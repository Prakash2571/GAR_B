/**
 * A WORKING ORDER RECOVERED ON RESTART IS NOT "RECONCILED".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THESE TESTS PIN
 *
 * Readiness was scored from `unknownOrders`:
 *
 *     this.unknownOrders = reconciledNonterminalIntents
 *       .filter((intent) => RECONCILE_STATES.has(intent.state)).length;   // UNKNOWN | RECONCILIATION_REQUIRED
 *
 * and both `health.reconciliation_complete` and `safeAttributedReductionReady` were derived from
 * `unknownOrders === 0`. A durable intent that reconciliation MATCHED against a real broker order in
 * OPEN / ACKNOWLEDGED / PARTIALLY_FILLED therefore counted as NOTHING.
 *
 * So after a restart in the middle of an attempt, with a short entry still working at the exchange:
 *
 *     reconciliation_complete = true
 *     safe_reduction_ready    = true
 *     can_enter               = true
 *
 * while an order that could still fill was live. The sequence that loses money: the process dies
 * after a hedge BUY fills and its short SELL is submitted; on restart the short is still working;
 * recovery sees the long and sells it; the short then fills — leaving a naked short option.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE FIX IS, AND IS NOT
 *
 * NOT "refuse to reduce". Refusing would strand the exposure, which is strictly worse and is the
 * defect class this file's neighbours exist to remove. Reduction stays available throughout.
 *
 * Instead: an UNATTENDED working order (one no waiter in this process owns) blocks NEW ENTRY, and the
 * emergency flatten SETTLES before it plans — latch entry off, cancel working orders, re-reconcile,
 * and only then compute reductions against post-cancellation broker truth.
 *
 * `!activeClientIds.has(...)` is what makes this safe: a live four-leg attempt's own in-flight legs are
 * attended, so they must not block their siblings. Test W3 is the control that proves it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager } from "../../dist/box/orderManager.js";

const clone = (v) => structuredClone(v);
const TERMINAL = ["COMPLETE", "CANCELLED", "REJECTED"];

const request = (o = {}) => {
  const role = o.role ?? "k1_ce";
  const purpose = o.purpose ?? "ENTRY";
  const attempt = o.attempt_id ?? "a1";
  const trade = o.trade_id ?? "trade-1";
  return {
    client_order_id: o.client_order_id ?? `BOX:${trade}:${purpose}:${role}:${attempt}`,
    role, trade_id: trade, attempt_id: attempt, purpose,
    phase: o.phase ?? (purpose === "ENTRY" ? "entry" : "exit"),
    exchange: "NFO", tradingsymbol: o.tradingsymbol ?? `SYM-${role}`,
    token: o.token ?? 5000, side: o.side ?? (purpose === "ENTRY" ? "BUY" : "SELL"),
    quantity: o.quantity ?? 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
  };
};

/** A durable intent as it would be READ BACK after a restart. */
function intentFrom(req, state, filled = 0) {
  const at = new Date(1_000);
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.client_order_id}`,
    broker_mode: "live", broker: "zerodha", broker_account: "ZD1234",
    trade_id: req.trade_id, attempt_id: req.attempt_id, role: req.role,
    purpose: req.purpose, phase: req.phase, exchange: req.exchange,
    tradingsymbol: req.tradingsymbol, token: req.token, side: req.side, quantity: req.quantity,
    reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1,
    state, filled_quantity: filled, average_price: null,
    broker_tag: `TAG${req.role}`, reject_family: null, reject_reason: null,
    created_at: at, updated_at: at, terminal_at: null, audit: [],
  };
}

class Journal {
  constructor(intents = []) { this.rows = new Map(intents.map((i) => [i.client_order_id, clone(i)])); }
  async create(intent) {
    const cur = this.rows.get(intent.client_order_id);
    if (cur) return clone(cur);
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  async update(id, patch, audit) {
    const cur = this.rows.get(id);
    if (!cur) return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
    const next = { ...cur, ...clone(patch) };
    if (!next.audit.some((a) => a.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
    this.rows.set(id, next);
    return {
      intent: clone(next), applied: true,
      previous_filled_quantity: cur.filled_quantity, current_filled_quantity: next.filled_quantity,
    };
  }
  async loadNonterminal() { return [...this.rows.values()].filter((i) => !TERMINAL.includes(i.state)).map(clone); }
  async loadOwned() { return [...this.rows.values()].map(clone); }
  async findByClientId(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }
  async findByBrokerId(id) {
    const f = [...this.rows.values()].find((i) => i.broker_order_id === id);
    return f ? clone(f) : null;
  }
}

/** The broker's own view, mirroring the durable rows so reconcile MATCHES rather than trips. */
const brokerOrderFrom = (i) => ({
  client_order_id: i.client_order_id, broker_order_id: i.broker_order_id, tag: i.broker_tag,
  role: i.role, trade_id: i.trade_id, attempt_id: i.attempt_id, purpose: i.purpose, phase: i.phase,
  exchange: i.exchange, tradingsymbol: i.tradingsymbol, token: i.token, side: i.side,
  quantity: i.quantity,
  pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
  limit_price: 100.1, state: i.state, filled_quantity: i.filled_quantity,
  pending_quantity: Math.max(0, i.quantity - i.filled_quantity),
  average_price: null, fills: [], reject_family: null, reject_reason: null,
  created_at: 1_000, updated_at: 2_000,
});

const LIMITS = {
  maxOpenBoxes: 10, maxConcurrentExecutions: 1, maxResidualLegs: 10,
  dailyLossLimit: 1_000_000, rejectLimit: 1_000, consecutiveFailureLimit: 1_000,
  maxOpenLegQuantity: 1_000, maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 3_600_000, feedReconnectWarmupMs: 0,
};

/** A manager booted over durable rows, i.e. exactly the post-restart situation. */
async function restartWith(intents, { positions = [], cancelBlocks = false } = {}) {
  const journal = new Journal(intents);
  const cancelled = [];
  const orders = new Map(intents.map((i) => [i.client_order_id, brokerOrderFrom(i)]));
  const adapter = {
    mode: "live", cancelled, orders,
    prepareOrder: (r) => ({ ...r, tag: `TAG${r.role}` }),
    submitOrder: async (r, before) => { before?.(); return brokerOrderFrom(intentFrom(r, "COMPLETE", r.quantity)); },
    cancelOrder: async (id) => {
      if (cancelBlocks) throw new Error("broker refused the cancel");
      cancelled.push(id);
      const cur = orders.get(id);
      const done = cur ? { ...clone(cur), state: "CANCELLED" } : undefined;
      if (done) orders.set(id, done);
      return done;
    },
    getOrder: async (id) => (orders.has(id) ? clone(orders.get(id)) : undefined),
    listOrders: async () => [...orders.values()].map(clone),
    // Read LIVE from the caller's array so a test can let broker positions follow a fill.
    listPositions: async () => clone(positions),
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (intent, snap) => ({ ...clone(snap), client_order_id: intent.client_order_id }),
  };
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter, persistence: journal, limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ }, istDayKey: () => "2026-09-15",
    brokerAccount: () => "ZD1234",
  });
  manager.seedLimits({ tradingDay: "2026-09-15" });
  manager.setFeedHealthy(true);
  await manager.reconcile();
  return { manager, adapter, journal };
}

/* ══════════════════ W1-W2. a recovered working order is not "nothing" ══════════════════ */

for (const state of ["OPEN", "ACKNOWLEDGED", "PARTIALLY_FILLED", "CANCEL_REQUESTED"]) {
  test(`W1: a recovered ${state} order is counted, and it BLOCKS new entry`, async () => {
    const working = intentFrom(request({ role: "k1_pe", side: "SELL" }), state, state === "PARTIALLY_FILLED" ? 35 : 0);
    const { manager } = await restartWith([working], {
      positions: [
        // The broker's positions must agree with the durable map or reconcile trips for a different
        // reason and the test would pass vacuously.
        { exchange: "NFO", tradingsymbol: "SYM-k1_pe", net_quantity: state === "PARTIALLY_FILLED" ? -35 : 0 },
      ],
    });

    assert.equal(
      manager.status().unattendedWorkingOrders,
      1,
      `${state} is an unattended working order — it used to count as zero`,
    );
    assert.equal(manager.canEnter(request({ role: "k1_ce", attempt_id: "new" })), false, "new entry is refused");
    assert.match(
      manager.entryBlockReason(request({ role: "k1_ce", attempt_id: "new" })) ?? "",
      /interrupted attempt are still live at the broker/,
      "and the reason names the real cause, not a generic 'controls closed'",
    );
  });
}

test("W2: reduction is NOT blocked by an unattended working order", async () => {
  /*
   * The whole point of the previous fixes: nothing about an unsettled quantity may disable the ability
   * to SHED risk. Blocking here would strand the very exposure that needs unwinding.
   */
  const working = intentFrom(request({ role: "k1_pe", side: "SELL" }), "OPEN", 0);
  const { manager } = await restartWith([working], {
    positions: [{ exchange: "NFO", tradingsymbol: "SYM-k1_pe", net_quantity: 0 }],
  });

  assert.equal(manager.status().unattendedWorkingOrders, 1);
  assert.equal(manager.exposureReductionBlockReason(), null, "reduction remains available");

  const sweep = await manager.cancelWorkingBoxOrders();
  assert.equal(sweep.attempted, true, "the working order can be cancelled");
  assert.equal(sweep.cancelled.length, 1);
});

test("W3 (control): a live attempt's OWN in-flight legs do not block its siblings", async () => {
  /*
   * NON-VACUOUS CONTROL. If "any non-terminal intent blocks entry" were the rule, a four-leg box could
   * never submit its second leg. The discriminator is attendance: this process owns these, so they are
   * not unattended.
   */
  // `positions` is the array the adapter reads on every call, so it can follow the fill — a reconcile
  // whose broker positions disagreed with the durable map would trip the breaker for an unrelated
  // reason and this control would pass vacuously.
  const positions = [];
  const { manager } = await restartWith([], { positions });
  assert.equal(manager.status().unattendedWorkingOrders, 0, "a clean boot has none");

  // Leg 1 goes through the real submit path, which registers it as attended.
  const leg1 = await manager.submit(request({ role: "k1_ce", attempt_id: "live" }));
  assert.equal(leg1.state, "COMPLETE");
  positions.push({ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 });

  // A reconcile while the attempt is live must not manufacture a blocker for its siblings.
  await manager.reconcile();
  assert.equal(manager.status().unattendedWorkingOrders, 0, "a completed own leg is terminal, not unattended");
  assert.equal(
    manager.entryBlockReason(request({ role: "k2_ce", attempt_id: "live" })),
    null,
    "the attempt's remaining legs are still admissible",
  );
});

test("W4: a CREATED intent that never reached the broker is not counted as working", async () => {
  // CREATED means the durable row exists but no POST happened. There is nothing live to settle, and
  // counting it would block entry forever on a row that can never fill.
  const created = intentFrom(request({ role: "k1_ce" }), "CREATED", 0);
  const journal = new Journal([created]);
  const adapter = {
    mode: "live", orders: new Map(),
    prepareOrder: (r) => ({ ...r, tag: `TAG${r.role}` }),
    submitOrder: async (r, before) => { before?.(); return brokerOrderFrom(intentFrom(r, "COMPLETE", r.quantity)); },
    cancelOrder: async () => undefined,
    getOrder: async () => undefined,
    // Deliberately absent at the broker: a CREATED row is EXPECTED to be missing.
    listOrders: async () => [],
    listPositions: async () => [],
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (i, s) => ({ ...clone(s), client_order_id: i.client_order_id }),
  };
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter, persistence: journal, limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ }, istDayKey: () => "2026-09-15", brokerAccount: () => "ZD1234",
  });
  manager.seedLimits({ tradingDay: "2026-09-15" });
  manager.setFeedHealthy(true);
  await manager.reconcile();

  assert.equal(manager.status().unattendedWorkingOrders, 0, "CREATED is not a live broker order");
});


/* ══════════════════ W5. authorisation must be re-checked AT the POST boundary ══════════════════ */

test("W5: an entry admitted before a disarm is refused at the POST boundary, and never reaches the broker", async () => {
  /*
   * THE DEFECT THIS PINS. Session authorisation was checked only at ADMISSION. Between admission and
   * transmit an attempt sits in the priority queue and behind broker pacing — a real window, not a
   * theoretical one. Disarming the session in that window changed the session record and nothing
   * re-read it, so a one-attempt session that the operator had explicitly stopped still sent all four
   * orders. "I pressed stop and it kept trading" is the failure.
   *
   * The check must NOT be a budget re-check: an admitted attempt has legitimately spent its
   * allowance and would otherwise reject itself for that reason.
   */
  const posts = [];
  const adapter = {
    mode: "live", orders: new Map(),
    prepareOrder: (r) => ({ ...r, tag: `TAG${r.role}` }),
    submitOrder: async (r, before) => {
      // `before` is the manager's final pre-POST guard. Recording AFTER it means `posts` contains
      // only orders that genuinely crossed the boundary.
      before?.();
      posts.push(r.client_order_id);
      return brokerOrderFrom(intentFrom(r, "COMPLETE", r.quantity));
    },
    cancelOrder: async () => undefined,
    getOrder: async () => undefined,
    listOrders: async () => [],
    listPositions: async () => [],
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (i, s) => ({ ...clone(s), client_order_id: i.client_order_id }),
  };

  // A minimal stand-in for the engine's wiring: authorised while `armed` is true.
  let armed = true;
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter, persistence: new Journal(), limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ }, istDayKey: () => "2026-09-15", brokerAccount: () => "ZD1234",
    entryAuthorizationBlockReason: () => (armed
      ? null
      : "the trading session was DISARMED after this entry was admitted; no further entry order may be sent"),
  });
  manager.seedLimits({ tradingDay: "2026-09-15" });
  manager.setFeedHealthy(true);
  await manager.reconcile();

  // While armed, entry flows — the non-vacuous half.
  const ok = await manager.submit(request({ role: "k1_ce", attempt_id: "armed" }));
  assert.equal(ok.state, "COMPLETE");
  assert.equal(posts.length, 1, "an authorised entry posts");

  // Operator disarms. The next leg of the SAME admitted attempt must not reach the broker.
  armed = false;
  await assert.rejects(
    () => manager.submit(request({ role: "k2_ce", attempt_id: "armed" })),
    /DISARMED after this entry was admitted/,
    "the refusal names the disarm, not a generic gate",
  );
  assert.equal(posts.length, 1, "NOTHING further reached the broker after the disarm");
});

test("W6: a REDUCTION is never refused by the entry-authorisation hook", async () => {
  // The hook is entry-only by construction. A disarmed session must still be able to get flat —
  // otherwise stopping trading would strand exposure, which is the opposite of what stop means.
  const posts = [];
  const adapter = {
    mode: "live", orders: new Map(),
    prepareOrder: (r) => ({ ...r, tag: `TAG${r.role}` }),
    submitOrder: async (r, before) => {
      before?.();
      posts.push({ id: r.client_order_id, purpose: r.purpose });
      return brokerOrderFrom(intentFrom(r, "COMPLETE", r.quantity));
    },
    cancelOrder: async () => undefined,
    getOrder: async () => undefined,
    listOrders: async () => [],
    listPositions: async () => [],
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (i, s) => ({ ...clone(s), client_order_id: i.client_order_id }),
  };
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter, persistence: new Journal(), limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ }, istDayKey: () => "2026-09-15", brokerAccount: () => "ZD1234",
    // Refuses EVERYTHING it is asked about. It must never be asked about a reduction.
    entryAuthorizationBlockReason: () => "session disarmed",
  });
  manager.seedLimits({ tradingDay: "2026-09-15" });
  manager.setFeedHealthy(true);
  // Reconcile on a clean broker BEFORE seeding attributed exposure, so entry is not blocked by an
  // unrelated readiness gate and the authorisation hook is genuinely the thing that refuses it.
  await manager.reconcile();
  manager.setAttributedBoxPositions([{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }]);

  const exit = await manager.submit(request({ purpose: "EXIT", role: "k1_ce", side: "SELL", quantity: 75 }));
  assert.equal(exit.state, "COMPLETE", "the EXIT reached the broker despite a disarmed session");
  assert.deepEqual(posts.map((p) => p.purpose), ["EXIT"]);

  // ...and ENTRY under the same manager IS refused, so the hook is genuinely wired.
  await assert.rejects(
    () => manager.submit(request({ role: "k2_ce", attempt_id: "blocked" })),
    /session disarmed/,
  );
});


/* ══════════════════ W7. a mid-reconcile fill must not resurrect closed exposure ══════════════════ */

test("W7: a fill committed DURING reconciliation is not overwritten by the stale rebuild", async () => {
  /*
   * THE DEFECT THIS PINS. `performReconcile` loads its journal snapshot, awaits `listOrders()` and
   * `listPositions()`, and then rebuilds `attributedBoxPositions` ABSOLUTELY from that snapshot:
   *
   *     for (const symbol of ownedSymbols) {
   *       this.attributedBoxPositions.set(symbol, intentNetBySymbol.get(symbol) ?? 0);
   *     }
   *
   * An exit that commits during those awaits applies its delta incrementally to the SAME map, and the
   * rebuild then overwrites it with the pre-exit value. The sequence:
   *
   *     actual long 75  →  reconcile starts  →  an EXIT sells 75 (actual now 0)
   *                     →  reconcile restores internal exposure to long 75
   *                     →  another "reduction" sells 75  →  actual is now SHORT 75.
   *
   * The circuit breaker is no defence: reduction admission reads this same map and stays permitted
   * while the breaker is open, so the corrupted map authorises the over-reduction directly.
   *
   * The fix keeps the NEWER incremental value and discards the obsolete rebuild, then reports
   * reconciliation INCOMPLETE so the next pass reconciles fresh. It self-heals; it does not trip a
   * breaker that would need an operator to clear.
   */
  const entry = intentFrom(request({ role: "k1_ce", side: "BUY" }), "COMPLETE", 75);
  const journal = new Journal([entry]);
  let midReconcile = null;
  const adapter = {
    mode: "live", orders: new Map([[entry.client_order_id, brokerOrderFrom(entry)]]),
    prepareOrder: (r) => ({ ...r, tag: `TAG${r.role}` }),
    submitOrder: async (r, before) => { before?.(); return brokerOrderFrom(intentFrom(r, "COMPLETE", r.quantity)); },
    cancelOrder: async () => undefined,
    getOrder: async (id) => (adapter.orders.has(id) ? clone(adapter.orders.get(id)) : undefined),
    listOrders: async () => {
      // INSIDE the reconcile's awaits: the exit completes and is committed durably.
      await midReconcile?.();
      return [...adapter.orders.values()].map(clone);
    },
    listPositions: async () => [],
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (i, s) => ({ ...clone(s), client_order_id: i.client_order_id }),
  };
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter, persistence: journal, limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ }, istDayKey: () => "2026-09-15", brokerAccount: () => "ZD1234",
  });
  manager.seedLimits({ tradingDay: "2026-09-15" });
  manager.setFeedHealthy(true);
  manager.setAttributedBoxPositions([{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }]);

  /*
   * The concurrent exit runs through the REAL submit path while the reconcile is parked inside its
   * broker await. That is what makes this a faithful reproduction rather than a mock of one: the exit
   * commits durably through `persistOrder`, which both advances the journal row and applies the
   * incremental attribution — leaving the reconcile holding a snapshot that is genuinely obsolete.
   */
  midReconcile = async () => {
    midReconcile = null;
    await manager.submit(
      request({ purpose: "EXIT", role: "k1_ce", side: "SELL", quantity: 75, attempt_id: "x1" }),
    );
  };

  await manager.reconcile().catch(() => undefined);

  const status = manager.status();
  assert.equal(
    status.staleReconcilePasses,
    1,
    "the pass detected that its snapshot had been overtaken and discarded the rebuild",
  );
  assert.equal(
    status.health.reconciliation_complete,
    false,
    "a stale pass must NOT certify reconciliation complete",
  );
  assert.equal(
    status.safeAttributedReductionReady,
    false,
    "nor may it certify that the full durable quantity is provably reducible",
  );
  // And the safety property that matters: reduction is still POSSIBLE (never stranded)...
  assert.equal(manager.exposureReductionBlockReason(), null, "reduction is not stranded by a stale pass");
  // ...but a further sell of a position that is already flat is refused on the CURRENT exposure.
  await assert.rejects(
    () => manager.submit(request({ purpose: "EXIT", role: "k1_ce", side: "SELL", quantity: 75, attempt_id: "x2" })),
    /would not reduce the attributed net position \(0\)/,
    "the phantom long is gone, so it cannot authorise selling through flat into a reverse position",
  );
});
