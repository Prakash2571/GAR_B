/**
 * LIVE MUTATION SAFETY — may this change be applied, in this state, right now?
 *
 * Pure decisions only: every fact arrives in `SystemState`, so the same predicate that runs in
 * production runs in a test without an engine, a broker or a database.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE INVARIANT THIS MODULE MUST NEVER BREAK
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here can block risk REDUCTION, and that is a structural property rather than a rule this
 * file remembers to follow: this module decides whether a CONFIGURATION WRITE is permitted. It is
 * never consulted on an order path. Exit, protective cancellation, emergency residual flatten,
 * reconciliation-required reduction and recovery/unwind do not call it and cannot be refused by it.
 *
 * The codebase already earned that separation the hard way, and the comments recording it are worth
 * honouring: `orderManager.exposureReductionBlockReason` documents a defect where turning off
 * `box_live_order_enabled` silently disabled every reduction path at once, with
 * `cancelWorkingBoxOrders()` returning an empty SUCCESS. The response was to split "do not take new
 * exposure" from "may shed exposure". Every setting registered in this subsystem is consumed on an
 * ENTRY-only path for the same reason — `capitalBlockReason` is reached only for `purpose === "ENTRY"`,
 * the operator blocklist has no counterpart in `coordinateExit`, and the inventory ceiling is
 * annotated "ENTRY ONLY. A full inventory is never a reason exposure cannot be reduced."
 *
 * `tests/operatorConfig/exitInvariant.test.mjs` asserts this against the registry rather than trusting
 * the prose.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY REFUSALS ARE NAMED, AND WHY NOTHING IS SILENTLY DEFERRED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A refusal returns specific {@link Blocker}s. A change is never partially applied, and never quietly
 * stored "for later" unless the setting's policy is explicitly `NEXT_SESSION` — in which case the
 * deferral is the documented behaviour and is reported as `takesEffect: "next_arm"`, not hidden.
 */

import { isSafer } from "./precedence.js";
import type {
  Blocker,
  MutationPolicy,
  SettingSpec,
  SettingValue,
  SystemState,
  TakesEffect,
} from "./types.js";

export type MutationDecision =
  | { readonly allowed: true; readonly takesEffect: TakesEffect; readonly tightening: boolean }
  | { readonly allowed: false; readonly blockers: readonly Blocker[] };

/**
 * FLAT: no exposure, nothing in flight, nothing unreconciled.
 *
 * All five terms are required. `openBoxes === 0` alone is not flat — a residual leg is real exposure
 * that simply never became a Box, a working order can still fill, an in-flight execution may be
 * mid-entry, and unreconciled state means the deployment does not yet know what it owns. Widening a
 * limit against any of those is widening against an unknown position.
 */
export function isFlat(state: SystemState): boolean {
  return (
    state.openBoxes === 0 &&
    state.residualLegs === 0 &&
    state.workingOrders === 0 &&
    state.inFlightExecutions === 0 &&
    state.reconciliationClean
  );
}

/** The specific reasons `state` is not flat, so a refusal can say which one applies. */
export function notFlatBlockers(state: SystemState): Blocker[] {
  const blockers: Blocker[] = [];
  if (state.openBoxes > 0) {
    blockers.push({
      code: "open_box",
      message: `${state.openBoxes} open Box position(s). This change requires the system to be flat.`,
    });
  }
  if (state.residualLegs > 0) {
    blockers.push({
      code: "residual_exposure",
      message: `${state.residualLegs} unresolved residual leg(s) still carry exposure.`,
    });
  }
  if (state.workingOrders > 0) {
    blockers.push({
      code: "working_orders",
      message: `${state.workingOrders} working order(s) could still fill.`,
    });
  }
  if (state.inFlightExecutions > 0) {
    blockers.push({
      code: "in_flight_execution",
      message: `${state.inFlightExecutions} execution(s) are in flight.`,
    });
  }
  if (!state.reconciliationClean) {
    blockers.push({
      code: "reconciliation_pending",
      message: "Reconciliation is not clean, so the position this deployment owns is not yet proven.",
    });
  }
  return blockers;
}

/**
 * Is the session "armed" for the purposes of a widening check?
 *
 * Either operator entry permission OR an armed trading session counts. They are different planes —
 * `entryArmed` is the live-order permission, `sessionArmed` means ceilings have been snapshotted — and
 * widening authority under either is the thing being prevented, so the test is a disjunction rather
 * than requiring both.
 */
export function isArmed(state: SystemState): boolean {
  return state.entryArmed || state.sessionArmed;
}

/** Where an accepted change lands, given the policy. */
function effectPoint(policy: MutationPolicy): TakesEffect {
  if (policy === "NEXT_SESSION") return "next_arm";
  if (policy === "FLAT_AND_DISARMED") return "immediately";
  return "next_candidate";
}

/**
 * Decide whether `current → requested` may be applied now.
 *
 * `current` must be the EFFECTIVE value, not the configured one. Judging a tightening against a
 * configured value that a deployment ceiling is already overriding would let an operator "tighten"
 * from a number that was never in force.
 */
export function evaluateMutation(args: {
  readonly spec: SettingSpec;
  readonly current: SettingValue;
  readonly requested: SettingValue;
  readonly state: SystemState;
  /** An explicit deployment bound, when the setting declares one and env set it. */
  readonly deploymentBound?: SettingValue | null;
}): MutationDecision {
  const { spec, current, requested, state } = args;
  const blockers: Blocker[] = [];

  // ── 1. Deployment configuration is never writable through this API ──────────────────────────
  if (spec.policy === "RESTART_REQUIRED") {
    return {
      allowed: false,
      blockers: [
        {
          code: "restart_required",
          message: `${spec.label} is deployment configuration. It is shown for reference and can only be changed in the deployment environment.`,
        },
      ],
    };
  }

  const tightening = isSafer(spec, current, requested);
  const widening = !tightening && current !== requested;

  // ── 2. Role. A risk-increasing change needs full admin, not merely trade permission ─────────
  //
  // Checked before the state gates so an under-privileged operator is told the real reason rather
  // than being sent to flatten the book first and refused anyway.
  if (widening && spec.requiresFullAdmin && state.operatorRole !== "full") {
    blockers.push({
      code: "full_admin_required",
      message: `Raising ${spec.label} widens what the engine may risk, so it requires full administrator access.`,
    });
  }

  // ── 3. The deployment ceiling/floor is absolute ─────────────────────────────────────────────
  //
  // REFUSED, not clamped. Silently storing 150,000 while enforcing 120,000 would leave the UI
  // truthfully reporting a configured value that has no effect, which is how an operator comes to
  // believe a limit is in force when it is not.
  if (args.deploymentBound !== undefined && args.deploymentBound !== null && widening) {
    const bound = args.deploymentBound;
    const overshoots =
      typeof bound === "number" && typeof requested === "number"
        ? spec.containment === "ceiling"
          ? isSafer(spec, bound, requested) === false && requested !== bound && exceedsCeiling(bound, requested, spec)
          : false
        : false;
    if (overshoots) {
      blockers.push({
        code: "deployment_bound",
        message: `${spec.label} is capped at ${String(bound)} by this deployment's ${spec.envVar}. A runtime setting can lower it but never raise it.`,
      });
    }
  }

  // ── 4. A fault-injecting paper profile must never be selectable in live ─────────────────────
  if (
    spec.forbiddenValuesInLive !== undefined &&
    state.executionMode === "live" &&
    typeof requested === "string" &&
    spec.forbiddenValuesInLive.includes(requested)
  ) {
    blockers.push({
      code: "forbidden_in_live",
      message: `${spec.label} cannot be set to "${requested}" while the deployment is in live execution mode.`,
    });
  }

  // ── 5. The policy gates ─────────────────────────────────────────────────────────────────────
  if (spec.policy === "FLAT_AND_DISARMED") {
    if (isArmed(state)) {
      blockers.push({
        code: "session_armed",
        message: `${spec.label} can only be changed while the live session is disarmed.`,
      });
    }
    blockers.push(...notFlatBlockers(state));
  } else if (spec.policy === "TIGHTEN_ONLY_WHILE_ARMED" && isArmed(state) && widening) {
    // The headline rule: while armed, this setting may only move in the safer direction. The
    // risk-increasing direction is not merely deferred — it is refused, with the route to it named.
    blockers.push({
      code: "widening_while_armed",
      message: `${spec.label} may only be made more restrictive while the session is armed. To widen it, disarm the session and flatten any open exposure.`,
    });
    if (!isFlat(state)) blockers.push(...notFlatBlockers(state));
  }

  if (blockers.length > 0) return { allowed: false, blockers };
  return { allowed: true, takesEffect: effectPoint(spec.policy), tightening };
}

/**
 * Does `requested` exceed a `ceiling` bound, accounting for `0 = unlimited`?
 *
 * Separated out because the `0` case inverts the comparison: a requested `0` on an
 * unlimited-capable ceiling is the LEAST restrictive value possible, so it overshoots any finite
 * bound even though `0 < bound` numerically.
 */
function exceedsCeiling(bound: number, requested: number, spec: SettingSpec): boolean {
  const unlimited = spec.zeroMeans === "unlimited";
  const boundCmp = unlimited && bound === 0 ? Number.POSITIVE_INFINITY : bound;
  const reqCmp = unlimited && requested === 0 ? Number.POSITIVE_INFINITY : requested;
  return reqCmp > boundCmp;
}
