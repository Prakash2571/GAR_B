/**
 * THE OPERATOR RUNTIME CONFIGURATION MODEL — types only, no behaviour.
 *
 * WHAT THIS SUBSYSTEM IS FOR
 *
 * `src/box/config.ts` parses 131 environment variables into one `BoxConfig` at boot. Most of them
 * describe the EXECUTION MODEL — reservation TTLs, transport pacing, queue internals, timeouts — and
 * belong to whoever deploys the process. A minority are genuine OPERATOR POLICY: the entry
 * threshold, the capital cap, the inventory ceiling, the coherence bounds. Those are the ones an
 * operator legitimately changes during a trading day, and today changing one means editing a server
 * `.env` and restarting.
 *
 * This subsystem gives that minority a durable, validated, audited home without moving the majority
 * anywhere. See `docs/OPERATOR_CONFIG_AUDIT.md` for the per-setting classification and the evidence
 * behind each policy choice.
 *
 * THE FOUR AUTHORITIES, KEPT SEPARATE ON PURPOSE
 *
 *   SECRETS              server only, never in this registry at all (see ./registry.ts guard)
 *   DEPLOYMENT CAPABILITY env only — BOX_EXECUTION_MODE, BOX_LIVE_TRADING_ENABLED and the two
 *                        per-broker live gates. Never registered here, only displayed.
 *   OPERATOR POLICY      this subsystem: PostgreSQL-persisted, backend-validated
 *   SESSION AUTHORITY    the arm-time snapshot in tradingSession.ts, which this must not disturb
 *
 * WHY THE DOMAIN KEY IS NOT THE ENV VAR NAME
 *
 * The frontend's model is `maxBoxCapitalRupees`, not `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES`. An operator
 * should not have to remember an environment variable to raise a capital limit, and tying the wire
 * format to an internal variable name would make every future rename a breaking API change. The env
 * var survives as a BOOTSTRAP input and as provenance, which is why `envVar` is still on the spec.
 *
 * ERASABLE SYNTAX ONLY
 *
 * No `enum`, no `namespace`, no parameter properties anywhere under `operatorConfig/`. These modules
 * are imported directly from source by `tests/operatorConfig/*.test.mjs` under
 * `node --experimental-strip-types`, which strips types but transforms nothing. String-literal unions
 * and `as const` objects do the work an enum would. `operatorConfigErasable.test.mjs` enforces this.
 */

/** Every value this subsystem can hold. Deliberately narrow — no objects, no arrays, no null. */
export type SettingValue = boolean | number | string;

/** How a value is parsed, validated and rendered. */
export type SettingType = "boolean" | "integer" | "number" | "enum";

/**
 * The unit, so the UI can format without hardcoding a per-key lookup.
 *
 * `milliseconds` exists rather than a generic `duration` because the backend's unit IS milliseconds
 * and the wire format must stay exact; the frontend may *display* 15000 as "15 s" but it sends
 * 15000 back.
 */
export type SettingUnit =
  | "rupees"
  | "milliseconds"
  | "seconds"
  | "minutes"
  | "count"
  | "ratio"
  | "percent"
  | "none";

/** Which screen a setting belongs on. Mirrors the frontend's Configuration tabs. */
export type SettingCategory = "strategy" | "risk" | "market_data" | "paper" | "universe" | "charges";

/**
 * WHEN a change may be applied. The heart of the safety model.
 *
 *   HOT_SAFE                  apply immediately; cannot widen risk in any state.
 *   TIGHTEN_ONLY_WHILE_ARMED  while armed, only a change in the SAFER direction is accepted; the
 *                             risk-increasing direction requires flat + disarmed.
 *   FLAT_AND_DISARMED         no open box, no residual exposure, no working orders, no in-flight
 *                             execution, reconciliation clean, session disarmed.
 *   NEXT_SESSION              store the configured value but never touch the armed snapshot. This
 *                             is what preserves the arm-time freeze in tradingSession.ts.
 *   RESTART_REQUIRED          read-only from the API; the change stays deployment-side.
 */
export type MutationPolicy =
  | "HOT_SAFE"
  | "TIGHTEN_ONLY_WHILE_ARMED"
  | "FLAT_AND_DISARMED"
  | "NEXT_SESSION"
  | "RESTART_REQUIRED";

/**
 * How an explicitly-set env value composes with a persisted runtime value.
 *
 * THIS IS THE "DO NOT BLINDLY LET THE DATABASE WIN" CONTROL, and it is the single most important
 * field on a spec.
 *
 *   replace  the env value is a DEFAULT. A runtime value supersedes it outright.
 *   ceiling  the env value is an ABSOLUTE DEPLOYMENT MAXIMUM. Effective = the stricter of the two.
 *            A runtime override may lower it and can never raise it.
 *   floor    the env value is an ABSOLUTE DEPLOYMENT MINIMUM. Effective = the stricter of the two.
 *            A runtime override may raise it and can never lower it.
 *
 * `ceiling`/`floor` apply ONLY when the env var was EXPLICITLY SET. An unset variable expresses no
 * deployment opinion, so the code default must not act as a ceiling — otherwise a deployment that
 * never mentioned a limit could never have it raised from the UI, which is not containment, it is an
 * accident. See `resolveSetting` in ./precedence.ts.
 */
export type Containment = "replace" | "ceiling" | "floor";

/**
 * Which direction of change REDUCES risk. Used to decide what "tighten" means per setting, because
 * it is not a property of the number.
 *
 * Raising `minExpectedNetProfit` is safer (fewer, better entries). Raising `maxOpenBoxes` is riskier
 * (more concurrent exposure). Both are "a bigger number".
 */
export type SafeDirection =
  | "lower_is_safer"
  | "higher_is_safer"
  | "enabled_is_safer"
  | "disabled_is_safer"
  | "neutral";

/**
 * What `0` means. `BOX_MAX_OPEN_BOXES=0` means UNLIMITED, not "no boxes".
 *
 * This is why ceiling composition cannot be a plain `Math.min`: `min(5, 0)` is 0, which would turn a
 * finite deployment limit into an unlimited one — precisely the migration hazard called out in the
 * audit. ./precedence.ts normalises `0` to `+Infinity` before comparing and back afterwards.
 */
export type ZeroMeaning = "value" | "unlimited" | "disabled";

/** When an accepted change becomes visible to the engine. Reported to the UI verbatim. */
export type TakesEffect = "immediately" | "next_candidate" | "next_arm" | "next_restart";

/**
 * Which layer supplied the effective value.
 *
 * `runtime_clamped_by_env` is the interesting one: the operator has configured a value, and an
 * explicit deployment ceiling/floor is overriding it. The UI must show both figures, because
 * "my setting is not in force and nothing said so" is the failure this whole provenance field
 * exists to prevent.
 */
export type SettingSource = "default" | "env" | "runtime" | "runtime_clamped_by_env";

/**
 * One runtime-configurable setting.
 *
 * `boxConfigField` names the `BoxConfig` field the resolved value is written onto, so the mapping
 * from this registry to the object the engine actually reads is declarative and testable rather than
 * a hand-written switch that can silently omit a key.
 */
export interface SettingSpec {
  /** Stable domain key. The wire format and the persisted identity. camelCase. */
  readonly key: string;
  /** The legacy/bootstrap environment variable. Provenance and backward compatibility. */
  readonly envVar: string;
  /** The `BoxConfig` field this resolves onto. */
  readonly boxConfigField: string;
  readonly category: SettingCategory;
  /** Human label, shown first in the UI. The env var appears only in an Advanced detail. */
  readonly label: string;
  /** What it controls, in an operator's terms. Rendered next to the control. */
  readonly description: string;
  readonly type: SettingType;
  readonly unit: SettingUnit;
  /** Inclusive bounds. Required for `integer`/`number`; enforced by ./validate.ts. */
  readonly min?: number;
  readonly max?: number;
  readonly enumValues?: readonly string[];
  readonly zeroMeans?: ZeroMeaning;
  readonly containment: Containment;
  readonly safeDirection: SafeDirection;
  readonly policy: MutationPolicy;
  readonly takesEffect: TakesEffect;
  /** Risk-increasing in at least one direction: the UI must confirm explicitly. */
  readonly dangerous: boolean;
  /** Risk-increasing changes require the `full` operator role, not merely `trade`. */
  readonly requiresFullAdmin: boolean;
  /** Only meaningful in a paper execution mode. */
  readonly paperOnly?: boolean;
  /** Only meaningful on the live path. */
  readonly liveOnly?: boolean;
  /** Enum values that must never be selected while `executionMode === "live"`. */
  readonly forbiddenValuesInLive?: readonly string[];
  /** Operator-facing caveat surfaced in the UI (e.g. Kite's 1-second timestamp precision). */
  readonly caveat?: string;
}

/**
 * The facts a mutation decision needs, gathered by the caller from the engine.
 *
 * Passed in rather than read, so ./policy.ts stays pure and the same predicate can be exercised by a
 * test without an engine, a broker or a database.
 */
export interface SystemState {
  readonly executionMode: string;
  /** Operator entry permission (`box_entry_enabled`). */
  readonly entryArmed: boolean;
  /** A trading session is armed, so ceilings have been snapshotted. */
  readonly sessionArmed: boolean;
  readonly openBoxes: number;
  readonly residualLegs: number;
  readonly workingOrders: number;
  readonly inFlightExecutions: number;
  readonly reconciliationClean: boolean;
  readonly operatorRole: "full" | "trade" | null;
}

/** A named reason a requested mutation was refused. Never a bare boolean. */
export interface Blocker {
  readonly code: string;
  readonly message: string;
}

/** The fully resolved state of one setting, as returned by GET and after a successful PATCH. */
export interface ResolvedSetting {
  readonly key: string;
  readonly codeDefault: SettingValue;
  /** What the operator has configured: runtime value if present, else env, else code default. */
  readonly configured: SettingValue;
  /** What the engine will actually enforce, after deployment containment. */
  readonly effective: SettingValue;
  readonly source: SettingSource;
  /** The explicit deployment bound, when one is set and the mode is ceiling/floor. */
  readonly deploymentBound: SettingValue | null;
  /** True when an operator-configured value is not in force because of `deploymentBound`. */
  readonly clampedByDeployment: boolean;
}

/** What the resolver is given for one setting. `*Present` distinguishes "absent" from "falsy". */
export interface ResolveInput {
  readonly envPresent: boolean;
  readonly envValue?: SettingValue;
  readonly runtimePresent: boolean;
  readonly runtimeValue?: SettingValue;
}
