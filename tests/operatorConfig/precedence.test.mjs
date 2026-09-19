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

test("zero normalises to +Infinity for `unlimited` AND `disabled`, never for `value`", () => {
  // This test previously asserted `toComparable(0, "disabled") === 0`, which encoded the defect
  // described in section 7: it let a runtime 0 disable a deployment-mandated coherence bound and be
  // classified as a tightening. Both sentinels mean "no bound is enforced", so both normalise.
  assert.equal(toComparable(0, "unlimited"), Number.POSITIVE_INFINITY);
  assert.equal(toComparable(0, "disabled"), Number.POSITIVE_INFINITY);
  // `value` must NOT normalise: for liveMaxOpenBoxes, 0 refuses every entry and is the strictest
  // setting available, so normalising it would invert that one in the opposite direction.
  assert.equal(toComparable(0, "value"), 0);
  assert.equal(toComparable(0, undefined), 0);
  assert.equal(fromComparable(Number.POSITIVE_INFINITY, "unlimited"), 0);
  assert.equal(fromComparable(Number.POSITIVE_INFINITY, "disabled"), 0);
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


/* ═════════════════ 7. The AMBIGUOUS ZERO SENTINEL — three regressions ═════════════════ */

/*
 * These exist because an earlier revision of this module got the coherence bounds exactly backwards,
 * and two independent guards were inverted by one missing case.
 *
 * `maxCrossLegReceiveDispersionMs` is a `ceiling` whose `0` means "gate off". With `0` left out of the
 * normalisation, `Math.min(500, 0)` was `0`, so a persisted runtime `0` DISABLED a deployment-mandated
 * cross-leg coherence check — and `isSafer` read the same `0` as the tightest possible value, so the
 * change was classified as a TIGHTENING and permitted while the live session was armed.
 *
 * The direction is genuinely undecidable from the value: `loadBoxConfig` documents that in LIVE a `0`
 * dispersion limit is impossible to satisfy (maximally safe — it refuses every entry) unless
 * BOX_COHERENCE_ZERO_DISPERSION_DISABLES_IN_LIVE is set, while paper always reads `0` as disabled and
 * therefore maximally permissive. So the resolver refuses to guess.
 */

const AMBIGUOUS = OPERATOR_SETTINGS.filter((s) => s.zeroMeans === "disabled");

test("the ambiguous-sentinel settings are the coherence bounds, and they are ceilings", () => {
  assert.deepEqual(
    AMBIGUOUS.map((s) => s.key).sort(),
    ["maxCrossLegExchangeDispersionMs", "maxCrossLegReceiveDispersionMs", "maxReceiveToExchangeDelayMs"],
  );
  for (const s of AMBIGUOUS) assert.equal(s.containment, "ceiling", `${s.key} is not a ceiling`);
});

test("a runtime 0 cannot disable a deployment-mandated coherence bound", () => {
  for (const s of AMBIGUOUS) {
    const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
      envPresent: true,
      envValue: 500,
      runtimePresent: true,
      runtimeValue: 0,
    });
    assert.equal(r.effective, 500, `${s.key}: a runtime 0 switched the gate off`);
    assert.equal(r.configured, 0, "the operator's intent is still reported");
    assert.equal(r.clampedByDeployment, true);
    assert.equal(r.source, "runtime_clamped_by_env");
  }
});

test("moving a coherence bound to or from 0 is never called a tightening", () => {
  for (const s of AMBIGUOUS) {
    assert.equal(isSafer(s, 500, 0), false, `${s.key}: 500 -> 0 was called safer`);
    assert.equal(isSafer(s, 0, 500), false, `${s.key}: 0 -> 500 was called safer`);
  }
});

test("a genuine finite tightening of a coherence bound is still recognised", () => {
  // The fix must not make every change to these settings unprovable — only the 0 cases.
  for (const s of AMBIGUOUS) {
    assert.equal(isSafer(s, 500, 300), true, `${s.key}: 500 -> 300 should be a tightening`);
    assert.equal(isSafer(s, 300, 500), false, `${s.key}: 300 -> 500 should be a widening`);
  }
});

test("a deployment that explicitly set 0 pins it, in both directions", () => {
  // In live-strict mode that 0 refuses every entry, so a runtime 500 would be ENABLING entry. Since
  // which meaning applies depends on another setting, the deployment's value stands.
  for (const s of AMBIGUOUS) {
    const r = resolveSetting(s, CODE_DEFAULTS.get(s.key), {
      envPresent: true,
      envValue: 0,
      runtimePresent: true,
      runtimeValue: 500,
    });
    assert.equal(r.effective, 0, `${s.key}: a runtime value overrode a deployment-pinned 0`);
    assert.equal(r.clampedByDeployment, true);
  }
});

test("`value` zero is NOT normalised, because there 0 is the STRICTEST setting", () => {
  // liveMaxOpenBoxes: the order manager tests `openBoxes >= limit`, so 0 refuses every entry.
  // Normalising it would invert this one in the opposite direction.
  const s = spec("liveMaxOpenBoxes");
  assert.equal(s.zeroMeans, "value");
  assert.equal(toComparable(0, "value"), 0);
  // 0 is the safest value, so moving away from it is a widening.
  assert.equal(isSafer(s, 0, 3), false);
  assert.equal(isSafer(s, 3, 0), true);
});

test("all three ZeroMeaning values round-trip through the comparison space", () => {
  for (const zero of ["unlimited", "disabled"]) {
    assert.equal(toComparable(0, zero), Number.POSITIVE_INFINITY);
    assert.equal(fromComparable(Number.POSITIVE_INFINITY, zero), 0);
  }
  assert.equal(toComparable(0, "value"), 0);
  assert.equal(fromComparable(Number.POSITIVE_INFINITY, "value"), Number.POSITIVE_INFINITY);
});

/* ═════════════════ 8. PRESENT-BUT-UNPARSED IS NOT A BOUND ═════════════════ */

test("env presence without a value does not invent a deployment bound", () => {
  // The regression: `input.envValue ?? codeDefault` gave liveMaxOpenBoxes a phantom ceiling of 1,
  // silently capping every operator value and blaming a deployment that had said nothing.
  const s = spec("liveMaxOpenBoxes");
  const r = resolveSetting(s, 1, { envPresent: true, runtimePresent: true, runtimeValue: 5 });
  assert.equal(r.effective, 5, "a phantom bound capped the operator value");
  assert.equal(r.deploymentBound, null);
  assert.equal(r.clampedByDeployment, false);
  assert.equal(r.source, "runtime");
});

test("env presence without a value falls through to the code default when nothing is persisted", () => {
  const s = spec("liveMaxOpenBoxes");
  const r = resolveSetting(s, 1, { envPresent: true, runtimePresent: false });
  assert.equal(r.effective, 1);
  assert.equal(r.source, "default", "an unparsed env value was reported as an env-sourced one");
});
