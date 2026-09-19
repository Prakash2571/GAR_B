/**
 * THE IMMUTABLE, VERSIONED CONFIGURATION SNAPSHOT — the only thing execution code reads.
 *
 * WHY A SNAPSHOT AT ALL
 *
 * The hard performance requirement is that configuration must not add a database call to any market
 * tick, scanner candidate or broker order decision. So the durable store is consulted at boot and on
 * an operator mutation, and never on a hot path. Between mutations, every read is a synchronous map
 * lookup against a frozen object.
 *
 * WHY THIS IS A NEW LAYER RATHER THAN A CHANGE TO `BoxConfig`
 *
 * `BoxConfig` is deliberately mutable and deliberately shared by reference: `engine.applyTuning()`
 * assigns to its fields, and the scanner, simulator, gateway and coordinator all see the change
 * because they hold the same object. `Object.freeze`-ing `BoxConfig` would break the existing tuning
 * API outright. So this snapshot sits BESIDE it: the snapshot is the validated, audited source of
 * truth for operator settings, and applying one writes the resolved values onto the shared
 * `BoxConfig` exactly as `applyTuning` already does. Nothing downstream needs to change to read it.
 *
 * WHY THE VERSION IS A PLAIN COUNTER
 *
 * It exists for optimistic concurrency, not for history — the audit table owns history. A PATCH
 * carries the version it believes it is editing, and a mismatch is refused rather than merged, so two
 * operators (or two browser tabs) cannot silently overwrite each other. A monotonic integer is
 * sufficient and is trivially comparable, which matters because the FRONTEND also uses it to discard
 * a stale response that arrives after a newer one.
 *
 * WHY MISSING IS NEVER ZERO
 *
 * `buildSnapshot` resolves every registered key, always, from `CODE_DEFAULTS` upward. A key with no
 * runtime row and no env value still resolves — to its code default. There is no path where absence
 * produces `0`, which is the specific migration hazard that would turn an existing finite risk limit
 * into an unlimited one.
 */

import { resolveSetting } from "./precedence.js";
import type { ResolveInput, ResolvedSetting, SettingSpec, SettingValue } from "./types.js";

/** An immutable resolution of every registered setting, at one version. */
export interface ConfigSnapshot {
  readonly version: number;
  /** ISO-8601. Provenance for the UI, never used for ordering — the version is. */
  readonly updatedAt: string;
  /** Effective values, keyed by domain key. What the engine enforces. */
  readonly effective: ReadonlyMap<string, SettingValue>;
  /** Full per-setting resolution, including provenance and any deployment clamp. */
  readonly resolved: ReadonlyMap<string, ResolvedSetting>;
}

export interface BuildSnapshotArgs {
  readonly version: number;
  readonly updatedAt: string;
  readonly specs: readonly SettingSpec[];
  readonly codeDefaults: ReadonlyMap<string, SettingValue>;
  /**
   * Per-key env presence and parsed value. A key absent from this map means the environment said
   * nothing, which is different from an env value that happens to be falsy.
   */
  readonly envInputs: ReadonlyMap<string, { readonly present: boolean; readonly value?: SettingValue }>;
  /** Persisted operator overrides. A key absent from this map falls through — it is NOT zero. */
  readonly runtimeValues: ReadonlyMap<string, SettingValue>;
}

/**
 * Build a frozen snapshot.
 *
 * Throws if a registered spec has no code default, because a setting with no floor to fall back to
 * would resolve to `undefined` on a fresh deployment — and a missing risk limit must fail loudly at
 * boot rather than quietly become permissive.
 */
export function buildSnapshot(args: BuildSnapshotArgs): ConfigSnapshot {
  const effective = new Map<string, SettingValue>();
  const resolved = new Map<string, ResolvedSetting>();

  for (const spec of args.specs) {
    const codeDefault = args.codeDefaults.get(spec.key);
    if (codeDefault === undefined) {
      throw new Error(
        `[operatorConfig] setting "${spec.key}" has no code default. Every setting must have one, ` +
          `because a fresh deployment with no persisted row and no environment value would otherwise ` +
          `resolve it to undefined.`,
      );
    }
    const env = args.envInputs.get(spec.key);
    const hasRuntime = args.runtimeValues.has(spec.key);
    const input: ResolveInput = {
      envPresent: env?.present === true,
      ...(env?.value === undefined ? {} : { envValue: env.value }),
      runtimePresent: hasRuntime,
      ...(hasRuntime ? { runtimeValue: args.runtimeValues.get(spec.key) as SettingValue } : {}),
    };
    const r = resolveSetting(spec, codeDefault, input);
    resolved.set(spec.key, Object.freeze(r));
    effective.set(spec.key, r.effective);
  }

  return Object.freeze({
    version: args.version,
    updatedAt: args.updatedAt,
    // Frozen maps are still mutable, so hand out read-only views by contract and never leak the
    // originals. The maps are not re-exposed anywhere that could call `.set`.
    effective: effective as ReadonlyMap<string, SettingValue>,
    resolved: resolved as ReadonlyMap<string, ResolvedSetting>,
  });
}

/**
 * Read one effective value. The hot-path accessor.
 *
 * Throws on an unregistered key rather than returning `undefined`, so a typo in execution code is a
 * crash at first use instead of a silently permissive limit.
 */
export function effectiveValue(snapshot: ConfigSnapshot, key: string): SettingValue {
  const value = snapshot.effective.get(key);
  if (value === undefined) {
    throw new Error(`[operatorConfig] "${key}" is not a registered setting.`);
  }
  return value;
}

/** Typed accessor for a numeric setting. Throws if the setting is not numeric. */
export function effectiveNumber(snapshot: ConfigSnapshot, key: string): number {
  const value = effectiveValue(snapshot, key);
  if (typeof value !== "number") {
    throw new Error(`[operatorConfig] "${key}" is not numeric (got ${typeof value}).`);
  }
  return value;
}

/** Typed accessor for a boolean setting. Throws if the setting is not boolean. */
export function effectiveBoolean(snapshot: ConfigSnapshot, key: string): boolean {
  const value = effectiveValue(snapshot, key);
  if (typeof value !== "boolean") {
    throw new Error(`[operatorConfig] "${key}" is not boolean (got ${typeof value}).`);
  }
  return value;
}

/**
 * OPTIMISTIC CONCURRENCY: is this write based on a stale view of the configuration?
 *
 * A PATCH carries the version the client believes it is editing. If that is not the current version,
 * somebody else — another operator, another browser tab, or the same operator's earlier request —
 * has changed the configuration in between, and applying this write would silently discard their
 * change. So it is REFUSED and the caller re-reads.
 *
 * `expectedVersion === undefined` is treated as stale rather than as "force". A client that cannot
 * say what it is editing cannot be allowed to overwrite a risk limit, and making the permissive case
 * the default is how a version check comes to be bypassed everywhere.
 */
export function isStaleWrite(snapshot: ConfigSnapshot, expectedVersion: number | undefined): boolean {
  if (expectedVersion === undefined) return true;
  if (!Number.isInteger(expectedVersion)) return true;
  return expectedVersion !== snapshot.version;
}

/**
 * Produce the next snapshot after an accepted mutation.
 *
 * The version increments by exactly one, and the whole snapshot is rebuilt from inputs rather than
 * patched in place — so a derived value can never be left over from the previous version. This is the
 * same discipline `engine.applyTuning()` uses when it re-derives the gross prefilter from an immutable
 * baseline instead of adjusting the running value, which is what makes repeated application
 * idempotent and rollback exact.
 *
 * NEXT_SESSION settings are included here because the snapshot holds the CONFIGURED value that the
 * next arm will read. It is the trading-session record — not this snapshot — that binds an armed
 * session, so publishing a new value here cannot widen a session already armed.
 */
export function withMutations(
  snapshot: ConfigSnapshot,
  args: Omit<BuildSnapshotArgs, "version" | "updatedAt" | "runtimeValues"> & {
    readonly runtimeValues: ReadonlyMap<string, SettingValue>;
    readonly updatedAt: string;
  },
): ConfigSnapshot {
  return buildSnapshot({
    version: snapshot.version + 1,
    updatedAt: args.updatedAt,
    specs: args.specs,
    codeDefaults: args.codeDefaults,
    envInputs: args.envInputs,
    runtimeValues: args.runtimeValues,
  });
}
