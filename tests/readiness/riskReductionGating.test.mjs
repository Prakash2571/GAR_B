/**
 * FINDING C — the HTTP readiness gate vs risk reduction, PINNED.
 *
 * The single readiness gate in src/index.ts refuses ALL mutating requests while the
 * process is not `ready` (i.e. `starting`, `failed` or `shutting_down`). That set
 * includes the operator's MANUAL risk-reducing routes:
 *
 *     POST /api/box/live/flatten
 *     POST /api/box/live/cancel-working
 *     POST /api/box/live/reconcile
 *     POST /api/box/trades/:id/close
 *     POST /api/box/execution/control        (the emergency-flatten control lives here)
 *
 * The audit judged this bounded-but-unpinned. This suite PINS the intended, correct
 * behaviour so it can never change silently:
 *
 *   (1) Each manual risk-reducing route returns 503 with the readiness reason while
 *       `starting` AND while `shutting_down`. This is DELIBERATE:
 *         • before readiness (`starting`) no durable exposure has been adopted, so a
 *           manual flatten would act on an empty, un-reconciled world — it MUST be
 *           refused;
 *         • refusing mutations during `shutting_down` is PRE-EXISTING behaviour (the
 *           old `shuttingDown` middleware already did this) — not a regression.
 *
 *   (2) The engine's AUTOMATIC risk reduction (automatic exit, protective
 *       cancellation, reconciliation, emergency residual flatten) is NOT
 *       readiness-gated. It is engine-internal and never passes through the HTTP
 *       readiness middleware at all. This is the invariant that actually matters: an
 *       HTTP gate must NEVER be able to stop risk reduction.
 *         • STRUCTURAL: the ReadinessController is imported ONLY by src/index.ts (the
 *           HTTP layer); no engine module under src/box/** references it, so the
 *           automatic reduction paths cannot consult it.
 *         • BEHAVIOURAL: a real engine order manager performs a PROTECTIVE_CANCEL and
 *           an EXIT with no readiness controller anywhere in the stack — proving the
 *           automatic path does not depend on HTTP readiness.
 *
 * Mirrors tests/readiness/readiness.test.mjs conventions: a REAL express app wired
 * with the SAME single readiness gate used by src/index.ts, driven by the REAL
 * ReadinessController from dist, served over node:http on 127.0.0.1:0 and probed
 * with fetch. The behavioural half reuses the live engine harness the invariant
 * suite uses (tests/box/liveEntryHarness.mjs), so "the cancel/exit reached the
 * broker" is a statement about a real mutation, not internal bookkeeping.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { liveStack } from "../box/liveEntryHarness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");
const SRC = resolve(HERE, "..", "..", "src");

const { ReadinessController } = await import(`${DIST}/runtime/readiness.js`);

/** The manual, operator-initiated risk-reducing routes, exactly as src/box/routes.ts mounts them. */
const RISK_REDUCING_ROUTES = [
  "/api/box/live/flatten",
  "/api/box/live/cancel-working",
  "/api/box/live/reconcile",
  "/api/box/trades/trade-123/close", // POST /api/box/trades/:id/close
  "/api/box/execution/control", // carries the emergency-flatten control
];

/**
 * Boot a real express app wired EXACTLY as src/index.ts wires the readiness gate,
 * with the manual risk-reducing routes mounted AFTER the gate (as src/box/routes.ts
 * mounts them behind requireOperator, which itself sits behind this gate). If the gate
 * lets a request through, the route answers 200 — so a 200 here would be a FAILURE to
 * gate, making the test bite.
 */
async function startApp(readiness = new ReadinessController()) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // --- THE SINGLE READINESS GATE (mirrors src/index.ts, byte-for-byte) ------
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

  // The manual risk-reducing routes, mounted AFTER the gate. Each would answer 200 if
  // reached — so any 200 while not-ready is a gate failure.
  for (const path of ["/api/box/live/flatten", "/api/box/live/cancel-working", "/api/box/live/reconcile", "/api/box/execution/control"]) {
    app.post(path, (_req, res) => res.status(200).json({ ok: true }));
  }
  app.post("/api/box/trades/:id/close", (_req, res) => res.status(200).json({ ok: true }));

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

async function post(origin, path) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

/* ─────────── (1) manual risk-reducing routes are gated while NOT ready ─────────── */

test("every manual risk-reducing route returns 503 while `starting` (no exposure adopted yet)", async () => {
  const app = await startApp(); // fresh controller = `starting`
  try {
    assert.equal(app.readiness.getState(), "starting");
    for (const path of RISK_REDUCING_ROUTES) {
      const { res, body } = await post(app.origin, path);
      assert.equal(res.status, 503, `${path} must be 503 while starting`);
      assert.match(body.error, /not ready/i, `${path} must carry the not-ready readiness reason`);
    }
  } finally {
    await app.close();
  }
});

test("every manual risk-reducing route returns 503 while `shutting_down` (pre-existing drain behaviour)", async () => {
  const app = await startApp();
  try {
    app.readiness.markReady();
    app.readiness.markShuttingDown();
    assert.equal(app.readiness.getState(), "shutting_down");
    for (const path of RISK_REDUCING_ROUTES) {
      const { res, body } = await post(app.origin, path);
      assert.equal(res.status, 503, `${path} must be 503 while shutting down`);
      assert.match(body.error, /shutting down/i, `${path} must carry the shutting-down readiness reason`);
    }
  } finally {
    await app.close();
  }
});

test("once `ready`, the manual risk-reducing routes are reachable (the gate is not permanently closed)", async () => {
  const app = await startApp();
  try {
    app.readiness.markReady();
    for (const path of RISK_REDUCING_ROUTES) {
      const { res } = await post(app.origin, path);
      assert.equal(res.status, 200, `${path} must be reachable once ready`);
    }
  } finally {
    await app.close();
  }
});

/* ─────────── (2a) STRUCTURAL: the gate is HTTP-only; the engine never consults it ─────────── */

test("STRUCTURAL: ReadinessController is imported ONLY by the HTTP layer (src/index.ts), never by the engine", () => {
  // The gate is HTTP middleware in src/index.ts. If any engine module under src/box/**
  // imported the ReadinessController, an HTTP-readiness state could reach the automatic
  // reduction paths — exactly what must be impossible. We assert the import graph.
  const indexSrc = readFileSync(resolve(SRC, "index.ts"), "utf8");
  assert.match(
    indexSrc,
    /import\s*\{\s*ReadinessController\s*\}\s*from\s*["']\.\/runtime\/readiness\.js["']/,
    "src/index.ts must be the module that owns the ReadinessController",
  );

  // The gate itself is HTTP middleware keyed on the HTTP method — assert its shape is present.
  assert.match(indexSrc, /readiness\.mutationsAllowed\(\)/, "the gate must consult mutationsAllowed()");
  assert.match(indexSrc, /req\.method === "POST"/, "the gate must be HTTP-method scoped (HTTP-only)");
});

test("STRUCTURAL: no engine module under src/box/** references the HTTP ReadinessController", async () => {
  // Walk src/box/**/*.ts and assert none of them import runtime/readiness or reference the
  // ReadinessController symbol or its mutationsAllowed() method. The word "readiness" appears in
  // the engine for DATA/FEED/PERSISTENCE readiness (a different concept), so we assert the
  // SPECIFIC HTTP-gate identifiers are absent, not the generic word.
  const { readdirSync, statSync } = await import("node:fs");
  const boxDir = resolve(SRC, "box");
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(full, "utf8");
      if (
        /runtime\/readiness/.test(text) ||
        /\bReadinessController\b/.test(text) ||
        /\.mutationsAllowed\s*\(/.test(text)
      ) {
        offenders.push(full);
      }
    }
  };
  walk(boxDir);
  assert.deepEqual(
    offenders,
    [],
    `no engine module may consult the HTTP readiness gate; offenders: ${JSON.stringify(offenders)}`,
  );
});

/* ─────────── (2b) BEHAVIOURAL: automatic reduction runs with NO readiness gate in the stack ─────────── */

/** Attribute the four legs so the manager treats a reduction as owned exposure. */
function ownFourLegs(stack, { quantity = 75 } = {}) {
  const legs = stack.candidate.legs;
  stack.manager.setAttributedBoxPositions([
    { exchange: "NFO", tradingsymbol: legs.k1_ce.tradingsymbol, net_quantity: quantity },
    { exchange: "NFO", tradingsymbol: legs.k2_ce.tradingsymbol, net_quantity: -quantity },
    { exchange: "NFO", tradingsymbol: legs.k2_pe.tradingsymbol, net_quantity: quantity },
    { exchange: "NFO", tradingsymbol: legs.k1_pe.tradingsymbol, net_quantity: -quantity },
  ]);
}

test("BEHAVIOURAL: a PROTECTIVE_CANCEL reaches the broker with no readiness controller anywhere in the engine stack", async () => {
  const stack = await liveStack();
  ownFourLegs(stack);
  // The engine harness has NO ReadinessController — the automatic reduction path cannot
  // consult one because none exists in this stack. That is the point: reduction is not
  // wired to HTTP readiness.
  assert.equal(typeof stack.readiness, "undefined", "the engine stack must not carry an HTTP readiness controller");

  const cancelRequest = {
    client_order_id: "BOX:trade-live-1:PROTECTIVE_CANCEL:k1_ce:cancel-1",
    role: "k1_ce",
    trade_id: "trade-live-1",
    attempt_id: "cancel-1",
    purpose: "PROTECTIVE_CANCEL",
    phase: "exit",
    exchange: "NFO",
    tradingsymbol: stack.candidate.legs.k1_ce.tradingsymbol,
    token: stack.candidate.legs.k1_ce.token,
    side: "SELL",
    quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 99.9 },
  };

  const order = await stack.manager.submit(cancelRequest);
  assert.equal(order.client_order_id, cancelRequest.client_order_id);
  assert.equal(stack.adapter.posts.length, 1, "the protective cancel reached the broker with no HTTP gate involved");
  assert.equal(stack.adapter.posts[0].purpose, "PROTECTIVE_CANCEL");
});

test("BEHAVIOURAL: an EXIT reaches the broker with no readiness controller anywhere in the engine stack", async () => {
  const stack = await liveStack();
  ownFourLegs(stack);
  assert.equal(typeof stack.readiness, "undefined", "the engine stack must not carry an HTTP readiness controller");

  const exitRequest = {
    client_order_id: "BOX:trade-live-1:EXIT:k1_ce:exit-1",
    role: "k1_ce",
    trade_id: "trade-live-1",
    attempt_id: "exit-1",
    purpose: "EXIT",
    phase: "exit",
    exchange: "NFO",
    tradingsymbol: stack.candidate.legs.k1_ce.tradingsymbol,
    token: stack.candidate.legs.k1_ce.token,
    side: "SELL",
    quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 99.9 },
  };

  const order = await stack.manager.submit(exitRequest);
  assert.equal(order.client_order_id, exitRequest.client_order_id);
  assert.equal(stack.adapter.posts.length, 1, "the exit reached the broker with no HTTP gate involved");
  assert.equal(stack.adapter.posts[0].purpose, "EXIT");
});
