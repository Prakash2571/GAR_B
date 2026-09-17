/**
 * AN UNREADABLE RESIDUAL PICTURE MUST NOT LOOK LIKE AN EMPTY ONE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS FILE PINS
 *
 * `loadUnresolvedBoxExecutionAttempts()` used to end with:
 *
 *     } catch {
 *       return [];
 *     }
 *
 * so three completely different situations produced the identical answer:
 *
 *   1. there genuinely is no outstanding residual exposure;
 *   2. the database is unreachable;
 *   3. the query was refused (permissions, a missing relation, a statement timeout).
 *
 * Its ONE caller — `BoxEngine.reconcileResidualExposure()`, which runs once at boot — therefore
 * adopted nothing and reported nothing. That is not merely a missing warning. `flattenResiduals()`
 * clears its own interval the first time it finds the residual map empty, so a single spurious `[]`
 * meant the unresolved rows were NEVER revisited for the remaining life of the process, while the
 * engine reported zero residual exposure throughout.
 *
 * "Unknown" and "none" are different claims and only one of them is safe. The loader now propagates
 * the failure so the engine can refuse new entry, publish a blocker naming the cause, and retry —
 * without ever blocking reduction of exposure it already knows about.
 *
 * WHY THIS TEST IS AGAINST A REAL DATABASE
 * The behaviour being fixed is precisely what happens when a real query fails. A stubbed rejection
 * would prove only that a `try/catch` was deleted; dropping the relation out from under the real
 * pooled query proves the whole path propagates.
 */

import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { setup, teardown, loadRepository } from "./helpers.mjs";

let ctx;
let repo;

test.before(async () => {
  ctx = await setup("residualload");
  repo = await loadRepository();
});
test.after(async () => {
  await teardown(ctx);
});

const BASE_URL = (process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge").trim();

/** Run DDL as an admin connection inside this file's private schema. */
async function admin(sql) {
  const client = new pg.Client({ connectionString: BASE_URL });
  await client.connect();
  try {
    await client.query(`SET search_path = ${ctx.schema}`);
    await client.query(sql);
  } finally {
    await client.end().catch(() => {});
  }
}

test("a HEALTHY database returns the real (empty) set — the non-vacuous control", async () => {
  const rows = await repo.loadUnresolvedBoxExecutionAttempts();
  assert.ok(Array.isArray(rows), "a readable, empty residual table must still resolve to an array");
  assert.equal(rows.length, 0, "nothing unresolved has been inserted yet");
});

test("an unresolved attempt IS found while the table is readable", async () => {
  const id = await repo.insertBoxExecutionAttempt({
    candidate_key: "RELIANCE|2026-09-24|100|110|LONG_BOX",
    underlying: "RELIANCE",
    execution_mode: "paper_legging",
    broker: "zerodha",
    resolved: false,
    residual_exposure: [
      {
        token: 9001,
        tradingsymbol: "SYM-k1_ce",
        exchange: "NFO",
        role: "k1_ce",
        side: "BUY",
        quantity: 75,
        average_price: 100,
        source: "partial_entry",
        created_at: 1_000,
      },
    ],
  });
  assert.ok(id, "the attempt row must persist");

  const rows = await repo.loadUnresolvedBoxExecutionAttempts();
  assert.equal(rows.length, 1, "the unresolved attempt must be discoverable");
  assert.equal(rows[0].execution_mode, "paper_legging", "the row must carry the mode it was created under");
  assert.equal(rows[0].broker, "zerodha", "the row must carry its broker");
});

test("a FAILING query REJECTS instead of reporting 'no residuals'", async () => {
  // Remove the relation under the live pool. Every code path in the loader references it, so the
  // next call is guaranteed to fail at the database rather than in our own arithmetic.
  await admin("DROP TABLE box_execution_attempts CASCADE");

  await assert.rejects(
    () => repo.loadUnresolvedBoxExecutionAttempts(),
    (err) => {
      assert.ok(err instanceof Error, "the failure must surface as an Error");
      assert.match(
        String(err.message),
        /box_execution_attempts|does not exist|relation/i,
        `the cause must be legible to an operator, got: ${err.message}`,
      );
      return true;
    },
    "an unreadable residual picture must NOT resolve to an empty array",
  );
});
