import {
  BrokerAmbiguousSubmitError,
  BrokerCancelNotTransmittedError,
  BrokerCancelUnresolvedError,
  BrokerOrderRejectedError,
  BrokerPreSubmitRefusedError,
  isBrokerOrderTerminal,
  type BrokerAdapter,
  type BrokerOrder,
  type BrokerOrderRequest,
  type BrokerOrderState,
} from "./brokerAdapter.js";
import { mergeBrokerOrderSnapshot } from "./brokerOrderMerge.js";
import { BoundedTtlCache } from "../boundedCache.js";
import type { BoxConfig } from "./config.js";
import { CumulativeFillLedger } from "./orderLifecycle.js";
import type { ExecutionTimingRecorder } from "./executionTiming.js";
import { kindForPurpose } from "./executionTiming.js";
import type { BrokerId } from "./latencyModel.js";
import { dhanCorrelationId } from "../brokers/dhan/correlation.js";
import {
  evaluateLiveEntryGuard,
  stillWantedSafely,
  type LiveEntryGuardDecision,
  type LiveEntryGuardStage,
} from "./liveEntryGuard.js";
import {
  HedgeCoverageLedger,
  type HedgeOutcomeEvidence,
  type HedgeRequirement,
} from "./hedgeCoverageLedger.js";
import {
  admitBoxOperation,
  BOX_ORDER_PRIORITY,
  type BoxSchedulingOccupancy,
  type BoxSchedulingSlot,
  clampEntrySubmitConcurrency,
} from "./executionSchedulingPolicy.js";
import { ZERODHA_STATIC_IP_UNCONFIRMED } from "./zerodhaStaticIp.js";
import type {
  BoxOrderIntentAudit,
  BoxOrderIntentPatch,
  BoxOrderIntentState,
  BoxOrderPurpose,
  BoxLegRole,
  IBoxOrderIntent,
  ResidualLegExposure,
} from "./types.js";

/**
 * The outcome of one guarded durable update — the TRANSITION, not merely the resulting document.
 *
 * `previous_filled_quantity` / `current_filled_quantity` are what make position attribution safe.
 * See `durableFillDelta` and `repository.updateBoxOrderIntent` for the double-count this exists
 * to prevent. A persistence implementation that cannot report the transition must leave them
 * null; the manager then attributes nothing and raises an invariant rather than guessing.
 */
export interface OrderIntentUpdateResult {
  intent: IBoxOrderIntent | null;
  applied: boolean;
  previous_filled_quantity?: number | null;
  current_filled_quantity?: number | null;
}

export interface CheckedFeedStamp {
  /** Token whose exact executable snapshot was checked. */
  readonly token: number;
  readonly feed_generation: number;
  readonly quote_version: number;
  readonly quote_at: number;
  readonly checked_at: number;
}

/**
 * The BOX-LEVEL per-Box ₹ capital decision, stamped onto every ENTRY leg of one Box.
 *
 * WHY THIS EXISTS. The cap is a property of the whole four-leg set, but the manager schedules
 * one leg at a time and can never see the set. Without the stamp there would be no way to
 * re-verify the cap at dequeue — the last safe moment before a broker mutation — so a config
 * change or a rebuilt request set between admission and transmission would go unnoticed.
 *
 * EPHEMERAL EVIDENCE ONLY, exactly like {@link CheckedFeedStamp}: never copied into the
 * durable intent and never sent to the broker.
 */
export interface EntryCapitalStamp {
  readonly candidate_key: string;
  /** Gross entry-order notional in integer PAISE, from the bounded LIMIT requests. */
  readonly box_notional_paise: number;
  /** The cap that was in force when the decision was taken (₹). 0 ⇒ disabled. */
  readonly configured_max_rupees: number;
  readonly checked_at: number;
}

/**
 * The per-leg ENTRY guard: the caller's ownership/"still wanted" predicate plus this leg's place
 * in the hedge-first transport sequence.
 *
 * EPHEMERAL, exactly like {@link CheckedFeedStamp} and {@link EntryCapitalStamp}: never written to
 * the durable intent and never sent to a broker. It is live authority, not a record.
 *
 * ENTRY ONLY. The manager checks `purpose === "ENTRY"` before it consults any of this, because
 * every condition here is a reason not to CREATE exposure and never a reason to leave existing
 * exposure on the book. See {@link evaluateLiveEntryGuard}.
 */
export interface LiveEntryTransportGuard {
  /**
   * The composed ownership + scanner predicate, re-evaluated (not cached) at dequeue, after
   * durable persistence, and immediately before the broker POST. Throwing counts as "no".
   */
  readonly stillWanted: () => boolean;
  /** 0-based hedge-first transport rank within this attempt (see entrySubmissionOrder.ts). */
  readonly transportRank: number;
  /** True when this leg is a BUY hedge that the attempt's uncovered SELL legs depend on. */
  readonly hedge: boolean;
  /** How many BUY hedge legs this attempt has. Uncovered SELLs wait for all of them. */
  readonly hedgeCount: number;
  /**
   * CROSS-LEG COHERENCE, re-evaluated against the CURRENT four books at the send boundary.
   *
   * Supplied by the gateway, which is the only layer that can see all four books, the socket
   * generation and the configured policy. Returns null when the snapshot is still coherent, or the
   * reason it is not. Consulted ONLY at `pre_post`, and only while the attempt has taken no
   * exposure — see `cross_leg_incoherent` in liveEntryGuard.ts for why.
   *
   * Optional so that callers which cannot observe the books (and every existing test) are unchanged;
   * absent means "no objection from here", never "coherence is proven".
   */
  readonly sendBoundaryCoherence?: () => string | null;
  /**
   * FUNDS/MARGIN EVIDENCE validity, re-evaluated at the send boundary against the request that is
   * actually about to be transmitted.
   *
   * Supplied by the gateway, which owns the evidence it admitted the entry with. Returns null when
   * the evidence still applies, or the reason it does not (expired, account/session changed, or the
   * order plan differs from the one the margin figure was fetched for). Consulted ONLY at
   * `pre_post`, and only while the attempt has taken no exposure — see `economic_evidence_expired`
   * in liveEntryGuard.ts.
   *
   * Optional so callers with no economic control enabled (and every existing test) are unchanged;
   * absent means "no objection from here", never "funding is proven".
   */
  readonly sendBoundaryEconomics?: (request?: BrokerOrderRequest) => string | null;
}

/**
 * Per-attempt transport sequencing state for one entry attempt's four legs.
 *
 * WHY THIS IS NEEDED AT ALL. Building the requests in hedge-first order is not sufficient. With
 * `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY = 4` all four legs are dequeued together and each then does
 * its own two durable Mongo writes; whichever write finishes first would reach the broker first.
 * Enqueue order therefore does NOT determine POST order, and the uncovered SELL could still win
 * the race. This gate makes rank `n` wait until every rank below it has DECIDED — posted, or
 * terminalized locally without posting.
 *
 * DEADLOCK SAFETY. Every rank that is admitted releases in a `finally`, every rank rejected before
 * enqueue releases immediately, and `dispose` releases the rest. Rank 0 never waits. Because the
 * queue is FIFO by sequence and the gateway enqueues in rank order, rank 0 is always dequeued
 * first, so a lower rank can never be starved by a higher one holding its slot.
 */
interface EntryTransportGate {
  /**
   * Every rank that has registered for this attempt.
   *
   * Tracked EXPLICITLY rather than inferred from the decided/parked sets. Inferring it lost the
   * gate — and with it the `hedgeFailure` record — the moment the last hedge woke the parked SELLs,
   * because a woken waiter is no longer in either set. The SELLs then found no gate, read no hedge
   * failure, and POSTed naked. The set is the authority for when the gate may be dropped.
   */
  readonly registered: Set<number>;
  /** Ranks that have decided, and how. */
  readonly decided: Map<number, "posted" | "no_post">;
  /** Waiters parked until every BUY hedge rank has decided. */
  waiters: Array<{ readonly rank: number; readonly wake: () => void }>;
  /**
   * DEFECT-CLOSING NOTE — this field is now a DIAGNOSTIC ONLY.
   *
   * It records the first NAMED hedge failure for readable status/audit. It is NOT the thing a
   * dependent SELL consults for permission any more, precisely because a NAMED failure and a
   * PROVEN COVERAGE are not complements: a hedge could come back CANCELLED with zero fills — a
   * total absence of coverage — without being named a failure here, and the old code then POSTed
   * the naked SELL. Permission is now taken from {@link coverage} below, which requires positive,
   * attributed proof of fill. See hedgeCoverageLedger.ts.
   */
  hedgeFailure: string | null;
  /**
   * Attributed, single-use, attempt-scoped proof of hedge fill. The AUTHORITATIVE basis for
   * authorising a dependent uncovered SELL: a SELL may POST only when every BUY hedge of the
   * attempt is PROVEN here to have filled its full required quantity on the right contract, side
   * and account. Absent/insufficient proof fails closed.
   */
  readonly coverage: HedgeCoverageLedger;
  /**
   * The identity every BUY hedge of this attempt must prove, keyed by transport rank. Populated as
   * each hedge leg is submitted (it declares its own contract/side/quantity), and read by each
   * dependent SELL to build its coverage requirement set. Ranks `[0, hedgeCount)` are hedges.
   */
  readonly hedgeRequirements: Map<number, HedgeRequirement>;
  /** How many BUY hedge legs this attempt has; ranks `[0, hedgeCount)` are the hedges. */
  hedgeCount: number;
  /**
   * The broker-account key FROZEN for the whole attempt, captured when this gate was created.
   *
   * WHY FROZEN. Coverage compares the account on a requirement (stamped BEFORE a hedge posts) with
   * the account on its evidence (stamped AFTER). Reading the live account at both moments meant an
   * identity that changed inside that window — a token dying, a re-login, a broker switch, or a
   * stored-session adoption that nulls the session metadata — produced `account_mismatch` and refused
   * the dependent uncovered SELLs *after* the hedge BUYs had already filled. The compounding is what
   * makes it serious: the same unnameable-account condition also used to block the protective unwind,
   * so one signal both prevented completion of the box and blocked the automatic way out of it.
   *
   * Freezing per attempt keeps the axis meaningful — two DIFFERENT attempts still cannot share
   * coverage, which is the property that matters — while guaranteeing all four legs of ONE attempt
   * are judged against a single value. This weakens nothing that was ever real: before the account
   * provider was wired, both sides were the constant `broker:live` and the axis could not disagree at
   * all.
   */
  readonly brokerAccountKey: string;
}

export interface OrderIntentPersistence {
  create(intent: IBoxOrderIntent): Promise<IBoxOrderIntent>;
  update(
    clientOrderId: string,
    patch: BoxOrderIntentPatch,
    audit: BoxOrderIntentAudit,
    /** Optional compare-and-set guard for safety-critical local transitions. */
    expectedStates?: readonly BoxOrderIntentState[],
  ): Promise<OrderIntentUpdateResult>;
  loadNonterminal(): Promise<IBoxOrderIntent[]>;
  loadOwned?(): Promise<IBoxOrderIntent[]>;
  findByClientId(clientOrderId: string): Promise<IBoxOrderIntent | null>;
  findByBrokerId(brokerOrderId: string): Promise<IBoxOrderIntent | null>;
}

/**
 * The broker owns this fill, but Mongo could not accept its terminal snapshot.
 * Carrying the broker snapshot prevents callers from accidentally treating the
 * rejected promise as an unfilled order and dropping irreversible exposure.
 */
export class OrderPersistenceAfterFillError extends Error {
  constructor(
    readonly order: BrokerOrder,
    readonly causeValue: unknown,
  ) {
    super(`Persistence failed after confirmed fill ${order.client_order_id}.`);
    this.name = "OrderPersistenceAfterFillError";
  }
}

export interface OrderManagerControls {
  /**
   * Permits NEW exposure. Never consulted for a reduction.
   */
  entryEnabled: boolean;
  /**
   * The master switch for NEW exposure — NOT for reduction.
   *
   * It once gated `canManageExposure()` as well, which meant switching it off silently disabled
   * cancellation, exits and residual flattening while the exposure was still owned. Reduction now
   * depends on the ability to act attributably (authenticated + known account), not on an operator
   * preference about taking new risk. See {@link BoxOrderManager.exposureReductionBlockReason}.
   */
  liveOrderEnabled: boolean;
  emergencyFlatten: boolean;
}

/**
 * The outcome of a cancel-working sweep, reported so a REFUSAL cannot be mistaken for a clean sweep.
 *
 * The method used to return `BrokerOrder[]`, and returned `[]` both when it cancelled nothing because
 * there was nothing to cancel AND when it refused to try at all. The route published the second case
 * as `{ ok: true, orders: [] }`.
 */
export interface CancelWorkingBoxOrdersResult {
  /** Every eligible intent was attempted and none failed. NOT a claim that the broker is now flat. */
  ok: boolean;
  /** False when the sweep was refused outright — no intent was loaded and nothing was sent. */
  attempted: boolean;
  /** Why the sweep was refused, verbatim, or null when it ran. */
  blocked_reason: string | null;
  /** Non-terminal durable intents examined. */
  examined: number;
  /** Of those, how many were BOX intents eligible for cancellation. */
  eligible: number;
  /** Durable order snapshots for the cancels the broker accepted. */
  cancelled: BrokerOrder[];
  /** Per-intent failures, each `clientOrderId: message`. Non-empty means exposure may remain. */
  failures: string[];
}

export interface OrderManagerHealth {
  persistence: "healthy" | "unhealthy" | "unknown";
  daily_risk_seed: "healthy" | "seeding" | "failed" | "unknown";
  broker_auth: "healthy" | "unhealthy" | "disabled" | "unknown";
  broker_orders_api: "healthy" | "unhealthy" | "disabled" | "unknown";
  broker_positions_api: "healthy" | "unhealthy" | "disabled" | "unknown";
  reconciliation: "idle" | "running" | "failed";
  reconciliation_complete: boolean;
  feed: "healthy" | "warming" | "unhealthy" | "unknown";
  circuit: "closed" | "open";
}

export interface DailyRiskSeed {
  realisedPnl: number;
  rejects: number;
  consecutiveFailures: number;
  /** Authoritative charge total for this seed's trading day, keyed by execution attempt. */
  flattenChargeBaselinesForDay?: Record<string, number>;
  /**
   * The loader could not prove it read every contributing row. An understated loss must never
   * present itself as an authoritative seed, so this keeps `daily_risk_seed` unhealthy — and
   * therefore entry closed — while still installing the counters for observability.
   */
  incomplete?: boolean;
}

/** Generation captured immediately before an asynchronous daily-risk load begins. */
export interface DailyRiskSeedToken {
  readonly tradingDay: string;
  readonly mutationGeneration: number;
  /** Unique loader/token generation; late completions are accepted only while this is active. */
  readonly loadGeneration: number;
}

export interface DailyRiskSeedTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface FlattenChargeMutation {
  readonly generation: number;
  readonly attemptId: string;
  readonly previousChargesForDay: number;
  readonly chargesForDay: number;
}

export interface OrderManagerStatus {
  controls: OrderManagerControls;
  health: OrderManagerHealth;
  circuitBreaker: { tripped: boolean; reason: string | null; at: number | null };
  inFlight: number;
  queued: number;
  reservedEntryQuantity: number;
  reservedReductionQuantity: number;
  unknownOrders: number;
  recoveryActive: boolean;
  safeAttributedReductionReady: boolean;
  /**
   * Working broker orders from an interrupted attempt that no waiter in this process owns. Non-zero
   * blocks NEW ENTRY (their final quantities are unsettled) but never blocks reduction.
   */
  unattendedWorkingOrders: number;
  /** Reconcile passes that discarded an obsolete absolute rebuild because a fill landed mid-pass. */
  staleReconcilePasses: number;
  /** Matching crash-only exposure exists but its unique durable recovery boundary is unavailable. */
  crashRecoveryEntryQuarantined: boolean;
  tradingDay: string;
  riskBookkeeping: {
    activeSeedTokens: number;
    activeLoadGeneration: number | null;
    retainedMutationCount: number;
    retainedMutationDayBuckets: number;
  };
  rejects: number;
  consecutiveFailures: number;
  realisedPnlToday: number;
  residualLegs: number;
  openBoxes: number;
  orphanOrders: BrokerOrder[];
  lastReconciledAt: number | null;
  /**
   * How many durable state transitions the intent state machine REFUSED this session.
   *
   * A bounded counter, not a label: a refused transition used to be indistinguishable from a
   * successful one because the guarded write returns the unchanged document either way.
   */
  durableTransitionRefusals: number;
  /**
   * Four-leg coherence that had degraded at the SEND BOUNDARY after the attempt already held
   * exposure, and the most recent reason.
   *
   * The completion policy deliberately does not refuse in that state (a complete box is hedged;
   * abandoning it manufactures a partial entry and a recovery cost), so this is what keeps the
   * decision VISIBLE rather than silent. A non-zero count with real boxes is the signal that the
   * configured dispersion limit and the actual feed timing disagree.
   */
  coherenceDegradedAfterExposure: number;
  lastCoherenceDegradation: string | null;
  /**
   * Times the funds/margin evidence had already expired (or the plan/account had changed) at the
   * send boundary but the attempt held exposure, so the box was COMPLETED and the degradation
   * recorded rather than refused. A non-zero value means real entries are racing their own evidence
   * window: either the window is too tight or the queue/persistence/pacing path is too slow.
   */
  economicEvidenceDegradedAfterExposure: number;
  lastEconomicEvidenceDegradation: string | null;
}

export interface OrderManagerLimits {
  maxOpenBoxes: number;
  maxConcurrentExecutions: number;
  /**
   * How many ENTRY role submissions of ONE Box pipeline may be in transport at once (1..4).
   *
   * See the BOX ENTRY BURST POLICY section of executionSchedulingPolicy.ts. `1` reproduces the
   * pre-burst behaviour exactly.
   */
  entrySubmitConcurrency: number;
  /**
   * Per-Box gross entry-order notional cap (₹). `0` disables the gate.
   *
   * Held here so the DEQUEUE re-check has its own authority and does not depend on the stamp
   * agreeing with itself. See `boxCapital.ts` for why this is not broker margin.
   */
  maxBoxCapitalRupees: number;
  maxResidualLegs: number;
  dailyLossLimit: number;
  rejectLimit: number;
  consecutiveFailureLimit: number;
  maxOpenLegQuantity: number;
  maxGrossOpenLegQuantity: number;
  reconcileIntervalMs: number;
  feedReconnectWarmupMs: number;
  /**
   * Has an operator confirmed Zerodha's static-IP registration for a LIVE deployment?
   *
   * Pre-resolved against the execution mode at construction so this object stays a plain value and
   * the order manager needs no knowledge of the mode: a paper profile places no broker order, so it
   * is folded to `true` here rather than special-cased at the point of use.
   *
   * Consumed by `entryBlockReasonAfterControls` ONLY. It must never be read from a submit, cancel or
   * modify path that a reduction can reach — an operator forgetting a confirmation flag must not stop
   * GAR_B from ATTEMPTING to reduce exposure it already owns.
   */
  zerodhaEntryStaticIpConfirmed: boolean;
}

export function orderManagerLimitsFromConfig(cfg: BoxConfig): OrderManagerLimits {
  return {
    zerodhaEntryStaticIpConfirmed:
      cfg.executionMode === "live" ? cfg.zerodhaStaticIp.confirmed : true,
    maxOpenBoxes: cfg.liveMaxOpenBoxes,
    maxConcurrentExecutions: cfg.liveMaxConcurrentExecutions,
    entrySubmitConcurrency: cfg.liveEntrySubmitConcurrency,
    maxBoxCapitalRupees: cfg.liveMaxBoxCapitalRupees,
    maxResidualLegs: cfg.liveMaxResidualLegs,
    dailyLossLimit: cfg.liveDailyLossLimit,
    rejectLimit: cfg.liveRejectLimit,
    consecutiveFailureLimit: cfg.liveConsecutiveFailureLimit,
    maxOpenLegQuantity: cfg.liveMaxOpenLegQuantity,
    maxGrossOpenLegQuantity: cfg.liveMaxGrossOpenLegQuantity,
    reconcileIntervalMs: cfg.liveReconcileIntervalMs,
    feedReconnectWarmupMs: cfg.liveFeedReconnectWarmupMs,
  };
}

export interface OrderManagerReconcileReport {
  matched: number;
  missingAtBroker: string[];
  orphanOrders: BrokerOrder[];
  positions: Awaited<ReturnType<BrokerAdapter["listPositions"]>>;
  positionMismatches: Array<{ symbol: string; expected: number; actual: number }>;
  affectedTradeIds: string[];
  remainingByTrade: Record<string, Partial<Record<BoxLegRole, number>>>;
}

interface SubmitQueueAction {
  kind: "submit";
  request: BrokerOrderRequest;
  /** Ephemeral evidence only; never copied into the durable intent or broker payload. */
  checkedFeed?: CheckedFeedStamp;
  /** Box-level ₹ capital evidence for an ENTRY leg. Ephemeral, like `checkedFeed`. */
  capital?: EntryCapitalStamp;
  /** Live ENTRY ownership guard + hedge-first rank. ENTRY only; ephemeral, like `capital`. */
  entry?: LiveEntryTransportGuard;
  resolve: (order: BrokerOrder) => void;
  reject: (error: unknown) => void;
  sequence: number;
}

interface CancelQueueAction {
  kind: "cancel";
  intent: IBoxOrderIntent;
  resolve: (order: BrokerOrder | undefined) => void;
  reject: (error: unknown) => void;
  sequence: number;
}

type QueueAction = SubmitQueueAction | CancelQueueAction;

// The scheduling priority is defined once, in executionSchedulingPolicy, and shared with
// the paper live_parity scheduler so the two can never drift. Same values, same ordering
// the manager has always used — this is a source move, not a behaviour change.
const PRIORITY = BOX_ORDER_PRIORITY;

const RECONCILE_STATES: ReadonlySet<BrokerOrderState> = new Set([
  "UNKNOWN",
  "RECONCILIATION_REQUIRED",
]);

/**
 * A broker account identity reduced to "a name" or "unproven" — the ONLY two states worth comparing.
 *
 * Every account comparison in this file routes through here so that the several ways of saying
 * "we do not know" (`undefined`, `null`, `""`, `"   "`) collapse to ONE value. Without this, a guard
 * could compare `""` against `null` and conclude the accounts differ, which would refuse a
 * cancellation on the strength of two pieces of missing information.
 */
function normalizedAccount(account: string | null | undefined): string | null {
  if (typeof account !== "string") return null;
  const trimmed = account.trim();
  return trimmed === "" ? null : trimmed;
}

function queuePriority(action: QueueAction): number {
  return action.kind === "cancel" ? PRIORITY.PROTECTIVE_CANCEL : PRIORITY[action.request.purpose];
}

/**
 * Durable, broker-neutral order coordinator. It intentionally knows no strategy
 * arithmetic: the engine integration can supply qualified requests later while
 * this layer owns identity, persistence-before-submit, safety controls and
 * reconciliation.
 */
export class BoxOrderManager {
  private controls: OrderManagerControls;
  private health: OrderManagerHealth = {
    persistence: "unknown",
    daily_risk_seed: "unknown",
    broker_auth: "unknown",
    broker_orders_api: "unknown",
    broker_positions_api: "unknown",
    reconciliation: "idle",
    reconciliation_complete: false,
    feed: "unknown",
    circuit: "closed",
  };
  private readonly queue: QueueAction[] = [];
  /**
   * INDEPENDENT OVERFILL TRIPWIRE — deliberately a SECOND, redundant fill accounting (audit D3).
   *
   * This is NOT the single projection of truth. That is {@link OrderUpdateProjection} inside the
   * order-stream consumer (see `noteStreamBrokerSnapshot`), through which stream AND REST
   * observations are attributed, deduplicated and woken. This second set of per-order ledgers is a
   * separate, adversarial CROSS-CHECK fed from the SAME broker snapshot on the SAME code path: its
   * ONLY job is to trip the circuit breaker if the broker ever reports MORE filled than we asked
   * for. It is redundant BY DESIGN — an overfill is a "our own quantity model is wrong" signal, and
   * a safety tripwire that shares no state with the thing it guards is worth its small cost.
   *
   * REPLACED a dead `fillIdentities` set whose `continue` skipped nothing and which nothing read.
   * Every observed broker snapshot for an order is routed through a ledger that enforces the same
   * invariants: a duplicate broker event contributes no quantity, an out-of-order snapshot cannot
   * rewind the cumulative total, and an overfill is surfaced rather than silently clamped.
   *
   * The authoritative position arithmetic remains the Mongo-guarded path below. Because BOTH this
   * tripwire and the projection are idempotent, monotonic and fed the SAME cumulative snapshot,
   * they can NEVER disagree about attributed cumulative quantity for an order (pinned by
   * tests/box/fillLedgerTwoStores.test.mjs). Bounded by TTL and count, so a long session cannot leak.
   */
  private readonly overfillTripwireLedgers: BoundedTtlCache<CumulativeFillLedger>;
  private readonly activeClientIds = new Set<string>();
  private readonly knownIntents = new Map<string, IBoxOrderIntent>();
  private orphanOrders: BrokerOrder[] = [];
  private sequence = 0;
  /**
   * TOTAL in-flight operations. Retained as the reported number (`status().inFlight`) so every
   * existing consumer — health, capacity checks, diagnostics — keeps its meaning.
   */
  private inFlight = 0;
  /** In-flight operations holding a BASE concurrency slot. */
  private baseInFlight = 0;
  /** In-flight ENTRY operations holding an entry-burst slot. */
  private burstInFlight = 0;
  /** In-flight operations whose purpose is not ENTRY. */
  private nonEntryInFlight = 0;
  /** The single Box pipeline owning every in-flight ENTRY operation, or null. */
  private entryAttemptInFlight: string | null = null;
  /** In-flight ENTRY operations, used to clear {@link entryAttemptInFlight} at zero. */
  private entryInFlight = 0;
  /** Peak simultaneous ENTRY submissions observed, for diagnostics. */
  private peakEntryBurstWidth = 0;
  /** How many times the entry burst granted an extra slot. Diagnostics only. */
  private entryBurstGrants = 0;
  private rejects = 0;
  private consecutiveFailures = 0;
  private realisedPnlToday = 0;
  private residualLegs = 0;
  private openBoxes = 0;
  private grossOpenLegQuantity = 0;
  private reservedEntryQuantity = 0;
  private reservedReductionQuantity = 0;
  private readonly reservations = new Map<string, number>();
  private readonly reductionReservations = new Map<string, { symbol: string; quantity: number }>();
  private readonly reservedReductionsBySymbol = new Map<string, number>();
  private unknownOrders = 0;
  private recoveryActive = false;
  private safeAttributedReductionReady = false;
  /**
   * Non-terminal durable orders that reconciliation matched at the broker but which NO waiter in this
   * process owns — i.e. an interrupted attempt's legs, still live and still able to fill.
   *
   * Deliberately NOT folded into `safeAttributedReductionReady`: blocking reduction here would strand
   * exposure, which is the worse failure. The correct response is to CANCEL them and re-establish
   * final quantities before planning a reduction — see `BoxEngine.flattenAttributedBoxExposure`.
   */
  private unattendedWorkingOrders = 0;
  /**
   * How many reconcile passes discarded an obsolete exposure rebuild.
   *
   * Reconciliation loads its journal snapshot, awaits two broker round trips, then rebuilds the
   * attributed-position map ABSOLUTELY from that snapshot. A fill committed during those awaits — an
   * exit that just closed the position, say — is applied incrementally to the same map, and the
   * absolute rebuild would overwrite it with the PRE-EXIT value. The manager would then believe it
   * still holds exposure it has already closed, and a further "reduction" against that phantom would
   * sell through flat into a REVERSE position. The circuit breaker is no defence: reduction admission
   * reads the same map and stays permitted while the breaker is open.
   *
   * A non-zero value here means that race was detected and the stale rebuild refused. Diagnostics
   * only — a spike means contention worth investigating, not a fault in itself.
   */
  private staleReconcilePasses = 0;
  private tradingDay: string;
  private readonly attributedBoxPositions = new Map<string, number>();
  /**
   * The broker account {@link attributedBoxPositions} was reconciled under, or null when unproven.
   *
   * Attribution without an owner is how one account's flatten reaches another account's positions —
   * see {@link BoxOrderManager.attributedAccountDriftReason}.
   */
  private attributedPositionsAccount: string | null = null;
  private feedHealthy = false;
  private feedWarmUntil = Number.POSITIVE_INFINITY;
  private breakerReason: string | null = null;
  private breakerAt: number | null = null;
  private reconcilePromise: Promise<OrderManagerReconcileReport> | null = null;
  private dailyRiskLoadGeneration = 0;
  private activeDailyRiskLoad: {
    generation: number;
    day: string;
    token: DailyRiskSeedToken;
    timeout: unknown;
  } | null = null;
  private readonly activeDailyRiskSeedTokens = new Map<number, DailyRiskSeedToken>();
  private crashOnlyAttributedExposure = false;
  /**
   * Local flatten observations are generation-stamped per day. A seed loader captures the
   * generation before issuing any query, then installation merges only ranges absent from the
   * loader's authoritative per-attempt day buckets. This is the serialization boundary between
   * Mongo reconstruction and in-process risk mutation.
   */
  private flattenChargeMutationGeneration = 0;
  private readonly flattenChargeMutationsByDay = new Map<string, FlattenChargeMutation[]>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  /**
   * How many times four-leg coherence had degraded at the send boundary AFTER the attempt already
   * held exposure, and the most recent reason.
   *
   * Counted rather than acted on: the completion policy deliberately does NOT refuse in that state
   * (see `entryCrossLegCoherenceGap`), so this is the record that keeps the decision visible instead
   * of silent. Fixed cardinality — a counter and one bounded string.
   */
  private coherenceDegradedAfterExposure = 0;
  private lastCoherenceDegradation: string | null = null;
  private economicEvidenceDegradedAfterExposure = 0;
  private lastEconomicEvidenceDegradation: string | null = null;
  private disposed = false;
  private lastReconciledAt: number | null = null;
  /** Guarded durable transitions the intent state machine refused. Bounded counter. */
  private durableTransitionRefusals = 0;
  /** Hedge-first transport sequencing, one entry per live ENTRY attempt. Bounded by attempts. */
  private readonly entryTransportGates = new Map<string, EntryTransportGate>();
  /** ENTRY legs refused by the composed ownership guard, by stage. Diagnostics only. */
  private readonly entryGuardRefusals = new Map<LiveEntryGuardStage, number>();

  constructor(
    private readonly deps: {
      adapter: BrokerAdapter;
      /**
       * The order-stream consumer for this broker account, when live streams are wired.
       *
       * OWNERSHIP-FIRST. The manager registers each leg's durable identity here as it enters
       * SUBMITTING — BEFORE the broker POST — so an order-update that beats the placement HTTP
       * response has a ledger to land in and is attributable the instant it arrives. It also learns
       * the broker order id on acknowledgement and feeds REST snapshots into the same projection, so
       * the stream and REST are ONE deduplicated truth. Optional: absent ⇒ the manager behaves
       * exactly as before (REST polling is the only fill observer).
       */
      orderStreamConsumer?: import("./orderStreamConsumer.js").OrderStreamConsumer;
      persistence: OrderIntentPersistence;
      limits: OrderManagerLimits;
      /**
       * THE VERIFIED BROKER ACCOUNT for the active session (Kite `user_id` / Dhan client id).
       *
       * Read fresh on every decision, so a token refresh for the SAME account preserves attribution
       * and a login for a DIFFERENT account is visible immediately. Returns null when the process
       * cannot name its own account, which:
       *   - BLOCKS new live entry with a specific reason ({@link BoxOrderManager.entryBlockReason});
       *   - BLOCKS reduction, because a reduction that cannot be attributed to the owning account is
       *     how one account's flatten reaches another's positions.
       *
       * Optional so paper deployments and existing tests construct unchanged; absent behaves as
       * "unknown account", which is the safe direction.
       */
      brokerAccount?: () => string | null;
      controls?: Partial<OrderManagerControls>;
      clock?: { now: () => number };
      istDayKey?: (at: number) => string;
      onPersistenceLossAfterFill?: (order: BrokerOrder, error: unknown) => void;
      onReconciliationIssue?: (report: OrderManagerReconcileReport) => void | Promise<void>;
      loadDailyRiskSeed?: (tradingDay: string) => Promise<DailyRiskSeed>;
      /** Logical cancellation bound for a seed query that the database driver cannot abort. */
      dailyRiskSeedTimeoutMs?: number;
      /** Injectable deterministic timer used by seed timeout tests. */
      dailyRiskSeedTimer?: DailyRiskSeedTimer;
      /** Process/connection/index-scoped readiness; read at every entry decision. */
      isCrashRecoveryPersistenceReady?: () => boolean;
      onCircuitTrip?: (reason: string) => void;
      /**
       * LIVE TIMING INSTRUMENTATION (Phase 2). Optional and FAIL-OPEN: when absent the manager
       * behaves exactly as before, and when present no failure inside it can affect an order.
       * The manager owns the SCHEDULER stages (enqueue/dequeue) because it is the only layer
       * that witnesses them; the adapter marks the transport, ACK, fill and cancel stages on
       * the same trace, keyed by client order id.
       */
      timing?: ExecutionTimingRecorder;
      /**
       * Called for every REAL broker rejection, so reject-family statistics are measured rather
       * than modelled (Phase 19). Fail-open: a diagnostics failure here must not change how a
       * rejection is handled.
       */
      onBrokerReject?: (order: BrokerOrder | null, reason: string) => void;
      /**
       * Re-check the exact executable quote admitted by the gateway. Production
       * installs this fail-closed authority; optionality preserves isolated manager
       * use where no market-data source exists.
       */
      revalidateQueuedRequest?: (
        request: BrokerOrderRequest,
        stamp: CheckedFeedStamp | undefined,
      ) => string | null;
      /**
       * IS THIS ENTRY STILL AUTHORISED, at the last instant before its POST?
       *
       * ENTRY ONLY. Never consulted for a reduction — an exit, protective cancel or residual unwind
       * must never be refused because an operator control changed.
       *
       * THE DEFECT THIS EXISTS FOR. Admission-time authorisation is not enough. An attempt admitted
       * a moment ago has passed the session gate, taken its reservations and queued four orders; if
       * the operator then DISARMS the session, nothing re-checked it and all four orders still went
       * to the broker. "I pressed stop and it kept trading" is not an acceptable outcome, and the
       * queue plus broker pacing make that window real rather than theoretical.
       *
       * It must NOT merely re-check the remaining attempt budget: an admitted attempt has
       * legitimately consumed its allowance and would otherwise reject itself.
       *
       * Fails CLOSED: a throwing validator blocks the POST.
       */
      entryAuthorizationBlockReason?: (request: BrokerOrderRequest) => string | null;
      /**
       * Which broker these samples belong to. Required for timing to be recorded at all,
       * because a sample that cannot be attributed to a broker must never be filed — pooling
       * Zerodha and Dhan latency would describe neither.
       */
      broker?: () => BrokerId;
    },
  ) {
    this.tradingDay = this.dayKey();
    // Bounded: one tripwire ledger per in-flight order, expiring well after any order's lifetime.
    // Sized generously relative to the concurrency cap so nothing in a normal session is evicted
    // while still live, and hard-capped so nothing can leak.
    this.overfillTripwireLedgers = new BoundedTtlCache<CumulativeFillLedger>({
      maxEntries: 512,
      ttlMs: 60 * 60_000,
      now: () => this.now(),
    });
    this.controls = {
      entryEnabled: deps.controls?.entryEnabled ?? false,
      liveOrderEnabled: deps.controls?.liveOrderEnabled ?? false,
      emergencyFlatten: deps.controls?.emergencyFlatten ?? false,
    };
  }

  /** Reconcile immediately at startup and keep retrying at a low-frequency cadence. */
  async start(): Promise<OrderManagerReconcileReport> {
    // Arm the retry loop before the first pass: a transient startup failure must
    // not silently disable reconciliation for the rest of the process lifetime.
    if (!this.disposed && this.reconcileTimer === null) {
      this.reconcileTimer = setInterval(() => {
        void this.reconcile().catch(() => undefined);
      }, Math.max(5_000, this.deps.limits.reconcileIntervalMs));
      this.reconcileTimer.unref?.();
    }
    return this.reconcile();
  }

  setControls(patch: Partial<OrderManagerControls>): void {
    this.controls = { ...this.controls, ...patch };
  }

  /** Capture and register the local mutation boundary immediately before a daily-risk load starts. */
  beginDailyRiskSeed(tradingDay: string): DailyRiskSeedToken {
    const token: DailyRiskSeedToken = {
      tradingDay,
      mutationGeneration: this.flattenChargeMutationGeneration,
      loadGeneration: ++this.dailyRiskLoadGeneration,
    };
    this.activeDailyRiskSeedTokens.set(token.loadGeneration, token);
    return token;
  }

  /**
   * Release a daily-risk seed token whose load will never install anything.
   *
   * `seedLimits` settles the token on the installing path; every other exit needs this one, or the
   * token stays "active" forever and `compactFlattenChargeMutations` must retain the whole day's
   * merge journal — the unbounded growth the generation bound exists to close, re-opened once per
   * failed boot. Idempotent (an already-settled token is not registered) and it never discards a
   * merge a genuinely active loader still needs: compaction keeps the suffix above the oldest
   * REMAINING active generation for the day.
   */
  abandonDailyRiskSeed(token: DailyRiskSeedToken): void {
    if (!this.activeDailyRiskSeedTokens.has(token.loadGeneration)) return;
    this.settleDailyRiskSeedToken(token);
  }

  /**
   * Reconciliation/engine seam for crash-only exposure not represented by projected trades.
   * Entry reads persistence readiness dynamically; ordinary exits never consult this flag.
   */
  setCrashOnlyAttributedExposure(exists: boolean): void {
    this.crashOnlyAttributedExposure = exists;
  }

  /**
   * Record one authoritative per-attempt/day bucket advance. Lifetime bookkeeping lives in the
   * engine; this manager owns only the trading-day debit and the seed-install merge journal.
   */
  recordFlattenCharge(args: {
    attemptId: string;
    chargeDay: string;
    previousChargesForDay: number;
    chargesForDay: number;
  }): void {
    if (!args.chargeDay || !Number.isFinite(args.previousChargesForDay) ||
        !Number.isFinite(args.chargesForDay)) return;
    const previous = Math.round(Math.max(0, args.previousChargesForDay) * 100) / 100;
    const current = Math.round(Math.max(0, args.chargesForDay) * 100) / 100;
    if (current <= previous || args.chargeDay !== this.tradingDay) return;
    const generation = ++this.flattenChargeMutationGeneration;
    const activeLoaderCanNeedMutation = [...this.activeDailyRiskSeedTokens.values()].some(
      (token) => token.tradingDay === args.chargeDay && token.mutationGeneration < generation,
    );
    if (activeLoaderCanNeedMutation) {
      const mutation: FlattenChargeMutation = {
        generation,
        attemptId: args.attemptId,
        previousChargesForDay: previous,
        chargesForDay: current,
      };
      const mutations = this.flattenChargeMutationsByDay.get(args.chargeDay) ?? [];
      mutations.push(mutation);
      this.flattenChargeMutationsByDay.set(args.chargeDay, mutations);
    }
    if (args.chargeDay === this.tradingDay) {
      this.realisedPnlToday = Math.round((this.realisedPnlToday - (current - previous)) * 100) / 100;
      this.evaluateLimits();
    }
  }

  /** Seed durable/reconciled counters before entry is allowed. */
  seedLimits(args: {
    tradingDay: string;
    realisedPnlToday?: number;
    rejects?: number;
    consecutiveFailures?: number;
    openBoxes?: number;
    residualLegs?: number;
    seedToken?: DailyRiskSeedToken | undefined;
    flattenChargeBaselinesForDay?: Record<string, number> | undefined;
    /** The reconstruction may be missing loss rows; see `DailyRiskSeed.incomplete`. */
    incomplete?: boolean | undefined;
  }): void {
    if (args.seedToken && !this.activeDailyRiskSeedTokens.has(args.seedToken.loadGeneration)) {
      // Timed-out/rolled-over loader completion. Its scalar and baselines are no longer allowed to
      // mutate current risk, and its mutation range has already been compacted.
      return;
    }
    this.tradingDay = args.tradingDay;
    const seedPnl = Number.isFinite(args.realisedPnlToday) ? args.realisedPnlToday! : 0;
    this.realisedPnlToday = this.mergePostLoadFlattenCharges(
      args.tradingDay,
      seedPnl,
      args.seedToken,
      args.flattenChargeBaselinesForDay,
    );
    this.rejects = Math.max(0, Math.floor(args.rejects ?? 0));
    this.consecutiveFailures = Math.max(0, Math.floor(args.consecutiveFailures ?? 0));
    this.openBoxes = Math.max(0, Math.floor(args.openBoxes ?? 0));
    this.residualLegs = Math.max(0, Math.floor(args.residualLegs ?? 0));
    // A truncated reconstruction can only understate a loss, which would LOOSEN the daily-loss
    // gate. Counters are still installed so an operator can see them, but the seed is not called
    // healthy, and `canEnter()` already treats anything other than healthy as closed.
    this.health.daily_risk_seed = args.incomplete === true ? "failed" : "healthy";
    if (args.seedToken) this.settleDailyRiskSeedToken(args.seedToken);
    this.evaluateLimits();
  }

  invariantViolation(reason: string): void {
    this.recoveryActive = true;
    this.trip(`execution invariant violation: ${reason}`);
    void this.reconcile().catch(() => undefined);
  }

  setExposure(args: {
    openBoxes?: number;
    residualLegs?: number;
    grossOpenLegQuantity?: number;
  }): void {
    if (args.openBoxes !== undefined) this.openBoxes = Math.max(0, Math.floor(args.openBoxes));
    if (args.residualLegs !== undefined) this.residualLegs = Math.max(0, Math.floor(args.residualLegs));
    if (args.grossOpenLegQuantity !== undefined) {
      this.grossOpenLegQuantity = Math.max(0, Math.floor(args.grossOpenLegQuantity));
    }
    this.evaluateLimits();
  }

  /**
   * Seed signed positions that the caller has already attributed to durable BOX
   * trades/intents. Raw account positions must never be passed here.
   */
  setAttributedBoxPositions(
    positions: Awaited<ReturnType<BrokerAdapter["listPositions"]>>,
    opts: { account?: string | null } = {},
  ): void {
    this.attributedBoxPositions.clear();
    for (const position of positions) {
      this.attributedBoxPositions.set(
        `${position.exchange}:${position.tradingsymbol}`,
        position.net_quantity,
      );
    }
    /*
     * THE SNAPSHOT IS STAMPED WITH THE ACCOUNT IT WAS BUILT UNDER.
     *
     * THE P0 THIS CLOSES (second reproduction in the audit). This map was keyed by
     * `exchange:tradingsymbol` alone, with no account component anywhere — and it is the sole
     * authority for whether a reduction is permitted (`quantityLimitBlockReason` requires the
     * correct side and refuses any overshoot of the attributed net). So a long opened under account
     * A stayed in this map verbatim across a re-login to account B, the side and size checks passed,
     * and an EXIT SELL was authorised against a position the new session does not hold.
     *
     * That SELL does not close A's long. Sent on B's credential it OPENS A SHORT in B.
     *
     * Recording the account for the SNAPSHOT rather than per position is deliberate and sufficient:
     * this method's contract is a set of positions already attributed to durable BOX trades for ONE
     * session, rebuilt in full on every reconciliation pass. There is no legitimate way for one
     * snapshot to span two accounts, so one stamp describes it exactly.
     *
     * Defaulted from the live provider when the caller does not name an account, so the production
     * seam (`engine.syncManagerExposure`) is stamped correctly without every call site restating it.
     */
    this.attributedPositionsAccount = normalizedAccount(
      opts.account !== undefined ? opts.account : this.deps.brokerAccount?.() ?? null,
    );
    this.recalculateGrossAttributedQuantity();
  }

  /**
   * WHY A REDUCTION AGAINST THIS ATTRIBUTED SNAPSHOT MUST BE REFUSED, or null when it may proceed.
   *
   * Blocks ONLY on positive proof that the snapshot belongs to a different account than the one now
   * signed in. Every other case — an unstamped snapshot, an unnameable session — is "cannot tell",
   * and consistent with `exposureReductionBlockReason` and `accountConsistencyBlockReason` that must
   * never refuse: a blocked exit guarantees exposure stays, whereas the broker itself will reject a
   * cancel or exit aimed at an account we are not authenticated for.
   *
   * A KNOWN-different account is the exception, and the only one, because there the request would
   * NOT fail harmlessly at the broker: it would succeed, against the wrong positions.
   */
  private attributedAccountDriftReason(): string | null {
    const owner = this.attributedPositionsAccount;
    if (owner === null) return null;
    // BOTH witnesses. The session provider LAGS a credential swap — that lag is the fence's entire
    // justification — so consulting it alone caught a drift only later, at dispatch, after the reduction
    // had already been planned and reserved. The credential is the authoritative one.
    const dispatch = normalizedAccount(this.deps.adapter.dispatchAccount?.() ?? null);
    if (dispatch !== null && dispatch !== owner) {
      return (
        `The attributed position map was reconciled under broker account ${owner}, but the credential ` +
        `that would send a reduction now belongs to account ${dispatch}. A reduction derived from ` +
        `another account's exposure would not close it — it would open NEW exposure there.`
      );
    }
    const current = normalizedAccount(this.deps.brokerAccount?.() ?? null);
    if (current === null || current === owner) return null;
    return (
      `The attributed position map was reconciled under broker account ${owner}, but this session is ` +
      `signed in as ${current}. A reduction derived from another account's exposure would not close ` +
      `it — it would open NEW exposure here. Sign back into ${owner}, or reconcile explicitly.`
    );
  }

  /**
   * Exact net exposure attributable to durable BOX intents/open projections.
   * Callers may use this for recovery flattening only after reconciliation; raw
   * account positions and tag-only orphans are intentionally absent.
   */
  attributedRecoveryExposure(): ResidualLegExposure[] {
    const out: ResidualLegExposure[] = [];
    for (const [symbol, net] of this.attributedBoxPositions) {
      if (net === 0) continue;
      const intent = [...this.knownIntents.values()].find(
        (candidate) => `${candidate.exchange}:${candidate.tradingsymbol}` === symbol,
      );
      if (!intent) continue;
      out.push({
        token: intent.token,
        tradingsymbol: intent.tradingsymbol,
        exchange: intent.exchange,
        role: intent.role,
        side: net > 0 ? "BUY" : "SELL",
        quantity: Math.abs(net),
        average_price: intent.average_price ?? intent.reference_price,
        source: "partial_entry",
        created_at: intent.updated_at.getTime(),
      });
    }
    return out;
  }

  /**
   * Read one durable order intent by client id.
   *
   * Exposed so residual flattening can resolve its DURABLE attempt generation from the intent
   * journal rather than from an in-memory counter. Read-only, and it never creates an intent.
   */
  findDurableIntent(clientOrderId: string): Promise<IBoxOrderIntent | null> {
    return this.deps.persistence.findByClientId(clientOrderId);
  }

  setFeedHealthy(healthy: boolean): void {
    const now = this.now();
    if (healthy && !this.feedHealthy) this.feedWarmUntil = now + this.deps.limits.feedReconnectWarmupMs;
    if (!healthy) this.feedWarmUntil = Number.POSITIVE_INFINITY;
    this.feedHealthy = healthy;
    this.health.feed = !healthy ? "unhealthy" : now < this.feedWarmUntil ? "warming" : "healthy";
  }

  recordRealisedPnl(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.realisedPnlToday += delta;
    this.evaluateLimits();
  }

  canEnter(request?: BrokerOrderRequest): boolean {
    return this.entryBlockReason(request) === null;
  }

  /**
   * WHY new live entry is refused, or null when it is permitted.
   *
   * Exists so a refusal can be REPORTED rather than inferred from a bare `false`. `canEnter` is now a
   * thin wrapper, so the two can never disagree.
   */
  entryBlockReason(request?: BrokerOrderRequest): string | null {
    this.rollTradingDay();
    this.refreshFeedHealth();
    if (this.disposed) return "The live order manager has been disposed.";
    if (this.breakerReason !== null) return `Circuit breaker open: ${this.breakerReason}`;
    if (!this.controls.entryEnabled) return "box_entry_enabled is off.";
    if (!this.controls.liveOrderEnabled) return "box_live_order_enabled is off.";
    /*
     * THE ACCOUNT MUST BE KNOWN BEFORE A LIVE ENTRY.
     *
     * Previously nothing on the live path could name the account: the engine's account provider
     * always returned null and both stream-ownership registrations hard-coded `account: null`, so the
     * projection's foreign-account rejection could never fire and attribution rested entirely on the
     * per-order tag. An entry that cannot be attributed to a verified account must not be placed.
     */
    if (this.deps.brokerAccount !== undefined) {
      const account = this.deps.brokerAccount() ?? null;
      if (account === null || account.trim() === "") {
        return (
          "The broker account could not be identified from the authenticated session. A live entry " +
          "must be attributable to a verified account before it is placed."
        );
      }
    }
    return this.entryBlockReasonAfterControls(request);
  }

  /** The remaining entry preconditions, unchanged in substance, now each with a named reason. */
  private entryBlockReasonAfterControls(request?: BrokerOrderRequest): string | null {
    if (this.health.persistence !== "healthy") return "Durable persistence is not healthy.";
    if (this.health.daily_risk_seed !== "healthy") return "The daily risk seed is not established.";
    if (!this.health.reconciliation_complete) {
      return "Broker reconciliation is not complete; entry waits until durable and broker state agree.";
    }
    if (this.health.broker_auth !== "healthy") return "Broker authentication is not healthy.";
    if (this.health.broker_orders_api !== "healthy") return "The broker orders API is not healthy.";
    if (this.health.broker_positions_api !== "healthy") return "The broker positions API is not healthy.";
    if (this.unknownOrders > 0) {
      return `${this.unknownOrders} order(s) are in an UNKNOWN state; entry waits until they are resolved.`;
    }
    // An interrupted attempt's legs are still live at the broker and can still fill. Taking NEW
    // exposure on top of exposure whose final size is not yet settled is exactly what must not happen.
    if (this.unattendedWorkingOrders > 0) {
      return (
        `${this.unattendedWorkingOrders} working order(s) from an interrupted attempt are still live at ` +
        `the broker; entry waits until their final quantities are settled.`
      );
    }
    if (this.recoveryActive) return "Recovery is active; entry waits until exposure is resolved.";
    if (this.isCrashRecoveryEntryQuarantined()) {
      return "Crash-recovery quarantine is in force; entry waits until unresolved state is reconciled.";
    }
    if (!this.feedHealthy) return "The market-data feed is not healthy.";
    if (this.now() < this.feedWarmUntil) {
      return "The market-data feed is still warming up after a reconnect.";
    }
    if (this.openBoxes >= this.deps.limits.maxOpenBoxes) {
      return `The open-box limit (${this.deps.limits.maxOpenBoxes}) is reached.`;
    }
    if (this.residualLegs > this.deps.limits.maxResidualLegs) {
      return `${this.residualLegs} residual leg(s) exceed the configured limit; entry waits until they clear.`;
    }
    /*
     * THE ZERODHA STATIC-IP OPERATOR CONFIRMATION — ENFORCEMENT, not reporting.
     *
     * Zerodha requires the public egress IP that sends API order requests to be registered in the
     * Kite developer console. GAR_B cannot verify that whitelist (no authoritative endpoint exists),
     * so this gate records an OPERATOR CONFIRMATION and refuses new live entry without one.
     *
     * It lives HERE, and the location is the substance of the change. `entryBlockReasonAfterControls`
     * is reached only through `canEnter`, which `submit()` consults exclusively under
     * `purpose === "ENTRY"` — the disjoint branch from `purpose !== "ENTRY"`. So this cannot be
     * reached by an EXIT, a PROTECTIVE_CANCEL, an EMERGENCY_RESIDUAL or reconciliation, by
     * construction rather than by convention.
     *
     * That placement is deliberate in contrast to Dhan's `ensureTradingReady()`, which is called from
     * `submitOrder`, `cancelOrder` AND `modifyOrder`. For Dhan that is right — its broker genuinely
     * refuses all three from a non-whitelisted address. It is the wrong home for a LOCAL policy flag:
     * an operator forgetting a confirmation must never stop GAR_B from attempting to reduce exposure
     * it already owns. If the host really is on an unregistered address, Zerodha rejecting the exit
     * is a broker/infrastructure failure to surface and escalate — not a reason to decline to try.
     *
     * A readiness blocker with the same code is published for observability, but readiness is
     * consumed only by `getStatus()` and the runtime-status projection, so it enforces nothing. This
     * line is the enforcement; the two are tested independently on purpose.
     */
    if (!this.deps.limits.zerodhaEntryStaticIpConfirmed && this.deps.broker?.() === "zerodha") {
      return (
        `${ZERODHA_STATIC_IP_UNCONFIRMED}: no operator has confirmed that the public egress IP sending ` +
        `Zerodha order requests is registered in the Kite developer console, so no NEW entry is taken. ` +
        `Set ZERODHA_STATIC_IP_CONFIRMED=true once it is registered. Exits, protective cancels, ` +
        `emergency residual flattening and reconciliation are NOT gated by this.`
      );
    }
    if (request) {
      const quantityBlocked = this.quantityLimitBlockReason(request);
      if (quantityBlocked !== null) return quantityBlocked;
    }
    // Concurrency is enforced by the priority queue's pump. Do not reject the
    // remaining role-orders of the SAME Box pipeline merely because its first
    // role is currently at the broker; those requests must queue so one live Box
    // can submit all four bounded orders under a max-concurrency value of one.
    return null;
  }

  /**
   * MAY THIS PROCESS REDUCE EXPOSURE IT ALREADY OWNS?
   *
   * THE DEFECT THIS REPLACES. This used to be:
   *
   * ```ts
   * return !this.disposed && this.controls.liveOrderEnabled;
   * ```
   *
   * so turning off `box_live_order_enabled` — the natural, obvious operator response to "stop
   * trading" — silently disabled every risk-reduction path at once: `cancelWorkingBoxOrders()`
   * returned `[]` (an empty SUCCESS, indistinguishable from "nothing was working"), and `submit()`
   * refused every EXIT, PROTECTIVE_CANCEL and EMERGENCY_RESIDUAL. It was reproduced with
   * `emergencyFlatten=true`: no working intents were even loaded, and no cancellation was attempted.
   *
   * That is backwards. A control that means "do not take new exposure" must never remove the ability
   * to *shed* exposure already taken; those are opposite directions of risk, and conflating them
   * turns a caution into a trap precisely when an operator is trying to get flat.
   *
   * THE POLICY, enforced identically here, at `submit()`'s dequeue re-check, at the routes and in
   * the coordinator:
   *
   *   - `entryEnabled` / `liveOrderEnabled` gate NEW EXPOSURE ONLY (see {@link canEnter}, which
   *     requires both).
   *   - REDUCTION requires only that this process can still act at all:
   *       * not disposed — a torn-down manager has no transport;
   *       * the broker session is not KNOWN-BAD (`health.broker_auth === "unhealthy"`) — an
   *         unauthenticated client cannot cancel anything, and pretending otherwise would report
   *         success for a request that never left. Note `=== "unhealthy"`, not `!== "healthy"`: an
   *         UNVERIFIED session (boot, pre-reconciliation) must still be able to get flat.
   *
   *     AND EXPLICITLY **NOT** that the ACCOUNT is known. An earlier revision of this list said it
   *     did, and that claim outlived the code by some margin — see the long comment in
   *     {@link exposureReductionBlockReason}, which removed the account block on the grounds that it
   *     was the same defect as this one wearing an identity-shaped costume. `liveBrokerAccount()`
   *     can return null with a perfectly healthy trading session, so making reduction depend on it
   *     would strand exposure. Account identity is enforced where it is real evidence — at the send
   *     boundary and per durable row — and only ever on proof of a DIFFERENT account, never on an
   *     unknown one.
   *   - Ownership, side and attributed-quantity checks remain mandatory and are unchanged: reduction
   *     is still refused unless it genuinely reduces a position this deployment owns
   *     ({@link withinQuantityLimits}, `queuedActionBlockReason`). Nothing here grants any power over
   *     an unrelated manual order or position.
   *
   * Callers that need a REASON rather than a boolean must use {@link exposureReductionBlockReason};
   * returning a bare `false` is what allowed an empty successful-looking result to be published.
   */
  canManageExposure(): boolean {
    return this.exposureReductionBlockReason() === null;
  }

  /**
   * WHY exposure reduction is unavailable, or null when it is available.
   *
   * Every refusal here is a genuine inability to act — not a policy preference. Each is reported
   * verbatim to the operator, because "the cancel did nothing" and "the cancel could not be
   * attempted because the session is unauthenticated" demand completely different responses.
   */
  exposureReductionBlockReason(): string | null {
    if (this.disposed) {
      return "The live order manager has been disposed (process shutting down), so no broker request can be issued.";
    }
    /*
     * NO `rollTradingDay()` HERE, DELIBERATELY.
     *
     * The predecessor of this method (`canManageExposure`) was side-effect free, and an early version
     * of this one called `rollTradingDay()` at this point. That is a real mutation: it resets
     * `realisedPnlToday`, `rejects` and `consecutiveFailures`, sets `daily_risk_seed` back to
     * "seeding", clears `reconciliation_complete`, and kicks off an asynchronous seed load and timer.
     * Since this method is consulted on every reduction submit, every dequeue re-check and every
     * cancel sweep, the first cancel after the IST midnight boundary would perform all of that from
     * inside a synchronous "may I reduce?" guard.
     *
     * A question about whether risk can be shed must not be the thing that rolls the trading day. The
     * roll still happens where it belongs — on the ENTRY path (`entryBlockReasonAfterControls`) and on
     * the periodic reconciliation — both of which fail in the strict direction while it settles.
     */
    /*
     * A *CONFIRMED* AUTH FAILURE BLOCKS. AN UNVERIFIED ONE DOES NOT.
     *
     * Deliberately `=== "unhealthy"` rather than `!== "healthy"`. `broker_auth` only becomes
     * `"healthy"` after a successful reconciliation, so testing for healthy would mean a process that
     * has not yet reconciled — boot, or straight after a restart with exposure open — could not
     * cancel anything. That would be a NEW way to break the panic button, of exactly the kind this
     * whole change exists to remove. An unverified session is allowed to TRY: the broker is the
     * authority and will reject it, which is honest, whereas refusing locally guarantees the exposure
     * stays.
     */
    if (this.health.broker_auth === "unhealthy") {
      return (
        "The broker session is not authenticated, so a cancellation or reduction cannot be sent. " +
        "Sign in to the active broker; exposure is unchanged and still owned."
      );
    }
    /*
     * AN UNNAMEABLE SESSION ACCOUNT IS DELIBERATELY *NOT* A REASON TO REFUSE REDUCTION.
     *
     * An earlier version of this method blocked here when `deps.brokerAccount()` returned null, on
     * the reasoning that a reduction must be attributable. That was the SAME DEFECT as the one this
     * method exists to fix, wearing an identity-shaped costume instead of a control-shaped one:
     * a condition that has nothing to do with our ability to shed risk was allowed to disable every
     * cancel, exit and residual flatten at once.
     *
     * And it is reachable with a perfectly healthy trading session. `liveBrokerAccount()` requires
     * `marketData.isAuthenticated()`, a MARKET-DATA property: on Dhan `DHAN_DATA_ENABLED=false`
     * alone makes it false, and on Zerodha a stored-session adoption can null the session metadata
     * while leaving the access token live. In both, orders would still be accepted by the broker
     * while we refused to send the one kind of order that reduces risk.
     *
     * WHERE OWNERSHIP IS ACTUALLY PROVEN. A reduction may only ever trade against an ATTRIBUTED
     * position (see `quantityLimitBlockReason`, which requires the correct side and refuses any
     * quantity that would overshoot the attributed net), and attribution is established by
     * reconciliation against the broker's own positions. Any mutation derived from a DURABLE ROW is
     * additionally checked by `accountConsistencyBlockReason`, which compares the account recorded
     * ON THAT ROW — evidence that does not depend on the session being able to introduce itself.
     *
     * So the account is enforced where it is real evidence, and it is not permitted to strand
     * exposure. NEW ENTRY is a different matter entirely and remains hard-blocked when the account
     * cannot be named (see `entryBlockReason`): refusing to take new risk is always safe.
     */
    return null;
  }

  canSafelyReduceAttributedExposure(): boolean {
    return this.canManageExposure() && this.safeAttributedReductionReady;
  }

  /**
   * MAY THE CURRENT SESSION ACT ON THIS DURABLE INTENT?
   *
   * Returns null when the intent belongs to the account we are authenticated as, and a reason
   * otherwise. Consulted before any broker mutation derived from a durable row — cancellation,
   * reduction and adoption during reconciliation.
   *
   * IT BLOCKS ONLY ON POSITIVE PROOF OF FOREIGNNESS. Every mutation this guard covers — cancel, exit,
   * residual flatten, adoption — REDUCES or resolves exposure. For that class of operation, refusing
   * on weak evidence is not the cautious choice: a refused cancel GUARANTEES the exposure stays, while
   * an attempted cancel of an order that truly belongs to another account cannot succeed anyway,
   * because the broker scopes cancellation-by-order-id to the authenticated account. So the two error
   * directions are not symmetric, and only one of them can actually hurt.
   *
   * THE CASES:
   *
   *  1. MATCH — proceed.
   *  2. FOREIGN ACCOUNT (both accounts known, and DIFFERENT) — refused outright. This is the case that
   *     had no defence at all: a re-login under the same API key to another account could otherwise
   *     adopt, cancel or flatten the previous account's exposure. Never guess; a human must decide,
   *     because the correct action may be to sign back into the ORIGINAL account.
   *  3. CURRENT ACCOUNT UNNAMEABLE — does NOT block. We can prove nothing either way, and the
   *     condition is reachable with a live trading session (`liveBrokerAccount()` depends on
   *     `marketData.isAuthenticated()`, which on Dhan includes the DATA switch). Blocking here would
   *     disable the panic button on a market-data signal — the exact defect class this file fixes.
   *  4. UNPROVEN ROW (predates migration 011, which deliberately does not backfill) — does NOT block a
   *     reduction. "Probably ours" is not ownership evidence and must never authorise NEW exposure
   *     (entry is gated separately and strictly), but it is ample reason to try to CANCEL something
   *     that our own durable ledger records as working. The null is preserved as UNPROVEN everywhere
   *     it is reported, and counted by the projection's `unverifiedAccount`, rather than being
   *     resolved into a claim.
   */
  /**
   * IS THE CREDENTIAL ABOUT TO SIGN THIS ORDER STILL THE ACCOUNT IT WAS STAMPED UNDER?
   *
   * THE P0 THIS CLOSES. The account was read ONCE, at dequeue, and stamped onto the durable intent
   * before persistence — and then nothing ever checked it again. Between that stamp and the POST the
   * order still had to survive two database round trips, a priority-queue wait, the hedge-first
   * barrier and lazy per-call token resolution. A re-login during ANY of those windows installs a
   * replacement credential synchronously (see `registry.completeZerodhaLogin`), so the request would
   * be signed by account B while the durable row, the attribution and every report said account A.
   *
   * The registry now refuses a different-account login while exposure is unresolved, which removes
   * the ordinary route into this state. This is the second, independent fence: the one that holds at
   * the instant of dispatch, for whatever route remains — a first login with no prior session, a
   * provider-mode token install, a recovery path.
   *
   * TWO INDEPENDENT WITNESSES ARE COMPARED:
   *
   *   - `adapter.dispatchAccount()` — the account behind the credential that will actually sign the
   *     request, read from the same object the token comes from. This is the authoritative one.
   *   - `deps.brokerAccount()` — the session account the rest of the process believes it is. Checked
   *     too, because a disagreement between these two is itself evidence of a mid-flight change.
   *
   * IT BLOCKS ONLY ON POSITIVE PROOF OF DIFFERENCE, matching `accountConsistencyBlockReason` and
   * `exposureReductionBlockReason`. An unproven row, an adapter that cannot name its credential, or
   * an unnameable session are all "cannot tell" — and "cannot tell" must never strand exposure,
   * because a refused EXIT guarantees the position stays. Only a KNOWN-different account refuses.
   */
  private dispatchAccountBlockReason(
    intent: Pick<IBoxOrderIntent, "client_order_id" | "broker_account">,
  ): string | null {
    const stamped = normalizedAccount(intent.broker_account);
    // An unproven row carries no claim that a credential could contradict.
    if (stamped === null) return null;

    const dispatch = normalizedAccount(this.deps.adapter.dispatchAccount?.() ?? null);
    if (dispatch !== null && dispatch !== stamped) {
      return (
        `Order ${intent.client_order_id} was authorised under broker account ${stamped}, but the ` +
        `credential that would send it now belongs to account ${dispatch}. The account changed after ` +
        `this order was authorised, so it must not be transmitted: an order sent to a different ` +
        `account does not act on the exposure it was planned against.`
      );
    }

    const session = normalizedAccount(this.deps.brokerAccount?.() ?? null);
    if (session !== null && session !== stamped) {
      return (
        `Order ${intent.client_order_id} was authorised under broker account ${stamped}, but the ` +
        `active session is now signed in as ${session}. The account changed after this order was ` +
        `authorised, so it must not be transmitted.`
      );
    }
    return null;
  }

  accountConsistencyBlockReason(intent: Pick<IBoxOrderIntent, "client_order_id" | "broker_account">): string | null {
    // Account binding not wired at all (paper / pre-binding construction): there is no account claim
    // to contradict, so ownership rests on the durable BOX client-order-id prefix as it did before.
    if (this.deps.brokerAccount === undefined) return null;
    const current = this.deps.brokerAccount() ?? null;
    // Case 3 — unnameable current account. Not proof of anything; must not strand exposure.
    if (current === null || current.trim() === "") return null;
    const owner = intent.broker_account ?? null;
    // Case 4 — unproven row. Not proof of foreignness.
    if (owner === null || owner.trim() === "") return null;
    if (owner.trim() !== current.trim()) {
      return (
        `Order ${intent.client_order_id} was placed under a DIFFERENT broker account than the one now ` +
        `signed in. This session must not act on another account's exposure — sign back into the ` +
        `account that placed it, or resolve it explicitly.`
      );
    }
    return null;
  }

  submit(
    request: BrokerOrderRequest,
    checkedFeed?: CheckedFeedStamp,
    capital?: EntryCapitalStamp,
    entry?: LiveEntryTransportGuard,
  ): Promise<BrokerOrder> {
    // ENTRY-ONLY GUARD, checked before anything is reserved or enqueued. `entry` is supplied only
    // for ENTRY legs; an EXIT/PROTECTIVE_CANCEL/EMERGENCY_RESIDUAL never carries one and so can
    // never be refused by it.
    const entryGuard = request.purpose === "ENTRY" ? entry : undefined;
    // Registered BEFORE any early return below, so that every rejection path from here on can
    // release this rank and cannot strand a higher-ranked sibling waiting on it.
    if (entryGuard) this.ensureEntryTransportGate(request.attempt_id, entryGuard, request);
    const releaseOnReject = (error: Error): Promise<BrokerOrder> => {
      if (entryGuard) {
        this.decideEntryTransportRank(request, entryGuard, "no_post", error.message, null);
      }
      return Promise.reject(error);
    };
    if (entryGuard) {
      const decision = this.evaluateEntryGuard(request, entryGuard, "pre_enqueue");
      if (!decision.allowed) {
        return releaseOnReject(
          new BrokerPreSubmitRefusedError(request.client_order_id, "dequeue", false, decision.reason),
        );
      }
    }
    if (request.purpose === "ENTRY") {
      // The SPECIFIC reason, not "entry controls or limits are closed". A supervised one-lot attempt
      // that is refused must say which precondition refused it — a quantity envelope too small for
      // four legs, a missing account identity and a paused entry control demand different responses,
      // and the generic message made them indistinguishable in the logs.
      const blocked = this.entryBlockReason(request);
      if (blocked !== null) {
        return releaseOnReject(new Error(`Entry cannot be sent: ${blocked}`));
      }
    }
    if (request.purpose !== "ENTRY") {
      // A REDUCTION carries the specific reason, not a generic "disabled". The old message named a
      // control the operator had deliberately set, which read as intended behaviour rather than as a
      // genuine inability to act.
      const blocked = this.exposureReductionBlockReason();
      if (blocked !== null) {
        return Promise.reject(new Error(`Exposure reduction cannot be sent: ${blocked}`));
      }
    }
    const quantityBlocked = this.quantityLimitBlockReason(request);
    if (quantityBlocked !== null) {
      return releaseOnReject(new Error(quantityBlocked));
    }
    if (this.activeClientIds.has(request.client_order_id)) {
      return releaseOnReject(new Error(`Order ${request.client_order_id} is already queued or active.`));
    }
    this.activeClientIds.add(request.client_order_id);
    if (request.purpose === "ENTRY") {
      this.reservations.set(request.client_order_id, request.quantity);
      // The owning attempt is recorded alongside the reservation so the whole-attempt envelope can
      // net out this attempt's own commitments instead of charging it for itself twice.
      this.reservationAttempts.set(request.client_order_id, request.attempt_id);
      this.reservedEntryQuantity += request.quantity;
    } else if (request.purpose !== "PROTECTIVE_CANCEL") {
      const symbol = `${request.exchange}:${request.tradingsymbol}`;
      this.reductionReservations.set(request.client_order_id, { symbol, quantity: request.quantity });
      this.reservedReductionsBySymbol.set(symbol, (this.reservedReductionsBySymbol.get(symbol) ?? 0) + request.quantity);
      this.reservedReductionQuantity += request.quantity;
    }
    // SCHEDULER ENQUEUE. Recorded here, before the queue push, so `scheduler_wait_ms` measures
    // the real wait rather than starting from whenever the pump happened to look. Fail-open by
    // construction: `beginTrace` swallows everything.
    this.beginTrace(request);
    return new Promise<BrokerOrder>((resolve, reject) => {
      this.queue.push({
        kind: "submit",
        request,
        ...(checkedFeed ? { checkedFeed } : {}),
        ...(capital ? { capital } : {}),
        ...(entryGuard ? { entry: entryGuard } : {}),
        resolve,
        reject,
        sequence: this.sequence++,
      });
      this.sortQueue();
      this.pump();
    });
  }

  /**
   * Open a timing trace for a request and mark the enqueue instant.
   *
   * NEVER THROWS and never affects the return path. Telemetry is not permitted to change whether
   * an order is submitted.
   */
  private beginTrace(request: BrokerOrderRequest): void {
    try {
      const timing = this.deps.timing;
      const broker = this.deps.broker?.();
      // No broker attribution ⇒ no sample. Better to lose a measurement than to file it under
      // the wrong broker and corrupt both distributions.
      if (!timing || !broker) return;
      const trace = timing.trace(request.client_order_id, {
        broker,
        purpose: request.purpose,
        role: request.role,
        tradeId: request.trade_id,
        attemptId: request.attempt_id,
        requestedQty: request.quantity,
      });
      trace?.setKind(kindForPurpose(request.purpose));
      trace?.mark("scheduler_enqueued");
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /**
   * INDEPENDENT OVERFILL TRIPWIRE — route an observed broker snapshot through this order's
   * SECOND, redundant fill ledger whose SOLE purpose is to trip the breaker on an overfill.
   *
   * This is deliberately NOT the projection of truth (that is the order-stream consumer's
   * {@link OrderUpdateProjection}, fed by `noteStreamBrokerSnapshot` on this SAME code path). It is
   * an adversarial cross-check: it shares no state with the projection, so a bug in either one is
   * caught by the other. Because both are idempotent, monotonic and fed the same cumulative
   * snapshot, they can never disagree about attributed cumulative quantity (pinned by
   * tests/box/fillLedgerTwoStores.test.mjs).
   *
   * THE INVARIANTS THIS ENFORCES (Phase 6 / Phase 29):
   *
   *  - a duplicate broker event contributes zero quantity (identity dedupe);
   *  - an out-of-order or re-polled snapshot cannot reduce the cumulative total;
   *  - an overfill — the broker reporting more filled than we asked for — TRIPS THE BREAKER
   *    rather than being clamped away, because it means our own quantity model is wrong and
   *    every downstream exposure number is suspect.
   *
   * Fail-open with respect to the ledger itself: a bookkeeping failure must not block
   * persistence of a real fill. It is emphatically NOT fail-open with respect to the overfill
   * finding, which is a safety signal.
   */
  private checkOverfillTripwire(order: BrokerOrder): void {
    let overfill: { cumulative: number; requested: number } | null = null;
    try {
      let ledger = this.overfillTripwireLedgers.get(order.client_order_id);
      if (!ledger) {
        ledger = new CumulativeFillLedger(order.client_order_id, order.quantity);
        this.overfillTripwireLedgers.set(order.client_order_id, ledger);
      }
      const result = ledger.apply({
        cumulativeQty: order.filled_quantity,
        averagePrice: order.average_price,
        // The newest fill identity the adapter surfaced. Kite synthesises one per distinct
        // cumulative quantity and Dhan supplies the exchange trade id; either way a repeated
        // poll of an unchanged order yields the same identity and is correctly ignored.
        eventId: order.fills.at(-1)?.fill_id ?? null,
        observedAtWall: order.updated_at,
        source: "rest_poll",
      });
      if (result.outcome === "applied_overfill") {
        overfill = { cumulative: result.cumulative, requested: ledger.requestedQty };
      }
    } catch {
      /* bookkeeping must not block persistence of a confirmed fill */
    }
    if (overfill) {
      this.trip(
        `broker reported ${overfill.cumulative} filled for ${order.client_order_id}, exceeding the ${overfill.requested} requested`,
      );
    }
  }

  /**
   * The overfill-tripwire ledger's cumulative for an order, or `undefined` if none exists.
   *
   * READ-ONLY DIAGNOSTIC (audit D3). Exposed only so a test can pin the invariant that the
   * independent overfill tripwire and the order-stream consumer's projection of truth NEVER
   * disagree about attributed cumulative quantity — both are fed the same cumulative snapshots and
   * are idempotent+monotonic, so they must always match. It is not part of any decision path.
   */
  overfillTripwireCumulative(clientOrderId: string): number | undefined {
    return this.overfillTripwireLedgers.get(clientOrderId)?.cumulative;
  }

  /** Report a real broker rejection for statistics. Fail-open. */
  private noteBrokerReject(order: BrokerOrder | null, reason: string): void {
    try {
      this.deps.onBrokerReject?.(order, reason);
    } catch {
      /* diagnostics must never change rejection handling */
    }
  }

  /** Mark a stage on a request's trace. Fail-open; a no-op when instrumentation is off. */
  private markTiming(clientOrderId: string, stage: Parameters<ExecutionTimingRecorder["mark"]>[1]): void {
    try {
      this.deps.timing?.mark(clientOrderId, stage);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /**
   * Publish an order's timing once it is terminal.
   *
   * Called from the terminal paths only. Idempotent in the recorder, so an order whose terminal
   * state is witnessed by both the adapter and the reconciler contributes exactly one sample.
   */
  private publishTiming(clientOrderId: string): void {
    try {
      this.deps.timing?.publish(clientOrderId);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /**
   * CANCEL EVERY WORKING BOX ORDER, and report honestly what happened.
   *
   * THE DEFECT THIS REPLACES. The old signature was `Promise<BrokerOrder[]>` and the body opened
   * with `if (!this.canManageExposure()) return [];`. The route published that as
   * `{ ok: true, orders: [] }` — HTTP 200. So with `box_live_order_enabled` off, the operator's panic
   * button reported a clean sweep while **no intent was even loaded and no cancellation was
   * attempted**. An empty array is also what a genuinely quiet account returns, so the two were
   * indistinguishable.
   *
   * It now returns a RESULT, and the three outcomes are separable:
   *   - `blocked_reason !== null`  — nothing was attempted, and why. `ok` is false.
   *   - `failures.length > 0`      — attempted and some could not be cancelled. `ok` is false.
   *   - `cancelled` + `eligible`   — what was attempted and what the broker confirmed.
   *
   * `eligible === 0` with `blocked_reason === null` is the only case that legitimately means
   * "there was nothing to cancel", and it is now distinguishable from every failure.
   */
  async cancelWorkingBoxOrders(): Promise<CancelWorkingBoxOrdersResult> {
    const blocked = this.exposureReductionBlockReason();
    if (blocked !== null) {
      // NOT an empty success. Loud in the log too, because a refused panic button is an incident.
      console.error(`[BoxOrderManager] cancel-working REFUSED, nothing attempted: ${blocked}`);
      return {
        ok: false,
        attempted: false,
        blocked_reason: blocked,
        examined: 0,
        eligible: 0,
        cancelled: [],
        failures: [],
      };
    }
    const intents = await this.deps.persistence.loadNonterminal();
    const cancelled: BrokerOrder[] = [];
    const failures: string[] = [];
    let eligible = 0;
    for (const intent of intents) {
      // Only durable BOX intents are eligible. Never cancel arbitrary broker orders.
      if (!intent.client_order_id.startsWith("BOX:")) continue;
      eligible++;
      /*
       * OWNERSHIP BEFORE CANCELLATION.
       *
       * A cancel is a real broker mutation, so it must be attributable. An intent belonging to
       * another account — or one whose account is unproven — is reported as a FAILURE rather than
       * skipped silently: the operator needs to know that quantity may still be working and that a
       * human decision is required, not to see it quietly excluded from the sweep.
       */
      const foreign = this.accountConsistencyBlockReason(intent);
      if (foreign !== null) {
        failures.push(`${intent.client_order_id}: ${foreign}`);
        continue;
      }
      // One leg's cancel MUST NOT abandon the others. `enqueueCancel` rejects on any adapter
      // error, and an ambiguous or slow cancel is exactly the situation in which this method is
      // called — so letting the rejection escape the loop meant the first troublesome leg
      // prevented legs 2-4 from ever being enqueued, leaving them working at the broker while the
      // operator's panic button reported a flat failure. Every eligible intent now gets its own
      // attempt, and the failures are surfaced after all of them have been tried.
      try {
        const order = await this.enqueueCancel(intent);
        if (order) cancelled.push(order);
        // BELT AND BRACES. `executeCancel` now raises `BrokerCancelUnresolvedError` rather than
        // resolving undefined, so this branch should be unreachable — but an intent counted as
        // ELIGIBLE and then reported in NEITHER `cancelled` nor `failures` is exactly the shape that
        // produced a green `ok: true` while nothing was cancelled. If it ever happens again it must
        // be visible, not silent.
        else if (intent.broker_order_id) {
          // Only an intent that DID reach the broker can be genuinely unresolved. A never-posted row is
          // resolved by `executeCancel` and deliberately reported as nothing-to-cancel.
          failures.push(
            `${intent.client_order_id}: the cancellation produced no broker outcome, so whether the ` +
              "order is still working is UNKNOWN. Reconcile, or cancel it broker-side.",
          );
        }
      } catch (error) {
        failures.push(`${intent.client_order_id}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      // Loud, and not thrown: the caller needs the list of what WAS cancelled far more than it
      // needs an exception, and a half-completed cancel sweep must never look like a clean one.
      this.invariantViolation(
        `cancel-working sweep left ${failures.length} order(s) uncancelled: ${failures.join("; ")}`,
      );
    }
    return {
      // `ok` means "every eligible intent was attempted and none failed". It does NOT claim the
      // broker has no remaining quantity — a cancellation acknowledgement is not proof that the
      // remaining quantity was cancelled, which is why the durable snapshot is what `cancelled`
      // carries and why reconciliation still runs.
      ok: failures.length === 0,
      attempted: true,
      blocked_reason: null,
      examined: intents.length,
      eligible,
      cancelled,
      failures,
    };
  }

  reconcile(): Promise<OrderManagerReconcileReport> {
    this.rollTradingDay();
    if (this.health.daily_risk_seed !== "healthy") this.refreshDailyRiskSeed();
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.performReconcile().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  status(): OrderManagerStatus {
    this.rollTradingDay();
    this.refreshFeedHealth();
    return {
      controls: { ...this.controls },
      health: { ...this.health },
      circuitBreaker: {
        tripped: this.breakerReason !== null,
        reason: this.breakerReason,
        at: this.breakerAt,
      },
      inFlight: this.inFlight,
      queued: this.queue.length,
      reservedEntryQuantity: this.reservedEntryQuantity,
      reservedReductionQuantity: this.reservedReductionQuantity,
      unknownOrders: this.unknownOrders,
      unattendedWorkingOrders: this.unattendedWorkingOrders,
      staleReconcilePasses: this.staleReconcilePasses,
      recoveryActive: this.recoveryActive,
      safeAttributedReductionReady: this.safeAttributedReductionReady,
      crashRecoveryEntryQuarantined: this.isCrashRecoveryEntryQuarantined(),
      tradingDay: this.tradingDay,
      riskBookkeeping: {
        activeSeedTokens: this.activeDailyRiskSeedTokens.size,
        activeLoadGeneration: this.activeDailyRiskLoad?.generation ?? null,
        retainedMutationCount: [...this.flattenChargeMutationsByDay.values()]
          .reduce((sum, mutations) => sum + mutations.length, 0),
        retainedMutationDayBuckets: this.flattenChargeMutationsByDay.size,
      },
      rejects: this.rejects,
      consecutiveFailures: this.consecutiveFailures,
      realisedPnlToday: this.realisedPnlToday,
      residualLegs: this.residualLegs,
      openBoxes: this.openBoxes,
      orphanOrders: this.orphanOrders.map(cloneOrder),
      lastReconciledAt: this.lastReconciledAt,
      durableTransitionRefusals: this.durableTransitionRefusals,
      coherenceDegradedAfterExposure: this.coherenceDegradedAfterExposure,
      lastCoherenceDegradation: this.lastCoherenceDegradation,
      economicEvidenceDegradedAfterExposure: this.economicEvidenceDegradedAfterExposure,
      lastEconomicEvidenceDegradation: this.lastEconomicEvidenceDegradation,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.activeDailyRiskLoad) {
      this.seedTimer().clearTimeout(this.activeDailyRiskLoad.timeout);
      this.activeDailyRiskLoad = null;
    }
    this.activeDailyRiskSeedTokens.clear();
    this.flattenChargeMutationsByDay.clear();
    // Wake anything parked on the hedge-first barrier BEFORE rejecting the queue, so a disposed
    // manager can never leave an entry leg awaiting a sibling that will now never run. The woken
    // leg re-checks the guard, sees `disposed`, and terminalizes without POSTing.
    this.drainEntryTransportGates();
    for (const action of this.queue.splice(0)) {
      if (action.kind === "submit") {
        this.activeClientIds.delete(action.request.client_order_id);
        this.releaseReservation(action.request.client_order_id);
      }
      action.reject(new Error("OrderManager disposed before broker action."));
    }
  }

  private enqueueCancel(intent: IBoxOrderIntent): Promise<BrokerOrder | undefined> {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: "cancel", intent, resolve, reject, sequence: this.sequence++ });
      this.sortQueue();
      this.pump();
    });
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => queuePriority(a) - queuePriority(b) || a.sequence - b.sequence);
  }

  /** The purpose an action is scheduled under. A bare cancel is a PROTECTIVE_CANCEL. */
  private static purposeOf(action: QueueAction): BoxOrderPurpose {
    return action.kind === "cancel" ? "PROTECTIVE_CANCEL" : action.request.purpose;
  }

  /** The Box pipeline an action belongs to. */
  private static attemptOf(action: QueueAction): string {
    return action.kind === "cancel" ? action.intent.attempt_id : action.request.attempt_id;
  }

  /** Current slot occupancy, in the shape the shared admission policy expects. */
  private occupancy(): BoxSchedulingOccupancy {
    return {
      baseInFlight: this.baseInFlight,
      burstInFlight: this.burstInFlight,
      entryAttemptId: this.entryAttemptInFlight,
      nonEntryInFlight: this.nonEntryInFlight,
    };
  }

  private pump(): void {
    while (!this.disposed && this.queue.length > 0) {
      // PEEK, never shift-then-requeue. The queue is priority-sorted, so if the head cannot be
      // admitted we must STOP rather than look further down: admitting a lower-priority ENTRY
      // ahead of a blocked EMERGENCY_RESIDUAL would invert BOX_ORDER_PRIORITY.
      const action = this.queue[0];
      if (!action) return;
      const verdict = admitBoxOperation({
        request: {
          purpose: BoxOrderManager.purposeOf(action),
          attemptId: BoxOrderManager.attemptOf(action),
        },
        occupancy: this.occupancy(),
        baseConcurrency: this.deps.limits.maxConcurrentExecutions,
        entrySubmitConcurrency: clampEntrySubmitConcurrency(this.deps.limits.entrySubmitConcurrency),
      });
      if (!verdict.admit) return;
      this.queue.shift();

      /*
       * THE DEQUEUE REFUSAL IS THE ONE EXIT THAT BYPASSES `execute()` ENTIRELY.
       *
       * `execute()`'s `finally` releases the hedge-first rank on every path out of it, and
       * `releaseOnReject` covers the synchronous refusals in `submit()`. This path was covered by
       * neither, so an ENTRY leg refused HERE never decided its rank. Two consequences:
       *
       *   - `entryAllRanksDecided` could never become true, so the `EntryTransportGate` and its
       *     `HedgeCoverageLedger` leaked, one per affected attempt, for the life of the process;
       *   - if the refused rank was a HEDGE and a dependent uncovered SELL was already parked in
       *     `awaitEntryTransportTurn`, `entryHedgesDecided` could never become true either, so the
       *     SELL was never woken. Its `execute()` never returns, so the scheduling slot,
       *     `entryAttemptInFlight`, its reservation and its `activeClientIds` entry are all held
       *     forever, the pump can admit nothing further, and the gateway's `Promise.allSettled`
       *     never settles — leaving a filled BUY hedge unattended with no legging record and no
       *     partial-entry recovery.
       *
       * The block is also wrapped, because `queuedActionBlockReason` consults injected providers
       * (`brokerAccount()`, the capital authority). A throw here previously dropped an already
       * SHIFTED action with neither resolve nor reject — a caller that waits forever, a permanently
       * leaked reservation, and an unhandled rejection out of the `finally`-driven re-entry that
       * STOPPED the pump, parking every queued EXIT and EMERGENCY_RESIDUAL behind it. A guard that
       * asks "may I proceed?" must fail closed, not fail silent.
       */
      let blocked: string | null;
      try {
        blocked = this.queuedActionBlockReason(action);
      } catch (error) {
        blocked = `the dequeue re-check could not be evaluated: ${errorMessage(error)}`;
      }
      if (blocked) {
        if (action.kind === "submit") {
          this.activeClientIds.delete(action.request.client_order_id);
          this.releaseReservation(action.request.client_order_id);
          // Release the hedge-first rank so a dependent sibling cannot park on it forever.
          if (action.entry) {
            this.decideEntryTransportRank(action.request, action.entry, "no_post", blocked, null);
          }
        }
        action.reject(new Error(blocked));
        continue;
      }
      // SCHEDULER DEQUEUE. A concurrency slot has been acquired and the operation is about to
      // reach the broker, so this closes `scheduler_wait_ms` and opens `transport_wait_ms`.
      this.markTiming(
        action.kind === "submit" ? action.request.client_order_id : action.intent.client_order_id,
        "scheduler_dequeued",
      );
      this.occupySlot(action, verdict.slot);
      const execution = action.kind === "submit"
        ? this.execute(action)
        : this.executeCancel(action);
      void execution.finally(() => {
        this.releaseSlot(action, verdict.slot);
        if (action.kind === "submit") {
          const known = this.knownIntents.get(action.request.client_order_id);
          if (!known || !RECONCILE_STATES.has(known.state)) {
            this.releaseReservation(action.request.client_order_id);
          }
          this.activeClientIds.delete(action.request.client_order_id);
        }
        this.pump();
      });
    }
  }

  /** Take a scheduling slot. Paired with {@link releaseSlot} in the execution's `finally`. */
  private occupySlot(action: QueueAction, slot: BoxSchedulingSlot): void {
    this.inFlight++;
    if (slot === "base") this.baseInFlight++;
    else {
      this.burstInFlight++;
      this.entryBurstGrants++;
    }
    if (BoxOrderManager.purposeOf(action) === "ENTRY") {
      this.entryInFlight++;
      this.entryAttemptInFlight = BoxOrderManager.attemptOf(action);
      if (this.entryInFlight > this.peakEntryBurstWidth) this.peakEntryBurstWidth = this.entryInFlight;
    } else {
      this.nonEntryInFlight++;
    }
  }

  /** Give a scheduling slot back. Clamped at zero so a double release cannot corrupt admission. */
  private releaseSlot(action: QueueAction, slot: BoxSchedulingSlot): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (slot === "base") this.baseInFlight = Math.max(0, this.baseInFlight - 1);
    else this.burstInFlight = Math.max(0, this.burstInFlight - 1);
    if (BoxOrderManager.purposeOf(action) === "ENTRY") {
      this.entryInFlight = Math.max(0, this.entryInFlight - 1);
      // The pipeline owns the ENTRY slot set only while at least one of its legs is in flight.
      // Clearing at zero is what lets the NEXT candidate start once this Box is fully settled.
      if (this.entryInFlight === 0) this.entryAttemptInFlight = null;
    } else {
      this.nonEntryInFlight = Math.max(0, this.nonEntryInFlight - 1);
    }
  }

  /** Entry-burst observations for diagnostics. Bounded, low-cardinality. */
  entryBurstDiagnostics(): {
    configured_entry_submit_concurrency: number;
    base_concurrency: number;
    peak_entry_submissions_in_flight: number;
    burst_slot_grants: number;
    base_in_flight: number;
    burst_in_flight: number;
    entry_attempt_in_flight: string | null;
  } {
    return {
      configured_entry_submit_concurrency: clampEntrySubmitConcurrency(this.deps.limits.entrySubmitConcurrency),
      base_concurrency: this.deps.limits.maxConcurrentExecutions,
      peak_entry_submissions_in_flight: this.peakEntryBurstWidth,
      burst_slot_grants: this.entryBurstGrants,
      base_in_flight: this.baseInFlight,
      burst_in_flight: this.burstInFlight,
      entry_attempt_in_flight: this.entryAttemptInFlight,
    };
  }

  /**
   * RE-VERIFY the per-Box ₹ cap at dequeue — the last safe moment before a broker mutation.
   *
   * Three distinct refusals, and the middle one is the important one:
   *
   *   - cap disabled ⇒ no opinion, exactly as before this feature existed.
   *   - cap enabled but NO STAMP ⇒ REFUSE. An ENTRY that reached the queue without a capital
   *     decision cannot be proven compliant, and an unprovable safety gate is not a safety
   *     gate. This is what stops a new ENTRY submission path from silently bypassing the cap.
   *   - stamped notional over the cap ⇒ REFUSE. Catches the case where the cap was tightened,
   *     or the request set rebuilt, between admission and transmission.
   *
   * Deliberately reached ONLY for `purpose === "ENTRY"`. An EXIT, PROTECTIVE_CANCEL or
   * EMERGENCY_RESIDUAL reduces exposure we already own, and a capital cap on new exposure must
   * never be able to prevent that.
   */
  private capitalBlockReason(action: SubmitQueueAction): string | null {
    const limit = this.deps.limits.maxBoxCapitalRupees;
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const stamp = action.capital;
    if (!stamp) {
      return "Box capital evidence is missing; entry refused because the per-Box ₹ cap cannot be verified.";
    }
    const limitPaise = Math.round(limit * 100);
    if (stamp.box_notional_paise > limitPaise) {
      return (
        `Box gross entry-order notional ₹${(stamp.box_notional_paise / 100).toFixed(2)} exceeded the ` +
        `₹${limit} per-Box cap while the order was queued.`
      );
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /*  Live ENTRY ownership guard + hedge-first transport sequencing       */
  /* ------------------------------------------------------------------ */

  /**
   * Evaluate the composed ENTRY permission at one checkpoint.
   *
   * Gathers the facts only this layer can see (controls, breaker, full `canEnter` admission, the
   * attempt's hedge state) and delegates the DECISION to the pure
   * {@link evaluateLiveEntryGuard}, so all five checkpoints share one rule.
   *
   * NEVER called for a non-ENTRY purpose — the callers gate on `purpose === "ENTRY"` — which is
   * what keeps exits, protective cancels and residual flattening immune from every condition here.
   */
  private evaluateEntryGuard(
    request: BrokerOrderRequest,
    guard: LiveEntryTransportGuard,
    stage: LiveEntryGuardStage,
  ): LiveEntryGuardDecision {
    const gate = this.entryTransportGates.get(request.attempt_id);
    const decision = evaluateLiveEntryGuard({
      stage,
      stillWanted: stillWantedSafely(guard.stillWanted),
      entryEnabled: this.controls.entryEnabled,
      liveOrderEntryEnabled: this.controls.liveOrderEnabled,
      circuitClosed: this.breakerReason === null,
      // `pre_enqueue` runs before `canEnter` is consulted by `submit` itself, so it must not
      // pre-empt that check's own distinct error; the later stages assert it fully.
      entryAdmissible: stage === "pre_enqueue" ? true : this.canEnter(request),
      attemptAborted: null,
      // COVERAGE PERMISSION. A hedge leg depends on no coverage, so it passes `null`. A dependent
      // uncovered SELL must PROVE its hedges: `null` here is a positive verdict from the ledger
      // that every BUY hedge of this attempt filled its full required quantity on the right
      // contract/side/account; any non-null value is the specific reason coverage is unproven and
      // BLOCKS the SELL. This inverts the old "no named failure ⇒ permitted" behaviour that let a
      // CANCELLED/zero-fill hedge authorise a naked SELL.
      hedgeCoverageGap: guard.hedge ? null : this.entryHedgeCoverageGap(request, gate, stage),
      // CROSS-LEG COHERENCE at the final boundary only, and only while this attempt has taken NO
      // exposure. See `entryCrossLegCoherenceGap`.
      crossLegCoherenceGap: this.entryCrossLegCoherenceGap(guard, gate, stage),
      // ECONOMIC EVIDENCE at the final boundary only, and only while this attempt has taken NO
      // exposure. Same exposure-aware policy as coherence: refusing a leg after siblings have
      // POSTed would manufacture a partial entry. See `entryEconomicEvidenceGap`.
      economicEvidenceGap: this.entryEconomicEvidenceGap(request, guard, gate, stage),
    });
    if (!decision.allowed) {
      this.entryGuardRefusals.set(stage, (this.entryGuardRefusals.get(stage) ?? 0) + 1);
    }
    return decision;
  }

  /**
   * The coverage gap a dependent uncovered SELL must clear before it may POST, or null when every
   * BUY hedge of the attempt is PROVEN to cover it.
   *
   * FAIL CLOSED at every uncertain edge:
   *   • No gate at all ⇒ no proof of any hedge ⇒ blocked.
   *   • Fewer registered hedge requirements than the attempt's `hedgeCount` ⇒ a hedge has not even
   *     declared its identity yet, so its coverage cannot be proven ⇒ blocked.
   *   • Otherwise the ledger is asked for POSITIVE proof of full fill on every hedge; the first
   *     unproven hedge's reason is returned.
   *
   * This is the exact inversion the defect requires: permission needs proof, not the mere absence
   * of a named failure.
   */
  private entryHedgeCoverageGap(
    request: BrokerOrderRequest,
    gate: EntryTransportGate | undefined,
    stage: LiveEntryGuardStage,
  ): string | null {
    // TIMING — coverage is only knowable AFTER the hedge-first barrier. A dependent SELL passes
    // through pre_build/pre_enqueue/dequeue/post_persist BEFORE it parks on the barrier
    // ({@link awaitEntryTransportTurn}); at those points its hedges have not yet decided and
    // coverage is legitimately unproven. Enforcing there would refuse every SELL before it ever
    // waited for its hedges. The barrier guarantees that by the time `pre_post` runs — the final
    // boundary, immediately before the HTTP POST — every BUY hedge rank HAS decided, so this is the
    // one and only checkpoint at which a proven-coverage verdict is both meaningful and safe. The
    // earlier stages still enforce ownership, arm, breaker and admission exactly as before.
    if (stage !== "pre_post") return null;
    if (!gate) {
      return `no transport gate for attempt ${request.attempt_id}; hedge coverage is unprovable`;
    }
    const hedgeCount = gate.hedgeCount;
    const requirements: HedgeRequirement[] = [];
    for (let rank = 0; rank < hedgeCount; rank++) {
      const req = gate.hedgeRequirements.get(rank);
      if (!req) {
        return `hedge rank ${rank} has not declared its identity for attempt ${request.attempt_id}; coverage is unprovable`;
      }
      requirements.push(req);
    }
    // Single-use, attempt-scoped attribution: claim the coverage set for THIS dependent. The claim
    // only succeeds when the set is fully covered, and prevents one hedge fill from being reused to
    // back an incompatible dependent under a future multi-lot profile.
    if (!gate.coverage.claimCoverage(request.role, requirements)) {
      return gate.coverage.coverageGapFor(requirements) ?? "hedge coverage could not be claimed";
    }
    return null;
  }

  /**
   * The cross-leg coherence objection at the FINAL send boundary, or null to proceed.
   *
   * DEFECT C. The gateway checks four-leg coherence twice, both BEFORE the manager is called. A leg
   * then waits — queued, persisted, parked on the hedge-first barrier, paced by the adapter — and
   * the books can deteriorate throughout. Per-leg freshness cannot see it: four books can each be
   * young while being young at four DIFFERENT instants. This carries the check into the one place
   * that is actually the send boundary.
   *
   * TWO DELIBERATE RESTRICTIONS:
   *
   *  1. `pre_post` ONLY. Earlier checkpoints are already covered by the gateway's own pre-enqueue
   *     evaluation, and re-refusing there would just duplicate a decision with a worse reason.
   *
   *  2. NO EXPOSURE ONLY. If any leg of this attempt has already POSTed, the attempt COMPLETES the
   *     hedged box instead. Refusing leg 4 after legs 1-3 reached the broker manufactures a partial
   *     entry and a real recovery cost, whereas a complete box is hedged by construction and the
   *     post-fill economics gate already unwinds one that turned out uneconomic. The degradation is
   *     still recorded on the attempt's diagnostics, so it is never silently discarded.
   *
   * A callback that THROWS has told us nothing, and nothing is not permission — but it is also not
   * proof of incoherence, and failing an ENTRY closed on a diagnostic bug would be its own defect.
   * A throw is therefore treated as an explicit objection, matching `stillWantedSafely`.
   */
  private entryCrossLegCoherenceGap(
    guard: LiveEntryTransportGuard,
    gate: EntryTransportGate | undefined,
    stage: LiveEntryGuardStage,
  ): string | null {
    if (stage !== "pre_post") return null;
    if (guard.sendBoundaryCoherence === undefined) return null;
    const alreadyExposed = gate !== undefined &&
      [...gate.decided.values()].some((outcome) => outcome === "posted");
    if (alreadyExposed) {
      // COMPLETION POLICY. Record it, do not refuse it.
      try {
        const gap = guard.sendBoundaryCoherence();
        if (gap !== null) {
          this.coherenceDegradedAfterExposure++;
          this.lastCoherenceDegradation = gap;
        }
      } catch {
        this.coherenceDegradedAfterExposure++;
      }
      return null;
    }
    try {
      return guard.sendBoundaryCoherence();
    } catch (error) {
      return `cross-leg coherence could not be evaluated: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * The FUNDS/MARGIN EVIDENCE gap at the final send boundary, or null when it still applies.
   *
   * Section 3 requirement 12/13, and the exact mirror of {@link entryCrossLegCoherenceGap}:
   *
   *  1. `pre_post` ONLY. Earlier checkpoints re-verify ownership and admission; the evidence
   *     expiry question only becomes meaningful at the boundary where the POST would happen.
   *  2. NO EXPOSURE ONLY (requirement 13: an explicit recovery policy, not blind re-admission). If
   *     any leg of this attempt has already POSTed, the attempt COMPLETES the hedged box and the
   *     degradation is RECORDED. Refusing leg 4 because a funds figure aged out would leave an
   *     unhedged partial that costs real money to unwind — strictly worse than completing a hedged
   *     box whose post-fill economics gate can still unwind it.
   *  3. A THROWING callback is an explicit objection, not silent permission — matching
   *     `stillWantedSafely` and the coherence check.
   *
   * The request about to be transmitted is passed through so the gateway can compare it against the
   * order plan its margin evidence was fetched for.
   */
  private entryEconomicEvidenceGap(
    request: BrokerOrderRequest,
    guard: LiveEntryTransportGuard,
    gate: EntryTransportGate | undefined,
    stage: LiveEntryGuardStage,
  ): string | null {
    if (stage !== "pre_post") return null;
    if (guard.sendBoundaryEconomics === undefined) return null;
    const alreadyExposed = gate !== undefined &&
      [...gate.decided.values()].some((outcome) => outcome === "posted");
    if (alreadyExposed) {
      try {
        const gap = guard.sendBoundaryEconomics(request);
        if (gap !== null) {
          this.economicEvidenceDegradedAfterExposure++;
          this.lastEconomicEvidenceDegradation = gap;
        }
      } catch {
        this.economicEvidenceDegradedAfterExposure++;
      }
      return null;
    }
    try {
      return guard.sendBoundaryEconomics(request);
    } catch (error) {
      return `funds/margin evidence could not be re-evaluated: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** {@link evaluateEntryGuard} as a reason string, matching the `*BlockReason` convention. */
  private entryGuardBlockReason(
    request: BrokerOrderRequest,
    guard: LiveEntryTransportGuard,
    stage: LiveEntryGuardStage,
  ): string | null {
    const decision = this.evaluateEntryGuard(request, guard, stage);
    return decision.allowed ? null : decision.reason;
  }

  /** ENTRY legs refused by the composed ownership guard, by checkpoint. Diagnostics only. */
  entryGuardDiagnostics(): Record<LiveEntryGuardStage, number> {
    return {
      pre_build: this.entryGuardRefusals.get("pre_build") ?? 0,
      post_evidence: this.entryGuardRefusals.get("post_evidence") ?? 0,
      pre_enqueue: this.entryGuardRefusals.get("pre_enqueue") ?? 0,
      dequeue: this.entryGuardRefusals.get("dequeue") ?? 0,
      post_persist: this.entryGuardRefusals.get("post_persist") ?? 0,
      pre_post: this.entryGuardRefusals.get("pre_post") ?? 0,
    };
  }

  /** Create (or fetch) the transport gate for one entry attempt, and register this leg's rank. */
  private ensureEntryTransportGate(
    attemptId: string,
    guard: LiveEntryTransportGuard,
    request: BrokerOrderRequest,
  ): EntryTransportGate {
    let gate = this.entryTransportGates.get(attemptId);
    if (!gate) {
      gate = {
        registered: new Set(),
        decided: new Map(),
        waiters: [],
        hedgeFailure: null,
        coverage: new HedgeCoverageLedger(attemptId),
        hedgeRequirements: new Map(),
        hedgeCount: guard.hedgeCount,
        // Captured ONCE, here, and used by every leg of this attempt. See the field's doc comment.
        brokerAccountKey: this.brokerAccountKey(),
      };
      this.entryTransportGates.set(attemptId, gate);
    }
    gate.registered.add(guard.transportRank);
    // Every leg of one attempt reports the same count; take the largest seen so a mis-supplied
    // smaller value can never shrink the set of hedges a SELL must wait for.
    gate.hedgeCount = Math.max(gate.hedgeCount, guard.hedgeCount);
    // A BUY hedge DECLARES the exact coverage a dependent SELL must later prove: this contract,
    // this side, this account, this full quantity. Recorded at registration (before the POST) so
    // the requirement exists independently of, and cannot be forged by, the outcome. A dependent
    // SELL that finds no requirement for a hedge rank therefore fails closed.
    if (guard.hedge) {
      gate.hedgeRequirements.set(guard.transportRank, {
        attempt_id: attemptId,
        role: request.role,
        token: request.token,
        tradingsymbol: request.tradingsymbol,
        side: request.side,
        // The gate's FROZEN key, not a live read — see EntryTransportGate.brokerAccountKey.
        broker_account: gate.brokerAccountKey,
        required_quantity: request.quantity,
      });
    }
    return gate;
  }

  /**
   * A stable key for the broker/account the manager posts through.
   *
   * WHAT THIS USED TO BE, and why it was not enough:
   *
   * ```ts
   * return `broker:${this.deps.adapter.mode}`;      // → "broker:live"
   * ```
   *
   * The adapter interface exposes only `mode`, so the key was the adapter MODE, not an account. The
   * hedge-coverage ledger stamps this on both the hedge REQUIREMENT and the hedge OUTCOME evidence,
   * and documents that "coverage is not fungible across accounts" — but with a constant on both
   * sides that axis was degenerate: it could never disagree, so the invariant constrained nothing.
   * Harmless in a single-account deployment, and misleading precisely because it looked satisfied.
   *
   * Now that the account provider is wired (the same one that stamps `broker_account` on every
   * durable intent), the real account is used when it can be named, so the ledger's account axis
   * actually discriminates. The mode-derived form remains the FALLBACK for a paper or pre-binding
   * construction that has no account provider — it keeps the hedge and its dependent SELL agreeing
   * within one manager, which is the minimum the check needs to stay non-vacuous.
   *
   * NOTE the direction of safety: this key is compared for EQUALITY to prove coverage. Falling back
   * to a constant can only ever make two legs of the same attempt agree (permissive-but-consistent);
   * it can never make two different accounts look equal, because a named account is never equal to
   * the `broker:` fallback.
   */
  private brokerAccountKey(): string {
    const account = this.deps.brokerAccount?.();
    if (typeof account === "string") {
      const trimmed = account.trim();
      if (trimmed !== "") return trimmed;
    }
    return `broker:${this.deps.adapter.mode}`;
  }

  /**
   * The stable strategy key the broker will ECHO on every order update for this order — the
   * ownership key the projection attributes by.
   *
   *   Zerodha: the order `tag` (`request.tag` after prepareOrder = stableKiteTag), echoed as `tag`.
   *   Dhan:    the `correlationId` derived from the client id, echoed as `CorrelationId`.
   *
   * Broker-aware so the registered key matches exactly what arrives on the stream; a mismatch would
   * make our own fill look unowned. Falls back to the durable `broker_tag`/`broker_correlation_id`
   * when present so a value written under an older algorithm still attributes.
   */
  private ownerTagFor(intent: IBoxOrderIntent, request: BrokerOrderRequest): string {
    const broker = this.deps.broker?.();
    if (broker === "dhan") {
      return intent.broker_correlation_id ?? dhanCorrelationId(intent.client_order_id);
    }
    // Default (Zerodha): the tag the postback echoes.
    return intent.broker_tag ?? request.tag ?? "";
  }

  /**
   * Register a leg's durable identity with the order-stream consumer BEFORE the POST.
   *
   * Fail-open and idempotent: a registration fault must never block or delay the order. Absent
   * consumer ⇒ no-op (REST polling remains the fill observer).
   */
  private registerStreamOwnership(intent: IBoxOrderIntent, request: BrokerOrderRequest): void {
    const consumer = this.deps.orderStreamConsumer;
    if (!consumer) return;
    const ownerTag = this.ownerTagFor(intent, request);
    if (!ownerTag) return;
    try {
      consumer.registerIntent({
        clientOrderId: intent.client_order_id,
        ownerTag,
        /*
         * THE VERIFIED ACCOUNT, not null.
         *
         * This was hard-coded `account: null`, and the engine's account provider always returned null
         * too, so NO registration ever carried an account — which meant the projection's
         * `foreign_account` rejection could never fire and attribution rested entirely on the
         * per-order tag. After a re-login to a DIFFERENT account, that left nothing structural
         * preventing the new session's stream events from being matched to the old account's orders.
         *
         * THE INTENT'S OWN RECORDED ACCOUNT, AND NOTHING ELSE. Every live intent is stamped before
         * its POST, so a bound row always has one. A row WITHOUT one predates migration 011, and
         * falling back to the currently signed-in account here would stamp it with an account that
         * may not have placed it — fabricating exactly the attribution migration 011 refuses to
         * backfill for that reason. Worse, the fabrication is load-bearing in the wrong direction:
         * the projection would then treat a frame naming the real (different) account as
         * `foreign_account` and DISCARD an owned fill, leaving real exposure unobserved.
         *
         * `null` therefore means UNPROVEN, and the projection counts it (`unverifiedAccount`) and
         * attributes on the owner tag, exactly as it did before account binding existed.
         */
        account: intent.broker_account ?? null,
        requestedQty: intent.quantity,
        brokerOrderId: intent.broker_order_id ?? null,
      });
    } catch {
      // Never let stream bookkeeping affect the order path.
    }
  }

  /**
   * Bind a broker order id to the durable client identity once the broker reports it, and feed the
   * broker snapshot's cumulative quantity into the SAME projection as a REST observation — so the
   * stream and REST are one deduplicated truth. Fail-open.
   */
  private noteStreamBrokerSnapshot(intent: IBoxOrderIntent, order: BrokerOrder): void {
    const consumer = this.deps.orderStreamConsumer;
    if (!consumer) return;
    try {
      if (order.broker_order_id) {
        consumer.learnBrokerOrderId(intent.client_order_id, order.broker_order_id);
      }
      const ownerTag = this.ownerTagFor(intent, requestFromIntent(intent));
      // A REST/adapter snapshot's cumulative quantity, deduplicated against the stream in the one
      // projection. `quantityPresent` mirrors the adapter's evidence marker so a snapshot that
      // could not prove a quantity is not read as a confirmed zero.
      const quantityPresent = order.execution_evidence?.quantity !== "missing";
      consumer.ingestRestObservation({
        ownerTag,
        brokerOrderId: order.broker_order_id ?? null,
        // The account the INTENT was placed under, and never a live-session substitute — see
        // registerStreamOwnership. Null is UNPROVEN, which the projection counts rather than
        // resolving into a claim that could reject an owned fill as foreign.
        account: intent.broker_account ?? null,
        cumulativeQty: order.filled_quantity,
        quantityPresent,
        averagePrice: order.average_price ?? null,
        rawStatus: order.state,
        eventId: `rest:${order.client_order_id}:${order.filled_quantity}:${order.state}`,
      });
    } catch {
      // Never let stream bookkeeping affect reconciliation or persistence.
    }
  }

  /**
   * Record that one rank has decided, wake anything now unblocked, and remember a hedge failure.
   *
   * "DECIDED" for a hedge leg means its POST ROUND TRIP IS OVER — the adapter call returned or
   * threw — not merely that it started. That is deliberate and is what makes the dependent-SELL
   * protection real: only a completed hedge round trip can tell us whether the hedge was actually
   * accepted, and therefore whether the uncovered SELL is safe to send at all.
   *
   * IDEMPOTENT: a rank already decided is not re-recorded, so a double decision (a submit-time
   * rejection followed by a `finally`, say) cannot corrupt the sequence.
   */
  private decideEntryTransportRank(
    request: BrokerOrderRequest,
    guard: LiveEntryTransportGuard,
    outcome: "posted" | "no_post",
    reason?: string,
    terminalOrder?: BrokerOrder | null,
  ): void {
    const gate = this.entryTransportGates.get(request.attempt_id);
    if (!gate) return;
    if (!gate.decided.has(guard.transportRank)) {
      gate.decided.set(guard.transportRank, outcome);
    }
    // A BUY hedge that never reached the broker — or reached it and was refused — leaves the
    // dependent uncovered SELLs unhedged. Recording it is what lets those SELLs refuse BEFORE
    // their own POST rather than becoming naked short exposure.
    if (guard.hedge && reason !== undefined && gate.hedgeFailure === null) {
      const how = outcome === "no_post" ? "did not reach the broker" : "failed at the broker";
      gate.hedgeFailure = `${request.role} (${request.side}) ${how}: ${reason}`;
    }
    // COVERAGE EVIDENCE — the authoritative, attributed record a dependent SELL is authorised from.
    //
    // Recorded for a BUY hedge only, since only a hedge can COVER anything. The evidence is the
    // broker's OWN terminal snapshot (`terminalOrder`) and its cumulative filled quantity, NOT our
    // failure classification. This is the whole fix: a hedge that returns CANCELLED with zero
    // fills, OPEN, or partially filled below size now records a terminal-but-insufficient (or
    // non-terminal) evidence, so the ledger proves NO coverage and the dependent SELL fails closed.
    // A no-POST or an unproven/ambiguous outcome carries no snapshot and records `null` fill, which
    // the ledger also reads as zero proven coverage. NEVER guess a fill in the permissive direction.
    if (guard.hedge) {
      gate.coverage.record(this.hedgeEvidenceFrom(request, outcome, terminalOrder ?? null, reason));
    }
    this.wakeEntryTransportWaiters(gate);
    // Drop the gate only once EVERY REGISTERED rank has decided. A woken-but-not-yet-decided leg is
    // still counted, which is what keeps coverage readable at its own pre-POST checkpoint.
    if (gate.waiters.length === 0 && this.entryAllRanksDecided(gate)) {
      this.entryTransportGates.delete(request.attempt_id);
    }
  }

  /**
   * Translate a decided hedge leg into attributed coverage evidence.
   *
   * The `confirmed_fill_quantity` is populated ONLY from a broker snapshot that is TERMINAL by the
   * broker's own state machine ({@link isBrokerOrderTerminal}). While an order can still fill, its
   * quantity is not proof — recording it as coverage would be a guess, and its shortfall is not yet
   * a final failure either. A missing snapshot (a proven local no-POST, an ambiguous submit, an
   * uncertain state) yields `terminal: true, confirmed_fill_quantity: null` when we KNOW no POST
   * happened, and `terminal: false` otherwise, so the ledger fails closed in every case.
   */
  private hedgeEvidenceFrom(
    request: BrokerOrderRequest,
    outcome: "posted" | "no_post",
    order: BrokerOrder | null,
    reason: string | undefined,
  ): HedgeOutcomeEvidence {
    const base = {
      attempt_id: request.attempt_id,
      role: request.role,
      // The ATTEMPT's frozen key, so an identity change between the requirement (pre-POST) and this
      // evidence (post-POST) cannot manufacture an `account_mismatch` that strands a filled hedge.
      // Falls back to a live read only when no gate exists, which is a non-hedge/paper path.
      broker_account:
        this.entryTransportGates.get(request.attempt_id)?.brokerAccountKey ?? this.brokerAccountKey(),
      requested_quantity: request.quantity,
    } as const;
    if (order && isBrokerOrderTerminal(order.state)) {
      // The order can no longer change: its cumulative filled quantity is the proven coverage. The
      // contract, side and quantity are taken from the BROKER'S OWN SNAPSHOT, not from our request,
      // so a fill the broker reports on a DIFFERENT contract or side than the one we intended is
      // caught by the ledger's attribution checks and covers nothing. Trusting the request here
      // would let a mis-routed or mismatched fill masquerade as coverage.
      return {
        ...base,
        token: order.token,
        tradingsymbol: order.tradingsymbol,
        side: order.side,
        confirmed_fill_quantity: order.filled_quantity,
        terminal: true,
        detail: `broker terminal ${order.state} filled ${order.filled_quantity}/${order.quantity} on ${order.tradingsymbol}/${order.token}`,
      };
    }
    if (outcome === "no_post") {
      // Proven that nothing reached the broker: terminal with zero coverage. The dependent SELL is
      // correctly and finally refused rather than left waiting. The intended contract is recorded
      // for a readable attribution failure, but the null fill is what blocks the SELL.
      return {
        ...base,
        token: request.token,
        tradingsymbol: request.tradingsymbol,
        side: request.side,
        confirmed_fill_quantity: null,
        terminal: true,
        detail: reason ? `no broker POST: ${reason}` : "no broker POST",
      };
    }
    // A POST happened but the snapshot is not terminal (OPEN, PARTIALLY_FILLED, UNKNOWN, or an
    // ambiguous submit with no proven quantity). It can still change, so coverage is not counted
    // and the shortfall is not a final failure. FAIL CLOSED: not_terminal blocks the SELL.
    return {
      ...base,
      token: order?.token ?? request.token,
      tradingsymbol: order?.tradingsymbol ?? request.tradingsymbol,
      side: order?.side ?? request.side,
      confirmed_fill_quantity: null,
      terminal: false,
      detail: reason
        ? `hedge outcome not proven terminal: ${reason}`
        : order
          ? `hedge state ${order.state} is not a terminal proof of fill`
          : "hedge outcome not proven terminal",
    };
  }

  /** True when every rank that registered for this attempt has reached a decision. */
  private entryAllRanksDecided(gate: EntryTransportGate): boolean {
    for (const rank of gate.registered) {
      if (!gate.decided.has(rank)) return false;
    }
    return true;
  }

  /** Wake every parked leg whose hedge prerequisites are now satisfied. */
  private wakeEntryTransportWaiters(gate: EntryTransportGate): void {
    const ready = gate.waiters.filter((waiter) => this.entryHedgesDecided(gate, waiter.rank));
    if (ready.length === 0) return;
    gate.waiters = gate.waiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) waiter.wake();
  }

  /**
   * True when every BUY hedge rank of the attempt has decided.
   *
   * The hedge ranks are exactly `[0, hedgeCount)` because {@link entrySubmissionOrder} places all
   * BUY legs first. A leg with `rank < hedgeCount` is itself a hedge and waits for nothing.
   */
  private entryHedgesDecided(gate: EntryTransportGate, rank: number): boolean {
    const hedgeCount = gate.hedgeCount;
    if (rank < hedgeCount) return true;
    for (let hedge = 0; hedge < hedgeCount; hedge++) {
      if (!gate.decided.has(hedge)) return false;
    }
    return true;
  }

  /**
   * Park an uncovered SELL leg until every BUY hedge of the same attempt has completed its POST.
   *
   * THIS IS THE BARRIER THAT MAKES HEDGE-FIRST REAL. Building the four requests in hedge-first
   * order is not enough: with `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY = 4` all four legs are dequeued
   * together and each does its own durable Mongo writes, so without this the uncovered SELL could
   * still win the race to the broker.
   *
   * Hedge legs return immediately, so the two BUYs still overlap each other and the entry does not
   * degrade into four fully serial round trips. `dispose` drains parked waiters, and the caller
   * re-checks the whole guard after waking — waking is never by itself permission to POST.
   */
  private awaitEntryTransportTurn(request: BrokerOrderRequest, guard: LiveEntryTransportGuard): Promise<void> {
    const gate = this.entryTransportGates.get(request.attempt_id);
    if (!gate || guard.hedge) return Promise.resolve();
    if (this.entryHedgesDecided(gate, guard.transportRank)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      gate.waiters.push({ rank: guard.transportRank, wake: resolve });
    });
  }

  /** Release every parked entry leg, so disposal can never leave one waiting forever. */
  private drainEntryTransportGates(): void {
    for (const gate of this.entryTransportGates.values()) {
      const waiters = gate.waiters;
      gate.waiters = [];
      for (const waiter of waiters) waiter.wake();
    }
    this.entryTransportGates.clear();
  }

  /** Re-check mutable gates at the last safe point before any broker mutation. */
  private queuedActionBlockReason(action: QueueAction): string | null {
    if (action.kind === "cancel") {
      const blocked = this.exposureReductionBlockReason();
      return blocked === null ? null : `Cancellation could not be sent: ${blocked}`;
    }
    const { request } = action;
    if (request.purpose === "ENTRY") {
      const entryBlocked = this.entryBlockReason();
      if (entryBlocked !== null) return `Entry closed while the order was queued: ${entryBlocked}`;
      if (request.quantity > this.deps.limits.maxOpenLegQuantity ||
          this.grossOpenLegQuantity + this.reservedEntryQuantity > this.deps.limits.maxGrossOpenLegQuantity) {
        return "Order exceeded live quantity limits while queued.";
      }
      const capital = this.capitalBlockReason(action);
      if (capital) return capital;
      return null;
    }
    const reductionBlocked = this.exposureReductionBlockReason();
    if (reductionBlocked !== null) {
      return `Exposure reduction could not be sent: ${reductionBlocked}`;
    }
    if (request.purpose === "PROTECTIVE_CANCEL") return null;
    // Re-checked at dequeue too: an account change while this reduction sat in the priority queue is
    // one of the windows the audit reproduced.
    const queuedAccountDrift = this.attributedAccountDriftReason();
    if (queuedAccountDrift !== null) return queuedAccountDrift;
    const symbol = `${request.exchange}:${request.tradingsymbol}`;
    const net = this.attributedBoxPositions.get(symbol) ?? 0;
    const correctSide = (net > 0 && request.side === "SELL") || (net < 0 && request.side === "BUY");
    const reserved = this.reservedReductionsBySymbol.get(symbol) ?? 0;
    return request.quantity <= this.deps.limits.maxOpenLegQuantity && correctSide && reserved <= Math.abs(net)
      ? null
      : "Attributed exposure changed while reduction was queued.";
  }

  private async executeCancel(action: CancelQueueAction): Promise<void> {
    try {
      let order = await this.deps.adapter.cancelOrder(action.intent.client_order_id);
      if (!order) {
        /*
         * THE ADAPTER DOES NOT KNOW THIS ORDER — AND THAT IS NOT SUCCESS.
         *
         * THE DEFECT THIS FIXES. `cancelOrder` returns `undefined` when the client order id is absent
         * from the adapter's SESSION-LOCAL map, which is the normal state after a restart for an order
         * that is still durably OPEN and still working at the broker. That `undefined` was resolved as
         * a successful no-op: no persistence write, no audit row, no failure. The sweep then reported
         * `{ ok: true, eligible: 1, cancelled: [], failures: [] }` with HTTP 200 and ZERO broker cancel
         * calls — an operator pressing the panic button was told it worked while the exposure stayed
         * live. That is the single most dangerous shape a cancellation result can take.
         *
         * So: try to ADOPT the durable identity first, which is the legitimate way to make a
         * restart-orphaned order cancellable again, and if that cannot be done, report an UNRESOLVED
         * FAILURE. Never silence.
         */
        order = await this.adoptThenCancel(action.intent);
      }
      if (!order) {
        /*
         * A ROW THAT NEVER REACHED THE BROKER IS "NOTHING TO CANCEL", NOT "UNRESOLVED".
         *
         * `broker_order_id === null` is the shape a crash between `persistence.create` and the POST
         * leaves behind: durable, non-terminal, and provably never transmitted. Reporting it as
         * unresolved told the operator "the order may still be working" — which is false — and, because
         * any `failures` entry calls `invariantViolation`, it TRIPPED THE STICKY CIRCUIT BREAKER and
         * disabled entry. So pressing the panic button after a restart with one stale CREATED row
         * disarmed the system on the strength of an order that does not exist.
         *
         * The distinction this error class exists to draw — "I could not do this" versus "there was
         * nothing to do" — is exactly what `broker_order_id` tells us, and it was not being used.
         */
        if (!action.intent.broker_order_id) {
          this.markNothingToCancel(action.intent);
          action.resolve(undefined);
          return;
        }
        throw new BrokerCancelUnresolvedError(
          action.intent.client_order_id,
          action.intent.broker_order_id,
        );
      }
      const durable = await this.persistOrder(action.intent, order, "protective cancel reconciliation");
      // A cancel that raced a fill must report the DURABLE quantity: this snapshot decides whether a
      // hedge is still needed and how much residual is outstanding.
      action.resolve(this.authoritativeOrder(order, durable));
    } catch (error) {
      action.reject(error);
    }
  }

  /**
   * Re-establish the adapter's knowledge of a durable order, then cancel it. Undefined if impossible.
   *
   * A restart leaves the adapter's session map empty while durable rows remain OPEN and the orders
   * remain live at the broker. Adoption is the existing, VALIDATED route back: `adoptOrder` requires a
   * matching durable broker identity and equal immutable fields (exchange, symbol, side, quantity,
   * limit price, tag) and refuses a broker order already attributed to a different client id, so it
   * cannot invent an association. Only after the identity is genuinely re-established is a cancel
   * attempted; nothing here fabricates a cancellation.
   *
   * Every failure path returns undefined so the caller raises a structured unresolved failure rather
   * than a silent success.
   */
  /**
   * Record that a durable row needed no cancellation because it never reached the broker.
   *
   * Counted rather than silent: "nothing to cancel" is a legitimate outcome, but it must still be
   * visible, because the same shape would be alarming if it appeared for a row that HAD posted.
   */
  private markNothingToCancel(intent: IBoxOrderIntent): void {
    this.neverPostedCancelSkips++;
    void intent;
  }

  private async adoptThenCancel(intent: IBoxOrderIntent): Promise<BrokerOrder | undefined> {
    const adapter = this.deps.adapter;
    if (!adapter.adoptOrder || !intent.broker_order_id) return undefined;
    // Ownership must still hold: never adopt (or cancel) another account's order.
    if (this.accountConsistencyBlockReason(intent) !== null) return undefined;
    // AND the credential witness. Adoption WRITES a broker-sourced snapshot into our durable row and
    // feeds `attributedBoxPositions`, which authorises further reductions — so the "attempting a cancel
    // is safer than refusing it" argument that leaves cancels unfenced does not extend to it.
    if (this.dispatchAccountBlockReason(intent) !== null) return undefined;
    let snapshot: BrokerOrder | undefined;
    try {
      const brokerOrders = await adapter.listOrders();
      snapshot = brokerOrders.find((candidate) => candidate.broker_order_id === intent.broker_order_id);
    } catch {
      // A read failure is not evidence of absence; fall through to the unresolved failure.
      return undefined;
    }
    if (!snapshot) return undefined;
    try {
      await adapter.adoptOrder(intent, snapshot);
      return await adapter.cancelOrder(intent.client_order_id);
    } catch {
      return undefined;
    }
  }

  private async execute(action: SubmitQueueAction): Promise<void> {
    const request = this.deps.adapter.prepareOrder?.(action.request) ?? action.request;
    // The account is stamped BEFORE the durable write, which is itself before the POST — so a crash
    // in between leaves a row that already names the account that owns whatever reached the broker.
    let intent = intentFromRequest(
      request,
      this.deps.adapter.mode,
      this.now(),
      this.deps.brokerAccount?.() ?? null,
    );
    // Hedge-first bookkeeping for this leg. `postBegan` flips inside the adapter's pre-POST
    // callback, so the `finally` can tell "we transmitted" from "we refused locally" — the
    // distinction the dependent uncovered SELL legs are waiting on.
    const entryGuard = action.entry;
    let postBegan = false;
    let hedgeFailureReason: string | null = null;
    // The terminal broker snapshot for THIS leg, if one exists, captured so the `finally` can hand
    // it to the coverage ledger. A hedge's dependent SELL is authorised ONLY from proven fill, so
    // the ledger needs the authoritative snapshot — not merely "did it fail". Null until a broker
    // snapshot with a settled cumulative quantity is in hand; a no-POST or unproven outcome leaves
    // it null, which the ledger reads as zero proven coverage. FAIL CLOSED.
    let terminalOrder: BrokerOrder | null = null;
    try {
      intent = await this.deps.persistence.create(intent);
      const persistedRequest = requestFromIntent(intent);
      this.knownIntents.set(intent.client_order_id, intent);
      this.health.persistence = "healthy";
      if (intent.state !== "CREATED") {
        // A prior submission exists. Reconcile it; never let current feed state
        // hide or rewrite an identity that may already exist at the broker.
        const reconciled = await this.deps.adapter.getOrder(request.client_order_id);
        if (!reconciled) throw new Error("Existing durable intent requires reconciliation before resubmit.");
        const durable = await this.persistOrder(intent, reconciled, "existing intent reconciled before resubmit");
        action.resolve(this.authoritativeOrder(reconciled, durable));
        return;
      }

      // ── CHECKPOINT 3 of 5: AT DEQUEUE ────────────────────────────────────────────────
      // A concurrency slot is held and the durable CREATED row exists, but nothing has been
      // transmitted. Both the current-feed authority and (for ENTRY only) the composed ownership
      // guard are asked again here, because an unbounded amount of wall-clock time may have passed
      // while this leg sat in the priority queue behind its siblings.
      const dequeueReason = this.checkedFeedBlockReason(request, action.checkedFeed) ??
        this.dispatchAccountBlockReason(intent) ??
        (entryGuard ? this.entryGuardBlockReason(action.request, entryGuard, "dequeue") : null);
      if (dequeueReason) {
        const refusal = new BrokerPreSubmitRefusedError(
          request.client_order_id,
          "dequeue",
          true,
          dequeueReason,
        );
        hedgeFailureReason = dequeueReason;
        const terminalized = await this.persistLocalPreSubmitRefusal(intent, refusal);
        if (!terminalized) {
          await this.resolveConcurrentSubmissionOwner(action, this.knownIntents.get(intent.client_order_id) ?? intent);
          return;
        }
        action.reject(refusal);
        return;
      }

      const submitting = await this.transitionResult(
        intent,
        "SUBMITTING",
        null,
        "transport submission starting",
        ["CREATED"],
      );
      if (!submitting.applied) {
        // Another process won the deterministic identity. Never POST from this
        // process; adopt a known snapshot or leave the identity to reconciliation.
        await this.resolveConcurrentSubmissionOwner(action, submitting.intent);
        return;
      }
      intent = submitting.intent;
      if (intent.state !== "SUBMITTING") {
        throw new Error(`Order intent ${intent.client_order_id} did not durably enter SUBMITTING; broker POST blocked.`);
      }
      // OWNERSHIP-FIRST, BEFORE THE POST. The identity is durably SUBMITTING and CAS-owned by this
      // process; register it with the order-stream consumer NOW so an order-update that beats the
      // placement HTTP response has a ledger to land in and is attributable the instant it arrives.
      this.registerStreamOwnership(intent, persistedRequest);
      // DURABLE PERSISTENCE COMPLETE. Both Mongo writes are done and the order may now be
      // transmitted, so this closes `persistence_wait_ms` and opens `transport_wait_ms`. Recorded
      // here rather than being left inside the pacing span, because a database round trip reported
      // as rate limiting is exactly the kind of mislabelled measurement that corrupts calibration.
      this.markTiming(intent.client_order_id, "intent_persisted");

      // ── CHECKPOINT 4 of 5: AFTER DURABLE PERSISTENCE ─────────────────────────────────
      // The identity is durably spent and CAS-owned by this process, and still nothing has been
      // transmitted. This is the cheapest possible place to discover that entry was disarmed or
      // ownership was lost during the two Mongo round trips.
      // The account is checked for EVERY purpose, not only ENTRY: the second reproduction in the
      // audit was an EXIT. Placed outside the `entryGuard` block below for exactly that reason.
      const persistedAccountReason = this.dispatchAccountBlockReason(intent);
      if (persistedAccountReason) {
        const refusal = new BrokerPreSubmitRefusedError(
          request.client_order_id,
          "post_persist",
          true,
          persistedAccountReason,
        );
        hedgeFailureReason = persistedAccountReason;
        const terminalized = await this.persistLocalPreSubmitRefusal(intent, refusal);
        if (!terminalized) {
          await this.resolveConcurrentSubmissionOwner(action, this.knownIntents.get(intent.client_order_id) ?? intent);
          return;
        }
        action.reject(refusal);
        return;
      }

      if (entryGuard) {
        const persistedReason = this.entryGuardBlockReason(action.request, entryGuard, "post_persist");
        if (persistedReason) {
          const refusal = new BrokerPreSubmitRefusedError(
            request.client_order_id,
            "post_persist",
            true,
            persistedReason,
          );
          hedgeFailureReason = persistedReason;
          const terminalized = await this.persistLocalPreSubmitRefusal(intent, refusal);
          if (!terminalized) {
            await this.resolveConcurrentSubmissionOwner(action, this.knownIntents.get(intent.client_order_id) ?? intent);
            return;
          }
          action.reject(refusal);
          return;
        }
        // HEDGE-FIRST BARRIER. An uncovered SELL parks here until every BUY hedge of this attempt
        // has finished its POST round trip. Waking is not permission: the full guard is re-checked
        // inside the pre-POST callback below, which is what catches a hedge that just failed.
        await this.awaitEntryTransportTurn(action.request, entryGuard);
      }

      let order: BrokerOrder;
      try {
        order = await this.deps.adapter.submitOrder(persistedRequest, () => {
          // ── CHECKPOINT 5 of 5: THE FINAL BOUNDARY ────────────────────────────────────
          // Adapter pacing is done; the next instruction after this callback returns is the HTTP
          // POST. Throwing here PROVES no broker mutation was attempted.
          const reason = this.checkedFeedBlockReason(request, action.checkedFeed) ??
            // THE LAST POSSIBLE INSTANT to notice the account changed. Checked here — not merely at
            // dequeue and post-persist — because the hedge-first barrier immediately above can park
            // an uncovered SELL for an unbounded time, and the credential is resolved lazily AFTER
            // this callback returns. This is the only check that can prove the credential about to
            // sign the request is still the account the order was authorised under.
            this.dispatchAccountBlockReason(intent) ??
            this.entryAuthorizationBlockReason(request) ??
            (entryGuard ? this.entryGuardBlockReason(action.request, entryGuard, "pre_post") : null);
          if (reason) {
            hedgeFailureReason = reason;
            throw new BrokerPreSubmitRefusedError(
              request.client_order_id,
              "pre_post",
              true,
              reason,
            );
          }
          // Past the point of no return: from here a broker mutation may exist.
          postBegan = true;
          // ...which is exactly the condition the whole-attempt quantity envelope keys on. Recorded
          // HERE, at the last pre-POST instant, so that every path which refuses a leg WITHOUT
          // reaching the broker leaves the attempt un-started and its siblings re-ask the full
          // four-leg question. See `postedEntryAttempts`.
          if (request.purpose === "ENTRY") this.postedEntryAttempts.add(request.attempt_id);
        });
      } catch (error) {
        if (error instanceof BrokerPreSubmitRefusedError) {
          const terminalized = await this.persistLocalPreSubmitRefusal(intent, error);
          if (!terminalized) {
            await this.resolveConcurrentSubmissionOwner(
              action,
              this.knownIntents.get(intent.client_order_id) ?? intent,
            );
            return;
          }
          action.reject(error);
          return;
        }
        if (error instanceof BrokerOrderRejectedError) {
          await this.persistOrder(intent, error.order, "broker rejected order");
          this.rejects++;
          this.noteBrokerReject(error.order, errorMessage(error));
          this.noteFailure("broker rejected order");
          this.evaluateLimits();
          // A REJECTED hedge is a definitive hedge failure: the dependent uncovered SELL legs of
          // this attempt are still parked behind the barrier and must now refuse before POSTing.
          hedgeFailureReason = errorMessage(error);
          // The reject snapshot is authoritative and terminal — it proves ZERO covering fill,
          // which is exactly what the ledger must record so the dependent SELL fails closed.
          terminalOrder = error.order;
          action.reject(error);
          return;
        }
        /*
         * A PROVEN-UNSENT CANCELLATION IS NOT BROKER UNCERTAINTY.
         *
         * The adapter now re-raises `BrokerCancelNotTransmittedError` rather than quarantining it, and
         * without this branch it fell to the catch-all below, which writes RECONCILIATION_REQUIRED and
         * increments `unknownOrders` — the number the registry turns into its `unknown_order_state`
         * blocker. So the wedge the error type exists to remove was reproduced one layer up.
         *
         * What is actually true: the protective cancel never left, so the ENTRY ORDER IS UNCHANGED and
         * still working at the broker. That is a known live order, not an unknown one. It is persisted
         * from the snapshot the error carries (so the durable row keeps the quantity that travelled with
         * the refusal), left NON-TERMINAL so it can be cancelled again, and counted as an unattended
         * working order — which already blocks new entry — instead of as an unresolvable mystery.
         *
         * The hedge is still treated as failed: an un-cancelled working order is not proof of a fill,
         * and `hedgeFailureReason` must stay set so no dependent uncovered SELL is authorised.
         */
        if (error instanceof BrokerCancelNotTransmittedError) {
          if (error.order) await this.persistOrder(intent, error.order, error.message);
          this.unattendedWorkingOrders++;
          this.noteFailure("protective cancellation was not transmitted");
          hedgeFailureReason = errorMessage(error);
          action.reject(error);
          return;
        }
        if (error instanceof BrokerAmbiguousSubmitError || isTimeoutLike(error) || !(error instanceof BrokerOrderRejectedError)) {
          /*
           * FAILING TO RECORD THE UNCERTAINTY DOES NOT MAKE IT GO AWAY.
           *
           * THE BLOCKER THIS CLOSES. These writes can throw — "connection terminated unexpectedly" is
           * the ordinary case — and the throw used to escape to the outer catch, which rejected the
           * action with the DATABASE error. That replaced the typed `BrokerAmbiguousSubmitError` with a
           * generic one, and the gateway then did not recognise the leg as uncertain: it treated a SELL
           * whose broker outcome was UNKNOWN as one that was never submitted, and partial-entry recovery
           * bought back the confirmed short and sold BOTH BUY hedges — including the hedge protecting
           * the unresolved SELL. If that SELL later fills, its protection has already been sold.
           *
           * Reproduced end-to-end as `PARTIAL_ENTRY_UNWOUND` with an empty `residual_exposure` and no
           * invariant violation, while the adapter still held the SELL as RECONCILIATION_REQUIRED.
           *
           * So: the durable write is attempted, its failure is recorded as a persistence fault, and the
           * ORIGINAL typed error is what the caller receives either way. A broker submission that may
           * exist must keep saying so even when we cannot write it down.
           */
          try {
            if (error instanceof BrokerAmbiguousSubmitError && error.order) {
              await this.persistOrder(intent, error.order, error.message);
            } else {
              await this.transition(
                intent,
                "RECONCILIATION_REQUIRED",
                null,
                errorMessage(error),
              );
            }
          } catch (recordFailure) {
            // The row may now disagree with the broker, which is exactly what crash recovery is for.
            this.health.persistence = "unhealthy";
            this.noteFailure("broker uncertainty could not be recorded durably");
            this.crashOnlyAttributedExposure = true;
            console.error(
              `[BoxOrderManager] could not durably record broker uncertainty for ` +
                `${intent.client_order_id}: ${errorMessage(recordFailure)}. The original broker ` +
                `outcome is UNKNOWN and is being reported as such.`,
            );
          }
          this.unknownOrders++;
          this.noteFailure("ambiguous broker submission");
          // An AMBIGUOUS hedge is treated as a hedge failure for sequencing purposes. We cannot
          // prove the hedge exists, and "unproven hedge" must never authorise sending the
          // uncovered SELL that depends on it. Never guess in the permissive direction.
          hedgeFailureReason = errorMessage(error);
          action.reject(error);
          return;
        }
        const rejected = await this.transition(intent, "REJECTED", null, errorMessage(error));
        this.knownIntents.set(rejected.client_order_id, rejected);
        this.rejects++;
        this.noteBrokerReject(null, errorMessage(error));
        this.noteFailure("broker rejected order");
        this.evaluateLimits();
        action.reject(error);
        return;
      }

      // The DURABLE row is the authority the caller is resolved with — see authoritativeOrder().
      let accepted = order;
      if (RECONCILE_STATES.has(order.state)) {
        const durable = await this.persistOrder(intent, order, "adapter returned uncertain state; no retry");
        accepted = this.authoritativeOrder(order, durable);
        this.noteFailure("adapter returned uncertain order state");
        hedgeFailureReason = `broker state ${accepted.state} is not proof of a hedge`;
        // UNKNOWN/RECONCILIATION_REQUIRED is not a terminal proven quantity. Deliberately leave
        // `terminalOrder` null so the ledger records no coverage: an unprovable hedge must never
        // authorise the naked SELL that depends on it.
      } else {
        const durable = await this.persistOrder(intent, order, "adapter order snapshot");
        accepted = this.authoritativeOrder(order, durable);
        // AUTHORITATIVE SNAPSHOT for coverage. Whatever the state — COMPLETE, CANCELLED, OPEN,
        // PARTIALLY_FILLED — this is the broker's own report of the leg reconciled with the durable
        // row, and the ledger decides coverage from its terminal-ness and filled quantity, NOT from
        // whether we named it a failure. This is the crux of the fix: a CANCELLED/zero-fill hedge
        // now yields zero proven coverage and blocks the dependent SELL, instead of silently
        // authorising it.
        terminalOrder = accepted;
        // BREAKER ACCOUNTING FOLLOWS THE ADAPTER'S OWN VERDICT, NOT THE MERGED LABEL.
        //
        // `accepted` blends in the durable row, and the durable state-predecessor guard can refuse a
        // transition and return the existing row — so a row already terminally CANCELLED would make
        // the merge report CANCELLED for an order the BROKER rejected, and the rejection would vanish
        // from `rejects` and `consecutiveFailures`, the counters the circuit breaker trips on.
        // Coverage still reads `accepted` (a terminal zero-fill credits nothing either way); only the
        // "did the broker refuse us" question is answered by `order`.
        if (order.state === "REJECTED") {
          this.rejects++;
          this.noteBrokerReject(order, order.reject_reason ?? "broker rejected order");
          this.noteFailure("broker rejected order");
          hedgeFailureReason = order.reject_reason ?? "broker rejected order";
        } else if (accepted.state === "COMPLETE") {
          this.consecutiveFailures = 0;
        }
      }
      this.evaluateLimits();
      action.resolve(accepted);
    } catch (error) {
      this.health.persistence = "unhealthy";
      this.noteFailure("order intent persistence failure");
      hedgeFailureReason = errorMessage(error);
      action.reject(error);
    } finally {
      // HEDGE-FIRST RELEASE — on EVERY path out of this method, including the early `return`s and
      // any throw. A rank that failed to release would leave its dependent uncovered SELL parked
      // forever, so this is a liveness invariant, not bookkeeping.
      if (entryGuard) {
        this.decideEntryTransportRank(
          action.request,
          entryGuard,
          postBegan ? "posted" : "no_post",
          hedgeFailureReason ?? undefined,
          terminalOrder,
        );
      }
    }
  }

  /**
   * Is this ENTRY still authorised by the trading session, at the POST boundary? Null if yes.
   *
   * ENTRY only, and fail-closed. See the `entryAuthorizationBlockReason` dependency for why an
   * admission-time check alone let a disarmed session keep sending orders.
   */
  private entryAuthorizationBlockReason(request: BrokerOrderRequest): string | null {
    if (request.purpose !== "ENTRY") return null;
    const check = this.deps.entryAuthorizationBlockReason;
    if (!check) return null;
    try {
      return check(request);
    } catch {
      return "entry authorisation could not be verified before the broker POST (failed closed)";
    }
  }

  /** Current-feed authority for one queued request. A validator fault fails closed. */
  private checkedFeedBlockReason(
    request: BrokerOrderRequest,
    stamp: CheckedFeedStamp | undefined,
  ): string | null {
    const validate = this.deps.revalidateQueuedRequest;
    if (!validate) return null;
    try {
      return validate(request, stamp);
    } catch {
      return "current executable-feed validation failed closed";
    }
  }

  /**
   * Terminalize a proven local no-POST outcome without counting it as a broker
   * rejection or uncertainty. The expected-state CAS prevents this process from
   * overwriting a concurrent actor that advanced the identity toward the broker.
   */
  private async persistLocalPreSubmitRefusal(
    intent: IBoxOrderIntent,
    refusal: BrokerPreSubmitRefusedError,
  ): Promise<boolean> {
    const result = await this.transitionResult(
      intent,
      "REJECTED",
      null,
      `local pre-submit refusal; no broker POST attempted (${refusal.stage}): ${refusal.reason}`,
      [intent.state],
      {
        origin: "local_pre_submit_refusal",
        no_broker_post: true,
        stage: refusal.stage,
        reason: refusal.reason,
      },
    );
    // Provenance matters: an already-REJECTED fresh row may be a real broker
    // rejection written by another actor. Only THIS applied CAS proves no POST.
    return result.applied && result.intent.state === "REJECTED";
  }

  /** Adopt another process's winner when possible; otherwise quarantine locally without POST. */
  private async resolveConcurrentSubmissionOwner(
    action: SubmitQueueAction,
    current: IBoxOrderIntent,
  ): Promise<void> {
    this.knownIntents.set(current.client_order_id, current);
    const reconciled = await this.deps.adapter.getOrder(current.client_order_id);
    if (reconciled) {
      const durable = await this.persistOrder(current, reconciled, "concurrent durable submission owner reconciled");
      action.resolve(this.authoritativeOrder(reconciled, durable));
      return;
    }
    if (!isBrokerOrderTerminal(current.state)) this.unknownOrders++;
    action.reject(new BrokerAmbiguousSubmitError(
      current.client_order_id,
      `Another process advanced durable intent ${current.client_order_id} to ${current.state}; ` +
        "this process attempted no broker POST and reconciliation is required.",
    ));
  }

  private async performReconcile(): Promise<OrderManagerReconcileReport> {
    this.health.reconciliation = "running";
    this.safeAttributedReductionReady = false;
    try {
      let loadedNonterminalIntents: IBoxOrderIntent[];
      let loadedOwnedIntents: IBoxOrderIntent[];

      try {
        loadedNonterminalIntents = await this.deps.persistence.loadNonterminal();
        loadedOwnedIntents = this.deps.persistence.loadOwned
          ? await this.deps.persistence.loadOwned()
          : loadedNonterminalIntents;
        this.health.persistence = "healthy";
      } catch (error) {
        this.health.persistence = "unhealthy";
        throw error;
      }
      const nonterminalByClient = new Map(
        loadedNonterminalIntents.map((intent) => [intent.client_order_id, intent]),
      );
      const ownedByClient = new Map(
        loadedOwnedIntents.map((intent) => [intent.client_order_id, intent]),
      );
      for (const intent of loadedOwnedIntents) this.knownIntents.set(intent.client_order_id, intent);
      const brokerHealth = await (this.deps.adapter.health?.() ?? Promise.resolve(null));
      this.health.broker_auth = brokerHealth === null || brokerHealth.authenticated ? "healthy" : "unhealthy";
      let brokerOrders: BrokerOrder[];
      try {
        brokerOrders = await this.deps.adapter.listOrders();
        this.health.broker_orders_api = "healthy";
      } catch (error) {
        this.health.broker_orders_api = "unhealthy";
        throw error;
      }
      let positions: Awaited<ReturnType<BrokerAdapter["listPositions"]>>;
      try {
        positions = await this.deps.adapter.listPositions();
        this.health.broker_positions_api = "healthy";
      } catch (error) {
        this.health.broker_positions_api = "unhealthy";
        throw error;
      }
      const byClient = ownedByClient;
      const byBroker = new Map(
        loadedOwnedIntents
          .filter((intent): intent is IBoxOrderIntent & { broker_order_id: string } => Boolean(intent.broker_order_id))
          .map((intent) => [intent.broker_order_id, intent]),
      );
      // A tag is attribution-safe only when exactly one durable intent owns it.
      const byTag = new Map<string, IBoxOrderIntent | null>();
      for (const intent of loadedOwnedIntents) {
        if (!intent.broker_tag) continue;
        byTag.set(intent.broker_tag, byTag.has(intent.broker_tag) ? null : intent);
      }
      const matchedClients = new Set<string>();
      const matchCounts = new Map<string, number>();
      const affectedTradeIds = new Set<string>();
      const identityMismatchSymbols = new Set<string>();
      const orphans: BrokerOrder[] = [];
      const ownedLookingOrphans: BrokerOrder[] = [];
      let matched = 0;

      for (const order of brokerOrders) {
        // Attribution is safe only through durable client/broker identity. A BOX tag
        // alone can classify an orphan, but never authorises flattening/cancellation.
        const intent = byClient.get(order.client_order_id) ??
          (order.broker_order_id ? byBroker.get(order.broker_order_id) : undefined) ??
          (order.tag ? byTag.get(order.tag) ?? undefined : undefined);
        if (!intent) {
          orphans.push(order);
          if (order.client_order_id.startsWith("BOX:") || order.tag?.startsWith("BOX")) {
            ownedLookingOrphans.push(order);
            this.recoveryActive = true;
            this.trip(`unattributed BOX-looking broker order ${order.broker_order_id ?? order.client_order_id}`);
          }
          continue;
        }
        const count = (matchCounts.get(intent.client_order_id) ?? 0) + 1;
        matchCounts.set(intent.client_order_id, count);
        if (count > 1) {
          if (intent.trade_id) affectedTradeIds.add(intent.trade_id);
          this.recoveryActive = true;
          this.trip(`multiple broker orders matched durable intent ${intent.client_order_id}`);
          continue;
        }
        matchedClients.add(intent.client_order_id);
        matched++;
        try {
          const attributed = this.deps.adapter.adoptOrder
            ? await this.deps.adapter.adoptOrder(intent, order)
            : { ...order, client_order_id: intent.client_order_id };
          const updated = await this.persistOrder(intent, attributed, "broker reconciliation snapshot");
          ownedByClient.set(updated.client_order_id, updated);
          if (isBrokerOrderTerminal(updated.state)) nonterminalByClient.delete(updated.client_order_id);
          else nonterminalByClient.set(updated.client_order_id, updated);
        } catch (error) {
          if (intent.trade_id) affectedTradeIds.add(intent.trade_id);
          identityMismatchSymbols.add(`${intent.exchange}:${intent.tradingsymbol}`);
          this.recoveryActive = true;
          this.trip(`broker identity/attribute mismatch for ${intent.client_order_id}: ${errorMessage(error)}`);
        }
      }

      const missingAtBroker: string[] = [];
      for (const intent of loadedNonterminalIntents) {
        if (matchedClients.has(intent.client_order_id)) continue;
        missingAtBroker.push(intent.client_order_id);
        if (intent.trade_id) affectedTradeIds.add(intent.trade_id);
        if (intent.state !== "CREATED") {
          const updated = await this.transition(
            intent,
            "RECONCILIATION_REQUIRED",
            intent.broker_order_id,
            "durable nonterminal intent not found in broker order list; no resubmit",
          );
          nonterminalByClient.set(updated.client_order_id, updated);
          ownedByClient.set(updated.client_order_id, updated);
        }
        this.recoveryActive = true;
        this.trip(`durable nonterminal intent missing at broker: ${intent.client_order_id}`);
      }

      const reconciledNonterminalIntents = [...nonterminalByClient.values()];
      const reconciledOwnedIntents = [...ownedByClient.values()];
      if (this.lastReconciledAt === null) {
        this.reservations.clear();
        this.reservationAttempts.clear();
        this.reservedEntryQuantity = 0;
        this.reductionReservations.clear();
        this.reservedReductionsBySymbol.clear();
        this.reservedReductionQuantity = 0;
        for (const intent of reconciledNonterminalIntents) {
          const remaining = Math.max(0, intent.quantity - intent.filled_quantity);
          if (remaining === 0) continue;
          if (intent.purpose === "ENTRY") {
            this.reservations.set(intent.client_order_id, remaining);
            this.reservationAttempts.set(intent.client_order_id, intent.attempt_id);
            this.reservedEntryQuantity += remaining;
            // RESTART: a durable non-terminal ENTRY intent is PROOF this attempt's leg reached the
            // broker — that is what made the row non-terminal — so its surviving siblings must take
            // the incremental path. Without this, a post-restart leg would re-ask the whole-attempt
            // envelope and count the attempt's own recovered exposure against it, refusing the very
            // legs needed to complete or unwind it.
            this.postedEntryAttempts.add(intent.attempt_id);
          } else if (intent.purpose !== "PROTECTIVE_CANCEL") {
            const symbol = `${intent.exchange}:${intent.tradingsymbol}`;
            this.reductionReservations.set(intent.client_order_id, { symbol, quantity: remaining });
            this.reservedReductionsBySymbol.set(symbol, (this.reservedReductionsBySymbol.get(symbol) ?? 0) + remaining);
            this.reservedReductionQuantity += remaining;
          }
        }
      }

      const intentNetBySymbol = new Map<string, number>();
      const tradeRoleNet = new Map<string, number>();
      const ownedSymbols = new Set<string>();
      for (const intent of reconciledOwnedIntents) {
        const symbol = `${intent.exchange}:${intent.tradingsymbol}`;
        ownedSymbols.add(symbol);
        if (intent.filled_quantity <= 0) continue;
        const delta = (intent.side === "BUY" ? 1 : -1) * intent.filled_quantity;
        intentNetBySymbol.set(symbol, (intentNetBySymbol.get(symbol) ?? 0) + delta);
        if (intent.trade_id) {
          const tradeRole = `${intent.trade_id}:${intent.role}`;
          tradeRoleNet.set(tradeRole, (tradeRoleNet.get(tradeRole) ?? 0) + delta);
        }
      }
      const remainingByTrade: Record<string, Partial<Record<BoxLegRole, number>>> = {};
      for (const intent of reconciledOwnedIntents) {
        if (!intent.trade_id) continue;
        const roles = remainingByTrade[intent.trade_id] ?? {};
        roles[intent.role] = Math.abs(tradeRoleNet.get(`${intent.trade_id}:${intent.role}`) ?? 0);
        remainingByTrade[intent.trade_id] = roles;
      }
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * IS THIS SNAPSHOT STILL CURRENT? An obsolete absolute rebuild is REFUSED, not applied.
       *
       * Everything above was derived from a journal snapshot read before two broker round trips. If a
       * fill was committed during those awaits, the rebuild below would overwrite the newer, correct
       * exposure with the older value — and the classic sequence is the dangerous one:
       *
       *    actual long 75  →  reconcile starts  →  an EXIT sells 75 (actual now 0)
       *                    →  reconcile restores internal exposure to long 75
       *                    →  another "reduction" sells 75  →  actual is now SHORT 75.
       *
       * The breaker is no defence: reduction admission reads this same map and stays permitted while
       * the breaker is open, so a corrupted map authorises the over-reduction directly.
       *
       * The incremental value is the more recent of the two, so the safe action is to KEEP it and
       * discard this pass's rebuild. Reconciliation is then reported INCOMPLETE — entry stays blocked,
       * reduction remains available (it must: refusing to reduce strands exposure), and the next pass
       * reconciles against a fresh snapshot.
       *
       * The position-mismatch comparison is skipped for the same reason: `expected` would be the stale
       * figure, so it would manufacture a spurious mismatch and trip the breaker on our own staleness.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      /*
       * DETECTED PER INTENT, not by a global counter. A reconcile pass legitimately commits fills of
       * its OWN — that is what adopting broker truth means — and a global "did anything change" flag
       * cannot tell those apart from a concurrent exit's write, so it would discard every adopting
       * pass. `knownIntents` is updated by `persistOrder` on every committed write, so an entry there
       * with a HIGHER cumulative fill than this pass's copy is proof that someone else advanced it
       * after the snapshot was taken.
       */
      const snapshotByClient = new Map(reconciledOwnedIntents.map((i) => [i.client_order_id, i]));
      const staleIntents: IBoxOrderIntent[] = [];
      for (const known of this.knownIntents.values()) {
        if (known.filled_quantity <= 0) continue;
        // Only symbols this pass is about to rebuild can be corrupted by it.
        if (!ownedSymbols.has(`${known.exchange}:${known.tradingsymbol}`)) continue;
        const snapshot = snapshotByClient.get(known.client_order_id);
        // ABSENT is as stale as BEHIND: the dangerous case is a whole new EXIT that closed the
        // position after the snapshot was read, which the snapshot cannot represent at all.
        if (!snapshot || known.filled_quantity > snapshot.filled_quantity) staleIntents.push(known);
      }
      const snapshotIsStale = staleIntents.length > 0;
      const positionMismatches: Array<{ symbol: string; expected: number; actual: number }> = [];

      if (!snapshotIsStale) {
        // The complete live-intent journal is authoritative for every symbol it has
        // ever owned, including an exact zero. Open trade docs remain the authority
        // only for legacy/projected symbols with no live intent history.
        for (const symbol of ownedSymbols) {
          this.attributedBoxPositions.set(symbol, intentNetBySymbol.get(symbol) ?? 0);
        }
        this.recalculateGrossAttributedQuantity();
        for (const symbol of identityMismatchSymbols) {
          positionMismatches.push({
            symbol,
            expected: this.attributedBoxPositions.get(symbol) ?? 0,
            actual: Number.NaN,
          });
        }
        const brokerBySymbol = new Map(
          positions.map((position) => [`${position.exchange}:${position.tradingsymbol}`, position.net_quantity]),
        );
        const allSymbols = new Set([...this.attributedBoxPositions.keys(), ...brokerBySymbol.keys()]);
        for (const symbol of allSymbols) {
          const expected = this.attributedBoxPositions.get(symbol) ?? 0;
          const actual = brokerBySymbol.get(symbol) ?? 0;
          if (expected !== actual && (expected !== 0 || ownedSymbols.has(symbol))) {
            positionMismatches.push({ symbol, expected, actual });
            for (const intent of reconciledOwnedIntents) {
              if (`${intent.exchange}:${intent.tradingsymbol}` === symbol && intent.trade_id) affectedTradeIds.add(intent.trade_id);
            }
            this.recoveryActive = true;
            this.trip(`broker-position mismatch for attributed Box symbol ${symbol}: expected ${expected}, actual ${actual}`);
          }
        }
      } else {
        /*
         * DELIBERATELY NOT `invariantViolation`. This is a race that was DETECTED AND HANDLED
         * correctly, not a broken invariant: the newer incremental value was kept and the obsolete
         * rebuild discarded. `invariantViolation` would trip the circuit breaker — which needs an
         * operator to clear — and would re-enter `reconcile()` from inside `reconcile()`.
         *
         * Reporting reconciliation INCOMPLETE is the right response: entry stays blocked, reduction
         * stays available, and the next pass reconciles a fresh snapshot, so it SELF-HEALS. The
         * counter makes a persistent problem visible without halting a healthy one.
         */
        this.staleReconcilePasses += 1;
        console.warn(
          `[Box] reconciliation discarded an obsolete exposure rebuild: ${staleIntents.length} intent(s) ` +
          `were advanced durably after this pass loaded its snapshot ` +
          `[${staleIntents.map((i) => i.client_order_id).join(", ")}]. ` +
          `The newer exposure was kept; the next pass will reconcile a fresh snapshot.`,
        );
      }
      this.unknownOrders = reconciledNonterminalIntents.filter((intent) => RECONCILE_STATES.has(intent.state)).length;
      /*
       * UNATTENDED WORKING ORDERS — an interrupted attempt's legs, still live at the broker.
       *
       * THE DEFECT THIS CLOSES. Readiness was scored from `unknownOrders`, which counts only UNKNOWN
       * and RECONCILIATION_REQUIRED. A durable intent that reconciliation MATCHED against a real
       * broker order in OPEN / ACKNOWLEDGED / PARTIALLY_FILLED / CANCEL_REQUESTED was therefore
       * counted as nothing at all — so after a restart mid-attempt, `reconciliation_complete`,
       * `safe_reduction_ready` and `can_enter` all read TRUE while an order that could still fill was
       * sitting at the exchange.
       *
       * The concrete failure: the process dies after a hedge BUY fills and its short SELL is
       * submitted. On restart the short is still working. Recovery sees the long, sells it — and the
       * short then fills, leaving a naked short.
       *
       * `!activeClientIds.has(...)` is the discriminator that makes this safe to act on. An order this
       * process is actively working IS in that set, so a live four-leg attempt does not block its own
       * remaining legs. An order recovered from a PREVIOUS process life is not, because no waiter in
       * this process owns it — which is exactly what "unattended" means and exactly what is dangerous.
       */
      this.unattendedWorkingOrders = reconciledNonterminalIntents.filter((intent) =>
        !RECONCILE_STATES.has(intent.state) &&
        intent.state !== "CREATED" &&
        !this.activeClientIds.has(intent.client_order_id)
      ).length;
      for (const intent of reconciledNonterminalIntents) {
        if (RECONCILE_STATES.has(intent.state) && intent.trade_id) affectedTradeIds.add(intent.trade_id);
      }
      this.orphanOrders = orphans.map(cloneOrder);
      // A stale pass proves nothing about broker equality, so it may not certify safe reduction.
      // Reduction itself stays AVAILABLE (see exposureReductionBlockReason); this flag only withholds
      // the stronger "the full durable quantity is provably reducible" claim.
      this.safeAttributedReductionReady = !snapshotIsStale &&
        missingAtBroker.length === 0 &&
        ownedLookingOrphans.length === 0 && this.unknownOrders === 0 &&
        positionMismatches.every((item) => Number.isFinite(item.actual) && item.expected !== 0 &&
          Math.sign(item.expected) === Math.sign(item.actual) && Math.abs(item.actual) >= Math.abs(item.expected));
      this.lastReconciledAt = this.now();
      this.health.reconciliation = "idle";
      this.health.reconciliation_complete = !snapshotIsStale &&
        this.health.daily_risk_seed === "healthy" &&
        missingAtBroker.length === 0 && positionMismatches.length === 0 &&
        ownedLookingOrphans.length === 0 && this.unknownOrders === 0;
      const report = {
        matched,
        missingAtBroker,
        orphanOrders: orphans,
        positions,
        positionMismatches,
        affectedTradeIds: [...affectedTradeIds],
        remainingByTrade,
      };
      await this.deps.onReconciliationIssue?.(report);
      return report;
    } catch (error) {
      this.health.reconciliation = "failed";
      this.health.reconciliation_complete = false;
      if (this.deps.adapter.mode === "live") {
        if (this.health.broker_orders_api === "unknown") this.health.broker_orders_api = "unhealthy";
        if (this.health.broker_positions_api === "unknown") this.health.broker_positions_api = "unhealthy";
      }
      this.trip(`reconciliation failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  private async persistOrder(
    intent: IBoxOrderIntent,
    order: BrokerOrder,
    message: string,
  ): Promise<IBoxOrderIntent> {
    // ONE PROJECTION OF TRUTH. Feed this authoritative broker snapshot into the SAME order-stream
    // projection the stream feeds (the OrderUpdateProjection in the consumer), deduplicated and
    // monotonic — so a REST/adapter snapshot and a stream event of the same fill are never
    // double-counted, and the broker order id is bound to our client id. That projection is the
    // single truth for attribution and waking waiters. Fail-open; it runs off the existing guarded
    // durable write below, not a second persistence path.
    this.noteStreamBrokerSnapshot(intent, order);
    // TIMING: record the broker's CUMULATIVE quantity for this snapshot, and — if the order has
    // reached a terminal state — close and publish the trace. Both are fail-open no-ops when
    // instrumentation is off, and neither can throw into the persistence path below.
    try {
      this.deps.timing?.markFill(order.client_order_id, order.filled_quantity);
      if (isBrokerOrderTerminal(order.state)) {
        this.markTiming(order.client_order_id, "terminal");
      }
    } catch {
      /* telemetry must never affect execution */
    }
    this.checkOverfillTripwire(order);
    try {
      const result = await this.deps.persistence.update(
        intent.client_order_id,
        {
          broker_order_id: order.broker_order_id,
          state: order.state,
          filled_quantity: order.filled_quantity,
          average_price: order.average_price,
          broker_tag: order.tag,
          reject_family: order.reject_family,
          reject_reason: order.reject_reason,
          updated_at: new Date(order.updated_at),
          terminal_at: isBrokerOrderTerminal(order.state) ? new Date(order.updated_at) : null,
        },
        auditFor(intent, order.state, order.broker_order_id, message, order.fills.at(-1)?.fill_id ?? null, this.now()),
      );
      const updated = result.intent;
      if (!updated) throw new Error(`Order intent ${intent.client_order_id} disappeared.`);
      // ATTRIBUTION FOLLOWS THE DURABLE WRITE, NEVER THE CALLER'S SNAPSHOT.
      // `intent` here is whatever this async context loaded before its awaits, and a concurrent
      // reconcile pass legitimately holds the same stale copy. Attributing
      // `updated.filled_quantity - intent.filled_quantity` therefore credited one broker fill
      // twice, inflating `attributedBoxPositions` — the permission boundary for reduction and
      // recovery orders — so the manager could authorise reducing more than is actually held.
      const delta = this.durableFillDelta(result, intent);
      if (delta > 0) {
        const key = `${updated.exchange}:${updated.tradingsymbol}`;
        const prior = this.attributedBoxPositions.get(key) ?? 0;
        this.attributedBoxPositions.set(key, prior + (updated.side === "BUY" ? delta : -delta));
        this.recalculateGrossAttributedQuantity();
        // The filled part is now real attributed exposure, so it must stop being counted as a
        // RESERVATION as well. Without this a partially filled working leg was counted twice in
        // every `gross + reserved` comparison.
        this.reduceReservationByFill(updated.client_order_id, delta);
      }
      this.knownIntents.set(updated.client_order_id, updated);
      if (isBrokerOrderTerminal(order.state)) {
        this.releaseReservation(updated.client_order_id);
        // TIMING: publish only once the terminal snapshot is DURABLY recorded, so a sample can
        // never describe an outcome the system does not actually believe in. A trace whose
        // persistence failed is left to expire and is reported as lost measurement rather than
        // being published against an uncertain outcome.
        this.publishTiming(updated.client_order_id);
      }
      this.health.persistence = "healthy";
      return updated;
    } catch (error) {
      this.health.persistence = "unhealthy";
      if (order.filled_quantity > 0) {
        this.trip(`persistence lost after confirmed fill ${order.client_order_id}`);
        this.deps.onPersistenceLossAfterFill?.(order, error);
        throw new OrderPersistenceAfterFillError(order, error);
      }
      throw error;
    }
  }

  /**
   * Reconcile the adapter's snapshot with the DURABLE row that `persistOrder` returned.
   *
   * WHY THIS EXISTS. `persistOrder` returns the durable intent, and that row can legitimately hold a
   * HIGHER cumulative quantity than the snapshot just written: the PostgreSQL compare-and-set
   * refuses a regressing `filled_quantity` and returns the current row instead, which is exactly
   * what happens when a stream-fed reconcile pass has already persisted more. Every caller but one
   * discarded that return value and resolved the ORIGINAL adapter snapshot, so an under-reported
   * quantity reached:
   *   • the hedge-coverage ledger (a dependent SELL judged against too little proven cover),
   *   • `entryLegOutcomes` / gateway results,
   *   • unwind sizing (`result.filled_quantity`), which then unwinds LESS than is actually held,
   *   • residual classification and downstream exposure arithmetic.
   *
   * Attribution was never affected — `durableFillDelta` already reads the pre-image the locked row
   * recorded — so this closes the reporting gap only. It does not relax any durable guard.
   *
   * The same merge authority as the adapters is reused, so "authoritative" means the same thing at
   * every layer: monotonic cumulative quantity, no price borrowed from a smaller fill, no terminal
   * state reopened, and contradictions routed to reconciliation rather than silently resolved.
   */
  private authoritativeOrder(order: BrokerOrder, durable: IBoxOrderIntent): BrokerOrder {
    const durableView: BrokerOrder = {
      ...order,
      broker_order_id: durable.broker_order_id,
      state: durable.state,
      filled_quantity: durable.filled_quantity,
      pending_quantity: Math.max(0, durable.quantity - durable.filled_quantity),
      average_price: durable.average_price,
      // The durable row carries a quantity and an average price but NO fill records. Copying the
      // adapter's rows alongside a HIGHER durable quantity would publish detail that under-sums the
      // quantity printed beside it, so when the row is ahead the records are dropped and the merge's
      // own rule rebuilds a coherent aggregate for the accepted quantity.
      fills: durable.filled_quantity > order.filled_quantity ? [] : order.fills.map((fill) => ({ ...fill })),
      reject_family: (durable.reject_family as BrokerOrder["reject_family"]) ?? null,
      reject_reason: durable.reject_reason,
      updated_at: durable.updated_at.getTime(),
    };
    const merged = mergeBrokerOrderSnapshot(order, durableView, {
      observedCumulativeQty: durable.filled_quantity,
    });
    return merged.order;
  }

  private async transition(
    intent: IBoxOrderIntent,
    state: BoxOrderIntentState,
    brokerOrderId: string | null,
    message: string,
    expectedStates?: readonly BoxOrderIntentState[],
  ): Promise<IBoxOrderIntent> {
    return (await this.transitionResult(intent, state, brokerOrderId, message, expectedStates)).intent;
  }

  /** Same transition, retaining whether THIS atomic compare-and-set won. */
  private async transitionResult(
    intent: IBoxOrderIntent,
    state: BoxOrderIntentState,
    brokerOrderId: string | null,
    message: string,
    expectedStates?: readonly BoxOrderIntentState[],
    payload?: Record<string, unknown> | null,
  ): Promise<OrderIntentUpdateResult & { intent: IBoxOrderIntent }> {
    const at = this.now();
    const result = await this.deps.persistence.update(
      intent.client_order_id,
      {
        state,
        broker_order_id: brokerOrderId,
        updated_at: new Date(at),
        terminal_at: state === "COMPLETE" || state === "CANCELLED" || state === "REJECTED"
          ? new Date(at)
          : null,
      },
      auditFor(intent, state, brokerOrderId, message, null, at, payload),
      expectedStates,
    );
    const updated = result.intent;
    if (!updated) throw new Error(`Order intent ${intent.client_order_id} disappeared.`);
    if (!result.applied) {
      // The intent state machine REFUSED this transition. Returning the unchanged document made
      // that indistinguishable from success, so a caller could believe it had quarantined an
      // order that is still working.
      this.durableTransitionRefusals++;
      console.warn(
        `[Box] durable state transition ${intent.state} -> ${state} for ` +
          `${intent.client_order_id} was refused; the document is still ${updated.state}.`,
      );
      if (state === "RECONCILIATION_REQUIRED" && !RECONCILE_STATES.has(updated.state)) {
        // A refused quarantine is not survivable silently: uncertain broker state would look
        // resolved. Trip directly rather than via invariantViolation, which would recurse into
        // reconcile from inside a persistence path.
        this.trip(`quarantine transition refused for ${intent.client_order_id}`);
      }
    }
    this.knownIntents.set(updated.client_order_id, updated);
    return { ...result, intent: updated };
  }

  /**
   * The fill quantity THIS caller's durable write actually established.
   *
   * The only safe source is the guarded write's own pre-image/post-image pair:
   *
   *   applied === false            => 0. The write was refused, so this caller advanced nothing.
   *   applied === true             => current - previous, as recorded by the atomic update.
   *
   * Worked example of the race this closes — two callers holding `filled_quantity: 0` for one
   * order the broker filled 40:
   *
   *   A persists 40  ->  applied, pre 0,  post 40  ->  delta 40
   *   B persists 40  ->  applied, pre 40, post 40  ->  delta  0     (the `$lte` guard is
   *                                                                  deliberately non-strict, so
   *                                                                  B's write matches and is
   *                                                                  reported applied — but it
   *                                                                  advanced nothing)
   *
   * Total attributed 40, which is the truth. The old stale-snapshot arithmetic gave 80.
   *
   * A persistence layer that cannot report the transition gets NOTHING attributed and trips the
   * invariant. That direction is deliberate: under-attribution blocks reductions (safe), while
   * over-attribution authorises reducing more than is held (not safe). Reconciliation rebuilds
   * the map absolutely from the journal, so a missed increment is repaired rather than compounded.
   */
  private durableFillDelta(result: OrderIntentUpdateResult, intent: IBoxOrderIntent): number {
    if (!result.applied) return 0;
    const previous = result.previous_filled_quantity;
    const current = result.current_filled_quantity;
    if (typeof previous !== "number" || typeof current !== "number") {
      this.invariantViolation(
        `durable persistence did not report the fill transition for ${intent.client_order_id}; ` +
          `no exposure was attributed`,
      );
      return 0;
    }
    const delta = current - previous;
    if (delta < 0) {
      // The monotonic `$lte` guard forbids this. If it ever happens the durable quantity moved
      // backwards, which is a corruption, not a reduction — never feed it into exposure.
      this.invariantViolation(
        `durable filled quantity for ${intent.client_order_id} regressed ${previous} -> ${current}`,
      );
      return 0;
    }
    return delta;
  }

  private recalculateGrossAttributedQuantity(): void {
    this.grossOpenLegQuantity = [...this.attributedBoxPositions.values()]
      .reduce((sum, quantity) => sum + Math.abs(quantity), 0);
  }

  /**
   * How many legs a Box entry attempt will submit. A box is four legs, always.
   *
   * Named rather than inlined because it is the basis of the WHOLE-ATTEMPT envelope preflight below,
   * and a reader needs to see that the `4` is structural, not a tuning knob.
   */
  private static readonly BOX_ENTRY_LEG_COUNT = 4;

  /**
   * Attempts that have had at least one ENTRY leg reach the BROKER.
   *
   * Why this exists. The whole-attempt envelope below is only a correct question while the attempt
   * has committed nothing: it asks "does 4 x lot fit alongside everything ELSE?". Asking it again on
   * leg 2 would count the attempt's own leg 1 both as committed exposure AND as part of the 4 x lot
   * it is about to need — double-counting it into a false refusal that strands the attempt exactly
   * where the envelope was meant to prevent it from getting. So the envelope is evaluated once,
   * before the attempt's first leg posts; later legs keep the incremental per-leg check.
   *
   * MEMBERSHIP IS RECORDED AT THE POST, NOT AT THE RESERVATION. An earlier version added the attempt
   * when `submit()` took its reservation — before the queue. But a queued leg can still be refused at
   * the dequeue re-check (entry closed, capital, coherence, economics), and that path releases the
   * reservation while leaving nothing behind: no exposure, no reservation, nothing to double-count.
   * Marking the attempt there meant a retry under the same attempt id skipped the whole-attempt
   * envelope entirely and posted its first leg under the weaker incremental check — silently turning
   * off the protection, and contradicting the comment that claimed the opposite.
   *
   * Keying on "did any leg actually reach the broker" is the property that matters: only a POSTed leg
   * can have created exposure or a broker-side order for the envelope to double-count.
   *
   * Session-lifetime by design (cleared on day roll): attempt ids are unique per attempt, so a stale
   * entry can never make a LATER attempt's check more permissive.
   */
  private readonly postedEntryAttempts = new Set<string>();

  /**
   * Which ATTEMPT each entry reservation belongs to, keyed by client order id.
   *
   * Kept in step with {@link reservations} — written where a reservation is taken, deleted wherever one
   * is released — so the whole-attempt envelope can distinguish "this attempt's own legs" from
   * "everything else", which is the distinction it was previously unable to make.
   */
  private readonly reservationAttempts = new Map<string, string>();
  /**
   * Durable rows a cancel sweep skipped because they never reached the broker. Diagnostics only.
   */
  private neverPostedCancelSkips = 0;

  /**
   * Would the FULL four-leg attempt fit the gross cap? Null if it fits, else the reason.
   *
   * THE HAZARD THIS CLOSES. `withinQuantityLimits` checked the gross cap incrementally —
   * `gross + reserved + thisLeg <= maxGross` — which is correct per leg and insufficient for an
   * attempt. With `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=200` and a 75-unit lot, leg 1 passes (75),
   * leg 2 passes (150) and leg 3 is REFUSED at 225. By then the hedge legs have already POSTed and
   * may have filled, so the attempt discovers an incompatible quantity cap *after* acquiring real
   * exposure — precisely what must not happen. The stranded legs then have to be unwound, turning a
   * configuration mistake into live risk.
   *
   * Checking the whole envelope on EVERY entry leg (including the first) means such an attempt is
   * refused before anything reaches the broker. The default 400 comfortably admits a 75-unit NIFTY or
   * 35-unit BANKNIFTY box (300 / 140); it does NOT admit a 500-unit single-stock lot, which is
   * correctly refused up front rather than half-executed.
   */
  entryQuantityEnvelopeBlockReason(quantityPerLeg: number, attemptId?: string): string | null {
    const legs = BoxOrderManager.BOX_ENTRY_LEG_COUNT;
    if (quantityPerLeg > this.deps.limits.maxOpenLegQuantity) {
      return (
        `One lot of this instrument is ${quantityPerLeg} unit(s), which exceeds the per-leg limit ` +
        `BOX_LIVE_MAX_OPEN_LEG_QUANTITY=${this.deps.limits.maxOpenLegQuantity}. Set the limit to the ` +
        `selected instrument's one-lot quantity — do not raise it globally.`
      );
    }
    /*
     * THE ATTEMPT MUST NOT BE CHARGED FOR ITSELF TWICE.
     *
     * THE DEFECT THIS FIXES. `quantityPerLeg * legs` is a claim about ALL FOUR legs of this attempt.
     * But `submit()` reserves each leg's quantity as it is admitted, so by the time leg 2 asks the
     * question, leg 1's 75 units are ALREADY inside `reservedEntryQuantity` — and the envelope added
     * the full 4-leg claim on top of them. A perfectly valid 4 x 75 = 300 box was therefore refused
     * against a 300 cap:
     *
     *     leg 1:  0 + 0   + 300 = 300  <= 300   admitted, reserved -> 75
     *     leg 2:  0 + 75  + 300 = 375  >  300   REFUSED
     *
     * The attempt rejected itself using its own reservation. Worse, with a cap of 400 the first two
     * legs were admitted and leg 3 was refused at 450 — by which time a hedge had POSTed and could
     * have FILLED, so the very outcome this envelope exists to prevent (acquiring exposure against a
     * cap the attempt cannot satisfy) was caused by the envelope itself.
     *
     * Other attempts and pre-existing positions are still counted in FULL. Only this attempt's own
     * commitments are netted out, because `quantityPerLeg * legs` already accounts for them.
     *
     * `ownGross` is not subtracted, and does not need to be: this arm only runs when the attempt has
     * NOT reached the broker (`postedEntryAttempts` is checked by the sole caller), and a leg that has
     * not posted cannot have filled. So this attempt contributes nothing to `grossOpenLegQuantity`
     * here, by construction.
     */
    const ownReserved = attemptId === undefined ? 0 : this.reservedEntryQuantityForAttempt(attemptId);
    const committedByOthers =
      this.grossOpenLegQuantity + Math.max(0, this.reservedEntryQuantity - ownReserved);
    const envelope = committedByOthers + quantityPerLeg * legs;
    if (envelope > this.deps.limits.maxGrossOpenLegQuantity) {
      return (
        `The full ${legs}-leg attempt needs ${quantityPerLeg * legs} unit(s) of gross leg quantity ` +
        `(already committed: ${committedByOthers}), which exceeds ` +
        `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=${this.deps.limits.maxGrossOpenLegQuantity}. Refused ` +
        `BEFORE the first leg posts, so no hedge is acquired against a cap the attempt cannot satisfy.`
      );
    }
    return null;
  }

  /**
   * How much of `reservedEntryQuantity` belongs to ONE attempt.
   *
   * Derived from the existing per-leg reservations rather than tracked as a second running total: a
   * duplicated total is a second thing that can drift out of step with the first, and this is the
   * number that decides whether an entry may proceed.
   */
  private reservedEntryQuantityForAttempt(attemptId: string): number {
    let total = 0;
    for (const [clientOrderId, quantity] of this.reservations) {
      if (this.reservationAttempts.get(clientOrderId) === attemptId) total += quantity;
    }
    return total;
  }

  /**
   * Why this specific order fails the quantity limits, or null if it passes.
   *
   * Reason-returning rather than boolean because "exceeds the configured live leg quantity limits" is
   * useless to a supervising operator: it cannot distinguish a per-leg cap below one lot (fix
   * `BOX_LIVE_MAX_OPEN_LEG_QUANTITY`) from a gross envelope too small for four legs (fix
   * `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY`) from a reduction pointed the wrong way (a code defect).
   * Those demand different responses, so they must read differently.
   */
  private quantityLimitBlockReason(request: BrokerOrderRequest): string | null {
    if (request.purpose === "ENTRY") {
      if (!this.postedEntryAttempts.has(request.attempt_id)) {
        // Nothing of this attempt has reached the broker: ask the WHOLE-ATTEMPT question while the
        // answer is still meaningful. This is the check that prevents acquiring a hedge against a cap
        // the attempt cannot satisfy. It subsumes the per-leg cap.
        // The attempt id is passed so the envelope nets out THIS attempt's own reserved siblings.
        // Without it every leg after the first was charged for the legs already admitted alongside it.
        return this.entryQuantityEnvelopeBlockReason(request.quantity, request.attempt_id);
      }
      // A leg of this attempt has already POSTed, so re-asking the envelope would double-count this
      // attempt's own committed legs. Fall back to the incremental per-leg check.
      if (request.quantity > this.deps.limits.maxOpenLegQuantity) {
        return (
          `Order quantity ${request.quantity} exceeds the per-leg limit ` +
          `BOX_LIVE_MAX_OPEN_LEG_QUANTITY=${this.deps.limits.maxOpenLegQuantity}.`
        );
      }
      const gross = this.grossOpenLegQuantity + this.reservedEntryQuantity + request.quantity;
      if (gross > this.deps.limits.maxGrossOpenLegQuantity) {
        return (
          `This entry leg would take gross open leg quantity to ${gross}, exceeding ` +
          `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=${this.deps.limits.maxGrossOpenLegQuantity}.`
        );
      }
      return null;
    }
    if (request.quantity > this.deps.limits.maxOpenLegQuantity) {
      return (
        `Order quantity ${request.quantity} exceeds the per-leg limit ` +
        `BOX_LIVE_MAX_OPEN_LEG_QUANTITY=${this.deps.limits.maxOpenLegQuantity}.`
      );
    }
    if (request.purpose === "PROTECTIVE_CANCEL") return null;

    // ATTRIBUTION IS ONLY EVIDENCE IF IT BELONGS TO THIS ACCOUNT. Checked before the side/size
    // arithmetic below, because that arithmetic is exactly what a foreign snapshot would satisfy.
    const accountDrift = this.attributedAccountDriftReason();
    if (accountDrift !== null) return accountDrift;

    // A REDUCTION may only ever shrink a position this process is attributed, and only from the side
    // that shrinks it. Anything else would be new exposure wearing an exit's label.
    const symbol = `${request.exchange}:${request.tradingsymbol}`;
    const net = this.attributedBoxPositions.get(symbol) ?? 0;
    const correctSide = (net > 0 && request.side === "SELL") || (net < 0 && request.side === "BUY");
    if (!correctSide) {
      return (
        `A ${request.purpose} ${request.side} on ${symbol} would not reduce the attributed net ` +
        `position (${net}); a reduction must trade against the position it owns.`
      );
    }
    const alreadyReserved = this.reservedReductionsBySymbol.get(symbol) ?? 0;
    if (request.quantity + alreadyReserved > Math.abs(net)) {
      return (
        `Reducing ${request.quantity} unit(s) of ${symbol} would overshoot the attributed net ` +
        `position (${Math.abs(net)}, of which ${alreadyReserved} is already reserved for in-flight ` +
        `reductions), which would open NEW exposure on the opposite side.`
      );
    }
    return null;
  }

  private withinQuantityLimits(request: BrokerOrderRequest): boolean {
    return this.quantityLimitBlockReason(request) === null;
  }

  /**
   * Reduce a still-working leg's reservation by the quantity that has now DURABLY FILLED.
   *
   * THE DOUBLE COUNT THIS REMOVES. A reservation used to be released only when the broker state went
   * terminal, while attribution was credited on any positive fill delta. So a partially filled,
   * still-working leg was counted twice — its filled part in `grossOpenLegQuantity` AND its full
   * quantity in `reservedEntryQuantity` — and every gross check that sums the two over-counted by the
   * filled amount. That is the same arithmetic that decides whether an entry may proceed, and it is
   * also inconsistent with the crash-recovery rebuild, which has always reserved only the OUTSTANDING
   * remainder.
   *
   * Clamped at zero and never below, so an over-fill cannot make the reservation negative.
   */
  private reduceReservationByFill(clientOrderId: string, filledDelta: number): void {
    if (!(filledDelta > 0)) return;
    const held = this.reservations.get(clientOrderId);
    if (held === undefined || held <= 0) return;
    const remaining = Math.max(0, held - filledDelta);
    const consumed = held - remaining;
    if (consumed <= 0) return;
    this.reservedEntryQuantity = Math.max(0, this.reservedEntryQuantity - consumed);
    if (remaining === 0) {
      this.reservations.delete(clientOrderId);
      this.reservationAttempts.delete(clientOrderId);
    } else {
      this.reservations.set(clientOrderId, remaining);
    }
  }

  private releaseReservation(clientOrderId: string): void {
    const quantity = this.reservations.get(clientOrderId) ?? 0;
    if (quantity > 0) this.reservedEntryQuantity = Math.max(0, this.reservedEntryQuantity - quantity);
    this.reservations.delete(clientOrderId);
    this.reservationAttempts.delete(clientOrderId);
    const reduction = this.reductionReservations.get(clientOrderId);
    if (reduction) {
      const remaining = Math.max(0, (this.reservedReductionsBySymbol.get(reduction.symbol) ?? 0) - reduction.quantity);
      if (remaining === 0) this.reservedReductionsBySymbol.delete(reduction.symbol);
      else this.reservedReductionsBySymbol.set(reduction.symbol, remaining);
      this.reservedReductionQuantity = Math.max(0, this.reservedReductionQuantity - reduction.quantity);
      this.reductionReservations.delete(clientOrderId);
    }
  }

  private mergePostLoadFlattenCharges(
    day: string,
    seedPnl: number,
    token: DailyRiskSeedToken | undefined,
    baselines: Record<string, number> | undefined,
  ): number {
    if (!token || token.tradingDay !== day) return seedPnl;
    let unseededCharges = 0;
    for (const mutation of this.flattenChargeMutationsByDay.get(day) ?? []) {
      if (mutation.generation <= token.mutationGeneration) continue;
      const seedBaselineValue = baselines?.[mutation.attemptId];
      const seedBaseline = Number.isFinite(seedBaselineValue)
        ? Math.round(Math.max(0, seedBaselineValue!) * 100) / 100
        : 0;
      // A loader may have observed none, part, or all of this local range. Add exactly the suffix
      // above both the mutation's prior watermark and the authoritative seed bucket.
      const representedThrough = Math.max(mutation.previousChargesForDay, seedBaseline);
      if (mutation.chargesForDay > representedThrough) {
        unseededCharges += mutation.chargesForDay - representedThrough;
      }
    }
    return Math.round((seedPnl - unseededCharges) * 100) / 100;
  }

  private settleDailyRiskSeedToken(token: DailyRiskSeedToken): void {
    this.activeDailyRiskSeedTokens.delete(token.loadGeneration);
    this.compactFlattenChargeMutations(token.tradingDay);
  }

  /** Retain exactly the mutation suffix an active loader can still need. */
  private compactFlattenChargeMutations(day: string): void {
    const active = [...this.activeDailyRiskSeedTokens.values()]
      .filter((token) => token.tradingDay === day);
    if (active.length === 0) {
      this.flattenChargeMutationsByDay.delete(day);
      return;
    }
    const oldestBoundary = Math.min(...active.map((token) => token.mutationGeneration));
    const retained = (this.flattenChargeMutationsByDay.get(day) ?? [])
      .filter((mutation) => mutation.generation > oldestBoundary);
    if (retained.length === 0) this.flattenChargeMutationsByDay.delete(day);
    else this.flattenChargeMutationsByDay.set(day, retained);
  }

  private rollTradingDay(): void {
    const next = this.dayKey();
    if (next === this.tradingDay) return;
    this.tradingDay = next;
    // No prior-day loader may pin memory or occupy the one current-day slot. Logical cancellation
    // is enough even when the database operation itself cannot be aborted: generation checks make
    // every eventual completion inert.
    if (this.activeDailyRiskLoad && this.activeDailyRiskLoad.day !== next) {
      this.seedTimer().clearTimeout(this.activeDailyRiskLoad.timeout);
      this.settleDailyRiskSeedToken(this.activeDailyRiskLoad.token);
      this.activeDailyRiskLoad = null;
    }
    for (const token of [...this.activeDailyRiskSeedTokens.values()]) {
      if (token.tradingDay !== next) this.settleDailyRiskSeedToken(token);
    }
    for (const day of [...this.flattenChargeMutationsByDay.keys()]) {
      if (day !== next) this.flattenChargeMutationsByDay.delete(day);
    }
    // Attempts do not span trading days, so yesterday's entries are dead weight. Dropping them is
    // safe in the strict direction: a forgotten attempt id makes the envelope check apply, not lapse.
    this.postedEntryAttempts.clear();
    // Never reopen on a process-local zero at midnight. Entry remains blocked
    // until the new IST day's durable closes, aborts, and rejects are reloaded.
    this.realisedPnlToday = 0;
    this.rejects = 0;
    this.consecutiveFailures = 0;
    this.health.daily_risk_seed = "seeding";
    this.health.reconciliation_complete = false;
    this.refreshDailyRiskSeed();
    // A day roll never clears a sticky safety breaker or operator controls.
  }

  private refreshDailyRiskSeed(): void {
    if (this.activeDailyRiskLoad || this.disposed) return;
    const day = this.tradingDay;
    const loader = this.deps.loadDailyRiskSeed;
    if (!loader) {
      this.health.daily_risk_seed = "failed";
      return;
    }
    const token = this.beginDailyRiskSeed(day);
    const generation = token.loadGeneration;
    this.health.daily_risk_seed = "seeding";
    const timeout = this.seedTimer().setTimeout(() => {
      const active = this.activeDailyRiskLoad;
      if (!active || active.generation !== generation) return;
      this.activeDailyRiskLoad = null;
      this.settleDailyRiskSeedToken(token);
      if (day === this.tradingDay) this.health.daily_risk_seed = "failed";
      // Release the slot and immediately request the newest day. The timed-out promise may settle
      // later, but it no longer owns a generation and therefore cannot install anything.
      if (!this.disposed) {
        this.rollTradingDay();
        this.refreshDailyRiskSeed();
      }
    }, Math.max(1, this.deps.dailyRiskSeedTimeoutMs ?? 30_000));
    this.activeDailyRiskLoad = { generation, day, token, timeout };

    void Promise.resolve()
      .then(() => loader(day))
      .then((seed) => {
        const active = this.activeDailyRiskLoad;
        if (!active || active.generation !== generation || day !== this.tradingDay ||
            !this.activeDailyRiskSeedTokens.has(token.loadGeneration)) return;
        this.seedTimer().clearTimeout(active.timeout);
        this.activeDailyRiskLoad = null;
        this.seedLimits({
          tradingDay: day,
          realisedPnlToday: Number.isFinite(seed.realisedPnl) ? seed.realisedPnl : 0,
          rejects: seed.rejects,
          consecutiveFailures: seed.consecutiveFailures,
          seedToken: token,
          flattenChargeBaselinesForDay: seed.flattenChargeBaselinesForDay,
          incomplete: seed.incomplete,
        });
        // Reconciliation owns the final entry-ready flag. Defer so the load slot is visibly free.
        const deferred = setTimeout(() => void this.reconcile().catch(() => undefined), 0);
        deferred.unref?.();
      })
      .catch(() => {
        const active = this.activeDailyRiskLoad;
        if (!active || active.generation !== generation) return;
        this.seedTimer().clearTimeout(active.timeout);
        this.activeDailyRiskLoad = null;
        this.settleDailyRiskSeedToken(token);
        if (day === this.tradingDay) this.health.daily_risk_seed = "failed";
      });
  }

  private seedTimer(): DailyRiskSeedTimer {
    if (this.deps.dailyRiskSeedTimer) return this.deps.dailyRiskSeedTimer;
    return {
      setTimeout: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
  }

  private isCrashRecoveryEntryQuarantined(): boolean {
    if (!this.crashOnlyAttributedExposure) return false;
    try {
      return !(this.deps.isCrashRecoveryPersistenceReady?.() ?? false);
    } catch {
      return true;
    }
  }

  private dayKey(): string {
    if (this.deps.istDayKey) return this.deps.istDayKey(this.now());
    return new Date(this.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  private noteFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.deps.limits.consecutiveFailureLimit) {
      this.trip(`${reason}: consecutive failure limit reached`);
    }
  }

  private evaluateLimits(): void {
    if (this.deps.limits.dailyLossLimit > 0 && this.realisedPnlToday <= -this.deps.limits.dailyLossLimit) {
      this.trip("daily loss limit reached");
    }
    if (this.rejects >= this.deps.limits.rejectLimit) this.trip("broker reject limit reached");
    if (this.residualLegs > this.deps.limits.maxResidualLegs) this.trip("residual leg limit exceeded");
    if (this.openBoxes > this.deps.limits.maxOpenBoxes) this.trip("open box limit exceeded");
    if (this.grossOpenLegQuantity > this.deps.limits.maxGrossOpenLegQuantity) {
      this.trip("gross open leg quantity limit exceeded");
    }
  }

  private trip(reason: string): void {
    if (this.breakerReason !== null) return;
    this.breakerReason = reason;
    this.breakerAt = this.now();
    this.health.circuit = "open";
    this.controls.entryEnabled = false;
    this.deps.onCircuitTrip?.(reason);
  }

  private refreshFeedHealth(): void {
    if (this.feedHealthy) {
      this.health.feed = this.now() < this.feedWarmUntil ? "warming" : "healthy";
    }
  }

  private now(): number {
    return this.deps.clock?.now() ?? Date.now();
  }
}

/** Compatibility alias for existing imports while the public name is explicit. */
export { BoxOrderManager as OrderManager };

function requestFromIntent(intent: IBoxOrderIntent): BrokerOrderRequest {
  return {
    client_order_id: intent.client_order_id,
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
    ...(intent.broker_tag ? { tag: intent.broker_tag } : {}),
  };
}

function intentFromRequest(
  request: BrokerOrderRequest,
  mode: "paper" | "live",
  now: number,
  /**
   * The verified broker account, stamped onto the intent BEFORE the broker POST.
   *
   * Pre-POST is the only correct moment: a crash between POST and the response must leave a durable
   * row that already names its owning account, or recovery cannot tell whose order it found. `null`
   * is permitted so paper intents and pre-binding callers are unchanged, and `null` means UNPROVEN —
   * it is never later filled in from whoever happens to be signed in.
   */
  brokerAccount: string | null = null,
): IBoxOrderIntent {
  const at = new Date(now);
  return {
    client_order_id: request.client_order_id,
    broker_order_id: null,
    broker_mode: mode,
    broker_account: brokerAccount,
    trade_id: request.trade_id,
    attempt_id: request.attempt_id,
    role: request.role,
    purpose: request.purpose,
    phase: request.phase,
    exchange: request.exchange,
    tradingsymbol: request.tradingsymbol,
    token: request.token,
    side: request.side,
    quantity: request.quantity,
    reference_price: request.pricing.reference_price,
    tick_size: request.pricing.tick_size,
    max_chase_ticks: request.pricing.max_chase_ticks,
    limit_price: request.pricing.limit_price,
    state: "CREATED",
    filled_quantity: 0,
    average_price: null,
    broker_tag: request.tag ?? null,
    reject_family: null,
    reject_reason: null,
    created_at: at,
    updated_at: at,
    terminal_at: null,
    audit: [{
      audit_id: `${request.client_order_id}:CREATED`,
      at,
      from_state: null,
      to_state: "CREATED",
      broker_order_id: null,
      message: "durable order intent created before submission",
      fill_identity: null,
    }],
  };
}

function auditFor(
  intent: IBoxOrderIntent,
  state: BoxOrderIntentState,
  brokerOrderId: string | null,
  message: string,
  fillIdentity: string | null,
  now: number,
  payload: Record<string, unknown> | null = null,
): BoxOrderIntentAudit {
  return {
    audit_id: `${intent.client_order_id}:${intent.state}->${state}:${brokerOrderId ?? "none"}:${fillIdentity ?? "none"}`,
    at: new Date(now),
    from_state: intent.state,
    to_state: state,
    broker_order_id: brokerOrderId,
    message,
    fill_identity: fillIdentity,
    payload,
  };
}

function cloneOrder(order: BrokerOrder): BrokerOrder {
  return {
    ...order,
    pricing: { ...order.pricing },
    fills: order.fills.map((fill) => ({ ...fill })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out|unknown/i.test(error.message);
}
