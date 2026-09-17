/**
 * The paper EXECUTION SIMULATOR.
 *
 * WHY IT EXISTS
 *
 * `paper_touch` records a fill at the touch that was visible in the DETECTION
 * snapshot. That is useful — it isolates the strategy's edge from execution
 * quality — but it is optimistic in a specific, knowable way: it assumes the book
 * is unchanged between spotting a four-leg mispricing and an order reaching the
 * exchange. For a mispricing that exists precisely because someone is about to
 * correct it, that assumption is the whole question.
 *
 * `paper_latency` answers it with evidence instead of a fudge factor:
 *
 *   detection snapshot
 *     → simulated decision/processing delay      (BOX_SIMULATED_DECISION_MS)
 *     → simulated order-send timestamp
 *     → simulated exchange arrival               (BOX_SIMULATED_LATENCY_MS)
 *     → wait for the FIRST WebSocket book each leg publishes at/after arrival
 *     → evaluate the four legs on the books that actually existed then
 *     → measure slippage per leg against the detected touch
 *     → re-qualify on those executed prices
 *     → fill, or refuse with a specific reason
 *
 * There is NO invented slippage percentage anywhere in this module. Every price it
 * records was published by the exchange after the simulated order could have
 * arrived. Correspondingly, if a leg publishes nothing in the wait window there is
 * no evidence of what it would have filled at, so nothing is filled — recorded as
 * `missing_book` rather than quietly reusing the stale detection price.
 *
 * DESIGN CONSTRAINTS
 *
 *   - The hot detection path must stay fast. Only candidates that already cleared
 *     qualification enter this pipeline, and each one runs at most once at a time.
 *   - The clock and the sleep are INJECTED, so the whole pipeline is
 *     deterministically testable without real timers.
 *   - Full five-level depth is captured only here (at the fill) and never per
 *     candidate per tick.
 */

import type { BoxConfig } from "./config.js";
import { BoxExecutionPolicy } from "./executionPolicy.js";
import type { BoxMetrics } from "./metrics.js";
import { LegExecutor, fillTiming, type LegOrderRequest } from "./legExecutor.js";
import { PaperLiquidityLedger } from "./liquidityLedger.js";
import { createStructuredLatencySource, type StructuredLatencySource } from "./latencyModel.js";
import {
  classifyTimeOfDayBucket,
  type BrokerId,
  type CalibrationConfidence,
  type LatencyProfile,
  type TimeOfDayBucket,
} from "./latencyModel.js";
import type { CalibrationDimensions, ExecutionCalibrationStore } from "./executionCalibration.js";
import { CalibratedStructuredLatencySource, type CalibratedLatencyStatus } from "./calibratedLatencySource.js";
import type { LegCancelRaceModel } from "./legExecutor.js";
import { kindForPurpose } from "./executionTiming.js";
import { createSchedulingPolicy, type ExecutionSchedulingPolicy } from "./executionSchedulingPolicy.js";
import { planPaperSchedule, type SchedulableOperation } from "./paperScheduler.js";
import type { ExecutionPhase } from "./executionPolicy.js";
import type { BoxOrderPurpose } from "./types.js";
import {
  cloneDepth,
  entrySideFor,
  evaluateCandidate,
  evaluateExitLegs,
  exitSideFor,
  round2,
  slippagePerUnit,
  temporalCoherence,
} from "./math.js";
import { touchPrice, walkDepth } from "./orderPricing.js";
import {
  evaluateBookCoherence,
  paperPolicyFromConfig,
  type CoherenceLegObservation,
} from "./executionCoherence.js";
import { outstandingRoles, type BoxOpenPosition } from "./positions.js";
import { singleLotCandidateViolation } from "./singleLotInvariant.js";
import type { BoxQuoteStore } from "./quotes.js";
import {
  BOX_LEG_ROLES,
  directionSign,
  type BoxCandidate,
  type BoxEntryDecision,
  type BoxEvaluation,
  type BoxExecutionFailureReason,
  type BoxExecutionLeg,
  type BoxExecutionRecord,
  type BoxLegEvaluation,
  type BoxLegRole,
  type BoxQuote,
  type BoxTemporalCoherence,
  type ExecutionMode,
  type OrderSide,
  type PaperLegExecution,
  type PaperLeggingExecutionRecord,
  type ResidualLegExposure,
} from "./types.js";

export interface BoxExecutionSimulatorDeps {
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  isMarketOpen: () => boolean;
  isFeedHealthy: () => boolean;
  metrics?: BoxMetrics;
  /**
   * Total charges (₹) for a set of paper orders, from the LOCAL calculator.
   * Injected so the legging model can price partial-entry and unwind charges
   * without importing the calculator; absent in tests defaults to 0.
   */
  chargeTotal?: (orders: { side: OrderSide; tradingsymbol: string; quantity: number; price: number }[]) => number;
  /** Injected clock — real time in production, a fake clock in tests. */
  now?: () => number;
  /** Injected sleep. Tests advance their clock (and push ticks) inside it. */
  wait?: (ms: number) => Promise<void>;
  /**
   * Feed/broker generation, for the live-parity liquidity ledger's keys so a broker
   * switch invalidates reservations. Optional; defaults to a constant 0 (single
   * generation) when absent, which is correct for tests and single-broker runs.
   */
  feedGeneration?: () => number;
  /**
   * LIVE-CALIBRATION SOURCE (live_parity only).
   *
   * When supplied, paper's broker-side latency and its cancel-race window are drawn from
   * MEASURED live observations instead of the configured constant — and the simulator reports
   * which of the two it is actually using. Absent ⇒ the previous constant-driven behaviour,
   * unchanged.
   */
  calibration?: ExecutionCalibrationStore;
  /**
   * Which broker paper is shadowing. Required for calibration to be usable at all: a sample can
   * only be looked up under the broker it was measured on, and Zerodha and Dhan never mix.
   */
  broker?: () => BrokerId;
  /** Minutes past IST midnight, for time-of-day calibration buckets. */
  istMinutesOfDay?: () => number;
  /**
   * The OPERATOR BLOCKLIST verdict for an underlying — enforcement point 3 of 4.
   *
   * This is the check that makes the blocklist a GUARANTEE rather than a policy. The scanner check is
   * cheap but sits above the pipeline, and the coordinator check is disabled outright when
   * `BOX_EXECUTION_COORDINATOR_ENABLED=false` — so neither is unbypassable. Every paper mode
   * terminates HERE, so a refusal here cannot be configured away.
   *
   * Synchronous and side-effect-free. Returns the refusal, or null when entry may proceed. ENTRY
   * ONLY — deliberately not consulted by `simulateExit` or `simulateLeggingExit`.
   */
  underlyingExclusion?: (underlying: string) => { code: string; detail: string } | null;
}

/** The result of a paper_legging entry attempt. */
export type BoxLeggingResult =
  | {
      ok: true;
      /** All four legs filled — the engine opens a box from `evaluation`. */
      evaluation: BoxEvaluation;
      decision: BoxEntryDecision;
      legging: PaperLeggingExecutionRecord;
    }
  | {
      ok: false;
      /** Some or none filled — no box opened. `legging` carries the abort cost. */
      legging: PaperLeggingExecutionRecord;
      reason: BoxExecutionFailureReason;
      detail: string;
    };

/** A successful simulated entry: the snapshot that filled and how it compares. */
export interface BoxEntryExecution {
  ok: true;
  /** The evaluation the fill was taken from (with five-level depth captured). */
  evaluation: BoxEvaluation;
  record: BoxExecutionRecord;
  decision: BoxEntryDecision;
}

export interface BoxExecutionRefusal {
  ok: false;
  record: BoxExecutionRecord;
  reason: BoxExecutionFailureReason;
  detail: string;
}

export type BoxEntryExecutionResult = BoxEntryExecution | BoxExecutionRefusal;

/** A successful simulated exit. */
export interface BoxExitExecution {
  ok: true;
  legs: BoxLegEvaluation[];
  record: BoxExecutionRecord;
}

export type BoxExitExecutionResult = BoxExitExecution | BoxExecutionRefusal;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
  });

export class BoxExecutionSimulator {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  /** Candidate/position keys with a pipeline in flight — the dedupe guard. */
  private inFlight = new Set<string>();
  private active = 0;

  /** How a broker would work an order (pricing/chase/queue), separate from strategy. */
  private readonly policy: BoxExecutionPolicy;
  /** Independent per-leg order lifecycles (paper_legging). */
  private readonly legExecutor: LegExecutor;
  /** True under live_parity AND stress — both share the realism layering. */
  private readonly liveParity: boolean;
  /**
   * True ONLY under live_parity. The distinction matters for reporting: figures produced under
   * the stress profile are the product of injected faults and must never be presented as
   * evidence about real execution.
   */
  private readonly evidenceDriven: boolean;
  /** Measured-latency source, non-null only when a calibration store was injected. */
  private readonly calibratedLatency: CalibratedStructuredLatencySource | null;
  /** The cancel-vs-fill race model handed to the leg executor. */
  private readonly cancelRace: LegCancelRaceModel | null;
  /** Shared liquidity ledger, non-null only under live_parity. */
  private readonly ledger: PaperLiquidityLedger | null;
  /** Structured broker-latency source (POST→ACK, ACK→terminal), non-null only under live_parity. */
  private readonly structuredLatency: StructuredLatencySource | null;
  /** Shared scheduling policy (cap + min-interval + priority), non-null only under live_parity. */
  private readonly schedulingPolicy: ExecutionSchedulingPolicy | null;

  constructor(private deps: BoxExecutionSimulatorDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? sleep;
    this.policy = new BoxExecutionPolicy(deps.cfg);

    // LIVE-PARITY layering. Only when the profile is explicitly `live_parity` do we build
    // the shared-liquidity ledger and the deterministic latency source and hand them to
    // the leg executor. In `standard` (the default) these stay undefined, so the leg
    // executor's fill and submit paths are byte-for-byte what they were before.
    // `live_parity` and `stress` share the same realism LAYERING (shared liquidity, the live
    // scheduling policy, the cancel-race model). They differ in what feeds it: live_parity is
    // driven by measured evidence, stress deliberately injects faults. Keeping the layering
    // common and the INPUTS separate is what stops an injected fault from ever being reported as
    // observed behaviour.
    const profile = deps.cfg.paperExecutionProfile;
    this.liveParity = profile === "live_parity" || profile === "stress";
    /** True only for the evidence-driven profile — never for stress. */
    this.evidenceDriven = profile === "live_parity";
    this.ledger = this.liveParity ? new PaperLiquidityLedger() : null;

    // LIVE-PARITY: structured broker latency (POST→ACK and ACK→terminal drawn independently
    // from measured samples when available) feeds the shared scheduler, so the four legs
    // pass through the same priority queue + concurrency cap + transport pacing the live
    // OrderManager enforces — instead of all arriving at `submit + one latency`. In
    // `standard` both are null and no arrival planner is wired, so the leg executor's
    // submit/fill path is byte-for-byte what it was before.
    // LATENCY SOURCE. When a live calibration store is injected, paper draws from MEASURED
    // observations (and says so); otherwise it keeps the previous config-driven source exactly as
    // before. The calibrated source is itself responsible for falling back to the documented
    // constant when calibration is UNCALIBRATED / too thin / STALE — and for never describing
    // that constant as measured.
    this.calibratedLatency =
      this.liveParity && deps.calibration
        ? new CalibratedStructuredLatencySource({
            store: deps.calibration,
            dimensions: () => this.calibrationDimensions("ENTRY"),
            fallbackConstantMs: deps.cfg.simulatedLatencyMs,
            seed: deps.cfg.paperLatencySeed,
          })
        : null;
    this.structuredLatency =
      this.calibratedLatency ??
      (this.liveParity
        ? createStructuredLatencySource({
            mode: deps.cfg.paperLatencyMode,
            constantMs: deps.cfg.simulatedLatencyMs,
            postToAckSamples: deps.cfg.paperLatencySamples,
            ackToTerminalSamples: deps.cfg.paperLatencyAckToTerminalSamples,
            seed: deps.cfg.paperLatencySeed,
          })
        : null);

    // CANCEL-RACE WINDOW. Sized from measured CANCEL latency when available, otherwise from the
    // documented conservative constant. Deliberately non-zero either way: a zero window means
    // "cancels are instantaneous", which is precisely the optimistic assumption this models away.
    this.cancelRace = this.liveParity
      ? {
          latencyMs: () => this.cancelWindowMs(),
        }
      : null;
    this.schedulingPolicy = this.liveParity
      ? createSchedulingPolicy({
          maxConcurrentOperations: deps.cfg.paperMaxConcurrentExecutions,
          minBrokerIntervalMs: deps.cfg.liveBrokerMinIntervalMs,
        })
      : null;

    this.legExecutor = new LegExecutor({
      policy: this.policy,
      quotes: deps.quotes,
      now: this.now,
      wait: this.wait,
      metrics: deps.metrics,
      reservation: this.ledger ?? undefined,
      arrivalPlanner: this.liveParity ? (a) => this.planArrivals(a) : undefined,
      generation: deps.feedGeneration,
      cancelRace: this.cancelRace ?? undefined,
    });
  }

  /**
   * The calibration dimensions to look latency up under.
   *
   * Re-read per resolution so the time-of-day bucket follows the session: the open really is a
   * different regime from midday, and a sample from one is not evidence about the other.
   *
   * The profile is MARKETABLE_LIMIT because that is what this strategy submits — a bounded limit
   * priced from the opposite touch with a non-negative chase band. It is stated explicitly rather
   * than inferred so that passive statistics can never leak in.
   */
  private calibrationDimensions(kind: CalibrationDimensions["kind"]): CalibrationDimensions {
    const broker: BrokerId = this.deps.broker?.() ?? "zerodha";
    const profile: LatencyProfile = "MARKETABLE_LIMIT";
    const bucket: TimeOfDayBucket = this.deps.cfg.paperCalibrationTimeBuckets
      ? classifyTimeOfDayBucket(this.deps.istMinutesOfDay?.() ?? Number.NaN)
      : "NORMAL";
    return { broker, kind, profile, bucket };
  }

  /**
   * Durable-persistence delay to apply before transmitting, in ms.
   *
   * Measured `persistence_wait_ms` p50 when calibration supports it, else the configured
   * fallback (0 by default). Returning 0 is the honest answer to "we have never measured our own
   * database": it makes paper optimistic on this stage rather than confidently wrong about it,
   * and {@link calibrationStatus} reports which of the two is in force.
   */
  private persistenceWindowMs(kind: CalibrationDimensions["kind"]): number {
    const fallback = Math.max(0, this.deps.cfg.paperPersistenceMs);
    const store = this.deps.calibration;
    if (!store) return fallback;
    const resolved = store.resolve(this.calibrationDimensions(kind), "persistence_wait_ms");
    if (!resolved.measured || resolved.percentiles.p50 === null) return fallback;
    return Math.max(0, Math.round(resolved.percentiles.p50));
  }

  /**
   * How long a cancel takes to reach a confirmed terminal state, in ms.
   *
   * Measured CANCEL latency when calibration supports it (p50, because the window's typical
   * length is what governs typical race exposure), else the documented constant. Never zero
   * unless explicitly configured so.
   */
  private cancelWindowMs(): number {
    const fallback = Math.max(0, this.deps.cfg.paperCancelLatencyMs);
    const store = this.deps.calibration;
    if (!store) return fallback;
    const resolved = store.resolve(this.calibrationDimensions("CANCEL"), "cancel_request_to_terminal_ms");
    if (!resolved.measured || resolved.percentiles.p50 === null) return fallback;
    return Math.max(0, Math.round(resolved.percentiles.p50));
  }

  /**
   * What paper is CURRENTLY running on, for the parity report and admin diagnostics.
   *
   * Deliberately explicit about the profile: a caller rendering this must be able to distinguish
   * "measured live latency" from "a configured constant" and from "the stress profile's injected
   * faults", without inferring anything.
   */
  calibrationStatus(): {
    profile: BoxConfig["paperExecutionProfile"];
    evidence_driven: boolean;
    latency: CalibratedLatencyStatus | null;
    cancel_window_ms: number;
    cancel_window_measured: boolean;
    persistence_window_ms: number;
    persistence_window_measured: boolean;
    confidence: CalibrationConfidence;
  } {
    const latency = this.calibratedLatency?.status() ?? null;
    const store = this.deps.calibration;
    const cancelResolved = store
      ? store.resolve(this.calibrationDimensions("CANCEL"), "cancel_request_to_terminal_ms")
      : null;
    const persistenceResolved = store
      ? store.resolve(this.calibrationDimensions("ENTRY"), "persistence_wait_ms")
      : null;
    return {
      profile: this.deps.cfg.paperExecutionProfile,
      evidence_driven: this.evidenceDriven,
      latency,
      cancel_window_ms: this.cancelWindowMs(),
      cancel_window_measured: cancelResolved?.measured === true && cancelResolved.percentiles.p50 !== null,
      persistence_window_ms: this.persistenceWindowMs("ENTRY"),
      // False means paper is applying its configured fallback (0 by default) rather than a measured
      // durable-write latency — i.e. optimistic on this stage, and saying so.
      persistence_window_measured:
        persistenceResolved?.measured === true && persistenceResolved.percentiles.p50 !== null,
      // The stress profile is never allowed to claim confidence: its numbers come from injected
      // faults, not observations.
      confidence: this.evidenceDriven ? (latency?.confidence ?? "LOW") : "LOW",
    };
  }

  /**
   * LIVE-PARITY arrival planner. Runs the run's legs through the shared paper scheduler
   * (same policy the live OrderManager uses) and returns each leg's simulated
   * EXCHANGE-ARRIVAL time — its ACK, when the order is live and can start filling from
   * observed books. The broker-side latency components (POST→ACK, ACK→terminal) are drawn
   * from the structured, calibration-fed source; the queue wait and transport pacing are
   * computed by the scheduler from the cap + min-interval. No randomness, fully reproducible.
   */
  private planArrivals(args: { count: number; submitAt: number; phase: ExecutionPhase }): number[] {
    const source = this.structuredLatency;
    const policy = this.schedulingPolicy;
    if (!source || !policy) return []; // unreachable under live_parity; keeps types honest
    // Within one run all legs share a purpose, so this only sets the priority band for
    // diagnostics/fixtures; intra-run ordering is FIFO by leg. Unwinds carry the
    // emergency-residual band, everything else the entry band.
    const purpose: BoxOrderPurpose = args.phase === "unwind" ? "EMERGENCY_RESIDUAL" : "ENTRY";
    const persistence = this.persistenceWindowMs(kindForPurpose(purpose));
    const ops: SchedulableOperation[] = Array.from({ length: args.count }, (_, i) => {
      const draw = source.next();
      return {
        id: String(i),
        purpose,
        sequence: i,
        readyAt: args.submitAt,
        // Durable-persistence latency, from measurement when it exists and 0 otherwise.
        persistenceMs: persistence,
        postToAckMs: draw.postToAckMs,
        ackToTerminalMs: draw.ackToTerminalMs,
      };
    });
    return planPaperSchedule(ops, policy).map((s) => s.ack_at);
  }

  /**
   * The abort predicate for ONE legging run.
   *
   * Built per call and passed into `legExecutor.run()`, never stored on this
   * instance: with several pipelines in flight, a shared field meant one
   * candidate's STOP/window state could cancel a different candidate's orders.
   */
  private leggingAbortReason(
    stillWanted?: () => boolean,
  ): () => { reason: BoxExecutionFailureReason; detail: string } | null {
    return () => {
      if (!this.deps.isMarketOpen()) {
        return { reason: "market_closed", detail: "the market closed while orders were working" };
      }
      if (!this.deps.isFeedHealthy()) {
        return {
          reason: "feed_unhealthy",
          detail: "the WebSocket feed went unhealthy while orders were working",
        };
      }
      if (stillWanted && !stillWanted()) {
        return {
          reason: "discovery_stopped",
          detail: "the candidate was no longer wanted while orders were working",
        };
      }
      return null;
    };
  }

  /** Close the unhedged-exposure window and derive its duration. */
  private closeExposure(record: PaperLeggingExecutionRecord, at: number): void {
    if (record.exposure_started_at === null) return;
    record.exposure_ended_at = at;
    record.exposure_duration_ms = round2(at - record.exposure_started_at);
    this.deps.metrics?.recordExposureDuration(record.exposure_duration_ms);
  }

  get mode(): ExecutionMode {
    return this.deps.cfg.executionMode;
  }

  get activeCount(): number {
    return this.active;
  }

  /** True when another pipeline may start right now. */
  hasCapacity(): boolean {
    // Live-parity mirrors the LIVE concurrency cap (default 1) so the paper validation
    // baseline matches a conservative live deployment; standard keeps its own cap.
    const cap = this.liveParity
      ? this.deps.cfg.paperMaxConcurrentExecutions
      : this.deps.cfg.maxConcurrentExecutions;
    return this.active < cap;
  }

  /** True when this exact candidate/position already has a pipeline running. */
  isRunning(key: string): boolean {
    return this.inFlight.has(key);
  }

  /* --------------------------------- entry -------------------------------- */

  /**
   * Simulate the execution of a detected box.
   *
   * `qualify` is applied to the EXECUTED snapshot, not the detected one — the final
   * entry decision is therefore a statement about prices that existed after the
   * order could have arrived, with the measured slippage already deducted.
   */
  async simulateEntry(args: {
    candidate: BoxCandidate;
    detection: BoxEvaluation;
    qualify: (execution: BoxEvaluation, measuredSlippage: number) => BoxEntryDecision;
    /** Re-checked after the delay: discovery may have stopped, the pair been taken. */
    stillWanted?: () => boolean;
  }): Promise<BoxEntryExecutionResult> {
    const { candidate, detection } = args;
    const key = candidate.key;

    // Live execution is owned by OrderManager. Until the engine is explicitly
    // integrated with it, never let `live` fall through to a paper fill model.
    if (this.mode === "live") {
      return this.refuse(
        detection,
        "discovery_stopped",
        "live OrderManager is not integrated with BoxExecutionSimulator; refusing a paper fallback",
      );
    }

    // OPERATOR BLOCKLIST — the unbypassable refusal for the atomic paper modes.
    const atomicExclusion = this.deps.underlyingExclusion?.(candidate.underlying);
    if (atomicExclusion) {
      return this.refuse(detection, "underlying_excluded", atomicExclusion.detail);
    }

    const quantityViolation = singleLotCandidateViolation(candidate);
    if (quantityViolation) {
      return this.refuse(
        detection,
        "insufficient_quantity",
        `single-lot entry invariant refused execution: ${quantityViolation}`,
      );
    }

    if (this.inFlight.has(key)) {
      return this.refuse(detection, "duplicate", "an execution pipeline is already running for this candidate");
    }
    this.inFlight.add(key);
    this.active++;
    this.deps.metrics?.recordExecutionAttempt();
    const startedAt = this.now();

    try {
      const timing = this.timingFor(detection.at);
      const tokens = BOX_LEG_ROLES.map((role) => candidate.legs[role].token);

      const captured = await this.awaitBooks(tokens, timing.arrivalAt);

      if (args.stillWanted && !args.stillWanted()) {
        return this.refuse(detection, "discovery_stopped", "the candidate was no longer wanted after the simulated delay", timing);
      }
      if (!this.deps.isMarketOpen()) {
        return this.refuse(detection, "market_closed", "the market closed during the simulated delay", timing);
      }
      if (!this.deps.isFeedHealthy()) {
        return this.refuse(detection, "feed_unhealthy", "the WebSocket feed went unhealthy during the simulated delay", timing);
      }

      const missing = tokens.filter((t) => !captured.has(t));
      if (missing.length > 0) {
        return this.refuse(
          detection,
          "missing_book",
          `no WebSocket book published at or after the simulated arrival for ${missing.length} leg(s)`,
          timing,
          captured,
        );
      }

      // The books arrived at or after the simulated arrival, but the real fill
      // instant is now — stamp it so leg ages are measured against the moment the
      // fill was decided, not the theoretical arrival (which would make a book
      // that landed a few ms later look like it came from the future).
      timing.executedAt = Math.max(timing.arrivalAt, this.now());

      // Evaluate the four legs on the EXACT captured books.
      const execution = this.evaluateFromCaptured(candidate, captured, timing.executedAt);
      const record = this.buildRecord({
        mode: this.mode,
        timing,
        detection,
        execution,
        lotSize: candidate.lot_size,
        captured,
      });

      if (!execution.tradable || execution.gross_edge === null) {
        const reason: BoxExecutionFailureReason =
          execution.reject === "insufficient_qty"
            ? "insufficient_quantity"
            : execution.reject === "stale_quote" || execution.reject === "no_quote"
              ? "missing_book"
              : "price_moved";
        return this.fail(record, reason, `execution snapshot rejected: ${execution.reject ?? "not tradable"}`);
      }
      if (execution.gross_edge <= 0) {
        return this.fail(record, "edge_disappeared", "the gross edge was gone by the time the order arrived");
      }

      const decision = args.qualify(execution, record.total_slippage);
      if (!decision.qualifies) {
        const reason: BoxExecutionFailureReason =
          decision.reject === "below_expected_net_profit"
            ? "below_expected_net_profit"
            : decision.reject === "below_gross_prefilter"
              ? "edge_disappeared"
              : "below_expected_net_profit";
        return this.fail(
          record,
          reason,
          `expected net ₹${decision.expected_net_profit ?? "?"} < required ₹${decision.min_expected_net_profit}`,
        );
      }

      record.filled = true;
      this.deps.metrics?.recordExecutionFilled(record.total_slippage, record.decision_to_fill_ms);
      this.deps.metrics?.qualificationToFill.push(this.now() - startedAt);
      return { ok: true, evaluation: execution, record, decision };
    } finally {
      this.active--;
      this.inFlight.delete(key);
    }
  }

  /* -------------------------------- legging ------------------------------- */

  /**
   * paper_legging — simulate FOUR INDEPENDENT option orders rather than one
   * atomic box.
   *
   * Real four-leg execution is not atomic: some legs fill and others do not,
   * leaving temporary exposure that costs money to unwind. This models that:
   *
   *   detect → decision delay → submit (parallel, or sequential) → per-leg
   *   arrival → each leg fills from its own current book, or fails → if all four
   *   fill, open the box → if some fill and others fail, emergency-unwind the
   *   filled legs at the current opposite touch and book the legging loss.
   *
   * Every price is an observed executable touch — never invented, no random
   * slippage. The same recorded ticks always reproduce the same result.
   */
  async simulateLeggingEntry(args: {
    candidate: BoxCandidate;
    detection: BoxEvaluation;
    qualify: (execution: BoxEvaluation, measuredSlippage: number) => BoxEntryDecision;
    stillWanted?: () => boolean;
  }): Promise<BoxLeggingResult> {
    const { candidate, detection } = args;
    const key = candidate.key;
    const direction = candidate.direction ?? "LONG_BOX";
    const lotSize = candidate.lot_size;
    const legMode = this.deps.cfg.legExecutionMode;
    const detByRole = new Map(detection.legs.map((l) => [l.role, l]));

    const baseRecord = (): PaperLeggingExecutionRecord => ({
      mode: "paper_legging",
      leg_execution_mode: legMode,
      detected_at: detection.at,
      order_sent_at: detection.at + Math.max(0, this.deps.cfg.simulatedDecisionMs),
      filled_leg_count: 0,
      opened: false,
      failed_legs: [],
      legs: [],
      first_to_last_fill_ms: null,
      decision_to_first_fill_ms: null,
      decision_to_last_fill_ms: null,
      timed_out_legs: [],
      partial_fill_legs: [],
      exposure_started_at: null,
      exposure_ended_at: null,
      exposure_duration_ms: null,
      decision_to_complete_ms: null,
      total_entry_slippage: 0,
      emergency_unwind: false,
      partial_entry_charges: null,
      unwind_charges: null,
      legging_gross_loss: null,
      legging_net_loss: null,
      abort_after_fill: false,
      final_expected_net_profit: null,
      required_expected_net_profit: null,
      temporal: null,
      residual_exposure: [],
      submitted_leg_count: 0,
      fully_closed_role_count: 0,
      remaining_role_count: 0,
      fills_by_role: {},
      failure_reason: null,
      failure_detail: null,
    });

    // OPERATOR BLOCKLIST — the unbypassable refusal for paper_legging. Checked before the in-flight
    // set is touched and before any leg is priced, so an excluded name leaves no trace to unwind.
    const leggingExclusion = this.deps.underlyingExclusion?.(candidate.underlying);
    if (leggingExclusion) {
      return this.leggingRefuse(baseRecord(), "underlying_excluded", leggingExclusion.detail);
    }

    const quantityViolation = singleLotCandidateViolation(candidate);
    if (quantityViolation) {
      return this.leggingRefuse(
        baseRecord(),
        "insufficient_quantity",
        `single-lot entry invariant refused execution: ${quantityViolation}`,
      );
    }

    if (this.inFlight.has(key)) {
      return { ok: false, legging: baseRecord(), reason: "duplicate", detail: "a legging pipeline is already running for this candidate" };
    }
    this.inFlight.add(key);
    this.active++;
    this.deps.metrics?.recordExecutionAttempt();
    this.deps.metrics?.recordLeggingAttempt();

    try {
      const sentAt = detection.at + Math.max(0, this.deps.cfg.simulatedDecisionMs);
      const tokens = BOX_LEG_ROLES.map((role) => candidate.legs[role].token);

      // FOUR-LEG TEMPORAL COHERENCE. Measured on the books we are about to trade,
      // BEFORE committing. This now delegates to the ONE shared coherence policy
      // (executionCoherence.ts) that the LIVE gateway also enforces, so paper and
      // live cannot drift. Paper reads the PAPER policy: a 0 dispersion limit
      // DISABLES the cross-leg gate (the historical paper behaviour), whereas live
      // reads 0 as impossible-to-satisfy unless the operator opts out. The measured
      // `temporal` figures are still surfaced on the record for the trade audit.
      //
      // Exchange-time dispersion is applied only when EVERY leg carries a real
      // exchange timestamp; when any leg lacks one the receive-time constraint
      // stands. Receive-time coherence proves arrival spread, NOT that the exchange
      // published the four books simultaneously — see executionCoherence.ts.
      const temporal = this.temporalFor(candidate, detByRole, this.now());
      const coherence = evaluateBookCoherence(
        this.coherenceObservations(candidate, detByRole),
        paperPolicyFromConfig(this.deps.cfg),
        this.now(),
      );
      if (!coherence.admit) {
        const rec: PaperLeggingExecutionRecord = { ...baseRecord(), temporal: coherence.temporal };
        this.deps.metrics?.recordCrossLegSkewReject();
        return this.leggingRefuse(
          rec,
          "cross_leg_time_skew",
          `four-leg coherence refused entry [${coherence.reason}]: ${coherence.detail}`,
        );
      }

      /**
       * FOUR INDEPENDENT ORDERS.
       *
       * Each one travels, arrives, and then walks its own book within its limit —
       * filling fully, partially (the remainder rests for later liquidity), or not
       * at all — until its arrival-relative deadline. No common snapshot, so legs
       * genuinely land at different instants (or not at all).
       */
      const run = await this.legExecutor.run({
        requests: BOX_LEG_ROLES.map((role) => {
          const det = detByRole.get(role);
          return {
            role,
            side: entrySideFor(role, direction),
            inst: candidate.legs[role],
            detected_price: det?.price ?? null,
            detected_qty: det?.qty_at_touch ?? 0,
            quantity: lotSize,
          } satisfies LegOrderRequest;
        }),
        submitAt: sentAt,
        phase: "entry",
        orderIdPrefix: `${key}:entry`,
        // Per-run, closed over THIS candidate's stillWanted only.
        abortReason: this.leggingAbortReason(args.stillWanted),
      });

      const legs = run.legs;
      const filledRoles = legs.filter((l) => l.status === "FILLED").map((l) => l.role);
      const filledCount = filledRoles.length;
      const failedLegs = BOX_LEG_ROLES.filter((r) => !filledRoles.includes(r));
      const timedOutLegs = legs.filter((l) => l.status === "TIMED_OUT").map((l) => l.role);
      // A leg that took SOME quantity but never completed is real exposure too.
      const partialFillLegs = legs
        .filter((l) => l.fill_qty > 0 && l.fill_qty < l.quantity)
        .map((l) => l.role);
      const totalEntrySlippage = round2(
        // Count every leg that acquired quantity, not only clean full fills — a
        // partial entry still cost slippage on what it took.
        legs.reduce((s, l) => s + (l.fill_qty > 0 && l.slippage !== null ? l.slippage : 0), 0),
      );
      const timing = fillTiming(legs, detection.at);
      for (const _ of timedOutLegs) this.deps.metrics?.recordLegTimeout();
      for (const _ of partialFillLegs) this.deps.metrics?.recordPartialFill();
      // Books that moved between detection and the fill, for latency calibration.
      temporal.books_changed_during_latency = legs.reduce((n, l) => {
        const det = detByRole.get(l.role);
        return n + (det?.quote_version != null && l.quote_version != null && l.quote_version !== det.quote_version ? 1 : 0);
      }, 0);

      const record: PaperLeggingExecutionRecord = {
        ...baseRecord(),
        filled_leg_count: filledCount,
        failed_legs: failedLegs,
        timed_out_legs: timedOutLegs,
        partial_fill_legs: partialFillLegs,
        temporal,
        legs,
        first_to_last_fill_ms: timing.first_to_last_fill_ms,
        decision_to_first_fill_ms: timing.decision_to_first_fill_ms,
        decision_to_last_fill_ms: timing.decision_to_last_fill_ms,
        // Exposure starts the moment the FIRST leg fills. It ends when the box is
        // complete (4/4) or when the unwind finishes — set on those paths below.
        submitted_leg_count: legs.length,
        fully_closed_role_count: filledCount,
        remaining_role_count: legs.filter((l) => l.remaining_qty > 0).length,
        fills_by_role: Object.fromEntries(legs.map((l) => [l.role, l.fill_qty])) as Partial<Record<BoxLegRole, number>>,
        exposure_started_at: timing.first_fill_at,
        exposure_ended_at: filledCount === 4 ? timing.last_fill_at : null,
        exposure_duration_ms:
          filledCount === 4 && timing.first_fill_at !== null && timing.last_fill_at !== null
            ? round2(timing.last_fill_at - timing.first_fill_at)
            : null,
        decision_to_complete_ms: round2(this.now() - detection.at),
        total_entry_slippage: totalEntrySlippage,
      };

      // The run was cut short (feed died / market shut / discovery stopped). Legs
      // that had already filled are still real, so fall through to the abort
      // accounting below rather than pretending nothing happened.
      if (run.aborted && filledCount === 0) {
        return this.leggingRefuse(record, run.aborted.reason, run.aborted.detail);
      }

      if (timing.first_fill_at !== null) {
        this.deps.metrics?.recordFirstFillLatency(timing.decision_to_first_fill_ms ?? 0);
        this.deps.metrics?.recordLastFillLatency(timing.decision_to_last_fill_ms ?? 0);
      }

      // ---- All four filled. Re-qualify on the ACTUAL AVERAGE FILL PRICES. ----
      if (filledCount === 4) {
        // The four legs filled at four different instants and possibly across
        // several depth levels, so the store's CURRENT books are not what we
        // traded. Qualification prices the WEIGHTED-AVERAGE fill of each leg —
        // exactly the economics of the position we now hold.
        const completedAt = timing.last_fill_at ?? this.now();
        const execution = this.evaluationFromFills(candidate, legs, run.booksAtFill, completedAt);
        const decision = args.qualify(execution, totalEntrySlippage);
        record.final_expected_net_profit = decision.expected_net_profit;
        record.required_expected_net_profit = decision.min_expected_net_profit;

        /**
         * ABORT AFTER FILL.
         *
         * The four orders have ALREADY filled, so we cannot pretend nothing
         * happened and simply refuse the entry — that would silently discard a
         * position the simulated market really gave us, and flatter the strategy
         * by hiding the cost of a dislocation that decayed in flight.
         *
         * Instead: reverse all four legs immediately at the current opposite
         * touch, book the true round-trip cost (adverse spread + charges both
         * ways), and open NO box.
         */
        if (!decision.qualifies) {
          record.abort_after_fill = true;
          // The SAME label live uses, so paper and live report one vocabulary and a parity run
          // exercises the identical UI path.
          record.outcome_class = "FILLED_THEN_ECONOMICS_ABORT";
          record.emergency_unwind = true;
          const unwind = await this.emergencyUnwind(candidate, legs, key, args.stillWanted);
          record.partial_entry_charges = unwind.partial_entry_charges;
          record.unwind_charges = unwind.unwind_charges;
          record.legging_gross_loss = unwind.legging_gross_loss;
          record.legging_net_loss = unwind.legging_net_loss;
          record.residual_exposure = unwind.residual;
          // The box was complete and hedged, then reversed: exposure ends with the
          // unwind, not with the fourth fill.
          this.closeExposure(record, this.now());
          record.decision_to_complete_ms = round2(this.now() - detection.at);
          // A failed unwind is the more serious condition, so it wins the label.
          record.failure_reason = unwind.unwindFailed ? "unwind_failed" : "abort_after_fill";
          record.failure_detail =
            `4/4 filled, but the executed economics no longer qualify: expected net ` +
            `₹${decision.expected_net_profit ?? "?"} < required ₹${decision.min_expected_net_profit}` +
            (unwind.unwindFailed ? " (one or more legs could not be unwound)" : "");
          // Counted as an ABORT, never as a 4/4 fill — no box was opened.
          this.deps.metrics?.recordLeggingAbortAfterFill();
          this.deps.metrics?.recordExecutionFailed(record.failure_reason);
          this.deps.metrics?.recordLeggingLoss(unwind.legging_net_loss);
          if (unwind.unwindFailed) this.deps.metrics?.recordUnwindFailure();
          else this.deps.metrics?.recordUnwindSuccess();
          if (record.residual_exposure.length > 0) this.deps.metrics?.recordResidualExposure(record.residual_exposure.length);
          if (record.first_to_last_fill_ms !== null) {
            this.deps.metrics?.recordFirstToLastFill(record.first_to_last_fill_ms);
          }
          return { ok: false, legging: record, reason: record.failure_reason, detail: record.failure_detail };
        }

        record.opened = true;
        record.outcome_class = "OPENED";
        this.deps.metrics?.recordLeggingOutcome(4, 0);
        // Detection → the box actually being complete (the LAST leg's fill).
        this.deps.metrics?.recordExecutionFilled(totalEntrySlippage, round2(completedAt - detection.at));
        if (record.first_to_last_fill_ms !== null) {
          this.deps.metrics?.recordFirstToLastFill(record.first_to_last_fill_ms);
        }
        return { ok: true, evaluation: execution, decision, legging: record };
      }

      // ---- Partial (1-3) or nothing filled. ----
      this.deps.metrics?.recordLeggingOutcome(filledCount, filledCount);
      for (const r of failedLegs) this.deps.metrics?.recordLeggingFailedRole(r);

      if (filledCount === 0) {
        // No exposure was ever taken on, so no legging cost.
        record.failure_reason = "legging_incomplete";
        record.failure_detail = "no leg filled at arrival";
        this.deps.metrics?.recordExecutionFailed("legging_incomplete");
        return { ok: false, legging: record, reason: "legging_incomplete", detail: record.failure_detail };
      }

      // Emergency unwind the filled/partial legs through the SAME order lifecycle
      // (marketable-limit, wider chase, depth walking, latency, timeout).
      record.emergency_unwind = true;
      const unwind = await this.emergencyUnwind(candidate, legs, key, args.stillWanted);
      record.partial_entry_charges = unwind.partial_entry_charges;
      record.unwind_charges = unwind.unwind_charges;
      record.legging_gross_loss = unwind.legging_gross_loss;
      record.legging_net_loss = unwind.legging_net_loss;
      record.residual_exposure = unwind.residual;
      // Directional exposure ran from the first fill until the unwind completed.
      this.closeExposure(record, this.now());
      record.decision_to_complete_ms = round2(this.now() - detection.at);
      // Report the CAUSE, not just the symptom. If the run was cut short (STOP, feed
      // death, market close) that is why the box never completed, and the attempt
      // record must say so — a bare "legging_incomplete" would hide it. A leg that
      // could not be unwound is more serious still, so it wins.
      record.failure_reason = unwind.unwindFailed
        ? "unwind_failed"
        : (run.aborted?.reason ?? "legging_incomplete");
      record.failure_detail =
        `${filledCount}/4 filled, failed legs: ${failedLegs.join(", ")}` +
        (run.aborted ? ` — ${run.aborted.detail}` : "") +
        (unwind.unwindFailed ? " (one or more could not be unwound)" : "");

      this.deps.metrics?.recordExecutionFailed(record.failure_reason);
      this.deps.metrics?.recordLeggingLoss(unwind.legging_net_loss);
      if (unwind.unwindFailed) this.deps.metrics?.recordUnwindFailure();
      else this.deps.metrics?.recordUnwindSuccess();
      if (record.residual_exposure.length > 0) this.deps.metrics?.recordResidualExposure(record.residual_exposure.length);
      if (record.first_to_last_fill_ms !== null) {
        this.deps.metrics?.recordFirstToLastFill(record.first_to_last_fill_ms);
      }

      return { ok: false, legging: record, reason: record.failure_reason, detail: record.failure_detail };
    } finally {
      this.active--;
      this.inFlight.delete(key);
    }
  }

  /* --------------------------- legging exit / unwind ---------------------- */

  /**
   * paper_legging EXIT — reverse an open box with FOUR INDEPENDENT orders.
   *
   * The exit gets the same leg-level realism as the entry: each closing order
   * travels, walks its own book within a marketable limit, and fills fully,
   * partially, or not at all. If all four fill the box is closed on the actual
   * fills; if only some fill, the position now has RESIDUAL exposure, which is
   * reported explicitly rather than pretending the box stayed intact.
   */
  async simulateLeggingExit(args: {
    position: BoxOpenPosition;
    detectionLegs: BoxLegEvaluation[];
    detectedAt: number;
    stillWanted?: () => boolean;
  }): Promise<
    | { ok: true; legs: BoxLegEvaluation[]; record: PaperLeggingExecutionRecord; booksAtFill: Map<number, BoxQuote> }
    | {
        ok: false;
        record: PaperLeggingExecutionRecord;
        reason: BoxExecutionFailureReason;
        detail: string;
        /** Any quantity that DID close on a partial exit — real closes to apply. */
        legs?: BoxLegEvaluation[];
        booksAtFill?: Map<number, BoxQuote>;
      }
  > {
    const { position, detectionLegs } = args;
    const key = `exit:${position.id}`;
    const direction = position.direction ?? "LONG_BOX";
    const lotSize = position.lot_size;
    const detByRole = new Map(detectionLegs.map((l) => [l.role, l]));

    const base = (): PaperLeggingExecutionRecord => ({
      mode: "paper_legging",
      leg_execution_mode: this.deps.cfg.legExecutionMode,
      detected_at: args.detectedAt,
      order_sent_at: args.detectedAt + Math.max(0, this.deps.cfg.simulatedDecisionMs),
      filled_leg_count: 0,
      opened: false,
      failed_legs: [],
      legs: [],
      first_to_last_fill_ms: null,
      decision_to_first_fill_ms: null,
      decision_to_last_fill_ms: null,
      timed_out_legs: [],
      partial_fill_legs: [],
      exposure_started_at: null,
      exposure_ended_at: null,
      exposure_duration_ms: null,
      decision_to_complete_ms: null,
      total_entry_slippage: 0,
      emergency_unwind: false,
      partial_entry_charges: null,
      unwind_charges: null,
      legging_gross_loss: null,
      legging_net_loss: null,
      abort_after_fill: false,
      final_expected_net_profit: null,
      required_expected_net_profit: null,
      temporal: null,
      residual_exposure: [],
      submitted_leg_count: 0,
      fully_closed_role_count: 0,
      remaining_role_count: 0,
      fills_by_role: {},
      failure_reason: null,
      failure_detail: null,
    });

    if (this.inFlight.has(key)) {
      return { ok: false, record: base(), reason: "duplicate", detail: "an exit pipeline is already running for this position" };
    }
    this.inFlight.add(key);
    this.active++;

    try {
      const sentAt = args.detectedAt + Math.max(0, this.deps.cfg.simulatedDecisionMs);

      // Size each closing order from the EXACT outstanding quantity per role — a
      // role already flat is never submitted, so a partial exit can never re-close
      // a leg or create reverse exposure. Between 1 and 4 orders may go out.
      const toClose = outstandingRoles(position);
      if (toClose.length === 0) {
        // Nothing left to close — the position is already flat. Not an error; the
        // caller treats an empty close as a no-op.
        const rec: PaperLeggingExecutionRecord = { ...base(), submitted_leg_count: 0 };
        return { ok: false, record: rec, reason: "legging_incomplete", detail: "position already flat — nothing to close" };
      }
      const submittedRoles = toClose.map((t) => t.role);

      const run = await this.legExecutor.run({
        requests: toClose.map(({ role, quantity }) => {
          const det = detByRole.get(role);
          return {
            role,
            side: exitSideFor(role, direction),
            inst: position.legs[role],
            detected_price: det?.price ?? null,
            detected_qty: det?.qty_at_touch ?? 0,
            quantity, // exactly the outstanding quantity for this role
          } satisfies LegOrderRequest;
        }),
        submitAt: sentAt,
        phase: "entry", // an exit is a normal marketable-limit order, not a panic unwind
        orderIdPrefix: `${key}:exit`,
        abortReason: this.leggingAbortReason(args.stillWanted),
      });

      const legs = run.legs;
      const fullyClosedRoles = legs.filter((l) => l.status === "FILLED").map((l) => l.role);
      const filledCount = fullyClosedRoles.length;
      const timing = fillTiming(legs, args.detectedAt);
      const fillsByRole: Partial<Record<BoxLegRole, number>> = {};
      for (const l of legs) fillsByRole[l.role] = l.fill_qty;
      const remainingRoleCount = legs.filter((l) => l.remaining_qty > 0).length;
      const record: PaperLeggingExecutionRecord = {
        ...base(),
        filled_leg_count: filledCount,
        failed_legs: submittedRoles.filter((r) => !fullyClosedRoles.includes(r)),
        timed_out_legs: legs.filter((l) => l.status === "TIMED_OUT").map((l) => l.role),
        partial_fill_legs: legs.filter((l) => l.fill_qty > 0 && l.fill_qty < l.quantity).map((l) => l.role),
        legs,
        first_to_last_fill_ms: timing.first_to_last_fill_ms,
        decision_to_first_fill_ms: timing.decision_to_first_fill_ms,
        decision_to_last_fill_ms: timing.decision_to_last_fill_ms,
        decision_to_complete_ms: round2(this.now() - args.detectedAt),
        submitted_leg_count: submittedRoles.length,
        fully_closed_role_count: filledCount,
        remaining_role_count: remainingRoleCount,
        fills_by_role: fillsByRole,
      };
      for (const _ of record.timed_out_legs) this.deps.metrics?.recordLegTimeout();
      for (const _ of record.partial_fill_legs) this.deps.metrics?.recordPartialFill();

      // Build a leg evaluation for every role that closed ANY quantity — the close
      // accounting is priced on the actual average fills, per role, for whatever
      // filled (full or partial).
      const closedLegs: BoxLegEvaluation[] = legs
        .filter((l) => l.fill_qty > 0)
        .map((l) => {
          const book = run.booksAtFill.get(position.legs[l.role].token);
          return this.legEvaluationFromFill(l.role, l, position.legs[l.role], book, timing.last_fill_at ?? this.now());
        });

      // A CLEAN close: every role that was still outstanding filled completely.
      const cleanClose = remainingRoleCount === 0 && filledCount === submittedRoles.length;
      if (cleanClose) {
        const exitSlip = round2(legs.reduce((s, l) => s + (l.slippage ?? 0), 0));
        this.deps.metrics?.recordExitSlippage(exitSlip);
        return { ok: true, legs: closedLegs, record, booksAtFill: run.booksAtFill };
      }

      // Some quantity did not close → the position is (still) partial. Any quantity
      // that DID close is a real close (returned in `closedLegs`); the outstanding
      // remainder is residual exposure the caller must keep working.
      const residual = this.residualFromPartialExit(position, legs, this.now());
      record.residual_exposure = residual;
      record.failure_reason = run.aborted?.reason ?? "legging_incomplete";
      record.failure_detail =
        `${filledCount}/${submittedRoles.length} submitted exit legs filled` +
        (run.aborted ? ` — ${run.aborted.detail}` : "") +
        (residual.length > 0 ? ` — ${residual.length} leg(s) of residual exposure remain` : "");
      if (residual.length > 0) this.deps.metrics?.recordResidualExposure(residual.length);
      this.deps.metrics?.recordExecutionFailed(record.failure_reason);
      return { ok: false, record, reason: record.failure_reason, detail: record.failure_detail, legs: closedLegs, booksAtFill: run.booksAtFill };
    } finally {
      this.active--;
      this.inFlight.delete(key);
    }
  }

  /**
   * NON-MUTATING estimate of how much of each still-open role could execute RIGHT
   * NOW, using the SAME marketable-limit pricing, depth walking and queue haircut
   * the LegExecutor uses to actually fill. Qualification and execution therefore
   * share one implementation and cannot drift.
   *
   * For each outstanding role it reports the executable quantity within the limit
   * (across depth levels, after the queue haircut) so the caller can pre-reject an
   * exit only when the executable quantity is genuinely below what is needed —
   * never merely because the whole lot is not resting at the single best touch.
   */
  estimateExecutableExit(
    position: BoxOpenPosition,
    now = this.now(),
  ): { role: BoxLegRole; side: OrderSide; remaining: number; executable: number; fresh: boolean }[] {
    const direction = position.direction ?? "LONG_BOX";
    const maxAgeMs = this.policy.quoteMaxAgeMs;
    const out: { role: BoxLegRole; side: OrderSide; remaining: number; executable: number; fresh: boolean }[] = [];
    for (const { role, quantity } of outstandingRoles(position)) {
      const side = exitSideFor(role, direction);
      const inst = position.legs[role];
      const quote = this.deps.quotes.get(inst.token);
      if (!quote) {
        out.push({ role, side, remaining: quantity, executable: 0, fresh: false });
        continue;
      }
      const age = now - quote.at;
      const fresh = age >= 0 && age <= maxAgeMs;
      const ref = touchPrice(side, quote.bids, quote.asks);
      if (!fresh || ref === null || !(ref > 0)) {
        out.push({ role, side, remaining: quantity, executable: 0, fresh });
        continue;
      }
      const pricing = this.policy.priceOrder({ side, quantity, referencePrice: ref, inst, phase: "entry" });
      const walk = walkDepth({
        side,
        levels: side === "BUY" ? quote.asks : quote.bids,
        remainingQty: quantity,
        limitPrice: pricing.limit_price,
        queueModel: this.policy.queueModel,
        haircutPct: this.policy.queueHaircutPct,
        at: now,
        quoteVersion: quote.version,
      });
      out.push({ role, side, remaining: quantity, executable: walk.executable_within_limit, fresh });
    }
    return out;
  }

  /**
   * Residual exposure left by a partial EXIT: every role whose closing order did
   * not fully fill is still (partly) an open box leg. The side we still hold is
   * the ENTRY side, and the outstanding quantity is what the exit could not close.
   */
  private residualFromPartialExit(
    position: BoxOpenPosition,
    exitLegs: PaperLegExecution[],
    now: number,
  ): ResidualLegExposure[] {
    const direction = position.direction ?? "LONG_BOX";
    const out: ResidualLegExposure[] = [];
    for (const role of BOX_LEG_ROLES) {
      const leg = exitLegs.find((l) => l.role === role);
      const closed = leg?.fill_qty ?? 0;
      // Outstanding is measured against the role's CURRENT open quantity, not the
      // original lot — a role that was already partly closed in a prior attempt
      // must not have its earlier closes counted again here.
      const openNow = position.remaining_qty_by_role[role] ?? 0;
      const outstanding = openNow - closed;
      if (outstanding <= 0) continue;
      out.push({
        token: position.legs[role].token,
        tradingsymbol: position.legs[role].tradingsymbol,
        role,
        side: entrySideFor(role, direction),
        quantity: outstanding,
        average_price: position.entry_prices[role] ?? 0,
        source: "partial_exit",
        created_at: now,
      });
    }
    return out;
  }

  /** Build a BoxLegEvaluation from a completed fill, for the close accounting. */
  private legEvaluationFromFill(
    role: BoxLegRole,
    leg: PaperLegExecution,
    inst: { token: number; tradingsymbol: string; strike: number; instrument_type: "CE" | "PE" },
    book: BoxQuote | undefined,
    at: number,
  ): BoxLegEvaluation {
    const price = leg.average_fill_price ?? leg.fill_price;
    return {
      role,
      side: leg.side,
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      price,
      qty_at_touch: leg.fill_qty,
      bid: book?.bid ?? 0,
      bid_qty: book?.bid_qty ?? 0,
      ask: book?.ask ?? 0,
      ask_qty: book?.ask_qty ?? 0,
      quote_at: book?.at ?? null,
      quote_version: book?.version ?? leg.quote_version ?? null,
      depth: book ? cloneDepth(book) : null,
      age_ms: book ? at - book.at : null,
      fresh: true,
      executable: price !== null && price > 0,
    };
  }

  /**
   * Emergency-reverse every leg that acquired quantity, through the SAME order
   * lifecycle as an entry — a marketable-limit order with a (wider) unwind chase
   * band, simulated latency, depth walking, partial fills and a timeout. Prices
   * the whole episode from observed executable prices only: never invented, never
   * a random slippage figure.
   *
   * Shared by both abort paths — a partial entry (1-3 legs, real directional
   * exposure) and an abort after a complete 4/4 fill (economics failed). Mutates
   * each leg's status/unwind fields so the per-leg audit shows what happened, and
   * leaves any quantity it could not flatten as RESIDUAL exposure that stays
   * visible (the leg is marked UNWIND_FAILED).
   */
  private async emergencyUnwind(
    candidate: BoxCandidate,
    legs: PaperLegExecution[],
    key: string,
    _stillWanted?: () => boolean,
  ): Promise<{
    unwindFailed: boolean;
    partial_entry_charges: number;
    unwind_charges: number;
    legging_gross_loss: number;
    legging_net_loss: number;
    residual: ResidualLegExposure[];
  }> {
    // Only legs that acquired quantity need reversing; a zero-fill leg is flat.
    const toUnwind = legs.filter((l) => l.fill_qty > 0);
    const charge = this.deps.chargeTotal ?? (() => 0);
    const entryOrders = toUnwind
      .filter((l) => (l.average_fill_price ?? l.fill_price) !== null)
      .map((l) => ({
        side: l.side,
        tradingsymbol: l.tradingsymbol,
        quantity: l.fill_qty,
        price: (l.average_fill_price ?? l.fill_price) as number,
      }));

    if (toUnwind.length === 0) {
      return {
        unwindFailed: false,
        partial_entry_charges: 0,
        unwind_charges: 0,
        legging_gross_loss: 0,
        legging_net_loss: 0,
        residual: [],
      };
    }

    // Reference each reversal against the CURRENT opposite touch, then let the
    // executor work it exactly like any other order (wider unwind chase band).
    const now = this.now();
    const requests: LegOrderRequest[] = toUnwind.map((l) => {
      const inst = candidate.legs[l.role];
      const unwindSide: OrderSide = l.side === "BUY" ? "SELL" : "BUY";
      const q = this.deps.quotes.get(inst.token);
      const ref = q ? touchPrice(unwindSide, q.bids, q.asks) : null;
      return {
        role: l.role,
        side: unwindSide,
        inst,
        detected_price: ref,
        detected_qty: 0,
        quantity: l.fill_qty,
      };
    });

    const run = await this.legExecutor.run({
      requests,
      submitAt: now,
      latencyMs: this.policy.unwindLatencyMs,
      phase: "unwind",
      orderIdPrefix: `${key}:unwind`,
      // NB: NOT gated by stillWanted. Flattening real exposure must proceed even
      // after discovery has stopped — only a dead feed or a closed market can
      // legitimately halt it (Task 8/9). `_stillWanted` is intentionally unused.
      abortReason: this.leggingAbortReason(),
    });

    let unwindFailed = false;
    let grossLoss = 0;
    const unwindOrders: { side: OrderSide; tradingsymbol: string; quantity: number; price: number }[] = [];
    const residual: ResidualLegExposure[] = [];

    for (const entryLeg of toUnwind) {
      const u = run.legs.find((x) => x.role === entryLeg.role);
      const entryPrice = (entryLeg.average_fill_price ?? entryLeg.fill_price) as number;
      const unwoundQty = u?.fill_qty ?? 0;
      const unwindPrice = u?.average_fill_price ?? u?.fill_price ?? null;
      entryLeg.unwound_qty = unwoundQty;
      entryLeg.unwind_price = unwindPrice;

      if (unwoundQty > 0 && unwindPrice !== null) {
        // Round-trip loss on the reversed quantity (positive = money lost).
        const cost =
          entryLeg.side === "BUY"
            ? round2((entryPrice - unwindPrice) * unwoundQty) // paid to buy, received to sell
            : round2((unwindPrice - entryPrice) * unwoundQty); // received to sell, paid to buy back
        entryLeg.unwind_slippage = cost;
        grossLoss += cost;
        unwindOrders.push({
          side: entryLeg.side === "BUY" ? "SELL" : "BUY",
          tradingsymbol: entryLeg.tradingsymbol,
          quantity: unwoundQty,
          price: unwindPrice,
        });
      }

      const outstanding = entryLeg.fill_qty - unwoundQty;
      if (outstanding > 0) {
        // Could not fully flatten — leave the leg's status honest and record the
        // outstanding contracts as residual exposure the monitor must keep working.
        unwindFailed = true;
        if (entryLeg.status === "FILLED") entryLeg.status = "UNWIND_FAILED";
        entryLeg.fail_reason =
          `could not unwind ${outstanding} of ${entryLeg.fill_qty} — no executable opposite price within the limit`;
        residual.push({
          token: entryLeg.token,
          tradingsymbol: entryLeg.tradingsymbol,
          role: entryLeg.role,
          side: entryLeg.side,
          quantity: outstanding,
          average_price: entryPrice,
          source: "failed_unwind",
          created_at: now,
        });
      } else if (entryLeg.status === "FILLED") {
        entryLeg.status = "UNWOUND";
      }
    }

    const partial_entry_charges = round2(charge(entryOrders));
    const unwind_charges = round2(charge(unwindOrders));
    const legging_gross_loss = round2(-grossLoss); // as a P&L (≤ 0)
    const legging_net_loss = round2(legging_gross_loss - partial_entry_charges - unwind_charges);
    return { unwindFailed, partial_entry_charges, unwind_charges, legging_gross_loss, legging_net_loss, residual };
  }

  /**
   * Flatten outstanding RESIDUAL exposure through the SAME order lifecycle — a
   * marketable-limit order (wider unwind chase band), depth walking, queue haircut,
   * latency and timeout. Submits the OPPOSITE side of what we hold, sized to the
   * EXACT residual quantity, so a quantity already flattened is never re-sent.
   *
   * NOT gated by any scanner/discovery predicate — flattening real exposure must
   * proceed whenever the market is open and the feed is healthy (the caller checks
   * those before calling). Returns how much of each residual leg was flattened, the
   * charges billed for the flatten fills, and the STILL-outstanding residual.
   */
  async flattenResidual(args: {
    residual: ResidualLegExposure[];
    keyPrefix: string;
  }): Promise<{
    flattened_by_role: Partial<Record<BoxLegRole, number>>;
    flatten_charges: number;
    remaining: ResidualLegExposure[];
    legs: PaperLegExecution[];
  }> {
    const now = this.now();
    const requests: LegOrderRequest[] = args.residual.map((r) => {
      // We HOLD r.side; flatten by trading the opposite side.
      const flattenSide: OrderSide = r.side === "BUY" ? "SELL" : "BUY";
      const inst = {
        token: r.token,
        tradingsymbol: r.tradingsymbol,
        exchange: "NFO",
        strike: 0,
        instrument_type: r.role.endsWith("_ce") ? "CE" : "PE",
        expiry: "",
        lot_size: r.quantity,
      } as const;
      const q = this.deps.quotes.get(r.token);
      const ref = q ? touchPrice(flattenSide, q.bids, q.asks) : null;
      return {
        role: r.role,
        side: flattenSide,
        inst,
        detected_price: ref,
        detected_qty: 0,
        quantity: r.quantity,
      };
    });

    const run = await this.legExecutor.run({
      requests,
      submitAt: now,
      latencyMs: this.policy.unwindLatencyMs,
      phase: "unwind",
      orderIdPrefix: `${args.keyPrefix}:flatten`,
      // Only a dead feed / closed market may halt flattening — never discovery state.
      abortReason: this.leggingAbortReason(),
    });

    const flattenedByRole: Partial<Record<BoxLegRole, number>> = {};
    const charge = this.deps.chargeTotal ?? (() => 0);
    const flattenOrders: { side: OrderSide; tradingsymbol: string; quantity: number; price: number }[] = [];
    const remaining: ResidualLegExposure[] = [];

    for (const r of args.residual) {
      const leg = run.legs.find((x) => x.role === r.role);
      const flat = leg?.fill_qty ?? 0;
      flattenedByRole[r.role] = flat;
      if (flat > 0 && (leg?.average_fill_price ?? leg?.fill_price) !== null) {
        flattenOrders.push({
          side: leg!.side,
          tradingsymbol: r.tradingsymbol,
          quantity: flat,
          price: (leg!.average_fill_price ?? leg!.fill_price) as number,
        });
      }
      const left = r.quantity - flat;
      if (left > 0) remaining.push({ ...r, quantity: left, created_at: r.created_at });
    }

    return {
      flattened_by_role: flattenedByRole,
      flatten_charges: round2(charge(flattenOrders)),
      remaining,
      legs: run.legs,
    };
  }

  /** Temporal coherence of a candidate's four books right now (for the skew gate). */
  private temporalFor(
    candidate: BoxCandidate,
    detByRole: Map<BoxLegRole, BoxLegEvaluation>,
    now: number,
  ): BoxTemporalCoherence {
    return temporalCoherence(
      BOX_LEG_ROLES.map((role) => {
        const q = this.deps.quotes.get(candidate.legs[role].token);
        const det = detByRole.get(role);
        return {
          received_at: q?.at ?? null,
          exchange_at: q?.exchange_at ?? null,
          current_version: q?.version ?? null,
          detection_version: det?.quote_version ?? null,
        };
      }),
      now,
    );
  }

  /**
   * The four legs' CURRENT books as coherence evidence for the shared policy.
   *
   * `reference_version` is the DETECTION version, so the shared decision can see whether a book
   * moved since detection. The paper store carries no socket generation, so `generation` is null
   * (a single-generation run) and the caller passes no `currentGeneration`; the generation-split
   * and stale-generation checks are then inert, which is correct for the deterministic simulator.
   */
  private coherenceObservations(
    candidate: BoxCandidate,
    detByRole: Map<BoxLegRole, BoxLegEvaluation>,
  ): CoherenceLegObservation[] {
    return BOX_LEG_ROLES.map((role) => {
      const q = this.deps.quotes.get(candidate.legs[role].token);
      const det = detByRole.get(role);
      return {
        role,
        received_at: q?.at ?? null,
        exchange_at: q?.exchange_at ?? null,
        current_version: q?.version ?? null,
        reference_version: det?.quote_version ?? null,
        generation: null,
        has_depth: q ? q.bids.length > 0 && q.asks.length > 0 : false,
      } satisfies CoherenceLegObservation;
    });
  }

  /**
   * Build a full candidate evaluation from the AVERAGE FILL prices of the four
   * legs — the economics of the position actually acquired.
   *
   * Depth (for the trade audit) is taken from the book each leg last filled from.
   */
  private evaluationFromFills(
    candidate: BoxCandidate,
    legs: PaperLegExecution[],
    booksAtFill: Map<number, BoxQuote>,
    at: number,
  ): BoxEvaluation {
    const legEvals: BoxLegEvaluation[] = BOX_LEG_ROLES.map((role) => {
      const leg = legs.find((l) => l.role === role)!;
      const inst = candidate.legs[role];
      const book = booksAtFill.get(inst.token);
      return this.legEvaluationFromFill(role, leg, inst, book, at);
    });
    return this.assembleEvaluation(candidate, legEvals, at);
  }

  private leggingRefuse(
    record: PaperLeggingExecutionRecord,
    reason: BoxExecutionFailureReason,
    detail: string,
  ): BoxLeggingResult {
    record.failure_reason = reason;
    record.failure_detail = detail;
    // A refusal reached here only when NOTHING filled, so it cost nothing. Labelled distinctly
    // from a partial entry precisely so the UI can stop treating the two as the same event.
    if (record.outcome_class === undefined) {
      record.outcome_class = record.legs.some((leg) => leg.fill_qty > 0)
        ? "PARTIAL_ENTRY_UNWOUND"
        : "REFUSED_BEFORE_SUBMIT";
    }
    this.deps.metrics?.recordExecutionFailed(reason);
    return { ok: false, legging: record, reason, detail };
  }

  /* ---------------------------------- exit -------------------------------- */

  /**
   * Simulate the execution of an exit.
   *
   * The same discipline as an entry: after the simulated delay the unwind is priced
   * from books the market actually published, and `validate` gets the final say on
   * those prices. An exit that only looked profitable at detection is refused
   * rather than recorded at prices that were never available.
   */
  async simulateExit(args: {
    position: BoxOpenPosition;
    detectionLegs: BoxLegEvaluation[];
    detectedAt: number;
    /** Final say on the executed prices. Return a reason to refuse. */
    validate?: (
      legs: BoxLegEvaluation[],
      measuredSlippage: number,
    ) => { ok: true } | { ok: false; reason: BoxExecutionFailureReason; detail: string };
    stillWanted?: () => boolean;
  }): Promise<BoxExitExecutionResult> {
    const { position, detectionLegs } = args;
    const key = `exit:${position.id}`;
    const direction = position.direction ?? "LONG_BOX";

    if (this.mode === "live") {
      return this.refuseLegs(
        detectionLegs,
        args.detectedAt,
        "discovery_stopped",
        "live OrderManager is not integrated with BoxExecutionSimulator; refusing a paper fallback",
      );
    }

    if (this.inFlight.has(key)) {
      return this.refuseLegs(detectionLegs, args.detectedAt, "duplicate", "an exit pipeline is already running for this position");
    }
    this.inFlight.add(key);
    this.active++;

    try {
      const timing = this.timingFor(args.detectedAt);
      const tokens = BOX_LEG_ROLES.map((role) => position.legs[role].token);
      const captured = await this.awaitBooks(tokens, timing.arrivalAt);

      if (args.stillWanted && !args.stillWanted()) {
        return this.refuseLegs(detectionLegs, args.detectedAt, "discovery_stopped", "the position was no longer closable after the simulated delay", timing);
      }
      if (!this.deps.isMarketOpen()) {
        return this.refuseLegs(detectionLegs, args.detectedAt, "market_closed", "the market closed during the simulated exit delay", timing);
      }
      if (!this.deps.isFeedHealthy()) {
        return this.refuseLegs(detectionLegs, args.detectedAt, "feed_unhealthy", "the WebSocket feed went unhealthy during the simulated exit delay", timing);
      }

      const missing = tokens.filter((t) => !captured.has(t));
      if (missing.length > 0) {
        return this.refuseLegs(
          detectionLegs,
          args.detectedAt,
          "missing_book",
          `no WebSocket book published at or after the simulated arrival for ${missing.length} exit leg(s)`,
          timing,
        );
      }

      timing.executedAt = Math.max(timing.arrivalAt, this.now());

      const legs: BoxLegEvaluation[] = BOX_LEG_ROLES.map((role) => {
        const inst = position.legs[role];
        const quote = captured.get(inst.token)!;
        return this.legFromQuote({
          role,
          side: exitSideFor(role, direction),
          inst,
          quote,
          lotSize: position.lot_size,
          now: timing.executedAt,
          maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
        });
      });

      const record = this.buildRecordFromLegs({
        timing,
        detectionLegs,
        executionLegs: legs,
        lotSize: position.lot_size,
        captured,
      });

      const notExecutable = legs.find((l) => !l.executable || !l.fresh);
      if (notExecutable) {
        const reason: BoxExecutionFailureReason =
          notExecutable.price === null || !(notExecutable.price > 0)
            ? "price_moved"
            : "insufficient_quantity";
        return this.fail(record, reason, `${notExecutable.tradingsymbol} could not fill one lot at the executed touch`);
      }

      if (args.validate) {
        const verdict = args.validate(legs, record.total_slippage);
        if (!verdict.ok) return this.fail(record, verdict.reason, verdict.detail);
      }

      record.filled = true;
      this.deps.metrics?.recordExitSlippage(record.total_slippage);
      return { ok: true, legs, record };
    } finally {
      this.active--;
      this.inFlight.delete(key);
    }
  }

  /* -------------------------------- internals ----------------------------- */

  private timingFor(detectedAt: number): {
    detectedAt: number;
    sentAt: number;
    arrivalAt: number;
    executedAt: number;
  } {
    const cfg = this.deps.cfg;
    if (cfg.executionMode === "paper_touch") {
      // No delay is modelled: the fill is taken from the detection instant.
      return { detectedAt, sentAt: detectedAt, arrivalAt: detectedAt, executedAt: detectedAt };
    }
    const sentAt = detectedAt + Math.max(0, cfg.simulatedDecisionMs);
    const arrivalAt = sentAt + Math.max(0, cfg.simulatedLatencyMs);
    return { detectedAt, sentAt, arrivalAt, executedAt: arrivalAt };
  }

  /**
   * The LATEST VALID book for each token AT the simulated arrival time.
   *
   * TASK 2 — this deliberately models "the current market state at arrival",
   * NOT "the first tick published after arrival". A resting order book does not
   * stop being valid just because no new tick arrived after our order reached the
   * exchange: an option quoted `Ask ₹100 × 500` at 10:00:00.000 with no update is
   * still `Ask ₹100 × 500` at 10:00:00.250. Requiring a fresh post-arrival tick
   * falsely rejected quiet-but-valid books.
   *
   * So: wait until arrival (we cannot act before the order lands), then read the
   * store's current book per token. Any tick that landed DURING the latency is
   * naturally the current book by then, so an adverse or favourable in-flight move
   * is used automatically. A book that is simply old is judged by the downstream
   * freshness check (age at executedAt vs `quoteMaxAgeMs`), and a token with no
   * book at all is `missing_book`.
   *
   * `paper_touch` keeps its definition: the detection-instant book, no delay.
   */
  private async awaitBooks(
    tokens: number[],
    arrivalAt: number,
  ): Promise<Map<number, BoxQuote>> {
    const wanted = new Set(tokens);
    const captured = new Map<number, BoxQuote>();

    const takeCurrent = () => {
      captured.clear();
      for (const token of wanted) {
        const q = this.deps.quotes.get(token);
        // The store replaces quote objects rather than mutating them, so holding
        // this reference is a permanent record of exactly this packet.
        if (q) captured.set(token, q);
      }
    };

    if (this.deps.cfg.executionMode === "paper_touch") {
      takeCurrent();
      return captured;
    }

    // Wait until the simulated arrival instant, in bounded steps, so any ticks
    // published during the latency window land in the store first. In live
    // operation this is a real sleep; in tests the injected clock advances and
    // fires scheduled ticks. We never wait for a NEW tick — only until arrival.
    const poll = Math.max(1, this.deps.cfg.executionPollMs);
    let guard = 0;
    while (this.now() < arrivalAt) {
      const remaining = arrivalAt - this.now();
      await this.wait(Math.min(remaining, poll));
      if (++guard > 100_000) break; // never spin forever on a stuck clock
    }

    // Read the latest current book for every leg. Freshness/existence/quantity
    // are validated by the caller against `executedAt`.
    takeCurrent();
    return captured;
  }

  /**
   * Assemble a BoxEvaluation from four already-priced leg evaluations.
   *
   * Mirrors the arithmetic in math.evaluateCandidate but takes explicit leg
   * prices (the average fills) rather than reading the touch from a book — so the
   * qualification prices the position we actually hold.
   */
  private assembleEvaluation(
    candidate: BoxCandidate,
    legs: BoxLegEvaluation[],
    at: number,
  ): BoxEvaluation {
    const direction = candidate.direction ?? "LONG_BOX";
    const sign = directionSign(direction);
    const lotSize = candidate.lot_size;
    let havePrices = true;
    let netDebit = 0;
    let version: number | null = null;
    let worstAge: number | null = null;
    let agesSeen = 0;
    let depthOk = true;
    for (const leg of legs) {
      if (leg.price === null) havePrices = false;
      else netDebit += (leg.side === "BUY" ? 1 : -1) * leg.price;
      if (leg.age_ms !== null) {
        agesSeen++;
        if (worstAge === null || leg.age_ms > worstAge) worstAge = leg.age_ms;
      }
      if (leg.quote_version != null && (version === null || leg.quote_version > version)) {
        version = leg.quote_version;
      }
      if (!(leg.price !== null && leg.price > 0 && leg.executable)) depthOk = false;
    }
    const netDebitPerUnit = havePrices ? round2(netDebit) : null;
    const grossPerUnit =
      netDebitPerUnit === null ? null : round2(sign * candidate.box_width - netDebitPerUnit);
    const grossEdge = grossPerUnit === null ? null : round2(grossPerUnit * lotSize);
    return {
      candidate,
      at,
      legs,
      entry_net_debit_per_unit: netDebitPerUnit,
      entry_box_cost_per_unit: netDebitPerUnit,
      gross_edge_per_unit: grossPerUnit,
      gross_edge: grossEdge,
      tradable: havePrices && legs.every((l) => l.executable),
      depth_ok: depthOk,
      worst_age_ms: agesSeen === legs.length ? worstAge : null,
      quote_version: version,
      reject: havePrices ? null : "no_quote",
    };
  }

  /** One leg evaluated from one exact captured book, with its depth recorded. */
  private legFromQuote(args: {
    role: BoxLegRole;
    side: OrderSide;
    inst: { token: number; tradingsymbol: string; strike: number; instrument_type: "CE" | "PE" };
    quote: BoxQuote;
    lotSize: number;
    now: number;
    maxAgeMs: number;
  }): BoxLegEvaluation {
    const { role, side, inst, quote, lotSize, now, maxAgeMs } = args;
    const isBuy = side === "BUY";
    const levels = isBuy ? quote.asks : quote.bids;
    let price: number | null = null;
    for (const lv of levels) {
      if (!(lv.price > 0)) continue;
      if (price === null) price = lv.price;
      else price = isBuy ? Math.min(price, lv.price) : Math.max(price, lv.price);
    }
    if (price === null) {
      const scalar = isBuy ? quote.ask : quote.bid;
      price = scalar > 0 ? scalar : null;
    }
    let qty = 0;
    if (price !== null) {
      for (const lv of levels) if (lv.price === price && lv.qty > 0) qty += lv.qty;
      if (qty === 0) {
        const scalarPrice = isBuy ? quote.ask : quote.bid;
        if (scalarPrice === price) qty = isBuy ? quote.ask_qty : quote.bid_qty;
      }
    }
    const age = now - quote.at;
    return {
      role,
      side,
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      price,
      qty_at_touch: qty,
      bid: quote.bid,
      bid_qty: quote.bid_qty,
      ask: quote.ask,
      ask_qty: quote.ask_qty,
      quote_at: quote.at,
      quote_version: quote.version,
      // The fill's audit record: captured here and nowhere on the hot path.
      depth: cloneDepth(quote),
      age_ms: age,
      fresh: age >= 0 ? age <= maxAgeMs : false,
      executable: price !== null && price > 0 && qty >= lotSize,
    };
  }

  /** A full candidate evaluation built from the captured books. */
  private evaluateFromCaptured(
    candidate: BoxCandidate,
    captured: Map<number, BoxQuote>,
    at: number,
  ): BoxEvaluation {
    // Reuse the single source of truth for the arithmetic, feeding it exactly the
    // captured books rather than whatever the store holds now.
    return evaluateCandidate({
      candidate,
      quotes: captured,
      now: at,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      captureDepth: true,
    });
  }

  private buildRecord(args: {
    mode: ExecutionMode;
    timing: { detectedAt: number; sentAt: number; arrivalAt: number; executedAt: number };
    detection: BoxEvaluation;
    execution: BoxEvaluation;
    lotSize: number;
    captured: Map<number, BoxQuote>;
  }): BoxExecutionRecord {
    const { timing, detection, execution, lotSize } = args;
    const detByRole = new Map(detection.legs.map((l) => [l.role, l]));

    let totalSlippage = 0;
    const legs: BoxExecutionLeg[] = execution.legs.map((exec) => {
      const det = detByRole.get(exec.role);
      const perUnit = slippagePerUnit(exec.side, det?.price ?? null, exec.price);
      const slip = perUnit === null ? null : round2(perUnit * lotSize);
      if (slip !== null) totalSlippage += slip;
      const detVer = det?.quote_version ?? null;
      const execVer = exec.quote_version ?? null;
      return {
        role: exec.role,
        side: exec.side,
        token: exec.token,
        tradingsymbol: exec.tradingsymbol,
        detected_price: det?.price ?? null,
        detected_qty: det?.qty_at_touch ?? 0,
        detected_quote_version: detVer,
        detected_quote_at: det?.quote_at ?? null,
        detected_exchange_at: det?.exchange_at ?? null,
        detected_depth: det?.depth ? { bids: det.depth.bids.map((level) => ({ ...level })), asks: det.depth.asks.map((level) => ({ ...level })) } : null,
        executed_price: exec.price,
        executed_qty: exec.qty_at_touch,
        executed_quote_version: execVer,
        executed_quote_at: exec.quote_at,
        executed_exchange_at: args.captured.get(exec.token)?.exchange_at ?? exec.exchange_at ?? null,
        slippage_per_unit: perUnit,
        slippage: slip,
        executed_book_age_ms: exec.age_ms,
        // A newer book arrived during the latency when the version advanced.
        book_changed: detVer !== null && execVer !== null && execVer !== detVer,
        executed_depth: exec.depth ?? null,
      };
    });

    return {
      mode: args.mode,
      detected_at: timing.detectedAt,
      order_sent_at: timing.sentAt,
      executed_at: timing.executedAt,
      decision_to_fill_ms: Math.max(0, timing.executedAt - timing.detectedAt),
      simulated_decision_ms: timing.sentAt - timing.detectedAt,
      simulated_latency_ms: timing.arrivalAt - timing.sentAt,
      detection_quote_version: detection.quote_version,
      execution_quote_version: execution.quote_version,
      detected_net_debit_per_unit: detection.entry_net_debit_per_unit,
      executed_net_debit_per_unit: execution.entry_net_debit_per_unit,
      detected_gross_edge: detection.gross_edge,
      executed_gross_edge: execution.gross_edge,
      total_slippage: round2(totalSlippage),
      legs,
      filled: false,
      failure_reason: null,
      failure_detail: null,
    };
  }

  /** The same record shape for an exit, where there is no candidate evaluation. */
  private buildRecordFromLegs(args: {
    timing: { detectedAt: number; sentAt: number; arrivalAt: number; executedAt: number };
    detectionLegs: BoxLegEvaluation[];
    executionLegs: BoxLegEvaluation[];
    lotSize: number;
    captured: Map<number, BoxQuote>;
  }): BoxExecutionRecord {
    const { timing, detectionLegs, executionLegs, lotSize } = args;
    const detByRole = new Map(detectionLegs.map((l) => [l.role, l]));
    let totalSlippage = 0;
    let detVersion: number | null = null;
    let execVersion: number | null = null;

    const legs: BoxExecutionLeg[] = executionLegs.map((exec) => {
      const det = detByRole.get(exec.role);
      const perUnit = slippagePerUnit(exec.side, det?.price ?? null, exec.price);
      const slip = perUnit === null ? null : round2(perUnit * lotSize);
      if (slip !== null) totalSlippage += slip;
      if (det?.quote_version != null && (detVersion === null || det.quote_version > detVersion)) {
        detVersion = det.quote_version;
      }
      if (exec.quote_version != null && (execVersion === null || exec.quote_version > execVersion)) {
        execVersion = exec.quote_version;
      }
      return {
        role: exec.role,
        side: exec.side,
        token: exec.token,
        tradingsymbol: exec.tradingsymbol,
        detected_price: det?.price ?? null,
        detected_qty: det?.qty_at_touch ?? 0,
        detected_quote_version: det?.quote_version ?? null,
        detected_quote_at: det?.quote_at ?? null,
        detected_exchange_at: det?.exchange_at ?? null,
        detected_depth: det?.depth ? { bids: det.depth.bids.map((level) => ({ ...level })), asks: det.depth.asks.map((level) => ({ ...level })) } : null,
        executed_price: exec.price,
        executed_qty: exec.qty_at_touch,
        executed_quote_version: exec.quote_version ?? null,
        executed_quote_at: exec.quote_at,
        executed_exchange_at: args.captured.get(exec.token)?.exchange_at ?? exec.exchange_at ?? null,
        slippage_per_unit: perUnit,
        slippage: slip,
        executed_depth: exec.depth ?? null,
      };
    });

    return {
      mode: this.mode,
      detected_at: timing.detectedAt,
      order_sent_at: timing.sentAt,
      executed_at: timing.executedAt,
      decision_to_fill_ms: Math.max(0, timing.executedAt - timing.detectedAt),
      simulated_decision_ms: timing.sentAt - timing.detectedAt,
      simulated_latency_ms: timing.arrivalAt - timing.sentAt,
      detection_quote_version: detVersion,
      execution_quote_version: execVersion,
      detected_net_debit_per_unit: null,
      executed_net_debit_per_unit: null,
      detected_gross_edge: null,
      executed_gross_edge: null,
      total_slippage: round2(totalSlippage),
      legs,
      filled: false,
      failure_reason: null,
      failure_detail: null,
    };
  }

  /** Mark an already-built record as failed and count it. */
  private fail(
    record: BoxExecutionRecord,
    reason: BoxExecutionFailureReason,
    detail: string,
  ): BoxExecutionRefusal {
    record.filled = false;
    record.failure_reason = reason;
    record.failure_detail = detail;
    this.deps.metrics?.recordExecutionFailed(reason);
    return { ok: false, record, reason, detail };
  }

  /** A refusal that happened before an execution snapshot could be built. */
  private refuse(
    detection: BoxEvaluation,
    reason: BoxExecutionFailureReason,
    detail: string,
    timing?: { detectedAt: number; sentAt: number; arrivalAt: number; executedAt: number },
    captured?: Map<number, BoxQuote>,
  ): BoxExecutionRefusal {
    const t = timing ?? this.timingFor(detection.at);
    const record: BoxExecutionRecord = {
      mode: this.mode,
      detected_at: t.detectedAt,
      order_sent_at: t.sentAt,
      executed_at: null,
      decision_to_fill_ms: null,
      simulated_decision_ms: t.sentAt - t.detectedAt,
      simulated_latency_ms: t.arrivalAt - t.sentAt,
      detection_quote_version: detection.quote_version,
      execution_quote_version: null,
      detected_net_debit_per_unit: detection.entry_net_debit_per_unit,
      executed_net_debit_per_unit: null,
      detected_gross_edge: detection.gross_edge,
      executed_gross_edge: null,
      total_slippage: 0,
      legs: detection.legs.map((det) => ({
        role: det.role,
        side: det.side,
        token: det.token,
        tradingsymbol: det.tradingsymbol,
        detected_price: det.price,
        detected_qty: det.qty_at_touch,
        detected_quote_version: det.quote_version ?? null,
        detected_quote_at: det.quote_at,
        executed_price: null,
        executed_qty: 0,
        executed_quote_version: captured?.get(det.token)?.version ?? null,
        executed_quote_at: captured?.get(det.token)?.at ?? null,
        slippage_per_unit: null,
        slippage: null,
        executed_depth: null,
      })),
      filled: false,
      failure_reason: reason,
      failure_detail: detail,
    };
    this.deps.metrics?.recordExecutionFailed(reason);
    return { ok: false, record, reason, detail };
  }

  /** The same, for an exit refusal where only leg evaluations exist. */
  private refuseLegs(
    detectionLegs: BoxLegEvaluation[],
    detectedAt: number,
    reason: BoxExecutionFailureReason,
    detail: string,
    timing?: { detectedAt: number; sentAt: number; arrivalAt: number; executedAt: number },
  ): BoxExecutionRefusal {
    const t = timing ?? this.timingFor(detectedAt);
    const record: BoxExecutionRecord = {
      mode: this.mode,
      detected_at: t.detectedAt,
      order_sent_at: t.sentAt,
      executed_at: null,
      decision_to_fill_ms: null,
      simulated_decision_ms: t.sentAt - t.detectedAt,
      simulated_latency_ms: t.arrivalAt - t.sentAt,
      detection_quote_version: null,
      execution_quote_version: null,
      detected_net_debit_per_unit: null,
      executed_net_debit_per_unit: null,
      detected_gross_edge: null,
      executed_gross_edge: null,
      total_slippage: 0,
      legs: detectionLegs.map((det) => ({
        role: det.role,
        side: det.side,
        token: det.token,
        tradingsymbol: det.tradingsymbol,
        detected_price: det.price,
        detected_qty: det.qty_at_touch,
        detected_quote_version: det.quote_version ?? null,
        detected_quote_at: det.quote_at,
        executed_price: null,
        executed_qty: 0,
        executed_quote_version: null,
        executed_quote_at: null,
        slippage_per_unit: null,
        slippage: null,
        executed_depth: null,
      })),
      filled: false,
      failure_reason: reason,
      failure_detail: detail,
    };
    this.deps.metrics?.recordExecutionFailed(reason);
    return { ok: false, record, reason, detail };
  }
}

/**
 * A convenience re-export so callers can build the detection-side exit legs with
 * the same helper the monitor uses.
 */
export { evaluateExitLegs };
