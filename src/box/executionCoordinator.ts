/**
 * BOX EXECUTION COORDINATION — one contract, one execution at a time, ACROSS WORKERS.
 *
 * THE PROBLEM, CONCRETELY
 * Every duplicate guard in this engine is keyed on the strike pair
 * (`underlying|expiry|K1|K2|DIRECTION`). A 1300/1320 box and a 1320/1340 box are
 * therefore treated as unrelated, even though both trade the 1320 strike. Nothing
 * stopped them submitting in the same instant, each assuming the FULL displayed size
 * resting at 1320. Real closed-trade history shows exactly that: overlapping-strike
 * pairs opened in the same second. In paper it overstates achievable fills, because
 * the same resting lot is spent twice.
 *
 * That guard used to be process-local. Under PM2 cluster mode, several workers, two
 * EC2 instances or Kubernetes replicas, each process owned a separate in-memory Map:
 * both saw RELIANCE 2550CE as free, both reserved it, both sent an order. The
 * reservation store is now CHAINED — a free in-process filter in front of a durable
 * MongoDB authority — so exclusion holds deployment-wide. See
 * `reservations/durable.ts` for why a single-document insert against a unique
 * multikey index makes a four-leg claim atomic.
 *
 * WHERE THIS SITS, AND WHY THERE
 * It decorates `BoxExecutionGateway` — the interface where, and only where, the
 * paper/live branch happens. That placement is the whole design:
 *
 *   scanner / monitor  ->  THIS  ->  CentralBoxExecutionGateway  ->  paper | live
 *
 * so paper gets no shortcut around coordination. Paper realism is the reason to
 * insist on that: a simulator that lets two boxes consume one lot is not modelling
 * anything real. It also means the scanner and monitor need no changes at all, and
 * none of this lands in the already-oversized engine.ts.
 *
 * WHY NOT A SLEEP
 * A fixed `await sleep(250)` before every second execution would be both wrong and
 * slow: wrong because it does not actually establish exclusion, and slow because the
 * dislocation is usually gone. The loser of a conflict instead registers for the
 * winner's release and is woken by it — typically within a millisecond — then
 * REPRICES against the current book before it is allowed to proceed.
 *
 * WAITING IS NOW HYBRID, BECAUSE IT HAS TO BE
 * `onRelease` is an in-memory emitter: it can only ever observe a release by THIS
 * process. A contract held by a sibling worker will never fire it. So the wait races
 * the release event against a short jittered timer and retries the acquisition —
 * event-driven where that works, bounded polling where it cannot. The jitter matters:
 * without it several workers freed by the same release would retry in lockstep and
 * hammer the authority in a thundering herd. Every path stays bounded by
 * `BOX_CONFLICT_WAIT_MAX_MS`; there are no unbounded waits.
 *
 * TTL IS NOT EXECUTION PERMISSION
 * The dangerous sequence is: this worker stalls on GC, its lease expires, another
 * worker legitimately takes the contracts, this worker wakes up and submits another
 * leg. Local state saying "running" is not good enough. So ownership is re-checked
 * at every point where it can be:
 *
 *   • a heartbeat RENEWS the lease and, on failure, records a safety event and trips
 *     `invariantViolation` rather than carrying on;
 *   • `stillWanted` — which the simulator already consults before each leg — is
 *     COMPOSED with a synchronous ownership predicate, so ownership loss aborts the
 *     remaining legs of a paper legging run through the existing abort path;
 *   • immediately before delegating, the broker generation is re-checked, and the
 *     durable lease is re-verified whenever the execution waited.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not serialise unrelated boxes. Two boxes sharing no contract never wait on
 * each other; there is no global execution mutex and no per-underlying lock —
 * RELIANCE 2500CE and RELIANCE 2800CE are independent. And it does not net opposite
 * sides internally: that needs the ledger to represent virtual ownership of both
 * boxes while broker net exposure is zero, which has not been proven, so the safe
 * path (serialise, confirm, re-evaluate) is taken for both same-side and
 * opposite-side overlaps.
 */

import { entrySideFor, evaluateCandidate } from "./math.js";
import {
  boxInstrumentRefs,
  classifyConflict,
  keysOf,
  type InstrumentConflict,
  type InstrumentLegRef,
} from "./instrumentKey.js";
import {
  evaluateUnderlyingAdmission,
  underlyingLegRef,
  UNDERLYING_ALREADY_ACTIVE_REASON,
  type UnderlyingActivity,
} from "./underlyingLock.js";
// Imported from the LEAF modules rather than the `instrumentReservations.js` barrel on
// purpose: the barrel re-exports the Mongo adapter, and the coordinator has no business
// pulling mongoose into its module graph just to name a type.
import { BoundedSamples } from "./reservations/types.js";
import { createProcessIdentity, mintOwnerId } from "./reservations/identity.js";
import type { ProcessIdentity } from "./reservations/identity.js";
import type {
  InstrumentReservationStore,
  RenewOutcome,
  ReservationContext,
  ReservationDurability,
  ReservationLease,
  ReservationStoreDiagnostics,
  ReservationWaitable,
} from "./reservations/types.js";
import type { BoxExecutionGateway } from "./executionGateway.js";
import type { BoxConfig } from "./config.js";
import type { BoxQuoteStore } from "./quotes.js";
import type { BoxExecutionSimulator } from "./executionSimulator.js";
import {
  BOX_LEG_ROLES,
  type BoxCandidate,
  type BoxDirection,
  type BoxEvaluation,
  type BoxExecutionFailureReason,
  type BoxLegRole,
  type BoxOptionInstrument,
  type OrderSide,
  type PaperLeggingExecutionRecord,
} from "./types.js";

/**
 * Coordination outcome for one execution, extending the observational vocabulary
 * rather than the durable `BoxOrderIntentState` (which is enforced as a Mongo
 * predecessor guard, so widening it would need a migration).
 */
export type CoordinationState =
  | "RESERVED"
  | "WAITING_FOR_INSTRUMENT"
  | "REVALIDATING"
  | "EXECUTING"
  | "ABORTED_DETERIORATED"
  | "EXPIRED_WHILE_WAITING"
  | "SUPPRESSED_DUPLICATE"
  | "REFUSED_NO_COORDINATION"
  /** The durable authority could not be reached, so a live entry was refused. */
  | "REFUSED_DURABLE_UNAVAILABLE"
  /** The lease was lost mid-execution. An invariant violation, not a retry. */
  | "OWNERSHIP_LOST"
  /** The broker or its generation moved on while this execution was coordinating. */
  | "ABORTED_STALE_GENERATION";

/**
 * A machine-greppable token that leads the detail of a fail-closed refusal, so an
 * operator (and the execution-attempts ledger) can find these without parsing prose.
 */
export const DURABLE_UNAVAILABLE_REASON = "durable_reservation_unavailable";
export const STALE_GENERATION_REASON = "stale_broker_generation";

export interface CoordinatorMetricsSnapshot {
  activeExecutions: number;
  activeInstrumentReservations: number;
  waitingExecutions: number;
  reservationConflicts: number;
  duplicateSuppressed: number;
  /** Entries refused because the underlying is on the operator blocklist, or it was unreadable. */
  underlyingExcluded: number;
  /** Entries refused because `BOX_MAX_OPEN_BOXES` (all modes) was already met. */
  inventoryLimitRefusals: number;
  expiredWhileWaiting: number;
  revalidationRejected: number;
  revalidationPassed: number;
  reservationsHeldOnUncertainty: number;
  failedClosed: number;
  waitMs: { p50: number | null; p95: number | null; samples: number };
  /** Retained names, so existing consumers and the frontend keep working. */
  store: string;
  durable: boolean;

  /* ---- durable-tier health. Counts, statuses and percentiles only: never an
   * execution id, instrument token, symbol or order id. ---- */
  reservationStore: string;
  reservationDurability: ReservationDurability;
  durableReservationsEnabled: boolean;
  durableReady: boolean;
  requireDurable: boolean;
  durableAcquireAttempts: number;
  durableAcquireSuccess: number;
  durableConflicts: number;
  durableErrors: number;
  durableAcquireLatencyP50: number | null;
  durableAcquireLatencyP95: number | null;
  durableAcquireLatencyP99: number | null;
  reservationRenewSuccess: number;
  reservationRenewFailure: number;
  reservationOwnershipLost: number;
  expiredReservationsObserved: number;
  /** Live entries refused because the authority was unreachable. */
  durableUnavailableRefusals: number;
  /** Paper executions that proceeded on the local tier alone, and said so. */
  localOnlyFallbacks: number;
  staleGenerationAborts: number;
  /** Reservations still held because a terminal broker state was unresolved. */
  uncertainHoldsActive: number;
  /** Uncertain holds that hit their bound and were left to expire. */
  uncertainHoldsAbandoned: number;
  clockOffsetMs: number | null;
}

/** The richer, operator-facing view. May contain a (scrubbed) error message. */
export interface CoordinationHealthSnapshot {
  enabled: boolean;
  localStore: string;
  durableStore: string | null;
  durableReady: boolean;
  requireDurable: boolean;
  /** True when LIVE Box ENTRY is currently refused for safety. */
  liveEntryBlocked: boolean;
  liveEntryBlockedReason: string | null;
  deployment: string;
  broker: string;
  generation: number;
  activeReservations: number;
  ownershipLosses: number;
  acquireP50Ms: number | null;
  acquireP95Ms: number | null;
  acquireP99Ms: number | null;
  durableLastError: string | null;
  tiers: ReservationStoreDiagnostics[];
}

export interface CoordinatorLogFields {
  execution: string;
  broker: string;
  underlying: string;
  status: string;
  [extra: string]: string | number | boolean | null;
}

export interface CoordinatorDeps {
  /** The real gateway. Every call is delegated once coordination succeeds. */
  inner: BoxExecutionGateway;
  /** The chain: in-process filter plus (when configured) the durable authority. */
  reservations: InstrumentReservationStore;
  /**
   * The in-process tier on its own.
   *
   * Needed for the explicitly-marked paper fallback: when the durable authority is
   * unreachable, paper may still coordinate locally, and doing so requires bypassing
   * the chain that (correctly) refuses.
   */
  local?: InstrumentReservationStore;
  /** Present only when a tier supports event-driven wakeups. */
  waitable?: ReservationWaitable;
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  broker: () => string;
  /** Broker generation. Bumped on every switch; stamped on every durable lease. */
  generation?: () => number;
  /** Process/deployment identity. Generated once at startup. */
  identity?: ProcessIdentity;
  /**
   * LAYER 1a of the underlying lock: underlyings that currently carry, or may carry,
   * attributable Box exposure — derived from DURABLE state (open/partial/recovery positions,
   * unresolved residual legs, unresolved order intents).
   *
   * SYNCHRONOUS BY CONTRACT, for two reasons. It is consulted inside `coordinateEntry`'s
   * synchronous prologue, where an `await` would reintroduce the exact TOCTOU that prologue
   * exists to prevent. And it must reflect state reconstructed from Mongo at boot, so the lock
   * survives a restart rather than depending on a lease that can expire.
   */
  activeUnderlyings?: () => ReadonlyMap<string, UnderlyingActivity>;
  /**
   * The armed trading session's ENTRY verdict (`BOX_SESSION_MAX_COMPLETED_TRADES`).
   *
   * SYNCHRONOUS, for the same reason as `activeUnderlyings`: it is consulted in a prologue that
   * must not yield. ENTRY ONLY — a spent session budget must never reach an exit, a protective
   * cancel, a residual flatten or a reconciliation-driven reduction.
   */
  sessionEntryGate?: () => { allowed: boolean; reason: string | null; detail: string | null };
  /**
   * The OPERATOR BLOCKLIST verdict for an underlying (`box_excluded_underlyings`).
   *
   * SYNCHRONOUS BY CONTRACT, for exactly the same reason as `activeUnderlyings` and
   * `sessionEntryGate`: it is consulted in the prologue that must not yield, so it has to be an
   * in-memory lookup. This is why the blocklist is held in memory and reloaded at boot rather than
   * read from PostgreSQL per decision — a query here would reopen the TOCTOU the prologue exists to
   * close.
   *
   * Returns the refusal, or null when entry may proceed. A non-null result covers both an explicitly
   * excluded name and an unreadable blocklist. ENTRY ONLY — never consulted on any reduction path.
   */
  underlyingExclusion?: (underlying: string) => { code: string; detail: string } | null;
  /**
   * DURABLE-SIDE Box inventory: how much committed exposure the engine already holds.
   *
   * Counts open positions PLUS unresolved residual attempts PLUS unresolved order intents — not
   * merely established positions. A partial entry that never became a Box is still capital at risk,
   * and a ceiling that ignored it would admit a second Box on top of exposure nobody is counting.
   *
   * SYNCHRONOUS BY CONTRACT, like `activeUnderlyings` and `sessionEntryGate`: it is read inside the
   * prologue that must not yield. The coordinator adds its OWN in-flight claims and uncertain holds
   * on top, because those are exposure the engine cannot see yet.
   */
  boxInventory?: () => number;
  /**
   * CONSUME one entry attempt from the session's ATTEMPT budget, durably.
   *
   * Called after the cheap gates pass and BEFORE any reservation or broker POST. `ok: false` refuses
   * the entry: an attempt that could not be durably counted would be an unbounded one, and the
   * attempt budget is precisely what stops a run of failed-and-recovered attempts from taking risk
   * indefinitely. Nothing has been sent at this point, so refusing costs nothing.
   */
  sessionConsumeAttempt?: () => Promise<{ ok: boolean; detail: string | null }>;
  now?: () => number;
  /** Injected so tests can drive waiting deterministically. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so tests never create a real heartbeat timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (fields: CoordinatorLogFields) => void;
}

const DEFAULT_POLL_MS = 100;

type AcquireResult =
  | { kind: "acquired"; lease: ReservationLease }
  | { kind: "conflict"; conflicts: InstrumentConflict[] }
  | { kind: "unavailable"; tier: string; detail: string };

interface ActiveExecution {
  keys: string[];
  underlying: string;
  /** Null until the reservation is granted — an execution is CLAIMED before it is leased. */
  lease: ReservationLease | null;
  context: ReservationContext;
  ownershipLost: boolean;
  ownershipLossReason: string | null;
  opportunityId: string | null;
}

interface UncertainHold {
  lease: ReservationLease;
  context: ReservationContext;
  keys: string[];
  heldSince: number;
  reason: string;
}

/**
 * A durable reservation on ONE underlying key, held for as long as anything depends on it.
 *
 * REFERENCE-COUNTED BY HOLDER, not by trade id alone. There are three kinds of holder and they
 * have different lifetimes, which is why a single id was not enough:
 *
 *   `pipeline:<executionId>`  an entry pipeline is running. Added before the contract lease is
 *                             taken, removed when the pipeline settles.
 *   `trade:<tradeId>`         an established Box is open. Added on a successful entry, removed
 *                             when the engine reports it FLAT (or the record is deleted).
 *   `residual:<attemptId>`    unresolved residual legs exist. Added when residual exposure is
 *                             registered, removed when it resolves.
 *
 * The claim is released only when EVERY holder is gone. That is what makes both failure modes
 * impossible: it cannot be lost while a Box is open (the `trade:` holder is added before the
 * `pipeline:` holder is removed), and it cannot be retained after the Box is flat (the last
 * holder leaving releases it).
 */
interface PositionUnderlyingClaim {
  readonly owner: string;
  lease: ReservationLease;
  context: ReservationContext;
  readonly keys: string[];
  readonly underlying: string;
  /** Holder tokens, e.g. `trade:665f…`. Released when this empties. */
  readonly holders: Set<string>;
  claimedAt: number;
  ownershipLost: boolean;
}

export class CoordinatedBoxExecutionGateway implements BoxExecutionGateway {
  readonly mode: BoxConfig["executionMode"];

  private seq = 0;
  private readonly identity: ProcessIdentity;
  private active = new Map<string, ActiveExecution>();
  /**
   * Leases retained because a terminal broker state was ambiguous.
   *
   * Kept SEPARATE from `active` so the heartbeat keeps renewing them — a healthy
   * process with unresolved broker state must not let protection lapse just because
   * its execution call returned — while they no longer count as executions in flight.
   */
  private holds = new Map<string, UncertainHold>();
  /**
   * DURABLE OPEN-POSITION OWNERSHIP of an underlying — Layer 1c of the underlying lock.
   *
   * WHY THIS EXISTS. On a clean settle the entry lease is RELEASED, and it must be: an entry
   * pipeline should not hold contracts forever. But `activeUnderlyings` (Layer 1a) reads this
   * process's in-memory position book, which a SIBLING PROCESS cannot see. So between "entry
   * settled" and "the sibling reboots and adopts open trades from Mongo" there was a window in
   * which a second worker could open a second Box on an underlying that already had one.
   *
   * A successful entry therefore CONVERTS its lease into a position claim instead of releasing
   * it. Nothing is released and re-acquired, so there is no gap to race through. The claim is
   * renewed by the same heartbeat as every other lease and is dropped only when the engine
   * reports the Box flat.
   *
   * ON THE TTL. The spec is explicit that a TTL lease must not be the ONLY representation of an
   * open position, and it is not: the claim is backed by the heartbeat while the process lives,
   * by Layer 1a's durable-state check in-process, and — decisively — by the engine RE-CLAIMING
   * at boot from adopted Mongo state. A lapsed TTL therefore degrades to "the durable state
   * check still blocks", never to "nothing blocks".
   *
   * Keyed by `<BROKER>:<UNDERLYING>` and reference-counted by trade id, because two trades on
   * one underlying (possible only when the restriction is off, or across a config change) must
   * not have the first release drop the second's protection.
   */
  private positionClaims = new Map<string, PositionUnderlyingClaim>();
  /** Canonical opportunity identity -> execution id, for duplicate suppression. */
  private activeOpportunities = new Map<string, string>();
  private waiting = 0;
  private heartbeat: unknown = null;
  private heartbeatRunning = false;
  private disposed = false;
  private stats = {
    reservationConflicts: 0,
    duplicateSuppressed: 0,
    expiredWhileWaiting: 0,
    revalidationRejected: 0,
    revalidationPassed: 0,
    reservationsHeldOnUncertainty: 0,
    failedClosed: 0,
    durableUnavailableRefusals: 0,
    localOnlyFallbacks: 0,
    staleGenerationAborts: 0,
    ownershipLost: 0,
    renewSuccess: 0,
    renewFailure: 0,
    uncertainHoldsAbandoned: 0,
    underlyingAlreadyActive: 0,
    sessionLimitRefusals: 0,
    underlyingExcluded: 0,
    inventoryLimitRefusals: 0,
    positionClaimsHeld: 0,
    positionClaimsReleased: 0,
    positionClaimFailures: 0,
  };
  private waitSamples = new BoundedSamples();
  /** Deterministic retry jitter. See `pollDelay()`. */
  private jitterSeq = 0;
  private readonly jitterSeed: number;

  constructor(private readonly deps: CoordinatorDeps) {
    this.mode = deps.inner.mode;
    this.identity = deps.identity ?? createProcessIdentity();
    // Seeded from the per-process identity, so two workers de-synchronise while each
    // stays reproducible. A plain string hash is ample: this picks a retry delay.
    let seed = 0;
    for (const ch of this.identity.processTag) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
    this.jitterSeed = seed;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private generation(): number {
    return this.deps.generation?.() ?? 0;
  }

  private context(): ReservationContext {
    return {
      deployment: this.identity.deployment,
      broker: this.deps.broker(),
      generation: this.generation(),
      mode: this.mode,
    };
  }

  private log(fields: CoordinatorLogFields): void {
    if (this.deps.log) {
      this.deps.log(fields);
      return;
    }
    const rest = Object.entries(fields)
      .filter(([k]) => !["execution", "broker", "underlying", "status"].includes(k))
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    console.log(
      `[BoxCoord] execution=${fields.execution} broker=${fields.broker} ` +
        `underlying=${fields.underlying} status=${fields.status}${rest ? ` ${rest}` : ""}`,
    );
  }

  /* ------------------------------------------------------------------ *
   * Pass-through members. Coordination applies to submission, not to
   * read-only estimation or diagnostics.
   * ------------------------------------------------------------------ */

  hasCapacity(): boolean {
    return this.deps.inner.hasCapacity();
  }

  estimateExecutableExit(...args: Parameters<BoxExecutionGateway["estimateExecutableExit"]>) {
    return this.deps.inner.estimateExecutableExit(...args);
  }

  invariantViolation(reason: string): void {
    this.deps.inner.invariantViolation(reason);
  }

  /**
   * Residual flattening is NOT gated. Not by a reservation, and NOT by the durable
   * authority's health either.
   *
   * It reduces exposure that already exists, and it runs on the highest scheduling
   * priority for exactly that reason. Making it wait behind an entry's reservation
   * would let a naked leg sit open while a speculative box held the contract — the
   * precise inversion of the safety this class is for. "Cannot flatten a naked leg
   * because a database lock is unavailable" must never be reachable: ENTRY safety and
   * EXIT safety are different problems, and reducing exposure always wins.
   */
  flattenResidual(...args: Parameters<BoxExecutionGateway["flattenResidual"]>) {
    return this.deps.inner.flattenResidual(...args);
  }

  /* ------------------------------------------------------------------ *
   * Entries — fully coordinated.
   * ------------------------------------------------------------------ */

  async simulateLeggingEntry(
    args: Parameters<BoxExecutionSimulator["simulateLeggingEntry"]>[0],
  ): ReturnType<BoxExecutionSimulator["simulateLeggingEntry"]> {
    if (!this.deps.cfg.executionCoordinatorEnabled) {
      return this.deps.inner.simulateLeggingEntry(args);
    }
    const gate = await this.coordinateEntry(args.candidate, args.detection);
    if (!gate.ok) {
      return {
        ok: false,
        reason: gate.reason,
        detail: gate.detail,
        legging: emptyLeggingRecord(this.mode, args.detection.at, this.now(), gate.reason, gate.detail),
      };
    }
    try {
      const result = await this.deps.inner.simulateLeggingEntry({
        ...args,
        stillWanted: this.ownershipGuard(gate.executionId, args.stillWanted),
      });
      // Promote the underlying's PIPELINE hold to a TRADE hold before the pipeline hold is
      // dropped, so an open Box is never momentarily unprotected. Deliberately independent of the
      // contract lease's fate: even if that lease's ownership was lost mid-flight, an established
      // Box still gets its underlying protection.
      const uncertainty = uncertaintyOf(result);
      await this.settleUnderlyingHold({
        executionId: gate.executionId,
        underlying: gate.underlying,
        tradeId: result.ok === true ? (result.legging?.trade_id ?? null) : null,
        established: result.ok === true,
        retainForUncertainty: uncertainty === "uncertain",
      });
      await this.settle(gate.executionId, gate.opportunityId, uncertainty);
      return result;
    } catch (error) {
      // An exception leaves broker state genuinely unknown. Hold the reservation
      // rather than releasing: the alternative is a second box firing into a contract
      // whose first order may well have been accepted.
      this.holdOnUncertainty(gate.executionId, gate.opportunityId, "entry threw");
      throw error;
    }
  }

  async simulateEntry(
    args: Parameters<BoxExecutionSimulator["simulateEntry"]>[0],
  ): ReturnType<BoxExecutionSimulator["simulateEntry"]> {
    if (!this.deps.cfg.executionCoordinatorEnabled) {
      return this.deps.inner.simulateEntry(args);
    }
    const gate = await this.coordinateEntry(args.candidate, args.detection);
    if (!gate.ok) {
      return { ok: false, reason: gate.reason, detail: gate.detail } as Awaited<
        ReturnType<BoxExecutionSimulator["simulateEntry"]>
      >;
    }
    try {
      const result = await this.deps.inner.simulateEntry({
        ...args,
        stillWanted: this.ownershipGuard(gate.executionId, args.stillWanted),
      });
      // The atomic entry path reports no residual, so a plain failure is clean. It also has no
      // trade id to promote a hold to, so the pipeline hold is simply released and Layer 1a's
      // durable-state check takes over for whatever position was opened.
      await this.settleUnderlyingHold({
        executionId: gate.executionId,
        underlying: gate.underlying,
        tradeId: null,
        established: false,
        retainForUncertainty: false,
      });
      await this.settle(gate.executionId, gate.opportunityId, "clean");
      return result;
    } catch (error) {
      this.holdOnUncertainty(gate.executionId, gate.opportunityId, "entry threw");
      throw error;
    }
  }

  /* ------------------------------------------------------------------ *
   * Exits — reserved, but never made to wait.
   * ------------------------------------------------------------------ */

  /**
   * An exit takes the same contract reservation, so an entry cannot submit into a
   * leg an exit is closing. It does NOT wait on a conflict: it returns the failure
   * the monitor already handles by holding the position and retrying next cycle.
   * Waiting would be worse than retrying — the monitor owns exit urgency (including
   * the expiry-safety window) and must not be blocked behind a speculative entry.
   *
   * A DURABLE OUTAGE DOES NOT BLOCK AN EXIT. An exit reduces exposure, so when the
   * authority is unreachable it proceeds on the local tier and says so, rather than
   * leaving a position open because a database was down.
   */
  async simulateLeggingExit(
    args: Parameters<BoxExecutionSimulator["simulateLeggingExit"]>[0],
  ): ReturnType<BoxExecutionSimulator["simulateLeggingExit"]> {
    if (!this.deps.cfg.executionCoordinatorEnabled) {
      return this.deps.inner.simulateLeggingExit(args);
    }
    const refs = this.refsForExit(args.position);
    const executionId = this.mintId("exit");
    const acquired = await this.acquireForExit(executionId, refs);
    if (acquired.kind !== "acquired") {
      this.stats.reservationConflicts++;
      const count = acquired.kind === "conflict" ? acquired.conflicts.length : 0;
      this.log({
        execution: executionId,
        broker: this.deps.broker(),
        underlying: args.position.underlying,
        status: "exit_conflict",
        conflicts: count,
      });
      const detail =
        acquired.kind === "conflict"
          ? `exit deferred: ${count} leg(s) reserved by another execution`
          : `exit deferred: ${acquired.detail}`;
      return {
        ok: false,
        reason: "insufficient_quantity",
        detail,
        record: emptyLeggingRecord(this.mode, args.detectedAt ?? this.now(), this.now(), "insufficient_quantity", detail),
      };
    }
    this.registerActive(executionId, keysOf(refs), args.position.underlying, acquired.lease);
    try {
      // NOTE the ownership guard is deliberately NOT composed in here.
      //
      // An exit REDUCES exposure. If a lost or unverifiable lease aborted the remaining
      // legs of an exit, a half-closed box would be left with naked legs — the precise
      // inversion of the safety this class exists for, and the same reason
      // `flattenResidual` is ungated. Ownership matters for OPENING exposure; it must
      // never be a reason to stop closing it.
      const result = await this.deps.inner.simulateLeggingExit(args);
      await this.settle(executionId, null, uncertaintyOf(result));
      return result;
    } catch (error) {
      this.holdOnUncertainty(executionId, null, "exit threw");
      throw error;
    }
  }

  async simulateExit(
    args: Parameters<BoxExecutionSimulator["simulateExit"]>[0],
  ): ReturnType<BoxExecutionSimulator["simulateExit"]> {
    if (!this.deps.cfg.executionCoordinatorEnabled) {
      return this.deps.inner.simulateExit(args);
    }
    const refs = this.refsForExit(args.position);
    const executionId = this.mintId("exit");
    const acquired = await this.acquireForExit(executionId, refs);
    if (acquired.kind !== "acquired") {
      this.stats.reservationConflicts++;
      return {
        ok: false,
        reason: "insufficient_quantity",
        detail:
          acquired.kind === "conflict"
            ? "exit deferred: leg reserved by another execution"
            : `exit deferred: ${acquired.detail}`,
      } as Awaited<ReturnType<BoxExecutionSimulator["simulateExit"]>>;
    }
    this.registerActive(executionId, keysOf(refs), args.position.underlying, acquired.lease);
    try {
      const result = await this.deps.inner.simulateExit(args);
      await this.settle(executionId, null, "clean");
      return result;
    } catch (error) {
      this.holdOnUncertainty(executionId, null, "exit threw");
      throw error;
    }
  }

  /**
   * An exit's acquisition, which degrades to the local tier on a durable outage.
   *
   * Reducing existing exposure outranks cross-process exclusion: the worst case of
   * proceeding is that two workers work the same contract, the worst case of refusing
   * is an open position nobody closes. Entry takes the opposite trade-off, on purpose.
   */
  private async acquireForExit(executionId: string, refs: InstrumentLegRef[]): Promise<AcquireResult> {
    const attempt = await this.acquire(executionId, refs, this.context());
    if (attempt.kind !== "unavailable") return attempt;
    const local = this.deps.local;
    if (local === undefined) return attempt;
    this.stats.localOnlyFallbacks++;
    this.log({
      execution: executionId,
      broker: this.deps.broker(),
      underlying: "-",
      status: "exit_local_only",
      reason: DURABLE_UNAVAILABLE_REASON,
      detail: "exit proceeds on the local tier; reducing exposure outranks cross-process exclusion",
    });
    return this.acquireWith(local, executionId, refs, this.context());
  }

  /* ------------------------------------------------------------------ *
   * The coordination algorithm.
   * ------------------------------------------------------------------ */

  private async coordinateEntry(
    candidate: BoxCandidate,
    detection: BoxEvaluation,
  ): Promise<
    | { ok: true; executionId: string; keys: string[]; opportunityId: string; underlying: string }
    | { ok: false; reason: BoxExecutionFailureReason; detail: string }
  > {
    const broker = this.deps.broker();
    const executionId = this.mintId("entry");
    const opportunityId = `${broker.toUpperCase()}:${candidate.key}`;
    const context = this.context();

    // FAIL CLOSED (1). A durable tier is REQUIRED but none is configured. Live
    // execution must not proceed with only process-local exclusion. Paper is allowed
    // to continue on the in-process store so development and tests still work, and it
    // says so.
    if (this.deps.cfg.reservationRequireDurable && !this.deps.reservations.durable) {
      if (this.mode === "live") {
        this.stats.failedClosed++;
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "failed_closed",
          reason: "durable_reservations_required",
          store: this.deps.reservations.name,
        });
        return {
          ok: false,
          reason: "feed_unhealthy",
          detail:
            `live execution refused: BOX_RESERVATION_REQUIRE_DURABLE is set but the reservation ` +
            `store "${this.deps.reservations.name}" is not durable`,
        };
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────────────
    // EVERYTHING FROM HERE TO `claim()` RUNS SYNCHRONOUSLY, AND MUST.
    //
    // THE RULE: no `await` may appear between the guards below and `this.claim(...)`.
    //
    // The duplicate guard and the per-underlying budget are check-then-act on process state.
    // When the reservation store was synchronous this whole prologue ran to completion in one
    // turn of the event loop, so two candidates arriving on the same tick could not both pass.
    // Every later `await` inserted here has re-opened the same TOCTOU.
    //
    // IT REGRESSED, AND THIS IS WHAT IT COST. The session ATTEMPT-BUDGET consume
    // (`await sessionConsumeAttempt()`, a real PostgreSQL upsert) and the Layer 1b underlying
    // hold were both added ABOVE the claim. Two identical candidates on one tick therefore both
    // read `activeOpportunities` as empty, both yielded, and both SPENT an attempt before either
    // was visible to the other: `duplicateSuppressed` stayed 0 and `entry_attempts` went to 2 for
    // a single opportunity — on a one-attempt supervised trial, the entire safety budget consumed
    // by a duplicate. The second `claim()` also overwrote the first execution's
    // `activeOpportunities` entry, after which execution #1's `abandon()` no longer removed its
    // own key (that delete is guarded on the key still mapping to itself), leaving a phantom
    // incumbent that suppressed the opportunity for the rest of the process's life.
    //
    // Both awaits now live AFTER the claim. Ordering note: the attempt is still consumed durably
    // BEFORE any reservation is taken and long before any broker POST, so nothing is risked on an
    // uncounted attempt — the claim is process-local bookkeeping, not exposure. In exchange, every
    // refusal past the claim must release it; `abandonAndReleaseHold` is the one call that does.
    // ─────────────────────────────────────────────────────────────────────────────────────

    // DUPLICATE GUARD — a different problem from instrument reservation. This one
    // catches the SAME strategy fired twice; the reservation catches DIFFERENT
    // strategies sharing a contract. Both are needed.
    const incumbent = this.activeOpportunities.get(opportunityId);
    if (incumbent !== undefined && this.active.has(incumbent)) {
      this.stats.duplicateSuppressed++;
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "suppressed_duplicate",
        incumbent,
      });
      return { ok: false, reason: "duplicate", detail: `identical opportunity already executing as ${incumbent}` };
    }

    // ── SESSION CYCLE BUDGET ───────────────────────────────────────────────────────────
    //
    // Checked first: it is the cheapest gate and the most decisive. With
    // BOX_SESSION_MAX_COMPLETED_TRADES=1 the second candidate must be refused even while the
    // first Box is still OPEN, i.e. before any cycle has COMPLETED — which is why the session
    // counts cycles CONSUMED at establishment rather than only completed ones.
    //
    // Everything protective continues: this returns only from the ENTRY path.
    const sessionGate = this.deps.sessionEntryGate?.();
    if (sessionGate && !sessionGate.allowed) {
      this.stats.sessionLimitRefusals++;
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "suppressed_session_limit",
        reason: sessionGate.reason ?? "session_limit_reached",
      });
      // `session_limit_reached` is the only BoxExecutionFailureReason for this layer, so the
      // specific cause travels in the DETAIL and in the log's `reason` field. Flattening the
      // detail too would tell an operator whose database blipped that they were out of budget.
      return {
        ok: false,
        reason: "session_limit_reached",
        detail:
          sessionGate.detail ??
          `${sessionGate.reason ?? "session_limit_reached"}: the armed trading session refused entry`,
      };
    }

    // ── OPERATOR BLOCKLIST — enforcement point 2 of 4 ───────────────────────────────────
    //
    // Synchronous, inside the no-await prologue, and BEFORE the claim: an excluded name must not
    // spend an attempt, take a reservation or hold a claim it will immediately give back.
    //
    // Deliberately placed after the session gate so the existing refusal precedence is unchanged,
    // and before the underlying lock because "the operator forbade this name" is a more useful
    // answer than "this name is busy" when both happen to be true.
    //
    // ENTRY ONLY. There is no counterpart in `acquireForExit`, `coordinateExit` or any reduction
    // path, and that omission is the point: excluding a name must never trap an open Box.
    const exclusion = this.deps.underlyingExclusion?.(candidate.underlying);
    if (exclusion) {
      this.stats.underlyingExcluded++;
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "suppressed_underlying_excluded",
        reason: exclusion.code,
      });
      return { ok: false, reason: "underlying_excluded", detail: exclusion.detail };
    }

    // ── UNDERLYING LOCK, LAYER 1a: DURABLE POSITION OWNERSHIP ──────────────────────────
    //
    // Checked here, synchronously, BEFORE any reservation is taken, and derived from durable
    // state rather than from a lease. That is what makes it survive a restart: an open Box, a
    // partial position, a RECOVERY position or an unresolved residual leg blocks a second Box
    // on the same underlying even though no lease exists for it — and would still block after
    // a process restart, when every lease has expired.
    //
    // Layer 1b (the lease, acquired below alongside the contract keys) covers only the window
    // between admission and durable state existing. The two hand off, which is why the lock is
    // neither lost while a position is open nor retained once it is fully flat.
    if (this.deps.cfg.oneActiveBoxPerUnderlying) {
      const admission = evaluateUnderlyingAdmission({
        enabled: true,
        underlying: candidate.underlying,
        active: this.deps.activeUnderlyings?.() ?? new Map<string, UnderlyingActivity>(),
      });
      if (!admission.allowed) {
        this.stats.underlyingAlreadyActive++;
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "suppressed_underlying_active",
          reason: UNDERLYING_ALREADY_ACTIVE_REASON,
          kinds: admission.activity.kinds.join(","),
        });
        return { ok: false, reason: UNDERLYING_ALREADY_ACTIVE_REASON, detail: admission.detail };
      }
    }

    // ── TOTAL INVENTORY CEILING (BOX_MAX_OPEN_BOXES) — ALL MODES ───────────────────────
    //
    // The only global "how many Boxes may I hold at once" gate that works in paper as well as live,
    // and the only one decided BEFORE exposure exists.
    //
    // WHY IT IS NOT `BOX_LIVE_MAX_OPEN_BOXES`. That guard lives in BoxOrderManager, which is
    // constructed only on the live path, so (a) no paper rehearsal can exercise it and (b) it reads
    // a count the engine refreshes only AFTER a position has been created — so it cannot refuse the
    // second of two entries admitted in the same instant. Both gaps are closed here.
    //
    // WHAT IS COUNTED, and why each term is needed:
    //   engine inventory   — open positions, unresolved residual attempts, unresolved order intents.
    //                        A partial entry that never became a Box is still capital at risk.
    //   in-flight claims   — entries past `claim()` but not yet settled. `opportunityId !== null` is
    //                        what distinguishes an ENTRY claim from an EXIT acquisition, which also
    //                        lives in `this.active` and must NOT count against an entry ceiling.
    //   uncertain holds    — reservations retained over an ambiguous terminal state. Treating one as
    //                        "not a Box" is precisely the assumption `retain()` refuses to make.
    //
    // Synchronous and before the claim, so a refusal costs no attempt, no reservation and no hold.
    //
    // ENTRY ONLY. A full inventory is never a reason exposure cannot be reduced.
    const inventoryCeiling = this.deps.cfg.maxOpenBoxes;
    if (inventoryCeiling > 0) {
      let entriesInFlight = 0;
      for (const entry of this.active.values()) if (entry.opportunityId !== null) entriesInFlight++;
      const engineHeld = this.deps.boxInventory?.() ?? 0;
      const held = engineHeld + entriesInFlight + this.holds.size;
      if (held >= inventoryCeiling) {
        this.stats.inventoryLimitRefusals++;
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "suppressed_inventory_limit",
          held,
          ceiling: inventoryCeiling,
        });
        return {
          ok: false,
          reason: "box_inventory_limit",
          detail:
            `BOX_MAX_OPEN_BOXES=${inventoryCeiling} is already met (${held} held: ${engineHeld} durable, ` +
            `${entriesInFlight} entry pipeline(s) in flight, ${this.holds.size} reservation(s) held over an ` +
            `uncertain outcome), so no further box is entered on any underlying, in either direction. ` +
            `Exits, reductions and protective cancels are unaffected.`,
        };
      }
    }

    const refs = this.refsForEntry(candidate);
    const keys = keysOf(refs);

    // Optional per-underlying budget. It NEVER replaces exact-leg exclusion — it is a
    // risk cap on top of it, and 0 disables it.
    const perUnderlying = this.deps.cfg.maxConcurrentPerUnderlying;
    if (perUnderlying > 0) {
      let sameUnderlying = 0;
      for (const entry of this.active.values()) if (entry.underlying === candidate.underlying) sameUnderlying++;
      if (sameUnderlying >= perUnderlying) {
        return {
          ok: false,
          reason: "duplicate",
          detail: `per-underlying execution budget reached (${sameUnderlying}/${perUnderlying})`,
        };
      }
    }

    // THE CLAIM. Still synchronous, still the same event-loop turn as the guards above,
    // so a sibling candidate on this tick now sees this execution and is suppressed.
    this.claim(executionId, opportunityId, candidate.underlying, keys, context);

    // ═══════════════════════════════════════════════════════════════════════════════════
    // PAST THE CLAIM. Awaiting is now safe, and everything below MUST release the claim on
    // every refusal, exception and timeout — `abandonAndReleaseHold` does both halves.
    // ═══════════════════════════════════════════════════════════════════════════════════

    // ── SESSION ATTEMPT BUDGET: CONSUMED HERE, BEFORE ANYTHING IS RISKED ───────────────
    //
    // The gate above asked "may I attempt?". This SPENDS the attempt. It sits before the reservation
    // and long before any broker POST, so an attempt that is admitted and then fails — rejected,
    // partially filled and unwound, or recovered — has still consumed its budget. Counting at
    // completion instead is what let a trial configured for one trade submit orders indefinitely,
    // provided no attempt ever completed a Box.
    //
    // A failure to record REFUSES the entry rather than proceeding: nothing has been sent yet, so the
    // safe answer is to not send, and an uncounted attempt would be an unbounded one.
    if (this.deps.sessionConsumeAttempt) {
      let consumed: { ok: boolean; detail: string | null };
      try {
        consumed = await this.deps.sessionConsumeAttempt();
      } catch (error) {
        // A THROWING consume hook must not keep the claim. This is the FIRST await past the
        // claim, and a leak here is permanent and silent: nothing reaps `this.active` except a
        // broker switch, so the opportunity would be refused as a duplicate OF ITSELF for the
        // life of the process — and because the per-underlying budget counts `this.active`,
        // with BOX_MAX_CONCURRENT_PER_UNDERLYING=1 (the trial-profile value) every OTHER
        // opportunity on that underlying would be refused too. The hold acquisition below has
        // the same guard for the same reason.
        this.abandonAndReleaseHold(executionId);
        throw error;
      }
      if (!consumed.ok) {
        this.stats.sessionLimitRefusals++;
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "suppressed_session_limit",
          reason: "session_attempt_unaccountable",
        });
        // RELEASE THE CLAIM. It is held before this await now, so every refusal past this
        // point must give it back or the opportunity would be permanently self-suppressed.
        this.abandonAndReleaseHold(executionId);
        return {
          ok: false,
          reason: "session_limit_reached",
          detail:
            consumed.detail ??
            "the entry attempt could not be durably counted against the session attempt budget, so it was not started",
        };
      }
    }

    // ── UNDERLYING LOCK, LAYER 1b: ENTRY PIPELINE OWNERSHIP ────────────────────────────
    //
    // Acquired here: after the durable-state check, BEFORE the contract lease, and holding ONLY
    // the underlying key. Always first, so there is no lock-ordering cycle. This is a cross-process
    // CAS, so it also closes the same-tick race the in-process Layer 1a check cannot see.
    //
    // ENTRY ONLY. `refsForExit` never takes it, so an exit can never be blocked by it.
    if (this.deps.cfg.oneActiveBoxPerUnderlying) {
      let held: boolean;
      try {
        held = await this.holdUnderlying(
          candidate.underlying,
          CoordinatedBoxExecutionGateway.pipelineHolder(executionId),
          // EXCLUSIVE: a second entry pipeline may not join an underlying that is already held.
          true,
        );
      } catch (error) {
        // A throwing hold store must not leave the claim behind, or this opportunity would be
        // suppressed as a duplicate of itself for the rest of the process's life.
        this.abandonAndReleaseHold(executionId);
        throw error;
      }
      if (!held) {
        this.abandonAndReleaseHold(executionId);
        this.stats.underlyingAlreadyActive++;
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "suppressed_underlying_active",
          reason: UNDERLYING_ALREADY_ACTIVE_REASON,
        });
        return {
          ok: false,
          reason: UNDERLYING_ALREADY_ACTIVE_REASON,
          detail:
            `${candidate.underlying} is already held by another Box or entry pipeline; ` +
            "BOX_ONE_ACTIVE_BOX_PER_UNDERLYING is enabled, so a second Box on this underlying may " +
            "not enter regardless of strike pair, expiry or direction. This is NOT a contract " +
            "reservation conflict — the two Boxes need not share any option.",
        };
      }
    }


    const waitStarted = this.now();
    let attempt: AcquireResult;
    let waited = false;
    try {
      attempt = await this.acquire(executionId, refs, context);
    } catch (error) {
      // A store that throws must not leave the claim behind, or this opportunity would
      // be suppressed as a duplicate of itself forever.
      this.abandonAndReleaseHold(executionId);
      throw error;
    }

    if (attempt.kind === "unavailable") {
      const fallback = await this.handleUnavailable(executionId, refs, candidate, context, attempt);
      if (!fallback.ok) {
        this.abandonAndReleaseHold(executionId);
        return fallback;
      }
      attempt = fallback.attempt;
    }

    if (attempt.kind === "conflict") {
      waited = true;
      this.stats.reservationConflicts++;
      const described = attempt.conflicts.map((c) => c.kind).join(",");
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "waiting",
        conflicts: attempt.conflicts.length,
        kinds: described,
      });
      this.waiting++;
      try {
        attempt = await this.waitForKeys(executionId, refs, waitStarted, context);
      } finally {
        this.waiting--;
      }

      if (attempt.kind === "unavailable") {
        const fallback = await this.handleUnavailable(executionId, refs, candidate, context, attempt);
        if (!fallback.ok) {
          this.abandonAndReleaseHold(executionId);
          return fallback;
        }
        attempt = fallback.attempt;
      }

      if (attempt.kind !== "acquired") {
        this.abandonAndReleaseHold(executionId);
        this.stats.expiredWhileWaiting++;
        this.waitSamples.add(this.now() - waitStarted);
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "expired_while_waiting",
          waitMs: this.now() - waitStarted,
        });
        return {
          ok: false,
          reason: "price_moved",
          detail: `waited ${this.now() - waitStarted}ms for a shared contract and gave up`,
        };
      }

      // REVALIDATE. Arriving at the front of the queue is not a reason to trade. The
      // book has moved while waiting, so the opportunity is re-measured and only
      // executed if it still qualifies on CURRENT prices. Distributed waiting makes
      // this MORE important, not less: the wait may have been on another worker.
      const waitMs = this.now() - waitStarted;
      this.waitSamples.add(waitMs);
      const verdict = this.revalidate(candidate, detection);
      if (!verdict.ok) {
        this.stats.revalidationRejected++;
        this.abandonAndReleaseHold(executionId);
        await this.releaseLease(executionId, attempt.lease);
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "abort",
          reason: verdict.reason,
          waitMs,
          edgeBefore: detection.gross_edge ?? "null",
          edgeNow: verdict.edgeNow ?? "null",
        });
        return { ok: false, reason: "edge_disappeared", detail: `revalidation after ${waitMs}ms: ${verdict.reason}` };
      }
      this.stats.revalidationPassed++;
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "execute",
        waitMs,
        revalidated: true,
        edgeBefore: detection.gross_edge ?? "null",
        edgeNow: verdict.edgeNow ?? "null",
      });
    }

    // NOT merely a type narrowing — a genuine hole this closes.
    //
    // The paper/exit fallback re-acquires against the local tier, and that attempt can
    // ITSELF come back `unavailable`. Without this guard that outcome fell straight
    // through the conflict branch and reached the submit path with no lease at all. It
    // fails closed like every other unresolved acquisition.
    if (attempt.kind !== "acquired") {
      this.abandonAndReleaseHold(executionId);
      this.stats.failedClosed++;
      const detail =
        attempt.kind === "unavailable"
          ? `${DURABLE_UNAVAILABLE_REASON}: ${attempt.detail}`
          : "no reservation was granted";
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "failed_closed",
        reason: attempt.kind,
      });
      return { ok: false, reason: "feed_unhealthy", detail };
    }

    // PRE-SUBMIT OWNERSHIP CHECK. The last thing before the order path.
    const permitted = await this.confirmBeforeSubmit(executionId, keys, context, attempt.lease, waited);
    if (!permitted.ok) {
      this.abandonAndReleaseHold(executionId);
      await this.releaseLease(executionId, attempt.lease);
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "abort",
        reason: permitted.token,
        detail: permitted.detail,
      });
      return { ok: false, reason: "feed_unhealthy", detail: `${permitted.token}: ${permitted.detail}` };
    }

    // The claim becomes a LEASED execution. Nothing was registered twice: `claim()`
    // already created the record; this only attaches the granted reservation.
    this.grant(executionId, keys, attempt.lease);
    return { ok: true, executionId, keys, opportunityId, underlying: candidate.underlying };
  }

  /* ------------------------------------------------------------------ *
   * Claim lifecycle: claimed (synchronously) -> leased -> settled.
   * ------------------------------------------------------------------ */

  /**
   * Reserve this execution's PROCESS-LOCAL identity, synchronously.
   *
   * Separate from the contract reservation, and earlier than it, because the duplicate
   * guard and the per-underlying budget are decisions about this process's own state and
   * must not straddle an `await`. Called with no `await` between it and those guards.
   */
  private claim(
    executionId: string,
    opportunityId: string | null,
    underlying: string,
    keys: string[],
    context: ReservationContext,
  ): void {
    this.active.set(executionId, {
      keys,
      underlying,
      lease: null,
      context,
      ownershipLost: false,
      ownershipLossReason: null,
      opportunityId,
    });
    if (opportunityId !== null) this.activeOpportunities.set(opportunityId, executionId);
  }

  /** Attach the granted reservation to an already-claimed execution. */
  private grant(executionId: string, keys: string[], lease: ReservationLease | null): void {
    const exec = this.active.get(executionId);
    if (exec === undefined) return;
    exec.keys = keys;
    exec.lease = lease;
    exec.context = this.context();
    this.ensureHeartbeat();
  }

  /**
   * Drop a claim that never became an execution.
   *
   * Every failure path after `claim()` must call this, or the opportunity would be
   * suppressed as a duplicate of itself and the underlying's budget slot would leak.
   */
  /**
   * Release the entry-pipeline hold on an underlying, if this execution took one.
   *
   * Called from `abandon`, which every failure path inside `coordinateEntry` already invokes — so a
   * new early-return added later cannot leak the hold. Fire-and-forget because `abandon` is
   * synchronous by design (it runs inside the non-yielding prologue), and a failed release only ever
   * over-restricts.
   */
  private releasePipelineHold(executionId: string, underlying: string | undefined): void {
    if (!this.deps.cfg.oneActiveBoxPerUnderlying || !underlying) return;
    void this.dropUnderlyingHolder(
      underlying,
      CoordinatedBoxExecutionGateway.pipelineHolder(executionId),
    ).catch(() => undefined);
  }

  /**
   * Abandon an execution AND release its underlying pipeline hold.
   *
   * For `coordinateEntry`'s failure paths only. Every early return there already calls this, which
   * is why the release lives here rather than being repeated at each one — a new early return added
   * later cannot leak the hold.
   *
   * NOT used by `settle`/`holdOnUncertainty`: by then the hold's fate has already been decided by
   * `settleUnderlyingHold` (promoted to a trade hold, retained for uncertainty, or dropped), and
   * releasing again here would undo that decision. That mistake dropped the hold on exactly the
   * ambiguous outcomes it exists to cover.
   */
  private abandonAndReleaseHold(executionId: string): void {
    const exec = this.active.get(executionId);
    this.releasePipelineHold(executionId, exec?.underlying);
    this.abandon(executionId);
  }

  private abandon(executionId: string): void {
    const exec = this.active.get(executionId);
    if (exec === undefined) return;
    this.active.delete(executionId);
    if (exec.opportunityId !== null && this.activeOpportunities.get(exec.opportunityId) === executionId) {
      this.activeOpportunities.delete(exec.opportunityId);
    }
    // An abandoned claim can be the last thing keeping the heartbeat alive.
    this.stopHeartbeatIfIdle();
  }

  /**
   * The durable authority is unreachable. Decide, by mode, what that means.
   *
   * LIVE fails closed, unconditionally. A live entry opens NEW exposure on a shared
   * contract, and without the authority there is no way to know another worker is not
   * doing the same thing. Note this is not a new restriction in practice: live
   * execution already requires the Box database for durable order intents, so a Mongo
   * outage stops live entry regardless — this just makes the refusal explicit and
   * attributable instead of surfacing later as a persistence failure.
   *
   * PAPER may continue on the local tier, because paper cannot reach a broker and
   * because a development machine with no database must still be able to run. It is
   * counted and labelled `local_only` so nobody can mistake a degraded paper run for a
   * cross-process-safe one.
   */
  private async handleUnavailable(
    executionId: string,
    refs: InstrumentLegRef[],
    candidate: BoxCandidate,
    context: ReservationContext,
    attempt: Extract<AcquireResult, { kind: "unavailable" }>,
  ): Promise<
    | { ok: true; attempt: AcquireResult }
    | { ok: false; reason: BoxExecutionFailureReason; detail: string }
  > {
    if (this.mode === "live") {
      this.stats.failedClosed++;
      this.stats.durableUnavailableRefusals++;
      this.log({
        execution: executionId,
        broker: context.broker,
        underlying: candidate.underlying,
        status: "failed_closed",
        reason: DURABLE_UNAVAILABLE_REASON,
        tier: attempt.tier,
      });
      return {
        ok: false,
        reason: "feed_unhealthy",
        detail:
          `${DURABLE_UNAVAILABLE_REASON}: live entry refused because the durable reservation ` +
          `authority "${attempt.tier}" is unavailable (${attempt.detail})`,
      };
    }
    const local = this.deps.local;
    if (local === undefined) {
      return {
        ok: false,
        reason: "feed_unhealthy",
        detail: `${DURABLE_UNAVAILABLE_REASON}: ${attempt.detail}`,
      };
    }
    this.stats.localOnlyFallbacks++;
    this.log({
      execution: executionId,
      broker: context.broker,
      underlying: candidate.underlying,
      status: "local_only",
      reason: DURABLE_UNAVAILABLE_REASON,
      reservationDurability: "local_only",
    });
    return { ok: true, attempt: await this.acquireWith(local, executionId, refs, context) };
  }

  /**
   * The final gate before anything reaches the order path.
   *
   * TWO checks, with deliberately different costs.
   *
   * The broker/generation comparison is free and ALWAYS runs, because a broker switch
   * can land during the conflict wait: the lease would still be valid while naming a
   * broker whose token namespace no longer applies.
   *
   * The durable re-verification costs a round trip, so it runs only when the execution
   * actually WAITED. With no wait, the lease was granted microseconds earlier in this
   * same call and there is no window to close; after a wait of up to
   * `BOX_CONFLICT_WAIT_MAX_MS` there genuinely is one.
   */
  private async confirmBeforeSubmit(
    executionId: string,
    keys: readonly string[],
    context: ReservationContext,
    lease: ReservationLease,
    waited: boolean,
  ): Promise<{ ok: true } | { ok: false; token: string; detail: string }> {
    const current = this.context();
    if (current.broker !== context.broker || current.generation !== context.generation) {
      this.stats.staleGenerationAborts++;
      return {
        ok: false,
        token: STALE_GENERATION_REASON,
        detail:
          `reservation was taken under ${context.broker} generation ${context.generation}, ` +
          `active is ${current.broker} generation ${current.generation}`,
      };
    }
    if (!waited || lease.durability !== "durable") return { ok: true };
    const verdict = await this.deps.reservations.verify({
      owner: executionId,
      keys,
      now: this.now(),
      fence: lease.fence,
      context: current,
    });
    if (verdict.owned) return { ok: true };
    if (verdict.reason === "superseded") this.stats.staleGenerationAborts++;
    else this.stats.ownershipLost++;
    return {
      ok: false,
      token: verdict.reason === "superseded" ? STALE_GENERATION_REASON : "reservation_ownership_lost",
      detail: verdict.detail,
    };
  }

  /**
   * Wait for every required contract to become free.
   *
   * HYBRID, because it must be. Within this process the holder's release wakes the
   * waiter almost immediately. Across processes nothing can: `onRelease` is an
   * in-memory emitter, so a sibling worker's release is invisible and the only way to
   * learn about it is to ask again. So each round races the release event against a
   * short JITTERED timer and retries.
   *
   * The jitter is not decoration. Several workers woken by the same expiry would
   * otherwise retry in lockstep, converge on the authority together, and all but one
   * would pay a round trip to be told no.
   *
   * An `unavailable` result ends the wait immediately rather than spinning: retrying
   * against a database that is down just burns the opportunity window.
   */
  private async waitForKeys(
    executionId: string,
    refs: InstrumentLegRef[],
    startedAt: number,
    context: ReservationContext,
  ): Promise<AcquireResult> {
    const deadline = startedAt + this.deps.cfg.conflictWaitMaxMs;
    const keys = keysOf(refs);
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: AcquireResult = { kind: "conflict", conflicts: [] };

    while (this.now() < deadline) {
      let wake: (() => void) | null = null;
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const off = this.deps.waitable?.onRelease(keys, () => wake?.());
      const remaining = Math.max(1, deadline - this.now());
      try {
        await Promise.race([woken, sleep(Math.min(this.pollDelay(), remaining))]);
      } finally {
        off?.();
      }
      const retry = await this.acquire(executionId, refs, context);
      if (retry.kind === "acquired") return retry;
      if (retry.kind === "unavailable") return retry;
      last = retry;
    }
    return last;
  }

  /**
   * The retry delay, jittered ±20% — DETERMINISTICALLY.
   *
   * Jitter is needed because several workers freed by the same release or the same lease
   * expiry would otherwise retry in lockstep, converge on the authority together, and
   * all but one would pay a round trip to be told no.
   *
   * It is NOT `Math.random()`. The execution model is required to stay fully
   * deterministic — a recorded scenario has to reproduce exactly, and there is a test
   * asserting `Math.random` appears nowhere in `src/box` — so the sequence is a counter
   * stepped through a cheap integer hash, seeded from THIS PROCESS's boot token. Each
   * worker therefore walks a different sequence (which is what de-synchronises them)
   * while remaining perfectly reproducible within a process.
   */
  private pollDelay(): number {
    this.jitterSeq = (this.jitterSeq + 1) >>> 0;
    // Knuth multiplicative hash: one multiply, well-spread low bits.
    const mixed = Math.imul(this.jitterSeed ^ this.jitterSeq, 2654435761) >>> 0;
    const frac = (mixed % 1024) / 1024;
    // Rounded: sub-millisecond precision is meaningless to a timer, and an integer keeps
    // the delay readable in a log.
    return Math.round(DEFAULT_POLL_MS * (0.8 + 0.4 * frac));
  }

  /**
   * Re-measure the opportunity on the CURRENT book.
   *
   * Reuses `evaluateCandidate`, the same pure function the scanner uses, so this can
   * never drift from the real qualification arithmetic. Three independent reasons to
   * abort: the legs are no longer executable, the edge has gone, or the edge has
   * decayed past the configured tolerance relative to what was detected.
   */
  private revalidate(
    candidate: BoxCandidate,
    detection: BoxEvaluation,
  ): { ok: true; edgeNow: number | null } | { ok: false; reason: string; edgeNow: number | null } {
    const now = this.now();
    const fresh = evaluateCandidate({
      candidate,
      quotes: this.deps.quotes.view(),
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      captureDepth: false,
    });
    const edgeNow = fresh.gross_edge;
    if (!fresh.tradable) return { ok: false, reason: `not_tradable:${fresh.reject ?? "unknown"}`, edgeNow };
    if (edgeNow === null) return { ok: false, reason: "edge_unpriced", edgeNow };
    if (edgeNow <= 0) return { ok: false, reason: "edge_gone", edgeNow };

    const before = detection.gross_edge;
    if (before !== null && before > 0) {
      const retained = edgeNow / before;
      const floor = this.deps.cfg.conflictRevalidateMinEdgeRatio;
      if (retained < floor) {
        return { ok: false, reason: `edge_deteriorated:${Math.round(retained * 100)}%`, edgeNow };
      }
    }
    return { ok: true, edgeNow };
  }

  private refsForEntry(candidate: BoxCandidate): InstrumentLegRef[] {
    const direction = candidate.direction ?? "LONG_BOX";
    const refs = boxInstrumentRefs(
      this.deps.broker(),
      candidate.legs,
      (role: BoxLegRole): OrderSide => entrySideFor(role, direction),
      BOX_LEG_ROLES,
    );
    // NOTE the underlying key is deliberately NOT added here.
    //
    // An earlier version appended it to this key set so all five were claimed atomically. That
    // was a serious bug: the claim outlives the entry (it must, to protect an OPEN Box), and a
    // reservation conflict is side-agnostic, so the Box's OWN EXIT then collided with its own
    // claim on the four contracts and was deferred forever — auto-exit, manual close and
    // operator emergency flatten alike, with only a restart to clear it.
    //
    // The underlying lock is therefore acquired SEPARATELY, holds ONLY the underlying key, and
    // is reference-counted by holder (see `holdUnderlying`). Losing atomicity between the two
    // acquisitions is harmless: they protect different things, the underlying is always taken
    // FIRST so there is no lock-ordering cycle, and each is individually CAS-exclusive.
    return refs;
  }

  private refsForExit(position: {
    underlying: string;
    legs: Record<BoxLegRole, BoxOptionInstrument>;
    direction?: BoxDirection;
  }): InstrumentLegRef[] {
    const direction = position.direction ?? "LONG_BOX";
    // The exit works the reverse side of each leg, so the reservation names the
    // contract on the side it will actually be traded.
    return boxInstrumentRefs(
      this.deps.broker(),
      position.legs,
      (role: BoxLegRole): OrderSide => (entrySideFor(role, direction) === "BUY" ? "SELL" : "BUY"),
      BOX_LEG_ROLES,
    );
  }

  private acquire(
    executionId: string,
    refs: InstrumentLegRef[],
    context: ReservationContext,
  ): Promise<AcquireResult> {
    return this.acquireWith(this.deps.reservations, executionId, refs, context);
  }

  private async acquireWith(
    store: InstrumentReservationStore,
    executionId: string,
    refs: InstrumentLegRef[],
    context: ReservationContext,
  ): Promise<AcquireResult> {
    const now = this.now();
    const keys = keysOf(refs);
    const sideByKey = new Map<string, string>();
    for (const ref of refs) sideByKey.set(ref.key, ref.side);

    const outcome = await store.tryAcquireAll({
      owner: executionId,
      keys,
      ttlMs: this.deps.cfg.instrumentLockTtlMs,
      now,
      sideByKey,
      context,
    });
    if (outcome.ok) {
      return {
        kind: "acquired",
        lease: {
          owner: outcome.owner,
          keys: outcome.keys,
          expiresAt: outcome.expiresAt,
          fence: outcome.fence,
          durability: outcome.durability,
        },
      };
    }
    if (outcome.reason === "unavailable") {
      return { kind: "unavailable", tier: outcome.tier, detail: outcome.detail };
    }
    const wanted = new Map(refs.map((r) => [r.key, r.side] as const));
    // The incumbent's side arrives ON the conflict, so no second lookup is needed —
    // a follow-up read could describe a holder that has since gone away.
    const conflicts = outcome.conflicts.map((c) =>
      classifyConflict(
        c.key,
        c.heldBy,
        (c.heldSide as OrderSide | null) ?? null,
        wanted.get(c.key) ?? "BUY",
      ),
    );
    return { kind: "conflict", conflicts };
  }

  /** The claim key for an underlying under the CURRENT broker. */
  private positionClaimKey(underlying: string): string {
    return `${this.deps.broker().trim().toUpperCase()}:${underlying.trim().toUpperCase()}`;
  }

  /**
   * Acquire (or join) the durable claim on one underlying, for a named holder.
   *
   * Holds ONLY the underlying key, so it can never conflict with the four contract keys an exit
   * needs. Idempotent per holder. Returns false when the claim is held by ANOTHER process or the
   * authority is unreachable, which the caller treats as `underlying_already_active` on entry and
   * as a degraded-protection note on the boot path.
   *
   * Never throws: a failure to take a lock must not be able to abort adopting real exposure.
   */
  private async holdUnderlying(
    underlying: string,
    holder: string,
    /**
     * Whether an EXISTING claim must be refused rather than joined.
     *
     * TRUE for an entry pipeline, and this is the whole restriction: joining would admit a second
     * Box on an underlying that already has one, which is precisely what the setting forbids. An
     * earlier version joined unconditionally and therefore did not restrict anything for the
     * in-flight case.
     *
     * FALSE for the boot re-claim, a trade hold and a residual hold. Those are not new exposure —
     * they are additional dependents on protection that must already exist, and refusing them would
     * mean an adopted position or an unresolved residual leg silently lost its lock.
     */
    exclusive: boolean,
  ): Promise<boolean> {
    if (!this.deps.cfg.oneActiveBoxPerUnderlying) return false;
    const claimKey = this.positionClaimKey(underlying);
    const existing = this.positionClaims.get(claimKey);
    if (existing) {
      if (exclusive) return false;
      existing.holders.add(holder);
      return true;
    }
    const owner = this.mintId("underlying");
    const context = this.context();
    const refs = [underlyingLegRef(this.deps.broker(), underlying, BOX_LEG_ROLES[0] as BoxLegRole)];
    try {
      const attempt = await this.acquire(owner, refs, context);
      if (attempt.kind !== "acquired") {
        this.stats.positionClaimFailures++;
        this.log({
          execution: owner,
          broker: context.broker,
          underlying,
          status: "underlying_claim_unavailable",
          reason: attempt.kind,
        });
        return false;
      }
      this.positionClaims.set(claimKey, {
        owner,
        lease: attempt.lease,
        context,
        keys: attempt.lease.keys as string[],
        underlying: underlying.trim().toUpperCase(),
        holders: new Set([holder]),
        claimedAt: this.now(),
        ownershipLost: false,
      });
      this.stats.positionClaimsHeld++;
      this.ensureHeartbeat();
      return true;
    } catch {
      this.stats.positionClaimFailures++;
      return false;
    }
  }

  /**
   * Drop one holder, releasing the claim when the last one goes.
   *
   * Releasing here — rather than letting a TTL lapse — is what stops the lock being incorrectly
   * retained after a position is flat.
   */
  private async dropUnderlyingHolder(underlying: string, holder: string): Promise<void> {
    const claimKey = this.positionClaimKey(underlying);
    const claim = this.positionClaims.get(claimKey);
    if (!claim) return;
    claim.holders.delete(holder);
    if (claim.holders.size > 0) return;
    this.positionClaims.delete(claimKey);
    this.stats.positionClaimsReleased++;
    await this.releaseLease(claim.owner, claim.lease);
    this.stopHeartbeatIfIdle();
    this.log({
      execution: claim.owner,
      broker: claim.context.broker,
      underlying,
      status: "underlying_claim_released",
      holder,
    });
  }

  /** Holder token for an entry pipeline. */
  private static pipelineHolder(executionId: string): string {
    return `pipeline:${executionId}`;
  }

  /** Holder token for an established Box. */
  private static tradeHolder(tradeId: string): string {
    return `trade:${tradeId}`;
  }

  /**
   * Promote a settled entry pipeline's hold to a TRADE hold, or release it.
   *
   * ORDER MATTERS AND IS THE WHOLE POINT: the `trade:` holder is added BEFORE the `pipeline:`
   * holder is removed, so there is no instant at which the claim has zero holders while a Box is
   * open. That is what closes the "lock lost while the position remains open" hole, including the
   * case where the entry lease's ownership was lost mid-flight — this path does not depend on that
   * lease at all.
   *
   * `retainForUncertainty` keeps the pipeline hold when the outcome was ambiguous: exposure may
   * exist under a trade id we do not yet know, so releasing would assume there is none.
   */
  private async settleUnderlyingHold(args: {
    readonly executionId: string;
    readonly underlying: string;
    readonly tradeId: string | null;
    readonly established: boolean;
    readonly retainForUncertainty: boolean;
  }): Promise<void> {
    if (!this.deps.cfg.oneActiveBoxPerUnderlying) return;
    const pipeline = CoordinatedBoxExecutionGateway.pipelineHolder(args.executionId);
    if (args.established && args.tradeId) {
      const claimKey = this.positionClaimKey(args.underlying);
      const claim = this.positionClaims.get(claimKey);
      if (claim) claim.holders.add(CoordinatedBoxExecutionGateway.tradeHolder(args.tradeId));
      else {
        // The hold was somehow lost while the entry succeeded. Re-acquire under the trade rather
        // than leaving an open Box unprotected across processes.
        await this.holdUnderlying(
          args.underlying,
          CoordinatedBoxExecutionGateway.tradeHolder(args.tradeId),
          false,
        );
      }
      this.log({
        execution: args.executionId,
        broker: this.deps.broker(),
        underlying: args.underlying,
        status: "underlying_claim_held",
        tradeId: args.tradeId,
      });
    } else if (args.retainForUncertainty) {
      // Ambiguous outcome: keep the pipeline hold. It is renewed by the heartbeat and cleared by
      // reconciliation or by the engine registering residual exposure under its own holder.
      this.log({
        execution: args.executionId,
        broker: this.deps.broker(),
        underlying: args.underlying,
        status: "underlying_claim_retained_uncertain",
      });
      return;
    }
    await this.dropUnderlyingHolder(args.underlying, pipeline);
  }

  /**
   * Claim an underlying for an already-open Box or an unresolved residual attempt.
   *
   * Called by the engine at BOOT for every adopted position and residual, which is what makes the
   * lock survive a restart: after a reboot every lease has expired, so protection is rebuilt from
   * durable Mongo state rather than assumed to have persisted.
   */
  async claimUnderlyingForPosition(underlying: string, tradeId: string): Promise<boolean> {
    return this.holdUnderlying(underlying, CoordinatedBoxExecutionGateway.tradeHolder(tradeId), false);
  }

  /** Release a trade's hold. Called when a Box becomes fully FLAT, or its record is deleted. */
  async releaseUnderlyingForPosition(underlying: string, tradeId: string): Promise<void> {
    await this.dropUnderlyingHolder(underlying, CoordinatedBoxExecutionGateway.tradeHolder(tradeId));
  }

  /** Claim an underlying on behalf of unresolved RESIDUAL legs. */
  async claimUnderlyingForResidual(underlying: string, attemptId: string): Promise<boolean> {
    return this.holdUnderlying(underlying, `residual:${attemptId}`, false);
  }

  /** Release a residual attempt's hold once its exposure is resolved. */
  async releaseUnderlyingForResidual(underlying: string, attemptId: string): Promise<void> {
    await this.dropUnderlyingHolder(underlying, `residual:${attemptId}`);
  }

  /** Underlyings this process currently protects on behalf of an open Box. Diagnostics. */
  claimedUnderlyings(): string[] {
    return [...this.positionClaims.values()].map((claim) => claim.underlying).sort();
  }

  private async releaseLease(executionId: string, lease: ReservationLease | null): Promise<void> {
    await this.deps.reservations.release({
      owner: executionId,
      ...(lease === null ? {} : { keys: lease.keys, fence: lease.fence }),
      now: this.now(),
    });
    // The paper fallback may have written to the local tier directly, so release it
    // there too. Releasing a lease you do not hold is a no-op by contract.
    const local = this.deps.local;
    if (local !== undefined && local !== this.deps.reservations) {
      await local.release({ owner: executionId, now: this.now() });
    }
  }

  /* ------------------------------------------------------------------ *
   * Ownership: the heartbeat and the synchronous guard.
   * ------------------------------------------------------------------ */

  /**
   * Register an EXIT's execution.
   *
   * Exits take the same contract reservation but participate in neither the duplicate
   * guard nor the per-underlying budget — the monitor owns exit urgency, and an exit is
   * never a speculative duplicate — so they have no opportunity identity to claim and can
   * register once the reservation is granted.
   */
  private registerActive(
    executionId: string,
    keys: string[],
    underlying: string,
    lease: ReservationLease | null,
  ): void {
    this.active.set(executionId, {
      keys,
      underlying,
      lease,
      context: this.context(),
      ownershipLost: false,
      ownershipLossReason: null,
      opportunityId: null,
    });
    this.ensureHeartbeat();
  }

  /**
   * The synchronous ownership predicate, composed with the caller's own `stillWanted`.
   *
   * This is the hook that makes "TTL is not execution permission" real rather than
   * aspirational: the simulator already consults `stillWanted` before each leg and
   * inside its abort predicate, so a lost lease aborts the remaining legs through the
   * existing, tested path instead of a new one.
   *
   * It is PESSIMISTIC about time, and the margin is NOT the clock-skew grace.
   *
   * The clock grace (250 ms) is sized for measurement error between this process and the
   * authority. It says nothing about how long a broker order takes. A leg permitted at
   * `expiresAt - 300ms` is submitted, the HTTP round trip takes a second or more, and by
   * the time it is acknowledged another worker may legitimately hold the contract — and
   * as `durable.ts` notes honestly, neither Zerodha nor Dhan accepts a fencing token, so
   * nothing downstream can reject the stale order.
   *
   * So the margin is `reservationOwnershipMarginMs`, which must exceed worst-case submit
   * latency. Renewal normally keeps `expiresAt` far ahead, so this boundary is rarely
   * reached; when it is, refusing to open another leg is the only safe answer.
   *
   * NOTE it is deliberately NOT applied to `flattenResidual` or to EXITS, both of which
   * must reduce existing exposure regardless of lease state.
   */
  private ownershipGuard(executionId: string, inner?: () => boolean): () => boolean {
    return () => {
      if (inner !== undefined && !inner()) return false;
      const exec = this.active.get(executionId);
      // FAIL CLOSED on an untracked execution. The only ways to get here are a settled
      // execution (whose executor has already returned, so nothing consults this) or a
      // broker switch that cleared the table mid-flight — in which case stopping is
      // exactly right, because the contracts are in the outgoing broker's namespace.
      if (exec === undefined) return false;
      // Coordination granted no lease at all: there is nothing to assert.
      if (exec.lease === null) return true;
      if (exec.ownershipLost) return false;
      return this.now() < exec.lease.expiresAt - this.deps.cfg.reservationOwnershipMarginMs;
    };
  }

  private ensureHeartbeat(): void {
    if (this.disposed) return;
    if (this.heartbeat !== null) return;
    if (this.active.size === 0 && this.holds.size === 0 && this.positionClaims.size === 0) return;
    const interval = this.deps.cfg.reservationRenewIntervalMs;
    const set =
      this.deps.setTimer ??
      ((fn: () => void, ms: number) => {
        const handle = setInterval(fn, ms);
        // Never hold the process open for a lock heartbeat.
        if (typeof handle.unref === "function") handle.unref();
        return handle;
      });
    this.heartbeat = set(() => {
      // The tick is async; a rejection must never escape as an unhandled rejection.
      void this.renewTick().catch(() => undefined);
    }, interval);
  }

  private stopHeartbeatIfIdle(): void {
    if (this.heartbeat === null) return;
    // A position claim outlives every execution, so the heartbeat must outlive them too:
    // stopping it here would let an open Box's underlying protection lapse by TTL.
    if (this.active.size > 0 || this.holds.size > 0 || this.positionClaims.size > 0) return;
    const clear = this.deps.clearTimer ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Renew every lease this process still depends on.
   *
   * Bounded by a timer derived from the TTL, NOT driven by market ticks — renewing per
   * tick would put thousands of writes a minute on the authority to achieve nothing.
   *
   * A failed renewal is a SAFETY EVENT. Ownership was lost, or is unknown, and either
   * way this worker must stop treating the contracts as its own. `invariantViolation`
   * is raised so the live path's existing quarantine logic engages, and the
   * synchronous guard flips so the remaining legs abort.
   */
  async renewTick(): Promise<void> {
    if (this.heartbeatRunning) return; // never overlap a tick with itself
    this.heartbeatRunning = true;
    try {
      const now = this.now();
      const ttl = this.deps.cfg.instrumentLockTtlMs;
      // THE CURRENT context, deliberately — never the one the lease was taken under.
      //
      // Renewal asks "is this lease still valid in the world as it is NOW", and the
      // durable tier answers by comparing the STORED broker/generation against what it is
      // given. Handing it the lease's own recorded context would compare the lease to
      // itself, which always matches, which silently disables the stale-generation check
      // at exactly the moment it matters: a broker switch during a long execution.
      const current = this.context();

      // Renewed CONCURRENTLY, not one after another. A serial loop costs N round trips
      // per tick, so a slow tier could push a tick past the renew interval and let
      // leases lapse — and it would couple unrelated boxes, since one slow renewal would
      // delay every other lease's. The fan-out is bounded by the execution concurrency
      // cap, so this is a handful of requests.
      // `allSettled`, not `all`: one renewal rejecting must not abandon the others, nor
      // skip the uncertain-hold maintenance below.
      await Promise.allSettled(
        [...this.active].map(async ([executionId, exec]) => {
          if (exec.lease === null || exec.ownershipLost) return;
          const outcome = await this.renewLease(executionId, exec.lease, ttl, now, current);
          if (outcome.ok) {
            this.stats.renewSuccess++;
            exec.lease = { ...exec.lease, expiresAt: outcome.expiresAt, fence: outcome.fence };
            return;
          }
          this.stats.renewFailure++;
          this.stats.ownershipLost++;
          exec.ownershipLost = true;
          exec.ownershipLossReason = outcome.reason;
          this.log({
            execution: executionId,
            broker: exec.context.broker,
            underlying: exec.underlying,
            status: "ownership_lost",
            reason: outcome.reason,
            detail: outcome.detail,
          });
          // An invariant violation, not a retryable hiccup: another worker may already
          // own these contracts.
          this.deps.inner.invariantViolation(
            `box reservation ownership ${outcome.reason} mid-execution (${outcome.detail})`,
          );
        }),
      );

      // Uncertain holds keep their protection alive while this process is healthy, and
      // for a BOUNDED time only. Renewing forever would lock a contract permanently on
      // one ambiguous outcome; not renewing at all would drop protection while real
      // exposure may exist. So it is renewed up to `reservationUncertainHoldMaxMs` and
      // then LEFT TO EXPIRE — never actively released, because releasing is the
      // "assume there is no exposure" mistake this hold exists to avoid.
      for (const [executionId, hold] of [...this.holds]) {
        if (now - hold.heldSince >= this.deps.cfg.reservationUncertainHoldMaxMs) {
          this.holds.delete(executionId);
          this.stats.uncertainHoldsAbandoned++;
          this.log({
            execution: executionId,
            broker: hold.context.broker,
            underlying: "-",
            status: "reservation_hold_expiring",
            reason: hold.reason,
            heldMs: now - hold.heldSince,
          });
          continue;
        }
        // Current context here too: a hold from a superseded broker generation must stop
        // being renewed rather than being kept alive indefinitely.
        const outcome = await this.renewLease(executionId, hold.lease, ttl, now, current);
        if (outcome.ok) {
          this.stats.renewSuccess++;
          hold.lease = { ...hold.lease, expiresAt: outcome.expiresAt, fence: outcome.fence };
          continue;
        }
        this.stats.renewFailure++;
        // A TRANSIENT failure must not collapse the hold. `unavailable` means ownership is
        // UNKNOWN, and dropping the hold on a brief Mongo blip would cut protection from
        // `reservationUncertainHoldMaxMs` down to a single lock TTL at exactly the moment
        // broker state is ambiguous. Only a confirmed loss ends the hold.
        if (outcome.reason === "unavailable") {
          this.log({
            execution: executionId,
            broker: hold.context.broker,
            underlying: "-",
            status: "reservation_hold_renew_unavailable",
            reason: outcome.reason,
          });
          continue;
        }
        this.holds.delete(executionId);
        this.log({
          execution: executionId,
          broker: hold.context.broker,
          underlying: "-",
          status: "reservation_hold_lost",
          reason: outcome.reason,
        });
      }

      // OPEN-POSITION UNDERLYING CLAIMS. Renewed indefinitely and deliberately UNBOUNDED by
      // `reservationUncertainHoldMaxMs`: an uncertain hold is a temporary ambiguity, whereas
      // this represents a Box that really is open, and an open Box may be held for hours. The
      // claim ends when the engine reports it flat, not when a timer says so.
      //
      // A failed renewal is recorded but the claim is NOT dropped. Losing the reservation does
      // not mean the position closed, and forgetting it here would remove Layer 1c's protection
      // while the exposure remained. Layer 1a still blocks locally, so the degradation is
      // bounded and visible rather than silent.
      for (const [claimKey, claim] of [...this.positionClaims]) {
        const outcome = await this.renewLease(claim.owner, claim.lease, ttl, now, current);
        if (outcome.ok) {
          this.stats.renewSuccess++;
          claim.lease = { ...claim.lease, expiresAt: outcome.expiresAt, fence: outcome.fence };
          claim.ownershipLost = false;
          continue;
        }
        this.stats.renewFailure++;
        if (!claim.ownershipLost) {
          claim.ownershipLost = true;
          this.log({
            execution: claim.owner,
            broker: claim.context.broker,
            underlying: claim.underlying,
            status: "underlying_claim_renew_failed",
            reason: outcome.reason,
            detail: outcome.detail,
            claimKey,
          });
        }
      }
      this.stopHeartbeatIfIdle();
    } finally {
      this.heartbeatRunning = false;
    }
  }

  /**
   * Renew ONE lease against the tier that actually granted it.
   *
   * A `local_only` lease came from the in-process tier, because the durable authority was
   * unreachable when it was taken. Renewing it against the CHAIN would ask that same
   * unreachable authority to confirm a lease it never issued, get `unavailable`, and
   * declare ownership lost on the very first heartbeat — destroying the documented
   * degraded modes (paper continuing, and an exit proceeding) exactly one interval after
   * they began.
   */
  private renewLease(
    executionId: string,
    lease: ReservationLease,
    ttlMs: number,
    now: number,
    context: ReservationContext,
  ): Promise<RenewOutcome> {
    const store =
      lease.durability === "local_only" && this.deps.local !== undefined
        ? this.deps.local
        : this.deps.reservations;
    return store.renew({
      owner: executionId,
      keys: lease.keys,
      ttlMs,
      now,
      fence: lease.fence,
      context,
    });
  }

  /**
   * Decide whether an execution's reservation may be released.
   *
   * `clean` means the broker's position is knowable and settled — released, so a
   * later box may legitimately work the same contract for its own lot. `uncertain`
   * means residual exposure exists or the terminal state is ambiguous, and the
   * reservation is HELD and kept renewed. Holding is the conservative choice:
   * releasing would let a second box assume there is no exposure on a contract that
   * may still carry some.
   */
  private async settle(
    executionId: string,
    opportunityId: string | null,
    outcome: "clean" | "uncertain",
  ): Promise<void> {
    const exec = this.active.get(executionId);
    this.abandon(executionId);
    // NOTE the deliberate ABSENCE of an unguarded `activeOpportunities.delete(opportunityId)` here.
    //
    // `abandon()` above already removes the entry, but ONLY when it still maps to THIS execution
    // (see the guard at its own delete). That guard is the whole point, and repeating the delete
    // unguarded defeated it: if a successor execution has since claimed the same opportunity id,
    // this line deleted the SUCCESSOR's suppression entry while the successor was still running —
    // re-opening the duplicate window for an opportunity that is actively executing.
    //
    // That is the same failure the no-await banner above `coordinateEntry` records having already
    // been paid for once ("the second `claim()` also overwrote the first execution's
    // `activeOpportunities` entry, after which execution #1's `abandon()` no longer removed its
    // own key"), approached from the other side. The guarded delete in `abandon` is sufficient and
    // is the only correct one.
    if (outcome === "clean") {
      await this.releaseLease(executionId, exec?.lease ?? null);
      this.stopHeartbeatIfIdle();
      return;
    }
    this.retain(executionId, exec, "uncertain_terminal_state");
  }

  private holdOnUncertainty(executionId: string, _opportunityId: string | null, why: string): void {
    const exec = this.active.get(executionId);
    // `abandon()` performs the OWNERSHIP-GUARDED removal. See the note in `settle` for why an
    // unguarded delete here was actively harmful rather than merely redundant.
    this.abandon(executionId);
    this.retain(executionId, exec, why);
  }

  private retain(executionId: string, exec: ActiveExecution | undefined, why: string): void {
    this.stats.reservationsHeldOnUncertainty++;
    if (exec?.lease != null && !exec.ownershipLost) {
      this.holds.set(executionId, {
        lease: exec.lease,
        context: exec.context,
        keys: exec.keys,
        heldSince: this.now(),
        reason: why,
      });
      this.ensureHeartbeat();
    }
    this.log({
      execution: executionId,
      broker: exec?.context.broker ?? this.deps.broker(),
      underlying: "-",
      status: "reservation_held",
      reason: why,
      ttlMs: this.deps.cfg.instrumentLockTtlMs,
      renewedUntilMs: this.deps.cfg.reservationUncertainHoldMaxMs,
    });
    this.stopHeartbeatIfIdle();
  }

  private mintId(kind: string): string {
    this.seq += 1;
    // Globally unique. A bare per-process counter collides across workers — worker-1's
    // `entry-7` and worker-2's `entry-7` are the same string — which would let one
    // worker renew or release the other's lease.
    return mintOwnerId(this.identity, kind, this.seq);
  }

  /**
   * Broker switch: keys change namespace wholesale, so nothing may survive.
   *
   * The durable tier clears only the reservations THIS PROCESS owns. A sibling
   * worker's live reservations are authoritative and must not be deleted — doing so
   * would be exactly the multi-process violation this subsystem exists to prevent.
   */
  async resetForBrokerSwitch(): Promise<void> {
    await this.deps.reservations.clear();
    const local = this.deps.local;
    if (local !== undefined && local !== this.deps.reservations) await local.clear();
    this.active.clear();
    this.holds.clear();
    // Position claims are keyed by the OUTGOING broker's namespace, so their rows are gone with
    // the `clear()` above and their bookkeeping would be stale. The engine re-claims under the
    // new broker as part of the switch, exactly as it does at boot.
    this.positionClaims.clear();
    this.activeOpportunities.clear();
    this.stopHeartbeatIfIdle();
  }

  /** True while this process holds any reservation, including uncertain holds and claims. */
  get holdsReservations(): boolean {
    return this.active.size > 0 || this.holds.size > 0 || this.positionClaims.size > 0;
  }

  /** Stop the heartbeat. Called from the engine's shutdown path. */
  dispose(): void {
    this.disposed = true;
    if (this.heartbeat !== null) {
      const clear = this.deps.clearTimer ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
      clear(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** Why LIVE Box entry is currently refused, or null when it is permitted. */
  private liveEntryBlockedReason(): string | null {
    if (this.mode !== "live") return null;
    if (this.deps.cfg.reservationRequireDurable && !this.deps.reservations.durable) {
      return `BOX_RESERVATION_REQUIRE_DURABLE is set but "${this.deps.reservations.name}" is not durable`;
    }
    if (this.deps.cfg.durableReservationsEnabled && !this.deps.reservations.ready) {
      return `${DURABLE_UNAVAILABLE_REASON}: the durable reservation authority is not ready`;
    }
    return null;
  }

  metrics(): CoordinatorMetricsSnapshot {
    const now = this.now();
    const tier = this.deps.reservations.diagnostics();
    return {
      activeExecutions: this.active.size,
      activeInstrumentReservations: this.deps.reservations.activeCount(now),
      waitingExecutions: this.waiting,
      reservationConflicts: this.stats.reservationConflicts,
      duplicateSuppressed: this.stats.duplicateSuppressed,
      underlyingExcluded: this.stats.underlyingExcluded,
      inventoryLimitRefusals: this.stats.inventoryLimitRefusals,
      expiredWhileWaiting: this.stats.expiredWhileWaiting,
      revalidationRejected: this.stats.revalidationRejected,
      revalidationPassed: this.stats.revalidationPassed,
      reservationsHeldOnUncertainty: this.stats.reservationsHeldOnUncertainty,
      failedClosed: this.stats.failedClosed,
      waitMs: {
        p50: this.waitSamples.percentile(0.5),
        p95: this.waitSamples.percentile(0.95),
        samples: this.waitSamples.samples,
      },
      store: this.deps.reservations.name,
      durable: this.deps.reservations.durable,

      reservationStore: this.deps.reservations.name,
      reservationDurability: this.deps.reservations.durable ? "durable" : "local_only",
      durableReservationsEnabled: this.deps.cfg.durableReservationsEnabled,
      durableReady: this.deps.reservations.ready,
      requireDurable: this.deps.cfg.reservationRequireDurable,
      durableAcquireAttempts: tier.acquireAttempts,
      durableAcquireSuccess: tier.acquireSuccess,
      durableConflicts: tier.conflicts,
      durableErrors: tier.errors,
      durableAcquireLatencyP50: tier.acquireLatencyP50Ms,
      durableAcquireLatencyP95: tier.acquireLatencyP95Ms,
      durableAcquireLatencyP99: tier.acquireLatencyP99Ms,
      reservationRenewSuccess: this.stats.renewSuccess,
      reservationRenewFailure: this.stats.renewFailure,
      reservationOwnershipLost: this.stats.ownershipLost,
      expiredReservationsObserved: tier.expiredReservationsObserved,
      durableUnavailableRefusals: this.stats.durableUnavailableRefusals,
      localOnlyFallbacks: this.stats.localOnlyFallbacks,
      staleGenerationAborts: this.stats.staleGenerationAborts,
      uncertainHoldsActive: this.holds.size,
      uncertainHoldsAbandoned: this.stats.uncertainHoldsAbandoned,
      clockOffsetMs: tier.clockOffsetMs,
    };
  }

  /**
   * The operator-facing health view.
   *
   * Separate from `metrics()` because it may carry a (scrubbed) error message, and
   * `metrics()` is contractually counts-and-statuses only. `liveEntryBlocked` is the
   * field a UI should surface loudly: it means the system is deliberately refusing to
   * open new Box exposure.
   */
  coordinationHealth(): CoordinationHealthSnapshot {
    const now = this.now();
    // `tierDiagnostics` is a chain-only affordance, so it is probed structurally rather
    // than added to the store interface every single-tier implementation would then have
    // to satisfy for no benefit.
    const maybeChain = this.deps.reservations as unknown as {
      tierDiagnostics?: () => ReservationStoreDiagnostics[];
    };
    const tiers =
      typeof maybeChain.tierDiagnostics === "function"
        ? maybeChain.tierDiagnostics()
        : [this.deps.reservations.diagnostics()];
    const durableTier = tiers.find((t) => t.durable) ?? null;
    const blocked = this.liveEntryBlockedReason();
    return {
      enabled: this.deps.cfg.executionCoordinatorEnabled,
      localStore: this.deps.local?.name ?? tiers[0]?.name ?? this.deps.reservations.name,
      durableStore: durableTier?.name ?? null,
      durableReady: durableTier?.ready ?? false,
      requireDurable: this.deps.cfg.reservationRequireDurable,
      liveEntryBlocked: blocked !== null,
      liveEntryBlockedReason: blocked,
      deployment: this.identity.deployment,
      broker: this.deps.broker(),
      generation: this.generation(),
      activeReservations: this.deps.reservations.activeCount(now),
      ownershipLosses: this.stats.ownershipLost,
      acquireP50Ms: durableTier?.acquireLatencyP50Ms ?? tiers[0]?.acquireLatencyP50Ms ?? null,
      acquireP95Ms: durableTier?.acquireLatencyP95Ms ?? tiers[0]?.acquireLatencyP95Ms ?? null,
      acquireP99Ms: durableTier?.acquireLatencyP99Ms ?? tiers[0]?.acquireLatencyP99Ms ?? null,
      durableLastError: durableTier?.lastError ?? null,
      tiers,
    };
  }
}

/**
 * Was the terminal state knowable?
 *
 * Residual exposure or a failure that implies orders may still be working means the
 * contract must stay reserved. `abort_after_fill` is explicitly CLEAN: the box was
 * briefly complete and fully reversed, so nothing is outstanding.
 */
function uncertaintyOf(result: unknown): "clean" | "uncertain" {
  if (typeof result !== "object" || result === null) return "uncertain";
  const r = result as {
    ok?: boolean;
    reason?: string;
    legging?: { residual_exposure?: unknown[] };
    record?: { residual_exposure?: unknown[] };
  };
  const residual = r.legging?.residual_exposure ?? r.record?.residual_exposure;
  if (Array.isArray(residual) && residual.length > 0) return "uncertain";
  if (r.ok === true) return "clean";
  if (r.reason === "legging_incomplete" || r.reason === "unwind_failed") return "uncertain";
  return "clean";
}

/**
 * A minimal record for a refusal that never reached the executor.
 *
 * Explicitly typed as `PaperLeggingExecutionRecord` rather than cast, so the compiler
 * keeps verifying it against the real shape — a cast here would silently rot the
 * moment a field is added to the record.
 */
function emptyLeggingRecord(
  mode: BoxConfig["executionMode"],
  detectedAt: number,
  now: number,
  reason: BoxExecutionFailureReason,
  detail: string,
): PaperLeggingExecutionRecord {
  return {
    mode: mode === "live" ? "live" : "paper_legging",
    leg_execution_mode: "parallel",
    remaining_role_count: 0,
    failure_reason: reason,
    failure_detail: detail,
    detected_at: detectedAt,
    order_sent_at: now,
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
    fills_by_role: {},
  };
}
