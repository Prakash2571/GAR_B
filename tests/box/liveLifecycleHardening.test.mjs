/**
 * SECOND-PASS AUDIT REGRESSIONS — live order lifecycle defects.
 *
 * Each assertion describes DESIRED behaviour and FAILS on 292e8a7.
 *
 *   L2 — the ack/working deadline was re-derived on every poll from `order.state` while `elapsed` was
 *   always measured from the start. `kiteState` maps every transient `*PENDING` label back to
 *   ACKNOWLEDGED, so a healthy order resting for 4s under the 30s working budget was judged against
 *   the 3s ACK budget the moment one poll reported a pending label — and protectively CANCELLED.
 *
 *   L3 — neither cancel entry point guarded against `CANCEL_REQUESTED` (which is deliberately NOT
 *   terminal), so a second DELETE went out whenever a cancellation was already in flight. Kite answers
 *   that with a definitive 400, which was then converted into a forced quarantine of a perfectly
 *   resolvable order.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KiteBrokerAdapter } from "../../dist/box/kiteBrokerAdapter.js";
import { isBrokerOrderTerminal } from "../../dist/box/brokerAdapter.js";

const CONFIG = {
  executionMode: "live",
  enabled: true,
  ackTimeoutMs: 3_000,
  workingTimeoutMs: 30_000,
  partialTimeoutMs: 10_000,
  cancelTimeoutMs: 1_000,
  brokerMinIntervalMs: 10,
  maxModifications: 3,
};

function clock(start = 0) {
  let now = start;
  return { now: () => now, wait: async (ms) => { now += ms; }, at: () => now };
}

/**
 * A transport driven by a scripted list of Kite status labels, recording every call.
 *
 * A fake transport object rather than a fake `fetch`, matching the convention in
 * `kiteBrokerAdapter.test.mjs`.
 */
function scripted({ statuses, cancelError }) {
  const calls = [];
  let i = 0;
  const state = () => statuses[Math.min(i, statuses.length - 1)];
  return {
    calls,
    cancels: () => calls.filter((c) => c[0] === "cancel").length,
    async placeOrder(_req, opts) {
      calls.push(["place"]);
      opts?.beforeSend?.();
      return { order_id: "BRK-1" };
    },
    async getOrder() {
      calls.push(["get"]);
      const status = state();
      i += 1;
      return {
        order_id: "BRK-1",
        status,
        filled_quantity: 0,
        pending_quantity: 75,
        quantity: 75,
        average_price: null,
        order_timestamp: null,
        exchange_update_timestamp: null,
        status_message: null,
        tag: "TAG",
      };
    },
    async cancelOrder(id) {
      calls.push(["cancel", id]);
      if (cancelError) throw cancelError;
    },
    async listOrders() { return []; },
    async listPositions() { return []; },
  };
}

const request = (o = {}) => ({
  client_order_id: o.client_order_id ?? "BOX-1",
  trade_id: "T1",
  attempt_id: "A1",
  role: "k1_ce",
  purpose: "ENTRY",
  phase: "entry",
  exchange: "NFO",
  tradingsymbol: "SYM",
  token: 111,
  side: "BUY",
  quantity: 75,
  pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
  tag: "TAG",
});

/* ═══════════ L2: a transient PENDING label must not collapse the working budget ═══════════ */

test("L2-1: a transient MODIFY VALIDATION PENDING does not protective-cancel a healthy resting order", async () => {
  // OPEN (working, 30s budget) → a transient pending label → OPEN again. On the baseline the pending
  // label re-selected the 3s ACK budget while `elapsed` was already ~4s, so the order was cancelled.
  const transport = scripted({
    statuses: ["OPEN", "OPEN", "MODIFY VALIDATION PENDING", "OPEN", "COMPLETE"],
  });
  const c = clock();
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, c);

  const order = await adapter.submitOrder(request());
  assert.equal(
    transport.cancels(),
    0,
    "a healthy order that briefly reports a pending label must NOT be cancelled",
  );
  assert.ok(isBrokerOrderTerminal(order.state), `resolved, got ${order.state}`);
});

test("L2-2: an order that never leaves ACKNOWLEDGED still times out on the ACK budget", async () => {
  // The inverse error must not be introduced: a genuinely stuck acknowledgement must still be
  // protective-cancelled on the SHORT budget, not granted the 30s working budget.
  const transport = scripted({ statuses: ["VALIDATION PENDING"] });
  const c = clock();
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, c);
  await adapter.submitOrder(request()).catch(() => undefined);
  assert.ok(transport.cancels() >= 1, "a stuck ACK is still protective-cancelled");
  assert.ok(
    c.at() < CONFIG.workingTimeoutMs,
    `it must fire on the ACK budget (${c.at()}ms elapsed), not wait out the working budget`,
  );
});

/* ═══════════ L3: a cancellation already in flight must not be sent twice ═══════════ */

test("L3-1: cancelOrder is idempotent — a pending cancellation is awaited, not duplicated", async () => {
  // CANCEL_REQUESTED is deliberately NOT terminal (the order can still be filling), so the
  // terminality guard did not cover it and a second DELETE went out.
  const transport = scripted({ statuses: ["CANCEL PENDING", "CANCELLED"] });
  const c = clock();
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, c);

  await adapter.submitOrder(request()).catch(() => undefined);
  const before = transport.cancels();
  // A second cancellation request for an order already being cancelled.
  await adapter.cancelOrder("BOX-1").catch(() => undefined);
  assert.equal(
    transport.cancels(),
    before,
    "no second DELETE may be sent for a cancellation already on the wire",
  );
});

test("L3-2: a cancel of an already-terminal order is a no-op, not a broker call", async () => {
  const transport = scripted({ statuses: ["COMPLETE"] });
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, clock());
  await adapter.submitOrder(request()).catch(() => undefined);
  const before = transport.cancels();
  const result = await adapter.cancelOrder("BOX-1");
  assert.equal(transport.cancels(), before, "a settled order is never cancelled at the broker");
  assert.ok(result === undefined || isBrokerOrderTerminal(result.state));
});

test("L3-3: cancelling an unknown client order id is a no-op", async () => {
  const transport = scripted({ statuses: ["OPEN"] });
  const adapter = new KiteBrokerAdapter(transport, { ...CONFIG }, clock());
  assert.equal(await adapter.cancelOrder("NOT-OURS"), undefined);
  assert.equal(transport.cancels(), 0);
});

/* ═══════════ the Dhan side of the P0 fence ═══════════ */

test("P0-D: the Dhan adapter reports its dispatch account, so the send-boundary fence applies", async () => {
  // Without `dispatchAccount()` the manager's account comparison reports "cannot prove" and never
  // refuses — so the P0 fence silently protected Zerodha only.
  const { DhanBrokerAdapter } = await import("../../dist/box/dhanBrokerAdapter.js");
  assert.equal(
    typeof DhanBrokerAdapter.prototype.dispatchAccount,
    "function",
    "the Dhan adapter must expose the account behind its credential",
  );
});
