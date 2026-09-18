/**
 * SHADOW MODE, THE STRESS PROFILE, AND THE SAFETY GATES THAT MUST NOT REGRESS.
 *
 * Covers the required cases:
 *  16. Paper never contacts a broker.
 *  17. The stress profile never activates automatically.
 *  18. Existing strategy mathematics remain byte-for-byte equivalent.
 *  19. Existing live safety gates remain intact.
 *
 * Every assertion here is about something being IMPOSSIBLE, so the tests are written to try the
 * dangerous thing and require it to fail.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadBoxConfig } from "../../dist/box/config.js";
import {
  ShadowModeViolationError,
  shadowGuardedAdapter,
  shadowModeStatus,
} from "../../dist/box/shadowMode.js";
import {
  STRESS_FAULTS,
  StressInjector,
  createStressInjector,
  profileReportBanner,
} from "../../dist/box/stressProfile.js";

/** Run a body with specific env vars set, restoring them afterwards. */
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

/* ─────────────────── 17. stress never activates automatically ─────────────────── */

test("REQUIRED 17: the default profile is standard — stress is never reached by default", () => {
  withEnv({ BOX_PAPER_EXECUTION_PROFILE: undefined, BOX_EXECUTION_MODE: undefined }, () => {
    assert.equal(loadBoxConfig().paperExecutionProfile, "standard");
  });
});

test("REQUIRED 17: an unrecognised profile falls back to standard, NEVER to stress", () => {
  for (const bogus of ["STRESS_TEST", "chaos", "live-parity", "parity", ""]) {
    withEnv({ BOX_PAPER_EXECUTION_PROFILE: bogus, BOX_EXECUTION_MODE: undefined }, () => {
      const profile = loadBoxConfig().paperExecutionProfile;
      assert.notEqual(profile, "stress", `"${bogus}" must not activate stress`);
      assert.equal(profile, "standard");
    });
  }
});

test("REQUIRED 17: stress requires the exact explicit value", () => {
  withEnv({ BOX_PAPER_EXECUTION_PROFILE: "stress", BOX_EXECUTION_MODE: undefined }, () => {
    assert.equal(loadBoxConfig().paperExecutionProfile, "stress");
  });
});

test("REQUIRED 17: stress combined with LIVE execution refuses to start", () => {
  withEnv(
    {
      BOX_PAPER_EXECUTION_PROFILE: "stress",
      BOX_EXECUTION_MODE: "live",
      BOX_LIVE_TRADING_ENABLED: "true",
    },
    () => {
      assert.throws(() => loadBoxConfig(), /stress.*cannot be combined with.*live|must never run against a real account/s);
    },
  );
});

test("REQUIRED 17: a fault injector CANNOT be created outside the stress profile", () => {
  const config = { schedules: [{ fault: "broker_reject", everyNth: 1 }] };
  for (const profile of ["standard", "live_parity", "", "STRESS", "Stress"]) {
    assert.throws(
      () => createStressInjector({ profile, config }),
      /refusing to create a stress fault injector/,
      `profile "${profile}" must not yield an injector`,
    );
  }
  // Only the exact profile works.
  assert.ok(createStressInjector({ profile: "stress", config }) instanceof StressInjector);
});

test("stress faults fire from an explicit schedule, never from randomness", () => {
  const injector = createStressInjector({
    profile: "stress",
    config: {
      schedules: [
        { fault: "http_timeout", atOperations: [2] },
        { fault: "partial_fill", everyNth: 3, magnitude: 40 },
      ],
    },
  });
  const fired = [];
  for (let i = 0; i < 6; i++) fired.push(injector.nextOperation());

  assert.deepEqual(fired, [[], ["http_timeout"], ["partial_fill"], [], [], ["partial_fill"]]);
  assert.equal(injector.magnitudeFor("partial_fill", 0), 40);
  assert.deepEqual(injector.report(), { http_timeout: 1, partial_fill: 2 });

  // Reproducibility: an identical configuration yields an identical run.
  const twin = createStressInjector({
    profile: "stress",
    config: {
      schedules: [
        { fault: "http_timeout", atOperations: [2] },
        { fault: "partial_fill", everyNth: 3, magnitude: 40 },
      ],
    },
  });
  const again = [];
  for (let i = 0; i < 6; i++) again.push(twin.nextOperation());
  assert.deepEqual(again, fired, "the same schedule must reproduce the same faults exactly");
});

test("every fault class the brief names is representable", () => {
  for (const fault of [
    "broker_slowdown",
    "feed_outage",
    "websocket_gap",
    "http_timeout",
    "delayed_ack",
    "delayed_cancel",
    "partial_fill",
    "broker_reject",
    "mongo_failure",
    "redis_failure",
    "process_restart",
    "duplicate_broker_event",
    "out_of_order_broker_event",
  ]) {
    assert.ok(STRESS_FAULTS.includes(fault), `${fault} must be a declared stress fault`);
  }
});

test("a stress report is banner-labelled so it can never be quoted as live parity", () => {
  const banner = profileReportBanner("stress");
  assert.match(banner, /STRESS PROFILE/);
  assert.match(banner, /SYNTHETIC FAULTS/);
  assert.match(banner, /NOT measured/);
  assert.match(banner, /NEVER be quoted as live parity/);

  // And live_parity's banner claims evidence, not perfection.
  const parity = profileReportBanner("live_parity");
  assert.match(parity, /evidence-driven/);
  assert.doesNotMatch(parity, /\d+% realistic/);
});

/* ─────────────────────────── 21. shadow mode ─────────────────────────── */

test("shadow mode combined with LIVE execution refuses to start", () => {
  withEnv({ BOX_SHADOW_MODE_ENABLED: "true", BOX_EXECUTION_MODE: "live", BOX_LIVE_TRADING_ENABLED: "true" }, () => {
    assert.throws(() => loadBoxConfig(), /shadow mode must never be able to submit a broker order/);
  });
});

test("shadow mode is off by default", () => {
  withEnv({ BOX_SHADOW_MODE_ENABLED: undefined, BOX_EXECUTION_MODE: undefined }, () => {
    assert.equal(loadBoxConfig().shadowModeEnabled, false);
  });
});

test("the shadow guard makes every broker MUTATION throw", async () => {
  let submitted = 0;
  const real = {
    mode: "live",
    submitOrder: async () => {
      submitted++;
      return {};
    },
    cancelOrder: async () => {
      submitted++;
      return undefined;
    },
    modifyOrder: async () => {
      submitted++;
      return {};
    },
    getOrder: async () => undefined,
    listOrders: async () => ["order"],
    listPositions: async () => ["position"],
    margins: async () => ({ available: 1, utilised: 0 }),
    health: async () => ({ ok: true }),
    adoptOrder: async () => ({}),
  };
  const guarded = shadowGuardedAdapter(real);

  assert.throws(() => guarded.submitOrder({ client_order_id: "BOX:x" }), ShadowModeViolationError);
  assert.throws(() => guarded.cancelOrder("BOX:x"), ShadowModeViolationError);
  assert.throws(() => guarded.modifyOrder("BOX:x", { limit_price: 1 }), ShadowModeViolationError);
  assert.equal(submitted, 0, "the real adapter must never be reached by a mutation");

  // Reads still work, so after-the-fact comparison remains possible.
  assert.deepEqual(await guarded.listOrders(), ["order"]);
  assert.deepEqual(await guarded.listPositions(), ["position"]);
  assert.equal((await guarded.health()).ok, true);

  // Adoption means taking ownership of real exposure — shadow mode has no business doing it.
  assert.equal(guarded.adoptOrder, undefined, "adoptOrder must not be forwarded");
});

test("the shadow violation names the operation and the order, so a mistake is attributable", () => {
  const guarded = shadowGuardedAdapter({
    mode: "live",
    submitOrder: async () => ({}),
    cancelOrder: async () => undefined,
    getOrder: async () => undefined,
    listOrders: async () => [],
    listPositions: async () => [],
  });
  try {
    guarded.submitOrder({ client_order_id: "BOX:trade-7:ENTRY:k1_ce:attempt-1" });
    assert.fail("expected a throw");
  } catch (error) {
    assert.match(error.message, /SHADOW MODE/);
    assert.match(error.message, /BOX:trade-7:ENTRY:k1_ce:attempt-1/);
    assert.match(error.message, /defence-in-depth/);
  }
});

test("shadow status reports the structural reasons, not just the flag", () => {
  const paper = shadowModeStatus({ shadowEnabled: true, executionMode: "paper_legging", hasOrderManager: false });
  assert.equal(paper.submissionImpossible, true);
  assert.ok(paper.reasons.some((r) => /no live adapter is constructed/.test(r)));
  assert.ok(paper.reasons.some((r) => /no OrderManager exists/.test(r)));

  // With a live mode AND a manager, submission is structurally possible — and the status says so
  // rather than pretending a flag is protection.
  const live = shadowModeStatus({ shadowEnabled: false, executionMode: "live", hasOrderManager: true });
  assert.equal(live.submissionImpossible, false);
});

/* ───────────── 16. paper never contacts a broker ───────────── */

test("REQUIRED 16: no paper module imports a broker transport", async () => {
  // A structural check: the paper simulation stack must not even be able to reach a transport.
  const { readFileSync } = await import("node:fs");
  const paperModules = [
    "src/box/executionSimulator.ts",
    "src/box/legExecutor.ts",
    "src/box/liquidityLedger.ts",
    "src/box/orderPricing.ts",
    "src/box/executionPolicy.ts",
    "src/box/paperScheduler.ts",
    "src/box/calibratedLatencySource.ts",
    "src/box/executionCalibration.ts",
  ];
  const forbidden = [
    "kiteBrokerAdapter",
    "dhanBrokerAdapter",
    "brokers/dhan",
    "from \"../kite.js\"",
    "fetch(",
    "mongoose",
  ];
  for (const file of paperModules) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    // Strip comments so prose mentioning an adapter does not fail the check.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    for (const needle of forbidden) {
      assert.ok(!code.includes(needle), `${file} must not reference ${needle}`);
    }
  }
});

test("REQUIRED 16: the calibration store paper reads is pure in-memory with no I/O", async () => {
  const { ExecutionCalibrationStore } = await import("../../dist/box/executionCalibration.js");
  const store = new ExecutionCalibrationStore({ nowWall: () => 0 });
  // Recording and resolving must complete synchronously — nothing awaits, so nothing can be I/O.
  store.record({
    broker: "zerodha",
    kind: "ENTRY",
    profile: "MARKETABLE_LIMIT",
    bucket: "NORMAL",
    stage: "post_to_ack_ms",
    valueMs: 100,
    atWall: 0,
  });
  const resolved = store.resolve(
    { broker: "zerodha", kind: "ENTRY", profile: "MARKETABLE_LIMIT", bucket: "NORMAL" },
    "post_to_ack_ms",
  );
  assert.equal(typeof resolved.measured, "boolean");
  assert.equal(typeof store.export, "function");
  // The export is a plain object, not a database handle.
  assert.equal(typeof JSON.stringify(store.export()), "string");
});

/* ───────────── 18 & 19. nothing important changed ───────────── */

test("REQUIRED 18: the strategy-maths configuration surface is untouched by this work", () => {
  withEnv({ BOX_PAPER_EXECUTION_PROFILE: undefined, BOX_EXECUTION_MODE: undefined }, () => {
    const cfg = loadBoxConfig();
    // The numbers the strategy turns on must still be exactly the shipped defaults.
    assert.equal(cfg.minExpectedNetProfit, 1200);
    assert.equal(cfg.minGrossEdge, 1200);
    assert.equal(cfg.minNetEdge, 0);
    assert.equal(cfg.safetyBuffer, 150);
    assert.equal(cfg.expectedEntrySlippage, 250);
    assert.equal(cfg.expectedExitSlippage, 250);
    assert.equal(cfg.legMaxChaseTicks, 2);
    assert.equal(cfg.unwindMaxChaseTicks, 5);
    assert.equal(cfg.queueModel, "haircut");
    assert.equal(cfg.queueLiquidityHaircutPct, 30);
    // 1000ms, matching Kite's whole-second stamp precision. A default BELOW that precision is
    // unsatisfiable-by-quantisation (see config.ts) — it was 250, which refused coherent books
    // whenever the four legs straddled a second boundary.
    assert.equal(cfg.maxCrossLegExchangeDispersionMs, 1000);
    assert.equal(cfg.simulatedLatencyMs, 250);
    assert.equal(cfg.simulatedDecisionMs, 40);
  });
});

test("REQUIRED 19: the live kill switch still refuses live mode without explicit enablement", () => {
  withEnv({ BOX_EXECUTION_MODE: "live", BOX_LIVE_TRADING_ENABLED: undefined }, () => {
    assert.throws(() => loadBoxConfig(), /requires BOX_LIVE_TRADING_ENABLED=true/);
  });
  withEnv({ BOX_EXECUTION_MODE: "live", BOX_LIVE_TRADING_ENABLED: "false" }, () => {
    assert.throws(() => loadBoxConfig(), /refusing to start live execution/);
  });
});

test("REQUIRED 19: an invalid execution mode still stops startup rather than guessing", () => {
  withEnv({ BOX_EXECUTION_MODE: "papertrade" }, () => {
    assert.throws(() => loadBoxConfig(), /invalid BOX_EXECUTION_MODE/);
  });
});

test("REQUIRED 19: the conservative live limits are unchanged", () => {
  withEnv({ BOX_EXECUTION_MODE: undefined }, () => {
    const cfg = loadBoxConfig();
    assert.equal(cfg.liveTradingEnabled, false, "live trading is OFF by default");
    assert.equal(cfg.liveMaxOpenBoxes, 1);
    assert.equal(cfg.liveMaxConcurrentExecutions, 1);
    assert.equal(cfg.liveMaxResidualLegs, 1);
    assert.equal(cfg.liveDailyLossLimit, 5_000);
    assert.equal(cfg.liveRejectLimit, 3);
    assert.equal(cfg.liveConsecutiveFailureLimit, 3);
    assert.equal(cfg.liveMaxOpenLegQuantity, 100);
    assert.equal(cfg.liveMaxGrossOpenLegQuantity, 400);
    assert.equal(cfg.liveMaxChaseTicks, 2);
    assert.equal(cfg.liveMaxModifications, 2);
    assert.equal(cfg.liveBrokerMinIntervalMs, 250);
  });
});

test("REQUIRED 19: bounded LIMIT enforcement still makes a MARKET order unrepresentable", async () => {
  const { assertBoundedLimit } = await import("../../dist/box/brokerAdapter.js");
  const base = {
    client_order_id: "BOX:t:ENTRY:k1_ce:attempt-1",
    role: "k1_ce",
    trade_id: "t",
    attempt_id: "attempt-1",
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: "SYM",
    token: 1,
    side: "BUY",
    quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
  };
  assert.doesNotThrow(() => assertBoundedLimit(base, 2));
  // A non-LIMIT order type is not representable at all.
  assert.throws(() => assertBoundedLimit({ ...base, pricing: { ...base.pricing, order_type: "MARKET" } }, 2));
  // Beyond the configured chase band.
  assert.throws(() => assertBoundedLimit({ ...base, pricing: { ...base.pricing, max_chase_ticks: 50 } }, 2));
  // Not tick-aligned.
  assert.throws(() => assertBoundedLimit({ ...base, pricing: { ...base.pricing, limit_price: 100.123 } }, 2));
  // Wrong direction for the side.
  assert.throws(() => assertBoundedLimit({ ...base, pricing: { ...base.pricing, limit_price: 99.8 } }, 2));
  // Non-integer / non-positive quantity.
  assert.throws(() => assertBoundedLimit({ ...base, quantity: 0 }, 2));
  assert.throws(() => assertBoundedLimit({ ...base, quantity: 1.5 }, 2));
});

test("REQUIRED 19: there is still no Math.random anywhere in src/box", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../src/box/", import.meta.url);
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(new URL(name, dir), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    if (code.includes("Math.random")) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "the execution model must remain fully deterministic");
});


/* ─────────────────── configuration documentation completeness ─────────────────── */

test("every new configuration variable is documented in all four required places", async () => {
  // Phase 31 requires each variable to appear in .env.example, README.md,
  // docs/CONFIGURATION.md and src/box/LIVE_EXECUTION.md. Asserting it keeps code and docs from
  // drifting apart, which is the usual fate of a configuration table.
  const { readFileSync } = await import("node:fs");
  const files = [".env.example", "README.md", "docs/CONFIGURATION.md", "src/box/LIVE_EXECUTION.md"];
  const contents = new Map(
    files.map((f) => [f, readFileSync(new URL(`../../${f}`, import.meta.url), "utf8")]),
  );

  const introduced = [
    "BOX_PAPER_CALIBRATION_MIN_SAMPLES",
    "BOX_PAPER_CALIBRATION_BUCKET_MIN_SAMPLES",
    "BOX_PAPER_CALIBRATION_MAX_AGE_MS",
    "BOX_PAPER_CALIBRATION_TIME_BUCKETS",
    "BOX_PAPER_CANCEL_LATENCY_MS",
    "BOX_LIVE_TIMING_PERSIST_ENABLED",
    "BOX_LIVE_TIMING_BATCH_SIZE",
    "BOX_LIVE_TIMING_FLUSH_MS",
    "BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED",
    "BOX_SHADOW_MODE_ENABLED",
  ];

  const missing = [];
  for (const variable of introduced) {
    for (const [file, text] of contents) {
      if (!text.includes(variable)) missing.push(`${variable} missing from ${file}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every new configuration variable is actually read by the loader", async () => {
  // The mirror of the test above: documentation must not describe a variable that does nothing.
  const { readFileSync } = await import("node:fs");
  const configSource = readFileSync(new URL("../../src/box/config.ts", import.meta.url), "utf8");
  for (const variable of [
    "BOX_PAPER_CALIBRATION_MIN_SAMPLES",
    "BOX_PAPER_CALIBRATION_BUCKET_MIN_SAMPLES",
    "BOX_PAPER_CALIBRATION_MAX_AGE_MS",
    "BOX_PAPER_CALIBRATION_TIME_BUCKETS",
    "BOX_PAPER_CANCEL_LATENCY_MS",
    "BOX_LIVE_TIMING_PERSIST_ENABLED",
    "BOX_LIVE_TIMING_BATCH_SIZE",
    "BOX_LIVE_TIMING_FLUSH_MS",
    "BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED",
    "BOX_SHADOW_MODE_ENABLED",
  ]) {
    assert.ok(configSource.includes(variable), `${variable} is documented but never read`);
  }
});

test("the shipped .env.example still describes a SAFE, non-live configuration", () => {
  // A copy-paste of the example file must never produce a live-trading process.
  const profileLine = /^BOX_PAPER_EXECUTION_PROFILE=standard$/m;
  const shadowLine = /^BOX_SHADOW_MODE_ENABLED=false$/m;
  const persistLine = /^BOX_LIVE_TIMING_PERSIST_ENABLED=false$/m;
  return import("node:fs").then(({ readFileSync }) => {
    const env = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    assert.match(env, profileLine, "the example must not ship a non-default profile");
    assert.match(env, shadowLine);
    assert.match(env, persistLine);
    assert.doesNotMatch(env, /^BOX_EXECUTION_MODE=live$/m, "the example must never default to live");
    assert.doesNotMatch(env, /^BOX_LIVE_TRADING_ENABLED=true$/m);
    assert.doesNotMatch(env, /^BOX_PAPER_EXECUTION_PROFILE=stress$/m);
  });
});


test("REQUIRED 20: the pre-existing suite is still present and still exercised", async () => {
  // Case 20 is "existing tests continue passing", which the suite itself proves by running. What
  // this test adds is a guard against the OTHER way that requirement can be met dishonestly:
  // deleting or emptying the tests that used to cover the behaviour being changed.
  const { readdirSync, readFileSync } = await import("node:fs");
  // "./" is this file's own directory (tests/box/); "../" would be tests/.
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs"));

  // The suites most exposed to this work must all still exist and still contain assertions.
  for (const required of [
    "execution.test.mjs",
    "legParity.test.mjs",
    "legParityScheduler.test.mjs",
    "legExecutor.test.mjs",
    "legFills.test.mjs",
    "orderManager.test.mjs",
    "kiteBrokerAdapter.test.mjs",
    "dhanAdapter.test.mjs",
    "brokerAdapter.test.mjs",
    "orderPricing.test.mjs",
    "liquidityLedger.test.mjs",
    "paperScheduler.test.mjs",
    "latencyModel.test.mjs",
    "brokerTimingStore.test.mjs",
    "parityReport.test.mjs",
    "paperNeverReachesBroker.test.mjs",
    "migrationFixtures.test.mjs",
    "migrationFixturesParity.test.mjs",
    "config.test.mjs",
    "math.test.mjs",
  ]) {
    assert.ok(files.includes(required), `${required} must not be removed`);
    const source = readFileSync(new URL(required, dir), "utf8");
    assert.ok(source.includes("assert"), `${required} must still assert something`);
    assert.ok(/\btest\(/.test(source), `${required} must still declare tests`);
  }
  assert.ok(files.length >= 55, `expected the full suite, found only ${files.length} files`);
});
