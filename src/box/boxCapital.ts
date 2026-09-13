/**
 * MAXIMUM ₹ EXPOSURE PER BOX — the admission metric and its gate.
 *
 * WHAT THIS NUMBER IS
 *
 * `gross_entry_order_notional_rupees` = SUM over the four ENTRY legs of
 *
 *     |limit_price x quantity|
 *
 * computed from the ACTUAL bounded LIMIT order requests that would be transmitted. It is
 * the largest rupee amount those four immutable orders can transact, because a LIMIT order
 * can never fill worse than its limit and the Box never uses MARKET orders.
 *
 * WHAT THIS NUMBER IS **NOT**
 *
 * It is NOT broker margin. It is NOT SPAN+exposure. It is NOT the capital the broker will
 * actually block. A four-leg Box is a hedged structure and its real margin requirement is
 * typically a small fraction of gross option notional — sometimes it is a NET CREDIT. The
 * naming is deliberate and the code must never be edited to call this "margin", because an
 * operator who reads "margin: ₹120,000" and sets a ₹120,000 cap would be setting a limit
 * roughly an order of magnitude away from what they intended.
 *
 * If a reliable broker margin API is available its answer is exposed SEPATATELY as
 * `broker_estimated_margin_rupees` (see {@link BoxCapitalReport}) and is never substituted
 * for the admission metric: one is an observable property of our own bounded orders, the
 * other is a remote estimate that can fail, lag, or be denied.
 *
 * WHY GROSS NOTIONAL IS STILL THE RIGHT ADMISSION GATE
 *
 * It is deterministic, computable offline from data we already hold, monotone in quantity
 * and price, and CONSERVATIVE (it always over-states the economic risk of a hedged Box).
 * An operator using it is expressing "do not let one Box transact more than ₹X of option
 * premium", which is a meaningful, auditable sentence. It requires no broker round trip, so
 * it can be evaluated at the last safe moment before submission — which a remote margin
 * call cannot.
 *
 * PRECISION
 *
 * All comparisons are done in INTEGER PAISE. Rupee floats cannot represent ₹0.01 exactly,
 * and the specification requires that ₹0.01 over the cap is refused while exactly at the
 * cap is admitted. Comparing paise integers makes that boundary exact rather than
 * dependent on IEEE-754 rounding.
 */

import type { BoxLegRole, OrderSide } from "./types.js";
import type { AgedEvidence, EvidenceIdentity } from "./evidenceTiming.js";

/** ₹ -> integer paise, half-up. Total: non-finite input yields 0. */
export function toPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return 0;
  return Math.round(rupees * 100);
}

/** Integer paise -> ₹, to 2dp. */
export function fromPaise(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return Math.round(paise) / 100;
}

/** The minimal shape of an order request this module needs. */
export interface BoxCapitalOrderLike {
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  readonly tradingsymbol: string;
  readonly quantity: number;
  readonly pricing: { readonly limit_price: number };
}

/** One leg's contribution to the gross entry notional. */
export interface BoxCapitalLegBreakdown {
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  readonly tradingsymbol: string;
  readonly quantity: number;
  /** The bounded LIMIT price used — never an LTP, never a mid. */
  readonly limit_price: number;
  readonly notional_rupees: number;
}

/**
 * The computed metric, plus whether it is TRUSTWORTHY.
 *
 * `complete` is the safety-critical field. A metric computed from three priced legs and one
 * unpriced leg understates the true total, and admitting on an understated total is exactly
 * how a cap gets bypassed. Callers must treat `complete === false` as "cannot prove
 * compliance" and refuse when a cap is configured.
 */
export interface BoxCapitalMetrics {
  readonly gross_entry_order_notional_rupees: number;
  readonly gross_entry_order_notional_paise: number;
  readonly legs: readonly BoxCapitalLegBreakdown[];
  readonly leg_count: number;
  /** True only when every leg carried a finite, positive quantity and limit price. */
  readonly complete: boolean;
  /** Human-readable reason `complete` is false, else null. */
  readonly incomplete_reason: string | null;
}

/**
 * Compute the gross entry-order notional from the bounded LIMIT requests.
 *
 * `expectedLegCount` defaults to 4 (a Box). Passing the count explicitly lets the caller
 * assert "I built four requests" so a silently-dropped leg is caught here rather than
 * becoming an under-stated total.
 */
export function grossEntryOrderNotional(
  requests: readonly BoxCapitalOrderLike[],
  expectedLegCount = 4,
): BoxCapitalMetrics {
  const legs: BoxCapitalLegBreakdown[] = [];
  const problems: string[] = [];
  let totalPaise = 0;

  for (const request of requests) {
    const quantity = request.quantity;
    const limit = request.pricing?.limit_price;
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
      problems.push(`${request.role} has a non-positive or non-integer quantity (${String(quantity)})`);
      continue;
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      problems.push(`${request.role} has no usable bounded LIMIT price (${String(limit)})`);
      continue;
    }
    // Absolute value: a Box mixes BUY and SELL legs, and the metric is GROSS transacted
    // value, not a net debit. Netting BUY against SELL would let an arbitrarily large Box
    // through by pairing offsetting legs — the exact opposite of a conservative cap.
    const legPaise = Math.abs(toPaise(limit) * quantity);
    totalPaise += legPaise;
    legs.push({
      role: request.role,
      side: request.side,
      tradingsymbol: request.tradingsymbol,
      quantity,
      limit_price: limit,
      notional_rupees: fromPaise(legPaise),
    });
  }

  if (legs.length !== expectedLegCount) {
    problems.push(`expected ${expectedLegCount} priced legs, computed ${legs.length}`);
  }

  return {
    gross_entry_order_notional_rupees: fromPaise(totalPaise),
    gross_entry_order_notional_paise: totalPaise,
    legs,
    leg_count: legs.length,
    complete: problems.length === 0,
    incomplete_reason: problems.length === 0 ? null : problems.join("; "),
  };
}

/** Where in the pipeline a capital check ran. Recorded so a refusal is attributable. */
export type BoxCapitalCheckStage =
  /** During candidate qualification, for visibility. Advisory only. */
  | "qualification"
  /** From the immutable bounded order requests, immediately before durable submission. */
  | "pre_submit"
  /** Re-checked at dequeue, because requests may have been rebuilt or prices re-read. */
  | "dequeue";

/** The refusal reason string persisted and reported for a capital-cap block. */
export const BOX_CAPITAL_LIMIT_REASON = "box_capital_limit" as const;

export interface BoxCapitalReport {
  readonly stage: BoxCapitalCheckStage;
  /** Whether a cap is configured at all. `false` ⇒ this gate is disabled. */
  readonly enabled: boolean;
  readonly allowed: boolean;
  /** `box_capital_limit` when refused, else null. */
  readonly reason: typeof BOX_CAPITAL_LIMIT_REASON | null;
  readonly detail: string | null;
  readonly calculated_rupees: number;
  readonly configured_max_rupees: number;
  readonly broker: string;
  /** The Box candidate key. Internal identifier; not a secret, but not surfaced to end users. */
  readonly candidate_key: string;
  readonly at: number;
  readonly metrics: BoxCapitalMetrics;
  /**
   * A broker's own margin estimate, when one was obtained. NEVER used for admission and
   * NEVER substituted for `calculated_rupees`. Null when unavailable, which is the common
   * case and must not be mistaken for zero.
   */
  readonly broker_estimated_margin_rupees: number | null;
}

/**
 * Evaluate the configured ₹ cap against a computed metric.
 *
 * SEMANTICS, pinned by tests:
 *   - `limitRupees <= 0` ⇒ the gate is DISABLED and everything is admitted. This is the
 *     default, so an existing deployment upgrading to this build changes behaviour in no
 *     way whatsoever.
 *   - amount strictly below the cap ⇒ admitted.
 *   - amount EXACTLY at the cap ⇒ admitted (the cap is a maximum, inclusive).
 *   - amount ₹0.01 over the cap ⇒ refused.
 *   - metric NOT `complete` while a cap is configured ⇒ REFUSED. We cannot prove
 *     compliance from an under-stated total, and an unprovable safety gate is not a
 *     safety gate.
 *
 * This function is pure and performs no submission. Refusing here is a PRE-TRADE refusal:
 * the caller must invoke it before any broker mutation.
 */
export function evaluateBoxCapitalAdmission(args: {
  readonly metrics: BoxCapitalMetrics;
  readonly limitRupees: number;
  readonly broker: string;
  readonly candidateKey: string;
  readonly at: number;
  readonly stage: BoxCapitalCheckStage;
  readonly brokerEstimatedMarginRupees?: number | null;
}): BoxCapitalReport {
  const limit = Number.isFinite(args.limitRupees) ? args.limitRupees : 0;
  const base = {
    stage: args.stage,
    calculated_rupees: args.metrics.gross_entry_order_notional_rupees,
    configured_max_rupees: limit > 0 ? limit : 0,
    broker: args.broker,
    candidate_key: args.candidateKey,
    at: args.at,
    metrics: args.metrics,
    broker_estimated_margin_rupees: args.brokerEstimatedMarginRupees ?? null,
  } as const;

  if (limit <= 0) {
    // Disabled. Deliberately does NOT inspect `complete`: with no cap configured there is
    // nothing to prove, and refusing an entry because a metric we are not using is
    // incomplete would be a behaviour regression for every existing deployment.
    return { ...base, enabled: false, allowed: true, reason: null, detail: null };
  }

  if (!args.metrics.complete) {
    return {
      ...base,
      enabled: true,
      allowed: false,
      reason: BOX_CAPITAL_LIMIT_REASON,
      detail:
        `cannot verify the ₹${limit} per-Box cap: ${args.metrics.incomplete_reason ?? "metric incomplete"}. ` +
        "Refusing rather than admitting on an under-stated total.",
    };
  }

  const limitPaise = toPaise(limit);
  if (args.metrics.gross_entry_order_notional_paise > limitPaise) {
    return {
      ...base,
      enabled: true,
      allowed: false,
      reason: BOX_CAPITAL_LIMIT_REASON,
      detail:
        `gross_entry_order_notional_rupees ₹${args.metrics.gross_entry_order_notional_rupees} exceeds the ` +
        `configured BOX_LIVE_MAX_BOX_CAPITAL_RUPEES ₹${limit} (checked at ${args.stage}). ` +
        "This is gross option-order notional from the bounded LIMIT requests, NOT broker margin.",
    };
  }

  return { ...base, enabled: true, allowed: true, reason: null, detail: null };
}

/**
 * A compact, low-cardinality projection for status/diagnostics.
 *
 * Deliberately omits the per-leg breakdown and the candidate key: a status endpoint polled
 * every second must not grow unbounded, and per-leg tradingsymbols are high-cardinality
 * labels of the kind the metrics contract already forbids.
 */
export function boxCapitalSummary(report: BoxCapitalReport | null): {
  enabled: boolean;
  configured_max_rupees: number;
  last_calculated_rupees: number | null;
  last_stage: BoxCapitalCheckStage | null;
  last_allowed: boolean | null;
  last_at: number | null;
} {
  if (!report) {
    return {
      enabled: false,
      configured_max_rupees: 0,
      last_calculated_rupees: null,
      last_stage: null,
      last_allowed: null,
      last_at: null,
    };
  }
  return {
    enabled: report.enabled,
    configured_max_rupees: report.configured_max_rupees,
    last_calculated_rupees: report.calculated_rupees,
    last_stage: report.stage,
    last_allowed: report.allowed,
    last_at: report.at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE FIVE DISTINCT ECONOMIC QUANTITIES  (Task 9)
//
// The gross-notional metric above is ONE of five quantities an honest admission gate must keep
// separate. Conflating any two of them is how a box is admitted that the broker will reject, or
// that will breach available funds during the legging window even though the final hedged
// position is cheap. The five, never to be substituted for one another:
//
//   1. AVAILABLE broker funds            — what the account can actually deploy right now.
//   2. Margin required by the PLANNED     — the broker's own estimate for the four-leg basket,
//      execution sequence                   from a SUPPORTED margin facility (Kite basket /
//                                            Dhan multi). An ESTIMATE, never a guarantee of
//                                            acceptance.
//   3. PEAK TEMPORARY EXPOSURE            — the most capital tied up at any instant DURING
//      (the legging window)                 legging, before all four legs and their hedge
//                                            benefit exist. Can far exceed (2).
//   4. GROSS order notional              — the existing metric above. Deterministic, offline,
//                                            conservative. Keeps its label.
//   5. Bounded WORST-CASE entry prices   — the largest the four LIMIT orders can cost, and the
//      and estimated costs                  estimated charges on top. Deterministic from the
//                                            bounded requests.
//
// PROVENANCE is a first-class type here. Every remote figure is tagged with where it came from,
// when, and whether it is a broker-CONFIRMED value or our own ESTIMATE. A stale or failed fetch
// yields an explicit `unavailable`/`stale` status that the gate treats as "cannot prove", never
// as an optimistic zero.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where an economic figure came from, and how much it can be trusted.
 *
 *   "broker_confirmed" — returned by a supported broker margin/funds facility THIS session.
 *   "estimate"         — computed by us (e.g. gross notional, worst-case cost). Deterministic
 *                        but NOT a promise the broker will accept the orders.
 *   "unavailable"      — no figure could be obtained (absent source, timeout, throw, null).
 *                        Distinct from a value of 0.
 *   "stale"            — a figure was obtained but is older than the configured freshness bound.
 *   "invalid"          — a figure was obtained but cannot be AGED or ATTRIBUTED: a non-finite
 *                        timestamp, a source clock materially in the future, inverted monotonic
 *                        readings, or an account/session/broker that changed during the read.
 *                        Distinct from "stale" on purpose: stale means "too old", invalid means
 *                        "this number is not about what we are trading, or cannot be trusted to be
 *                        timed at all". Both are unusable; conflating them hides a clock fault.
 */
export type EconomicProvenance = "broker_confirmed" | "estimate" | "unavailable" | "stale" | "invalid";

/**
 * A single economic quantity with full provenance.
 *
 * `value` is null whenever provenance is "unavailable" — null is "not known", never "₹0". A
 * caller must branch on `provenance` before trusting `value`, which the type nudges by making
 * `value` nullable.
 */
export interface EconomicFigure {
  readonly value_rupees: number | null;
  readonly provenance: EconomicProvenance;
  /** Epoch ms the figure was observed, or null when never observed. WALL clock, for audit only. */
  readonly observed_at: number | null;
  /**
   * Monotonic ms the figure was observed. Null for a locally computed estimate or when unavailable.
   * NEVER comparable with `observed_at`; this is the reading `age_ms` is derived from.
   */
  readonly observed_at_mono: number | null;
  /** Age (ms) at the time the report was built, or null when never observed. Never negative. */
  readonly age_ms: number | null;
  /** True when `age_ms` came from the monotonic clock rather than a wall-clock difference. */
  readonly age_is_monotonic: boolean;
  /** True when provenance is broker_confirmed AND within the freshness bound. */
  readonly usable: boolean;
  /**
   * The order plan this figure is evidence ABOUT, when it is plan-specific (a basket margin).
   * Null for account-level figures (available funds) and local estimates.
   */
  readonly plan_fingerprint: string | null;
  /** Free-text describing exactly what this figure can and cannot prove. */
  readonly note: string;
}

/**
 * Build an {@link EconomicFigure} from an ALREADY-AGED observation.
 *
 * The freshness decision itself lives in {@link ageEvidence} (src/box/evidenceTiming.ts), which owns
 * the one coherent clock model: monotonic for durations, wall for audit, evaluation instant stamped
 * AFTER the reads resolve. This function only projects that decision into the reporting shape, so
 * there is exactly ONE place in the system that decides whether a broker figure is fresh.
 *
 * WHY THIS CHANGED. It used to compute `age = now - observedAt` from two wall-clock readings taken
 * on opposite sides of an `await`, which made the age of every real broker response NEGATIVE and
 * downgraded fresh evidence to "stale". See src/box/evidenceTiming.ts for the full root cause.
 */
export function brokerFigure(args: {
  readonly valueRupees: number | null;
  readonly aged: AgedEvidence;
  /** Wall time the figure was observed, for the audit record. */
  readonly observedAtWall: number | null;
  /** Monotonic time the figure was observed, which `aged.age_ms` is derived from. */
  readonly observedAtMono: number | null;
  readonly planFingerprint?: string | null;
  readonly confirmedNote: string;
}): EconomicFigure {
  const plan = args.planFingerprint ?? null;
  // No value, or a non-finite one, is UNKNOWN — never ₹0, and never merely "stale".
  if (args.valueRupees === null || !Number.isFinite(args.valueRupees)) {
    return {
      value_rupees: null,
      provenance: "unavailable",
      observed_at: null,
      observed_at_mono: null,
      age_ms: null,
      age_is_monotonic: false,
      usable: false,
      plan_fingerprint: plan,
      note:
        args.aged.status === "unavailable"
          ? args.aged.note
          : `${args.aged.note} (and no finite figure was returned; treated as UNKNOWN, never as ₹0)`,
    };
  }
  const provenance: EconomicProvenance =
    args.aged.status === "usable"
      ? "broker_confirmed"
      : args.aged.status === "stale"
        ? "stale"
        : args.aged.status === "invalid"
          ? "invalid"
          : "unavailable";
  return {
    value_rupees: args.valueRupees,
    provenance,
    observed_at: args.observedAtWall,
    observed_at_mono: args.observedAtMono,
    age_ms: args.aged.age_ms,
    age_is_monotonic: args.aged.age_is_monotonic,
    usable: provenance === "broker_confirmed",
    plan_fingerprint: plan,
    note: provenance === "broker_confirmed" ? `${args.confirmedNote} (${args.aged.note})` : args.aged.note,
  };
}

/** Build an {@link EconomicFigure} for a locally COMPUTED estimate (always fresh, never a guarantee). */
export function estimateFigure(valueRupees: number | null, now: number, note: string): EconomicFigure {
  if (valueRupees === null || !Number.isFinite(valueRupees)) {
    return {
      value_rupees: null,
      provenance: "unavailable",
      observed_at: null,
      observed_at_mono: null,
      age_ms: null,
      age_is_monotonic: false,
      usable: false,
      plan_fingerprint: null,
      note: "estimate could not be computed (an unpriced leg); treated as UNKNOWN",
    };
  }
  return {
    value_rupees: valueRupees,
    provenance: "estimate",
    observed_at: now,
    observed_at_mono: null,
    age_ms: 0,
    age_is_monotonic: false,
    usable: true,
    plan_fingerprint: null,
    note: `${note} This is OUR estimate from the bounded requests, NOT a broker-confirmed figure.`,
  };
}

/**
 * The bounded WORST-CASE entry cost of the four legs (quantity #5).
 *
 * For each leg, the worst the LIMIT order can cost the account is |limit_price x quantity| — the
 * same paise the gross-notional metric sums, but here it is a DEBIT view: BUY legs cost money,
 * SELL legs receive premium. We return BOTH the gross (all legs as cost, matching #4) and the
 * NET worst-case debit (buys minus sells), because peak exposure during legging is bounded by
 * the gross while the final settled debit is bounded by the net. Callers must not conflate them.
 */
export interface WorstCaseEntryCost {
  /** Sum of |limit x qty| over all four legs — matches gross notional, the peak-legging bound. */
  readonly gross_cost_rupees: number;
  /** BUY premium paid minus SELL premium received, at the bounded limits — the settled bound. */
  readonly net_debit_rupees: number;
  /** Estimated round-trip charges on top, when a charge estimate is supplied. Null otherwise. */
  readonly estimated_charges_rupees: number | null;
  readonly complete: boolean;
  readonly incomplete_reason: string | null;
}

export function worstCaseEntryCost(
  requests: readonly BoxCapitalOrderLike[],
  estimatedChargesRupees: number | null = null,
): WorstCaseEntryCost {
  const problems: string[] = [];
  let grossPaise = 0;
  let netDebitPaise = 0;
  let priced = 0;
  for (const r of requests) {
    const q = r.quantity;
    const limit = r.pricing?.limit_price;
    if (!Number.isFinite(q) || q <= 0 || !Number.isInteger(q)) {
      problems.push(`${r.role} non-positive/non-integer quantity`);
      continue;
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      problems.push(`${r.role} unpriced`);
      continue;
    }
    const legPaise = Math.abs(toPaise(limit) * q);
    grossPaise += legPaise;
    // A BUY pays premium (positive debit); a SELL receives it (negative debit).
    netDebitPaise += r.side === "BUY" ? legPaise : -legPaise;
    priced++;
  }
  if (priced !== 4) problems.push(`expected 4 priced legs, got ${priced}`);
  return {
    gross_cost_rupees: fromPaise(grossPaise),
    net_debit_rupees: fromPaise(netDebitPaise),
    estimated_charges_rupees:
      estimatedChargesRupees !== null && Number.isFinite(estimatedChargesRupees)
        ? estimatedChargesRupees
        : null,
    complete: problems.length === 0,
    incomplete_reason: problems.length === 0 ? null : problems.join("; "),
  };
}

/**
 * A single stage of the ACTUAL hedge-first execution sequence, and what it costs to reach.
 *
 * WHY STAGES EXIST (section 8). A four-leg box is only cheap once all four legs exist. The broker's
 * `final` basket margin is the requirement for the COMPLETED structure — it already contains the
 * spread benefit. Using it to decide whether the account can fund the sequence that CREATES the
 * structure is circular: at stage 1 the account holds one long option and has earned no spread
 * benefit at all. Zerodha's own documented example makes the size of the gap plain: `initial`
 * ₹96,504.98 vs `final` ₹34,786.73 for the same two-leg basket.
 *
 * So the funding question is asked stage by stage, in the order the legs are ACTUALLY transmitted
 * (BUY hedges first — see entrySubmissionOrder.ts), and the binding requirement is the WORST stage,
 * not the last one.
 */
export interface FundingStage {
  /** 0-based transport rank, matching entrySubmissionOrder(). */
  readonly index: number;
  readonly role: string;
  readonly side: OrderSide;
  /** True while this stage is still sending BUY hedges (no SELL proceeds exist yet). */
  readonly hedge: boolean;
  /** Cumulative premium PAID by the BUY legs sent up to and including this stage (₹). */
  readonly cumulative_premium_debit_rupees: number | null;
  /**
   * Cumulative premium RECEIVED from SELL legs up to and including this stage (₹).
   *
   * NOT treated as available funding for a later stage: option sale proceeds are not free
   * collateral at the moment of sale, and the SELL legs are last in the sequence anyway. It is
   * reported so an operator can see the real cash shape of the sequence.
   */
  readonly cumulative_premium_credit_rupees: number | null;
  /** Which broker margin figure applies at this stage, and why. */
  readonly margin_basis: "initial_basket" | "final_basket" | "unknown";
  /** Total funding needed to REACH this stage, or null when it cannot be established. */
  readonly requirement_rupees: number | null;
  readonly known: boolean;
  readonly note: string;
}

/**
 * The explicit funding figures section 8 requires, each separately labelled and never substituted.
 *
 * `binding_requirement` is the number admission compares available funds against. It is the WORST
 * stage requirement plus charges, the configured recovery reserve and any observed encumbrance —
 * never the completed-basket `final` margin alone.
 */
export interface FundingPicture {
  readonly initial_basket_margin: EconomicFigure;
  readonly final_basket_margin: EconomicFigure;
  readonly hedge_premium_requirement: EconomicFigure;
  readonly intermediate_stage_requirement: EconomicFigure;
  readonly encumbrance: EconomicFigure;
  readonly estimated_charges: EconomicFigure;
  readonly recovery_reserve: EconomicFigure;
  readonly binding_requirement: EconomicFigure;
  readonly stages: readonly FundingStage[];
  /** True when the hedge-first sequence was verified as BUY-before-SELL. */
  readonly hedge_first_sequence_valid: boolean;
  /** Every stage whose requirement could not be established. Non-empty ⇒ refuse the profile. */
  readonly unknown_stages: readonly string[];
}

/**
 * Build the stage-by-stage funding requirement for the REAL transmitted sequence.
 *
 * DOUBLE-COUNTING (section 8 requirement 4). Kite's basket-margin totals already include an
 * `option_premium` component, so the BUY premium is inside `initial`/`final`. Therefore the stage
 * requirement is NOT "margin + premium": it is the margin figure applicable at that stage, floored
 * by the premium actually payable by then. Flooring cannot double-count, and it protects against a
 * broker figure that understates the cash a BUY leg must actually pay.
 *
 * `requests` must be the bounded LIMIT requests that will really be transmitted.
 */
export function buildFundingStages(args: {
  readonly requests: readonly BoxCapitalOrderLike[];
  /** Transport order (hedge-first). Roles not present in `requests` are skipped. */
  readonly transportOrder: readonly { readonly role: string; readonly side: OrderSide; readonly rank: number }[];
  /** Broker `initial` basket margin (₹) — margin to EXECUTE the orders, no spread benefit. */
  readonly initialMarginRupees: number | null;
  /** Broker `final` basket margin (₹) — margin WITH the spread benefit, once all legs exist. */
  readonly finalMarginRupees: number | null;
}): { readonly stages: readonly FundingStage[]; readonly hedgeFirstValid: boolean; readonly unknown: readonly string[] } {
  const byRole = new Map(args.requests.map((r) => [String(r.role), r]));
  const ordered = [...args.transportOrder].sort((a, b) => a.rank - b.rank);
  const stages: FundingStage[] = [];
  const unknown: string[] = [];
  let debitPaise = 0;
  let creditPaise = 0;
  let seenSell = false;
  let hedgeFirstValid = true;
  let index = 0;

  for (const slot of ordered) {
    const request = byRole.get(slot.role);
    if (slot.side === "SELL") seenSell = true;
    else if (seenSell) hedgeFirstValid = false; // a BUY after a SELL breaks hedge-first
    const limit = request?.pricing?.limit_price;
    const qty = request?.quantity;
    const priced = request !== undefined && Number.isFinite(limit) && (limit as number) > 0 &&
      Number.isFinite(qty) && (qty as number) > 0;
    if (priced) {
      const legPaise = Math.abs(toPaise(limit as number) * (qty as number));
      if (slot.side === "BUY") debitPaise += legPaise;
      else creditPaise += legPaise;
    }

    // While hedges are going out, the completed-basket spread benefit does NOT exist. Only the
    // FINAL stage — every leg on the book — may use the `final` figure.
    //
    // A figure is usable as a stage basis only when it is a CREDIBLE requirement: present,
    // finite, and strictly positive. The positivity test is load-bearing, not cosmetic. A
    // four-leg box always contains SHORT options, so a required margin of exactly ₹0 is not a
    // real answer — it is what a fabricated stand-in looks like. Defect B fabricated exactly
    // that (`span ?? 0`), and because `Number.isFinite(0)` is true the old test admitted it,
    // took `margin_basis: "initial_basket"`, and then computed
    // `Math.max(0, cumulative BUY premium)` — the gross premium, which this very function's
    // other branch correctly says "does NOT bound a margin requirement". The adapter no longer
    // manufactures that zero; this guard means the stage model cannot be fooled by one from any
    // future source either. Zerodha's own basket example uses the same convention
    // (`normalizeDhanMultiMargin` already rejects a non-positive total).
    const isFinalStage = index === ordered.length - 1;
    const usableFigure = (value: number | null): number | null =>
      value !== null && Number.isFinite(value) && value > 0 ? value : null;
    const finalFigure = usableFigure(args.finalMarginRupees);
    const initialFigure = usableFigure(args.initialMarginRupees);
    const marginBasis: FundingStage["margin_basis"] = isFinalStage
      ? finalFigure !== null
        ? "final_basket"
        : "unknown"
      : initialFigure !== null
        ? "initial_basket"
        : "unknown";
    const marginRupees =
      marginBasis === "final_basket" ? finalFigure : marginBasis === "initial_basket" ? initialFigure : null;

    const premiumDue = priced || request === undefined ? fromPaise(debitPaise) : null;
    let requirement: number | null = null;
    let note: string;
    if (!priced) {
      note = `${slot.role} is unpriced or missing from the plan; its stage requirement is UNKNOWN`;
      unknown.push(`${slot.role}:unpriced`);
    } else if (marginRupees === null) {
      note =
        `no broker ${isFinalStage ? "final" : "initial"} basket-margin figure is available, so the ` +
        `funding requirement at stage ${index} (${slot.role}) is UNKNOWN — refusing is the only ` +
        "honest answer; gross premium does NOT bound a margin requirement";
      unknown.push(`${slot.role}:no_${isFinalStage ? "final" : "initial"}_margin`);
    } else {
      // FLOOR, not sum: the broker total already contains an option-premium component.
      requirement = Math.max(marginRupees, premiumDue ?? 0);
      note =
        `stage ${index}: after sending ${slot.side} ${slot.role}, cumulative BUY premium payable is ` +
        `₹${premiumDue}; applicable broker figure is the ${marginBasis === "final_basket" ? "FINAL (spread-benefit)" : "INITIAL (no spread benefit)"} ` +
        `basket margin ₹${marginRupees}. Requirement is the greater of the two (the broker total already ` +
        "includes an option-premium component, so they are not added).";
    }
    stages.push({
      index,
      role: slot.role,
      side: slot.side,
      hedge: slot.side === "BUY",
      cumulative_premium_debit_rupees: priced ? fromPaise(debitPaise) : null,
      cumulative_premium_credit_rupees: priced ? fromPaise(creditPaise) : null,
      margin_basis: marginBasis,
      requirement_rupees: requirement,
      known: requirement !== null,
      note,
    });
    index++;
  }
  if (!hedgeFirstValid) unknown.push("sequence:not_hedge_first");
  return { stages, hedgeFirstValid, unknown };
}

/**
 * The complete, HONEST economic picture of a candidate box — all five quantities, each with its
 * own provenance, none substituted for another.
 *
 * This is a REPORT, not a gate: {@link evaluateEconomicAdmission} decides admission from it. The
 * separation matters because the report is also what diagnostics display, and an operator must
 * be able to see, for instance, that funds are ample but the margin fetch is stale.
 */
export interface EconomicPicture {
  /** #1 Available broker funds. */
  readonly available_funds: EconomicFigure;
  /** #2 Margin required by the planned execution sequence (broker basket estimate). */
  readonly planned_margin: EconomicFigure;
  /** #3 Peak temporary exposure during the legging window. */
  readonly peak_legging_exposure: EconomicFigure;
  /** #4 Gross order notional — the existing metric, unchanged label. */
  readonly gross_notional: EconomicFigure;
  /** #5 Bounded worst-case entry cost. */
  readonly worst_case_entry: EconomicFigure;
  /** The underlying gross-notional metric object, for the leg breakdown. */
  readonly gross_notional_metrics: BoxCapitalMetrics;
  /**
   * Section 8: the stage-by-stage funding requirement of the REAL hedge-first sequence, with
   * initial and final basket margin preserved SEPARATELY. Null when no margin evidence at all was
   * supplied (in which case the funding controls have nothing to judge and refuse).
   */
  readonly funding: FundingPicture | null;
}

/**
 * Assemble the quantities into one picture from ALREADY-AGED observations.
 *
 * PEAK LEGGING EXPOSURE is derived from the bounded requests, NOT from the broker margin: while
 * legging, before the offsetting legs both exist, the account can be exposed to as much as the
 * gross cost of the legs already sent. We therefore bound #3 by the gross notional (#4) as a
 * conservative upper bound and label it an estimate — the true peak depends on fill order, which
 * the execution-sequence owner (orderManager) knows and this pure module deliberately does not.
 *
 * `now` is the WALL-clock evaluation instant, used only for the audit stamp on local estimates.
 * FRESHNESS IS NOT DECIDED HERE — the caller passes {@link AgedEvidence} produced by
 * `ageEvidence()`, which owns the single coherent clock model. That is the fix for the reported
 * defect: this function can no longer subtract two wall readings taken across an `await`.
 */
export function buildEconomicPicture(args: {
  readonly requests: readonly BoxCapitalOrderLike[];
  readonly now: number;
  readonly availableFundsRupees?: number | null;
  /**
   * How the spendable-funds figure was derived from the broker's raw fields (see
   * box/fundsSemantics.ts). Surfaced in the figure's note so a refusal explains its own arithmetic.
   */
  readonly availableFundsBasis?: string | null;
  readonly availableFundsAged: AgedEvidence;
  readonly availableFundsObservedAtWall?: number | null;
  readonly availableFundsObservedAtMono?: number | null;
  readonly plannedMarginRupees?: number | null;
  readonly plannedMarginAged: AgedEvidence;
  readonly plannedMarginObservedAtWall?: number | null;
  readonly plannedMarginObservedAtMono?: number | null;
  readonly planFingerprint?: string | null;
  readonly estimatedChargesRupees?: number | null;
  readonly expectedLegCount?: number;
  /** Section 8 inputs. Absent ⇒ `funding` is null and the funding controls refuse. */
  readonly funding?: {
    readonly transportOrder: readonly { readonly role: string; readonly side: OrderSide; readonly rank: number }[];
    readonly initialMarginRupees: number | null;
    readonly finalMarginRupees: number | null;
    /** ₹ blocked by existing open orders/positions, when observable. Null ⇒ unknown, not zero. */
    readonly encumbranceRupees: number | null;
    /**
     * Whether `availableFundsRupees` above already has the encumbrance deducted. Forwarded to
     * {@link buildFundingPicture}; see its `encumbranceNettedFromAvailableFunds` for why counting
     * the same blocked rupees on both sides of the comparison was wrong.
     */
    readonly encumbranceNettedFromAvailableFunds?: boolean;
    /** Operator-configured reserve kept back for recovery actions (₹). */
    readonly recoveryReserveRupees: number;
  };
}): EconomicPicture {
  const metrics = grossEntryOrderNotional(args.requests, args.expectedLegCount ?? 4);
  const worst = worstCaseEntryCost(args.requests, args.estimatedChargesRupees ?? null);

  const available_funds = brokerFigure({
    valueRupees: args.availableFundsRupees ?? null,
    aged: args.availableFundsAged,
    observedAtWall: args.availableFundsObservedAtWall ?? null,
    observedAtMono: args.availableFundsObservedAtMono ?? null,
    // The note carries HOW the figure was derived from the broker's fields, because "available
    // funds ₹X" is not self-explanatory when the broker's own semantics decide whether the
    // encumbrance has already been taken out. An operator reading a refusal needs to see the
    // arithmetic, and — when the semantics are unverified — that the conservative reading was used.
    confirmedNote:
      args.availableFundsBasis ??
      "broker-confirmed available funds for this account/session",
  });
  const planned_margin = brokerFigure({
    valueRupees: args.plannedMarginRupees ?? null,
    aged: args.plannedMarginAged,
    observedAtWall: args.plannedMarginObservedAtWall ?? null,
    observedAtMono: args.plannedMarginObservedAtMono ?? null,
    planFingerprint: args.planFingerprint ?? null,
    confirmedNote:
      "broker basket-margin estimate for the four-leg sequence (Kite basket / Dhan multi). " +
      "An ESTIMATE of the requirement — it does NOT guarantee the broker will accept the orders.",
  });

  return {
    available_funds,
    planned_margin,
    peak_legging_exposure: estimateFigure(
      metrics.complete ? metrics.gross_entry_order_notional_rupees : null,
      args.now,
      "peak temporary exposure during legging, bounded ABOVE by gross notional; the true peak " +
        "depends on fill order which this pure module does not observe.",
    ),
    gross_notional: estimateFigure(
      metrics.complete ? metrics.gross_entry_order_notional_rupees : null,
      args.now,
      "gross option-order notional from the bounded LIMIT requests (existing metric).",
    ),
    worst_case_entry: estimateFigure(
      worst.complete ? worst.gross_cost_rupees : null,
      args.now,
      "bounded worst-case gross entry cost from the LIMIT requests.",
    ),
    gross_notional_metrics: metrics,
    funding: args.funding
      ? buildFundingPicture({
          requests: args.requests,
          now: args.now,
          plannedMarginAged: args.plannedMarginAged,
          planFingerprint: args.planFingerprint ?? null,
          estimatedChargesRupees: args.estimatedChargesRupees ?? null,
          ...args.funding,
        })
      : null,
  };
}

/** Assemble the section-8 funding figures. Exported for direct testing of the stage model. */
export function buildFundingPicture(args: {
  readonly requests: readonly BoxCapitalOrderLike[];
  readonly now: number;
  readonly transportOrder: readonly { readonly role: string; readonly side: OrderSide; readonly rank: number }[];
  readonly initialMarginRupees: number | null;
  readonly finalMarginRupees: number | null;
  readonly encumbranceRupees: number | null;
  /**
   * Whether the AVAILABLE-FUNDS figure this requirement will be compared against has ALREADY had
   * the encumbrance deducted from it.
   *
   * ANTI-DOUBLE-COUNT. `usableFundsRupees` always yields SPENDABLE funds — it passes `available`
   * through for a broker documented as net of encumbrance, and subtracts the utilisation for a
   * broker that is gross or whose semantics are unverified. Adding the same utilisation into the
   * requirement as well charged the account twice for money that was blocked once:
   *     available(A − U) ≥ requirement(R + U)   ⟺   A ≥ R + 2U
   * The error is conservative in direction, so it never admitted an unaffordable entry — but it
   * refused affordable ones by an amount that grows with unrelated activity on the same account,
   * and it made the published arithmetic wrong, which is worse in a figure operators reason with.
   *
   * `true` (what the production gateway passes, because it derives funds via `usableFundsRupees`)
   * means the encumbrance is reported for diagnostics but NOT re-added here. `false` preserves the
   * additive behaviour for a caller that supplies a genuinely GROSS available figure.
   *
   * The fail-closed property is unchanged and simply lives on the correct side of the comparison:
   * when a broker's semantics require the encumbrance and it is missing, `usableFundsRupees`
   * returns no funds figure at all, so admission still refuses.
   */
  readonly encumbranceNettedFromAvailableFunds?: boolean;
  readonly recoveryReserveRupees: number;
  readonly plannedMarginAged: AgedEvidence;
  readonly planFingerprint: string | null;
  readonly estimatedChargesRupees: number | null;
}): FundingPicture {
  const { stages, hedgeFirstValid, unknown } = buildFundingStages({
    requests: args.requests,
    transportOrder: args.transportOrder,
    initialMarginRupees: args.initialMarginRupees,
    finalMarginRupees: args.finalMarginRupees,
  });

  const marginUsable = args.plannedMarginAged.status === "usable";
  const marginNote = marginUsable
    ? args.plannedMarginAged.note
    : `broker margin evidence is ${args.plannedMarginAged.status}: ${args.plannedMarginAged.note}`;

  const initial_basket_margin: EconomicFigure = figureOrUnknown(
    args.initialMarginRupees,
    marginUsable,
    args.planFingerprint,
    "broker INITIAL basket margin — the margin required to EXECUTE the orders, WITHOUT the spread " +
      "benefit. This is the figure that applies while legging, because the completed structure does " +
      "not exist yet.",
    marginNote,
  );
  const final_basket_margin: EconomicFigure = figureOrUnknown(
    args.finalMarginRupees,
    marginUsable,
    args.planFingerprint,
    "broker FINAL basket margin — the margin WITH the spread benefit, applicable only once every " +
      "leg is on the book. NOT proof that the account can fund the sequence that creates it.",
    marginNote,
  );

  // The BUY hedge premium: cash the account must be able to pay before ANY sale proceeds exist.
  const hedgePremium = hedgePremiumRupees(args.requests, args.transportOrder);
  const hedge_premium_requirement: EconomicFigure = hedgePremium === null
    ? unknownFigure(
        "the BUY hedge premium could not be computed (an unpriced hedge leg); UNKNOWN, never ₹0",
      )
    : {
        value_rupees: hedgePremium,
        provenance: "estimate",
        observed_at: args.now,
        observed_at_mono: null,
        age_ms: 0,
        age_is_monotonic: false,
        usable: true,
        plan_fingerprint: args.planFingerprint,
        note:
          `premium payable by the BUY hedge legs before any SELL proceeds exist (₹${hedgePremium}). ` +
          "Computed from the bounded LIMIT requests, so it is an upper bound on the hedge debit.",
      };

  const knownStageRequirements = stages
    .map((s) => s.requirement_rupees)
    .filter((v): v is number => v !== null);
  const worstStage = knownStageRequirements.length ? Math.max(...knownStageRequirements) : null;
  const stagesComplete = unknown.length === 0 && stages.length > 0;

  const intermediate_stage_requirement: EconomicFigure = !stagesComplete || worstStage === null
    ? unknownFigure(
        "the intermediate execution-stage requirement is UNKNOWN: " +
          (unknown.length ? unknown.join("; ") : "no stages could be modelled") +
          ". Refusing the supervised entry profile is the only honest response.",
      )
    : {
        value_rupees: worstStage,
        provenance: marginUsable ? "broker_confirmed" : "stale",
        observed_at: args.now,
        observed_at_mono: null,
        age_ms: args.plannedMarginAged.age_ms,
        age_is_monotonic: args.plannedMarginAged.age_is_monotonic,
        usable: marginUsable,
        plan_fingerprint: args.planFingerprint,
        note:
          `the WORST stage of the ${stages.length}-stage hedge-first sequence requires ₹${worstStage}. ` +
          "This — not the completed-basket final margin — is what the account must be able to fund.",
      };

  const encumbrance: EconomicFigure = args.encumbranceRupees === null || !Number.isFinite(args.encumbranceRupees)
    ? unknownFigure(
        "₹ blocked by existing open orders/positions is UNKNOWN (the broker facility did not report " +
          "it). Treated as unknown, never as ₹0: other activity on this account can consume the same " +
          "available-funds allowance.",
      )
    : {
        value_rupees: args.encumbranceRupees,
        provenance: "broker_confirmed",
        observed_at: args.now,
        observed_at_mono: null,
        age_ms: args.plannedMarginAged.age_ms,
        age_is_monotonic: args.plannedMarginAged.age_is_monotonic,
        usable: true,
        plan_fingerprint: null,
        note: "₹ already blocked by open orders/positions on this account.",
      };

  const estimated_charges: EconomicFigure =
    args.estimatedChargesRupees !== null && Number.isFinite(args.estimatedChargesRupees)
      ? {
          value_rupees: args.estimatedChargesRupees,
          provenance: "estimate",
          observed_at: args.now,
          observed_at_mono: null,
          age_ms: 0,
          age_is_monotonic: false,
          usable: true,
          plan_fingerprint: args.planFingerprint,
          note: "locally estimated brokerage/statutory charges for the four entry legs.",
        }
      : unknownFigure("estimated charges are UNKNOWN (no local fee calculator result).");

  const reserve = Number.isFinite(args.recoveryReserveRupees) && args.recoveryReserveRupees >= 0
    ? args.recoveryReserveRupees
    : 0;
  const recovery_reserve: EconomicFigure = {
    value_rupees: reserve,
    provenance: "estimate",
    observed_at: args.now,
    observed_at_mono: null,
    age_ms: 0,
    age_is_monotonic: false,
    usable: true,
    plan_fingerprint: null,
    note:
      `operator-configured reserve of ₹${reserve} held back so a recovery action (cancel, unwind, ` +
      "complete) is not blocked by having spent every rupee on the entry.",
  };

  // The BINDING requirement. Deliberately conservative and additive across INDEPENDENT costs:
  // the worst execution stage, plus charges, plus the recovery reserve.
  //
  // THE ENCUMBRANCE IS INCLUDED ONLY IF IT IS NOT ALREADY NETTED OUT OF AVAILABLE FUNDS. See
  // `encumbranceNettedFromAvailableFunds`: counting it on both sides charged the account twice for
  // the same blocked rupees. When it IS already netted, an unknown encumbrance no longer has to
  // poison this total either — because in that case the funds side is the thing that fails closed,
  // and it does.
  const encumbranceCountedHere = args.encumbranceNettedFromAvailableFunds !== true;
  const parts: (number | null)[] = [
    intermediate_stage_requirement.usable ? intermediate_stage_requirement.value_rupees : null,
    estimated_charges.value_rupees,
    recovery_reserve.value_rupees,
    ...(encumbranceCountedHere ? [encumbrance.value_rupees] : []),
  ];
  const binding = parts.some((p) => p === null)
    ? null
    : parts.reduce<number>((sum, p) => sum + (p as number), 0);
  const binding_requirement: EconomicFigure = binding === null
    ? unknownFigure(
        "the binding funding requirement is UNKNOWN because at least one component is unknown " +
          `(worst stage: ${intermediate_stage_requirement.value_rupees ?? "unknown"}, charges: ` +
          `${estimated_charges.value_rupees ?? "unknown"}` +
          (encumbranceCountedHere
            ? `, encumbrance: ${encumbrance.value_rupees ?? "unknown"}`
            : " — the encumbrance is already netted out of available funds and is not a component here") +
          "). The supervised entry profile must be refused rather than admitted on a guess.",
      )
    : {
        value_rupees: binding,
        provenance: marginUsable ? "broker_confirmed" : "stale",
        observed_at: args.now,
        observed_at_mono: null,
        age_ms: args.plannedMarginAged.age_ms,
        age_is_monotonic: args.plannedMarginAged.age_is_monotonic,
        usable: marginUsable,
        plan_fingerprint: args.planFingerprint,
        note:
          `worst stage ₹${intermediate_stage_requirement.value_rupees} + charges ` +
          `₹${estimated_charges.value_rupees} + recovery reserve ₹${recovery_reserve.value_rupees}` +
          (encumbranceCountedHere
            ? ` + encumbrance ₹${encumbrance.value_rupees}`
            : ` (encumbrance ₹${encumbrance.value_rupees ?? "unknown"} is NOT added here — it is already ` +
              "deducted from the available-funds figure, and counting it twice would overstate the requirement)") +
          ` = ₹${binding}. This is what available funds are compared against — NOT the ` +
          "completed-basket final margin.",
      };

  return {
    initial_basket_margin,
    final_basket_margin,
    hedge_premium_requirement,
    intermediate_stage_requirement,
    encumbrance,
    estimated_charges,
    recovery_reserve,
    binding_requirement,
    stages,
    hedge_first_sequence_valid: hedgeFirstValid,
    unknown_stages: unknown,
  };
}

function unknownFigure(note: string): EconomicFigure {
  return {
    value_rupees: null,
    provenance: "unavailable",
    observed_at: null,
    observed_at_mono: null,
    age_ms: null,
    age_is_monotonic: false,
    usable: false,
    plan_fingerprint: null,
    note,
  };
}

function figureOrUnknown(
  valueRupees: number | null,
  usable: boolean,
  planFingerprint: string | null,
  confirmedNote: string,
  agedNote: string,
): EconomicFigure {
  if (valueRupees === null || !Number.isFinite(valueRupees)) {
    return unknownFigure(`${confirmedNote} — NOT AVAILABLE: ${agedNote}`);
  }
  return {
    value_rupees: valueRupees,
    provenance: usable ? "broker_confirmed" : "stale",
    observed_at: null,
    observed_at_mono: null,
    age_ms: null,
    age_is_monotonic: false,
    usable,
    plan_fingerprint: planFingerprint,
    note: usable ? confirmedNote : `${confirmedNote} — NOT USABLE: ${agedNote}`,
  };
}

/** Premium payable by the BUY (hedge) legs, or null when any hedge leg is unpriced. */
function hedgePremiumRupees(
  requests: readonly BoxCapitalOrderLike[],
  transportOrder: readonly { readonly role: string; readonly side: OrderSide; readonly rank: number }[],
): number | null {
  const hedgeRoles = new Set(transportOrder.filter((s) => s.side === "BUY").map((s) => s.role));
  if (hedgeRoles.size === 0) return null;
  let paise = 0;
  let seen = 0;
  for (const r of requests) {
    if (!hedgeRoles.has(String(r.role))) continue;
    const limit = r.pricing?.limit_price;
    if (!Number.isFinite(limit) || (limit as number) <= 0 || !Number.isFinite(r.quantity) || r.quantity <= 0) {
      return null;
    }
    paise += Math.abs(toPaise(limit as number) * r.quantity);
    seen++;
  }
  return seen === hedgeRoles.size ? fromPaise(paise) : null;
}

/** Why an economic admission was refused. Distinct, non-conflated reasons. */
export type EconomicRefusalReason =
  | "gross_notional_over_cap"
  | "insufficient_available_funds"
  | "margin_evidence_stale_or_missing"
  | "margin_evidence_invalid"
  | "funds_evidence_invalid"
  | "funding_stage_unknown"
  | "hedge_sequence_invalid"
  | "metric_incomplete";

export interface EconomicAdmissionReport {
  readonly allowed: boolean;
  readonly reasons: readonly EconomicRefusalReason[];
  readonly detail: string | null;
  readonly picture: EconomicPicture;
  /** Whether each configured control was ENABLED (a control with no config is skipped). */
  readonly controls: {
    readonly gross_cap_enabled: boolean;
    readonly funds_check_enabled: boolean;
    readonly margin_evidence_required: boolean;
    /** Section 8: require every hedge-first funding stage to be establishable. */
    readonly stage_funding_required: boolean;
  };
  /** WALL-clock instant the decision was made — captured AFTER the evidence reads resolved. */
  readonly evaluated_at: number;
  /** The order plan this decision is about. Re-checked at the send boundary. */
  readonly plan_fingerprint: string | null;
  /** Broker/account/session the evidence was read under, in non-secret form. */
  readonly evidence_context: EvidenceIdentity | null;
  /** How long each evidence read took (monotonic ms), for instrumentation. */
  readonly read_elapsed_ms: { readonly funds: number | null; readonly margin: number | null };
}

/**
 * Evaluate the configured economic controls against the picture, BEFORE any leg is sent. Each
 * control is independent and fails CLOSED:
 *
 *   - `grossCapRupees > 0`: refuse if gross notional (#4) exceeds it, or is incomplete. (Same
 *     semantics as {@link evaluateBoxCapitalAdmission}; kept in step deliberately.)
 *   - `requireFundsCover`: refuse unless AVAILABLE FUNDS (#1) are usable AND cover the BINDING
 *     STAGE REQUIREMENT (section 8) when the funding model could be built, else the planned margin,
 *     else the worst-case entry cost. Never admits on a stale/unavailable/invalid funds figure.
 *   - `requireMarginEvidence`: refuse unless the planned-margin figure (#2) is broker-confirmed
 *     and fresh. This is the "do not admit on an estimate alone" control.
 *   - `requireStageFunding`: refuse unless EVERY stage of the real hedge-first sequence has an
 *     establishable requirement AND the sequence is genuinely hedge-first. This is the control that
 *     stops `final` (completed-basket, spread-benefit) margin being used as proof that the account
 *     can fund the sequence that creates the box.
 *
 * Returning MULTIPLE reasons is intentional: an operator debugging a refusal should see every
 * failing control at once, not fix one and rediscover the next.
 */
export function evaluateEconomicAdmission(args: {
  readonly picture: EconomicPicture;
  readonly grossCapRupees: number;
  readonly requireFundsCover: boolean;
  readonly requireMarginEvidence: boolean;
  readonly requireStageFunding?: boolean;
  readonly evaluatedAt?: number;
  readonly planFingerprint?: string | null;
  readonly evidenceContext?: EvidenceIdentity | null;
  readonly readElapsedMs?: { readonly funds: number | null; readonly margin: number | null };
}): EconomicAdmissionReport {
  const { picture } = args;
  const reasons: EconomicRefusalReason[] = [];
  const details: string[] = [];

  const grossCapEnabled = Number.isFinite(args.grossCapRupees) && args.grossCapRupees > 0;
  if (grossCapEnabled) {
    if (!picture.gross_notional_metrics.complete) {
      reasons.push("metric_incomplete");
      details.push(
        `cannot verify the ₹${args.grossCapRupees} gross cap: ` +
          `${picture.gross_notional_metrics.incomplete_reason ?? "metric incomplete"}`,
      );
    } else {
      const overCap =
        picture.gross_notional_metrics.gross_entry_order_notional_paise > toPaise(args.grossCapRupees);
      if (overCap) {
        reasons.push("gross_notional_over_cap");
        details.push(
          `gross_entry_order_notional_rupees ₹${picture.gross_notional_metrics.gross_entry_order_notional_rupees} ` +
            `exceeds the configured gross cap ₹${args.grossCapRupees} (gross option-order notional, NOT broker margin)`,
        );
      }
    }
  }

  if (args.requireMarginEvidence && !picture.planned_margin.usable) {
    // INVALID is reported distinctly from STALE: "the clock or the account changed" is a different
    // operational problem from "the figure is too old", and an operator must be able to tell them
    // apart without reading the note.
    if (picture.planned_margin.provenance === "invalid") {
      reasons.push("margin_evidence_invalid");
      details.push(`planned-margin evidence is INVALID: ${picture.planned_margin.note}`);
    } else {
      reasons.push("margin_evidence_stale_or_missing");
      details.push(
        `planned-margin evidence is not usable (${picture.planned_margin.provenance}); ` +
          "refusing rather than admitting on an estimate or a stale figure",
      );
    }
  }

  const stageFundingRequired = args.requireStageFunding === true;
  /*
   * STAGE FUNDING IMPLIES THE FUNDS-COVER CHECK. This is structural, not a configuration
   * convention, because the configuration convention was silently violable.
   *
   * THE CONTRADICTORY COMBINATION: BOX_LIVE_REQUIRE_STAGE_FUNDING=true with
   * BOX_LIVE_REQUIRE_FUNDS_COVER=false. The stage block below verifies that every stage of the real
   * hedge-first sequence has an establishable requirement and that the sequence is genuinely
   * hedge-first — and then stops. The comparison of the resulting requirement against the account's
   * usable funds lives ENTIRELY inside the `requireFundsCover` block, so with that flag off the
   * deployment computed a precise stage requirement, satisfied itself the sequence was safe, and
   * never once checked that the account could pay for it. A configuration that reads as the
   * strictest available while omitting the only check that involves money is worse than one that
   * reads as lax, because it is trusted.
   *
   * Asking for the stage model IS asking to be held to it, so the funds comparison is now implied.
   * `controls.funds_check_enabled` below reports the EFFECTIVE value, so the published control
   * surface cannot claim the check is off while it is running.
   */
  const fundsCoverRequired = args.requireFundsCover || stageFundingRequired;
  if (stageFundingRequired) {
    const funding = picture.funding;
    if (!funding) {
      reasons.push("funding_stage_unknown");
      details.push(
        "no stage-by-stage funding model could be built (no broker initial/final basket margin was " +
          "supplied); the supervised entry profile is refused rather than admitted on the completed-" +
          "basket figure",
      );
    } else {
      if (!funding.hedge_first_sequence_valid) {
        reasons.push("hedge_sequence_invalid");
        details.push(
          "the transmitted sequence is not hedge-first (a BUY hedge would follow a SELL); refusing " +
            "because an uncovered SELL must never be sent first",
        );
      }
      if (funding.unknown_stages.length > 0 || !funding.binding_requirement.usable) {
        reasons.push("funding_stage_unknown");
        details.push(
          `at least one funding stage is UNKNOWN [${funding.unknown_stages.join(", ")}]: ` +
            funding.binding_requirement.note,
        );
      }
    }
  }

  if (fundsCoverRequired) {
    if (picture.available_funds.provenance === "invalid") {
      reasons.push("funds_evidence_invalid");
      details.push(`available-funds evidence is INVALID: ${picture.available_funds.note}`);
    } else if (!picture.available_funds.usable || picture.available_funds.value_rupees === null) {
      reasons.push("insufficient_available_funds");
      details.push(
        `available funds not usable (${picture.available_funds.provenance}); ` +
          "cannot prove the account can fund this entry",
      );
    } else {
      // Require funds to cover the strongest requirement we can prove, in DESCENDING order of
      // fidelity to the real sequence:
      //   1. the section-8 binding stage requirement (worst stage + charges + reserve + encumbrance)
      //   2. the broker basket margin, if usable
      //   3. the conservative worst-case entry cost
      // NEVER the (smaller) net debit, and never the FINAL completed-basket margin alone.
      const funding = picture.funding;
      const bindingUsable =
        funding?.binding_requirement.usable === true && funding.binding_requirement.value_rupees !== null;
      const marginUsable = picture.planned_margin.usable && picture.planned_margin.value_rupees !== null;
      // THE GROSS-PREMIUM FALLBACK IS GONE.
      //
      // Step 3 used to be `picture.worst_case_entry.value_rupees` — the gross cost of the BUY
      // legs. For a structure whose short legs are the reason margin exists at all, option
      // premium does not bound the requirement: a box's premium outlay can be a small fraction
      // of the margin its short options attract. Comparing funds against it and calling the
      // result "funds cover" authorised entries the account could not fund, and did so with a
      // number that looks like diligence.
      //
      // There are now exactly TWO admissible bases, both real requirements:
      //   1. the section-8 binding stage requirement (worst stage + charges + reserve + encumbrance)
      //   2. the broker basket margin, if usable
      // With neither, the requirement is UNKNOWN and admission refuses `metric_incomplete`. That
      // is a refusal to take new exposure, not a claim that the box is unaffordable.
      const need = bindingUsable
        ? (funding as NonNullable<typeof funding>).binding_requirement.value_rupees
        : marginUsable
          ? picture.planned_margin.value_rupees
          : null;
      const basis = bindingUsable ? "binding hedge-first stage requirement" : "broker margin";
      if (need === null) {
        reasons.push("metric_incomplete");
        details.push(
          "cannot compute a funding requirement: neither a usable hedge-first stage requirement nor a " +
            "usable broker basket margin is available. Gross option premium is NOT used as a substitute — " +
            "it does not bound the margin a short option requires — so entry is refused until real " +
            "margin evidence is obtained.",
        );
      } else if (picture.available_funds.value_rupees < need) {
        reasons.push("insufficient_available_funds");
        details.push(
          `available funds ₹${picture.available_funds.value_rupees} < required ₹${need} (${basis})`,
        );
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    detail: details.length ? details.join("; ") : null,
    picture,
    controls: {
      gross_cap_enabled: grossCapEnabled,
      // The EFFECTIVE value, so the published control surface cannot claim the funds check is
      // off while stage funding is silently running it.
      funds_check_enabled: fundsCoverRequired,
      margin_evidence_required: args.requireMarginEvidence,
      stage_funding_required: stageFundingRequired,
    },
    evaluated_at: args.evaluatedAt ?? 0,
    plan_fingerprint: args.planFingerprint ?? null,
    evidence_context: args.evidenceContext ?? null,
    read_elapsed_ms: args.readElapsedMs ?? { funds: null, margin: null },
  };
}

/**
 * The recovery/completion policy once a box is PARTIALLY EXPOSED.
 *
 * The task requires that once legs are on the book we stop chasing the ORIGINAL profit threshold
 * and instead complete or unwind on a recovery basis. This is a pure decision helper the
 * execution owner can consult; it does not itself place orders (it cannot — this module owns no
 * transport). It keeps the one-lot rule: it never proposes resizing a partially filled box.
 */
export type RecoveryAction = "complete_remaining_legs" | "unwind_filled_legs" | "hold_and_reassess";

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  readonly reason: string;
  /** Always true here: the policy never resizes a box into a different strategy. */
  readonly one_lot_preserved: true;
}

/**
 * Decide what to do with a partially-exposed box.
 *
 *   - If completing the remaining legs is still feasible within funds/margin evidence, complete
 *     them — a hedged box is cheaper to hold than a naked partial.
 *   - If the remaining legs can no longer be proven affordable, UNWIND the filled legs rather
 *     than chase the original edge: an unhedged partial is the exposure we most want to shed.
 *   - If evidence is merely stale (not disproven), HOLD and reassess when fresh evidence
 *     arrives, rather than act on a stale number.
 */
export function decidePartialRecovery(args: {
  readonly remainingLegsPriceable: boolean;
  readonly completionAffordable: boolean;
  readonly marginEvidenceUsable: boolean;
}): RecoveryDecision {
  if (!args.marginEvidenceUsable) {
    return {
      action: "hold_and_reassess",
      reason:
        "margin/funds evidence is stale or missing; holding a partial and reassessing on fresh " +
        "evidence is safer than acting on an unverified number",
      one_lot_preserved: true,
    };
  }
  if (args.remainingLegsPriceable && args.completionAffordable) {
    return {
      action: "complete_remaining_legs",
      reason: "completing the hedge is affordable; a completed box carries less risk than a naked partial",
      one_lot_preserved: true,
    };
  }
  return {
    action: "unwind_filled_legs",
    reason:
      "the remaining legs cannot be proven affordable/priceable; unwinding the filled legs sheds " +
      "the unhedged exposure rather than chasing the original profit threshold",
    one_lot_preserved: true,
  };
}
