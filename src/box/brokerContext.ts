/**
 * The broker-neutral dependencies the Box strategy is allowed to know about.
 *
 * WHY THIS FILE EXISTS
 * BoxEngine used to import `KiteClient` and construct `KiteBrokerAdapter` /
 * `KiteHttpTransport` itself. That made the strategy structurally dependent on
 * one venue: adding a second broker would have meant either a second engine (two
 * copies of the box maths — unacceptable) or `if (broker === "dhan")` branches
 * threaded through the decision path (worse).
 *
 * So the engine now depends only on the three narrow interfaces below. Concrete
 * brokers are assembled OUTSIDE the strategy and injected. The engine cannot name
 * Zerodha or Dhan, and therefore cannot accidentally prefer one.
 *
 * The surface is deliberately tiny — it is exactly what the engine actually used
 * from `KiteClient`, no more:
 *   - an authentication predicate
 *   - REST snapshot quotes (for the last-close view and the spot seed)
 *   - a basket-margin call
 *   - a factory for the live order adapter
 */

import type { BrokerId } from "../brokers/types.js";
import type { BrokerAdapter } from "./brokerAdapter.js";
import type { BoxConfig } from "./config.js";
import type { ExecutionTimingRecorder } from "./executionTiming.js";
import type { BoxCharges, BoxChargesWithOrigin, OrderSide } from "./types.js";

/**
 * One instrument's REST snapshot, broker-neutral.
 *
 * `last_trade_time` is an IST "YYYY-MM-DD HH:MM:SS" string because the last-close
 * view derives the trading SESSION from its date part — that is the only way to
 * tell a strike that genuinely closed today from one whose last print is days old.
 * A provider that cannot supply it must return an empty string, which the caller
 * already treats as "not comparable" rather than as today.
 */
export interface BoxRestQuote {
  instrument_token: number;
  last_price: number;
  last_trade_time: string;
}

/**
 * Read-only market data, as the strategy consumes it.
 *
 * Note there is no `broker` field here: the engine asks the registry which broker
 * is active. Putting it on the provider too would create two answers to one
 * question and invite them to disagree.
 */
export interface BoxMarketDataProvider {
  /**
   * Whether the ACTIVE broker's session can currently serve data.
   *
   * Must reflect the broker session, never an admin password. `getStatus()`
   * publishes this as `authenticated`, and the UI must not print "Connected" for
   * an operator who merely typed the admin secret.
   */
  isAuthenticated(): boolean;
  /**
   * Snapshot quotes for "EXCHANGE:TRADINGSYMBOL" identifiers.
   *
   * Implementations are responsible for their own request chunking and rate
   * limiting; the engine passes the whole universe and expects one array back.
   */
  getQuoteFull(identifiers: string[]): Promise<BoxRestQuote[]>;
  /**
   * The account's available balance and what is already blocked, in rupees.
   *
   * OPTIONAL, and the optionality is the honest part: not every provider can answer this, and a
   * provider that cannot must be distinguishable from an account with no money. An implementation
   * that omits it produces `unavailable_reason: "not_supported"` rather than ₹0.
   *
   * ON THE MARKET-DATA PROVIDER RATHER THAN THE LIVE ORDER ADAPTER, deliberately. The live adapter
   * exists only in live mode, but "how much can I actually trade with?" is a question an operator
   * needs answered while REHEARSING — before arming, not after. The same authenticated session that
   * streams prices can read the balance, so it is asked here and is therefore available in paper too.
   *
   * NULL FIELDS ARE UNKNOWN, NEVER ZERO. Whether `available` is already net of the encumbrance is a
   * per-broker semantic resolved once in `fundsSemantics.ts`; implementations must NOT pre-combine
   * the two numbers, or the meaning would be decided in two places and could differ.
   *
   * May throw. A throw is recorded as a failed read (the previous figure is kept and marked stale),
   * which is why it must not be swallowed into a zero by the implementation.
   */
  getFunds?(): Promise<{ available: number | null; utilised: number | null }>;
}

/** One leg of a basket-margin request, broker-neutral. */
export interface BoxMarginOrder {
  exchange: string;
  tradingsymbol: string;
  transaction_type: "BUY" | "SELL";
  variety: string;
  product: string;
  order_type: string;
  quantity: number;
  price: number;
  /**
   * Real per-unit price of this leg, when the caller knows it.
   *
   * Exists because the brokers differ: Kite's basket endpoint takes an `order_type` and
   * resolves a MARKET leg's price from the LTP itself, so `price` is conventionally 0
   * there. Dhan's calculator has no `order_type` and margins against whatever price it
   * is given, so a leg quoted at 0 (or at a nominal placeholder) loses its premium
   * component. Kite ignores this field; Dhan prefers it.
   */
  reference_price?: number | null;
}

/**
 * Net basket margin for a set of orders priced together.
 *
 * A four-leg box is margined as a BASKET, not as four independent positions — the
 * offsetting legs are most of the point — so this must always be asked about all
 * four legs at once, whichever broker answers.
 */
/**
 * Where a margin figure came from.
 *
 * Recorded because the two Dhan paths are NOT equivalent: the multi-order calculator
 * returns a hedge-adjusted basket figure, whereas summing four standalone legs ignores
 * the offsetting benefit and can over-state the requirement several-fold. An operator
 * comparing margins across days needs to know which one they are looking at.
 */
export type BoxMarginSource =
  /** Zerodha's basket-margin API. */
  | "kite_basket"
  /** Dhan's POST /margincalculator/multi — hedge-adjusted, preferred. */
  | "dhan_multi"
  /** Dhan per-leg margins summed. Conservative UPPER bound; fallback only. */
  | "dhan_per_leg_fallback"
  /** No figure could be obtained. */
  | "unavailable";

export interface BoxBasketMargin {
  /**
   * The margin required to EXECUTE the orders, or `null` when that is UNKNOWN.
   *
   * NULLABLE ON PURPOSE. This field previously could not express "unknown", so callers had to
   * invent a stand-in, and both brokers invented ZERO:
   *   * Dhan mapped `initial: Math.round(normalized.span ?? 0)` — promoting SPAN, which is a
   *     COMPONENT of an F&O margin, to a statement about execution-stage funding, and turning an
   *     ABSENT span into an established requirement of ₹0.
   *   * Zerodha's client returns `0` for a `data.initial` block the API did not send, and its
   *     `initial_available` presence flag was discarded on the way here.
   * Downstream, `Number.isFinite(0)` is true, so a fabricated zero was indistinguishable from a
   * real figure and `buildFundingStages` collapsed the intermediate requirement to the gross
   * option premium — which does not bound the margin a short option requires.
   *
   * Only a value the broker DOCUMENTS as the execute-the-orders margin belongs here. Zerodha
   * documents `data.initial.total`. Dhan publishes no equivalent field, so for Dhan this is
   * `null` and strict stage-funded entry refuses rather than guessing. `null` means UNKNOWN and
   * must never be coerced to 0.
   */
  initial: number | null;
  /**
   * The margin required to HOLD the completed, hedged basket, or `null` when UNKNOWN.
   * Zerodha documents `data.final.total` (the spread-benefit figure). Same null contract.
   */
  final: number | null;
  /**
   * The headline requirement, or `null` when no figure could be established.
   *
   * `null` rather than `0`: a zero total reads as "this box is margin-free", which for a
   * four-leg F&O basket containing short options is never true.
   */
  total: number | null;
  /** Which calculation produced `total`. */
  source: BoxMarginSource;
  /**
   * Whether EVERY requested leg was resolved and answered with a structurally valid figure.
   *
   * THE COMPLETENESS FLAG. Its absence was defect A: the Dhan per-leg fallback counted
   * successes and refused only the all-zero case, so a sum over 1 of 4 legs was returned as
   * `{ total: 1000, source: "dhan_per_leg_fallback" }` — shaped exactly like a complete
   * four-leg sum. A partial sum is an UNDER-statement, not the "conservative upper bound" the
   * fallback claims to be, and no consumer could tell the difference.
   *
   * `false` means the figure is NOT admissible evidence for taking new exposure. It may still
   * be displayed, provided it is labelled.
   */
  complete: boolean;
  /** How many legs the caller asked about. */
  legs_requested: number;
  /**
   * How many legs produced a valid figure. Equal to `legs_requested` iff `complete`.
   * For a netted basket call this is all-or-nothing; for the per-leg sum it is a real count.
   */
  legs_priced: number;
  /** Why the evidence is incomplete, for an operator-facing refusal. `null` when complete. */
  incomplete_reason: string | null;
  /** Benefit attributable to offsetting legs (₹), when the broker reports it. */
  hedge_benefit?: number | null;
  /**
   * SPAN margin, as a LABELLED COMPONENT only.
   *
   * Reported for display and diagnosis. Deliberately NOT usable as `initial`: see that field.
   */
  span?: number | null;
  /** Exposure margin, likewise a labelled component and not a stage requirement. */
  exposure?: number | null;
}

export interface BoxMarginProvider {
  /** Which broker's margin model produced the figure (for provenance display). */
  readonly broker: BrokerId;
  basketMargin(orders: BoxMarginOrder[]): Promise<BoxBasketMargin>;
}

/**
 * Builds the LIVE order adapter for a broker.
 *
 * A FACTORY rather than an instance because live adapters hold sockets, pacing
 * queues and session-local idempotency maps: switching broker must construct a
 * fresh one and discard the old, never mutate a shared object. The engine calls it
 * at most once, only when `executionMode === "live"`.
 *
 * Throwing here is the correct way to fail closed — a missing API key or an
 * unsatisfied static-IP requirement must stop live startup, not degrade to paper
 * silently.
 */
export type BoxLiveAdapterFactory = (ctx: {
  broker: BrokerId;
  cfg: BoxConfig;
  /**
   * LIVE TIMING INSTRUMENTATION (Phase 2). Optional and FAIL-OPEN.
   *
   * Threaded through so the adapter can mark the stages only it witnesses — transport, HTTP,
   * broker ACK, each cumulative fill, and the cancel request/acknowledgement — onto the same
   * per-order trace the OrderManager opened. Without it the adapter records nothing and behaves
   * exactly as before; with it, nothing it does can throw into or delay an order.
   */
  timing?: ExecutionTimingRecorder;
}) => BrokerAdapter;


/**
 * The live feed, as the strategy uses it.
 *
 * Abstracts the six calls BoxEngine made directly on the Kite `TickerHub`. With this
 * in place the engine subscribes, unsubscribes and reads liveness without knowing
 * whether a Kite or a Dhan socket is behind it — which is what lets the registry
 * swap feeds on a broker switch without touching the strategy.
 */
export interface BoxFeedProvider {
  /** Register a tick listener. Returns a remover. */
  addTickListener(fn: (ticks: import("../ticker.js").Tick[]) => void): () => void;
  /**
   * Register a connection-state listener. Returns a remover.
   *
   * Implementations MUST deliver the current state immediately on subscribe, so a
   * late listener cannot mistake books gathered before it attached for warm ones.
   */
  addConnectionListener(fn: (connected: boolean) => void): () => void;
  /** Hold the feed open with no browser attached. Returns a release function. */
  retain(): () => void;
  subscribeTokens(tokens: number[]): void;
  unsubscribeTokens(tokens: number[]): void;
  /**
   * Declare the strategy's ENTIRE token set in one diff.
   *
   * Optional so existing wiring keeps working. When present the engine prefers it,
   * because a moving strike window otherwise unsubscribes tokens that a browser SSE
   * client or another consumer may still need — the refcount can only be maintained
   * correctly if the owner states its whole set rather than deltas.
   */
  setStrategyTokens?(tokens: number[]): void;
  /**
   * Declare the Box lane's ENTIRE token set in one diff.
   *
   * The DEDICATED Box market-data lane: a second physical socket on the same active
   * broker, with its own refcount table and its own token budget. Preferred over
   * `setStrategyTokens` when `BOX_DEDICATED_MARKET_FEED` is on, because sharing one
   * connection makes the option universe and the calendar-spread board compete — every
   * strike the board displaces is an arbitrage the scanner cannot see.
   *
   * Optional so a provider that predates the lane split still satisfies this contract,
   * in which case the engine falls back to the shared feed.
   */
  setBoxTokens?(tokens: number[]): void;
  subscribedCount(): number;
  isConnected(): boolean;
}

/**
 * A charge calculator, as the strategy uses it.
 *
 * `LocalChargeCalculator` (Zerodha) and `DhanChargeCalculator` both satisfy this, so
 * the active broker's fee schedule is injected rather than branched on. This is the
 * seam that stops a Dhan trade from being costed with Zerodha brokerage — the Box
 * expected-net gate spends whatever this object says, so it must be the right one.
 */
export interface BoxChargeCalculatorLike {
  legs(orders: BoxChargeCalcOrder[], source?: BoxCharges["source"]): BoxChargesWithOrigin;
  roundTrip(
    orders: BoxChargeCalcOrder[],
    at?: Date,
  ): {
    entry: BoxChargesWithOrigin;
    estimated_exit: BoxChargesWithOrigin;
    entry_total: number;
    estimated_exit_total: number;
  };
  /** Entry + projected-exit totals — what the hot path actually needs. */
  totals(orders: BoxChargeCalcOrder[]): { entry: number; exit: number };
  /**
   * The stamped rate-card version, so a historical trade stays interpretable after
   * rates change. Widened to the fields the strategy reads, so both brokers' richer
   * rate cards satisfy it.
   */
  readonly rates: { rateVersion: string };
}

/** One order to be costed, broker-neutral. */
export interface BoxChargeCalcOrder {
  side: OrderSide;
  tradingsymbol: string;
  quantity: number;
  price: number;
}
