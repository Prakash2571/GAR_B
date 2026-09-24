/**
 * TECHNICAL FAULTS ARE NOT MARKET OUTCOMES.
 *
 * The parent-entry path used to collapse every thrown error into one label:
 *
 *     catch (err) { console.warn(...); finish("FAILED", "internal_error", ...) }
 *
 * so the dashboard could tell you that something broke 47 times and nothing else. A Mongo
 * outage, a missing live order manager, a durable-reservation authority failure and a genuine
 * programming bug were one indistinguishable bucket.
 *
 * The opposite mistake is just as bad: exposing `error.message` as the metric label. Exception
 * text is unbounded and attacker/market influenced, so it would turn a counter into an unbounded
 * label space — the classic cardinality explosion — and leak candidate keys and symbols into
 * telemetry.
 *
 * So this module defines a SMALL FIXED taxonomy (ten classes, closed set, `as const`), modelled
 * on the existing `REJECT_CLASSES` in `executionOutcomes.ts`, plus a bounded diagnostic log that
 * keeps the detail a human needs without ever becoming a metric label.
 *
 * THE RULE THIS ENFORCES
 * A programming error must NEVER be disguised as `edge_disappeared`, a liquidity rejection or a
 * fees rejection. Those are market outcomes and they are how the strategy is judged. A technical
 * fault is a technical fault, and it belongs in its own vocabulary.
 */

import type { BoxExecutionFailureReason } from "./types.js";

/**
 * Every way the entry pipeline can fail for a TECHNICAL reason.
 *
 * Deliberately minimal: one class per subsystem that can actually throw on this path, and one
 * honest "we could not classify this" bucket. Do not add a class without a subsystem to justify
 * it — a taxonomy nobody can reason about is only marginally better than `internal_error`.
 */
export const EXECUTION_FAULT_CLASSES = [
  /** Instrument reservation refused or failed for a non-authority reason. */
  "reservation_error",
  /**
   * The DURABLE reservation authority could not be consulted (Mongo down, index missing, no
   * server timestamp/fencing token). Distinct from `reservation_error` because it is the class
   * that must fail live entry closed while never blocking an exit.
   */
  "reservation_authority_unavailable",
  /** The execution gateway itself could not run (e.g. no live order manager wired). */
  "execution_gateway_error",
  /** The paper execution simulator threw. Always a modelling bug — paper is result-typed. */
  "execution_simulator_error",
  /** An execution invariant tripped: internal state was inconsistent, not the market. */
  "execution_invariant_error",
  /** The durable trade/attempt write failed or persistence is unavailable. */
  "trade_persistence_error",
  /** The in-memory position book refused or failed. */
  "position_book_error",
  /** The charge calculator could not price the legs. */
  "charge_calculation_error",
  /** The broker's state for our order is unknown/ambiguous, so nothing may be assumed. */
  "broker_state_error",
  /** Genuinely unclassified. A bug in this classifier, or a fault we have not met yet. */
  "unknown_internal_error",
] as const;

export type ExecutionFaultClass = (typeof EXECUTION_FAULT_CLASSES)[number];

const FAULT_CLASS_SET: ReadonlySet<string> = new Set(EXECUTION_FAULT_CLASSES);

/** Is this string one of the fixed fault classes? */
export function isExecutionFaultClass(value: string): value is ExecutionFaultClass {
  return FAULT_CLASS_SET.has(value);
}

/**
 * WHERE in the entry pipeline we were when the error escaped.
 *
 * The stage is known precisely by the caller (it advances a variable as it goes), so it is far
 * better evidence than any message match. Message inspection is used only to split classes that
 * genuinely share a stage.
 */
export const EXECUTION_STAGES = [
  "reservation",
  /** Local charge projection + the pre-execution decision. */
  "pre_decision",
  /** Inside the execution gateway / simulator / broker coordination. */
  "execution",
  /** The final expected-net qualification on the EXECUTED snapshot. */
  "final_qualification",
  /** Building the charge legs and persisting the durable trade. */
  "trade_persistence",
  /** Reserving/releasing the in-memory position book. */
  "position_book",
] as const;

export type ExecutionStage = (typeof EXECUTION_STAGES)[number];

/* --------------------------- message refinement --------------------------- */

// Conservative, anchored on wording the code itself produces (repository.ts, mongoStore.ts,
// executionGateway.ts, orderManager.ts). Anything unmatched falls through to the stage default,
// never to a market outcome.
const DURABLE_AUTHORITY = /reservation|fencing token|server timestamp|is missing the .* index|connection is not ready/i;
const PERSISTENCE = /persistence is unavailable|order intent|mongo|topology|E11000|server selection|write concern|disappeared/i;
const BROKER_UNKNOWN = /unknown|ambiguous|reconcil|uncertain|timed? ?out|quarantin/i;
const INVARIANT = /invariant|must never|overfill|regressed|impossible/i;
const GATEWAY = /execution manager is unavailable|live execution is blocked|no executable reference price/i;
const CHARGES = /charge|unpriced|fee|brokerage|stt|gst/i;

/** Best-effort message for anything thrown. Never throws itself. */
export function faultMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** The constructor name, which distinguishes a TypeError (a bug) from a domain Error. */
export function faultErrorType(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor.name || "Error";
  return typeof error;
}

/**
 * Classify one escaped error into the fixed taxonomy.
 *
 * STAGE FIRST, message second. A `TypeError` is always treated as a programming fault for its
 * stage rather than being pattern-matched into something reassuring.
 */
export function classifyExecutionFault(args: {
  stage: ExecutionStage;
  error: unknown;
}): ExecutionFaultClass {
  const message = faultMessage(args.error);
  const type = faultErrorType(args.error);
  const isProgrammingError = type === "TypeError" || type === "RangeError" || type === "ReferenceError";

  switch (args.stage) {
    case "reservation":
      if (DURABLE_AUTHORITY.test(message) || PERSISTENCE.test(message)) {
        return "reservation_authority_unavailable";
      }
      return isProgrammingError ? "execution_invariant_error" : "reservation_error";

    case "pre_decision":
    case "final_qualification":
      // These stages do exactly one thing: price the legs with the local calculator.
      return isProgrammingError ? "execution_invariant_error" : "charge_calculation_error";

    case "position_book":
      return isProgrammingError ? "execution_invariant_error" : "position_book_error";

    case "trade_persistence":
      if (CHARGES.test(message) && !PERSISTENCE.test(message)) return "charge_calculation_error";
      if (isProgrammingError) return "execution_invariant_error";
      return "trade_persistence_error";

    case "execution":
      // Several subsystems live behind this stage, so here — and only here — the message
      // legitimately refines the class.
      if (INVARIANT.test(message)) return "execution_invariant_error";
      if (BROKER_UNKNOWN.test(message)) return "broker_state_error";
      if (DURABLE_AUTHORITY.test(message)) return "reservation_authority_unavailable";
      if (PERSISTENCE.test(message)) return "trade_persistence_error";
      if (GATEWAY.test(message)) return "execution_gateway_error";
      if (CHARGES.test(message)) return "charge_calculation_error";
      // The paper simulator is result-typed and never throws by design, so a throw reaching
      // here in a paper mode is a modelling bug rather than a market event.
      return isProgrammingError ? "execution_simulator_error" : "execution_gateway_error";
  }
}

/* ---------------------------- bounded diagnostics -------------------------- */

/**
 * Redact anything that looks like a credential before it is stored or logged.
 *
 * Exported because the box HTTP boundary needs exactly this treatment for broker error text it passes
 * on to an operator (`routes.ts`): a broker message is useful and is also an untrusted string from
 * outside this process, so it is redacted and length-bounded rather than either trusted or discarded.
 */
export function sanitize(text: string, maxLength: number): string {
  const redacted = text
    .replace(/(api[_-]?key|access[_-]?token|authorization|password|secret|bearer)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]");
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

const MAX_MESSAGE = 400;
const MAX_STACK = 2_000;

/**
 * One technical fault, with the context an operator needs to act.
 *
 * `candidate_key` is here because logs and audit legitimately need it. It must NEVER become a
 * metric label or leave through the diagnostics endpoint — see {@link ExecutionFaultLog.publicRecent}.
 */
export interface ExecutionFaultEvent {
  at: number;
  fault_class: ExecutionFaultClass;
  stage: ExecutionStage;
  execution_mode: string;
  paper_profile: string;
  broker: string | null;
  error_type: string;
  message: string;
  stack: string | null;
  /** LOGS AND AUDIT ONLY. Never a metric label, never published over HTTP. */
  candidate_key: string;
  /** Was an instrument reservation held when this failed? */
  reservation_held: boolean;
  /** Did any filled exposure exist at the moment of failure? */
  exposure_existed: boolean;
  /** LIVE ONLY: did execution reach the broker? Null in paper, where there is no broker. */
  reached_broker: boolean | null;
}

/** The same event with the high-cardinality field removed, safe for the HTTP surface. */
export type PublicExecutionFaultEvent = Omit<ExecutionFaultEvent, "candidate_key" | "stack">;

/**
 * A bounded ring of recent technical faults plus fixed-key counters.
 *
 * Bounded on BOTH axes, which is the whole point: the ring is capped by entry count, and the
 * counters are capped by the closed taxonomy. Neither can grow with traffic, so this can be
 * exposed on an always-on endpoint without becoming a memory or cardinality liability.
 */
export class ExecutionFaultLog {
  private readonly events: ExecutionFaultEvent[] = [];
  private readonly byClass = new Map<ExecutionFaultClass, number>();
  private totalFaults = 0;

  constructor(private readonly maxEntries = 50) {}

  record(event: ExecutionFaultEvent): ExecutionFaultEvent {
    const stored: ExecutionFaultEvent = {
      ...event,
      message: sanitize(event.message, MAX_MESSAGE),
      stack: event.stack === null ? null : sanitize(event.stack, MAX_STACK),
    };
    this.events.push(stored);
    // Drop-oldest, so a fault storm cannot evict the counters or exhaust memory.
    if (this.events.length > this.maxEntries) this.events.splice(0, this.events.length - this.maxEntries);
    this.byClass.set(stored.fault_class, (this.byClass.get(stored.fault_class) ?? 0) + 1);
    this.totalFaults++;
    return stored;
  }

  /** Newest last. Full detail, including `candidate_key` — for logs, audit and tests. */
  recent(limit = this.maxEntries): ExecutionFaultEvent[] {
    return this.events.slice(-Math.max(0, limit));
  }

  /**
   * Newest last, with `candidate_key` and `stack` stripped.
   *
   * The diagnostics endpoint's standing rule is counts, percentiles and statuses only — never an
   * order id, execution id or symbol — so the identifying fields are removed here rather than
   * being trusted to every future caller.
   */
  publicRecent(limit = this.maxEntries): PublicExecutionFaultEvent[] {
    return this.recent(limit).map(({ candidate_key: _key, stack: _stack, ...rest }) => rest);
  }

  /** Every class with its count. Fixed keys, always all ten, so a zero is visible as a zero. */
  counts(): Record<ExecutionFaultClass, number> {
    const out = {} as Record<ExecutionFaultClass, number>;
    for (const cls of EXECUTION_FAULT_CLASSES) out[cls] = this.byClass.get(cls) ?? 0;
    return out;
  }

  get total(): number {
    return this.totalFaults;
  }
}

/* ------------------------- the parent-attempt label ------------------------ */

/**
 * Every label the parent ENTRY attempt may terminate with. A CLOSED union, so a stray string
 * cannot become a permanent metric key.
 *
 * `internal_error` is retained purely for backwards compatibility with dashboards and stored
 * history; nothing produces it any more — new technical faults get a real class.
 */
export type BoxParentAttemptReason =
  | BoxExecutionFailureReason
  | ExecutionFaultClass
  | "persistence_unavailable"
  /**
   * ALL FOUR legs filled and the Box could not be RECORDED — the qualification callback threw, or the
   * durable position insert failed. Distinct from `persistence_unavailable`, which describes a store
   * that could not be reached BEFORE exposure was taken: this one means exposure EXISTS at the broker
   * and we hold it without a position row. It is the most actionable reason in this taxonomy.
   */
  | "filled_exposure_unrecorded"
  | "internal_error";

/**
 * EVERY market/admission refusal reason, as an EXHAUSTIVE map rather than a hand-written list.
 *
 * WHY A MAP AND NOT AN ARRAY. This used to be `readonly BoxExecutionFailureReason[]`, which type-checks
 * a list that is missing entries just as happily as a complete one. Six reasons had been added to
 * `BoxExecutionFailureReason` over time without being added here — `box_capital_limit`,
 * `underlying_already_active`, `underlying_excluded`, `box_inventory_limit`, `session_limit_reached`
 * and `execution_mode_mismatch`. Every one of them is a REAL, correctly-reported refusal, and every
 * one of them was silently rewritten to `unknown_internal_error` by the cardinality backstop in
 * `BoxMetrics.finishLogicalAttempt`.
 *
 * The visible consequence was a dashboard reporting `UNKNOWN_INTERNAL_ERROR: 354` for a deployment
 * whose session attempt budget was simply spent — sending an operator hunting a crash that never
 * happened, while the one fact that would have explained it (`session_limit_reached`) was the one
 * fact being discarded. An honest "the session budget is used up" is actionable; "unknown internal
 * error" is not merely unhelpful, it is misleading about the KIND of problem.
 *
 * `Record<BoxExecutionFailureReason, true>` makes that class of drift a COMPILE ERROR: adding a member
 * to the union without adding it here fails the build. Do not replace this with an array.
 */
const MARKET_REASON_MAP: Record<BoxExecutionFailureReason, true> = {
  price_moved: true,
  insufficient_quantity: true,
  missing_book: true,
  feed_unhealthy: true,
  market_closed: true,
  edge_disappeared: true,
  below_expected_net_profit: true,
  discovery_stopped: true,
  duplicate: true,
  legging_incomplete: true,
  unwind_failed: true,
  cross_leg_time_skew: true,
  abort_after_fill: true,
  // The six that were missing. Each is an ADMISSION refusal decided before or instead of a fill,
  // and each names a different remedy, which is exactly why they must not share a bucket.
  box_capital_limit: true,
  underlying_already_active: true,
  underlying_excluded: true,
  box_inventory_limit: true,
  session_limit_reached: true,
  execution_mode_mismatch: true,
  lot_exceeds_quantity_cap: true,
  // Unowned broker exposure from a crash. An ADMISSION refusal like the six above, and it names a
  // remedy no other reason does: an operator must verify and flatten (or reconcile) real exposure.
  unowned_attributed_exposure: true,
};

const MARKET_REASONS: readonly BoxExecutionFailureReason[] = Object.keys(
  MARKET_REASON_MAP,
) as BoxExecutionFailureReason[];

/** The complete, closed set of admissible parent-attempt labels. */
export const BOX_PARENT_ATTEMPT_REASONS: readonly BoxParentAttemptReason[] = [
  ...MARKET_REASONS,
  ...EXECUTION_FAULT_CLASSES,
  "persistence_unavailable",
  "internal_error",
];

const REASON_SET: ReadonlySet<string> = new Set(BOX_PARENT_ATTEMPT_REASONS);

/** Runtime guard for the metric label space — the last line of defence against cardinality. */
export function isBoxParentAttemptReason(value: string): value is BoxParentAttemptReason {
  return REASON_SET.has(value);
}
