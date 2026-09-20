/**
 * The box scanner: the event-driven discovery and entry path.
 *
 *   Kite WebSocket → quote map → affected candidates → fast LOCAL calculation
 *   → net-profit qualification → centralized execution gateway → durable trade
 *
 * Nothing on the qualification path touches MongoDB, and nothing waits on the
 * frontend OR on Zerodha. Charges are computed synchronously by the local
 * calculator; Zerodha is consulted only afterwards, to reconcile. A tick affects
 * only the candidates that reference the token that moved.
 *
 * The scanner never calls Kite order APIs directly. Qualified candidates are
 * handed to a narrow execution gateway: paper modes delegate to the deterministic
 * simulator, while explicit live mode uses durable bounded-LIMIT coordination.
 */

import type { BoxConfig } from "./config.js";
import { configSnapshot, prefilterGrossThreshold, requiredNetProfit } from "./config.js";
import {
  BoxChargeEstimator,
  buildEntryChargeLegs,
  type BoxChargeLeg,
} from "./charges.js";
import type { BoxExecutionGateway } from "./executionGateway.js";
import type { BoxChargeCalculatorLike } from "./brokerContext.js";
import {
  classifyExecutionFault,
  faultErrorType,
  faultMessage,
  type BoxParentAttemptReason,
  type ExecutionFaultLog,
  type ExecutionStage,
} from "./executionFaults.js";
import type { BoxMetrics } from "./metrics.js";
import {
  evaluateCandidate,
  evaluateCandidateIndicative,
  evaluateEntryDecision,
  passesGrossPrefilter,
  round2,
} from "./math.js";
import type { BoxQuoteStore } from "./quotes.js";
import type { BoxPositionBook } from "./positions.js";
import {
  BOX_LEG_ROLES,
  directionOf,
  type BoxCandidate,
  type BoxChargeOrigin,
  type BoxEntryDecision,
  type BoxEvaluation,
  type BoxExecutionFailureReason,
  type BoxExecutionRecord,
  type BoxOpportunity,
  type PaperLeggingExecutionRecord,
  type ResidualLegExposure,
} from "./types.js";

/** At most one hot-path evaluation-fault log line per this interval. */
const EVALUATION_FAULT_LOG_INTERVAL_MS = 5_000;

/** What the scanner needs from the outside world. */
export interface BoxScannerDeps {
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  /** Zerodha estimator — used ONLY for asynchronous reconciliation now. */
  charges: BoxChargeEstimator;
  /** The synchronous, deterministic charge calculator for the hot path. */
  /** The ACTIVE broker's charge calculator (see brokerContext.ts). */
  localCharges: BoxChargeCalculatorLike;
  /** Central mode-neutral execution gateway. */
  executionSim: BoxExecutionGateway;
  positions: BoxPositionBook;
  metrics?: BoxMetrics;
  /**
   * Bounded store for TECHNICAL entry failures.
   *
   * The metric label is only ever the fixed fault class; the detail an operator actually needs
   * (stage, sanitized message, stack, whether a reservation was held, whether exposure existed)
   * lands here instead of being crammed into a label. Optional so tests and the pure paths need
   * not supply it.
   */
  faults?: ExecutionFaultLog;
  /** Live only: has execution reached the broker for this attempt? Null/absent in paper. */
  reachedBroker?: () => boolean;
  /** Which broker the fault is attributable to. Diagnostics only. */
  activeBroker?: () => string;
  /** Opens the paper trade. Returns the trade id, or null when it did not open. */
  openPaperTrade: (args: {
    candidate: BoxCandidate;
    /** The EXECUTION snapshot (with depth) the fill was taken from. */
    evaluation: BoxEvaluation;
    entryLegs: BoxChargeLeg[];
    entryChargesTotal: number | null;
    estimatedExitChargesTotal: number | null;
    chargeOrigin: BoxChargeOrigin;
    decision: BoxEntryDecision;
    execution: BoxExecutionRecord | null;
    /** Present when the fill came from the paper_legging model (4/4 filled). */
    legging?: PaperLeggingExecutionRecord | null;
  }) => Promise<string | null>;
  /**
   * paper_legging only: a fill attempt that did NOT open a box (some legs filled
   * and were unwound, or none filled). Persisted so failed-execution losses are
   * not invisible in the strategy's analytics.
   */
  onExecutionAttempt?: (
    candidate: BoxCandidate,
    legging: PaperLeggingExecutionRecord,
    reason: BoxExecutionFailureReason,
    detail: string,
    /**
     * The gross edge measured at DETECTION (₹), which the legging record does not carry.
     * Cost attribution needs the edge the attempt set out to capture; without it there is
     * nothing to attribute against, so it is passed explicitly rather than substituted.
     */
    detectedGrossEdge?: number | null,
  ) => void;
  /** Ledger hook for rejections and detections. */
  onEvent: (
    event:
      | "DETECTED"
      | "ENTRY_REJECTED_STALE"
      | "ENTRY_REJECTED_LIQUIDITY"
      | "ENTRY_REJECTED_FEES"
      | "ENTRY_REJECTED_DUPLICATE"
      | "ENTRY_REJECTED_NET_PROFIT"
      | "ENTRY_REJECTED_EXECUTION",
    candidate: BoxCandidate,
    evaluation: BoxEvaluation,
    detail?: string,
  ) => void;
  /**
   * EXECUTION FUNNEL (Task 8), candidate stage. Called ONCE per candidate the scanner priced —
   * the widest denominator. Optional so tests and pure paths need not supply it; pure accounting,
   * never on the control path.
   */
  onCandidateEvaluated?: () => void;
  /**
   * EXECUTION FUNNEL (Task 8), qualified stage. Called when a candidate passed the economic
   * qualification gate (net-profit decision) and is about to be attempted. A strict subset of
   * candidates. Optional.
   */
  onQualified?: () => void;
  /**
   * THE OPERATOR BLOCKLIST, asked once per candidate that would otherwise be entered.
   *
   * Synchronous by contract: this runs on the tick path, so it must be an in-memory lookup and must
   * never await. Returning `true` means "do not enter this underlying" — which covers BOTH an
   * explicitly excluded name AND an unreadable blocklist, because a list we cannot read cannot
   * confirm any name is permitted (see exclusionEntryRefusal).
   *
   * Optional so tests and the pure paths need not supply it; absent means "nothing is excluded".
   * This is the CHEAPEST of the four enforcement points — it refuses before a reservation is taken,
   * before a session attempt is spent and before any order exists — but it is deliberately not the
   * only one, because a scanner-level check alone would be bypassed by any future entry originator.
   */
  isUnderlyingExcluded?: (underlying: string) => boolean;
  /**
   * A PARENT ENTRY ATTEMPT WAS REFUSED — with the underlying attached.
   *
   * The counterpart to `metrics.finishLogicalAttempt`, which receives the same reason but CANNOT be
   * told which name it belonged to: `rejection_categories` is a process-lifetime metric label space,
   * and putting a symbol in it is the cardinality explosion executionFaults.ts exists to prevent.
   * This hook feeds the bounded, aggregated `EntryAlertLedger` instead, which is where a symbol is
   * safe to key on.
   *
   * Called for EVERY refused attempt, deliberately unthrottled and with no gross prefilter — unlike
   * `logRejection`, whose per-candidate cooldown is right for an append-only event ledger and wrong
   * here. The ledger aggregates by (underlying, reason), so 354 identical refusals cost one group
   * with a count of 354; throttling would instead make the count a lie.
   *
   * Optional, so tests and pure paths need not supply it.
   */
  onEntryRejected?: (args: {
    readonly underlying: string;
    readonly reason: BoxParentAttemptReason;
    readonly detail: string | null;
    readonly candidateKey: string;
  }) => void;
}

/** Counters exposed by GET /api/box/status. */
export interface BoxScannerStats {
  ticksApplied: number;
  evaluations: number;
  prefilterPasses: number;
  qualifyAttempts: number;
  executionsAttempted: number;
  entriesOpened: number;
  rejectedStale: number;
  rejectedLiquidity: number;
  rejectedNetProfit: number;
  rejectedExecution: number;
  rejectedDuplicate: number;
  /**
   * Candidates that would have been entered but whose underlying is on the operator blocklist (or
   * whose blocklist was unreadable). Counted so an operator can see the control WORKING, rather than
   * inferring it from an absence of trades — a silent guard is indistinguishable from a broken one.
   */
  rejectedExcluded: number;
  /**
   * Candidate evaluations that threw on the hot path.
   *
   * A technical fault, not a market rejection, so it has its own counter rather than being pooled
   * into `rejectedExecution`. Always 0 in a healthy session.
   */
  evaluationFaults: number;
  lastEvaluationAt: number | null;
}

/**
 * Rejection events are only worth writing once per candidate per cooldown —
 * otherwise a single thin book would produce thousands of identical ledger rows.
 */
const REJECT_LOG_COOLDOWN_MS = 60_000;

export class BoxScanner {
  private candidates = new Map<string, BoxCandidate>();
  /** token → candidate keys that reference it. The dependency index. */
  private tokenIndex = new Map<number, Set<string>>();
  /** The newest published view of each candidate. */
  private opportunities = new Map<string, BoxOpportunity>();
  /** Candidates with an entry pipeline in flight. */
  private entryInFlight = new Set<string>();
  private lastRejectLogAt = new Map<string, number>();

  private discovering = false;
  private marketOpen = true;
  private feedHealthy = true;

  private stats: BoxScannerStats = {
    ticksApplied: 0,
    evaluations: 0,
    prefilterPasses: 0,
    qualifyAttempts: 0,
    executionsAttempted: 0,
    entriesOpened: 0,
    rejectedStale: 0,
    rejectedLiquidity: 0,
    rejectedNetProfit: 0,
    rejectedExecution: 0,
    rejectedDuplicate: 0,
    rejectedExcluded: 0,
    evaluationFaults: 0,
    lastEvaluationAt: null,
  };
  /** Throttle for hot-path fault logging; the fault log itself keeps every occurrence. */
  private lastEvaluationFaultLogAt = 0;

  constructor(private deps: BoxScannerDeps) {}

  /* ------------------------------ lifecycle ------------------------------ */

  setDiscovering(on: boolean): void {
    this.discovering = on;
  }

  isDiscovering(): boolean {
    return this.discovering;
  }

  setMarketOpen(open: boolean): void {
    this.marketOpen = open;
  }

  isMarketOpen(): boolean {
    return this.marketOpen;
  }

  setFeedHealthy(healthy: boolean): void {
    this.feedHealthy = healthy;
  }

  isFeedHealthy(): boolean {
    return this.feedHealthy;
  }

  getStats(): BoxScannerStats {
    return { ...this.stats };
  }

  /* ------------------------------ candidates ----------------------------- */

  setCandidatesForUnderlying(underlying: string, next: BoxCandidate[]): void {
    for (const [key, cand] of this.candidates) {
      if (cand.underlying !== underlying) continue;
      this.candidates.delete(key);
      this.opportunities.delete(key);
      for (const role of BOX_LEG_ROLES) {
        const set = this.tokenIndex.get(cand.legs[role].token);
        if (!set) continue;
        set.delete(key);
        if (set.size === 0) this.tokenIndex.delete(cand.legs[role].token);
      }
    }
    for (const cand of next) {
      this.candidates.set(cand.key, cand);
      for (const role of BOX_LEG_ROLES) {
        const token = cand.legs[role].token;
        let set = this.tokenIndex.get(token);
        if (!set) {
          set = new Set();
          this.tokenIndex.set(token, set);
        }
        set.add(cand.key);
      }
    }
  }

  removeUnderlying(underlying: string): void {
    this.setCandidatesForUnderlying(underlying, []);
  }

  get candidateCount(): number {
    return this.candidates.size;
  }

  get monitoredTokenCount(): number {
    return this.tokenIndex.size;
  }

  getCandidate(key: string): BoxCandidate | undefined {
    return this.candidates.get(key);
  }

  candidatesFor(underlying: string): BoxCandidate[] {
    return [...this.candidates.values()].filter((c) => c.underlying === underlying);
  }

  /* ------------------------------- hot path ------------------------------ */

  /**
   * Handle a batch of updated tokens.
   *
   * THE hot path. Synchronous, allocation-light, and only ever looks at
   * candidates that reference one of the tokens that changed.
   */
  onTokensUpdated(tokens: number[], receivedAt?: number): void {
    if (tokens.length === 0) return;
    this.stats.ticksApplied += tokens.length;

    let affected: Set<string> | null = null;
    for (const token of tokens) {
      const keys = this.tokenIndex.get(token);
      if (!keys) continue;
      if (!affected) affected = new Set();
      for (const k of keys) affected.add(k);
    }
    if (!affected) return;

    const now = Date.now();
    for (const key of affected) {
      const cand = this.candidates.get(key);
      if (!cand) continue;
      this.safeEvaluate(cand, now, receivedAt);
    }
  }

  refreshAll(): void {
    const now = Date.now();
    for (const cand of this.candidates.values()) {
      this.safeEvaluate(cand, now);
    }
  }

  /**
   * ONE CANDIDATE'S FAULT MUST NOT ABORT THE TICK.
   *
   * `evaluateAndMaybeEnter` is fully synchronous and runs in a loop over every candidate the tick
   * touched, and it calls the charge calculator (`localDecisionFor`) twice. An escaping error
   * therefore skipped every remaining candidate in the batch AND propagated out of
   * `onTokensUpdated` into the WebSocket tick handler — so one unpriceable candidate could stop
   * discovery for the whole universe. The position monitor has always had this guard for its
   * cycle; the scanner did not.
   *
   * Classified and recorded like any other technical fault, never silently swallowed.
   */
  private safeEvaluate(cand: BoxCandidate, now: number, receivedAt?: number): void {
    try {
      this.evaluateAndMaybeEnter(cand, now, receivedAt);
    } catch (err) {
      // The only thing that can throw out here is the pre-entry evaluation/projection: the entry
      // pipeline past this point has its own classified catch.
      const faultClass = classifyExecutionFault({ stage: "pre_decision", error: err });
      this.stats.evaluationFaults++;
      this.deps.faults?.record({
        at: now,
        fault_class: faultClass,
        stage: "pre_decision",
        execution_mode: this.deps.cfg.executionMode,
        paper_profile: this.deps.cfg.paperExecutionProfile,
        broker: this.deps.activeBroker?.() ?? null,
        error_type: faultErrorType(err),
        message: faultMessage(err),
        stack: err instanceof Error ? err.stack ?? null : null,
        candidate_key: cand.key,
        reservation_held: this.deps.positions.isTaken(cand.key),
        exposure_existed: this.deps.positions.getByKey(cand.key) !== undefined,
        reached_broker: null,
      });
      // Bounded logging: this runs at tick rate, so a persistent fault must not become a log flood.
      if (now - this.lastEvaluationFaultLogAt >= EVALUATION_FAULT_LOG_INTERVAL_MS) {
        this.lastEvaluationFaultLogAt = now;
        console.warn(
          `[Box] candidate evaluation ${faultClass} for ${cand.key} ` +
            `(${this.stats.evaluationFaults} total this session):`,
          err,
        );
      }
    }
  }

  private evaluateAndMaybeEnter(cand: BoxCandidate, now: number, receivedAt?: number): void {
    this.stats.evaluations++;
    this.stats.lastEvaluationAt = now;
    this.deps.metrics?.evaluations.mark(1, now);
    // EXECUTION FUNNEL (Task 8): every candidate the scanner prices is counted here — the widest
    // denominator. Pure accounting; failure is swallowed so it can never disturb the hot path.
    try { this.deps.onCandidateEvaluated?.(); } catch { /* diagnostics only */ }

    // Hot path: NO depth cloning. Only the touch view is built.
    const evaluation = evaluateCandidate({
      candidate: cand,
      quotes: this.deps.quotes.view(),
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      captureDepth: false,
    });

    if (receivedAt !== undefined) {
      this.deps.metrics?.receiveToEvaluation.push(Math.max(0, now - receivedAt));
    }

    const openKeyTaken = this.deps.positions.getByKey(cand.key) !== undefined;
    const threshold = prefilterGrossThreshold(this.deps.cfg);
    const passedPrefilter = passesGrossPrefilter(evaluation.gross_edge, threshold);
    if (passedPrefilter) this.stats.prefilterPasses++;

    this.publish(evaluation, {
      openKeyTaken,
      passedPrefilter,
      decision: this.localDecisionFor(evaluation, this.deps.cfg.expectedEntrySlippage),
    });

    if (!this.discovering) return;
    if (!this.marketOpen) return;
    if (!this.feedHealthy) return;
    if (openKeyTaken) return;
    /*
     * OPERATOR BLOCKLIST — enforcement point 1 of 4, and the cheapest.
     *
     * Placed AFTER `publish` on purpose: the opportunity stays visible on the board with its real
     * economics, so an operator can still see what they are declining. It is placed BEFORE
     * `positions.reserve`, before the session attempt budget and before any order exists, so an
     * excluded name costs nothing at all — no reservation, no durable write, no attempt spent.
     *
     * This is not the guarantee. The guarantee is the unbypassable check in
     * CentralBoxExecutionGateway; this one exists so the guarantee is almost never reached.
     */
    if (this.deps.isUnderlyingExcluded?.(cand.underlying) === true) {
      this.stats.rejectedExcluded++;
      return;
    }
    if (!evaluation.tradable) {
      this.noteRejection(cand, evaluation);
      return;
    }
    if (!passedPrefilter) return;
    if (this.entryInFlight.has(cand.key)) return;
    if (!this.deps.executionSim.hasCapacity()) return;

    // Only candidates that clear the fast local net-profit projection are worth
    // spending an execution pipeline on. This keeps the hot path cheap.
    const localDecision = this.localDecisionFor(evaluation, this.deps.cfg.expectedEntrySlippage);
    if (!localDecision || !localDecision.qualifies) {
      if (localDecision && localDecision.reject === "below_expected_net_profit") {
        this.noteNetProfitRejection(cand, evaluation, localDecision);
      }
      return;
    }

    // EXECUTION FUNNEL (Task 8): this candidate cleared the economic qualification gate and is
    // about to be attempted — a strict subset of candidates.
    try { this.deps.onQualified?.(); } catch { /* diagnostics only */ }

    // This is the rare transition from discovery into a real order pipeline, so
    // take one immutable four-book snapshot with depth. Hot tick evaluation stays
    // allocation-light; subsequent ticks cannot mutate this audit record.
    const executionDetection = evaluateCandidate({
      candidate: cand,
      quotes: this.deps.quotes.view(),
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      captureDepth: true,
    });
    void this.attemptEntry(cand, executionDetection);
  }

  /**
   * The projected expected-net-profit decision from the LOCAL calculator.
   *
   * Synchronous and allocation-cheap: the calculator does a few dozen float ops
   * and never touches the network. Used both to publish the opportunity's cost
   * breakdown and to decide whether a candidate is worth executing.
   */
  private localDecisionFor(
    evaluation: BoxEvaluation,
    entrySlippageAllowance: number,
  ): BoxEntryDecision | null {
    if (evaluation.gross_edge === null) return null;
    const legs = buildEntryChargeLegs(evaluation.candidate, evaluation.legs);
    if (!legs) return null;
    const totals = this.deps.localCharges.totals(
      legs.map((l) => ({
        side: l.side,
        tradingsymbol: l.tradingsymbol,
        quantity: l.quantity,
        price: l.price,
      })),
    );
    return evaluateEntryDecision({
      grossEdge: evaluation.gross_edge,
      entryCharges: totals.entry,
      estimatedExitCharges: totals.exit,
      // PRE-EXECUTION PROJECTION: this is the DETECTION gross edge, so an expected
      // entry-slippage allowance is deducted alongside the future exit allowance.
      entrySlippageAllowance,
      futureExitSlippageAllowance: this.deps.cfg.expectedExitSlippage,
      cfg: this.deps.cfg,
    });
  }

  /* ------------------------------ entry path ----------------------------- */

  /**
   * The paper-entry pipeline.
   *
   *   1. reserve the strike pair (synchronous, atomic)
   *   2. hand the DETECTION snapshot to the execution simulator
   *   3. the simulator waits the decision + latency delay and fills from the
   *      first post-arrival WebSocket book — re-qualifying on the EXECUTED prices
   *      with the MEASURED slippage
   *   4. only a qualified, filled execution creates the paper trade
   *
   * There is no charge network call anywhere on this path; the local calculator
   * prices both the projection and the final qualification.
   */
  private async attemptEntry(cand: BoxCandidate, detection: BoxEvaluation): Promise<void> {
    if (!this.deps.positions.reserve(cand.key)) {
      this.stats.rejectedDuplicate++;
      this.logRejection("ENTRY_REJECTED_DUPLICATE", cand, detection, "strike pair already taken");
      return;
    }
    this.entryInFlight.add(cand.key);
    this.stats.qualifyAttempts++;
    this.stats.executionsAttempted++;
    // This parent id represents ONE strategy decision. Four leg orders, recovery
    // work and retries remain child events and cannot change this denominator.
    const attemptId = `entry:${cand.key}:${detection.at}`;
    this.deps.metrics?.beginLogicalAttempt(attemptId);
    /**
     * WHERE WE ARE. Advanced as the pipeline progresses so the catch can classify a fault by the
     * subsystem that was actually running, rather than guessing from an exception string.
     */
    let stage: ExecutionStage = "pre_decision";
    /**
     * Assigned inside the try. It used to be computed BEFORE the try even though it calls the
     * charge calculator — so a throw there escaped `attemptEntry` entirely, leaving the candidate
     * permanently in `entryInFlight` and its strike pair permanently reserved, with the parent
     * attempt counted and never terminated.
     */
    let detectionDecision: BoxEntryDecision | null = null;
    const finish = (
      outcome: "SUCCESS" | "FAILED" | "PARTIAL_RECOVERED" | "PARTIAL_UNRESOLVED" | "ABORTED",
      reason: BoxParentAttemptReason | null,
      realisedExpectedNet: number | null,
      decisionToFillMs: number | null,
      arrivalExecutionSlippage: number | null,
    ) => this.deps.metrics?.finishLogicalAttempt(attemptId, outcome, reason, {
      decisionDeterioration:
        detectionDecision && detectionDecision.expected_net_profit !== null && realisedExpectedNet !== null
          ? round2(detectionDecision.expected_net_profit - realisedExpectedNet)
          : null,
      // Atomic paper fills are priced exactly from their captured arrival book, so
      // zero is an honest measurement. Modes without an arrival reference stay null.
      arrivalExecutionSlippage,
      detectionToDecisionMs: 0,
      decisionToOrderSendMs: 0,
      orderLatencyMs: decisionToFillMs,
      decisionToFillMs,
    });

    const stillWanted = () =>
      this.discovering &&
      this.marketOpen &&
      this.feedHealthy &&
      this.deps.positions.getByKey(cand.key) === undefined;

    /**
     * Run the final qualification with the stage temporarily set, because the gateway invokes it
     * as a callback from deep inside execution. Without this a charge-calculator fault would be
     * attributed to the broker.
     */
    const qualifyStaged = (execution: BoxEvaluation, measuredSlippage: number): BoxEntryDecision => {
      const outer = stage;
      stage = "final_qualification";
      try {
        return this.finalQualify(execution, measuredSlippage);
      } finally {
        stage = outer;
      }
    };

    try {
      detectionDecision = this.localDecisionFor(detection, this.deps.cfg.expectedEntrySlippage);
      stage = "execution";
      // Independent role orders in paper_legging and live modes.
      if (this.deps.cfg.executionMode === "paper_legging" || this.deps.cfg.executionMode === "live") {
        const legging = await this.deps.executionSim.simulateLeggingEntry({
          candidate: cand,
          detection,
          stillWanted,
          qualify: qualifyStaged,
        });
        if (!legging.ok) {
          // Some legs may have filled and been unwound: persist the attempt so the
          // legging loss is not invisible, then release.
          if (legging.legging.filled_leg_count > 0 || legging.legging.emergency_unwind) {
            this.deps.onExecutionAttempt?.(
              cand,
              legging.legging,
              legging.reason,
              legging.detail,
              detection.gross_edge,
            );
          }
          this.recordExecutionFailure(cand, detection, legging.reason, legging.detail);
          // WHICH NAME, AND WHY. Recorded before `finish` so the operator-facing ledger and the
          // metric agree on the same reason for the same attempt, and recorded unconditionally —
          // this is the branch that produced 354 invisible refusals, because it neither persists an
          // attempt row (no legs filled) nor survives the event ledger's per-candidate throttle.
          this.deps.onEntryRejected?.({
            underlying: cand.underlying,
            reason: legging.reason,
            detail: legging.detail,
            candidateKey: cand.key,
          });
          finish(
            // Residual exposure outstanding is the most severe state, whatever
            // else is true. Otherwise: a clean abort-after-fill (4/4 filled, then
            // fully reversed because the executed economics failed re-qualification)
            // is ABORTED, never "recovered" — it must be checked BEFORE the generic
            // filled_leg_count>0 case, since an abort-after-fill always has
            // filled_leg_count===4 and would otherwise be misclassified as a partial
            // recovery. A partial fill (1-3 legs) that was cleanly unwound with no
            // residual is the actual PARTIAL_RECOVERED case.
            legging.legging.residual_exposure.length > 0
              ? "PARTIAL_UNRESOLVED"
              : legging.legging.abort_after_fill
                ? "ABORTED"
                : legging.legging.filled_leg_count > 0
                  ? "PARTIAL_RECOVERED"
                  : "FAILED",
            legging.reason,
            legging.legging.final_expected_net_profit,
            legging.legging.decision_to_last_fill_ms,
            null,
          );
          this.deps.positions.release(cand.key);
          return;
        }
        /**
         * EXECUTION OWNERSHIP — do not re-check discovery state here.
         *
         * Four simulated orders have FILLED and the box qualified on those fill
         * prices. Those fills happened: releasing the reservation and returning
         * would delete a complete, hedged position from existence, with no unwind
         * and no entry in the P&L — the single worst thing a paper simulator can do,
         * because it silently flatters every result.
         *
         * A candidate is freely CANCELLABLE only BEFORE its first fill (the
         * executor's own abort predicate handles that, and does so per run). From
         * the first fill onward the execution owns the outcome, so the completed box
         * is persisted and handed to the monitor — which runs regardless of RUN/STOP,
         * market hours or feed health, and will exit it when it can.
         */
        stage = "trade_persistence";
        const opened = await this.finalizeOpen(cand, legging.evaluation, legging.decision, null, legging.legging);
        finish(
          opened ? "SUCCESS" : "PARTIAL_UNRESOLVED",
          opened ? null : "persistence_unavailable",
          legging.decision.expected_net_profit,
          legging.legging.decision_to_last_fill_ms,
          null,
        );
        return;
      }

      const result = await this.deps.executionSim.simulateEntry({
        candidate: cand,
        detection,
        stillWanted,
        // The final gate: expected NET profit on the EXECUTED snapshot, with the
        // measured entry slippage RECORDED but never deducted again.
        qualify: qualifyStaged,
      });

      if (!result.ok) {
        this.recordExecutionFailure(cand, detection, result.reason, result.detail);
        finish(
          "FAILED",
          result.reason,
          null,
          result.record.decision_to_fill_ms,
          result.record.executed_at === null ? null : 0,
        );
        this.deps.positions.release(cand.key);
        return;
      }

      /**
       * EXECUTION OWNERSHIP (same rule as the legging path above).
       *
       * This used to re-check discovery/market/feed state and abandon the entry.
       * But the simulator has already produced a FILL at observed executable prices
       * — the four legs are on. Dropping it here erased that position silently, so a
       * STOP, a feed blip or the closing bell landing in the same turn made a real
       * simulated fill vanish from the book and from the P&L.
       *
       * The simulator's own pre-fill checks are what cancel an entry safely; once
       * filled, the position is persisted and the (always-on) monitor owns it.
       */
      stage = "trade_persistence";
      const opened = await this.finalizeOpen(cand, result.evaluation, result.decision, result.record, null);
      finish(
        opened ? "SUCCESS" : "PARTIAL_UNRESOLVED",
        opened ? null : "persistence_unavailable",
        result.decision.expected_net_profit,
        result.record.decision_to_fill_ms,
        // Atomic paper fills are the captured arrival-book touch by construction.
        0,
      );
    } catch (err) {
      // A TECHNICAL FAULT IS NOT A MARKET OUTCOME. Classify it by the subsystem that was actually
      // running (`stage`), keep the fixed class as the only metric label, and put the detail an
      // operator needs into the bounded diagnostic log — never into the label.
      const faultClass = classifyExecutionFault({ stage, error: err });
      const recorded = this.deps.faults?.record({
        at: Date.now(),
        fault_class: faultClass,
        stage,
        execution_mode: this.deps.cfg.executionMode,
        paper_profile: this.deps.cfg.paperExecutionProfile,
        broker: this.deps.activeBroker?.() ?? null,
        error_type: faultErrorType(err),
        message: faultMessage(err),
        stack: err instanceof Error ? err.stack ?? null : null,
        candidate_key: cand.key,
        reservation_held: this.deps.positions.isTaken(cand.key),
        exposure_existed: this.deps.positions.getByKey(cand.key) !== undefined,
        reached_broker: this.deps.cfg.executionMode === "live"
          ? this.deps.reachedBroker?.() ?? null
          : null,
      });
      // Loud for the classes that mean money or durability is at risk; a warning otherwise.
      const severe = faultClass === "trade_persistence_error" ||
        faultClass === "broker_state_error" ||
        faultClass === "execution_invariant_error" ||
        faultClass === "reservation_authority_unavailable";
      const line = `[Box] entry ${faultClass} at stage ${stage} for ${cand.key}: ` +
        `${recorded?.message ?? faultMessage(err)}`;
      if (severe) console.error(line, err);
      else console.warn(line, err);
      // Also count it in the scanner's own stats and the trade-event ledger, so a technical fault
      // is not invisible everywhere except one metric. Previously the catch skipped both.
      this.stats.rejectedExecution++;
      this.logRejection("ENTRY_REJECTED_EXECUTION", cand, detection, `${faultClass}: ${stage}`);
      // A TECHNICAL FAULT NAMES ITS UNDERLYING TOO. The bounded fault log already holds the stack,
      // but it is keyed by nothing an operator scans by; this puts the same fault on the alert
      // surface beside the market refusals, so "which stock failed for what reason" has one answer
      // rather than two half-answers in two places.
      this.deps.onEntryRejected?.({
        underlying: cand.underlying,
        reason: faultClass,
        detail: `${faultClass} at stage ${stage}: ${recorded?.message ?? faultMessage(err)}`,
        candidateKey: cand.key,
      });
      finish("FAILED", faultClass, null, null, null);
      this.deps.positions.release(cand.key);
    } finally {
      this.entryInFlight.delete(cand.key);
    }
  }

  /**
   * THE FINAL entry qualification on an EXECUTED snapshot.
   *
   * `execution.gross_edge` already reflects any adverse entry movement, so the
   * measured entry slippage is RECORDED (analytics) but never deducted again —
   * only the future exit-slippage allowance is a forward cost here. This is the
   * fix for entry-slippage double counting (Task 1), shared by every mode.
   */
  private finalQualify(execution: BoxEvaluation, measuredSlippage: number): BoxEntryDecision {
    const legs = buildEntryChargeLegs(execution.candidate, execution.legs);
    if (!legs) {
      return {
        gross_edge: execution.gross_edge,
        entry_charges: null,
        estimated_exit_charges: null,
        execution_cost: 0,
        entry_slippage_allowance: 0,
        future_exit_slippage_allowance: 0,
        measured_entry_slippage: null,
        safety_buffer: this.deps.cfg.safetyBuffer,
        expected_net_profit: null,
        min_expected_net_profit: requiredNetProfit(this.deps.cfg),
        passes_gross_prefilter: false,
        qualifies: false,
        reject: "unpriced_charges",
      };
    }
    const totals = this.deps.localCharges.totals(
      legs.map((l) => ({
        side: l.side,
        tradingsymbol: l.tradingsymbol,
        quantity: l.quantity,
        price: l.price,
      })),
    );
    return evaluateEntryDecision({
      grossEdge: execution.gross_edge,
      entryCharges: totals.entry,
      estimatedExitCharges: totals.exit,
      entrySlippageAllowance: 0,
      futureExitSlippageAllowance: this.deps.cfg.expectedExitSlippage,
      measuredEntrySlippage: measuredSlippage,
      cfg: this.deps.cfg,
    });
  }

  /** Build the final charge legs and hand the fill to the engine to persist. */
  private async finalizeOpen(
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    decision: BoxEntryDecision,
    execution: BoxExecutionRecord | null,
    legging: PaperLeggingExecutionRecord | null,
  ): Promise<boolean> {
    const legs = buildEntryChargeLegs(evaluation.candidate, evaluation.legs);
    if (!legs) {
      // Should be unreachable: a filled evaluation always has four priced legs. But we are PAST the
      // fill here, so if it ever happens the position exists and we failed to record it — that must
      // never be silent, and it must never be released as though nothing filled.
      this.retainUnrecordedFill(cand, evaluation, legging, "its entry charge legs could not be built");
      return false;
    }
    const orders = legs.map((l) => ({
      side: l.side,
      tradingsymbol: l.tradingsymbol,
      quantity: l.quantity,
      price: l.price,
    }));
    const local = this.deps.localCharges.roundTrip(orders);

    const id = await this.deps.openPaperTrade({
      candidate: cand,
      evaluation,
      entryLegs: legs,
      entryChargesTotal: local.entry_total,
      estimatedExitChargesTotal: local.estimated_exit_total,
      chargeOrigin: "local",
      decision,
      execution,
      legging,
    });

    if (id) {
      this.stats.entriesOpened++;
      this.markStatus(cand.key, this.deps.cfg.executionMode === "live" ? "LIVE_OPENED" : "PAPER_OPENED");
    } else {
      // The legs FILLED but nothing was persisted — either the unique index says this
      // box is already open, or the write failed. Either way the exposure was taken on
      // and is now unrecorded.
      this.retainUnrecordedFill(
        cand,
        evaluation,
        legging,
        "no position was persisted (duplicate open box, or the insert failed)",
      );
    }
    return id !== null;
  }

  /**
   * A CONFIRMED FILL WE COULD NOT RECORD — retained, never released.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * THE DEFECT THIS CLOSES
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * Both post-fill failure branches in `finalizeOpen` used to end in `positions.release(cand.key)`
   * after a `console.error`. The comment was honest that "durable retry / residual-exposure adoption
   * for this path is not built yet" — but the consequence was that a COMPLETE FOUR-LEG POSITION,
   * already filled at the broker, was handed back to the candidate pool as though nothing had
   * happened: no durable attempt row, no residual exposure, nothing blocking the next entry, and a
   * log line as the only trace. In live mode that is real money with no owner.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * WHAT THIS DOES INSTEAD
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   *   1. KEEPS OWNERSHIP. `positions.release` is deliberately NOT called, so the candidate key stays
   *      taken and this underlying cannot be re-entered on top of exposure we already hold.
   *   2. RECONSTRUCTS THE EXPOSURE from the legging record's own filled legs and publishes it as
   *      `residual_exposure` on a durable attempt row, which is what the residual/flatten loop
   *      adopts and what `residualLegs` uses to block new entry.
   *   3. BLOCKS NEW ENTRY IMMEDIATELY via `invariantViolation`, which trips the breaker and sets
   *      `recoveryActive`. This is process-local and therefore holds even when the durable write is
   *      the very thing that just failed.
   *   4. NAMES THE LIMIT. The durable write is fire-and-forget (`onExecutionAttempt` returns void),
   *      so this can NOT claim the exposure was safely persisted — and says so, with the broker
   *      order ids an operator needs to verify the legs directly.
   *
   * It does NOT unwind. The position is complete and hedged, quantities are certain, and reversing
   * it is an economic decision this path has no verdict for — the residual machinery reduces it
   * under the existing exposure-aware rules (shorts first, hedges held while any short is unproven).
   */
  private retainUnrecordedFill(
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    legging: PaperLeggingExecutionRecord | null,
    why: string,
  ): void {
    const now = Date.now();
    /*
     * RECONSTRUCTED FROM WHICHEVER RECORD THIS PATH HAS.
     *
     * The legging path carries per-leg broker execution detail (`fill_qty`, average price); the
     * ATOMIC path (`simulateEntry`) reaches `finalizeOpen` with `legging === null` and only an
     * evaluation. Both can lose a fill, so both must be able to describe the exposure they hold —
     * an atomic fill that could not be recorded is no less real for having no per-leg record.
     */
    const filledLegs = (legging?.legs ?? []).filter((leg) => leg.fill_qty > 0);
    const retained: ResidualLegExposure[] = filledLegs.length > 0
      ? filledLegs.map((leg) => ({
        token: leg.token,
        tradingsymbol: leg.tradingsymbol,
        role: leg.role,
        side: leg.side,
        quantity: leg.fill_qty,
        // NEVER a fabricated 0: an unpublished average price is absent data, not a free fill.
        average_price: leg.average_fill_price ?? leg.fill_price ?? 0,
        source: "partial_entry" as const,
        created_at: now,
      }))
      : evaluation.legs
        .filter((leg) => leg.price !== null && leg.price > 0)
        .map((leg) => ({
          token: leg.token,
          tradingsymbol: leg.tradingsymbol,
          role: leg.role,
          side: leg.side,
          quantity: evaluation.candidate.lot_size,
          average_price: leg.price as number,
          source: "partial_entry" as const,
          created_at: now,
        }));
    const brokerIdentity = retained.length > 0
      ? retained.map((leg) => `${leg.role} ${leg.side} ${leg.quantity} @ ${leg.average_price}`).join("; ")
      : "no per-leg execution detail available";

    if (legging) {
      legging.outcome_class = "FILLED_EXPOSURE_UNRECORDED";
      // Reconstructed only when the record does not already carry one, so a residual the gateway
      // computed (which knows the broker snapshots) is never overwritten by a weaker projection.
      if (legging.residual_exposure.length === 0) legging.residual_exposure = retained;
    }

    const detail =
      `LOST FILL: ${cand.key} filled all four legs but ${why}. The exposure is REAL and is NOT ` +
      `unwound; it is retained for broker-authoritative reconciliation and new entry is blocked. ` +
      `Durable recording of this attempt could NOT be confirmed from here, so do not assume it was ` +
      `persisted — verify the legs at the broker: ${brokerIdentity}`;

    // Loud, and on the operator alert surface beside the market refusals rather than only in a log.
    console.error(`[Box] ${detail}`);
    this.deps.faults?.record({
      at: Date.now(),
      fault_class: "trade_persistence_error",
      stage: "trade_persistence",
      execution_mode: this.deps.cfg.executionMode,
      paper_profile: this.deps.cfg.paperExecutionProfile,
      broker: this.deps.activeBroker?.() ?? null,
      error_type: "LostFillUnrecorded",
      message: detail,
      stack: null,
      candidate_key: cand.key,
      reservation_held: this.deps.positions.isTaken(cand.key),
      // TRUE, unlike the generic catch which reports `positions.getByKey(...) !== undefined` and so
      // asserted "no exposure existed" for precisely this case.
      exposure_existed: true,
      reached_broker: this.deps.cfg.executionMode === "live"
        ? this.deps.reachedBroker?.() ?? null
        : null,
    });
    this.deps.onEntryRejected?.({
      underlying: cand.underlying,
      reason: "filled_exposure_unrecorded",
      detail,
      candidateKey: cand.key,
    });

    // The durable attempt row carries the reconstructed residual, which is what the flatten loop
    // adopts. Fire-and-forget by the dependency's own contract, hence the disclaimer above.
    if (legging) {
      this.deps.onExecutionAttempt?.(
        cand,
        legging,
        "legging_incomplete",
        detail,
        evaluation.gross_edge ?? 0,
      );
    }

    // Blocks new entry regardless of whether anything above reached storage.
    this.deps.executionSim.invariantViolation(`${cand.key}: ${detail}`);

    // NOTE: `positions.release(cand.key)` is deliberately absent. See the docblock.
  }

  private recordExecutionFailure(
    cand: BoxCandidate,
    detection: BoxEvaluation,
    reason: string,
    detail: string,
  ): void {
    if (reason === "below_expected_net_profit") {
      this.stats.rejectedNetProfit++;
      this.logRejection("ENTRY_REJECTED_NET_PROFIT", cand, detection, detail);
      return;
    }
    if (reason === "insufficient_quantity" || reason === "missing_book" || reason === "price_moved") {
      this.stats.rejectedLiquidity++;
      this.logRejection("ENTRY_REJECTED_EXECUTION", cand, detection, `${reason}: ${detail}`);
      return;
    }
    // duplicate / discovery_stopped / market_closed / feed_unhealthy /
    // edge_disappeared — expected transients, counted but not spammed to the ledger.
    this.stats.rejectedExecution++;
    this.logRejection("ENTRY_REJECTED_EXECUTION", cand, detection, `${reason}: ${detail}`);
  }

  /* -------------------------------- events -------------------------------- */

  private noteRejection(
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    detail?: string,
  ): void {
    const reason = evaluation.reject;
    if (reason === "stale_quote" || reason === "no_quote") {
      this.stats.rejectedStale++;
      this.logRejection("ENTRY_REJECTED_STALE", cand, evaluation, detail);
      return;
    }
    if (
      reason === "insufficient_qty" ||
      reason === "missing_bid" ||
      reason === "missing_ask"
    ) {
      this.stats.rejectedLiquidity++;
      this.logRejection("ENTRY_REJECTED_LIQUIDITY", cand, evaluation, detail);
    }
  }

  private noteNetProfitRejection(
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    decision: BoxEntryDecision,
  ): void {
    this.stats.rejectedNetProfit++;
    this.logRejection(
      "ENTRY_REJECTED_NET_PROFIT",
      cand,
      evaluation,
      `expected net ₹${decision.expected_net_profit ?? "?"} < required ₹${decision.min_expected_net_profit}`,
    );
  }

  private logRejection(
    event:
      | "ENTRY_REJECTED_STALE"
      | "ENTRY_REJECTED_LIQUIDITY"
      | "ENTRY_REJECTED_FEES"
      | "ENTRY_REJECTED_DUPLICATE"
      | "ENTRY_REJECTED_NET_PROFIT"
      | "ENTRY_REJECTED_EXECUTION",
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    detail?: string,
  ): void {
    if (!passesGrossPrefilter(evaluation.gross_edge, prefilterGrossThreshold(this.deps.cfg))) {
      return;
    }
    const logKey = `${event}|${cand.key}`;
    const last = this.lastRejectLogAt.get(logKey) ?? 0;
    const now = Date.now();
    if (now - last < REJECT_LOG_COOLDOWN_MS) return;
    this.lastRejectLogAt.set(logKey, now);
    this.deps.onEvent(event, cand, evaluation, detail);
  }

  /* ----------------------------- publication ----------------------------- */

  private markStatus(key: string, status: BoxOpportunity["status"]): void {
    const opp = this.opportunities.get(key);
    if (opp) this.opportunities.set(key, { ...opp, status, updated_at: Date.now() });
  }

  private publish(
    evaluation: BoxEvaluation,
    ctx: {
      openKeyTaken: boolean;
      passedPrefilter: boolean;
      decision: BoxEntryDecision | null;
      priceSource?: "touch" | "last_close";
    },
  ): void {
    const cand = evaluation.candidate;
    const previous = this.opportunities.get(cand.key);
    const cfg = this.deps.cfg;
    const direction = cand.direction ?? "LONG_BOX";

    const indicative = ctx.priceSource === "last_close";
    const decision = ctx.decision;
    const expectedNet = decision ? decision.expected_net_profit : null;

    let status: BoxOpportunity["status"];
    if (ctx.openKeyTaken) status = "OPEN";
    else if ((previous?.status === "PAPER_OPENED" || previous?.status === "LIVE_OPENED") && !ctx.openKeyTaken) status = previous.status;
    else if (indicative) status = "INDICATIVE";
    else if (!evaluation.tradable) status = ctx.passedPrefilter ? "REJECTED" : "WATCHING";
    else if (decision && decision.qualifies) status = "ELIGIBLE";
    else status = "WATCHING";

    this.opportunities.set(cand.key, {
      key: cand.key,
      underlying: cand.underlying,
      name: cand.name,
      is_index: cand.is_index,
      expiry: cand.expiry,
      direction,
      lower_strike: cand.lower_strike,
      upper_strike: cand.upper_strike,
      box_width: cand.box_width,
      lot_size: cand.lot_size,
      quantity: cand.lot_size,
      entry_box_cost:
        evaluation.entry_net_debit_per_unit === null
          ? null
          : round2(evaluation.entry_net_debit_per_unit * cand.lot_size),
      gross_edge: evaluation.gross_edge,
      entry_charges: decision ? decision.entry_charges : null,
      estimated_exit_charges: decision ? decision.estimated_exit_charges : null,
      execution_cost: decision ? decision.execution_cost : cfg.expectedEntrySlippage + cfg.expectedExitSlippage,
      safety_buffer: cfg.safetyBuffer,
      projected_net_edge: expectedNet,
      expected_net_profit: expectedNet,
      min_expected_net_profit: requiredNetProfit(cfg),
      charge_origin: "local",
      entry_sides: evaluation.legs.map((l) => ({
        role: l.role,
        side: l.side,
        tradingsymbol: l.tradingsymbol,
      })),
      liquidity_ok: evaluation.tradable,
      depth_ok: evaluation.depth_ok,
      worst_age_ms: evaluation.worst_age_ms,
      price_source: ctx.priceSource ?? "touch",
      status,
      reject: evaluation.reject,
      // Depth/version are internal fill-audit data. The opportunity stream keeps
      // its compact per-leg API shape.
      legs: evaluation.legs.map(({ depth: _depth, quote_version: _version, ...leg }) => leg),
      updated_at: evaluation.at,
    });
  }

  /**
   * Publish an INDICATIVE view of every candidate from last traded / closing
   * prices, for when the market is shut.
   */
  publishIndicative(lastPrices: Map<number, number>): number {
    const now = Date.now();
    const openKeys = this.deps.positions.openKeys();
    let priced = 0;
    for (const cand of this.candidates.values()) {
      const evaluation = evaluateCandidateIndicative({ candidate: cand, lastPrices, now });
      if (evaluation.gross_edge !== null) priced++;
      this.publish(evaluation, {
        openKeyTaken: openKeys.has(cand.key),
        passedPrefilter: passesGrossPrefilter(
          evaluation.gross_edge,
          prefilterGrossThreshold(this.deps.cfg),
        ),
        decision: null,
        priceSource: "last_close",
      });
    }
    this.stats.lastEvaluationAt = now;
    return priced;
  }

  /**
   * Opportunities worth showing: anything tradable-and-interesting, anything that
   * cleared the gross prefilter, and anything already open.
   */
  listOpportunities(limit: number): BoxOpportunity[] {
    const threshold = prefilterGrossThreshold(this.deps.cfg);
    const rows: BoxOpportunity[] = [];
    for (const opp of this.opportunities.values()) {
      const interesting =
        opp.status === "OPEN" ||
        opp.status === "PAPER_OPENED" ||
        opp.status === "LIVE_OPENED" ||
        opp.status === "ELIGIBLE" ||
        opp.status === "UNPRICED" ||
        opp.status === "INDICATIVE" ||
        (opp.gross_edge !== null && opp.gross_edge >= Math.min(threshold, 0)) ||
        (opp.expected_net_profit !== null && opp.expected_net_profit >= 0);
      if (!interesting) continue;
      if (
        opp.status !== "OPEN" &&
        opp.status !== "PAPER_OPENED" &&
        opp.status !== "LIVE_OPENED" &&
        (opp.gross_edge === null || opp.gross_edge <= 0)
      ) {
        continue;
      }
      rows.push(opp);
    }
    rows.sort((a, b) => {
      const an = a.expected_net_profit ?? a.gross_edge ?? Number.NEGATIVE_INFINITY;
      const bn = b.expected_net_profit ?? b.gross_edge ?? Number.NEGATIVE_INFINITY;
      return bn - an;
    });
    return rows.slice(0, limit);
  }

  opportunitiesFor(underlying: string): BoxOpportunity[] {
    return [...this.opportunities.values()].filter((o) => o.underlying === underlying);
  }

  clearOpportunities(): void {
    this.opportunities.clear();
  }
}
