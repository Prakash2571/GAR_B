/**
 * SUITE — MULTI-WINDOW ORDER BUDGETS, RECOVERY RESERVE, AND Retry-After.  (Task 8)
 *
 * The per-second min-interval (proven in brokerPacing.test.mjs) only bounds one window. These
 * tests pin the four correctness properties the min-interval alone cannot give:
 *
 *   1. The CORRECTED per-second order budget matches the official docs (10/s, not >10/s).
 *   2. A recovery cancel/modify still has budget after placement has saturated its share.
 *   3. Retry-After cooldowns are honoured and never shortened.
 *   4. A rate-limit signal NEVER causes a mutation to be replayed — the ledger only gates NEW
 *      requests; it exposes no "resend" path at all.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BROKER_RATE_LIMITS,
  brokerRateLimits,
  DEFAULT_ORDER_BUDGET_POLICY,
  isOrderEndpoint,
  isRateLimited,
  parseRetryAfterMs,
  placementBudgets,
  RateBudgetLedger,
  resolveOrderBudgetPolicy,
} from "../../dist/box/brokerPacing.js";

// ── the corrected published limits ───────────────────────────────────────────────────────

test("the published order limits are frozen and match the official docs (verified 2026-09-09)", () => {
  assert.ok(Object.isFrozen(BROKER_RATE_LIMITS));

  const z = BROKER_RATE_LIMITS.zerodha;
  assert.equal(z.perSecond.limit, 10, "Kite: 10 order req/sec");
  assert.equal(z.perMinute.limit, 400, "Kite: 400 orders/min");
  assert.equal(z.perDay.limit, 5_000, "Kite: 5000 orders/day");
  assert.equal(z.maxModificationsPerOrder, 25);
  assert.match(z.sourceUrl, /kite\.trade\/docs\/connect\/v3/);

  const d = BROKER_RATE_LIMITS.dhan;
  assert.equal(d.perSecond.limit, 10, "DhanHQ v2: 10 order req/sec — NOT more than 10");
  assert.equal(d.perMinute.limit, 250, "DhanHQ v2: 250 orders/min");
  assert.equal(d.perHour.limit, 1_000, "DhanHQ v2: 1000 orders/hour");
  assert.equal(d.perDay.limit, 7_000, "DhanHQ v2: 7000 orders/day");
  assert.equal(d.maxModificationsPerOrder, 25);
  assert.match(d.sourceUrl, /dhanhq\.co\/docs\/v2/);
});

test("THE CORRECTED DEFECT: Dhan per-second order budget is 10, never above", () => {
  // The prior code asserted Dhan permits "materially more than 10/s". Pin the corrected fact so
  // a regression to the old claim fails loudly.
  assert.equal(BROKER_RATE_LIMITS.dhan.perSecond.limit, 10);
  assert.ok(BROKER_RATE_LIMITS.dhan.perSecond.limit <= 10);
});

test("an unknown broker falls back to the STRICTEST limit per window, not to no limit", () => {
  const s = brokerRateLimits("mystery-broker");
  assert.equal(s.perSecond.limit, 10);
  assert.equal(s.perMinute.limit, 250, "min of 400 and 250");
  assert.equal(s.perDay.limit, 5_000, "min of 5000 and 7000");
  assert.equal(s.confirmed, false);
  assert.ok(s.unconfirmedNotes.length > 0);
});

test("endpoint classification: the three order classes are metered, data reads are not", () => {
  assert.equal(isOrderEndpoint("order_place"), true);
  assert.equal(isOrderEndpoint("order_modify"), true);
  assert.equal(isOrderEndpoint("order_cancel"), true);
  assert.equal(isOrderEndpoint("data_read"), false);
});

// ── placement vs recovery budgets ──────────────────────────────────────────────────────────

test("the recovery reserve is withheld from placement but available to recovery", () => {
  const budgets = placementBudgets(BROKER_RATE_LIMITS.dhan, { workerCount: 1, recoveryReserveFraction: 0.2 });
  const perMin = budgets.find((b) => b.window === "perMinute");
  assert.equal(perMin.accountLimit, 250);
  assert.equal(perMin.perWorkerLimit, 250);
  assert.equal(perMin.recoveryReserve, Math.ceil(250 * 0.2));
  assert.equal(perMin.placementLimit, 250 - Math.ceil(250 * 0.2));
  assert.ok(perMin.placementLimit < perMin.perWorkerLimit, "placement gets less than recovery");
});

test("sharing across workers divides the budget", () => {
  const one = placementBudgets(BROKER_RATE_LIMITS.dhan, { workerCount: 1, recoveryReserveFraction: 0 });
  const two = placementBudgets(BROKER_RATE_LIMITS.dhan, { workerCount: 2, recoveryReserveFraction: 0 });
  const oneMin = one.find((b) => b.window === "perMinute").perWorkerLimit;
  const twoMin = two.find((b) => b.window === "perMinute").perWorkerLimit;
  assert.equal(twoMin, Math.floor(oneMin / 2));
});

test("an unlimited window (Kite per-hour) carries null, never 0", () => {
  const budgets = placementBudgets(BROKER_RATE_LIMITS.zerodha);
  const perHour = budgets.find((b) => b.window === "perHour");
  assert.equal(perHour.accountLimit, null, "null = unlimited, not a cap of zero");
  assert.equal(perHour.placementLimit, null);
});

test("policy resolution clamps nonsense to safe defaults", () => {
  assert.equal(resolveOrderBudgetPolicy({ workerCount: 0 }).workerCount, 1);
  assert.equal(resolveOrderBudgetPolicy({ workerCount: -4 }).workerCount, 1);
  assert.equal(resolveOrderBudgetPolicy({ recoveryReserveFraction: 0.9 }).recoveryReserveFraction,
    DEFAULT_ORDER_BUDGET_POLICY.recoveryReserveFraction, "over 0.5 is rejected");
  assert.equal(resolveOrderBudgetPolicy({ recoveryReserveFraction: -1 }).recoveryReserveFraction,
    DEFAULT_ORDER_BUDGET_POLICY.recoveryReserveFraction);
  assert.equal(resolveOrderBudgetPolicy({ recoveryReserveFraction: 0.3 }).recoveryReserveFraction, 0.3);
});

// ── the ledger: per-second budget is enforced ───────────────────────────────────────────────

test("the corrected per-second placement budget is ENFORCED", () => {
  // Dhan 10/s, no reserve, one worker: exactly 10 placements per second, the 11th refused.
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.dhan, { workerCount: 1, recoveryReserveFraction: 0 });
  let now = 1_000_000;
  let placed = 0;
  for (let i = 0; i < 20; i++) {
    const d = ledger.check("order_place", now);
    if (d.allowed) {
      ledger.record("order_place", now);
      placed++;
    } else {
      assert.equal(d.bindingWindow, "perSecond");
      break;
    }
  }
  assert.equal(placed, 10, "exactly the published 10/s, then refused");
});

// ── recovery capacity survives placement saturation ─────────────────────────────────────────

test("a protective CANCEL still has budget after placement has saturated its share", () => {
  // 10/s, 20% reserve ⇒ placement ceiling = 10 - ceil(2) = 8. Fill placement to its ceiling;
  // a cancel must still be admitted because it may use the reserved 2 slots.
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.dhan, { workerCount: 1, recoveryReserveFraction: 0.2 });
  const now = 2_000_000;
  let placed = 0;
  while (ledger.check("order_place", now).allowed) {
    ledger.record("order_place", now);
    placed++;
    if (placed > 50) break; // safety
  }
  assert.equal(placed, 8, "placement stops at the reserved ceiling");
  // Placement is now refused...
  assert.equal(ledger.check("order_place", now).allowed, false);
  // ...but a recovery cancel still fits, spending into the reserve.
  const cancel = ledger.check("order_cancel", now);
  assert.equal(cancel.allowed, true, "recovery must survive placement saturation");
});

test("recovery is bounded by the per-worker limit, so it cannot exceed the ACCOUNT budget", () => {
  // Entry placement must never let total order traffic exceed the published account cap even
  // when recovery spends the reserve.
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.dhan, { workerCount: 1, recoveryReserveFraction: 0.2 });
  const now = 3_000_000;
  let total = 0;
  // Interleave placement then recovery until both refuse.
  while (true) {
    let progressed = false;
    if (ledger.check("order_place", now).allowed) { ledger.record("order_place", now); total++; progressed = true; }
    if (ledger.check("order_cancel", now).allowed) { ledger.record("order_cancel", now); total++; progressed = true; }
    if (!progressed || total > 100) break;
  }
  assert.equal(total, 10, "total order traffic never exceeds the 10/s account budget");
});

// ── Retry-After ──────────────────────────────────────────────────────────────────────────

test("parseRetryAfterMs handles delta-seconds, HTTP-date, and garbage", () => {
  const now = 1_700_000_000_000;
  assert.equal(parseRetryAfterMs("2", now), 2_000);
  assert.equal(parseRetryAfterMs("", now), null);
  assert.equal(parseRetryAfterMs(null, now), null);
  assert.equal(parseRetryAfterMs("not-a-date", now), null);
  // An HTTP-date 5s in the future.
  const future = new Date(now + 5_000).toUTCString();
  const parsed = parseRetryAfterMs(future, now);
  assert.ok(parsed >= 4_000 && parsed <= 5_000, `expected ~5000ms, got ${parsed}`);
  // A past date clamps to 0, never negative.
  const past = new Date(now - 10_000).toUTCString();
  assert.equal(parseRetryAfterMs(past, now), 0);
});

test("a Retry-After cooldown is HONOURED: all order requests refused until it elapses", () => {
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.zerodha);
  const now = 5_000_000;
  ledger.penalize(now, 3_000); // Retry-After: 3s
  assert.equal(ledger.inCooldown(now), true);
  assert.equal(ledger.check("order_place", now + 1_000).allowed, false, "still cooling down");
  assert.equal(ledger.check("order_cancel", now + 1_000).allowed, false, "even recovery waits out a 429");
  // After the cooldown, placement resumes.
  assert.equal(ledger.check("order_place", now + 3_001).allowed, true);
});

test("a second 429 during a cooldown EXTENDS it, never shortens it", () => {
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.zerodha);
  const now = 6_000_000;
  ledger.penalize(now, 5_000);       // until now+5000
  ledger.penalize(now + 1_000, 1_000); // would be until now+2000 — must NOT shorten
  assert.equal(ledger.check("order_place", now + 3_000).allowed, false, "the longer cooldown still holds");
  assert.equal(ledger.check("order_place", now + 5_001).allowed, true);
});

test("a 429 with no Retry-After applies a conservative one-second cooldown, not zero", () => {
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.zerodha);
  const now = 7_000_000;
  ledger.penalize(now, null);
  assert.equal(ledger.check("order_place", now + 500).allowed, false);
  assert.equal(ledger.check("order_place", now + 1_001).allowed, true);
});

// ── the no-replay invariant ────────────────────────────────────────────────────────────────

test("isRateLimited flags a 429 and nothing else — it is a cooldown signal, not a resend one", () => {
  assert.equal(isRateLimited(429), true);
  assert.equal(isRateLimited(200), false);
  assert.equal(isRateLimited(500), false);
  assert.equal(isRateLimited(null), false);
  assert.equal(isRateLimited(undefined), false);
});

test("the ledger exposes NO way to replay a mutation", () => {
  // The safety property is structural: the ledger's only mutating methods are check/record/
  // penalize/noteRefusal — none of which resend anything. A 429 must not become a resend.
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.dhan);
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ledger));
  assert.ok(!methods.some((m) => /replay|resend|retry/i.test(m)),
    `ledger must expose no replay/resend/retry method, found: ${methods.join(", ")}`);
});

// ── the unobservable-external-consumer limitation ───────────────────────────────────────────

test("the snapshot EXPOSES that external consumers are unobservable and requires coordination", () => {
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.dhan, { workerCount: 3, recoveryReserveFraction: 0.2 });
  const now = 8_000_000;
  ledger.record("order_place", now);
  ledger.noteRefusal("order_place");
  const snap = ledger.snapshot(now);
  assert.equal(snap.external_consumers_unobservable, true);
  assert.match(snap.external_consumers_note, /coordinat/i);
  assert.equal(snap.worker_count, 3);
  assert.equal(snap.confirmed, true);
  assert.equal(snap.verified_on, "2026-09-09");
  // The snapshot is bounded: fixed windows, no per-order detail.
  assert.equal(snap.windows.length, 4);
  const perSec = snap.windows.find((w) => w.window === "perSecond");
  assert.equal(perSec.account_limit, 10);
  assert.equal(perSec.used, 1);
});

test("data reads are never order-budget metered and cannot be starved by placement", () => {
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.dhan, { workerCount: 1, recoveryReserveFraction: 0 });
  const now = 9_000_000;
  for (let i = 0; i < 10; i++) ledger.record("order_place", now);
  assert.equal(ledger.check("order_place", now).allowed, false, "order budget exhausted");
  assert.equal(ledger.check("data_read", now).allowed, true, "a data read is not order-metered");
});


// ── a PROTECTIVE PLACEMENT may draw on the recovery reserve ──────────────────────────────────

/*
 * THE DEFECT THESE PIN.
 *
 * Reserve eligibility was inferred from the BROKER'S endpoint class alone:
 *
 *     const isRecovery = klass === "order_cancel" || klass === "order_modify";
 *
 * Every new order — including an EXIT and an EMERGENCY_RESIDUAL buyback that closes a naked short —
 * is metered by the broker as `order_place`. So a protective placement was held to the lower
 * placement ceiling and REFUSED while the recovery reserve sat unused, at precisely the moment the
 * reserve exists for. "Which endpoint the broker meters" and "does this order add or remove risk" are
 * different questions, and only the second one should decide who may spend the reserve.
 */

test("a protective PLACEMENT (an exit/buyback) may spend the recovery reserve", () => {
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.dhan, { workerCount: 1, recoveryReserveFraction: 0.2 });
  const now = 4_000_000;
  let placed = 0;
  while (ledger.check("order_place", now).allowed) {
    ledger.record("order_place", now);
    placed++;
    if (placed > 50) break;
  }
  assert.equal(placed, 8, "ordinary placement stops at the reserved ceiling");
  assert.equal(ledger.check("order_place", now).allowed, false, "a NEW-EXPOSURE placement is refused");

  // The same endpoint class, but this order REDUCES risk.
  const protectivePlacement = ledger.check("order_place", now, { protective: true });
  assert.equal(
    protectivePlacement.allowed,
    true,
    "a risk-reducing placement must reach the broker using the reserve",
  );
  assert.match(protectivePlacement.reason ?? "", /within all published windows/);
});

test("the reserve does NOT admit an entry, so `protective` cannot become a general bypass", () => {
  // Non-vacuous control: if `protective` were ignored (or defaulted true) this would fail.
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.dhan, { workerCount: 1, recoveryReserveFraction: 0.2 });
  const now = 5_000_000;
  while (ledger.check("order_place", now).allowed) ledger.record("order_place", now);

  assert.equal(ledger.check("order_place", now).allowed, false, "explicitly non-protective is refused");
  assert.equal(
    ledger.check("order_place", now, { protective: false }).allowed,
    false,
    "and `protective: false` is refused too",
  );
  const refusal = ledger.check("order_place", now, { protective: false });
  assert.match(refusal.reason ?? "", /reserve withheld/, "the reason says the reserve was withheld");
});

test("a protective placement is still bounded by the ACCOUNT budget", () => {
  // The reserve is a reservation WITHIN the published cap, never an extension of it. Protective
  // traffic must not be able to exceed what the broker permits.
  const ledger = new RateBudgetLedger(BROKER_RATE_LIMITS.dhan, { workerCount: 1, recoveryReserveFraction: 0.2 });
  const now = 6_000_000;
  let total = 0;
  while (ledger.check("order_place", now, { protective: true }).allowed && total <= 100) {
    ledger.record("order_place", now);
    total++;
  }
  assert.equal(total, 10, "protective placements still stop at the 10/s account budget");
});
