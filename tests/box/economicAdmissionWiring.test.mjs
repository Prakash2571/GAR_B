/**
 * ECONOMIC ADMISSION — the FRESH funds/margin evidence gate, wired into the live entry path.
 *
 * The load-bearing proof: with the funds-cover (or margin-evidence) control enabled, MISSING or
 * STALE broker funds/margin evidence must ACTUALLY BLOCK a live entry — nothing reaches the
 * manager (zero submissions) — and the refusal must be a proven pre-submit refusal
 * (outcome_class REFUSED_BEFORE_SUBMIT), never exposure taken then unwound.
 *
 * It also proves the gate is EVIDENCE-driven, not a copy of the gross cap: with fresh funds that
 * cover the requirement it admits, and the four distinct quantities (gross option-order notional,
 * broker margin, peak legging capital, worst-case entry cost) are surfaced separately.
 *
 * Failing-first: before the gateway is wired to evaluateEconomicAdmission, enabling the control
 * does nothing — the entry is admitted and the four legs are submitted — so the "blocked" and
 * "nothing submitted" assertions fail.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg, exitQuotes, goodCandidate, seedStore } from "./helpers.mjs";

const NOW = 10_000;

function brokerOrder(req) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.role}-${req.purpose}`,
    tag: null, role: req.role, trade_id: req.trade_id, attempt_id: req.attempt_id,
    purpose: req.purpose, phase: req.phase, exchange: req.exchange,
    tradingsymbol: req.tradingsymbol, token: req.token, side: req.side, quantity: req.quantity,
    pricing: { ...req.pricing }, limit_price: req.pricing.limit_price,
    state: "COMPLETE", filled_quantity: req.quantity, pending_quantity: 0,
    average_price: req.pricing.reference_price,
    fills: [{ fill_id: `f-${req.role}`, quantity: req.quantity, price: req.pricing.reference_price, at: NOW }],
    reject_family: null, reject_reason: null, created_at: NOW, updated_at: NOW,
  };
}

function detectionLegs(candidate, quotes) {
  return BOX_LEG_ROLES.map((role) => {
    const leg = candidate.legs[role];
    const q = quotes.get(leg.token);
    const side = entrySideFor(role, candidate.direction ?? "LONG_BOX");
    const price = side === "BUY" ? q.ask : q.bid;
    return { role, token: leg.token, side, price, bid: q.bid, ask: q.ask, age_ms: 0 };
  });
}

/**
 * The REAL CentralBoxExecutionGateway in live mode over a fake manager. `econ` supplies the
 * optional funds/plannedMargin evidence sources the economic gate consults.
 */
function harness({ config = {}, funds, plannedMargin } = {}) {
  const { candidate } = goodCandidate();
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, 198, { at: NOW, qty: 100_000 }), NOW);
  const submitted = [];
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({
      executionMode: "live",
      liveTradingEnabled: true,
      queueModel: "none",
      liveMaxChaseTicks: 2,
      legMaxChaseTicks: 2,
      unwindMaxChaseTicks: 5,
      // Gross cap generous so it never binds: we are testing the ECONOMIC (funds/margin) gate.
      liveMaxBoxCapitalRupees: 1_000_000_000,
      ...config,
    }),
    simulator: { hasCapacity: () => false, estimateExecutableExit: () => [] },
    quotes,
    manager: {
      status: () => ({ inFlight: 0, queued: 0 }),
      submit: async (req, feed, capital) => {
        submitted.push({ ...req, _capital: capital ?? null });
        return brokerOrder(req);
      },
      invariantViolation: () => {},
    },
    broker: () => "zerodha",
    allocateTradeId: () => "trade-1",
    isTokenWarm: () => true,
    feedGeneration: () => 7,
    now: () => NOW,
    chargeTotal: () => 0,
    ...(funds ? { funds } : {}),
    ...(plannedMargin ? { plannedMargin } : {}),
  });
  return { candidate, quotes, gateway, submitted };
}

function entryDetection(h) {
  return {
    candidate: h.candidate,
    at: NOW,
    legs: detectionLegs(h.candidate, h.quotes),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80,
    gross_edge: 4_000,
    tradable: true, depth_ok: true, worst_age_ms: 0, quote_version: 1, reject: null,
  };
}

function runEntry(h) {
  return h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection: entryDetection(h),
    stillWanted: () => true,
    qualify: () => ({ qualifies: true }),
  });
}

test("MISSING funds evidence blocks a live entry when funds-cover is required (nothing submitted)", async () => {
  // Control enabled, but NO funds source wired → available funds are unavailable → must block.
  const h = harness({ config: { liveRequireFundsCover: true } });
  const entry = await runEntry(h);
  assert.equal(entry.ok, false, "entry must be refused when required funds evidence is missing");
  assert.equal(entry.legging.outcome_class, "REFUSED_BEFORE_SUBMIT", "a pre-submit refusal, no exposure");
  assert.equal(h.submitted.length, 0, "NO leg reached the manager — missing evidence actually blocked entry");
});

test("STALE funds evidence blocks a live entry (a fresh figure would be required)", async () => {
  // A funds figure exists but is older than the freshness window → treated as not usable → block.
  const h = harness({
    config: { liveRequireFundsCover: true, liveFundsFreshnessMaxAgeMs: 1_000 },
    funds: async () => ({ availableRupees: 10_000_000, observedAt: NOW - 60_000 }),
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, false, "a stale funds figure must not admit");
  assert.equal(h.submitted.length, 0, "nothing submitted on stale evidence");
});

test("MISSING margin evidence blocks entry when margin-evidence is required", async () => {
  // No basket-margin source → planned margin unavailable → refusing rather than assuming.
  const h = harness({ config: { liveRequireMarginEvidence: true } });
  const entry = await runEntry(h);
  assert.equal(entry.ok, false, "entry refused without fresh broker-confirmed margin evidence");
  assert.equal(h.submitted.length, 0, "nothing submitted");
});

test("FRESH funds that cover the requirement ADMIT the entry (evidence-driven, not a cap copy)", async () => {
  // Ample fresh funds, funds-cover required (margin evidence NOT required). Entry admitted; the
  // four legs reach the manager.
  const h = harness({
    config: { liveRequireFundsCover: true },
    funds: async () => ({ availableRupees: 10_000_000, observedAt: NOW }),
    // A real broker margin figure is now REQUIRED for funds cover to have anything to compare
    // against: the previous gross-option-premium substitute has been removed, because premium
    // does not bound the margin a short option requires.
    plannedMargin: async () => ({ marginRupees: 50_000, observedAt: NOW }),
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, true, "fresh funds covering the requirement admit the entry");
  assert.equal(h.submitted.length, 4, "all four legs were submitted once admission passed");
});

test("funds cover with NO margin figure refuses and submits nothing (no premium substitute)", async () => {
  // The complement of the test above, and the safety half of it: ample funds plus funds-cover
  // enabled must NOT admit while the funding requirement is unknown. Pre-fix this admitted by
  // comparing ₹10,000,000 against the gross entry premium.
  const h = harness({
    config: { liveRequireFundsCover: true },
    funds: async () => ({ availableRupees: 10_000_000, observedAt: NOW }),
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, false, "an unknown requirement cannot be 'covered' by any amount of funds");
  assert.equal(h.submitted.length, 0, "ZERO order-placement calls reached the manager");
});

test("INSUFFICIENT fresh funds block entry (funds compared to a real requirement, not the cap)", async () => {
  // Funds are fresh and broker-confirmed but far below the worst-case entry cost → block.
  const h = harness({
    config: { liveRequireFundsCover: true },
    funds: async () => ({ availableRupees: 1, observedAt: NOW }),
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, false, "funds below the requirement must block");
  assert.equal(h.submitted.length, 0, "nothing submitted");
});

test("the economic diagnostics surface the FOUR distinct quantities, none substituted", async () => {
  const h = harness({
    config: { liveRequireFundsCover: true },
    funds: async () => ({ availableRupees: 10_000_000, observedAt: NOW }),
  });
  await runEntry(h);
  const econ = h.gateway.economicDiagnostics();
  assert.ok(econ, "economic diagnostics are exposed");
  // Four distinct, separately-labelled quantities.
  assert.ok("gross_notional" in econ.picture, "gross option-order notional present");
  assert.ok("planned_margin" in econ.picture, "broker margin present and distinct");
  assert.ok("peak_legging_exposure" in econ.picture, "peak legging capital present and distinct");
  assert.ok("worst_case_entry" in econ.picture, "worst-case entry (maximum loss) present and distinct");
  // They are not the same object / not conflated: gross notional is a real figure here.
  assert.notEqual(econ.picture.gross_notional.value_rupees, null);
});
