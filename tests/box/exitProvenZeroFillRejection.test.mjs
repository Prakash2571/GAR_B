/**
 * A PROVEN ZERO-FILL EXIT REJECTION IS A FAILED REDUCTION, NOT AN UNKNOWN.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `simulateLeggingExit`'s `runWave` had branches for a fulfilled submit, a pre-submit refusal and a
 * persistence-after-fill error. `BrokerOrderRejectedError` had none, so it fell into the catch-all:
 *
 *     uncertain = true;
 *     byRole.set(role, { filled: 0, certain: false });
 *
 * The consequences were wildly out of proportion. `uncertain` calls
 * `manager.invariantViolation`, which sets `recoveryActive` and OPENS THE CIRCUIT BREAKER — blocking
 * all new entry — and sets the detail to "exit terminal quantity uncertain; position moved to
 * recovery". `positionMonitor.applyLeggingExitResult` regex-matches /uncertain|reconcil/i on that
 * detail and moves the WHOLE POSITION to RECOVERY, writing an `UNCERTAIN` exit attempt whose broker
 * orders are rewritten to RECONCILIATION_REQUIRED.
 *
 * But a definitive broker rejection is the LEAST uncertain outcome available: the broker positively
 * told us it refused the order and nothing executed. That leg's outstanding quantity is exactly what
 * it was, its hedge is still required and still in place, and the right response is to report a
 * failed reduction with the broker's reason and try again — not to declare the position's quantities
 * unknowable and freeze entry.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT MUST STILL FAIL CLOSED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Only a rejection whose snapshot PASSES `verifyZeroBrokerExposure` — terminal REJECTED with a
 * verified `filled_quantity === 0`, no fill records, no missing quantity evidence — is treated this
 * way. A contradicted rejection (a positive fill behind the refusal), an ambiguous submission, or a
 * persistence failure after a fill must still quarantine.
 *
 * Offline: real gateway → manager → recording adapter, with the rejections produced by a REAL
 * `KiteBrokerAdapter` driven against a deterministic fake transport.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BrokerOrderRejectedError,
  BrokerRejectionContradictedError,
  verifyZeroBrokerExposure,
} from "../../dist/box/brokerAdapter.js";
import { KiteBrokerAdapter, KiteHttpError } from "../../dist/box/kiteBrokerAdapter.js";
import { BOX_ENTRY_SIDES_BY_DIRECTION } from "../../dist/box/types.js";
import { exitSideFor } from "../../dist/box/math.js";
import { verticalPartner } from "../../dist/box/exitDependencies.js";
import { LOT, positionFrom } from "./helpers.mjs";
import { brokerOrderFor, liveStack, NOW, runEntry } from "./liveEntryHarness.mjs";

/* ────────────────────────── real-adapter rejection factories ────────────────────────── */

const adapterCfg = {
  executionMode: "live", enabled: true, ackTimeoutMs: 40, workingTimeoutMs: 60,
  partialTimeoutMs: 40, cancelTimeoutMs: 40, brokerMinIntervalMs: 0,
  maxModifications: 2, maxChaseTicks: 2,
};
const fakeClock = () => { let n = 1_000; return { now: () => n, wait: async (ms) => { n += Math.max(0, ms); } }; };

function raceTransport({ inject, fail }) {
  return {
    async placeOrder(_p, opts) {
      opts?.beforeSend?.();
      inject?.();
      throw fail();
    },
    async listOrders() { return []; },
    async getOrder() { return null; },
    async cancelOrder() {}, async modifyOrder() {}, async listPositions() { return []; },
  };
}

/** A real adapter's DEFINITIVE rejection with a verified zero fill. */
async function provenZeroFillRejection(req, message = "RMS: margin shortfall") {
  const adapter = new KiteBrokerAdapter(
    raceTransport({ fail: () => new KiteHttpError(400, message, {}) }), adapterCfg, fakeClock(),
  );
  const error = await adapter.submitOrder(req).then(() => null, (e) => e);
  assert.ok(error instanceof BrokerOrderRejectedError, "fixture: a real definitive rejection");
  assert.equal(
    verifyZeroBrokerExposure(error.order).proven, true,
    "fixture: the snapshot must PROVE zero exposure",
  );
  return error;
}

/** A real adapter's rejection CONTRADICTED by a fill observed while the POST was in flight. */
async function contradictedRejection(req, filled = 25) {
  const holder = {};
  const transport = raceTransport({
    inject: () => holder.a.applyOrderUpdate({
      clientOrderId: req.client_order_id, brokerOrderId: `K-${req.role}`,
      cumulativeQty: filled, averagePrice: 100.02, rawStatus: "OPEN", observedAtWall: 1_050,
    }),
    fail: () => new KiteHttpError(400, "RMS: margin shortfall", {}),
  });
  holder.a = new KiteBrokerAdapter(transport, adapterCfg, fakeClock());
  const error = await holder.a.submitOrder(req).then(() => null, (e) => e);
  assert.ok(error instanceof BrokerRejectionContradictedError, "fixture: a contradicted rejection");
  return error;
}

/* ────────────────────────── exit harness ────────────────────────── */

const geometry = (direction) => {
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];
  return { shorts: Object.keys(sides).filter((r) => sides[r] === "SELL") };
};

function exitDetection(candidate, quotes, direction) {
  return Object.keys(candidate.legs).map((role) => {
    const leg = candidate.legs[role];
    const q = quotes.get(leg.token);
    const side = exitSideFor(role, direction);
    return {
      role, side, token: leg.token, tradingsymbol: leg.tradingsymbol,
      strike: leg.strike, instrument_type: leg.instrument_type,
      price: side === "BUY" ? q.asks[0].price : q.bids[0].price,
      qty_at_touch: candidate.lot_size,
      bid: q.bids[0].price, bid_qty: q.bids[0].quantity,
      ask: q.asks[0].price, ask_qty: q.asks[0].quantity,
      quote_at: q.at, exchange_at: null, quote_version: q.version, depth: null,
      age_ms: 0, fresh: true, executable: true,
    };
  });
}

async function exitStack(direction, answer) {
  const stack = await liveStack({
    direction,
    feedRevalidation: true,
    adapterOptions: {
      submit: async (req, adapter) =>
        (req.purpose === "ENTRY" ? brokerOrderFor(req, req.quantity, "COMPLETE") : answer(req.role, req, adapter)),
    },
  });
  const entry = await runEntry(stack);
  assert.equal(entry.ok, true, "fixture: the box must be entered before it can be exited");
  const position = positionFrom(stack.candidate, { direction });
  return {
    ...stack,
    position,
    run: () => stack.gateway.simulateLeggingExit({
      position,
      detectionLegs: exitDetection(stack.candidate, stack.quotes, direction),
      detectedAt: NOW,
    }),
  };
}

const exitPosts = (adapter) => adapter.posts.filter((p) => p.purpose !== "ENTRY");
const postsFor = (adapter, role) => exitPosts(adapter).filter((p) => p.role === role);
const closedFor = (adapter, role) => postsFor(adapter, role).reduce(
  (t, p) => t + (adapter.orders.get(p.client_order_id)?.filled_quantity ?? 0), 0,
);
const fullFill = (role, req) => brokerOrderFor(req, req.quantity, "COMPLETE");

/* ═══════════════════════════════ the matrix ═══════════════════════════════ */

for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
  const [shortA, shortB] = geometry(direction).shorts;
  const hedgeOfA = verticalPartner(shortA);

  /* ── 1. PROVEN zero-fill rejection ───────────────────────────────────────────────────── */

  test(`${direction}: a PROVEN zero-fill exit rejection is a failed reduction, not broker uncertainty`, async () => {
    const stack = await exitStack(direction, async (role, req) => {
      if (role === shortA) throw await provenZeroFillRejection(req);
      return fullFill(role, req);
    });

    const result = await stack.run();

    assert.equal(result.ok, false, "the reduction did not happen, so the exit is not clean");
    // THE BROKER'S REASON IS REPORTED.
    assert.match(result.detail, /REJECTED BY BROKER/, "the rejection is named as such");
    assert.match(result.detail, new RegExp(shortA), "the rejected leg is named");
    assert.match(result.detail, /margin shortfall/, "the broker's own reason is carried through");
    // AND NO UNCERTAINTY IS INVENTED. This regex is exactly the predicate
    // `positionMonitor.applyLeggingExitResult` uses to move a position to RECOVERY.
    assert.doesNotMatch(
      result.detail, /uncertain|reconcil/i,
      "a definitive broker rejection must not be described as uncertain, or the whole position " +
        "is moved to RECOVERY on the strength of the one outcome the broker was explicit about",
    );
    assert.doesNotMatch(result.detail, /NOT SUBMITTED/, "it WAS submitted; the broker refused it");
  });

  test(`${direction}: a PROVEN zero-fill exit rejection does not trip the breaker or block entry`, async () => {
    const stack = await exitStack(direction, async (role, req) => {
      if (role === shortA) throw await provenZeroFillRejection(req);
      return fullFill(role, req);
    });
    const canEnterBefore = stack.manager.canEnter();

    await stack.run();

    assert.ok(
      !stack.violations.some((v) => /uncertain broker terminal quantity/i.test(v)),
      `no uncertainty invariant may be raised, got ${JSON.stringify(stack.violations)}`,
    );
    assert.equal(stack.manager.status().health.circuit, "closed", "the circuit stays closed");
    assert.equal(stack.manager.canEnter(), canEnterBefore, "entry admission is unchanged");
  });

  test(`${direction}: a PROVEN zero-fill exit rejection leaves the leg's quantity known and its hedge ON`, async () => {
    const stack = await exitStack(direction, async (role, req) => {
      if (role === shortA) throw await provenZeroFillRejection(req);
      return fullFill(role, req);
    });

    const result = await stack.run();

    // The leg closed nothing, and the report says exactly how much is still open.
    assert.equal(closedFor(stack.adapter, shortA), 0, "a rejected order closes nothing");
    assert.match(
      result.detail, new RegExp(`${shortA} ${LOT}`),
      "the full outstanding quantity of the rejected leg is reported as still open",
    );
    // THE HEDGE STAYS. Its short is entirely intact, so no cover may be released.
    assert.equal(
      postsFor(stack.adapter, hedgeOfA).length, 0,
      `${hedgeOfA} must not be released while ${shortA} is fully outstanding`,
    );
    // The unrelated short still reduced — one rejected leg does not abort the wave.
    assert.ok(postsFor(stack.adapter, shortB).length > 0, `${shortB} still reduced normally`);
  });

  /* ── 2. PARTIAL fills on other legs are still credited ───────────────────────────────── */

  test(`${direction}: a PROVEN rejection on one leg still credits a PARTIAL fill on another`, async () => {
    const half = Math.floor(LOT / 2);
    const stack = await exitStack(direction, async (role, req) => {
      if (role === shortA) throw await provenZeroFillRejection(req);
      if (role === shortB) return brokerOrderFor(req, half, "CANCELLED");
      return fullFill(role, req);
    });

    const result = await stack.run();

    assert.equal(closedFor(stack.adapter, shortB), half, "the confirmed partial on the other leg stands");
    assert.equal(closedFor(stack.adapter, shortA), 0, "the rejected leg closed nothing");
    // Both remainders are reported, per role.
    assert.match(result.detail, new RegExp(`${shortA} ${LOT}`), "the rejected leg's full quantity is open");
    assert.match(result.detail, new RegExp(`${shortB} ${LOT - half}`), "the partial leg's remainder is open");
    assert.doesNotMatch(result.detail, /uncertain|reconcil/i, "still no invented uncertainty");
    // shortB's hedge may release only the proven-free half.
    const hedgeOfB = verticalPartner(shortB);
    const releasedB = postsFor(stack.adapter, hedgeOfB).reduce((t, p) => t + p.quantity, 0);
    assert.equal(releasedB, half, `only the proven ${half} may be released from ${hedgeOfB}`);
  });

  /* ── 3. CONTRADICTED rejection must still fail closed ────────────────────────────────── */

  test(`${direction}: a CONTRADICTED exit rejection still quarantines and moves the position to recovery`, async () => {
    const stack = await exitStack(direction, async (role, req) => {
      if (role === shortA) throw await contradictedRejection(req, 25);
      return fullFill(role, req);
    });

    const result = await stack.run();

    assert.equal(result.ok, false);
    // THE FAIL-CLOSED PATH IS UNCHANGED: this one really is uncertain.
    assert.match(
      result.detail, /uncertain/i,
      "a rejection contradicted by an observed fill must still be reported as uncertain",
    );
    assert.ok(
      stack.violations.some((v) => /uncertain broker terminal quantity/i.test(v)),
      "and it must still raise the uncertainty invariant",
    );
    assert.equal(
      postsFor(stack.adapter, hedgeOfA).length, 0,
      `${hedgeOfA} must not be released on an unproven short close`,
    );
  });
}

/* ── 4. the discriminator itself ─────────────────────────────────────────────────────────── */

test("the exit path discriminates on verifyZeroBrokerExposure, not on the error type alone", async () => {
  // Both fixtures are rejections produced by the same real adapter on the same definitive 400. The
  // ONLY difference is whether a fill was observed while the POST was in flight — and that is what
  // decides whether the exit reports a failed reduction or quarantines.
  const req = {
    client_order_id: "BOX:t-disc:EXIT:k2_ce:attempt-1", role: "k2_ce", trade_id: "t-disc",
    attempt_id: "attempt-1", purpose: "EXIT", phase: "exit", exchange: "NFO",
    tradingsymbol: "NIFTY26SEP20100CE", token: 2001, side: "BUY", quantity: LOT,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
  };

  const proven = await provenZeroFillRejection(req);
  assert.equal(proven.order.state, "REJECTED");
  assert.equal(proven.order.filled_quantity, 0);
  assert.equal(verifyZeroBrokerExposure(proven.order).proven, true);

  const contradicted = await contradictedRejection({ ...req, client_order_id: "BOX:t-disc2:EXIT:k2_ce:attempt-1" }, 25);
  assert.equal(contradicted.order.state, "RECONCILIATION_REQUIRED");
  assert.equal(contradicted.order.filled_quantity, 25);
  assert.equal(verifyZeroBrokerExposure(contradicted.order).proven, false);
  assert.equal(
    contradicted instanceof BrokerOrderRejectedError, false,
    "a contradicted rejection is not a BrokerOrderRejectedError at all, so it cannot reach the proven branch",
  );
});
