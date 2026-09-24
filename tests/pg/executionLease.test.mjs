/**
 * EXCLUSIVE, ACCOUNT-SCOPED EXECUTION OWNERSHIP, AGAINST REAL POSTGRESQL.
 *
 * WHAT THIS IS FOR
 *
 * Nothing in this codebase established exclusive execution ownership. `backend_instance_epoch`
 * (migration 009) hands out strictly increasing boot ordinals, which order a FRONTEND's readiness
 * decisions; because the increment is atomic, two live processes always get DIFFERENT ordinals, so the
 * "two instances" detection branch in `orderReadinessDecision()` — which requires EQUAL ordinals — is
 * unreachable for exactly the topology it was meant to catch. UI restart ordering is not execution
 * fencing. `box_reservation_keys` (migration 004) is a real lease but is scoped to instrument keys, not
 * accounts.
 *
 * So this suite pins the properties the new `box_execution_leases` row must have. Every assertion is
 * made against the DATABASE, with two independent callers, because a property that only holds inside
 * one process is the property that was already missing.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE
 *
 * That a lease stops an HTTP request already on the wire. It does not, and cannot: neither broker
 * accepts a fencing token. `takeover_reconciled_at` exists precisely because of that, and the
 * reconciliation gate is asserted below.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown } from "./helpers.mjs";

let ctx;
let store;

const DEPLOYMENT = "test-deploy";
const BROKER = "zerodha";
const ACCOUNT = "AB1234";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  ctx = await setup("execlease");
  store = await import("../../dist/box/executionLeaseStore.js");
});

test.after(async () => {
  await teardown(ctx);
});

async function clean() {
  await ctx.pool.query(`DELETE FROM box_execution_leases`);
}

function owner(tag) {
  return `${DEPLOYMENT}:host:p${tag}:boot${tag}:exec-1:${tag}-uuid`;
}

const scope = () => store.executionLeaseScope({ deployment: DEPLOYMENT, broker: BROKER, account: ACCOUNT });

function acquire(tag, ttlMs = 30_000) {
  return store.acquireExecutionLease({
    deployment: DEPLOYMENT,
    broker: BROKER,
    account: ACCOUNT,
    owner: owner(tag),
    instance: `inst-${tag}`,
    ttlMs,
  });
}

/* ───────────────────────── the store exists ───────────────────────── */

/**
 * NON-VACUITY, and a regression guard for a specific trap.
 *
 * The first version of this probe asked `pg_class WHERE relname = 'box_execution_leases'`. `relname` is
 * CLUSTER-WIDE and unique only per schema, so with several test schemas in one database the probe found
 * somebody else's table and passed while the one THIS connection would use was absent — the exact
 * defect migration 014 exists to repair, reproduced. The probe now uses `to_regclass`, which resolves
 * through `search_path`. Renaming the table out from under it is how that is proved.
 */
test("the lease store probe is scoped to this schema, not to any table of that name in the database", async () => {
  await store.ensureExecutionLeaseStoreReady();
  await ctx.pool.query(`ALTER TABLE box_execution_leases RENAME TO box_execution_leases_hidden`);
  try {
    await assert.rejects(
      () => store.ensureExecutionLeaseStoreReady(),
      /box_execution_leases is missing/,
      "a missing lease table must fail loudly, never silently permit unfenced execution",
    );
  } finally {
    // Always restore, or every later test in this file fails for the wrong reason.
    await ctx.pool.query(`ALTER TABLE box_execution_leases_hidden RENAME TO box_execution_leases`);
  }
  await store.ensureExecutionLeaseStoreReady();
});

/* ─────────── 1. two independent callers, one account, one winner ─────────── */

test("a second caller cannot acquire a lease a live instance already holds", async () => {
  await clean();

  const first = await acquire("a");
  assert.equal(first.ok, true, "the first caller must get the lease");
  assert.equal(first.took_over, false, "a fresh acquisition is not a takeover");
  assert.equal(first.lease.account, ACCOUNT);
  assert.ok(first.lease.fence > 0, "a lease must carry a positive fence");
  assert.equal(first.lease.takeover_reason, "fresh");

  const second = await acquire("b");
  assert.equal(second.ok, false, "a second live caller must be REFUSED, not queued");
  assert.equal(second.reason, "held_by_other");
  assert.match(
    second.detail,
    /will NOT submit orders/,
    "the refusal must say plainly that this process will not submit orders",
  );
  assert.equal(second.holder?.owner, owner("a"), "the refusal must name the actual holder");

  // And the durable row still belongs to the first caller, unchanged.
  const row = await store.readExecutionLease(scope());
  assert.equal(row.owner, owner("a"));
  assert.equal(row.fence, first.lease.fence);
});

test("concurrent first-acquisitions produce exactly one winner", async () => {
  await clean();
  const results = await Promise.all([
    acquire("c1"), acquire("c2"), acquire("c3"), acquire("c4"), acquire("c5"),
  ]);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, `exactly one caller may win, got ${winners.length}`);
  for (const loser of results.filter((r) => !r.ok)) {
    assert.equal(loser.reason, "held_by_other", `a loser must be refused for ownership: ${loser.detail}`);
  }
  const row = await store.readExecutionLease(scope());
  assert.equal(row.owner, winners[0].lease.owner);
});

/* ───────────────── 2. re-acquiring our own lease is idempotent ───────────────── */

test("an owner reacquiring its own lease keeps its fence and its reconciled stamp", async () => {
  await clean();
  const first = await acquire("a");
  assert.equal(first.ok, true);

  // Stamp it reconciled, as a takeover would after cleaning up.
  const stamped = await store.markExecutionLeaseReconciled({
    scope: scope(), owner: owner("a"), fence: first.lease.fence,
  });
  assert.notEqual(stamped, null, "our own unexpired lease must be stampable");
  assert.notEqual(stamped.takeover_reconciled_at, null);

  // Reacquire — a reconnect, or a broker-context refresh.
  const again = await acquire("a");
  assert.equal(again.ok, true, "an owner must be able to reacquire its own lease");
  assert.equal(
    again.lease.fence,
    first.lease.fence,
    "reacquiring our OWN lease must not bump the fence: in-flight guards captured it",
  );
  assert.notEqual(
    again.lease.takeover_reconciled_at,
    null,
    "reacquiring our own lease must not force us to re-reconcile",
  );
  assert.equal(again.took_over, false);
});

/* ───────────── 3. owner death / TTL lapse permits exactly one takeover ───────────── */

test("a lapsed lease may be taken over by exactly one successor, with a higher fence and a cleared reconciled stamp", async () => {
  await clean();

  // A short TTL stands in for an owner that died: it stops renewing and the row lapses.
  const dead = await acquire("dead", 1_200);
  assert.equal(dead.ok, true);
  await store.markExecutionLeaseReconciled({
    scope: scope(), owner: owner("dead"), fence: dead.lease.fence,
  });

  // While it is still live, a successor is refused. This is the "paused owner" case: the owner is not
  // renewing, but its lease has not lapsed yet, so nobody may take over.
  const tooEarly = await acquire("succ");
  assert.equal(tooEarly.ok, false, "a successor must NOT take over a lease that has not lapsed");
  assert.equal(tooEarly.reason, "held_by_other");

  await sleep(1_500);

  const takers = await Promise.all([acquire("s1"), acquire("s2"), acquire("s3")]);
  const won = takers.filter((r) => r.ok);
  assert.equal(won.length, 1, `exactly one successor may take over, got ${won.length}`);
  const successor = won[0];
  assert.equal(successor.took_over, true, "the successor must know it took over");
  assert.ok(
    successor.lease.fence > dead.lease.fence,
    `the successor's fence (${successor.lease.fence}) must exceed the predecessor's (${dead.lease.fence})`,
  );
  assert.equal(
    successor.lease.takeover_reconciled_at,
    null,
    "a takeover must CLEAR the reconciled stamp, so new entry stays refused until pending broker " +
      "operations are reconciled",
  );
  assert.equal(successor.lease.takeover_reason, "expired");
});

/* ─────────── 4. the dead predecessor cannot interfere with its successor ─────────── */

test("a superseded owner can neither renew, stamp, nor release its successor's lease", async () => {
  await clean();
  const old = await acquire("old", 1_200);
  assert.equal(old.ok, true);
  await sleep(1_500);
  const next = await acquire("new");
  assert.equal(next.ok, true);
  assert.equal(next.took_over, true);

  // RENEW: the old owner wakes up (a GC pause, a reconnect) and tries to keep its lease alive.
  const renewed = await store.renewExecutionLease({
    scope: scope(), owner: owner("old"), fence: old.lease.fence, ttlMs: 30_000,
  });
  assert.equal(renewed, null, "a lapsed owner must NOT be able to renew back to life");

  // STAMP: it must not be able to declare the successor's takeover reconciled.
  const stamped = await store.markExecutionLeaseReconciled({
    scope: scope(), owner: owner("old"), fence: old.lease.fence,
  });
  assert.equal(stamped, null, "a superseded owner must not stamp the lease");

  // RELEASE: the shutdown path of the old process must not delete the successor's row. This is the
  // fence-pinning property; without it a late shutdown would hand the account to nobody.
  const removed = await store.releaseExecutionLease({
    scope: scope(), owner: owner("old"), fence: old.lease.fence,
  });
  assert.equal(removed, 0, "a fence-pinned release must not remove a successor's lease");

  const row = await store.readExecutionLease(scope());
  assert.equal(row.owner, owner("new"), "the successor must still own the account");
  assert.equal(row.fence, next.lease.fence);
});

/* ───────────────── 5. clean release frees the account immediately ───────────────── */

test("a clean fence-pinned release lets the next instance acquire at once", async () => {
  await clean();
  const first = await acquire("a");
  assert.equal(first.ok, true);

  const removed = await store.releaseExecutionLease({
    scope: scope(), owner: owner("a"), fence: first.lease.fence,
  });
  assert.equal(removed, 1, "an owner must be able to release its own lease");
  assert.equal(await store.readExecutionLease(scope()), null);

  const second = await acquire("b");
  assert.equal(second.ok, true, "a released account must be immediately acquirable");
  assert.equal(second.took_over, false, "acquiring a released (absent) row is fresh, not a takeover");
  assert.ok(second.lease.fence > first.lease.fence, "fences remain monotonic across a clean handover");
});

/* ───────────────── 6. reconciliation gate and scope isolation ───────────────── */

test("the reconciled stamp is per-lease and a different account is a different lease", async () => {
  await clean();
  const a = await acquire("a");
  assert.equal(a.ok, true);

  const otherScope = store.executionLeaseScope({
    deployment: DEPLOYMENT, broker: BROKER, account: "ZZ9999",
  });
  const other = await store.acquireExecutionLease({
    deployment: DEPLOYMENT, broker: BROKER, account: "ZZ9999",
    owner: owner("b"), instance: "inst-b", ttlMs: 30_000,
  });
  assert.equal(other.ok, true, "a DIFFERENT account must be independently leasable");
  assert.notEqual(other.lease.scope, a.lease.scope);

  // A different broker for the same account number is also a different lease.
  const dhan = await store.acquireExecutionLease({
    deployment: DEPLOYMENT, broker: "dhan", account: ACCOUNT,
    owner: owner("c"), instance: "inst-c", ttlMs: 30_000,
  });
  assert.equal(dhan.ok, true, "the same account number under a different broker is a different lease");

  await ctx.pool.query(`DELETE FROM box_execution_leases WHERE scope = $1`, [otherScope]);
});

test("reaping removes only lapsed rows and never a live one", async () => {
  await clean();
  const live = await acquire("live", 30_000);
  assert.equal(live.ok, true);
  await store.acquireExecutionLease({
    deployment: DEPLOYMENT, broker: "dhan", account: "SHORT1",
    owner: owner("short"), instance: "inst-short", ttlMs: 1_000,
  });
  await sleep(1_300);

  const reaped = await store.reapExpiredExecutionLeases();
  assert.equal(reaped, 1, `exactly the lapsed row may be reaped, got ${reaped}`);
  const still = await store.readExecutionLease(scope());
  assert.notEqual(still, null, "the live lease must survive a reap");
  assert.equal(still.owner, owner("live"));
});

test("listing by owner reports this process's leases only", async () => {
  await clean();
  const mine = await acquire("mine");
  assert.equal(mine.ok, true);
  await store.acquireExecutionLease({
    deployment: DEPLOYMENT, broker: "dhan", account: "OTHER1",
    owner: owner("theirs"), instance: "inst-theirs", ttlMs: 30_000,
  });

  const listed = await store.listExecutionLeasesByOwner(owner("mine"));
  assert.equal(listed.length, 1, "only our own leases may be listed");
  assert.equal(listed[0].account, ACCOUNT);
});

/* ─────── 7. the server's clock decides expiry, and remaining life is derivable ─────── */

test("remaining life is computed from the server clock, not the caller's", async () => {
  await clean();
  const got = await acquire("a", 10_000);
  assert.equal(got.ok, true);
  const remaining = got.lease.expires_at - got.lease.server_now;
  assert.ok(
    remaining > 8_000 && remaining <= 10_100,
    `remaining life must come from one clock and be near the TTL, got ${remaining}ms`,
  );
  // Both values are server-clock readings from the same statement, so their difference is skew-free
  // even if this process's clock is wrong. Prove the row carries both.
  assert.ok(Number.isFinite(got.lease.server_now) && got.lease.server_now > 0);
  assert.ok(Number.isFinite(got.lease.expires_at) && got.lease.expires_at > got.lease.server_now);
});
