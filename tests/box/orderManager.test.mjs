import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BrokerAmbiguousSubmitError,
  BrokerPreSubmitRefusedError,
} from "../../dist/box/brokerAdapter.js";
import {
  BoxOrderManager,
  OrderPersistenceAfterFillError,
} from "../../dist/box/orderManager.js";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];
const immutable = [
  "broker_mode", "trade_id", "attempt_id", "role", "purpose", "phase",
  "exchange", "tradingsymbol", "token", "side", "quantity",
  "reference_price", "tick_size", "max_chase_ticks", "limit_price",
];

const clone = (value) => structuredClone(value);

const request = (overrides = {}) => {
  const role = overrides.role ?? "k1_ce";
  const purpose = overrides.purpose ?? "ENTRY";
  const attempt = overrides.attempt_id ?? `attempt-${role}`;
  const trade = overrides.trade_id ?? "trade-1";
  return {
    client_order_id: overrides.client_order_id ?? `BOX:${trade}:${purpose}:${role}:${attempt}`,
    role,
    trade_id: trade,
    attempt_id: attempt,
    purpose,
    phase: overrides.phase ?? (purpose === "ENTRY" ? "entry" : purpose === "EMERGENCY_RESIDUAL" ? "unwind" : "exit"),
    exchange: overrides.exchange ?? "NFO",
    tradingsymbol: overrides.tradingsymbol ?? `SYM-${role}`,
    token: overrides.token ?? 1000 + ROLES.indexOf(role),
    side: overrides.side ?? (purpose === "ENTRY" ? "BUY" : "SELL"),
    quantity: overrides.quantity ?? 75,
    pricing: overrides.pricing ?? {
      order_type: "LIMIT",
      reference_price: 100,
      tick_size: 0.05,
      max_chase_ticks: 2,
      limit_price: overrides.side === "SELL" ? 99.9 : 100.1,
    },
    ...(overrides.tag ? { tag: overrides.tag } : {}),
  };
};

function intentFrom(req, state = "CREATED", filled = 0) {
  const at = new Date(1_000);
  return {
    client_order_id: req.client_order_id,
    broker_order_id: state === "CREATED" || state === "SUBMITTING" ? null : `B-${req.client_order_id}`,
    broker_mode: "live",
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
    state,
    filled_quantity: filled,
    average_price: filled > 0 ? 100 : null,
    broker_tag: req.tag ?? null,
    reject_family: null,
    reject_reason: null,
    created_at: at,
    updated_at: at,
    terminal_at: ["COMPLETE", "CANCELLED", "REJECTED"].includes(state) ? at : null,
    audit: [],
  };
}

function orderFrom(req, overrides = {}) {
  const filled = overrides.filled_quantity ?? req.quantity;
  const state = overrides.state ?? (filled === req.quantity ? "COMPLETE" : "PARTIALLY_FILLED");
  return {
    client_order_id: req.client_order_id,
    broker_order_id: overrides.broker_order_id ?? `B-${req.client_order_id}`,
    tag: overrides.tag ?? req.tag ?? null,
    role: req.role,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: overrides.quantity ?? req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state,
    filled_quantity: filled,
    pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? 100 : null,
    fills: filled > 0 ? [{ fill_id: overrides.fill_id ?? `fill-${req.client_order_id}-${filled}`, quantity: filled, price: 100, at: 2_000 }] : [],
    reject_family: null,
    reject_reason: null,
    created_at: 1_000,
    updated_at: 2_000,
  };
}

class MemoryPersistence {
  constructor(intents = []) {
    this.rows = new Map(intents.map((intent) => [intent.client_order_id, clone(intent)]));
    this.events = [];
  }
  async create(intent) {
    this.events.push(["create", intent.client_order_id, intent.state]);
    const current = this.rows.get(intent.client_order_id);
    if (current) {
      for (const key of immutable) {
        if (current[key] !== intent[key]) throw new Error(`immutable mismatch: ${key}`);
      }
      return clone(current);
    }
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  /**
   * Models the real guarded write, INCLUDING the property that makes attribution safe: the
   * update reports the transition it established (`previous_filled_quantity` /
   * `current_filled_quantity`), stamped from the pre-image, exactly as the Mongo aggregation
   * `$set` does. The `$lte` fill guard is deliberately NON-strict here too — re-writing the same
   * cumulative quantity matches and reports `applied: true` — because that is what makes a naive
   * caller-snapshot delta double-count.
   */
  async update(clientOrderId, patch, audit, expectedStates) {
    const current = this.rows.get(clientOrderId);
    this.events.push(["update", clientOrderId, patch.state ?? current?.state]);
    if (!current) {
      return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
    }
    if (expectedStates && !expectedStates.includes(current.state)) {
      return {
        intent: clone(current),
        applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
    }
    if (patch.filled_quantity !== undefined && patch.filled_quantity < current.filled_quantity) {
      return {
        intent: clone(current),
        applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
    }
    const next = { ...current, ...clone(patch), previous_filled_quantity: current.filled_quantity };
    if (!next.audit.some((item) => item.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
    this.rows.set(clientOrderId, next);
    return {
      intent: clone(next),
      applied: true,
      previous_filled_quantity: current.filled_quantity,
      current_filled_quantity: next.filled_quantity,
    };
  }
  async loadNonterminal() {
    return [...this.rows.values()]
      .filter((intent) => !["COMPLETE", "CANCELLED", "REJECTED"].includes(intent.state))
      .map(clone);
  }
  async loadOwned() { return [...this.rows.values()].map(clone); }
  async findByClientId(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }
  async findByBrokerId(id) {
    const found = [...this.rows.values()].find((intent) => intent.broker_order_id === id);
    return found ? clone(found) : null;
  }
}

function fakeAdapter(options = {}) {
  const calls = [];
  const orders = new Map((options.orders ?? []).map((order) => [order.client_order_id, clone(order)]));
  let active = 0;
  let maxActive = 0;
  const adapter = {
    mode: "live",
    calls,
    orders,
    get maxActive() { return maxActive; },
    prepareOrder: (req) => ({ ...req, pricing: { ...req.pricing }, tag: req.tag ?? `TAG${req.role}` }),
    submitOrder: async (req, beforePost) => {
      await options.beforePost?.(req, adapter);
      beforePost?.();
      calls.push(["submit", req.purpose, req.role, req.client_order_id, req.quantity]);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        const result = options.submit ? await options.submit(req, adapter) : orderFrom(req);
        if (result) orders.set(req.client_order_id, clone(result));
        return clone(result);
      } finally {
        active--;
      }
    },
    cancelOrder: async (id) => { calls.push(["cancel", id]); return orders.get(id); },
    getOrder: async (id) => { calls.push(["get", id]); return orders.has(id) ? clone(orders.get(id)) : undefined; },
    listOrders: async () => (options.listOrders ? options.listOrders() : [...orders.values()].map(clone)),
    listPositions: async () => clone(options.positions ?? []),
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (intent, snapshot) => {
      if (options.adopt) return options.adopt(intent, snapshot);
      if (snapshot.quantity !== intent.quantity || snapshot.tradingsymbol !== intent.tradingsymbol || snapshot.side !== intent.side) {
        throw new Error("immutable broker snapshot mismatch");
      }
      return { ...clone(snapshot), client_order_id: intent.client_order_id };
    },
  };
  return adapter;
}

const limits = (overrides = {}) => ({
  maxOpenBoxes: 10,
  maxConcurrentExecutions: 1,
  maxResidualLegs: 10,
  dailyLossLimit: 1_000_000,
  rejectLimit: 100,
  consecutiveFailureLimit: 100,
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 60_000,
  feedReconnectWarmupMs: 0,
  ...overrides,
});

async function managerHarness({
  persistence = new MemoryPersistence(),
  adapter = fakeAdapter(),
  limitOverrides = {},
  reconcile = true,
  revalidateQueuedRequest,
  isCrashRecoveryPersistenceReady,
} = {}) {
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter,
    persistence,
    limits: limits(limitOverrides),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-02",
    ...(revalidateQueuedRequest ? { revalidateQueuedRequest } : {}),
    ...(isCrashRecoveryPersistenceReady ? { isCrashRecoveryPersistenceReady } : {}),
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  if (reconcile) await manager.reconcile();
  return { manager, persistence, adapter };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const feedStamp = (req, generation = 1, version = 1, at = 9_000) => ({
  token: req.token,
  feed_generation: generation,
  quote_version: version,
  quote_at: at,
  checked_at: at,
});

test("CREATED and SUBMITTING are durable before transport submission", async () => {
  const persistence = new MemoryPersistence();
  let adapter;
  adapter = fakeAdapter({
    submit: async (req) => {
      assert.equal(persistence.rows.get(req.client_order_id).state, "SUBMITTING");
      persistence.events.push(["transport", req.client_order_id]);
      return orderFrom(req);
    },
  });
  const h = await managerHarness({ persistence, adapter });
  persistence.events.length = 0;

  await h.manager.submit(request());
  assert.deepEqual(
    persistence.events.slice(0, 3).map((event) => [event[0], event[2]]),
    [["create", "CREATED"], ["update", "SUBMITTING"], ["transport", undefined]],
  );
});

test("reused client ID with immutable mismatch is rejected without a second submit", async () => {
  const h = await managerHarness();
  const original = request();
  await h.manager.submit(original);
  await tick();
  await assert.rejects(
    () => h.manager.submit({ ...original, quantity: 74 }),
    /immutable mismatch: quantity/,
  );
  assert.equal(h.adapter.calls.filter(([name]) => name === "submit").length, 1);
});

test("one Box queues all four role orders with max concurrency one", async () => {
  const adapter = fakeAdapter({
    submit: async (req) => { await tick(); return orderFrom(req); },
  });
  const h = await managerHarness({ adapter, limitOverrides: { maxConcurrentExecutions: 1 } });
  const requests = ROLES.map((role) => request({ role, attempt_id: "box-attempt" }));

  await Promise.all(requests.map((item) => h.manager.submit(item)));
  assert.equal(adapter.maxActive, 1);
  assert.deepEqual(adapter.calls.filter(([name]) => name === "submit").map(([, , role]) => role), ROLES);
});

test("queued work is ordered emergency > cancel > exit > entry", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let first = true;
  const adapter = fakeAdapter({
    submit: async (req) => {
      if (first) { first = false; await blocked; }
      return orderFrom(req);
    },
  });
  const h = await managerHarness({ adapter });
  h.manager.setAttributedBoxPositions([{ token: 99, exchange: "NFO", tradingsymbol: "REDUCE", net_quantity: 500, average_price: 100 }]);

  const blocker = h.manager.submit(request({ role: "k1_ce", attempt_id: "blocker" }));
  await tick();
  const queuedEntry = h.manager.submit(request({ role: "k2_ce", attempt_id: "queued-entry" }));
  const queuedExit = h.manager.submit(request({ role: "k2_pe", purpose: "EXIT", attempt_id: "queued-exit", tradingsymbol: "REDUCE", token: 99, side: "SELL" }));
  const queuedCancel = h.manager.cancelWorkingBoxOrders();
  await tick();
  const queuedEmergency = h.manager.submit(request({ role: "k1_ce", purpose: "EMERGENCY_RESIDUAL", attempt_id: "queued-emergency", tradingsymbol: "REDUCE", token: 99, side: "SELL" }));
  release();
  await Promise.all([blocker, queuedEntry, queuedExit, queuedCancel, queuedEmergency]);

  assert.deepEqual(
    adapter.calls
      .filter(([name]) => name === "submit" || name === "cancel")
      .map(([name, purpose]) => name === "cancel" ? "PROTECTIVE_CANCEL" : purpose),
    ["ENTRY", "EMERGENCY_RESIDUAL", "PROTECTIVE_CANCEL", "EXIT", "ENTRY"],
  );
});

test("queued ENTRY, EXIT, and emergency reductions cannot cross a feed generation", async (t) => {
  for (const purpose of ["ENTRY", "EXIT", "EMERGENCY_RESIDUAL"]) {
    await t.test(purpose, async () => {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let holdFirst = true;
      let generation = 1;
      const adapter = fakeAdapter({
        submit: async (req) => {
          if (holdFirst) {
            holdFirst = false;
            await held;
          }
          return orderFrom(req);
        },
      });
      const validate = (req, stamp) =>
        !stamp || stamp.token !== req.token || stamp.feed_generation !== generation
          ? "feed generation changed while order was queued"
          : null;
      const h = await managerHarness({ adapter, revalidateQueuedRequest: validate });
      const blockerReq = request({ role: "k1_ce", attempt_id: `blocker-${purpose}` });
      const blocker = h.manager.submit(blockerReq, feedStamp(blockerReq));
      await tick();

      const queuedReq = purpose === "ENTRY"
        ? request({ role: "k2_ce", purpose, attempt_id: `stale-${purpose}` })
        : request({
            role: "k2_ce",
            purpose,
            attempt_id: `stale-${purpose}`,
            phase: purpose === "EXIT" ? "exit" : "unwind",
            tradingsymbol: `REDUCE-${purpose}`,
            token: 8_000 + (purpose === "EXIT" ? 1 : 2),
            side: "SELL",
          });
      if (purpose !== "ENTRY") {
        h.manager.setAttributedBoxPositions([{
          token: queuedReq.token,
          exchange: "NFO",
          tradingsymbol: queuedReq.tradingsymbol,
          net_quantity: queuedReq.quantity,
          average_price: 100,
        }]);
      }
      const queued = h.manager.submit(queuedReq, feedStamp(queuedReq));
      generation = 2;
      release();
      await blocker;
      const error = await queued.then(() => null, (reason) => reason);

      assert.ok(error instanceof BrokerPreSubmitRefusedError);
      assert.equal(error.stage, "dequeue");
      assert.equal(error.durableIdentitySpent, true);
      assert.equal(h.persistence.rows.get(queuedReq.client_order_id).state, "REJECTED");
      const refusalAudit = h.persistence.rows.get(queuedReq.client_order_id).audit.at(-1);
      assert.deepEqual(refusalAudit.payload, {
        origin: "local_pre_submit_refusal",
        no_broker_post: true,
        stage: "dequeue",
        reason: "feed generation changed while order was queued",
      });
      assert.equal(
        adapter.calls.some(([name, , , clientId]) => name === "submit" && clientId === queuedReq.client_order_id),
        false,
        "the stale queued request made no adapter POST",
      );
      assert.equal(h.manager.status().rejects, 0, "a local refusal is not a broker rejection");
    });
  }
});

test("generation change after SUBMITTING but before broker POST is locally terminal", async () => {
  let generation = 1;
  const req = request({ attempt_id: "pre-post-reset" });
  const adapter = fakeAdapter({
    beforePost: async (candidate) => {
      if (candidate.client_order_id === req.client_order_id) generation = 2;
    },
  });
  const h = await managerHarness({
    adapter,
    revalidateQueuedRequest: (candidate, stamp) =>
      stamp?.token === candidate.token && stamp.feed_generation === generation
        ? null
        : "feed generation changed before broker POST",
  });

  const error = await h.manager.submit(req, feedStamp(req)).then(() => null, (reason) => reason);
  assert.ok(error instanceof BrokerPreSubmitRefusedError);
  assert.equal(error.stage, "pre_post");
  assert.equal(h.persistence.rows.get(req.client_order_id).state, "REJECTED");
  assert.deepEqual(h.persistence.rows.get(req.client_order_id).audit.at(-1).payload, {
    origin: "local_pre_submit_refusal",
    no_broker_post: true,
    stage: "pre_post",
    reason: "feed generation changed before broker POST",
  });
  assert.equal("feed_generation" in h.persistence.rows.get(req.client_order_id), false);
  assert.equal("quote_version" in h.persistence.rows.get(req.client_order_id), false);
  assert.equal(adapter.calls.filter(([name]) => name === "submit").length, 0);
  assert.equal(h.manager.status().unknownOrders, 0, "known local refusal is not broker uncertainty");
  assert.equal(h.manager.status().rejects, 0);
});

test("a lost pre-POST refusal CAS is reconciliation, never local no-POST provenance", async () => {
  let generation = 1;
  const req = request({ attempt_id: "pre-post-refusal-cas-loser" });
  const persistence = new MemoryPersistence();
  const update = persistence.update.bind(persistence);
  persistence.update = async (clientOrderId, patch, audit, expectedStates) => {
    if (patch.state === "REJECTED" && expectedStates?.includes("SUBMITTING")) {
      const current = persistence.rows.get(clientOrderId);
      const externallyAdvanced = {
        ...current,
        state: "REJECTED",
        reject_reason: "external broker outcome",
        terminal_at: new Date(10_002),
      };
      persistence.rows.set(clientOrderId, externallyAdvanced);
      return {
        intent: clone(externallyAdvanced),
        applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
    }
    return update(clientOrderId, patch, audit, expectedStates);
  };
  const adapter = fakeAdapter({
    beforePost: async () => { generation = 2; },
  });
  const h = await managerHarness({
    persistence,
    adapter,
    revalidateQueuedRequest: (candidate, stamp) =>
      stamp?.token === candidate.token && stamp.feed_generation === generation
        ? null
        : "generation changed at final boundary",
  });

  const error = await h.manager.submit(req, feedStamp(req)).then(() => null, (reason) => reason);
  assert.ok(error instanceof BrokerAmbiguousSubmitError);
  assert.equal(error instanceof BrokerPreSubmitRefusedError, false);
  assert.equal(adapter.calls.filter(([name]) => name === "submit").length, 0);
  assert.match(error.message, /reconciliation is required/);
  assert.equal(
    persistence.rows.get(req.client_order_id).audit.some((event) =>
      event.payload?.origin === "local_pre_submit_refusal"),
    false,
    "the CAS loser cannot stamp local-no-POST provenance onto another actor's rejection",
  );
});

test("stale feed evidence never hides adoption of an existing non-CREATED intent", async () => {
  const req = request({
    purpose: "EMERGENCY_RESIDUAL",
    phase: "unwind",
    side: "SELL",
    attempt_id: "adopt-across-feed-reset",
  });
  const durable = intentFrom(req, "SUBMITTING", 0);
  const broker = orderFrom(req);
  const persistence = new MemoryPersistence([durable]);
  const adapter = fakeAdapter({ orders: [broker] });
  const h = await managerHarness({
    persistence,
    adapter,
    reconcile: false,
    revalidateQueuedRequest: () => "feed generation is stale",
  });

  h.manager.setAttributedBoxPositions([{
    token: req.token,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    net_quantity: req.quantity,
    average_price: 100,
  }]);
  const adopted = await h.manager.submit(req, feedStamp(req));
  assert.equal(adopted.state, "COMPLETE");
  assert.equal(adapter.calls.filter(([name]) => name === "submit").length, 0);
  assert.equal(adapter.calls.filter(([name]) => name === "get").length, 1);
  assert.equal(persistence.rows.get(req.client_order_id).state, "COMPLETE");
});

test("two managers racing one CREATED identity produce exactly one broker placement", async () => {
  const persistence = new MemoryPersistence();
  const create = persistence.create.bind(persistence);
  let arrivals = 0;
  let releaseCreates;
  const bothCreated = new Promise((resolve) => { releaseCreates = resolve; });
  persistence.create = async (intent) => {
    const created = await create(intent);
    arrivals++;
    if (arrivals === 2) releaseCreates();
    await bothCreated;
    return created;
  };
  let placements = 0;
  const adapterA = fakeAdapter({ submit: async (req) => { placements++; return orderFrom(req); } });
  const adapterB = fakeAdapter({ submit: async (req) => { placements++; return orderFrom(req); } });
  const [a, b] = await Promise.all([
    managerHarness({ persistence, adapter: adapterA }),
    managerHarness({ persistence, adapter: adapterB }),
  ]);
  const req = request({
    purpose: "EMERGENCY_RESIDUAL",
    phase: "unwind",
    side: "SELL",
    attempt_id: "cross-process-race",
  });
  for (const h of [a, b]) {
    h.manager.setAttributedBoxPositions([{
      token: req.token,
      exchange: req.exchange,
      tradingsymbol: req.tradingsymbol,
      net_quantity: req.quantity,
      average_price: 100,
    }]);
  }

  const settled = await Promise.allSettled([
    a.manager.submit(req),
    b.manager.submit(req),
  ]);
  assert.equal(placements, 1, "only the applied CREATED -> SUBMITTING CAS winner may POST");
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const loser = settled.find((item) => item.status === "rejected");
  assert.ok(loser.reason instanceof BrokerAmbiguousSubmitError);
  assert.match(loser.reason.message, /attempted no broker POST/);
  assert.equal(persistence.rows.get(req.client_order_id).state, "COMPLETE");
});

test("a lost local-refusal CAS cannot claim no-POST provenance", async () => {
  const req = request({ attempt_id: "local-refusal-cas-loser" });
  const persistence = new MemoryPersistence();
  const update = persistence.update.bind(persistence);
  persistence.update = async (clientOrderId, patch, audit, expectedStates) => {
    if (patch.state === "REJECTED" && expectedStates) {
      const current = persistence.rows.get(clientOrderId);
      const brokerRejected = {
        ...current,
        state: "REJECTED",
        reject_reason: "broker rejected elsewhere",
        terminal_at: new Date(10_001),
      };
      persistence.rows.set(clientOrderId, brokerRejected);
      return {
        intent: clone(brokerRejected),
        applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
    }
    return update(clientOrderId, patch, audit, expectedStates);
  };
  const h = await managerHarness({
    persistence,
    revalidateQueuedRequest: () => "feed generation changed",
  });

  const error = await h.manager.submit(req, feedStamp(req)).then(() => null, (reason) => reason);
  assert.ok(error instanceof BrokerAmbiguousSubmitError);
  assert.equal(error instanceof BrokerPreSubmitRefusedError, false);
  assert.equal(h.adapter.calls.filter(([name]) => name === "submit").length, 0);
  assert.equal(h.manager.status().durableTransitionRefusals, 1);
  assert.equal(
    persistence.rows.get(req.client_order_id).audit.some((event) =>
      event.payload?.origin === "local_pre_submit_refusal"),
    false,
  );
});

test("reductions must use the exact reducing side/quantity and cannot cross flat", async () => {
  const h = await managerHarness();
  h.manager.setAttributedBoxPositions([{ token: 99, exchange: "NFO", tradingsymbol: "HELD", net_quantity: 75, average_price: 100 }]);
  const base = { purpose: "EXIT", tradingsymbol: "HELD", token: 99, phase: "exit" };

  // The refusal REASON is asserted, not just the refusal: an operator reading it must be able to tell
  // "this reduction points the wrong way" from "this reduction overshoots into new exposure".
  await assert.rejects(
    () => h.manager.submit(request({ ...base, attempt_id: "wrong-side", side: "BUY", quantity: 75 })),
    /would not reduce the attributed net position/,
  );
  await assert.rejects(
    () => h.manager.submit(request({ ...base, attempt_id: "cross-flat", side: "SELL", quantity: 76 })),
    /overshoot the attributed net position/,
  );
  const exact = await h.manager.submit(request({ ...base, attempt_id: "exact", side: "SELL", quantity: 75 }));
  assert.equal(exact.filled_quantity, 75);
  await assert.rejects(
    () => h.manager.submit(request({ ...base, attempt_id: "after-flat", side: "SELL", quantity: 1 })),
    /would not reduce the attributed net position \(0\)/,
  );
  assert.equal(h.adapter.calls.filter(([name]) => name === "submit").length, 1);
});

test("ambiguous submit is durable and never blindly retried", async () => {
  const adapter = fakeAdapter({
    submit: async (req) => {
      const uncertain = orderFrom(req, { state: "RECONCILIATION_REQUIRED", filled_quantity: 0 });
      throw new BrokerAmbiguousSubmitError(req.client_order_id, "placement ambiguous", undefined, uncertain);
    },
  });
  const h = await managerHarness({ adapter });
  const req = request({ purpose: "PROTECTIVE_CANCEL", phase: "exit", attempt_id: "ambiguous-cancel" });

  await assert.rejects(() => h.manager.submit(req), BrokerAmbiguousSubmitError);
  await tick();
  assert.equal(h.persistence.rows.get(req.client_order_id).state, "RECONCILIATION_REQUIRED");
  await assert.rejects(() => h.manager.submit(req), /requires reconciliation before resubmit/);
  assert.equal(adapter.calls.filter(([name]) => name === "submit").length, 1);
});

test("reconciliation missing intent or immutable mismatch trips recovery and blocks entry", async (t) => {
  for (const scenario of ["missing", "mismatch"]) {
    await t.test(scenario, async () => {
      const req = request({ trade_id: `trade-${scenario}`, attempt_id: scenario });
      const durable = intentFrom(req, "SUBMITTING", 0);
      const persistence = new MemoryPersistence([durable]);
      const broker = orderFrom(req, scenario === "mismatch" ? { quantity: 74, filled_quantity: 0, state: "OPEN" } : { filled_quantity: 0, state: "OPEN" });
      const adapter = fakeAdapter({
        orders: scenario === "mismatch" ? [broker] : [],
        listOrders: () => scenario === "mismatch" ? [clone(broker)] : [],
      });
      const h = await managerHarness({ persistence, adapter, reconcile: false });

      const report = await h.manager.reconcile();
      assert.equal(h.manager.status().recoveryActive, true);
      assert.equal(h.manager.status().circuitBreaker.tripped, true);
      assert.equal(h.manager.status().health.reconciliation_complete, false);
      if (scenario === "missing") assert.deepEqual(report.missingAtBroker, [req.client_order_id]);
      else assert.equal(report.affectedTradeIds.includes(req.trade_id), true);
      // The reason names the breaker, not a generic "controls closed".
      await assert.rejects(
        () => h.manager.submit(request({ trade_id: "new", attempt_id: `blocked-${scenario}` })),
        /Entry cannot be sent: .*(breaker|Recovery|recovery)/,
      );
      assert.equal(adapter.calls.filter(([name]) => name === "submit").length, 0);
    });
  }
});

test("duplicate cumulative fill snapshots are idempotent", async () => {
  const req = request({ trade_id: "filled-trade", attempt_id: "filled" });
  const durable = intentFrom(req, "COMPLETE", 75);
  const broker = orderFrom(req, { fill_id: "same-fill" });
  const persistence = new MemoryPersistence([durable]);
  const adapter = fakeAdapter({
    orders: [broker],
    listOrders: () => [clone(broker), clone(broker)].slice(0, 1),
    positions: [{ token: req.token, exchange: req.exchange, tradingsymbol: req.tradingsymbol, net_quantity: 75, average_price: 100 }],
  });
  const h = await managerHarness({ persistence, adapter });
  await h.manager.reconcile();

  await assert.rejects(
    () => h.manager.submit(request({ purpose: "EXIT", phase: "exit", trade_id: "filled-trade", attempt_id: "too-much", tradingsymbol: req.tradingsymbol, token: req.token, side: "SELL", quantity: 76 })),
    /overshoot the attributed net position/,
  );
  const reduced = await h.manager.submit(request({ purpose: "EXIT", phase: "exit", trade_id: "filled-trade", attempt_id: "exact-reduce", tradingsymbol: req.tradingsymbol, token: req.token, side: "SELL", quantity: 75 }));
  assert.equal(reduced.filled_quantity, 75);
});

test("restart loads nonterminal work and reconstructs only the unfilled reservation", async () => {
  const req = request({ trade_id: "restart-trade", attempt_id: "restart", quantity: 75 });
  const durable = intentFrom(req, "PARTIALLY_FILLED", 40);
  const broker = orderFrom(req, { state: "PARTIALLY_FILLED", filled_quantity: 40, fill_id: "restart-fill-40" });
  const persistence = new MemoryPersistence([durable]);
  const adapter = fakeAdapter({
    orders: [broker],
    listOrders: () => [clone(broker)],
    positions: [{ token: req.token, exchange: req.exchange, tradingsymbol: req.tradingsymbol, net_quantity: 40, average_price: 100 }],
  });

  const h = await managerHarness({ persistence, adapter });
  assert.equal(h.manager.status().reservedEntryQuantity, 35, "75 requested - 40 cumulatively filled = 35 reserved after restart");
  assert.equal(h.manager.status().unknownOrders, 0);
});


test("confirmed broker fills remain attached when their durable snapshot update fails", async () => {
  class FailingAfterFillPersistence extends MemoryPersistence {
    async update(clientOrderId, patch, audit) {
      if (patch.filled_quantity > 0) throw new Error("mongo unavailable after fill");
      return super.update(clientOrderId, patch, audit);
    }
  }
  const persistence = new FailingAfterFillPersistence();
  const h = await managerHarness({ persistence });
  const req = request({ attempt_id: "fill-persistence-loss" });

  await assert.rejects(
    () => h.manager.submit(req),
    (error) => {
      assert.equal(error instanceof OrderPersistenceAfterFillError, true);
      assert.equal(error.order.client_order_id, req.client_order_id);
      assert.equal(error.order.filled_quantity, 75);
      return true;
    },
  );
  assert.equal(h.manager.status().health.persistence, "unhealthy");
  assert.equal(h.manager.status().circuitBreaker.tripped, true);
});

test("queued entries re-check runtime controls before broker submission", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let first = true;
  const adapter = fakeAdapter({
    submit: async (req) => {
      if (first) { first = false; await blocked; }
      return orderFrom(req);
    },
  });
  const h = await managerHarness({ adapter });
  const firstOrder = h.manager.submit(request({ role: "k1_ce", attempt_id: "active-before-disable" }));
  await tick();
  const queued = ROLES.slice(1).map((role) =>
    h.manager.submit(request({ role, attempt_id: "queued-before-disable" })),
  );
  h.manager.setControls({ entryEnabled: false, liveOrderEnabled: false });
  release();

  const results = await Promise.allSettled([firstOrder, ...queued]);
  assert.equal(results[0].status, "fulfilled", "already-submitted broker work is observed to completion");
  assert.equal(results.slice(1).every((item) => item.status === "rejected"), true);
  assert.equal(adapter.calls.filter(([name]) => name === "submit").length, 1);
  assert.equal(h.manager.status().queued, 0);
  assert.equal(h.manager.status().reservedEntryQuantity, 0);
});

test("reconciliation derives exact exposure from the adopted broker snapshot in the same pass", async () => {
  const entryReq = request({ trade_id: "restart-exact", attempt_id: "entry", side: "BUY" });
  const exitReq = request({
    trade_id: "restart-exact",
    attempt_id: "exit",
    purpose: "EXIT",
    phase: "exit",
    side: "SELL",
    tradingsymbol: entryReq.tradingsymbol,
    token: entryReq.token,
  });
  const entryIntent = intentFrom(entryReq, "COMPLETE", 75);
  const exitIntent = intentFrom(exitReq, "PARTIALLY_FILLED", 40);
  const entryOrder = orderFrom(entryReq, { state: "COMPLETE", filled_quantity: 75 });
  const completedExit = orderFrom(exitReq, { state: "COMPLETE", filled_quantity: 75 });
  const persistence = new MemoryPersistence([entryIntent, exitIntent]);
  const adapter = fakeAdapter({
    orders: [entryOrder, completedExit],
    listOrders: () => [clone(entryOrder), clone(completedExit)],
    positions: [],
  });
  const h = await managerHarness({ persistence, adapter, reconcile: false });

  const report = await h.manager.reconcile();
  assert.equal(report.positionMismatches.length, 0);
  assert.equal(report.remainingByTrade["restart-exact"].k1_ce, 0);
  assert.equal(h.manager.status().health.reconciliation_complete, true);
  assert.equal(h.manager.status().reservedReductionQuantity, 0);
});

test("feed reconnect warm-up blocks entry until its deterministic deadline", async () => {
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits({ feedReconnectWarmupMs: 5_000 }),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: false },
    clock: { now: () => now },
    istDayKey: () => "2026-09-02",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  await manager.reconcile();
  manager.setFeedHealthy(false);
  manager.setFeedHealthy(true);

  assert.equal(manager.status().health.feed, "warming");
  assert.equal(manager.canEnter(), false);
  now += 4_999;
  assert.equal(manager.canEnter(), false);
  now += 1;
  assert.equal(manager.status().health.feed, "healthy");
  assert.equal(manager.canEnter(), true);
});


test("startup reconciliation failure keeps the retry timer armed and persistence unhealthy", async () => {
  class FlakyPersistence extends MemoryPersistence {
    failLoads = true;
    async loadNonterminal() {
      if (this.failLoads) throw new Error("mongo read unavailable");
      return super.loadNonterminal();
    }
  }
  const persistence = new FlakyPersistence();
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence,
    limits: limits(),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => "2026-09-02",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);

  await assert.rejects(() => manager.start(), /mongo read unavailable/);
  assert.notEqual(manager.reconcileTimer, null, "periodic reconciliation remains armed after initial failure");
  assert.equal(manager.status().health.persistence, "unhealthy");
  assert.equal(manager.status().health.reconciliation_complete, false);

  persistence.failLoads = false;
  await manager.reconcile();
  assert.equal(manager.status().health.persistence, "healthy");
  manager.dispose();
});

test("startup seed installation merges post-load flatten charges not represented by its snapshot", async () => {
  let resolveSeed;
  const deferredSeed = new Promise((resolve) => { resolveSeed = resolve; });
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: false, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => "2026-09-07",
  });
  const seedToken = manager.beginDailyRiskSeed("2026-09-07");
  const install = (async () => {
    const seed = await deferredSeed;
    manager.seedLimits({
      tradingDay: "2026-09-07",
      realisedPnlToday: seed.realisedPnl,
      rejects: seed.rejects,
      consecutiveFailures: seed.consecutiveFailures,
      seedToken,
      flattenChargeBaselinesForDay: seed.flattenChargeBaselinesForDay,
    });
  })();

  // Both observations land after the load boundary. The eventual Mongo snapshot includes A but
  // not B: installation must neither double A nor overwrite B.
  manager.recordFlattenCharge({
    attemptId: "startup-A",
    chargeDay: "2026-09-07",
    previousChargesForDay: 0,
    chargesForDay: 4,
  });
  manager.recordFlattenCharge({
    attemptId: "startup-B",
    chargeDay: "2026-09-07",
    previousChargesForDay: 0,
    chargesForDay: 6,
  });
  resolveSeed({
    realisedPnl: -4,
    rejects: 0,
    consecutiveFailures: 0,
    flattenChargeBaselinesForDay: { "startup-A": 4 },
  });
  await install;

  assert.equal(manager.status().realisedPnlToday, -10,
    "the represented charge is present once and the post-snapshot charge is merged once");
  manager.dispose();
});

test("an arbitrarily slow startup seed retains every post-load charge mutation", () => {
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: false, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => "2026-09-07",
  });
  const seedToken = manager.beginDailyRiskSeed("2026-09-07");
  for (let index = 0; index < 2_050; index++) {
    manager.recordFlattenCharge({
      attemptId: "slow-loader-attempt",
      chargeDay: "2026-09-07",
      previousChargesForDay: index,
      chargesForDay: index + 1,
    });
  }
  assert.deepEqual(manager.status().riskBookkeeping, {
    activeSeedTokens: 1,
    activeLoadGeneration: null,
    retainedMutationCount: 2_050,
    retainedMutationDayBuckets: 1,
  }, "an actually active loader retains the complete >2048 mutation suffix");
  manager.seedLimits({
    tradingDay: "2026-09-07",
    realisedPnlToday: 0,
    seedToken,
    flattenChargeBaselinesForDay: {},
  });
  assert.equal(manager.status().realisedPnlToday, -2_050,
    "the in-flight merge journal is lossless rather than capped");
  assert.equal(manager.status().riskBookkeeping.retainedMutationCount, 0,
    "the represented range compacts immediately after the loader settles");
  assert.equal(manager.status().riskBookkeeping.activeSeedTokens, 0);
  manager.dispose();
});

test("overlapping same-day seed installs each retain post-snapshot flatten charges", () => {
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: false, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => "2026-09-07",
  });
  const olderLoader = manager.beginDailyRiskSeed("2026-09-07");
  const newerLoader = manager.beginDailyRiskSeed("2026-09-07");
  manager.recordFlattenCharge({
    attemptId: "overlap",
    chargeDay: "2026-09-07",
    previousChargesForDay: 0,
    chargesForDay: 7.5,
  });

  manager.seedLimits({
    tradingDay: "2026-09-07",
    realisedPnlToday: 0,
    seedToken: newerLoader,
    flattenChargeBaselinesForDay: {},
  });
  assert.equal(manager.status().realisedPnlToday, -7.5);
  manager.seedLimits({
    tradingDay: "2026-09-07",
    realisedPnlToday: 0,
    seedToken: olderLoader,
    flattenChargeBaselinesForDay: {},
  });
  assert.equal(manager.status().realisedPnlToday, -7.5,
    "the later-arriving snapshot cannot erase a charge merged by an earlier install");
  manager.dispose();
});

test("rollover seed installation merges deferred post-load charges exactly once", async () => {
  let day = "2026-09-07";
  let resolveSeed;
  const loaderStarted = new Promise((resolve) => {
    resolveSeed = (seed) => resolve(seed);
  });
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: false, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => day,
    loadDailyRiskSeed: () => loaderStarted,
  });
  manager.seedLimits({ tradingDay: day });

  day = "2026-09-08";
  assert.equal(manager.status().tradingDay, day, "status deterministically starts rollover seeding");
  manager.recordFlattenCharge({
    attemptId: "rollover-A",
    chargeDay: day,
    previousChargesForDay: 0,
    chargesForDay: 3.5,
  });
  manager.recordFlattenCharge({
    attemptId: "rollover-B",
    chargeDay: day,
    previousChargesForDay: 2,
    chargesForDay: 7,
  });
  resolveSeed({
    realisedPnl: -3.5,
    rejects: 0,
    consecutiveFailures: 0,
    flattenChargeBaselinesForDay: { "rollover-A": 3.5, "rollover-B": 4 },
  });
  await tick();
  await tick();

  assert.equal(manager.status().realisedPnlToday, -6.5,
    "A is already in the seed and only B's suffix above the seed bucket is merged");
  manager.dispose();
});

test("a stale rollover loader cannot alter the new trading day and immediately reloads it", async () => {
  let day = "2026-09-07";
  let resolveOldSeed;
  let resolveCurrentSeed;
  const oldSeed = new Promise((resolve) => { resolveOldSeed = resolve; });
  const currentSeed = new Promise((resolve) => { resolveCurrentSeed = resolve; });
  const loadedDays = [];
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: false, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => day,
    loadDailyRiskSeed: (requestedDay) => {
      loadedDays.push(requestedDay);
      return requestedDay === "2026-09-08" ? oldSeed : currentSeed;
    },
  });
  manager.seedLimits({ tradingDay: day });

  day = "2026-09-08";
  manager.status();
  day = "2026-09-09";
  manager.status();
  manager.recordFlattenCharge({
    attemptId: "new-day",
    chargeDay: day,
    previousChargesForDay: 0,
    chargesForDay: 2.25,
  });
  resolveOldSeed({
    realisedPnl: -999,
    rejects: 99,
    consecutiveFailures: 99,
    flattenChargeBaselinesForDay: {},
  });
  await tick();

  assert.deepEqual(loadedDays, ["2026-09-08", "2026-09-09"],
    "settling the stale loader immediately opens a loader slot for the current day");
  let status = manager.status();
  assert.equal(status.tradingDay, "2026-09-09");
  assert.equal(status.realisedPnlToday, -2.25);
  assert.equal(status.rejects, 0);
  assert.equal(status.consecutiveFailures, 0);

  resolveCurrentSeed({
    realisedPnl: -2.25,
    rejects: 0,
    consecutiveFailures: 0,
    flattenChargeBaselinesForDay: { "new-day": 2.25 },
  });
  await tick();
  await tick();
  status = manager.status();
  assert.equal(status.health.daily_risk_seed, "healthy");
  assert.equal(status.realisedPnlToday, -2.25);
  manager.dispose();
});

test("an incomplete daily-risk reconstruction is never treated as an authoritative seed", async () => {
  let day = "2026-09-07";
  const seeds = [];
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => day,
    loadDailyRiskSeed: () => Promise.resolve(seeds.shift()),
  });

  // A page-bounded read cannot prove it saw every loss row, and a dropped `net_abort_pnl` makes the
  // day look CHEAPER than it was — the one direction the daily-loss gate must never be wrong in.
  manager.seedLimits({
    tradingDay: day,
    realisedPnlToday: -100,
    rejects: 0,
    consecutiveFailures: 0,
    incomplete: true,
  });
  let status = manager.status();
  assert.equal(status.health.daily_risk_seed, "failed",
    "a truncated reconstruction is reported rather than published as healthy");
  assert.equal(status.realisedPnlToday, -100, "the counters are still installed for observability");
  assert.equal(manager.canEnter(), false, "entry stays closed on an unproven daily-loss figure");

  // A later complete reconstruction is authoritative and restores entry readiness.
  day = "2026-09-08";
  seeds.push({ realisedPnl: -50, rejects: 0, consecutiveFailures: 0, incomplete: false });
  manager.status();
  await tick();
  await tick();
  status = manager.status();
  assert.equal(status.health.daily_risk_seed, "healthy");
  assert.equal(status.realisedPnlToday, -50);
  manager.dispose();
});

test("crash-only attributed exposure gates entry dynamically until recovery persistence is ready", async () => {
  let recoveryReady = false;
  const entryReq = request({ trade_id: "crash-only", attempt_id: "entry" });
  const completeIntent = intentFrom(entryReq, "COMPLETE", 75);
  const completeOrder = orderFrom(entryReq, { state: "COMPLETE", filled_quantity: 75 });
  const adapter = fakeAdapter({
    orders: [completeOrder],
    listOrders: () => [clone(completeOrder)],
    positions: [{
      token: entryReq.token,
      exchange: entryReq.exchange,
      tradingsymbol: entryReq.tradingsymbol,
      net_quantity: 75,
      average_price: 100,
    }],
  });
  const h = await managerHarness({
    persistence: new MemoryPersistence([completeIntent]),
    adapter,
    isCrashRecoveryPersistenceReady: () => recoveryReady,
  });

  // The engine marks this only after reconciliation proves the attributed position has no trade
  // projection. A failed/missing index does not block boot or exits; it blocks new exposure.
  h.manager.setCrashOnlyAttributedExposure(true);
  assert.equal(h.manager.status().health.reconciliation_complete, true);
  assert.equal(h.manager.status().crashRecoveryEntryQuarantined, true);
  assert.equal(h.manager.canEnter(), false);
  assert.equal(h.manager.canManageExposure(), true);

  const exit = await h.manager.submit(request({
    trade_id: "crash-only",
    attempt_id: "reduce-while-quarantined",
    purpose: "EXIT",
    phase: "exit",
    tradingsymbol: entryReq.tradingsymbol,
    token: entryReq.token,
    side: "SELL",
    quantity: 75,
  }));
  assert.equal(exit.filled_quantity, 75, "ordinary attributed reduction remains available");

  recoveryReady = true;
  assert.equal(h.manager.status().crashRecoveryEntryQuarantined, false,
    "later index verification is observed without restarting the manager");
  assert.equal(h.manager.canEnter(), true);

  h.manager.setCrashOnlyAttributedExposure(false);
  recoveryReady = false;
  assert.equal(h.manager.canEnter(), true,
    "index quarantine alone does not disable live entry when no crash-only exposure exists");
  h.manager.dispose();
});

test("a never-settling old-day seed times out, releases bookkeeping, and starts only the newest day", async () => {
  let day = "2026-09-07";
  const callbacks = new Map();
  let timerId = 0;
  const timer = {
    setTimeout(callback) {
      const id = ++timerId;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) { callbacks.delete(id); },
    fire(id) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback?.();
    },
  };
  let resolveOld;
  const oldSeed = new Promise((resolve) => { resolveOld = resolve; });
  const loadedDays = [];
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: false, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => day,
    dailyRiskSeedTimeoutMs: 50,
    dailyRiskSeedTimer: timer,
    loadDailyRiskSeed: (requestedDay) => {
      loadedDays.push(requestedDay);
      return requestedDay === "2026-09-08"
        ? oldSeed
        : Promise.resolve({
            realisedPnl: -4,
            rejects: 1,
            consecutiveFailures: 0,
            flattenChargeBaselinesForDay: {},
          });
    },
  });
  manager.seedLimits({ tradingDay: day });

  day = "2026-09-08";
  manager.status();
  await tick();
  assert.deepEqual(loadedDays, ["2026-09-08"]);
  const oldGeneration = manager.status().riskBookkeeping.activeLoadGeneration;
  const oldTimer = [...callbacks.keys()][0];
  assert.ok(oldGeneration);

  // The wall-clock day advances without any API call. Timeout re-reads the day, abandons the old
  // generation, compacts its token, and starts D+2 immediately.
  day = "2026-09-09";
  timer.fire(oldTimer);
  await tick();
  await tick();
  assert.deepEqual(loadedDays, ["2026-09-08", "2026-09-09"]);
  let status = manager.status();
  assert.equal(status.tradingDay, "2026-09-09");
  assert.equal(status.health.daily_risk_seed, "healthy");
  assert.equal(status.realisedPnlToday, -4);
  assert.equal(status.riskBookkeeping.retainedMutationCount, 0);
  assert.equal(status.riskBookkeeping.activeSeedTokens, 0);

  resolveOld({
    realisedPnl: -999,
    rejects: 99,
    consecutiveFailures: 99,
    flattenChargeBaselinesForDay: {},
  });
  await tick();
  status = manager.status();
  assert.equal(status.realisedPnlToday, -4, "late completion from the expired generation is inert");
  assert.equal(status.rejects, 1);
  assert.equal(callbacks.size, 0, "settled and expired generations leave no hanging timer");
  manager.dispose();
});


/* ════════════ boot daily-risk seed tokens must never leak ════════════
 *
 * The engine registers a seed token BEFORE adoption (so every local flatten observation from that
 * moment is journaled for the loader to merge) and only `seedLimits` settles it. Every other exit
 * from boot therefore used to leak the token: it stayed "active" with today's day key, so
 * `compactFlattenChargeMutations` had to retain the WHOLE day's merge journal — the unbounded
 * growth the generation bound exists to close, re-opened once per boot retry. `boot()` failure is
 * caught by its caller and the process keeps running with the flatten timer armed, so those
 * observations keep arriving.
 *
 * These drive the manager exactly as boot does: begin a token, observe local charges, then take
 * the failing/day-crossing exit instead of installing.
 */

/** Read internals directly: `status()` rolls the trading day, which would mask the leak itself. */
const seedInternals = (manager) => ({
  activeTokens: manager.activeDailyRiskSeedTokens.size,
  journalDays: [...manager.flattenChargeMutationsByDay.keys()],
  retained: [...manager.flattenChargeMutationsByDay.values()].reduce((sum, list) => sum + list.length, 0),
});

test("a boot that fails between beginDailyRiskSeed and seedLimits releases the token and unpins the day journal", () => {
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: false, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => "2026-09-07",
  });
  const bootToken = manager.beginDailyRiskSeed("2026-09-07");
  manager.recordFlattenCharge({
    attemptId: "boot-failure",
    chargeDay: "2026-09-07",
    previousChargesForDay: 0,
    chargesForDay: 5,
  });
  assert.deepEqual(seedInternals(manager), {
    activeTokens: 1,
    journalDays: ["2026-09-07"],
    retained: 1,
  }, "while the boot loader is genuinely active its merge journal is retained");

  // Adoption threw, or `loadBoxLiveRiskSeed` threw: boot never reaches `seedLimits`, and its
  // `finally` abandons the token.
  manager.abandonDailyRiskSeed(bootToken);
  assert.deepEqual(seedInternals(manager), {
    activeTokens: 0,
    journalDays: [],
    retained: 0,
  }, "no loader can still need the day's merge journal");
  assert.equal(manager.status().realisedPnlToday, -5,
    "abandoning the load never discards the charge itself — it was already debited");

  // And nothing journals afterwards, so the leak cannot reappear one observation at a time.
  manager.recordFlattenCharge({
    attemptId: "boot-failure",
    chargeDay: "2026-09-07",
    previousChargesForDay: 5,
    chargesForDay: 9,
  });
  assert.equal(seedInternals(manager).retained, 0);
  assert.equal(manager.status().realisedPnlToday, -9);

  // Idempotent: a second release (or one after `seedLimits` already settled the token) is a no-op.
  manager.abandonDailyRiskSeed(bootToken);
  assert.equal(seedInternals(manager).activeTokens, 0);
  manager.dispose();
});

test("abandoning one boot token retains exactly the suffix another active loader still needs", () => {
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: false, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => "2026-09-07",
  });
  const bootToken = manager.beginDailyRiskSeed("2026-09-07");
  manager.recordFlattenCharge({
    attemptId: "before-second-loader",
    chargeDay: "2026-09-07",
    previousChargesForDay: 0,
    chargesForDay: 3,
  });
  const laterLoader = manager.beginDailyRiskSeed("2026-09-07");
  manager.recordFlattenCharge({
    attemptId: "after-second-loader",
    chargeDay: "2026-09-07",
    previousChargesForDay: 0,
    chargesForDay: 4,
  });

  manager.abandonDailyRiskSeed(bootToken);
  assert.deepEqual(seedInternals(manager), {
    activeTokens: 1,
    journalDays: ["2026-09-07"],
    retained: 1,
  }, "the still-active loader keeps the mutations recorded after its own boundary");

  // That loader's own snapshot represents nothing, so its post-load range must still merge.
  manager.seedLimits({
    tradingDay: "2026-09-07",
    realisedPnlToday: 0,
    seedToken: laterLoader,
    flattenChargeBaselinesForDay: {},
  });
  assert.equal(manager.status().realisedPnlToday, -4);
  assert.deepEqual(seedInternals(manager), { activeTokens: 0, journalDays: [], retained: 0 });
  manager.dispose();
});

test("a boot that crosses midnight before installing releases its token without waiting for a day roll", () => {
  let day = "2026-09-07";
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits(),
    controls: { entryEnabled: false, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => day,
    // A loader that never settles, so the rollover seed below cannot mask the boot token.
    loadDailyRiskSeed: () => new Promise(() => {}),
  });
  const bootToken = manager.beginDailyRiskSeed(day);
  manager.recordFlattenCharge({
    attemptId: "midnight",
    chargeDay: "2026-09-07",
    previousChargesForDay: 0,
    chargesForDay: 2.5,
  });
  assert.deepEqual(seedInternals(manager), {
    activeTokens: 1,
    journalDays: ["2026-09-07"],
    retained: 1,
  });

  // Midnight passed during boot, so the engine's day guard installs NOTHING: the seed it loaded
  // belongs to a day the manager is about to leave, and the manager reloads the new one itself.
  day = "2026-09-08";
  manager.abandonDailyRiskSeed(bootToken);
  assert.deepEqual(seedInternals(manager), {
    activeTokens: 0,
    journalDays: [],
    retained: 0,
  }, "the uninstalled boot token is released at boot, not left to a later day roll");

  // The manager's own rollover seeding is unaffected: exactly one token, for the new day.
  const status = manager.status();
  assert.equal(status.tradingDay, "2026-09-08");
  assert.equal(status.health.daily_risk_seed, "seeding");
  assert.deepEqual(seedInternals(manager), { activeTokens: 1, journalDays: [], retained: 0 });
  manager.dispose();
});

test("the engine's boot really settles its seed token on every exit", () => {
  // `boot()` needs live Mongo and a live adapter, so the call site is asserted structurally —
  // the same approach `wiredNotInert.test.mjs` uses for production wiring.
  const engine = readFileSync(new URL("../../src/box/engine.ts", import.meta.url), "utf8");
  const boot = engine.slice(engine.indexOf("const startupRiskSeedToken"));
  const region = boot.slice(0, boot.indexOf("this.monitor.start();"));
  assert.match(region, /\}\s*finally\s*\{/, "the token region must be closed by a finally");
  assert.match(
    region,
    /if \(startupRiskSeedToken\) this\.orderManager\?\.abandonDailyRiskSeed\(startupRiskSeedToken\);/,
    "every exit that does not reach seedLimits must release the boot token",
  );
});
