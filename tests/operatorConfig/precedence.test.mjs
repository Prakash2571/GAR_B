/**
 * CONFIGURATION PRECEDENCE.
 *
 * These assertions encode the two rules that make the whole refactor safe rather than merely tidy:
 *
 *   1. MISSING NEVER MEANS ZERO. A deployment with no persisted rows must behave exactly as it did
 *      before the migration. If an absent row resolved to 0, several ceilings would silently become
 *      UNLIMITED — `BOX_MAX_OPEN_BOXES`, `BOX_LIVE_DAILY_LOSS_LIMIT` and
 *      `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` all read 0 as "no limit".
 *
 *   2. A RUNTIME OVERRIDE MAY TIGHTEN BUT NEVER WIDEN A DEPLOYMENT BOUND. This is what stops the
 *      browser from raising a limit the deployment pinned.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { precedence, registry, spec } from "./_harness.mjs";

const { resolveSetting, isSafer, toComparable, fromComparable } = precedence;
const { OPERATOR_SETTINGS, CODE_DEFAULTS } = registry;

/* ═════════════════ 1. Missing means fall through, never zero ═════════════════ */

test("no env and no runtime row resolves to the code default, with `default` provenance", () => {
  for (const s of OPERATOR_SETTINGS) {
    const codeDefault = CODE_DEFAULTS.get(s.key);
    const r = resolveSetting(s, codeDefault, { envPresent: false, runtimePresent: false });
    assert.equal(r.effective, codeDefault, `${s.key} did not fall through to its code default`);
    assert.equal(r.configured, codeDefault);
    assert.equal(r.source, "default");
    assert.equal(r.clampedByDeployment, false);
    assert.equal(r.deploymentBound, null);
  }
});

test("a missing runtime row NEVER resolves a ceiling to 0 when env pinned a finite limit", () => {
  // The specific migration hazard: an operator has BOX_MAX_OPEN_BOXES=3 in .env, the new table is
  // empty, and the deployment must still enforce 3 rather than "unlimited".
  const ceilings = OPERATOR_SETTINGS.filter(
    (s) => s.containment === "ceiling" && s.type === "integer" && s.zeroMeans === "unlimited",
  );
  assert.ok(ceilings.length >= 4, "expected several unlimited-capable ceilings to exist");

  for (const s of ceilings) {
    const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
      envPresent: true,
      envValue: 3,
      runtimePresent: false,
    });
    assert.equal(r.effective, 3, `${s.key} lost its env-pinned limit`);
    assert.equal(r.source, "env");
    assert.notEqual(r.effective, 0, `${s.key} became UNLIMITED with no runtime row`);
  }
});

/* ═════════════════ 2. `0 = unlimited` arithmetic ═════════════════ */

test("zero normalises to +Infinity only for `unlimited` settings", () => {
  assert.equal(toComparable(0, "unlimited"), Number.POSITIVE_INFINITY);
  assert.equal(toComparable(0, "disabled"), 0);
  assert.equal(toComparable(0, "value"), 0);
  assert.equal(toComparable(0, undefined), 0);
  assert.equal(fromComparable(Number.POSITIVE_INFINITY, "unlimited"), 0);
  assert.equal(fromComparable(5, "unlimited"), 5);
});

test("a runtime `0` cannot widen a finite deployment ceiling to unlimited", () => {
  const s = spec("maxOpenBoxes");
  const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
    envPresent: true,
    envValue: 2,
    runtimePresent: true,
    runtimeValue: 0, // "unlimited"
  });
  // Naive Math.min(2, 0) would be 0 = UNLIMITED. The normalised comparison keeps 2.
  assert.equal(r.effective, 2, "runtime 0 widened a finite ceiling to unlimited");
  assert.equal(r.configured, 0, "the operator's intent is still reported");
  assert.equal(r.source, "runtime_clamped_by_env");
  assert.equal(r.clampedByDeployment, true);
  assert.equal(r.deploymentBound, 2);
});

test("a runtime value may tighten below an unlimited deployment ceiling", () => {
  const s = spec("maxOpenBoxes");
  const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
    envPresent: true,
    envValue: 0, // deployment says unlimited
    runtimePresent: true,
    runtimeValue: 4,
  });
  assert.equal(r.effective, 4);
  assert.equal(r.source, "runtime");
  assert.equal(r.clampedByDeployment, false);
});

/* ═════════════════ 3. Ceiling / floor containment ═════════════════ */

test("a ceiling refuses to be raised and reports the clamp", () => {
  const s = spec("liveMaxBoxCapitalRupees");
  const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
    envPresent: true,
    envValue: 120_000,
    runtimePresent: true,
    runtimeValue: 150_000,
  });
  assert.equal(r.effective, 120_000, "a runtime value widened a deployment capital cap");
  assert.equal(r.configured, 150_000);
  assert.equal(r.clampedByDeployment, true);
  assert.equal(r.source, "runtime_clamped_by_env");
});

test("a ceiling accepts being lowered", () => {
  const s = spec("liveMaxBoxCapitalRupees");
  const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
    envPresent: true,
    envValue: 120_000,
    runtimePresent: true,
    runtimeValue: 90_000,
  });
  assert.equal(r.effective, 90_000);
  assert.equal(r.clampedByDeployment, false);
  assert.equal(r.source, "runtime");
});

test("a floor refuses to be lowered", () => {
  const s = spec("expirySafetyMinutes");
  assert.equal(s.containment, "floor");
  const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
    envPresent: true,
    envValue: 60,
    runtimePresent: true,
    runtimeValue: 10,
  });
  assert.equal(r.effective, 60, "a runtime value lowered a deployment minimum");
  assert.equal(r.clampedByDeployment, true);
});

test("`replace` containment lets a runtime value supersede env outright", () => {
  const s = spec("minExpectedNetProfit");
  assert.equal(s.containment, "replace");
  const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
    envPresent: true,
    envValue: 1200,
    runtimePresent: true,
    runtimeValue: 800,
  });
  // Deliberate backward compatibility: this knob is already DB-authoritative via box_settings.
  assert.equal(r.effective, 800);
  assert.equal(r.source, "runtime");
  assert.equal(r.clampedByDeployment, false);
});

/* ═════════════════ 4. Boolean containment follows the SAFE direction ═════════════════ */

test("an env-enabled protection cannot be disabled at runtime", () => {
  const s = spec("oneActiveBoxPerUnderlying");
  assert.equal(s.safeDirection, "enabled_is_safer");
  const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
    envPresent: true,
    envValue: true,
    runtimePresent: true,
    runtimeValue: false,
  });
  assert.equal(r.effective, true, "runtime disabled a deployment-enabled protection");
  assert.equal(r.clampedByDeployment, true);
});

test("an env-disabled risky feature cannot be enabled at runtime", () => {
  const s = spec("enableShortBox");
  assert.equal(s.safeDirection, "disabled_is_safer");
  const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
    envPresent: true,
    envValue: false,
    runtimePresent: true,
    runtimeValue: true,
  });
  assert.equal(r.effective, false, "runtime enabled a deployment-disabled risky feature");
  assert.equal(r.clampedByDeployment, true);
});

test("a protection the deployment left off may be enabled at runtime", () => {
  const s = spec("oneActiveBoxPerUnderlying");
  const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
    envPresent: true,
    envValue: false,
    runtimePresent: true,
    runtimeValue: true,
  });
  assert.equal(r.effective, true);
  assert.equal(r.clampedByDeployment, false);
});

/* ═════════════════ 5. An unset env expresses no bound ═════════════════ */

test("an unset env var does not turn the code default into an unraisable ceiling", () => {
  const s = spec("maxOpenBoxes");
  const r = resolveSetting(s, 0, {
    envPresent: false,
    runtimePresent: true,
    runtimeValue: 6,
  });
  assert.equal(r.effective, 6, "the code default acted as a ceiling despite no deployment opinion");
  assert.equal(r.source, "runtime");
  assert.equal(r.deploymentBound, null);
  assert.equal(r.clampedByDeployment, false);
});

/* ═════════════════ 6. `isSafer` is direction-aware, not magnitude-aware ═════════════════ */

test("isSafer knows that bigger is safer for a threshold and riskier for a ceiling", () => {
  const threshold = spec("minExpectedNetProfit"); // higher_is_safer
  assert.equal(isSafer(threshold, 1200, 1500), true);
  assert.equal(isSafer(threshold, 1200, 900), false);

  const ceiling = spec("maxOpenBoxes"); // lower_is_safer
  assert.equal(isSafer(ceiling, 5, 2), true);
  assert.equal(isSafer(ceiling, 2, 5), false);
});

test("isSafer treats unlimited as the least safe value for a ceiling", () => {
  const ceiling = spec("maxOpenBoxes");
  // 0 = unlimited, so moving 0 -> 3 is a TIGHTENING even though the number grew.
  assert.equal(isSafer(ceiling, 0, 3), true);
  assert.equal(isSafer(ceiling, 3, 0), false);
});

test("isSafer never claims an enum change is a tightening", () => {
  const s = spec("paperExecutionProfile");
  assert.equal(isSafer(s, "standard", "live_parity"), false);
  assert.equal(isSafer(s, "live_parity", "standard"), false);
});

test("isSafer is false for an equal value, so a no-op is never mistaken for a tightening", () => {
  assert.equal(isSafer(spec("maxOpenBoxes"), 3, 3), false);
  assert.equal(isSafer(spec("oneActiveBoxPerUnderlying"), true, true), false);
});
