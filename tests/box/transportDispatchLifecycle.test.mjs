/**
 * AUDIT REGRESSIONS — TRANSPORT DISPATCH LIFECYCLE (audit findings 3 and 4).
 *
 * Every assertion in this file describes DESIRED behaviour and FAILS on the audited baseline
 * (978b813). The baseline's `TransportPacer` was a single FIFO promise chain whose links resolved
 * only when the previous operation's HTTP call SETTLED, which produced two distinct defects:
 *
 *   FINDING 3 — a slow read blocked placements and protective cancels. The queue had no priority and
 *   no concurrency: a parked 5-second positions read held every later request, including a cancel,
 *   for the whole 5 seconds — even though the broker would have accepted another request 110ms in.
 *   The manager's own priority order was discarded at the adapter boundary.
 *
 *   FINDING 4 — a timed-out cancellation could still be transmitted later. The deadline was a
 *   `Promise.race` against a bare `setTimeout`; losing the race rejected the CALLER but left the
 *   queued closure in place, so the DELETE went out once the blocking read returned. The reported
 *   lifecycle and actual broker activity disagreed, and a timeout could be misread as "nothing was
 *   sent".
 *
 * The distinction these tests defend is three-valued, not two: ACKNOWLEDGED, PROVEN-NOT-TRANSMITTED,
 * and AMBIGUOUS. Collapsing the middle case into either neighbour is what made the defect dangerous.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TRANSPORT_CONCURRENCY,
  resolveBrokerPacing,
  TransportPacer,
  TransportRequestAbandonedError,
} from "../../dist/box/brokerPacing.js";
import { Deadline } from "../../dist/brokers/deadline.js";

/**
 * A virtual clock whose `wait` advances time, plus `deferred()` for operations that never settle
 * on their own. No real timers: the whole point is to hold an operation open indefinitely and prove
 * the queue still advances.
 */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks run. The pacer's scheduler is async but uses no real timers here. */
async function settle(times = 12) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function pacerFor(clock, limits) {
  return new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock, limits ?? {});
}

/* ───────────────────────────── FINDING 3: a slow read must not block a cancel ───────────────────── */

test("A1: a parked read does NOT block a later protective cancel", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock);
  const parked = deferred();
  const order = [];

  // A read that never returns — the audit's "parked read".
  const readPromise = pacer.run(
    async () => {
      order.push("read-dispatched");
      return parked.promise;
    },
    "general",
    { urgency: "read" },
  );
  await settle();

  // A cancel queued strictly AFTER it.
  const cancelPromise = pacer.run(
    async () => {
      order.push("cancel-dispatched");
      return "cancelled";
    },
    "order_mutation",
    { urgency: "recovery" },
  );
  await settle();

  // ON THE BASELINE the cancel could not dispatch until `parked` resolved, so this was never
  // reached. Dispatch spacing is a property of TIME, not of how long a response takes.
  assert.equal(await cancelPromise, "cancelled", "the cancel must complete while the read is still open");
  assert.ok(
    order.indexOf("cancel-dispatched") > -1,
    "the cancel must have reached the transport",
  );

  parked.resolve("late read");
  assert.equal(await readPromise, "late read", "the read still settles normally afterwards");
});

test("A2: a risk-reducing cancel is dispatched AHEAD of reads that were queued first", async () => {
  const clock = fakeClock();
  // One slot at a time, so ordering is the only thing that can decide who goes first.
  const pacer = pacerFor(clock, { maxInFlight: 1, reservedForRecovery: 0, maxConcurrentReads: 1 });
  const dispatched = [];

  // Occupy the transport so everything else must queue behind a busy slot.
  const blocking = deferred();
  const first = pacer.run(
    async () => {
      dispatched.push("read-0");
      return blocking.promise;
    },
    "general",
    { urgency: "read" },
  );
  await settle();

  // Two reads queued BEFORE the cancel.
  const reads = [
    pacer.run(async () => { dispatched.push("read-1"); return 1; }, "general", { urgency: "read" }),
    pacer.run(async () => { dispatched.push("read-2"); return 2; }, "general", { urgency: "read" }),
  ];
  const cancel = pacer.run(
    async () => { dispatched.push("cancel"); return "c"; },
    "order_mutation",
    { urgency: "recovery" },
  );
  await settle();

  blocking.resolve("done");
  await first;
  await Promise.all([...reads, cancel]);

  // The manager has always had a priority order; the baseline THREW IT AWAY below the adapter, so
  // arrival order alone decided and the cancel went last.
  const cancelAt = dispatched.indexOf("cancel");
  assert.ok(cancelAt > -1, "the cancel was dispatched");
  assert.ok(
    cancelAt < dispatched.indexOf("read-1") && cancelAt < dispatched.indexOf("read-2"),
    `the cancel must overtake the older reads, got ${dispatched.join(",")}`,
  );
});

test("A3: reserved capacity keeps a cancel dispatchable when reads saturate the transport", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock, { maxInFlight: 2, reservedForRecovery: 1, maxConcurrentReads: 2 });
  const held = [deferred(), deferred()];
  let readsDispatched = 0;
  let cancelDispatched = false;

  const reads = held.map((gate) =>
    pacer.run(
      async () => {
        readsDispatched += 1;
        return gate.promise;
      },
      "general",
      { urgency: "read" },
    ),
  );
  await settle();
  // Only ONE read may occupy the transport: the other slot is reserved for recovery.
  assert.equal(readsDispatched, 1, "reads must not consume the recovery reserve");

  const cancel = pacer.run(
    async () => {
      cancelDispatched = true;
      return "c";
    },
    "order_mutation",
    { urgency: "recovery" },
  );
  await settle();
  assert.ok(cancelDispatched, "the reserved slot must admit the cancel immediately");
  assert.equal(await cancel, "c");

  held.forEach((gate) => gate.resolve("ok"));
  await Promise.all(reads);
});

test("A4: dispatch spacing is still a REAL rate-limit wait, and total rate is still bounded", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock);
  const at = [];

  await Promise.all([
    pacer.run(async () => { at.push(clock.now()); }, "order_mutation", { urgency: "placement" }),
    pacer.run(async () => { at.push(clock.now()); }, "order_mutation", { urgency: "placement" }),
    pacer.run(async () => { at.push(clock.now()); }, "order_mutation", { urgency: "placement" }),
    pacer.run(async () => { at.push(clock.now()); }, "order_mutation", { urgency: "placement" }),
  ]);

  // Unchanged from the baseline, and deliberately so: concurrency must not raise the rate the broker
  // sees. Zerodha publishes 10 order req/sec; 110ms keeps 10% headroom.
  assert.deepEqual(at, [0, 110, 220, 330], "four placements still pay the published 110ms gap");
  const stats = pacer.stats();
  assert.equal(stats.orderMutationWaitMs, 330, "the burst still pays a real rate-limit wait");
  assert.ok(stats.maxObservedInFlight >= 1);
});

test("A5: concurrency is BOUNDED — it is not an unlimited fan-out", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock, { maxInFlight: 2, reservedForRecovery: 0, maxConcurrentReads: 2 });
  const gates = [deferred(), deferred(), deferred(), deferred()];
  let inFlight = 0;
  let peak = 0;

  const all = gates.map((gate) =>
    pacer.run(
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate.promise;
        inFlight -= 1;
      },
      "general",
      { urgency: "read" },
    ),
  );
  await settle();
  assert.ok(peak <= 2, `never more than the configured bound in flight, saw ${peak}`);

  gates.forEach((gate) => gate.resolve());
  await Promise.all(all);
  assert.ok(pacer.stats().maxObservedInFlight <= 2);
});

test("A6: reads remain serialised with EACH OTHER, so two status polls cannot overlap", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock);
  const gate = deferred();
  let concurrentReads = 0;
  let peak = 0;

  const reads = [gate.promise, Promise.resolve()].map((wait) =>
    pacer.run(
      async () => {
        concurrentReads += 1;
        peak = Math.max(peak, concurrentReads);
        await wait;
        concurrentReads -= 1;
      },
      "general",
      { urgency: "read" },
    ),
  );
  await settle();
  // Deliberate: nothing is gained by overlapping two polls of the same order, and keeping them
  // one-at-a-time preserves the REST/stream lost-update ordering the merge tests pin.
  assert.equal(peak, 1, "reads do not overlap each other by default");
  gate.resolve();
  await Promise.all(reads);
});

/* ─────────────────── FINDING 4: an expired, unsent request must NEVER be transmitted ────────────── */

test("B1: a cancel whose deadline expires while QUEUED is never transmitted", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock, { maxInFlight: 1, reservedForRecovery: 0, maxConcurrentReads: 1 });
  const parked = deferred();
  let cancelSent = false;

  const read = pacer.run(async () => parked.promise, "general", { urgency: "read" });
  await settle();

  // A deadline anchored to the SAME virtual clock the pacer uses.
  const deadline = Deadline.at(clock.now() + 5, 5, () => clock.now());
  const cancel = pacer.run(
    async () => {
      cancelSent = true;
      return "sent";
    },
    "order_mutation",
    { urgency: "recovery", deadline },
  );

  // The deadline passes while the cancel is still waiting for a slot.
  clock.advance(50);
  await settle();

  // THE HEADLINE ASSERTION. Releasing the blocking read is the exact moment the baseline transmitted
  // the DELETE — after the caller had already been told the cancellation timed out. The expiry must
  // be noticed at the dispatch boundary instead, so the request is refused rather than sent late.
  //
  // (Promptly RELEASING the caller is the adapter's job, not the pacer's: it races its own real-timer
  // deadline and then calls `abandon()`, which is covered by B3. The pacer's guarantee — the one that
  // matters for what the broker sees — is that an expired entry is NEVER handed to the transport.)
  parked.resolve("read done");
  await read;

  await assert.rejects(
    cancel,
    (error) => {
      assert.ok(
        error instanceof TransportRequestAbandonedError,
        `expected TransportRequestAbandonedError, got ${error?.name}`,
      );
      assert.equal(error.transmitted, false, "the refusal must be a PROVEN no-request");
      return true;
    },
    "an expired queued cancel must be refused, not silently kept",
  );

  await settle();
  assert.equal(cancelSent, false, "an expired, unsent request must NEVER reach the transport later");
  assert.equal(pacer.stats().abandonedBeforeDispatch, 1);
});

test("B2: an already-expired deadline is refused at admission and never queued", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock);
  let sent = false;
  const expired = Deadline.at(clock.now() - 1, 1, () => clock.now());

  await assert.rejects(
    pacer.run(async () => { sent = true; return 1; }, "order_mutation", {
      urgency: "recovery",
      deadline: expired,
    }),
    TransportRequestAbandonedError,
  );
  await settle();
  assert.equal(sent, false, "an operation past its budget must not be sent at all");
  assert.equal(pacer.queueDepth(), 0, "and must not hold a queue slot ahead of viable work");
});

test("B3: abandon() distinguishes QUEUED (proven unsent) from DISPATCHED (ambiguous)", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock, { maxInFlight: 1, reservedForRecovery: 0, maxConcurrentReads: 1 });
  const parked = deferred();

  const inFlight = pacer.submit(async () => parked.promise, "general", { urgency: "read" });
  await settle();
  assert.equal(inFlight.dispatched(), true, "the first operation is on the wire");
  assert.equal(
    inFlight.abandon("caller gave up"),
    false,
    "a DISPATCHED request cannot be claimed as un-sent — its outcome belongs to the broker",
  );

  const queued = pacer.submit(async () => "never", "order_mutation", { urgency: "recovery" });
  assert.equal(queued.dispatched(), false);
  assert.equal(
    queued.abandon("caller gave up"),
    true,
    "a still-QUEUED request can be withdrawn, and that is proof nothing was transmitted",
  );
  await assert.rejects(queued.result, TransportRequestAbandonedError);

  parked.resolve("x");
  await inFlight.result;
});

test("B4: an abandoned operation charges NO rate budget and stamps NO pacing watermark", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock, { maxInFlight: 1, reservedForRecovery: 0, maxConcurrentReads: 1 });
  const parked = deferred();
  let charged = 0;

  const read = pacer.run(async () => parked.promise, "general", { urgency: "read" });
  await settle();

  const queued = pacer.submit(async () => "never", "order_mutation", {
    urgency: "recovery",
    // Charged at DISPATCH. The baseline charged synchronously at enqueue, so spend was recorded for
    // requests the broker never saw and our budget drifted permanently above reality.
    beforeDispatch: () => { charged += 1; },
  });
  assert.equal(queued.abandon("withdrawn"), true);
  await assert.rejects(queued.result, TransportRequestAbandonedError);

  assert.equal(charged, 0, "a withdrawn operation must not consume broker budget");
  const before = pacer.stats().orderMutations;
  assert.equal(before, 0, "and must not count as an order mutation the broker observed");

  parked.resolve("x");
  await read;
});

test("B5: a dispatch-time admission refusal is a proven no-request", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock);
  let sent = false;

  await assert.rejects(
    pacer.run(async () => { sent = true; return 1; }, "order_mutation", {
      urgency: "recovery",
      beforeDispatch: () => {
        throw new Error("recovery budget unavailable");
      },
    }),
    /recovery budget unavailable/,
  );
  await settle();
  assert.equal(sent, false, "a refused admission must not reach the transport");
  assert.equal(pacer.stats().refusedAtDispatch, 1);
  assert.equal(pacer.stats().orderMutations, 0, "and must not be counted as a broker call");
});

/* ───────────────────────────── invariants the fix must NOT break ────────────────────────────────── */

test("C1: a failed operation does not break the queue, and the next mutation still pays its gap", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock);
  await assert.rejects(
    pacer.run(async () => { throw new Error("broker 500"); }, "order_mutation", { urgency: "placement" }),
    /broker 500/,
  );
  let secondAt = -1;
  await pacer.run(async () => { secondAt = clock.now(); }, "order_mutation", { urgency: "placement" });
  assert.equal(secondAt, 110, "the failed call still consumed its rate slot");
});

test("C2: an operation that throws SYNCHRONOUSLY still releases its slot", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock, { maxInFlight: 1, reservedForRecovery: 0, maxConcurrentReads: 1 });
  await assert.rejects(
    pacer.run(() => { throw new Error("sync boom"); }, "general", { urgency: "read" }),
    /sync boom/,
  );
  // If the slot leaked, this would hang rather than resolve.
  assert.equal(await pacer.run(async () => "ok", "general", { urgency: "read" }), "ok");
});

test("C3: an unclassified call still defaults to the SLOWER bucket and the yielding tier", async () => {
  const clock = fakeClock();
  const pacer = pacerFor(clock);
  await pacer.run(async () => undefined);
  let secondAt = -1;
  await pacer.run(async () => { secondAt = clock.now(); });
  assert.equal(secondAt, 250, "defaulting must never silently grant the order-mutation rate");
});

test("C4: the reserve can never be configured so large that ordinary work starves", async () => {
  const clock = fakeClock();
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock, {
    maxInFlight: 2,
    reservedForRecovery: 99,
  });
  assert.ok(
    pacer.concurrencyLimits().reservedForRecovery < pacer.concurrencyLimits().maxInFlight,
    "at least one slot must always be usable by a non-recovery operation",
  );
  assert.equal(await pacer.run(async () => "ok", "general", { urgency: "read" }), "ok");
});

test("C5: the shipped defaults are conservative and documented", () => {
  assert.ok(Object.isFrozen(DEFAULT_TRANSPORT_CONCURRENCY));
  assert.equal(DEFAULT_TRANSPORT_CONCURRENCY.maxConcurrentReads, 1, "reads stay serialised by default");
  assert.ok(
    DEFAULT_TRANSPORT_CONCURRENCY.reservedForRecovery >= 1,
    "capacity to shed risk is always withheld",
  );
  assert.ok(
    DEFAULT_TRANSPORT_CONCURRENCY.maxInFlight > DEFAULT_TRANSPORT_CONCURRENCY.reservedForRecovery,
  );
});
