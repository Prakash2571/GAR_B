/**
 * INVARIANT 20 — EXIT ALWAYS WINS, closing the PROTECTIVE_CANCEL gap.
 *
 * The audit found that invariant 20 ("none of the entry blockers may prevent a valid reduction of
 * already-owned exposure") names FOUR reduction operations that must never be blocked: EXIT,
 * protective cancellation, emergency residual flatten, and reconciliation-required reduction.
 *
 * The existing suites cover three of the four at the ORDER-MANAGER layer, but NOT protective
 * cancellation:
 *
 *   - tests/box/liveEntryOwnershipGuard.test.mjs proves an EXIT and an EMERGENCY_RESIDUAL still
 *     POST while `entryEnabled=false` AND the circuit breaker is open.
 *   - tests/box/exitImmunity.test.mjs proves the coordinator/gateway gates (capital cap, session
 *     budget, underlying lock, max-open-boxes, durable reservation outage) never block an
 *     EXIT/flatten.
 *   - tests/box/monitor.test.mjs (test 30) proves scanner STOP still auto-exits.
 *
 * None of them exercises PROTECTIVE_CANCEL under a disarmed entry / open breaker at the manager
 * boundary. `BoxOrderManager.cancelWorkingBoxOrders()` and a `purpose: "PROTECTIVE_CANCEL"`
 * `submit()` are both gated ONLY by `canManageExposure()` (i.e. `liveOrderEnabled`) — never by
 * `canEnter()` — so the enforcement exists; this suite proves it, so the "protective cancellation"
 * clause of invariant 20 is not a claim that nothing verifies.
 *
 * `stack.adapter.posts` / `stack.adapter.cancels` are appended only at the real broker boundary, so
 * "the cancel reached the broker" is a statement about a real mutation, not internal bookkeeping.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { liveStack } from "../box/liveEntryHarness.mjs";

const NOW = 10_000;

/** Attribute the four legs so the manager treats a reduction as owned exposure. */
function ownFourLegs(stack, { quantity = 75 } = {}) {
  const legs = stack.candidate.legs;
  stack.manager.setAttributedBoxPositions([
    { exchange: "NFO", tradingsymbol: legs.k1_ce.tradingsymbol, net_quantity: quantity },
    { exchange: "NFO", tradingsymbol: legs.k2_ce.tradingsymbol, net_quantity: -quantity },
    { exchange: "NFO", tradingsymbol: legs.k2_pe.tradingsymbol, net_quantity: quantity },
    { exchange: "NFO", tradingsymbol: legs.k1_pe.tradingsymbol, net_quantity: -quantity },
  ]);
}

/** A working (non-terminal) durable BOX entry intent for one leg, eligible for a protective cancel. */
function seedWorkingEntryIntent(stack, role = "k1_ce") {
  const leg = stack.candidate.legs[role];
  const clientOrderId = `BOX:trade-live-1:ENTRY:${role}:attempt-1`;
  const at = new Date(NOW);
  stack.persistence.rows.set(clientOrderId, {
    client_order_id: clientOrderId,
    broker_order_id: `B-${clientOrderId}`,
    broker_mode: "live",
    trade_id: "trade-live-1",
    attempt_id: "attempt-1",
    role,
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: leg.tradingsymbol,
    token: leg.token,
    side: "BUY",
    quantity: 75,
    reference_price: 100,
    tick_size: 0.05,
    max_chase_ticks: 2,
    limit_price: 100.1,
    state: "WORKING",
    filled_quantity: 0,
    average_price: null,
    broker_tag: null,
    reject_family: null,
    reject_reason: null,
    created_at: at,
    updated_at: at,
    terminal_at: null,
    audit: [],
  });
  // The adapter must know the order so a cancel round-trip resolves.
  stack.adapter.orders.set(clientOrderId, {
    client_order_id: clientOrderId,
    broker_order_id: `B-${clientOrderId}`,
    tag: null,
    role,
    trade_id: "trade-live-1",
    attempt_id: "attempt-1",
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: leg.tradingsymbol,
    token: leg.token,
    side: "BUY",
    quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
    limit_price: 100.1,
    state: "CANCELLED",
    filled_quantity: 0,
    pending_quantity: 75,
    average_price: null,
    fills: [],
    reject_family: null,
    reject_reason: null,
    created_at: NOW,
    updated_at: NOW,
  });
  return clientOrderId;
}

test("a PROTECTIVE_CANCEL submit reaches the broker while entry is disarmed and the breaker is open", async () => {
  const stack = await liveStack();
  ownFourLegs(stack);
  stack.manager.setControls({ entryEnabled: false });
  stack.manager.invariantViolation("breaker open during protective cancel");

  assert.equal(stack.manager.canEnter(), false, "entry really is closed");
  assert.equal(stack.manager.canManageExposure(), true, "reduction remains permitted");

  const cancelRequest = {
    client_order_id: "BOX:trade-live-1:PROTECTIVE_CANCEL:k1_ce:cancel-1",
    role: "k1_ce",
    trade_id: "trade-live-1",
    attempt_id: "cancel-1",
    purpose: "PROTECTIVE_CANCEL",
    phase: "exit",
    exchange: "NFO",
    tradingsymbol: stack.candidate.legs.k1_ce.tradingsymbol,
    token: stack.candidate.legs.k1_ce.token,
    side: "SELL",
    quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 99.9 },
  };

  // A protective cancel carries no entry guard and is admitted purely on canManageExposure().
  const order = await stack.manager.submit(cancelRequest);
  assert.equal(order.client_order_id, cancelRequest.client_order_id);
  assert.equal(stack.adapter.posts.length, 1, "the protective cancel reached the broker");
  assert.equal(stack.adapter.posts[0].purpose, "PROTECTIVE_CANCEL");
});

test("cancelWorkingBoxOrders() cancels working legs while entry is disarmed and the breaker is open", async () => {
  const stack = await liveStack();
  ownFourLegs(stack);
  const clientOrderId = seedWorkingEntryIntent(stack, "k1_ce");

  stack.manager.setControls({ entryEnabled: false });
  stack.manager.invariantViolation("breaker open during cancel sweep");
  assert.equal(stack.manager.canEnter(), false, "entry really is closed");

  const result = await stack.manager.cancelWorkingBoxOrders();
  // `cancelWorkingBoxOrders` returns a RESULT, not an array: an empty array could not distinguish
  // "nothing was working" from "the sweep refused to run", and the route published the latter as
  // HTTP 200 `{ok:true, orders:[]}`.
  assert.equal(result.attempted, true, "the sweep was attempted");
  assert.equal(result.ok, true);
  assert.equal(result.cancelled.length, 1, "the working leg was cancelled despite entry being locked down");
  assert.ok(
    stack.adapter.cancels.includes(clientOrderId),
    "the cancel reached the broker for the working BOX order",
  );
});

test("cancelWorkingBoxOrders() is refused ONLY by a genuine inability to act", async () => {
  /*
   * THIS INVARIANT WAS INVERTED, AND THE INVERSION WAS THE BUG.
   *
   * It used to assert: "The single legitimate way to stop a protective cancel is to disable exposure
   * management entirely (box_live_order_enabled=false)." That encoded the defect as a guarantee. With
   * `canManageExposure()` reading `!disposed && controls.liveOrderEnabled`, turning off
   * `box_live_order_enabled` — the obvious operator response to "stop trading" — made the panic
   * button return `[]` untried, and the route published it as HTTP 200 `{ok:true, orders:[]}`.
   * Reproduced with `emergencyFlatten=true`: no intents loaded, no cancellation attempted.
   *
   * An operator preference about taking NEW risk must never remove the ability to SHED risk already
   * taken. So the negative case is no longer a control at all — it is a genuine inability to act
   * attributably:
   *
   *   - the broker session is confirmed unauthenticated (nothing can be sent), or
   *   - the owning account cannot be identified (a mutation could not be attributed).
   *
   * The original test's real value is preserved: the positive case proves the sweep is not vacuous,
   * and the negative case is a REAL refusal that reaches no broker.
   */
  const stack = await liveStack();
  ownFourLegs(stack);
  seedWorkingEntryIntent(stack, "k1_ce");

  // Entry closed AND live orders withdrawn: a cancel STILL runs. This is the corrected invariant.
  stack.manager.setControls({ entryEnabled: false, liveOrderEnabled: false });
  const stillRuns = await stack.manager.cancelWorkingBoxOrders();
  assert.equal(stillRuns.attempted, true, "disarming new orders must NOT disable getting flat");
  assert.equal(stillRuns.cancelled.length, 1);

  // Now a GENUINE inability: the broker session is confirmed unauthenticated.
  seedWorkingEntryIntent(stack, "k2_ce");
  const cancelsBefore = stack.adapter.cancels.length;
  stack.adapter.health = async () => ({
    ok: false, transport: "up", authenticated: false, message: "session rejected", checked_at: NOW,
  });
  await stack.manager.reconcile();

  const refused = await stack.manager.cancelWorkingBoxOrders();
  assert.equal(refused.attempted, false, "nothing was attempted");
  assert.equal(refused.ok, false, "and it is NOT reported as a success");
  assert.match(refused.blocked_reason, /not authenticated/);
  assert.match(
    refused.blocked_reason,
    /exposure is unchanged and still owned/,
    "the operator is told the exposure survives the refusal",
  );
  assert.equal(refused.cancelled.length, 0);
  assert.equal(stack.adapter.cancels.length, cancelsBefore, "no further broker cancel was issued");
});
