/**
 * EXIT LEG ISOLATION — one unusable book must not abort every other leg of an exit wave.
 *
 * THE DEFECT. `simulateLeggingExit`'s inner `runWave` was strictly three-phase:
 *
 *     const requests    = legs.map(build);          // (1) build ALL requests
 *     const checkedFeed = this.precheck(requests);  // (2) validate ALL — THROWS on the first bad leg
 *     const settled     = await Promise.allSettled( // (3) per-leg tolerant … but unreachable
 *       requests.map((r) => manager.submit(r, checkedFeed.get(r.client_order_id))));
 *
 * `precheck` is a `for` loop with four `throw` sites (token not warm, no quote, stale quote,
 * insufficient bounded depth). Any one of them aborts the WHOLE wave before the first
 * `manager.submit`. Because wave 0 carries EVERY short-closing BUY plus every unpaired long, a
 * single leg with a missing or unusable book meant ZERO exit orders were submitted — including the
 * risk-reducing BUY on a perfectly liquid short leg. `runWave`'s caller then returned
 * `{ ok: false, reason: "insufficient_quantity" }` having created no durable intent for anything.
 *
 * Note the asymmetry that shows the intended shape of the fix: wave 1 (hedge releases) ALREADY
 * treated a `precheck` throw as non-fatal, because withholding a hedge is the safe side.
 * Withholding a SHORT CLOSE is the UNSAFE side, so it must degrade to a per-leg refusal.
 *
 * WHAT MUST NOT CHANGE. A blocked leg is a PROVEN LOCAL ZERO — nothing was transmitted — which is
 * exactly how `BrokerPreSubmitRefusedError` is already classified: `{ filled: 0, certain: true }`.
 * It therefore releases NO hedge, and it must be recorded as withheld so the exit is never reported
 * as clean. Nothing may be submitted against a fabricated, stale or insufficient book.
 *
 * These tests run the REAL gateway → manager → durable persistence stack and enter a REAL box
 * first, because the entry is what gives the manager the attributed exposure that authorises a
 * reduction at all.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BOX_ENTRY_SIDES_BY_DIRECTION } from "../../dist/box/types.js";
import { exitSideFor } from "../../dist/box/math.js";
import {
  isExposureSafeExitSequence,
  planExitDependencies,
  verticalPartner,
} from "../../dist/box/exitDependencies.js";
import { LOT, positionFrom } from "./helpers.mjs";
import { brokerOrderFor, liveStack, NOW, runEntry } from "./liveEntryHarness.mjs";

/* ────────────────────────── fixture helpers ────────────────────────── */

/** SHORT roles (entry SELL) and LONG roles (entry BUY) for a direction. */
function geometry(direction) {
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];
  const shorts = Object.keys(sides).filter((role) => sides[role] === "SELL");
  const longs = Object.keys(sides).filter((role) => sides[role] === "BUY");
  return { sides, shorts, longs };
}

/** Detection legs for the exit, priced from the seeded book on the EXIT side of each role. */
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

/**
 * Build the live stack, ENTER a real box, then expose an EXIT runner.
 *
 * `cold` is a mutable Set of tokens that `precheck` will treat as having no current executable
 * depth. It is EMPTY during the entry (so the box really is entered) and populated afterwards, which
 * models a book going away between detection and the exit wave.
 */
async function exitStack(direction, answer, { position: positionOverrides = {} } = {}) {
  const cold = new Set();
  const stack = await liveStack({
    direction,
    isTokenWarm: (token) => !cold.has(token),
    // The exit path stamps every request through `precheck`, exactly as production does, so the
    // manager's CHECKPOINT 3 / 5 re-validation is wired here to keep the send boundary real.
    feedRevalidation: true,
    adapterOptions: {
      submit: async (req, adapter) =>
        (req.purpose === "ENTRY"
          ? brokerOrderFor(req, req.quantity, "COMPLETE")
          : answer(req.role, req, adapter)),
    },
  });

  const entry = await runEntry(stack);
  assert.equal(entry.ok, true, "fixture: the box must be entered before it can be exited");
  assert.equal(stack.adapter.posts.length, 4, "fixture: a complete box is four entry POSTs");

  const position = positionFrom(stack.candidate, { direction, ...positionOverrides });
  const tokenFor = (role) => stack.candidate.legs[role].token;
  const run = () => stack.gateway.simulateLeggingExit({
    position,
    detectionLegs: exitDetection(stack.candidate, stack.quotes, direction),
    detectedAt: NOW,
  });
  return { ...stack, position, cold, tokenFor, run, chill: (role) => cold.add(tokenFor(role)) };
}

/** Every EXIT POST that reached the (recording) broker, in transmission order. */
const exitPosts = (adapter) => adapter.posts.filter((post) => post.purpose !== "ENTRY");
const postsFor = (adapter, role) => exitPosts(adapter).filter((post) => post.role === role);
/** Quantity TRANSMITTED for a role (what was requested). This is the hedge-release SIZE. */
const sentFor = (adapter, role) => postsFor(adapter, role).reduce((total, post) => total + post.quantity, 0);
/** Quantity actually FILLED for a role, per the broker's answer. A request is not a fill. */
const closedFor = (adapter, role) =>
  postsFor(adapter, role).reduce(
    (total, post) => total + (adapter.orders.get(post.client_order_id)?.filled_quantity ?? 0),
    0,
  );

/** Answer helper: full fill for everything unless overridden per role. */
const answerBy = (overrides = {}) => (role, req) =>
  (overrides[role] ? overrides[role](req) : brokerOrderFor(req, req.quantity, "COMPLETE"));

/* ═══════════════════════════════ the matrix ═══════════════════════════════ */

for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
  const { shorts, longs, sides } = geometry(direction);
  const [shortA, shortB] = shorts;
  const hedgeOfA = verticalPartner(shortA);
  const hedgeOfB = verticalPartner(shortB);

  /* 1 — one short-close book MISSING; the other valid short close proceeds */
  test(`${direction}: a missing book on one short close does not block the OTHER short close`, async () => {
    const stack = await exitStack(direction, answerBy());
    stack.chill(shortA);

    const result = await stack.run();

    assert.equal(
      postsFor(stack.adapter, shortA).length,
      0,
      `${shortA} has no usable book, so nothing may be transmitted for it`,
    );
    assert.ok(
      postsFor(stack.adapter, shortB).length > 0,
      `${shortB} has a valid executable book and is risk-reducing; it MUST still be submitted ` +
        `even though ${shortA} is unusable`,
    );
    assert.equal(closedFor(stack.adapter, shortB), LOT, `${shortB} closes its full outstanding quantity`);
    // The exit is not clean, and the reason names the blocked leg.
    assert.equal(result.ok, false);
    assert.match(result.detail, new RegExp(shortA), "the blocked leg and its reason are reported");
  });

  /* 2 — one short-close book present but STALE / lacking bounded executable quantity */
  test(`${direction}: a short close lacking bounded executable depth is refused ALONE`, async () => {
    const stack = await exitStack(direction, answerBy());
    // Re-seed ONLY the blocked leg's token with a book that cannot cover one lot within the limit.
    const token = stack.tokenFor(shortA);
    const before = stack.quotes.get(token);
    stack.quotes.applyTicks(
      [{
        token,
        last_price: before.asks[0].price,
        // A real, present, FRESH book that is simply too THIN to cover one lot within the bounded
        // limit, so `walkDepth`'s executable_within_limit < quantity. This is a different refusal
        // condition from "no book at all" and must also be isolated to this leg.
        bids: [{ price: before.bids[0].price, qty: 1, orders: 1 }],
        asks: [{ price: before.asks[0].price, qty: 1, orders: 1 }],
      }],
      NOW,
    );
    assert.ok(stack.quotes.get(token), "fixture: the leg still HAS a book — it is thin, not absent");

    const result = await stack.run();

    assert.equal(
      postsFor(stack.adapter, shortA).length,
      0,
      "a leg without bounded executable depth must NOT be submitted — no fabricated or insufficient book",
    );
    assert.ok(
      postsFor(stack.adapter, shortB).length > 0,
      `${shortB} still has real depth and must proceed independently`,
    );
    assert.equal(result.ok, false);
  });

  /* 3 — one independent LONG-ONLY close unavailable; another valid close proceeds */
  test(`${direction}: an unavailable long-only close does not block an unpaired long close`, async () => {
    // Both shorts already flat, so BOTH longs are unpaired ⇒ both are wave-0 closes with no
    // hedge dependency between them. One is made unusable.
    const flatShorts = { [shortA]: 0, [shortB]: 0 };
    const stack = await exitStack(direction, answerBy(), {
      position: { remaining_qty_by_role: { ...flatShorts, [hedgeOfA]: LOT, [hedgeOfB]: LOT } },
    });
    const plan = planExitDependencies(direction, { [hedgeOfA]: LOT, [hedgeOfB]: LOT });
    assert.deepEqual(
      plan.wave0.map((slot) => slot.kind).sort(),
      ["close_unpaired_long", "close_unpaired_long"],
      "fixture: with both shorts flat, both longs are unpaired wave-0 closes",
    );
    stack.chill(hedgeOfA);

    await stack.run();

    assert.equal(postsFor(stack.adapter, hedgeOfA).length, 0, "the unusable long close is withheld");
    assert.ok(
      postsFor(stack.adapter, hedgeOfB).length > 0,
      "the OTHER unpaired long close is independent and must proceed",
    );
  });

  /* 4 — one HEDGE RELEASE unavailable; another eligible hedge release proceeds */
  test(`${direction}: one blocked hedge release does not suppress an unrelated eligible release`, async () => {
    const stack = await exitStack(direction, answerBy());
    // Both shorts close completely, so BOTH hedges become fully releasable…
    // …but one hedge's own book is unusable.
    stack.chill(hedgeOfA);

    await stack.run();

    assert.equal(closedFor(stack.adapter, shortA), LOT, "short A closed");
    assert.equal(closedFor(stack.adapter, shortB), LOT, "short B closed");
    assert.equal(postsFor(stack.adapter, hedgeOfA).length, 0, "the unusable hedge release is withheld");
    assert.ok(
      postsFor(stack.adapter, hedgeOfB).length > 0,
      "the other hedge is proven free and its book is fine; it MUST still be released",
    );
  });

  /* 5 — short close REJECTED / locally refused: its required hedge STAYS */
  test(`${direction}: a short close that is refused keeps its hedge on`, async () => {
    const stack = await exitStack(direction, answerBy({
      [shortA]: (req) => brokerOrderFor(req, 0, "CANCELLED"),
    }));

    await stack.run();

    assert.equal(sentFor(stack.adapter, shortA), LOT, "the close was attempted for the full outstanding quantity");
    assert.equal(
      postsFor(stack.adapter, hedgeOfA).length,
      0,
      `${shortA} did not close, so its hedge ${hedgeOfA} must NOT be released`,
    );
    assert.ok(
      postsFor(stack.adapter, hedgeOfB).length > 0,
      `${shortB} closed, so its own hedge ${hedgeOfB} is still eligible`,
    );
  });

  /* 6 — PARTIAL short closure: only proven-free hedge quantity may be released */
  test(`${direction}: a partial short close releases only the proven-free hedge quantity`, async () => {
    const half = Math.floor(LOT / 2);
    const stack = await exitStack(direction, answerBy({
      [shortA]: (req) => brokerOrderFor(req, half, "CANCELLED"),
    }));

    await stack.run();

    const released = sentFor(stack.adapter, hedgeOfA);
    assert.equal(
      released,
      half,
      `only the ${half} units proven no longer needed may be released from ${hedgeOfA}`,
    );
    assert.ok(released < LOT, "the remainder stays on as cover");
  });

  /* 7 — UNKNOWN outcome: no unsupported hedge release, and no duplicate retry identity */
  test(`${direction}: an unknown short-close outcome releases no hedge and creates no duplicate`, async () => {
    const stack = await exitStack(direction, answerBy({
      [shortA]: (req) => brokerOrderFor(req, 0, "UNKNOWN"),
    }));

    const result = await stack.run();

    assert.equal(
      postsFor(stack.adapter, hedgeOfA).length,
      0,
      "an unprovable short close releases NOTHING — uncertainty is not proof of closure",
    );
    assert.equal(result.ok, false);
    // Durable identity is one per (trade, purpose, role, attempt): no leg was sent twice.
    const ids = exitPosts(stack.adapter).map((post) => post.client_order_id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate exit identities were transmitted");
  });

  /* 8 — feed changes while a leg is QUEUED: the final send boundary still protects it */
  test(`${direction}: a book that dies during queueing is refused at the send boundary`, async () => {
    let stack;
    const stackRef = () => stack;
    stack = await exitStack(direction, answerBy());
    // Chill shortB's token WHILE shortA is waiting in adapter pacing, i.e. after the wave was
    // prechecked but before shortB is transmitted. CHECKPOINT 5 must catch it.
    stack.adapter.orders.clear();
    const original = stack.adapter.submitOrder;
    stack.adapter.submitOrder = async (req, beforePost) => {
      if (req.purpose !== "ENTRY" && req.role === shortA) stackRef().chill(shortB);
      return original(req, beforePost);
    };

    await stack.run();

    assert.ok(postsFor(stack.adapter, shortA).length > 0, `${shortA} was validated and transmitted`);
    assert.equal(
      postsFor(stack.adapter, shortB).length,
      0,
      `${shortB}'s book died after the wave precheck; the final send-boundary validation must refuse it`,
    );
  });

  /* 9 — a LATER retry closes only the remaining quantity */
  test(`${direction}: a later retry closes only the quantity still outstanding`, async () => {
    const half = Math.floor(LOT / 2);
    const stack = await exitStack(direction, answerBy({
      [shortA]: (req) => brokerOrderFor(req, half, "CANCELLED"),
    }));
    await stack.run();
    const firstAttempt = closedFor(stack.adapter, shortA);
    assert.equal(firstAttempt, half, "the first attempt closed half");

    // The position now records the reduced outstanding quantity, and a second detection retries.
    const retryPosition = positionFrom(stack.candidate, {
      direction,
      remaining_qty_by_role: {
        [shortA]: LOT - half,
        [shortB]: 0,
        [hedgeOfA]: LOT - half,
        [hedgeOfB]: 0,
      },
    });
    const before = exitPosts(stack.adapter).length;
    await stack.gateway.simulateLeggingExit({
      position: retryPosition,
      detectionLegs: exitDetection(stack.candidate, stack.quotes, direction),
      detectedAt: NOW + 1,
    });
    const retried = exitPosts(stack.adapter).slice(before).filter((post) => post.role === shortA);
    assert.equal(
      retried.reduce((total, post) => total + post.quantity, 0),
      LOT - half,
      "the retry sizes itself to the REMAINING quantity, never the original",
    );
  });

  /* 10 — a failure on one leg does not erase another leg's confirmed fills */
  test(`${direction}: one leg's failure does not erase another leg's confirmed fills`, async () => {
    const stack = await exitStack(direction, answerBy({
      [shortA]: () => { throw new Error("broker exploded for this leg only"); },
    }));

    const result = await stack.run();

    assert.equal(
      closedFor(stack.adapter, shortB),
      LOT,
      `${shortB}'s confirmed close must survive ${shortA}'s failure`,
    );
    // The RESULT must carry the confirmed close, or the caller cannot decrement the outstanding
    // quantity and the box would look un-exited despite a real, filled reduction.
    // `legsFromOrders` reports the filled quantity as `qty_at_touch`.
    const reported = (result.legs ?? []).find((leg) => leg.role === shortB);
    assert.ok(reported, `${shortB}'s confirmed close must appear in the exit result`);
    assert.equal(reported.qty_at_touch, LOT, "the full confirmed quantity is reported, not discarded");
    assert.equal(result.ok, false, "an uncertain leg means the exit is not reported as fully closed");
  });

  /* Exposure-safety oracle over the transmitted sequence, independent of the planner. */
  test(`${direction}: every transmitted exit sequence is exposure-safe (independent oracle)`, async () => {
    const stack = await exitStack(direction, answerBy({
      [shortA]: (req) => brokerOrderFor(req, 0, "CANCELLED"),
    }));
    stack.chill(hedgeOfB);

    await stack.run();

    // The oracle needs what each transmitted leg actually FILLED, which the recording adapter
    // reports through the order it answered with — the requested quantity is not a fill.
    const sent = exitPosts(stack.adapter).map((post) => ({
      role: post.role,
      quantity: post.quantity,
      filled: stack.adapter.orders.get(post.client_order_id)?.filled_quantity ?? 0,
    }));
    const outstanding = {};
    for (const role of Object.keys(sides)) outstanding[role] = LOT;
    assert.equal(
      isExposureSafeExitSequence(direction, outstanding, sent),
      true,
      `the transmitted sequence must be exposure-safe: ${JSON.stringify(sent)}`,
    );
  });
}
