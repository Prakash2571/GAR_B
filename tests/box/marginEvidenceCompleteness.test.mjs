/**
 * MARGIN EVIDENCE: COMPLETENESS (defect A) and DHAN INITIAL-MARGIN SEMANTICS (defect B).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT A — A PARTIAL PER-LEG SUM WAS RETURNED AS BASKET EVIDENCE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `dhanBasketMargin()` fell back to summing standalone leg margins when the hedge-aware
 * multi-order call failed. That fallback counted SUCCESSES (`priced++`) and refused only the
 * `priced === 0` case. With four legs requested, the multi call failing, ONE leg answering
 * `{ totalMargin: 1000, spanMargin: 500 }` and the other THREE throwing, it returned
 * `{ total: 1000, source: "dhan_per_leg_fallback" }` — a figure indistinguishable, in the
 * returned value, from a complete four-leg sum. Nothing on `BoxBasketMargin` could express
 * "this is 1 leg of 4", so the engine's `plannedMargin` provider (which rejected only
 * `source === "unavailable"`) forwarded it as usable basket-margin evidence for live admission.
 *
 * The same hole existed one step earlier: a leg whose tradingsymbol did not resolve to a Dhan
 * security id was silently `continue`d, so the sum could cover a SUBSET of the basket while the
 * log called it "conservative". A sum over fewer legs than requested is an UNDER-statement.
 *
 * Two coercions manufactured the numbers: `Number(res.totalMargin) || 0` and
 * `Number(res.spanMargin) || 0` turned missing, null, malformed, and NaN values into 0 and
 * silently folded them into the total.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT B — SPAN WAS PROMOTED TO "INITIAL EXECUTION-STAGE FUNDING"
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The mapping was `initial: Math.round(normalized.span ?? 0)`. SPAN is a COMPONENT of an F&O
 * margin (SPAN + exposure + premium ...), not a statement of the funding required at an
 * intermediate point of a four-leg execution sequence. Two consequences:
 *   * SPAN present (30,000 against a 41,250 total) became an "established" initial requirement
 *     of 30,000 — a number Dhan never claimed means that.
 *   * SPAN ABSENT became `?? 0` → `initial: 0`. `Number.isFinite(0)` is true, so the engine
 *     forwarded `initialMarginRupees: 0` as an ESTABLISHED figure, `buildFundingStages` took
 *     `margin_basis: "initial_basket"`, and the stage requirement collapsed to
 *     `Math.max(0, cumulative BUY premium)` — the gross option premium, which is exactly what
 *     that code's own comment says "does NOT bound a margin requirement".
 *
 * NO OFFICIAL DHAN DOCUMENTATION was reachable from the build environment to establish that ANY
 * Dhan margin field carries "initial/execution-stage requirement" semantics, and Zerodha's
 * documented `initial`/`final` meanings must not be transplanted onto Dhan fields. Per the
 * working rule, an unsupported requirement is represented as UNKNOWN (null) and strict
 * stage-funded entry REFUSES with an actionable reason. It is never invented.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * FAILING-FIRST
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Against the pre-fix implementation (24ecfdb) the A-section partial/invalid cases fail because
 * the basket is reported usable with a understated total, and the B-section cases fail because
 * `initial` is 30,000 (SPAN) or 0 (missing SPAN) instead of null.
 *
 * Every broker network call is mocked. No live broker endpoint is contacted.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ActiveBrokerManager } from "../../dist/brokers/registry.js";
import {
  buildEconomicPicture,
  buildFundingStages,
  evaluateEconomicAdmission,
} from "../../dist/box/boxCapital.js";

/* ────────────────────────────── fixtures ────────────────────────────── */

const BOX_ORDERS = [
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2500CE", transaction_type: "BUY",  variety: "regular", product: "NRML", order_type: "LIMIT", quantity: 275, price: 50 },
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2520CE", transaction_type: "SELL", variety: "regular", product: "NRML", order_type: "LIMIT", quantity: 275, price: 30 },
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2520PE", transaction_type: "BUY",  variety: "regular", product: "NRML", order_type: "LIMIT", quantity: 275, price: 40 },
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2500PE", transaction_type: "SELL", variety: "regular", product: "NRML", order_type: "LIMIT", quantity: 275, price: 20 },
];

/**
 * A manager with the Dhan instrument store seeded and the Dhan client stubbed.
 *
 * `perLeg` is a function of the resolved securityId, so an INDIVIDUAL leg can fail or return a
 * malformed payload — the granularity the pre-fix tests lacked, and the reason the partial
 * fallback survived them.
 *
 * `resolveOnly` limits which tradingsymbols resolve to a Dhan security id, reproducing the
 * unresolved-instrument hole.
 */
function marginManager({ multi = "throw", perLeg, resolveOnly, kiteBasket } = {}) {
  const calls = { multi: 0, perLeg: 0, perLegIds: [], multiLegs: null, kite: 0 };
  const m = new ActiveBrokerManager({
    kite: {
      getAccessToken: () => "k",
      getApiKey: () => "k",
      getQuoteFull: async () => [],
      getBasketMargin: async () => {
        calls.kite++;
        if (kiteBasket === "throw") throw new Error("kite basket unavailable");
        return (
          kiteBasket ?? {
            initial: 96_505,
            final: 34_787,
            total: 34_787,
            initial_available: true,
            final_available: true,
            total_basis: "final",
          }
        );
      },
    },
    tickerHub: {
      isConnected: () => true, subscribedCount: () => 0, subscribeTokens: () => {},
      unsubscribeTokens: () => {}, stop: () => {}, seed: () => {}, retain: () => () => {},
      addTickListener: () => () => {}, addConnectionListener: () => () => {},
      ingestExternalTicks: () => {}, setExternalConnected: () => {},
    },
    boxConfig: () => ({}),
    istDayKey: () => "2026-09-03",
    onDhanTicks: () => {},
  });

  const store = m.dhanInstrumentStore;
  store.load = async () => [];
  const wanted = resolveOnly ?? BOX_ORDERS.map((o) => o.tradingsymbol);
  const instruments = BOX_ORDERS.filter((o) => wanted.includes(o.tradingsymbol)).map((o) => ({
    exchange: "NFO",
    tradingsymbol: o.tradingsymbol,
    dhan_segment: "NSE_FNO",
    dhan_security_id: 45000 + BOX_ORDERS.findIndex((b) => b.tradingsymbol === o.tradingsymbol),
    instrument_token: 2_000_045_000 + BOX_ORDERS.findIndex((b) => b.tradingsymbol === o.tradingsymbol),
  }));
  Object.defineProperty(store, "instruments", { get: () => instruments, configurable: true });

  const client = m.dhan;
  client.calculateMultiMargin = async (legs) => {
    calls.multi++;
    calls.multiLegs = legs;
    if (typeof multi === "function") return multi(legs);
    if (multi === "throw") throw new Error("multi endpoint unavailable");
    return multi;
  };
  client.calculateMargin = async (leg) => {
    calls.perLeg++;
    calls.perLegIds.push(leg.securityId);
    if (perLeg === "throw") throw new Error("per-leg unavailable");
    if (typeof perLeg === "function") {
      const out = perLeg(leg.securityId, leg);
      if (out === "throw") throw new Error(`per-leg unavailable for ${leg.securityId}`);
      return out;
    }
    return perLeg ?? { totalMargin: 50_000, spanMargin: 40_000 };
  };
  return { m, calls };
}

function activateDhan(m) {
  Object.defineProperty(m, "active", { value: "dhan", writable: true, configurable: true });
}

/** Dhan active, per-leg fallback forced (multi throws). */
async function dhanFallback(opts) {
  const { m, calls } = marginManager(opts);
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  return { res, calls };
}

/**
 * "Usable as basket evidence for LIVE ADMISSION".
 *
 * This is the single property defect A violated. It is deliberately expressed as the conjunction
 * the engine's `plannedMargin` provider must enforce, so the test pins the CONTRACT rather than
 * one particular field name.
 */
function usableForAdmission(res) {
  return (
    res.source !== "unavailable" &&
    res.complete === true &&
    res.total !== null &&
    Number.isFinite(res.total)
  );
}

/* ═════════════════════════ A. COMPLETENESS ═════════════════════════ */

test("A0 baseline: all four legs priced makes a COMPLETE, usable per-leg fallback", async () => {
  const { res, calls } = await dhanFallback({
    perLeg: () => ({ totalMargin: 50_000, spanMargin: 40_000 }),
  });
  assert.equal(calls.perLeg, 4, "every requested leg is resolved before evidence is accepted");
  assert.equal(res.source, "dhan_per_leg_fallback");
  assert.equal(res.complete, true);
  assert.equal(res.legs_requested, 4);
  assert.equal(res.legs_priced, 4);
  assert.equal(res.total, 200_000);
  assert.ok(usableForAdmission(res));
});

test("A1 REPRODUCTION: one leg priced, three failing is NOT usable basket evidence", async () => {
  // The exact confirmed baseline: totalMargin=1000 / spanMargin=500 on ONE leg, three failures.
  // Pre-fix this returned { total: 1000, source: "dhan_per_leg_fallback" } and was ACCEPTED.
  const { res } = await dhanFallback({
    perLeg: (id) => (id === "45000" ? { totalMargin: 1000, spanMargin: 500 } : "throw"),
  });
  assert.equal(
    usableForAdmission(res),
    false,
    "a 1-of-4 sum must never be usable basket-margin evidence for live admission",
  );
  assert.equal(res.complete, false);
  assert.equal(res.legs_priced, 1);
  assert.equal(res.legs_requested, 4);
  assert.notEqual(res.total, 1000, "the understated partial sum must not be published as the total");
  assert.equal(res.total, null, "an incomplete basket has NO total, not a small one");
  assert.match(String(res.incomplete_reason), /1\D*4|leg/i, "the refusal names the missing legs");
});

test("A2 EACH individual leg failing makes the basket unusable", async () => {
  for (const failing of ["45000", "45001", "45002", "45003"]) {
    const { res } = await dhanFallback({
      perLeg: (id) => (id === failing ? "throw" : { totalMargin: 50_000, spanMargin: 40_000 }),
    });
    assert.equal(
      usableForAdmission(res),
      false,
      `leg ${failing} failing must invalidate the basket (3 of 4 is not evidence)`,
    );
    assert.equal(res.legs_priced, 3);
    assert.equal(res.complete, false);
  }
});

test("A3 ALL legs failing reports unavailable, never zero margin", async () => {
  const { res } = await dhanFallback({ perLeg: "throw" });
  assert.equal(res.source, "unavailable");
  assert.equal(res.complete, false);
  assert.equal(res.legs_priced, 0);
  assert.equal(usableForAdmission(res), false);
  assert.notEqual(res.total, 0, "zero would read as 'this box is margin-free'");
});

test("A4 an UNRESOLVED instrument invalidates the basket instead of margining a subset", async () => {
  // Pre-fix: the unresolved leg was `continue`d, the multi call was skipped, and the sum over the
  // surviving 3 legs was labelled "conservative". A sum over fewer legs UNDER-states.
  const { res, calls } = await dhanFallback({
    resolveOnly: ["ASTRAL25SEP2500CE", "ASTRAL25SEP2520CE", "ASTRAL25SEP2520PE"],
    perLeg: () => ({ totalMargin: 50_000, spanMargin: 40_000 }),
  });
  assert.equal(usableForAdmission(res), false, "3 of 4 legs resolved is not a margined basket");
  assert.equal(res.complete, false);
  assert.equal(res.legs_requested, 4);
  assert.equal(calls.multi, 0, "a partial basket is never sent to the hedge-aware endpoint");
  assert.match(String(res.incomplete_reason), /resolve|security id/i);
});

test("A5 missing / null / malformed / negative / non-finite totalMargin invalidates that leg", async () => {
  // Every one of these was previously coerced to 0 by `Number(res.totalMargin) || 0` and folded
  // into the total, so a malformed response LOWERED the requirement.
  const hostile = [
    ["missing", {}],
    ["null", { totalMargin: null }],
    ["undefined", { totalMargin: undefined }],
    ["malformed string", { totalMargin: "abc" }],
    ["empty string", { totalMargin: "" }],
    ["negative", { totalMargin: -5_000 }],
    ["NaN", { totalMargin: Number.NaN }],
    ["Infinity", { totalMargin: Number.POSITIVE_INFINITY }],
    ["object", { totalMargin: { value: 1 } }],
    ["boolean", { totalMargin: true }],
  ];
  for (const [label, payload] of hostile) {
    const { res } = await dhanFallback({
      perLeg: (id) => (id === "45002" ? { ...payload, spanMargin: 1 } : { totalMargin: 50_000, spanMargin: 40_000 }),
    });
    assert.equal(
      usableForAdmission(res),
      false,
      `a ${label} totalMargin must invalidate the basket, not coerce to 0`,
    );
    assert.equal(res.complete, false, `${label}: basket must be incomplete`);
    assert.notEqual(res.total, 150_000, `${label}: the bad leg must not silently contribute 0`);
  }
});

test("A6 an EXPLICIT documented zero is honoured and kept distinct from absent", async () => {
  // A real, structurally valid 0 is a value; a missing field is not. They must not be conflated.
  const { res } = await dhanFallback({
    perLeg: (id) => (id === "45003" ? { totalMargin: 0, spanMargin: 0 } : { totalMargin: 50_000, spanMargin: 40_000 }),
  });
  assert.equal(res.complete, true, "an explicit zero is a resolved leg");
  assert.equal(res.legs_priced, 4);
  assert.equal(res.total, 150_000, "0 contributes 0 — deliberately, not by coercion");
  assert.ok(usableForAdmission(res));
});

test("A7 numeric STRINGS are validated deliberately rather than blindly coerced", async () => {
  const { res } = await dhanFallback({
    perLeg: () => ({ totalMargin: "50000", spanMargin: "40000" }),
  });
  assert.equal(res.complete, true);
  assert.equal(res.total, 200_000, "a well-formed numeric string is accepted as the number it is");
});

/* ══════════════ B. DHAN INITIAL-MARGIN SEMANTICS ══════════════ */

test("B1 REPRODUCTION: SPAN=30000 with total=41250 does NOT establish initial funding of 30000", async () => {
  const { res } = await dhanFallback({
    multi: { totalMargin: 41_250, spanMargin: 30_000, exposureMargin: 11_250, marginBenefit: 158_750 },
  });
  assert.equal(res.source, "dhan_multi");
  assert.equal(res.total, 41_250, "the hedge-aware basket total is still used as the total");
  assert.notEqual(res.initial, 30_000, "SPAN is a COMPONENT, not an execution-stage requirement");
  assert.equal(res.initial, null, "no documented Dhan initial field exists → UNKNOWN");
  assert.equal(res.span, 30_000, "SPAN is still reported, as a labelled component");
  assert.equal(res.exposure, 11_250);
});

test("B2 REPRODUCTION: a MISSING SPAN does not establish initial funding of ZERO", async () => {
  const { res } = await dhanFallback({ multi: { totalMargin: 41_250 } });
  assert.equal(res.total, 41_250);
  assert.notEqual(res.initial, 0, "`span ?? 0` turned 'unknown' into 'free'");
  assert.equal(res.initial, null);
  assert.equal(res.span, null, "absent stays absent");
});

test("B3 the per-leg fallback also refuses to invent an initial requirement", async () => {
  const { res } = await dhanFallback({ perLeg: () => ({ totalMargin: 50_000 }) });
  assert.equal(res.complete, true);
  assert.equal(res.initial, null, "a sum of standalone SPANs is not a stage requirement either");
});

test("B4 Zerodha's DOCUMENTED initial/final meanings are preserved", async () => {
  const { m } = marginManager({});
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(res.source, "kite_basket");
  assert.equal(res.initial, 96_505, "Kite documents data.initial.total as the execute-the-orders margin");
  assert.equal(res.final, 34_787, "and data.final.total as the spread-benefit margin");
  assert.equal(res.complete, true);
});

test("B5 a Kite response MISSING the initial block yields UNKNOWN, not zero", async () => {
  const { m } = marginManager({
    kiteBasket: {
      initial: 0, final: 34_787, total: 34_787,
      initial_available: false, final_available: true, total_basis: "final",
    },
  });
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(res.initial, null, "presence must be tracked separately from value");
  assert.equal(res.final, 34_787);
});

/* ══════════ B/A JOINED: what admission does with the evidence ══════════ */

function requests() {
  const mk = (role, side, price) => ({
    client_order_id: `BOX:T1:ENTRY:${role}:a1`,
    role, side, quantity: 75,
    tradingsymbol: `NIFTY26OCT${role}`, exchange: "NFO", token: 1000 + role.length,
    pricing: { order_type: "LIMIT", limit_price: price, reference_price: price, tick_size: 0.05, max_chase_ticks: 3 },
  });
  return [mk("k1_ce", "BUY", 200), mk("k1_pe", "BUY", 20), mk("k2_ce", "SELL", 30), mk("k2_pe", "SELL", 150)];
}

const TRANSPORT_ORDER = [
  { role: "k1_ce", side: "BUY", rank: 0 },
  { role: "k1_pe", side: "BUY", rank: 1 },
  { role: "k2_ce", side: "SELL", rank: 2 },
  { role: "k2_pe", side: "SELL", rank: 3 },
];

test("B6 an UNKNOWN initial leaves every intermediate stage unknown (never premium-only)", () => {
  const out = buildFundingStages({
    requests: requests(),
    transportOrder: TRANSPORT_ORDER,
    initialMarginRupees: null,
    finalMarginRupees: 34_787,
  });
  const intermediate = out.stages.slice(0, -1);
  for (const s of intermediate) {
    assert.equal(s.margin_basis, "unknown", `${s.role} must not claim an initial_basket basis`);
    assert.equal(s.requirement_rupees, null);
    assert.equal(s.known, false);
  }
  assert.ok(out.unknown.length > 0, "the unknown stages are reported, not hidden");
});

test("B7 REPRODUCTION: a ZERO initial must not make intermediate stages premium-only", () => {
  // Pre-fix `initial: 0` passed `!== null && isFinite`, took margin_basis "initial_basket", and
  // the requirement became Math.max(0, cumulative BUY premium) — the gross premium.
  const out = buildFundingStages({
    requests: requests(),
    transportOrder: TRANSPORT_ORDER,
    initialMarginRupees: 0,
    finalMarginRupees: 34_787,
  });
  const first = out.stages[0];
  const premiumOnly = 200 * 75; // the k1_ce debit alone
  assert.notEqual(
    first.requirement_rupees,
    premiumOnly,
    "gross premium does not bound a short-option margin requirement",
  );
});

test("B8 unknown intermediate funding REFUSES strict stage-funded entry with a reason", () => {
  const picture = buildEconomicPicture({
    requests: requests(),
    now: 1_000,
    availableFundsRupees: 10_000_000,
    availableFundsBasis: "zerodha: available is net of encumbrance",
    availableFundsAged: { status: "usable", note: "fresh" },
    plannedMarginRupees: 34_787,
    plannedMarginAged: { status: "usable", note: "fresh" },
    planFingerprint: "fp-1",
    estimatedChargesRupees: 120,
    expectedLegCount: 4,
    funding: {
      transportOrder: TRANSPORT_ORDER,
      initialMarginRupees: null, // Dhan: UNKNOWN
      finalMarginRupees: 34_787,
      encumbranceRupees: 0,
      recoveryReserveRupees: 0,
    },
  });
  const report = evaluateEconomicAdmission({
    picture, grossCapRupees: 0,
    requireFundsCover: true, requireMarginEvidence: true, requireStageFunding: true,
    evaluatedAt: 1_000, planFingerprint: "fp-1",
  });
  assert.equal(report.allowed, false, "abundant funds must not excuse an unknown stage requirement");
  assert.ok(
    report.reasons.includes("funding_stage_unknown"),
    `expected funding_stage_unknown, got ${JSON.stringify(report.reasons)}`,
  );
});

test("B9 funds cover must NOT silently fall back to gross option premium", () => {
  // With no usable margin figure at all, the pre-fix `need` ladder used
  // picture.worst_case_entry (the gross BUY premium). Gross premium does not bound the margin a
  // short option requires, so admitting on it authorises unfunded exposure.
  const picture = buildEconomicPicture({
    requests: requests(),
    now: 1_000,
    availableFundsRupees: 20_000, // enough for the premium, nowhere near a real margin
    availableFundsBasis: "zerodha: available is net of encumbrance",
    availableFundsAged: { status: "usable", note: "fresh" },
    plannedMarginRupees: null,
    plannedMarginAged: { status: "unavailable", note: "no margin evidence" },
    planFingerprint: "fp-1",
    estimatedChargesRupees: 120,
    expectedLegCount: 4,
  });
  const report = evaluateEconomicAdmission({
    picture, grossCapRupees: 0,
    requireFundsCover: true, requireMarginEvidence: false, requireStageFunding: false,
    evaluatedAt: 1_000, planFingerprint: "fp-1",
  });
  assert.equal(report.allowed, false, "funds cover cannot be satisfied without a margin bound");
  assert.ok(
    report.reasons.includes("metric_incomplete"),
    `expected metric_incomplete, got ${JSON.stringify(report.reasons)}`,
  );
});


/* ═════════════════════════════════════════════════════════════════════════════════════════
 * SECTION R — REVIEW FINDINGS ON THE FIX ITSELF
 *
 * The completeness fix established that a ₹0 requirement for a four-leg basket containing SHORT
 * options is what a fabricated or misread payload looks like — and enforced it in the stage model
 * (`usableFigure`), in `normalizeDhanMultiMargin`, and in the decision to make `total` nullable
 * "rather than 0". A review found the per-leg fallback it rewrote did NOT apply the same rule:
 * four legs each answering `{ totalMargin: 0 }` satisfied the completeness COUNT and were returned
 * as `{ total: 0, complete: true }` — the field the rest of the system now treats as the
 * completeness authority. Funds-cover then compared available funds against a ₹0 requirement and
 * admitted.
 *
 * Stage funding rejected it one layer above, so the supervised trial profile was protected; the
 * weaker two controls, which are configurable on their own, were not.
 * ═════════════════════════════════════════════════════════════════════════════════════════ */

test("R1 REPRODUCTION: four legs each answering ZERO is not complete evidence", async () => {
  const { res } = await dhanFallback({ perLeg: () => ({ totalMargin: 0, spanMargin: 0 }) });
  assert.equal(
    usableForAdmission(res),
    false,
    "a summed requirement of ₹0 for a basket containing short options is not credible",
  );
  assert.equal(res.complete, false);
  assert.equal(res.total, null, "reported as unknown, not as a margin-free basket");
  assert.equal(res.source, "unavailable");
  assert.match(String(res.incomplete_reason), /non-positive|₹0/i);
});

test("R2 a partially-zero basket that still sums positive remains usable", async () => {
  // The guard is on the TOTAL, not on each leg: a genuine zero on one leg is still a real answer
  // (A6 above), and must not be turned into a refusal when the basket total is credible.
  const { res } = await dhanFallback({
    perLeg: (id) => (id === "45003" ? { totalMargin: 0 } : { totalMargin: 50_000 }),
  });
  assert.equal(res.complete, true);
  assert.equal(res.total, 150_000);
  assert.ok(usableForAdmission(res));
});
