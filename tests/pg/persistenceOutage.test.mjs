/**
 * A POSTGRESQL OUTAGE MUST FAIL CLOSED AND SAY SO — never silently report success or emptiness.
 *
 * WHAT THIS SUITE IS FOR
 *
 * The review's hypothesis was that bulk cancellation required reading the durable order journal, and
 * that a failed read meant no cancellation was attempted while the UI still claimed "exits unaffected".
 * The refusal half is now correct in the code; what was missing was EVIDENCE that the real SQL fails the
 * way the refusal path assumes. That matters because the difference between "throws" and "returns an
 * empty array" is the difference between refusing loudly and cancelling nothing while reporting success.
 *
 * HOW THE OUTAGE IS INJECTED
 *
 * By RENAMING the tables out from under the queries, inside this test's own schema. That is a genuine
 * database-level failure — the real statement runs and PostgreSQL rejects it — rather than a stub that
 * merely throws where we already expect a throw. Every rename is restored in a `finally`, and the
 * restore is itself asserted, so a failure here cannot cascade into the rest of the file.
 *
 * WHY NOT STOP THE SERVER. Killing the cluster would break every other test file running against it in
 * parallel. Renaming is scoped to this schema, which is what `tests/pg/helpers.mjs` gives each file.
 *
 * THE FIVE MOMENTS COVERED
 *
 *   1. BEFORE SUBMISSION      — the pre-POST insert fails, so nothing may be sent.
 *   2. DURING CANCELLATION    — the journal read fails, so the sweep refuses with nothing attempted.
 *   3. AFTER POSSIBLE BROKER ACCEPTANCE — a fill arrives and cannot be persisted.
 *   4. DURING FILL PERSISTENCE — the CAS write fails; the durable pre-image must not move.
 *   5. AFTER RESTART          — the durable state is intact and unresolved orders are still unresolved.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, loadRepository, baseIntent, audit } from "./helpers.mjs";

let ctx;
let repo;
let leaseStore;

test.before(async () => {
  ctx = await setup("pgoutage");
  repo = await loadRepository();
  leaseStore = await import("../../dist/box/executionLeaseStore.js");
});
test.after(async () => { await teardown(ctx); });

/**
 * Run `fn` while `table` does not exist, then restore it.
 *
 * The restore is asserted, because a silent failure to restore would make every later assertion in this
 * file meaningless in a way that looks like a different bug.
 */
async function withTableMissing(table, fn) {
  await ctx.pool.query(`ALTER TABLE ${table} RENAME TO ${table}_outage`);
  try {
    return await fn();
  } finally {
    await ctx.pool.query(`ALTER TABLE ${table}_outage RENAME TO ${table}`);
    const { rows } = await ctx.pool.query(`SELECT to_regclass($1)::text AS t`, [table]);
    assert.equal(rows[0].t, table, `the ${table} outage must be fully reverted`);
  }
}

const coid = (tag) => `BOX:${tag}-${Math.random().toString(36).slice(2)}:ENTRY:k1_ce:a1`;

/* ══════════════ 1. BEFORE SUBMISSION — the pre-POST insert must fail ══════════════ */

test("the pre-POST durable insert FAILS during an outage, so nothing can be submitted", async () => {
  const id = coid("presubmit");
  await withTableMissing("box_order_intents", async () => {
    await assert.rejects(
      () => repo.createBoxOrderIntent(baseIntent({ client_order_id: id, state: "CREATED" })),
      (err) => /box_order_intents|does not exist/i.test(String(err && err.message)),
      "the pre-POST insert must REJECT, not resolve — resolving would let an order be sent with no " +
        "durable identity, and duplicate prevention depends entirely on that row",
    );
  });
  // And nothing was written, so a retry after recovery is a clean first attempt rather than a duplicate.
  assert.equal(
    await repo.findBoxOrderIntentByClientId(id), null,
    "a failed insert must leave no partial row behind",
  );
});

/* ══════════════ 2. DURING CANCELLATION — the journal read must throw ══════════════ */

test("the nonterminal-journal read THROWS during an outage; it must never return an empty list", async () => {
  // Seed a working order so a wrongly-empty read would be provably wrong rather than vacuously right.
  const live = coid("sweep");
  await repo.createBoxOrderIntent(baseIntent({ client_order_id: live, state: "OPEN" }));
  const before = await repo.loadNonterminalBoxOrderIntents();
  assert.ok(
    before.some((i) => i.client_order_id === live),
    "NON-VACUITY: the healthy read must see the working order, or the outage assertion proves nothing",
  );

  await withTableMissing("box_order_intents", async () => {
    await assert.rejects(
      () => repo.loadNonterminalBoxOrderIntents(),
      (err) => /box_order_intents|does not exist/i.test(String(err && err.message)),
      "THE DECISIVE PROPERTY: an unreadable journal must THROW. Returning [] would make the " +
        "cancellation sweep report a clean sweep of zero orders while a live order stays working at " +
        "the broker — a successful response presented as confirmed flatness.",
    );
  });

  // The order is still there and still working. The outage changed nothing about the exposure.
  const after = await repo.loadNonterminalBoxOrderIntents();
  assert.ok(
    after.some((i) => i.client_order_id === live),
    "exposure must be unchanged and still owned after the outage",
  );
});

test("the owned-intent read also throws rather than reporting nothing owned", async () => {
  await withTableMissing("box_order_intents", async () => {
    await assert.rejects(
      () => repo.loadOwnedBoxOrderIntents(),
      (err) => /box_order_intents|does not exist/i.test(String(err && err.message)),
      "reporting 'nothing owned' during an outage would erase attributed exposure from every " +
        "downstream decision",
    );
  });
});

/* ════ 3 + 4. AFTER POSSIBLE BROKER ACCEPTANCE / DURING FILL PERSISTENCE ════ */

test("a fill that cannot be persisted does not move the durable pre-image, and is not lost on recovery", async () => {
  const id = coid("fill");
  await repo.createBoxOrderIntent(baseIntent({ client_order_id: id, state: "SUBMITTING" }));
  const opened = await repo.updateBoxOrderIntent(
    id, { state: "OPEN", broker_order_id: "B-1" }, audit("OPEN"),
  );
  assert.equal(opened.applied, true, "the order must be durably OPEN before the outage is injected");

  // The broker has accepted and a partial fill has arrived. PostgreSQL goes away before it lands.
  await withTableMissing("box_order_intents", async () => {
    await assert.rejects(
      () => repo.updateBoxOrderIntent(
        id, { state: "PARTIALLY_FILLED", filled_quantity: 40 }, audit("PARTIALLY_FILLED"),
      ),
      (err) => /box_order_intents|does not exist/i.test(String(err && err.message)),
      "a fill write that cannot land must reject, so the caller treats the order as unresolved rather " +
        "than as accounted for",
    );
  });

  // The durable row is exactly as it was: still OPEN, still 0 filled. Nothing invented, nothing lost.
  const row = await repo.findBoxOrderIntentByClientId(id);
  assert.equal(row.state, "OPEN", "a failed write must not half-apply a state transition");
  assert.equal(row.filled_quantity, 0, "a failed write must not invent a fill");

  // The SAME fill re-applied after recovery lands exactly once, with the durable pre-image as its base.
  const replay = await repo.updateBoxOrderIntent(
    id, { state: "PARTIALLY_FILLED", filled_quantity: 40 }, audit("PARTIALLY_FILLED"),
  );
  assert.equal(replay.applied, true, "the same fill must land cleanly once persistence is back");
  assert.equal(replay.previous_filled_quantity, 0, "the pre-image must come from the locked row");
  assert.equal(replay.current_filled_quantity, 40);

  // And a duplicate of that same cumulative snapshot must not double-count.
  const again = await repo.updateBoxOrderIntent(
    id, { state: "PARTIALLY_FILLED", filled_quantity: 40 }, audit("PARTIALLY_FILLED"),
  );
  const final = await repo.findBoxOrderIntentByClientId(id);
  assert.equal(final.filled_quantity, 40, "a re-fed cumulative snapshot must be counted exactly once");
  assert.equal((again.current_filled_quantity ?? 0) - (again.previous_filled_quantity ?? 0), 0);
});

/* ══════════════ 5. AFTER RESTART — unresolved stays unresolved ══════════════ */

test("after an outage and a fresh read, unresolved orders are still unresolved and consumed budget is intact", async () => {
  // An order left non-terminal, and a session with budget already spent.
  const stuck = coid("restart");
  await repo.createBoxOrderIntent(baseIntent({ client_order_id: stuck, state: "SUBMITTING" }));

  await ctx.pool.query(`DELETE FROM box_trading_session`);
  const { BoxTradingSessionManager } = await import("../../dist/box/tradingSessionStore.js");
  const mk = () => new BoxTradingSessionManager({
    persistence: {
      load: () => repo.loadBoxTradingSession(),
      save: (r, o) => repo.saveBoxTradingSession(r, o),
      flatTradeIds: async () => [],
      consumeEntryAttempt: (a) => repo.consumeBoxTradingSessionEntryAttempt(a),
    },
    configuredMaxCompletedTrades: () => 0,
    configuredMaxEntryAttempts: () => 3,
    persistenceAvailable: () => true,
    log: () => {},
  });
  const first = mk();
  await first.initialise();
  assert.equal((await first.arm({
    maxEntryAttempts: 3, armedBy: "t", openBoxes: 0, residualLegs: 0, recoveryActive: false,
  })).ok, true);
  assert.equal((await first.recordAttemptStarted()).ok, true);
  assert.equal((await first.recordAttemptStarted()).ok, true);

  // The outage happens, and a consumption is attempted during it.
  await withTableMissing("box_trading_session", async () => {
    const refused = await first.recordAttemptStarted();
    assert.equal(
      refused.ok, false,
      "an attempt that cannot be durably counted must NOT be admitted — an uncounted attempt is an " +
        "unbounded one",
    );
    assert.match(refused.detail, /could not be durably recorded/);
  });

  // A fresh manager, as a restart would build. Consumed budget survives; nothing was handed back.
  const restarted = mk();
  await restarted.initialise();
  assert.equal(
    restarted.snapshot().entry_attempts, 2,
    "the two consumed attempts must survive the outage and the restart — handing them back is the " +
      "'restart for another attempt' hole the budget exists to close",
  );
  assert.equal(restarted.snapshot().max_entry_attempts, 3);

  // And the unresolved order is still unresolved: an outage never resolves anything.
  const nonterminal = await repo.loadNonterminalBoxOrderIntents();
  assert.ok(
    nonterminal.some((i) => i.client_order_id === stuck && i.state === "SUBMITTING"),
    "an order left SUBMITTING must still be SUBMITTING after the outage — ambiguous stays ambiguous",
  );
});

/* ══════════════ the atomic budget consume reports an outage as an ERROR ══════════════ */

test("the atomic attempt consume distinguishes an outage from a refusal by the ceiling", async () => {
  await ctx.pool.query(`DELETE FROM box_trading_session`);
  await ctx.pool.query(
    `INSERT INTO box_trading_session
       (id, session_id, armed_at, armed_by, max_completed_trades, established_trade_ids,
        completed_trade_ids, aborted_attempts, arm_count, updated_at, entry_attempts, max_entry_attempts)
     VALUES ('current','s-1',now(),'t',0,'[]'::jsonb,'[]'::jsonb,0,1,now(),1,1)`,
  );

  // Exhausted: a genuine refusal by the ceiling.
  const exhausted = await repo.consumeBoxTradingSessionEntryAttempt({ sessionId: "s-1", now: Date.now() });
  assert.equal(exhausted.ok, false);
  assert.equal(
    exhausted.reason, "budget_exhausted",
    "a ceiling refusal must be distinguishable from an infrastructure fault: the first is the system " +
      "working, the second is the system unable to answer",
  );

  // Outage: an error, NOT a budget refusal and NOT a silent pass.
  await withTableMissing("box_trading_session", async () => {
    const broken = await repo.consumeBoxTradingSessionEntryAttempt({ sessionId: "s-1", now: Date.now() });
    assert.equal(broken.ok, false, "an outage must never be reported as a successful consumption");
    assert.equal(broken.reason, "error");
    assert.equal(broken.entry_attempts, null, "an unknown counter must be null, never 0");
  });
});

/* ══════════════ the execution lease refuses rather than assuming exclusivity ══════════════ */

test("a missing lease table refuses loudly instead of assuming nobody else is trading", async () => {
  await leaseStore.ensureExecutionLeaseStoreReady();
  await withTableMissing("box_execution_leases", async () => {
    await assert.rejects(
      () => leaseStore.ensureExecutionLeaseStoreReady(),
      /box_execution_leases is missing/,
      "an absent lease table must be an explicit blocker; assuming exclusivity is the failure mode the " +
        "lease exists to remove",
    );
    const attempt = await leaseStore.acquireExecutionLease({
      deployment: "d", broker: "zerodha", account: "A1", owner: "o", instance: "i", ttlMs: 30_000,
    });
    assert.equal(attempt.ok, false);
    assert.equal(
      attempt.reason, "unavailable",
      "an outage is 'unavailable' (cannot tell), NOT 'held_by_other' (proven foreign) — the two have " +
        "opposite consequences for whether reduction is permitted",
    );
  });
});
