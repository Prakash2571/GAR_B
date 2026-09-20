/**
 * THE ONE AUTHORITATIVE READINESS DECISION — SECTION 7.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Readiness was being ANSWERED IN THREE PLACES, and the three did not agree:
 *
 *   1. `engine.getStatus()` published two transports (`market_data_state`, `order_stream`) as raw
 *      states and left the reader to combine them.
 *   2. `GET /api/runtime/status` computed `live_entry.blocked` from a DIFFERENT set of facts
 *      (env gates, PostgreSQL, token state, reconciliation) that did not include either transport
 *      lifecycle at all — so it could report entry unblocked while the engine was refusing every
 *      entry because the feed was DEGRADED.
 *   3. The frontend then derived its OWN entry verdict from market-data readiness plus a single
 *      reconcile flag — a third matrix, missing most of the real blockers.
 *
 * Three answers to one question is not redundancy, it is a guarantee that at least two of them are
 * wrong at any moment. This module is the single place the question is answered. Both HTTP surfaces
 * are projections of THIS decision, and the frontend renders it rather than recomputing it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT DOES NOT INVENT A PERMISSION MODEL
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Entry and exposure-management permissions come from {@link combinedPermissions} in
 * `streamHealthPolicy.ts` — the SAME table the live-entry checkpoint consults via
 * {@link entryPermittedFromStreams}. If this module disagreed with that table, the frontend would
 * be shown a permission the engine does not enforce. A test cross-checks every state pair.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ASYMMETRY IT PRESERVES (the load-bearing invariant)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ENTRY-scoped restrictions — a stopped scanner, entry disabled, a spent session budget, an entry
 * capital cap, one-active-underlying, an unavailable reservation service, entry-only market-data
 * requirements, an UNRELATED symbol's stale book — must NEVER independently block a REDUCTION of
 * exposure already owned. Every blocker therefore carries an explicit `scope`, and reduction is
 * computed from the reduction-scoped facts ONLY. Reduction keeps its own genuine requirements: an
 * expired session, or a book it cannot price, still refuses it — and says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NO SECRETS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The account identity is MASKED here and nowhere else, so there is one rule for it. No token, no
 * passcode, no full account id, no credential-bearing URL can pass through this shape: it is a
 * closed set of states, counts, ages, booleans and bounded sentences.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. It does not promise a fill, four-leg atomicity, uninterrupted
 * data, or a bounded loss. `entry.permitted` means "every precondition this system can actually
 * observe is currently satisfied" — never "this trade will work".
 *
 * PURE: no clock (the instant is passed in), no I/O, no globals. Total over its inputs.
 */

import {
  combinedPermissions,
  type MarketDataState,
  type OperationPermissions,
  type OrderStreamLifecycleState,
} from "./streamHealthPolicy.js";
import type { FillObservationMechanism, OrderStreamWiring } from "./orderStreamStatus.js";
import type { OrderStreamState } from "./orderUpdateProjection.js";
import type { BrokerId } from "./latencyModel.js";
import type { BackendInstanceIdentity } from "./backendInstance.js";

/**
 * The version of THIS decision shape.
 *
 * Published in every response so a frontend can tell whether it is reading a decision it
 * understands. Bumped with the wire contract; a frontend that does not recognise it must degrade to
 * "unknown", never to a green light.
 */
export const OPERATIONAL_READINESS_VERSION = "1.7.0";

/* ─────────────────────────── blockers: scope is the whole point ─────────────────────────── */

/**
 * What a blocker is allowed to stop.
 *
 *   entry      — creating NEW exposure only. NEVER touches reduction. This is the scope that holds
 *                the invariant: a stopped scanner or a spent budget is an entry-only fact.
 *   reduction  — genuinely prevents REDUCING exposure (an expired session; no priceable book).
 *                Rare and serious: a reduction blocker means a live position cannot be closed
 *                right now, which is the worst state the system can report.
 *   both       — a fact that really does stop everything (an expired session stops both).
 */
export type BlockerScope = "entry" | "reduction" | "both";

/** One named, operator-readable reason something is not permitted. Never a stack, never a secret. */
/**
 * Whether the authoritative operational store can actually be used right now.
 *
 * Two independent signals, because neither alone is sufficient:
 *   • `durableStoreReady` — the pool-level latch (`isPgReady()`, published as `pg_ready`). It is
 *     probed once at init and NOT re-probed per query, so it can read `true` during a mid-session
 *     outage while every query fails.
 *   • `durableWrites` — the OrderManager's observed-write-outcome latch (`health.persistence`),
 *     which is exactly what catches that case. `"unknown"` means no write has been attempted yet
 *     and is NOT an outage.
 */
/** The minimum an attributed leg must expose for the unowned-exposure check. */
export interface AttributedLegForOwnership {
  readonly tradingsymbol: string;
  readonly exchange?: string | undefined;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
}

/**
 * EXPOSURE WE RECONSTRUCTED BUT NOTHING OWNS — an ENTRY-only stop with a named action.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Four live legs are broker-confirmed FILLED, so four terminal COMPLETE rows exist in the durable
 * intent journal — then the position/execution-attempt write fails and the process stops. On restart
 * `performReconcile` faithfully rebuilds `attributedBoxPositions` from those rows, and the broker
 * confirms the same four positions, so there is NO mismatch, nothing trips, and
 * `reconciliation_complete` becomes true. But no position row was ever written: `openBoxes` and
 * `residualLegs` are both 0, the residual flatten loop has nothing to work, and the only route that
 * can see the exposure (`flattenAttributedBoxExposure`, via this same crash-only filter) is
 * OPERATOR-INVOKED rather than automatic.
 *
 * Measured on the real wiring before this existed: `canEnter()` returned true and
 * `entryBlockReason()` returned null, so a brand-new four-leg box was admissible on top of four legs
 * the system knew it held and nobody was managing.
 *
 * `crashRecoveryEntryQuarantined` does not cover it. That flag is refreshed only from
 * `onReconciliationIssue` (which does not fire when reconcile finds no mismatch), and
 * `isCrashRecoveryEntryQuarantined()` additionally requires the crash-recovery INDEX to be
 * unverified — so a cleanly restarted process with a healthy database is never quarantined by it.
 * That axis asks "can we RECORD recovery state?"; this one asks "does any durable row ACCOUNT for
 * exposure we have already reconstructed?".
 *
 * WHY READINESS AND NOT THE ORDER MANAGER'S ENTRY GATE. That gate is consulted per LEG at all five
 * checkpoints, so blocking there also refuses the legitimate continuation of the very attempt that
 * left the orphan — a crash mid-attempt can leave one leg terminal-filled while its siblings were
 * never posted, and that trade must still be able to reconcile and unwind. Readiness is evaluated
 * when deciding to open a NEW box, which is exactly the decision that must stop.
 *
 * `scope: "entry"`, so exits, protective cancellation, the residual flatten loop and reconciliation
 * all remain available — they are how an operator resolves it.
 *
 * Exported and pure so the engine and its tests share ONE derivation rather than two that can drift.
 */
export function unownedAttributedExposureBlocker(args: {
  /** `orderManager.attributedRecoveryExposure()`. */
  readonly attributed: readonly AttributedLegForOwnership[];
  /** Every leg symbol projected by the durable position book, as `EXCHANGE:TRADINGSYMBOL`. */
  readonly projectedSymbols: ReadonlySet<string>;
}): ReadinessBlocker | null {
  const unowned = args.attributed.filter(
    (leg) => !args.projectedSymbols.has(`${leg.exchange ?? "NFO"}:${leg.tradingsymbol}`),
  );
  if (unowned.length === 0) return null;
  const named = unowned
    .slice(0, 4)
    .map((leg) => `${leg.exchange ?? "NFO"}:${leg.tradingsymbol} ${leg.side} ${leg.quantity}`)
    .join(", ");
  return {
    code: "unowned_attributed_exposure",
    scope: "entry",
    detail:
      `${unowned.length} attributed Box leg(s) are held at the broker with NO open trade or residual ` +
      `row accounting for them (${named}${unowned.length > 4 ? " …" : ""}) — almost certainly a fill ` +
      `that was confirmed before a previous process could record it. Nothing is reducing this ` +
      `automatically. OPERATOR ACTION REQUIRED: verify these positions at the broker, then flatten ` +
      `the attributed exposure with the emergency control (or reconcile it into a trade). New entry ` +
      `stays blocked until it is resolved; exits, protective cancellation and reconciliation remain ` +
      `available.`,
  };
}

export interface ReadinessPersistenceInput {
  readonly durableStoreReady: boolean;
  readonly durableWrites: "healthy" | "unhealthy" | "unknown";
}

export interface ReadinessBlocker {
  /** Stable machine code, for the UI to key and group on. snake_case. */
  readonly code: string;
  /** What this blocker is allowed to stop. */
  readonly scope: BlockerScope;
  /** One bounded sentence a human can act on. */
  readonly detail: string;
}

/** A blocker as published: identical shape, but frozen into the response. */
export interface PublishedBlocker {
  readonly code: string;
  readonly scope: BlockerScope;
  readonly detail: string;
}

/* ─────────────────────────── inputs ─────────────────────────── */

export interface ReadinessIdentityInput {
  readonly broker: BrokerId | null;
  /** The raw trading account id. MASKED before publication; never emitted verbatim. */
  readonly account: string | null;
  readonly executionMode: string;
  /** Whether the live runtime controls are armed right now. */
  readonly liveRuntimeArmed: boolean;
  /** Whether this deployment is capable of live trading at all (env gates). */
  readonly deploymentLiveCapable: boolean;
}

/**
 * Market-data facts as handed to the builder.
 *
 * AGES, NOT TIMESTAMPS — deliberately. This interface used to take `lastFrameAt`,
 * `lastHeartbeatAt` and `lastDepthAt` and the builder subtracted `now` from each. The engine
 * stamps those three on the MONOTONIC clock but passed `executionClock.wall()` as `now`, so every
 * published age was roughly the Unix epoch in milliseconds (~55 years) — always positive, so
 * `Math.max(0, …)` could not even reveal it, and a dashboard could only render it as nonsense or
 * as "never observed". Taking finished ages that were computed inside the monotonic domain makes
 * the mixed-domain subtraction impossible to write here, rather than merely absent today.
 *
 * `null` in any age means NEVER OBSERVED and must be published as `null`, never coerced to 0.
 */
export interface ReadinessMarketDataInput {
  readonly state: MarketDataState;
  /** Connection generation. A book observed under a superseded socket is not evidence. */
  readonly generation: number;
  readonly desiredInstruments: number;
  readonly readyInstruments: number;
  /** Pre-computed ages (ms) in the machine's own monotonic domain. Null ⇒ never observed. */
  readonly frameAgeMs: number | null;
  readonly heartbeatAgeMs: number | null;
  readonly depthAgeMs: number | null;
  /** Wall-clock (epoch ms) stamps, for audit/display only. Null ⇒ never observed. */
  readonly lastFrameWallAt: number | null;
  readonly lastHeartbeatWallAt: number | null;
  readonly lastDepthWallAt: number | null;
  /**
   * Evidence counters. These are what separate "a socket is open" from "data is arriving": a
   * connection with `frames > 0` but `depthObservations === 0` is a real and nameable state.
   */
  readonly frames: number;
  readonly heartbeats: number;
  readonly depthObservations: number;
  readonly backlog: boolean;
  /**
   * Where the quotes are coming from. `broker_websocket` is the only value that licenses the
   * "real broker WebSocket quotes" claim, and even then only when tick evidence supports it.
   */
  readonly source: MarketDataSource;
  /** Whether the quote socket is currently connected (transport fact, NOT readiness). */
  readonly socketConnected: boolean;
  /** Whether the feed reports itself authenticated (transport fact, NOT readiness). */
  readonly authenticated: boolean;
  /** Whether subscriptions have been REQUESTED for the current generation. */
  readonly subscriptionsRequested: boolean;
  /** Count of instruments with a currently usable executable book. */
  readonly usableBooks: number;
}

/**
 * The mechanism supplying quotes.
 *
 * `rest_snapshot_fallback` is NOT equivalent to `broker_websocket`: a REST snapshot is a documented
 * fallback for discovery and last-close views, and must never be silently presented as executable
 * streaming depth.
 */
export type MarketDataSource = "broker_websocket" | "rest_snapshot_fallback" | "none";

/**
 * How PAPER execution is realised, published separately from any broker order stream.
 *
 * A broker cannot emit order-update events for orders that were never sent to it. Paper fills are
 * produced by the local simulator against real streamed quotes, and saying so plainly is the only
 * honest option: reporting paper fills as `rest_polling_only` (as the order-stream status did)
 * implies a broker round trip that does not happen.
 */
export interface ReadinessPaperExecutionInput {
  /** True when this deployment simulates execution rather than sending real orders. */
  readonly simulated: boolean;
  /** The paper profile in force (e.g. paper_latency), or null under live. */
  readonly profile: string | null;
  /** Whether the simulator is pricing against real streamed quotes right now. */
  readonly usingStreamedQuotes: boolean;
}

export interface ReadinessOrderStreamInput {
  /** The AUTHORITATIVE lifecycle — the value the entry gate scores. */
  readonly lifecycle: OrderStreamLifecycleState;
  /** The state as published in `order_stream`, derived from the lifecycle. */
  readonly publishedState: OrderStreamState;
  readonly wiring: OrderStreamWiring;
  readonly gateEnabled: boolean;
  readonly connected: boolean;
  readonly authorised: boolean;
  readonly lastEventAt: number | null;
  readonly disconnects: number;
  readonly reconcilePending: boolean;
  readonly fillsObservedBy: FillObservationMechanism;
}

export interface ReadinessExposureInput {
  readonly openPositions: number;
  readonly residualLegs: number;
  readonly workingOrders: number;
}

export interface OperationalReadinessInput {
  /** The instant this decision was evaluated. Passed in so the module stays pure. */
  readonly now: number;
  /**
   * Monotonic counter, incremented once per decision, SCOPED TO THIS PROCESS.
   *
   * It orders concurrent responses from one instance and nothing more. It resets on restart, so it
   * cannot order across one — that is what `instance` below is for, and treating this counter as
   * globally monotonic is precisely the defect that left a browser holding generation 5000 rejecting
   * a restarted backend's generation 1 forever.
   */
  readonly decisionGeneration: number;
  /**
   * WHICH BACKEND PROCESS decided this, and where that process sits in the restart order.
   *
   * Absent only for a deployment that predates the instance-aware contract; a client that receives no
   * instance cannot order across a restart and must degrade to unknown rather than to a green light.
   */
  readonly instance?: BackendInstanceIdentity;
  readonly identity: ReadinessIdentityInput;
  readonly marketData: ReadinessMarketDataInput;
  readonly orderStream: ReadinessOrderStreamInput;
  /**
   * How execution is actually performed. Required so the payload can state the paper mechanism
   * instead of leaving a reader to infer it from an order-stream field that does not apply.
   */
  readonly paperExecution: ReadinessPaperExecutionInput;
  /**
   * Everything OUTSIDE the two transports that legitimately blocks something: env gates, PostgreSQL,
   * token state, session budget, scanner state, reservations, recovery. Each carries its scope, so
   * an entry-only fact can never leak into the reduction answer.
   */
  /**
   * THE DURABLE STORE'S OWN HEALTH, because reduction depends on it as much as entry does.
   *
   * REQUIRED, deliberately: a production caller that forgets it is a COMPILE ERROR, which is the
   * only reliable guard against the class of defect this field exists to close (a readiness verdict
   * computed from transport lifecycle alone, publishing "exits are unaffected" during a PostgreSQL
   * outage). The builder reads it defensively so untyped `.mjs` test harnesses that predate the
   * field still resolve to "available" rather than inventing an outage.
   */
  readonly persistence: ReadinessPersistenceInput;
  readonly blockers: readonly ReadinessBlocker[];
  readonly openExposure: ReadinessExposureInput;
}

/* ─────────────────────────── the published decision ─────────────────────────── */

export interface OperationalReadinessDecision {
  /**
   * Monotonic per-response counter, SCOPED TO `instance.instance_id`. A response with a LOWER value
   * from the SAME instance is stale — ignore it. Across instances this counter means nothing; use
   * `instance.boot_ordinal`.
   */
  readonly decision_generation: number;
  /**
   * THE BACKEND PROCESS THIS DECISION CAME FROM, and its place in the restart order.
   *
   * `boot_ordinal` is a restart-durable, strictly increasing integer minted by PostgreSQL — not a
   * clock, and not a random id, because neither can express "newer". `null` means the backend could
   * not establish it (its authoritative store was unreachable at boot), in which case the decision is
   * UNORDERABLE: a client must not let it overwrite an ordered decision, and must disable new entry.
   *
   * See src/box/backendInstance.ts for the full ordering protocol; `orderReadinessDecision()` there is
   * the shared rule the frontend vendors rather than reimplementing.
   */
  readonly instance: {
    readonly instance_id: string | null;
    readonly boot_ordinal: number | null;
    /** AUDIT ONLY. Never used for ordering — a wall clock cannot order instances correctly. */
    readonly started_at: number | null;
  };
  /** The shape version, so an unfamiliar frontend degrades to "unknown", never to green. */
  readonly decision_version: string;
  /** When this decision was evaluated (wall ms). */
  readonly decided_at: number;

  readonly identity: {
    readonly broker: BrokerId | null;
    /** MASKED account id, e.g. "AB••34". Never the raw value. Null when no account is bound. */
    readonly account_masked: string | null;
    /** Whether an account is bound at all — distinct from "the id is hidden". */
    readonly account_present: boolean;
    readonly execution_mode: string;
    readonly live_runtime_armed: boolean;
    readonly deployment_live_capable: boolean;
  };

  readonly market_data: {
    readonly state: MarketDataState;
    readonly generation: number;
    readonly desired_instruments: number;
    readonly ready_instruments: number;
    readonly backlog: boolean;
    /** True ONLY in READY: fresh usable depth per traded instrument, this generation. */
    readonly usable_for_entry: boolean;

    /*
     * THE SIX DISTINCT FACTS A DASHBOARD MUST NOT COLLAPSE.
     *
     * "Is the socket up?" and "is there executable depth?" are different questions, and a UI that
     * had only `state` to work with could do nothing but conflate them. Each of the following is
     * separately observable, so an operator can see exactly how far along the chain the feed got:
     * connected → authenticated → subscriptions requested → frames arriving → usable depth →
     * per-candidate readiness (which is answered per candidate, not here).
     */
    /** Where quotes come from. Never `broker_websocket` unless a broker socket is the source. */
    readonly source: MarketDataSource;
    readonly socket_connected: boolean;
    readonly authenticated: boolean;
    readonly subscriptions_requested: boolean;
    /** Instruments with a currently usable executable book. */
    readonly usable_books: number;
    /**
     * Whether any tick/frame has been received IN THE CURRENT GENERATION.
     *
     * This is the field that licenses the "real broker WebSocket quotes" claim. An open socket
     * alone must never produce it.
     */
    readonly ticks_observed: boolean;
    readonly frames_observed: number;
    readonly heartbeats_observed: number;
    readonly depth_observations: number;
  };

  readonly order_stream: {
    /** The AUTHORITATIVE lifecycle the entry gate scored. */
    readonly lifecycle: OrderStreamLifecycleState;
    /** The same fact as published in `order_stream`, derived from the lifecycle above. */
    readonly published_state: OrderStreamState;
    readonly wiring: OrderStreamWiring;
    readonly gate_enabled: boolean;
    readonly connected: boolean;
    readonly authorised: boolean;
    readonly disconnects: number;
  };

  /** The mechanism ACTUALLY responsible for observing a fill right now. */
  readonly fill_observation: {
    readonly mechanism: FillObservationMechanism;
    /** True when a broker push is currently doing the observing; false ⇒ REST polling is. */
    readonly stream_assisted: boolean;
    readonly detail: string;
  };

  /**
   * PAPER EXECUTION, published separately from any broker order stream.
   *
   * Present in every payload so a reader never has to decide whether an order-stream field applies.
   * When `simulated` is true, fills come from the local simulator and NO broker order confirmation
   * exists or is possible — which is a normal, healthy state, not a degraded one.
   */
  readonly paper_execution: {
    readonly simulated: boolean;
    readonly profile: string | null;
    readonly using_streamed_quotes: boolean;
    /** Plain language, safe to display verbatim. */
    readonly detail: string;
  };

  /**
   * How old the evidence behind this decision is. `null` means NEVER OBSERVED — not fresh.
   *
   * Every market-data age here was computed in the MONOTONIC domain by the state machine that
   * stamped it (see {@link ReadinessMarketDataInput}). `order_stream_event_age_ms` is computed here
   * from `now`, which is legitimate because the order-stream event time is a WALL reading and `now`
   * is `executionClock.wall()` — same domain, so the subtraction is sound.
   */
  readonly evidence: {
    readonly market_data_frame_age_ms: number | null;
    readonly market_data_heartbeat_age_ms: number | null;
    readonly market_data_depth_age_ms: number | null;
    readonly order_stream_event_age_ms: number | null;
    /** Wall-clock stamps for audit/display. `null` means never observed. */
    readonly market_data_last_frame_at: number | null;
    readonly market_data_last_depth_at: number | null;
    /**
     * Which clock produced the market-data ages, published so a reader can verify the domains
     * were not mixed rather than trusting that they were not.
     */
    readonly market_data_age_clock: "monotonic";
  };

  readonly reconciliation: {
    readonly pending: boolean;
    /** Named reasons a reconciliation is owed or incomplete. Empty when nothing is owed. */
    readonly blockers: readonly PublishedBlocker[];
  };

  /** NEW ENTRY: the single verdict, with every reason it was refused. */
  readonly entry: {
    readonly permitted: boolean;
    readonly reasons: readonly PublishedBlocker[];
  };

  /**
   * EXPOSURE MANAGEMENT — and its REAL limitations, stated rather than implied.
   *
   * Computed from reduction-scoped facts only. An entry-scoped blocker can never appear here.
   */
  readonly exposure_management: {
    readonly exit_and_reduce: boolean;
    readonly protective_cancel: boolean;
    readonly manage_working_orders: boolean;
    /** Reasons a REDUCTION is refused. Empty when reduction is permitted. */
    readonly blocked_reasons: readonly PublishedBlocker[];
    /** What reduction cannot promise even when permitted. Always non-empty — these never go away. */
    readonly limitations: readonly string[];
    readonly open_positions: number;
    readonly residual_legs: number;
    readonly working_orders: number;
  };
}

/* ─────────────────────────── masking ─────────────────────────── */

/**
 * MASK a broker account id for publication.
 *
 * Keeps the first two and last two characters so an operator can confirm WHICH account is bound
 * without the value being reusable or loggable in full. Anything too short to mask safely is
 * reported as fully masked rather than partially leaked — a short id is not a licence to publish it.
 * Returns null for an absent account, which the caller reports as `account_present: false`.
 */
export function maskAccountId(account: string | null | undefined): string | null {
  if (account === null || account === undefined) return null;
  const trimmed = String(account).trim();
  if (trimmed === "") return null;
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}••${trimmed.slice(-2)}`;
}

/* ─────────────────────────── the builder ─────────────────────────── */

/**
 * Age of an observation, or null when it was never observed. NEVER 0 for "never".
 *
 * ONLY valid when `now` and `at` are readings of the SAME clock. The one remaining caller is the
 * order-stream event age, where both are `executionClock.wall()`. Market-data ages arrive
 * pre-computed precisely so this function cannot be misapplied across clock domains again.
 */
function ageOf(now: number, at: number | null): number | null {
  if (at === null || !Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

/**
 * Normalise an already-computed age for publication.
 *
 * The schema declares these as INTEGER-or-null with a zero floor, and a monotonic clock is
 * fractional (`performance.now()`), so a raw 12.7 would violate the contract. `null` passes
 * through untouched: "never observed" is not a number and must not become one.
 */
function intAge(age: number | null): number | null {
  if (age === null || !Number.isFinite(age)) return null;
  return Math.max(0, Math.round(age));
}

/**
 * Describe the paper execution mechanism in plain language, gated on REAL evidence.
 *
 * The "real broker WebSocket quotes · simulated execution" claim is only made when frames have
 * actually been observed on the broker socket. With no tick evidence the text says so instead,
 * because a confident label over an empty feed is exactly the failure this whole payload exists to
 * prevent.
 */
function describePaperExecution(
  paper: ReadinessPaperExecutionInput,
  marketData: ReadinessMarketDataInput,
): string {
  if (!paper.simulated) {
    return "Live execution: orders are sent to the broker and fills are broker-confirmed.";
  }
  const profile = paper.profile ? ` (${paper.profile})` : "";
  if (marketData.source === "broker_websocket" && marketData.frames > 0) {
    return (
      `Real broker WebSocket quotes · simulated execution${profile}. Fills are produced by the ` +
      `local execution simulator against streamed quotes; NO order reaches the broker, so no ` +
      `broker fill confirmation exists or is possible.`
    );
  }
  if (marketData.source === "broker_websocket") {
    return (
      `Simulated execution${profile}, but NO tick has been observed on the broker quote socket ` +
      `yet — so there is no streamed pricing basis to simulate against. This is a market-data ` +
      `fault, not an execution one.`
    );
  }
  return (
    `Simulated execution${profile}. Quotes are NOT coming from a broker WebSocket ` +
    `(source: ${marketData.source}), so any fill simulated now is priced off fallback data and ` +
    `must not be read as executable.`
  );
}

/** Reasons a market-data state does not license NEW ENTRY, named per state. */
function marketDataEntryBlocker(state: MarketDataState): ReadinessBlocker | null {
  switch (state) {
    case "READY":
      return null;
    case "DISABLED":
      return {
        code: "market_data_not_configured",
        scope: "both",
        detail: "Market data is not armed, so there is no pricing basis for any decision.",
      };
    case "CONNECTING":
      return {
        code: "market_data_lifecycle",
        scope: "entry",
        detail: "Market data is connecting; a route to the broker is not readiness.",
      };
    case "AUTHENTICATING":
      return {
        code: "market_data_lifecycle",
        scope: "entry",
        detail: "The market-data socket is open but the session handshake is not yet accepted.",
      };
    case "SYNCHRONIZING":
      return {
        code: "market_data_lifecycle",
        scope: "entry",
        detail:
          "Market data is synchronizing: subscriptions are restoring and fresh depth per traded " +
          "instrument is still owed. Exit and cancel continue.",
      };
    case "DEGRADED":
      return {
        code: "market_data_lifecycle",
        scope: "entry",
        detail:
          "Market data is connected but cannot be trusted for entry (heartbeat gap, stale book, " +
          "partial subscription or an ingestion backlog). A reduction can still be priced off a " +
          "current single-leg book.",
      };
    case "DISCONNECTED":
      return {
        code: "market_data_disconnected",
        scope: "entry",
        detail:
          "The market-data socket is closed or half-open. New entry is stopped; protective cancel " +
          "and exposure management continue.",
      };
    case "AUTH_EXPIRED":
      return {
        code: "market_data_session_expired",
        scope: "both",
        detail:
          "The market-data session or token was rejected or expired. The broker will refuse " +
          "everything but a cancel, so a priced reduction cannot be relied on until it is renewed.",
      };
  }
}

/** Reasons an order-stream lifecycle does not license NEW ENTRY, named per state. */
function orderStreamEntryBlocker(lifecycle: OrderStreamLifecycleState): ReadinessBlocker | null {
  switch (lifecycle) {
    // A DISABLED order stream is NOT a fault: REST polling is the documented baseline and the
    // stream is off by default. It never blocks entry — it only makes fill observation slower.
    case "DISABLED":
    case "READY":
      return null;
    case "CONNECTING":
    case "AUTHENTICATING":
      return {
        code: "order_stream_lifecycle",
        scope: "entry",
        detail:
          `The order-update stream is ${lifecycle}: it is not yet delivering, so a fill would be ` +
          `observed only by REST polling. New entry waits; exit and cancel continue.`,
      };
    case "RECONCILING":
      return {
        code: "order_stream_lifecycle",
        scope: "entry",
        detail:
          "The order-update stream connected and a REST reconciliation is owed. Taking new exposure " +
          "on top of an unrepaired fill gap is how one unknown becomes two.",
      };
    case "DEGRADED":
      return {
        code: "order_stream_lifecycle",
        scope: "entry",
        detail:
          "The order-update stream is connected but NOT delivering while a fill is expected. Events " +
          "may be missing — which is never read as a zero fill. REST polling is observing fills.",
      };
    case "DISCONNECTED":
      return {
        code: "order_stream_lifecycle",
        scope: "entry",
        detail:
          "The order-update stream is down. REST polling remains the source of truth for fills; " +
          "new entry stops while exposure management continues.",
      };
    case "AUTH_EXPIRED":
      return {
        code: "order_stream_session_expired",
        scope: "entry",
        detail:
          "The session behind the order-update stream was rejected or expired. Reconnecting with it " +
          "is pointless until it is renewed.",
      };
  }
}

/**
 * The limitations of exposure management that are ALWAYS true, permitted or not.
 *
 * Stated explicitly because a green "you can exit" invites the inference that exiting is assured,
 * and it is not: an exit is four more orders into the same market, with the same partial-fill and
 * liquidity risk as the entry. Nothing here is a promise.
 */
const EXPOSURE_LIMITATIONS: readonly string[] = Object.freeze([
  "A reduction is itself an order into the market: it can partially fill, be rejected, or fill at a worse price. Permission is not a fill.",
  "Four-leg atomicity is not available from any broker; legs are reduced one order at a time and an intermediate state is unavoidable.",
  "A reduction needs a usable book for the leg being reduced. Whole-feed readiness is not required, but an unpriceable leg cannot be reduced on a limit price.",
  /*
   * CORRECTED. This previously read "Protective cancellation reduces exposure and is permitted in
   * every state except an expired session, where the broker itself refuses" — which was the
   * backend's own source for the frontend's "exits, protective cancellation and reconciliation are
   * unaffected" claim during a PostgreSQL outage. An expired session is not the only exception: the
   * durable store is a precondition too.
   */
  "Protective cancellation reduces exposure and needs no market data, so it is permitted in almost every state — but NOT with an expired broker session (the broker itself refuses) and NOT while the durable store is unavailable (the sweep must read the intent journal to know what to cancel).",
  "EVERY automated reduction — exit, emergency flatten, protective cancel, reconciliation — requires PostgreSQL. An order records a durable intent BEFORE it reaches the broker. During an outage a reduction is REFUSED rather than queued, nothing is transmitted, exposure is unchanged and still owned, and the broker terminal is the only way to reduce it.",
]);

/**
 * BUILD THE DECISION.
 *
 * The order of work matters and is deliberate:
 *   1. Score BOTH transports through the shared permission table — the same call the live-entry
 *      checkpoint makes. This is what stops a second matrix existing.
 *   2. Collect ENTRY reasons: transport reasons plus every caller-supplied blocker scoped to entry
 *      (or both). Entry is permitted only when the table says so AND no entry-scoped blocker exists.
 *   3. Collect REDUCTION reasons from reduction-scoped facts ONLY — the invariant. An entry-scoped
 *      blocker is structurally unable to reach this list.
 */
export function buildOperationalReadiness(
  input: OperationalReadinessInput,
): OperationalReadinessDecision {
  const { now, marketData, orderStream, identity, openExposure, paperExecution } = input;

  // (1) The SHARED table — never a local re-derivation.
  const permissions: OperationPermissions = combinedPermissions({
    marketData: marketData.state,
    orderStream: orderStream.lifecycle,
  });

  // (2) ENTRY reasons. Transport reasons first (they explain the table's verdict), then external.
  const entryReasons: PublishedBlocker[] = [];
  const mdBlocker = marketDataEntryBlocker(marketData.state);
  if (mdBlocker) entryReasons.push(mdBlocker);
  const osBlocker = orderStreamEntryBlocker(orderStream.lifecycle);
  if (osBlocker) entryReasons.push(osBlocker);
  for (const b of input.blockers) {
    if (b.scope === "entry" || b.scope === "both") entryReasons.push(b);
  }

  // (3) REDUCTION reasons — reduction-scoped facts ONLY. This is the invariant, enforced by
  // construction rather than by remembering to check: an `entry`-scoped blocker cannot be selected
  // by this filter, so no entry restriction can ever reach the reduction verdict.
  const reductionReasons: PublishedBlocker[] = [];
  if (!permissions.exitAndReduce) {
    // The table refused reduction. Name the transport responsible, from the reduction-relevant
    // states only (an entry-only demotion like SYNCHRONIZING never lands here, because the table
    // permits exitAndReduce there).
    if (marketData.state === "AUTH_EXPIRED") {
      reductionReasons.push({
        code: "market_data_session_expired",
        scope: "reduction",
        detail:
          "The session or token was rejected or expired: the broker will refuse a priced reduction. " +
          "A protective cancel is the only action it will still accept.",
      });
    } else if (marketData.state === "DISABLED") {
      reductionReasons.push({
        code: "market_data_not_configured",
        scope: "reduction",
        detail: "Market data is not armed, so a reduction cannot be priced at all.",
      });
    } else if (marketData.state === "DISCONNECTED") {
      reductionReasons.push({
        code: "market_data_disconnected",
        scope: "reduction",
        detail:
          "The market-data socket is closed, so no current book exists to price a reduction against. " +
          "Protective cancellation still reduces exposure and remains permitted.",
      });
    } else if (marketData.state === "CONNECTING" || marketData.state === "AUTHENTICATING") {
      reductionReasons.push({
        code: "market_data_lifecycle",
        scope: "reduction",
        detail:
          `Market data is ${marketData.state}: there is no current book to price a reduction ` +
          `against yet. Protective cancellation remains permitted.`,
      });
    } else if (marketData.state === "SYNCHRONIZING") {
      reductionReasons.push({
        code: "market_data_lifecycle",
        scope: "reduction",
        detail:
          "Market data is synchronizing after a reconnect and no book in the current generation is " +
          "proven yet. Protective cancellation remains permitted.",
      });
    } else if (orderStream.lifecycle === "AUTH_EXPIRED") {
      reductionReasons.push({
        code: "order_stream_session_expired",
        scope: "reduction",
        detail:
          "The session behind the order-update stream was rejected or expired, so a reduction " +
          "cannot be confirmed. A protective cancel is still accepted.",
      });
    }
  }
  for (const b of input.blockers) {
    if (b.scope === "reduction" || b.scope === "both") reductionReasons.push(b);
  }

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * THE DURABLE STORE IS A PRECONDITION OF REDUCTION, NOT ONLY OF ENTRY.
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * THE DEFECT THIS CLOSES. This builder had no persistence input at all, so every reduction
   * verdict was computed from transport lifecycle alone. With PostgreSQL unavailable it published
   * `exit_and_reduce: true`, `protective_cancel: true` and `manage_working_orders: true` while
   * EVERY one of those operations would in fact be refused — and the frontend rendered that as
   * "Exits, protective cancellation and reconciliation are unaffected."
   *
   * WHY IT IS FALSE. `BoxOrderManager.execute()` performs TWO awaited durable writes before the
   * transport call — `persistence.create` (the CREATED row) and the CREATED→SUBMITTING
   * compare-and-set — for EVERY purpose. There is no purpose branch around them, and the guard
   * after the CAS is explicit: "did not durably enter SUBMITTING; broker POST blocked". So an
   * EXIT and an EMERGENCY_RESIDUAL flatten are refused at the first write, having transmitted
   * nothing. The bare-cancel path (`executeCancel`) does POST before writing, but its only caller
   * (`cancelWorkingBoxOrders`) must first READ `loadNonterminal()` to learn what to cancel, and
   * reconciliation opens with `loadNonterminal()` + `loadOwned()`. Nothing reduces exposure
   * without PostgreSQL.
   *
   * THIS DOES NOT WEAKEN THE ENTRY-ONLY RULE. The invariant is that an ENTRY-SCOPED control must
   * never block reduction, and it still holds: `entryReasons` and `reductionReasons` remain
   * separately filtered, and an unfunded account, a spent attempt budget or a daily-loss trip
   * still leave every reduction route open. Persistence is not an entry control — it is a shared
   * physical precondition, which is why it is reported on BOTH scopes and why the honest verdict
   * is "cannot", not "not allowed".
   *
   * FAIL-SAFE READ. `durableStoreReady === false` is the pool-level latch (`isPgReady()`, what the
   * runtime status publishes as `pg_ready`); `durableWrites === "unhealthy"` is the OrderManager's
   * observed-write-outcome latch, which catches a mid-session outage the pool latch can miss
   * because it is probed once at init and never re-probed. `"unknown"` — no write attempted yet —
   * is deliberately NOT treated as an outage: absence of evidence is not evidence of failure.
   *
   * LIVE-CAPABLE DEPLOYMENTS ONLY. The precondition being described is the DURABLE ORDER-INTENT
   * journal, and only the live path writes one: a paper reduction goes through the deterministic
   * simulator, which performs no pre-POST intent write and needs no journal read to act. PostgreSQL
   * is optional for a paper deployment, so raising this there would report a blocked reduction on a
   * deployment that has nothing to block — which is the mirror image of the falsehood being fixed.
   */
  const durableStoreReady = input.persistence?.durableStoreReady !== false;
  const durableWritesFailing = input.persistence?.durableWrites === "unhealthy";
  const persistenceUnavailable = identity.deploymentLiveCapable
    && (!durableStoreReady || durableWritesFailing);
  if (persistenceUnavailable) {
    const detail = !durableStoreReady
      ? "PostgreSQL, the authoritative operational store, is not available. Every order — an exit " +
        "and an emergency flatten included — records a durable intent BEFORE it reaches the " +
        "broker, and the working-order sweep and reconciliation must first READ that journal. So " +
        "automated reduction is refused, not queued: nothing is transmitted. Existing exposure is " +
        "unchanged and still owned. Restore PostgreSQL, or reduce the position from the broker " +
        "terminal if it cannot wait."
      : "A durable order-intent write has FAILED, so the operational store cannot be trusted to " +
        "record an order. Automated reduction records a durable intent before it reaches the " +
        "broker and is therefore refused, not queued. Existing exposure is unchanged and still " +
        "owned. Check PostgreSQL, or reduce the position from the broker terminal if it cannot wait.";
    // `both`: it genuinely stops creating exposure AND reducing it.
    const blocker: PublishedBlocker = { code: "durable_store_unavailable", scope: "both", detail };
    entryReasons.push(blocker);
    reductionReasons.push(blocker);
  }

  // Reconciliation blockers: what is owed, and anything the caller flagged as recovery work.
  const reconciliationBlockers: PublishedBlocker[] = [];
  if (orderStream.reconcilePending) {
    reconciliationBlockers.push({
      code: "order_stream_reconciliation_owed",
      scope: "entry",
      detail:
        "A REST reconciliation of the order-update gap is owed. Events in the gap are NOT assumed " +
        "absent; they are repaired from REST before the stream is trusted again.",
    });
  }
  for (const b of input.blockers) {
    if (b.code.includes("reconcil") || b.code.includes("recovery")) {
      reconciliationBlockers.push(b);
    }
  }

  const streamAssisted = orderStream.fillsObservedBy === "stream_primary_rest_reconcile";

  return {
    decision_generation: input.decisionGeneration,
    // Published even when unknown, and published as EXPLICIT NULLS rather than omitted, so a client
    // can tell "this backend cannot be ordered" from "this field was dropped in transit".
    instance: {
      instance_id: input.instance?.instance_id ?? null,
      boot_ordinal: input.instance?.boot_ordinal ?? null,
      started_at: input.instance?.started_at ?? null,
    },
    decision_version: OPERATIONAL_READINESS_VERSION,
    decided_at: now,

    identity: {
      broker: identity.broker,
      account_masked: maskAccountId(identity.account),
      account_present: maskAccountId(identity.account) !== null,
      execution_mode: identity.executionMode,
      live_runtime_armed: identity.liveRuntimeArmed,
      deployment_live_capable: identity.deploymentLiveCapable,
    },

    market_data: {
      state: marketData.state,
      generation: marketData.generation,
      desired_instruments: marketData.desiredInstruments,
      ready_instruments: marketData.readyInstruments,
      backlog: marketData.backlog,
      usable_for_entry: marketData.state === "READY",
      source: marketData.source,
      socket_connected: marketData.socketConnected,
      authenticated: marketData.authenticated,
      subscriptions_requested: marketData.subscriptionsRequested,
      usable_books: marketData.usableBooks,
      // Tick evidence is a COUNT, not a socket state. `frames > 0` is the only thing that can
      // justify telling an operator that real broker quotes are arriving.
      ticks_observed: marketData.frames > 0,
      frames_observed: marketData.frames,
      heartbeats_observed: marketData.heartbeats,
      depth_observations: marketData.depthObservations,
    },

    order_stream: {
      lifecycle: orderStream.lifecycle,
      published_state: orderStream.publishedState,
      wiring: orderStream.wiring,
      gate_enabled: orderStream.gateEnabled,
      connected: orderStream.connected,
      authorised: orderStream.authorised,
      disconnects: orderStream.disconnects,
    },

    fill_observation: {
      mechanism: orderStream.fillsObservedBy,
      stream_assisted: streamAssisted,
      /*
       * THREE mechanisms, three sentences. This used to be a two-way ternary on `streamAssisted`,
       * so paper mode — which is not stream-assisted — fell into the REST branch and told the
       * operator "REST polling is observing fills" about orders that are never sent to a broker at
       * all. The mechanism label was already corrected to `simulated_paper_fills`; leaving the prose
       * behind would have contradicted it in the same object.
       */
      detail:
        orderStream.fillsObservedBy === "stream_primary_rest_reconcile"
          ? "A broker push is observing fills first; REST reconciles behind it."
          : orderStream.fillsObservedBy === "simulated_paper_fills"
            ? "The local execution simulator is producing fills against streamed quotes. No order " +
              "reaches the broker, so there is no broker confirmation to wait for and nothing is " +
              "being polled — fill timing is the simulator's modelled latency, not broker latency."
            : "REST polling is observing fills. Fill-observation latency is bounded by the polling " +
              "cadence and the pacing floor, not by broker push latency.",
    },

    paper_execution: {
      simulated: paperExecution.simulated,
      profile: paperExecution.profile,
      using_streamed_quotes: paperExecution.usingStreamedQuotes,
      detail: describePaperExecution(paperExecution, marketData),
    },

    evidence: {
      // Already computed in the monotonic domain by the market-data machine. NOT recomputed from
      // `now`, which is a wall reading — that mixture is the defect this shape removes.
      market_data_frame_age_ms: intAge(marketData.frameAgeMs),
      market_data_heartbeat_age_ms: intAge(marketData.heartbeatAgeMs),
      market_data_depth_age_ms: intAge(marketData.depthAgeMs),
      // Wall minus wall: `now` is executionClock.wall() and so is lastEventAt.
      order_stream_event_age_ms: ageOf(now, orderStream.lastEventAt),
      market_data_last_frame_at: marketData.lastFrameWallAt,
      market_data_last_depth_at: marketData.lastDepthWallAt,
      market_data_age_clock: "monotonic",
    },

    reconciliation: {
      pending: orderStream.reconcilePending,
      blockers: reconciliationBlockers,
    },

    entry: {
      // BOTH conditions: the shared table AND the absence of any entry-scoped external blocker.
      permitted: permissions.newEntry && entryReasons.length === 0,
      reasons: entryReasons,
    },

    exposure_management: {
      // Reduction is scored from the table plus reduction-scoped blockers ONLY.
      exit_and_reduce: permissions.exitAndReduce && reductionReasons.length === 0,
      /*
       * `protective_cancel` and `manage_working_orders` are deliberately NOT gated on
       * `reductionReasons`, because most reduction blockers are market-data facts and a CANCEL
       * needs no book — that permissiveness is correct and is preserved.
       *
       * They ARE gated on the durable store, because that is a physical precondition rather than a
       * pricing one: the sweep cannot even enumerate what to cancel without reading the intent
       * journal. Reporting `true` here while the sweep would refuse is the specific falsehood being
       * corrected, and it is the one an operator is most likely to act on under pressure.
       */
      protective_cancel: permissions.protectiveCancel && !persistenceUnavailable,
      manage_working_orders: permissions.manageWorkingOrders && !persistenceUnavailable,
      blocked_reasons: reductionReasons,
      limitations: EXPOSURE_LIMITATIONS,
      open_positions: openExposure.openPositions,
      residual_legs: openExposure.residualLegs,
      working_orders: openExposure.workingOrders,
    },
  };
}
