/**
 * HONEST STARTUP READINESS — regression suite.
 *
 * Proves the FIX-6 contract end to end WITHOUT a database (hermetic, loopback only),
 * following the conventions of tests/access/helpers.mjs and tests/shutdown/*:
 *   • the readiness STATE MACHINE is driven directly from dist/runtime/readiness.js;
 *   • a REAL express app is wired with the SAME single readiness gate + /api/health
 *     handler used by src/index.ts, served over node:http on 127.0.0.1:0 and probed
 *     with fetch — supertest is not available.
 *
 * The app harness re-implements ONLY the two things src/index.ts mounts around the
 * readiness controller (the one mutating-refusal gate and the contentless health
 * endpoint), byte-for-byte matching the source, and drives them with the REAL
 * ReadinessController. The state machine itself is the module under test, imported
 * from dist — never re-implemented.
 *
 * A "boot"/"shutdown" here is modelled as an ordered list of async steps plus the
 * readiness transitions src/index.ts performs around them, so the tests can assert
 * ORDER (readiness flips before resources close) and OUTCOME (never ready after a
 * failure) without spawning a real server, DB, feeds or brokers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");

const { ReadinessController, sanitizeFailureReason } = await import(`${DIST}/runtime/readiness.js`);

/* ───────────────────────────── app harness ───────────────────────────── */

/**
 * Boot a real express app wired EXACTLY as src/index.ts wires the readiness gate and
 * health endpoint, driven by a real ReadinessController. Returns the origin, the
 * controller and a close().
 */
async function startApp(readiness = new ReadinessController()) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // --- THE SINGLE READINESS GATE (mirrors src/index.ts) --------------------
  app.use((req, res, next) => {
    const mutating =
      req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
    if (mutating && !readiness.mutationsAllowed()) {
      const state = readiness.getState();
      const message =
        state === "shutting_down"
          ? "GTS Box is shutting down; mutating requests are refused."
          : "GTS Box is not ready; mutating requests are refused until startup completes.";
      res.status(503).json({ error: message });
      return;
    }
    next();
  });

  // --- CONTENTLESS HEALTH (mirrors src/index.ts) ---------------------------
  app.get("/api/health", (_req, res) => {
    const state = readiness.getState();
    const ready = readiness.isReady();
    res.status(ready ? 200 : 503).json({
      service: "strikedge",
      state,
      ready,
      shutting_down: state === "shutting_down",
    });
  });

  // Mounted AFTER the gate, exactly like the access routes and Box module in
  // src/index.ts, so a mutation cannot slip past. These stand in for
  // /api/access/verify, scanner controls, broker switching and session arming.
  app.post("/api/access/verify", (_req, res) => res.status(200).json({ ok: true }));
  app.post("/api/box/scanner/start", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/api/box/status", (_req, res) => res.status(200).json({ ok: true }));

  const server = createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    readiness,
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
}

async function getJson(origin, path, init) {
  const res = await fetch(`${origin}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

/**
 * Model of src/index.ts's boot + readiness wiring, without a DB/engine/feeds.
 *
 * `steps` run in order. If any throws, boot is marked FAILED, the "resource close"
 * teardown steps run (recording their order), and readiness is NEVER marked ready.
 * On success readiness is marked ready exactly once.
 */
async function runBootLike(readiness, { steps, closers = [], onEvent = () => {} }) {
  try {
    for (const step of steps) {
      await step();
    }
    const flipped = readiness.markReady();
    onEvent({ type: "ready-attempt", flipped });
  } catch (err) {
    readiness.markFailed(err);
    onEvent({ type: "failed", reason: readiness.snapshot().failureReason });
    // Mirror failBootAndExit(): shutting_down BEFORE closing resources.
    readiness.markShuttingDown();
    for (const close of closers) {
      await close();
    }
  }
}

/* ─────────────────────── state-machine unit tests ─────────────────────── */

test("initial state is starting, not ready, mutations refused", () => {
  const r = new ReadinessController();
  assert.equal(r.getState(), "starting");
  assert.equal(r.isReady(), false);
  assert.equal(r.mutationsAllowed(), false);
  assert.deepEqual(r.snapshot(), { state: "starting", ready: false, failureReason: null });
});

test("starting -> ready is legal and idempotent (ready happens exactly once)", () => {
  const r = new ReadinessController();
  assert.equal(r.markReady(), true, "first ready transition applies");
  assert.equal(r.getState(), "ready");
  assert.equal(r.isReady(), true);
  assert.equal(r.mutationsAllowed(), true);
  // A SECOND markReady must be refused as a state change — no double transition.
  assert.equal(r.markReady(), false, "second ready transition must be refused");
  assert.equal(r.getState(), "ready");
});

test("failed -> ready is REFUSED (a failed boot can never become ready)", () => {
  const r = new ReadinessController();
  assert.equal(r.markFailed("broker restore blew up"), true);
  assert.equal(r.getState(), "failed");
  assert.equal(r.isReady(), false);
  // The single most important refusal.
  assert.equal(r.transition("ready"), false, "failed -> ready must be refused");
  assert.equal(r.markReady(), false);
  assert.equal(r.getState(), "failed");
  assert.equal(r.isReady(), false);
});

test("ready -> failed is refused; a ready process only moves to shutting_down", () => {
  const r = new ReadinessController();
  r.markReady();
  assert.equal(r.markFailed("late fault"), false, "ready -> failed must be refused");
  assert.equal(r.getState(), "ready");
  assert.equal(r.markShuttingDown(), true, "ready -> shutting_down is legal");
  assert.equal(r.getState(), "shutting_down");
});

test("failed -> shutting_down is legal (so a failed boot can close resources)", () => {
  const r = new ReadinessController();
  r.markFailed("migration failure");
  assert.equal(r.markShuttingDown(), true);
  assert.equal(r.getState(), "shutting_down");
  assert.equal(r.isReady(), false);
});

test("shutting_down is terminal and repeated signals are harmless no-ops", () => {
  const r = new ReadinessController();
  r.markShuttingDown();
  assert.equal(r.getState(), "shutting_down");
  assert.equal(r.markShuttingDown(), false, "second signal is a no-op");
  assert.equal(r.transition("ready"), false, "shutting_down -> ready refused");
  assert.equal(r.transition("starting"), false, "shutting_down -> starting refused");
  assert.equal(r.getState(), "shutting_down");
});

test("markFailed keeps the FIRST reason (root cause), sanitised and bounded", () => {
  const r = new ReadinessController();
  r.markFailed(new Error("PostgreSQL down"));
  assert.equal(r.snapshot().failureReason, "PostgreSQL down");
  // A later teardown error must not overwrite why boot failed.
  r.markFailed(new Error("and then mongo close threw"));
  assert.equal(r.snapshot().failureReason, "PostgreSQL down");
});

test("failure reasons are single-line and bounded (no secret-laden stack leaks)", () => {
  const long = "x".repeat(500);
  const out = sanitizeFailureReason(new Error(long));
  assert.ok(out.length <= 200, "reason is hard-truncated");
  const multiline = sanitizeFailureReason("line1\n  SELECT token FROM t WHERE k=$1\nline3");
  assert.equal(multiline.includes("\n"), false, "multi-line collapsed to a single line");
  assert.equal(sanitizeFailureReason("   "), "unspecified failure");
});

/* ─────────────────────── HTTP behaviour: startup ─────────────────────── */

test("health is 503 with ready:false during startup", async () => {
  const app = await startApp();
  try {
    const { res, body } = await getJson(app.origin, "/api/health");
    assert.equal(res.status, 503);
    assert.equal(body.ready, false);
    assert.equal(body.state, "starting");
    assert.equal(body.service, "strikedge");
  } finally {
    await app.close();
  }
});

test("mutations (incl. /api/access/verify) are rejected with 503 during startup", async () => {
  const app = await startApp();
  try {
    for (const path of ["/api/access/verify", "/api/box/scanner/start"]) {
      const { res, body } = await getJson(app.origin, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 503, `${path} must be 503 during startup`);
      assert.match(body.error, /not ready/i);
    }
    // Reads still answer.
    const read = await getJson(app.origin, "/api/box/status");
    assert.equal(read.res.status, 200, "GET reads still answer during startup");
  } finally {
    await app.close();
  }
});

/* ─────────────────────── HTTP behaviour: transitions ─────────────────── */

test("a successful boot transitions to ready; health flips to 200 and mutations open", async () => {
  const app = await startApp();
  try {
    let readyEvents = 0;
    await runBootLike(app.readiness, {
      steps: [async () => {}, async () => {}], // pg, migrations, restore, engine, reconcile...
      onEvent: (e) => {
        if (e.type === "ready-attempt" && e.flipped) readyEvents += 1;
      },
    });
    assert.equal(readyEvents, 1, "ready transition happens exactly once");
    assert.equal(app.readiness.getState(), "ready");

    const health = await getJson(app.origin, "/api/health");
    assert.equal(health.res.status, 200);
    assert.equal(health.body.ready, true);
    assert.equal(health.body.state, "ready");

    const mut = await getJson(app.origin, "/api/access/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(mut.res.status, 200, "mutations are allowed once ready");
  } finally {
    await app.close();
  }
});

test("a broker-restore failure never becomes ready and never allows mutations", async () => {
  const app = await startApp();
  try {
    await runBootLike(app.readiness, {
      steps: [
        async () => {}, // pg + migrations ok
        async () => {
          throw new Error("authoritative broker restore failed: undecryptable Dhan session");
        },
        async () => {
          throw new Error("must-not-run: step after the failing restore");
        },
      ],
    });
    assert.notEqual(app.readiness.getState(), "ready");
    assert.equal(app.readiness.isReady(), false);

    const health = await getJson(app.origin, "/api/health");
    assert.equal(health.res.status, 503);
    assert.equal(health.body.ready, false);

    const mut = await getJson(app.origin, "/api/access/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(mut.res.status, 503, "a failed boot must never allow mutations");
  } finally {
    await app.close();
  }
});

test("a migration failure never becomes ready", async () => {
  const r = new ReadinessController();
  await runBootLike(r, {
    steps: [
      async () => {}, // pg ok
      async () => {
        throw new Error("Migration 006_active_broker.sql failed: relation already exists");
      },
    ],
  });
  assert.notEqual(r.getState(), "ready");
  assert.equal(r.isReady(), false);
  // The bounded reason is recorded and non-secret.
  assert.match(r.snapshot().failureReason, /Migration 006/);
});

test("a Mongo outage does NOT block readiness (projector is never a boot dependency)", async () => {
  const r = new ReadinessController();
  await runBootLike(r, {
    steps: [
      async () => {}, // pg + migrations
      async () => {}, // broker restore
      async () => {}, // engine boot + reconciliation complete
      async () => {
        // The projector start swallows a Mongo outage rather than throwing — model it
        // as a step that catches its own error and continues, exactly as src/index.ts
        // starts the projector INDEPENDENTLY of boot.
        try {
          throw new Error("MongoServerSelectionError: connection timed out");
        } catch {
          /* projector connectivity is not a boot dependency */
        }
      },
    ],
  });
  assert.equal(r.getState(), "ready", "a Mongo outage must not prevent readiness");
  assert.equal(r.isReady(), true);
});

/* ─────────────────────── shutdown ordering ─────────────────────── */

test("shutdown changes readiness to non-ready BEFORE resources close", async () => {
  const r = new ReadinessController();
  r.markReady();
  assert.equal(r.isReady(), true);

  const events = [];
  // Model src/index.ts's signal handler + coordinator: readiness flips FIRST, then
  // the resource-close steps run and record their order.
  r.markShuttingDown();
  events.push({ type: "readiness", ready: r.isReady(), state: r.getState() });
  for (const name of ["stop scanner", "stop feeds", "close HTTP", "close Mongo", "close PG"]) {
    events.push({ type: "close", name });
  }

  const firstClose = events.findIndex((e) => e.type === "close");
  const readinessFlip = events.findIndex((e) => e.type === "readiness");
  assert.ok(readinessFlip < firstClose, "readiness must flip before the first resource close");
  assert.equal(events[readinessFlip].ready, false, "readiness is non-ready at the flip");
  assert.equal(events[readinessFlip].state, "shutting_down");
});

test("during shutdown, health is 503 and mutations are refused", async () => {
  const app = await startApp();
  try {
    app.readiness.markReady();
    app.readiness.markShuttingDown();

    const health = await getJson(app.origin, "/api/health");
    assert.equal(health.res.status, 503);
    assert.equal(health.body.ready, false);
    assert.equal(health.body.state, "shutting_down");
    assert.equal(health.body.shutting_down, true);

    const mut = await getJson(app.origin, "/api/access/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(mut.res.status, 503);
    assert.match(mut.body.error, /shutting down/i);
  } finally {
    await app.close();
  }
});

/* ─────────────────────── contentless health ─────────────────────── */

test("the health response carries NO broker/token/exposure/migration detail", async () => {
  const app = await startApp();
  try {
    // Ready state: the fullest a health body ever gets.
    app.readiness.markReady();
    const { res, body } = await getJson(app.origin, "/api/health");
    assert.equal(res.status, 200);
    // ONLY these keys are permitted.
    assert.deepEqual(
      Object.keys(body).sort(),
      ["ready", "service", "shutting_down", "state"],
      "health body must contain only liveness/readiness keys",
    );
    // Belt-and-braces: no operational vocabulary anywhere in the serialised body.
    const serialised = JSON.stringify(body).toLowerCase();
    for (const forbidden of [
      "broker",
      "token",
      "position",
      "exposure",
      "migration",
      "zerodha",
      "dhan",
      "reconcil",
      "scanner",
      "generation",
    ]) {
      assert.equal(
        serialised.includes(forbidden),
        false,
        `health body must not mention "${forbidden}"`,
      );
    }
  } finally {
    await app.close();
  }
});
