/**
 * A SLOW SSE CLIENT MUST NOT COST THIS PROCESS UNBOUNDED MEMORY.
 *
 * `res.write()` does not throw when a peer stops reading. It returns FALSE, having accepted the chunk
 * into an in-process buffer that has no limit, and it will keep accepting for as long as it is called.
 * The old fan-out called it inside a `try/catch` and discarded the result, so the `catch` never fired
 * and nothing bounded the growth: one authenticated client on a stalled connection — a suspended laptop,
 * a hung proxy, a debugger on a breakpoint — could drive this process towards an out-of-memory death.
 *
 * It matters here more than it would elsewhere because this is the same process that prices and
 * dispatches orders, and the execution path's own safety margins are stated in milliseconds.
 *
 * The policy being pinned (it follows `boundedQueue.ts`'s documented doctrine):
 *   · snapshots COALESCE while a client is backed up — a superseded whole-state frame is worthless;
 *   · discrete events do NOT coalesce — they are delivered, or the client is disconnected, never
 *     silently dropped;
 *   · the budget counts BOTH our queue and the socket's own buffer, since the socket is where the
 *     unbounded growth actually happened.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { BoundedSseWriter, DEFAULT_SSE_CLIENT_BUDGET_BYTES } = await import("../../dist/box/sseWriter.js");

/**
 * A fake response that models the one behaviour that matters: `write` returns false once it is "full",
 * and it buffers everything it was given until the test drains it.
 */
function sink({ acceptBytes = Infinity } = {}) {
  const state = {
    written: [],
    buffered: 0,
    destroyed: false,
    drainListeners: [],
    throwOnWrite: false,
  };
  return {
    state,
    get writableLength() {
      return state.buffered;
    },
    write(chunk) {
      if (state.throwOnWrite) throw new Error("EPIPE");
      state.written.push(chunk);
      state.buffered += chunk.length;
      // False means "I took it, but stop": exactly what a stalled socket does.
      return state.buffered < acceptBytes;
    },
    once(event, listener) {
      if (event === "drain") state.drainListeners.push(listener);
    },
    destroy() {
      state.destroyed = true;
    },
    /** Pretend the peer read everything, then fire `drain` as a real socket would. */
    drain() {
      state.buffered = 0;
      const listeners = state.drainListeners.splice(0);
      for (const listener of listeners) listener();
    },
  };
}

const snapshot = (n) => JSON.stringify({ status: { n }, filler: "x".repeat(200) });

test("a healthy client is written to directly", () => {
  const s = sink();
  const writer = new BoundedSseWriter({ sink: s });
  writer.send("snapshot", snapshot(1), { coalesceKey: "snapshot" });
  writer.send("entry", '{"id":"a"}');

  assert.equal(s.state.written.length, 2);
  assert.match(s.state.written[0], /^event: snapshot\ndata: /);
  assert.match(s.state.written[1], /\n\n$/, "every frame must be terminated by a blank line");
  assert.equal(writer.stats().queuedFrames, 0);
});

test("once the socket pushes back, writing STOPS instead of buffering forever", () => {
  const s = sink({ acceptBytes: 100 });
  const writer = new BoundedSseWriter({ sink: s });

  writer.send("snapshot", snapshot(1), { coalesceKey: "snapshot" });
  const afterFirst = s.state.written.length;
  assert.equal(afterFirst, 1, "the first frame goes out and the sink reports it is now full");

  for (let i = 2; i <= 50; i += 1) {
    writer.send("snapshot", snapshot(i), { coalesceKey: "snapshot" });
  }

  assert.equal(
    s.state.written.length,
    afterFirst,
    "THE DEFECT: writes continued into an unbounded buffer after the sink said stop",
  );
  assert.equal(
    writer.stats().queuedFrames,
    1,
    "49 superseded snapshots must collapse into the single newest one",
  );
  assert.ok(writer.stats().framesCoalesced >= 48);
  assert.equal(s.state.destroyed, false, "a merely slow client is not disconnected");
});

test("the newest snapshot is the one that survives coalescing", () => {
  const s = sink({ acceptBytes: 100 });
  const writer = new BoundedSseWriter({ sink: s });
  writer.send("snapshot", snapshot(1), { coalesceKey: "snapshot" });
  writer.send("snapshot", snapshot(2), { coalesceKey: "snapshot" });
  writer.send("snapshot", snapshot(3), { coalesceKey: "snapshot" });

  s.drain();

  const last = s.state.written[s.state.written.length - 1];
  assert.match(last, /"n":3/, "a client must never be left holding a stale snapshot");
  assert.ok(
    !s.state.written.some((frame) => /"n":2/.test(frame)),
    "the superseded snapshot must not be sent at all — it was going to be replaced anyway",
  );
});

test("DISCRETE events are never coalesced away", () => {
  const s = sink({ acceptBytes: 100 });
  const writer = new BoundedSseWriter({ sink: s });
  writer.send("snapshot", snapshot(1), { coalesceKey: "snapshot" });
  writer.send("entry", '{"id":"e1"}');
  writer.send("exit", '{"id":"x1"}');
  writer.send("execution_attempt", '{"id":"a1"}');

  assert.equal(writer.stats().queuedFrames, 3, "each distinct event keeps its place in the queue");

  s.drain();

  const body = s.state.written.join("");
  for (const id of ["e1", "x1", "a1"]) {
    assert.match(body, new RegExp(id), `event ${id} must be delivered, not dropped`);
  }
  // Order is preserved: an exit that arrives before its entry would be nonsense.
  assert.ok(body.indexOf("e1") < body.indexOf("x1"));
  assert.ok(body.indexOf("x1") < body.indexOf("a1"));
});

test("a client that stays over budget is DISCONNECTED, not carried", () => {
  const s = sink({ acceptBytes: 1 });
  const overflows = [];
  const writer = new BoundedSseWriter({
    sink: s,
    maxPendingBytes: 16 * 1024,
    onOverBudget: (info) => overflows.push(info),
  });

  // Discrete events cannot be coalesced, so a peer that never drains must eventually be cut off.
  for (let i = 0; i < 500; i += 1) writer.send("entry", JSON.stringify({ i, pad: "y".repeat(200) }));

  assert.equal(overflows.length, 1, "the overflow must be reported exactly once");
  assert.ok(overflows[0].pendingBytes > 16 * 1024);
  assert.equal(s.state.destroyed, true, "the connection is dropped so the memory is released");
  assert.equal(writer.isClosed(), true);

  const sent = s.state.written.length;
  writer.send("entry", '{"i":"after"}');
  assert.equal(s.state.written.length, sent, "a closed writer sends nothing further");
});

test("the budget counts what the SOCKET is holding, not only our own queue", () => {
  // This is the case the original defect actually hit: our queue was empty every time, because every
  // chunk had been handed straight to a socket that was not draining.
  const s = sink({ acceptBytes: 1 });
  let overflowed = false;
  const writer = new BoundedSseWriter({
    sink: s,
    maxPendingBytes: 16 * 1024,
    onOverBudget: () => {
      overflowed = true;
    },
  });
  writer.send("snapshot", "x".repeat(40_000), { coalesceKey: "snapshot" });
  assert.equal(overflowed, true, "one huge frame to a dead peer is already over budget");
  assert.equal(s.state.destroyed, true);
});

test("a drained client resumes normally", () => {
  const s = sink({ acceptBytes: 5_000 });
  const writer = new BoundedSseWriter({ sink: s });
  writer.send("snapshot", snapshot(1), { coalesceKey: "snapshot" });
  while (!writer.stats().blocked) writer.send("entry", '{"pad":"' + "z".repeat(500) + '"}');
  assert.ok(writer.stats().blocked);

  s.drain();

  assert.equal(writer.stats().blocked, false);
  assert.equal(writer.stats().queuedFrames, 0);
  const before = s.state.written.length;
  writer.send("entry", '{"id":"fresh"}');
  assert.equal(s.state.written.length, before + 1, "writing resumes directly after a drain");
});

test("a broken pipe closes the writer without throwing", () => {
  const s = sink();
  const writer = new BoundedSseWriter({ sink: s });
  s.state.throwOnWrite = true;
  assert.doesNotThrow(() => writer.send("snapshot", snapshot(1), { coalesceKey: "snapshot" }));
  assert.equal(writer.isClosed(), true);
});

test("the default per-client budget is a real bound", () => {
  assert.equal(typeof DEFAULT_SSE_CLIENT_BUDGET_BYTES, "number");
  assert.ok(DEFAULT_SSE_CLIENT_BUDGET_BYTES > 0);
  assert.ok(
    DEFAULT_SSE_CLIENT_BUDGET_BYTES <= 4 * 1024 * 1024,
    "a per-client budget large enough to matter defeats the purpose",
  );
});
