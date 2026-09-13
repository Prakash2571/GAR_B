/**
 * SECTION 3 — FUNDS/MARGIN EVIDENCE TIMING, on the REAL production path.
 *
 * REPORTED DEFECT (root cause). `CentralBoxExecutionGateway.evaluateEntryEconomics()` captured the
 * evaluation instant (`const now = this.now()`) BEFORE awaiting the funds and planned-margin reads.
 * The engine's providers (`src/box/engine.ts` funds / plannedMargin) stamp `observedAt: Date.now()`
 * AFTER their broker round trip resolves. So for any read that takes real time,
 *
 *     observedAt  >  now      ⇒      age = now - observedAt  <  0
 *
 * and `brokerFigure()` (src/box/boxCapital.ts) requires `age >= 0` to call a figure fresh. A
 * PERFECTLY FRESH broker response was therefore downgraded to "stale", marked unusable, and the
 * economic gate refused a valid live entry. The bug is invisible under a frozen test clock (the
 * pre-existing economicAdmissionWiring suite stamps `observedAt === now`), which is exactly why it
 * survived: it only appears when the clock ADVANCES across the awaits, i.e. always, in production.
 *
 * These tests drive the REAL gateway with a clock that advances during the provider awaits, the way
 * a real broker round trip does. They also pin the surrounding requirements: independent
 * observation timestamps, monotonic in-process aging, bounded reads, no revival of cached evidence,
 * evidence bound to broker/account/session identity, re-validation of the candidate and the order
 * plan after the asynchronous reads, and an explicit refusal (never a hang) when a read stalls.
 *
 * FAILING-FIRST: on 2a62398 the first test ("delayed but fresh ... ADMITS") fails with
 * `insufficient_available_funds` / `margin_evidence_stale_or_missing` because the age is negative.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg, exitQuotes, goodCandidate, seedStore } from "./helpers.mjs";

const NOW = 10_000_000;

/**
 * A controllable pair of clocks. `wall` is what the audit trail and the broker `observedAt` use;
 * `mono` is what durations must be measured on. They advance TOGETHER here so a test that only
 * moves time forward behaves like production; `skewWall` moves the wall clock ALONE, which is the
 * NTP-correction case monotonic aging has to survive.
 */
function clocks(start = NOW) {
  const state = { wall: start, mono: 5_000 };
  return {
    wall: () => state.wall,
    mono: () => state.mono,
    /** Advance both clocks, as real elapsed time does. */
    advance(ms) {
      state.wall += ms;
      state.mono += ms;
    },
    /** Move the WALL clock only (NTP step). Monotonic time is unaffected, by definition. */
    skewWall(ms) {
      state.wall += ms;
    },
  };
}

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
 * The REAL CentralBoxExecutionGateway in live mode over a fake manager, with an ADVANCING clock.
 * Every knob here corresponds to a production dependency; nothing about the economic path is
 * stubbed out.
 */
function harness({ config = {}, funds, plannedMargin, evidenceContext, clock = clocks(), stillWanted } = {}) {
  const { candidate } = goodCandidate();
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, 198, { at: NOW, qty: 100_000 }), NOW);
  const submitted = [];
  const guards = [];
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({
      executionMode: "live",
      liveTradingEnabled: true,
      queueModel: "none",
      liveMaxChaseTicks: 2,
      legMaxChaseTicks: 2,
      unwindMaxChaseTicks: 5,
      liveMaxBoxCapitalRupees: 1_000_000_000,
      // Freshness windows deliberately TIGHTER than the delays under test would need if the age
      // were computed the broken way, so a negative age cannot accidentally pass as fresh.
      liveFundsFreshnessMaxAgeMs: 5_000,
      liveMarginFreshnessMaxAgeMs: 5_000,
      ...config,
    }),
    simulator: { hasCapacity: () => false, estimateExecutableExit: () => [] },
    quotes,
    manager: {
      status: () => ({ inFlight: 0, queued: 0 }),
      submit: async (req, feed, capital, guard) => {
        submitted.push({ ...req, _capital: capital ?? null });
        if (guard) guards.push(guard);
        return brokerOrder(req);
      },
      invariantViolation: () => {},
    },
    broker: () => "zerodha",
    allocateTradeId: () => "trade-1",
    isTokenWarm: () => true,
    feedGeneration: () => 7,
    // PRODUCTION CLOCK MODEL: wall for audit, monotonic for durations. Both injected.
    now: () => clock.wall(),
    monotonicNow: () => clock.mono(),
    chargeTotal: () => 0,
    ...(funds ? { funds } : {}),
    ...(plannedMargin ? { plannedMargin } : {}),
    ...(evidenceContext ? { evidenceContext } : {}),
  });
  return { candidate, quotes, gateway, submitted, guards, clock, stillWanted };
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

function runEntry(h, { stillWanted } = {}) {
  return h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection: entryDetection(h),
    stillWanted: stillWanted ?? (() => true),
    qualify: () => ({ qualifies: true }),
  });
}

/** A provider that costs real (virtual) time, then stamps observedAt at the moment it RESOLVES. */
function delayedFunds(clock, { delayMs, availableRupees = 10_000_000 }) {
  return async () => {
    clock.advance(delayMs);
    return { availableRupees, observedAt: clock.wall() };
  };
}

function delayedMargin(clock, { delayMs, marginRupees = 50_000 }) {
  return async () => {
    clock.advance(delayMs);
    return { marginRupees, observedAt: clock.wall() };
  };
}

// ── 1. The reported defect itself ────────────────────────────────────────────────────────────

test("delayed but FRESH funds+margin evidence ADMITS (evaluation instant is captured AFTER the reads)", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true, liveRequireMarginEvidence: true },
    // Realistic Mumbai-to-broker round trips. Both well inside the 5s freshness window.
    funds: delayedFunds(clock, { delayMs: 180 }),
    plannedMargin: delayedMargin(clock, { delayMs: 220 }),
  });
  const entry = await runEntry(h);
  const econ = h.gateway.economicDiagnostics();
  assert.ok(econ, "economic diagnostics present");
  assert.ok(
    (econ.picture.available_funds.age_ms ?? -1) >= 0,
    `funds age must never be negative, got ${econ.picture.available_funds.age_ms}`,
  );
  assert.ok(
    (econ.picture.planned_margin.age_ms ?? -1) >= 0,
    `margin age must never be negative, got ${econ.picture.planned_margin.age_ms}`,
  );
  assert.equal(econ.picture.available_funds.provenance, "broker_confirmed", "fresh funds are broker_confirmed");
  assert.equal(econ.picture.planned_margin.provenance, "broker_confirmed", "fresh margin is broker_confirmed");
  assert.equal(econ.allowed, true, `economic admission must allow: ${econ.detail ?? "(no detail)"}`);
  assert.equal(entry.ok, true, "a valid entry with fresh delayed evidence is admitted");
  assert.equal(h.submitted.length, 4, "all four legs submitted");
});

test("independent observation timestamps are PRESERVED (fast read + slow read keep their own ages)", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true, liveRequireMarginEvidence: true },
    funds: delayedFunds(clock, { delayMs: 20 }),      // fast
    plannedMargin: delayedMargin(clock, { delayMs: 900 }), // slow
  });
  await runEntry(h);
  const p = h.gateway.economicDiagnostics().picture;
  assert.notEqual(p.available_funds.observed_at, p.planned_margin.observed_at,
    "the two reads were observed at different instants and must keep distinct observed_at");
  assert.ok(p.available_funds.age_ms >= 0 && p.planned_margin.age_ms >= 0, "no negative ages");
  assert.ok(
    p.available_funds.age_ms > p.planned_margin.age_ms,
    `the EARLIER (fast) observation must be the OLDER one: funds=${p.available_funds.age_ms}ms ` +
      `margin=${p.planned_margin.age_ms}ms`,
  );
  assert.equal(p.available_funds.usable, true, "the fast read is still within the freshness window");
  assert.equal(p.planned_margin.usable, true, "the slow read is fresh — it was just observed");
});

// ── 2. Controls must still bite: nothing above may be "fixed" by accepting everything ────────

test("genuinely STALE cached evidence is still REFUSED (no revival by restamping)", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true, liveFundsFreshnessMaxAgeMs: 1_000 },
    // A CACHE hit: the value was observed 60s ago and the provider honestly reports that.
    funds: async () => ({ availableRupees: 10_000_000, observedAt: clock.wall() - 60_000 }),
  });
  const entry = await runEntry(h);
  const p = h.gateway.economicDiagnostics().picture;
  assert.equal(p.available_funds.provenance, "stale", "old evidence stays stale; it is never restamped as fresh");
  assert.ok(p.available_funds.age_ms >= 60_000, "the real age is reported, not zeroed");
  assert.equal(entry.ok, false, "stale funds evidence must refuse entry");
  assert.equal(entry.legging.outcome_class, "REFUSED_BEFORE_SUBMIT", "refused before any exposure");
  assert.equal(h.submitted.length, 0, "nothing submitted");
});

test("a MATERIALLY FUTURE-DATED broker timestamp is refused explicitly, not treated as fresh", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true },
    // A broker/host clock far ahead of ours. This must NOT be silently accepted as "age 0".
    funds: async () => ({ availableRupees: 10_000_000, observedAt: clock.wall() + 3_600_000 }),
  });
  const entry = await runEntry(h);
  const p = h.gateway.economicDiagnostics().picture;
  assert.equal(p.available_funds.usable, false, "a figure stamped an hour in the future is not usable");
  assert.equal(p.available_funds.provenance, "invalid", "future-dated evidence is INVALID, distinct from stale");
  assert.equal(entry.ok, false, "entry refused");
  assert.equal(h.submitted.length, 0, "nothing submitted");
});

test("a NON-FINITE observation timestamp or value is refused explicitly", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true },
    funds: async () => ({ availableRupees: Number.NaN, observedAt: clock.wall() }),
  });
  const entry = await runEntry(h);
  const p = h.gateway.economicDiagnostics().picture;
  assert.equal(p.available_funds.usable, false, "NaN funds are unknown, never ₹0");
  assert.equal(p.available_funds.value_rupees, null, "no fabricated value");
  assert.equal(entry.ok, false);
  assert.equal(h.submitted.length, 0);
});

// ── 3. Bounded reads: a stalled broker must not hang admission ───────────────────────────────

test("a STALLED broker read is bounded and refuses; admission never hangs", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: {
      liveRequireFundsCover: true,
      liveEvidenceReadTimeoutMs: 250,
    },
    // Never resolves. Without a bound, the whole entry path would await forever.
    funds: () => new Promise(() => {}),
  });
  const entry = await Promise.race([
    runEntry(h),
    new Promise((_, reject) => setTimeout(() => reject(new Error("admission HUNG on a stalled broker read")), 5_000)),
  ]);
  const p = h.gateway.economicDiagnostics().picture;
  assert.equal(p.available_funds.provenance, "unavailable", "a timed-out read yields UNKNOWN, never a value");
  assert.match(p.available_funds.note, /timed out|timeout|unavailable/i, "the note names the timeout honestly");
  assert.equal(entry.ok, false, "refused: the control could not be proven");
  assert.equal(h.submitted.length, 0, "nothing submitted");
});

test("a THROWING evidence source is unavailable, not a fabricated zero", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true },
    funds: async () => { throw new Error("HTTP 503 from broker"); },
  });
  const entry = await runEntry(h);
  const p = h.gateway.economicDiagnostics().picture;
  assert.equal(p.available_funds.value_rupees, null, "no value");
  assert.equal(p.available_funds.provenance, "unavailable");
  assert.equal(entry.ok, false);
  assert.equal(h.submitted.length, 0);
});

// ── 4. Monotonic aging: a wall-clock step must not fabricate or erase staleness ───────────────
//
// TWO DISTINCT CONCERNS, deliberately tested apart:
//
//   (a) The SOURCE's own timestamp versus ours, compared at the same instant. A material gap means
//       either a cache hit or a clock disagreement, and neither can be timed reliably — so the
//       figure is refused. The "stale cached evidence" and "future-dated" tests above cover that,
//       and refusing is the conservative direction.
//   (b) AGING BETWEEN two of our own readings — observation → evaluation, and admission → send
//       boundary. This must run on the MONOTONIC clock so an NTP correction in that window can
//       neither fabricate staleness nor erase it. That is what these two tests pin.

test("a BACKWARD wall-clock step between the read and the evaluation does not turn fresh evidence stale", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true, liveFundsFreshnessMaxAgeMs: 5_000 },
    funds: delayedFunds(clock, { delayMs: 50 }),
    plannedMargin: async () => {
      clock.advance(10);
      // NTP corrects the host clock BACKWARD by 30s AFTER the funds figure was observed but BEFORE
      // the evaluation instant is taken. Wall-clock aging would now compute age = -30_000 for the
      // funds figure and call a perfectly fresh number stale.
      clock.skewWall(-30_000);
      // A USABLE margin figure. This stub used to return null, and the funds-cover check then
      // silently compared funds against the gross option premium (`worst_case_entry`). That
      // substitution has been removed — premium does not bound short-option margin — so a real
      // requirement must be supplied for this test to exercise what it is actually about: that a
      // wall-clock step does not fabricate staleness.
      return { marginRupees: 50_000, observedAt: clock.wall() };
    },
  });
  const entry = await runEntry(h);
  const p = h.gateway.economicDiagnostics().picture;
  assert.equal(p.available_funds.usable, true,
    `evidence observed 60ms ago must survive a wall-clock step; note: ${p.available_funds.note}`);
  assert.ok((p.available_funds.age_ms ?? -1) >= 0, "age is a monotonic duration and cannot be negative");
  assert.equal(p.available_funds.age_is_monotonic, true, "the age was taken from the monotonic clock");
  assert.equal(h.gateway.economicDiagnostics().allowed, true,
    `the ECONOMIC control must not refuse: ${h.gateway.economicDiagnostics().detail ?? "(none)"}`);
  void entry; // the entry as a whole is refused by the MARKET-DATA gate; see the forward-step test.
});

test("a FORWARD wall-clock step does not fabricate staleness in the ECONOMIC decision", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true, liveFundsFreshnessMaxAgeMs: 2_000 },
    funds: delayedFunds(clock, { delayMs: 30 }),
    // The host clock jumps 10 minutes forward after the funds read, before evaluation.
    plannedMargin: async () => {
      clock.skewWall(600_000);
      // Stamped AFTER the jump, i.e. "just observed" on the corrected clock. A usable figure is
      // required now that funds cover no longer falls back to gross option premium.
      return { marginRupees: 50_000, observedAt: clock.wall() };
    },
  });
  await runEntry(h);
  const econ = h.gateway.economicDiagnostics();
  assert.ok((econ.picture.available_funds.age_ms ?? 1e9) < 2_000,
    `monotonic age must stay small (got ${econ.picture.available_funds.age_ms}ms) despite a 10-minute wall jump`);
  assert.equal(econ.picture.available_funds.usable, true, "the figure was genuinely just observed");
  assert.equal(econ.allowed, true, `the ECONOMIC control must not refuse: ${econ.detail ?? "(none)"}`);
  // NOTE: the ENTRY as a whole is still refused here, and correctly so — a 10-minute wall jump makes
  // every quote in the book look 10 minutes old, which the MARKET-DATA freshness/coherence gate
  // refuses. That is a different control with its own evidence, and this test deliberately asserts
  // only the economic one so the two cannot be confused.
});

test("send-boundary aging is MONOTONIC: a wall jump does not expire evidence, real elapsed time does", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true, liveFundsFreshnessMaxAgeMs: 1_000 },
    funds: delayedFunds(clock, { delayMs: 20 }),
    // A real broker margin figure, so the funds-cover comparison has an actual requirement to
    // compare against rather than the gross-premium substitute that has been removed.
    plannedMargin: delayedMargin(clock, { delayMs: 10 }),
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, true, "admitted on fresh evidence");
  const guard = h.guards[0];
  clock.skewWall(600_000);
  assert.equal(guard.sendBoundaryEconomics(), null,
    "a wall-clock jump must not expire evidence at the send boundary — that age is monotonic too");
  clock.advance(5_000);
  assert.ok(guard.sendBoundaryEconomics(), "genuine monotonic elapsed time DOES expire it");
});

// ── 5. Evidence is bound to identity and to the order plan ───────────────────────────────────

test("evidence acquired for a DIFFERENT account/session is refused (identity binding)", async () => {
  const clock = clocks();
  let context = { broker: "zerodha", account_ref: "acct-A", session_id: "sess-1" };
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true },
    evidenceContext: () => context,
    funds: async () => {
      clock.advance(40);
      const observed = { availableRupees: 10_000_000, observedAt: clock.wall() };
      // The operator switched the account/session WHILE the read was in flight.
      context = { broker: "zerodha", account_ref: "acct-B", session_id: "sess-2" };
      return observed;
    },
  });
  const entry = await runEntry(h);
  const p = h.gateway.economicDiagnostics().picture;
  assert.equal(p.available_funds.usable, false, "funds read against acct-A cannot admit an entry for acct-B");
  assert.match(
    h.gateway.economicDiagnostics().detail ?? "",
    /account|session|identity|context/i,
    "the refusal names the identity change",
  );
  assert.equal(entry.ok, false);
  assert.equal(h.submitted.length, 0, "nothing submitted after an identity change");
});

test("a BROKER switch during the evidence reads invalidates the evidence", async () => {
  const clock = clocks();
  let broker = "zerodha";
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true },
    evidenceContext: () => ({ broker, account_ref: "acct-A", session_id: "sess-1" }),
    funds: async () => {
      clock.advance(40);
      const observed = { availableRupees: 10_000_000, observedAt: clock.wall() };
      broker = "dhan"; // switched mid-read
      return observed;
    },
  });
  const entry = await runEntry(h);
  assert.equal(h.gateway.economicDiagnostics().picture.available_funds.usable, false,
    "Zerodha funds are not evidence about a Dhan account");
  assert.equal(entry.ok, false);
  assert.equal(h.submitted.length, 0);
});

test("the candidate is RE-VALIDATED after the asynchronous evidence reads", async () => {
  const clock = clocks();
  let wanted = true;
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true },
    funds: async () => {
      clock.advance(120);
      // The scanner withdrew the candidate (STOP, budget, or the opportunity vanished) while we
      // were waiting on the broker.
      wanted = false;
      return { availableRupees: 10_000_000, observedAt: clock.wall() };
    },
  });
  const entry = await runEntry(h, { stillWanted: () => wanted });
  assert.equal(entry.ok, false, "a withdrawn candidate must not be entered");
  assert.equal(entry.legging.outcome_class, "REFUSED_BEFORE_SUBMIT", "free refusal, no exposure");
  assert.equal(h.submitted.length, 0, "nothing submitted");
});

test("evidence is bound to the ORDER PLAN it was fetched for (a changed plan invalidates it)", async () => {
  const clock = clocks();
  const seen = [];
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true, liveRequireMarginEvidence: true },
    funds: delayedFunds(clock, { delayMs: 30 }),
    plannedMargin: async (requests) => {
      clock.advance(60);
      seen.push(requests.map((r) => `${r.role}:${r.side}:${r.quantity}@${r.pricing.limit_price}`).join("|"));
      return { marginRupees: 50_000, observedAt: clock.wall() };
    },
  });
  await runEntry(h);
  const econ = h.gateway.economicDiagnostics();
  assert.equal(seen.length, 1, "margin was requested for exactly one plan");
  assert.ok(econ.plan_fingerprint, "the report records WHICH order plan the evidence was fetched for");
  assert.equal(
    econ.picture.planned_margin.plan_fingerprint,
    econ.plan_fingerprint,
    "the margin figure is bound to that same plan fingerprint",
  );
});

// ── 6. The final entry boundary re-checks expiry and the plan before exposure starts ─────────

test("evidence that EXPIRES between admission and the send boundary blocks the POST", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: {
      liveRequireFundsCover: true,
      liveFundsFreshnessMaxAgeMs: 1_000,
    },
    funds: delayedFunds(clock, { delayMs: 20 }),
    // Supplies the funding requirement. Previously omitted, which made this test depend on the
    // gross-premium fallback that has since been removed from funds cover.
    plannedMargin: delayedMargin(clock, { delayMs: 10 }),
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, true, "admission itself succeeded on fresh evidence");
  // The REAL seam: the gateway passes a LiveEntryTransportGuard to manager.submit(); the manager
  // consults it at the final pre-POST boundary. The guard must carry an economic re-check.
  const guard = h.guards[0] ?? null;
  assert.ok(guard, "the gateway passed a transport guard to the manager");
  assert.equal(typeof guard.sendBoundaryEconomics, "function",
    "the guard supplies a send-boundary economic re-check alongside the coherence one");
  assert.equal(guard.sendBoundaryEconomics(), null, "fresh at this instant: no refusal");
  clock.advance(5_000); // the queue, durable persistence and broker pacing took 5s
  const refusal = guard.sendBoundaryEconomics();
  assert.ok(refusal, "once the evidence has expired the boundary must refuse the POST");
  assert.match(refusal, /expired|stale|fresh/i, "the refusal explains that the evidence expired");
});

test("a CHANGED order plan at the send boundary blocks the POST (evidence was fetched for the old plan)", async () => {
  const clock = clocks();
  const h = harness({
    clock,
    config: { liveRequireFundsCover: true, liveRequireMarginEvidence: true },
    funds: delayedFunds(clock, { delayMs: 20 }),
    plannedMargin: delayedMargin(clock, { delayMs: 20 }),
  });
  const entry = await runEntry(h);
  assert.equal(entry.ok, true);
  const guard = h.guards[0];
  assert.equal(guard.sendBoundaryEconomics(), null, "unchanged plan: no refusal");
  // A chase re-priced a leg after admission. The margin figure was computed for the OLD prices, so
  // it is no longer evidence about what is about to be sent.
  const refusal = guard.sendBoundaryEconomics({
    ...h.submitted[0],
    pricing: { ...h.submitted[0].pricing, limit_price: h.submitted[0].pricing.limit_price + 25 },
  });
  assert.ok(refusal, "a re-priced leg must invalidate the plan-bound evidence at the boundary");
  assert.match(refusal, /plan|price|quantit/i, "the refusal names the plan change");
});
