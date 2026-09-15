/**
 * PAPER MODE CONSUMES THE REAL BROKER QUOTE FEED — driven through the production wiring.
 *
 * THE DEFECT THIS SUITE EXISTS FOR
 *
 * `src/box/engine.ts` constructed its market-data health machine with
 * `enabled: this.cfg.executionMode === "live"`, coupling MARKET-DATA MONITORING to LIVE-ORDER
 * EXECUTION. They are unrelated: market data is the quote feed, and `live` and all three paper
 * modes consume the same broker socket with the same full-depth subscriptions.
 *
 * Under the deployed `BOX_EXECUTION_MODE=paper_latency` the machine was therefore built DISABLED,
 * and because nearly every transition early-returns in that state the whole diagnostic surface was
 * dead in a very specific, recognisable pattern:
 *
 *   • `onAuthenticated()` early-returned      ⇒ generation stuck at 0
 *   • `onUsableDepth()` early-returned        ⇒ depth NEVER recorded, readyInstruments always 0
 *   • state never left DISABLED               ⇒ "DISABLED market-data lifecycle" on the dashboard
 *   • `marketDataEntryBlocker("DISABLED")` has scope `both` ⇒ EXPOSURE MANAGEMENT also reported
 *     blocked, which is the red exposure warning that appeared in paper for no reason at all
 *
 * These tests drive the REAL `BoxEngine` through its REAL production entry points
 * (`onBoxLaneConnection`, `ingestBoxLaneTicks`, `onBoxLaneHeartbeat`) and assert on its REAL
 * published payload. Nothing here asserts that a method name appears in a source file.
 *
 * They also pin the two honesty properties that must hold at the same time: a connected socket with
 * no ticks must NOT claim readiness, and paper fills must be reported as simulated rather than as
 * broker-observed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");

/**
 * A hermetic engine: no network, no database, no broker.
 *
 * Deliberately the same shape the contract suite uses, so this suite exercises the production
 * constructor rather than a bespoke test double of the engine.
 */
function engineDeps({ authenticated = true, broker = "zerodha", marketOpen = true } = {}) {
  return {
    marketData: { isAuthenticated: () => authenticated, getQuoteFull: async () => ({}) },
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
    isMarketOpen: () => marketOpen,
    margins: {
      broker,
      basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }),
    },
    brokerAccountRef: () => "AB1234",
  };
}

/** A tick carrying an AUTHORITATIVE two-sided book — the only kind that can warm an instrument. */
function depthTick(token, bid = 100, ask = 100.5) {
  return {
    token,
    last_price: (bid + ask) / 2,
    close_price: bid,
    oi: 0,
    bid,
    ask,
    bids: [
      { price: bid, qty: 500, orders: 3 },
      { price: bid - 0.5, qty: 700, orders: 4 },
    ],
    asks: [
      { price: ask, qty: 500, orders: 3 },
      { price: ask + 0.5, qty: 700, orders: 4 },
    ],
    depth_updated: true,
  };
}

/** An LTP-only tick: no ladder, so it must NOT be able to warm an executable book. */
function ltpOnlyTick(token, price = 100) {
  return { token, last_price: price, close_price: price, oi: 0, bid: 0, ask: 0 };
}

async function makeEngine(opts) {
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  return new BoxEngine(engineDeps(opts));
}

/**
 * Declare a subscription intent WITHOUT needing the REST universe.
 *
 * `refreshUniverse()` requires instrument/board fetches that a hermetic test has no business
 * doing, but the market-data machine measures readiness against the engine's DESIRED option set.
 * This drives the same private path `applySubscriptions` drives — the machine's own
 * `setDesiredInstruments` — so readiness is measured against a real intent.
 */
function declareDesired(engine, optionTokens) {
  engine.marketDataMachine.setDesiredInstruments(optionTokens);
  engine.subscribedOptionTokens = new Set(optionTokens);
}

/* ═════════════════ 1. PAPER RECEIVES SOCKET TICKS AND UPDATES QUOTES ═════════════════ */

test("paper_latency: the market-data machine is ARMED, not DISABLED", async () => {
  const engine = await makeEngine();
  try {
    const status = engine.getStatus();
    assert.equal(
      status.execution_mode,
      "paper_latency",
      "this suite must be running the deployed paper mode",
    );
    assert.notEqual(
      status.market_data_state,
      "DISABLED",
      "market data must be monitored in paper mode — this is the primary defect",
    );
    assert.equal(
      status.market_data_state,
      "DISCONNECTED",
      "armed but not yet connected: DISCONNECTED, never DISABLED",
    );
  } finally {
    engine.dispose?.();
  }
});

test("paper_latency: socket ticks reach the quote store and advance the lifecycle with REAL evidence", async () => {
  const engine = await makeEngine();
  try {
    declareDesired(engine, [101, 102, 103, 104]);

    // 1. The socket connects. This alone must NOT be readiness.
    engine.onBoxLaneConnection(true);
    let d = engine.operationalReadiness();
    assert.equal(d.market_data.socket_connected, true);
    assert.ok(d.market_data.generation >= 1, "authentication advanced the generation past 0");
    assert.equal(d.market_data.state, "SYNCHRONIZING", "connected is not ready");
    assert.equal(d.market_data.ticks_observed, false, "no frame has arrived yet");
    assert.equal(d.market_data.usable_for_entry, false);
    assert.equal(d.evidence.market_data_depth_age_ms, null, "never observed stays null, not 0");

    // 2. Real depth arrives on the box lane — the production ingestion entry point.
    engine.ingestBoxLaneTicks([depthTick(101), depthTick(102)]);

    d = engine.operationalReadiness();
    assert.equal(d.market_data.ticks_observed, true, "frames are now observed");
    assert.ok(d.market_data.depth_observations >= 2, "usable depth was recorded per instrument");
    assert.ok(d.market_data.usable_books >= 2, "the quote store holds executable books");
    assert.equal(d.market_data.state, "READY", "authenticated + live transport + delivering depth");
    assert.equal(d.market_data.usable_for_entry, true);
    assert.equal(d.market_data.source, "broker_websocket");

    // Ages are real, small, and in ONE clock domain.
    assert.ok(Number.isInteger(d.evidence.market_data_depth_age_ms));
    assert.ok(
      d.evidence.market_data_depth_age_ms < 60_000,
      `depth age ${d.evidence.market_data_depth_age_ms}ms betrays a mixed clock domain`,
    );
    assert.ok(d.evidence.market_data_frame_age_ms < 60_000);
    assert.equal(d.evidence.market_data_age_clock, "monotonic");

    // The quote store really does hold the book, with both sides.
    const quote = engine.quotes.get(101);
    assert.ok(quote, "the book is in the store");
    assert.equal(quote.bid, 100);
    assert.equal(quote.ask, 100.5);
  } finally {
    engine.dispose?.();
  }
});

test("paper_latency: an LTP-only tick keeps the transport alive but cannot make a book executable", async () => {
  const engine = await makeEngine();
  try {
    declareDesired(engine, [201]);
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([ltpOnlyTick(201)]);

    const d = engine.operationalReadiness();
    assert.equal(d.market_data.ticks_observed, true, "it IS an inbound frame");
    assert.equal(d.market_data.depth_observations, 0, "but it carries no authoritative ladder");
    assert.equal(d.market_data.usable_books, 0, "so no executable book exists");
    assert.equal(d.market_data.state, "SYNCHRONIZING", "and the feed is NOT ready");
    assert.equal(d.market_data.usable_for_entry, false);
    assert.equal(d.evidence.market_data_depth_age_ms, null);
  } finally {
    engine.dispose?.();
  }
});

/* ═════════════════ 2. CONNECTION WITHOUT DATA NEVER CLAIMS READINESS ═════════════════ */

test("a connected, heart-beating socket with NO depth does not claim executable readiness", async () => {
  const engine = await makeEngine();
  try {
    declareDesired(engine, [301, 302]);
    engine.onBoxLaneConnection(true);

    // Only keep-alives. This is the production heartbeat entry point.
    for (let i = 0; i < 25; i++) engine.onBoxLaneHeartbeat();

    const d = engine.operationalReadiness();
    assert.equal(d.market_data.socket_connected, true);
    assert.ok(d.market_data.heartbeats_observed >= 25, "the heartbeats were genuinely observed");
    assert.equal(d.market_data.depth_observations, 0);
    assert.equal(d.market_data.usable_books, 0);
    assert.equal(d.market_data.state, "SYNCHRONIZING");
    assert.equal(d.market_data.usable_for_entry, false, "an open socket is NOT readiness");
    assert.equal(d.entry.permitted, false);
    assert.equal(d.evidence.market_data_depth_age_ms, null, "no depth was ever observed");
    assert.ok(
      d.evidence.market_data_heartbeat_age_ms !== null,
      "but the heartbeat age IS known — the two facts stay distinct",
    );
  } finally {
    engine.dispose?.();
  }
});

test("heartbeat-only traffic cannot refresh a STALE book back into freshness", async () => {
  const engine = await makeEngine();
  try {
    declareDesired(engine, [401]);
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([depthTick(401)]);
    assert.equal(engine.operationalReadiness().market_data.state, "READY");

    const depthAgeBefore = engine.operationalReadiness().evidence.market_data_depth_age_ms;

    // A burst of keep-alives, and nothing else.
    for (let i = 0; i < 10; i++) engine.onBoxLaneHeartbeat();

    const d = engine.operationalReadiness();
    assert.ok(
      d.evidence.market_data_depth_age_ms >= depthAgeBefore,
      "the DEPTH clock must not be rewound by keep-alive traffic",
    );
    assert.equal(
      d.market_data.depth_observations,
      1,
      "ten heartbeats produced exactly zero additional depth observations",
    );
  } finally {
    engine.dispose?.();
  }
});

/* ═════════════════ 3. GENERATION / RECONNECT DISCIPLINE ═════════════════ */

test("a reconnect advances the generation and INVALIDATES the previous executable books", async () => {
  const engine = await makeEngine();
  try {
    declareDesired(engine, [501, 502]);
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([depthTick(501), depthTick(502)]);

    const before = engine.operationalReadiness();
    assert.equal(before.market_data.state, "READY");
    assert.ok(before.market_data.usable_books >= 2);
    const genBefore = before.market_data.generation;

    // The socket drops, then returns.
    engine.onBoxLaneConnection(false);
    let d = engine.operationalReadiness();
    assert.equal(d.market_data.state, "DISCONNECTED");
    assert.equal(d.market_data.socket_connected, false);
    assert.equal(
      d.market_data.usable_books,
      0,
      "books from the dead socket are dropped, not carried across",
    );
    assert.equal(d.entry.permitted, false);
    /*
     * The ESTABLISHED policy for a disconnected market-data feed, preserved exactly:
     * `MARKET_DATA_PERMISSIONS.DISCONNECTED` is
     * `{ newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: false }`
     * — a priced reduction needs a book and there is none, but PROTECTIVE CANCEL always remains, so
     * exposure can still be reduced by cancelling. This suite deliberately does not loosen that.
     */
    assert.equal(d.exposure_management.protective_cancel, true, "cancel always reduces exposure");
    assert.equal(d.exposure_management.manage_working_orders, true);

    engine.onBoxLaneConnection(true);
    d = engine.operationalReadiness();
    assert.ok(d.market_data.generation > genBefore, "the new socket is a new generation");
    assert.equal(d.market_data.state, "SYNCHRONIZING", "and must re-earn READY from fresh depth");
    assert.equal(d.market_data.depth_observations, 0, "prior-generation depth is not evidence");
    assert.equal(d.market_data.usable_for_entry, false);

    // Fresh depth in the NEW generation restores readiness.
    engine.ingestBoxLaneTicks([depthTick(501)]);
    d = engine.operationalReadiness();
    assert.equal(d.market_data.state, "READY");
    assert.equal(d.market_data.usable_for_entry, true);
  } finally {
    engine.dispose?.();
  }
});

test("token replacement RECOVERS the feed from a terminal expired session", async () => {
  const engine = await makeEngine();
  try {
    declareDesired(engine, [601]);
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([depthTick(601)]);
    assert.equal(engine.operationalReadiness().market_data.state, "READY");

    // The broker rejects the token.
    engine.onMarketDataSessionLost("Kite feed rejected the session (close code 1008)");
    let d = engine.operationalReadiness();
    assert.equal(d.market_data.state, "AUTH_EXPIRED");

    // No amount of DATA may revive it — a tick on a rejected socket proves nothing.
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([depthTick(601)]);
    engine.onBoxLaneHeartbeat();
    assert.equal(
      engine.operationalReadiness().market_data.state,
      "AUTH_EXPIRED",
      "data cannot vouch for a credential the broker already refused",
    );

    // A REPLACEMENT credential can, because it comes from the auth path.
    engine.onMarketDataSessionRestored("operator signed in again");
    d = engine.operationalReadiness();
    assert.equal(d.market_data.state, "DISCONNECTED", "recovered, but not optimistically ready");
    assert.equal(d.market_data.usable_for_entry, false);

    // And the feed genuinely works again after reconnecting.
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([depthTick(601)]);
    d = engine.operationalReadiness();
    assert.equal(d.market_data.state, "READY", "the replacement token restored the feed");
    assert.equal(
      d.exposure_management.exit_and_reduce,
      true,
      "and a READY feed can price a reduction again",
    );
  } finally {
    engine.dispose?.();
  }
});

test("a RECONNECTABLE transport fault is never reported as an expired session", async () => {
  const engine = await makeEngine();
  try {
    declareDesired(engine, [701]);
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([depthTick(701)]);

    engine.onBoxLaneTransportFault("Kite WebSocket error.");

    const d = engine.operationalReadiness();
    assert.notEqual(
      d.market_data.state,
      "AUTH_EXPIRED",
      "a network blip must NOT be escalated to token death",
    );
    // Exposure management stays available: that is the whole point of the distinction.
    assert.equal(d.exposure_management.exit_and_reduce, true);
    assert.equal(d.exposure_management.protective_cancel, true);
  } finally {
    engine.dispose?.();
  }
});

/* ═════════════════ 4. PAPER EXECUTION IS SIMULATED, AND SAID TO BE ═════════════════ */

test("paper fills are labelled SIMULATED, and the order stream is not-applicable rather than broken", async () => {
  const engine = await makeEngine();
  try {
    declareDesired(engine, [801]);
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([depthTick(801)]);

    const status = engine.getStatus();
    const active = status.order_stream.brokers.find((b) => b.broker === "zerodha");
    assert.equal(
      active.wiring,
      "not_applicable_paper",
      "paper builds no consumer BY DESIGN — that is not `not_wired`",
    );
    assert.equal(active.fills_observed_by, "simulated_paper_fills");
    assert.doesNotMatch(
      active.detail,
      /REST polling only/,
      "nothing is polled for an order that was never sent",
    );
    assert.match(active.detail, /NOT APPLICABLE|not applicable/);
    assert.equal(status.order_stream.any_stream_live, false);

    const d = engine.operationalReadiness();
    assert.equal(d.paper_execution.simulated, true);
    assert.equal(d.paper_execution.profile, "paper_latency");
    assert.equal(d.paper_execution.using_streamed_quotes, true, "there IS depth evidence");
    assert.match(
      d.paper_execution.detail,
      /Real broker WebSocket quotes · simulated execution/,
      "the claim is made ONLY because real ticks were observed",
    );
    assert.equal(d.fill_observation.mechanism, "simulated_paper_fills");
    assert.equal(d.fill_observation.stream_assisted, false);
  } finally {
    engine.dispose?.();
  }
});

test("the streamed-quote claim is WITHHELD until a tick actually arrives", async () => {
  const engine = await makeEngine();
  try {
    declareDesired(engine, [901]);
    engine.onBoxLaneConnection(true); // connected, but nothing has ticked

    const d = engine.operationalReadiness();
    assert.equal(d.paper_execution.simulated, true);
    assert.equal(d.paper_execution.using_streamed_quotes, false);
    assert.doesNotMatch(
      d.paper_execution.detail,
      /Real broker WebSocket quotes/,
      "an open socket must not license the streamed-quotes claim",
    );
    assert.match(d.paper_execution.detail, /NO tick has been observed/);
  } finally {
    engine.dispose?.();
  }
});

test("PAPER SAFETY: no live order manager or live adapter exists at all", async () => {
  // The structural guarantee behind "paper cannot touch a real order": the objects capable of it
  // are never constructed. Asserted on the real engine instance, not by reading the source.
  const engine = await makeEngine();
  try {
    assert.equal(engine.orderManager ?? null, null, "no order manager in paper");
    assert.equal(engine.liveAdapter ?? null, null, "no live broker adapter in paper");
    assert.equal(engine.orderStreamConsumer ?? null, null, "no order-stream consumer in paper");
    assert.equal(engine.dhanOrderFeed ?? null, null, "no Dhan order socket in paper");

    // And driving the full market-data path does not bring any of them into existence.
    declareDesired(engine, [1001]);
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([depthTick(1001)]);
    engine.onBoxLaneHeartbeat();
    engine.operationalReadiness();
    engine.getStatus();

    assert.equal(engine.orderManager ?? null, null, "still no order manager after real ticks");
    assert.equal(engine.liveAdapter ?? null, null, "still no live adapter after real ticks");
    assert.equal(
      engine.orderStreamConsumer ?? null,
      null,
      "obtaining WebSocket status must NOT construct an order-stream consumer",
    );
  } finally {
    engine.dispose?.();
  }
});

/* ═════════════════ 5. THE RED EXPOSURE WARNING ═════════════════ */

test("paper never reports exposure management as blocked merely because live readiness is off", async () => {
  /*
   * THE REGRESSION GUARD for the red exposure warning. With the machine DISABLED,
   * `marketDataEntryBlocker("DISABLED")` returns scope `both` — so a paper deployment reported
   * "REDUCING exposure is currently blocked" purely because live-order readiness was off, which is
   * both false and alarming.
   */
  const engine = await makeEngine();
  try {
    declareDesired(engine, [1101]);
    engine.onBoxLaneConnection(true);
    engine.ingestBoxLaneTicks([depthTick(1101)]);

    const d = engine.operationalReadiness();
    assert.equal(d.identity.execution_mode, "paper_latency");
    assert.equal(d.identity.deployment_live_capable, false, "live is genuinely NOT armed");

    assert.equal(d.exposure_management.exit_and_reduce, true);
    assert.equal(d.exposure_management.protective_cancel, true);
    assert.equal(d.exposure_management.manage_working_orders, true);
    assert.deepEqual(
      d.exposure_management.blocked_reasons,
      [],
      "no reduction blocker may come from live readiness being off",
    );
    // No blocker anywhere may carry the not-configured code now that market data is armed.
    const codes = [...d.entry.reasons, ...d.exposure_management.blocked_reasons].map((r) => r.code);
    assert.ok(
      !codes.includes("market_data_not_configured"),
      `market data is configured in paper (got ${codes.join(", ")})`,
    );
  } finally {
    engine.dispose?.();
  }
});

test("a GENUINE feed fault still blocks entry in paper — the fix does not hardcode green", async () => {
  // The counterweight to every test above: arming the machine must not make paper look healthy
  // when it is not.
  const engine = await makeEngine();
  try {
    declareDesired(engine, [1201]);
    // Never connected, never a tick.
    const d = engine.operationalReadiness();
    assert.equal(d.market_data.state, "DISCONNECTED");
    assert.equal(d.market_data.usable_for_entry, false);
    assert.equal(d.entry.permitted, false, "a dead feed must refuse entry in paper too");
    assert.ok(
      d.entry.reasons.some((r) => String(r.code).startsWith("market_data")),
      "and it must SAY the market data is the reason",
    );
    assert.equal(d.market_data.source, "none", "no socket and no fallback ⇒ no source");
    assert.equal(d.market_data.ticks_observed, false);
  } finally {
    engine.dispose?.();
  }
});
