/**
 * THE WIRE PROJECTION — snapshot + specs + state → the `operator-config` contract shape.
 *
 * Pure, and separate from the route on purpose: the interesting decisions (what is mutable right now,
 * which blockers apply, what the armed session is actually bound by) are all made here, so they can be
 * exercised against the real JSON-Schema without an HTTP server, a database or an engine. The route
 * becomes a thin adapter that gathers facts and serialises this.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THREE VALUES ARE ALWAYS SENT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `configured_value` is what the operator asked for. `effective_value` is what the engine enforces.
 * `default_value` is the code default. They are all sent, always, because they diverge in the case
 * that matters most: an explicitly-set deployment ceiling clamping an operator's figure. A UI given
 * only one number would display a limit that is not in force — and on a capital cap that is the most
 * dangerous thing this surface could do. `source: "runtime_clamped_by_env"` and
 * `clamped_by_deployment: true` name the situation so it cannot be rendered as agreement.
 *
 * `session_snapshot_value` is the fourth value, and it exists for the same reason in the session
 * plane. A NEXT_SESSION setting's armed ceiling was FROZEN at arm time by
 * `tradingSession.armSession()`, so a newly configured attempt budget must never be presented as
 * though the running session were bound by it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY ABSENT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * No secret, no identity value, no token, no session cookie. Only settings whose environment variable
 * is classified plain `config` are registrable at all (see `assertNoSensitiveKeys` in ./registry.ts),
 * `env_var` carries a NAME and never a value, and the actor is always a ROLE. The `deployment` block
 * is read-only: it reports the live-capability gates so an operator can see the ceiling, and nothing
 * in it is writable by any runtime path.
 */

import { evaluateMutation } from "./policy.js";
import type { ConfigSnapshot } from "./snapshot.js";
import type { Blocker, SettingSpec, SettingValue, SystemState } from "./types.js";

/** Env/deployment-owned capability. Every field is display-only. */
export interface DeploymentView {
  readonly executionMode: string;
  readonly liveTradingEnabled: boolean;
  readonly zerodhaLiveTradingEnabled: boolean;
  readonly dhanLiveTradingEnabled: boolean;
  readonly shadowModeEnabled: boolean;
  readonly executionCoordinatorEnabled: boolean;
  /** The backend's own paper/live verdict. The UI must not derive its own. */
  readonly liveCapable: boolean;
  readonly region: string | null;
  readonly activeBroker: string | null;
}

/** One entry of the append-only audit trail, already projected by the repository. */
export interface ChangeView {
  readonly changedAt: string;
  readonly actorRole: string | null;
  readonly settingKey: string;
  readonly previousConfigured: SettingValue | null;
  readonly newConfigured: SettingValue | null;
  readonly previousEffective: SettingValue | null;
  readonly newEffective: SettingValue | null;
  readonly mutationPolicy: string;
  readonly newSource: string;
  readonly sessionId: string | null;
  readonly reason: string | null;
  readonly configVersion: number;
}

export interface ProjectArgs {
  readonly snapshot: ConfigSnapshot;
  readonly specs: readonly SettingSpec[];
  readonly state: SystemState;
  readonly deployment: DeploymentView;
  /** Per-key provenance of the persisted row, when one exists. */
  readonly rowMeta: ReadonlyMap<string, { readonly updatedAt: string | null; readonly updatedBy: string | null }>;
  /**
   * The ceilings the ARMED session is actually bound by, snapshotted at arm time. Empty when no
   * session is armed. Keyed by domain key.
   */
  readonly sessionSnapshot: ReadonlyMap<string, SettingValue>;
  readonly recentChanges: readonly ChangeView[];
}

/**
 * Can this setting be changed right now, and if not, why not?
 *
 * Asked against a HYPOTHETICAL widening rather than a specific requested value, because the UI needs
 * to know "is this field editable at all" before the operator has typed anything. A setting that is
 * tighten-only while armed is therefore reported as mutable — it genuinely is, in the safe direction —
 * and the blockers explain the restriction. The authoritative per-value decision still happens on
 * PATCH; this is the affordance, not the enforcement.
 */
function mutability(
  spec: SettingSpec,
  effective: SettingValue,
  state: SystemState,
  deploymentBound: SettingValue | null,
): { mutable: boolean; blockers: readonly Blocker[] } {
  if (spec.policy === "RESTART_REQUIRED") {
    return {
      mutable: false,
      blockers: [
        {
          code: "restart_required",
          message: `${spec.label} is deployment configuration and is shown for reference only.`,
        },
      ],
    };
  }

  // Probe with the value itself: this asks "does the STATE permit a change at all", independent of
  // direction, which is what an editability affordance means.
  const probe = evaluateMutation({
    spec,
    current: effective,
    requested: effective,
    state,
    deploymentBound,
  });

  if (spec.policy === "FLAT_AND_DISARMED") {
    // For these, state alone decides, so the probe's verdict is the answer.
    const decided = evaluateMutation({
      spec,
      // A deliberately different value, so the policy's state gates are actually reached rather than
      // short-circuited by "nothing is changing".
      current: effective,
      requested: flip(spec, effective),
      state,
      deploymentBound: null,
    });
    return decided.allowed
      ? { mutable: true, blockers: [] }
      : { mutable: false, blockers: decided.blockers };
  }

  if (spec.policy === "TIGHTEN_ONLY_WHILE_ARMED" && (state.entryArmed || state.sessionArmed)) {
    return {
      mutable: true,
      blockers: [
        {
          code: "tighten_only_while_armed",
          message: `${spec.label} may only be made more restrictive while the session is armed. Widening it requires the system to be flat and the session disarmed.`,
        },
      ],
    };
  }

  return probe.allowed ? { mutable: true, blockers: [] } : { mutable: false, blockers: probe.blockers };
}

/** A different-but-valid value, used only to drive the state gates in {@link mutability}. */
function flip(spec: SettingSpec, value: SettingValue): SettingValue {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") {
    const max = spec.max ?? value + 1;
    return value === max ? Math.max(spec.min ?? 0, value - 1) : value + 1;
  }
  const choices = spec.enumValues ?? [];
  return choices.find((c) => c !== value) ?? value;
}

/** Project the whole configuration into the contract shape. Snake_case, because the wire is. */
export function projectOperatorConfig(args: ProjectArgs): Record<string, unknown> {
  const settings = args.specs.map((spec) => {
    const r = args.snapshot.resolved.get(spec.key);
    if (r === undefined) {
      throw new Error(`[operatorConfig] snapshot is missing "${spec.key}" — it cannot be projected.`);
    }
    const { mutable, blockers } = mutability(spec, r.effective, args.state, r.deploymentBound);
    const meta = args.rowMeta.get(spec.key);

    // Non-null ONLY for a session-snapshotted setting while a session is armed. Anything else would
    // invite the UI to show a frozen value that does not exist.
    const snapshotValue =
      spec.policy === "NEXT_SESSION" && args.state.sessionArmed
        ? (args.sessionSnapshot.get(spec.key) ?? null)
        : null;

    return {
      key: spec.key,
      label: spec.label,
      description: spec.description,
      category: spec.category,
      type: spec.type,
      unit: spec.unit,
      configured_value: r.configured,
      effective_value: r.effective,
      default_value: r.codeDefault,
      source: r.source,
      deployment_bound: r.deploymentBound,
      clamped_by_deployment: r.clampedByDeployment,
      min: spec.min ?? null,
      max: spec.max ?? null,
      enum_values: spec.enumValues === undefined ? null : [...spec.enumValues],
      zero_means: spec.zeroMeans ?? null,
      mutable,
      mutation_policy: spec.policy,
      takes_effect: spec.takesEffect,
      // Derived from the policy rather than stored twice, so the two can never disagree.
      requires_flat: spec.policy === "FLAT_AND_DISARMED",
      requires_disarmed: spec.policy === "FLAT_AND_DISARMED",
      dangerous: spec.dangerous,
      requires_full_admin: spec.requiresFullAdmin,
      session_snapshot_value: snapshotValue,
      blockers: blockers.map((b) => ({ code: b.code, message: b.message })),
      env_var: spec.envVar,
      caveat: spec.caveat ?? null,
      updated_at: meta?.updatedAt ?? null,
      updated_by: meta?.updatedBy ?? null,
    };
  });

  return {
    version: args.snapshot.version,
    updated_at: args.snapshot.updatedAt,
    operator_role: args.state.operatorRole,
    deployment: {
      execution_mode: args.deployment.executionMode,
      live_trading_enabled: args.deployment.liveTradingEnabled,
      zerodha_live_trading_enabled: args.deployment.zerodhaLiveTradingEnabled,
      dhan_live_trading_enabled: args.deployment.dhanLiveTradingEnabled,
      shadow_mode_enabled: args.deployment.shadowModeEnabled,
      execution_coordinator_enabled: args.deployment.executionCoordinatorEnabled,
      live_capable: args.deployment.liveCapable,
      region: args.deployment.region,
      active_broker: args.deployment.activeBroker,
    },
    state: {
      entry_armed: args.state.entryArmed,
      session_armed: args.state.sessionArmed,
      open_boxes: args.state.openBoxes,
      residual_legs: args.state.residualLegs,
      working_orders: args.state.workingOrders,
      in_flight_executions: args.state.inFlightExecutions,
      reconciliation_clean: args.state.reconciliationClean,
      flat:
        args.state.openBoxes === 0 &&
        args.state.residualLegs === 0 &&
        args.state.workingOrders === 0 &&
        args.state.inFlightExecutions === 0 &&
        args.state.reconciliationClean,
    },
    settings,
    recent_changes: args.recentChanges.map((c) => ({
      changed_at: c.changedAt,
      actor_role: c.actorRole,
      setting_key: c.settingKey,
      previous_configured_value: c.previousConfigured,
      new_configured_value: c.newConfigured,
      previous_effective_value: c.previousEffective,
      new_effective_value: c.newEffective,
      mutation_policy: c.mutationPolicy,
      new_source: c.newSource,
      session_id: c.sessionId,
      reason: c.reason,
      config_version: c.configVersion,
    })),
  };
}

/** Project a refusal into the contract shape. `applied` is a constant, never a computed flag. */
export function projectRefusal(args: {
  readonly version: number;
  readonly reason:
    | "stale_version"
    | "validation_failed"
    | "policy_refused"
    | "forbidden"
    | "persistence_failed";
  readonly problems: readonly { readonly key: string; readonly code: string; readonly message: string }[];
}): Record<string, unknown> {
  if (args.problems.length === 0) {
    // A refusal with no stated problem is the silent refusal this surface forbids, so it is a
    // programming error rather than an empty array to be rendered.
    throw new Error("[operatorConfig] a refusal must name at least one problem.");
  }
  return {
    applied: false,
    version: args.version,
    reason: args.reason,
    problems: args.problems.map((p) => ({ key: p.key, code: p.code, message: p.message })),
  };
}
