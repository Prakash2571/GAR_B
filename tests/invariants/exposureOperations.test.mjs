/**
 * A RETRIED REDUCTION MUST NOT BECOME A SECOND REDUCTION.
 *
 * THE HAZARD THIS CLOSES
 *
 * A browser that gives up on a request does NOT cancel the server operation: `AbortController` closes
 * the client's end of the socket and the handler keeps running. So bounding the client's wait — which
 * the frontend now does, because an unbounded one left the panic button permanently dead — creates a new
 * risk: the operator sees a timeout, presses again, and a SECOND cancellation or flatten begins while
 * the first is still working. Two flattens over one position can double-close it.
 *
 * The tempting client-side fix (release the lock, allow the second click) makes this strictly worse on
 * its own. The lock must be released AND the server must refuse to do the work twice.
 *
 * WHAT IS ASSERTED
 *
 *   1. A second concurrent caller does NOT invoke the work again, and receives the FIRST operation's
 *      real result tagged `deduplicated: true` with the shared `operation_id`.
 *   2. Kinds are independent — a wedged `cancel_working` does not block `flatten`. That coupling is the
 *      frontend defect's server-side mirror and must not be reintroduced here.
 *   3. A rejection reaches every joiner. Telling a joiner "fine" because it personally did nothing would
 *      be the same class of misreporting as the hardcoded `ok: true`.
 *   4. The slot is released on success AND on failure, so one fault cannot wedge the button forever.
 *   5. A late-completing operation does not delete a successor's slot.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { ExposureOperationRegistry } = await import("../../dist/box/exposureOperations.js");

const deferred = () => {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/* ═════════════ 1. a second caller joins rather than duplicating ═════════════ */

test("a second concurrent caller joins the running operation and does not invoke the work twice", async () => {
  const registry = new ExposureOperationRegistry();
  const gate = deferred();
  let invocations = 0;

  const work = async () => {
    invocations += 1;
    await gate.promise;
    return { cancelled: ["BOX:a", "BOX:b"], ok: true };
  };

  const first = registry.run("cancel_working", work);
  // The slot must be claimed before any await inside `work` can yield, so the second caller sees it.
  const second = registry.run("cancel_working", work);

  assert.equal(registry.isRunning("cancel_working"), true);
  const described = registry.describe("cancel_working");
  assert.equal(typeof described.operation_id, "string");
  assert.match(described.operation_id, /^cancel_working:/, "the id must name its kind");

  gate.resolve();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(invocations, 1, "THE INVARIANT: the work must run exactly once, not once per caller");
  assert.equal(a.deduplicated, false, "the caller that started it is not a duplicate");
  assert.equal(b.deduplicated, true, "the caller that joined must be told it joined");
  assert.equal(a.operation_id, b.operation_id, "both callers must see the SAME operation identity");
  assert.deepEqual(
    b.result, a.result,
    "the joiner must receive the real result, not a fabricated refusal — the exposure outcome is the " +
      "one thing the operator needs",
  );
  assert.equal(registry.isRunning("cancel_working"), false, "the slot must be released when it settles");
  assert.equal(registry.describe("cancel_working"), null);
});

test("three simultaneous callers produce one invocation and one identity", async () => {
  const registry = new ExposureOperationRegistry();
  const gate = deferred();
  let invocations = 0;
  const work = async () => { invocations += 1; await gate.promise; return "done"; };

  const all = [registry.run("flatten", work), registry.run("flatten", work), registry.run("flatten", work)];
  gate.resolve();
  const results = await Promise.all(all);

  assert.equal(invocations, 1);
  assert.equal(new Set(results.map((r) => r.operation_id)).size, 1);
  assert.equal(results.filter((r) => r.deduplicated).length, 2);
  assert.equal(results.filter((r) => !r.deduplicated).length, 1);
});

/* ═════════════ 2. a sequential retry after completion DOES run again ═════════════ */

test("a retry AFTER the first operation settled starts a new operation with a new identity", async () => {
  const registry = new ExposureOperationRegistry();
  let invocations = 0;
  const work = async () => { invocations += 1; return invocations; };

  const a = await registry.run("flatten", work);
  const b = await registry.run("flatten", work);

  assert.equal(invocations, 2, "dedup must not become a one-shot latch: a later retry is legitimate");
  assert.notEqual(a.operation_id, b.operation_id);
  assert.equal(b.deduplicated, false);
});

/* ═════════════ 3. kinds are independent ═════════════ */

test("a wedged cancel_working does NOT block flatten", async () => {
  const registry = new ExposureOperationRegistry();
  const wedged = deferred();
  let flattenRan = false;

  // Never resolves during this test: models a cancellation stalled at the broker.
  const stuck = registry.run("cancel_working", () => wedged.promise);
  assert.equal(registry.isRunning("cancel_working"), true);

  const flatten = await registry.run("flatten", async () => { flattenRan = true; return "flat"; });
  assert.equal(
    flattenRan, true,
    "THE EMERGENCY BRAKE MUST NOT BE HELD HOSTAGE by a stalled cancellation — that coupling is exactly " +
      "the defect being fixed on the client, and it must not be recreated on the server",
  );
  assert.equal(flatten.deduplicated, false);
  assert.equal(flatten.result, "flat");

  // Clean up so the test does not leak a pending promise.
  wedged.resolve("eventually");
  await stuck;
});

/* ═════════════ 4. failures reach joiners and release the slot ═════════════ */

test("a rejection propagates to the joiner as well as the starter", async () => {
  const registry = new ExposureOperationRegistry();
  const gate = deferred();
  let invocations = 0;
  const work = async () => { invocations += 1; await gate.promise; throw new Error("broker refused"); };

  const first = registry.run("flatten", work);
  const second = registry.run("flatten", work);
  gate.resolve();

  await assert.rejects(() => first, /broker refused/);
  await assert.rejects(
    () => second,
    /broker refused/,
    "a joiner must see the failure; reporting success because it personally did nothing would be the " +
      "same class of defect as a hardcoded ok:true",
  );
  assert.equal(invocations, 1);
  assert.equal(
    registry.isRunning("flatten"), false,
    "a failure must release the slot, or one fault disables the control for the life of the process",
  );
});

test("the slot is reusable immediately after a failure", async () => {
  const registry = new ExposureOperationRegistry();
  await assert.rejects(() => registry.run("flatten", async () => { throw new Error("x"); }), /x/);
  const ok = await registry.run("flatten", async () => "recovered");
  assert.equal(ok.result, "recovered");
  assert.equal(ok.deduplicated, false);
});

/* ═════════════ 5. a late finisher must not clear a successor's slot ═════════════ */

test("a late-completing operation does not release a slot a successor has taken", async () => {
  // Deterministic ids so the assertion is about identity, not timing.
  let seq = 0;
  const registry = new ExposureOperationRegistry({ newId: () => `id-${++seq}` });

  const firstGate = deferred();
  const first = registry.run("flatten", () => firstGate.promise);
  assert.equal(registry.describe("flatten").operation_id, "flatten:id-1");

  // Let the first finish and be cleared.
  firstGate.resolve("first");
  await first;
  assert.equal(registry.isRunning("flatten"), false);

  // A successor takes the slot.
  const secondGate = deferred();
  const second = registry.run("flatten", () => secondGate.promise);
  assert.equal(registry.describe("flatten").operation_id, "flatten:id-2");

  // The successor's slot must still be there — nothing from the first operation's completion may have
  // removed it. This is the same fence-pinning discipline the execution lease uses for release.
  assert.equal(registry.isRunning("flatten"), true);
  secondGate.resolve("second");
  assert.equal((await second).result, "second");
});

/* ═════════════ 6. the status projection ═════════════ */

test("the snapshot reports every running operation with its age", async () => {
  let clock = 1_000;
  const registry = new ExposureOperationRegistry({ now: () => clock, newId: () => "fixed" });
  const gateA = deferred();
  const gateB = deferred();
  const a = registry.run("cancel_working", () => gateA.promise);
  const b = registry.run("flatten", () => gateB.promise);

  clock = 3_500;
  const snap = registry.snapshot().sort((x, y) => x.kind.localeCompare(y.kind));
  assert.deepEqual(snap, [
    { kind: "cancel_working", operation_id: "cancel_working:fixed", age_ms: 2_500 },
    { kind: "flatten", operation_id: "flatten:fixed", age_ms: 2_500 },
  ]);

  gateA.resolve(1); gateB.resolve(2);
  await Promise.all([a, b]);
  assert.deepEqual(registry.snapshot(), []);
});
