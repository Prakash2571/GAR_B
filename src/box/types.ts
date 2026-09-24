/**
 * Box-arbitrage domain types.
 *
 * This module is entirely SEPARATE from the calendar-spread engine: it shares
 * only the Kite client, the ticker hub, the instrument cache and the Zerodha
 * charge estimator. No calendar type, schema or collection is reused or
 * modified.
 *
 * A box on strikes K1 < K2 of the same underlying and expiry has TWO directions:
 *
 *   LONG_BOX   BUY  K1 CE / SELL K2 CE / BUY  K2 PE / SELL K1 PE
 *   SHORT_BOX  SELL K1 CE / BUY  K2 CE / SELL K2 PE / BUY  K1 PE
 *
 * Both settle at a fixed (K2 - K1) per unit whatever the underlying does: the
 * long box RECEIVES that width at expiry and the short box PAYS it. So the
 * arbitrage in either direction is the difference between the width and what the
 * four legs are actually worth right now — signed by the direction.
 *
 * BROKER IDENTITY
 * Every record the strategy writes carries the `BrokerId` that created it. The
 * field is OPTIONAL on every persisted shape so documents written before broker
 * identity existed keep loading, and `brokerOf()` resolves an absent value to
 * "zerodha" — which is a statement of fact, since Zerodha was the only broker the
 * application ever had. A record's broker is IMMUTABLE once written.
 */

import type { BrokerId } from "../brokers/types.js";
import type { PaperLegCancelStage } from "./paperLegTimeline.js";
import type { PartialExitMark } from "./partialExitPnl.js";

export type { PaperLegCancelStage, PartialExitMark };

/**
 * One order's charges, as billed by Zerodha's virtual contract note (or by the
 * local deterministic calculator that mirrors it).
 *
 * Structurally identical to the calendar ledger's `ILegCharges` so a box contract
 * note reads exactly like a calendar one — but declared here rather than imported
 * so the box trading core has NO dependency on Mongoose or Express. That keeps
 * the whole decision path (math, liquidity, fees, exits) importable and testable
 * on its own. `model.ts` asserts the two shapes stay compatible.
 */
export interface BoxLegCharges {
  side: OrderSide;
  tradingsymbol: string;
  quantity: number;
  price: number;
  value: number;
  brokerage: number;
  stt: number;
  stt_type: string;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
}

/** The charges of one side of a box (all four orders), with the summed heads. */
export interface BoxCharges {
  legs: BoxLegCharges[];
  value: number;
  brokerage: number;
  stt: number;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
  /** "kite" for the priced fills, "kite_estimate" for a projection. */
  source: "kite" | "kite_estimate";
  at: Date;
}

/**
 * WHO produced these numbers.
 *
 * Deliberately a separate OPTIONAL field rather than a new `source` value: the
 * box charge record must stay structurally interchangeable with the calendar
 * ledger's (see the assignability assertions in model.ts), and widening `source`
 * would break that. It is the honest label the UI needs — a locally computed
 * contract note must never be displayed as if Zerodha had confirmed it.
 *
 *   "local"          computed synchronously from the centralized rate card
 *   "kite"           Zerodha's virtual contract note
 *   "local_verified" local figures that a Zerodha reconciliation has since agreed with
 *   "dhan"           Dhan's own charge/brokerage figures for the executed trade
 *   "dhan_estimate"  Dhan's rate card applied locally (no broker confirmation yet)
 *
 * The two Dhan values exist because Dhan's brokerage and Zerodha's are DIFFERENT
 * numbers. Labelling a locally computed Dhan note as "local" would be honest but
 * useless — the operator needs to know which rate card produced the figure that
 * the expected-net gate actually spent, and a Zerodha-priced note must never be
 * displayed against a Dhan trade.
 */
export type BoxChargeOrigin =
  | "local"
  | "kite"
  | "local_verified"
  | "dhan"
  | "dhan_estimate";

/**
 * A charge record that also says where it came from.
 *
 * `broker` is carried separately from `source` because `BoxCharges` must stay
 * structurally interchangeable with the calendar ledger's `ITradeCharges` (see the
 * assignability assertions in model.ts), whose `source` enum is fixed. So the
 * venue travels alongside rather than inside it — and every charge record can then
 * state, unambiguously, whose fee schedule it represents.
 */
export interface BoxChargesWithOrigin extends BoxCharges {
  computed_by?: BoxChargeOrigin;
  /** Which broker's fee schedule produced these numbers. Absent ⇒ zerodha. */
  broker?: BrokerId;
}

/**
 * The result of checking a locally calculated contract note against Zerodha's.
 *
 * Written asynchronously AFTER a paper fill, never before: the whole point of the
 * local calculator is that no decision waits on the network.
 */
export interface BoxChargeReconciliation {
  status: "pending" | "verified" | "failed";
  /** What the local calculator said (the figure the decision actually used). */
  local_total: number | null;
  /** What Zerodha's virtual contract note said, when it answered. */
  reconciled_total: number | null;
  /** |zerodha - local|, in ₹. */
  abs_diff: number | null;
  /** abs_diff / zerodha_total, as a percentage. */
  pct_diff: number | null;
  /**
   * Per-head local-minus-Zerodha differences (₹). When a discrepancy clusters on
   * one head this points straight at the wrong rate or rounding rule (e.g. STT),
   * instead of leaving a single opaque total to guess about.
   */
  head_diffs?: {
    brokerage: number;
    stt: number;
    exchange_txn: number;
    sebi: number;
    stamp_duty: number;
    gst: number;
  } | null;
  at: Date | null;
  error: string | null;
}

/**
 * How a paper fill is simulated.
 *
 *   "paper_touch"   — fills at the touch visible in the DETECTION snapshot.
 *                     Optimistic: it assumes the book cannot move between seeing
 *                     an opportunity and reaching the exchange. Kept for
 *                     comparison.
 *   "paper_latency" — fills from the first WebSocket book that arrives AT OR
 *                     AFTER a simulated decision + order-send delay, so the
 *                     price the simulator records is one the market actually
 *                     published after the order could have arrived.
 */
export type ExecutionMode = "paper_touch" | "paper_latency" | "paper_legging" | "live";

/**
 * How displayed order-book depth is treated as executable for our simulated
 * order.
 *
 *   "none"    — the full displayed quantity at a price is assumed available to us.
 *   "haircut" — only a configurable fraction is treated as safely executable, a
 *               transparent, DETERMINISTIC stand-in for the queue ahead of us that
 *               level-2 depth cannot reveal. This is NOT a reconstruction of true
 *               NSE queue priority — see orderPricing.ts.
 */
export type BoxQueueModel = "none" | "haircut";
export const EXECUTION_MODES: readonly ExecutionMode[] = [
  "paper_touch",
  "paper_latency",
  "paper_legging",
  "live",
] as const;
/** @deprecated Retained so older imports keep compiling. */
export const EXECUTION_MODE = "paper_touch" as const;

/** Which way round the four legs are traded. */
export type BoxDirection = "LONG_BOX" | "SHORT_BOX";
export const BOX_DIRECTIONS: readonly BoxDirection[] = ["LONG_BOX", "SHORT_BOX"] as const;

/** The four legs of a box, in a fixed order. */
export type BoxLegRole = "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe";

/** Leg roles in canonical order — index 0..3 everywhere in this module. */
export const BOX_LEG_ROLES: readonly BoxLegRole[] = [
  "k1_ce",
  "k2_ce",
  "k2_pe",
  "k1_pe",
] as const;

export type OrderSide = "BUY" | "SELL";

/**
 * Which side each leg trades on ENTRY, per direction.
 *
 * SHORT_BOX is the exact mirror of LONG_BOX. Everything else in the module reads
 * its sides from here, so a direction can never be half-applied.
 */
export const BOX_ENTRY_SIDES_BY_DIRECTION: Readonly<
  Record<BoxDirection, Readonly<Record<BoxLegRole, OrderSide>>>
> = {
  LONG_BOX: { k1_ce: "BUY", k2_ce: "SELL", k2_pe: "BUY", k1_pe: "SELL" },
  SHORT_BOX: { k1_ce: "SELL", k2_ce: "BUY", k2_pe: "SELL", k1_pe: "BUY" },
} as const;

/** Long-box entry sides. Kept as a named export for compatibility. */
export const BOX_ENTRY_SIDES: Readonly<Record<BoxLegRole, OrderSide>> =
  BOX_ENTRY_SIDES_BY_DIRECTION.LONG_BOX;

/**
 * +1 for a long box, -1 for a short box.
 *
 * The ONE place the sign of the strike width lives. A long box receives the width
 * at expiry; a short box pays it. Every edge, P&L and convergence figure is
 * derived from this so the two directions cannot drift apart.
 */
export function directionSign(direction: BoxDirection): 1 | -1 {
  return direction === "LONG_BOX" ? 1 : -1;
}

/** One level of the order book. */
export interface BoxDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

/**
 * A point-in-time view of one instrument's executable book.
 *
 * IMMUTABLE: the quote store replaces the whole object on every accepted packet
 * and never mutates one in place, so a stored reference is a permanent record of
 * that packet. `at` is when it was RECEIVED (not an exchange timestamp), which is
 * what the freshness gate is measured against.
 */
export interface BoxQuote {
  token: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  bids: BoxDepthLevel[];
  asks: BoxDepthLevel[];
  /** Monotonic local sequence assigned when a WebSocket depth packet arrives. */
  version: number;
  /** Epoch ms when this book was RECEIVED — what the freshness gate is measured against. */
  at: number;
  /**
   * The EXCHANGE timestamp of this packet (epoch ms), when the feed supplied one.
   *
   * Kept ALONGSIDE `at`, never instead of it: receive time drives feed-health and
   * freshness (a genuinely dead feed is only visible in receive time), while the
   * exchange timestamp is what makes cross-leg temporal coherence meaningful — it
   * says when the exchange published the book, not when our process saw it. Null
   * when the feed did not carry one, in which case callers fall back to `at`.
   */
  exchange_at: number | null;
  /** Executable Box books are accepted from the live WebSocket only. */
  source: "ws";
}

/**
 * The LIGHTWEIGHT execution view of one side of one book — what the hot path
 * needs and nothing more.
 *
 * The five-level ladder is deliberately absent: cloning four ladders for each of
 * up to 21 candidates on every tick was pure allocation churn, and none of the
 * qualification arithmetic looks past the touch. The full depth is captured
 * separately (see `captureDepth`) at the few moments that genuinely need an
 * audit record.
 */
export interface BoxTouch {
  token: number;
  side: OrderSide;
  /** ask for BUY, bid for SELL — the only price a paper fill may use. */
  price: number | null;
  /** Quantity resting at EXACTLY that price. */
  qty: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  version: number;
  at: number;
  age_ms: number;
  fresh: boolean;
}

/** An option contract in a monitored strike window. */
export interface BoxOptionInstrument {
  token: number;
  tradingsymbol: string;
  exchange: string;
  strike: number;
  instrument_type: "CE" | "PE";
  expiry: string;
  lot_size: number;
  /**
   * The exchange tick size (₹) for this contract, from the instrument dump.
   *
   * Used to price marketable-limit orders in paper_legging — the limit is a whole
   * number of ticks past the reference touch. Optional so a leg constructed before
   * tick size was carried (or from a fixture) still loads; the executor falls back
   * to `BOX_DEFAULT_TICK_SIZE` when it is absent.
   */
  tick_size?: number;
}

/** One underlying being scanned, with its resolved seven-strike window. */
export interface BoxUnderlyingState {
  underlying: string;
  name: string;
  is_index: boolean;
  spot_token: number;
  expiry: string;
  lot_size: number;
  /** Strike step of the chain (median gap between adjacent strikes). */
  strike_step: number;
  /** The ATM strike the current window is centred on. */
  atm_strike: number;
  /** Exactly the strikes ATM-3 .. ATM+3 that exist in the chain (max 7). */
  strikes: number[];
  /** CE/PE instrument per strike in the window. */
  ce: Map<number, BoxOptionInstrument>;
  pe: Map<number, BoxOptionInstrument>;
  /** Spot value the window was last centred with, and when. */
  spot: number;
  spot_at: number;
  /** When the window was last rebuilt (used to damp resubscription churn). */
  window_at: number;
}

/**
 * One evaluable box: a strike pair AND a direction.
 *
 * At most C(7,2) x 2 = 42 candidates per underlying — 21 pairs each evaluated
 * long and short. The direction is part of the identity, so a long box and a
 * short box on the same strikes are different candidates and different positions.
 */
export interface BoxCandidate {
  /** Stable key: underlying|expiry|K1|K2|DIRECTION. */
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  /** The four contracts, keyed by role. */
  legs: Record<BoxLegRole, BoxOptionInstrument>;
}

/** Why a candidate could not be paper-traded. */
export type BoxRejectReason =
  | "no_quote"
  | "stale_quote"
  | "missing_bid"
  | "missing_ask"
  | "insufficient_qty"
  | "below_gross_prefilter"
  | "below_net_edge"
  /** The decisive gate: expected NET profit after all costs is too small. */
  | "below_expected_net_profit"
  /** The simulated execution after the latency delay could not fill. */
  | "execution_failed"
  | "unpriced_charges"
  | "duplicate_open"
  | "stale_underlying"
  /** The market is shut, so these figures are indicative and not executable. */
  | "market_closed"
  /**
   * The last-close prices do not form a coherent box, which means at least one
   * leg has not traded recently enough to be comparable.
   */
  | "implausible_close";

/** Per-leg liquidity/freshness detail for an evaluation. */
export interface BoxLegEvaluation {
  role: BoxLegRole;
  side: OrderSide;
  token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "CE" | "PE";
  /** The executable price for this side: ask for BUY, bid for SELL. */
  price: number | null;
  /** Quantity available AT that exact touch price. */
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  quote_at: number | null;
  /** Exchange publication timestamp for this immutable WS book, when supplied. */
  exchange_at?: number | null;
  /** WS sequence of the exact immutable book used for this leg. */
  quote_version?: number | null;
  /**
   * Five-level WS book — populated ONLY when the evaluation was asked to capture
   * depth (entry/exit snapshots, audit events, chain requests). Null on the hot
   * path by design.
   */
  depth?: BoxDepthSnapshot | null;
  age_ms: number | null;
  fresh: boolean;
  /** True when price > 0 and qty_at_touch >= lot size. */
  executable: boolean;
}

/**
 * A fully evaluated candidate at one instant, computed only from executable
 * bid/ask (never LTP, never mid).
 */
export interface BoxEvaluation {
  candidate: BoxCandidate;
  at: number;
  legs: BoxLegEvaluation[];
  /**
   * Net DEBIT per unit: sum of (+price for every BUY leg, -price for every SELL
   * leg) at the executable touch.
   *
   * Positive means the box costs money to put on (the usual long box); negative
   * means it pays a credit (the usual short box). One formula, both directions.
   */
  entry_net_debit_per_unit: number | null;
  /**
   * The long box's cost per unit. Same number as `entry_net_debit_per_unit`,
   * retained under its original name so existing consumers keep working.
   */
  entry_box_cost_per_unit: number | null;
  /** directionSign x width - netDebit, per unit. */
  gross_edge_per_unit: number | null;
  /** gross_edge_per_unit * lot_size. */
  gross_edge: number | null;
  /** All four legs quoted, fresh and one-lot executable. */
  tradable: boolean;
  /**
   * All four legs show a whole lot at the touch, IGNORING freshness.
   *
   * Reported separately from `tradable` so liquidity and staleness can be told
   * apart: "the book is thin" and "the book has not been pushed for a while" are
   * different problems with different fixes.
   */
  depth_ok: boolean;
  /** Oldest leg quote age in ms (the freshness that actually binds). */
  worst_age_ms: number | null;
  /** Highest WS version across the four legs — the snapshot's identity. */
  quote_version: number | null;
  reject: BoxRejectReason | null;
}

/** Charge estimate for a box (four entry orders + four exit orders). */
export interface BoxChargeEstimate {
  entry: BoxCharges;
  /** Conservative projection of the cost to unwind. */
  estimated_exit: BoxCharges;
  entry_total: number;
  estimated_exit_total: number;
  /** Per-leg rows kept for the audit ledger. */
  entry_legs: BoxLegCharges[];
  exit_legs: BoxLegCharges[];
}

/**
 * The full arithmetic of an entry decision — every term visible, nothing hidden
 * behind a single number.
 *
 *   expected_net = gross
 *                - entry_charges
 *                - estimated_exit_charges
 *                - execution_cost      (measured slippage + exit allowance)
 *                - safety_buffer
 *
 * `qualifies` is expected_net >= min_expected_net_profit. That is THE entry
 * decision; the gross figure is only a cheap prefilter.
 */
export interface BoxEntryDecision {
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  /**
   * The total execution/slippage cost actually DEDUCTED from expected net (₹) —
   * `entry_slippage_allowance + future_exit_slippage_allowance`.
   *
   * DELIBERATELY the sum of the two named allowances below, never the measured
   * entry slippage: at the FINAL qualification `gross_edge` is already the
   * executed gross edge (adverse entry movement is baked into it), so deducting
   * the measured entry slippage again would double-count it.
   */
  execution_cost: number;
  /**
   * PRE-EXECUTION only: the expected entry-slippage allowance deducted while
   * merely projecting whether an opportunity is worth starting. Zero at the final
   * qualification, where the executed gross edge already reflects real movement.
   */
  entry_slippage_allowance: number;
  /** The expected FUTURE exit-slippage allowance (₹) — always a forward cost. */
  future_exit_slippage_allowance: number;
  /**
   * ANALYTICS ONLY: the entry slippage actually measured against the detection
   * touch (₹, positive = worse). Recorded and exposed, but NOT subtracted from
   * expected net — the executed gross edge already contains it.
   */
  measured_entry_slippage: number | null;
  safety_buffer: number;
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  /** True when the gross prefilter was cleared (cheap, first-pass). */
  passes_gross_prefilter: boolean;
  qualifies: boolean;
  reject: BoxRejectReason | null;
}

/** An opportunity as published to the UI. */
export interface BoxOpportunity {
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  /** Signed net debit of the four entry orders (negative = credit received). */
  entry_box_cost: number | null;
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  /** Expected execution/slippage cost carried in the projection (₹). */
  execution_cost: number;
  safety_buffer: number;
  /** gross - entryFees - estExitFees - executionCost - safetyBuffer. */
  projected_net_edge: number | null;
  /** Same figure under its decision-facing name. */
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  /** Whether the charge figures behind this row are local or Zerodha-verified. */
  charge_origin: BoxChargeOrigin;
  /** The four entry orders, so the direction's sides are unambiguous in the UI. */
  entry_sides: { role: BoxLegRole; side: OrderSide; tradingsymbol: string }[];
  /** True when every leg is fresh AND one-lot executable at the touch. */
  liquidity_ok: boolean;
  /** One whole lot available on all four legs, ignoring how quiet the book is. */
  depth_ok: boolean;
  worst_age_ms: number | null;
  /**
   * Where the prices behind this row came from.
   *
   * "touch"     — executable best bid/ask. The only source that can be traded.
   * "last_close"— last traded / closing prices, shown while the market is shut.
   */
  price_source: "touch" | "last_close";
  /**
   * "INDICATIVE" — the market is closed, so this is a last-close view only.
   * "UNPRICED"   — charges could not be determined.
   * Neither is ever auto-traded.
   */
  status:
    | "WATCHING"
    | "INDICATIVE"
    | "UNPRICED"
    | "ELIGIBLE"
    | "PAPER_OPENED"
    | "LIVE_OPENED"
    | "OPEN"
    | "REJECTED";
  reject: BoxRejectReason | null;
  legs: BoxLegEvaluation[];
  updated_at: number;
}

/* -------------------------------------------------------------------------- */
/*  Execution simulation                                                      */
/* -------------------------------------------------------------------------- */

/** Why a simulated execution did not produce a fill. */
export type BoxExecutionFailureReason =
  | "price_moved"
  | "insufficient_quantity"
  | "missing_book"
  | "feed_unhealthy"
  | "market_closed"
  | "edge_disappeared"
  | "below_expected_net_profit"
  | "discovery_stopped"
  | "duplicate"
  /** paper_legging: at least one leg did not fill before the timeout. */
  | "legging_incomplete"
  /** paper_legging: a filled leg could not be unwound (no executable opposite price). */
  | "unwind_failed"
  /**
   * The four legs' EXCHANGE timestamps were too far apart to be a coherent
   * cross-sectional snapshot, so the candidate was not auto-entered.
   */
  | "cross_leg_time_skew"
  /**
   * paper_legging: ALL FOUR legs filled, but the final economics computed on the
   * EXECUTED prices no longer clear the required expected net profit.
   *
   * This is not a refusal — the orders really filled, so a real position existed.
   * The box is never opened; instead all four legs are immediately reversed and
   * the true cost of that round trip is booked as the abort P&L.
   */
  | "abort_after_fill"
  /**
   * The four bounded ENTRY orders' GROSS NOTIONAL exceeds
   * `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES`.
   *
   * A PRE-TRADE refusal: it is decided from the immutable bounded LIMIT requests before any
   * broker mutation, so nothing reached the market. Note the metric is gross option-order
   * notional, NOT broker margin — see boxCapital.ts.
   */
  | "box_capital_limit"
  /**
   * `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING` is enabled and this underlying already carries an
   * active Box, partial position, recovery position, residual exposure or in-flight entry.
   *
   * DELIBERATELY DISTINCT from a contract-reservation conflict: the two Boxes may share no
   * option at all. Reporting this as a reservation conflict would misdescribe the cause and
   * point an operator at the wrong remedy.
   */
  | "underlying_already_active"
  /**
   * The underlying is on the operator's blocklist (`box_excluded_underlyings`), or that blocklist
   * could not be read and therefore cannot confirm this name is tradable.
   *
   * DELIBERATELY DISTINCT from `underlying_already_active`: nothing is wrong with the market or with
   * our own exposure — an operator has simply said this name is not to be entered. Reporting it as a
   * conflict or a market rejection would send them looking for a fault that does not exist.
   *
   * Blocks NEW ENTRY ONLY, in every execution mode. An excluded name whose Box is already open is
   * still monitored, still exits, and can still be flattened — see underlyingExclusions.ts.
   */
  | "underlying_excluded"
  /**
   * `BOX_MAX_OPEN_BOXES` — the MODE-INDEPENDENT inventory ceiling — is already met.
   *
   * DELIBERATELY DISTINCT from `underlying_already_active` (which is per-underlying) and from the
   * live-only open-box guard inside BoxOrderManager (which is read from a count refreshed only after
   * a position exists, and is invisible in paper). This one is decided in the coordinator's
   * synchronous admission prologue in EVERY mode, against committed exposure — open positions,
   * unresolved residuals and intents, in-flight entry claims and uncertain reservation holds.
   *
   * Blocks NEW ENTRY ONLY. Nothing about a full inventory is a reason exposure cannot be reduced.
   */
  | "box_inventory_limit"
  /**
   * The armed trading session has consumed its permitted Box lifecycles
   * (`BOX_SESSION_MAX_COMPLETED_TRADES`), or no session is armed.
   *
   * Blocks NEW ENTRY ONLY. Monitoring, exit, residual flattening, reconciliation and recovery
   * all continue — a spent session budget must never be a reason exposure cannot be reduced.
   */
  | "session_limit_reached"
  /**
   * The RECORD and the PROCESS disagree about whether the fills are real.
   *
   * Restored state carries the execution mode it was actually created under
   * (`IBoxTrade.execution_mode`, `IBoxExecutionAttempt.execution_mode`) precisely so it can be
   * compared against the running process — but nothing compared them, and the exit/flatten path
   * forked on the PROCESS mode alone. Both directions were unsafe:
   *
   *   live process + paper record — a simulated position drives REAL broker orders. The manager's
   *                                attributed-position check is keyed by `exchange:tradingsymbol`,
   *                                so when a genuine live box holds the same contract the paper
   *                                record's exit passes every side/size test and reduces the LIVE
   *                                box's exposure.
   *   paper process + live record — the close is SIMULATED and the row is marked closed while real
   *                                broker exposure remains. No order is ever sent, and nothing says so.
   *
   * Refusing is the safe answer in both directions, because the refusal strands nothing this process
   * could legitimately have acted on: a paper record has no real exposure to leave behind, and a live
   * record's real exposure must be reduced by a live process, never simulated away. The refusal is
   * always accompanied by a `reduction`-scoped readiness blocker, so it can never be silent.
   *
   * Compared on the PAPER/LIVE BOUNDARY only (see `isPaperExecutionMode`), never by exact equality —
   * `paper_touch` and `paper_latency` are freely interchangeable and must stay so.
   */
  | "execution_mode_mismatch"
  /**
   * The instrument's LOT SIZE cannot satisfy the live quantity envelope — one lot exceeds
   * `BOX_LIVE_MAX_OPEN_LEG_QUANTITY`, or four legs of one lot exceed
   * `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY`.
   *
   * DELIBERATELY DISTINCT FROM `insufficient_quantity`, which means the executable DEPTH could not
   * fill one lot. This is the opposite problem: the market is irrelevant, the instrument is simply
   * too large for the configured envelope, and no amount of liquidity changes that. Reporting it as
   * a liquidity refusal sent an operator to look at the order book for a configuration mismatch.
   *
   * Decided in the coordinator's synchronous prologue from the candidate's own lot size, BEFORE the
   * session attempt is consumed — see the long note at that gate for what this previously cost.
   * LIVE ONLY: the caps live in BoxOrderManager, which paper never constructs.
   */
  | "lot_exceeds_quantity_cap"
  /**
   * Box legs are held AT THE BROKER that no open trade and no residual attempt accounts for —
   * almost certainly a fill confirmed before a previous process could record it. Nothing is
   * reducing that exposure automatically, so no NEW box is admitted until an operator resolves it.
   *
   * DELIBERATELY DISTINCT FROM `underlying_already_active`, and this distinction is the whole
   * point: unowned exposure is not attached to a *known* position, so the per-underlying lock
   * cannot see it — its input is the durable position book, which by definition has no row for
   * this exposure. It is equally invisible to `box_inventory_limit`, whose count is derived from
   * that same book. A candidate on a COMPLETELY DIFFERENT underlying therefore used to sail
   * through every admission gate while four unowned legs sat at the broker.
   *
   * Decided in the coordinator's synchronous prologue from the SAME shared derivation that
   * produces the operator's `unowned_attributed_exposure` readiness blocker, BEFORE the claim,
   * BEFORE the session attempt is consumed, BEFORE any reservation and long before any broker
   * POST — so a refusal costs nothing and, critically, cannot be converted into new exposure.
   *
   * Blocks NEW ENTRY ONLY, in every mode that attributes broker exposure. Exits, protective
   * cancellation, reconciliation, residual flattening and the operator-invoked emergency flatten
   * all remain available — they are the only things that can clear this state, so gating them on
   * it would make it permanent.
   */
  | "unowned_attributed_exposure";

/** One leg's detection → execution comparison. */
export interface BoxExecutionLeg {
  role: BoxLegRole;
  side: OrderSide;
  token: number;
  tradingsymbol: string;
  /** The touch that was visible when the box was DETECTED. */
  detected_price: number | null;
  detected_qty: number;
  detected_quote_version: number | null;
  detected_quote_at: number | null;
  detected_exchange_at?: number | null;
  /** Full immutable book from detection, including bid/ask/qty/depth. */
  detected_depth?: BoxDepthSnapshot | null;
  /** The touch from the first WS book at/after the simulated arrival. */
  executed_price: number | null;
  executed_qty: number;
  executed_quote_version: number | null;
  executed_quote_at: number | null;
  executed_exchange_at?: number | null;
  /**
   * Cost of the move, per unit: positive means the market moved AGAINST us
   * (paying more on a BUY, receiving less on a SELL).
   */
  slippage_per_unit: number | null;
  /** slippage_per_unit x lot size. */
  slippage: number | null;
  /** Age (ms) of the book used, measured at the simulated arrival/fill instant. */
  executed_book_age_ms?: number | null;
  /** True when a newer book arrived during the latency (version changed). */
  book_changed?: boolean;
  /** Five-level book at execution — the audit record of the fill. */
  executed_depth: BoxDepthSnapshot | null;
}

/**
 * The complete record of one simulated execution: what was seen, what could
 * actually have been filled, and how far apart they were.
 */
export interface BoxExecutionRecord {
  mode: ExecutionMode;
  detected_at: number;
  /** detected_at + decision delay + send latency. */
  order_sent_at: number;
  executed_at: number | null;
  /** executed_at - detected_at: the real answer to "how late is the fill". */
  decision_to_fill_ms: number | null;
  simulated_decision_ms: number;
  simulated_latency_ms: number;
  detection_quote_version: number | null;
  execution_quote_version: number | null;
  /** Box value per unit at detection and at execution. */
  detected_net_debit_per_unit: number | null;
  executed_net_debit_per_unit: number | null;
  detected_gross_edge: number | null;
  executed_gross_edge: number | null;
  /** Sum of the four legs' slippage, in ₹ (positive = worse than detected). */
  total_slippage: number;
  legs: BoxExecutionLeg[];
  filled: boolean;
  failure_reason: BoxExecutionFailureReason | null;
  failure_detail: string | null;
}

/* -------------------------------------------------------------------------- */
/*  paper_legging — four independent orders, not one atomic box                */
/* -------------------------------------------------------------------------- */

/** How the four legs are submitted in paper_legging. */
export type BoxLegExecutionMode = "parallel" | "sequential";

/**
 * The lifecycle state of one simulated leg order.
 *
 *   CREATED          built, not yet submitted (sequential mode: waiting its turn)
 *   SUBMITTED        released to the simulated broker at submit_at
 *   IN_FLIGHT        travelling; cannot fill before arrival_at
 *   PENDING          arrived and resting — the book could not fill any of it yet
 *   PARTIALLY_FILLED some quantity filled by walking depth within the limit, but
 *                    not the whole order; the remainder rests for later liquidity
 *   FILLED           the full requested quantity filled at observed executable prices
 *   TIMED_OUT        still not fully filled at arrival_at + BOX_LEG_TIMEOUT_MS
 *                    (may carry a non-zero fill_qty — a partial that never completed)
 *   CANCELLED        withdrawn before completing (STOP / feed / market before fill)
 *   FAILED           could not be worked at all (never submitted, sequential skip)
 *   UNWINDING        a filled/partial leg whose reversal is in flight
 *   UNWOUND          filled, then successfully reversed
 *   UNWIND_FAILED    filled, and the reversal found no executable opposite price —
 *                    so simulated exposure is STILL OUTSTANDING and must stay visible
 */
/**
 * Two further states exist under the live_parity profile only, because they model something
 * standard paper does not attempt:
 *
 *   ACKNOWLEDGED      the broker has accepted the order but it is not yet confirmed working at
 *                     the exchange. Held explicitly so that an ACK can never be mistaken for a
 *                     fill — see orderLifecycle.stageProvesExecution.
 *   CANCEL_REQUESTED  a cancel is in flight and HAS NOT been confirmed. The order is STILL
 *                     eligible to fill: this is the state in which the real cancel-vs-fill
 *                     race happens, and modelling it is the whole point.
 */
export type PaperLegStatus =
  | "CREATED"
  | "SUBMITTED"
  | "IN_FLIGHT"
  | "ACKNOWLEDGED"
  | "PENDING"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_REQUESTED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "FAILED"
  | "UNWINDING"
  | "UNWOUND"
  | "UNWIND_FAILED";

/**
 * How the order interacts with the book.
 *
 *   MARKETABLE_LIMIT — priced to cross immediately (a bounded limit at or through the touch).
 *                      Its fill behaviour depends on visible depth within the limit, which we
 *                      CAN observe. This is what the Box strategy submits.
 *   PASSIVE_LIMIT    — priced away from the touch, resting behind unknown queue depth. Whether
 *                      it fills depends overwhelmingly on true NSE queue position, which a
 *                      retail feed does not expose.
 *
 * Recorded per order so realism scoring and parity reports can keep the two populations
 * apart. They must never be pooled: passive fill statistics would flatter marketable orders
 * and vice versa, and a blended figure describes neither.
 */
export type PaperOrderType = "MARKETABLE_LIMIT" | "PASSIVE_LIMIT";

/**
 * The executable price envelope of one simulated order.
 *
 * This is the heart of the realism model: an order does NOT consume whatever the
 * book shows on arrival. It carries a LIMIT computed from the reference touch it
 * was priced against plus a bounded number of ticks of chase, and no depth level
 * worse than that limit is ever filled.
 *
 *   BUY : limit_price = reference_price + max_chase_ticks × tick_size
 *   SELL: limit_price = reference_price − max_chase_ticks × tick_size
 */
export interface PaperOrderPricing {
  order_type: PaperOrderType;
  side: OrderSide;
  quantity: number;
  /** The touch this order was priced against (ask for a BUY, bid for a SELL). */
  reference_price: number;
  /** Exchange tick size used to size the chase band (₹). */
  tick_size: number;
  /** How many ticks past the reference the order may chase. */
  max_chase_ticks: number;
  /** The worst price the order will accept (₹). */
  limit_price: number;
}

/** One executed slice of an order: a quantity taken at one book level and instant. */
export interface PaperFillSlice {
  price: number;
  qty: number;
  /** Quantity DISPLAYED at that level in the book. */
  displayed_qty: number;
  /** Quantity treated as executable for us after the queue model (≤ displayed). */
  effective_qty: number;
  /** When this slice filled (epoch ms) — the timestamp of the book it came from. */
  at: number;
  /** WS version of the book this slice was taken from. */
  quote_version: number | null;
}

/**
 * One leg's independent execution attempt under paper_legging.
 *
 * Every price here is an observed executable price from a real WebSocket book at
 * the moment it filled — never invented, never a random slippage figure.
 */
export interface PaperLegExecution {
  role: BoxLegRole;
  side: OrderSide;
  token: number;
  tradingsymbol: string;
  /** Deterministic internal id of this order, for reconciliation. */
  order_id: string;
  /** Client order id (mirrors order_id in paper; the seam a real broker would map). */
  client_order_id: string;
  /** The executable-price envelope this order was worked under. */
  pricing: PaperOrderPricing | null;
  /** The touch visible when the box was detected. */
  detected_price: number | null;
  detected_qty: number;
  submit_at: number;
  /** submit + per-leg network/broker latency. */
  arrival_at: number;
  /**
   * When the broker ACKNOWLEDGED the order (live_parity only; null in standard paper).
   *
   * Recorded separately from `arrival_at` so the ACK is a first-class, measurable event rather
   * than an implicit side effect of arrival. AN ACK IS NOT A FILL: this timestamp says the
   * order exists at the broker, and nothing whatsoever about executed quantity.
   */
  ack_at: number | null;
  /** When the order arrived and began RESTING unfilled (null if it never did). */
  pending_since: number | null;
  /** arrival_at + BOX_LEG_TIMEOUT_MS — the instant this order gives up. */
  timeout_at: number | null;
  /**
   * When a cancel was REQUESTED (live_parity only; null in standard paper).
   *
   * Between this instant and `cancel_confirmed_at` the order is still working at the exchange
   * and may still fill — a cancel request is a request, not an outcome.
   */
  cancel_requested_at: number | null;
  /** When the cancel was CONFIRMED terminal by the broker. */
  cancel_confirmed_at: number | null;
  /**
   * Cumulative filled quantity at the instant the cancel was requested.
   *
   * Retained purely so the race is visible: the difference between this and the final
   * `fill_qty` is quantity that filled while the cancellation was in flight. The final
   * quantity, never this one, is authoritative.
   */
  fill_qty_at_cancel_request: number | null;
  /** Quantity that filled AFTER the cancel was requested. The race, quantified. */
  raced_fill_qty: number;
  /**
   * WHERE the order was when a cancel was requested — null when none ever was.
   *
   * Only `at_exchange` may participate in the cancel-vs-fill race. A cancel issued while the
   * order was still in transport (`in_transport`) or before it was ever submitted
   * (`pre_submission`) removes an order that was never resting on the book, so it cannot fill:
   * previously the abort path made every unresolved leg `CANCEL_REQUESTED` regardless of
   * arrival, which let a leg in flight produce `fill_at < arrival_at`.
   *
   * See `paperLegTimeline.ts`. Recorded so parity statistics can separate "cancelled in
   * transport" from "cancelled while working", which are different market events.
   */
  cancel_stage: PaperLegCancelStage | null;
  /**
   * Executable quantity WITHIN THE LIMIT on the first book this order was offered, before any of it
   * was consumed (queue haircut applied, concurrent reservations subtracted).
   *
   * The denominator of the realisation ratio: what we could actually SEE and were willing to pay
   * for. Captured once, at the first fill attempt, because that is the closest observable analogue
   * of "displayed depth at submission". Null when the order never saw a usable book.
   */
  executable_within_limit_at_arrival: number | null;
  /** Total displayed quantity on our side of that first book, before the queue haircut. */
  displayed_qty_at_arrival: number | null;
  /** Signed ticks from the opposite touch when priced. Positive = through the touch. */
  limit_offset_ticks: number | null;
  /** When the order became FULLY filled (null if it never did). */
  fill_at: number | null;
  /** When the fill (or failure) resolved. */
  resolved_at: number | null;
  /** The weighted-average fill price across all slices, or null if nothing filled. */
  fill_price: number | null;
  /** Same figure under an explicit name. */
  average_fill_price: number | null;
  /** The requested quantity (one lot). */
  quantity: number;
  requested_qty: number;
  /** Quantity actually filled, and what was left unfilled. */
  fill_qty: number;
  remaining_qty: number;
  /** Individual fill slices, in fill order. */
  fills: PaperFillSlice[];
  /** WS version of the LAST book a slice was taken from. */
  quote_version: number | null;
  /** RECEIVE timestamp of the last book a slice was taken from. */
  book_at: number | null;
  /** EXCHANGE timestamp of that book, when the feed supplied one. */
  book_exchange_at: number | null;
  /** Book age at the leg's arrival (ms). */
  book_age_ms: number | null;
  /** fill − detected, signed so positive is always worse (₹, over filled qty). */
  slippage: number | null;
  status: PaperLegStatus;
  /** If the leg had to be unwound, the average opposite price it was closed at. */
  unwind_price: number | null;
  unwind_slippage: number | null;
  /** Quantity actually flattened by the unwind (≤ fill_qty). */
  unwound_qty: number;
  fail_reason: string | null;
}

/**
 * Outstanding simulated exposure that a box execution could not resolve to a flat
 * or complete position.
 *
 * Created when a partial entry cannot be fully unwound, a partial exit leaves the
 * original box half-closed, or an emergency unwind fails. It is NEVER treated as
 * flat: the engine keeps it visible and the monitor keeps trying to flatten it
 * while the market is open and the feed is healthy.
 */
export type ResidualExposureSource = "partial_entry" | "partial_exit" | "failed_unwind";

export interface ResidualLegExposure {
  token: number;
  tradingsymbol: string;
  /** Exchange is retained for live crash-recovery orders; legacy paper rows omit it. */
  exchange?: string;
  role: BoxLegRole;
  /** The side we are currently HOLDING (BUY = long the contract, SELL = short it). */
  side: OrderSide;
  /** Outstanding quantity still on our book. */
  quantity: number;
  /** Average price we acquired it at (₹). */
  average_price: number;
  /** Where this residual came from. */
  source: ResidualExposureSource;
  created_at: number;
  /**
   * DURABLE FLATTEN GENERATION — the attempt number the NEXT flatten submission must use.
   *
   * `created_at` is deliberately preserved when a shrunken residual is written back, so it
   * cannot distinguish one flatten attempt from the next. Without a generation every pass
   * regenerates the same `client_order_id`, and a live residual can therefore never be
   * flattened a second time (see `residualFlatten.ts` for the full failure analysis).
   *
   * Persisted inside `BoxExecutionAttempt.residual_exposure` by the SAME write that persists
   * the new remaining quantity, so advancing the generation and shrinking the exposure are one
   * atomic durable transition.
   *
   * OPTIONAL FOR BACKWARDS COMPATIBILITY: rows written before this field existed read as
   * attempt 1, which is the safe reading — attempt 1's durable intent is adopted rather than
   * duplicated if it already exists.
   */
  flatten_attempt?: number;
  /**
   * Broker cumulative fill already represented by this residual projection for
   * `flatten_attempt`. Optional legacy rows start at zero.
   */
  flatten_accounted_filled?: number;
  /**
   * Cumulative charge estimate already represented for the same durable flatten
   * identity. Stored beside quantity so replay after a crash can bill only the
   * incremental cumulative charge.
   */
  flatten_accounted_charges?: number;
  /**
   * How many times the BROKER has terminally rejected a reduction of this residual, with zero
   * exposure PROVEN each time.
   *
   * WHY THIS COUNTER EXISTS. A broker rejection used to map to `adopt_attempt`, which never
   * advances `flatten_attempt` — so the next pass regenerated the identical `client_order_id`,
   * the durable journal adopted the REJECTED intent instead of submitting, and the naked leg was
   * stranded permanently. One transient refusal (a momentary margin shortfall, a `market_closed`
   * race at 15:30, a freeze-quantity or price-band refusal) was enough to leave real exposure
   * unmanaged until a human noticed.
   *
   * Retiring past a rejection is SAFE because the gateway only classifies `broker_rejected` after
   * `verifyZeroBrokerExposure(...).proven` — a rejected order holds no quantity, so a fresh
   * identity cannot duplicate a fill. What retirement must not be is UNBOUNDED: a structurally
   * impossible reduction (instrument in an F&O ban period, contract expired, RMS block) would
   * otherwise POST every `RESIDUAL_FLATTEN_MS` forever and burn the account's daily order budget
   * that protective work for other positions depends on.
   *
   * So the policy is: retry a bounded number of times, then stop POSTing and escalate to the
   * operator. Persisted by the same atomic `$set` as the quantity and the generation.
   */
  flatten_broker_rejections?: number;
}

/**
 * The complete record of one paper_legging execution — whether it opened a box
 * (4/4 filled) or aborted (some legs filled, others failed → emergency unwind).
 *
 * When it aborts it still costs money: partial-entry charges on the filled legs
 * plus the charges and adverse touch of unwinding them. That legging loss is the
 * whole reason this model exists.
 */
/**
 * HOW A BOX ENTRY ATTEMPT ENDED, as one label an operator can read.
 *
 * The distinction that matters, and the reason this type exists:
 *
 *   REFUSED_BEFORE_SUBMIT       nothing reached the broker. No exposure, no cost.
 *   NO_FILL                     orders reached the broker and none filled.
 *   PARTIAL_ENTRY_UNWOUND       some legs filled; the confirmed exposure was reversed.
 *   PARTIAL_ENTRY_RESIDUAL      some legs filled and the reversal was incomplete — exposure
 *                               is still held and is being worked by the flatten loop.
 *   FILLED_THEN_ECONOMICS_ABORT ALL FOUR legs filled, so a complete hedged Box genuinely
 *                               existed, but the economics computed on the EXECUTED prices no
 *                               longer qualified, so the whole Box was reversed immediately.
 *   QUARANTINED_UNKNOWN         broker state is unprovable; nothing may be unwound or opened
 *                               until reconciliation resolves it.
 *   OPENED                      a valid four-leg Box was opened.
 *
 * `FILLED_THEN_ECONOMICS_ABORT` must never be presented as an ordinary rejected candidate.
 * There was no legging RISK — the Box was briefly complete and hedged — but there was a real
 * cost, and its charges, slippage and P&L are tracked separately on the durable attempt row
 * (`gross_abort_pnl`, `net_abort_pnl`, `partial_entry_charges`, `unwind_charges`).
 */
export type BoxEntryOutcomeClass =
  | "OPENED"
  | "REFUSED_BEFORE_SUBMIT"
  | "NO_FILL"
  | "PARTIAL_ENTRY_UNWOUND"
  | "PARTIAL_ENTRY_RESIDUAL"
  | "FILLED_THEN_ECONOMICS_ABORT"
  /**
   * ALL FOUR legs filled, but the Box could not be RECORDED as an open position — the final
   * qualification callback threw, or the durable position insert failed.
   *
   * Distinct from `FILLED_THEN_ECONOMICS_ABORT`, where a verdict was reached and the box was
   * deliberately reversed, and from `QUARANTINED_UNKNOWN`, where the BROKER state is unprovable.
   * Here the broker state is fully proven — four terminal legs with confirmed cumulative fills —
   * and it is OUR OWN bookkeeping that failed. The exposure is real, its quantities are certain,
   * and it is retained as residual exposure for reconciliation rather than unwound on an unknown
   * verdict. New entry is blocked while it is outstanding.
   *
   * It must NEVER be presented as an ordinary rejected candidate: a candidate that never traded
   * and a live four-leg position nobody recorded demand opposite responses.
   */
  | "FILLED_EXPOSURE_UNRECORDED"
  | "QUARANTINED_UNKNOWN";

export interface PaperLeggingExecutionRecord {
  /** Honest execution source: live records must never be labelled simulated. */
  mode: "paper_legging" | "live";
  /** Preallocated durable trade identity used by every live intent and final trade. */
  trade_id?: string | null;
  leg_execution_mode: BoxLegExecutionMode;
  detected_at: number;
  order_sent_at: number;
  /** 0..4 */
  filled_leg_count: number;
  /** True only when all four legs filled and a box position was opened. */
  opened: boolean;
  /** Roles that failed to fill (empty on a clean 4/4). */
  failed_legs: BoxLegRole[];
  legs: PaperLegExecution[];
  /**
   * LEG DISPERSION: max(fill_at) − min(fill_at) across FILLED legs.
   *
   * Literally how far apart the fills landed — the measure of legging risk. This
   * is NOT "detection → last fill" (that is decision_to_last_fill_ms below); a
   * single-leg fill therefore gives 0, not the latency.
   */
  first_to_last_fill_ms: number | null;
  /** Detection → the FIRST leg's fill (ms). */
  decision_to_first_fill_ms: number | null;
  /** Detection → the LAST leg's fill (ms). */
  decision_to_last_fill_ms: number | null;
  /** Roles that arrived but were still (fully) unfilled at their timeout. */
  timed_out_legs: BoxLegRole[];
  /** Roles that filled only part of the requested lot before resolving. */
  partial_fill_legs: BoxLegRole[];
  /**
   * UNHEDGED EXPOSURE WINDOW: when the first leg filled, and when the position
   * stopped being one-sided — either the fourth leg completed the box, or the
   * emergency unwind finished.
   */
  exposure_started_at: number | null;
  exposure_ended_at: number | null;
  exposure_duration_ms: number | null;
  decision_to_complete_ms: number | null;
  /** Sum of per-leg entry slippage across FILLED legs (₹). */
  total_entry_slippage: number;
  /** ABORT accounting (all null / 0 on a clean open). */
  emergency_unwind: boolean;
  partial_entry_charges: number | null;
  unwind_charges: number | null;
  /** Gross loss from the round-trip of the partially-filled legs (₹, ≤ 0). */
  legging_gross_loss: number | null;
  /** legging_gross_loss − partial_entry_charges − unwind_charges (₹, ≤ 0). */
  legging_net_loss: number | null;
  /**
   * True when all four legs FILLED but the final qualification on the executed
   * prices failed, so the complete box had to be reversed straight away.
   *
   * Distinct from a partial-fill abort: there was no legging *risk* here (the box
   * was briefly complete and hedged), only an economics failure — the cost is the
   * round-trip spread and charges on all four legs.
   */
  abort_after_fill: boolean;
  /** Expected net profit recomputed on the EXECUTED prices (₹). */
  final_expected_net_profit: number | null;
  /** The gate that figure was tested against (₹). */
  required_expected_net_profit: number | null;
  /**
   * A SINGLE, UI-FACING label for how this attempt ended.
   *
   * Exists because `abort_after_fill` was previously only a boolean buried in the record, so a
   * 4/4-filled Box that failed final economics rendered as an ordinary failed candidate. It is
   * not one: real orders really filled, a real position really existed, and a real round trip
   * was really paid. See {@link BoxEntryOutcomeClass}.
   */
  outcome_class?: BoxEntryOutcomeClass;
  /* ---- four-leg temporal coherence (analytics; see math.ts) ---- */
  temporal: BoxTemporalCoherence | null;
  /* ---- residual exposure: outstanding simulated contracts, if any ---- */
  residual_exposure: ResidualLegExposure[];
  /* ---- partial-quantity accounting (exits / residual flattening) ---- */
  /**
   * How many role-orders were actually SUBMITTED this run. On an entry this is
   * always 4; on a partial exit or a residual flatten it is only the roles that
   * still had outstanding quantity, so internal correctness logic must NOT assume
   * "/4". `filled_leg_count` still means the submitted orders that FULLY filled.
   */
  submitted_leg_count: number;
  /** Submitted role-orders that completely filled their requested quantity. */
  fully_closed_role_count: number;
  /** Submitted role-orders left with outstanding quantity after this run. */
  remaining_role_count: number;
  /** Quantity actually closed/filled per role this run (absent roles = 0). */
  fills_by_role: Partial<Record<BoxLegRole, number>>;
  failure_reason: BoxExecutionFailureReason | null;
  failure_detail: string | null;
}

/**
 * Four-leg temporal coherence at a decision/execution instant.
 *
 * Quote age alone cannot tell whether the four legs form a coherent
 * cross-sectional snapshot. These figures do: how far apart the four books are in
 * receive time and (where available) in exchange time, and how many legs moved
 * during the decision latency.
 */
export interface BoxTemporalCoherence {
  /** Oldest / newest leg quote age at the instant measured (ms). */
  oldest_quote_age_ms: number | null;
  newest_quote_age_ms: number | null;
  /** newest − oldest RECEIVE timestamp across the four legs (ms). */
  receive_dispersion_ms: number | null;
  /** newest − oldest EXCHANGE timestamp across the four legs (ms), when all four have one. */
  exchange_dispersion_ms: number | null;
  /** How many of the four legs carried a valid exchange timestamp. */
  legs_with_exchange_ts: number;
  /** Per-leg (received_at − exchange_at) where both exist (ms) — feed-latency calibration. */
  receive_to_exchange_delay_ms: (number | null)[];
  /** How many legs' books changed (version advanced) during the decision latency. */
  books_changed_during_latency: number;
}

/** Durable lifecycle vocabulary shared by live broker orders and their intent journal. */
export type BoxOrderIntentState =
  | "CREATED"
  | "SUBMITTING"
  | "ACKNOWLEDGED"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "COMPLETE"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "REJECTED"
  | "UNKNOWN"
  | "RECONCILIATION_REQUIRED";

export type BoxOrderPurpose = "ENTRY" | "EXIT" | "EMERGENCY_RESIDUAL" | "PROTECTIVE_CANCEL";
export type BoxOrderPhase = "entry" | "exit" | "unwind";

/** One idempotent state transition in the separate order-intent audit journal. */
export interface BoxOrderIntentAudit {
  audit_id: string;
  at: Date;
  from_state: BoxOrderIntentState | null;
  to_state: BoxOrderIntentState;
  broker_order_id: string | null;
  message: string | null;
  fill_identity: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Durable intent written BEFORE any live transport call.
 *
 * This lives in `box_order_intents`, never in the trade document, so high-volume
 * broker evidence cannot leak into trade-list/history projections.
 */
export interface IBoxOrderIntent {
  client_order_id: string;
  broker_order_id: string | null;
  broker_mode: "paper" | "live";
  /**
   * WHICH BROKER this intent was (or will be) submitted to — immutable.
   *
   * Reconciliation routes on this field and nothing else. An unresolved Zerodha
   * intent must NEVER be looked up through Dhan, and vice versa: the two brokers'
   * order-id spaces are unrelated, so a cross-broker lookup would either 404 (and
   * be misread as "the order never existed") or, far worse, collide with an
   * unrelated real order. See ActiveBrokerManager's foreign-exposure guard.
   */
  broker?: BrokerId;
  /**
   * The bounded broker-side correlation identity, when the broker constrains it.
   *
   * Dhan's correlationId is limited to 30 characters, which a Box client order id
   * ("BOX:<24-char-oid>:ENTRY:k1_ce:attempt-1") comfortably exceeds. Both are
   * persisted so the original strategy identity is never lost and the broker-side
   * handle stays recoverable.
   */
  broker_correlation_id?: string | null;
  /**
   * WHICH BROKER ACCOUNT this intent was submitted under (Kite `user_id` / Dhan client id).
   *
   * Immutable once set, and set BEFORE the broker POST so a crash cannot leave an order whose owning
   * account is unknown. Migration `011_order_intent_broker_account.sql`.
   *
   * `null`/absent means UNPROVEN, not "the current account": a row written before account binding
   * genuinely does not record who placed it, and it is deliberately never backfilled — stamping it
   * with whoever is signed in now would fabricate the attribution this field exists to prove. Such a
   * row must be reconciled against broker evidence or explicitly resolved before being acted upon.
   *
   * Why it matters: without it, a re-login to a DIFFERENT account under the same API key left nothing
   * structural to prevent the new session from adopting, cancelling or flattening the previous
   * account's exposure. Tag uniqueness is not the same guarantee as account ownership.
   */
  broker_account?: string | null;
  trade_id: string | null;
  attempt_id: string;
  role: BoxLegRole;
  purpose: BoxOrderPurpose;
  phase: BoxOrderPhase;
  exchange: string;
  tradingsymbol: string;
  token: number;
  side: OrderSide;
  quantity: number;
  reference_price: number;
  tick_size: number;
  max_chase_ticks: number;
  limit_price: number;
  state: BoxOrderIntentState;
  filled_quantity: number;
  /**
   * The cumulative filled quantity this document held IMMEDIATELY BEFORE the most recent
   * guarded update, written by the same atomic update that advanced `filled_quantity`.
   *
   * WHY IT IS DURABLE RATHER THAN COMPUTED BY THE CALLER
   * Position attribution needs the delta a write actually established. Deriving it from the
   * caller's in-memory snapshot double-counts whenever two async contexts hold the same stale
   * snapshot (a live submit and a reconcile pass routinely do), because both then compute
   * `post - 0` for one broker fill. The persistence layer is the only place that can know the
   * real transition, so it records it: `delta = filled_quantity - previous_filled_quantity`.
   *
   * OPTIONAL FOR BACKWARDS COMPATIBILITY: absent on documents written before this field
   * existed. A caller that cannot read an authoritative transition must attribute NOTHING
   * rather than guess — under-attribution blocks reductions (safe), over-attribution
   * authorises reducing more than is held (not safe).
   */
  previous_filled_quantity?: number | null;
  average_price: number | null;
  broker_tag: string | null;
  reject_family: string | null;
  reject_reason: string | null;
  created_at: Date;
  updated_at: Date;
  terminal_at: Date | null;
  /** Append-only, idempotent by audit_id. Kept only in this dedicated collection. */
  audit: BoxOrderIntentAudit[];
}

export type BoxOrderIntentPatch = Partial<
  Pick<
    IBoxOrderIntent,
    | "broker_order_id"
    | "state"
    | "filled_quantity"
    | "average_price"
    | "broker_tag"
    | "reject_family"
    | "reject_reason"
    | "updated_at"
    | "terminal_at"
  >
>;

/** A persisted record of an execution ATTEMPT that did not open a box. */
export interface IBoxExecutionAttempt {
  candidate_key: string;
  direction: BoxDirection;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  execution_mode: ExecutionMode;
  /** The broker this attempt ran against. Absent ⇒ zerodha. */
  broker?: BrokerId;
  leg_execution_mode: BoxLegExecutionMode | null;
  detected_at: Date;
  resolved_at: Date;
  /** The gross edge that was detected. */
  detected_gross_edge: number | null;
  /** The expected net profit the entry was chasing. */
  expected_net_profit: number | null;
  /** The gate the attempt had to clear (₹) — so a miss can be sized, not guessed. */
  required_expected_net_profit?: number | null;
  /** Which statutory rate card priced this attempt. */
  charge_rate_version?: string | null;
  /**
   * True for the EXECUTION_ABORT_AFTER_FILL case: 4/4 filled, economics failed on
   * the executed prices, whole box reversed immediately.
   */
  abort_after_fill?: boolean;
  /**
   * How the attempt ended, hoisted from `legging.outcome_class` for direct querying and for the
   * admin attempts list. `FILLED_THEN_ECONOMICS_ABORT` is the one that must never be rendered as
   * an ordinary rejected candidate.
   */
  outcome_class?: BoxEntryOutcomeClass | null;
  filled_leg_count: number;
  failed_legs: BoxLegRole[];
  failure_reason: BoxExecutionFailureReason | null;
  failure_detail: string | null;
  legging: PaperLeggingExecutionRecord | null;
  /** ABORT accounting, hoisted for easy querying. */
  partial_entry_charges: number | null;
  unwind_charges: number | null;
  /**
   * Cumulative charges of RESIDUAL FLATTENING, accumulated across flatten passes.
   *
   * Kept separate from `unwind_charges`: the unwind is the immediate reversal at abort time,
   * flattening is the later (possibly multi-pass) work of clearing what the unwind could not.
   */
  flatten_charges?: number | null;
  /** IST day receiving the most recent flatten charge and the amount attributed to that day. */
  flatten_charge_day?: string | null;
  flatten_charges_for_day?: number | null;
  /** Monotonic residual/charge projection version. Missing legacy rows are version 0. */
  projection_version?: number | null;
  /** Stable content identity of `residual_exposure`; optional for migration-free legacy reads. */
  residual_projection_identity?: string | null;
  /** Bounded ring of recent residual-projection application ids. */
  applied_flatten_applications?: string[] | null;
  gross_abort_pnl: number | null;
  net_abort_pnl: number | null;
  /**
   * Outstanding simulated exposure this attempt could not flatten, hoisted for
   * querying. Empty when the attempt resolved flat. `resolved` is false while any
   * residual remains, so startup reconciliation can find and keep flattening it.
   */
  residual_exposure?: ResidualLegExposure[];
  resolved?: boolean;
}

/** One leg of a persisted box trade. */
export interface IBoxLeg {
  role: BoxLegRole;
  token: number;
  tradingsymbol: string;
  exchange: string;
  strike: number;
  instrument_type: "CE" | "PE";
  side: OrderSide;

  entry_price: number;
  entry_bid: number;
  entry_bid_qty: number;
  entry_ask: number;
  entry_ask_qty: number;
  entry_quote_at: Date | null;
  entry_depth: BoxDepthSnapshot | null;
  /** The touch that was DETECTED, before the simulated latency (nullable). */
  detected_price?: number | null;
  /** entry_price - detected_price, signed so positive is always worse. */
  entry_slippage?: number | null;

  exit_price: number | null;
  exit_bid: number | null;
  exit_bid_qty: number | null;
  exit_ask: number | null;
  exit_ask_qty: number | null;
  exit_quote_at: Date | null;
  exit_depth: BoxDepthSnapshot | null;
  exit_detected_price?: number | null;
  exit_slippage?: number | null;
}

/** The five-level book recorded at a decision instant. */
export interface BoxDepthSnapshot {
  bids: BoxDepthLevel[];
  asks: BoxDepthLevel[];
}

export type BoxTradeStatus = "open" | "closed" | "error";

/**
 * Whether a position is a complete box, partially exited, in reconciliation
 * recovery, or confirmed flat.
 *
 * RECOVERY is deliberately sticky while any canonical role remains non-zero;
 * FLAT is derived only when all four canonical quantities are exactly zero.
 */
export type BoxPositionState = "BOX" | "PARTIALLY_EXITED" | "RECOVERY" | "FLAT";

/**
 * One durable record of an exit ATTEMPT against a position.
 *
 * A box may be closed across several attempts (some legs fill, others fail and are
 * retried). Each attempt appends one of these so the full exit audit — what closed,
 * when, at what cost, and what remained — is never overwritten. Kept deliberately
 * light (no depth ladders) so it can ride on the trade document; the full per-leg
 * legging audit stays in the Mixed `exit_legging` blob, projected out of list
 * views.
 */
export interface IBoxExitAttempt {
  attempt_id: string;
  /** Durable source and lifecycle of this append-only attempt. */
  source: "auto" | "manual" | "recovery";
  status: "SUBMITTED" | "PARTIAL" | "COMPLETE" | "FAILED" | "INVARIANT_VIOLATION" | "UNCERTAIN";
  /** @deprecated Compatibility alias for source. */
  origin: "auto" | "manual";
  reason: BoxExitReason;
  detected_at: Date;
  requested_at: Date;
  submitted_at: Date | null;
  completed_at: Date | null;
  requested_qty_by_role: Record<BoxLegRole, number>;
  /** Quantity confirmed closed per role in THIS attempt. */
  filled_qty_by_role: Partial<Record<BoxLegRole, number>>;
  /** Compatibility alias retained for older consumers. */
  fills_by_role: Partial<Record<BoxLegRole, number>>;
  /** Weighted-average fill price per role in this attempt. */
  avg_price_by_role: Partial<Record<BoxLegRole, number>>;
  /** Full charge object and scalar for this attempt. */
  charges: BoxChargesWithOrigin | null;
  charges_total: number;
  /** Realised gross P&L booked by the quantity closed in this attempt (₹). */
  gross_pnl: number | null;
  /** Exact canonical per-role remaining quantity after this attempt. */
  remaining_after: Record<BoxLegRole, number>;
  submitted_role_count: number;
  fully_filled_role_count: number;
  remaining_role_count: number;
  /** Compatibility counters retained for old readers. */
  submitted_leg_count: number;
  filled_leg_count: number;
  broker_orders?: Array<{
    client_order_id: string;
    broker_order_id: string | null;
    state: BoxOrderIntentState;
    requested_quantity: number;
    filled_quantity: number;
    average_price: number | null;
  }>;
  invariant_violation?: string | null;
}

export type BoxExitReason =
  | "EDGE_CONVERGED"
  | "PROFIT_CAPTURE"
  | "MANUAL"
  | "EXPIRY_SAFETY";

/** Why an exit that the rules wanted did not happen. */
export type BoxExitBlockedReason =
  | "insufficient_exit_liquidity"
  | "net_below_floor"
  | "unpriced_charges"
  | "market_closed"
  | "feed_unhealthy"
  | null;

/** The scanner settings a trade was taken under (frozen onto the document). */
export interface BoxScannerConfigSnapshot {
  /** The gross PREFILTER (₹) this trade cleared before costs were considered. */
  min_gross_edge: number;
  /** Legacy net floor (0 = none). Superseded by min_expected_net_profit. */
  min_net_edge: number;
  /** THE ENTRY GATE: minimum expected NET profit (₹) after every cost. */
  min_expected_net_profit?: number;
  safety_buffer: number;
  /** Allowances used when a real measurement was not available yet (₹). */
  expected_entry_slippage?: number;
  expected_exit_slippage?: number;
  /*
   * PER-UNIT rates (₹ per unit of quantity), frozen so a fill stays interpretable.
   *
   * Without these a document records only the flat figures, and the question that actually decides
   * whether a trade should have been taken — "what was the hurdle for THIS lot size?" — becomes
   * unanswerable from the document alone once the rates are retuned. Optional: absent on every
   * document written before lot-relative thresholds existed.
   */
  min_expected_net_profit_per_unit?: number;
  min_gross_edge_per_unit?: number;
  safety_buffer_per_unit?: number;
  expected_entry_slippage_per_unit?: number;
  expected_exit_slippage_per_unit?: number;
  min_exit_net_pnl_per_unit?: number;
  quote_max_age_ms: number;
  strikes_each_side: number;
  convergence_floor: number;
  convergence_pct: number;
  min_exit_net_pnl: number;
  profit_capture_pct: number;
  /** Fraction of the ORIGINAL edge that alone justifies taking profit. */
  min_captured_pct?: number;
  execution_mode: ExecutionMode;
  simulated_decision_ms?: number;
  simulated_latency_ms?: number;
  /** Paper execution profile ("standard" | "live_parity"); absent on legacy documents. */
  paper_execution_profile?: "standard" | "live_parity" | "stress";
  /** Live safety envelope captured for audit; absent on legacy paper documents. */
  live_trading_enabled?: boolean;
  live_reconcile_interval_ms?: number;
  live_feed_reconnect_warmup_ms?: number;
  live_max_open_boxes?: number;
  live_max_concurrent_executions?: number;
  live_max_residual_legs?: number;
  live_daily_loss_limit?: number;
  live_reject_limit?: number;
  live_consecutive_failure_limit?: number;
  live_max_open_leg_quantity?: number;
  live_max_gross_open_leg_quantity?: number;
  live_http_timeout_ms?: number;
  live_ack_timeout_ms?: number;
  live_working_timeout_ms?: number;
  live_partial_timeout_ms?: number;
  live_cancel_timeout_ms?: number;
  /** Absolute end-to-end budget for one live order mutation (ms). See src/brokers/deadline.ts. */
  live_order_mutation_deadline_ms?: number;
  live_max_modifications?: number;
  live_max_chase_ticks?: number;
  live_broker_min_interval_ms?: number;
  /** Order-mutation pacing override (0 = derive from the broker's published limit). */
  live_broker_order_min_interval_ms?: number;
  /** How many ENTRY role submissions could be in transport at once (1..4). */
  live_entry_submit_concurrency?: number;
  /** The per-Box gross entry-order notional cap in force (₹). 0 = disabled. NOT margin. */
  live_max_box_capital_rupees?: number;
  /** Whether the underlying-level entry restriction was in force. */
  one_active_box_per_underlying?: boolean;
  /** The session cycle budget in force. 0 = unlimited. */
  session_max_completed_trades?: number;
  /**
   * Attempt ceiling for one armed session. 0 = unbounded.
   *
   * Bounds RISK-TAKING rather than success: `session_max_completed_trades` counts cycles consumed at
   * establishment, so an attempt that submitted orders and was then unwound or recovered spends no
   * cycle. This ceiling is counted at admission, before any broker POST, so such an attempt still
   * spends it.
   */
  session_max_entry_attempts?: number;
  /** Executable-order-pricing knobs a paper_legging fill was taken under. */
  leg_max_chase_ticks?: number;
  unwind_max_chase_ticks?: number;
  queue_model?: BoxQueueModel;
  queue_liquidity_haircut_pct?: number;
  max_cross_leg_exchange_dispersion_ms?: number;
  max_cross_leg_receive_dispersion_ms?: number;
  max_receive_to_exchange_delay_ms?: number;
  coherence_zero_dispersion_disables_in_live?: boolean;
}

/** A persisted Box strategy trade (paper or explicitly gated live). */
export interface IBoxTrade {
  execution_mode: ExecutionMode;

  /**
   * WHICH BROKER created this trade — permanent and immutable.
   *
   * Distinct from `execution_mode` on purpose: that says whether the fill was
   * simulated or real, this says whose market data and whose order book it came
   * from. Both matter and neither implies the other (a Dhan paper trade and a
   * Zerodha paper trade are priced by different feeds and costed by different
   * fee schedules).
   *
   * OPTIONAL so pre-existing documents load unchanged; `brokerOf()` resolves an
   * absent value to "zerodha".
   */
  broker?: BrokerId;

  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;

  /**
   * Which way the box was traded. OPTIONAL on purpose: documents written before
   * short boxes existed have no such field and must keep loading — they are all
   * long boxes, and `directionOf()` resolves them to LONG_BOX.
   */
  direction?: BoxDirection;

  lower_strike: number;
  upper_strike: number;

  lot_size: number;
  quantity: number;

  status: BoxTradeStatus;

  /**
   * EXACT per-role open quantity. At entry every role holds one lot; a partial
   * exit decrements only the roles it closed. This is the authoritative record of
   * what is still on our book, so a retry never re-closes a flat leg. OPTIONAL: a
   * document written before per-role state existed has none, and startup adoption
   * defaults every role to `quantity` (a full, un-exited box).
   */
  remaining_qty_by_role?: Partial<Record<BoxLegRole, number>> | null;
  /** Durable geometry; absent on old docs is still treated as a full "BOX". */
  position_state?: BoxPositionState | null;
  /** Every exit attempt against this trade, appended (never overwritten). */
  exit_attempts?: IBoxExitAttempt[] | null;
  /** Running total of exit-side charges across all attempts (₹). */
  cumulative_exit_charges?: number | null;

  legs: IBoxLeg[];

  box_width: number;

  /**
   * Net span (SPAN + exposure) margin the four legs block together, from
   * Zerodha's basket-margin API priced for all four one-lot orders at once.
   *
   * `null` when it could not be fetched — captured best-effort at entry, exactly
   * like the calendar trade's margin, and never gates a trade.
   */
  margin: number | null;
  /**
   * WHICH margin model produced `margin`. The four are not interchangeable:
   * `kite_basket` and `dhan_multi` are position-aware netted figures, whereas
   * `dhan_per_leg_fallback` is a summed per-leg UPPER bound that materially over-states a
   * hedged four-leg Box. Persisted so a stored number can never be mistaken for a netted
   * one after the fact.
   *
   * `null` means the trade predates provenance capture — deliberately distinct from
   * `"unavailable"`, which means a figure was requested and none was obtained.
   */
  margin_source?: "kite_basket" | "dhan_multi" | "dhan_per_leg_fallback" | "unavailable" | null;

  /** Signed net debit of the four entry fills (negative = credit received). */
  entry_box_cost: number;
  entry_gross_edge: number;

  entry_charges: BoxChargesWithOrigin | null;
  estimated_exit_charges: BoxChargesWithOrigin | null;
  safety_buffer: number;
  entry_net_edge: number;

  /** The decisive figure at entry: expected net profit after every cost. */
  expected_net_profit?: number | null;
  /** Execution/slippage cost carried into that decision (₹). */
  entry_execution_cost?: number | null;
  /** Where the entry charge numbers came from. */
  charge_origin?: BoxChargeOrigin;
  /** Which statutory rate card priced this trade (see BoxChargeRates.rateVersion). */
  charge_rate_version?: string | null;
  /** Zerodha's verdict on the local entry/exit charge calculation. */
  entry_charge_reconciliation?: BoxChargeReconciliation | null;
  exit_charge_reconciliation?: BoxChargeReconciliation | null;

  /** The full detection → execution audit record for the entry. */
  entry_execution?: BoxExecutionRecord | null;
  /** The per-leg legging record when the entry used paper_legging (4/4 fill). */
  entry_legging?: PaperLeggingExecutionRecord | null;
  /** The same for the exit. */
  exit_execution?: BoxExecutionRecord | null;
  /** The per-leg legging record when the EXIT used the independent-order model. */
  exit_legging?: PaperLeggingExecutionRecord | null;
  /**
   * Outstanding simulated exposure left by an incomplete exit (some exit legs
   * filled, others did not), so the trade is never shown as cleanly flat when it
   * is not. Optional/absent on the overwhelmingly common clean close.
   */
  residual_exposure?: ResidualLegExposure[] | null;

  opened_at: Date;

  /** Latest computed residual convergence, refreshed by the monitor. */
  current_remaining_edge: number | null;
  /** Latest captured edge and percentage, refreshed by the monitor. */
  current_captured_edge?: number | null;
  current_captured_pct?: number | null;

  exit_box_value: number | null;
  exit_charges: BoxChargesWithOrigin | null;

  gross_pnl: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  /**
   * The REALISED net P&L of a closed trade: actual simulated gross from the
   * recorded fills, minus actual entry and exit charges. No expected-slippage
   * allowance — that forward estimate disappears once the real exit price is
   * known. On an OPEN trade this is null. Mirrors `net_pnl` for closed trades,
   * named explicitly so "expected / current / realisable / realised" never blur.
   */
  realised_net_pnl?: number | null;

  closed_at: Date | null;
  exit_reason: BoxExitReason | null;
  /** Stable final execution identity for idempotent close acknowledgement. */
  close_idempotency_key?: string | null;

  /** Set when an automatic close was wanted but the touch could not fill it. */
  exit_blocked_reason: string | null;
  /** True once the expiry-safety window has been entered. */
  expiry_safety: boolean;

  scanner_config_snapshot: BoxScannerConfigSnapshot;

  error: string | null;
}

/** Append-only audit event kinds. */
export type BoxEventType =
  | "DETECTED"
  | "ENTRY"
  | "ENTRY_REJECTED_STALE"
  | "ENTRY_REJECTED_LIQUIDITY"
  | "ENTRY_REJECTED_FEES"
  | "ENTRY_REJECTED_DUPLICATE"
  /** The expected-net-profit gate refused it. */
  | "ENTRY_REJECTED_NET_PROFIT"
  /** The simulated execution after the latency delay could not fill. */
  | "ENTRY_REJECTED_EXECUTION"
  | "EXIT_TRIGGERED"
  | "EXIT"
  | "EXIT_SKIPPED_LIQUIDITY"
  | "EXPIRY_SAFETY"
  | "CHARGES_RECONCILED"
  /** paper_legging: some legs filled, the box aborted and was unwound. */
  | "EXECUTION_ABORTED"
  | "SCANNER_STARTED"
  | "SCANNER_STOPPED"
  /** An admin changed a live threshold (entry gate / safety buffer). */
  | "SCANNER_CONFIG"
  /**
   * A full administrator DELETED a trade record.
   *
   * The trade document itself is gone, so this event is the only surviving
   * evidence that it ever existed and that a human removed it. The ledger stays
   * append-only precisely so a deletion cannot erase its own audit trail.
   */
  | "TRADE_DELETED"
  /** The active broker was switched (or a switch was refused). */
  | "BROKER_SWITCHED"
  | "ERROR";

/** One immutable decision snapshot in the box ledger. */
export interface IBoxTradeEvent {
  event: BoxEventType;
  at: Date;
  /** Set once a trade document exists. */
  trade_id: string | null;
  /** underlying|expiry|K1|K2|DIRECTION — present even for rejections. */
  candidate_key: string;
  underlying: string;
  expiry: string;
  direction?: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  execution_mode: ExecutionMode;
  /** The broker this decision was taken against. Absent ⇒ zerodha. */
  broker?: BrokerId;

  box_width: number | null;
  box_cost: number | null;
  gross_edge: number | null;
  entry_charges_total: number | null;
  exit_charges_total: number | null;
  safety_buffer: number | null;
  net_edge: number | null;
  expected_net_profit?: number | null;
  execution_cost?: number | null;
  gross_pnl: number | null;
  net_pnl: number | null;
  remaining_edge: number | null;
  captured_edge?: number | null;
  captured_pct?: number | null;
  /** Simulated-execution audit for entry/exit events. */
  execution?: BoxExecutionRecord | null;

  /** The quote snapshot the decision was made on. */
  legs: BoxEventLeg[];
  reason: string | null;
  detail: string | null;
}

/** Per-leg quote snapshot stored on an event. */
export interface BoxEventLeg {
  role: BoxLegRole;
  side: OrderSide;
  token: number;
  tradingsymbol: string;
  price: number | null;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  quote_at: Date | null;
  age_ms: number | null;
}

/* -------------------------------------------------------------------------- */
/*  Exit / convergence                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The structured verdict of the exit rules — ONE decision object instead of a
 * handful of scattered booleans.
 *
 * `rule_reason` is what the arithmetic concludes; `should_exit` additionally
 * requires an executable four-leg market. Keeping them apart is what lets the
 * monitor record "should close but cannot" (EXIT_SKIPPED_LIQUIDITY) rather than
 * silently doing nothing.
 */
export interface BoxExitDecision {
  should_exit: boolean;
  reason: BoxExitReason | null;
  rule_reason: BoxExitReason | null;
  /** Mispricing still outstanding (₹). Falls towards 0 as the box converges. */
  remaining_edge: number | null;
  /** entryEdge - remainingEdge: how much of the original edge has been earned. */
  captured_edge: number | null;
  /** captured_edge / |entry edge|. */
  captured_pct: number | null;
  gross_pnl: number | null;
  net_pnl: number | null;
  /** All four reversed legs fresh and one-lot fillable right now. */
  executable: boolean;
  blocked_reason: BoxExitBlockedReason;
}

/** Live exit metrics for an open trade, recomputed from the executable book. */
export interface BoxExitMetrics {
  at: number;
  direction: BoxDirection;
  legs: BoxLegEvaluation[];
  /**
   * Net CREDIT per unit received by unwinding: sum of (+price for every closing
   * SELL, -price for every closing BUY). For a long box this is the familiar
   * Bid(K1CE) - Ask(K2CE) + Bid(K2PE) - Ask(K1PE).
   */
  exit_net_credit_per_unit: number | null;
  /** Same number under its original name. */
  exit_box_value_per_unit: number | null;
  exit_box_value: number | null;
  gross_pnl_if_closed_now: number | null;
  estimated_exit_charges: number | null;
  total_round_trip_charges: number | null;
  current_net_pnl: number | null;
  /** Execution/slippage allowance for the unwind carried in the decision (₹). */
  estimated_execution_cost: number;
  /** Net P&L after the execution allowance — what an exit realistically nets. */
  realisable_net_pnl: number | null;
  /** Mispricing still outstanding (₹). */
  remaining_edge: number | null;
  /** Original entry edge (₹), the reference every capture figure is against. */
  entry_edge: number;
  captured_edge: number | null;
  captured_pct: number | null;
  /** max(floor, pct * entry expected net edge). */
  convergence_threshold: number;
  min_exit_net_pnl: number;
  profit_capture_target: number;
  min_captured_pct: number;
  time_in_trade_ms: number | null;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  /** What the EXIT ARITHMETIC alone concludes, ignoring fillability. */
  rule_reason: BoxExitReason | null;
  /** rule_reason AND a fresh, one-lot-executable four-leg market. */
  exit_eligible: boolean;
  exit_reason: BoxExitReason | null;
  /** Why the rules are holding, or why an eligible exit is blocked. */
  blocked_reason: BoxExitBlockedReason;
  /** The full structured decision this metrics object was derived from. */
  decision: BoxExitDecision;
  /**
   * Present ONLY when this position has already closed some quantity.
   *
   * When set, the P&L fields above (`gross_pnl_if_closed_now`, `current_net_pnl`,
   * `realisable_net_pnl`, `estimated_exit_charges`, `total_round_trip_charges`) are the
   * PARTIAL-AWARE figures: realised gross frozen on closed quantity plus a mark on the
   * remaining quantity only, and exit charges = already paid + an estimate for what is left.
   * `pos.quantity`/`pos.lot_size` are never decremented by a partial exit, so without this the
   * mark re-valued already-flat legs at a full lot on every tick.
   *
   * The EDGE family (`entry_edge`, `remaining_edge`, `captured_edge`, `captured_pct`,
   * `convergence_threshold`, `profit_capture_target`) and `decision` deliberately remain
   * whole-box, full-lot reference figures: they describe a BOX, and a partially exited position
   * is not one. That is why `evaluatePosition` sends a `PARTIALLY_EXITED` position straight to
   * flattening and never consults `decision`. See `partialExitPnl.ts`.
   */
  partial_exit_mark?: PartialExitMark;
}

/**
 * The direction of a stored document.
 *
 * Old box documents predate short boxes and carry no `direction`. They are all
 * long boxes, so an absent field resolves to LONG_BOX rather than failing to
 * load — that is the whole backwards-compatibility contract.
 */
export function directionOf(doc: { direction?: BoxDirection | null }): BoxDirection {
  return doc.direction === "SHORT_BOX" ? "SHORT_BOX" : "LONG_BOX";
}

/** Human label for a direction, used in logs and the UI. */
export function directionLabel(direction: BoxDirection): string {
  return direction === "SHORT_BOX" ? "SHORT BOX" : "LONG BOX";
}


/**
 * The broker of a stored document, with the legacy default applied.
 *
 * Re-exported here (rather than only from ../brokers/types.js) so every box
 * module reads broker identity through the same import it already uses for
 * `directionOf` — the two backwards-compatibility rules are exactly analogous and
 * belong side by side.
 */
export { brokerOf, brokerLabel, BROKER_IDS, LEGACY_BROKER, isBrokerId } from "../brokers/types.js";
export type { BrokerId } from "../brokers/types.js";

/** True for every simulated execution mode — i.e. anything that is not live. */
export function isPaperExecutionMode(mode: ExecutionMode): boolean {
  return mode !== "live";
}

/**
 * The execution mode a record actually STATES, or null when it makes no claim.
 *
 * WHY THIS IS NOT `?? "paper_touch"`. Mode isolation refuses to act on a record whose fills are of a
 * different KIND from the running process. That refusal must rest on a mode the record genuinely
 * asserts — never on the ABSENCE of one. Defaulting a missing value to any paper mode would turn
 * "we cannot tell" into the positive claim "this is simulated", and a live process would then refuse
 * to exit it: a REDUCTION blocker manufactured out of missing data, which is the one direction this
 * codebase never fails in ("a blocked exit guarantees exposure stays").
 *
 * `null` therefore means NO CLAIM, and every caller treats it as "no mismatch" — i.e. exactly the
 * behaviour that existed before mode isolation. Real records are unaffected: `box_trades.execution_mode`
 * and `box_execution_attempts.execution_mode` are both `NOT NULL`, so a restored position or attempt
 * always states its mode and is always checked.
 *
 * Deliberately validates against {@link EXECUTION_MODES} rather than trusting the declared type: this
 * reads values that crossed a database or process boundary, where the compiler guarantees nothing.
 */
export function statedExecutionMode(value: unknown): ExecutionMode | null {
  return typeof value === "string" && (EXECUTION_MODES as readonly string[]).includes(value)
    ? (value as ExecutionMode)
    : null;
}
