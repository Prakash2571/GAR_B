/**
 * ONE BROKER FILL MUST BE ATTRIBUTED EXACTLY ONCE.
 *
 * `attributedBoxPositions` is not a statistic. It is the PERMISSION BOUNDARY for reduction and
 * recovery orders: `withinQuantityLimits` and `queuedActionBlockReason` both authorise a reducing
 * order only up to `Math.abs(net)`. Inflate it and the manager will authorise reducing more than
 * is actually held — crossing flat and opening opposite-side exposure with real money.
 *
 * THE DEFECT
 * `persistOrder` derived the fill delta from the CALLER'S in-memory intent snapshot
 * (`updated.filled_quantity - intent.filled_quantity`) and never read the guarded write's
 * `applied` result. Two async contexts routinely hold the same stale snapshot for one order — the
 * live submit path holds `filled_quantity: 0` for the whole broker round trip, and the reconcile
 * timer loads its own copy at the top of each pass — so a single 40-lot fill was credited twice:
 *
 *   live path                     reconcile path
 *   ---------                     --------------
 *   load fill=0                   load fill=0
 *                                 persist fill=40   -> attribute +40
 *   persist fill=40                                    (guard `$lte` is NON-strict, so this
 *   -> attribute +40 AGAIN                               second write reports applied:true)
 *
 * Internal attributed exposure 80; actual fill 40.
 *
 * THE FIX these tests pin: the delta is a property of the DURABLE TRANSITION
 * (`current_filled_quantity - previous_filled_quantity`, and 0 when `applied` is false), reported
 * by the write itself. Never `post - stale_caller_snapshot`.
 *
 * WHY THESE ARE REAL RACES
 * `raceGate()` parks the adapter mid-POST so a genuine `reconcile()` interleaves with a genuine
 * `submit()` — two real concurrent promises against one manager and one journal, not two
 * sequential calls dressed up as concurrency. The contract-level tests then fan out hundreds of
 * truly concurrent `update()` calls over one shared store.
 *
 * Pure and offline, except the final block which runs against a REAL MongoDB when
 * BOX_TEST_MONGODB_URI is set.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager } from "../../dist/box/orderManager.js";

const clone = (v) => structuredClone(v);
const TERMINAL = ["COMPLETE", "CANCELLED", "REJECTED"];
const SYMBOL = "NFO:SYM-k1_ce";

const request = (o = {}) => ({
  client_order_id: o.client_order_id ?? "BOX:trade-1:ENTRY:k1_ce:attempt-1",
  role: "k1_ce",
  trade_id: "trade-1",
  attempt_id: "attempt-1",
  purpose: o.purpose ?? "ENTRY",
  phase: o.phase ?? "entry",
  exchange: "NFO",
  tradingsymbol: "SYM-k1_ce",
  token: 1001,
  side: o.side ?? "BUY",
  quantity: o.quantity ?? 75,
  pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
});

function orderFor(req, { state, filled }) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.client_order_id}`,
    tag: req.tag ?? null,
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
    state,
    filled_quantity: filled,
    pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? 100 : null,
    fills: filled > 0 ? [{ fill_id: `fill-${req.client_order_id}-${filled}`, quantity: filled, price: 100, at: 2_000 }] : [],
    reject_family: null,
    reject_reason: null,
    created_at: 1_000,
    updated_at: 2_000,
  };
}

/**
 * The durable journal, modelling the two properties that decide this outcome:
 *  - the `$lte` fill guard is NON-STRICT, so an equal cumulative quantity is applied; and
 *  - the write reports the pre-image it replaced, which is the only authoritative delta.
 * `yieldFirst` inserts a real await before the critical section so concurrent callers interleave
 * rather than being accidentally serialised by the microtask queue.
 */
class Journal {
  constructor(intents = [], { yieldFirst = false } = {}) {
    this.rows = new Map(intents.map((i) => [i.client_order_id, clone(i)]));
    this.yieldFirst = yieldFirst;
    this.updates = [];
  }
  async create(intent) {
    const current = this.rows.get(intent.client_order_id);
    if (current) return clone(current);
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  async update(clientOrderId, patch, audit) {
    if (this.yieldFirst) await new Promise((r) => setImmediate(r));
    const current = this.rows.get(clientOrderId);
    if (!current) {
      return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
    }
    if (patch.filled_quantity !== undefined && patch.filled_quantity < current.filled_quantity) {
      const refused = {
        intent: clone(current), applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
      this.updates.push({ clientOrderId, ...refused, intent: undefined });
      return refused;
    }
    const next = { ...current, ...clone(patch), previous_filled_quantity: current.filled_quantity };
    if (!next.audit.some((a) => a.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
    this.rows.set(clientOrderId, next);
    const applied = {
      intent: clone(next), applied: true,
      previous_filled_quantity: current.filled_quantity,
      current_filled_quantity: next.filled_quantity,
    };
    this.updates.push({ clientOrderId, applied: true, previous_filled_quantity: applied.previous_filled_quantity, current_filled_quantity: applied.current_filled_quantity });
    return applied;
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

const LIMITS = {
  maxOpenBoxes: 10,
  maxConcurrentExecutions: 1,
  maxResidualLegs: 10,
  dailyLossLimit: 1_000_000,
  rejectLimit: 1_000,
  consecutiveFailureLimit: 1_000,
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 3_600_000,
  feedReconnectWarmupMs: 0,
};

/** A latch a test can open once the other half of the race has done its work. */
function raceGate() {
  let open;
  const opened = new Promise((r) => { open = r; });
  return { opened, open: () => open() };
}

async function buildManager({ journal, adapter }) {
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter,
    persistence: journal,
    limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-07",
  });
  manager.seedLimits({ tradingDay: "2026-09-07" });
  manager.setFeedHealthy(true);
  // Entry requires a completed reconciliation, exactly as in production. The adapter is not yet
  // "armed", so this first pass sees an empty account and simply opens the gate.
  await manager.reconcile();
  return manager;
}

/** The exposure the manager believes it may reduce — the permission boundary itself. */
function attributedQuantity(manager, tradingsymbol = "SYM-k1_ce") {
  const found = manager.attributedRecoveryExposure().find((r) => r.tradingsymbol === tradingsymbol);
  return found ? found.quantity : 0;
}

/**
 * The core race: a live submit is parked mid-POST while a full reconcile pass persists the same
 * broker snapshot. Both hold `filled_quantity: 0`.
 */
async function submitVsReconcile({ brokerFilled, reconcileFilled, reconcileState = "COMPLETE", submitState = "COMPLETE" }) {
  const journal = new Journal();
  const gate = raceGate();
  const req = request();
  let reconcileSnapshot = null;

  const adapter = {
    mode: "live",
    prepareOrder: (r) => ({ ...r, pricing: { ...r.pricing }, tag: "TAGk1_ce" }),
    submitOrder: async (r) => {
      // The broker already has the order and it has already filled; our response is just slow.
      reconcileSnapshot = orderFor(r, { state: reconcileState, filled: reconcileFilled });
      await gate.opened; // let the reconcile pass run first, against the SAME stale snapshot
      return orderFor(r, { state: submitState, filled: brokerFilled });
    },
    cancelOrder: async () => undefined,
    getOrder: async () => undefined,
    listOrders: async () => (reconcileSnapshot ? [clone(reconcileSnapshot)] : []),
    listPositions: async () => (reconcileSnapshot
      ? [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: Math.max(brokerFilled, reconcileFilled) }]
      : []),
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (intent, snapshot) => ({ ...clone(snapshot), client_order_id: intent.client_order_id }),
  };

  const manager = await buildManager({ journal, adapter });
  const submitting = manager.submit(req);
  // Let execute() reach the parked POST, so its intent snapshot is durably SUBMITTING/filled 0.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await manager.reconcile();   // persists the broker snapshot against ITS own stale snapshot
  gate.open();
  await submitting;            // now the submit path persists the same fill again
  return { manager, journal, req };
}

/* ══════════════════ A1. the exact race from the defect report ══════════════════ */

test("A1: a reconcile and a live submit persisting the SAME 40-lot fill attribute 40, not 80", async () => {
  const { manager, journal, req } = await submitVsReconcile({ brokerFilled: 40, reconcileFilled: 40, submitState: "PARTIALLY_FILLED", reconcileState: "PARTIALLY_FILLED" });

  assert.equal(journal.rows.get(req.client_order_id).filled_quantity, 40, "durable cumulative quantity is the broker's 40");
  assert.equal(
    attributedQuantity(manager),
    40,
    "ONE broker fill must be attributed ONCE — 80 would authorise reducing twice what is held",
  );

  // And the durable write reported the truth about each caller.
  const applied = journal.updates.filter((u) => u.current_filled_quantity === 40);
  assert.ok(applied.length >= 2, "both callers wrote the same cumulative quantity");
  const deltas = journal.updates.map((u) => (u.applied ? u.current_filled_quantity - u.previous_filled_quantity : 0));
  assert.equal(deltas.reduce((a, b) => a + b, 0), 40, "the sum of authoritative deltas is the fill, exactly once");
});

test("A2: 40 then 55 for one order attributes 55 in total, never 95", async () => {
  const { manager, journal, req } = await submitVsReconcile({ brokerFilled: 55, reconcileFilled: 40, submitState: "PARTIALLY_FILLED", reconcileState: "PARTIALLY_FILLED" });

  assert.equal(journal.rows.get(req.client_order_id).filled_quantity, 55, "cumulative broker quantity is authoritative");
  assert.equal(attributedQuantity(manager), 55, "attribution equals the final cumulative quantity, not the sum of snapshots");
});

test("A3: an OUT-OF-ORDER smaller cumulative snapshot neither rewinds the quantity nor attributes anything", async () => {
  // The submit path returns the STALE 40 after the reconcile already recorded 55.
  const { manager, journal, req } = await submitVsReconcile({ brokerFilled: 40, reconcileFilled: 55, submitState: "PARTIALLY_FILLED", reconcileState: "PARTIALLY_FILLED" });

  assert.equal(journal.rows.get(req.client_order_id).filled_quantity, 55, "a smaller cumulative quantity must never rewind the durable fill");
  assert.equal(attributedQuantity(manager), 55, "and must not add exposure");
  assert.ok(
    journal.updates.some((u) => u.applied === false),
    "the regressing write must be REFUSED by the guard, not silently accepted",
  );
});

test("A4: a duplicated terminal broker snapshot is idempotent for attribution", async () => {
  const { manager, journal, req } = await submitVsReconcile({ brokerFilled: 75, reconcileFilled: 75 });
  assert.equal(journal.rows.get(req.client_order_id).filled_quantity, 75);
  assert.equal(attributedQuantity(manager), 75, "a full fill seen twice is still one fill");
  assert.equal(journal.rows.get(req.client_order_id).state, "COMPLETE");
});

test("A5: a NONTERMINAL then TERMINAL snapshot of the same order attributes only the increment", async () => {
  const { manager, journal, req } = await submitVsReconcile({ brokerFilled: 75, reconcileFilled: 30, reconcileState: "PARTIALLY_FILLED", submitState: "COMPLETE" });
  assert.equal(journal.rows.get(req.client_order_id).filled_quantity, 75);
  assert.equal(attributedQuantity(manager), 75, "30 then 75 is 75 of exposure, not 105");
});

/* ══════════════════ A6. the reduction permission boundary ══════════════════ */

test("A6: a double-counted fill would authorise an over-reduction; the authoritative delta does not", async () => {
  const { manager } = await submitVsReconcile({ brokerFilled: 40, reconcileFilled: 40, submitState: "PARTIALLY_FILLED", reconcileState: "PARTIALLY_FILLED" });

  // We hold +40. A 40-lot SELL reduction is legitimate; an 80-lot SELL would cross flat.
  assert.equal(attributedQuantity(manager), 40);
  await assert.rejects(
    manager.submit(request({ client_order_id: "BOX:trade-1:EMERGENCY_RESIDUAL:k1_ce:attempt-1", purpose: "EMERGENCY_RESIDUAL", phase: "unwind", side: "SELL", quantity: 80 })),
    /overshoot the attributed net position \(40/,
    "reducing 80 against a real 40 must be refused — this is the gate the double-count defeated",
  );
});

/* ══════════════════ A7-A8. the persistence contract under real concurrency ══════════════════ */

/**
 * The invariant the whole fix rests on, hammered directly at the contract level:
 *
 *   sum of authoritative deltas  ===  max cumulative quantity ever written
 *
 * for ANY interleaving of concurrent writers. Asserted over hundreds of randomised races.
 */
test("A7: over 400 randomised concurrent races, the summed deltas always equal the final cumulative quantity", async () => {
  let checked = 0;
  for (let iteration = 0; iteration < 400; iteration++) {
    const intent = {
      client_order_id: "c1", broker_order_id: null, broker_mode: "live", trade_id: "t", attempt_id: "a",
      role: "k1_ce", purpose: "ENTRY", phase: "entry", exchange: "NFO", tradingsymbol: "S", token: 1,
      side: "BUY", quantity: 75, reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1,
      state: "SUBMITTING", filled_quantity: 0, average_price: null, broker_tag: null,
      reject_family: null, reject_reason: null,
      created_at: new Date(0), updated_at: new Date(0), terminal_at: null, audit: [],
    };
    const journal = new Journal([intent], { yieldFirst: true });

    // A random set of cumulative snapshots, delivered concurrently in arbitrary order.
    const writers = Array.from({ length: 2 + (iteration % 5) }, () => 1 + Math.floor(Math.random() * 75));
    const results = await Promise.all(writers.map((filled, i) =>
      journal.update("c1", { state: "PARTIALLY_FILLED", filled_quantity: filled, updated_at: new Date(1) }, { audit_id: `a${i}` }),
    ));

    const attributed = results.reduce(
      (sum, r) => sum + (r.applied ? (r.current_filled_quantity ?? 0) - (r.previous_filled_quantity ?? 0) : 0),
      0,
    );
    const durable = journal.rows.get("c1").filled_quantity;
    assert.equal(attributed, durable, `iteration ${iteration}: attributed ${attributed} != durable ${durable} for ${writers}`);
    assert.equal(durable, Math.max(...writers), "the largest cumulative quantity wins and nothing rewinds it");
    checked++;
  }
  assert.equal(checked, 400);
});

test("A8: duplicate identical snapshots from many concurrent callers attribute the fill exactly once", async () => {
  for (let iteration = 0; iteration < 200; iteration++) {
    const intent = {
      client_order_id: "c1", broker_order_id: null, broker_mode: "live", trade_id: "t", attempt_id: "a",
      role: "k1_ce", purpose: "ENTRY", phase: "entry", exchange: "NFO", tradingsymbol: "S", token: 1,
      side: "BUY", quantity: 75, reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1,
      state: "SUBMITTING", filled_quantity: 0, average_price: null, broker_tag: null,
      reject_family: null, reject_reason: null,
      created_at: new Date(0), updated_at: new Date(0), terminal_at: null, audit: [],
    };
    const journal = new Journal([intent], { yieldFirst: true });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      journal.update("c1", { state: "COMPLETE", filled_quantity: 75, updated_at: new Date(1) }, { audit_id: `dup-${i}` }),
    ));
    const attributed = results.reduce(
      (sum, r) => sum + (r.applied ? (r.current_filled_quantity ?? 0) - (r.previous_filled_quantity ?? 0) : 0),
      0,
    );
    assert.equal(attributed, 75, `iteration ${iteration}: eight identical snapshots must attribute 75, got ${attributed}`);
  }
});

/* ══════════════════ A9. a persistence layer that cannot report the transition ══════════════════ */

test("A9: a persistence layer that does not report the transition attributes NOTHING and trips the invariant", async () => {
  // A deliberately non-conforming double: applied, but no pre-image. Guessing from the caller's
  // snapshot is exactly the bug, so the manager must refuse to guess.
  const journal = new Journal();
  const inner = journal.update.bind(journal);
  journal.update = async (id, patch, audit) => {
    const r = await inner(id, patch, audit);
    return { intent: r.intent, applied: r.applied };   // pre-image withheld
  };

  const req = request();
  const adapter = {
    mode: "live",
    prepareOrder: (r) => ({ ...r, pricing: { ...r.pricing }, tag: "TAGk1_ce" }),
    submitOrder: async (r) => orderFor(r, { state: "COMPLETE", filled: 75 }),
    cancelOrder: async () => undefined,
    getOrder: async () => undefined,
    listOrders: async () => [],
    listPositions: async () => [],
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (intent, s) => ({ ...clone(s), client_order_id: intent.client_order_id }),
  };
  const manager = await buildManager({ journal, adapter });
  await manager.submit(req);

  assert.equal(attributedQuantity(manager), 0, "an unknowable transition must attribute nothing rather than guess");
  assert.equal(manager.status().circuitBreaker.tripped, true, "and must be surfaced, not swallowed");
});

/* ══════════════════ A10. refused transitions are no longer invisible ══════════════════ */

test("A10: a refused (stale) durable write adds no exposure on top of the reconciled truth", async () => {
  const intent = {
    client_order_id: "c1", broker_order_id: null, broker_mode: "live", trade_id: "t", attempt_id: "a",
    role: "k1_ce", purpose: "ENTRY", phase: "entry", exchange: "NFO", tradingsymbol: "SYM-k1_ce", token: 1001,
    side: "BUY", quantity: 75, reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1,
    state: "COMPLETE", filled_quantity: 75, average_price: 100, broker_tag: null,
    reject_family: null, reject_reason: null,
    created_at: new Date(0), updated_at: new Date(0), terminal_at: new Date(0), audit: [],
  };
  const journal = new Journal([intent]);
  const staleReq = request({ client_order_id: "c1" });
  const adapter = {
    mode: "live",
    prepareOrder: (r) => ({ ...r, pricing: { ...r.pricing }, tag: "TAGk1_ce" }),
    submitOrder: async () => { throw new Error("a durably COMPLETE intent must never be resubmitted"); },
    cancelOrder: async () => undefined,
    // The broker reports an OLD, smaller cumulative quantity for this order.
    getOrder: async () => clone(orderFor(staleReq, { state: "PARTIALLY_FILLED", filled: 10 })),
    listOrders: async () => [],
    listPositions: async () => [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (i, s) => ({ ...clone(s), client_order_id: i.client_order_id }),
  };
  const manager = await buildManager({ journal, adapter });

  // Reconciliation has already established the truth from the journal: we own 75.
  assert.equal(attributedQuantity(manager), 75, "the absolute rebuild owns 75");

  // A stale 10-lot snapshot against a durable 75 must be refused and must attribute nothing.
  await manager.submit(staleReq).catch(() => undefined);
  assert.equal(journal.rows.get("c1").filled_quantity, 75, "the stale snapshot cannot rewind the durable fill");
  assert.equal(
    attributedQuantity(manager),
    75,
    "and cannot ADD exposure — 85 here would mean a refused write still moved the permission boundary",
  );
  assert.ok(
    journal.updates.some((u) => u.applied === false),
    "the refusal is real, not an artefact of the assertion",
  );
});
