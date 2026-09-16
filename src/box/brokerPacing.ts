/**
 * BROKER-AWARE LIVE TRANSPORT PACING POLICY.
 *
 * WHY THIS MODULE EXISTS
 *
 * `BOX_LIVE_BROKER_MIN_INTERVAL_MS` (default 250ms) was a SINGLE knob applied by the
 * adapters' shared `call()` throttle to EVERY transport operation alike: order placement,
 * modification, cancellation, order-status polls, positions reads, margins and health.
 * That conflates two genuinely different things:
 *
 *   1. A REAL broker rate limit on order mutation. Exceeding it earns a 429 and, at
 *      Zerodha, counts the rejected request against the daily order-request budget. This
 *      is a hard external constraint and must be honoured.
 *
 *   2. A POLL CADENCE we chose ourselves. How often we re-read a working order's status
 *      is our decision, and 250ms is a sensible, deliberately unhurried choice.
 *
 * Because both used one number, making the four-leg entry burst reach the broker faster
 * would have required lowering the status-poll cadence too — spending real API budget to
 * buy submission speed. Splitting them lets the four ENTRY placements be spaced at the
 * broker's actual published placement limit while polling stays calm.
 *
 * THIS IS NOT "REMOVING A DELAY". The gap between successive placements remains a REAL
 * rate-limit wait derived from published broker limits, never zero, and never below a
 * per-broker floor. See {@link BROKER_PACING_PROFILES}.
 *
 * PUBLISHED LIMITS THE DEFAULTS ARE DERIVED FROM  (verified 2026-09-09; see docs/BROKER_LIMITS.md)
 *
 *   Zerodha / Kite Connect v3 — order placement is limited to 10 requests/second, with a
 *   further 400 orders/minute and 5000 orders/day per-user/API-key cap (across all
 *   segments and varieties), and order MODIFICATION is capped at 25 modifications per
 *   order — after which the order must be cancelled and re-placed. 10/s ⇒ a 100ms floor;
 *   the default adds 10% headroom (110ms) because the limiter is enforced on the broker's
 *   clock, not ours, and a burst that lands microseconds early is a 429.
 *   Source: https://kite.trade/docs/connect/v3/exceptions/#api-rate-limit
 *
 *   Dhan (DhanHQ v2) — CORRECTION OF A PRIOR DEFECT. This module previously asserted that
 *   "Dhan permits materially more than 10/s". The official DhanHQ v2 documentation states
 *   Order APIs are limited to 10 requests/second, 250/minute, 1000/hour and 7000/day, with
 *   modifications capped at 25/order. There is no headroom above 10/s to be had, so the
 *   old claim was simply wrong and is removed. The repository's own `src/brokers/dhan/http.ts`
 *   additionally paces every HTTP call at `DHAN_MIN_INTERVAL_MS` (default 120ms); 120ms is
 *   ABOVE the 100ms the 10/s limit alone would allow, so it is the binding floor here and
 *   is CONSERVATIVE with respect to the published 10/s. Source:
 *   https://dhanhq.co/docs/v2/  (the "Rate Limit" table). A Dhan customer-support FAQ
 *   quotes a higher "25 orders/second, 250/minute" figure; where the developer docs and a
 *   support FAQ disagree we take the STRICTER developer-doc figure, since guessing upward
 *   is the one direction that earns a real 429 on a real order.
 *
 * MULTI-WINDOW BUDGETS. A single min-interval only bounds the PER-SECOND rate. The broker
 * also enforces per-minute, per-hour and per-day caps, and a four-leg entry every few
 * seconds can exhaust a per-minute or per-day budget long before the per-second gap ever
 * binds. {@link BrokerRateLimits} carries every published window and {@link RateBudgetLedger}
 * accounts spend against all of them, so admission can refuse an entry that WOULD fit the
 * 100ms gap but would breach the day cap — and so a reserve is always kept for recovery.
 *
 * THE NUMBERS HERE PERFORM NO I/O. The pacer and ledger take an injected clock; everything
 * else is a pure description of policy so the adapters, the diagnostics endpoint and the
 * paper live_parity scheduler all read the SAME effective numbers and cannot drift.
 */

import type { BrokerId } from "./latencyModel.js";
import type { Deadline } from "../brokers/deadline.js";

/**
 * Which rate-limit bucket a transport operation belongs to.
 *
 *   "order_mutation" — place / modify / cancel. Governed by the broker's ORDER rate
 *                      limit. Cancellation is deliberately in the fast bucket: a
 *                      protective cancel is the operation we least want to slow down.
 *
 *   "general"        — order-status polls, order lists, positions, margins, health.
 *                      Governed by our own chosen cadence.
 */
export type BrokerPacingClass = "order_mutation" | "general";

/**
 * The per-broker floors and defaults for order-mutation pacing.
 *
 * `floorMs` is a HARD floor. An operator override below it is clamped UP, not honoured:
 * the floor encodes an external constraint (or a lower transport layer that will impose
 * the wait anyway), so permitting a smaller value would only make the reported number
 * dishonest while the wait still happened.
 */
export interface BrokerPacingProfile {
  readonly broker: BrokerId;
  /** Default gap (ms) between successive order mutations when no override is set. */
  readonly defaultOrderMutationMs: number;
  /** Hard minimum gap (ms). Overrides below this are clamped up to it. */
  readonly floorMs: number;
  /** Human-readable justification, surfaced verbatim in diagnostics. */
  readonly rationale: string;
}

export const BROKER_PACING_PROFILES: Readonly<Record<BrokerId, BrokerPacingProfile>> = Object.freeze({
  zerodha: Object.freeze({
    broker: "zerodha" as const,
    defaultOrderMutationMs: 110,
    floorMs: 100,
    rationale:
      "Kite Connect permits 10 order requests/second (100ms floor); the default adds 10% headroom " +
      "because the limiter runs on the broker's clock and a rejected request still consumes the " +
      "daily order-request budget.",
  }),
  dhan: Object.freeze({
    broker: "dhan" as const,
    defaultOrderMutationMs: 120,
    floorMs: 120,
    rationale:
      "DhanHQ v2 Order APIs permit 10 order requests/second (verified 2026-09-09), NOT more, so " +
      "the 100ms the limit alone would allow is the ceiling. src/brokers/dhan/http.ts additionally " +
      "paces every HTTP call at DHAN_MIN_INTERVAL_MS (default 120ms), which is ABOVE 100ms and " +
      "therefore the binding floor here — conservative w.r.t. the published 10/s.",
  }),
});

/**
 * The pacing actually in force for one broker, with its provenance.
 *
 * `source` exists so the diagnostics endpoint can answer "why is it this number?" without
 * the reader having to reconstruct the clamp chain in their head.
 */
export interface EffectiveBrokerPacing {
  readonly broker: BrokerId;
  /** Gap (ms) enforced between successive place/modify/cancel calls. */
  readonly orderMutationMinIntervalMs: number;
  /** Gap (ms) enforced between all other transport calls, incl. status polls. */
  readonly generalMinIntervalMs: number;
  /** Where `orderMutationMinIntervalMs` came from. */
  readonly source: "broker_default" | "operator_override" | "clamped_to_floor" | "clamped_to_general";
  /** The broker's hard floor, for display. */
  readonly floorMs: number;
  readonly rationale: string;
}

/**
 * Resolve the effective pacing for a broker.
 *
 * @param broker              the broker the adapter is talking to.
 * @param generalMinIntervalMs `BOX_LIVE_BROKER_MIN_INTERVAL_MS` — the existing knob, still
 *                             governing polls and every non-mutating call. Unchanged in
 *                             meaning, which is why existing deployments see no behaviour
 *                             change for those calls.
 * @param orderOverrideMs      `BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS`. `0` (the default)
 *                             means "use the broker profile default". Any positive value
 *                             is an operator override, clamped up to the broker floor.
 *
 * Total and pure: unknown brokers fall back to the STRICTEST profile rather than to no
 * pacing, because an unrecognised broker is exactly the case where we know least about
 * its limits.
 */
export function resolveBrokerPacing(
  broker: BrokerId | string,
  generalMinIntervalMs: number,
  orderOverrideMs: number,
): EffectiveBrokerPacing {
  const profile = brokerPacingProfile(broker);
  const general = Number.isFinite(generalMinIntervalMs) ? Math.max(0, Math.floor(generalMinIntervalMs)) : 250;

  let order: number;
  let source: EffectiveBrokerPacing["source"];
  if (Number.isFinite(orderOverrideMs) && Math.floor(orderOverrideMs) > 0) {
    const requested = Math.floor(orderOverrideMs);
    if (requested < profile.floorMs) {
      order = profile.floorMs;
      source = "clamped_to_floor";
    } else {
      order = requested;
      source = "operator_override";
    }
  } else {
    order = profile.defaultOrderMutationMs;
    source = "broker_default";
  }

  // NEVER SLOWER THAN THE GENERAL INTERVAL WOULD HAVE BEEN is NOT a rule: the general
  // interval may legitimately be tightened below the order floor by an operator, in which
  // case order mutation must still respect its own (larger) floor. But the reverse — an
  // order interval LARGER than the general one — is honoured as-is, since a deliberately
  // slow placement cadence is a safe direction to err in.
  //
  // The one correction worth making: if the general interval is TIGHTER than the order
  // interval the operator asked for, the operator has not been misled, so nothing changes.
  // If the general interval is looser, the effective spacing of a placement is still the
  // order interval because the two buckets are tracked independently below.
  if (order < profile.floorMs) {
    order = profile.floorMs;
    source = "clamped_to_floor";
  }

  return {
    broker: profile.broker,
    orderMutationMinIntervalMs: order,
    generalMinIntervalMs: general,
    source,
    floorMs: profile.floorMs,
    rationale: profile.rationale,
  };
}

/** The profile for a broker id, defaulting to the strictest known profile. */
export function brokerPacingProfile(broker: BrokerId | string): BrokerPacingProfile {
  const key = typeof broker === "string" ? broker.trim().toLowerCase() : broker;
  if (key === "zerodha") return BROKER_PACING_PROFILES.zerodha;
  if (key === "dhan") return BROKER_PACING_PROFILES.dhan;
  return strictestProfile();
}

/**
 * The most conservative profile across all known brokers.
 *
 * Used for an unrecognised broker id. Picking the LARGEST floor and the LARGEST default is
 * the fail-closed direction: pacing too slowly costs latency, pacing too quickly costs a
 * rate-limit rejection on a real order.
 */
function strictestProfile(): BrokerPacingProfile {
  const all = [BROKER_PACING_PROFILES.zerodha, BROKER_PACING_PROFILES.dhan];
  const floorMs = Math.max(...all.map((p) => p.floorMs));
  const defaultOrderMutationMs = Math.max(...all.map((p) => p.defaultOrderMutationMs));
  return {
    // The strictest profile is not attributable to one broker; report the safest label.
    broker: "zerodha",
    defaultOrderMutationMs,
    floorMs,
    rationale:
      "Unrecognised broker id: falling back to the strictest known pacing profile, because an " +
      "unknown broker is exactly the case where its published limits are least certain.",
  };
}

/**
 * The wait (ms) an operation must serve before it may touch the transport.
 *
 * Pure: the caller owns the clock and the "last call" bookkeeping, one watermark PER
 * CLASS. Returns 0 when the required gap has already elapsed, and never a negative number.
 *
 * Separate watermarks are what makes the split real. Sharing one watermark would mean a
 * status poll 10ms ago forced the next PLACEMENT to wait the general interval, which is
 * the very conflation this module removes.
 */
export function pacingWaitMs(args: {
  readonly pacing: EffectiveBrokerPacing;
  readonly klass: BrokerPacingClass;
  readonly lastCallAt: number;
  readonly now: number;
}): number {
  const required = args.klass === "order_mutation"
    ? args.pacing.orderMutationMinIntervalMs
    : args.pacing.generalMinIntervalMs;
  if (!Number.isFinite(args.lastCallAt)) return 0;
  const elapsed = args.now - args.lastCallAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    // A non-monotonic clock reading. Serve the FULL interval rather than trusting a
    // negative elapsed time, which would otherwise let a clock step bypass pacing.
    return required;
  }
  return Math.max(0, required - elapsed);
}

/**
 * Worst-case wall-clock cost (ms) of pacing a burst of `legCount` order mutations.
 *
 * The first placement pays nothing (its predecessor is a poll on the other watermark, or
 * nothing at all), so `legCount - 1` gaps are paid. Reported in diagnostics so an operator
 * can see the pacing floor on first-to-last submit WITHOUT having to place a real order.
 */
export function burstPacingBudgetMs(pacing: EffectiveBrokerPacing, legCount: number): number {
  const legs = Number.isFinite(legCount) ? Math.max(0, Math.floor(legCount)) : 0;
  if (legs <= 1) return 0;
  return (legs - 1) * pacing.orderMutationMinIntervalMs;
}

/** Cumulative pacing observations, for diagnostics. Bounded and low-cardinality. */
export interface TransportPacerStats {
  readonly orderMutations: number;
  readonly generalCalls: number;
  readonly totalWaitMs: number;
  readonly orderMutationWaitMs: number;
  readonly generalWaitMs: number;
  /** Times the ABSOLUTE floor (not the class interval) was the binding constraint. */
  readonly absoluteFloorBinds: number;
  readonly maxObservedWaitMs: number;
  /** Operations that expired or were withdrawn while QUEUED and so never reached the wire. */
  readonly abandonedBeforeDispatch: number;
  /** Operations a dispatch-time admission check (e.g. the order budget) refused before sending. */
  readonly refusedAtDispatch: number;
  /** High-water mark of the dispatch queue, so a starving queue is visible. */
  readonly maxObservedQueueDepth: number;
  /** High-water mark of concurrently in-flight transport calls. */
  readonly maxObservedInFlight: number;
  /** Times a risk-reducing operation was dispatched ahead of an older, less urgent one. */
  readonly priorityOvertakes: number;
}

/**
 * DISPATCH URGENCY — which operation goes first when several are waiting.
 *
 * The manager has always had a priority order (`executionSchedulingPolicy.ts`:
 * EMERGENCY_RESIDUAL → PROTECTIVE_CANCEL → EXIT → ENTRY), but that information was DISCARDED at
 * the adapter boundary: below it, one FIFO promise chain served whatever arrived first. So a
 * routine positions poll that entered the chain ahead of a protective cancel was served first, and
 * the cancel waited out the poll's entire round trip.
 *
 *   "recovery"  — reduces or resolves risk: cancel, modify, and protective (EXIT /
 *                 EMERGENCY_RESIDUAL / PROTECTIVE_CANCEL) placements. Dispatched first, and holds
 *                 a reserved slice of concurrency no other class may consume.
 *   "placement" — an ENTRY placement. Takes risk, so it yields to recovery, but it must not sit
 *                 behind nonurgent reads: a short leg delayed by a positions poll widens the
 *                 uncovered window.
 *   "read"      — polls and status reads. Never urgent; always yields.
 */
export type TransportUrgency = "recovery" | "placement" | "read";

const URGENCY_RANK: Readonly<Record<TransportUrgency, number>> = Object.freeze({
  recovery: 0,
  placement: 1,
  read: 2,
});

/**
 * A queued transport operation that never reached the wire. PROVEN not transmitted.
 *
 * This distinction is the whole point of {@link TransportPacer.submit}. A caller that times out
 * needs to know which of two very different things happened:
 *
 *   - the request was still QUEUED and has now been withdrawn — nothing was sent, nothing exists at
 *     the broker, and the local state should not be quarantined;
 *   - the request was DISPATCHED and the outcome is unknown — it may well have reached the
 *     exchange, so it must stay ambiguous and be reconciled.
 *
 * Reporting the first as the second manufactures uncertainty; reporting the second as the first is
 * far worse — it would let a timeout be read as "nothing was sent".
 */
export class TransportRequestAbandonedError extends Error {
  /** Always false, and PROVEN: the pacer never invoked the operation. */
  readonly transmitted = false;

  constructor(
    message: string,
    /** The endpoint class, for diagnostics. */
    readonly klass: BrokerPacingClass,
    /** How long it had been queued when it was withdrawn. */
    readonly queuedMs: number,
  ) {
    super(message);
    this.name = "TransportRequestAbandonedError";
  }
}

/** Per-operation dispatch controls. All optional: omitting them reproduces the previous behaviour. */
export interface TransportRunOptions {
  /** Dispatch tier. Defaults to `"read"` — the tier that yields to everything. */
  readonly urgency?: TransportUrgency;
  /**
   * An ABSOLUTE deadline for this operation.
   *
   * Consulted before admission, after every pacing sleep, and one last time immediately before
   * dispatch. An operation whose deadline has passed while it was queued is REFUSED, never sent
   * late — the defect this closes is a cancellation that timed out, was reported to the caller as
   * timed out, and was then transmitted anyway once the request ahead of it finally returned.
   */
  readonly deadline?: Deadline | null;
  /**
   * Synchronous admission check, run AT DISPATCH rather than at enqueue.
   *
   * Throwing refuses the operation without sending it, so the throw is a proven no-request. This is
   * where the rate budget is charged: charging at enqueue counted spend for operations that were
   * later abandoned, which is how a budget drifts away from what the broker actually saw.
   */
  readonly beforeDispatch?: () => void;
}

/** A submitted operation: its settlement, plus the ability to ask about and withdraw it. */
export interface TransportSubmission<T> {
  /** Settles with the operation's outcome, or rejects with {@link TransportRequestAbandonedError}. */
  readonly result: Promise<T>;
  /** Has the operation been handed to the transport? Once true it can never become false. */
  dispatched(): boolean;
  /**
   * Withdraw the operation if it has not been dispatched.
   *
   * Returns true when the withdrawal succeeded, which is a PROOF that nothing was transmitted;
   * false when the operation was already on the wire and the outcome is therefore ambiguous.
   */
  abandon(reason: string): boolean;
}

interface QueuedOperation {
  readonly seq: number;
  readonly klass: BrokerPacingClass;
  readonly urgency: TransportUrgency;
  readonly deadline: Deadline | null;
  readonly beforeDispatch: (() => void) | undefined;
  readonly operation: () => Promise<unknown>;
  readonly enqueuedAt: number;
  readonly settle: (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => void;
  waitedMs: number;
  state: "queued" | "dispatched" | "settled";
}

/**
 * How much of the transport may be in flight at once, and how much is held back for recovery.
 *
 * WHY CONCURRENCY EXISTS AT ALL NOW. The pacer used to await each operation's COMPLETION before
 * even computing the next one's pacing wait, which conflated two unrelated quantities: the rate the
 * broker permits (a property of time) and how long a request happens to take (a property of the
 * network). One parked 5-second read therefore blocked every subsequent request — including a
 * protective cancel — for 5 seconds, even though the broker would have accepted another request
 * 110ms in.
 *
 * THE BROKER SEES NO HIGHER RATE THAN BEFORE. Dispatch spacing is unchanged and still enforced from
 * the watermarks, and the absolute floor still bounds total dispatch to
 * `1 / orderMutationMinIntervalMs` (10/s for Zerodha, its published ceiling). Concurrency only
 * decouples "when may the next request leave" from "has the previous one come back".
 */
export interface TransportConcurrencyLimits {
  /** Total simultaneous transport calls. */
  readonly maxInFlight: number;
  /**
   * Slots only `"recovery"` operations may occupy.
   *
   * The same reasoning as `RateBudgetLedger`'s recovery reserve: the moment the transport is
   * saturated is exactly the moment a cancel is most likely to be needed, so capacity to shed risk
   * is withheld rather than shared.
   */
  readonly reservedForRecovery: number;
  /**
   * Simultaneous `"read"` operations. Defaults to 1, deliberately.
   *
   * Reads stay serialised with EACH OTHER because nothing is gained by overlapping two status polls
   * of the same order, and keeping them one-at-a-time preserves the lost-update ordering the
   * REST/stream merge tests already pin. The defect was never that reads did not overlap — it was
   * that a read blocked a CANCEL, which the tiers and the reserve now prevent.
   */
  readonly maxConcurrentReads: number;
}

export const DEFAULT_TRANSPORT_CONCURRENCY: TransportConcurrencyLimits = Object.freeze({
  maxInFlight: 4,
  reservedForRecovery: 1,
  maxConcurrentReads: 1,
});

/**
 * The transport pacer both live adapters share.
 *
 * WHY A CLASS RATHER THAN TWO COPIES OF THE ARITHMETIC: the Kite and Dhan adapters
 * previously each had their own inline `call()` throttle. Duplicated pacing arithmetic in a
 * safety-critical path is how the two brokers silently drift apart, and it also meant the
 * effective interval could not be reported honestly from one place.
 *
 * THREE WATERMARKS, and why each exists:
 *
 *   lastOrderMutationAt — gates place/modify/cancel at the broker's ORDER limit.
 *   lastGeneralAt       — gates polls/reads at our chosen cadence.
 *   lastAnyCallAt       — an ABSOLUTE floor across every call regardless of class.
 *
 * The third is the important one. Splitting one bucket into two independent buckets raises
 * the achievable TOTAL request rate: with only per-class watermarks, alternating a poll and a
 * placement could exceed the broker's overall cap even while each class respected its own
 * interval. The absolute floor bounds total transport at `1 / orderMutationMinIntervalMs`
 * (10/s for Zerodha — exactly its published ceiling), so splitting the buckets buys entry
 * speed WITHOUT raising the peak rate the broker sees.
 *
 * The pacer holds no timers: the caller injects `now` and `wait`, which is what lets the
 * tests drive it on a virtual clock and assert the exact gaps.
 */
export class TransportPacer {
  private lastOrderMutationAt = Number.NEGATIVE_INFINITY;
  private lastGeneralAt = Number.NEGATIVE_INFINITY;
  private lastAnyCallAt = Number.NEGATIVE_INFINITY;

  /**
   * Operations waiting for a dispatch slot, in arrival order.
   *
   * THIS REPLACES A PROMISE CHAIN (`tail`), and the replacement is the fix. A chain can only be
   * appended to: it has no priority, nothing can be removed from it, and — the actual defect — each
   * link resolved only when the previous operation's HTTP call SETTLED, so the successor's pacing
   * arithmetic did not even begin until the predecessor returned. A real queue can be reordered by
   * urgency and, critically, entries can be WITHDRAWN before they reach the wire.
   */
  private readonly queue: QueuedOperation[] = [];
  private inFlight = 0;
  private readsInFlight = 0;
  private scheduling = false;
  private seq = 0;

  private orderMutations = 0;
  private generalCalls = 0;
  private totalWaitMs = 0;
  private orderMutationWaitMs = 0;
  private generalWaitMs = 0;
  private absoluteFloorBinds = 0;
  private maxObservedWaitMs = 0;
  private abandonedBeforeDispatch = 0;
  private refusedAtDispatch = 0;
  private maxObservedQueueDepth = 0;
  private maxObservedInFlight = 0;
  private priorityOvertakes = 0;

  private readonly limits: TransportConcurrencyLimits;

  constructor(
    private pacing: EffectiveBrokerPacing,
    private readonly clock: { now: () => number; wait: (ms: number) => Promise<void> },
    limits: Partial<TransportConcurrencyLimits> = {},
  ) {
    this.limits = {
      maxInFlight: Math.max(1, Math.floor(limits.maxInFlight ?? DEFAULT_TRANSPORT_CONCURRENCY.maxInFlight)),
      // Never reserve so much that a non-recovery operation can never run at all.
      reservedForRecovery: Math.max(
        0,
        Math.min(
          Math.max(1, Math.floor(limits.maxInFlight ?? DEFAULT_TRANSPORT_CONCURRENCY.maxInFlight)) - 1,
          Math.floor(limits.reservedForRecovery ?? DEFAULT_TRANSPORT_CONCURRENCY.reservedForRecovery),
        ),
      ),
      maxConcurrentReads: Math.max(
        1,
        Math.floor(limits.maxConcurrentReads ?? DEFAULT_TRANSPORT_CONCURRENCY.maxConcurrentReads),
      ),
    };
  }

  /** The concurrency bounds in force, for diagnostics. */
  concurrencyLimits(): TransportConcurrencyLimits {
    return this.limits;
  }

  /** The pacing currently in force. */
  effective(): EffectiveBrokerPacing {
    return this.pacing;
  }

  /**
   * Replace the pacing in force, e.g. after a broker switch.
   *
   * Watermarks are deliberately RETAINED: the requests already sent still happened, and
   * resetting them would let a broker switch be used to issue an immediate unpaced burst.
   */
  repoint(pacing: EffectiveBrokerPacing): void {
    this.pacing = pacing;
  }

  stats(): TransportPacerStats {
    return {
      orderMutations: this.orderMutations,
      generalCalls: this.generalCalls,
      totalWaitMs: this.totalWaitMs,
      orderMutationWaitMs: this.orderMutationWaitMs,
      generalWaitMs: this.generalWaitMs,
      absoluteFloorBinds: this.absoluteFloorBinds,
      maxObservedWaitMs: this.maxObservedWaitMs,
      abandonedBeforeDispatch: this.abandonedBeforeDispatch,
      refusedAtDispatch: this.refusedAtDispatch,
      maxObservedQueueDepth: this.maxObservedQueueDepth,
      maxObservedInFlight: this.maxObservedInFlight,
      priorityOvertakes: this.priorityOvertakes,
    };
  }

  /** How many operations are waiting for a dispatch slot right now. */
  queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Run `operation` after serving its pacing wait.
   *
   * `klass` defaults to `"general"` so that a call site which forgets to classify itself is
   * paced by the SLOWER interval. Defaulting the other way would silently grant an
   * unclassified call the order-mutation rate.
   */
  run<T>(
    operation: () => Promise<T>,
    klass: BrokerPacingClass = "general",
    options: TransportRunOptions = {},
  ): Promise<T> {
    return this.submit(operation, klass, options).result;
  }

  /**
   * Enqueue `operation` and return a handle that can report on and WITHDRAW it.
   *
   * The handle is what makes a deadline honest. `run()` alone can only tell a caller "this
   * rejected"; it cannot say whether anything was transmitted. A caller that raced its own timeout
   * calls `abandon()`, and a `true` return is proof that the request never left.
   */
  submit<T>(
    operation: () => Promise<T>,
    klass: BrokerPacingClass = "general",
    options: TransportRunOptions = {},
  ): TransportSubmission<T> {
    const urgency = options.urgency ?? "read";
    const deadline = options.deadline ?? null;
    let settled = false;
    let resolveOuter: (value: T) => void = () => undefined;
    let rejectOuter: (error: unknown) => void = () => undefined;
    const result = new Promise<T>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });

    const entry: QueuedOperation = {
      seq: this.seq++,
      klass,
      urgency,
      deadline,
      beforeDispatch: options.beforeDispatch,
      operation: operation as () => Promise<unknown>,
      enqueuedAt: this.clock.now(),
      waitedMs: 0,
      state: "queued",
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        entry.state = "settled";
        if (outcome.ok) resolveOuter(outcome.value as T);
        else rejectOuter(outcome.error);
      },
    };

    // PRE-ADMISSION. An operation whose budget is already spent must not even take a queue slot,
    // let alone a dispatch slot ahead of something still viable.
    if (deadline?.expired()) {
      this.abandonedBeforeDispatch++;
      entry.settle({
        ok: false,
        error: new TransportRequestAbandonedError(
          "The request deadline had already expired before it could be dispatched; nothing was transmitted.",
          klass,
          0,
        ),
      });
      return this.handleFor(entry, result);
    }

    this.queue.push(entry);
    if (this.queue.length > this.maxObservedQueueDepth) this.maxObservedQueueDepth = this.queue.length;
    this.startScheduling();
    return this.handleFor(entry, result);
  }

  private handleFor<T>(entry: QueuedOperation, result: Promise<T>): TransportSubmission<T> {
    return {
      result,
      dispatched: () => entry.state !== "queued",
      abandon: (reason: string): boolean => {
        // Already on the wire (or already finished): the outcome is the broker's to decide and this
        // caller may not claim otherwise.
        if (entry.state !== "queued") return false;
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        this.abandonedBeforeDispatch++;
        entry.settle({
          ok: false,
          error: new TransportRequestAbandonedError(
            `${reason} The request was still queued and has been withdrawn; nothing was transmitted.`,
            entry.klass,
            Math.max(0, this.clock.now() - entry.enqueuedAt),
          ),
        });
        // A freed queue slot may let something else go now.
        this.startScheduling();
        return true;
      },
    };
  }

  private startScheduling(): void {
    if (this.scheduling) return;
    this.scheduling = true;
    void this.drainQueue().finally(() => {
      this.scheduling = false;
      // A late arrival during the final await would otherwise sit until the next `submit`.
      if (this.queue.length > 0 && this.canDispatchSomething()) this.startScheduling();
    });
  }

  private canDispatchSomething(): boolean {
    return this.pickNext() !== null;
  }

  /**
   * The dispatch loop.
   *
   * Note what it does NOT do: it never awaits `operation()`. It awaits only the PACING interval, so
   * the queue advances on the schedule the broker permits rather than on however long the previous
   * response happens to take. That single change is the fix for a slow read blocking a cancel.
   */
  private async drainQueue(): Promise<void> {
    for (;;) {
      this.refuseExpiredQueueEntries();
      const next = this.pickNext();
      if (!next) return;

      const now = this.clock.now();
      const classWait = pacingWaitMs({
        pacing: this.pacing,
        klass: next.klass,
        lastCallAt: next.klass === "order_mutation" ? this.lastOrderMutationAt : this.lastGeneralAt,
        now,
      });
      // The absolute floor uses the order-mutation interval as the tightest permissible gap
      // between ANY two transport calls, bounding total request rate.
      const absoluteWait = pacingWaitMs({
        pacing: this.pacing,
        klass: "order_mutation",
        lastCallAt: this.lastAnyCallAt,
        now,
      });
      const wait = Math.max(classWait, absoluteWait);

      if (wait > 0) {
        if (absoluteWait > classWait) this.absoluteFloorBinds++;
        // The sleep itself is bounded by the operation's own deadline, so a request cannot spend
        // its entire budget waiting for a slot and then be transmitted anyway.
        const slice = next.deadline ? Math.min(wait, Math.max(1, next.deadline.timerMs())) : wait;
        const before = this.clock.now();
        await this.clock.wait(slice);
        next.waitedMs += slice;
        const after = this.clock.now();
        // A clock that does not advance across a wait cannot express pacing at all (several suites
        // inject `wait: () => Promise.resolve()`). Dispatching is what the previous implementation
        // did in that case; re-evaluating instead would spin forever.
        if (after > before) continue;
      }

      if (next.deadline?.expired()) {
        this.refuseExpired(next);
        continue;
      }
      this.dispatch(next, next.waitedMs);
    }
  }

  /**
   * The most urgent operation that may run right now, or null.
   *
   * Ties break on arrival order, so within a tier the queue is still FIFO and nothing starves.
   */
  private pickNext(): QueuedOperation | null {
    if (this.queue.length === 0) return null;
    if (this.inFlight >= this.limits.maxInFlight) return null;

    const ordered = [...this.queue].sort((a, b) => {
      const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
      return byUrgency !== 0 ? byUrgency : a.seq - b.seq;
    });

    for (const candidate of ordered) {
      if (candidate.state !== "queued") continue;
      if (candidate.urgency === "read" && this.readsInFlight >= this.limits.maxConcurrentReads) continue;
      // Everything except recovery must leave the reserve alone.
      if (
        candidate.urgency !== "recovery" &&
        this.limits.maxInFlight - this.inFlight <= this.limits.reservedForRecovery
      ) {
        continue;
      }
      // Diagnostics: did urgency let this jump an older entry?
      const oldestQueued = ordered.reduce<QueuedOperation | null>(
        (best, item) => (item.state === "queued" && (best === null || item.seq < best.seq) ? item : best),
        null,
      );
      if (oldestQueued && oldestQueued !== candidate) this.priorityOvertakes++;
      return candidate;
    }
    return null;
  }

  private refuseExpiredQueueEntries(): void {
    // Iterate over a copy: `refuseExpired` mutates the queue.
    for (const entry of [...this.queue]) {
      if (entry.state === "queued" && entry.deadline?.expired()) this.refuseExpired(entry);
    }
  }

  /**
   * Refuse an operation whose deadline passed while it was QUEUED.
   *
   * It is removed rather than left in place, and `operation()` is never called. The watermarks are
   * NOT stamped and no budget is charged, because nothing was sent — an abandoned operation
   * consumed none of the broker's capacity and must not be accounted as if it had.
   */
  private refuseExpired(entry: QueuedOperation): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    this.abandonedBeforeDispatch++;
    entry.settle({
      ok: false,
      error: new TransportRequestAbandonedError(
        "The request deadline expired while it was queued behind broker pacing; nothing was transmitted.",
        entry.klass,
        Math.max(0, this.clock.now() - entry.enqueuedAt),
      ),
    });
  }

  private dispatch(entry: QueuedOperation, wait: number): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);

    // DISPATCH-TIME ADMISSION (the rate budget). A throw here is a proven no-request, so — exactly
    // as for an expired entry — no watermark is stamped and no spend is recorded.
    if (entry.beforeDispatch) {
      try {
        entry.beforeDispatch();
      } catch (error) {
        this.refusedAtDispatch++;
        entry.settle({ ok: false, error });
        return;
      }
    }

    entry.state = "dispatched";
    const at = this.clock.now();
    this.lastAnyCallAt = at;
    if (entry.klass === "order_mutation") {
      this.lastOrderMutationAt = at;
      this.orderMutations++;
      this.orderMutationWaitMs += wait;
    } else {
      this.lastGeneralAt = at;
      this.generalCalls++;
      this.generalWaitMs += wait;
    }
    this.totalWaitMs += wait;
    if (wait > this.maxObservedWaitMs) this.maxObservedWaitMs = wait;

    this.inFlight++;
    if (entry.urgency === "read") this.readsInFlight++;
    if (this.inFlight > this.maxObservedInFlight) this.maxObservedInFlight = this.inFlight;

    const release = (): void => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      if (entry.urgency === "read") this.readsInFlight = Math.max(0, this.readsInFlight - 1);
      // A completed call frees a slot; something may now be dispatchable.
      this.startScheduling();
    };

    let running: Promise<unknown>;
    try {
      running = entry.operation();
    } catch (error) {
      // A synchronous throw from the operation itself. It was invoked, so it counts as dispatched.
      entry.settle({ ok: false, error });
      release();
      return;
    }
    Promise.resolve(running).then(
      (value) => {
        entry.settle({ ok: true, value });
        release();
      },
      (error: unknown) => {
        entry.settle({ ok: false, error });
        release();
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// MULTI-WINDOW ORDER BUDGETS, ENDPOINT CLASSES, AND RESERVED RECOVERY CAPACITY  (Task 8)
//
// The min-interval above bounds the PER-SECOND rate only. A broker also enforces per-minute,
// per-hour and per-day order caps, plus a per-order modification cap. This section models all
// of them as a pure, injected-clock ledger so admission can refuse an entry that WOULD clear
// the 100ms gap but would breach a longer window — and, crucially, so a RESERVE is always held
// back for the protective cancels and exposure-reducing orders that recover an existing box.
//
// A DELIBERATE NON-GOAL: this ledger accounts only for the requests THIS application makes. It
// CANNOT observe requests made by unrelated applications sharing the same broker account (a
// mobile app, a second algo, a manual dealer terminal). That blind spot is exposed on the
// reporting surface ({@link RateBudgetSnapshot.external_consumers_unobservable}) and reduced —
// but never eliminated — by declaring how many of OUR OWN workers share the budget.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The endpoint class a request belongs to, at the granularity the brokers actually meter.
 *
 * Both Zerodha and Dhan meter ORDER endpoints separately from DATA/quote endpoints, and both
 * cap MODIFICATIONS per order. We keep place / modify / cancel distinct even though they share
 * the order-per-second bucket, because modification has its own per-order cap and because a
 * CANCEL is the recovery operation we must never starve.
 */
export type BrokerEndpointClass = "order_place" | "order_modify" | "order_cancel" | "data_read";

/** True for the three classes that consume the broker's ORDER rate budget. */
export function isOrderEndpoint(klass: BrokerEndpointClass): boolean {
  return klass === "order_place" || klass === "order_modify" || klass === "order_cancel";
}

/**
 * One rolling-window budget: a maximum count over a fixed span.
 *
 * `limit === null` means the broker publishes this window as UNLIMITED (e.g. Dhan's per-minute
 * quote budget). Null is NOT zero and NOT "unknown": it is an explicit "no cap at this window",
 * so the ledger skips it rather than refusing everything.
 */
export interface RateWindow {
  readonly spanMs: number;
  /** Max requests in the span, or null for an explicitly unlimited window. */
  readonly limit: number | null;
}

/**
 * The full published order-rate limits for one broker, per window.
 *
 * Every figure carries its source URL and the date it was verified, so a stale constant is
 * self-identifying rather than a silent assumption. `confirmed` distinguishes a figure taken
 * verbatim from official developer documentation from one we could only INFER or take
 * conservatively; an unconfirmed figure must always be the conservative (smaller) choice.
 */
export interface BrokerRateLimits {
  readonly broker: BrokerId;
  readonly perSecond: RateWindow;
  readonly perMinute: RateWindow;
  readonly perHour: RateWindow;
  readonly perDay: RateWindow;
  /** Max modifications per single order before it must be cancelled and re-placed. */
  readonly maxModificationsPerOrder: number;
  /** The exact official source URL each figure above was read from. */
  readonly sourceUrl: string;
  /** ISO date the figures were last checked against the source. */
  readonly verifiedOn: string;
  /** True only when every window was read verbatim from official developer docs. */
  readonly confirmed: boolean;
  /** Figures that could NOT be confirmed from an official source, if any. */
  readonly unconfirmedNotes: readonly string[];
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Published ORDER-endpoint rate limits, verified 2026-09-09.
 *
 * These are the authoritative constants the admission gate and the diagnostics endpoint share.
 * They are frozen so no code path can widen a limit at runtime without an explicit, reviewable
 * edit here (the task's "no widening without an economic bound and a cited justification" rule
 * is enforced by making every widening a diff against this table).
 */
export const BROKER_RATE_LIMITS: Readonly<Record<BrokerId, BrokerRateLimits>> = Object.freeze({
  zerodha: Object.freeze({
    broker: "zerodha" as const,
    perSecond: Object.freeze({ spanMs: SECOND, limit: 10 }),
    perMinute: Object.freeze({ spanMs: MINUTE, limit: 400 }),
    // Kite publishes no explicit per-hour order cap; the day cap governs. Null = no such window.
    perHour: Object.freeze({ spanMs: HOUR, limit: null }),
    perDay: Object.freeze({ spanMs: DAY, limit: 5_000 }),
    maxModificationsPerOrder: 25,
    sourceUrl: "https://kite.trade/docs/connect/v3/exceptions/#api-rate-limit",
    verifiedOn: "2026-09-09",
    confirmed: true,
    unconfirmedNotes: Object.freeze([
      "Kite documents no explicit per-hour order cap; per-hour is modelled as unlimited and the " +
        "400/min and 5000/day caps govern instead.",
    ]),
  }),
  dhan: Object.freeze({
    broker: "dhan" as const,
    perSecond: Object.freeze({ spanMs: SECOND, limit: 10 }),
    perMinute: Object.freeze({ spanMs: MINUTE, limit: 250 }),
    perHour: Object.freeze({ spanMs: HOUR, limit: 1_000 }),
    perDay: Object.freeze({ spanMs: DAY, limit: 7_000 }),
    maxModificationsPerOrder: 25,
    sourceUrl: "https://dhanhq.co/docs/v2/",
    verifiedOn: "2026-09-09",
    confirmed: true,
    unconfirmedNotes: Object.freeze([
      "A Dhan customer-support FAQ (dhan.co) quotes a higher 25 orders/second, 250/minute figure " +
        "that conflicts with the DhanHQ v2 developer docs' 10/second, 250/minute. The stricter " +
        "developer-doc figure (10/s) is used, since guessing upward is the only direction that " +
        "earns a real 429 on a real order.",
    ]),
  }),
});

/** The published limits for a broker id, defaulting to the STRICTEST known limits. */
export function brokerRateLimits(broker: BrokerId | string): BrokerRateLimits {
  const key = typeof broker === "string" ? broker.trim().toLowerCase() : broker;
  if (key === "zerodha") return BROKER_RATE_LIMITS.zerodha;
  if (key === "dhan") return BROKER_RATE_LIMITS.dhan;
  return strictestRateLimits();
}

/** The minimum non-null limit across brokers for each window — the fail-closed choice. */
function strictestRateLimits(): BrokerRateLimits {
  const all = [BROKER_RATE_LIMITS.zerodha, BROKER_RATE_LIMITS.dhan];
  const strictest = (pick: (l: BrokerRateLimits) => RateWindow): RateWindow => {
    const limits = all.map(pick).map((w) => w.limit).filter((n): n is number => n !== null);
    // If EVERY broker leaves this window unlimited, keep it unlimited; otherwise take the min.
    return { spanMs: pick(all[0]!).spanMs, limit: limits.length ? Math.min(...limits) : null };
  };
  return {
    broker: "zerodha",
    perSecond: strictest((l) => l.perSecond),
    perMinute: strictest((l) => l.perMinute),
    perHour: strictest((l) => l.perHour),
    perDay: strictest((l) => l.perDay),
    maxModificationsPerOrder: Math.min(...all.map((l) => l.maxModificationsPerOrder)),
    sourceUrl: "(fallback: strictest of all known brokers)",
    verifiedOn: "2026-09-09",
    confirmed: false,
    unconfirmedNotes: Object.freeze([
      "Unrecognised broker id: using the strictest limit across all known brokers for every " +
        "window, because an unknown broker is exactly where its published limits are least certain.",
    ]),
  };
}

/**
 * How the order budget is shared and reserved.
 *
 * `workerCount` is the number of THIS application's processes/consumers that place orders on the
 * SAME broker account. The effective budget one worker may use is the published budget divided
 * by the worker count, because the broker meters the account, not the process. Defaulting to 1
 * matches the deployment described in the task (one active box), but a value must be settable
 * from config later — see HANDOFF.
 *
 * `recoveryReserveFraction` is the fraction of each window's budget that entry PLACEMENT may not
 * touch, so that protective cancels and exposure-reducing orders always have room. It applies to
 * placement only: a cancel or a modify that reduces exposure may spend into the reserve, because
 * the reserve exists FOR them.
 */
export interface OrderBudgetPolicy {
  readonly workerCount: number;
  readonly recoveryReserveFraction: number;
}

export const DEFAULT_ORDER_BUDGET_POLICY: OrderBudgetPolicy = Object.freeze({
  workerCount: 1,
  // A four-leg box needs at most four cancels to unwind, so reserving ~20% of even the tightest
  // window (10/s ⇒ 2 slots, 400/min ⇒ 80 slots) always covers a full protective unwind. This is
  // the explicit economic bound the task requires for the reserve: reserve >= max legs to cancel.
  recoveryReserveFraction: 0.2,
});

/** Resolve a budget policy, clamping nonsense values into a safe range. */
export function resolveOrderBudgetPolicy(overrides?: Partial<OrderBudgetPolicy>): OrderBudgetPolicy {
  const workers = overrides?.workerCount;
  const reserve = overrides?.recoveryReserveFraction;
  return {
    workerCount:
      Number.isFinite(workers) && (workers as number) >= 1 ? Math.floor(workers as number) : 1,
    // Clamp to [0, 0.5]: a reserve of more than half the budget would starve placement entirely,
    // which is not the intent — the reserve protects recovery, it does not forbid entry.
    recoveryReserveFraction:
      Number.isFinite(reserve) && (reserve as number) >= 0 && (reserve as number) <= 0.5
        ? (reserve as number)
        : DEFAULT_ORDER_BUDGET_POLICY.recoveryReserveFraction,
  };
}

/** The per-window budget one worker may use for PLACEMENT, after sharing and reserve. */
export interface PlacementBudget {
  readonly window: "perSecond" | "perMinute" | "perHour" | "perDay";
  readonly spanMs: number;
  /** Published account-wide limit for the window, or null when unlimited. */
  readonly accountLimit: number | null;
  /** Limit after dividing by workerCount (still includes the reserve). */
  readonly perWorkerLimit: number | null;
  /** Slots a single worker may spend on ENTRY PLACEMENT — perWorkerLimit minus the reserve. */
  readonly placementLimit: number | null;
  /** Slots held back for recovery (cancel / exposure reduction). */
  readonly recoveryReserve: number;
}

/**
 * Compute the placement budgets for every window, given a broker and a policy.
 *
 * The reserve is computed per window and rounded UP (`ceil`) so a partial slot always favours
 * recovery over placement — erring toward being able to protect exposure.
 */
export function placementBudgets(
  limits: BrokerRateLimits,
  policy: OrderBudgetPolicy = DEFAULT_ORDER_BUDGET_POLICY,
): PlacementBudget[] {
  const windows: { key: PlacementBudget["window"]; win: RateWindow }[] = [
    { key: "perSecond", win: limits.perSecond },
    { key: "perMinute", win: limits.perMinute },
    { key: "perHour", win: limits.perHour },
    { key: "perDay", win: limits.perDay },
  ];
  return windows.map(({ key, win }) => {
    if (win.limit === null) {
      return {
        window: key,
        spanMs: win.spanMs,
        accountLimit: null,
        perWorkerLimit: null,
        placementLimit: null,
        recoveryReserve: 0,
      };
    }
    const perWorker = Math.max(0, Math.floor(win.limit / Math.max(1, policy.workerCount)));
    const reserve = Math.ceil(perWorker * policy.recoveryReserveFraction);
    return {
      window: key,
      spanMs: win.spanMs,
      accountLimit: win.limit,
      perWorkerLimit: perWorker,
      placementLimit: Math.max(0, perWorker - reserve),
      recoveryReserve: reserve,
    };
  });
}

/** The outcome of asking the ledger whether one more request of a class may proceed. */
export interface BudgetDecision {
  readonly allowed: boolean;
  /** The window that BOUND the decision when refused, else null. */
  readonly bindingWindow: PlacementBudget["window"] | null;
  /** Human-readable reason, always populated. */
  readonly reason: string;
  /** Suggested earliest retry time (epoch ms) when refused for a window, else null. */
  readonly retryAtMs: number | null;
}

/**
 * A rolling-window budget ledger for ONE broker account, from ONE worker's point of view.
 *
 * Records every ORDER request this worker makes with its timestamp and class, and answers
 * "may I place / modify / cancel now?" against all published windows at once. Recovery
 * operations (cancel, exposure-reducing modify) are allowed to spend into the reserve;
 * entry placement is not.
 *
 * COOLDOWN / Retry-After: when the broker returns a 429 with a Retry-After, {@link penalize}
 * records a hard cooldown until that instant. While cooling down, ALL order requests are
 * refused — a 429 means the account is over budget in a way our own count did not predict
 * (most likely an unobservable external consumer), so backing off entirely is the only safe
 * response. Recovery is still permitted to be QUEUED but must also wait out the cooldown,
 * because sending more requests into a 429 only deepens it.
 *
 * WHAT THIS LEDGER MUST NEVER DO: it never decides to RESEND a mutation. A 429 or transport
 * error tells us a request may or may not have reached the matching engine; replaying it could
 * double an order. The ledger only gates NEW requests and the caller's idempotency layer owns
 * whether a given request has already been durably attempted.
 */
export class RateBudgetLedger {
  /** Order-request timestamps (epoch ms), oldest first. Pruned to the longest window. */
  private readonly placementTimes: number[] = [];
  private readonly recoveryTimes: number[] = [];
  /** Cooldown-until (epoch ms) set by a Retry-After. Number.NEGATIVE_INFINITY = none. */
  private cooldownUntil = Number.NEGATIVE_INFINITY;
  private penalties = 0;
  private placementRefusals = 0;
  private recoveryRefusals = 0;

  constructor(
    private limits: BrokerRateLimits,
    private policy: OrderBudgetPolicy = DEFAULT_ORDER_BUDGET_POLICY,
  ) {}

  /** The longest finite window span, for pruning. */
  private horizonMs(): number {
    const spans = [this.limits.perSecond, this.limits.perMinute, this.limits.perHour, this.limits.perDay]
      .filter((w) => w.limit !== null)
      .map((w) => w.spanMs);
    return spans.length ? Math.max(...spans) : DAY;
  }

  private prune(now: number): void {
    const cutoff = now - this.horizonMs();
    for (const arr of [this.placementTimes, this.recoveryTimes]) {
      while (arr.length > 0 && arr[0]! <= cutoff) arr.shift();
    }
  }

  /** Count timestamps within `spanMs` of `now`, across both placement and recovery. */
  private countWithin(spanMs: number, now: number): number {
    const cutoff = now - spanMs;
    let n = 0;
    for (const t of this.placementTimes) if (t > cutoff) n++;
    for (const t of this.recoveryTimes) if (t > cutoff) n++;
    return n;
  }

  /**
   * Would one more request of `klass` breach a window right now?
   *
   * Placement is checked against `placementLimit` (published − share − reserve). Recovery is
   * checked against `perWorkerLimit` (published − share, NO reserve subtracted), so the reserve
   * is exactly the headroom recovery gets that placement does not.
   */
  /**
   * @param opts.protective  This mutation REDUCES risk (an exit, an emergency residual unwind, a
   *   protective cancel), so it may draw on the recovery reserve even though the broker meters it as
   *   a placement.
   *
   *   WHY THIS PARAMETER EXISTS. Eligibility for the reserve used to be inferred purely from the
   *   BROKER'S endpoint class: `order_cancel` and `order_modify` got the reserve, everything else did
   *   not. But "which endpoint the broker meters" and "does this order add or remove risk" are
   *   different questions, and only the second one should decide who may spend the reserve. An
   *   emergency buyback that closes a naked short is a `POST /orders` like any other, so it was
   *   refused with reserved capacity sitting unused — at exactly the moment the reserve existed for.
   */
  check(klass: BrokerEndpointClass, now: number, opts?: { protective?: boolean }): BudgetDecision {
    if (!isOrderEndpoint(klass)) {
      return { allowed: true, bindingWindow: null, reason: "data read: not order-budget metered", retryAtMs: null };
    }
    if (now < this.cooldownUntil) {
      return {
        allowed: false,
        bindingWindow: null,
        reason: `broker cooldown active (Retry-After) until ${this.cooldownUntil}`,
        retryAtMs: this.cooldownUntil,
      };
    }
    this.prune(now);
    // RISK PURPOSE, not endpoint class, decides reserve eligibility. Cancel/modify are protective by
    // nature; a placement is protective only when the caller proves it reduces exposure.
    const isRecovery = klass === "order_cancel" || klass === "order_modify" || opts?.protective === true;
    const budgets = placementBudgets(this.limits, this.policy);
    for (const b of budgets) {
      if (b.accountLimit === null) continue;
      const ceiling = isRecovery ? b.perWorkerLimit : b.placementLimit;
      if (ceiling === null) continue;
      const used = this.countWithin(b.spanMs, now);
      if (used >= ceiling) {
        return {
          allowed: false,
          bindingWindow: b.window,
          reason:
            `${klass} would breach the ${b.window} budget: ${used}/${ceiling} used` +
            (isRecovery
              ? ` (recovery ceiling, reserve included${opts?.protective ? "; protective placement" : ""})`
              : " (placement ceiling, reserve withheld)"),
          // Earliest the oldest in-window request ages out.
          retryAtMs: this.oldestInWindow(b.spanMs, now) + b.spanMs,
        };
      }
    }
    return { allowed: true, bindingWindow: null, reason: "within all published windows", retryAtMs: null };
  }

  private oldestInWindow(spanMs: number, now: number): number {
    const cutoff = now - spanMs;
    let oldest = now;
    for (const arr of [this.placementTimes, this.recoveryTimes]) {
      for (const t of arr) if (t > cutoff && t < oldest) oldest = t;
    }
    return oldest;
  }

  /**
   * Record that a request of `klass` was actually sent at `now`.
   *
   * MUST be called only after {@link check} allowed it and the request was durably attempted —
   * recording a request that never went out would make the ledger over-count and needlessly
   * refuse real capacity. Data reads are ignored (not order-metered).
   */
  record(klass: BrokerEndpointClass, now: number): void {
    if (!isOrderEndpoint(klass)) return;
    if (klass === "order_cancel" || klass === "order_modify") this.recoveryTimes.push(now);
    else this.placementTimes.push(now);
    this.prune(now);
  }

  /**
   * Apply a broker throttle signal (a 429). `retryAfterMs` comes from the Retry-After header;
   * when absent the broker gave no hint and we apply a conservative default cooldown of one
   * per-second window, which is the minimum a 429 can mean.
   */
  penalize(now: number, retryAfterMs: number | null): void {
    const cooldown =
      Number.isFinite(retryAfterMs) && (retryAfterMs as number) > 0
        ? (retryAfterMs as number)
        : this.limits.perSecond.spanMs;
    const until = now + cooldown;
    // Never SHORTEN an existing cooldown — a second 429 during a cooldown extends, never resets.
    if (until > this.cooldownUntil) this.cooldownUntil = until;
    this.penalties++;
  }

  /** True while a Retry-After cooldown is in force. */
  inCooldown(now: number): boolean {
    return now < this.cooldownUntil;
  }

  /** A bounded, low-cardinality snapshot for diagnostics. */
  snapshot(now: number): RateBudgetSnapshot {
    this.prune(now);
    const budgets = placementBudgets(this.limits, this.policy);
    return {
      broker: this.limits.broker,
      verified_on: this.limits.verifiedOn,
      source_url: this.limits.sourceUrl,
      confirmed: this.limits.confirmed,
      worker_count: this.policy.workerCount,
      recovery_reserve_fraction: this.policy.recoveryReserveFraction,
      windows: budgets.map((b) => ({
        window: b.window,
        account_limit: b.accountLimit,
        per_worker_limit: b.perWorkerLimit,
        placement_limit: b.placementLimit,
        recovery_reserve: b.recoveryReserve,
        used: b.accountLimit === null ? null : this.countWithin(b.spanMs, now),
      })),
      cooldown_active: this.inCooldown(now),
      cooldown_until: this.inCooldown(now) ? this.cooldownUntil : null,
      penalties: this.penalties,
      placement_refusals: this.placementRefusals,
      recovery_refusals: this.recoveryRefusals,
      // THE LIMITATION, stated in the reporting surface itself: we cannot see requests made by
      // unrelated apps on the same account. Operational coordination is required.
      external_consumers_unobservable: true,
      external_consumers_note:
        "This ledger counts only THIS application's own order requests. Requests made by other " +
        "apps, dealer terminals or a second algo on the same broker account are invisible to it. " +
        "A 429 despite an in-budget local count is the expected symptom; operators MUST coordinate " +
        "so no unrelated consumer shares this account during live trading.",
    };
  }

  /** Record a refusal for the snapshot counters (called by the caller on a refused check). */
  noteRefusal(klass: BrokerEndpointClass): void {
    if (klass === "order_cancel" || klass === "order_modify") this.recoveryRefusals++;
    else this.placementRefusals++;
  }
}

/** The diagnostics projection of a ledger. Bounded and low-cardinality. */
export interface RateBudgetSnapshot {
  readonly broker: BrokerId;
  readonly verified_on: string;
  readonly source_url: string;
  readonly confirmed: boolean;
  readonly worker_count: number;
  readonly recovery_reserve_fraction: number;
  readonly windows: readonly {
    readonly window: PlacementBudget["window"];
    readonly account_limit: number | null;
    readonly per_worker_limit: number | null;
    readonly placement_limit: number | null;
    readonly recovery_reserve: number;
    readonly used: number | null;
  }[];
  readonly cooldown_active: boolean;
  readonly cooldown_until: number | null;
  readonly penalties: number;
  readonly placement_refusals: number;
  readonly recovery_refusals: number;
  readonly external_consumers_unobservable: boolean;
  readonly external_consumers_note: string;
}

/**
 * Parse a Retry-After header value into milliseconds.
 *
 * HTTP allows Retry-After to be either delta-seconds (an integer) or an HTTP-date. Returns null
 * when the value is absent or unparseable, so the caller applies its own conservative default
 * rather than treating garbage as "retry immediately".
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, now: number): number | null {
  if (headerValue === null || headerValue === undefined) return null;
  const raw = headerValue.trim();
  if (raw === "") return null;
  // delta-seconds form.
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1_000 : null;
  }
  // HTTP-date form.
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return null;
  const delta = when - now;
  // A past date means "retry now"; clamp to 0 rather than returning a negative cooldown.
  return delta > 0 ? delta : 0;
}

/**
 * Whether a caught error/response means "the broker threw this request away for rate reasons".
 *
 * This is the ONLY sanctioned use of a rate-limit signal: to (a) trigger a cooldown and (b) tell
 * the caller NOT to count the request as sent. It must NEVER be interpreted as "safe to resend":
 * a 429 tells us nothing about whether the matching engine saw the order.
 */
export function isRateLimited(status: number | null | undefined): boolean {
  return status === 429;
}
