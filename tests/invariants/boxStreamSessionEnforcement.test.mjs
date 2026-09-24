/**
 * AN OPEN SSE STREAM IS ENFORCED, NOT JUST AUTHENTICATED ONCE.
 *
 * `tests/box/streamSession.test.mjs` pins the POLICY (what verdict each situation deserves). This file
 * pins the WIRING, which is where the defect actually lived: the route authenticated when the stream
 * opened and then never again, so a client that simply held its connection kept receiving full state
 * snapshots after its session was revoked and after the session's hard expiry. The policy being right is
 * worth nothing if nothing calls it, and nothing did.
 *
 * The route is mounted against a MINIMAL app recorder rather than a real express server: the handler is
 * the unit of interest, and driving it directly is what makes "the session was revoked twenty seconds
 * in" expressible without a real socket, a real database, or a twenty-second wait. The heartbeat cadence
 * is injectable for exactly that reason.
 *
 * `tests/access/gate.test.mjs` continues to cover the complementary half — that the stream cannot be
 * opened without a cookie, and that a token in the query string is never accepted.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { registerBoxRoutes } = await import("../../dist/box/routes.js");

/** Records the handler registered for each route, so one can be invoked directly. */
function appRecorder() {
  const routes = new Map();
  const record = (method) => (path, ...handlers) => {
    routes.set(`${method} ${path}`, handlers[handlers.length - 1]);
  };
  return {
    routes,
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    delete: record("DELETE"),
  };
}

/** The parts of req/res an SSE handler touches, and nothing else. */
function connection({ expiresAt, sessionToken = "session-token-abc" }) {
  const closeHandlers = [];
  const req = {
    operator: { role: "full", sessionToken, expiresAt, csrfTokenHash: "hash" },
    query: {},
    params: {},
    on(event, fn) {
      if (event === "close") closeHandlers.push(fn);
    },
    fireClose() {
      for (const fn of closeHandlers) fn();
    },
  };
  const res = {
    headers: {},
    chunks: [],
    statusCode: 200,
    body: null,
    ended: false,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    flushHeaders() {},
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return { req, res };
}

/** An engine stand-in that records registration, deregistration and server-side closes. */
function engineRecorder() {
  const events = { added: 0, removed: 0, closed: [] };
  return {
    events,
    engine: {
      addSseClient() {
        events.added += 1;
        return () => {
          events.removed += 1;
        };
      },
      closeSseClient(_res, reason) {
        events.closed.push(reason);
      },
      getStatus: () => ({}),
      getConfig: () => ({}),
    },
  };
}

function mount({ isSessionLive, graceMs = 50, heartbeatMs }) {
  const app = appRecorder();
  const { engine, events } = engineRecorder();
  registerBoxRoutes(app, {
    engine,
    requireOperator: (_req, _res, next) => next(),
    getOperatorRole: (req) => req.operator?.role ?? null,
    isSessionLive,
    streamSessionGraceMs: graceMs,
    ...(heartbeatMs !== undefined ? { streamHeartbeatMs: heartbeatMs } : {}),
  });
  const handler = app.routes.get("GET /api/box/stream");
  assert.equal(typeof handler, "function", "the stream route must be registered");
  return { handler, events };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hourAhead = () => new Date(Date.now() + 3_600_000);

test("a live session streams, and its own token is what gets re-verified", async () => {
  const seen = [];
  const { handler, events } = mount({
    isSessionLive: async (token) => {
      seen.push(token);
      return true;
    },
    heartbeatMs: 10,
  });
  const { req, res } = connection({ expiresAt: hourAhead(), sessionToken: "session-token-abc" });
  handler(req, res);

  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.equal(events.added, 1);

  await wait(40);
  assert.ok(res.chunks.length > 0, "the heartbeat must actually run");
  assert.equal(res.ended, false, "a live session keeps streaming");
  assert.deepEqual(
    [...new Set(seen)],
    ["session-token-abc"],
    "the stream re-verifies the session it was opened with — never a token from the URL",
  );

  req.fireClose();
  assert.equal(events.removed, 1);
});

test("a REVOKED session ends the stream from the server side", async () => {
  let live = true;
  const { handler, events } = mount({ isSessionLive: async () => live, heartbeatMs: 10 });
  const { req, res } = connection({ expiresAt: hourAhead() });
  handler(req, res);

  await wait(30);
  assert.equal(res.ended, false);

  // The operator logs out: the row is revoked, so the session no longer validates.
  live = false;
  await wait(40);

  assert.equal(
    res.ended,
    true,
    "THE DEFECT: the stream kept delivering state snapshots after its session was revoked, because " +
      "nothing after the opening request ever checked again",
  );
  assert.equal(events.removed, 1, "and the engine must stop holding the response object");
  assert.match(events.closed[0] ?? "", /revoked/, "the client is told why, not just cut off");
});

test("an EXPIRED session ends the stream even with the session store answering happily", async () => {
  // Expiry is decided locally and fails closed: a store that says "still live" cannot extend a session
  // past `expires_at`, because there is no sliding renewal.
  const { handler, events } = mount({ isSessionLive: async () => true, heartbeatMs: 10 });
  const { req, res } = connection({ expiresAt: new Date(Date.now() + 25) });
  handler(req, res);

  await wait(80);

  assert.equal(res.ended, true);
  assert.match(events.closed[0] ?? "", /expiry/);
});

test("a stream opened after expiry is closed without waiting for a heartbeat at all", async () => {
  const { handler, events } = mount({ isSessionLive: async () => true });
  const { req, res } = connection({ expiresAt: new Date(Date.now() - 1) });
  handler(req, res);

  await wait(20);

  assert.equal(res.ended, true, "the 20s heartbeat must not be the only thing that can close a stream");
  assert.equal(events.removed, 1);
});

test("a session-store outage is tolerated briefly, then the stream is closed", async () => {
  const { handler, events } = mount({
    isSessionLive: async () => {
      throw new Error("connection terminated unexpectedly");
    },
    heartbeatMs: 10,
    graceMs: 60,
  });
  const { req, res } = connection({ expiresAt: hourAhead() });
  handler(req, res);

  await wait(30);
  assert.equal(
    res.ended,
    false,
    "a database blip must not take the operator's live view away — an unreadable store is not " +
      "evidence that anybody was revoked",
  );

  await wait(120);
  assert.equal(res.ended, true, "but a stream cannot run unverified indefinitely either");
  assert.match(events.closed[0] ?? "", /could not be re-verified/);
});

test("a slow session store does not accumulate one overlapping query per heartbeat", async () => {
  let inFlight = 0;
  let peak = 0;
  const { handler } = mount({
    isSessionLive: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await wait(40);
      inFlight -= 1;
      return true;
    },
    heartbeatMs: 5,
  });
  const { req, res } = connection({ expiresAt: hourAhead() });
  handler(req, res);

  await wait(120);
  req.fireClose();
  assert.equal(peak, 1, "checks must be single-flighted, or a slow store becomes a query pile-up");
  assert.equal(res.ended, true);
});

test("teardown runs exactly once, whichever reason gets there first", async () => {
  const { handler, events } = mount({ isSessionLive: async () => false, heartbeatMs: 10 });
  const { req, res } = connection({ expiresAt: hourAhead() });
  handler(req, res);

  await wait(40);
  assert.equal(events.removed, 1);

  req.fireClose();
  req.fireClose();
  assert.equal(events.removed, 1, "a double teardown would deregister a client twice");
});

test("a request without a validated operator session registers nothing at all", () => {
  const { handler, events } = mount({ isSessionLive: async () => true });
  const { req, res } = connection({ expiresAt: hourAhead() });
  delete req.operator;

  handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(events.added, 0, "an unauthenticated caller must never reach the engine's registry");
});
