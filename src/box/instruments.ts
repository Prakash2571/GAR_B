/**
 * Box universe construction: which underlyings are scanned, which expiry each
 * one uses, and which seven strikes are monitored.
 *
 * Everything comes from the SHARED instrument cache (the same dump the calendar
 * board is derived from), so lot sizes and strikes are always current instrument
 * metadata and never hard-coded.
 */

import type { Instrument } from "../kite.js";
import { tradingDaysUntil } from "../marketCalendar.js";
import { selectStrikeWindow, shouldRecentreWindow, strikeStepOf } from "./math.js";
import type { BoxOptionInstrument, BoxUnderlyingState } from "./types.js";

/** The board rows the box module needs (a subset of index.ts's BoardItem). */
export interface BoxBoardItem {
  symbol: string;
  name: string;
  spot_token: number;
  is_index?: boolean;
}

/** The option chain of one underlying, grouped for fast window selection. */
export interface BoxChainIndex {
  underlying: string;
  expiry: string;
  lot_size: number;
  strike_step: number;
  /** Every strike that has BOTH a CE and a PE for this expiry, ascending. */
  strikes: number[];
  ce: Map<number, BoxOptionInstrument>;
  pe: Map<number, BoxOptionInstrument>;
  /**
   * Trading days from today to this chain's expiry, or null when it could not be computed.
   *
   * Carried on the chain so downstream gates (and the operator surface) can see the distance that
   * was actually used, rather than each layer re-deriving it from a different calendar.
   */
  trading_days_to_expiry: number | null;
  /**
   * Expiries that were SKIPPED because they were too close to settlement, nearest first.
   *
   * Recorded rather than silently dropped: "NIFTY is trading the 2026-10-06 series, not the
   * 2026-09-29 one, because 29 Sep is 1 trading day out and the minimum is 2" is a materially
   * different situation from "NIFTY has no chain", and an operator who cannot tell them apart will
   * go looking for a feed problem that does not exist.
   */
  skipped_near_expiries: string[];
}

/**
 * Why an expiry is not eligible to have NEW boxes opened in it.
 *
 * SETTLEMENT IS THE RISK THIS GUARDS, and it is a cost the engine cannot otherwise see. Holding a box
 * to expiry is not a neutral alternative to closing it:
 *
 *   EXERCISE STT. A box ALWAYS has in-the-money legs at expiry — for K1 < S < K2 the two long legs'
 *   intrinsic values sum to exactly the box width. STT on exercise is 0.15% of INTRINSIC value
 *   (raised from 0.125% effective 1 April 2026) and is payable by the BUYER of the option. It is
 *   unbounded in |S − K1|: a NIFTY box whose lower strike ends 4,100 points ITM pays roughly ₹384 of
 *   exercise STT on one 75-lot, which is well over the entire gross edge such a box would ever show.
 *
 *   PHYSICAL SETTLEMENT. Stock options in India are physically settled; index options are cash
 *   settled. A stock box carried into expiry week becomes a delivery obligation — and NSE ramps
 *   physical-delivery margin on ITM long options from around four days before expiry, reaching a
 *   large fraction of the full delivery value. On a RELIANCE box with a ₹10,000 maximum payoff, the
 *   delivery leg is several lakh rupees of notional and the margin ramp dwarfs the trade.
 *
 *   SPREAD MARGIN BENEFIT IS WITHDRAWN near expiry, so the margin actually held against an open box
 *   rises while nothing in the engine observes it.
 *
 * The cheapest defence against all three is to never be in that series: refuse to OPEN a box that
 * cannot comfortably be closed before settlement.
 */
export type ExpiryIneligibility = "too_close_to_expiry" | "unparseable_expiry";

function toBoxInstrument(i: Instrument): BoxOptionInstrument {
  const inst: BoxOptionInstrument = {
    token: i.instrument_token,
    tradingsymbol: i.tradingsymbol,
    exchange: i.exchange,
    strike: i.strike,
    instrument_type: i.instrument_type === "CE" ? "CE" : "PE",
    expiry: i.expiry,
    lot_size: i.lot_size,
  };
  // Carry the real exchange tick size through, so marketable-limit pricing in
  // paper_legging uses the instrument's own tick rather than a hard-coded ₹0.05.
  // Only set when the dump reports a usable value (exactOptionalPropertyTypes:
  // the field must be genuinely absent, not `undefined`, when unknown).
  if (i.tick_size > 0) inst.tick_size = i.tick_size;
  return inst;
}

/**
 * Index the NFO option chains by underlying, keeping only the NEAREST
 * non-expired expiry for each.
 *
 * "Non-expired" is evaluated against the IST trading day, so an expiry dated
 * today is still live (it trades until the close).
 */
/**
 * Index the NFO option chains by underlying, keeping the nearest expiry that is far enough from
 * settlement to be worth opening a box in.
 *
 * WHAT CHANGED, AND WHY. This used to take `expiries[0]` — the nearest non-expired series, INCLUDING
 * today's. Combined with the absence of any days-to-expiry rule anywhere in the system, that meant a
 * box could be opened at 14:00 on expiry day, in the expiring series, with nothing between it and
 * settlement but the 45-minute expiry-safety window. And that window deliberately refuses to fill
 * against an untradeable book (it never invents a price), so an illiquid wing at 15:15 sent the box
 * to settlement with no accounting path at all — the charge model has no exercise-STT head, so the
 * realised cost was simply never computed. See {@link ExpiryIneligibility} for what settlement
 * actually costs.
 *
 * The rule is expressed in TRADING days, not calendar days, because the question is "how many
 * sessions do I have to get out of four legs", and a Friday-to-Monday expiry is three calendar days
 * but one session. `minTradingDays` of 1 means "not the expiring series"; 2 means "at least one full
 * session of slack after today".
 *
 * A skipped series is RECORDED on the chain, not silently dropped.
 *
 * Note this only governs which chain NEW candidates are built from. Positions already open in a
 * nearer series keep their own instruments and stay subscribed, so rolling the discovery chain
 * forward never orphans live exposure.
 */
export function indexOptionChains(
  all: Instrument[],
  today: string,
  opts: {
    /**
     * Minimum trading days from today to expiry for a series to accept NEW boxes.
     * 0 preserves the historical behaviour (nearest live expiry, including today's).
     */
    minTradingDays?: number;
    /** Trading days from `today` to a given expiry, or null when uncomputable. Injected for tests. */
    tradingDaysUntil?: (from: string, to: string) => number | null;
  } = {},
): Map<string, BoxChainIndex> {
  const minTradingDays = Math.max(0, Math.floor(opts.minTradingDays ?? 0));
  const daysUntil = opts.tradingDaysUntil ?? ((from, to) => tradingDaysUntil(from, to));
  // underlying -> expiry -> strike -> { ce, pe }
  const byUnderlying = new Map<string, Map<string, Instrument[]>>();

  for (const i of all) {
    if (i.exchange !== "NFO") continue;
    if (i.instrument_type !== "CE" && i.instrument_type !== "PE") continue;
    if (!i.name || !i.expiry || !(i.strike > 0)) continue;
    if (i.expiry < today) continue; // expired
    let byExpiry = byUnderlying.get(i.name);
    if (!byExpiry) {
      byExpiry = new Map();
      byUnderlying.set(i.name, byExpiry);
    }
    const arr = byExpiry.get(i.expiry);
    if (arr) arr.push(i);
    else byExpiry.set(i.expiry, [i]);
  }

  const out = new Map<string, BoxChainIndex>();
  for (const [underlying, byExpiry] of byUnderlying) {
    // ISO dates sort chronologically, so the first is the nearest live expiry.
    const expiries = [...byExpiry.keys()].sort();

    /*
     * Walk OUTWARD to the first series far enough from settlement, recording what was passed over.
     *
     * A series whose distance cannot be computed (an expiry the calendar cannot parse, or one beyond
     * the scan bound) is SKIPPED rather than admitted: an unknown distance to settlement is not
     * evidence of a safe distance, and this is the one decision where guessing has an unbounded
     * downside.
     */
    const skipped: string[] = [];
    let expiry: string | undefined;
    let daysToExpiry: number | null = null;
    for (const candidate of expiries) {
      if (minTradingDays <= 0) {
        expiry = candidate;
        daysToExpiry = daysUntil(today, candidate);
        break;
      }
      const days = daysUntil(today, candidate);
      if (days !== null && days >= minTradingDays) {
        expiry = candidate;
        daysToExpiry = days;
        break;
      }
      skipped.push(candidate);
    }
    if (!expiry) continue;
    const contracts = byExpiry.get(expiry)!;

    const ce = new Map<number, BoxOptionInstrument>();
    const pe = new Map<number, BoxOptionInstrument>();
    let lotSize = 0;
    for (const c of contracts) {
      const inst = toBoxInstrument(c);
      if (inst.instrument_type === "CE") ce.set(inst.strike, inst);
      else pe.set(inst.strike, inst);
      if (!lotSize && c.lot_size > 0) lotSize = c.lot_size;
    }
    // A box needs all four legs, so only strikes with BOTH a call and a put can
    // ever take part.
    const strikes = [...ce.keys()].filter((s) => pe.has(s)).sort((a, b) => a - b);
    if (strikes.length === 0 || lotSize <= 0) continue;

    out.set(underlying, {
      underlying,
      expiry,
      lot_size: lotSize,
      strike_step: strikeStepOf(strikes),
      strikes,
      ce,
      pe,
      trading_days_to_expiry: daysToExpiry,
      skipped_near_expiries: skipped,
    });
  }
  return out;
}

/**
 * Build (or re-centre) the seven-strike window for one underlying.
 *
 * Returns null when the chain cannot support a window at this spot. The returned
 * state carries at most seven strikes — ATM and up to three either side.
 */
export function buildUnderlyingState(args: {
  board: BoxBoardItem;
  chain: BoxChainIndex;
  spot: number;
  spotAt: number;
  eachSide: number;
  now: number;
}): BoxUnderlyingState | null {
  const { board, chain, spot, spotAt, eachSide, now } = args;
  const picked = selectStrikeWindow(chain.strikes, spot, eachSide);
  if (!picked) return null;

  const ce = new Map<number, BoxOptionInstrument>();
  const pe = new Map<number, BoxOptionInstrument>();
  for (const s of picked.window) {
    const c = chain.ce.get(s);
    const p = chain.pe.get(s);
    if (c) ce.set(s, c);
    if (p) pe.set(s, p);
  }

  return {
    underlying: board.symbol,
    name: board.name,
    is_index: board.is_index === true,
    spot_token: board.spot_token,
    expiry: chain.expiry,
    lot_size: chain.lot_size,
    strike_step: chain.strike_step,
    atm_strike: picked.atm,
    strikes: picked.window,
    ce,
    pe,
    spot,
    spot_at: spotAt,
    window_at: now,
  };
}

/**
 * Whether an existing window should be rebuilt for a new spot.
 *
 * Two damps are applied so a drifting price cannot cause continuous
 * resubscription: the spot must clear the ATM hysteresis band, AND the window
 * must not have been rebuilt too recently.
 */
export function windowNeedsRebuild(args: {
  state: BoxUnderlyingState;
  spot: number;
  now: number;
  hysteresis: number;
  minIntervalMs: number;
}): boolean {
  const { state, spot, now, hysteresis, minIntervalMs } = args;
  if (!(spot > 0)) return false;
  if (now - state.window_at < minIntervalMs) return false;
  return shouldRecentreWindow(state.atm_strike, spot, state.strike_step, hysteresis);
}

/** Every option token in a window (14 for a full seven-strike window). */
export function windowTokens(state: BoxUnderlyingState): number[] {
  const out: number[] = [];
  for (const inst of state.ce.values()) out.push(inst.token);
  for (const inst of state.pe.values()) out.push(inst.token);
  return out;
}

/**
 * Order the universe so that, when the token budget binds, the most useful
 * underlyings are the ones that get subscribed: indices first (they are the most
 * liquid option books on the exchange), then stocks alphabetically for a stable,
 * predictable selection.
 */
export function prioritiseUniverse(board: BoxBoardItem[]): BoxBoardItem[] {
  const indices = board.filter((b) => b.is_index === true);
  const stocks = board.filter((b) => b.is_index !== true);
  indices.sort((a, b) => a.symbol.localeCompare(b.symbol));
  stocks.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return [...indices, ...stocks];
}

/** True when `expiry` (YYYY-MM-DD) is the current IST trading day. */
export function isExpiryToday(expiry: string, today: string): boolean {
  return expiry === today;
}
