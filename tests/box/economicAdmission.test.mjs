/**
 * SUITE — THE FIVE DISTINCT ECONOMIC QUANTITIES.  (Task 9)
 *
 * The safety property: available funds, planned margin, peak legging exposure, gross notional,
 * and worst-case entry cost must stay DISTINCT and never be substituted for one another; a stale
 * or failed broker fetch must produce explicit failure behaviour rather than optimistic
 * admission; and an ESTIMATE must never masquerade as a broker-CONFIRMED figure.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  brokerFigure,
  buildEconomicPicture,
  decidePartialRecovery,
  estimateFigure,
  evaluateEconomicAdmission,
  worstCaseEntryCost,
} from "../../dist/box/boxCapital.js";
import { ageEvidence } from "../../dist/box/evidenceTiming.js";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];
const NOW = 10_000_000;

/**
 * Age an observation exactly the way the production path does.
 *
 * `brokerFigure()` no longer decides freshness itself — that lives in `ageEvidence()`
 * (src/box/evidenceTiming.ts), which owns the single coherent clock model: MONOTONIC for durations,
 * wall for audit, and an evaluation instant stamped AFTER the reads resolve. This helper drives the
 * REAL ageing function rather than hand-rolling a status, so these tests still exercise the code
 * that makes the decision. `observedAt === null` models a read that produced nothing at all.
 */
function agedAt(observedAt, { now = NOW, maxAgeMs, label = "figure" } = {}) {
  const observation = observedAt === null
    ? {
        value: null, at: null, source_observed_at_wall: null, failure: "absent",
        detail: null, identity: null, identity_at_resolution: null, elapsed_ms: null,
      }
    : {
        value: {}, at: { mono: observedAt, wall: observedAt },
        source_observed_at_wall: observedAt, failure: null, detail: null,
        identity: null, identity_at_resolution: null, elapsed_ms: 0,
      };
  return ageEvidence({
    observation,
    evaluatedAt: { mono: now, wall: now },
    maxAgeMs,
    futureSkewGraceMs: 1_000,
    currentIdentity: null,
    label,
  });
}

function legs({ prices, quantity = 100, sides = ["BUY", "SELL", "BUY", "SELL"] }) {
  return ROLES.map((role, i) => ({
    role,
    side: sides[i],
    tradingsymbol: `SYM${i}`,
    quantity,
    pricing: { limit_price: prices[i] },
  }));
}

// ── provenance is a first-class concept ─────────────────────────────────────────────────────

test("a broker figure within the freshness bound is broker_confirmed and usable", () => {
  const f = brokerFigure({
    valueRupees: 41_250,
    aged: agedAt(NOW - 500, { maxAgeMs: 2_000 }),
    observedAtWall: NOW - 500,
    observedAtMono: NOW - 500,
    confirmedNote: "ok",
  });
  assert.equal(f.provenance, "broker_confirmed");
  assert.equal(f.usable, true);
  assert.equal(f.value_rupees, 41_250);
  assert.equal(f.age_ms, 500);
});

test("a broker figure OVER the freshness bound is downgraded to stale and NOT usable", () => {
  const f = brokerFigure({
    valueRupees: 41_250,
    aged: agedAt(NOW - 5_000, { maxAgeMs: 2_000 }),
    observedAtWall: NOW - 5_000,
    observedAtMono: NOW - 5_000,
    confirmedNote: "ok",
  });
  assert.equal(f.provenance, "stale");
  assert.equal(f.usable, false, "a stale margin must not admit a live entry");
  assert.equal(f.value_rupees, 41_250, "the value is retained for display, but marked unusable");
});

test("a missing broker figure is UNAVAILABLE with null value, never ₹0", () => {
  const f = brokerFigure({
    valueRupees: null,
    aged: agedAt(null, { maxAgeMs: 2_000 }),
    observedAtWall: null,
    observedAtMono: null,
    confirmedNote: "ok",
  });
  assert.equal(f.provenance, "unavailable");
  assert.equal(f.value_rupees, null, "absent must read as null, not 0");
  assert.equal(f.usable, false);
});

test("an estimate is tagged estimate and always says it is NOT broker-confirmed", () => {
  const f = estimateFigure(10_000, NOW, "gross notional.");
  assert.equal(f.provenance, "estimate");
  assert.equal(f.usable, true);
  assert.match(f.note, /NOT a broker-confirmed/);
});

test("an estimate that cannot be computed is unavailable, not a guessed number", () => {
  const f = estimateFigure(null, NOW, "x");
  assert.equal(f.provenance, "unavailable");
  assert.equal(f.value_rupees, null);
});

// ── worst-case entry cost (quantity #5) is distinct from gross notional (#4) ──────────────────

test("worst-case entry: gross cost sums all legs; net debit nets buys minus sells", () => {
  // BUY 10, SELL 20, BUY 30, SELL 40 at qty 100.
  const w = worstCaseEntryCost(legs({ prices: [10, 20, 30, 40] }));
  assert.equal(w.gross_cost_rupees, (10 + 20 + 30 + 40) * 100, "gross adds all four");
  // net debit = (10 + 30) - (20 + 40) = -20 per unit x 100 = -2000 (a net credit).
  assert.equal(w.net_debit_rupees, ((10 + 30) - (20 + 40)) * 100);
  assert.notEqual(w.gross_cost_rupees, w.net_debit_rupees, "gross and net must not be conflated");
  assert.equal(w.complete, true);
});

test("worst-case entry with an unpriced leg is incomplete", () => {
  const bad = legs({ prices: [10, 20, 30, 40] });
  bad[2].pricing.limit_price = 0;
  const w = worstCaseEntryCost(bad);
  assert.equal(w.complete, false);
});

// ── the five-quantity picture keeps everything distinct ──────────────────────────────────────

/**
 * The five-quantity picture. `availableFundsObservedAt` / `plannedMarginObservedAt` are kept as the
 * test's vocabulary and translated into the production `AgedEvidence` inputs here, so each test
 * still reads as "a figure observed N ms ago" while driving the real ageing code.
 */
function picture({ availableFundsObservedAt = null, plannedMarginObservedAt = null, ...overrides } = {}) {
  return buildEconomicPicture({
    requests: legs({ prices: [50, 50, 50, 50] }), // gross = 50*100*4 = 20,000
    now: NOW,
    availableFundsAged: agedAt(availableFundsObservedAt, { maxAgeMs: 5_000, label: "available-funds" }),
    availableFundsObservedAtWall: availableFundsObservedAt,
    availableFundsObservedAtMono: availableFundsObservedAt,
    plannedMarginAged: agedAt(plannedMarginObservedAt, { maxAgeMs: 2_000, label: "planned-margin" }),
    plannedMarginObservedAtWall: plannedMarginObservedAt,
    plannedMarginObservedAtMono: plannedMarginObservedAt,
    ...overrides,
  });
}

test("all five quantities are present and carry independent provenance", () => {
  const p = picture({
    availableFundsRupees: 500_000,
    availableFundsObservedAt: NOW - 1_000,
    plannedMarginRupees: 41_250,
    plannedMarginObservedAt: NOW - 500,
  });
  assert.equal(p.available_funds.provenance, "broker_confirmed");
  assert.equal(p.planned_margin.provenance, "broker_confirmed");
  assert.equal(p.peak_legging_exposure.provenance, "estimate");
  assert.equal(p.gross_notional.provenance, "estimate");
  assert.equal(p.worst_case_entry.provenance, "estimate");

  // The four estimate/notional numbers are computed from the same bounded requests but describe
  // DIFFERENT things — check the labels stay distinct.
  assert.equal(p.gross_notional.value_rupees, 20_000);
  assert.notEqual(p.available_funds.value_rupees, p.gross_notional.value_rupees);
  assert.notEqual(p.planned_margin.value_rupees, p.gross_notional.value_rupees);
});

test("the picture does NOT substitute broker margin for gross notional", () => {
  const p = picture({ plannedMarginRupees: 41_250, plannedMarginObservedAt: NOW });
  // gross notional is our own metric (20,000); planned margin is the broker's (41,250). They
  // are carried side by side, never merged.
  assert.equal(p.gross_notional.value_rupees, 20_000);
  assert.equal(p.planned_margin.value_rupees, 41_250);
});

// ── admission fails closed on stale/missing evidence ─────────────────────────────────────────

test("requireMarginEvidence REFUSES when the margin fetch is stale", () => {
  const p = picture({ plannedMarginRupees: 41_250, plannedMarginObservedAt: NOW - 10_000 }); // stale
  const r = evaluateEconomicAdmission({ picture: p, grossCapRupees: 0, requireFundsCover: false, requireMarginEvidence: true });
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.includes("margin_evidence_stale_or_missing"));
});

test("requireMarginEvidence REFUSES when there is no margin at all (no optimistic admission)", () => {
  const p = picture(); // no margin supplied
  const r = evaluateEconomicAdmission({ picture: p, grossCapRupees: 0, requireFundsCover: false, requireMarginEvidence: true });
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.includes("margin_evidence_stale_or_missing"));
});

test("requireMarginEvidence ADMITS only on a fresh broker-confirmed figure", () => {
  const p = picture({ plannedMarginRupees: 41_250, plannedMarginObservedAt: NOW - 100 });
  const r = evaluateEconomicAdmission({ picture: p, grossCapRupees: 0, requireFundsCover: false, requireMarginEvidence: true });
  assert.equal(r.allowed, true);
});

test("funds cover REFUSES when funds are missing, never admits on unknown funds", () => {
  const p = picture({ plannedMarginRupees: 41_250, plannedMarginObservedAt: NOW });
  const r = evaluateEconomicAdmission({ picture: p, grossCapRupees: 0, requireFundsCover: true, requireMarginEvidence: false });
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.includes("insufficient_available_funds"));
});

test("funds cover uses BROKER MARGIN when usable, and REFUSES when there is no margin figure", () => {
  // Funds 30,000. Broker margin 41,250 (fresh) > funds ⇒ refuse.
  const withMargin = evaluateEconomicAdmission({
    picture: picture({
      availableFundsRupees: 30_000, availableFundsObservedAt: NOW,
      plannedMarginRupees: 41_250, plannedMarginObservedAt: NOW,
    }),
    grossCapRupees: 0, requireFundsCover: true, requireMarginEvidence: false,
  });
  assert.equal(withMargin.allowed, false, "30k funds cannot cover 41.25k broker margin");
  assert.ok(withMargin.reasons.includes("insufficient_available_funds"));
  assert.match(withMargin.detail, /broker margin/);

  // CHANGED DELIBERATELY. This second half used to assert that with NO usable margin the check
  // fell back to the worst-case GROSS ENTRY COST (₹20,000) and admitted, because ₹30,000 covers
  // it. That is the defect: ₹20,000 of option premium says nothing about the margin the two SHORT
  // legs of this box attract, which in the same fixture is ₹41,250 — more than the funds
  // available. Substituting premium for margin therefore admitted an entry the account could not
  // fund, using a comparison that reads like diligence.
  //
  // With no real requirement the answer is UNKNOWN, and admission refuses.
  const noMargin = evaluateEconomicAdmission({
    picture: picture({ availableFundsRupees: 30_000, availableFundsObservedAt: NOW }),
    grossCapRupees: 0, requireFundsCover: true, requireMarginEvidence: false,
  });
  assert.equal(noMargin.allowed, false, "no margin evidence ⇒ no funding requirement ⇒ refuse");
  assert.ok(noMargin.reasons.includes("metric_incomplete"));
  assert.match(noMargin.detail, /Gross option premium is NOT used as a substitute/);
});

test("gross cap control stays consistent with the standalone gross-notional gate", () => {
  const p = picture(); // gross = 20,000
  const under = evaluateEconomicAdmission({ picture: p, grossCapRupees: 25_000, requireFundsCover: false, requireMarginEvidence: false });
  assert.equal(under.allowed, true);
  const over = evaluateEconomicAdmission({ picture: p, grossCapRupees: 15_000, requireFundsCover: false, requireMarginEvidence: false });
  assert.equal(over.allowed, false);
  assert.ok(over.reasons.includes("gross_notional_over_cap"));
  assert.match(over.detail, /NOT broker margin/);
});

test("an incomplete gross metric refuses under a cap (fail closed)", () => {
  const partial = buildEconomicPicture({
    requests: legs({ prices: [50, 50, 50, 50] }).slice(0, 3),
    now: NOW,
    availableFundsAged: agedAt(null, { maxAgeMs: 5_000, label: "available-funds" }),
    plannedMarginAged: agedAt(null, { maxAgeMs: 2_000, label: "planned-margin" }),
  });
  const r = evaluateEconomicAdmission({ picture: partial, grossCapRupees: 100_000, requireFundsCover: false, requireMarginEvidence: false });
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.includes("metric_incomplete"));
});

test("multiple failing controls are reported together", () => {
  const p = picture(); // no funds, no margin
  const r = evaluateEconomicAdmission({ picture: p, grossCapRupees: 5_000, requireFundsCover: true, requireMarginEvidence: true });
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.includes("gross_notional_over_cap"));
  assert.ok(r.reasons.includes("margin_evidence_stale_or_missing"));
  assert.ok(r.reasons.includes("insufficient_available_funds"));
});

test("with every control disabled, admission is permitted (backwards compatible)", () => {
  const p = picture();
  const r = evaluateEconomicAdmission({ picture: p, grossCapRupees: 0, requireFundsCover: false, requireMarginEvidence: false });
  assert.equal(r.allowed, true);
  assert.equal(r.reasons.length, 0);
});

// ── partial-recovery policy preserves one lot and does not chase the original edge ────────────

test("partial recovery: holds when margin evidence is not usable", () => {
  const d = decidePartialRecovery({ remainingLegsPriceable: true, completionAffordable: true, marginEvidenceUsable: false });
  assert.equal(d.action, "hold_and_reassess");
  assert.equal(d.one_lot_preserved, true);
});

test("partial recovery: completes the hedge when affordable and priceable", () => {
  const d = decidePartialRecovery({ remainingLegsPriceable: true, completionAffordable: true, marginEvidenceUsable: true });
  assert.equal(d.action, "complete_remaining_legs");
});

test("partial recovery: UNWINDS rather than chasing the original edge when completion is unaffordable", () => {
  const d = decidePartialRecovery({ remainingLegsPriceable: true, completionAffordable: false, marginEvidenceUsable: true });
  assert.equal(d.action, "unwind_filled_legs");
  assert.match(d.reason, /rather than chasing the original profit threshold/);
  assert.equal(d.one_lot_preserved, true);
});

test("every recovery decision preserves one lot — no silent resize", () => {
  for (const priceable of [true, false]) {
    for (const affordable of [true, false]) {
      for (const usable of [true, false]) {
        const d = decidePartialRecovery({ remainingLegsPriceable: priceable, completionAffordable: affordable, marginEvidenceUsable: usable });
        assert.equal(d.one_lot_preserved, true);
      }
    }
  }
});
