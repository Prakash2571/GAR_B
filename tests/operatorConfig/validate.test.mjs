/**
 * PATCH VALIDATION.
 *
 * The behaviours asserted here are the difference between a configuration API and a footgun:
 * an unknown key must not be silently ignored, a non-finite number must not reach a risk limit, and a
 * patch with one bad field must not land its good fields.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validate, registry } from "./_harness.mjs";

const { validatePatch, PATCH_SCOPE } = validate;
const SPECS = registry.OPERATOR_SETTINGS;

const codes = (result) => result.problems.map((p) => p.code).sort();
const keys = (result) => result.problems.map((p) => p.key).sort();

/* ═════════════════ 1. Unknown keys are refused, never ignored ═════════════════ */

test("an unknown key is rejected rather than ignored", () => {
  const r = validatePatch({ notASetting: 5 }, SPECS);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["unknown_key"]);
  assert.deepEqual(keys(r), ["notASetting"]);
});

test("an env-var-style key is rejected — the API speaks domain keys only", () => {
  const r = validatePatch({ BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: 150_000 }, SPECS);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["unknown_key"]);
});

test("an empty patch is rejected", () => {
  const r = validatePatch({}, SPECS);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["empty_patch"]);
  assert.equal(r.problems[0].key, PATCH_SCOPE);
});

/* ═════════════════ 2. Non-finite and wrong-typed values ═════════════════ */

test("NaN and both infinities are refused", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const r = validatePatch({ maxOpenBoxes: bad }, SPECS);
    assert.equal(r.ok, false, `${String(bad)} was accepted`);
    assert.deepEqual(codes(r), ["not_finite"]);
  }
});

test("a numeric setting refuses a numeric STRING rather than coercing it", () => {
  const r = validatePatch({ liveMaxBoxCapitalRupees: "150000" }, SPECS);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["not_a_number"]);
});

test("a boolean setting refuses a truthy non-boolean", () => {
  for (const bad of [1, "true", "yes"]) {
    const r = validatePatch({ oneActiveBoxPerUnderlying: bad }, SPECS);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} was accepted as a boolean`);
    assert.deepEqual(codes(r), ["not_a_boolean"]);
  }
});

test("an integer setting refuses a fraction, because rounding would change the limit", () => {
  const r = validatePatch({ maxOpenBoxes: 2.5 }, SPECS);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["not_an_integer"]);
});

test("a present-but-null value is refused rather than treated as 'leave alone'", () => {
  // The legacy validateTuning skipped null/""; that made a UI bug indistinguishable from an
  // untouched field. Omitting the key is the way to leave a setting alone.
  for (const bad of [null, undefined]) {
    const r = validatePatch({ safetyBuffer: bad }, SPECS);
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), ["value_required"]);
  }
});

/* ═════════════════ 3. Ranges are enforced from the registry ═════════════════ */

test("values below min and above max are refused with distinct codes", () => {
  const below = validatePatch({ maxOpenBoxes: -1 }, SPECS);
  assert.equal(below.ok, false);
  assert.deepEqual(codes(below), ["below_min"]);

  const above = validatePatch({ maxOpenBoxes: 51 }, SPECS);
  assert.equal(above.ok, false);
  assert.deepEqual(codes(above), ["above_max"]);
});

test("every numeric setting enforces its declared bounds", () => {
  for (const s of SPECS) {
    if (s.type !== "integer" && s.type !== "number") continue;
    assert.ok(s.min !== undefined, `${s.key} has no min`);
    assert.ok(s.max !== undefined, `${s.key} has no max`);

    const under = validatePatch({ [s.key]: s.min - 1 }, SPECS);
    assert.equal(under.ok, false, `${s.key} accepted a value below min`);

    const over = validatePatch({ [s.key]: s.max + 1 }, SPECS);
    assert.equal(over.ok, false, `${s.key} accepted a value above max`);

    const ok = validatePatch({ [s.key]: s.min }, SPECS);
    assert.equal(ok.ok, true, `${s.key} rejected its own minimum`);
  }
});

test("bounds are inclusive at both ends", () => {
  assert.equal(validatePatch({ maxOpenBoxes: 0 }, SPECS).ok, true);
  assert.equal(validatePatch({ maxOpenBoxes: 50 }, SPECS).ok, true);
});

/* ═════════════════ 4. Enums ═════════════════ */

test("an enum accepts only declared values", () => {
  assert.equal(validatePatch({ paperExecutionProfile: "live_parity" }, SPECS).ok, true);
  const r = validatePatch({ paperExecutionProfile: "turbo" }, SPECS);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["not_in_enum"]);
});

/* ═════════════════ 5. All-or-nothing ═════════════════ */

test("one invalid field refuses the WHOLE patch — no partial application", () => {
  const r = validatePatch({ safetyBuffer: 200, maxOpenBoxes: 999 }, SPECS);
  assert.equal(r.ok, false);
  // `values` is not present at all on a failure, so there is nothing a caller could half-apply.
  assert.equal(r.values, undefined);
  assert.deepEqual(codes(r), ["above_max"]);
});

test("every problem is reported in one pass, not just the first", () => {
  const r = validatePatch(
    { safetyBuffer: Number.NaN, maxOpenBoxes: 999, nope: 1 },
    SPECS,
  );
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["above_max", "not_finite", "unknown_key"]);
});

test("a fully valid patch returns exactly the coerced values", () => {
  const r = validatePatch({ safetyBuffer: 250, oneActiveBoxPerUnderlying: true }, SPECS);
  assert.equal(r.ok, true);
  assert.equal(r.values.size, 2);
  assert.equal(r.values.get("safetyBuffer"), 250);
  assert.equal(r.values.get("oneActiveBoxPerUnderlying"), true);
});

/* ═════════════════ 6. Read-only settings ═════════════════ */

test("a RESTART_REQUIRED setting cannot be written even with a valid value", () => {
  const readOnly = SPECS.filter((s) => s.policy === "RESTART_REQUIRED");
  for (const s of readOnly) {
    const value = s.type === "boolean" ? true : s.type === "enum" ? s.enumValues[0] : s.min;
    const r = validatePatch({ [s.key]: value }, SPECS);
    assert.equal(r.ok, false, `${s.key} was writable despite RESTART_REQUIRED`);
    assert.deepEqual(codes(r), ["not_mutable"]);
  }
});
