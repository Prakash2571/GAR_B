/**
 * RISK REDUCTION UNDER DEGRADED MARKET DATA — what is reported when automation cannot reduce.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE POLICY BEING TESTED (and why it is the right one)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every order this system sends is a BOUNDED LIMIT order, on entry and on reduction alike. So a
 * reduction leg can only be priced and sent while it has a current, fresh, deep-enough executable
 * book: the gateway prechecks each leg (`precheckOne`), and the manager RE-VALIDATES at CHECKPOINT 3
 * (dequeue) and CHECKPOINT 5 (immediately pre-POST) via `checkedFeedBlockReason`. If the book dies in
 * between, the leg is WITHHELD rather than sent blind.
 *
 * That is deliberately NOT escalated to a market order. An unbounded order on a thin or absent
 * options book is how a reduction becomes a worse loss than the exposure it was removing. The
 * accepted cost is that automated reduction can be WITHHELD while exposure stays open — which makes
 * the REPORTING the safety-critical surface, because it is the only thing that tells a human to go
 * and reduce the position by hand.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THESE TESTS PIN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A leg refused at CHECKPOINT 3/5 surfaces as `BrokerPreSubmitRefusedError`. That branch recorded
 * `{filled: 0, certain: true}` — correct for accounting — but did NOT record the leg as withheld.
 * With no withheld legs and nothing uncertain, the failure detail fell through to the literal string
 *
 *     "live exit partially filled"
 *
 * for a leg that was PROVABLY NEVER TRANSMITTED. The operator was told a partial reduction had
 * happened when nothing had been sent at all, and the two situations demand opposite responses.
 *
 * The accounting was never wrong (exposure is only ever decremented from a broker cumulative fill),
 * so these tests assert the DURABLE/EXPOSURE facts AND the operator-facing text together — the text
 * is the part that was lying.
 *
 * Offline: real gateway → manager → recording adapter, fake books, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BOX_ENTRY_SIDES_BY_DIRECTION } from "../../dist/box/types.js";
import { exitSideFor } from "../../dist/box/math.js";
import { verticalPartner } from "../../dist/box/exitDependencies.js";
import { LOT, positionFrom } from "./helpers.mjs";
import { brokerOrderFor, liveStack, NOW, runEntry } from "./liveEntryHarness.mjs";

/* ────────────────────────── fixture helpers (mirrors exitLegIsolation) ────────────────────────── */

function geometry(direction) {
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];
  return {
    sides,
    shorts: Object.keys(sides).filter((role) => sides[role] === "SELL"),
    longs: Object.keys(sides).filter((role) => sides[role] === "BUY"),
  };
}

function exitDetection(candidate, quotes, direction) {
  return Object.keys(candidate.legs).map((role) => {
    const leg = candidate.legs[role];
    const q = quotes.get(leg.token);
    const side = exitSideFor(role, direction);
    return {
      role,
      side,
      token: leg.token,
      tradingsymbol: leg.tradingsymbol,
      strike: leg.strike,
      instrument_type: leg.instrument_type,
      price: side === "BUY" ? q.asks[0].price : q.bids[0].price,
      qty_at_touch: candidate.lot_size,
      bid: q.bids[0].price,
      bid_qty: q.bids[0].quantity,
      ask: q.asks[0].price,
      ask_qty: q.asks[0].quantity,
      quote_at: q.at,
      exchange_at: null,
      quote_version: q.version,
      depth: null,
      age_ms: 0,
      fresh: true,
      executable: true,
    };
  });
}

async function exitStack(direction, answer, { limitOverrides = {} } = {}) {
  const cold = new Set();
  const stack = await liveStack({
    direction,
    limitOverrides,
    isTokenWarm: (token) => !cold.has(token),
    // CHECKPOINT 3 / CHECKPOINT 5, wired exactly as production does. Without this the send-boundary
    // re-validation would not run and the "after queueing" cases would prove nothing.
    feedRevalidation: true,
    adapterOptions: {
      submit: async (req, adapter) =>
        (req.purpose === "ENTRY" ? brokerOrderFor(req, req.quantity, "COMPLETE") : answer(req.role, req, adapter)),
    },
  });

  const entry = await runEntry(stack);
  assert.equal(entry.ok, true, "fixture: the box must be entered before it can be exited");

  const position = positionFrom(stack.candidate, { direction });
  const tokenFor = (role) => stack.candidate.legs[role].token;
  return {
    ...stack,
    position,
    tokenFor,
    chill: (role) => cold.add(tokenFor(role)),
    chillAll: () => Object.keys(stack.candidate.legs).forEach((role) => cold.add(tokenFor(role))),
    run: () => stack.gateway.simulateLeggingExit({
      position,
      detectionLegs: exitDetection(stack.candidate, stack.quotes, direction),
      detectedAt: NOW,
    }),
  };
}

const exitPosts = (adapter) => adapter.posts.filter((post) => post.purpose !== "ENTRY");
const postsFor = (adapter, role) => exitPosts(adapter).filter((post) => post.role === role);
const answerBy = (overrides = {}) => (role, req) =>
  (overrides[role] ? overrides[role](req) : brokerOrderFor(req, req.quantity, "COMPLETE"));

/* ═══════════════════════════════ the matrix ═══════════════════════════════ */

for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
  const { shorts } = geometry(direction);
  const [shortA, shortB] = shorts;
  const hedgeOfA = verticalPartner(shortA);

  /* ── 1. FEED LOSS BEFORE QUEUEING ─────────────────────────────────────────────────────── */

  test(`${direction}: feed loss BEFORE queueing is reported as NOT SUBMITTED, never as a fill`, async () => {
    const stack = await exitStack(direction, answerBy());
    stack.chill(shortB); // its book is gone before the wave is even built

    const result = await stack.run();

    // Nothing was transmitted for that leg.
    assert.equal(postsFor(stack.adapter, shortB).length, 0, "no order may be sent against an absent book");
    assert.equal(result.ok, false, "a withheld reduction is never a clean exit");

    // THE REPORTING CONTRACT.
    assert.match(result.detail, /NOT SUBMITTED/, "a never-transmitted leg must say so explicitly");
    assert.match(result.detail, new RegExp(shortB), "the withheld leg is named");
    assert.doesNotMatch(
      result.detail, /partially filled/,
      "nothing was sent, so this must never be described in fill language",
    );
    // The operator is told what is still open, and what to do if automation keeps failing.
    assert.match(result.detail, /Still open:/, "remaining exposure is named");
    assert.match(result.detail, /MANUALLY AT THE BROKER/, "the manual-intervention instruction is present");
  });

  /* ── 2. FEED LOSS AFTER QUEUEING (the send boundary) ──────────────────────────────────── */

  test(`${direction}: feed loss AFTER queueing is refused at the send boundary and reported honestly`, async () => {
    let stack;
    const ref = () => stack;
    stack = await exitStack(direction, answerBy());
    // Chill shortB's token WHILE shortA sits in adapter pacing: the wave was already prechecked, so
    // only CHECKPOINT 5 can catch this. This is the branch that produced the false "partially
    // filled" text, because it arrives as BrokerPreSubmitRefusedError rather than a precheck verdict.
    const original = stack.adapter.submitOrder;
    stack.adapter.submitOrder = async (req, beforePost) => {
      if (req.purpose !== "ENTRY" && req.role === shortA) ref().chill(shortB);
      return original(req, beforePost);
    };

    const result = await stack.run();

    assert.ok(postsFor(stack.adapter, shortA).length > 0, `${shortA} was validated and transmitted`);
    assert.equal(
      postsFor(stack.adapter, shortB).length, 0,
      `${shortB}'s book died after the precheck; the send boundary must refuse it`,
    );

    // THE REGRESSION THIS FILE EXISTS FOR.
    assert.match(
      result.detail, /NOT SUBMITTED/,
      "a CHECKPOINT-5 refusal must be reported as not submitted, not as a partial fill",
    );
    assert.doesNotMatch(result.detail, /partially filled/);
    assert.match(result.detail, new RegExp(shortB));
    assert.match(result.detail, /MANUALLY AT THE BROKER/);
  });

  /* ── 3. PARTIAL FILL, THEN THE FEED BECOMES UNUSABLE ──────────────────────────────────── */

  test(`${direction}: a leg that PARTIALLY filled before the feed died keeps its fill and reports the rest open`, async () => {
    const half = Math.floor(LOT / 2);
    let stack;
    const ref = () => stack;
    stack = await exitStack(direction, answerBy({
      // shortA genuinely closes half, and the book dies as it does so — so the dependent hedge
      // release in wave 1 can no longer be priced.
      [shortA]: (req) => {
        ref().chillAll();
        return brokerOrderFor(req, half, "CANCELLED");
      },
    }));

    const result = await stack.run();

    // 1. THE CONFIRMED PARTIAL IS CREDITED — a feed failure must not discard a real fill.
    const closedA = postsFor(stack.adapter, shortA).reduce(
      (total, post) => total + (stack.adapter.orders.get(post.client_order_id)?.filled_quantity ?? 0), 0,
    );
    assert.equal(closedA, half, "the broker-confirmed partial close stands");

    // 2. THE REMAINDER IS STILL OPEN, and is reported as such rather than as a completed reduction.
    assert.equal(result.ok, false);
    assert.match(result.detail, /Still open:/);
    assert.match(
      result.detail, new RegExp(`${shortA} ${LOT - half}`),
      "the exact unreduced remainder of the partially filled leg is named",
    );

    // 3. NO HEDGE WAS SOLD AGAINST AN UNPRICEABLE BOOK, and the withheld release is disclosed.
    assert.equal(
      postsFor(stack.adapter, hedgeOfA).length, 0,
      "the hedge release had no executable book and must be withheld, never sent blind",
    );
    assert.match(result.detail, /NOT SUBMITTED/);
    assert.match(result.detail, /MANUALLY AT THE BROKER/);
  });

  /* ── 4. NEGATIVE CONTROL: a deliberate cover hold is NOT an alarm ─────────────────────── */

  test(`${direction}: a hedge held purely for cover is still reported as cover, not as a failure to transmit`, async () => {
    // shortA closes only half with a GOOD book everywhere. The hedge is deliberately held back for
    // the uncovered remainder. That is correct, self-healing behaviour and must keep its calm
    // wording — otherwise the loud "NOT SUBMITTED / act manually" text would fire on every ordinary
    // partial close and stop meaning anything.
    const half = Math.floor(LOT / 2);
    const stack = await exitStack(direction, answerBy({
      [shortA]: (req) => brokerOrderFor(req, half, "CANCELLED"),
    }));

    const result = await stack.run();

    assert.equal(result.ok, false);
    assert.match(result.detail, /preserved required hedge cover/, "the cover hold keeps its own wording");
    assert.doesNotMatch(
      result.detail, /NOT SUBMITTED/,
      "nothing was withheld for want of a book, so the transmit alarm must not fire",
    );
    assert.match(result.detail, /Still open:/, "but the operator is still told what remains");
  });

  /* ── 5. EVERY REDUCTION ORDER IS A BOUNDED LIMIT ORDER ───────────────────────────────── */

  test(`${direction}: a degraded book never escalates a reduction to an unbounded order`, async () => {
    const stack = await exitStack(direction, answerBy());
    stack.chill(shortB);
    await stack.run();

    for (const post of exitPosts(stack.adapter)) {
      const order = stack.adapter.orders.get(post.client_order_id);
      assert.ok(order, `every transmitted reduction has a recorded order (${post.role})`);
      assert.equal(order.pricing.order_type, "LIMIT", "a reduction is always a bounded LIMIT order");
      assert.ok(
        Number.isFinite(order.pricing.limit_price) && order.pricing.limit_price > 0,
        "a reduction always carries a finite positive limit price",
      );
    }
  });
}

/* ── 6. REDUCTION SURVIVES AN ENTRY-SCOPED BRAKE ─────────────────────────────────────────── */

test("a DAILY-LOSS circuit trip closes ENTRY but never blocks reduction", async () => {
  // The safety boundary: an entry-specific brake must never take exits, protective cancels or
  // reconciliation with it. A brake that also froze reduction would strand exposure at exactly the
  // moment something has already gone wrong.
  //
  // Driven through the real mechanism rather than a test hook: `seedLimits` is the production entry
  // point the engine uses at boot and on a day roll, and it ends in `evaluateLimits()`, which is the
  // only consumer of `dailyLossLimit`.
  // The PRODUCTION default limit (BOX_LIVE_DAILY_LOSS_LIMIT = 5000), not the harness's
  // deliberately-out-of-the-way 1,000,000, so this exercises the shipped configuration.
  const stack = await exitStack("LONG_BOX", answerBy(), { limitOverrides: { dailyLossLimit: 5_000 } });
  const [shortA] = geometry("LONG_BOX").shorts;

  stack.manager.seedLimits({ tradingDay: "2026-09-02", realisedPnlToday: -6_000 });

  // ENTRY is closed, and it names the daily loss limit.
  assert.equal(stack.manager.canEnter(), false, "a breached daily loss limit must close entry");
  assert.match(
    String(stack.manager.entryBlockReason()), /daily loss limit/i,
    "the refusal must name the daily loss limit, so an operator can tell why entry stopped",
  );

  // REDUCTION is unaffected.
  const result = await stack.run();
  assert.ok(
    postsFor(stack.adapter, shortA).length > 0,
    "a short close must still be transmitted while the entry breaker is open",
  );
  assert.equal(result.ok, true, "with good books the exit completes normally despite the entry brake");
});
