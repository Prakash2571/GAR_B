/**
 * The LOCAL, deterministic, synchronous option-charge calculator.
 *
 * WHY THIS EXISTS
 *
 * Box qualification used to wait on Zerodha's virtual contract note
 * (POST /charges/orders) before it could decide whether an opportunity was still
 * worth taking. That put a network round trip — tens to hundreds of milliseconds
 * — between seeing a four-leg mispricing and acting on it, which is exactly the
 * window in which such a mispricing disappears.
 *
 * So the decision path now uses this module: no I/O, no promises, no caching
 * needed, a few dozen floating-point operations. Zerodha is still consulted, but
 * AFTERWARDS, to verify the arithmetic (see chargeReconciler.ts). A paper fill is
 * never delayed by it.
 *
 * SEMANTICS ARE COPIED, NOT INVENTED
 *
 * The output shape and the rounding rules are taken from the calendar engine's
 * existing `toLegCharges` / `aggregateCharges` in src/index.ts, so a locally
 * calculated contract note is interchangeable with a Zerodha-priced one:
 *
 *   - every head is rounded to paise individually
 *   - a leg's `total` is the sum of its ROUNDED heads (so heads always add up)
 *   - a group's heads are the sums of the legs' rounded heads
 *   - `value` is quantity x fill price (premium turnover)
 *   - `stt_type` is Kite's label, "stt" for equity derivatives
 *
 * RATES
 *
 * The rates are NOT hardcoded in the trading logic: they live in one place here
 * and every one is env-overridable, because statutory rates change. The shipped
 * defaults are the current NSE equity-OPTIONS structure:
 *
 *   brokerage           ₹20 per executed order (Zerodha F&O)
 *   STT                 0.15% of premium, SELL side only
 *   exchange txn        0.035530% of premium (NSE equity options), both sides
 *   SEBI turnover       0.0001% of premium (₹10 per crore), both sides
 *   stamp duty          0.003% of premium, BUY side only
 *   GST                 18% of (brokerage + exchange txn + SEBI)
 *   NSE IPFT            0 by default — see BOX_IPFT_PCT below
 *
 * Sources for the defaults (rates are summarized, not quoted):
 *   https://support.zerodha.com/category/account-opening/resident-individual/ri-charges/articles/exchange-transaction-charges
 *   https://support.zerodha.com/category/account-opening/company-partnership-and-huf-account-opening/company/articles/charges-society-account
 *   https://www.kotakneo.com/uploads/FATAX_73524_49fff471f4.pdf  (STT on option sales)
 *
 * If a rate changes, or if the reconciler starts reporting a consistent
 * discrepancy, ONE env var fixes it for the whole module — and until it is fixed
 * the discrepancy is visible in /api/box/status rather than silently mispricing
 * every trade.
 */

import type {
  BoxChargeOrigin,
  BoxCharges,
  BoxChargesWithOrigin,
  BoxLegCharges,
  OrderSide,
} from "./types.js";

/** Round money to paise so float noise never reaches the ledger. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * The one and only rate card for box charges.
 *
 * Percentages are expressed as PERCENT (0.15 means 0.15%), matching how every
 * broker and exchange circular states them — so a value copied from a circular
 * can be pasted into the env var without conversion.
 */
export interface BoxChargeRates {
  /** Flat brokerage per executed order (₹). */
  brokeragePerOrder: number;
  /** Optional cap as a percentage of turnover; 0 disables it. */
  brokerageMaxPct: number;
  /** STT on option SALES, percent of premium. */
  sttSellPct: number;
  /**
   * STT on option EXERCISE, percent of INTRINSIC value, charged to the option BUYER.
   *
   * A different tax on a different base from {@link sttSellPct}, and kept as its own rate for that
   * reason even when the two happen to be numerically equal: premium STT is paid by the writer at the
   * moment of sale, exercise STT by the holder at settlement. They have moved independently before.
   */
  sttExercisePct: number;
  /**
   * How STT is rounded. Zerodha's contract note rounds the STT head to the
   * NEAREST RUPEE, not to paise — so ₹33.75 of computed STT is billed as ₹34.
   * Modelled explicitly here (via `roundStt`) rather than assuming every head
   * rounds to paise identically. Set false to round to paise instead.
   */
  sttRoundNearestRupee: boolean;
  /** Exchange transaction charge, percent of premium, both sides. */
  exchangeTxnPct: number;
  /**
   * NSE IPFT (Investor Protection Fund Trust), expressed as ₹ PER CRORE of
   * premium turnover — the unit the exchange circular actually uses, so no
   * percentage conversion is needed. It is folded into the exchange head, which
   * is where a contract note shows it. 0 = not modelled.
   */
  ipftPerCrore: number;
  /**
   * @deprecated Legacy IPFT expressed as a PERCENT of premium. Kept so an
   * existing `BOX_IPFT_PCT` deployment still works; prefer `ipftPerCrore`. Both
   * are added if set.
   */
  ipftPct: number;
  /** SEBI turnover fee, percent of premium, both sides. */
  sebiPct: number;
  /** Stamp duty on PURCHASES, percent of premium. */
  stampDutyBuyPct: number;
  /** GST on (brokerage + exchange txn + SEBI), percent. */
  gstPct: number;
  /** Kite's label for the transaction tax on this segment. */
  sttType: string;
  /**
   * Identifier for THIS rate card, stamped onto every trade and execution attempt.
   *
   * Statutory rates change (option STT moved on 1 April 2026), so a P&L number is
   * only interpretable alongside the rates it was computed with. Recording the
   * version means results from before and after a change stay comparable instead of
   * silently blending into one series.
   */
  rateVersion: string;
}

/** The shipped rate card, with every value env-overridable. */
export function loadBoxChargeRates(): BoxChargeRates {
  return {
    brokeragePerOrder: num("BOX_BROKERAGE_PER_ORDER", 20),
    brokerageMaxPct: num("BOX_BROKERAGE_MAX_PCT", 0),
    /**
     * Options STT, sell side, percent of PREMIUM.
     *
     * 0.15% since 1 April 2026, when option STT was flattened to a uniform rate
     * (futures went 0.02% → 0.05% in the same revision). The previous default here
     * was 0.10%, which UNDERSTATED the single largest cost in the round trip by a
     * third and therefore flattered every paper result — the dangerous direction to
     * be wrong in. Verify against zerodha.com/charges for your account and override
     * if it has moved again.
     */
    sttSellPct: num("BOX_STT_SELL_PCT", 0.15),
    /**
     * STT on option EXERCISE, percent of INTRINSIC value, charged to the BUYER.
     *
     * 0.15% since 1 April 2026, raised from 0.125% in the same Budget 2026 revision that took
     * sell-side premium STT from 0.10% to 0.15%. Verify against zerodha.com/charges and override if
     * it moves again.
     *
     * A SEPARATE RATE FROM {@link BoxChargeRates.sttSellPct}, even though the two are numerically
     * equal today, because they are different taxes on different bases: sell-side STT is a percentage
     * of PREMIUM paid by the writer at the time of sale, exercise STT is a percentage of INTRINSIC
     * VALUE paid by the holder at settlement. They have moved independently before (0.0625→0.10 on
     * premium in Oct 2024 left exercise at 0.125) and will again, so collapsing them into one knob
     * would guarantee a wrong number the next time only one changes.
     */
    sttExercisePct: num("BOX_STT_EXERCISE_PCT", 0.15),
    sttRoundNearestRupee: bool("BOX_STT_ROUND_NEAREST_RUPEE", true),
    exchangeTxnPct: num("BOX_EXCHANGE_TXN_PCT", 0.03503),
    /**
     * NSE IPFT, ₹ per crore of premium turnover — ₹50/crore on equity options.
     *
     * This previously defaulted to 0 while the comment stated ₹50, so the code and
     * its documentation disagreed and the head was silently omitted. It is small
     * (₹50/crore ≈ ₹0.11 on a ₹22,500 leg) but it is billed, so it is modelled.
     */
    ipftPerCrore: num("BOX_IPFT_PER_CRORE", 50),
    ipftPct: num("BOX_IPFT_PCT", 0),
    sebiPct: num("BOX_SEBI_PCT", 0.0001),
    stampDutyBuyPct: num("BOX_STAMP_DUTY_BUY_PCT", 0.003),
    gstPct: num("BOX_GST_PCT", 18),
    sttType: process.env.BOX_STT_TYPE?.trim() || "stt",
    rateVersion:
      process.env.BOX_CHARGE_RATE_VERSION?.trim() || "zerodha-nse-options-2026-04-01",
  };
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

/**
 * Statutory rounding of the STT head.
 *
 * The one place this rule lives, so a contract note reads like Zerodha's. STT is
 * rounded to the nearest rupee by default (their documented behaviour); the other
 * heads keep paise. Centralised so it can never be applied to the wrong head.
 */
export function roundStt(value: number, rates: Pick<BoxChargeRates, "sttRoundNearestRupee">): number {
  return rates.sttRoundNearestRupee ? Math.round(value) : round2(value);
}

/** IPFT for one leg (₹), from the ₹/crore rate plus any legacy percentage. */
export function ipftFor(value: number, rates: BoxChargeRates): number {
  const perCrore = (value * rates.ipftPerCrore) / 10_000_000;
  const legacyPct = pct(value, rates.ipftPct);
  return round2(perCrore + legacyPct);
}

/** One order to charge: the instrument, the size and the fill price. */
export interface BoxChargeOrder {
  side: OrderSide;
  tradingsymbol: string;
  quantity: number;
  price: number;
}

const pct = (value: number, percent: number): number => (value * percent) / 100;

/**
 * Charges for ONE option order, computed exactly the way the stored contract
 * note is shaped.
 *
 * Every head is rounded to paise and the total is the sum of those rounded heads,
 * so a caller can add up the heads OR trust the total and get the same number —
 * the invariant the calendar ledger already relies on, and the one the tests
 * assert.
 */
export function calculateLegCharges(
  order: BoxChargeOrder,
  rates: BoxChargeRates,
): BoxLegCharges {
  const value = round2(order.quantity * order.price);

  const cap = rates.brokerageMaxPct > 0 ? pct(value, rates.brokerageMaxPct) : Infinity;
  const brokerage = round2(Math.min(rates.brokeragePerOrder, cap));

  // STT is a SELL-side tax on the premium; a purchase pays none. Rounded by the
  // statutory rule (nearest rupee by default), NOT to paise like the other heads.
  const stt = order.side === "SELL" ? roundStt(pct(value, rates.sttSellPct), rates) : 0;
  // Exchange transaction charge + IPFT (₹/crore) ride in the exchange head, which
  // is where a contract note shows them.
  const exchange_txn = round2(pct(value, rates.exchangeTxnPct) + ipftFor(value, rates));
  const sebi = round2(pct(value, rates.sebiPct));
  // Stamp duty is a BUY-side duty.
  const stamp_duty = order.side === "BUY" ? round2(pct(value, rates.stampDutyBuyPct)) : 0;
  // GST applies to brokerage and the two turnover fees — never to STT or stamp duty.
  const gst = round2(pct(brokerage + exchange_txn + sebi, rates.gstPct));

  return {
    side: order.side,
    tradingsymbol: order.tradingsymbol,
    quantity: order.quantity,
    price: round2(order.price),
    value,
    brokerage,
    stt,
    stt_type: order.side === "SELL" ? rates.sttType : "",
    exchange_txn,
    sebi,
    stamp_duty,
    gst,
    total: round2(brokerage + stt + exchange_txn + sebi + stamp_duty + gst),
  };
}

/**
 * Charges for a GROUP of orders (the four legs of one side of a box).
 *
 * `source` keeps the calendar-compatible meaning ("kite" = the priced fills,
 * "kite_estimate" = a projection), while `computed_by` records that these numbers
 * were produced locally — so nothing can present an unverified local calculation
 * as a Zerodha-confirmed one.
 */
export function calculateBoxCharges(
  orders: BoxChargeOrder[],
  rates: BoxChargeRates,
  source: BoxCharges["source"] = "kite",
  computedBy: BoxChargeOrigin = "local",
  at: Date = new Date(),
): BoxChargesWithOrigin {
  const legs = orders.map((o) => calculateLegCharges(o, rates));
  const sum = (pick: (l: BoxLegCharges) => number) =>
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
    at,
    computed_by: computedBy,
  };
}

/**
 * Charge orders for a set of evaluated legs.
 *
 * The side comes from the evaluation, so this is direction-agnostic: a short box's
 * orders are charged as the sells and buys it actually places. Returns null when
 * any leg has no executable price, because charging a fill that cannot happen
 * would be meaningless.
 */
export function ordersFromLegs(
  legs: { side: OrderSide; tradingsymbol: string; price: number | null }[],
  quantity: number,
): BoxChargeOrder[] | null {
  const out: BoxChargeOrder[] = [];
  for (const leg of legs) {
    if (leg.price === null || !(leg.price > 0)) return null;
    out.push({
      side: leg.side,
      tradingsymbol: leg.tradingsymbol,
      quantity,
      price: round2(leg.price),
    });
  }
  return out;
}

/** The same orders with both sides reversed — i.e. the orders that close them. */
export function reverseOrders(orders: BoxChargeOrder[]): BoxChargeOrder[] {
  return orders.map((o) => ({
    ...o,
    side: o.side === "BUY" ? ("SELL" as const) : ("BUY" as const),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Settlement (hold-to-expiry) charges                                       */
/* -------------------------------------------------------------------------- */

/** One leg of a box as it stands at expiry, for settlement pricing. */
export interface BoxSettlementLeg {
  /** The side we HOLD: BUY = long the option, SELL = short it (we wrote it). */
  side: OrderSide;
  tradingsymbol: string;
  instrument_type: "CE" | "PE";
  strike: number;
  quantity: number;
}

/** What holding a box to settlement costs, per head. */
export interface BoxSettlementCharges {
  /**
   * STT on EXERCISE: 0.15% of intrinsic value, charged to the BUYER of an ITM option.
   *
   * Rounded by the same statutory nearest-rupee rule as sell-side STT.
   */
  stt_exercise: number;
  /** Total settlement cost (currently exercise STT alone — see the note in the function). */
  total: number;
  /** Per-leg intrinsic value at the settlement price, for audit. */
  legs: {
    tradingsymbol: string;
    side: OrderSide;
    instrument_type: "CE" | "PE";
    strike: number;
    quantity: number;
    /** max(0, S − K) for a call, max(0, K − S) for a put. */
    intrinsic_per_unit: number;
    /** Whether this leg is exercised against us paying exercise STT (long AND in the money). */
    exercised_long: boolean;
    stt_exercise: number;
  }[];
  /** The settlement price the intrinsics were computed against. */
  settlement_price: number;
  rate_version: string;
}

/**
 * What it costs to let a box go to SETTLEMENT instead of closing it.
 *
 * THE GAP THIS FILLS. There was no expiry branch in the economics at all. `BoxChargeOrder` carries
 * only side/symbol/quantity/price — no strike and no instrument type — so exercise STT was not merely
 * missing, it was structurally impossible to compute. The consequence was not a small error: the
 * engine could not compare holding against unwinding, and when a box DID reach settlement (an
 * illiquid wing inside the expiry-safety window is refused a fill by design, because that window
 * never invents a price) the realised cost was simply never booked. The position stayed "open" and
 * contributed stale marks to the day's P&L indefinitely.
 *
 * THE ARITHMETIC. Exercise STT is 0.15% of INTRINSIC value (raised from 0.125% effective 1 April
 * 2026), payable by the BUYER of an option that is exercised. So:
 *
 *   - It applies ONLY to legs we are LONG (`side === "BUY"`) and only when they are in the money. A
 *     short leg is ASSIGNED, and the writer pays no exercise STT — which is why the side test is not
 *     symmetric and must not be "simplified".
 *   - A box always has ITM legs. For K1 < S < K2 the two long legs' intrinsics sum to exactly the
 *     width, so the floor is 0.15% × width × lot — about ₹22 on a 200-wide NIFTY box. Outside the
 *     strikes it is unbounded in |S − K1|: a box whose lower strike finishes 4,100 points ITM pays
 *     roughly ₹461 on one 75-lot, several times any edge such a box could show.
 *
 * WHAT IS DELIBERATELY NOT MODELLED HERE. Physical settlement of STOCK options produces a delivery
 * obligation, delivery brokerage, DP charges and a very different STT treatment. Rather than
 * approximate that, stock underlyings are kept out of the universe by default
 * (`BOX_ALLOW_STOCK_UNDERLYINGS`); this function is correct for CASH-settled index options and should
 * not be extended to stocks without modelling delivery properly.
 *
 * PURE: no clock, no I/O.
 */
export function calculateSettlementCharges(
  legs: BoxSettlementLeg[],
  settlementPrice: number,
  rates: BoxChargeRates,
): BoxSettlementCharges {
  const priced = legs.map((leg) => {
    const intrinsicPerUnit = leg.instrument_type === "CE"
      ? Math.max(0, settlementPrice - leg.strike)
      : Math.max(0, leg.strike - settlementPrice);
    // LONG and in the money. A short ITM leg is assigned; the writer pays no exercise STT.
    const exercisedLong = leg.side === "BUY" && intrinsicPerUnit > 0;
    const notional = round2(intrinsicPerUnit * leg.quantity);
    const stt = exercisedLong
      ? roundStt(pct(notional, rates.sttExercisePct), rates)
      : 0;
    return {
      tradingsymbol: leg.tradingsymbol,
      side: leg.side,
      instrument_type: leg.instrument_type,
      strike: leg.strike,
      quantity: leg.quantity,
      intrinsic_per_unit: round2(intrinsicPerUnit),
      exercised_long: exercisedLong,
      stt_exercise: stt,
    };
  });
  const sttExercise = round2(priced.reduce((sum, l) => sum + l.stt_exercise, 0));
  return {
    stt_exercise: sttExercise,
    // Sum of the heads, so the total always equals what is itemised — the same invariant
    // `calculateLegCharges` maintains. Currently one head; kept as a total so adding another
    // (e.g. a delivery head if stocks are ever modelled) cannot silently bypass callers.
    total: sttExercise,
    legs: priced,
    settlement_price: round2(settlementPrice),
    rate_version: rates.rateVersion,
  };
}

/**
 * Entry charges AND the projected exit charges of a box, in one synchronous call.
 *
 * The exit projection is priced at the ENTRY fills, which is the conservative
 * assumption the module has always made: it presumes unwinding costs at least
 * what putting the box on did.
 */
export function calculateRoundTrip(
  entryOrders: BoxChargeOrder[],
  rates: BoxChargeRates,
  at: Date = new Date(),
): {
  entry: BoxChargesWithOrigin;
  estimated_exit: BoxChargesWithOrigin;
  entry_total: number;
  estimated_exit_total: number;
} {
  const entry = calculateBoxCharges(entryOrders, rates, "kite", "local", at);
  const estimated_exit = calculateBoxCharges(
    reverseOrders(entryOrders),
    rates,
    "kite_estimate",
    "local",
    at,
  );
  return {
    entry,
    estimated_exit,
    entry_total: entry.total,
    estimated_exit_total: estimated_exit.total,
  };
}

/**
 * A ready-made calculator bound to one rate card.
 *
 * Held by the engine so the rates are read from the environment once at boot
 * rather than per evaluation, and so tests can inject their own card.
 */
export class LocalChargeCalculator {
  constructor(readonly rates: BoxChargeRates = loadBoxChargeRates()) {}

  legs(orders: BoxChargeOrder[], source: BoxCharges["source"] = "kite"): BoxChargesWithOrigin {
    return calculateBoxCharges(orders, this.rates, source);
  }

  roundTrip(entryOrders: BoxChargeOrder[], at?: Date) {
    return calculateRoundTrip(entryOrders, this.rates, at);
  }

  /** Just the totals — what the hot path actually needs. */
  totals(entryOrders: BoxChargeOrder[]): { entry: number; exit: number } {
    const rt = calculateRoundTrip(entryOrders, this.rates);
    return { entry: rt.entry_total, exit: rt.estimated_exit_total };
  }
}
