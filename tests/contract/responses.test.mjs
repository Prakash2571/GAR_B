/**
 * CONTRACT SUITE — real serialized responses validated against contract/schemas/.
 *
 * Every case says HOW the response was obtained:
 *   [HTTP]   real route registrar mounted on a real loopback express app + fetch;
 *            requireOperator routes use a REAL PG-backed session (migration 007).
 *   [SERDE]  the real pure serializer / real engine method called directly and JSON
 *            round-tripped — used only where the route needs a live engine + DB +
 *            market feed to reach (documented per case).
 *
 * These validate REAL bytes, never hand-written literals: HTTP bodies come off the
 * wire; SERDE values come from the actual production serializer/engine functions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  startApp, createDbSchema, login, authGet, authPost,
  makeBrokerProvider, check, wire,
} from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");

const PASSCODE = "ci-fake-site-access-secret-not-a-real-passcode";
const assertValid = (errs, name) =>
  assert.deepEqual(errs, [], `${name} must satisfy its schema; errors: ${JSON.stringify(errs)}`);

/* ══════════════════════════ HTTP: access + status + broker ══════════════════════════ */

test("[HTTP] access verify / status / runtime / export / broker shapes", async (t) => {
  const db = await createDbSchema("resp");
  const app = await startApp(db.databaseUrl, {
    env: { SITE_ACCESS_SECRET: PASSCODE },
    brokerProvider: makeBrokerProvider({ active: "zerodha", generation: 3 }),
  });
  t.after(async () => { await app.close(); await db.drop(); });

  // access verify (200)
  const auth = await login(app.origin, PASSCODE);
  assert.equal(auth.res.status, 200, "verify must succeed with the configured passcode");
  assertValid(await check(auth.body, "access-verify.schema.json"), "access-verify");

  // access status — authenticated branch
  const statusAuthed = await authGet(app.origin, "/api/access/status", auth.cookieHeader);
  assert.equal(statusAuthed.res.status, 200);
  assert.equal(statusAuthed.body.authenticated, true);
  assertValid(await check(statusAuthed.body, "access-status.schema.json"), "access-status (authed)");

  // access status — anonymous branch (no cookie)
  const statusAnon = await authGet(app.origin, "/api/access/status", "");
  assert.equal(statusAnon.body.authenticated, false);
  assertValid(await check(statusAnon.body, "access-status.schema.json"), "access-status (anon)");

  // runtime status
  const runtime = await authGet(app.origin, "/api/runtime/status", auth.cookieHeader);
  assert.equal(runtime.res.status, 200);
  assertValid(await check(runtime.body, "runtime-status.schema.json"), "runtime-status");

  // export status
  const exp = await authGet(app.origin, "/api/export/status", auth.cookieHeader);
  assert.equal(exp.res.status, 200);
  assertValid(await check(exp.body, "export-status.schema.json"), "export-status");

  // broker status
  const bstat = await authGet(app.origin, "/api/broker/status", auth.cookieHeader);
  assert.equal(bstat.res.status, 200);
  assertValid(await check(bstat.body, "broker-status.schema.json"), "broker-status");

  // broker switch-blockers (no blockers)
  const blockers = await authGet(app.origin, "/api/broker/switch-blockers?broker=dhan", auth.cookieHeader);
  assert.equal(blockers.res.status, 200);
  assertValid(await check(blockers.body, "broker-switch-blockers.schema.json"), "broker-switch-blockers");
});

test("[HTTP] broker selection success (200) vs refusal (409)", async (t) => {
  const db = await createDbSchema("respsel");

  // Success: a provider with no blockers.
  const okApp = await startApp(db.databaseUrl, {
    env: { SITE_ACCESS_SECRET: PASSCODE },
    brokerProvider: makeBrokerProvider({ active: "zerodha", generation: 1, blockers: [] }),
  });
  const okAuth = await login(okApp.origin, PASSCODE);
  const success = await authPost(okApp.origin, "/api/broker/select", okAuth.cookieHeader, okAuth.csrf, { broker: "dhan" });
  assert.equal(success.res.status, 200, "a switch with no blockers must succeed");
  assertValid(await check(success.body, "broker-select-success.schema.json"), "broker-select-success");
  await okApp.close();

  // Refusal: a provider with blockers -> 409 with the full list.
  const noApp = await startApp(db.databaseUrl, {
    env: { SITE_ACCESS_SECRET: PASSCODE },
    brokerProvider: makeBrokerProvider({ active: "zerodha", generation: 1, blockers: ["open Box exposure", "an in-flight entry"] }),
  });
  const noAuth = await login(noApp.origin, PASSCODE);
  const refusal = await authPost(noApp.origin, "/api/broker/select", noAuth.cookieHeader, noAuth.csrf, { broker: "dhan" });
  assert.equal(refusal.res.status, 409, "a switch with blockers must be refused with 409");
  assertValid(await check(refusal.body, "broker-select-refusal.schema.json"), "broker-select-refusal");
  assert.deepEqual(refusal.body.blockers, ["open Box exposure", "an in-flight entry"], "the FULL blocker list must be returned");
  await noApp.close();

  await db.drop();
});

/* ══════════════════════ SERDE: box engine + serializer shapes ══════════════════════ */

function engineWith({ authenticated = true, broker = "zerodha" } = {}) {
  return {
    marketData: { isAuthenticated: () => authenticated, getQuoteFull: async () => ({}) },
    activeBroker: () => broker,
    feed: {
      addTickListener: () => () => {}, addConnectionListener: () => () => {}, retain: () => () => {},
      subscribeTokens: () => {}, unsubscribeTokens: () => {}, setStrategyTokens: () => {}, setBoxTokens: () => {},
      subscribedCount: () => 0, isConnected: () => false,
    },
    charges: { broker, rateVersion: "test", estimate: () => null },
    getAllInstruments: async () => [], getBoard: async () => [],
    priceChargeGroups: async () => null, istDayKey: () => "2026-09-08",
    makeIdResolver: () => () => null, isMarketOpen: () => false,
    margins: { broker, basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }) },
  };
}

test("[SERDE] box status / config / execution-control (real BoxEngine methods)", async () => {
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const e = new BoxEngine(engineWith());
  try {
    assertValid(await check(wire(e.getConfig()), "box-config.schema.json"), "box-config");
    assertValid(await check(wire(e.getStatus()), "box-status.schema.json"), "box-status");
    assertValid(await check(wire(e.getExecutionControl()), "box-execution-control.schema.json"), "box-execution-control");
    // The SSE snapshot payload and the opportunities/open-trades envelopes on an idle engine.
    assertValid(await check(wire(e.snapshot()), "box-sse-snapshot.schema.json"), "box-sse-snapshot");
    assertValid(await check({ opportunities: wire(e.getOpportunities()), status: wire(e.getStatus()) }, "box-opportunities.schema.json"), "box-opportunities");
    assertValid(await check({ dbEnabled: false, open: wire(e.getOpenPositions()) }, "box-open-trades.schema.json"), "box-open-trades (open only)");
  } finally {
    e.dispose();
  }
});

test("[SERDE] SSE frame envelope round-trips through the engine's own framing", async () => {
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const e = new BoxEngine(engineWith());
  try {
    // Reproduce writeFrame() byte-for-byte (src/box/engine.ts): `event: <name>\ndata: <json>\n\n`.
    const payload = e.snapshot();
    const frame = `event: snapshot\ndata: ${JSON.stringify(wire(payload))}\n\n`;
    // Parse the SSE frame back into { event, data }.
    const lines = frame.split("\n");
    const event = lines.find((l) => l.startsWith("event: ")).slice("event: ".length);
    const data = JSON.parse(lines.find((l) => l.startsWith("data: ")).slice("data: ".length));
    const parsed = { event, data };
    assertValid(await check(parsed, "sse-envelope.schema.json"), "sse-envelope");
    assert.equal(parsed.event, "snapshot");
    // A snapshot frame's data must ALSO satisfy the snapshot payload contract.
    assertValid(await check(parsed.data, "box-sse-snapshot.schema.json"), "sse snapshot data");
  } finally {
    e.dispose();
  }
});

test("[SERDE] a real opportunity (real BoxScanner + evaluateCandidate)", async () => {
  const h = await import(`${HERE}/../box/helpers.mjs`);
  const { BoxScanner } = await import(`${DIST}/box/scanner.js`);
  const { BoxChargeEstimator } = await import(`${DIST}/box/charges.js`);
  const { BoxExecutionSimulator } = await import(`${DIST}/box/executionSimulator.js`);
  const { BoxMetrics } = await import(`${DIST}/box/metrics.js`);
  const { BoxPositionBook } = await import(`${DIST}/box/positions.js`);
  const { BoxQuoteStore } = await import(`${DIST}/box/quotes.js`);

  const { candidate, all } = h.goodCandidate();
  const conf = h.cfg({});
  const quotes = new BoxQuoteStore();
  const positions = new BoxPositionBook();
  const metrics = new BoxMetrics(conf.metricsWindow);
  const executionSim = new BoxExecutionSimulator({ cfg: conf, quotes, isMarketOpen: () => true, isFeedHealthy: () => true, metrics });
  const charges = new BoxChargeEstimator(h.chargeStub({}).fn, conf);
  const scanner = new BoxScanner({
    cfg: conf, quotes, charges, localCharges: h.localChargesStub({}), executionSim, positions, metrics,
    openPaperTrade: async () => "box1", onEvent: () => {},
  });
  scanner.setCandidatesForUnderlying("NIFTY", all);
  scanner.setMarketOpen(true);
  scanner.setFeedHealthy(true);
  const now = Date.now();
  const map = h.quotesFor(candidate, {}, { at: now });
  for (const [token, q] of map) quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], now);
  scanner.setDiscovering(false);
  scanner.onTokensUpdated([...map.keys()]);

  const opps = wire(scanner.listOpportunities(50));
  assert.ok(opps.length >= 1, "the fixture must produce at least one opportunity");
  for (const opp of opps) {
    assertValid(await check(opp, "box-opportunity.schema.json"), `opportunity ${opp.key}`);
  }
});

test("[SERDE] a real open position (real BoxPositionMonitor.measure)", async () => {
  const h = await import(`${HERE}/../box/helpers.mjs`);
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const { BoxPositionMonitor } = await import(`${DIST}/box/positionMonitor.js`);
  const { BoxQuoteStore } = await import(`${DIST}/box/quotes.js`);
  const { BoxMetrics } = await import(`${DIST}/box/metrics.js`);

  const conf = h.cfg({});
  const { candidate } = h.goodCandidate();
  const quotes = new BoxQuoteStore();
  const now = Date.now();
  const map = h.exitQuotes(candidate, 198, { at: now });
  for (const [token, q] of map) quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], now);

  const monitor = new BoxPositionMonitor({
    cfg: conf, quotes, localCharges: h.localChargesStub({}),
    isMarketOpen: () => true, isFeedHealthy: () => true, metrics: new BoxMetrics(conf.metricsWindow),
    istDayKey: () => "2026-09-08", istMinutesOfDay: () => 600,
  });
  const pos = h.positionFrom(candidate, { metrics: null, broker: "zerodha", execution_mode: "paper_touch" });
  pos.metrics = monitor.measure(pos);

  const e = new BoxEngine(engineWith());
  try {
    e.positionsRef.add(pos);
    const open = wire(e.getOpenPositions());
    assert.equal(open.length, 1, "one open position expected");
    assertValid(await check(open[0], "box-open-position.schema.json"), "open position");
    // The full /api/box/trades envelope shape (open + trades).
    assertValid(await check({ dbEnabled: true, open, trades: [] }, "box-open-trades.schema.json"), "open-trades envelope");
    // The SSE snapshot with a live open position.
    assertValid(await check({ status: wire(e.getStatus()), opportunities: [], open_trades: open }, "box-sse-snapshot.schema.json"), "snapshot with open position");
  } finally {
    e.dispose();
  }
});

test("[SERDE] a serialized Box trade + margin provenance (real serializeBoxTrade)", async () => {
  const h = await import(`${HERE}/../box/helpers.mjs`);
  const { serializeBoxTrade } = await import(`${DIST}/box/serialize.js`);
  const { configSnapshot, loadBoxConfig } = await import(`${DIST}/box/config.js`);

  const { candidate } = h.goodCandidate();
  const opened = new Date("2026-08-29T04:20:00.000Z");
  const closed = new Date("2026-08-29T05:10:30.000Z");
  const mkDoc = (overrides = {}) => ({
    _id: { toString: () => "68b0f1c2a1b2c3d4e5f60001" },
    execution_mode: "paper_touch", underlying: "NIFTY", name: "NIFTY 50", is_index: true,
    expiry: candidate.expiry, lower_strike: h.GOOD_BOX.k1, upper_strike: h.GOOD_BOX.k2,
    lot_size: h.LOT, quantity: h.LOT, status: "closed",
    legs: [{
      role: "k1_ce", token: 1004, tradingsymbol: "NIFTY26SEP19900CE", exchange: "NFO",
      strike: h.GOOD_BOX.k1, instrument_type: "CE", side: "BUY", entry_price: 300, entry_bid: 299,
      entry_bid_qty: 150, entry_ask: 300, entry_ask_qty: 150, entry_quote_at: opened,
      entry_depth: { bids: [], asks: [] }, exit_price: 350, exit_bid: 350, exit_bid_qty: 150,
      exit_ask: 351, exit_ask_qty: 150, exit_quote_at: closed, exit_depth: { bids: [], asks: [] },
    }],
    box_width: h.GOOD_BOX.width, entry_box_cost: h.GOOD_BOX.costPerUnit * h.LOT,
    entry_gross_edge: h.GOOD_BOX.grossEdge, entry_charges: null, estimated_exit_charges: null,
    safety_buffer: 150, entry_net_edge: 1425, opened_at: opened, current_remaining_edge: 150,
    exit_box_value: 198 * h.LOT, exit_charges: null, gross_pnl: 1725, total_charges: 300,
    net_pnl: 1425, closed_at: closed, exit_reason: "EDGE_CONVERGED", exit_blocked_reason: null,
    expiry_safety: false, scanner_config_snapshot: configSnapshot(loadBoxConfig()), error: null,
    ...overrides,
  });

  // Closed trade.
  const closedTrade = wire(serializeBoxTrade(mkDoc()));
  assertValid(await check(closedTrade, "box-trade.schema.json"), "box-trade (closed)");
  assertValid(await check({ margin: closedTrade.margin, margin_source: closedTrade.margin_source }, "margin-provenance.schema.json"), "margin-provenance (closed, null source)");

  // Open trade (null exit fields).
  const openTrade = wire(serializeBoxTrade(mkDoc({
    status: "open", closed_at: null, exit_reason: null, exit_box_value: null,
    gross_pnl: null, total_charges: null, net_pnl: null,
  })));
  assertValid(await check(openTrade, "box-trade.schema.json"), "box-trade (open)");

  // Each margin provenance model round-trips through the serializer and the schema.
  for (const source of ["kite_basket", "dhan_multi", "dhan_per_leg_fallback", "unavailable"]) {
    const t = wire(serializeBoxTrade(mkDoc({ margin: 12345, margin_source: source })));
    assert.equal(t.margin_source, source);
    assertValid(await check(t, "box-trade.schema.json"), `box-trade (${source})`);
    assertValid(await check({ margin: t.margin, margin_source: t.margin_source }, "margin-provenance.schema.json"), `margin-provenance (${source})`);
  }

  // The trades-history (scope=all) envelope.
  assertValid(
    await check({ dbEnabled: true, scope: "all", source: "postgres", cacheEnabled: false, lite: true, trades: [closedTrade] }, "box-trades-history.schema.json"),
    "trades-history (all)",
  );
  // The trades-history (scope=today) envelope with an empty lite list.
  assertValid(
    await check({ dbEnabled: true, scope: "today", source: "memory", day: "2026-09-09", cacheEnabled: false, lite: true, trades: [] }, "box-trades-history.schema.json"),
    "trades-history (today)",
  );
});

test("[SERDE] event ledger legs (real toEventLegs)", async () => {
  const h = await import(`${HERE}/../box/helpers.mjs`);
  const { toEventLegs } = await import(`${DIST}/box/serialize.js`);
  const { evaluateCandidate } = await import(`${DIST}/box/math.js`);
  const { candidate } = h.goodCandidate();
  const now = 1_000_000;
  const ev = evaluateCandidate({ candidate, quotes: h.quotesFor(candidate, {}, { at: now - 200 }), now, maxAgeMs: 1500 });
  const legs = wire(toEventLegs(ev.legs));
  assert.equal(legs.length, 4);
  for (const leg of legs) {
    assertValid(await check(leg, "box-event-leg.schema.json"), `event leg ${leg.role}`);
  }
  // The events envelope on an idle engine (empty ledger, real engine loadable path -> [] here).
  assertValid(await check({ events: [] }, "box-events.schema.json"), "events envelope");
  assertValid(await check({ dbEnabled: false, attempts: [] }, "box-execution-attempts.schema.json"), "execution-attempts envelope");
  // Chains LIST form from a real idle engine.
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const e = new BoxEngine(engineWith());
  try {
    assertValid(await check({ chains: wire(e.listChainSymbols()) }, "box-chains.schema.json"), "chains (list)");
  } finally {
    e.dispose();
  }
});

/* ════════════════ SERDE: the REAL re-projections src/index.ts ships ════════════════
 *
 * The HTTP cases above drive the routes with INERT provider stubs, which can only
 * ever produce the shape the stub author chose to type out. That is exactly how two
 * real fields (`enabled`/`connected` on export status, `state` on a broker session)
 * shipped without ever being declared or schema'd: the stub omitted them, so the
 * contract suite validated a stub, not production.
 *
 * These cases close that gap. src/index.ts re-projects each internal read model into
 * its public shape via the pure functions in src/runtime/projections.js. We import
 * the IDENTICAL functions and feed them realistic INTERNAL inputs (the camelCase
 * outbox snapshot, the internal BrokerSessionState / BrokerHealthState), then
 * validate their output against the schema. Because production calls the same
 * function, a field the projection emits is guaranteed to be in the schema.
 */

test("[SERDE] projectExportStatus output (the REAL export-status projection) satisfies the schema", async () => {
  const { projectExportStatus } = await import(`${DIST}/runtime/projections.js`);
  // A realistic camelCase outbox snapshot as src/outbox/status.ts getExportStatus returns.
  const internal = {
    enabled: true,
    connected: true,
    backlog: 7,
    oldestPendingAgeMs: 4200,
    lastSuccessAt: "2026-09-09T03:20:00.000Z",
    lastError: null,
    deadLettered: 1,
    publishedTotal: 999,
    attemptsHistogram: { "0": 5, "1": 2 },
  };
  const projected = wire(projectExportStatus(internal));
  assertValid(await check(projected, "export-status.schema.json"), "export-status (real projection)");
  // The two fields the inert stub used to omit MUST be present and boolean.
  assert.equal(projected.enabled, true, "enabled must survive the projection");
  assert.equal(projected.connected, true, "connected must survive the projection");
  // The internal-only fields (publishedTotal, attemptsHistogram, camelCase names)
  // must NOT leak onto the wire — additionalProperties:false would already fail, but
  // assert explicitly for a clearer signal.
  assert.deepEqual(
    Object.keys(projected).sort(),
    ["backlog_count", "connected", "dead_letter_count", "enabled", "last_error", "last_success_at", "oldest_pending_age_ms"],
    "the projection must emit exactly the public field set",
  );

  // connected can be false while enabled is true (Mongo temporarily disconnected).
  const disconnected = wire(projectExportStatus({ ...internal, connected: false }));
  assertValid(await check(disconnected, "export-status.schema.json"), "export-status (disconnected)");
  assert.equal(disconnected.connected, false);
});

test("[SERDE] projectBrokerSession output (the REAL broker-session projection) covers every state", async () => {
  const { projectBrokerSession } = await import(`${DIST}/runtime/projections.js`);

  // Internal BrokerSessionState fixtures spanning the full `state` domain.
  const base = {
    broker: "zerodha",
    client_id: "AB1234567",
    client_name: "Operator",
    token_expires_at: Date.parse("2026-09-09T18:30:00.000Z"),
    login_day: "2026-09-09",
    login_at: Date.parse("2026-09-09T03:15:00.000Z"),
  };
  const cases = [
    { name: "waiting", s: { ...base, authenticated: false, token_expired: false }, active: "zerodha", expect: "waiting" },
    { name: "expired", s: { ...base, authenticated: true, token_expired: true }, active: "zerodha", expect: "expired" },
    // THE REAL-WORLD EXPIRED SHAPE. Both brokers report `authenticated: false` once their
    // token is past its expiry (Dhan by its stated instant, Zerodha by the IST day
    // boundary), so this — not the case above — is what an expired session actually looks
    // like. The projection used to test `!authenticated` FIRST and label it "waiting",
    // telling the operator to wait for something while `problems` told them to act.
    { name: "expired-unauthenticated", s: { ...base, authenticated: false, token_expired: true }, active: "zerodha", expect: "expired" },
    { name: "ready", s: { ...base, authenticated: true, token_expired: false }, active: "zerodha", expect: "ready" },
    { name: "standby", s: { ...base, authenticated: true, token_expired: false }, active: "dhan", expect: "standby" },
  ];
  const seen = new Set();
  for (const c of cases) {
    const projected = wire(projectBrokerSession("zerodha", c.s, c.active));
    assertValid(await check(projected, "broker-session.schema.json"), `broker-session (${c.name})`);
    assert.equal(projected.state, c.expect, `state must be ${c.expect}`);
    seen.add(projected.state);
    // No credential leaked: the account_label is redacted (last 4 only), never the raw id.
    assert.notEqual(projected.account_label, base.client_id, "account_label must be redacted, never the raw client_id");
    // Exactly the public field set — internal fields (client_name, login_day) must not leak.
    assert.deepEqual(
      Object.keys(projected).sort(),
      ["account_label", "broker", "connected", "established_at", "expires_at", "state"],
      "the session projection must emit exactly the public field set",
    );
  }
  assert.deepEqual([...seen].sort(), ["expired", "ready", "standby", "waiting"], "all four states exercised");

  // A never-authenticated broker projects null labels/timestamps and is schema-valid.
  const empty = wire(projectBrokerSession("dhan", {
    broker: "dhan", authenticated: false, client_id: null, client_name: null,
    token_expires_at: null, token_expired: false, login_day: null, login_at: null,
  }, "zerodha"));
  assertValid(await check(empty, "broker-session.schema.json"), "broker-session (empty)");
  assert.equal(empty.state, "waiting");
});

test("[SERDE] projectBrokerHealth output (the REAL broker-health projection) satisfies the schema", async () => {
  const { projectBrokerHealth } = await import(`${DIST}/runtime/projections.js`);
  // A full internal BrokerHealthState, including internal-only fields that must NOT leak.
  const internal = {
    broker: "zerodha",
    authenticated: true,
    token_expires_at: Date.parse("2026-09-09T18:30:00.000Z"),
    token_expired: false,
    data_ready: true,
    trading_ready: false,
    static_ip_configured: null,
    feed_connected: true,
    feed_age_ms: 120,
    problems: ["Live trading disarmed"],
  };
  const projected = wire(projectBrokerHealth("zerodha", internal));
  assertValid(await check(projected, "broker-health.schema.json"), "broker-health (real projection)");
  assert.deepEqual(
    Object.keys(projected).sort(),
    ["authenticated", "broker", "data_ready", "problems", "trading_ready"],
    "the health projection must emit exactly the public field set (no token metadata, feed age or static-IP leak)",
  );
});
