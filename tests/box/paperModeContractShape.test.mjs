/**
 * THE PAPER-MODE PAYLOAD CONFORMS TO THE PUBLISHED CONTRACT — validated against the real schemas.
 *
 * WHY THIS IS A SEPARATE SUITE FROM tests/contract/
 *
 * `tests/contract/helpers.mjs` boots the Express app to validate real HTTP responses, which is the
 * right thing for the routes. This suite validates the same payload WITHOUT the HTTP layer, so the
 * schema/payload agreement is checked even where an HTTP server cannot be started, and so a schema
 * edit is caught by the fastest suite rather than the slowest.
 *
 * WHAT IT GUARDS. `operational-readiness.schema.json` is declared `additionalProperties: false`
 * with an explicit `required` list — deliberately CLOSED, because a silently added or renamed field
 * there is a silently changed permission. That makes the schema and the builder capable of drifting
 * apart in BOTH directions, and both are failures:
 *
 *   • a field added to the payload but not the schema  ⇒ every client rejects the whole response;
 *   • a field required by the schema but not published ⇒ the same.
 *
 * This change adds `paper_execution`, nine `market_data` transport/evidence fields and three
 * `evidence` fields, and widens two enums. All of it is asserted here against the REAL engine
 * output, in the deployed `paper_latency` mode.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validate } from "../../contract/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");
const SCHEMAS_DIR = resolve(HERE, "..", "..", "contract", "schemas");

let _registry = null;
async function schemas() {
  if (_registry) return _registry;
  const names = (await readdir(SCHEMAS_DIR)).filter((n) => n.endsWith(".schema.json")).sort();
  const registry = {};
  for (const name of names) {
    registry[name] = JSON.parse(await readFile(resolve(SCHEMAS_DIR, name), "utf8"));
  }
  _registry = registry;
  return registry;
}

async function check(value, schemaName) {
  const registry = await schemas();
  const schema = registry[schemaName];
  assert.ok(schema, `no such schema: ${schemaName}`);
  return validate(value, schema, { registry });
}

/** Exactly the bytes a client receives from res.json(value). */
const wire = (v) => JSON.parse(JSON.stringify(v));

function engineDeps({ broker = "zerodha" } = {}) {
  return {
    marketData: { isAuthenticated: () => true, getQuoteFull: async () => ({}) },
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
    charges: { broker, rateVersion: "test", estimate: () => null },
    getAllInstruments: async () => [],
    getBoard: async () => [],
    priceChargeGroups: async () => null,
    istDayKey: () => "2026-09-08",
    makeIdResolver: () => () => null,
    isMarketOpen: () => true,
    margins: {
      broker,
      basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }),
    },
    brokerAccountRef: () => "AB1234",
  };
}

function depthTick(token, bid = 100, ask = 100.5) {
  return {
    token,
    last_price: (bid + ask) / 2,
    close_price: bid,
    oi: 0,
    bid,
    ask,
    bids: [{ price: bid, qty: 500, orders: 3 }],
    asks: [{ price: ask, qty: 500, orders: 3 }],
    depth_updated: true,
  };
}

async function engineWithLiveFeed(broker = "zerodha") {
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const engine = new BoxEngine(engineDeps({ broker }));
  engine.marketDataMachine.setDesiredInstruments([4001, 4002]);
  engine.subscribedOptionTokens = new Set([4001, 4002]);
  engine.onBoxLaneConnection(true);
  engine.ingestBoxLaneTicks([depthTick(4001), depthTick(4002)]);
  engine.onBoxLaneHeartbeat();
  return engine;
}

/* ═══════════════════════ schema conformance ═══════════════════════ */

for (const broker of ["zerodha", "dhan"]) {
  test(`[${broker}] the paper_latency box-status payload satisfies its schema`, async () => {
    const engine = await engineWithLiveFeed(broker);
    try {
      const status = wire(engine.getStatus());
      assert.deepEqual(
        await check(status, "box-status.schema.json"),
        [],
        "box-status must satisfy its schema",
      );
      assert.deepEqual(
        await check(status.operational_readiness, "operational-readiness.schema.json"),
        [],
        "the readiness decision must satisfy its CLOSED schema — a new field must be declared",
      );
      assert.deepEqual(
        await check(status.order_stream, "order-stream-status.schema.json"),
        [],
        "the order-stream snapshot must satisfy its schema with the paper enum values",
      );
    } finally {
      engine.dispose?.();
    }
  });
}

test("the new market-data transport fields are PUBLISHED, not merely declared", async () => {
  const engine = await engineWithLiveFeed();
  try {
    const md = wire(engine.getStatus()).operational_readiness.market_data;

    // The six distinct facts a dashboard must not collapse.
    assert.equal(md.source, "broker_websocket");
    assert.equal(md.socket_connected, true);
    assert.equal(md.authenticated, true);
    assert.equal(md.subscriptions_requested, true);
    assert.equal(typeof md.usable_books, "number");
    assert.ok(md.usable_books >= 2, "two books were delivered");
    assert.equal(md.ticks_observed, true);
    assert.ok(md.frames_observed >= 2);
    assert.ok(md.heartbeats_observed >= 1, "the heartbeat was observed and counted separately");
    assert.ok(md.depth_observations >= 2);

    // Desired vs usable is reported as two numbers, not one.
    assert.equal(md.desired_instruments, 2);
    assert.ok(md.ready_instruments <= md.desired_instruments);
  } finally {
    engine.dispose?.();
  }
});

test("evidence carries monotonic ages, wall stamps, and the clock domain", async () => {
  const engine = await engineWithLiveFeed();
  try {
    const ev = wire(engine.getStatus()).operational_readiness.evidence;

    assert.equal(ev.market_data_age_clock, "monotonic");
    for (const key of [
      "market_data_frame_age_ms",
      "market_data_depth_age_ms",
      "market_data_heartbeat_age_ms",
    ]) {
      assert.ok(Number.isInteger(ev[key]), `${key} must be an integer, got ${ev[key]}`);
      assert.ok(ev[key] >= 0, `${key} must not be negative`);
      assert.ok(
        ev[key] < 60_000,
        `${key} of ${ev[key]}ms is impossible for a feed that just ticked — a mixed clock domain`,
      );
    }
    // Wall stamps are real epoch milliseconds, and are NOT the ages.
    assert.ok(ev.market_data_last_frame_at > 1_600_000_000_000, "a real epoch timestamp");
    assert.ok(ev.market_data_last_depth_at > 1_600_000_000_000);
    assert.notEqual(
      ev.market_data_frame_age_ms,
      ev.market_data_last_frame_at,
      "the age and the timestamp are different quantities in different domains",
    );
  } finally {
    engine.dispose?.();
  }
});

test("paper_execution is present and truthful in the published payload", async () => {
  const engine = await engineWithLiveFeed();
  try {
    const pe = wire(engine.getStatus()).operational_readiness.paper_execution;
    assert.equal(pe.simulated, true);
    assert.equal(pe.profile, "paper_latency");
    assert.equal(pe.using_streamed_quotes, true);
    assert.equal(typeof pe.detail, "string");
    assert.match(pe.detail, /Real broker WebSocket quotes · simulated execution/);
  } finally {
    engine.dispose?.();
  }
});

test("NO SECRET reaches the wire through any of the new fields", async () => {
  // The new fields carry a source label, counters, ages and sentences. This is the standing
  // no-secrets assertion applied to the widened payload.
  const engine = await engineWithLiveFeed();
  try {
    const blob = JSON.stringify(wire(engine.getStatus()));
    assert.doesNotMatch(blob, /AB1234/, "the account reference is published MASKED or not at all");
    assert.doesNotMatch(blob, /access_token|api_secret|Bearer |passcode/i);
  } finally {
    engine.dispose?.();
  }
});

test("the schema genuinely REJECTS the old pre-fix shapes (negative control)", async () => {
  // Without this, every assertion above could pass against a schema that validates anything.
  const engine = await engineWithLiveFeed();
  try {
    const good = wire(engine.getStatus()).operational_readiness;

    // (a) the old mechanism label for paper fills is no longer merely discouraged — but it IS still
    //     a legal enum value, so instead assert an INVALID one is refused.
    const badMechanism = structuredClone(good);
    badMechanism.fill_observation.mechanism = "rest_polling_maybe";
    assert.notDeepEqual(await check(badMechanism, "operational-readiness.schema.json"), []);

    // (b) dropping paper_execution must fail: it is required, so a deployment cannot omit the
    //     answer to "how is execution actually performed".
    const noPaper = structuredClone(good);
    delete noPaper.paper_execution;
    assert.notDeepEqual(
      await check(noPaper, "operational-readiness.schema.json"),
      [],
      "paper_execution is REQUIRED",
    );

    // (c) an age must not be a float — a monotonic clock is fractional, so this is a real hazard.
    const floatAge = structuredClone(good);
    floatAge.evidence.market_data_frame_age_ms = 12.7;
    assert.notDeepEqual(
      await check(floatAge, "operational-readiness.schema.json"),
      [],
      "the contract declares an integer age",
    );

    // (d) the clock domain is a const, so a payload cannot claim wall-clock ages.
    const wrongClock = structuredClone(good);
    wrongClock.evidence.market_data_age_clock = "wall";
    assert.notDeepEqual(
      await check(wrongClock, "operational-readiness.schema.json"),
      [],
      "market_data_age_clock is pinned to monotonic",
    );

    // (e) an undeclared field must fail closed — the schema is CLOSED on purpose.
    const extra = structuredClone(good);
    extra.market_data.definitely_not_declared = true;
    assert.notDeepEqual(await check(extra, "operational-readiness.schema.json"), []);
  } finally {
    engine.dispose?.();
  }
});
