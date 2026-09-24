/**
 * The Box arbitrage mathematical core.
 *
 * Every function here is PURE: no clock, no network, no database. The engine
 * feeds it quotes and configuration and it returns decisions. That is what makes
 * the trading rules deterministically testable.
 *
 * Three rules are absolute throughout this file:
 *
 *   1. Prices come from the EXECUTABLE TOUCH ONLY. A BUY fills at the best ask
 *      and a SELL fills at the best bid. LTP, mid-price and theoretical values
 *      are never used to size, qualify or close a trade.
 *   2. A leg is only executable if the ENTIRE lot is available AT that exact
 *      best price. Deeper levels are never walked.
 *   3. DIRECTION IS NEVER ASSUMED. Every signed quantity is derived from
 *      `directionSign()` and the per-direction side map, so a long box and a
 *      short box cannot disagree about which way profit runs.
 *
 * THE TWO DIRECTIONS, IN ONE FORMULA
 *
 *   netDebitPerUnit = Σ over the four legs of (+price if BUY, -price if SELL)
 *   grossEdgePerUnit = directionSign x width - netDebitPerUnit
 *
 *   LONG_BOX  (sign +1): BUY K1CE / SELL K2CE / BUY K2PE / SELL K1PE
 *       netDebit = Ask(K1CE) - Bid(K2CE) + Ask(K2PE) - Bid(K1PE)   (a cost)
 *       edge     = width - cost
 *
 *   SHORT_BOX (sign -1): SELL K1CE / BUY K2CE / SELL K2PE / BUY K1PE
 *       netDebit = Ask(K2CE) + Ask(K1PE) - Bid(K1CE) - Bid(K2PE) = -credit
 *       edge     = -width + credit = credit - width
 *
 * Both reduce to "what the box settles at, minus what it cost to hold" — which is
 * why no sign is written out by hand anywhere below.
 */

import type { BoxConfig } from "./config.js";
import {
  minExitNetPnlForLot,
  prefilterGrossThresholdForLot,
  requiredNetProfitForLot,
  safetyBufferForLot,
  type BoxThresholdConfig,
} from "./config.js";
import { singleLotLegViolation } from "./singleLotInvariant.js";
import {
  BOX_ENTRY_SIDES_BY_DIRECTION,
  BOX_LEG_ROLES,
  directionSign,
  type BoxCandidate,
  type BoxDirection,
  type BoxEntryDecision,
  type BoxEvaluation,
  type BoxExitBlockedReason,
  type BoxExitDecision,
  type BoxExitMetrics,
  type BoxExitReason,
  type BoxLegEvaluation,
  type BoxLegRole,
  type BoxOptionInstrument,
  type BoxQuote,
  type BoxRejectReason,
  type OrderSide,
} from "./types.js";

/** Round money to paise so float noise never reaches the ledger. */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Cost of a price move, per unit: POSITIVE always means "worse for us".
 *
 * Paying more on a BUY and receiving less on a SELL are both adverse, so the sign
 * is normalised here rather than at each call site — a leg's slippage is then
 * directly comparable and summable regardless of side.
 */
export function slippagePerUnit(
  side: OrderSide,
  detected: number | null,
  executed: number | null,
): number | null {
  if (detected === null || executed === null) return null;
  return round2(side === "BUY" ? executed - detected : detected - executed);
}

/** The side a leg trades on ENTRY for a given direction. */
export function entrySideFor(role: BoxLegRole, direction: BoxDirection = "LONG_BOX"): OrderSide {
  return BOX_ENTRY_SIDES_BY_DIRECTION[direction][role];
}

/** The side that CLOSES a leg — the exact reverse of how it was opened. */
export function exitSideFor(role: BoxLegRole, direction: BoxDirection = "LONG_BOX"): OrderSide {
  return entrySideFor(role, direction) === "BUY" ? "SELL" : "BUY";
}

/** +1 when a side pays money out, -1 when it takes money in. */
function debitSign(side: OrderSide): 1 | -1 {
  return side === "BUY" ? 1 : -1;
}

/* -------------------------------------------------------------------------- */
/*  Four-leg temporal coherence                                               */
/* -------------------------------------------------------------------------- */

/**
 * Cross-sectional temporal coherence of the four legs at one instant.
 *
 * Quote age alone cannot say whether the four books form a coherent snapshot.
 * This does: receive-time and (where available) exchange-time dispersion across
 * the legs, per-leg feed latency, and how many books moved during the decision
 * latency.
 *
 * PURE: it never rejects anything; it only measures. The exchange-time dispersion
 * is null unless ALL legs carry an exchange timestamp, so a caller can safely fall
 * back to receive-time logic when the feed did not supply one — the module never
 * rejects a candidate for missing data it cannot control.
 */
export function temporalCoherence(
  legs: {
    received_at: number | null;
    exchange_at: number | null;
    current_version: number | null;
    detection_version: number | null;
  }[],
  now: number,
): import("./types.js").BoxTemporalCoherence {
  const received = legs.map((l) => l.received_at).filter((v): v is number => v !== null);
  const exchange = legs.map((l) => l.exchange_at).filter((v): v is number => v !== null);
  const ages = received.map((r) => now - r);

  const receiveDispersion =
    received.length >= 2 ? round2(Math.max(...received) - Math.min(...received)) : null;
  // Only meaningful — and only used to reject — when EVERY leg has an exchange ts.
  const exchangeDispersion =
    exchange.length === legs.length && legs.length >= 2
      ? round2(Math.max(...exchange) - Math.min(...exchange))
      : null;

  let booksChanged = 0;
  for (const l of legs) {
    if (
      l.current_version !== null &&
      l.detection_version !== null &&
      l.current_version !== l.detection_version
    ) {
      booksChanged++;
    }
  }

  return {
    oldest_quote_age_ms: ages.length > 0 ? round2(Math.max(...ages)) : null,
    newest_quote_age_ms: ages.length > 0 ? round2(Math.min(...ages)) : null,
    receive_dispersion_ms: receiveDispersion,
    exchange_dispersion_ms: exchangeDispersion,
    legs_with_exchange_ts: exchange.length,
    receive_to_exchange_delay_ms: legs.map((l) =>
      l.received_at !== null && l.exchange_at !== null ? round2(l.received_at - l.exchange_at) : null,
    ),
    books_changed_during_latency: booksChanged,
  };
}

/* -------------------------------------------------------------------------- */
/*  Touch prices                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The best price on one side of the book: highest bid, lowest ask.
 *
 * Computed rather than trusting array order, so a reordered or padded depth
 * payload can never hand back a worse level as if it were the touch. Returns
 * null when that side is empty, so callers refuse the trade instead of inventing
 * a fill from a last-traded price.
 */
export function bestPrice(
  levels: { price: number; qty: number }[],
  side: "bid" | "ask",
): number | null {
  let best: number | null = null;
  for (const lv of levels) {
    if (!(lv.price > 0)) continue;
    if (best === null) best = lv.price;
    else best = side === "bid" ? Math.max(best, lv.price) : Math.min(best, lv.price);
  }
  return best;
}

/**
 * Total quantity resting at EXACTLY the given price on one side.
 *
 * Summed across levels because an exchange can report the same price twice in a
 * padded depth payload. Quantity at deeper (worse) prices is deliberately
 * ignored: this module does not walk the book.
 */
export function qtyAtPrice(
  levels: { price: number; qty: number }[],
  price: number,
): number {
  let qty = 0;
  for (const lv of levels) {
    if (lv.price === price && lv.qty > 0) qty += lv.qty;
  }
  return qty;
}

/**
 * The executable touch for one side of a trade, with the size available there.
 *
 * `bid`/`ask` scalars on a tick are used only as a fallback when the five-level
 * depth is absent; the quantity then has to come from the depth, so a book with
 * no depth can never satisfy the one-lot test (which is the safe outcome).
 */
export function touchFor(
  quote: BoxQuote,
  side: OrderSide,
): { price: number | null; qty: number } {
  if (side === "BUY") {
    const price = bestPrice(quote.asks, "ask") ?? (quote.ask > 0 ? quote.ask : null);
    if (price === null) return { price: null, qty: 0 };
    const qty = qtyAtPrice(quote.asks, price) || (quote.ask === price ? quote.ask_qty : 0);
    return { price, qty };
  }
  const price = bestPrice(quote.bids, "bid") ?? (quote.bid > 0 ? quote.bid : null);
  if (price === null) return { price: null, qty: 0 };
  const qty = qtyAtPrice(quote.bids, price) || (quote.bid === price ? quote.bid_qty : 0);
  return { price, qty };
}

/** A clone of a book's five levels — the audit record of one exact packet. */
export function cloneDepth(quote: BoxQuote): { bids: typeof quote.bids; asks: typeof quote.asks } {
  return {
    bids: quote.bids.map((l) => ({ ...l })),
    asks: quote.asks.map((l) => ({ ...l })),
  };
}

/* -------------------------------------------------------------------------- */
/*  Strike window: ATM ± 3                                                    */
/* -------------------------------------------------------------------------- */

/** The strike closest to spot. Ties resolve to the lower strike. */
export function atmStrikeFor(strikes: number[], spot: number): number | null {
  if (strikes.length === 0) return null;
  const sorted = [...strikes].sort((a, b) => a - b);
  let best = sorted[0]!;
  let bestDist = Math.abs(best - spot);
  for (const s of sorted) {
    const d = Math.abs(s - spot);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/** Median gap between adjacent strikes — the chain's strike step. */
export function strikeStepOf(strikes: number[]): number {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  if (sorted.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * The monitored window: the ATM strike plus up to three strikes each side, taken
 * from the strikes that ACTUALLY EXIST in the chain.
 *
 * At most seven strikes come back — never more. Near the end of a chain fewer are
 * returned rather than reaching further in the other direction, because a
 * lopsided window would silently change which strikes are monitored.
 */
export function selectStrikeWindow(
  strikes: number[],
  spot: number,
  eachSide = 3,
): { atm: number; window: number[] } | null {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const atm = atmStrikeFor(sorted, spot);
  if (atm === null) return null;
  const idx = sorted.indexOf(atm);
  const lo = Math.max(0, idx - eachSide);
  const hi = Math.min(sorted.length - 1, idx + eachSide);
  return { atm, window: sorted.slice(lo, hi + 1) };
}

/**
 * Whether the ATM window should be re-centred.
 *
 * The spot must move PAST the midpoint between the current ATM and its neighbour
 * by an extra fraction of a strike step (the hysteresis band) before the window
 * moves. Without that band a price sitting exactly on a strike boundary would
 * resubscribe the whole window on alternating ticks.
 */
export function shouldRecentreWindow(
  currentAtm: number,
  spot: number,
  strikeStep: number,
  hysteresis: number,
): boolean {
  if (!(strikeStep > 0)) return false;
  const drift = Math.abs(spot - currentAtm);
  return drift > strikeStep * (0.5 + hysteresis);
}

/* -------------------------------------------------------------------------- */
/*  Candidate construction                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Stable identity of a box: the strike pair AND the direction.
 *
 * The direction is part of the key because a long box and a short box on the same
 * strikes are opposite trades — letting one key stand for both would silently
 * prevent the two from ever being open at the same time, and would make an
 * adopted position ambiguous after a restart.
 */
export function candidateKey(
  underlying: string,
  expiry: string,
  k1: number,
  k2: number,
  direction: BoxDirection = "LONG_BOX",
): string {
  return `${underlying}|${expiry}|${k1}|${k2}|${direction}`;
}

/**
 * Every distinct strike pair K1 < K2 in the window, for each requested direction.
 *
 * Seven strikes give C(7,2) = 21 pairs; evaluating both directions gives 42
 * candidates for one underlying. A pair is skipped when either strike is missing
 * a CE or a PE, since all four legs are required to form a box.
 *
 * `directions` defaults to LONG_BOX only, so a caller that has not opted into
 * short boxes keeps exactly its previous candidate set.
 */
export function buildCandidates(args: {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lot_size: number;
  strikes: number[];
  ce: Map<number, BoxOptionInstrument>;
  pe: Map<number, BoxOptionInstrument>;
  directions?: readonly BoxDirection[];
}): BoxCandidate[] {
  // Box V1 is exactly one exchange lot. Invalid metadata must remove the
  // candidate before it can reach qualification or any execution boundary.
  if (!Number.isSafeInteger(args.lot_size) || args.lot_size <= 0) return [];
  const sorted = [...new Set(args.strikes)].sort((a, b) => a - b);
  const directions = args.directions ?? (["LONG_BOX"] as const);
  const out: BoxCandidate[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const k1 = sorted[i]!;
      const k2 = sorted[j]!;
      const k1ce = args.ce.get(k1);
      const k2ce = args.ce.get(k2);
      const k2pe = args.pe.get(k2);
      const k1pe = args.pe.get(k1);
      if (!k1ce || !k2ce || !k2pe || !k1pe) continue;
      const legs = { k1_ce: k1ce, k2_ce: k2ce, k2_pe: k2pe, k1_pe: k1pe };
      if (singleLotLegViolation(args.lot_size, legs)) continue;
      for (const direction of directions) {
        out.push({
          key: candidateKey(args.underlying, args.expiry, k1, k2, direction),
          underlying: args.underlying,
          name: args.name,
          is_index: args.is_index,
          expiry: args.expiry,
          direction,
          lower_strike: k1,
          upper_strike: k2,
          box_width: round2(k2 - k1),
          lot_size: args.lot_size,
          legs,
        });
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Entry evaluation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate one leg from one book.
 *
 * `captureDepth` is FALSE on the hot path. Cloning four five-level ladders for
 * every one of up to 42 candidates on every tick was pure allocation churn, and
 * none of the qualification arithmetic looks past the touch. The ladder is
 * captured only where it is genuinely needed: an entry fill, an exit fill, an
 * audit event or an explicit chain request.
 */
function evaluateLeg(args: {
  role: BoxLegRole;
  side: OrderSide;
  inst: BoxOptionInstrument;
  quote: BoxQuote | undefined;
  lotSize: number;
  now: number;
  maxAgeMs: number;
  captureDepth: boolean;
}): BoxLegEvaluation {
  const { role, side, inst, quote, lotSize, now, maxAgeMs, captureDepth } = args;
  if (!quote) {
    return {
      role,
      side,
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      price: null,
      qty_at_touch: 0,
      bid: 0,
      bid_qty: 0,
      ask: 0,
      ask_qty: 0,
      quote_at: null,
      exchange_at: null,
      quote_version: null,
      depth: null,
      age_ms: null,
      fresh: false,
      executable: false,
    };
  }
  const age = now - quote.at;
  const fresh = age >= 0 ? age <= maxAgeMs : false;
  const touch = touchFor(quote, side);
  return {
    role,
    side,
    token: inst.token,
    tradingsymbol: inst.tradingsymbol,
    strike: inst.strike,
    instrument_type: inst.instrument_type,
    price: touch.price,
    qty_at_touch: touch.qty,
    bid: quote.bid,
    bid_qty: quote.bid_qty,
    ask: quote.ask,
    ask_qty: quote.ask_qty,
    quote_at: quote.at,
    exchange_at: quote.exchange_at,
    quote_version: quote.version,
    depth: captureDepth ? cloneDepth(quote) : null,
    age_ms: age,
    fresh,
    // One ENTIRE lot must rest at the exact touch price.
    executable: touch.price !== null && touch.price > 0 && touch.qty >= lotSize,
  };
}

/** The first blocking reason across the four legs, in priority order. */
function firstRejectReason(
  legs: BoxLegEvaluation[],
  lotSize: number,
): BoxRejectReason | null {
  for (const l of legs) if (l.quote_at === null) return "no_quote";
  for (const l of legs) if (!l.fresh) return "stale_quote";
  for (const l of legs) {
    if (l.price === null || !(l.price > 0)) {
      return l.side === "BUY" ? "missing_ask" : "missing_bid";
    }
  }
  for (const l of legs) if (l.qty_at_touch < lotSize) return "insufficient_qty";
  return null;
}

/**
 * Evaluate one candidate from the executable book.
 *
 *   netDebitPerUnit  = Σ (+ask for BUY legs, -bid for SELL legs)
 *   grossEdgePerUnit = directionSign x width - netDebitPerUnit
 *   grossEdge        = grossEdgePerUnit x lotSize
 *
 * The cost and the edge are reported whenever all four prices exist, even if a
 * leg is stale or too thin, so the UI can show a near-miss. `tradable` is what
 * gates a paper entry.
 *
 * HOT PATH: no Map is built, no depth is cloned, and the four legs are visited
 * exactly once.
 */
export function evaluateCandidate(args: {
  candidate: BoxCandidate;
  quotes: Map<number, BoxQuote>;
  now: number;
  maxAgeMs: number;
  /** Capture the five-level ladders. Only for fills, audits and chain views. */
  captureDepth?: boolean;
}): BoxEvaluation {
  const { candidate, quotes, now, maxAgeMs } = args;
  const captureDepth = args.captureDepth === true;
  const lotSize = candidate.lot_size;
  const direction = candidate.direction ?? "LONG_BOX";
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];

  const legs: BoxLegEvaluation[] = new Array(BOX_LEG_ROLES.length);
  let havePrices = true;
  let netDebit = 0;
  let worstAge: number | null = null;
  let agesSeen = 0;
  let version: number | null = null;
  let depthOk = true;

  for (let i = 0; i < BOX_LEG_ROLES.length; i++) {
    const role = BOX_LEG_ROLES[i]!;
    const inst = candidate.legs[role];
    const leg = evaluateLeg({
      role,
      side: sides[role],
      inst,
      quote: quotes.get(inst.token),
      lotSize,
      now,
      maxAgeMs,
      captureDepth,
    });
    legs[i] = leg;

    if (leg.price === null) havePrices = false;
    else netDebit += debitSign(leg.side) * leg.price;

    if (leg.age_ms !== null) {
      agesSeen++;
      if (worstAge === null || leg.age_ms > worstAge) worstAge = leg.age_ms;
    }
    if (leg.quote_version !== null && leg.quote_version !== undefined) {
      if (version === null || leg.quote_version > version) version = leg.quote_version;
    }
    if (!(leg.price !== null && leg.price > 0 && leg.qty_at_touch >= lotSize)) depthOk = false;
  }

  const netDebitPerUnit = havePrices ? round2(netDebit) : null;
  const grossPerUnit =
    netDebitPerUnit === null
      ? null
      : round2(directionSign(direction) * candidate.box_width - netDebitPerUnit);
  const grossEdge = grossPerUnit === null ? null : round2(grossPerUnit * lotSize);

  const reject = firstRejectReason(legs, lotSize);

  return {
    candidate,
    at: now,
    legs,
    entry_net_debit_per_unit: netDebitPerUnit,
    entry_box_cost_per_unit: netDebitPerUnit,
    gross_edge_per_unit: grossPerUnit,
    gross_edge: grossEdge,
    tradable: reject === null && grossEdge !== null,
    depth_ok: depthOk,
    worst_age_ms: agesSeen === BOX_LEG_ROLES.length ? worstAge : null,
    quote_version: version,
    reject,
  };
}

/**
 * The after-cost picture:
 *
 *   projectedNetEdge = grossEdge - entryFees - estExitFees - executionCost - buffer
 *
 * `executionCost` defaults to 0 so older callers keep their arithmetic.
 */
export function projectedNetEdge(args: {
  grossEdge: number;
  entryCharges: number;
  estimatedExitCharges: number;
  safetyBuffer: number;
  executionCost?: number;
}): number {
  return round2(
    args.grossEdge -
      args.entryCharges -
      args.estimatedExitCharges -
      (args.executionCost ?? 0) -
      args.safetyBuffer,
  );
}

/**
 * THE ENTRY DECISION — expected NET profit, with every term visible.
 *
 *   expectedNet = grossEdge
 *               - entryCharges
 *               - estimatedExitCharges
 *               - (entrySlippageAllowance + futureExitSlippageAllowance)
 *               - safetyBufferForLot(cfg, lotSize)
 *   qualifies   = expectedNet >= requiredNetProfitForLot(cfg, lotSize)
 *
 * LOT-RELATIVE BY CONSTRUCTION. `grossEdge` is `grossEdgePerUnit × lotSize`, so both the gate and
 * the buffer are resolved through `cfg`'s flat/per-unit pairs against the candidate's own lot. A
 * caller that supplies only flat figures (every per-unit rate 0) gets exactly the previous
 * arithmetic; a caller that sets rates gets one consistent per-unit hurdle across the universe.
 *
 * TWO DISTINCT CONTEXTS, ONE FUNCTION — and the difference is the whole point of
 * TASK 1 (fixing entry-slippage double counting):
 *
 *   PRE-EXECUTION PROJECTION (deciding whether to start the pipeline)
 *     grossEdge                    = the DETECTION gross edge
 *     entrySlippageAllowance       = cfg.expectedEntrySlippage   (a guess, deducted)
 *     futureExitSlippageAllowance  = cfg.expectedExitSlippage    (a guess, deducted)
 *     measuredEntrySlippage        = null
 *
 *   FINAL EXECUTION QUALIFICATION (deciding whether the fill is worth keeping)
 *     grossEdge                    = the EXECUTED gross edge — adverse entry
 *                                    movement is ALREADY inside this number
 *     entrySlippageAllowance       = 0   ← never deduct entry slippage again
 *     futureExitSlippageAllowance  = cfg.expectedExitSlippage    (still a future cost)
 *     measuredEntrySlippage        = the measured entry slippage — RECORDED as an
 *                                    analytics figure, NOT deducted
 *
 * The legacy single `executionCost` argument is still accepted (treated as the
 * whole deducted allowance) so existing callers/tests keep working.
 */
export function evaluateEntryDecision(args: {
  grossEdge: number | null;
  entryCharges: number | null;
  estimatedExitCharges: number | null;
  /** @deprecated Prefer the explicit allowances below. The whole deducted cost. */
  executionCost?: number;
  /** Expected entry-slippage allowance to deduct (pre-execution only; 0 at final). */
  entrySlippageAllowance?: number;
  /** Expected future exit-slippage allowance to deduct (always a forward cost). */
  futureExitSlippageAllowance?: number;
  /** Measured entry slippage for the record — NEVER deducted (analytics only). */
  measuredEntrySlippage?: number | null;
  /**
   * The candidate's EXCHANGE LOT SIZE, which resolves every lot-relative threshold.
   *
   * REQUIRED, not optional, and deliberately so: `grossEdge` already scales with the lot, so a
   * gate that does not know the lot is a different gate on every instrument (see the per-unit
   * block in config.ts). Making it required turns a missed call site into a COMPILE ERROR instead
   * of a silently mis-scaled threshold on the live entry path.
   */
  lotSize: number;
  cfg: BoxThresholdConfig;
}): BoxEntryDecision {
  const { grossEdge, entryCharges, estimatedExitCharges, cfg, lotSize } = args;

  // Resolve the two named allowances. When the explicit fields are supplied they
  // win; otherwise fall back to the legacy lumped `executionCost` (attributed to
  // the entry allowance, with no future-exit split — legacy callers never cared).
  const usingExplicit =
    args.entrySlippageAllowance !== undefined || args.futureExitSlippageAllowance !== undefined;
  const entryAllowance = usingExplicit
    ? round2(args.entrySlippageAllowance ?? 0)
    : round2(args.executionCost ?? 0);
  const futureExitAllowance = usingExplicit ? round2(args.futureExitSlippageAllowance ?? 0) : 0;
  const executionCost = round2(entryAllowance + futureExitAllowance);
  const measuredEntrySlippage =
    args.measuredEntrySlippage === undefined || args.measuredEntrySlippage === null
      ? null
      : round2(args.measuredEntrySlippage);

  // Every threshold is resolved against THIS candidate's lot, so one configured policy means the
  // same per-unit hurdle on a 35-lot index and on a 40,000-lot single stock.
  const minNet = requiredNetProfitForLot(cfg, lotSize);
  const safetyBuffer = safetyBufferForLot(cfg, lotSize);
  const passesPrefilter =
    grossEdge !== null && grossEdge >= prefilterGrossThresholdForLot(cfg, lotSize);

  const base: Omit<BoxEntryDecision, "qualifies" | "reject" | "expected_net_profit"> = {
    gross_edge: grossEdge,
    entry_charges: entryCharges,
    estimated_exit_charges: estimatedExitCharges,
    execution_cost: executionCost,
    entry_slippage_allowance: entryAllowance,
    future_exit_slippage_allowance: futureExitAllowance,
    measured_entry_slippage: measuredEntrySlippage,
    safety_buffer: safetyBuffer,
    min_expected_net_profit: minNet,
    passes_gross_prefilter: passesPrefilter,
  };

  if (grossEdge === null) {
    return { ...base, expected_net_profit: null, qualifies: false, reject: "no_quote" };
  }
  if (entryCharges === null || estimatedExitCharges === null) {
    // Without charges the after-cost picture does not exist, so there is nothing
    // to compare against the gate.
    return {
      ...base,
      expected_net_profit: null,
      qualifies: false,
      reject: "unpriced_charges",
    };
  }

  const expectedNet = projectedNetEdge({
    grossEdge,
    entryCharges,
    estimatedExitCharges,
    executionCost,
    safetyBuffer,
  });

  if (!passesPrefilter) {
    return {
      ...base,
      expected_net_profit: expectedNet,
      qualifies: false,
      reject: "below_gross_prefilter",
    };
  }
  if (expectedNet < minNet) {
    return {
      ...base,
      expected_net_profit: expectedNet,
      qualifies: false,
      reject: "below_expected_net_profit",
    };
  }
  return { ...base, expected_net_profit: expectedNet, qualifies: true, reject: null };
}

/**
 * LEGACY gross/net gate, kept for the prefilter and for existing callers.
 *
 * The decisive check is `evaluateEntryDecision`; this one only answers "is the
 * gross spread big enough to be worth costing out", plus the optional legacy net
 * floor.
 */
export function qualifiesForEntry(
  grossEdge: number | null,
  netEdge: number | null,
  cfg: Pick<BoxConfig, "minGrossEdge" | "minNetEdge">,
): boolean {
  if (grossEdge === null) return false;
  if (grossEdge < cfg.minGrossEdge) return false;
  if (cfg.minNetEdge > 0) {
    if (netEdge === null) return false;
    if (netEdge < cfg.minNetEdge) return false;
  }
  return true;
}

/** Whether a candidate's gross edge justifies the full qualification pipeline. */
export function passesGrossPrefilter(grossEdge: number | null, threshold: number): boolean {
  return grossEdge !== null && grossEdge >= threshold;
}

/* -------------------------------------------------------------------------- */
/*  Indicative evaluation (market closed)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate a box from LAST TRADED / CLOSING prices instead of the touch.
 *
 * Used only while the market is shut, so an opportunity that existed at the close
 * can still be inspected. Deliberately a SEPARATE function from
 * evaluateCandidate: there is no bid/ask and therefore no executable price, so
 * the result is always `tradable: false` and can never reach the entry path.
 */
export function evaluateCandidateIndicative(args: {
  candidate: BoxCandidate;
  /** token → last traded / closing price. */
  lastPrices: Map<number, number>;
  now: number;
}): BoxEvaluation {
  const { candidate, lastPrices, now } = args;
  const lotSize = candidate.lot_size;
  const direction = candidate.direction ?? "LONG_BOX";
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];

  const legs: BoxLegEvaluation[] = BOX_LEG_ROLES.map((role) => {
    const inst = candidate.legs[role];
    const last = lastPrices.get(inst.token) ?? 0;
    return {
      role,
      side: sides[role],
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      // The closing price, NOT an executable touch — hence executable: false.
      price: last > 0 ? last : null,
      qty_at_touch: 0,
      bid: 0,
      bid_qty: 0,
      ask: 0,
      ask_qty: 0,
      quote_at: null,
      exchange_at: null,
      quote_version: null,
      depth: null,
      age_ms: null,
      fresh: false,
      executable: false,
    };
  });

  const havePrices = legs.every((l) => l.price !== null);
  let rawDebit = 0;
  if (havePrices) for (const l of legs) rawDebit += debitSign(l.side) * l.price!;
  const netDebit = havePrices ? round2(rawDebit) : null;

  // PLAUSIBILITY BOUND — the reason this function cannot simply do the arithmetic
  // and publish it.
  //
  // A box's fair value is the width, undiscounted. `signedCost` is the implied
  // VALUE of the box (what establishing the long side would cost): the entry sides
  // mirror by direction, so `netDebit` flips sign with the direction and
  // `directionSign × netDebit` recovers the same positive value either way.
  //
  // The band bounds how far that implied value may sit from the width before the
  // four prices stop being a coherent snapshot. It has to be TWO-SIDED, because
  // both sides of the width are real:
  //
  //   value < width  →  the LONG box is the arbitrage (pay less than it settles at)
  //   value > width  →  the SHORT box is the arbitrage (take in more than it costs)
  //
  // This previously read `signedCost < box_width`, which is not a coherence test at
  // all — it is a "the long box is profitable" test. Since the value is identical
  // for both directions, it admitted every long-box edge and rejected EVERY
  // profitable short box as implausible, so the market-closed view could only ever
  // show short boxes as losers.
  //
  // What is genuinely implausible is an edge of the same order as the width itself:
  // a strike that has not traded for days carries a price struck when the
  // underlying was somewhere else entirely, and four legs each stale from a
  // different session produce a fictional edge many times the width. Bounding the
  // edge MAGNITUDE by the width keeps both real arbitrage directions and still
  // rejects that garbage — with no invented tolerance constant, since the width is
  // already the natural scale of the trade.
  // Restated as a bound on this direction's SIGNED edge — `0 < edge < width` —
  // which is what makes it direction-correct. The edge is
  // `directionSign × width − netDebit`, so the single condition expands to each
  // direction's own profitable region:
  //
  //   LONG:   0 < width − value < width   ⟺   0 < value < width
  //   SHORT:  0 < value − width < width   ⟺   width < value < 2 × width
  //
  // The long-box case is byte-for-byte the old band, so nothing about long boxes
  // changes — including the excluded boundaries (value = 0 is the free-money case,
  // value = width has no edge) and the guarantee that a reported edge is positive
  // and smaller than the box's maximum payoff. What it adds is the mirror region,
  // where taking in more than the box can cost to settle makes the SHORT box the
  // arbitrage. No tolerance constant is introduced: the width is the trade's own
  // natural scale, and an "edge" as large as the width is stale-data garbage rather
  // than a dislocation.
  const signedCost = netDebit === null ? null : directionSign(direction) * netDebit;
  const impliedEdge =
    netDebit === null ? null : directionSign(direction) * candidate.box_width - netDebit;
  const plausible =
    signedCost !== null &&
    impliedEdge !== null &&
    signedCost > 0 &&
    impliedEdge > 0 &&
    impliedEdge < candidate.box_width;

  const netDebitPerUnit = plausible ? netDebit : null;
  const grossPerUnit =
    netDebitPerUnit === null
      ? null
      : round2(directionSign(direction) * candidate.box_width - netDebitPerUnit);
  const grossEdge = grossPerUnit === null ? null : round2(grossPerUnit * lotSize);

  let reject: BoxRejectReason;
  if (!havePrices) reject = "no_quote";
  else if (!plausible) reject = "implausible_close";
  else reject = "market_closed";

  return {
    candidate,
    at: now,
    legs,
    // Deliberately null rather than the raw figure when implausible: a number
    // that cannot be true must not be displayed as though it were.
    entry_net_debit_per_unit: netDebitPerUnit,
    entry_box_cost_per_unit: netDebitPerUnit,
    gross_edge_per_unit: grossPerUnit,
    gross_edge: grossEdge,
    // Never tradable: there is no executable book behind these numbers.
    tradable: false,
    // Closing prices carry no bid/ask, so executable size is simply unknown.
    depth_ok: false,
    worst_age_ms: null,
    quote_version: null,
    reject,
  };
}

/* -------------------------------------------------------------------------- */
/*  Exit evaluation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Price the unwind of an open box from the executable book.
 *
 * Each leg is evaluated on the side that CLOSES it, so the two longs are sold
 * into the bid and the two shorts are bought back at the ask (and the mirror for
 * a short box). No LTP, no midpoint, no theoretical price.
 */
export function evaluateExitLegs(args: {
  legs: { role: BoxLegRole; inst: BoxOptionInstrument }[];
  quotes: Map<number, BoxQuote>;
  lotSize: number;
  now: number;
  maxAgeMs: number;
  direction?: BoxDirection;
  captureDepth?: boolean;
}): BoxLegEvaluation[] {
  const direction = args.direction ?? "LONG_BOX";
  return args.legs.map(({ role, inst }) =>
    evaluateLeg({
      role,
      side: exitSideFor(role, direction),
      inst,
      quote: args.quotes.get(inst.token),
      lotSize: args.lotSize,
      now: args.now,
      maxAgeMs: args.maxAgeMs,
      captureDepth: args.captureDepth === true,
    }),
  );
}

/** The convergence threshold: max(floor, pct × original entry net edge). */
export function convergenceThreshold(
  entryNetEdge: number,
  cfg: Pick<BoxConfig, "convergenceFloor" | "convergencePct">,
): number {
  return round2(Math.max(cfg.convergenceFloor, cfg.convergencePct * entryNetEdge));
}

/**
 * The net CREDIT per unit received by unwinding the four legs right now:
 *
 *   Σ (+price for every closing SELL, -price for every closing BUY)
 *
 * For a long box that is the familiar
 * Bid(K1CE) - Ask(K2CE) + Bid(K2PE) - Ask(K1PE); for a short box it is negative,
 * because closing a short box costs money. Same formula either way.
 */
export function exitNetCreditPerUnit(legs: BoxLegEvaluation[]): number | null {
  let credit = 0;
  for (const l of legs) {
    if (l.price === null || !(l.price > 0)) return null;
    // A closing SELL takes money in, a closing BUY pays money out.
    credit += -debitSign(l.side) * l.price;
  }
  return round2(credit);
}

/**
 * Whether all four reversed legs can actually be filled for one whole lot right
 * now. A paper exit is refused rather than faked when this is false.
 */
export function exitLiquidityOk(legs: BoxLegEvaluation[]): boolean {
  return legs.length === 4 && legs.every((l) => l.fresh && l.executable);
}

/**
 * THE EXIT DECISION — one pure function, one structured answer.
 *
 * The strategy is not a hold-to-expiry trade: it enters a temporary four-leg
 * mispricing and leaves as soon as the discrepancy has closed enough to bank a
 * worthwhile profit. So the decision is expressed in terms of CONVERGENCE, not of
 * time or of price levels:
 *
 *   remainingEdge = (directionSign x width - exitCreditPerUnit) x lot
 *   capturedEdge  = entryEdge - remainingEdge          (= gross P&L)
 *   capturedPct   = capturedEdge / |entryEdge|
 *
 * A trade closes when it is EXECUTABLE and genuinely worth closing:
 *
 *   EXPIRY_SAFETY  the emergency rule — expiry is imminent, so leave regardless
 *                  of profit (but never at an invented price)
 *   EDGE_CONVERGED remainingEdge <= max(floor, pct x entryNetEdge)
 *                  AND netPnl >= minExitNetPnl
 *   PROFIT_CAPTURE netPnl >= minExitNetPnl
 *                  AND (netPnl >= profitCapturePct x entryNetEdge
 *                       OR capturedPct >= minCapturedPct)
 *
 * `netPnl` is computed from the EXECUTABLE touch and the current exit charges, so
 * "the threshold was crossed" can never on its own close a trade that would not
 * actually pay: that is the `net_below_floor` block below, and it is the whole
 * point of returning a structured decision instead of a boolean.
 */
export function evaluateExitDecision(args: {
  direction: BoxDirection;
  boxWidth: number;
  lotSize: number;
  /** Signed net debit per unit the position was opened at. */
  entryNetDebitPerUnit: number;
  /** The original mispricing (₹) every capture figure is measured against. */
  entryEdge: number;
  /** The expected net edge recorded at entry, used for the thresholds. */
  entryNetEdge: number;
  entryChargesTotal: number | null;
  currentExitChargesTotal: number | null;
  legs: BoxLegEvaluation[];
  expirySafety?: boolean;
  /**
   * The expected FUTURE exit-slippage allowance (₹). PRE-execution the floor is
   * measured against `netPnl - executionAllowance` (the realistically realisable
   * figure); once the ACTUAL exit price is known the caller passes 0.
   */
  executionAllowance?: number;
  /** When true, the profit floor/capture use realisable net rather than touch net. */
  useRealisableForFloor?: boolean;
  cfg: Pick<
    BoxConfig,
    | "convergenceFloor"
    | "convergencePct"
    | "minExitNetPnl"
    // Resolved against `lotSize`, so the exit floor is the same per-unit hurdle as the entry gate.
    // Without this the two disagree: a large-lot box would be admitted against a real requirement
    // and then released against a trivial one.
    | "minExitNetPnlPerUnit"
    | "profitCapturePct"
    | "minCapturedPct"
  >;
}): BoxExitDecision {
  const { direction, boxWidth, lotSize, entryNetDebitPerUnit, entryEdge, legs, cfg } = args;

  const exitCredit = exitNetCreditPerUnit(legs);
  const grossPnl =
    exitCredit === null ? null : round2((exitCredit - entryNetDebitPerUnit) * lotSize);
  const roundTrip =
    args.entryChargesTotal === null || args.currentExitChargesTotal === null
      ? null
      : round2(args.entryChargesTotal + args.currentExitChargesTotal);
  const netPnl = grossPnl === null || roundTrip === null ? null : round2(grossPnl - roundTrip);

  // The figure the PROFIT rules judge against. Pre-execution (useRealisableForFloor)
  // it is net minus the expected exit-slippage allowance — a conservative estimate
  // of what an exit would realistically net. Post-execution the caller sets the
  // allowance to 0, so this equals the actual net at the executed price.
  const allowance = args.useRealisableForFloor === true ? round2(args.executionAllowance ?? 0) : 0;
  const floorNet = netPnl === null ? null : round2(netPnl - allowance);

  const remainingEdge =
    exitCredit === null
      ? null
      : round2((directionSign(direction) * boxWidth - exitCredit) * lotSize);
  const capturedEdge = remainingEdge === null ? null : round2(entryEdge - remainingEdge);
  const capturedPct =
    capturedEdge === null || !(Math.abs(entryEdge) > 0)
      ? null
      : round2(capturedEdge / Math.abs(entryEdge));

  const threshold = convergenceThreshold(args.entryNetEdge, cfg);
  const captureTarget = round2(cfg.profitCapturePct * args.entryNetEdge);
  const executable = exitLiquidityOk(legs);
  const expirySafety = args.expirySafety === true;

  // What the ARITHMETIC concludes, before asking whether it can be done. The
  // profit tests use `floorNet` (realisable pre-execution, actual post-execution);
  // the "in profit at all" guard stays on the touch net.
  let ruleReason: BoxExitReason | null = null;
  let blocked: BoxExitBlockedReason = null;

  if (netPnl === null || floorNet === null) {
    blocked = "unpriced_charges";
  } else if (netPnl > 0 && remainingEdge !== null) {
    const clearsFloor = floorNet >= minExitNetPnlForLot(cfg, args.lotSize);
    const converged = remainingEdge <= threshold;
    const capturedEnough =
      floorNet >= captureTarget || (capturedPct !== null && capturedPct >= cfg.minCapturedPct);

    if (converged && clearsFloor) ruleReason = "EDGE_CONVERGED";
    else if (clearsFloor && capturedEnough) ruleReason = "PROFIT_CAPTURE";
    else if (converged || capturedEnough) {
      // The convergence/capture condition IS satisfied, but the executable prices
      // would not pay enough to be worth the round trip. Recorded, never acted on.
      blocked = "net_below_floor";
    }
  } else if (remainingEdge !== null && remainingEdge <= threshold) {
    // Converged into a loss: hold and say so rather than crystallising it.
    blocked = "net_below_floor";
  }

  // A normal reason is preferred when one exists, so an emergency close is never
  // recorded for a trade that simply converged. Expiry safety is the fallback that
  // overrides profitability — an abandoned box at expiry is a far worse outcome —
  // but it still refuses to invent a price.
  const reason: BoxExitReason | null = executable
    ? (ruleReason ?? (expirySafety ? "EXPIRY_SAFETY" : null))
    : null;

  if ((ruleReason !== null || expirySafety) && !executable) {
    blocked = "insufficient_exit_liquidity";
  }

  return {
    should_exit: reason !== null && executable,
    reason: reason !== null && executable ? reason : null,
    rule_reason: ruleReason,
    remaining_edge: remainingEdge,
    captured_edge: capturedEdge,
    captured_pct: capturedPct,
    gross_pnl: grossPnl,
    net_pnl: netPnl,
    executable,
    blocked_reason: blocked,
  };
}

/**
 * Full exit arithmetic for one open box: the decision above, plus every figure
 * the UI and the ledger display.
 *
 * Accepts the original long-box argument names so existing callers and tests keep
 * working: `entryBoxCostPerUnit` is the signed net debit, and when
 * `entryEdge`/`direction` are not supplied they default to a long box derived
 * from the width.
 */
export function computeExitMetrics(args: {
  boxWidth: number;
  lotSize: number;
  /** Signed net debit per unit (the long box's cost). */
  entryBoxCostPerUnit: number;
  entryNetEdge: number;
  entryChargesTotal: number | null;
  /** Charges to unwind, priced now; falls back to the stored estimate. */
  currentExitChargesTotal: number | null;
  legs: BoxLegEvaluation[];
  now: number;
  direction?: BoxDirection;
  /** The original mispricing (₹). Derived for a long box when omitted. */
  entryEdge?: number;
  /** Execution/slippage allowance reported for the unwind (₹). */
  executionCost?: number;
  /** Use realisable net (touch net − executionCost) for the profit floor/capture. */
  useRealisableForFloor?: boolean;
  openedAt?: number;
  expirySafety?: boolean;
  cfg: Pick<
    BoxConfig,
    | "convergenceFloor"
    | "convergencePct"
    | "minExitNetPnl"
    // Resolved against `lotSize`, so the exit floor is the same per-unit hurdle as the entry gate.
    // Without this the two disagree: a large-lot box would be admitted against a real requirement
    // and then released against a trivial one.
    | "minExitNetPnlPerUnit"
    | "profitCapturePct"
    | "minCapturedPct"
  >;
}): BoxExitMetrics {
  const direction = args.direction ?? "LONG_BOX";
  const { boxWidth, lotSize, entryBoxCostPerUnit, entryNetEdge, legs, now, cfg } = args;
  const entryEdge =
    args.entryEdge ??
    round2((directionSign(direction) * boxWidth - entryBoxCostPerUnit) * lotSize);
  const executionCost = round2(args.executionCost ?? 0);

  const decision = evaluateExitDecision({
    direction,
    boxWidth,
    lotSize,
    entryNetDebitPerUnit: entryBoxCostPerUnit,
    entryEdge,
    entryNetEdge,
    entryChargesTotal: args.entryChargesTotal,
    currentExitChargesTotal: args.currentExitChargesTotal,
    legs,
    expirySafety: args.expirySafety === true,
    executionAllowance: executionCost,
    useRealisableForFloor: args.useRealisableForFloor === true,
    cfg,
  });

  const exitCredit = decision.gross_pnl === null ? null : exitNetCreditPerUnit(legs);
  const exitBoxValue = exitCredit === null ? null : round2(exitCredit * lotSize);
  const roundTrip =
    args.entryChargesTotal === null || args.currentExitChargesTotal === null
      ? null
      : round2(args.entryChargesTotal + args.currentExitChargesTotal);

  const realisable =
    decision.net_pnl === null ? null : round2(decision.net_pnl - executionCost);

  let worstAge: number | null = null;
  let agesSeen = 0;
  for (const l of legs) {
    if (l.age_ms === null) continue;
    agesSeen++;
    if (worstAge === null || l.age_ms > worstAge) worstAge = l.age_ms;
  }

  // `exit_eligible` keeps its original meaning: the rules say close AND the market
  // can fill it. Expiry safety is reported through `decision.reason`, which is what
  // the monitor acts on, so an emergency close is never mistaken for a normal one.
  const eligible = decision.rule_reason !== null && decision.executable;

  return {
    at: now,
    direction,
    legs,
    exit_net_credit_per_unit: exitCredit,
    exit_box_value_per_unit: exitCredit,
    exit_box_value: exitBoxValue,
    gross_pnl_if_closed_now: decision.gross_pnl,
    estimated_exit_charges: args.currentExitChargesTotal,
    total_round_trip_charges: roundTrip,
    current_net_pnl: decision.net_pnl,
    estimated_execution_cost: executionCost,
    realisable_net_pnl: realisable,
    remaining_edge: decision.remaining_edge,
    entry_edge: entryEdge,
    captured_edge: decision.captured_edge,
    captured_pct: decision.captured_pct,
    convergence_threshold: convergenceThreshold(entryNetEdge, cfg),
    // The EFFECTIVE floor for this lot, not the flat configured figure, so the reported number is
    // the one the decision above actually compared against.
    min_exit_net_pnl: minExitNetPnlForLot(cfg, lotSize),
    profit_capture_target: round2(cfg.profitCapturePct * entryNetEdge),
    min_captured_pct: cfg.minCapturedPct,
    time_in_trade_ms: args.openedAt === undefined ? null : Math.max(0, now - args.openedAt),
    liquidity_ok: decision.executable,
    worst_age_ms: agesSeen === legs.length && agesSeen > 0 ? worstAge : null,
    rule_reason: decision.rule_reason,
    exit_eligible: eligible,
    exit_reason: eligible ? decision.rule_reason : null,
    blocked_reason: decision.blocked_reason,
    decision,
  };
}
