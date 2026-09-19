/**
 * PATCH VALIDATION — strict, whole-patch, and it never clamps.
 *
 * THE RULE: A PATCH IS ALL-OR-NOTHING.
 *
 * Every problem in the request is collected and the ENTIRE patch is refused if there is even one.
 * Two reasons, and the second is the important one:
 *
 *   1. An operator fixing a form wants every complaint in one pass, not one per round trip.
 *   2. A partially-applied risk change is an unknown risk state. "I raised the cap and tightened the
 *      coherence bound" must not be able to land as "I raised the cap". Half of a two-sided
 *      adjustment can be strictly more dangerous than neither half.
 *
 * WHY IT REFUSES INSTEAD OF CLAMPING
 *
 * `src/box/config.ts` deliberately has BOTH behaviours, and the distinction is load-bearing: `clampInt`
 * clamps a tuning value, while `strictLimitInt` THROWS for a containment limit, because — as its own
 * comment records — `BOX_SESSION_MAX_ENTRY_ATTEMPTS="one"` clamping to `0` silently means UNLIMITED.
 * An HTTP API has no "leave it unset" case to be lenient about: every key in the body was typed by
 * somebody on purpose, so silently narrowing or widening it hides the mistake. This validator is
 * therefore always strict, matching `validateTuning`, which also rejects rather than clamps.
 *
 * ONE DEPARTURE FROM THE LEGACY `validateTuning`, ON PURPOSE
 *
 * `validateTuning` treats `""`/`null`/`undefined` as "leave this alone" and skips it. That made a
 * reset-to-default impossible to express and means a UI bug that sends `null` is indistinguishable
 * from a field the operator did not touch. Here, a key that is PRESENT must carry a usable value;
 * omit the key to leave a setting alone, and use the explicit reset path to return to the default.
 */

import type { SettingSpec, SettingValue } from "./types.js";

/** A single named validation failure. `key` is `"__patch__"` for whole-body problems. */
export interface ValidationProblem {
  readonly key: string;
  readonly code: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, SettingValue> }
  | { readonly ok: false; readonly problems: readonly ValidationProblem[] };

/** Sentinel key for problems that concern the request as a whole rather than one setting. */
export const PATCH_SCOPE = "__patch__";

function problem(key: string, code: string, message: string): ValidationProblem {
  return { key, code, message };
}

/**
 * Validate one value against its spec. Returns the coerced value or a problem.
 *
 * Numbers are NOT coerced from strings. `"150000"` is rejected rather than parsed, because a typed
 * API whose client can send either is a client that will eventually send `"1,50,000"` and have it
 * read as `1`. The frontend sends JSON numbers.
 */
function validateOne(
  spec: SettingSpec,
  raw: unknown,
): { readonly ok: true; readonly value: SettingValue } | { readonly ok: false; readonly problem: ValidationProblem } {
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      problem: problem(
        spec.key,
        "value_required",
        `${spec.label} was sent with no value. Omit the key to leave it unchanged.`,
      ),
    };
  }

  if (spec.type === "boolean") {
    if (typeof raw !== "boolean") {
      return {
        ok: false,
        problem: problem(spec.key, "not_a_boolean", `${spec.label} must be true or false.`),
      };
    }
    return { ok: true, value: raw };
  }

  if (spec.type === "enum") {
    if (typeof raw !== "string") {
      return { ok: false, problem: problem(spec.key, "not_a_string", `${spec.label} must be a string.`) };
    }
    const allowed = spec.enumValues ?? [];
    if (!allowed.includes(raw)) {
      return {
        ok: false,
        problem: problem(
          spec.key,
          "not_in_enum",
          `${spec.label} must be one of: ${allowed.join(", ")}.`,
        ),
      };
    }
    return { ok: true, value: raw };
  }

  // integer | number
  if (typeof raw !== "number") {
    return { ok: false, problem: problem(spec.key, "not_a_number", `${spec.label} must be a number.`) };
  }
  // Rejects NaN, Infinity and -Infinity in one predicate. A non-finite risk limit is not a limit.
  if (!Number.isFinite(raw)) {
    return {
      ok: false,
      problem: problem(spec.key, "not_finite", `${spec.label} must be a finite number.`),
    };
  }
  if (spec.type === "integer" && !Number.isInteger(raw)) {
    return {
      ok: false,
      problem: problem(
        spec.key,
        "not_an_integer",
        `${spec.label} must be a whole number — rounding it would change the limit you asked for.`,
      ),
    };
  }
  if (spec.min !== undefined && raw < spec.min) {
    return {
      ok: false,
      problem: problem(spec.key, "below_min", `${spec.label} must be at least ${spec.min}.`),
    };
  }
  if (spec.max !== undefined && raw > spec.max) {
    return {
      ok: false,
      problem: problem(spec.key, "above_max", `${spec.label} must be at most ${spec.max}.`),
    };
  }
  return { ok: true, value: raw };
}

/**
 * Validate a whole patch body against the registry.
 *
 * Unknown keys are REFUSED, not ignored. Ignoring one means an operator who mistypes a setting name
 * gets a `200 OK` for a change that never happened — and on this surface that change is a risk limit.
 * The same reasoning rejects a body that contains no settings at all.
 */
export function validatePatch(
  patch: Readonly<Record<string, unknown>>,
  specs: readonly SettingSpec[],
): ValidationResult {
  const byKey = new Map<string, SettingSpec>();
  for (const spec of specs) byKey.set(spec.key, spec);

  const problems: ValidationProblem[] = [];
  const values = new Map<string, SettingValue>();

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    return {
      ok: false,
      problems: [
        problem(PATCH_SCOPE, "empty_patch", "No settings were supplied, so there is nothing to change."),
      ],
    };
  }

  for (const key of keys) {
    const spec = byKey.get(key);
    if (spec === undefined) {
      problems.push(problem(key, "unknown_key", `"${key}" is not a configurable setting.`));
      continue;
    }
    if (spec.policy === "RESTART_REQUIRED") {
      problems.push(
        problem(
          key,
          "not_mutable",
          `${spec.label} is deployment configuration and cannot be changed at runtime.`,
        ),
      );
      continue;
    }
    const checked = validateOne(spec, patch[key]);
    if (checked.ok) values.set(key, checked.value);
    else problems.push(checked.problem);
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, values };
}
