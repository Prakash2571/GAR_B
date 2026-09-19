/**
 * LIVE-EXECUTION REVIEW FIXES — the three properties this change is responsible for.
 *
 * Each of these was found by tracing the live entry/exit paths rather than by a failing test, so each
 * needs a test that would have caught it:
 *
 *   1. THE COORDINATOR IS NOT OPTIONAL IN LIVE. `BOX_MAX_OPEN_BOXES` has exactly ONE enforcement
 *      point — the coordinator's entry prologue — and `simulateEntry`/`simulateLeggingEntry` delegate
 *      straight past it when `BOX_EXECUTION_COORDINATOR_ENABLED=false`. An operator who sets
 *      `BOX_MAX_OPEN_BOXES=1` because they cannot fund a second box, and separately turns the
 *      coordinator off, previously got NO ceiling and no indication of it.
 *
 *   2. A SETTLING EXECUTION MUST NOT CLEAR A SUCCESSOR'S DUPLICATE SUPPRESSION. `settle` and
 *      `holdOnUncertainty` each performed an UNGUARDED `activeOpportunities.delete(opportunityId)`
 *      after `abandon()` had already done the ownership-guarded one. Where a successor had claimed
 *      the same opportunity id, that second delete removed the SUCCESSOR's entry while it was still
 *      executing — re-opening the duplicate window on a live opportunity.
 *
 *   3. FREE CAPITAL IS REPORTED HONESTLY. Unknown must never render as ₹0, a stale figure must be
 *      kept and labelled rather than blanked, and the per-broker semantics must be applied once so
 *      the screen and the admission gate cannot disagree.
 *
 * Plain ESM against the COMPILED output in dist/, matching every other suite here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DIST = resolve(ROOT, "dist");

const { AccountFundsTracker, unavailableFunds } = await import(`${DIST}/box/accountFunds.js`);

/* ════════════════ 1. LIVE REQUIRES THE COORDINATOR ════════════════ */

/** Run `loadBoxConfig` under a temporary environment, restoring whatever was there. */
async function withEnv(overrides, fn) {
  const { loadBoxConfig } = await import(`${DIST}/box/config.js`);
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn(loadBoxConfig);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const LIVE = {
  BOX_EXECUTION_MODE: "live",
  BOX_LIVE_TRADING_ENABLED: "true",
  BOX_PAPER_EXECUTION_PROFILE: "standard",
  BOX_SHADOW_MODE_ENABLED: "false",
  // A live boot also requires a per-Box ₹ ceiling. It is the only MONETARY containment — the two
  // quantity ceilings bound LOTS, and a Box can satisfy both while committing an arbitrary rupee
  // amount, because notional is price × quantity — so `loadBoxConfig` refuses it disabled in live,
  // exactly as the quantity ceilings have always refused 0. See `liveCapitalCeiling.test.mjs`.
  //
  // Supplied here so the tests below keep testing the COORDINATOR gate rather than tripping an
  // unrelated refusal. The one test that expects a throw is unaffected either way: the coordinator
  // refusal is raised earlier in `loadBoxConfig` than this one.
  BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "100000",
};

test("live + BOX_EXECUTION_COORDINATOR_ENABLED=false REFUSES to start", async () => {
  // The whole "only one box" guarantee lives in the coordinator's prologue. Delegating past it is not
  // a degraded mode, it is an unguarded one, so it must not be reachable in live.
  //
  // Only the spellings `bool()` actually recognises as false are exercised. That is not a limitation
  // being papered over: an unrecognised value (`off`, `disabled`, a typo) falls back to the default,
  // which for this variable is TRUE — the coordinator stays on and every ceiling stays enforced. The
  // fail-safe direction, asserted separately below.
  for (const off of ["false", "0", "no", "FALSE", " false "]) {
    await withEnv({ ...LIVE, BOX_EXECUTION_COORDINATOR_ENABLED: off }, (loadBoxConfig) => {
      assert.throws(
        () => loadBoxConfig(),
        /BOX_EXECUTION_COORDINATOR_ENABLED=false cannot be combined with BOX_EXECUTION_MODE=live/,
        `BOX_EXECUTION_COORDINATOR_ENABLED=${off} must refuse in live`,
      );
    });
  }
});

test("the live refusal NAMES what would be lost, so the operator can judge it", async () => {
  await withEnv({ ...LIVE, BOX_EXECUTION_COORDINATOR_ENABLED: "false" }, (loadBoxConfig) => {
    let message = "";
    try {
      loadBoxConfig();
    } catch (err) {
      message = err.message;
    }
    // A refusal that says only "not allowed" makes an operator disable the wrong thing next.
    for (const named of [
      "BOX_MAX_OPEN_BOXES",
      "session attempt budget",
      "BOX_ONE_ACTIVE_BOX_PER_UNDERLYING",
      "duplicate-opportunity guard",
      "reservation",
    ]) {
      assert.ok(message.includes(named), `the refusal must name ${named}; got: ${message}`);
    }
  });
});

test("live WITH the coordinator loads, and PAPER may still disable it", async () => {
  await withEnv({ ...LIVE, BOX_EXECUTION_COORDINATOR_ENABLED: "true" }, (loadBoxConfig) => {
    const cfg = loadBoxConfig();
    assert.equal(cfg.executionMode, "live");
    assert.equal(cfg.executionCoordinatorEnabled, true);
  });
  // Paper is untouched: development and tests legitimately run without coordination.
  await withEnv(
    { BOX_EXECUTION_MODE: "paper_legging", BOX_EXECUTION_COORDINATOR_ENABLED: "false" },
    (loadBoxConfig) => {
      const cfg = loadBoxConfig();
      assert.equal(cfg.executionCoordinatorEnabled, false, "paper may disable it");
    },
  );
});

test("the coordinator default is ENABLED, and an UNRECOGNISED value stays enabled", async () => {
  // Both directions of the fail-safe. Unset must not disable the ceilings, and neither must a typo:
  // for this variable the safe fallback is `true`, because `true` is the guarded state. (Contrast the
  // live-enable gates, where the safe fallback is `false` — in each case the default is chosen so an
  // unreadable value cannot remove protection.)
  await withEnv({ ...LIVE, BOX_EXECUTION_COORDINATOR_ENABLED: undefined }, (loadBoxConfig) => {
    assert.equal(loadBoxConfig().executionCoordinatorEnabled, true, "unset ⇒ enabled");
  });
  for (const typo of ["off", "disabled", "flase", "", "   "]) {
    await withEnv({ ...LIVE, BOX_EXECUTION_COORDINATOR_ENABLED: typo }, (loadBoxConfig) => {
      assert.equal(
        loadBoxConfig().executionCoordinatorEnabled,
        true,
        `${JSON.stringify(typo)} must leave the coordinator ENABLED, not silently disable every ceiling`,
      );
    });
  }
});

/* ════════════════ 2. THE GUARDED DUPLICATE-SUPPRESSION DELETE ════════════════ */

test("settle/holdOnUncertainty do NOT delete the opportunity entry unguarded", () => {
  /*
   * A SOURCE-LEVEL ASSERTION, deliberately, and here is why it is the right tool rather than a
   * cop-out. Reproducing the race behaviourally needs a CoordinatedBoxExecutionGateway, which needs
   * a reservation stack, a durable tier, a quote store, a session manager and an inner gateway — and
   * the resulting test would prove that a mock sequenced the way I chose produces the outcome I
   * expected. The actual invariant is textual and absolute: ownership of the `activeOpportunities`
   * entry is checked in exactly ONE place (`abandon`), and no other method may remove it. That is
   * checkable directly, and it fails loudly if someone re-adds the line.
   */
  const src = readFileSync(resolve(ROOT, "src/box/executionCoordinator.ts"), "utf8");

  // Isolate the two methods, comments stripped, so prose describing the removed line cannot pass.
  const region = (name) => {
    const start = src.indexOf(`private ${name}(`) >= 0 ? src.indexOf(`private ${name}(`) : src.indexOf(`private async ${name}(`);
    assert.ok(start > 0, `${name} not found`);
    const body = src.slice(start, start + 2000);
    return body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
  };

  for (const name of ["settle", "holdOnUncertainty"]) {
    const code = region(name);
    assert.equal(
      /activeOpportunities\.delete\(/.test(code),
      false,
      `${name} must not delete from activeOpportunities directly — abandon() owns the ` +
        `ownership-guarded removal, and an unguarded delete here removes a SUCCESSOR's suppression ` +
        `entry while it is still executing`,
    );
    assert.ok(/this\.abandon\(executionId\)/.test(code), `${name} must still call abandon()`);
  }

  // And `abandon` must still hold the guard, or removing the duplicates above would be a regression.
  const abandonStart = src.indexOf("private abandon(executionId: string): void {");
  assert.ok(abandonStart > 0, "abandon not found");
  const abandon = src.slice(abandonStart, abandonStart + 700);
  assert.match(
    abandon,
    /activeOpportunities\.get\(exec\.opportunityId\) === executionId/,
    "abandon must only delete the entry when it still maps to THIS execution",
  );
});

/* ════════════════ 3. ACCOUNT FUNDS: UNKNOWN IS NEVER ZERO ════════════════ */

const FRESHNESS = 45_000;

function tracker(startAt = 1_000_000) {
  let now = startAt;
  const t = new AccountFundsTracker({ freshnessMaxAgeMs: FRESHNESS, now: () => now });
  return { t, advance: (ms) => { now += ms; }, at: () => now };
}

test("an unread balance is NULL with a reason, never ₹0", () => {
  const { t } = tracker();
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.equal(snap.free_to_trade_rupees, null, "unknown must not be 0");
  assert.equal(snap.unavailable_reason, "never_read");
  assert.equal(snap.fresh, false);
  assert.match(snap.note, /NOT a zero balance/);
});

test("the four unavailable reasons stay DISTINCT — they need different operator actions", () => {
  // log in / wait / stop expecting a number / the call errored. Collapsing them into one blank is
  // what makes an operator stare at a dash with nothing to do about it.
  const { t } = tracker();
  assert.equal(t.snapshot({ sessionReady: false, supported: true }).unavailable_reason, "no_session");
  assert.equal(t.snapshot({ sessionReady: true, supported: false }).unavailable_reason, "not_supported");
  assert.equal(t.snapshot({ sessionReady: true, supported: true }).unavailable_reason, "never_read");
  t.recordFailure("ECONNRESET");
  assert.equal(t.snapshot({ sessionReady: true, supported: true }).unavailable_reason, "read_failed");
});

test("a GENUINE zero balance is reported as 0, not as unknown", () => {
  // The distinction that matters most in the other direction: an empty account is a real, actionable
  // fact and must not hide behind the same dash as "we could not read it".
  const { t, at } = tracker();
  t.record("zerodha", { availableRupees: 0, utilisedRupees: 0 }, at());
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.equal(snap.free_to_trade_rupees, 0);
  assert.equal(snap.unavailable_reason, null);
  assert.equal(snap.fresh, true);
});

test("ZERODHA semantics are applied ONCE: utilised is NOT subtracted from live_balance", () => {
  // Zerodha documents `available.live_balance` as already net of encumbrance. Subtracting
  // `utilised.debits` again would understate free capital by everything already blocked — and would
  // disagree with the live admission gate, which uses the same helper.
  const { t, at } = tracker();
  t.record("zerodha", { availableRupees: 47_250, utilisedRupees: 12_000 }, at());
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.equal(snap.free_to_trade_rupees, 47_250, "must NOT be 35,250");
  assert.equal(snap.semantics, "net_of_encumbrance");
  assert.equal(snap.encumbrance_netted, true);
  assert.equal(snap.broker_available_rupees, 47_250);
  assert.equal(snap.broker_utilised_rupees, 12_000);
});

test("`semantics` is the machine-readable ENUM, never the prose audit sentence", () => {
  // Caught in review: the verdict's `basis` is a sentence for a log line. Publishing it in an enum
  // field would break every client that switches on the value.
  const { t, at } = tracker();
  t.record("zerodha", { availableRupees: 100, utilisedRupees: 0 }, at());
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.ok(
    ["net_of_encumbrance", "gross_of_encumbrance", "unverified"].includes(snap.semantics),
    `semantics must be an enum member, got: ${snap.semantics}`,
  );
  assert.ok(snap.note.length > 40, "the prose belongs in `note`, which must still carry it");
});

test("an UNVERIFIED broker fails CLOSED rather than guessing what its number means", () => {
  const { t, at } = tracker();
  t.record("dhan", { availableRupees: 5_000, utilisedRupees: null }, at());
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.equal(snap.free_to_trade_rupees, null, "an uninterpretable figure is not money");
  assert.equal(snap.unavailable_reason, "semantics_unknown");
  // The raw broker figure is still surfaced, so the operator can see the input that could not be read.
  assert.equal(snap.broker_available_rupees, 5_000);
});

test("a STALE figure is KEPT and labelled, not blanked", () => {
  // Mid-session, "₹47,000 as of 60s ago, refresh failing" is far more useful than a dash.
  const { t, advance, at } = tracker();
  t.record("zerodha", { availableRupees: 47_250, utilisedRupees: 0 }, at());
  advance(FRESHNESS + 15_000);
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.equal(snap.free_to_trade_rupees, 47_250, "the figure survives");
  assert.equal(snap.fresh, false, "but it is not called fresh");
  assert.equal(snap.age_ms, FRESHNESS + 15_000);
  assert.equal(snap.unavailable_reason, null, "stale is not unavailable");
  assert.match(snap.note, /indicative/);
});

test("a failed refresh keeps the last good figure AND publishes the error", () => {
  const { t, advance, at } = tracker();
  t.record("zerodha", { availableRupees: 47_250, utilisedRupees: 0 }, at());
  advance(20_000);
  t.recordFailure("ETIMEDOUT after 2500ms");
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.equal(snap.free_to_trade_rupees, 47_250);
  assert.equal(snap.last_error, "ETIMEDOUT after 2500ms");
  assert.match(snap.note, /refresh FAILED/);
});

test("the error is bounded and whitespace-collapsed, so a huge message cannot flood the payload", () => {
  const { t } = tracker();
  t.recordFailure(`x${"y".repeat(5000)}\n\n   trailing`);
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.ok(snap.last_error.length <= 200, `got ${snap.last_error.length} chars`);
  assert.equal(/\s\s/.test(snap.last_error), false, "collapsed");
});

test("age is CLAMPED at zero, so a backwards clock step cannot publish a future figure", () => {
  let now = 1_000_000;
  const t = new AccountFundsTracker({ freshnessMaxAgeMs: FRESHNESS, now: () => now });
  t.record("zerodha", { availableRupees: 100, utilisedRupees: 0 }, now);
  now -= 30_000; // NTP correction backwards
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.equal(snap.age_ms, 0, "never negative");
});

test("a broker switch FORGETS the balance — one account's funds are not another's", () => {
  const { t, at } = tracker();
  t.record("zerodha", { availableRupees: 47_250, utilisedRupees: 0 }, at());
  t.reset();
  const snap = t.snapshot({ sessionReady: true, supported: true });
  assert.equal(snap.free_to_trade_rupees, null);
  assert.equal(snap.broker, null);
  assert.equal(snap.unavailable_reason, "never_read", "reset also clears the attempted flag");
});

test("the note never claims a specific box is affordable", () => {
  // The figure is an account balance on a timer. Four-leg margin is a different question, answered by
  // the economic-admission gate against the broker's basket margin. Implying otherwise would invite
  // exactly the inference that gate exists to make properly.
  const { t, at } = tracker();
  t.record("zerodha", { availableRupees: 47_250, utilisedRupees: 0 }, at());
  assert.match(t.snapshot({ sessionReady: true, supported: true }).note, /does NOT prove/);
});

test("unavailableFunds() builds a complete, honest snapshot for a deployment that cannot report", () => {
  const snap = unavailableFunds("not_supported", "no reader wired", "zerodha");
  assert.equal(snap.free_to_trade_rupees, null);
  assert.equal(snap.fresh, false);
  assert.equal(snap.observed_at, null);
  assert.equal(snap.age_ms, null);
  assert.equal(snap.broker, "zerodha");
  assert.equal(snap.unavailable_reason, "not_supported");
});
