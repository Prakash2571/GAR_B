/**
 * THE EXECUTION FUNNEL — outcome counts with EXPLICIT denominators.
 *
 * The problem this exists to prevent: a "success rate" with an unstated denominator.
 * "80% fill rate" is meaningless — 80% of what? Of candidates the scanner saw? Of
 * attempts that actually reached a broker? Those differ by orders of magnitude, and
 * the flattering one is always available to quote. So every ratio published here
 * carries the numerator AND the denominator it was computed from, and the stages are
 * strictly nested so a reader can see exactly where opportunities were lost.
 *
 * THE CHAIN (each stage is a subset of the one above it):
 *
 *   candidates_evaluated          every candidate the scanner priced
 *     └─ qualified_opportunities  passed the economic gate
 *         └─ attempts_admitted    passed every admission gate (coherence, capital,
 *                                 reservation, single-lot, entry arming)
 *             └─ attempts_submitted   at least ONE real broker POST occurred
 *                 └─ four_leg_completed_entries   all four legs confirmed filled
 *
 * The gap between `attempts_admitted` and `attempts_submitted` is the zero-POST
 * refusal population (`REFUSED_BEFORE_SUBMIT`) — genuinely free refusals that cost
 * nothing. Keeping them OUT of the submitted denominator is what stops a wave of
 * cheap local refusals from diluting the real broker-facing failure rate; keeping
 * them visible as their own count is what stops them from being hidden entirely.
 *
 * TWO KINDS OF SUCCESS, NEVER CONFLATED.
 *
 *   EXECUTION completion  — did the four-leg structure actually get built?
 *   ECONOMIC   outcome    — did we make money after every cost, including recovery?
 *
 * These are independent and both are published. A `FILLED_THEN_ECONOMICS_ABORT` is an
 * execution SUCCESS (all four legs filled) and an economic LOSS (round-trip spread
 * plus charges on four legs). Reporting only the first would look like a triumph;
 * reporting only the second would hide that the machinery worked. Recovery costs are
 * counted in the economic total, never excluded as "exceptional".
 *
 * PURE ACCOUNTING. This module counts what it is told and computes ratios. It never
 * decides, never rejects, never touches an order. Counters are fixed-cardinality
 * (no per-token or per-candidate labels) so the structure cannot grow unbounded.
 */

import type { BoxEntryOutcomeClass } from "./types.js";

/** Why an admitted attempt never reached a broker. Fixed, low-cardinality vocabulary. */
export type ZeroPostRefusalReason =
  | "coherence"
  | "capital"
  | "entry_guard"
  | "hedge_coverage"
  | "deadline"
  | "depth"
  | "ownership"
  | "other";

/** Why a submitted attempt did not become a four-leg box. */
export type SubmittedFailureReason =
  | "no_fill"
  | "partial_entry_unwound"
  | "partial_entry_residual"
  | "economics_abort_after_fill"
  /** All four legs filled but the Box could not be recorded; the exposure is retained. */
  | "filled_exposure_unrecorded"
  | "quarantined_unknown";

export interface FunnelRatio {
  /** The count that succeeded. */
  numerator: number;
  /** WHAT it is a fraction OF — never omitted, so the ratio cannot be misread. */
  denominator: number;
  /** null when the denominator is 0: an undefined ratio is reported as undefined, not as 0 or 1. */
  rate: number | null;
  /** Plain-language statement of the denominator, carried to the UI verbatim. */
  basis: string;
}

export interface ExecutionFunnelSnapshot {
  /* ---- the nested execution chain ---- */
  candidates_evaluated: number;
  qualified_opportunities: number;
  attempts_admitted: number;
  attempts_submitted: number;
  four_leg_completed_entries: number;

  /* ---- where admitted attempts were lost, by stage ---- */
  /** Admitted but ZERO broker POST. Cost nothing; broken out by cause. */
  zero_post_refusals: number;
  zero_post_by_reason: Record<ZeroPostRefusalReason, number>;
  /** Submitted but did not complete four legs, by cause. */
  submitted_failures: number;
  submitted_failures_by_reason: Record<SubmittedFailureReason, number>;

  /* ---- exposure and recovery, never hidden ---- */
  no_fill_cancellations: number;
  partial_entry_recoveries: number;
  /** Exposure still outstanding RIGHT NOW — a live gauge, not a cumulative count. */
  unresolved_exposure_open: number;
  /** Every attempt that ever ended holding unresolved exposure (cumulative). */
  unresolved_exposure_total: number;
  completed_exits: number;

  /* ---- economics, separate from execution ---- */
  /** Realised net P&L (₹) after ALL costs, including recovery and unwind charges. */
  realised_net_pnl: number;
  /** Recovery/unwind charges (₹) included in the figure above, shown so they cannot be hidden. */
  recovery_costs_included: number;
  /** Attempts whose realised economics were positive. */
  economically_profitable: number;
  /** Attempts whose realised economics were negative (includes successful-execution aborts). */
  economically_unprofitable: number;

  /* ---- explicit, denominator-carrying ratios ---- */
  ratios: {
    /** Of QUALIFIED opportunities, how many were admitted. */
    admission_rate: FunnelRatio;
    /** Of ADMITTED attempts, how many reached a broker at all. */
    submission_rate: FunnelRatio;
    /**
     * Of SUBMITTED attempts, how many completed four legs. This is the honest
     * "did the execution work" number: its denominator excludes free local
     * refusals but includes every attempt that touched a broker.
     */
    execution_completion_rate: FunnelRatio;
    /** Of COMPLETED four-leg entries, how many were economically profitable. */
    economic_success_rate: FunnelRatio;
    /** Of ADMITTED attempts, how many ended in unresolved exposure. */
    unresolved_exposure_rate: FunnelRatio;
  };
}

const ZERO_POST_REASONS: readonly ZeroPostRefusalReason[] = [
  "coherence", "capital", "entry_guard", "hedge_coverage", "deadline", "depth", "ownership", "other",
];
const SUBMITTED_FAILURE_REASONS: readonly SubmittedFailureReason[] = [
  "no_fill", "partial_entry_unwound", "partial_entry_residual", "economics_abort_after_fill",
  "filled_exposure_unrecorded", "quarantined_unknown",
];

function ratio(numerator: number, denominator: number, basis: string): FunnelRatio {
  return {
    numerator,
    denominator,
    // An undefined ratio stays null. Publishing 0 for "no attempts yet" would render
    // as a 0% success rate on a dashboard and read as failure rather than absence.
    rate: denominator > 0 ? numerator / denominator : null,
    basis,
  };
}

/**
 * Maps a terminal entry outcome onto the funnel.
 *
 * Driven by the SAME `BoxEntryOutcomeClass` the execution path already stamps on every
 * record, so the funnel cannot drift from what actually happened — there is no second,
 * parallel notion of "success" to disagree with.
 */
export class ExecutionFunnel {
  private candidatesEvaluated = 0;
  private qualifiedOpportunities = 0;
  private attemptsAdmitted = 0;
  private attemptsSubmitted = 0;
  private fourLegCompleted = 0;
  private zeroPost = 0;
  private zeroPostByReason: Record<ZeroPostRefusalReason, number> =
    Object.fromEntries(ZERO_POST_REASONS.map((r) => [r, 0])) as Record<ZeroPostRefusalReason, number>;
  private submittedFailures = 0;
  private submittedFailureByReason: Record<SubmittedFailureReason, number> =
    Object.fromEntries(SUBMITTED_FAILURE_REASONS.map((r) => [r, 0])) as Record<SubmittedFailureReason, number>;
  private noFillCancellations = 0;
  private partialEntryRecoveries = 0;
  private unresolvedOpen = 0;
  private unresolvedTotal = 0;
  private completedExits = 0;
  private realisedNetPnl = 0;
  private recoveryCosts = 0;
  private profitable = 0;
  private unprofitable = 0;

  /** One candidate priced by the scanner. The widest denominator. */
  recordCandidateEvaluated(count = 1): void {
    this.candidatesEvaluated += Math.max(0, count);
  }

  /** A candidate that passed the economic gate. */
  recordQualified(): void {
    this.qualifiedOpportunities++;
  }

  /** An attempt that passed EVERY admission gate and is about to be worked. */
  recordAdmitted(): void {
    this.attemptsAdmitted++;
  }

  /**
   * An admitted attempt that was refused with ZERO broker POSTs.
   *
   * Deliberately NOT counted in `attempts_submitted`: nothing reached a broker, so
   * including it would dilute the broker-facing completion rate with free refusals.
   * It IS counted here and by reason, so it is never invisible.
   */
  recordZeroPostRefusal(reason: ZeroPostRefusalReason): void {
    this.zeroPost++;
    this.zeroPostByReason[reason] = (this.zeroPostByReason[reason] ?? 0) + 1;
  }

  /** An attempt in which at least one real broker POST occurred. */
  recordSubmitted(): void {
    this.attemptsSubmitted++;
  }

  /**
   * A terminal entry outcome. `submitted` says whether any POST happened, which is what
   * decides which denominator this attempt belongs to.
   */
  recordEntryOutcome(args: {
    outcome: BoxEntryOutcomeClass;
    submitted: boolean;
    /** Realised net P&L (₹) once known, including recovery costs. */
    realisedNetPnl?: number | null;
    /** Recovery/unwind charges (₹) inside the figure above. */
    recoveryCost?: number | null;
    /** Whether this attempt left exposure still outstanding. */
    leftUnresolvedExposure?: boolean;
    /** Why a zero-POST refusal happened, when applicable. */
    zeroPostReason?: ZeroPostRefusalReason;
  }): void {
    const { outcome, submitted } = args;

    if (!submitted) {
      // Every non-submitted terminal outcome is a zero-POST refusal by definition.
      this.recordZeroPostRefusal(args.zeroPostReason ?? "other");
    } else {
      switch (outcome) {
        case "OPENED":
          this.fourLegCompleted++;
          break;
        case "NO_FILL":
          this.submittedFailures++;
          this.submittedFailureByReason.no_fill++;
          this.noFillCancellations++;
          break;
        case "PARTIAL_ENTRY_UNWOUND":
          this.submittedFailures++;
          this.submittedFailureByReason.partial_entry_unwound++;
          this.partialEntryRecoveries++;
          break;
        case "PARTIAL_ENTRY_RESIDUAL":
          this.submittedFailures++;
          this.submittedFailureByReason.partial_entry_residual++;
          this.partialEntryRecoveries++;
          break;
        case "FILLED_THEN_ECONOMICS_ABORT":
          // EXECUTION SUCCEEDED (four legs filled) but we chose to reverse it. It is
          // counted as a submitted FAILURE for the completion rate because no box was
          // opened, and its cost lands in the economic total. Both facts are true and
          // both are published; neither is allowed to hide the other.
          this.submittedFailures++;
          this.submittedFailureByReason.economics_abort_after_fill++;
          break;
        case "FILLED_EXPOSURE_UNRECORDED":
          /*
           * A SUBMITTED FAILURE, and deliberately its own reason.
           *
           * Four legs really filled, so this belongs in the submitted denominator — but it is not
           * `no_fill` (they filled), not `partial_entry_*` (all four filled and none was unwound),
           * not `economics_abort_after_fill` (no economic verdict was ever reached) and not
           * `quarantined_unknown` (the broker state is fully proven; ours is what failed). Folding
           * it into any of those would hide the one outcome in this enum where a live position
           * exists that the system never recorded.
           */
          this.submittedFailures++;
          this.submittedFailureByReason.filled_exposure_unrecorded++;
          break;
        case "QUARANTINED_UNKNOWN":
          this.submittedFailures++;
          this.submittedFailureByReason.quarantined_unknown++;
          break;
        case "REFUSED_BEFORE_SUBMIT":
          // Contradictory input: labelled a pre-submit refusal yet reported as submitted.
          // Trust the OUTCOME LABEL (it is stamped by the execution path itself) and file
          // it as a zero-POST refusal rather than silently inventing a submission.
          this.recordZeroPostRefusal(args.zeroPostReason ?? "other");
          break;
      }
    }

    if (args.leftUnresolvedExposure === true) {
      this.unresolvedTotal++;
      this.unresolvedOpen++;
    }
    if (typeof args.realisedNetPnl === "number" && Number.isFinite(args.realisedNetPnl)) {
      this.realisedNetPnl += args.realisedNetPnl;
      if (args.realisedNetPnl > 0) this.profitable++;
      else if (args.realisedNetPnl < 0) this.unprofitable++;
    }
    if (typeof args.recoveryCost === "number" && Number.isFinite(args.recoveryCost)) {
      this.recoveryCosts += Math.max(0, args.recoveryCost);
    }
  }

  /** Exposure that was outstanding has now been resolved. Clamped at zero. */
  recordUnresolvedExposureResolved(): void {
    this.unresolvedOpen = Math.max(0, this.unresolvedOpen - 1);
  }

  /** A position closed cleanly. */
  recordCompletedExit(realisedNetPnl?: number | null): void {
    this.completedExits++;
    if (typeof realisedNetPnl === "number" && Number.isFinite(realisedNetPnl)) {
      this.realisedNetPnl += realisedNetPnl;
      if (realisedNetPnl > 0) this.profitable++;
      else if (realisedNetPnl < 0) this.unprofitable++;
    }
  }

  snapshot(): ExecutionFunnelSnapshot {
    const round2 = (v: number): number => Math.round(v * 100) / 100;
    return {
      candidates_evaluated: this.candidatesEvaluated,
      qualified_opportunities: this.qualifiedOpportunities,
      attempts_admitted: this.attemptsAdmitted,
      attempts_submitted: this.attemptsSubmitted,
      four_leg_completed_entries: this.fourLegCompleted,

      zero_post_refusals: this.zeroPost,
      zero_post_by_reason: { ...this.zeroPostByReason },
      submitted_failures: this.submittedFailures,
      submitted_failures_by_reason: { ...this.submittedFailureByReason },

      no_fill_cancellations: this.noFillCancellations,
      partial_entry_recoveries: this.partialEntryRecoveries,
      unresolved_exposure_open: this.unresolvedOpen,
      unresolved_exposure_total: this.unresolvedTotal,
      completed_exits: this.completedExits,

      realised_net_pnl: round2(this.realisedNetPnl),
      recovery_costs_included: round2(this.recoveryCosts),
      economically_profitable: this.profitable,
      economically_unprofitable: this.unprofitable,

      ratios: {
        admission_rate: ratio(
          this.attemptsAdmitted, this.qualifiedOpportunities,
          "admitted attempts / qualified opportunities",
        ),
        submission_rate: ratio(
          this.attemptsSubmitted, this.attemptsAdmitted,
          "attempts with >=1 real broker POST / admitted attempts",
        ),
        execution_completion_rate: ratio(
          this.fourLegCompleted, this.attemptsSubmitted,
          "four-leg completed entries / attempts with >=1 real broker POST " +
            "(excludes zero-POST local refusals; includes every broker-facing attempt)",
        ),
        economic_success_rate: ratio(
          this.economicallyProfitableAmongCompleted(), this.fourLegCompleted,
          "economically profitable outcomes / four-leg completed entries " +
            "(economic success is NOT execution completion)",
        ),
        unresolved_exposure_rate: ratio(
          this.unresolvedTotal, this.attemptsAdmitted,
          "attempts that ended with unresolved exposure / admitted attempts",
        ),
      },
    };
  }

  /**
   * Profitable outcomes bounded by the completed-entry count.
   *
   * `profitable` also counts clean exits, which would let the economic success RATE
   * exceed 1 against a completed-entry denominator. Clamped so the published ratio is
   * never absurd, while the raw counts above stay unclamped and auditable.
   */
  private economicallyProfitableAmongCompleted(): number {
    return Math.min(this.profitable, this.fourLegCompleted);
  }

  reset(): void {
    this.candidatesEvaluated = 0;
    this.qualifiedOpportunities = 0;
    this.attemptsAdmitted = 0;
    this.attemptsSubmitted = 0;
    this.fourLegCompleted = 0;
    this.zeroPost = 0;
    this.zeroPostByReason = Object.fromEntries(ZERO_POST_REASONS.map((r) => [r, 0])) as Record<ZeroPostRefusalReason, number>;
    this.submittedFailures = 0;
    this.submittedFailureByReason = Object.fromEntries(SUBMITTED_FAILURE_REASONS.map((r) => [r, 0])) as Record<SubmittedFailureReason, number>;
    this.noFillCancellations = 0;
    this.partialEntryRecoveries = 0;
    this.unresolvedOpen = 0;
    this.unresolvedTotal = 0;
    this.completedExits = 0;
    this.realisedNetPnl = 0;
    this.recoveryCosts = 0;
    this.profitable = 0;
    this.unprofitable = 0;
  }
}
