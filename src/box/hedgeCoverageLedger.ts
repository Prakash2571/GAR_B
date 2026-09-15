/**
 * THE HEDGE COVERAGE LEDGER — proven, attributed, single-use evidence that an uncovered SELL is
 * safe to transmit.
 *
 * THE DEFECT THIS CLOSES. The hedge-first barrier (see orderManager.ts) used to authorise a
 * dependent SELL on the basis of "no BUY hedge of this attempt was recorded as a DEFINITIVE
 * FAILURE" — i.e. `hedgeFailure === null`. That is a FAILURE signal, not a COVERAGE signal, and the
 * two are not complements. A BUY hedge that came back CANCELLED with ZERO fills, or OPEN, or
 * PARTIALLY_FILLED-then-terminal below its required size, or in any terminal state that the
 * failure classifier did not name, left `hedgeFailure === null` — and the full-size uncovered SELL
 * that depended on it was authorised and POSTed NAKED. Confirmed against current main: with both
 * BUY hedges returning CANCELLED/0-filled the gateway still transmitted both SELL legs at entry
 * concurrency 1 and 4.
 *
 * THE INVERSION. Permission for a dependent SELL now requires PROVEN SUFFICIENT COVERAGE, not the
 * absence of a named failure:
 *
 *   • Coverage is only ever created by an authoritative broker snapshot whose FILLED QUANTITY
 *     reaches the required size. A broker acceptance, an order id, an ACK, an OPEN/working state,
 *     or a state the classifier merely failed to name is NOT coverage — it is the absence of
 *     coverage, and the absence of coverage is not permission.
 *   • The snapshot must MATCH the intended hedge on every attributable axis: attempt identity,
 *     role, contract (token AND tradingsymbol), side (a hedge is a BUY), broker/account, and
 *     requested quantity. A fill on the wrong contract, the wrong side, the wrong account or a
 *     different attempt covers nothing.
 *   • Attribution is SINGLE-USE and ATTEMPT-SCOPED. One proven hedge fill can back the dependents
 *     of exactly the attempt it belongs to; it can never be reused across incompatible attempts.
 *
 * FAIL CLOSED. Absent, stale, mismatched or unprovable evidence yields NO coverage. Every method
 * here is a positive assertion ("this much is proven"); the DEFAULT is zero.
 *
 * SCOPE — ENTRY ONLY. This ledger exists solely to decide whether it is safe to CREATE the
 * uncovered short half of a box. It is never consulted for an EXIT, a PROTECTIVE_CANCEL or an
 * EMERGENCY_RESIDUAL: those reduce exposure already owned, and coverage is irrelevant to reducing
 * risk. The order manager enforces that by only building coverage for `purpose === "ENTRY"`.
 *
 * PURE STATE, NO I/O. This is in-memory session authority, exactly like the transport gate it
 * lives beside. It is never written to the durable intent and never sent to a broker.
 */

import type { BoxLegRole, OrderSide } from "./types.js";

/**
 * The identity an intended BUY hedge MUST prove before any of its quantity counts as coverage.
 *
 * Every field is an attributable axis. Two evidences with the same `attempt_id` + `role` but a
 * different contract, side, account or requested quantity are DIFFERENT hedges, and the mismatch
 * means the newer one proves nothing about the intended one.
 */
export interface HedgeRequirement {
  readonly attempt_id: string;
  readonly role: BoxLegRole;
  /** Numeric instrument token of the exact option the hedge must fill. */
  readonly token: number;
  /** Human-readable contract symbol; checked alongside the token, never instead of it. */
  readonly tradingsymbol: string;
  /** A hedge is a BUY. Anything else is not a hedge and cannot cover an uncovered SELL. */
  readonly side: OrderSide;
  /** Broker/account the hedge must have filled on. Coverage is not fungible across accounts. */
  readonly broker_account: string;
  /** Full quantity that must be broker-confirmed before this hedge counts as covered. */
  readonly required_quantity: number;
}

/**
 * A terminal, authoritative broker observation of one hedge leg's outcome.
 *
 * `no_post` is the proven-local-refusal case: the leg never reached the broker at all, so there is
 * categorically nothing to cover with. It is recorded so the ledger can report an explicit reason
 * rather than a silent zero.
 */
export interface HedgeOutcomeEvidence {
  readonly attempt_id: string;
  readonly role: BoxLegRole;
  readonly token: number;
  readonly tradingsymbol: string;
  readonly side: OrderSide;
  readonly broker_account: string;
  /** The quantity we asked the broker to fill. */
  readonly requested_quantity: number;
  /**
   * Broker-confirmed CUMULATIVE filled quantity. This is the ONLY basis for coverage. It comes
   * from a terminal broker snapshot; a pre-terminal or unproven read must be reported as `null`,
   * never as an optimistic number.
   */
  readonly confirmed_fill_quantity: number | null;
  /**
   * True only when the broker snapshot is TERMINAL and its cumulative quantity can no longer
   * change (COMPLETE/CANCELLED/REJECTED). While an order can still fill, coverage from it must not
   * be counted AND its shortfall must not be treated as a final failure — either would be a guess.
   */
  readonly terminal: boolean;
  /** Provenance for diagnostics/audit; never itself a basis for coverage. */
  readonly detail: string;
}

/** Why a hedge did not (yet) prove coverage. Distinct causes so callers can assert the reason. */
export type HedgeCoverageGap =
  | "no_evidence"
  | "not_terminal"
  | "no_post"
  | "contract_mismatch"
  | "side_mismatch"
  | "account_mismatch"
  | "attempt_mismatch"
  | "insufficient_fill";

/** The coverage verdict for one intended hedge requirement. */
export interface HedgeCoverageResult {
  readonly covered: boolean;
  /** Present iff `covered === false`. */
  readonly gap?: HedgeCoverageGap;
  readonly reason?: string;
}

/**
 * Per-attempt, in-memory ledger of proven hedge coverage.
 *
 * One instance per entry attempt (created lazily beside the transport gate). It stores at most one
 * terminal evidence per role — a role decides exactly once — and answers "is this intended hedge
 * provably covered?" against it.
 */
export class HedgeCoverageLedger {
  private readonly attemptId: string;
  private readonly evidenceByRole = new Map<BoxLegRole, HedgeOutcomeEvidence>();
  /**
   * Roles whose proven fill has already been CLAIMED as coverage for a transmitted dependent. Kept
   * so a future multi-lot profile cannot silently double-spend one hedge fill across two
   * dependents; in the one-lot-per-leg profile a whole box shares one hedge set, so a claim is
   * recorded per-(role,dependent) and the same dependent re-checking is idempotent.
   */
  private readonly claims = new Map<BoxLegRole, Set<string>>();

  constructor(attemptId: string) {
    this.attemptId = attemptId;
  }

  /**
   * Record one hedge leg's terminal outcome. Idempotent per role: the FIRST terminal evidence for
   * a role wins, so a later `finally`-path re-report cannot overwrite a proven broker snapshot with
   * a weaker one. A non-terminal evidence never displaces a terminal one.
   */
  record(evidence: HedgeOutcomeEvidence): void {
    if (evidence.attempt_id !== this.attemptId) return; // Never store another attempt's evidence.
    const existing = this.evidenceByRole.get(evidence.role);
    if (existing && existing.terminal && !evidence.terminal) return;
    if (existing && existing.terminal && evidence.terminal) return;
    this.evidenceByRole.set(evidence.role, evidence);
  }

  /**
   * Is the intended hedge provably covered?
   *
   * Returns `covered: true` ONLY when a stored evidence matches the requirement on every
   * attributable axis, is terminal, and its confirmed fill reaches the required quantity.
   * Everything else — including no evidence at all — is an explicit gap. FAIL CLOSED.
   */
  coverageFor(req: HedgeRequirement): HedgeCoverageResult {
    if (req.attempt_id !== this.attemptId) {
      return gap("attempt_mismatch", `requirement is for attempt ${req.attempt_id}, ledger is ${this.attemptId}`);
    }
    const evidence = this.evidenceByRole.get(req.role);
    if (!evidence) return gap("no_evidence", `no terminal broker evidence for hedge ${req.role}`);
    if (evidence.attempt_id !== req.attempt_id) {
      return gap("attempt_mismatch", `hedge ${req.role} evidence belongs to attempt ${evidence.attempt_id}`);
    }
    if (evidence.side !== req.side || req.side !== "BUY") {
      return gap("side_mismatch", `hedge ${req.role} must be a BUY; evidence side is ${evidence.side}`);
    }
    if (evidence.token !== req.token || evidence.tradingsymbol !== req.tradingsymbol) {
      return gap(
        "contract_mismatch",
        `hedge ${req.role} evidence is ${evidence.tradingsymbol}/${evidence.token}, required ${req.tradingsymbol}/${req.token}`,
      );
    }
    if (evidence.broker_account !== req.broker_account) {
      /*
       * The accounts are NOT interpolated. This reason string travels further than it looks: a
       * `pre_post` refusal becomes a BrokerPreSubmitRefusedError whose reason is written into the
       * intent's transition note and audit JSONB, which the outbox copies verbatim into the Mongo
       * projection payload. Once the account provider became real, that meant the raw broker
       * `user_id` twice over in a durable, replicated record — while every other surface in this
       * codebase masks that identifier (`projectBrokerSession`, `buildOperationalReadiness`).
       *
       * The role is enough to act on: an operator who sees this needs to know WHICH hedge could not
       * be proven and that the account differed, not what the two account ids were.
       */
      return gap(
        "account_mismatch",
        `hedge ${req.role} evidence was recorded under a DIFFERENT broker account than the ` +
          `requirement declared before it posted; coverage cannot be proven across accounts`,
      );
    }
    if (!evidence.terminal) {
      return gap("not_terminal", `hedge ${req.role} is not terminal; coverage cannot be counted while it can still change`);
    }
    if (evidence.confirmed_fill_quantity === null) {
      return gap("no_post", `hedge ${req.role} has no broker-confirmed fill quantity (${evidence.detail})`);
    }
    if (evidence.confirmed_fill_quantity < req.required_quantity) {
      return gap(
        "insufficient_fill",
        `hedge ${req.role} confirmed ${evidence.confirmed_fill_quantity} of required ${req.required_quantity}`,
      );
    }
    return { covered: true };
  }

  /**
   * Full coverage across a SET of intended hedges (the ONE-LOT profile: every uncovered SELL of an
   * attempt depends on ALL of the attempt's BUY hedges). Returns null when every requirement is
   * covered; otherwise the FIRST gap's reason, so the refusal names a real, specific cause.
   */
  coverageGapFor(reqs: readonly HedgeRequirement[]): string | null {
    if (reqs.length === 0) {
      // A dependent SELL with no declared hedge prerequisites is a contradiction: an uncovered
      // SELL by definition depends on hedges. Absent requirements are unprovable coverage.
      return "no hedge requirements supplied for a dependent SELL; coverage is unprovable";
    }
    for (const req of reqs) {
      const result = this.coverageFor(req);
      if (!result.covered) return `hedge ${req.role} not proven covered: ${result.reason}`;
    }
    return null;
  }

  /**
   * Claim the proven coverage of a hedge SET for one dependent, single-use per (role, dependent).
   * Returns true when the claim is granted (or already held by this dependent — idempotent), false
   * if any required hedge is not covered. Prevents one hedge fill from backing incompatible
   * dependents in a future multi-lot profile.
   */
  claimCoverage(dependentRole: BoxLegRole, reqs: readonly HedgeRequirement[]): boolean {
    if (this.coverageGapFor(reqs) !== null) return false;
    for (const req of reqs) {
      const claimants = this.claims.get(req.role) ?? new Set<string>();
      claimants.add(dependentRole);
      this.claims.set(req.role, claimants);
    }
    return true;
  }

  /** Diagnostics only: the stored evidence for a role, if any. */
  evidence(role: BoxLegRole): HedgeOutcomeEvidence | undefined {
    return this.evidenceByRole.get(role);
  }
}

function gap(gap: HedgeCoverageGap, reason: string): HedgeCoverageResult {
  return { covered: false, gap, reason };
}
