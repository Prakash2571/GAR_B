/**
 * WHAT AN EMERGENCY FLATTEN ACTUALLY ACHIEVED — classified honestly, and separately per item.
 *
 * THE DEFECT THIS CLOSES
 *
 * `POST /api/box/live/flatten` answered `{ ok: true, ... }` as a literal, always with HTTP 200, over a
 * `results: unknown[]` filled with `ManualCloseResult` objects that are frequently `{ ok: false }`.
 * The frontend inspected only `settlement.failures` and `settlement.reconciled` — the CANCELLATION and
 * RECONCILIATION halves — and never looked at `results` at all. So an operator who pressed the panic
 * button while the exchange was closed, the feed was unhealthy, a position was in RECOVERY, or a
 * position was already closing got a GREEN success toast while every position failed to close.
 *
 * The cancel-working route immediately above it had already been rewritten to derive `ok` from its
 * sweep and to answer 409/207. This module does the same job for flatten, and does it in one pure
 * place so the route, the schema and the UI cannot drift from each other.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE
 *
 * UNKNOWN EXPOSURE MUST NEVER BECOME ZERO EXPOSURE. `remaining_quantity: null` means "not known",
 * and it is NOT interchangeable with 0. Any item whose remaining quantity is unknown makes the whole
 * result `unresolved`, never `flat`. An accepted order, a 200 response and a cancellation
 * acknowledgement are each evidence that something was REQUESTED — none of them is evidence of
 * flatness.
 */

import type { BoxLegRole } from "./types.js";

/** Per-item disposition, from strongest to weakest evidence. */
export type FlattenItemDisposition =
  /**
   * The reduction completed and the position reached FLAT on this process's fill evidence.
   *
   * Deliberately NOT called "broker confirmed": it is derived from the fills this process observed and
   * applied, which is the strongest signal available at the end of a flatten but is not an independent
   * re-read of broker positions. `reconciliation_complete` in the settlement block is what speaks to
   * durable/broker agreement.
   */
  | "flat_on_fill_evidence"
  /** Some quantity was reduced; exposure remains and is still being managed. */
  | "partially_reduced"
  /** Nothing was reduced, and a reason is known. Exposure is unchanged and still owned. */
  | "not_reduced"
  /**
   * Something was attempted and the outcome is NOT established — a thrown error, a lost
   * acknowledgement, a residual pass whose remaining quantity could not be determined.
   *
   * This is the most important state in the enum and the one a green toast used to hide.
   */
  | "unresolved";

/** One position or one crash-only residual group. */
export interface FlattenItemOutcome {
  readonly kind: "position" | "residual";
  /** Position id, or the durable recovery-attempt id for a residual group. */
  readonly id: string;
  /** Underlying/symbol label, for an operator reading a list. Null when not determinable. */
  readonly label: string | null;
  readonly disposition: FlattenItemDisposition;
  /** Why, in operator-readable prose. Null only for `flat_on_fill_evidence`. */
  readonly reason: string | null;
  /**
   * Quantity still outstanding. NULL MEANS UNKNOWN, NOT ZERO.
   *
   * 0 is only ever written for `flat_on_fill_evidence`.
   */
  readonly remaining_quantity: number | null;
  /** Per-role breakdown where one exists. Null when unknown or not applicable. */
  readonly remaining_by_role: Readonly<Partial<Record<BoxLegRole, number>>> | null;
}

/** The aggregate disposition of the whole flatten. */
export type FlattenAggregateOutcome =
  /** Every item reached flat on fill evidence AND settlement was clean. */
  | "flat_on_fill_evidence"
  /** Every item is accounted for, at least one reduced, and exposure remains. */
  | "partially_reduced"
  /** At least one item's outcome is not established. Exposure may or may not remain. */
  | "unresolved"
  /** Nothing was reduced at all, and every reason is known. */
  | "not_reduced"
  /** There was nothing attributed to flatten. */
  | "nothing_to_flatten";

export interface FlattenSettlement {
  /** Working orders cancelled by the pre-flatten sweep. */
  readonly cancelled: number;
  readonly failures: readonly string[];
  /** Non-null when the cancellation sweep was REFUSED outright (nothing attempted). */
  readonly blocked: string | null;
  /** Whether the post-cancellation reconcile completed. */
  readonly reconciled: boolean;
}

export interface AttributedFlattenResult {
  /** How many items the flatten was asked to reduce. */
  readonly requested: number;
  /** How many of those it actually tried to reduce. Never greater than `requested`. */
  readonly attempted: number;
  readonly items: readonly FlattenItemOutcome[];
  readonly settlement: FlattenSettlement;
  readonly outcome: FlattenAggregateOutcome;
  /**
   * TRUE ONLY when there is positive evidence that nothing is left: every item flat on fill evidence,
   * settlement clean, and no unknown quantity anywhere.
   *
   * This is what the route publishes as `ok`, replacing a hardcoded literal.
   */
  readonly ok: boolean;
  /** False when ANY item's remaining quantity is unknown. */
  readonly remaining_exposure_known: boolean;
  /**
   * Total quantity still outstanding, or null when that cannot be totalled because something is
   * unknown. Null must never be rendered as zero.
   */
  readonly remaining_quantity: number | null;
  /** Every distinct reason exposure remains or is unproven. Deduplicated, order preserved. */
  readonly blockers: readonly string[];
  /** What the operator must do now. Never "nothing"; always a concrete instruction. */
  readonly next_action: string;
  /** Legacy alias of `items`, kept so an older consumer reading `results` still sees the array. */
  readonly results: readonly FlattenItemOutcome[];
}

/** The subset of `ManualCloseResult` this classifier needs. Structural, so no import cycle. */
export interface ManualCloseLike {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly partial?: boolean | undefined;
  readonly remaining_qty_by_role?: Readonly<Partial<Record<BoxLegRole, number>>> | undefined;
}

function totalOf(byRole: Readonly<Partial<Record<BoxLegRole, number>>> | null | undefined): number | null {
  if (!byRole) return null;
  let total = 0;
  for (const value of Object.values(byRole)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return total;
}

/**
 * Classify one position close.
 *
 * `thrown` is for the case the close raised rather than returned: nothing about the outcome is
 * established, and orders may already be at the broker, so it is `unresolved` with an UNKNOWN
 * remaining quantity — never "not reduced".
 */
export function classifyPositionClose(args: {
  readonly id: string;
  readonly label: string | null;
  readonly result: ManualCloseLike | null;
  readonly thrown?: string | undefined;
}): FlattenItemOutcome {
  const base = { kind: "position" as const, id: args.id, label: args.label };
  if (args.thrown !== undefined) {
    return {
      ...base,
      disposition: "unresolved",
      reason:
        `the close raised before its outcome was established (${args.thrown}). Orders may already ` +
        "have reached the broker; treat this exposure as unresolved and verify at the broker terminal.",
      remaining_quantity: null,
      remaining_by_role: null,
    };
  }
  if (args.result === null) {
    return {
      ...base,
      disposition: "unresolved",
      reason: "the close returned no result, so its outcome is not established",
      remaining_quantity: null,
      remaining_by_role: null,
    };
  }
  if (args.result.ok) {
    return {
      ...base,
      disposition: "flat_on_fill_evidence",
      reason: null,
      remaining_quantity: 0,
      remaining_by_role: null,
    };
  }
  const byRole = args.result.remaining_qty_by_role ?? null;
  if (args.result.partial === true) {
    return {
      ...base,
      disposition: "partially_reduced",
      reason:
        args.result.error ??
        "the position was partially closed; the remaining exposure is still being managed",
      remaining_quantity: totalOf(byRole),
      remaining_by_role: byRole,
    };
  }
  return {
    ...base,
    disposition: "not_reduced",
    reason: args.result.error ?? "the position could not be closed, and it is unchanged",
    // NOT zero: nothing was reduced, so whatever was there is still there. When the per-role map is
    // absent we do not know the number, and null is the honest answer.
    remaining_quantity: totalOf(byRole),
    remaining_by_role: byRole,
  };
}

/** The subset of a residual flatten pass this classifier needs. */
export interface ResidualPassLike {
  readonly remaining?: readonly { readonly role: BoxLegRole; readonly quantity: number }[] | undefined;
  readonly flattened_by_role?: Readonly<Partial<Record<BoxLegRole, number>>> | undefined;
}

/** Classify one crash-only residual flatten pass. */
export function classifyResidualFlatten(args: {
  readonly id: string;
  readonly label: string | null;
  readonly result: ResidualPassLike | null;
  readonly thrown?: string | undefined;
  /** Quantity that was outstanding BEFORE the pass, so "reduced nothing" can be distinguished. */
  readonly requestedQuantity: number | null;
}): FlattenItemOutcome {
  const base = { kind: "residual" as const, id: args.id, label: args.label };
  if (args.thrown !== undefined) {
    return {
      ...base,
      disposition: "unresolved",
      reason:
        `the residual flatten raised before its outcome was established (${args.thrown}). Reducing ` +
        "orders may already have reached the broker; verify at the broker terminal.",
      remaining_quantity: null,
      remaining_by_role: null,
    };
  }
  if (args.result === null || args.result.remaining === undefined) {
    return {
      ...base,
      disposition: "unresolved",
      reason:
        "the residual flatten did not report what remains, so the outstanding quantity is not " +
        "established",
      remaining_quantity: null,
      remaining_by_role: null,
    };
  }
  const byRole: Partial<Record<BoxLegRole, number>> = {};
  let remaining = 0;
  for (const leg of args.result.remaining) {
    if (!Number.isFinite(leg.quantity) || leg.quantity < 0) {
      return {
        ...base,
        disposition: "unresolved",
        reason: "the residual flatten reported an unusable remaining quantity",
        remaining_quantity: null,
        remaining_by_role: null,
      };
    }
    byRole[leg.role] = (byRole[leg.role] ?? 0) + leg.quantity;
    remaining += leg.quantity;
  }
  if (remaining === 0) {
    return {
      ...base,
      disposition: "flat_on_fill_evidence",
      reason: null,
      remaining_quantity: 0,
      remaining_by_role: null,
    };
  }
  const reducedAnything =
    args.requestedQuantity !== null && args.requestedQuantity > remaining;
  return {
    ...base,
    disposition: reducedAnything ? "partially_reduced" : "not_reduced",
    reason: reducedAnything
      ? `the residual was partially reduced; ${remaining} unit(s) remain and the watchdog keeps retrying`
      : `no part of the residual could be reduced; ${remaining} unit(s) remain and the watchdog keeps retrying`,
    remaining_quantity: remaining,
    remaining_by_role: byRole,
  };
}

function dedupe(values: readonly (string | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value === null || value === "") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Fold per-item outcomes plus settlement into the published result.
 *
 * THE AGGREGATION IS DELIBERATELY PESSIMISTIC AT EVERY STEP. A single unresolved item makes the whole
 * thing unresolved; a single unknown quantity makes the total unknown; a settlement that did not
 * reconcile withholds `ok` even when every item reported flat, because an unreconciled snapshot is
 * exactly the state in which a still-working order can fill after the flatten "succeeded".
 */
export function buildAttributedFlattenResult(args: {
  readonly requested: number;
  readonly attempted: number;
  readonly items: readonly FlattenItemOutcome[];
  readonly settlement: FlattenSettlement;
}): AttributedFlattenResult {
  const { items, settlement } = args;

  const anyUnresolved = items.some((i) => i.disposition === "unresolved");
  const anyPartial = items.some((i) => i.disposition === "partially_reduced");
  const anyNotReduced = items.some((i) => i.disposition === "not_reduced");
  const allFlat = items.length > 0 && items.every((i) => i.disposition === "flat_on_fill_evidence");

  // Unknown anywhere ⇒ unknown overall. Never substitute 0.
  const remainingKnown = items.every((i) => i.remaining_quantity !== null);
  const remainingQuantity = remainingKnown
    ? items.reduce((sum, i) => sum + (i.remaining_quantity ?? 0), 0)
    : null;

  const settlementClean =
    settlement.blocked === null && settlement.failures.length === 0 && settlement.reconciled;

  let outcome: FlattenAggregateOutcome;
  if (args.requested === 0) outcome = "nothing_to_flatten";
  else if (anyUnresolved) outcome = "unresolved";
  else if (args.attempted < args.requested) {
    // Items the flatten never got to. Their exposure is untouched and we hold no outcome for them, so
    // the result cannot be flat however well the attempted ones went.
    outcome = "unresolved";
  } else if (allFlat) outcome = "flat_on_fill_evidence";
  else if (anyPartial) outcome = "partially_reduced";
  else if (anyNotReduced) outcome = "not_reduced";
  else outcome = "unresolved";

  // `ok` requires positive evidence on BOTH halves AND that every requested item was accounted for.
  // "Nothing to flatten" is genuinely ok: there was no attributed exposure, and settlement still has to
  // have been clean for that to mean anything.
  const ok =
    settlementClean &&
    remainingKnown &&
    (remainingQuantity ?? 0) === 0 &&
    args.attempted >= args.requested &&
    items.length >= args.requested &&
    (outcome === "flat_on_fill_evidence" || outcome === "nothing_to_flatten");

  const blockers = dedupe([
    settlement.blocked === null
      ? null
      : `the pre-flatten cancellation sweep was REFUSED and nothing was cancelled: ${settlement.blocked}`,
    ...settlement.failures.map((f) => `settlement: ${f}`),
    settlement.reconciled
      ? null
      : "the post-cancellation reconcile did not complete, so the reduction was planned against a " +
        "snapshot a still-working order could change",
    ...items
      .filter((i) => i.disposition !== "flat_on_fill_evidence")
      .map((i) => `${i.kind} ${i.id}: ${i.reason ?? "outcome not established"}`),
    args.attempted < args.requested
      ? `${args.requested - args.attempted} item(s) were never attempted`
      : null,
  ]);

  return {
    requested: args.requested,
    attempted: args.attempted,
    items,
    results: items,
    settlement,
    outcome,
    ok,
    remaining_exposure_known: remainingKnown,
    remaining_quantity: remainingQuantity,
    blockers,
    next_action: nextAction({ ok, outcome, remainingKnown, settlementClean }),
  };
}

function nextAction(args: {
  readonly ok: boolean;
  readonly outcome: FlattenAggregateOutcome;
  readonly remainingKnown: boolean;
  readonly settlementClean: boolean;
}): string {
  if (args.ok) {
    return (
      "No attributed Box exposure remains on this process's fill evidence. Confirm flat at the broker " +
      "terminal before re-arming — this result is not an independent broker position re-read."
    );
  }
  if (!args.remainingKnown || args.outcome === "unresolved") {
    return (
      "EXPOSURE IS UNRESOLVED. At least one reduction's outcome is not established, so orders may " +
      "have reached the broker without a known result. Do NOT re-arm. Inspect positions and working " +
      "orders AT THE BROKER TERMINAL and reduce there if required; pressing flatten again cannot " +
      "establish what is already outstanding."
    );
  }
  if (args.outcome === "partially_reduced" || args.outcome === "not_reduced") {
    return (
      "EXPOSURE REMAINS. Read the per-item reasons below: each names why that item could not be " +
      "reduced. Exposure is still owned and still monitored. If the reasons are not clearing, reduce " +
      "at the broker terminal."
    );
  }
  if (!args.settlementClean) {
    return (
      "Settlement did not complete cleanly. Working orders may still be live and able to fill. " +
      "Re-run the working-order cancellation, then inspect positions at the broker terminal."
    );
  }
  return "Inspect positions and working orders at the broker terminal before any further action.";
}

/**
 * The HTTP status this result deserves.
 *
 * Mirrors the cancel-working route, which was deliberately rewritten to stop answering 200 for a
 * refusal: 409 when nothing was reduced, 207 when the outcome is mixed or unproven, 200 only on
 * positive evidence of flatness.
 */
export function flattenHttpStatus(result: AttributedFlattenResult): 200 | 207 | 409 {
  if (result.ok) return 200;
  if (result.outcome === "not_reduced") return 409;
  return 207;
}
