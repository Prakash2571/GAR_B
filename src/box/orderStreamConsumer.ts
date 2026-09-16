/**
 * ORDER-STREAM CONSUMER — the PRODUCTION component that makes a broker order-update stream
 * actually resolve fills, instead of merely relabelling status.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS / WHAT IT WIRES TOGETHER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Before this, every piece was built and unit-tested but nothing constructed and connected them:
 *
 *   transports          brokers/zerodha/orderUpdates.ts (parseKiteOrderFrame)
 *                       brokers/dhan/orderFeed.ts        (DhanOrderFeed / parseDhanOrderAlert)
 *   ONE truth           box/orderUpdateProjection.ts     (OrderUpdateProjection)
 *   the wake seam       box/{kite,dhan}BrokerAdapter.ts  (applyOrderUpdate → wakes order waiters)
 *   the health machine  box/streamHealthPolicy.ts        (OrderStreamStateMachine + permissions)
 *
 * This class owns ONE {@link OrderUpdateProjection} and ONE {@link OrderStreamStateMachine} per
 * active broker account, and is the single point where a normalized observation — from the stream
 * OR from REST — is (1) attributed and deduplicated through the projection, and (2) handed to the
 * adapter's {@link BrokerAdapter.applyOrderUpdate}, which re-validates the evidence, applies it
 * cumulative-monotonically to the session snapshot, and WAKES that order's waiters. That last step
 * is what makes a stream event resolve a live `waitForResolution` loop BEFORE its REST poll fires.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULES THIS CLASS ENFORCES (each maps to the task brief)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  - OWNERSHIP FIRST, BEFORE THE POST. {@link registerIntent} is called as the durable intent
 *    enters SUBMITTING — before the HTTP POST — so an event that beats the placement response has
 *    a ledger to land in. Account-wide events for orders we did not place are rejected as unowned.
 *  - ONE PROJECTION OF TRUTH. Stream and REST both funnel through the same projection, so dedup
 *    and monotonicity hold across both sources; a stream only ever makes the SAME truth arrive
 *    sooner, never a second, racing truth.
 *  - MISSING ≠ ZERO. An observation whose quantity is ABSENT (a Kite postback with no
 *    filled_quantity, a Dhan TRADED/CANCELLED with no TradedQty) is attributed but applies NO
 *    quantity; it schedules a targeted REST reconciliation to obtain the real figure. It is never
 *    read as a confirmed zero fill.
 *  - SOCKET-OPEN IS NOT READY. Health is driven by the state machine: only a completed
 *    reconciliation reaches READY. Loss → DISCONNECTED (bounded REST, no new entry, exposure
 *    management continues); reconnect → RECONCILING until the gap is repaired; auth reject →
 *    AUTH_EXPIRED. A missing event is never a zero fill.
 *
 * PURITY. This class holds no sockets and no timers of its own. The transports own the sockets and
 * call the lifecycle hooks; the clock is injected. REST reconciliation is a callback the caller
 * (which owns the adapter's REST transport) supplies, so this class never makes a network call.
 */

import {
  OrderUpdateProjection,
  type IngestResult,
  type NormalizedOrderObservation,
  type OrderStreamHealth,
  type OrderStreamState,
} from "./orderUpdateProjection.js";
import {
  OrderStreamStateMachine,
  type OperationPermissions,
  type OrderStreamAuthEvidence,
  type OrderStreamLifecycleState,
} from "./streamHealthPolicy.js";
import type { BrokerAdapter, ExternalOrderUpdate } from "./brokerAdapter.js";
import type { BrokerId } from "./latencyModel.js";

/** A box leg registered as durable intent, BEFORE the broker POST. */
export interface RegisterIntentArgs {
  readonly clientOrderId: string;
  /** Zerodha tag / Dhan correlationId — the stable strategy key echoed on every event. */
  readonly ownerTag: string;
  /**
   * The trading account (Kite user_id / Dhan ClientId), for foreign-account rejection.
   *
   * THREE DISTINCT STATES, and the difference between the last two is load-bearing:
   *
   *   "ZD1234"  — PROVEN. The caller knows which account owns this order. A frame naming a
   *               different account is foreign and is dropped.
   *   null      — UNPROVEN, ASSERTED. The caller has looked and cannot establish ownership (a
   *               durable row predating migration 011, which deliberately does not backfill).
   *               The account check is SKIPPED and the event is attributed on the owner tag
   *               alone, counted as `unverifiedAccount` so the gap stays visible.
   *   (omitted)  — NO OPINION. The caller has no account context at all, so the consumer may
   *               supply the current session account as a default.
   *
   * An explicit `null` is therefore NEVER upgraded to the session account. Doing so used to
   * convert "we could not verify" into a hard claim, and the projection would then reject a frame
   * naming the order's REAL (different) account as `foreign_account` — discarding a fill we own
   * and leaving real exposure unobserved. See {@link OrderStreamConsumer.registerIntent}.
   */
  readonly account?: string | null;
  readonly requestedQty: number;
  /** Known only after acknowledgement; a pre-POST registration passes null. */
  readonly brokerOrderId?: string | null;
}

export interface OrderStreamConsumerOptions {
  readonly broker: BrokerId;
  /** The active trading account, read fresh so a session change is reflected. */
  readonly account: () => string | null;
  /**
   * The live execution adapter. Its {@link BrokerAdapter.applyOrderUpdate} is the seam that wakes
   * order waiters; when absent (a paper deployment), observations still update the projection but
   * wake nothing — which is honest, because there is nothing live to wake.
   */
  readonly adapter?: Pick<BrokerAdapter, "applyOrderUpdate"> | null;
  /** Whether the order-update stream is armed at all. When false, this is a pure REST accountant. */
  readonly streamEnabled: boolean;
  /**
   * Targeted REST reconciliation for ONE order, invoked when a stream event is owned but carries
   * INSUFFICIENT quantity evidence. The caller owns the adapter's REST transport and feeds the
   * result back via {@link ingestRestObservation}; this class never makes a network call itself.
   * Fail-open: a reconciliation error must not throw into the ingestion path.
   */
  readonly restReconcile?: (clientOrderId: string) => Promise<void>;
  /**
   * The POST-RECONNECT GAP-REPAIR SWEEP (D4). Invoked by {@link runReconnectReconciliation} while
   * the machine is RECONCILING, this reconciles durable nonterminal orders and attributed
   * positions against the broker over REST. It is handed an `ingestRest` callback so every
   * observation it recovers is funnelled through the SAME single projection — so a gap fill and a
   * later stream redelivery of that same fill deduplicate and never double-count. The consumer
   * clears RECONCILING (→ READY) only AFTER this resolves consistently. Fail-open: a throwing
   * sweep leaves the machine RECONCILING and REST polling continues.
   */
  readonly reconcileSweep?: (
    ingestRest: (obs: IncomingObservation) => IngestResult,
  ) => Promise<ReconcileSweepOutcome | void>;
  /**
   * Bounded-retry shape for a sweep that FAILED or came back inconsistent. A reconciliation that
   * cannot complete must be retried — otherwise a single transient REST failure strands the stream in
   * RECONCILING until the next reconnect, which for a stable socket may be never — but it must not be
   * retried in a tight loop, because the recovery path shares the broker's rate-limit budget with the
   * cancels and exits that a degraded stream makes MORE likely to be needed. So retries back off
   * exponentially and are then capped, giving a steady, predictable worst-case call rate.
   */
  readonly reconcileRetryBaseMs?: number;
  readonly reconcileRetryMaxMs?: number;
  /**
   * Expected-idle bound (ms). A connected stream that delivers NO event for longer than this WHILE
   * a working order is outstanding is demoted to DEGRADED by {@link evaluateIdle} (D5). Silence on
   * an account with no working orders is NORMAL and never demotes. Default 15000.
   */
  readonly expectedIdleMs?: number;
  readonly now?: () => number;
}

/**
 * A single observation as the transports produce it, MINUS the source/time the consumer stamps.
 * `source` is filled in by the ingest method so a caller cannot mislabel a REST poll as a stream.
 */
export type IncomingObservation = Omit<NormalizedOrderObservation, "source"> & {
  readonly observedAtWall?: number | null;
  readonly observedAtMono?: number | null;
};

/**
 * THE VERDICT OF A RECONCILIATION SWEEP — not merely "did the promise resolve".
 *
 * A sweep that ran to completion has still proven nothing if what it FOUND was a durable order the
 * broker has never heard of, or a position that disagrees with our ledger. Resolving without throwing
 * is not synchronization; it is only the absence of a transport error. So the sweep reports an
 * explicit verdict and the consumer refuses to leave RECONCILING unless that verdict says the account
 * is genuinely consistent.
 *
 * A sweep may also return nothing at all (`void`). That is treated as a consistent verdict for
 * backwards compatibility with callers that predate this type, and is why the PRODUCTION sweep in
 * `engine.ts` returns an explicit object: silence must not be how production claims readiness.
 */
export interface ReconcileSweepOutcome {
  /** Whether the account is genuinely consistent and the stream may be trusted for new entry. */
  readonly synchronized: boolean;
  /** Operator-readable reason when `synchronized` is false. Never a secret. */
  readonly reason?: string;
  /** Durable orders the sweep could not resolve against the broker. */
  readonly unresolvedOrders?: number;
  /** Inconsistencies the sweep observed (missing orders, position mismatches). */
  readonly discrepancies?: number;
}

/**
 * SECTION 7 — THE ONE MAPPING from the governing lifecycle to the published order-stream state.
 *
 * TOTAL by construction (a `switch` over a closed union, so a future lifecycle state is a COMPILE
 * error here rather than a silent default). Because the published `state` is produced only by this
 * function, from only `OrderStreamStateMachine.state()`, it is not possible for the operator-facing
 * state to contradict the state that governs entry — which is exactly what defect (a) was.
 *
 * The mapping is deliberately conservative at every step: only a genuinely READY lifecycle (socket
 * up, authorised AND the reconciliation sweep completed) is published as `LIVE`. Everything else
 * names its real situation.
 */
export function publishedStateForLifecycle(lifecycle: OrderStreamLifecycleState): OrderStreamState {
  switch (lifecycle) {
    case "DISABLED":
      return "DISABLED";
    case "CONNECTING":
      return "CONNECTING";
    // A socket that has merely opened is NOT live: authorisation is still owed. It reports as
    // CONNECTING because that is what it still is from the operator's point of view.
    case "AUTHENTICATING":
      return "CONNECTING";
    case "RECONCILING":
      return "RECONNECTED_PENDING_RECONCILE";
    case "READY":
      return "LIVE";
    case "DEGRADED":
      return "DEGRADED";
    case "DISCONNECTED":
      return "DOWN";
    case "AUTH_EXPIRED":
      return "AUTH_EXPIRED";
  }
}

/**
 * Operator-readable sentence for a lifecycle state, used when it supersedes the projection's.
 *
 * `evidence` and `sweepFailure` are woven into the RECONCILING/AUTHENTICATING sentences on purpose.
 * The published `health` object is a CLOSED contract schema, so the honest reporting of
 * authentication uncertainty and of a stalled reconciliation has to travel through the free-form
 * `detail` field rather than through new fields that no frontend has agreed to yet. An operator
 * reading "authorisation is ASSUMED (Dhan publishes no acknowledgement)" is being told the truth that
 * `authorised: true` on its own would hide.
 */
function describeLifecycle(
  lifecycle: OrderStreamLifecycleState,
  evidence: OrderStreamAuthEvidence = "none",
  sweepFailure: string | null = null,
): string {
  const assumed =
    evidence === "login_submitted"
      ? " Authorisation is ASSUMED, not acknowledged: the login frame was sent and has not been " +
        "rejected, but this protocol publishes no authentication response, so only a successful " +
        "REST round trip can establish the session."
      : "";
  switch (lifecycle) {
    case "DISABLED":
      return "Order-update stream disabled — fills are observed by REST polling only.";
    case "CONNECTING":
      return "Connecting to the order-update stream…";
    case "AUTHENTICATING":
      return "Order-update socket open but not yet authorised — a route is not readiness.";
    case "RECONCILING":
      return (
        "Order-update stream connected — a REST reconciliation is owed before it is trusted." +
        assumed +
        (sweepFailure === null ? "" : ` Reconciliation is not complete: ${sweepFailure}`)
      );
    case "READY":
      return "Order-update stream live — fills observed here first, REST reconciles.";
    case "DEGRADED":
      return (
        "Order-update stream connected but NOT delivering (no event within the expected idle bound " +
        "while a fill is expected) — REST polling is observing fills. New entry is paused; exit, " +
        "reduction and protective cancel continue."
      );
    case "DISCONNECTED":
      return "Order-update stream is down — REST polling remains the source of truth.";
    case "AUTH_EXPIRED":
      return (
        "The session behind the order-update stream was rejected or expired — reconnecting with it " +
        "is pointless. REST polling observes fills; the broker will refuse all but a cancel."
      );
  }
}

/**
 * The minimum an adapter's returned order must expose for SETTLEMENT to be decided from the
 * adapter's own normalization rather than from a re-parsed broker label.
 */
interface BrokerOrderLike {
  readonly state?: string;
}

/**
 * The adapter-normalized states after which an order can produce no further events.
 *
 * These are `BrokerOrderState` values produced by the ADAPTERS (kiteState / dhanOrderState), NOT raw
 * broker labels — which is the point. `TRADED` (Dhan) and `COMPLETE` (Kite) and `CLOSED` and
 * `EXPIRED` all mean different things at different brokers; each adapter already resolves its own
 * vocabulary, including the contradictory cases (a `TRADED` label with a short fill becomes
 * PARTIALLY_FILLED, not COMPLETE). Consuming the resolved state keeps that difference in the
 * adapters and stops a second, drifting status mapper appearing here.
 */
const TERMINAL_ORDER_STATES: ReadonlySet<string> = new Set([
  "COMPLETE",
  "CANCELLED",
  "REJECTED",
]);

/** Compare status labels as opaque, trimmed, upper-cased strings. No vocabulary interpretation. */
function normaliseStatusLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toUpperCase();
  return trimmed === "" ? null : trimmed;
}

export class OrderStreamConsumer {
  private readonly proj = new OrderUpdateProjection();
  private readonly machine: OrderStreamStateMachine;
  private readonly opts: OrderStreamConsumerOptions;
  /** Client order ids for which a targeted REST reconciliation is outstanding. Bounded by orders. */
  private readonly pendingReconciliations = new Set<string>();
  private streamEventsApplied = 0;
  private streamEventsWokeAdapter = 0;
  private absentEvidenceEvents = 0;
  /**
   * WORKING ORDERS — the orders we are actually EXPECTING events for (D5). An order enters here on
   * registerIntent and leaves when it is observed complete (cumulative ≥ requested) or explicitly
   * settled by the manager. Idleness is only evidence of a problem when this set is non-empty:
   * a quiet stream on an account with nothing working is normal, not degraded.
   */
  private readonly workingOrders = new Set<string>();
  /** Requested quantity per registered order, so a completing observation can settle it. */
  private readonly requestedQtyOf = new Map<string, number>();
  /** Wall-clock ms of the last event delivered by the STREAM (never a REST poll). */
  private lastStreamEventAtWall: number | null = null;
  private readonly expectedIdleMs: number;
  /**
   * The single in-flight reconciliation sweep, or null. Present so duplicate connection callbacks and
   * the status-path poll driver COALESCE onto one sweep per broker account instead of each launching
   * their own — which would multiply REST load on exactly the path that also has to serve recovery.
   */
  private sweepInFlight: Promise<void> | null = null;
  /**
   * The connection epoch the in-flight sweep was started under. Coalescing is scoped to this: joining
   * a sweep from a SUPERSEDED connection would leave the current connection reconciled by nothing,
   * because that sweep's result is going to be discarded.
   */
  private sweepInFlightGeneration: number | null = null;
  /** Consecutive failed/inconsistent sweeps, driving the bounded exponential backoff. */
  private sweepAttempts = 0;
  /** Earliest wall time at which another sweep may be attempted. Null ⇒ no restriction. */
  private nextSweepNotBeforeWall: number | null = null;
  /** Why the last sweep did not synchronize. Operator-visible; never a secret. */
  private lastSweepFailure: string | null = null;
  private lastSweepUnresolvedOrders = 0;
  private lastSweepDiscrepancies = 0;
  private sweepsStarted = 0;
  private sweepsSynchronized = 0;
  private sweepsDiscardedStaleEpoch = 0;
  /**
   * THE NON-QUANTITY MEMO — what order management has already been told about each order, on the two
   * tracks the cumulative ledger does not own: the status LABEL and the average price. It exists so a
   * genuine transition always propagates while an unchanged re-poll does not, WITHOUT the consumer
   * having to interpret either broker's status vocabulary. Bounded by the number of registered orders.
   */
  private readonly lastForwarded = new Map<
    string,
    { status: string | null; price: number | null; terminal: boolean }
  >();
  /** Forwards that carried a status change with no quantity change — the class that used to vanish. */
  private statusOnlyForwards = 0;
  /** Forwards that carried only an average-price enrichment. Must never create a fill. */
  private priceOnlyForwards = 0;
  /** Orders settled because the ADAPTER reported a terminal state (including zero-fill terminals). */
  private terminalSettlements = 0;
  /** Observations whose quantity was impossible (non-finite/negative). Escalated, never applied. */
  private invalidQuantityObservations = 0;
  /** Observations where the broker reported more filled than requested. Applied and escalated. */
  private overfillObservations = 0;
  /** Non-terminal labels observed after a terminal one. Counted and reconciled, never adopted. */
  private contradictoryTerminalObservations = 0;

  constructor(opts: OrderStreamConsumerOptions) {
    this.opts = opts;
    this.machine = new OrderStreamStateMachine(opts.streamEnabled);
    this.proj.setStreamEnabled(opts.streamEnabled);
    this.expectedIdleMs = Math.max(0, opts.expectedIdleMs ?? 15_000);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /* ─────────────────────────── ownership registration (before the POST) ─────────────────────────── */

  /**
   * Register a box leg as durable intent enters SUBMITTING — BEFORE the broker POST.
   *
   * This is the durable-intent-first ordering: an order-update that beats the placement HTTP
   * response has a ledger to land in, and an account-wide event for an order we DID place is
   * attributable the instant it arrives. Idempotent (re-registering keeps the same ledger).
   */
  registerIntent(args: RegisterIntentArgs): void {
    this.proj.register({
      clientOrderId: args.clientOrderId,
      ownerTag: args.ownerTag,
      account: this.registeredOwnershipAccount(args),
      requestedQty: args.requestedQty,
      brokerOrderId: args.brokerOrderId ?? null,
    });
    // A freshly registered order is a WORKING order: we now EXPECT fill/terminal events for it, so
    // stream silence past the idle bound becomes evidence of a problem (D5). It leaves the set when
    // observed complete or explicitly settled.
    this.requestedQtyOf.set(args.clientOrderId, args.requestedQty);
    if (args.requestedQty > 0) this.workingOrders.add(args.clientOrderId);
  }

  /**
   * THE ACCOUNT THIS REGISTRATION ACTUALLY PROVES — never a fabricated one.
   *
   * This used to be `args.account ?? this.opts.account() ?? null`, which collapsed two
   * different claims into one. `??` cannot tell an EXPLICIT null ("I looked; ownership is
   * unproven") from an OMITTED field ("I have no account context"), so it silently answered both
   * with the CURRENT SESSION account.
   *
   * That substitution is unsound because the session account is the account signed in NOW, not
   * the account that placed the order. The manager's only production caller
   * (`registerStreamOwnership`) passes `intent.broker_account ?? null` precisely so an unproven
   * row stays unproven — and this method used to overwrite that decision. The consequence was
   * concrete: the projection stores a non-null expected account as a HARD gate, so a later frame
   * naming the order's real (different) account was rejected as `foreign_account` and an owned
   * fill was discarded, leaving live exposure unobserved while we waited on REST.
   *
   * `in` is the discriminator rather than a `=== undefined` test because `exactOptionalPropertyTypes`
   * makes "present but undefined" unrepresentable for a caller in TypeScript; a blank/whitespace
   * string is also treated as unproven rather than as an account named "".
   */
  private registeredOwnershipAccount(args: RegisterIntentArgs): string | null {
    if ("account" in args) {
      const asserted = typeof args.account === "string" ? args.account.trim() : "";
      // An explicit null (or blank) is the caller's ASSERTION of unproven ownership. Preserve it.
      return asserted === "" ? null : asserted;
    }
    const session = this.opts.account();
    const current = typeof session === "string" ? session.trim() : "";
    return current === "" ? null : current;
  }

  /**
   * Explicitly settle an order that will produce no further events (a confirmed cancel/reject with
   * residual, a fully-reconciled terminal). The manager calls this so a cancelled-with-residual
   * order does not keep the idle detector expecting events that will never come.
   */
  markOrderSettled(clientOrderId: string): void {
    this.workingOrders.delete(clientOrderId);
  }

  /** How many orders are currently WORKING (events expected). For diagnostics and the idle gate. */
  workingOrderCount(): number {
    return this.workingOrders.size;
  }

  /** Bind a broker order id to the durable client identity once the broker reports it. */
  learnBrokerOrderId(clientOrderId: string, brokerOrderId: string | null): void {
    this.proj.learnBrokerOrderId(clientOrderId, brokerOrderId);
  }

  /* ─────────────────────────── observation ingestion ─────────────────────────── */

  /**
   * Ingest ONE observation from the broker STREAM (a Kite postback text frame or a Dhan
   * order_alert). Attributes and deduplicates through the projection, then — when a quantity was
   * present and it is ours — hands it to the adapter to wake waiters. When the quantity is ABSENT,
   * it schedules a targeted REST reconciliation rather than fabricating a zero.
   */
  ingestStreamObservation(obs: IncomingObservation): IngestResult {
    return this.ingest(obs, "order_update");
  }

  /**
   * Ingest ONE observation from a REST source (a poll, a correlation lookup, or the reconciliation
   * sweep). Same projection, so it deduplicates against the stream and cannot double-count. A REST
   * source never refreshes stream liveness (the projection enforces that), so a poll can never make
   * a dead stream look alive.
   */
  ingestRestObservation(
    obs: IncomingObservation,
    source: "rest_poll" | "reconciliation" = "rest_poll",
  ): IngestResult {
    const result = this.ingest(obs, source);
    if (result.clientOrderId && result.quantityEvidence === "confirmed") {
      this.pendingReconciliations.delete(result.clientOrderId);
    }
    return result;
  }

  private ingest(obs: IncomingObservation, source: NormalizedOrderObservation["source"]): IngestResult {
    const stamped: NormalizedOrderObservation = {
      ...obs,
      source,
      observedAtWall: obs.observedAtWall ?? this.now(),
      observedAtMono: obs.observedAtMono ?? null,
    };
    const result = this.proj.ingest(stamped);

    // STREAM LIVENESS (D5). A genuine stream delivery — with or without a quantity — proves the
    // socket is delivering RIGHT NOW, so it resets the idle clock. A REST poll never does this, so
    // a poll can never mask a dead stream as alive.
    if ((source === "order_update" || source === "postback") && result.attributed) {
      this.lastStreamEventAtWall = stamped.observedAtWall ?? this.now();
    }

    // AN IMPOSSIBLE QUANTITY IS A RECONCILIATION CONDITION, NOT A NO-OP.
    //
    // The projection refuses a non-finite or NEGATIVE cumulative quantity as `malformed` before the
    // ledger ever sees it — correctly, since such a figure is not information and must never touch
    // exposure. But refusing it silently would mean a broker sending impossible numbers looked exactly
    // like a broker sending nothing. It is counted here so it is visible and auditable.
    //
    // HONEST LIMITATION: a malformed observation is rejected before attribution, so there is no
    // clientOrderId to target a reconcile at. The periodic account-wide reconcile is the backstop, and
    // the counter is what tells an operator to go looking.
    if (result.rejection === "malformed") {
      this.invalidQuantityObservations++;
      return result;
    }

    if (!result.attributed || result.clientOrderId === null) return result;

    if (result.quantityEvidence === "absent") {
      // INSUFFICIENT EVIDENCE. Owned, but no quantity — never a zero fill. Obtain the truth by
      // targeted REST reconciliation, and wake the adapter's waiter with an ABSENT quantity so a
      // status-only frame does not stall the loop but also does not fabricate a fill.
      this.absentEvidenceEvents++;
      const merged = this.applyToAdapter(result.clientOrderId, stamped, /* quantityAbsent */ true);
      this.noteForwarded(result.clientOrderId, stamped);
      this.settleIfTerminal(result.clientOrderId, merged, result);
      this.scheduleReconciliation(result.clientOrderId);
      return result;
    }

    /*
     * ───────────────────────────────────────────────────────────────────────────────────────────
     * THREE INDEPENDENT TRACKS, ONE OBSERVATION.
     * ───────────────────────────────────────────────────────────────────────────────────────────
     * This used to be a single condition:
     *
     *     if (result.apply.outcome === "applied" || outcome === "applied_overfill") applyToAdapter(...)
     *
     * i.e. an observation reached order management ONLY when the cumulative FILLED QUANTITY had
     * increased. Quantity is not the only thing an order update carries, so that conflation silently
     * dropped whole classes of update:
     *
     *   - OPEN(0) → CANCELLED(0): the cumulative is 0 both times, so the ledger returns
     *     `stale_cumulative` and the CANCELLATION never reached order management. The order stayed
     *     "working" until a REST poll happened to notice, and the leg's waiter was never woken.
     *   - OPEN(0) → REJECTED(0): identical, and worse — a rejection is precisely the event a caller
     *     is waiting on to stop.
     *   - PARTIAL(q) → CANCELLED(q): same cumulative q, so the cancellation of the REMAINDER
     *     vanished while the fill was (correctly) kept.
     *   - A later average-price enrichment at unchanged quantity was dropped entirely.
     *
     * So the three tracks are now scored separately:
     *   1. EXECUTED QUANTITY — owned exclusively by the cumulative ledger above. Monotonic,
     *      idempotent, and the ONLY thing that may create exposure.
     *   2. LIFECYCLE / STATUS — a change in the broker's status LABEL is meaningful state even when
     *      the quantity is untouched.
     *   3. EXECUTION ENRICHMENT — a change in average price for quantity we already hold.
     *
     * FORWARDING A STATUS CHANGE CANNOT CREATE A FILL. `applyToAdapter` passes the SAME confirmed
     * cumulative the ledger just deduplicated, and every adapter's `applyOrderUpdate` is
     * cumulative-monotonic (it refuses a quantity below what it already holds and never re-adds a
     * delta). So track 2 and track 3 move status and price only. That is what keeps requirement
     * "price enrichment at unchanged quantity must not create another fill" true by construction
     * rather than by care.
     *
     * NOTE ON INTERPRETATION. This class deliberately does NOT parse broker status vocabularies —
     * `TRADED`, `PART_TRADED`, `COMPLETE`, `CLOSED` and `EXPIRED` mean different things at the two
     * brokers, and that normalization belongs in the adapters (kiteState / dhanOrderState), which
     * already do it. Here the status is compared as an opaque string, and the adapter's OWN
     * normalized `state` on the value it returns is what decides settlement below. No second,
     * drifting status mapper is introduced.
     */
    const outcome = result.apply?.outcome ?? null;
    const quantityAdvanced = outcome === "applied" || outcome === "applied_overfill";
    // The SAME broker event, redelivered. By definition it carries nothing new, on any track, so it
    // must not reach order management: that is what stops a redelivery from duplicating a fill, a
    // recovery action or a P&L entry.
    const sameEventRedelivered = outcome === "duplicate_event";
    const change = this.classifyNonQuantityChange(result.clientOrderId, stamped);

    // An IMPOSSIBLE quantity that reached the ledger (rather than being caught as `malformed` above)
    // is not information and must never be applied — but it IS a discrepancy that wants REST
    // resolution rather than silence. Here we DO have an attributed order to target.
    if (outcome === "invalid") {
      this.invalidQuantityObservations++;
      this.scheduleReconciliation(result.clientOrderId);
      return result;
    }
    // The broker says MORE filled than we asked for. Applied (broker truth wins) and escalated: our
    // own quantity model was wrong, which is a reconciliation condition, not a rounding note.
    if (outcome === "applied_overfill") {
      this.overfillObservations++;
      this.scheduleReconciliation(result.clientOrderId);
    }
    // A non-terminal status observed AFTER a terminal one is contradictory. The adapter refuses to
    // regress its own terminal state, so this cannot corrupt the lifecycle; it is counted and
    // reconciled so a genuine broker disagreement is not merely absorbed.
    if (change.contradictsTerminal) {
      this.contradictoryTerminalObservations++;
      this.scheduleReconciliation(result.clientOrderId);
    }

    if (!sameEventRedelivered && (quantityAdvanced || change.statusChanged || change.priceChanged)) {
      const merged = this.applyToAdapter(result.clientOrderId, stamped, /* quantityAbsent */ false);
      if (change.statusChanged) this.statusOnlyForwards += quantityAdvanced ? 0 : 1;
      if (change.priceChanged && !change.statusChanged && !quantityAdvanced) this.priceOnlyForwards++;
      this.noteForwarded(result.clientOrderId, stamped);
      this.settleIfTerminal(result.clientOrderId, merged, result);
      return result;
    }

    // Nothing new on any track. Still let a fully-filled order settle, since a re-poll of an order
    // that completed while we were not looking is a legitimate way to learn it is done.
    this.settleIfTerminal(result.clientOrderId, undefined, result);
    return result;
  }

  /**
   * Compare an observation's NON-QUANTITY content against the last thing forwarded for this order.
   *
   * Pure comparison, no broker vocabulary interpretation. The point of the memo is to answer "does
   * order management already know this?" so that a REST poll repeating an unchanged snapshot every
   * second does not wake waiters and inflate counters, while a genuine transition always does.
   *
   * After a RESTART the memo is empty, so the first observation of each order forwards. That is
   * correct rather than merely tolerable: a fresh process has told the adapter nothing, and the
   * forward is idempotent because the adapter is cumulative-monotonic. Deduplication across a restart
   * is carried by the broker's own cumulative quantity (re-established by the reconciliation sweep),
   * not by remembered event ids — which is why no new persistence is required here.
   */
  private classifyNonQuantityChange(
    clientOrderId: string,
    obs: NormalizedOrderObservation,
  ): { statusChanged: boolean; priceChanged: boolean; contradictsTerminal: boolean } {
    const status = normaliseStatusLabel(obs.rawStatus);
    const price = obs.averagePrice != null && Number.isFinite(obs.averagePrice) ? obs.averagePrice : null;
    const prior = this.lastForwarded.get(clientOrderId);
    if (!prior) {
      return {
        statusChanged: status !== null,
        priceChanged: price !== null,
        contradictsTerminal: false,
      };
    }
    return {
      statusChanged: status !== null && status !== prior.status,
      // A price only counts as new when it is actually a different number. Re-reporting the same
      // average price is not enrichment.
      priceChanged: price !== null && price !== prior.price,
      contradictsTerminal: prior.terminal && status !== null && status !== prior.status,
    };
  }

  private noteForwarded(clientOrderId: string, obs: NormalizedOrderObservation): void {
    const status = normaliseStatusLabel(obs.rawStatus);
    const prior = this.lastForwarded.get(clientOrderId);
    this.lastForwarded.set(clientOrderId, {
      status: status ?? prior?.status ?? null,
      price:
        obs.averagePrice != null && Number.isFinite(obs.averagePrice)
          ? obs.averagePrice
          : (prior?.price ?? null),
      // Terminality is sticky: once order management has been told this order reached a terminal
      // state, a later non-terminal label is a contradiction to report, not a state to adopt.
      terminal: prior?.terminal === true,
    });
  }

  /**
   * Remove an order from the WORKING set once it can produce no further events.
   *
   * TWO independent grounds, because the old single ground was wrong:
   *   - the ADAPTER's own normalized state is terminal. This is what makes OPEN(0) → CANCELLED(0)
   *     and OPEN(0) → REJECTED(0) settle correctly: a zero-fill terminal leaves `remaining` at the
   *     full requested quantity, so the old `remaining <= 0` test never fired and the idle detector
   *     went on expecting events for an order that was already dead — eventually demoting a
   *     perfectly healthy stream to DEGRADED and refusing new entry for it.
   *   - the ledger reports nothing outstanding (a full fill).
   *
   * The terminal ground uses the state the ADAPTER computed, so the per-broker vocabulary difference
   * stays in the adapter where it belongs.
   */
  private settleIfTerminal(
    clientOrderId: string,
    merged: BrokerOrderLike | undefined,
    result: IngestResult,
  ): void {
    const state = merged?.state;
    if (typeof state === "string" && TERMINAL_ORDER_STATES.has(state)) {
      const memo = this.lastForwarded.get(clientOrderId);
      if (memo) this.lastForwarded.set(clientOrderId, { ...memo, terminal: true });
      this.workingOrders.delete(clientOrderId);
      this.terminalSettlements++;
      return;
    }
    if (result.apply && result.apply.remaining <= 0) {
      this.workingOrders.delete(clientOrderId);
    }
  }

  private applyToAdapter(
    clientOrderId: string,
    obs: NormalizedOrderObservation,
    quantityAbsent: boolean,
  ): BrokerOrderLike | undefined {
    const adapter = this.opts.adapter;
    if (!adapter?.applyOrderUpdate) return undefined;
    const update: ExternalOrderUpdate = {
      clientOrderId,
      brokerOrderId: obs.brokerOrderId ?? null,
      // ABSENT quantity is conveyed as `undefined` so the adapter's `readNonNegativeInteger` sees a
      // genuine gap — a fabricated 0 would let a terminal label terminalise on nothing.
      cumulativeQty: quantityAbsent ? (undefined as unknown as number) : obs.cumulativeQty,
      averagePrice: obs.averagePrice ?? null,
      rawStatus: obs.rawStatus ?? null,
      observedAtWall: obs.observedAtWall ?? this.now(),
    };
    try {
      const merged = adapter.applyOrderUpdate(update);
      this.streamEventsApplied++;
      if (merged) this.streamEventsWokeAdapter++;
      // Returned so the caller can read the ADAPTER's normalized order state for settlement, rather
      // than re-deriving terminality from a broker status label here.
      return merged as BrokerOrderLike | undefined;
    } catch {
      // A single order's apply fault must never break stream ingestion for the others.
      return undefined;
    }
  }

  private scheduleReconciliation(clientOrderId: string): void {
    if (!this.opts.restReconcile) return;
    if (this.pendingReconciliations.has(clientOrderId)) return;
    this.pendingReconciliations.add(clientOrderId);
    void Promise.resolve()
      .then(() => this.opts.restReconcile?.(clientOrderId))
      .catch(() => {
        // Fail-open: leave the pending flag so a later sweep retries; never throw into ingestion.
      });
  }

  /* ─────────────────────────── transport lifecycle → health ─────────────────────────── */

  onConnecting(): void {
    this.machine.onConnecting();
    this.proj.onStreamConnecting();
  }

  /** Socket open — NOT ready. Authorisation and synchronization are still owed. */
  onSocketOpen(): void {
    this.machine.onSocketOpen();
  }

  /**
   * The login frame has been submitted and the transport believes the session is usable. Always
   * enters RECONCILING (a gap is owed, even on first connect).
   *
   * `evidence` says how strong that belief is. It defaults to `login_submitted` — the honest reading
   * for Dhan, whose order-update socket sends no authentication acknowledgement, so "authorised" on
   * open is an assumption that only a successful REST round trip can upgrade. Passing
   * `broker_acknowledged` is reserved for a transport that genuinely received one.
   *
   * A repeat call for a connection already being reconciled is absorbed by the machine, so duplicate
   * transport callbacks cannot advance the epoch out from under the sweep they just triggered.
   */
  onAuthenticated(evidence: OrderStreamAuthEvidence = "login_submitted"): void {
    const reconnect = this.machine.isReconnect();
    const priorGeneration = this.machine.generation();
    this.machine.onAuthenticated(evidence);
    if (this.machine.generation() === priorGeneration) {
      // Duplicate callback for the epoch already in flight: no new gap, nothing to re-arm.
      return;
    }
    this.proj.onStreamConnected({ authorised: true, reconnect });
    // A new epoch invalidates any backoff earned by the previous connection's failures: this
    // connection deserves an immediate first attempt.
    this.sweepAttempts = 0;
    this.nextSweepNotBeforeWall = null;
    // A fresh (re)connect resets the idle clock: silence is measured from when the socket became
    // authorised, not from a stale pre-disconnect event.
    this.lastStreamEventAtWall = this.now();
  }

  /**
   * The reconnect reconciliation sweep is complete and consistent. ONLY path to READY. The caller
   * invokes this AFTER it has fed every reconciled REST observation back via ingestRestObservation.
   *
   * `atGeneration` scopes the claim to one connection epoch. A caller that did asynchronous work
   * MUST pass the generation it captured before starting, so a late result cannot promote a newer
   * connection whose gap it never examined. Returns whether the claim was actually applied.
   */
  markSynchronized(atGeneration?: number): boolean {
    const applied = this.machine.markSynchronized(atGeneration);
    if (applied) this.proj.markReconciled();
    return applied;
  }

  /** The current connection epoch, for a caller that must scope an asynchronous claim to it. */
  connectionGeneration(): number {
    return this.machine.generation();
  }

  /**
   * Record positive proof that the session behind the stream is authorised, obtained out-of-band from
   * a successful REST call on the same credentials. Does not change the lifecycle state: a working
   * REST session is not evidence that the SOCKET is delivering.
   */
  noteRestVerifiedSession(): void {
    this.machine.noteRestVerifiedSession();
  }

  /**
   * DRIVE THE POST-RECONNECT GAP-REPAIR SWEEP TO COMPLETION (D4).
   *
   * Called by the caller (the engine) whenever the machine is RECONCILING — on first connect and
   * on every reconnect. It runs the injected {@link OrderStreamConsumerOptions.reconcileSweep},
   * handing it an `ingestRest` funnel so every recovered observation goes through the SAME single
   * projection: a fill that happened in the disconnect gap (which the broker does NOT replay) is
   * recovered and counted exactly once, and a stream event that arrives DURING the sweep merges
   * monotonically without double-counting. Only AFTER the sweep resolves does the machine leave
   * RECONCILING (→ READY). Fail-open: a throwing sweep leaves it RECONCILING and REST continues.
   *
   * Idempotent and safe to poll: it is a no-op unless a reconciliation is actually owed.
   */
  async runReconnectReconciliation(): Promise<void> {
    // COALESCE DUPLICATE CONNECTION CALLBACKS INTO BOUNDED WORK — BUT ONLY WITHIN ONE EPOCH.
    //
    // A transport may report the SAME connection more than once (Dhan's onopen fires per socket, and
    // the engine also polls this from the status path), so those callers must join the sweep already
    // running rather than each starting their own against the same account.
    //
    // Coalescing must NOT cross a connection boundary, though. A sweep for a connection that has since
    // dropped is going to be DISCARDED by the stale-epoch guard, so joining it would leave the NEW
    // connection with no sweep of its own — reconciled by nothing, waiting on a result that can never
    // apply to it. That is the opposite of the fix. So a caller whose epoch differs from the in-flight
    // sweep's starts a fresh sweep for its own epoch; the superseded one still resolves and is still
    // discarded. Concurrent REST load stays bounded at one sweep per live epoch, and the order
    // manager's own `reconcile()` coalescing collapses the overlap anyway.
    const inFlight = this.sweepInFlight;
    if (inFlight !== null && this.sweepInFlightGeneration === this.machine.generation()) {
      return inFlight;
    }
    if (!this.reconcilePending()) return;
    const sweep = this.opts.reconcileSweep;
    if (!sweep) {
      // No explicit sweep supplied: nothing can prove consistency, so stay RECONCILING. This is
      // deliberately conservative — a gap that cannot be repaired must not silently read READY.
      this.lastSweepFailure =
        "no reconciliation sweep is wired, so nothing can prove the account is synchronized";
      return;
    }
    // CAPTURE THE EPOCH BEFORE THE AWAIT. Everything below is asynchronous and the socket may drop,
    // the session may be rejected, or a NEWER connection may authorise while it runs. The result is
    // only allowed to apply to the connection it actually examined.
    const startedAtGeneration = this.machine.generation();
    // PUBLISH THE IN-FLIGHT BARRIER SYNCHRONOUSLY, before any of the sweep's own code can run. If the
    // barrier were only installed after `executeSweep` had already reached its first await, a
    // re-entrant call — from inside the sweep, or from a socket callback the sweep provokes — would
    // find no sweep in flight and launch a second one against the same broker account. That is the
    // re-entrant sweep loop this must not have.
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sweepInFlight = barrier;
    this.sweepInFlightGeneration = startedAtGeneration;
    try {
      await this.executeSweep(sweep, startedAtGeneration);
    } finally {
      // Only clear if this sweep is still the registered one: a newer epoch's sweep may have replaced
      // it while this one was resolving, and clearing then would drop the newer sweep's guard.
      if (this.sweepInFlight === barrier) {
        this.sweepInFlight = null;
        this.sweepInFlightGeneration = null;
      }
      release();
    }
  }

  private async executeSweep(
    sweep: NonNullable<OrderStreamConsumerOptions["reconcileSweep"]>,
    startedAtGeneration: number,
  ): Promise<void> {
    this.sweepsStarted++;
    let outcome: ReconcileSweepOutcome | void;
    try {
      outcome = await sweep((obs) => this.ingestRestObservation(obs, "reconciliation"));
    } catch (err) {
      // Fail-CLOSED for readiness, fail-open for control flow: the machine stays RECONCILING (no new
      // entry) and REST polling continues, but this never throws into a socket callback.
      this.noteSweepFailure(
        startedAtGeneration,
        `reconciliation sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // STALE-EPOCH GUARD. If the connection this sweep examined is gone, its verdict — good or bad —
    // describes a session that no longer exists. Discard it rather than let it promote whatever
    // connection happens to be current now.
    if (startedAtGeneration !== this.machine.generation()) {
      this.sweepsDiscardedStaleEpoch++;
      this.lastSweepFailure =
        "a reconciliation result arrived for a superseded connection and was discarded; " +
        "the current connection still owes its own reconciliation";
      return;
    }

    // CHECK THE RESULT, NOT JUST THE PROMISE. `undefined` is the legacy "no verdict" shape and is
    // treated as consistent; production supplies an explicit verdict.
    if (outcome && outcome.synchronized !== true) {
      const detail = outcome.reason ?? "the reconciliation sweep reported the account inconsistent";
      this.noteSweepFailure(startedAtGeneration, detail, outcome);
      return;
    }

    // The sweep completed, its verdict is consistent, and every recovered observation is in the
    // single projection. NOW the machine may leave RECONCILING — and only for THIS epoch.
    const applied = this.machine.markSynchronized(startedAtGeneration);
    if (!applied) {
      this.sweepsDiscardedStaleEpoch++;
      return;
    }
    this.proj.markReconciled();
    this.sweepsSynchronized++;
    this.sweepAttempts = 0;
    this.nextSweepNotBeforeWall = null;
    this.lastSweepFailure = null;
    this.lastSweepUnresolvedOrders = outcome?.unresolvedOrders ?? 0;
    this.lastSweepDiscrepancies = outcome?.discrepancies ?? 0;
  }

  /** Record a failed/inconsistent sweep and arm a bounded, backed-off retry for the same epoch. */
  private noteSweepFailure(
    atGeneration: number,
    reason: string,
    outcome?: ReconcileSweepOutcome,
  ): void {
    this.lastSweepFailure = reason;
    if (outcome) {
      this.lastSweepUnresolvedOrders = outcome.unresolvedOrders ?? 0;
      this.lastSweepDiscrepancies = outcome.discrepancies ?? 0;
    }
    // Only schedule a retry for a connection that still exists. A drop/loss already re-owes a
    // reconciliation and will drive a fresh one on the next connect.
    if (atGeneration !== this.machine.generation()) return;
    this.sweepAttempts++;
    const base = Math.max(250, this.opts.reconcileRetryBaseMs ?? 2_000);
    const max = Math.max(base, this.opts.reconcileRetryMaxMs ?? 60_000);
    const delay = Math.min(max, base * 2 ** Math.min(8, this.sweepAttempts - 1));
    this.nextSweepNotBeforeWall = this.now() + delay;
  }

  /**
   * POLL-SAFE RECONCILIATION DRIVER — the piece that makes "reconcile on initial connection and every
   * relevant reconnect" true even when a sweep fails.
   *
   * The engine calls this wherever it already reads order-stream state, so a reconciliation that is
   * owed is always being driven towards completion by SOMETHING, rather than depending on a connection
   * edge that may not recur for hours on a stable socket. It is cheap and self-guarding:
   *   - it does nothing unless a reconciliation is actually owed;
   *   - it does nothing while the socket is down or the session is rejected (there is nothing to
   *     synchronize a dead connection against, and hammering REST there would burn the rate-limit
   *     budget that exits and cancels need);
   *   - it respects the bounded backoff armed by the previous failure, so the worst-case REST call
   *     rate from recovery is capped.
   *
   * It deliberately does NOT await: it is called from status/gate reads that must not block.
   */
  ensureReconciled(nowWall?: number): void {
    if (!this.reconcilePending()) return;
    // Epoch-scoped, for the same reason the coalescing above is: a sweep still resolving for a
    // SUPERSEDED connection must not stop the CURRENT connection from starting the sweep that will
    // actually be allowed to promote it.
    if (this.sweepInFlight !== null && this.sweepInFlightGeneration === this.machine.generation()) return;
    if (!this.opts.reconcileSweep) return;
    const state = this.machine.state();
    // Only a live, authorised connection can be synchronized. DISCONNECTED/AUTH_EXPIRED/DISABLED all
    // owe a reconciliation, but it is the next successful connect that must drive it.
    if (state !== "RECONCILING" && state !== "DEGRADED" && state !== "READY") return;
    const now = nowWall ?? this.now();
    const notBefore = this.nextSweepNotBeforeWall;
    if (notBefore !== null && now < notBefore) return;
    void this.runReconnectReconciliation();
  }

  /** Connected but not delivering usable events within the expected idle bound. */
  onIdle(): void {
    this.machine.onIdle();
    // SECTION 7 / defect (a). The PROJECTION must hear this too. It used to be told nothing, so
    // `health()` — the surface an operator reads — went on reporting LIVE while the lifecycle that
    // governs entry had already degraded. Two truths, one of them flattering.
    this.proj.onStreamIdle();
  }

  /**
   * DRIVE THE ZERODHA MULTIPLEXED-QUOTE-SOCKET LIFECYCLE (D6).
   *
   * Zerodha carries order postbacks as TEXT frames on the SAME quote socket that carries the
   * ticks (docs/BROKER_STREAM_DOCS.md), so there is no separate order socket to open — the
   * order-stream health MUST be driven by the quote socket's connection lifecycle. A
   * `connected=true` edge means the quote socket is open AND authorised (the box lane only opens
   * once it holds credentials), so this walks CONNECTING → socket-open → authenticated, landing in
   * RECONCILING, and drives the post-(re)connect gap-repair sweep (D4) to completion — the only
   * path to READY. A `connected=false` edge is a disconnect. Inert when the stream is DISABLED.
   *
   * Returns the promise of the reconnect reconciliation so a caller may await it in tests; in
   * production the engine fires it and does not block the socket callback.
   */
  driveQuoteSocketLifecycle(connected: boolean): Promise<void> {
    if (this.machine.state() === "DISABLED") return Promise.resolve();
    if (connected) {
      this.onConnecting();
      this.onSocketOpen();
      // ZERODHA'S AUTHORISATION IS ACKNOWLEDGED BY THE HANDSHAKE ITSELF. The Kite quote socket
      // carries `api_key` + `access_token` in the connection request and the broker REFUSES the
      // handshake when they are invalid, so an OPEN socket is a positive acceptance of the
      // credentials — materially stronger evidence than Dhan's unacknowledged login frame. This is
      // the one place a `broker_acknowledged` claim is justified, and it is justified by the
      // transport's own semantics rather than by an assumption.
      this.onAuthenticated("broker_acknowledged");
      return this.runReconnectReconciliation();
    }
    this.onDisconnected();
    return Promise.resolve();
  }

  /**
   * DRIVE IDLENESS FROM A REAL CLOCK (D5).
   *
   * Called on a poll with the current wall time. It demotes a connected stream (READY/RECONCILING)
   * to DEGRADED ONLY when BOTH are true:
   *   1. a WORKING order is outstanding (we are actually EXPECTING events), and
   *   2. no stream event has arrived for longer than the expected-idle bound.
   * A quiet stream on an account with nothing working is NORMAL and never demotes — the alarm is
   * based on working-order expectation, not wall-clock silence alone. Any real stream event resets
   * the clock (see ingest), so a live-but-slow stream is not falsely flagged.
   */
  evaluateIdle(nowWall?: number): void {
    if (this.workingOrders.size === 0) return; // silence is expected — no false alarm
    const state = this.machine.state();
    if (state !== "READY" && state !== "RECONCILING") return;
    const now = nowWall ?? this.now();
    const since = this.lastStreamEventAtWall;
    if (since === null) return; // never connected/authorised long enough to measure
    if (now - since > this.expectedIdleMs) {
      // SECTION 7 / defect (a): go through onIdle(), NOT this.machine.onIdle(). The direct machine
      // call was the bug — it demoted the governing state and left the PUBLISHED projection saying
      // LIVE. Every idle demotion now travels the one path that informs both.
      this.onIdle();
    }
  }

  onDisconnected(): void {
    this.machine.onDisconnected();
    this.proj.onStreamDisconnected();
  }

  onSessionLost(_reason: string): void {
    this.machine.onSessionLost();
    // SECTION 7: a lost session is its OWN published state, not a plain disconnect. Reporting it as
    // DOWN invited a futile reconnect with a credential the broker has already rejected. The
    // projection still records that a gap exists, so a reconciliation remains owed.
    this.proj.onStreamSessionLost();
  }

  setStreamEnabled(enabled: boolean): void {
    this.machine.setEnabled(enabled);
    this.proj.setStreamEnabled(enabled);
  }

  /* ─────────────────────────── reads ─────────────────────────── */

  lifecycleState(): OrderStreamLifecycleState {
    return this.machine.state();
  }

  permissions(): OperationPermissions {
    return this.machine.permissions();
  }

  reconcilePending(): boolean {
    return this.machine.reconcilePending() || this.proj.reconcilePending();
  }

  /**
   * THE PUBLISHED ORDER-STREAM HEALTH — SECTION 7 / defect (a): derived from the ONE lifecycle
   * authority, so the state that GOVERNS entry and the state the operator READS cannot disagree.
   *
   * WHAT WAS WRONG. This used to be `return this.proj.orderStreamHealth()` — a straight pass-through
   * of a SECOND state holder. `onIdle`/`evaluateIdle` demoted `this.machine` to DEGRADED and never
   * touched the projection, whose `streamState` had no way to express "connected but not
   * delivering" and so stayed `LIVE`. `engine.getStatus()` publishes this object into
   * `order_stream`, and `orderStreamStatus()` scores `fills_observed_by` off `state === "LIVE"`. So
   * the dashboard advertised `stream_primary_rest_reconcile` — the FAST fill path — at the precise
   * moment the engine was refusing new entry because that same stream was degraded.
   *
   * THE FIX IS STRUCTURAL, NOT A PATCH. The projection keeps supplying the facts it genuinely
   * observes (connected, authorised, last event, disconnect count, detail). The `state` — the field
   * every consumer branches on — is now MAPPED from `this.machine.state()`, the same value
   * `lifecycleState()` returns and the same value the entry gate scores. `reconcilePending` is taken
   * from the union read (`reconcilePending()`), so neither holder can under-report an owed
   * reconciliation. `lifecycle` carries the authority verbatim so a reader is never left inferring.
   */
  health(): OrderStreamHealth {
    const lifecycle = this.machine.state();
    const projected = this.proj.orderStreamHealth();
    const state = publishedStateForLifecycle(lifecycle);
    const evidence = this.machine.authenticationEvidence();
    // A RECONCILING stream whose sweep keeps failing must SAY so. Otherwise the operator sees a state
    // that looks like a transient step in a handshake, when in fact it is a stalled recovery that will
    // refuse new entry indefinitely — the exact failure mode that made the missing Dhan wiring silent.
    const lifecycleSentence = describeLifecycle(lifecycle, evidence, this.lastSweepFailure);
    return {
      ...projected,
      state,
      lifecycle,
      // Either holder owing a reconciliation means one is owed. Never the narrower answer.
      reconcilePending: this.reconcilePending(),
      // Keep the projection's own sentence when the two agree AND there is nothing extra to disclose;
      // otherwise the lifecycle wins and says so, because a stale sentence next to a corrected state
      // is its own small lie.
      detail:
        state === projected.state && this.lastSweepFailure === null && evidence !== "login_submitted"
          ? projected.detail
          : lifecycleSentence,
    };
  }

  /** The single projection of truth for this broker account. */
  projection(): OrderUpdateProjection {
    return this.proj;
  }

  diagnostics(): {
    lifecycle: OrderStreamLifecycleState;
    /** The connection epoch. Advances on every authorisation, drop, session loss and disable. */
    generation: number;
    /** What is actually KNOWN about this session's authorisation — never upgraded by a mere send. */
    authEvidence: OrderStreamAuthEvidence;
    streamEventsApplied: number;
    streamEventsWokeAdapter: number;
    absentEvidenceEvents: number;
    pendingReconciliations: number;
    /** True while a post-connect/reconnect reconciliation is owed and not yet proven complete. */
    reconcilePending: boolean;
    /** True while a sweep is actually running (so duplicate callers coalesced onto it). */
    reconcileInFlight: boolean;
    sweepsStarted: number;
    sweepsSynchronized: number;
    /** Results that arrived for a superseded connection and were refused. */
    sweepsDiscardedStaleEpoch: number;
    /** Updates that changed STATUS with no quantity change — the class that used to be dropped. */
    statusOnlyForwards: number;
    /** Updates that carried only an average-price enrichment. These must never create a fill. */
    priceOnlyForwards: number;
    /** Orders settled on the adapter's terminal state, including zero-fill cancels/rejects. */
    terminalSettlements: number;
    /** Impossible quantities seen: escalated to reconciliation, never applied. */
    invalidQuantityObservations: number;
    /** Broker-reported overfills: applied (broker truth) and escalated. */
    overfillObservations: number;
    /** Non-terminal labels seen after a terminal one: counted and reconciled, never adopted. */
    contradictoryTerminalObservations: number;
    /** Consecutive failures currently driving the bounded retry backoff. */
    sweepAttempts: number;
    /** Why the last sweep did not synchronize, if it did not. */
    lastSweepFailure: string | null;
    lastSweepUnresolvedOrders: number;
    lastSweepDiscrepancies: number;
    projection: ReturnType<OrderUpdateProjection["diagnostics"]>;
  } {
    return {
      lifecycle: this.machine.state(),
      generation: this.machine.generation(),
      authEvidence: this.machine.authenticationEvidence(),
      streamEventsApplied: this.streamEventsApplied,
      streamEventsWokeAdapter: this.streamEventsWokeAdapter,
      absentEvidenceEvents: this.absentEvidenceEvents,
      pendingReconciliations: this.pendingReconciliations.size,
      reconcilePending: this.reconcilePending(),
      reconcileInFlight: this.sweepInFlight !== null,
      sweepsStarted: this.sweepsStarted,
      sweepsSynchronized: this.sweepsSynchronized,
      sweepsDiscardedStaleEpoch: this.sweepsDiscardedStaleEpoch,
      statusOnlyForwards: this.statusOnlyForwards,
      priceOnlyForwards: this.priceOnlyForwards,
      terminalSettlements: this.terminalSettlements,
      invalidQuantityObservations: this.invalidQuantityObservations,
      overfillObservations: this.overfillObservations,
      contradictoryTerminalObservations: this.contradictoryTerminalObservations,
      sweepAttempts: this.sweepAttempts,
      lastSweepFailure: this.lastSweepFailure,
      lastSweepUnresolvedOrders: this.lastSweepUnresolvedOrders,
      lastSweepDiscrepancies: this.lastSweepDiscrepancies,
      projection: this.proj.diagnostics(),
    };
  }
}
