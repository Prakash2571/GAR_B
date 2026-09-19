/**
 * THE IMMUTABLE VERSIONED SNAPSHOT.
 *
 * Two properties are load-bearing here:
 *
 *   PERFORMANCE — every read is a synchronous lookup against a frozen object. There is no database
 *   call on any hot path, which is why the snapshot exists at all rather than the engine querying
 *   `box_settings` per candidate.
 *
 *   ATOMICITY — a mutation produces a WHOLE NEW snapshot at version + 1. Nothing is patched in place,
 *   so a derived value cannot be left over from the previous version and a rollback is exact. This is
 *   the same discipline `engine.applyTuning()` already uses when it re-derives the gross prefilter
 *   from an immutable baseline instead of adjusting the running value.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { snapshot as snap, registry } from "./_harness.mjs";

const { buildSnapshot, withMutations, effectiveValue, effectiveNumber, effectiveBoolean, isStaleWrite } =
  snap;
const { OPERATOR_SETTINGS, CODE_DEFAULTS } = registry;

const NO_ENV = new Map();
const NO_RUNTIME = new Map();

function build(overrides = {}) {
  return buildSnapshot({
    version: overrides.version ?? 1,
    updatedAt: overrides.updatedAt ?? "2026-09-19T04:00:00.000Z",
    specs: overrides.specs ?? OPERATOR_SETTINGS,
    codeDefaults: overrides.codeDefaults ?? CODE_DEFAULTS,
    envInputs: overrides.envInputs ?? NO_ENV,
    runtimeValues: overrides.runtimeValues ?? NO_RUNTIME,
  });
}

/* ═════════════════ 1. A bare deployment resolves to code defaults ═════════════════ */

test("with no env and no persisted rows, every setting resolves to its code default", () => {
  const s = build();
  assert.equal(s.effective.size, OPERATOR_SETTINGS.length);
  for (const spec of OPERATOR_SETTINGS) {
    assert.equal(
      s.effective.get(spec.key),
      CODE_DEFAULTS.get(spec.key),
      `${spec.key} did not resolve to its code default`,
    );
    assert.equal(s.resolved.get(spec.key).source, "default");
  }
});

test("a missing persisted row never resolves to 0", () => {
  const s = build();
  for (const spec of OPERATOR_SETTINGS) {
    const value = s.effective.get(spec.key);
    const expected = CODE_DEFAULTS.get(spec.key);
    // Only assert the dangerous direction: a non-zero default must not have become 0.
    if (typeof expected === "number" && expected !== 0) {
      assert.notEqual(value, 0, `${spec.key} collapsed to 0 with no persisted row`);
    }
  }
});

/* ═════════════════ 2. Immutability ═════════════════ */

test("the snapshot object is frozen, as is each resolved entry", () => {
  const s = build();
  assert.equal(Object.isFrozen(s), true);
  assert.throws(() => {
    "use strict";
    s.version = 99;
  }, TypeError);
  for (const spec of OPERATOR_SETTINGS) {
    assert.equal(Object.isFrozen(s.resolved.get(spec.key)), true, `${spec.key} resolution is mutable`);
  }
});

/* ═════════════════ 3. Versioning ═════════════════ */

test("a mutation produces version + 1, leaving the previous snapshot untouched", () => {
  const first = build({ version: 7 });
  const second = withMutations(first, {
    specs: OPERATOR_SETTINGS,
    codeDefaults: CODE_DEFAULTS,
    envInputs: NO_ENV,
    runtimeValues: new Map([["maxOpenBoxes", 3]]),
    updatedAt: "2026-09-19T05:00:00.000Z",
  });

  assert.equal(second.version, 8);
  assert.equal(first.version, 7, "the previous snapshot was mutated");
  assert.equal(second.effective.get("maxOpenBoxes"), 3);
  assert.equal(first.effective.get("maxOpenBoxes"), CODE_DEFAULTS.get("maxOpenBoxes"));
  assert.equal(second.updatedAt, "2026-09-19T05:00:00.000Z");
});

test("a second mutation does not retain the first one's values", () => {
  // Rebuilding wholesale is what guarantees this: a patch-in-place implementation would leave
  // maxOpenBoxes at 3 after it was removed from the runtime map.
  const v1 = build({ version: 1 });
  const v2 = withMutations(v1, {
    specs: OPERATOR_SETTINGS,
    codeDefaults: CODE_DEFAULTS,
    envInputs: NO_ENV,
    runtimeValues: new Map([["maxOpenBoxes", 3]]),
    updatedAt: "t2",
  });
  const v3 = withMutations(v2, {
    specs: OPERATOR_SETTINGS,
    codeDefaults: CODE_DEFAULTS,
    envInputs: NO_ENV,
    runtimeValues: new Map(), // the row was reset
    updatedAt: "t3",
  });
  assert.equal(v3.version, 3);
  assert.equal(v3.effective.get("maxOpenBoxes"), CODE_DEFAULTS.get("maxOpenBoxes"));
  assert.equal(v3.resolved.get("maxOpenBoxes").source, "default");
});

test("a stale or absent expected version is refused", () => {
  const s = build({ version: 17 });
  assert.equal(isStaleWrite(s, 17), false);
  assert.equal(isStaleWrite(s, 16), true);
  assert.equal(isStaleWrite(s, 18), true);
  // Absent is stale, not "force" — a client that cannot say what it edits may not overwrite a limit.
  assert.equal(isStaleWrite(s, undefined), true);
  assert.equal(isStaleWrite(s, 17.5), true);
  assert.equal(isStaleWrite(s, Number.NaN), true);
});

/* ═════════════════ 4. Provenance survives into the snapshot ═════════════════ */

test("a deployment clamp is reported on the resolved entry, not silently applied", () => {
  const s = build({
    envInputs: new Map([["liveMaxBoxCapitalRupees", { present: true, value: 120_000 }]]),
    runtimeValues: new Map([["liveMaxBoxCapitalRupees", 150_000]]),
  });
  const r = s.resolved.get("liveMaxBoxCapitalRupees");
  assert.equal(r.effective, 120_000);
  assert.equal(r.configured, 150_000);
  assert.equal(r.source, "runtime_clamped_by_env");
  assert.equal(r.clampedByDeployment, true);
  assert.equal(r.deploymentBound, 120_000);
  // The snapshot's effective map carries the ENFORCED figure, never the requested one.
  assert.equal(s.effective.get("liveMaxBoxCapitalRupees"), 120_000);
});

test("env-sourced values are reported as `env`, not as `default`", () => {
  const s = build({
    envInputs: new Map([["safetyBuffer", { present: true, value: 400 }]]),
  });
  assert.equal(s.effective.get("safetyBuffer"), 400);
  assert.equal(s.resolved.get("safetyBuffer").source, "env");
});

/* ═════════════════ 5. Accessors fail loudly ═════════════════ */

test("reading an unregistered key throws instead of returning undefined", () => {
  const s = build();
  // A typo in execution code must crash at first use, not silently become a permissive limit.
  assert.throws(() => effectiveValue(s, "notASetting"), /not a registered setting/);
  assert.throws(() => effectiveNumber(s, "notASetting"), /not a registered setting/);
});

test("typed accessors refuse a mismatched type", () => {
  const s = build();
  assert.equal(effectiveNumber(s, "maxOpenBoxes"), CODE_DEFAULTS.get("maxOpenBoxes"));
  assert.equal(effectiveBoolean(s, "oneActiveBoxPerUnderlying"), false);
  assert.throws(() => effectiveNumber(s, "oneActiveBoxPerUnderlying"), /not numeric/);
  assert.throws(() => effectiveBoolean(s, "maxOpenBoxes"), /not boolean/);
});

/* ═════════════════ 6. A setting with no default is a boot failure ═════════════════ */

test("building a snapshot without a code default throws rather than resolving undefined", () => {
  assert.throws(
    () =>
      build({
        specs: [OPERATOR_SETTINGS[0]],
        codeDefaults: new Map(), // deliberately empty
      }),
    /has no code default/,
  );
});

/* ═════════════════ 7. Hot-path shape ═════════════════ */

test("reads are plain synchronous lookups — no promise anywhere in the accessor path", () => {
  const s = build();
  for (const spec of OPERATOR_SETTINGS) {
    const value = effectiveValue(s, spec.key);
    assert.notEqual(value, undefined);
    assert.equal(typeof value === "object", false, `${spec.key} resolved to an object`);
    assert.equal(value instanceof Promise, false);
  }
});
