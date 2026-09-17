import type { BrokerOrder, BrokerOrderRequest } from "./brokerAdapter.js";
import {
  BrokerAmbiguousSubmitError,
  BrokerCancelNotTransmittedError,
  BrokerCancelUnresolvedError,
  BrokerOrderRejectedError,
  BrokerPreSubmitRefusedError,
  boxClientOrderId,
  isBrokerOrderTerminal,
} from "./brokerAdapter.js";
import {
  planPartialEntryRecovery,
  verifyQuantityConservation,
  type EntryLegOutcome,
  type PartialEntryPlan,
} from "./partialEntryRecovery.js";
import {
  boxCapitalSummary,
  buildEconomicPicture,
  evaluateBoxCapitalAdmission,
  evaluateEconomicAdmission,
  grossEntryOrderNotional,
  type BoxCapitalReport,
  type EconomicAdmissionReport,
} from "./boxCapital.js";
import { buildFundingReadiness, type FundingReadiness } from "./fundingReadiness.js";
import {
  ageEvidence,
  identityMismatch,
  monoElapsed,
  orderPlanFingerprint,
  readEvidence,
  type EvidenceClock,
  type EvidenceIdentity,
  type EvidenceInstant,
} from "./evidenceTiming.js";
import { monotonicNow } from "../brokers/deadline.js";
import { entrySubmissionOrder } from "./entrySubmissionOrder.js";
import {
  planExitDependencies,
  releasableHedgeQuantity,
  verticalPartner,
} from "./exitDependencies.js";
import { evaluateLiveEntryGuard, stillWantedSafely } from "./liveEntryGuard.js";
import {
  evaluateBookCoherence,
  livePolicyFromConfig,
  recheckBookCoherence,
  type CoherenceDecision,
  type CoherenceLegObservation,
} from "./executionCoherence.js";
import {
  OrderPersistenceAfterFillError,
  type BoxOrderManager,
  type CheckedFeedStamp,
  type EntryCapitalStamp,
} from "./orderManager.js";
import {
  carryResidualForward,
  classifyResidualFlattenErrorMessage,
  classifyResidualOrder,
  dispositionForFailure,
  residualFailureIsInvariant,
  residualFailurePhrase,
  residualFlattenAttempt,
  residualFlattenAttemptId,
  FIRST_RESIDUAL_FLATTEN_ATTEMPT,
  MAX_RESIDUAL_FLATTEN_ATTEMPT_PROBE,
  type ResidualFlattenFailureKind,
  type ResidualFlattenPass,
} from "./residualFlatten.js";
import type { BoxConfig } from "./config.js";
import type {
  BoxEntryExecutionResult,
  BoxExitExecutionResult,
  BoxLeggingResult,
  BoxExecutionSimulator,
} from "./executionSimulator.js";
import { entrySideFor, exitSideFor, round2 } from "./math.js";
import { usableFundsRupees } from "./fundsSemantics.js";
import { buildOrderPricing, touchPrice, walkDepth } from "./orderPricing.js";
import { outstandingRoles, type BoxOpenPosition } from "./positions.js";
import { singleLotCandidateViolation } from "./singleLotInvariant.js";
import type { BoxQuoteStore } from "./quotes.js";
import {
  BOX_LEG_ROLES,
  directionSign,
  isPaperExecutionMode,
  statedExecutionMode,
  type BoxCandidate,
  type BoxDirection,
  type BoxEntryDecision,
  type BoxEvaluation,
  type BoxExecutionFailureReason,
  type BoxExecutionRecord,
  type BoxLegEvaluation,
  type BoxLegRole,
  type BoxOptionInstrument,
  type IBoxOrderIntent,
  type OrderSide,
  type PaperLegExecution,
  type PaperLeggingExecutionRecord,
  type ResidualLegExposure,
} from "./types.js";

/**
 * One exit leg's authoritative outcome within a wave.
 *
 * `certain` is the safety question: may the paired hedge be released on the strength of this?
 * Only a TERMINAL broker snapshot ({@link isBrokerOrderTerminal}), or a proven local refusal that
 * never reached the broker, answers yes. A PARTIALLY_FILLED snapshot is deliberately NOT certain —
 * it can still fill more, and sizing a hedge release from it is exactly the "guess a quantity while
 * an order can still fill" that the contract forbids. See exitDependencies.ts.
 *
 * This is a STRICTER notion than the `uncertain` flag that drives the invariant/recovery path,
 * which keeps its original meaning (an unprovable broker outcome). Holding a hedge on a live
 * partial is the safe side and must not, by itself, trip the breaker.
 */
interface ExitWaveOutcome {
  readonly filled: number;
  readonly certain: boolean;
}

/** Narrow strategy-facing execution seam shared by scanner, monitor and recovery. */export interface BoxExecutionGateway {
  readonly mode: BoxConfig["executionMode"];
  hasCapacity(): boolean;
  simulateEntry(args: Parameters<BoxExecutionSimulator["simulateEntry"]>[0]): Promise<BoxEntryExecutionResult>;
  simulateLeggingEntry(args: Parameters<BoxExecutionSimulator["simulateLeggingEntry"]>[0]): Promise<BoxLeggingResult>;
  simulateExit(args: Parameters<BoxExecutionSimulator["simulateExit"]>[0]): Promise<BoxExitExecutionResult>;
  simulateLeggingExit(args: Parameters<BoxExecutionSimulator["simulateLeggingExit"]>[0]): ReturnType<BoxExecutionSimulator["simulateLeggingExit"]>;
  estimateExecutableExit(position: BoxOpenPosition, now?: number): ReturnType<BoxExecutionSimulator["estimateExecutableExit"]>;
  flattenResidual(args: Parameters<BoxExecutionSimulator["flattenResidual"]>[0]): ReturnType<BoxExecutionSimulator["flattenResidual"]>;
  invariantViolation(reason: string): void;
}

/**
 * Re-check a gateway admission stamp against the newest book in the SAME socket
 * generation. A newer book may proceed only when it still executes the immutable
 * quantity within the immutable bounded LIMIT; generation changes always refuse.
 */
/**
 * Make a withheld-leg reason safe to embed in the exit `detail` string.
 *
 * WHY THIS IS NOT COSMETIC. `positionMonitor.applyLeggingExitResult` decides whether a failed exit
 * sends the position to RECOVERY by matching `/uncertain|reconcil/i` against `result.detail`. A
 * withheld leg is the OPPOSITE of uncertain — nothing was transmitted, so zero filled is proven —
 * and it must not be classified as an unprovable outcome. Since a per-leg reason can now carry
 * arbitrary broker/pricing error text into that string, the two words the classifier keys on are
 * neutralised here rather than left to chance.
 *
 * The reason stays fully readable for the operator; only the classifier's trigger tokens are broken.
 */
function withheldReason(reason: string): string {
  return reason
    .replace(/uncertain/gi, "not-established")
    .replace(/reconcil/gi, "re-check");
}

export function checkedFeedBlockReason(args: {
  request: BrokerOrderRequest;
  stamp: CheckedFeedStamp | undefined;
  currentGeneration: number;
  tokenCurrent: boolean;
  quote: ReturnType<BoxQuoteStore["get"]>;
  now: number;
  quoteMaxAgeMs: number;
  queueModel: BoxConfig["queueModel"];
  queueLiquidityHaircutPct: number;
}): string | null {
  const { request, stamp, quote } = args;
  if (!stamp) return "checked executable-feed evidence is missing";
  if (stamp.token !== request.token) return "checked executable-feed token does not match request";
  if (stamp.feed_generation !== args.currentGeneration) return "feed generation changed while order was queued";
  if (!args.tokenCurrent) return "token has no executable book in the current feed generation";
  if (!quote) return "current executable book is absent";
  if (!Number.isSafeInteger(stamp.quote_version) || quote.version < stamp.quote_version || quote.at < stamp.quote_at) {
    return "executable book identity regressed after bounded-depth admission";
  }
  const age = args.now - quote.at;
  if (!Number.isFinite(stamp.checked_at) || stamp.checked_at < stamp.quote_at || stamp.checked_at > args.now ||
      !Number.isFinite(age) || age < 0 || age > args.quoteMaxAgeMs) {
    return "checked executable book is stale or has invalid timing";
  }
  const walk = walkDepth({
    side: request.side,
    levels: request.side === "BUY" ? quote.asks : quote.bids,
    remainingQty: request.quantity,
    limitPrice: request.pricing.limit_price,
    queueModel: args.queueModel,
    haircutPct: args.queueLiquidityHaircutPct,
    at: quote.at,
    quoteVersion: quote.version,
  });
  return walk.executable_within_limit >= request.quantity
    ? null
    : "current executable book no longer covers bounded order quantity";
}

/**
 * Central execution facade. Paper modes delegate byte-for-byte to the existing
 * deterministic simulator; live mode emits bounded LIMIT intents through the
 * durable BoxOrderManager and trusts broker cumulative fills only.
 */
export class CentralBoxExecutionGateway implements BoxExecutionGateway {
  readonly mode: BoxConfig["executionMode"];
  /** The most recent per-Box capital decision, for status. Never a correctness input. */
  private lastCapitalReport: BoxCapitalReport | null = null;
  /** The most recent economic-admission decision (five distinct quantities), for status. */
  private lastEconomicReport: EconomicAdmissionReport | null = null;
  /**
   * The evidence that admitted the CURRENT entry attempt, retained so the final send boundary can
   * re-check expiry, identity and the order plan WITHOUT re-fetching from the broker. Null when no
   * economic control is enabled or admission was refused.
   */
  private economicEvidence: {
    readonly fundsObservedAtMono: number | null;
    readonly marginObservedAtMono: number | null;
    readonly fundsMaxAgeMs: number;
    readonly marginMaxAgeMs: number;
    readonly planFingerprint: string;
    readonly identity: EvidenceIdentity | null;
    readonly fundsRequired: boolean;
    readonly marginRequired: boolean;
  } | null = null;

  constructor(private readonly deps: {
    cfg: BoxConfig;
    simulator: BoxExecutionSimulator;
    quotes: BoxQuoteStore;
    manager?: BoxOrderManager;
    /** The active broker, for attributing a capital refusal. Diagnostics only. */
    broker?: () => string;
    /**
     * A restored record was refused because its execution mode is not this process's.
     *
     * NOT diagnostics. A refused exit means exposure this process cannot reduce, which the operator
     * must be told about — the engine turns this into a `reduction`-scoped readiness blocker. Optional
     * only so existing wiring and tests construct the gateway unchanged; absent ⇒ the refusal still
     * happens, it is merely not surfaced.
     */
    onExecutionModeMismatch?: (detail: string) => void;
    /** Allocates the Mongo identity before any live intent is created. */
    allocateTradeId?: () => string;
    isTokenWarm?: (token: number) => boolean;
    /** Current socket generation, captured with each checked executable book. */
    feedGeneration?: () => number;
    /**
     * MARKET-DATA READINESS gate for NEW ENTRY (GAP 1). When supplied and it reports NOT permitted,
     * a live entry is refused at the cheapest checkpoint (before any request is built or any
     * exposure is created). The driven MarketDataStateMachine gates entry on READY: a socket that
     * has merely opened, a partly-restored subscription set, a heartbeat gap, a stale book or an
     * ingestion backlog all report NOT permitted with the state as the reason. Absent (paper, and
     * older single-broker wiring) ⇒ no additional gate, preserving prior behaviour exactly.
     */
    marketDataEntryPermitted?: () => { permitted: boolean; state: string };
    /**
     * CANDIDATE-SCOPED market-data admission for THIS box's four instruments.
     *
     * Separate from `marketDataEntryPermitted` on purpose. That one answers "is the transport
     * healthy?" — a shared condition. This one answers "do these four legs have admissible evidence
     * right now?" — and it is the check that used to be missing, which is why the transport gate had
     * been quietly overloaded into a universe-wide per-instrument gate that one unrelated stale
     * strike could fail. See box/candidateMarketData.ts.
     *
     * Consulted at the entry checkpoint AND again immediately before exposure-increasing submission,
     * because everything in between takes real time.
     */
    candidateMarketDataAdmissible?: (candidate: BoxCandidate) => {
      permitted: boolean;
      reason: string;
      sharedFailure: boolean;
    };
    now?: () => number;
    /**
     * Total charges (₹) for a set of orders, from the LOCAL fee calculator.
     *
     * Needed so LIVE residual flattening bills its own brokerage/taxes. Previously the live branch
     * returned a hard `flatten_charges: 0`, which meant the fees on real EMERGENCY_RESIDUAL orders
     * were never even estimated — a genuine cost silently absent from the trade's accounting.
     */
    chargeTotal?: (orders: { side: OrderSide; tradingsymbol: string; quantity: number; price: number }[]) => number;
    /**
     * FRESH available-funds evidence for the active broker account (Task 8, economic admission).
     *
     * Sourced from a SUPPORTED broker facility (the adapter's own margins()), returning the
     * available balance and the wall-clock time it was observed. Returning null — or a stale
     * observedAt — makes the economic gate treat funds as unavailable and REFUSE rather than
     * assume the account can fund the entry. Only consulted when a control needs it.
     */
    /**
     * FRESH broker-confirmed funds evidence.
     *
     * `utilisedRupees` is the ACCOUNT ENCUMBRANCE — funds already blocked by other open orders and
     * positions — read from the SAME funds response as `availableRupees`, so the two can never
     * disagree with each other. It was previously read from the broker and discarded, which left the
     * stage-funding model with no encumbrance and therefore no establishable requirement.
     *
     * Both fields are `null` for MISSING and never for zero. A reported zero is a real figure; an
     * absent one must refuse. `Number.isFinite(0)` is true, so presence is the provider's job to
     * signal and is never inferred from the value.
     */
    funds?: () => Promise<{
      availableRupees: number | null;
      utilisedRupees?: number | null;
      observedAt: number;
    } | null>;
    /**
     * FRESH broker-confirmed planned-margin evidence for the four-leg entry (Task 8).
     *
     * A basket/multi-order margin estimate from a supported broker facility, with its observed-at
     * time. When the margin-evidence control is enabled and this is absent/stale the gate FAILS
     * CLOSED. Never fabricated from the gross cap or the net debit.
     *
     * SECTION 8: `initialMarginRupees` and `finalMarginRupees` are kept SEPARATE and must not be
     * collapsed. Kite documents them as "Total margins required to execute the orders" (initial)
     * versus "Total margins with the spread benefit" (final) — in Zerodha's own example ₹96,504.98
     * vs ₹34,786.73 for the same basket. `final` describes the COMPLETED structure and is not proof
     * that the account can fund the sequence which creates it, so the stage model needs both.
     * `encumbranceRupees` is ₹ already blocked by other open orders/positions, when observable;
     * null means UNKNOWN, never zero.
     */
    plannedMargin?: (
      requests: readonly BrokerOrderRequest[],
    ) => Promise<{
      marginRupees: number | null;
      observedAt: number;
      initialMarginRupees?: number | null;
      finalMarginRupees?: number | null;
      encumbranceRupees?: number | null;
    } | null>;
    /**
     * MONOTONIC clock for measuring durations (evidence aging, read deadlines).
     *
     * Separate from `now` on purpose: `now` is the WALL clock used for audit stamps and can step
     * backward under NTP, which is exactly how a freshness check gets fooled. Absent ⇒
     * `performance.now()`.
     */
    monotonicNow?: () => number;
    /**
     * WHO the economic evidence is about — broker, masked account reference, session/token
     * generation. Read before AND after the asynchronous evidence reads so a broker switch, token
     * rotation onto a different account, or session restart in flight invalidates the evidence
     * instead of admitting an entry against the wrong account.
     */
    evidenceContext?: () => EvidenceIdentity | null;
  }) {
    this.mode = deps.cfg.executionMode;
  }

  hasCapacity(): boolean {
    if (this.mode !== "live") return this.deps.simulator.hasCapacity();
    if (!this.deps.manager) return false;
    const status = this.deps.manager.status();
    // One Box pipeline owns all queued role-orders. Counting only the currently
    // active role creates a micro-window between roles where a second candidate
    // can enter; require both the active slot and priority queue to be empty.
    return status.inFlight === 0 && status.queued === 0;
  }

  simulateEntry(args: Parameters<BoxExecutionSimulator["simulateEntry"]>[0]): Promise<BoxEntryExecutionResult> {
    return this.deps.simulator.simulateEntry(args);
  }

  async simulateLeggingEntry(args: Parameters<BoxExecutionSimulator["simulateLeggingEntry"]>[0]): Promise<BoxLeggingResult> {
    if (this.mode !== "live") return this.deps.simulator.simulateLeggingEntry(args);
    const manager = this.requireManager();
    const quantityViolation = singleLotCandidateViolation(args.candidate);
    if (quantityViolation) {
      manager.invariantViolation(`live entry ${args.candidate.key} violated single-lot invariant: ${quantityViolation}`);
      return liveEntryFailure(
        args.candidate,
        args.detection.at,
        this.now(),
        [],
        "insufficient_quantity",
        `single-lot entry invariant refused execution: ${quantityViolation}`,
        this.deps.cfg,
        null,
      );
    }
    const attemptId = stableAttemptId(args.candidate.key, args.detection.at, "ENTRY");
    const tradeId = this.deps.allocateTradeId?.();
    if (!tradeId) {
      manager.invariantViolation(`live entry ${attemptId} has no preallocated durable trade identity`);
      return liveEntryFailure(args.candidate, args.detection.at, this.now(), [], "legging_incomplete", "durable trade identity allocation failed; entry blocked", this.deps.cfg, null);
    }
    // ── CHECKPOINT 1 of 5: BEFORE BUILDING ANYTHING ──────────────────────────────────────
    //
    // `args.stillWanted` is the predicate the COORDINATOR composed: the caller's own condition
    // folded together with "do we still hold the reservation lease" (see
    // executionCoordinator.ownershipGuard). Until this fix the live path never called it — only
    // the paper simulator did — so a Box whose lease had been lost still POSTed all four legs.
    //
    // Cheapest possible refusal: no requests, no durable rows, no exposure.
    const submittedAt = this.now();
    const wantedAtBuild = this.entryGuardRefusal(args.stillWanted, "pre_build");
    if (wantedAtBuild) return this.refusedBeforeSubmit(args, submittedAt, tradeId, wantedAtBuild);

    // ── MARKET-DATA READINESS: gate NEW ENTRY on READY (GAP 1) ─────────────────────────────
    //
    // The driven MarketDataStateMachine only reports permitted when the feed is authenticated AND
    // every traded instrument has fresh usable depth in the CURRENT generation. A socket that has
    // merely opened, a partly-restored subscription set after a reconnect, a heartbeat gap, a
    // stale book, or an ingestion backlog all refuse here — at the cheapest checkpoint, before any
    // request is built or any exposure is created. This is ENTRY-ONLY: protective cancel, exit and
    // attributed reduction are never routed through here and are never blocked by it.
    const mdGate = this.deps.marketDataEntryPermitted?.();
    if (mdGate && !mdGate.permitted) {
      return liveEntryFailure(
        args.candidate,
        args.detection.at,
        submittedAt,
        [],
        "feed_unhealthy",
        `market-data/order-stream transport does not license new entry (state ${mdGate.state})`,
        this.deps.cfg,
        tradeId,
      );
    }

    // ── CANDIDATE-SCOPED MARKET-DATA EVIDENCE ──────────────────────────────────────────────
    //
    // The transport gate above is a SHARED condition: it says the socket is authenticated, live,
    // un-backlogged and delivering depth. It deliberately no longer asserts anything about a
    // PARTICULAR instrument, because it used to be handed the entire streamed option universe as its
    // "desired" set and one illiquid strike in an unrelated underlying therefore refused every box.
    //
    // The per-instrument strictness lives here instead, scoped to the four legs actually being
    // entered: each leg subscribed, each leg with fresh usable depth in the CURRENT generation, each
    // leg's book present and within both the locally-measured and source freshness bounds, executable
    // -side price and depth for the quantity we intend to send, a coherent (uncrossed) snapshot, lot
    // and tick conformance, and an unexpired contract. An unrelated stale token cannot fail this; a
    // genuinely shared transport failure already failed above.
    const candidateGate = this.deps.candidateMarketDataAdmissible?.(args.candidate);
    if (candidateGate && !candidateGate.permitted) {
      return liveEntryFailure(
        args.candidate,
        args.detection.at,
        submittedAt,
        [],
        "feed_unhealthy",
        candidateGate.reason,
        this.deps.cfg,
        tradeId,
      );
    }

    const requests: BrokerOrderRequest[] = [];
    let checkedFeed = new Map<string, CheckedFeedStamp>();
    // HEDGE-FIRST TRANSPORT ORDER (see entrySubmissionOrder.ts). Requests are built — and
    // therefore enqueued, and therefore POSTed — BUY hedges first. Under the canonical role order
    // a SHORT_BOX sent its naked SELL first and hedged it second; this makes that impossible.
    // Role identities, sides, quantities and the four-leg economics are untouched: only the
    // sequence changes, and every downstream figure is keyed by role, never by position.
    const submissionOrder = entrySubmissionOrder(args.candidate.direction);
    const hedgeCount = submissionOrder.filter((slot) => slot.hedge).length;
    try {
      for (const slot of submissionOrder) {
        const leg = args.detection.legs.find((item) => item.role === slot.role);
        if (!leg || leg.price === null) throw new Error(`No executable reference price for ${slot.role}.`);
        requests.push(this.request({
          role: slot.role,
          inst: args.candidate.legs[slot.role],
          side: entrySideFor(slot.role, args.candidate.direction),
          quantity: args.candidate.lot_size,
          referencePrice: leg.price,
          tradeId,
          attemptId,
          purpose: "ENTRY",
          phase: "entry",
        }));
      }
      checkedFeed = this.precheck(requests);
    } catch (error) {
      return liveEntryFailure(args.candidate, args.detection.at, submittedAt, [], "insufficient_quantity", errorMessage(error), this.deps.cfg, tradeId);
    }

    // ── FOUR-LEG BOOK COHERENCE: the live ADMISSION gate ───────────────────────────────────
    //
    // THE FIX. Until now this constraint lived ONLY in the paper simulator, so the live gateway
    // admitted four books spread thousands of ms apart as long as each individual quote age stayed
    // under the per-leg allowance — per-leg freshness is blind to cross-leg skew. The SAME shared
    // policy the paper path uses is enforced here, from the CURRENT books, before any exposure.
    //
    // Receive-time is the always-available cross-sectional bound (Dhan carries no book exchange
    // timestamp; Kite's is 1s-granular). Exchange-time dispersion is layered on only when every
    // leg carries a real one. Receive-time coherence proves the four packets ARRIVED together, not
    // that the exchange PUBLISHED them together — see executionCoherence.ts.
    const admission = this.evaluateEntryCoherence(args.candidate, submittedAt);
    if (!admission.admit) {
      const rejected = liveEntryFailure(
        args.candidate,
        args.detection.at,
        submittedAt,
        [],
        "cross_leg_time_skew",
        `four-leg coherence refused entry [${admission.reason}]: ${admission.detail}`,
        this.deps.cfg,
        tradeId,
      );
      rejected.legging.temporal = admission.temporal;
      rejected.legging.outcome_class = "REFUSED_BEFORE_SUBMIT";
      return rejected;
    }

    // ── MAXIMUM ₹ PER BOX: the authoritative pre-trade gate ────────────────────────────────
    //
    // Evaluated HERE, from the four IMMUTABLE bounded LIMIT requests that would be
    // transmitted, and BEFORE the first `manager.submit`. Two properties matter:
    //
    //   1. It uses the actual order LIMIT prices, never an LTP or a mid. A cap checked against
    //      a stale last-traded price is not a cap on what the orders can transact.
    //   2. Nothing has reached the broker yet, so a refusal here is a genuine PRE-TRADE
    //      refusal with no exposure to unwind.
    //
    // A quantity/price change between detection and here is therefore already accounted for:
    // the requests were rebuilt from the current book a few lines above.
    const capital = this.evaluateEntryCapital(requests, args.candidate, "pre_submit");
    this.lastCapitalReport = capital;
    if (!capital.allowed) {
      return liveEntryFailure(
        args.candidate,
        args.detection.at,
        submittedAt,
        [],
        "box_capital_limit",
        capital.detail ?? "per-Box capital limit refused entry",
        this.deps.cfg,
        tradeId,
      );
    }

    // ── ECONOMIC ADMISSION: FRESH funds / broker-margin evidence (Task 8) ──────────────────
    //
    // A DISTINCT gate from the gross-notional cap above. Where the cap bounds gross option-order
    // notional, this proves the account can actually FUND the entry, using freshly observed broker
    // evidence — never the cap as a stand-in for a budget, never the net debit as a stand-in for
    // the requirement. Enabled only when the operator asks for it (funds-cover or margin-evidence);
    // when enabled, MISSING or STALE evidence REFUSES rather than assumes. Runs on the SAME four
    // immutable requests, still before any leg is sent, so a refusal is a free pre-submit refusal.
    const economic = await this.evaluateEntryEconomics(requests, args.candidate.direction ?? "LONG_BOX");
    if (economic && !economic.allowed) {
      const rejected = liveEntryFailure(
        args.candidate,
        args.detection.at,
        submittedAt,
        [],
        "box_capital_limit",
        `economic admission refused entry [${economic.reasons.join(",")}]: ${economic.detail ?? "insufficient economic evidence"}`,
        this.deps.cfg,
        tradeId,
      );
      rejected.legging.outcome_class = "REFUSED_BEFORE_SUBMIT";
      return rejected;
    }

    // ── RE-VALIDATE THE CANDIDATE AFTER THE ASYNCHRONOUS EVIDENCE READS ──────────────────
    //
    // Section 3 requirement 11. The funds/margin reads above are real broker round trips: the
    // scanner can have withdrawn the candidate (STOP, budget exhausted, the opportunity closed) or
    // the session can have been disarmed while we were waiting. Still nothing has been transmitted,
    // so this remains a free refusal — and skipping it would mean entering a box nobody wants any
    // more purely because the decision to enter predated the evidence.
    const wantedAfterEvidence = this.entryGuardRefusal(args.stillWanted, "post_evidence");
    if (wantedAfterEvidence) {
      return this.refusedBeforeSubmit(args, submittedAt, tradeId, wantedAfterEvidence);
    }

    // The Box-level decision is stamped onto every leg so the manager can RE-VERIFY it at
    // dequeue, the last safe moment before a broker mutation. A per-leg check could not: the
    // cap is a property of the whole four-leg set, which no single leg can see.
    const capitalStamp: EntryCapitalStamp = {
      candidate_key: args.candidate.key,
      box_notional_paise: capital.metrics.gross_entry_order_notional_paise,
      configured_max_rupees: capital.configured_max_rupees,
      checked_at: capital.at,
    };

    // ── CHECKPOINT 2 of 5: IMMEDIATELY BEFORE ENQUEUE ────────────────────────────────────
    // Everything above — building four requests, the depth precheck, the capital evaluation — took
    // real time. Still nothing has been transmitted, so this remains a free refusal.
    const wantedAtEnqueue = this.entryGuardRefusal(args.stillWanted, "pre_enqueue");
    if (wantedAtEnqueue) return this.refusedBeforeSubmit(args, submittedAt, tradeId, wantedAtEnqueue);

    // ── COHERENCE RE-CHECK against CURRENT evidence, immediately before transmit ────────────
    //
    // A book coherent at admission can be stale by the time the legs transmit — building four
    // requests, the depth precheck and the capital evaluation all took real time. Re-run the SAME
    // decision on the CURRENT books, plus a duplicate/stall guard, so a box that deteriorated
    // between admission and send is refused before any exposure rather than after leg 4.
    const recheck = this.recheckEntryCoherence(args.candidate, this.now());
    if (!recheck.admit) {
      const rejected = liveEntryFailure(
        args.candidate,
        args.detection.at,
        submittedAt,
        [],
        "cross_leg_time_skew",
        `four-leg coherence deteriorated before transmit [${recheck.reason}]: ${recheck.detail}`,
        this.deps.cfg,
        tradeId,
      );
      rejected.legging.temporal = recheck.temporal;
      rejected.legging.outcome_class = "REFUSED_BEFORE_SUBMIT";
      return rejected;
    }

    // The guard travels WITH each leg, alongside its hedge-first rank, so the manager can
    // re-evaluate it at dequeue, after durable persistence, and at the final pre-POST boundary.
    // It is passed for ENTRY legs ONLY; exits and reductions never receive one and so can never be
    // refused by it.
    const rankByRole = new Map(submissionOrder.map((slot) => [slot.role, slot]));
    const settled = await Promise.allSettled(
      requests.map((request) => {
        const slot = rankByRole.get(request.role);
        return manager.submit(request, checkedFeed.get(request.client_order_id), capitalStamp, {
          stillWanted: () => (args.stillWanted ? args.stillWanted() : true),
          transportRank: slot?.rank ?? 0,
          hedge: slot?.hedge ?? false,
          hedgeCount,
          // DEFECT C. The SAME four-leg decision, re-run against the CURRENT books at the real send
          // boundary — after queueing, durable persistence, the hedge-first barrier and adapter
          // pacing. The gateway supplies it because it is the only layer that can see all four
          // books, the socket generation and the configured policy. The manager decides WHEN to
          // honour it (no exposure ⇒ refuse; exposure taken ⇒ complete and record).
          sendBoundaryCoherence: () => {
            // RE-ASK THE CANDIDATE-SCOPED MARKET-DATA QUESTION AT THE SEND BOUNDARY.
            //
            // The checkpoint version of this ran before requests were built, before queueing, and
            // before the funding and economics work — all of which takes real time. A socket can die,
            // a generation can advance, a leg's book can go stale or lose its executable side in that
            // window, and the whole point of the send boundary is that exposure-increasing orders are
            // authorised by evidence that is current AT THE MOMENT OF THE POST, not by evidence that
            // was current when the opportunity was scored. A frontend opportunity card, and equally a
            // checkpoint verdict from 300ms ago, is not admission authority.
            const md = this.deps.candidateMarketDataAdmissible?.(args.candidate);
            if (md && !md.permitted) return `[feed_unhealthy] ${md.reason}`;
            const verdict = this.recheckEntryCoherence(args.candidate, this.now());
            return verdict.admit
              ? null
              : `[${verdict.reason}] ${verdict.detail}`;
          },
          // SECTION 3 requirement 12. The economic half of the same boundary: evidence that has
          // EXPIRED, an account/session that has CHANGED, or an order plan that no longer matches
          // the one the margin figure was computed for must all refuse the POST while there is
          // still no exposure. The manager decides WHEN to honour it, using the same rule as the
          // coherence check (no exposure ⇒ refuse; exposure taken ⇒ complete and record).
          sendBoundaryEconomics: (candidateRequest?: BrokerOrderRequest) =>
            this.economicSendBoundary(candidateRequest ?? request),
        });
      }),
    );
    // Canonical role order for OUTPUT/accounting; the POSTs above were hedge-first.
    const orders = canonicalRoleOrder(ordersFromSettled(settled));
    /*
     * AN ABSENT RESULT MEANS "NEVER SUBMITTED" ONLY WITH EXPLICIT PROOF.
     *
     * Uncertainty used to be recognised by listing the ways it can look — a type here, some words in a
     * message there — so anything unrecognised defaulted to "certain, nothing happened", and recovery
     * then unwound hedges protecting an order that might exist. That default is the wrong way round.
     *
     * These two types are the ONLY proof that no exposure was created: a local pre-submit refusal
     * (thrown before the HTTP request, so provably no POST) and a definitive broker rejection (the
     * broker itself said the order does not exist). Every other rejection — a transport fault, a
     * database failure while recording, an error type nobody has thought of yet — leaves the outcome
     * unproven, and unproven must mean uncertain.
     */
    const provenNoExposure = (reason: unknown): boolean =>
      reason instanceof BrokerPreSubmitRefusedError || reason instanceof BrokerOrderRejectedError;
    const uncertain = settled.some((item) => item.status === "rejected" && !provenNoExposure(item.reason)) ||
      settled.some((item) => item.status === "rejected" &&
      (item.reason instanceof OrderPersistenceAfterFillError ||
        /*
         * DECIDED BY TYPE, NOT BY THE WORDS IN A MESSAGE.
         *
         * This was a regex over `error.message` alone. A cancellation withdrawn while still queued means
         * the ENTRY LEG IS STILL WORKING AT THE BROKER, but `BrokerCancelNotTransmittedError`'s message
         * contains none of "unknown", "ambiguous" or "reconcil" — so `uncertain` came out FALSE,
         * `entryLegOutcomes` reported the leg as never submitted, and `planPartialEntryRecovery` unwound
         * the siblings' CONFIRMED FILLS against a live leg. The regex remains as a backstop for untyped
         * errors, but a type whose entire contract is "the outcome is not proven" must never depend on
         * its prose to be recognised.
         */
        item.reason instanceof BrokerCancelNotTransmittedError ||
        item.reason instanceof BrokerCancelUnresolvedError ||
        item.reason instanceof BrokerAmbiguousSubmitError ||
        /unknown|ambiguous|reconcil/i.test(errorMessage(item.reason)))) ||
      orders.some((order) => order.state === "UNKNOWN" || order.state === "RECONCILIATION_REQUIRED");
    if (uncertain) {
      manager.invariantViolation(`live entry ${attemptId} has uncertain broker terminal quantity`);
      return liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "legging_incomplete", "broker terminal quantity is uncertain; entry quarantined", this.deps.cfg, tradeId);
    }

    // `>=`, not `===`. A broker reporting MORE filled than requested is an anomaly, but it is an
    // anomaly in which the four-leg box is unambiguously ON — the requested quantity is covered.
    // Under `===` an overfill read as "not fully filled" and sent a complete, hedged box straight
    // into a four-leg protective unwind, paying a full round trip plus charges to reverse a
    // position that was actually correct. Overfill is detected and quarantined by the cumulative
    // fill ledger, which is where that belongs; it must not also be mistaken for underfill here.
    const fullyFilled =
      orders.length === requests.length && orders.every((order) => order.filled_quantity >= order.quantity);
    if (!fullyFilled) {
      // ── PARTIAL ENTRY: the explicit, ordered recovery sequence ───────────────────────
      //
      // The RULE is unchanged: if all four legs did not reach their requested quantity there is
      // no valid Box, and the trade record is never opened as one. What is new is that the
      // recovery is now DECIDED by a pure, testable plan rather than implied by control flow.
      //
      // Steps 1-3 of the sequence are already guaranteed upstream and are asserted here rather
      // than re-implemented: `adapter.submitOrder` polls to a terminal state (protectively
      // cancelling on timeout), and the `uncertain` check above has already quarantined anything
      // whose terminal quantity is unprovable. So every order in hand is terminal with a
      // broker-confirmed cumulative quantity, which is the only basis on which an unwind may be
      // sized — a cancel can race a fill, so a pre-terminal snapshot would strand the raced part.
      const plan = planPartialEntryRecovery({
        legs: entryLegOutcomes(requests, orders),
        expectedRoles: BOX_LEG_ROLES,
      });

      // DEFENCE IN DEPTH. Unreachable given the guarantees above, but if a future change ever
      // lets a non-terminal or unprovable leg reach here, quarantine — never unwind. Unwinding an
      // unproven quantity would create opposite naked exposure, which is strictly worse than the
      // exposure it was trying to remove.
      if (plan.action === "quarantine_unknown" || plan.action === "await_terminal") {
        manager.invariantViolation(
          `live entry ${attemptId} reached partial-entry recovery with a non-terminal or unprovable leg ` +
            `(${plan.action}); quarantined instead of unwinding`,
        );
        const quarantined = liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "legging_incomplete", `entry quarantined: ${plan.detail}`, this.deps.cfg, tradeId);
        quarantined.legging.outcome_class = "QUARANTINED_UNKNOWN";
        return quarantined;
      }

      // Steps 4-6: unwind EXACTLY the confirmed exposure, per role, at the reversed side. Skipped
      // entirely when nothing filled — there is no exposure, so there is nothing to reverse and
      // no charges to pay.
      const unwindOrders = plan.action === "no_exposure"
        ? []
        : await this.unwindConfirmed(orders, args.candidate.legs, tradeId, `${attemptId}:unwind`);

      // Steps 7-8: whatever the unwind did not cover becomes durable residual exposure, which the
      // flatten loop works and which blocks new entry under the existing rules.
      const residual = residualAfterUnwind(orders, unwindOrders);
      this.verifyEntryConservation(plan, orders, unwindOrders, attemptId, "partial_entry");

      const failed = liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "legging_incomplete", plan.action === "no_exposure" ? "entry did not fill; no exposure to unwind" : "entry incomplete; confirmed fills were protectively unwound", this.deps.cfg, tradeId, residual, unwindOrders);
      failed.legging.outcome_class = plan.action === "no_exposure"
        ? "NO_FILL"
        : residual.length > 0
          ? "PARTIAL_ENTRY_RESIDUAL"
          : "PARTIAL_ENTRY_UNWOUND";
      return failed;
    }

    const evaluation = evaluationFromFills(args.detection, orders);
    const measured = slippageFromFills(args.detection.legs, orders);
    const decision = args.qualify(evaluation, measured);
    if (!decision.qualifies) {
      // ── 4/4 FILLED, THEN ECONOMICS FAILED ────────────────────────────────────────────
      //
      // A complete hedged Box genuinely existed. There was no legging RISK, but there IS a real
      // cost: the round-trip spread and charges on all four legs. Reversed immediately, and
      // labelled distinctly so it is never rendered as an ordinary rejected candidate.
      const unwindOrders = await this.unwindConfirmed(orders, args.candidate.legs, tradeId, `${attemptId}:economics-unwind`);
      const residual = residualAfterUnwind(orders, unwindOrders);
      this.verifyEntryConservation(
        planPartialEntryRecovery({ legs: entryLegOutcomes(requests, orders), expectedRoles: BOX_LEG_ROLES }),
        orders,
        unwindOrders,
        attemptId,
        "economics_abort",
      );
      const failed = liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "abort_after_fill", "executed prices failed final economics; confirmed box was unwound", this.deps.cfg, tradeId, residual, unwindOrders);
      failed.legging.abort_after_fill = true;
      failed.legging.outcome_class = "FILLED_THEN_ECONOMICS_ABORT";
      failed.legging.final_expected_net_profit = decision.expected_net_profit;
      failed.legging.required_expected_net_profit = decision.min_expected_net_profit;
      return failed;
    }

    const opened = liveRecord(args.detection.at, submittedAt, orders, true, this.deps.cfg, undefined, tradeId);
    opened.outcome_class = "OPENED";
    return { ok: true, evaluation, decision, legging: opened };
  }

  /**
   * The composed entry-guard refusal reason at a gateway-side checkpoint, or null to proceed.
   *
   * The gateway can only see `stillWanted` — the manager owns entry arming, the breaker and full
   * admission — so it supplies `true` for the facts it cannot observe and lets the manager assert
   * them at its own three checkpoints. The DECISION itself still comes from the one pure function,
   * so the reason text is identical wherever the refusal is taken.
   */
  private entryGuardRefusal(
    stillWanted: (() => boolean) | undefined,
    stage: "pre_build" | "post_evidence" | "pre_enqueue",
  ): string | null {
    const decision = evaluateLiveEntryGuard({
      stage,
      stillWanted: stillWantedSafely(stillWanted),
      entryEnabled: true,
      liveOrderEntryEnabled: true,
      circuitClosed: true,
      entryAdmissible: true,
      attemptAborted: null,
      // pre_build/pre_enqueue run before any hedge leg exists, so coverage is not applicable here
      // and is asserted only at the manager's post-barrier pre_post checkpoint. Passing `null`
      // means "no coverage objection at this stage", NOT "coverage is proven".
      hedgeCoverageGap: null,
      // The gateway runs its OWN coherence admission and re-check around these stages
      // (see the `evaluateEntryCoherence`/`recheckEntryCoherence` calls in the entry path), so
      // there is no objection to add here. `null` means "nothing to report from this stage",
      // not "coherence is proven"; the send boundary supplies the real verdict.
      crossLegCoherenceGap: null,
    });
    return decision.allowed ? null : decision.reason;
  }

  /**
   * A proven ZERO-POST entry refusal taken before the manager was ever called.
   *
   * `REFUSED_BEFORE_SUBMIT` is the existing outcome class for exactly this: nothing reached the
   * broker, so there is no exposure, no charge and nothing to unwind. It is emphatically NOT a
   * broker rejection and NOT ambiguous — no durable intent was even created, because the refusal
   * happened before the first `manager.submit`.
   */
  private refusedBeforeSubmit(
    args: Parameters<BoxExecutionSimulator["simulateLeggingEntry"]>[0],
    submittedAt: number,
    tradeId: string | null,
    detail: string,
  ): Extract<BoxLeggingResult, { ok: false }> {
    const refused = liveEntryFailure(
      args.candidate,
      args.detection.at,
      submittedAt,
      [],
      "discovery_stopped",
      detail,
      this.deps.cfg,
      tradeId,
    );
    refused.legging.outcome_class = "REFUSED_BEFORE_SUBMIT";
    return refused;
  }

  /**
   * Assert EXACT per-role quantity conservation across an entry and its unwind.
   *
   * THE INVARIANT: for every role, `residual = confirmed_entry_fill - confirmed_unwind_fill`, and
   * that residual is never negative. A negative residual means we sold something we never bought
   * — brand-new naked exposure created by the very code meant to remove some. An overfill means
   * broker truth has proven our quantity model wrong, so every downstream exposure number is
   * suspect.
   *
   * Either way the response is RECOVERY, not a clamp and a shrug: `invariantViolation` sets
   * `recoveryActive`, trips the breaker and kicks reconciliation. Verification itself never
   * throws, because a bookkeeping check must not be able to abort a recovery already in progress.
   */
  private verifyEntryConservation(
    plan: PartialEntryPlan,
    entryOrders: BrokerOrder[],
    unwindOrders: BrokerOrder[],
    attemptId: string,
    phase: "partial_entry" | "economics_abort",
  ): void {
    const violation = this.conservationViolation(plan, entryOrders, unwindOrders, attemptId, phase);
    // RAISED OUTSIDE the guarded block. Wrapping the reporting call in the same try/catch as the
    // arithmetic meant a throw from `invariantViolation` — the very thing that triggers RECOVERY —
    // silently discarded the violation it was reporting.
    if (violation !== null) this.deps.manager?.invariantViolation(violation);
  }

  /** The conservation failure message, or null when exact conservation holds. Never throws. */
  private conservationViolation(
    plan: PartialEntryPlan,
    entryOrders: BrokerOrder[],
    unwindOrders: BrokerOrder[],
    attemptId: string,
    phase: "partial_entry" | "economics_abort",
  ): string | null {
    try {
      const unwoundByRole: Partial<Record<BoxLegRole, number>> = {};
      for (const order of unwindOrders) {
        unwoundByRole[order.role] = (unwoundByRole[order.role] ?? 0) + order.filled_quantity;
      }
      const result = verifyQuantityConservation({
        entry: entryOrders.map((order) => ({
          role: order.role,
          side: order.side,
          requested: order.quantity,
          confirmedFilled: order.filled_quantity,
          terminal: true,
          submitted: true,
          brokerStateKnown: true,
        })),
        unwoundByRole,
      });
      if (result.conserved) return null;
      return (
        `live entry ${attemptId} (${phase}) violated quantity conservation: ` +
        result.violations
          .map((violation) => `${violation.role}:${violation.kind}(${violation.detail})`)
          .join("; ") +
        `. Planned unwind was ${plan.unwind.length} leg(s).`
      );
    } catch {
      // Only the ARITHMETIC is guarded. A throw here means the check itself failed, which must not
      // abort the recovery in progress — but it must also not be silently indistinguishable from
      // "conserved", so it is reported as its own violation below.
      return `live entry ${attemptId} (${phase}) quantity-conservation check itself failed`;
    }
  }

  /**
   * Why this process must not act on this position, or null when it may.
   *
   * THE BOUNDARY THAT WAS MISSING. Adoption faithfully records the mode a position was created
   * under (`positions.ts` documents that it is carried per-position "because the config can differ
   * from what an ADOPTED position was actually opened under") — and then no exit path ever read it.
   * The only paper/live fork was the process-wide `this.mode`, so restored state was executed under
   * whatever the process happened to be configured as today.
   *
   * Checked at the GATEWAY rather than only at adoption because this is the last point before a
   * broker submission, and because the position book must keep holding every position for the
   * broker-switch guard, the delete guard and the margin totals to stay truthful.
   */
  private executionModeMismatch(position: BoxOpenPosition): string | null {
    // NO CLAIM ⇒ NO REFUSAL. A record that does not state its mode cannot contradict this process,
    // and inventing a contradiction from missing data would block a reduction — see
    // `statedExecutionMode`. Real restored positions always state it (the column is NOT NULL).
    const stated = statedExecutionMode(position.execution_mode);
    if (stated === null) return null;
    const processIsPaper = isPaperExecutionMode(this.mode);
    const recordIsPaper = isPaperExecutionMode(stated);
    if (processIsPaper === recordIsPaper) return null;
    return processIsPaper
      ? `Position ${position.id} was opened in ${position.execution_mode} mode, but this process runs ` +
        `${this.mode}. Refusing to SIMULATE a close of real broker exposure — it would mark the trade ` +
        `closed while the real position stayed on. A live process must reduce it.`
      : `Position ${position.id} was opened in ${position.execution_mode} mode, but this process runs ` +
        `${this.mode}. Refusing to send REAL orders for a simulated position — they would reduce ` +
        `whatever genuine exposure happens to share these contracts.`;
  }

  /**
   * A refusal record for the non-legging exit path.
   *
   * `BoxExecutionRecord` (what {@link BoxExitExecutionResult} carries) is a DIFFERENT shape from the
   * `PaperLeggingExecutionRecord` that `liveRecord` builds, so the two refusal paths cannot share a
   * constructor. Nothing was executed, so every measured field is null/0 and `legs` is empty — the
   * record exists to carry the reason honestly, not to describe a fill that never happened.
   */
  private modeMismatchRecord(detectedAt: number, detail: string): BoxExecutionRecord {
    const sentAt = this.now();
    return {
      mode: this.mode,
      detected_at: detectedAt,
      order_sent_at: sentAt,
      executed_at: null,
      decision_to_fill_ms: null,
      simulated_decision_ms: Math.max(0, sentAt - detectedAt),
      simulated_latency_ms: 0,
      detection_quote_version: null,
      execution_quote_version: null,
      detected_net_debit_per_unit: null,
      executed_net_debit_per_unit: null,
      detected_gross_edge: null,
      executed_gross_edge: null,
      total_slippage: 0,
      legs: [],
      filled: false,
      failure_reason: "execution_mode_mismatch",
      failure_detail: detail,
    };
  }

  async simulateExit(args: Parameters<BoxExecutionSimulator["simulateExit"]>[0]): Promise<BoxExitExecutionResult> {
    const mismatch = this.executionModeMismatch(args.position);
    if (mismatch !== null) {
      this.deps.onExecutionModeMismatch?.(mismatch);
      return {
        ok: false,
        record: this.modeMismatchRecord(args.detectedAt, mismatch),
        reason: "execution_mode_mismatch",
        detail: mismatch,
      };
    }
    return this.deps.simulator.simulateExit(args);
  }

  async simulateLeggingExit(args: Parameters<BoxExecutionSimulator["simulateLeggingExit"]>[0]): ReturnType<BoxExecutionSimulator["simulateLeggingExit"]> {
    // BEFORE the paper/live fork, deliberately: the fork itself is what made the wrong mode act.
    const mismatch = this.executionModeMismatch(args.position);
    if (mismatch !== null) {
      this.deps.onExecutionModeMismatch?.(mismatch);
      const record = liveRecord(args.detectedAt, this.now(), [], false, this.deps.cfg, undefined, args.position.id);
      return { ok: false, record, reason: "execution_mode_mismatch", detail: mismatch };
    }
    if (this.mode !== "live") return this.deps.simulator.simulateLeggingExit(args);
    const manager = this.requireManager();
    const attemptId = stableAttemptId(args.position.id, args.detectedAt, "EXIT");
    const detByRole = new Map(args.detectionLegs.map((leg) => [leg.role, leg]));
    const direction = args.position.direction ?? "LONG_BOX";
    const outstanding = outstandingRoles(args.position);
    if (outstanding.length === 0) {
      const record = liveRecord(args.detectedAt, this.now(), [], false, this.deps.cfg, undefined, args.position.id);
      return { ok: false, record, reason: "legging_incomplete", detail: "position already flat" };
    }

    // ── EXPOSURE-AWARE EXIT DEPENDENCIES (see exitDependencies.ts) ──────────────────────────
    //
    // WAVE 0 transmits everything that can only reduce risk: every BUY that closes a short leg,
    // plus every long leg with no short standing beside it (a long-only residual has nothing to
    // wait for, and must never be made to wait for a nonexistent short).
    //
    // WAVE 1 transmits hedge releases, each bounded by PROVEN cover release. A hedge whose paired
    // short is still outstanding — because the close cancelled, partially filled, or is simply not
    // decided yet — keeps exactly the quantity that short still needs.
    const outstandingByRole: Partial<Record<BoxLegRole, number>> = {};
    for (const { role, quantity } of outstanding) outstandingByRole[role] = quantity;
    const plan = planExitDependencies(direction, outstandingByRole);

    const build = (role: BoxLegRole, quantity: number): BrokerOrderRequest => this.request({
      role,
      inst: args.position.legs[role],
      side: exitSideFor(role, direction),
      quantity,
      referencePrice: detByRole.get(role)?.price ?? 0,
      tradeId: args.position.id,
      attemptId,
      purpose: "EXIT",
      phase: "exit",
    });

    const orders: BrokerOrder[] = [];
    let uncertain = false;
    let attempted = 0;
    const withheld: string[] = [];

    /**
     * Submit one wave, recording orders and whether any outcome is unprovable.
     *
     * PER-LEG ISOLATION. Request construction, pricing and the current-feed precheck all happen
     * INSIDE the loop, so one unusable book removes exactly one leg. Previously all requests were
     * built and then prechecked as a batch, and `precheck` threw on the first failure — so a single
     * leg with a missing, stale or thin book prevented every OTHER leg in the wave from reaching the
     * manager, including risk-reducing short closes on legs with perfectly good depth.
     *
     * A blocked leg is recorded as `{ filled: 0, certain: true }`: nothing was transmitted, so zero
     * filled is PROVEN, exactly as for a `BrokerPreSubmitRefusedError` below. That is what keeps it
     * safe — a proven-zero short close releases NO hedge, because the short is fully intact. It is
     * also recorded in `withheld` with its exact reason, so the exit can never be reported clean.
     *
     * Nothing is submitted against a fabricated, stale or insufficient book: an admitted leg carries
     * the stamp `precheckOne` produced, and the manager re-validates it at CHECKPOINT 3 (dequeue) and
     * CHECKPOINT 5 (immediately pre-POST) before any broker mutation.
     */
    const runWave = async (
      legs: readonly { role: BoxLegRole; quantity: number }[],
    ): Promise<Map<BoxLegRole, ExitWaveOutcome>> => {
      const byRole = new Map<BoxLegRole, ExitWaveOutcome>();
      if (legs.length === 0) return byRole;
      // Freshness is re-established per wave: wave 1 is transmitted after wave 0's broker round
      // trip, so reusing wave 0's stamps would authorise a SELL against a book that has since aged.
      const checkedAt = this.now();
      const feedGeneration = this.deps.feedGeneration?.() ?? 0;
      const admitted: BrokerOrderRequest[] = [];
      const checkedFeed = new Map<string, CheckedFeedStamp>();

      for (const leg of legs) {
        attempted++;
        let request: BrokerOrderRequest;
        try {
          // Construction and pricing are per-leg: a leg whose reference price cannot be derived
          // must not take the rest of the wave down with it.
          request = build(leg.role, leg.quantity);
        } catch (error) {
          byRole.set(leg.role, { filled: 0, certain: true });
          withheld.push(`${leg.role} not submitted: ${withheldReason(errorMessage(error))}`);
          continue;
        }
        const verdict = this.precheckOne(request, checkedAt, feedGeneration);
        if (verdict.reason !== null) {
          byRole.set(leg.role, { filled: 0, certain: true });
          withheld.push(`${leg.role} not submitted: ${withheldReason(verdict.reason)}`);
          continue;
        }
        checkedFeed.set(request.client_order_id, verdict.stamp);
        admitted.push(request);
      }

      if (admitted.length === 0) return byRole;
      const settled = await Promise.allSettled(
        admitted.map((request) => manager.submit(request, checkedFeed.get(request.client_order_id))),
      );
      settled.forEach((item, index) => {
        const role = admitted[index]!.role;
        if (item.status === "fulfilled") {
          orders.push(item.value);
          // `uncertain` keeps its ORIGINAL meaning — an unprovable broker terminal quantity — so a
          // confirmed partial still does not trip the invariant. Hedge-release certainty is the
          // stricter test beside it.
          if (item.value.state === "UNKNOWN" || item.value.state === "RECONCILIATION_REQUIRED") {
            uncertain = true;
          }
          byRole.set(role, {
            filled: item.value.filled_quantity,
            certain: isBrokerOrderTerminal(item.value.state),
          });
          return;
        }
        if (item.reason instanceof BrokerPreSubmitRefusedError) {
          // A LOCAL pre-submit refusal never reached the broker, so nothing filled. That is
          // CERTAIN knowledge of zero — not an unknown — and it is exactly why the original code
          // excluded it from `uncertain`. It still releases no hedge, because the short is intact.
          byRole.set(role, { filled: 0, certain: true });
          return;
        }
        if (item.reason instanceof OrderPersistenceAfterFillError) {
          orders.push(item.reason.order);
          uncertain = true;
          byRole.set(role, { filled: item.reason.order.filled_quantity, certain: false });
          return;
        }
        uncertain = true;
        byRole.set(role, { filled: 0, certain: false });
      });
      return byRole;
    };

    let wave0: Map<BoxLegRole, ExitWaveOutcome>;
    try {
      wave0 = await runWave(plan.wave0.map((slot) => ({ role: slot.role, quantity: slot.outstanding })));
    } catch (error) {
      // DEFENCE IN DEPTH ONLY. An unusable book, an unpriceable leg and a per-leg submission failure
      // are all handled inside `runWave` now and are recorded as withheld legs, so none of them
      // reaches here. This remains for a genuinely unexpected fault, where abandoning the attempt
      // without having transmitted anything is the safe outcome.
      const record = liveRecord(args.detectedAt, this.now(), [], false, this.deps.cfg, plan.wave0.length, args.position.id);
      return { ok: false, record, reason: "insufficient_quantity", detail: errorMessage(error) };
    }

    // Hedge releases, sized from AUTHORITATIVE fill quantity only.
    const releases: { role: BoxLegRole; quantity: number }[] = [];
    for (const slot of plan.wave1) {
      const short = slot.covers!;
      const evidence = wave0.get(short);
      const releasable = releasableHedgeQuantity({
        hedgeOutstanding: slot.outstanding,
        short: {
          shortOutstanding: outstandingByRole[short] ?? 0,
          confirmedClosed: evidence?.filled ?? 0,
          // No evidence at all (the short was never planned, or the wave threw) is UNCERTAIN.
          certain: evidence?.certain ?? false,
        },
      });
      if (releasable <= 0) {
        withheld.push(`${slot.role} held back ${slot.outstanding} covering ${short}`);
        continue;
      }
      if (releasable < slot.outstanding) {
        withheld.push(`${slot.role} held back ${slot.outstanding - releasable} covering ${short}`);
      }
      releases.push({ role: slot.role, quantity: releasable });
    }

    if (releases.length > 0) {
      try {
        // Hedge releases are isolated per leg by the SAME mechanism as wave 0, so one release with
        // no executable book no longer suppresses an unrelated release that is already proven free.
        // A release refused for want of a book is NOT an exposure failure: that hedge simply stays
        // on, which is the safe side. Recorded, never escalated to a naked sell.
        await runWave(releases);
      } catch (error) {
        // Defence in depth, as for wave 0.
        withheld.push(`hedge release blocked: ${errorMessage(error)}`);
      }
    }

    if (uncertain) manager.invariantViolation(`live exit ${attemptId} has uncertain broker terminal quantity`);
    const record = liveRecord(args.detectedAt, this.now(), orders, false, this.deps.cfg, attempted, args.position.id);
    const legs = legsFromOrders(orders, args.position.legs, this.deps.quotes, this.now());

    // CLEAN means every outstanding unit of every outstanding role is confirmed closed. Measured
    // per ROLE against the position's outstanding quantity — not per REQUEST — because a hedge
    // release is deliberately sized below its outstanding quantity when cover is still required,
    // and "the requests I chose to send all filled" would then read a half-exited box as flat.
    const closedByRole = new Map<BoxLegRole, number>();
    for (const order of orders) {
      closedByRole.set(order.role, (closedByRole.get(order.role) ?? 0) + order.filled_quantity);
    }
    const clean = !uncertain && withheld.length === 0 &&
      outstanding.every(({ role, quantity }) => (closedByRole.get(role) ?? 0) >= quantity);
    if (clean) return { ok: true, legs, record, booksAtFill: new Map() };
    return {
      ok: false,
      record,
      reason: "legging_incomplete",
      detail: uncertain
        ? "exit terminal quantity uncertain; position moved to recovery"
        : withheld.length > 0
          ? `live exit preserved required hedge cover: ${withheld.join("; ")}`
          : "live exit partially filled",
      legs,
      booksAtFill: new Map(),
    };
  }

  estimateExecutableExit(position: BoxOpenPosition, now?: number): ReturnType<BoxExecutionSimulator["estimateExecutableExit"]> {
    return this.deps.simulator.estimateExecutableExit(position, now);
  }

  /**
   * LIVE RESIDUAL FLATTENING — a genuine retry loop.
   *
   * Every logically new attempt on still-outstanding quantity gets a NEW durable identity
   * (`…:attempt-N`); a retry or reconciliation of the SAME broker submission keeps the old one.
   * See `residualFlatten.ts` for the state machine and the crash-safety argument.
   *
   * Nothing here is allowed to swallow an error. Each leg's outcome is classified into a fixed
   * disposition that decides ONE thing: may the next pass reuse this identity? A terminal
   * durable outcome spends it only when the broker is terminal or a local guard proves no POST.
   */
  async flattenResidual(args: Parameters<BoxExecutionSimulator["flattenResidual"]>[0]): ReturnType<BoxExecutionSimulator["flattenResidual"]> {
    if (this.mode !== "live") return this.deps.simulator.flattenResidual(args);
    const manager = this.requireManager();
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════════
     * SHORTS FIRST, AND LONGS ONLY ONCE THE SHORTS ARE PROVEN GONE.
     *
     * THE DEFECT THIS REPLACES. This loop used to be:
     *
     *     for (const residual of args.residual) {
     *       passes.push(await this.flattenOneResidual(manager, args.keyPrefix, residual));
     *     }
     *
     * — every residual reversed independently, in whatever order the array happened to arrive.
     * Normal exits and the immediate protective unwind both understand hedge dependencies; this
     * separate periodic path did not.
     *
     * The failure is concrete. An incomplete or recovered box holds long option hedges and short
     * options. The loop sells both longs successfully, then its short-closing BUYs fail to fill. What
     * remains is a NAKED SHORT OPTION — unlimited-risk exposure manufactured by the very routine whose
     * job was to remove risk. Merely sorting shorts first does not fix it either: a short-close that
     * fails must still prevent the subsequent sale of its cover, and ordering alone cannot express that.
     *
     * THE RULE NOW: no long residual is released while ANY short residual remains unproven.
     *
     * "Proven" means the disposition is `flattened` — the broker's own terminal outcome accounted for
     * the full requested quantity. Working, rejected, ambiguous, partially filled and not-sent all
     * count as NOT closed, which is the whole point: those are exactly the states in which a hedge is
     * still doing its job.
     *
     * The gate is deliberately whole-position rather than per-contract. A box's protection is not a
     * neat one-to-one pairing, and holding a long option one extra cycle costs time value, whereas
     * releasing it one cycle early can cost without bound. Retained longs are returned as remaining
     * residuals with their identity untouched, so the next pass reconsiders them — and once the shorts
     * are closed they flatten normally.
     * ══════════════════════════════════════════════════════════════════════════════════════════════
     */
    const isShort = (r: ResidualLegExposure): boolean => r.side === "SELL";
    const shortResiduals = args.residual.filter(isShort);
    const longResiduals = args.residual.filter((r) => !isShort(r));

    const passes: ResidualFlattenPass[] = [];
    for (const residual of shortResiduals) {
      passes.push(await this.flattenOneResidual(manager, args.keyPrefix, residual));
    }

    // Every short must be PROVEN gone before any cover is released.
    const unresolvedShorts = passes.filter((p) => p.disposition !== "flattened");
    const coverMustBeHeld = unresolvedShorts.length > 0;

    for (const residual of longResiduals) {
      if (coverMustBeHeld) {
        const blocking = unresolvedShorts
          .map((p) => `${p.residual.role}(${p.disposition}${p.failure ? `:${p.failure}` : ""})`)
          .join(", ");
        passes.push({
          residual,
          // The identity is NOT advanced: nothing was sent under it.
          attempt: residualFlattenAttempt(residual),
          order: null,
          disposition: dispositionForFailure("hedge_cover_retained"),
          failure: "hedge_cover_retained",
          detail:
            `held as cover while ${unresolvedShorts.length} short residual(s) remain unproven ` +
            `[${blocking}]; selling it now would create naked short exposure`,
        });
        continue;
      }
      passes.push(await this.flattenOneResidual(manager, args.keyPrefix, residual));
    }

    const orders: BrokerOrder[] = [];
    const flattened: Partial<Record<BoxLegRole, number>> = {};
    const remaining: ResidualLegExposure[] = [];
    let flattenCharges = 0;
    for (const pass of passes) {
      // Attribute the order to the residual that produced it. Matching by role was wrong the
      // moment two residual entries shared a role: the second silently inherited the first's
      // fill and its own exposure vanished from the books.
      if (pass.order) orders.push(pass.order);

      const sameGeneration = pass.attempt === residualFlattenAttempt(pass.residual);
      const rawFilledWatermark = sameGeneration ? pass.residual.flatten_accounted_filled : undefined;
      const rawChargeWatermark = sameGeneration ? pass.residual.flatten_accounted_charges : undefined;
      const legacyWatermarks = rawFilledWatermark === undefined && rawChargeWatermark === undefined;
      const watermarksValid = legacyWatermarks || (
        typeof rawFilledWatermark === "number" && Number.isFinite(rawFilledWatermark) && rawFilledWatermark >= 0 &&
        typeof rawChargeWatermark === "number" && Number.isFinite(rawChargeWatermark) && rawChargeWatermark >= 0
      );
      let accountedFilled = watermarksValid && !legacyWatermarks ? rawFilledWatermark! : 0;
      let accountedCharges = watermarksValid && !legacyWatermarks ? round2(rawChargeWatermark!) : 0;
      let disposition = pass.disposition;
      let fillDelta = 0;
      let chargeDelta = 0;
      // `undefined` means "this pass observed no broker order", so the residual keeps whatever it
      // already carried — including ABSENT on a pre-watermark row, whose already-projected fill can
      // only ever be derived from a durable intent snapshot.
      let cumulativeFilled: number | undefined = watermarksValid && !legacyWatermarks ? accountedFilled : undefined;
      let cumulativeCharges: number | undefined = watermarksValid && !legacyWatermarks ? accountedCharges : undefined;

      if (!watermarksValid) {
        manager.invariantViolation(
          `residual ${args.keyPrefix} ${pass.residual.role} attempt-${pass.attempt} has inconsistent cumulative accounting watermarks`,
        );
        disposition = "adopt_attempt";
        // Normalise the pair so the identity stops being ambiguous next pass instead of tripping the
        // invariant forever: keep the highest readable fill watermark (never re-credit it) and read
        // an unreadable one as zero, exactly as before this accounting existed.
        cumulativeFilled = typeof rawFilledWatermark === "number" && Number.isFinite(rawFilledWatermark) &&
          rawFilledWatermark > 0 ? rawFilledWatermark : 0;
        cumulativeCharges = typeof rawChargeWatermark === "number" && Number.isFinite(rawChargeWatermark) &&
          rawChargeWatermark > 0 ? round2(rawChargeWatermark) : 0;
      } else if (pass.order) {
        const brokerFilled = pass.order.filled_quantity;
        if (legacyWatermarks) {
          // A residual persisted before cumulative watermarks existed carries no accounting at all.
          // Reading that as "nothing projected yet" replays the partial fill this identity ALREADY
          // credited and re-bills its fee on the first post-upgrade terminal pass, understating the
          // exposure that is still naked. `order.quantity` is immutable on the durable intent and
          // equals the residual quantity at the moment this identity was created, so the difference
          // is exactly what was already projected under it — and 0 for a genuinely fresh residual.
          // Clamped: a snapshot whose quantity is somehow below the residual must never manufacture
          // a negative watermark (which would re-credit even more than defaulting to zero).
          accountedFilled = Math.max(0, pass.order.quantity - pass.residual.quantity);
          accountedCharges = this.residualCumulativeCharges(pass.order, accountedFilled, 0);
        }
        const brokerCumulativeCharges = this.residualCumulativeCharges(pass.order, brokerFilled, accountedCharges);
        // Only the FILL stream is a trustworthiness test. The charge figure is re-estimated from
        // the current rate card on every pass rather than recorded, so it can legitimately fall
        // (rate-card version change, corrected average price) while the fill is unchanged. Treating
        // that as corruption forced `adopt_attempt` on every later pass, so the residual could
        // never retire or flatten and every interval tripped the invariant/breaker — a permanently
        // stranded naked leg. Real turnover is monotonic, so this branch catches nothing the fill
        // check does not; a cheaper estimate is absorbed by the zero-clamp on `chargeDelta` below.
        const regression = !Number.isFinite(brokerFilled) || brokerFilled < accountedFilled ||
          brokerFilled < 0 || brokerFilled > pass.order.quantity;
        const candidateFillDelta = regression ? 0 : brokerFilled - accountedFilled;
        if (regression || candidateFillDelta > pass.residual.quantity) {
          manager.invariantViolation(
            `residual ${args.keyPrefix} ${pass.residual.role} attempt-${pass.attempt} cumulative accounting regressed or exceeded exposure ` +
              `(fill ${accountedFilled} -> ${brokerFilled}, charge ${accountedCharges} -> ${brokerCumulativeCharges}, residual ${pass.residual.quantity})`,
          );
          // Quarantine this identity. Never turn a negative/regressed cumulative snapshot into a
          // fill and never retire past an identity whose accounting cannot be trusted. The
          // watermarks are still persisted so the quarantined identity stops being ambiguous.
          disposition = "adopt_attempt";
          cumulativeFilled = accountedFilled;
          cumulativeCharges = accountedCharges;
        } else {
          fillDelta = candidateFillDelta;
          chargeDelta = round2(Math.max(0, brokerCumulativeCharges - accountedCharges));
          cumulativeFilled = brokerFilled;
          // Keep the charge watermark monotonic: a cheaper re-estimate must not lower the bar and
          // let the next pass bill the same turnover again when the estimate recovers.
          cumulativeCharges = Math.max(accountedCharges, brokerCumulativeCharges);
        }
      }

      flattened[pass.residual.role] = (flattened[pass.residual.role] ?? 0) + fillDelta;
      flattenCharges = round2(flattenCharges + chargeDelta);
      const outstanding = pass.residual.quantity - fillDelta;
      if (outstanding > 0) {
        remaining.push(carryResidualForward(
          pass.residual,
          outstanding,
          pass.attempt,
          disposition,
          { cumulativeFilled, cumulativeCharges },
        ));
      }
    }

    return {
      flattened_by_role: flattened,
      flatten_charges: flattenCharges,
      remaining,
      legs: orders.map((order) => paperLeg(order)),
    };
  }

  /**
   * Cumulative charge for one cumulative filled quantity on one durable identity.
   *
   * The SAME estimator is used for a legacy-derived watermark and for the current snapshot, so a
   * derived watermark and the figure it is compared against cannot disagree by construction — an
   * unchanged cumulative fill therefore bills exactly zero. `fallback` is what an unpriceable or
   * zero-fill snapshot means: no charge information, so the existing watermark stands.
   */
  private residualCumulativeCharges(order: BrokerOrder, filled: number, fallback: number): number {
    if (!(filled > 0) || order.average_price === null) return fallback;
    return round2(this.deps.chargeTotal?.([{
      side: order.side,
      tradingsymbol: order.tradingsymbol,
      quantity: filled,
      price: order.average_price,
    }]) ?? 0);
  }

  /**
   * One residual leg, one flatten attempt.
   *
   * The generation comes from the residual itself when it has one (the runtime loop persists it),
   * and otherwise from the DURABLE intent journal — never from an in-memory counter, a clock or a
   * random value. Crash-recovery exposure derived from the journal has no persisted generation,
   * so the journal itself is probed for the first identity that is absent or still adoptable.
   */
  private async flattenOneResidual(
    manager: BoxOrderManager,
    keyPrefix: string,
    residual: ResidualLegExposure,
  ): Promise<ResidualFlattenPass> {
    const base = stableAttemptId(keyPrefix, residual.created_at, `RESIDUAL-${residual.role}`);
    const selected = await this.firstAdoptableResidualAttempt(
      manager,
      keyPrefix,
      residual,
      base,
      residualFlattenAttempt(residual),
    );
    const attempt = selected.attempt;

    const fail = (kind: ResidualFlattenFailureKind, detail: string, order: BrokerOrder | null = null): ResidualFlattenPass => {
      if (residualFailureIsInvariant(kind)) {
        manager.invariantViolation(
          `residual ${keyPrefix} ${residual.role} attempt-${attempt} [${kind}]: ` +
            `${residualFailurePhrase(kind)} — ${detail}`,
        );
      }
      return { residual, attempt, order, disposition: dispositionForFailure(kind), failure: kind, detail };
    };

    if (selected.terminalIntent) {
      const order = brokerOrderFromDurableIntent(selected.terminalIntent);
      if (order.state === "REJECTED") {
        return fail("broker_rejected", order.reject_reason ?? "durable broker rejection", order);
      }
      const disposition = classifyResidualOrder(order, residual.quantity);
      return { residual, attempt, order, disposition, failure: null, detail: null };
    }

    const side: OrderSide = residual.side === "BUY" ? "SELL" : "BUY";
    const quote = this.deps.quotes.get(residual.token);
    const reference = quote ? touchPrice(side, quote.bids, quote.asks) : null;
    const enforceCurrentGeneration = this.deps.isTokenWarm !== undefined;
    if (!reference || (this.deps.isTokenWarm && !this.deps.isTokenWarm(residual.token)) ||
        !quote || (enforceCurrentGeneration && this.now() - quote.at > this.deps.cfg.quoteMaxAgeMs)) {
      // Nothing was sent, so the identity is still unused and MUST be reused next pass.
      return fail("no_executable_book", `no current executable ${side} touch for ${residual.tradingsymbol}`);
    }

    const inst: BoxOptionInstrument = {
      token: residual.token,
      tradingsymbol: residual.tradingsymbol,
      exchange: residual.exchange ?? "NFO",
      strike: 0,
      instrument_type: residual.role.endsWith("_ce") ? "CE" : "PE",
      expiry: "",
      lot_size: residual.quantity,
    };

    try {
      const request = this.request({
        role: residual.role,
        inst,
        side,
        quantity: residual.quantity,
        referencePrice: reference,
        tradeId: keyPrefix,
        attemptId: residualFlattenAttemptId(base, attempt),
        purpose: "EMERGENCY_RESIDUAL",
        phase: "unwind",
      });
      // Residual reduction bypasses entry discovery/warmup, but never bounded
      // quantity, freshness, relevant-side depth, or generation checks.
      let checkedFeed: Map<string, CheckedFeedStamp>;
      try {
        checkedFeed = this.precheck([request]);
      } catch (error) {
        return fail("no_executable_book", errorMessage(error));
      }
      const order = await manager.submit(request, checkedFeed.get(request.client_order_id));
      const disposition = classifyResidualOrder(order, residual.quantity);
      if (disposition === "adopt_attempt") {
        // A working or unknown order still owns this identity. Keep it and reconcile.
        return fail("broker_state_unknown", `order state ${order.state} is not terminal`, order);
      }
      return { residual, attempt, order, disposition, failure: null, detail: null };
    } catch (error) {
      // The broker owns a fill we could not record. Broker truth wins: carry the snapshot so the
      // quantity is credited, and trip the invariant.
      if (error instanceof OrderPersistenceAfterFillError) {
        return fail("persistence_after_fill", errorMessage(error), error.order);
      }
      // A durable local refusal proves no broker POST and terminally spends this
      // identity, so the still-outstanding quantity must advance to attempt N+1.
      if (error instanceof BrokerPreSubmitRefusedError) {
        return fail("local_pre_submit_refused", errorMessage(error));
      }
      // A KNOWN broker refusal. It is terminal broker truth, but policy retains this durable
      // identity rather than manufacturing a fresh reduction order automatically.
      if (error instanceof BrokerOrderRejectedError) {
        return fail("broker_rejected", errorMessage(error), error.order);
      }
      // An ambiguous submission may or may not exist at the broker. NEVER resubmit it under a
      // new identity; keep this one so the durable journal adopts whatever is really there.
      if (error instanceof BrokerAmbiguousSubmitError) {
        return fail("broker_state_unknown", errorMessage(error), error.order ?? null);
      }
      return fail(classifyResidualFlattenErrorMessage(errorMessage(error)), errorMessage(error));
    }
  }

  /**
   * First flatten generation whose durable intent is absent or still adoptable.
   *
   * Every residual is reconciled, including one that already persisted a generation. This repairs
   * the crash window where a local no-POST refusal committed REJECTED but generation N+1 did not.
   * Only an unambiguous structured local-no-POST rejection with zero fill and no broker order is
   * advanced here. Broker rejection and every working/ambiguous state retain their identity.
   */
  private async firstAdoptableResidualAttempt(
    manager: BoxOrderManager,
    keyPrefix: string,
    residual: ResidualLegExposure,
    base: string,
    firstAttempt = FIRST_RESIDUAL_FLATTEN_ATTEMPT,
  ): Promise<{ attempt: number; terminalIntent: IBoxOrderIntent | null }> {
    const probe = manager.findDurableIntent?.bind(manager);
    if (!probe) return { attempt: firstAttempt, terminalIntent: null };
    const lastAttempt = firstAttempt + MAX_RESIDUAL_FLATTEN_ATTEMPT_PROBE - 1;
    for (let attempt = firstAttempt; attempt <= lastAttempt; attempt++) {
      const clientOrderId = boxClientOrderId({
        tradeId: keyPrefix,
        purpose: "EMERGENCY_RESIDUAL",
        role: residual.role,
        attempt: residualFlattenAttemptId(base, attempt),
      });
      let existing: Awaited<ReturnType<NonNullable<BoxOrderManager["findDurableIntent"]>>>;
      try {
        existing = await probe(clientOrderId);
      } catch {
        // The journal is unreadable. Reusing the current identity is the safe answer: the upsert
        // adopts an existing submission and only POSTs when the intent is still CREATED.
        return { attempt, terminalIntent: null };
      }
      if (!existing) return { attempt, terminalIntent: null };
      if (existing.state === "REJECTED") {
        if (hasDurableLocalNoPostProvenance(existing)) continue;
        return { attempt, terminalIntent: existing };
      }
      // COMPLETE/CANCELLED broker truth is projected directly from the durable snapshot before
      // any later generation is allowed to POST. Working and ambiguous states retain the identity
      // and flow through OrderManager reconciliation. Only proven local no-POST refusal is skipped.
      if (existing.state === "COMPLETE" || existing.state === "CANCELLED") {
        return { attempt, terminalIntent: existing };
      }
      return { attempt, terminalIntent: null };
    }
    return { attempt: lastAttempt + 1, terminalIntent: null };
  }

  invariantViolation(reason: string): void {
    this.deps.manager?.invariantViolation(reason);
  }

  private request(args: {
    role: BoxLegRole;
    inst: BoxOptionInstrument;
    side: OrderSide;
    quantity: number;
    referencePrice: number;
    tradeId: string;
    attemptId: string;
    purpose: "ENTRY" | "EXIT" | "EMERGENCY_RESIDUAL";
    phase: "entry" | "exit" | "unwind";
  }): BrokerOrderRequest {
    const pricing = buildOrderPricing({
      side: args.side,
      quantity: args.quantity,
      referencePrice: args.referencePrice,
      tickSize: args.inst.tick_size ?? this.deps.cfg.defaultTickSize,
      maxChaseTicks: Math.min(this.deps.cfg.liveMaxChaseTicks, args.phase === "unwind" ? this.deps.cfg.unwindMaxChaseTicks : this.deps.cfg.legMaxChaseTicks),
    });
    return {
      client_order_id: boxClientOrderId({ tradeId: args.tradeId, purpose: args.purpose, role: args.role, attempt: args.attemptId }),
      role: args.role,
      trade_id: args.tradeId,
      attempt_id: args.attemptId,
      purpose: args.purpose,
      phase: args.phase,
      exchange: args.inst.exchange,
      tradingsymbol: args.inst.tradingsymbol,
      token: args.inst.token,
      side: args.side,
      quantity: args.quantity,
      pricing: {
        order_type: "LIMIT",
        reference_price: pricing.reference_price,
        tick_size: pricing.tick_size,
        max_chase_ticks: pricing.max_chase_ticks,
        limit_price: pricing.limit_price,
      },
    };
  }

  /**
   * The per-Box ₹ cap in force for the CURRENT execution mode.
   *
   * LIVE is the authoritative safety gate. Paper has its own optional mirror so a
   * `live_parity` run can exercise the identical admission arithmetic without a real account;
   * a paper cap can never relax the live one because they are different config keys and only
   * the live one is consulted in live mode.
   */
  private capitalLimitRupees(): number {
    return this.mode === "live"
      ? this.deps.cfg.liveMaxBoxCapitalRupees
      : this.deps.cfg.paperMaxBoxCapitalRupees;
  }

  /** Compute and judge the gross entry-order notional for a built request set. */
  private evaluateEntryCapital(
    requests: readonly BrokerOrderRequest[],
    candidate: BoxCandidate,
    stage: BoxCapitalReport["stage"],
  ): BoxCapitalReport {
    return evaluateBoxCapitalAdmission({
      metrics: grossEntryOrderNotional(requests, BOX_LEG_ROLES.length),
      limitRupees: this.capitalLimitRupees(),
      broker: this.deps.broker?.() ?? "unknown",
      candidateKey: candidate.key,
      at: this.now(),
      stage,
    });
  }

  /** The last capital decision, for status/diagnostics. Bounded, low-cardinality. */
  capitalDiagnostics(): ReturnType<typeof boxCapitalSummary> & { limit_source: "live" | "paper" } {
    return {
      ...boxCapitalSummary(this.lastCapitalReport),
      limit_source: this.mode === "live" ? "live" : "paper",
    };
  }

  /**
   * Evaluate the economic-admission controls for a built entry request set.
   *
   * Returns null when NO economic control is enabled (the gross-cap-only behaviour is unchanged).
   * When a control is enabled, it sources FRESH funds/margin evidence from the injected broker
   * facilities and judges the five-quantity picture. Funds/margin are exposed as
   * missing/stale (unusable) rather than assumed; the gate then fails closed.
   *
   * NOT applied to reduction/exit — only `simulateLeggingEntry` calls it, so protective reduction
   * once partially exposed is never subject to new-entry economics (explicit recovery policy).
   */
  /**
   * FRESH funds/margin evidence, read and judged on ONE coherent clock model.
   *
   * ROOT CAUSE THIS FIXES. The previous implementation captured `const now = this.now()` BEFORE
   * awaiting the broker reads, while the engine's providers stamp `observedAt` AFTER their round
   * trip resolves. Every real response therefore had `observedAt > now`, the computed age was
   * NEGATIVE, and `brokerFigure()`'s `age >= 0` rule downgraded fresh evidence to "stale" — so the
   * economic gate refused valid live entries. See src/box/evidenceTiming.ts for the full account.
   *
   * WHAT IT NOW DOES, in order:
   *   1. Snapshots the identity (broker/account/session) and fingerprints the exact order plan.
   *   2. Reads funds and margin with a HARD per-read deadline, so a stalled broker endpoint cannot
   *      hold admission open. Concurrently only when the broker integration permits it.
   *   3. Stamps the EVALUATION INSTANT after both reads have settled — ages are >= 0 by
   *      construction, and each observation keeps its OWN timestamp.
   *   4. Ages each observation on the MONOTONIC clock, so an NTP step cannot fabricate or erase
   *      staleness, while retaining wall time for the audit record.
   *   5. Re-reads the identity and invalidates evidence acquired for a different
   *      broker/account/session.
   *   6. Builds the section-8 stage model (initial vs final basket margin kept separate) and
   *      evaluates the configured controls.
   *
   * Returns null when no economic control is enabled (paper and legacy paths are untouched).
   */
  private async evaluateEntryEconomics(
    requests: readonly BrokerOrderRequest[],
    direction: BoxDirection,
  ): Promise<EconomicAdmissionReport | null> {
    if (this.mode !== "live") return null;
    const requireFundsCover = this.deps.cfg.liveRequireFundsCover === true;
    const requireMarginEvidence = this.deps.cfg.liveRequireMarginEvidence === true;
    const requireStageFunding = this.deps.cfg.liveRequireStageFunding === true;
    if (!requireFundsCover && !requireMarginEvidence && !requireStageFunding) return null;

    const clock = this.evidenceClock();
    const identity = () => this.evidenceIdentity();
    const planFingerprint = orderPlanFingerprint(requests);
    const timeoutMs = this.deps.cfg.liveEvidenceReadTimeoutMs;
    const futureSkewGraceMs = this.deps.cfg.liveEvidenceFutureSkewGraceMs;

    const readFunds = () =>
      readEvidence({
        read: this.deps.funds,
        timeoutMs,
        clock,
        identity,
        sourceObservedAtWall: (value) => value.observedAt ?? null,
        label: "available-funds",
      });
    const readMargin = () =>
      readEvidence({
        read: this.deps.plannedMargin ? () => this.deps.plannedMargin!(requests) : undefined,
        timeoutMs,
        clock,
        identity,
        sourceObservedAtWall: (value) => value.observedAt ?? null,
        label: "planned-margin",
      });

    // CONCURRENCY IS OPT-IN. Two independent GETs against different endpoints are safe to overlap,
    // but a broker's rate limiter and this process's own pacing rules are the authority on that —
    // so the default is SERIAL, and overlapping is enabled only when configured.
    let fundsObs: Awaited<ReturnType<typeof readFunds>>;
    let marginObs: Awaited<ReturnType<typeof readMargin>>;
    if (this.deps.cfg.liveEvidenceConcurrentReads === true) {
      [fundsObs, marginObs] = await Promise.all([readFunds(), readMargin()]);
    } else {
      fundsObs = await readFunds();
      marginObs = await readMargin();
    }

    // ── THE FIX: the evaluation instant is captured HERE, after every read has settled. ──
    const evaluatedAt: EvidenceInstant = { mono: clock.mono(), wall: clock.wall() };
    const currentIdentity = this.evidenceIdentity();

    const fundsAged = ageEvidence({
      observation: fundsObs,
      evaluatedAt,
      maxAgeMs: this.deps.cfg.liveFundsFreshnessMaxAgeMs,
      futureSkewGraceMs,
      currentIdentity,
      label: "available-funds",
    });
    const marginAged = ageEvidence({
      observation: marginObs,
      evaluatedAt,
      maxAgeMs: this.deps.cfg.liveMarginFreshnessMaxAgeMs,
      futureSkewGraceMs,
      currentIdentity,
      label: "planned-margin",
    });

    const marginValue = marginObs.value;
    // Resolve what the broker's funds figures actually MEAN before using them as money. Uses the
    // identity captured after the reads settled, so a broker switch in flight cannot have this
    // resolved against the wrong broker's semantics.
    const usableFunds = usableFundsRupees({
      broker: currentIdentity?.broker ?? null,
      availableRupees: fundsObs.value?.availableRupees ?? null,
      utilisedRupees: fundsObs.value?.utilisedRupees ?? null,
    });
    const picture = buildEconomicPicture({
      requests,
      now: evaluatedAt.wall,
      // SPENDABLE funds, derived through the DECLARED per-broker semantics rather than by assuming
      // what the broker's "available" figure means. Whether `available` is already net of the
      // encumbrance decides the arithmetic completely, and the two possible mistakes are not
      // symmetric: understating refuses affordable entries (safe), overstating admits an entry the
      // account cannot fund and leaves partially-executed exposure to recover from. So an unverified
      // broker gets the conservative reading and says so in the refusal. See box/fundsSemantics.ts.
      availableFundsRupees: usableFunds.value_rupees,
      availableFundsBasis: usableFunds.basis,
      availableFundsAged: fundsAged,
      availableFundsObservedAtWall: fundsObs.at?.wall ?? null,
      availableFundsObservedAtMono: fundsObs.at?.mono ?? null,
      plannedMarginRupees: marginValue?.marginRupees ?? null,
      plannedMarginAged: marginAged,
      plannedMarginObservedAtWall: marginObs.at?.wall ?? null,
      plannedMarginObservedAtMono: marginObs.at?.mono ?? null,
      planFingerprint,
      estimatedChargesRupees: this.chargesForRequests(requests),
      expectedLegCount: BOX_LEG_ROLES.length,
      // Section 8: the stage model needs INITIAL and FINAL basket margin kept apart. It is built
      // only when the provider actually supplied them, so a broker that cannot distinguish the two
      // produces an explicit "unknown stage" refusal rather than a fabricated stage requirement.
      ...(marginValue && (marginValue.initialMarginRupees != null || marginValue.finalMarginRupees != null)
        ? {
            funding: {
              transportOrder: entrySubmissionOrder(direction),
              initialMarginRupees: marginValue.initialMarginRupees ?? null,
              finalMarginRupees: marginValue.finalMarginRupees ?? null,
              // THE ENCUMBRANCE, PREFERRED FROM THE FUNDS ENDPOINT. The basket-margin endpoint prices
              // a hypothetical basket and does not report what is already blocked on the account, so
              // it supplied null and the stage model could never establish a requirement. The funds
              // endpoint does report it, from the same response that supplies `available`. Missing is
              // preserved as null so the funding gate refuses rather than assuming the account is
              // otherwise idle — other applications trading the same account are exactly that hazard.
              encumbranceRupees: fundsObs.value?.utilisedRupees ?? marginValue.encumbranceRupees ?? null,
              // ...AND REPORTED, NOT RE-CHARGED. `usableFunds` above came from `usableFundsRupees`,
              // which already returns SPENDABLE funds for every broker — passing `available`
              // through when the broker documents it as net, and subtracting the utilisation when
              // it does not (or when the semantics are unverified). Adding that same utilisation
              // into the requirement as well made the comparison `A − U ≥ R + U`, i.e. it demanded
              // `A ≥ R + 2U`: the account was charged twice for rupees blocked once. The
              // encumbrance is still surfaced in the picture for diagnostics.
              encumbranceNettedFromAvailableFunds: usableFunds.encumbranceNettedFromAvailable,
              recoveryReserveRupees: this.deps.cfg.liveRecoveryReserveRupees,
            },
          }
        : {}),
    });

    const report = evaluateEconomicAdmission({
      picture,
      // Reuse the SAME gross cap as the notional gate for the gross-notional check inside the
      // economic evaluator; the funds/margin controls are independent of it.
      grossCapRupees: this.capitalLimitRupees(),
      requireFundsCover,
      requireMarginEvidence,
      requireStageFunding,
      evaluatedAt: evaluatedAt.wall,
      planFingerprint,
      evidenceContext: currentIdentity,
      readElapsedMs: { funds: fundsObs.elapsed_ms, margin: marginObs.elapsed_ms },
    });
    this.lastEconomicReport = report;
    // Retained so the SEND BOUNDARY can re-check expiry and the plan without re-fetching.
    this.economicEvidence = report.allowed
      ? {
          fundsObservedAtMono: fundsObs.at?.mono ?? null,
          marginObservedAtMono: marginObs.at?.mono ?? null,
          fundsMaxAgeMs: this.deps.cfg.liveFundsFreshnessMaxAgeMs,
          marginMaxAgeMs: this.deps.cfg.liveMarginFreshnessMaxAgeMs,
          planFingerprint,
          identity: currentIdentity,
          // Mirror the evaluator's IMPLICATION: stage funding requires the funds comparison, so the
          // SEND-BOUNDARY re-check must also treat the funds evidence as load-bearing. Without this,
          // a stage-funding deployment would re-validate the margin evidence at the boundary but let
          // the funds evidence expire unchecked — re-opening at the send boundary exactly the hole
          // that was just closed at admission.
          fundsRequired: requireFundsCover || requireStageFunding,
          marginRequired: requireMarginEvidence || requireStageFunding,
        }
      : null;
    return report;
  }

  /** The clock pair evidence is stamped against: wall for audit, monotonic for durations. */
  private evidenceClock(): EvidenceClock {
    return {
      wall: () => this.now(),
      mono: () => this.deps.monotonicNow?.() ?? monotonicNow(),
    };
  }

  /** Who the evidence is about, in non-secret form. Null when the deployment cannot report it. */
  private evidenceIdentity(): EvidenceIdentity | null {
    if (this.deps.evidenceContext) return this.deps.evidenceContext();
    const broker = this.deps.broker?.();
    return broker ? { broker, account_ref: null, session_id: null } : null;
  }

  /**
   * THE FINAL ENTRY BOUNDARY for economic evidence (section 3 requirement 12).
   *
   * Called by the order manager at the last moment before a broker mutation, after queueing,
   * durable persistence and broker pacing have each consumed real time. It refuses when:
   *   - the evidence that admitted this entry has since EXPIRED, or
   *   - the order plan about to be sent DIFFERS from the plan the evidence was fetched for, or
   *   - the broker/account/session has CHANGED since admission.
   *
   * It returns a reason string to refuse, or null to allow. It does NOT decide what happens once
   * exposure already exists — the manager owns that, and its policy is "no exposure ⇒ refuse;
   * exposure taken ⇒ complete and record", which is why this must never be used to abandon a leg
   * that could already be filling.
   */
  private economicSendBoundary(request?: BrokerOrderRequest): string | null {
    const evidence = this.economicEvidence;
    if (!evidence) return null; // no economic control enabled, or admission produced no evidence
    const mono = this.deps.monotonicNow?.() ?? monotonicNow();

    if (evidence.fundsRequired && evidence.fundsObservedAtMono !== null) {
      const age = monoElapsed(evidence.fundsObservedAtMono, mono);
      if (age === null || age > evidence.fundsMaxAgeMs) {
        return `available-funds evidence EXPIRED before transmit (age ${age ?? "?"}ms > ${evidence.fundsMaxAgeMs}ms)`;
      }
    }
    if (evidence.marginRequired && evidence.marginObservedAtMono !== null) {
      const age = monoElapsed(evidence.marginObservedAtMono, mono);
      if (age === null || age > evidence.marginMaxAgeMs) {
        return `planned-margin evidence EXPIRED before transmit (age ${age ?? "?"}ms > ${evidence.marginMaxAgeMs}ms)`;
      }
    }
    const mismatch = identityMismatch(evidence.identity, this.evidenceIdentity());
    if (mismatch) return `economic evidence no longer applies: ${mismatch}`;

    // PLAN BINDING. The manager hands us the request it is about to POST; if its contract, side,
    // quantity or limit price is not the one the margin figure was computed for, the evidence is
    // not about this order.
    if (request) {
      const leg = orderPlanFingerprint([request]);
      if (!evidence.planFingerprint.split("|").includes(leg)) {
        return (
          "order plan CHANGED after evidence acquisition (quantity or limit price differs from the " +
          `plan the margin figure was fetched for): ${leg}`
        );
      }
    }
    return null;
  }

  /** Estimated charges (₹) for a request set, from the local fee calculator when available. */
  private chargesForRequests(requests: readonly BrokerOrderRequest[]): number | null {
    if (!this.deps.chargeTotal) return null;
    try {
      return this.deps.chargeTotal(
        requests.map((r) => ({
          side: r.side,
          tradingsymbol: r.tradingsymbol,
          quantity: r.quantity,
          price: r.pricing.limit_price,
        })),
      );
    } catch {
      return null;
    }
  }

  /**
   * The last economic-admission decision, for status/diagnostics.
   *
   * Returns null until an economic control has run at least once. The picture carries all five
   * quantities with their provenance so an operator can see, e.g., ample funds but stale margin.
   */
  economicDiagnostics(): EconomicAdmissionReport | null {
    return this.lastEconomicReport;
  }

  /**
   * FUNDING READINESS — always answerable, including when every evidence gate is off.
   *
   * `economicDiagnostics()` is deliberately null until a control has run, and stays null forever
   * when all three gates are disabled. That null is honest but ambiguous to read: "nothing was
   * checked" and "checked and fine" are different facts and must not share a representation. This
   * accessor names which of the five funding states the deployment is actually in, reports the
   * EFFECTIVE gate settings (including the stage-funding ⇒ funds-cover implication), and states the
   * standing limitations — so a deployment review can see that funding is unverified rather than
   * inferring it from an absent object.
   *
   * It reads only already-resolved config and the last decision: no broker call, no side effect.
   */
  fundingReadiness(brokerLimitations: readonly string[] = []): FundingReadiness {
    return buildFundingReadiness({
      live: this.mode === "live",
      requireFundsCover: this.deps.cfg.liveRequireFundsCover === true,
      requireMarginEvidence: this.deps.cfg.liveRequireMarginEvidence === true,
      requireStageFunding: this.deps.cfg.liveRequireStageFunding === true,
      recoveryReserveRupees: this.deps.cfg.liveRecoveryReserveRupees,
      freshness: {
        funds_max_age_ms: this.deps.cfg.liveFundsFreshnessMaxAgeMs,
        margin_max_age_ms: this.deps.cfg.liveMarginFreshnessMaxAgeMs,
        read_timeout_ms: this.deps.cfg.liveEvidenceReadTimeoutMs,
      },
      report: this.lastEconomicReport,
      brokerLimitations,
    });
  }

  /**
   * Observe the four legs' CURRENT books as coherence evidence.
   *
   * The socket generation is captured per leg (a cold/unwarm token is treated as belonging to no
   * current generation, so the gate fails it closed) so a reconnect between legs is caught as a
   * generation split rather than silently trading books from two different epochs. Movement between
   * admission and re-check is detected by the store advancing `version`; the reference is the
   * current version at capture time, so a duplicate-echoed packet leaves both equal.
   */
  private coherenceObservations(candidate: BoxCandidate): CoherenceLegObservation[] {
    const generation = this.deps.feedGeneration?.() ?? null;
    return BOX_LEG_ROLES.map((role) => {
      const token = candidate.legs[role].token;
      const quote = this.deps.quotes.get(token);
      const warm = this.deps.isTokenWarm ? this.deps.isTokenWarm(token) : true;
      return {
        role,
        received_at: quote ? quote.at : null,
        exchange_at: quote ? quote.exchange_at : null,
        current_version: quote ? quote.version : null,
        reference_version: quote ? quote.version : null,
        generation: warm ? generation : null,
        has_depth: quote ? quote.bids.length > 0 && quote.asks.length > 0 : false,
      } satisfies CoherenceLegObservation;
    });
  }

  /** The LIVE coherence admission decision for a candidate's current four books. */
  private evaluateEntryCoherence(candidate: BoxCandidate, now: number): CoherenceDecision {
    return evaluateBookCoherence(
      this.coherenceObservations(candidate),
      livePolicyFromConfig(this.deps.cfg),
      now,
      { currentGeneration: this.deps.feedGeneration?.() ?? null },
    );
  }

  /** The LIVE coherence RE-CHECK decision (admission + duplicate/stall guard). */
  private recheckEntryCoherence(candidate: BoxCandidate, now: number): CoherenceDecision {
    return recheckBookCoherence(
      this.coherenceObservations(candidate),
      livePolicyFromConfig(this.deps.cfg),
      now,
      { currentGeneration: this.deps.feedGeneration?.() ?? null },
    );
  }

  /**
   * Current-feed authority for ONE request.
   *
   * The four refusal conditions are unchanged and are still applied in the same order; the only
   * difference from the historical `precheck` loop is that a refusal is RETURNED rather than thrown,
   * so a caller may decide whether the failure is fatal to a whole batch or only to this leg.
   * Nothing here admits a request it previously rejected.
   */
  private precheckOne(
    request: BrokerOrderRequest,
    checkedAt: number,
    feedGeneration: number,
  ): { stamp: CheckedFeedStamp; reason: null } | { stamp: null; reason: string } {
    if (this.mode === "live" && this.deps.isTokenWarm && !this.deps.isTokenWarm(request.token)) {
      return { stamp: null, reason: `${request.tradingsymbol} has not received a WebSocket tick in the current feed generation.` };
    }
    const quote = this.deps.quotes.get(request.token);
    if (!quote) return { stamp: null, reason: `${request.tradingsymbol} has no live depth.` };
    const age = checkedAt - quote.at;
    if (this.deps.isTokenWarm && (!Number.isFinite(age) || age < 0 || age > this.deps.cfg.quoteMaxAgeMs)) {
      return { stamp: null, reason: `${request.tradingsymbol} has no current executable depth.` };
    }
    const walk = walkDepth({
      side: request.side,
      levels: request.side === "BUY" ? quote.asks : quote.bids,
      remainingQty: request.quantity,
      limitPrice: request.pricing.limit_price,
      queueModel: this.deps.cfg.queueModel,
      haircutPct: this.deps.cfg.queueLiquidityHaircutPct,
      at: quote.at,
      quoteVersion: quote.version,
    });
    if (walk.executable_within_limit < request.quantity) {
      return {
        stamp: null,
        reason: `${request.tradingsymbol} has ${walk.executable_within_limit} safe quantity within bounded limit; needs ${request.quantity}.`,
      };
    }
    return {
      stamp: {
        token: request.token,
        feed_generation: feedGeneration,
        quote_version: quote.version,
        quote_at: quote.at,
        checked_at: checkedAt,
      },
      reason: null,
    };
  }

  /**
   * ALL-OR-NOTHING precheck, for batches where a partial batch is not a valid outcome.
   *
   * ENTRY uses this deliberately: a box that cannot place all four legs is not a box, so the first
   * unusable leg must abort the attempt before anything is transmitted. Behaviour is identical to
   * the original implementation, including the message text of each refusal.
   */
  private precheck(requests: BrokerOrderRequest[]): Map<string, CheckedFeedStamp> {
    const checked = new Map<string, CheckedFeedStamp>();
    const checkedAt = this.now();
    const feedGeneration = this.deps.feedGeneration?.() ?? 0;
    for (const request of requests) {
      const verdict = this.precheckOne(request, checkedAt, feedGeneration);
      if (verdict.reason !== null) throw new Error(verdict.reason);
      checked.set(request.client_order_id, verdict.stamp);
    }
    return checked;
  }

  /**
   * PROTECTIVE UNWIND of CONFIRMED entry exposure — exposure-aware, hedge-preserving.
   *
   * THE DEFECT THIS CLOSES. This used to walk `orders` in arbitrary array order and reverse each
   * confirmed fill, so on a partial entry it could SELL a filled long hedge before (or instead of)
   * buying back the short leg beside it. An accepted-but-unfilled buy-back then left a naked short
   * with its cover gone — the same failure as the exit path, reached from recovery instead.
   *
   * THE ORDER IS NOW DERIVED FROM EXPOSURE, not from array position (see exitDependencies.ts):
   *
   *   wave 0  reverse every SHORT the entry created (an unwind BUY; only ever reduces risk)
   *   wave 1  reverse the LONG hedges, each capped at the quantity PROVEN no longer needed as
   *           cover for the short beside it
   *
   * Anything held back is not lost: it stays as durable residual exposure for the flatten loop,
   * which is strictly safer than selling cover away and strictly better than doing nothing.
   */
  private async unwindConfirmed(orders: BrokerOrder[], instruments: Record<BoxLegRole, BoxOptionInstrument>, tradeId: string, attemptId: string): Promise<BrokerOrder[]> {
    const manager = this.requireManager();
    const unwinds: BrokerOrder[] = [];

    /** Confirmed exposure this entry actually created, by role. */
    const exposure = new Map<BoxLegRole, { order: BrokerOrder; quantity: number }>();
    for (const order of orders) {
      if (order.filled_quantity <= 0) continue;
      const prior = exposure.get(order.role);
      exposure.set(order.role, {
        order,
        quantity: (prior?.quantity ?? 0) + order.filled_quantity,
      });
    }

    /** Reverse `quantity` of one confirmed leg. Returns what the reversal proved. */
    const reverse = async (
      order: BrokerOrder,
      quantity: number,
    ): Promise<ExitWaveOutcome> => {
      const quote = this.deps.quotes.get(order.token);
      const side: OrderSide = order.side === "BUY" ? "SELL" : "BUY";
      const reference = quote ? touchPrice(side, quote.bids, quote.asks) : null;
      if (!reference) {
        manager.invariantViolation(`cannot price protective unwind for ${order.client_order_id}`);
        return { filled: 0, certain: false };
      }
      try {
        const request = this.request({
          role: order.role,
          inst: instruments[order.role],
          side,
          quantity,
          referencePrice: reference,
          tradeId,
          attemptId,
          purpose: "EMERGENCY_RESIDUAL",
          phase: "unwind",
        });
        const checkedFeed = this.precheck([request]);
        const result = await manager.submit(request, checkedFeed.get(request.client_order_id));
        unwinds.push(result);
        return { filled: result.filled_quantity, certain: isBrokerOrderTerminal(result.state) };
      } catch (error) {
        if (error instanceof OrderPersistenceAfterFillError) {
          unwinds.push(error.order);
          manager.invariantViolation(`protective unwind failed for ${order.client_order_id}: ${errorMessage(error)}`);
          return { filled: error.order.filled_quantity, certain: false };
        }
        manager.invariantViolation(`protective unwind failed for ${order.client_order_id}: ${errorMessage(error)}`);
        // A LOCAL pre-submit refusal proves no POST, so the exposure is intact and known; anything
        // else may leave a fill with the broker and must be treated as unprovable.
        return { filled: 0, certain: error instanceof BrokerPreSubmitRefusedError };
      }
    };

    // ── wave 0: buy back every short the entry created ──────────────────────────────────────
    const reduced = new Map<BoxLegRole, ExitWaveOutcome>();
    for (const role of BOX_LEG_ROLES) {
      const item = exposure.get(role);
      if (!item || item.order.side !== "SELL") continue;
      reduced.set(role, await reverse(item.order, item.quantity));
    }

    // ── wave 1: release long hedges only up to proven-free quantity ─────────────────────────
    for (const role of BOX_LEG_ROLES) {
      const item = exposure.get(role);
      if (!item || item.order.side !== "BUY") continue;
      const partner = verticalPartner(role);
      const partnerExposure = exposure.get(partner);
      const shortOutstanding = partnerExposure && partnerExposure.order.side === "SELL"
        ? partnerExposure.quantity
        : 0;
      const evidence = reduced.get(partner);
      const releasable = releasableHedgeQuantity({
        hedgeOutstanding: item.quantity,
        short: {
          shortOutstanding,
          confirmedClosed: evidence?.filled ?? 0,
          certain: evidence?.certain ?? false,
        },
      });
      if (releasable <= 0) {
        manager.invariantViolation(
          `protective unwind ${attemptId} preserved hedge ${role} (${item.quantity}) because short ${partner} ` +
            `still has ${shortOutstanding - Math.min(evidence?.certain ? evidence.filled : 0, shortOutstanding)} ` +
            `outstanding; the exposure is carried as residual instead of sold`,
        );
        continue;
      }
      await reverse(item.order, releasable);
    }
    return unwinds;
  }

  private requireManager(): BoxOrderManager {
    if (!this.deps.manager) throw new Error("Live execution manager is unavailable; live execution is blocked.");
    return this.deps.manager;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function brokerOrderFromDurableIntent(intent: IBoxOrderIntent): BrokerOrder {
  return {
    client_order_id: intent.client_order_id,
    broker_order_id: intent.broker_order_id,
    tag: intent.broker_tag,
    role: intent.role,
    trade_id: intent.trade_id,
    attempt_id: intent.attempt_id,
    purpose: intent.purpose,
    phase: intent.phase,
    exchange: intent.exchange,
    tradingsymbol: intent.tradingsymbol,
    token: intent.token,
    side: intent.side,
    quantity: intent.quantity,
    pricing: {
      order_type: "LIMIT",
      reference_price: intent.reference_price,
      tick_size: intent.tick_size,
      max_chase_ticks: intent.max_chase_ticks,
      limit_price: intent.limit_price,
    },
    limit_price: intent.limit_price,
    state: intent.state,
    filled_quantity: intent.filled_quantity,
    pending_quantity: Math.max(0, intent.quantity - intent.filled_quantity),
    average_price: intent.average_price,
    fills: [],
    reject_family: intent.reject_family as BrokerOrder["reject_family"],
    reject_reason: intent.reject_reason,
    created_at: intent.created_at.getTime(),
    updated_at: intent.updated_at.getTime(),
  };
}

export function hasDurableLocalNoPostProvenance(intent: IBoxOrderIntent): boolean {
  if (intent.state !== "REJECTED" || intent.filled_quantity !== 0 || intent.broker_order_id !== null) {
    return false;
  }
  return intent.audit.some((event) => {
    const payload = event.payload;
    return event.to_state === "REJECTED" &&
      payload?.origin === "local_pre_submit_refusal" &&
      payload.no_broker_post === true &&
      (payload.stage === "dequeue" ||
        payload.stage === "post_persist" ||
        payload.stage === "pre_post");
  });
}

function stableAttemptId(scope: string, at: number, purpose: string): string {
  return `${purpose.toLowerCase()}-${stableHash(`${scope}:${at}:${purpose}`)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function evaluationFromFills(detection: BoxEvaluation, orders: BrokerOrder[]): BoxEvaluation {
  const byRole = new Map(orders.map((order) => [order.role, order]));
  const legs = detection.legs.map((leg) => {
    const order = byRole.get(leg.role);
    return order ? { ...leg, price: order.average_price, qty_at_touch: order.filled_quantity, executable: order.filled_quantity > 0 } : leg;
  });
  const netPerUnit = legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? 1 : -1) * (leg.price ?? 0), 0);
  const gross = round2((directionSign(detection.candidate.direction) * detection.candidate.box_width - netPerUnit) * detection.candidate.lot_size);
  return { ...detection, at: Math.max(...orders.map((order) => order.updated_at)), legs, entry_net_debit_per_unit: netPerUnit, entry_box_cost_per_unit: netPerUnit, gross_edge_per_unit: gross / detection.candidate.lot_size, gross_edge: gross, tradable: true, depth_ok: true, reject: null };
}

function slippageFromFills(detection: BoxLegEvaluation[], orders: BrokerOrder[]): number {
  const byRole = new Map(detection.map((leg) => [leg.role, leg]));
  return round2(orders.reduce((sum, order) => {
    const detected = byRole.get(order.role)?.price ?? order.average_price ?? 0;
    const fill = order.average_price ?? detected;
    return sum + (order.side === "BUY" ? fill - detected : detected - fill) * order.filled_quantity;
  }, 0));
}

function liveEntryFailure(candidate: BoxCandidate, detectedAt: number, submittedAt: number, orders: BrokerOrder[], reason: BoxExecutionFailureReason, detail: string, cfg: BoxConfig, tradeId: string | null, residualOverride?: ResidualLegExposure[], unwindOrders: BrokerOrder[] = []): Extract<BoxLeggingResult, { ok: false }> {
  const record = liveRecord(detectedAt, submittedAt, orders, false, cfg, BOX_LEG_ROLES.length, tradeId);
  const unwindByRole = new Map(unwindOrders.map((order) => [order.role, order]));
  for (const leg of record.legs) {
    const unwind = unwindByRole.get(leg.role);
    if (!unwind || unwind.filled_quantity <= 0) continue;
    leg.unwound_qty = unwind.filled_quantity;
    leg.unwind_price = unwind.average_price;
    // SLIPPAGE IS UNKNOWABLE WITHOUT AN ENTRY PRICE. `leg.fill_price ?? 0` reported the ENTIRE
    // unwind price as slippage whenever the entry average was unpublished — a fabricated loss that
    // then fed calibration. An unknown input must produce an unknown output, exactly as a null
    // unwind price already does.
    leg.unwind_slippage = unwind.average_price === null || leg.fill_price === null || leg.fill_price === undefined
      ? null
      : leg.side === "BUY"
        ? round2(leg.fill_price - unwind.average_price)
        : round2(unwind.average_price - leg.fill_price);
  }
  record.failure_reason = reason;
  record.failure_detail = detail;
  record.residual_exposure = residualOverride ?? orders.filter((order) => order.filled_quantity > 0).map((order) => ({
    token: order.token,
    tradingsymbol: order.tradingsymbol,
    role: order.role,
    side: order.side,
    quantity: order.filled_quantity,
    /*
     * NEVER ₹0 FOR A REAL FILL.
     *
     * This was `order.average_price ?? 0`. Both adapters take deliberate care to keep an unpublished
     * average price NULL — "an unpublished average price is absent data, not a free execution" — and
     * this line then converted that absence into a claim that we acquired real exposure for nothing.
     * The residual/flatten and P&L arithmetic consume this field as evidence, so a ₹0 entry price
     * makes an unwind look like pure profit and reports the entire unwind price as slippage.
     *
     * `ResidualLegExposure.average_price` is not nullable, so the honest fallback is the price we
     * AUTHORISED rather than a fabricated zero. It errs conservatively in both directions: for a BUY
     * the limit is the most we agreed to pay (so cost is never understated), and for a SELL it is the
     * least we agreed to accept (so proceeds are never overstated). Zero is only reached if the
     * broker published neither an average nor a limit, which is not a state a filled order can be in.
     */
    average_price: order.average_price ?? order.limit_price ?? 0,
    source: "partial_entry",
    created_at: order.updated_at,
  }));
  return { ok: false, legging: record, reason, detail };
}

function liveRecord(detectedAt: number, submittedAt: number, orders: BrokerOrder[], opened: boolean, cfg: BoxConfig, requestedCount = orders.length, tradeId: string | null = null): PaperLeggingExecutionRecord {
  const legs = orders.map(paperLeg);
  const fully = orders.filter((order) => order.filled_quantity >= order.quantity).length;
  const fills: Partial<Record<BoxLegRole, number>> = {};
  for (const order of orders) fills[order.role] = order.filled_quantity;
  const fillTimes = orders.filter((order) => order.filled_quantity > 0).map((order) => order.updated_at);
  return {
    mode: "live",
    trade_id: tradeId,
    leg_execution_mode: cfg.legExecutionMode,
    detected_at: detectedAt,
    order_sent_at: submittedAt,
    filled_leg_count: fully,
    opened,
    failed_legs: orders.filter((order) => order.filled_quantity < order.quantity).map((order) => order.role),
    legs,
    first_to_last_fill_ms: fillTimes.length ? Math.max(...fillTimes) - Math.min(...fillTimes) : null,
    decision_to_first_fill_ms: fillTimes.length ? Math.min(...fillTimes) - detectedAt : null,
    decision_to_last_fill_ms: fillTimes.length ? Math.max(...fillTimes) - detectedAt : null,
    timed_out_legs: [],
    partial_fill_legs: orders.filter((order) => order.filled_quantity > 0 && order.filled_quantity < order.quantity).map((order) => order.role),
    exposure_started_at: fillTimes.length ? Math.min(...fillTimes) : null,
    exposure_ended_at: opened && fillTimes.length ? Math.max(...fillTimes) : null,
    exposure_duration_ms: opened && fillTimes.length ? Math.max(...fillTimes) - Math.min(...fillTimes) : null,
    decision_to_complete_ms: fillTimes.length ? Math.max(...fillTimes) - detectedAt : null,
    total_entry_slippage: 0,
    emergency_unwind: !opened && orders.some((order) => order.filled_quantity > 0),
    partial_entry_charges: null,
    unwind_charges: null,
    legging_gross_loss: null,
    legging_net_loss: null,
    abort_after_fill: false,
    final_expected_net_profit: null,
    required_expected_net_profit: null,
    temporal: null,
    residual_exposure: [],
    submitted_leg_count: requestedCount,
    fully_closed_role_count: fully,
    remaining_role_count: Math.max(0, requestedCount - fully),
    fills_by_role: fills,
    failure_reason: null,
    failure_detail: null,
  };
}

function paperLeg(order: BrokerOrder): PaperLegExecution {
  const filled = order.filled_quantity;
  return {
    role: order.role,
    side: order.side,
    token: order.token,
    tradingsymbol: order.tradingsymbol,
    order_id: order.broker_order_id ?? order.client_order_id,
    client_order_id: order.client_order_id,
    pricing: { order_type: "MARKETABLE_LIMIT", side: order.side, quantity: order.quantity, reference_price: order.pricing.reference_price, tick_size: order.pricing.tick_size, max_chase_ticks: order.pricing.max_chase_ticks, limit_price: order.limit_price },
    detected_price: order.pricing.reference_price,
    detected_qty: order.quantity,
    submit_at: order.created_at,
    arrival_at: order.created_at,
    // This projection describes a LIVE order rendered in the paper shape for reporting. The
    // live path records its own stage timings through the timing recorder, so these
    // paper-only race fields stay null rather than being back-filled with a guess.
    ack_at: null,
    pending_since: null,
    timeout_at: null,
    cancel_requested_at: null,
    cancel_confirmed_at: null,
    fill_qty_at_cancel_request: null,
    raced_fill_qty: 0,
    // Live orders carry no simulated cancel stage: the broker, not the simulator, decided.
    cancel_stage: null,
    // A live order is filled by the exchange, not by walking a book, so there is no
    // "executable within limit" observation to report. Left null rather than back-filled.
    executable_within_limit_at_arrival: null,
    displayed_qty_at_arrival: null,
    limit_offset_ticks: null,
    fill_at: filled > 0 ? order.updated_at : null,
    resolved_at: order.updated_at,
    fill_price: order.average_price,
    average_fill_price: order.average_price,
    quantity: order.quantity,
    requested_qty: order.quantity,
    fill_qty: filled,
    remaining_qty: order.quantity - filled,
    // PRICED SLICES ONLY. `PaperFillSlice.price` is a number by contract, so a fill whose price the
    // broker has not published is deliberately absent from this list rather than rendered at zero.
    // The exposure is not lost: `fill_qty` above is the broker's cumulative quantity, and
    // `average_fill_price` is null, which is how a reader knows the pricing is still pending.
    fills: order.fills
      .filter((fill): fill is typeof fill & { price: number } => fill.price !== null)
      .map((fill) => ({ price: fill.price, qty: fill.quantity, displayed_qty: fill.quantity, effective_qty: fill.quantity, at: fill.at, quote_version: null })),
    quote_version: null,
    book_at: order.updated_at,
    book_exchange_at: null,
    book_age_ms: null,
    slippage: null,
    status: order.state === "COMPLETE" ? "FILLED" : order.state === "CANCELLED" ? (filled > 0 ? "PARTIALLY_FILLED" : "CANCELLED") : order.state === "REJECTED" ? "FAILED" : "PENDING",
    unwind_price: null,
    unwind_slippage: null,
    unwound_qty: 0,
    fail_reason: order.reject_reason,
  };
}

function legsFromOrders(orders: BrokerOrder[], instruments: Record<BoxLegRole, BoxOptionInstrument>, quotes: BoxQuoteStore, now: number): BoxLegEvaluation[] {
  return orders.filter((order) => order.filled_quantity > 0).map((order) => {
    const inst = instruments[order.role];
    const quote = quotes.get(order.token);
    return {
      role: order.role,
      side: order.side,
      token: order.token,
      tradingsymbol: order.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      price: order.average_price,
      qty_at_touch: order.filled_quantity,
      bid: quote?.bid ?? 0,
      bid_qty: quote?.bid_qty ?? 0,
      ask: quote?.ask ?? 0,
      ask_qty: quote?.ask_qty ?? 0,
      quote_at: quote?.at ?? null,
      quote_version: quote?.version ?? null,
      depth: quote ? { bids: quote.bids.map((level) => ({ ...level })), asks: quote.asks.map((level) => ({ ...level })) } : null,
      age_ms: quote ? now - quote.at : null,
      fresh: true,
      executable: order.average_price !== null && order.average_price > 0,
    };
  });
}

/**
 * Project the settled entry into the authoritative per-role outcomes the recovery plan needs.
 *
 * A role with NO order snapshot was not submitted, or was refused before any POST. That is safe
 * to report as `submitted: false` — and NOT as unknown — only because the caller has already
 * quarantined every ambiguous case: `ordersFromSettled` surfaces an order for an ambiguous submit
 * and for a persistence-after-fill, and the `uncertain` check refuses to continue when any such
 * order is present. So by construction, a missing snapshot here means "no exposure was created",
 * while a present one is terminal with a broker-confirmed cumulative quantity.
 *
 * ON TERMINALITY, and why it is NOT `isBrokerOrderTerminal(order.state)`.
 *
 * By the time `manager.submit` resolves, the adapter has already driven the order to a settled
 * outcome — polling to a terminal state and, on timeout, protectively cancelling and CONFIRMING
 * the final cumulative quantity. An order it could not settle surfaces as `UNKNOWN` or
 * `RECONCILIATION_REQUIRED`, which the caller has already quarantined.
 *
 * So a `PARTIALLY_FILLED` snapshot arriving here is not "still working": it is a settled partial
 * whose `filled_quantity` is the authoritative final quantity. Gating the unwind on the lifecycle
 * enum instead of on PROVABILITY would refuse to reverse exactly those confirmed partial fills and
 * strand them as naked exposure. Both fields are therefore derived from the single question that
 * actually matters — is the quantity provable? — which is what the pre-existing code trusted.
 */
function entryLegOutcomes(
  requests: readonly BrokerOrderRequest[],
  orders: readonly BrokerOrder[],
): EntryLegOutcome[] {
  const byRole = new Map(orders.map((order) => [order.role, order]));
  return requests.map((request) => {
    const order = byRole.get(request.role);
    if (!order) {
      return {
        role: request.role,
        side: request.side,
        requested: request.quantity,
        confirmedFilled: 0,
        terminal: true,
        submitted: false,
        brokerStateKnown: true,
      };
    }
    const provable = order.state !== "UNKNOWN" && order.state !== "RECONCILIATION_REQUIRED";
    return {
      role: order.role,
      side: order.side,
      requested: order.quantity,
      // BROKER CUMULATIVE FILLED QUANTITY — the only fill authority.
      confirmedFilled: order.filled_quantity,
      terminal: provable,
      submitted: true,
      brokerStateKnown: provable,
    };
  });
}

function residualAfterUnwind(entries: BrokerOrder[], unwinds: BrokerOrder[]): ResidualLegExposure[] {
  const unwindByRole = new Map(unwinds.map((order) => [order.role, order.filled_quantity]));
  return entries.flatMap((entry) => {
    const remaining = entry.filled_quantity - (unwindByRole.get(entry.role) ?? 0);
    if (remaining <= 0) return [];
    return [{
      token: entry.token,
      tradingsymbol: entry.tradingsymbol,
      exchange: entry.exchange,
      role: entry.role,
      side: entry.side,
      quantity: remaining,
      average_price: entry.average_price ?? 0,
      source: "partial_entry" as const,
      created_at: entry.updated_at,
    }];
  });
}

/**
 * Re-sort broker orders into CANONICAL role order.
 *
 * Entry requests are now built and transmitted HEDGE-FIRST, so the settled results arrive in
 * transport order. Every consumer downstream pairs BY ROLE, but the execution RECORD builds its
 * `legs` array positionally — so without this the persisted and API-visible leg order would have
 * silently changed from `[k1_ce, k2_ce, k2_pe, k1_pe]` to the transport permutation.
 *
 * Transport order is an execution-safety decision; leg-array order is an output contract. This
 * keeps them independent, which is exactly what "preserve accounting by role rather than array
 * position" requires.
 */
function canonicalRoleOrder(orders: BrokerOrder[]): BrokerOrder[] {
  const rank = new Map(BOX_LEG_ROLES.map((role, index) => [role, index]));
  return [...orders].sort(
    (a, b) => (rank.get(a.role) ?? BOX_LEG_ROLES.length) - (rank.get(b.role) ?? BOX_LEG_ROLES.length),
  );
}

function ordersFromSettled(results: PromiseSettledResult<BrokerOrder>[]): BrokerOrder[] {
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return [result.value];
    if (result.reason instanceof BrokerAmbiguousSubmitError && result.reason.order) {
      return [result.reason.order];
    }
    return result.reason instanceof OrderPersistenceAfterFillError
      ? [result.reason.order]
      : [];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
