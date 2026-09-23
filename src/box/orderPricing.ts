/**
 * EXECUTABLE ORDER PRICING — the marketable-limit model, depth walking and the
 * conservative queue approximation.
 *
 * Every function here is PURE: no clock, no randomness, no I/O. Given the same
 * book and the same configuration it returns the same fills, byte for byte. That
 * determinism is load-bearing — the whole point of a paper simulator is that a
 * recorded market always reproduces the same result.
 *
 * THREE IDEAS
 *
 * 1. MARKETABLE LIMIT (not a market order). An order is priced against a REFERENCE
 *    touch and carries a LIMIT a bounded number of ticks past it. The book may be
 *    walked only down to that limit; anything worse is refused. This is the
 *    difference between "I'll pay up to ₹100.10" and "I'll pay whatever is
 *    showing" — real arbitrage execution is the former.
 *
 *       BUY : limit = reference + chaseTicks × tick   (willing to pay UP TO)
 *       SELL: limit = reference − chaseTicks × tick   (willing to sell DOWN TO)
 *
 * 2. DEPTH WALKING. A marketable-limit order fills across as many book levels as
 *    it needs, stopping at the limit. The average fill price is the
 *    quantity-weighted mean of the slices it took.
 *
 * 3. CONSERVATIVE QUEUE APPROXIMATION. We cannot see NSE order-level queue
 *    priority from level-2 depth, so we do NOT pretend the displayed quantity is
 *    all ours. With the "haircut" model only a configurable fraction of each
 *    displayed level is treated as executable for us. This is a transparent,
 *    deterministic stand-in — NOT a reconstruction of true queue position — and it
 *    is recorded (displayed vs effective) so a paper run can compare raw and
 *    conservative liquidity. Randomness is never used.
 */

import type {
  BoxDepthLevel,
  BoxQueueModel,
  OrderSide,
  PaperFillSlice,
  PaperOrderPricing,
  PaperOrderType,
} from "./types.js";

/** Float comparisons on prices tolerate a sub-paise epsilon. */
const EPS = 1e-9;

/** Round money to paise so float noise never reaches the ledger. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Snap a price to the nearest tick multiple, then to paise.
 *
 * NEAREST, not side-directional, and that is deliberate. Rounding a BUY up / a SELL down looks
 * safer in isolation, but with `maxChaseTicks: 0` it pushes the limit OUTSIDE the zero-width chase
 * band, and `assertBoundedLimit` then refuses the envelope outright. Nearest-rounding keeps the
 * limit inside the band for every band width.
 *
 * This only matters at all when the reference price is off our tick grid, which in live trading means
 * the instrument master's `tick_size` disagrees with the exchange's real tick (NSE lot/tick revisions
 * are routine). That case is caught loudly rather than mispriced: `candidateMarketData` raises
 * `leg_tick_size_invalid` when a touch price is not a multiple of the instrument's tick, and
 * `assertBoundedLimit` re-checks alignment and direction before anything reaches the wire. So a tick
 * mismatch produces a local refusal, never a silently wrong order.
 */
export function roundToTick(price: number, tick: number): number {
  if (!(tick > 0)) return round2(price);
  return round2(Math.round(price / tick) * tick);
}

/**
 * The worst price a marketable-limit order will accept.
 *
 * The chase band widens the limit AWAY from us: dearer for a BUY, cheaper for a SELL. Snapped to
 * the tick grid so the limit is itself a tradable price.
 *
 * FLOORED AT ONE TICK — the defect this floor exists to prevent.
 *
 * Without it a SELL whose reference touch sits at or below the chase band produces a limit of zero
 * or less: with the live default of 2 chase ticks at ₹0.05, a bid of ₹0.10 yields ₹0.00 and a bid of
 * ₹0.05 yields ₹-0.05. `assertBoundedLimit` then hard-refuses `limit_price <= 0`, and on the
 * residual-flatten path that throw is swallowed into a failed pass whose disposition reuses the
 * same identity — so the pass deterministically fails again, every two seconds, forever.
 *
 * The legs this bites are exactly the ones a box leaves behind: a far-OTM wing trading at ₹0.05–0.10
 * is completely normal on NSE, and it is the leg an unwind or EMERGENCY_RESIDUAL most often has to
 * sell. The old behaviour meant that leg could never be flattened AT ALL — a naked option carried
 * overnight while the operator was told only "no executable book".
 *
 * ₹0.05 is the lowest tradable price on NSE, not an arbitrary clamp: an order there sells to whatever
 * bid exists and cannot be refused for being off-grid or non-positive. It is also still INSIDE the
 * chase band whenever the reference is a real NSE price (the floor can only raise a SELL limit that
 * the band drove below one tick, and one tick is the lowest price the reference itself can be), so
 * flooring cannot push the envelope past `assertBoundedLimit`'s directional check.
 */
export function computeLimitPrice(args: {
  side: OrderSide;
  referencePrice: number;
  tickSize: number;
  maxChaseTicks: number;
}): number {
  const { side, referencePrice, tickSize, maxChaseTicks } = args;
  const tick = tickSize > 0 ? tickSize : 0;
  const chase = Math.max(0, Math.round(maxChaseTicks)) * tick;
  const raw = side === "BUY" ? referencePrice + chase : referencePrice - chase;
  const snapped = roundToTick(raw, tickSize);
  // A BUY limit is only ever pushed UP by the chase, so it cannot be driven non-positive by this
  // arithmetic; flooring it too costs nothing and means a corrupt reference cannot produce an
  // unsendable envelope on either side.
  if (tick > 0) return Math.max(tick, snapped);
  return snapped;
}

/**
 * Build the full pricing envelope for one order.
 *
 * `orderType` defaults to `MARKETABLE_LIMIT` because that is what the Box strategy submits: a
 * bounded limit priced from the opposite touch with a non-negative chase band is marketable by
 * construction. The parameter exists so a caller that deliberately prices passively can label
 * it truthfully rather than mislabelling it — see {@link classifyOrderProfile}, which
 * determines the label from an observed book rather than from an assumption.
 */
export function buildOrderPricing(args: {
  side: OrderSide;
  quantity: number;
  referencePrice: number;
  tickSize: number;
  maxChaseTicks: number;
  orderType?: PaperOrderType;
}): PaperOrderPricing {
  const tick = args.tickSize > 0 ? args.tickSize : 0.05;
  return {
    order_type: args.orderType ?? "MARKETABLE_LIMIT",
    side: args.side,
    quantity: args.quantity,
    reference_price: round2(args.referencePrice),
    tick_size: tick,
    max_chase_ticks: Math.max(0, Math.round(args.maxChaseTicks)),
    limit_price: computeLimitPrice({
      side: args.side,
      referencePrice: args.referencePrice,
      tickSize: tick,
      maxChaseTicks: args.maxChaseTicks,
    }),
  };
}

/**
 * The quantity at a displayed level that is treated as executable FOR US.
 *
 * "none": all of it. "haircut": the fraction not assumed to be queued ahead of us,
 * floored to whole contracts. Deterministic — the same displayed quantity and the
 * same configuration always yield the same effective quantity.
 */
export function effectiveQty(displayed: number, model: BoxQueueModel, haircutPct: number): number {
  if (!Number.isSafeInteger(displayed) || displayed <= 0) return 0;
  if (model === "none") return displayed;
  if (!Number.isFinite(haircutPct)) return 0;
  const pct = Math.min(100, Math.max(0, haircutPct));
  return Math.floor(displayed * (1 - pct / 100));
}

/** Whether a level's price is executable for a side against a limit. */
function withinLimit(side: OrderSide, price: number, limit: number): boolean {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(limit) || limit <= 0) return false;
  return side === "BUY" ? price <= limit + EPS : price >= limit - EPS;
}

export interface DepthWalkResult {
  /** Quantity this walk could fill from the given book. */
  filled_qty: number;
  /** Quantity-weighted average price of the slices, or null if nothing filled. */
  average_price: number | null;
  slices: PaperFillSlice[];
  /**
   * Executable quantity available within the limit on THIS book, after the queue
   * model — i.e. the most this order could have taken here regardless of how much
   * it still wanted. Recorded for the "estimated vs realised executable" metric.
   */
  executable_within_limit: number;
}

/**
 * Walk the book for one order, up to `remainingQty`, never past `limitPrice`,
 * consuming only the queue-adjusted effective quantity at each level.
 *
 * Levels are visited best-price-first (lowest ask for a BUY, highest bid for a
 * SELL). The book is not mutated. Slices are stamped with the supplied book time
 * and version so a fill is always traceable to the exact packet it came from.
 */
export function walkDepth(args: {
  side: OrderSide;
  levels: BoxDepthLevel[];
  remainingQty: number;
  limitPrice: number;
  queueModel: BoxQueueModel;
  haircutPct: number;
  at: number;
  quoteVersion: number | null;
  /**
   * OPTIONAL, live-parity paper only: quantity already reserved by earlier concurrent
   * paper attempts at (price, version), subtracted from each level's queue-adjusted
   * effective quantity so two attempts cannot double-consume one observed level. When
   * omitted the walk is byte-identical to before — standard paper and the live precheck
   * never pass it.
   */
  reserved?: ((price: number, quoteVersion: number | null) => number) | undefined;
}): DepthWalkResult {
  const { side, levels, remainingQty, limitPrice, queueModel, haircutPct, at, quoteVersion, reserved } = args;
  const slices: PaperFillSlice[] = [];
  if (!Number.isSafeInteger(remainingQty) || remainingQty <= 0 ||
      !Number.isFinite(limitPrice) || limitPrice <= 0) {
    return { filled_qty: 0, average_price: null, slices, executable_within_limit: 0 };
  }
  let remaining = remainingQty;
  let filled = 0;
  let valueSum = 0;
  let executableWithinLimit = 0;

  // Best price first: ascending for a BUY (cheapest ask), descending for a SELL
  // (richest bid). Sorting a COPY leaves the caller's book untouched.
  const ordered = [...levels]
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.price * 100) &&
      Number.isSafeInteger(l.qty) && l.qty > 0 && Number.isFinite(l.price * l.qty))
    .sort((a, b) => (side === "BUY" ? a.price - b.price : b.price - a.price));

  for (const lv of ordered) {
    if (!withinLimit(side, lv.price, limitPrice)) break; // deeper levels are only worse
    const effectiveRaw = effectiveQty(lv.qty, queueModel, haircutPct);
    // Subtract liquidity earlier concurrent paper attempts already reserved at this
    // exact level+version. `reserved` is undefined outside live-parity paper, so this is
    // a no-op and the result is identical to before.
    const reservedQty = reserved ? reserved(lv.price, quoteVersion) : 0;
    const already = Number.isSafeInteger(reservedQty) && reservedQty > 0 ? reservedQty : 0;
    const effective = Math.max(0, effectiveRaw - already);
    executableWithinLimit = Math.min(Number.MAX_SAFE_INTEGER, executableWithinLimit + effective);
    if (remaining <= 0 || effective <= 0) continue;
    const take = Math.min(remaining, effective);
    if (take <= 0) continue;
    slices.push({
      price: round2(lv.price),
      qty: take,
      displayed_qty: lv.qty,
      effective_qty: effective,
      at,
      quote_version: quoteVersion,
    });
    filled += take;
    valueSum += lv.price * take;
    remaining -= take;
  }

  return {
    filled_qty: filled,
    average_price: filled > 0 ? round2(valueSum / filled) : null,
    slices,
    executable_within_limit: executableWithinLimit,
  };
}

/**
 * MARKETABLE vs PASSIVE classification, decided from an OBSERVED book rather than from an
 * assumption about how the order was priced.
 *
 * WHY THE DISTINCTION IS LOAD-BEARING (audit divergence D20)
 *
 * A marketable limit crosses the spread: it executes against liquidity that is visible to us
 * right now, so its fill behaviour is largely a function of things we CAN measure — displayed
 * depth within the limit, and how fast we arrive. A passive limit rests behind other orders at
 * its price, so whether and when it fills is dominated by true NSE queue position and by other
 * participants' flow, NEITHER of which a retail level-2 feed reveals.
 *
 * That means the two have fundamentally different epistemic status. Statistics about marketable
 * fills are evidence; statistics about passive fills are largely a statement about an unobserved
 * queue. Pooling them produces a "fill rate" that flatters passive orders, slanders marketable
 * ones, and describes neither — which is why every distribution and every parity comparison in
 * this system is keyed by the profile this function returns.
 *
 * Pure: no clock, no randomness.
 */
export interface OrderProfileClassification {
  readonly profile: PaperOrderType;
  /** True when the limit is at or through the opposite touch. */
  readonly marketable: boolean;
  /** The opposite touch the classification was made against, or null when unobservable. */
  readonly touch: number | null;
  /**
   * Signed distance from the touch, in ticks. POSITIVE means through the touch (more
   * aggressive); negative means resting behind it. Null when the touch is unknown.
   *
   * Recorded because it is the single most useful covariate for queue-model calibration: how
   * far past the touch an order reached predicts how much of the displayed depth it realised.
   */
  readonly offsetTicks: number | null;
  /** Set when the book gave no opposite touch, so the profile is a documented assumption. */
  readonly assumed: boolean;
}

export function classifyOrderProfile(args: {
  side: OrderSide;
  limitPrice: number;
  bids: BoxDepthLevel[];
  asks: BoxDepthLevel[];
  tickSize: number;
}): OrderProfileClassification {
  const { side, limitPrice } = args;
  const touch = touchPrice(side, args.bids, args.asks);
  const tick = args.tickSize > 0 ? args.tickSize : 0.05;

  if (touch === null || !(limitPrice > 0)) {
    // No observable opposite touch. We do NOT guess a passive classification: the strategy
    // prices from the touch with a non-negative chase, so marketable is the correct structural
    // answer — but `assumed` records that this came from construction, not observation.
    return { profile: "MARKETABLE_LIMIT", marketable: true, touch: null, offsetTicks: null, assumed: true };
  }

  // A BUY is marketable when it is willing to pay at least the best ask; a SELL when it is
  // willing to accept at most the best bid.
  const marketable = side === "BUY" ? limitPrice >= touch - EPS : limitPrice <= touch + EPS;
  const rawOffset = side === "BUY" ? limitPrice - touch : touch - limitPrice;
  return {
    profile: marketable ? "MARKETABLE_LIMIT" : "PASSIVE_LIMIT",
    marketable,
    touch: round2(touch),
    offsetTicks: Math.round((rawOffset / tick) * 100) / 100,
    assumed: false,
  };
}

/** The best (touch) price on one side of a book: lowest ask for a BUY, highest bid for a SELL. */
export function touchPrice(side: OrderSide, bids: BoxDepthLevel[], asks: BoxDepthLevel[]): number | null {
  const levels = side === "BUY" ? asks : bids;
  let best: number | null = null;
  for (const l of levels) {
    if (!Number.isFinite(l.price) || l.price <= 0 ||
        !Number.isSafeInteger(l.qty) || l.qty <= 0) continue;
    if (best === null) best = l.price;
    else best = side === "BUY" ? Math.min(best, l.price) : Math.max(best, l.price);
  }
  return best;
}
