/**
 * SECOND-PASS AUDIT REGRESSIONS — defects found by reviewing the TransportPacer rewrite itself.
 *
 * The rewrite that fixed audit findings 3 and 4 introduced its own defects. Every assertion here
 * describes DESIRED behaviour and FAILS on 292e8a7 (the commit that shipped the rewrite).
 *
 * THE MOST SERIOUS ONE RE-OPENED FINDING 4. `drainQueue` picked an entry, awaited the pacing sleep,
 * and then dispatched WITHOUT re-checking the entry's state. The await is a real yield point and
 * `abandon()` is called from an independent timer, so a cancellation could be withdrawn during the
 * sleep — with `abandon()` returning true, i.e. telling the caller "PROVEN nothing was transmitted" —
 * and then be put on the wire anyway. Exactly the lie the finding exists to prevent, reintroduced by
 * its own fix.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveBrokerPacing,
  TransportPacer,
  TransportRequestAbandonedError,
} from "../../dist/box/brokerPacing.js";
import { Deadline } from "../../dist/brokers/deadline.js";

/** A clock whose `wait` does NOT advance time — an explicitly supported input the pacer must survive. */
function frozenClock(at = 0) {
  return { now: () => at, wait: async () => {}, set: (v) => { at = v; } };
}

function advancingClock() {
  let now = 0;
  return {
    now: () => now,
    wait: async (ms) => { now += ms; },
    advance: (ms) => { now += ms; },
  };
}

async function settle(times = 16) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const pacerFor = (clock, limits) =>
  new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock, limits ?? {});

/* ══════════ THE CRITICAL ONE: a withdrawn request must never be dispatched afterwards ══════════ */

test("S1: a cancel abandoned DURING the pacing sleep is never transmitted", async () => {
  // A frozen clock is what makes the window observable: the sleep resolves, time has not moved, and
  // the old code fell straight through to `dispatch()` without re-reading the entry's state.
  const clock = frozenClock(0);
  const pacer = pacerFor(clock);
  let sent = 0;

  // Occupy the order-mutation watermark so the next mutation owes a real pacing gap.
  await pacer.run(async () => { sent += 1; }, "order_mutation", { urgency: "recovery" });
  assert.equal(sent, 1);

  // This one must WAIT (110ms owed), which is when the caller withdraws it.
  const submission = pacer.submit(async () => { sent += 1; return "sent"; }, "order_mutation", {
    urgency: "recovery",
  });
  assert.equal(submission.dispatched(), false, "still queued: the pacing gap is owed");
  assert.equal(
    submission.abandon("caller deadline expired"),
    true,
    "a queued request can be withdrawn, and that is a PROOF nothing was transmitted",
  );

  await settle();
  // THE HEADLINE ASSERTION.
  assert.equal(sent, 1, "an abandoned request must NEVER reach the transport, even on a frozen clock");
  await assert.rejects(submission.result, TransportRequestAbandonedError);
  assert.equal(submission.dispatched(), false, "and it must never report itself as dispatched");
});

test("S2: dispatched() means 'reached the transport', not merely 'settled'", async () => {
  const clock = advancingClock();
  const pacer = pacerFor(clock);

  // Pre-admission expiry: settled, but nothing was sent.
  const expired = Deadline.at(clock.now() - 1, 1, () => clock.now());
  const preAdmission = pacer.submit(async () => "x", "order_mutation", {
    urgency: "recovery",
    deadline: expired,
  });
  await assert.rejects(preAdmission.result, TransportRequestAbandonedError);
  assert.equal(
    preAdmission.dispatched(),
    false,
    "a request refused at admission was never handed to the transport",
  );

  // A dispatch-time budget refusal: also settled, also never sent.
  const refused = pacer.submit(async () => "x", "order_mutation", {
    urgency: "recovery",
    beforeDispatch: () => { throw new Error("recovery budget unavailable"); },
  });
  await assert.rejects(refused.result, /recovery budget unavailable/);
  assert.equal(refused.dispatched(), false, "a budget refusal is a proven no-request");

  // A genuine dispatch does report true.
  const real = pacer.submit(async () => "ok", "general", { urgency: "read" });
  assert.equal(await real.result, "ok");
  assert.equal(real.dispatched(), true);
});

/* ═════════════════════════ liveness and fault containment ═════════════════════════ */

test("S3: a throwing clock fails the queue instead of taking the process down", async () => {
  // `startScheduling` voids the drain promise, so an exception escaping the loop became an UNHANDLED
  // REJECTION — process exit on modern Node — and left every queued operation pending forever.
  const clock = {
    now: () => 0,
    wait: async () => { throw new Error("clock exploded"); },
  };
  const pacer = pacerFor(clock);
  let sent = 0;

  await pacer.run(async () => { sent += 1; }, "order_mutation", { urgency: "recovery" });
  // The next mutation owes a gap, so it must sleep — and the sleep throws.
  await assert.rejects(
    pacer.run(async () => { sent += 1; }, "order_mutation", { urgency: "recovery" }),
    (error) => {
      assert.ok(error instanceof TransportRequestAbandonedError, `got ${error?.name}`);
      assert.equal(error.transmitted, false, "a scheduler fault sent nothing");
      return true;
    },
    "a queued operation must be FAILED, not left pending forever",
  );
  assert.equal(sent, 1, "nothing was transmitted by the faulting pass");
  assert.equal(pacer.stats().schedulerFaults, 1, "and the fault is reported, not swallowed");
  assert.match(pacer.stats().lastSchedulerFault ?? "", /clock exploded/);
});

test("S4: a frozen clock does not let the pacer spin, and still dispatches", async () => {
  const clock = frozenClock(0);
  const pacer = pacerFor(clock);
  const at = [];
  // Four mutations on a clock that never moves: pacing is inexpressible, so the previous behaviour
  // (dispatch rather than spin) must be preserved — but without the state-check hole S1 covers.
  await Promise.all([
    pacer.run(async () => { at.push(1); }, "order_mutation", { urgency: "placement" }),
    pacer.run(async () => { at.push(2); }, "order_mutation", { urgency: "placement" }),
    pacer.run(async () => { at.push(3); }, "order_mutation", { urgency: "placement" }),
  ]);
  assert.equal(at.length, 3, "all three dispatch rather than deadlocking");
});

/* ═════════════════════════ head-of-line fairness ═════════════════════════ */

test("S5: a cancel arriving DURING a poll's pacing sleep is not held for the full interval", async () => {
  // Only one drain loop exists and its sleep is not interruptible, so a single long sleep was a
  // head-of-line block: a poll owing the 250ms general interval held a cancel that becomes
  // dispatchable at the 110ms absolute floor. Nothing can dispatch closer than that floor, so
  // re-evaluating on it costs nothing.
  const clock = advancingClock();
  const pacer = pacerFor(clock);
  let cancelAt = -1;

  await pacer.run(async () => undefined, "general", { urgency: "read" }); // t=0
  // Owes 250ms (general interval). Starts sleeping.
  const poll = pacer.run(async () => undefined, "general", { urgency: "read" });
  await settle(2);
  // Arrives while that sleep is in progress.
  const cancel = pacer.run(
    async () => { cancelAt = clock.now(); },
    "order_mutation",
    { urgency: "recovery" },
  );

  await Promise.all([poll, cancel]);
  assert.ok(cancelAt >= 0, "the cancel was dispatched");
  assert.ok(
    cancelAt <= 110,
    `the cancel must go at the absolute floor, not behind the poll's 250ms interval (went at ${cancelAt})`,
  );
});

/* ═════════════════════════ honest accounting ═════════════════════════ */

test("S6: pacing statistics only count time that was actually served", async () => {
  // Charging the REQUESTED slice let a clock advancing less than asked inflate the figures without
  // the broker ever being given the gap the figures claimed.
  const clock = frozenClock(0);
  const pacer = pacerFor(clock);
  await pacer.run(async () => undefined, "order_mutation", { urgency: "placement" });
  await pacer.run(async () => undefined, "order_mutation", { urgency: "placement" });
  const stats = pacer.stats();
  assert.equal(
    stats.totalWaitMs,
    0,
    "a frozen clock served no wait, so none may be reported as served",
  );
  assert.equal(stats.orderMutationWaitMs, 0);
});

test("S7: an abandon-then-expire sequence counts ONE withheld request, not two", async () => {
  const clock = advancingClock();
  const pacer = pacerFor(clock, { maxInFlight: 1, reservedForRecovery: 0, maxConcurrentReads: 1 });
  let release;
  const parked = new Promise((r) => { release = r; });
  const read = pacer.run(async () => parked, "general", { urgency: "read" });
  await settle();

  const deadline = Deadline.at(clock.now() + 5, 5, () => clock.now());
  const cancel = pacer.submit(async () => "x", "order_mutation", { urgency: "recovery", deadline });
  assert.equal(cancel.abandon("withdrawn"), true);
  clock.advance(50); // the deadline now ALSO passes
  release("done");
  await read;
  await assert.rejects(cancel.result, TransportRequestAbandonedError);
  assert.equal(
    pacer.stats().abandonedBeforeDispatch,
    1,
    "one operation was withheld, so the counter must read 1",
  );
});

test("S8: the read-only capacity check does not mutate the diagnostics", async () => {
  // `canDispatchSomething()` called `pickNext()` purely as a predicate, so a "read-only" check
  // incremented `priorityOvertakes` — and it runs on every drain completion.
  const clock = advancingClock();
  const pacer = pacerFor(clock);
  await pacer.run(async () => undefined, "general", { urgency: "read" });
  await pacer.run(async () => undefined, "general", { urgency: "read" });
  assert.equal(
    pacer.stats().priorityOvertakes,
    0,
    "no operation overtook another, so the counter must be 0",
  );
});

test("S9: priorityOvertakes counts DISPATCHES, and counts a real overtake exactly once", async () => {
  const clock = advancingClock();
  const pacer = pacerFor(clock, { maxInFlight: 1, reservedForRecovery: 0, maxConcurrentReads: 1 });
  let release;
  const parked = new Promise((r) => { release = r; });
  const blocking = pacer.run(async () => parked, "general", { urgency: "read" });
  await settle();

  const laterRead = pacer.run(async () => undefined, "general", { urgency: "read" });
  const cancel = pacer.run(async () => undefined, "order_mutation", { urgency: "recovery" });
  await settle();
  release("x");
  await Promise.all([blocking, laterRead, cancel]);

  assert.equal(
    pacer.stats().priorityOvertakes,
    1,
    "exactly one dispatch jumped an older queued entry",
  );
});

/* ═════════════════════════ fail-safe limits ═════════════════════════ */

test("S10: a NaN concurrency limit falls back to the default instead of removing the bound", async () => {
  // `??` only catches null/undefined, and `Math.max(1, Math.floor(NaN))` is NaN. A NaN bound is not a
  // large bound, it is NO bound: `inFlight >= NaN` is false and the reserve comparison is false, so
  // the cap AND the recovery reserve both silently vanished. `Number(process.env.X)` on a typo is
  // enough to produce it.
  const clock = advancingClock();
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock, {
    maxInFlight: Number.NaN,
    reservedForRecovery: Number.NaN,
    maxConcurrentReads: Number.NaN,
  });
  const limits = pacer.concurrencyLimits();
  assert.ok(Number.isFinite(limits.maxInFlight) && limits.maxInFlight >= 1, "the cap must be real");
  assert.ok(Number.isFinite(limits.reservedForRecovery), "the reserve must be real");
  assert.ok(Number.isFinite(limits.maxConcurrentReads) && limits.maxConcurrentReads >= 1);
  assert.ok(limits.reservedForRecovery < limits.maxInFlight);

  const gates = [];
  let peak = 0;
  let inFlight = 0;
  const all = [0, 1, 2, 3, 4, 5, 6, 7].map(() => {
    let release;
    gates.push(new Promise((r) => { release = r; }));
    const gate = gates[gates.length - 1];
    void release;
    return pacer.run(
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight -= 1;
      },
      "general",
      { urgency: "read" },
    );
  });
  await settle();
  assert.ok(peak <= limits.maxInFlight, `bounded fan-out, saw ${peak}`);
  void all;
});

test("S11: maxConcurrentReads can never exceed the total in-flight cap", () => {
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), advancingClock(), {
    maxInFlight: 2,
    maxConcurrentReads: 99,
  });
  assert.ok(pacer.concurrencyLimits().maxConcurrentReads <= pacer.concurrencyLimits().maxInFlight);
});

test("S12: a starved queued operation is visible by AGE, not just by depth", async () => {
  // Depth alone hides the case that matters: one starved entry behind a saturated tier reads as
  // depth 1, which looks healthy.
  const clock = advancingClock();
  const pacer = pacerFor(clock, { maxInFlight: 1, reservedForRecovery: 0, maxConcurrentReads: 1 });
  let release;
  const parked = new Promise((r) => { release = r; });
  const read = pacer.run(async () => parked, "general", { urgency: "read" });
  await settle();
  const queued = pacer.run(async () => undefined, "general", { urgency: "read" });
  clock.advance(4_000);
  assert.equal(pacer.queueDepth(), 1);
  assert.ok(
    pacer.stats().oldestQueuedAgeMs >= 4_000,
    `a 4s-old queued operation must be reported, got ${pacer.stats().oldestQueuedAgeMs}`,
  );
  release("x");
  await Promise.all([read, queued]);
});
