/**
 * THE PLANNED-MARGIN EVIDENCE PROVIDER — the single choke point between a broker's basket-margin
 * adapter and the live-entry admission gate.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * This logic decides whether a broker's margin answer is EVIDENCE or merely a number, and it was
 * previously an inline closure inside `BoxEngine`'s dependency literal. That made it unreachable
 * from a test without constructing the whole engine (and therefore a database), so the only
 * coverage it could have was a re-implementation in a test file — which is exactly the kind of
 * "test" that keeps passing while production changes underneath it. Both defects it now guards
 * against shipped under those conditions:
 *
 *   * DEFECT A — an INCOMPLETE figure was accepted. The Dhan per-leg fallback could return a sum
 *     over 1 of 4 legs, shaped identically to a complete four-leg sum, and the only rejection here
 *     was `source === "unavailable"`. A partial sum UNDER-states the requirement.
 *
 *   * DEFECT B — `Number.isFinite(basket.initial)` was used as a PRESENCE test. It is not one:
 *     a fabricated `0` is finite. A broker that never reported an execute-the-orders margin
 *     produced `initialMarginRupees: 0`, which the stage model read as an established requirement
 *     of nothing and then reduced to the gross option premium.
 *
 * THE CONTRACT, in one sentence: `null` means UNKNOWN and never zero, and an incomplete figure is
 * not evidence at all.
 */

import type { BoxMarginOrder, BoxMarginProvider } from "./brokerContext.js";

/** The subset of a `BrokerOrderRequest` this provider needs. */
export interface PlannedMarginRequestLike {
  readonly exchange: string;
  readonly tradingsymbol: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
  readonly pricing: { readonly limit_price: number };
}

/**
 * What the admission gate consumes.
 *
 * Every rupee field is nullable, and `null` uniformly means "not established". No field here may
 * be defaulted to 0 by a consumer.
 */
export interface PlannedMarginObservation {
  /** The headline requirement (₹), or null when no usable figure exists. */
  readonly marginRupees: number | null;
  readonly observedAt: number;
  /** Margin to EXECUTE the orders (₹). Null = UNKNOWN. Never 0-for-missing. */
  readonly initialMarginRupees?: number | null;
  /** Margin to HOLD the completed hedged basket (₹). Null = UNKNOWN. */
  readonly finalMarginRupees?: number | null;
  /** ₹ already blocked on the account, when this source can observe it (it cannot). */
  readonly encumbranceRupees?: number | null;
}

/** Map the four entry requests onto the broker-neutral margin-order shape. */
export function marginOrdersForRequests(
  requests: readonly PlannedMarginRequestLike[],
): BoxMarginOrder[] {
  return requests.map((r) => ({
    exchange: r.exchange,
    tradingsymbol: r.tradingsymbol,
    transaction_type: r.side,
    variety: "regular",
    product: "NRML",
    order_type: "LIMIT",
    quantity: r.quantity,
    price: r.pricing.limit_price,
    reference_price: r.pricing.limit_price,
  }));
}

/**
 * Build the production `plannedMargin` evidence provider over a broker margin provider.
 *
 * `now` is injectable only so tests can pin the observation stamp; production passes `Date.now`.
 */
export function createPlannedMarginProvider(args: {
  readonly margins: BoxMarginProvider;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}): (requests: readonly PlannedMarginRequestLike[]) => Promise<PlannedMarginObservation> {
  const now = args.now ?? (() => Date.now());
  const log = args.log ?? ((message: string) => console.warn(message));

  return async (requests) => {
    const orders = marginOrdersForRequests(requests);
    const basket = await args.margins.basketMargin(orders).catch(() => null);

    // FAIL CLOSED. Four independent ways this can fail to be evidence, and all four must produce
    // the SAME "no figure" outcome so the gate cannot be admitted on a partial or fabricated one:
    //   1. the read threw                          → basket is null
    //   2. the adapter reported no figure           → source "unavailable"
    //   3. the figure covers only part of the basket → complete !== true   (DEFECT A)
    //   4. there is no usable total                 → total null / non-finite
    //
    // "unavailable" is an HONEST no-figure, not a zero. An INCOMPLETE figure may still be
    // DISPLAYED with its label (see `BoxEngine.captureMargin`), but it must not authorise new
    // exposure, so here it is surfaced to the gate as missing.
    // FAIL CLOSED. Five independent ways this can fail to be evidence, and all five must produce
    // the SAME "no figure" outcome so the gate cannot be admitted on a partial or fabricated one:
    //   1. the read threw                           → basket is null
    //   2. the adapter reported no figure            → source "unavailable"
    //   3. the figure covers only part of the basket → complete !== true   (DEFECT A)
    //   4. there is no usable total                  → total null / non-finite
    //   5. the total is NON-POSITIVE                 → not a credible requirement
    //
    // (5) is the broker-agnostic backstop, and it belongs here rather than only in each adapter.
    // A four-leg box always contains SHORT options, so a requirement of ₹0 is never real — it is
    // what a fabricated stand-in or a misread payload looks like. `Number.isFinite(0)` is true and
    // `available_funds < 0` is false, so without this test a ₹0 total would be reported as
    // broker-confirmed evidence AND would satisfy funds-cover against any balance. The stage model
    // rejects non-positive figures one layer above, but the two weaker controls
    // (BOX_LIVE_REQUIRE_FUNDS_COVER / BOX_LIVE_REQUIRE_MARGIN_EVIDENCE) are configurable on their
    // own, so the boundary has to hold this itself.
    if (
      !basket ||
      basket.source === "unavailable" ||
      basket.complete !== true ||
      basket.total === null ||
      !Number.isFinite(basket.total) ||
      !(basket.total > 0)
    ) {
      if (basket && basket.complete !== true && basket.incomplete_reason !== null) {
        log(
          "[Box] planned-margin evidence is INCOMPLETE and will not authorise entry: " +
            `${basket.incomplete_reason} (source=${basket.source}, ` +
            `legs ${basket.legs_priced}/${basket.legs_requested})`,
        );
      } else if (basket && basket.complete === true && basket.total !== null && !(basket.total > 0)) {
        log(
          `[Box] planned-margin evidence REFUSED: ${basket.source} reported a complete basket with ` +
            `a non-positive total (₹${basket.total}). A four-leg box contains short options, so ` +
            "this is not a credible requirement and will not authorise entry.",
        );
      }
      return { marginRupees: null, observedAt: now() };
    }

    // SECTION 8. `initial` and `final` are passed through SEPARATELY and are never collapsed here.
    // Zerodha documents `initial` as the margin required to execute the orders and `final` as the
    // margin with the spread benefit; the stage model needs both, because while legging the spread
    // benefit does not exist yet. Dhan publishes no equivalent of `initial`, so it arrives as null
    // and the stage model refuses rather than inventing a figure. `total` is retained for the
    // existing single-figure margin control, unchanged.
    return {
      marginRupees: basket.total,
      observedAt: now(),
      // PASSED THROUGH, NOT PROBED — see the module header on why `Number.isFinite` is not a
      // presence test.
      initialMarginRupees: basket.initial,
      finalMarginRupees: basket.final,
      // NULL HERE, AND THAT IS CORRECT RATHER THAN A GAP. The basket-margin endpoint prices a
      // hypothetical basket and does not report what is already blocked on the account. The
      // encumbrance arrives from the FUNDS provider, which is the endpoint that reports it — and
      // which also supplies `available`, so the two are read from one response and cannot
      // disagree. The gateway prefers the funds-derived value and falls back to this only if a
      // future provider can supply it.
      encumbranceRupees: null,
    };
  };
}
