/**
 * The box engine: the one object that owns the module's lifecycle.
 *
 * It wires the shared market-data feed to the scanner and the position monitor,
 * maintains the ATM±3 strike windows and their subscriptions, executes through
 * one mode-neutral gateway, persists fills, and publishes state to the UI.
 *
 * Two independent switches:
 *
 *   DISCOVERY  (RUN / STOP)  — opening NEW boxes.
 *   MONITORING (always on)   — managing and exiting boxes that are already open.
 *
 * STOP only turns discovery off. Positions never become unmanaged.
 */

import type { Response } from "express";
import type { Instrument } from "../kite.js";
import type { BrokerId } from "../brokers/types.js";
import type {
  BoxChargeCalculatorLike,
  BoxFeedProvider,
  BoxLiveAdapterFactory,
  BoxMarginProvider,
  BoxMarketDataProvider,
} from "./brokerContext.js";
import { createPlannedMarginProvider } from "./plannedMarginEvidence.js";
import type { Tick } from "../ticker.js";
import {
  BOX_TUNING_KEYS,
  BOX_TUNING_LIMITS,
  clampStrikeLevel,
  configSnapshot,
  loadBoxConfig,
  lotRelativeThresholdsEnabled,
  prefilterGrossThreshold,
  readTuning,
  requiredNetProfit,
  validateTuning,
  type BoxConfig,
  type BoxPaperProfile,
  type BoxTuning,
} from "./config.js";
import type { BrokerAdapter } from "./brokerAdapter.js";
import {
  burstPacingBudgetMs,
  resolveBrokerPacing,
  type EffectiveBrokerPacing,
} from "./brokerPacing.js";
import {
  currentSelection,
  evaluateLiveArm,
  evaluateModeTransition,
  executionModeLabel,
  transitionBlockers,
  type ExecutionModeSelection,
  type ModeTransitionSnapshot,
} from "./liveModeTransition.js";
import { BoxChargeEstimator, buildEntryChargeLegs, type BoxChargeLeg, type PriceChargeGroupsFn } from "./charges.js";
import { BoxChargeReconciler } from "./chargeReconciler.js";
import { activeUnderlyings, type UnderlyingActivity } from "./underlyingLock.js";
import { deriveRecoveryEscalation, recoveryEscalationBlocker } from "./recoveryEscalation.js";
import { deriveResidualNotional, residualNotionalSummary } from "./residualNotional.js";
import {
  MAX_EXCLUDED_UNDERLYINGS,
  UnderlyingExclusionBook,
  allowlistEntryRefusal,
  exclusionEntryRefusal,
  validateExclusionInput,
  type UnderlyingExclusion,
} from "./underlyingExclusions.js";
import {
  projectUniverse,
  summariseUniverse,
  type UniverseSummary,
  type UniverseUnderlying,
} from "./universeView.js";
import { BoxTradingSessionManager } from "./tradingSessionStore.js";
import { AccountFundsTracker, unavailableFunds, type AccountFundsSnapshot } from "./accountFunds.js";
import { EntryAlertLedger } from "./entryAlerts.js";
import { BoxExecutionSimulator } from "./executionSimulator.js";
import { coherencePrecisionWarning } from "./executionCoherence.js";
import { createExecutionClock, type ExecutionClock } from "./executionClock.js";
import { ExecutionEnvironmentMonitor } from "./executionEnvironment.js";
import { ExecutionCalibrationStore, type CalibrationStage } from "./executionCalibration.js";
import { classifyTimeOfDayBucket, istMinutesOfDayFor } from "./latencyModel.js";
import { ExecutionTimingRecorder } from "./executionTiming.js";
import { CalibrationPersistenceBuffer } from "./calibrationPersistence.js";
import { BrokerTimingStore } from "./brokerTimingStore.js";
import { ExecutionOutcomeStore } from "./executionOutcomes.js";
import { ExecutionFunnel, type ZeroPostRefusalReason } from "./executionFunnel.js";
import { ExecutionFaultLog } from "./executionFaults.js";
import { QueueCalibrationEstimator } from "./queueCalibration.js";
import { computeExecutionShortfall, type ExecutionShortfall } from "./executionShortfall.js";
import { buildParityReports } from "./parityReport.js";
import type { BoxExecutionOutcome } from "./brokerTimingStore.js";
import type { LatencyProfile } from "./latencyModel.js";
import { shadowModeStatus } from "./shadowMode.js";
import { profileReportBanner } from "./stressProfile.js";
import { formatCalibrationBlock } from "./calibratedLatencySource.js";
import {
  CentralBoxExecutionGateway,
  checkedFeedBlockReason,
  type BoxExecutionGateway,
} from "./executionGateway.js";
import {
  residualBrokerRejections,
  residualRejectionBudgetExhausted,
} from "./residualFlatten.js";
import { evaluateSessionEntryWindow } from "../marketCalendar.js";
import { tradingDaysUntil } from "../marketCalendar.js";
import {
  adoptObservedFlattenCharges,
  compactObservedFlattenChargeWatermarks,
  compactResidualProjectionBookkeeping,
  createResidualProjectionCommand,
  persistOwnedResidualProjection,
  recoveryExecutionAttemptId,
  residualProjectionChanges,
  residualProjectionIdentity,
  runInitialRegisteredResidualPass,
  seedObservedFlattenCharges,
  seedObservedFlattenChargesForDay,
  type BoxExecutionAttemptProjectionCommand,
  type BoxExecutionAttemptProjectionResult,
  type FlattenChargeDayObservation,
} from "./executionAttemptProjection.js";
import { CoordinatedBoxExecutionGateway } from "./executionCoordinator.js";
// The BARREL, not the `instrumentReservations.js` shim: this is the one module that
// needs the Mongo-bound factory, and the engine is already database-bound.
import {
  createReservationStack,
  isDeploymentIdExplicit,
  type ReservationStack,
} from "./reservations/index.js";
import { mintOwnerId } from "./reservations/identity.js";
import { BoxExecutionLeaseManager, executionLeaseStatus } from "./executionLease.js";
import {
  buildAttributedFlattenResult,
  classifyPositionClose,
  classifyResidualFlatten,
  type AttributedFlattenResult,
  type FlattenItemOutcome,
} from "./flattenOutcome.js";
import { ExposureOperationRegistry } from "./exposureOperations.js";
import {
  degradedRecoveryStatus,
  degradedRecoveryVerdict,
  type DegradedRecoveryStatus,
  type FeedCondition,
  type RecoveryDepthCapability,
} from "./degradedRecovery.js";
import {
  BoxOrderManager,
  orderManagerLimitsFromConfig,
  type CancelWorkingBoxOrdersResult,
  type OrderManagerReconcileReport,
} from "./orderManager.js";
import { BoxMetrics } from "./metrics.js";
import {
  buildUnderlyingState,
  indexOptionChains,
  prioritiseUniverse,
  windowNeedsRebuild,
  windowTokens,
  type BoxBoardItem,
  type BoxChainIndex,
} from "./instruments.js";
// THE UNIVERSE PIPELINE DIAGNOSIS. Names the FIRST stage that stopped, so "0 candidates" — a
// symptom shared by fifteen different causes — is never the only thing an operator is told.
import {
  assessUniverseReadiness,
  type InstrumentLoadState,
  type UniverseReadiness,
} from "./universeReadiness.js";
import { buildCandidates, round2 } from "./math.js";
import { BoxPositionBook, deriveBoxPositionState, fullLotByRole, isBoxPositionFlat, outstandingRoles, type BoxOpenPosition } from "./positions.js";
import { exactEntryFillViolation, singleLotCandidateViolation, singleLotPositionViolation } from "./singleLotInvariant.js";
import { BoxPositionMonitor } from "./positionMonitor.js";
import { BoxQuoteStore, SpotStore } from "./quotes.js";
import { orderStreamStatus } from "./orderStreamStatus.js";
// SECTION 7: the ONE authoritative readiness decision, shared by getStatus() and the operator
// runtime-status endpoint so the two can never publish disagreeing verdicts.
import {
  buildOperationalReadiness,
  unownedAttributedExposureBlocker,
  type OperationalReadinessDecision,
  type ReadinessBlocker,
  type MarketDataSource,
} from "./operationalReadiness.js";
import {
  brokerFundingLimitations,
  fundingReadinessBlockers,
  type FundingReadiness,
} from "./fundingReadiness.js";
import type { EconomicAdmissionReport } from "./boxCapital.js";
import type { OrderStreamHealth } from "./orderUpdateProjection.js";
import { OrderStreamConsumer } from "./orderStreamConsumer.js";
import { createDhanOrderStreamHandlers } from "./dhanOrderStreamWiring.js";
import { BackendInstance } from "./backendInstance.js";
import {
  describeCandidateMarketDataVerdict,
  evaluateCandidateMarketData,
} from "./candidateMarketData.js";
import { MarketDataStateMachine, marketDataPermissions, entryPermittedFromStreams, type MarketDataState, type OrderStreamLifecycleState } from "./streamHealthPolicy.js";
import { StagePipeline } from "./boundedQueue.js";
import { parseKiteOrderFrame, zerodhaOrderStreamEnabledFromEnv, zerodhaTextFramesConsumed } from "../brokers/zerodha/orderUpdates.js";
import { dhanOrderStreamEnabledFromEnv, type DhanOrderFeed } from "../brokers/dhan/orderFeed.js";
import { ensureBoxPersistenceReady } from "./repository.js";
import {
  appendBoxEvent,
  allocateBoxTradeId,
  applyBoxExecutionAttemptProjection,
  applyBoxPartialExit,
  applyBoxReconciledProjection,
  cancelBoxPnlDeletion,
  closeBoxTrade,
  deleteBoxDailyPnlForTrade,
  deleteBoxDailyPnlRows,
  deleteBoxTrade,
  filterExistingBoxTradeIds,
  findBoxTradeById,
  ensureBoxRecoveryExecutionAttempt,
  initialiseBoxExecutionAttemptPersistence,
  isBoxRecoveryPersistenceReady,
  insertBoxExecutionAttempt,
  insertBoxTrade,
  isBoxDailyPnlSnapshotComplete,
  isBoxDbEnabled,
  isValidBoxId,
  loadBoxDailyPnlSnapshot,
  loadBoxMarginIntervalsSince,
  markBoxDailyPnlComplete,
  markBoxDailyPnlIncomplete,
  loadBoxExecutionAttempts,
  loadBoxLiveRiskSeed,
  loadBoxExcludedUnderlyings,
  saveBoxExcludedUnderlying,
  deleteBoxExcludedUnderlying,
  applyBoxExcludedUnderlyingsBulk,
  loadBoxSettings,
  loadBoxTradingSession,
  loadFlatBoxTradeIds,
  loadBoxTradesClosedSince,
  loadOpenBoxTrades,
  loadUnresolvedBoxExecutionAttempts,
  markBoxTradeRecovery,
  consumeBoxTradingSessionEntryAttempt,
  loadBoxCalibrationSamples,
  persistBoxCalibrationSamples,
  prepareBoxPnlDeletion,
  reconcileBoxDailyPnlOrphans,
  saveBoxSettings,
  saveBoxTradingSession,
  serializeBoxTrade,
  setBoxChargeReconciliation,
  setBoxTradeMargin,
  toEventLegs,
  tradeKey,
  updateBoxTradeLive,
  upsertBoxDailyPnl,
  type SerializedBoxTrade,
  boxOrderIntentPersistence,
} from "./repository.js";
import type { BoxTradeRecord } from "./model.js";
import { BoxClosedTradeCache, liteClosedTrade } from "./closedCache.js";
import { BoxPnlCache } from "./pnlCache.js";
import { BoxPnlArchiver, istDayStartMs } from "./pnlArchive.js";
import type {
  BoxDailyPnlSummary,
  ClosedPnlInput,
  OpenPnlInput,
} from "./pnlSnapshot.js";
import { BoxScanner } from "./scanner.js";
import {
  BOX_DIRECTIONS,
  BOX_LEG_ROLES,
  directionLabel,
  directionOf,
  type BoxCandidate,
  type BoxChargesWithOrigin,
  type BoxDirection,
  type BoxEntryDecision,
  type BoxEvaluation,
  type BoxExecutionRecord,
  type BoxExitMetrics,
  type BoxExitReason,
  type BoxLegRole,
  type BoxOrderIntentState,
  type BoxOpportunity,
  type BoxOptionInstrument,
  type BoxUnderlyingState,
  type IBoxExecutionAttempt,
  type IBoxExitAttempt,
  type IBoxLeg,
  type IBoxTrade,
  type PaperLeggingExecutionRecord,
  type ResidualLegExposure,
  isPaperExecutionMode,
  statedExecutionMode,
  type ExecutionMode,
} from "./types.js";
import type { BoxExecutionFailureReason } from "./types.js";
import type { BoxEntryOutcomeClass } from "./types.js";
import { entrySideFor } from "./math.js";
import { brokerOf } from "../brokers/types.js";
import { peakConcurrentMargin, usableMarginIntervals } from "./marginReplay.js";

export interface BoxEngineDeps {
  /**
   * Broker-neutral market data. NOT a KiteClient: the engine must not be able to
   * name a venue. See brokerContext.ts for why the surface is this small.
   */
  marketData: BoxMarketDataProvider;
  /**
   * Which broker currently owns the feed, the scanner and execution.
   *
   * A function rather than a value because it is read at decision time: a broker
   * switch must be visible to the very next trade the engine stamps, without
   * reconstructing the engine.
   */
  activeBroker: () => BrokerId;
  /**
   * The broker GENERATION, bumped on every switch.
   *
   * Stamped onto every durable reservation and re-checked before execution, so a
   * worker cannot keep trading a lease taken under a broker that is no longer active.
   * Optional, defaulting to 0, so existing wiring and every existing test behave
   * exactly as before.
   */
  brokerGeneration?: () => number;
  /**
   * A NON-SECRET reference to the authenticated broker account (masked id / hash, never a token).
   * Binds funds/margin evidence to the account it was read for. Absent ⇒ null ⇒ the account half of
   * the identity check is skipped, and unknown is never treated as a mismatch.
   */
  brokerAccountRef?: () => string | null;
  /**
   * The ACTIVE broker's live feed. Not a TickerHub: the engine must not be able to
   * reach a specific broker's socket (see brokerContext.ts).
   */
  feed: BoxFeedProvider;
  /**
   * The ACTIVE broker's charge calculator.
   *
   * Injected rather than constructed, because the expected-net gate spends whatever
   * this says — costing a Dhan trade with Zerodha brokerage would make the gate
   * quietly wrong.
   */
  charges: BoxChargeCalculatorLike;
  getAllInstruments: () => Promise<Instrument[]>;
  getBoard: () => Promise<BoxBoardItem[]>;
  /**
   * The ACTIVE broker's charge estimator.
   *
   * Broker-scoped on purpose: a Dhan trade costed with Zerodha brokerage would
   * make the expected-net gate spend money it does not have. The registry swaps
   * this with the broker.
   */
  priceChargeGroups: PriceChargeGroupsFn;
  istDayKey: (at?: number) => string;
  makeIdResolver: (all: Instrument[]) => (token: number) => string | null;
  /** NSE equity-derivatives hours, reused from the calendar engine. */
  isMarketOpen: () => boolean;
  /** The ACTIVE broker's basket-margin provider. */
  margins: BoxMarginProvider;
  /**
   * Builds the live order adapter. Absent ⇒ live execution is impossible, which
   * is the correct default: no injected adapter means no way to place an order.
   */
  createLiveAdapter?: BoxLiveAdapterFactory;
  /**
   * Construct the Dhan DEDICATED order-update feed (wss://api-order-update.dhan.co), bound to the
   * registry's CURRENT session token/client id. Absent ⇒ no Dhan order stream is available and the
   * consumer honestly reports the stream disabled while REST polling remains the fill authority.
   * The registry returns null when Dhan is not the active broker, so an order feed can never
   * observe a broker the system is not trading.
   */
  createDhanOrderFeed?: (handlers: {
    onObservation: (observation: import("./orderUpdateProjection.js").NormalizedOrderObservation) => void;
    onConnecting?: () => void;
    onConnected?: (args: { authorised: boolean; reconnect: boolean }) => void;
    onDisconnected?: () => void;
    onSessionLost?: (reason: string) => void;
    nowMono?: () => number;
    nowWall?: () => number;
  }) => DhanOrderFeed | null;
}

/** Minutes past IST midnight, right now. */
function istMinutesOfDay(at: number = Date.now()): number {
  const ist = new Date(at + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

interface SseClient {
  res: Response;
}

/**
 * Map a terminal entry {@link BoxExecutionFailureReason} onto the funnel's low-cardinality
 * zero-POST refusal vocabulary. Only meaningful for a refusal (submitted === false).
 */
function zeroPostReasonFor(reason: BoxExecutionFailureReason | null | undefined): ZeroPostRefusalReason {
  switch (reason) {
    case "cross_leg_time_skew":
      return "coherence";
    case "box_capital_limit":
      return "capital";
    case "missing_book":
    case "feed_unhealthy":
      return "depth";
    case "legging_incomplete":
      return "deadline";
    case "underlying_already_active":
    case "duplicate":
    // Exposure at the broker that no record owns. `ownership` is exactly right — it is an
    // ownership failure, not an entry-guard preference — and it keeps the funnel's account of
    // WHY nothing was posted truthful for the one refusal that means real exposure is loose.
    case "unowned_attributed_exposure":
      return "ownership";
    case "insufficient_quantity":
    case "price_moved":
    case "edge_disappeared":
    case "below_expected_net_profit":
    case "market_closed":
    case "discovery_stopped":
    case "session_limit_reached":
    // A CONFIGURATION refusal, not a market one: the instrument's lot cannot satisfy the live
    // quantity envelope. Deliberately not `capital` (that is a ₹ notional cap) and emphatically not
    // `depth` — the order book is irrelevant to it.
    case "lot_exceeds_quantity_cap":
    default:
      return "entry_guard";
  }
}

/**
 * How often to retry claiming the durable boot ordinal after a transient failure.
 *
 * 15s: while it is unclaimed NEW ENTRY IS REFUSED, so recovering promptly matters — but the only thing
 * that can fix it is PostgreSQL becoming reachable, and hammering a database that is already
 * struggling is how a recovery poll becomes part of the outage. Deliberately not configurable: it is
 * an internal recovery cadence, not a risk control, and one more env var on this surface is a worse
 * trade than a sensible fixed value.
 */
const BOOT_ORDINAL_RETRY_MS = 15_000;

export class BoxEngine {
  private cfg: BoxConfig;
  private quotes = new BoxQuoteStore();
  private spots = new SpotStore();
  private positions = new BoxPositionBook();
  private charges: BoxChargeEstimator;
  private localCharges: BoxChargeCalculatorLike;
  private executionSim: BoxExecutionSimulator;
  private execution: BoxExecutionGateway;
  /**
   * Contract-level reservations: the fast in-process tier plus, when configured, the
   * durable cross-process authority. Held here so a broker switch can clear them and
   * so boot() can bring the durable tier up.
   */
  private readonly reservations: ReservationStack;
  /** The coordinator, kept typed so its metrics reach diagnostics. */
  private readonly coordinator: CoordinatedBoxExecutionGateway;
  private orderManager: BoxOrderManager | null = null;
  /**
   * LIVE-CALIBRATION INFRASTRUCTURE (Phases 2, 7, 8, 13, 24).
   *
   * All four are additive and fail-open. The clock separates monotonic measurement from
   * wall-clock audit; the environment monitor explains latency outliers; the calibration store
   * accumulates dimensioned measured distributions that paper consumes; the timing recorder is
   * the bridge that finally connects the live order path to both stores. None of them can affect
   * whether or how an order is placed.
   */
  private readonly executionClock: ExecutionClock;
  private readonly environmentMonitor: ExecutionEnvironmentMonitor;
  private readonly calibration: ExecutionCalibrationStore;
  private readonly brokerTiming: BrokerTimingStore;
  /**
   * PAPER-side timing store, the counterpart of `brokerTiming`.
   *
   * `parityReport` compares a LIVE snapshot against a PAPER snapshot, and it previously had no
   * production caller for exactly one reason: nothing produced the paper half. This store is fed
   * from finished paper legs, which is what makes a live-vs-paper comparison possible at all.
   */
  private readonly paperTiming: BrokerTimingStore;
  private readonly timingRecorder: ExecutionTimingRecorder;
  /**
   * Bounded async buffer that persists measured calibration observations (Phase 25).
   *
   * Without it, calibration dies with the process — a restart at 09:30 discards the morning's
   * evidence exactly when it is most valuable. Recording is one in-memory append with no await and
   * no I/O; flushing is batched and off the order path entirely.
   */
  private readonly calibrationPersistence: CalibrationPersistenceBuffer;
  /** Measured outcome and reject-family rates (Phases 9, 19). */
  private readonly outcomeStore = new ExecutionOutcomeStore();
  /**
   * THE EXECUTION FUNNEL (Task 8): outcome counts with EXPLICIT denominators, incremented from
   * REAL execution events — candidates at the scanner, qualified at the economic gate, the
   * terminal entry outcome at {@link observeAttempt}, and completed exits at
   * {@link closePaperTrade}. Pure accounting; it never decides anything. Read-only via getStatus.
   */
  private readonly funnel = new ExecutionFunnel();
  /**
   * Bounded store of TECHNICAL entry-pipeline faults, classified into a fixed taxonomy.
   *
   * Exists so the dashboard can distinguish "Mongo is down" from "the durable reservation
   * authority is unreachable" from "a programming bug", instead of collapsing all of them into
   * one `internal_error` counter. Bounded on both axes: a 50-entry ring and a closed set of
   * class counters, so neither memory nor metric cardinality grows with traffic.
   */
  private readonly entryFaults = new ExecutionFaultLog();
  /**
   * WHICH UNDERLYING WAS REFUSED, AND WHY — the operator-facing alert surface.
   *
   * Complements, and does not duplicate, the three things that already exist and each lose part of
   * the answer: `metrics.rejection_categories` has the reason but structurally cannot carry a symbol,
   * `entryFaults` has the stack but only for thrown faults, and `box_execution_attempts` has the
   * symbol but is only written once legs have actually filled. This is the one place that answers
   * "which stock failed, for what reason, how many times, and what do I do about it".
   *
   * Bounded and aggregated — see entryAlerts.ts for why keying by underlying is safe here and was
   * not safe in the metric.
   */
  private readonly entryAlerts = new EntryAlertLedger({ now: () => Date.now() });
  /** Advisory queue/haircut recommender fed by live limit-order evidence (Phases 10, 26). */
  private readonly queueEstimator: QueueCalibrationEstimator;
  /** Most recent implementation-shortfall attribution, surfaced in diagnostics. */
  private lastShortfall: ExecutionShortfall | null = null;
  private reconciler: BoxChargeReconciler;
  private metrics: BoxMetrics;
  private scanner: BoxScanner;
  private monitor: BoxPositionMonitor;
  private pnlCache: BoxPnlCache;
  private pnlArchiver: BoxPnlArchiver;

  private closedCache: BoxClosedTradeCache;

  /** Running tally of trades CLOSED today, for the day-P&L view (no Mongo on read). */
  private closedTodayDay = "";
  private closedTodayCount = 0;
  private closedTodayNet = 0;
  private closedTodayGross = 0;
  /** Total basket margin that today's closed boxes had blocked while they were on. */
  private closedTodayMargin = 0;
  /**
   * Highest OPEN basket margin observed at any status sample since process start.
   *
   * Sampled, not continuously integrated: it can only reflect margin levels that
   * actually coincided with a status read (or SSE publish), so it is a lower bound
   * on the true peak, never an invented figure. Null until a first open-margin
   * sample exists, and never backfilled from history that predates this process.
   */
  private peakConcurrentMargin: number | null = null;
  /** How many of today's closed boxes never got a margin figure back from Zerodha. */
  private closedTodayMarginUnknown = 0;
  /**
   * TODAY's closed trades, newest first — the Closed-trades tab's fast path.
   *
   * Held in process so the view costs nothing to read: seeded from Mongo at boot,
   * appended to on every close, and mirrored to Redis so a restart mid-session
   * refills it in one round trip instead of re-querying the whole closed book.
   */
  private closedTodayTrades: SerializedBoxTrade[] = [];
  /**
   * The IST day `closedTodayTrades` has actually been LOADED for, or null.
   *
   * Deliberately a day key rather than a boolean. A boolean flipped by the day-roll
   * helper would mark the list authoritative whenever the day field merely became
   * current — including the `"" → today` roll that happens on the first request
   * after a FAILED boot seed. That would answer "no closed trades" from memory for
   * the rest of the day without ever consulting Redis or Mongo: precisely the
   * empty-Closed-tab bug this whole change exists to fix.
   */
  private closedTodayLoadedFor: string | null = null;
  /** The directions the scanner builds candidates for. */
  private directions: readonly BoxDirection[];
  /**
   * The ACTIVE strikes-each-side level (1, 2 or 3), admin-adjustable at runtime.
   *
   * Never above the config cap (ATM ±3). Narrowing it changes only which NEW
   * boxes are discovered — open positions keep their own legs and are managed
   * independently, so a level change can never affect a trade already on.
   */
  private strikeLevel: 1 | 2 | 3;
  /** Forces every window to rebuild on the next refresh (set by setStrikeLevel). */
  private forceWindowRebuild = false;
  /**
   * THE OPERATOR BLOCKLIST — underlyings that must never be ENTERED, in any execution mode.
   *
   * Held in memory because all four enforcement points are synchronous (the scanner's tick path and
   * the coordinator's no-await prologue both forbid a query), and reloaded from
   * `box_excluded_underlyings` at boot. A mid-session database outage therefore cannot lose the
   * blocklist: only a WRITE can fail, and a failed write is reported to the operator and rolled back
   * in memory rather than silently diverging from what is stored.
   *
   * Starts in `never_loaded`, which REFUSES entry. That is deliberate: until the durable list has
   * been read we cannot assert any name is permitted, and the scanner cannot enter anything before
   * `start()` anyway, so the closed default costs nothing.
   */
  private readonly exclusions = new UnderlyingExclusionBook();
  /**
   * CONFIRMED FILLS THAT ARE NOT YET RECORDED — the gap `BOX_MAX_OPEN_BOXES` would otherwise miss.
   *
   * THE WINDOW THIS CLOSES. The coordinator releases its entry claim in `settle()`, which runs as
   * soon as the inner execution returns. The position is only added to the book later, inside
   * `openPaperTrade`, and `insertWithRetry` puts a PostgreSQL round trip in between. For those few
   * milliseconds the four legs are genuinely filled and yet nothing counts them: the claim is gone
   * and `positions.size` has not moved. A tick arriving in that window could admit a second box.
   *
   * The session ATTEMPT budget happens to cover this for a one-attempt trial, but that is a
   * coincidence of configuration, not a property of the ceiling — an operator who sets
   * `BOX_MAX_OPEN_BOXES=1` and leaves the attempt budget unlimited would still get two boxes. So the
   * ceiling closes its own gap: incremented around the whole establishment call, decremented in a
   * `finally`, so it holds the slot until either the position is in the book or the open provably
   * failed. Together with the coordinator's in-flight claims this gives continuous coverage from
   * admission to durable record, with no uncounted interval.
   */
  private pendingEstablishments = 0;
  /**
   * The CONFIGURED gross prefilter (MIN_BOX_GROSS_EDGE), before any gate-driven
   * narrowing. Captured once at construction so applyTuning can re-derive the live
   * prefilter from a fixed baseline instead of clamping the running value, which
   * would only ever ratchet downwards.
   */
  private readonly baseMinGrossEdge: number;

  /** Underlying → its current seven-strike window. */
  private windows = new Map<string, BoxUnderlyingState>();
  /** Underlying → nearest live expiry chain index. */
  private chains = new Map<string, BoxChainIndex>();
  private board: BoxBoardItem[] = [];
  /** Every option token we have asked the hub to stream for the box module. */
  private subscribedOptionTokens = new Set<number>();
  private subscribedSpotTokens = new Set<number>();
  private skippedForBudget: string[] = [];
  /**
   * Left out because BOX_MAX_UNDERLYINGS capped the list, NOT because the feed budget bound.
   *
   * Kept apart from `skippedForBudget` for exactly the reason `skippedForIndicativeCap` is: these are
   * two unrelated limits with identical symptoms, and merging them made the UI blame the live-feed
   * token budget for a cap that has nothing to do with tokens. With `BOX_MAX_UNDERLYINGS=1` and 215
   * joined names the operator was told 214 underlyings were "outside the live-feed token budget
   * (2200 instruments)" while the budget had hundreds of tokens to spare — so the reported cause
   * pointed at a number that was not the constraint, and the one setting that WAS went unnamed.
   */
  private skippedForUnderlyingCap: string[] = [];
  /** Left out of the last-close preview by its own cap, not by the feed budget. */
  private skippedForIndicativeCap: string[] = [];

  private releaseRetainer: (() => void) | null = null;
  private removeTickListener: (() => void) | null = null;
  private removeConnectionListener: (() => void) | null = null;
  private universeTimer: NodeJS.Timeout | null = null;
  /**
   * THE STANDING ACCOUNT-BALANCE OBSERVATION.
   *
   * Separate from the `available_funds` figure inside `economic_admission`, which is a by-product of
   * live entry admission and is therefore null in paper, null when the funding gates are off, and
   * null until the first entry has been evaluated — i.e. absent exactly when an operator is deciding
   * whether to arm. This one is refreshed on its own timer whenever a session exists, in any mode.
   */
  private readonly accountFunds: AccountFundsTracker;
  private fundsTimer: NodeJS.Timeout | null = null;
  /** True while a refresh is in flight, so a slow broker cannot stack overlapping reads. */
  private fundsRefreshInFlight = false;
  private publishTimer: NodeJS.Timeout | null = null;

  private running = false;
  private started = false;
  private startedAt: number | null = null;
  /**
   * Order-stream health per broker, keyed by whatever component is CONSUMING that broker's
   * order-update stream.
   *
   * Empty means no consumer exists, which `orderStreamStatus` reports as `not_wired` /
   * `rest_polling_only`. It is deliberately a plain empty map rather than an optional
   * dependency with a default-healthy fallback: the absence of a consumer must surface as an
   * honest operational state, never as silence that reads like health.
   */
  private readonly orderStreamConsumers = new Map<BrokerId, OrderStreamHealth>();
  private stoppedAt: number | null = null;
  private lastError: string | null = null;
  private universeBuiltAt: number | null = null;
  private sseClients = new Set<SseClient>();

  /** Cached exchange-hours state, refreshed on the market timer. */
  private marketOpen = false;
  private feedHealthy = false;
  /** Monotonic reference for the market-watch loop-stall check that feeds the backlog signal. */
  private marketWatchStallRef: number | null = null;
  /** Raw current-socket arrival clock; intentionally independent of depth books. */
  private lastRawTickAt: number | null = null;
  private feedGeneration = 0;
  private readonly tokenFeedGeneration = new Map<number, number>();
  private marketTimer: NodeJS.Timeout | null = null;
  private indicativeTimer: NodeJS.Timeout | null = null;

  /* ─────────────── UNIVERSE PIPELINE OBSERVATIONS (see universeReadiness.ts) ───────────────
   *
   * These exist because `underlyings: this.windows.size` was the ONLY universe figure published, so
   * "the instrument dump came back empty" and "the market is quiet" were both rendered as `0`. Each
   * field is an observation recorded at the stage that produces it, never inferred.
   */
  /** How the instrument master load stands. Four states, because "loading" ≠ "failed" ≠ "empty". */
  private instrumentLoadState: InstrumentLoadState = "never_attempted";
  /** The broker's own load-failure message, verbatim. */
  private instrumentsError: string | null = null;
  /** Rows returned by the last successful load. */
  private instrumentCount = 0;
  private instrumentsLoadedAt: number | null = null;
  /** Consecutive load failures. Drives the bounded retry AND is published. */
  private instrumentLoadFailures = 0;
  /** Board rows BEFORE the chain join. */
  private boardRowsDerived = 0;
  private chainsIndexed = 0;
  /** Board rows that also have a chain — what the universe loop actually iterates. */
  private boardWithChains = 0;
  /** Joined underlyings still lacking a spot price, so no ATM window can be centred. */
  private underlyingsMissingSpot = 0;
  private spotSeedFailed = false;
  private spotSeedError: string | null = null;
  /** Last universe pass that produced at least one window. */
  private lastSuccessfulBuildAt: number | null = null;
  /**
   * Bounded retry for a FAILED universe pass.
   *
   * The recurring universe timer already retries, but at `universeRefreshMs` — far too slow to be
   * the recovery path for a transient instrument download failure, and it leaves the scanner blind
   * in the meantime. This is a short, capped, DEDUPLICATED retry so a blip recovers on its own
   * without an operator pressing anything, restarting the process or regenerating a token.
   */
  private universeRetryTimer: NodeJS.Timeout | null = null;
  /**
   * Consecutive FAILED universe passes — the backoff's own counter.
   *
   * Deliberately NOT `instrumentLoadFailures`: that one is reset to 0 immediately after a successful
   * load, so deriving the delay from it pinned the backoff at the 2s base for any failure occurring
   * AFTER the load (the spot seed, subscription application, anything added later). Every retry then
   * re-ran the REST spot seed at 2s intervals — a retry storm, which is exactly what the bound exists
   * to prevent.
   */
  private universeRetryAttempts = 0;
  /**
   * True while a universe pass is in flight.
   *
   * The retry timer, the recurring universe timer, RUN and a strike-level change can all invoke a
   * pass. Deduplicating the TIMER is not enough — two overlapping passes each await the instrument
   * load and then the REST spot seed while mutating `chains`/`board`/`spots`/`windows`. The provider's
   * `inFlight` map collapses the download, but not the second REST quote call.
   */
  private universePassInFlight = false;
  private static readonly UNIVERSE_RETRY_BASE_MS = 2_000;
  private static readonly UNIVERSE_RETRY_MAX_MS = 60_000;
  /**
   * True once {@link dispose} has run.
   *
   * Needed so the bounded universe retry cannot re-arm itself during shutdown — a timer that
   * rebuilds the universe after the engine has released its feed and stopped its monitors would
   * resurrect work nothing is left to consume.
   */
  private disposed = false;
  private indicativeAt: number | null = null;
  private indicativePriced = 0;
  /** Positions whose margin fetch is currently in flight (dedupe guard). */
  private marginInFlight = new Set<string>();
  /** Backfill rounds spent per position, so a hopeless one is not retried forever. */
  private marginBackfillTries = new Map<string, number>();
  private static readonly MAX_MARGIN_BACKFILLS = 5;
  /** Rolling ring of (receive time − exchange timestamp) samples, in ms. */
  private exchangeLagSamples: number[] = [];
  private exchangeLagCursor = 0;
  private static readonly EXCHANGE_LAG_WINDOW = 500;
  /** The trading day the last-close view was built from. */
  private indicativeSessionDay: string | null = null;
  /** Legs discarded because they last traded in an EARLIER session. */
  private indicativeStaleLegs = 0;

  /* ------------------------- execution durability ------------------------- */
  /**
   * Boxes whose four legs filled but whose trade-projection insert has not yet
   * succeeded. Retained so a broker-confirmed or simulated fill is never erased
   * when persistence is temporarily unavailable; drained by a slow retry loop.
   */
  private pendingPersists: { payload: IBoxTrade; key: string; attempts: number; preallocatedId?: string }[] = [];
  private ownedRetryTimer: NodeJS.Timeout | null = null;
  private static readonly OWNED_RETRY_MS = 15_000;
  /** How many synchronous insert attempts one fill gets before it is retained. */
  private static readonly PERSIST_RETRY_ATTEMPTS = 3;
  /**
   * Outstanding residual exposure the engine is still trying to flatten, keyed by
   * the execution-attempt id it belongs to. Rebuilt at startup from unresolved
   * attempts, so an interrupted unwind is resumed whether or not RUN is pressed.
   */
  private residualByAttempt = new Map<string, ResidualLegExposure[]>();
  /**
   * Which UNDERLYING each residual attempt belongs to.
   *
   * Residual legs are keyed by attempt id and carry only per-contract identity, so on their own
   * they cannot answer "does RELIANCE have unresolved exposure?". The attribution is recorded at
   * both registration sites — the live entry path, which knows the candidate, and boot
   * reconciliation, which reads `underlying` off the durable execution attempt — so the
   * underlying lock's answer survives a restart.
   */
  private residualUnderlyingByAttempt = new Map<string, string>();
  /**
   * WHOSE residual each attempt is: the execution mode and broker it was created under.
   *
   * Recorded because residual legs are worked by a periodic loop that reached the gateway with only
   * `{ residual, keyPrefix }` — no ownership at all — so the gateway forked on the PROCESS mode and
   * a `paper_legging` attempt's residual legs became real broker orders in a live process (and a
   * live attempt's real legs were "flattened" by simulation in a paper one).
   *
   * Durable rows state their own mode/broker, so reconciliation passes theirs through verbatim.
   * Anything registered by this process's own execution belongs to this process, which is the
   * default. Entries are NEVER removed for being foreign: `residualLegCount()` is what the
   * broker-switch guard and the exposure probe read, and under-reporting exposure there would be a
   * worse bug than the one being fixed. Foreign residuals are held, reported and not acted on.
   */
  private residualOwnershipByAttempt = new Map<string, { mode: ExecutionMode; broker: BrokerId }>();
  /**
   * Why residual exposure could not be READ, or null when it is known.
   *
   * Non-null means the durable residual picture is UNKNOWN — which is emphatically not the same as
   * empty, and is the state the old `catch { return []; }` was indistinguishable from. While set:
   * new entry is refused (an unknown amount of exposure may already be on), an `entry`-scoped
   * readiness blocker names the condition, and a bounded retry keeps trying to establish the truth.
   *
   * Deliberately `entry` and not `both`: not knowing what exposure exists makes taking MORE unsafe,
   * but it must never become a reason the exposure this process already holds cannot be reduced.
   */
  private residualRecoveryLoadError: string | null = null;
  /**
   * When THIS process first observed any unresolved-recovery condition, wall clock. Null when clear.
   *
   * The non-durable half of the escalation age. Residual exposure carries its own durable
   * `created_at`, which is preferred and survives a restart; the other unresolved states (unknown
   * orders, unattended working orders, incomplete reconciliation) have no durable timestamp anywhere
   * in the schema, so their age is measured from here and RESETS ON RESTART. That limitation is
   * reported rather than hidden — see `RecoveryAgeSource` in `recoveryEscalation.ts`.
   *
   * One number, cleared the moment nothing is unresolved, so nothing accumulates.
   */
  private recoveryUnresolvedSinceWall: number | null = null;
  /** Retry timer for an unreadable residual picture. Cleared the moment a read succeeds. */
  private residualRecoveryRetryTimer: NodeJS.Timeout | null = null;
  private static readonly RESIDUAL_RECOVERY_RETRY_MS = 15_000;
  /**
   * Restored positions this process must not execute against, keyed by trade id.
   *
   * Populated at adoption by comparing the position's own `execution_mode` against this process's.
   * The positions STAY in the book — the broker-switch guard, the delete guard and the margin totals
   * all read it, and hiding a position from them would be a worse bug. This is the visible record
   * that they exist and why they cannot be worked here.
   */
  private readonly modeMismatchedPositions = new Map<string, string>();
  /**
   * The armed trading session (`BOX_SESSION_MAX_COMPLETED_TRADES`).
   *
   * Durable, because a one-shot budget that a process restart could reset would be decorative.
   * Until its state has been READ successfully it refuses entry — an unread session is not an
   * unarmed one.
   */
  private readonly session: BoxTradingSessionManager;
  /**
   * EXCLUSIVE, ACCOUNT-SCOPED EXECUTION OWNERSHIP.
   *
   * The one thing the deployment previously assumed rather than enforced. `backend_instance_epoch`
   * orders a frontend's readiness decisions across a restart; it grants no exclusivity, and because
   * its increment is atomic two live processes always get DIFFERENT ordinals, so the "two instances"
   * branch of `orderReadinessDecision()` — which needs EQUAL ordinals — cannot fire for the topology
   * it was meant to catch. UI restart ordering is not execution fencing.
   *
   * Its `dispatchBlockReason()` is consulted SYNCHRONOUSLY at CHECKPOINT 5 in the order manager. See
   * `executionLease.ts` for exactly what a lease can and cannot guarantee — in particular that it
   * cannot retract a request already on the wire, and that neither broker accepts a fencing token.
   */
  private readonly executionLease: BoxExecutionLeaseManager;
  /**
   * SERVER-SIDE SINGLE-FLIGHT for the exposure-reducing operations.
   *
   * A browser that abandons a request does not cancel the server operation, so bounding the client's
   * wait creates the risk that an operator retries and a SECOND cancellation or flatten begins while the
   * first is still working. A second caller joins the running operation and receives its real result;
   * no second broker action is taken. See `exposureOperations.ts`.
   */
  private readonly exposureOperations = new ExposureOperationRegistry({
    log: (message) => console.warn(message),
  });
  /**
   * The live broker adapter, when one was constructed.
   *
   * Null in every paper deployment — which is the structural guarantee that a paper process
   * contains no object capable of placing a real order, and is why `BOX_EXECUTION_MODE` stays a
   * startup-only construction boundary.
   */
  private liveAdapter: BrokerAdapter | null = null;
  /**
   * The order-stream consumer for the active broker — the running component that consumes the
   * order-update stream, owns the single projection of truth, and drives the health state machine.
   * Null in paper and until live construction. When present it is registered in
   * {@link orderStreamConsumers} so `orderStreamStatus` reports the REAL wiring, never `not_wired`.
   */
  private orderStreamConsumer: OrderStreamConsumer | null = null;
  /** The Dhan dedicated order-update socket, when Dhan is active and the stream is armed. */
  private dhanOrderFeed: DhanOrderFeed | null = null;
  /**
   * THE DRIVEN MARKET-DATA HEALTH MACHINE (GAP 1).
   *
   * Turns the box market-data feed lifecycle into a {@link MarketDataState}. `READY` is
   * unreachable by socket-open: it requires authentication AND fresh usable depth for EVERY
   * traded (desired) instrument in the CURRENT generation. Driven from `onTicks` (frame + per-leg
   * depth), the feed connection listener / `onBoxLaneConnection` (connect/disconnect →
   * authenticated/disconnected), a feed session loss (`onMarketDataSessionLost` → AUTH_EXPIRED),
   * and the market-watch timer (`evaluate()` for heartbeat-gap / stale-book / backlog demotion).
   * Constructed on the monotonic clock so age comparisons never step with an NTP correction.
   */
  private readonly marketDataMachine: MarketDataStateMachine;
  /**
   * Whether the BOX market-data socket is currently connected.
   *
   * A raw TRANSPORT fact, tracked separately from {@link MarketDataStateMachine} state because the
   * two answer different questions and a dashboard must be able to show both. "Connected" is not
   * "ready": an open socket that has delivered no depth is connected and NOT usable, and reporting
   * only the machine state left an operator unable to tell that case from a closed socket.
   */
  private marketDataSocketConnected = false;
  /**
   * The most recent RECONNECTABLE transport fault on the box lane, if any.
   *
   * Kept distinct from `lastError` semantics around session loss: this one is self-healing and must
   * never be presented as an expired token.
   */
  private lastMarketDataTransportFault: string | null = null;
  /**
   * THE BACKPRESSURE PIPELINE (GAP 2).
   *
   * Decouples ingestion from processing so a slow stage cannot block order-state processing on the
   * single event loop. The `order_events` stage is NEVER-DROP: a WebSocket callback ENQUEUES the
   * raw frame and returns (staying lightweight), and a bounded microtask pump drains it into the
   * order-stream consumer; under overload it signals the market-data machine's backlog (blocking
   * NEW ENTRY and prompting reconciliation) while still delivering every event — a missing order
   * event is never a zero fill. Constructed on the monotonic clock.
   */
  private readonly ingestPipeline: StagePipeline;
  /** True while a pipeline drain is scheduled, so overlapping frames coalesce into one pump. */
  private ingestPumpScheduled = false;
  /**
   * The inner (uncoordinated) gateway.
   *
   * Retained only so read-only diagnostics can reach the per-Box capital report, which is computed
   * where the bounded order requests are built. Execution always goes through `this.coordinator`.
   */
  private readonly centralGateway: CentralBoxExecutionGateway;
  /** The paper profile currently in force. Mutable at runtime; LIVE is not. */
  private paperProfile: BoxPaperProfile;
  /** Durable projection version/content corresponding to each in-memory residual. */
  private residualProjectionVersion = new Map<string, number>();
  private residualProjectionIdentity = new Map<string, string>();
  /** Highest durable cumulative flatten charge this process has included per attempt. */
  private observedFlattenCharges = new Map<string, number>();
  /** Highest authoritative charge bucket observed for each attempt/day pair. */
  private observedFlattenChargesByDay = new Map<string, number>();
  /** Full immutable commands whose durable acknowledgement was lost. */
  private pendingResidualPersists = new Map<string, BoxExecutionAttemptProjectionCommand>();
  /** Attempt ids whose residual is being flattened right now (concurrency guard). */
  private residualFlattenInFlight = new Set<string>();
  /**
   * Attempt ids whose residual exhausted its broker-rejection retry budget and has already been
   * escalated to the operator.
   *
   * Once a reduction has been terminally refused `MAX_RESIDUAL_BROKER_REJECTIONS` times with zero
   * fill each time, retrying is pointless (an F&O ban period, an expired contract and a standing
   * RMS block do not clear on the next two-second tick) and each attempt spends an order request
   * from the daily budget that protective work for other positions depends on. So the loop stops
   * submitting — but it must say so exactly ONCE, not raise the same invariant every two seconds
   * for the rest of the session.
   *
   * The exposure is NEVER removed from `residualByAttempt`: it keeps counting toward
   * `residualLegCount()`, so new entry stays blocked and the readiness surface keeps naming it.
   * Deliberately in-memory only — a restart re-escalates, which is correct, because a restart is
   * also the moment the condition may genuinely have cleared.
   */
  private residualRejectionEscalated = new Set<string>();
  /**
   * The armed session id that authorised the most recent admitted entry attempt, re-checked at the
   * POST boundary. Null when no attempt has been admitted, or when sessions are not enforcing.
   */
  private entryAuthorizedSessionId: string | null = null;
  /** Bounded watchdog that works outstanding residuals; runs only while any exist. */
  private residualFlattenTimer: NodeJS.Timeout | null = null;
  private static readonly RESIDUAL_FLATTEN_MS = 2_000;

  constructor(private deps: BoxEngineDeps) {
    this.cfg = loadBoxConfig();
    this.charges = new BoxChargeEstimator(deps.priceChargeGroups, this.cfg);
    // The ACTIVE broker's fee schedule, injected by the registry.
    this.localCharges = deps.charges;
    this.metrics = new BoxMetrics(this.cfg.metricsWindow);
    this.directions = this.cfg.enableShortBox ? BOX_DIRECTIONS : (["LONG_BOX"] as const);
    this.strikeLevel = this.cfg.defaultStrikeLevel;
    this.baseMinGrossEdge = this.cfg.minGrossEdge;
    // The paper profile is the one execution-shape knob an operator may change at runtime,
    // because switching between paper timing models creates no new capability. LIVE is not
    // runtime-selectable — see liveModeTransition.ts for why that boundary is deliberate.
    this.paperProfile = this.cfg.paperExecutionProfile;

    // ── Calibration infrastructure, built before the simulator so it can consume it ──
    this.executionClock = createExecutionClock();
    // The market-data health machine reads the MONOTONIC clock so a heartbeat-gap / stale-book
    // comparison is never corrupted by an NTP step. heartbeatMaxAgeMs mirrors the feed-liveness
    // bound; bookMaxAgeMs mirrors the per-leg usable-book age the coherence gate already enforces.
    /*
     * ARMED IN EVERY EXECUTION MODE — this was the primary defect.
     *
     * This used to read `enabled: this.cfg.executionMode === "live"`, which coupled MARKET-DATA
     * MONITORING to LIVE-ORDER EXECUTION. They have nothing to do with each other: market data is
     * the quote feed, and `live` and all three paper modes consume the same real broker quote
     * socket with the same full-depth subscriptions. The scanner cannot find a box without books
     * whatever mode it is in.
     *
     * Under `paper_latency` the machine was therefore constructed DISABLED, and because almost
     * every transition early-returns in that state the whole diagnostic surface was dead:
     *
     *   • `onAuthenticated()` early-returned  ⇒ generation stayed at 0 forever;
     *   • `onUsableDepth()` early-returned    ⇒ no per-instrument depth was EVER recorded, so
     *                                           `lastDepthAt` stayed null and `readyInstruments`
     *                                           stayed 0 no matter how many books arrived;
     *   • the state stayed `DISABLED`          ⇒ published as a DISABLED market-data lifecycle;
     *   • `marketDataEntryBlocker("DISABLED")` has scope `both`, so it also reported EXPOSURE
     *     MANAGEMENT as blocked — the red exposure warning that appeared in paper for no reason
     *     other than that live readiness was off.
     *
     * That is the whole "SCANNING / DISABLED / generation 0 / no observed frame-or-depth" picture.
     * Arming the machine unconditionally does NOT weaken any gate: READY still requires
     * authentication, a live transport, no backlog and genuinely delivered depth in the current
     * generation, and per-candidate admission is still decided per candidate.
     */
    this.marketDataMachine = new MarketDataStateMachine({
      enabled: true,
      now: () => this.executionClock.mono(),
      // Wall stamps for audit/display only. Supplying BOTH clocks is what lets the machine publish
      // finished monotonic ages next to human-readable timestamps without any caller ever
      // subtracting one domain from the other.
      nowWall: () => this.executionClock.wall(),
      heartbeatMaxAgeMs: this.cfg.feedMaxAgeMs,
      bookMaxAgeMs: this.cfg.quoteMaxAgeMs,
    });
    // The backpressure pipeline. The order-event stage is NEVER-DROP: a raw postback frame is
    // enqueued by the (lightweight) WS callback and drained by a bounded microtask pump into the
    // order-stream consumer. Capacity is a pressure THRESHOLD, not a cap — the queue holds and
    // delivers every event, and an overload only raises the backlog signal that blocks new entry.
    this.ingestPipeline = new StagePipeline({ now: () => this.executionClock.mono() });
    this.ingestPipeline.addStage<string>({
      name: "order_events",
      capacity: this.cfg.orderEventQueuePressureThreshold,
      overflow: "never-drop",
      handler: (raw) => this.processOrderEventFrame(raw),
      onOverload: (info) => {
        // Record the degraded condition and BLOCK new entry via the market-data backlog signal.
        // Exposure management (exit/cancel) is unaffected: it does not route through this queue.
        this.lastError =
          `order-event ingestion backlog (${info.depth} queued) — new entry paused, reconciling`;
        this.marketDataMachine.onProcessingBacklog(true);
        // A backlog means events may be arriving faster than we apply them: reconcile against the
        // broker so the durable truth is re-established, never inferred from the gap.
        void this.orderManager?.reconcile().catch(() => undefined);
      },
    });
    this.environmentMonitor = new ExecutionEnvironmentMonitor({
      enabled: this.cfg.executionEventLoopMetricsEnabled,
      clock: this.executionClock,
    });
    this.calibration = new ExecutionCalibrationStore({
      window: this.cfg.executionTimingWindow,
      // The region is a LABEL, never auto-detected, and a store never merges another region's
      // samples: two deployments have different physical RTTs to the broker.
      region: this.cfg.deploymentRegion,
      minSamples: this.cfg.paperCalibrationMinSamples,
      bucketMinSamples: this.cfg.paperCalibrationBucketMinSamples,
      maxAgeMs: this.cfg.paperCalibrationMaxAgeMs,
      nowWall: () => this.executionClock.wall(),
    });
    this.brokerTiming = new BrokerTimingStore({
      window: this.cfg.executionTimingWindow,
      region: this.cfg.deploymentRegion,
      now: () => this.executionClock.wall(),
    });
    this.paperTiming = new BrokerTimingStore({
      window: this.cfg.executionTimingWindow,
      region: this.cfg.deploymentRegion,
      now: () => this.executionClock.wall(),
    });
    this.queueEstimator = new QueueCalibrationEstimator({
      currentHaircutPct: this.cfg.queueLiquidityHaircutPct,
      minSamples: this.cfg.paperCalibrationMinSamples,
    });
    this.calibrationPersistence = new CalibrationPersistenceBuffer({
      enabled: this.cfg.liveTimingPersistEnabled,
      sink: (batch) => persistBoxCalibrationSamples(batch, this.cfg.deploymentRegion),
      batchSize: this.cfg.liveTimingBatchSize,
      flushMs: this.cfg.liveTimingFlushMs,
      now: () => this.executionClock.wall(),
    });
    this.timingRecorder = new ExecutionTimingRecorder({
      enabled: this.cfg.executionTimingMetricsEnabled,
      clock: this.executionClock,
      timingStore: this.brokerTiming,
      calibration: this.calibration,
      environment: this.environmentMonitor,
      // Mirror every measured span into the durable buffer so it survives a restart. Fail-open and
      // allocation-light: the recorder already swallows anything this throws.
      onPublish: (timing) => {
        const bucket = classifyTimeOfDayBucket(istMinutesOfDayFor(timing.atWall));
        for (const [stage, valueMs] of Object.entries(timing.spans)) {
          this.calibrationPersistence.record({
            broker: timing.identity.broker,
            kind: stage === "cancel_request_to_terminal_ms" ? "CANCEL" : timing.kind,
            profile: timing.profile,
            bucket,
            stage: stage as CalibrationStage,
            valueMs: valueMs as number,
            atWall: timing.atWall,
          });
        }
      },
    });

    this.executionSim = new BoxExecutionSimulator({
      cfg: this.cfg,
      quotes: this.quotes,
      metrics: this.metrics,
      isMarketOpen: () => this.marketOpen,
      isFeedHealthy: () => this.isFeedHealthy(),
      // Paper consumes the SAME store the live path writes to. That single shared store is what
      // makes the simulator progressively more accurate as real executions are observed — and it
      // is scoped by broker so paper only ever draws the latency of the broker it is shadowing.
      calibration: this.calibration,
      broker: () => this.deps.activeBroker(),
      istMinutesOfDay: () => istMinutesOfDay(),
      // OPERATOR BLOCKLIST, enforcement point 3 of 4 — the unbypassable refusal for every paper mode.
      underlyingExclusion: (underlying) => this.underlyingExclusionRefusal(underlying),
      // The local charge calculator prices paper_legging partial-entry and unwind
      // charges synchronously — never a network call inside the fill.
      chargeTotal: (orders) => this.localCharges.legs(orders).total,
    });

    if (this.cfg.executionMode === "live") {
      // The strategy does not build broker transports. The registry assembles the
      // active broker's adapter and injects the factory; a missing factory means
      // live execution is not possible, and that must stop startup rather than
      // quietly fall back to simulated fills.
      const createAdapter = this.deps.createLiveAdapter;
      if (!createAdapter) {
        throw new Error(
          "[Box] live execution blocked: no live execution adapter was injected for the active broker.",
        );
      }
      const adapter = createAdapter({
        broker: this.deps.activeBroker(),
        cfg: this.cfg,
        timing: this.timingRecorder,
      });
      // Retained ONLY so diagnostics can report the pacing the adapter is really enforcing.
      // Re-deriving it from config would usually agree, but "usually" is not a diagnostic: if the
      // adapter ever clamps differently the operator must see the adapter's number, not ours.
      this.liveAdapter = adapter;

      // ── ORDER-STREAM CONSUMER: the running component that consumes the order-update stream ──
      // Constructed HERE, in production, bound to the live adapter and the active account, so the
      // stream is not a disconnected helper: a stream event routes through the single projection
      // and then the adapter's applyOrderUpdate, which wakes the order's waiters. The env gate only
      // decides whether the transports are STARTED — the consumer always exists so REST
      // reconciliation and honest health reporting work even when the stream is off.
      const activeBroker = this.deps.activeBroker();
      const streamEnabled =
        activeBroker === "zerodha" ? zerodhaOrderStreamEnabledFromEnv() : dhanOrderStreamEnabledFromEnv();
      const consumer = new OrderStreamConsumer({
        broker: activeBroker,
        account: () => this.liveBrokerAccount(),
        adapter,
        streamEnabled,
        // Targeted REST reconciliation when a stream event is owned but its quantity is absent, and
        // for the reconnect gap repair. Delegated to the order manager's REST reconcile, which owns
        // the adapter's transport and the EXISTING guarded durable writes — no second persistence
        // path is invented here.
        restReconcile: async (_clientOrderId) => {
          try {
            const manager = this.orderManager;
            if (!manager) return;
            await manager.reconcile();
            // A TARGETED reconcile is NOT account-wide synchronization. This used to call
            // `consumer.markSynchronized()`, which promoted the whole stream to READY off the back of
            // resolving ONE order's missing quantity — an account-wide readiness claim from
            // single-order evidence, and an accidental back door out of RECONCILING that masked the
            // missing Dhan sweep wiring. What this REST round trip does legitimately prove is that
            // the SESSION is authorised, so that is all it records; leaving RECONCILING remains the
            // exclusive job of the checked gap-repair sweep.
            consumer.noteRestVerifiedSession();
          } catch {
            // Fail-open: a reconciliation failure leaves the stream DEGRADED/RECONCILING and REST
            // polling continues; it must never throw into the ingestion path.
          }
        },
        // POST-RECONNECT GAP-REPAIR SWEEP (D4). Driven by runReconnectReconciliation whenever the
        // machine is RECONCILING (first connect and every reconnect). It delegates to the SAME
        // order-manager REST reconcile — the existing guarded durable path — so no second
        // persistence path is invented. The consumer clears RECONCILING (→ READY) only after this
        // resolves consistently; a throw leaves it RECONCILING and REST polling continues. The
        // `_ingestRest` funnel is available for recovered observations that must also land in the
        // consumer's own projection; the manager's reconcile is the durable authority.
        reconcileSweep: async (_ingestRest) => {
          // RETURN A CHECKED VERDICT, NOT SILENCE. Resolving without throwing is not synchronization:
          // a sweep that ran perfectly and DISCOVERED a durable order the broker has never heard of
          // has proven the opposite of consistency. Previously this returned void on any resolution,
          // so `runReconnectReconciliation` promoted to READY on "did not throw" alone — and, because
          // of the optional chaining below, promoted even when there was no order manager at all and
          // literally nothing had been examined.
          const manager = this.orderManager;
          if (!manager) {
            return {
              synchronized: false,
              reason:
                "no live order manager is constructed, so no durable order or position could be " +
                "reconciled against the broker; nothing has been proven about the account",
            };
          }
          const report = await manager.reconcile();
          if (!report) {
            return {
              synchronized: false,
              reason: "the reconcile produced no report, so its result could not be checked",
            };
          }
          // INCONSISTENCIES THAT ARE ABOUT *OUR* STATE BLOCK NEW ENTRY. A durable order the broker
          // cannot find, or a position that disagrees with the ledger, means our view of our own
          // exposure is wrong — precisely the condition under which adding exposure is unsafe. These
          // are also already routed to `onReconciliationIssue` → RECOVERY, so blocking here is
          // consistent with how the manager treats them.
          const discrepancies = report.missingAtBroker.length + report.positionMismatches.length;
          if (discrepancies > 0) {
            const parts: string[] = [];
            if (report.missingAtBroker.length > 0) {
              parts.push(`${report.missingAtBroker.length} durable order(s) unknown at the broker`);
            }
            if (report.positionMismatches.length > 0) {
              parts.push(`${report.positionMismatches.length} position mismatch(es) vs the ledger`);
            }
            return {
              synchronized: false,
              reason: `reconciliation found the account inconsistent: ${parts.join("; ")}`,
              discrepancies,
              unresolvedOrders: report.missingAtBroker.length,
            };
          }
          // ORPHAN ORDERS ARE REPORTED BUT DO NOT BLOCK. An order at the broker that is not ours is
          // normal on a shared account (manual activity), and treating it as an inconsistency would
          // hand any manual order the power to disable this strategy's entry indefinitely. It is NOT
          // ignored: it is surfaced in the diagnostics below, and the funds it encumbers are the
          // funding gate's concern, not the stream's. See docs/BROKER_STREAM_DOCS.md for the residual
          // risk this leaves (external activity we cannot attribute).
          return {
            synchronized: true,
            unresolvedOrders: 0,
            discrepancies: 0,
            ...(report.orphanOrders.length > 0
              ? {
                  reason:
                    `${report.orphanOrders.length} order(s) at the broker are not attributable to ` +
                    `this strategy (shared-account activity); entry is not blocked on them`,
                }
              : {}),
          };
        },
        // EXPECTED-IDLE BOUND (D5). A connected order stream that delivers nothing for longer than
        // this WHILE a working order is outstanding is demoted to DEGRADED. Silence on an account
        // with nothing working is normal and never demotes. Derived from the live reconcile
        // interval (the cadence at which REST would otherwise catch a missed fill): if the stream
        // has said nothing for a working order across a whole reconcile cycle, it is not delivering.
        expectedIdleMs: Math.max(5_000, this.cfg.liveReconcileIntervalMs),
        now: () => this.executionClock.wall(),
      });
      this.orderStreamConsumer = consumer;
      // Populate the map READ by orderStreamStatus so the status reflects reality instead of
      // reporting `not_wired`. The health object is refreshed on every status read below.
      this.orderStreamConsumers.set(activeBroker, consumer.health());

      this.orderManager = new BoxOrderManager({
        adapter,
        orderStreamConsumer: consumer,
        persistence: boxOrderIntentPersistence,
        limits: orderManagerLimitsFromConfig(this.cfg),
        // THE VERIFIED ACCOUNT, read fresh on every decision. A token refresh for the SAME account
        // preserves attribution; a login for a DIFFERENT account is visible immediately and blocks
        // action on the previous account's intents.
        //
        // NULL BLOCKS NEW ENTRY ONLY — it does NOT block reduction. This comment used to claim it
        // blocked both, which was wrong and dangerous to believe during an incident: an operator
        // reading it would conclude the flatten button was dead when the account could not be named.
        // `exposureReductionBlockReason` deliberately does not consult the account at all (only
        // `disposed` and a KNOWN-BAD broker session), because `liveBrokerAccount()` can return null
        // with a healthy trading session and stranding exposure on an identity check is the same
        // defect that guard exists to prevent.
        brokerAccount: () => this.liveBrokerAccount(),
        controls: { entryEnabled: false, liveOrderEnabled: false, emergencyFlatten: false },
        istDayKey: (at) => this.deps.istDayKey(at),
        onPersistenceLossAfterFill: (_order, error) => {
          this.lastError = `live fill persistence failed: ${error instanceof Error ? error.message : String(error)}`;
          for (const position of this.positions.list()) {
            position.position_state = "RECOVERY";
            position.exit_blocked_reason = this.lastError;
            void markBoxTradeRecovery(position.id, this.lastError).catch(() => undefined);
          }
        },
        onReconciliationIssue: async (report) => {
          await this.markReconciliationRecovery(report);
          this.refreshCrashRecoveryEntryQuarantine();
        },
        isCrashRecoveryPersistenceReady: () => isBoxRecoveryPersistenceReady(),
        loadDailyRiskSeed: async (day) => {
          const seed = await loadBoxLiveRiskSeed(istDayStartMs(day), day);
          // Install lifetime and day-bucket watermarks synchronously before returning the scalar
          // seed. The manager's generation token then merges any post-load local ranges absent
          // from these authoritative buckets. A slow prior-day response mutates neither map.
          if (day === this.deps.istDayKey()) {
            compactObservedFlattenChargeWatermarks({
              observedByAttempt: this.observedFlattenCharges,
              observedByAttemptDay: this.observedFlattenChargesByDay,
              // Unresolved attempts the seed represents, PLUS anything this process can still
              // project: dropping a live/pending attempt's watermark would let its next
              // acknowledgement look like a brand-new charge and debit the day twice.
              retainAttemptIds: this.retainedRiskAttemptIds(
                Object.keys(seed.flattenChargeBaselines),
              ),
              currentDay: day,
            });
            for (const [attemptId, cumulative] of Object.entries(seed.flattenChargeBaselines)) {
              seedObservedFlattenCharges(this.observedFlattenCharges, attemptId, cumulative);
              seedObservedFlattenChargesForDay(
                this.observedFlattenChargesByDay,
                attemptId,
                day,
                seed.flattenChargeBaselinesForDay[attemptId],
              );
            }
          }
          return seed;
        },
        // Live timing instrumentation. The manager owns the scheduler stages and the terminal
        // publish; the adapter marks the transport/ACK/fill/cancel stages on the same trace.
        timing: this.timingRecorder,
        broker: () => this.deps.activeBroker(),
        onBrokerReject: (order, reason) => {
          this.outcomeStore.recordReject(this.deps.activeBroker(), order?.reject_family ?? null, reason);
        },
        revalidateQueuedRequest: (request, stamp) => checkedFeedBlockReason({
          request,
          stamp,
          currentGeneration: this.feedGeneration,
          tokenCurrent: this.tokenFeedGeneration.get(request.token) === this.feedGeneration,
          quote: this.quotes.get(request.token),
          now: Date.now(),
          quoteMaxAgeMs: this.cfg.quoteMaxAgeMs,
          queueModel: this.cfg.queueModel,
          queueLiquidityHaircutPct: this.cfg.queueLiquidityHaircutPct,
        }),
        /*
         * THE SESSION MUST STILL AUTHORISE THIS ENTRY AT THE POST BOUNDARY.
         *
         * Admission-time authorisation is not enough. Between admission and transmit an attempt sits
         * in the priority queue and behind broker pacing — a real window in which an operator can
         * disarm the session. Nothing re-checked it, so a disarmed one-attempt session still sent all
         * four orders. This closes that window.
         *
         * Deliberately NOT a budget re-check: an admitted attempt has legitimately spent its
         * allowance and must not reject itself for that.
         */
        entryAuthorizationBlockReason: () => {
          // Sessions not enforcing (no durable session layer, or no ceilings armed): unchanged
          // behaviour — there is no authorisation to withdraw.
          if (!this.session.enforcing()) return null;
          const record = this.session.snapshot();
          const armed = record.session_id !== "" && record.armed_at !== null;
          if (!armed) {
            return "the trading session was DISARMED after this entry was admitted; no further entry order may be sent";
          }
          if (this.entryAuthorizedSessionId !== null && record.session_id !== this.entryAuthorizedSessionId) {
            return (
              "the trading session was re-armed under a new session id after this entry was admitted; " +
              "its authorisation is void"
            );
          }
          return null;
        },
        // EXCLUSIVE EXECUTION OWNERSHIP, asked synchronously in the last instant before the wire.
        //
        // Every other guard in CHECKPOINT 5 reads only THIS process's state and would authorise a
        // second instance's POST just as readily. This is the only one that can answer "might another
        // process be trading this account right now".
        //
        // Read through a closure rather than captured, because `this.executionLease` is constructed
        // after the order manager — and because the lease state legitimately changes under it.
        executionOwnershipBlockReason: (use) => this.executionLease.dispatchBlockReason(use),
      });
    }
    const centralGateway = this.centralGateway = new CentralBoxExecutionGateway({
      cfg: this.cfg,
      simulator: this.executionSim,
      quotes: this.quotes,
      ...(this.orderManager ? { manager: this.orderManager, allocateTradeId: allocateBoxTradeId } : {}),
      // Attributes a per-Box capital refusal to the broker it was judged against. Diagnostics
      // only: the capital metric itself is broker-independent.
      broker: () => this.deps.activeBroker(),
      /*
       * A restored record was refused at the submission boundary because its execution mode is not
       * this process's. Recorded so the READINESS surface names it as a `reduction` blocker: a refused
       * exit means exposure this process cannot close, which an operator must be told about rather
       * than discovering from an unchanged position. Keyed by trade id so repeated monitor passes
       * report the condition once rather than growing without bound.
       */
      onExecutionModeMismatch: (detail) => {
        const id = detail.match(/^Position (\S+) /)?.[1] ?? detail;
        if (!this.modeMismatchedPositions.has(id)) {
          this.modeMismatchedPositions.set(id, detail);
          console.error(`[Box] EXIT REFUSED — execution-mode mismatch: ${detail}`);
        }
      },
      // OPERATOR BLOCKLIST, enforcement point 4 of 4 — the unbypassable refusal for LIVE, which never
      // reaches the simulator because simulateLeggingEntry forks to BoxOrderManager before it.
      underlyingExclusion: (underlying) => this.underlyingExclusionRefusal(underlying),
      isTokenWarm: (token) => this.tokenFeedGeneration.get(token) === this.feedGeneration,
      feedGeneration: () => this.feedGeneration,
      // COMBINED READINESS gate for NEW ENTRY (GAP 1 + D1). Live only: the market-data machine is
      // armed only in live mode (in paper it is DISABLED and this gate would otherwise refuse
      // everything), so the gate is supplied only when executing live.
      //
      // D1 FIX: the entry gate is the INTERSECTION of BOTH transports' NEW-ENTRY permission, via
      // the shared combinedPermissions table (entryPermittedFromStreams), NOT market data alone.
      // An enabled-but-unhealthy order stream (CONNECTING/AUTHENTICATING/RECONCILING/DEGRADED/
      // DISCONNECTED/AUTH_EXPIRED) therefore refuses new entry, because taking fresh exposure on
      // top of an unreconciled or undelivered fill gap is how one unknown becomes two. A DISABLED
      // order stream never blocks — REST polling is the documented baseline and the stream is OFF
      // by default. This is ENTRY-ONLY: protective cancel, exit and attributed reduction are never
      // routed through here and are never blocked by it, so a degraded stream cannot strand a
      // live position. The refusal reason names whichever transport blocked.
      ...(this.cfg.executionMode === "live"
        ? {
            marketDataEntryPermitted: () => {
              const state = this.marketDataState();
              const orderStream = this.orderStreamState();
              // Both transports must license NEW ENTRY (intersection). Market data is scored from
              // its own permission table; the order stream is intersected via the SAME shared
              // combinedPermissions table (entryPermittedFromStreams), never an ad-hoc boolean.
              const marketDataOk = marketDataPermissions(state).newEntry;
              const permitted = entryPermittedFromStreams({ marketData: state, orderStream }).permitted;
              // Name whichever transport blocked, so the operator sees an actionable reason.
              const reason = permitted
                ? state
                : marketDataOk
                  ? `order-stream ${orderStream}`
                  : state;
              return { permitted, state: reason };
            },
            // CANDIDATE-SCOPED MARKET-DATA ADMISSION. The transport gate above is deliberately a
            // SHARED verdict; the per-instrument strictness that used to live (wrongly) inside it —
            // where it was applied to the ENTIRE streamed option universe, so one illiquid unrelated
            // strike refused every box — is applied here to exactly the four legs being entered.
            //
            // Every input is read LIVE at call time (socket generation, feed generation, subscription
            // intent, each leg's book), so there is no cached candidate readiness that could survive a
            // candidate switch, a reconnect or a subscription change. See box/candidateMarketData.ts.
            candidateMarketDataAdmissible: (candidate) => {
              const verdict = evaluateCandidateMarketData(candidate, {
                transportState: this.marketDataState(),
                generation: this.marketDataMachine.generation(),
                isInstrumentReady: (token) => this.marketDataMachine.isInstrumentReady(token),
                isSubscribed: (token) => this.marketDataMachine.isSubscribed(token),
                isTokenWarm: (token) => this.tokenFeedGeneration.get(token) === this.feedGeneration,
                quote: (token) => this.quotes.get(token),
                now: () => this.executionClock.wall(),
                quoteMaxAgeMs: this.cfg.quoteMaxAgeMs,
                // Only bound the SOURCE timestamp when the feed actually supplies one; the helper
                // skips the check for a book with no exchange timestamp rather than faking freshness.
                sourceMaxAgeMs: this.cfg.quoteMaxAgeMs,
          // The SAME tolerance the four-leg coherence gate uses, so the two admission layers cannot
          // disagree about whether a 1-second-granular exchange stamp is a clock fault.
          maxExchangeAheadOfReceiveMs: this.cfg.maxExchangeAheadOfReceiveMs,
                // ONE LOT PER LEG — the same quantity executionGateway.request() actually sends
                // (`quantity: args.candidate.lot_size`), so the depth requirement checked here is the
                // depth the order will really need rather than a guess.
                requiredQuantity: candidate.lot_size,
                sideForRole: (role) => entrySideFor(role, candidate.direction),
                tradingDayStartMs: istDayStartMs(this.deps.istDayKey()),
                defaultTickSize: this.cfg.defaultTickSize,
              });
              return {
                permitted: verdict.eligible,
                reason: describeCandidateMarketDataVerdict(verdict),
                sharedFailure: verdict.sharedFailure,
              };
            },
          }
        : {}),
      // So LIVE residual flattening bills its own fees, exactly as the paper path already did.
      chargeTotal: (orders) => this.localCharges.legs(orders).total,
      // ECONOMIC ADMISSION (Task 8): FRESH funds/margin evidence via SUPPORTED broker facilities.
      // Both are exposed as missing/stale rather than assumed — a throwing or "unavailable" source
      // yields null, which the economic gate treats as unusable and (when the control is enabled)
      // refuses on. Only consulted when a control is enabled, so paper/parity paths are untouched.
      funds: async () => {
        const adapter = this.liveAdapter;
        if (!adapter?.margins) return null;
        const m = await adapter.margins().catch(() => null);
        if (!m || typeof m.available !== "number" || !Number.isFinite(m.available)) return null;
        // `observedAt` is stamped HERE, when the broker answer is in hand. The gateway captures its
        // evaluation instant AFTER every read has settled, so this can never produce a negative age.
        return {
          availableRupees: m.available,
          // THE ENCUMBRANCE, FROM THE ENDPOINT THAT ACTUALLY REPORTS IT.
          //
          // This was being read from the broker and then thrown away. The stage-funding model was
          // separately handed `encumbranceRupees: null` from the BASKET-MARGIN provider with the
          // comment "not observable from the basket endpoint" — true of that endpoint, but the FUNDS
          // endpoint reports it, and this call already had the answer in hand. So strict stage
          // funding could never establish a requirement and had to be left disabled, which in turn
          // meant admission fell back to the FINAL (completed-basket, spread-benefit) margin — the
          // exact figure the stage model exists to stop being used as proof that the account can
          // fund the sequence that creates the box.
          //
          // MISSING IS NOT ZERO. `numberOrNull`/`numericPath` in the adapters yield null when the
          // field is absent, and that null is preserved here rather than collapsed to 0. A reported
          // zero utilisation is a real, trustworthy figure and stays 0; an ABSENT one stays null and
          // makes the funding gate refuse. `Number.isFinite(0)` is true, so presence is decided by
          // the adapter's null, never inferred from the value.
          //
          // WHERE THE REFUSAL COMES FROM, for each broker's declared semantics (fundsSemantics.ts):
          // for a GROSS or UNVERIFIED broker the utilisation is needed to compute spendable funds at
          // all, so a null yields no funds figure. For a NET broker it is not needed for the
          // subtraction, but its absence means the already-net claim cannot be corroborated — so the
          // encumbrance stays a required UNKNOWN component of the binding requirement and stage
          // funding refuses. Either way an absent utilisation refuses rather than being assumed idle.
          utilisedRupees: typeof m.utilised === "number" && Number.isFinite(m.utilised) ? m.utilised : null,
          // The vendor breakdown travels to the GATE too, not just to the dashboard: the configured
          // funds basis is resolved inside `usableFundsRupees`, and if only the tile carried the
          // components then the two could resolve different bases for the same account.
          components: m.components ?? null,
          observedAt: Date.now(),
        };
      },
      // THE PLANNED-MARGIN EVIDENCE PROVIDER, extracted to `plannedMarginEvidence.ts`.
      //
      // It used to be an inline closure here, which meant the rules deciding whether a broker's
      // margin answer counts as EVIDENCE could not be tested without constructing the whole engine
      // (and a database). Both defects it guards against — accepting an INCOMPLETE basket figure,
      // and using `Number.isFinite` as a presence test so a fabricated `initial: 0` read as an
      // established requirement — shipped under exactly that lack of reachable coverage.
      plannedMargin: createPlannedMarginProvider({ margins: this.deps.margins }),
      // MONOTONIC clock for evidence aging and read deadlines, separate from the wall clock used
      // for audit stamps. An NTP correction must not be able to fabricate or erase staleness.
      monotonicNow: () => performance.now(),
      // WHO the economic evidence is about. Read before AND after the asynchronous broker reads, so
      // a broker switch or a token rotation onto a different account in flight invalidates the
      // evidence instead of admitting an entry against the wrong account. Non-secret by
      // construction: the account reference is whatever masked id the broker state exposes.
      evidenceContext: () => ({
        broker: this.deps.activeBroker(),
        account_ref: this.deps.brokerAccountRef?.() ?? null,
        session_id: this.deps.brokerGeneration ? String(this.deps.brokerGeneration()) : null,
      }),
    });
    // Contract-level exclusion wraps the gateway rather than living inside it, so it
    // sits ABOVE the paper/live branch: paper gets no shortcut around coordination,
    // which is the only way paper can stop showing two boxes consuming one lot. The
    // scanner and monitor are unchanged — they still see a plain BoxExecutionGateway.
    // The chain is [in-process, durable]. That order is the ACQUIRE order: the free
    // process-local filter rejects the common same-tick overlap without a network
    // call, and only then is the cross-process authority asked. Release runs in the
    // reverse order, so the authority lets go first. See reservations/chained.ts.
    this.reservations = createReservationStack({
      durableEnabled: this.cfg.durableReservationsEnabled,
      context: () => ({
        deployment: this.reservations.identity.deployment,
        broker: this.deps.activeBroker(),
        generation: this.deps.brokerGeneration?.() ?? 0,
        mode: this.cfg.executionMode,
      }),
      skewGraceMs: this.cfg.reservationClockSkewGraceMs,
    });
    // The durable trading session. Constructed here so the coordinator's entry gate can close
    // over it; its state is READ later, during start(), once persistence is known to be up.
    this.accountFunds = new AccountFundsTracker({
      freshnessMaxAgeMs: this.cfg.accountFundsFreshnessMaxAgeMs,
      now: () => Date.now(),
      // The SAME basis the admission gate uses, from the one config field, so the tile and the gate
      // can never report different spendable figures for one account.
      basis: this.cfg.zerodhaFundsBasis,
    });

    this.session = new BoxTradingSessionManager({
      persistence: {
        load: () => loadBoxTradingSession(),
        save: (record, options) => saveBoxTradingSession(record, options),
        flatTradeIds: (ids) => loadFlatBoxTradeIds(ids),
        // THE ATTEMPT CEILING IS ENFORCED IN THE DATABASE, not in this process's memory. One
        // statement increments and bounds under one row lock, fenced to the session id the attempt
        // was authorised under, so two managers — in one process or two — cannot both spend the same
        // allowance. See `consumeBoxTradingSessionEntryAttempt` and
        // `tests/pg/sessionBudgetTwoManagers.test.mjs`.
        consumeEntryAttempt: (args) => consumeBoxTradingSessionEntryAttempt(args),
      },
      configuredMaxCompletedTrades: () => this.cfg.sessionMaxCompletedTrades,
      // THE ATTEMPT CEILING. Bounds attempts STARTED, not trades completed — see the field comment
      // in config.ts for why the cycle budget alone left repeated failed attempts unbounded.
      configuredMaxEntryAttempts: () => this.cfg.sessionMaxEntryAttempts,
      // Distinguishes "no Box database in this deployment" from "Mongo is down". The first must
      // leave the session layer inert; the second must fail entry closed.
      persistenceAvailable: () => isBoxDbEnabled(),
      log: (message) => console.warn(message),
    });

    // EXECUTION OWNERSHIP. Constructed here, beside the session manager, because the two answer
    // adjacent questions: the session bounds HOW MANY attempts this deployment may make, and the lease
    // bounds WHICH PROCESS may make them. A bounded budget spent by two processes is still two
    // processes trading one account.
    this.executionLease = new BoxExecutionLeaseManager({
      deployment: this.reservations.identity.deployment,
      instance: this.reservations.identity.instance,
      // One owner id per process, minted from the same identity the instrument reservations use, so a
      // restarted process with a recycled pid is correctly "not me".
      owner: mintOwnerId(this.reservations.identity, "exec-lease", 0),
      broker: () => String(this.deps.activeBroker()),
      // Prefer the adapter's own account — resolved from the credential holder, so it cannot drift
      // from the token in use — and fall back to the session account. Null when neither can prove it,
      // which makes the lease inactive and (per `dispatchBlockReason`) refuses NEW ENTRY only.
      account: () => this.liveAdapter?.dispatchAccount?.() ?? this.liveBrokerAccount(),
      persistenceAvailable: () => isBoxDbEnabled(),
      liveCapable: () => this.cfg.executionMode === "live",
      log: (message) => console.warn(message),
      // TAKEOVER RECONCILIATION. Before a successor may start NEW entry it must establish what the
      // previous owner left behind at the broker. `reconcile()` is the existing pass that walks the
      // durable order journal against broker state; requiring it to COMPLETE (not merely run) is what
      // the reconciled stamp records.
      reconcileAfterTakeover: async () => {
        const manager = this.orderManager;
        if (manager === null) return false;
        try {
          await manager.reconcile();
          return manager.status().health.reconciliation_complete === true;
        } catch (err) {
          console.warn("[Box] takeover reconciliation pass failed:", err);
          return false;
        }
      },
    });

    this.coordinator = new CoordinatedBoxExecutionGateway({
      inner: centralGateway,
      reservations: this.reservations.store,
      // The in-process tier on its own: it is the only tier that can offer
      // event-driven wakeups, and the only one paper may fall back to.
      local: this.reservations.local,
      waitable: this.reservations.local,
      cfg: this.cfg,
      quotes: this.quotes,
      broker: () => this.deps.activeBroker(),
      generation: () => this.deps.brokerGeneration?.() ?? 0,
      identity: this.reservations.identity,
      // LAYER 1a of the underlying lock. Synchronous and durable-state derived, so the lock
      // cannot be lost by a lease expiring while a position is still open.
      activeUnderlyings: () => this.activeUnderlyings(),
      // OPERATOR BLOCKLIST, enforcement point 2 of 4. Synchronous, so it is legal inside the
      // coordinator's no-await prologue; ENTRY only, so no reduction path can see it.
      underlyingExclusion: (underlying) => this.underlyingExclusionRefusal(underlying),
      // THE MODE-INDEPENDENT INVENTORY CEILING's durable term. Synchronous.
      boxInventory: () => this.boxInventoryCount(),
      // UNOWNED BROKER EXPOSURE, enforced. The SAME call that produces the operator's
      // `unowned_attributed_exposure` readiness blocker, so the verdict and the gate cannot
      // disagree. Synchronous (legal in the no-await prologue) and ENTRY only — every reduction
      // path bypasses it, because reduction is the only thing that can clear it.
      orphanedExposureGate: () => this.unownedAttributedExposure(),
      // The session cycle budget, INTERSECTED with "is the residual picture known?". ENTRY only;
      // every reduction path bypasses it.
      sessionEntryGate: () => this.entryGateVerdict(),
      /*
       * The SESSION TIMING window for a new box. Pure clock + calendar arithmetic, evaluated fresh
       * on every decision rather than cached off the 15-second market poll — a cutoff that is
       * re-read every 15 seconds would admit an entry up to 15 seconds past its own deadline, and
       * near the bell that is precisely the margin being protected.
       *
       * ENTRY ONLY. Deliberately NOT wired into `coordinateExit`, `acquireForExit` or
       * `flattenResidual`.
       */
      sessionEntryWindow: () => {
        const verdict = evaluateSessionEntryWindow({
          at: this.executionClock.wall(),
          cutoffMinutesBeforeClose: this.cfg.entryCutoffMinutesBeforeClose,
          warmupMinutesAfterOpen: this.cfg.sessionWarmupMinutesAfterOpen,
        });
        return { allowed: verdict.allowed, refusal: verdict.refusal, detail: verdict.detail };
      },
      // CONSUME AN ATTEMPT AT ADMISSION. Called by the coordinator after every cheap gate has
      // passed and BEFORE any reservation or broker POST, so an attempt that then fails has still
      // spent its budget — which is the entire point of bounding attempts rather than completions.
      // Returning ok:false refuses the entry, because an attempt that could not be durably counted
      // would be an unbounded one.
      sessionConsumeAttempt: async () => {
        const consumed = await this.session.recordAttemptStarted();
        // REMEMBER WHICH ARMED SESSION AUTHORISED THIS ATTEMPT. Read back at the POST boundary so a
        // disarm (or a re-arm under a new id) between admission and transmit voids the authorisation
        // instead of being noticed only after four orders have gone to the broker.
        if (consumed.ok) this.entryAuthorizedSessionId = this.session.snapshot().session_id || null;
        return consumed;
      },
    });
    this.execution = this.coordinator;

    this.reconciler = new BoxChargeReconciler({
      cfg: this.cfg,
      charges: this.charges,
      metrics: this.metrics,
      isAuthenticated: () => this.deps.marketData.isAuthenticated(),
      persist: (tradeId, phase, verdict) =>
        setBoxChargeReconciliation(tradeId, phase, verdict),
      onReconciled: (tradeId, phase, verdict, warned) => {
        void appendBoxEvent({
          event: "CHARGES_RECONCILED",
          trade_id: tradeId,
          candidate_key: "",
          underlying: "",
          expiry: "",
          lower_strike: 0,
          upper_strike: 0,
          lot_size: 0,
          quantity: 0,
          execution_mode: this.cfg.executionMode,
          reason: warned ? "discrepancy_over_threshold" : "verified",
          detail:
            `${phase}: local ₹${verdict.local_total} vs Zerodha ₹${verdict.reconciled_total} ` +
            `(${verdict.pct_diff}%)`,
        });
      },
    });

    this.scanner = new BoxScanner({
      cfg: this.cfg,
      quotes: this.quotes,
      charges: this.charges,
      localCharges: this.localCharges,
      executionSim: this.execution,
      metrics: this.metrics,
      positions: this.positions,
      faults: this.entryFaults,
      activeBroker: () => this.deps.activeBroker(),
      // LIVE ONLY: whether this attempt's orders actually reached the broker. In paper there is
      // no broker, so the field stays null rather than pretending to know.
      reachedBroker: () => (this.orderManager?.status().inFlight ?? 0) > 0,
      // OPERATOR BLOCKLIST, enforcement point 1 of 4 — the cheapest. Refuses before a reservation is
      // taken or a session attempt is spent, so an excluded name costs nothing at all.
      isUnderlyingExcluded: (underlying) => this.underlyingExclusionRefusal(underlying) !== null,
      /*
       * HOLD AN INVENTORY SLOT ACROSS THE WHOLE ESTABLISHMENT, not just until the claim drops.
       *
       * The counter is incremented here rather than inside `openPaperTrade` so it brackets the
       * ENTIRE call including its durable write, and is released in a `finally` so a throw cannot
       * leak a slot and permanently refuse entry. See `pendingEstablishments`.
       */
      openPaperTrade: async (args) => {
        this.pendingEstablishments++;
        try {
          return await this.openPaperTrade(args);
        } finally {
          this.pendingEstablishments--;
        }
      },
      onExecutionAttempt: (candidate, legging, reason, detail, detectedGrossEdge) =>
        void this.persistExecutionAttempt(candidate, legging, reason, detail, detectedGrossEdge),
      // Every refused entry attempt, with its underlying, into the bounded alert ledger.
      onEntryRejected: (rejection) => this.entryAlerts.record(rejection),
      // EXECUTION FUNNEL (Task 8): candidate + qualified stages, from the scanner hot path.
      onCandidateEvaluated: () => this.funnel.recordCandidateEvaluated(),
      onQualified: () => this.funnel.recordQualified(),
      onEvent: (event, candidate, evaluation, detail) => {
        void appendBoxEvent({
          event,
          candidate_key: candidate.key,
          underlying: candidate.underlying,
          expiry: candidate.expiry,
          direction: candidate.direction,
          lower_strike: candidate.lower_strike,
          upper_strike: candidate.upper_strike,
          lot_size: candidate.lot_size,
          quantity: candidate.lot_size,
          execution_mode: this.cfg.executionMode,
          box_width: candidate.box_width,
          box_cost:
            evaluation.entry_net_debit_per_unit === null
              ? null
              : round2(evaluation.entry_net_debit_per_unit * candidate.lot_size),
          gross_edge: evaluation.gross_edge,
          safety_buffer: this.cfg.safetyBuffer,
          legs: toEventLegs(evaluation.legs),
          reason: evaluation.reject,
          detail: detail ?? null,
        });
      },
    });

    this.monitor = new BoxPositionMonitor({
      cfg: this.cfg,
      quotes: this.quotes,
      localCharges: this.localCharges,
      executionSim: this.execution,
      positions: this.positions,
      metrics: this.metrics,
      closePaperTrade: (args) => this.closePaperTrade(args),
      persistPartialExit: (args) => this.persistPartialExit(args),
      persistLive: (pos) =>
        updateBoxTradeLive(pos.id, {
          current_remaining_edge: pos.metrics?.remaining_edge ?? null,
          current_captured_edge: pos.metrics?.captured_edge ?? null,
          current_captured_pct: pos.metrics?.captured_pct ?? null,
          exit_blocked_reason: pos.exit_blocked_reason,
          expiry_safety: pos.expiry_safety,
        }),
      onEvent: (event, pos, metrics, detail) => {
        void appendBoxEvent({
          event,
          trade_id: pos.id,
          candidate_key: pos.key,
          underlying: pos.underlying,
          expiry: pos.expiry,
          direction: pos.direction ?? "LONG_BOX",
          lower_strike: pos.lower_strike,
          upper_strike: pos.upper_strike,
          lot_size: pos.lot_size,
          quantity: pos.quantity,
          execution_mode: this.cfg.executionMode,
          box_width: pos.box_width,
          box_cost: round2(pos.entry_box_cost_per_unit * pos.lot_size),
          gross_edge: pos.entry_gross_edge,
          entry_charges_total: pos.entry_charges_total,
          exit_charges_total: metrics?.estimated_exit_charges ?? null,
          safety_buffer: pos.safety_buffer,
          net_edge: pos.entry_net_edge,
          gross_pnl: metrics?.gross_pnl_if_closed_now ?? null,
          net_pnl: metrics?.current_net_pnl ?? null,
          remaining_edge: metrics?.remaining_edge ?? null,
          captured_edge: metrics?.captured_edge ?? null,
          captured_pct: metrics?.captured_pct ?? null,
          legs: metrics ? toEventLegs(metrics.legs) : [],
          reason: metrics?.exit_reason ?? null,
          detail: detail ?? null,
        });
      },
      istDayKey: () => this.deps.istDayKey(),
      istMinutesOfDay: () => istMinutesOfDay(),
      isMarketOpen: () => this.marketOpen,
      isFeedHealthy: () => this.isFeedHealthy(),
      // WHY a reduction cannot be worked while the WS feed is unhealthy. The monitor used to return
      // silently here; now the position carries the reason and the reason names the broker terminal when
      // that is the only remaining route. See `degradedRecovery.ts`.
      degradedReductionBlockReason: (pos) => this.degradedReductionBlockReason(pos),
    });

    // Read-path cache for today's closed trades (inert without Upstash).
    this.closedCache = new BoxClosedTradeCache(this.cfg);

    // Live P&L cache + nightly archive (inert unless BOX_PNL_CACHE_ENABLED and
    // Upstash are both configured — see pnlArchive.ts).
    this.pnlCache = new BoxPnlCache(this.cfg);
    this.pnlArchiver = new BoxPnlArchiver({
      cfg: this.cfg,
      cache: this.pnlCache,
      getOpenPnl: () => this.openPnlInputs(),
      loadClosedSince: (sinceMs) => this.closedPnlInputs(sinceMs),
      upsert: (doc) => upsertBoxDailyPnl(doc),
      filterExistingTradeIds: (ids) => filterExistingBoxTradeIds(ids),
      loadPersistedDay: (day) => loadBoxDailyPnlSnapshot(day),
      isPersistedDayComplete: (day, ids) => isBoxDailyPnlSnapshotComplete(day, ids),
      markPersistedDayIncomplete: (day) => markBoxDailyPnlIncomplete(day),
      markPersistedDayComplete: (day, ids) => markBoxDailyPnlComplete(day, ids),
      deletePersistedRows: (day, ids) => deleteBoxDailyPnlRows(day, ids),
      reconcileDurableOrphans: () => reconcileBoxDailyPnlOrphans(),
      istDayKey: () => this.deps.istDayKey(),
      // A Date whose UTC fields read as IST, matching the EOD scheduler's clock.
      istNow: () => new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      isDbEnabled: () => isBoxDbEnabled(),
    });

    this.metrics.startSampling();
    this.marketOpen = this.deps.isMarketOpen();
    this.scanner.setMarketOpen(this.marketOpen);
  }

  /* ------------------------------- lifecycle ------------------------------ */

  /**
   * Boot the module.
   *
   * Adopts any box that was open before the restart and starts the MONITOR
   * immediately — a position taken yesterday must be managed today whether or not
   * anyone presses RUN. Discovery stays off until RUN.
   */
  async boot(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
    // Verify PostgreSQL — this backend's operational authority — is up and migrated
    // before the positions below are read from it.
    await ensureBoxPersistenceReady();
    /*
     * CLAIM THE DURABLE BOOT ORDINAL HERE, AT BOOT — not only when the scanner starts.
     *
     * It used to be claimed exclusively inside `start()`, i.e. on RUN. The consequence was a
     * chicken-and-egg that made a freshly booted deployment unreadable: with no ordinal the readiness
     * decision is unorderable, a client refuses the WHOLE status payload rather than adopt a verdict
     * it cannot place in order, and the dashboard therefore showed `MODE UNKNOWN`, an empty board and
     * zeroed counts until the operator pressed RUN. The pre-run confirmation dialog — whose entire
     * purpose is to state whether real orders are about to be placed — could not name the execution
     * mode until after the thing it was confirming had already happened.
     *
     * Ordering is deliberate: immediately after `ensureBoxPersistenceReady()`, so the authority is
     * known to be up before the first attempt, exactly as the `start()` call site relied on.
     *
     * `start()` still calls this too. It is idempotent, and pressing RUN should force an immediate
     * attempt rather than waiting out the retry interval.
     */
    this.ensureBootOrdinalClaim();
    // Crash-only recovery is safe only behind its explicitly established and verified partial
    // unique index. Failure quarantines that direct path while ordinary residual exits continue.
    try {
      await initialiseBoxExecutionAttemptPersistence();
      console.log("[Box] crash-recovery execution-attempt persistence READY.");
    } catch (err) {
      console.error(
        "[Box] crash-only attributed recovery is QUARANTINED until persistence is repaired:",
        err,
      );
    }
    // Bring the durable reservation tier up: create and VERIFY its indexes, measure the
    // authority's clock, and reclaim reservations that have already lost their lease.
    // It never throws — an unreachable authority is an operating state the coordinator
    // reports and fails closed on, not a reason to stop the engine from booting and
    // managing exposure that already exists.
    const durableReady = await this.reservations.initialise();
    // EXECUTION OWNERSHIP, established as early as possible — right after the reservation identity is
    // usable and before anything can reach a broker. Never throws: a failure leaves the manager
    // refusing NEW ENTRY while leaving every reduction path open, which is the same trade-off the
    // durable reservation boot check makes. Refusing to boot would also refuse to monitor, reconcile
    // and flatten exposure that already exists.
    await this.executionLease.initialise();
    if (this.cfg.executionMode === "live") {
      const lease = this.executionLease.snapshot();
      console.log(
        `[Box] execution ownership: ${lease.kind}` +
          (lease.kind === "held"
            ? ` (account=${lease.lease.account} fence=${lease.lease.fence}` +
              `${lease.lease.reconciled ? "" : " takeover NOT yet reconciled"})`
            : ` — ${lease.detail}`),
      );
    }
    if (this.cfg.durableReservationsEnabled) {
      console.log(
        `[Box] durable instrument reservations ${durableReady ? "READY" : "UNAVAILABLE"} ` +
          `(deployment=${this.reservations.identity.deployment} store=${this.reservations.store.name})`,
      );
      // An INFERRED lock namespace is a footgun in live trading: two environments sharing
      // one means a laptop can take a contract the real trading process needs, or believe
      // it holds one production is actively trading. Say so loudly rather than silently.
      if (this.cfg.executionMode === "live" && !isDeploymentIdExplicit()) {
        console.warn(
          `[Box] CALSPREAD_DEPLOYMENT_ID is not set — the durable reservation lock namespace ` +
            `was INFERRED as "${this.reservations.identity.deployment}". Set it explicitly so this ` +
            `deployment cannot share a lock namespace with another environment.`,
        );
      }
      if (!durableReady && this.cfg.executionMode === "live") {
        console.warn(
          "[Box] LIVE Box ENTRY is disabled until the durable reservation authority is reachable. " +
            "Exits, residual flattening and reconciliation remain available.",
        );
      }
    }
    if (this.cfg.executionMode === "live") {
      if (!isBoxDbEnabled()) {
        throw new Error("[Box] live execution blocked: Box database is not ready.");
      }
      if (this.cfg.reservationRequireDurable && !durableReady) {
        // Deliberately a WARNING, not a throw.
        //
        // Refusing to boot would also refuse to adopt open positions, run the position
        // monitor, reconcile, and flatten residual exposure — so a missing lock would
        // strand real money in the market. ENTRY safety and EXIT safety are different
        // problems: new Box entries are already failed closed by the coordinator (it
        // reports `durable_reservation_unavailable` and refuses), while everything that
        // REDUCES exposure keeps working.
        console.error(
          "[Box] BOX_RESERVATION_REQUIRE_DURABLE is set but the durable instrument-reservation " +
            "authority could not be initialised. LIVE Box ENTRY is DISABLED. Exits, residual " +
            "flattening, reconciliation and position monitoring continue.",
        );
      }
      if (!this.deps.marketData.isAuthenticated()) {
        throw new Error(
          `[Box] live execution blocked: the ${this.deps.activeBroker()} broker session is missing.`,
        );
      }
    }
    // Admin-saved thresholds override the env defaults, before anything can be
    // judged against them.
    await this.loadPersistedTuning();
    // THE BLOCKLIST BEFORE THE FIRST EVALUATION. Loaded here rather than lazily because a lazily
    // loaded blocklist is an unloaded one for the first few ticks — and the first few ticks are
    // exactly when a supervised session is most likely to find its one qualifying box.
    await this.loadPersistedExclusions();
    this.marketOpen = this.deps.isMarketOpen();
    this.scanner.setMarketOpen(this.marketOpen);
    // Capture before adoption can register/work residuals. Every local flatten observation from
    // this point until seed installation is generation-stamped and merged against the loader's
    // per-attempt day buckets, regardless of when each Mongo query took its snapshot.
    const startupTradingDay = this.deps.istDayKey();
    const startupRiskSeedToken = this.orderManager?.beginDailyRiskSeed(startupTradingDay);
    // Everything from here to seed installation runs under that token, so every exit from this
    // region must settle it (see the `finally` below).
    try {
      try {
        await this.adoptOpenPositions();
      } catch (err) {
        console.warn("[Box] failed to adopt open positions:", err);
        if (this.cfg.executionMode === "live") {
          throw new Error(`[Box] live execution blocked: open-position adoption failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Re-adopt any outstanding residual exposure from an interrupted unwind, so it
      // is resumed regardless of whether RUN is ever pressed.
      try {
        await this.reconcileResidualExposure();
      } catch (err) {
        console.warn("[Box] failed to reconcile residual exposure:", err);
      }
      // A consumption write that failed earlier keeps entry closed until it lands, so retry it on
      // every reconciliation rather than waiting for someone to notice. Cheap no-op when nothing
      // is pending.
      void this.session.retryPendingWrite().catch(() => undefined);
      // Rebuild underlying-level protection from the state just adopted. Runs AFTER both
      // position adoption and residual reconciliation, so it sees every underlying that carries
      // exposure — a claim taken before residuals were loaded would miss some.
      try {
        await this.reclaimUnderlyingsForOpenExposure();
      } catch (err) {
        console.warn("[Box] failed to re-claim underlying locks at startup:", err);
      }
      // SESSION: read the durable record and close out cycles that reached FLAT while this
      // process was down. Runs AFTER adoption so `flatTradeIds` is answered against the same
      // durable trade documents the engine has just reconciled. A read failure leaves the session
      // unreadable, which fails ENTRY closed while leaving every reduction path open.
      await this.session.initialise();
      if (this.orderManager) {
        this.syncManagerExposure();
        const riskSeed = await loadBoxLiveRiskSeed(
          istDayStartMs(startupTradingDay),
          startupTradingDay,
        );
        // Never let a boot loader that crossed midnight install its old scalar or watermarks. The
        // manager's first reconciliation will roll and load the new day instead.
        if (startupTradingDay === this.deps.istDayKey()) {
          compactObservedFlattenChargeWatermarks({
            observedByAttempt: this.observedFlattenCharges,
            observedByAttemptDay: this.observedFlattenChargesByDay,
            retainAttemptIds: this.retainedRiskAttemptIds(
              Object.keys(riskSeed.flattenChargeBaselines),
            ),
            currentDay: startupTradingDay,
          });
          for (const [attemptId, cumulative] of Object.entries(riskSeed.flattenChargeBaselines)) {
            seedObservedFlattenCharges(this.observedFlattenCharges, attemptId, cumulative);
            seedObservedFlattenChargesForDay(
              this.observedFlattenChargesByDay,
              attemptId,
              startupTradingDay,
              riskSeed.flattenChargeBaselinesForDay[attemptId],
            );
          }
          this.orderManager.seedLimits({
            tradingDay: startupTradingDay,
            realisedPnlToday: riskSeed.realisedPnl,
            rejects: riskSeed.rejects,
            consecutiveFailures: riskSeed.consecutiveFailures,
            openBoxes: this.positions.size,
            residualLegs: this.residualLegCount(),
            seedToken: startupRiskSeedToken,
            flattenChargeBaselinesForDay: riskSeed.flattenChargeBaselinesForDay,
            incomplete: riskSeed.incomplete,
          });
        }
        try {
          const report = await this.orderManager.start();
          // The order manager's initial reconcile has completed, so the durable nonterminal orders
          // are known: NOW open the order-stream transports. Starting after reconcile means a
          // pre-arrival stream event lands in a ledger that was already registered from durable
          // intent, and the reconnect gap-repair path has a consistent baseline to merge against.
          this.startOrderStreamTransports();
          if (report.positionMismatches.length > 0 || report.missingAtBroker.length > 0) {
            const mismatchSymbols = new Set(report.positionMismatches.map((item) => item.symbol));
            const affectedIds = new Set(report.affectedTradeIds);
            for (const position of this.positions.list()) {
              const symbolAffected = BOX_LEG_ROLES.some((role) => {
                const inst = position.legs[role];
                return mismatchSymbols.has(`${inst.exchange}:${inst.tradingsymbol}`);
              });
              if (!symbolAffected && !affectedIds.has(position.id)) continue;
              const detail = "live broker reconciliation found an order or attributed-position mismatch";
              position.position_state = "RECOVERY";
              position.exit_blocked_reason = detail;
              await markBoxTradeRecovery(position.id, detail);
            }
          }
        } catch (err) {
          const detail = `live reconciliation failed: ${err instanceof Error ? err.message : String(err)}`;
          await Promise.all(this.positions.list().map(async (position) => {
            position.position_state = "RECOVERY";
            position.exit_blocked_reason = detail;
            await markBoxTradeRecovery(position.id, detail).catch(() => undefined);
          }));
          this.lastError = detail;
          console.error(`[Box] ${this.lastError}`);
        }
      }
    } finally {
      // `seedLimits` settles the token on the installing path. EVERY other exit must release it
      // here: a throwing adoption, a failed `loadBoxLiveRiskSeed`, a failed reconciliation, or the
      // midnight branch that deliberately installs nothing. A leaked token stays 'active' with
      // today's day key, so `rollTradingDay` will not settle it either, and the day's whole
      // charge-mutation journal is pinned in memory for the rest of the day — once per boot retry,
      // because a failed boot is caught by the caller and the process keeps running with the
      // flatten timer armed. Abandonment is idempotent and only ever drops merges that no
      // remaining active loader can still need.
      if (startupRiskSeedToken) this.orderManager?.abandonDailyRiskSeed(startupRiskSeedToken);
    }
    this.monitor.start();
    // Seed the "closed today" tally AND the closed-today trade list from Mongo, so
    // both the day-P&L figures and the Closed-trades tab are correct and instant
    // immediately after a restart. Then start the P&L cache + nightly archiver.
    await this.refreshClosedTodayFromDb().catch((err) =>
      console.warn("[Box] closed-today seed failed:", err),
    );
    this.pnlArchiver.start();
    // Open positions AND residual legs need live books even with the scanner stopped. Residual
    // reconciliation has already run by this point, so `residualLegCount()` is authoritative here.
    if (this.positions.size > 0 || this.residualLegCount() > 0) this.ensureFeed();
    // Track market hours from boot, not only from RUN. Two things depend on it
    // whether or not anyone presses RUN: the monitor's view of tradability, and
    // the last-close view — which is the ONLY way to see how boxes were priced at
    // the close, and used to be unreachable with the scanner stopped.
    this.startMarketWatch();
    // Exactly ONE universe pass at boot. refreshClosedMarketView performs its own,
    // so calling refreshUniverse first as well would double the instrument, board
    // and spot-seed fetches on every startup.
    if (!this.marketOpen) {
      await this.refreshClosedMarketView().catch((err) =>
        console.warn("[Box] last-close view failed at boot:", err),
      );
    } else if (this.positions.size > 0 || this.residualLegCount() > 0) {
      // Residual-only restarts included. Gating this on open positions alone meant a process that
      // came back holding nothing but residual exposure never ran a universe pass, so it never
      // placed a window, never subscribed anything, and — because an empty token set produces no
      // 0→1 refcount edge — never even constructed the box-lane socket. It would then start its
      // flatten timer against a feed that did not exist.
      await this.refreshUniverse().catch((err) =>
        console.warn("[Box] universe refresh failed at boot:", err),
      );
    }
    /*
     * START THE BALANCE POLLER — last, and deliberately not awaited.
     *
     * It is a diagnostic: boot must not be able to fail, or even be delayed, because a funds endpoint
     * is slow. `ensureAccountFundsTimer` fires one read immediately and then polls, and every path
     * inside it swallows its own errors, so nothing here can reject.
     *
     * Started in EVERY mode, not just live. A paper rehearsal has the same authenticated session and
     * the same question — "what can I actually trade with?" — and needs the answer before arming
     * rather than after.
     */
    this.ensureAccountFundsTimer();

    /*
     * NAME AN UNSATISFIABLE COHERENCE BOUND, LOUDLY, AT BOOT.
     *
     * A cross-leg exchange-dispersion limit below the broker's stamp precision refuses coherent
     * books on quantisation alone, and the symptom — 100% of entries refused as `cross_leg_time_skew`
     * on a healthy feed — looks exactly like adverse market conditions. Nothing previously connected
     * the setting to the cause, so the operator had no way to tell the two apart.
     *
     * Logged after the readiness line so it is the LAST thing on screen at boot rather than being
     * scrolled away by it.
     */
    const coherenceWarning = coherencePrecisionWarning({
      broker: this.deps.activeBroker(),
      maxExchangeDispersionMs: this.cfg.maxCrossLegExchangeDispersionMs,
    });

    console.log(
      `[Box] engine ready — ${this.positions.size} open box position(s), ` +
        `entry gate ₹${requiredNetProfit(this.cfg)} EXPECTED NET after every cost ` +
        `(gross prefilter ₹${this.cfg.minGrossEdge})` +
        (this.cfg.minNetEdge > 0 ? ` (plus a ₹${this.cfg.minNetEdge} net floor)` : "") +
        `, safety ₹${this.cfg.safetyBuffer} (deducted inside that net figure), ` +
        `freshness ${this.cfg.quoteMaxAgeMs}ms, ATM±${this.strikeLevel} of max ±${this.cfg.strikesEachSide}, ` +
        `market ${this.marketOpen ? "OPEN" : "CLOSED"}.`,
    );
    /*
     * Say plainly whether the thresholds are LOT-RELATIVE, because the two regimes screen a wide
     * universe completely differently and the flat figures above do not reveal which is in force.
     * Flat-only is called out as a warning, not silence: across a 150-name universe whose lots
     * span ~1000x it is the configuration that traded only the largest lots.
     */
    if (lotRelativeThresholdsEnabled(this.cfg)) {
      console.log(
        `[Box] thresholds are LOT-RELATIVE — effective = max(flat, rate x lotSize) per candidate: ` +
          `net ₹${this.cfg.minExpectedNetProfitPerUnit}/unit, ` +
          `prefilter ₹${this.cfg.minGrossEdgePerUnit}/unit, ` +
          `safety ₹${this.cfg.safetyBufferPerUnit}/unit, ` +
          `entry slip ₹${this.cfg.expectedEntrySlippagePerUnit}/unit, ` +
          `exit slip ₹${this.cfg.expectedExitSlippagePerUnit}/unit, ` +
          `exit floor ₹${this.cfg.minExitNetPnlPerUnit}/unit.`,
      );
    } else {
      console.warn(
        `[Box] thresholds are FLAT RUPEES with no per-unit rates. Gross edge scales with lot size ` +
          `but these gates do not, so the effective hurdle is ₹${requiredNetProfit(this.cfg)}/lotSize ` +
          `per unit — far stricter on small lots than on large ones. Across a mixed universe that ` +
          `concentrates every entry in the largest-lot names. Set BOX_MIN_EXPECTED_NET_PROFIT_PER_UNIT ` +
          `(and the matching slippage rates) to apply one consistent per-unit policy.`,
      );
    }
    if (coherenceWarning !== null) console.warn(coherenceWarning);
    } catch (error) {
      // A failed live boot must be retryable after Mongo/session recovery.
      this.started = false;
      throw error;
    }
  }

  /** The active strikes-each-side level (1, 2 or 3). */
  getStrikeLevel(): 1 | 2 | 3 {
    return this.strikeLevel;
  }

  /**
   * Admin control: set how many strikes each side of ATM are monitored/traded.
   *
   * Only 1, 2 or 3 (never wider than the ATM ±3 cap). The change rebuilds every
   * strike window at the new width and re-derives the candidate set, so from this
   * point only boxes within ATM ±level are discovered and entered.
   *
   * OPEN POSITIONS ARE UNTOUCHED. They hold their own legs, their tokens stay
   * subscribed unconditionally, and the monitor manages and exits them exactly as
   * before — a leg now outside the narrower window keeps streaming and the trade
   * is unaffected. Only NEW discovery is constrained.
   */
  async setStrikeLevel(level: number): Promise<{ ok: boolean; level: 1 | 2 | 3; error?: string }> {
    const next = clampStrikeLevel(level);
    if (next === this.strikeLevel) return { ok: true, level: next };
    this.strikeLevel = next;
    this.forceWindowRebuild = true;
    console.log(`[Box] strike level set to ATM ±${next} — new discovery is limited to this window; open positions are unaffected.`);
    // Rebuild windows now if the feed is up; otherwise the next scheduled refresh
    // (or the next RUN) picks up the flag.
    //
    // The clear happens ONLY on the path that can rebuild. Clearing unconditionally
    // would empty the page when Zerodha is disconnected, with nothing able to
    // repopulate it — a control documented as affecting only new discovery should
    // not be able to blank the view.
    if (this.deps.marketData.isAuthenticated()) {
      try {
        // The published list describes the OLD window, so it has to go: leaving it
        // up would show boxes at strikes that are no longer monitored, which is
        // exactly the "nothing changes when I pick 2" symptom.
        this.scanner.clearOpportunities();
        await this.refreshUniverse();
        // Re-price the new candidate set immediately, so the change is visible at
        // once instead of on the next tick (market open) or the next 60s indicative
        // pass (market shut). With the exchange closed there are no ticks at all,
        // so without this the list would simply stay empty.
        if (this.marketOpen) this.scanner.refreshAll();
        else await this.refreshIndicative();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    this.publish();
    return { ok: true, level: next };
  }

  /* ------------------------------ live tuning ------------------------------ */

  /** The admin-tunable thresholds as they currently stand. */
  getTuning(): BoxTuning {
    return readTuning(this.cfg);
  }

  /**
   * Apply persisted admin thresholds over the env defaults at boot.
   *
   * Best-effort: an unreachable settings store leaves the env-configured values in
   * place rather than blocking the boot.
   */
  /* ------------------------- excluded underlyings ------------------------- */

  /**
   * Load the operator blocklist into memory.
   *
   * FAILS CLOSED, and that is the whole point. A read failure leaves the book in `failed`, which
   * refuses every ENTRY and raises an `entry`-scoped readiness blocker — because a list we cannot
   * read cannot confirm that any name is permitted. The alternative (treat unreadable as empty) would
   * silently unlock every excluded name at exactly the moment the operator has least visibility,
   * which is the same reasoning `BoxTradingSessionManager` applies to an unreadable session record.
   *
   * The one exception is a deployment with no box persistence at all: no exclusion could ever have
   * been saved, so none is being forgotten, and the book records `unpersisted` (which permits entry)
   * rather than pretending a list was lost. Live execution independently requires healthy persistence
   * via `BoxOrderManager.entryBlockReasonAfterControls`, so this exception cannot apply to live.
   *
   * Retried by the periodic reconciliation pass, so a transient outage at boot heals itself without a
   * restart.
   */
  private async loadPersistedExclusions(): Promise<void> {
    if (!isBoxDbEnabled()) {
      this.exclusions.unpersisted();
      console.warn(
        "[Box] no box persistence, so the excluded-underlyings blocklist is EMPTY and cannot be " +
          "saved. Nothing is being forgotten — no exclusion could have been stored.",
      );
      return;
    }
    const read = await loadBoxExcludedUnderlyings();
    if (!read.ok) {
      this.exclusions.loadFailed(read.error);
      console.error(
        `[Box] the excluded-underlyings blocklist could not be READ (${read.error}). ` +
          `NEW ENTRY IS REFUSED until it can be: an unreadable blocklist cannot confirm any name is ` +
          `tradable. Exits, reductions and protective cancels are unaffected.`,
      );
      return;
    }
    this.exclusions.loaded(read.rows);
    if (read.rows.length > 0) {
      console.log(
        `[Box] ${read.rows.length} underlying(s) excluded from entry: ${this.exclusions.symbols().join(", ")}.`,
      );
    }
  }

  /**
   * Retry an earlier failed blocklist read. Called from the periodic reconciliation pass.
   *
   * Only ever attempted when the book is actually in `failed`, so a healthy deployment pays nothing
   * for this and a successful load is never overwritten by a later transient error.
   */
  private async retryExclusionLoad(): Promise<void> {
    if (this.exclusions.loadState !== "failed") return;
    await this.loadPersistedExclusions();
    if (this.exclusions.readable) {
      console.log("[Box] the excluded-underlyings blocklist is readable again; entry is no longer refused for it.");
      this.publish();
    }
  }

  /**
   * The blocklist verdict for one underlying — the single function all four enforcement points share.
   *
   * Synchronous and total, so it is safe in the scanner's tick path and inside the coordinator's
   * no-await prologue.
   */
  private underlyingExclusionRefusal(underlying: string): { code: string; detail: string } | null {
    /*
     * TWO LAYERS, ONE VERDICT, AND THE ALLOWLIST IS CHECKED FIRST.
     *
     * Composing the allowlist here rather than adding a parallel mechanism is the whole point: this
     * function is already injected into all four entry enforcement points — the cheap scanner filter
     * and the three authoritative lower layers — so the allowlist inherits every one of them, plus
     * the property that none of them is reachable from a reduction. A second, separately-wired check
     * would have had to re-earn all of that, and could be bypassed anywhere it was forgotten.
     *
     * The allowlist is evaluated BEFORE the blocklist because it is the cheaper and more fundamental
     * question: "is this instrument one we intend to trade at all" precedes "has an operator
     * suspended it". It also means an allowlisted-out name never depends on the blocklist being
     * readable, so a database outage cannot widen the set of tradable instruments.
     *
     * Both are ENTRY-only, which is enforced by where this function is consulted, not by anything it
     * does itself. A name removed from the allowlist mid-session keeps every exit, reduction,
     * protective cancel and reconciliation route for exposure already owned.
     */
    const notAllowed = allowlistEntryRefusal(this.cfg.liveAllowedUnderlyings, underlying);
    if (notAllowed !== null) return notAllowed;
    return exclusionEntryRefusal(this.exclusions, underlying);
  }

  /** The blocklist as the API reports it. */
  listExcludedUnderlyings(): {
    readable: boolean;
    persistent: boolean;
    load_state: string;
    error: string | null;
    max: number;
    excluded: UnderlyingExclusion[];
  } {
    return {
      readable: this.exclusions.readable,
      persistent: this.exclusions.persistent,
      load_state: this.exclusions.loadState,
      error: this.exclusions.loadError,
      max: MAX_EXCLUDED_UNDERLYINGS,
      excluded: this.exclusions.list(),
    };
  }

  /**
   * ADMIN control: forbid new entry on an underlying.
   *
   * Applies from the very next evaluation, in EVERY execution mode, and is persisted so it survives a
   * restart. It affects only which NEW boxes may be entered:
   *
   *   - a box ALREADY OPEN on this underlying is never touched. It keeps its legs subscribed (see
   *     `mustKeep` in refreshUniverse), keeps being monitored, exits on its own rules and can still
   *     be flattened. Excluding a name must not trap exposure;
   *   - the durable write happens AFTER the in-memory change but a failure ROLLS THE MEMORY BACK, so
   *     an operator is never told a name was excluded when it will revert on the next restart. Same
   *     discipline as `setTuning`.
   */
  async excludeUnderlying(
    input: { symbol?: unknown; reason?: unknown },
    actor?: string,
  ): Promise<{ ok: true; excluded: UnderlyingExclusion } | { ok: false; code: number; error: string }> {
    const parsed = validateExclusionInput(input);
    if (!parsed.ok) return { ok: false, code: 400, error: parsed.error };
    if (!this.exclusions.persistent) {
      return {
        ok: false,
        code: 503,
        error:
          "Box persistence is not configured, so an exclusion cannot be saved. It would be lost on " +
          "the next restart, so it is refused rather than accepted and forgotten.",
      };
    }
    if (this.exclusions.wouldExceedCap(parsed.symbol)) {
      return {
        ok: false,
        code: 409,
        error:
          `At most ${MAX_EXCLUDED_UNDERLYINGS} underlyings may be excluded. A blocklist this large is ` +
          `better expressed as a narrower universe (BOX_MAX_UNDERLYINGS) than as a deny list.`,
      };
    }
    const entry: UnderlyingExclusion = {
      symbol: parsed.symbol,
      reason: parsed.reason,
      excluded_by: actor ?? null,
      excluded_at: Date.now(),
    };
    const before = this.exclusions.get(parsed.symbol);
    this.exclusions.set(entry);
    try {
      await saveBoxExcludedUnderlying(entry);
    } catch (err) {
      // ROLL BACK, so what is running matches what is stored.
      if (before === undefined) this.exclusions.delete(parsed.symbol);
      else this.exclusions.set(before);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 503, error: `Could not save the exclusion: ${message}` };
    }

    console.log(
      `[Box] ${entry.symbol} EXCLUDED from new entry${actor ? ` by ${actor}` : ""}` +
        `${entry.reason === null ? "" : ` — ${entry.reason}`}. Open positions on it are unaffected.`,
    );
    void appendBoxEvent({
      event: "SCANNER_CONFIG",
      candidate_key: "",
      underlying: entry.symbol,
      expiry: "",
      lower_strike: 0,
      upper_strike: 0,
      lot_size: 0,
      quantity: 0,
      safety_buffer: this.cfg.safetyBuffer,
      detail:
        `underlying_excluded=${entry.symbol}` +
        (entry.reason === null ? "" : ` reason=${entry.reason}`) +
        (actor ? ` by=${actor}` : ""),
    });

    await this.applyExclusionChange();
    return { ok: true, excluded: entry };
  }

  /**
   * ADMIN control: allow new entry on an underlying again.
   *
   * Removing an exclusion cannot create exposure by itself — it only makes the name eligible for the
   * normal gates again — so it is the safer direction and needs no confirmation.
   */
  async includeUnderlying(
    symbol: unknown,
    actor?: string,
  ): Promise<{ ok: true; removed: boolean; symbol: string } | { ok: false; code: number; error: string }> {
    const parsed = validateExclusionInput({ symbol });
    if (!parsed.ok) return { ok: false, code: 400, error: parsed.error };
    if (!this.exclusions.persistent) {
      return {
        ok: false,
        code: 503,
        error: "Box persistence is not configured, so there is no stored blocklist to remove from.",
      };
    }
    const before = this.exclusions.get(parsed.symbol);
    if (before === undefined) return { ok: true, removed: false, symbol: parsed.symbol };
    this.exclusions.delete(parsed.symbol);
    let removed: boolean;
    try {
      removed = await deleteBoxExcludedUnderlying(parsed.symbol);
    } catch (err) {
      this.exclusions.set(before);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 503, error: `Could not remove the exclusion: ${message}` };
    }

    console.log(`[Box] ${parsed.symbol} is no longer excluded${actor ? ` (by ${actor})` : ""}; normal gates apply again.`);
    void appendBoxEvent({
      event: "SCANNER_CONFIG",
      candidate_key: "",
      underlying: parsed.symbol,
      expiry: "",
      lower_strike: 0,
      upper_strike: 0,
      lot_size: 0,
      quantity: 0,
      safety_buffer: this.cfg.safetyBuffer,
      detail: `underlying_included=${parsed.symbol}${actor ? ` by=${actor}` : ""}`,
    });

    await this.applyExclusionChange();
    return { ok: true, removed, symbol: parsed.symbol };
  }

  /* ------------------------- the tradable universe ------------------------- */

  /**
   * THE JOINED UNIVERSE, for the pre-run picker.
   *
   * Read-only and cheap: `board` and `chains` are already in memory, and `boot()` performs exactly one
   * universe pass, so this is populated BEFORE the operator presses RUN. That timing is the whole point
   * — a picker that only worked after discovery started could not be used to decide what to discover.
   *
   * Every row carries whether the name could trade AT ALL under the current quantity caps. With one
   * chosen underlying that question was trivial (set the cap to its lot); across the whole F&O universe
   * it is not, because lot sizes span orders of magnitude and one global cap cannot fit them all. A name
   * above the cap is not unlikely to trade, it CANNOT — and without this projection that fact only
   * surfaces as a deep entry-path refusal that reads like an execution fault.
   */
  listUniverse(): {
    underlyings: UniverseUnderlying[];
    summary: UniverseSummary;
    caps: { max_open_leg_quantity: number; max_gross_open_leg_quantity: number };
    /** False when no universe pass has produced a board yet, so an empty list is not read as "none". */
    built: boolean;
    built_at: number | null;
    /** The blocklist's own readability, since an unreadable list refuses entry regardless of this view. */
    blocklist_readable: boolean;
    /** BOX_MAX_UNDERLYINGS (0 = no cap) — the setting to change, named rather than described. */
    max_underlyings: number;
    /** BOX_MAX_SUBSCRIBED_TOKENS, the other limit that can leave an eligible name unobserved. */
    max_subscribed_tokens: number;
    /** False when the scanner is stopped, which is why nothing is being observed. */
    discovering: boolean;
  } {
    const exclusions = new Map(
      this.exclusions.list().map((e) => [e.symbol, { reason: e.reason }] as const),
    );
    const caps = {
      maxOpenLegQuantity: this.cfg.liveMaxOpenLegQuantity,
      maxGrossOpenLegQuantity: this.cfg.liveMaxGrossOpenLegQuantity,
    };
    const underlyings = projectUniverse({
      board: this.board,
      chains: this.chains,
      exclusions,
      caps,
      // GROUND TRUTH for what is being observed: the engine's own window map, not a re-derivation of
      // the caps. A second implementation of "who won a place in the universe" would be free to
      // disagree with the one that actually built the windows, and this surface exists precisely to
      // answer that question authoritatively.
      watch: {
        windows: new Set(this.windows.keys()),
        skippedForUnderlyingCap: new Set(this.skippedForUnderlyingCap),
        skippedForBudget: new Set(this.skippedForBudget),
        discovering: this.running,
      },
    });
    return {
      underlyings,
      summary: summariseUniverse(underlyings),
      caps: {
        max_open_leg_quantity: caps.maxOpenLegQuantity,
        max_gross_open_leg_quantity: caps.maxGrossOpenLegQuantity,
      },
      built: this.board.length > 0,
      built_at: this.universeBuiltAt,
      blocklist_readable: this.exclusions.readable,
      max_underlyings: this.cfg.maxUnderlyings,
      max_subscribed_tokens: this.cfg.maxSubscribedTokens,
      discovering: this.running,
    };
  }

  /**
   * ADMIN control: apply MANY blocklist changes at once, with ONE universe rebuild.
   *
   * The per-symbol mutators each rebuild the entire universe, which is correct for a single change and
   * unusable for a hundred: enabling the whole F&O universe makes "exclude eighty names" the normal
   * operation, and doing that one request at a time would mean eighty instrument-master fetches.
   *
   * DIFF-BASED, deliberately. The caller sends explicit adds and removes rather than the desired final
   * set, so a UI holding a stale list cannot silently RE-ADMIT a name excluded moments earlier from
   * somewhere else. That is the only direction of error that matters here, because it re-opens entry on
   * something the operator declined.
   *
   * VALIDATED WHOLE, APPLIED WHOLE. Every symbol is normalised and checked before anything is written,
   * so a single bad entry rejects the request instead of leaving half of it applied — an operator who
   * mistyped one name in a list of eighty must not have to work out which seventy-nine took effect.
   */
  async setExcludedUnderlyingsBulk(
    input: { exclude?: unknown; include?: unknown },
    actor?: string,
  ): Promise<
    | { ok: true; added: number; removed: number }
    | { ok: false; code: number; error: string }
  > {
    if (!this.exclusions.persistent) {
      return {
        ok: false,
        code: 503,
        error:
          "Box persistence is not configured, so exclusions cannot be saved. They would be lost on the " +
          "next restart, so the request is refused rather than accepted and forgotten.",
      };
    }

    const rawExclude = input.exclude === undefined ? [] : input.exclude;
    const rawInclude = input.include === undefined ? [] : input.include;
    if (!Array.isArray(rawExclude) || !Array.isArray(rawInclude)) {
      return { ok: false, code: 400, error: "exclude and include must each be an array when provided." };
    }

    const at = Date.now();
    const add: UnderlyingExclusion[] = [];
    const addSymbols = new Set<string>();
    for (const raw of rawExclude) {
      // Accept both a bare symbol and { symbol, reason }, so a picker submitting names without notes
      // needs no special case.
      const candidate = typeof raw === "string" ? { symbol: raw } : (raw as { symbol?: unknown; reason?: unknown });
      const parsed = validateExclusionInput(candidate ?? {});
      if (!parsed.ok) return { ok: false, code: 400, error: `exclude: ${parsed.error}` };
      if (addSymbols.has(parsed.symbol)) continue;
      addSymbols.add(parsed.symbol);
      add.push({ symbol: parsed.symbol, reason: parsed.reason, excluded_by: actor ?? null, excluded_at: at });
    }

    const remove: string[] = [];
    const removeSymbols = new Set<string>();
    for (const raw of rawInclude) {
      const parsed = validateExclusionInput({ symbol: raw });
      if (!parsed.ok) return { ok: false, code: 400, error: `include: ${parsed.error}` };
      if (addSymbols.has(parsed.symbol)) {
        return {
          ok: false,
          code: 400,
          error: `${parsed.symbol} appears in both exclude and include; the request is ambiguous and was not applied.`,
        };
      }
      if (removeSymbols.has(parsed.symbol)) continue;
      removeSymbols.add(parsed.symbol);
      remove.push(parsed.symbol);
    }

    // The cap is judged against the RESULTING set, not the request size: re-admitting names in the same
    // request legitimately makes room for new ones.
    const resulting = new Set(this.exclusions.symbols());
    for (const s of removeSymbols) resulting.delete(s);
    for (const s of addSymbols) resulting.add(s);
    if (resulting.size > MAX_EXCLUDED_UNDERLYINGS) {
      return {
        ok: false,
        code: 409,
        error:
          `That would leave ${resulting.size} excluded underlyings, above the limit of ` +
          `${MAX_EXCLUDED_UNDERLYINGS}. A blocklist this large is better expressed as a narrower ` +
          `universe (BOX_MAX_UNDERLYINGS) than as a deny list.`,
      };
    }

    // ROLL BACK IN MEMORY ON A FAILED WRITE, exactly as the single-symbol mutators do: the operator must
    // never be told a set was applied when it will revert on the next restart.
    const before = new Map(this.exclusions.list().map((e) => [e.symbol, e] as const));
    for (const entry of add) this.exclusions.set(entry);
    for (const symbol of remove) this.exclusions.delete(symbol);

    let result: { added: number; removed: number };
    try {
      result = await applyBoxExcludedUnderlyingsBulk({ add, remove });
    } catch (err) {
      this.exclusions.loaded([...before.values()]);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 503, error: `Could not save the exclusions: ${message}` };
    }

    console.log(
      `[Box] blocklist updated${actor ? ` by ${actor}` : ""}: ${add.length} excluded, ${remove.length} ` +
        `re-included; ${resulting.size} name(s) now blocked. Open positions are unaffected.`,
    );
    void appendBoxEvent({
      event: "SCANNER_CONFIG",
      candidate_key: "",
      underlying: "",
      expiry: "",
      lower_strike: 0,
      upper_strike: 0,
      lot_size: 0,
      quantity: 0,
      safety_buffer: this.cfg.safetyBuffer,
      detail:
        `blocklist_bulk excluded=${add.length} included=${remove.length} total=${resulting.size}` +
        (actor ? ` by=${actor}` : ""),
    });

    // ONE rebuild for the whole batch — the reason this method exists.
    await this.applyExclusionChange();
    return { ok: true, added: result.added, removed: result.removed };
  }

  /**
   * Make a blocklist change VISIBLE immediately, market open or shut.
   *
   * The same quartet `setStrikeLevel` uses, and for the same reason: a control whose effect only
   * appears on the next 60-second universe pass reads as inert, and an operator who cannot see their
   * exclusion take hold will reasonably assume it did not. Excluding a name drops its candidates
   * entirely; re-including one rebuilds them.
   *
   * Best-effort by design — the exclusion is already applied and persisted at this point, so a
   * refresh failure must not be reported as a failure to exclude.
   */
  private async applyExclusionChange(): Promise<void> {
    if (this.deps.marketData.isAuthenticated()) {
      try {
        this.scanner.clearOpportunities();
        await this.refreshUniverse();
        if (this.marketOpen) this.scanner.refreshAll();
        else await this.refreshIndicative();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    this.publish();
  }

  private async loadPersistedTuning(): Promise<void> {
    const saved = await loadBoxSettings();
    if (saved.size === 0) return;
    const patch: Partial<Record<keyof BoxTuning, unknown>> = {};
    for (const [field, key] of Object.entries(BOX_TUNING_KEYS) as [keyof BoxTuning, string][]) {
      const value = saved.get(key);
      if (value !== undefined) patch[field] = value;
    }
    const parsed = validateTuning(patch);
    if (!parsed.ok) {
      console.warn(`[Box] ignoring persisted settings — ${parsed.error}`);
      return;
    }
    this.applyTuning(parsed.values);
    console.log(
      `[Box] applied saved thresholds: entry gate ₹${this.cfg.minExpectedNetProfit}, ` +
        `safety ₹${this.cfg.safetyBuffer}.`,
    );
  }

  /**
   * Write validated tunables onto the live config.
   *
   * The gross prefilter is derived, never mutated in place. It is only ever a cheap
   * LOWER bound (see config.ts) and must under-state the real requirement: leaving
   * it at ₹1,200 while an admin lowered the gate to ₹800 would silently discard
   * boxes that now qualify, making the gate change look inert.
   *
   * It is recomputed from the CONFIGURED baseline every time, which makes this
   * idempotent: clamping in place would ratchet the prefilter down for the life of
   * the process, so lowering the gate to ₹800 and putting it back to ₹1,200 would
   * leave the prefilter at ₹800 — quietly running full qualification on candidates
   * it used to reject, and freezing that drifted number onto every later trade's
   * config snapshot.
   */
  private applyTuning(values: Partial<BoxTuning>): void {
    if (values.minExpectedNetProfit !== undefined) {
      this.cfg.minExpectedNetProfit = values.minExpectedNetProfit;
    }
    if (values.safetyBuffer !== undefined) {
      this.cfg.safetyBuffer = values.safetyBuffer;
    }
    this.cfg.minGrossEdge = Math.min(this.baseMinGrossEdge, requiredNetProfit(this.cfg));
  }

  /**
   * ADMIN control: set the entry gate and/or the safety buffer at runtime.
   *
   * Takes effect on the very next evaluation, and is persisted so it survives a
   * restart. Affects only which NEW boxes qualify:
   *
   *   - positions ALREADY OPEN are never re-judged. Their exit rules are driven by
   *     the edge they were entered on, and each carries the
   *     `scanner_config_snapshot` of the settings it was actually taken under, so
   *     yesterday's trades stay interpretable after today's change;
   *   - the safety buffer is deducted INSIDE the expected-net figure the gate tests
   *     (see math.ts), so raising it makes the gate strictly harder to clear —
   *     it is part of the decision, not merely a reported number.
   */
  async setTuning(
    patch: Partial<Record<keyof BoxTuning, unknown>>,
    /** Who made the change, for the append-only ledger (e.g. the admin role). */
    actor?: string,
  ): Promise<{ ok: true; tuning: BoxTuning } | { ok: false; code: number; error: string }> {
    const parsed = validateTuning(patch);
    if (!parsed.ok) return { ok: false, code: 400, error: parsed.error };

    const before = readTuning(this.cfg);
    this.applyTuning(parsed.values);

    // Persist AFTER applying but report a failure honestly: the admin must not be
    // told a threshold was saved when it will revert on the next restart. The live
    // values are rolled back so what is running matches what is stored — and
    // because applyTuning re-derives the prefilter from a fixed baseline, restoring
    // the two tunables restores the prefilter exactly too.
    try {
      const entries = new Map<string, number>();
      for (const [field, key] of Object.entries(BOX_TUNING_KEYS) as [keyof BoxTuning, string][]) {
        const value = parsed.values[field];
        if (value !== undefined) entries.set(key, value);
      }
      await saveBoxSettings(entries);
    } catch (err) {
      this.applyTuning(before);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 503, error: `Could not save the settings: ${message}` };
    }

    console.log(
      `[Box] thresholds updated${actor ? ` by ${actor}` : ""} — entry gate ` +
        `₹${before.minExpectedNetProfit} → ₹${this.cfg.minExpectedNetProfit}, safety ` +
        `₹${before.safetyBuffer} → ₹${this.cfg.safetyBuffer} ` +
        `(gross prefilter ₹${this.cfg.minGrossEdge}). ` +
        `New entries only — open positions are unaffected.`,
    );

    void appendBoxEvent({
      event: "SCANNER_CONFIG",
      candidate_key: "",
      underlying: "",
      expiry: "",
      lower_strike: 0,
      upper_strike: 0,
      lot_size: 0,
      quantity: 0,
      safety_buffer: this.cfg.safetyBuffer,
      detail:
        `min_expected_net_profit=${this.cfg.minExpectedNetProfit} ` +
        `safety_buffer=${this.cfg.safetyBuffer} min_gross_edge=${this.cfg.minGrossEdge}` +
        (actor ? ` by=${actor}` : ""),
    });

    // Re-price the published list so the new gate is reflected: an opportunity's
    // ELIGIBLE/WATCHING verdict is computed against it.
    //
    // NOT awaited on the closed-market path. The setting is already applied and
    // persisted, and repricing after hours means a whole-universe REST quote pass —
    // holding the admin's HTTP request open for it risks a proxy timeout reporting
    // failure for a change that in fact succeeded.
    if (this.marketOpen) {
      this.scanner.refreshAll();
    } else {
      void this.refreshIndicative().catch(() => {/* view only */});
    }
    this.publish();

    return { ok: true, tuning: readTuning(this.cfg) };
  }

  /** RUN: start discovering qualified boxes; execution remains gated separately. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (!this.deps.marketData.isAuthenticated()) {
      // Names the ACTIVE broker rather than hardcoding Zerodha. This backend runs
      // either broker, and a Dhan-active deployment showing "Connect to Zerodha"
      // sends the operator to the wrong place — the exact confusion
      // tests/box/dhanActiveNoKite.test.mjs was written about.
      return {
        ok: false,
        error: `No valid ${this.deps.activeBroker()} session yet — today's access token has not been acquired from the token provider. The scanner cannot start without authoritative market data.`,
      };
    }
    if (!isBoxDbEnabled()) {
      /**
       * POSTGRESQL, NOT MONGODB.
       *
       * This message used to read "set MONGODB_URI", which is now actively
       * dangerous advice: in this backend PostgreSQL is the operational authority and
       * MongoDB Atlas is an asynchronous reporting replica whose absence must never
       * block the scanner. `isBoxDbEnabled()` resolves to `isPgReady()`, so the only
       * thing that can trip this branch is PostgreSQL — and an operator told to fix
       * Mongo during a session would be debugging the wrong database.
       */
      return {
        ok: false,
        error:
          "PostgreSQL is not ready. It is this backend's authoritative operational store, so the scanner refuses to discover new boxes rather than trade unrecorded. Check DATABASE_URL and GET /api/runtime/status (pg_ready).",
      };
    }
    if (this.running) return { ok: true };

    this.running = true;
    this.startedAt = Date.now();
    this.lastError = null;
    // CLAIM THIS BOOT'S DURABLE ORDINAL, so readiness decisions from this process can be ordered
    // against a PREVIOUS process. Normally already claimed in `boot()`; this call makes RUN force an
    // immediate attempt when an earlier one failed, rather than waiting out the retry interval.
    // Idempotent per process — it can never consume a second ordinal and make this process look newer
    // than itself, and concurrent attempts share one claim (see BackendInstance.inFlight).
    this.ensureBootOrdinalClaim();
    // Event-loop / process diagnostics. Idempotent and fail-open: if it cannot attach it reports
    // `enabled: false` and the engine carries on regardless.
    this.environmentMonitor.start();
    // Persist measured calibration observations, and REHYDRATE what a previous process measured, so
    // a restart does not throw the session's evidence away. Fail-open: a failure here degrades
    // calibration to UNCALIBRATED (which reports itself honestly) and never blocks starting.
    this.calibrationPersistence.start();
    void this.rehydrateCalibration();
    this.scanner.setDiscovering(true);
    this.ensureFeed();
    this.startMarketWatch();

    try {
      // WITH the bounded retry, not without it. RUN is exactly the moment the fast retry exists for:
      // a transient instrument-master failure here used to arm nothing and leave the scanner blind
      // until the next `universeRefreshMs` tick, which is what made an operator press RUN again.
      await this.refreshUniverseWithRetry();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    // Shut market: populate the last-close view straight away so pressing RUN
    // after hours still shows whatever opportunities existed at the close.
    if (!this.marketOpen) {
      await this.refreshIndicative().catch(() => {});
    }

    if (!this.universeTimer) {
      this.universeTimer = setInterval(() => {
        void this.refreshUniverseWithRetry().catch((err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
        });
      }, this.cfg.universeRefreshMs);
      this.universeTimer.unref?.();
    }

    void appendBoxEvent({
      event: "SCANNER_STARTED",
      candidate_key: "",
      underlying: "",
      expiry: "",
      lower_strike: 0,
      upper_strike: 0,
      lot_size: 0,
      quantity: 0,
      detail: `min_net_edge=${this.cfg.minNetEdge} safety=${this.cfg.safetyBuffer}`,
    });
    this.publish();
    return { ok: true };
  }

  /**
   * STOP: stop discovering/opening NEW boxes.
   *
   * Deliberately does NOT stop the monitor, does not drop open positions, and
   * does not release the feed while positions are open.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stoppedAt = Date.now();
    this.scanner.setDiscovering(false);

    if (this.universeTimer) {
      clearInterval(this.universeTimer);
      this.universeTimer = null;
    }
    // AND the bounded retry. Clearing only the recurring timer left a pending retry armed, which then
    // ran full universe passes — instrument load plus REST spot seed — and re-armed itself, for a
    // scanner the operator had just stopped.
    this.cancelUniverseRetry();

    // Release everything except what the open positions still need.
    this.shrinkToOpenPositions();

    void appendBoxEvent({
      event: "SCANNER_STOPPED",
      candidate_key: "",
      underlying: "",
      expiry: "",
      lower_strike: 0,
      upper_strike: 0,
      lot_size: 0,
      quantity: 0,
      detail: `open_positions=${this.positions.size} (still monitored)`,
    });
    // shrinkToOpenPositions has just cleared the published list. With the market
    // shut, rebuild the read-only last-close view rather than leaving the operator
    // staring at an empty page until the next 60s pass.
    if (!this.marketOpen) {
      void this.refreshClosedMarketView().catch(() => {/* view only */});
    }
    this.publish();
  }

  setLiveControl(
    control: "box_entry_enabled" | "box_live_order_enabled" | "box_emergency_flatten",
    enabled: boolean,
  ): {
    ok: boolean;
    error?: string;
    /**
     * WHAT REMAINS OWNED after this control change, and what it means.
     *
     * A disarm request must report the exposure it does NOT remove. Previously
     * `box_live_order_enabled=false` silently disabled every reduction path while positions stayed
     * open, and the response was a bare `{ok:true}` — so the operator was told the switch worked
     * without being told that the exposure was now unmanageable. Reduction is no longer coupled to
     * this control, but the operator still needs to see what they still own.
     */
    exposure?: {
      open_positions: number;
      residual_legs: number;
      working_orders: number;
      consequence: string;
      reduction_available: boolean;
      reduction_blocked_reason: string | null;
    };
  } {
    if (!this.orderManager || this.cfg.executionMode !== "live") {
      return { ok: false, error: "Live controls are unavailable outside explicit live mode." };
    }
    const patch = control === "box_entry_enabled"
      ? { entryEnabled: enabled }
      : control === "box_live_order_enabled"
        ? { liveOrderEnabled: enabled }
        : { emergencyFlatten: enabled };
    this.orderManager.setControls(patch);

    /*
     * REPORT THE EXPOSURE THIS CHANGE DOES NOT REMOVE.
     *
     * Disarming a control never closes a position. An operator who turns entry (or live orders) off
     * while four legs are open has stopped NEW risk and still owns the old risk, and the response must
     * say so — with whether reduction is currently available, and why not if it is not.
     */
    const openPositions = this.positions.size;
    const residualLegs = this.residualLegCount();
    const workingOrders = this.orderStreamConsumer?.workingOrderCount() ?? 0;
    const reductionBlocked = this.orderManager.exposureReductionBlockReason();
    const owned = openPositions + residualLegs + workingOrders;
    const disarming = !enabled && control !== "box_emergency_flatten";
    const consequence = owned === 0
      ? "No Box exposure is currently owned by this deployment."
      : disarming
        ? `This deployment still owns ${openPositions} open box(es), ${residualLegs} residual leg(s) ` +
          `and ${workingOrders} working order(s). Disabling this control stops NEW exposure; it does ` +
          `NOT close what is already owned. Exits, protective cancellation and residual flattening ` +
          `remain available.`
        : `This deployment owns ${openPositions} open box(es), ${residualLegs} residual leg(s) and ` +
          `${workingOrders} working order(s).`;

    return {
      ok: true,
      exposure: {
        open_positions: openPositions,
        residual_legs: residualLegs,
        working_orders: workingOrders,
        consequence,
        reduction_available: reductionBlocked === null,
        reduction_blocked_reason: reductionBlocked,
      },
    };
  }

  async reconcileLive(): Promise<unknown> {
    if (!this.orderManager) throw new Error("Live order manager is unavailable.");
    this.syncManagerExposure();
    // Flush any consumption write that failed earlier. Reconciliation is exactly the right place:
    // it is the operation an operator runs when they suspect durable state has drifted.
    await this.session.retryPendingWrite();
    return this.orderManager.reconcile();
  }

  /**
   * Cancel every working Box order and return the sweep RESULT.
   *
   * Typed concretely (it was `Promise<unknown>`) so the route cannot accidentally publish a refusal
   * as a success — the compiler now knows there is an `attempted`/`ok`/`blocked_reason` to inspect.
   */
  async cancelWorkingBoxOrders(): Promise<CancelWorkingBoxOrdersResult & {
    operation_id: string;
    deduplicated: boolean;
  }> {
    if (!this.orderManager) throw new Error("Live order manager is unavailable.");
    const manager = this.orderManager;
    // SINGLE-FLIGHT BY OPERATION KIND. A client whose request timed out and retried must not cause a
    // second sweep: browser abort does not cancel the server operation. A second caller JOINS the one
    // already running and receives its real result, so the operator learns what happened instead of
    // being told "no" about work that is in progress. See `exposureOperations.ts`.
    const outcome = await this.exposureOperations.run("cancel_working", () =>
      manager.cancelWorkingBoxOrders(),
    );
    return {
      ...outcome.result,
      operation_id: outcome.operation_id,
      deduplicated: outcome.deduplicated,
    };
  }

  async flattenAttributedBoxExposure(): Promise<AttributedFlattenResult & {
    operation_id: string;
    deduplicated: boolean;
  }> {
    // SINGLE-FLIGHT BY OPERATION KIND, for the same reason as the cancellation sweep: a client that
    // gave up waiting and pressed the button again must not start a second flatten racing the first.
    // Two flattens over one position can double-close it. A second caller joins and receives the real
    // result. Kinds are independent, so a wedged cancel sweep does not block this.
    const outcome = await this.exposureOperations.run("flatten", () =>
      this.flattenAttributedBoxExposureOnce(),
    );
    return {
      ...outcome.result,
      operation_id: outcome.operation_id,
      deduplicated: outcome.deduplicated,
    };
  }

  private async flattenAttributedBoxExposureOnce(): Promise<AttributedFlattenResult> {
    if (!this.orderManager) throw new Error("Live order manager is unavailable.");
    const manager = this.orderManager;
    const managerStatus = this.orderManager.status();
    if (!managerStatus.controls.emergencyFlatten) {
      throw new Error("box_emergency_flatten is disabled.");
    }

    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════════
     * SETTLE BEFORE YOU PLAN: latch entry off, cancel working orders, then re-establish quantities.
     *
     * THE DEFECT THIS CLOSES. Flatten used to go straight from its readiness gate to planning
     * reductions against the CURRENT attributed-position snapshot. But a working broker order — an
     * interrupted attempt's leg, recovered on restart and matched by reconciliation — can still fill.
     * Reconciliation reported `complete` anyway, because readiness counted only UNKNOWN /
     * RECONCILIATION_REQUIRED intents and a matched OPEN order counted as nothing.
     *
     * So the sequence that loses money was: crash after a hedge BUY fills and its short SELL is
     * submitted; restart; flatten sees the long, sells it; the still-working short then fills. The
     * flatten created the naked short it was invoked to prevent.
     *
     * Planning a reduction against a quantity that another order is still changing is the whole
     * problem, so the fix is ORDERING, not refusal — refusing here would strand the exposure, which is
     * strictly worse. Three steps, in this order:
     *
     *   1. LATCH ENTRY OFF, so nothing new is added while we work. Reduction is deliberately
     *      untouched: `box_entry_enabled` never gates getting flat.
     *   2. CANCEL WORKING ORDERS, which removes the "can still fill" hazard at its source. A refusal
     *      or partial sweep is reported and does NOT abort the flatten — cancellation failing is
     *      precisely when flattening matters most — but it is surfaced so the operator sees it.
     *   3. RE-RECONCILE, so the reduction is planned against post-cancellation broker truth rather
     *      than the snapshot that was current before we cancelled anything.
     * ══════════════════════════════════════════════════════════════════════════════════════════════
     */
    this.orderManager.setControls({ entryEnabled: false });
    const settlement: { cancelled: number; failures: string[]; blocked: string | null; reconciled: boolean } = {
      cancelled: 0, failures: [], blocked: null, reconciled: false,
    };
    try {
      // Through the registry, so this JOINS an operator-initiated sweep that is already running rather
      // than issuing a duplicate that would race it. Dedup, not blocking: the kinds are independent, so
      // the flatten is never held up by anything other than a cancel sweep it genuinely needs.
      const sweep = (await this.exposureOperations.run("cancel_working", () =>
        manager.cancelWorkingBoxOrders(),
      )).result;
      settlement.cancelled = sweep.cancelled.length;
      settlement.failures = sweep.failures;
      settlement.blocked = sweep.blocked_reason;
    } catch (error) {
      // Never let a cancellation fault stop the flatten; record it and continue.
      settlement.failures = [error instanceof Error ? error.message : String(error)];
    }
    try {
      await this.orderManager.reconcile();
      settlement.reconciled = true;
    } catch (error) {
      settlement.failures = [
        ...settlement.failures,
        `post-cancel reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }

    // Re-read AFTER settling: the gate below must judge post-cancellation state, not the snapshot
    // captured before the sweep.
    const settledStatus = this.orderManager.status();
    if (!settledStatus.health.reconciliation_complete && !this.orderManager.canSafelyReduceAttributedExposure()) {
      throw new Error(
        "Cannot flatten until broker state proves the full durable Box quantity can be reduced safely" +
        (settlement.blocked ? ` (cancellation was refused: ${settlement.blocked})` : "") +
        (settlement.failures.length > 0 ? ` [settlement issues: ${settlement.failures.join("; ")}]` : ""),
      );
    }
    const positions = this.positions.list();
    const projectedSymbols = new Set<string>();
    for (const position of positions) {
      for (const role of BOX_LEG_ROLES) {
        const inst = position.legs[role];
        projectedSymbols.add(`${inst.exchange}:${inst.tradingsymbol}`);
      }
    }
    const items: FlattenItemOutcome[] = [];
    let attempted = 0;
    for (const position of positions) {
      if (position.position_state === "RECOVERY") {
        // Reconciliation established exact broker equality with the durable map;
        // this is the only transition that authorises recovery execution. A
        // malformed/overfilled map is NEVER promoted to BOX: emergency handling
        // works its exact quantities only as reduction-only partial exposure.
        const violation = singleLotPositionViolation(position);
        position.position_state = violation
          ? "PARTIALLY_EXITED"
          : deriveBoxPositionState(position.remaining_qty_by_role);
      }
      const label = `${position.underlying} ${position.expiry} ${position.lower_strike}/${position.upper_strike}`;
      attempted += 1;
      // EVERY per-position outcome is classified and published. It used to be pushed into an
      // `unknown[]` that nothing inspected, under a hardcoded `ok: true`.
      try {
        const closed = await this.monitor.closeManually(position.id);
        items.push(classifyPositionClose({ id: position.id, label, result: closed }));
      } catch (error) {
        // A throw establishes nothing about whether orders reached the broker, so this is UNRESOLVED
        // with an unknown remaining quantity — never "not reduced", and never absent from the result.
        items.push(classifyPositionClose({
          id: position.id,
          label,
          result: null,
          thrown: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    // A crash can leave COMPLETE owned intents before their trade projection was
    // inserted. Reconciliation attributes those exact symbols/quantities; flatten
    // only that durable ownership, never tag-only or arbitrary account positions.
    const crashOnly = this.orderManager.attributedRecoveryExposure().filter(
      (residual) => !projectedSymbols.has(`${residual.exchange ?? "NFO"}:${residual.tradingsymbol}`),
    );
    if (crashOnly.length > 0) {
      const recoveryKey = "boot-recovery";
      const recoveryId = recoveryExecutionAttemptId(recoveryKey, crashOnly);
      const recovery = await ensureBoxRecoveryExecutionAttempt({
        id: recoveryId,
        recoveryKey,
        residual: crashOnly,
        executionMode: this.cfg.executionMode,
        broker: this.deps.activeBroker(),
        at: new Date(),
      });
      if (!recovery) {
        // REPORTED, not thrown. Throwing here discarded every per-position outcome computed above —
        // including successful closes and, worse, unresolved ones the operator most needs to see.
        items.push({
          kind: "residual",
          id: recoveryId,
          label: crashOnly.map((r) => r.tradingsymbol).join(", "),
          disposition: "not_reduced",
          reason:
            "crash-only attributed exposure cannot be flattened without a durable recovery ledger row, " +
            "so nothing was attempted for it. The exposure is unchanged and still owned. Restore " +
            "persistence, or reduce it at the broker terminal.",
          remaining_quantity: crashOnly.reduce((sum, r) => sum + (r.quantity ?? 0), 0),
          remaining_by_role: null,
        });
        return buildAttributedFlattenResult({
          requested: positions.length + crashOnly.length,
          attempted,
          items,
          settlement,
        });
      }
      const durableRecoveryId = recovery._id.toString();
      const durableResidual = (recovery.residual_exposure ?? []) as ResidualLegExposure[];
      const durableVersion = Number.isSafeInteger(recovery.projection_version) &&
        (recovery.projection_version ?? -1) >= 0 ? recovery.projection_version! : 0;
      const durableIdentity = recovery.residual_projection_identity ??
        residualProjectionIdentity(durableResidual);
      adoptObservedFlattenCharges({
        observedByAttempt: this.observedFlattenCharges,
        observedByAttemptDay: this.observedFlattenChargesByDay,
        attemptId: durableRecoveryId,
        cumulativeCharges: recovery.flatten_charges,
        currentDay: this.deps.istDayKey(),
        chargeDay: recovery.flatten_charge_day,
        chargesForDay: recovery.flatten_charges_for_day,
        onNewCharge: (charge, observation) =>
          this.noteFlattenCharges(durableRecoveryId, charge, observation),
      });
      const requestedResidualQuantity = durableResidual.reduce(
        (sum, leg) => sum + (Number.isFinite(leg.quantity) ? leg.quantity : 0),
        0,
      );
      attempted += 1;
      let residualOutcome: FlattenItemOutcome;
      const residualLabel = durableResidual.map((leg) => leg.tradingsymbol).join(", ");
      try {
        const bootFlatten = await runInitialRegisteredResidualPass({
          // Set the guard before registration arms the timer, then keep the authoritative row in the
          // watchdog even when this first pass has no book, is gate-refused, or broker-rejected.
          markInFlight: () => this.residualFlattenInFlight.add(durableRecoveryId),
          register: () => this.registerResidual(
            durableRecoveryId,
            durableResidual,
            durableVersion,
            durableIdentity,
          ),
          flatten: async () => {
            const flattened = await this.execution.flattenResidual({
              residual: durableResidual,
              keyPrefix: durableRecoveryId,
            });
            const command = createResidualProjectionCommand({
              attemptId: durableRecoveryId,
              expectedVersion: durableVersion,
              expectedResidual: durableResidual,
              nextResidual: flattened.remaining,
              flattenChargeDelta: flattened.flatten_charges,
              flattenChargeDay: this.deps.istDayKey(),
            });
            if (residualProjectionChanges(command)) {
              try {
                const projection = await this.persistResidualProjection(durableRecoveryId, command);
                if (projection.status === "not_found") {
                  this.pendingResidualPersists.set(durableRecoveryId, command);
                  this.execution.invariantViolation("crash-only flatten durable recovery row disappeared");
                } else if (projection.status === "stale") {
                  this.execution.invariantViolation(
                    `crash-only flatten adopted newer durable projection version ${projection.projection_version}`,
                  );
                }
              } catch {
                this.pendingResidualPersists.set(durableRecoveryId, command);
                this.execution.invariantViolation("crash-only flatten awaits durable accounting acknowledgement");
              }
            }
            return flattened;
          },
          clearInFlight: () => this.residualFlattenInFlight.delete(durableRecoveryId),
        });
        residualOutcome = classifyResidualFlatten({
          id: durableRecoveryId,
          label: residualLabel,
          result: bootFlatten,
          requestedQuantity: requestedResidualQuantity,
        });
      } catch (error) {
        residualOutcome = classifyResidualFlatten({
          id: durableRecoveryId,
          label: residualLabel,
          result: null,
          requestedQuantity: requestedResidualQuantity,
          thrown: error instanceof Error ? error.message : String(error),
        });
      }
      items.push(residualOutcome);
    }
    // `settlement` is published so the operator can see what the flatten did BEFORE it planned:
    // whether working orders were cancelled, whether any refused, and whether quantities were
    // re-established. A flatten that proceeded on an unreconciled snapshot must be visible as such.
    //
    // `ok` and the HTTP status are DERIVED from the per-item outcomes plus settlement, replacing the
    // route's hardcoded `ok: true`. See `flattenOutcome.ts` for the aggregation rules — in particular
    // that any unknown remaining quantity makes the whole result unresolved rather than flat.
    return buildAttributedFlattenResult({
      requested: positions.length + crashOnly.length,
      attempted,
      items,
      settlement,
    });
  }

  /**
   * Tear everything down: stop discovery and the monitor, clear every timer, drop
   * the feed retainer and metrics sampling.
   *
   * The engine is a long-lived singleton in normal operation, so this exists for
   * clean shutdown and for tests — every timer/listener the engine owns is cleared
   * here so nothing keeps the process alive or leaks across a re-create.
   */
  dispose(): void {
    // Set FIRST, so anything that re-arms a timer during teardown sees the shutdown.
    this.disposed = true;
    this.cancelUniverseRetry();
    this.stopBootOrdinalClaim();
    this.orderManager?.setControls({ entryEnabled: false });
    this.stop();
    this.monitor.stop();
    this.environmentMonitor.stop();
    // Final flush, so a clean shutdown keeps the session's tail of observations.
    void this.calibrationPersistence.dispose().catch(() => undefined);
    this.metrics.stopSampling();
    this.pnlArchiver.stop();
    for (const t of [
      this.marketTimer,
      this.indicativeTimer,
      this.publishTimer,
      this.universeTimer,
      this.ownedRetryTimer,
      this.residualFlattenTimer,
      this.residualRecoveryRetryTimer,
    ]) {
      if (t) clearInterval(t);
    }
    this.marketTimer = null;
    this.indicativeTimer = null;
    this.publishTimer = null;
    this.universeTimer = null;
    this.ownedRetryTimer = null;
    this.residualFlattenTimer = null;
    this.residualRecoveryRetryTimer = null;
    this.orderManager?.dispose();
    // The reservation heartbeat. It only exists while a lease is held, and it is
    // unref'd, but stopping it explicitly keeps the "every timer the engine owns is
    // cleared" property this method exists to guarantee.
    this.coordinator.dispose();
    // The execution-lease heartbeat. Stopped synchronously here so the "every timer the engine owns is
    // cleared" property holds; the lease ROW is released by `releaseExecutionOwnership()`, which is a
    // database write and therefore an awaited shutdown step of its own, ordered before `closePg()`.
    // Stopping the heartbeat alone is already safe: the cached observation ages out and the dispatch
    // guard then refuses.
    this.executionLease.stopHeartbeat();
    // The balance poller. Unref'd, so it could not hold the process open, but stopping it keeps the
    // "every timer the engine owns is cleared" property this method exists to guarantee.
    this.stopAccountFundsTimer(false);
    if (this.removeConnectionListener) {
      this.removeConnectionListener();
      this.removeConnectionListener = null;
    }
    if (this.removeTickListener) {
      this.removeTickListener();
      this.removeTickListener = null;
    }
    if (this.releaseRetainer) {
      this.releaseRetainer();
      this.releaseRetainer = null;
    }
  }

  /**
   * RELEASE EXCLUSIVE EXECUTION OWNERSHIP. A separate, awaited shutdown step because it is a database
   * write and must therefore be ordered before `closePg()`.
   *
   * SIGTERM is not an instruction to liquidate, and this does not liquidate: it hands the account back
   * so a successor need not wait out the lease TTL before it can monitor and reduce the exposure this
   * process leaves open. A failure here is not a safety problem — the TTL reaps the row — so it never
   * throws and never blocks shutdown.
   */
  async releaseExecutionOwnership(): Promise<void> {
    await this.executionLease.release().catch((err: unknown) => {
      console.warn("[Box] failed to release execution ownership during shutdown:", err);
    });
  }

  /** The execution-ownership projection, for status and readiness. Never a dispatch decision. */
  executionOwnershipStatus(): ReturnType<typeof executionLeaseStatus> {
    return executionLeaseStatus({
      state: this.executionLease.snapshot(),
      liveCapable: this.cfg.executionMode === "live",
      entryBlockReason: this.executionLease.dispatchBlockReason("new_entry"),
      reductionBlockReason: this.executionLease.dispatchBlockReason("exposure_reduction"),
    });
  }

  /**
   * Keep the cached market-hours state current, and drive the last-close view
   * while the exchange is shut.
   *
   * The transition matters: on close the live books stop arriving, so the
   * indicative refresh takes over; on open it is dropped and the tick path
   * resumes as the only source of truth.
   */
  private startMarketWatch(): void {
    const sync = () => {
      // Feed health has to be re-evaluated on a timer as well as on a tick: going
      // FROM healthy TO dead is signalled precisely by ticks no longer arriving,
      // so nothing else would ever notice.
      const healthy = this.isFeedHealthy();
      if (healthy !== this.feedHealthy) {
        if (!healthy && this.feedHealthy) this.invalidateFeedGeneration();
        this.feedHealthy = healthy;
        this.scanner.setFeedHealthy(healthy);
        this.orderManager?.setFeedHealthy(healthy);
        if (!healthy && this.marketOpen) {
          console.warn(
            `[Box] tick feed has gone quiet (>${this.cfg.feedMaxAgeMs}ms) — entries and automatic exits are paused until it recovers.`,
          );
        }
      }
      // MARKET-DATA HEALTH: keep the machine's DESIRED set aligned with the real subscription
      // intent, and force an evaluation so a heartbeat gap or a book that quietly aged past its
      // bound demotes READY → DEGRADED even though no discrete event would fire. A significant
      // event-loop stall is a processing backlog: the loop was blocked long enough that queued
      // market data could not be drained, which must block NEW ENTRY without touching exposure
      // management.
      this.marketDataMachine.setDesiredInstruments(this.subscribedOptionTokens);
      const loopStall = this.environmentMonitor.annotate(this.marketWatchStallRef);
      this.marketWatchStallRef = this.executionClock.mono();
      this.marketDataMachine.onProcessingBacklog(loopStall.stalled);
      this.marketDataMachine.evaluate();
      // Enrich any open position still missing its margin (adopted-on-restart
      // trades, or entries whose margin call had failed).
      this.backfillMissingMargins();
      const open = this.deps.isMarketOpen();
      if (open !== this.marketOpen) {
        this.marketOpen = open;
        this.scanner.setMarketOpen(open);
        console.log(
          `[Box] market ${open ? "OPEN — live executable prices" : "CLOSED — last-close view only, no entries"}.`,
        );
        if (open) {
          // Live books supersede the closing snapshot immediately.
          this.scanner.clearOpportunities();
          if (this.running) {
            this.scanner.refreshAll();
          } else {
            // Discard the indicative-only windows built while the market was shut.
            // They are priced from last close and nothing is streaming them, so
            // keeping them would leave stale closing prices on screen during live
            // hours — and leave candidates nothing will ever evaluate.
            this.shrinkToOpenPositions();
          }
        } else {
          void this.refreshClosedMarketView();
        }
      }
    };
    if (!this.marketTimer) {
      this.marketTimer = setInterval(sync, 15_000);
      this.marketTimer.unref?.();
    }
    if (!this.indicativeTimer) {
      // NOT gated on `running`. The last-close view is a read-only view of how the
      // session ended; refusing to build it unless discovery is on made the closing
      // prices unreachable precisely when they are the only prices there are.
      this.indicativeTimer = setInterval(() => {
        if (this.marketOpen) return;
        void this.refreshClosedMarketView();
      }, this.cfg.indicativeRefreshMs);
      this.indicativeTimer.unref?.();
    }
    sync();
  }

  /**
   * Build and price the last-close view while the exchange is shut.
   *
   * Two steps, because with the scanner stopped there may be nothing to price:
   * `refreshUniverse` places the strike windows (and with `indicativeDiscovery` on
   * it does so for the whole universe, not just underlyings carrying a position),
   * then `refreshIndicative` prices them from last traded prices over REST.
   *
   * Costs no feed subscription: see the subscription gating in refreshUniverse.
   */
  private async refreshClosedMarketView(): Promise<void> {
    if (this.marketOpen) return;
    if (!this.deps.marketData.isAuthenticated()) return;
    try {
      await this.refreshUniverse();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    await this.refreshIndicative();
  }

  /**
   * Rebuild the opportunity list from LAST TRADED / CLOSING prices.
   *
   * Only ever runs while the market is shut. One REST /quote call per 500
   * instruments, so the whole monitored universe costs a handful of requests a
   * minute — and the result is explicitly marked `last_close`, so it can be read
   * but never traded.
   */
  async refreshIndicative(): Promise<void> {
    if (!this.deps.marketData.isAuthenticated()) return;
    // Price every leg of every monitored WINDOW, not just the tokens that happen to
    // be streaming. With discovery off the feed carries only open positions' legs,
    // so keying off subscriptions meant the last-close view could see almost
    // nothing — while the windows themselves were sitting right there. Position
    // legs are unioned in so a leg that has aged out of its window is still priced.
    const tokens = new Set<number>();
    for (const state of this.windows.values()) {
      for (const t of windowTokens(state)) tokens.add(t);
    }
    for (const t of this.subscribedOptionTokens) tokens.add(t);
    if (tokens.size === 0) return;
    try {
      const all = await this.deps.getAllInstruments();
      const resolve = this.deps.makeIdResolver(all);
      const ids = [...tokens]
        .map(resolve)
        .filter((s): s is string => typeof s === "string");
      if (ids.length === 0) return;
      // Chunked at 500 identifiers per request inside the client.
      const quotes = await this.deps.marketData.getQuoteFull(ids);

      // Only legs that traded in the LATEST session may be compared.
      //
      // `last_price` is the price of the last trade, not "the close": a strike
      // that has not traded for days carries a price struck when the underlying
      // was somewhere else, and four legs each stale from a different session
      // produce a fictional edge. The session is derived from the data itself —
      // the newest trade date across the whole universe — so no holiday calendar
      // is needed and a long weekend resolves correctly.
      const sessionDay = quotes.reduce((latest, q) => {
        const day = q.last_trade_time.slice(0, 10);
        return day > latest ? day : latest;
      }, "");

      const lastPrices = new Map<number, number>();
      let stale = 0;
      for (const q of quotes) {
        if (!(q.last_price > 0)) continue;
        if (sessionDay && q.last_trade_time.slice(0, 10) !== sessionDay) {
          stale++;
          continue; // last traded in an earlier session — not comparable
        }
        lastPrices.set(q.instrument_token, q.last_price);
      }

      // The market may have OPENED while those REST round trips were in flight. A
      // whole-universe pass takes several requests, so one starting at 09:14:40 can
      // land after 09:15 — after the open transition has already cleared the list
      // for live books. Publishing here would put last-close prices on screen during
      // live hours, undoing the very handler meant to prevent that.
      if (this.marketOpen) {
        console.log("[Box] discarding a last-close pass that finished after the open.");
        return;
      }

      this.indicativeSessionDay = sessionDay || null;
      this.indicativeStaleLegs = stale;
      this.indicativePriced = this.scanner.publishIndicative(lastPrices);
      this.indicativeAt = Date.now();
      console.log(
        `[Box] last-close view: session ${sessionDay || "unknown"}, ` +
          `${lastPrices.size}/${quotes.length} legs traded in it (${stale} stale), ` +
          `${this.indicativePriced} box(es) with a coherent close.`,
      );
      // Push it out now. With the scanner stopped there is no publish loop running,
      // so without this the freshly priced view would sit unseen until something
      // else happened to publish.
      this.publish();
    } catch (err) {
      console.warn("[Box] indicative (last-close) refresh failed:", err);
    }
  }

  /** Attach to the shared feed (tick/lifecycle listeners + retainer + publish loop). */
  private ensureFeed(): void {
    if (!this.removeTickListener) {
      this.removeTickListener = this.deps.feed.addTickListener((ticks) =>
        this.onTicks(ticks),
      );
    }
    if (!this.removeConnectionListener) {
      this.removeConnectionListener = this.deps.feed.addConnectionListener((connected) => {
        /*
         * CROSS-LANE CONTAMINATION GUARD.
         *
         * `this.deps.feed` is the SHARED (futures/board) feed. When `BOX_DEDICATED_MARKET_FEED` is
         * on — the default — the Box engine's books come from the separate BOX lane, whose own
         * lifecycle arrives via `onBoxLaneConnection`. Driving the box market-data machine and
         * invalidating the box quote generation from the FUTURES socket's connection edges meant a
         * board-lane reconnect would, for a completely unrelated socket:
         *   • bump the box feed generation, marking every warm box book stale;
         *   • wipe the quote store, the spot cache and every detected opportunity;
         *   • re-authenticate the box health machine, dropping all per-instrument readiness.
         * A board lane that flaps therefore repeatedly blinded the box scanner, which shows up as
         * exactly the reported "zero evaluated candidates" with a healthy-looking socket.
         *
         * With a dedicated box lane the shared feed is not the box engine's market-data source, so
         * its connection edges must not speak for it. Without a dedicated lane the shared feed IS
         * the source and the original behaviour is correct — hence the condition rather than a
         * blanket removal.
         */
        if (this.cfg.boxDedicatedMarketFeed && this.deps.feed.setBoxTokens) return;
        this.marketDataSocketConnected = connected;
        this.invalidateFeedGeneration();
        this.driveMarketDataConnection(connected);
      });
    }
    if (!this.releaseRetainer) {
      this.releaseRetainer = this.deps.feed.retain();
    }
    if (!this.publishTimer) {
      this.publishTimer = setInterval(() => this.publish(), this.cfg.publishIntervalMs);
      this.publishTimer.unref?.();
    }
  }

  /**
   * Let the feed go when neither discovery, nor any open position, nor any OUTSTANDING RESIDUAL
   * needs it.
   *
   * The residual clause is not defensive tidying. Residual legs are exposure without an open
   * position, so this guard used to release the tick listener, the connection listener and the
   * retainer while the flatten loop was still trying to work them — `registerResidual` called
   * `ensureFeed()`, and this method undid it on the next STOP, trade deletion, exit or SSE detach.
   * With no ticks arriving, the flatten loop can never see a priceable book, so exposure stays on
   * indefinitely with nothing reporting why.
   */
  private maybeReleaseFeed(): void {
    if (this.running || this.positions.size > 0 || this.residualLegCount() > 0) return;
    if (this.removeConnectionListener) {
      this.removeConnectionListener();
      this.removeConnectionListener = null;
    }
    if (this.removeTickListener) {
      this.removeTickListener();
      this.removeTickListener = null;
    }
    if (this.releaseRetainer) {
      this.releaseRetainer();
      this.releaseRetainer = null;
    }
    if (this.publishTimer && this.sseClients.size === 0) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
  }

  /** Every socket open/close creates a fresh executable-book generation. */
  private invalidateFeedGeneration(): void {
    this.feedGeneration++;
    this.tokenFeedGeneration.clear();
    this.lastRawTickAt = null;
    this.quotes.invalidateGeneration();
    this.spots.clear();
    this.scanner.clearOpportunities();
    this.feedHealthy = false;
    this.scanner.setFeedHealthy(false);
    this.orderManager?.setFeedHealthy(false);
  }

  /* --------------------------- market-data intake -------------------------- */

  /**
   * THE HOT PATH. Ticks land here from the shared WebSocket.
   *
   * Apply → find affected candidates → evaluate. No database, no HTTP, no
   * frontend round trip. The UI is updated separately on its own slow cadence.
   */
  private onTicks(ticks: Tick[]): void {
    if (ticks.length === 0) return;
    const now = Date.now();
    // Raw socket liveness is independent of executable depth. LTP-only index,
    // futures and option ticks keep analytics/feed health alive but cannot warm a
    // token's executable-book generation.
    this.lastRawTickAt = now;
    // Underlying values first: the strike window depends on them.
    for (const t of ticks) {
      if (this.subscribedSpotTokens.has(t.token) && t.last_price > 0) {
        this.spots.set(t.token, t.last_price, now);
      }
      // Sample how far behind the exchange we are, when a packet carries an
      // exchange timestamp. It is a Unix SECOND, so the estimate is coarse (and
      // sensitive to any skew between our clock and the exchange's), hence it is
      // kept as a rolling distribution and clearly labelled approximate.
      if (t.exchange_ts && t.exchange_ts > 0) this.sampleExchangeLag(now - t.exchange_ts);
    }
    this.metrics.ticks.mark(ticks.length, now);
    const changed = this.quotes.applyTicks(ticks, now);
    // MARKET-DATA HEALTH: any packet on the current socket is a received frame (transport
    // liveness); a token that now carries a usable book is FRESH DEPTH for that instrument this
    // generation. These are fed as DISTINCT facts — a frame never counts as depth — so the machine
    // cannot read READY off a socket that is alive but publishing no usable book.
    this.marketDataMachine.onFrame();
    for (const token of changed) {
      if (this.quotes.get(token)) {
        this.tokenFeedGeneration.set(token, this.feedGeneration);
        this.marketDataMachine.onUsableDepth(token);
      } else {
        this.tokenFeedGeneration.delete(token);
      }
    }
    if (changed.length > 0) {
      this.metrics.wsUpdates.mark(changed.length, now);
      // Open-position exits get first look at every authoritative observation,
      // including an empty invalidation that must make pending work fail closed.
      this.monitor.onTokensUpdated(changed);
      this.scanner.onTokensUpdated(changed, now);
    }
    // Any raw packet on the current socket restores GLOBAL liveness. Per-token
    // execution remains guarded by current-generation usable books above.
    if (this.marketOpen && !this.feedHealthy) {
      this.feedHealthy = true;
      this.scanner.setFeedHealthy(true);
      this.orderManager?.setFeedHealthy(true);
    }
  }

  /**
   * DEGRADED-RECOVERY CAPABILITY for the active broker.
   *
   * `supported` records whether the broker has a REST depth endpoint that does NOT substitute the last
   * traded price for a missing touch:
   *
   *   · Zerodha — YES, via `KiteClient.getQuoteLadder()`, which returns real 5-level bids/asks filtered
   *     to `price > 0`. NOT `getQuoteDepth()`, whose `?? last` fallback manufactures a two-sided price
   *     for an unquoted instrument.
   *   · Dhan — YES in principle, via `DhanClient.marketFeedQuote()`, which carries 5-level depth with
   *     per-level order counts.
   *
   * `enabled` is separate and currently always FALSE, and that is deliberate rather than an oversight.
   * The admission test and the policy are complete and tested, but admitting a REST-sourced reference
   * price at the DISPATCH BOUNDARY is not wired: `executionGateway.precheckOne` is synchronous and
   * demands a WS quote with a current feed generation, and `checkedFeedBlockReason` re-validates that
   * same stamp at CHECKPOINT 3 and CHECKPOINT 5. A REST-priced order would therefore be refused at the
   * last instant anyway, and half-wiring the most safety-critical code in the process to avoid that
   * would be worse than reporting honestly.
   *
   * So the degraded path today makes the outage VISIBLE and EXACT — which position, why, and that the
   * broker terminal is the remaining route — without claiming it can execute. See
   * `docs/DEGRADED_RECOVERY.md`.
   */
  private degradedRecoveryCapability(): RecoveryDepthCapability {
    const broker = String(this.deps.activeBroker());
    const supported = broker === "zerodha" || broker === "dhan";
    return {
      supported,
      enabled: false,
      detail: supported
        ? "REST depth exists for this broker, but admitting a REST-sourced reference price at the order " +
          "dispatch boundary is not wired, so this process will not price a reduction from it. Reductions " +
          "still require a healthy WebSocket book."
        : `no REST depth source is known for broker ${broker}, so a reduction cannot be priced while the ` +
          "WebSocket feed is unhealthy.",
    };
  }

  /**
   * WHY this position cannot be reduced right now, or null when it can.
   *
   * Consulted by the monitor in place of a bare `return` on an unhealthy feed. Never consulted for entry:
   * a degraded feed can never justify creating a new four-leg box, and `streamHealthPolicy.ts` already
   * records that asymmetry.
   */
  private degradedReductionBlockReason(pos: BoxOpenPosition): string | null {
    const decision = degradedRecoveryVerdict({
      marketOpen: this.marketOpen,
      feed: this.isFeedHealthy() ? "healthy" : "unhealthy",
      capability: this.degradedRecoveryCapability(),
      // No REST observation is sought while the path is not enabled. When it is, this is where the
      // per-instrument admission verdict arrives.
      admission: null,
      tradingsymbol: `${pos.underlying} ${pos.expiry} ${pos.lower_strike}/${pos.upper_strike}`,
    });
    if (decision.kind === "normal") return null;
    if (decision.kind === "degraded") return null;
    return decision.blocker;
  }

  /** The degraded-recovery projection, so the operator sees the state rather than inferring it. */
  degradedRecoveryState(): DegradedRecoveryStatus {
    const feed: FeedCondition = this.isFeedHealthy() ? "healthy" : "unhealthy";
    // Bounded: only positions that actually carry a blocked reason, capped so a wide outage cannot
    // produce an unbounded projection.
    const blocked: { tradingsymbol: string; reason: string }[] = [];
    for (const pos of this.positions.list()) {
      if (blocked.length >= 20) break;
      const reason = pos.exit_blocked_reason;
      if (typeof reason === "string" && reason !== "") {
        blocked.push({
          tradingsymbol: `${pos.underlying} ${pos.expiry} ${pos.lower_strike}/${pos.upper_strike}`,
          reason,
        });
      }
    }
    return degradedRecoveryStatus({ capability: this.degradedRecoveryCapability(), feed, blocked });
  }

  /** Whether the current socket has delivered any raw tick recently. */
  private isFeedHealthy(): boolean {
    if (!this.marketOpen) return false;
    const at = this.lastRawTickAt;
    if (at === null) return false;
    return Date.now() - at <= this.cfg.feedMaxAgeMs;
  }

  /** Age (ms) of the newest raw tick anywhere in the box universe. */
  private feedAgeMs(): number | null {
    const at = this.lastRawTickAt;
    return at === null ? null : Date.now() - at;
  }

  /** Age of the newest authoritative book observation (usable or invalidating). */
  private bookObservationAgeMs(): number | null {
    const at = this.quotes.lastUpdateAt;
    return at === null ? null : Date.now() - at;
  }

  /** Record one exchange-lag sample into the ring, clamping clock-skew negatives. */
  private sampleExchangeLag(lagMs: number): void {
    // A negative lag means our clock is behind the exchange's — clock skew, not a
    // real "arrived before it was sent". Clamp so it never flatters the figure.
    const v = lagMs < 0 ? 0 : lagMs;
    if (this.exchangeLagSamples.length < BoxEngine.EXCHANGE_LAG_WINDOW) {
      this.exchangeLagSamples.push(v);
    } else {
      this.exchangeLagSamples[this.exchangeLagCursor] = v;
      this.exchangeLagCursor = (this.exchangeLagCursor + 1) % BoxEngine.EXCHANGE_LAG_WINDOW;
    }
  }

  /**
   * The exchange-lag distribution, or null when no timestamped packet has been
   * seen yet.
   *
   * APPROXIMATE by construction: the exchange stamp is second-resolution and the
   * figure includes any skew between our clock and the exchange's. It answers
   * "roughly how far behind NSE is the book we are acting on", not a precise
   * network latency.
   */
  private exchangeLag(): {
    median_ms: number;
    p95_ms: number;
    last_ms: number;
    samples: number;
  } | null {
    const n = this.exchangeLagSamples.length;
    if (n === 0) return null;
    const sorted = [...this.exchangeLagSamples].sort((a, b) => a - b);
    const at = (frac: number) => sorted[Math.min(n - 1, Math.floor(frac * n))]!;
    return {
      median_ms: at(0.5),
      p95_ms: at(0.95),
      // Newest sample: the most recently written ring slot.
      last_ms:
        n < BoxEngine.EXCHANGE_LAG_WINDOW
          ? this.exchangeLagSamples[n - 1]!
          : this.exchangeLagSamples[
              (this.exchangeLagCursor - 1 + BoxEngine.EXCHANGE_LAG_WINDOW) %
                BoxEngine.EXCHANGE_LAG_WINDOW
            ]!,
      samples: n,
    };
  }

  /* ------------------------------- universe ------------------------------- */

  /**
   * Rebuild the scanned universe: nearest live expiry per underlying, the ATM
   * ±(active level) window, its candidate strike pairs, and the subscription set.
   *
   * Windows are only re-centred when the underlying has genuinely drifted (see
   * windowNeedsRebuild), so this can run on a timer without churning
   * subscriptions.
   *
   * TWO REASONS a window gets built, and they are not the same thing:
   *   - to STREAM (discovery is on, or the underlying carries an open position):
   *     costs a slice of the subscription budget;
   *   - to LOOK AT while the exchange is shut (`indicativeDiscovery`): priced from
   *     last-close prices over REST and subscribed to nothing.
   */
  async refreshUniverse(): Promise<void> {
    if (!this.deps.marketData.isAuthenticated()) return;
    const now = Date.now();
    const today = this.deps.istDayKey();

    /*
     * INSTRUMENT LOAD IS AN OBSERVED STAGE, NOT AN ASSUMPTION.
     *
     * `getAllInstruments()` returned `[]` for Zerodha for as long as this bug existed, and because
     * an empty array is a perfectly successful Promise nothing here could tell the difference
     * between "the broker has no instruments" and "we never asked". Every count below is recorded so
     * `assessUniverseReadiness` can name the stage that actually stopped, and a REJECTION is
     * recorded and rethrown rather than being flattened into an empty universe.
     */
    let all: Instrument[];
    let board: BoxBoardItem[];
    /*
     * A RETRY DOES NOT DOWNGRADE `failed` TO `loading`.
     *
     * This was `if (this.instrumentLoadState !== "loaded") … = "loading"`, so every retry attempt
     * flipped a known failure back to `loading` — and `loading` is classified TRANSIENT, whose whole
     * message is "this resolves on its own, wait rather than restarting". An operator watching a
     * broker that had already failed three times was told to wait, while the real 503 sat in
     * `instruments_error` where the headline no longer pointed. `failed` is sticky until a load
     * actually succeeds, which is also what this module's own "may not conflate loading with failed"
     * rule requires.
     */
    if (this.instrumentLoadState === "never_attempted") this.instrumentLoadState = "loading";
    try {
      [all, board] = await Promise.all([this.deps.getAllInstruments(), this.deps.getBoard()]);
    } catch (err) {
      this.instrumentLoadState = "failed";
      this.instrumentLoadFailures++;
      this.instrumentsError = err instanceof Error ? err.message : String(err);
      // Rethrow: the caller records it and the bounded retry below picks it up. Swallowing here is
      // what would recreate the silent-empty-universe failure.
      throw err;
    }
    this.instrumentLoadState = "loaded";
    this.instrumentLoadFailures = 0;
    this.instrumentsError = null;
    this.instrumentCount = all.length;
    if (all.length > 0) this.instrumentsLoadedAt = now;

    /*
     * PER-UNDERLYING EXPIRY DISTANCE, because index and stock underlyings settle differently.
     *
     * Index options are CASH settled; stock options are PHYSICALLY settled, and NSE ramps
     * physical-delivery margin on ITM long options from several days before expiry. So a stock chain
     * needs to be further from settlement than an index chain to be safe to open, and the stock rule
     * is applied as a MAXIMUM with the index rule rather than a replacement — raising the index
     * minimum therefore also raises the stock one, which is the only composition that cannot be
     * configured into being looser than intended.
     */
    const isIndexUnderlying = new Map(board.map((b) => [b.symbol, b.is_index === true]));
    const indexMinDays = this.cfg.minTradingDaysToExpiry;
    const stockMinDays = Math.max(indexMinDays, this.cfg.stockMinTradingDaysToExpiry);
    this.chains = indexOptionChains(all, today, {
      minTradingDays: indexMinDays,
      // Resolved per underlying inside the selection walk, so a stock and an index can land on
      // different series in one pass.
      tradingDaysUntil: (from, to) => tradingDaysUntil(from, to),
    });
    /*
     * Re-select for stock underlyings that need a longer runway, and DROP stock underlyings entirely
     * unless the operator has opted in.
     *
     * Done as a second pass rather than threaded through `indexOptionChains` because that function is
     * pure over the dump and has no notion of the board — `is_index` lives on the board row, which is
     * the only place the index/stock distinction is known.
     */
    for (const [symbol, chain] of [...this.chains]) {
      const isIndex = isIndexUnderlying.get(symbol) === true;
      if (isIndex) continue;
      if (!this.cfg.allowStockUnderlyings) {
        this.chains.delete(symbol);
        continue;
      }
      const days = chain.trading_days_to_expiry;
      if (stockMinDays > 0 && (days === null || days < stockMinDays)) {
        // Rebuild this one underlying against the stricter rule rather than guessing a replacement
        // series, so the recorded `skipped_near_expiries` stays truthful.
        const restricted = indexOptionChains(all.filter((i) => i.name === symbol), today, {
          minTradingDays: stockMinDays,
          tradingDaysUntil: (from, to) => tradingDaysUntil(from, to),
        }).get(symbol);
        if (restricted) this.chains.set(symbol, restricted);
        else this.chains.delete(symbol);
      }
    }
    this.board = prioritiseUniverse(board.filter((b) => this.chains.has(b.symbol)));
    // Recorded BEFORE and AFTER the join, because "no board rows" and "the board and the chains do
    // not intersect" have completely different causes and identical symptoms.
    this.boardRowsDerived = board.length;
    this.chainsIndexed = this.chains.size;
    this.boardWithChains = this.board.length;
    if (all.length > 0 && this.board.length === 0) {
      // Loud, because this is the shape of the bug that started all this: a successful load whose
      // universe is nonetheless unusable.
      console.warn(
        `[Box] universe unusable: ${all.length.toLocaleString()} instrument(s) produced ` +
          `${board.length} board row(s) and ${this.chains.size} option chain(s), of which ` +
          `${this.board.length} joined. Nothing can be subscribed.`,
      );
    }

    // Underlyings carrying EXPOSURE must always be in the universe, whatever the
    // budget says, so their legs keep streaming. That is open positions AND unresolved
    // residual legs: a residual-only underlying is exposure with no open position, and
    // leaving it out let a routine universe pass unsubscribe the books the flatten loop
    // needs — including the window pruning at the end of this method.
    const mustKeep = new Set(this.positions.list().map((p) => p.underlying));
    for (const symbol of this.residualUnderlyings()) mustKeep.add(symbol);

    // Seed the spot values we do not have yet, so a first window can be placed.
    await this.seedSpots(all);

    const budget = this.cfg.maxSubscribedTokens;
    const wantOption = new Set<number>();
    const wantSpot = new Set<number>();
    const skipped: string[] = [];
    /**
     * Skipped for the INDICATIVE cap, kept apart from the token-budget list.
     *
     * Two different reasons a symbol is left out, and conflating them made the UI
     * blame the live-feed token budget for exclusions that had nothing to do with
     * it — while the market was shut and nothing was streaming at all.
     */
    const skippedIndicative: string[] = [];
    /**
     * Skipped because BOX_MAX_UNDERLYINGS capped the list, kept apart from the token-budget list for
     * the same reason as the indicative cap above: the two limits are unrelated and reporting them
     * as one names the wrong number as the constraint.
     */
    const skippedForCap: string[] = [];
    /** Underlyings that have a live window after this pass (subscribed or not). */
    const liveWindows = new Set<string>();
    let used = 0;

    /**
     * Whether windows are built for the whole universe.
     *
     * True while discovering, and ALSO while the market is shut with
     * `indicativeDiscovery` on: with the exchange closed the windows are wanted
     * purely to be priced from last-close prices and looked at, which costs REST
     * calls but no feed subscription (see the gating below).
     */
    const discoveryAllowed =
      this.running || (!this.marketOpen && this.cfg.indicativeDiscovery);
    /** True when a window is wanted for STREAMING, not merely for the closed view. */
    const streams = (symbol: string): boolean => this.running || mustKeep.has(symbol);
    /**
     * Indicative-only windows built this pass, against their own cap.
     *
     * They spend none of the subscription budget, so `budget` does not bound them.
     * Without this counter a stopped engine after hours would hold a window and a
     * full candidate set for every underlying with a chain, and re-quote the lot
     * every minute until the market opened.
     */
    const indicativeCap = this.cfg.indicativeMaxUnderlyings;
    let indicativeUsed = 0;

    const ordered = [
      ...this.board.filter((b) => mustKeep.has(b.symbol)),
      ...this.board.filter((b) => !mustKeep.has(b.symbol)),
    ];
    const cap =
      this.cfg.maxUnderlyings > 0 ? Math.min(this.cfg.maxUnderlyings, ordered.length) : ordered.length;

    for (const [i, item] of ordered.entries()) {
      if (i >= cap && !mustKeep.has(item.symbol)) {
        // BOX_MAX_UNDERLYINGS, not the token budget. Recorded separately so the operator is told
        // which setting actually excluded the name.
        skippedForCap.push(item.symbol);
        continue;
      }
      /*
       * OPERATOR BLOCKLIST — the SOFT layer, and deliberately subordinate to `mustKeep`.
       *
       * Dropping an excluded name here removes its window and its candidates entirely, so the
       * scanner never prices it and its ~15 tokens are returned to the subscription budget. That is a
       * real benefit, not just tidiness: the budget is what decides how much of the universe is
       * watchable at all.
       *
       * But it is NOT the guarantee, for two reasons. Windows are only rebuilt on a refresh pass, so
       * a newly-added exclusion would otherwise not bite until the next one; and `mustKeep` overrides
       * every cap here by design, because an underlying carrying an open position or an unresolved
       * residual leg MUST keep streaming or the monitor cannot exit it. So an excluded name with
       * exposure stays fully subscribed, and the four entry checks are what actually stop a new box.
       */
      if (!mustKeep.has(item.symbol) && this.exclusions.has(item.symbol)) {
        continue;
      }

      const chain = this.chains.get(item.symbol);
      if (!chain) continue;

      const spot = this.spots.get(item.spot_token);
      const existing = this.windows.get(item.symbol);

      // Nothing wants this underlying: discovery is off (and the market is open, so
      // there is no closed view to build) and it carries no position.
      if (!discoveryAllowed && !mustKeep.has(item.symbol)) continue;

      let state = existing;
      const needsBuild =
        // A strike-level change forces every window to rebuild at the new width.
        this.forceWindowRebuild ||
        !state ||
        state.expiry !== chain.expiry ||
        (spot !== undefined &&
          windowNeedsRebuild({
            state,
            spot: spot.value,
            now,
            hysteresis: this.cfg.atmHysteresis,
            minIntervalMs: this.cfg.windowMinIntervalMs,
          }));

      if (needsBuild && spot !== undefined) {
        const built = buildUnderlyingState({
          board: item,
          chain,
          spot: spot.value,
          spotAt: spot.at,
          // The ACTIVE admin-selected level, never above the ATM ±3 cap.
          eachSide: this.strikeLevel,
          now,
        });
        if (built) state = built;
      }
      if (!state) continue;

      const tokens = windowTokens(state);
      // The budget counts the option legs plus the one underlying we need to keep
      // the window centred. It is a SUBSCRIPTION budget, so it only binds windows
      // that will actually stream — an indicative-only window costs no slot.
      const cost = tokens.length + 1;
      if (streams(item.symbol)) {
        if (used + cost > budget && !mustKeep.has(item.symbol)) {
          skipped.push(item.symbol);
          continue;
        }
        used += cost;
      } else {
        // Indicative-only: bounded by its own cap, not by the token budget.
        if (indicativeCap > 0 && indicativeUsed >= indicativeCap) {
          skippedIndicative.push(item.symbol);
          continue;
        }
        indicativeUsed++;
      }
      liveWindows.add(item.symbol);

      if (state !== existing) {
        this.windows.set(item.symbol, state);
        this.scanner.setCandidatesForUnderlying(
          item.symbol,
          buildCandidates({
            underlying: state.underlying,
            name: state.name,
            is_index: state.is_index,
            expiry: state.expiry,
            lot_size: state.lot_size,
            strikes: state.strikes,
            ce: state.ce,
            pe: state.pe,
            directions: this.directions,
          }),
        );
      }
      // Only stream what is actually being traded or monitored. An indicative
      // window built for the closed-market view is priced over REST, so it must not
      // put the hub anywhere near its subscription budget — and must not still be
      // subscribed when the market reopens with discovery still off.
      if (streams(item.symbol)) {
        for (const t of tokens) wantOption.add(t);
        wantSpot.add(item.spot_token);
      }
    }

    // Open positions' legs are subscribed unconditionally.
    for (const t of this.positions.tokens()) wantOption.add(t);
    // So are residual legs. This union is the ONLY unconditional one, so a residual whose
    // underlying fell out of the board or lost the budget race would otherwise be dropped
    // here even though the exposure is still on.
    for (const t of this.residualTokens()) wantOption.add(t);

    // The forced rebuild (from a strike-level change) has now been applied.
    this.forceWindowRebuild = false;
    this.skippedForBudget = skipped;
    this.skippedForUnderlyingCap = skippedForCap;
    this.skippedForIndicativeCap = skippedIndicative;
    this.universeBuiltAt = now;
    /*
     * HOW MANY JOINED UNDERLYINGS STILL HAVE NO PRICE TO CENTRE ON.
     *
     * This is the observation that separates `awaiting_spot_prices` from `no_windows_built`. It is
     * counted over the joined board rather than the whole dump, because an underlying with no chain
     * was never a candidate for a window in the first place and counting it would overstate the
     * problem.
     */
    this.underlyingsMissingSpot = this.board.filter(
      (b) => this.spots.get(b.spot_token) === undefined,
    ).length;
    // The last pass that produced at least one window. Distinguishes "never worked" from "worked
    // until N minutes ago", which is the difference between a broken deployment and a live incident.
    if (liveWindows.size > 0) this.lastSuccessfulBuildAt = now;
    this.applySubscriptions(wantOption, wantSpot);
    // Windows that dropped out of the universe must stop producing candidates.
    // Keyed on what this pass actually built, NOT on the subscription set: an
    // indicative window is deliberately unsubscribed, and testing `wantSpot` would
    // therefore delete every window the closed-market view had just placed.
    for (const underlying of [...this.windows.keys()]) {
      if (liveWindows.has(underlying) || mustKeep.has(underlying)) continue;
      this.windows.delete(underlying);
      this.scanner.removeUnderlying(underlying);
    }
    this.charges.prune();
  }

  /**
   * Run a universe pass and, if it FAILS, schedule a bounded deduplicated retry.
   *
   * WHY THIS EXISTS. A transient instrument-master failure (a 5xx from the broker, a DNS blip, a
   * truncated CSV) left the engine with no universe until the next `universeRefreshMs` tick — and
   * before the diagnostics above, with no visible reason either. The observed operator response was
   * to press RUN again, restart the process, or regenerate a token, none of which was the problem.
   *
   * The retry is:
   *   - BOUNDED: exponential from 2s, capped at 60s, so a broker outage cannot become a retry storm;
   *   - DEDUPLICATED: one timer at a time, so overlapping triggers (the recurring timer, a RUN, a
   *     strike-level change) cannot stack into parallel multi-megabyte downloads. The
   *     `InstrumentProvider`'s own `inFlight` map is the second line of defence for concurrent calls;
   *   - SELF-CLEARING: a success cancels it and resets the backoff.
   *
   * It never throws: the caller has already recorded the failure, and an unhandled rejection inside
   * a timer would take the process down over a recoverable condition.
   */
  private async refreshUniverseWithRetry(): Promise<void> {
    // ONE PASS AT A TIME. Overlapping passes duplicate the REST spot seed and the window rebuild
    // while mutating shared state; deduplicating only the timer does not prevent that.
    if (this.universePassInFlight) return;
    this.universePassInFlight = true;
    try {
      // HEAL AN UNREADABLE BLOCKLIST. A boot-time read failure closes ENTRY, so it must not need a
      // restart to clear. This pass is the right carrier: it already runs on RUN and then every
      // `universeRefreshMs`, and a successful reload wants a universe rebuild anyway so the newly
      // known exclusions actually drop out of the candidate set. A cheap no-op unless the last read
      // failed, and it deliberately cannot throw into the retry logic below.
      await this.retryExclusionLoad().catch(() => undefined);
      await this.refreshUniverse();
      // Success clears both the pending retry and the backoff, so the next incident starts at the
      // base delay rather than wherever the last one ended.
      this.universeRetryAttempts = 0;
      if (this.universeRetryTimer) {
        clearTimeout(this.universeRetryTimer);
        this.universeRetryTimer = null;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.universeRetryAttempts++;
      this.scheduleUniverseRetry();
      throw err;
    } finally {
      this.universePassInFlight = false;
    }
  }

  /**
   * Arm the bounded retry. Idempotent: a pending retry is never duplicated.
   *
   * Refuses to arm once disposed, and once discovery has stopped — a retry that outlived STOP kept
   * loading the instrument master and seeding spots over REST on a self-perpetuating timer, for a
   * scanner the operator had switched off. Open positions do not need this path: they are monitored
   * from the surviving subscriptions, not from a universe rebuild.
   */
  private scheduleUniverseRetry(): void {
    if (this.universeRetryTimer !== null) return;
    if (this.disposed || !this.running) return;
    const attempt = Math.max(1, this.universeRetryAttempts);
    const delay = Math.min(
      BoxEngine.UNIVERSE_RETRY_MAX_MS,
      BoxEngine.UNIVERSE_RETRY_BASE_MS * 2 ** Math.min(5, attempt - 1),
    );
    console.warn(
      `[Box] universe pass failed (attempt ${attempt}); retrying in ${delay}ms. ` +
        `Reason: ${this.instrumentsError ?? this.lastError ?? "unknown"}`,
    );
    this.universeRetryTimer = setTimeout(() => {
      this.universeRetryTimer = null;
      // Bare catch: the failure is already recorded and a further retry is armed inside.
      void this.refreshUniverseWithRetry().catch(() => undefined);
    }, delay);
    this.universeRetryTimer.unref?.();
  }

  /** Cancel any pending universe retry and reset the backoff. */
  private cancelUniverseRetry(): void {
    if (this.universeRetryTimer) {
      clearTimeout(this.universeRetryTimer);
      this.universeRetryTimer = null;
    }
    this.universeRetryAttempts = 0;
  }

  /**
   * Fetch the underlying values we are missing.
   *
   * Index spot instruments have no market depth, so the WebSocket alone can take
   * a while to place a first window; one REST call gets every window opened
   * immediately.
   */
  private async seedSpots(all: Instrument[]): Promise<void> {
    const missing = this.board
      .filter((b) => this.spots.get(b.spot_token) === undefined)
      .slice(0, 500);
    if (missing.length === 0) return;
    const resolve = this.deps.makeIdResolver(all);
    const ids = missing
      .map((b) => resolve(b.spot_token))
      .filter((s): s is string => typeof s === "string");
    if (ids.length === 0) return;
    try {
      const quotes = await this.deps.marketData.getQuoteFull(ids);
      const at = Date.now();
      const bySymbol = new Map(quotes.map((q) => [q.instrument_token, q]));
      for (const b of missing) {
        const q = bySymbol.get(b.spot_token);
        if (q && q.last_price > 0) this.spots.set(b.spot_token, q.last_price, at);
      }
      // A seed that returned nothing usable is not a success. Recorded so
      // `awaiting_spot_prices` can say whether the REST call failed or simply came back empty.
      this.spotSeedFailed = false;
      this.spotSeedError = null;
    } catch (err) {
      /*
       * SURFACED, NOT JUST LOGGED.
       *
       * This catch used to be a bare `console.warn`, and it never touched any published field. That
       * matters more than it looks: `refreshUniverse` skips an underlying entirely when it has no
       * spot (`if (!state) continue`), so a failed seed produces ZERO windows, zero candidates and
       * zero subscriptions — the same observable state as an empty instrument dump, with the
       * explanation only in the process log.
       *
       * It stays non-fatal on purpose: a spot seed can fail for one chunk while the rest of the
       * universe is fine, and the next pass retries. But it is now an OBSERVATION, so
       * `assessUniverseReadiness` can report `awaiting_spot_prices` with the real reason attached.
       */
      this.spotSeedFailed = true;
      this.spotSeedError = err instanceof Error ? err.message : String(err);
      console.warn("[Box] spot seed failed:", err);
    }
  }

  /** Reconcile the hub subscription with what the engine now wants. */
  private applySubscriptions(wantOption: Set<number>, wantSpot: Set<number>): void {
    const toAdd: number[] = [];
    for (const t of wantOption) if (!this.subscribedOptionTokens.has(t)) toAdd.push(t);
    for (const t of wantSpot) if (!this.subscribedSpotTokens.has(t)) toAdd.push(t);

    const toDrop: number[] = [];
    for (const t of this.subscribedOptionTokens) if (!wantOption.has(t)) toDrop.push(t);
    for (const t of this.subscribedSpotTokens) if (!wantSpot.has(t)) toDrop.push(t);

    this.subscribedOptionTokens = wantOption;
    this.subscribedSpotTokens = wantSpot;

    // PREFERRED: the dedicated Box lane. Its own socket and its own token budget, so a
    // wide option universe cannot displace the calendar-spread board's instruments and
    // a busy board cannot displace strikes. Both option AND spot tokens go here: the Box
    // scanner's view of the underlying must not depend on the futures lane's health.
    if (this.cfg.boxDedicatedMarketFeed && this.deps.feed.setBoxTokens) {
      /*
       * RECORD THE INTENT BEFORE PUBLISHING IT UPSTREAM.
       *
       * `setBoxTokens` can synchronously create the box-lane socket, and the resulting
       * `onBoxLaneConnection(true)` edge calls `setDesiredInstruments(this.subscribedOptionTokens)`.
       * When the assignment happened AFTER the call, that edge could publish the PREVIOUS
       * generation's desired set — empty on the very first subscription — so readiness would be
       * measured against nothing (and `anyDesiredFresh` returns false for an empty set, keeping the
       * machine below READY until the next market-watch tick re-asserted it).
       *
       * Assigning first makes the ordering irrelevant: whenever the connection edge lands, the
       * desired set it reads is already the current one.
       */
      this.subscribedOptionTokens = new Set(wantOption);
      this.subscribedSpotTokens = new Set(wantSpot);
      // Keep the health machine's measurement target in step with the intent immediately, rather
      // than waiting up to one market-watch period (15s) for the timer to re-assert it.
      this.marketDataMachine.setDesiredInstruments(this.subscribedOptionTokens);
      this.deps.feed.setBoxTokens([...wantOption, ...wantSpot]);
      if (toDrop.length > 0) this.quotes.forget(toDrop);
      return;
    }
    // Fallback: the single shared feed, exactly as before. Kept so the dedicated lane
    // can be switched off without a redeploy, and so a provider that predates it works.
    if (this.deps.feed.setStrategyTokens) {
      this.deps.feed.setStrategyTokens([...wantOption, ...wantSpot]);
      this.subscribedOptionTokens = new Set(wantOption);
      this.subscribedSpotTokens = new Set(wantSpot);
      if (toDrop.length > 0) this.quotes.forget(toDrop);
      return;
    }
    if (toAdd.length > 0) this.deps.feed.subscribeTokens(toAdd);
    if (toDrop.length > 0) {
      this.deps.feed.unsubscribeTokens(toDrop);
      this.quotes.forget(toDrop);
    }
  }

  /**
   * After STOP: keep only what OUTSTANDING EXPOSURE needs — open positions AND residual legs.
   *
   * STOP is an operator SAFETY control. It turns discovery off; it must never remove the market data
   * that reducing existing exposure depends on. Computing the keep-set from `positions` alone meant a
   * residual-only book (an incomplete entry that left legs behind without opening a box) had its
   * subscriptions dropped and its quotes forgotten by the very action an operator reaches for when
   * something looks wrong.
   */
  private shrinkToOpenPositions(): void {
    const keepUnderlyings = new Set(this.positions.list().map((p) => p.underlying));
    // Residual exposure keeps its underlying's window and spot alive too, so the flatten loop can
    // still centre and price the contracts it is unwinding.
    for (const symbol of this.residualUnderlyings()) keepUnderlyings.add(symbol);
    for (const underlying of [...this.windows.keys()]) {
      if (keepUnderlyings.has(underlying)) continue;
      this.windows.delete(underlying);
      this.scanner.removeUnderlying(underlying);
    }
    this.scanner.clearOpportunities();

    const wantOption = new Set<number>(this.positions.tokens());
    // Residual legs are exposure. They are subscribed on exactly the same footing as an open
    // position's legs, and for the same reason: they cannot be flattened from a book we dropped.
    for (const token of this.residualTokens()) wantOption.add(token);
    const wantSpot = new Set<number>();
    for (const underlying of keepUnderlyings) {
      const w = this.windows.get(underlying);
      if (w) wantSpot.add(w.spot_token);
    }
    this.applySubscriptions(wantOption, wantSpot);
    this.maybeReleaseFeed();
  }

  /* --------------------------- executed positions --------------------------- */

  /**
   * Create the durable trade projection for a confirmed execution.
   *
   * Paper modes contain observed simulated fills; live mode reaches this method
   * only with broker-confirmed cumulative quantities from the central gateway.
   */
  /**
   * Persist an independent-leg execution ATTEMPT that did not open a box.
   *
   * A failed four-leg execution can itself cost money (partial fill + emergency
   * unwind), so it must not vanish as though nothing happened. Stored in its own
   * `box_execution_attempts` collection — never mixed into `box_trades` — so the
   * strategy's true P&L can later net successful boxes against abort losses.
   */
  private async persistExecutionAttempt(
    candidate: BoxCandidate,
    legging: PaperLeggingExecutionRecord,
    reason: BoxExecutionFailureReason,
    detail: string,
    /** Gross edge at detection (₹), for cost attribution. Null when it is not known. */
    detectedGrossEdge?: number | null,
  ): Promise<void> {
    const direction = candidate.direction ?? "LONG_BOX";
    let grossAbort = legging.legging_gross_loss ?? null;
    let netAbort = legging.legging_net_loss ?? null;
    if (legging.mode === "live" && grossAbort === null) {
      const entryOrders = legging.legs
        .filter((leg) => leg.fill_qty > 0 && leg.fill_price !== null)
        .map((leg) => ({ side: leg.side, tradingsymbol: leg.tradingsymbol, quantity: leg.fill_qty, price: leg.fill_price! }));
      const unwindOrders = legging.legs
        .filter((leg) => leg.unwound_qty > 0 && leg.unwind_price !== null)
        .map((leg) => ({ side: leg.side === "BUY" ? "SELL" as const : "BUY" as const, tradingsymbol: leg.tradingsymbol, quantity: leg.unwound_qty, price: leg.unwind_price! }));
      grossAbort = round2(legging.legs.reduce((sum, leg) => {
        if (leg.unwound_qty <= 0 || leg.fill_price === null || leg.unwind_price === null) return sum;
        const per = leg.side === "BUY" ? leg.unwind_price - leg.fill_price : leg.fill_price - leg.unwind_price;
        return sum + per * leg.unwound_qty;
      }, 0));
      const entryCharges = entryOrders.length > 0 ? this.localCharges.legs(entryOrders).total : 0;
      const unwindCharges = unwindOrders.length > 0 ? this.localCharges.legs(unwindOrders).total : 0;
      legging.partial_entry_charges = round2(entryCharges);
      legging.unwind_charges = round2(unwindCharges);
      legging.legging_gross_loss = grossAbort;
      netAbort = round2(grossAbort - entryCharges - unwindCharges);
      legging.legging_net_loss = netAbort;
    }
    const residual = legging.residual_exposure ?? [];
    const attempt: IBoxExecutionAttempt = {
      candidate_key: candidate.key,
      direction,
      underlying: candidate.underlying,
      name: candidate.name,
      is_index: candidate.is_index,
      expiry: candidate.expiry,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      execution_mode: this.cfg.executionMode,
      leg_execution_mode: legging.leg_execution_mode,
      detected_at: new Date(legging.detected_at),
      resolved_at: new Date(),
      detected_gross_edge: null,
      // The economics recomputed on the EXECUTED prices, and the gate they were
      // tested against — so an abort can be sized rather than guessed at.
      expected_net_profit: legging.final_expected_net_profit,
      required_expected_net_profit: legging.required_expected_net_profit,
      abort_after_fill: legging.abort_after_fill,
      // Hoisted so the attempts list can distinguish a costless refusal from a real round trip
      // without unpacking the legging blob.
      outcome_class: legging.outcome_class ?? null,
      charge_rate_version: this.localCharges.rates.rateVersion,
      filled_leg_count: legging.filled_leg_count,
      failed_legs: legging.failed_legs,
      failure_reason: reason,
      failure_detail: detail,
      legging,
      partial_entry_charges: legging.partial_entry_charges,
      unwind_charges: legging.unwind_charges,
      gross_abort_pnl: grossAbort,
      net_abort_pnl: netAbort,
      // Outstanding contracts the unwind could not flatten. `resolved` false keeps
      // this attempt visible to startup reconciliation until it is flattened.
      residual_exposure: residual.length > 0 ? residual : [],
      resolved: residual.length === 0,
      projection_version: 0,
      residual_projection_identity: residualProjectionIdentity(residual),
      applied_flatten_applications: [],
      flatten_charge_day: null,
      flatten_charges_for_day: 0,
    };
    // Feed the calibration surface BEFORE persistence, so an attempt is observed even if its
    // durable projection fails (the failure is handled separately below).
    this.observeAttempt(legging, false, detectedGrossEdge ?? null);
    const attemptId = await insertBoxExecutionAttempt(attempt);
    if (attemptId) seedObservedFlattenCharges(this.observedFlattenCharges, attemptId, 0);
    if (this.orderManager && this.cfg.executionMode === "live") {
      if (attemptId) this.orderManager.recordRealisedPnl(netAbort ?? 0);
      else this.orderManager.invariantViolation(`live abort ${candidate.key} was not durably projected`);
    }
    if (residual.length > 0) {
      // Track the outstanding exposure so it is never lost, and start the flatten
      // loop. The id lets a later flatten mark this attempt resolved.
      this.registerResidual(
        attemptId ?? `local:${candidate.key}:${Date.now()}`,
        residual,
        0,
        residualProjectionIdentity(residual),
        candidate.underlying,
      );
      console.warn(
        `[Box] ${residual.length} residual execution leg(s) left OUTSTANDING by ${candidate.key} ` +
          `(could not be flattened) — recorded and being worked by the flatten loop.`,
      );
    }

    // SESSION: an entry that ended with NO Box. Counted for visibility only — it consumes no
    // cycle, because burning an operator's single permitted trade on an attempt that left no
    // position would be indefensible.
    void this.session.recordAborted();

    void appendBoxEvent({
      event: "EXECUTION_ABORTED",
      candidate_key: candidate.key,
      underlying: candidate.underlying,
      expiry: candidate.expiry,
      direction,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      execution_mode: this.cfg.executionMode,
      net_pnl: netAbort,
      gross_pnl: grossAbort,
      reason,
      detail: `${detail} — legging net loss ₹${netAbort ?? 0}`,
    });

    console.log(
      `[Box] ${legging.abort_after_fill ? "ABORT AFTER FILL" : "LEGGING ABORT"} ` +
        `${directionLabel(direction)} ${candidate.underlying} ` +
        `${candidate.lower_strike}→${candidate.upper_strike}: ${legging.filled_leg_count}/4 filled, ` +
        `net loss ₹${netAbort ?? 0} (${reason})` +
        (legging.abort_after_fill
          ? ` — executed net ₹${legging.final_expected_net_profit ?? "?"} < required ₹${legging.required_expected_net_profit ?? "?"}`
          : ""),
    );
    this.broadcast("execution_attempt", { attempt });
  }

  private async openPaperTrade(args: {
    candidate: BoxCandidate;
    evaluation: BoxEvaluation;
    entryLegs: BoxChargeLeg[];
    entryChargesTotal: number | null;
    estimatedExitChargesTotal: number | null;
    chargeOrigin: BoxChargesWithOrigin["computed_by"];
    decision: BoxEntryDecision;
    execution: BoxExecutionRecord | null;
    legging?: PaperLeggingExecutionRecord | null;
  }): Promise<string | null> {
    const { candidate, evaluation, decision, execution } = args;
    const candidateViolation = singleLotCandidateViolation(candidate);
    if (candidateViolation) {
      this.orderManager?.invariantViolation(
        `entry ${candidate.key} reached persistence with an invalid single-lot candidate: ${candidateViolation}`,
      );
      return null;
    }
    const confirmedEntryQty = {} as Record<BoxLegRole, number>;
    for (const role of BOX_LEG_ROLES) {
      const confirmed = args.legging?.fills_by_role[role];
      confirmedEntryQty[role] = Number.isSafeInteger(confirmed) && confirmed! >= 0
        ? confirmed!
        : candidate.lot_size;
    }
    const entryFillViolation = args.legging
      ? exactEntryFillViolation(candidate.lot_size, args.legging.fills_by_role)
      : null;
    const entryPositionState = entryFillViolation ? "RECOVERY" as const : "BOX" as const;
    if (entryFillViolation) {
      this.orderManager?.invariantViolation(
        `entry ${candidate.key} did not acquire exactly one lot on every role: ${entryFillViolation}`,
      );
    }
    const direction = candidate.direction ?? "LONG_BOX";
    const byRole = new Map(evaluation.legs.map((l) => [l.role, l]));
    const execByRole = new Map((execution?.legs ?? []).map((l) => [l.role, l]));
    // Total measured entry slippage for the log/ledger — from the latency record
    // or the legging record, whichever produced this fill.
    const entrySlippageForLog = execution?.total_slippage ?? args.legging?.total_entry_slippage ?? 0;

    // The local contract note for the executed fills, and its reversed projection.
    const orders = args.entryLegs.map((l) => ({
      side: l.side,
      tradingsymbol: l.tradingsymbol,
      quantity: l.quantity,
      price: l.price,
    }));
    const localRoundTrip = this.localCharges.roundTrip(orders);

    const legs: IBoxLeg[] = [];
    for (const role of BOX_LEG_ROLES) {
      const ev = byRole.get(role);
      const inst = candidate.legs[role];
      if (!ev || ev.price === null) return null;
      const execLeg = execByRole.get(role);
      legs.push({
        role,
        token: inst.token,
        tradingsymbol: inst.tradingsymbol,
        exchange: inst.exchange,
        strike: inst.strike,
        instrument_type: inst.instrument_type,
        side: entrySideFor(role, direction),
        entry_price: round2(ev.price),
        entry_bid: ev.bid,
        entry_bid_qty: ev.bid_qty,
        entry_ask: ev.ask,
        entry_ask_qty: ev.ask_qty,
        entry_quote_at: ev.quote_at === null ? null : new Date(ev.quote_at),
        entry_depth: ev.depth ?? null,
        detected_price: execLeg?.detected_price ?? null,
        entry_slippage: execLeg?.slippage ?? null,
        exit_price: null,
        exit_bid: null,
        exit_bid_qty: null,
        exit_ask: null,
        exit_ask_qty: null,
        exit_quote_at: null,
        exit_depth: null,
        exit_detected_price: null,
        exit_slippage: null,
      });
    }

    const costPerUnit = evaluation.entry_net_debit_per_unit!;
    // The recorded net edge is the expected NET profit the entry qualified on.
    const recordedNetEdge =
      decision.expected_net_profit ?? round2(evaluation.gross_edge! - this.cfg.safetyBuffer);
    const broker = this.deps.activeBroker();
    const payload: IBoxTrade = {
      execution_mode: this.cfg.executionMode,
      // Stamped at creation and never changed again. Which broker's feed priced
      // these legs, and whose fee schedule costed them, is not recoverable later.
      broker,
      underlying: candidate.underlying,
      name: candidate.name,
      is_index: candidate.is_index,
      expiry: candidate.expiry,
      direction,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      status: "open",
      // A normal entry is exactly one lot on every role. Broker-confirmed
      // overfill/malformed fill truth is preserved but quarantined in RECOVERY.
      remaining_qty_by_role: confirmedEntryQty,
      position_state: entryPositionState,
      exit_attempts: [],
      cumulative_exit_charges: 0,
      legs,
      box_width: candidate.box_width,
      margin: null,
      entry_box_cost: round2(costPerUnit * candidate.lot_size),
      entry_gross_edge: evaluation.gross_edge!,
      entry_charges: localRoundTrip.entry,
      estimated_exit_charges: localRoundTrip.estimated_exit,
      safety_buffer: this.cfg.safetyBuffer,
      entry_net_edge: recordedNetEdge,
      expected_net_profit: decision.expected_net_profit,
      entry_execution_cost: decision.execution_cost,
      charge_origin: args.chargeOrigin ?? "local",
      // Stamp the rate card so this trade stays interpretable after statutory rates
      // change (option STT moved on 1 April 2026).
      charge_rate_version: this.localCharges.rates.rateVersion,
      entry_charge_reconciliation: {
        status: "pending",
        local_total: localRoundTrip.entry_total,
        reconciled_total: null,
        abs_diff: null,
        pct_diff: null,
        at: null,
        error: null,
      },
      exit_charge_reconciliation: null,
      entry_execution: execution,
      entry_legging: args.legging ?? null,
      exit_execution: null,
      opened_at: new Date(),
      current_remaining_edge: evaluation.gross_edge,
      current_captured_edge: 0,
      current_captured_pct: 0,
      exit_box_value: null,
      exit_charges: null,
      gross_pnl: null,
      total_charges: null,
      net_pnl: null,
      closed_at: null,
      exit_reason: null,
      exit_blocked_reason: null,
      expiry_safety: false,
      scanner_config_snapshot: configSnapshot(this.cfg),
      error: entryFillViolation
        ? `single-lot entry invariant: ${entryFillViolation}`
        : null,
    };

    // DURABILITY: the four legs have FILLED, so this box exists. Live execution
    // uses the identity allocated before its first intent, preserving a one-to-one
    // order-intent → trade mapping across crashes and reconciliation.
    const preallocatedId = this.cfg.executionMode === "live" ? args.legging?.trade_id ?? undefined : undefined;
    if (this.cfg.executionMode === "live" && !preallocatedId) {
      this.orderManager?.invariantViolation(`filled live entry ${candidate.key} has no durable trade identity`);
      this.retainOwnedExecution(payload, candidate.key);
      return null;
    }
    // Persist with a bounded synchronous retry; if the store is genuinely
    // unavailable, retain the owned fill and retry in the background.
    let doc: BoxTradeRecord | null;
    try {
      doc = await this.insertWithRetry(payload, preallocatedId);
    } catch (err) {
      this.retainOwnedExecution(payload, candidate.key, preallocatedId);
      console.error(
        `[Box] persistence unavailable for filled box ${candidate.key} — RETAINED for ` +
          `background retry (degraded). ${String(err)}`,
      );
      return null;
    }
    if (!doc) {
      // The unique partial index refused it: this box is already open.
      return null;
    }
    const id = doc._id.toString();

    const entryPrices = {} as Record<BoxLegRole, number>;
    for (const l of legs) entryPrices[l.role] = l.entry_price;

    const position: BoxOpenPosition = {
      id,
      key: candidate.key,
      broker,
      execution_mode: this.cfg.executionMode,
      underlying: candidate.underlying,
      name: candidate.name,
      is_index: candidate.is_index,
      expiry: candidate.expiry,
      direction,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      box_width: candidate.box_width,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      entry_box_cost_per_unit: costPerUnit,
      entry_gross_edge: evaluation.gross_edge!,
      entry_net_edge: recordedNetEdge,
      entry_charges_total: localRoundTrip.entry_total,
      estimated_exit_charges_total: localRoundTrip.estimated_exit_total,
      safety_buffer: this.cfg.safetyBuffer,
      expected_net_profit: decision.expected_net_profit,
      entry_execution_cost: decision.execution_cost,
      charge_origin: args.chargeOrigin ?? "local",
      entry_execution: execution,
      margin: null,
      opened_at: Date.now(),
      legs: candidate.legs,
      entry_prices: entryPrices,
      remaining_qty_by_role: confirmedEntryQty,
      position_state: entryPositionState,
      cumulative_exit_charges: 0,
      exit_attempts: [],
      metrics: null,
      exit_blocked_reason: entryFillViolation
        ? `single-lot entry invariant: ${entryFillViolation}`
        : null,
      expiry_safety: false,
      closing: false,
      last_persist_at: Date.now(),
      config: configSnapshot(this.cfg),
    };
    this.positions.add(position);
    this.syncManagerExposure();

    // SESSION: a cycle is CONSUMED here, and only here.
    //
    // This is the successful-open path: a full four-leg Box now exists as a persisted position. A
    // rejected, partially-filled-then-unwound or economics-aborted entry never reaches this line,
    // which is exactly why such an attempt cannot burn the operator's permitted trade.
    //
    // AWAITED, not fired and forgotten. Whether this write landed decides whether a one-shot budget
    // was spent, so discarding its outcome would let a Mongo hiccup hand the budget back. The store
    // retains the consumption in memory and closes entry when the write fails, so awaiting here
    // costs a round trip and buys the guarantee.
    await this.session.recordEstablished(id);

    // A successfully opened box IS the 4/4 outcome. Observed here so measured outcome rates have a
    // numerator as well as a denominator — previously nothing ever recorded a success, so every
    // rate was permanently zero.
    if (args.legging) this.observeAttempt(args.legging, true, evaluation.gross_edge);

    // EXECUTION FUNNEL (Task 8): a four-leg box opened. Recorded here — not only inside
    // observeAttempt — because an ATOMIC paper open carries no legging record yet is still a
    // genuine completed four-leg entry. observeAttempt's funnel recorder deliberately skips the
    // OPENED class (filledAllFour===true) so this is the SOLE place an open is counted, never twice.
    try {
      this.funnel.recordAdmitted();
      this.funnel.recordSubmitted();
      this.funnel.recordEntryOutcome({ outcome: "OPENED", submitted: true });
    } catch (err) {
      console.warn("[Box] funnel open recording failed (diagnostics only):", err);
    }

    // Margin is captured AFTER the fill is recorded, off the hot path.
    void this.captureMargin(id, candidate.legs, candidate.lot_size, candidate.key, direction);

    // Verify the local entry charges against Zerodha — asynchronously, never
    // blocking the fill and never hammering the API.
    this.reconciler.submit({
      tradeId: id,
      phase: "entry",
      localTotal: localRoundTrip.entry_total,
      legs: args.entryLegs,
      localCharges: localRoundTrip.entry,
      label: `${candidate.underlying} ${candidate.lower_strike}→${candidate.upper_strike} ${direction}`,
    });

    void appendBoxEvent({
      event: "ENTRY",
      trade_id: id,
      candidate_key: candidate.key,
      underlying: candidate.underlying,
      expiry: candidate.expiry,
      direction,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      execution_mode: this.cfg.executionMode,
      box_width: candidate.box_width,
      box_cost: round2(costPerUnit * candidate.lot_size),
      gross_edge: evaluation.gross_edge,
      entry_charges_total: localRoundTrip.entry_total,
      exit_charges_total: localRoundTrip.estimated_exit_total,
      safety_buffer: this.cfg.safetyBuffer,
      net_edge: recordedNetEdge,
      expected_net_profit: decision.expected_net_profit,
      execution_cost: decision.execution_cost,
      execution,
      legs: toEventLegs(evaluation.legs),
      reason: `${this.cfg.executionMode} fill; expected net ₹${decision.expected_net_profit}`,
      detail: `1 lot (${candidate.lot_size} qty), slippage ₹${entrySlippageForLog}`,
    });

    console.log(
      `[Box] ${this.cfg.executionMode.toUpperCase()} ENTRY ${directionLabel(direction)} ${candidate.underlying} ` +
        `${candidate.lower_strike}→${candidate.upper_strike} ${candidate.expiry} ` +
        `gross ₹${evaluation.gross_edge} expected-net ₹${decision.expected_net_profit} ` +
        `(slippage ₹${entrySlippageForLog})`,
    );
    this.broadcast("entry", { trade: serializeBoxTrade(doc) });
    return id;
  }

  /**
   * Durably mirror a PARTIAL exit to Mongo in one atomic update.
   *
   * The caller supplies a projected copy; this persists the exact remaining-per-role
   * state, append-only attempt audit, cumulative charges, and residual before that
   * projection is copied into the authoritative in-memory position.
   */
  private async persistPartialExit(args: {
    position: BoxOpenPosition;
    residual: ResidualLegExposure[];
    legging: PaperLeggingExecutionRecord;
  }): Promise<boolean> {
    const { position, residual, legging } = args;
    const ok = await applyBoxPartialExit(position.id, {
      remaining_qty_by_role: position.remaining_qty_by_role,
      position_state: position.position_state,
      cumulative_exit_charges: position.cumulative_exit_charges,
      exit_attempts: position.exit_attempts,
      residual_exposure: residual.length > 0 ? residual : null,
      exit_legging: legging,
      current_remaining_edge: position.metrics?.remaining_edge ?? null,
    });
    if (ok) {
      void appendBoxEvent({
        event: "EXIT_SKIPPED_LIQUIDITY",
        trade_id: position.id,
        candidate_key: position.key,
        underlying: position.underlying,
        expiry: position.expiry,
        direction: position.direction ?? "LONG_BOX",
        lower_strike: position.lower_strike,
        upper_strike: position.upper_strike,
        lot_size: position.lot_size,
        quantity: position.quantity,
        execution_mode: this.cfg.executionMode,
        reason: "partial_exit",
        detail:
          `partial exit persisted — remaining ` +
          BOX_LEG_ROLES.map((r) => `${r}:${position.remaining_qty_by_role[r]}`).join(" "),
      });
    }
    return ok;
  }

  /** Persist a confirmed exit projection atomically. */
  private async closePaperTrade(args: {
    position: BoxOpenPosition;
    metrics: BoxExitMetrics;
    exitCharges: BoxChargesWithOrigin | null;
    reason: BoxExitReason;
    execution: BoxExecutionRecord | null;
    /** The independent-order exit audit, when the exit used paper_legging. */
    legging?: PaperLeggingExecutionRecord | null;
    /** Residual exposure a partial exit left behind, if any. */
    residual?: ResidualLegExposure[] | null;
    /**
     * CUMULATIVE realised gross across every exit attempt (paper_legging multi-
     * attempt close). When provided it is authoritative — a box closed across
     * several partial attempts cannot be priced from a single final snapshot.
     */
    grossPnlOverride?: number | null;
    /** CUMULATIVE exit charges across every attempt (entry + this = total). */
    exitChargesTotalOverride?: number | null;
    /** The full append-only exit-attempt audit to persist on the closed trade. */
    exitAttempts?: IBoxExitAttempt[] | null;
  }): Promise<boolean> {
    const { position, metrics, exitCharges, reason, execution } = args;
    const byRole = new Map(metrics.legs.map((l) => [l.role, l]));
    const execByRole = new Map((execution?.legs ?? []).map((l) => [l.role, l]));

    const exitChargesTotal =
      args.exitChargesTotalOverride !== undefined && args.exitChargesTotalOverride !== null
        ? round2(args.exitChargesTotalOverride)
        : exitCharges
          ? round2(exitCharges.total)
          : metrics.estimated_exit_charges;
    const totalCharges =
      position.entry_charges_total === null || exitChargesTotal === null
        ? null
        : round2(position.entry_charges_total + exitChargesTotal);
    const grossPnl =
      args.grossPnlOverride !== undefined && args.grossPnlOverride !== null
        ? round2(args.grossPnlOverride)
        : metrics.gross_pnl_if_closed_now;
    const netPnl =
      grossPnl === null || totalCharges === null ? null : round2(grossPnl - totalCharges);

    const closeIdempotencyKey = args.exitAttempts?.at(-1)?.attempt_id ??
      args.legging?.legs[0]?.client_order_id ??
      (execution ? `${position.id}:${execution.mode}:${execution.detected_at}:${execution.executed_at ?? "none"}` : `${position.id}:${reason}:${metrics.at}`);

    // Only the exit half of each leg is written, so the stored entry snapshot
    // (which is an execution record) is never overwritten.
    const setFields: Record<string, unknown> = {
      status: "closed",
      closed_at: new Date(),
      close_idempotency_key: closeIdempotencyKey,
      exit_reason: reason,
      exit_box_value: metrics.exit_box_value,
      exit_charges: exitCharges,
      exit_execution: execution,
      exit_legging: args.legging ?? null,
      residual_exposure: args.residual && args.residual.length > 0 ? args.residual : null,
      // A closed box is flat on every role, and carries its full exit-attempt audit
      // Explicitly persist the terminal geometry; old documents still default to
      // full per-role quantity during adoption when this map is absent.
      remaining_qty_by_role: fullLotByRole(0),
      position_state: "FLAT",
      cumulative_exit_charges: exitChargesTotal,
      ...(args.exitAttempts ? { exit_attempts: args.exitAttempts } : {}),
      exit_charge_reconciliation: exitCharges
        ? {
            status: "pending",
            local_total: round2(exitCharges.total),
            reconciled_total: null,
            abs_diff: null,
            pct_diff: null,
            at: null,
            error: null,
          }
        : null,
      gross_pnl: grossPnl,
      total_charges: totalCharges,
      net_pnl: netPnl,
      // The REALISED net: actual simulated gross from the recorded fills minus
      // actual charges. No expected-slippage allowance — that forward estimate
      // is gone now the real exit price is known (Task 6).
      realised_net_pnl: netPnl,
      current_remaining_edge: metrics.remaining_edge,
      current_captured_edge: metrics.captured_edge,
      current_captured_pct: metrics.captured_pct,
      exit_blocked_reason: null,
    };
    // Track how far the eventual realised net landed from the expected net at
    // entry — the honest measure of the projection's quality.
    if (netPnl !== null && position.expected_net_profit !== null && position.expected_net_profit !== undefined) {
      this.metrics.recordRealisedVsExpected(round2(position.expected_net_profit - netPnl));
    }
    for (const [i, role] of BOX_LEG_ROLES.entries()) {
      const ev = byRole.get(role);
      const execLeg = execByRole.get(role);
      setFields[`legs.${i}.exit_price`] = ev?.price ?? null;
      setFields[`legs.${i}.exit_bid`] = ev?.bid ?? null;
      setFields[`legs.${i}.exit_bid_qty`] = ev?.bid_qty ?? null;
      setFields[`legs.${i}.exit_ask`] = ev?.ask ?? null;
      setFields[`legs.${i}.exit_ask_qty`] = ev?.ask_qty ?? null;
      setFields[`legs.${i}.exit_quote_at`] = ev?.quote_at ? new Date(ev.quote_at) : null;
      setFields[`legs.${i}.exit_depth`] = ev?.depth ?? null;
      setFields[`legs.${i}.exit_detected_price`] = execLeg?.detected_price ?? null;
      setFields[`legs.${i}.exit_slippage`] = execLeg?.slippage ?? null;
    }

    const closed = await closeBoxTrade(position.id, setFields as never, closeIdempotencyKey);
    if (!closed) return false;

    // EXECUTION FUNNEL (Task 8): a box closed cleanly and is durably FLAT. Its realised net P&L
    // (after all charges) is booked here so the funnel's economics reflect completed round trips.
    // A residual left behind means the exposure this trade opened is now resolved.
    try {
      this.funnel.recordCompletedExit(netPnl);
      if (args.residual && args.residual.length > 0) this.funnel.recordUnresolvedExposureResolved();
    } catch (err) {
      console.warn("[Box] funnel exit recording failed (diagnostics only):", err);
    }

    if (this.orderManager && this.cfg.executionMode === "live") {
      this.orderManager.recordRealisedPnl(netPnl ?? 0);
    }
    this.positions.remove(position.id);
    this.syncManagerExposure();
    this.marginBackfillTries.delete(position.id);
    // The position is gone, so its unworkability is no longer a fact about this process.
    this.modeMismatchedPositions.delete(position.id);
    // The Box is FLAT and durably closed, so the underlying-level protection must end. Doing it
    // here rather than letting a TTL lapse is what stops the lock being incorrectly retained
    // after a position is fully flat. `releaseUnderlyingForPosition` is reference-counted, so a
    // second Box on the same underlying keeps its own protection.
    void this.releaseUnderlyingClaim(position.underlying, position.id);
    // SESSION: the cycle is COMPLETE. Recorded only after `closeBoxTrade` returned true, so the
    // trade really is durably closed with every role at zero — the same authority boot
    // reconciliation uses, which is what keeps the two consistent across a restart.
    //
    // Failure here is benign in the safe direction: the cycle stays "in flight", which keeps entry
    // closed and re-arming refused, and boot reconciliation closes it from durable trade state.
    await this.session.recordCompleted(position.id);

    // Fold the realised result into the running day-P&L tally.
    this.rollClosedTodayDay();
    this.closedTodayCount++;
    this.closedTodayNet += netPnl ?? 0;
    this.closedTodayGross += grossPnl ?? 0;
    if (position.margin === null || position.margin === undefined) this.closedTodayMarginUnknown++;
    else this.closedTodayMargin += position.margin;

    const serialized = serializeBoxTrade(closed);
    // Add to today's fast list and mirror it, so the Closed-trades tab shows this
    // trade instantly and keeps showing it across a restart without a full-book
    // Mongo query. The audit blobs are stripped for both: the list never renders
    // them, and holding a session's worth of depth ladders in memory would cost
    // tens of MB for data nothing reads. Fire-and-forget on Redis — the trade is
    // already durably in Mongo, so a cache failure costs only the acceleration.
    const lite = liteClosedTrade(serialized);
    this.recordClosedToday(lite);
    void this.closedCache
      .writeTrade(this.closedTodayDay, lite)
      .catch(() => {/* best-effort accelerator */});

    // Verify the exit charges asynchronously, exactly like the entry.
    if (exitCharges) {
      const exitOrders: BoxChargeLeg[] = metrics.legs
        .filter((l) => l.price !== null && l.price > 0)
        .map((l) => ({
          side: l.side,
          token: l.token,
          expiry: position.expiry,
          tradingsymbol: l.tradingsymbol,
          exchange: position.legs[l.role].exchange,
          quantity: position.quantity,
          price: round2(l.price!),
        }));
      if (exitOrders.length === BOX_LEG_ROLES.length) {
        this.reconciler.submit({
          tradeId: position.id,
          phase: "exit",
          localTotal: round2(exitCharges.total),
          legs: exitOrders,
          localCharges: exitCharges,
          label: `${position.underlying} ${position.lower_strike}→${position.upper_strike}`,
        });
      }
    }

    void appendBoxEvent({
      event: "EXIT",
      trade_id: position.id,
      candidate_key: position.key,
      underlying: position.underlying,
      expiry: position.expiry,
      direction: position.direction ?? "LONG_BOX",
      lower_strike: position.lower_strike,
      upper_strike: position.upper_strike,
      lot_size: position.lot_size,
      quantity: position.quantity,
      execution_mode: this.cfg.executionMode,
      box_width: position.box_width,
      box_cost: round2(position.entry_box_cost_per_unit * position.lot_size),
      gross_edge: position.entry_gross_edge,
      entry_charges_total: position.entry_charges_total,
      exit_charges_total: exitChargesTotal,
      safety_buffer: position.safety_buffer,
      net_edge: position.entry_net_edge,
      gross_pnl: grossPnl,
      net_pnl: netPnl,
      remaining_edge: metrics.remaining_edge,
      captured_edge: metrics.captured_edge,
      captured_pct: metrics.captured_pct,
      execution,
      legs: toEventLegs(metrics.legs),
      reason,
      detail: `${this.cfg.executionMode} exit — ${reason} (slippage ₹${execution?.total_slippage ?? 0})`,
    });

    console.log(
      `[Box] ${this.cfg.executionMode.toUpperCase()} EXIT ${directionLabel(position.direction ?? "LONG_BOX")} ${position.underlying} ` +
        `${position.lower_strike}→${position.upper_strike} ${reason} net ₹${netPnl ?? "?"}`,
    );
    this.broadcast("exit", { trade: serialized });
    this.maybeReleaseFeed();
    return true;
  }

  /**
   * Fetch the net basket margin for the four legs and patch it onto the live
   * position and the stored document.
   *
   * Deliberately off the entry critical path: it runs after the trade exists, so
   * its network latency never delays the fill. Best-effort — a failure just
   * leaves margin null, exactly like the calendar trade.
   */
  private async captureMargin(
    id: string,
    legs: Record<BoxLegRole, BoxOptionInstrument>,
    lotSize: number,
    key: string,
    direction: BoxDirection = "LONG_BOX",
  ): Promise<void> {
    if (this.marginInFlight.has(id)) return;
    this.marginInFlight.add(id);
    // Entry prices, when the position is already in the book — which it is on both
    // callers: entry captures margin only after the fill is recorded, and the backfill
    // sweep works from live positions. Kite derives a MARKET leg's price from the LTP
    // itself, but Dhan's calculator margins against the price it is handed, so passing
    // the real figures is what makes the two brokers' margins comparable.
    const entryPrices = this.positions.get(id)?.entry_prices ?? null;

    // The sides depend on the direction: a short box blocks a different basket
    // margin from a long box on the same strikes.
    const orders = BOX_LEG_ROLES.map((role) => ({
      exchange: legs[role].exchange,
      tradingsymbol: legs[role].tradingsymbol,
      transaction_type: entrySideFor(role, direction),
      variety: "regular",
      product: "NRML",
      order_type: "MARKET",
      quantity: lotSize,
      price: 0,
      reference_price: entryPrices?.[role] ?? null,
    }));

    // Retry a few times: the margin API can transiently 5xx or rate-limit, and a
    // single failure used to leave margin permanently blank. The trade already
    // exists, so this is pure enrichment — retrying is safe.
    const MAX_ATTEMPTS = 4;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await this.deps.margins.basketMargin(orders);
          // Accept whatever the API returns, INCLUDING a small or zero figure: a
          // long box is a hedged position, so a position-aware basket margin can
          // legitimately be low, whichever broker computed it. Only a thrown error (network / auth / rate
          // limit) is a miss worth retrying — a successful small number is real.
          // A null total is UNKNOWN, and an INCOMPLETE figure covers only part of the basket.
          // Neither is a margin for this trade. Throwing routes both into the existing retry /
          // backfill path, which leaves the column NULL — honestly blank — rather than
          // persisting a partial sum that becomes indistinguishable from a real basket margin
          // the moment it is written.
          if (res.total === null || !Number.isFinite(res.total)) {
            throw new Error(`basket margin returned no usable total (source=${res.source})`);
          }
          if (res.complete !== true) {
            throw new Error(
              `basket margin covered only ${res.legs_priced}/${res.legs_requested} legs and is ` +
                `not a basket figure: ${res.incomplete_reason ?? "incomplete"}`,
            );
          }
          const margin = Math.max(0, Math.round(res.total));
          // Say so when the figure is NOT a netted basket number. Only `res.total` is
          // persisted, so once stored an inflated per-leg sum is indistinguishable from
          // a real basket margin — and it is plausible enough to go unnoticed, which is
          // precisely how it went unnoticed before.
          if (res.source === "dhan_per_leg_fallback") {
            console.warn(
              `[Box] margin for ${key} is a PER-LEG SUM (₹${margin}), not a netted basket ` +
                "figure: Dhan's multi-order calculator did not answer, so this OVER-STATES " +
                "a hedged box. See the [Dhan] warning above for the cause.",
            );
          }
          const pos = this.positions.get(id);
          if (pos) pos.margin = margin;
          if (pos) pos.margin_source = res.source;
          // Persist the PROVENANCE with the figure. Without it a dhan_per_leg_fallback
          // upper bound is indistinguishable from a netted basket margin once stored.
          await setBoxTradeMargin(id, margin, res.source);
          if (attempt > 1) {
            console.log(`[Box] margin for ${key} captured on attempt ${attempt}: ₹${margin}`);
          }
          return;
        } catch (err) {
          const last = attempt === MAX_ATTEMPTS;
          console.warn(
            `[Box] basket margin fetch failed for ${key} (attempt ${attempt}/${MAX_ATTEMPTS})${last ? " — will retry later on the backfill sweep" : ", retrying"}:`,
            err instanceof Error ? err.message : err,
          );
          if (last) return;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    } finally {
      this.marginInFlight.delete(id);
    }
  }

  /**
   * Fill in margin for any open position that still lacks it.
   *
   * Covers three cases the entry-time capture misses: a trade adopted from a
   * previous process (opened before margin existed), an entry whose margin call
   * failed every retry, and a session that only came up after entry. Runs on the
   * slow market-watch timer, so it is nowhere near the hot path.
   *
   * BOUNDED per position. The market-watch timer now runs from boot rather than
   * only while scanning, so an unbackfillable position (a delisted leg, say) would
   * otherwise re-attempt its four-try margin call every 15 seconds for the entire
   * life of the process. Margin is enrichment, not a trading input — after a few
   * rounds it is left null and reported as unknown.
   */
  private backfillMissingMargins(): void {
    if (!this.deps.marketData.isAuthenticated()) return;
    for (const pos of this.positions.list()) {
      if (pos.margin !== null) continue;
      if (this.marginInFlight.has(pos.id)) continue;
      const tried = this.marginBackfillTries.get(pos.id) ?? 0;
      if (tried >= BoxEngine.MAX_MARGIN_BACKFILLS) continue;
      this.marginBackfillTries.set(pos.id, tried + 1);
      void this.captureMargin(pos.id, pos.legs, pos.lot_size, pos.key, pos.direction ?? "LONG_BOX");
    }
  }

  /** Manual close from the API. */
  async closeManually(id: string) {
    return this.monitor.closeManually(id);
  }

  /* --------------------------- restart adoption ---------------------------- */

  /** Re-adopt boxes that were open before a restart so they stay managed. */
  private async adoptOpenPositions(): Promise<void> {
    const open = await loadOpenBoxTrades();
    if (open.length === 0) return;
    for (const doc of open) this.adoptDoc(doc);
    console.log(`[Box] adopted ${this.positions.size} open box position(s).`);
  }

  /**
   * Rebuild ONE open position into the in-memory book from its stored document.
   *
   * Shared by restart adoption and by the durable-persistence drain (a box whose
   * insert only succeeded on a later retry is adopted through exactly this path).
   * Returns true when the position was adopted.
   */
  private adoptDoc(doc: BoxTradeRecord): boolean {
    const legs = {} as Record<BoxLegRole, BoxOptionInstrument>;
    const entryPrices = {} as Record<BoxLegRole, number>;
    for (const role of BOX_LEG_ROLES) {
      const l = doc.legs.find((x) => x.role === role);
      if (!l) {
        console.warn("[Box] skipping malformed open trade", doc._id.toString());
        return false;
      }
      legs[role] = {
        token: l.token,
        tradingsymbol: l.tradingsymbol,
        exchange: l.exchange,
        strike: l.strike,
        instrument_type: l.instrument_type,
        expiry: doc.expiry,
        lot_size: doc.lot_size,
      };
      entryPrices[role] = l.entry_price;
    }
    const restoredRemaining = this.remainingByRoleFromDoc(doc);
    const durableRemaining = doc.remaining_qty_by_role ?? fullLotByRole(doc.quantity);
    const positionViolation = singleLotPositionViolation({
      lot_size: doc.lot_size,
      quantity: doc.quantity,
      // Validate the RAW durable map. The conservative restoration fallback must
      // never conceal a missing/non-numeric role and promote corruption to BOX.
      remaining_qty_by_role: durableRemaining,
      legs,
    });
    this.positions.add({
      id: doc._id.toString(),
      key: tradeKey(doc),
      // Read from the DOCUMENT, never from the running config. An adopted position
      // may predate a broker switch or an execution-mode change, and the delete
      // guard and the foreign-exposure guard both depend on the truth of what this
      // position actually is — not on how the process happens to be configured now.
      broker: brokerOf(doc),
      execution_mode: doc.execution_mode,
      underlying: doc.underlying,
      name: doc.name,
      is_index: doc.is_index,
      expiry: doc.expiry,
      // Old documents carry no direction; directionOf() resolves them to LONG_BOX.
      direction: directionOf(doc),
      lower_strike: doc.lower_strike,
      upper_strike: doc.upper_strike,
      box_width: doc.box_width,
      lot_size: doc.lot_size,
      quantity: doc.quantity,
      entry_box_cost_per_unit:
        doc.lot_size > 0 ? doc.entry_box_cost / doc.lot_size : doc.entry_box_cost,
      entry_gross_edge: doc.entry_gross_edge,
      entry_net_edge: doc.entry_net_edge,
      entry_charges_total: doc.entry_charges ? doc.entry_charges.total : null,
      estimated_exit_charges_total: doc.estimated_exit_charges
        ? doc.estimated_exit_charges.total
        : null,
      safety_buffer: doc.safety_buffer,
      expected_net_profit: doc.expected_net_profit ?? null,
      entry_execution_cost: doc.entry_execution_cost ?? null,
      charge_origin: doc.charge_origin ?? "local",
      entry_execution: doc.entry_execution ?? null,
      margin: doc.margin ?? null,
      opened_at: doc.opened_at.getTime(),
      legs,
      entry_prices: entryPrices,
      // Restore EXACT outstanding quantity per role. A document written before
      // per-role state existed has none, so default every role to the full lot —
      // a whole, un-exited box (never destructive). A partially-closed trade
      // therefore resumes with ONLY its true outstanding exposure.
      remaining_qty_by_role: restoredRemaining,
      position_state: positionViolation
        ? "RECOVERY"
        : deriveBoxPositionState(restoredRemaining, doc.position_state ?? "BOX"),
      cumulative_exit_charges: doc.cumulative_exit_charges ?? 0,
      exit_attempts: Array.isArray(doc.exit_attempts) ? doc.exit_attempts : [],
      metrics: null,
      exit_blocked_reason: positionViolation
        ? `single-lot position invariant: ${positionViolation}`
        : doc.exit_blocked_reason,
      expiry_safety: doc.expiry_safety,
      closing: false,
      last_persist_at: Date.now(),
      config: doc.scanner_config_snapshot,
    });
    /*
     * MODE ISOLATION, RECORDED AT ADOPTION.
     *
     * The position is deliberately still ADDED to the book above: the broker-switch guard, the
     * delete guard and the per-broker margin/P&L totals all read that book, and a position hidden
     * from them would be a worse defect than the one this guards. What changes is that a record
     * whose fills are of a different KIND from this process's is now known to be unworkable here,
     * so it can be reported instead of silently exited under the wrong regime. The gateway refuses
     * it again at the submission boundary — see `executionModeMismatch` there.
     */
    const statedDocMode = statedExecutionMode(doc.execution_mode);
    if (statedDocMode !== null && isPaperExecutionMode(statedDocMode) !== isPaperExecutionMode(this.cfg.executionMode)) {
      const detail =
        `Trade ${doc._id.toString()} was opened in ${doc.execution_mode} mode but this process runs ` +
        `${this.cfg.executionMode}. It is monitored and reported, but this process must not exit it: ` +
        (isPaperExecutionMode(this.cfg.executionMode)
          ? "simulating the close would mark it closed while real exposure remained."
          : "sending real orders for it would reduce whatever genuine exposure shares its contracts.");
      this.modeMismatchedPositions.set(doc._id.toString(), detail);
      console.error(`[Box] ADOPTED BUT NOT EXECUTABLE HERE: ${detail}`);
    }
    return true;
  }

  /* ------------------------------ deletion -------------------------------- */

  /**
   * PERMANENTLY delete a PAPER box trade — open, closed or errored — and correct
   * every trade-derived statistic from what actually remains.
   *
   * WHY DELETION IS NOT "CLOSE WITH EXTRA STEPS"
   * A close is a market event: it produces fills, realises P&L and belongs in the
   * day's history. A delete is an ADMINISTRATIVE correction: the trade should never
   * have counted at all. So nothing about it may survive in any statistic, in any
   * of the four places box state lives (in-process memory, Redis, Mongo, and the
   * P&L archive) — and the numbers must be RECOMPUTED, not adjusted.
   *
   * WHY LIVE TRADES ARE REFUSED
   * A live box may have real broker exposure attached. Deleting the record would
   * orphan it: the position would still exist at the broker with nothing in our
   * database pointing at it, so no reconciliation, no monitor and no flatten could
   * ever find it again. An open live trade must be flattened first. A CLOSED live
   * trade is retained too, deliberately — it is the audit record of real money
   * moving, and `deleteBoxTrade`'s query guard refuses both cases.
   *
   * Returns a `{ ok, code, error }` result in the same shape as `closeManually`, so
   * the route surfaces it with `res.status(result.code)` exactly as it already does.
   */
  async deleteTrade(
    id: string,
    opts: { actor: string; reason?: string | null } = { actor: "admin" },
  ): Promise<{ ok: boolean; code: number; error?: string; deleted?: SerializedBoxTrade | null }> {
    if (!isValidBoxId(id)) {
      return { ok: false, code: 400, error: "Invalid trade id." };
    }
    if (!isBoxDbEnabled()) {
      return { ok: false, code: 503, error: "The Box database is not available." };
    }

    // Read first — but ONLY to choose the right status code and to capture the
    // audit fields before they vanish. The delete itself is guarded in its own
    // query, so this read is never load-bearing for the safety decision.
    const doc = await findBoxTradeById(id);
    if (!doc) {
      return { ok: false, code: 404, error: "No such Box trade." };
    }
    const serialized = serializeBoxTrade(doc);

    if (doc.execution_mode === "live") {
      // Distinct messages: an open live position is a live-exposure problem the
      // operator can act on, whereas a closed live trade is a retention decision.
      const message = doc.status === "open"
        ? "Cannot delete an open live trade because broker exposure may still exist. Flatten/close it first."
        : "Closed LIVE trades are retained as the audit record of real executed orders and cannot be deleted.";
      return { ok: false, code: 409, error: message };
    }

    const position = this.positions.get(id);

    // A paper position mid-exit is still refused. `closing` means an exit is in
    // flight and `pendingFinalPersists` may already hold a CONFIRMED fill; deleting
    // underneath that would race the persist and could resurrect the document.
    if (position?.closing) {
      return {
        ok: false,
        code: 409,
        error: "This trade is currently being closed. Wait for the exit to finish, then delete it.",
      };
    }

    // Install the durable archive fence BEFORE the irreversible source delete.
    // If the guarded delete loses its race, remove the unused pending fence.
    await prepareBoxPnlDeletion(id);
    let deletedCount: number;
    try {
      deletedCount = await deleteBoxTrade(id);
    } catch (deleteErr) {
      // A transport error is ambiguous: Mongo may have committed the delete. A
      // source re-read resolves it when possible; otherwise retain the intent and
      // actively retry reconciliation in this process (startup retries too).
      let sourceAfterError: BoxTradeRecord | null;
      try {
        sourceAfterError = await findBoxTradeById(id);
      } catch (resolveErr) {
        this.pnlArchiver.requestDurableReconcile();
        console.warn(`[Box] could not resolve ambiguous deletion of ${id}:`, resolveErr);
        throw deleteErr;
      }
      if (sourceAfterError) {
        await cancelBoxPnlDeletion(id).catch((cancelErr) => {
          console.warn(`[Box] failed to cancel unused P&L deletion fence for ${id}:`, cancelErr);
          this.pnlArchiver.requestDurableReconcile();
        });
        throw deleteErr;
      }
      console.warn(`[Box] deletion of ${id} committed despite an ambiguous response; continuing cleanup.`);
      deletedCount = 1;
    }
    if (deletedCount === 0) {
      await cancelBoxPnlDeletion(id).catch((cancelErr) => {
        console.warn(`[Box] failed to cancel unused P&L deletion fence for ${id}:`, cancelErr);
        this.pnlArchiver.requestDurableReconcile();
      });
      return { ok: false, code: 409, error: "The trade could not be deleted." };
    }

    await this.pnlArchiver.withTradeDeletion(id, async () => {
      /* ---- 1. in-memory position book, and everything keyed off it ---- */
      if (position) {
        this.positions.remove(id);          // also frees the byKey / reserved entry
        this.modeMismatchedPositions.delete(id);
        this.syncManagerExposure();         // exposure counts the manager enforces
        // The record is being destroyed, so nothing could ever release the claim later.
        void this.releaseUnderlyingClaim(position.underlying, id);
        this.marginBackfillTries.delete(id);
        this.marginInFlight.delete(id);
        const wasHeld = this.monitor.forgetPosition(id);
        if (wasHeld) {
          console.warn(`[Box] deletion of ${id} interrupted in-flight monitor work for that trade.`);
        }
        if (!this.running) this.shrinkToOpenPositions();
        else this.maybeReleaseFeed();
      }

      /* ---- 2. Redis mirrors (membership is checked before invalidation) ---- */
      const day = this.deps.istDayKey();
      await this.closedCache.evictTrade(day, id).catch(() => false);
      const pnlEviction = await this.pnlCache.evictTradeEverywhere(id).catch(() => ({
        days: [],
        attempted_days: 0,
        completed: false,
      }));

      /* ---- 3. durable archive cleanup; failures remain pending for restart ---- */
      await deleteBoxDailyPnlForTrade(id, pnlEviction.days).catch((err) => {
        console.warn(
          `[Box] box_daily_pnl cleanup for deleted trade ${id} is pending durable retry:`,
          err,
        );
        this.pnlArchiver.requestDurableReconcile();
      });
    });

    /* ---- 4. RECOMPUTE every trade-derived figure from what remains ---- */
    await this.recomputeTradeDerivedStatistics();

    /* ---- 5. audit, then tell every browser ---- */
    void appendBoxEvent({
      event: "TRADE_DELETED",
      trade_id: id,
      candidate_key: tradeKey(doc),
      underlying: doc.underlying,
      expiry: doc.expiry,
      direction: directionOf(doc),
      broker: brokerOf(doc),
      lower_strike: doc.lower_strike,
      upper_strike: doc.upper_strike,
      lot_size: doc.lot_size,
      quantity: doc.quantity,
      execution_mode: doc.execution_mode,
      box_width: doc.box_width,
      gross_pnl: doc.gross_pnl,
      net_pnl: doc.net_pnl,
      reason: `deleted_by:${opts.actor}`,
      detail:
        `status_before=${doc.status} mode=${doc.execution_mode} broker=${brokerOf(doc)} ` +
        `opened_at=${doc.opened_at.toISOString()} ` +
        `closed_at=${doc.closed_at ? doc.closed_at.toISOString() : "null"} ` +
        `deleted_at=${new Date().toISOString()}` +
        (opts.reason ? ` reason=${opts.reason}` : ""),
    });

    console.log(
      `[Box] TRADE DELETED ${id} (${doc.underlying} ${directionLabel(directionOf(doc))}, ` +
        `${doc.status}, ${doc.execution_mode}, ${brokerOf(doc)}) by ${opts.actor}.`,
    );

    this.broadcast("trade_deleted", { id, trade: serialized });
    // A full snapshot immediately after, so every open tab shows the corrected
    // counts, P&L and margin without waiting for the next publish tick or a reload.
    this.publish();

    return { ok: true, code: 200, deleted: serialized };
  }

  /**
   * Rebuild every trade-derived statistic from the surviving records.
   *
   * RECOMPUTED, NEVER ADJUSTED. Subtracting a deleted trade's fields from the
   * running tallies is wrong in at least three ways, and the peak is the clearest
   * case: `peak -= deleted.margin` is simply not what a maximum is. If the deleted
   * trade set the previous high-water mark, the true peak is whatever the highest
   * remaining OVERLAP is — which can only be found by replaying the intervals.
   *
   * The open side needs no work: `computeDayPnl()` derives it from the position
   * book on every read, so removing the position already corrected it.
   */
  private async recomputeTradeDerivedStatistics(): Promise<void> {
    // Closed-today tallies and the fast list: re-read the day from Mongo rather
    // than decrementing counters. This is the same query the boot seed uses, so
    // there is exactly one definition of "today's closed set" in the engine.
    await this.refreshClosedTodayFromDb().catch((err) =>
      console.warn("[Box] closed-today recompute after deletion failed:", err),
    );
    await this.recomputePeakConcurrentMargin();
  }

  /**
   * Recompute peak concurrent margin by REPLAYING the surviving trade intervals.
   *
   * Each trade blocks its margin over [opened_at, closed_at) — or to now while it
   * is still open. The peak concurrent figure is the largest sum of margins whose
   * intervals overlap at a single instant. That maximum can only occur at an
   * interval START (adding exposure is the only thing that can raise the sum), so
   * sweeping the start points is exact rather than sampled.
   *
   * Trades with an unknown (null) margin are EXCLUDED, never counted as zero —
   * consistent with `computeDayPnl`, which reports them separately. Including them
   * as zero would understate the peak and quietly present a guess as a measurement.
   *
   * This replaces the process-lifetime sampled high-water mark for the day being
   * recomputed: after a deletion the sampled value may reflect a trade that no
   * longer exists, and an honest recomputation is strictly better than a stale
   * observation.
   */
  private async recomputePeakConcurrentMargin(): Promise<void> {
    try {
      const dayStart = istDayStartMs(this.deps.istDayKey());
      const rows = await loadBoxMarginIntervalsSince(dayStart);
      const now = Date.now();
      // The arithmetic itself lives in the pure marginReplay module so it can be
      // unit-tested offline; this method only supplies the data.
      const intervals = usableMarginIntervals(
        rows.map((r) => ({
          from: r.opened_at.getTime(),
          to: r.closed_at ? r.closed_at.getTime() : now,
          margin: r.margin,
        })),
      );
      this.peakConcurrentMargin = peakConcurrentMargin(intervals);
    } catch (err) {
      console.warn("[Box] peak-concurrent-margin replay failed:", err);
    }
  }

  /**
   * Restore the stored quantities without normalising broker truth. Numeric
   * overfills, fractions, or negatives are retained verbatim and the shared
   * invariant moves the position to RECOVERY. A missing/non-numeric role falls
   * back conservatively to the document quantity, also causing RECOVERY when the
   * document is not an exact one-lot position.
   */
  private remainingByRoleFromDoc(doc: BoxTradeRecord): Record<BoxLegRole, number> {
    const stored = doc.remaining_qty_by_role ?? null;
    const out = {} as Record<BoxLegRole, number>;
    for (const role of BOX_LEG_ROLES) {
      const raw = stored === null ? doc.quantity : stored[role];
      out[role] = typeof raw === "number" ? raw : doc.quantity;
    }
    return out;
  }

  /* ----------------------- execution durability --------------------------- */

  /**
   * Insert an open box, retrying a THROWN (transient) failure a bounded number of
   * times with linear backoff. A duplicate-key is not an error — it means the box
   * is already open — so it returns null immediately without retrying. Runs off
   * the hot scanner path (openPaperTrade is already awaited outside the tick loop).
   */
  private async insertWithRetry(payload: IBoxTrade, preallocatedId?: string): Promise<BoxTradeRecord | null> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= BoxEngine.PERSIST_RETRY_ATTEMPTS; attempt++) {
      try {
        return await insertBoxTrade(payload, preallocatedId);
      } catch (err) {
        lastErr = err;
        if (attempt < BoxEngine.PERSIST_RETRY_ATTEMPTS) {
          await new Promise((r) => {
            const t = setTimeout(r, attempt * 250);
            (t as { unref?: () => void }).unref?.();
          });
        }
      }
    }
    throw lastErr;
  }

  /**
   * Retain a filled box whose insert has failed after the bounded retries.
   *
   * The exposure is REAL, so it must never be forgotten. It is queued and a slow,
   * bounded background timer keeps re-attempting the insert; once it succeeds the
   * position is adopted into the live book and managed normally. Until then the
   * engine reports `degraded`.
   */
  private retainOwnedExecution(payload: IBoxTrade, key: string, preallocatedId?: string): void {
    this.pendingPersists.push({
      payload,
      key,
      attempts: BoxEngine.PERSIST_RETRY_ATTEMPTS,
      ...(preallocatedId ? { preallocatedId } : {}),
    });
    this.metrics.setPendingUnpersistedFills(this.pendingPersists.length);
    // Hold the strike-pair reservation so no new tick can open a DUPLICATE box for
    // this key while the fill is unpersisted (the Mongo unique index cannot help
    // yet — nothing is persisted). The scanner releases the reservation right after
    // openPaperTrade returns null, so re-claim it on the next microtask. It is
    // cleared when the box is finally persisted (positions.add) or found duplicate.
    queueMicrotask(() => {
      if (!this.positions.getByKey(key)) this.positions.reserve(key);
    });
    if (!this.ownedRetryTimer) {
      this.ownedRetryTimer = setInterval(() => void this.drainOwnedExecutions(), BoxEngine.OWNED_RETRY_MS);
      this.ownedRetryTimer.unref?.();
    }
  }

  /** Retry every retained owned box; adopt each one that finally persists. */
  private async drainOwnedExecutions(): Promise<void> {
    if (this.pendingPersists.length === 0) {
      if (this.ownedRetryTimer) {
        clearInterval(this.ownedRetryTimer);
        this.ownedRetryTimer = null;
      }
      return;
    }
    const still: { payload: IBoxTrade; key: string; attempts: number; preallocatedId?: string }[] = [];
    for (const entry of this.pendingPersists) {
      try {
        const doc = await insertBoxTrade(entry.payload, entry.preallocatedId);
        if (doc) {
          // adoptDoc → positions.add clears the held reservation as it takes over.
          this.adoptDoc(doc);
          this.ensureFeed();
          console.log(`[Box] recovered a retained filled box into the live book (${doc._id.toString()}).`);
        } else {
          // Duplicate-key: the box is already open, so the retained copy is
          // redundant. Release the reservation we were holding and drop it.
          this.positions.release(entry.key);
        }
      } catch {
        entry.attempts++;
        still.push(entry);
      }
    }
    this.pendingPersists = still;
    this.metrics.setPendingUnpersistedFills(this.pendingPersists.length);
    if (this.pendingPersists.length === 0 && this.ownedRetryTimer) {
      clearInterval(this.ownedRetryTimer);
      this.ownedRetryTimer = null;
    }
  }

  /* --------------------- residual-exposure reconciliation ------------------ */

  /**
   * On startup, load execution attempts that still hold residual exposure and
   * register it, so an interrupted unwind is resumed whether or not RUN is pressed.
   *
   * This does NOT depend on the scanner: outstanding simulated contracts are the
   * engine's responsibility to keep flattening while the market is open and the
   * feed is healthy, exactly like an open position.
   */
  private async reconcileResidualExposure(): Promise<void> {
    let attempts: Awaited<ReturnType<typeof loadUnresolvedBoxExecutionAttempts>>;
    try {
      attempts = await loadUnresolvedBoxExecutionAttempts();
    } catch (err) {
      /*
       * RESIDUAL STATE IS UNKNOWN, WHICH IS NOT THE SAME AS EMPTY.
       *
       * The loader used to swallow this and answer `[]`, so boot proceeded believing there was no
       * outstanding exposure. Recorded rather than rethrown because a read failure must NOT stop the
       * exposure this process already owns from being reduced — it only makes taking NEW exposure
       * unsafe, because we cannot know what is already on.
       */
      this.residualRecoveryLoadError = err instanceof Error ? err.message : String(err);
      this.ensureResidualRecoveryRetry();
      console.error(
        `[Box] residual exposure could not be READ (${this.residualRecoveryLoadError}) — entry is ` +
          `refused until it is known; already-owned risk reduction continues.`,
      );
      return;
    }
    // A successful read is the only thing that clears the blocker.
    this.residualRecoveryLoadError = null;
    let total = 0;
    for (const a of attempts) {
      const residual = (a.residual_exposure ?? []) as ResidualLegExposure[];
      if (!Array.isArray(residual) || residual.length === 0) continue;
      const attemptId = a._id.toString();
      // The boot daily-risk seed includes this cumulative total. Record the same baseline before
      // the watchdog can observe an acknowledgement, otherwise it would debit historical charges
      // a second time in this process.
      seedObservedFlattenCharges(this.observedFlattenCharges, attemptId, a.flatten_charges);
      seedObservedFlattenChargesForDay(
        this.observedFlattenChargesByDay,
        attemptId,
        a.flatten_charge_day,
        a.flatten_charges_for_day,
      );
      this.registerResidual(
        attemptId,
        residual,
        Number.isSafeInteger(a.projection_version) && (a.projection_version ?? -1) >= 0
          ? a.projection_version!
          : 0,
        a.residual_projection_identity ?? residualProjectionIdentity(residual),
        // Read off the durable row, so the underlying lock blocks this symbol again after a
        // restart exactly as it did before one.
        a.underlying,
        // OWNERSHIP FROM THE ROW, never from this process's config. The row states the mode and
        // broker the exposure was actually created under; that is precisely what decides whether this
        // process may trade against it.
        { mode: a.execution_mode, broker: brokerOf(a) },
      );
      total += residual.length;
    }
    if (total > 0) {
      console.warn(
        `[Box] ${total} residual simulated leg(s) across ${this.residualByAttempt.size} attempt(s) ` +
          `were outstanding at boot — the flatten loop will work them when the feed is healthy.`,
      );
    }
  }

  /**
   * The ENTRY-ONLY gate the coordinator enforces: the armed session's verdict, plus the requirement
   * that outstanding residual exposure is actually KNOWN.
   *
   * Hooked here rather than into a new mechanism because this gate is already, by construction,
   * consulted on the entry path only — every protective path (exit, cancel, residual flatten,
   * reconciliation-driven reduction) bypasses it. That is exactly the asymmetry an unknown residual
   * picture needs: it must stop new exposure without ever stopping reduction.
   *
   * The coordinator maps this layer onto the single `session_limit_reached` failure reason and passes
   * our `reason`/`detail` through verbatim, precisely so a database blip is not reported to an operator
   * as "out of budget" — so the distinct reason code survives.
   */
  private entryGateVerdict(): { allowed: boolean; reason: string | null; detail: string | null } {
    if (this.residualRecoveryLoadError !== null) {
      return {
        allowed: false,
        reason: "residual_state_unknown",
        detail:
          `Outstanding residual exposure could not be read (${this.residualRecoveryLoadError}), so how ` +
          `much exposure is already on is unknown. Unknown is not none: no new box is opened until the ` +
          `read succeeds. Reduction of known exposure is unaffected.`,
      };
    }
    return this.session.evaluateEntry(this.recoveryActive());
  }

  /* ------------------------------ account funds ------------------------------ */

  /**
   * The published free-capital snapshot.
   *
   * Answers "not supported" and "no session" distinctly from "unknown", because an operator staring
   * at a blank needs to know whether to log in, wait, or stop expecting a number at all.
   */
  private accountFundsSnapshot(): AccountFundsSnapshot {
    if (!this.cfg.accountFundsEnabled) {
      return unavailableFunds(
        "not_supported",
        "Account-funds polling is disabled (BOX_ACCOUNT_FUNDS_ENABLED=false), so free capital is not " +
          "being read. This is NOT a zero balance.",
        this.deps.activeBroker(),
      );
    }
    return this.accountFunds.snapshot({
      sessionReady: this.deps.marketData.isAuthenticated(),
      supported: typeof this.deps.marketData.getFunds === "function",
    });
  }

  /**
   * Read the balance once, recording either the figure or the failure.
   *
   * NEVER THROWS. A funds read is a diagnostic: if it could throw into a timer it would become an
   * unhandled rejection, and if it could throw into the status path it would take down the whole
   * status response for a number that is merely informational.
   *
   * Skipped entirely when no session exists, so a logged-out deployment does not generate a failed
   * read every cycle and then report "read_failed" when the honest answer is "no session".
   */
  private async refreshAccountFunds(): Promise<void> {
    if (!this.cfg.accountFundsEnabled) return;
    const read = this.deps.marketData.getFunds;
    if (typeof read !== "function") return;
    if (!this.deps.marketData.isAuthenticated()) return;
    // One at a time. Without this a broker slower than the interval would queue reads indefinitely,
    // and each would then be charged against the same rate limit the market feed depends on.
    if (this.fundsRefreshInFlight) return;
    this.fundsRefreshInFlight = true;
    try {
      const funds = await read.call(this.deps.marketData);
      this.accountFunds.record(this.deps.activeBroker(), {
        availableRupees: funds.available,
        utilisedRupees: funds.utilised,
        // The full vendor breakdown, so the published headline can be checked against the broker's
        // own funds screen component by component rather than taken on trust.
        components: funds.components ?? null,
      });
    } catch (error) {
      // The PREVIOUS figure is kept and marked stale by the tracker — an operator mid-session is
      // better served by "₹47,000 as of 40s ago, refresh failing" than by a blank.
      this.accountFunds.recordFailure(
        error instanceof Error ? error.message : String(error),
        this.deps.activeBroker(),
      );
    } finally {
      this.fundsRefreshInFlight = false;
    }
  }

  /** Start the balance poller. Idempotent. */
  private ensureAccountFundsTimer(): void {
    if (!this.cfg.accountFundsEnabled) return;
    if (this.fundsTimer !== null) return;
    if (typeof this.deps.marketData.getFunds !== "function") return;
    void this.refreshAccountFunds();
    this.fundsTimer = setInterval(() => {
      void this.refreshAccountFunds();
    }, this.cfg.accountFundsRefreshMs);
    // Never hold the process open for a diagnostic poll.
    if (typeof this.fundsTimer.unref === "function") this.fundsTimer.unref();
  }

  /* --------------------------- durable boot ordinal --------------------------- */

  /**
   * Keep trying to claim the durable boot ordinal until it settles. Idempotent.
   *
   * WHY A RETRY EXISTS AT ALL. `resolveBootOrdinal()` deliberately does not mark itself resolved on a
   * transient failure, with the comment "a later attempt may succeed once the database is reachable,
   * and this process should stop being unorderable as soon as it can". Nothing performed that later
   * attempt: there was one fire-and-forget call site, so a single blip while claiming left the process
   * permanently unorderable — refusing all new entry for its whole life, with only a restart to clear
   * it, which is the opposite of what the comment promised.
   *
   * Stops on EITHER outcome, so it cannot hammer the database over a condition retrying cannot fix:
   * success, or `permanentlyUnavailable()` (migration 009 absent, or an unusable row).
   */
  private ensureBootOrdinalClaim(): void {
    if (this.disposed) return;
    if (this.backendInstance.hasOrdinal() || this.backendInstance.permanentlyUnavailable()) return;
    // Attempt now; the timer only covers the case where this one fails.
    void this.claimBootOrdinalOnce();
    if (this.bootOrdinalTimer !== null) return;
    this.bootOrdinalTimer = setInterval(() => {
      void this.claimBootOrdinalOnce();
    }, BOOT_ORDINAL_RETRY_MS);
    // Never hold the process open for a recovery poll.
    if (typeof this.bootOrdinalTimer.unref === "function") this.bootOrdinalTimer.unref();
  }

  /** One attempt, stopping the retry as soon as the outcome is settled either way. */
  private async claimBootOrdinalOnce(): Promise<void> {
    if (this.disposed) {
      this.stopBootOrdinalClaim();
      return;
    }
    // Never throws, by contract — it is a recovery poll and must not become an unhandled rejection.
    await this.backendInstance.resolveBootOrdinal();
    if (this.backendInstance.hasOrdinal() || this.backendInstance.permanentlyUnavailable()) {
      this.stopBootOrdinalClaim();
    }
  }

  /** Stop the claim retry. Called when it settles and on shutdown. */
  private stopBootOrdinalClaim(): void {
    if (this.bootOrdinalTimer !== null) {
      clearInterval(this.bootOrdinalTimer);
      this.bootOrdinalTimer = null;
    }
  }

  /** Stop the poller and forget the figure. Called on shutdown and on a broker switch. */
  private stopAccountFundsTimer(forget: boolean): void {
    if (this.fundsTimer !== null) {
      clearInterval(this.fundsTimer);
      this.fundsTimer = null;
    }
    // One broker's balance is not another's, so a switch must not leave the outgoing account's
    // number on screen under the incoming account's name.
    if (forget) this.accountFunds.reset();
  }

  /**
   * COMMITTED BOX EXPOSURE this engine already holds, for `BOX_MAX_OPEN_BOXES`.
   *
   * Deliberately NOT just `positions.size`. Three kinds of thing are capital at risk:
   *
   *   - an OPEN position — the obvious one;
   *   - an unresolved RESIDUAL attempt — a partial entry that never became a Box. Counted per
   *     ATTEMPT rather than per leg, because one failed four-leg entry is one box's worth of
   *     exposure, not four;
   *   - a fill that is CONFIRMED but not yet recorded ({@link pendingEstablishments}). See below.
   *
   * A ceiling that counted only established positions would happily admit a second Box on top of a
   * half-filled first one — which is the exact situation an operator who "cannot afford two" most
   * needs refused.
   *
   * WHY UNRESOLVED ORDER INTENTS ARE **NOT** COUNTED HERE, having been in the first draft.
   *
   * Two reasons, both concrete. (1) Reading them requires `orderManager.status()`, and `status()`
   * calls `rollTradingDay()` — a MUTATION that resets the daily risk counters and can kick off an
   * async seed load. This method is read inside the coordinator's no-await prologue on every entry
   * admission, and the codebase has already paid once for putting `rollTradingDay()` on a guard path
   * (see the comment in `exposureReductionBlockReason`). (2) It double-counted: an orphaned order
   * belonging to an OPEN position resolves to that position's underlying, so the same box was counted
   * twice — once here and once in `positions.size`.
   *
   * Nothing is lost by omitting them. An unknown order is not merely *counted* against entry, it
   * REFUSES entry outright: `BoxOrderManager.entryBlockReason` blocks while `unknownOrders > 0`, and
   * the readiness surface raises `reconciliation_incomplete` (scope `entry`). Both are strictly
   * stronger than occupying an inventory slot. In paper there is no order manager and so no orphan
   * concept at all.
   *
   * Synchronous, allocation-free and side-effect-free — which is what the prologue requires.
   */
  private boxInventoryCount(): number {
    return this.positions.size + this.residualByAttempt.size + this.pendingEstablishments;
  }

  /**
   * BROKER EXPOSURE THAT NO RECORD OWNS — the ONE derivation behind BOTH the operator's
   * `unowned_attributed_exposure` readiness blocker AND the coordinator's entry-admission refusal.
   *
   * WHY THIS IS ONE FUNCTION AND MUST STAY ONE. It previously existed only as an inline block inside
   * the readiness builder, so the verdict an operator read and the rule the engine enforced were not
   * merely separate implementations — the second one did not exist. Readiness reported the condition
   * accurately while `coordinateEntry` admitted new boxes straight past it. Deriving it twice would
   * re-open exactly that gap in a subtler form: the banner and the gate could disagree about whether
   * a given leg is owned, and the operator would be told one thing while the engine did another.
   *
   * WHAT MAKES IT INVISIBLE TO EVERY OTHER GATE. `projectedSymbols` is built from the durable
   * position book, and the defining property of this exposure is that the book has NO row for it —
   * the position write is precisely what failed. So:
   *
   *   `boxInventoryCount()`            counts positions/residuals/establishments → does not see it.
   *   Layer 1a (`activeUnderlyings`)   keyed on the same book, per-underlying → does not see it, and
   *                                    would not stop a candidate on a DIFFERENT underlying anyway.
   *   `BOX_LIVE_MAX_OPEN_BOXES`        a manager count refreshed from the book → does not see it.
   *
   * That is why this needs its own gate rather than a term added to one of theirs.
   *
   * THE CRASH-ONLY FILTER IS THE ORDER MANAGER'S. `attributedRecoveryExposure()` returns only legs
   * reconstructed from the durable intent journal and confirmed against the broker — the same set
   * `flattenAttributedBoxExposure` acts on. So what is reported, what is enforced, and what the
   * emergency control would flatten are guaranteed to be the same legs; an operator who clears the
   * blocker has necessarily cleared the gate.
   *
   * PAPER IS EXEMPT BY CONSTRUCTION, not by a mode check: there is no `orderManager` in paper, hence
   * no attributed broker exposure and nothing to own.
   *
   * Synchronous, side-effect-free and allocation-bounded — the coordinator's no-await prologue
   * requires all three.
   */
  private unownedAttributedExposure(): ReadinessBlocker | null {
    if (!this.orderManager) return null;
    const projectedSymbols = new Set<string>();
    for (const position of this.positions.list()) {
      for (const role of BOX_LEG_ROLES) {
        const instrument = position.legs[role];
        projectedSymbols.add(`${instrument.exchange}:${instrument.tradingsymbol}`);
      }
    }
    return unownedAttributedExposureBlocker({
      attributed: this.orderManager.attributedRecoveryExposure(),
      projectedSymbols,
    });
  }

  /** How many residual legs are still outstanding across all attempts. */
  private residualLegCount(): number {
    let n = 0;
    for (const legs of this.residualByAttempt.values()) n += legs.length;
    return n;
  }

  /**
   * The oldest `created_at` across all outstanding residual legs, or null when there are none.
   *
   * This is the DURABLE unresolved-since instant: `created_at` is written when the residual is
   * recorded and deliberately preserved when a shrunken residual is written back, so it is neither
   * reset by a partial flatten nor by a restart that reloads the same residual. That is what lets the
   * recovery-escalation age survive a restart instead of quietly starting from zero.
   *
   * Wall clock, matching the stamp's own domain — comparing it against a monotonic reading would be
   * meaningless.
   */
  private oldestResidualCreatedAtWall(): number | null {
    let oldest: number | null = null;
    for (const legs of this.residualByAttempt.values()) {
      for (const leg of legs) {
        if (!Number.isFinite(leg.created_at)) continue;
        if (oldest === null || leg.created_at < oldest) oldest = leg.created_at;
      }
    }
    return oldest;
  }

  /**
   * Every instrument token that OUTSTANDING RESIDUAL EXPOSURE needs a live book for.
   *
   * WHY THIS EXISTS. Residual legs are real (or really simulated) exposure that no ordinary open
   * position represents: an incomplete entry can leave them behind without ever creating a box. Every
   * subscription decision used to be computed from `positions.tokens()` alone, so a residual-only book
   * was invisible to all of them — STOP, the boot universe pass, a universe refresh and the SSE
   * disposer would each drop the very instruments the flatten loop needs to price its own unwind, and
   * `applySubscriptions` would additionally `quotes.forget()` them. The flatten loop then could not
   * act, silently, for as long as the process lived.
   *
   * `token` is present on every {@link ResidualLegExposure}, so this needs no lookup and cannot fail.
   */
  private residualTokens(): Set<number> {
    const out = new Set<number>();
    for (const legs of this.residualByAttempt.values()) {
      for (const leg of legs) out.add(leg.token);
    }
    return out;
  }

  /**
   * The underlyings that outstanding residual exposure belongs to.
   *
   * Kept alongside {@link residualTokens} because a window (and therefore a spot subscription) is
   * placed per underlying, not per contract. Deliberately NOT the primary mechanism: the boot
   * recovery call site historically registered residuals without an underlying, so an
   * underlying-only fix would miss exactly the crash-recovery case that matters most. Tokens are
   * authoritative; this only widens the window/spot keep-set.
   */
  private residualUnderlyings(): Set<string> {
    const out = new Set<string>();
    for (const [attemptId, symbol] of this.residualUnderlyingByAttempt) {
      if (this.residualByAttempt.has(attemptId)) out.add(symbol);
    }
    return out;
  }

  /**
   * Why this process must not FLATTEN this residual attempt, or null when it may.
   *
   * The paper/live boundary only — `paper_touch` and `paper_latency` are interchangeable, so exact
   * equality would refuse work this process is perfectly entitled to do. Broker is compared too:
   * Dhan and Zerodha order ids are unrelated identifier spaces, so "flattening" a Dhan residual
   * through Zerodha either 404s or collides with an unrelated real order.
   *
   * An attempt with no recorded ownership is treated as THIS process's, which preserves the previous
   * behaviour exactly for anything registered before this map existed.
   */
  private residualOwnershipMismatch(attemptId: string): string | null {
    const owner = this.residualOwnershipByAttempt.get(attemptId);
    if (!owner) return null;
    // NO CLAIM ⇒ NO REFUSAL, for the same reason as the gateway's position check: a durable row that
    // does not state its mode cannot contradict this process, and refusing to flatten on the strength
    // of missing data would leave exposure on. See `statedExecutionMode`.
    const stated = statedExecutionMode(owner.mode);
    if (stated !== null && isPaperExecutionMode(stated) !== isPaperExecutionMode(this.cfg.executionMode)) {
      return (
        `residual ${attemptId} was created in ${owner.mode} mode but this process runs ` +
        `${this.cfg.executionMode}` +
        (isPaperExecutionMode(this.cfg.executionMode)
          ? " — refusing to SIMULATE flattening real broker exposure"
          : " — refusing to send REAL orders for simulated exposure")
      );
    }
    const active = this.deps.activeBroker();
    if (owner.broker !== active) {
      return (
        `residual ${attemptId} belongs to ${owner.broker} but ${active} is active — order-id spaces ` +
        `are unrelated, so it must be flattened by its own broker`
      );
    }
    return null;
  }

  /** Residual attempts this process is holding but must not act on, with the reason. */
  private residualOwnershipMismatches(): { attemptId: string; reason: string }[] {
    const out: { attemptId: string; reason: string }[] = [];
    for (const attemptId of this.residualByAttempt.keys()) {
      const reason = this.residualOwnershipMismatch(attemptId);
      if (reason !== null) out.push({ attemptId, reason });
    }
    return out;
  }

  /**
   * Add residual legs to the CURRENT subscription set without disturbing anything else.
   *
   * `registerResidual` retained the feed but never asked for the instruments — it held a transport
   * with nothing on it. This closes that asymmetry at the moment exposure is registered, which is the
   * only point at which the engine learns the tokens exist. Additive on purpose: `applySubscriptions`
   * has REPLACE semantics, so it is handed the existing set plus the residual tokens rather than a
   * freshly computed universe, which this method has no business recomputing.
   */
  private ensureResidualSubscriptions(): void {
    const residual = this.residualTokens();
    if (residual.size === 0) return;
    let missing = false;
    for (const token of residual) {
      if (!this.subscribedOptionTokens.has(token)) {
        missing = true;
        break;
      }
    }
    if (!missing) return;
    const wantOption = new Set<number>(this.subscribedOptionTokens);
    for (const token of residual) wantOption.add(token);
    this.applySubscriptions(wantOption, new Set<number>(this.subscribedSpotTokens));
  }

  /**
   * Attempt ids whose per-attempt risk bookkeeping must survive compaction.
   *
   * An attempt is retained while this process can still emit a projection for it — exposure the
   * flatten loop is still working, or an immutable command whose durable acknowledgement was lost
   * and will be retried. `extra` carries the authoritative unresolved set of a daily-risk seed,
   * which is a superset in the healthy case and deliberately not assumed to be one: a row that
   * resolved between the two reads must not lose the watermark that keeps its late acknowledgement
   * idempotent.
   */
  private retainedRiskAttemptIds(extra?: Iterable<string>): Set<string> {
    const retained = new Set<string>(this.residualByAttempt.keys());
    for (const attemptId of this.pendingResidualPersists.keys()) retained.add(attemptId);
    if (extra) for (const attemptId of extra) retained.add(attemptId);
    return retained;
  }

  /** Bounded per-attempt risk bookkeeping sizes. A diagnostics seam, never a control input. */
  private riskBookkeepingDiagnostics(): {
    observed_charge_attempts: number;
    observed_charge_day_buckets: number;
    projection_versions: number;
    projection_identities: number;
    pending_projection_acknowledgements: number;
  } {
    return {
      observed_charge_attempts: this.observedFlattenCharges.size,
      observed_charge_day_buckets: this.observedFlattenChargesByDay.size,
      projection_versions: this.residualProjectionVersion.size,
      projection_identities: this.residualProjectionIdentity.size,
      pending_projection_acknowledgements: this.pendingResidualPersists.size,
    };
  }

  /**
   * Register outstanding residual exposure and make sure the flatten loop runs.
   *
   * `underlying` is recorded so the underlying-level entry lock can see that this symbol still
   * carries unresolved exposure. It is optional only so a legacy caller keeps compiling; both
   * production call sites supply it.
   */
  private registerResidual(
    attemptId: string,
    residual: ResidualLegExposure[],
    projectionVersion = 0,
    projectionIdentity = residualProjectionIdentity(residual),
    underlying?: string,
    /**
     * The mode/broker this residual was created under. Omitted ⇒ THIS process, which is correct for
     * every in-process registration (a residual produced by this engine's own execution). Boot
     * reconciliation passes the durable row's own values instead, so a restored residual is worked
     * only by a process that matches it.
     */
    ownership?: { mode: ExecutionMode; broker: BrokerId },
  ): void {
    this.residualProjectionVersion.set(attemptId, projectionVersion);
    this.residualProjectionIdentity.set(attemptId, projectionIdentity);
    if (residual.length === 0) {
      // RESOLVED. Drop the underlying hold this attempt owned, so the lock cannot outlive the
      // exposure that justified it.
      const resolved = this.residualUnderlyingByAttempt.get(attemptId);
      this.residualByAttempt.delete(attemptId);
      this.residualUnderlyingByAttempt.delete(attemptId);
      this.residualOwnershipByAttempt.delete(attemptId);
      if (resolved) {
        void this.coordinator
          .releaseUnderlyingForResidual(resolved, attemptId)
          .catch(() => undefined);
      }
    } else {
      this.residualByAttempt.set(attemptId, residual);
      this.residualOwnershipByAttempt.set(attemptId, {
        mode: ownership?.mode ?? this.cfg.executionMode,
        broker: ownership?.broker ?? this.deps.activeBroker(),
      });
      if (underlying) {
        const symbol = underlying.trim().toUpperCase();
        this.residualUnderlyingByAttempt.set(attemptId, symbol);
        // Unresolved residual legs ARE exposure, so they hold the underlying in their own right —
        // durably and cross-process, not merely via this process's in-memory view.
        void this.coordinator.claimUnderlyingForResidual(symbol, attemptId).catch(() => undefined);
      }
      this.ensureFeed(); // outstanding exposure needs live books to flatten
      // ...and RETAINING the transport is not the same as asking for the instruments. Without this
      // the engine held a feed carrying none of the residual contracts, so the flatten loop had a
      // healthy socket and no book to price against.
      this.ensureResidualSubscriptions();
      this.ensureResidualFlattenTimer();
    }
    this.orderManager?.setExposure({ residualLegs: this.residualLegCount() });
  }

  /**
   * Whether exposure is currently quarantined pending reconciliation.
   *
   * Reads the SAME authority `getStatus()` reports (`live_manager.recoveryActive`), so the session
   * gate and the operator's screen can never disagree about it.
   */
  private recoveryActive(): boolean {
    return this.orderManager?.status().recoveryActive ?? false;
  }

  /**
   * Underlyings carrying an order whose broker state is not resolved.
   *
   * Built from the manager's orphan list — orders it saw at the broker but could not attribute to a
   * known durable intent. Attribution is by tradingsymbol against the open-position book, which is
   * the only mapping available without a database round trip on a synchronous path.
   */
  private unresolvedIntentUnderlyings(): { underlying: string; state: BoxOrderIntentState }[] {
    const live = this.orderManager?.status() ?? null;
    if (!live || live.orphanOrders.length === 0) return [];
    const bySymbol = new Map<string, string>();
    for (const position of this.positions.list()) {
      for (const role of BOX_LEG_ROLES) {
        bySymbol.set(position.legs[role].tradingsymbol, position.underlying);
      }
    }
    return live.orphanOrders.map((order) => ({
      underlying: bySymbol.get(order.tradingsymbol) ?? "__UNATTRIBUTED__",
      state: "UNKNOWN" as BoxOrderIntentState,
    }));
  }

  /**
   * Release the durable underlying claim for a trade. Never throws.
   *
   * A failure here would leave the underlying protected for longer than necessary, which is the
   * safe direction, so it is logged rather than propagated into a close/delete path.
   */
  private async releaseUnderlyingClaim(underlying: string, tradeId: string): Promise<void> {
    if (!this.cfg.oneActiveBoxPerUnderlying) return;
    try {
      await this.coordinator.releaseUnderlyingForPosition(underlying, tradeId);
    } catch (error) {
      console.warn(`[Box] failed to release the ${underlying} underlying claim for ${tradeId}:`, error);
    }
  }

  /**
   * RE-ESTABLISH underlying claims from durable state.
   *
   * Called at boot after positions and residual attempts are adopted, and after a broker switch.
   * This is what makes the underlying lock survive a restart: every lease expired while the
   * process was down, so protection is rebuilt from Mongo rather than assumed to have persisted.
   *
   * Failures are counted, not fatal. Refusing to boot because a lock could not be taken would
   * strand real exposure — the same trade-off the durable-reservation boot warning already makes.
   */
  private async reclaimUnderlyingsForOpenExposure(): Promise<void> {
    if (!this.cfg.oneActiveBoxPerUnderlying) return;
    // EVERY open position gets its own holder, not one per underlying: with the restriction
    // disabled-then-enabled, or across a config change, two Boxes can share an underlying, and the
    // first to close must not drop the second's protection.
    const wanted = new Map<string, string>();
    for (const position of this.positions.list()) {
      if (position.position_state === "FLAT") continue;
      wanted.set(`${position.underlying}\u0000${position.id}`, position.id);
    }
    let claimed = 0;
    for (const [composite, tradeId] of wanted) {
      const underlying = composite.split("\u0000")[0] as string;
      if (await this.coordinator.claimUnderlyingForPosition(underlying, tradeId)) claimed++;
    }
    // Residual attempts hold the underlying under their OWN holder token, so a position closing
    // does not drop protection that outstanding residual legs still need.
    for (const [attemptId, legs] of this.residualByAttempt) {
      if (legs.length === 0) continue;
      const symbol = this.residualUnderlyingByAttempt.get(attemptId);
      if (symbol) await this.coordinator.claimUnderlyingForResidual(symbol, attemptId);
    }
    if (wanted.size > 0) {
      console.warn(
        `[Box] re-claimed ${claimed}/${wanted.size} underlying lock(s) for exposure adopted at startup ` +
          `(BOX_ONE_ACTIVE_BOX_PER_UNDERLYING is enabled).`,
      );
    }
  }

  /**
   * LAYER 1a OF THE UNDERLYING LOCK: which underlyings carry, or may carry, Box exposure.
   *
   * Derived entirely from state reconstructed from Mongo at boot — open/partial/RECOVERY
   * positions and unresolved residual attempts — so the answer is identical before and after a
   * restart. Nothing here depends on a lease, a timer or a TTL, which is precisely the point:
   * a lock that expired while a position stayed open would not be a lock.
   *
   * SYNCHRONOUS by contract; the coordinator consults it inside a prologue that must not yield.
   */
  private activeUnderlyings(): ReadonlyMap<string, UnderlyingActivity> {
    return activeUnderlyings({
      positions: this.positions.list().map((position) => ({
        underlying: position.underlying,
        ...(position.position_state ? { position_state: position.position_state } : {}),
        remaining_qty_by_role: position.remaining_qty_by_role,
      })),
      residuals: [...this.residualByAttempt].map(([attemptId, legs]) => ({
        // An unattributed residual is reported under a sentinel rather than dropped: losing it
        // would silently unlock the underlying it belongs to.
        underlying: this.residualUnderlyingByAttempt.get(attemptId) ?? "__UNATTRIBUTED__",
        legs: legs.length,
      })),
      // Orders whose broker state the manager could not attribute. Their underlying is resolved
      // through the open-position book by tradingsymbol; anything unattributable is reported under
      // a sentinel rather than dropped, because an order we cannot place is the LAST thing to treat
      // as harmless.
      intents: this.unresolvedIntentUnderlyings(),
    });
  }

  private ensureResidualFlattenTimer(): void {
    if (this.residualFlattenTimer) return;
    this.residualFlattenTimer = setInterval(() => void this.flattenResiduals(), BoxEngine.RESIDUAL_FLATTEN_MS);
    this.residualFlattenTimer.unref?.();
  }

  /**
   * Keep retrying the residual READ until it succeeds.
   *
   * Recovery discovery ran exactly once, at boot, and the flatten loop only ever retries legs it
   * already holds in memory — so a read that failed was never re-attempted, and the process stayed
   * blind for its whole life. This is the missing retry: it re-reads the durable picture, and a
   * success clears both the blocker and this timer. It never touches already-owned exposure, so it
   * cannot interfere with reduction in progress.
   */
  private ensureResidualRecoveryRetry(): void {
    if (this.residualRecoveryRetryTimer || this.disposed) return;
    this.residualRecoveryRetryTimer = setInterval(() => {
      if (this.residualRecoveryLoadError === null || this.disposed) {
        if (this.residualRecoveryRetryTimer) {
          clearInterval(this.residualRecoveryRetryTimer);
          this.residualRecoveryRetryTimer = null;
        }
        return;
      }
      void this.reconcileResidualExposure()
        .then(() => {
          if (this.residualRecoveryLoadError === null && this.residualRecoveryRetryTimer) {
            clearInterval(this.residualRecoveryRetryTimer);
            this.residualRecoveryRetryTimer = null;
            console.log("[Box] residual exposure is readable again — entry is no longer refused for it.");
          }
        })
        .catch(() => undefined);
    }, BoxEngine.RESIDUAL_RECOVERY_RETRY_MS);
    this.residualRecoveryRetryTimer.unref?.();
  }

  /**
   * THE RESIDUAL-FLATTENING RUNTIME LOOP.
   *
   * Independent of RUN/STOP: outstanding simulated exposure is the engine's
   * responsibility to flatten, exactly like an open position. It runs only while
   * the market is open and the feed is healthy, works each attempt at most once at
   * a time (in-flight guard), sizes each order to the EXACT remaining quantity
   * (never re-sending flattened quantity), persists the shrunken residual
   * immediately, and resolves the attempt when it reaches zero. When nothing is
   * outstanding the timer stops and degraded clears.
   */
  /**
   * OBSERVE A COMPLETED FOUR-LEG ATTEMPT (Phases 9, 10, 18).
   *
   * One integration point, called from both the success and the abort path, that turns a finished
   * attempt into the three kinds of evidence the calibration surface needs:
   *
   *   - the OUTCOME class, so measured outcome rates exist at all (they were previously always
   *     zero because nothing ever recorded one);
   *   - QUEUE EVIDENCE per leg, so the haircut recommender has a data source (it previously had
   *     none and could only ever report "insufficient evidence");
   *   - IMPLEMENTATION SHORTFALL, so where the detected edge went is attributed rather than
   *     inferred.
   *
   * FAIL-OPEN. This is pure observability on a path that has already completed real or simulated
   * execution; a failure here must never affect the attempt's recorded result.
   */
  private observeAttempt(
    legging: PaperLeggingExecutionRecord,
    filledAllFour: boolean,
    /**
     * Gross edge measured at DETECTION (₹), or null when the caller does not know it.
     * Required for shortfall attribution and never substituted with another figure.
     */
    detectedGrossEdge: number | null = null,
  ): void {
    try {
      const broker = this.deps.activeBroker();
      const legs = legging.legs ?? [];

      // ── outcome class ──────────────────────────────────────────────────────────────
      // Precedence is deliberate: the most SPECIFIC description of what went wrong wins, so a
      // partial that was then unwound is reported as the unwind it became, not merely as "partial".
      const raced = legs.some((leg) => (leg.raced_fill_qty ?? 0) > 0);
      const residual = (legging.residual_exposure ?? []).length > 0;
      const outcome: BoxExecutionOutcome = filledAllFour
        ? "filled_4_of_4"
        : legging.abort_after_fill
          ? "abort_after_fill"
          : legging.failure_reason === "unwind_failed"
            ? "failed_unwind"
            : residual
              ? "residual"
              : raced
                ? "cancel_race"
                : legs.some((leg) => leg.status === "UNWOUND")
                  ? "clean_unwind"
                  : legging.filled_leg_count > 0
                    ? "partial"
                    : legs.some((leg) => leg.status === "TIMED_OUT")
                      ? "timeout"
                      : "no_fill";

      // Marketable and passive populations are never pooled, so the outcome is filed under the
      // profile the legs were actually CLASSIFIED as (not an assumed one).
      const profile: LatencyProfile =
        legs.some((leg) => leg.pricing?.order_type === "PASSIVE_LIMIT") ? "PASSIVE_LIMIT" : "MARKETABLE_LIMIT";
      this.outcomeStore.recordOutcome(broker, profile, outcome);

      // ── EXECUTION FUNNEL (Task 8): the SAME terminal event, counted with explicit denominators.
      // `submitted` is derived from the outcome CLASS the execution path itself stamped: only a
      // REFUSED_BEFORE_SUBMIT (or an equivalent no-POST classification) had zero broker POSTs, so
      // it is the only class that must NOT dilute the broker-facing completion rate. Costs and
      // residual come straight off the record, so recovery losses and unresolved exposure can
      // never be hidden from the published rate.
      this.recordEntryFunnelOutcome(legging, filledAllFour);

      // ── queue evidence, per leg ────────────────────────────────────────────────────
      for (const leg of legs) {
        const visible = leg.executable_within_limit_at_arrival;
        // No observed executable depth means no realisation ratio to compute. Skipped rather than
        // recorded as a zero, which would drag the recommended haircut upward on no evidence.
        if (visible === null || !(visible > 0)) continue;
        this.queueEstimator.record({
          broker,
          profile: leg.pricing?.order_type === "PASSIVE_LIMIT" ? "PASSIVE_LIMIT" : "MARKETABLE_LIMIT",
          side: leg.side,
          tradingsymbol: leg.tradingsymbol,
          displayedQtyAtSubmit: leg.displayed_qty_at_arrival ?? visible,
          executableWithinLimitAtSubmit: visible,
          requestedQty: leg.requested_qty,
          limitOffsetTicks: leg.limit_offset_ticks,
          immediatelyMarketable: leg.pricing?.order_type !== "PASSIVE_LIMIT",
          filledQty: leg.fill_qty,
          fillLatencyMs:
            leg.fill_at !== null && leg.ack_at !== null ? Math.max(0, leg.fill_at - leg.ack_at) : null,
          partial: leg.fill_qty > 0 && leg.fill_qty < leg.quantity,
          bookUpdatesWhileWorking: null,
          atWall: this.executionClock.wall(),
        });
      }

      // ── paper-side timing, so a parity report has two sides to compare ────────────
      // Only from PAPER legs: a live attempt's timing already goes to `brokerTiming` through the
      // recorder, and mixing the two stores would compare a distribution against itself.
      if (this.cfg.executionMode !== "live") {
        for (const leg of legs) {
          this.paperTiming.recordLegTiming({
            broker,
            trade_id: legging.trade_id ?? null,
            attempt_id: "paper",
            role: leg.role,
            purpose: "ENTRY",
            kind: "ENTRY",
            detected_at: legging.detected_at,
            queued_at: leg.submit_at,
            dequeued_at: leg.submit_at,
            post_started_at: leg.submit_at,
            post_returned_at: leg.ack_at,
            acknowledged_at: leg.ack_at,
            first_fill_at: leg.fills[0]?.at ?? null,
            last_fill_at: leg.fills.at(-1)?.at ?? null,
            terminal_at: leg.resolved_at,
            cancel_requested_at: leg.cancel_requested_at,
            cancel_confirmed_at: leg.cancel_confirmed_at,
          });
        }
        this.paperTiming.recordBoxOutcome({
          broker,
          outcome,
          detection_to_first_fill_ms:
            legging.decision_to_first_fill_ms ?? null,
          detection_to_all_four_filled_ms: legging.decision_to_last_fill_ms ?? null,
          first_fill_to_last_fill_ms: legging.first_to_last_fill_ms ?? null,
          unhedged_exposure_duration_ms: legging.exposure_duration_ms ?? null,
        });
      }

      // ── implementation shortfall ───────────────────────────────────────────────────
      // Attribution is only meaningful against the edge the attempt SET OUT to capture. That
      // figure is not on the legging record, and the two fields that look adjacent are neither of
      // it: `required_expected_net_profit` is the GATE THRESHOLD the executed prices were tested
      // against, and `final_expected_net_profit` is an expected NET, not a gross edge. Feeding the
      // threshold in as the theoretical edge made every line of the subtraction chain — including
      // `unexplained` — an attribution of nothing in particular. The detected edge is now passed
      // in explicitly by the caller, and when the caller does not know it the shortfall is SKIPPED
      // rather than computed from a stand-in.
      if (detectedGrossEdge === null || !Number.isFinite(detectedGrossEdge)) {
        this.lastShortfall = null;
        return;
      }
      const shortfall = computeExecutionShortfall({
        theoreticalDetectedEdge: detectedGrossEdge,
        // The record carries no EXECUTED gross edge, and `final_expected_net_profit` is an expected
        // net — a different quantity. Reported as unknown rather than filled with the wrong one.
        executedGrossEdge: null,
        brokerage: 0,
        taxesAndFees: round2((legging.partial_entry_charges ?? 0) + (legging.unwind_charges ?? 0)),
        unwindCost: Math.max(0, -(legging.legging_gross_loss ?? 0)),
        realisedNetResult: legging.legging_net_loss ?? 0,
        outcome:
          outcome === "filled_4_of_4"
            ? "filled_4_of_4"
            : outcome === "abort_after_fill"
              ? "aborted_after_fill"
              : residual
                ? "partial_residual"
                : legging.filled_leg_count > 0
                  ? "partial_unwound"
                  : "no_fill",
        legs: legs.map((leg) => ({
          role: leg.role,
          side: leg.side,
          detectedPrice: leg.detected_price,
          // The touch at submission is not separately captured, so the detection reference is used
          // and edge decay collapses into slippage rather than being invented as a separate figure.
          submitPrice: null,
          filledPrice: leg.average_fill_price ?? leg.fill_price,
          requestedQty: leg.requested_qty,
          filledQty: leg.fill_qty,
        })),
      });
      this.lastShortfall = shortfall;
    } catch (err) {
      // Observability only; never allow it to disturb a completed execution.
      console.warn("[Box] attempt observation failed (diagnostics only):", err);
    }
  }

  /**
   * Feed the terminal entry outcome to the {@link ExecutionFunnel} (Task 8).
   *
   * Pure accounting, wrapped so a counting error can never disturb an execution. `submitted` is
   * whether ANY real broker POST occurred, derived from the outcome CLASS the execution path
   * stamped: a REFUSED_BEFORE_SUBMIT (or a fallback classification with zero submitted legs)
   * reached no broker. Recovery costs and unresolved exposure come straight off the record, so the
   * displayed success rate is computed from the SAME facts and cannot be improved by hiding them.
   */
  private recordEntryFunnelOutcome(legging: PaperLeggingExecutionRecord, filledAllFour: boolean): void {
    try {
      // A clean four-leg open is counted by openPaperTrade (the only path that also handles atomic
      // opens with no legging record). Skipping it here is what keeps a completed entry counted
      // exactly once across the two callers of observeAttempt.
      if (filledAllFour) return;
      const outcomeClass: BoxEntryOutcomeClass =
        legging.outcome_class ??
        ((legging.submitted_leg_count ?? 0) > 0
          ? legging.filled_leg_count > 0
            ? "PARTIAL_ENTRY_UNWOUND"
            : "NO_FILL"
          : "REFUSED_BEFORE_SUBMIT");
      // A real broker POST happened unless this was a proven pre-submit refusal. The outcome CLASS
      // is authoritative (the execution path stamps REFUSED_BEFORE_SUBMIT only when nothing
      // reached the broker); submitted_leg_count is the corroborating fact.
      const submitted =
        outcomeClass !== "REFUSED_BEFORE_SUBMIT" || (legging.submitted_leg_count ?? 0) > 0;
      const recoveryCost =
        (legging.partial_entry_charges ?? 0) + (legging.unwind_charges ?? 0);
      const leftUnresolvedExposure = (legging.residual_exposure ?? []).length > 0;
      // Every admitted attempt is counted; recordEntryOutcome files it into the right denominator.
      this.funnel.recordAdmitted();
      if (submitted) this.funnel.recordSubmitted();
      this.funnel.recordEntryOutcome({
        outcome: outcomeClass,
        submitted,
        // On an abort/partial the realised economics are the (negative) legging net loss; on a
        // clean OPEN there is no realised entry P&L yet (the exit books it), so leave it null.
        realisedNetPnl:
          outcomeClass === "OPENED" ? null : legging.legging_net_loss ?? null,
        recoveryCost: recoveryCost > 0 ? recoveryCost : null,
        leftUnresolvedExposure,
        ...(submitted ? {} : { zeroPostReason: zeroPostReasonFor(legging.failure_reason) }),
      });
    } catch (err) {
      console.warn("[Box] funnel outcome recording failed (diagnostics only):", err);
    }
  }

  /**
   * Reload previously-measured calibration observations into the in-memory store.
   *
   * THIS is what persistence is for: without it, calibration status resets to UNCALIBRATED on every
   * restart and paper silently drops back to its constants. Region-scoped, because two deployments
   * have different physical round-trip times to the broker.
   *
   * Bounded and fail-open: it loads at most a capped number of rows no older than the active
   * calibration window, and any failure simply leaves the store empty — which reports itself as
   * UNCALIBRATED rather than pretending.
   */
  private async rehydrateCalibration(): Promise<void> {
    if (!this.cfg.liveTimingPersistEnabled) return;
    try {
      const rows = await loadBoxCalibrationSamples({
        region: this.cfg.deploymentRegion,
        maxAgeMs: this.cfg.paperCalibrationMaxAgeMs,
      });
      let restored = 0;
      for (const row of rows) {
        // Anything whose dimensions we no longer recognise is skipped, never coerced.
        this.calibration.record({
          broker: row.broker as BrokerId,
          kind: row.kind as never,
          profile: row.profile as never,
          bucket: row.bucket as never,
          stage: row.stage as CalibrationStage,
          valueMs: row.valueMs,
          atWall: row.atWall,
          session: row.session,
        });
        restored++;
      }
      if (restored > 0) {
        console.log(
          `[Box] restored ${restored} persisted calibration observations` +
            `${this.cfg.deploymentRegion ? ` for region ${this.cfg.deploymentRegion}` : ""}.`,
        );
      }
    } catch (err) {
      console.warn("[Box] calibration rehydration failed; starting UNCALIBRATED:", err);
    }
  }

  /**
   * Count residual-flatten charges against the live daily risk limit.
   *
   * Only the increment for THIS pass, so multi-pass flattening cannot double-count. Deliberately
   * does NOT rewrite the attempt's historical `net_abort_pnl`: execution economics that were
   * already recorded are never mutated after the fact — the cost is recorded as its own field and
   * as realised P&L, which is the honest way to show a later cost against an earlier trade.
   */
  private noteFlattenCharges(
    attemptId: string,
    charges: number,
    observation?: FlattenChargeDayObservation,
  ): void {
    if (!Number.isFinite(charges) || charges <= 0) return;
    if (!observation) {
      // Compatibility fallback for a legacy/custom projection persistence implementation. The
      // production repository always returns authoritative day metadata.
      this.orderManager?.recordRealisedPnl(-charges);
      return;
    }
    this.orderManager?.recordFlattenCharge({
      attemptId,
      chargeDay: observation.chargeDay,
      previousChargesForDay: observation.previousChargesForDay,
      chargesForDay: observation.chargesForDay,
    });
  }

  private async persistResidualProjection(
    attemptId: string,
    command: BoxExecutionAttemptProjectionCommand,
  ): Promise<BoxExecutionAttemptProjectionResult> {
    const result = await persistOwnedResidualProjection({
      attemptId,
      command,
      persist: (immutableCommand) => applyBoxExecutionAttemptProjection(attemptId, immutableCommand),
      observedFlattenCharges: this.observedFlattenCharges,
      observedFlattenChargesByDay: this.observedFlattenChargesByDay,
      onAppliedCharge: (charge, observation) =>
        this.noteFlattenCharges(attemptId, charge, observation),
    });
    if (result.status !== "not_found" && result.residual_exposure &&
        result.projection_version !== null && result.projection_identity !== null) {
      this.pendingResidualPersists.delete(attemptId);
      this.registerResidual(
        attemptId,
        result.residual_exposure,
        result.projection_version,
        result.projection_identity,
        // Carry the existing attribution forward: a shrinking residual must not lose the
        // underlying it belongs to, or the lock would silently release mid-flatten.
        this.residualUnderlyingByAttempt.get(attemptId),
      );
      if (result.residual_exposure.length === 0) {
        // This attempt is authoritatively resolved and its acknowledgement is no longer pending,
        // so nothing in this process can project it again: release every per-attempt structure it
        // owns rather than carrying it for the process lifetime.
        const retained = this.retainedRiskAttemptIds();
        compactObservedFlattenChargeWatermarks({
          observedByAttempt: this.observedFlattenCharges,
          observedByAttemptDay: this.observedFlattenChargesByDay,
          retainAttemptIds: retained,
          currentDay: this.deps.istDayKey(),
        });
        compactResidualProjectionBookkeeping({
          projectionVersionByAttempt: this.residualProjectionVersion,
          projectionIdentityByAttempt: this.residualProjectionIdentity,
          retainAttemptIds: retained,
        });
      }
    }
    return result;
  }

  private async flattenResiduals(): Promise<void> {
    if (this.residualByAttempt.size === 0 && this.pendingResidualPersists.size === 0) {
      if (this.residualFlattenTimer) {
        clearInterval(this.residualFlattenTimer);
        this.residualFlattenTimer = null;
      }
      return;
    }
    for (const [attemptId, command] of [...this.pendingResidualPersists]) {
      try {
        const result = await this.persistResidualProjection(attemptId, command);
        if (result.status === "not_found") continue;
        if (result.status === "stale") {
          this.execution.invariantViolation(
            `residual ${attemptId} projection retry was stale and adopted durable version ${result.projection_version}`,
          );
        }
      } catch {
        // Persistence-only retry with the exact same immutable application id, projection and fee.
        // Never replay the already-confirmed broker/paper fill.
      }
    }
    if (!this.marketOpen || !this.isFeedHealthy()) return; // cannot execute now; residual is kept

    for (const [attemptId, residual] of [...this.residualByAttempt]) {
      if (this.pendingResidualPersists.has(attemptId)) continue;
      if (this.residualFlattenInFlight.has(attemptId)) continue; // no concurrent flatten
      /*
       * OWNERSHIP BEFORE ACTION. A restored residual states the mode and broker it was created
       * under; this process must match both before it may trade against it. Skipped — never
       * deleted — so `residualLegCount()` keeps reporting the exposure to the broker-switch guard
       * and the exposure probe, and the readiness surface keeps naming it as a reduction blocker.
       */
      const foreign = this.residualOwnershipMismatch(attemptId);
      if (foreign !== null) continue;
      /*
       * STOP RETRYING A REDUCTION THE BROKER KEEPS REFUSING — but keep holding and reporting it.
       *
       * A broker rejection retires the flatten generation so the exposure can genuinely be retried
       * (retaining the identity used to strand it permanently). The bound is the other half of that
       * change: a reduction refused MAX_RESIDUAL_BROKER_REJECTIONS times running, with zero fill
       * every time, is structurally impossible rather than unlucky. Escalated once, then skipped —
       * the exposure stays in `residualByAttempt`, so it keeps blocking new entry and keeps
       * appearing on the readiness surface. A human has to clear it.
       */
      if (residual.some(residualRejectionBudgetExhausted)) {
        if (!this.residualRejectionEscalated.has(attemptId)) {
          this.residualRejectionEscalated.add(attemptId);
          const stuck = residual
            .filter(residualRejectionBudgetExhausted)
            .map((r) => `${r.role} ${r.side} ${r.quantity} ${r.tradingsymbol} ` +
              `(${residualBrokerRejections(r)} broker rejections)`)
            .join(", ");
          this.execution.invariantViolation(
            `residual ${attemptId} has STOPPED automatic flattening: [${stuck}]. Every reduction was ` +
              `terminally rejected by the broker with zero fill. The exposure is STILL HELD. Check for ` +
              `an F&O ban period, an expired contract, an RMS block or a margin shortfall, then flatten ` +
              `manually.`,
          );
          this.metrics.recordResidualFlattenFailure();
        }
        continue;
      }
      this.residualFlattenInFlight.add(attemptId);
      this.metrics.recordResidualFlattenAttempt();
      try {
        const res = await this.execution.flattenResidual({ residual, keyPrefix: attemptId });
        const command = createResidualProjectionCommand({
          attemptId,
          expectedVersion: this.residualProjectionVersion.get(attemptId) ?? 0,
          expectedResidual: residual,
          nextResidual: res.remaining,
          flattenChargeDelta: res.flatten_charges,
          flattenChargeDay: this.deps.istDayKey(),
        });
        if (!residualProjectionChanges(command)) {
          // No broker fill, charge, or generation retirement occurred. A no-book/gate pass must
          // not consume the projection version ahead of another worker's broker-confirmed result.
          this.metrics.recordResidualFlattenFailure();
          continue;
        }
        let result: BoxExecutionAttemptProjectionResult;
        try {
          result = await this.persistResidualProjection(attemptId, command);
        } catch {
          this.pendingResidualPersists.set(attemptId, command);
          this.execution.invariantViolation(
            `residual ${attemptId} flatten awaits durable versioned projection acknowledgement`,
          );
          this.metrics.recordResidualFlattenFailure();
          continue;
        }
        if (result.status === "not_found") {
          this.pendingResidualPersists.set(attemptId, command);
          this.execution.invariantViolation(`residual ${attemptId} durable execution attempt was not found`);
          this.metrics.recordResidualFlattenFailure();
          continue;
        }
        if (result.status === "stale") {
          this.execution.invariantViolation(
            `residual ${attemptId} stale projection lost to durable version ${result.projection_version}`,
          );
          this.metrics.recordResidualFlattenFailure();
          continue;
        }
        const authoritative = result.residual_exposure ?? [];
        if (authoritative.length === 0) {
          this.metrics.recordResidualFlattenSuccess();
          console.log(`[Box] residual exposure for attempt ${attemptId} fully flattened.`);
        } else {
          const sumQty = (legs: ResidualLegExposure[]): number => legs.reduce((s, r) => s + r.quantity, 0);
          if (sumQty(authoritative) < sumQty(residual)) this.metrics.recordResidualFlattenPartial();
          else this.metrics.recordResidualFlattenFailure();
        }
      } catch (err) {
        this.metrics.recordResidualFlattenFailure();
        console.warn(`[Box] residual flatten failed for attempt ${attemptId}:`, err);
      } finally {
        this.residualFlattenInFlight.delete(attemptId);
      }
    }

    if (this.residualByAttempt.size === 0 && this.pendingResidualPersists.size === 0 &&
        this.residualFlattenTimer) {
      clearInterval(this.residualFlattenTimer);
      this.residualFlattenTimer = null;
    }
  }

  private async markReconciliationRecovery(report: OrderManagerReconcileReport): Promise<void> {
    const mismatchSymbols = new Set(report.positionMismatches.map((item) => item.symbol));
    const affectedIds = new Set(report.affectedTradeIds);
    for (const position of this.positions.list()) {
      const projected = report.remainingByTrade[position.id];
      if (projected) {
        const exact = {} as Record<BoxLegRole, number>;
        let valid = true;
        for (const role of BOX_LEG_ROLES) {
          const quantity = projected[role] ?? 0;
          // Preserve broker-confirmed integer overfill exactly. It is abnormal
          // position truth, not permission to normalize back to one lot.
          if (!Number.isSafeInteger(quantity) || quantity < 0) valid = false;
          exact[role] = quantity;
        }
        const changed = BOX_LEG_ROLES.some((role) => exact[role] !== position.remaining_qty_by_role[role]);
        if (!valid) {
          affectedIds.add(position.id);
        } else {
          const projectedViolation = singleLotPositionViolation({
            ...position,
            remaining_qty_by_role: exact,
          });
          const projectedState = isBoxPositionFlat(exact) || projectedViolation
            ? "RECOVERY" as const
            : deriveBoxPositionState(exact, position.position_state);
          if (changed) {
            const persisted = await applyBoxReconciledProjection(position.id, exact, projectedState);
            if (!persisted) throw new Error(`failed to persist reconciled quantity projection for ${position.id}`);
            position.remaining_qty_by_role = exact;
            position.position_state = projectedState;
            if (projectedState === "RECOVERY") {
              position.exit_blocked_reason = projectedViolation
                ? `broker-confirmed quantity violates single-lot position invariant: ${projectedViolation}`
                : "broker-confirmed flat quantity requires terminal close-accounting recovery";
            }
          }
          if (projectedViolation) affectedIds.add(position.id);
        }
      }

      const symbolAffected = BOX_LEG_ROLES.some((role) => {
        const inst = position.legs[role];
        return mismatchSymbols.has(`${inst.exchange}:${inst.tradingsymbol}`);
      });
      if (!symbolAffected && !affectedIds.has(position.id)) continue;
      const detail = "live broker reconciliation found an order or attributed-position mismatch";
      position.position_state = "RECOVERY";
      position.exit_blocked_reason = detail;
      await markBoxTradeRecovery(position.id, detail);
    }
  }

  private refreshCrashRecoveryEntryQuarantine(): void {
    if (!this.orderManager) return;
    const projectedSymbols = new Set<string>();
    for (const position of this.positions.list()) {
      for (const role of BOX_LEG_ROLES) {
        const instrument = position.legs[role];
        projectedSymbols.add(`${instrument.exchange}:${instrument.tradingsymbol}`);
      }
    }
    const hasCrashOnlyExposure = this.orderManager.attributedRecoveryExposure().some(
      (residual) => !projectedSymbols.has(
        `${residual.exchange ?? "NFO"}:${residual.tradingsymbol}`,
      ),
    );
    this.orderManager.setCrashOnlyAttributedExposure(hasCrashOnlyExposure);
  }

  private syncManagerExposure(): void {
    if (!this.orderManager) return;
    const bySymbol = new Map<string, { token: number; exchange: string; tradingsymbol: string; net_quantity: number; average_price: number }>();
    for (const position of this.positions.list()) {
      const direction = position.direction ?? "LONG_BOX";
      for (const role of BOX_LEG_ROLES) {
        const quantity = position.remaining_qty_by_role[role];
        if (!Number.isInteger(quantity) || quantity <= 0) continue;
        const inst = position.legs[role];
        const key = `${inst.exchange}:${inst.tradingsymbol}`;
        const current = bySymbol.get(key) ?? { token: inst.token, exchange: inst.exchange, tradingsymbol: inst.tradingsymbol, net_quantity: 0, average_price: position.entry_prices[role] ?? 0 };
        current.net_quantity += entrySideFor(role, direction) === "BUY" ? quantity : -quantity;
        bySymbol.set(key, current);
      }
    }
    // STAMPED WITH THE ACCOUNT THIS SNAPSHOT DESCRIBES. Attribution with no owner is what allowed one
    // account's positions to authorise a reduction in another's session — see
    // `BoxOrderManager.attributedAccountDriftReason`.
    this.orderManager.setAttributedBoxPositions(
      [...bySymbol.values()].filter((position) => position.net_quantity !== 0),
      { account: this.liveBrokerAccount() },
    );
    this.orderManager.setExposure({
      openBoxes: this.positions.size,
      residualLegs: this.residualLegCount(),
    });
  }

  /** Authoritative degraded verdict, derived from actual ownership risk. */
  private computeDegraded(): boolean {
    const live = this.orderManager?.status();
    return this.pendingPersists.length > 0 ||
      this.residualByAttempt.size > 0 ||
      Boolean(live && (live.health.persistence === "unhealthy" || live.unknownOrders > 0 || live.recoveryActive));
  }

  /* --------------------------------- views -------------------------------- */

  getConfig() {
    return {
      /**
       * THE ENTRY GATE — minimum expected NET profit (₹) after every cost.
       *
       * The ABSOLUTE FLOOR. When a per-unit rate is set the figure a candidate is actually judged
       * against is `max(this, rate x lotSize)`, so this alone does not describe the policy — read
       * it together with `min_expected_net_profit_per_unit` and `lot_relative_thresholds`.
       */
      min_expected_net_profit: requiredNetProfit(this.cfg),
      /** A cheap gross prefilter (₹), never the decision. */
      min_gross_edge: this.cfg.minGrossEdge,
      /** Legacy extra net floor; 0 means it does not raise the gate. */
      min_net_edge: this.cfg.minNetEdge,
      /*
       * PER-UNIT RATES (₹ per unit of quantity). 0 = inactive, i.e. the flat figure stands alone.
       *
       * Published so an operator can tell the two regimes apart without reading env: flat-only
       * means the effective hurdle is `flat / lotSize` per unit, which differs ~1000x across an
       * F&O universe and concentrates entries in the largest-lot names.
       */
      lot_relative_thresholds: lotRelativeThresholdsEnabled(this.cfg),
      min_expected_net_profit_per_unit: this.cfg.minExpectedNetProfitPerUnit,
      min_gross_edge_per_unit: this.cfg.minGrossEdgePerUnit,
      safety_buffer_per_unit: this.cfg.safetyBufferPerUnit,
      expected_entry_slippage_per_unit: this.cfg.expectedEntrySlippagePerUnit,
      expected_exit_slippage_per_unit: this.cfg.expectedExitSlippagePerUnit,
      min_exit_net_pnl_per_unit: this.cfg.minExitNetPnlPerUnit,
      /** Execution model and its simulated delays. */
      execution_mode: this.cfg.executionMode,
      simulated_decision_ms: this.cfg.simulatedDecisionMs,
      simulated_latency_ms: this.cfg.simulatedLatencyMs,
      expected_entry_slippage: this.cfg.expectedEntrySlippage,
      expected_exit_slippage: this.cfg.expectedExitSlippage,
      enable_short_box: this.cfg.enableShortBox,
      directions: this.directions,
      min_captured_pct: this.cfg.minCapturedPct,
      reconcile_charges: this.cfg.reconcileCharges,
      charge_reconcile_warn_pct: this.cfg.chargeReconcileWarnPct,
      require_priced_charges: this.cfg.requirePricedCharges,
      safety_buffer: this.cfg.safetyBuffer,
      /** How long an UNCHANGED book is still trusted. */
      quote_max_age_ms: this.cfg.quoteMaxAgeMs,
      /** Feed-liveness limit: newest tick across the whole universe. */
      feed_max_age_ms: this.cfg.feedMaxAgeMs,
      underlying_max_age_ms: this.cfg.underlyingMaxAgeMs,
      /** The MAXIMUM strikes each side (the cap). */
      strikes_each_side: this.cfg.strikesEachSide,
      /** The ACTIVE admin-selected level (1, 2 or 3), never above the cap. */
      strike_level: this.strikeLevel,
      max_strikes: this.strikeLevel * 2 + 1,
      /**
       * Strike PAIRS in the active window: C(n,2) for n = 2·level+1 strikes.
       * ±3 → 7 strikes → 21 pairs, ±2 → 5 → 10, ±1 → 3 → 3. Was hard-coded at 21,
       * which over-stated the monitored set at every level but the widest.
       */
      max_candidates_per_underlying: (() => {
        const n = this.strikeLevel * 2 + 1;
        return (n * (n - 1)) / 2;
      })(),
      prefilter_gross_threshold: prefilterGrossThreshold(this.cfg),
      convergence_floor: this.cfg.convergenceFloor,
      convergence_pct: this.cfg.convergencePct,
      min_exit_net_pnl: this.cfg.minExitNetPnl,
      profit_capture_pct: this.cfg.profitCapturePct,
      expiry_safety_minutes: this.cfg.expirySafetyMinutesBeforeClose,
      max_subscribed_tokens: this.cfg.maxSubscribedTokens,
      lots: 1,
      universe: "NSE F&O options only — F&O stocks + supported indices",
      /** Whether the last-close view covers the whole universe with RUN off. */
      indicative_discovery: this.cfg.indicativeDiscovery,
      /** Whether today's closed trades are mirrored to Redis for a fast read. */
      closed_cache_enabled: this.closedCache.enabled(),
      /** The thresholds an admin may change from the UI, and their bounds. */
      tunable: {
        min_expected_net_profit: BOX_TUNING_LIMITS.minExpectedNetProfit,
        safety_buffer: BOX_TUNING_LIMITS.safetyBuffer,
      },
    };
  }

  /**
   * READ-ONLY execution diagnostics (Phase 32).
   *
   * Everything an operator needs to answer "is the simulator calibrated, and how much should I
   * trust it?" — per-broker calibration status with sample counts and freshness, the measured
   * latency percentiles, event-loop health, what paper is ACTUALLY running on, outcome and
   * reject rates, the advisory haircut recommendation, and recent latency outliers.
   *
   * TWO PROPERTIES THIS METHOD MUST HAVE:
   *
   *  1. NO SECRETS. It exposes latency numbers, counts, statuses and explicitly-configured
   *     labels. No access token, no API key, no session identifier, no credential of any kind is
   *     reachable from here — the stores it reads never held one.
   *  2. NO SIDE EFFECTS. Purely a read. It is a cold path: it sorts sample arrays to compute
   *     percentiles, so it must never be called per tick or per order.
   */
  getExecutionDiagnostics(): Record<string, unknown> {
    const paper = this.executionSim.calibrationStatus();
    return {
      // What paper is running on RIGHT NOW, stated so it cannot be misread. The banner is blunt
      // about the stress profile precisely so its figures are never quoted as live parity.
      profile: {
        name: this.cfg.paperExecutionProfile,
        execution_mode: this.cfg.executionMode,
        evidence_driven: paper.evidence_driven,
        banner: profileReportBanner(this.cfg.paperExecutionProfile),
      },
      paper_calibration: {
        ...paper,
        // The human-readable CALIBRATION block, so confidence never appears without its evidence.
        rendered: paper.latency ? formatCalibrationBlock(paper.latency) : null,
      },
      // Per-broker calibration state. Zerodha and Dhan are always reported separately.
      calibration_by_broker: this.calibration.allBrokerStatus(),
      calibration_distributions: this.calibration.snapshot(),
      calibration_dropped_samples: this.calibration.dropped,
      // Measured live timing, per broker and operation kind.
      live_timing: this.brokerTiming.snapshot(),
      // Recent raw timelines — the outliers an operator wants to inspect.
      recent_latency_outliers: this.brokerTiming.recentTimeline().slice(-20),
      timing_recorder: this.timingRecorder.diagnostics(),
      // Persistence health. `lost_total` is surfaced deliberately: silent sample loss is
      // indistinguishable from a broker that got faster.
      calibration_persistence: this.calibrationPersistence.diagnostics(),
      // Node scheduling health, so a stall is never mistaken for broker latency.
      execution_environment: this.environmentMonitor.snapshot(),
      event_loop_attach_failure: this.environmentMonitor.attachFailure,
      // Measured outcome and reject rates for the active broker.
      outcomes: this.outcomeStore.outcomeCounts(this.deps.activeBroker(), "MARKETABLE_LIMIT"),
      rejects: this.outcomeStore.rejectCounts(this.deps.activeBroker()),
      // TECHNICAL entry-pipeline faults, classified. Fixed keys (always all ten, so a zero reads
      // as a zero) plus a bounded ring of recent detail. `candidate_key` and stack traces are
      // stripped here by `publicRecent()`: they go to the server log and the trade-event ledger,
      // never to a metric label or this endpoint, which is counts/statuses only.
      entry_fault_classes: this.entryFaults.counts(),
      entry_faults_total: this.entryFaults.total,
      recent_entry_faults: this.entryFaults.publicRecent(20),
      // Advisory only. Never applied automatically; never a claim about NSE queue position.
      queue_calibration: this.queueEstimator.recommendAll(),
      last_implementation_shortfall: this.lastShortfall,
      // LIVE vs PAPER parity, per broker. Both halves are now produced, so this is a real
      // comparison rather than an unreachable pure function. Low-confidence metrics are flagged by
      // the report itself rather than being presented as significant.
      parity: buildParityReports(this.brokerTiming.snapshot(), this.paperTiming.snapshot()),
      // Contract-level coordination. No high-cardinality labels: counts, percentiles
      // and statuses only — never an order id, execution id or symbol.
      coordinator: this.coordinator.metrics(),
      // Multi-process reservation health. `liveEntryBlocked` is the field that matters
      // operationally: when true the system is deliberately refusing to open NEW Box
      // exposure because cross-process exclusion cannot be guaranteed. Exits, residual
      // flattening and reconciliation are unaffected.
      executionCoordination: this.coordinator.coordinationHealth(),
      shadow_mode: shadowModeStatus({
        shadowEnabled: this.cfg.shadowModeEnabled,
        executionMode: this.cfg.executionMode,
        hasOrderManager: this.orderManager !== null,
      }),
    };
  }

  /**
   * Is this DEPLOYMENT capable of placing real orders?
   *
   * All three conditions are startup facts, not runtime state: the mode the process was
   * constructed in, the deployment kill switch, and whether a mutation-capable adapter actually
   * exists. No runtime action and no UI click can change any of them, which is precisely the
   * property the kill switch needs.
   */
  private liveCapability(): { capable: boolean; detail: string } {
    if (this.cfg.executionMode !== "live") {
      return { capable: false, detail: `BOX_EXECUTION_MODE is "${this.cfg.executionMode}", not "live"` };
    }
    if (!this.cfg.liveTradingEnabled) {
      return { capable: false, detail: "BOX_LIVE_TRADING_ENABLED is false" };
    }
    if (!this.orderManager || !this.liveAdapter) {
      return { capable: false, detail: "no live broker adapter was constructed in this process" };
    }
    return { capable: true, detail: "live-capable" };
  }

  /**
   * The pacing ACTUALLY in force, read from the adapter when there is one.
   *
   * Falls back to re-deriving it from config for a paper deployment, where there is no adapter to
   * ask. The fallback is labelled so an operator can tell "this is what the adapter is doing" from
   * "this is what a live adapter would do if you started one".
   */
  private effectivePacing(): EffectiveBrokerPacing & { source_of_truth: "adapter" | "config_projection" } {
    const adapter = this.liveAdapter as (BrokerAdapter & { effectivePacing?: () => EffectiveBrokerPacing }) | null;
    if (adapter?.effectivePacing) {
      return { ...adapter.effectivePacing(), source_of_truth: "adapter" };
    }
    return {
      ...resolveBrokerPacing(
        this.deps.activeBroker(),
        this.cfg.liveBrokerMinIntervalMs,
        this.cfg.liveBrokerOrderMinIntervalMs,
      ),
      source_of_truth: "config_projection",
    };
  }

  /** The snapshot the mode-transition and arming predicates need. */
  private modeTransitionSnapshot(): ModeTransitionSnapshot {
    const live = this.orderManager?.status() ?? null;
    const capability = this.liveCapability();
    let partial = 0;
    let recovery = 0;
    for (const position of this.positions.list()) {
      if (position.position_state === "PARTIALLY_EXITED") partial++;
      if (position.position_state === "RECOVERY") recovery++;
    }
    return {
      deploymentLiveCapable: capability.capable,
      liveCapabilityDetail: capability.detail,
      openBoxes: this.positions.size,
      partiallyExitedBoxes: partial,
      recoveryBoxes: recovery,
      residualLegs: this.residualLegCount(),
      recoveryActive: live?.recoveryActive ?? false,
      workingBrokerOrders: live ? live.inFlight + live.queued : 0,
      queuedExecutions: live?.queued ?? 0,
      inFlightExecutions: live?.inFlight ?? 0,
      // An orphan order is an intent whose broker state we could not attribute; it is exactly the
      // kind of unresolved intent that must block a mode change.
      unresolvedIntents: live?.orphanOrders.length ?? 0,
      unknownOrders: live?.unknownOrders ?? 0,
      reconciliationHealthy: live ? live.health.reconciliation !== "failed" : true,
      reconciliationIncidentActive: live ? !live.health.reconciliation_complete : false,
      scannerRunning: this.running,
      paperSimulationsInFlight: this.executionSim.activeCount,
    };
  }

  /**
   * THE EXECUTION CONTROL SURFACE (Part 15).
   *
   * One read-only payload answering "what is this process allowed to do right now, and why".
   * Deliberately separate from `getStatus()` so the UI's Execution panel has a stable contract of
   * its own rather than mining a 60-field status blob.
   *
   * NO SECRETS: modes, labels, counts, booleans and configured numbers only. No access token, no
   * session id, no credential — `armed_by` is an admin ROLE label, never a token.
   */
  getExecutionControl(): Record<string, unknown> {
    const live = this.orderManager?.status() ?? null;
    const capability = this.liveCapability();
    const broker = this.deps.activeBroker();
    const selection = currentSelection(this.cfg.executionMode, this.paperProfile);
    const pacing = this.effectivePacing();
    const sessionVerdict = this.session.evaluateEntry(this.recoveryActive());
    const activeUnderlyingMap = this.activeUnderlyings();

    const armPreconditions = {
      deploymentLiveCapable: capability.capable,
      brokerAuthenticated: this.deps.marketData.isAuthenticated(),
      reconciliationHealthy: live ? live.health.reconciliation !== "failed" : false,
      reconciliationComplete: live?.health.reconciliation_complete ?? false,
      feedHealthy: this.feedHealthy,
      feedWarmedUp: live ? live.health.feed === "healthy" : false,
      circuitClosed: live ? !live.circuitBreaker.tripped : false,
      recoveryActive: live?.recoveryActive ?? false,
      unknownOrders: live?.unknownOrders ?? 0,
      durableReservationsAvailable: !this.coordinator.coordinationHealth().liveEntryBlocked,
    };

    return {
      execution_mode: this.cfg.executionMode,
      paper_execution_profile: this.paperProfile,
      broker,
      /** Immutable for the process lifetime. A UI click can never make this true. */
      deployment_live_capable: capability.capable,
      live_capability_detail: capability.detail,
      /** Whether live ORDER HANDLING (exposure management) is armed. */
      live_runtime_armed: live?.controls.liveOrderEnabled ?? false,
      /** Whether NEW ENTRY is permitted. Independent of the above, on purpose. */
      entry_enabled: live?.controls.entryEnabled ?? false,
      emergency_flatten_enabled: live?.controls.emergencyFlatten ?? false,

      mode: {
        selection,
        label: executionModeLabel(this.cfg.executionMode, this.paperProfile, broker),
        /**
         * Paper profiles are runtime-selectable; LIVE is not. Stated explicitly so the UI reports
         * "restart required" honestly instead of offering a control that cannot work.
         */
        runtime_selectable: ["paper_latency", "paper_legging", "paper_legging_live_parity"],
        live_requires_restart: true,
        transition_blockers: transitionBlockers(this.modeTransitionSnapshot()),
      },

      session: this.session.status({
        entryInProgress: this.executionSim.activeCount > 0,
        openBoxes: this.positions.size,
        // The monitor exposes no in-flight exit count, so an exit is "in progress" exactly when a
        // manager operation is at the broker. Inventing a field would be worse than reusing the
        // one signal that is actually authoritative.
        exitInProgress: (live?.inFlight ?? 0) > 0,
        recoveryActive: live?.recoveryActive ?? false,
        entryBlockedExternally: live ? !live.controls.entryEnabled : true,
      }),

      risk: {
        /** The per-Box GROSS ENTRY-ORDER NOTIONAL cap (₹). 0 = disabled. NOT broker margin. */
        // The LIVE cap is the only ENFORCED one, so it is the only one reported as active.
        // Reporting the paper mirror here made the UI badge a limit that never refuses anything.
        max_box_capital_rupees: this.cfg.executionMode === "live" ? this.cfg.liveMaxBoxCapitalRupees : 0,
        /** The paper mirror's configured value, reported separately and labelled as advisory. */
        paper_max_box_capital_rupees: this.cfg.paperMaxBoxCapitalRupees,
        max_box_capital_enforced: this.cfg.executionMode === "live" && this.cfg.liveMaxBoxCapitalRupees > 0,
        max_box_capital_metric: "gross_entry_order_notional_rupees",
        capital: this.centralGateway.capitalDiagnostics(),
        one_active_box_per_underlying: this.cfg.oneActiveBoxPerUnderlying,
        one_opportunity_per_underlying: this.cfg.oneOpportunityPerUnderlying,
        active_underlyings: [...activeUnderlyingMap.values()].map((activity) => ({
          underlying: activity.underlying,
          kinds: activity.kinds,
        })),
        claimed_underlyings: this.coordinator.claimedUnderlyings(),
        max_open_boxes: this.cfg.liveMaxOpenBoxes,
        /**
         * The MODE-INDEPENDENT inventory ceiling and what it currently counts.
         *
         * Reported separately from `max_open_boxes` because the two are genuinely different controls:
         * that one is live-only and read after a position exists, this one is enforced at admission in
         * every mode. `held` counts committed exposure, not just established positions, so it can
         * exceed `open_boxes` while a partial entry is unresolved.
         */
        max_open_boxes_all_modes: this.cfg.maxOpenBoxes,
        box_inventory_held: this.boxInventoryCount(),
        open_boxes: this.positions.size,
        residual_legs: this.residualLegCount(),
        daily_loss_limit: this.cfg.liveDailyLossLimit,
        realised_pnl_today: live?.realisedPnlToday ?? null,
      },

      execution: {
        live_entry_submit_concurrency: this.cfg.liveEntrySubmitConcurrency,
        max_concurrent_executions: this.cfg.liveMaxConcurrentExecutions,
        /** GENERAL transport pacing: status polls, lists, positions, margins. */
        effective_broker_min_interval_ms: pacing.generalMinIntervalMs,
        /** ORDER-MUTATION pacing: place / modify / cancel. A real rate limit, never zero. */
        effective_broker_order_min_interval_ms: pacing.orderMutationMinIntervalMs,
        broker_order_interval_floor_ms: pacing.floorMs,
        broker_order_interval_source: pacing.source,
        broker_pacing_rationale: pacing.rationale,
        pacing_source_of_truth: pacing.source_of_truth,
        /** Worst-case pacing cost of the four-leg entry burst, without placing an order. */
        four_leg_burst_pacing_budget_ms: burstPacingBudgetMs(pacing, BOX_LEG_ROLES.length),
        entry_burst: this.orderManager?.entryBurstDiagnostics() ?? null,
        queued: live?.queued ?? 0,
        in_flight: live?.inFlight ?? 0,
        circuit: live?.health.circuit ?? "closed",
        /**
         * NO ARTIFICIAL LATENCY IS APPLIED TO LIVE EXECUTION.
         *
         * Stated as data rather than only in a comment so an operator can verify it from the API,
         * and so a regression test can assert it. The simulated values are reported alongside
         * precisely to show they belong to PAPER: they are not consulted on the live path.
         */
        artificial_latency_applied_to_live: false,
        paper_only_simulated_decision_ms: this.cfg.simulatedDecisionMs,
        paper_only_simulated_latency_ms: this.cfg.simulatedLatencyMs,
      },

      arm: {
        preconditions: armPreconditions,
        entry: evaluateLiveArm({ permission: "entryEnabled", pre: armPreconditions }),
        exposure_management: evaluateLiveArm({ permission: "liveOrderEnabled", pre: armPreconditions }),
        emergency_flatten: evaluateLiveArm({ permission: "emergencyFlatten", pre: armPreconditions }),
      },

      block_reason: sessionVerdict.reason,
      block_detail: sessionVerdict.detail,
    };
  }

  /**
   * Change the PAPER execution profile at runtime.
   *
   * Permitted because it creates no new capability: both profiles are simulations, and no
   * mutation-capable adapter is constructed either way. Refused while anything is in flight,
   * because changing the timing model under a running simulated execution would corrupt its
   * record. Refused outright in live mode — there is no paper profile to change there, and
   * pretending otherwise would imply live timing is configurable when it is not.
   */
  setPaperExecutionProfile(
    profile: BoxPaperProfile,
    actor: string | null,
  ): { ok: true; profile: BoxPaperProfile } | { ok: false; code: number; error: string; blockers?: unknown } {
    if (this.cfg.executionMode === "live") {
      return {
        ok: false,
        code: 409,
        error:
          "The paper execution profile cannot be changed in live mode. BOX_EXECUTION_MODE is a " +
          "startup-only construction boundary; crossing the paper/live boundary requires an " +
          "environment change and a restart.",
      };
    }
    if (profile === this.paperProfile) return { ok: true, profile };
    const from = currentSelection(this.cfg.executionMode, this.paperProfile);
    const to = currentSelection(this.cfg.executionMode, profile);
    // `currentSelection` collapses `standard` and `stress` onto the same selection, so a
    // standard<->stress change would look like a no-op to `evaluateModeTransition` and skip the
    // in-flight guard entirely. The real profile comparison above handles the genuine no-op; here
    // we force the guard to run whenever the PROFILE differs, even if the selection does not.
    const verdict = from === to
      ? (transitionBlockers(this.modeTransitionSnapshot()).length > 0 ||
          this.executionSim.activeCount > 0
          ? ({
              outcome: "refused",
              from,
              to,
              blockers: [
                ...transitionBlockers(this.modeTransitionSnapshot()),
                ...(this.executionSim.activeCount > 0
                  ? [{
                      code: "paper_simulation_in_flight",
                      detail: `${this.executionSim.activeCount} simulated execution(s) are in flight`,
                    }]
                  : []),
              ],
            } as const)
          : ({ outcome: "allowed", from, to } as const))
      : evaluateModeTransition({ from, to, snapshot: this.modeTransitionSnapshot() });
    if (verdict.outcome === "refused") {
      return {
        ok: false,
        code: 409,
        error: "The execution profile cannot be changed while executions or exposure are outstanding.",
        blockers: verdict.blockers,
      };
    }
    if (verdict.outcome === "restart_required") {
      return { ok: false, code: 409, error: verdict.detail };
    }
    this.paperProfile = profile;
    this.cfg.paperExecutionProfile = profile;
    console.warn(`[Box] paper execution profile changed to "${profile}" by ${actor ?? "unknown"}.`);
    return { ok: true, profile };
  }

  /**
   * Report what a requested execution-mode change would do, without doing it.
   *
   * The UI calls this to render an honest answer — including "restart required" and the exact
   * environment variables involved — instead of offering a selector that silently fails.
   */
  previewModeTransition(to: ExecutionModeSelection): ReturnType<typeof evaluateModeTransition> {
    return evaluateModeTransition({
      from: currentSelection(this.cfg.executionMode, this.paperProfile),
      to,
      snapshot: this.modeTransitionSnapshot(),
    });
  }

  /** Arm a trading session (Part 7). Full-admin only; enforced by the route. */
  async armTradingSession(args: {
    maxCompletedTrades?: number;
    /** Attempt ceiling for this session. Omitted ⇒ the configured default. */
    maxEntryAttempts?: number;
    actor: string | null;
  }): Promise<{ ok: true; session: unknown } | { ok: false; code: number; error: string }> {
    const live = this.orderManager?.status() ?? null;
    const armed = await this.session.arm({
      ...(args.maxCompletedTrades === undefined ? {} : { maxCompletedTrades: args.maxCompletedTrades }),
      ...(args.maxEntryAttempts === undefined ? {} : { maxEntryAttempts: args.maxEntryAttempts }),
      armedBy: args.actor,
      openBoxes: this.positions.size,
      residualLegs: this.residualLegCount(),
      recoveryActive: live?.recoveryActive ?? false,
    });
    if (!armed.ok) return { ok: false, code: 409, error: armed.reason };
    console.warn(
      `[Box] trading session armed by ${args.actor ?? "unknown"} with a limit of ` +
        `${armed.record.max_completed_trades === 0 ? "UNLIMITED" : armed.record.max_completed_trades} cycle(s) ` +
        `and ${armed.record.max_entry_attempts === 0 ? "UNLIMITED" : armed.record.max_entry_attempts} entry attempt(s). ` +
        `Attempts bound RISK-TAKING: an attempt that submits and is then unwound still spends one.`,
    );
    return { ok: true, session: this.sessionStatusPayload() };
  }

  /** Disarm the trading session. Counters are preserved, never cleared. */
  async disarmTradingSession(actor: string | null): Promise<{ ok: boolean; session: unknown }> {
    const ok = await this.session.disarm();
    if (ok) console.warn(`[Box] trading session disarmed by ${actor ?? "unknown"}.`);
    return { ok, session: this.sessionStatusPayload() };
  }

  /** The session status projection, using live activity. */
  private sessionStatusPayload(): unknown {
    const live = this.orderManager?.status() ?? null;
    return this.session.status({
      entryInProgress: this.executionSim.activeCount > 0,
      openBoxes: this.positions.size,
      exitInProgress: false,
      recoveryActive: live?.recoveryActive ?? false,
      entryBlockedExternally: live ? !live.controls.entryEnabled : true,
    });
  }

  getStatus() {
    const scanner = this.scanner.getStats();
    const live = this.orderManager?.status() ?? null;
    return {
      running: this.running,
      state: this.running
        ? this.marketOpen
          ? ("SCANNING" as const)
          : ("MARKET_CLOSED" as const)
        : ("STOPPED" as const),
      monitoring: true,
      /** False → prices shown are last-close and NOTHING can be entered. */
      market_open: this.marketOpen,
      /** When the last-close view was last rebuilt, and how many boxes it priced. */
      indicative_at: this.indicativeAt,
      indicative_priced: this.indicativePriced,
      /** The session the last-close prices come from, and legs dropped as stale. */
      indicative_session_day: this.indicativeSessionDay,
      indicative_stale_legs: this.indicativeStaleLegs,
      execution_mode: this.cfg.executionMode,
      /** The broker that owns the feed, the scanner and execution right now. */
      broker: this.deps.activeBroker(),
      /** Distinct brokers holding open exposure — normally just the active one. */
      brokers_with_open_positions: this.positions.brokersInUse(),
      authenticated: this.deps.marketData.isAuthenticated(),
      broker_auth_healthy: live ? live.health.broker_auth === "healthy" : null,
      broker_orders_api_healthy: live ? live.health.broker_orders_api === "healthy" : null,
      broker_positions_api_healthy: live ? live.health.broker_positions_api === "healthy" : null,
      market_data_healthy: this.isFeedHealthy(),
      /**
       * ORDER-UPDATE STREAM STATUS — deliberately adjacent to `market_data_healthy` because
       * that adjacency is the point: a healthy market-data feed is NOT evidence that fills are
       * observed promptly. Zerodha sends order updates as TEXT frames on the same socket that
       * carries binary ticks; Dhan uses an entirely separate order-update WebSocket. So this is
       * its own signal, and it names the mechanism currently responsible for seeing a fill.
       */
      order_stream: orderStreamStatus({
        brokers: ["zerodha", "dhan"],
        gateEnabled: (broker) =>
          broker === "zerodha" ? zerodhaOrderStreamEnabledFromEnv() : dhanOrderStreamEnabledFromEnv(),
        // The running consumer's CURRENT health is refreshed into the map on every read (see
        // refreshOrderStreamConsumerHealth), so this reflects reality: a broker with a live
        // consumer reports `armed` + its real projection health.
        consumers: this.refreshOrderStreamConsumerHealth(),
        /*
         * PAPER: absent is NOT_APPLICABLE, not broken.
         *
         * A paper process constructs no order-stream consumer BY DESIGN — building one implies a
         * live order manager, and a paper process must contain no object capable of touching a
         * real order. `orderStreamStatus` previously read "no consumer" as `not_wired`, whose
         * documented meaning is "this should be running and is not", and paired it with
         * `rest_polling_only`. So every paper deployment permanently reported a broken fast fill
         * path that was never meant to exist, and claimed REST polling for orders that are never
         * sent to a broker at all.
         */
        paperSimulated: this.cfg.executionMode !== "live",
      }),
      /**
       * THE EXECUTION FUNNEL (Task 8) — outcome counts with EXPLICIT denominators, from real
       * execution events (candidates at the scanner, qualified at the economic gate, terminal
       * entry outcomes at observeAttempt, completed exits at closePaperTrade). Every ratio carries
       * its denominator's basis; economic success is reported SEPARATELY from execution
       * completion; recovery costs and unresolved exposure are counted, never hidden.
       */
      execution_funnel: this.funnel.snapshot(),
      /**
       * The economic-admission decision (five distinct quantities), when a control is enabled.
       *
       * NULL means NO evidence gate is enabled, so nothing was read and NOTHING IS CLAIMED about
       * funding. That is deliberately not the same as "checked and sufficient", and clients render it
       * as such. When a gate IS enabled the decision carries a `funding_readiness` block naming the
       * funding state and the EFFECTIVE gate settings (see fundingReadiness.ts); a refusal also
       * appears as an entry-scoped blocker in `operational_readiness`.
       */
      economic_admission: this.economicAdmissionStatus(),
      // FREE CAPITAL, published continuously rather than as a side effect of an entry attempt.
      account_funds: this.accountFundsSnapshot(),
      /**
       * WHY ENTRIES ARE BEING REFUSED, PER UNDERLYING.
       *
       * Published in the status the dashboard already polls so the notification surface needs no
       * second request and no extra poll. This is the named-symbol counterpart to
       * `metrics.execution.rejection_categories`, which can only ever carry counts per reason.
       */
      entry_alerts: this.entryAlerts.snapshot(),
      database_healthy: isBoxDbEnabled() && (!live || live.health.persistence === "healthy"),
      daily_risk_seed_healthy: live ? live.health.daily_risk_seed === "healthy" : null,
      reconciliation_complete: live?.health.reconciliation_complete ?? true,
      unknown_orders: live?.unknownOrders ?? 0,
      recovery_active: live?.recoveryActive ?? false,
      circuit_state: live?.health.circuit ?? "closed",
      live_manager: live,
      db_enabled: isBoxDbEnabled(),
      started_at: this.startedAt,
      stopped_at: this.stoppedAt,
      universe_built_at: this.universeBuiltAt,
      /** The active strikes-each-side level (1, 2 or 3). */
      strike_level: this.strikeLevel,
      /**
       * THE OPERATOR BLOCKLIST, as it currently stands.
       *
       * Reported in the status the dashboard already polls, so the UI can badge an excluded row
       * without a second request, and so `readable: false` is visible as a REASON new entry is
       * refused rather than being an unexplained absence of trades.
       */
      excluded_underlyings: this.listExcludedUnderlyings(),
      underlyings: this.windows.size,
      candidates: this.scanner.candidateCount,
      /**
       * THE UNIVERSE PIPELINE DIAGNOSIS — why the scanner is or is not evaluating.
       *
       * `underlyings` above is `this.windows.size`, which is `0` both when the instrument dump came
       * back empty and when the market is simply quiet. This block names the FIRST stage that
       * stopped, publishes the count behind every stage so the verdict can be checked rather than
       * trusted, and separates "the operator pressed RUN" (`running`) from "the engine can actually
       * evaluate a box" (`universe.ready_to_evaluate`).
       */
      universe: this.universeReadiness(),
      monitored_tokens: this.scanner.monitoredTokenCount,
      subscribed_option_tokens: this.subscribedOptionTokens.size,
      subscribed_spot_tokens: this.subscribedSpotTokens.size,
      /**
       * THE SHARED/FUTURES LANE, named as such.
       *
       * `hub_connected` is the SHARED board feed, which with `BOX_DEDICATED_MARKET_FEED=true` (the
       * default) is a DIFFERENT socket from the one carrying box quotes. Publishing only this made a
       * connected board lane read as proof the box lane was up. `box_lane_connected` below is the
       * socket the box engine's books actually come from.
       */
      hub_subscribed: this.deps.feed.subscribedCount(),
      hub_connected: this.deps.feed.isConnected(),
      /** The BOX lane's own socket — the one that carries the option depth this engine trades on. */
      box_lane_connected: this.marketDataSocketConnected,
      /** True when the box lane is a separate socket from the shared board feed. */
      box_lane_dedicated: this.cfg.boxDedicatedMarketFeed,
      quotes: this.quotes.size,
      quote_updates: this.quotes.updateCount,
      /** Preserved field: now correctly reports RAW current-socket tick age. */
      feed_age_ms: this.feedAgeMs(),
      raw_tick_age_ms: this.feedAgeMs(),
      book_observation_age_ms: this.bookObservationAgeMs(),
      executable_books: this.quotes.size,
      executable_book_diagnostics: this.quotes.diagnostics(),
      feed_healthy: this.isFeedHealthy(),
      /**
       * The DRIVEN market-data health state (GAP 1). Distinct from `feed_healthy` (a raw-tick
       * liveness boolean): this reports the state machine that gates NEW ENTRY on READY and only
       * reaches READY with fresh usable depth per traded instrument in the current generation.
       */
      market_data_state: this.marketDataState(),
      market_data_health: this.marketDataMachine.diagnostics(),
      /**
       * SECTION 7 — THE ONE AUTHORITATIVE READINESS DECISION.
       *
       * The two blocks above (`market_data_state`, `order_stream`) are RAW FACTS about two
       * independent transports. This is the single VERDICT derived from them, and it is the field a
       * client must render rather than recombining the facts itself.
       *
       * It exists because readiness was previously answered in three places that did not agree: here
       * (raw transports), `GET /api/runtime/status` (`live_entry.blocked`, computed from env/DB/token
       * facts that did not include either transport), and the frontend (its own matrix, derived from
       * market-data readiness plus one reconcile flag). Both HTTP surfaces are now projections of
       * THIS decision, and it carries its own generation/version/timestamp so a client can detect a
       * stale or out-of-order response instead of rendering it as current.
       */
      operational_readiness: this.operationalReadiness(),
      /**
       * APPROXIMATE lag behind the exchange, from Kite's second-resolution
       * exchange_timestamp. Distinct from feed_age_ms (a liveness heartbeat):
       * this estimates how stale the data itself is versus NSE. null until a
       * timestamped packet has been seen.
       */
      exchange_lag_ms: this.exchangeLag(),
      open_positions: this.positions.size,
      /**
       * DEGRADED: something the engine owns could not be persisted or flattened
       * and is being retried (a filled box awaiting its Mongo insert, or residual
       * exposure from a failed unwind). A clean run reports false. Never hidden —
       * "tests pass" must never be read as "flat and healthy" when it is not.
       */
      degraded: this.computeDegraded(),
      pending_unpersisted_fills: this.pendingPersists.length,
      owned_unpersisted: this.pendingPersists.length,
      residual_exposure_count: this.residualByAttempt.size,
      residual_exposure_legs: this.residualLegCount(),
      residual_flatten_in_flight: this.residualFlattenInFlight.size,
      /** Bounded per-attempt risk bookkeeping. Observability only; never a control input. */
      risk_bookkeeping: this.riskBookkeepingDiagnostics(),
      partially_exited_positions: this.positions.list().filter((p) => p.position_state === "PARTIALLY_EXITED").length,
      /** Running day P&L: open positions' current net + today's realised net. */
      day_pnl: this.computeDayPnl(),
      skipped_for_budget: this.skippedForBudget.length,
      skipped_symbols: this.skippedForBudget.slice(0, 25),
      /**
       * Skipped by BOX_MAX_UNDERLYINGS — a DIFFERENT limit from the one above.
       *
       * Published separately because they were previously merged, which told the operator that 214
       * names were outside a 2200-token feed budget that in fact had room for all of them, while the
       * setting genuinely responsible was never mentioned. `max_underlyings` is echoed so the UI can
       * name the value to change instead of describing the symptom.
       */
      skipped_for_underlying_cap: this.skippedForUnderlyingCap.length,
      skipped_underlying_cap_symbols: this.skippedForUnderlyingCap.slice(0, 25),
      max_underlyings: this.cfg.maxUnderlyings,
      /**
       * Left out of the LAST-CLOSE PREVIEW by its own cap
       * (BOX_INDICATIVE_MAX_UNDERLYINGS) — a display limit while the market is
       * shut, unrelated to the live-feed token budget above.
       */
      skipped_indicative_cap: this.skippedForIndicativeCap.length,
      skipped_indicative_symbols: this.skippedForIndicativeCap.slice(0, 25),
      indicative_max_underlyings: this.cfg.indicativeMaxUnderlyings,
      scanner: {
        ...scanner,
        // Execution simulation headline figures the operator watches.
        simulated_entries_attempted: scanner.executionsAttempted,
        simulated_entries_filled: scanner.entriesOpened,
        simulated_entries_failed:
          scanner.rejectedExecution + scanner.rejectedLiquidity + scanner.rejectedNetProfit,
        active_execution_pipelines: this.executionSim.activeCount,
      },
      monitor: this.monitor.getStats(),
      charges: this.charges.getStats(),
      reconciliation: this.reconciler.getStats(),
      /** Rolling latency / slippage / throughput distributions (bounded rings). */
      metrics: this.metrics.snapshot(),
      last_error: this.lastError,
      config: this.getConfig(),
    };
  }

  /**
   * The raw BoxConfig, for collaborators that must build broker adapters from it.
   *
   * Distinct from `getConfig()`, which is the UI's curated view. Exposed read-only so
   * the broker registry can construct an execution adapter with the same limits the
   * engine is running under, without re-reading the environment (which could have
   * drifted from what this process actually loaded).
   */
  getConfigRaw(): BoxConfig {
    return this.cfg;
  }

  /** Live exposure, for the broker-switch guard. Cheap: all in-memory. */
  exposureSummary(): {
    scannerRunning: boolean;
    openPositions: number;
    brokersWithOpenPositions: BrokerId[];
    workingOrders: number;
    executionInFlight: boolean;
    reconciliationComplete: boolean;
    residualLegs: number;
    unknownOrders: number;
  } {
    const live = this.orderManager?.status() ?? null;
    return {
      scannerRunning: this.running,
      openPositions: this.positions.size,
      brokersWithOpenPositions: this.positions.brokersInUse(),
      // In-flight + queued is the honest "still working" count the manager exposes.
      workingOrders: live ? live.inFlight + live.queued : 0,
      // A simulated pipeline counts too: deleting the feed under an in-flight paper
      // entry would leave the attempt unable to resolve.
      //
      // The COORDINATOR is consulted as well, and that is a real widening. A pipeline
      // is only "active" once the simulator owns it, so an execution parked in the
      // conflict wait — and a reservation still held because a terminal broker state
      // was ambiguous — used to be invisible to the broker-switch guard. Both hold
      // contracts in the OUTGOING broker's namespace, so switching under them is
      // exactly what creates a stale-generation worker.
      executionInFlight: this.executionSim.activeCount > 0 || this.coordinator.holdsReservations,
      reconciliationComplete: live?.health.reconciliation_complete ?? true,
      residualLegs: this.residualLegCount(),
      unknownOrders: live?.unknownOrders ?? 0,
    };
  }

  /**
   * Drop every cached book and bump the feed generation.
   *
   * Called on a broker switch. This is what guarantees a Zerodha depth ladder can
   * never price a Dhan decision: the quote store is emptied and every token's
   * warm-generation marker is invalidated, so nothing is treated as executable until
   * the NEW broker has published a fresh book for it.
   */
  /**
   * Drop every contract reservation.
   *
   * Called on a broker switch: the keys are namespaced by broker, so a surviving
   * Zerodha reservation is meaningless to Dhan and would only be able to block a
   * legitimate execution until its TTL expired.
   */
  async clearInstrumentReservations(): Promise<void> {
    await this.coordinator.resetForBrokerSwitch();
    // FORGET THE BALANCE TOO. It was read from the OUTGOING broker, and leaving it on screen under
    // the incoming broker's name would attribute one account's free capital to another. The poller
    // restarts on the next boot pass and re-reads against the new session.
    this.stopAccountFundsTimer(true);
    this.ensureAccountFundsTimer();
    // FORGET THE REFUSALS TOO, for the same reason the balance is forgotten: they were decided
    // against the OUTGOING broker's session, budget and positions. Carrying "NIFTY refused —
    // session budget spent" across a switch would attribute one account's constraints to another.
    this.entryAlerts.reset();
  }

  /**
   * Ticks from the DEDICATED BOX LANE.
   *
   * Deliberately the same code path as the shared-feed listener, so a Box quote is
   * processed identically however it arrived and the two feed topologies cannot drift.
   * What differs is only the source socket — and therefore the token budget the Box
   * universe is competing for, which is the entire point of the split.
   */
  ingestBoxLaneTicks(ticks: Tick[]): void {
    this.onTicks(ticks);
  }

  /**
   * The Box lane's socket changed state.
   *
   * Bumps the feed generation exactly as a shared-feed reconnect does, so no book
   * cached before the reconnect can be treated as warm and therefore executable.
   */
  onBoxLaneConnection(connected: boolean): void {
    this.marketDataSocketConnected = connected;
    this.invalidateFeedGeneration();
    this.driveMarketDataConnection(connected);
    this.driveZerodhaOrderStreamConnection(connected);
    if (!connected) this.lastError = "box market-data lane disconnected";
    else this.lastMarketDataTransportFault = null;
  }

  /**
   * A TRANSPORT HEARTBEAT arrived on the box lane (keep-alive / non-tick frame).
   *
   * WHAT THIS DELIBERATELY DOES NOT DO. It does not touch `lastRawTickAt`, does not enter anything
   * into the quote store, does not stamp `tokenFeedGeneration`, and does not flip `feedHealthy`.
   * A keep-alive proves a route to the broker is alive and proves NOTHING about any instrument's
   * book. Letting it refresh depth timestamps or warm an instrument would let a feed delivering no
   * books at all report itself executable — the exact failure the four separate time facts exist
   * to make impossible.
   *
   * It advances only the machine's heartbeat/frame clocks, which is what allows a genuinely quiet
   * market to stay `transportLive` without ever becoming READY on stale books.
   */
  onBoxLaneHeartbeat(): void {
    this.marketDataMachine.onHeartbeat();
  }

  /**
   * The box lane hit a reconnectable transport fault. Recorded, never escalated.
   *
   * Explicitly NOT routed to {@link onMarketDataSessionLost}: that drives the terminal AUTH_EXPIRED
   * state, and a network blip is not evidence that a token is dead. A reconnect is already
   * scheduled by the feed.
   */
  onBoxLaneTransportFault(reason: string): void {
    this.lastMarketDataTransportFault = reason;
    this.lastError = `box market-data transport fault (recovering): ${reason}`;
  }

  /**
   * A REPLACEMENT market-data credential was installed, so clear a terminal AUTH_EXPIRED verdict.
   *
   * Driven from the broker registry's login / token-refresh / broker-switch paths. This is the only
   * thing permitted to clear AUTH_EXPIRED — no data event may, because a tick arriving on a socket
   * the broker already rejected proves nothing about the credential. Without this the machine
   * stayed terminally expired for the life of the process even after a successful re-login, and
   * because that blocker's scope is `both` it also kept reporting exposure management as blocked.
   */
  onMarketDataSessionRestored(reason: string): void {
    this.marketDataMachine.onSessionRestored();
    // The books from the dead session are not evidence for the new one.
    this.invalidateFeedGeneration();
    this.lastError = `market-data session restored (${reason}); reconnecting`;
  }

  /**
   * Where the box engine's quotes are coming from RIGHT NOW.
   *
   * Reported rather than assumed, so the "real broker WebSocket quotes" claim is always backed by
   * the same evidence the payload publishes. A REST snapshot (indicative/last-close view) is a
   * documented fallback and is labelled as such — never as executable streaming depth.
   */
  private marketDataSource(): MarketDataSource {
    if (this.marketDataSocketConnected) return "broker_websocket";
    // Not connected, but the last-close / indicative REST view may still be populating the screen.
    // `indicativeAt` is set only by `refreshIndicative`, which prices from REST snapshots.
    if (this.indicativeAt !== null) return "rest_snapshot_fallback";
    return "none";
  }

  /**
   * Drive the ZERODHA ORDER-STREAM lifecycle from the SAME quote-socket connection (D6).
   *
   * Per the verified broker docs (docs/BROKER_STREAM_DOCS.md), Zerodha multiplexes order postbacks
   * as TEXT frames onto the very quote socket that carries the ticks — there is no separate order
   * socket to open. So the order-stream health machine must be driven by the quote socket's
   * lifecycle, exactly as the market-data machine is. Before this the Zerodha consumer only ever
   * received `onConnecting()` and was stuck at CONNECTING, causing orderStreamStatus to under-claim
   * the account as rest_polling_only even while postbacks were resolving waiters.
   *
   * A `connected=true` edge stands for "socket open AND authorised" (the box lane only opens once
   * it holds credentials). We therefore walk CONNECTING → socket-open → authenticated, which puts
   * the machine in RECONCILING, and then DRIVE the post-(re)connect gap-repair sweep (D4) to
   * completion — only after which the machine reaches READY. A `connected=false` edge is a
   * disconnect: exposure management and protective cancel continue, new entry stops, and a missing
   * postback is never read as a zero fill. Inert unless a Zerodha consumer exists and its stream is
   * armed; Dhan drives its own DEDICATED order socket via createDhanOrderFeed and is untouched here.
   */
  private driveZerodhaOrderStreamConnection(connected: boolean): void {
    const consumer = this.orderStreamConsumer;
    if (!consumer) return;
    if (this.deps.activeBroker() !== "zerodha") return;
    if (!zerodhaOrderStreamEnabledFromEnv()) return;
    // Delegate the multiplexed-socket semantics to the consumer. In production we do not block the
    // socket callback on the reconciliation promise; the consumer fails open internally.
    void consumer.driveQuoteSocketLifecycle(connected);
  }

  /**
   * Drive the MARKET-DATA health machine from a coarse feed connection change.
   *
   * The feed provider only surfaces a connected boolean (the socket lifecycle lives inside the
   * lane feed / TickerHub), so a `connected=true` edge stands for "socket open AND authorised" —
   * the feed only opens once it holds credentials, and both broker feeds guard their handlers on
   * generation so a superseded socket can never emit. We therefore walk the machine through
   * CONNECTING → socket-open → authenticated (which advances the generation and drops prior
   * readiness), leaving it SYNCHRONIZING until fresh depth per instrument arrives via `onTicks`.
   * A `connected=false` edge is a disconnect: exposure management and protective cancel continue,
   * new entry stops, and a missing book is never read as a zero. AUTH_EXPIRED is reached only via
   * {@link onMarketDataSessionLost}, never inferred from a plain disconnect.
   */
  private driveMarketDataConnection(connected: boolean): void {
    if (connected) {
      this.marketDataMachine.onConnecting();
      this.marketDataMachine.onSocketOpen();
      this.marketDataMachine.onAuthenticated();
      // Publish the CURRENT desired traded instruments so readiness is measured against the real
      // subscription intent, not a stale set from the previous generation.
      this.marketDataMachine.setDesiredInstruments(this.subscribedOptionTokens);
    } else {
      this.marketDataMachine.onDisconnected();
    }
  }

  /**
   * The market-data feed reported a session/token rejection (a dead or expired token).
   *
   * Distinct from a transient disconnect: reconnecting with a rejected token is pointless and the
   * broker will refuse everything but a cancel, so the machine goes AUTH_EXPIRED and NO data event
   * can revive it. Wired to the lane feed's `onDead`/`onSessionLost` callback by the registry.
   */
  onMarketDataSessionLost(reason: string): void {
    this.marketDataMachine.onSessionLost();
    this.lastError = reason;
  }

  /**
   * WHY THE SCANNER IS OR IS NOT EVALUATING CANDIDATES.
   *
   * Assembles every observation the universe pipeline recorded and hands them to the pure
   * {@link assessUniverseReadiness}, which names the FIRST stage that stopped. This is the answer to
   * the failure that started all of this: `instruments()` returned `[]` for Zerodha, so the board,
   * the chains, the windows, the candidates and the subscriptions were all empty — and the only
   * published figure was `underlyings: 0`, which is indistinguishable from a quiet market.
   *
   * `readyToEvaluate` is deliberately NOT `running`: the operator's intent and the engine's
   * capability are different facts, and publishing only the former is what let `SCANNING` sit above
   * a completely empty universe for an entire session.
   */
  universeReadiness(): UniverseReadiness {
    const mdDiag = this.marketDataMachine.diagnostics();
    return assessUniverseReadiness({
      scannerRunning: this.running,
      authenticated: this.deps.marketData.isAuthenticated(),
      instrumentLoad: this.instrumentLoadState,
      instrumentsError: this.instrumentsError,
      instrumentCount: this.instrumentCount,
      instrumentsLoadedAt: this.instrumentsLoadedAt,
      instrumentLoadFailures: this.instrumentLoadFailures,
      boardRows: this.boardRowsDerived,
      chainsIndexed: this.chainsIndexed,
      boardWithChains: this.boardWithChains,
      underlyingsMissingSpot: this.underlyingsMissingSpot,
      spotSeedFailed: this.spotSeedFailed,
      spotSeedError: this.spotSeedError,
      windowsBuilt: this.windows.size,
      candidates: this.scanner.candidateCount,
      desiredOptionSubscriptions: this.subscribedOptionTokens.size,
      boxSocketConnected: this.marketDataSocketConnected,
      // A subscribe frame was WRITTEN. Not an acknowledgement — this broker sends none, so usable
      // depth (below) is the only real confirmation and is reported separately.
      subscriptionsRequested: this.subscribedOptionTokens.size > 0,
      framesObserved: mdDiag.frames,
      depthObservations: mdDiag.depthObservations,
      usableBooks: this.quotes.size,
      lastSuccessfulBuildAt: this.lastSuccessfulBuildAt,
    });
  }

  /** The current driven market-data health state (GAP 1). For status and the entry gate. */
  marketDataState(): MarketDataState {
    // Force the age-based demotions no discrete event would trigger (a heartbeat gap or a book
    // that quietly aged past its bound), then report.
    return this.marketDataMachine.evaluate();
  }

  /**
   * The current driven ORDER-STREAM lifecycle state (D1). For status and the combined entry gate.
   *
   * When no consumer exists (paper deployments) the order stream is DISABLED, which the
   * combinedPermissions table treats as "does not block" — REST polling is the baseline. When a
   * consumer exists, this first drives the idleness clock (D5) so a connected-but-not-delivering
   * stream is demoted to DEGRADED before the gate reads it, then reports the machine's state.
   */
  orderStreamState(): OrderStreamLifecycleState {
    const consumer = this.orderStreamConsumer;
    if (!consumer) return "DISABLED";
    const nowWall = this.executionClock.wall();
    consumer.evaluateIdle(nowWall);
    // DRIVE AN OWED RECONCILIATION TOWARDS COMPLETION FROM A PLACE THAT IS ACTUALLY CALLED.
    // A connection edge is the only other trigger, and on a stable socket that edge may not recur for
    // hours — so a sweep that failed once (a transient REST error, a throttle) would otherwise leave
    // the stream stuck refusing entry with no path back. This is cheap, self-guarding, coalesced onto
    // any sweep already running, and rate-limited by the consumer's bounded backoff, so polling it
    // from the gate/status path cannot turn recovery into a REST flood.
    consumer.ensureReconciled(nowWall);
    return consumer.lifecycleState();
  }

  /**
   * Refresh the running consumer's CURRENT health into the status map and return it.
   *
   * The map is what `orderStreamStatus` reads. Snapshotting the live health here — rather than at
   * construction — is what makes the status track reality: a stream that has gone DOWN, or a
   * reconnect that is still RECONCILING, is reported as it actually is, not as it was when the
   * consumer was built.
   */
  private refreshOrderStreamConsumerHealth(): ReadonlyMap<BrokerId, OrderStreamHealth> {
    const consumer = this.orderStreamConsumer;
    if (consumer) this.orderStreamConsumers.set(this.deps.activeBroker(), consumer.health());
    return this.orderStreamConsumers;
  }

  /* ═════════════════════ SECTION 7: THE ONE AUTHORITATIVE READINESS DECISION ═════════════════════ */

  /**
   * SECTION 7 — the source of blockers the ENGINE cannot see for itself.
   *
   * Env gates, PostgreSQL availability, migration state and per-broker token readiness live in
   * `src/index.ts`, not in the engine. Before this seam existed, `GET /api/runtime/status` combined
   * THOSE facts into its own `live_entry.blocked` while the engine combined the TRANSPORT facts into
   * its own entry gate — two verdicts on one question, each blind to half the evidence. Injecting
   * them here means both surfaces are projections of ONE decision.
   *
   * Fail-safe by design: a throwing provider yields a BLOCKER, never silence. "We could not check"
   * must never render as "nothing is wrong".
   */
  private externalReadinessBlockers: (() => readonly ReadinessBlocker[]) | null = null;

  /** Monotonic per-decision counter, so a client can discard an out-of-order response. */
  private readinessDecisionGeneration = 0;
  /**
   * WHICH PROCESS this is, and where it sits in the restart order.
   *
   * `readinessDecisionGeneration` above is process-local and resets on restart, so on its own it
   * cannot order readiness decisions across one — a browser holding generation 5000 rejected a
   * restarted backend's generation 1 indefinitely. The instance carries a restart-durable ordinal
   * minted by PostgreSQL, which is what makes "newer" mean something. See box/backendInstance.ts.
   */
  private readonly backendInstance = new BackendInstance();
  /** Retry handle for the durable boot-ordinal claim. Null once it settles. */
  private bootOrdinalTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Register the external blocker source. Called once during boot from `src/index.ts`.
   *
   * Deliberately a setter rather than a constructor dependency: the engine is constructed before the
   * token service and the pool are known, and a required constructor dep would have forced a
   * placeholder that silently reported "no blockers" for the whole of boot.
   */
  setExternalReadinessBlockers(source: () => readonly ReadinessBlocker[]): void {
    this.externalReadinessBlockers = source;
  }

  /**
   * THE ONE READINESS DECISION — consumed by `getStatus()` (the dashboard/SSE) AND by
   * `GET /api/runtime/status` (the operator endpoint), so the two cannot disagree.
   *
   * It reads the SAME `marketDataState()` and `orderStreamState()` the live-entry checkpoint reads,
   * and scores them through the SAME `combinedPermissions` table, so the published permission is the
   * permission actually enforced. Note the ORDER of the reads: `orderStreamState()` drives the
   * idleness clock, so it must be called BEFORE the consumer's health is snapshotted — otherwise the
   * decision could carry a lifecycle one poll staler than the health beside it.
   */
  /**
   * The published `economic_admission` leaf.
   *
   * NULL is preserved exactly as before when no evidence gate is enabled — that is the honest
   * "nothing was checked, nothing is claimed" signal, and clients already render it that way. When a
   * decision DOES exist it is enriched with the funding-readiness block, which names the state
   * (`verified` / `refused`) and the EFFECTIVE gate settings including the stage-funding implication.
   * `economic_admission` is an OPEN contract leaf, so adding this field needs no schema change.
   */
  private economicAdmissionStatus(): (EconomicAdmissionReport & { funding_readiness: FundingReadiness }) | null {
    const gateway = this.centralGateway;
    if (!gateway) return null;
    const report = gateway.economicDiagnostics();
    if (!report) return null;
    return {
      ...report,
      funding_readiness: gateway.fundingReadiness(brokerFundingLimitations(this.deps.activeBroker())),
    };
  }

  operationalReadiness(): OperationalReadinessDecision {
    // Drive both machines' age-based demotions FIRST, then read everything from the settled states.
    const marketDataState = this.marketDataState();
    const orderStreamLifecycle = this.orderStreamState();
    const consumer = this.orderStreamConsumer;
    const health = consumer?.health() ?? null;
    const mdDiag = this.marketDataMachine.diagnostics();
    const live = this.orderManager?.status() ?? null;
    const activeBroker = this.deps.activeBroker();

    // The published order-stream snapshot for the ACTIVE broker, so the decision's fill-observation
    // mechanism is literally the same value the `order_stream` block publishes.
    const published = orderStreamStatus({
      brokers: [activeBroker],
      gateEnabled: (broker) =>
        broker === "zerodha" ? zerodhaOrderStreamEnabledFromEnv() : dhanOrderStreamEnabledFromEnv(),
      consumers: this.refreshOrderStreamConsumerHealth(),
      // Same paper labelling as the `order_stream` block above, so the readiness decision and the
      // published status can never disagree about the fill mechanism.
      paperSimulated: this.cfg.executionMode !== "live",
    }).brokers[0];

    // External blockers, fail-safe: an unavailable provider is a BLOCKER, never an all-clear.
    let external: readonly ReadinessBlocker[] = [];
    if (this.externalReadinessBlockers) {
      try {
        external = this.externalReadinessBlockers();
      } catch {
        external = [
          {
            code: "readiness_evidence_unavailable",
            scope: "entry",
            detail:
              "The runtime readiness evidence (token, database, migration and gate state) could not " +
              "be read. Entry is refused because unverified is not the same as verified.",
          },
        ];
      }
    }

    // Blockers the ENGINE itself owns and the runtime endpoint never saw.
    const engineBlockers: ReadinessBlocker[] = [];
    // A DECISION THAT CANNOT BE ORDERED IS NOT A PERMISSION.
    //
    // Without a durable boot ordinal, no client can tell this process's verdict from a superseded
    // process's verdict, so "entry permitted" from here is unverifiable. Rather than rely on every
    // client to notice the null and refuse it — which would make safety depend on the frontend
    // getting it right — the SERVER refuses entry itself, which is the only place the refusal is
    // authoritative. Exposure management is untouched: not being able to ORDER a verdict is no reason
    // to stop reducing risk.
    if (!this.backendInstance.hasOrdinal()) {
      engineBlockers.push({
        code: "instance_epoch_unknown",
        scope: "entry",
        detail:
          "This backend process has no durable boot ordinal, so its readiness decisions cannot be " +
          "ordered against a previous process and a client cannot tell this verdict from a stale one. " +
          `New entry is refused until it is established. ${this.backendInstance.ordinalError() ?? "It has not been claimed yet."}`,
      });
    }
    if (!this.running) {
      engineBlockers.push({
        code: "scanner_stopped",
        scope: "entry",
        detail:
          "The scanner is STOPPED, so no new box will be entered. Existing positions continue to be " +
          "monitored and can still be exited, reduced and protectively cancelled.",
      });
    }
    if (!this.marketOpen) {
      engineBlockers.push({
        code: "market_closed",
        scope: "entry",
        detail: "The exchange is closed: prices shown are last-close and nothing can be entered.",
      });
    } else {
      /*
       * THE SESSION IS OPEN BUT THE ENTRY WINDOW MAY NOT BE.
       *
       * Reported separately from `market_closed` because the operator's question is different: an
       * open market that refuses new boxes is either warming up, past the cutoff, or running on a
       * calendar year this build has no holiday data for. Reporting all three as "market closed"
       * would be a lie that hides a configuration problem.
       *
       * Scope is ENTRY in every case. Exits, protective cancels and residual flattening are
       * deliberately unaffected — the cutoff exists so exposure stays reducible for longer than it
       * is creatable, so turning it into a `both`-scoped blocker would invert its purpose.
       */
      const entryWindow = evaluateSessionEntryWindow({
        at: this.executionClock.wall(),
        cutoffMinutesBeforeClose: this.cfg.entryCutoffMinutesBeforeClose,
        warmupMinutesAfterOpen: this.cfg.sessionWarmupMinutesAfterOpen,
      });
      if (!entryWindow.allowed && entryWindow.refusal !== null) {
        engineBlockers.push({
          code: entryWindow.refusal,
          scope: "entry",
          detail:
            `${entryWindow.detail ?? "new entry is outside the session entry window"}. ` +
            `Existing positions are still monitored, exitable and protectively cancellable.`,
        });
      }
    }
    /*
     * THE BLOCKLIST IS UNREADABLE. Scoped `entry`, never `both`: not knowing which names are
     * forbidden makes taking NEW exposure unsafe, but it must never be a reason the exposure this
     * process already holds cannot be reduced. Worded like `residual_state_unknown` above, because it
     * is the same shape of problem — unknown is not the same as none.
     */
    if (!this.exclusions.readable) {
      engineBlockers.push({
        code: "underlying_exclusions_unreadable",
        scope: "entry",
        detail:
          `The excluded-underlyings blocklist could not be READ ` +
          `(${this.exclusions.loadError ?? "it has not been loaded yet"}), so no name can be confirmed ` +
          `tradable and no new box is entered. Exits, reductions and protective cancels continue, and ` +
          `the read is retried automatically.`,
      });
    }
    if (live && !live.controls.entryEnabled) {
      engineBlockers.push({
        code: "entry_disabled",
        scope: "entry",
        detail: "The live ENTRY control is disarmed. Exposure management is unaffected by it.",
      });
    }
    if (live?.recoveryActive) {
      engineBlockers.push({
        code: "recovery_active",
        scope: "entry",
        detail:
          "A crash-recovery pass is still resolving previously-unknown orders. New entry waits until " +
          "the picture is whole; reduction of known exposure does not.",
      });
    }
    if ((live?.unknownOrders ?? 0) > 0) {
      engineBlockers.push({
        code: "reconciliation_incomplete",
        scope: "entry",
        detail:
          `${live?.unknownOrders} order(s) are not yet reconciled with the broker. Their fills are ` +
          `unknown, not zero, so no new exposure is taken on top of them.`,
      });
    }
    /*
     * RESIDUAL STATE UNREADABLE. Scoped `entry`, not `both`: not knowing what residual exposure
     * exists makes taking NEW exposure unsafe, but it must never be a reason the exposure this
     * process already holds cannot be reduced. Worded after `readiness_evidence_unavailable` — the
     * point is that unverified is not the same as verified.
     */
    if (this.residualRecoveryLoadError !== null) {
      engineBlockers.push({
        code: "residual_state_unknown",
        scope: "entry",
        detail:
          `Outstanding residual exposure could not be READ (${this.residualRecoveryLoadError}). ` +
          `Unknown is not the same as none, so no new exposure is taken until it is established. ` +
          `Reduction of known exposure continues, and the read is retried automatically.`,
      });
    }
    /*
     * RECOVERY ESCALATION. A MORE PRECISE REASON for a refusal that is already happening.
     *
     * Every condition below already blocks new entry inside
     * `BoxOrderManager.entryBlockReasonAfterControls`, so this adds NO new enforcement — two gates for
     * one condition can disagree, and an operator then cannot tell which is in force. What it adds is
     * the distinction between "recovery is in progress" and "recovery has been stuck for longer than
     * the operator said was acceptable", plus the bounded numbers behind it.
     *
     * Derived, never stored, so it clears itself the moment the underlying state resolves. Entry-scoped
     * for the usual reason: the readiness scope filter cannot route it to the reduction verdict, and
     * nothing here flattens, cancels or reverses anything because a timer expired.
     */
    const escalation = deriveRecoveryEscalation({
      nowWall: this.executionClock.wall(),
      escalateAfterMs: this.cfg.liveRecoveryEscalationMs,
      oldestResidualCreatedAtWall: this.oldestResidualCreatedAtWall(),
      firstObservedUnresolvedAtWall: this.recoveryUnresolvedSinceWall,
      residualLegCount: this.residualLegCount(),
      unknownOrderCount: live?.unknownOrders ?? 0,
      unattendedWorkingOrderCount: live?.unattendedWorkingOrders ?? 0,
      reconciliationComplete: live?.health.reconciliation_complete ?? true,
      recoveryActive: live?.recoveryActive ?? false,
      crashRecoveryQuarantined: live?.crashRecoveryEntryQuarantined ?? false,
      residualStateUnknown: this.residualRecoveryLoadError !== null,
      residualAttemptIds: [...this.residualByAttempt.keys()],
    });
    // Start or clear the process-local mark in the SAME pass that evaluated the conditions, so the
    // two can never disagree about whether anything is unresolved.
    this.recoveryUnresolvedSinceWall = escalation.unresolved
      ? (this.recoveryUnresolvedSinceWall ?? this.executionClock.wall())
      : null;
    /*
     * §12 RESIDUAL ECONOMIC OBSERVABILITY, attached where it is most decision-relevant.
     *
     * Computed only when an escalation is actually being reported, so a healthy deployment pays nothing
     * for it. NOTIONAL, never a loss or risk estimate: an option position's loss can exceed it or fall
     * well below it, and nothing here computes which. UNKNOWN rather than zero whenever a price is
     * missing, stale or unusable — see `residualNotional.ts`.
     *
     * `quoteMaxAgeMs` is the repository's existing "is this quote usable for a decision" policy rather
     * than a threshold invented here; the strict supervised profile sets it to 3000ms.
     */
    const escalationBlocker = recoveryEscalationBlocker(
      escalation,
      escalation.escalated
        ? residualNotionalSummary(
            deriveResidualNotional({
              legs: [...this.residualByAttempt.values()].flat(),
              price: (token) => {
                const quote = this.quotes.get(token);
                return quote === undefined ? undefined : { last: quote.last, at: quote.at };
              },
              nowWall: this.executionClock.wall(),
              maxPriceAgeMs: this.cfg.quoteMaxAgeMs,
            }),
          )
        : null,
    );
    if (escalationBlocker !== null) engineBlockers.push(escalationBlocker);
    /*
     * EXPOSURE THIS PROCESS MUST NOT EXECUTE. Scoped `reduction` — the most serious scope — because
     * that is precisely what it means: a real position or residual is on, and this process is the
     * wrong kind of process to close it. Naming it is the whole point; the previous behaviour was to
     * exit it under the wrong regime without a word.
     */
    const foreignResiduals = this.residualOwnershipMismatches();
    const mismatchedPositions = [...this.modeMismatchedPositions.values()];
    if (foreignResiduals.length > 0 || mismatchedPositions.length > 0) {
      const parts = [
        ...mismatchedPositions,
        ...foreignResiduals.map((m) => m.reason),
      ].slice(0, 3);
      engineBlockers.push({
        code: "execution_mode_mismatch",
        scope: "reduction",
        detail:
          `${mismatchedPositions.length} restored position(s) and ${foreignResiduals.length} residual ` +
          `attempt(s) were created under a different execution mode or broker than this process, so it ` +
          `must not trade against them: ${parts.join(" | ")}` +
          (mismatchedPositions.length + foreignResiduals.length > parts.length ? " …" : ""),
      });
    }
    /*
     * EXPOSURE WE RECONSTRUCTED BUT NOTHING OWNS — see `unownedAttributedExposure()` for the full
     * reasoning. This is REPORTING only; the SAME call is the coordinator's `orphanedExposureGate`
     * dep, which is what actually refuses admission. Reporting it here without enforcing it there
     * was the original defect: the verdict was correct and nothing acted on it.
     */
    const unownedBlocker = this.unownedAttributedExposure();
    if (unownedBlocker !== null) engineBlockers.push(unownedBlocker);

    // FUNDING ADMISSION, surfaced in the ONE authoritative readiness decision.
    //
    // Previously a funding refusal existed only inside the OPEN `economic_admission` blob, so the
    // readiness verdict — the thing a client is required to render — never mentioned it. These
    // blockers are emitted ONLY when a gate is ENABLED and the last decision REFUSED: disabled gates
    // deliberately produce none, because turning the default-off configuration into a trading stop
    // would change a deployment's controls rather than report on them (that state is reported as
    // `checks_disabled` by `fundingReadiness()` and reviewed via `node dist/box/effectiveConfig.js`).
    //
    // Every one is `scope: "entry"`, so an account that cannot fund a NEW box can still exit,
    // reduce and protectively cancel the exposure it already holds.
    if (this.centralGateway) {
      engineBlockers.push(
        ...fundingReadinessBlockers(
          this.centralGateway.fundingReadiness(brokerFundingLimitations(activeBroker)),
        ),
      );
    }

    return buildOperationalReadiness({
      now: this.executionClock.wall(),
      decisionGeneration: ++this.readinessDecisionGeneration,
      // The ordering identity travels WITH the decision it orders, so a client never has to
      // correlate two responses to work out which process spoke.
      instance: this.backendInstance.identity(),
      /*
       * The durable store's health, so the reduction verdict cannot claim exits are available while
       * the write that precedes every broker order would fail. Both signals are needed:
       * `isBoxDbEnabled()` is the pool latch (probed once at init), and `health.persistence` is the
       * observed-write-outcome latch that catches a mid-session outage the pool latch misses.
       * `"unknown"` (no write attempted yet) is passed through as-is and is not read as an outage.
       */
      persistence: {
        durableStoreReady: isBoxDbEnabled(),
        durableWrites: live ? live.health.persistence : "unknown",
      },
      identity: {
        broker: activeBroker,
        // `brokerAccountRef` is already documented as a NON-SECRET reference (masked id / hash,
        // never a token). It is masked AGAIN inside the builder so there is exactly one masking rule
        // for the wire, and so a future provider that returns something less redacted cannot leak.
        account: this.deps.brokerAccountRef?.() ?? null,
        executionMode: this.cfg.executionMode,
        liveRuntimeArmed: live ? live.controls.entryEnabled || live.controls.liveOrderEnabled : false,
        deploymentLiveCapable: this.cfg.executionMode === "live",
      },
      marketData: {
        state: marketDataState,
        generation: mdDiag.generation,
        desiredInstruments: mdDiag.desired,
        readyInstruments: mdDiag.readyInstruments,
        /*
         * AGES, ALREADY COMPUTED IN THE MONOTONIC DOMAIN.
         *
         * This used to pass `lastFrameAt` / `lastHeartbeatAt` / `lastDepthAt` — MONOTONIC readings
         * (`executionClock.mono()`) — into a builder whose `now` is `executionClock.wall()`. The
         * builder subtracted them, so every published market-data age was roughly the Unix epoch
         * in milliseconds: ~1.7e12 ms, about 55 years. Always positive, so the `Math.max(0, …)`
         * floor could not even expose it, and a dashboard had no choice but to render it as
         * garbage or as "never observed" — which is precisely the "last frame never observed"
         * symptom, appearing even while ticks were arriving normally.
         *
         * The machine now computes these ages itself, inside the one clock domain that stamped
         * them, and no longer exposes the raw monotonic timestamps at all — so the mixed-domain
         * subtraction is not merely corrected here, it is unavailable to any caller.
         */
        frameAgeMs: mdDiag.frameAgeMs,
        heartbeatAgeMs: mdDiag.heartbeatAgeMs,
        depthAgeMs: mdDiag.depthAgeMs,
        // Wall stamps travel alongside for audit/display. Never subtracted from anything.
        lastFrameWallAt: mdDiag.lastFrameWallAt,
        lastHeartbeatWallAt: mdDiag.lastHeartbeatWallAt,
        lastDepthWallAt: mdDiag.lastDepthWallAt,
        frames: mdDiag.frames,
        heartbeats: mdDiag.heartbeats,
        depthObservations: mdDiag.depthObservations,
        backlog: mdDiag.backlog,
        source: this.marketDataSource(),
        socketConnected: this.marketDataSocketConnected,
        authenticated: this.deps.marketData.isAuthenticated(),
        // Subscriptions have been REQUESTED once the engine has pushed a non-empty desired set at
        // the lane. Deliberately not "confirmed": Zerodha sends no subscription ack, so claiming
        // confirmation would be an assumption. Confirmation is evidenced by depth arriving.
        subscriptionsRequested: this.subscribedOptionTokens.size > 0,
        usableBooks: this.quotes.size,
      },
      orderStream: {
        lifecycle: orderStreamLifecycle,
        publishedState: health?.state ?? "DISABLED",
        wiring: published?.wiring ?? "not_wired",
        gateEnabled: published?.gate_enabled ?? false,
        connected: health?.connected ?? false,
        authorised: health?.authorised ?? false,
        lastEventAt: health?.lastEventAt ?? null,
        disconnects: health?.disconnects ?? 0,
        reconcilePending: consumer?.reconcilePending() ?? false,
        fillsObservedBy:
          published?.fills_observed_by ??
          // No published status for the active broker. Under paper the honest default is the
          // simulator, NOT REST polling: nothing is sent to a broker, so nothing is polled for.
          (this.cfg.executionMode === "live" ? "rest_polling_only" : "simulated_paper_fills"),
      },
      paperExecution: {
        simulated: this.cfg.executionMode !== "live",
        profile: this.cfg.executionMode === "live" ? null : this.cfg.executionMode,
        // The simulator prices against the live quote store, so it is using streamed quotes exactly
        // when the feed has actually delivered depth in the current generation. Claiming otherwise
        // from an open socket is the conflation this whole payload exists to prevent.
        usingStreamedQuotes: this.cfg.executionMode !== "live" && mdDiag.depthObservations > 0,
      },
      blockers: [...engineBlockers, ...external],
      openExposure: {
        openPositions: this.positions.size,
        residualLegs: this.residualLegCount(),
        workingOrders: consumer?.workingOrderCount() ?? 0,
      },
    });
  }

  /**
   * A Kite order-update TEXT frame arrived on the box lane's quote socket.
   *
   * PRODUCTION WIRING for the Zerodha fast fill path. The frame is parsed by `parseKiteOrderFrame`
   * and, when it is an order postback, routed into the order-stream consumer's single projection
   * and thence the live adapter's `applyOrderUpdate` (which wakes the order's waiter). Error/message
   * frames and unparseable input are ignored — a bad postback must never disturb the market-data
   * socket that carries the ticks the whole strategy depends on.
   *
   * D2 — THE FLAG GATES THE OBSERVATION PATH, NOT A LABEL. When `ZERODHA_ORDER_STREAM_ENABLED` is
   * unset (the safe default), the frame is DROPPED HERE, before it is parsed or enqueued: no
   * postback is consumed, no order waiter is ever resolved by the stream, and fills are observed by
   * REST polling only — exactly what `orderStreamStatus` reports as the mechanism in force. Arming
   * the flag turns the observation path on; disarming it turns the path off, not just the label.
   * Inert unless a consumer exists AND the Zerodha stream is armed.
   */
  ingestBoxLaneOrderText(raw: string): void {
    if (!this.orderStreamConsumer) return;
    // OBSERVATION-PATH GATE (D2): unless the flag is armed, Zerodha postbacks are NOT consumed —
    // they are discarded here (as ticker.ts did before this path existed) and REST polling remains
    // the sole fill-observation mechanism. This is what makes the flag control the capability, not
    // merely relabel it.
    if (!zerodhaTextFramesConsumed()) return;
    // KEEP THE WS CALLBACK LIGHTWEIGHT: enqueue the raw frame and return. Parsing and ingestion
    // happen off the socket callback in a bounded microtask pump, so a slow projection/analytics
    // stage can never block the socket that also carries the market-data ticks. The order-event
    // queue is NEVER-DROP, so a burst is retained and delivered, never silently discarded.
    this.ingestPipeline.enqueue("order_events", raw, "order_events");
    this.scheduleIngestPump();
  }

  /** Parse + ingest ONE order-event frame. Runs in the drain pump, never inside the WS callback. */
  private processOrderEventFrame(raw: string): void {
    const consumer = this.orderStreamConsumer;
    if (!consumer) return;
    const frame = parseKiteOrderFrame(raw);
    if (frame.type === "order" && frame.observation) {
      consumer.ingestStreamObservation(frame.observation);
    }
    // A `message`/`error`/`unknown` frame carries no fill evidence; it is intentionally dropped —
    // this is dropping a NON-order informational frame, NOT an order event.
  }

  /**
   * Schedule ONE bounded drain of the ingestion pipeline on a microtask.
   *
   * Coalesced: overlapping enqueues share a single scheduled pump, so a burst of frames does not
   * spawn a pump each. The drain is bounded (drains the queued snapshot and returns), never leaves
   * a dangling timer, and clears the backlog signal once the order-event queue is no longer
   * overloaded so new entry can resume.
   */
  private scheduleIngestPump(): void {
    if (this.ingestPumpScheduled) return;
    this.ingestPumpScheduled = true;
    queueMicrotask(() => {
      void this.ingestPipeline
        .pumpUntilIdle({ stages: ["order_events"] })
        .catch(() => undefined)
        .finally(() => {
          this.ingestPumpScheduled = false;
          // Once the order-event queue has drained back within its threshold, lift the backlog
          // signal so NEW ENTRY can resume (exposure management was never blocked).
          if (!this.ingestPipeline.stage("order_events").isOverloaded()) {
            this.marketDataMachine.onProcessingBacklog(false);
          }
        });
    });
  }

  /**
   * Best-effort active broker account (Kite user_id / Dhan client id), used as the default account
   * on ownership registration for foreign-account rejection. Returns null when the process cannot
   * name its own account without extra session plumbing — in which case attribution rests on the
   * per-order tag/correlationId (unique per order and attempt) and the observation's own account is
   * still checked against any account a registration DID carry.
   */
  private liveBrokerAccount(): string | null {
    /*
     * THE VERIFIED ACCOUNT, from the authenticated session.
     *
     * This was `return this.deps.marketData.isAuthenticated() ? null : null;` — a ternary whose two
     * branches are identical, so it returned null unconditionally. Combined with the hard-coded
     * `account: null` at both order-stream ownership registrations, NO live order ever carried an
     * account, the projection's `foreign_account` rejection could never fire, and attribution rested
     * entirely on the per-order tag.
     *
     * The identity was already in the process the whole time: `ActiveBrokerManager.sessionFor(broker)`
     * projects `client_id` from the Zerodha login's `user_id` (or the Dhan client id), and
     * `deps.brokerAccountRef` was already wired to it in `src/index.ts` for margin-evidence
     * attribution. It simply was never handed to the order path.
     *
     * Authentication is still required: an unauthenticated session must not name an account, because
     * the token that proved it may already have been replaced.
     *
     * WHAT NULL ACTUALLY BLOCKS. New live ENTRY, and only that (`BoxOrderManager.entryBlockReason`).
     * It does NOT block reduction — this comment previously said it blocked both, which was wrong.
     * The distinction is deliberate and load-bearing: this method requires
     * `marketData.isAuthenticated()`, a MARKET-DATA property, so it can return null while the trading
     * session is perfectly healthy (Dhan with `DHAN_DATA_ENABLED=false`; a Zerodha stored-session
     * adoption that leaves session metadata unset). Making the flatten path depend on that would
     * strand real exposure on an unrelated feed condition. Account identity is instead enforced where
     * it constitutes evidence — the send boundary and each durable row — and only ever refuses on
     * proof of a DIFFERENT account, never on an unknown one.
     */
    if (!this.deps.marketData.isAuthenticated()) return null;
    const account = this.deps.brokerAccountRef?.() ?? null;
    if (account === null) return null;
    const trimmed = String(account).trim();
    return trimmed === "" ? null : trimmed;
  }

  /**
   * START the order-stream transports for the active broker, if the stream is armed.
   *
   * Zerodha needs nothing started here — its postbacks ride the existing box quote socket via
   * `ingestBoxLaneOrderText`, forwarded by the registry's `onBoxLaneOrderText`. Dhan needs its
   * DEDICATED order socket opened (`wss://api-order-update.dhan.co`), constructed by the registry
   * against the CURRENT token. Idempotent and safe to call after live construction.
   */
  private startOrderStreamTransports(): void {
    const consumer = this.orderStreamConsumer;
    if (!consumer) return;
    const broker = this.deps.activeBroker();
    if (broker === "zerodha") {
      // Nothing to open: the box quote socket already carries the postbacks. If armed, the
      // consumer's health machine advances as the box lane connects; on connect the box lane
      // reports through onBoxLaneConnection and the postback path is live automatically.
      if (zerodhaOrderStreamEnabledFromEnv()) {
        consumer.onConnecting();
      }
      return;
    }
    // Dhan: open the dedicated order-update socket via the registry-provided factory.
    if (broker === "dhan" && dhanOrderStreamEnabledFromEnv() && this.deps.createDhanOrderFeed && !this.dhanOrderFeed) {
      // THE LIFECYCLE WIRING IS THE ONE IN box/dhanOrderStreamWiring.ts, not a copy of it.
      // It was inline here, and what it omitted was any call to `runReconnectReconciliation()` — so
      // every Dhan connection entered RECONCILING (which `onAuthenticated` always owes) and never
      // left, because `markSynchronized` is the only exit. Live entry was therefore refused forever
      // with `feed_unhealthy`. It is extracted so a test can drive the EXACT production handlers with
      // a fake socket; a test could not reach this method, which is why the gap went unnoticed.
      const feed = this.deps.createDhanOrderFeed(
        createDhanOrderStreamHandlers(consumer, {
          nowMono: () => this.executionClock.mono(),
          nowWall: () => this.executionClock.wall(),
        }),
      );
      if (feed) {
        this.dhanOrderFeed = feed;
        feed.start();
      }
    }
  }

  invalidateBooks(): void {
    this.invalidateFeedGeneration();
    // Broker-switch-only transport ownership reset. Executable state is already
    // cleared by every generation invalidation above.
    this.subscribedOptionTokens.clear();
    this.subscribedSpotTokens.clear();
  }

  /** Force a universe rebuild for the newly active broker. */
  async reloadUniverse(): Promise<void> {
    this.forceWindowRebuild = true;
    await this.refreshUniverse();
  }

  /** Push the current snapshot to every SSE client immediately. */
  publishNow(): void {
    this.publish();
  }

  getOpportunities(limit?: number): BoxOpportunity[] {
    return this.scanner.listOpportunities(limit ?? this.cfg.maxPublishedOpportunities);
  }

  /** Recent paper_legging execution attempts that did not open a box. */
  async listExecutionAttempts(limit = 100) {
    return loadBoxExecutionAttempts(limit);
  }

  /* ------------------------------- day P&L -------------------------------- */

  /** Reset the closed-today tally when the IST trading day rolls over. */
  private rollClosedTodayDay(): void {
    const today = this.deps.istDayKey();
    if (this.closedTodayDay !== today) {
      const previous = this.closedTodayDay;
      this.closedTodayDay = today;
      this.closedTodayCount = 0;
      this.closedTodayNet = 0;
      this.closedTodayGross = 0;
      this.closedTodayMargin = 0;
      this.closedTodayMarginUnknown = 0;
      // Yesterday's trades are history now: they belong to the Mongo-backed view,
      // not to today's fast list.
      this.closedTodayTrades = [];
      // NOT marked loaded. A genuine midnight roll starts an empty day, but this
      // same branch runs on the first request after a failed boot seed, where an
      // empty list means "not read yet" and the read tiers must still be tried.
      // Only a real load sets closedTodayLoadedFor.
      this.closedTodayLoadedFor = previous === "" ? this.closedTodayLoadedFor : today;
    }
  }

  /** Put one just-closed trade at the head of today's fast list, de-duplicated. */
  private recordClosedToday(trade: SerializedBoxTrade): void {
    this.closedTodayTrades = [
      trade,
      ...this.closedTodayTrades.filter((t) => t.id !== trade.id),
    ];
  }

  /**
   * Seed the closed-today tally AND today's fast trade list from Mongo (called at
   * boot and on a day roll).
   *
   * This is the one full read of today's closed set; from here on the list is
   * maintained incrementally, so the Closed-trades tab never queries Mongo again
   * for today.
   */
  private async refreshClosedTodayFromDb(): Promise<void> {
    const day = this.deps.istDayKey();
    const rows = await loadBoxTradesClosedSince(istDayStartMs(day));
    let count = 0;
    let net = 0;
    let gross = 0;
    let margin = 0;
    let marginUnknown = 0;
    for (const r of rows) {
      count++;
      net += r.realised_net_pnl ?? r.net_pnl ?? 0;
      gross += r.gross_pnl ?? 0;
      if (r.margin === null || r.margin === undefined) marginUnknown++;
      else margin += r.margin;
    }
    this.closedTodayDay = day;
    this.closedTodayCount = count;
    this.closedTodayNet = net;
    this.closedTodayGross = gross;
    this.closedTodayMargin = margin;
    this.closedTodayMarginUnknown = marginUnknown;

    this.closedTodayTrades = rows.map((r) => liteClosedTrade(serializeBoxTrade(r)));
    this.closedTodayLoadedFor = day;
    // Mirror the seed so a later restart can skip this query entirely.
    if (this.closedTodayTrades.length > 0) {
      void this.closedCache
        .writeTrades(day, this.closedTodayTrades)
        .catch(() => {/* best-effort accelerator */});
    }
  }

  /**
   * TODAY's closed trades — the Closed-trades tab's fast path.
   *
   * Three tiers, fastest first:
   *   1. in process (the normal case: seeded at boot, appended to on every close);
   *   2. Redis (a restart mid-session: one round trip, no Mongo);
   *   3. Mongo, narrowed to `closed_at >= IST midnight` (the fallback, and still
   *      far cheaper than the whole-book query this replaced).
   *
   * Earlier days are deliberately NOT served here — they stay on the full-history
   * route, where a slower load is acceptable.
   */
  async getClosedToday(): Promise<{
    trades: SerializedBoxTrade[];
    source: "memory" | "postgres" | "none";
    day: string;
  }> {
    this.rollClosedTodayDay();
    const day = this.closedTodayDay;

    // Answered from the warm in-process list: no database, no Redis, no I/O.
    // Reported as "memory" because that is the tier that served THIS request —
    // reporting the provenance of the list instead would label every read after a
    // boot seed as "mongo" while it was in fact costing nothing.
    if (this.closedTodayLoadedFor === day) {
      return { trades: this.closedTodayTrades, source: "memory", day };
    }

    // Redis holds whatever was mirrored, which after a partially-applied pipeline
    // may be a SUBSET of the day. Trust it only when it is at least as complete as
    // the tally says the day is; otherwise fall through to Mongo, which is the one
    // source that is definitionally complete.
    try {
      const cached = await this.closedCache.readDay(day);
      if (cached.length > 0 && cached.length >= this.closedTodayCount) {
        this.closedTodayTrades = cached;
        this.closedTodayLoadedFor = day;
        return { trades: cached, source: "postgres", day };
      }
      if (cached.length > 0) {
        console.warn(
          `[Box] closed-today cache holds ${cached.length} of ${this.closedTodayCount} ` +
            `trade(s) for ${day} — falling back to Mongo.`,
        );
      }
    } catch (err) {
      console.warn("[Box] closed-today cache read failed:", err);
    }

    // The SAME query the boot seed uses: narrowed to today and deliberately
    // UNLIMITED. A cap here could truncate the list while the tally kept counting,
    // recreating the "the strip says 164, the tab shows fewer" disagreement.
    const rows = await loadBoxTradesClosedSince(istDayStartMs(day));
    const fromDb = rows.map((r) => liteClosedTrade(serializeBoxTrade(r)));

    // Only ADOPT the database's answer if it is at least as complete as what is
    // already held. With the box connection down this query returns [] rather than
    // throwing, and overwriting the in-process list with that would DELETE trades
    // closed in this session from the view — a cache miss must never lose data.
    if (fromDb.length >= this.closedTodayTrades.length) {
      this.closedTodayTrades = fromDb;
      // Only trust it as "loaded for today" when the store was actually readable;
      // otherwise leave the tiers to be retried on the next request.
      if (isBoxDbEnabled()) this.closedTodayLoadedFor = day;
      // Re-mirror, so the next restart gets the fast path back.
      if (fromDb.length > 0) {
        void this.closedCache
          .writeTrades(day, fromDb)
          .catch(() => {/* best-effort accelerator */});
      }
    }
    return { trades: this.closedTodayTrades, source: "postgres", day };
  }

  /** Whether the Redis accelerator for today's closed trades is live. */
  isClosedCacheEnabled(): boolean {
    return this.closedCache.enabled();
  }

  /**
   * The running day P&L: open positions' current net + today's realised net.
   *
   * Cheap — the open side reads each position's already-computed metrics and the
   * closed side is an in-memory tally, so no database is touched on a status read.
   */
  private computeDayPnl() {
    this.rollClosedTodayDay();
    let openNet = 0;
    let openGross = 0;
    let openCount = 0;
    let openMargin = 0;
    let openMarginUnknown = 0;
    for (const pos of this.positions.list()) {
      openCount++;
      const m = pos.metrics;
      if (m) {
        openNet += m.current_net_pnl ?? 0;
        openGross += m.gross_pnl_if_closed_now ?? 0;
      }
      // Zerodha's basket margin for the four legs, captured just after entry. Null
      // when that call never succeeded, which must be reported rather than counted
      // as zero — otherwise a failed margin fetch silently understates the total.
      if (pos.margin === null || pos.margin === undefined) openMarginUnknown++;
      else openMargin += pos.margin;
    }
    // A same-instant sample of concurrently-blocked margin — the only honest input
    // to a peak. Never fabricated for periods before this process was running.
    if (openMargin > 0 && (this.peakConcurrentMargin === null || openMargin > this.peakConcurrentMargin)) {
      this.peakConcurrentMargin = openMargin;
    }
    const cachedSummary = this.pnlArchiver.getLastSummary();
    return {
      day: this.closedTodayDay,
      open_count: openCount,
      open_running_net_pnl: round2(openNet),
      open_running_gross_pnl: round2(openGross),
      closed_count: this.closedTodayCount,
      closed_realised_net_pnl: round2(this.closedTodayNet),
      closed_realised_gross_pnl: round2(this.closedTodayGross),
      /** Open running net + today's realised net — the day's running total (₹). */
      total_net_pnl: round2(openNet + this.closedTodayNet),
      total_gross_pnl: round2(openGross + this.closedTodayGross),
      /**
       * MARGIN DEPLOYED TODAY (₹) — the basket margin Zerodha blocked for these
       * boxes, summed.
       *
       * `open_margin_used` is currently blocked; `closed_margin_used` is what
       * today's already-closed boxes had blocked while they were on. Their sum is
       * the margin the day's box trading consumed in total — note it is a SUM over
       * the day, not a peak concurrent figure: boxes that opened and closed at
       * different times never held their margin simultaneously, so the total is an
       * upper bound on what was blocked at any one instant.
       */
      open_margin_used: round2(openMargin),
      closed_margin_used: round2(this.closedTodayMargin),
      /** @deprecated Kept for existing dashboards: identical to cumulative_trade_margin. */
      total_margin_used: round2(openMargin + this.closedTodayMargin),
      /** Explicit SUM over the day — never a concurrent/peak figure. See total_margin_used. */
      cumulative_trade_margin: round2(openMargin + this.closedTodayMargin),
      /**
       * Highest OPEN margin actually observed at any sampled instant since this
       * process started. Null until a first open-margin sample exists; never
       * reconstructed for time before the process was running.
       */
      peak_concurrent_margin: this.peakConcurrentMargin === null ? null : round2(this.peakConcurrentMargin),
      /** Boxes whose margin call never returned, so they are absent from the sums. */
      margin_unknown_count: openMarginUnknown + this.closedTodayMarginUnknown,
      /** Whether the Redis P&L cache is actively mirroring this figure. */
      cache_enabled: this.pnlCache.enabled(),
      last_cached_at: cachedSummary ? cachedSummary.updated_at : null,
    };
  }

  /** Map the live open positions to the P&L cache's input shape. */
  private openPnlInputs(): OpenPnlInput[] {
    return this.positions.list().map((pos) => {
      const m = pos.metrics ?? this.monitor.measure(pos);
      return {
        id: pos.id,
        underlying: pos.underlying,
        direction: pos.direction ?? "LONG_BOX",
        lower_strike: pos.lower_strike,
        upper_strike: pos.upper_strike,
        expiry: pos.expiry,
        opened_at: new Date(pos.opened_at).toISOString(),
        gross_pnl: m.gross_pnl_if_closed_now,
        net_pnl: m.current_net_pnl,
        realisable_net_pnl: m.realisable_net_pnl,
      };
    });
  }

  /** Map trades closed since `sinceMs` to the P&L cache's input shape. */
  private async closedPnlInputs(sinceMs: number): Promise<ClosedPnlInput[]> {
    const rows = await loadBoxTradesClosedSince(sinceMs);
    return rows.map((doc) => ({
      id: doc._id.toString(),
      underlying: doc.underlying,
      direction: directionOf(doc),
      lower_strike: doc.lower_strike,
      upper_strike: doc.upper_strike,
      expiry: doc.expiry,
      opened_at: doc.opened_at.toISOString(),
      closed_at: doc.closed_at ? doc.closed_at.toISOString() : null,
      gross_pnl: doc.gross_pnl ?? null,
      net_pnl: doc.net_pnl ?? null,
      realised_net_pnl: doc.realised_net_pnl ?? null,
    }));
  }

  /**
   * The ATM±3 option chain of one underlying with the box legs marked.
   *
   * Only the seven monitored strikes are returned — this is not a general option
   * chain endpoint.
   */
  getChain(underlying: string) {
    const state = this.windows.get(underlying.toUpperCase());
    if (!state) return null;
    const now = Date.now();
    const openKeys = this.positions.openKeys();

    // Which legs belong to a detected/open box, so the UI can mark them.
    const marks = new Map<string, Set<string>>();
    const addMark = (token: number, label: string) => {
      const key = String(token);
      const set = marks.get(key) ?? new Set<string>();
      set.add(label);
      marks.set(key, set);
    };
    for (const opp of this.scanner.opportunitiesFor(state.underlying)) {
      const isOpen = openKeys.has(opp.key);
      const relevant =
        isOpen || opp.status === "ELIGIBLE" || opp.status === "PAPER_OPENED" || opp.status === "LIVE_OPENED" || opp.status === "UNPRICED";
      if (!relevant) continue;
      for (const leg of opp.legs) {
        addMark(leg.token, `${leg.side}_${leg.instrument_type}`);
      }
    }

    const rows = state.strikes.map((strike) => {
      const ce = state.ce.get(strike);
      const pe = state.pe.get(strike);
      const ceQ = ce ? this.quotes.get(ce.token) : undefined;
      const peQ = pe ? this.quotes.get(pe.token) : undefined;
      return {
        strike,
        is_atm: strike === state.atm_strike,
        ce: ce
          ? {
              token: ce.token,
              tradingsymbol: ce.tradingsymbol,
              bid: ceQ?.bid ?? 0,
              bid_qty: ceQ?.bid_qty ?? 0,
              ask: ceQ?.ask ?? 0,
              ask_qty: ceQ?.ask_qty ?? 0,
              last: ceQ?.last ?? 0,
              age_ms: ceQ ? now - ceQ.at : null,
              marks: [...(marks.get(String(ce.token)) ?? [])],
            }
          : null,
        pe: pe
          ? {
              token: pe.token,
              tradingsymbol: pe.tradingsymbol,
              bid: peQ?.bid ?? 0,
              bid_qty: peQ?.bid_qty ?? 0,
              ask: peQ?.ask ?? 0,
              ask_qty: peQ?.ask_qty ?? 0,
              last: peQ?.last ?? 0,
              age_ms: peQ ? now - peQ.at : null,
              marks: [...(marks.get(String(pe.token)) ?? [])],
            }
          : null,
      };
    });

    return {
      underlying: state.underlying,
      name: state.name,
      is_index: state.is_index,
      expiry: state.expiry,
      lot_size: state.lot_size,
      quantity: state.lot_size,
      atm_strike: state.atm_strike,
      strike_step: state.strike_step,
      spot: state.spot,
      spot_age_ms: now - state.spot_at,
      strikes: rows,
    };
  }

  /** Underlyings that currently have a monitored window. */
  listChainSymbols(): { underlying: string; name: string; is_index: boolean; expiry: string }[] {
    return [...this.windows.values()].map((w) => ({
      underlying: w.underlying,
      name: w.name,
      is_index: w.is_index,
      expiry: w.expiry,
    }));
  }

  /** Live view of the open positions, with the current exit arithmetic. */
  getOpenPositions() {
    return this.positions.list().map((pos) => {
      const m = pos.metrics ?? this.monitor.measure(pos);
      const direction = pos.direction ?? "LONG_BOX";
      return {
        id: pos.id,
        key: pos.key,
        // The position's OWN mode/broker, not the engine's current config, so an
        // adopted trade is never mislabelled after a switch.
        execution_mode: pos.execution_mode,
        broker: pos.broker,
        underlying: pos.underlying,
        name: pos.name,
        is_index: pos.is_index,
        expiry: pos.expiry,
        direction,
        lower_strike: pos.lower_strike,
        upper_strike: pos.upper_strike,
        box_width: pos.box_width,
        lot_size: pos.lot_size,
        quantity: pos.quantity,
        opened_at: new Date(pos.opened_at).toISOString(),
        margin: pos.margin,
        entry_box_cost: round2(pos.entry_box_cost_per_unit * pos.lot_size),
        entry_gross_edge: pos.entry_gross_edge,
        entry_charges: pos.entry_charges_total,
        estimated_exit_charges_at_entry: pos.estimated_exit_charges_total,
        safety_buffer: pos.safety_buffer,
        entry_net_edge: pos.entry_net_edge,
        expected_net_profit: pos.expected_net_profit ?? null,
        entry_execution_cost: pos.entry_execution_cost ?? null,
        charge_origin: pos.charge_origin ?? "local",
        entry_legs: BOX_LEG_ROLES.map((role) => ({
          role,
          side: entrySideFor(role, direction),
          tradingsymbol: pos.legs[role].tradingsymbol,
          strike: pos.legs[role].strike,
          instrument_type: pos.legs[role].instrument_type,
          entry_price: pos.entry_prices[role],
        })),
        exit_legs: m.legs.map((l) => ({
          role: l.role,
          side: l.side,
          tradingsymbol: l.tradingsymbol,
          price: l.price,
          bid: l.bid,
          bid_qty: l.bid_qty,
          ask: l.ask,
          ask_qty: l.ask_qty,
          age_ms: l.age_ms,
          executable: l.executable,
          fresh: l.fresh,
        })),
        exit_box_value: m.exit_box_value,
        gross_pnl: m.gross_pnl_if_closed_now,
        current_exit_charges: m.estimated_exit_charges,
        total_charges: m.total_round_trip_charges,
        net_pnl: m.current_net_pnl,
        realisable_net_pnl: m.realisable_net_pnl,
        estimated_execution_cost: m.estimated_execution_cost,
        remaining_edge: m.remaining_edge,
        /** Convergence progress the UI shows to make "is it converging" obvious. */
        entry_edge: m.entry_edge,
        captured_edge: m.captured_edge,
        captured_pct: m.captured_pct,
        time_in_trade_ms: m.time_in_trade_ms,
        convergence_threshold: m.convergence_threshold,
        min_exit_net_pnl: m.min_exit_net_pnl,
        profit_capture_target: m.profit_capture_target,
        min_captured_pct: m.min_captured_pct,
        liquidity_ok: m.liquidity_ok,
        worst_age_ms: m.worst_age_ms,
        exit_eligible: m.exit_eligible,
        exit_reason: m.exit_reason,
        /** What the rules say even when the market cannot currently fill it. */
        exit_rule_reason: m.rule_reason,
        /** Why it is being held, or why an eligible exit is blocked. */
        blocked_reason: m.blocked_reason,
        exit_blocked_reason: pos.exit_blocked_reason,
        expiry_safety: pos.expiry_safety,
        status: "open" as const,
      };
    });
  }

  /* ---------------------------------- SSE --------------------------------- */

  addSseClient(res: Response): () => void {
    const client: SseClient = { res };
    this.sseClients.add(client);
    if (!this.publishTimer) {
      this.publishTimer = setInterval(() => this.publish(), this.cfg.publishIntervalMs);
      this.publishTimer.unref?.();
    }
    this.writeFrame(client, "snapshot", this.snapshot());
    return () => {
      this.sseClients.delete(client);
      // `maybeReleaseFeed` now guards residuals itself; this pre-check is kept in step with it so
      // the two can never disagree about whether the feed is still needed.
      if (
        this.sseClients.size === 0 &&
        !this.running &&
        this.positions.size === 0 &&
        this.residualLegCount() === 0
      ) {
        this.maybeReleaseFeed();
      }
    };
  }

  private snapshot() {
    return {
      status: this.getStatus(),
      opportunities: this.getOpportunities(),
      open_trades: this.getOpenPositions(),
    };
  }

  /**
   * Push the current state to the UI on a slow cadence (a few times a second).
   * The frontend is a visualization surface — it never participates in a trading
   * decision, so it does not need every exchange tick.
   */
  private publish(): void {
    if (this.sseClients.size === 0) return;
    const payload = this.snapshot();
    for (const client of this.sseClients) this.writeFrame(client, "snapshot", payload);
  }

  private broadcast(event: string, payload: unknown): void {
    for (const client of this.sseClients) this.writeFrame(client, event, payload);
  }

  private writeFrame(client: SseClient, event: string, payload: unknown): void {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // Broken pipe — the request's own close handler removes the client.
    }
  }

  /** Called when the Zerodha session dies: drop live state, keep positions. */
  onSessionLost(): void {
    this.invalidateFeedGeneration();
    this.quotes.clear();
    this.spots.clear();
    this.scanner.clearOpportunities();
    this.lastError = "The Zerodha session ended — live box data is unavailable.";
  }

  /** Test/diagnostic accessors. */
  get scannerRef(): BoxScanner {
    return this.scanner;
  }
  get monitorRef(): BoxPositionMonitor {
    return this.monitor;
  }
  get quotesRef(): BoxQuoteStore {
    return this.quotes;
  }
  get positionsRef(): BoxPositionBook {
    return this.positions;
  }
}

export type { SerializedBoxTrade };
