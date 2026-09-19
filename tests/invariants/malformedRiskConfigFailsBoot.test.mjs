/**
 * MALFORMED RISK CONFIGURATION MUST FAIL BOOT, NOT RESOLVE TO SOMETHING PERMISSIVE.
 *
 * The rule these tests pin, for every safety-sensitive setting:
 *
 *     UNSET                     -> the documented default, silently
 *     EXPLICIT AND VALID        -> exactly that value
 *     EXPLICIT AND MALFORMED    -> BOOT FAILURE
 *
 * The third line is the one that was missing. Four containment limits were parsed by helpers that
 * funnel every kind of bad input to the fallback or the nearest bound, and for these four that
 * resolved *towards permissiveness*:
 *
 *     BOX_MAX_UNDERLYINGS="abc"            -> NaN -> fallback 0 -> 0 means UNLIMITED
 *     BOX_MAX_UNDERLYINGS="-4"             -> -4  passed through raw (`num()` has no bounds at all)
 *     BOX_MAX_UNDERLYINGS="1.7"            -> 1.7 passed through raw
 *     BOX_STRIKE_LEVEL="abc" or "7"        -> 3, the WIDEST candidate set
 *     BOX_LIVE_MAX_RESIDUAL_LEGS="abc"/"9" -> 1 / 4, silently defaulted or widened
 *     BOX_MAX_CONCURRENT_PER_UNDERLYING="abc" -> 2
 *
 * An operator narrowing a supervised one-box trial is exactly the person most likely to be editing
 * these, and a typo handed them a WIDER envelope than the default while reporting nothing. That is
 * the inverse of what a containment limit is for.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHANGE. The `0` sentinels keep their existing meanings —
 * `BOX_MAX_UNDERLYINGS=0` still means unlimited and `BOX_LIVE_MAX_RESIDUAL_LEGS=0` still means
 * tolerate none. Reinterpreting a WELL-FORMED value would silently alter production behaviour on
 * upgrade, which is a separate migration. These tests assert both halves: the sentinels still load,
 * and malformed input is refused.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadBoxConfig } from "../../dist/box/config.js";
import { resolveEffectiveConfig } from "../../dist/box/effectiveConfig.js";

/** Set env vars for the duration of `body`, restoring every key afterwards. */
function withEnv(vars, body) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Every case runs in paper so nothing here can depend on a live gate. */
const PAPER = { BOX_EXECUTION_MODE: "paper_latency" };

/* ───────────────────────── the default is still reachable ───────────────────────── */

test("UNSET leaves every one of the four at its documented default", () => {
  withEnv(
    {
      ...PAPER,
      BOX_MAX_UNDERLYINGS: undefined,
      BOX_STRIKE_LEVEL: undefined,
      BOX_LIVE_MAX_RESIDUAL_LEGS: undefined,
      BOX_MAX_CONCURRENT_PER_UNDERLYING: undefined,
    },
    () => {
      const cfg = loadBoxConfig();
      assert.equal(cfg.maxUnderlyings, 0, "0 is the documented default and means unlimited");
      assert.equal(cfg.defaultStrikeLevel, 3);
      assert.equal(cfg.liveMaxResidualLegs, 1);
      assert.equal(cfg.maxConcurrentPerUnderlying, 2);
    },
  );
});

/* ─────────── an explicitly-set VALID value is honoured, sentinels included ─────────── */

test("an explicit VALID value is used, and the 0 sentinels keep their existing meaning", () => {
  withEnv({ ...PAPER, BOX_MAX_UNDERLYINGS: "1" }, () => {
    assert.equal(loadBoxConfig().maxUnderlyings, 1);
  });
  // The sentinel is NOT reinterpreted by this change: 0 still means "no cap on the universe".
  withEnv({ ...PAPER, BOX_MAX_UNDERLYINGS: "0" }, () => {
    assert.equal(loadBoxConfig().maxUnderlyings, 0);
  });
  withEnv({ ...PAPER, BOX_STRIKE_LEVEL: "1" }, () => {
    assert.equal(loadBoxConfig().defaultStrikeLevel, 1, "ATM±1, the narrowest scan");
  });
  withEnv({ ...PAPER, BOX_STRIKE_LEVEL: "2" }, () => {
    assert.equal(loadBoxConfig().defaultStrikeLevel, 2);
  });
  // 0 here means "tolerate no residual legs at all" — the comparison against it is strictly `>`.
  withEnv({ ...PAPER, BOX_LIVE_MAX_RESIDUAL_LEGS: "0" }, () => {
    assert.equal(loadBoxConfig().liveMaxResidualLegs, 0);
  });
  withEnv({ ...PAPER, BOX_MAX_CONCURRENT_PER_UNDERLYING: "1" }, () => {
    assert.equal(loadBoxConfig().maxConcurrentPerUnderlying, 1);
  });
});

/* ───────────────────── an explicitly-set MALFORMED value is fatal ───────────────────── */

/**
 * Each row is (variable, value, why it used to be dangerous). A single table rather than a test per
 * case so that adding a newly-hardened variable is one line, and so a regression shows up as the
 * specific variable that stopped refusing.
 */
const MALFORMED = [
  ["BOX_MAX_UNDERLYINGS", "abc", "NaN previously fell back to 0, which means UNLIMITED"],
  ["BOX_MAX_UNDERLYINGS", "one", "a spelled-out number is the likeliest human error"],
  ["BOX_MAX_UNDERLYINGS", "-4", "a negative cap previously reached the engine unaltered"],
  ["BOX_MAX_UNDERLYINGS", "1.7", "a fractional cap previously reached the engine unaltered"],
  ["BOX_MAX_UNDERLYINGS", "1001", "above the generous upper bound, so almost certainly a typo"],
  ["BOX_STRIKE_LEVEL", "abc", "previously resolved to 3 — the WIDEST scan, not the narrowest"],
  ["BOX_STRIKE_LEVEL", "7", "previously clamped to 3 rather than being questioned"],
  ["BOX_STRIKE_LEVEL", "0", "below the valid 1..3 range"],
  ["BOX_LIVE_MAX_RESIDUAL_LEGS", "abc", "previously resolved silently to the default 1"],
  ["BOX_LIVE_MAX_RESIDUAL_LEGS", "9", "previously clamped to 4, widening the tolerance"],
  ["BOX_LIVE_MAX_RESIDUAL_LEGS", "-1", "a negative tolerance is meaningless"],
  ["BOX_MAX_CONCURRENT_PER_UNDERLYING", "abc", "previously resolved silently to the default 2"],
  ["BOX_MAX_CONCURRENT_PER_UNDERLYING", "99", "above the 0..16 range"],
];

for (const [name, value, why] of MALFORMED) {
  test(`${name}="${value}" REFUSES to boot (${why})`, () => {
    withEnv({ ...PAPER, [name]: value }, () => {
      assert.throws(
        () => loadBoxConfig(),
        (err) => {
          assert.match(err.message, new RegExp(name), "the refusal must name the offending variable");
          return true;
        },
        `${name}="${value}" must not resolve to any value at all`,
      );
    });
  });
}

/* ───────────── the boolean that was already strict must stay strict ───────────── */

test("BOX_ONE_ACTIVE_BOX_PER_UNDERLYING='ture' still refuses rather than reading as false", () => {
  withEnv({ ...PAPER, BOX_ONE_ACTIVE_BOX_PER_UNDERLYING: "ture" }, () => {
    assert.throws(() => loadBoxConfig(), /BOX_ONE_ACTIVE_BOX_PER_UNDERLYING/);
  });
  // ...and the legitimate spellings still work, in both directions.
  for (const [raw, expected] of [["true", true], ["1", true], ["yes", true], ["false", false], ["no", false]]) {
    withEnv({ ...PAPER, BOX_ONE_ACTIVE_BOX_PER_UNDERLYING: raw }, () => {
      assert.equal(loadBoxConfig().oneActiveBoxPerUnderlying, expected);
    });
  }
});

/* ───────────── the diagnostics surface must not contradict the loader ───────────── */

/**
 * `effectiveConfig` is a REPORT of what is in force and its stated contract is that it mirrors
 * `loadBoxConfig`. It honours that by CONSTRUCTION rather than by description: it calls the real
 * loader (`loadWith` -> `loadBoxConfig`) before building any field report, so a value the loader
 * refuses makes the whole report unavailable instead of being described as a reassuring
 * `env_clamped`.
 *
 * That is the correct behaviour and worth pinning, because the alternative is the failure this
 * whole file exists to prevent: a diagnostics surface cheerfully reporting a containment limit that
 * the process would never actually boot with.
 *
 * (Note for future readers: the `env_invalid_refused` branch inside `resolveKnob` is therefore
 * unreachable for every `strict` knob. It is left in place as defence-in-depth for any future
 * caller that reports without loading, and this test documents why it never fires today.)
 */
test("effectiveConfig cannot report a config the loader would refuse", () => {
  for (const bad of [
    { BOX_LIVE_MAX_RESIDUAL_LEGS: "9" },
    { BOX_MAX_CONCURRENT_PER_UNDERLYING: "99" },
    { BOX_MAX_UNDERLYINGS: "abc" },
    { BOX_STRIKE_LEVEL: "7" },
  ]) {
    const name = Object.keys(bad)[0];
    assert.throws(
      () => resolveEffectiveConfig({ BOX_EXECUTION_MODE: "paper_latency", ...bad }),
      new RegExp(name),
      `${name} must make the report unavailable, not produce a reassuring one`,
    );
  }
});

/**
 * ...and the report is still produced for a VALID configuration, including the `0` sentinels. A
 * refusal that also broke the ordinary reporting path would be a regression in its own right.
 */
test("effectiveConfig still reports normally for valid values and the 0 sentinels", () => {
  const report = resolveEffectiveConfig({
    BOX_EXECUTION_MODE: "paper_latency",
    BOX_MAX_UNDERLYINGS: "0",
    BOX_STRIKE_LEVEL: "1",
    BOX_LIVE_MAX_RESIDUAL_LEGS: "0",
    BOX_MAX_CONCURRENT_PER_UNDERLYING: "1",
  });
  const byKey = new Map(report.values.map((v) => [String(v.key), v]));
  assert.equal(byKey.get("liveMaxResidualLegs").value, 0);
  assert.equal(byKey.get("liveMaxResidualLegs").source, "env");
  assert.equal(byKey.get("maxConcurrentPerUnderlying").value, 1);
  assert.equal(byKey.get("maxConcurrentPerUnderlying").source, "env");
});
