/**
 * THE TRIAL MUST BOUND ATTEMPTS, NOT ONLY SUCCESSFUL COMPLETIONS.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The session budget counted cycles CONSUMED at establishment — `established_trade_ids.length` —
 * and an attempt that ended with no Box was recorded in `aborted_attempts`, documented in the source
 * as "Visibility only; never gates anything".
 *
 * The reasoning for not spending a CYCLE on a failed attempt is sound and is preserved: burning an
 * operator's single permitted trade on an attempt that left no position would be indefensible. But it
 * left NOTHING bounding attempts at all. An attempt that
 *
 *   - passes every gate, and
 *   - submits orders, and
 *   - partially fills (real, irreversible exposure), and
 *   - is then unwound or recovered
 *
 * has taken real exposure, paid real charges and consumed real rate-limit budget — and was free. A
 * deployment configured for "one bounded trial trade" could therefore submit orders indefinitely, as
 * long as no attempt ever completed a Box, while still reporting one cycle remaining.
 *
 * THE FIX: two INDEPENDENT budgets that both gate entry. A cycle is spent by SUCCEEDING; an attempt
 * is spent by STARTING, counted at admission before any broker POST.
 *
 * This suite drives the real pure state machine and the real durable manager with an injected
 * persistence surface, so the restart and write-failure behaviour is exercised rather than assumed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  armSession,
  evaluateSessionEntry,
  idleSessionRecord,
  isAttemptBudgetExhausted,
  normaliseSessionRecord,
  recordAbortedAttempt,
  recordEntryAttemptStarted,
  recordEstablishedBox,
  remainingEntryAttempts,
  sessionStatus,
} from "../../dist/box/tradingSession.js";
import { BoxTradingSessionManager } from "../../dist/box/tradingSessionStore.js";

/* ─────────────────────────── helpers ─────────────────────────── */

const NOW = 1_700_000_000_000;
const ACTIVITY = {
  entryInProgress: false,
  openBoxes: 0,
  exitInProgress: false,
  recoveryActive: false,
  entryBlockedExternally: false,
};

function armed({ maxCompletedTrades = 1, maxEntryAttempts = 0 } = {}) {
  return armSession({
    sessionId: "sess-test",
    maxCompletedTrades,
    maxEntryAttempts,
    armedBy: "tester",
    previous: idleSessionRecord(NOW),
    now: NOW,
  });
}

/** An in-memory persistence surface. `failWrites` makes every save reject. */
function memoryPersistence({ initial = null, failWrites = false, failLoad = null } = {}) {
  let stored = initial;
  const saves = [];
  return {
    saves,
    stored: () => stored,
    setFailWrites: (v) => {
      failWrites = v;
    },
    async load() {
      if (failLoad) return { ok: false, error: failLoad };
      return { ok: true, record: stored };
    },
    async save(record) {
      if (failWrites) throw new Error("mongo is down");
      stored = record;
      saves.push(record);
    },
    async flatTradeIds() {
      return [];
    },
  };
}

function makeManager(persistence, { maxCompletedTrades = 0, maxEntryAttempts = 2, available = true } = {}) {
  return new BoxTradingSessionManager({
    persistence,
    configuredMaxCompletedTrades: () => maxCompletedTrades,
    configuredMaxEntryAttempts: () => maxEntryAttempts,
    persistenceAvailable: () => available,
    now: () => NOW,
    newSessionId: () => "sess-test",
  });
}

/* ═══════════════ 1. the reproduction ═══════════════ */

test("REPRODUCTION: with only the CYCLE budget, unlimited failed attempts are permitted", () => {
  // A one-trade session. Every attempt aborts, so no cycle is ever consumed.
  let record = armed({ maxCompletedTrades: 1, maxEntryAttempts: 0 });
  for (let i = 0; i < 500; i++) {
    record = recordAbortedAttempt(record, NOW);
    const verdict = evaluateSessionEntry({ record, recoveryActive: false });
    assert.equal(
      verdict.allowed,
      true,
      `attempt ${i + 1} was still permitted: aborted attempts gate nothing, so risk-taking is unbounded`,
    );
  }
  assert.equal(record.aborted_attempts, 500);
  const status = sessionStatus(record, ACTIVITY, null);
  assert.equal(status.remaining_trades, 1, "and the session still reports a full cycle budget remaining");
});

test("with the ATTEMPT budget armed, the same run is bounded", () => {
  let record = armed({ maxCompletedTrades: 1, maxEntryAttempts: 3 });
  const outcomes = [];
  for (let i = 0; i < 6; i++) {
    const verdict = evaluateSessionEntry({ record, recoveryActive: false });
    outcomes.push(verdict.allowed);
    if (!verdict.allowed) continue;
    // Admitted ⇒ the attempt is spent, then it aborts having taken exposure.
    record = recordEntryAttemptStarted(record, NOW);
    record = recordAbortedAttempt(record, NOW);
  }
  assert.deepEqual(
    outcomes,
    [true, true, true, false, false, false],
    "exactly three attempts are admitted, then entry is refused",
  );
  assert.equal(record.entry_attempts, 3);
  assert.equal(record.aborted_attempts, 3);
});

/* ═══════════════ 2. attempts are spent by STARTING, not by succeeding ═══════════════ */

test("an attempt is spent at ADMISSION, whatever its outcome", () => {
  const base = armed({ maxCompletedTrades: 5, maxEntryAttempts: 2 });

  // Outcome A: aborted.
  let aborted = recordEntryAttemptStarted(base, NOW);
  aborted = recordAbortedAttempt(aborted, NOW);
  assert.equal(aborted.entry_attempts, 1, "an aborted attempt spends an attempt");
  assert.equal(aborted.established_trade_ids.length, 0, "and no cycle");

  // Outcome B: succeeded.
  let ok = recordEntryAttemptStarted(base, NOW);
  ok = recordEstablishedBox(ok, "T-1", NOW);
  assert.equal(ok.entry_attempts, 1, "a successful attempt spends the same one attempt");
  assert.equal(ok.established_trade_ids.length, 1, "and additionally a cycle");
});

test("the two budgets are INDEPENDENT: either can exhaust alone", () => {
  // Attempt budget exhausted while cycles remain.
  let attemptsGone = armed({ maxCompletedTrades: 10, maxEntryAttempts: 1 });
  attemptsGone = recordEntryAttemptStarted(attemptsGone, NOW);
  const v1 = evaluateSessionEntry({ record: attemptsGone, recoveryActive: false });
  assert.equal(v1.allowed, false);
  assert.equal(v1.reason, "session_attempt_budget_exhausted");
  assert.match(v1.detail, /BOX_SESSION_MAX_ENTRY_ATTEMPTS=1/);
  assert.match(v1.detail, /bounds ATTEMPTS, not completions/);

  // Cycle budget exhausted while attempts remain.
  let cyclesGone = armed({ maxCompletedTrades: 1, maxEntryAttempts: 10 });
  cyclesGone = recordEntryAttemptStarted(cyclesGone, NOW);
  cyclesGone = recordEstablishedBox(cyclesGone, "T-1", NOW);
  const v2 = evaluateSessionEntry({ record: cyclesGone, recoveryActive: false });
  assert.equal(v2.allowed, false);
  assert.equal(v2.reason, "session_budget_exhausted", "the cycle budget still reports its own reason");
});

test("the CYCLE budget is still reported first when both are exhausted", () => {
  // Ordering matters for the operator message: running out of permitted TRADES is the expected end
  // of a trial, whereas running out of ATTEMPTS means something kept failing.
  let record = armed({ maxCompletedTrades: 1, maxEntryAttempts: 1 });
  record = recordEntryAttemptStarted(record, NOW);
  record = recordEstablishedBox(record, "T-1", NOW);
  const v = evaluateSessionEntry({ record, recoveryActive: false });
  assert.equal(v.reason, "session_budget_exhausted");
});

/* ═══════════════ 3. exposure management is never blocked by a spent attempt budget ═══════════════ */

test("an exhausted attempt budget refuses ENTRY ONLY and says so", () => {
  let record = armed({ maxCompletedTrades: 5, maxEntryAttempts: 1 });
  record = recordEntryAttemptStarted(record, NOW);
  const v = evaluateSessionEntry({ record, recoveryActive: false });
  assert.equal(v.allowed, false);
  assert.match(
    v.detail,
    /Monitoring, exit, residual flattening and reconciliation continue; only\s+new entry is refused/,
    "a spent budget must never be a reason an owned position cannot be closed",
  );
});

test("RECOVERY still outranks the attempt budget", () => {
  const record = armed({ maxCompletedTrades: 5, maxEntryAttempts: 5 });
  const v = evaluateSessionEntry({ record, recoveryActive: true });
  assert.equal(v.reason, "session_recovery", "recovery is reported ahead of any budget");
});

/* ═══════════════ 4. remaining/exhausted arithmetic, and unbounded ═══════════════ */

test("0 means UNBOUNDED, and is reported as null rather than Infinity", () => {
  const unbounded = armed({ maxEntryAttempts: 0 });
  assert.equal(remainingEntryAttempts(unbounded), null, "null serialises honestly; Infinity does not");
  assert.equal(isAttemptBudgetExhausted(unbounded), false);
  const spent = recordEntryAttemptStarted(recordEntryAttemptStarted(unbounded, NOW), NOW);
  assert.equal(isAttemptBudgetExhausted(spent), false, "an unbounded session is never exhausted");
});

test("remaining attempts counts down and floors at zero", () => {
  let record = armed({ maxEntryAttempts: 2 });
  assert.equal(remainingEntryAttempts(record), 2);
  record = recordEntryAttemptStarted(record, NOW);
  assert.equal(remainingEntryAttempts(record), 1);
  record = recordEntryAttemptStarted(record, NOW);
  assert.equal(remainingEntryAttempts(record), 0);
  record = recordEntryAttemptStarted(record, NOW);
  assert.equal(remainingEntryAttempts(record), 0, "never negative");
  assert.equal(isAttemptBudgetExhausted(record), true);
});

/* ═══════════════ 5. the ceiling is SNAPSHOT at arm time ═══════════════ */

test("the attempt ceiling is snapshot at ARM, so an env change cannot widen a live session", () => {
  const record = armed({ maxEntryAttempts: 2 });
  assert.equal(record.max_entry_attempts, 2);
  // Re-arming is the only way to change it, and re-arming resets the counter for the new session.
  const rearmed = armSession({
    sessionId: "sess-2",
    maxCompletedTrades: 1,
    maxEntryAttempts: 5,
    armedBy: "tester",
    previous: recordEntryAttemptStarted(record, NOW),
    now: NOW,
  });
  assert.equal(rearmed.max_entry_attempts, 5);
  assert.equal(rearmed.entry_attempts, 0, "a new session measures its OWN attempts");
  assert.equal(rearmed.arm_count, record.arm_count + 1, "and the re-arm is audited");
});

/* ═══════════════ 6. status projection ═══════════════ */

test("the status projection publishes the attempt budget alongside the cycle budget", () => {
  let record = armed({ maxCompletedTrades: 1, maxEntryAttempts: 3 });
  record = recordEntryAttemptStarted(record, NOW);
  record = recordAbortedAttempt(record, NOW);
  const status = sessionStatus(record, ACTIVITY, null);
  assert.equal(status.entry_attempts, 1);
  assert.equal(status.max_entry_attempts, 3);
  assert.equal(status.remaining_entry_attempts, 2);
  assert.equal(status.aborted_attempts, 1, "the visibility counter is still there, and still distinct");
  assert.equal(status.consumed_cycles, 0, "an aborted attempt consumed no cycle");
});

/* ═══════════════ 7. records written by an older build ═══════════════ */

test("a record with no attempt fields normalises to unbounded/none-spent, not to undefined", () => {
  // `undefined >= 2` is false, which would silently DISABLE the bound. Missing must become 0.
  const legacy = { ...idleSessionRecord(NOW) };
  delete legacy.entry_attempts;
  delete legacy.max_entry_attempts;
  const normalised = normaliseSessionRecord(legacy);
  assert.equal(normalised.entry_attempts, 0, "none spent — inventing spent attempts would refuse authorised entry");
  assert.equal(normalised.max_entry_attempts, 0, "unbounded — inventing a ceiling the operator never armed under would too");
  assert.equal(isAttemptBudgetExhausted(normalised), false);
});

test("normalisation clamps hostile values rather than trusting them", () => {
  const weird = { ...idleSessionRecord(NOW), entry_attempts: -5, max_entry_attempts: 2.7 };
  const n = normaliseSessionRecord(weird);
  assert.equal(n.entry_attempts, 0);
  assert.equal(n.max_entry_attempts, 2);
});

/* ═══════════════ 8. the DURABLE manager: restart, write failure, unarmed ═══════════════ */

test("the manager consumes an attempt DURABLY and refuses when the write fails", async () => {
  const persistence = memoryPersistence();
  const mgr = makeManager(persistence, { maxEntryAttempts: 2 });
  await mgr.initialise();
  const arm = await mgr.arm({ armedBy: "tester", openBoxes: 0, residualLegs: 0, recoveryActive: false });
  assert.equal(arm.ok, true);

  const first = await mgr.recordAttemptStarted();
  assert.equal(first.ok, true, "the first attempt is admitted");
  assert.equal(persistence.stored().entry_attempts, 1, "and DURABLY recorded before anything is sent");

  // Now the database fails. The attempt must NOT be started.
  persistence.setFailWrites(true);
  const second = await mgr.recordAttemptStarted();
  assert.equal(second.ok, false, "an attempt that cannot be counted must not be started");
  assert.match(second.detail, /could not be durably recorded/);
  assert.equal(
    persistence.stored().entry_attempts,
    1,
    "and the durable count is unchanged — nothing was risked, so nothing needed counting",
  );
});

test("a CONSUMED attempt survives a restart: the budget does not reset", async () => {
  const persistence = memoryPersistence();
  const first = makeManager(persistence, { maxEntryAttempts: 2 });
  await first.initialise();
  await first.arm({ armedBy: "tester", openBoxes: 0, residualLegs: 0, recoveryActive: false });
  assert.equal((await first.recordAttemptStarted()).ok, true);
  assert.equal((await first.recordAttemptStarted()).ok, true);
  assert.equal(first.evaluateEntry(false).allowed, false, "budget spent in this process");

  // ── RESTART: a brand-new manager reading the same durable record. ──
  const second = makeManager(persistence, { maxEntryAttempts: 2 });
  await second.initialise();
  const verdict = second.evaluateEntry(false);
  assert.equal(
    verdict.allowed,
    false,
    "restarting must NOT hand the attempt budget back — otherwise 'restart for another attempt' works",
  );
  assert.equal(verdict.reason, "session_attempt_budget_exhausted");
  assert.equal(second.snapshot().entry_attempts, 2);
});

test("an UNREADABLE durable session refuses to consume an attempt", async () => {
  const persistence = memoryPersistence({ failLoad: "mongo timeout" });
  const mgr = makeManager(persistence, { maxEntryAttempts: 2 });
  await mgr.initialise();
  assert.equal(mgr.isReady(), false);
  const consumed = await mgr.recordAttemptStarted();
  assert.equal(consumed.ok, false, "an unread session cannot be proven to have attempts left");
  assert.match(consumed.detail, /not armed or its durable state is unreadable/);
});

test("an UNARMED session refuses to consume an attempt", async () => {
  const persistence = memoryPersistence();
  const mgr = makeManager(persistence, { maxEntryAttempts: 2 });
  await mgr.initialise();
  const consumed = await mgr.recordAttemptStarted();
  assert.equal(consumed.ok, false, "nothing may be attempted before a session is armed");
});

test("with the bound NOT configured the manager is a true no-op", async () => {
  // The default must change nothing for an existing deployment.
  const persistence = memoryPersistence();
  const mgr = makeManager(persistence, { maxCompletedTrades: 0, maxEntryAttempts: 0 });
  await mgr.initialise();
  assert.equal(mgr.evaluateEntry(false).allowed, true, "no opinion when nothing is configured");
  const consumed = await mgr.recordAttemptStarted();
  assert.equal(consumed.ok, true, "and consuming is permitted without recording anything");
  assert.equal(persistence.saves.length, 0, "no write at all");
});

test("the ATTEMPT bound alone is enough to make the session ENFORCE", async () => {
  // enforcing() used to depend solely on the CYCLE budget, so a trial configured with an attempt
  // ceiling but no cycle ceiling would have had its only bound silently ignored.
  const persistence = memoryPersistence();
  const mgr = makeManager(persistence, { maxCompletedTrades: 0, maxEntryAttempts: 1 });
  await mgr.initialise();
  const arm = await mgr.arm({ armedBy: "tester", openBoxes: 0, residualLegs: 0, recoveryActive: false });
  assert.equal(arm.ok, true);
  assert.equal(arm.record.max_entry_attempts, 1);
  assert.equal((await mgr.recordAttemptStarted()).ok, true);
  const verdict = mgr.evaluateEntry(false);
  assert.equal(verdict.allowed, false, "the attempt bound enforces on its own");
  assert.equal(verdict.reason, "session_attempt_budget_exhausted");

  const status = mgr.status(ACTIVITY);
  assert.equal(status.enforcing, true, "and the status says the session IS enforcing");
  assert.equal(status.remaining_entry_attempts, 0);
});

/* ═══════════════ 9. the coordinator consumes BEFORE risking anything ═══════════════ */

test("the coordinator consumes the attempt before any reservation or POST", async () => {
  const { readFileSync } = await import("node:fs");
  const strip = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  const coordinator = strip(
    readFileSync(new URL("../../src/box/executionCoordinator.ts", import.meta.url), "utf8"),
  );

  const consumeAt = coordinator.indexOf("this.deps.sessionConsumeAttempt()");
  assert.ok(consumeAt > 0, "the coordinator must consume an attempt");

  // It must come BEFORE the reservation acquisition, which is the first thing that can lead to a POST.
  const reserveAt = coordinator.indexOf("acquireForEntry");
  if (reserveAt > 0) {
    assert.ok(
      consumeAt < reserveAt,
      "the attempt must be consumed before the reservation, so a failure after it still spent budget",
    );
  }
  // A refusal to count must refuse the entry, not proceed.
  const block = coordinator.slice(consumeAt, consumeAt + 700);
  assert.ok(block.includes("session_limit_reached"), "a failure to count must refuse the entry");

  const engine = strip(readFileSync(new URL("../../src/box/engine.ts", import.meta.url), "utf8"));
  // Asserted as "the hook calls the durable counter", not as one exact source line: the hook also
  // records which armed session authorised the attempt, so the POST boundary can detect a disarm.
  const wireAt = engine.indexOf("sessionConsumeAttempt:");
  assert.ok(wireAt > 0, "the engine must wire the consume hook");
  assert.ok(
    engine.slice(wireAt, wireAt + 600).includes("this.session.recordAttemptStarted()"),
    "and the engine must wire it to the durable session manager",
  );
  assert.ok(
    engine.includes("configuredMaxEntryAttempts: () => this.cfg.sessionMaxEntryAttempts"),
    "and supply the configured ceiling",
  );
});

test("the example configuration documents the bound and leaves it OFF", async () => {
  const { readFileSync } = await import("node:fs");
  const env = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  assert.match(env, /^BOX_SESSION_MAX_ENTRY_ATTEMPTS=0$/m, "shipped OFF, like every other live control");
  assert.match(env, /BOUNDS RISK-TAKING, NOT SUCCESS/, "and explains why the cycle budget is not enough");
});
