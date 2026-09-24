/**
 * EXECUTION-OWNERSHIP STATE TRANSITIONS.
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM executionLeaseGuard.test.mjs.
 *
 * That suite installs a state directly and asks what the guard answers for it. Every individual state
 * was covered that way — including "`refused` blocks both directions" and "`unavailable` blocks entry
 * but permits reduction" — and the suite was still blind to a real defect, because the defect was not
 * in any single state. It was in the MOVE BETWEEN two of them:
 *
 *     refused  ──(the lease store threw)──▶  unavailable
 *
 * Both endpoints behaved exactly as their own tests demanded. The transition was the bug: `refused` is
 * proof that another live instance owns the account, `unavailable` means "I could not find out", and
 * demoting the first to the second re-permitted exposure reduction — concurrent flatten and cancel —
 * while the other owner was still trading. A failed query is not evidence that a competitor went away;
 * the likeliest cause of the failure (PostgreSQL unreachable) leaves the competitor entirely untouched.
 *
 * So these tests drive `refresh()` ACROSS PASSES with different store answers and assert on the guard
 * after each one. They need no database: the durable-store operations are injected (see
 * `ExecutionLeaseStoreOps`), which is what makes "the second call throws" expressible at all.
 *
 * THE RULE BEING PINNED: once proven-foreign evidence exists for a scope, only an authoritative answer
 * about that scope may replace it — a successful acquire/renew, another proven-foreign answer, or this
 * process releasing. "I could not ask" changes nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { BoxExecutionLeaseManager } = await import("../../dist/box/executionLease.js");

const DEPLOYMENT = "d";
const OWNER = "d:i:p1:b1:exec-1:uuid";

/** A row as the database would return it: `server_now` is the authority's clock, `expires_at` its TTL. */
function row({ serverNow = 1_000_000, lifeMs = 30_000, reconciled = true, broker = "zerodha", account = "AB1234" } = {}) {
  return {
    scope: `${DEPLOYMENT}|${broker}|${account}`,
    deployment: DEPLOYMENT,
    broker,
    account,
    owner: OWNER,
    instance: "i",
    fence: 7,
    acquired_at: serverNow,
    renewed_at: serverNow,
    expires_at: serverNow + lifeMs,
    takeover_reconciled_at: reconciled ? serverNow : null,
    takeover_reason: "fresh",
    server_now: serverNow,
  };
}

const HELD_BY_OTHER = {
  ok: false,
  reason: "held_by_other",
  detail: "held by instance-B until 12:00:05",
  holder: { owner: "other:instance:B" },
};

const STORE_UNAVAILABLE = {
  ok: false,
  reason: "unavailable",
  detail: "PostgreSQL did not return a fencing token for the execution lease",
  holder: null,
};

/**
 * A manager with injected store operations and a controllable clock.
 *
 * `clock` is a mutable counter, which is monotonic — the same property the production default
 * (`monotonicNowMs`) has, so a test can never accidentally depend on wall-clock behaviour.
 */
function harness({ broker = () => "zerodha", account = () => "AB1234", persistenceAvailable = () => true } = {}) {
  const clock = { t: 500_000 };
  /**
   * The operations a test reassigns between passes. The manager resolves its store ONCE at
   * construction, so the injected functions delegate through this record rather than being it —
   * otherwise a mid-test reassignment would be silently ignored and every transition assertion would
   * be measuring the first pass twice.
   */
  const impl = {
    acquire: async () => STORE_UNAVAILABLE,
    renew: async () => null,
    markReconciled: async () => null,
    release: async () => 1,
    read: async () => null,
    ready: async () => undefined,
  };
  const store = {
    acquire: (args) => impl.acquire(args),
    renew: (args) => impl.renew(args),
    markReconciled: (args) => impl.markReconciled(args),
    release: (args) => impl.release(args),
    read: (scope) => impl.read(scope),
    ready: () => impl.ready(),
  };
  const manager = new BoxExecutionLeaseManager({
    deployment: DEPLOYMENT,
    instance: "i",
    owner: OWNER,
    broker,
    account,
    persistenceAvailable,
    liveCapable: () => true,
    now: () => clock.t,
    log: () => {},
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    store,
  });
  return { manager, store: impl, clock };
}

/** Both guard answers at once, so a transition is asserted in both directions every time. */
function guards(manager) {
  return {
    entry: manager.dispatchBlockReason("new_entry"),
    reduce: manager.dispatchBlockReason("exposure_reduction"),
  };
}

/* ───────────── a store failure must not erase proven foreign ownership ───────────── */

test("refused ──(store THREW)──▶ stays refused: reduction is NOT re-permitted", async () => {
  const { manager, store } = harness();

  store.acquire = async () => HELD_BY_OTHER;
  await manager.refresh();
  assert.equal(manager.snapshot().kind, "refused");
  assert.ok(guards(manager).reduce !== null, "a proven foreign owner must block reduction");

  // The next pass cannot reach PostgreSQL at all.
  store.acquire = async () => {
    throw new Error("connection terminated unexpectedly");
  };
  await manager.refresh();

  assert.equal(
    manager.snapshot().kind,
    "refused",
    "a storage failure is not evidence the other owner released the account",
  );
  const after = guards(manager);
  assert.ok(
    after.reduce !== null,
    "THE DEFECT: the reduction guard went permissive after a lease-store error, so a concurrent " +
      "flatten or cancel could race the live owner",
  );
  assert.ok(after.entry !== null, "new entry must stay refused as well");
  assert.match(after.reduce, /held by another instance/);
});

test("refused ──(store answered `unavailable`)──▶ stays refused", async () => {
  // The store does not have to throw: a failed fence read, or any error it catches itself, returns
  // `reason: "unavailable"` on the ordinary path. That must be treated identically.
  const { manager, store } = harness();
  store.acquire = async () => HELD_BY_OTHER;
  await manager.refresh();

  store.acquire = async () => STORE_UNAVAILABLE;
  await manager.refresh();

  assert.equal(manager.snapshot().kind, "refused");
  assert.ok(guards(manager).reduce !== null);
});

test("refused ──(persistence disappeared)──▶ stays refused", async () => {
  let pg = true;
  const { manager, store } = harness({ persistenceAvailable: () => pg });
  store.acquire = async () => HELD_BY_OTHER;
  await manager.refresh();

  pg = false;
  await manager.refresh();

  assert.equal(
    manager.snapshot().kind,
    "refused",
    "losing the database is usually the SAME outage that stopped us asking — not a release",
  );
  assert.ok(guards(manager).reduce !== null);
});

test("refused ──(account no longer resolvable)──▶ stays refused", async () => {
  let account = "AB1234";
  const { manager, store } = harness({ account: () => account });
  store.acquire = async () => HELD_BY_OTHER;
  await manager.refresh();

  account = null;
  await manager.refresh();

  assert.equal(manager.snapshot().kind, "refused");
  assert.ok(guards(manager).reduce !== null);
});

test("lost ──(store THREW)──▶ stays lost", async () => {
  const { manager, store } = harness();
  store.acquire = async () => ({ ok: true, lease: row(), took_over: false });
  await manager.refresh();
  assert.equal(manager.snapshot().kind, "held");

  // The renewal finds no row it may renew: ours lapsed and may have been taken over.
  store.renew = async () => null;
  await manager.refresh();
  assert.equal(manager.snapshot().kind, "lost");
  assert.ok(guards(manager).reduce !== null);

  store.acquire = async () => {
    throw new Error("connection terminated unexpectedly");
  };
  await manager.refresh();
  assert.equal(manager.snapshot().kind, "lost", "a storage error must not soften a proven loss");
  assert.ok(guards(manager).reduce !== null);
});

/* ─────────────── but the refusal must not become permanent either ─────────────── */

test("refused ──(acquisition SUCCEEDED)──▶ held: the refusal is cleared by authority", async () => {
  const { manager, store } = harness();
  store.acquire = async () => HELD_BY_OTHER;
  await manager.refresh();
  assert.equal(manager.snapshot().kind, "refused");

  // The other instance shut down and we genuinely own the row now. This is the ONLY thing that
  // clears the evidence, and it must clear it — a sticky refusal that never lifts would strand
  // exposure just as badly as a refusal that lifts too easily.
  store.acquire = async () => ({ ok: true, lease: row(), took_over: true });
  await manager.refresh();

  assert.equal(manager.snapshot().kind, "held");
  assert.equal(guards(manager).reduce, null, "a held lease permits reduction");
});

test("refused ──(the scope CHANGED)──▶ unavailable: evidence about another account is retired", async () => {
  let broker = "zerodha";
  const { manager, store } = harness({ broker: () => broker });
  store.acquire = async () => HELD_BY_OTHER;
  await manager.refresh();
  assert.equal(manager.snapshot().kind, "refused");

  // A broker switch means a different lease entirely. The old refusal was about a different
  // account and says nothing about this one, so it must NOT be carried across — otherwise one
  // stale refusal would suppress protective reduction on an unrelated account forever.
  broker = "dhan";
  store.acquire = async () => STORE_UNAVAILABLE;
  await manager.refresh();

  assert.equal(manager.snapshot().kind, "unavailable");
  assert.equal(
    guards(manager).reduce,
    null,
    "with no evidence for THIS scope, reduction stays available",
  );
});

/* ─────────────────────────── the lease-lifetime arithmetic ─────────────────────────── */

test("the measured database round-trip is charged against the observed lifetime", async () => {
  const { manager, store, clock } = harness();
  // The row grants 30s from the server's clock, but the answer takes 4s to arrive. Those 4s are
  // lease life that was ALREADY spent before this process could act on the number.
  store.acquire = async () => {
    clock.t += 4_000;
    return { ok: true, lease: row({ lifeMs: 30_000 }), took_over: false };
  };
  await manager.refresh();

  const state = manager.snapshot();
  assert.equal(state.kind, "held");
  assert.equal(
    state.lease.remainingAtObservationMs,
    26_000,
    "a cached lease must never claim more life than the row could still have had on arrival",
  );

  // 26s of charged life, 5s guard margin ⇒ the guard must refuse from 21s after the observation.
  clock.t += 20_999;
  assert.equal(guards(manager).reduce, null, "just inside the provable window");
  clock.t += 1;
  assert.ok(
    guards(manager).reduce !== null,
    "at the margin boundary the guard must refuse in BOTH directions",
  );
  assert.ok(guards(manager).entry !== null);
});

test("a renewal is charged for its round-trip too", async () => {
  const { manager, store, clock } = harness();
  store.acquire = async () => ({ ok: true, lease: row({ lifeMs: 30_000 }), took_over: false });
  await manager.refresh();

  store.renew = async () => {
    clock.t += 3_000;
    return row({ serverNow: 1_030_000, lifeMs: 30_000 });
  };
  await manager.refresh();

  assert.equal(manager.snapshot().lease.remainingAtObservationMs, 27_000);
});

test("a clock that moves BACKWARDS refuses both directions instead of looking fresh", async () => {
  const { manager, store, clock } = harness();
  store.acquire = async () => ({ ok: true, lease: row(), took_over: false });
  await manager.refresh();
  assert.equal(guards(manager).entry, null, "sanity: a fresh, reconciled lease permits entry");

  // An NTP step, a manual `date -s`, or a restored VM snapshot. The old arithmetic clamped the
  // resulting negative elapsed time to zero, which reported the observation as maximally FRESH —
  // the one failure mode where a broken clock made the guard MORE permissive.
  clock.t -= 60_000;

  const after = guards(manager);
  assert.ok(after.entry !== null, "a backwards clock must not permit new entry");
  assert.ok(after.reduce !== null, "nor reduction: the observation's age is unmeasurable");
  assert.match(after.reduce, /BACKWARDS/);
});

test("the production default clock is monotonic, not the settable wall clock", async () => {
  // No `now` injected, so the manager uses its default source. A monotonic reading is measured from
  // process start, so it is many orders of magnitude smaller than a Unix epoch millisecond value.
  const manager = new BoxExecutionLeaseManager({
    deployment: DEPLOYMENT,
    instance: "i",
    owner: OWNER,
    broker: () => "zerodha",
    account: () => "AB1234",
    persistenceAvailable: () => true,
    liveCapable: () => true,
    log: () => {},
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    store: { acquire: async () => ({ ok: true, lease: row(), took_over: false }) },
  });
  await manager.refresh();

  const observed = manager.snapshot().lease.observedAtLocal;
  assert.ok(
    observed < Date.now() - 1_000_000_000,
    `expected a process-relative monotonic reading, got ${observed}, which looks like Date.now()`,
  );
});
