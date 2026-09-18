/**
 * THE REGRESSION THIS SUITE EXISTS FOR.
 *
 * A live paper_legging deployment reported:
 *
 *     ATTEMPTS 355   SUCCESSFUL 0   FAILED 355   FAILURE RATE 100%
 *     Rejection categories:  UNKNOWN_INTERNAL_ERROR 354   CROSS_LEG_TIME_SKEW 1
 *
 * Nothing had crashed. The session's attempt budget was spent, so every candidate was refused with
 * `session_limit_reached` — a correct, deliberate, well-documented refusal. But `session_limit_reached`
 * was one of SIX members of `BoxExecutionFailureReason` that had never been added to `MARKET_REASONS`,
 * so the cardinality backstop in `BoxMetrics.finishLogicalAttempt` rewrote all 354 of them to
 * `unknown_internal_error` — and the operator was sent hunting a crash that never happened.
 *
 * Two independent failures, tested separately below:
 *   1. the label taxonomy had drifted behind the reason union (§1, §2);
 *   2. even with the right label, NOTHING anywhere carried the SYMBOL — `rejection_categories` is a
 *      metric label space and cannot, `box_execution_attempts` rows are only written once a leg has
 *      filled, and the `ENTRY_REJECTED_*` events are throttled per candidate (§3 onward).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOX_PARENT_ATTEMPT_REASONS,
  isBoxParentAttemptReason,
} from "../../dist/box/executionFaults.js";
import { EntryAlertLedger, emptyEntryAlerts, entryAlertMeta } from "../../dist/box/entryAlerts.js";
import { BoxMetrics } from "../../dist/box/metrics.js";

/** A ledger on a clock the test drives, so ordering assertions are exact rather than timing-dependent. */
function ledgerAt(start = 1_000_000, opts = {}) {
  let now = start;
  const ledger = new EntryAlertLedger({ now: () => now, ...opts });
  return { ledger, tick: (ms) => { now += ms; }, at: () => now };
}

/* ══════════════════ §1 the six reasons that were being folded away ══════════════════ */

/**
 * THE EXACT BUG. Each of these is a real refusal an operator must be able to read, and each was
 * absent from the closed label set and therefore reported as "unknown internal error".
 */
const PREVIOUSLY_FOLDED = [
  "session_limit_reached",
  "underlying_excluded",
  "box_inventory_limit",
  "box_capital_limit",
  "underlying_already_active",
  "execution_mode_mismatch",
];

test("§1 the six previously-folded refusal reasons are now admissible metric labels", () => {
  for (const reason of PREVIOUSLY_FOLDED) {
    assert.ok(
      isBoxParentAttemptReason(reason),
      `${reason} is a real BoxExecutionFailureReason and must be an admissible label — folding it ` +
        `into unknown_internal_error is what made a spent session budget look like a crash`,
    );
    assert.ok(
      BOX_PARENT_ATTEMPT_REASONS.includes(reason),
      `${reason} must appear in the published closed set`,
    );
  }
});

test("§1 a session-limit refusal is reported AS ITSELF, and folds nothing", () => {
  const metrics = new BoxMetrics(16);
  // Reproduce the shape of the real run: many identical admission refusals, one skew refusal.
  for (let i = 0; i < 354; i++) {
    metrics.beginLogicalAttempt(`entry:NIFTY|k${i}`);
    metrics.finishLogicalAttempt(`entry:NIFTY|k${i}`, "FAILED", "session_limit_reached");
  }
  metrics.beginLogicalAttempt("entry:NIFTY|skew");
  metrics.finishLogicalAttempt("entry:NIFTY|skew", "FAILED", "cross_leg_time_skew");

  const { execution } = metrics.snapshot();
  assert.equal(execution.attempted, 355);
  assert.equal(execution.failed, 355);
  assert.equal(
    execution.rejection_categories.session_limit_reached,
    354,
    "the honest reason must be the label",
  );
  assert.equal(execution.rejection_categories.cross_leg_time_skew, 1);
  assert.equal(
    execution.rejection_categories.unknown_internal_error,
    undefined,
    "nothing should land in unknown_internal_error — that bucket is for genuinely unclassifiable faults",
  );
  assert.equal(
    execution.unclassified_rejection_labels,
    0,
    "a non-zero drift counter means the taxonomy is behind the reason union again",
  );
});

test("§1 the drift counter still bites for a genuinely unknown label", () => {
  // The backstop must remain a backstop: widening the taxonomy must not disable it.
  const metrics = new BoxMetrics(4);
  metrics.beginLogicalAttempt("a");
  metrics.finishLogicalAttempt("a", "FAILED", "not_a_real_reason_at_all");
  const { execution } = metrics.snapshot();
  assert.equal(execution.rejection_categories.unknown_internal_error, 1);
  assert.equal(execution.unclassified_rejection_labels, 1);
});

/* ══════════════════ §2 the taxonomy cannot drift again ══════════════════ */

test("§2 EVERY admissible reason has a category and a remedy", () => {
  for (const reason of BOX_PARENT_ATTEMPT_REASONS) {
    const meta = entryAlertMeta(reason);
    assert.ok(meta, `${reason} has no alert metadata`);
    assert.ok(
      ["market", "operator_action", "infrastructure", "fault"].includes(meta.category),
      `${reason} has an unknown category ${meta.category}`,
    );
    assert.ok(
      typeof meta.remedy === "string" && meta.remedy.trim().length > 10,
      `${reason} must carry a real remedy sentence — "no action" is an acceptable remedy, silence is not`,
    );
  }
});

test("§2 the admission refusals are classified as needing a HUMAN, not as market churn", () => {
  // The distinction is the whole point of the categories: an operator must be able to tell
  // "the market moved" (ignore) from "your session budget is spent" (nothing will ever trade).
  for (const reason of ["session_limit_reached", "underlying_excluded", "box_inventory_limit", "box_capital_limit"]) {
    assert.equal(entryAlertMeta(reason).category, "operator_action", `${reason} needs an operator`);
  }
  for (const reason of ["price_moved", "edge_disappeared", "below_expected_net_profit"]) {
    assert.equal(entryAlertMeta(reason).category, "market", `${reason} is ordinary churn`);
  }
  assert.equal(entryAlertMeta("feed_unhealthy").category, "infrastructure");
  assert.equal(entryAlertMeta("execution_simulator_error").category, "fault");
});

/* ══════════════════ §3 aggregation: 354 refusals are ONE fact with a count ══════════════════ */

test("§3 repeated refusals of one name aggregate into a single counted group", () => {
  const { ledger, tick } = ledgerAt();
  for (let i = 0; i < 354; i++) {
    ledger.record({
      underlying: "NIFTY",
      reason: "session_limit_reached",
      detail: `attempt ${i}`,
      candidateKey: `NIFTY|2026-09-24|24000|24200|LONG`,
    });
    tick(10);
  }
  const snap = ledger.snapshot();
  assert.equal(snap.total_alerts, 1, "one name, one reason — one group, not 354 notifications");
  assert.equal(snap.alerts[0].count, 354, "the count must be exact, never throttled or sampled");
  assert.equal(snap.total_rejections, 354);
  assert.equal(snap.alerts[0].underlying, "NIFTY");
  assert.equal(snap.alerts[0].reason, "session_limit_reached");
  // first_at/last_at must bracket the run, so a long-standing condition is distinguishable from a new one.
  assert.equal(snap.alerts[0].first_at, 1_000_000);
  assert.equal(snap.alerts[0].last_at, 1_000_000 + 353 * 10);
  assert.equal(snap.alerts[0].last_detail, "attempt 353", "the NEWEST detail wins, not the first");
  assert.equal(snap.latest_at, snap.alerts[0].last_at);
});

test("§3 the same name refused for DIFFERENT reasons stays separate", () => {
  const { ledger } = ledgerAt();
  ledger.record({ underlying: "NIFTY", reason: "session_limit_reached" });
  ledger.record({ underlying: "NIFTY", reason: "feed_unhealthy" });
  ledger.record({ underlying: "BANKNIFTY", reason: "session_limit_reached" });
  const snap = ledger.snapshot();
  assert.equal(snap.total_alerts, 3, "collapsing these would hide either a name or a cause");
  assert.equal(snap.total_rejections, 3);
});

test("§3 a blank underlying is named honestly rather than creating an unusable group", () => {
  const { ledger } = ledgerAt();
  ledger.record({ underlying: "   ", reason: "price_moved" });
  assert.equal(ledger.snapshot().alerts[0].underlying, "(unknown)");
});

test("§3 an unrecognised reason is recorded, not dropped", () => {
  const { ledger } = ledgerAt();
  ledger.record({ underlying: "NIFTY", reason: "nonsense_reason" });
  const snap = ledger.snapshot();
  assert.equal(snap.total_alerts, 1);
  assert.equal(snap.alerts[0].reason, "unknown_internal_error", "drift stays visible, matching the metric backstop");
});

/* ══════════════════ §4 the badge must not cry wolf ══════════════════ */

test("§4 actionable counts EXCLUDE ordinary market churn", () => {
  const { ledger } = ledgerAt();
  for (let i = 0; i < 50; i++) ledger.record({ underlying: `X${i}`, reason: "price_moved" });
  ledger.record({ underlying: "NIFTY", reason: "session_limit_reached" });
  ledger.record({ underlying: "NIFTY", reason: "session_limit_reached" });
  const snap = ledger.snapshot();
  assert.equal(snap.total_alerts, 51);
  assert.equal(
    snap.actionable_alerts,
    1,
    "badging all 51 would make the bell ring permanently for price movement, which teaches an operator to ignore it",
  );
  assert.equal(snap.actionable_rejections, 2);
  assert.equal(snap.alerts.filter((a) => a.actionable).length, 1);
});

/* ══════════════════ §5 ordering is urgency-first and TOTAL ══════════════════ */

test("§5 faults sort above infrastructure, above operator action, above market churn", () => {
  const { ledger, tick } = ledgerAt();
  // Recorded in the OPPOSITE order to the expected output, so a pass cannot be insertion order.
  ledger.record({ underlying: "AAA", reason: "price_moved" });
  tick(5);
  ledger.record({ underlying: "BBB", reason: "session_limit_reached" });
  tick(5);
  ledger.record({ underlying: "CCC", reason: "feed_unhealthy" });
  tick(5);
  ledger.record({ underlying: "DDD", reason: "execution_simulator_error" });
  const categories = ledger.snapshot().alerts.map((a) => a.category);
  assert.deepEqual(categories, ["fault", "infrastructure", "operator_action", "market"]);
});

test("§5 the sort is total, so identical data never reshuffles between polls", () => {
  const { ledger } = ledgerAt();
  // Same category, same timestamp, same count — only the name and reason can break the tie.
  ledger.record({ underlying: "ZZZ", reason: "price_moved" });
  ledger.record({ underlying: "AAA", reason: "price_moved" });
  ledger.record({ underlying: "MMM", reason: "edge_disappeared" });
  const first = ledger.snapshot().alerts.map((a) => `${a.underlying}:${a.reason}`);
  const second = ledger.snapshot().alerts.map((a) => `${a.underlying}:${a.reason}`);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["AAA:price_moved", "MMM:edge_disappeared", "ZZZ:price_moved"]);
});

/* ══════════════════ §6 bounded, and honest about being bounded ══════════════════ */

test("§6 the group cap holds and the truncation is PUBLISHED, not hidden", () => {
  // A tiny cap makes the eviction policy assertable; production uses 300.
  const { ledger, tick } = ledgerAt(1_000_000, { maxGroups: 3 });
  ledger.record({ underlying: "OLD", reason: "price_moved" });
  tick(100);
  ledger.record({ underlying: "MID", reason: "price_moved" });
  tick(100);
  ledger.record({ underlying: "NEW", reason: "price_moved" });
  tick(100);
  assert.equal(ledger.size, 3);
  assert.equal(ledger.snapshot().dropped_groups, 0);

  // A fourth distinct group must evict the LEAST RECENTLY ACTIVE one — oldest-first discards what
  // has stopped happening, rather than silently discarding a whole class of problem.
  ledger.record({ underlying: "NEWEST", reason: "price_moved" });
  const snap = ledger.snapshot();
  assert.equal(ledger.size, 3, "the cap is what makes keying by symbol safe here");
  assert.equal(snap.dropped_groups, 1, "a silent bound would just be a different kind of lie");
  assert.deepEqual(
    snap.alerts.map((a) => a.underlying).sort(),
    ["MID", "NEW", "NEWEST"],
    "OLD was the least recently active and must be the one evicted",
  );
});

test("§6 an existing group keeps counting after the cap is reached", () => {
  const { ledger } = ledgerAt(1_000_000, { maxGroups: 2 });
  ledger.record({ underlying: "A", reason: "price_moved" });
  ledger.record({ underlying: "B", reason: "price_moved" });
  for (let i = 0; i < 10; i++) ledger.record({ underlying: "A", reason: "price_moved" });
  const snap = ledger.snapshot();
  assert.equal(snap.dropped_groups, 0, "counting a KNOWN group must never trigger an eviction");
  assert.equal(snap.alerts.find((a) => a.underlying === "A").count, 11);
});

test("§6 detail strings are bounded and whitespace-collapsed", () => {
  const { ledger } = ledgerAt();
  ledger.record({ underlying: "NIFTY", reason: "price_moved", detail: `a${"b".repeat(500)}` });
  const detail = ledger.snapshot().alerts[0].last_detail;
  assert.ok(detail.length <= 240, `detail must be bounded, got ${detail.length}`);
  assert.ok(detail.endsWith("…"), "truncation must be visible");

  const { ledger: l2 } = ledgerAt();
  l2.record({ underlying: "NIFTY", reason: "price_moved", detail: "  too   many\n\tspaces  " });
  assert.equal(l2.snapshot().alerts[0].last_detail, "too many spaces");
});

/* ══════════════════ §7 lifecycle ══════════════════ */

test("§7 reset forgets everything — one broker's refusals are not another's", () => {
  const { ledger } = ledgerAt();
  ledger.record({ underlying: "NIFTY", reason: "session_limit_reached" });
  ledger.reset();
  const snap = ledger.snapshot();
  assert.equal(snap.total_alerts, 0);
  assert.equal(snap.total_rejections, 0);
  assert.equal(snap.dropped_groups, 0);
  assert.equal(snap.latest_at, null);
  assert.deepEqual(snap, emptyEntryAlerts());
});

test("§7 an empty ledger publishes zeros and a null timestamp, never a missing field", () => {
  const { ledger } = ledgerAt();
  const snap = ledger.snapshot();
  // The schema declares every one of these REQUIRED, so absence is a contract violation.
  for (const key of [
    "alerts",
    "total_alerts",
    "total_rejections",
    "actionable_alerts",
    "actionable_rejections",
    "dropped_groups",
    "latest_at",
  ]) {
    assert.ok(key in snap, `${key} must always be present`);
  }
  assert.equal(snap.latest_at, null, "null means never — it must not be faked as 0");
});
