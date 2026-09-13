/**
 * The scanner's REFUSAL MESSAGES are operator-facing safety copy.
 *
 * WHY THIS FILE EXISTS
 * `BoxEngine.start()` refuses for two reasons, and both messages were inherited from
 * the predecessor codebase where they were correct and in this backend were not:
 *
 *   1. It said "Box persistence is not configured (set MONGODB_URI)". In this backend
 *      PostgreSQL is the operational authority and MongoDB Atlas is an asynchronous
 *      reporting replica whose absence must NEVER block the scanner. `isBoxDbEnabled()`
 *      resolves to `isPgReady()`, so the only thing that can trip that branch is
 *      PostgreSQL. Telling an operator to fix Mongo while PostgreSQL is down sends them
 *      to the wrong database in the middle of a session.
 *
 *   2. It said "Connect to Zerodha before starting the box scanner". GTS Algo Research runs
 *      either broker, so a Dhan-active deployment showed an instruction naming a broker
 *      it was not using.
 *
 * A wrong diagnostic is not cosmetic: it is the thing an operator acts on under time
 * pressure. These assertions pin the corrected copy so neither can silently regress.
 *
 * The engine is driven through its PUBLIC `start()` with fake providers — no database
 * and no broker — because the branches under test are the first two statements in the
 * method and are reached before any I/O.
 */

import assert from "node:assert/strict";
import test from "node:test";

const { BoxEngine } = await import("../../dist/box/engine.js");

/**
 * Minimal engine dependencies. Only the two collaborators the guarded branches read
 * have to behave; everything else exists so construction succeeds.
 */
function engineWith({ authenticated, broker }) {
  return new BoxEngine({
    marketData: {
      isAuthenticated: () => authenticated,
      getQuoteFull: async () => ({}),
    },
    activeBroker: () => broker,
    feed: {
      addTickListener: () => () => {},
      addConnectionListener: () => () => {},
      retain: () => () => {},
      subscribeTokens: () => {},
      unsubscribeTokens: () => {},
      setStrategyTokens: () => {},
      setBoxTokens: () => {},
      subscribedCount: () => 0,
      isConnected: () => false,
    },
    charges: {
      broker,
      rateVersion: "test",
      estimate: () => null,
    },
    getAllInstruments: async () => [],
    getBoard: async () => [],
    priceChargeGroups: async () => null,
    istDayKey: () => "2026-09-08",
    makeIdResolver: () => () => null,
    isMarketOpen: () => false,
    margins: {
      broker,
      basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }),
    },
  });
}

test("an unauthenticated broker refusal names the ACTIVE broker, never a hardcoded Zerodha", async () => {
  for (const broker of ["zerodha", "dhan"]) {
    const engine = engineWith({ authenticated: false, broker });
    const result = await engine.start();

    assert.equal(result.ok, false, `${broker}: start() must refuse without a session`);
    assert.match(
      result.error,
      new RegExp(broker, "i"),
      `${broker}: the refusal must name the broker actually in use`,
    );
    engine.dispose();
  }
});

test("a Dhan-active deployment is never told to connect to Zerodha", async () => {
  // The specific production confusion this guards: `LTP -` on the dashboard next to a
  // banner naming a broker the deployment is not using.
  const engine = engineWith({ authenticated: false, broker: "dhan" });
  const result = await engine.start();
  assert.doesNotMatch(
    result.error,
    /zerodha/i,
    "a Dhan-active deployment must not mention Zerodha in its refusal",
  );
  engine.dispose();
});

test("the persistence refusal blames PostgreSQL, never MongoDB", async () => {
  // Authenticated, so the FIRST branch passes and the persistence branch is the one
  // that refuses. No PostgreSQL pool is initialised in this process, so
  // isBoxDbEnabled() -> isPgReady() is false — exactly the production condition.
  const engine = engineWith({ authenticated: true, broker: "zerodha" });
  const result = await engine.start();

  assert.equal(result.ok, false, "start() must refuse while PostgreSQL is unavailable");
  assert.match(result.error, /postgres/i, "the refusal must name PostgreSQL as the cause");
  assert.doesNotMatch(
    result.error,
    /MONGODB_URI/,
    "MongoDB Atlas is a reporting replica; it must never be blamed for a PostgreSQL outage",
  );
  assert.doesNotMatch(
    result.error,
    /\bmongo/i,
    "the message must not send the operator to the wrong database",
  );
  engine.dispose();
});

test("the persistence refusal tells the operator where to look", async () => {
  // A diagnostic that names a cause without naming a check is only half useful.
  const engine = engineWith({ authenticated: true, broker: "zerodha" });
  const result = await engine.start();
  assert.match(result.error, /DATABASE_URL/, "name the variable that configures it");
  assert.match(result.error, /runtime\/status/, "name the endpoint that reports it");
  engine.dispose();
});

test("refusing to start leaves the scanner stopped rather than half-running", async () => {
  // The load-bearing part: a refusal must not leave discovery enabled. Both refusal
  // branches return BEFORE `this.running = true`, and this pins that.
  const engine = engineWith({ authenticated: true, broker: "zerodha" });
  const result = await engine.start();
  assert.equal(result.ok, false);
  assert.equal(
    engine.exposureSummary().scannerRunning,
    false,
    "a refused start must not leave the scanner reporting itself as running",
  );
  engine.dispose();
});
