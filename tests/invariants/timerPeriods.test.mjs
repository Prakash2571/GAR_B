/**
 * A ZERO TIMER PERIOD MUST NEVER BE HONOURED.
 *
 * Five Box config values are passed straight to `setInterval`: the universe refresh, the
 * indicative refresh, the SSE publish, the position monitor and the persist cadence.
 * `setInterval(fn, 0)` does not mean "disabled" and does not mean "use the default" — it means
 * run as fast as the event loop allows, forever.
 *
 * This is not hypothetical. `.env.example` shipped `BOX_UNIVERSE_REFRESH_MS=0` (and thirteen
 * other `*_MS=0` knobs with non-zero code defaults) under a header promising "the defaults ARE
 * the shipped specification", while the plain `num()` reader treats an explicit `0` as a finite
 * value and returns it. Copying the example file — the documented way to start — turned four
 * timers into spin loops at once. The event loop saturated, which starved the market-data
 * drain, so depth never arrived and the feed reported DOWN while its socket was open, and HTTP
 * requests intermittently 502'd at the reverse proxy. Four unrelated-looking failures, none of
 * which named the cause.
 *
 * These tests pin the two halves of the fix: the loader refuses a non-positive period, and the
 * shipped example file no longer contains a zero that would override a real default.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadBoxConfig } from "../../dist/box/config.js";

/** Run `fn` with `vars` applied to process.env, restoring whatever was there before. */
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The five values that become a timer period, with their documented defaults. */
const PERIODS = [
  ["BOX_UNIVERSE_REFRESH_MS", "universeRefreshMs", 60_000],
  ["BOX_INDICATIVE_REFRESH_MS", "indicativeRefreshMs", 60_000],
  ["BOX_PUBLISH_INTERVAL_MS", "publishIntervalMs", 500],
  ["BOX_MONITOR_INTERVAL_MS", "monitorIntervalMs", 1_000],
  ["BOX_PERSIST_INTERVAL_MS", "persistIntervalMs", 30_000],
];

test("an explicit 0 falls back to the default instead of becoming a spin loop", () => {
  for (const [envName, field, expected] of PERIODS) {
    const cfg = withEnv({ [envName]: "0" }, () => loadBoxConfig());
    assert.equal(
      cfg[field],
      expected,
      `${envName}=0 must resolve to the default ${expected}, not 0 — setInterval(fn, 0) is a hot loop`,
    );
    assert.ok(cfg[field] > 0, `${field} must always be a positive period`);
  }
});

test("a negative or unparseable period also falls back", () => {
  for (const [envName, field, expected] of PERIODS) {
    for (const bad of ["-1", "-60000", "abc", "NaN"]) {
      const cfg = withEnv({ [envName]: bad }, () => loadBoxConfig());
      assert.equal(cfg[field], expected, `${envName}="${bad}" must resolve to ${expected}`);
    }
  }
});

test("an unset period uses the default, and a real value is honoured", () => {
  for (const [envName, field, expected] of PERIODS) {
    assert.equal(withEnv({ [envName]: null }, () => loadBoxConfig())[field], expected);
    assert.equal(withEnv({ [envName]: "" }, () => loadBoxConfig())[field], expected);
    assert.equal(withEnv({ [envName]: "2500" }, () => loadBoxConfig())[field], 2_500);
  }
});

test("a positive but absurdly small period is floored, not taken literally", () => {
  // A typo like `1` would approximate the same spin loop the zero produced.
  for (const [envName, field] of PERIODS) {
    const cfg = withEnv({ [envName]: "1" }, () => loadBoxConfig());
    assert.ok(cfg[field] >= 10, `${field} must be floored (got ${cfg[field]})`);
  }
});

test("knobs whose 0 legitimately means unbounded/disabled are NOT changed", () => {
  // The fix must be surgical: `periodMs` is only for values that become a timer. A knob that
  // uses 0 to mean "no ceiling" must keep reading 0 as exactly that, or a deployment relying on
  // it would silently acquire a limit it never asked for.
  const cfg = withEnv(
    { BOX_MAX_UNDERLYINGS: "0", BOX_MAX_SUBSCRIBED_TOKENS: "0", BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS: "0" },
    () => loadBoxConfig(),
  );
  assert.equal(cfg.maxUnderlyings, 0, "0 means unbounded here and must survive");
  assert.equal(cfg.maxSubscribedTokens, 0, "0 means unbounded here and must survive");
  assert.equal(cfg.maxCrossLegExchangeDispersionMs, 0, "0 disables this constraint by design");
});

test(".env.example ships no *_MS=0 that would override a non-zero default", () => {
  // The second half of the fix, and the half that actually bit: the loader can only defend the
  // five timer periods. A zero in the example file silently replaced the default for fourteen
  // timing knobs, and copying that file is the documented way to start.
  const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const zeroed = [...example.matchAll(/^([A-Z_]+_MS)=0$/gm)].map((m) => m[1]);

  const source = readFileSync(new URL("../../src/box/config.ts", import.meta.url), "utf8");
  const offenders = zeroed.filter((name) => {
    const m = new RegExp(`(?:num|periodMs)\\("${name}",\\s*([0-9_]+)`).exec(source);
    const codeDefault = m ? Number(m[1].replace(/_/g, "")) : 0;
    return codeDefault > 0;
  });

  assert.deepEqual(
    offenders,
    [],
    `.env.example sets these to 0, silently overriding a non-zero code default. Leave them ` +
      `EMPTY to use the default: ${offenders.join(", ")}`,
  );
});
