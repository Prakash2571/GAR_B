/**
 * The open-position monitor.
 *
 * BACKEND-OWNED and completely independent of the scanner's RUN state and of any
 * browser:
 *
 *   - it keeps running when the scanner is STOPPED
 *   - it keeps running when nobody is looking at /box
 *   - it keeps running when the browser is closed
 *
 * A position's lifecycle can never depend on React being mounted, so every exit
 * decision — and every refusal to exit — happens here.
 *
 * TWO THINGS CHANGED FROM THE ORIGINAL
 *
 *   1. Exit charges are now priced by the LOCAL calculator, synchronously, on the
 *      decision-critical path. There is no Zerodha round trip between measuring a
 *      position and deciding to close it; verification happens asynchronously
 *      elsewhere (chargeReconciler.ts).
 *   2. The fill itself goes through the central execution gateway. Paper modes
 *      retain their simulator semantics; live mode uses durable bounded LIMIT
 *      orders and applies only broker-confirmed cumulative fills.
 */

import type { BoxConfig } from "./config.js";
import { exitSlippageAllowanceForLot } from "./config.js";
import { NSE_SESSION_CLOSE_MINUTES } from "../marketCalendar.js";
import type { BoxExecutionGateway } from "./executionGateway.js";
import type { BoxMetrics } from "./metrics.js";
import { ordersFromLegs } from "./localCharges.js";
import {
  isPartialBox,
  markPartialExit,
  openQuantityFraction,
  realisedExitGross,
  remainingByRoleOf,
  remainingExitChargeOrders,
} from "./partialExitPnl.js";
import type { BoxChargeCalculatorLike } from "./brokerContext.js";
import {
  computeExitMetrics,
  entrySideFor,
  evaluateExitLegs,
  exitLiquidityOk,
  round2,
} from "./math.js";
import {
  deriveBoxPositionState,
  isBoxPositionFlat,
  outstandingRoles,
  type BoxOpenPosition,
  type BoxPositionBook,
} from "./positions.js";
import type { BoxQuoteStore } from "./quotes.js";
import {
  BOX_LEG_ROLES,
  type BoxChargesWithOrigin,
  type BoxExecutionRecord,
  type BoxExitMetrics,
  type BoxExitReason,
  type BoxExecutionFailureReason,
  type BoxLegEvaluation,
  type BoxLegRole,
  type IBoxExitAttempt,
  type PaperLeggingExecutionRecord,
  type ResidualLegExposure,
} from "./types.js";

export interface BoxMonitorDeps {
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  /** The ACTIVE broker's charge calculator (see brokerContext.ts). */
  localCharges: BoxChargeCalculatorLike;
  executionSim: BoxExecutionGateway;
  positions: BoxPositionBook;
  /** Bounded metrics sink (optional; absent in some tests). */
  metrics?: BoxMetrics;
  /** Persists the close. Returns true when this call is the one that closed it. */
  closePaperTrade: (args: {
    position: BoxOpenPosition;
    metrics: BoxExitMetrics;
    exitCharges: BoxChargesWithOrigin | null;
    reason: BoxExitReason;
    execution: BoxExecutionRecord | null;
    /** The independent-order exit audit, when the exit used paper_legging. */
    legging?: PaperLeggingExecutionRecord | null;
    residual?: ResidualLegExposure[] | null;
    /** CUMULATIVE realised gross across all exit attempts (paper_legging). */
    grossPnlOverride?: number | null;
    /** CUMULATIVE exit charges across all attempts (paper_legging). */
    exitChargesTotalOverride?: number | null;
    /** The full append-only exit-attempt audit to persist on close. */
    exitAttempts?: IBoxExitAttempt[] | null;
  }) => Promise<boolean>;
  /**
   * Durably record a PARTIAL exit (some quantity closed, some remains) in one
   * atomic update, BEFORE the monitor treats the execution as clean. Returns true
   * when the update matched an open trade.
   */
  persistPartialExit: (args: {
    position: BoxOpenPosition;
    residual: ResidualLegExposure[];
    legging: PaperLeggingExecutionRecord;
  }) => Promise<boolean>;
  /** Slow periodic flush of the live convergence figure. */
  persistLive: (position: BoxOpenPosition) => Promise<void>;
  /** Ledger hook. */
  onEvent: (
    event: "EXIT_TRIGGERED" | "EXIT_SKIPPED_LIQUIDITY" | "EXPIRY_SAFETY" | "ERROR",
    position: BoxOpenPosition,
    metrics: BoxExitMetrics | null,
    detail?: string,
  ) => void;
  /** IST trading-day key, injected so the monitor has no clock of its own. */
  istDayKey: () => string;
  /** Minutes past midnight IST, for the expiry-safety window. */
  istMinutesOfDay: () => number;
  isMarketOpen: () => boolean;
  isFeedHealthy: () => boolean;
  /**
   * WHY a reduction cannot be worked right now while the WS feed is unhealthy, or null when it can.
   *
   * Optional so every existing construction site is unchanged: absent means "no degraded assessment is
   * wired", and the caller falls back to the plain `isFeedHealthy()` gate exactly as before.
   *
   * It exists because returning early on `!isFeedHealthy()` was SILENT. The monitor bailed out above
   * its liquidity gate, so an outage emitted no `EXIT_SKIPPED_LIQUIDITY` event and set no
   * `exit_blocked_reason` — the position simply went quiet, and the one alarm that still fired
   * (`EXPIRY_SAFETY`) demanded an exit that was blocked four lines later with no explanation.
   *
   * See `degradedRecovery.ts` for the policy this reports.
   */
  degradedReductionBlockReason?: (pos: BoxOpenPosition) => string | null;
}

/**
 * Market close in IST minutes-of-day (15:30).
 *
 * Re-exported from the calendar rather than redeclared, so there is exactly ONE definition of when
 * the exchange shuts. These two numbers previously disagreed: this file and `latencyModel` used the
 * correct 15:30 while `boxSupport.isMarketOpen` used 15:40, which is how the engine came to believe
 * it could trade for ten minutes after the bell.
 */
const IST_CLOSE_MINUTES = NSE_SESSION_CLOSE_MINUTES;

export class BoxPositionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private evaluationTasks = new Map<string, Promise<void>>();
  private pendingEvaluationIds = new Set<string>();
  private closingIds = new Set<string>();
  private pendingPartialPersists = new Map<string, {
    projected: BoxOpenPosition;
    residual: ResidualLegExposure[];
    legging: PaperLeggingExecutionRecord;
  }>();
  /** Confirmed final fills awaiting the one atomic close projection. No order is replayed. */
  private pendingFinalPersists = new Map<string, Parameters<BoxMonitorDeps["closePaperTrade"]>[0]>();
  private lastBlockedKey = new Map<string, string>();
  private stats = {
    cycles: 0,
    exitsTriggered: 0,
    exitsSkippedLiquidity: 0,
    exitsFailedExecution: 0,
    lastCycleAt: null as number | null,
  };

  constructor(private deps: BoxMonitorDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.cycle();
    }, this.deps.cfg.monitorIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Forget every trace of a position the monitor may still be holding.
   *
   * Called when a trade is DELETED rather than closed. Removing it from the
   * position book is not enough on its own: this class keeps five id-keyed
   * structures, and two of them (`pendingFinalPersists`, `pendingPartialPersists`)
   * are RETRY QUEUES that are drained on every cycle and deliberately do NOT
   * consult the book — that is the whole point of them, since a confirmed fill must
   * be persisted even if the position has already left memory.
   *
   * So a deleted trade left in those maps would be re-persisted on the next cycle,
   * silently resurrecting the document a moment after the administrator deleted it.
   * `closingIds` would likewise make a later close attempt look already-in-flight.
   *
   * Returns true when anything was actually being held, so the caller can log the
   * fact that a deletion interrupted in-flight work.
   */
  forgetPosition(id: string): boolean {
    const held =
      this.closingIds.has(id) ||
      this.pendingFinalPersists.has(id) ||
      this.pendingPartialPersists.has(id) ||
      this.pendingEvaluationIds.has(id) ||
      this.evaluationTasks.has(id);
    this.closingIds.delete(id);
    this.pendingFinalPersists.delete(id);
    this.pendingPartialPersists.delete(id);
    this.pendingEvaluationIds.delete(id);
    // The in-flight evaluation promise is intentionally NOT cancelled — it cannot
    // be. It is safe to drop the handle: requestEvaluation re-reads the book on
    // every iteration and breaks when the position is gone (see its loop), so the
    // task observes the deletion and exits on its own.
    this.evaluationTasks.delete(id);
    this.lastBlockedKey.delete(id);
    return held;
  }

  getStats() {
    return { ...this.stats, running: this.timer !== null };
  }

  /**
   * Primary low-latency path: a WS depth update immediately re-evaluates only
   * open positions that contain one of the changed contracts.
   */
  onTokensUpdated(tokens: number[]): void {
    if (tokens.length === 0) return;
    const changed = new Set(tokens);
    for (const pos of this.deps.positions.list()) {
      const affected = BOX_LEG_ROLES.some((role) => changed.has(pos.legs[role].token));
      if (affected) void this.requestEvaluation(pos.id);
    }
  }

  private requestEvaluation(id: string): Promise<void> {
    this.pendingEvaluationIds.add(id);
    const existing = this.evaluationTasks.get(id);
    if (existing) return existing;

    const task = (async () => {
      try {
        while (this.pendingEvaluationIds.delete(id)) {
          const pos = this.deps.positions.get(id);
          if (!pos) break;
          try {
            await this.evaluatePosition(pos);
          } catch (err) {
            console.warn("[Box] monitor failed for", pos.id, err);
            this.deps.onEvent("ERROR", pos, pos.metrics, String(err));
          }
        }
      } finally {
        this.evaluationTasks.delete(id);
        if (this.pendingEvaluationIds.has(id) && this.deps.positions.get(id)) {
          void this.requestEvaluation(id);
        }
      }
    })();
    this.evaluationTasks.set(id, task);
    return task;
  }

  async cycle(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.retryPendingFinalPersists();
      await this.retryPendingPartialPersists();
      this.stats.cycles++;
      this.stats.lastCycleAt = Date.now();
      await Promise.all(this.deps.positions.list().map((pos) => this.requestEvaluation(pos.id)));
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Total exit charges for a set of evaluated exit legs, from the LOCAL
   * calculator. Synchronous — this is the whole point.
   */
  private localExitChargesTotal(pos: BoxOpenPosition, legs: BoxLegEvaluation[]): number | null {
    const orders = ordersFromLegs(legs, pos.quantity);
    if (!orders) return pos.estimated_exit_charges_total;
    return this.deps.localCharges.legs(orders, "kite_estimate").total;
  }

  private localExitCharges(pos: BoxOpenPosition, legs: BoxLegEvaluation[]): BoxChargesWithOrigin | null {
    const orders = ordersFromLegs(legs, pos.quantity);
    if (!orders) return null;
    return this.deps.localCharges.legs(orders, "kite_estimate");
  }

  /**
   * Estimated exit charges for the quantity that is STILL OPEN.
   *
   * A partially exited box has already paid to close what it closed
   * (`cumulative_exit_charges`, exact). Re-estimating a full four-leg exit on top of that
   * double-counts the closed legs, which is half of the partial-exit accounting defect.
   */
  private remainingExitChargesEstimate(pos: BoxOpenPosition, legs: BoxLegEvaluation[]): number | null {
    const orders = remainingExitChargeOrders(pos, legs);
    if (orders === null) {
      // A remaining leg cannot be priced. Returning null would drop this position out of the day
      // total entirely (`?? 0` at the aggregation sites), which is a worse lie than an estimate,
      // so fall back to the stored full-lot projection scaled by the fraction still open. It is an
      // estimate of last resort — exactly what `estimated_exit_charges_total` already is.
      const stored = pos.estimated_exit_charges_total;
      if (stored === null) return null;
      return round2(stored * openQuantityFraction(pos));
    }
    if (orders.length === 0) return 0;    // nothing left to close, so nothing left to pay
    return round2(this.deps.localCharges.legs(orders, "kite_estimate").total);
  }

  /** Recompute the exit arithmetic for one position (no side effects, no I/O). */
  measure(
    pos: BoxOpenPosition,
    now = Date.now(),
    exitChargesTotalOverride?: number | null,
    captureDepth = false,
  ): BoxExitMetrics {
    const direction = pos.direction ?? "LONG_BOX";
    const legs = evaluateExitLegs({
      legs: BOX_LEG_ROLES.map((role) => ({ role, inst: pos.legs[role] })),
      quotes: this.deps.quotes.view(),
      lotSize: pos.lot_size,
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      direction,
      captureDepth,
    });

    const partial = isPartialBox(pos);
    const exitChargesTotal =
      exitChargesTotalOverride !== undefined
        ? exitChargesTotalOverride
        : partial
          // Already paid (exact) + estimated cost of closing only what is left.
          ? this.addNullable(pos.cumulative_exit_charges, this.remainingExitChargesEstimate(pos, legs))
          : this.localExitChargesTotal(pos, legs);

    const metrics = computeExitMetrics({
      boxWidth: pos.box_width,
      lotSize: pos.lot_size,
      entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
      entryNetEdge: pos.entry_net_edge,
      entryChargesTotal: pos.entry_charges_total,
      currentExitChargesTotal: exitChargesTotal,
      legs,
      now,
      direction,
      entryEdge: pos.entry_gross_edge,
      // PRE-EXECUTION: judge the profit floor on realisable net (touch net minus
      // the expected exit-slippage allowance) so a marginal touch does not trigger
      // an exit that would not realistically net enough. Lot-resolved, because the
      // unwind cost is ticks x QUANTITY — a flat figure understates it by ~99% on a
      // large-lot single stock, which is the direction that invents profit.
      executionCost: exitSlippageAllowanceForLot(this.deps.cfg, pos.lot_size),
      useRealisableForFloor: this.deps.cfg.exitUseRealisableNet,
      openedAt: pos.opened_at,
      expirySafety: this.isInExpirySafetyWindow(pos),
      cfg: this.deps.cfg,
    });

    // A WHOLE box keeps the pre-existing arithmetic byte-for-byte, including its rounding.
    if (!partial) return metrics;

    // PARTIALLY EXITED: re-mark only what is still open, and freeze what is already realised.
    // `computeExitMetrics` above is quantity-blind by construction — its gross is
    // `(exitCredit − entryDebit) × lotSize`, a whole-box identity that cannot express per-role
    // quantities — so the P&L figures are replaced here rather than by trying to bend it.
    const remainingByRole = remainingByRoleOf(pos);
    const mark = markPartialExit({
      direction,
      remainingByRole,
      entryPrices: pos.entry_prices,
      legs,
      realisedGross: realisedExitGross(pos),
      // When a caller supplies the override (the FINAL close, which passes the exact cumulative
      // figure) it is the whole exit-charge story and must not be added to again.
      exitChargesIncurred: exitChargesTotalOverride !== undefined
        ? 0
        : pos.cumulative_exit_charges,
      entryChargesTotal: pos.entry_charges_total,
      estimatedRemainingExitCharges: exitChargesTotalOverride !== undefined
        ? exitChargesTotalOverride
        : this.remainingExitChargesEstimate(pos, legs),
      executionCost: exitSlippageAllowanceForLot(this.deps.cfg, pos.lot_size),
    });

    return {
      ...metrics,
      gross_pnl_if_closed_now: mark.gross,
      estimated_exit_charges: mark.exit_charges_total,
      total_round_trip_charges: mark.round_trip_charges,
      current_net_pnl: mark.net,
      realisable_net_pnl: mark.realisable_net,
      // The breakdown, so the number is auditable rather than merely different.
      partial_exit_mark: mark,
    };
  }

  /** Sum two possibly-unknown charge figures without turning an unknown into a zero. */
  private addNullable(a: number | null, b: number | null): number | null {
    if (a === null || b === null) return null;
    return round2(a + b);
  }

  private async retryPendingFinalPersists(): Promise<void> {
    for (const [id, pending] of [...this.pendingFinalPersists]) {
      const current = this.deps.positions.get(id);
      if (!current) {
        this.pendingFinalPersists.delete(id);
        continue;
      }
      const closed = await this.deps.closePaperTrade(pending).catch(() => false);
      if (!closed) continue;
      this.pendingFinalPersists.delete(id);
    }
  }

  private async retryPendingPartialPersists(): Promise<void> {
    for (const [id, pending] of [...this.pendingPartialPersists]) {
      const current = this.deps.positions.get(id);
      if (!current) {
        this.pendingPartialPersists.delete(id);
        continue;
      }
      const persisted = await this.deps.persistPartialExit({
        position: pending.projected,
        residual: pending.residual,
        legging: pending.legging,
      }).catch(() => false);
      if (!persisted) continue;
      current.remaining_qty_by_role = { ...pending.projected.remaining_qty_by_role };
      current.position_state = pending.projected.position_state;
      current.cumulative_exit_charges = pending.projected.cumulative_exit_charges;
      current.exit_attempts = [...pending.projected.exit_attempts];
      current.metrics = pending.projected.metrics;
      current.exit_blocked_reason = pending.projected.exit_blocked_reason;
      this.pendingPartialPersists.delete(id);
    }
  }

  private async evaluatePosition(pos: BoxOpenPosition): Promise<void> {
    const now = Date.now();
    let metrics = this.measure(pos, now);
    pos.metrics = metrics;
    pos.current_captured_edge = metrics.captured_edge;
    pos.current_captured_pct = metrics.captured_pct;

    if (now - pos.last_persist_at >= this.deps.cfg.persistIntervalMs) {
      pos.last_persist_at = now;
      void this.deps.persistLive(pos);
    }

    if (pos.closing || this.closingIds.has(pos.id)) return;
    if (this.pendingFinalPersists.has(pos.id) || this.pendingPartialPersists.has(pos.id)) return;

    /*
     * EXPIRY-SAFETY DETECTION IS UNCONDITIONAL, AND DELIBERATELY ABOVE THE MARKET/FEED RETURNS.
     *
     * It used to sit BELOW `if (!this.deps.isFeedHealthy()) return;`, which meant a feed outage at
     * 14:45 on expiry day skipped the deadline entirely: `pos.expiry_safety` was never set and the
     * EXPIRY_SAFETY event was never emitted. The one moment an operator most needs to be woken up —
     * settlement approaching on a position the engine cannot see prices for — was the exact moment
     * the alarm was suppressed.
     *
     * The window is pure clock-and-calendar arithmetic, so it can always be evaluated. Only the
     * EXECUTION of the exit needs a live book, and that is still gated below.
     */
    const expirySafetyState = this.expirySafetyState(pos);
    const expirySafety = expirySafetyState !== "none";
    if (expirySafety && !pos.expiry_safety) {
      pos.expiry_safety = true;
      this.deps.onEvent(
        "EXPIRY_SAFETY",
        pos,
        metrics,
        expirySafetyState === "expired"
          ? `contract expired on ${pos.expiry} and this position is STILL OPEN — it has gone to ` +
            `settlement. Exercise STT of 0.15% of intrinsic value is payable on every in-the-money ` +
            `LONG leg, and a box always has in-the-money legs. Reconcile against the broker.`
          : "entered the expiry-safety window — attempting an executable close",
      );
    }

    // Outside market hours / dead feed: refresh metrics, attempt nothing. Neither
    // is a liquidity event. Detection above has already run and alerted.
    if (!this.deps.isMarketOpen()) return;
    if (!this.deps.isFeedHealthy()) {
      /*
       * THE OUTAGE IS NOW VISIBLE — BUT IT IS NOT LABELLED A LIQUIDITY PROBLEM.
       *
       * This used to be a bare `return`, which was the defect: the monitor bailed out ABOVE its
       * liquidity gate, so nothing was recorded at all. An operator watching a position through a feed
       * outage saw nothing — and on expiry day the EXPIRY_SAFETY alarm above fired demanding an exit
       * that was blocked here with no explanation.
       *
       * The event is deliberately ERROR and NOT `EXIT_SKIPPED_LIQUIDITY`. A dead feed is not a thin
       * book, and saying "skipped for liquidity" would send the operator looking at depth that is
       * simply unobserved. ERROR is the same channel the RECOVERY block below uses for exactly this
       * reason: blocked, but not by the market.
       *
       * Nothing is attempted, exactly as before. Deduplicated by `lastBlockedKey` so a dead socket
       * cannot flood the ledger.
       */
      const detail = this.deps.degradedReductionBlockReason?.(pos)
        ?? "the market-data feed is not healthy enough to price a reduction, so nothing was attempted. " +
           "The position is unchanged, still owned and still monitored. If this does not clear, reduce " +
           "it at the broker terminal.";
      pos.exit_blocked_reason = detail;
      const gapKey = `feed_unhealthy:${detail.slice(0, 80)}`;
      if (this.lastBlockedKey.get(pos.id) !== gapKey) {
        this.lastBlockedKey.set(pos.id, gapKey);
        this.deps.onEvent("ERROR", pos, metrics, detail);
      }
      return;
    }

    // RECOVERY means broker attribution/quantity is not yet trusted. Never feed it
    // into ordinary box convergence or automatic flattening; OrderManager
    // reconciliation owns broker-authoritative recovery.
    if (pos.position_state === "RECOVERY") {
      const detail = "position is in RECOVERY and requires broker order/position reconciliation";
      pos.exit_blocked_reason = detail;
      const gapKey = "recovery:reconciliation_required";
      if (this.lastBlockedKey.get(pos.id) !== gapKey) {
        this.lastBlockedKey.set(pos.id, gapKey);
        this.deps.onEvent("ERROR", pos, metrics, detail);
      }
      return;
    }

    // A PARTIALLY_EXITED position is no longer a whole box: prioritise FLATTENING
    // the remaining exposure rather than waiting for a convergence signal that no
    // longer describes it. Throttled so a burst of ticks cannot hammer the executor
    // while an attempt is (or just was) in flight.
    if (pos.position_state === "PARTIALLY_EXITED") {
      const throttle = Math.max(250, this.deps.cfg.legTimeoutMs);
      if (now - (pos.last_exit_attempt_at ?? 0) < throttle) return;
      this.deps.metrics?.recordPartialExitRetry();
      const cleanupReason: BoxExitReason = pos.exit_attempts[0]?.reason ?? "EDGE_CONVERGED";
      await this.runExit(pos, metrics, expirySafety ? "EXPIRY_SAFETY" : cleanupReason, expirySafety);
      return;
    }

    const decision = metrics.decision;
    // Nothing to do: no rule fired and we are not in the expiry window.
    if (decision.rule_reason === null && !expirySafety) {
      if (pos.exit_blocked_reason) pos.exit_blocked_reason = null;
      this.lastBlockedKey.delete(pos.id);
      return;
    }

    const reason: BoxExitReason | null =
      decision.rule_reason ?? (expirySafety ? "EXPIRY_SAFETY" : null);
    if (!reason) return;

    // The rules want to close. Is there enough EXECUTABLE liquidity to work it?
    // paper_legging walks depth within a limit, so its pre-gate is depth-aware
    // (do not reject merely because the whole lot is not at the single best
    // touch); the atomic modes fill at the touch, so they keep the touch gate.
    if (!this.exitExecutionOk(pos, metrics)) {
      this.recordLiquiditySkip(pos, metrics);
      return;
    }

    // ATTEMPT-CADENCE THROTTLE FOR A STILL-WHOLE BOX.
    //
    // The PARTIALLY_EXITED branch above is throttled, but a box whose admitted legs all came back
    // with ZERO fill never becomes PARTIALLY_EXITED: it stays here, `OPEN`. That was harmless while
    // the liquidity gate demanded EVERY leg be executable, because a book bad enough to close nothing
    // usually failed the gate too. Now that live exits proceed when only SOME legs are executable, a
    // single healthy book would re-fire the whole attempt on every monitor cycle — a fresh
    // `stableAttemptId`, hence a fresh durable intent and a fresh POST per admitted leg, indefinitely.
    //
    // The same throttle is therefore applied here. It bounds retry CADENCE only: nothing about which
    // legs are eligible changes.
    //
    // The EXPIRY-SAFETY WINDOW is exempt, and the exemption keys on the WINDOW rather than on the
    // reason name. Inside the window a box that has also converged is named EDGE_CONVERGED, so
    // testing the reason would have thrown away the exemption in exactly the case where the position
    // both can and must be closed. A position that has to be flat before expiry cannot be made to wait.
    if (!expirySafety && this.deps.cfg.executionMode === "live") {
      const throttle = Math.max(250, this.deps.cfg.legTimeoutMs);
      if (now - (pos.last_exit_attempt_at ?? 0) < throttle) return;
    }

    // For a convergence/profit exit the net P&L must still be genuinely positive.
    // Expiry safety overrides profitability but still refuses invented prices.
    if (reason !== "EXPIRY_SAFETY") {
      if (metrics.current_net_pnl === null || metrics.current_net_pnl <= 0) return;
      if (decision.rule_reason === null) return;
    }

    await this.runExit(pos, metrics, reason, expirySafety);
  }

  /**
   * Simulate the exit fill, then persist it.
   *
   * paper_latency: the simulator waits the decision + latency delay and fills from
   * the first post-arrival WS book, re-validating that the exit still makes sense
   * on those prices. paper_touch: it fills at the current touch immediately.
   */
  private async runExit(
    pos: BoxOpenPosition,
    detectionMetrics: BoxExitMetrics,
    reason: BoxExitReason,
    expirySafety: boolean,
  ): Promise<void> {
    if (this.closingIds.has(pos.id)) return;
    this.closingIds.add(pos.id);
    pos.closing = true;
    let handed = false;

    // Independent-role execution is shared by paper_legging and live.
    if (this.deps.cfg.executionMode === "paper_legging" || this.deps.cfg.executionMode === "live") {
      try {
        await this.runLeggingExit(pos, detectionMetrics, reason);
      } finally {
        this.closingIds.delete(pos.id);
        // runLeggingExit hands the close itself when it fully fills; otherwise the
        // position stays open and must be un-marked so a later cycle can retry.
        if (this.deps.positions.get(pos.id)) pos.closing = false;
      }
      return;
    }

    try {
      const result = await this.deps.executionSim.simulateExit({
        position: pos,
        detectionLegs: detectionMetrics.legs,
        detectedAt: detectionMetrics.at,
        stillWanted: () =>
          this.deps.positions.get(pos.id) !== undefined &&
          this.deps.isMarketOpen() &&
          this.deps.isFeedHealthy(),
        validate: (legs) => {
          // Re-derive the decision on the EXECUTED prices with local charges.
          // POST-EXECUTION: the actual exit price is now known, so no expected
          // exit-slippage allowance is subtracted (Task 6/7) — the floor is the
          // real net.
          const exitTotal = this.localExitChargesTotal(pos, legs);
          const m = computeExitMetrics({
            boxWidth: pos.box_width,
            lotSize: pos.lot_size,
            entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
            entryNetEdge: pos.entry_net_edge,
            entryChargesTotal: pos.entry_charges_total,
            currentExitChargesTotal: exitTotal,
            legs,
            now: Date.now(),
            direction: pos.direction ?? "LONG_BOX",
            entryEdge: pos.entry_gross_edge,
            executionCost: 0,
            useRealisableForFloor: false,
            openedAt: pos.opened_at,
            expirySafety,
            cfg: this.deps.cfg,
          });
          if (!exitLiquidityOk(legs)) {
            return { ok: false as const, reason: "insufficient_quantity" as const, detail: "exit touch cannot fill one lot" };
          }
          if (!expirySafety) {
            const stillWants = m.decision.rule_reason !== null;
            const profitable = m.current_net_pnl !== null && m.current_net_pnl > 0;
            if (!stillWants || !profitable) {
              return { ok: false as const, reason: "edge_disappeared" as const, detail: "the exit no longer nets a profit at the executed touch" };
            }
          }
          return { ok: true as const };
        },
      });

      if (!result.ok) {
        // The fill could not happen at post-latency prices. In paper_touch this is
        // effectively immediate; in paper_latency the book moved away. Either way
        // the position stays open and the reason is recorded (deduped).
        this.stats.exitsFailedExecution++;
        const fresh = this.measure(pos, Date.now());
        pos.metrics = fresh;
        if (!exitLiquidityOk(fresh.legs)) this.recordLiquiditySkip(pos, fresh);
        pos.closing = false;
        return;
      }

      // The executed legs are the fill. Price them locally and build the final
      // metrics the trade is closed on.
      const exitCharges = this.localExitCharges(pos, result.legs);
      const exitTotal = exitCharges ? exitCharges.total : this.localExitChargesTotal(pos, result.legs);
      const finalMetrics = computeExitMetrics({
        boxWidth: pos.box_width,
        lotSize: pos.lot_size,
        entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
        entryNetEdge: pos.entry_net_edge,
        entryChargesTotal: pos.entry_charges_total,
        currentExitChargesTotal: exitTotal,
        legs: result.legs,
        now: Date.now(),
        direction: pos.direction ?? "LONG_BOX",
        entryEdge: pos.entry_gross_edge,
        // The exit has executed at a known price: no forward allowance is
        // subtracted, so realisable == realised net here.
        executionCost: 0,
        useRealisableForFloor: false,
        openedAt: pos.opened_at,
        expirySafety,
        cfg: this.deps.cfg,
      });
      pos.metrics = finalMetrics;

      pos.exit_blocked_reason = null;
      this.lastBlockedKey.delete(pos.id);
      this.stats.exitsTriggered++;
      this.deps.onEvent("EXIT_TRIGGERED", pos, finalMetrics, reason);

      handed = true;
      const closed = await this.deps.closePaperTrade({
        position: pos,
        metrics: finalMetrics,
        exitCharges,
        reason,
        execution: result.record,
      });
      if (!closed) pos.closing = false;
    } catch (err) {
      console.warn("[Box] exit failed for", pos.id, err);
      this.deps.onEvent("ERROR", pos, pos.metrics, `exit failed: ${String(err)}`);
      pos.closing = false;
    } finally {
      this.closingIds.delete(pos.id);
      if (!handed) pos.closing = false;
    }
  }

  /**
   * Close a box with four INDEPENDENT exit orders (paper_legging), sizing each
   * closing order from the EXACT outstanding quantity per role. Delegates the
   * fill-application, per-role decrement and persistence to the shared helper so
   * automatic and manual legging exits use identical mechanics.
   */
  private async runLeggingExit(
    pos: BoxOpenPosition,
    detectionMetrics: BoxExitMetrics,
    reason: BoxExitReason,
  ): Promise<void> {
    pos.last_exit_attempt_at = Date.now();
    const result = await this.deps.executionSim.simulateLeggingExit({
      position: pos,
      detectionLegs: detectionMetrics.legs,
      detectedAt: detectionMetrics.at,
      stillWanted: () =>
        this.deps.positions.get(pos.id) !== undefined &&
        this.deps.isMarketOpen() &&
        this.deps.isFeedHealthy(),
    });
    await this.applyLeggingExitResult(pos, result, reason, "auto");
  }

  /**
   * Apply the result of a legging exit to the position — the ONE place partial and
   * full closes are turned into durable state, shared by automatic and manual
   * exits so they can never diverge.
   *
   *  - Any quantity that CLOSED is applied irreversibly: `remaining_qty_by_role`
   *    is decremented (never below zero, never re-closing a flat leg), an exit
   *    attempt is appended, and charges/realised-gross accumulate.
   *  - If every role is now flat, the trade is closed on the CUMULATIVE accounting.
   *  - Otherwise the partial exit is persisted atomically and the position stays
   *    open for the next cycle to keep flattening — never marked flat, never
   *    turned into reverse exposure.
   *
   * Returns what happened so a manual caller can report it honestly.
   */
  private async applyLeggingExitResult(
    pos: BoxOpenPosition,
    result:
      | { ok: true; legs: BoxLegEvaluation[]; record: PaperLeggingExecutionRecord }
      | { ok: false; record: PaperLeggingExecutionRecord; reason: BoxExecutionFailureReason; detail: string; legs?: BoxLegEvaluation[] },
    reason: BoxExitReason,
    origin: "auto" | "manual",
  ): Promise<{ closedAny: boolean; flat: boolean; closedRoles: BoxLegRole[] }> {
    const record = result.record;
    const uncertain = this.deps.cfg.executionMode === "live" && !result.ok && /uncertain|reconcil/i.test(result.detail);
    if (uncertain) {
      const requested = emptyRoleMap();
      for (const leg of record.legs) requested[leg.role] = leg.requested_qty;
      const attempt: IBoxExitAttempt = {
        attempt_id: record.legs[0]?.order_id ?? `${pos.id}:exit:${pos.exit_attempts.length}`,
        source: origin,
        status: "UNCERTAIN",
        origin,
        reason,
        detected_at: new Date(record.detected_at),
        requested_at: new Date(record.detected_at),
        submitted_at: new Date(record.order_sent_at),
        completed_at: null,
        requested_qty_by_role: requested,
        filled_qty_by_role: { ...record.fills_by_role },
        fills_by_role: { ...record.fills_by_role },
        avg_price_by_role: {},
        charges: null,
        charges_total: 0,
        gross_pnl: null,
        remaining_after: { ...pos.remaining_qty_by_role },
        submitted_role_count: record.submitted_leg_count,
        fully_filled_role_count: record.fully_closed_role_count,
        remaining_role_count: outstandingRoles(pos).length,
        submitted_leg_count: record.submitted_leg_count,
        filled_leg_count: record.fully_closed_role_count,
        broker_orders: record.legs.map((leg) => ({
          client_order_id: leg.client_order_id,
          broker_order_id: leg.order_id,
          state: "RECONCILIATION_REQUIRED",
          requested_quantity: leg.requested_qty,
          filled_quantity: leg.fill_qty,
          average_price: leg.average_fill_price,
        })),
      };
      const projected: BoxOpenPosition = {
        ...pos,
        position_state: "RECOVERY",
        exit_blocked_reason: result.detail,
        exit_attempts: [...pos.exit_attempts, attempt],
        remaining_qty_by_role: { ...pos.remaining_qty_by_role },
      };
      const residual = outstandingRoles(projected).map<ResidualLegExposure>(({ role, quantity }) => ({
        token: projected.legs[role].token,
        tradingsymbol: projected.legs[role].tradingsymbol,
        role,
        side: entrySideFor(role, projected.direction ?? "LONG_BOX"),
        quantity,
        average_price: projected.entry_prices[role] ?? 0,
        source: "partial_exit",
        created_at: Date.now(),
      }));
      const persisted = await this.deps.persistPartialExit({ position: projected, residual, legging: record }).catch(() => false);
      if (persisted) {
        pos.position_state = "RECOVERY";
        pos.exit_blocked_reason = result.detail;
        pos.exit_attempts = projected.exit_attempts;
      } else {
        this.pendingPartialPersists.set(pos.id, { projected, residual, legging: record });
      }
      this.deps.executionSim.invariantViolation(`${pos.id}: ${result.detail}`);
      return { closedAny: false, flat: false, closedRoles: [] };
    }
    const closedLegs = (result.ok ? result.legs : result.legs ?? []).filter(
      (l) => (record.fills_by_role[l.role] ?? 0) > 0,
    );
    this.deps.metrics?.recordPartialExitAttempt();

    if (closedLegs.length === 0) {
      // Nothing closed this attempt. Keep the position open and record why (deduped).
      this.stats.exitsFailedExecution++;
      const detail =
        `${this.deps.cfg.executionMode} exit closed 0/${record.submitted_leg_count} submitted legs` +
        (result.ok ? "" : ` — ${result.detail}`);
      pos.exit_blocked_reason = detail;
      const gapKey = `legging_exit:0:${record.submitted_leg_count}`;
      if (this.lastBlockedKey.get(pos.id) !== gapKey) {
        this.lastBlockedKey.set(pos.id, gapKey);
        this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, pos.metrics, detail);
      }
      return { closedAny: false, flat: false, closedRoles: [] };
    }

    const submittedRoles = new Set<BoxLegRole>([
      ...record.legs.map((leg) => leg.role),
      ...(Object.keys(record.fills_by_role) as BoxLegRole[]),
    ]);
    const invalidRole = [...submittedRoles].find((role) => {
      const previous = pos.remaining_qty_by_role[role] ?? 0;
      const confirmed = record.fills_by_role[role] ?? 0;
      return !Number.isInteger(confirmed) || confirmed < 0 || confirmed > previous;
    });
    if (invalidRole) {
      const previous = pos.remaining_qty_by_role[invalidRole] ?? 0;
      const confirmed = record.fills_by_role[invalidRole] ?? 0;
      const message = `confirmed fill invariant violated for ${invalidRole}: ${confirmed} not within 0..${previous}`;
      this.deps.metrics?.recordInvariantFailure();
      const requested = emptyRoleMap();
      for (const leg of record.legs) requested[leg.role] = leg.requested_qty;
      const violation: IBoxExitAttempt = {
        attempt_id: record.legs[0]?.order_id ?? `${pos.id}:exit:${pos.exit_attempts.length}`,
        source: origin,
        status: "INVARIANT_VIOLATION",
        origin,
        reason,
        detected_at: new Date(record.detected_at),
        requested_at: new Date(record.detected_at),
        submitted_at: new Date(record.order_sent_at),
        completed_at: new Date(),
        requested_qty_by_role: requested,
        filled_qty_by_role: { ...record.fills_by_role },
        fills_by_role: { ...record.fills_by_role },
        avg_price_by_role: {},
        charges: null,
        charges_total: 0,
        gross_pnl: null,
        remaining_after: { ...pos.remaining_qty_by_role },
        submitted_role_count: record.submitted_leg_count,
        fully_filled_role_count: record.fully_closed_role_count,
        remaining_role_count: outstandingRoles(pos).length,
        submitted_leg_count: record.submitted_leg_count,
        filled_leg_count: record.fully_closed_role_count,
        invariant_violation: message,
      };
      const projected: BoxOpenPosition = {
        ...pos,
        exit_attempts: [...pos.exit_attempts, violation],
        position_state: "RECOVERY",
        exit_blocked_reason: message,
        remaining_qty_by_role: { ...pos.remaining_qty_by_role },
      };
      const residual = outstandingRoles(projected).map<ResidualLegExposure>(({ role, quantity }) => ({
        token: pos.legs[role].token,
        tradingsymbol: pos.legs[role].tradingsymbol,
        role,
        side: entrySideFor(role, pos.direction ?? "LONG_BOX"),
        quantity,
        average_price: pos.entry_prices[role] ?? 0,
        source: "partial_exit",
        created_at: Date.now(),
      }));
      const persisted = await this.deps.persistPartialExit({
        position: projected,
        residual,
        legging: record,
      }).catch(() => false);
      if (persisted) {
        pos.exit_attempts = [...projected.exit_attempts];
        pos.position_state = projected.position_state;
        pos.exit_blocked_reason = projected.exit_blocked_reason;
      } else {
        this.pendingPartialPersists.set(pos.id, { projected, residual, legging: record });
        pos.position_state = "RECOVERY";
        pos.exit_blocked_reason = `${message}; durable recovery projection is pending`;
      }
      this.deps.executionSim.invariantViolation(`${pos.id}: ${message}`);
      this.deps.onEvent("ERROR", pos, pos.metrics, message);
      return { closedAny: false, flat: false, closedRoles: [] };
    }

    const direction = pos.direction ?? "LONG_BOX";
    const now = Date.now();
    const projected: BoxOpenPosition = {
      ...pos,
      remaining_qty_by_role: { ...pos.remaining_qty_by_role },
      exit_attempts: [...pos.exit_attempts],
    };
    const fillsByRole: Partial<Record<BoxLegRole, number>> = {};
    const avgByRole: Partial<Record<BoxLegRole, number>> = {};
    const requestedByRole = emptyRoleMap();
    for (const leg of record.legs) requestedByRole[leg.role] = leg.requested_qty;
    const remainingAfter: Record<BoxLegRole, number> = { ...pos.remaining_qty_by_role };
    const closedRoles: BoxLegRole[] = [];
    const chargeOrders: { side: "BUY" | "SELL"; tradingsymbol: string; quantity: number; price: number }[] = [];
    let attemptGross = 0;
    let closedQtyTotal = 0;

    for (const leg of closedLegs) {
      const role = leg.role;
      const prev = pos.remaining_qty_by_role[role] ?? 0;
      const closed = record.fills_by_role[role] ?? 0;
      if (closed <= 0) continue;
      // A confirmed fill with no price is a contradiction, and defaulting it to 0 would be the
      // worst possible response: `per` below becomes ±entryPrice, fabricating tens of thousands of
      // rupees of realised P&L out of a missing field, and the leg's charges would be priced on ₹0
      // of turnover. Refuse the quantity instead and raise the invariant — the role stays
      // outstanding, so the next cycle re-reads it rather than banking a fiction.
      if (leg.price === null || !(leg.price > 0)) {
        this.deps.executionSim.invariantViolation(
          `${pos.id}: exit fill on ${role} reported ${closed} filled with no usable price; quantity retained`,
        );
        continue;
      }
      const price = leg.price;
      const remaining = Math.max(0, prev - closed);
      projected.remaining_qty_by_role[role] = remaining;
      fillsByRole[role] = closed;
      avgByRole[role] = price;
      remainingAfter[role] = remaining;
      closedRoles.push(role);
      closedQtyTotal += closed;
      // Realised gross for the closed quantity of this leg (per-leg identity that
      // sums to the box gross once all four are flat).
      const entrySide = entrySideFor(role, direction);
      const entryPrice = pos.entry_prices[role] ?? 0;
      const per = entrySide === "BUY" ? price - entryPrice : entryPrice - price;
      attemptGross += per * closed;
      chargeOrders.push({ side: leg.side, tradingsymbol: leg.tradingsymbol, quantity: closed, price });
    }

    const attemptChargeObject = this.deps.localCharges.legs(chargeOrders, "kite_estimate");
    const attemptCharges = round2(attemptChargeObject.total);
    attemptGross = round2(attemptGross);
    projected.cumulative_exit_charges = round2(pos.cumulative_exit_charges + attemptCharges);
    projected.metrics = this.measure(projected, now);

    const flat = isBoxPositionFlat(projected.remaining_qty_by_role);
    projected.position_state = deriveBoxPositionState(projected.remaining_qty_by_role, pos.position_state);

    const attempt: IBoxExitAttempt = {
      attempt_id: record.legs[0]?.order_id ?? `${pos.id}:exit:${pos.exit_attempts.length}`,
      source: origin,
      status: flat ? "COMPLETE" : "PARTIAL",
      origin,
      reason,
      detected_at: new Date(record.detected_at),
      requested_at: new Date(record.detected_at),
      submitted_at: new Date(record.order_sent_at),
      completed_at: new Date(now),
      requested_qty_by_role: requestedByRole,
      filled_qty_by_role: fillsByRole,
      fills_by_role: fillsByRole,
      avg_price_by_role: avgByRole,
      charges: attemptChargeObject,
      charges_total: attemptCharges,
      gross_pnl: attemptGross,
      remaining_after: remainingAfter,
      submitted_role_count: record.submitted_leg_count,
      fully_filled_role_count: record.fully_closed_role_count,
      remaining_role_count: BOX_LEG_ROLES.filter((role) => projected.remaining_qty_by_role[role] > 0).length,
      submitted_leg_count: record.submitted_leg_count,
      filled_leg_count: record.fully_closed_role_count,
      broker_orders: record.legs.map((leg) => ({
        client_order_id: leg.client_order_id,
        broker_order_id: leg.order_id,
        state: leg.status === "FILLED" ? "COMPLETE" : leg.status === "CANCELLED" ? "CANCELLED" : leg.status === "FAILED" ? "REJECTED" : "PARTIALLY_FILLED",
        requested_quantity: leg.requested_qty,
        filled_quantity: leg.fill_qty,
        average_price: leg.average_fill_price,
      })),
    };
    projected.exit_attempts.push(attempt);
    this.deps.metrics?.recordPartialExitFilledQty(closedQtyTotal);

    if (flat) {
      // Every role is flat → close on the CUMULATIVE accounting across attempts.
      const cumulativeGross = round2(projected.exit_attempts.reduce((s, a) => s + (a.gross_pnl ?? 0), 0));
      const finalLegs = this.buildFinalExitLegs(projected);
      const finalMetrics = computeExitMetrics({
        boxWidth: pos.box_width,
        lotSize: pos.lot_size,
        entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
        entryNetEdge: pos.entry_net_edge,
        entryChargesTotal: pos.entry_charges_total,
        currentExitChargesTotal: projected.cumulative_exit_charges,
        legs: finalLegs,
        now,
        direction,
        entryEdge: pos.entry_gross_edge,
        executionCost: 0,
        useRealisableForFloor: false,
        openedAt: pos.opened_at,
        expirySafety: this.isInExpirySafetyWindow(pos),
        cfg: this.deps.cfg,
      });
      projected.metrics = finalMetrics;
      projected.exit_blocked_reason = null;
      this.lastBlockedKey.delete(pos.id);
      this.stats.exitsTriggered++;
      if (origin === "manual") this.deps.metrics?.recordManualLeggingExit();
      this.deps.onEvent("EXIT_TRIGGERED", projected, finalMetrics, reason);
      const closeArgs: Parameters<BoxMonitorDeps["closePaperTrade"]>[0] = {
        position: projected,
        metrics: finalMetrics,
        exitCharges: null,
        reason,
        execution: null,
        legging: record,
        residual: null,
        grossPnlOverride: cumulativeGross,
        exitChargesTotalOverride: projected.cumulative_exit_charges,
        exitAttempts: projected.exit_attempts,
      };
      const closed = await this.deps.closePaperTrade(closeArgs).catch(() => false);
      if (!closed) {
        // Broker-confirmed fills are irreversible, but the close projection is not
        // authoritative until Mongo accepts it. Quarantine and retry persistence
        // only; never submit another exit order for these already-flat roles.
        this.pendingFinalPersists.set(pos.id, closeArgs);
        pos.position_state = "RECOVERY";
        pos.exit_blocked_reason = "all exit fills confirmed, but final close persistence is pending";
        this.deps.executionSim.invariantViolation(`${pos.id}: final close persistence pending`);
        return { closedAny: true, flat: false, closedRoles };
      }
      pos.remaining_qty_by_role = { ...projected.remaining_qty_by_role };
      pos.position_state = projected.position_state;
      pos.cumulative_exit_charges = projected.cumulative_exit_charges;
      pos.exit_attempts = [...projected.exit_attempts];
      pos.metrics = projected.metrics;
      pos.exit_blocked_reason = null;
      return { closedAny: true, flat: true, closedRoles };
    }

    // Partial close → persist the projected exact map before making it authoritative.
    const residual = outstandingRoles(projected).map<ResidualLegExposure>(({ role, quantity }) => ({
      token: pos.legs[role].token,
      tradingsymbol: pos.legs[role].tradingsymbol,
      role,
      side: entrySideFor(role, direction),
      quantity,
      average_price: pos.entry_prices[role] ?? 0,
      source: "partial_exit",
      created_at: now,
    }));
    this.deps.metrics?.recordPartialExitRemainingRoles(residual.length);
    // `.catch` is NOT optional here. The store REJECTS (rather than returning false) on a socket
    // error, timeout or topology change. An escaping rejection would unwind past this function
    // without running the quarantine below, leaving `pos.remaining_qty_by_role` still claiming the
    // full quantity on roles the broker has already closed — and nothing queued for retry. The next
    // monitor cycle would then size a fresh closing order from those stale figures and re-close an
    // already-flat role, which is reverse exposure: precisely the outcome this class exists to make
    // impossible. Every sibling persist on this path is guarded the same way.
    const persisted = await this.deps
      .persistPartialExit({ position: projected, residual, legging: record })
      .catch(() => false);
    const detail =
      `partial exit: closed ${closedRoles.join(", ")}; still open ` +
      `${residual.map((r) => `${r.role}×${r.quantity}`).join(", ")}` +
      (persisted ? "" : " (persist failed — retained for deterministic retry)");
    if (persisted) {
      pos.remaining_qty_by_role = { ...projected.remaining_qty_by_role };
      pos.position_state = projected.position_state;
      pos.cumulative_exit_charges = projected.cumulative_exit_charges;
      pos.exit_attempts = [...projected.exit_attempts];
      pos.metrics = projected.metrics;
    } else {
      this.pendingPartialPersists.set(pos.id, { projected, residual, legging: record });
      pos.position_state = "RECOVERY";
      this.deps.executionSim.invariantViolation(`${pos.id}: confirmed partial exit awaits durable persistence`);
    }
    pos.exit_blocked_reason = detail;
    const gapKey = `partial_exit:${residual.map((r) => r.role).join("|")}`;
    if (this.lastBlockedKey.get(pos.id) !== gapKey) {
      this.lastBlockedKey.set(pos.id, gapKey);
      this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, pos.metrics, detail);
    }
    return { closedAny: true, flat: false, closedRoles };
  }

  /**
   * Build one exit-side leg evaluation per role from the accumulated attempts'
   * volume-weighted average close price — the coherent four-leg view a completed
   * multi-attempt close is priced/displayed on.
   */
  private buildFinalExitLegs(pos: BoxOpenPosition): BoxLegEvaluation[] {
    const direction = pos.direction ?? "LONG_BOX";
    return BOX_LEG_ROLES.map((role) => {
      let qty = 0;
      let value = 0;
      for (const a of pos.exit_attempts) {
        const q = a.fills_by_role[role] ?? 0;
        const p = a.avg_price_by_role[role] ?? 0;
        qty += q;
        value += q * p;
      }
      const price = qty > 0 ? round2(value / qty) : pos.entry_prices[role] ?? 0;
      const inst = pos.legs[role];
      return {
        role,
        side: direction === "LONG_BOX"
          ? (role === "k1_ce" || role === "k2_pe" ? "SELL" : "BUY")
          : (role === "k1_ce" || role === "k2_pe" ? "BUY" : "SELL"),
        token: inst.token,
        tradingsymbol: inst.tradingsymbol,
        strike: inst.strike,
        instrument_type: inst.instrument_type,
        price,
        qty_at_touch: qty,
        bid: 0,
        bid_qty: 0,
        ask: 0,
        ask_qty: 0,
        quote_at: null,
        quote_version: null,
        depth: null,
        age_ms: null,
        fresh: true,
        executable: price > 0,
      };
    });
  }

  private recordLiquiditySkip(pos: BoxOpenPosition, metrics: BoxExitMetrics): void {
    this.stats.exitsSkippedLiquidity++;
    const detail = describeLiquidityGap(metrics.legs, pos.lot_size);
    const key = liquidityGapKey(metrics.legs, pos.lot_size);
    if (this.lastBlockedKey.get(pos.id) !== key) {
      this.lastBlockedKey.set(pos.id, key);
      pos.exit_blocked_reason = detail;
      this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, metrics, detail);
    } else {
      pos.exit_blocked_reason = detail;
    }
  }

  /**
   * Manual close, driven by the UI.
   *
   * Uses the same executable touch as an automatic close, priced with the local
   * calculator. Refuses rather than inventing prices when the four-leg one-lot
   * market is unavailable, and says why.
   */
  async closeManually(id: string): Promise<ManualCloseResult> {
    const pos = this.deps.positions.get(id);
    if (!pos) {
      return { ok: false, error: "That box position is not open.", metrics: null, code: 404 };
    }
    if (pos.position_state === "RECOVERY") {
      return {
        ok: false,
        error: "Cannot manually close a RECOVERY position through ordinary execution. Reconcile broker orders and positions first.",
        metrics: pos.metrics,
        code: 409,
      };
    }
    if (pos.closing || this.closingIds.has(id)) {
      return {
        ok: false,
        error: "That box position is already being closed.",
        metrics: pos.metrics,
        code: 409,
      };
    }
    if (!this.deps.isMarketOpen()) {
      return {
        ok: false,
        error: "Cannot close while the exchange is closed. The position is still monitored.",
        metrics: pos.metrics,
        code: 409,
      };
    }
    if (!this.deps.isFeedHealthy()) {
      // The refusal now carries the DEGRADED assessment when one is wired, so the operator learns
      // whether the broker could price this at all and what the remaining route is — rather than a
      // bare "feed unavailable" that leaves them guessing. Nothing is attempted either way.
      const detail = this.deps.degradedReductionBlockReason?.(pos)
        ?? "Cannot close while the live WebSocket feed is unavailable. The position is still monitored.";
      pos.exit_blocked_reason = detail;
      return {
        ok: false,
        error: detail,
        metrics: pos.metrics,
        code: 409,
      };
    }

    // A manual close changes only the REASON, never the execution mechanics: in
    // paper_legging it uses the SAME independent-order model (and partial-state
    // persistence) as an automatic close.
    if (this.deps.cfg.executionMode === "paper_legging" || this.deps.cfg.executionMode === "live") {
      return this.manualLeggingClose(pos);
    }

    const first = this.measure(pos);
    pos.metrics = first;
    if (!exitLiquidityOk(first.legs)) {
      const detail = describeLiquidityGap(first.legs, pos.lot_size);
      pos.exit_blocked_reason = detail;
      this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, first, `manual close refused: ${detail}`);
      return {
        ok: false,
        error: `Cannot close at an executable price right now: ${detail}. The position is still open and being monitored.`,
        metrics: first,
        code: 409,
      };
    }

    // Claim before the simulated fill so an automatic evaluation cannot race it.
    this.closingIds.add(id);
    pos.closing = true;
    let handed = false;
    try {
      const result = await this.deps.executionSim.simulateExit({
        position: pos,
        detectionLegs: first.legs,
        detectedAt: first.at,
        stillWanted: () => this.deps.isMarketOpen() && this.deps.isFeedHealthy(),
        validate: (legs) =>
          exitLiquidityOk(legs)
            ? { ok: true as const }
            : { ok: false as const, reason: "insufficient_quantity" as const, detail: "exit touch cannot fill one lot" },
      });

      if (!result.ok) {
        const fresh = this.measure(pos, Date.now());
        pos.metrics = fresh;
        const detail = result.detail;
        if (!exitLiquidityOk(fresh.legs)) {
          pos.exit_blocked_reason = describeLiquidityGap(fresh.legs, pos.lot_size);
          this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, fresh, `manual close refused: ${pos.exit_blocked_reason}`);
        }
        return {
          ok: false,
          error: `Cannot close at an executable price right now: ${detail}. The position is still open and being monitored.`,
          metrics: fresh,
          code: 409,
        };
      }

      const exitCharges = this.localExitCharges(pos, result.legs);
      const exitTotal = exitCharges ? exitCharges.total : this.localExitChargesTotal(pos, result.legs);
      const metrics = computeExitMetrics({
        boxWidth: pos.box_width,
        lotSize: pos.lot_size,
        entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
        entryNetEdge: pos.entry_net_edge,
        entryChargesTotal: pos.entry_charges_total,
        currentExitChargesTotal: exitTotal,
        legs: result.legs,
        now: Date.now(),
        direction: pos.direction ?? "LONG_BOX",
        entryEdge: pos.entry_gross_edge,
        executionCost: exitSlippageAllowanceForLot(this.deps.cfg, pos.lot_size),
        openedAt: pos.opened_at,
        expirySafety: this.isInExpirySafetyWindow(pos),
        cfg: this.deps.cfg,
      });
      pos.metrics = metrics;

      this.stats.exitsTriggered++;
      this.deps.onEvent("EXIT_TRIGGERED", pos, metrics, "MANUAL");
      handed = true;
      const closed = await this.deps.closePaperTrade({
        position: pos,
        metrics,
        exitCharges,
        reason: "MANUAL",
        execution: result.record,
      });
      if (!closed) {
        pos.closing = false;
        return {
          ok: false,
          error: "That box position was already closed.",
          metrics,
          code: 409,
        };
      }
      return { ok: true };
    } finally {
      this.closingIds.delete(id);
      if (!handed) pos.closing = false;
    }
  }

  /**
   * Manual close for paper_legging — the SAME independent-order path and partial-
   * state persistence as an automatic close, differing only in the exit reason and
   * in reporting the outcome honestly to the caller.
   */
  private async manualLeggingClose(pos: BoxOpenPosition): Promise<ManualCloseResult> {
    const first = this.measure(pos);
    pos.metrics = first;

    // Depth-aware pre-gate (shared with the executor): refuse only when there is
    // genuinely not enough executable liquidity for the outstanding quantity.
    if (!this.exitExecutionOk(pos, first)) {
      const detail = describeLiquidityGap(first.legs, pos.lot_size);
      pos.exit_blocked_reason = detail;
      this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, first, `manual close refused: ${detail}`);
      return {
        ok: false,
        error: `Cannot close at an executable price right now: ${detail}. The position is still open and being monitored.`,
        metrics: first,
        code: 409,
      };
    }

    this.closingIds.add(pos.id);
    pos.closing = true;
    pos.last_exit_attempt_at = Date.now();
    let outcome: { closedAny: boolean; flat: boolean; closedRoles: BoxLegRole[] } = {
      closedAny: false,
      flat: false,
      closedRoles: [],
    };
    try {
      const result = await this.deps.executionSim.simulateLeggingExit({
        position: pos,
        detectionLegs: first.legs,
        detectedAt: first.at,
        stillWanted: () => this.deps.isMarketOpen() && this.deps.isFeedHealthy(),
      });
      outcome = await this.applyLeggingExitResult(pos, result, "MANUAL", "manual");
    } catch (err) {
      console.warn("[Box] manual legging close failed for", pos.id, err);
      this.deps.onEvent("ERROR", pos, pos.metrics, `manual close failed: ${String(err)}`);
    } finally {
      this.closingIds.delete(pos.id);
      // Only a fully flat position is removed by closePaperTrade; if it is still
      // open (nothing/partial closed) clear the guard so a later cycle retries.
      if (this.deps.positions.get(pos.id)) pos.closing = false;
    }

    if (outcome.flat) return { ok: true };

    const remaining = { ...pos.remaining_qty_by_role };
    if (outcome.closedAny) {
      // Some roles closed, others remain: report the partial honestly rather than
      // pretending nothing happened. The remaining exposure keeps being managed.
      return {
        ok: false,
        partial: true,
        filled_roles: outcome.closedRoles,
        remaining_qty_by_role: remaining,
        error: "Position partially closed; remaining exposure is still being managed.",
        metrics: pos.metrics,
        code: 409,
      };
    }
    return {
      ok: false,
      error: "Cannot close at an executable price right now. The position is still open and being monitored.",
      metrics: pos.metrics,
      code: 409,
    };
  }

  /**
   * Whether there is enough EXECUTABLE liquidity to work a close right now.
   *
   * paper_legging walks depth within a limit, so its gate asks the shared executor
   * estimator whether every outstanding role can execute its remaining quantity;
   * the atomic modes fill at the single touch, so they keep the whole-lot touch
   * gate. One implementation per model — the qualification cannot drift from what
   * the executor actually does.
   */
  private exitExecutionOk(pos: BoxOpenPosition, metrics: BoxExitMetrics): boolean {
    if (this.deps.cfg.executionMode === "live") {
      const est = this.deps.executionSim.estimateExecutableExit(pos);
      if (est.length === 0) return false;
      // LIVE ISOLATES PER LEG, so this gate must too.
      //
      // `every` here was the second half of the all-or-nothing exit defect: one outstanding role
      // with no book (or a stale/thin one) made the whole predicate false, so `runExit` returned at
      // the EXIT_SKIPPED_LIQUIDITY branch and `simulateLeggingExit` was never called at all. The
      // per-leg isolation inside the gateway was therefore unreachable in production, and a
      // risk-reducing close on a leg with perfectly good depth was suppressed by an unrelated leg.
      //
      // `some` asks the question this gate is actually for: is there ANY work worth attempting? It
      // does NOT decide what gets sent. The gateway still prechecks every leg individually and the
      // order manager still re-validates at CHECKPOINT 3 (dequeue) and CHECKPOINT 5 (pre-POST), so
      // relaxing this cannot transmit anything against an unusable book — it can only stop the
      // monitor from refusing to look. Legs that remain unexecutable are reported as withheld and
      // the exit is never reported as fully closed.
      return est.some((e) => e.fresh && e.executable >= e.remaining);
    }
    if (this.deps.cfg.executionMode === "paper_legging") {
      const est = this.deps.executionSim.estimateExecutableExit(pos);
      if (est.length === 0) return false;
      // paper_legging keeps the whole-position gate: its simulator resolves a wave as one unit and
      // has no per-leg withholding, so admitting a partially executable position there would model
      // an execution the paper executor cannot actually perform. One implementation per model.
      return est.every((e) => e.fresh && e.executable >= e.remaining);
    }
    return exitLiquidityOk(metrics.legs);
  }

  /**
   * Where this position stands relative to settlement.
   *
   *   "none"     — not on expiry day, or on expiry day but before the safety window opens.
   *   "window"   — expiry day, inside the last `expirySafetyMinutesBeforeClose` minutes.
   *   "expired"  — the contract's expiry date has ALREADY PASSED and the position is still open.
   *
   * THE "expired" STATE IS THE BUG FIX. The predicate was `if (pos.expiry !== this.deps.istDayKey())
   * return false;` — an EQUALITY. So the only day on which expiry safety could ever fire was the
   * expiry date itself, and a position that survived past it (the process was down across expiry, or
   * the exit was refused for liquidity right to the bell) fell permanently out of the window: never
   * force-exited, never flagged, never escalated. It sat in the book indefinitely, contributing stale
   * marks to the day's P&L while the contract no longer existed.
   *
   * That is also the single most expensive state in the system. Settlement is not free: exercise STT
   * is 0.15% of INTRINSIC value on every in-the-money LONG leg (raised from 0.125% effective
   * 1 April 2026), a box ALWAYS has in-the-money legs, and the cost is unbounded in how far the
   * underlying travelled — so the position an operator was never told about is precisely the one
   * whose cost cannot be bounded.
   *
   * Pure clock-and-calendar arithmetic: no feed, no book, no broker. That is what allows detection to
   * run unconditionally, above the market-hours and feed-health guards.
   */
  private expirySafetyState(pos: BoxOpenPosition): "none" | "window" | "expired" {
    const today = this.deps.istDayKey();
    // ISO dates compare lexicographically in chronological order.
    if (pos.expiry < today) return "expired";
    if (pos.expiry !== today) return "none";
    const minutes = this.deps.istMinutesOfDay();
    return minutes >= IST_CLOSE_MINUTES - this.deps.cfg.expirySafetyMinutesBeforeClose
      ? "window"
      : "none";
  }

  private isInExpirySafetyWindow(pos: BoxOpenPosition): boolean {
    return this.expirySafetyState(pos) !== "none";
  }
}

/** The result of a manual close — honest about partial execution. */
export type ManualCloseResult =
  | { ok: true; partial?: false }
  | {
      ok: false;
      error: string;
      metrics: BoxExitMetrics | null;
      code: number;
      /** True when SOME roles closed but exposure remains (still being managed). */
      partial?: boolean;
      filled_roles?: BoxLegRole[];
      remaining_qty_by_role?: Record<BoxLegRole, number>;
    };

function emptyRoleMap(): Record<BoxLegRole, number> {
  return { k1_ce: 0, k2_ce: 0, k2_pe: 0, k1_pe: 0 };
}

/**
 * A STABLE identity for the SHAPE of a liquidity gap: which legs are blocked and
 * why, with no volatile numbers in it.
 */
export function liquidityGapKey(legs: BoxLegEvaluation[], lotSize: number): string {
  const parts: string[] = [];
  for (const l of legs) {
    let cause: string | null = null;
    if (l.quote_at === null) cause = "no_book";
    else if (!l.fresh) cause = "stale";
    else if (l.price === null || !(l.price > 0)) cause = l.side === "BUY" ? "no_ask" : "no_bid";
    else if (l.qty_at_touch < lotSize) cause = "thin";
    if (cause) parts.push(`${l.role}:${cause}`);
  }
  return parts.join("|") || "ok";
}

/** A human-readable description of which legs cannot fill one lot. */
export function describeLiquidityGap(legs: BoxLegEvaluation[], lotSize: number): string {
  const problems: string[] = [];
  for (const l of legs) {
    if (l.quote_at === null) {
      problems.push(`${l.tradingsymbol} has no live book`);
    } else if (!l.fresh) {
      problems.push(`${l.tradingsymbol} book is stale (${l.age_ms ?? "?"}ms)`);
    } else if (l.price === null || !(l.price > 0)) {
      problems.push(`${l.tradingsymbol} has no ${l.side === "BUY" ? "ask" : "bid"}`);
    } else if (l.qty_at_touch < lotSize) {
      problems.push(`${l.tradingsymbol} shows ${l.qty_at_touch} at ${l.price} (needs ${lotSize})`);
    }
  }
  return problems.length > 0 ? problems.join("; ") : "insufficient touch liquidity";
}
