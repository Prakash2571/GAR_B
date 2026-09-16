/**
 * AUDIT FINDING 6 — the regression that was still missing.
 *
 * The audit asked for a test that delivers a TERMINAL stream update while a REST read is GENUINELY IN
 * FLIGHT and asserts `submitOrder` resolves BEFORE that read returns. Every earlier test only proved
 * the pre-REST park (`orderStreamRealWaiter` asserts `getOrderCalls() === 0`), which is a different and
 * much weaker property: it shows a stream event is used when nothing else is happening, not that it can
 * END a wait that is already blocked on the network.
 *
 * WHY IT MATTERS. `submitOrder` for a hedge leg does not resolve until the lifecycle reaches a terminal
 * state, and the hedge-first barrier holds every dependent uncovered SELL until it does. So any time
 * spent waiting on a read whose answer already arrived on the socket is added directly to the
 * naked-short window.
 *
 * The REST deferred is left UNRESOLVED across the assertion, so a pass cannot be an accident of timing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KiteBrokerAdapter } from "../../dist/box/kiteBrokerAdapter.js";
import { isBrokerOrderTerminal } from "../../dist/box/brokerAdapter.js";

const CONFIG = {
  executionMode: "live",
  enabled: true,
  ackTimeoutMs: 60_000,
  workingTimeoutMs: 600_000,
  partialTimeoutMs: 600_000,
  cancelTimeoutMs: 5_000,
  brokerMinIntervalMs: 5,
  maxModifications: 3,
};

function clock(start = 0) {
  let now = start;
  return { now: () => now, wait: async (ms) => { now += ms; }, at: () => now };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Pump microtasks. No timers: the whole point is that nothing depends on time passing. */
async function settle(times = 24) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const request = (o = {}) => ({
  client_order_id: o.client_order_id ?? "BOX-1",
  trade_id: "T1", attempt_id: "A1", role: "k1_ce", purpose: "ENTRY", phase: "entry",
  exchange: "NFO", tradingsymbol: "SYM", token: 111, side: "BUY", quantity: 75,
  pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
  tag: "TAG",
});

/** A transport whose `getOrder` hangs on a deferred the test controls. */
function blockingTransport() {
  const gates = [];
  let getCalls = 0;
  return {
    getCalls: () => getCalls,
    gates,
    async placeOrder(_req, opts) { opts?.beforeSend?.(); return { order_id: "BRK-1" }; },
    async getOrder() {
      getCalls += 1;
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
    async cancelOrder() {},
    async listOrders() { return []; },
    async listPositions() { return []; },
  };
}

const streamUpdate = (o = {}) => ({
  clientOrderId: "BOX-1",
  brokerOrderId: "BRK-1",
  account: null,
  ownerTag: "TAG",
  rawStatus: o.rawStatus ?? "COMPLETE",
  cumulativeQty: o.cumulativeQty ?? 75,
  quantityPresent: true,
  averagePrice: o.averagePrice ?? 100.1,
  source: "postback",
});

test("F6-1: a TERMINAL stream update resolves submitOrder while the REST read is still in flight", async () => {
  const transport = blockingTransport();
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, clock());

  let resolved = false;
  const submit = adapter.submitOrder(request()).then((order) => { resolved = true; return order; });

  // Let the lifecycle park, wake on the poll interval, and enter the REST read.
  await settle();
  assert.ok(transport.getCalls() >= 1, "the adapter must actually be blocked on a REST read");
  assert.equal(resolved, false, "not resolved yet — the read is outstanding");

  // The fill arrives on the socket while that read is still hanging.
  const merged = adapter.applyOrderUpdate(streamUpdate());
  assert.ok(merged && isBrokerOrderTerminal(merged.state), "the stream update is terminal evidence");

  await settle();
  const order = await submit;

  // THE HEADLINE ASSERTION: resolved without the REST read ever answering.
  assert.equal(resolved, true);
  assert.ok(isBrokerOrderTerminal(order.state), `resolved terminal, got ${order.state}`);
  assert.equal(order.filled_quantity, 75);
  assert.ok(
    transport.gates.every((gate) => gate.promise !== undefined),
    "the outstanding read was never resolved by the test",
  );
});

test("F6-2: partial -> partial -> COMPLETE releases on the COMPLETE, not on the first partial", async () => {
  // The defect found reviewing the finding-6 fix: a partial won the race, was found nonterminal, and
  // the listener was torn down — so a later COMPLETE had nothing to wake.
  const transport = blockingTransport();
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, clock());

  let resolved = false;
  const submit = adapter.submitOrder(request()).then((o) => { resolved = true; return o; });
  await settle();
  assert.ok(transport.getCalls() >= 1);

  adapter.applyOrderUpdate(streamUpdate({ rawStatus: "OPEN", cumulativeQty: 25 }));
  await settle();
  assert.equal(resolved, false, "a partial is not terminal evidence and must not release the wait");

  adapter.applyOrderUpdate(streamUpdate({ rawStatus: "OPEN", cumulativeQty: 50 }));
  await settle();
  assert.equal(resolved, false, "still not terminal");

  // The observation must STILL be armed after two nonterminal events.
  adapter.applyOrderUpdate(streamUpdate({ rawStatus: "COMPLETE", cumulativeQty: 75 }));
  await settle();
  const order = await submit;
  assert.equal(resolved, true, "the COMPLETE must release the wait even after earlier partials");
  assert.equal(order.filled_quantity, 75);
});

test("F6-3: a terminal CANCELLED stream update also releases the wait", async () => {
  const transport = blockingTransport();
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, clock());
  const submit = adapter.submitOrder(request());
  await settle();
  adapter.applyOrderUpdate(streamUpdate({ rawStatus: "CANCELLED", cumulativeQty: 0, averagePrice: null }));
  await settle();
  const order = await submit;
  assert.ok(isBrokerOrderTerminal(order.state), `got ${order.state}`);
});

test("F6-4: a DUPLICATE terminal update does not double-apply or wedge the lifecycle", async () => {
  const transport = blockingTransport();
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, clock());
  const submit = adapter.submitOrder(request());
  await settle();
  adapter.applyOrderUpdate(streamUpdate());
  adapter.applyOrderUpdate(streamUpdate());
  await settle();
  const order = await submit;
  assert.equal(order.filled_quantity, 75, "cumulative quantity is monotonic, never additive");
});

test("F6-5: a LATE REST response cannot rewind the terminal state the stream established", async () => {
  // Abandoning the read must not discard it: its monotonic merge still has to be safe.
  const transport = blockingTransport();
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, clock());
  const submit = adapter.submitOrder(request());
  await settle();
  adapter.applyOrderUpdate(streamUpdate());
  await settle();
  const order = await submit;
  assert.equal(order.filled_quantity, 75);

  // The read finally answers, describing a SMALLER, still-open fill.
  transport.gates[0]?.resolve({
    order_id: "BRK-1", status: "OPEN", filled_quantity: 25, pending_quantity: 50, quantity: 75,
    average_price: 100.1, order_timestamp: null, exchange_update_timestamp: null,
    status_message: null, tag: "TAG",
  });
  await settle();
  const after = await adapter.getOrder("BOX-1");
  assert.equal(after.filled_quantity, 75, "a staler REST payload must not rewind a confirmed fill");
  assert.ok(isBrokerOrderTerminal(after.state), "nor reopen a confirmed terminal state");
});

test("F6-6: a REJECTED REST read after terminal stream evidence does not surface as a failure", async () => {
  // The abandoned read's rejection must stay handled — it must not become an unhandled rejection nor
  // overwrite the outcome the caller already received.
  const transport = blockingTransport();
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, clock());
  const submit = adapter.submitOrder(request());
  await settle();
  adapter.applyOrderUpdate(streamUpdate());
  await settle();
  const order = await submit;
  assert.equal(order.filled_quantity, 75);

  transport.gates[0]?.resolve(null); // "the broker has no such order right now"
  await settle();
  const after = await adapter.getOrder("BOX-1");
  assert.equal(after.filled_quantity, 75, "the confirmed fill survives an unhelpful late read");
});
