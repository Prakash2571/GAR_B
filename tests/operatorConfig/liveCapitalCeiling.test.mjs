/**
 * THE PER-BOX ₹ CEILING MAY NOT BE SILENTLY ABSENT IN LIVE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The three live size ceilings were not equally protected:
 *
 *   BOX_LIVE_MAX_OPEN_LEG_QUANTITY        strictLimitInt(…, min 1, …)  → 0 REFUSED at boot
 *   BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY  strictLimitInt(…, min 1, …)  → 0 REFUSED at boot
 *   BOX_LIVE_MAX_BOX_CAPITAL_RUPEES       strictLimitInt(…, min 0, …)  → 0 ACCEPTED = NO CEILING
 *
 * `0` legitimately means "disabled" for that variable — `capitalBlockReason` returns `null` on
 * `limit <= 0` — and that default existed so the cap could be added without changing an existing
 * deployment's behaviour. But the quantity ceilings bound LOTS, and lots are not money: a Box can
 * satisfy both quantity caps and still commit an arbitrary rupee amount, because notional is
 * price × quantity and neither cap says anything about price.
 *
 * `.env.example` ships the variable at `0`, so on a real-money supervised test the single most likely
 * operator mistake was leaving the one monetary ceiling at its shipped value and never being told.
 *
 * These run against `src/box/config.ts` directly, so they need no build.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

import { repoPath } from "./_harness.mjs";

register(pathToFileURL(repoPath("tests", "helpers", "tsResolve.mjs")).href);
const { loadBoxConfig } = await import(pathToFileURL(repoPath("src", "box", "config.ts")).href);

/**
 * Run `loadBoxConfig()` under an isolated environment.
 *
 * `loadBoxConfig` reads `process.env` at call time, so the single cached ESM import is safe. Every
 * key touched is restored in `finally`, including keys that were previously ABSENT (deleted rather
 * than set to `undefined`, which `strictLimitInt` would otherwise read as the string "undefined").
 */
function withEnv(values, fn) {
  const saved = new Map();
  for (const key of Object.keys(values)) saved.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = String(value);
    }
    return fn();
  } finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

/** The minimum a live boot needs, so each test varies exactly one thing. */
const LIVE = {
  BOX_EXECUTION_MODE: "live",
  BOX_LIVE_TRADING_ENABLED: "true",
  BOX_PAPER_EXECUTION_PROFILE: "standard",
  BOX_SHADOW_MODE_ENABLED: "false",
  BOX_EXECUTION_COORDINATOR_ENABLED: "true",
};

/* ═════════════════ 1. Live refuses a disabled ₹ ceiling ═════════════════ */

test("live mode REFUSES to boot with the per-Box capital ceiling disabled", () => {
  assert.throws(
    () => withEnv({ ...LIVE, BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "0" }, () => loadBoxConfig()),
    /BOX_LIVE_MAX_BOX_CAPITAL_RUPEES=0 disables the per-Box/,
  );
});

test("the refusal explains WHY the quantity caps are not a substitute", () => {
  // The message has to carry the reasoning, because the obvious operator response to this refusal is
  // "but I already capped the quantity" — and that is exactly the misunderstanding it exists to correct.
  try {
    withEnv({ ...LIVE, BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "0" }, () => loadBoxConfig());
    assert.fail("expected a refusal");
  } catch (err) {
    assert.match(err.message, /only monetary containment/i);
    assert.match(err.message, /bound LOTS/);
    assert.match(err.message, /price × quantity/);
    // And it must name a concrete next action rather than only complaining.
    assert.match(err.message, /100000/);
  }
});

test("the ceiling being UNSET is refused too, because its default is 0", () => {
  // Unset resolves to the code default of 0, which is the same absent ceiling. An operator who never
  // set the variable must get the same refusal as one who set it to 0.
  assert.throws(
    () => withEnv({ ...LIVE, BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: undefined }, () => loadBoxConfig()),
    /BOX_LIVE_MAX_BOX_CAPITAL_RUPEES=0 disables the per-Box/,
  );
});

/* ═════════════════ 2. A real ceiling boots, and is carried through ═════════════════ */

test("live mode boots with a positive ceiling, and the value reaches BoxConfig", () => {
  const cfg = withEnv(
    { ...LIVE, BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "100000" },
    () => loadBoxConfig(),
  );
  assert.equal(cfg.executionMode, "live");
  assert.equal(cfg.liveMaxBoxCapitalRupees, 100_000);
});

test("the smallest positive ceiling is accepted — the rule is 'present', not 'large'", () => {
  const cfg = withEnv({ ...LIVE, BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "1" }, () => loadBoxConfig());
  assert.equal(cfg.liveMaxBoxCapitalRupees, 1);
});

/* ═════════════════ 3. Paper is deliberately untouched ═════════════════ */

test("paper modes still accept a disabled ceiling, so a rehearsal is unaffected", () => {
  // Paper has its own BOX_PAPER_MAX_BOX_CAPITAL_RUPEES where 0 costs nothing. Scoping the refusal to
  // live is what keeps this from breaking every development and paper deployment.
  for (const mode of ["paper_latency", "paper_touch", "paper_legging"]) {
    const cfg = withEnv(
      {
        BOX_EXECUTION_MODE: mode,
        BOX_LIVE_TRADING_ENABLED: "false",
        BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "0",
      },
      () => loadBoxConfig(),
    );
    assert.equal(cfg.executionMode, mode, `${mode} did not load`);
    assert.equal(cfg.liveMaxBoxCapitalRupees, 0, `${mode} should keep the disabled ceiling`);
  }
});

/* ═════════════════ 4. The asymmetry that motivated this is real ═════════════════ */

test("the two quantity ceilings already refuse 0, so all three now agree", () => {
  // Proves the premise rather than asserting it: the quantity caps have min 1, so 0 was ALREADY
  // refused by strictLimitInt. The capital cap was the only one of the three that could be silently
  // absent, and now none of them can.
  for (const key of ["BOX_LIVE_MAX_OPEN_LEG_QUANTITY", "BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY"]) {
    assert.throws(
      () =>
        withEnv({ ...LIVE, BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "100000", [key]: "0" }, () =>
          loadBoxConfig(),
        ),
      /outside the permitted range/,
      `${key} unexpectedly accepted 0`,
    );
  }
});

test("a one-lot NIFTY live envelope loads cleanly end to end", () => {
  // The exact posture a supervised one-lot test runs, so a future change to any of these refusals
  // fails here rather than at 09:15 on the deployment.
  const cfg = withEnv(
    {
      ...LIVE,
      BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "100000",
      BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "75",
      BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "300",
      BOX_MAX_OPEN_BOXES: "1",
      BOX_SESSION_MAX_ENTRY_ATTEMPTS: "1",
      BOX_SESSION_MAX_COMPLETED_TRADES: "1",
      BOX_ONE_ACTIVE_BOX_PER_UNDERLYING: "true",
      BOX_LIVE_DAILY_LOSS_LIMIT: "5000",
    },
    () => loadBoxConfig(),
  );

  assert.equal(cfg.liveMaxBoxCapitalRupees, 100_000);
  assert.equal(cfg.liveMaxOpenLegQuantity, 75);
  assert.equal(cfg.liveMaxGrossOpenLegQuantity, 300);
  assert.equal(cfg.maxOpenBoxes, 1);
  assert.equal(cfg.sessionMaxEntryAttempts, 1);
  assert.equal(cfg.sessionMaxCompletedTrades, 1);
  assert.equal(cfg.oneActiveBoxPerUnderlying, true);
  assert.equal(cfg.liveDailyLossLimit, 5000);
  // Four legs of one 75 lot must fit inside the gross ceiling, or no entry could ever be admitted.
  assert.ok(cfg.liveMaxOpenLegQuantity * 4 <= cfg.liveMaxGrossOpenLegQuantity);
});
