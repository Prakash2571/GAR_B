/**
 * THE ECONOMIC SIZE OF UNRESOLVED RESIDUAL EXPOSURE — measured, never modelled.
 *
 * ── WHAT PROBLEM THIS SOLVES ─────────────────────────────────────────────────────────────────
 *
 * "3 residual legs" says nothing about scale. Three legs of one NIFTY lot and three legs of a large
 * single-stock lot are the same sentence and very different mornings. An operator deciding whether to
 * intervene manually needs a rupee figure.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────────────────────────
 *
 * It is NOT maximum loss, VaR, risk, worst-case loss or capital at risk. It is NOTIONAL: quantity
 * times a price. For an option position the loss can exceed notional (a short leg) or be bounded well
 * below it (a long leg), and nothing here computes which. Naming it "risk" would claim a quantity this
 * code does not derive, and on a real-money operator surface that is worse than saying less.
 *
 * Two figures are reported because they answer different questions and must never be conflated:
 *
 *   MARKED    quantity x the freshest usable LAST TRADED price. What the exposure is worth now.
 *             UNKNOWN when the price is missing, stale or unusable — never zero.
 *
 *   COMMITTED quantity x `average_price`, the price the position was actually acquired at. Durable,
 *             recorded on the residual itself, so it is available even with a dead feed and it
 *             survives a restart. It is a historical fact, not a mark.
 *
 * ── UNKNOWN IS NOT ZERO ──────────────────────────────────────────────────────────────────────
 *
 * Zero is reported only when the residual quantity is genuinely zero. Everything else that cannot be
 * computed reports `null` with a reason. A zero shown for "we could not tell" would read as "nothing
 * outstanding", which is the exact opposite of the truth being reported.
 *
 * And a PARTIAL total is treated as unknown too: if one leg of four cannot be priced, the sum of the
 * other three understates the exposure while looking like a complete answer. A number that is wrong in
 * the reassuring direction is worse than an admission.
 *
 * ── QUANTITY SEMANTICS: NO SECOND LOT MULTIPLICATION ─────────────────────────────────────────
 *
 * `ResidualLegExposure.quantity` is documented as "outstanding quantity still on our book" and is
 * already in INDIVIDUAL CONTRACTS — the same units the order carried, which is one lot already
 * multiplied out (65 for a one-lot NIFTY leg, not 1). Multiplying by a lot size here would overstate
 * every figure by the lot size, so it is not done, and a test pins that.
 *
 * ── OBSERVABILITY ONLY ───────────────────────────────────────────────────────────────────────
 *
 * Nothing here can refuse anything. It returns numbers. It introduces no threshold, no comparison and
 * no gate, so it cannot block an exit, a protective cancel, an emergency residual flatten,
 * reconciliation or a broker-state refresh — there is no code path by which it could.
 */

/** One residual leg, reduced to what a notional calculation needs. */
export interface ResidualNotionalLeg {
  readonly token: number;
  /** Outstanding quantity in INDIVIDUAL CONTRACTS — already lot-multiplied. Sign is ignored. */
  readonly quantity: number;
  /** The price this exposure was acquired at (₹). Durable; survives a restart. */
  readonly average_price: number;
}

/** The freshest last-traded price for a token, with the receive time freshness is measured against. */
export interface ResidualPriceLookup {
  (token: number): { readonly last: number; readonly at: number } | undefined;
}

export type ResidualPriceSource = "last_traded_fresh" | "unknown" | "not_applicable";

export interface ResidualNotionalView {
  readonly residualLegCount: number;
  /** Total outstanding contracts across all legs, absolute. */
  readonly totalQuantity: number;
  /**
   * Quantity x freshest usable last-traded price, in whole rupees. `null` means UNKNOWN — see
   * `markedUnknownReason`. `0` appears only when there is genuinely no residual quantity.
   */
  readonly markedNotionalRupees: number | null;
  readonly markedUnknownReason: string | null;
  readonly priceSource: ResidualPriceSource;
  /** Quantity x the acquisition price, in whole rupees. `null` only if a leg's price is unusable. */
  readonly committedNotionalRupees: number | null;
  readonly legsPriced: number;
  readonly legsUnpriced: number;
}

/** A finite, non-negative, sane magnitude — rejects NaN, Infinity and negatives. */
function usableMagnitude(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Round to whole rupees, refusing a value that has left the range where integer arithmetic is exact.
 *
 * `Number.MAX_SAFE_INTEGER` rather than `Number.isFinite` alone: a product can stay finite while
 * losing integer precision, and silently reporting a figure that is merely approximately right is the
 * kind of false confidence this whole module is written against.
 */
function toWholeRupees(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded)) return null;
  return rounded;
}

/**
 * Measure unresolved residual exposure.
 *
 * Pure and total: no clock, no I/O, no state. `nowWall` and `maxPriceAgeMs` are supplied so the
 * freshness rule is the caller's existing policy rather than a threshold invented here.
 */
export function deriveResidualNotional(input: {
  readonly legs: readonly ResidualNotionalLeg[];
  readonly price: ResidualPriceLookup;
  readonly nowWall: number;
  /** Maximum age of a last-traded price for it to be usable, ms. `0` or negative ⇒ never usable. */
  readonly maxPriceAgeMs: number;
}): ResidualNotionalView {
  const { legs, price, nowWall, maxPriceAgeMs } = input;

  let totalQuantity = 0;
  let marked = 0;
  let committed = 0;
  let legsPriced = 0;
  let legsUnpriced = 0;
  let markedUnknownReason: string | null = null;
  let committedUnusable = false;

  for (const leg of legs) {
    const quantity = Math.abs(leg.quantity);
    if (!usableMagnitude(quantity)) {
      // An uncertain quantity makes BOTH figures unanswerable for this leg, and therefore in total.
      markedUnknownReason ??= `residual quantity for token ${leg.token} is not a usable number`;
      committedUnusable = true;
      legsUnpriced += 1;
      continue;
    }
    totalQuantity += quantity;

    // COMMITTED — from the durable acquisition price. No feed involved, so no freshness question.
    if (usableMagnitude(leg.average_price)) {
      committed += quantity * Math.abs(leg.average_price);
    } else {
      committedUnusable = true;
    }

    // MARKED — from the freshest usable last-traded price.
    const quote = price(leg.token);
    if (quote === undefined) {
      legsUnpriced += 1;
      markedUnknownReason ??= `no market price available for token ${leg.token}`;
      continue;
    }
    const age = nowWall - quote.at;
    if (maxPriceAgeMs <= 0 || !Number.isFinite(age) || age < 0 || age > maxPriceAgeMs) {
      legsUnpriced += 1;
      markedUnknownReason ??=
        `market price for token ${leg.token} is stale (age ${Number.isFinite(age) ? age : "?"}ms > ${maxPriceAgeMs}ms)`;
      continue;
    }
    if (!usableMagnitude(quote.last) || quote.last === 0) {
      legsUnpriced += 1;
      markedUnknownReason ??= `market price for token ${leg.token} is not a usable price`;
      continue;
    }
    /*
     * NO LOT MULTIPLICATION. `quantity` is already individual contracts; multiplying by a lot size
     * here would overstate the figure by exactly that lot size.
     */
    marked += quantity * quote.last;
    legsPriced += 1;
  }

  if (legs.length === 0) {
    // Genuinely nothing outstanding. This is the one case where zero is the truthful answer.
    return {
      residualLegCount: 0,
      totalQuantity: 0,
      markedNotionalRupees: 0,
      markedUnknownReason: null,
      priceSource: "not_applicable",
      committedNotionalRupees: 0,
      legsPriced: 0,
      legsUnpriced: 0,
    };
  }

  /*
   * A PARTIAL TOTAL IS UNKNOWN. Summing only the legs that could be priced produces a number that is
   * confidently too small, which is the worst kind of wrong on an exposure readout.
   */
  const markedComplete = legsUnpriced === 0 && markedUnknownReason === null;
  const markedRupees = markedComplete ? toWholeRupees(marked) : null;
  const overflowed = markedComplete && markedRupees === null;

  const committedRupees = committedUnusable ? null : toWholeRupees(committed);

  return {
    residualLegCount: legs.length,
    totalQuantity,
    markedNotionalRupees: markedRupees,
    markedUnknownReason: markedComplete
      ? (overflowed ? "notional exceeded the range where the figure would be exact" : null)
      : (markedUnknownReason ?? `${legsUnpriced} of ${legs.length} residual leg(s) could not be priced`),
    priceSource: markedRupees === null ? "unknown" : "last_traded_fresh",
    committedNotionalRupees: committedRupees,
    legsPriced,
    legsUnpriced,
  };
}

/**
 * One bounded operator sentence, for an existing diagnostic surface.
 *
 * It goes in a detail string rather than a first-class status field because
 * `operational-readiness.schema.json` is closed at the root AND at `exposure_management`, so a new
 * field is a contract version bump coordinated across two repositories — deliberately not bundled
 * into a safety patch. The same bounded information is carried here today.
 *
 * Says "notional" and never "risk" or "loss", and names the price basis explicitly so the marked and
 * committed figures cannot be read as the same kind of number.
 */
export function residualNotionalSummary(view: ResidualNotionalView): string {
  if (view.residualLegCount === 0) return "No unresolved residual exposure.";
  const marked =
    view.markedNotionalRupees === null
      ? `UNKNOWN (${view.markedUnknownReason ?? "not computable"})`
      : `₹${view.markedNotionalRupees.toLocaleString("en-IN")} at the last traded price`;
  const committed =
    view.committedNotionalRupees === null
      ? "UNKNOWN"
      : `₹${view.committedNotionalRupees.toLocaleString("en-IN")} at the acquisition price`;
  return (
    `Unresolved residual exposure: ${view.totalQuantity} contract(s) across ${view.residualLegCount} ` +
    `leg(s). Notional ${marked}; ${committed}. This is NOTIONAL, not a loss estimate and not a risk ` +
    `measure — an option position's loss can exceed or fall well below it, and nothing here computes ` +
    `which.`
  );
}
