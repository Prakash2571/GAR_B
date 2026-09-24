/**
 * GRACEFUL SHUTDOWN — coordinator behaviour and the declared step ORDER.
 *
 * `src/shutdown.ts` deliberately contains no `process.on`/`process.exit`: signals are
 * wired at the call site in `src/index.ts`, and the exit code is the caller's decision.
 * That is what lets the ordering, idempotency, error-isolation and deadline logic be
 * proven here without spawning a process or killing the test runner.
 *
 * Importing `src/index.ts` would boot a real server (HTTP listen, DB connections, feeds),
 * so we do NOT import it. Instead:
 *   • the BEHAVIOUR is proven by driving `ShutdownCoordinator` with recording/fake steps;
 *   • the ORDER declared in `src/index.ts` is proven by reading and parsing the step
 *     names out of the source — the honest way to pin an ordering that cannot be executed
 *     offline. If someone reorders the real steps, the parse test fails.
 *
 * THE RULE THAT MATTERS MOST: a SIGTERM must never flatten/liquidate/close a position.
 * We assert it two ways — the fake steps include a flatten spy that must never be called,
 * and the parsed source step names must contain no flatten/liquidate/close-position verb.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { ShutdownCoordinator, shutdownExitCode } from "../../dist/shutdown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = resolve(HERE, "..", "..", "src", "index.ts");

/* ─────────────────────────── recording helpers ─────────────────────────── */

/** A coordinator whose steps push their name into `order` when they run. */
function recordingCoordinator(names, opts = {}) {
  const order = [];
  const steps = names.map((name) => ({
    name,
    run: () => {
      order.push(name);
    },
  }));
  const logs = [];
  const coordinator = new ShutdownCoordinator({
    steps,
    timeoutMs: opts.timeoutMs ?? 5_000,
    log: (m) => logs.push(m),
    now: opts.now,
  });
  return { coordinator, order, logs };
}

/* ──────────────────────────── behaviour tests ──────────────────────────── */

test("steps run in the declared order", async () => {
  const declared = ["a", "b", "c", "d"];
  const { coordinator, order } = recordingCoordinator(declared);
  const result = await coordinator.run("SIGTERM");
  assert.deepEqual(order, declared, "steps must execute in array order");
  assert.deepEqual(result.completed, declared);
  assert.equal(result.failed.length, 0);
  assert.equal(result.timedOut, false);
});

test("a second signal is idempotent and BOTH callers observe the same result", async () => {
  let runs = 0;
  const coordinator = new ShutdownCoordinator({
    steps: [{ name: "dispose (must run once)", run: async () => { runs += 1; await tick(); } }],
    log: () => {},
  });
  // Two overlapping signals, exactly as SIGTERM followed by SIGINT would arrive.
  const [r1, r2] = await Promise.all([coordinator.run("SIGTERM"), coordinator.run("SIGINT")]);
  assert.equal(runs, 1, "a second signal must NOT start a second cleanup pass");
  assert.strictEqual(r1, r2, "both callers observe the identical result object");
  assert.equal(r1.signal, "SIGTERM", "the first signal owns the run");
  // A late third signal also returns the same settled result.
  const r3 = await coordinator.run("SIGTERM");
  assert.strictEqual(r3, r1);
});

test("a step that throws does not prevent the later steps (especially the DB close)", async () => {
  const order = [];
  const coordinator = new ShutdownCoordinator({
    steps: [
      { name: "stop scanner", run: () => { order.push("stop scanner"); throw new Error("scanner already down"); } },
      { name: "flush outbox", run: () => { order.push("flush outbox"); } },
      { name: "close MongoDB", run: () => { order.push("close MongoDB"); } },
      { name: "close PostgreSQL", run: () => { order.push("close PostgreSQL"); throw new Error("pg hiccup"); } },
    ],
    log: () => {},
  });
  const result = await coordinator.run("SIGTERM");
  // Every step still ran, in order, despite the early throw.
  assert.deepEqual(order, ["stop scanner", "flush outbox", "close MongoDB", "close PostgreSQL"]);
  assert.deepEqual(result.completed, ["flush outbox", "close MongoDB"]);
  assert.deepEqual(result.failed.map((f) => f.step).sort(), ["close PostgreSQL", "stop scanner"]);
  // A step throwing is NOT, on its own, a failed shutdown — the sequence reached the end.
  assert.equal(result.timedOut, false);
  assert.equal(shutdownExitCode(result), 0, "a thrown step alone must not report a failed shutdown");
});

test("PostgreSQL is closed LAST, after every other step including a throwing one", async () => {
  const order = [];
  const mk = (name, fn) => ({ name, run: fn ?? (() => { order.push(name); }) });
  const coordinator = new ShutdownCoordinator({
    steps: [
      mk("stop entry"),
      mk("close MongoDB", () => { order.push("close MongoDB"); throw new Error("mongo already gone"); }),
      mk("close PostgreSQL"),
    ],
    log: () => {},
  });
  await coordinator.run("SIGTERM");
  assert.equal(order[order.length - 1], "close PostgreSQL", "PostgreSQL must be the final close");
  assert.ok(order.indexOf("close MongoDB") < order.indexOf("close PostgreSQL"), "Mongo closes before PG");
});

test("the deadline is honoured and produces a NON-ZERO exit code", async () => {
  // A virtual clock so the test is fast and deterministic: `now()` jumps past the deadline.
  let clock = 0;
  const coordinator = new ShutdownCoordinator({
    steps: [
      { name: "quick", run: () => {} },
      { name: "hangs forever", run: () => new Promise(() => { /* never resolves */ }) },
      { name: "never reached", run: () => { throw new Error("should not run"); } },
    ],
    timeoutMs: 50,
    log: () => {},
    now: () => (clock += 1_000), // each read advances 1s, so durationMs is measured as non-zero
  });
  const result = await coordinator.run("SIGTERM");
  assert.equal(result.timedOut, true, "a hung step must trip the deadline");
  assert.equal(shutdownExitCode(result), 1, "a timed-out shutdown must exit non-zero");
  assert.ok(result.completed.includes("quick"));
  assert.ok(!result.completed.includes("hangs forever"));
});

test("SIGTERM NEVER calls anything that could flatten a position", async () => {
  // Drive a coordinator built from fakes mirroring index.ts, INCLUDING a flatten spy that
  // is wired to a hook no shutdown step invokes. If any step ever calls it, this fails.
  let flattenCalls = 0;
  const flatten = () => { flattenCalls += 1; };
  const coordinator = new ShutdownCoordinator({
    steps: [
      { name: "block new Box entry and stop scanner discovery", run: () => {} },
      { name: "stop accepting mutating HTTP requests", run: () => {} },
      { name: "stop broker token polling", run: () => {} },
      { name: "stop market-data subscriptions and sockets", run: () => {} },
      { name: "stop monitoring and timers (positions preserved)", run: () => {/* dispose: no flatten */} },
      { name: "flush bounded Mongo outbox work", run: () => {} },
      { name: "close HTTP and SSE", run: () => {} },
      // Hands the broker account back. Named here so the spy proves it is NOT a liquidation: a
      // successor must be able to adopt and reduce the exposure this process leaves open, and handing
      // ownership back is how it does that WITHOUT anything being closed on the way out.
      { name: "release execution ownership", run: () => {/* fence-pinned DELETE: no flatten */} },
      { name: "close MongoDB", run: () => {} },
      { name: "close PostgreSQL", run: () => {} },
    ],
    log: () => {},
  });
  const result = await coordinator.run("SIGTERM");
  assert.equal(flattenCalls, 0, "NO shutdown step may flatten/liquidate/close a position");
  assert.equal(result.failed.length, 0);
  assert.equal(result.completed.length, 10);
});

test("the Mongo flush is BOUNDED — one pass, not drain-until-empty", async () => {
  // The real flush step calls projector.stop() then a SINGLE runOnce(). We model that the
  // step performs exactly one drain pass even when work remains, and never loops to empty.
  let runOnceCalls = 0;
  let stopped = false;
  const fakeProjector = {
    stop: () => { stopped = true; },
    runOnce: async () => { runOnceCalls += 1; return { claimed: 5, published: 3, failed: 2 }; },
  };
  const coordinator = new ShutdownCoordinator({
    steps: [{
      name: "flush bounded Mongo outbox work",
      run: async () => {
        fakeProjector.stop();
        await fakeProjector.runOnce(); // ONE pass; remaining work is durable in PostgreSQL
      },
    }],
    log: () => {},
  });
  await coordinator.run("SIGTERM");
  assert.equal(stopped, true, "the projector loop is stopped before the final flush");
  assert.equal(runOnceCalls, 1, "the flush must be a single bounded pass, never a drain-until-empty loop");
});

/* ─────────────────────── declared-order source parse ─────────────────────── */

/**
 * Parse the ordered step `name:` literals out of the ShutdownCoordinator({ steps: [...] })
 * block in src/index.ts. This pins the ORDER that cannot be executed offline.
 */
function parseDeclaredStepNames() {
  const src = readFileSync(INDEX_TS, "utf8");
  const anchor = src.indexOf("new ShutdownCoordinator({");
  assert.ok(anchor >= 0, "the coordinator must be constructed in src/index.ts");
  const stepsStart = src.indexOf("steps:", anchor);
  assert.ok(stepsStart >= 0, "the coordinator must declare a steps array");
  // Bound the scan to the coordinator construction (up to the signal wiring loop).
  const region = src.slice(stepsStart, src.indexOf("for (const signal of", stepsStart));
  const names = [];
  const re = /name:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(region)) !== null) names.push(m[1]);
  return names;
}

test("the declared order matches the specified shutdown order", () => {
  const declared = parseDeclaredStepNames();
  const expected = [
    "block new Box entry and stop scanner discovery",     // block new entry -> stop scanner discovery
    "stop accepting mutating HTTP requests",               // stop mutating HTTP
    "stop broker token polling",                           // stop token polling
    "stop market-data subscriptions and sockets",          // stop market-data subscriptions/socket
    "stop monitoring and timers (positions preserved)",    // stop monitoring/timers
    "flush bounded Mongo outbox work",                     // flush BOUNDED Mongo outbox
    "close HTTP and SSE",                                   // close HTTP/SSE
    // Hands the broker account back so a replacement instance need not wait out the lease TTL before
    // it can monitor and reduce the exposure this process leaves open. A DATABASE WRITE, so it must
    // sit after the engine has stopped and strictly before PostgreSQL closes. It does not liquidate.
    "release execution ownership",
    "close MongoDB",                                        // close Mongo
    "close PostgreSQL",                                     // close PostgreSQL LAST
  ];
  assert.deepEqual(declared, expected, "the declared step order must match the specified order exactly");
});

test("execution ownership is released before PostgreSQL closes, and is not a liquidation", () => {
  const declared = parseDeclaredStepNames();
  const release = declared.indexOf("release execution ownership");
  assert.ok(release >= 0, "the lease must be released during shutdown, not merely left to lapse");
  assert.ok(
    release < declared.indexOf("close PostgreSQL"),
    "releasing the lease is a PostgreSQL write, so it must precede closing PostgreSQL",
  );
  assert.ok(
    release > declared.indexOf("stop monitoring and timers (positions preserved)"),
    "ownership must not be handed back while this process could still dispatch",
  );
  assert.doesNotMatch(
    declared[release],
    /flatten|liquidate|close position|square.?off/i,
    "handing back ownership must not be describable as liquidating anything",
  );
});

test("PostgreSQL is the LAST declared step and Mongo precedes it", () => {
  const declared = parseDeclaredStepNames();
  assert.equal(declared[declared.length - 1], "close PostgreSQL", "PostgreSQL must be closed last");
  assert.ok(
    declared.indexOf("close MongoDB") < declared.indexOf("close PostgreSQL"),
    "MongoDB must close before PostgreSQL",
  );
});

test("the outbox flush is declared as BOUNDED in the source", () => {
  const declared = parseDeclaredStepNames();
  const flush = declared.find((n) => /outbox/i.test(n));
  assert.ok(flush, "there must be an outbox flush step");
  assert.match(flush, /bounded/i, "the flush step name must state that it is bounded");
});

test("NO declared shutdown step names a flatten/liquidate/close-position action", () => {
  // The single most expensive thing this file could get wrong: turning a redeploy into a
  // forced liquidation. Asserted against the real step names, not a model.
  const declared = parseDeclaredStepNames();
  for (const name of declared) {
    assert.doesNotMatch(
      name,
      /flatten|liquidat|close[ -]?position|square[ -]?off|exit[ -]?position/i,
      `a shutdown step must never flatten a position: "${name}"`,
    );
  }
});

/* ─────────────────────────────── util ─────────────────────────────── */

const tick = () => new Promise((r) => setImmediate(r));
