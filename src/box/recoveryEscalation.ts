/**
 * BOUNDED ESCALATION FOR RECOVERY THAT STAYS UNRESOLVED TOO LONG.
 *
 * ── WHAT THIS IS, AND EMPHATICALLY IS NOT ────────────────────────────────────────────────────
 *
 * This is observability and operator alerting. It is NOT permission to reverse a position because a
 * timer expired. Nothing here decides to flatten, cancel or unwind anything: the only outputs are a
 * boolean, some counts, an age, and a readiness blocker carrying them.
 *
 * ── WHY IT ADDS NO NEW ENTRY ENFORCEMENT ─────────────────────────────────────────────────────
 *
 * Every state this module treats as unresolved recovery ALREADY blocks new entry, in the authoritative
 * place — `BoxOrderManager.entryBlockReasonAfterControls`, which `submit()` reaches only under
 * `purpose === "ENTRY"`:
 *
 *     !health.reconciliation_complete        -> entry waits for durable and broker state to agree
 *     unknownOrders > 0                      -> entry waits until they are resolved
 *     unattendedWorkingOrders > 0            -> entry waits for final quantities to settle
 *     recoveryActive                         -> entry waits until exposure is resolved
 *     isCrashRecoveryEntryQuarantined()      -> entry waits for unresolved state to reconcile
 *     residualLegs > maxResidualLegs         -> entry waits until they clear
 *
 * So adding a second entry gate here would be duplicate, and worse: two gates for one condition can
 * disagree, and the operator then cannot tell which one is in force. This module therefore reports a
 * MORE PRECISE REASON for a refusal that is already happening, and deliberately does not become the
 * thing that causes it.
 *
 * The distinction matters because `operationalReadiness()` is consumed only by `getStatus()` and the
 * runtime-status projection — it reports and does not enforce. A reader who assumed otherwise would
 * be wrong about this module specifically, which is why it is stated here rather than implied.
 *
 * ── AGE, AND NOT PRETENDING TO MORE PRECISION THAN EXISTS ────────────────────────────────────
 *
 * Two sources, and which one is in play is reported rather than blurred:
 *
 *   `durable_residual_created_at` — `ResidualLegExposure.created_at` is a wall-clock stamp written
 *     when the residual was recorded and deliberately PRESERVED when a shrunken residual is written
 *     back, so it is the genuine "unresolved since" instant. It is durable, so this age SURVIVES A
 *     RESTART: a process that comes back up to the same residual reports the original age, not zero.
 *
 *   `process_local_first_observed` — the other unresolved states (unknown orders, unattended working
 *     orders, incomplete reconciliation) carry no durable timestamp anywhere in the schema. Their age
 *     is measured from when THIS process first observed the condition, and therefore RESETS ON
 *     RESTART. That is a real limitation, not a rounding error: a crash loop could keep resetting it.
 *     Inventing durable persistence for it was out of scope, and reporting a made-up start instant
 *     would be worse than reporting an honest source label.
 *
 * Wall clock is used throughout, never mixed with monotonic. The durable stamp is wall clock by
 * necessity, and comparing a monotonic reading against it would be meaningless.
 *
 * ── BOUNDED ──────────────────────────────────────────────────────────────────────────────────
 *
 * Derived on demand from state that already exists; nothing is accumulated here. Counts are integers,
 * and attempt identifiers are capped at five and sorted, so neither the payload nor any metric label
 * derived from it can grow with the number of attempts.
 */

/** The stable machine-readable reason. Distinct from ordinary unresolved recovery, deliberately. */
export const RECOVERY_ESCALATION_TIMEOUT = "recovery_escalation_timeout";

/** How many attempt identifiers a diagnostic may carry. Small, fixed, and sorted for determinism. */
export const MAX_ESCALATION_ATTEMPT_SAMPLE = 5;

/** Where the reported age came from — reported so no caller has to guess its restart semantics. */
export type RecoveryAgeSource =
  | "durable_residual_created_at"
  | "process_local_first_observed"
  | "none";

export interface RecoveryEscalationInput {
  /** Wall-clock now, matching the durable `created_at` domain. */
  readonly nowWall: number;
  /** Threshold in ms. `0` disables escalation entirely (the condition is still reported). */
  readonly escalateAfterMs: number;
  /** Oldest `ResidualLegExposure.created_at` across unresolved residuals, or null when there are none. */
  readonly oldestResidualCreatedAtWall: number | null;
  /** When THIS process first saw any unresolved state, for the non-durable half. Null when clear. */
  readonly firstObservedUnresolvedAtWall: number | null;
  readonly residualLegCount: number;
  readonly unknownOrderCount: number;
  readonly unattendedWorkingOrderCount: number;
  readonly reconciliationComplete: boolean;
  readonly recoveryActive: boolean;
  /** Crash-only exposure exists but its durable recovery boundary is unavailable. */
  readonly crashRecoveryQuarantined: boolean;
  /** The residual projection could not be READ, so nothing can be confirmed resolved. */
  readonly residualStateUnknown: boolean;
  /** Attempt ids with unresolved residual exposure. Capped and sorted by this module. */
  readonly residualAttemptIds: readonly string[];
}

export interface RecoveryEscalation {
  /** Is anything unresolved at all? True well before the threshold. */
  readonly unresolved: boolean;
  /** Has unresolved recovery exceeded the threshold? */
  readonly escalated: boolean;
  /** Age of the oldest unresolved thing, or null when nothing is unresolved. */
  readonly oldestRecoveryAgeMs: number | null;
  readonly ageSource: RecoveryAgeSource;
  /** How many distinct unresolved CONDITIONS hold (not how many orders). Bounded by the list above. */
  readonly unresolvedRecoveryCount: number;
  readonly unresolvedResidualLegCount: number;
  readonly unknownOrderCount: number;
  readonly reconciliationRequired: boolean;
  /** At most `MAX_ESCALATION_ATTEMPT_SAMPLE`, sorted. Never the full set. */
  readonly sampleAttemptIds: readonly string[];
  /** `RECOVERY_ESCALATION_TIMEOUT` once escalated, else null. */
  readonly reason: string | null;
}

/**
 * Derive the escalation view. Pure and total: no clock, no storage, no side effects.
 *
 * Because it is derived rather than stored, cleanup is automatic — when the underlying state resolves,
 * the inputs go quiet and `unresolved`/`escalated` become false in the same call. There is no sticky
 * latch to clear and no way for a stale escalation to outlive the condition that caused it.
 */
export function deriveRecoveryEscalation(input: RecoveryEscalationInput): RecoveryEscalation {
  const conditions = [
    input.residualLegCount > 0,
    input.unknownOrderCount > 0,
    input.unattendedWorkingOrderCount > 0,
    !input.reconciliationComplete,
    input.recoveryActive,
    input.crashRecoveryQuarantined,
    input.residualStateUnknown,
  ];
  const unresolvedRecoveryCount = conditions.filter(Boolean).length;
  const unresolved = unresolvedRecoveryCount > 0;

  /*
   * PREFER THE DURABLE STAMP. When a residual exists its `created_at` is the true unresolved-since
   * instant and survives restart, so it wins over the process-local mark even if the mark is older —
   * the mark can only ever be later than the real start, never earlier.
   */
  let oldestRecoveryAgeMs: number | null = null;
  let ageSource: RecoveryAgeSource = "none";
  if (unresolved) {
    if (input.oldestResidualCreatedAtWall !== null) {
      ageSource = "durable_residual_created_at";
      oldestRecoveryAgeMs = Math.max(0, input.nowWall - input.oldestResidualCreatedAtWall);
    } else if (input.firstObservedUnresolvedAtWall !== null) {
      ageSource = "process_local_first_observed";
      oldestRecoveryAgeMs = Math.max(0, input.nowWall - input.firstObservedUnresolvedAtWall);
    }
  }

  const escalated =
    unresolved &&
    input.escalateAfterMs > 0 &&
    oldestRecoveryAgeMs !== null &&
    oldestRecoveryAgeMs >= input.escalateAfterMs;

  return {
    unresolved,
    escalated,
    oldestRecoveryAgeMs,
    ageSource,
    unresolvedRecoveryCount,
    unresolvedResidualLegCount: input.residualLegCount,
    unknownOrderCount: input.unknownOrderCount,
    reconciliationRequired: !input.reconciliationComplete,
    sampleAttemptIds: [...new Set(input.residualAttemptIds)].sort().slice(0, MAX_ESCALATION_ATTEMPT_SAMPLE),
    reason: escalated ? RECOVERY_ESCALATION_TIMEOUT : null,
  };
}

/** A readiness blocker, mirrored locally so this module imports nothing. */
export interface RecoveryEscalationBlocker {
  readonly code: typeof RECOVERY_ESCALATION_TIMEOUT;
  readonly scope: "entry";
  readonly detail: string;
}

/**
 * The escalation as an entry-scoped readiness blocker, or null.
 *
 * `scope: "entry"` and nothing else: the readiness scope filter cannot select an entry-scoped blocker
 * for the reduction verdict, so this cannot reach `exposure_management`. It exists to give an operator
 * a precise reason and the numbers behind it — the refusal itself is already happening in the order
 * manager, for the underlying state rather than for the timer.
 *
 * NOTE ON THE CODE NAME. `operationalReadiness` also copies any blocker whose code contains
 * "recovery" into `reconciliation.blockers`. That is intended here: an unresolved recovery escalation
 * belongs in the reconciliation view.
 *
 * The counts travel in `detail` rather than as dedicated status fields because
 * `operational-readiness.schema.json` is closed at the root AND at `exposure_management`, so a new
 * field is a contract version bump coordinated across both repositories. That is deliberately not
 * bundled into a safety commit; the detail string carries the same bounded information today.
 */
export function recoveryEscalationBlocker(
  escalation: RecoveryEscalation,
  /**
   * Optional one-sentence economic size of the unresolved residual exposure (§12).
   *
   * Appended rather than made a status field of its own because
   * `operational-readiness.schema.json` is closed at the root AND at `exposure_management`, so a new
   * field is a contract version bump across two repositories. This is the point where an operator most
   * needs the number — recovery has been stuck long enough to warrant a decision, and "3 residual
   * legs" does not say whether that decision is urgent.
   */
  residualSummary?: string | null,
): RecoveryEscalationBlocker | null {
  if (!escalation.escalated) return null;
  const seconds = Math.floor((escalation.oldestRecoveryAgeMs ?? 0) / 1000);
  const restartNote =
    escalation.ageSource === "durable_residual_created_at"
      ? "measured from the residual's durable created_at, so this age survives a restart"
      : "measured from when this process first observed the condition, so it RESET at the last restart";
  const sample =
    escalation.sampleAttemptIds.length > 0
      ? ` Affected attempts (first ${escalation.sampleAttemptIds.length}): ${escalation.sampleAttemptIds.join(", ")}.`
      : "";
  return {
    code: RECOVERY_ESCALATION_TIMEOUT,
    scope: "entry",
    detail:
      `Recovery has been unresolved for ${seconds}s (${restartNote}). ` +
      `${escalation.unresolvedRecoveryCount} unresolved condition(s): ` +
      `${escalation.unresolvedResidualLegCount} residual leg(s), ${escalation.unknownOrderCount} ` +
      `unknown order(s), reconciliation ${escalation.reconciliationRequired ? "INCOMPLETE" : "complete"}.` +
      `${sample}${residualSummary ? ` ${residualSummary}` : ""} This is an ALERT, not an instruction: ` +
      `nothing is flattened or reversed because a timer expired. New entry is already refused for the ` +
      `underlying state; exits, protective cancels, emergency residual flattening, reconciliation and ` +
      `broker-state refresh all continue.`,
  };
}
