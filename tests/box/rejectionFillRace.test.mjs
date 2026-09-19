/**
 * THE REJECTION/FILL RACE: "the broker rejected it" is not, by itself, proof of zero exposure.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A placement POST can receive a DEFINITIVE rejection after an order update has already reported a
 * positive cumulative fill for the same client order id. Both live adapters merge the rejection onto
 * their current snapshot, and `mergeBrokerOrderSnapshot` correctly refuses to choose a side: it
 * yields RECONCILIATION_REQUIRED and PRESERVES the fill.
 *
 * The adapters nevertheless threw that merged snapshot inside a `BrokerOrderRejectedError` — the one
 * error type `executionGateway` accepts as proof that the leg does not exist. `ordersFromSettled`
 * then dropped the snapshot, so the `RECONCILIATION_REQUIRED` backstop could not fire either;
 * `entryLegOutcomes` reported the leg as never submitted with `brokerStateKnown: true`; and
 * `planPartialEntryRecovery` returned `unwind_confirmed_exposure` — SELLING the confirmed BUY hedges
 * that may still have been protecting the disputed leg's real short fill. A recovery became a fresh
 * naked position.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT UNDER TEST
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * "Broker rejected the request" proves zero exposure ONLY when the authoritative merged snapshot
 * establishes a terminal REJECTED state with a verified `filled_quantity === 0`. A nonterminal or
 * contradictory state, a positive cumulative fill, missing quantity evidence, a conflicting broker
 * order id, or a failed durable write does NOT prove zero exposure.
 *
 * WHAT THESE TESTS DRIVE. Cases 1-4 and 8 run the REAL `KiteBrokerAdapter` / `DhanBrokerAdapter`
 * against a deterministic fake transport, with the mid-POST observation injected at an exact point
 * in the POST's lifetime. Cases 5-7, 9 and 10 run the REAL gateway → manager → adapter stack, and
 * the error that crosses those boundaries is the one a REAL adapter actually produced — not a
 * hand-built stand-in. The assertions are on the RECOVERY ACTIONS and the DURABLE ROWS, not on
 * error messages.
 *
 * No network, no broker, no database: fake transports, fake clocks, in-memory persistence.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BrokerAmbiguousSubmitError,
  BrokerOrderRejectedError,
  BrokerPreSubmitRefusedError,
  BrokerRejectionContradictedError,
  verifyZeroBrokerExposure,
} from "../../dist/box/brokerAdapter.js";
import { KiteBrokerAdapter, KiteHttpError, stableKiteTag } from "../../dist/box/kiteBrokerAdapter.js";
import { DhanBrokerAdapter } from "../../dist/box/dhanBrokerAdapter.js";
import { DhanError } from "../../dist/brokers/dhan/errors.js";
import { brokerOrderFor, entryPosts, liveStack, runEntry } from "./liveEntryHarness.mjs";

/* ═══════════════════════════════ shared fixtures ═══════════════════════════════ */

const LOTS = 75;

const kiteRequest = (overrides = {}) => ({
  client_order_id: "BOX:trade-rr:ENTRY:k1_ce:attempt-1",
  role: "k1_ce",
  trade_id: "trade-rr",
  attempt_id: "attempt-1",
  purpose: "ENTRY",
  phase: "entry",
  exchange: "NFO",
  tradingsymbol: "NIFTY26SEP19900CE",
  token: 1001,
  side: "BUY",
  quantity: LOTS,
  pricing: {
    order_type: "LIMIT",
    reference_price: 100,
    tick_size: 0.05,
    max_chase_ticks: 2,
    limit_price: 100.1,
  },
  ...overrides,
});

const dhanRequest = (overrides = {}) => kiteRequest({
  client_order_id: "BOX:trade-rr:ENTRY:k1_ce:attempt-1",
  tradingsymbol: "ASTRAL25SEP2500CE",
  ...overrides,
});

const kiteConfig = (overrides = {}) => ({
  executionMode: "live",
  enabled: true,
  ackTimeoutMs: 40,
  workingTimeoutMs: 60,
  partialTimeoutMs: 40,
  cancelTimeoutMs: 40,
  brokerMinIntervalMs: 0,
  maxModifications: 2,
  maxChaseTicks: 2,
  ...overrides,
});

const dhanConfig = (overrides = {}) => ({
  ...kiteConfig(),
  staticIpReady: () => true,
  brokerMinIntervalMs: 1,
  dhanClientId: () => "C1",
  identify: () => ({ segment: "NSE_FNO", securityId: 45678 }),
  ...overrides,
});

function fakeClock(start = 1_000) {
  let now = start;
  return { now: () => now, wait: async (ms) => { now += Math.max(0, ms); } };
}

/** The mid-POST observation: a broker order update reporting a real cumulative fill. */
const fillObservation = (clientOrderId, cumulativeQty, rawStatus = "OPEN") => ({
  clientOrderId,
  brokerOrderId: "K-RACE-1",
  cumulativeQty,
  averagePrice: 100.02,
  rawStatus,
  observedAtWall: 1_050,
});

const rejection = async (promise) => {
  try {
    await promise;
    throw new Error("expected a rejection, but the call resolved");
  } catch (error) {
    return error;
  }
};

/**
 * A Kite transport whose POST optionally lands an order update BEFORE it fails.
 *
 * `injectBeforeThrow` runs at the exact instant the POST is on the wire, which is the window the
 * defect lives in. `beforeSend` is invoked first, faithfully to KiteHttpTransport.request.
 */
function kiteRaceTransport({ injectBeforeThrow, failWith } = {}) {
  const calls = [];
  const book = [];
  return {
    calls,
    book,
    async placeOrder(_params, opts) {
      opts?.beforeSend?.();
      calls.push("place");
      injectBeforeThrow?.();
      if (failWith) throw failWith();
      return { order_id: "K-RACE-1" };
    },
    async listOrders() { calls.push("listOrders"); return book; },
    async getOrder(id) { calls.push("getOrder"); return book.find((o) => o.order_id === id) ?? null; },
    async cancelOrder() { calls.push("cancel"); },
    async modifyOrder() { calls.push("modify"); },
    async listPositions() { return []; },
  };
}

function dhanRaceClient({ injectBeforeThrow, failWith } = {}) {
  const calls = { place: 0, byCorrelation: 0, get: 0 };
  return {
    calls,
    async placeOrder(_req, opts) {
      opts?.beforeSend?.();
      calls.place++;
      injectBeforeThrow?.();
      if (failWith) throw failWith();
      return { orderId: "DHAN-RACE-1", orderStatus: "PENDING" };
    },
    async getOrderByCorrelationId() { calls.byCorrelation++; return null; },
    async getOrder() { calls.get++; return null; },
    async cancelOrder() { return { orderId: "1", orderStatus: "CANCELLED" }; },
    async modifyOrder() { return { orderId: "1", orderStatus: "PENDING" }; },
    async getTradesForOrder() { return []; },
    async listOrders() { return []; },
    async listPositions() { return []; },
    async getFundLimit() { return { availabelBalance: 100000, utilizedAmount: 5000 }; },
    async getProfile() { return { dhanClientId: "C1" }; },
  };
}

/* ═════════ REQUIRED 1 — Kite: a fill observed BEFORE the definitive rejection ═════════ */

test("REQUIRED 1: Kite — a fill observed before a definitive rejection is NOT a no-exposure certificate", async () => {
  const holder = {};
  const transport = kiteRaceTransport({
    // The postback lands while the POST is still in flight.
    injectBeforeThrow: () => holder.adapter.applyOrderUpdate(
      fillObservation(kiteRequest().client_order_id, 25),
    ),
    failWith: () => new KiteHttpError(400, "insufficient funds", {}),
  });
  holder.adapter = new KiteBrokerAdapter(transport, kiteConfig(), fakeClock());

  const error = await rejection(holder.adapter.submitOrder(kiteRequest()));

  // THE CORE ASSERTION: this must NOT be the type that downstream reads as proof of absence.
  assert.equal(
    error instanceof BrokerOrderRejectedError, false,
    "a rejection contradicted by a confirmed fill must never be a BrokerOrderRejectedError",
  );
  assert.ok(error instanceof BrokerRejectionContradictedError);
  // It travels the EXISTING uncertainty channel, so every layer already keyed to that type is safe.
  assert.ok(error instanceof BrokerAmbiguousSubmitError, "must reuse the plumbed uncertainty channel");

  // The evidence is preserved, not discarded.
  assert.equal(error.order.state, "RECONCILIATION_REQUIRED");
  assert.equal(error.order.filled_quantity, 25, "the observed fill survives the rejection");
  assert.equal(error.observedFilledQuantity, 25);
  assert.equal(error.disproof, "positive_cumulative_fill");
  assert.equal(error.brokerOrderId, "K-RACE-1", "broker identity is preserved for reconciliation");
  assert.equal(error.brokerRejectFamily, "margin", "the broker's own classification survives");
  assert.match(error.rejectedOrder.reject_reason, /insufficient funds/, "the broker's text survives");
  assert.match(error.rejectedOrder.reject_reason, /cumulative fill of 25/, "the conflict reason survives");

  // And it is not proven zero exposure by the single authority.
  assert.equal(verifyZeroBrokerExposure(error.order).proven, false);
  // Never re-POSTed.
  assert.equal(transport.calls.filter((c) => c === "place").length, 1, "an uncertain POST is never retried");
});

test("Kite — a FULL mid-POST fill contradicting the rejection is equally uncertain", async () => {
  const holder = {};
  const transport = kiteRaceTransport({
    injectBeforeThrow: () => holder.adapter.applyOrderUpdate(
      fillObservation(kiteRequest().client_order_id, LOTS, "COMPLETE"),
    ),
    failWith: () => new KiteHttpError(400, "RMS rejection", {}),
  });
  holder.adapter = new KiteBrokerAdapter(transport, kiteConfig(), fakeClock());

  const error = await rejection(holder.adapter.submitOrder(kiteRequest()));
  assert.ok(error instanceof BrokerRejectionContradictedError);
  assert.equal(error.order.state, "RECONCILIATION_REQUIRED");
  assert.equal(error.order.filled_quantity, LOTS);
  assert.equal(verifyZeroBrokerExposure(error.order).proven, false);
});

/* ═════════ REQUIRED 2 — Kite: the definitive rejection arrives BEFORE a late fill ═════════ */

test("REQUIRED 2: Kite — a definitive rejection followed by a LATE positive fill does not erase the fill", async () => {
  const transport = kiteRaceTransport({ failWith: () => new KiteHttpError(400, "insufficient funds", {}) });
  const adapter = new KiteBrokerAdapter(transport, kiteConfig(), fakeClock());
  const req = kiteRequest();

  // At the moment of the throw nothing had filled, so this IS a proven rejection.
  const error = await rejection(adapter.submitOrder(req));
  assert.ok(error instanceof BrokerOrderRejectedError, "with a verified zero this is a real rejection");
  assert.equal(error.order.filled_quantity, 0);
  assert.equal(verifyZeroBrokerExposure(error.order).proven, true);

  // ...and then the exchange reports a fill that was in flight all along.
  const late = adapter.applyOrderUpdate(fillObservation(req.client_order_id, 25));

  // The cached REJECTED must not suppress it, and the fill must not be discarded.
  assert.equal(late.state, "RECONCILIATION_REQUIRED", "a late fill against REJECTED is a contradiction");
  assert.equal(late.filled_quantity, 25, "an observed fill is never silently dropped");
  assert.equal(verifyZeroBrokerExposure(late).proven, false, "the earlier proof is void once a fill appears");
});

/* ═════════ REQUIRED 3 — Dhan: both orderings ═════════ */

test("REQUIRED 3a: Dhan — a fill observed before a definitive 4xx is NOT a no-exposure certificate", async () => {
  const holder = {};
  const client = dhanRaceClient({
    injectBeforeThrow: () => holder.adapter.applyOrderUpdate(
      fillObservation(dhanRequest().client_order_id, 25),
    ),
    failWith: () => new DhanError("Insufficient margin available", 400, "MARGIN_ERROR"),
  });
  holder.adapter = new DhanBrokerAdapter(client, dhanConfig());

  const error = await rejection(holder.adapter.submitOrder(dhanRequest()));

  assert.equal(error instanceof BrokerOrderRejectedError, false, "Dhan must not certify absence either");
  assert.ok(error instanceof BrokerRejectionContradictedError);
  assert.ok(error instanceof BrokerAmbiguousSubmitError);
  assert.equal(error.order.state, "RECONCILIATION_REQUIRED");
  assert.equal(error.order.filled_quantity, 25);
  assert.equal(error.disproof, "positive_cumulative_fill");
  assert.match(error.rejectedOrder.reject_reason, /Insufficient margin/);
  assert.equal(verifyZeroBrokerExposure(error.order).proven, false);
  assert.equal(client.calls.place, 1, "exactly one POST; never a retry");
});

test("REQUIRED 3b: Dhan — a definitive 4xx followed by a LATE positive fill does not erase the fill", async () => {
  const client = dhanRaceClient({
    failWith: () => new DhanError("Insufficient margin available", 400, "MARGIN_ERROR"),
  });
  const adapter = new DhanBrokerAdapter(client, dhanConfig());
  const req = dhanRequest();

  const error = await rejection(adapter.submitOrder(req));
  assert.ok(error instanceof BrokerOrderRejectedError);
  assert.equal(error.order.filled_quantity, 0);
  assert.equal(verifyZeroBrokerExposure(error.order).proven, true);

  const late = adapter.applyOrderUpdate(fillObservation(req.client_order_id, 25));
  assert.equal(late.state, "RECONCILIATION_REQUIRED");
  assert.equal(late.filled_quantity, 25);
  assert.equal(verifyZeroBrokerExposure(late).proven, false);
});

/* ═════════ REQUIRED 4 — a genuine zero-fill rejection stays a proven rejection ═════════ */

test("REQUIRED 4: a definitive rejection with a VERIFIED zero fill remains a proven no-exposure result", async () => {
  // Kite.
  const kite = new KiteBrokerAdapter(
    kiteRaceTransport({ failWith: () => new KiteHttpError(400, "insufficient funds", {}) }),
    kiteConfig(),
    fakeClock(),
  );
  const kiteError = await rejection(kite.submitOrder(kiteRequest()));
  assert.ok(kiteError instanceof BrokerOrderRejectedError, "behaviour for real rejections is unchanged");
  assert.equal(kiteError instanceof BrokerRejectionContradictedError, false);
  assert.equal(kiteError.order.state, "REJECTED");
  assert.equal(kiteError.order.filled_quantity, 0);
  assert.deepEqual(kiteError.order.fills, []);
  assert.equal(verifyZeroBrokerExposure(kiteError.order).proven, true);
  assert.equal(verifyZeroBrokerExposure(kiteError.order).disproof, null);

  // Dhan.
  const dhan = new DhanBrokerAdapter(
    dhanRaceClient({ failWith: () => new DhanError("Insufficient margin available", 400, "MARGIN_ERROR") }),
    dhanConfig(),
  );
  const dhanError = await rejection(dhan.submitOrder(dhanRequest()));
  assert.ok(dhanError instanceof BrokerOrderRejectedError);
  assert.equal(dhanError instanceof BrokerRejectionContradictedError, false);
  assert.equal(dhanError.order.state, "REJECTED");
  assert.equal(dhanError.order.filled_quantity, 0);
  assert.equal(verifyZeroBrokerExposure(dhanError.order).proven, true);
});

test("the zero-exposure proof names each way a rejection can fail to prove absence", () => {
  const base = {
    client_order_id: "c1",
    broker_order_id: null,
    tag: null,
    role: "k1_ce",
    trade_id: "t",
    attempt_id: "a",
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: "X",
    token: 1,
    side: "BUY",
    quantity: LOTS,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
    limit_price: 100.1,
    state: "REJECTED",
    filled_quantity: 0,
    pending_quantity: LOTS,
    average_price: null,
    fills: [],
    reject_family: "margin",
    reject_reason: "no",
    created_at: 1,
    updated_at: 2,
  };

  assert.equal(verifyZeroBrokerExposure(base).proven, true, "the control case must be proven");

  // A positive cumulative fill.
  assert.equal(verifyZeroBrokerExposure({ ...base, filled_quantity: 1 }).disproof, "positive_cumulative_fill");
  // A contradictory / nonterminal state, including the broker-id conflict the merge routes there.
  assert.equal(
    verifyZeroBrokerExposure({ ...base, state: "RECONCILIATION_REQUIRED" }).disproof,
    "state_not_terminal_rejected",
  );
  assert.equal(verifyZeroBrokerExposure({ ...base, state: "UNKNOWN" }).disproof, "state_not_terminal_rejected");
  assert.equal(verifyZeroBrokerExposure({ ...base, state: "OPEN" }).disproof, "state_not_terminal_rejected");
  // Fill records outrank an aggregate that reads zero.
  assert.equal(
    verifyZeroBrokerExposure({ ...base, fills: [{ fill_id: "f", quantity: 5, price: 1, at: 1 }] }).disproof,
    "fill_records_present",
  );
  // Missing quantity evidence: absence is not zero.
  assert.equal(
    verifyZeroBrokerExposure({
      ...base,
      execution_evidence: { quantity: "missing", price: "missing", accounting: "unproven" },
    }).disproof,
    "quantity_evidence_missing",
  );
  // A nonsensical quantity is missing evidence, never a zero.
  assert.equal(verifyZeroBrokerExposure({ ...base, filled_quantity: Number.NaN }).disproof, "quantity_evidence_missing");
  assert.equal(verifyZeroBrokerExposure({ ...base, filled_quantity: -5 }).disproof, "quantity_evidence_missing");
  // A CONFIRMED zero with its evidence marker is still proven.
  assert.equal(
    verifyZeroBrokerExposure({
      ...base,
      execution_evidence: { quantity: "confirmed", price: "not_applicable", accounting: "complete" },
    }).proven,
    true,
  );
});

/* ═════════ REQUIRED 8 — neither source order may lower accepted cumulative fill ═════════ */

test("REQUIRED 8: Kite — REST and stream observations in EITHER order never lower accepted cumulative fill", async () => {
  const req = kiteRequest();
  const restRow = {
    order_id: "K-RACE-1",
    status: "CANCELLED",
    exchange: "NFO",
    tradingsymbol: req.tradingsymbol,
    transaction_type: "BUY",
    quantity: LOTS,
    filled_quantity: 30,
    pending_quantity: 45,
    average_price: 99.5,
    price: req.pricing.limit_price,
    tag: stableKiteTag(req.client_order_id),
    status_message: null,
    order_timestamp: null,
    exchange_update_timestamp: null,
  };

  // Order A: the stream reports 75 first, then an OLDER REST read reports 30.
  {
    const transport = kiteRaceTransport();
    transport.book.push(restRow);
    const adapter = new KiteBrokerAdapter(transport, kiteConfig(), fakeClock());
    await adapter.submitOrder(req).catch(() => {});
    adapter.applyOrderUpdate(fillObservation(req.client_order_id, LOTS, "COMPLETE"));
    const after = await adapter.getOrder(req.client_order_id);
    assert.equal(after.filled_quantity, LOTS, "an older REST read must not rewind a streamed fill");
  }

  // Order B: the REST read of 30 lands first, then the stream reports 75.
  {
    const transport = kiteRaceTransport();
    transport.book.push(restRow);
    const adapter = new KiteBrokerAdapter(transport, kiteConfig(), fakeClock());
    await adapter.submitOrder(req).catch(() => {});
    await adapter.getOrder(req.client_order_id);
    const merged = adapter.applyOrderUpdate(fillObservation(req.client_order_id, LOTS, "COMPLETE"));
    assert.equal(merged.filled_quantity, LOTS, "a later, larger fill is accepted");
    const after = await adapter.getOrder(req.client_order_id);
    assert.equal(after.filled_quantity, LOTS, "and a re-read cannot lower it again");
  }
});

test("REQUIRED 8: a stream observation reporting LESS than is held is never applied", async () => {
  const holder = {};
  const transport = kiteRaceTransport({
    injectBeforeThrow: () => holder.adapter.applyOrderUpdate(
      fillObservation(kiteRequest().client_order_id, LOTS, "COMPLETE"),
    ),
    failWith: () => new KiteHttpError(400, "rejected", {}),
  });
  holder.adapter = new KiteBrokerAdapter(transport, kiteConfig(), fakeClock());
  const req = kiteRequest();
  await rejection(holder.adapter.submitOrder(req));

  // A regressing observation arrives afterwards.
  const regressed = holder.adapter.applyOrderUpdate(fillObservation(req.client_order_id, 10, "OPEN"));
  assert.equal(regressed.filled_quantity, LOTS, "cumulative fill is monotonic");
  assert.equal(regressed.state, "RECONCILIATION_REQUIRED", "and the contradiction is still flagged");
});

/* ═══════════════════════ composed gateway/manager/adapter cases ═══════════════════════ */

/**
 * Produce the error a REAL Kite adapter raises for a contradicted rejection of `req`.
 *
 * This is what makes the composed cases below a genuine reproduction rather than a re-assertion of
 * a hand-built error: the object that crosses manager → gateway was constructed by the real
 * adapter, through the real merge, from a real mid-POST observation.
 */
async function realContradictedRejection(req, filled) {
  const holder = {};
  const transport = kiteRaceTransport({
    injectBeforeThrow: () => holder.adapter.applyOrderUpdate({
      clientOrderId: req.client_order_id,
      brokerOrderId: `K-${req.role}`,
      cumulativeQty: filled,
      averagePrice: 100.02,
      rawStatus: "OPEN",
      observedAtWall: 1_050,
    }),
    failWith: () => new KiteHttpError(400, "insufficient funds", {}),
  });
  holder.adapter = new KiteBrokerAdapter(transport, kiteConfig(), fakeClock());
  const error = await rejection(holder.adapter.submitOrder(req));
  assert.ok(
    error instanceof BrokerRejectionContradictedError,
    "fixture precondition: the real adapter must produce a contradicted rejection",
  );
  return error;
}

const unwindsOf = (adapter) => adapter.posts.filter((p) => p.purpose === "EMERGENCY_RESIDUAL");

/* ═════════ REQUIRED 5 & 7 — the disputed SELL must not cost its protective BUY ═════════ */

test("REQUIRED 5/7: a contradicted SELL rejection quarantines the attempt and never unwinds the hedges", async () => {
  // k1_pe is a SELL on a LONG_BOX. Its two BUY hedges (k1_ce, k2_pe) fill for real.
  const stack = await liveStack({
    direction: "LONG_BOX",
    adapterOptions: {
      submit: async (req) => {
        if (req.purpose === "ENTRY" && req.role === "k1_pe") {
          throw await realContradictedRejection(req, 25);
        }
        return brokerOrderFor(req);
      },
    },
  });

  const result = await runEntry(stack, {
    qualify: () => { throw new Error("an incomplete entry must never reach final economics"); },
  });

  // 1. The attempt is QUARANTINED, not "recovered".
  assert.equal(result.ok, false);
  assert.equal(result.reason, "legging_incomplete");
  assert.equal(result.legging.opened, false);
  assert.equal(
    result.legging.outcome_class, "QUARANTINED_UNKNOWN",
    "a disputed leg must be quarantined, never treated as absent",
  );

  // 2. THE DANGEROUS ACTION DID NOT HAPPEN. No confirmed hedge was reversed.
  assert.deepEqual(
    unwindsOf(stack.adapter), [],
    "the confirmed BUY hedges protect a leg that may really be short; they must not be sold",
  );

  // 3. The uncertainty was declared.
  assert.ok(
    stack.violations.some((v) => /uncertain broker terminal quantity/i.test(v)),
    `expected an uncertainty invariant violation, got ${JSON.stringify(stack.violations)}`,
  );

  // 4. THE DURABLE ROW keeps the disputed leg's real fill, non-terminal, for the reconciler.
  const disputed = [...stack.persistence.rows.values()]
    .find((row) => row.role === "k1_pe" && row.purpose === "ENTRY");
  assert.ok(disputed, "the disputed leg must have a durable row");
  assert.equal(disputed.state, "RECONCILIATION_REQUIRED", "durably uncertain, not durably REJECTED");
  assert.equal(disputed.filled_quantity, 25, "the observed fill is durably preserved");
  assert.equal(disputed.terminal_at ?? null, null, "an unresolved contradiction is not terminal");
});

test("REQUIRED 5 (negative control): the SAME shape with a PROVEN zero-fill rejection still unwinds", async () => {
  // Non-vacuity: if the rejection really does prove absence, the pre-existing recovery must still
  // run — otherwise the test above would pass for the wrong reason (nothing ever unwinds).
  const stack = await liveStack({
    direction: "LONG_BOX",
    adapterOptions: {
      submit: async (req) => {
        if (req.purpose === "ENTRY" && req.role === "k1_pe") {
          const transport = kiteRaceTransport({ failWith: () => new KiteHttpError(400, "insufficient funds", {}) });
          const adapter = new KiteBrokerAdapter(transport, kiteConfig(), fakeClock());
          const error = await rejection(adapter.submitOrder(req));
          assert.ok(error instanceof BrokerOrderRejectedError, "fixture: a genuine rejection");
          throw error;
        }
        return brokerOrderFor(req);
      },
    },
  });

  const result = await runEntry(stack, { qualify: () => { throw new Error("unreachable") } });
  assert.equal(result.ok, false);
  assert.equal(
    result.legging.outcome_class, "PARTIAL_ENTRY_UNWOUND",
    "a proven zero-fill rejection keeps its original recovery",
  );
  assert.equal(unwindsOf(stack.adapter).length, 3, "the three confirmed legs are reversed as before");
  assert.ok(!unwindsOf(stack.adapter).some((u) => u.role === "k1_pe"), "nothing to reverse on the refused leg");
});

/* ═════════ REQUIRED 6 — a disputed BUY hedge never authorises a dependent SELL ═════════ */

test("REQUIRED 6: a DISPUTED BUY hedge never authorises the dependent SELL", async () => {
  // k1_ce is a BUY hedge on a LONG_BOX; k2_ce and k1_pe are the SELLs that depend on hedge cover.
  const stack = await liveStack({
    direction: "LONG_BOX",
    adapterOptions: {
      submit: async (req) => {
        if (req.purpose === "ENTRY" && req.role === "k1_ce") {
          throw await realContradictedRejection(req, 25);
        }
        return brokerOrderFor(req);
      },
    },
  });

  const result = await runEntry(stack, { qualify: () => { throw new Error("unreachable") } });

  const posted = entryPosts(stack.adapter);
  const postedSells = posted.filter((p) => p.side === "SELL");
  assert.deepEqual(
    postedSells.map((p) => p.role), [],
    "an unproven hedge must not authorise ANY uncovered SELL to reach the broker",
  );
  assert.ok(posted.some((p) => p.role === "k1_ce"), "the hedge itself was attempted");

  assert.equal(result.ok, false);
  assert.equal(result.legging.opened, false);
  assert.deepEqual(unwindsOf(stack.adapter), [], "and no protective exposure is reversed");
});

/* ═════════ REQUIRED 9 — a failed durable write cannot manufacture a proven rejection ═════════ */

test("REQUIRED 9: failing to PERSIST the contradiction does not convert it into a proven rejection", async () => {
  const stack = await liveStack({
    direction: "LONG_BOX",
    adapterOptions: {
      submit: async (req) => {
        if (req.purpose === "ENTRY" && req.role === "k1_pe") {
          throw await realContradictedRejection(req, 25);
        }
        return brokerOrderFor(req);
      },
    },
  });

  // The durable write of the uncertainty fails for the disputed leg only.
  const realUpdate = stack.persistence.update.bind(stack.persistence);
  stack.persistence.update = async (clientOrderId, patch, audit, expectedStates) => {
    if (clientOrderId.includes("k1_pe") && patch.state === "RECONCILIATION_REQUIRED") {
      throw new Error("connection terminated unexpectedly");
    }
    return realUpdate(clientOrderId, patch, audit, expectedStates);
  };

  const result = await runEntry(stack, { qualify: () => { throw new Error("unreachable") } });

  // The uncertainty survives the write failure.
  assert.equal(result.ok, false);
  assert.equal(
    result.legging.outcome_class, "QUARANTINED_UNKNOWN",
    "an unrecordable contradiction is still a contradiction",
  );
  assert.deepEqual(unwindsOf(stack.adapter), [], "and still must not unwind the protective hedges");
  assert.equal(stack.manager.health.persistence, "unhealthy", "the persistence fault is reported");
});

/* ═════════ REQUIRED 10 — a local no-POST refusal stays its own distinct outcome ═════════ */

test("REQUIRED 10: a local no-POST refusal is distinct from a broker rejection and from an ambiguous POST", async () => {
  const seen = [];
  const stack = await liveStack({
    direction: "LONG_BOX",
    adapterOptions: {
      duringPacing: (req) => {
        // A LOCAL authority refuses at the send boundary: nothing is transmitted.
        if (req.purpose === "ENTRY" && req.role === "k1_pe") {
          throw new BrokerPreSubmitRefusedError(
            req.client_order_id, "pre_post", true, "feed generation changed before broker POST",
          );
        }
      },
      submit: async (req) => { seen.push(req.role); return brokerOrderFor(req); },
    },
  });

  const result = await runEntry(stack, { qualify: () => { throw new Error("unreachable") } });

  // Proven no POST: the refused role never reached the recording boundary at all.
  assert.ok(!seen.includes("k1_pe"), "a pre-submit refusal must transmit nothing");
  assert.ok(!entryPosts(stack.adapter).some((p) => p.role === "k1_pe"));

  // It is NOT quarantined (that would wedge recovery), and NOT a broker rejection.
  assert.equal(result.ok, false);
  assert.notEqual(
    result.legging.outcome_class, "QUARANTINED_UNKNOWN",
    "a proven no-POST refusal is certain knowledge of zero, not an unknown",
  );
  assert.equal(
    result.legging.outcome_class, "PARTIAL_ENTRY_UNWOUND",
    "the siblings' confirmed fills are safely reversible, because this leg provably does not exist",
  );

  // The durable row records a LOCAL refusal, never a broker reject family.
  const refused = [...stack.persistence.rows.values()]
    .find((row) => row.role === "k1_pe" && row.purpose === "ENTRY");
  assert.ok(refused, "the refused leg still has a durable row");
  assert.equal(refused.state, "REJECTED", "terminally spent locally");
  assert.notEqual(refused.state, "RECONCILIATION_REQUIRED");
});
