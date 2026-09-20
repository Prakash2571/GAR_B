/**
 * WHICH NAME WAS REFUSED, AND WHY — the operator-facing entry-rejection ledger.
 *
 * THE PROBLEM THIS EXISTS TO FIX
 *
 * A deployment could report `ATTEMPTS 355 / FAILED 355 / FAILURE RATE 100%` and, underneath it,
 * `UNKNOWN_INTERNAL_ERROR: 354` — and that was the ENTIRE account an operator was given. Three
 * separate things were wrong with it:
 *
 *   1. the label was a lie of omission (see `MARKET_REASON_MAP` in executionFaults.ts): a real
 *      refusal reason was being folded into "unknown internal error" because the metric's closed
 *      label set had drifted behind the reason union;
 *   2. `rejection_categories` is a COUNTER MAP. It can say "354 of something" but it structurally
 *      cannot say WHICH UNDERLYING, because putting a symbol in a metric label is exactly the
 *      cardinality explosion `executionFaults.ts` was written to prevent;
 *   3. the two places that DID carry a symbol both dropped it. `box_execution_attempts` rows are
 *      written only when `filled_leg_count > 0 || emergency_unwind` (scanner.ts), so a refusal that
 *      never touched the market — which is most of them — persists nothing at all; and the
 *      `ENTRY_REJECTED_*` ledger events are throttled per candidate by `REJECT_LOG_COOLDOWN_MS`, so
 *      a name refused 354 times in a row leaves a handful of rows.
 *
 * So the fact an operator most needs — "NIFTY was refused because the session attempt budget is
 * spent" — existed in the process and was thrown away three times over.
 *
 * WHAT THIS IS
 *
 * A bounded, AGGREGATED ledger keyed by (underlying, reason). Aggregation is the design, not an
 * optimisation: 354 identical refusals of the same name for the same reason are ONE fact with a
 * count of 354, and rendering them as 354 notifications would bury the three that differ. Each group
 * carries its own first/last timestamps, the most recent detail string, and a remedy sentence.
 *
 * WHY IT IS SAFE TO KEY BY UNDERLYING HERE, having been unsafe in `rejection_categories`
 *
 * This is NOT a metric label space. It is an explicitly bounded collection with a hard group cap and
 * an eviction policy (see `MAX_ALERT_GROUPS`), so its worst case is a fixed number of objects rather
 * than unbounded growth in a process-lifetime counter map. The underlying set is itself bounded by
 * the F&O universe, and the reason set is closed.
 *
 * DELIBERATELY NOT A TIME SERIES. The question is "what is being refused, and what do I do about
 * it?", not "plot refusals over time". Keeping a series would invite a chart implying a precision
 * these counts do not have, and would reintroduce the unbounded growth this file avoids.
 */

import type { BoxParentAttemptReason } from "./executionFaults.js";

/**
 * WHAT KIND of problem this is — which decides whether the operator must act.
 *
 * The categories exist because a bell that rings equally for "the price moved" and "your session
 * budget is spent" trains an operator to ignore it. Ordinary market churn is recorded but must never
 * demand attention; the other three categories mean nothing will trade until something changes.
 */
export type EntryAlertCategory =
  /**
   * NORMAL MARKET OUTCOMES. The strategy looked, the market moved or was not good enough, nothing is
   * broken. Recorded for completeness and explicitly NOT counted as actionable.
   */
  | "market"
  /**
   * A CONFIGURATION OR OPERATOR DECISION is refusing entry. Nothing is broken and nothing will trade
   * until the operator changes a setting, lifts an exclusion, closes a box or re-arms the session.
   * This is the category that was hiding inside `UNKNOWN_INTERNAL_ERROR`.
   */
  | "operator_action"
  /** A DEPENDENCY is unhealthy — feed, database. Not a code bug, not a market outcome. */
  | "infrastructure"
  /** A TECHNICAL FAULT: our own code or an unclassifiable failure. Always worth a human's attention. */
  | "fault";

/**
 * Reason → (category, remedy).
 *
 * EXHAUSTIVE BY CONSTRUCTION. `Record<BoxParentAttemptReason, ...>` means a new reason cannot be
 * added to the union without being classified here, which is precisely the drift that produced the
 * misleading dashboard in the first place. The remedy is a sentence an operator can act on; where the
 * honest remedy is "nothing, this is normal", it says so rather than inventing an action.
 */
const REASON_META: Record<
  BoxParentAttemptReason,
  { readonly category: EntryAlertCategory; readonly remedy: string }
> = {
  /* ── ordinary market outcomes ─────────────────────────────────────────────────────────── */
  price_moved: {
    category: "market",
    remedy: "No action. The book moved between detection and execution — normal in a live market.",
  },
  edge_disappeared: {
    category: "market",
    remedy: "No action. The arbitrage closed before the orders could be placed.",
  },
  below_expected_net_profit: {
    category: "market",
    remedy:
      "No action needed. The box no longer cleared the required expected net profit after costs. " +
      "Lower BOX_MIN_EXPECTED_NET_PROFIT only if you intend to accept thinner edges.",
  },
  insufficient_quantity: {
    category: "market",
    remedy: "No action. The executable depth could not fill one lot on every leg.",
  },
  missing_book: {
    category: "market",
    remedy:
      "No action if intermittent. A leg had no usable bid/ask — persistent cases usually mean an " +
      "illiquid strike rather than a fault.",
  },
  duplicate: {
    category: "market",
    remedy: "No action. The same strike pair was already being worked, and was correctly not entered twice.",
  },
  cross_leg_time_skew: {
    category: "market",
    remedy:
      // DELIBERATELY POINTS AT THE DETAIL rather than naming a cause. Two very different problems
      // share this reason, and the first version of this sentence named only one of them ("the four
      // legs' exchange timestamps were too far apart") while also saying "no action if rare" — which
      // is useless advice on a deployment refusing 100% of entries, and misleading when the binding
      // bound was receive-time. The detail line states which bound failed and by how much, so send
      // the operator there instead of guessing for them.
      "Read the detail: it names which bound failed. `exchange-timestamp dispersion 1000ms exceeds " +
      "250ms` is CONFIGURATION, not the market — Zerodha stamps books to the whole second, so any " +
      "BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS below 1000 refuses coherent books whenever the four " +
      "legs straddle a second boundary; set it to 1000. A larger multiple (2000ms+) means one leg's " +
      "book genuinely has not updated for seconds — usually an illiquid strike — and refusing is " +
      "correct. `receive-time dispersion` is a separate problem: the four books really did arrive " +
      "that far apart, which is worth investigating on the feed.",
  },
  abort_after_fill: {
    category: "market",
    remedy:
      "Review the realised cost. All four legs FILLED but the executed economics failed " +
      "re-qualification, so the position was immediately reversed — the round-trip cost is real.",
  },
  legging_incomplete: {
    category: "market",
    remedy:
      "Review. Some legs filled and were unwound within the legging timeout. Frequent occurrences " +
      "suggest the timeout or the chosen strikes are too optimistic for this name's liquidity.",
  },
  unwind_failed: {
    category: "fault",
    remedy:
      "ACT NOW. A filled leg could not be unwound, so real or simulated residual exposure may remain. " +
      "Check open positions and residual exposure before doing anything else.",
  },
  market_closed: {
    category: "market",
    remedy: "No action. The market is closed, so no entry is possible.",
  },
  discovery_stopped: {
    category: "market",
    remedy: "No action. The scanner was stopped, so the candidate was abandoned rather than entered.",
  },

  /* ── configuration / operator decisions ───────────────────────────────────────────────── */
  session_limit_reached: {
    category: "operator_action",
    remedy:
      "The armed session has spent its permitted attempts or box lifecycles " +
      "(BOX_SESSION_MAX_COMPLETED_TRADES / the session attempt budget). NOTHING WILL ENTER until you " +
      "arm a new session or raise the budget. Open positions are still monitored and can still exit.",
  },
  underlying_excluded: {
    category: "operator_action",
    remedy:
      "This name is on your blocklist, or the blocklist could not be read to confirm it is tradable. " +
      "Remove it from the excluded underlyings to allow entry.",
  },
  box_inventory_limit: {
    category: "operator_action",
    remedy:
      "BOX_MAX_OPEN_BOXES is already met, counting open positions, unresolved residuals and in-flight " +
      "entries. Close or resolve a box, or raise the ceiling.",
  },
  underlying_already_active: {
    category: "market",
    remedy:
      "Expected under BOX_ONE_ACTIVE_BOX_PER_UNDERLYING: this name already carries an active box, " +
      "partial position, residual or in-flight entry. Disable that setting only if you intend to run " +
      "concurrent boxes on one underlying.",
  },
  lot_exceeds_quantity_cap: {
    category: "operator_action",
    remedy:
      "This instrument's LOT SIZE is too large for your live quantity envelope — not a liquidity " +
      "problem, so the order book is the wrong place to look. Either raise " +
      "BOX_LIVE_MAX_OPEN_LEG_QUANTITY / BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY to carry that much per " +
      "leg, or exclude this underlying so the caps and the blocklist agree. Excluding is usually " +
      "right: a large lot means a proportionally larger naked position if one leg fails to fill.",
  },
  box_capital_limit: {
    category: "operator_action",
    remedy:
      "The four entry orders' GROSS NOTIONAL exceeded BOX_LIVE_MAX_BOX_CAPITAL_RUPEES, so nothing " +
      "reached the market. Raise that cap or trade a smaller/cheaper structure.",
  },
  execution_mode_mismatch: {
    category: "fault",
    remedy:
      "ACT NOW. A stored record's execution mode disagrees with this process across the paper/live " +
      "boundary, so the action was refused to avoid simulating away real exposure (or sending real " +
      "orders for a simulated one). Reconcile before trading.",
  },

  /* ── infrastructure ───────────────────────────────────────────────────────────────────── */
  feed_unhealthy: {
    category: "infrastructure",
    remedy:
      "The market-data feed is not healthy enough to execute on. Check the broker session and the " +
      "box lane socket — entry stays refused until depth is warm and flowing.",
  },
  persistence_unavailable: {
    category: "infrastructure",
    remedy:
      "The durable store could not be reached, so the attempt could not be recorded safely. Check " +
      "PostgreSQL health; entry fails closed by design.",
  },
  filled_exposure_unrecorded: {
    // NOT `infrastructure`: the database may be perfectly healthy and the position still unrecorded
    // (a qualification callback that threw, or a duplicate-open-box unique-index rejection). This
    // always needs a human, and it needs one NOW.
    category: "fault",
    remedy:
      "ACT NOW: all four legs FILLED at the broker but the Box was not recorded as an open position, " +
      "so this exposure has no position row and is not being exited by the position monitor. It was " +
      "deliberately NOT unwound and NOT released. New entry is blocked. Verify the four legs on the " +
      "broker terminal against the detail line, then reconcile — and reduce manually at the broker if " +
      "the residual flatten loop cannot.",
  },

  /* ── technical faults ─────────────────────────────────────────────────────────────────── */
  reservation_error: {
    category: "fault",
    remedy: "Instrument reservation refused or failed. Check the execution diagnostics endpoint for the stack.",
  },
  reservation_authority_unavailable: {
    category: "infrastructure",
    remedy:
      "The durable reservation authority could not be consulted, so live entry fails closed. Check " +
      "database health. Exits are deliberately never blocked by this.",
  },
  execution_gateway_error: {
    category: "fault",
    remedy: "The execution gateway could not run — often no live order manager wired. Check the deployment configuration.",
  },
  execution_simulator_error: {
    category: "fault",
    remedy: "The paper execution simulator threw. This is always a modelling bug — please report it with the stack.",
  },
  execution_invariant_error: {
    category: "fault",
    remedy: "An internal invariant tripped: engine state was inconsistent. This is a bug, not a market outcome.",
  },
  trade_persistence_error: {
    category: "infrastructure",
    remedy: "The durable trade/attempt write failed. Check database health and the outbox.",
  },
  position_book_error: {
    category: "fault",
    remedy: "The in-memory position book refused or failed. This is a bug; capture the diagnostics before restarting.",
  },
  charge_calculation_error: {
    category: "fault",
    remedy: "The charge calculator could not price the legs, so profitability could not be established honestly.",
  },
  broker_state_error: {
    category: "fault",
    remedy:
      "The broker's state for our order is unknown or ambiguous, so nothing was assumed. Reconcile " +
      "orders with the broker before re-arming.",
  },
  unknown_internal_error: {
    category: "fault",
    remedy:
      "Genuinely unclassified. If this appears with a real reason available, the classifier has " +
      "drifted — check `execution.unclassified_rejection_labels` and report it.",
  },
  internal_error: {
    category: "fault",
    remedy: "A legacy unclassified failure. Check the execution diagnostics endpoint for the stack.",
  },
};

/** Which categories mean "an operator must look at this". Market churn deliberately excluded. */
const ACTIONABLE: ReadonlySet<EntryAlertCategory> = new Set<EntryAlertCategory>([
  "operator_action",
  "infrastructure",
  "fault",
]);

/**
 * Hard cap on distinct (underlying, reason) groups.
 *
 * Sized to comfortably exceed the realistic worst case — the whole watched universe refused for a
 * couple of reasons at once — while still being a fixed ceiling. When full, the least recently active
 * group is evicted and the eviction is COUNTED and published, so a truncated list can never be
 * mistaken for a complete one.
 */
const MAX_ALERT_GROUPS = 300;

/** Detail strings are operator-facing, not a log sink. Bounded so one alert cannot dominate a response. */
const MAX_DETAIL_CHARS = 240;

/** One aggregated refusal: a name, a reason, and how often it happened. */
export interface EntryAlert {
  /** The underlying symbol that was refused (e.g. "NIFTY", "RELIANCE"). */
  readonly underlying: string;
  /** The refusal reason, from the closed parent-attempt taxonomy. */
  readonly reason: BoxParentAttemptReason;
  /** What kind of problem this is, and therefore whether it is actionable. */
  readonly category: EntryAlertCategory;
  /** True when this category means an operator should look. Precomputed so clients cannot disagree. */
  readonly actionable: boolean;
  /** How many times this exact (underlying, reason) pair was refused. */
  readonly count: number;
  /** Epoch ms of the first occurrence. */
  readonly first_at: number;
  /** Epoch ms of the most recent occurrence. */
  readonly last_at: number;
  /** The most recent detail from the refusing layer, bounded. Null when the layer supplied none. */
  readonly last_detail: string | null;
  /** The most recent candidate key, so a specific strike pair can be found. Null when unknown. */
  readonly last_candidate_key: string | null;
  /** What the operator should do about it. Always a real sentence, including "no action". */
  readonly remedy: string;
}

/** The published alert surface. */
export interface EntryAlertsSnapshot {
  /** The alert groups, most urgent first, then most recent first. Bounded by MAX_ALERT_GROUPS. */
  readonly alerts: readonly EntryAlert[];
  /** How many distinct (underlying, reason) groups are being tracked. */
  readonly total_alerts: number;
  /** The SUM of every group's count — total refusals observed since this process started. */
  readonly total_rejections: number;
  /** How many groups are actionable (everything except ordinary market churn). Drives the badge. */
  readonly actionable_alerts: number;
  /** Sum of counts across actionable groups only. */
  readonly actionable_rejections: number;
  /**
   * Groups evicted because the cap was reached. Non-zero means the list is TRUNCATED and older
   * refusals are missing — published so a partial list is never read as a complete one.
   */
  readonly dropped_groups: number;
  /** Epoch ms of the most recent refusal in the ledger, or null when there has never been one. */
  readonly latest_at: number | null;
}

export interface EntryAlertLedgerOptions {
  readonly now: () => number;
  /** Overridable only for tests; production always uses the module constant. */
  readonly maxGroups?: number;
}

/** A mutable group. Kept private; `EntryAlert` is the readonly published projection. */
interface AlertGroup {
  underlying: string;
  reason: BoxParentAttemptReason;
  count: number;
  firstAt: number;
  lastAt: number;
  lastDetail: string | null;
  lastCandidateKey: string | null;
}

/** Urgency order for presentation. Faults first — they are the ones that should never be scrolled past. */
const CATEGORY_RANK: Record<EntryAlertCategory, number> = {
  fault: 0,
  infrastructure: 1,
  operator_action: 2,
  market: 3,
};

/**
 * The standing entry-rejection ledger.
 *
 * One instance per engine. Not reset on RUN/STOP: an operator who stops the scanner to investigate
 * must still be able to read why it was refusing. Cleared explicitly via {@link reset} on a broker
 * switch, where the refusals belonged to a different account.
 */
export class EntryAlertLedger {
  private readonly groups = new Map<string, AlertGroup>();
  private droppedGroups = 0;
  private readonly opts: EntryAlertLedgerOptions;
  private readonly maxGroups: number;

  // Assigned explicitly rather than via a parameter property, so this module can be executed
  // directly from source by `node --experimental-strip-types` — the same discipline accountFunds.ts
  // follows, and for the same reason: the bounding and eviction rules must be assertable without a
  // broker, a database or a build step.
  constructor(opts: EntryAlertLedgerOptions) {
    this.opts = opts;
    this.maxGroups = opts.maxGroups ?? MAX_ALERT_GROUPS;
  }

  /**
   * Record one refused entry attempt.
   *
   * NEVER THROWS and never allocates unboundedly — it is called from the entry hot path, on a path
   * that is already handling a failure, so it must not be able to turn a refusal into a crash. An
   * unrecognised reason is recorded as `unknown_internal_error` rather than dropped, matching the
   * metrics backstop, so drift stays visible instead of silently shrinking the ledger.
   */
  record(args: {
    readonly underlying: string;
    readonly reason: BoxParentAttemptReason;
    readonly detail?: string | null;
    readonly candidateKey?: string | null;
  }): void {
    const at = this.opts.now();
    // An empty underlying would create a group nobody can act on; name it honestly instead.
    const underlying = args.underlying.trim() === "" ? "(unknown)" : args.underlying.trim();
    const reason: BoxParentAttemptReason =
      args.reason in REASON_META ? args.reason : "unknown_internal_error";
    const key = `${underlying}\u0000${reason}`;

    const existing = this.groups.get(key);
    if (existing) {
      existing.count++;
      existing.lastAt = at;
      // The LATEST detail wins. The newest occurrence is the one an operator is reacting to, and
      // keeping the first would leave a stale sentence beside a fresh timestamp.
      if (args.detail) existing.lastDetail = boundDetail(args.detail);
      if (args.candidateKey) existing.lastCandidateKey = args.candidateKey;
      return;
    }

    if (this.groups.size >= this.maxGroups) this.evictLeastRecent();

    this.groups.set(key, {
      underlying,
      reason,
      count: 1,
      firstAt: at,
      lastAt: at,
      lastDetail: args.detail ? boundDetail(args.detail) : null,
      lastCandidateKey: args.candidateKey ?? null,
    });
  }

  /**
   * Drop the least recently active group to make room.
   *
   * Chooses by `lastAt` rather than by category on purpose: evicting by category would silently
   * discard whole classes of problem, whereas oldest-first discards what has stopped happening. The
   * eviction is counted so the truncation is always visible in the snapshot.
   */
  private evictLeastRecent(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, group] of this.groups) {
      if (group.lastAt < oldestAt) {
        oldestAt = group.lastAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      this.groups.delete(oldestKey);
      this.droppedGroups++;
    }
  }

  /** Forget everything. Called on a broker switch: one account's refusals are not another's. */
  reset(): void {
    this.groups.clear();
    this.droppedGroups = 0;
  }

  /** How many distinct groups are held. Diagnostics and tests. */
  get size(): number {
    return this.groups.size;
  }

  /** Project into the published snapshot. Pure — safe to call from the status path. */
  snapshot(): EntryAlertsSnapshot {
    let totalRejections = 0;
    let actionableAlerts = 0;
    let actionableRejections = 0;
    let latestAt: number | null = null;

    const alerts: EntryAlert[] = [];
    for (const group of this.groups.values()) {
      const meta = REASON_META[group.reason];
      const actionable = ACTIONABLE.has(meta.category);
      totalRejections += group.count;
      if (actionable) {
        actionableAlerts++;
        actionableRejections += group.count;
      }
      if (latestAt === null || group.lastAt > latestAt) latestAt = group.lastAt;
      alerts.push({
        underlying: group.underlying,
        reason: group.reason,
        category: meta.category,
        actionable,
        count: group.count,
        first_at: group.firstAt,
        last_at: group.lastAt,
        last_detail: group.lastDetail,
        last_candidate_key: group.lastCandidateKey,
        remedy: meta.remedy,
      });
    }

    // Urgency first, then recency, then the name — the last key makes the order TOTAL, so a client
    // polling twice with identical data can never see rows shuffle.
    alerts.sort(
      (a, b) =>
        CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
        b.last_at - a.last_at ||
        b.count - a.count ||
        a.underlying.localeCompare(b.underlying) ||
        a.reason.localeCompare(b.reason),
    );

    return {
      alerts,
      total_alerts: alerts.length,
      total_rejections: totalRejections,
      actionable_alerts: actionableAlerts,
      actionable_rejections: actionableRejections,
      dropped_groups: this.droppedGroups,
      latest_at: latestAt,
    };
  }
}

/** An empty snapshot, for deployments/paths with no ledger wired. */
export function emptyEntryAlerts(): EntryAlertsSnapshot {
  return {
    alerts: [],
    total_alerts: 0,
    total_rejections: 0,
    actionable_alerts: 0,
    actionable_rejections: 0,
    dropped_groups: 0,
    latest_at: null,
  };
}

/** Collapse whitespace and bound the length. Details are shown to humans, not parsed. */
function boundDetail(detail: string): string {
  const collapsed = detail.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_DETAIL_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

/** The category/remedy for a reason. Exported so the contract test can assert exhaustiveness. */
export function entryAlertMeta(
  reason: BoxParentAttemptReason,
): { readonly category: EntryAlertCategory; readonly remedy: string } {
  return REASON_META[reason];
}
