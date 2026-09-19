/**
 * CONFIGURATION PRECEDENCE — one pure function, because this is the safety-critical rule.
 *
 * THE MODEL
 *
 *     code default  →  deployment/env override  →  persisted runtime operator override
 *
 * with ONE inversion that matters more than the ordering itself: a runtime override may never WIDEN
 * an authority the deployment expressed. For a setting declared `ceiling`/`floor`, an explicitly-set
 * environment value is an ABSOLUTE BOUND, and the effective value is the stricter of the two.
 *
 * Session snapshots sit below this and are deliberately NOT modelled here. `sessionMaxEntryAttempts`
 * and `sessionMaxCompletedTrades` are frozen into the durable session record at ARM
 * (`tradingSession.ts:armSession`), and that record — never this resolver — is what a per-attempt
 * decision compares against. This module resolves the CONFIGURED value that the next arm will read.
 *
 * WHY "EXPLICITLY SET" IS THE HINGE
 *
 * A ceiling only contains when the deployment actually stated one. If an unset variable were treated
 * as a ceiling, the code default would silently become an unraisable maximum, so a deployment that
 * never mentioned a limit could never have it raised from the UI. That is not containment, it is an
 * accident that looks like containment. `envPresent` therefore comes from the caller, which reads it
 * with the same "blank is not a value" rule the rest of the codebase uses (`src/env/layer.ts`'s
 * `hasUsableValue`), so a process manager injecting `FOO=` cannot create a phantom ceiling.
 *
 * WHY `Math.min` IS WRONG HERE
 *
 * Several ceilings use `0` to mean UNLIMITED (`BOX_MAX_OPEN_BOXES`, `BOX_LIVE_DAILY_LOSS_LIMIT`,
 * `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES`, …). `Math.min(5, 0)` is `0`, which would convert a finite
 * deployment limit into an unlimited one — the exact "do not accidentally turn an existing finite
 * risk limit into unlimited" failure the migration must avoid. Every comparison therefore happens in
 * a normalised space where `0` has become `+Infinity`, and the result is denormalised on the way out.
 */

import type {
  Containment,
  ResolveInput,
  ResolvedSetting,
  SafeDirection,
  SettingSpec,
  SettingValue,
  ZeroMeaning,
} from "./types.js";

/**
 * Map a stored number into comparison space, where "no bound is enforced" really is the largest value.
 *
 * BOTH `unlimited` AND `disabled` normalise, and an earlier revision of this function normalised only
 * `unlimited`. That was a real defect, not a stylistic gap: the three cross-leg coherence bounds are
 * `ceiling` settings that read `0` as "gate off", so with `0` left unnormalised a persisted
 * `maxCrossLegReceiveDispersionMs = 0` produced `Math.min(500, 0) = 0` and DISABLED a
 * deployment-mandated coherence check — and `isSafer` read the same `0` as the tightest possible
 * value, so the change was classified as a TIGHTENING and permitted while the live session was armed.
 * Two independent guards both inverted by one missing case.
 *
 * `value` (the third `ZeroMeaning`) is deliberately not normalised: for `liveMaxOpenBoxes` the order
 * manager tests `openBoxes >= limit`, so `0` refuses every entry and is the MOST restrictive setting
 * available. Normalising it would invert that one instead.
 */
export function toComparable(value: number, zeroMeans: ZeroMeaning | undefined): number {
  if (value === 0 && (zeroMeans === "unlimited" || zeroMeans === "disabled")) {
    return Number.POSITIVE_INFINITY;
  }
  return value;
}

/** Inverse of {@link toComparable}. */
export function fromComparable(value: number, zeroMeans: ZeroMeaning | undefined): number {
  if (value === Number.POSITIVE_INFINITY && (zeroMeans === "unlimited" || zeroMeans === "disabled")) {
    return 0;
  }
  return value;
}

/**
 * Is `0` a sentinel whose SAFETY DIRECTION cannot be determined from the value alone?
 *
 * True for `disabled`, and the reason is specific to the coherence bounds. `loadBoxConfig` documents
 * that in LIVE a `0` cross-leg dispersion limit is IMPOSSIBLE TO SATISFY — i.e. maximally safe, it
 * refuses every entry — unless `BOX_COHERENCE_ZERO_DISPERSION_DISABLES_IN_LIVE` is explicitly set,
 * while paper always reads `0` as "disabled" and therefore maximally permissive. The same stored `0`
 * is thus the strictest possible setting in one mode and the loosest in another, and which one applies
 * depends on a DIFFERENT setting.
 *
 * So no change involving it is PROVABLY a tightening, and this module refuses to guess: a `0`-involving
 * change is never called safe, which routes it to the flat-and-disarmed path instead of being waved
 * through while armed. A genuine finite-to-finite tightening (500 ms → 300 ms) is unaffected.
 */
export function zeroDirectionIsAmbiguous(zeroMeans: ZeroMeaning | undefined): boolean {
  return zeroMeans === "disabled";
}

/**
 * Is `candidate` strictly safer than `current` for this setting?
 *
 * Exported because ./policy.ts needs exactly this predicate to decide whether a change is a
 * permitted tightening while armed, and two definitions of "safer" is how a widening gets through.
 *
 * Numeric comparison happens in normalised space so that "unlimited" ranks as the least safe value
 * for a ceiling and the safest for a floor — otherwise `0` would look like the tightest possible cap.
 */
export function isSafer(
  spec: Pick<SettingSpec, "safeDirection" | "zeroMeans" | "type">,
  current: SettingValue,
  candidate: SettingValue,
): boolean {
  const direction: SafeDirection = spec.safeDirection;
  if (direction === "neutral") return false;

  if (typeof current === "boolean" && typeof candidate === "boolean") {
    if (direction === "enabled_is_safer") return candidate && !current;
    if (direction === "disabled_is_safer") return !candidate && current;
    return false;
  }

  if (typeof current === "number" && typeof candidate === "number") {
    // An ambiguous sentinel on either side makes the direction unprovable — see
    // {@link zeroDirectionIsAmbiguous}. Answering "false" is the conservative answer: the change is
    // not refused outright, it simply cannot be admitted as a tightening while armed.
    if (zeroDirectionIsAmbiguous(spec.zeroMeans) && (current === 0 || candidate === 0)) return false;
    const a = toComparable(current, spec.zeroMeans);
    const b = toComparable(candidate, spec.zeroMeans);
    if (direction === "lower_is_safer") return b < a;
    if (direction === "higher_is_safer") return b > a;
    return false;
  }

  // Enums and strings have no ordering, so no change to one is ever provably a tightening.
  return false;
}

/** The stricter of two booleans, given which state is the safe one. */
function composeBoolean(
  direction: SafeDirection,
  envValue: boolean,
  runtimeValue: boolean,
): boolean {
  // An env that explicitly asserts the SAFE state locks it; otherwise the operator decides.
  if (direction === "enabled_is_safer") return envValue || runtimeValue;
  if (direction === "disabled_is_safer") return envValue && runtimeValue;
  return runtimeValue;
}

/** The stricter of two numbers under `ceiling`/`floor`, in normalised space. */
function composeNumber(
  containment: Containment,
  zeroMeans: ZeroMeaning | undefined,
  envValue: number,
  runtimeValue: number,
): number {
  // A DEPLOYMENT THAT EXPLICITLY SET AN AMBIGUOUS SENTINEL PINS IT, in both directions.
  //
  // `min()`/`max()` cannot help here. In live-strict mode a stored `0` refuses every entry, so a
  // runtime 500 ms would be ENABLING entry — a widening — while in paper the same `0` disables the
  // check and a runtime 500 ms is a tightening. Since the deployment stated `0` and we cannot tell
  // which meaning is in force without reading another setting, the deployment's value stands and the
  // operator's is reported as clamped.
  if (zeroDirectionIsAmbiguous(zeroMeans) && envValue === 0) return 0;

  const envCmp = toComparable(envValue, zeroMeans);
  const runCmp = toComparable(runtimeValue, zeroMeans);
  const picked = containment === "ceiling" ? Math.min(envCmp, runCmp) : Math.max(envCmp, runCmp);
  return fromComparable(picked, zeroMeans);
}

/**
 * Resolve one setting to its configured value, its effective value and its provenance.
 *
 * `configured` is what the operator asked for; `effective` is what the engine will enforce. They
 * differ exactly when a deployment bound is overriding an operator value, and that case is reported
 * as `runtime_clamped_by_env` with `clampedByDeployment: true` so the UI can show both numbers
 * instead of quietly displaying one.
 *
 * MISSING NEVER MEANS ZERO. An absent runtime row falls through to env, and an absent env falls
 * through to the code default. There is no path in this function where absence produces `0`, and
 * `precedence.test.mjs` asserts that for every registered ceiling.
 */
export function resolveSetting(
  spec: SettingSpec,
  codeDefault: SettingValue,
  input: ResolveInput,
): ResolvedSetting {
  // PRESENT BUT UNPARSED IS NOT A DEPLOYMENT BOUND.
  //
  // An earlier revision read `input.envValue ?? codeDefault` here, which invented a bound out of the
  // code default whenever a caller reported presence without a value: `liveMaxOpenBoxes` then acquired
  // a phantom ceiling of 1 and silently capped every operator value, with `clampedByDeployment: true`
  // blaming a deployment that had said nothing of the sort. Absence of a usable value means the
  // deployment expressed no opinion, exactly as an unset variable does.
  const envValue =
    input.envPresent && input.envValue !== undefined ? input.envValue : undefined;
  const runtimeValue = input.runtimePresent ? input.runtimeValue : undefined;

  // The operator's intent, before any deployment containment is applied.
  const configured: SettingValue = runtimeValue ?? envValue ?? codeDefault;

  // No runtime row: the configured value IS the effective value. Provenance is env or default.
  if (runtimeValue === undefined) {
    return {
      key: spec.key,
      codeDefault,
      configured,
      effective: configured,
      source: envValue === undefined ? "default" : "env",
      deploymentBound: null,
      clampedByDeployment: false,
    };
  }

  // A runtime row exists but the deployment stated no bound, or the setting is a plain override.
  if (envValue === undefined || spec.containment === "replace") {
    return {
      key: spec.key,
      codeDefault,
      configured,
      effective: runtimeValue,
      source: "runtime",
      deploymentBound: null,
      clampedByDeployment: false,
    };
  }

  // A runtime row AND an explicit deployment bound: take the stricter value.
  let effective: SettingValue;
  if (typeof envValue === "boolean" && typeof runtimeValue === "boolean") {
    effective = composeBoolean(spec.safeDirection, envValue, runtimeValue);
  } else if (typeof envValue === "number" && typeof runtimeValue === "number") {
    effective = composeNumber(spec.containment, spec.zeroMeans, envValue, runtimeValue);
  } else {
    // An enum/string cannot be "stricter". The deployment value wins, because a bound that cannot be
    // compared must not be silently discarded in favour of a runtime value.
    effective = envValue;
  }

  const clamped = effective !== runtimeValue;
  return {
    key: spec.key,
    codeDefault,
    configured,
    effective,
    source: clamped ? "runtime_clamped_by_env" : "runtime",
    deploymentBound: envValue,
    clampedByDeployment: clamped,
  };
}
