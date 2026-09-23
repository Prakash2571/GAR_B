/**
 * LIVE RESIDUAL FLATTENING MUST BE A REAL RETRY LOOP.
 *
 * A residual leg is naked option exposure we hold and did not want. The engine works it every
 * two seconds until it is flat. Before this fix that loop could not retry: the durable
 * `client_order_id` was derived from `(attemptId, residual.created_at, role)`, and `created_at`
 * is deliberately PRESERVED when the shrunken residual is written back — so every pass
 * regenerated a byte-identical identity.
 *
 *   filled 0  -> the durable intent upsert returned the existing non-CREATED intent, so
 *                `OrderManager.execute()` took its "a prior submission exists" branch, re-read
 *                the stale order and resolved. NO SECOND ORDER WAS EVER SENT.
 *   filled 40 -> the remaining quantity changed but the identity did not, so
 *                `assertIntentImmutableMatch` threw on `quantity` — and that error matched
 *                neither branch of the old catch, so it was swallowed, forever.
 *
 * WHY THESE TESTS ARE NOT MIRRORS OF THE IMPLEMENTATION
 * They drive the REAL `BoxOrderManager` over a REAL durable-journal double and the REAL
 * `CentralBoxExecutionGateway` in live mode, and they assert on what reached the ADAPTER — i.e.
 * on whether an order was actually sent to the broker, which is the only thing that matters for
 * money. `loop()` below reproduces the engine's durable write-back (persist `res.remaining`,
 * then work it again) so identity reuse across passes is exercised exactly as in production.
 *
 * The negative control at the end re-introduces the OLD write-back (generation never advances)
 * against the SAME new code and proves the second POST disappears — so these tests are pinned to
 * the durable generation, not to any incidental detail of the new code.
 *
 * Pure and offline: no broker, no Mongo, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager } from "../../dist/box/orderManager.js";
import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BrokerAmbiguousSubmitError } from "../../dist/box/brokerAdapter.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { loadBoxConfig } from "../../dist/box/config.js";
import { MAX_RESIDUAL_BROKER_REJECTIONS } from "../../dist/box/residualFlatten.js";
import { quote } from "./helpers.mjs";

const clone = (v) => structuredClone(v);
const TERMINAL = ["COMPLETE", "CANCELLED", "REJECTED"];
const IMMUTABLE = [
  "broker_mode", "trade_id", "attempt_id", "role", "purpose", "phase",
  "exchange", "tradingsymbol", "token", "side", "quantity",
  "reference_price", "tick_size", "max_chase_ticks", "limit_price",
];

const TOKENS = { k1_ce: 9001, k2_ce: 9002, k2_pe: 9003, k1_pe: 9004 };

/**
 * The durable intent journal, modelling the two properties that decide the outcome:
 * an upsert that RETURNS the existing row rather than overwriting it, and the immutable-field
 * comparison that made the old partial-fill case throw.
 */
class Journal {
  constructor(rows = []) {
    this.rows = new Map(rows.map((r) => [r.client_order_id, clone(r)]));
    this.creates = [];
  }
  async create(intent) {
    this.creates.push(intent.client_order_id);
    const current = this.rows.get(intent.client_order_id);
    if (current) {
      for (const key of IMMUTABLE) {
        if (current[key] !== intent[key]) {
          throw new Error(
            `Client order id ${intent.client_order_id} was reused with different immutable field ${key}.`,
          );
        }
      }
      return clone(current);
    }
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  async update(clientOrderId, patch, audit) {
    const current = this.rows.get(clientOrderId);
    if (!current) return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
    if (patch.filled_quantity !== undefined && patch.filled_quantity < current.filled_quantity) {
      return {
        intent: clone(current), applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
    }
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
    average_price: filled > 0 ? avg : null,
    fills: filled > 0
      ? [{ fill_id: `fill-${req.client_order_id}-${filled}`, quantity: filled, price: avg, at: 2_000 }]
      : [],
    reject_family: null,
    reject_reason: null,
    created_at: 1_000,
    updated_at: 2_000,
  };
}

/**
 * `script` is consulted per SUBMIT, keyed by the attempt generation embedded in the client id,
 * so a test says "attempt 1 fills 0, attempt 2 fills everything" without caring about hashes.
 */
function adapterFor(script, options = {}) {
  const submits = [];
  const gets = [];
  const orders = new Map(options.seedOrders ?? []);
  return {
    mode: "live",
    submits,
    gets,
    orders,
    prepareOrder: (req) => ({ ...req, pricing: { ...req.pricing }, tag: `TAG${req.role}` }),
    submitOrder: async (req, beforePost) => {
      await options.beforePost?.(req);
      // This callback is the manager's final executable-feed guard. It runs
      // before `submits` is mutated because that array represents an external POST.
      beforePost?.();
      submits.push({ id: req.client_order_id, role: req.role, quantity: req.quantity, side: req.side });
      const generation = Number(/attempt-(\d+)$/.exec(req.client_order_id)?.[1] ?? 0);
      const outcome = script({ req, generation, submitIndex: submits.length - 1 });
      if (outcome instanceof Error) throw outcome;
      const order = orderFor(req, outcome);
      orders.set(req.client_order_id, clone(order));
      return clone(order);
    },
    cancelOrder: async (id) => orders.get(id),
    getOrder: async (id) => {
      gets.push(id);
      return orders.has(id) ? clone(orders.get(id)) : undefined;
    },
    listOrders: async () => [...orders.values()].map(clone),
    listPositions: async () => clone(options.positions ?? []),
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (intent, snapshot) => {
      if (snapshot.quantity !== intent.quantity) throw new Error("immutable broker snapshot mismatch");
      return { ...clone(snapshot), client_order_id: intent.client_order_id };
    },
  };
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

/**
 * A live gateway over a real manager. `held` seeds the ATTRIBUTED exposure the residual is
 * reducing — without it the manager's reduction gate (correctly) refuses every order.
 */
async function build({
  script,
  journal = new Journal(),
  held,
  invariants = [],
  generation = { value: 0 },
  beforePost,
  chargeTotal = () => 20,
} = {}) {
  const adapter = adapterFor(script, { beforePost });
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter,
    persistence: journal,
    limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-07",
    revalidateQueuedRequest: (_req, stamp) =>
      stamp?.feed_generation === generation.value
        ? null
        : "feed generation changed before broker POST",
  });
  // Spy on the REAL invariant hook rather than replacing it: the breaker must still trip.
  const realInvariant = manager.invariantViolation.bind(manager);
  manager.invariantViolation = (reason) => {
    invariants.push(reason);
    realInvariant(reason);
  };
  manager.seedLimits({ tradingDay: "2026-09-07" });
  manager.setFeedHealthy(true);
  manager.setAttributedBoxPositions(held);

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
    feedGeneration: () => generation.value,
    chargeTotal,
  });

  return { manager, gateway, adapter, journal, quotes, invariants };
}

const residual = (role, overrides = {}) => ({
  role,
  token: TOKENS[role],
  tradingsymbol: `SYM-${role}`,
  exchange: "NFO",
  side: "BUY",
  quantity: 75,
  average_price: 100,
  source: "partial_entry",
  created_at: 1_000,
  ...overrides,
});

/**
 * Reproduce the engine's flatten loop: work the residual, then durably write back exactly what
 * `res.remaining` says (quantity AND generation together, as one atomic document write), then
 * work THAT. `writeBack` lets a test substitute the old, broken projection.
 */
async function loop(gateway, start, passes, { keyPrefix = "att-1", writeBack = (r) => r } = {}) {
  let work = start;
  const history = [];
  for (let i = 0; i < passes && work.length > 0; i++) {
    const res = await gateway.flattenResidual({ residual: work, keyPrefix });
    history.push(res);
    work = res.remaining.map((r) => writeBack(r));
  }
  return { history, remaining: work };
}

/* ══════════════════ 1-2. a zero-fill attempt must be retryable ══════════════════ */

test("R1/R2: after a residual attempt fills 0, the NEXT attempt uses a different client order id and actually reaches the broker", async () => {
  const b = await build({
    // Attempt 1 is cancelled unfilled — the ordinary reason a residual survives a pass.
    script: ({ generation, req }) => generation === 1
      ? { state: "CANCELLED", filled: 0 }
      : { state: "COMPLETE", filled: req.quantity },
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce")], 2);

  assert.equal(b.adapter.submits.length, 2, "the second pass must SEND a second order, not re-read the first");
  assert.notEqual(
    b.adapter.submits[0].id,
    b.adapter.submits[1].id,
    "a new logical flatten attempt must have a NEW durable identity",
  );
  assert.match(b.adapter.submits[0].id, /attempt-1$/);
  assert.match(b.adapter.submits[1].id, /attempt-2$/);
  assert.equal(b.adapter.submits[1].quantity, 75, "nothing filled, so the whole residual is retried");

  assert.equal(history[0].remaining.length, 1, "pass 1 leaves the exposure outstanding");
  assert.equal(history[0].remaining[0].flatten_attempt, 2, "and retires the spent generation durably");
  assert.equal(remaining.length, 0, "pass 2 flattens it");
  assert.equal(history[1].flattened_by_role.k1_ce, 75);
});

test("R2b: the retry is a real POST — the durable journal holds two distinct intents", async () => {
  const b = await build({
    script: ({ generation, req }) => generation === 1
      ? { state: "CANCELLED", filled: 0 }
      : { state: "COMPLETE", filled: req.quantity },
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  await loop(b.gateway, [residual("k1_ce")], 2);

  const ids = [...b.journal.rows.keys()].filter((k) => k.includes("EMERGENCY_RESIDUAL"));
  assert.equal(ids.length, 2, "each logical attempt is represented explicitly in the journal");
  assert.equal(new Set(ids).size, 2);
  // The generation is the ONLY thing that differs — the scope hash is still stable.
  assert.deepEqual(
    ids.map((id) => id.replace(/attempt-\d+$/, "attempt-N")),
    [ids[0].replace(/attempt-\d+$/, "attempt-N"), ids[0].replace(/attempt-\d+$/, "attempt-N")],
  );
});

/* ══════════════════ 3-7. a partial fill must be retryable for the remainder ══════════════════ */

test("R3/R4/R5: a partially filled residual persists the remainder, and the next attempt submits EXACTLY the remainder under a new identity", async () => {
  const b = await build({
    // 30 of 75 fill, then the order terminates. 45 remain.
    script: ({ generation, req }) => generation === 1
      ? { state: "CANCELLED", filled: 30 }
      : { state: "COMPLETE", filled: req.quantity },
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce")], 2);

  // 5. the remaining quantity is persisted
  assert.equal(history[0].remaining.length, 1);
  assert.equal(history[0].remaining[0].quantity, 45, "exactly the unflattened remainder is carried");
  assert.equal(history[0].flattened_by_role.k1_ce, 30);

  // 6. a DIFFERENT identity
  assert.equal(b.adapter.submits.length, 2);
  assert.notEqual(b.adapter.submits[0].id, b.adapter.submits[1].id);
  assert.equal(history[0].remaining[0].flatten_attempt, 2);

  // 7. submitting exactly the remainder — and NOT throwing on the immutable `quantity` field,
  //    which is what silently killed every later pass before this fix.
  assert.equal(b.adapter.submits[0].quantity, 75);
  assert.equal(b.adapter.submits[1].quantity, 45, "the retry is sized to the remainder, never the original");
  assert.equal(remaining.length, 0);
});

test("R13: a prior attempt's immutable durable fields can never block a legitimate later attempt", async () => {
  // Three passes, each partially filling, so the quantity changes on EVERY pass. Under the old
  // identity this threw `reused with different immutable field quantity` from pass 2 onward and
  // the error was swallowed whole.
  const b = await build({
    script: ({ generation }) => ({ state: "CANCELLED", filled: generation === 1 ? 30 : generation === 2 ? 25 : 20 }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce")], 3);

  assert.equal(b.adapter.submits.length, 3, "every pass must reach the broker");
  assert.deepEqual(b.adapter.submits.map((s) => s.quantity), [75, 45, 20]);
  assert.deepEqual(history.map((h) => h.remaining[0]?.quantity ?? 0), [45, 20, 0]);
  assert.deepEqual(history.map((h) => h.remaining[0]?.flatten_attempt ?? null), [2, 3, null]);
  assert.equal(remaining.length, 0, "the residual is fully flattened by repeated legitimate retries");
  assert.equal(b.invariants.length, 0, "a normal partial-fill retry is not an invariant violation");
});

/* ══════════════════ 8-9. crash BEFORE the broker submit ══════════════════ */

/** Discover the durable identity attempt N would use, without leaving state behind. */
async function identityFor(attempt, r = residual("k1_ce"), keyPrefix = "att-1") {
  const probe = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: r.tradingsymbol, net_quantity: r.quantity }],
  });
  await probe.gateway.flattenResidual({ residual: [{ ...r, flatten_attempt: attempt }], keyPrefix });
  return { id: probe.adapter.submits[0].id, intent: probe.journal.rows.get(probe.adapter.submits[0].id) };
}

test("R8/R9: a crash after the durable attempt was created but BEFORE the broker POST does not invent a duplicate attempt", async () => {
  // The exact torn state: `createBoxOrderIntent` committed CREATED and the process died before
  // the SUBMITTING transition, so nothing ever reached the broker.
  const { id, intent } = await identityFor(1);
  const torn = new Journal([{ ...intent, state: "CREATED", filled_quantity: 0, average_price: null, broker_order_id: null, terminal_at: null }]);

  // RESTART. The residual is re-read from Mongo with its generation UNCHANGED (the write-back
  // never happened), so the SAME identity is worked again — which is correct: no POST happened.
  const after = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    journal: torn,
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const res = await after.gateway.flattenResidual({ residual: [residual("k1_ce")], keyPrefix: "att-1" });

  assert.equal(
    [...torn.rows.keys()].length,
    1,
    "the restart must NOT create a second logical attempt for work that never reached the broker",
  );
  assert.equal(after.adapter.submits.length, 1, "and it must send the order that was never sent");
  assert.equal(after.adapter.submits[0].id, id, "under the SAME identity");
  assert.equal(res.remaining.length, 0);
});

test("R9b: a crash mid-submit (durably SUBMITTING, broker outcome unknown) is reconciled, never resubmitted", async () => {
  const { id, intent } = await identityFor(1);
  // SUBMITTING means the POST may or may not have landed. The broker has nothing to show.
  const torn = new Journal([{ ...intent, state: "SUBMITTING", filled_quantity: 0, average_price: null, broker_order_id: null, terminal_at: null }]);
  const after = await build({
    script: () => { throw new Error("A MID-SUBMIT CRASH MUST NOT BE BLINDLY RESUBMITTED"); },
    journal: torn,
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const res = await after.gateway.flattenResidual({ residual: [residual("k1_ce")], keyPrefix: "att-1" });

  assert.equal(after.adapter.submits.length, 0, "an unknown POST outcome is never duplicated");
  assert.ok(after.adapter.gets.includes(id), "it is reconciled by client id first");
  assert.equal(res.remaining.length, 1, "the exposure stays outstanding and visible");
  assert.equal(res.remaining[0].flatten_attempt, 1, "and the identity is retained for reconciliation");
  assert.ok(after.invariants.some((r) => /broker_state_unknown/.test(r)), "the uncertainty is surfaced");
});

/* ══════════════════ 10-11. crash AFTER the broker submit ══════════════════ */

test("R10/R11: a crash after the broker POST but before the durable terminal update adopts rather than blindly resubmitting", async () => {
  const b = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  // Simulate the crash window: the order EXISTS at the broker and the intent is durably
  // SUBMITTING, but no terminal snapshot was ever written.
  const r = residual("k1_ce");
  const probe = await b.gateway.flattenResidual({ residual: [r], keyPrefix: "att-1" });
  assert.equal(probe.remaining.length, 0);
  const clientId = b.adapter.submits[0].id;

  const torn = new Journal([{ ...b.journal.rows.get(clientId), state: "SUBMITTING", filled_quantity: 0, terminal_at: null }]);
  const after = await build({
    script: () => { throw new Error("A RESTART MUST NOT RESUBMIT AN ORDER THE BROKER ALREADY HAS"); },
    journal: torn,
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  // The broker still has the real, filled order.
  after.adapter.orders.set(clientId, b.adapter.orders.get(clientId));

  const res = await after.gateway.flattenResidual({ residual: [r], keyPrefix: "att-1" });

  assert.equal(after.adapter.submits.length, 0, "no second POST for an order the broker already has");
  assert.ok(after.adapter.gets.includes(clientId), "the existing submission is reconciled by client id");
  assert.equal(res.flattened_by_role.k1_ce, 75, "the broker's real fill is adopted");
  assert.equal(res.remaining.length, 0, "so the exposure is correctly recorded as flat");
  assert.equal(torn.rows.get(clientId).filled_quantity, 75, "and the durable snapshot is repaired");
});

/* ══════════════════ 12. independent identities per role ══════════════════ */

test("R12: multiple residual roles use independent identities and independent generations", async () => {
  const b = await build({
    // k1_ce needs two passes; k2_pe flattens on the first.
    script: ({ req, generation }) => {
      if (req.role === "k2_pe") return { state: "COMPLETE", filled: req.quantity };
      return generation === 1 ? { state: "CANCELLED", filled: 0 } : { state: "COMPLETE", filled: req.quantity };
    },
    held: [
      { exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 },
      { exchange: "NFO", tradingsymbol: "SYM-k2_pe", net_quantity: 75 },
    ],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce"), residual("k2_pe")], 2);

  const ids = b.adapter.submits.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "no two submissions may share an identity");
  assert.equal(history[0].remaining.length, 1, "only the unflattened role survives pass 1");
  assert.equal(history[0].remaining[0].role, "k1_ce");
  assert.equal(history[0].remaining[0].flatten_attempt, 2, "the flattened role's generation is irrelevant to k1_ce's");
  assert.equal(history[0].flattened_by_role.k2_pe, 75);
  assert.equal(history[0].flattened_by_role.k1_ce, 0);
  assert.equal(remaining.length, 0);

  // Each role's identity carries its own role and its own generation.
  assert.ok(ids.every((id) => /:(k1_ce|k2_pe):/.test(id)));
  assert.equal(ids.filter((id) => id.includes(":k1_ce:")).length, 2);
  assert.equal(ids.filter((id) => id.includes(":k2_pe:")).length, 1);
});

test("R12b: two residual entries sharing one role are accounted separately, not collapsed", async () => {
  // The old code matched an order back to its residual BY ROLE, so a second entry for the same
  // role silently inherited the first's fill and its own exposure vanished from the books.
  const b = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 110 }],
  });
  const res = await b.gateway.flattenResidual({
    residual: [
      residual("k1_ce", { quantity: 75, created_at: 1_000 }),
      residual("k1_ce", { quantity: 35, created_at: 2_000 }),
    ],
    keyPrefix: "att-1",
  });
  assert.equal(b.adapter.submits.length, 2, "both entries must be worked");
  assert.deepEqual(b.adapter.submits.map((s) => s.quantity).sort((a, c) => a - c), [35, 75]);
  assert.equal(res.flattened_by_role.k1_ce, 110, "the role's flattened quantity is the SUM of both");
  assert.equal(res.remaining.length, 0);
});

/* ══════════════════ 14. ambiguity must never become a duplicate POST ══════════════════ */

test("R14: an ambiguous broker response never becomes a duplicate POST, and is quarantined", async () => {
  const b = await build({
    script: () => new BrokerAmbiguousSubmitError("submit timed out; broker state unknown"),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce")], 4);

  assert.equal(b.adapter.submits.length, 1, "an ambiguous submission must be attempted exactly ONCE");
  assert.equal(history[0].remaining[0].flatten_attempt, 1, "the generation must NOT advance past an unknown outcome");
  assert.equal(remaining.length, 1, "the exposure stays visible rather than being silently dropped");
  assert.equal(remaining[0].quantity, 75, "and keeps its exact quantity");
  assert.ok(
    b.invariants.some((r) => /broker_state_unknown/.test(r)),
    `an unknown broker outcome must raise an invariant, got: ${JSON.stringify(b.invariants)}`,
  );
  // Quarantine is real: the reduction reservation is still held, so nothing can double-reduce.
  assert.equal(b.manager.status().unknownOrders > 0, true, "the order manager reports the quarantine");
});

test("R14b: a working (non-terminal) order keeps its identity instead of racing a second reduction", async () => {
  const b = await build({
    script: () => ({ state: "UNKNOWN", filled: 0 }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const res = await b.gateway.flattenResidual({ residual: [residual("k1_ce")], keyPrefix: "att-1" });
  assert.equal(res.remaining[0].flatten_attempt, 1, "an order that may still fill keeps its identity");
  assert.ok(b.invariants.some((r) => /broker_state_unknown/.test(r)));
});

/* ══════════════════ nothing-was-sent must NOT burn a generation ══════════════════ */

test("R15: a pass with no executable book keeps the identity — a generation is only spent by the broker", async () => {
  const b = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  // A token with no book at all.
  const orphan = residual("k1_ce", { token: 999_999 });
  const res = await b.gateway.flattenResidual({ residual: [orphan], keyPrefix: "att-1" });

  assert.equal(b.adapter.submits.length, 0, "nothing can be sent without an executable touch");
  assert.equal(res.remaining.length, 1);
  assert.equal(res.remaining[0].flatten_attempt, 1, "an unused identity must be reused, not retired");
  assert.equal(res.flatten_charges, 0);
});

test("R16: a gate refusal keeps the identity and never reports a phantom fill", async () => {
  const b = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    // No attributed exposure at all, so the manager's reduction gate must refuse.
    held: [],
  });
  const res = await b.gateway.flattenResidual({ residual: [residual("k1_ce")], keyPrefix: "att-1" });

  assert.equal(b.adapter.submits.length, 0, "a reduction with no attributed exposure must never reach the broker");
  assert.equal(res.remaining[0].quantity, 75, "the exposure is unchanged");
  assert.equal(res.remaining[0].flatten_attempt, 1, "and the unused identity is preserved");
});

test("R17: an applied local pre-POST refusal spends exactly one generation and retries the exact remainder", async () => {
  const generation = { value: 1 };
  let firstBoundary = true;
  const b = await build({
    generation,
    beforePost: async () => {
      if (firstBoundary) {
        firstBoundary = false;
        generation.value = 2;
      }
    },
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const first = await b.gateway.flattenResidual({
    residual: [residual("k1_ce")],
    keyPrefix: "att-local-refusal",
  });
  assert.equal(b.adapter.submits.length, 0, "the stale generation made no external POST");
  assert.equal(first.flattened_by_role.k1_ce, 0);
  assert.equal(first.remaining[0].quantity, 75, "a local refusal cannot invent a fill");
  assert.equal(first.remaining[0].flatten_attempt, 2, "the durably rejected identity is spent exactly once");
  const firstId = [...b.journal.rows.keys()].find((id) => /attempt-1$/.test(id));
  assert.equal(b.journal.rows.get(firstId).state, "REJECTED", "no-POST provenance is durable");

  const second = await b.gateway.flattenResidual({
    residual: first.remaining,
    keyPrefix: "att-local-refusal",
  });
  assert.equal(b.adapter.submits.length, 1, "the next logical attempt reaches the broker once");
  assert.match(b.adapter.submits[0].id, /attempt-2$/);
  assert.equal(b.adapter.submits[0].quantity, 75, "the retry uses the exact still-outstanding quantity");
  assert.equal(second.flattened_by_role.k1_ce, 75);
  assert.equal(second.remaining.length, 0);
});

test("R17b: restart repairs a crash-stranded persisted generation after durable local refusal", async () => {
  const generation = { value: 1 };
  let refuseOnce = true;
  const beforeCrash = await build({
    generation,
    beforePost: async () => {
      if (refuseOnce) {
        refuseOnce = false;
        generation.value = 2;
      }
    },
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const stalePersistedResidual = residual("k1_ce", { flatten_attempt: 1 });
  const refused = await beforeCrash.gateway.flattenResidual({
    residual: [stalePersistedResidual],
    keyPrefix: "att-crash-local-refusal",
  });
  assert.equal(refused.remaining[0].flatten_attempt, 2, "the in-memory result advanced before the crash");
  const rejected = [...beforeCrash.journal.rows.values()].find((intent) => intent.state === "REJECTED");
  assert.equal(rejected.filled_quantity, 0);
  assert.equal(rejected.broker_order_id, null);
  assert.equal(rejected.audit.at(-1).payload.no_broker_post, true);

  // CRASH: generation-2 was never projected. Restart receives the old generation-1 residual.
  const afterRestart = await build({
    generation,
    journal: beforeCrash.journal,
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const repaired = await afterRestart.gateway.flattenResidual({
    residual: [stalePersistedResidual],
    keyPrefix: "att-crash-local-refusal",
  });

  assert.equal(afterRestart.adapter.submits.length, 1, "restart reaches a fresh broker identity");
  assert.match(afterRestart.adapter.submits[0].id, /attempt-2$/);
  assert.equal(repaired.remaining.length, 0);
  assert.equal(repaired.flattened_by_role.k1_ce, 75);
});

test("R17c: a broker rejection is RETRIED under a fresh identity, but only a bounded number of times", async () => {
  /*
   * THIS TEST INVERTED. It used to assert "broker-origin REJECTED never advances to a fresh residual
   * identity" — which pinned a defect as a requirement.
   *
   * `adopt_attempt` does not advance `flatten_attempt`, so every later pass regenerated the same
   * `client_order_id`, the durable journal adopted the REJECTED intent instead of submitting, and NO
   * FURTHER ORDER WAS EVER SENT. A single transient refusal — a momentary margin shortfall while
   * another box was legging, a `market_closed` race on the 15:30 boundary, a freeze-quantity or
   * price-band refusal — left a naked option leg on the book permanently. New entry stayed blocked
   * (correctly), so the strategy was dead as well, until a human noticed.
   *
   * Retiring is safe because the gateway only classifies `broker_rejected` after zero exposure is
   * PROVEN, so the broker holds no quantity under the retired identity and a fresh one cannot
   * duplicate a fill. What must be bounded is the RETRY: a structurally impossible reduction (F&O
   * ban period, expired contract, standing RMS block) would otherwise re-POST every two seconds
   * forever and drain the daily order budget that protective work for other positions needs.
   */
  const b = await build({
    script: () => ({ state: "REJECTED", filled: 0 }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  let carried = [residual("k1_ce", { flatten_attempt: 1 })];
  for (let pass = 1; pass <= MAX_RESIDUAL_BROKER_REJECTIONS; pass++) {
    const result = await b.gateway.flattenResidual({ residual: carried, keyPrefix: "att-broker-reject" });
    assert.equal(
      b.adapter.submits.length, pass,
      `pass ${pass} must reach the broker under its own identity — a rejection is retryable`,
    );
    assert.match(b.adapter.submits[pass - 1].id, new RegExp(`attempt-${pass}$`));
    assert.equal(result.remaining.length, 1, "the exposure is retained; it was never filled");
    assert.equal(result.remaining[0].quantity, 75);
    assert.equal(
      result.remaining[0].flatten_attempt, pass + 1,
      "a proven zero-fill rejection retires its identity so the next pass can retry",
    );
    assert.equal(result.remaining[0].flatten_broker_rejections, pass, "consecutive rejections are counted");
    carried = result.remaining;
  }

  // BUDGET SPENT. Nothing further may be POSTed, the exposure is still held, and the condition is
  // escalated as an invariant rather than counted as a routine market outcome.
  const before = b.adapter.submits.length;
  const exhausted = await b.gateway.flattenResidual({ residual: carried, keyPrefix: "att-broker-reject" });
  assert.equal(b.adapter.submits.length, before, "past the bound, no further order is sent");
  assert.equal(exhausted.remaining.length, 1, "the exposure is retained, never abandoned");
  assert.equal(exhausted.remaining[0].quantity, 75);
  assert.equal(
    exhausted.remaining[0].flatten_attempt, carried[0].flatten_attempt,
    "an exhausted budget holds its identity rather than burning generations",
  );
  assert.ok(
    b.invariants.some((v) => /budget_exhausted/.test(v)),
    `the stalled exposure is escalated to an operator, got ${JSON.stringify(b.invariants)}`,
  );
});

test("R17c: a durable REJECTED intent that contradicts a recorded fill is NEVER retired past", async () => {
  /*
   * The safety counterpart to the test above. Retirement is only sound when the rejected identity
   * provably holds no quantity. A durable REJECTED intent carrying a fill is contradictory evidence,
   * and retiring past it would mint a second reduction order while the broker still holds quantity
   * under the first — a duplicate reduction, which on a short leg means selling the same exposure
   * twice and opening a naked position in the opposite direction.
   */
  const keyPrefix = "att-reject-with-fill";
  const journal = await terminalIntentJournal({ filled: 20, keyPrefix });
  const contradicted = new Journal([...journal.rows.values()].map((row) => ({
    ...row,
    state: "REJECTED",
    filled_quantity: 20,
    average_price: 99.9,
    reject_reason: "broker rejected the balance",
  })));
  const b = await build({
    journal: contradicted,
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 55 }],
  });
  const carried = residual("k1_ce", { quantity: 55, flatten_attempt: 1 });

  const result = await b.gateway.flattenResidual({ residual: [carried], keyPrefix });
  assert.equal(b.adapter.submits.length, 0, "an unprovable rejection never manufactures a new POST");
  assert.equal(result.remaining[0].flatten_attempt, 1, "the contradicted identity is retained, not retired");
  assert.equal(
    result.remaining[0].flatten_broker_rejections, undefined,
    "an unprovable rejection does not spend the retry budget — it is not a clean refusal",
  );
  assert.ok(
    b.invariants.some((v) => /broker_state_unknown/.test(v)),
    `it is quarantined for reconciliation, got ${JSON.stringify(b.invariants)}`,
  );
});

/* ══════════════════ stale projection self-repair ══════════════════ */

test("terminal broker truth is projected before a stale residual can use the next generation", async () => {
  const b = await build({
    script: ({ generation, req }) => generation === 1
      ? { state: "CANCELLED", filled: 0 }
      : { state: "COMPLETE", filled: req.quantity },
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const stale = residual("k1_ce", { flatten_attempt: 1 });
  const first = await b.gateway.flattenResidual({ residual: [stale], keyPrefix: "att-terminal-repair" });
  assert.equal(first.remaining[0].flatten_attempt, 2);
  assert.equal(b.adapter.submits.length, 1);

  // CRASH before generation 2 is projected: restart/another worker still holds generation 1.
  const repaired = await b.gateway.flattenResidual({ residual: [stale], keyPrefix: "att-terminal-repair" });
  assert.equal(b.adapter.submits.length, 1, "stale work adopts attempt 1; it cannot POST attempt 2 yet");
  assert.equal(repaired.remaining[0].flatten_attempt, 2, "adopted terminal truth repairs the projection");

  const completed = await b.gateway.flattenResidual({
    residual: repaired.remaining,
    keyPrefix: "att-terminal-repair",
  });
  assert.equal(b.adapter.submits.length, 2);
  assert.match(b.adapter.submits[1].id, /attempt-2$/);
  assert.equal(completed.remaining.length, 0);
});

test("a COMPLETE fill is adopted after crash-before-projection without a second POST", async () => {
  const b = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const stale = residual("k1_ce", { flatten_attempt: 1 });
  const beforeCrash = await b.gateway.flattenResidual({ residual: [stale], keyPrefix: "att-complete-repair" });
  assert.equal(beforeCrash.remaining.length, 0);
  assert.equal(b.adapter.submits.length, 1);

  const afterCrash = await b.gateway.flattenResidual({ residual: [stale], keyPrefix: "att-complete-repair" });
  assert.equal(b.adapter.submits.length, 1, "terminal attempt 1 is adopted rather than skipping to attempt 2");
  assert.equal(afterCrash.flattened_by_role.k1_ce, 75);
  assert.equal(afterCrash.remaining.length, 0);
});

test("terminal replay applies only cumulative fill/charge above the persisted generation watermark", async () => {
  const b = await build({
    script: () => ({ state: "UNKNOWN", filled: 20 }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * 0.5, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const projected = await b.gateway.flattenResidual({
    residual: [residual("k1_ce")],
    keyPrefix: "att-cumulative-terminal-same",
  });
  assert.equal(projected.flattened_by_role.k1_ce, 20);
  assert.equal(projected.flatten_charges, 10);
  assert.equal(projected.remaining[0].quantity, 55);
  assert.equal(projected.remaining[0].flatten_accounted_filled, 20);
  assert.equal(projected.remaining[0].flatten_accounted_charges, 10);

  const intent = [...b.journal.rows.values()][0];
  b.journal.rows.set(intent.client_order_id, {
    ...intent,
    state: "CANCELLED",
    filled_quantity: 20,
    average_price: 99.9,
    terminal_at: new Date(3_000),
    updated_at: new Date(3_000),
  });
  const replay = await b.gateway.flattenResidual({
    residual: projected.remaining,
    keyPrefix: "att-cumulative-terminal-same",
  });
  assert.equal(replay.flattened_by_role.k1_ce, 0, "unchanged broker cumulative fill is not replayed");
  assert.equal(replay.flatten_charges, 0, "unchanged cumulative fee is not replayed");
  assert.equal(replay.remaining[0].quantity, 55);
  assert.equal(replay.remaining[0].flatten_attempt, 2);
  assert.equal(replay.remaining[0].flatten_accounted_filled, 0, "a retired identity resets fill accounting");
  assert.equal(replay.remaining[0].flatten_accounted_charges, 0, "a retired identity resets fee accounting");

  // After restart, generation 2 owns a fresh cumulative stream and applies its full 55 once.
  const restarted = await build({
    journal: b.journal,
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * 0.5, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 55 }],
  });
  const completed = await restarted.gateway.flattenResidual({
    residual: replay.remaining,
    keyPrefix: "att-cumulative-terminal-same",
  });
  assert.match(restarted.adapter.submits.at(-1).id, /attempt-2$/);
  assert.equal(completed.flattened_by_role.k1_ce, 55);
  assert.equal(completed.flatten_charges, 27.5);
  assert.equal(completed.remaining.length, 0);
});

test("terminal replay applies only the later positive cumulative suffix", async () => {
  const b = await build({
    script: () => ({ state: "UNKNOWN", filled: 20 }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * 0.5, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const projected = await b.gateway.flattenResidual({
    residual: [residual("k1_ce")],
    keyPrefix: "att-cumulative-terminal-growth",
  });
  const intent = [...b.journal.rows.values()][0];
  b.journal.rows.set(intent.client_order_id, {
    ...intent,
    state: "CANCELLED",
    filled_quantity: 35,
    average_price: 99.9,
    terminal_at: new Date(3_000),
    updated_at: new Date(3_000),
  });

  const replay = await b.gateway.flattenResidual({
    residual: projected.remaining,
    keyPrefix: "att-cumulative-terminal-growth",
  });
  assert.equal(replay.flattened_by_role.k1_ce, 15);
  assert.equal(replay.flatten_charges, 7.5);
  assert.equal(replay.remaining[0].quantity, 40);
  assert.equal(replay.remaining[0].flatten_attempt, 2);
});

test("cumulative regression quarantines the identity and never produces negative fill", async () => {
  const b = await build({
    script: () => ({ state: "UNKNOWN", filled: 20 }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * 0.5, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const projected = await b.gateway.flattenResidual({
    residual: [residual("k1_ce")],
    keyPrefix: "att-cumulative-regression",
  });
  const intent = [...b.journal.rows.values()][0];
  b.journal.rows.set(intent.client_order_id, {
    ...intent,
    state: "CANCELLED",
    filled_quantity: 10,
    average_price: 99.9,
    terminal_at: new Date(3_000),
    updated_at: new Date(3_000),
  });

  const replay = await b.gateway.flattenResidual({
    residual: projected.remaining,
    keyPrefix: "att-cumulative-regression",
  });
  assert.equal(replay.flattened_by_role.k1_ce, 0);
  assert.equal(replay.flatten_charges, 0);
  assert.equal(replay.remaining[0].quantity, 55);
  assert.equal(replay.remaining[0].flatten_attempt, 1, "corrupt terminal accounting cannot retire past the identity");
  assert.ok(b.invariants.some((message) => /cumulative accounting regressed/.test(message)));
});


/* ══════════ pre-watermark (legacy) residuals must not be re-credited ══════════
 *
 * Cumulative watermarks are new. A residual persisted by the PREVIOUS version has none, and
 * reading that as "this identity has projected nothing yet" replays the partial fill it already
 * credited and re-bills its fee on the first post-upgrade terminal pass — understating exposure
 * that is still naked. `order.quantity` is immutable on the durable intent and equals the residual
 * quantity when that identity was created, so the difference is exactly what it already projected.
 */

/** A terminal durable intent for `attempt`, sized to `intentQuantity`, with `filled` cumulative. */
async function terminalIntentJournal({ attempt = 1, intentQuantity = 75, filled, keyPrefix }) {
  const { intent } = await identityFor(attempt, residual("k1_ce", { quantity: intentQuantity }), keyPrefix);
  return new Journal([{
    ...intent,
    state: "CANCELLED",
    filled_quantity: filled,
    average_price: 99.9,
    terminal_at: new Date(3_000),
    updated_at: new Date(3_000),
  }]);
}

test("a watermark-less residual derives its accounted fill from the durable intent instead of re-crediting it", async () => {
  const keyPrefix = "att-legacy-watermarks";
  // Pre-upgrade state: generation 1 was sized 75, filled 20, and that 20 was ALREADY projected and
  // charged — the old code recorded it only by shrinking the residual to 55.
  const journal = await terminalIntentJournal({ filled: 20, keyPrefix });
  const b = await build({
    journal,
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * 0.5, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 55 }],
  });
  const legacy = residual("k1_ce", { quantity: 55, flatten_attempt: 1 });
  assert.equal("flatten_accounted_filled" in legacy, false, "the legacy row has no watermarks at all");
  assert.equal("flatten_accounted_charges" in legacy, false);

  const replay = await b.gateway.flattenResidual({ residual: [legacy], keyPrefix });

  assert.equal(b.adapter.submits.length, 0, "terminal durable truth is replayed, never resubmitted");
  // Defaulting the watermark to 0 credited 20 lots a second time, billed the 20-lot fee again and
  // projected 35 — leaving 20 units naked and invisible.
  assert.equal(replay.flattened_by_role.k1_ce, 0, "the already-projected fill is not credited twice");
  assert.equal(replay.flatten_charges, 0, "and its fee is not billed twice");
  assert.equal(replay.remaining[0].quantity, 55, "all 55 units are still outstanding and still worked");
  assert.equal(replay.remaining[0].flatten_attempt, 2, "the spent identity retires normally");
  assert.equal(replay.remaining[0].flatten_accounted_filled, 0, "generation 2 owns a fresh stream");
  assert.equal(replay.remaining[0].flatten_accounted_charges, 0);
  assert.equal(b.invariants.length, 0, "an upgraded legacy row is not an accounting violation");

  // The exposure is still flattenable: generation 2 reduces the true 55 units exactly once.
  const completed = await b.gateway.flattenResidual({ residual: replay.remaining, keyPrefix });
  assert.match(b.adapter.submits.at(-1).id, /attempt-2$/);
  assert.equal(b.adapter.submits.at(-1).quantity, 55);
  assert.equal(completed.flattened_by_role.k1_ce, 55);
  assert.equal(completed.flatten_charges, 27.5);
  assert.equal(completed.remaining.length, 0);
});

test("a watermark-less residual with a zero-fill durable intent still applies its whole terminal fill", async () => {
  // The other half of the derivation: a genuinely FRESH legacy residual (nothing ever projected)
  // must derive a zero watermark, so its terminal fill is applied in full exactly once.
  const keyPrefix = "att-legacy-fresh";
  const journal = await terminalIntentJournal({ filled: 30, intentQuantity: 75, keyPrefix });
  const b = await build({
    journal,
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * 0.5, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const replay = await b.gateway.flattenResidual({
    residual: [residual("k1_ce", { quantity: 75, flatten_attempt: 1 })],
    keyPrefix,
  });
  assert.equal(replay.flattened_by_role.k1_ce, 30, "nothing was projected under this identity yet");
  assert.equal(replay.flatten_charges, 15);
  assert.equal(replay.remaining[0].quantity, 45);
  assert.equal(replay.remaining[0].flatten_attempt, 2);
  assert.equal(b.invariants.length, 0);
});

test("a pass with no broker order leaves a legacy residual's watermarks derivable", async () => {
  // A legacy row whose first post-upgrade pass finds no executable book must not have zeros written
  // over its absent watermarks: the durable intent is the only remaining evidence of what it
  // already projected, and the pass after that would re-credit the whole fill.
  const keyPrefix = "att-legacy-no-book";
  const journal = await terminalIntentJournal({ filled: 20, keyPrefix });
  const b = await build({
    journal,
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * 0.5, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 55 }],
  });
  // No book for a residual whose durable intent is still WORKING, so nothing is submitted or read.
  const working = new Journal([...b.journal.rows.values()].map((row) => ({ ...row, state: "UNKNOWN" })));
  const noBook = await build({
    journal: working,
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * 0.5, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 55 }],
  });
  noBook.quotes.applyTicks([], 1_000);
  const legacy = residual("k1_ce", { quantity: 55, flatten_attempt: 1 });
  const refused = await noBook.gateway.flattenResidual({
    residual: [{ ...legacy, token: 12345, tradingsymbol: "SYM-unquoted" }],
    keyPrefix,
  });
  assert.equal(noBook.adapter.submits.length, 0);
  assert.equal(refused.remaining[0].flatten_accounted_filled, undefined,
    "an unobserved pass writes no watermark over an absent one");
  assert.equal(refused.remaining[0].flatten_accounted_charges, undefined);

  // So the NEXT pass still derives the already-projected 20 from the durable intent.
  const replay = await b.gateway.flattenResidual({ residual: [legacy], keyPrefix });
  assert.equal(replay.flattened_by_role.k1_ce, 0);
  assert.equal(replay.flatten_charges, 0);
  assert.equal(replay.remaining[0].quantity, 55);
});

/* ══════════ a cheaper re-estimated charge is not corruption ══════════ */

test("a lower re-estimated cumulative charge still retires and flattens the residual, and bills no negative fee", async () => {
  // The cumulative charge is RE-ESTIMATED from the current rate card on every pass, so it can fall
  // while the fill is unchanged (rate-card version change, corrected average price). Folding that
  // into the accounting-regression guard forced `adopt_attempt` forever: the identity never
  // retired, the quantity never shrank, and every interval tripped the invariant and the breaker,
  // stranding a naked leg for good.
  const keyPrefix = "att-charge-only-regression";
  const rate = { perUnit: 0.25 };
  const journal = await terminalIntentJournal({ filled: 20, keyPrefix });
  const b = await build({
    journal,
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * rate.perUnit, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 55 }],
  });
  // 20 lots were charged 10 when the rate card was 0.5/unit; today the same fill estimates 5.
  const carried = residual("k1_ce", {
    quantity: 55,
    flatten_attempt: 1,
    flatten_accounted_filled: 20,
    flatten_accounted_charges: 10,
  });

  const replay = await b.gateway.flattenResidual({ residual: [carried], keyPrefix });
  assert.equal(replay.flattened_by_role.k1_ce, 0, "an unchanged cumulative fill is not replayed");
  assert.equal(replay.flatten_charges, 0, "a cheaper estimate bills nothing, never a negative fee");
  assert.equal(replay.remaining[0].quantity, 55);
  assert.equal(replay.remaining[0].flatten_attempt, 2, "the identity retires, so the exposure can be worked");
  assert.equal(b.invariants.length, 0, "a re-estimated charge is not accounting corruption");

  // Retirement is what makes the leg reachable at all: prove it actually flattens.
  const completed = await b.gateway.flattenResidual({ residual: replay.remaining, keyPrefix });
  assert.match(b.adapter.submits.at(-1).id, /attempt-2$/);
  assert.equal(completed.flattened_by_role.k1_ce, 55);
  assert.equal(completed.flatten_charges, 13.75);
  assert.equal(completed.remaining.length, 0);
  assert.equal(b.invariants.length, 0);
});

test("the charge watermark stays monotonic across a cheaper then recovered rate card", async () => {
  // A cheaper estimate must not LOWER the watermark either: the next pass would then bill the same
  // turnover again once the estimate recovers.
  //
  // THE VEHICLE CHANGED, THE PROPERTY DID NOT. This used to keep the watermarks across passes with a
  // broker-origin REJECTED intent, which retained its identity by policy. A proven zero-fill
  // rejection now RETIRES (so a transient refusal cannot strand exposure forever), and a retired
  // identity correctly starts a fresh cumulative stream at zero — so it is no longer a case in which
  // a falling estimate could lower the bar.
  //
  // A REJECTED intent that CONTRADICTS a recorded fill still retains its identity, and must: the
  // broker may hold quantity under it, so it is quarantined rather than retired. That is now the
  // case where watermarks genuinely carry across passes, and therefore the case this property has to
  // hold for.
  const keyPrefix = "att-charge-monotonic";
  const rate = { perUnit: 0.25 };
  const journal = await terminalIntentJournal({ filled: 20, keyPrefix });
  const retained = new Journal([...journal.rows.values()].map((row) => ({
    ...row,
    state: "REJECTED",
    filled_quantity: 20,
    average_price: 99.9,
    reject_reason: "broker rejected the balance",
  })));
  const b = await build({
    journal: retained,
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    chargeTotal: (orders) => orders.reduce((sum, order) => sum + order.quantity * rate.perUnit, 0),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 55 }],
  });
  const carried = residual("k1_ce", {
    quantity: 55,
    flatten_attempt: 1,
    flatten_accounted_filled: 20,
    flatten_accounted_charges: 10,
  });

  const cheaper = await b.gateway.flattenResidual({ residual: [carried], keyPrefix });
  assert.equal(b.adapter.submits.length, 0, "a retained broker rejection never manufactures a new POST");
  assert.equal(cheaper.flatten_charges, 0);
  assert.equal(cheaper.remaining[0].flatten_attempt, 1, "an unprovable rejection keeps the identity");
  assert.equal(cheaper.remaining[0].flatten_accounted_charges, 10,
    "the watermark never falls to the cheaper estimate");

  // Rate card recovers: the SAME 20 lots must still bill nothing.
  rate.perUnit = 0.5;
  const recovered = await b.gateway.flattenResidual({ residual: cheaper.remaining, keyPrefix });
  assert.equal(recovered.flatten_charges, 0, "already-billed turnover is never billed again");
  assert.equal(recovered.remaining[0].flatten_accounted_charges, 10);
});
