/**
 * Dhan live order transport, implementing the EXISTING `BrokerAdapter` interface.
 *
 * Deliberately a sibling of `kiteBrokerAdapter.ts`, not a new strategy: the same
 * `BoxOrderManager`, the same durable intents, the same bounded marketable-LIMIT
 * envelope, the same reconciliation state machine. Only the transport changes.
 *
 * FOUR THINGS THIS FILE IS RESPONSIBLE FOR GETTING RIGHT
 *
 *  1. NEVER an unrestricted MARKET order. Every request carries a bounded LIMIT
 *     envelope and `assertBoundedLimit` is enforced before anything is sent. Dhan
 *     supports MARKET orders; a four-leg box must not use them.
 *
 *  2. NEVER a blind re-submit. If POST /orders fails ambiguously (timeout, 5xx,
 *     429) the order may be live. The adapter reconciles by CORRELATION ID before
 *     concluding anything, because a second POST is how a box grows a fifth leg.
 *
 *  3. FAIL CLOSED on static IP. Dhan requires the caller's public IP to be
 *     whitelisted for order placement. When that is not satisfied the adapter
 *     refuses locally rather than discovering it mid-box.
 *
 *  4. HONEST STATE. Anything the adapter cannot prove is terminal becomes
 *     RECONCILIATION_REQUIRED, never a guessed COMPLETE or CANCELLED.
 *
 * PRODUCT TYPE is `MARGIN` — Dhan's F&O carry-forward product, the analogue of
 * Kite's `NRML`. `INTRADAY` would expose the box to auto-square-off.
 */

import {
  type BrokerEndpointClass,
  type BrokerPacingClass,
  type EffectiveBrokerPacing,
  isRateLimited,
  RateBudgetLedger,
  resolveBrokerPacing,
  TransportPacer,
  type TransportPacerStats,
  type TransportUrgency,
} from "./brokerPacing.js";
import {
  assertBoundedLimit,
  BrokerAmbiguousSubmitError,
  BrokerDisabledError,
  BrokerPreSubmitRefusedError,
  brokerRejectionOutcome,
  isBrokerOrderTerminal,
  type BrokerAdapter,
  type BeforeBrokerPost,
  type BrokerHealth,
  type BrokerMargin,
  type BrokerModifyRequest,
  type BrokerOrder,
  type BrokerOrderRequest,
  type BrokerOrderState,
  type BrokerPosition,
  type BrokerRejectFamily,
  type ExternalOrderUpdate,
} from "./brokerAdapter.js";
import type { BoxConfig } from "./config.js";
import { Deadline, monotonicNow, type MonotonicClock } from "../brokers/deadline.js";
import {
  evaluateExecutionEvidence,
  readCumulativeQuantity,
  readNonNegativeInteger,
  readPositivePrice,
  readTradedPrice,
} from "./brokerExecutionEvidence.js";
import type { ExecutionTimingRecorder } from "./executionTiming.js";
import type { IBoxOrderIntent } from "./types.js";
import {
  DhanAuthError,
  DhanError,
  DhanNetworkError,
  DhanRateLimitError,
  DhanTradingBlockedError,
} from "../brokers/dhan/errors.js";
import {
  dhanCorrelationId,
  isValidDhanCorrelationId,
} from "../brokers/dhan/correlation.js";
import { mergeBrokerOrderSnapshot, type BrokerOrderMergeOptions } from "./brokerOrderMerge.js";
import { parseIstBrokerTimestamp } from "./brokerTimestamps.js";
import type {
  DhanClient,
  DhanOrder,
  DhanOrderStatus,
  DhanPosition,
  DhanTrade,
} from "../brokers/dhan/client.js";
import type { DhanExchangeSegment } from "../brokers/dhan/segments.js";

export interface DhanAdapterConfig {
  /** Live only when the execution mode is live AND the deployment kill switch is on. */
  executionMode: BoxConfig["executionMode"];
  enabled: boolean;
  /**
   * Whether Dhan's static-IP requirement is satisfied.
   *
   * A FUNCTION, not a boolean: readiness can change while the process runs, and a
   * value captured at construction would let a box start after the check went bad.
   */
  staticIpReady: () => boolean;
  ackTimeoutMs: number;
  workingTimeoutMs: number;
  partialTimeoutMs: number;
  cancelTimeoutMs: number;
  /**
   * GENERAL transport pacing: order-status polls, order/position lists, funds, profile.
   *
   * Also the poll cadence in `waitForTerminal` / `protectiveCancelAndConfirm`. Unchanged in
   * meaning. ORDER MUTATIONS are paced separately — see {@link pacing}.
   */
  brokerMinIntervalMs: number;
  /**
   * Resolved order-mutation vs general pacing. Optional so existing config literals in tests
   * keep compiling; absent, it is derived from `brokerMinIntervalMs` and Dhan's floor.
   */
  pacing?: EffectiveBrokerPacing;
  /**
   * The SHARED, application-owned multi-window order budget for this broker ACCOUNT (Task 8).
   *
   * Optional so existing config literals keep compiling. When present it MUST be the ONE ledger
   * shared across every adapter/consumer on the same account (the engine owns it), because the
   * broker meters the account, not the adapter instance. The adapter consults it at the pre-wire
   * boundary: an over-budget ENTRY placement is refused with a proven no-POST
   * {@link BrokerPreSubmitRefusedError}, while a protective CANCEL/MODIFY spends the recovery
   * reserve so a placement storm cannot starve it.
   */
  rateBudget?: RateBudgetLedger;
  maxModifications: number;
  maxChaseTicks: number;
  dhanClientId: () => string;
  /** Internal token → Dhan (segment, securityId). */
  identify: (token: number) => { segment: DhanExchangeSegment; securityId: number } | null;
  /**
   * LIVE TIMING INSTRUMENTATION (Phase 2). Optional and FAIL-OPEN.
   *
   * Marks the stages only this adapter can witness: transport start, the HTTP request leaving the
   * wire, the response, the broker order id, the ACK, each cumulative fill, and the cancel
   * request/acknowledgement. The OrderManager owns the queue stages and the terminal publish.
   *
   * Dhan samples are filed under broker `dhan` and can never mix with Zerodha's — the two have
   * different networks and different gateways, so a pooled distribution would describe neither.
   */
  timing?: ExecutionTimingRecorder;
  /**
   * MONOTONIC clock for elapsed/deadline measurement (Defect D).
   *
   * The poll and protective-cancel loops used `Date.now()`, so a wall-clock step (NTP correction,
   * VM time sync) could shorten or lengthen a deadline the safety argument depends on. Wall-clock
   * time is still used for `created_at`/`updated_at`, which are AUDIT stamps and must stay
   * comparable with broker timestamps; only DURATIONS move to the monotonic clock.
   *
   * Optional so existing config literals keep compiling; defaults to `performance.now()`.
   */
  monotonic?: MonotonicClock;
  /**
   * ABSOLUTE end-to-end budget for ONE order mutation, in ms (Defect D).
   *
   * Started BEFORE the adapter's own transport pacer, so the pacer wait, the lower Dhan HTTP
   * pacing queue, the network round trip and the response body all draw on the SAME budget instead
   * of each layer restarting its own timer. Absent, the transport's own `timeoutMs` applies as
   * before and the adapter imposes nothing extra.
   */
  orderMutationDeadlineMs?: number;
}

export function dhanAdapterConfigFromBoxConfig(
  cfg: BoxConfig,
  deps: {
    staticIpReady: () => boolean;
    dhanClientId: () => string;
    identify: (token: number) => { segment: DhanExchangeSegment; securityId: number } | null;
    timing?: ExecutionTimingRecorder;
    /** The shared, application-owned account order budget (Task 8). */
    rateBudget?: RateBudgetLedger;
  },
): DhanAdapterConfig {
  return {
    executionMode: cfg.executionMode,
    enabled: cfg.liveTradingEnabled,
    ackTimeoutMs: cfg.liveAckTimeoutMs,
    workingTimeoutMs: cfg.liveWorkingTimeoutMs,
    partialTimeoutMs: cfg.livePartialTimeoutMs,
    cancelTimeoutMs: cfg.liveCancelTimeoutMs,
    orderMutationDeadlineMs: cfg.liveOrderMutationDeadlineMs,
    brokerMinIntervalMs: cfg.liveBrokerMinIntervalMs,
    pacing: resolveBrokerPacing("dhan", cfg.liveBrokerMinIntervalMs, cfg.liveBrokerOrderMinIntervalMs),
    maxModifications: cfg.liveMaxModifications,
    maxChaseTicks: cfg.liveMaxChaseTicks,
    ...deps,
  };
}

/**
 * Map Dhan's order status onto Calspread's `BrokerOrderState`.
 *
 * `filled`/`quantity` are consulted because Dhan reports `TRADED` for a fully
 * executed order but a partially filled one can appear as `PENDING` with a non-zero
 * filled quantity — trusting the label alone would treat a half-filled leg as
 * merely working, and the box's exposure accounting would be wrong.
 *
 * An UNRECOGNISED status becomes UNKNOWN, never a guess: the order manager knows how
 * to reconcile UNKNOWN, and inventing COMPLETE would fabricate a fill.
 */
export function dhanOrderState(
  status: DhanOrderStatus | string,
  filled: number,
  quantity: number,
): BrokerOrderState {
  const value = String(status ?? "").trim().toUpperCase();
  switch (value) {
    case "TRANSIT":
      // Accepted by Dhan, not yet acknowledged by the exchange.
      return "ACKNOWLEDGED";
    case "PENDING":
      // Working at the exchange — but a partial fill can also present as PENDING.
      return filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "OPEN";
    case "PART_TRADED":
      // Explicitly partial. If it has since completed, report COMPLETE.
      return filled >= quantity && quantity > 0 ? "COMPLETE" : "PARTIALLY_FILLED";
    case "TRADED":
      // Fully executed. Guard against a TRADED label with a short fill.
      return quantity > 0 && filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "COMPLETE";
    case "CANCELLED":
    case "CLOSED":
      return "CANCELLED";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
      // Validity lapsed without full execution. A partial fill still stands, so the
      // remainder is effectively cancelled rather than rejected.
      return filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Classify a Dhan rejection into the existing reject families.
 *
 * Prefers Dhan's `omsErrorCode` and falls back to the description, because a code is
 * stable while free text is not. The families drive risk decisions (a margin
 * rejection means stop; a price-band rejection means re-price), so `generic` is the
 * honest answer when nothing matches rather than a plausible-sounding guess.
 */
export function classifyDhanReject(code: string | null, description: string | null): BrokerRejectFamily {
  const text = `${code ?? ""} ${description ?? ""}`.toLowerCase();
  if (/margin|insufficient|fund|balance/.test(text)) return "margin";
  if (/price band|circuit|dpr|price range|freeze price/.test(text)) return "price_band";
  if (/quantity freeze|freeze quantity|max.*quantity|qty freeze/.test(text)) return "quantity_freeze";
  if (/not permitted|not allowed|rms|risk/.test(text)) return "rms";
  if (/market clos|outside market|trading session|not open/.test(text)) return "market_closed";
  if (/instrument|security|symbol|contract.*not|invalid securityid/.test(text)) return "instrument_unavailable";
  if (/rate limit|too many/.test(text)) return "rate_limit";
  if (/token|unauthor|forbidden|session|invalid.*access/.test(text)) return "auth";
  return "generic";
}

/**
 * Epoch ms from a Dhan timestamp string, or a fallback.
 *
 * THE PREVIOUS VERSION OF THIS FUNCTION LOOKED FIXED BUT WAS NOT. It tried `Date.parse(value)`
 * first and only appended `+05:30` when that returned NaN — but a space-separated stamp like
 * `"2026-09-09 10:00:01"` parses PERFECTLY WELL as host-local time, so the naive branch always won
 * and the IST branch was unreachable dead code. Dhan therefore carried exactly the timezone defect
 * its own comment claimed to have fixed.
 *
 * Now delegated to the shared parser, which builds the instant from the parsed components and never
 * lets a host-local reading participate. See `brokerTimestamps.ts`.
 */
function parseDhanTime(value: string | null | undefined, fallback: number): number {
  return parseIstBrokerTimestamp(value) ?? fallback;
}

/** Map the broker-metered endpoint class onto the per-second pacing bucket. */
function dhanPacingClassFor(klass: BrokerEndpointClass): BrokerPacingClass {
  return klass === "data_read" ? "general" : "order_mutation";
}

/**
 * Map the broker-metered endpoint class onto a DISPATCH TIER.
 *
 * Identical policy to the Kite adapter, deliberately: the pacer is shared, so if the two brokers
 * classified urgency differently the same queue would apply two different notions of "urgent".
 */
function dhanUrgencyFor(klass: BrokerEndpointClass): TransportUrgency {
  if (klass === "order_cancel" || klass === "order_modify") return "recovery";
  if (klass === "order_place") return "placement";
  return "read";
}

export class DhanBrokerAdapter implements BrokerAdapter {
  readonly mode = "live" as const;
  /** Session-local identity maps, exactly as the Kite adapter keeps. */
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly clientByBroker = new Map<string, string>();
  private readonly clientByCorrelation = new Map<string, string>();
  private readonly modifications = new Map<string, number>();
  private readonly pacer: TransportPacer;

  constructor(
    private readonly client: DhanClient,
    private readonly cfg: DhanAdapterConfig,
  ) {
    this.pacer = new TransportPacer(
      this.cfg.pacing ?? resolveBrokerPacing("dhan", this.cfg.brokerMinIntervalMs, 0),
      { now: () => Date.now(), wait: (ms) => sleep(ms) },
    );
  }

  /** The pacing actually in force, for diagnostics. */
  effectivePacing(): EffectiveBrokerPacing {
    return this.pacer.effective();
  }

  /** Observed pacing cost, for diagnostics. */
  pacingStats(): TransportPacerStats {
    return this.pacer.stats();
  }

  /** The correlation id for a client order id (also usable by callers/tests). */
  correlationFor(clientOrderId: string): string {
    return dhanCorrelationId(clientOrderId);
  }

  /**
   * The account behind the credential this adapter would sign the NEXT request with.
   *
   * WITHOUT THIS THE SEND-BOUNDARY ACCOUNT FENCE WAS A NO-OP FOR DHAN. The manager compares the
   * account an order was stamped under against `adapter.dispatchAccount()`, and an adapter that does
   * not implement it reports "cannot prove" — which, correctly, never refuses. So the P0 fence
   * silently protected Zerodha only.
   *
   * `dhanClientId` is read fresh from the same provider the request body is built from
   * (`buildOrderRequest` uses `this.cfg.dhanClientId()`), so the identity checked here and the
   * identity sent to Dhan cannot diverge. Fail-safe: any fault is reported as unproven (null), never
   * as a match.
   */
  dispatchAccount(): string | null {
    try {
      const account = this.cfg.dhanClientId();
      return typeof account === "string" && account.trim() !== "" ? account.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Both gates, exactly like the Kite adapter: a disabled instance makes ZERO
   * broker calls, including reads.
   */
  private isEnabled(): boolean {
    return this.cfg.executionMode === "live" && this.cfg.enabled;
  }

  private ensureEnabled(): void {
    if (!this.isEnabled()) {
      throw new BrokerDisabledError("Dhan live broker adapter is disabled.");
    }
  }

  /**
   * FAIL CLOSED on the static-IP requirement, for MUTATIONS only.
   *
   * Dhan refuses order placement/modification/cancellation from a non-whitelisted
   * IP. Checking locally means the box never gets half-built before discovering it,
   * and the operator sees the real reason instead of a generic broker error.
   *
   * Reads are deliberately NOT gated: market data and order lookups work without it,
   * and blocking them would prevent the very reconciliation needed to recover.
   */
  private ensureTradingReady(): void {
    this.ensureEnabled();
    if (!this.cfg.staticIpReady()) {
      throw new DhanTradingBlockedError(
        "Dhan live execution blocked: the server's static public IP is not whitelisted for order placement. " +
          "Whitelist it in the Dhan API dashboard, or set DHAN_STATIC_IP_EXPECTED to confirm it is configured.",
      );
    }
  }

  /**
   * Serialized, self-paced transport (one broker call at a time).
   *
   * `klass` defaults to `"general"`, so an unclassified call is paced by the SLOWER interval.
   * Only place / modify / cancel opt into Dhan's order-mutation rate. Note Dhan additionally
   * paces every HTTP call at `DHAN_MIN_INTERVAL_MS` inside src/brokers/dhan/http.ts, which is
   * why the Dhan order floor in brokerPacing.ts matches that value rather than going lower.
   */
  /**
   * Resolvers waiting for the NEXT observation of one order, keyed by client order id.
   *
   * This is what makes an order-update stream more than a status label. `waitForResolution` used to
   * sleep a fixed `brokerMinIntervalMs` between REST polls, so a fill was seen at best one poll
   * interval after it happened, no matter how promptly the broker told us. A stream event now
   * resolves the pending sleep immediately, so the waiter wakes on the EVENT.
   *
   * Bounded by construction: one entry per in-flight order, deleted the moment it is woken.
   */
  private readonly orderWaiters = new Map<string, Set<() => void>>();
  /** Client order ids observed while no waiter was parked; the next wait consumes the latch. */
  private readonly pendingObservation = new Set<string>();
  /** Stream observations applied to this session, for status/diagnostics. */
  private streamObservationsApplied = 0;
  private streamObservationsIgnored = 0;

  /**
   * Sleep up to `ms`, but wake EARLY if an external observation of this order arrives.
   *
   * Never longer than the poll interval, so REST remains a controlled fallback: if the stream is
   * dead, silent, or lying by omission, the loop still polls on its own cadence. The stream can
   * only ever make the answer arrive sooner.
   */
  private async sleepOrObservation(ms: number, clientOrderId: string): Promise<void> {
    // Edge-not-lost: consume a latched observation that arrived before this wait was entered.
    if (this.pendingObservation.delete(clientOrderId)) return;
    let waiters = this.orderWaiters.get(clientOrderId);
    if (!waiters) {
      waiters = new Set();
      this.orderWaiters.set(clientOrderId, waiters);
    }
    let wake: () => void = () => {};
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    waiters.add(wake);
    try {
      await Promise.race([sleep(ms), woken]);
    } finally {
      waiters.delete(wake);
      if (waiters.size === 0) this.orderWaiters.delete(clientOrderId);
    }
  }

  /** Wake every waiter on one order. Called after an external observation is merged. */
  private wakeOrderWaiters(clientOrderId: string): void {
    const waiters = this.orderWaiters.get(clientOrderId);
    if (!waiters || waiters.size === 0) {
      // Latch the edge for the next wait: the observation already updated the session snapshot.
      this.pendingObservation.add(clientOrderId);
      return;
    }
    for (const wake of [...waiters]) {
      try { wake(); } catch { /* a waiter must never break the ingestion path */ }
    }
  }

  /**
   * APPLY ONE EXTERNAL ORDER OBSERVATION (a websocket order update).
   *
   * Routed through the SAME evidence validation as a REST snapshot
   * (brokerExecutionEvidence.ts): a stream is a FASTER source, never a more trusted one. So a
   * stream event with a terminal-looking status but no cumulative quantity cannot terminalise an
   * order, and an unpriced fill is recorded as unpriced rather than as free.
   *
   * MONOTONIC. A cumulative quantity below what is already proven is discarded outright — out-of-
   * order stream delivery and overlapping REST reads are normal, and neither may rewind exposure.
   *
   * PROMPT. The merged snapshot is stored and every waiter on this order is woken, so
   * `waitForResolution` returns on the event instead of on the next poll interval.
   */
  applyOrderUpdate(update: ExternalOrderUpdate): BrokerOrder | undefined {
    const known = this.orders.get(update.clientOrderId);
    if (!known) {
      this.streamObservationsIgnored++;
      return undefined;
    }
    const observedQuantity = readNonNegativeInteger(update.cumulativeQty);
    const observedPrice = readPositivePrice(update.averagePrice ?? null);
    const label = String(update.rawStatus ?? "");
    const claimedState = dhanOrderState(label, observedQuantity.value ?? known.filled_quantity, known.quantity);
    const verdict = evaluateExecutionEvidence({
      statusLabel: label,
      claimedState,
      requestedQuantity: known.quantity,
      priorFilled: known.filled_quantity,
      quantity: observedQuantity,
      price: observedPrice,
    });

    // A regression carries no new QUANTITY. It may still carry a newer STATUS: Dhan can report
    // `CANCELLED` with `TradedQty` reflecting a pre-fill snapshot, and a REST poll can overtake a
    // stream alert and arrive with an older figure on a newer label. Discarding the whole observation
    // (which is what the early return below used to do) threw away the CANCELLATION of the remainder
    // along with the stale number, leaving the order "working" in the snapshot with its waiters never
    // woken. So the quantity is PINNED to what we already hold — never rewound — and the label is
    // resolved against that accepted quantity.
    const observedFilled = observedQuantity.present ? (observedQuantity.value ?? 0) : null;
    const regressed = observedFilled !== null && observedFilled < known.filled_quantity;
    const at = update.observedAtWall ?? Date.now();

    // The candidate is RAW-FAITHFUL — it reports exactly what THIS observation said — and
    // `mergeBrokerOrderSnapshot` applies the monotonic quantity floor, the price rule, the terminal
    // guard and the fill-record rule. Stream and REST now share one implementation of that
    // authority, which is what stops the two paths from disagreeing.
    const candidate: BrokerOrder = cloneOrder(known);
    candidate.filled_quantity = observedFilled ?? verdict.filledQuantity;
    candidate.pending_quantity = Math.max(0, known.quantity - candidate.filled_quantity);
    candidate.average_price = verdict.averagePrice;
    candidate.execution_evidence = verdict.quality;
    if (update.brokerOrderId) candidate.broker_order_id = update.brokerOrderId;
    // The state is re-derived from the OBSERVED quantity, exactly as `project()` does, so a
    // contradictory label (TRADED with a short fill, CANCELLED with a fill) resolves the same way
    // whichever source reported it.
    candidate.state = verdict.sufficient
      ? dhanOrderState(label, candidate.filled_quantity, known.quantity)
      : known.state;
    if (!verdict.sufficient) candidate.reject_reason = verdict.detail;
    candidate.fills = candidate.filled_quantity > 0
      ? [{
        fill_id: `dhan:stream:${candidate.broker_order_id ?? update.clientOrderId}:${candidate.filled_quantity}:${verdict.averagePrice ?? "unpriced"}`,
        quantity: candidate.filled_quantity,
        price: verdict.averagePrice,
        at,
      }]
      : [];
    candidate.updated_at = at;

    const merged = mergeBrokerOrderSnapshot(known, candidate, { observedCumulativeQty: observedFilled });
    // When the quantity went backwards AND nothing else moved, the observation genuinely carries
    // nothing on any track. Only then is it ignored outright.
    if (regressed && merged.order.state === known.state && merged.order.filled_quantity === known.filled_quantity) {
      this.streamObservationsIgnored++;
      return cloneOrder(known);
    }
    this.orders.set(update.clientOrderId, merged.order);
    if (merged.order.broker_order_id) {
      this.clientByBroker.set(merged.order.broker_order_id, update.clientOrderId);
    }
    this.streamObservationsApplied++;
    this.markFill(update.clientOrderId, merged.order.filled_quantity);
    this.wakeOrderWaiters(update.clientOrderId);
    return cloneOrder(merged.order);
  }

  /** How many external (stream) observations this session applied vs ignored. */
  streamObservationStats(): { applied: number; ignored: number } {
    return { applied: this.streamObservationsApplied, ignored: this.streamObservationsIgnored };
  }

  /** The MONOTONIC clock in force for elapsed/deadline measurement (Defect D). */
  private mono(): number {
    return (this.cfg.monotonic ?? monotonicNow)();
  }

  /**
   * An absolute end-to-end budget for one order mutation, or undefined when none is configured.
   *
   * Created by the CALLER before `this.call(...)`, so the adapter's own transport-pacer wait is
   * inside the budget rather than beside it.
   */
  private mutationDeadline(): Deadline | undefined {
    const budget = this.cfg.orderMutationDeadlineMs;
    if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return undefined;
    return Deadline.in(budget, () => this.mono());
  }

  /**
   * Paced transport. `klass` is the broker-metered endpoint class; it selects both the pacing
   * bucket and — for order endpoints — the shared {@link RateBudgetLedger}. The PLACEMENT check
   * rides the pre-wire boundary (`beforeSend`), not here. RECOVERY endpoints (cancel/modify) have
   * no such hook, so they are gated here immediately before the transport call.
   */
  private call<T>(op: () => Promise<T>, klass: BrokerEndpointClass = "data_read"): Promise<T> {
    return this.pacer.run(op, dhanPacingClassFor(klass), {
      // SHARED FIX, BOTH BROKERS. The pacer no longer serves a single FIFO chain, so a cancel must
      // declare itself risk-reducing to be dispatched ahead of routine reads. Dhan is affected by
      // the same defect for the same reason — the pacer is shared — so it gets the same tiering
      // rather than being left on the old ordering.
      urgency: dhanUrgencyFor(klass),
      // Charged at ACTUAL DISPATCH rather than at enqueue, so a cancel that is abandoned in the
      // queue does not permanently consume recovery budget the broker never saw spent.
      ...(klass === "order_cancel" || klass === "order_modify"
        ? { beforeDispatch: () => this.reserveRecoveryBudgetOrThrow(klass) }
        : {}),
    });
  }

  /** Fast pre-pacing refusal: throw immediately if the shared placement budget is already spent. */
  private refusePlacementIfBudgetExhausted(clientOrderId: string): void {
    const ledger = this.cfg.rateBudget;
    if (!ledger) return;
    const decision = ledger.check("order_place", this.mono());
    if (!decision.allowed) {
      ledger.noteRefusal("order_place");
      throw new BrokerPreSubmitRefusedError(
        clientOrderId,
        "pre_post",
        true,
        `order budget exhausted: ${decision.reason}`,
      );
    }
  }

  /** The send-boundary placement guard: check+record, throwing a proven no-POST when refused. */
  private placementBudgetGuard(clientOrderId: string): () => void {
    const ledger = this.cfg.rateBudget;
    if (!ledger) return () => undefined;
    return () => {
      const now = this.mono();
      const decision = ledger.check("order_place", now);
      if (!decision.allowed) {
        ledger.noteRefusal("order_place");
        throw new BrokerPreSubmitRefusedError(
          clientOrderId,
          "pre_post",
          true,
          `order budget exhausted: ${decision.reason}`,
        );
      }
      ledger.record("order_place", now);
    };
  }

  /** Gate a recovery mutation (cancel/modify) against the reserve; throw before any wire use. */
  private reserveRecoveryBudgetOrThrow(klass: "order_cancel" | "order_modify"): void {
    const ledger = this.cfg.rateBudget;
    if (!ledger) return;
    const now = this.mono();
    const decision = ledger.check(klass, now);
    if (!decision.allowed) {
      ledger.noteRefusal(klass);
      throw new BrokerPreSubmitRefusedError(
        "recovery",
        "pre_post",
        false,
        `recovery budget unavailable: ${decision.reason}`,
      );
    }
    ledger.record(klass, now);
  }

  /** Feed a 429 to the shared budget as a cooldown WITHOUT ever resending. */
  private penalizeIfRateLimited(error: unknown): void {
    const ledger = this.cfg.rateBudget;
    if (!ledger) return;
    if (error instanceof DhanRateLimitError) {
      const retryAfterMs =
        typeof error.retryAfterSec === "number" && Number.isFinite(error.retryAfterSec) && error.retryAfterSec > 0
          ? error.retryAfterSec * 1_000
          : null;
      ledger.penalize(this.mono(), retryAfterMs);
      return;
    }
    const status = error instanceof DhanError ? error.status : null;
    if (isRateLimited(status)) ledger.penalize(this.mono(), null);
  }

  /** Attach the deterministic correlation id. Pure — no transport. */
  prepareOrder(req: BrokerOrderRequest): BrokerOrderRequest {
    const correlation = this.correlationFor(req.client_order_id);
    if (!isValidDhanCorrelationId(correlation)) {
      // Refuse rather than send something Dhan will mangle: a truncated correlation
      // id would break reconciliation, which is the one thing that must not fail.
      throw new Error(`Derived Dhan correlationId "${correlation}" is invalid for ${req.client_order_id}.`);
    }
    return { ...req, tag: correlation };
  }

  async submitOrder(req: BrokerOrderRequest, beforePost?: BeforeBrokerPost): Promise<BrokerOrder> {
    this.ensureTradingReady();
    // Bounded LIMIT, always. This is what stops Box from ever placing a MARKET order.
    assertBoundedLimit(req, this.cfg.maxChaseTicks);

    // In-session idempotency: an already-known client id returns its current state
    // rather than producing a second order.
    const existing = this.orders.get(req.client_order_id);
    if (existing) return cloneOrder(existing);

    const identity = this.cfg.identify(req.token);
    if (!identity) {
      throw new Error(`No Dhan security id for token ${req.token} (${req.tradingsymbol}).`);
    }
    const correlationId = this.correlationFor(req.client_order_id);
    const order = fromRequest(req, Date.now(), correlationId);
    order.state = "SUBMITTING";
    this.orders.set(req.client_order_id, order);
    this.clientByCorrelation.set(correlationId, req.client_order_id);

    let placed: { orderId: string; orderStatus: DhanOrderStatus } | null = null;
    // TRANSPORT START: before `call()`, so the pacing wait is attributed to transport_wait_ms
    // rather than being hidden inside the POST duration.
    this.mark(req.client_order_id, "transport_started");
    // Fires exactly once, at the FINAL SYNCHRONOUS instant before the wire (Defect 3): the guard
    // is threaded THROUGH the adapter pacer AND the lower Dhan HTTP pacing queue to
    // http.request()'s send boundary, closing the window where a queued POST could fire after
    // entry was disarmed. `http_request_started` is marked here because this is the true moment
    // the POST leaves for the network; a thrown BrokerPreSubmitRefusedError proves it never did.
    const beforeSend = (): void => {
      beforePost?.();
      // ORDER BUDGET (Task 8): authoritative check+record at the FINAL pre-wire instant. An
      // over-budget placement throws BrokerPreSubmitRefusedError here — before any HTTP request —
      // so budget is consumed only for a request that actually leaves. No-op without a ledger.
      placementGuard();
      this.mark(req.client_order_id, "http_request_started");
    };
    // ABSOLUTE END-TO-END BUDGET, started BEFORE the transport pacer (Defect D). The pacer wait,
    // the lower HTTP pacing queue, the network round trip and the body read share this one budget;
    // an expiry while queued releases the caller promptly and provably transmits nothing.
    const mutationDeadline = this.mutationDeadline();
    // The send-boundary placement guard, resolved once so the SAME closure runs at the boundary.
    const placementGuard = this.placementBudgetGuard(req.client_order_id);
    try {
      // FAST REFUSAL: refuse an already-exhausted budget before the pacing wait, so an over-budget
      // entry does not sit through a pacing interval only to be refused at the wire. Caught below
      // and cleaned up like any pre-submit refusal.
      this.refusePlacementIfBudgetExhausted(req.client_order_id);
      placed = await this.call(() => {
        return this.client.placeOrder({
          dhanClientId: this.cfg.dhanClientId(),
          correlationId,
          transactionType: req.side,
          exchangeSegment: identity.segment,
          // F&O carry-forward. NOT INTRADAY, which would be auto-squared-off.
          productType: "MARGIN",
          orderType: "LIMIT",
          validity: "DAY",
          securityId: String(identity.securityId),
          quantity: req.quantity,
          price: req.pricing.limit_price,
        }, { beforeSend, ...(mutationDeadline ? { deadline: mutationDeadline } : {}) });
      }, "order_place");
      this.mark(req.client_order_id, "http_response");
    } catch (err) {
      if (err instanceof BrokerPreSubmitRefusedError) {
        // No HTTP request started and therefore no correlation lookup is needed.
        this.orders.delete(req.client_order_id);
        this.clientByCorrelation.delete(correlationId);
        throw err;
      }
      // A 429 feeds the shared budget a cooldown (never a resend). Done before classification so
      // the cooldown is recorded even on the ambiguous reconcile path below.
      this.penalizeIfRateLimited(err);
      // Recorded on the failure path too: a timeout's duration is only measurable if the
      // response event is marked whether or not it succeeded.
      this.mark(req.client_order_id, "http_response");

      // PROVEN NO-POST vs AMBIGUITY (Defect D). A deadline that expired while the write sat in a
      // queue was abandoned INSIDE this process before `fetch` was ever called, so there is
      // categorically nothing at the broker to reconcile. Treating it as ambiguous would spend a
      // broker read and a rate-budget slot to discover something already known, and would leave the
      // attempt quarantined as RECONCILIATION_REQUIRED when it is simply a refusal. The transport
      // only sets `transmitted: false` when it can prove the wire was never used.
      if (err instanceof DhanNetworkError && err.transmitted === false) {
        this.orders.delete(req.client_order_id);
        this.clientByCorrelation.delete(correlationId);
        throw new BrokerPreSubmitRefusedError(req.client_order_id, "pre_post", true, err.message);
      }
      // A DEFINITIVE 4xx (not 429) means Dhan understood and refused.
      if (err instanceof DhanError && err.isDefinitive && !(err instanceof DhanRateLimitError)) {
        // Merged, not written blind: if a fill was observed on the stream while the POST was in
        // flight, a bare REJECTED would erase real exposure. The merge routes that contradiction to
        // RECONCILIATION_REQUIRED instead of silently choosing one side.
        const rejected = this.commit(req.client_order_id, {
          ...cloneOrder(this.orders.get(req.client_order_id) ?? order),
          state: "REJECTED",
          reject_family: err instanceof DhanAuthError ? "auth" : classifyDhanReject(err.code, err.message),
          reject_reason: err.message,
          updated_at: Date.now(),
        });
        // ...AND THE MERGE'S VERDICT IS THE ONE THAT TRAVELS. Identical reasoning to Kite's
        // definitive-rejection path: an unconditional `BrokerOrderRejectedError` here would hand
        // the gateway a no-exposure certificate for a snapshot the merge just flagged as
        // contradictory, and recovery would unwind the hedges protecting it. This is also the
        // rule Dhan's own post-place verification path already applied below ("a REJECTED label
        // with a verified ZERO fill"), now shared rather than re-stated.
        throw brokerRejectionOutcome(cloneOrder(rejected), err);
      }

      // AMBIGUOUS. The order may be live. Reconcile by correlation id — never
      // re-POST. This is the single most important branch in this file.
      const reconciled = await this.reconcileByCorrelation(req, correlationId).catch(() => null);
      if (reconciled) {
        const accepted = this.commit(req.client_order_id, reconciled.order, reconciled.options);
        // The order DOES exist; carry on with its real state.
        return this.waitForResolution(req.client_order_id, accepted);
      }
      // Could not prove either way: quarantine for the durable reconciler.
      const reason = err instanceof Error ? err.message : String(err);
      const quarantined = this.quarantine(req.client_order_id, order, reason);
      throw new BrokerAmbiguousSubmitError(
        req.client_order_id,
        `Dhan order submission outcome is unknown and correlation lookup did not resolve it: ${reason}`,
        err,
        cloneOrder(quarantined),
      );
    }

    if (!placed?.orderId) {
      // A 200 with no order id is ambiguous too, and gets the same treatment.
      const reconciled = await this.reconcileByCorrelation(req, correlationId).catch(() => null);
      if (reconciled) {
        const accepted = this.commit(req.client_order_id, reconciled.order, reconciled.options);
        return this.waitForResolution(req.client_order_id, accepted);
      }
      const reason = "Dhan accepted the request but returned no orderId.";
      const quarantined = this.quarantine(req.client_order_id, order, reason);
      throw new BrokerAmbiguousSubmitError(req.client_order_id, reason, placed, cloneOrder(quarantined));
    }

    order.broker_order_id = placed.orderId;
    order.updated_at = Date.now();
    // Two distinct facts: an order id proves the order EXISTS; the ACK proves Dhan ACCEPTED it.
    // Neither proves any quantity executed.
    this.mark(req.client_order_id, "broker_order_id");
    this.mark(req.client_order_id, "acknowledged");
    this.clientByBroker.set(placed.orderId, req.client_order_id);

    // DEFECT 2 — a placement STATUS STRING is NOT an execution record.
    //
    // Dhan's POST /orders answers with only `{orderId, orderStatus}` — it carries NO cumulative
    // filled quantity and NO average price. The previous code did
    // `dhanOrderState(status, 0, quantity)`, which turned an immediate "TRADED" into COMPLETE
    // with filled_quantity 0: a fully-accounted terminal execution invented from a label and a
    // hardcoded zero, with no order-status or trade-book read behind it. P&L and recovery then
    // trusted a fill that was never observed.
    //
    // So the placement label only ever seeds a PROVISIONAL, non-terminal state here; the
    // authoritative quantity and price come from an order/trade read. A label that CLAIMS a
    // terminal outcome (TRADED / PART_TRADED / CANCELLED / CLOSED / EXPIRED / REJECTED) is
    // VERIFIED, never accepted:
    //   - verified evidence  → the real state, with real cumulative qty and avg price;
    //   - no evidence yet     → keep waiting/polling (non-terminal), never COMPLETE-with-0;
    //   - evidence impossible → RECONCILIATION_REQUIRED, blocking dependent entries, rather
    //                           than collapsing to a guessed COMPLETE or a guessed REJECTED.
    const claimsTerminal = isBrokerOrderTerminal(dhanOrderState(placed.orderStatus, 0, req.quantity))
      || dhanOrderState(placed.orderStatus, 0, req.quantity) === "PARTIALLY_FILLED";

    if (claimsTerminal) {
      // Ask for authoritative evidence. A TRADED label with no verified quantity must never
      // become a fully accounted execution on the label alone.
      // `refresh` now commits its own merge, so `verified` IS the accepted state; the explicit
      // `orders.set` calls that used to follow each branch would have re-written an already-merged
      // value and are gone.
      const verified = await this.refresh(req.client_order_id).catch(() => undefined);
      if (verified && this.hasAuthoritativeQuantity(verified, placed.orderStatus)) {
        // Reconcile contradictions here too: `project()` already re-derives the state from the
        // OBSERVED filled quantity, so a "CANCELLED with a nonzero fill" surfaces as a real
        // partial and a "TRADED with a short fill" as PARTIALLY_FILLED rather than COMPLETE.
        if (verified.state === "REJECTED") {
          // Through the shared guard, so a REJECTED read that somehow still carries a fill cannot
          // become a no-exposure certificate here either.
          throw brokerRejectionOutcome(cloneOrder(verified), placed);
        }
        return this.waitForResolution(req.client_order_id, verified);
      }
      // A REJECTED label with a verified ZERO fill is genuinely terminal and carries no
      // exposure, so it is safe to accept as a rejection — but only once the read has CONFIRMED
      // the zero, not merely inferred it from the label.
      if (verified && verified.state === "REJECTED" && verified.filled_quantity === 0) {
        // The pre-existing zero check is kept as the branch CONDITION (it decides whether this is
        // the "accept the rejection" case at all) and the shared guard re-proves it on the way out,
        // so this site and the definitive-4xx site above cannot drift apart again.
        throw brokerRejectionOutcome(cloneOrder(verified), placed);
      }
      // EVIDENCE NOT YET VISIBLE: the read SUCCEEDED and PROJECTED a genuine working state (the
      // trade has not propagated to the order book yet). This is the "keep waiting" case, NOT the
      // "give up" case — poll to a VERIFIED terminal outcome, where every quantity comes from an
      // order/trade read. A read that FAILED leaves the order in its pre-broker SUBMITTING state
      // (refresh returns the unchanged projection), which is NOT evidence and falls through to
      // the quarantine below.
      const projectedAWorkingState =
        verified
        && !isBrokerOrderTerminal(verified.state)
        && (verified.state === "OPEN"
          || verified.state === "ACKNOWLEDGED"
          || verified.state === "PARTIALLY_FILLED");
      if (projectedAWorkingState) {
        return this.waitForResolution(req.client_order_id, verified);
      }
      // Could not obtain authoritative quantity/price for a terminal-looking placement — either
      // the read failed outright, or it returned a terminal label we could not substantiate with
      // a quantity/price. RETAIN UNCERTAINTY: quarantine so dependent entries are blocked, rather
      // than fabricating a fill or a rejection. The durable reconciler resolves it against
      // confirmed evidence.
      const reason =
        `Dhan reported '${placed.orderStatus}' at placement but no authoritative cumulative quantity/price could be read; ` +
        "the execution is unproven and must be reconciled before any dependent leg.";
      const quarantined = this.quarantine(req.client_order_id, order, reason);
      throw new BrokerAmbiguousSubmitError(req.client_order_id, reason, placed, cloneOrder(quarantined));
    }

    // A non-terminal placement (TRANSIT / PENDING): the order is working. Seed the provisional
    // acknowledged/open state and let waitForResolution poll to a VERIFIED terminal outcome,
    // where every quantity comes from an order/trade read via project().
    //
    // COMMITTED THROUGH THE MAP. `order` was built before the POST; a socket fill that arrived while
    // the POST response was in flight is already merged into the map entry, and writing `order`
    // blind would replace it with "ACKNOWLEDGED/OPEN, filled 0". The placement label is a WORKING
    // state, so the merge cannot use it to rewind a stream-confirmed terminal state either.
    const acknowledged = this.commit(req.client_order_id, {
      ...cloneOrder(order),
      state: dhanOrderState(placed.orderStatus, 0, req.quantity),
      updated_at: Date.now(),
    });
    return this.waitForResolution(req.client_order_id, acknowledged);
  }

  /**
   * Move the LATEST accepted state to RECONCILIATION_REQUIRED.
   *
   * A confirmed TERMINAL state is left alone: quarantining an order the broker has already resolved
   * would manufacture uncertainty and send a settled order back through recovery.
   */
  private quarantine(clientOrderId: string, fallback: BrokerOrder, reason: string): BrokerOrder {
    const current = this.orders.get(clientOrderId) ?? fallback;
    if (isBrokerOrderTerminal(current.state)) return current;
    return this.commit(clientOrderId, {
      ...cloneOrder(current),
      state: "RECONCILIATION_REQUIRED",
      reject_reason: reason,
      updated_at: Date.now(),
    });
  }

  /**
   * Whether a refreshed order carries the authoritative evidence needed to ACCOUNT for a
   * terminal execution (Defect 2).
   *
   * The distinction the old code missed is between a MISSING quantity and an EXPLICITLY
   * VERIFIED ZERO. A read that returns a COMPLETE-family state must also carry a positive
   * cumulative fill AND an average price before we treat it as executed; a CANCELLED/REJECTED
   * read with a confirmed zero fill is authoritative in the other direction (nothing executed).
   * Anything else — a "TRADED" read that still shows 0 filled, or one with no average price —
   * is NOT yet proof and keeps the order uncertain.
   */
  private hasAuthoritativeQuantity(verified: BrokerOrder, placedStatus: DhanOrderStatus | string): boolean {
    // A working (non-terminal) read is not the evidence we need for a terminal claim; keep
    // polling instead.
    if (!isBrokerOrderTerminal(verified.state) && verified.state !== "PARTIALLY_FILLED") return false;
    // Executed states demand a positive, priced fill.
    if (verified.state === "COMPLETE" || verified.state === "PARTIALLY_FILLED") {
      return verified.filled_quantity > 0 && verified.average_price !== null && verified.average_price > 0;
    }
    // CANCELLED after a claimed terminal: authoritative only when the fill is a CONFIRMED zero,
    // or a positive priced partial (a "CANCELLED with a nonzero fill" that project() surfaced).
    if (verified.state === "CANCELLED") {
      if (verified.filled_quantity === 0) return true;
      return verified.average_price !== null && verified.average_price > 0;
    }
    // REJECTED is handled by the caller (a confirmed zero-fill rejection is terminal); a
    // rejection with a claimed fill is contradictory and stays uncertain.
    if (verified.state === "REJECTED") return verified.filled_quantity === 0;
    void placedStatus;
    return false;
  }

  /**
   * Ask Dhan whether our correlation id exists — the anti-duplicate primitive.
   *
   * Returns the projected order when Dhan knows it, or null when Dhan reports no
   * such order (meaning the submission genuinely never landed).
   */
  private async reconcileByCorrelation(
    req: BrokerOrderRequest,
    correlationId: string,
  ): Promise<{ order: BrokerOrder; options: BrokerOrderMergeOptions } | null> {
    const found = await this.call(() => this.client.getOrderByCorrelationId(correlationId));
    if (!found) return null;
    const fills = await this.fetchFills(found.orderId);
    // ── NO AWAIT BEYOND THIS POINT ─────────────────────────────────────────────────────────────
    // The template used to be the REQUEST, whose `priorFilled` is 0, so this path had NO monotonic
    // floor at all: a lookup that came back with a lower (or absent) quantity than a stream event had
    // already proven would silently reduce exposure. The template is now the latest ACCEPTED state
    // when there is one, re-read after both awaits.
    const template = this.orders.get(req.client_order_id) ?? req;
    return {
      order: this.project(template, found, correlationId, fills),
      options: { observedCumulativeQty: readCumulativeQuantity(found).value },
    };
  }

  /** Poll until terminal, then protectively cancel if the deadline passes. */
  private async waitForResolution(clientOrderId: string, initial: BrokerOrder): Promise<BrokerOrder> {
    let current = initial;
    // MONOTONIC (Defect D): these are DURATIONS, and a wall-clock step must never shorten or
    // lengthen a deadline that decides whether an order is protectively cancelled.
    const startedAt = this.mono();
    let firstPartialAt: number | null = current.filled_quantity > 0 ? startedAt : null;

    // Hard iteration cap in addition to the wall-clock deadlines. A broker that keeps
    // answering "still working" without the clock advancing as expected must not be
    // able to spin this loop indefinitely and wedge the order path.
    const maxPolls = Math.max(
      10,
      Math.ceil((this.cfg.workingTimeoutMs + this.cfg.partialTimeoutMs) / Math.max(1, this.cfg.brokerMinIntervalMs)) + 10,
    );
    let polls = 0;

    while (!isBrokerOrderTerminal(current.state)) {
      if (++polls > maxPolls) {
        // Out of budget without a terminal answer: quarantine rather than guess.
        return this.protectiveCancelAndConfirm(clientOrderId, current);
      }
      const elapsed = this.mono() - startedAt;
      const ackDeadlineHit = current.state === "ACKNOWLEDGED" && elapsed > this.cfg.ackTimeoutMs;
      const workingDeadlineHit = elapsed > this.cfg.workingTimeoutMs;
      const partialDeadlineHit =
        firstPartialAt !== null && this.mono() - firstPartialAt > this.cfg.partialTimeoutMs;

      if (ackDeadlineHit || workingDeadlineHit || partialDeadlineHit) {
        return this.protectiveCancelAndConfirm(clientOrderId, current);
      }
      // WAKE ON THE EVENT, fall back on the interval. A stream observation resolves this sleep
      // immediately; with no stream (or a silent one) the poll cadence is exactly as before, so
      // REST stays a controlled fallback rather than being replaced.
      await this.sleepOrObservation(this.cfg.brokerMinIntervalMs, clientOrderId);
      // A stream observation may have already updated this order's session snapshot (and woken us)
      // through applyOrderUpdate. That snapshot is authoritative and cumulative-monotonic, so adopt
      // it FIRST; if it is now terminal the fill was seen on the event, and a REST re-poll would
      // only risk overwriting a fresh terminal state with a staler snapshot — so skip it.
      const observed = this.orders.get(clientOrderId);
      if (observed && observed !== current) {
        current = observed;
        if (isBrokerOrderTerminal(current.state)) break;
      }
      const refreshed = await this.refresh(clientOrderId);
      if (!refreshed) break;
      current = refreshed;
      if (current.filled_quantity > 0 && firstPartialAt === null) firstPartialAt = this.mono();
    }
    return cloneOrder(current);
  }

  /**
   * Cancel, then CONFIRM the terminal state.
   *
   * A cancel request is not a cancellation: the order can fill in the same instant.
   * So the state is only accepted once Dhan reports something terminal; otherwise the
   * order is quarantined as RECONCILIATION_REQUIRED rather than assumed cancelled.
   */
  private async protectiveCancelAndConfirm(
    clientOrderId: string,
    current: BrokerOrder,
  ): Promise<BrokerOrder> {
    const order = this.orders.get(clientOrderId) ?? current;
    if (order.broker_order_id) {
      const brokerOrderId = order.broker_order_id;
      // Written THROUGH the map rather than mutated in place: an in-place mutation would apply to a
      // detached object if a stream observation replaced the map entry during the DELETE below.
      this.commit(clientOrderId, { ...cloneOrder(order), state: "CANCEL_REQUESTED", updated_at: Date.now() });
      // CANCEL REQUESTED. Opens cancel_request_to_terminal_ms — the measured span that sizes
      // paper's cancel-vs-fill race window. Marked before the DELETE, because the race begins the
      // moment we commit to cancelling.
      this.mark(clientOrderId, "cancel_requested");
      try {
        await this.call(
          () => this.client.cancelOrder(brokerOrderId, {
            // A protective cancel is bounded by its OWN confirmation window, started here so the
            // pacer wait counts against it (Defect D).
            deadline: Deadline.in(this.cfg.cancelTimeoutMs, () => this.mono()),
          }),
          "order_cancel",
        );
        // Dhan accepted the cancel REQUEST. Not a cancellation: the loop below keeps confirming
        // precisely because the order may be filling right now.
        this.mark(clientOrderId, "cancel_acknowledged");
      } catch (err) {
        // A cancel that fails does not make the order gone; keep confirming. A 429 still feeds the
        // shared budget a cooldown so we do not send more requests into a throttle.
        this.penalizeIfRateLimited(err);
        console.warn(`[Dhan] protective cancel failed for ${clientOrderId}:`, err);
      }
    }
    // MONOTONIC (Defect D). A protective cancel's confirmation window is a safety deadline.
    const cancelDeadlineAt = this.mono() + this.cfg.cancelTimeoutMs;
    const maxConfirmPolls = Math.max(
      5,
      Math.ceil(this.cfg.cancelTimeoutMs / Math.max(1, this.cfg.brokerMinIntervalMs)) + 5,
    );
    let confirmPolls = 0;
    while (this.mono() < cancelDeadlineAt && confirmPolls < maxConfirmPolls) {
      confirmPolls++;
      // A cancel races a fill; a stream event telling us which won must not wait out a poll.
      await this.sleepOrObservation(this.cfg.brokerMinIntervalMs, clientOrderId);
      const refreshed = await this.refresh(clientOrderId);
      if (refreshed && isBrokerOrderTerminal(refreshed.state)) return cloneOrder(refreshed);
    }
    // A stream event may have confirmed a terminal outcome between the last poll and here; the
    // quarantine helper leaves a confirmed terminal state alone rather than manufacturing doubt.
    return cloneOrder(this.quarantine(
      clientOrderId,
      order,
      "Dhan did not confirm a terminal state after a protective cancel within the deadline.",
    ));
  }

  /**
   * Mark a timing stage. FAIL-OPEN and silent when instrumentation is off or the order has no
   * trace — a metrics failure must never interfere with an order, least of all a cancel.
   */
  private mark(clientOrderId: string, stage: Parameters<ExecutionTimingRecorder["mark"]>[1]): void {
    try {
      this.cfg.timing?.mark(clientOrderId, stage);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /** Record an observed CUMULATIVE filled quantity. Fail-open; increases only. */
  private markFill(clientOrderId: string, cumulativeQty: number): void {
    try {
      this.cfg.timing?.markFill(clientOrderId, cumulativeQty);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /**
   * COMMIT ONE OBSERVATION — the ONLY way a REST path may write the session projection.
   *
   * See kiteBrokerAdapter.commit and brokerOrderMerge.ts. The read-merge-write below contains NO
   * `await`, so it runs in a single JS tick and is atomic with respect to `applyOrderUpdate`.
   * Dhan needed this most: `refresh` spans TWO awaits (the order read and the trade-book read), so
   * its window for a lost update was the widest in the codebase, and its previous monotonic guard
   * compared against a `known` captured before both of them.
   */
  private commit(
    clientOrderId: string,
    candidate: BrokerOrder,
    options?: BrokerOrderMergeOptions,
  ): BrokerOrder {
    const merged = mergeBrokerOrderSnapshot(this.orders.get(clientOrderId), candidate, options);
    this.orders.set(clientOrderId, merged.order);
    if (merged.conflict !== null) {
      // NEVER SILENT — see the Kite adapter's counterpart for the reasoning.
      console.warn(`[Dhan] execution evidence conflict for ${clientOrderId}: ${merged.conflict}`);
    }
    // A CONFLICTING broker id is deliberately NOT registered: it belongs to a different broker order.
    if (merged.order.broker_order_id && merged.conflict === null) {
      this.clientByBroker.set(merged.order.broker_order_id, clientOrderId);
    }
    // TIMING: the broker's CUMULATIVE quantity. The recorder ignores anything that is not an
    // increase, so re-polling an unchanged order manufactures no extra "fill" events.
    this.markFill(clientOrderId, merged.order.filled_quantity);
    return merged.order;
  }

  /** Re-read one order and merge the result into the session projection. */
  private async refresh(clientOrderId: string): Promise<BrokerOrder | undefined> {
    const known = this.orders.get(clientOrderId);
    if (!known) return undefined;
    try {
      const remote = known.broker_order_id
        ? await this.call(() => this.client.getOrder(known.broker_order_id!))
        : await this.call(() => this.client.getOrderByCorrelationId(this.correlationFor(clientOrderId)));
      if (!remote) {
        // MISSING-RESPONSE BRANCH: return the LATEST accepted state, not the pre-await snapshot.
        return this.orders.get(clientOrderId) ?? known;
      }
      const fills = await this.fetchFills(remote.orderId);
      // ── NO AWAIT BEYOND THIS POINT ─────────────────────────────────────────────────────────
      // Re-read AFTER both awaits. This is both the merge BASE (so `priorFilled` is current, which
      // is what makes the evidence reader's monotonic floor meaningful) and the write target.
      const current = this.orders.get(clientOrderId) ?? known;
      const projected = this.project(current, remote, current.tag ?? this.correlationFor(clientOrderId), fills);
      // The RAW reading is handed to the merge so a payload describing a smaller fill cannot donate
      // its average price to a larger accepted cumulative quantity. This replaces the old inline
      // monotonic block, which compared against a snapshot captured two awaits earlier.
      return this.commit(clientOrderId, projected, {
        observedCumulativeQty: readCumulativeQuantity(remote).value,
      });
    } catch (err) {
      if (err instanceof DhanAuthError) throw err;
      // A transient read failure must not rewrite state — and must not report a PRE-AWAIT snapshot
      // as current, which would discard a stream observation applied during the failed read.
      return this.orders.get(clientOrderId) ?? known;
    }
  }

  /**
   * Per-fill detail from the trade book.
   *
   * Best-effort: an order's aggregate quantity/average price is already authoritative
   * for exposure, so a trade-book hiccup degrades fill granularity rather than
   * blocking the order. Returns [] on failure.
   */
  private async fetchFills(orderId: string): Promise<DhanTrade[]> {
    try {
      return await this.call(() => this.client.getTradesForOrder(orderId));
    } catch {
      return [];
    }
  }

  /**
   * Project a Dhan order (+ fills) onto the broker-neutral shape.
   *
   * THE SINGLE FUNNEL for EVERY observation path — placement verification, REST polling,
   * correlation lookup, `listOrders`, restart adoption and (once consumed) websocket updates all
   * arrive here. So this is where execution evidence is validated, exactly once, for all of them.
   *
   * A MISSING cumulative quantity is not a zero (see brokerExecutionEvidence.ts). A terminal-looking
   * label that carries none cannot freeze accounting: it is projected as RECONCILIATION_REQUIRED
   * with the reason named, carrying forward the highest quantity already proven, so the durable
   * reconciler resolves it instead of a hardcoded zero doing so silently.
   */
  private project(
    template: Pick<
      BrokerOrder | BrokerOrderRequest,
      "client_order_id" | "role" | "trade_id" | "attempt_id" | "purpose" | "phase" | "exchange" | "tradingsymbol" | "token" | "side" | "quantity" | "pricing"
    >,
    remote: DhanOrder,
    correlationId: string,
    fills: DhanTrade[],
  ): BrokerOrder {
    const now = Date.now();
    const quantity = template.quantity;
    const priorFilled = "filled_quantity" in template && typeof template.filled_quantity === "number"
      ? template.filled_quantity
      : 0;

    const observedQuantity = readCumulativeQuantity(remote);
    const observedPrice = readTradedPrice(remote);
    // The label is mapped using the OBSERVED quantity when there is one, and the prior proven
    // quantity otherwise — never a fabricated zero, which is what turned TRADED into COMPLETE.
    const claimedState = dhanOrderState(remote.orderStatus, observedQuantity.value ?? priorFilled, quantity);
    const verdict = evaluateExecutionEvidence({
      statusLabel: String(remote.orderStatus ?? ""),
      claimedState,
      requestedQuantity: quantity,
      priorFilled,
      quantity: observedQuantity,
      price: observedPrice,
    });

    const filled = verdict.filledQuantity;
    // An insufficiently-evidenced terminal claim stays UNCERTAIN. Re-deriving the state from the
    // accepted quantity also reconciles contradictions (a "CANCELLED with a nonzero fill" surfaces
    // as a real partial; a "TRADED with a short fill" as PARTIALLY_FILLED, never COMPLETE).
    const state: BrokerOrderState = verdict.sufficient
      ? dhanOrderState(remote.orderStatus, filled, quantity)
      : "RECONCILIATION_REQUIRED";
    const remaining = remote.remainingQuantity !== undefined
      ? numberOr(remote.remainingQuantity, Math.max(0, quantity - filled))
      : Math.max(0, quantity - filled);
    const rejected = state === "REJECTED";

    return {
      client_order_id: template.client_order_id,
      broker_order_id: remote.orderId ?? null,
      tag: correlationId,
      role: template.role,
      trade_id: template.trade_id,
      attempt_id: template.attempt_id,
      purpose: template.purpose,
      phase: template.phase,
      exchange: template.exchange,
      tradingsymbol: remote.tradingSymbol || template.tradingsymbol,
      token: template.token,
      side: template.side,
      quantity,
      pricing: { ...template.pricing },
      limit_price: template.pricing.limit_price,
      state,
      filled_quantity: filled,
      pending_quantity: remaining,
      average_price: verdict.averagePrice,
      fills: fills.length > 0
        ? fills.map((t, index) => {
            const tradePrice = readPositivePrice(t.tradedPrice);
            return {
              fill_id: t.exchangeTradeId
                ? `dhan:${t.exchangeTradeId}`
                : `dhan:${remote.orderId}:${index}:${t.tradedQuantity}:${t.tradedPrice}`,
              quantity: numberOr(t.tradedQuantity, 0),
              // An unpublished trade price is NULL, never zero. Zero would be fabricated P&L.
              price: tradePrice.value,
              at: now,
            };
          })
        // No trade-book detail: synthesize ONE aggregate fill so exposure is still exact, matching
        // how the Kite adapter behaves. Its price is the OBSERVED average or null — the old code
        // used `numberOr(..., 0)` here, inventing a zero-cost execution.
        : filled > 0
          ? [{
              fill_id: `dhan:${remote.orderId}:${filled}:${verdict.averagePrice ?? "unpriced"}`,
              quantity: filled,
              price: verdict.averagePrice,
              at: now,
            }]
          : [],
      execution_evidence: verdict.quality,
      reject_family: rejected
        ? classifyDhanReject(remote.omsErrorCode ?? null, remote.omsErrorDescription ?? null)
        : null,
      reject_reason: rejected
        ? remote.omsErrorDescription ?? remote.omsErrorCode ?? "Dhan rejected the order."
        : verdict.detail,
      created_at: now,
      // OUR clock, always -- see BrokerOrder.updated_at. Dhan's own stamp is kept beside it.
    updated_at: now,
    exchange_updated_at: parseIstBrokerTimestamp(remote.exchangeTime ?? remote.updateTime),
    };
  }

  async cancelOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    this.ensureTradingReady();
    const known = this.orders.get(clientOrderId);
    if (!known) return undefined;
    if (isBrokerOrderTerminal(known.state)) return cloneOrder(known);
    return this.protectiveCancelAndConfirm(clientOrderId, known);
  }

  async modifyOrder(clientOrderId: string, request: BrokerModifyRequest): Promise<BrokerOrder> {
    this.ensureTradingReady();
    const known = this.orders.get(clientOrderId);
    if (!known) throw new Error(`Unknown Dhan order ${clientOrderId}.`);
    if (!known.broker_order_id) throw new Error(`Dhan order ${clientOrderId} has no broker id yet.`);

    // The modification cap is a safety limit on chasing, not a suggestion.
    const used = this.modifications.get(clientOrderId) ?? 0;
    if (used >= this.cfg.maxModifications) {
      throw new Error(
        `Dhan order ${clientOrderId} has reached its modification cap (${this.cfg.maxModifications}).`,
      );
    }
    // Re-validate the new price inside the ORIGINAL bounded envelope, so a
    // modification cannot walk the limit outside the configured chase band.
    assertBoundedLimit(
      {
        ...known,
        pricing: { ...known.pricing, limit_price: request.limit_price },
        quantity: request.quantity ?? known.quantity,
      } as BrokerOrderRequest,
      this.cfg.maxChaseTicks,
    );

    this.modifications.set(clientOrderId, used + 1);
    await this.call(() =>
      this.client.modifyOrder({
        dhanClientId: this.cfg.dhanClientId(),
        orderId: known.broker_order_id!,
        orderType: "LIMIT",
        price: request.limit_price,
        ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
        validity: "DAY",
      }),
      "order_modify",
    );
    // `known` is the PRE-AWAIT snapshot. The new limit price is applied to the LATEST accepted state
    // instead, so a fill observed during the modify round trip is not overwritten.
    const current = this.orders.get(clientOrderId) ?? known;
    const repriced = this.commit(clientOrderId, {
      ...cloneOrder(current),
      pricing: { ...current.pricing, limit_price: request.limit_price },
      limit_price: request.limit_price,
      updated_at: Date.now(),
    });
    const refreshed = await this.refresh(clientOrderId);
    return cloneOrder(refreshed ?? repriced);
  }

  async getOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    this.ensureEnabled();
    const refreshed = await this.refresh(clientOrderId);
    return refreshed ? cloneOrder(refreshed) : undefined;
  }

  async listOrders(): Promise<BrokerOrder[]> {
    this.ensureEnabled();
    const remote = await this.call(() => this.client.listOrders());
    // ── NO AWAIT BEYOND THIS POINT ─────────────────────────────────────────────────────────────
    // The map reads below are post-await, but the PAYLOAD predates any stream event that landed
    // during the round trip, and this loop previously wrote it back with no monotonic or terminal
    // guard at all. Every write now goes through the merge.
    const out: BrokerOrder[] = [];
    for (const order of remote) {
      const clientId =
        (order.correlationId && this.clientByCorrelation.get(order.correlationId)) ??
        this.clientByBroker.get(order.orderId);
      const known = clientId ? this.orders.get(clientId) : undefined;
      if (known) {
        const projected = this.project(known, order, known.tag ?? "", []);
        out.push(cloneOrder(this.commit(known.client_order_id, projected, {
          observedCumulativeQty: readCumulativeQuantity(order).value,
        })));
        continue;
      }
      // An order this session did not create. Surfaced with an explicit ORPHAN
      // identity so reconciliation can see it rather than silently ignoring
      // exposure that might be ours from a previous process.
      out.push(orphanOrder(order));
    }
    return out;
  }

  async listPositions(): Promise<BrokerPosition[]> {
    this.ensureEnabled();
    const remote = await this.call(() => this.client.listPositions());
    return remote
      .map((p) => normalizePosition(p, this.cfg.identify))
      .filter((p): p is BrokerPosition => p !== null && p.net_quantity !== 0);
  }

  /**
   * Adopt an order after a restart, re-binding durable identity to this session.
   *
   * Refuses on any immutable mismatch, exactly like the Kite adapter: adopting an
   * order that is not the one the intent describes would attribute someone else's
   * fills to this box.
   */
  async adoptOrder(intent: IBoxOrderIntent, snapshot: BrokerOrder): Promise<BrokerOrder> {
    this.ensureEnabled();
    if (intent.broker_order_id && snapshot.broker_order_id && intent.broker_order_id !== snapshot.broker_order_id) {
      throw new Error(
        `Refusing to adopt ${intent.client_order_id}: broker id ${snapshot.broker_order_id} does not match the durable intent's ${intent.broker_order_id}.`,
      );
    }
    if (
      snapshot.exchange !== intent.exchange ||
      snapshot.tradingsymbol !== intent.tradingsymbol ||
      snapshot.side !== intent.side ||
      snapshot.quantity !== intent.quantity
    ) {
      throw new Error(
        `Refusing to adopt ${intent.client_order_id}: the broker order does not match the durable intent.`,
      );
    }
    if (snapshot.broker_order_id) {
      const attributed = this.clientByBroker.get(snapshot.broker_order_id);
      if (attributed && attributed !== intent.client_order_id) {
        throw new Error(
          `Refusing to adopt ${intent.client_order_id}: broker order ${snapshot.broker_order_id} is already attributed to ${attributed}.`,
        );
      }
    }
    const correlation = intent.broker_correlation_id ?? this.correlationFor(intent.client_order_id);
    const adopted: BrokerOrder = {
      ...snapshot,
      client_order_id: intent.client_order_id,
      tag: correlation,
      pricing: {
        order_type: "LIMIT",
        reference_price: intent.reference_price,
        tick_size: intent.tick_size,
        max_chase_ticks: intent.max_chase_ticks,
        limit_price: intent.limit_price,
      },
      limit_price: intent.limit_price,
    };
    this.clientByCorrelation.set(correlation, intent.client_order_id);
    // ADOPTION MERGES. An unconditional write discarded a session entry that a stream observation
    // had already advanced — restart adoption and a live stream can overlap. Every durable immutable
    // field is still asserted above before we get here.
    return cloneOrder(this.commit(intent.client_order_id, adopted));
  }

  async margins(): Promise<BrokerMargin | null> {
    this.ensureEnabled();
    try {
      const funds = await this.call(() => this.client.getFundLimit());
      return {
        available: numberOrNull(funds.availabelBalance),
        utilised: numberOrNull(funds.utilizedAmount),
      };
    } catch {
      return null;
    }
  }

  async health(): Promise<BrokerHealth> {
    const checkedAt = Date.now();
    if (!this.isEnabled()) {
      return { ok: false, transport: "disabled", authenticated: false, message: "Dhan live adapter is disabled.", checked_at: checkedAt };
    }
    try {
      await this.call(() => this.client.getProfile());
      // Authenticated, but trading is a SEPARATE readiness question.
      const staticIpReady = this.cfg.staticIpReady();
      return {
        ok: staticIpReady,
        transport: "up",
        authenticated: true,
        message: staticIpReady
          ? null
          : "Dhan session is live but the static public IP is not whitelisted, so order placement is blocked.",
        checked_at: checkedAt,
      };
    } catch (err) {
      const authFailed = err instanceof DhanAuthError;
      return {
        ok: false,
        transport: err instanceof DhanNetworkError ? "down" : "unknown",
        authenticated: !authFailed,
        message: err instanceof Error ? err.message : String(err),
        checked_at: checkedAt,
      };
    }
  }
}

/** Net position, normalized. Dhan reports buy/sell legs plus a signed net. */
export function normalizePosition(
  p: DhanPosition,
  identify: (token: number) => { segment: DhanExchangeSegment; securityId: number } | null,
): BrokerPosition | null {
  const securityId = Number(p.securityId);
  if (!Number.isFinite(securityId)) return null;
  const net = numberOr(p.netQty, 0);
  // Dhan's average is side-specific; use the side that is actually open.
  const average = net > 0 ? numberOr(p.buyAvg, 0) : net < 0 ? numberOr(p.sellAvg, 0) : 0;
  // The internal token is recovered from Dhan's own identifiers so it matches what
  // the instrument store produced. `identify` is accepted for symmetry/testing.
  void identify;
  return {
    token: securityId,
    exchange: p.exchangeSegment === "NSE_FNO" ? "NFO" : p.exchangeSegment,
    tradingsymbol: p.tradingSymbol,
    net_quantity: net,
    average_price: average,
  };
}

function fromRequest(req: BrokerOrderRequest, now: number, correlationId: string): BrokerOrder {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: null,
    tag: correlationId,
    role: req.role,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state: "CREATED",
    filled_quantity: 0,
    pending_quantity: req.quantity,
    average_price: null,
    fills: [],
    reject_family: null,
    reject_reason: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * An order this session did not create, surfaced with an explicit ORPHAN identity.
 *
 * Subject to the SAME evidence rules as `project()`: an orphan whose terminal-looking label carries
 * no cumulative quantity is surfaced as RECONCILIATION_REQUIRED, not as a fully-executed or flat
 * order. Reconciliation after a restart is exactly when a fabricated zero does the most damage,
 * because there is no prior session state to contradict it.
 */
function orphanOrder(order: DhanOrder): BrokerOrder {
  const now = Date.now();
  const quantity = numberOr(order.quantity, 0);
  const observedQuantity = readCumulativeQuantity(order);
  const observedPrice = readTradedPrice(order);
  const claimedState = dhanOrderState(order.orderStatus, observedQuantity.value ?? 0, quantity);
  const verdict = evaluateExecutionEvidence({
    statusLabel: String(order.orderStatus ?? ""),
    claimedState,
    requestedQuantity: quantity,
    priorFilled: 0,
    quantity: observedQuantity,
    price: observedPrice,
  });
  const filled = verdict.filledQuantity;
  return {
    client_order_id: `DHAN_ORPHAN:${order.orderId}`,
    broker_order_id: order.orderId,
    tag: order.correlationId ?? null,
    role: "k1_ce",
    trade_id: null,
    attempt_id: `dhan-orphan-${order.orderId}`,
    purpose: "PROTECTIVE_CANCEL",
    phase: "entry",
    exchange: order.exchangeSegment === "NSE_FNO" ? "NFO" : order.exchangeSegment,
    tradingsymbol: order.tradingSymbol,
    token: Number(order.securityId) || 0,
    side: order.transactionType,
    quantity,
    pricing: {
      order_type: "LIMIT",
      reference_price: numberOr(order.price, 0) || 0.05,
      tick_size: 0.05,
      max_chase_ticks: 0,
      limit_price: numberOr(order.price, 0) || 0.05,
    },
    limit_price: numberOr(order.price, 0),
    state: verdict.sufficient
      ? dhanOrderState(order.orderStatus, filled, quantity)
      : "RECONCILIATION_REQUIRED",
    filled_quantity: filled,
    pending_quantity: Math.max(0, quantity - filled),
    average_price: verdict.averagePrice,
    fills: [],
    execution_evidence: verdict.quality,
    reject_family: null,
    reject_reason: verdict.detail,
    created_at: now,
    updated_at: now,
    exchange_updated_at: parseIstBrokerTimestamp(order.updateTime),
  };
}

function cloneOrder(order: BrokerOrder): BrokerOrder {
  return { ...order, pricing: { ...order.pricing }, fills: order.fills.map((f) => ({ ...f })) };
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number): Promise<void> {
  // NOT unref'd. An unref'd timer does not hold the event loop open, so awaiting one
  // can never resolve if nothing else is pending — the await simply hangs. `unref` is
  // right for a background retry timer (see the feed's reconnect), and wrong for a
  // delay something is waiting on.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
