import test from "node:test";
import assert from "node:assert/strict";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import {
  BrokerPreSubmitRefusedError,
} from "../../dist/box/brokerAdapter.js";
import {
  OrderPersistenceAfterFillError,
} from "../../dist/box/orderManager.js";
import { entrySideFor, exitSideFor } from "../../dist/box/math.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import {
  cfg,
  exitQuotes,
  goodCandidate,
  positionFrom,
  seedStore,
} from "./helpers.mjs";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];

function brokerOrder(req, filled = req.quantity) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.role}`,
    tag: null,
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
    state: filled === req.quantity ? "COMPLETE" : "PARTIALLY_FILLED",
    filled_quantity: filled,
    pending_quantity: req.quantity - filled,
    average_price: filled > 0 ? req.pricing.reference_price : null,
    fills: filled > 0 ? [{ fill_id: `fill-${req.role}-${filled}`, quantity: filled, price: req.pricing.reference_price, at: 10_100 }] : [],
    reject_family: null,
    reject_reason: null,
    created_at: 10_000,
    updated_at: 10_100,
  };
}

function liveHarness({ fillByRole = {}, warm = true } = {}) {
  const { candidate } = goodCandidate();
  const now = 10_000;
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, 198, { at: now, qty: 500 }), now);
  const submitted = [];
  const checkedFeed = [];
  const violations = [];
  const manager = {
    status: () => ({ inFlight: 0, queued: 0 }),
    submit: async (req, stamp) => {
      submitted.push(structuredClone(req));
      checkedFeed.push(structuredClone(stamp));
      return brokerOrder(req, fillByRole[req.role] ?? req.quantity);
    },
    invariantViolation: (reason) => violations.push(reason),
  };
  const simulator = {
    hasCapacity: () => false,
    estimateExecutableExit: () => [],
  };
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({
      executionMode: "live",
      liveTradingEnabled: true,
      queueModel: "none",
      liveMaxChaseTicks: 2,
      legMaxChaseTicks: 2,
    }),
    simulator,
    quotes,
    manager,
    allocateTradeId: () => "allocated-trade",
    isTokenWarm: () => warm,
    feedGeneration: () => 7,
    now: () => now,
  });
  return { candidate, quotes, submitted, checkedFeed, violations, manager, gateway, now };
}

function assertCheckedStamp(h, index) {
  const req = h.submitted[index];
  const stamp = h.checkedFeed[index];
  const quote = h.quotes.get(req.token);
  assert.deepEqual(stamp, {
    token: req.token,
    feed_generation: 7,
    quote_version: quote.version,
    quote_at: quote.at,
    checked_at: h.now,
  });
  assert.equal("checkedFeed" in req, false, "feed evidence is not embedded in the broker request");
}

/**
 * The expected exit transmission sequence, re-derived from the ENTRY sides.
 *
 * Deliberately does NOT import exitDependencies.ts: restating the property independently means a
 * bug in the planner cannot also certify itself. Rule: a role whose ENTRY side was SELL is short, so
 * closing it is risk-reducing and goes in the first group, together with any long whose paired
 * vertical leg has no outstanding short. Hedge releases follow.
 */
function expectedExitOrder(direction, remaining, quantities) {
  const partner = { k1_ce: "k2_ce", k2_ce: "k1_ce", k1_pe: "k2_pe", k2_pe: "k1_pe" };
  const first = [];
  const second = [];
  ROLES.forEach((role, index) => {
    if (!(remaining[role] > 0)) return;
    const pair = [role, quantities[index]];
    if (entrySideFor(role, direction) === "SELL") { first.push(pair); return; }
    const other = partner[role];
    const otherIsShort = entrySideFor(other, direction) === "SELL";
    if (otherIsShort && remaining[other] > 0) second.push(pair);
    else first.push(pair);
  });
  return [...first, ...second];
}

function detectionLegs(candidate, quotes, sideFor = exitSideFor) {
  return ROLES.map((role) => {
    const inst = candidate.legs[role];
    const side = sideFor(role, candidate.direction);
    const quote = quotes.get(inst.token);
    return {
      role,
      side,
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      price: side === "BUY" ? quote.ask : quote.bid,
      qty_at_touch: 500,
      bid: quote.bid,
      bid_qty: quote.bid_qty,
      ask: quote.ask,
      ask_qty: quote.ask_qty,
      quote_at: quote.at,
      quote_version: quote.version,
      depth: null,
      age_ms: 0,
      fresh: true,
      executable: true,
    };
  });
}

test("live gateway submits exactly the 1-4 nonzero outstanding roles and trusts broker-confirmed fills", async (t) => {
  const quantities = [35, 20, 10, 5];
  for (let count = 1; count <= 4; count++) {
    await t.test(`${count} outstanding role${count === 1 ? "" : "s"}`, async () => {
      const h = liveHarness();
      const remaining = Object.fromEntries(ROLES.map((role, index) => [role, index < count ? quantities[index] : 0]));
      const position = positionFrom(h.candidate, {
        id: `restart-${count}`,
        remaining_qty_by_role: remaining,
        position_state: "PARTIALLY_EXITED",
      });
      const result = await h.gateway.simulateLeggingExit({
        position,
        detectionLegs: detectionLegs(h.candidate, h.quotes),
        detectedAt: h.now,
        stillWanted: () => true,
      });

      assert.equal(result.ok, true);
      assert.equal(h.submitted.length, count);
      // EXPOSURE-AWARE EXIT ORDER (exitDependencies.ts). The SET of roles and their quantities is
      // unchanged — what changed is the SEQUENCE. Short-closing BUYs and longs with no short beside
      // them go first; a hedge release only follows proven closure of the short it covers. The
      // expected order is derived here from the entry sides rather than copied, so this asserts the
      // property and not a snapshot.
      const expected = expectedExitOrder(h.candidate.direction ?? "LONG_BOX", remaining, quantities);
      assert.deepEqual(h.submitted.map(({ role, quantity }) => [role, quantity]), expected);
      assert.equal(h.submitted.every((req) => req.quantity > 0 && req.pricing.order_type === "LIMIT"), true);
      h.submitted.forEach((_, index) => assertCheckedStamp(h, index));
      assert.deepEqual(
        Object.entries(result.record.fills_by_role).sort(),
        ROLES.slice(0, count).map((role, index) => [role, quantities[index]]).sort(),
        "the gateway projects only broker-confirmed cumulative fills",
      );
      assert.deepEqual(h.violations, []);
    });
  }
});

test("live gateway projects a partial exit from broker cumulative fill, not requested quantity", async () => {
  const h = liveHarness({ fillByRole: { k1_ce: 12 } });
  const position = positionFrom(h.candidate, {
    id: "broker-partial",
    remaining_qty_by_role: { k1_ce: 35, k2_ce: 0, k2_pe: 0, k1_pe: 0 },
    position_state: "PARTIALLY_EXITED",
  });

  const result = await h.gateway.simulateLeggingExit({
    position,
    detectionLegs: detectionLegs(h.candidate, h.quotes),
    detectedAt: h.now,
    stillWanted: () => true,
  });

  assert.equal(result.ok, false, "12/35 broker-confirmed is not a clean close");
  assert.equal(h.submitted[0].quantity, 35, "the exact outstanding quantity was requested");
  assert.equal(result.record.fills_by_role.k1_ce, 12, "the audit uses broker cumulative fill");
  assert.equal(result.record.remaining_role_count, 1);
  assert.equal(result.legs[0].qty_at_touch, 12);
  assert.deepEqual(h.violations, [], "a confirmed partial is not an uncertain outcome");
});

test("restart exact-map flow persisted 75→35 submits only 35 for that role", async () => {
  const h = liveHarness();
  const position = positionFrom(h.candidate, {
    id: "persisted-restart",
    remaining_qty_by_role: { k1_ce: 0, k2_ce: 35, k2_pe: 0, k1_pe: 0 },
    position_state: "PARTIALLY_EXITED",
  });

  const result = await h.gateway.simulateLeggingExit({
    position,
    detectionLegs: detectionLegs(h.candidate, h.quotes),
    detectedAt: h.now,
    stillWanted: () => true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(h.submitted.map(({ role, quantity }) => ({ role, quantity })), [{ role: "k2_ce", quantity: 35 }]);
  assert.equal(result.record.fills_by_role.k2_ce, 35);
});

test("paper gateway delegation remains byte-for-byte unchanged", async () => {
  const calls = [];
  const values = {
    entry: { entry: true },
    legEntry: { legEntry: true },
    exit: { exit: true },
    legExit: { legExit: true },
    estimate: [{ estimate: true }],
    flatten: { flatten: true },
  };
  const simulator = {
    hasCapacity: () => true,
    simulateEntry: async (arg) => { calls.push(["entry", arg]); return values.entry; },
    simulateLeggingEntry: async (arg) => { calls.push(["legEntry", arg]); return values.legEntry; },
    simulateExit: async (arg) => { calls.push(["exit", arg]); return values.exit; },
    simulateLeggingExit: async (arg) => { calls.push(["legExit", arg]); return values.legExit; },
    estimateExecutableExit: (arg, now) => { calls.push(["estimate", arg, now]); return values.estimate; },
    flattenResidual: async (arg) => { calls.push(["flatten", arg]); return values.flatten; },
  };
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({ executionMode: "paper_legging" }),
    simulator,
    quotes: new BoxQuoteStore(),
  });
  const args = { stable: "same-object" };

  assert.equal(gateway.hasCapacity(), true);
  assert.equal(await gateway.simulateEntry(args), values.entry);
  assert.equal(await gateway.simulateLeggingEntry(args), values.legEntry);
  assert.equal(await gateway.simulateExit(args), values.exit);
  assert.equal(await gateway.simulateLeggingExit(args), values.legExit);
  assert.equal(gateway.estimateExecutableExit(args, 123), values.estimate);
  assert.equal(await gateway.flattenResidual(args), values.flatten);
  assert.equal(calls.every((call) => call[1] === args), true, "paper arguments are delegated by identity without rewriting");
});


test("entry and protective unwind pass exact ephemeral feed stamps", async () => {
  const h = liveHarness();
  const detection = {
    candidate: h.candidate,
    at: h.now,
    legs: detectionLegs(h.candidate, h.quotes, entrySideFor),
  };

  const result = await h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection,
    qualify: () => ({ qualifies: false, expected_net_profit: 0, min_expected_net_profit: 1 }),
    stillWanted: () => true,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(h.submitted.map((req) => req.purpose), [
    "ENTRY", "ENTRY", "ENTRY", "ENTRY",
    "EMERGENCY_RESIDUAL", "EMERGENCY_RESIDUAL", "EMERGENCY_RESIDUAL", "EMERGENCY_RESIDUAL",
  ]);
  h.submitted.forEach((_, index) => assertCheckedStamp(h, index));
});


test("entry quarantine preserves a confirmed fill whose Mongo snapshot update failed", async () => {
  const h = liveHarness();
  h.manager.submit = async (req) => {
    h.submitted.push(structuredClone(req));
    if (req.role === "k1_ce") {
      throw new OrderPersistenceAfterFillError(
        brokerOrder(req, req.quantity),
        new Error("mongo unavailable after broker fill"),
      );
    }
    throw new Error("entry gate closed while queued");
  };
  const detection = {
    candidate: h.candidate,
    at: h.now,
    legs: detectionLegs(h.candidate, h.quotes, entrySideFor),
  };

  const result = await h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection,
    qualify: () => { throw new Error("uncertain entry must never reach economics"); },
    stillWanted: () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.legging.residual_exposure.length, 1);
  assert.equal(result.legging.residual_exposure[0].role, "k1_ce");
  assert.equal(result.legging.residual_exposure[0].quantity, h.candidate.lot_size);
  assert.equal(result.legging.legs[0].fill_qty, h.candidate.lot_size);
  assert.equal(h.violations.some((reason) => reason.includes("uncertain broker terminal quantity")), true);
});


test("exit audit preserves confirmed quantity when its Mongo snapshot update fails", async () => {
  const h = liveHarness();
  h.manager.submit = async (req) => {
    h.submitted.push(structuredClone(req));
    throw new OrderPersistenceAfterFillError(brokerOrder(req, req.quantity), new Error("mongo down"));
  };
  const position = positionFrom(h.candidate, {
    id: "exit-persistence-loss",
    remaining_qty_by_role: { k1_ce: 35, k2_ce: 0, k2_pe: 0, k1_pe: 0 },
    position_state: "PARTIALLY_EXITED",
  });

  const result = await h.gateway.simulateLeggingExit({
    position,
    detectionLegs: detectionLegs(h.candidate, h.quotes),
    detectedAt: h.now,
    stillWanted: () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.record.fills_by_role.k1_ce, 35);
  assert.equal(result.legs[0].qty_at_touch, 35);
  assert.equal(h.violations.some((reason) => reason.includes("uncertain broker terminal quantity")), true);
});

test("residual flatten applies a confirmed reduction even when its snapshot persistence fails", async () => {
  const h = liveHarness();
  h.manager.submit = async (req) => {
    h.submitted.push(structuredClone(req));
    throw new OrderPersistenceAfterFillError(brokerOrder(req, req.quantity), new Error("mongo down"));
  };
  const inst = h.candidate.legs.k1_ce;
  const result = await h.gateway.flattenResidual({
    keyPrefix: "residual-persistence-loss",
    residual: [{
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      exchange: inst.exchange,
      role: "k1_ce",
      side: "BUY",
      quantity: 35,
      average_price: 100,
      source: "partial_entry",
      created_at: h.now,
    }],
  });

  assert.equal(result.flattened_by_role.k1_ce, 35);
  assert.deepEqual(result.remaining, []);
  assert.equal(h.violations.some((reason) => reason.includes("durable snapshot failed")), true);
});

test("protective unwind retains a confirmed reduction after persistence loss", async () => {
  const h = liveHarness();
  h.manager.submit = async (req) => {
    h.submitted.push(structuredClone(req));
    if (req.purpose === "EMERGENCY_RESIDUAL") {
      throw new OrderPersistenceAfterFillError(brokerOrder(req, req.quantity), new Error("mongo down"));
    }
    return brokerOrder(req, req.role === "k1_ce" ? req.quantity : 0);
  };
  const detection = {
    candidate: h.candidate,
    at: h.now,
    legs: detectionLegs(h.candidate, h.quotes, entrySideFor),
  };

  const result = await h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection,
    qualify: () => { throw new Error("incomplete entry must unwind before economics"); },
    stillWanted: () => true,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.legging.residual_exposure, []);
  assert.equal(result.legging.legs.find((leg) => leg.role === "k1_ce").unwound_qty, h.candidate.lot_size);
  assert.equal(h.violations.some((reason) => reason.includes("protective unwind failed")), true);
});



test("local pre-submit exit refusal is known-zero, not broker uncertainty", async () => {
  const h = liveHarness();
  h.manager.submit = async (req, stamp) => {
    h.submitted.push(structuredClone(req));
    h.checkedFeed.push(structuredClone(stamp));
    throw new BrokerPreSubmitRefusedError(req.client_order_id, "dequeue", true, "feed generation changed");
  };
  const position = positionFrom(h.candidate, {
    id: "local-exit-refusal",
    remaining_qty_by_role: { k1_ce: 35, k2_ce: 0, k2_pe: 0, k1_pe: 0 },
    position_state: "PARTIALLY_EXITED",
  });

  const result = await h.gateway.simulateLeggingExit({
    position,
    detectionLegs: detectionLegs(h.candidate, h.quotes),
    detectedAt: h.now,
    stillWanted: () => true,
  });

  assert.equal(result.ok, false);
  /*
   * UPDATED EXPECTATION (was `/partially filled/`).
   *
   * This test's NAME is the invariant: a proven no-POST refusal is KNOWN-ZERO, not broker
   * uncertainty. The old assertion nevertheless required the detail to say "partially filled" —
   * fill language for a leg that was never transmitted — because the `BrokerPreSubmitRefusedError`
   * branch in `runWave` did not record the leg as withheld, so the detail fell through to the
   * generic partial-fill string. The reduction is now described as NOT SUBMITTED, which is what
   * actually happened, and the remaining exposure is named.
   *
   * The two real invariants below are unchanged and still assert the original point.
   */
  assert.match(result.detail, /NOT SUBMITTED/, "nothing reached the broker, and the detail says so");
  assert.doesNotMatch(result.detail, /partially filled/, "a never-transmitted leg is not a partial fill");
  assert.match(result.detail, /k1_ce 35/, "the still-open quantity is named for the operator");
  // KNOWN-ZERO, not uncertainty: these two tokens are what routes a position to RECOVERY.
  assert.doesNotMatch(result.detail, /uncertain|reconcil/i, "a proven local refusal is not uncertainty");
  assert.equal(h.violations.length, 0, "proven no-POST refusal must not quarantine broker quantity");
  assertCheckedStamp(h, 0);
});

test("durable local residual refusal retires the spent identity", async () => {
  const h = liveHarness();
  h.manager.submit = async (req, stamp) => {
    h.submitted.push(structuredClone(req));
    h.checkedFeed.push(structuredClone(stamp));
    throw new BrokerPreSubmitRefusedError(req.client_order_id, "pre_post", true, "book changed");
  };
  const inst = h.candidate.legs.k1_ce;
  const result = await h.gateway.flattenResidual({
    keyPrefix: "local-residual-refusal",
    residual: [{
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      exchange: inst.exchange,
      role: "k1_ce",
      side: "BUY",
      quantity: 35,
      average_price: 100,
      source: "partial_entry",
      created_at: h.now,
      flatten_attempt: 1,
    }],
  });

  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].quantity, 35);
  assert.equal(result.remaining[0].flatten_attempt, 2);
  assert.equal(h.violations.length, 0);
  assertCheckedStamp(h, 0);
});


test("live residual flatten refuses a non-current book and retains exposure", async () => {
  const h = liveHarness({ warm: false });
  const inst = h.candidate.legs.k1_ce;
  const residual = [{
    role: "k1_ce",
    token: inst.token,
    tradingsymbol: inst.tradingsymbol,
    exchange: inst.exchange,
    side: "BUY",
    quantity: 35,
    average_price: 100,
    source: "partial_entry",
    created_at: h.now,
  }];
  const result = await h.gateway.flattenResidual({ residual, keyPrefix: "non-current" });
  assert.equal(h.submitted.length, 0);
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].quantity, 35);
});

test("live residual flatten uses a current one-sided relevant book", async () => {
  const h = liveHarness({ warm: true });
  const inst = h.candidate.legs.k1_ce;
  h.quotes.applyTicks([{
    token: inst.token,
    last_price: 100,
    close_price: 99,
    oi: 0,
    bid: 99.9,
    ask: 0,
    bids: [{ price: 99.9, qty: 100, orders: 1 }],
    asks: [],
    depth_updated: true,
  }], h.now);
  const residual = [{
    role: "k1_ce",
    token: inst.token,
    tradingsymbol: inst.tradingsymbol,
    exchange: inst.exchange,
    side: "BUY",
    quantity: 35,
    average_price: 100,
    source: "partial_entry",
    created_at: h.now,
  }];
  const result = await h.gateway.flattenResidual({ residual, keyPrefix: "current-side" });
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].side, "SELL");
  assert.equal(h.submitted[0].quantity, 35);
  assertCheckedStamp(h, 0);
  assert.deepEqual(result.remaining, []);
});

test("live residual flatten refuses a missing relevant side and retains exposure", async () => {
  const h = liveHarness({ warm: true });
  const inst = h.candidate.legs.k1_ce;
  h.quotes.applyTicks([{
    token: inst.token,
    last_price: 100,
    close_price: 99,
    oi: 0,
    bid: 0,
    ask: 100.1,
    bids: [],
    asks: [{ price: 100.1, qty: 100, orders: 1 }],
    depth_updated: true,
  }], h.now);
  const residual = [{
    role: "k1_ce",
    token: inst.token,
    tradingsymbol: inst.tradingsymbol,
    exchange: inst.exchange,
    side: "BUY",
    quantity: 35,
    average_price: 100,
    source: "partial_entry",
    created_at: h.now,
  }];
  const result = await h.gateway.flattenResidual({ residual, keyPrefix: "wrong-side" });
  assert.equal(h.submitted.length, 0);
  assert.equal(result.remaining[0].quantity, 35);
});