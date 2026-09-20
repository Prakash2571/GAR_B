/**
 * THE PER-LEG QUANTITY BOUND — expressible in UNITS or in LOTS, because a universe has both.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `BOX_LIVE_MAX_OPEN_LEG_QUANTITY` is an ABSOLUTE UNIT ceiling. That works perfectly for a trial
 * pinned to one underlying: set it to that instrument's lot size and it means "one lot".
 *
 * It stops working the moment the allowlist is opened up. Exchange lot sizes differ by an order of
 * magnitude across the F&O universe, so a single unit number cannot mean "one lot" for more than one
 * instrument at a time. An operator who empties `BOX_LIVE_ALLOWED_UNDERLYINGS` to trade any name —
 * with the blocklist as the exclusion mechanism, which is a perfectly coherent posture — finds that
 * a cap sized for one instrument silently refuses almost every other one as
 * `lot_exceeds_quantity_cap`. The configuration reads like "one lot" and behaves like "one specific
 * instrument".
 *
 * Raising the unit cap to cover the largest lot in the universe is not a fix: it stops being a
 * one-lot bound for everything smaller, which is the entire population.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE FIX: A SECOND, LOT-RELATIVE BOUND ALONGSIDE THE ABSOLUTE ONE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   `BOX_LIVE_MAX_OPEN_LEG_QUANTITY`  an absolute UNIT ceiling. Always >= 1 in live.
 *   `BOX_LIVE_MAX_LOTS_PER_LEG`       a LOT-RELATIVE ceiling.   0 = disabled (the default).
 *
 * Both are enforced and whichever is TIGHTER for the instrument in hand wins:
 *
 *   units=65,  lots=0   the shipped behaviour, unchanged. One instrument at a time.
 *   units=900, lots=1   THE ANY-UNDERLYING POSTURE. "One lot of whatever this instrument is, and
 *                       never more than 900 units on a leg however large that lot turns out to be."
 *                       The unit cap stops being the thing that means "one lot" and becomes what it
 *                       should always have been: an absolute backstop against a surprise.
 *
 * THE UNIT CAP IS DELIBERATELY NOT DISABLEABLE, and this is a safety finding rather than a style
 * choice. `BoxOrderManager.queuedActionBlockReason` gates a queued REDUCTION on
 * `request.quantity <= maxOpenLegQuantity`. A cap of 0 would therefore refuse to send exits and
 * strand real exposure — the worst outcome in this system. `liveMaxOpenLegQuantity` is consequently
 * clamped to a minimum of 1, the lot-relative bound is ADDITIVE rather than a replacement, and no
 * reduction path needed to change for any of this.
 *
 * WHY THIS IS NOT A LOOSENING BY DEFAULT. `BOX_LIVE_MAX_LOTS_PER_LEG` defaults to 0, so a deployment
 * that does not set it behaves exactly as before, cap for cap. The lot-relative bound only ever
 * applies because an operator asked for it — and asking for it is strictly TIGHTER than the
 * alternative they would otherwise be pushed towards, which is raising the unit cap high enough for
 * the biggest lot in the universe and thereby permitting many lots of everything smaller.
 *
 * WHERE EACH BOUND IS ENFORCED, and why they differ. The lot-relative bound needs the instrument's
 * lot size, so it is enforced in the coordinator's admission prologue, which holds the candidate. The
 * order manager's send-boundary check keeps the absolute unit backstop only: at that layer a request
 * carries a quantity but not the lot size it came from, and inferring "how many lots is this?" from
 * the quantity alone would be circular.
 *
 * WHAT STILL BOUNDS THE MONEY. Nothing here is a rupee control, and a lot-relative bound deliberately
 * admits wildly different notional across instruments: one lot of a ₹3,000 stock and one lot of a
 * ₹60 stock are not comparable risk. `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` is the monetary containment
 * and is REQUIRED in live (`config.ts` refuses boot without it). On a multi-underlying posture it,
 * not the quantity caps, is the control that matters — which is worth saying out loud, because a
 * quantity cap is the one people look at.
 */

/** Four legs to a box. Local so this module stays dependency-free. */
export const ENVELOPE_LEG_COUNT = 4;

export interface QuantityEnvelopeInput {
  /** One lot of the instrument in hand, from the INSTRUMENT MASTER. Never assumed. */
  readonly lotSize: number;
  /** `BOX_LIVE_MAX_OPEN_LEG_QUANTITY`. 0 disables. */
  readonly perLegUnitCap: number;
  /** `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY`. 0 disables. */
  readonly grossUnitCap: number;
  /** `BOX_LIVE_MAX_LOTS_PER_LEG`. 0 disables. */
  readonly maxLotsPerLeg: number;
  /** Units actually intended on each leg. Defaults to one lot. */
  readonly quantityPerLeg?: number;
}

export interface QuantityEnvelopeVerdict {
  /** Whether this quantity may be sent on each of the four legs. */
  readonly admits: boolean;
  /** Units intended per leg. */
  readonly quantityPerLeg: number;
  /** Units across all four legs. */
  readonly gross: number;
  /**
   * The effective per-leg allowance in UNITS — the tighter of the two configured bounds, or null
   * when neither is configured (no per-leg bound at all).
   */
  readonly perLegLimit: number | null;
  /** Which bound produced `perLegLimit`. */
  readonly perLegLimitSource: "unit_cap" | "lots" | "none";
  /** A refusal an operator can act on, or null when the quantity is admissible. */
  readonly refusal: string | null;
}

/**
 * Evaluate one leg quantity against both bounds.
 *
 * Pure and synchronous: it is consulted inside the coordinator's no-await admission prologue as well
 * as at the order manager's send boundary, and having ONE derivation is what stops the cheap early
 * refusal and the authoritative late one disagreeing about the same instrument.
 */
export function evaluateQuantityEnvelope(input: QuantityEnvelopeInput): QuantityEnvelopeVerdict {
  const lotSize = Math.max(0, Math.floor(input.lotSize));
  const quantityPerLeg = Math.max(0, Math.floor(input.quantityPerLeg ?? lotSize));
  const gross = quantityPerLeg * ENVELOPE_LEG_COUNT;

  const unitCap = input.perLegUnitCap > 0 ? input.perLegUnitCap : null;
  // A lot-relative allowance needs a lot size to mean anything. With no lot size the bound simply
  // does not apply, rather than silently becoming 0 and refusing everything.
  const lotsCap = input.maxLotsPerLeg > 0 && lotSize > 0 ? input.maxLotsPerLeg * lotSize : null;

  let perLegLimit: number | null;
  let perLegLimitSource: "unit_cap" | "lots" | "none";
  if (unitCap !== null && lotsCap !== null) {
    // BOTH configured ⇒ the tighter governs. This is the belt-and-braces posture.
    perLegLimit = Math.min(unitCap, lotsCap);
    perLegLimitSource = perLegLimit === lotsCap ? "lots" : "unit_cap";
  } else if (unitCap !== null) {
    perLegLimit = unitCap;
    perLegLimitSource = "unit_cap";
  } else if (lotsCap !== null) {
    perLegLimit = lotsCap;
    perLegLimitSource = "lots";
  } else {
    perLegLimit = null;
    perLegLimitSource = "none";
  }

  let refusal: string | null = null;
  if (perLegLimit !== null && quantityPerLeg > perLegLimit) {
    refusal =
      perLegLimitSource === "lots"
        ? `${quantityPerLeg} unit(s) per leg exceeds BOX_LIVE_MAX_LOTS_PER_LEG=${input.maxLotsPerLeg} ` +
          `x a lot of ${lotSize} = ${perLegLimit} unit(s). The bound is expressed in LOTS, so it ` +
          `follows this instrument's lot size rather than a fixed unit count.`
        : `one lot of this instrument is ${lotSize} unit(s)` +
          (quantityPerLeg !== lotSize ? ` and ${quantityPerLeg} unit(s) are intended per leg` : "") +
          `, above BOX_LIVE_MAX_OPEN_LEG_QUANTITY=${input.perLegUnitCap}. No leg of this box can be ` +
          `sent. If you intend to trade whatever one lot happens to be across several underlyings, ` +
          `set BOX_LIVE_MAX_LOTS_PER_LEG=1 (a lot-relative bound) instead of raising this unit cap — ` +
          `a single unit number cannot mean "one lot" for instruments with different lot sizes.`;
  } else if (input.grossUnitCap > 0 && gross > input.grossUnitCap) {
    refusal =
      `four legs of ${quantityPerLeg} unit(s) need ${gross} unit(s), above ` +
      `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=${input.grossUnitCap}. A Box is four legs, so this ` +
      `ceiling must be at least 4x the per-leg allowance you intend to carry.`;
  }

  return { admits: refusal === null, quantityPerLeg, gross, perLegLimit, perLegLimitSource, refusal };
}
