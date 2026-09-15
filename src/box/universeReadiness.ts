/**
 * WHY THE SCANNER IS NOT EVALUATING CANDIDATES — named, ordered, and impossible to fake.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * `ActiveBrokerManager.instruments()` returned `[]` for Zerodha. Every stage downstream then
 * collapsed in silence: no board rows, no option chains, no ATM windows, no candidates, no desired
 * subscriptions — and because the box-lane socket is created LAZILY on the first subscription, no
 * socket either. The dashboard said `SCANNING` the whole time, because "the operator pressed RUN"
 * and "the engine can actually evaluate a box" were the same bit. `underlyings` was published as
 * `this.windows.size`, so "the instrument dump was empty" and "the market is quiet" rendered
 * identically: as `0`.
 *
 * A scanner that cannot possibly find anything must SAY SO, and say WHERE it stopped.
 *
 * THE DESIGN: ONE ORDERED WALK DOWN THE REAL PIPELINE
 *
 * The stages below are the actual composition, in order, each with the observation that proves it
 * completed. The FIRST unsatisfied stage is the answer — everything after it is unreachable, so
 * reporting more than one blocker would be noise. That ordering is the whole value: "0 candidates"
 * is a symptom shared by fifteen different causes, and an operator needs the cause.
 *
 * WHAT THIS MODULE MAY NOT DO
 *
 *   - It may not invent progress. Every field is a COUNT or a TIMESTAMP the engine actually
 *     observed; there is no default that reads as healthy.
 *   - It may not claim broker subscription ACKNOWLEDGEMENT. Zerodha sends no ack, so
 *     `subscriptionsRequested` means "we wrote a subscribe frame", and usable depth is tracked
 *     separately as the only real confirmation. Conflating them is how an unsubscribed universe
 *     looks subscribed.
 *   - It may not conflate "still loading" with "failed" or with "loaded and empty". Those are three
 *     different operator actions (wait, investigate the broker, investigate the filter).
 *
 * PURE: no clock of its own, no I/O. The caller supplies every observation, so the diagnosis is
 * deterministic and directly testable.
 */

/**
 * How the instrument master load stands. Deliberately four states, not a boolean.
 *
 * `never_attempted` and `loading` are the two that used to be indistinguishable from `failed`, and
 * they are the two where the correct action is to do nothing and wait.
 */
export type InstrumentLoadState = "never_attempted" | "loading" | "loaded" | "failed";

/**
 * The first unsatisfied stage of the universe → evaluation pipeline.
 *
 * Ordered as the pipeline runs. `evaluating` is the only value that means the scanner is genuinely
 * working on real books.
 */
export type UniverseStage =
  /** The scanner has not been started, so no universe is built. Not a fault. */
  | "scanner_stopped"
  /** The broker session is not authenticated, so no instrument master can be fetched. */
  | "not_authenticated"
  /** A first instrument load has not been attempted yet. */
  | "instruments_never_loaded"
  /** An instrument load is in flight and none has ever succeeded. WAIT — do not act. */
  | "instruments_loading"
  /** The instrument load FAILED. `instrumentsError` carries the broker's own message. */
  | "instruments_failed"
  /** The load succeeded and returned ZERO rows — a broker/endpoint problem, not a filter one. */
  | "instruments_empty"
  /** Instruments loaded, but no F&O board row survived (no NFO futures, or no spot to join). */
  | "no_board_rows"
  /** Board rows exist, but no option chain was indexable (no NFO CE/PE, or all expired). */
  | "no_option_chains"
  /** Both exist but do not intersect — the board and chain keys disagree. */
  | "no_board_chain_overlap"
  /** Underlyings are known but no initial spot price arrived, so no ATM window can be centred. */
  | "awaiting_spot_prices"
  /** Spots exist but no window was built (budget, underlying cap, or expiry mismatch). */
  | "no_windows_built"
  /** Windows exist but produced no four-leg candidate (lot-size mismatch, or too few strikes). */
  | "no_candidates"
  /** Candidates exist but nothing was requested from the feed. */
  | "no_desired_subscriptions"
  /** Subscriptions requested, but the box-lane socket is not connected. */
  | "box_socket_disconnected"
  /** The socket is connected but not one frame has arrived. */
  | "awaiting_first_tick"
  /** Frames are arriving but no USABLE two-sided depth has been observed. */
  | "awaiting_usable_depth"
  /** Everything the engine needs is present; candidates are being evaluated against real books. */
  | "evaluating";

/** Every observation the diagnosis is computed from. All supplied by the engine. */
export interface UniverseObservations {
  /** Whether the operator has started discovery. */
  readonly scannerRunning: boolean;
  /** Whether the broker session is authenticated. */
  readonly authenticated: boolean;

  readonly instrumentLoad: InstrumentLoadState;
  /** The broker's own failure message, verbatim. Null unless `instrumentLoad === "failed"`. */
  readonly instrumentsError: string | null;
  /** Rows returned by the last successful load. */
  readonly instrumentCount: number;
  /** Wall-clock ms of the last SUCCESSFUL load, or null. */
  readonly instrumentsLoadedAt: number | null;
  /** Consecutive failed load attempts. Drives the bounded retry, and is published. */
  readonly instrumentLoadFailures: number;

  /** F&O board rows derived from the dump, BEFORE the chain join. */
  readonly boardRows: number;
  /** Option chains indexed from the dump. */
  readonly chainsIndexed: number;
  /** Board rows that also have a chain — the join result the engine actually iterates. */
  readonly boardWithChains: number;

  /** Underlyings in the joined universe that still have no spot price. */
  readonly underlyingsMissingSpot: number;
  /** Whether the last REST spot seed threw. */
  readonly spotSeedFailed: boolean;
  /** The spot seed's failure message, verbatim, or null. */
  readonly spotSeedError: string | null;

  readonly windowsBuilt: number;
  readonly candidates: number;
  /** Option tokens the engine has asked the feed for. */
  readonly desiredOptionSubscriptions: number;

  /** Whether the box-lane market-data socket is connected. */
  readonly boxSocketConnected: boolean;
  /**
   * Whether a subscribe frame has been WRITTEN for the current generation.
   *
   * Not an acknowledgement: Zerodha's protocol supplies none. Usable depth is the only real
   * confirmation, which is why it is a separate observation below.
   */
  readonly subscriptionsRequested: boolean;
  /** Frames received in the current generation (ticks and keep-alives). */
  readonly framesObserved: number;
  /** Usable two-sided depth observations in the current generation. */
  readonly depthObservations: number;
  /** Instruments currently holding a usable executable book. */
  readonly usableBooks: number;

  /** Wall-clock ms of the last universe pass that produced at least one window. */
  readonly lastSuccessfulBuildAt: number | null;
}

/** The published diagnosis. */
export interface UniverseReadiness {
  /**
   * Whether the engine can evaluate a candidate against real current-generation books.
   *
   * DELIBERATELY SEPARATE FROM `running`. The operator's intent and the engine's capability are
   * different facts, and publishing only the former is what let `SCANNING` sit above zero
   * underlyings for an entire session.
   */
  readonly readyToEvaluate: boolean;
  /** The FIRST unsatisfied stage. The single most useful field here. */
  readonly stage: UniverseStage;
  /** Plain language, safe to display verbatim. Names the stage and what to do about it. */
  readonly detail: string;
  /** True when the correct action is to WAIT rather than investigate. */
  readonly transient: boolean;
  /** The counts behind the verdict, republished so the stage can be checked rather than trusted. */
  readonly counts: {
    readonly instruments: number;
    readonly board_rows: number;
    readonly chains_indexed: number;
    readonly board_with_chains: number;
    readonly underlyings_missing_spot: number;
    readonly windows_built: number;
    readonly candidates: number;
    readonly desired_option_subscriptions: number;
    readonly frames_observed: number;
    readonly depth_observations: number;
    readonly usable_books: number;
  };
  readonly instrument_load: InstrumentLoadState;
  readonly instruments_error: string | null;
  readonly instruments_loaded_at: number | null;
  readonly instrument_load_failures: number;
  readonly spot_seed_failed: boolean;
  readonly spot_seed_error: string | null;
  readonly last_successful_build_at: number | null;
  /**
   * Whether a subscribe frame was WRITTEN. NOT a broker acknowledgement — the protocol supplies
   * none, so this must never be rendered as "confirmed by the broker".
   */
  readonly subscriptions_requested: boolean;
  readonly box_socket_connected: boolean;
}

/** Resolve the first unsatisfied stage. Order matters: it is the pipeline order. */
function resolveStage(o: UniverseObservations): UniverseStage {
  if (!o.authenticated) return "not_authenticated";

  /*
   * A STOPPED SCANNER THAT WANTS NOTHING STREAMED IS SIMPLY STOPPED.
   *
   * Checked BEFORE the subscription stages, and this ordering is load-bearing. `refreshUniverse`
   * builds windows when `discoveryAllowed = running || (!marketOpen && indicativeDiscovery)` and
   * deliberately does NOT subscribe the indicative ones — they are priced from last-close prices over
   * REST and cost no subscription budget. So a stopped scanner after hours with the DEFAULT
   * `BOX_INDICATIVE_DISCOVERY=true` legitimately holds windows and candidates with zero desired
   * subscriptions. Diagnosing that further down the walk produced `no_desired_subscriptions` with
   * `transient: false` — a red "nothing subscribed / will NOT clear by itself" badge, every evening
   * and all weekend, on an engine behaving exactly as designed. Its detail sentence ("nothing will
   * ever tick") was false too.
   */
  if (!o.scannerRunning && o.desiredOptionSubscriptions === 0) return "scanner_stopped";

  // The instrument master gates everything, so it is diagnosed before the scanner's own state:
  // a failed download is worth reporting whether or not discovery was requested.
  switch (o.instrumentLoad) {
    case "failed":
      return "instruments_failed";
    case "loading":
      return "instruments_loading";
    case "never_attempted":
      // Never attempted AND not running is simply a stopped scanner — the load is on demand.
      return o.scannerRunning ? "instruments_never_loaded" : "scanner_stopped";
    case "loaded":
      break;
  }
  if (o.instrumentCount === 0) return "instruments_empty";

  if (o.boardRows === 0) return "no_board_rows";
  if (o.chainsIndexed === 0) return "no_option_chains";
  if (o.boardWithChains === 0) return "no_board_chain_overlap";

  // From here on, windows are only built while discovery is allowed, so a stopped scanner is the
  // honest answer rather than "no windows".
  if (!o.scannerRunning && o.windowsBuilt === 0) return "scanner_stopped";

  if (o.windowsBuilt === 0) {
    /*
     * "NO PRICE TO CENTRE ON" vs "BUILT NOTHING FOR ANOTHER REASON".
     *
     * The test is that EVERY joined underlying is missing a spot, not that any is. `seedSpots` seeds
     * at most 500 rows, skips tokens its id resolver cannot map, and drops quotes whose `last_price`
     * is 0 — so one permanently unresolvable underlying is a normal steady state. Triggering on `> 0`
     * meant a token-budget or underlying-cap exhaustion was reported as transient "wait for prices",
     * and `no_windows_built` — whose detail is the one that actually names the cap, the budget and the
     * strike coverage — was effectively unreachable in production.
     */
    const allMissingSpots =
      o.boardWithChains > 0 && o.underlyingsMissingSpot >= o.boardWithChains;
    // A FAILED seed is decisive on its own: it explains the absence regardless of the count.
    return allMissingSpots || o.spotSeedFailed ? "awaiting_spot_prices" : "no_windows_built";
  }
  if (o.candidates === 0) return "no_candidates";
  if (o.desiredOptionSubscriptions === 0) return "no_desired_subscriptions";
  if (!o.boxSocketConnected) return "box_socket_disconnected";
  if (o.framesObserved === 0) return "awaiting_first_tick";
  if (o.depthObservations === 0 || o.usableBooks === 0) return "awaiting_usable_depth";
  return "evaluating";
}

/** Stages where the right action is to wait: they clear on their own if the system is healthy. */
const TRANSIENT: ReadonlySet<UniverseStage> = new Set<UniverseStage>([
  "instruments_never_loaded",
  "instruments_loading",
  "awaiting_spot_prices",
  "awaiting_first_tick",
  "awaiting_usable_depth",
  "box_socket_disconnected",
]);

function describe(stage: UniverseStage, o: UniverseObservations): string {
  switch (stage) {
    case "scanner_stopped":
      return "The scanner is STOPPED, so no universe is built and no candidate is evaluated. Open positions continue to be monitored.";
    case "not_authenticated":
      return "The broker session is not authenticated, so the instrument master cannot be fetched. Sign in to the active broker.";
    case "instruments_never_loaded":
      return "No instrument master has been requested yet. The first universe pass will fetch it.";
    case "instruments_loading":
      return "The instrument master is downloading and none has completed yet. This resolves on its own — wait rather than restarting.";
    case "instruments_failed":
      return (
        `The instrument master could not be loaded after ${o.instrumentLoadFailures} attempt(s), so the universe is empty ` +
        `and nothing can be subscribed. Broker error: ${o.instrumentsError ?? "unknown"}`
      );
    case "instruments_empty":
      return "The instrument master loaded but contained ZERO rows. That is a broker or endpoint problem, not a filter problem — the universe cannot be built from it.";
    case "no_board_rows":
      return (
        `${o.instrumentCount.toLocaleString()} instruments loaded but NO F&O board row survived. The board needs NFO futures rows ` +
        `(instrument_type FUT, with a name) joined to a spot row (NSE EQ, or an INDICES row for an index). ` +
        `A dump missing either side produces this.`
      );
    case "no_option_chains":
      return (
        `${o.boardRows} board row(s) exist but NO option chain could be indexed. Chains need NFO CE/PE rows with a name, ` +
        `a non-expired YYYY-MM-DD expiry, a positive strike and a positive lot size.`
      );
    case "no_board_chain_overlap":
      return (
        `${o.boardRows} board row(s) and ${o.chainsIndexed} option chain(s) exist but they do NOT intersect. The board is keyed on the ` +
        `futures row's underlying name and the chain on the option row's name; if the broker labels them differently, nothing joins.`
      );
    case "awaiting_spot_prices":
      return (
        `${o.boardWithChains} underlying(s) are ready but ${o.underlyingsMissingSpot} still have no spot price, so no ATM window can be ` +
        `centred. Spot prices are seeded over REST because a live spot tick requires a subscription that a window would have to create.` +
        (o.spotSeedFailed ? ` The last seed FAILED: ${o.spotSeedError ?? "unknown"}` : "")
      );
    case "no_windows_built":
      return (
        `Spot prices are available but no strike window was built. Check the underlying cap, the subscription token budget, and that ` +
        `each chain has enough strikes on both sides of the money.`
      );
    case "no_candidates":
      return (
        `${o.windowsBuilt} window(s) built but no four-leg candidate was produced. A box needs two strikes with BOTH a call and a put, ` +
        `and every leg must carry the chain's lot size — a mixed-lot expiry silently drops pairs.`
      );
    case "no_desired_subscriptions":
      return `${o.candidates} candidate(s) exist but no option token was requested from the feed, so nothing will ever tick.`;
    case "box_socket_disconnected":
      return `${o.desiredOptionSubscriptions} option token(s) are wanted but the box-lane market-data socket is not connected. It reconnects on a bounded backoff.`;
    case "awaiting_first_tick":
      return (
        `The box-lane socket is connected and ${o.desiredOptionSubscriptions} subscription(s) were requested, but NO frame has arrived yet. ` +
        `Note that a written subscribe frame is not a broker acknowledgement — this broker sends none.`
      );
    case "awaiting_usable_depth":
      return (
        `Frames are arriving (${o.framesObserved}) but no USABLE two-sided book has been observed, so nothing is executable. ` +
        `An LTP-only packet keeps the transport alive without ever warming a book.`
      );
    case "evaluating":
      return (
        `Evaluating ${o.candidates} candidate(s) across ${o.windowsBuilt} underlying(s) against ${o.usableBooks} usable book(s) ` +
        `from real streamed depth.`
      );
  }
}

/** Diagnose the universe pipeline. Pure. */
export function assessUniverseReadiness(o: UniverseObservations): UniverseReadiness {
  const stage = resolveStage(o);
  return {
    readyToEvaluate: stage === "evaluating",
    stage,
    detail: describe(stage, o),
    transient: TRANSIENT.has(stage),
    counts: {
      instruments: o.instrumentCount,
      board_rows: o.boardRows,
      chains_indexed: o.chainsIndexed,
      board_with_chains: o.boardWithChains,
      underlyings_missing_spot: o.underlyingsMissingSpot,
      windows_built: o.windowsBuilt,
      candidates: o.candidates,
      desired_option_subscriptions: o.desiredOptionSubscriptions,
      frames_observed: o.framesObserved,
      depth_observations: o.depthObservations,
      usable_books: o.usableBooks,
    },
    instrument_load: o.instrumentLoad,
    instruments_error: o.instrumentsError,
    instruments_loaded_at: o.instrumentsLoadedAt,
    instrument_load_failures: o.instrumentLoadFailures,
    spot_seed_failed: o.spotSeedFailed,
    spot_seed_error: o.spotSeedError,
    last_successful_build_at: o.lastSuccessfulBuildAt,
    subscriptions_requested: o.subscriptionsRequested,
    box_socket_connected: o.boxSocketConnected,
  };
}
