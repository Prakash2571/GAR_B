/**
 * DEGRADED RECOVERY — reducing exposure when the WebSocket feed cannot be trusted.
 *
 * THE PROBLEM
 *
 * Every recovery path ultimately priced off `BoxQuoteStore`, which is WS-only by explicit construction
 * ("Executable books come exclusively from the shared Kite WebSocket; REST quotes are never admitted to
 * this store or its feed-health clock"). And every one of them was gated on a single global raw-tick
 * recency test, `engine.isFeedHealthy()`:
 *
 *   - automatic exit          — `positionMonitor.evaluatePosition` returns before doing anything
 *   - manual close            — `closeManually` refuses, and `stillWanted` re-checks mid-fill
 *   - emergency flatten       — reuses `closeManually` for every projected position
 *   - residual flatten        — the loop returns, and the per-token gate demands current WS depth
 *
 * So one quiet socket blocked every exit for every position, and `recoveryEscalation` — which is
 * explicit that it is "observability and operator alerting", not permission to act — reported an
 * incident that nothing could act on. Worse, because the monitor returned BEFORE reaching its liquidity
 * gate, an outage emitted no `EXIT_SKIPPED_LIQUIDITY` event and set no `exit_blocked_reason`: the
 * position simply went quiet. The only alarm that still fired was `EXPIRY_SAFETY`, whose own comment
 * concedes the point — "Only the EXECUTION of the exit needs a live book, and that is still gated
 * below."
 *
 * WHAT THIS MODULE IS
 *
 * Two pure pieces, and nothing else:
 *
 *   1. `admitRecoveryDepth()` — the ADMISSION TEST for a REST-sourced book. It is deliberately
 *      stricter than the WS path, not looser, and it is the only thing permitted to turn REST data
 *      into an executable reference price.
 *   2. `degradedRecoveryVerdict()` — the POLICY. Given feed state and what depth is actually
 *      available, it says whether a reduction may proceed, and when it may not it produces the exact
 *      blocker plus the broker-terminal instruction.
 *
 * Pure on purpose: no clock, no I/O, no store. The caller supplies `now`. That makes every rule here
 * testable without a feed, a database or a broker.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE MUST NEVER DO. These are the failure modes it exists to prevent.
 *
 *   · NEVER use LTP as an executable price. `kite.getQuoteDepth()` substitutes `last` for a missing
 *     touch (`const bid = v.depth?.buy?.[0]?.price ?? last`), which manufactures a two-sided price for
 *     an instrument that is not quoted. The correct Zerodha REST source is `getQuoteLadder()`, which
 *     does not. `brokers/quoteProvider.ts` already documents this trap for the entry path — "reporting
 *     0 is honest here — inventing the LTP as a two-sided price would make an unquoted instrument look
 *     executable" — and the same rule holds here.
 *   · NEVER admit REST data into `BoxQuoteStore` or into the feed-health clock. Entry coherence depends
 *     on that store meaning exactly one thing. REST depth lives in its own store with `source: "rest"`
 *     and its own observation stamp.
 *   · NEVER treat a cached price as a fresh quote. Freshness is measured from the observation stamp
 *     against a max age that is TIGHTER than the entry path's, because a reduction priced off stale
 *     depth is a market order in disguise.
 *   · NEVER widen entry freshness. `admitRecoveryDepth` is reachable only for a reduction.
 *   · NEVER enable unrestricted MARKET orders. A reference price still produces a bounded LIMIT
 *     through `orderPricing.computeLimitPrice`, including its one-tick floor.
 *   · NEVER promise flatness because recovery was requested. Every refusal here names the exposure as
 *     unresolved and still owned.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { OrderSide } from "./types.js";

/** One price level. Structurally identical to the WS shape so `walkDepth` can consume it unchanged. */
export interface RecoveryDepthLevel {
  readonly price: number;
  readonly qty: number;
}

/**
 * A REST-sourced book for one instrument.
 *
 * `source` is a literal rather than a boolean so a WS book cannot be passed here by accident, and so a
 * future third source has to be added deliberately.
 */
export interface RecoveryDepthObservation {
  readonly source: "rest";
  /** Which broker produced it. Checked against the active broker — a book from the wrong one is void. */
  readonly broker: string;
  /** The account the fetching credential belongs to, or null when it cannot be proven. */
  readonly account: string | null;
  readonly token: number;
  readonly tradingsymbol: string;
  /** Wall clock when the fetch COMPLETED. Never an exchange timestamp the REST payload did not carry. */
  readonly observed_at: number;
  readonly bids: readonly RecoveryDepthLevel[];
  readonly asks: readonly RecoveryDepthLevel[];
}

/** Why a REST book may not be used. Each maps to a distinct operator-facing sentence. */
export type RecoveryDepthRefusal =
  | "no_observation"
  | "wrong_source"
  | "wrong_broker"
  | "wrong_account"
  | "wrong_instrument"
  | "unusable_observation_time"
  | "stale_observation"
  | "no_relevant_side_depth"
  | "insufficient_quantity"
  | "unbounded_limit";

export interface RecoveryDepthAdmission {
  readonly admitted: boolean;
  readonly refusal: RecoveryDepthRefusal | null;
  readonly detail: string | null;
  /** The touch on the REDUCING side, only when admitted. */
  readonly reference_price: number | null;
  /** Quantity available at or better than `limit_price`, only when admitted. */
  readonly executable_quantity: number | null;
  /** Age of the observation at the moment of the decision, for the audit trail. */
  readonly observation_age_ms: number | null;
}

function refuse(
  refusal: RecoveryDepthRefusal,
  detail: string,
  ageMs: number | null = null,
): RecoveryDepthAdmission {
  return {
    admitted: false,
    refusal,
    detail,
    reference_price: null,
    executable_quantity: null,
    observation_age_ms: ageMs,
  };
}

/** A level is usable only with a real positive price AND a real positive integer size. */
function usableLevels(levels: readonly RecoveryDepthLevel[]): RecoveryDepthLevel[] {
  return levels.filter(
    (l) =>
      Number.isFinite(l.price) && l.price > 0 && Number.isSafeInteger(l.qty) && l.qty > 0,
  );
}

/**
 * MAY THIS REST BOOK PRICE THIS REDUCTION?
 *
 * Every check is a refusal, never a warning, and the order is deliberate: identity before content, so a
 * book for the wrong instrument can never be examined for depth and accidentally accepted on it.
 *
 * `side` is the side of the ORDER being sent — the reducing side. A reducing BUY consumes asks; a
 * reducing SELL consumes bids. Reading the wrong side would price against the spread and look
 * executable when it is not, which is the single easiest way to get this wrong.
 */
export function admitRecoveryDepth(args: {
  readonly observation: RecoveryDepthObservation | null | undefined;
  /** The instrument the order is for. Both fields are checked; a token alone can be recycled. */
  readonly token: number;
  readonly tradingsymbol: string;
  /** The broker this process is currently executing through. */
  readonly activeBroker: string;
  /**
   * The account the order will be sent under, or null when unproven.
   *
   * Mirrors `dispatchAccountBlockReason`: a refusal needs POSITIVE PROOF of difference. An unproven
   * account on either side is "cannot tell" and does not refuse, because a refused reduction strands
   * exposure. A KNOWN different account does refuse — a book fetched with another account's credential
   * is not evidence about this one.
   */
  readonly dispatchAccount: string | null;
  readonly side: OrderSide;
  readonly quantity: number;
  /** The bounded LIMIT the order will carry. Quantity is counted at or better than this only. */
  readonly limitPrice: number;
  readonly now: number;
  /** Tighter than the entry path's `quoteMaxAgeMs`, deliberately. */
  readonly maxObservationAgeMs: number;
}): RecoveryDepthAdmission {
  const o = args.observation;
  if (o === null || o === undefined) {
    return refuse(
      "no_observation",
      `no REST depth observation exists for ${args.tradingsymbol}, so no reference price can be` +
        " established without inventing one",
    );
  }
  if (o.source !== "rest") {
    return refuse(
      "wrong_source",
      `the depth observation for ${args.tradingsymbol} is not REST-sourced; the degraded path must not` +
        " silently consume the WebSocket store, whose freshness clock is the one that is unhealthy",
    );
  }
  if (o.broker !== args.activeBroker) {
    return refuse(
      "wrong_broker",
      `the REST depth for ${args.tradingsymbol} came from ${o.broker} but orders are being sent` +
        ` through ${args.activeBroker}; a book from another broker is not evidence about this one`,
    );
  }
  // Positive proof of a different account only. See the `dispatchAccount` docblock.
  if (o.account !== null && args.dispatchAccount !== null && o.account !== args.dispatchAccount) {
    return refuse(
      "wrong_account",
      `the REST depth for ${args.tradingsymbol} was fetched with account ${o.account} but the order` +
        ` would be sent under ${args.dispatchAccount}`,
    );
  }
  if (o.token !== args.token || o.tradingsymbol !== args.tradingsymbol) {
    return refuse(
      "wrong_instrument",
      `the REST depth observation is for ${o.tradingsymbol} (token ${o.token}) but the order is for` +
        ` ${args.tradingsymbol} (token ${args.token})`,
    );
  }
  if (!Number.isFinite(o.observed_at) || o.observed_at <= 0) {
    return refuse(
      "unusable_observation_time",
      `the REST depth for ${args.tradingsymbol} carries no usable observation time, so its freshness` +
        " cannot be established and it must not be treated as current",
    );
  }
  const age = args.now - o.observed_at;
  if (!Number.isFinite(age) || age < 0) {
    // A future-dated observation means the clocks disagree. Refuse rather than guess which is right.
    return refuse(
      "unusable_observation_time",
      `the REST depth for ${args.tradingsymbol} is stamped ${Math.abs(age)}ms in the FUTURE, which` +
        " means the clocks disagree; it must not be trusted as fresh",
      age,
    );
  }
  if (age > args.maxObservationAgeMs) {
    return refuse(
      "stale_observation",
      `the REST depth for ${args.tradingsymbol} was observed ${age}ms ago, beyond the` +
        ` ${args.maxObservationAgeMs}ms degraded-recovery limit. An expired cached price is not a` +
        " fresh quote, and pricing a reduction off one is a market order in disguise",
      age,
    );
  }

  // The REDUCING side. A reducing BUY consumes asks; a reducing SELL consumes bids.
  const levels = usableLevels(args.side === "BUY" ? o.asks : o.bids);
  if (levels.length === 0) {
    return refuse(
      "no_relevant_side_depth",
      `the REST depth for ${args.tradingsymbol} has no usable ${args.side === "BUY" ? "ask" : "bid"}` +
        " side (every level lacks a real price or a real size). There is nothing to reduce into, and" +
        " the last traded price is NOT a substitute for an executable book",
      age,
    );
  }
  const touch = levels[0];
  if (touch === undefined) {
    return refuse("no_relevant_side_depth", `no touch price for ${args.tradingsymbol}`, age);
  }

  if (!Number.isFinite(args.limitPrice) || args.limitPrice <= 0) {
    return refuse(
      "unbounded_limit",
      `the order for ${args.tradingsymbol} has no bounded positive limit price, so it must not be sent` +
        " — an unbounded reduction is a market order, which this path never enables",
      age,
    );
  }

  // Count only what is executable AT OR BETTER THAN the bounded limit. Depth beyond the limit is not
  // available to this order and counting it would overstate what can be reduced.
  let executable = 0;
  for (const level of levels) {
    const within = args.side === "BUY" ? level.price <= args.limitPrice : level.price >= args.limitPrice;
    if (!within) break;
    executable += level.qty;
  }
  if (!Number.isSafeInteger(args.quantity) || args.quantity <= 0) {
    return refuse(
      "insufficient_quantity",
      `the order for ${args.tradingsymbol} has no usable quantity (${args.quantity})`,
      age,
    );
  }
  if (executable < args.quantity) {
    return refuse(
      "insufficient_quantity",
      `the REST depth for ${args.tradingsymbol} offers ${executable} within the bounded limit of` +
        ` ${args.limitPrice}; the reduction needs ${args.quantity}`,
      age,
    );
  }

  return {
    admitted: true,
    refusal: null,
    detail: null,
    reference_price: touch.price,
    executable_quantity: executable,
    observation_age_ms: age,
  };
}

/* ══════════════════════════════════ the policy ══════════════════════════════════ */

/** What the WS feed is doing, as the engine already knows it. */
export type FeedCondition = "healthy" | "unhealthy";

/** Whether a broker can supply REST depth good enough to price a reduction. */
export interface RecoveryDepthCapability {
  /** The broker exposes a depth endpoint that does NOT substitute LTP for a missing touch. */
  readonly supported: boolean;
  /** The operator has enabled the degraded path. Off ⇒ report honestly, execute nothing. */
  readonly enabled: boolean;
  /** Why, when not supported or not enabled. Shown to the operator verbatim. */
  readonly detail: string;
}

export type DegradedRecoveryDecision =
  /** The WS feed is healthy; the ordinary path applies and this module has no opinion. */
  | { readonly kind: "normal" }
  /** The WS feed is unhealthy but a validated REST book can price this reduction. */
  | { readonly kind: "degraded"; readonly detail: string }
  /** Nothing trustworthy is available. `blocker` is the operator-facing sentence. */
  | { readonly kind: "blocked"; readonly blocker: string; readonly needs_broker_terminal: boolean };

/**
 * MAY A REDUCTION PROCEED RIGHT NOW?
 *
 * Only ever consulted for a REDUCTION. New entry is not a caller of this function and must not become
 * one: entry needs four-leg coherence and full readiness, and a degraded feed can never justify
 * creating a new box. `streamHealthPolicy.ts` already encodes that asymmetry as a table
 * (`DEGRADED → newEntry: false, exitAndReduce: true`); this is the runtime gate that was missing.
 *
 * The `blocked` branch always names the broker terminal, because that is the only remaining route when
 * this process cannot price a reduction. Saying so is the difference between an honest degraded state
 * and a silent one — and a silent one is what the monitor used to produce, returning before it reached
 * any gate that would set `exit_blocked_reason`.
 */
export function degradedRecoveryVerdict(args: {
  readonly marketOpen: boolean;
  readonly feed: FeedCondition;
  readonly capability: RecoveryDepthCapability;
  /** The admission verdict for this specific instrument, when one was sought. */
  readonly admission: RecoveryDepthAdmission | null;
  readonly tradingsymbol: string;
}): DegradedRecoveryDecision {
  if (!args.marketOpen) {
    return {
      kind: "blocked",
      blocker:
        `the exchange is closed, so no reduction can be worked for ${args.tradingsymbol}. The position` +
        " is unchanged, still owned and still monitored; it will be re-attempted when the market opens.",
      // Not a broker-terminal case: nobody can trade a closed exchange.
      needs_broker_terminal: false,
    };
  }
  if (args.feed === "healthy") return { kind: "normal" };

  // From here the WS feed is unhealthy and we are deciding whether REST can stand in.
  if (!args.capability.supported) {
    return {
      kind: "blocked",
      blocker:
        `the market-data feed is unhealthy and this broker cannot supply REST depth that is safe to` +
        ` price a reduction against, so ${args.tradingsymbol} CANNOT be reduced by this process.` +
        ` ${args.capability.detail} The exposure is unresolved and still owned. Reduce it at the` +
        " broker terminal.",
      needs_broker_terminal: true,
    };
  }
  if (!args.capability.enabled) {
    return {
      kind: "blocked",
      blocker:
        `the market-data feed is unhealthy and degraded REST-priced recovery is not enabled, so` +
        ` ${args.tradingsymbol} CANNOT be reduced by this process. ${args.capability.detail} The` +
        " exposure is unresolved and still owned. Reduce it at the broker terminal, or enable the" +
        " degraded path if its limitations are understood.",
      needs_broker_terminal: true,
    };
  }
  if (args.admission === null) {
    return {
      kind: "blocked",
      blocker:
        `the market-data feed is unhealthy and no REST depth was obtained for ${args.tradingsymbol}, so` +
        ` no reference price exists and it CANNOT be reduced by this process. The exposure is` +
        " unresolved and still owned. Reduce it at the broker terminal.",
      needs_broker_terminal: true,
    };
  }
  if (!args.admission.admitted) {
    return {
      kind: "blocked",
      blocker:
        `the market-data feed is unhealthy and the REST depth for ${args.tradingsymbol} was REFUSED, so` +
        ` it CANNOT be reduced by this process: ` +
        `${args.admission.detail ?? args.admission.refusal ?? "unusable"}. Nothing was sent. The` +
        " exposure is unresolved and still owned. If this does not clear, reduce it at the broker" +
        " terminal.",
      needs_broker_terminal: true,
    };
  }
  return {
    kind: "degraded",
    detail:
      `the WebSocket feed is unhealthy, so ${args.tradingsymbol} is being priced from REST depth` +
      ` observed ${args.admission.observation_age_ms}ms ago (touch ${args.admission.reference_price},` +
      ` ${args.admission.executable_quantity} available within the bounded limit). New entry stays` +
      " blocked. This is a DEGRADED reduction, not a normal one.",
  };
}

/** The published projection, so the operator can see the degraded path's state without inferring it. */
export interface DegradedRecoveryStatus {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly detail: string;
  /** True while the WS feed is unhealthy and reductions are therefore on the degraded assessment. */
  readonly active: boolean;
  /** Instruments currently blocked from reduction, with the reason. Bounded by the caller. */
  readonly blocked: readonly { readonly tradingsymbol: string; readonly reason: string }[];
}

export function degradedRecoveryStatus(args: {
  readonly capability: RecoveryDepthCapability;
  readonly feed: FeedCondition;
  readonly blocked: readonly { readonly tradingsymbol: string; readonly reason: string }[];
}): DegradedRecoveryStatus {
  return {
    supported: args.capability.supported,
    enabled: args.capability.enabled,
    detail: args.capability.detail,
    active: args.feed === "unhealthy",
    blocked: args.blocked,
  };
}
