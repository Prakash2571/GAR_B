/**
 * RESIDUAL-FLATTEN ATTEMPT IDENTITY.
 *
 * A residual leg is exposure we hold and did not want. The flatten loop works it every
 * `RESIDUAL_FLATTEN_MS` until the book is flat. That loop is a RETRY loop, and a retry loop
 * whose durable order identity never changes cannot retry.
 *
 * THE DEFECT THIS MODULE EXISTS TO PREVENT
 * The identity used to be `stableAttemptId(attemptId, residual.created_at, role)`, and
 * `created_at` is preserved when the shrunken residual is written back — so every pass
 * regenerated the SAME `client_order_id`:
 *
 *   - filled 0 (the normal reason a residual exists): the durable intent upsert returns the
 *     existing non-CREATED intent, `OrderManager.execute()` takes its "a prior submission
 *     exists" branch, re-reads the stale order and resolves. NO ORDER IS EVER SENT AGAIN and
 *     the residual stays naked indefinitely.
 *   - filled partially: the remaining quantity changed but the identity did not, so
 *     `assertIntentImmutableMatch` throws on `quantity` — and that error matched neither branch
 *     of the old catch, so it was swallowed. Every later pass threw the same way.
 *
 * THE INVARIANT
 *   SAME logical submission  => SAME identity   (so a retry/reconcile adopts, never duplicates)
 *   NEW attempt for still-outstanding quantity => NEW identity  (so a retry can actually retry)
 *
 * HOW THE GENERATION STAYS DURABLE AND CRASH-SAFE
 * The generation lives ON the residual record (`flatten_attempt`), which is persisted by the
 * SAME `updateBoxExecutionAttemptResidual` write that persists the new remaining quantity. One
 * document write carries both, so the pair can never be torn:
 *
 *   advance + shrink        -> one atomic `$set` of `residual_exposure`
 *   crash before that write -> the generation is UNCHANGED on restart, so the next pass reuses
 *                              the same identity, and the durable intent journal (one document
 *                              per `client_order_id`) decides what that means: a `CREATED`
 *                              intent is submitted (no POST had happened), anything later is
 *                              adopted through `adapter.getOrder`. Never a duplicate order.
 *   crash after that write  -> the previous generation reached an outcome that explicitly permits
 *                              advancement: COMPLETE/CANCELLED broker truth left a remainder, or
 *                              a local refusal proved no POST. Broker-origin REJECTED deliberately
 *                              retains its identity for operator/reconciliation policy.
 *
 * The generation is therefore never a loose in-memory counter, never `Date.now()` and never
 * random: each attempt is represented explicitly by its own row in `box_order_intents`.
 */

import { isBrokerOrderTerminal, type BrokerOrder } from "./brokerAdapter.js";
import type { ResidualLegExposure } from "./types.js";

/** The generation a residual carries before anything has been attempted. */
export const FIRST_RESIDUAL_FLATTEN_ATTEMPT = 1;

/**
 * How many PROVEN-ZERO-EXPOSURE broker rejections a residual may retry through before the
 * flatten loop stops POSTing and escalates to the operator.
 *
 * Sized for the failure it exists to survive: a transient refusal (a momentary margin shortfall
 * while another box is legging, a `market_closed` race on the 15:30 boundary, a one-off RMS
 * hiccup) clears within a pass or two. A structural refusal — F&O ban period, expired contract,
 * a standing RMS block on the symbol — never clears, and each retry costs an order request from
 * the daily budget that protective work for OTHER positions depends on. Five attempts at the
 * 2-second flatten cadence spends ~10 seconds and 5 order requests before handing over to a
 * human, which is the right trade against leaving a naked option leg unmanaged.
 */
export const MAX_RESIDUAL_BROKER_REJECTIONS = 5;

/**
 * CONSECUTIVE broker rejections already suffered by this residual, read defensively.
 *
 * Reset by any pass that reduces the outstanding quantity — a fill proves the reduction is
 * possible, so a later unrelated refusal starts from a full budget. Legacy rows and corrupt values
 * read as zero: the safe reading, because zero means the retry budget is intact and the exposure
 * will still be worked rather than abandoned.
 */
export function residualBrokerRejections(residual: ResidualLegExposure): number {
  const raw = residual.flatten_broker_rejections;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * Whether this residual has any rejection-retry budget left.
 *
 * At the bound the flatten loop must STOP submitting: a reduction the broker refuses five times
 * running is not going to succeed on the sixth, and each attempt consumes the account's order
 * budget. The exposure is retained, reported, and escalated rather than silently re-POSTed.
 */
export function residualRejectionBudgetExhausted(residual: ResidualLegExposure): boolean {
  return residualBrokerRejections(residual) >= MAX_RESIDUAL_BROKER_REJECTIONS;
}

/**
 * Upper bound on how far the durable journal is probed when a residual arrives with no
 * generation of its own (crash-recovery exposure derived from the intent journal rather than
 * read from a persisted residual). Bounded so a pathological journal cannot spin.
 */
export const MAX_RESIDUAL_FLATTEN_ATTEMPT_PROBE = 64;

/**
 * What the last attempt on this residual established, and therefore whether the NEXT attempt
 * may reuse its identity.
 *
 * An enum rather than a pair of booleans because the four cases have genuinely different
 * safety meanings, and "advance" is only ever legal in one of them.
 */
export type ResidualFlattenDisposition =
  /** Nothing is left. The residual is gone. */
  | "flattened"
  /**
   * This identity reached an outcome that permits a NEW generation: COMPLETE/CANCELLED broker
   * truth left quantity, a local pre-POST refusal proves no broker mutation occurred, or the
   * broker terminally REJECTED it with zero exposure proven (a rejected order holds no quantity,
   * so a fresh identity cannot duplicate a fill). Rejection-driven retirement is bounded by
   * {@link MAX_RESIDUAL_BROKER_REJECTIONS}.
   */
  | "retire_attempt"
  /**
   * Nothing reached the broker under this identity (no executable book, or a manager gate
   * refused before the POST). The identity is still unused, so the next pass MUST reuse it —
   * advancing here would burn generations and, worse, could POST a second reduction while the
   * first is still reserved.
   */
  | "reuse_attempt"
  /**
   * The broker's outcome for this identity is WORKING or UNKNOWN. Keep the identity so the next
   * pass reconciles/adopts it. Never advance and never resubmit: an ambiguous submission must
   * not become a duplicate POST.
   */
  | "adopt_attempt";

/** Why a flatten attempt did not flatten. Fixed, low-cardinality set — safe for telemetry. */
export type ResidualFlattenFailureKind =
  /** No book, or no executable touch price on the reducing side. Nothing was sent. */
  | "no_executable_book"
  /** A manager control/limit refused the order before it reached the broker. */
  | "gate_refused"
  /** The identity is already queued or in flight in this process. */
  | "already_in_flight"
  /** The gateway admitted a book, but queue/pre-POST revalidation refused it locally. */
  | "local_pre_submit_refused"
  /** The broker refused the order and said so. A known outcome. */
  | "broker_rejected"
  /**
   * The broker has now refused this reduction {@link MAX_RESIDUAL_BROKER_REJECTIONS} times with
   * zero exposure proven each time. The retry budget is spent, so the loop stops POSTing and the
   * exposure is escalated to the operator instead of being re-sent every two seconds forever.
   *
   * This is the terminal state of a STRUCTURALLY impossible reduction — an F&O ban period, an
   * expired contract, a standing RMS block. The exposure is still held and still reported; what
   * stops is the automatic retry.
   */
  | "broker_rejection_budget_exhausted"
  /** The broker filled it but the durable snapshot failed. Broker truth wins. */
  | "persistence_after_fill"
  /** Ambiguous/timed-out submission, or an intent needing reconciliation. Quarantine. */
  | "broker_state_unknown"
  /**
   * A previous attempt's immutable durable fields collided with this one. Should be impossible
   * now that the generation is part of the identity; if it happens it is a bug, not a market
   * outcome, so it is surfaced and the generation is retired to unblock the exposure.
   */
  | "identity_conflict"
  /**
   * DELIBERATELY NOT SENT: this residual is a LONG option still covering a SHORT residual that is
   * not yet proven closed. Selling it now would convert a covered position into a naked short.
   *
   * This is a SAFE, CORRECT outcome, not a fault. Nothing reached the broker, so the identity is
   * untouched and the next pass reuses it — by which time the short may be closed and the cover
   * genuinely free to release.
   */
  | "hedge_cover_retained"
  /** Anything unclassified. Treated as "nothing proven sent", i.e. the identity is kept. */
  | "unexpected";

/** One residual leg's outcome for one flatten pass. */
export interface ResidualFlattenPass {
  readonly residual: ResidualLegExposure;
  /** Generation actually used for this pass. */
  readonly attempt: number;
  /** The broker order, when one exists (including one carried by an error). */
  readonly order: BrokerOrder | null;
  readonly disposition: ResidualFlattenDisposition;
  readonly failure: ResidualFlattenFailureKind | null;
  readonly detail: string | null;
}

/**
 * The generation to use for this residual's next submission.
 *
 * Legacy rows (written before this field existed) and any corrupt value read as the first
 * attempt, which is the safe reading: the first attempt's identity is adopted rather than
 * duplicated if it happens to already exist durably.
 */
export function residualFlattenAttempt(residual: ResidualLegExposure): number {
  const raw = residual.flatten_attempt;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return FIRST_RESIDUAL_FLATTEN_ATTEMPT;
  const floored = Math.floor(raw);
  return floored >= FIRST_RESIDUAL_FLATTEN_ATTEMPT ? floored : FIRST_RESIDUAL_FLATTEN_ATTEMPT;
}

/**
 * Compose the durable attempt id from the residual's stable scope and its generation.
 *
 * `base` keeps the pre-existing stable scoping (attempt id + residual origin + role), so two
 * different residuals still cannot collide; the `attempt-N` suffix is what makes a RETRY a new
 * logical order. The resulting `client_order_id` reads
 * `BOX:<trade>:EMERGENCY_RESIDUAL:<role>:residual-<role>-<hash>-attempt-<N>`.
 */
export function residualFlattenAttemptId(base: string, attempt: number): string {
  return `${base}-attempt-${Math.max(FIRST_RESIDUAL_FLATTEN_ATTEMPT, Math.floor(attempt))}`;
}

/**
 * Carry a residual forward to the next pass with the generation implied by its disposition.
 *
 * ONLY `retire_attempt` advances. Everything else keeps the identity so the durable journal can
 * adopt whatever the broker actually has.
 */
export interface ResidualFlattenAccounting {
  /**
   * Broker cumulative quantity safely observed for `attempt`, or `undefined` when this pass saw no
   * broker order at all (no executable book, a gate refusal) and therefore observed nothing.
   */
  readonly cumulativeFilled: number | undefined;
  /** Cumulative charge safely observed for `attempt`, `undefined` under the same rule. */
  readonly cumulativeCharges: number | undefined;
}

export function carryResidualForward(
  residual: ResidualLegExposure,
  quantity: number,
  attempt: number,
  disposition: ResidualFlattenDisposition,
  accounting?: ResidualFlattenAccounting,
  /**
   * The failure this pass ended in, when there was one. Only used to count broker rejections, so
   * the bounded retry budget survives a restart — it is persisted by the same atomic `$set` as the
   * quantity and the generation, exactly like the accounting watermarks.
   */
  failure?: ResidualFlattenFailureKind | null,
): ResidualLegExposure {
  const retires = disposition === "retire_attempt";
  const nextAttempt = retires ? attempt + 1 : attempt;
  // A new durable order identity owns a fresh cumulative broker stream. Adopt/reuse retains the
  // exact watermarks so a terminal replay after restart contributes only its positive delta.
  //
  // A pass that observed no broker order at all contributes no watermark, so the residual's own
  // value is preserved — including ABSENT on a pre-watermark legacy row. Writing zero there would
  // destroy the only remaining evidence of what that identity already projected (the immutable
  // quantity on its durable intent), and the next terminal pass would re-credit and re-bill it.
  const accountedFilled = retires ? 0 : accounting?.cumulativeFilled ?? residual.flatten_accounted_filled;
  const accountedCharges = retires ? 0 : accounting?.cumulativeCharges ?? residual.flatten_accounted_charges;
  // CONSECUTIVE rejections, not lifetime ones. The count is deliberately NOT reset when the
  // generation retires — retirement is exactly what a rejection now causes, so resetting there
  // would make the budget infinite and reinstate the unbounded-retry hazard the bound exists to
  // prevent. It IS reset by evidence that the reduction is genuinely possible: any positive fill on
  // this pass (the outstanding quantity shrank) proves the broker will accept this order, so a
  // later unrelated refusal starts from a full budget rather than inheriting old failures.
  const filled = quantity < residual.quantity;
  const priorRejections = filled ? 0 : residualBrokerRejections(residual);
  const rejections = priorRejections + (failure === "broker_rejected" ? 1 : 0);
  const next: ResidualLegExposure = { ...residual, quantity, flatten_attempt: nextAttempt };
  if (accountedFilled === undefined) delete next.flatten_accounted_filled;
  else next.flatten_accounted_filled = accountedFilled;
  if (accountedCharges === undefined) delete next.flatten_accounted_charges;
  else next.flatten_accounted_charges = accountedCharges;
  if (rejections > 0) next.flatten_broker_rejections = rejections;
  else delete next.flatten_broker_rejections;
  return next;
}

/**
 * Classify a broker order returned by a residual submission.
 *
 * Terminal COMPLETE/CANCELLED is the only broker truth that retires an identity when quantity
 * remains. REJECTED also retires — a rejected order holds no quantity, so a fresh identity cannot
 * duplicate a fill, and retaining it stranded the exposure permanently (see
 * {@link dispositionForFailure}). The caller bounds how many rejections are retried.
 * Working/unknown outcomes keep their identity so a second reduction cannot race a fill.
 */
export function classifyResidualOrder(
  order: BrokerOrder,
  requested: number,
): ResidualFlattenDisposition {
  if (!isBrokerOrderTerminal(order.state)) return "adopt_attempt";
  if (order.state === "REJECTED") {
    // A rejection that contradicts an observed fill is NOT zero-exposure truth. The gateway
    // re-verifies this with `verifyZeroBrokerExposure` on the error path; here the snapshot itself
    // is the only evidence, so a non-zero fill keeps the identity for reconciliation.
    return order.filled_quantity > 0 ? "adopt_attempt" : "retire_attempt";
  }
  return order.filled_quantity >= requested ? "flattened" : "retire_attempt";
}

/**
 * Classify a thrown residual submission into a fixed failure kind.
 *
 * Deliberately message-based for the manager's own gate/identity errors: those are plain
 * `Error`s today, and the alternative (typed errors for every gate) is a far larger change to
 * the live order path than this fix should carry. `OrderPersistenceAfterFillError` and the
 * ambiguous-submit family are matched by the caller, which has the class in scope.
 */
export function classifyResidualFlattenErrorMessage(message: string): ResidualFlattenFailureKind {
  if (/reused with different immutable field/i.test(message)) return "identity_conflict";
  if (/already queued or active/i.test(message)) return "already_in_flight";
  if (/unknown|ambiguous|reconcil|timed? ?out/i.test(message)) return "broker_state_unknown";
  if (
    /quantity limits|exposure management|controls or limits|exposure changed while|disabled while/i
      .test(message)
  ) {
    return "gate_refused";
  }
  return "unexpected";
}

/**
 * The disposition implied by a failure kind.
 *
 * `identity_conflict`, `local_pre_submit_refused` and `broker_rejected` may advance the
 * generation; nothing else may.
 */
export function dispositionForFailure(kind: ResidualFlattenFailureKind): ResidualFlattenDisposition {
  switch (kind) {
    case "no_executable_book":
    case "gate_refused":
    case "already_in_flight":
    case "hedge_cover_retained":
      // Nothing reached the broker. The identity is untouched and must be reused.
      return "reuse_attempt";
    case "local_pre_submit_refused":
      // The applied structured audit proves the broker was never called, so a new identity is safe.
      return "retire_attempt";
    case "broker_rejected":
      // RETIRE, BOUNDED — this used to be `adopt_attempt`, and that was the single worst defect in
      // the residual path.
      //
      // `adopt_attempt` does not advance `flatten_attempt`, so the next pass regenerated the same
      // `client_order_id`, the durable journal adopted the REJECTED intent rather than submitting,
      // and NO FURTHER ORDER WAS EVER SENT. One transient refusal — a momentary margin shortfall
      // while another box was legging, a `market_closed` race on the 15:30 boundary, a freeze-
      // quantity or price-band refusal — permanently stranded a naked option leg. New entry stayed
      // blocked (correctly), so the strategy was dead too, until a human noticed.
      //
      // Retiring is safe here, and provably so rather than by assumption: the gateway only reaches
      // this kind after `verifyZeroBrokerExposure(order).proven`. A rejection that contradicts an
      // observed fill is classified `broker_state_unknown` instead and still retains its identity.
      // So at this point the broker holds NO quantity under this identity and a fresh one cannot
      // duplicate a fill.
      //
      // The bound lives in the caller, which counts rejections on the residual and switches to
      // `broker_rejection_budget_exhausted` once the budget is spent — because the thing that must
      // not happen is an UNBOUNDED retry against a structurally impossible reduction.
      return "retire_attempt";
    case "broker_rejection_budget_exhausted":
      // The retry budget is spent. Hold the identity so nothing is re-POSTed, and let the invariant
      // violation carry the exposure to an operator.
      return "adopt_attempt";
    case "identity_conflict":
      // A stale immutable snapshot must never be able to strand exposure. Retire past it.
      return "retire_attempt";
    case "persistence_after_fill":
    case "broker_state_unknown":
      // The broker may hold quantity under this identity. Adopt it; never duplicate it.
      return "adopt_attempt";
    case "unexpected":
      // Nothing is proven. Keeping the identity is the safe default: the durable upsert will
      // adopt an existing submission and only submit when the intent is still CREATED.
      return "adopt_attempt";
  }
}

/**
 * Stable human phrase per failure kind, used in the invariant/operator message.
 *
 * Fixed wording so the operator-facing text is a contract rather than an accident of whatever
 * an exception happened to say — and so the message stays greppable across refactors.
 */
export function residualFailurePhrase(kind: ResidualFlattenFailureKind): string {
  switch (kind) {
    case "no_executable_book": return "no executable book on the reducing side";
    case "gate_refused": return "an order-manager gate refused the reduction before the broker";
    case "already_in_flight": return "the same attempt is already queued or in flight";
    case "local_pre_submit_refused": return "current executable-feed authority refused before broker POST";
    case "broker_rejected": return "the broker terminally rejected the reduction";
    case "broker_rejection_budget_exhausted":
      return `the broker rejected this reduction ${MAX_RESIDUAL_BROKER_REJECTIONS} times running ` +
        `with zero fill each time; automatic retry has STOPPED and the exposure is still held — ` +
        `check for an F&O ban period, an expired contract, an RMS block or a margin shortfall, ` +
        `then flatten manually`;
    case "persistence_after_fill": return "filled but its durable snapshot failed";
    case "broker_state_unknown": return "uncertain broker terminal quantity; quarantined for reconciliation";
    case "identity_conflict": return "a stale durable intent blocked this attempt; the generation was retired past it";
    case "hedge_cover_retained":
      return "held back as cover: it is long protection against a short residual that is not yet proven closed";
    case "unexpected": return "an unclassified internal fault";
  }
}

/**
 * True when a failure kind must be raised as an invariant violation rather than counted as a
 * routine market outcome. A technical fault is not a market outcome.
 *
 * `broker_rejection_budget_exhausted` is included because held exposure the engine has STOPPED
 * trying to reduce is not a market outcome either — it is the one residual state that requires a
 * human, so it must reach the operator surface rather than being counted quietly.
 */
export function residualFailureIsInvariant(kind: ResidualFlattenFailureKind): boolean {
  return kind === "persistence_after_fill" ||
    kind === "broker_state_unknown" ||
    kind === "identity_conflict" ||
    kind === "broker_rejection_budget_exhausted" ||
    kind === "unexpected";
}
