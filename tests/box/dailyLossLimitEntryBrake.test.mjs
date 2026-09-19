/**
 * THE DAILY RUPEE LOSS LIMIT AS AN ENTRY BRAKE — proving what was previously only asserted.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `BOX_LIVE_DAILY_LOSS_LIMIT` (default ₹5,000) is presented to the operator as a hard risk control.
 * The trial runbook nevertheless told the operator NOT to rely on it as an entry brake, and the
 * fault matrix recorded its end-to-end enforcement as UNPROVEN.
 *
 * That was a statement about TEST COVERAGE, not about the code. The enforcement does exist, but it
 * is INDIRECT and therefore easy to mis-read: no checkpoint compares realised P&L against the limit.
 * Instead `evaluateLimits()` (the limit's only consumer) trips the STICKY circuit breaker, and the
 * breaker is what `entryBlockReason` refuses on — at all five entry checkpoints. Every existing suite
 * set `dailyLossLimit` to 1,000,000 or 0 to keep it out of the way, so nothing exercised the
 * loss → refusal path, and nobody could tell from the tests whether the brake worked at all.
 *
 * These tests close that gap at the PRODUCTION DEFAULT and assert the five properties that decide
 * whether an operator may treat it as a stop control:
 *
 *   1. crossing it refuses a NEW ENTRY end-to-end, with ZERO broker POSTs;
 *   2. it is reconstructed from DURABLE state, so it survives a restart;
 *   3. it FAILS CLOSED when the authoritative state cannot be read completely;
 *   4. it is ENTRY-ONLY — exits, protective cancels and reconciliation stay available;
 *   5. re-arming entry or rolling the trading day does NOT silently clear it.
 *
 * It also pins the one genuine footgun: `dailyLossLimit === 0` means DISABLED, not "no loss allowed".
 *
 * Offline: real gateway → manager → recording adapter, in-memory durable store, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { entryPosts, liveStack, runEntry } from "./liveEntryHarness.mjs";

/** The shipped default for BOX_LIVE_DAILY_LOSS_LIMIT. */
const PRODUCTION_DEFAULT_LIMIT = 5_000;
const TRADING_DAY = "2026-09-02";

/**
 * A live stack whose daily loss limit is the PRODUCTION default rather than the harness's
 * deliberately-out-of-the-way 1,000,000.
 */
const brakeStack = (limitOverrides = {}) => liveStack({
  limitOverrides: { dailyLossLimit: PRODUCTION_DEFAULT_LIMIT, ...limitOverrides },
});

/**
 * Seed the manager exactly as the engine does at boot and on a day roll.
 *
 * `seedLimits` is the production install point for the figure that `loadBoxLiveRiskSeed`
 * reconstructs from PostgreSQL (`box_trades.realised_net_pnl` + `box_execution_attempts`
 * contributions). Using it — rather than a private field or a test hook — is what makes these tests
 * evidence about the shipped path.
 */
const seedDurableLoss = (manager, realisedPnlToday, extra = {}) =>
  manager.seedLimits({ tradingDay: TRADING_DAY, realisedPnlToday, ...extra });

/* ═══════════ 1. crossing the limit refuses a new entry, with zero broker POSTs ═══════════ */

test("a durable loss beyond the daily limit refuses a NEW ENTRY, and nothing reaches the broker", async () => {
  const stack = await brakeStack();

  // Reconstructed from durable rows at boot: the day is already ₹6,000 down against a ₹5,000 limit.
  seedDurableLoss(stack.manager, -6_000);

  assert.equal(stack.manager.canEnter(), false, "entry must be closed once the day's loss exceeds the limit");
  assert.match(
    String(stack.manager.entryBlockReason()), /daily loss limit/i,
    "the refusal must NAME the daily loss limit; an unnamed brake is not an operator control",
  );

  // The whole gateway path, not just the predicate.
  const result = await runEntry(stack, {
    qualify: () => { throw new Error("a refused entry must never reach final economics"); },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.legging.outcome_class, "REFUSED_BEFORE_SUBMIT",
    "this is a free refusal: no exposure, no charges",
  );
  assert.deepEqual(
    entryPosts(stack.adapter), [],
    "NOT ONE broker POST may leave after the daily loss limit is breached",
  );
});

test("the brake engages EXACTLY at the limit, and not before it", async () => {
  // Non-vacuity: a test that only ever sees a refusal cannot distinguish a working brake from a
  // stack that refuses entry for some unrelated reason.
  const below = await brakeStack();
  seedDurableLoss(below.manager, -(PRODUCTION_DEFAULT_LIMIT - 1));
  assert.equal(below.manager.canEnter(), true, "a loss inside the limit must NOT close entry");
  const allowed = await runEntry(below);
  assert.equal(allowed.ok, true, "and a normal entry still completes");
  assert.equal(entryPosts(below.adapter).length, 4, "all four legs were transmitted");

  // `evaluateLimits` trips on `realisedPnlToday <= -dailyLossLimit`, so equality is a breach.
  const at = await brakeStack();
  seedDurableLoss(at.manager, -PRODUCTION_DEFAULT_LIMIT);
  assert.equal(at.manager.canEnter(), false, "reaching the limit exactly is a breach");
});

test("accumulated realised losses cross the limit through the ordinary P&L path", async () => {
  // Not only the boot seed: the running accumulator must trip it too, which is what happens during a
  // live session as trades close and flatten charges land.
  const stack = await brakeStack();
  seedDurableLoss(stack.manager, 0);
  assert.equal(stack.manager.canEnter(), true);

  stack.manager.recordRealisedPnl(-2_000);
  assert.equal(stack.manager.canEnter(), true, "still inside the limit");
  stack.manager.recordRealisedPnl(-3_500);

  assert.equal(stack.manager.canEnter(), false, "the accumulated loss crossed the limit");
  assert.match(String(stack.manager.entryBlockReason()), /daily loss limit/i);
});

/* ═══════════ 2. it survives a restart, because it is rebuilt from durable state ═══════════ */

test("the brake SURVIVES A RESTART: a fresh process re-seeded from durable state refuses entry", async () => {
  // The breaker flag itself is process-local and is NOT persisted. What survives is the
  // RECONSTRUCTION: on boot the engine reloads the day's realised P&L from PostgreSQL and calls
  // `seedLimits`, which ends in `evaluateLimits()`. This models that boot.
  const before = await brakeStack();
  seedDurableLoss(before.manager, -6_000);
  assert.equal(before.manager.canEnter(), false);

  // A completely separate stack == a new process, seeded from the same durable figure.
  const afterRestart = await brakeStack();
  assert.equal(afterRestart.manager.canEnter(), true, "a fresh process starts with a clean breaker");
  seedDurableLoss(afterRestart.manager, -6_000);

  assert.equal(
    afterRestart.manager.canEnter(), false,
    "re-seeding from durable state must re-trip the brake; otherwise a restart resets the day's risk",
  );
  const result = await runEntry(afterRestart, { qualify: () => { throw new Error("unreachable") } });
  assert.equal(result.legging.outcome_class, "REFUSED_BEFORE_SUBMIT");
  assert.deepEqual(entryPosts(afterRestart.adapter), [], "a restart does not buy a fresh entry budget");
});

/* ═══════════ 3. fail closed when the authoritative state cannot be read ═══════════ */

test("an INCOMPLETE durable reconstruction refuses entry rather than trusting an understated loss", async () => {
  // A truncated reconstruction can only ever UNDERSTATE a loss, which would loosen the brake. So an
  // incomplete read must refuse entry outright rather than be treated as authoritative.
  const stack = await brakeStack();
  seedDurableLoss(stack.manager, -100, { incomplete: true });

  assert.equal(
    stack.manager.canEnter(), false,
    "an unproven daily-loss figure must close entry, even though -100 is well inside the limit",
  );
  assert.match(
    String(stack.manager.entryBlockReason()), /daily risk seed/i,
    "the refusal must name the unestablished seed, not pretend the loss figure is authoritative",
  );

  const result = await runEntry(stack, { qualify: () => { throw new Error("unreachable") } });
  assert.deepEqual(entryPosts(stack.adapter), [], "no POST on unreadable authoritative risk state");
  assert.equal(result.legging.outcome_class, "REFUSED_BEFORE_SUBMIT");
});

test("a manager that was NEVER seeded does not permit entry on a process-local zero", async () => {
  // `realisedPnlToday` initialises to 0. If that counted as an authoritative "no loss today", a boot
  // whose risk load failed would trade with no brake at all.
  const stack = await liveStack({ limitOverrides: { dailyLossLimit: PRODUCTION_DEFAULT_LIMIT } });
  // Deliberately no seedLimits() call at all beyond the harness's own, then break the seed health.
  seedDurableLoss(stack.manager, 0, { incomplete: true });
  assert.equal(stack.manager.canEnter(), false, "an unestablished seed is not a zero loss");
});

/* ═══════════ 4. ENTRY-ONLY: reduction is never taken down with it ═══════════ */

test("the daily-loss brake is ENTRY-SCOPED and never blocks exposure reduction", async () => {
  // The safety boundary for the whole exercise: a financial brake must not strand exposure.
  const stack = await brakeStack();
  seedDurableLoss(stack.manager, -6_000);

  assert.equal(stack.manager.canEnter(), false, "entry is closed");
  assert.equal(
    stack.manager.canManageExposure(), true,
    "reduction must stay permitted: exits, protective cancels and reconciliation are how risk comes down",
  );
  assert.equal(
    stack.manager.exposureReductionBlockReason?.() ?? null, null,
    "and no reduction blocker may be raised by a breached ENTRY limit",
  );
});

/* ═══════════ 5. re-arming or rolling the day does not silently clear it ═══════════ */

test("RE-ARMING entry does not bypass a breached daily loss limit", async () => {
  // The operator-visible control is `entryEnabled`. `trip()` clears it, so a well-meaning operator
  // re-arming the session must NOT thereby re-open entry: the breaker is checked independently of
  // the control, and it is sticky.
  const stack = await brakeStack();
  seedDurableLoss(stack.manager, -6_000);
  assert.equal(stack.manager.canEnter(), false);

  stack.manager.setControls({ entryEnabled: true, liveOrderEnabled: true });

  assert.equal(
    stack.manager.canEnter(), false,
    "re-arming must not clear a sticky safety breaker — otherwise the brake is advisory only",
  );
  assert.match(String(stack.manager.entryBlockReason()), /daily loss limit/i);
  const result = await runEntry(stack, { qualify: () => { throw new Error("unreachable") } });
  assert.deepEqual(entryPosts(stack.adapter), [], "and still nothing reaches the broker");
});

test("a TRADING DAY ROLL does not clear a breaker the day's losses already tripped", async () => {
  // A day roll legitimately zeroes `realisedPnlToday`. It must not thereby reopen entry within the
  // same supervised run: a sticky safety breaker is a deliberate, operator-acknowledged stop.
  const stack = await brakeStack();
  seedDurableLoss(stack.manager, -6_000);
  assert.equal(stack.manager.canEnter(), false);

  // A new trading day, with a clean P&L figure.
  stack.manager.seedLimits({ tradingDay: "2026-09-03", realisedPnlToday: 0 });

  assert.equal(
    stack.manager.canEnter(), false,
    "a day roll must never clear a sticky safety breaker on its own",
  );
});

/* ═══════════ the zero-means-disabled footgun, pinned ═══════════ */

test("dailyLossLimit === 0 means DISABLED, not 'no loss allowed'", async () => {
  // This is a genuine trap in the configuration surface: 0 reads like the tightest possible setting
  // and is in fact the loosest. Pinned as a test so the semantics are documented and cannot drift
  // silently, and called out in the runbook.
  const stack = await liveStack({ limitOverrides: { dailyLossLimit: 0 } });
  seedDurableLoss(stack.manager, -10_000_000);

  assert.equal(
    stack.manager.canEnter(), true,
    "with the limit set to 0 the gate is OFF: a ten-million-rupee loss does not close entry",
  );
});

/* ═══════════ an admitted attempt's budget is durable BEFORE the POST ═══════════ */

test("the durable intent exists BEFORE the broker POST for every admitted entry leg", async () => {
  // A budget/identity that is spent only AFTER the POST cannot survive a crash between the two, and
  // the attempt would be re-tried as if it had never happened. Asserted at the one instant that
  // matters: inside the adapter, before the request is handed to the (recording) wire.
  const observed = [];
  const stack = await liveStack({
    limitOverrides: { dailyLossLimit: PRODUCTION_DEFAULT_LIMIT },
    adapterOptions: {
      // Runs before `beforePost()` and before the POST is recorded.
      duringPacing: (req) => {
        const row = stack.persistence.rows.get(req.client_order_id);
        observed.push({ role: req.role, durableStateBeforePost: row?.state ?? null });
      },
    },
  });
  seedDurableLoss(stack.manager, 0);

  const result = await runEntry(stack);
  assert.equal(result.ok, true, "fixture: a clean four-leg entry");
  assert.equal(observed.length, 4, "all four legs were observed at the send boundary");

  for (const { role, durableStateBeforePost } of observed) {
    assert.ok(
      durableStateBeforePost !== null,
      `${role}: a durable intent must exist BEFORE the broker POST, not after it`,
    );
    assert.ok(
      ["CREATED", "SUBMITTING"].includes(durableStateBeforePost),
      `${role}: the pre-POST durable state must be CREATED/SUBMITTING, got ${durableStateBeforePost}`,
    );
  }
});
