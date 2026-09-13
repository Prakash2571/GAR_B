/**
 * The dependencies CalSpread's `src/index.ts` used to hand the Box module.
 *
 * `registerBoxModule` takes eight collaborators it does not own — the IST day key,
 * the market-hours predicate, the token→identifier resolver, the F&O board, the
 * instrument dump, the Zerodha charge estimator and the basket-margin call. In
 * CalSpread those lived inside a 5,584-line `index.ts` alongcalendar spreads,
 * futures analytics, option-OI capture and Yahoo dividends. Extracting them into
 * this file is what makes GTS Box's own `index.ts` small enough to read.
 *
 * EVERY FUNCTION HERE IS A VERBATIM PORT. The board derivation, the IST arithmetic,
 * the market-hours window, the per-leg charge folding and the aggregation rounding
 * are byte-for-byte the CalSpread behaviour, because the Box entry gate is priced
 * off them and `tests/box/migration-fixtures` pins the results. Nothing in this
 * file may be "improved" without a fixture change to prove the new numbers.
 *
 * WHAT WAS DELIBERATELY LEFT BEHIND
 *   * `deriveFnoStocks` — only the calendar stock list used it.
 *   * `historyCache` / `/api/history` — historical charts are out of scope.
 *   * `istDateTime` — only the Kite historical endpoint needed it.
 *   * the calendar `ITradeLogLeg` ledger rows — the Box module ignores `logLegs`
 *     beyond passing it through, so the port keeps the field but types it as the
 *     Box charge module already does (`unknown[]`).
 */

import type { BoxChargeLeg, PricedChargeGroup } from "./box/charges.js";
import type { BoxBoardItem } from "./box/instruments.js";
import type { Instrument, KiteClient, OrderCharges } from "./kite.js";
import { resolveIndexSpotSymbol } from "./indexSpot.js";
import type { ILegCharges, ITradeCharges } from "./types/charges.js";

/* -------------------------------------------------------------------------- */
/*  IST time                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Calendar day in IST (UTC+5:30) as YYYY-MM-DD — defaults to right now.
 *
 * Fixed offset rather than `Intl` on purpose: India has no daylight saving and
 * never has, and the durable P&L day keys already written by CalSpread were
 * produced by exactly this arithmetic. `src/tokens/istClock.ts` uses the same
 * offset for the token scheduler, so a day boundary means one thing everywhere.
 */
export function istDayKey(at: number = Date.now()): string {
  const ist = new Date(at + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** True during NSE equity-derivatives hours: Mon-Fri, 09:15-15:40 IST. */
export function isMarketOpen(at: number = Date.now()): boolean {
  const ist = new Date(at + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay(); // 0 Sun ... 6 Sat (on the IST-shifted date)
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 40;
}

/* -------------------------------------------------------------------------- */
/*  Instruments                                                               */
/* -------------------------------------------------------------------------- */

/** Build a token -> "EXCHANGE:TRADINGSYMBOL" resolver from the instrument dump. */
export function makeIdResolver(all: Instrument[]): (token: number) => string | null {
  const byToken = new Map<number, string>();
  for (const inst of all) {
    byToken.set(inst.instrument_token, `${inst.exchange}:${inst.tradingsymbol}`);
  }
  return (token: number) => byToken.get(token) ?? null;
}

/**
 * One board row. Exactly CalSpread's `BoardItem`.
 *
 * `BoxBoardItem` (in `src/box/instruments.ts`) declares only the four fields the
 * Box universe actually reads, and it is deliberately left that way — the Box code
 * must not grow a dependency on the calendar board's shape. The extra `futures`
 * array is still produced because it is what CalSpread's board carried, and a
 * structural subtype is assignable to `BoxBoardItem` wherever the Box module wants
 * one. Declaring it here rather than widening `BoxBoardItem` keeps that seam intact.
 */
export interface FnoBoardItem extends BoxBoardItem {
  futures: { token: number; expiry: string; lot_size: number }[];
}

/**
 * Build the F&O board: each underlying with its spot token and three nearest
 * futures. The Box universe is derived from this — the futures rows supply the
 * lot size and the expiry ladder, and `spot_token` is what places the ATM window.
 *
 * The index-name resolution is the load-bearing part and is unchanged: Zerodha
 * calls the NIFTY spot index "NIFTY 50" while Dhan calls the same index "NIFTY",
 * so `resolveIndexSpotSymbol` tries the curated Zerodha name first and then the
 * underlying symbol itself. Getting this wrong drops every index Box silently.
 */
export function deriveFnoBoard(all: Instrument[]): FnoBoardItem[] {
  const futuresByUnderlying = new Map<string, Instrument[]>();
  const eqBySymbol = new Map<string, Instrument>();
  const indexBySymbol = new Map<string, Instrument>();

  for (const i of all) {
    if (i.exchange === "NFO" && i.instrument_type === "FUT" && i.name) {
      const arr = futuresByUnderlying.get(i.name) ?? [];
      arr.push(i);
      futuresByUnderlying.set(i.name, arr);
    } else if (i.segment === "INDICES") {
      // Spot index instruments (e.g. "NIFTY 50", "NIFTY BANK"). Checked BEFORE the
      // equity branch because indices may also carry instrument_type "EQ".
      indexBySymbol.set(i.tradingsymbol, i);
    } else if (i.exchange === "NSE" && i.instrument_type === "EQ") {
      eqBySymbol.set(i.tradingsymbol, i);
    }
  }

  const stocks: FnoBoardItem[] = [];
  const indices: FnoBoardItem[] = [];

  for (const [symbol, futs] of futuresByUnderlying) {
    const futures = futs
      .slice()
      .sort((a, b) => a.expiry.localeCompare(b.expiry))
      .slice(0, 3)
      .map((f) => ({
        token: f.instrument_token,
        expiry: f.expiry,
        lot_size: f.lot_size,
      }));

    const eq = eqBySymbol.get(symbol);
    if (eq) {
      stocks.push({ symbol, name: eq.name, spot_token: eq.instrument_token, futures });
      continue;
    }

    const indexTradingSymbol = resolveIndexSpotSymbol(symbol, (sym) => indexBySymbol.has(sym));
    const idx = indexTradingSymbol ? indexBySymbol.get(indexTradingSymbol) : undefined;
    if (idx) {
      indices.push({
        symbol,
        name: idx.tradingsymbol, // "NIFTY 50" on Zerodha, "NIFTY" on Dhan
        spot_token: idx.instrument_token,
        futures,
        is_index: true,
      });
    }
    // else: unknown underlying with no spot → skip
  }

  stocks.sort((a, b) => a.symbol.localeCompare(b.symbol));
  indices.sort((a, b) => a.symbol.localeCompare(b.symbol));
  // Indices first, then stocks alphabetically.
  return [...indices, ...stocks];
}

/* -------------------------------------------------------------------------- */
/*  Zerodha charge estimation (virtual contract note)                         */
/* -------------------------------------------------------------------------- */

/** Round money to paise so float noise never reaches the ledger. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Fold Kite's per-order charge object into the flat per-leg record. */
export function toLegCharges(leg: BoxChargeLeg, oc: OrderCharges): ILegCharges {
  const c = oc.charges;
  const brokerage = round2(c.brokerage);
  const stt = round2(c.transaction_tax);
  const exchange_txn = round2(c.exchange_turnover_charge);
  const sebi = round2(c.sebi_turnover_charge);
  const stamp_duty = round2(c.stamp_duty);
  const gst = round2(c.gst.total);
  return {
    side: leg.side,
    tradingsymbol: leg.tradingsymbol,
    quantity: leg.quantity,
    price: round2(leg.price),
    value: round2(leg.quantity * leg.price),
    brokerage,
    stt,
    stt_type: c.transaction_tax_type,
    exchange_txn,
    sebi,
    stamp_duty,
    gst,
    // Sum of the ROUNDED heads rather than Kite's own total, so a leg's total always
    // equals the heads shown for it. Kite's authoritative total stays in `raw`.
    total: round2(brokerage + stt + exchange_txn + sebi + stamp_duty + gst),
  };
}

/** Sum a set of legs into the charges record stored on the trade. */
export function aggregateCharges(
  legs: ILegCharges[],
  source: "kite" | "kite_estimate",
): ITradeCharges {
  const sum = (pick: (l: ILegCharges) => number) =>
    round2(legs.reduce((acc, l) => acc + pick(l), 0));
  return {
    legs,
    value: sum((l) => l.value),
    brokerage: sum((l) => l.brokerage),
    stt: sum((l) => l.stt),
    exchange_txn: sum((l) => l.exchange_txn),
    sebi: sum((l) => l.sebi),
    stamp_duty: sum((l) => l.stamp_duty),
    gst: sum((l) => l.gst),
    total: sum((l) => l.total),
    source,
    at: new Date(),
  };
}

/**
 * Price one or more GROUPS of legs in a single /charges/orders call.
 *
 * Batching is deliberate: the virtual contract note endpoint shares Kite's
 * order-rate quota, so a Box asks for its four entry orders and four projected
 * exit orders together (eight order lines, one request) instead of twice.
 *
 * Returns null — never throws — when Kite cannot price the orders. Charges are a
 * RECORD of a trade, not a precondition for it (`BOX_REQUIRE_PRICED_CHARGES`
 * decides separately whether an unpriced Box may be entered), so a failure here
 * must not propagate into the execution path.
 */
export function makePriceChargeGroups(kite: KiteClient) {
  return async function priceChargeGroups(
    groups: { legs: BoxChargeLeg[]; source: "kite" | "kite_estimate" }[],
  ): Promise<PricedChargeGroup[] | null> {
    const orders: Parameters<KiteClient["getOrderCharges"]>[0] = [];
    for (const [gi, g] of groups.entries()) {
      for (const [li, leg] of g.legs.entries()) {
        orders.push({
          // Synthetic ids: these are simulated fills, so there is no broker order to
          // reference. They also let responses be mapped back to legs by value
          // instead of relying on the response preserving request order.
          order_id: `strikedge-${gi}-${li}`,
          exchange: leg.exchange,
          tradingsymbol: leg.tradingsymbol,
          transaction_type: leg.side,
          variety: "regular",
          product: "NRML",
          order_type: "MARKET",
          quantity: leg.quantity,
          average_price: round2(leg.price),
        });
      }
    }
    if (orders.length === 0) return null;

    let priced: OrderCharges[];
    try {
      priced = await kite.getOrderCharges(orders);
    } catch {
      // Deliberately not logged with the error object: a Kite error can carry the
      // request URL, which carries the api_key.
      console.warn("[Charges] virtual contract note fetch failed.");
      return null;
    }
    if (priced.length !== orders.length) {
      console.warn(
        `[Charges] expected ${orders.length} priced orders, got ${priced.length} — skipping.`,
      );
      return null;
    }

    const byId = new Map(priced.map((p) => [p.order_id, p]));
    const out: PricedChargeGroup[] = [];
    let cursor = 0;
    for (const [gi, g] of groups.entries()) {
      const legCharges: ILegCharges[] = [];
      const logLegs: unknown[] = [];
      for (const [li, leg] of g.legs.entries()) {
        // Prefer the id round-trip; fall back to positional order.
        const oc = byId.get(`strikedge-${gi}-${li}`) ?? priced[cursor + li];
        if (!oc) return null;
        const lc = toLegCharges(leg, oc);
        legCharges.push(lc);
        logLegs.push({ ...lc, token: leg.token, exchange: leg.exchange, expiry: leg.expiry, raw: oc.raw });
      }
      cursor += g.legs.length;
      out.push({ charges: aggregateCharges(legCharges, g.source), logLegs });
    }
    return out;
  };
}
