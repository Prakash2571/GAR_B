/**
 * BROKER ORDER SNAPSHOT MERGE — the one place that decides which of two observations of the SAME
 * order is authoritative, field by field.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS CLOSES (lost update / REST-overwrites-WebSocket)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Both live adapters keep the session projection in a `Map<client_order_id, BrokerOrder>`. The
 * WebSocket path (`applyOrderUpdate`) is SYNCHRONOUS: it reads the map, merges, and writes back
 * within a single JS tick, so it is atomic. Every REST path, by contrast, was two-phase across an
 * `await`:
 *
 *     const known = this.orders.get(id);        // (1) snapshot taken
 *     const raw   = await transport.getOrder();  // (2) ... a stream event can land HERE ...
 *     const next  = project(known, raw);         // (3) merged against the STALE snapshot
 *     this.orders.set(id, next);                 // (4) unconditional clobber
 *
 * Reproduced consequence: cached cumulative fill 30 → REST read starts → stream reports 75 →
 * the older REST response reports CANCELLED/30 → the adapter caches CANCELLED/30 and returns it.
 * The 75 is gone: exposure is under-reported, an unwind is undersized, and a hedge-release
 * decision is made against a short that is more closed than we believe.
 *
 * Dhan's pre-existing monotonic comparison did not close this race because it compared against
 * the same stale `known` captured before TWO awaits (order read + trade-book read).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Adapters must re-read the map AFTER their last await and merge through this function, then write
 * back — all without an intervening `await`. That read/merge/write is then atomic with respect to
 * `applyOrderUpdate` for the same reason `applyOrderUpdate` itself is safe, and no versioning or
 * locking is required. `mergeBrokerOrderSnapshot` is PURE and total so the ordering guarantee is
 * the caller's only obligation.
 *
 * WHAT IS PRESERVED (quantity alone is NOT sufficient — see the field-by-field rules below):
 *   • cumulative filled quantity — monotonic, never rewound
 *   • average price — never the average of an OLDER, SMALLER fill applied to a LARGER accepted
 *     cumulative quantity; absent price for an advanced fill yields NULL plus the existing
 *     `pending_price` accounting marker, never a fabricated or carried-over number
 *   • execution evidence quality — downgraded to `pending_price` when exposure outruns price
 *   • fills — the array consistent with the accepted quantity; never concatenated, so a repeated
 *     observation cannot double-count
 *   • pending quantity — always recomputed from the accepted quantity
 *   • broker identity — a learned broker_order_id is kept; a CONFLICTING one is a hard conflict
 *   • terminal state — a stale/working observation can never reopen a confirmed terminal order,
 *     while a genuine LATE FILL or better evidence after cancellation is still accepted
 *
 * Contradictions that cannot be reconciled (e.g. REJECTED asserting no execution against a
 * confirmed positive fill) are NOT silently resolved: the merged order is placed in
 * RECONCILIATION_REQUIRED with a named reason, which is this codebase's existing recovery route.
 *
 * PURE and total: no clock, no config, no I/O, no broker SDK.
 */

import { isBrokerOrderTerminal, type BrokerFill, type BrokerOrder, type BrokerOrderState } from "./brokerAdapter.js";
import type { ExecutionEvidenceQuality } from "./brokerExecutionEvidence.js";

/** Result of merging a freshly observed snapshot onto the currently cached one. */
export interface BrokerOrderMerge {
  /** The authoritative order to cache and return. */
  readonly order: BrokerOrder;
  /**
   * Non-null when the two observations asserted mutually exclusive facts and the merge fell back
   * to RECONCILIATION_REQUIRED. Callers should surface this (audit/log); they must not discard it.
   */
  readonly conflict: string | null;
  /**
   * True when the candidate reported a LOWER cumulative quantity than was already held, i.e. it is
   * provably an older observation. Useful for adapter telemetry.
   */
  readonly candidateWasStale: boolean;
  /** True when the candidate advanced the cumulative quantity. */
  readonly candidateAdvancedFill: boolean;
}

/** Extra facts about the candidate that its projected fields cannot express. */
export interface BrokerOrderMergeOptions {
  /**
   * The cumulative quantity the candidate's RAW payload actually reported, before any monotonic
   * carry-forward was applied to it.
   *
   * WHY THIS IS NEEDED. Both adapters project a raw broker row through `evaluateExecutionEvidence`,
   * which already floors the result at the prior observed quantity. So a payload saying
   * "CANCELLED, 30 filled, average 10" against a prior of 75 arrives here as
   * `filled_quantity: 75, average_price: 10` — the quantity is right but the PRICE describes only
   * the 30. Comparing `filled_quantity` alone cannot detect that, and adopting the price would use
   * the average of an older, smaller fill as the average of a larger accepted cumulative fill.
   *
   * Pass the raw reading:
   *   • a NUMBER  — what the payload said;
   *   • NULL      — the payload carried no cumulative quantity at all (absence is not zero), in
   *                 which case it is not treated as better price evidence than a fill we hold;
   *   • OMITTED   — the candidate is already raw-faithful (e.g. built directly from a stream
   *                 observation), so `filled_quantity` is compared directly.
   */
  readonly observedCumulativeQty?: number | null;
}

/** Deep-enough copy: `pricing` and `fills` are the only nested structures on BrokerOrder. */
export function cloneBrokerOrder(order: BrokerOrder): BrokerOrder {
  return {
    ...order,
    pricing: { ...order.pricing },
    fills: order.fills.map((fill) => ({ ...fill })),
  };
}

/** Progression rank for the WORKING states, used only to pick the more advanced of two labels. */
function workingRank(state: BrokerOrderState): number {
  switch (state) {
    case "CREATED": return 0;
    case "SUBMITTING": return 1;
    case "ACKNOWLEDGED": return 2;
    case "OPEN": return 3;
    case "PARTIALLY_FILLED": return 4;
    case "CANCEL_REQUESTED": return 5;
    // The uncertain pair are not a "stage"; they are handled explicitly before rank is consulted.
    case "UNKNOWN": return -1;
    case "RECONCILIATION_REQUIRED": return -1;
    default: return -1;
  }
}

function sumFilled(fills: readonly BrokerFill[]): number {
  let total = 0;
  for (const fill of fills) {
    if (Number.isFinite(fill.quantity) && fill.quantity > 0) total += fill.quantity;
  }
  return total;
}

function safeCumulative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Compare the candidate's own observation against the cached cumulative quantity.
 *
 * Returns >0 when the candidate advanced the fill, <0 when it is provably an older/smaller
 * observation, 0 when the two describe the same cumulative quantity.
 */
function compareObservation(
  options: BrokerOrderMergeOptions | undefined,
  candFilled: number,
  curFilled: number,
): number {
  if (options === undefined || !("observedCumulativeQty" in options)) {
    // Candidate is raw-faithful; its projected quantity IS its observation.
    return candFilled - curFilled;
  }
  const raw = options.observedCumulativeQty;
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    // The payload reported NO cumulative quantity. Absence is not zero and it is not evidence, so
    // it can never outrank a fill we already hold — but with nothing held there is nothing to lose.
    return curFilled > 0 ? -1 : 0;
  }
  return Math.max(0, Math.floor(raw)) - curFilled;
}

/**
 * Merge a freshly observed snapshot (`candidate`) onto the cached one (`current`).
 *
 * With no cached order there is nothing to lose, so the candidate is adopted as-is.
 */
export function mergeBrokerOrderSnapshot(
  current: BrokerOrder | undefined,
  candidate: BrokerOrder,
  options?: BrokerOrderMergeOptions,
): BrokerOrderMerge {
  if (!current) {
    return {
      order: cloneBrokerOrder(candidate),
      conflict: null,
      candidateWasStale: false,
      candidateAdvancedFill: safeCumulative(candidate.filled_quantity) > 0,
    };
  }

  // ── IDENTITY ───────────────────────────────────────────────────────────────────────────────
  // The map is keyed by client_order_id, so a mismatch here means a caller merged two different
  // orders. That is never a recoverable data question; refuse to blend them and keep the cached
  // order, which is the one the key belongs to.
  if (current.client_order_id !== candidate.client_order_id) {
    return {
      order: cloneBrokerOrder(current),
      conflict:
        `refused to merge snapshot for ${candidate.client_order_id} onto ${current.client_order_id}: ` +
        "client order identity mismatch",
      candidateWasStale: false,
      candidateAdvancedFill: false,
    };
  }

  const curFilled = safeCumulative(current.filled_quantity);
  const candFilled = safeCumulative(candidate.filled_quantity);
  const accepted = Math.max(curFilled, candFilled);

  // How the candidate's OWN observation compares with what we already hold. This — not the
  // already-floored `filled_quantity` — is what decides whether the candidate is better evidence.
  const comparison = compareObservation(options, candFilled, curFilled);
  const candidateWasStale = comparison < 0;
  const candidateAdvancedFill = comparison > 0;

  // The requested quantity is immutable for a given identity EXCEPT via a real modify, which the
  // fresh observation reports. A provably older observation may not rewrite it.
  const requested = candidateWasStale ? current.quantity : candidate.quantity;

  // ── BROKER IDENTITY ────────────────────────────────────────────────────────────────────────
  // Mirrors the durable attribution guard in repository.updateBoxOrderIntent: a broker id may be
  // LEARNED (null → value) but never REASSIGNED.
  let brokerConflict: string | null = null;
  let brokerOrderId: string | null;
  if (current.broker_order_id === null) {
    brokerOrderId = candidate.broker_order_id;
  } else if (candidate.broker_order_id === null || candidate.broker_order_id === current.broker_order_id) {
    brokerOrderId = current.broker_order_id;
  } else {
    brokerOrderId = current.broker_order_id;
    brokerConflict =
      `broker order id conflict for ${current.client_order_id}: ` +
      `cached ${current.broker_order_id} vs observed ${candidate.broker_order_id}`;
  }

  // ── PRICE ──────────────────────────────────────────────────────────────────────────────────
  // NEVER apply the average of an older, SMALLER fill to a larger accepted cumulative quantity.
  // When the advancing observation carries no price, exposure still stands and the price stays
  // NULL — the `pending_price` accounting marker below is how that is expressed, and the durable
  // reconciler is what resolves it. Inventing or carrying over a price would fabricate P&L.
  let averagePrice: number | null;
  if (accepted === 0) {
    averagePrice = null;
  } else if (candidateAdvancedFill) {
    averagePrice = candidate.average_price;
  } else if (candidateWasStale) {
    averagePrice = current.average_price;
  } else {
    // Same cumulative quantity: both describe the SAME fill, so either price is valid for it and
    // the newer observation may enrich a price we did not have.
    averagePrice = candidate.average_price ?? current.average_price;
  }

  // ── STATE ──────────────────────────────────────────────────────────────────────────────────
  const resolved = resolveState({
    current,
    candidate,
    accepted,
    requested,
    candidateWasStale,
  });

  // ── EVIDENCE QUALITY ───────────────────────────────────────────────────────────────────────
  const evidence = resolveEvidence({
    current,
    candidate,
    accepted,
    averagePrice,
    candidateWasStale,
    candidateAdvancedFill,
  });

  // ── FILLS ──────────────────────────────────────────────────────────────────────────────────
  const fills = resolveFills({
    winner: candidateWasStale ? current : candidate,
    other: candidateWasStale ? candidate : current,
    accepted,
    averagePrice,
  });

  // Structural base: the provably older observation may not supply enrichment fields
  // (tag, limit_price, pricing, reject metadata) either.
  const base = candidateWasStale ? current : candidate;

  const conflict = resolved.conflict ?? brokerConflict;
  const state = resolved.conflict !== null ? "RECONCILIATION_REQUIRED" : resolved.state;

  const merged: BrokerOrder = {
    ...base,
    // Immutable durable identity always comes from the cached order.
    client_order_id: current.client_order_id,
    broker_order_id: brokerOrderId,
    tag: base.tag ?? current.tag,
    quantity: requested,
    state,
    filled_quantity: accepted,
    pending_quantity: Math.max(0, requested - accepted),
    average_price: averagePrice,
    fills,
    reject_family: state === "REJECTED" ? (base.reject_family ?? current.reject_family) : null,
    reject_reason: conflict ?? (state === "REJECTED" ? (base.reject_reason ?? current.reject_reason) : base.reject_reason),
    created_at: current.created_at,
    // Never let the observation clock run backwards for this identity.
    updated_at: Math.max(current.updated_at, candidate.updated_at),
  };
  if (evidence !== undefined) merged.execution_evidence = evidence;
  else if (current.execution_evidence !== undefined) merged.execution_evidence = current.execution_evidence;

  return {
    order: merged,
    conflict,
    candidateWasStale,
    candidateAdvancedFill,
  };
}

/**
 * Decide the authoritative state.
 *
 * Two competing requirements are both mandatory:
 *   • a stale or still-working observation must NOT reopen a confirmed terminal order;
 *   • a genuine LATE FILL, or better evidence arriving after a cancellation, must NOT be frozen
 *     out — real filled quantity may never disappear.
 * The reconciliation between them is the accepted CUMULATIVE quantity, which is monotonic and
 * therefore cannot be argued with, rather than the status label, which can arrive out of order.
 */
function resolveState(args: {
  readonly current: BrokerOrder;
  readonly candidate: BrokerOrder;
  readonly accepted: number;
  readonly requested: number;
  readonly candidateWasStale: boolean;
}): { readonly state: BrokerOrderState; readonly conflict: string | null } {
  const { current, candidate, accepted, requested, candidateWasStale } = args;
  const curTerminal = isBrokerOrderTerminal(current.state);
  const candTerminal = isBrokerOrderTerminal(candidate.state);
  const id = current.client_order_id;

  // REJECTED asserts that NOTHING executed. Against a confirmed positive cumulative fill that is
  // not a stale label, it is a contradiction, and guessing which side is right is exactly what the
  // reconciler exists to avoid.
  const rejectedAgainstFill = (state: BrokerOrderState): boolean => state === "REJECTED" && accepted > 0;

  if (curTerminal && candTerminal) {
    if (current.state === candidate.state) {
      if (rejectedAgainstFill(current.state)) {
        return {
          state: "REJECTED",
          conflict: `${id} is REJECTED yet a cumulative fill of ${accepted} is confirmed; execution evidence conflicts`,
        };
      }
      return { state: current.state, conflict: null };
    }
    if (rejectedAgainstFill(current.state) || rejectedAgainstFill(candidate.state)) {
      return {
        state: "RECONCILIATION_REQUIRED",
        conflict:
          `conflicting terminal evidence for ${id}: cached ${current.state} vs observed ${candidate.state} ` +
          `with a confirmed cumulative fill of ${accepted}`,
      };
    }
    // A cancellation that raced a complete fill: once the accepted cumulative quantity covers the
    // whole request there is nothing left that could have been cancelled.
    if (accepted >= requested && (current.state === "COMPLETE" || candidate.state === "COMPLETE")) {
      return { state: "COMPLETE", conflict: null };
    }
    // Partially filled and then cancelled is an ordinary, fully consistent outcome.
    if (accepted < requested && (current.state === "CANCELLED" || candidate.state === "CANCELLED")) {
      return { state: "CANCELLED", conflict: null };
    }
    return {
      state: "RECONCILIATION_REQUIRED",
      conflict:
        `conflicting terminal evidence for ${id}: cached ${current.state} vs observed ${candidate.state} ` +
        `at cumulative fill ${accepted}/${requested}`,
    };
  }

  if (curTerminal && !candTerminal) {
    if (current.state === "REJECTED" && accepted > 0) {
      return {
        state: "RECONCILIATION_REQUIRED",
        conflict: `${id} is cached REJECTED but a cumulative fill of ${accepted} is now confirmed`,
      };
    }
    // A LATE FILL that completes a previously cancelled order is real and must be recorded.
    if (current.state === "CANCELLED" && accepted >= requested && requested > 0) {
      return { state: "COMPLETE", conflict: null };
    }
    // Otherwise a working/uncertain observation may enrich quantity and price but may NOT reopen
    // the order. This is what stops a stale OPEN from rewinding a confirmed COMPLETE.
    return { state: current.state, conflict: null };
  }

  if (!curTerminal && candTerminal) {
    if (candidate.state === "REJECTED" && accepted > 0) {
      return {
        state: "RECONCILIATION_REQUIRED",
        conflict: `${id} was observed REJECTED while holding a confirmed cumulative fill of ${accepted}`,
      };
    }
    if (candidate.state === "CANCELLED" && accepted >= requested && requested > 0) {
      // The remainder cannot have been cancelled: the accepted cumulative quantity is the whole
      // request. This is the reproduced race (cached 30, stream 75, older REST CANCELLED/30).
      return { state: "COMPLETE", conflict: null };
    }
    if (candidate.state === "COMPLETE" && accepted < requested) {
      return {
        state: "RECONCILIATION_REQUIRED",
        conflict:
          `${id} was observed COMPLETE but the confirmed cumulative fill is ${accepted} of ${requested}`,
      };
    }
    return { state: candidate.state, conflict: null };
  }

  // ── Neither is terminal ───────────────────────────────────────────────────────────────────
  // RECONCILIATION_REQUIRED means a snapshot could not support the state it claimed. That is a
  // fail-safe signal and it is sticky until the reconciler clears it.
  if (current.state === "RECONCILIATION_REQUIRED" || candidate.state === "RECONCILIATION_REQUIRED") {
    return { state: "RECONCILIATION_REQUIRED", conflict: null };
  }
  if (candidateWasStale) {
    // Provably an older observation: keep the cached label, but never present a state that
    // contradicts the accepted quantity.
    if (accepted > 0 && accepted < args.requested && workingRank(current.state) < workingRank("PARTIALLY_FILLED")) {
      return { state: "PARTIALLY_FILLED", conflict: null };
    }
    return { state: current.state, conflict: null };
  }
  // The candidate is the newer observation, so it wins — including UNKNOWN, which is how a failed
  // or empty read legitimately reports that the broker may own something we cannot currently read.
  if (candidate.state === "UNKNOWN") return { state: "UNKNOWN", conflict: null };
  if (accepted > 0 && accepted < requested && workingRank(candidate.state) < workingRank("PARTIALLY_FILLED")) {
    return { state: "PARTIALLY_FILLED", conflict: null };
  }
  return {
    state: workingRank(candidate.state) >= workingRank(current.state) ? candidate.state : current.state,
    conflict: null,
  };
}

/**
 * Resolve the evidence marker.
 *
 * The critical output is `accounting`: when exposure is proven but its price is not, it must read
 * `pending_price` so that `executionAccountingComplete()` reports false and no consumer asserts
 * P&L or "the box is fully accounted for". That is the existing unpriced/reconciliation mechanism
 * and this merge must route into it rather than inventing a price.
 */
function resolveEvidence(args: {
  readonly current: BrokerOrder;
  readonly candidate: BrokerOrder;
  readonly accepted: number;
  readonly averagePrice: number | null;
  readonly candidateWasStale: boolean;
  readonly candidateAdvancedFill: boolean;
}): ExecutionEvidenceQuality | undefined {
  const { current, candidate, accepted, averagePrice, candidateWasStale, candidateAdvancedFill } = args;
  const winner = candidateWasStale ? current : candidate;
  const other = candidateWasStale ? candidate : current;
  const winnerEvidence = winner.execution_evidence ?? other.execution_evidence;
  // Paper and locally-constructed orders carry no marker and have nothing to disclaim.
  if (winnerEvidence === undefined) return undefined;

  // Was the snapshot that SUPPLIED the accepted cumulative figure the one that confirmed it?
  let quantityConfirmed: boolean;
  if (candidateAdvancedFill) {
    quantityConfirmed = candidate.execution_evidence?.quantity === "confirmed";
  } else if (candidateWasStale) {
    quantityConfirmed = current.execution_evidence?.quantity === "confirmed";
  } else {
    quantityConfirmed =
      candidate.execution_evidence?.quantity === "confirmed" ||
      current.execution_evidence?.quantity === "confirmed";
  }

  const quantity: ExecutionEvidenceQuality["quantity"] = quantityConfirmed ? "confirmed" : winnerEvidence.quantity;
  const price: ExecutionEvidenceQuality["price"] =
    accepted === 0 ? "not_applicable" : averagePrice !== null ? "confirmed" : "missing";

  let accounting: ExecutionEvidenceQuality["accounting"];
  if (accepted === 0) {
    accounting = quantity === "confirmed" ? "complete" : winnerEvidence.accounting;
  } else if (averagePrice === null) {
    // Exposure stands; only the ACCOUNTING waits for a price.
    accounting = "pending_price";
  } else {
    accounting = "complete";
  }
  // A snapshot that could not support its own claim, and whose quantity nobody confirmed, stays
  // unproven regardless of what else lines up.
  if (winnerEvidence.accounting === "unproven" && !quantityConfirmed) accounting = "unproven";

  return { quantity, price, accounting };
}

/**
 * Choose the fill records consistent with the accepted cumulative quantity.
 *
 * The two arrays are NEVER concatenated: adapters record either per-trade rows or one aggregate row
 * representing the cumulative quantity, so concatenating overlapping observations would double
 * count. Selecting one array makes a repeated observation idempotent.
 */
function resolveFills(args: {
  readonly winner: BrokerOrder;
  readonly other: BrokerOrder;
  readonly accepted: number;
  readonly averagePrice: number | null;
}): BrokerFill[] {
  const { winner, other, accepted, averagePrice } = args;
  if (accepted <= 0) return [];

  const copy = (fills: readonly BrokerFill[]): BrokerFill[] => fills.map((fill) => ({ ...fill }));

  const winnerSum = sumFilled(winner.fills);
  const otherSum = sumFilled(other.fills);

  // An array that already accounts for exactly the accepted quantity is authoritative.
  if (winner.fills.length > 0 && winnerSum === accepted) return copy(winner.fills);
  if (other.fills.length > 0 && otherSum === accepted) return copy(other.fills);

  // A MULTI-row array is per-trade detail. A trade book can legitimately lag the aggregate
  // (`fetchFills` is best-effort by design), so keeping it degrades granularity rather than
  // exposure — `filled_quantity` is what carries exposure. Prefer the richer of the two.
  const richer = winner.fills.length >= other.fills.length ? winner : other;
  const richerSum = richer === winner ? winnerSum : otherSum;
  if (richer.fills.length > 1 && richerSum < accepted) return copy(richer.fills);

  // A SINGLE row is an AGGREGATE by construction in both adapters, so a single row that does not
  // equal the accepted cumulative quantity describes an earlier, smaller fill. Presenting it
  // alongside a larger `filled_quantity` is exactly the incoherence this merge exists to prevent,
  // so it is replaced by an aggregate for the accepted quantity.
  return [{
    fill_id: `merge:${winner.broker_order_id ?? winner.client_order_id}:${accepted}:${averagePrice ?? "unpriced"}`,
    quantity: accepted,
    // NULL, never zero: an unpublished average price is absent data, not a free execution.
    price: averagePrice,
    at: Math.max(winner.updated_at, other.updated_at),
  }];
}
