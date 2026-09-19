/**
 * THE WIRE PROJECTION, VALIDATED AGAINST THE REAL JSON-SCHEMA.
 *
 * These tests run the actual payload the backend will send through `contract/validate.mjs` — the same
 * validator the contract suite and the frontend use, with its strict "unknown keyword is a loud error"
 * discipline. That makes the schema and the producer provably agree, rather than agreeing by review.
 *
 * The secret assertions are the important ones: they serialise the WHOLE payload and search it for
 * every credential name the backend knows about. A projection that accidentally spread a config object
 * containing a DSN would fail here, which is the only kind of guarantee worth having on this boundary.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { registry, snapshot as snap, baseState, repoPath, spec } from "./_harness.mjs";

register(pathToFileURL(repoPath("tests", "helpers", "tsResolve.mjs")).href);
const wire = await import(pathToFileURL(repoPath("src", "box", "operatorConfig", "wire.ts")).href);
const secrets = await import(pathToFileURL(repoPath("src", "env", "secrets.ts")).href);
const validator = await import(pathToFileURL(repoPath("contract", "validate.mjs")).href);

const { OPERATOR_SETTINGS, CODE_DEFAULTS } = registry;

/* Load every schema into a registry so cross-file $ref resolves exactly as in production. */
const SCHEMAS_DIR = repoPath("contract", "schemas");
const SCHEMA_REGISTRY = {};
for (const name of readdirSync(SCHEMAS_DIR).filter((n) => n.endsWith(".schema.json"))) {
  SCHEMA_REGISTRY[name] = JSON.parse(readFileSync(resolve(SCHEMAS_DIR, name), "utf8"));
}
const CONFIG_SCHEMA = SCHEMA_REGISTRY["operator-config.schema.json"];
const REFUSAL_SCHEMA = SCHEMA_REGISTRY["operator-config-refusal.schema.json"];

const DEPLOYMENT = {
  executionMode: "paper_latency",
  liveTradingEnabled: false,
  zerodhaLiveTradingEnabled: false,
  dhanLiveTradingEnabled: false,
  shadowModeEnabled: false,
  executionCoordinatorEnabled: true,
  liveCapable: false,
  region: null,
  activeBroker: "zerodha",
};

function build(overrides = {}) {
  return snap.buildSnapshot({
    version: overrides.version ?? 3,
    updatedAt: "2026-09-19T04:00:00.000Z",
    specs: OPERATOR_SETTINGS,
    codeDefaults: CODE_DEFAULTS,
    envInputs: overrides.envInputs ?? new Map(),
    runtimeValues: overrides.runtimeValues ?? new Map(),
  });
}

function project(overrides = {}) {
  return wire.projectOperatorConfig({
    snapshot: overrides.snapshot ?? build(overrides),
    specs: OPERATOR_SETTINGS,
    state: overrides.state ?? baseState(),
    deployment: { ...DEPLOYMENT, ...(overrides.deployment ?? {}) },
    rowMeta: overrides.rowMeta ?? new Map(),
    sessionSnapshot: overrides.sessionSnapshot ?? new Map(),
    recentChanges: overrides.recentChanges ?? [],
  });
}

const errorsFor = (payload, schema = CONFIG_SCHEMA) =>
  validator.validate(payload, schema, { registry: SCHEMA_REGISTRY });

/* ═════════════════ 1. The projection satisfies the schema ═════════════════ */

test("a default projection validates against operator-config.schema.json", () => {
  const errors = errorsFor(project());
  assert.deepEqual(errors, [], `schema errors: ${JSON.stringify(errors, null, 2)}`);
});

test("every registered setting appears, and the list is never empty", () => {
  const payload = project();
  assert.equal(payload.settings.length, OPERATOR_SETTINGS.length);
  assert.ok(payload.settings.length >= 1);
  const keys = payload.settings.map((s) => s.key).sort();
  assert.deepEqual(keys, OPERATOR_SETTINGS.map((s) => s.key).sort());
});

test("a projection with runtime overrides, a clamp, armed state and history still validates", () => {
  const payload = project({
    version: 17,
    envInputs: new Map([
      ["liveMaxBoxCapitalRupees", { present: true, value: 120_000 }],
      ["maxOpenBoxes", { present: true, value: 2 }],
    ]),
    runtimeValues: new Map([
      ["liveMaxBoxCapitalRupees", 150_000],
      ["safetyBuffer", 400],
      ["paperExecutionProfile", "live_parity"],
      ["sessionMaxEntryAttempts", 5],
    ]),
    state: baseState({ entryArmed: true, sessionArmed: true, openBoxes: 1, workingOrders: 2 }),
    sessionSnapshot: new Map([["sessionMaxEntryAttempts", 1]]),
    rowMeta: new Map([["safetyBuffer", { updatedAt: "2026-09-19T03:00:00.000Z", updatedBy: "full" }]]),
    recentChanges: [
      {
        changedAt: "2026-09-19T03:00:00.000Z",
        actorRole: "full",
        settingKey: "safetyBuffer",
        previousConfigured: 150,
        newConfigured: 400,
        previousEffective: 150,
        newEffective: 400,
        mutationPolicy: "TIGHTEN_ONLY_WHILE_ARMED",
        newSource: "runtime",
        sessionId: "sess-1",
        reason: null,
        configVersion: 17,
      },
    ],
  });
  const errors = errorsFor(payload);
  assert.deepEqual(errors, [], `schema errors: ${JSON.stringify(errors, null, 2)}`);
});

/* ═════════════════ 2. Configured / effective / armed are distinct on the wire ═════════════════ */

test("a deployment clamp sends BOTH numbers and names itself", () => {
  const payload = project({
    envInputs: new Map([["liveMaxBoxCapitalRupees", { present: true, value: 120_000 }]]),
    runtimeValues: new Map([["liveMaxBoxCapitalRupees", 150_000]]),
  });
  const s = payload.settings.find((x) => x.key === "liveMaxBoxCapitalRupees");
  assert.equal(s.configured_value, 150_000);
  assert.equal(s.effective_value, 120_000);
  assert.equal(s.default_value, 0);
  assert.equal(s.source, "runtime_clamped_by_env");
  assert.equal(s.clamped_by_deployment, true);
  assert.equal(s.deployment_bound, 120_000);
});

test("the armed session snapshot is sent only when a session is armed", () => {
  const armed = project({
    runtimeValues: new Map([["sessionMaxEntryAttempts", 5]]),
    state: baseState({ sessionArmed: true }),
    sessionSnapshot: new Map([["sessionMaxEntryAttempts", 1]]),
  });
  const a = armed.settings.find((x) => x.key === "sessionMaxEntryAttempts");
  // The operator has configured 5; the RUNNING session is still bound by the 1 it was armed under.
  assert.equal(a.configured_value, 5);
  assert.equal(a.session_snapshot_value, 1);
  assert.equal(a.takes_effect, "next_arm");

  const idle = project({
    runtimeValues: new Map([["sessionMaxEntryAttempts", 5]]),
    state: baseState({ sessionArmed: false }),
    sessionSnapshot: new Map([["sessionMaxEntryAttempts", 1]]),
  });
  const i = idle.settings.find((x) => x.key === "sessionMaxEntryAttempts");
  assert.equal(i.session_snapshot_value, null, "a frozen value was reported with no armed session");
});

test("a non-session setting never carries a session snapshot value", () => {
  const payload = project({
    state: baseState({ sessionArmed: true }),
    sessionSnapshot: new Map([["maxOpenBoxes", 99]]),
  });
  const s = payload.settings.find((x) => x.key === "maxOpenBoxes");
  assert.equal(s.session_snapshot_value, null);
});

/* ═════════════════ 3. Mutability and blockers ═════════════════ */

test("a FLAT_AND_DISARMED setting is reported immutable with named blockers while armed", () => {
  const payload = project({ state: baseState({ entryArmed: true, openBoxes: 1 }) });
  const s = payload.settings.find((x) => x.key === "liveMaxBoxCapitalRupees");
  assert.equal(s.mutable, false);
  assert.ok(s.blockers.length > 0, "an immutable setting must say why");
  const codes = s.blockers.map((b) => b.code);
  assert.ok(codes.includes("session_armed"));
  assert.ok(codes.includes("open_box"));
  assert.equal(s.requires_flat, true);
  assert.equal(s.requires_disarmed, true);
});

test("the same setting is mutable when flat and disarmed, with no blockers", () => {
  const payload = project({ state: baseState() });
  const s = payload.settings.find((x) => x.key === "liveMaxBoxCapitalRupees");
  assert.equal(s.mutable, true);
  assert.deepEqual(s.blockers, []);
});

test("a tighten-only setting stays mutable while armed but explains the restriction", () => {
  const payload = project({ state: baseState({ sessionArmed: true }) });
  const s = payload.settings.find((x) => x.key === "maxOpenBoxes");
  assert.equal(s.mutable, true, "tightening genuinely is available, so the field is editable");
  assert.ok(s.blockers.some((b) => b.code === "tighten_only_while_armed"));
});

test("an immutable setting never reports an empty blocker list", () => {
  for (const state of [
    baseState(),
    baseState({ entryArmed: true }),
    baseState({ sessionArmed: true, openBoxes: 2, residualLegs: 1, reconciliationClean: false }),
  ]) {
    for (const s of project({ state }).settings) {
      if (!s.mutable) {
        assert.ok(s.blockers.length > 0, `${s.key} is immutable with no stated reason`);
      }
    }
  }
});

/* ═════════════════ 4. Deployment gates are present and read-only ═════════════════ */

test("the deployment block reports the live gates and the backend's own verdict", () => {
  const payload = project({ deployment: { executionMode: "live", liveTradingEnabled: true, liveCapable: true } });
  assert.equal(payload.deployment.execution_mode, "live");
  assert.equal(payload.deployment.live_trading_enabled, true);
  assert.equal(payload.deployment.live_capable, true);
  // And none of those gate names is a writable setting.
  const keys = new Set(payload.settings.map((s) => s.key));
  for (const forbidden of ["executionMode", "liveTradingEnabled", "liveCapable"]) {
    assert.equal(keys.has(forbidden), false, `${forbidden} is writable`);
  }
});

test("`flat` is computed by the backend, not left to the client", () => {
  assert.equal(project({ state: baseState() }).state.flat, true);
  assert.equal(project({ state: baseState({ residualLegs: 1 }) }).state.flat, false);
  assert.equal(project({ state: baseState({ reconciliationClean: false }) }).state.flat, false);
});

/* ═════════════════ 5. No secret can reach the wire ═════════════════ */

test("no credential name or value appears anywhere in the serialised payload", () => {
  const json = JSON.stringify(
    project({
      envInputs: new Map(OPERATOR_SETTINGS.map((s) => [s.key, { present: true, value: CODE_DEFAULTS.get(s.key) }])),
      runtimeValues: new Map([["safetyBuffer", 400]]),
      state: baseState({ sessionArmed: true }),
    }),
  );
  for (const name of secrets.registeredSecretNames()) {
    assert.equal(json.includes(name), false, `the payload contains the secret name ${name}`);
  }
  // And nothing that looks like a credential-bearing value.
  for (const pattern of [/postgres:\/\//i, /mongodb:\/\//i, /passcode/i, /api_secret/i, /bearer /i]) {
    assert.equal(pattern.test(json), false, `the payload matches ${pattern}`);
  }
});

test("every env_var on the wire is classified as plain config", () => {
  for (const s of project().settings) {
    assert.equal(
      secrets.classifyEnvVar(s.env_var),
      "config",
      `${s.key} publishes ${s.env_var}, which is not plain config`,
    );
  }
});

/* ═════════════════ 6. Refusals ═════════════════ */

test("a refusal validates and is structurally impossible to read as a success", () => {
  const payload = wire.projectRefusal({
    version: 17,
    reason: "stale_version",
    problems: [{ key: "__patch__", code: "stale_version", message: "Configuration moved to version 18." }],
  });
  const errors = errorsFor(payload, REFUSAL_SCHEMA);
  assert.deepEqual(errors, [], `schema errors: ${JSON.stringify(errors)}`);
  assert.equal(payload.applied, false);
  assert.equal(payload.version, 17);
});

test("a refusal with no problems is a programming error, not an empty list", () => {
  assert.throws(
    () => wire.projectRefusal({ version: 1, reason: "validation_failed", problems: [] }),
    /must name at least one problem/,
  );
});

test("the refusal schema rejects applied:true and an empty problems array", () => {
  const bad = { applied: true, version: 1, reason: "validation_failed", problems: [] };
  assert.ok(errorsFor(bad, REFUSAL_SCHEMA).length > 0, "the schema accepted applied:true");

  const empty = { applied: false, version: 1, reason: "validation_failed", problems: [] };
  assert.ok(errorsFor(empty, REFUSAL_SCHEMA).length > 0, "the schema accepted an empty problems array");
});

/* ═════════════════ 7. The schema is genuinely closed ═════════════════ */

test("an unexpected top-level or per-setting field is rejected", () => {
  const extraTop = { ...project(), surprise: 1 };
  assert.ok(errorsFor(extraTop).length > 0, "the schema accepted an unknown top-level field");

  const payload = project();
  const settings = payload.settings.map((s, i) => (i === 0 ? { ...s, surprise: 1 } : s));
  assert.ok(errorsFor({ ...payload, settings }).length > 0, "the schema accepted an unknown setting field");
});

test("a missing required setting field is rejected", () => {
  const payload = project();
  const settings = payload.settings.map((s, i) => {
    if (i !== 0) return s;
    const copy = { ...s };
    delete copy.effective_value;
    return copy;
  });
  assert.ok(errorsFor({ ...payload, settings }).length > 0, "the schema accepted a setting with no effective_value");
});


/* ═════════════════ 8. The mutability probe must not manufacture a refusal ═════════════════ */

test("a paper profile is still reported mutable in LIVE, despite one forbidden value", () => {
  // The probe asks "does this system STATE permit a change?" by evaluating a hypothetical different
  // value. If it happened to pick the one value forbidden in live, the setting would be reported as
  // permanently locked when in fact only that value is — a refusal manufactured by the probe itself.
  const payload = project({
    state: baseState({ executionMode: "live" }),
    deployment: { executionMode: "live", liveTradingEnabled: true, liveCapable: true },
  });
  const s = payload.settings.find((x) => x.key === "paperExecutionProfile");
  assert.equal(s.mutable, true, "the probe manufactured a forbidden_in_live refusal");
  assert.equal(
    s.blockers.some((b) => b.code === "forbidden_in_live"),
    false,
    "a forbidden-value blocker leaked into the editability affordance",
  );
  // The forbidden value is still advertised, because the backend refuses it on submit and the UI
  // should show why rather than silently omitting an option.
  assert.ok(s.enum_values.includes("stress"));
});

test("the probe never reports a setting mutable when the STATE genuinely forbids it", () => {
  // The complement: the fix must not have made the probe permissive.
  const payload = project({
    state: baseState({ executionMode: "live", entryArmed: true, openBoxes: 1 }),
    deployment: { executionMode: "live", liveTradingEnabled: true, liveCapable: true },
  });
  const s = payload.settings.find((x) => x.key === "paperExecutionProfile");
  assert.equal(s.mutation_policy, "FLAT_AND_DISARMED");
  assert.equal(s.mutable, false);
  assert.ok(s.blockers.some((b) => b.code === "session_armed" || b.code === "open_box"));
});

/* ═════════════════ 9. safe_direction reaches the wire ═════════════════ */

test("every setting publishes safe_direction, so the UI need not infer risk direction", () => {
  const VALID = ["lower_is_safer", "higher_is_safer", "enabled_is_safer", "disabled_is_safer", "neutral"];
  for (const s of project().settings) {
    assert.ok(VALID.includes(s.safe_direction), `${s.key} published "${s.safe_direction}"`);
  }
});

test("the coherence bounds publish the sentinel the UI needs to be conservative about", () => {
  const settings = project().settings;
  for (const key of [
    "maxCrossLegReceiveDispersionMs",
    "maxCrossLegExchangeDispersionMs",
    "maxReceiveToExchangeDelayMs",
  ]) {
    const s = settings.find((x) => x.key === key);
    assert.equal(s.zero_means, "disabled", `${key} lost its sentinel marker`);
    assert.equal(s.safe_direction, "lower_is_safer");
    // Without both fields the frontend cannot tell that 0 disables the gate.
    assert.notEqual(s.min, null);
  }
});
