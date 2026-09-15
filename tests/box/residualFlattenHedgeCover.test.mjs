/**
 * PERIODIC RESIDUAL FLATTENING MUST NOT SELL THE HEDGES.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THESE TESTS PIN
 *
 * `CentralBoxExecutionGateway.flattenResidual()` used to be:
 *
 *     for (const residual of args.residual) {
 *       passes.push(await this.flattenOneResidual(manager, args.keyPrefix, residual));
 *     }
 *
 * Every residual reversed independently, in whatever order the array arrived. Normal exits
 * (`exitDependencies.ts`) and the immediate protective unwind both understand that a long option is
 * COVER for a short one; this separate periodic recovery path did not.
 *
 * So: an incomplete or recovered box holds two long hedges and two short options. The loop sells both
 * longs — those fill easily, they are the liquid protective side — and then the short-closing BUYs fail
 * to fill. What is left is NAKED SHORT OPTIONS: unlimited-risk exposure, manufactured by the routine
 * whose entire purpose is to remove risk.
 *
 * Sorting shorts first is NOT a sufficient fix, and test C1-c pins that: a short-close that *fails*
 * must still prevent the later sale of its cover. Ordering cannot express a dependency; only a gate can.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THESE TESTS ARE NOT MIRRORS OF THE IMPLEMENTATION
 *
 * They drive the REAL `CentralBoxExecutionGateway` in live mode over the REAL `BoxOrderManager` and a
 * real durable-journal double, and they assert on WHAT REACHED THE ADAPTER — i.e. on whether a long
 * option was actually sold to the broker. That is the only fact that matters for money.
 *
 * C1-b is the non-vacuous control: with the shorts genuinely closed, the longs MUST be sold. Without
 * it, "never sells a long" would pass trivially by doing nothing at all.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager } from "../../dist/box/orderManager.js";
import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { loadBoxConfig } from "../../dist/box/config.js";
import { quote } from "./helpers.mjs";

const clone = (v) => structuredClone(v);
const TERMINAL = ["COMPLETE", "CANCELLED", "REJECTED"];
const TOKENS = { k1_ce: 9001, k2_ce: 9002, k2_pe: 9003, k1_pe: 9004 };

/** The box shape these tests use: two LONG hedges (BUY at entry), two SHORT options (SELL at entry). */
const LONG_ROLES = ["k1_ce", "k2_pe"];
const SHORT_ROLES = ["k2_ce", "k1_pe"];

class Journal {
  constructor() { this.rows = new Map(); }
  async create(intent) {
    const current = this.rows.get(intent.client_order_id);
    if (current) return clone(current);
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  async update(clientOrderId, patch, audit) {
    const current = this.rows.get(clientOrderId);
    if (!current) return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
    const next = { ...current, ...clone(patch) };
    if (!next.audit.some((a) => a.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
    this.rows.set(clientOrderId, next);
    return {
      intent: clone(next), applied: true,
      previous_filled_quantity: current.filled_quantity,
      current_filled_quantity: next.filled_quantity,
    };
  }
  async loadNonterminal() {
    return [...this.rows.values()].filter((i) => !TERMINAL.includes(i.state)).map(clone);
  }
  async loadOwned() { return [...this.rows.values()].map(clone); }
  async findByClientId(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }
  async findByBrokerId(id) {
    const f = [...this.rows.values()].find((i) => i.broker_order_id === id);
    return f ? clone(f) : null;
  }
}

function orderFor(req, { state, filled, avg = 99.9 }) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.client_order_id}`,
    tag: req.tag ?? null, role: req.role, trade_id: req.trade_id, attempt_id: req.attempt_id,
    purpose: req.purpose, phase: req.phase, exchange: req.exchange,
    tradingsymbol: req.tradingsymbol, token: req.token, side: req.side, quantity: req.quantity,
    pricing: { ...req.pricing }, limit_price: req.pricing.limit_price,
    state, filled_quantity: filled, pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? avg : null,
    fills: filled > 0
      ? [{ fill_id: `fill-${req.client_order_id}-${filled}`, quantity: filled, price: avg, at: 2_000 }]
      : [],
    reject_family: null, reject_reason: null, created_at: 1_000, updated_at: 2_000,
  };
}

function adapterFor(script) {
  const submits = [];
  const orders = new Map();
  return {
    mode: "live", submits, orders,
    prepareOrder: (req) => ({ ...req, pricing: { ...req.pricing }, tag: `TAG${req.role}` }),
    submitOrder: async (req, beforePost) => {
      beforePost?.();
      // `submits` represents a real external POST — the thing that spends or creates exposure.
      submits.push({ id: req.client_order_id, role: req.role, side: req.side, quantity: req.quantity });
      const order = orderFor(req, script(req));
      orders.set(req.client_order_id, clone(order));
      return clone(order);
    },
    cancelOrder: async (id) => orders.get(id),
    getOrder: async (id) => (orders.has(id) ? clone(orders.get(id)) : undefined),
    listOrders: async () => [...orders.values()].map(clone),
    listPositions: async () => [],
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (intent, snapshot) => ({ ...clone(snapshot), client_order_id: intent.client_order_id }),
  };
}

const LIMITS = {
  maxOpenBoxes: 10, maxConcurrentExecutions: 1, maxResidualLegs: 10,
  dailyLossLimit: 1_000_000, rejectLimit: 1_000, consecutiveFailureLimit: 1_000,
  maxOpenLegQuantity: 1_000, maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 3_600_000, feedReconnectWarmupMs: 0,
};

/**
 * A live gateway over a real manager, holding a real four-leg box position:
 * LONG roles are attributed +75 (a SELL reduces them), SHORT roles -75 (a BUY reduces them).
 */
async function build(script) {
  const adapter = adapterFor(script);
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter,
    persistence: new Journal(),
    limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-15",
  });
  manager.seedLimits({ tradingDay: "2026-09-15" });
  manager.setFeedHealthy(true);
  manager.setAttributedBoxPositions([
    ...LONG_ROLES.map((role) => ({ exchange: "NFO", tradingsymbol: `SYM-${role}`, net_quantity: 75 })),
    ...SHORT_ROLES.map((role) => ({ exchange: "NFO", tradingsymbol: `SYM-${role}`, net_quantity: -75 })),
  ]);

  const quotes = new BoxQuoteStore();
  quotes.applyTicks(
    Object.values(TOKENS).map((t) => quote(t, { bid: 99.9, bidQty: 900, ask: 100.1, askQty: 900 })),
    1_000,
  );

  const gateway = new CentralBoxExecutionGateway({
    cfg: { ...loadBoxConfig(), executionMode: "live" },
    simulator: {
      flattenResidual: async () => { throw new Error("PAPER PATH MUST NOT BE REACHED IN LIVE MODE"); },
    },
    quotes,
    manager,
    feedGeneration: () => 0,
    chargeTotal: () => 20,
  });
  return { manager, gateway, adapter };
}

/** `side` is the side of the ORIGINAL entry order: BUY ⇒ we are long, SELL ⇒ we are short. */
const residual = (role, side) => ({
  role,
  token: TOKENS[role],
  tradingsymbol: `SYM-${role}`,
  exchange: "NFO",
  side,
  quantity: 75,
  average_price: 100,
  source: "partial_entry",
  created_at: 1_000,
});

const longs = () => LONG_ROLES.map((r) => residual(r, "BUY"));
const shorts = () => SHORT_ROLES.map((r) => residual(r, "SELL"));

const soldLongs = (adapter) => adapter.submits.filter((s) => s.side === "SELL");
const boughtShorts = (adapter) => adapter.submits.filter((s) => s.side === "BUY");

/* ══════════════════ C1. the hedges must survive a failed short close ══════════════════ */

test("C1: when the short closes do not fill, NOT ONE long hedge is sold", async () => {
  // The short-closing BUYs come back cancelled unfilled — the ordinary reason a residual survives.
  const b = await build((req) => (req.side === "BUY"
    ? { state: "CANCELLED", filled: 0 }
    : { state: "COMPLETE", filled: req.quantity }));

  const res = await b.gateway.flattenResidual({
    residual: [...longs(), ...shorts()],
    keyPrefix: "att-1",
  });

  assert.equal(
    soldLongs(b.adapter).length,
    0,
    "NO long hedge may be sold while a short residual is unresolved — this is the naked-short defect",
  );
  assert.equal(boughtShorts(b.adapter).length, 2, "both short closes were attempted");

  // All four legs are still owed, and the hedges say WHY they were held.
  assert.equal(res.remaining.length, 4, "nothing was flattened, so all four residuals remain");
  const heldRoles = res.remaining.map((r) => r.role);
  for (const role of LONG_ROLES) {
    assert.ok(heldRoles.includes(role), `${role} is still held as cover`);
  }
});

test("C1-b (control): once the shorts ARE proven closed, the longs are sold", async () => {
  // Non-vacuous control. Without this, "never sells a long" would pass by doing nothing at all.
  const b = await build((req) => ({ state: "COMPLETE", filled: req.quantity }));

  const res = await b.gateway.flattenResidual({
    residual: [...longs(), ...shorts()],
    keyPrefix: "att-1",
  });

  assert.equal(boughtShorts(b.adapter).length, 2, "the shorts were closed");
  assert.equal(soldLongs(b.adapter).length, 2, "and THEN the cover was released");
  assert.equal(res.remaining.length, 0, "the whole residual set is flat");

  // Ordering is a property of the fix, not an accident: every short close precedes every long sale.
  const lastBuy = b.adapter.submits.findLastIndex((s) => s.side === "BUY");
  const firstSell = b.adapter.submits.findIndex((s) => s.side === "SELL");
  assert.ok(lastBuy < firstSell, "shorts are closed BEFORE any cover is released");
});

test("C1-c: array order cannot defeat the gate — longs first is still refused", async () => {
  /*
   * The old loop's behaviour depended entirely on arrival order, and residual arrays are rebuilt
   * from durable rows whose order is not guaranteed. Putting the longs first is the arrangement that
   * made the old code sell them immediately.
   */
  const b = await build((req) => (req.side === "BUY"
    ? { state: "CANCELLED", filled: 0 }
    : { state: "COMPLETE", filled: req.quantity }));

  await b.gateway.flattenResidual({
    residual: [...longs(), ...shorts()].reverse(),
    keyPrefix: "att-1",
  });

  assert.equal(soldLongs(b.adapter).length, 0, "still no cover released, regardless of input order");
});

test("C1-d: a PARTIALLY closed short still holds the cover", async () => {
  // "Mostly closed" is not closed. 35 of 75 bought back leaves 40 short and uncovered if we sell.
  const b = await build((req) => (req.side === "BUY"
    ? { state: "CANCELLED", filled: 35 }
    : { state: "COMPLETE", filled: req.quantity }));

  const res = await b.gateway.flattenResidual({
    residual: [...shorts(), ...longs()],
    keyPrefix: "att-1",
  });

  assert.equal(soldLongs(b.adapter).length, 0, "a partial short close does not free the hedge");
  const remainingShorts = res.remaining.filter((r) => SHORT_ROLES.includes(r.role));
  for (const r of remainingShorts) {
    assert.equal(r.quantity, 40, "the short's unclosed remainder is carried forward");
  }
});

test("C1-e: a REJECTED short close holds the cover too", async () => {
  // A broker rejection is terminal but leaves the short in place. Terminal is not closed.
  const b = await build((req) => (req.side === "BUY"
    ? { state: "REJECTED", filled: 0 }
    : { state: "COMPLETE", filled: req.quantity }));

  await b.gateway.flattenResidual({ residual: [...shorts(), ...longs()], keyPrefix: "att-1" });
  assert.equal(soldLongs(b.adapter).length, 0, "a rejected short close does not free the hedge");
});

test("C1-f: a held hedge keeps its durable identity so the next pass can retry it", async () => {
  /*
   * Nothing was sent for a held long, so its flatten generation must NOT advance. Burning a
   * generation on an order that never existed would eventually strand the exposure.
   */
  const b = await build((req) => (req.side === "BUY"
    ? { state: "CANCELLED", filled: 0 }
    : { state: "COMPLETE", filled: req.quantity }));

  const start = [...shorts(), ...longs()];
  const res = await b.gateway.flattenResidual({ residual: start, keyPrefix: "att-1" });

  for (const role of LONG_ROLES) {
    const before = start.find((r) => r.role === role);
    const after = res.remaining.find((r) => r.role === role);
    assert.ok(after, `${role} is carried forward`);
    assert.equal(after.quantity, before.quantity, "its full quantity is still owed");
    assert.equal(
      after.flatten_attempt ?? 1,
      before.flatten_attempt ?? 1,
      "its generation did NOT advance — no order was sent under it",
    );
  }
});

test("C1-g: with no shorts at all, longs flatten immediately", async () => {
  // The gate must not become a deadlock for a residual set that has nothing to be covered against.
  const b = await build((req) => ({ state: "COMPLETE", filled: req.quantity }));

  const res = await b.gateway.flattenResidual({ residual: longs(), keyPrefix: "att-1" });

  assert.equal(soldLongs(b.adapter).length, 2, "long-only residuals are not blocked by an absent short");
  assert.equal(res.remaining.length, 0);
});
