/**
 * THE DURABLE BOOT ORDINAL — claiming it, retrying it, and never claiming it twice.
 *
 * WHY THESE TESTS EXIST. Without an ordinal the readiness decision is unorderable, a client refuses
 * the whole status payload, and the engine itself refuses new entry (`instance_epoch_unknown`). So the
 * claim is on the path of "can this deployment trade at all", and it had two defects:
 *
 *   1. It was claimed ONLY inside `BoxEngine.start()` — on RUN. A freshly booted process therefore
 *      published an unorderable decision, the dashboard showed `MODE UNKNOWN` with an empty board, and
 *      the pre-run dialog could not name the execution mode until after RUN had already happened.
 *   2. `resolveBootOrdinal` documents that a transient failure is deliberately left unresolved so
 *      "a later attempt may succeed once the database is reachable" — and nothing ever made a later
 *      attempt. One fire-and-forget call site meant a single blip left the process refusing entry for
 *      its entire life, clearable only by a restart.
 *
 * Fixing (2) introduced a new hazard that (1) had masked: with a retry, two attempts can overlap, and
 * `UPDATE … last_ordinal + 1` is not idempotent. Consuming two ordinals would leave this process
 * holding the LOWER one while the database had advanced past it — so a later boot could mint an
 * ordinal this process had already published, which is exactly the ordering guarantee the whole
 * mechanism exists to provide. The single-flight test below is the one that guards that.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BackendInstance } from "../../dist/box/backendInstance.js";

/** A stub epoch query with a controllable outcome and a call count. */
function epoch({ rows = [{ last_ordinal: 1 }], failWith = null, delayMs = 0 } = {}) {
  const state = { calls: 0, rows, failWith };
  const run = async () => {
    state.calls++;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (state.failWith !== null) throw state.failWith;
    return { rows: state.rows };
  };
  return { run, state };
}

/* ══════════════════════════ the happy path ══════════════════════════ */

test("a successful claim publishes the ordinal and settles", async () => {
  const { run, state } = epoch({ rows: [{ last_ordinal: 7 }] });
  const instance = new BackendInstance({ query: run });

  assert.equal(instance.hasOrdinal(), false, "null until claimed — and null is not zero");
  assert.equal(instance.identity().boot_ordinal, null);

  assert.equal(await instance.resolveBootOrdinal(), 7);
  assert.equal(instance.hasOrdinal(), true);
  assert.equal(instance.identity().boot_ordinal, 7);
  assert.equal(instance.ordinalError(), null);
  assert.equal(instance.permanentlyUnavailable(), false);
  assert.equal(state.calls, 1);
});

test("PostgreSQL bigint arrives as a string and is still a usable ordinal", async () => {
  // node-postgres returns bigint as a string; treating that as unusable would refuse entry on a
  // perfectly good claim.
  const { run } = epoch({ rows: [{ last_ordinal: "42" }] });
  const instance = new BackendInstance({ query: run });
  assert.equal(await instance.resolveBootOrdinal(), 42);
  assert.equal(instance.hasOrdinal(), true);
});

test("a settled claim never issues a second UPDATE", async () => {
  const { run, state } = epoch({ rows: [{ last_ordinal: 3 }] });
  const instance = new BackendInstance({ query: run });
  await instance.resolveBootOrdinal();
  await instance.resolveBootOrdinal();
  await instance.resolveBootOrdinal();
  assert.equal(state.calls, 1, "a second UPDATE would consume an ordinal this process cannot use");
  assert.equal(instance.identity().boot_ordinal, 3);
});

/* ══════════════ single-flight: the hazard the retry introduced ══════════════ */

test("CONCURRENT claims share ONE attempt and consume ONE ordinal", async () => {
  // The invariant: "idempotent per process — it can never consume a second ordinal and make this
  // process look newer than itself". `resolved` cannot provide it alone, because it stays false for
  // the whole duration of an attempt.
  const { run, state } = epoch({ rows: [{ last_ordinal: 9 }], delayMs: 25 });
  const instance = new BackendInstance({ query: run });

  const results = await Promise.all([
    instance.resolveBootOrdinal(),
    instance.resolveBootOrdinal(),
    instance.resolveBootOrdinal(),
  ]);

  assert.equal(state.calls, 1, "three overlapping claims must issue exactly one UPDATE");
  assert.deepEqual(results, [9, 9, 9], "and all callers see the same ordinal");
  assert.equal(instance.identity().boot_ordinal, 9);
});

/* ══════════════════════ transient vs permanent ══════════════════════ */

test("a TRANSIENT failure stays retryable, and a retry succeeds", async () => {
  const { run, state } = epoch({ failWith: new Error("ECONNREFUSED 127.0.0.1:5432") });
  const instance = new BackendInstance({ query: run });

  assert.equal(await instance.resolveBootOrdinal(), null);
  assert.equal(instance.hasOrdinal(), false);
  assert.equal(
    instance.permanentlyUnavailable(),
    false,
    "an unreachable database must remain retryable — this is the defect that stranded a process for life",
  );
  assert.match(instance.ordinalError(), /could not claim a boot ordinal from PostgreSQL/);
  assert.match(instance.ordinalError(), /ECONNREFUSED/, "the cause must reach the operator verbatim");

  // PostgreSQL comes back.
  state.failWith = null;
  state.rows = [{ last_ordinal: 12 }];
  assert.equal(await instance.resolveBootOrdinal(), 12);
  assert.equal(instance.hasOrdinal(), true);
  assert.equal(instance.ordinalError(), null, "the stale error must be cleared, not left on screen");
  assert.equal(state.calls, 2);
});

test("a MISSING epoch row is permanent — retrying cannot fix a missing migration", async () => {
  const { run, state } = epoch({ rows: [] });
  const instance = new BackendInstance({ query: run });

  assert.equal(await instance.resolveBootOrdinal(), null);
  assert.equal(instance.permanentlyUnavailable(), true);
  assert.match(instance.ordinalError(), /migration 009_backend_instance_epoch\.sql has not been applied/);

  // And it must stop asking: hammering the database over a deployment error helps nobody.
  await instance.resolveBootOrdinal();
  assert.equal(state.calls, 1);
});

test("an UNUSABLE ordinal is permanent, and is never silently treated as zero", async () => {
  for (const bad of [0, -1, "not-a-number"]) {
    const { run } = epoch({ rows: [{ last_ordinal: bad }] });
    const instance = new BackendInstance({ query: run });
    assert.equal(await instance.resolveBootOrdinal(), null, `${bad} must not be accepted`);
    assert.equal(instance.permanentlyUnavailable(), true);
    assert.equal(instance.hasOrdinal(), false);
    assert.match(instance.ordinalError(), /unusable ordinal/);
  }
});

test("never throws — it is polled, so a rejection would become an unhandled rejection", async () => {
  for (const thrown of [new Error("boom"), "a string", null, undefined]) {
    const instance = new BackendInstance({
      query: async () => {
        throw thrown;
      },
    });
    await assert.doesNotReject(() => instance.resolveBootOrdinal());
    assert.equal(instance.hasOrdinal(), false);
  }
});

/* ══════════════════════ identity ══════════════════════ */

test("distinct instances are distinct, and started_at never orders anything", async () => {
  const a = new BackendInstance({ query: epoch({ rows: [{ last_ordinal: 1 }] }).run });
  const b = new BackendInstance({ query: epoch({ rows: [{ last_ordinal: 2 }] }).run });
  await a.resolveBootOrdinal();
  await b.resolveBootOrdinal();
  assert.notEqual(a.identity().instance_id, b.identity().instance_id);
  assert.equal(a.identity().boot_ordinal, 1);
  assert.equal(b.identity().boot_ordinal, 2);
  // started_at is audit-only. A wall clock cannot order instances (NTP steps, snapshot restores), and
  // this asserts it is at least present and numeric rather than load-bearing.
  assert.equal(typeof a.identity().started_at, "number");
});
