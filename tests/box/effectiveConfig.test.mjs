/**
 * Effective-configuration surface: PRECEDENCE, PROVENANCE, and the proof that
 * REAL TRADING IS DISABLED BY DEFAULT.
 *
 * Item 11 requires more than a document: a runtime surface that reports the
 * RESOLVED value of every knob AND where it came from, plus a test that a
 * default-configured process refuses live entry. This file is that test.
 *
 * The surface under test is `src/box/effectiveConfig.ts`, which resolves against
 * the same `process.env` and the same parse/clamp rules as `loadBoxConfig`. The
 * final block reaches through the REAL `BoxOrderManager` entry gate to prove the
 * default posture in code, not just in config.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveEffectiveConfig,
  renderEffectiveConfig,
} from "../../dist/box/effectiveConfig.js";
import { loadBoxConfig } from "../../dist/box/config.js";
import { BoxOrderManager } from "../../dist/box/orderManager.js";

/** Set/restore an arbitrary set of env keys around fn. */
function withEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key)
        ? { present: true, value: process.env[key] }
        : { present: false },
    );
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, old] of previous) {
      if (old.present) process.env[key] = old.value;
      else delete process.env[key];
    }
  }
}

const findValue = (report, key) => report.values.find((v) => v.key === key);

/* --------------------------- precedence + provenance --------------------------- */

test("precedence is documented on the surface itself (default < environment)", () => {
  const report = resolveEffectiveConfig({});
  assert.ok(report.precedence.length >= 2);
  assert.match(report.precedence[0], /code default/i);
  assert.match(report.precedence[1], /environment/i);
});

test("an UNSET knob is reported as `default`, with the value equal to the code default", () => {
  const report = resolveEffectiveConfig({});
  const openBoxes = findValue(report, "liveMaxOpenBoxes");
  assert.equal(openBoxes.source, "default");
  assert.equal(openBoxes.value, 1);
  assert.equal(openBoxes.rawEnv, null);
});

test("environment OVERRIDES the default, and provenance says so", () => {
  const report = resolveEffectiveConfig({ BOX_ONE_ACTIVE_BOX_PER_UNDERLYING: "true" });
  const knob = findValue(report, "oneActiveBoxPerUnderlying");
  assert.equal(knob.value, true);
  assert.equal(knob.source, "env");
  assert.equal(knob.default, false); // the default it overrode
});

test("an OUT-OF-RANGE env value is CLAMPED, and the surface shows the requested vs effective", () => {
  const report = resolveEffectiveConfig({ BOX_LIVE_MAX_OPEN_BOXES: "99" });
  const knob = findValue(report, "liveMaxOpenBoxes");
  assert.equal(knob.source, "env_clamped");
  assert.equal(knob.value, 20, "99 is clamped to the max of 20 — the value actually in force");
  assert.match(knob.note ?? "", /clamp/i);
});

test("an UNPARSEABLE numeric env value FALLS BACK to the default", () => {
  const report = resolveEffectiveConfig({ BOX_QUOTE_MAX_AGE_MS: "not-a-number" });
  const knob = findValue(report, "quoteMaxAgeMs");
  assert.equal(knob.source, "env_invalid_fallback");
  assert.equal(knob.value, 15_000);
});

test("an unrecognised boolean FALLS BACK (a safety gate is never armed by a typo)", () => {
  // `ture` must never read as true.
  const report = resolveEffectiveConfig({ BOX_LIVE_TRADING_ENABLED: "ture" });
  const knob = findValue(report, "liveTradingEnabled");
  assert.equal(knob.value, false);
  assert.equal(knob.source, "env_invalid_fallback");
});

test("the RESOLVED values equal what loadBoxConfig actually loads (one parser, no drift)", () => {
  const env = {
    BOX_LIVE_MAX_OPEN_BOXES: "99", // clamped
    BOX_QUOTE_MAX_AGE_MS: "20000", // plain override
    BOX_ONE_ACTIVE_BOX_PER_UNDERLYING: "true",
    BOX_LIVE_DAILY_LOSS_LIMIT: "3000",
    BOX_SESSION_MAX_COMPLETED_TRADES: "1",
  };
  const report = resolveEffectiveConfig(env);
  const cfg = withEnv(env, () => loadBoxConfig());
  for (const v of report.values) {
    assert.deepEqual(
      v.value,
      cfg[v.key],
      `effectiveConfig.${v.key}=${JSON.stringify(v.value)} must equal loadBoxConfig.${v.key}=${JSON.stringify(cfg[v.key])}`,
    );
  }
});

test("the human-readable render flags every clamped / fallback value", () => {
  const report = resolveEffectiveConfig({
    BOX_LIVE_MAX_OPEN_BOXES: "99",
    BOX_QUOTE_MAX_AGE_MS: "garbage",
  });
  const text = renderEffectiveConfig(report);
  assert.match(text, /ATTENTION/);
  assert.match(text, /BOX_LIVE_MAX_OPEN_BOXES/);
  assert.match(text, /BOX_QUOTE_MAX_AGE_MS/);
});

test("the surface refuses to report a configuration that would not boot", () => {
  assert.throws(
    () => resolveEffectiveConfig({ BOX_EXECUTION_MODE: "bogus" }),
    /invalid BOX_EXECUTION_MODE/,
  );
  assert.throws(
    () => resolveEffectiveConfig({ BOX_EXECUTION_MODE: "live" }), // kill switch absent
    /requires BOX_LIVE_TRADING_ENABLED=true/,
  );
});

/* ----------------------- trading disabled by default ----------------------- */

test("DEFAULT config is paper, live disabled, and reports NOT armed", () => {
  const report = resolveEffectiveConfig({});
  assert.equal(report.liveTradingArmed, false);
  assert.equal(findValue(report, "executionMode").value, "paper_latency");
  assert.equal(findValue(report, "liveTradingEnabled").value, false);
});

test("live is 'armed' on the surface ONLY when BOTH switches are set", () => {
  assert.equal(
    resolveEffectiveConfig({
      BOX_EXECUTION_MODE: "live",
      BOX_LIVE_TRADING_ENABLED: "true",
      // Required for a live resolution to load at all: the per-Box ₹ ceiling is the only monetary
      // containment and `loadBoxConfig` refuses it disabled in live. Immaterial to what this test
      // asserts (that `liveTradingArmed` needs BOTH switches), so it is supplied rather than tested.
      BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "100000",
    }).liveTradingArmed,
    true,
  );
  // Kill switch on but mode still paper → not armed (and would not place a live order).
  assert.equal(
    resolveEffectiveConfig({ BOX_LIVE_TRADING_ENABLED: "true" }).liveTradingArmed,
    false,
  );
});

/**
 * The CODE-PATH proof: a default-configured BoxOrderManager refuses live entry,
 * and entry authority is SEPARATE from exposure-management permission.
 *
 * `controls` is omitted, so both `entryEnabled` and `liveOrderEnabled` default to
 * `false` (orderManager.ts:590-591). We assert the entry gate and the
 * exposure-management gate directly — no reconcile, no transport — because the
 * point is that the DEFAULT refuses before anything else is even consulted.
 */
function minimalManager(controls) {
  const noopAdapter = {
    submitOrder: async () => { throw new Error("must not submit in this test"); },
    cancelOrder: async () => undefined,
    getOrder: async () => undefined,
    listOrders: async () => [],
    listPositions: async () => [],
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 0 }),
    adoptOrder: async (intent, snapshot) => ({ ...snapshot, client_order_id: intent.client_order_id }),
  };
  const noopPersistence = {
    create: async (intent) => intent,
    update: async () => ({ ok: true }),
    loadNonterminal: async () => [],
    findByClientId: async () => null,
    findByBrokerId: async () => null,
  };
  const deps = {
    adapter: noopAdapter,
    persistence: noopPersistence,
    limits: {
      maxOpenBoxes: 1,
      maxConcurrentExecutions: 1,
      maxResidualLegs: 1,
      dailyLossLimit: 5_000,
      rejectLimit: 3,
      consecutiveFailureLimit: 3,
      maxOpenLegQuantity: 100,
      maxGrossOpenLegQuantity: 400,
      reconcileIntervalMs: 60_000,
      feedReconnectWarmupMs: 0,
    },
    clock: { now: () => 10_000 },
    istDayKey: () => "2026-09-10",
  };
  if (controls !== undefined) deps.controls = controls;
  return new BoxOrderManager(deps);
}

test("a DEFAULT-configured OrderManager refuses live entry (trading disabled by default)", () => {
  const mgr = minimalManager(undefined); // controls omitted → both false
  mgr.setFeedHealthy(true);
  assert.equal(mgr.canEnter(), false, "entry must be refused when nothing is armed");
});

test("entry authority is SEPARATE from exposure management: liveOrderEnabled alone permits protection but NOT entry", () => {
  // Arm ONLY exposure management. Entry authority is withheld.
  const mgr = minimalManager({ liveOrderEnabled: true, entryEnabled: false });
  mgr.setFeedHealthy(true);
  // canManageExposure depends ONLY on liveOrderEnabled (orderManager.ts:831) → true.
  assert.equal(mgr.canManageExposure(), true, "protective cancellation/reduction must stay available");
  // canEnter requires BOTH (orderManager.ts:813) → still false.
  assert.equal(mgr.canEnter(), false, "withdrawing entry authority must never enable entry");
});

test("withdrawing entry authority does NOT disable exposure management", () => {
  const mgr = minimalManager({ liveOrderEnabled: true, entryEnabled: true });
  mgr.setFeedHealthy(true);
  // Now disarm entry only.
  mgr.setControls({ entryEnabled: false });
  assert.equal(mgr.canEnter(), false, "entry disarmed");
  assert.equal(mgr.canManageExposure(), true, "exposure management survives entry disarm");
});
