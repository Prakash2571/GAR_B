/**
 * REGISTRY INTEGRITY — the security boundary and the "behaves exactly as before" guarantee.
 *
 * Four things are proven here, and the first two are the ones that matter most:
 *
 *   1. NO CREDENTIAL IS REGISTERED. Checked against the REAL classifier in `src/env/secrets.ts`, not
 *      against a copy, so the two cannot drift.
 *   2. NO DEPLOYMENT LIVE GATE IS REGISTERED. A runtime setting must never be able to turn a paper
 *      deployment into a live-capable one.
 *   3. EVERY CODE DEFAULT MATCHES `loadBoxConfig()`. Read out of the loader's own source, so a future
 *      edit to either side fails here instead of silently changing behaviour on first deployment.
 *   4. The specs are internally well-formed, and the modules stay within erasable TypeScript.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

import { registry, repoPath } from "./_harness.mjs";

register(pathToFileURL(repoPath("tests", "helpers", "tsResolve.mjs")).href);
const secrets = await import(pathToFileURL(repoPath("src", "env", "secrets.ts")).href);

const { OPERATOR_SETTINGS, CODE_DEFAULTS, SETTINGS_BY_KEY, assertNoSensitiveKeys, persistedKeyFor } =
  registry;

/* ═════════════════ 1. Secrets can never be registered ═════════════════ */

test("no registered setting maps to a secret or identity environment variable", () => {
  // The real classifier, so adding a credential to EXPLICIT_ENV_CLASS is enough to trip this.
  assert.doesNotThrow(() => assertNoSensitiveKeys(secrets.classifyEnvVar));

  for (const s of OPERATOR_SETTINGS) {
    assert.equal(
      secrets.classifyEnvVar(s.envVar),
      "config",
      `${s.key} exposes ${s.envVar}, which is not plain configuration`,
    );
  }
});

test("the guard actually throws when a credential is registered", () => {
  // Proves the guard is live rather than vacuously passing because nothing is sensitive.
  assert.throws(
    () => assertNoSensitiveKeys((name) => (name === OPERATOR_SETTINGS[0].envVar ? "secret" : "config")),
    /refusing to expose non-config environment variables/,
  );
});

/**
 * Source with comments stripped.
 *
 * The same helper `tests/runConfirmMode.test.mjs` uses, and for the same reason: registry.ts's own
 * prose legitimately NAMES the variables it excludes ("infrastructure: PORT, DATABASE_URL, pool
 * sizing…"), which is documentation worth keeping. The assertion below is about CODE.
 */
function code(absPath) {
  return readFileSync(absPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

test("no known credential name appears in executable registry code", () => {
  const source = code(repoPath("src", "box", "operatorConfig", "registry.ts"));
  for (const name of secrets.registeredSecretNames()) {
    assert.equal(source.includes(name), false, `registry.ts code references the secret ${name}`);
  }
});

test("no credential name appears in executable code anywhere in the subsystem", () => {
  const FILES = ["types.ts", "registry.ts", "precedence.ts", "validate.ts", "policy.ts", "snapshot.ts"];
  for (const file of FILES) {
    const source = code(repoPath("src", "box", "operatorConfig", file));
    for (const name of secrets.registeredSecretNames()) {
      assert.equal(source.includes(name), false, `${file} references the secret ${name}`);
    }
  }
});

/* ═════════════════ 2. Deployment capability stays in the environment ═════════════════ */

test("no deployment live gate is runtime-configurable", () => {
  // These four decide whether real orders are possible at all. The frontend may display their
  // resolved state; it must never be able to write one.
  const GATES = [
    "BOX_EXECUTION_MODE",
    "BOX_LIVE_TRADING_ENABLED",
    "ZERODHA_LIVE_TRADING_ENABLED",
    "DHAN_LIVE_TRADING_ENABLED",
    "BOX_SHADOW_MODE_ENABLED",
    "BOX_EXECUTION_COORDINATOR_ENABLED",
    "BOX_RESERVATION_REQUIRE_DURABLE",
    "BOX_DURABLE_RESERVATIONS_ENABLED",
    "BOX_LEG_EXECUTION_MODE",
  ];
  const registered = new Set(OPERATOR_SETTINGS.map((s) => s.envVar));
  for (const gate of GATES) {
    assert.equal(registered.has(gate), false, `${gate} must not be runtime-configurable`);
  }
});

test("no setting writes a BoxConfig field that controls live capability", () => {
  const FORBIDDEN_FIELDS = [
    "executionMode",
    "liveTradingEnabled",
    "shadowModeEnabled",
    "executionCoordinatorEnabled",
    "reservationRequireDurable",
    "durableReservationsEnabled",
    "legExecutionMode",
  ];
  for (const s of OPERATOR_SETTINGS) {
    assert.equal(
      FORBIDDEN_FIELDS.includes(s.boxConfigField),
      false,
      `${s.key} writes the capability field ${s.boxConfigField}`,
    );
  }
});

/* ═════════════════ 3. Defaults match loadBoxConfig() exactly ═════════════════ */

/**
 * Evaluate the simple numeric/boolean/string literal forms `loadBoxConfig` uses for a default.
 * Handles `15_000`, `3 * 24 * 60 * 60`, `true`, `"standard"`. Returns undefined for anything else,
 * which the caller treats as "not a plain literal".
 */
function literal(text) {
  const t = text.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  const str = /^"([^"]*)"$/.exec(t);
  if (str !== null) return str[1];
  if (/^[0-9_.\s*+]+$/.test(t)) {
    const value = Function(`"use strict";return (${t.replace(/_/g, "")});`)();
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

test("every registered code default is the literal loadBoxConfig uses", () => {
  const source = readFileSync(repoPath("src", "box", "config.ts"), "utf8");

  // `paperMaxConcurrentExecutions`'s loader default is not a literal — it is a nested
  // clampInt("BOX_LIVE_MAX_CONCURRENT_EXECUTIONS", 1, 1, 4), i.e. "default to the live cap". Its
  // effective default is that nested default, 1, which is asserted separately below.
  const DERIVED = new Set(["paperMaxConcurrentExecutions"]);

  let compared = 0;
  for (const s of OPERATOR_SETTINGS) {
    if (DERIVED.has(s.key)) continue;
    const expected = CODE_DEFAULTS.get(s.key);
    assert.notEqual(expected, undefined, `${s.key} has no code default`);

    // Find the loader call for this env var and capture its first argument.
    const re = new RegExp(`"${s.envVar}"\\s*,\\s*([^,)\\n]+)`);
    const m = re.exec(source);
    assert.notEqual(m, null, `loadBoxConfig has no default for ${s.envVar}`);

    const parsed = literal(m[1]);
    assert.notEqual(parsed, undefined, `could not parse the loader default for ${s.envVar}: ${m[1]}`);
    assert.equal(
      parsed,
      expected,
      `${s.key}: registry default ${String(expected)} != loadBoxConfig default ${String(parsed)}`,
    );
    compared++;
  }
  assert.ok(compared >= 45, `expected to compare most settings, compared only ${compared}`);
});

test("the paper concurrency default tracks the live concurrency default", () => {
  const source = readFileSync(repoPath("src", "box", "config.ts"), "utf8");
  const m = /"BOX_LIVE_MAX_CONCURRENT_EXECUTIONS"\s*,\s*([0-9]+)/.exec(source);
  assert.notEqual(m, null);
  assert.equal(CODE_DEFAULTS.get("paperMaxConcurrentExecutions"), Number(m[1]));
});

test("every code default sits inside its own declared bounds", () => {
  for (const s of OPERATOR_SETTINGS) {
    const d = CODE_DEFAULTS.get(s.key);
    if (s.type === "integer" || s.type === "number") {
      assert.ok(d >= s.min, `${s.key} default ${d} is below min ${s.min}`);
      assert.ok(d <= s.max, `${s.key} default ${d} is above max ${s.max}`);
      if (s.type === "integer") assert.ok(Number.isInteger(d), `${s.key} default is not an integer`);
    } else if (s.type === "enum") {
      assert.ok(s.enumValues.includes(d), `${s.key} default ${d} is not a declared enum value`);
    } else {
      assert.equal(typeof d, "boolean", `${s.key} default is not a boolean`);
    }
  }
});

/* ═════════════════ 4. Spec well-formedness ═════════════════ */

test("keys, env vars and BoxConfig fields are unique", () => {
  for (const field of ["key", "envVar", "boxConfigField"]) {
    const seen = new Set();
    for (const s of OPERATOR_SETTINGS) {
      assert.equal(seen.has(s[field]), false, `duplicate ${field}: ${s[field]}`);
      seen.add(s[field]);
    }
  }
  assert.equal(SETTINGS_BY_KEY.size, OPERATOR_SETTINGS.length);
  assert.equal(CODE_DEFAULTS.size, OPERATOR_SETTINGS.length);
});

test("every setting carries the metadata the UI needs", () => {
  for (const s of OPERATOR_SETTINGS) {
    assert.ok(s.label.length > 0, `${s.key} has no label`);
    // The label must read as English, not as an environment variable.
    assert.equal(/^[A-Z0-9_]+$/.test(s.label), false, `${s.key}'s label looks like an env var`);
    assert.ok(s.description.length > 20, `${s.key} has no useful description`);
    assert.ok(
      ["strategy", "risk", "market_data", "paper", "universe", "charges"].includes(s.category),
      `${s.key} has an unknown category`,
    );
    assert.equal(typeof s.dangerous, "boolean");
    assert.equal(typeof s.requiresFullAdmin, "boolean");
  }
});

test("a dangerous setting always requires full admin", () => {
  // UI confirmation is not security; the backend role check is. Anything flagged dangerous must
  // therefore also be gated on the role.
  for (const s of OPERATOR_SETTINGS) {
    if (s.dangerous) assert.equal(s.requiresFullAdmin, true, `${s.key} is dangerous but not admin-gated`);
  }
});

test("an `unlimited` zero is only declared where a bigger number really is looser", () => {
  // liveMaxOpenBoxes and liveMaxResidualLegs both test `>=`/`>` against the limit, so 0 there is the
  // MOST restrictive value, not the least. Declaring it `unlimited` would invert their containment.
  assert.equal(SETTINGS_BY_KEY.get("liveMaxOpenBoxes").zeroMeans, "value");
  assert.equal(SETTINGS_BY_KEY.get("liveMaxResidualLegs").zeroMeans, "value");
  assert.equal(SETTINGS_BY_KEY.get("maxOpenBoxes").zeroMeans, "unlimited");
  assert.equal(SETTINGS_BY_KEY.get("liveDailyLossLimit").zeroMeans, "unlimited");
});

test("ceiling and floor settings declare a comparable safe direction", () => {
  for (const s of OPERATOR_SETTINGS) {
    if (s.containment === "replace") continue;
    assert.notEqual(
      s.safeDirection,
      "neutral",
      `${s.key} uses ${s.containment} containment but has no safe direction to compare`,
    );
  }
});

test("persisted keys are stable snake_case and unique", () => {
  assert.equal(persistedKeyFor("liveMaxBoxCapitalRupees"), "live_max_box_capital_rupees");
  assert.equal(persistedKeyFor("minExpectedNetProfit"), "min_expected_net_profit");
  assert.equal(persistedKeyFor("safetyBuffer"), "safety_buffer");

  const seen = new Set();
  for (const s of OPERATOR_SETTINGS) {
    const k = persistedKeyFor(s.key);
    assert.match(k, /^[a-z][a-z0-9_]*$/, `${s.key} produced a non-snake_case persisted key`);
    assert.equal(seen.has(k), false, `duplicate persisted key ${k}`);
    seen.add(k);
  }
});

test("the two legacy box_settings keys keep their existing persisted names", () => {
  // These rows already exist in production. Renaming them would silently orphan an operator's
  // saved entry gate and quietly restore the env default.
  assert.equal(persistedKeyFor("minExpectedNetProfit"), "min_expected_net_profit");
  assert.equal(persistedKeyFor("safetyBuffer"), "safety_buffer");
});

/* ═════════════════ 5. The modules stay erasable and dependency-free ═════════════════ */

test("operatorConfig modules use erasable TypeScript only", () => {
  const FILES = ["types.ts", "registry.ts", "precedence.ts", "validate.ts", "policy.ts", "snapshot.ts"];
  for (const file of FILES) {
    const src = readFileSync(repoPath("src", "box", "operatorConfig", file), "utf8");
    assert.equal(/^\s*(export\s+)?enum\s/m.test(src), false, `${file} uses an enum`);
    assert.equal(/^\s*(export\s+)?namespace\s/m.test(src), false, `${file} uses a namespace`);
    assert.equal(/constructor\s*\([^)]*\b(private|public|protected|readonly)\s/.test(src), false,
      `${file} uses a constructor parameter property`);
  }
});

test("operatorConfig modules import nothing outside their own directory", () => {
  // This is what keeps configuration off the hot path and testable without a toolchain: no pg, no
  // express, no mongodb, and no reach into the engine.
  const FILES = ["types.ts", "registry.ts", "precedence.ts", "validate.ts", "policy.ts", "snapshot.ts"];
  for (const file of FILES) {
    const src = readFileSync(repoPath("src", "box", "operatorConfig", file), "utf8");
    for (const m of src.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)) {
      assert.match(m[1], /^\.\/[A-Za-z]+\.js$/, `${file} imports ${m[1]}, which is outside the subsystem`);
    }
  }
});
