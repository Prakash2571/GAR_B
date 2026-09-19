/**
 * D3 — TWO FILL-LEDGER STORES, ONE PROJECTION OF TRUTH + ONE INDEPENDENT OVERFILL TRIPWIRE.
 *
 * The audit found two per-order CumulativeFillLedger stores fed from the SAME broker snapshot on
 * the SAME code path (persistOrder), while a comment claimed "ONE TRUTH":
 *   Store 1: OrderUpdateProjection.ledgers (inside the order-stream consumer), fed by stream events
 *            AND by REST via noteStreamBrokerSnapshot. This is THE projection of truth: it attributes,
 *            deduplicates and wakes waiters.
 *   Store 2: orderManager's second ledger set, fed by (now) checkOverfillTripwire. Its ONLY job is
 *            to TRIP THE CIRCUIT BREAKER on an overfill — a safety cross-check the projection does
 *            NOT perform (the projection computes `applied_overfill` but never trips).
 *
 * RESOLUTION (option B): Store 2 serves a distinct purpose Store 1 cannot — an independent overfill
 * tripwire — so it is KEPT DELIBERATELY, RENAMED (fillLedgers → overfillTripwireLedgers,
 * rememberFillIdentities → checkOverfillTripwire) and its comments corrected so nothing claims to be
 * the single truth. This test pins the invariants the brief demands:
 *
 *   (1) THE OVERFILL PROTECTION STILL HOLDS: an overfilled broker snapshot trips the breaker. (This
 *       runs BEFORE the durable write; real PostgreSQL ALSO rejects it with the
 *       `box_order_intents_filled_le_qty` check constraint — a redundant third guard we observe.)
 *   (2) THE TWO CAN NEVER DISAGREE: for the same order, the projection's cumulative and the
 *       overfill-tripwire's cumulative are identical (both idempotent+monotonic, both fed the same
 *       cumulative snapshot), and a re-fed snapshot is counted exactly once in each — never twice.
 *
 * REAL PostgreSQL for persistence (the durable write persistOrder performs). Each test gets its own
 * schema for isolation. The broker network is mocked with a fake adapter — no broker request.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown } from "./helpers.mjs";

const clone = (v) => structuredClone(v);

function request(overrides = {}) {
  const role = overrides.role ?? "k1_ce";
  const attempt = overrides.attempt_id ?? `a-${Math.random().toString(36).slice(2)}`;
  const trade = overrides.trade_id ?? `d3-${Math.random().toString(36).slice(2)}`;
  return {
    client_order_id: overrides.client_order_id ?? `BOX:${trade}:ENTRY:${role}:${attempt}`,
    role, trade_id: trade, attempt_id: attempt,
    purpose: "ENTRY", phase: "entry",
    exchange: "NFO", tradingsymbol: `SYM-${role}`, token: 1001,
    side: "BUY", quantity: overrides.quantity ?? 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
    tag: overrides.tag ?? `BOXD3-${role}-${attempt}`,
  };
}

/** A fake Kite transport that ACKs and returns a chosen terminal snapshot. No broker network. */
function fakeAdapter({ filled } = {}) {
  const orders = new Map();
  const calls = [];
  return {
    calls,
    mode: "live",
    prepareOrder: (req) => ({ ...req, pricing: { ...req.pricing }, tag: req.tag ?? `TAG-${req.role}` }),
    async submitOrder(req) {
      calls.push(["submit", req.client_order_id]);
      const fill = filled ?? req.quantity;
      const order = {
        client_order_id: req.client_order_id,
        broker_order_id: `B-${req.client_order_id}`,
        tag: req.tag ?? null,
        role: req.role, trade_id: req.trade_id, attempt_id: req.attempt_id,
        purpose: req.purpose, phase: req.phase,
        exchange: req.exchange, tradingsymbol: req.tradingsymbol, token: req.token,
        side: req.side, quantity: req.quantity,
        pricing: { ...req.pricing }, limit_price: req.pricing.limit_price,
        state: fill >= req.quantity ? "COMPLETE" : "PARTIALLY_FILLED",
        filled_quantity: fill, pending_quantity: Math.max(0, req.quantity - fill),
        average_price: 100,
        fills: fill > 0 ? [{ fill_id: `fill-${req.client_order_id}-${fill}`, quantity: fill, price: 100, at: 2_000 }] : [],
        reject_family: null, reject_reason: null,
        created_at: 1_000, updated_at: 2_000,
      };
      orders.set(req.client_order_id, clone(order));
      return clone(order);
    },
    async cancelOrder(id) { calls.push(["cancel", id]); return orders.get(id); },
    async getOrder(id) { calls.push(["get", id]); return orders.has(id) ? clone(orders.get(id)) : undefined; },
    async modifyOrder() {},
    async listOrders() { return [...orders.values()].map(clone); },
    async listPositions() { return []; },
    async health() { return { ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }; },
  };
}

const limits = () => ({
  maxOpenBoxes: 10, maxConcurrentExecutions: 4, maxResidualLegs: 10,
  dailyLossLimit: 1_000_000, rejectLimit: 100, consecutiveFailureLimit: 100,
  maxOpenLegQuantity: 1_000, maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 60_000, feedReconnectWarmupMs: 0,
  // This fixture's broker dep is zerodha, so the static-IP ENTRY policy applies to it. Supplied as
  // confirmed because these cases are about the overfill tripwire and the fill projection agreeing —
  // not about the operator-confirmation gate, which has its own suite. Omitting it silently refused
  // the submit, so the breaker never tripped and the test failed for an unrelated reason.
  zerodhaEntryStaticIpConfirmed: true,
});

/** Build a fresh manager + real consumer against a fresh PG schema. Returns a disposer too. */
async function makeManager(tag, { adapter } = {}) {
  const ctx = await setup(tag);
  const { BoxOrderManager } = await import("../../dist/box/orderManager.js");
  const { OrderStreamConsumer } = await import("../../dist/box/orderStreamConsumer.js");
  const repo = await import("../../dist/box/repository.js");
  const usedAdapter = adapter ?? fakeAdapter();
  let now = 10_000;
  const consumer = new OrderStreamConsumer({
    broker: "zerodha", account: () => "AB1234", adapter: { applyOrderUpdate: () => undefined },
    streamEnabled: true, now: () => now,
  });
  const manager = new BoxOrderManager({
    adapter: usedAdapter,
    orderStreamConsumer: consumer,
    persistence: repo.boxOrderIntentPersistence, // the REAL PG-backed durable write
    limits: limits(),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-02",
    broker: () => "zerodha",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  await manager.reconcile();
  return { ctx, manager, consumer, adapter: usedAdapter, dispose: () => teardown(ctx) };
}

test("D3 (1): an overfilled broker snapshot TRIPS the breaker (overfill protection preserved)", async () => {
  const h = await makeManager("d3overfill", { adapter: fakeAdapter({ filled: 80 }) });
  try {
    const req = request({ tag: "BOXD3-OVERFILL" });
    // The durable write ALSO rejects the overfill (filled_le_qty constraint), surfacing as a throw.
    // The tripwire runs BEFORE that write, so the breaker is already tripped when we inspect it.
    await manager_submit(h.manager, req);
    const status = h.manager.status();
    assert.equal(status.circuitBreaker.tripped, true, "the independent overfill tripwire must trip the breaker");
    assert.match(status.circuitBreaker.reason ?? "", /exceeding the 75 requested/, "the trip must name the overfill");
  } finally {
    await h.dispose();
  }
});

test("D3 (2): the projection and the overfill tripwire NEVER disagree about attributed cumulative", async () => {
  const h = await makeManager("d3agree", { adapter: fakeAdapter({ filled: 75 }) });
  try {
    const req = request({ tag: "BOXD3-AGREE" });
    await manager_submit(h.manager, req);

    // Store 1 — the projection of truth (fed via noteStreamBrokerSnapshot on persistOrder).
    const projectionCumulative = h.consumer.projection().snapshot(req.client_order_id)?.cumulative;
    // Store 2 — the independent overfill tripwire (fed via checkOverfillTripwire on the SAME snapshot).
    const tripwireCumulative = h.manager.overfillTripwireCumulative(req.client_order_id);

    assert.equal(projectionCumulative, 75, "the projection recorded the full fill");
    assert.equal(tripwireCumulative, 75, "the tripwire recorded the full fill");
    assert.equal(
      projectionCumulative, tripwireCumulative,
      "INVARIANT: the two stores must never disagree about attributed cumulative quantity",
    );

    // COUNTED EXACTLY ONCE, NEVER TWICE: re-driving the SAME durable intent reconciles the SAME
    // snapshot through persistOrder again, re-feeding BOTH stores. Both are idempotent, so neither
    // cumulative advances past 75 and the breaker never trips on a legitimate exact fill.
    await manager_submit(h.manager, req);
    assert.equal(h.consumer.projection().snapshot(req.client_order_id)?.cumulative, 75, "projection did not double-count");
    assert.equal(h.manager.overfillTripwireCumulative(req.client_order_id), 75, "tripwire did not double-count");
    assert.equal(h.manager.status().circuitBreaker.tripped, false, "a legitimate exact fill never trips the breaker");
  } finally {
    await h.dispose();
  }
});

/** submit() may resolve or reject (durable overfill constraint); either way both stores were fed. */
async function manager_submit(manager, req) {
  try {
    await manager.submit(req);
  } catch {
    /* an overfill's durable write throws AFTER the tripwire ran — expected in test (1). */
  }
}
