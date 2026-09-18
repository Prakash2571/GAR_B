/**
 * FOUR-LEG BOOK COHERENCE — the shared policy and its LIVE enforcement.
 *
 * Two layers of proof:
 *   1. The pure decision (executionCoherence.js) exhaustively: per-leg age,
 *      receive-time dispersion as an ADMISSION constraint, exchange-time dispersion
 *      only when every leg has a stamp, missing timestamps, generations, clock
 *      anomalies, duplicate/stall, depthless updates, the meaning of a 0 limit, and
 *      that PROTECTIVE REDUCTION is never blocked by these rules.
 *   2. The LIVE gateway path: the mandated 8,000 ms cross-leg dispersion example is
 *      REJECTED before any order is submitted, BOTH with exchange timestamps and
 *      without them (receive-time only), while a coherent book is still ADMITTED.
 *
 * No real socket, no real broker: the manager and quote store are in-memory.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBookCoherence,
  recheckBookCoherence,
  evaluateReductionCoherence,
  livePolicyFromConfig,
  paperPolicyFromConfig,
  coherencePrecisionWarning,
  BROKER_TIMESTAMP_NOTES,
} from "../../dist/box/executionCoherence.js";
import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { entrySideFor } from "../../dist/box/math.js";
import { cfg, goodCandidate, GOOD_BOX } from "./helpers.mjs";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];

/** A four-leg observation set at one instant; per-role overrides tweak individual legs. */
function legs(now, { received = {}, exchange = {}, version = {}, refVersion = {}, generation = {}, depth = {} } = {}) {
  return ROLES.map((role, i) => ({
    role,
    received_at: role in received ? received[role] : now,
    exchange_at: role in exchange ? exchange[role] : null,
    current_version: role in version ? version[role] : 100 + i,
    reference_version: role in refVersion ? refVersion[role] : 100 + i,
    generation: role in generation ? generation[role] : 1,
    has_depth: role in depth ? depth[role] : true,
  }));
}

/* --------------------------- the pure decision ---------------------------- */

test("broker timestamp semantics are documented with sources and a verification date", () => {
  // These are asserted so a future feed-parser change that alters the assumptions
  // trips this test and forces the docs (and thresholds) to be re-derived.
  assert.equal(BROKER_TIMESTAMP_NOTES.zerodha.exchange_ts_available, true);
  assert.equal(BROKER_TIMESTAMP_NOTES.zerodha.exchange_ts_precision_ms, 1000, "Kite full-mode stamp is 1-second granular");
  assert.match(BROKER_TIMESTAMP_NOTES.zerodha.source, /kite\.trade/);
  assert.equal(BROKER_TIMESTAMP_NOTES.dhan.exchange_ts_available, false, "Dhan has NO book publication timestamp");
  assert.equal(BROKER_TIMESTAMP_NOTES.dhan.exchange_ts_precision_ms, null);
  assert.match(BROKER_TIMESTAMP_NOTES.dhan.note, /LTT|Last Trade Time/i, "must state LTT is not a book time");
  assert.equal(BROKER_TIMESTAMP_NOTES.verified_on, "2026-09-09");
});

test("a coherent book is ADMITTED (the fix does not reject everything)", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ maxCrossLegExchangeDispersionMs: 1000, maxCrossLegReceiveDispersionMs: 500 }));
  // All four received within 120ms, all fresh, one generation.
  const d = evaluateBookCoherence(
    legs(now, { received: { k1_ce: now - 20, k2_ce: now - 60, k2_pe: now - 100, k1_pe: now - 120 } }),
    policy,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, true, d.detail ?? "");
  assert.equal(d.reason, null);
  assert.equal(d.basis, "receive", "no exchange stamps ⇒ admitted on receive-time evidence");
});

test("8,000 ms cross-leg RECEIVE dispersion is REJECTED (no exchange timestamps)", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ maxCrossLegReceiveDispersionMs: 500 }));
  const d = evaluateBookCoherence(
    // Each leg individually fresh (< 15s), but 8s apart in receive time.
    legs(now, { received: { k1_ce: now - 100, k2_ce: now - 2_000, k2_pe: now - 5_000, k1_pe: now - 8_100 } }),
    policy,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, false);
  assert.equal(d.reason, "receive_dispersion");
  assert.equal(d.basis, "receive");
  assert.equal(d.temporal.receive_dispersion_ms, 8_000);
});

test("8,000 ms cross-leg EXCHANGE dispersion is REJECTED (all exchange timestamps present)", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ maxCrossLegExchangeDispersionMs: 1000, maxCrossLegReceiveDispersionMs: 60_000, maxReceiveToExchangeDelayMs: 30_000 }));
  // Receive times tightly clustered (would pass receive gate), but the EXCHANGE
  // stamps are 8s apart — the books describe different market instants. The
  // receive-to-exchange delay bound is widened here so the ONLY binding rule is the
  // exchange-dispersion constraint (a large delay would otherwise reject first).
  const base = now - 200;
  const d = evaluateBookCoherence(
    legs(now, {
      received: { k1_ce: now - 40, k2_ce: now - 60, k2_pe: now - 80, k1_pe: now - 100 },
      exchange: { k1_ce: base, k2_ce: base - 2_000, k2_pe: base - 5_000, k1_pe: base - 8_000 },
    }),
    policy,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, false);
  assert.equal(d.reason, "exchange_dispersion");
  assert.equal(d.basis, "exchange");
  assert.equal(d.temporal.exchange_dispersion_ms, 8_000);
});

test("PER-LEG age limit is enforced even when the four legs are tightly clustered", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ quoteMaxAgeMs: 15_000, maxCrossLegReceiveDispersionMs: 500 }));
  // Dispersion is only 200ms, but ALL FOUR are 20s old.
  const d = evaluateBookCoherence(
    legs(now, { received: { k1_ce: now - 20_000, k2_ce: now - 20_050, k2_pe: now - 20_100, k1_pe: now - 20_200 } }),
    policy,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, false);
  assert.equal(d.reason, "per_leg_stale");
});

test("a MISSING exchange timestamp never itself rejects; it falls back to receive-time", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ maxCrossLegExchangeDispersionMs: 1000, maxCrossLegReceiveDispersionMs: 500 }));
  // Three legs have an exchange stamp, one does not ⇒ exchange dispersion is null.
  const base = now - 300;
  const d = evaluateBookCoherence(
    legs(now, {
      received: { k1_ce: now - 40, k2_ce: now - 60, k2_pe: now - 80, k1_pe: now - 100 },
      exchange: { k1_ce: base, k2_ce: base, k2_pe: base, k1_pe: null },
    }),
    policy,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, true, d.detail ?? "");
  assert.equal(d.temporal.exchange_dispersion_ms, null, "not computed unless ALL legs have one");
  assert.equal(d.temporal.legs_with_exchange_ts, 3);
  assert.equal(d.basis, "receive");
});

test("a missing BOOK (no received_at) fails closed as missing_book", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg());
  const d = evaluateBookCoherence(legs(now, { received: { k2_pe: null } }), policy, now, { currentGeneration: 1 });
  assert.equal(d.admit, false);
  assert.equal(d.reason, "missing_book");
});

test("a DEPTHLESS update fails closed as depthless_book", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg());
  const d = evaluateBookCoherence(legs(now, { depth: { k1_pe: false } }), policy, now, { currentGeneration: 1 });
  assert.equal(d.admit, false);
  assert.equal(d.reason, "depthless_book");
});

test("a RECONNECT generation is invalidated: a leg from a superseded generation is refused", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg());
  // currentGeneration is 2; k2_ce still carries generation 1 (pre-reconnect).
  const d = evaluateBookCoherence(legs(now, { generation: { k2_ce: 1 } }), policy, now, { currentGeneration: 2 });
  assert.equal(d.admit, false);
  assert.equal(d.reason, "stale_generation");
});

test("legs that SPAN two generations are refused even without a caller-supplied current generation", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg());
  const d = evaluateBookCoherence(legs(now, { generation: { k1_ce: 1, k2_ce: 1, k2_pe: 2, k1_pe: 2 } }), policy, now);
  assert.equal(d.admit, false);
  assert.equal(d.reason, "generation_split");
});

test("a CLOCK anomaly (book stamped in the future) is refused", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg());
  const d = evaluateBookCoherence(legs(now, { received: { k2_pe: now + 500 } }), policy, now, { currentGeneration: 1 });
  assert.equal(d.admit, false);
  assert.equal(d.reason, "clock_anomaly");
});

test("an exchange timestamp implausibly AHEAD of receive time is refused (future skew)", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg());
  // Exchange stamp 5s ahead of receive — beyond the coarse-stamp tolerance.
  const d = evaluateBookCoherence(
    legs(now, { received: { k1_ce: now - 10 }, exchange: { k1_ce: now + 5_000 } }),
    policy,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, false);
  assert.equal(d.reason, "clock_anomaly");
});

test("a small exchange-ahead skew (coarse 1s stamps) is TOLERATED", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ maxCrossLegExchangeDispersionMs: 1000, maxCrossLegReceiveDispersionMs: 500 }));
  const base = now - 20; // exchange stamps ~ receive, rounded up to 300ms ahead
  const d = evaluateBookCoherence(
    legs(now, {
      received: { k1_ce: now - 20, k2_ce: now - 40, k2_pe: now - 60, k1_pe: now - 80 },
      exchange: { k1_ce: base + 300, k2_ce: base + 300, k2_pe: base + 300, k1_pe: base + 300 },
    }),
    policy,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, true, d.detail ?? "");
});

test("DUPLICATE/STALL: a re-check where no book advanced and all are at/over age is refused", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ quoteMaxAgeMs: 1_000, maxCrossLegReceiveDispersionMs: 60_000 }));
  // current_version === reference_version for every leg ⇒ nothing moved; all >= 1s old.
  const stalled = ROLES.map((role, i) => ({
    role,
    received_at: now - 1_500,
    exchange_at: null,
    current_version: 200 + i,
    reference_version: 200 + i,
    generation: 1,
    has_depth: true,
  }));
  const d = recheckBookCoherence(stalled, policy, now, { currentGeneration: 1 });
  // Note: per-leg age (1500 > 1000) would already fail; force a longer age window to
  // isolate the stall guard.
  const policyFreshAge = livePolicyFromConfig(cfg({ quoteMaxAgeMs: 1_000, maxCrossLegReceiveDispersionMs: 60_000 }));
  const d2 = recheckBookCoherence(
    stalled.map((l) => ({ ...l, received_at: now - 1_000 })),
    policyFreshAge,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, false);
  assert.equal(d2.admit, false);
  assert.equal(d2.reason, "duplicate_stall");
});

test("a re-check where a book DID advance is admitted (not treated as a stall)", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ quoteMaxAgeMs: 1_000, maxCrossLegReceiveDispersionMs: 60_000 }));
  const moved = ROLES.map((role, i) => ({
    role,
    received_at: now - 500,
    exchange_at: null,
    current_version: 300 + i, // advanced past reference
    reference_version: 200 + i,
    generation: 1,
    has_depth: true,
  }));
  const d = recheckBookCoherence(moved, policy, now, { currentGeneration: 1 });
  assert.equal(d.admit, true, d.detail ?? "");
});

/* ---------------------- meaning of a 0 dispersion limit -------------------- */

test("LIVE: a 0 receive-dispersion limit is IMPOSSIBLE-TO-SATISFY, not a silent bypass", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ maxCrossLegReceiveDispersionMs: 0 }));
  assert.equal(policy.zeroReceiveDispersionDisables, false, "live default: 0 does not disable");
  const d = evaluateBookCoherence(
    legs(now, { received: { k1_ce: now, k2_ce: now, k2_pe: now, k1_pe: now } }),
    policy,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, false, "even a 0ms-dispersed book cannot satisfy a 0ms limit in live");
  assert.equal(d.reason, "receive_dispersion");
});

test("LIVE with explicit opt-out: a 0 receive-dispersion limit DISABLES the receive gate", () => {
  const now = 1_000_000;
  const policy = livePolicyFromConfig(cfg({ maxCrossLegReceiveDispersionMs: 0, coherenceZeroDispersionDisablesInLive: true }));
  assert.equal(policy.zeroReceiveDispersionDisables, true);
  const d = evaluateBookCoherence(
    legs(now, { received: { k1_ce: now - 100, k2_ce: now - 3_000, k2_pe: now - 6_000, k1_pe: now - 8_100 } }),
    policy,
    now,
    { currentGeneration: 1 },
  );
  assert.equal(d.admit, true, "operator explicitly opted out of the receive-dispersion gate");
});

test("PAPER: a 0 dispersion limit disables the cross-leg gate (historical behaviour preserved)", () => {
  const now = 1_000_000;
  const policy = paperPolicyFromConfig(cfg({ maxCrossLegExchangeDispersionMs: 0, maxCrossLegReceiveDispersionMs: 0 }));
  assert.equal(policy.zeroReceiveDispersionDisables, true);
  const d = evaluateBookCoherence(
    legs(now, { received: { k1_ce: now - 100, k2_ce: now - 3_000, k2_pe: now - 6_000, k1_pe: now - 8_100 } }),
    policy,
    now,
  );
  assert.equal(d.admit, true, "paper reads 0 as disabled");
});

/* --------------------- protective reduction is NOT blocked ----------------- */

test("PROTECTIVE REDUCTION is NOT blocked when four-leg coherence has deteriorated", () => {
  // The exact scenario that must reduce risk: books are wildly incoherent (8s skew),
  // yet reducing the ONE owned leg is allowed as long as that leg has a depthful book.
  const reduce = evaluateReductionCoherence({ role: "k2_ce", received_at: 1, has_depth: true });
  assert.equal(reduce.admit, true, "an entry-freshness/dispersion rule must never block risk reduction");

  // It only refuses when the single leg genuinely cannot be priced.
  assert.equal(evaluateReductionCoherence({ role: "k2_ce", received_at: null, has_depth: true }).admit, false);
  assert.equal(evaluateReductionCoherence({ role: "k2_ce", received_at: 1, has_depth: false }).admit, false);
});

/* ============================ LIVE GATEWAY PROOF =========================== */

function brokerOrder(req) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.role}`,
    tag: null,
    role: req.role,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state: "COMPLETE",
    filled_quantity: req.quantity,
    pending_quantity: 0,
    average_price: req.pricing.reference_price,
    fills: [{ fill_id: `f-${req.role}`, quantity: req.quantity, price: req.pricing.reference_price, at: 10_100 }],
    reject_family: null,
    reject_reason: null,
    created_at: 10_000,
    updated_at: 10_100,
  };
}

/**
 * A LIVE entry harness. Books are seeded into a REAL BoxQuoteStore with per-leg
 * receive times (and optional exchange timestamps) so cross-leg dispersion is
 * modelled exactly. Nothing contacts a broker: `manager.submit` returns a filled
 * order in memory.
 */
function liveEntryHarness({ receivedByRole, exchangeByRole = {}, config = {} } = {}) {
  const { candidate } = goodCandidate();
  const now = 10_000;
  const quotes = new BoxQuoteStore();
  // BUY legs need asks, SELL legs need bids — seed both sides with deep size so the
  // depth precheck always passes and ONLY coherence can reject.
  for (const role of ROLES) {
    const p = GOOD_BOX.prices[role];
    const token = candidate.legs[role].token;
    const tick = {
      token,
      last_price: p.ask ?? p.bid ?? 1,
      bid: p.bid ?? 1,
      ask: p.ask ?? 2,
      bids: [{ price: p.bid ?? 1, qty: 5_000, orders: 1 }],
      asks: [{ price: p.ask ?? 2, qty: 5_000, orders: 1 }],
    };
    if (role in exchangeByRole && exchangeByRole[role] !== null) tick.exchange_ts = exchangeByRole[role];
    quotes.applyTicks([tick], receivedByRole[role]);
  }
  const submitted = [];
  const violations = [];
  const manager = {
    status: () => ({ inFlight: 0, queued: 0 }),
    submit: async (req) => {
      submitted.push(structuredClone(req));
      return brokerOrder(req);
    },
    invariantViolation: (r) => violations.push(r),
  };
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({
      executionMode: "live",
      liveTradingEnabled: true,
      queueModel: "none",
      liveMaxChaseTicks: 2,
      legMaxChaseTicks: 2,
      quoteMaxAgeMs: 15_000,
      ...config,
    }),
    simulator: { hasCapacity: () => false, estimateExecutableExit: () => [] },
    quotes,
    manager,
    allocateTradeId: () => "trade-1",
    isTokenWarm: () => true,
    feedGeneration: () => 1,
    now: () => now,
  });
  const detection = {
    at: now,
    candidate,
    legs: ROLES.map((role) => {
      const inst = candidate.legs[role];
      const side = entrySideFor(role, candidate.direction);
      const q = quotes.get(inst.token);
      return {
        role, side, token: inst.token, tradingsymbol: inst.tradingsymbol,
        strike: inst.strike, instrument_type: inst.instrument_type,
        price: side === "BUY" ? q.ask : q.bid,
        qty_at_touch: 5_000, bid: q.bid, bid_qty: q.bid_qty, ask: q.ask, ask_qty: q.ask_qty,
        quote_at: q.at, quote_version: q.version, depth: null, age_ms: now - q.at, fresh: true, executable: true,
      };
    }),
  };
  return { candidate, quotes, submitted, violations, gateway, detection, now };
}

const runEntry = (h) => h.gateway.simulateLeggingEntry({
  candidate: h.candidate,
  detection: h.detection,
  qualify: () => ({ qualifies: true, expected_net_profit: 5000, min_expected_net_profit: 1200 }),
  stillWanted: () => true,
});

test("LIVE gateway REJECTS 8,000 ms cross-leg dispersion — WITHOUT exchange timestamps", async () => {
  const now = 10_000;
  const h = liveEntryHarness({
    // Each leg individually < 15s fresh, but 8,000 ms apart in receive time.
    receivedByRole: { k1_ce: now - 100, k2_ce: now - 2_000, k2_pe: now - 5_000, k1_pe: now - 8_100 },
    config: { maxCrossLegReceiveDispersionMs: 500 },
  });
  const res = await runEntry(h);
  assert.equal(res.ok, false, "an 8s-dispersed book must not open a live box");
  assert.equal(res.reason, "cross_leg_time_skew");
  assert.equal(h.submitted.length, 0, "NOTHING was sent to the broker");
  assert.equal(res.legging.temporal.receive_dispersion_ms, 8_000);
  assert.match(res.detail, /receive_dispersion/);
});

test("LIVE gateway REJECTS 8,000 ms cross-leg dispersion — WITH exchange timestamps", async () => {
  const now = 10_000;
  const base = now - 200;
  const h = liveEntryHarness({
    // Receive times tightly clustered, but exchange stamps 8s apart.
    receivedByRole: { k1_ce: now - 40, k2_ce: now - 60, k2_pe: now - 80, k1_pe: now - 100 },
    exchangeByRole: { k1_ce: base, k2_ce: base - 2_000, k2_pe: base - 5_000, k1_pe: base - 8_000 },
    config: { maxCrossLegExchangeDispersionMs: 1000, maxCrossLegReceiveDispersionMs: 60_000, maxReceiveToExchangeDelayMs: 30_000 },
  });
  const res = await runEntry(h);
  assert.equal(res.ok, false, "8s of EXCHANGE dispersion must not open a live box");
  assert.equal(res.reason, "cross_leg_time_skew");
  assert.equal(h.submitted.length, 0, "NOTHING was sent to the broker");
  assert.equal(res.legging.temporal.exchange_dispersion_ms, 8_000);
  assert.match(res.detail, /exchange_dispersion/);
});

test("LIVE gateway ADMITS a coherent book (four legs received within ~120ms)", async () => {
  const now = 10_000;
  const h = liveEntryHarness({
    receivedByRole: { k1_ce: now - 20, k2_ce: now - 60, k2_pe: now - 100, k1_pe: now - 120 },
    config: { maxCrossLegReceiveDispersionMs: 500 },
  });
  const res = await runEntry(h);
  assert.equal(res.ok, true, res.ok ? "" : res.detail);
  assert.equal(h.submitted.length, 4, "all four legs were transmitted");
  assert.deepEqual(h.violations, []);
});


/* ══════════════ THE STAMP-PRECISION GUARD — the 100%-refusal regression ══════════════ */

/**
 * A deployment refused 100% of entries with `cross_leg_time_skew` on a healthy 200-underlying feed.
 * Nothing was wrong with the market: `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS` was 250 while Kite
 * stamps order books in epoch SECONDS, so cross-leg dispersion could only ever be 0 or a multiple of
 * 1000 ms — and every set of four legs that straddled a second boundary measured exactly 1000 ms and
 * was refused.
 *
 * The module had documented this since it was written (`BROKER_TIMESTAMP_NOTES`: "Any
 * exchange-dispersion threshold below ~1000 ms is therefore unsatisfiable-by-noise for Kite data")
 * and NOTHING READ IT. Two shipped templates set 250 anyway, one asserting in a comment that
 * receive-time would govern instead — which the decision function contradicts.
 *
 * These tests hold both halves: the quantisation behaviour itself, and the guard that now names it.
 */

test("PRECISION: 1000ms of Kite quantisation is refused at 250 and admitted at 1000", () => {
  const now = 1_000_000;
  // Four books the exchange published milliseconds apart, but straddling a second boundary — so Kite
  // reports two of them a whole second earlier. Receive times are identical and perfectly coherent,
  // and every receive-to-exchange delay stays well inside the 5s clock-sanity bound.
  const straddle = legs(now, {
    exchange: { k1_ce: now - 1000, k2_ce: now - 1000, k2_pe: now, k1_pe: now },
  });

  const tooTight = evaluateBookCoherence(
    straddle,
    livePolicyFromConfig(cfg({ maxCrossLegExchangeDispersionMs: 250, maxCrossLegReceiveDispersionMs: 500 })),
    now,
  );
  assert.equal(tooTight.admit, false, "250 against 1s stamps refuses a coherent snapshot");
  assert.equal(tooTight.reason, "exchange_dispersion");
  assert.match(tooTight.detail, /1000ms exceeds 250ms/);

  const atPrecision = evaluateBookCoherence(
    straddle,
    livePolicyFromConfig(cfg({ maxCrossLegExchangeDispersionMs: 1000, maxCrossLegReceiveDispersionMs: 500 })),
    now,
  );
  assert.equal(atPrecision.admit, true, "at the stamp precision the same books are admitted");
});

test("PRECISION: 1000ms does NOT blunt the check — genuinely separated stamps still refuse", () => {
  const now = 1_000_000;
  // Legs whose books have not been republished for seconds. A real signal, not quantisation. Kept
  // inside BOX_MAX_RECEIVE_TO_EXCHANGE_DELAY_MS (5000) so this refuses on DISPERSION rather than on
  // the clock-sanity check, which is what makes the assertion meaningful.
  const lagging = legs(now, {
    exchange: { k1_ce: now, k2_ce: now - 3000, k2_pe: now, k1_pe: now - 4000 },
  });
  const decision = evaluateBookCoherence(
    lagging,
    livePolicyFromConfig(cfg({ maxCrossLegExchangeDispersionMs: 1000, maxCrossLegReceiveDispersionMs: 60_000 })),
    now,
  );
  assert.equal(decision.admit, false, "4000ms of real separation must still be refused at a 1000ms bound");
  assert.equal(decision.reason, "exchange_dispersion");
  assert.match(decision.detail, /4000ms exceeds 1000ms/);
});

test("GUARD: a sub-precision bound is named for the broker that has a stamp", () => {
  const warning = coherencePrecisionWarning({ broker: "zerodha", maxExchangeDispersionMs: 250 });
  assert.ok(warning, "250 is below Kite's 1000ms precision and must be reported");
  // The operator needs the number, the cause and the remedy — not merely "check your config".
  assert.match(warning, /250/);
  assert.match(warning, /1000ms/);
  assert.match(warning, /UNSATISFIABLE-BY-QUANTISATION/);
  assert.match(warning, /BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS/);
});

test("GUARD: stays silent when there is nothing to say", () => {
  // At or above the precision there is no quantisation problem.
  assert.equal(coherencePrecisionWarning({ broker: "zerodha", maxExchangeDispersionMs: 1000 }), null);
  assert.equal(coherencePrecisionWarning({ broker: "zerodha", maxExchangeDispersionMs: 2000 }), null);
  // 0 is an explicit, documented "disabled" — an operator who chose it is not confused.
  assert.equal(coherencePrecisionWarning({ broker: "zerodha", maxExchangeDispersionMs: 0 }), null);
  // Dhan publishes NO book timestamp, so the bound is never applied and warning about it would send
  // an operator to change a setting that cannot affect anything.
  assert.equal(BROKER_TIMESTAMP_NOTES.dhan.exchange_ts_available, false);
  assert.equal(coherencePrecisionWarning({ broker: "dhan", maxExchangeDispersionMs: 250 }), null);
  // An unknown broker has no documented precision to compare against.
  assert.equal(coherencePrecisionWarning({ broker: "someone_else", maxExchangeDispersionMs: 1 }), null);
});

test("GUARD: the documented precision matches what the Kite parser can actually produce", () => {
  // src/ticker.ts does `exchangeTs = exSec * 1000`, so every stamp is a whole second. If that ever
  // changes, this constant must change with it or the guard will police the wrong threshold.
  assert.equal(BROKER_TIMESTAMP_NOTES.zerodha.exchange_ts_precision_ms, 1000);
  assert.equal(BROKER_TIMESTAMP_NOTES.zerodha.exchange_ts_available, true);
});
