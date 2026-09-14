/**
 * REST/WEBSOCKET FILL RACE — lost-update regression, BOTH live adapters.
 *
 * THE DEFECT. Both adapters kept the session projection in a Map keyed by client_order_id and
 * updated it in two phases across an `await`:
 *
 *     const known = this.orders.get(id);          // (1) snapshot
 *     const raw   = await transport.getOrder();    // (2) a stream event can land HERE
 *     const next  = project(known, raw);           // (3) merged against the STALE snapshot
 *     this.orders.set(id, next);                   // (4) unconditional clobber
 *
 * `applyOrderUpdate` (the WebSocket seam) is synchronous and therefore atomic, so the event's merge
 * is correct — it is simply DESTROYED by (4).
 *
 * Reproduced sequence (from the review):
 *     cached cumulative fill = 30 → REST read starts → WebSocket reports 75 →
 *     the older REST response reports CANCELLED with 30 → adapter caches and returns CANCELLED/30.
 *
 * These tests drive the REAL `KiteBrokerAdapter` and `DhanBrokerAdapter` (no merge-helper unit
 * tests here — the helper is exercised through the adapters that must use it) with transports whose
 * responses are controllable deferreds, so the stream event can be delivered while a REST read is
 * genuinely in flight. Every assertion is deterministic: no timers, no sleeps, no polling.
 *
 * Required matrix, applied to BOTH brokers:
 *   1. higher stream fill arrives during an older REST read
 *   2. a stream update arrives during the adapter's SECOND await
 *      (Dhan: the separate trade-detail fetch; Kite: the cancellation-confirmation re-read)
 *   3. two REST responses finish in reverse order
 *   4. a terminal stream observation races an older working response
 *   5. REST fails, or returns no order, after a newer stream observation
 *   6. duplicate observations do not double-count fills
 *   7. late additional fills remain visible (and do not reopen a terminal order)
 *   8. price evidence stays consistent with the accepted cumulative quantity
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KiteBrokerAdapter } from "../../dist/box/kiteBrokerAdapter.js";
import { DhanBrokerAdapter } from "../../dist/box/dhanBrokerAdapter.js";

const QTY = 75;
const CLIENT_ID = "BOX:trade-race:ENTRY:k1_ce:attempt-1";

/** A promise whose settlement this test controls. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield enough microtasks for the adapter to reach (and park on) its next await. */
async function settle(times = 8) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** The durable intent shape both adapters validate during adoption. */
function intent(overrides = {}) {
  return {
    client_order_id: CLIENT_ID,
    broker_order_id: "B-1",
    role: "k1_ce",
    trade_id: "trade-race",
    attempt_id: "attempt-1",
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: "NIFTY26SEP19900CE",
    token: 1001,
    side: "BUY",
    quantity: QTY,
    reference_price: 100,
    tick_size: 0.05,
    max_chase_ticks: 2,
    limit_price: 100.1,
    broker_tag: null,
    broker_correlation_id: null,
    ...overrides,
  };
}

/**
 * A cached snapshot with a PARTIAL fill already observed — the "30" of the reproduced sequence.
 * `execution_evidence` is present exactly as a live projection would leave it.
 */
function cachedSnapshot(overrides = {}) {
  const filled = overrides.filled_quantity ?? 30;
  const price = overrides.average_price !== undefined ? overrides.average_price : 10;
  return {
    client_order_id: CLIENT_ID,
    broker_order_id: "B-1",
    tag: null,
    role: "k1_ce",
    trade_id: "trade-race",
    attempt_id: "attempt-1",
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: "NIFTY26SEP19900CE",
    token: 1001,
    side: "BUY",
    quantity: QTY,
    pricing: {
      order_type: "LIMIT",
      reference_price: 100,
      tick_size: 0.05,
      max_chase_ticks: 2,
      limit_price: 100.1,
    },
    limit_price: 100.1,
    state: "PARTIALLY_FILLED",
    filled_quantity: filled,
    pending_quantity: Math.max(0, QTY - filled),
    average_price: price,
    fills: filled > 0 ? [{ fill_id: `seed:${filled}`, quantity: filled, price, at: 1 }] : [],
    execution_evidence: { quantity: "confirmed", price: price === null ? "missing" : "confirmed", accounting: price === null ? "pending_price" : "complete" },
    reject_family: null,
    reject_reason: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

/* ════════════════════════════════ KITE HARNESS ════════════════════════════════ */

function kiteClock() {
  let now = 100;
  return { now: () => now, wait: async (ms) => { now += ms; } };
}

/** Kite REST order row. */
function kiteRow(overrides = {}) {
  return {
    order_id: "B-1",
    status: "OPEN",
    exchange: "NFO",
    tradingsymbol: "NIFTY26SEP19900CE",
    transaction_type: "BUY",
    quantity: QTY,
    filled_quantity: 0,
    pending_quantity: QTY,
    average_price: 0,
    price: 100.1,
    tag: null,
    status_message: null,
    order_timestamp: null,
    exchange_update_timestamp: null,
    ...overrides,
  };
}

async function kiteHarness() {
  const pending = [];
  const transport = {
    getOrderCalls: 0,
    listOrdersCalls: 0,
    /** Each getOrder parks a deferred the test resolves explicitly. */
    async getOrder() {
      transport.getOrderCalls++;
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    async listOrders() {
      transport.listOrdersCalls++;
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    async placeOrder(_payload, opts) { opts?.beforeSend?.(); return { order_id: "B-1" }; },
    async cancelOrder() {},
    async modifyOrder() {},
    async listPositions() { return []; },
    async health() { return { authenticated: true, message: null, checked_at: 0 }; },
  };
  const adapter = new KiteBrokerAdapter(
    transport,
    {
      executionMode: "live",
      enabled: true,
      ackTimeoutMs: 60_000,
      workingTimeoutMs: 60_000,
      partialTimeoutMs: 60_000,
      cancelTimeoutMs: 60_000,
      brokerMinIntervalMs: 1,
      pacing: {
        broker: "zerodha",
        orderMutationMinIntervalMs: 0,
        generalMinIntervalMs: 0,
        source: "operator_override",
        floorMs: 0,
        rationale: "test",
      },
      maxModifications: 2,
      maxChaseTicks: 2,
    },
    kiteClock(),
  );
  await adapter.adoptOrder(intent(), cachedSnapshot());
  return { adapter, transport, pending };
}

/* ════════════════════════════════ DHAN HARNESS ════════════════════════════════ */

function dhanRow(overrides = {}) {
  return {
    dhanClientId: "C1",
    orderId: "B-1",
    correlationId: null,
    orderStatus: "PENDING",
    transactionType: "BUY",
    exchangeSegment: "NSE_FNO",
    productType: "MARGIN",
    orderType: "LIMIT",
    validity: "DAY",
    tradingSymbol: "NIFTY26SEP19900CE",
    securityId: "555",
    quantity: QTY,
    price: 100.1,
    ...overrides,
  };
}

async function dhanHarness() {
  const pendingOrder = [];
  const pendingTrades = [];
  const client = {
    getOrderCalls: 0,
    getTradesCalls: 0,
    async getOrder() {
      client.getOrderCalls++;
      const d = deferred();
      pendingOrder.push(d);
      return d.promise;
    },
    async getOrderByCorrelationId() {
      client.getOrderCalls++;
      const d = deferred();
      pendingOrder.push(d);
      return d.promise;
    },
    async getTradesForOrder() {
      client.getTradesCalls++;
      const d = deferred();
      pendingTrades.push(d);
      return d.promise;
    },
    async listOrders() {
      const d = deferred();
      pendingOrder.push(d);
      return d.promise;
    },
    async placeOrder() { return { orderId: "B-1", orderStatus: "PENDING" }; },
    async cancelOrder() { return { orderId: "B-1", orderStatus: "CANCELLED" }; },
    async modifyOrder() { return { orderId: "B-1", orderStatus: "PENDING" }; },
    async listPositions() { return []; },
    async getFundLimit() { return {}; },
    async getProfile() { return {}; },
  };
  const adapter = new DhanBrokerAdapter(client, {
    executionMode: "live",
    enabled: true,
    staticIpReady: () => true,
    ackTimeoutMs: 60_000,
    workingTimeoutMs: 60_000,
    partialTimeoutMs: 60_000,
    cancelTimeoutMs: 60_000,
    brokerMinIntervalMs: 0,
    pacing: {
      broker: "dhan",
      orderMutationMinIntervalMs: 0,
      generalMinIntervalMs: 0,
      source: "operator_override",
      floorMs: 0,
      rationale: "test",
    },
    maxModifications: 2,
    maxChaseTicks: 2,
    dhanClientId: () => "C1",
    identify: () => ({ segment: "NSE_FNO", securityId: 555 }),
  });
  await adapter.adoptOrder(intent(), cachedSnapshot());
  return { adapter, client, pendingOrder, pendingTrades };
}

/* ════════════════════════════ SHARED EXPECTATIONS ════════════════════════════ */

/**
 * The invariant every case below shares: whatever the adapter RETURNS and whatever it CACHES must
 * be the same accepted state, and it must never be below the highest cumulative quantity observed.
 */
async function assertCoherent(adapter, returned, expected, label) {
  assert.equal(returned.filled_quantity, expected.filled, `${label}: returned cumulative fill`);
  assert.equal(returned.state, expected.state, `${label}: returned state`);
  assert.equal(
    returned.pending_quantity,
    Math.max(0, QTY - expected.filled),
    `${label}: pending quantity must follow the accepted cumulative fill`,
  );
  if (expected.averagePrice !== undefined) {
    assert.equal(returned.average_price, expected.averagePrice, `${label}: average price`);
  }
  assertFillsConsistent(returned, expected.filled, label);
}

/**
 * Fill-record consistency.
 *
 * The fill array may LAG the aggregate (a partially returned trade book is documented, best-effort
 * behaviour), so it is not required to reach the accepted quantity. Two things are required:
 *   • it must never exceed the accepted cumulative quantity — that would be double counting;
 *   • a SINGLE row is an aggregate by construction in both adapters, so it must equal the accepted
 *     cumulative quantity rather than describe some earlier, smaller fill.
 */
function assertFillsConsistent(order, accepted, label) {
  const summed = order.fills.reduce((total, fill) => total + fill.quantity, 0);
  assert.ok(
    summed <= accepted,
    `${label}: fill records sum to ${summed}, above the accepted cumulative fill ${accepted} (double counted)`,
  );
  if (order.fills.length === 1) {
    assert.equal(
      summed,
      accepted,
      `${label}: a single aggregate fill row must equal the accepted cumulative fill`,
    );
  }
}

/* ════════════════════════════════════ KITE ════════════════════════════════════ */

test("KITE 1: a higher stream fill during an older REST read is not overwritten", async () => {
  const { adapter, pending } = await kiteHarness();

  const read = adapter.getOrder(CLIENT_ID); // starts the REST round trip
  await settle();
  assert.equal(pending.length, 1, "the REST read is in flight");

  // The WebSocket overtakes the in-flight read: 75 of 75, fully filled, priced.
  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "COMPLETE",
    observedAtWall: 200,
  });

  // Only NOW does the older REST response land, reporting CANCELLED with the pre-fill quantity.
  pending[0].resolve(kiteRow({ status: "CANCELLED", filled_quantity: 30, average_price: 10 }));
  const returned = await read;

  await assertCoherent(adapter, returned, { filled: 75, state: "COMPLETE", averagePrice: 12.4 }, "KITE 1");

  // CACHE COHERENCE: a follow-up read that ALSO reports the stale figure must still see 75, which
  // proves the in-flight response did not clobber the cache on its way out.
  const follow = adapter.getOrder(CLIENT_ID);
  await settle();
  pending[1].resolve(kiteRow({ status: "CANCELLED", filled_quantity: 30, average_price: 10 }));
  const after = await follow;
  assert.equal(after.filled_quantity, 75, "KITE 1: the cached cumulative fill was not clobbered");
});

test("KITE 2: a stream update during the cancellation-confirmation re-read survives", async () => {
  const { adapter, pending } = await kiteHarness();

  // cancelOrder → confirmTerminalAfterCancel → refresh (the adapter's second REST hop).
  const cancelling = adapter.cancelOrder(CLIENT_ID);
  await settle();
  assert.ok(pending.length >= 1, "the confirmation re-read is in flight");

  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "COMPLETE",
    observedAtWall: 200,
  });

  // The confirmation read reports the pre-fill cancellation.
  pending[0].resolve(kiteRow({ status: "CANCELLED", filled_quantity: 30, average_price: 10 }));
  const returned = await cancelling;

  await assertCoherent(adapter, returned, { filled: 75, state: "COMPLETE", averagePrice: 12.4 }, "KITE 2");
});

/**
 * Two REST responses finishing in reverse order.
 *
 * NOTE ON FAITHFULNESS: the adapters pace every transport call through a FIFO chain
 * (TransportPacer), so two reads on one adapter cannot have their HTTP calls overlap. Out-of-order
 * REST data therefore surfaces as a LATER call returning an OLDER row — the ordinary consequence of
 * a broker read replica lagging — which is what is modelled here. The overlapping-in-flight variant
 * is covered by cases 1, 2 and 4, where the competing observation arrives on the stream.
 */
test("KITE 3: a later REST response carrying an older row does not regress fill or state", async () => {
  const { adapter, pending } = await kiteHarness();

  const first = adapter.getOrder(CLIENT_ID);
  await settle();
  pending[0].resolve(kiteRow({ status: "COMPLETE", filled_quantity: 75, average_price: 12.4 }));
  const advanced = await first;
  assert.equal(advanced.filled_quantity, 75);
  assert.equal(advanced.state, "COMPLETE");

  // The next call returns the OLDER row (replica lag).
  const second = adapter.getOrder(CLIENT_ID);
  await settle();
  pending[1].resolve(kiteRow({ status: "OPEN", filled_quantity: 30, average_price: 10 }));
  const stale = await second;

  await assertCoherent(adapter, stale, { filled: 75, state: "COMPLETE", averagePrice: 12.4 }, "KITE 3");
});

test("KITE 4: a terminal stream observation is not rewound by an older working response", async () => {
  const { adapter, pending } = await kiteHarness();

  const read = adapter.getOrder(CLIENT_ID);
  await settle();

  // Terminal on the stream: fully filled.
  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "COMPLETE",
    observedAtWall: 200,
  });
  // An older, still-WORKING response must not reopen it.
  pending[0].resolve(kiteRow({ status: "OPEN", filled_quantity: 30, average_price: 10 }));
  const returned = await read;

  await assertCoherent(adapter, returned, { filled: 75, state: "COMPLETE", averagePrice: 12.4 }, "KITE 4");
});

test("KITE 5: a REST read returning NO order after a newer stream observation keeps the fill", async () => {
  const { adapter, pending } = await kiteHarness();

  const read = adapter.getOrder(CLIENT_ID);
  await settle();
  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "COMPLETE",
    observedAtWall: 200,
  });
  // The missing-response branch must not return the pre-await snapshot.
  pending[0].resolve(undefined);
  const returned = await read;

  assert.equal(returned.filled_quantity, 75, "KITE 5: the stream-proven fill survives an empty REST response");
  assert.equal(returned.average_price, 12.4, "KITE 5: and so does its price");
  // A confirmed terminal order must not be reopened by a failed read.
  assert.equal(returned.state, "COMPLETE", "KITE 5: an empty read cannot reopen a confirmed terminal order");
});

test("KITE 6: duplicate stream observations do not double-count fills", async () => {
  const { adapter } = await kiteHarness();

  const update = {
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "COMPLETE",
    observedAtWall: 200,
  };
  const once = adapter.applyOrderUpdate(update);
  adapter.applyOrderUpdate(update);
  const again = adapter.applyOrderUpdate(update);

  assert.equal(again.filled_quantity, 75, "KITE 6: cumulative quantity is not additive");
  assert.equal(again.fills.length, once.fills.length, "KITE 6: repeated observations do not grow the fill array");
  assertFillsConsistent(again, 75, "KITE 6");
});

test("KITE 7: a late additional fill stays visible without reopening a terminal order", async () => {
  const { adapter, pending } = await kiteHarness();

  // Establish a terminal CANCELLED with 30 filled.
  const first = adapter.getOrder(CLIENT_ID);
  await settle();
  pending[0].resolve(kiteRow({ status: "CANCELLED", filled_quantity: 30, average_price: 10 }));
  const cancelled = await first;
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.filled_quantity, 30);

  // A later read shows MORE filled than the cancellation reported: a real late fill.
  const second = adapter.getOrder(CLIENT_ID);
  await settle();
  pending[1].resolve(kiteRow({ status: "TRADED", filled_quantity: 50, average_price: 11 }));
  const late = await second;

  assert.equal(late.filled_quantity, 50, "KITE 7: the late fill is visible");
  assert.equal(late.state, "CANCELLED", "KITE 7: a late fill does not reopen the terminal order");
  assert.equal(late.pending_quantity, 25, "KITE 7: pending quantity follows the accepted fill");
});

test("KITE 8: an advanced fill with no price does NOT inherit the older, smaller fill's average", async () => {
  const { adapter, pending } = await kiteHarness();

  const read = adapter.getOrder(CLIENT_ID);
  await settle();
  // The stream advances the cumulative quantity but publishes NO usable price.
  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: null,
    rawStatus: "COMPLETE",
    observedAtWall: 200,
  });
  pending[0].resolve(kiteRow({ status: "CANCELLED", filled_quantity: 30, average_price: 10 }));
  const returned = await read;

  assert.equal(returned.filled_quantity, 75, "KITE 8: exposure is preserved");
  assert.equal(
    returned.average_price,
    null,
    "KITE 8: the average of the older 30-lot fill must NOT be presented as the average of 75",
  );
  assert.equal(
    returned.execution_evidence?.accounting,
    "pending_price",
    "KITE 8: confirmed exposure without price evidence uses the existing pending_price mechanism",
  );
});

/* ════════════════════════════════════ DHAN ════════════════════════════════════ */

test("DHAN 1: a higher stream fill during an older REST read is not overwritten", async () => {
  const { adapter, pendingOrder, pendingTrades } = await dhanHarness();

  const read = adapter.getOrder(CLIENT_ID);
  await settle();
  assert.equal(pendingOrder.length, 1, "the REST order read is in flight");

  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "TRADED",
    observedAtWall: 200,
  });

  pendingOrder[0].resolve(dhanRow({ orderStatus: "CANCELLED", filledQty: 30, averageTradedPrice: 10 }));
  await settle();
  if (pendingTrades.length > 0) pendingTrades[0].resolve([]);
  const returned = await read;

  await assertCoherent(adapter, returned, { filled: 75, state: "COMPLETE", averagePrice: 12.4 }, "DHAN 1");

  // CACHE COHERENCE: a follow-up read reporting the SAME stale figure must still see 75.
  const follow = adapter.getOrder(CLIENT_ID);
  await settle();
  pendingOrder[1].resolve(dhanRow({ orderStatus: "CANCELLED", filledQty: 30, averageTradedPrice: 10 }));
  await settle();
  pendingTrades[1]?.resolve([]);
  const after = await follow;
  assert.equal(after.filled_quantity, 75, "DHAN 1: the cached cumulative fill was not clobbered");
});

test("DHAN 2: a stream update during the separate trade-detail fetch survives", async () => {
  const { adapter, pendingOrder, pendingTrades } = await dhanHarness();

  const read = adapter.getOrder(CLIENT_ID);
  await settle();

  // Resolve the ORDER read first so the adapter proceeds to its SECOND await (the trade book)…
  pendingOrder[0].resolve(dhanRow({ orderStatus: "CANCELLED", filledQty: 30, averageTradedPrice: 10 }));
  await settle();
  assert.equal(pendingTrades.length, 1, "the trade-detail fetch is now in flight");

  // …and deliver the stream event inside THAT window. This is the wider of Dhan's two windows.
  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "TRADED",
    observedAtWall: 200,
  });

  pendingTrades[0].resolve([]);
  const returned = await read;

  await assertCoherent(adapter, returned, { filled: 75, state: "COMPLETE", averagePrice: 12.4 }, "DHAN 2");
});

/** See the note on KITE 3 for why out-of-order REST data is modelled as a lagging later response. */
test("DHAN 3: a later REST response carrying an older row does not regress fill or state", async () => {
  const { adapter, pendingOrder, pendingTrades } = await dhanHarness();

  const first = adapter.getOrder(CLIENT_ID);
  await settle();
  pendingOrder[0].resolve(dhanRow({ orderStatus: "TRADED", filledQty: 75, averageTradedPrice: 12.4 }));
  await settle();
  pendingTrades[0]?.resolve([]);
  const advanced = await first;
  assert.equal(advanced.filled_quantity, 75);
  assert.equal(advanced.state, "COMPLETE");

  const second = adapter.getOrder(CLIENT_ID);
  await settle();
  pendingOrder[1].resolve(dhanRow({ orderStatus: "PENDING", filledQty: 30, averageTradedPrice: 10 }));
  await settle();
  pendingTrades[1]?.resolve([]);
  const stale = await second;

  await assertCoherent(adapter, stale, { filled: 75, state: "COMPLETE", averagePrice: 12.4 }, "DHAN 3");
});

test("DHAN 4: a terminal stream observation is not rewound by an older working response", async () => {
  const { adapter, pendingOrder, pendingTrades } = await dhanHarness();

  const read = adapter.getOrder(CLIENT_ID);
  await settle();
  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "TRADED",
    observedAtWall: 200,
  });
  pendingOrder[0].resolve(dhanRow({ orderStatus: "PENDING", filledQty: 30, averageTradedPrice: 10 }));
  await settle();
  pendingTrades[0]?.resolve([]);
  const returned = await read;

  await assertCoherent(adapter, returned, { filled: 75, state: "COMPLETE", averagePrice: 12.4 }, "DHAN 4");
});

test("DHAN 5: a failed REST read after a newer stream observation keeps the fill", async () => {
  const { adapter, pendingOrder } = await dhanHarness();

  const read = adapter.getOrder(CLIENT_ID);
  await settle();
  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "TRADED",
    observedAtWall: 200,
  });
  // Dhan's catch branch returned the PRE-AWAIT `known` as if it were current.
  pendingOrder[0].reject(new Error("transient read failure"));
  const returned = await read;

  assert.equal(returned.filled_quantity, 75, "DHAN 5: the stream-proven fill survives a failed REST read");
  assert.equal(returned.average_price, 12.4, "DHAN 5: and so does its price");
  assert.equal(returned.state, "COMPLETE", "DHAN 5: a failed read cannot reopen a confirmed terminal order");
});

test("DHAN 6: duplicate stream observations do not double-count fills", async () => {
  const { adapter } = await dhanHarness();

  const update = {
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "TRADED",
    observedAtWall: 200,
  };
  const once = adapter.applyOrderUpdate(update);
  adapter.applyOrderUpdate(update);
  const again = adapter.applyOrderUpdate(update);

  assert.equal(again.filled_quantity, 75, "DHAN 6: cumulative quantity is not additive");
  assert.equal(again.fills.length, once.fills.length, "DHAN 6: repeated observations do not grow the fill array");
  assertFillsConsistent(again, 75, "DHAN 6");
});

test("DHAN 7: a late additional fill stays visible without reopening a terminal order", async () => {
  const { adapter, pendingOrder, pendingTrades } = await dhanHarness();

  const first = adapter.getOrder(CLIENT_ID);
  await settle();
  pendingOrder[0].resolve(dhanRow({ orderStatus: "CANCELLED", filledQty: 30, averageTradedPrice: 10 }));
  await settle();
  pendingTrades[0]?.resolve([]);
  const cancelled = await first;
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.filled_quantity, 30);

  const second = adapter.getOrder(CLIENT_ID);
  await settle();
  pendingOrder[1].resolve(dhanRow({ orderStatus: "TRADED", filledQty: 50, averageTradedPrice: 11 }));
  await settle();
  pendingTrades[1]?.resolve([]);
  const late = await second;

  assert.equal(late.filled_quantity, 50, "DHAN 7: the late fill is visible");
  assert.equal(late.state, "CANCELLED", "DHAN 7: a late fill does not reopen the terminal order");
  assert.equal(late.pending_quantity, 25, "DHAN 7: pending quantity follows the accepted fill");
});

test("DHAN 8: an advanced fill with no price does NOT inherit the older, smaller fill's average", async () => {
  const { adapter, pendingOrder, pendingTrades } = await dhanHarness();

  const read = adapter.getOrder(CLIENT_ID);
  await settle();
  adapter.applyOrderUpdate({
    clientOrderId: CLIENT_ID,
    brokerOrderId: "B-1",
    cumulativeQty: 75,
    averagePrice: null,
    rawStatus: "TRADED",
    observedAtWall: 200,
  });
  pendingOrder[0].resolve(dhanRow({ orderStatus: "CANCELLED", filledQty: 30, averageTradedPrice: 10 }));
  await settle();
  pendingTrades[0]?.resolve([]);
  const returned = await read;

  assert.equal(returned.filled_quantity, 75, "DHAN 8: exposure is preserved");
  assert.equal(
    returned.average_price,
    null,
    "DHAN 8: the average of the older 30-lot fill must NOT be presented as the average of 75",
  );
  assert.equal(
    returned.execution_evidence?.accounting,
    "pending_price",
    "DHAN 8: confirmed exposure without price evidence uses the existing pending_price mechanism",
  );
});
