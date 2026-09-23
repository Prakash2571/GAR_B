/**
 * TWO TRADING-SESSION MANAGERS SHARING ONE POSTGRESQL MUST NOT BOTH SPEND THE LAST ATTEMPT.
 *
 * THE DEFECT THIS REPRODUCES
 *
 * `BoxTradingSessionManager` serialises its mutations with a promise chain
 * (`tradingSessionStore.ts` `private mutations` / `serialize()`). That is a PER-INSTANCE field, so
 * it orders nothing between two managers — whether they live in one process or two. The durable
 * write underneath it was `saveBoxTradingSession`, an unconditional full-row upsert:
 *
 *     ON CONFLICT (id) DO UPDATE SET ... entry_attempts = $11, ...
 *
 * `$11` is a number computed in Node from a record read earlier. So with
 * `max_entry_attempts = 1`:
 *
 *   manager A reads entry_attempts = 0 -> evaluates "allowed" -> computes 1 -> writes 1
 *   manager B reads entry_attempts = 0 -> evaluates "allowed" -> computes 1 -> writes 1
 *
 * Both are admitted, and the persisted counter ends at 1 rather than 2 — a classic lost update.
 * The ceiling that exists to bound how many times real money is put at risk is consumed twice and
 * recorded once. Nothing in the pure state machine can see this: `evaluateSessionEntry` and
 * `recordEntryAttemptStarted` operate on an in-memory record that each manager believes is current.
 *
 * WHAT THIS FILE ASSERTS
 *
 *   1. REPRODUCTION (pre-fix behaviour, now the regression guard): two managers, one schema,
 *      `max_entry_attempts = 1`, both calling `recordAttemptStarted()`. EXACTLY ONE may be
 *      admitted, and the persisted counter must equal the number admitted.
 *   2. NO LOST UPDATE UNDER CONTENTION: with a larger ceiling and N concurrent consumers, the
 *      persisted counter must equal the number admitted, and must never exceed the ceiling.
 *   3. STALE WRITES CANNOT OVERWRITE NEWER CONSUMPTION: a manager holding an old record that
 *      writes some unrelated field must not reset `entry_attempts` to its stale value.
 *
 * Every assertion is about the DURABLE row, read back with a fresh query, because the in-memory
 * record of a manager that lost the race is exactly the thing that cannot be trusted.
 *
 * REAL PostgreSQL. Own schema per file. No broker network of any kind.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown } from "./helpers.mjs";

let ctx;
let repo;
let store;

test.before(async () => {
  ctx = await setup("sessbudget");
  repo = await loadRepo();
  store = await import("../../dist/box/tradingSessionStore.js");
});

test.after(async () => {
  await teardown(ctx);
});

async function loadRepo() {
  return import("../../dist/box/repository.js");
}

/** Read the durable row directly, bypassing every in-memory cache. */
async function durableAttempts() {
  const loaded = await repo.loadBoxTradingSession();
  assert.equal(loaded.ok, true, "the durable session row must be readable");
  return loaded.record === null
    ? { entry_attempts: 0, max_entry_attempts: 0, session_id: "" }
    : {
        entry_attempts: loaded.record.entry_attempts,
        max_entry_attempts: loaded.record.max_entry_attempts,
        session_id: loaded.record.session_id,
      };
}

/**
 * A manager wired to the REAL PostgreSQL persistence — the same functions `engine.ts` wires in
 * (`engine.ts` `save: (record) => saveBoxTradingSession(record)`). Nothing here is stubbed except
 * the trade-flatness lookup, which this test never exercises.
 */
function managerOn({ maxEntryAttempts = 1, maxCompletedTrades = 0 } = {}) {
  return new store.BoxTradingSessionManager({
    persistence: {
      load: () => repo.loadBoxTradingSession(),
      save: (record) => repo.saveBoxTradingSession(record),
      flatTradeIds: async () => [],
      consumeEntryAttempt: repo.consumeBoxTradingSessionEntryAttempt,
    },
    configuredMaxCompletedTrades: () => maxCompletedTrades,
    configuredMaxEntryAttempts: () => maxEntryAttempts,
    persistenceAvailable: () => true,
    log: () => {},
  });
}

async function resetSession() {
  const pool = ctx.pool;
  await pool.query(`DELETE FROM box_trading_session`);
}

/* ───────────────────────── 1. the reproduction ───────────────────────── */

test("two managers sharing one PostgreSQL cannot both spend the last entry attempt", async () => {
  await resetSession();

  // A arms the session. That write establishes max_entry_attempts = 1 durably.
  const a = managerOn({ maxEntryAttempts: 1 });
  await a.initialise();
  const armed = await a.arm({
    maxEntryAttempts: 1,
    armedBy: "test",
    openBoxes: 0,
    residualLegs: 0,
    recoveryActive: false,
  });
  assert.equal(armed.ok, true, `arming must succeed: ${armed.ok === false ? armed.reason : ""}`);

  const beforeArm = await durableAttempts();
  assert.equal(beforeArm.max_entry_attempts, 1, "the ceiling must be durable");
  assert.equal(beforeArm.entry_attempts, 0, "nothing spent yet");

  // B is a SECOND, INDEPENDENT manager over the SAME row. This is the review's scenario: two
  // trading-session managers sharing persistence. It loads the armed record A just wrote.
  const b = managerOn({ maxEntryAttempts: 1 });
  await b.initialise();
  assert.equal(
    b.snapshot().session_id,
    beforeArm.session_id,
    "B must have adopted the same armed session, otherwise this is not the contended case",
  );

  // Both admit concurrently, each having read entry_attempts = 0.
  const [ra, rb] = await Promise.all([a.recordAttemptStarted(), b.recordAttemptStarted()]);

  const admitted = [ra, rb].filter((r) => r.ok).length;
  const after = await durableAttempts();

  // THE INVARIANT: the ceiling is 1, so at most one attempt may be admitted.
  assert.equal(
    admitted,
    1,
    `exactly one manager may be admitted under max_entry_attempts=1, got ${admitted} ` +
      `(A=${JSON.stringify(ra)}, B=${JSON.stringify(rb)})`,
  );
  // AND the durable counter must agree with what was admitted. Pre-fix this was 1 while BOTH were
  // admitted, which is the lost update.
  assert.equal(
    after.entry_attempts,
    admitted,
    `the persisted counter (${after.entry_attempts}) must equal the number of admitted attempts (${admitted})`,
  );
  assert.ok(
    after.entry_attempts <= after.max_entry_attempts,
    `the persisted counter must never exceed the ceiling (${after.entry_attempts} <= ${after.max_entry_attempts})`,
  );

  // The refusal must be legible, not a bare false.
  const refused = ra.ok ? rb : ra;
  assert.equal(refused.ok, false);
  assert.equal(typeof refused.detail, "string");
  assert.ok(refused.detail.length > 0, "a refusal must carry a reason an operator can read");
});

/* ──────────────── 2. no lost update under wider contention ──────────────── */

test("N concurrent consumers over one row lose no update and never exceed the ceiling", async () => {
  await resetSession();

  const CEILING = 4;
  const CONSUMERS = 10;

  const arming = managerOn({ maxEntryAttempts: CEILING });
  await arming.initialise();
  const armed = await arming.arm({
    maxEntryAttempts: CEILING,
    armedBy: "test",
    openBoxes: 0,
    residualLegs: 0,
    recoveryActive: false,
  });
  assert.equal(armed.ok, true, `arming must succeed: ${armed.ok === false ? armed.reason : ""}`);

  // Independent managers, each with its own in-memory record and its own promise chain.
  const managers = [];
  for (let i = 0; i < CONSUMERS; i += 1) {
    const m = managerOn({ maxEntryAttempts: CEILING });
    await m.initialise();
    managers.push(m);
  }

  const results = await Promise.all(managers.map((m) => m.recordAttemptStarted()));
  const admitted = results.filter((r) => r.ok).length;
  const after = await durableAttempts();

  assert.equal(
    admitted,
    CEILING,
    `exactly the ceiling may be admitted (${CEILING}), got ${admitted}: ${JSON.stringify(results)}`,
  );
  assert.equal(
    after.entry_attempts,
    admitted,
    `no update may be lost: persisted ${after.entry_attempts} vs admitted ${admitted}`,
  );
  assert.ok(
    after.entry_attempts <= CEILING,
    `the ceiling must hold durably: ${after.entry_attempts} <= ${CEILING}`,
  );
});

/* ─────────── 3. a stale writer cannot roll back consumed budget ─────────── */

test("a stale manager's unrelated write cannot reset consumed entry attempts", async () => {
  await resetSession();

  const a = managerOn({ maxEntryAttempts: 5 });
  await a.initialise();
  const armed = await a.arm({
    maxEntryAttempts: 5,
    armedBy: "test",
    openBoxes: 0,
    residualLegs: 0,
    recoveryActive: false,
  });
  assert.equal(armed.ok, true);

  // `stale` loads the armed record NOW, while entry_attempts = 0, and then does not touch it.
  const stale = managerOn({ maxEntryAttempts: 5 });
  await stale.initialise();
  assert.equal(stale.snapshot().entry_attempts, 0, "the stale manager's view must start at 0");

  // A spends two attempts. The durable counter moves to 2; `stale` still believes 0.
  assert.equal((await a.recordAttemptStarted()).ok, true);
  assert.equal((await a.recordAttemptStarted()).ok, true);
  assert.equal((await durableAttempts()).entry_attempts, 2);

  // Now the stale manager performs a DIFFERENT mutation — an aborted attempt, which is a
  // visibility-only counter. Pre-fix this wrote the whole row from its stale snapshot and reset
  // entry_attempts to 0, handing back two consumed attempts.
  await stale.recordAborted();

  const after = await durableAttempts();
  assert.equal(
    after.entry_attempts,
    2,
    `a stale writer must not roll consumed budget back (expected 2, got ${after.entry_attempts})`,
  );
});
