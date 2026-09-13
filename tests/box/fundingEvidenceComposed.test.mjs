/**
 * COMPOSED REGRESSION: broker adapter → planned-margin provider → economic admission → the mocked
 * order-placement boundary.
 *
 * Every other test in this area exercises one layer. This one wires the REAL
 * `ActiveBrokerManager.margins()` to the REAL `createPlannedMarginProvider` to the REAL
 * `CentralBoxExecutionGateway`, with only two things faked: the Dhan HTTP client (so no broker is
 * contacted) and the order manager (so a placement attempt is observable and harmless).
 *
 * It exists because defects A and B were each individually plausible at every layer:
 *   * the adapter returned a number, which looked like an answer;
 *   * the provider forwarded it, because it was finite;
 *   * the stage model consumed it, because it was non-null;
 *   * admission compared it against funds and passed.
 * No single-layer test could see that the number described 1 leg of 4, or that it was SPAN wearing
 * the label "initial". The load-bearing assertion here is the one at the end of the chain:
 * `submitted.length === 0` — ZERO order-placement calls.
 *
 * It also pins the ENCUMBRANCE ARITHMETIC with explicit expected numbers for a net-of-encumbrance
 * broker and a gross/unverified one, and proves protective reductions stay available when entry
 * funding evidence does not.
 *
 * NO LIVE BROKER ENDPOINT IS CONTACTED: the Dhan client's two margin methods are replaced, and the
 * suite runs under the CI egress guard, which fails closed on any non-loopback request.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ActiveBrokerManager } from "../../dist/brokers/registry.js";
import { createPlannedMarginProvider } from "../../dist/box/plannedMarginEvidence.js";
import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import {
  buildEconomicPicture,
  evaluateEconomicAdmission,
} from "../../dist/box/boxCapital.js";
import { usableFundsRupees } from "../../dist/box/fundsSemantics.js";
import { cfg, exitQuotes, goodCandidate, positionFrom, seedStore } from "./helpers.mjs";

const NOW = 10_000;

/* ───────────────── the real Dhan margin adapter over a fake client ───────────────── */

/**
 * A real `ActiveBrokerManager` with Dhan active, its instrument store seeded, and ONLY the two
 * Dhan margin HTTP methods replaced. `perLeg` is keyed by securityId so an individual leg can fail.
 */
function dhanMarginProvider({ multi = "throw", perLeg, symbols }) {
  const calls = { multi: 0, perLeg: 0 };
  const m = new ActiveBrokerManager({
    kite: {
      getAccessToken: () => "k", getApiKey: () => "k", getQuoteFull: async () => [],
      getBasketMargin: async () => ({
        initial: 96_505, final: 34_787, total: 34_787,
        initial_available: true, final_available: true, total_basis: "final",
      }),
    },
    tickerHub: {
      isConnected: () => true, subscribedCount: () => 0, subscribeTokens: () => {},
      unsubscribeTokens: () => {}, stop: () => {}, seed: () => {}, retain: () => () => {},
      addTickListener: () => () => {}, addConnectionListener: () => () => {},
      ingestExternalTicks: () => {}, setExternalConnected: () => {},
    },
    boxConfig: () => ({}), istDayKey: () => "2026-09-03", onDhanTicks: () => {},
  });
  const store = m.dhanInstrumentStore;
  store.load = async () => [];
  const instruments = symbols.map((sym, i) => ({
    exchange: "NFO", tradingsymbol: sym, dhan_segment: "NSE_FNO",
    dhan_security_id: 45000 + i, instrument_token: 900_000 + i,
  }));
  Object.defineProperty(store, "instruments", { get: () => instruments, configurable: true });
  m.dhan.calculateMultiMargin = async () => {
    calls.multi++;
    if (multi === "throw") throw new Error("multi endpoint unavailable");
    return multi;
  };
  m.dhan.calculateMargin = async (leg) => {
    calls.perLeg++;
    const out = perLeg(leg.securityId);
    if (out === "throw") throw new Error(`per-leg unavailable for ${leg.securityId}`);
    return out;
  };
  Object.defineProperty(m, "active", { value: "dhan", writable: true, configurable: true });
  return { manager: m, calls };
}

/* ─────────────────────────── the real gateway over a fake manager ─────────────────────────── */

function brokerOrder(req) {
  return {
    client_order_id: req.client_order_id, broker_order_id: `B-${req.role}-${req.purpose}`,
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

function detectionLegs(candidate, quotes, sideFor) {
  return BOX_LEG_ROLES.map((role) => {
    const leg = candidate.legs[role];
    const q = quotes.get(leg.token);
    const side = sideFor
      ? sideFor(role, candidate.direction ?? "LONG_BOX")
      : entrySideFor(role, candidate.direction ?? "LONG_BOX");
    const price = side === "BUY" ? q.ask : q.bid;
    return { role, token: leg.token, side, price, bid: q.bid, ask: q.ask, age_ms: 0 };
  });
}

/** The REAL gateway in live mode, with the REAL provider chain supplying margin evidence. */
function composed({ margins, config = {}, funds } = {}) {
  const { candidate } = goodCandidate();
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, 198, { at: NOW, qty: 100_000 }), NOW);
  const submitted = [];
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({
      executionMode: "live", liveTradingEnabled: true, queueModel: "none",
      liveMaxChaseTicks: 2, legMaxChaseTicks: 2, unwindMaxChaseTicks: 5,
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
    broker: () => "dhan",
    allocateTradeId: () => "trade-1",
    isTokenWarm: () => true,
    feedGeneration: () => 7,
    now: () => NOW,
    chargeTotal: () => 0,
    funds: funds ?? (async () => ({ availableRupees: 10_000_000, utilisedRupees: 0, observedAt: NOW })),
    // THE REAL PRODUCTION PROVIDER over the REAL adapter.
    ...(margins ? { plannedMargin: createPlannedMarginProvider({ margins, now: () => NOW, log: () => {} }) } : {}),
  });
  return { candidate, quotes, gateway, submitted };
}

function runEntry(h) {
  return h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection: {
      candidate: h.candidate, at: NOW, legs: detectionLegs(h.candidate, h.quotes),
      entry_net_debit_per_unit: 20, entry_box_cost_per_unit: 20,
      gross_edge_per_unit: 80, gross_edge: 4_000,
      tradable: true, depth_ok: true, worst_age_ms: 0, quote_version: 1, reject: null,
    },
    stillWanted: () => true,
    qualify: () => ({ qualifies: true }),
  });
}

/** The four tradingsymbols the real candidate uses, so the adapter can resolve them. */
function candidateSymbols(candidate) {
  return BOX_LEG_ROLES.map((r) => candidate.legs[r].tradingsymbol);
}

/* ═════════ 1. incomplete evidence ⇒ ZERO order-placement calls ═════════ */

test("COMPOSED: a 1-of-4 Dhan per-leg sum results in ZERO order-placement calls", async () => {
  // The exact confirmed baseline, driven end to end: multi fails, ONE leg answers
  // { totalMargin: 1000, spanMargin: 500 }, three throw. Pre-fix the adapter returned
  // total=1000 / source="dhan_per_leg_fallback", the provider forwarded it, and admission
  // compared ₹10,000,000 of funds against it and PASSED — four legs went to the manager.
  const { candidate } = goodCandidate();
  const { manager } = dhanMarginProvider({
    symbols: candidateSymbols(candidate),
    perLeg: (id) => (id === "45000" ? { totalMargin: 1000, spanMargin: 500 } : "throw"),
  });
  const h = composed({
    margins: manager.margins(),
    config: { liveRequireFundsCover: true, liveRequireMarginEvidence: true },
  });
  const entry = await runEntry(h);

  assert.equal(entry.ok, false, "incomplete margin evidence must refuse entry");
  assert.equal(h.submitted.length, 0, "ZERO order-placement calls reached the manager");
  const econ = h.gateway.economicDiagnostics();
  assert.equal(econ.allowed, false);
  assert.equal(
    econ.picture.planned_margin.usable,
    false,
    "the partial sum must not be published as a usable broker figure",
  );
  assert.notEqual(econ.picture.planned_margin.value_rupees, 1000);
});

test("COMPOSED: an unresolved instrument results in ZERO order-placement calls", async () => {
  const { candidate } = goodCandidate();
  const all = candidateSymbols(candidate);
  const { manager, calls } = dhanMarginProvider({
    symbols: all.slice(0, 3), // one leg never resolves to a security id
    perLeg: () => ({ totalMargin: 50_000, spanMargin: 40_000 }),
  });
  const h = composed({
    margins: manager.margins(),
    config: { liveRequireFundsCover: true, liveRequireMarginEvidence: true },
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, false);
  assert.equal(h.submitted.length, 0, "ZERO order-placement calls");
  assert.equal(calls.multi, 0, "no margin request is made for a partial basket");
});

test("COMPOSED: a malformed leg figure results in ZERO order-placement calls", async () => {
  const { candidate } = goodCandidate();
  const { manager } = dhanMarginProvider({
    symbols: candidateSymbols(candidate),
    perLeg: (id) => (id === "45002" ? { totalMargin: "not-a-number" } : { totalMargin: 50_000 }),
  });
  const h = composed({
    margins: manager.margins(),
    config: { liveRequireFundsCover: true, liveRequireMarginEvidence: true },
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, false);
  assert.equal(h.submitted.length, 0, "ZERO order-placement calls");
});

test("COMPOSED: a COMPLETE four-leg Dhan basket figure IS accepted (the gate is not simply off)", async () => {
  // The necessary counter-test: a fix that refused everything would pass every assertion above.
  const { candidate } = goodCandidate();
  const { manager } = dhanMarginProvider({
    symbols: candidateSymbols(candidate),
    multi: { totalMargin: 41_250, spanMargin: 30_000, exposureMargin: 11_250, marginBenefit: 158_750 },
    perLeg: () => ({ totalMargin: 50_000 }),
  });
  const h = composed({
    margins: manager.margins(),
    config: { liveRequireFundsCover: true, liveRequireMarginEvidence: true },
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, true, "complete, fresh, hedge-aware evidence admits");
  assert.equal(h.submitted.length, 4, "all four legs were placed");
  const econ = h.gateway.economicDiagnostics();
  assert.equal(econ.picture.planned_margin.value_rupees, 41_250);
});

test("COMPOSED: STRICT STAGE funding refuses on Dhan even with a complete basket figure", async () => {
  // Dhan supplies a complete TOTAL but no documented execute-the-orders figure, so the
  // intermediate stage requirement is UNKNOWN. Strict stage-funded entry must refuse with an
  // actionable reason rather than fall back to the completed-basket margin or the premium.
  const { candidate } = goodCandidate();
  const { manager } = dhanMarginProvider({
    symbols: candidateSymbols(candidate),
    multi: { totalMargin: 41_250, spanMargin: 30_000, exposureMargin: 11_250 },
    perLeg: () => ({ totalMargin: 50_000 }),
  });
  const h = composed({
    margins: manager.margins(),
    config: {
      liveRequireFundsCover: true, liveRequireMarginEvidence: true, liveRequireStageFunding: true,
    },
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, false, "an unknown intermediate stage requirement must refuse");
  assert.equal(h.submitted.length, 0, "ZERO order-placement calls");
  const econ = h.gateway.economicDiagnostics();
  assert.ok(
    econ.reasons.includes("funding_stage_unknown"),
    `expected funding_stage_unknown, got ${JSON.stringify(econ.reasons)}`,
  );
  assert.match(String(econ.detail), /unknown/i, "the refusal is actionable, naming what is unknown");
});

/* ═════════ 2. protective reductions stay available ═════════ */

test("protective REDUCTION is unaffected when entry funding evidence is unavailable", async () => {
  // Entry restrictions must not automatically block exits. This is the same gateway instance, the
  // same absent evidence, and the same contracts.
  const { candidate } = goodCandidate();
  const { manager } = dhanMarginProvider({
    symbols: candidateSymbols(candidate),
    perLeg: () => "throw", // nothing can be margined at all
  });
  const h = composed({
    margins: manager.margins(),
    config: {
      liveRequireFundsCover: true, liveRequireMarginEvidence: true, liveRequireStageFunding: true,
    },
  });

  const entry = await runEntry(h);
  assert.equal(entry.ok, false, "new exposure is refused");
  assert.equal(h.submitted.length, 0);

  const position = positionFrom(h.candidate, {
    id: "t1",
    remaining_qty_by_role: { k1_ce: 75, k1_pe: 75, k2_ce: 75, k2_pe: 75 },
  });
  const exit = await h.gateway.simulateLeggingExit({
    position,
    detectionLegs: detectionLegs(h.candidate, h.quotes, (r, d) => (entrySideFor(r, d) === "BUY" ? "SELL" : "BUY")),
    detectedAt: NOW,
    stillWanted: () => true,
  });
  assert.equal(exit.ok, true, "reducing OWNED exposure must not require entry funding evidence");
  assert.ok(h.submitted.some((r) => r.purpose === "EXIT"), "the exit legs were placed");
  for (const req of h.submitted) {
    assert.notEqual(req.purpose, "ENTRY", "no entry order escaped");
  }
});

test("residual FLATTENING is unaffected when entry funding evidence is unavailable", async () => {
  const { candidate } = goodCandidate();
  const { manager } = dhanMarginProvider({
    symbols: candidateSymbols(candidate),
    perLeg: () => "throw",
  });
  const h = composed({
    margins: manager.margins(),
    config: {
      liveRequireFundsCover: true, liveRequireMarginEvidence: true, liveRequireStageFunding: true,
    },
  });
  const inst = h.candidate.legs.k1_ce;
  const pass = await h.gateway.flattenResidual({
    keyPrefix: "attempt-1",
    residual: [{
      token: inst.token, tradingsymbol: inst.tradingsymbol, exchange: inst.exchange,
      role: "k1_ce", side: "BUY", quantity: 25, average_price: 100,
      source: "partial_entry", created_at: NOW,
    }],
  });
  assert.ok(pass, "emergency residual flattening must never be gated by entry funding");
  assert.ok(h.submitted.some((r) => r.purpose === "EMERGENCY_RESIDUAL"));
});

/* ═════════ 3. encumbrance arithmetic, with explicit expected numbers ═════════ */

/**
 * The production derivation: `usableFundsRupees` for the funds side, and the resulting
 * `encumbranceNettedFromAvailable` flag forwarded into the funding picture — exactly as
 * `executionGateway.evaluateEntryEconomics` does it.
 */
function admitWithFunds({ broker, availableRupees, utilisedRupees, initial, final, charges = 0, reserve = 0 }) {
  const mk = (role, side, price) => ({
    client_order_id: `BOX:T1:ENTRY:${role}:a1`, role, side, quantity: 75,
    tradingsymbol: `NIFTY26OCT${role}`, exchange: "NFO", token: 1000 + role.length,
    pricing: { order_type: "LIMIT", limit_price: price, reference_price: price, tick_size: 0.05, max_chase_ticks: 3 },
  });
  const requests = [mk("k1_ce", "BUY", 200), mk("k1_pe", "BUY", 20), mk("k2_ce", "SELL", 30), mk("k2_pe", "SELL", 150)];
  const transportOrder = [
    { role: "k1_ce", side: "BUY", rank: 0 }, { role: "k1_pe", side: "BUY", rank: 1 },
    { role: "k2_ce", side: "SELL", rank: 2 }, { role: "k2_pe", side: "SELL", rank: 3 },
  ];
  const usable = usableFundsRupees({ broker, availableRupees, utilisedRupees });
  const USABLE = { status: "usable", note: "fresh" };
  const picture = buildEconomicPicture({
    requests, now: 1_000,
    availableFundsRupees: usable.value_rupees,
    availableFundsBasis: usable.basis,
    availableFundsAged: USABLE,
    plannedMarginRupees: final,
    plannedMarginAged: USABLE,
    planFingerprint: "fp-1",
    estimatedChargesRupees: charges,
    expectedLegCount: 4,
    funding: {
      transportOrder,
      initialMarginRupees: initial,
      finalMarginRupees: final,
      encumbranceRupees: utilisedRupees,
      encumbranceNettedFromAvailableFunds: usable.encumbranceNettedFromAvailable,
      recoveryReserveRupees: reserve,
    },
  });
  const report = evaluateEconomicAdmission({
    picture, grossCapRupees: 0,
    requireFundsCover: true, requireMarginEvidence: true, requireStageFunding: true,
    evaluatedAt: 1_000, planFingerprint: "fp-1",
  });
  return { usable, picture, report };
}

test("NET-of-encumbrance broker: utilisation is neither subtracted twice nor added to the requirement", () => {
  // Zerodha. available = 200,000 is already spendable; utilised = 50,000 is corroborating detail.
  // Worst stage = max(initial 96,505, cumulative premium) = 96,505. No charges, no reserve.
  // EXPECTED: spendable 200,000 ; requirement 96,505.
  const { usable, picture } = admitWithFunds({
    broker: "zerodha", availableRupees: 200_000, utilisedRupees: 50_000,
    initial: 96_505, final: 34_787,
  });
  assert.equal(usable.value_rupees, 200_000, "available is documented net: do NOT subtract again");
  assert.equal(usable.encumbranceNettedFromAvailable, true);
  assert.equal(
    picture.funding.binding_requirement.value_rupees,
    96_505,
    "the requirement is the worst stage alone — the 50,000 encumbrance is NOT re-added",
  );
  // The pre-fix arithmetic produced 96,505 + 50,000 = 146,505 against 200,000 of funds: the same
  // blocked rupees were charged twice (A ≥ R + 2U).
  assert.notEqual(picture.funding.binding_requirement.value_rupees, 146_505);
  assert.equal(picture.funding.encumbrance.value_rupees, 50_000, "still REPORTED, for diagnostics");
});

test("GROSS/unverified broker: utilisation is subtracted from available exactly once", () => {
  // Dhan (semantics unverified ⇒ conservative subtraction).
  // EXPECTED: spendable 200,000 − 50,000 = 150,000 ; requirement 96,505 (encumbrance not re-added).
  const { usable, picture } = admitWithFunds({
    broker: "dhan", availableRupees: 200_000, utilisedRupees: 50_000,
    initial: 96_505, final: 34_787,
  });
  assert.equal(usable.value_rupees, 150_000);
  assert.equal(usable.encumbranceNettedFromAvailable, true);
  assert.equal(usable.semanticsUnverified, true, "the unverified semantics stay explicit");
  assert.equal(picture.funding.binding_requirement.value_rupees, 96_505);
  assert.equal(picture.available_funds.value_rupees, 150_000);
});

test("the double count is what previously refused an AFFORDABLE entry", () => {
  // Zerodha, funds 120,000, worst stage 96,505, encumbrance 20,000.
  // Correct: spendable 120,000 ≥ requirement 96,505  ⇒ ADMIT.
  // Pre-fix: 120,000 ≥ 96,505 + 20,000 = 116,505 ⇒ admit too... so pick an encumbrance that flips
  // it, to show the effect is real and grows with unrelated account activity: 30,000.
  const affordable = admitWithFunds({
    broker: "zerodha", availableRupees: 120_000, utilisedRupees: 30_000,
    initial: 96_505, final: 34_787,
  });
  assert.equal(affordable.picture.funding.binding_requirement.value_rupees, 96_505);
  assert.equal(
    affordable.report.allowed,
    true,
    `an affordable entry must be admitted; detail: ${affordable.report.detail ?? "(none)"}`,
  );
  // Pre-fix requirement would have been 126,505 > 120,000 ⇒ refused for a shortfall that did not
  // exist. The direction was safe, but the published arithmetic was wrong.
  assert.ok(96_505 + 30_000 > 120_000, "the pre-fix sum really would have refused this");
});

test("an UNKNOWN encumbrance still fails closed, on the FUNDS side, for an unverified broker", () => {
  // The safety property must survive the arithmetic change. For Dhan the utilisation is REQUIRED
  // to compute spendable funds, so a missing one yields no funds figure and admission refuses.
  const { usable, report } = admitWithFunds({
    broker: "dhan", availableRupees: 200_000, utilisedRupees: null,
    initial: 96_505, final: 34_787,
  });
  assert.equal(usable.value_rupees, null, "missing encumbrance is not zero");
  assert.equal(usable.encumbranceMissing, true);
  assert.equal(usable.encumbranceNettedFromAvailable, false);
  assert.equal(report.allowed, false, "no funds figure ⇒ refuse");
});

test("an unrecognised broker yields no funds figure rather than borrowing another's semantics", () => {
  const { usable, report } = admitWithFunds({
    broker: "some_new_broker", availableRupees: 200_000, utilisedRupees: 10_000,
    initial: 96_505, final: 34_787,
  });
  assert.equal(usable.value_rupees, null);
  assert.equal(report.allowed, false);
});


/* ═════════════════════════════════════════════════════════════════════════════════════════
 * SECTION R — REVIEW FINDING ON THE ENCUMBRANCE FIX
 *
 * Removing the double count also removed a refusal, and only on the arm that matters most.
 *
 * Under the old additive model an UNKNOWN encumbrance made `binding_requirement` unknown and
 * stage funding refused `funding_stage_unknown`. The first version of the netting fix returned
 * `encumbranceNettedFromAvailable: true` for a `net_of_encumbrance` broker WITHOUT consulting
 * `utilisedRupees`, so a missing encumbrance neither poisoned the requirement nor reduced the
 * funds figure — admission proceeded on `available` alone.
 *
 * That is only safe if `available.live_balance` really is net of encumbrance, and
 * `fundsSemantics.ts` records its own identification of that field as resting on vendor SUPPORT
 * documentation rather than a field-level API statement, "NOT VERIFIED against a live account".
 * The double count was the compensating conservatism for that unverified fact — and Zerodha, the
 * only broker on this arm, is precisely the broker the supervised trial profile permits to run
 * (Dhan is deliberately blocked). So the refusal had to come back without the double count
 * returning with it.
 * ═════════════════════════════════════════════════════════════════════════════════════════ */

test("R1 REPRODUCTION: a NET broker with an UNREPORTED encumbrance must still refuse", () => {
  const { usable, picture, report } = admitWithFunds({
    broker: "zerodha",
    availableRupees: 10_000_000, // abundant
    utilisedRupees: null, // the broker did not report it
    initial: 96_505,
    final: 34_787,
  });
  // The funds figure is still produced — `available` does not depend on the utilisation here...
  assert.equal(usable.value_rupees, 10_000_000);
  // ...but the already-net claim cannot be corroborated, so it is NOT treated as netted.
  assert.equal(
    usable.encumbranceNettedFromAvailable,
    false,
    "an absent utilisation must not be reported as 'already netted'",
  );
  assert.equal(usable.encumbranceMissing, true);
  // Which leaves the encumbrance a required UNKNOWN component of the requirement.
  assert.equal(picture.funding.binding_requirement.usable, false);
  assert.equal(picture.funding.binding_requirement.value_rupees, null);
  assert.equal(report.allowed, false, "abundant funds must not excuse an uncorroborated claim");
  assert.ok(
    report.reasons.includes("funding_stage_unknown"),
    `expected funding_stage_unknown, got ${JSON.stringify(report.reasons)}`,
  );
});

test("R2 a NET broker with a REPORTED encumbrance is netted once and admits", () => {
  // The other half: when the utilisation IS reported the double count must stay gone.
  const { usable, picture, report } = admitWithFunds({
    broker: "zerodha",
    availableRupees: 200_000,
    utilisedRupees: 50_000,
    initial: 96_505,
    final: 34_787,
  });
  assert.equal(usable.value_rupees, 200_000, "not subtracted — the broker already netted it");
  assert.equal(usable.encumbranceNettedFromAvailable, true);
  assert.equal(
    picture.funding.binding_requirement.value_rupees,
    96_505,
    "and not re-added to the requirement either",
  );
  assert.equal(report.allowed, true, `should admit; detail: ${report.detail ?? "(none)"}`);
});

test("R3 a reported ZERO encumbrance is a real figure, not a missing one", () => {
  const { usable, picture, report } = admitWithFunds({
    broker: "zerodha",
    availableRupees: 200_000,
    utilisedRupees: 0,
    initial: 96_505,
    final: 34_787,
  });
  assert.equal(usable.encumbranceMissing, false, "a trustworthy 0 is not an absence");
  assert.equal(usable.encumbranceNettedFromAvailable, true);
  assert.equal(picture.funding.binding_requirement.value_rupees, 96_505);
  assert.equal(report.allowed, true);
});

test("R4 a GROSS/unverified broker still fails closed on the FUNDS side", () => {
  // Unchanged by the netting fix, re-asserted here so the two arms are pinned together.
  const { usable, report } = admitWithFunds({
    broker: "dhan",
    availableRupees: 200_000,
    utilisedRupees: null,
    initial: 96_505,
    final: 34_787,
  });
  assert.equal(usable.value_rupees, null, "spendable funds cannot be computed without it");
  assert.equal(usable.encumbranceNettedFromAvailable, false);
  assert.equal(report.allowed, false);
});
