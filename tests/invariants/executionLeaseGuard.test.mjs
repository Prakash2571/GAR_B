/**
 * THE SYNCHRONOUS EXECUTION-OWNERSHIP GUARD, AND ITS DELIBERATE ASYMMETRY.
 *
 * `dispatchBlockReason()` is the predicate `orderManager.ts` CHECKPOINT 5 calls in the last instant
 * before a broker POST. It must be synchronous (no await may separate the check from the wire) and it
 * must distinguish two things that look alike:
 *
 *   CANNOT TELL      — no lease table, no proven account, nothing acquired yet. No evidence a second
 *                      instance exists. NEW ENTRY refused; REDUCTION permitted, because refusing a
 *                      reduction strands real exposure for a reason that is not evidence of anything.
 *   PROVEN FOREIGN   — another live instance holds the lease, ours lapsed, or our observation is too
 *                      old to prove we still hold it. Now there IS evidence of a second owner, and
 *                      BOTH directions stop: two processes flattening double-close, two cancelling
 *                      race each other.
 *
 * This mirrors `orderManager.dispatchAccountBlockReason`, which blocks only on positive proof of a
 * different account for exactly the same reason.
 *
 * These tests drive the manager with an injected clock and no database at all, because the guard is
 * required to read only its cached observation. The durable half is covered against real PostgreSQL in
 * tests/pg/executionLease.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { BoxExecutionLeaseManager, leaseUseForPurpose, executionLeaseStatus } = await import(
  "../../dist/box/executionLease.js"
);

/** A manager whose state we set directly, with a controllable clock and no timers. */
function manager({ liveCapable = true, now = () => 1_000_000, guardMarginMs = 5_000 } = {}) {
  return new BoxExecutionLeaseManager({
    deployment: "d",
    instance: "i",
    owner: "d:i:p1:b1:exec-1:uuid",
    broker: () => "zerodha",
    account: () => "AB1234",
    persistenceAvailable: () => true,
    liveCapable: () => liveCapable,
    guardMarginMs,
    now,
    log: () => {},
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
}

/** Install a state without touching the database. Mirrors what `refresh()` would adopt. */
function withState(m, state) {
  // eslint-disable-next-line no-underscore-dangle
  m.state = state;
  return m;
}

function heldState({
  observedAtLocal,
  remainingAtObservationMs,
  reconciled = true,
  takeoverReason = "expired",
}) {
  return {
    kind: "held",
    lease: {
      scope: "d|zerodha|AB1234",
      owner: "d:i:p1:b1:exec-1:uuid",
      fence: 7,
      account: "AB1234",
      broker: "zerodha",
      remainingAtObservationMs,
      observedAtLocal,
      reconciled,
      takeoverReason,
    },
  };
}

/* ─────────────────────────── paper needs no lease ─────────────────────────── */

test("a deployment that cannot place live orders is never blocked by ownership", () => {
  const m = manager({ liveCapable: false });
  withState(m, { kind: "refused", detail: "someone else holds it", holder: "other" });
  assert.equal(m.dispatchBlockReason("new_entry"), null);
  assert.equal(m.dispatchBlockReason("exposure_reduction"), null);
});

/* ───────────────────────── a fresh held lease permits ───────────────────────── */

test("a held, reconciled, fresh lease permits both entry and reduction", () => {
  const m = manager({ now: () => 1_000_000 });
  withState(m, heldState({ observedAtLocal: 1_000_000, remainingAtObservationMs: 30_000 }));
  assert.equal(m.dispatchBlockReason("new_entry"), null);
  assert.equal(m.dispatchBlockReason("exposure_reduction"), null);
});

/* ───────────── an unreconciled takeover withholds entry, permits reduction ───────────── */

test("an unreconciled takeover refuses new entry but keeps reduction available", () => {
  const m = manager({ now: () => 1_000_000 });
  withState(
    m,
    heldState({ observedAtLocal: 1_000_000, remainingAtObservationMs: 30_000, reconciled: false }),
  );
  const entry = m.dispatchBlockReason("new_entry");
  assert.equal(typeof entry, "string");
  assert.match(entry, /TAKEN OVER/);
  assert.match(entry, /new entry is refused/);
  assert.match(
    entry,
    /reduction, protective cancellation and reconciliation remain available/i,
    "the refusal must say what IS still available, so nobody reads it as a full stop",
  );
  assert.equal(
    m.dispatchBlockReason("exposure_reduction"),
    null,
    "a takeover must be able to clean up after its predecessor",
  );
});

test("a FRESH unreconciled acquisition refuses entry too, but does not claim a takeover happened", () => {
  const m = manager({ now: () => 1_000_000 });
  withState(
    m,
    heldState({
      observedAtLocal: 1_000_000,
      remainingAtObservationMs: 30_000,
      reconciled: false,
      takeoverReason: "fresh",
    }),
  );
  const entry = m.dispatchBlockReason("new_entry");
  assert.equal(typeof entry, "string");
  assert.match(
    entry,
    /just established/,
    "a fresh acquisition must still reconcile broker state before entry — a clean handover leaves " +
      "open positions and working orders behind just as a crash does",
  );
  assert.doesNotMatch(
    entry,
    /TAKEN OVER|previous instance/,
    "it must NOT claim a takeover happened, or an operator goes looking for a second process that " +
      "never existed",
  );
  assert.equal(m.dispatchBlockReason("exposure_reduction"), null);
});

/* ───────── a stale observation is PROVEN-UNPROVABLE and blocks both ───────── */

test("an observation older than the provable life blocks both directions", () => {
  let clock = 1_000_000;
  const m = manager({ now: () => clock, guardMarginMs: 5_000 });
  withState(m, heldState({ observedAtLocal: 1_000_000, remainingAtObservationMs: 30_000 }));

  // 24s later: 6s of provable life remains, above the 5s margin. Still usable.
  clock = 1_024_000;
  assert.equal(m.dispatchBlockReason("new_entry"), null);

  // 26s later: 4s remains, under the margin. Both directions must stop, because a successor may
  // already have taken the lease.
  clock = 1_026_000;
  const entry = m.dispatchBlockReason("new_entry");
  const reduce = m.dispatchBlockReason("exposure_reduction");
  assert.equal(typeof entry, "string");
  assert.equal(typeof reduce, "string");
  assert.match(entry, /cannot prove it still owns execution/);
  assert.match(reduce, /cannot prove it still owns execution/);
  assert.match(reduce, /two instances acting on one account/);
});

test("the guard margin is honoured exactly at the boundary", () => {
  let clock = 1_000_000;
  const m = manager({ now: () => clock, guardMarginMs: 5_000 });
  withState(m, heldState({ observedAtLocal: 1_000_000, remainingAtObservationMs: 30_000 }));
  // Exactly at the margin: refused. `remaining <= margin` is deliberate — equality is not proof.
  clock = 1_025_000;
  assert.equal(typeof m.dispatchBlockReason("new_entry"), "string");
  clock = 1_024_999;
  assert.equal(m.dispatchBlockReason("new_entry"), null);
});

/* ───────────── proven foreign ownership blocks BOTH directions ───────────── */

test("a lease held by another live instance blocks reduction as well as entry", () => {
  const m = manager();
  withState(m, {
    kind: "refused",
    detail: "the execution lease for zerodha account AB1234 is held by another live instance (other).",
    holder: "other",
  });
  const entry = m.dispatchBlockReason("new_entry");
  const reduce = m.dispatchBlockReason("exposure_reduction");
  assert.match(entry, /held by another instance/);
  assert.match(
    reduce,
    /including a reduction, which would race the owner/,
    "reducing while another instance owns the account would double-close; it must be refused and say why",
  );
});

test("a lost lease blocks reduction as well as entry", () => {
  const m = manager();
  withState(m, { kind: "lost", detail: "it lapsed and may have been taken over" });
  assert.match(m.dispatchBlockReason("new_entry"), /no longer owns execution/);
  assert.match(
    m.dispatchBlockReason("exposure_reduction"),
    /race whoever took over/,
    "an old owner must not race its successor on cancellation or flatten",
  );
});

/* ───────── cannot-tell refuses entry only, and says so explicitly ───────── */

test("an unavailable lease store refuses new entry but not reduction", () => {
  const m = manager();
  withState(m, {
    kind: "unavailable",
    detail: "box_execution_leases is missing — run migrations.",
  });
  const entry = m.dispatchBlockReason("new_entry");
  assert.match(entry, /NEW ENTRY is refused/);
  assert.match(entry, /remain\s+available/i);
  assert.equal(
    m.dispatchBlockReason("exposure_reduction"),
    null,
    "a missing lease table is not evidence of a second instance, and must not strand exposure",
  );
});

test("an unproven account refuses new entry but not reduction", () => {
  const m = manager();
  withState(m, {
    kind: "inactive",
    detail: "the live broker account is not proven yet, so there is nothing to lease.",
  });
  const entry = m.dispatchBlockReason("new_entry");
  assert.match(entry, /NEW ENTRY is/);
  assert.equal(
    m.dispatchBlockReason("exposure_reduction"),
    null,
    "an unnameable account is 'cannot tell', not proof, and a refused exit strands exposure",
  );
});

/* ───────────────────────── purpose mapping ───────────────────────── */

test("only ENTRY is treated as new exposure", () => {
  assert.equal(leaseUseForPurpose("ENTRY"), "new_entry");
  assert.equal(leaseUseForPurpose("EXIT"), "exposure_reduction");
  assert.equal(leaseUseForPurpose("PROTECTIVE_CANCEL"), "exposure_reduction");
  assert.equal(leaseUseForPurpose("EMERGENCY_RESIDUAL"), "exposure_reduction");
});

/* ───────────────────────── the status projection is honest ───────────────────────── */

test("the status projection reports may_enter and may_reduce separately", () => {
  const m = manager({ now: () => 1_000_000 });
  withState(
    m,
    heldState({ observedAtLocal: 1_000_000, remainingAtObservationMs: 30_000, reconciled: false }),
  );
  const status = executionLeaseStatus({
    state: m.snapshot(),
    liveCapable: true,
    entryBlockReason: m.dispatchBlockReason("new_entry"),
    reductionBlockReason: m.dispatchBlockReason("exposure_reduction"),
  });
  assert.equal(status.required, true);
  assert.equal(status.state, "held");
  assert.equal(status.owner, "d:i:p1:b1:exec-1:uuid");
  assert.equal(status.fence, 7);
  assert.equal(status.account, "AB1234");
  assert.equal(status.reconciled, false);
  assert.equal(status.may_enter, false, "an unreconciled takeover may not enter");
  assert.equal(status.may_reduce, true, "an unreconciled takeover may still reduce");
  assert.match(status.detail, /takeover not yet reconciled/);
});

test("a paper deployment reports that no lease is required", () => {
  const m = manager({ liveCapable: false });
  const status = executionLeaseStatus({
    state: m.snapshot(),
    liveCapable: false,
    entryBlockReason: m.dispatchBlockReason("new_entry"),
    reductionBlockReason: m.dispatchBlockReason("exposure_reduction"),
  });
  assert.equal(status.required, false);
  assert.equal(status.may_enter, true);
  assert.equal(status.may_reduce, true);
  assert.equal(status.owner, null);
  assert.equal(status.fence, null);
});
