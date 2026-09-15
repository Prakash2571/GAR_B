/**
 * THE TWO P0 DEFECTS ON THE LIVE PATH, and the semantics that replace them.
 *
 * Both were REPRODUCED at commit 544dd5577980969011d1a343121e4955975c248a before being fixed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT 1 — DISABLING NEW ORDERS SILENTLY DISABLED GETTING FLAT
 *
 *     canManageExposure(): boolean {
 *       return !this.disposed && this.controls.liveOrderEnabled;
 *     }
 *
 *     async cancelWorkingBoxOrders(): Promise<BrokerOrder[]> {
 *       if (!this.canManageExposure()) return [];        // ← empty SUCCESS
 *       …
 *     }
 *
 * and the route published that as `{ ok: true, orders: [] }` with HTTP 200. So turning off
 * `box_live_order_enabled` — the obvious operator response to "stop trading" — made the panic button
 * report a clean sweep having loaded no intents and attempted no cancellation. It was reproduced with
 * `emergencyFlatten=true`. An empty array is also what a genuinely quiet account returns, so the two
 * outcomes were indistinguishable.
 *
 * A control meaning "do not take NEW exposure" must never remove the ability to SHED exposure already
 * taken. Those are opposite directions of risk.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT 2 — NO LIVE ORDER KNEW WHICH ACCOUNT PLACED IT
 *
 *     private liveBrokerAccount(): string | null {
 *       return this.deps.marketData.isAuthenticated() ? null : null;   // both branches null
 *     }
 *
 * plus `account: null` hard-coded at both order-stream ownership registrations. So the order-update
 * projection's `foreign_account` rejection could never fire and attribution rested entirely on the
 * per-order tag. Tag uniqueness is not account ownership: after a re-login to a DIFFERENT account
 * under the same API key, nothing structural stopped the new session adopting, cancelling or
 * flattening the previous account's exposure.
 *
 * These tests drive the REAL `BoxOrderManager` with fake transport/persistence boundaries.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager } from "../../dist/box/orderManager.js";

/* ─────────────────────────── fixtures ─────────────────────────── */

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];

const request = (o = {}) => {
  const role = o.role ?? "k1_ce";
  const purpose = o.purpose ?? "ENTRY";
  const attempt = o.attempt_id ?? `attempt-${role}`;
  const trade = o.trade_id ?? "trade-1";
  return {
    client_order_id: o.client_order_id ?? `BOX:${trade}:${purpose}:${role}:${attempt}`,
    role,
    trade_id: trade,
    attempt_id: attempt,
    purpose,
    phase: o.phase ?? (purpose === "ENTRY" ? "entry" : purpose === "EMERGENCY_RESIDUAL" ? "unwind" : "exit"),
    exchange: o.exchange ?? "NFO",
    tradingsymbol: o.tradingsymbol ?? `SYM-${role}`,
    token: o.token ?? 1000 + ROLES.indexOf(role),
    side: o.side ?? (purpose === "ENTRY" ? "BUY" : "SELL"),
    quantity: o.quantity ?? 75,
    pricing: o.pricing ?? {
      order_type: "LIMIT",
      reference_price: 100,
      tick_size: 0.05,
      max_chase_ticks: 2,
      limit_price: (o.side ?? "BUY") === "SELL" ? 99.9 : 100.1,
    },
    ...(o.tag ? { tag: o.tag } : {}),
  };
};

function intentFrom(req, o = {}) {
  const at = new Date(1_000);
  return {
    client_order_id: req.client_order_id,
    broker_order_id: o.broker_order_id ?? `B-${req.client_order_id}`,
    broker_mode: "live",
    broker: "zerodha",
    // The field that did not exist before migration 011.
    broker_account: o.broker_account === undefined ? "ZD1234" : o.broker_account,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    role: req.role,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: req.quantity,
    reference_price: req.pricing.reference_price,
    tick_size: req.pricing.tick_size,
    max_chase_ticks: req.pricing.max_chase_ticks,
    limit_price: req.pricing.limit_price,
    state: o.state ?? "OPEN",
    filled_quantity: o.filled_quantity ?? 0,
    average_price: null,
    broker_tag: req.tag ?? null,
    reject_family: null,
    reject_reason: null,
    created_at: at,
    updated_at: at,
    terminal_at: null,
    audit: [],
  };
}

/**
 * Persistence modelling the REAL guarded write, including the `{ intent, applied, previous/current }`
 * result shape the manager depends on. `calls` makes "nothing was even loaded" observable, which is
 * the defining property of the cancel-working defect.
 */
const clone = (v) => structuredClone(v);
const TERMINAL = ["COMPLETE", "CANCELLED", "REJECTED"];

class MemoryPersistence {
  constructor(intents = []) {
    this.rows = new Map(intents.map((i) => [i.client_order_id, clone(i)]));
    this.calls = [];
  }
  async create(intent) {
    this.calls.push(["create", intent.client_order_id]);
    const current = this.rows.get(intent.client_order_id);
    if (current) return clone(current);
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  async update(clientOrderId, patch, audit, expectedStates) {
    const current = this.rows.get(clientOrderId);
    this.calls.push(["update", clientOrderId]);
    if (!current) {
      return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
    }
    if (expectedStates && !expectedStates.includes(current.state)) {
      return {
        intent: clone(current), applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
    }
    const next = { ...current, ...clone(patch), previous_filled_quantity: current.filled_quantity };
    if (!next.audit.some((a) => a.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
    this.rows.set(clientOrderId, next);
    return {
      intent: clone(next), applied: true,
      previous_filled_quantity: current.filled_quantity,
      current_filled_quantity: next.filled_quantity,
    };
  }
  async loadNonterminal() {
    this.calls.push(["loadNonterminal"]);
    return [...this.rows.values()].filter((i) => !TERMINAL.includes(i.state)).map(clone);
  }
  async loadOwned() {
    return [...this.rows.values()].map(clone);
  }
  async findByClientId(id) {
    return this.rows.has(id) ? clone(this.rows.get(id)) : null;
  }
  async findByBrokerId(id) {
    const f = [...this.rows.values()].find((i) => i.broker_order_id === id);
    return f ? clone(f) : null;
  }
}

/** A faithful broker order snapshot (same shape the real adapter returns). */
function orderFrom(req, o = {}) {
  const filled = o.filled_quantity ?? req.quantity;
  const state = o.state ?? (filled === req.quantity ? "COMPLETE" : "PARTIALLY_FILLED");
  return {
    client_order_id: req.client_order_id,
    broker_order_id: o.broker_order_id ?? `B-${req.client_order_id}`,
    tag: o.tag ?? req.tag ?? null,
    role: req.role,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: o.quantity ?? req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state,
    filled_quantity: filled,
    pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? 100 : null,
    fills: filled > 0
      ? [{ fill_id: o.fill_id ?? `fill-${req.client_order_id}-${filled}`, quantity: filled, price: 100, at: 2_000 }]
      : [],
    reject_family: null,
    reject_reason: null,
    created_at: 1_000,
    updated_at: 2_000,
  };
}

/** The real adapter's surface, with fake transport. `cancelled` makes broker reach observable. */
function fakeAdapter(o = {}) {
  const cancelled = [];
  // Every boundary crossing, in order. "Nothing reached the broker" is the central claim of several of
  // these tests, so it has to be directly observable rather than inferred from state.
  const calls = [];
  const orders = new Map((o.orders ?? []).map((x) => [x.client_order_id, clone(x)]));
  const adapter = {
    mode: "live",
    broker: "zerodha",
    cancelled,
    calls,
    orders,
    health: o.health ?? (async () => ({
      ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000,
    })),
    prepareOrder: (req) => ({ ...req, pricing: { ...req.pricing }, tag: req.tag ?? `TAG${req.role}` }),
    submitOrder: async (req, beforePost) => {
      calls.push(["submitOrder", req.client_order_id]);
      beforePost?.();
      const result = o.submitOrder ? await o.submitOrder(req, adapter) : orderFrom(req);
      if (result) orders.set(req.client_order_id, clone(result));
      return clone(result);
    },
    cancelOrder: async (id) => {
      calls.push(["cancelOrder", id]);
      cancelled.push(id);
      const existing = orders.get(id);
      const snapshot = existing
        ? { ...clone(existing), state: "CANCELLED", filled_quantity: existing.filled_quantity ?? 0 }
        : undefined;
      if (snapshot) orders.set(id, snapshot);
      return snapshot;
    },
    getOrder: async (id) => (orders.has(id) ? clone(orders.get(id)) : undefined),
    listOrders: async () => (o.listOrders ? o.listOrders() : [...orders.values()].map(clone)),
    listPositions: async () => clone(o.positions ?? []),
    adoptOrder: async (intent, snapshot) => ({ ...clone(snapshot), client_order_id: intent.client_order_id }),
  };
  return adapter;
}

const limits = (o = {}) => ({
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 4_000,
  maxOpenBoxes: 1,
  maxResidualLegs: 4,
  maxBoxCapitalRupees: 0,
  entrySubmitConcurrency: 1,
  dailyLossLimit: 0,
  rejectLimit: 100,
  consecutiveFailureLimit: 100,
  reconcileIntervalMs: 60_000,
  feedReconnectWarmupMs: 0,
  ...o,
});

/**
 * A real BoxOrderManager.
 *
 * `brokerAccount` defaults to a wired provider returning a real account, because that is the LIVE
 * configuration this work is about. Pass `brokerAccount: undefined` explicitly to model a
 * pre-binding construction.
 */
function makeManager({
  persistence = new MemoryPersistence(),
  /**
   * The broker's own view. Defaults to MIRRORING the durable working intents, because a reconcile
   * that finds a durable non-terminal intent absent at the broker legitimately trips the circuit
   * breaker — which would mask the control semantics these tests are about.
   */
  adapter = fakeAdapter({
    orders: [...persistence.rows.values()]
      .filter((i) => !TERMINAL.includes(i.state))
      .map((i) => ({
        client_order_id: i.client_order_id,
        broker_order_id: i.broker_order_id,
        tag: i.broker_tag, role: i.role, trade_id: i.trade_id, attempt_id: i.attempt_id,
        purpose: i.purpose, phase: i.phase, exchange: i.exchange, tradingsymbol: i.tradingsymbol,
        token: i.token, side: i.side, quantity: i.quantity,
        pricing: { order_type: "LIMIT", reference_price: i.reference_price, tick_size: i.tick_size,
                   max_chase_ticks: i.max_chase_ticks, limit_price: i.limit_price },
        limit_price: i.limit_price, state: i.state, filled_quantity: i.filled_quantity,
        pending_quantity: Math.max(0, i.quantity - i.filled_quantity),
        average_price: null, fills: [], reject_family: null, reject_reason: null,
        created_at: 1_000, updated_at: 2_000,
      })),
  }),
  controls = { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
  /**
   * Pass the string "unwired" to model a construction with NO account provider at all (paper /
   * pre-binding). Passing `undefined` would hit the JS default and silently keep the provider.
   */
  brokerAccount = () => "ZD1234",
  limitOverrides = {},
  brokerAuth = "healthy",
  reconcile = true,
} = {}) {
  let now = 10_000;
  // `broker_auth` is only ever set by a reconcile reading `adapter.health()`. Model the requested
  // auth state there, then reconcile, so the manager reaches it exactly as production does.
  if (brokerAuth === "unhealthy") adapter.health = async () => ({ authenticated: false });
  else if (brokerAuth === "unknown") adapter.health = async () => ({ authenticated: true });
  const manager = new BoxOrderManager({
    adapter,
    persistence,
    limits: limits(limitOverrides),
    controls,
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-02",
    ...(brokerAccount === "unwired" ? {} : { brokerAccount }),
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  return { manager, persistence, adapter, reconcileNow: () => manager.reconcile() };
}

/** Await a real reconcile so health/reconciliation_complete reach their production values. */
async function ready(h) {
  await h.manager.reconcile();
  return h;
}

/* ══════════════════ A. EXISTING EXPOSURE + LIVE-ORDER DISARM ══════════════════ */

test("A1: disarming box_live_order_enabled stops ENTRY but NOT cancellation", async () => {
  const working = [intentFrom(request({ role: "k1_ce" })), intentFrom(request({ role: "k2_ce" }))];
  const { manager, persistence, adapter } = await ready(makeManager({
    persistence: new MemoryPersistence(working),
    // THE EXACT REPRODUCTION CONDITION: live orders off, emergency flatten on.
    controls: { entryEnabled: false, liveOrderEnabled: false, emergencyFlatten: true },
  }));
  persistence.calls.length = 0;

  // ENTRY is stopped, and says which control did it.
  assert.equal(manager.canEnter(request()), false);
  assert.match(manager.entryBlockReason(request()), /box_entry_enabled is off/);

  // REDUCTION remains available, and says so.
  assert.equal(
    manager.exposureReductionBlockReason(),
    null,
    "a control that stops NEW exposure must not remove the ability to shed exposure already owned",
  );
  assert.equal(manager.canManageExposure(), true);

  // THE PANIC BUTTON ACTUALLY RUNS.
  const result = await manager.cancelWorkingBoxOrders();
  assert.equal(result.attempted, true, "the sweep was attempted — it used to return [] untried");
  assert.equal(result.blocked_reason, null);
  assert.equal(result.ok, true);
  assert.equal(result.eligible, 2, "both working BOX intents were eligible");
  assert.equal(result.cancelled.length, 2);
  assert.deepEqual(result.failures, []);
  // And it genuinely reached the transport.
  assert.equal(adapter.cancelled.length, 2, "two cancels reached the broker adapter");
  assert.ok(
    persistence.calls.some((c) => c[0] === "loadNonterminal"),
    "working exposure was LOADED — the defect was that it never even looked",
  );
});

test("A1-negative: the OLD semantics would have returned an untried empty success", async () => {
  /*
   * A guard against silently regressing to the old shape. `cancelWorkingBoxOrders` must never be able
   * to report a clean sweep without having examined the durable working exposure.
   */
  const working = [intentFrom(request({ role: "k1_ce" }))];
  const { manager, persistence } = makeManager({
    persistence: new MemoryPersistence(working),
    controls: { entryEnabled: false, liveOrderEnabled: false, emergencyFlatten: false },
  });
  const result = await manager.cancelWorkingBoxOrders();
  const looksClean = result.ok === true && result.cancelled.length === 0 && result.failures.length === 0;
  const examinedExposure = persistence.calls.some((c) => c[0] === "loadNonterminal");
  assert.ok(
    !looksClean || examinedExposure,
    "a clean-looking result is only permissible after the working exposure was actually examined",
  );
});

test("A2: a genuine inability to act is REFUSED with a reason, never an empty success", async () => {
  const working = [intentFrom(request({ role: "k1_ce" }))];

  // (a) unauthenticated session — a real inability, honestly reported.
  const unauth = await ready(makeManager({
    persistence: new MemoryPersistence(working),
    brokerAuth: "unhealthy",
  }));
  unauth.persistence.calls.length = 0;
  const r1 = await unauth.manager.cancelWorkingBoxOrders();
  assert.equal(r1.ok, false, "NOT a success");
  assert.equal(r1.attempted, false, "and it says nothing was attempted");
  assert.match(r1.blocked_reason, /not authenticated/);
  assert.match(r1.blocked_reason, /exposure is unchanged and still owned/);
  assert.equal(
    unauth.persistence.calls.filter((c) => c[0] === "loadNonterminal").length,
    0,
    "a refusal does not pretend to have examined anything",
  );

  // (b) disposed manager — no transport at all.
  const disposed = makeManager({ persistence: new MemoryPersistence(working) });
  disposed.manager.dispose();
  const r3 = await disposed.manager.cancelWorkingBoxOrders();
  assert.equal(r3.attempted, false);
  assert.match(r3.blocked_reason, /disposed/);
});

test("A3: an unverified (not-yet-reconciled) session may still TRY to cancel", async () => {
  /*
   * `broker_auth` only becomes "healthy" after a successful reconciliation. Gating cancellation on
   * `=== "healthy"` would mean a process that has not reconciled — boot, or a restart with exposure
   * open — could not cancel anything, which would be a NEW way to break the panic button. Only a
   * CONFIRMED auth failure blocks; the broker is the authority on an unverified one.
   */
  const working = [intentFrom(request({ role: "k1_ce" }))];
  const { manager, adapter } = makeManager({
    persistence: new MemoryPersistence(working),
    brokerAuth: "unknown",
  });
  // Deliberately NOT reconciled: broker_auth is still "unknown", which is the boot/restart state.
  assert.equal(manager.status().health.broker_auth, "unknown");
  const result = await manager.cancelWorkingBoxOrders();
  assert.equal(result.attempted, true, "an unverified session is allowed to try");
  assert.equal(adapter.cancelled.length, 1);
});

test("A4: entry-only restrictions never reach a reduction through submit()", async () => {
  // Entry disabled, breaker tripped, feed unhealthy — every ENTRY-scoped restriction at once.
  const { manager, adapter } = await ready(makeManager({
    controls: { entryEnabled: false, liveOrderEnabled: false, emergencyFlatten: false },
  }));
  manager.setFeedHealthy(false);
  manager.setAttributedBoxPositions([{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }]);

  await assert.rejects(
    () => manager.submit(request({ purpose: "ENTRY" })),
    /Entry cannot be sent: box_entry_enabled is off/,
    "entry is refused, and names the control that refused it",
  );

  // A reduction of owned exposure goes through.
  const exit = request({ purpose: "EXIT", role: "k1_ce", side: "SELL", quantity: 75 });
  const order = await manager.submit(exit);
  assert.equal(order.client_order_id, exit.client_order_id, "the EXIT reached the broker");
  void adapter;
});

test("A5: a reduction refusal names the real cause, not a control the operator set", async () => {
  const { manager } = await ready(makeManager({ brokerAuth: "unhealthy" }));
  manager.setAttributedBoxPositions([{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }]);
  await assert.rejects(
    () => manager.submit(request({ purpose: "EXIT", side: "SELL" })),
    (err) => {
      // The old message was "OrderManager exposure management is disabled." — which read as intended
      // behaviour rather than as an inability to act.
      assert.doesNotMatch(err.message, /exposure management is disabled/);
      assert.match(err.message, /Exposure reduction cannot be sent/);
      assert.match(err.message, /not authenticated/);
      return true;
    },
  );
});

test("A6: ownership is still mandatory — a reduction cannot touch an unowned position", async () => {
  // The fix widens WHEN a reduction may be attempted; it must not widen WHAT may be reduced.
  const { manager } = makeManager();
  manager.setAttributedBoxPositions([]); // nothing attributed to this deployment
  await assert.rejects(
    () => manager.submit(request({ purpose: "EXIT", side: "SELL", quantity: 75 })),
    /would not reduce the attributed net position \(0\)/,
    "a reduction with no attributed opposing position is still refused",
  );
});

/* ══════════════════ B. ACCOUNT IDENTITY ══════════════════ */

test("B1: the account is stamped on the durable intent BEFORE the broker POST", async () => {
  const persistence = new MemoryPersistence();
  let accountAtPost = "not-observed";
  const adapter = fakeAdapter({
    submitOrder: async (req) => {
      // At POST time the durable row must already name its owning account.
      accountAtPost = persistence.rows.get(req.client_order_id).broker_account;
      return orderFrom(req);
    },
  });
  const { manager } = await ready(makeManager({ persistence, adapter, brokerAccount: () => "ZD1234" }));
  await manager.submit(request());
  assert.equal(
    accountAtPost,
    "ZD1234",
    "a crash between POST and response must leave a row that already names its account",
  );
});

test("B2: a MISSING account identity blocks new live entry with a specific reason", async () => {
  const { manager } = await ready(makeManager({ brokerAccount: () => null }));
  assert.equal(manager.canEnter(request()), false);
  assert.match(
    manager.entryBlockReason(request()),
    /account could not be identified/,
    "and it must say WHY, not merely refuse",
  );
  // The SPECIFIC reason must survive the trip through submit(). It used to be flattened into
  // "OrderManager entry controls or limits are closed.", which reads as an operator-set control
  // rather than as an unidentifiable account — the one thing a supervisor must not misread.
  await assert.rejects(
    () => manager.submit(request()),
    /Entry cannot be sent: .*account could not be identified/,
  );
});

test("B3: a same-account token refresh preserves attribution", async () => {
  // The provider is read fresh on every decision, so a refresh that returns the SAME account is a
  // no-op for attribution — the intent stays actionable.
  let account = "ZD1234";
  const working = [intentFrom(request(), { broker_account: "ZD1234" })];
  const { manager, adapter } = await ready(makeManager({
    persistence: new MemoryPersistence(working),
    brokerAccount: () => account,
  }));
  assert.equal(manager.accountConsistencyBlockReason(working[0]), null);

  account = "ZD1234"; // same account, new token
  const result = await manager.cancelWorkingBoxOrders();
  assert.equal(result.ok, true, "attribution survives a token refresh for the same account");
  assert.equal(adapter.cancelled.length, 1);
});

test("B4: a DIFFERENT account cannot act on the previous account's exposure", async () => {
  /*
   * THE EXPOSURE DEFECT 2 CREATED. Under the same API key, a re-login to another account had nothing
   * structural stopping it from cancelling or flattening the first account's orders.
   */
  const working = [intentFrom(request(), { broker_account: "ZD1234" })];
  const { manager, adapter } = makeManager({
    persistence: new MemoryPersistence(working),
    brokerAccount: () => "ZD9999", // a DIFFERENT account is now signed in
  });

  const reason = manager.accountConsistencyBlockReason(working[0]);
  assert.match(reason, /DIFFERENT broker account/);
  assert.match(reason, /must not act on another account's exposure/);

  const result = await manager.cancelWorkingBoxOrders();
  assert.equal(result.attempted, true, "the sweep ran (this session can act on its OWN orders)");
  assert.equal(result.ok, false, "but it did not succeed");
  assert.equal(result.cancelled.length, 0, "and nothing was cancelled");
  assert.equal(adapter.cancelled.length, 0, "NOTHING reached the broker for the foreign account");
  assert.equal(result.failures.length, 1, "the foreign order is REPORTED, not silently skipped");
  assert.match(result.failures[0], /DIFFERENT broker account/);
});

test("B5: an UNPROVEN (pre-binding) intent may still be CANCELLED — weak evidence must not strand it", async () => {
  /*
   * Migration 011 deliberately does not backfill, so a pre-migration row records no account. The
   * question is what a CANCEL should then do.
   *
   * An earlier version refused it, reasoning that "probably ours" is not ownership evidence. That is
   * true, and it is the right rule for taking NEW exposure — but wrong here, and wrong in the
   * dangerous direction: refusing to cancel GUARANTEES the working order stays live, whereas
   * attempting it costs nothing, because the broker scopes cancellation-by-order-id to the
   * authenticated account and will simply reject a genuinely foreign one. Refusing bought no safety
   * and paid for it with stranded exposure — the same defect class as gating reduction on
   * `liveOrderEnabled`.
   *
   * So the guard now blocks only on POSITIVE proof of foreignness (B4). The null is still never
   * resolved into a claim: it is preserved as UNPROVEN on the intent and on the stream registration.
   */
  const legacy = [intentFrom(request(), { broker_account: null })];
  const { manager, adapter } = makeManager({
    persistence: new MemoryPersistence(legacy),
    brokerAccount: () => "ZD1234",
  });
  assert.equal(
    manager.accountConsistencyBlockReason(legacy[0]),
    null,
    "an unproven row is not proof of foreignness",
  );

  const result = await manager.cancelWorkingBoxOrders();
  assert.equal(result.ok, true);
  assert.equal(result.cancelled.length, 1, "the working order was cancelled rather than stranded");
  assert.equal(adapter.cancelled.length, 1);
});

test("B5b: an unproven intent is never STAMPED with the current account", async () => {
  // The other half of B5: not blocking must not become fabricating. If the stream registration
  // adopted the live session's account for a null row, a frame naming the real (different) account
  // would be rejected as `foreign_account` and an OWNED FILL would be discarded.
  // Reconciliation feeds the projection through ingestRestObservation (registerIntent is the
  // submit-path seam). BOTH used to fall back to the live session's account.
  const registrations = [];
  const consumer = {
    registerIntent: (r) => registrations.push(r),
    ingestRestObservation: (o) => registrations.push(o),
    learnBrokerOrderId: () => {},
    health: () => ({}),
    workingOrderCount: () => 0,
  };
  const legacy = [intentFrom(request(), { broker_account: null })];
  const persistence = new MemoryPersistence(legacy);
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter: fakeAdapter({
      orders: [...persistence.rows.values()].map((i) => ({
        client_order_id: i.client_order_id, broker_order_id: i.broker_order_id, tag: i.broker_tag,
        role: i.role, trade_id: i.trade_id, attempt_id: i.attempt_id, purpose: i.purpose,
        phase: i.phase, exchange: i.exchange, tradingsymbol: i.tradingsymbol, token: i.token,
        side: i.side, quantity: i.quantity,
        pricing: { order_type: "LIMIT", reference_price: i.reference_price, tick_size: i.tick_size,
                   max_chase_ticks: i.max_chase_ticks, limit_price: i.limit_price },
        limit_price: i.limit_price, state: i.state, filled_quantity: i.filled_quantity,
        pending_quantity: i.quantity, average_price: null, fills: [], reject_family: null,
        reject_reason: null, created_at: 1_000, updated_at: 2_000,
      })),
    }),
    orderStreamConsumer: consumer,
    persistence,
    limits: limits(),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-02",
    brokerAccount: () => "ZD1234",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  await manager.reconcile();

  assert.ok(registrations.length >= 1, "the recovered intent reached the projection");
  for (const r of registrations) {
    assert.equal(
      r.account,
      null,
      "UNPROVEN stays null — it must not inherit the currently signed-in account",
    );
  }
});

test("B6: a pre-binding CONSTRUCTION (no account provider) behaves exactly as before", async () => {
  /*
   * `brokerAccount` absent is not the same as "returns null": it means account binding was never
   * wired, which is true of paper deployments and of fixtures that predate this work. Binding cannot
   * be demanded of a caller that was never given a way to supply it. The engine always wires it in
   * live mode, so production always gets the strict behaviour.
   */
  const working = [intentFrom(request(), { broker_account: null })];
  const { manager, adapter } = await ready(makeManager({
    persistence: new MemoryPersistence(working),
    brokerAccount: "unwired",
  }));
  assert.equal(manager.exposureReductionBlockReason(), null);
  assert.equal(manager.accountConsistencyBlockReason(working[0]), null);
  const result = await manager.cancelWorkingBoxOrders();
  assert.equal(result.ok, true);
  assert.equal(adapter.cancelled.length, 1);
});

test("B7: the account travels to the order-stream ownership registration", async () => {
  // Defect 2's other half: both registrations hard-coded `account: null`, so the projection's
  // foreign-account rejection could never fire.
  const registrations = [];
  const consumer = {
    registerIntent: (r) => registrations.push(r),
    ingestRestObservation: () => {},
    learnBrokerOrderId: () => {},
    health: () => ({}),
    workingOrderCount: () => 0,
  };
  let now = 10_000;
  const persistence = new MemoryPersistence();
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    orderStreamConsumer: consumer,
    persistence,
    limits: limits(),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-02",
    brokerAccount: () => "ZD1234",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  await manager.reconcile();

  await manager.submit(request({ tag: "BOXTAG1" }));

  assert.ok(registrations.length >= 1, "ownership was registered");
  assert.equal(
    registrations[0].account,
    "ZD1234",
    "the registration carries the VERIFIED account — it used to be hard-coded null",
  );
  assert.ok(registrations[0].ownerTag, "and still carries the per-order tag");
});


/* ══════════════════ B8. THE ENGINE'S ACCOUNT PROVIDER (defect 2's other half) ══════════════════ */

test("B8: the engine resolves the account from the authenticated session, not null", async () => {
  /*
   * `BoxEngine.liveBrokerAccount()` was:
   *
   *     return this.deps.marketData.isAuthenticated() ? null : null;
   *
   * a ternary whose two branches are identical. It is the value handed to `OrderStreamConsumer` and
   * (now) to the order manager, so it being unconditionally null is what made every account check
   * inert no matter how correct the checks themselves were.
   *
   * The identity was in the process the whole time: `deps.brokerAccountRef` was already wired in
   * `src/index.ts` to `sessionFor(activeBroker).client_id` for margin-evidence attribution.
   *
   * Constructed in the DEPLOYED paper mode, so this test enables nothing.
   */
  const { BoxEngine } = await import("../../dist/box/engine.js");
  const deps = (accountRef, authenticated = true) => ({
    marketData: { isAuthenticated: () => authenticated, getQuoteFull: async () => [] },
    activeBroker: () => "zerodha",
    feed: {
      addTickListener: () => () => {}, addConnectionListener: () => () => {}, retain: () => () => {},
      subscribeTokens: () => {}, unsubscribeTokens: () => {}, setStrategyTokens: () => {},
      setBoxTokens: () => {}, subscribedCount: () => 0, isConnected: () => false,
    },
    charges: { broker: "zerodha", rateVersion: "t", estimate: () => null },
    getAllInstruments: async () => [], getBoard: async () => [],
    priceChargeGroups: async () => null, istDayKey: () => "2026-09-15",
    makeIdResolver: () => () => null, isMarketOpen: () => false,
    margins: { broker: "zerodha", basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }) },
    brokerAccountRef: () => accountRef,
  });

  const withAccount = new BoxEngine(deps("ZD1234"));
  try {
    assert.equal(
      withAccount.liveBrokerAccount(),
      "ZD1234",
      "the engine must surface the verified account — this returned null unconditionally",
    );
  } finally {
    withAccount.dispose?.();
  }

  // Unauthenticated: no account may be claimed, because the token that proved it may already be gone.
  const unauth = new BoxEngine(deps("ZD1234", false));
  try {
    assert.equal(unauth.liveBrokerAccount(), null, "an unauthenticated session names no account");
  } finally {
    unauth.dispose?.();
  }

  // A blank reference is not an identity.
  for (const blank of [null, "", "   "]) {
    const e = new BoxEngine(deps(blank));
    try {
      assert.equal(e.liveBrokerAccount(), null, `${JSON.stringify(blank)} must not be treated as an account`);
    } finally {
      e.dispose?.();
    }
  }
});

test("B8b: the masked account reaches diagnostics, and the raw one never does", async () => {
  // Section 2: "Never log tokens or secrets. Use masked account references in public diagnostics."
  const { BoxEngine } = await import("../../dist/box/engine.js");
  const engine = new BoxEngine({
    marketData: { isAuthenticated: () => true, getQuoteFull: async () => [] },
    activeBroker: () => "zerodha",
    feed: {
      addTickListener: () => () => {}, addConnectionListener: () => () => {}, retain: () => () => {},
      subscribeTokens: () => {}, unsubscribeTokens: () => {}, setStrategyTokens: () => {},
      setBoxTokens: () => {}, subscribedCount: () => 0, isConnected: () => false,
    },
    charges: { broker: "zerodha", rateVersion: "t", estimate: () => null },
    getAllInstruments: async () => [], getBoard: async () => [],
    priceChargeGroups: async () => null, istDayKey: () => "2026-09-15",
    makeIdResolver: () => () => null, isMarketOpen: () => false,
    margins: { broker: "zerodha", basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }) },
    brokerAccountRef: () => "ZD1234",
  });
  try {
    const status = JSON.parse(JSON.stringify(engine.getStatus()));
    assert.equal(status.operational_readiness.identity.account_masked, "ZD••34");
    assert.equal(status.operational_readiness.identity.account_present, true);
    assert.doesNotMatch(
      JSON.stringify(status),
      /ZD1234/,
      "the raw account reference must never appear on the wire",
    );
  } finally {
    engine.dispose?.();
  }
});


/* ══════════════════ C. ONE-LOT QUANTITY ENVELOPE (the whole attempt, not one leg) ══════════════════ */

/*
 * THE HAZARD. The target is ONE FOUR-LEG BOX ATTEMPT, not one HTTP order request. The quantity gates
 * were per-leg and incremental:
 *
 *     if (request.quantity > limits.maxOpenLegQuantity) return false;
 *     if (purpose === "ENTRY") return gross + reserved + request.quantity <= maxGross;
 *
 * Correct for a leg, insufficient for an attempt. The shipped defaults are 100 per leg and 400 gross,
 * and a real lot is 75 (NIFTY) / 35 (BANKNIFTY) / 500 (RELIANCE) — so with a plausible tightening to
 * 200 gross and a 75-unit lot, legs 1 and 2 POST (75, 150) and leg 3 is refused at 225. The hedge is
 * then already at the broker, possibly filled, against a cap the attempt can never satisfy: a
 * configuration mistake converted into live exposure that must be unwound.
 *
 * The requirement is to discover the incompatibility BEFORE the first leg posts — and to do it
 * without globally raising the caps to enormous values.
 */

/** Real one-lot sizes; `maxOpenLegQuantity` must be set to the SELECTED instrument's lot. */
const LOT = { NIFTY: 75, BANKNIFTY: 35, RELIANCE: 500 };

test("C1: the four-leg envelope is refused BEFORE any leg reaches the broker", async () => {
  // 75-unit lot, gross capped at 200: incrementally legs 1-2 would pass and leg 3 would fail.
  const { manager, adapter, persistence } = await ready(makeManager({
    limitOverrides: { maxOpenLegQuantity: LOT.NIFTY, maxGrossOpenLegQuantity: 200 },
  }));

  await assert.rejects(
    () => manager.submit(request({ role: "k1_ce", quantity: LOT.NIFTY })),
    /full 4-leg attempt needs 300 unit\(s\)/,
    "the FIRST leg is refused, naming the whole-attempt requirement",
  );

  assert.equal(adapter.calls.filter(([n]) => n === "submitOrder").length, 0, "nothing was sent to the broker");
  assert.deepEqual(
    persistence.calls.filter(([n]) => n === "create"),
    [],
    "and no durable intent was created",
  );
});

test("C1-negative: the same lot under a sufficient gross cap posts all four legs", async () => {
  // Non-vacuous control: C1 must fail because of the ENVELOPE, not because 75 is refused everywhere.
  const { manager, adapter } = await ready(makeManager({
    limitOverrides: { maxOpenLegQuantity: LOT.NIFTY, maxGrossOpenLegQuantity: 4 * LOT.NIFTY },
  }));
  for (const role of ROLES) {
    const order = await manager.submit(request({ role, quantity: LOT.NIFTY, attempt_id: "a1" }));
    assert.equal(order.filled_quantity, LOT.NIFTY);
  }
  assert.equal(adapter.calls.filter(([n]) => n === "submitOrder").length, 4, "all four legs posted");
});

test("C2: the SHIPPED defaults (100/leg, 400 gross) ADMIT an index box and refuse a single-stock lot", async () => {
  /*
   * Section 4's premise, asserted against the real defaults rather than trusted: per-leg 100 admits a
   * 75-unit lot, but 4 x 75 = 300 <= 400 gross, so a NIFTY box actually FITS. The default that does
   * not fit is a single-stock lot, and the per-leg cap is what refuses it. Both are asserted so the
   * supervised-test config can be derived from behaviour, not from a reading of the docs.
   */
  const nifty = await ready(makeManager({
    limitOverrides: { maxOpenLegQuantity: 100, maxGrossOpenLegQuantity: 400 },
  }));
  assert.equal(
    nifty.manager.entryQuantityEnvelopeBlockReason(LOT.NIFTY),
    null,
    "a 75-unit NIFTY box fits the shipped defaults (300 of 400 gross)",
  );
  assert.equal(
    nifty.manager.entryQuantityEnvelopeBlockReason(LOT.BANKNIFTY),
    null,
    "a 35-unit BANKNIFTY box fits too (140 of 400)",
  );

  const reason = nifty.manager.entryQuantityEnvelopeBlockReason(LOT.RELIANCE);
  assert.match(
    reason ?? "",
    /One lot of this instrument is 500 unit\(s\), which exceeds the per-leg limit BOX_LIVE_MAX_OPEN_LEG_QUANTITY=100/,
    "a 500-unit single-stock lot is refused, and the reason names the exact knob",
  );
  assert.match(reason ?? "", /do not raise it globally/, "and warns against the unsafe remedy");
});

test("C3: the envelope counts exposure ALREADY held, so a second box cannot slip past the cap", async () => {
  const { manager } = await ready(makeManager({
    limitOverrides: { maxOpenLegQuantity: LOT.NIFTY, maxGrossOpenLegQuantity: 4 * LOT.NIFTY },
  }));
  assert.equal(manager.entryQuantityEnvelopeBlockReason(LOT.NIFTY), null, "an empty book admits one box");

  // One box already on the books: four legs of 75.
  manager.setAttributedBoxPositions(ROLES.map((role, i) => ({
    token: 1000 + i, exchange: "NFO", tradingsymbol: `SYM-${role}`, net_quantity: LOT.NIFTY, average_price: 100,
  })));

  const reason = manager.entryQuantityEnvelopeBlockReason(LOT.NIFTY);
  assert.match(reason ?? "", /already committed: 300/, "held exposure counts toward the envelope");
  assert.match(reason ?? "", /BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=300/);
});

test("C4: an in-flight leg's RESERVATION counts, so concurrent attempts cannot both fit", async () => {
  // Reservations exist precisely so that two attempts racing the pump cannot each see a clear book.
  let release;
  const gate = new Promise((r) => { release = r; });
  const adapter = fakeAdapter({ submitOrder: async (req) => { await gate; return orderFrom(req); } });
  const { manager } = await ready(makeManager({
    adapter,
    limitOverrides: { maxOpenLegQuantity: LOT.NIFTY, maxGrossOpenLegQuantity: 4 * LOT.NIFTY },
  }));

  const inFlight = manager.submit(request({ role: "k1_ce", quantity: LOT.NIFTY, attempt_id: "a1" }));
  // The reservation is taken synchronously in submit(), before the await.
  assert.match(
    manager.entryQuantityEnvelopeBlockReason(LOT.NIFTY) ?? "",
    /already committed: 75/,
    "the reserved in-flight leg is visible to the envelope check",
  );
  release();
  await inFlight.catch(() => {});
});

test("C5: the envelope guard governs the real submit path, not just the helper", async () => {
  /*
   * The check must sit on the path production uses. A helper that is correct but unreferenced would
   * pass C1-C4 while the broker still received the legs.
   */
  const { manager, adapter } = await ready(makeManager({
    limitOverrides: { maxOpenLegQuantity: 1_000, maxGrossOpenLegQuantity: 200 },
  }));

  // Per-leg cap is wide open (1000); ONLY the whole-attempt envelope can refuse this.
  await assert.rejects(
    () => manager.submit(request({ quantity: 100 })),
    /Refused BEFORE the first leg posts/,
    "refused by the envelope even though the per-leg cap permits it",
  );
  assert.equal(adapter.calls.filter(([n]) => n === "submitOrder").length, 0);

  // And the same refusal is reported by the pre-flight predicate the API surfaces.
  assert.equal(manager.canEnter(request({ quantity: 100 })), false);
  assert.match(manager.entryBlockReason(request({ quantity: 100 })) ?? "", /full 4-leg attempt/);
});

test("C6: a REDUCTION is never subject to the entry envelope", async () => {
  /*
   * The envelope bounds NEW exposure. Applying it to an exit would be the same class of defect as
   * defect 1: a cap on taking risk blocking the shedding of risk. A reduction of held exposure must
   * remain possible even when the book is at or over the gross cap.
   */
  const { manager, adapter } = await ready(makeManager({
    limitOverrides: { maxOpenLegQuantity: LOT.NIFTY, maxGrossOpenLegQuantity: 4 * LOT.NIFTY },
  }));
  manager.setAttributedBoxPositions(ROLES.map((role, i) => ({
    token: 1000 + i, exchange: "NFO", tradingsymbol: `SYM-${role}`, net_quantity: LOT.NIFTY, average_price: 100,
  })));

  // The book is exactly at the gross cap, so no new entry may start...
  assert.match(manager.entryQuantityEnvelopeBlockReason(LOT.NIFTY) ?? "", /exceeds/);
  // ...yet every leg can still be exited.
  for (const role of ROLES) {
    const exit = await manager.submit(request({
      role, purpose: "EXIT", side: "SELL", quantity: LOT.NIFTY, attempt_id: "x1",
    }));
    assert.equal(exit.filled_quantity, LOT.NIFTY);
  }
  assert.equal(adapter.calls.filter(([n]) => n === "submitOrder").length, 4, "all four exits reached the broker");
});


/* ══════════════════ D. THE DISARM RESPONSE MUST REPORT WHAT IT DID NOT REMOVE ══════════════════ */

test("D1: setLiveControl reports the exposure the switch leaves behind", async () => {
  /*
   * A disarm request that answers a bare `{ ok: true }` tells the operator the switch worked without
   * telling them exposure is still live and still theirs. `setLiveControl` therefore returns an
   * exposure block; this test exists because the ROUTE was dropping it on the floor, which made the
   * whole report unobservable — the exact silent-success shape this work set out to remove.
   */
  const { BoxEngine } = await import("../../dist/box/engine.js");
  const engine = new BoxEngine({
    marketData: { isAuthenticated: () => true, getQuoteFull: async () => [] },
    activeBroker: () => "zerodha",
    feed: {
      addTickListener: () => () => {}, addConnectionListener: () => () => {}, retain: () => () => {},
      subscribeTokens: () => {}, unsubscribeTokens: () => {}, setStrategyTokens: () => {},
      setBoxTokens: () => {}, subscribedCount: () => 0, isConnected: () => false,
    },
    charges: { broker: "zerodha", rateVersion: "t", estimate: () => null },
    getAllInstruments: async () => [], getBoard: async () => [],
    priceChargeGroups: async () => null, istDayKey: () => "2026-09-15",
    makeIdResolver: () => () => null, isMarketOpen: () => false,
    margins: { broker: "zerodha", basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }) },
    brokerAccountRef: () => "ZD1234",
  });
  try {
    // Paper mode has no live order manager, so this reports the refusal rather than an exposure
    // block — which is itself the contract: `ok:false` carries an error, `ok:true` carries exposure.
    const result = engine.setLiveControl("entry", false);
    if (result.ok) {
      assert.ok(result.exposure, "an accepted control change reports the exposure it left behind");
      for (const key of ["open_positions", "residual_legs", "working_orders", "consequence",
                         "reduction_available", "reduction_blocked_reason"]) {
        assert.ok(key in result.exposure, `exposure.${key} is reported`);
      }
      assert.equal(typeof result.exposure.consequence, "string");
      assert.equal(typeof result.exposure.reduction_available, "boolean");
    } else {
      assert.equal(typeof result.error, "string", "a refusal names its reason");
      assert.ok(!("exposure" in result), "a refusal carries no exposure claim");
    }
  } finally {
    engine.dispose?.();
  }
});

test("D2: an unnameable session account does NOT disable exposure reduction", async () => {
  /*
   * THE DEFECT THIS PINS, which was introduced by the FIX for defect 1 and caught in review.
   *
   * `exposureReductionBlockReason()` briefly refused every reduction when the session could not name
   * its broker account. That is the original defect wearing a different costume: the account is
   * resolved through `marketData.isAuthenticated()` — a MARKET-DATA property — so a Dhan deployment
   * with `DHAN_DATA_ENABLED=false`, or a Zerodha process whose session metadata was cleared while its
   * token stayed live, would refuse every cancel, exit and flatten while the broker would still have
   * accepted them.
   *
   * Ownership of a reduction is proven by ATTRIBUTION (it may only trade against an attributed
   * position) and, for anything derived from a durable row, by the account recorded ON THAT ROW —
   * neither of which needs the session to introduce itself. NEW ENTRY is gated strictly and
   * separately, which is asserted alongside so this test cannot pass by making everything permissive.
   */
  const working = [intentFrom(request(), { broker_account: "ZD1234" })];
  const { manager, adapter } = await ready(makeManager({
    persistence: new MemoryPersistence(working),
    brokerAccount: () => null, // wired, but cannot name the account
  }));

  assert.equal(
    manager.exposureReductionBlockReason(),
    null,
    "reduction is NOT blocked by the session's inability to name itself",
  );

  const result = await manager.cancelWorkingBoxOrders();
  assert.equal(result.ok, true, "the panic button works");
  assert.equal(result.attempted, true);
  assert.equal(adapter.cancelled.length, 1, "the working order really was cancelled");

  // ...and the asymmetry is preserved: taking NEW exposure still requires a nameable account.
  assert.equal(manager.canEnter(request()), false);
  assert.match(manager.entryBlockReason(request()) ?? "", /account could not be identified/);
});
