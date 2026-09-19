/**
 * Box-scanner configuration.
 *
 * Everything the trading rules depend on is here and overridable by env var, so
 * the thresholds can be tuned without touching the engine. The headline
 * DEFAULTS are:
 *
 *   BOX_MIN_EXPECTED_NET_PROFIT  ₹1,200 — THE ENTRY GATE, after every cost
 *   MIN_BOX_GROSS_EDGE           ₹1,200 — a cheap prefilter only
 *   BOX_SAFETY_BUFFER            ₹150   — risk allowance inside the net figure
 *   BOX_EXECUTION_MODE           paper_latency
 *   BOX_SIMULATED_LATENCY_MS     250 ms — decision → exchange arrival
 *   BOX_QUOTE_MAX_AGE_MS         15,000 ms — how long an UNCHANGED book is valid
 *   strikes each side            3  (ATM ± 3 → at most 7 strikes → 21 pairs)
 */

import {
  ENTRY_SUBMIT_CONCURRENCY_MAX,
  ENTRY_SUBMIT_CONCURRENCY_MIN,
} from "./executionSchedulingPolicy.js";
import { normaliseAllowlist } from "./underlyingExclusions.js";
import { readZerodhaStaticIpPolicy, type ZerodhaStaticIpPolicy } from "./zerodhaStaticIp.js";
import type { BoxQueueModel, BoxScannerConfigSnapshot, ExecutionMode } from "./types.js";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * A TIMER PERIOD in milliseconds. A non-positive value is NOT honoured.
 *
 * WHY THIS EXISTS — A ZERO PERIOD IS A HOT LOOP, NEVER A CONFIGURATION
 * These values are passed straight to `setInterval`. `setInterval(fn, 0)` does not mean
 * "disabled" and does not mean "use the default" — it means *run as fast as the event loop
 * allows*, forever. Four of these periods drive the universe refresh, the indicative refresh,
 * the SSE publish and the position monitor, so a zero turns each into a spin loop. Together
 * they saturate the event loop, which starves the market-data drain (so depth never arrives
 * and the feed reports down while the socket is open), and makes HTTP requests time out at
 * the reverse proxy as intermittent 502s. The system looks broken in four unrelated places
 * and none of them names the cause.
 *
 * That was not hypothetical: `.env.example` shipped `BOX_UNIVERSE_REFRESH_MS=0` and friends
 * under a header saying "the defaults ARE the shipped specification", while `num()` treats an
 * explicit `0` as a finite value and returns it. Copying the example file verbatim — the
 * documented way to start — produced exactly that failure.
 *
 * So a non-finite, zero or negative period falls back to the code default, and a positive one
 * is floored at `minMs` so a typo like `1` cannot approximate the same spin loop. Values that
 * legitimately use 0 to mean "unbounded" or "disabled" (`BOX_MAX_UNDERLYINGS`,
 * `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS`, …) keep using `num` and are unaffected — this is
 * only for periods that become a timer.
 */
function periodMs(name: string, fallback: number, minMs = 10): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    console.warn(
      `[BoxConfig] ${name}="${raw.trim()}" is not a usable timer period; using the default ${fallback}ms. ` +
        `A period of 0 would spin the event loop rather than disable the timer. Leave it unset to use the default.`,
    );
    return fallback;
  }
  return Math.max(minMs, v);
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

/**
 * Split a comma-separated env value into raw, untrimmed parts.
 *
 * Deliberately does NOT normalise: the caller applies whatever domain rules belong to the list it is
 * building, so that one normaliser owns each domain rather than this helper guessing. Returns an
 * empty array for unset or blank, which every caller must therefore give an explicit meaning.
 */
function csv(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",");
}

/** Parse a comma-separated list of IST hours (0-23), de-duplicated and sorted. */
function hours(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
  if (parsed.length === 0) return fallback;
  return [...new Set(parsed)].sort((a, b) => a - b);
}

/** Clamp any input to a valid hour-of-day (0-23). */
function clampHour(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const n = Math.round(v);
  if (n < 0 || n > 23) return fallback;
  return n;
}

/** Clamp any input to a valid strikes-each-side level: 1, 2 or 3. */
export function clampStrikeLevel(v: number): 1 | 2 | 3 {
  const n = Math.round(v);
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

/**
 * Clamp an integer to [min, max] with a fallback for garbage input.
 *
 * Used for the new execution-realism knobs (chase ticks, dispersion), so a typo
 * in an env var can never widen the price band without bound or turn a delay
 * negative.
 */
function clampInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * A CONTAINMENT limit: absent means the default, but an explicitly-set invalid value is FATAL.
 *
 * THE DEFECT THIS CLOSES. `clampInt` funnels every kind of bad input to the fallback or the nearest
 * bound, and for the settings where `fallback === min === 0` AND `0` means "unlimited", that turns a
 * typo into the removal of a safety limit:
 *
 *     BOX_SESSION_MAX_ENTRY_ATTEMPTS="one"   -> NaN  -> fallback 0 -> UNLIMITED
 *     BOX_SESSION_MAX_ENTRY_ATTEMPTS="-1"    -> -1   -> clamp  0   -> UNLIMITED
 *     BOX_SESSION_MAX_ENTRY_ATTEMPTS="0.2"   -> 0.2  -> round  0   -> UNLIMITED
 *
 * An operator arming a one-attempt supervised trial who fat-fingers the value gets UNBOUNDED
 * attempts, and nothing anywhere says so. That is the exact inverse of what a containment limit is
 * for, so this helper refuses instead: two distinct mechanisms (`NaN` and the `Math.max(min, …)`
 * clamp) both used to reach 0, and both are rejected here.
 *
 * The distinction that matters is MISSING versus EXPLICITLY WRONG. An unset variable is a deliberate
 * "use the default" and stays silent. A variable the operator took the trouble to set, incorrectly,
 * must never be silently reinterpreted — least of all into the most permissive value available.
 *
 * Throwing is the right failure mode: this runs during config load at boot, and the alternative is a
 * process that trades with containment the operator believes is in force.
 */
function strictLimitInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(
      `[BoxConfig] ${name}="${text}" is not a number. This is a safety limit, so it is refused rather ` +
        `than defaulted — a typo here would silently remove the limit. Leave it unset to use the ` +
        `default (${fallback}), or set a whole number between ${min} and ${max}.`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new Error(
      `[BoxConfig] ${name}="${text}" must be a WHOLE number, not a fraction. Rounding it would change ` +
        `the limit you asked for (0.2 would become 0, which means UNLIMITED for this setting).`,
    );
  }
  if (value < min || value > max) {
    throw new Error(
      `[BoxConfig] ${name}="${text}" is outside the permitted range ${min}..${max}. It is refused ` +
        `rather than clamped, because silently narrowing or widening a safety limit hides the mistake.`,
    );
  }
  return value;
}


/**
 * A NON-NEGATIVE economic figure. An explicitly-set negative value is FATAL.
 *
 * THE FAIL-OPEN PATH THIS CLOSES. `num()` applies no floor whatsoever, so a finite negative passed
 * straight through. `BOX_MIN_EXPECTED_NET_PROFIT=-5000` loaded verbatim and became the ENTRY GATE —
 * i.e. "enter at a known loss of up to 5000". The codebase already knows this is illegitimate:
 * `BOX_TUNING_LIMITS` pins the same knob to `{min: 0}` and `validateTuning` REFUSES rather than
 * clamps, with the comment that a negative one "would mean 'enter at a known loss', which is never
 * intended". But that floor only guarded the runtime admin API; the env path had none, so the two
 * entry points disagreed about what was acceptable. A negative `BOX_SAFETY_BUFFER` or slippage
 * estimate is the same defect wearing different units — it makes expected profit look larger.
 */
function nonNegativeNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) {
    throw new Error(
      `[BoxConfig] ${name}="${text}" is negative. This figure feeds the entry/exit economics, and a ` +
        `negative value LOOSENS the gate rather than tightening it (for the profit floor it means ` +
        `"enter at a known loss"). Refused rather than clamped, so the mistake is visible. Leave it ` +
        `unset for the default (${fallback}), or set a value >= 0.`,
    );
  }
  return value;
}

/**
 * A boolean where an UNRECOGNISED value is FATAL rather than silently the fallback.
 *
 * `bool()` returns the FALLBACK on an unrecognised value. For the eleven knobs whose default is
 * `true` that is the protective direction — a typo re-enables a guard. `BOX_ENABLE_SHORT_BOX` is the
 * exception: its default `true` DOUBLES the tradeable direction set, so `=off`, `=no thanks`,
 * `=disabled` or `=flase` silently re-enabled short boxes an operator believed were off. Refusing is
 * the only answer that cannot be wrong in the dangerous direction.
 */
function strictBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  throw new Error(
    `[BoxConfig] ${name}="${raw.trim()}" is not a recognised boolean. This switch changes what the ` +
      `system is willing to trade, so an unrecognised value is refused rather than resolved to the ` +
      `default (${fallback}) — a typo must never widen it. Use true/false (or 1/0, yes/no).`,
  );
}

/** Clamp a percentage to [0, 100]. */
function clampPct(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(100, Math.max(0, v));
}

function queueModel(name: string, fallback: BoxQueueModel): BoxQueueModel {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "none") return "none";
  if (v === "haircut") return "haircut";
  console.warn(`[Box] ignoring unknown ${name}="${raw}" — using ${fallback}.`);
  return fallback;
}

/**
 * The paper execution profile.
 *
 *   standard    — today's behaviour, byte-for-byte.
 *   live_parity — EVIDENCE-DRIVEN. Shared liquidity ledger, the live scheduling policy, and
 *                 latency drawn from MEASURED live samples when calibration is valid. Nothing in
 *                 this profile is ever fabricated.
 *   stress      — RESILIENCE TESTING ONLY. Deliberately injects faults (broker slowdown, feed
 *                 gaps, rejects, duplicate/out-of-order events). It is a separate profile
 *                 precisely so that injected faults can never be mistaken for measured
 *                 behaviour, and so "live parity" always means evidence.
 *
 * `stress` is never a fallback and is never reached by accident: it must be named explicitly,
 * and {@link loadBoxConfig} refuses to start if it is combined with live execution.
 */
export type BoxPaperProfile = "standard" | "live_parity" | "stress";

function paperProfile(name: string, fallback: BoxPaperProfile): BoxPaperProfile {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "standard" || value === "live_parity" || value === "stress") return value;
  console.warn(`[Box] ignoring unknown ${name}="${raw}" — using ${fallback}.`);
  return fallback;
}

/** Latency-source mode for live-parity paper. */
function latencyMode(name: string, fallback: "constant" | "recorded_samples"): "constant" | "recorded_samples" {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "constant" || value === "recorded_samples") return value;
  console.warn(`[Box] ignoring unknown ${name}="${raw}" — using ${fallback}.`);
  return fallback;
}

/** A comma-separated list of non-negative millisecond samples. */
function msSamples(name: string): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .map((n) => Math.round(n));
}

function executionMode(name: string, fallback: ExecutionMode): ExecutionMode {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (
    value === "paper_touch" ||
    value === "paper_latency" ||
    value === "paper_legging" ||
    value === "live"
  ) {
    return value;
  }
  // Execution selection is safety-critical. A misspelling must stop startup,
  // never silently switch the process to a different execution model.
  throw new Error(
    `[Box] invalid ${name}="${raw}"; expected paper_touch, paper_latency, paper_legging, or live.`,
  );
}

export interface BoxConfig {
  // ---- Execution model ----
  /**
   * How a paper fill is simulated.
   *
   * "paper_latency" (default) waits a simulated decision + send delay and then
   * fills from the first WebSocket book published at or after that moment, so a
   * recorded fill is always a price the market actually showed AFTER the order
   * could have arrived. "paper_touch" fills at the detection touch and is kept
   * for comparison.
   */
  executionMode: ExecutionMode;
  /** Simulated internal decision/processing time before an order is "sent" (ms). */
  simulatedDecisionMs: number;
  /** Simulated order-send → exchange arrival latency (ms). */
  simulatedLatencyMs: number;
  /**
   * How long the simulator waits for a post-arrival book on every leg (ms).
   *
   * If a leg publishes nothing in that window there is no evidence of what it
   * would have filled at, so NO fill is invented — the attempt is recorded as
   * `missing_book`.
   */
  executionMaxWaitMs: number;
  /** How often the simulator re-checks for post-arrival books (ms). */
  executionPollMs: number;
  /** Cap on simultaneous simulated execution pipelines. */
  maxConcurrentExecutions: number;

  /**
   * Route the Box scanner's option tokens onto a DEDICATED market-data lane.
   *
   * A second physical WebSocket on the same ACTIVE broker (never a second broker), with
   * its own refcount table and its own token budget. On by default because the shared
   * feed makes the option universe and the calendar-spread board compete for one budget:
   * every strike the board displaces is an arbitrage the scanner cannot see.
   *
   * Turning it off falls back to the single shared feed, exactly as before.
   */
  boxDedicatedMarketFeed: boolean;

  // ---- Box execution coordination (shared-contract exclusion) ----
  /**
   * Master switch for the execution coordinator.
   *
   * On by default because without it two boxes sharing an option strike can be
   * submitted in the same instant, each assuming the whole displayed size at that
   * strike. Exposed so it can be turned off in an emergency without a redeploy — but
   * turning it off restores that behaviour.
   */
  executionCoordinatorEnabled: boolean;
  /** Whether to poll the broker for the account balance. Display only; never gates a trade. */
  accountFundsEnabled: boolean;
  accountFundsRefreshMs: number;
  /** How old the balance may be and still be reported as fresh. Wider than the refresh interval. */
  accountFundsFreshnessMaxAgeMs: number;
  /**
   * How long a box may wait for a contract another execution is holding.
   *
   * Deliberately short: the loser is woken by the holder's release (typically within
   * a millisecond) and then RE-PRICED, so this is the give-up bound, not the normal
   * path. Large values keep stale opportunities alive to no purpose.
   */
  conflictWaitMaxMs: number;
  /**
   * TTL on a contract reservation.
   *
   * This is the crash-recovery mechanism: a wedged or dead execution cannot hold a
   * contract beyond it. It is also how long a reservation is HELD when a terminal
   * broker state was ambiguous, so it must comfortably exceed a normal round trip.
   */
  instrumentLockTtlMs: number;
  /**
   * Optional per-underlying execution budget. 0 disables it.
   *
   * A risk cap layered ON TOP of exact-contract exclusion — never a replacement for
   * it. RELIANCE 2500CE and RELIANCE 2800CE share no contract and must still be able
   * to execute concurrently.
   */
  maxConcurrentPerUnderlying: number;
  /**
   * The MODE-INDEPENDENT total inventory ceiling: how many Boxes may be held at once. 0 disables it.
   *
   * Distinct from `liveMaxOpenBoxes`, which is live-only and read after a position exists. See the
   * construction site for the full reasoning.
   */
  maxOpenBoxes: number;
  /**
   * Minimum fraction of the originally detected gross edge that must survive for a
   * box that waited on a conflict to be allowed to execute.
   *
   * Arriving at the front of the queue is not a reason to trade.
   */
  conflictRevalidateMinEdgeRatio: number;
  /**
   * Require a DURABLE reservation tier before live execution is permitted.
   *
   * Off by default because the deployment is a single PM2 fork process, where the
   * in-process store is authoritative and strictly stronger than a network lock. Turn
   * it on when running multiple workers: live execution then fails CLOSED unless a
   * durable tier is configured, rather than silently losing conflict protection.
   */
  reservationRequireDurable: boolean;
  /**
   * Build the DURABLE cross-process reservation tier at all.
   *
   * On by default. The in-process store is only authoritative for a single process,
   * and the moment there are two — PM2 cluster mode, a second worker, another EC2
   * instance, a Kubernetes replica — both see the same contract as free and both
   * submit. Mongo is already mandatory for the Box module, so this adds no new
   * operational dependency; it puts the exclusion where every worker can see it.
   *
   * Turning it off restores single-process-only protection.
   */
  durableReservationsEnabled: boolean;
  /**
   * How often a held reservation is renewed, in ms.
   *
   * A bounded timer derived from the TTL, NOT one renewal per market tick — that would
   * put thousands of writes a minute on the authority to achieve nothing. Defaults to
   * a third of `instrumentLockTtlMs`, so two consecutive renewals may fail before the
   * lease is genuinely at risk.
   */
  reservationRenewIntervalMs: number;
  /**
   * Clock-skew grace for durable expiry decisions, in ms.
   *
   * Creates a deliberately ASYMMETRIC dead band: the holder stops claiming ownership
   * `grace` BEFORE its lease expires, and a challenger may only reclaim a lease
   * `grace` AFTER it expired. Handing a contract to nobody for 2×grace is a missed
   * opportunity; handing it to two workers is a naked position.
   */
  reservationClockSkewGraceMs: number;
  /**
   * How long a reservation held over an UNRESOLVED broker state keeps being renewed.
   *
   * Unbounded renewal would lock a contract forever on one ambiguous outcome; no
   * renewal would drop protection while real exposure may still exist. So protection
   * is maintained for this long and then left to lapse by TTL — never actively
   * released, because releasing is the "assume there is no exposure" mistake. Residual
   * flattening is not gated by any of this and remains available throughout.
   */
  reservationUncertainHoldMaxMs: number;
  /**
   * How far AHEAD of its lease expiry an execution stops opening further legs, in ms.
   *
   * Deliberately separate from `reservationClockSkewGraceMs`, which is sized for clock
   * measurement error and says nothing about broker latency. A leg permitted 300 ms
   * before expiry, whose order takes a second to reach the exchange, can still be working
   * when another worker legitimately owns the contract — and no broker accepts a fencing
   * token that would let it reject the stale order. So this must exceed worst-case submit
   * latency, not clock error.
   */
  reservationOwnershipMarginMs: number;
  /**
   * Net two boxes that want opposite sides of the same contract against each other.
   *
   * MUST stay false until the ledger can represent virtual ownership of both boxes
   * while broker net exposure is zero. Until then opposite-side overlaps take the
   * same safe path as same-side ones: serialise, confirm, re-evaluate. Correctness
   * before cleverness.
   */
  internalNettingEnabled: boolean;

  // ---- Paper live-parity profile (default OFF; layered on paper_legging) ----
  /**
   * `standard` keeps today's paper behaviour byte-for-byte. `live_parity` layers a
   * shared-liquidity reservation ledger, a deterministic latency source and the live
   * concurrency cap onto `paper_legging`, to make paper a closer shadow of live. Only
   * meaningful when `executionMode` is a paper mode; ignored under `live`.
   */
  paperExecutionProfile: BoxPaperProfile;
  /**
   * Cap on simultaneous paper pipelines under live_parity. Defaults to the LIVE value
   * (`liveMaxConcurrentExecutions`) so the recommended validation baseline mirrors the
   * conservative live deployment; override with BOX_PAPER_MAX_CONCURRENT_EXECUTIONS.
   */
  paperMaxConcurrentExecutions: number;
  /** Latency source for live_parity: `constant` (default) or `recorded_samples`. */
  paperLatencyMode: "constant" | "recorded_samples";
  /**
   * Observed POST→ACK latency samples (ms) for `recorded_samples` — the time from an order
   * leaving the wire to the broker acknowledging it (the leg becoming live at the exchange).
   * Empty ⇒ fall back to the constant. These are the primary calibration feed; export them
   * from the live broker-timing store.
   */
  paperLatencySamples: number[];
  /**
   * Observed ACK→terminal latency samples (ms) — how long an order works at the exchange
   * after acknowledgement before it resolves. Feeds the scheduler's slot-hold model so paper
   * concurrency matches live. Empty ⇒ derived from a fraction of the constant.
   */
  paperLatencyAckToTerminalSamples: number[];
  /** Deterministic starting offset into the samples. No randomness anywhere. */
  paperLatencySeed: number;

  // ---- Live-calibration consumption (live_parity only) ----
  /**
   * Minimum FRESH measured samples before paper will use a calibrated distribution at all.
   * Below this it falls back to the documented constant and reports `measured: false`.
   */
  paperCalibrationMinSamples: number;
  /**
   * Minimum fresh samples before a TIME-OF-DAY bucket is used in preference to the pooled set.
   * Deliberately higher than `paperCalibrationMinSamples`: activating a narrow bucket on a
   * handful of observations is the definition of overfitting.
   */
  paperCalibrationBucketMinSamples: number;
  /**
   * Samples from sessions older than this are excluded from ACTIVE calibration. They are still
   * retained for analytics and drift detection — yesterday's latency is not today's.
   */
  paperCalibrationMaxAgeMs: number;
  /** Enable coarse OPEN/NORMAL/CLOSE bucketing at all. Buckets still need their own samples. */
  paperCalibrationTimeBuckets: boolean;
  /**
   * Fallback cancel-request→terminal window (ms) used by paper's cancel-vs-fill race when no
   * measured CANCEL latency exists.
   *
   * Deliberately NON-ZERO. Zero would mean "cancels are instantaneous", which is the optimistic
   * assumption the race model exists to remove. Reported as an unmeasured constant, never as
   * observed latency.
   */
  paperCancelLatencyMs: number;
  /**
   * Fallback durable-persistence delay (ms) paper applies between acquiring a concurrency slot
   * and transmitting, used only when `persistence_wait_ms` has not been measured.
   *
   * Defaults to 0 — deliberately. The live path really does pay a Mongo round trip there, but we
   * do not know its size until it has been observed, and a guessed database latency would be a
   * fabrication. 0 means "knowingly optimistic on this stage, and it says so"; once calibration
   * has samples paper uses the measured p50 instead. Set this only if you have measured your own
   * deployment's write latency.
   */
  paperPersistenceMs: number;

  // ---- Live timing persistence (Phase 25) ----
  /**
   * Persist calibration observations so they survive a restart. Default OFF: it is additive
   * infrastructure, and a deployment must opt in.
   */
  liveTimingPersistEnabled: boolean;
  /** Observations buffered before a flush. Bounded; never a synchronous hot-path write. */
  liveTimingBatchSize: number;
  /** Maximum time (ms) an observation waits in the buffer before being flushed. */
  liveTimingFlushMs: number;

  // ---- Execution environment diagnostics (Phases 13, 14) ----
  /**
   * Monitor event-loop delay and process pressure, so a Node stall is never recorded as broker
   * latency. Cheap and fail-open, so default ON.
   */
  executionEventLoopMetricsEnabled: boolean;

  // ---- Shadow validation (Phase 21) ----
  /**
   * SHADOW mode: the real feed and the real strategy run, paper live_parity produces simulated
   * orders, and NO broker order is ever submitted.
   *
   * Default OFF, and structurally incapable of placing an order — see the shadow guard.
   */
  shadowModeEnabled: boolean;

  // ---- Live execution timing observability (for latency calibration) ----
  /**
   * Collect high-resolution timing of live broker operations for calibration. Purely
   * observational and FAIL-OPEN: a metrics failure never affects trading. Default true.
   */
  executionTimingMetricsEnabled: boolean;
  /** Bounded RingBuffer window for each execution-timing distribution. Default 500. */
  executionTimingWindow: number;
  /**
   * Explicitly-configured deployment region label (e.g. "mumbai"), stamped onto calibration
   * datasets so Virginia samples never silently calibrate Mumbai paper. NEVER auto-detected
   * from cloud metadata; null unless BOX_DEPLOYMENT_REGION / BOX_EXECUTION_CALIBRATION_REGION
   * is set.
   */
  deploymentRegion: string | null;

  // ---- Live execution safety envelope (env-only, fail-closed) ----
  /** Deployment kill switch. `executionMode=live` is invalid unless this is true. */
  liveTradingEnabled: boolean;
  /** Low-frequency broker reconciliation cadence. */
  /**
   * Unresolved-recovery age (ms) at which operational status escalates. `0` disables the escalation
   * only — never the underlying entry refusal, which the order manager owns.
   */
  liveRecoveryEscalationMs: number;
  liveReconcileIntervalMs: number;
  /** Quiet period after a feed reconnect before a new entry may be submitted. */
  liveFeedReconnectWarmupMs: number;
  liveMaxOpenBoxes: number;
  liveMaxConcurrentExecutions: number;
  liveMaxResidualLegs: number;
  liveDailyLossLimit: number;
  liveRejectLimit: number;
  liveConsecutiveFailureLimit: number;
  /** Maximum quantity in one live leg and across all absolute open leg quantities. */
  liveMaxOpenLegQuantity: number;
  liveMaxGrossOpenLegQuantity: number;
  /**
   * The profile asserts its two quantity ceilings describe EXACTLY ONE LOT of the intended
   * underlying. Opt-in, and only meaningful in live. See the boot check in `loadBoxConfig`.
   */
  liveExactOneLot: boolean;
  /**
   * Underlyings a NEW live box may be entered on, normalised, de-duplicated and sorted. Empty means
   * no identity constraint. Never consulted for exits, reductions or reconciliation.
   */
  liveAllowedUnderlyings: readonly string[];
  /**
   * The operator's declared position on Zerodha's static-IP requirement. Gates NEW live Zerodha
   * ENTRY only; never consulted for a reduction. See `zerodhaStaticIp.ts`.
   */
  zerodhaStaticIp: ZerodhaStaticIpPolicy;
  /** Distinct bounded deadlines for transport and broker lifecycle phases. */
  liveHttpTimeoutMs: number;
  liveAckTimeoutMs: number;
  liveWorkingTimeoutMs: number;
  livePartialTimeoutMs: number;
  liveCancelTimeoutMs: number;
  /**
   * ABSOLUTE end-to-end budget for ONE live order mutation (ms).
   *
   * Started BEFORE queue admission, so the adapter's transport pacer, the broker HTTP pacing
   * queue, the network round trip and the response body all draw on this ONE budget rather than
   * each layer restarting its own timer. A mutation whose budget lapses while still queued is
   * released promptly and provably transmits nothing. See src/brokers/deadline.ts.
   */
  liveOrderMutationDeadlineMs: number;
  liveMaxModifications: number;
  liveMaxChaseTicks: number;
  /**
   * Minimum interval between GENERAL broker transport calls: order-status polls, order
   * lists, positions, margins and health.
   *
   * NOTE the narrowed meaning. This knob used to pace order placement too. Placement is now
   * governed by {@link liveBrokerOrderMinIntervalMs}, because a poll cadence we chose and a
   * rate limit the broker enforces are different things and should not share one number.
   * Existing deployments see no change to polling behaviour.
   */
  liveBrokerMinIntervalMs: number;
  /**
   * Minimum interval between ORDER MUTATIONS (place / modify / cancel), in ms.
   *
   * `0` (the default) means "derive from the broker's published limit" — see
   * `brokerPacing.ts` for the per-broker profiles and their citations. A positive value is an
   * operator override and is CLAMPED UP to the broker's hard floor: this is a real rate limit,
   * so it can be relaxed towards the floor but never below it, and never to zero.
   */
  liveBrokerOrderMinIntervalMs: number;
  /**
   * How many Box ENTRY role submissions may be in transport simultaneously (1..4).
   *
   * Scoped to ONE Box pipeline (`attempt_id`) and to `purpose === "ENTRY"` only. See the BOX
   * ENTRY BURST POLICY section of `executionSchedulingPolicy.ts` for why this is not a global
   * concurrency increase and cannot be used to bypass contract reservations.
   *
   * Defaults to `1`, which is EXACTLY the pre-existing behaviour. Production deployments
   * wanting the four-leg burst should set `4`.
   */
  liveEntrySubmitConcurrency: number;
  /**
   * Maximum gross entry-order notional (₹) permitted for ONE four-leg Box. `0` disables.
   *
   * This is `SUM(|limit_price x quantity|)` over the four bounded LIMIT requests. It is NOT
   * broker margin — see `boxCapital.ts`, which explains at length why conflating the two would
   * mislead an operator by roughly an order of magnitude.
   */
  liveMaxBoxCapitalRupees: number;

  // ---- Economic admission (Task 8): FRESH funds/margin evidence gate, distinct from the gross cap ----
  /**
   * Require proof that AVAILABLE broker funds cover the entry before any leg is sent. `false`
   * (default) keeps the pre-existing behaviour — the gross-notional cap alone. When `true`, entry
   * is refused unless a fresh, broker-confirmed available-funds figure covers the broker margin
   * (if a fresh margin figure exists) or else the bounded worst-case entry cost. Funds are sourced
   * from the adapter's own margins() facility; a missing or stale figure BLOCKS rather than admits.
   *
   * This is NOT the gross cap and NOT an approved-budget copy: it compares real, freshly observed
   * funds against a computed requirement. See boxCapital.ts.
   */
  liveRequireFundsCover: boolean;
  /**
   * Require FRESH, broker-confirmed margin evidence (a basket/multi-order margin estimate) before
   * entry. `false` (default) keeps existing behaviour. When `true`, entry is refused unless a
   * broker-confirmed, non-stale planned-margin figure exists — refusing on an estimate or a
   * missing figure rather than assuming the account can bear the margin. No basket-margin facility
   * is wired on the adapter yet, so with this enabled and no margin source the gate FAILS CLOSED
   * (documented, intentional): missing evidence blocks.
   */
  liveRequireMarginEvidence: boolean;
  /** Max age (ms) for an available-funds observation to count as fresh. Default 5000. */
  liveFundsFreshnessMaxAgeMs: number;
  /** Max age (ms) for a planned-margin observation to count as fresh. Default 5000. */
  liveMarginFreshnessMaxAgeMs: number;
  /**
   * HARD per-read deadline (ms) for one funds/margin evidence read. Default 2500.
   *
   * A stalled broker endpoint must not be able to hold an entry decision open. On expiry the figure
   * is reported UNAVAILABLE with the timeout named, which (with a control enabled) refuses the
   * entry. This bounds the WAIT, not the underlying HTTP request — no broker facility here is
   * cancellable — which is the property that matters for admission latency.
   */
  liveEvidenceReadTimeoutMs: number;
  /**
   * Tolerance (ms) for a broker/source timestamp being AHEAD of this host before the figure is
   * called INVALID rather than fresh. Default 1000.
   *
   * Small skew between the broker's clock and ours is normal and harmless. A figure stamped
   * materially in the future cannot be aged at all, so it is refused explicitly instead of being
   * silently treated as age 0.
   */
  liveEvidenceFutureSkewGraceMs: number;
  /**
   * Fetch the funds and margin evidence CONCURRENTLY. Default false (serial).
   *
   * Two independent GETs are safe to overlap in principle, but the broker's rate limiter and this
   * process's own pacing rules are the authority on whether they may be. Serial is the safe default;
   * enable it only once the broker's documented read limits have been checked for the deployment.
   */
  liveEvidenceConcurrentReads: boolean;
  /**
   * Require EVERY stage of the real hedge-first sequence to have an establishable funding
   * requirement before entry. Default false.
   *
   * When `true`, entry is refused unless the broker supplied BOTH the initial (no spread benefit)
   * and final (with spread benefit) basket margins, the sequence is genuinely hedge-first, and every
   * stage requirement could be computed. This is the control that stops the completed-basket `final`
   * margin being used as proof that the account can fund the sequence which creates the box —
   * Zerodha's own documented example has initial ₹96,504.98 against final ₹34,786.73.
   *
   * REQUIRED for the supervised one-shot live profile.
   */
  liveRequireStageFunding: boolean;
  /**
   * ₹ held back from the funding requirement so a recovery action (cancel, unwind, complete) is not
   * blocked by having spent every available rupee on the entry. Default 0.
   */
  liveRecoveryReserveRupees: number;

  // ---- Strategy-level entry restrictions (apply to ENTRY only, never to reduction) ----
  /**
   * Permit at most one active Box per UNDERLYING, regardless of strike pair, expiry or
   * direction. Defaults to `false` for backwards compatibility.
   *
   * An ADDITIONAL layer on top of the existing exact-contract reservations, never a
   * replacement. See `underlyingLock.ts`.
   */
  oneActiveBoxPerUnderlying: boolean;
  /**
   * Maximum COMPLETE Box lifecycles (ENTRY → HOLD → EXIT → FLAT) an armed session may run.
   * `0` = unlimited (default), `1` = one-shot, `N` = N cycles. See `tradingSession.ts`.
   */
  sessionMaxCompletedTrades: number;
  /**
   * Maximum ENTRY ATTEMPTS a single armed session may start. 0 ⇒ unbounded (the default).
   *
   * Bounds RISK-TAKING rather than success. `sessionMaxCompletedTrades` counts cycles CONSUMED at
   * establishment, so an attempt that submitted orders, partially filled and was then unwound or
   * recovered spends no cycle — correctly, because burning a permitted trade on an attempt that left
   * no position would be indefensible. But that left nothing bounding attempts at all: a trial
   * configured for one trade could submit orders indefinitely as long as no attempt ever completed.
   * This is the ceiling that stops it, counted at admission before any broker POST.
   */
  sessionMaxEntryAttempts: number;
  /**
   * Paper mirror of {@link liveMaxBoxCapitalRupees}, for `live_parity` validation. `0`
   * disables. LIVE remains the authoritative safety gate; this exists so a paper run can
   * exercise the same admission arithmetic.
   */
  paperMaxBoxCapitalRupees: number;

  // ---- paper_legging: four independent orders ----
  /** How the four legs are submitted: "parallel" (default) or "sequential". */
  legExecutionMode: "parallel" | "sequential";
  /** How long a leg may rest before it is deemed unfilled and the box aborts (ms). */
  legTimeoutMs: number;
  /** Simulated latency for the emergency unwind of partial fills (ms). */
  legUnwindLatencyMs: number;

  // ---- paper_legging: executable order pricing (marketable-limit) ----
  /**
   * How many ticks past the reference touch an ENTRY marketable-limit order may
   * chase. The limit price is `reference ± maxChaseTicks × tickSize` (up for a
   * BUY, down for a SELL). A depth level worse than the limit is never filled —
   * this is what stops a simulated order behaving like an unrestricted market
   * order that consumes whatever the book shows on arrival.
   */
  legMaxChaseTicks: number;
  /**
   * Chase band for an EMERGENCY UNWIND, which may deliberately tolerate a wider
   * price band than a normal entry because flattening exposure is more urgent
   * than getting a good price. Defaults higher than `legMaxChaseTicks`.
   */
  unwindMaxChaseTicks: number;
  /**
   * Fallback tick size (₹) when an instrument's real tick size is unavailable.
   * The real tick size from the instrument dump is preferred wherever present.
   */
  defaultTickSize: number;

  // ---- paper_legging: conservative queue-position approximation ----
  /**
   * How displayed depth is treated as executable for our simulated order.
   *
   *   "none"    — the full displayed quantity at each level is assumed available.
   *   "haircut" — only a fraction of the displayed quantity is treated as safely
   *               executable, a transparent stand-in for the queue ahead of us
   *               that we cannot observe from level-2 data.
   *
   * This is NOT a reconstruction of true NSE order-level queue priority (which is
   * not derivable from level-2 depth); it is a deterministic, configurable
   * approximation that lets a paper run compare raw vs conservative liquidity.
   */
  queueModel: BoxQueueModel;
  /**
   * Percentage of displayed quantity assumed to be QUEUED AHEAD of our order and
   * therefore not available to us, when `queueModel === "haircut"`. Effective
   * quantity at a level is `floor(displayed × (1 − pct/100))`. Deterministic; no
   * randomness.
   */
  queueLiquidityHaircutPct: number;

  // ---- paper_legging: four-leg temporal coherence ----
  /**
   * Maximum spread (ms) between the newest and oldest leg EXCHANGE timestamps a
   * candidate may show and still auto-enter. When all four legs carry valid
   * exchange timestamps and the dispersion exceeds this, the candidate is rejected
   * as `cross_leg_time_skew` rather than traded on books that are not a coherent
   * cross-sectional snapshot. 0 disables the check. When any leg lacks an exchange
   * timestamp the check is skipped and the existing receive-time logic stands.
   */
  maxCrossLegExchangeDispersionMs: number;
  /**
   * Maximum cross-leg RECEIVE-TIME dispersion (ms) enforced as a LIVE admission
   * constraint by the shared coherence policy (executionCoherence.ts). Receive-time
   * is the always-available cross-sectional bound: Dhan supplies no order-book
   * exchange timestamp at all, and Kite's is 1-second-granular, so this is the
   * primary gate in live. Distinct from the exchange-dispersion knob so a live
   * operator can bound arrival spread even when no usable exchange timestamp exists.
   */
  maxCrossLegReceiveDispersionMs: number;
  /**
   * Maximum plausible (received_at − exchange_at) in ms. A book received BEFORE its
   * exchange stamp (future skew) or lagging it absurdly is a clock/feed fault, never
   * coherence evidence. Generous because exchange stamps are coarse (Kite = 1s).
   */
  maxReceiveToExchangeDelayMs: number;
  /**
   * How LIVE reads a cross-leg dispersion limit of 0.
   *
   * false (default): in LIVE a 0 receive-dispersion limit is IMPOSSIBLE-TO-SATISFY,
   *   not a silent bypass — an unconfigured operator can never accidentally get "no
   *   cross-leg coherence enforcement" from a 0.
   * true: 0 explicitly DISABLES the receive-dispersion constraint in live (the
   *   operator has knowingly opted out; per-leg age and exchange checks still apply).
   * Paper ALWAYS reads 0 as "disabled" regardless of this flag.
   */
  coherenceZeroDispersionDisablesInLive: boolean;

  // ---- Entry qualification ----
  /**
   * THE ENTRY GATE: minimum EXPECTED NET PROFIT (₹).
   *
   *   expectedNet = grossEdge
   *               - entryCharges
   *               - estimatedExitCharges
   *               - executionCost (measured entry slippage + exit allowance)
   *               - safetyBuffer
   *
   * Evaluated on the EXECUTION snapshot, not merely on detection.
   */
  minExpectedNetProfit: number;
  /**
   * A cheap gross PREFILTER (₹) — performance only, never the decision.
   *
   * It must UNDER-state the true requirement, because its only job is to skip
   * candidates that cannot possibly qualify. Since the net gate above always
   * needs more gross than this, it can never discard a qualifying box.
   */
  minGrossEdge: number;
  /**
   * Legacy extra floor (₹) on the projected net edge. When set above 0 it raises
   * the effective requirement to max(minExpectedNetProfit, minNetEdge), so an
   * existing MIN_BOX_NET_EDGE deployment keeps its stricter behaviour.
   */
  minNetEdge: number;
  /** Risk/safety allowance (₹) deducted inside the expected-net figure. */
  safetyBuffer: number;
  /**
   * Expected ENTRY execution cost (₹) used before a real measurement exists —
   * i.e. in the published opportunity projection. Once the execution simulator
   * has run, the MEASURED slippage replaces it.
   */
  expectedEntrySlippage: number;
  /**
   * Expected EXIT execution cost (₹). Always an estimate: the unwind has not
   * happened yet, so its slippage cannot be measured at entry time.
   */
  expectedExitSlippage: number;
  /**
   * A deliberate LOWER bound on what a round trip can cost in charges (₹), used
   * only by the prefilter. Eight option orders at ₹20 brokerage plus GST is
   * already ≈ ₹189, so ₹160 is safe.
   */
  prefilterChargeAllowance: number;
  /**
   * Whether a box may be auto-entered when its charges could not be determined.
   *
   * With the local calculator this is virtually always possible, so it now only
   * guards genuinely pathological input (a zero-price leg).
   */
  requirePricedCharges: boolean;

  // ---- Charges ----
  /** Verify local charge maths against Zerodha asynchronously after a fill. */
  reconcileCharges: boolean;
  /** Warn when |local - Zerodha| exceeds this percentage of the Zerodha total. */
  chargeReconcileWarnPct: number;
  /** Max concurrent reconciliation calls (Zerodha must not be hammered). */
  chargeReconcileConcurrency: number;
  /**
   * How many times one verification may be tried before the charges are recorded
   * as unverified. Bounded so a broker outage can never become a hot retry loop.
   */
  chargeReconcileMaxAttempts: number;
  /** Linear backoff base (ms): attempt N waits N × this. */
  chargeReconcileRetryBaseMs: number;

  // ---- Market-data quality ----
  /**
   * How long an UNCHANGED order book is still trusted (ms).
   *
   * A depth feed only sends a message when the book actually changes, so silence
   * is not staleness: a resting book nobody has touched for ten seconds is still
   * the current, executable book. The protection against a genuinely dead feed is
   * `feedMaxAgeMs`.
   */
  quoteMaxAgeMs: number;
  /**
   * FEED LIVENESS: maximum age (ms) of the newest tick across the WHOLE box
   * universe. When it trips, no entry and no automatic exit happens at all.
   */
  feedMaxAgeMs: number;
  /**
   * ORDER-EVENT INGESTION backpressure threshold: the number of queued raw order-event frames
   * (the never-drop backpressure queue) above which the pipeline reports OVERLOAD. Overload blocks
   * NEW ENTRY (via the market-data backlog signal) and triggers a broker reconciliation while the
   * queue continues to hold and deliver EVERY event — a missing order event is never a zero fill,
   * so this is a pressure threshold, never a cap that could drop data. Sized generously: order
   * events are low-volume relative to market data, so a sustained backlog past this is a real
   * processing-lag incident worth pausing entry over.
   */
  orderEventQueuePressureThreshold: number;
  /** Maximum age (ms) of the underlying value used to place the ATM window. */
  underlyingMaxAgeMs: number;

  // ---- Strike window ----
  /**
   * The MAXIMUM strikes each side of ATM the module ever builds. Fixed at 3.
   *
   * The ACTIVE level (1, 2 or 3) is a separate runtime control the admin sets —
   * see `defaultStrikeLevel` and BoxEngine.setStrikeLevel. This cap never rises,
   * so an admin can only ever narrow the window, never widen it past ATM ±3.
   */
  readonly strikesEachSide: 3;
  /**
   * The active strikes-each-side level at boot: 1, 2 or 3 (default 3).
   *
   * Admin-adjustable at runtime. Narrowing it only affects which NEW boxes are
   * discovered; positions already open are never touched by a change.
   */
  defaultStrikeLevel: 1 | 2 | 3;
  /**
   * Extra fraction of a strike step the spot must travel PAST the midpoint
   * before the ATM is re-centred.
   */
  atmHysteresis: number;
  /** Minimum gap (ms) between two window rebuilds for one underlying. */
  windowMinIntervalMs: number;
  /** Evaluate SHORT boxes as well as LONG boxes. */
  enableShortBox: boolean;

  // ---- Exit rules ----
  /** Floor of the convergence threshold (₹). */
  convergenceFloor: number;
  /** Fraction of the original entry net edge used as the threshold. */
  convergencePct: number;
  /** Minimum realisable NET profit (₹) for any normal (non-emergency) exit. */
  minExitNetPnl: number;
  /**
   * Whether a normal auto-exit's profit floor is judged on REALISABLE net
   * (touch net − expected exit-slippage allowance) rather than raw touch net.
   * Once the exit actually executes, the check re-runs on the actual price with
   * no allowance. Default true.
   */
  exitUseRealisableNet: boolean;
  /** Net profit that alone justifies taking profit, as a fraction of net edge. */
  profitCapturePct: number;
  /** Fraction of the ORIGINAL edge captured that alone justifies an exit. */
  minCapturedPct: number;

  // ---- Expiry safety ----
  /** Minutes before the close on expiry day to start forcing an exit. */
  expirySafetyMinutesBeforeClose: number;

  // ---- Scheduling / capacity ----
  /** Watchdog cadence (ms); WS depth ticks drive normal exit evaluation. */
  monitorIntervalMs: number;
  /** How often (ms) open-trade live fields are flushed to Mongo. */
  persistIntervalMs: number;
  /** SSE publish cadence (ms) — the UI never needs every exchange tick. */
  publishIntervalMs: number;
  /** How often (ms) the universe/expiry/window set is refreshed. */
  universeRefreshMs: number;
  /** How often (ms) the last-close view is rebuilt while the market is shut. */
  indicativeRefreshMs: number;
  /**
   * Whether the last-close view is built for the WHOLE universe while the market
   * is shut and the scanner is stopped.
   *
   * With the exchange closed there is nothing to execute and no tick feed to pay
   * for, so the strike windows can be built and priced from REST /quote purely to
   * be looked at — which is the only way to see which boxes were mispriced at the
   * close without pressing RUN. It subscribes NOTHING: indicative windows never
   * cost a feed subscription, so this cannot affect live trading capacity.
   */
  indicativeDiscovery: boolean;
  /**
   * Cap on underlyings given an indicative-only window (0 = no cap).
   *
   * Indicative windows cost no feed subscription, so `maxSubscribedTokens` does not
   * bound them — without a separate cap a stopped engine would hold a window and a
   * full candidate set for every F&O underlying and re-quote all of it every
   * `indicativeRefreshMs`, all night. The board is priority-ordered, so the cap
   * keeps the most liquid names.
   */
  indicativeMaxUnderlyings: number;
  /** Cap on simultaneously subscribed box option tokens. */
  maxSubscribedTokens: number;
  /** Cap on underlyings scanned (0 = no cap beyond the token budget). */
  maxUnderlyings: number;
  /** TTL (ms) of a cached charge estimate for one candidate at given prices. */
  chargeCacheTtlMs: number;
  /** Max concurrent Zerodha charge estimations in flight. */
  chargeConcurrency: number;
  /** Opportunities published to the UI. */
  maxPublishedOpportunities: number;
  /** Samples kept in each rolling metrics ring buffer. */
  metricsWindow: number;

  // ---- Daily P&L cache + nightly archive ----
  /**
   * Master switch for the live P&L cache and its nightly archive.
   *
   * When on (and Upstash Redis is configured), the running net P&L of the day's
   * box trades — open positions AND trades closed today — is mirrored to Redis on
   * a slow cadence, then drained into the `box_daily_pnl` Mongo collection once a
   * night. OFF by default: with it unset the module behaves exactly as before and
   * touches neither Redis nor the new collection.
   */
  pnlCacheEnabled: boolean;
  /** How often (ms) the running day-P&L snapshot is mirrored to Redis. */
  pnlCacheIntervalMs: number;
  /** TTL (seconds) on a day's cached P&L hash — long enough to outlive verify. */
  pnlCacheTtlSec: number;
  /** IST hour (0-23) at which the day's cached P&L is drained to Mongo. */
  pnlArchiveHour: number;
  /**
   * IST hours (0-23) at which the archive is re-checked and completed if the 9 PM
   * drain did not finish (e.g. Redis or Mongo was briefly unavailable).
   */
  pnlVerifyHours: number[];
  /** Delay (ms) between each document while streaming the archive into Mongo. */
  pnlArchiveDrainDelayMs: number;

  // ---- Today's closed trades: Redis read-path cache ----
  /**
   * Mirror TODAY's closed trades to Redis so the Closed-trades tab loads without
   * a full-book Mongo query. ON by default (unlike the P&L cache): it is a pure
   * read accelerator, and with no Upstash configured it is inert and every read
   * falls back to Mongo. See closedCache.ts.
   */
  closedCacheEnabled: boolean;
  /** TTL (seconds) on a day's cached closed-trade hash. */
  closedCacheTtlSec: number;
}

/* ------------------------------ live tuning ------------------------------- */

/**
 * The thresholds an admin may change at RUNTIME from the UI.
 *
 * Deliberately just these two. They are the numbers an operator tunes while
 * watching the market — the entry gate and the risk allowance inside it — and
 * both are pure decision inputs: changing one alters which NEW boxes qualify and
 * nothing else. Positions already open are never re-judged, and every trade keeps
 * the `scanner_config_snapshot` of the settings it was actually taken under, so
 * history stays interpretable after a change.
 *
 * Everything else in BoxConfig stays env-only on purpose: latencies, feed
 * freshness and capacity limits describe the execution model, not an operator
 * preference, and letting them drift at runtime would make paper fills
 * incomparable across a session.
 */
export interface BoxTuning {
  /** THE ENTRY GATE: minimum expected NET profit (₹). */
  minExpectedNetProfit: number;
  /** Risk/safety allowance (₹) deducted inside the expected-net figure. */
  safetyBuffer: number;
}

/** Hard bounds on a tunable, so a typo cannot disable the gate or wedge it shut. */
export const BOX_TUNING_LIMITS: Record<keyof BoxTuning, { min: number; max: number }> = {
  // A zero gate is legitimate (take every box that is net-positive at all), but a
  // negative one would mean "enter at a known loss", which is never intended.
  minExpectedNetProfit: { min: 0, max: 1_000_000 },
  safetyBuffer: { min: 0, max: 1_000_000 },
};

/** The current live values of the tunables. */
export function readTuning(cfg: BoxConfig): BoxTuning {
  return {
    minExpectedNetProfit: cfg.minExpectedNetProfit,
    safetyBuffer: cfg.safetyBuffer,
  };
}

/**
 * Validate a partial tuning patch.
 *
 * Returns the accepted (rounded, in-range) values, or an error message naming the
 * offending field. Rejects rather than clamps: silently accepting ₹99,999,999 as
 * an entry gate would look like it worked and then never trade again.
 */
export function validateTuning(
  patch: Partial<Record<keyof BoxTuning, unknown>>,
): { ok: true; values: Partial<BoxTuning> } | { ok: false; error: string } {
  const values: Partial<BoxTuning> = {};
  for (const key of Object.keys(BOX_TUNING_LIMITS) as (keyof BoxTuning)[]) {
    const raw = patch[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = Number(raw);
    const { min, max } = BOX_TUNING_LIMITS[key];
    if (!Number.isFinite(v)) {
      return { ok: false, error: `${key} must be a number.` };
    }
    if (v < min || v > max) {
      return { ok: false, error: `${key} must be between ₹${min} and ₹${max}.` };
    }
    values[key] = Math.round(v);
  }
  if (Object.keys(values).length === 0) {
    return { ok: false, error: "Nothing to update — send minExpectedNetProfit and/or safetyBuffer." };
  }
  return { ok: true, values };
}

/**
 * The Mongo `box_settings` key each tunable is persisted under.
 *
 * Stable strings, not the TS field names, so renaming a config field later cannot
 * silently orphan a saved value.
 */
export const BOX_TUNING_KEYS: Record<keyof BoxTuning, string> = {
  minExpectedNetProfit: "min_expected_net_profit",
  safetyBuffer: "safety_buffer",
};

export function loadBoxConfig(): BoxConfig {
  const mode = executionMode("BOX_EXECUTION_MODE", "paper_latency");
  const liveTradingEnabled = bool("BOX_LIVE_TRADING_ENABLED", false);
  if (mode === "live" && !liveTradingEnabled) {
    throw new Error(
      "[Box] BOX_EXECUTION_MODE=live requires BOX_LIVE_TRADING_ENABLED=true; refusing to start live execution.",
    );
  }

  const profile = paperProfile("BOX_PAPER_EXECUTION_PROFILE", "standard");
  const shadow = bool("BOX_SHADOW_MODE_ENABLED", false);

  // A FAULT-INJECTING PROFILE MUST NEVER BE NEAR REAL MONEY.
  //
  // The stress profile deliberately fabricates broker rejects, feed gaps, duplicate events and
  // delays. Those are useful against a simulator and indefensible against a live account, so the
  // combination stops startup rather than being quietly downgraded — the same reasoning as the
  // execution-mode kill switch above.
  if (mode === "live" && profile === "stress") {
    throw new Error(
      "[Box] BOX_PAPER_EXECUTION_PROFILE=stress cannot be combined with BOX_EXECUTION_MODE=live: " +
        "the stress profile injects synthetic faults and must never run against a real account.",
    );
  }

  // Shadow mode exists to run the real strategy against the real feed while submitting NOTHING.
  // Pairing it with live execution is a contradiction, and resolving it silently in either
  // direction would be dangerous: one way places unwanted orders, the other silently disables
  // trading somebody believed was on.
  if (mode === "live" && shadow) {
    throw new Error(
      "[Box] BOX_SHADOW_MODE_ENABLED=true cannot be combined with BOX_EXECUTION_MODE=live: " +
        "shadow mode must never be able to submit a broker order.",
    );
  }

  /*
   * THE COORDINATOR IS NOT OPTIONAL IN LIVE, AND THIS IS THE MOST IMPORTANT REFUSAL IN THIS FUNCTION.
   *
   * `CoordinatedBoxExecutionGateway.simulateEntry` / `simulateLeggingEntry` both begin with
   *
   *     if (!this.deps.cfg.executionCoordinatorEnabled) return this.deps.inner.<same>(args);
   *
   * — a straight delegation to the uncoordinated gateway. Everything the coordinator's entry prologue
   * enforces is therefore SKIPPED WHOLESALE when the flag is false, and that list is not a set of
   * refinements:
   *
   *   · BOX_MAX_OPEN_BOXES — the ONLY mode-independent inventory ceiling, and it has exactly one
   *     enforcement point, inside that prologue. `BOX_LIVE_MAX_OPEN_BOXES` in BoxOrderManager is a
   *     DIFFERENT variable read from a count refreshed only after a position exists;
   *   · the session ATTEMPT budget (BOX_SESSION_MAX_ENTRY_ATTEMPTS) — consumed inside the prologue,
   *     so with the coordinator off a one-attempt supervised trial can submit indefinitely;
   *   · the session ENTRY gate (BOX_SESSION_MAX_COMPLETED_TRADES);
   *   · BOX_ONE_ACTIVE_BOX_PER_UNDERLYING, all three layers;
   *   · the duplicate-opportunity guard;
   *   · contract-level instrument reservations, i.e. all cross-process exclusion.
   *
   * An operator who sets BOX_MAX_OPEN_BOXES=1 because they cannot fund a second box, and separately
   * turns this flag off, gets NO ceiling at all — and nothing tells them. That is the exact shape of
   * failure the double-gating above exists to prevent, so it is refused the same way rather than
   * being left to a warning nobody reads at 09:14.
   *
   * NO LEGITIMATE CONFIGURATION IS LOST. Live execution already requires durable reservations to be
   * reachable (`BOX_RESERVATION_REQUIRE_DURABLE`, and the coordinator fails live closed when the
   * authority is unavailable), so a live deployment with coordination disabled was never a supported
   * state — merely an unguarded one. Paper is untouched: development and tests may still disable it.
   */
  if (mode === "live" && !bool("BOX_EXECUTION_COORDINATOR_ENABLED", true)) {
    throw new Error(
      "[Box] BOX_EXECUTION_COORDINATOR_ENABLED=false cannot be combined with BOX_EXECUTION_MODE=live. " +
        "The coordinator's entry prologue is the ONLY enforcement point for BOX_MAX_OPEN_BOXES, the " +
        "session attempt budget, BOX_ONE_ACTIVE_BOX_PER_UNDERLYING, the duplicate-opportunity guard " +
        "and every instrument reservation. Disabling it in live silently removes all of them, so " +
        "startup is refused rather than trading without an inventory ceiling.",
    );
  }

  /*
   * THE PER-BOX ₹ CEILING MAY NOT BE SILENTLY ABSENT IN LIVE. It is the only MONETARY containment.
   *
   * THE ASYMMETRY THIS CLOSES. The three live size ceilings were not equally protected:
   *
   *   BOX_LIVE_MAX_OPEN_LEG_QUANTITY        strictLimitInt(…, min 1, …)  → 0 REFUSED at boot
   *   BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY  strictLimitInt(…, min 1, …)  → 0 REFUSED at boot
   *   BOX_LIVE_MAX_BOX_CAPITAL_RUPEES       strictLimitInt(…, min 0, …)  → 0 ACCEPTED = NO CEILING
   *
   * `0` is a legitimate value for that variable and means "disabled" — `capitalBlockReason` returns
   * `null` on `limit <= 0`, i.e. no opinion. That default exists for a good reason: the cap was added
   * after the fact, and `0` let an existing deployment upgrade without a behaviour change. But the
   * quantity ceilings bound LOTS, and lots are not money. A deployment can satisfy both quantity caps
   * and still commit an arbitrary rupee amount, because notional is price × quantity and the caps say
   * nothing about price.
   *
   * `.env.example` ships the variable AT `0`, so the single most likely operator mistake on a
   * real-money supervised test is leaving the one monetary ceiling at its shipped value and never
   * being told. Every comparable containment in this file refuses rather than defaults — that is the
   * whole argument of `strictLimitInt` — so this one is refused too.
   *
   * SCOPED TO LIVE ONLY, and deliberately. Paper has `BOX_PAPER_MAX_BOX_CAPITAL_RUPEES`, where `0`
   * means the same thing and costs nothing, so a paper rehearsal is untouched. This fires only where
   * real money is reachable, and it names the fix.
   */
  if (mode === "live") {
    const liveCapitalCap = strictLimitInt("BOX_LIVE_MAX_BOX_CAPITAL_RUPEES", 0, 0, 1_000_000_000);
    if (liveCapitalCap <= 0) {
      throw new Error(
        "[Box] BOX_LIVE_MAX_BOX_CAPITAL_RUPEES=0 disables the per-Box ₹ ceiling, and it cannot be " +
          "disabled while BOX_EXECUTION_MODE=live. It is the ONLY monetary containment on a single " +
          "Box: the two quantity ceilings bound LOTS, and a Box can satisfy both while still " +
          "committing an arbitrary rupee amount, because notional is price × quantity. Set it to the " +
          "largest amount one Box may commit — for a one-lot NIFTY test, 100000 is a reasonable " +
          "starting figure. Startup is refused rather than trading with no ₹ ceiling.",
      );
    }
  }

  /*
   * A PROFILE THAT CLAIMS "EXACTLY ONE LOT" MUST BE ARITHMETICALLY CAPABLE OF MEANING IT.
   *
   * THE DRIFT THIS CATCHES, WHICH ALREADY HAPPENED. The order quantity actually sent is always
   * `candidate.lot_size`, read from the live instrument master — never a number from any env file.
   * The two live quantity ceilings are a CONTAINMENT CHECK on that quantity. They therefore have to
   * agree with it, and when they stop agreeing the failure is silent in one direction and total in
   * the other: a per-leg cap below one lot refuses every entry (indistinguishable from "nothing
   * ever qualifies"), and a gross cap above four lots permits more exposure than the profile claims.
   *
   * `FINAL-one-box-live.env.template` shipped 75 / 300 together with a note saying "75 is only right
   * while NIFTY's is 75". NIFTY's lot then moved to 65. The per-leg figure was updated; the gross
   * figure was not. The result was a gross ceiling of 300 against a real four-leg lot of 260 — an
   * envelope 15% wider than the "exactly one lot" the profile advertises, with nothing anywhere
   * reporting the discrepancy. That is precisely the class of error a supervised first run cannot
   * afford, because the whole point of the exercise is that the size is known.
   *
   * WHAT IS CHECKABLE AT BOOT, AND WHAT IS NOT. The lot size is not knowable here: it belongs to an
   * instrument master that has not been loaded yet, and inventing a number for it in this file would
   * recreate exactly the hardcoding this check exists to prevent. What IS knowable is whether the
   * two ceilings are consistent WITH EACH OTHER: four legs of one lot is four times one leg of one
   * lot, whatever the lot happens to be. So this refuses `gross !== 4 × perLeg` — which catches the
   * 300-vs-260 drift above without asserting what the lot size is.
   *
   * The remaining half — comparing the ceilings against the SELECTED underlying's actual `lot_size`
   * — is a runtime readiness question, because only then is the instrument known. It is deliberately
   * not attempted here.
   *
   * OPT-IN, AND LIVE-ONLY. Only a profile that sets `BOX_LIVE_EXACT_ONE_LOT=true` is asserting the
   * exact-one-lot relationship, so only that profile is held to it. A deployment intentionally
   * sizing a gross ceiling to something other than 4x — a multi-lot or multi-box posture — is
   * untouched and needs no change. Paper is untouched entirely.
   */
  if (mode === "live" && strictBool("BOX_LIVE_EXACT_ONE_LOT", false)) {
    const perLeg = strictLimitInt("BOX_LIVE_MAX_OPEN_LEG_QUANTITY", 100, 1, 1_000_000);
    const gross = strictLimitInt("BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY", 400, 1, 4_000_000);
    if (gross !== perLeg * 4) {
      throw new Error(
        `[Box] BOX_LIVE_EXACT_ONE_LOT=true declares that the live quantity ceilings describe exactly ` +
          `one lot across the four legs of one Box, but BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=${gross} ` +
          `is not 4 x BOX_LIVE_MAX_OPEN_LEG_QUANTITY=${perLeg} (=${perLeg * 4}). A Box is four legs, so ` +
          `these two must move together: the usual cause is an exchange lot-size change applied to the ` +
          `per-leg figure and not the gross one, which leaves the gross ceiling permitting more ` +
          `exposure than the profile claims. Set the gross ceiling to ${perLeg * 4}, or if you did ` +
          `intend a wider envelope than one lot, unset BOX_LIVE_EXACT_ONE_LOT — do not widen the ` +
          `per-leg cap to make the arithmetic agree. The order quantity itself always comes from the ` +
          `instrument master, never from these values.`,
      );
    }
  }

  return {
    executionMode: mode,
    simulatedDecisionMs: num("BOX_SIMULATED_DECISION_MS", 40),
    simulatedLatencyMs: num("BOX_SIMULATED_LATENCY_MS", 250),
    executionMaxWaitMs: num("BOX_EXECUTION_MAX_WAIT_MS", 1500),
    executionPollMs: num("BOX_EXECUTION_POLL_MS", 20),
    maxConcurrentExecutions: num("BOX_MAX_CONCURRENT_EXECUTIONS", 8),

    /*
     * ACCOUNT-FUNDS POLLING — a diagnostic, and priced like one.
     *
     * `bool` not `strictBool`, and enabled by default, because this knob cannot affect what trades:
     * it decides whether a balance is DISPLAYED. A typo that silently disabled it would cost an
     * operator a number on a screen, which does not justify refusing to boot. Contrast
     * BOX_MAX_OPEN_BOXES, where a typo would silently remove a safety ceiling and therefore throws.
     *
     * 15s default. The figure moves only when an order fills or funds are transferred, so polling
     * faster buys nothing and spends the same broker rate limit the market feed depends on. The
     * freshness bound is deliberately WIDER than the interval (45s vs 15s) so a single missed or slow
     * read does not flip a perfectly good balance to "stale" — it takes three consecutive failures.
     *
     * Neither value is safety-critical, so both clamp rather than throw.
     */
    accountFundsEnabled: bool("BOX_ACCOUNT_FUNDS_ENABLED", true),
    accountFundsRefreshMs: clampInt("BOX_ACCOUNT_FUNDS_REFRESH_MS", 15_000, 2_000, 600_000),
    accountFundsFreshnessMaxAgeMs: clampInt("BOX_ACCOUNT_FUNDS_MAX_AGE_MS", 45_000, 5_000, 3_600_000),

    boxDedicatedMarketFeed: bool("BOX_DEDICATED_MARKET_FEED", true),
    executionCoordinatorEnabled: bool("BOX_EXECUTION_COORDINATOR_ENABLED", true),
    // 250ms: long enough for a broker ACK to land and the holder to release, short
    // enough that a dead opportunity is abandoned rather than chased.
    conflictWaitMaxMs: clampInt("BOX_CONFLICT_WAIT_MAX_MS", 250, 0, 5_000),
    // 5s: comfortably longer than a round trip, so an ambiguous terminal state stays
    // protected, but short enough that a crashed process frees contracts quickly.
    instrumentLockTtlMs: clampInt("BOX_INSTRUMENT_LOCK_TTL_MS", 5_000, 250, 60_000),
    /* Per-underlying concurrency is a containment limit, so a malformed value is refused rather
       than resolved to the default. The `0` sentinel's existing meaning is left exactly as it was. */
    maxConcurrentPerUnderlying: strictLimitInt("BOX_MAX_CONCURRENT_PER_UNDERLYING", 2, 0, 16),
    /**
     * THE MODE-INDEPENDENT INVENTORY CEILING: how many Boxes may be held AT ONCE, in total.
     *
     * WHY THIS EXISTS SEPARATELY FROM `BOX_LIVE_MAX_OPEN_BOXES`.
     *
     * `BOX_LIVE_MAX_OPEN_BOXES` lives in `BoxOrderManager`, which is constructed ONLY on the live
     * path. So it does two things this one does not: it is invisible in every paper mode (a paper
     * rehearsal cannot exercise it, which makes "paper never breached the cap" evidence about
     * nothing), and it is read from a count the engine refreshes only AFTER a position exists — so
     * it cannot refuse the second of two entries admitted in the same instant.
     *
     * This ceiling is checked in the coordinator's synchronous admission prologue, in EVERY
     * execution mode, against an inventory that counts committed exposure rather than only
     * established positions: open positions, unresolved residual attempts, unresolved order
     * intents, in-flight entry claims and reservations retained over an uncertain terminal state.
     *
     * `0` = unlimited, preserving existing behaviour exactly. Set it to `1` for a supervised trial
     * and it becomes the one control that answers "I cannot afford a second box" in the paper
     * rehearsal AND in live, for boxes on the same underlying and on different underlyings alike —
     * including a LONG_BOX and a SHORT_BOX, which share reservation keys only while both are in
     * flight and are otherwise unrelated to each other.
     *
     * It is NOT a substitute for `BOX_SESSION_MAX_ENTRY_ATTEMPTS`. This bounds INVENTORY; the
     * attempt budget bounds RISK-TAKING, including attempts that took real exposure and were then
     * unwound. A trial wants both.
     */
    /*
     * `strictLimitInt`, NOT `clampInt` — and this setting is the textbook case for it.
     *
     * `fallback === min === 0` AND `0` means UNLIMITED, which is exactly the combination
     * `strictLimitInt`'s own doc comment names: with `clampInt`, `BOX_MAX_OPEN_BOXES="one"` (NaN →
     * fallback), `"-1"` (clamped up to the minimum) and `"0.5"` (rounded down) would ALL silently
     * resolve to 0 = unlimited. An operator hand-typing the one ceiling that stops a second box from
     * opening would have removed it, and nothing anywhere would have said so.
     *
     * The first draft of this setting used `clampInt`. It was wrong for the same reason the session
     * ceilings were wrong before `strictLimitInt` was introduced for them.
     */
    maxOpenBoxes: strictLimitInt("BOX_MAX_OPEN_BOXES", 0, 0, 50),
    conflictRevalidateMinEdgeRatio: num("BOX_CONFLICT_REVALIDATE_MIN_EDGE_RATIO", 0.8),
    // Default FALSE, preserving today's single-process semantics exactly. Multi-worker
    // deployments (PM2 cluster mode, several replicas) must set it true so live
    // execution fails CLOSED rather than silently losing conflict protection.
    reservationRequireDurable: bool("BOX_RESERVATION_REQUIRE_DURABLE", false),
    // Default TRUE: the durable tier is additive protection over a database that is
    // already mandatory here, and running without it is only correct for exactly one
    // process. When it cannot be reached, live ENTRY fails closed and paper degrades to
    // an explicitly-labelled local_only mode.
    durableReservationsEnabled: bool("BOX_DURABLE_RESERVATIONS_ENABLED", true),
    // A third of the lock TTL, clamped. Two renewals may fail before the lease is
    // genuinely at risk, and it is nowhere near per-tick.
    reservationRenewIntervalMs: clampInt(
      "BOX_RESERVATION_RENEW_INTERVAL_MS",
      Math.max(250, Math.floor(clampInt("BOX_INSTRUMENT_LOCK_TTL_MS", 5_000, 250, 60_000) / 3)),
      100,
      30_000,
    ),
    // 250ms covers a healthy NTP-synced fleet plus a Mongo round trip several times
    // over, while costing at most half a second of contract idleness on a handover.
    reservationClockSkewGraceMs: clampInt("BOX_RESERVATION_CLOCK_SKEW_GRACE_MS", 250, 0, 5_000),
    // 60s — twelve default TTLs. Long enough for reconciliation to resolve an ambiguous
    // terminal state, short enough that one bad outcome cannot lock a strike all day.
    reservationUncertainHoldMaxMs: clampInt("BOX_RESERVATION_UNCERTAIN_HOLD_MAX_MS", 60_000, 1_000, 600_000),
    // Defaults to the order-wait budget (BOX_EXECUTION_MAX_WAIT_MS, 1500ms): if an order
    // can legitimately be working that long, ownership must be certain for at least that
    // long before another leg is permitted.
    reservationOwnershipMarginMs: clampInt(
      "BOX_RESERVATION_OWNERSHIP_MARGIN_MS",
      Math.max(250, Math.round(num("BOX_EXECUTION_MAX_WAIT_MS", 1500))),
      0,
      30_000,
    ),
    internalNettingEnabled: bool("BOX_INTERNAL_NETTING_ENABLED", false),

    // Paper live-parity profile. All default to preserving today's behaviour: the
    // profile is `standard`, and the ledger/latency-source are only ever consulted when
    // it is explicitly set to `live_parity`.
    paperExecutionProfile: profile,
    // Default to the LIVE concurrency cap (1) so the recommended validation baseline
    // matches a conservative live deployment; explicit override wins.
    paperMaxConcurrentExecutions: clampInt(
      "BOX_PAPER_MAX_CONCURRENT_EXECUTIONS",
      clampInt("BOX_LIVE_MAX_CONCURRENT_EXECUTIONS", 1, 1, 4),
      1,
      8,
    ),
    paperLatencyMode: latencyMode("BOX_PAPER_LATENCY_MODE", "constant"),
    paperLatencySamples: msSamples("BOX_PAPER_LATENCY_SAMPLES"),
    paperLatencyAckToTerminalSamples: msSamples("BOX_PAPER_LATENCY_ACK_TERMINAL_SAMPLES"),
    paperLatencySeed: num("BOX_PAPER_LATENCY_SEED", 0),

    // Live-calibration consumption. The defaults are deliberately conservative: paper stays on
    // its documented constant until there is a genuinely useful amount of recent evidence, and a
    // narrow time bucket needs twice as much again before it is trusted on its own.
    paperCalibrationMinSamples: clampInt("BOX_PAPER_CALIBRATION_MIN_SAMPLES", 30, 5, 100_000),
    paperCalibrationBucketMinSamples: clampInt("BOX_PAPER_CALIBRATION_BUCKET_MIN_SAMPLES", 60, 5, 100_000),
    // Three days: long enough to survive a weekend gap in evidence, short enough that a
    // fortnight-old network regime never calibrates today.
    paperCalibrationMaxAgeMs: clampInt(
      "BOX_PAPER_CALIBRATION_MAX_AGE_MS",
      3 * 24 * 60 * 60 * 1000,
      60_000,
      30 * 24 * 60 * 60 * 1000,
    ),
    paperCalibrationTimeBuckets: bool("BOX_PAPER_CALIBRATION_TIME_BUCKETS", true),
    // 150ms is a conservative stand-in for a real cancel round trip. NOT zero: an instantaneous
    // cancel is the optimistic assumption the race model exists to remove.
    paperCancelLatencyMs: clampInt("BOX_PAPER_CANCEL_LATENCY_MS", 150, 0, 60_000),
    paperPersistenceMs: clampInt("BOX_PAPER_PERSISTENCE_MS", 0, 0, 60_000),

    liveTimingPersistEnabled: bool("BOX_LIVE_TIMING_PERSIST_ENABLED", false),
    liveTimingBatchSize: clampInt("BOX_LIVE_TIMING_BATCH_SIZE", 50, 1, 10_000),
    liveTimingFlushMs: clampInt("BOX_LIVE_TIMING_FLUSH_MS", 15_000, 250, 10 * 60_000),

    executionEventLoopMetricsEnabled: bool("BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED", true),

    shadowModeEnabled: shadow,
    executionTimingMetricsEnabled: bool("BOX_EXECUTION_TIMING_METRICS_ENABLED", true),
    executionTimingWindow: clampInt("BOX_EXECUTION_TIMING_WINDOW", 500, 50, 100_000),
    deploymentRegion:
      (process.env.BOX_DEPLOYMENT_REGION?.trim() ||
        process.env.BOX_EXECUTION_CALIBRATION_REGION?.trim() ||
        "") || null,

    liveTradingEnabled,
    /*
     * How long unresolved recovery may persist before operational status ESCALATES.
     *
     * Strict rather than clamped: this governs when an operator is told that recovery has stalled, so
     * a typo silently resolving to a long default would delay the alert without saying so. `0`
     * disables escalation and is a legitimate explicit choice — the unresolved state itself is still
     * reported and still blocks entry, because that enforcement lives in the order manager and does
     * not depend on this threshold. See `recoveryEscalation.ts`.
     */
    liveRecoveryEscalationMs: strictLimitInt("BOX_LIVE_RECOVERY_ESCALATION_MS", 120_000, 0, 60 * 60_000),
    liveReconcileIntervalMs: clampInt("BOX_LIVE_RECONCILE_INTERVAL_MS", 60_000, 5_000, 15 * 60_000),
    liveFeedReconnectWarmupMs: clampInt("BOX_LIVE_FEED_RECONNECT_WARMUP_MS", 5_000, 0, 5 * 60_000),
    liveMaxOpenBoxes: clampInt("BOX_LIVE_MAX_OPEN_BOXES", 1, 0, 20),
    liveMaxConcurrentExecutions: clampInt("BOX_LIVE_MAX_CONCURRENT_EXECUTIONS", 1, 1, 4),
    /* A containment limit on how much unresolved one-sided exposure may exist before entry stops.
       `clampInt` silently resolved "abc" to 1 and "9" to 4; both are now refused. `0` still means
       "tolerate none" — the comparison against it is strictly `>` and is not changed here. */
    liveMaxResidualLegs: strictLimitInt("BOX_LIVE_MAX_RESIDUAL_LEGS", 1, 0, 4),
    liveDailyLossLimit: strictLimitInt("BOX_LIVE_DAILY_LOSS_LIMIT", 5_000, 0, 10_000_000),
    liveRejectLimit: clampInt("BOX_LIVE_REJECT_LIMIT", 3, 1, 100),
    liveConsecutiveFailureLimit: clampInt("BOX_LIVE_CONSECUTIVE_FAILURE_LIMIT", 3, 1, 100),
    liveMaxOpenLegQuantity: strictLimitInt("BOX_LIVE_MAX_OPEN_LEG_QUANTITY", 100, 1, 1_000_000),
    liveMaxGrossOpenLegQuantity: strictLimitInt("BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY", 400, 1, 4_000_000),
    liveExactOneLot: strictBool("BOX_LIVE_EXACT_ONE_LOT", false),
    /*
     * The live ENTRY allowlist. Empty means "no identity constraint" — see `allowlistEntryRefusal`
     * for why the absent case is not read as "nothing may be traded". Normalisation happens here,
     * once, with the same rules the operator blocklist uses, so the two layers cannot disagree about
     * what a symbol is.
     */
    liveAllowedUnderlyings: normaliseAllowlist(csv("BOX_LIVE_ALLOWED_UNDERLYINGS")),
    /*
     * The Zerodha static-IP OPERATOR CONFIRMATION. Read through the pure policy module so that one
     * place owns the fail-closed parse and the honest wording. `confirmed` is an operator assertion
     * that the egress IP is registered in the Kite developer console — never a broker-verified fact.
     */
    zerodhaStaticIp: readZerodhaStaticIpPolicy(process.env),
    liveHttpTimeoutMs: clampInt("BOX_LIVE_HTTP_TIMEOUT_MS", 5_000, 250, 30_000),
    liveAckTimeoutMs: clampInt("BOX_LIVE_ACK_TIMEOUT_MS", 3_000, 250, 30_000),
    liveWorkingTimeoutMs: clampInt("BOX_LIVE_WORKING_TIMEOUT_MS", 30_000, 1_000, 10 * 60_000),
    livePartialTimeoutMs: clampInt("BOX_LIVE_PARTIAL_TIMEOUT_MS", 10_000, 500, 5 * 60_000),
    liveCancelTimeoutMs: clampInt("BOX_LIVE_CANCEL_TIMEOUT_MS", 5_000, 250, 60_000),
    liveOrderMutationDeadlineMs: clampInt("BOX_LIVE_ORDER_MUTATION_DEADLINE_MS", 4_000, 250, 30_000),
    liveMaxModifications: clampInt("BOX_LIVE_MAX_MODIFICATIONS", 2, 0, 10),
    liveMaxChaseTicks: clampInt("BOX_LIVE_MAX_CHASE_TICKS", 2, 0, 20),
    liveBrokerMinIntervalMs: clampInt("BOX_LIVE_BROKER_MIN_INTERVAL_MS", 250, 50, 5_000),
    // 0 = derive from the broker's published order-placement limit. A positive value is an
    // operator override, clamped UP to the broker floor by resolveBrokerPacing().
    liveBrokerOrderMinIntervalMs: clampInt("BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS", 0, 0, 5_000),
    // 1 = exactly the pre-existing serialised behaviour. Set 4 for the four-leg entry burst.
    liveEntrySubmitConcurrency: clampInt(
      "BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY",
      ENTRY_SUBMIT_CONCURRENCY_MIN,
      ENTRY_SUBMIT_CONCURRENCY_MIN,
      ENTRY_SUBMIT_CONCURRENCY_MAX,
    ),
    // 0 = disabled, so an existing deployment upgrading to this build is unaffected. The upper
    // bound is deliberately generous (₹100 crore): this is a per-Box notional cap, and clamping
    // it low would silently weaken an operator's intended limit.
    liveMaxBoxCapitalRupees: strictLimitInt("BOX_LIVE_MAX_BOX_CAPITAL_RUPEES", 0, 0, 1_000_000_000),

    // Economic admission (Task 8). Both controls default OFF so existing behaviour is unchanged;
    // enabling either makes missing/stale funds or margin evidence BLOCK entry.
    liveRequireFundsCover: bool("BOX_LIVE_REQUIRE_FUNDS_COVER", false),
    liveRequireMarginEvidence: bool("BOX_LIVE_REQUIRE_MARGIN_EVIDENCE", false),
    liveFundsFreshnessMaxAgeMs: clampInt("BOX_LIVE_FUNDS_FRESHNESS_MAX_AGE_MS", 5_000, 250, 600_000),
    liveMarginFreshnessMaxAgeMs: clampInt("BOX_LIVE_MARGIN_FRESHNESS_MAX_AGE_MS", 5_000, 250, 600_000),
    liveEvidenceReadTimeoutMs: clampInt("BOX_LIVE_EVIDENCE_READ_TIMEOUT_MS", 2_500, 100, 60_000),
    liveEvidenceFutureSkewGraceMs: clampInt("BOX_LIVE_EVIDENCE_FUTURE_SKEW_GRACE_MS", 1_000, 0, 60_000),
    liveEvidenceConcurrentReads: bool("BOX_LIVE_EVIDENCE_CONCURRENT_READS", false),
    liveRequireStageFunding: bool("BOX_LIVE_REQUIRE_STAGE_FUNDING", false),
    liveRecoveryReserveRupees: strictLimitInt("BOX_LIVE_RECOVERY_RESERVE_RUPEES", 0, 0, 100_000_000),

    /*
     * `strictBool`, NOT `bool` — because this switch's default is the UNSAFE direction.
     *
     * `bool()` resolves an unrecognised value to the fallback, and the fallback here is `false` =
     * protection OFF. So `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING=ture` silently disabled the per-underlying
     * lock, on a deployment whose operator had explicitly asked for it. A safety switch must never
     * resolve a typo to the permissive setting; `BOX_ENABLE_SHORT_BOX` already uses `strictBool` for
     * exactly this reason, and this one was inconsistent with it.
     */
    oneActiveBoxPerUnderlying: strictBool("BOX_ONE_ACTIVE_BOX_PER_UNDERLYING", false),
    sessionMaxCompletedTrades: strictLimitInt("BOX_SESSION_MAX_COMPLETED_TRADES", 0, 0, 10_000),
    sessionMaxEntryAttempts: strictLimitInt("BOX_SESSION_MAX_ENTRY_ATTEMPTS", 0, 0, 10_000),
    paperMaxBoxCapitalRupees: clampInt("BOX_PAPER_MAX_BOX_CAPITAL_RUPEES", 0, 0, 1_000_000_000),

    legExecutionMode:
      (process.env.BOX_LEG_EXECUTION_MODE?.trim().toLowerCase() === "sequential"
        ? "sequential"
        : "parallel"),
    legTimeoutMs: num("BOX_LEG_TIMEOUT_MS", 500),
    legUnwindLatencyMs: num("BOX_LEG_UNWIND_LATENCY_MS", 150),

    // Executable order pricing. 2 ticks (₹0.10 at a ₹0.05 tick) of chase on entry
    // is a marketable limit that tolerates a small in-flight move but refuses a
    // runaway one; unwinds get a wider band because flattening matters more.
    legMaxChaseTicks: clampInt("BOX_LEG_MAX_CHASE_TICKS", 2, 0, 100),
    unwindMaxChaseTicks: clampInt("BOX_UNWIND_MAX_CHASE_TICKS", 5, 0, 200),
    defaultTickSize: (() => {
      const v = num("BOX_DEFAULT_TICK_SIZE", 0.05);
      return v > 0 ? v : 0.05;
    })(),

    // Conservative queue approximation, on by default: treat 30% of displayed
    // depth as queued ahead of us. Set BOX_QUEUE_MODEL=none for raw displayed
    // liquidity (the optimistic comparison baseline).
    queueModel: queueModel("BOX_QUEUE_MODEL", "haircut"),
    queueLiquidityHaircutPct: clampPct("BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT", 30),

    /**
     * Four-leg EXCHANGE-timestamp coherence.
     *
     * 1000ms, NOT 250ms — and the difference is not conservatism, it is arithmetic.
     *
     * WHY 250 WAS A BUG, not a tighter setting. Kite's book timestamp is EPOCH SECONDS (see
     * `src/ticker.ts`: `exchangeTs = exSec * 1000`), so every Kite stamp is an exact multiple of
     * 1000ms and cross-leg dispersion can only ever be 0, 1000, 2000, … ms. Four legs the exchange
     * published 160ms apart therefore measure as either 0ms (same second) or a full 1000ms (either
     * side of a second boundary) — purely by where the boundary fell. Against a 250ms limit the
     * boundary case is refused, so a perfectly coherent snapshot was rejected on quantisation noise.
     * This module's own `BROKER_TIMESTAMP_NOTES` in executionCoherence.ts has always said so:
     * "Any exchange-dispersion threshold below ~1000 ms is therefore unsatisfiable-by-noise for Kite
     * data and would reject coherent books purely on quantisation."
     *
     * Observed consequence before this change: a paper_legging run showed 100% refusals, every one
     * `cross_leg_time_skew`, on a healthy feed with 200+ underlyings — and the two deploy templates
     * that shipped 250 carried a comment asserting the receive-time gate "actually governs", which
     * the code contradicts (`evaluateBookCoherence` applies the exchange bound whenever it is > 0 and
     * all four legs carry a stamp, which for Kite depth packets is always).
     *
     * WHY RAISING IT LOSES NO PROTECTION. Sub-second coherence is enforced by
     * `maxCrossLegReceiveDispersionMs` (500ms) against OUR OWN arrival clock, which is millisecond-
     * resolution and always present. That is the precise gate. This one is a COARSE sanity check that
     * still catches genuinely separated books — stamps spanning 15s/18s/15s/19s measure 4000ms and are
     * still refused. Setting it BELOW the broker's precision does not buy tighter coherence; it only
     * makes admission depend on second boundaries.
     *
     * `0` still disables it entirely, leaving receive-time as the sole constraint. A value below the
     * active broker's documented precision is warned about at boot (see `warnCoherencePrecision`).
     */
    maxCrossLegExchangeDispersionMs: clampInt("BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS", 1_000, 0, 60_000),
    // Four-leg RECEIVE-TIME coherence — the ALWAYS-available cross-sectional bound
    // (Dhan has no book exchange stamp; Kite's is 1s-granular). 500ms comfortably
    // admits a genuine simultaneous snapshot delivered over one socket yet rejects
    // legs whose arrival is visibly out of step. This is the primary LIVE gate.
    maxCrossLegReceiveDispersionMs: clampInt("BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS", 500, 0, 60_000),
    // A book cannot be received before the exchange published it; 5s tolerates
    // coarse (1s) exchange stamps and normal feed latency without flagging a fault.
    maxReceiveToExchangeDelayMs: clampInt("BOX_MAX_RECEIVE_TO_EXCHANGE_DELAY_MS", 5_000, 0, 120_000),
    // In LIVE, a 0 cross-leg dispersion limit is impossible-to-satisfy (safe) unless
    // the operator explicitly opts out here. Paper always reads 0 as "disabled".
    coherenceZeroDispersionDisablesInLive: bool("BOX_COHERENCE_ZERO_DISPERSION_DISABLES_IN_LIVE", false),

    // THE gate: ₹1,200 of expected net profit after every cost.
    minExpectedNetProfit: nonNegativeNum("BOX_MIN_EXPECTED_NET_PROFIT", 1200),
    // Prefilter only.
    minGrossEdge: nonNegativeNum("MIN_BOX_GROSS_EDGE", 1200),
    minNetEdge: nonNegativeNum("MIN_BOX_NET_EDGE", 0),
    safetyBuffer: nonNegativeNum("BOX_SAFETY_BUFFER", 150),
    expectedEntrySlippage: nonNegativeNum("BOX_EXPECTED_ENTRY_SLIPPAGE", 250),
    expectedExitSlippage: nonNegativeNum("BOX_EXPECTED_EXIT_SLIPPAGE", 250),
    prefilterChargeAllowance: nonNegativeNum("BOX_PREFILTER_CHARGE_ALLOWANCE", 160),
    requirePricedCharges: bool("BOX_REQUIRE_PRICED_CHARGES", true),

    reconcileCharges: bool("BOX_RECONCILE_CHARGES", true),
    chargeReconcileWarnPct: num("BOX_CHARGE_RECONCILE_WARN_PCT", 5),
    chargeReconcileConcurrency: num("BOX_CHARGE_RECONCILE_CONCURRENCY", 2),
    chargeReconcileMaxAttempts: num("BOX_CHARGE_RECONCILE_MAX_ATTEMPTS", 3),
    chargeReconcileRetryBaseMs: num("BOX_CHARGE_RECONCILE_RETRY_BASE_MS", 5_000),

    quoteMaxAgeMs: num("BOX_QUOTE_MAX_AGE_MS", 15_000),
    feedMaxAgeMs: num("BOX_FEED_MAX_AGE_MS", 5_000),
    // Order-event ingestion backpressure threshold. Order postbacks are low-volume relative to
    // market data, so a sustained backlog past this many queued frames is a genuine processing-lag
    // incident: overload pauses NEW ENTRY and prompts reconciliation while the never-drop queue
    // keeps delivering every event. Not a cap — data is never dropped.
    orderEventQueuePressureThreshold: num("BOX_ORDER_EVENT_QUEUE_PRESSURE", 512),
    underlyingMaxAgeMs: num("BOX_UNDERLYING_MAX_AGE_MS", 10_000),

    strikesEachSide: 3,
    /*
     * `clampStrikeLevel(num(...))` resolved BOTH a typo and an out-of-range value to 3 — the WIDEST
     * candidate set, three strikes each side. An operator narrowing a first live test to ATM±1 who
     * typed `BOX_STRIKE_LEVEL=one` got the widest scan instead of the narrowest, silently.
     *
     * `strictLimitInt` refuses an explicitly-set invalid value; `clampStrikeLevel` is retained
     * around it only to narrow the type to `1 | 2 | 3` (it is a no-op now that the input is proven
     * to be in range, and is still needed for the runtime-tuning path that does not come from env).
     */
    defaultStrikeLevel: clampStrikeLevel(strictLimitInt("BOX_STRIKE_LEVEL", 3, 1, 3)),
    atmHysteresis: num("BOX_ATM_HYSTERESIS", 0.15),
    windowMinIntervalMs: num("BOX_WINDOW_MIN_INTERVAL_MS", 15_000),
    enableShortBox: strictBool("BOX_ENABLE_SHORT_BOX", true),

    convergenceFloor: nonNegativeNum("BOX_CONVERGENCE_FLOOR", 200),
    convergencePct: num("BOX_CONVERGENCE_PCT", 0.2),
    minExitNetPnl: nonNegativeNum("BOX_MIN_EXIT_NET_PNL", 600),
    exitUseRealisableNet: bool("BOX_EXIT_USE_REALISABLE", true),
    profitCapturePct: num("BOX_PROFIT_CAPTURE_PCT", 0.75),
    minCapturedPct: num("BOX_MIN_CAPTURED_PCT", 0.75),

    expirySafetyMinutesBeforeClose: nonNegativeNum("BOX_EXPIRY_SAFETY_MINUTES", 45),

    monitorIntervalMs: periodMs("BOX_MONITOR_INTERVAL_MS", 1000),
    persistIntervalMs: periodMs("BOX_PERSIST_INTERVAL_MS", 30_000),
    publishIntervalMs: periodMs("BOX_PUBLISH_INTERVAL_MS", 500),
    universeRefreshMs: periodMs("BOX_UNIVERSE_REFRESH_MS", 60_000),
    indicativeRefreshMs: periodMs("BOX_INDICATIVE_REFRESH_MS", 60_000),
    indicativeDiscovery: bool("BOX_INDICATIVE_DISCOVERY", true),
    // ~150 underlyings × 14 legs ≈ 2,100 tokens ≈ 5 chunked /quote requests a
    // minute, comparable to what a running scanner already costs.
    indicativeMaxUnderlyings: num("BOX_INDICATIVE_MAX_UNDERLYINGS", 150),
    maxSubscribedTokens: num("BOX_MAX_SUBSCRIBED_TOKENS", 2200),
    /*
     * THE UNIVERSE CAP, AND WHY `num()` WAS THE WRONG PARSER FOR IT.
     *
     * `num()` applies no bounds whatsoever: it returns the fallback on NaN and otherwise passes the
     * number straight through. For a cap whose fallback is `0` AND where `0` means UNLIMITED, that
     * made every kind of typo resolve to the most permissive value available, and two more besides:
     *
     *     BOX_MAX_UNDERLYINGS="abc"  -> NaN -> fallback 0  -> UNLIMITED
     *     BOX_MAX_UNDERLYINGS="-4"   -> -4                 -> a NEGATIVE cap reached the engine
     *     BOX_MAX_UNDERLYINGS="1.7"  -> 1.7                -> a FRACTIONAL cap reached the engine
     *
     * An operator restricting a supervised trial to one underlying who fat-fingers the value got an
     * unbounded universe, and nothing said so. That is the same fail-open shape `strictLimitInt`
     * was written for, so this now uses it.
     *
     * `0` STILL MEANS UNLIMITED — the sentinel is deliberately unchanged here (min is 0, so an
     * explicit `0` remains valid). This commit makes a MALFORMED value fatal; it does not
     * reinterpret a well-formed one. The upper bound is deliberately generous: the whole F&O
     * universe is a few hundred names, so 1000 cannot refuse a legitimate configuration and exists
     * only to catch garbage that happens to parse as a number.
     */
    maxUnderlyings: strictLimitInt("BOX_MAX_UNDERLYINGS", 0, 0, 1_000),
    chargeCacheTtlMs: num("BOX_CHARGE_CACHE_TTL_MS", 30_000),
    chargeConcurrency: num("BOX_CHARGE_CONCURRENCY", 3),
    maxPublishedOpportunities: num("BOX_MAX_PUBLISHED_OPPORTUNITIES", 60),
    metricsWindow: num("BOX_METRICS_WINDOW", 500),

    pnlCacheEnabled: bool("BOX_PNL_CACHE_ENABLED", false),
    pnlCacheIntervalMs: num("BOX_PNL_CACHE_INTERVAL_MS", 30_000),
    pnlCacheTtlSec: num("BOX_PNL_CACHE_TTL_SEC", 3 * 24 * 60 * 60),
    pnlArchiveHour: clampHour(num("BOX_PNL_ARCHIVE_HOUR", 21), 21),
    pnlVerifyHours: hours("BOX_PNL_VERIFY_HOURS", [22, 23]),
    pnlArchiveDrainDelayMs: num("BOX_PNL_ARCHIVE_DRAIN_DELAY_MS", 50),

    closedCacheEnabled: bool("BOX_CLOSED_CACHE_ENABLED", true),
    closedCacheTtlSec: num("BOX_CLOSED_CACHE_TTL_SEC", 3 * 24 * 60 * 60),
  };
}

/**
 * The minimum expected NET profit a box must show to be entered.
 *
 * One number, one decision path: the new gate, raised by the legacy
 * MIN_BOX_NET_EDGE floor if somebody has deliberately configured a stricter one.
 */
export function requiredNetProfit(
  cfg: Pick<BoxConfig, "minExpectedNetProfit" | "minNetEdge">,
): number {
  return Math.max(cfg.minExpectedNetProfit, cfg.minNetEdge > 0 ? cfg.minNetEdge : 0);
}

/**
 * The gross edge (₹) a candidate must clear before it is worth running the full
 * qualification and execution pipeline on it — the FAST LOCAL PREFILTER.
 *
 * Deliberately a LOWER bound. The real gate needs
 * `requiredNetProfit + charges + executionCost + buffer` of gross, which is
 * strictly more than this, so the prefilter cannot discard a box that would have
 * qualified.
 */
export function prefilterGrossThreshold(cfg: BoxConfig): number {
  return Math.max(0, cfg.minGrossEdge);
}

/** The immutable settings frozen onto every trade document. */
export function configSnapshot(cfg: BoxConfig): BoxScannerConfigSnapshot {
  return {
    min_gross_edge: cfg.minGrossEdge,
    min_net_edge: cfg.minNetEdge,
    min_expected_net_profit: requiredNetProfit(cfg),
    safety_buffer: cfg.safetyBuffer,
    expected_entry_slippage: cfg.expectedEntrySlippage,
    expected_exit_slippage: cfg.expectedExitSlippage,
    quote_max_age_ms: cfg.quoteMaxAgeMs,
    strikes_each_side: cfg.strikesEachSide,
    convergence_floor: cfg.convergenceFloor,
    convergence_pct: cfg.convergencePct,
    min_exit_net_pnl: cfg.minExitNetPnl,
    profit_capture_pct: cfg.profitCapturePct,
    min_captured_pct: cfg.minCapturedPct,
    execution_mode: cfg.executionMode,
    simulated_decision_ms: cfg.simulatedDecisionMs,
    simulated_latency_ms: cfg.simulatedLatencyMs,
    paper_execution_profile: cfg.paperExecutionProfile,
    live_trading_enabled: cfg.liveTradingEnabled,
    live_reconcile_interval_ms: cfg.liveReconcileIntervalMs,
    live_feed_reconnect_warmup_ms: cfg.liveFeedReconnectWarmupMs,
    live_max_open_boxes: cfg.liveMaxOpenBoxes,
    live_max_concurrent_executions: cfg.liveMaxConcurrentExecutions,
    live_max_residual_legs: cfg.liveMaxResidualLegs,
    live_daily_loss_limit: cfg.liveDailyLossLimit,
    live_reject_limit: cfg.liveRejectLimit,
    live_consecutive_failure_limit: cfg.liveConsecutiveFailureLimit,
    live_max_open_leg_quantity: cfg.liveMaxOpenLegQuantity,
    live_max_gross_open_leg_quantity: cfg.liveMaxGrossOpenLegQuantity,
    live_http_timeout_ms: cfg.liveHttpTimeoutMs,
    live_ack_timeout_ms: cfg.liveAckTimeoutMs,
    live_working_timeout_ms: cfg.liveWorkingTimeoutMs,
    live_partial_timeout_ms: cfg.livePartialTimeoutMs,
    live_cancel_timeout_ms: cfg.liveCancelTimeoutMs,
    live_order_mutation_deadline_ms: cfg.liveOrderMutationDeadlineMs,
    live_max_modifications: cfg.liveMaxModifications,
    live_max_chase_ticks: cfg.liveMaxChaseTicks,
    live_broker_min_interval_ms: cfg.liveBrokerMinIntervalMs,
    // Frozen onto the trade so an execution stays interpretable after these are retuned:
    // "why were the legs 250ms apart?" must be answerable from the document alone.
    live_broker_order_min_interval_ms: cfg.liveBrokerOrderMinIntervalMs,
    live_entry_submit_concurrency: cfg.liveEntrySubmitConcurrency,
    live_max_box_capital_rupees: cfg.liveMaxBoxCapitalRupees,
    one_active_box_per_underlying: cfg.oneActiveBoxPerUnderlying,
    session_max_completed_trades: cfg.sessionMaxCompletedTrades,
    session_max_entry_attempts: cfg.sessionMaxEntryAttempts,
    // Executable-order-pricing knobs, frozen so a paper_legging fill stays
    // interpretable after the defaults are retuned.
    leg_max_chase_ticks: cfg.legMaxChaseTicks,
    unwind_max_chase_ticks: cfg.unwindMaxChaseTicks,
    queue_model: cfg.queueModel,
    queue_liquidity_haircut_pct: cfg.queueLiquidityHaircutPct,
    max_cross_leg_exchange_dispersion_ms: cfg.maxCrossLegExchangeDispersionMs,
    max_cross_leg_receive_dispersion_ms: cfg.maxCrossLegReceiveDispersionMs,
    max_receive_to_exchange_delay_ms: cfg.maxReceiveToExchangeDelayMs,
    coherence_zero_dispersion_disables_in_live: cfg.coherenceZeroDispersionDisablesInLive,
  };
}
