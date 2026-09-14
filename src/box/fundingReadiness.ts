/**
 * FUNDING READINESS — "the evidence checks are off" stated as a DIFFERENT fact from
 * "funding is verified".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CONFIGURATION RISK THIS ADDRESSES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Four controls govern whether a live entry is admitted against real money, and all four default
 * OFF in `src/box/config.ts`:
 *
 *     BOX_LIVE_REQUIRE_FUNDS_COVER      false
 *     BOX_LIVE_REQUIRE_MARGIN_EVIDENCE  false
 *     BOX_LIVE_REQUIRE_STAGE_FUNDING    false
 *     BOX_LIVE_RECOVERY_RESERVE_RUPEES  0
 *
 * When all three boolean gates are off, `CentralBoxExecutionGateway.evaluateEntryEconomics`
 * returns before reading any evidence, so `economicDiagnostics()` is `null`. Null is honest — it
 * means "nothing was checked, and therefore nothing is claimed" — but it is easy to read as
 * "no problems found". This module makes the distinction explicit and machine-readable, and names
 * the FIVE mutually exclusive states funding can be in.
 *
 * WHAT THIS MODULE DOES NOT DO — deliberately
 * It does NOT make entry refuse merely because the gates are off. The default-off configuration is
 * the behaviour existing deployments are running today, and silently converting it into a
 * trading-stop would be a change to their trading controls rather than a report about them. So:
 *
 *   • gates OFF                          → no blocker; the state is REPORTED as `checks_disabled`.
 *   • gate ON and evidence unusable      → an ENTRY-SCOPED blocker, because evidence that is
 *                                          REQUIRED and absent must refuse entry.
 *
 * ENTRY-ONLY BY CONSTRUCTION. Every blocker produced here has `scope: "entry"`. `buildOperationalReadiness`
 * filters blockers by scope when it composes the reduction verdict, so a funding blocker cannot
 * stop a safely attributed risk reduction — an account that cannot fund a NEW box must still be
 * able to close the one it already has.
 *
 * PURE and total: no clock, no config loading, no I/O.
 */

import type { EconomicAdmissionReport, EconomicRefusalReason } from "./boxCapital.js";
import type { ReadinessBlocker } from "./operationalReadiness.js";

/**
 * The five mutually exclusive funding states.
 *
 * `checks_disabled` and `verified` are the two the review called out as conflated. They are now
 * different values, not two readings of `null`.
 */
export type FundingReadinessStatus =
  /** Not a live deployment: funding admission does not apply and claims nothing. */
  | "not_applicable"
  /** Live, but every evidence gate is off. NOTHING is claimed about funding. */
  | "checks_disabled"
  /** Live with at least one gate on, but no entry has been evaluated yet this session. */
  | "not_evaluated"
  /** Live, gates on, and the last evaluation ADMITTED against fresh bound evidence. */
  | "verified"
  /** Live, gates on, and the last evaluation REFUSED. `reasons` says why. */
  | "refused";

/** Which gates are in force, separating what was CONFIGURED from what is EFFECTIVE. */
export interface FundingGateSettings {
  /** `BOX_LIVE_REQUIRE_FUNDS_COVER` as configured. */
  readonly funds_cover_configured: boolean;
  /** `BOX_LIVE_REQUIRE_MARGIN_EVIDENCE` as configured. */
  readonly margin_evidence_configured: boolean;
  /** `BOX_LIVE_REQUIRE_STAGE_FUNDING` as configured. */
  readonly stage_funding_configured: boolean;
  /**
   * EFFECTIVE funds-cover requirement.
   *
   * Stage funding IMPLIES the funds comparison (see boxCapital.evaluateEconomicAdmission): computing
   * a precise per-stage requirement and then never comparing it against money would be a gate in
   * name only. So this is `funds_cover_configured || stage_funding_configured`, and it is reported
   * separately so a surface can never claim the funds check is off while stage funding runs it.
   */
  readonly funds_cover_effective: boolean;
  /** EFFECTIVE margin-evidence requirement — stage funding needs the basket margin too. */
  readonly margin_evidence_effective: boolean;
  /** Stage funding has no implication applied to it. */
  readonly stage_funding_effective: boolean;
}

/** Freshness/timeout thresholds the evidence was (or would be) judged against. */
export interface FundingFreshnessSettings {
  readonly funds_max_age_ms: number;
  readonly margin_max_age_ms: number;
  readonly read_timeout_ms: number;
}

export interface FundingReadiness {
  readonly status: FundingReadinessStatus;
  /**
   * TRUE only in `verified`.
   *
   * The single boolean a surface should key on when it wants to say "funding was proven". It is
   * false for `checks_disabled`, which is the whole point.
   */
  readonly funding_verified: boolean;
  /** One bounded sentence stating exactly what is and is not proven. */
  readonly claim: string;
  readonly gates: FundingGateSettings;
  readonly freshness: FundingFreshnessSettings;
  /**
   * The operator-configured recovery reserve, in rupees, held back so a recovery action is not
   * blocked for want of funds. NOT a computed or recommended figure — see the note in
   * docs/ECONOMIC_ADMISSION.md on how an operator must size it.
   */
  readonly recovery_reserve_rupees: number;
  /** Refusal reasons from the last evaluation. Empty unless `status === "refused"`. */
  readonly reasons: readonly EconomicRefusalReason[];
  /** Wall-clock instant of the last evaluation, or null when none happened. */
  readonly evaluated_at: number | null;
  /** The immutable order plan the last decision was bound to. */
  readonly plan_fingerprint: string | null;
  /** Broker/account/session the evidence was read under, in non-secret form. */
  readonly evidence_context: EconomicAdmissionReport["evidence_context"];
  /** Standing limitations an operator must know, whether or not they blocked anything. */
  readonly limitations: readonly string[];
}

export interface FundingReadinessInput {
  /** True only for a live-capable deployment (`executionMode === "live"`). */
  readonly live: boolean;
  readonly requireFundsCover: boolean;
  readonly requireMarginEvidence: boolean;
  readonly requireStageFunding: boolean;
  readonly recoveryReserveRupees: number;
  readonly freshness: FundingFreshnessSettings;
  /** The last economic-admission decision, or null when none has been made. */
  readonly report: EconomicAdmissionReport | null;
  /**
   * Standing per-broker evidence limitations, e.g. "Dhan publishes no documented
   * execute-the-orders (initial) basket margin". Reported verbatim.
   */
  readonly brokerLimitations?: readonly string[];
}

/** Human-readable claim text per state. Kept beside the status so the two cannot drift. */
function claimFor(status: FundingReadinessStatus, gates: FundingGateSettings): string {
  switch (status) {
    case "not_applicable":
      return "This deployment is not live, so no funding admission is performed and none is claimed.";
    case "checks_disabled":
      return (
        "EVIDENCE CHECKS ARE DISABLED. No funds, margin or stage-funding evidence is read, so nothing " +
        "is known about whether the account can fund an entry. This is NOT a statement that funding " +
        "is sufficient. Enable BOX_LIVE_REQUIRE_FUNDS_COVER, BOX_LIVE_REQUIRE_MARGIN_EVIDENCE and " +
        "BOX_LIVE_REQUIRE_STAGE_FUNDING to have it verified."
      );
    case "not_evaluated":
      return (
        "Funding evidence checks are ENABLED but no entry has been evaluated yet in this session, so " +
        "there is no decision to report. Funding is neither proven nor disproven."
      );
    case "verified":
      return (
        "The last entry was admitted against fresh funds/margin evidence bound to this broker " +
        "account/session and to the exact order plan" +
        (gates.stage_funding_effective ? ", including every hedge-first funding stage." : ".")
      );
    case "refused":
      return "The last entry was REFUSED on funding grounds. See `reasons`.";
  }
}

/**
 * Classify funding readiness from the configured gates and the last decision.
 *
 * Total: every combination of inputs maps to exactly one status.
 */
export function buildFundingReadiness(input: FundingReadinessInput): FundingReadiness {
  // The implication is applied ONCE, here and in the evaluator, and reported explicitly.
  const gates: FundingGateSettings = {
    funds_cover_configured: input.requireFundsCover === true,
    margin_evidence_configured: input.requireMarginEvidence === true,
    stage_funding_configured: input.requireStageFunding === true,
    funds_cover_effective: input.requireFundsCover === true || input.requireStageFunding === true,
    margin_evidence_effective: input.requireMarginEvidence === true || input.requireStageFunding === true,
    stage_funding_effective: input.requireStageFunding === true,
  };
  const anyGateOn =
    gates.funds_cover_effective || gates.margin_evidence_effective || gates.stage_funding_effective;

  let status: FundingReadinessStatus;
  if (!input.live) status = "not_applicable";
  else if (!anyGateOn) status = "checks_disabled";
  else if (input.report === null) status = "not_evaluated";
  else status = input.report.allowed ? "verified" : "refused";

  const limitations: string[] = [...(input.brokerLimitations ?? [])];
  if (status === "checks_disabled") {
    limitations.push(
      "Funding evidence gates are all disabled, so an entry can be admitted without any funds or " +
        "margin evidence being read.",
    );
  }
  if (input.live && anyGateOn && input.recoveryReserveRupees <= 0) {
    // Not a refusal: zero is a legitimate operator choice. But it IS a limitation worth stating,
    // because the reserve is the only component that keeps funds back for a recovery action.
    limitations.push(
      "BOX_LIVE_RECOVERY_RESERVE_RUPEES is 0, so no funds are held back for a recovery action " +
        "(cancel, unwind, complete). Size it deliberately rather than leaving the default.",
    );
  }

  return {
    status,
    funding_verified: status === "verified",
    claim: claimFor(status, gates),
    gates,
    freshness: input.freshness,
    recovery_reserve_rupees: Number.isFinite(input.recoveryReserveRupees) && input.recoveryReserveRupees > 0
      ? input.recoveryReserveRupees
      : 0,
    reasons: status === "refused" ? (input.report?.reasons ?? []) : [],
    evaluated_at: input.report?.evaluated_at ?? null,
    plan_fingerprint: input.report?.plan_fingerprint ?? null,
    evidence_context: input.report?.evidence_context ?? null,
    limitations,
  };
}

/**
 * Standing, broker-specific evidence limitations.
 *
 * These are NOT failures — they are facts about what each integration can and cannot prove, and they
 * are reported so an operator learns them from the readiness surface rather than from a refused
 * entry. Each one is sourced from the declarations the code already relies on:
 * `BROKER_FUNDS_SEMANTICS` in fundsSemantics.ts, and the per-broker basket-margin providers in
 * src/brokers/registry.ts.
 *
 * Keep this honest: if a broker cannot supply a required figure, say so plainly. The evaluator
 * already refuses entry when the figure is required and absent; this only names the reason in
 * advance.
 */
export function brokerFundingLimitations(broker: string | null): readonly string[] {
  if (broker === "zerodha") {
    return [
      "Zerodha's available-funds semantics are declared NET of encumbrance from vendor documentation " +
        "and have NOT been verified against a live account; the conservative reading is applied.",
    ];
  }
  if (broker === "dhan") {
    return [
      "Dhan publishes no documented execute-the-orders (INITIAL) basket margin, so a hedge-first " +
        "funding stage cannot be established for it. With BOX_LIVE_REQUIRE_STAGE_FUNDING=true, live " +
        "entry on Dhan is refused with funding_stage_unknown BY DESIGN rather than admitted on the " +
        "completed-box (final) margin.",
      "Dhan's available-funds semantics are UNVERIFIED; the conservative (understating) reading is " +
        "applied.",
    ];
  }
  return [];
}

/** One actionable sentence per refusal reason, for the readiness surface. */
const REASON_DETAIL: Readonly<Record<EconomicRefusalReason, string>> = {
  gross_notional_over_cap:
    "The planned gross option-order notional exceeds the configured cap. This is a NOTIONAL limit, " +
    "not a margin or available-funds check.",
  insufficient_available_funds:
    "Available funds do not cover the binding funding requirement (worst funding stage + estimated " +
    "charges + recovery reserve, plus encumbrance where it is not already netted).",
  margin_evidence_stale_or_missing:
    "The broker's planned (basket) margin evidence is missing or older than the configured freshness " +
    "window. Missing is not zero, so entry is refused rather than estimated.",
  margin_evidence_invalid:
    "The broker returned a planned-margin figure that cannot be used as authority (incomplete, " +
    "non-finite, or non-positive).",
  funds_evidence_invalid:
    "The broker's available-funds figure cannot be used as authority for this broker's declared " +
    "funds semantics.",
  funding_stage_unknown:
    "At least one hedge-first funding stage has no establishable requirement, so the account cannot " +
    "be shown to fund the SEQUENCE that creates the box — only, at best, the finished box.",
  hedge_sequence_invalid:
    "The planned submission order is not hedge-first (a naked SELL would precede its hedge BUY).",
  metric_incomplete:
    "A required economic quantity could not be established, so there is nothing to compare against.",
};

/**
 * ENTRY-SCOPED readiness blockers for the funding state.
 *
 * Emitted ONLY when a gate is enabled and the last decision refused. Disabled gates produce NO
 * blocker — see the module header for why that is deliberate — and every blocker is `scope: "entry"`
 * so risk reduction is structurally unaffected.
 *
 * STALENESS, STATED HONESTLY. The input derives from the gateway's LAST economic decision, which is
 * retained until the next entry is evaluated. So this reports "the most recent entry was refused on
 * funding grounds", not "an entry attempted right now would be refused" — the live entry gate is the
 * stream/permission table, not this decision. The two are usually the same (funds do not appear
 * between candidates) and erring toward reporting a refusal is the safe direction, but a surface
 * MUST NOT present this as a real-time enforcement state. `evaluated_at` is published so a reader can
 * see how old the verdict is.
 */
export function fundingReadinessBlockers(readiness: FundingReadiness): ReadinessBlocker[] {
  if (readiness.status !== "refused") return [];
  const blockers: ReadinessBlocker[] = [];
  for (const reason of readiness.reasons) {
    blockers.push({
      code: `funding_${reason}`,
      scope: "entry",
      detail:
        `${REASON_DETAIL[reason]} New entry is refused; exposure already held can still be exited, ` +
        "reduced and protectively cancelled.",
    });
  }
  if (blockers.length === 0) {
    // Refused with no enumerated reason: still refuse, and say so rather than implying an all-clear.
    blockers.push({
      code: "funding_refused_unspecified",
      scope: "entry",
      detail:
        "Economic admission refused the last entry on funding grounds without an enumerated reason. " +
        "New entry is refused; exposure management is unaffected.",
    });
  }
  return blockers;
}
