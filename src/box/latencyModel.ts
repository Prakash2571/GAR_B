/**
 * STRUCTURED LATENCY MODEL — the vocabulary of measurable execution delay, plus a
 * deterministic source that turns REAL measured samples into paper scheduling inputs.
 *
 * WHY NOT "latency = 250 ms"
 *
 * A single constant either hides the tail (optimistic) or overweights it (pessimistic),
 * and — worse — it collapses stages that behave very differently. A live four-leg Box
 * entry's time-to-fill is really the sum of distinct, separately-measurable stages:
 *
 *   detection → internal processing → OrderManager queue wait → transport pacing wait →
 *   HTTP/network → broker/RMS ACK → waiting for executable liquidity → first fill → …
 *
 * This module names those stages ({@link LATENCY_COMPONENTS}) so live observability can
 * measure each one independently and paper can be calibrated from the ones we can
 * actually observe — never from a random generator.
 *
 * WHAT PAPER NEEDS FROM CALIBRATION
 *
 * The paper scheduler ({@link ../paperScheduler}) computes `queue_wait_ms` and
 * `transport_wait_ms` itself from the shared policy — those are a function of the queue
 * and the min-interval, not of the broker. What it CANNOT compute, and must be fed from
 * measured live data, are the broker-side spans:
 *
 *   - `post_to_ack_ms`   — POST leaves the wire → broker acknowledges (order live).
 *   - `ack_to_terminal_ms` — ACK → the order resolves (the slot is held this long).
 *
 * {@link StructuredLatencySource} supplies exactly those two, drawn deterministically
 * (never `Math.random()`), per broker, so paper's slot occupancy and exchange-arrival
 * timing match what the account actually experienced.
 *
 * DETERMINISM & CALIBRATION HONESTY
 *
 * Draws are reproducible. And the source ALWAYS reports whether it is running on measured
 * samples or a conservative constant fallback ({@link CalibrationStatus}), so nothing ever
 * pretends a constant is measured live latency.
 */

import { createLatencySource, type LatencyMode, type LatencySource } from "./latencySource.js";
import { NSE_SESSION_CLOSE_MINUTES, NSE_SESSION_OPEN_MINUTES } from "../marketCalendar.js";

/** The brokers whose latency is measured and calibrated independently — never mixed. */
export type BrokerId = "zerodha" | "dhan";
export const BROKER_IDS: readonly BrokerId[] = ["zerodha", "dhan"] as const;

/**
 * The operation classes latency is bucketed by (where sample count allows). Distinct from
 * `BoxOrderPurpose`: UNWIND is the emergency-residual flatten, CANCEL/MODIFY are transport
 * operations. Kept separate so, e.g., entry ACK latency never contaminates cancel latency.
 */
export type LatencyOperationKind = "ENTRY" | "EXIT" | "UNWIND" | "CANCEL" | "MODIFY";
export const LATENCY_OPERATION_KINDS: readonly LatencyOperationKind[] = [
  "ENTRY",
  "EXIT",
  "UNWIND",
  "CANCEL",
  "MODIFY",
] as const;

/**
 * The measurable stages of one broker operation's latency. Not every value exists for
 * every order (a rejected order has no first-fill); absent stages are recorded as null,
 * never fabricated.
 */
export const LATENCY_COMPONENTS = [
  "queue_wait_ms",
  "transport_wait_ms",
  "post_to_http_response_ms",
  "post_to_ack_ms",
  "ack_to_first_fill_ms",
  "first_fill_to_terminal_ms",
  "submit_to_first_fill_ms",
  "submit_to_terminal_ms",
] as const;
export type LatencyComponent = (typeof LATENCY_COMPONENTS)[number];

/* ------------------------- calibration dimensions ------------------------- */

/**
 * How the order interacts with the book — the single most important calibration dimension
 * after the broker itself, and one that must NEVER be pooled.
 *
 *   MARKETABLE_LIMIT — priced to cross immediately: a bounded limit at or through the touch.
 *                      Its fill behaviour depends mostly on visible depth within the limit,
 *                      which we CAN observe. This is what the Box strategy submits.
 *   PASSIVE_LIMIT    — priced away from the touch, resting behind other orders. Whether and
 *                      when it fills depends overwhelmingly on true NSE queue position and on
 *                      other participants' flow — neither of which a retail feed reveals.
 *
 * Pooling the two would be actively misleading: passive fill rates are far lower and far more
 * variable, so a blended "fill rate" flatters passive orders and slanders marketable ones,
 * and a blended latency distribution describes neither. Every distribution, every parity
 * comparison and every realism score in this system is therefore keyed by profile.
 */
export type LatencyProfile = "MARKETABLE_LIMIT" | "PASSIVE_LIMIT";
export const LATENCY_PROFILES: readonly LatencyProfile[] = ["MARKETABLE_LIMIT", "PASSIVE_LIMIT"] as const;

/**
 * Coarse time-of-day bucket. Execution latency and liquidity genuinely differ across the
 * session — the open is thin and fast-moving, the close carries square-off flow — so a
 * single all-day distribution smears three different regimes together.
 *
 * DELIBERATELY COARSE. Three buckets, not twelve. A bucket is only used when it has enough
 * observations of its own (see `ResolvedCalibration.fallback`); otherwise the broker-wide set
 * is used instead. Overfitting a tiny sample to a narrow time window would produce
 * confident-looking numbers with no statistical basis, which is worse than a coarse average.
 */
export type TimeOfDayBucket = "OPEN" | "NORMAL" | "CLOSE";
export const TIME_OF_DAY_BUCKETS: readonly TimeOfDayBucket[] = ["OPEN", "NORMAL", "CLOSE"] as const;

/**
 * NSE equity-derivatives session, in minutes past IST midnight.
 *
 * Re-exported from the calendar rather than redeclared, so the session boundaries have exactly one
 * definition across the codebase.
 */
export const IST_MARKET_OPEN_MINUTES = NSE_SESSION_OPEN_MINUTES;
export const IST_MARKET_CLOSE_MINUTES = NSE_SESSION_CLOSE_MINUTES;

export interface TimeBucketBoundaries {
  /** Minutes from the open that count as OPEN. Default 15 (09:15–09:30). */
  openWindowMinutes: number;
  /** Minutes before the close that count as CLOSE. Default 15 (15:15–15:30). */
  closeWindowMinutes: number;
}

export const DEFAULT_TIME_BUCKET_BOUNDARIES: TimeBucketBoundaries = {
  openWindowMinutes: 15,
  closeWindowMinutes: 15,
};

/**
 * Classify minutes-past-IST-midnight into a bucket. Pure.
 *
 * Anything outside the session maps to NORMAL: an operation observed outside market hours is
 * not evidence about the open or the close, and inventing a fourth bucket for it would split
 * samples for no benefit.
 */
export function classifyTimeOfDayBucket(
  istMinutesOfDay: number,
  boundaries: TimeBucketBoundaries = DEFAULT_TIME_BUCKET_BOUNDARIES,
): TimeOfDayBucket {
  if (!Number.isFinite(istMinutesOfDay)) return "NORMAL";
  const openWindow = Math.max(0, boundaries.openWindowMinutes);
  const closeWindow = Math.max(0, boundaries.closeWindowMinutes);
  if (istMinutesOfDay < IST_MARKET_OPEN_MINUTES || istMinutesOfDay > IST_MARKET_CLOSE_MINUTES) {
    return "NORMAL";
  }
  if (istMinutesOfDay < IST_MARKET_OPEN_MINUTES + openWindow) return "OPEN";
  if (istMinutesOfDay > IST_MARKET_CLOSE_MINUTES - closeWindow) return "CLOSE";
  return "NORMAL";
}

/** Minutes past IST midnight for a wall-clock instant. */
export function istMinutesOfDayFor(atWall: number): number {
  const ist = new Date(atWall + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** IST calendar day key (`YYYY-MM-DD`) — the session identity used for freshness. */
export function istSessionKey(atWall: number): string {
  const ist = new Date(atWall + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/* --------------------------- calibration status --------------------------- */

/**
 * Whether paper is running on measured live latency, and how much to trust it.
 *
 *   UNCALIBRATED         — no live samples; paper falls back to a conservative constant.
 *   PARTIALLY_CALIBRATED — some samples, but below the confidence threshold.
 *   CALIBRATED           — enough recent samples to trust the distribution.
 *   STALE                — was calibrated, but the newest sample is older than the freshness
 *                          window (market/network conditions may have shifted since).
 */
export type CalibrationStatus =
  | "UNCALIBRATED"
  | "PARTIALLY_CALIBRATED"
  | "CALIBRATED"
  | "STALE";

export interface CalibrationThresholds {
  /** At/above this many recent samples the distribution is trusted. Default 200. */
  calibratedMinSamples: number;
  /** A sample older than this (ms) makes an otherwise-calibrated set STALE. Default 1 trading day. */
  staleAfterMs: number;
}

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  calibratedMinSamples: 200,
  // ~6.5h trading day + margin. Latency shifts by session, so a set from a previous day
  // should not silently calibrate today without an explicit refresh.
  staleAfterMs: 8 * 60 * 60 * 1000,
};

/**
 * Classify a calibration set. Pure: given sample count and the age of the newest sample,
 * return the status. `lastSampleAgeMs === null` means "no samples".
 */
export function classifyCalibration(
  sampleCount: number,
  lastSampleAgeMs: number | null,
  thresholds: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
): CalibrationStatus {
  if (sampleCount <= 0 || lastSampleAgeMs === null) return "UNCALIBRATED";
  const stale = lastSampleAgeMs > thresholds.staleAfterMs;
  if (sampleCount >= thresholds.calibratedMinSamples) return stale ? "STALE" : "CALIBRATED";
  return "PARTIALLY_CALIBRATED";
}

/**
 * How much a reported figure should be trusted — the number that goes on every parity report.
 *
 * This exists because "the simulator is 95 % realistic" is a claim, and a claim needs
 * evidence. There is no arithmetic that turns 12 observations into a confident statement about
 * a latency tail, so the report says LOW and the reader knows to keep validating.
 *
 *   HIGH   — a calibrated, fresh set with a large sample count. Percentile tails are meaningful.
 *   MEDIUM — genuinely measured, but either the sample count only just clears the bar or the
 *            set is a fallback from a narrower dimension. Central tendency is usable; tails
 *            are not.
 *   LOW    — too few samples, stale, or not measured at all. Diagnostic only. Nothing here
 *            justifies a realism claim.
 */
export type CalibrationConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface ConfidenceThresholds {
  /** At/above this many fresh samples a calibrated set is HIGH confidence. Default 200. */
  highMinSamples: number;
  /** At/above this many fresh samples a set is at least MEDIUM. Default 30. */
  mediumMinSamples: number;
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  highMinSamples: 200,
  mediumMinSamples: 30,
};

/**
 * Classify confidence. Pure and deliberately pessimistic:
 *
 *  - anything not backed by measured samples is LOW, whatever the sample count says;
 *  - a STALE or UNCALIBRATED set is LOW, however large — yesterday's tail is not today's;
 *  - a set reached only by falling back from a narrower dimension is capped at MEDIUM, because
 *    it is evidence about a broader population than the one being asked about.
 */
export function classifyConfidence(args: {
  status: CalibrationStatus;
  sampleCount: number;
  /** False when the figures are a configured constant rather than live observations. */
  measured: boolean;
  /** True when a broader dimension supplied the samples (e.g. broker-wide instead of a bucket). */
  fellBack?: boolean;
  thresholds?: ConfidenceThresholds;
}): CalibrationConfidence {
  if (!args.measured) return "LOW";
  if (args.status === "UNCALIBRATED" || args.status === "STALE") return "LOW";
  const t = args.thresholds ?? DEFAULT_CONFIDENCE_THRESHOLDS;
  if (args.sampleCount < t.mediumMinSamples) return "LOW";
  if (args.fellBack) return "MEDIUM";
  if (args.status === "CALIBRATED" && args.sampleCount >= t.highMinSamples) return "HIGH";
  return "MEDIUM";
}

/* ----------------------- structured latency source ------------------------ */

/** The broker-side spans the paper scheduler consumes per operation. */
export interface BrokerLatencyDraw {
  /** POST → broker ACK (ms). */
  postToAckMs: number;
  /** ACK → terminal resolution (ms) — how long the slot is held. */
  ackToTerminalMs: number;
}

export interface StructuredLatencyConfig {
  mode: LatencyMode;
  /** Conservative fallback when a component has no samples (typically BOX_SIMULATED_LATENCY_MS). */
  constantMs: number;
  /** Measured POST→ACK samples (ms). Empty ⇒ fall back to constant for this component. */
  postToAckSamples?: number[];
  /** Measured ACK→terminal samples (ms). Empty ⇒ fall back to a fraction of the constant. */
  ackToTerminalSamples?: number[];
  /** Deterministic starting offset; never introduces randomness. */
  seed?: number;
}

/**
 * A deterministic per-broker latency source for paper `live_parity`. Composes two
 * independent {@link LatencySource}s (POST→ACK and ACK→terminal) so each broker-side stage
 * is drawn from its own measured distribution, in a fixed order, reproducibly.
 */
export interface StructuredLatencySource {
  readonly mode: LatencyMode;
  /** True when at least one component is backed by measured samples. */
  readonly calibrated: boolean;
  /** Draw the components for the next operation and advance the cursors. */
  next(): BrokerLatencyDraw;
  /** Restart every component sequence — a fresh run reproduces the same draws. */
  reset(): void;
}

/**
 * When no ACK→terminal samples exist we approximate the post-ack working span as a
 * fraction of the single constant, so an uncalibrated run still separates "time to reach
 * the exchange" from "time working at the exchange" instead of collapsing both into one.
 */
const UNCALIBRATED_ACK_TO_TERMINAL_FRACTION = 0.4;

export function createStructuredLatencySource(
  config: StructuredLatencyConfig,
): StructuredLatencySource {
  const postToAck = createLatencySource({
    mode: config.mode,
    constantMs: config.constantMs,
    samples: config.postToAckSamples ?? [],
    seed: config.seed ?? 0,
  });
  const ackToTerminal = createLatencySource({
    mode: config.mode,
    constantMs: Math.round(config.constantMs * UNCALIBRATED_ACK_TO_TERMINAL_FRACTION),
    samples: config.ackToTerminalSamples ?? [],
    seed: config.seed ?? 0,
  });
  const calibrated =
    (config.postToAckSamples?.length ?? 0) > 0 || (config.ackToTerminalSamples?.length ?? 0) > 0;

  return new ComposedStructuredLatencySource(config.mode, postToAck, ackToTerminal, calibrated);
}

class ComposedStructuredLatencySource implements StructuredLatencySource {
  constructor(
    readonly mode: LatencyMode,
    private readonly postToAck: LatencySource,
    private readonly ackToTerminal: LatencySource,
    readonly calibrated: boolean,
  ) {}
  next(): BrokerLatencyDraw {
    return {
      postToAckMs: Math.max(0, this.postToAck.next()),
      ackToTerminalMs: Math.max(0, this.ackToTerminal.next()),
    };
  }
  reset(): void {
    this.postToAck.reset();
    this.ackToTerminal.reset();
  }
}
