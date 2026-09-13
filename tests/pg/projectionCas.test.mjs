/**
 * Residual-projection CAS against a real PostgreSQL.
 *
 * This file EXISTS to close a coverage gap left by the extraction. The old the predecessor codebase suite
 * proved `applyBoxExecutionAttemptProjection` against a real MongoDB in
 * `executionAttemptProjection.test.mjs`:
 *
 *   • "real Mongo: concurrent projection writers apply one charge/version"  ->  here:
 *      "concurrent projection writers apply one version and record the charge exactly once"
 *   • "real Mongo: a physically legacy row accepts one version-zero CAS"    ->  here:
 *      "a legacy row with a NULL projection_version accepts exactly one version-zero CAS"
 *
 * GTS Algo Research made PostgreSQL the projection authority, so the guarantee is proven here against
 * the SQL implementation (`SELECT ... FOR UPDATE`, an application-id idempotency ring, and a
 * version/identity guard) instead. See tests/README.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, loadRepository } from "./helpers.mjs";

let ctx;
let repo;
let projection;

test.before(async () => {
  ctx = await setup("projcas");
  repo = await loadRepository();
  projection = await import("../../dist/box/executionAttemptProjection.js");
});
test.after(async () => { await teardown(ctx); });

/** The residual-leg shape the projection identity is computed over. */
const residual = (quantity = 75, attempt = 1) => [{
  token: 9001,
  tradingsymbol: "SYM-k1_ce",
  exchange: "NFO",
  role: "k1_ce",
  side: "BUY",
  quantity,
  average_price: 100,
  source: "partial_entry",
  created_at: 1_000 + attempt,
}];

/**
 * Insert an attempt row with a KNOWN id and a chosen projection_version/identity, exactly as the
 * old Mongo test used `model.create`/`collection.insertOne`. Uses the same pool the repository
 * reads, so the guarded UPDATE and this INSERT see the same schema.
 */
async function insertAttempt({ id, candidateKey, before, version, identity, flattenCharges = 0 }) {
  await ctx.pool.query(
    `INSERT INTO box_execution_attempts
       (id, candidate_key, resolved, residual_exposure, projection_version,
        residual_projection_identity, flatten_charges, applied_flatten_applications)
     VALUES ($1, $2, false, $3::jsonb, $4, $5, $6, '[]'::jsonb)`,
    [
      id,
      candidateKey,
      JSON.stringify(before),
      version,
      identity,
      flattenCharges,
    ],
  );
}

test("concurrent projection writers apply one version and record the charge exactly once", async () => {
  const id = repo.allocateBoxTradeId();
  const before = residual(75, 1);
  await insertAttempt({
    id,
    candidateKey: "projection-cas-test",
    before,
    version: 0,
    identity: projection.residualProjectionIdentity(before),
  });

  const command = projection.createResidualProjectionCommand({
    attemptId: id,
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(30, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 4.5,
  });

  // Two genuinely concurrent writers replaying the SAME immutable command.
  const results = await Promise.all([
    repo.applyBoxExecutionAttemptProjection(id, command),
    repo.applyBoxExecutionAttemptProjection(id, command),
  ]);

  // Exactly one performs the write; the other observes it was already applied.
  assert.deepEqual(results.map((r) => r.status).sort(), ["already_applied", "applied"]);
  // Both callers observe the SAME resulting charge attribution.
  assert.deepEqual(results.map((r) => r.flatten_charge_day), ["2026-09-07", "2026-09-07"]);
  assert.deepEqual(results.map((r) => r.flatten_charges_for_day), [4.5, 4.5]);

  const stored = (await ctx.pool.query(`SELECT * FROM box_execution_attempts WHERE id = $1`, [id])).rows[0];
  assert.equal(Number(stored.projection_version), 1, "the version advanced exactly once");
  assert.equal(Number(stored.flatten_charges), 4.5, "the charge was recorded exactly once");
  assert.deepEqual(stored.residual_exposure, residual(30, 2), "the durable residual advanced");
});

test("a legacy row with a NULL projection_version accepts exactly one version-zero CAS", async () => {
  const id = repo.allocateBoxTradeId();
  const before = residual(75, 1);
  // A physically legacy row: residual_projection_identity is absent (NULL) and projection_version
  // is at its default 0, with no application ring. This is the SQL shape of the pre-projection row
  // the version-zero CAS must be able to adopt exactly once.
  await ctx.pool.query(
    `INSERT INTO box_execution_attempts
       (id, candidate_key, resolved, residual_exposure, residual_projection_identity)
     VALUES ($1, $2, false, $3::jsonb, NULL)`,
    [id, "projection-legacy-cas-test", JSON.stringify(before)],
  );

  const command = projection.createResidualProjectionCommand({
    attemptId: id,
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(35, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 6.25,
  });

  const first = await repo.applyBoxExecutionAttemptProjection(id, command);
  assert.equal(first.status, "applied", "the version-zero CAS establishes the projection identity");
  assert.equal(first.flatten_charge_day, "2026-09-07");
  assert.equal(first.flatten_charges_for_day, 6.25);

  const stored = (await ctx.pool.query(`SELECT * FROM box_execution_attempts WHERE id = $1`, [id])).rows[0];
  assert.equal(Number(stored.projection_version), 1);
  assert.equal(Number(stored.flatten_charges), 6.25);
  assert.equal(stored.flatten_charge_day, "2026-09-07");
  assert.deepEqual(stored.residual_exposure, residual(35, 2));
  assert.deepEqual(stored.applied_flatten_applications, [command.application_id]);

  // A replay of the same command is idempotent.
  assert.equal((await repo.applyBoxExecutionAttemptProjection(id, command)).status, "already_applied");
});

test("a stale expected version is rejected without mutating the row", async () => {
  const id = repo.allocateBoxTradeId();
  const before = residual(75, 1);
  await insertAttempt({
    id,
    candidateKey: "projection-stale-cas-test",
    before,
    version: 3,
    identity: projection.residualProjectionIdentity(before),
  });
  const command = projection.createResidualProjectionCommand({
    attemptId: id,
    expectedVersion: 0, // the row is at version 3
    expectedResidual: before,
    nextResidual: residual(30, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 4.5,
  });
  const result = await repo.applyBoxExecutionAttemptProjection(id, command);
  assert.equal(result.status, "stale");
  const stored = (await ctx.pool.query(`SELECT * FROM box_execution_attempts WHERE id = $1`, [id])).rows[0];
  assert.equal(Number(stored.projection_version), 3, "a stale CAS leaves the version untouched");
  assert.equal(Number(stored.flatten_charges), 0, "and records no charge");
});
