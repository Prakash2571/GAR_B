/**
 * THE ZERODHA UNIVERSE, THROUGH THE REAL COMPOSITION — the test that would have caught the bug.
 *
 * THE DEFECT
 *
 * `ActiveBrokerManager.instruments()` contained:
 *
 * ```ts
 * if (this.active === "zerodha") return [];
 * const rows = await this.dhanInstruments.load();
 * ```
 *
 * and `src/index.ts` feeds BOTH of the box engine's universe dependencies from it:
 *
 * ```ts
 * getAllInstruments: () => brokerManager.instruments(),
 * getBoard: async () => deriveFnoBoard(await brokerManager.instruments()),
 * ```
 *
 * So with Zerodha active — production — the engine got an empty dump and everything downstream
 * collapsed in order and in silence: no board rows, no chains, no ATM windows, no candidates, no
 * desired subscriptions, and therefore NO BOX SOCKET AT ALL, because the box lane is constructed
 * lazily on the first subscription. The dashboard read `SCANNING` with zero underlyings.
 *
 * WHY THE EXISTING PAPER TESTS DID NOT CATCH IT
 *
 * They hand ticks straight to `engine.ingestBoxLaneTicks(...)` and supply
 * `getAllInstruments: async () => []`. That is a perfectly reasonable way to test the INGESTION
 * half, but it hardcodes the very value that was the bug — so it could never fail because of it,
 * and it proves nothing about whether startup can create a subscription.
 *
 * WHAT THIS SUITE DOES INSTEAD
 *
 * It builds the REAL `ActiveBrokerManager` (with its REAL `InstrumentProvider`), wires a REAL
 * `BoxEngine` to it EXACTLY as `src/index.ts` does, puts a fake `WebSocket` under the box lane, and
 * asserts on what actually reaches the wire. Nothing is hand-delivered: the subscribe frames and the
 * ticks travel the production path.
 *
 * The two things it will not do: it cannot call `engine.start()` (that requires PostgreSQL via
 * `isBoxDbEnabled()`), so discovery is switched on directly and `refreshUniverse()` is driven — the
 * composition under test is unchanged. And it is FIXTURE data, not a real broker: it proves the
 * wiring, never the live handshake.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");

/*
 * STOCK UNDERLYINGS ARE ENABLED FOR THIS SUITE.
 *
 * This suite exists to prove the universe PLUMBING — instruments → board → chains → windows →
 * candidates → subscriptions → socket → ticks — and its fixture deliberately carries one index
 * (NIFTY) and one stock (RELIANCE) so the board/chain join is exercised on both shapes.
 *
 * Stocks are excluded from the universe by DEFAULT in production (`BOX_ALLOW_STOCK_UNDERLYINGS=false`)
 * because stock options are PHYSICALLY settled and neither the delivery obligation nor NSE's
 * physical-delivery margin ramp is modelled in the capital layer. That policy is asserted separately,
 * in the "stock underlyings" tests at the bottom of this file. Opting in here keeps the plumbing
 * coverage on two underlyings instead of silently narrowing it to one.
 */
process.env.BOX_ALLOW_STOCK_UNDERLYINGS = "1";

/* ───────────────────────── realistic instrument fixtures ───────────────────────── */

/**
 * A miniature but STRUCTURALLY REAL Zerodha dump.
 *
 * It must satisfy all three consumers of one array, which is the integration constraint the bug hid:
 *   - `deriveFnoBoard` needs NFO `FUT` rows (grouped by `name`) joined to a spot row — `NSE`/`EQ`
 *     for a stock, or a `segment: "INDICES"` row for an index;
 *   - `indexOptionChains` needs NFO `CE`/`PE` rows with the SAME `name`, a non-expired
 *     `YYYY-MM-DD` expiry, a positive strike and a positive lot size;
 *   - `makeIdResolver` needs the spot rows present so `spot_token` can become `NSE:RELIANCE` for the
 *     REST spot seed.
 */
function zerodhaDump({ expiry = "2026-09-24", lotMismatch = false } = {}) {
  const rows = [];
  const push = (o) =>
    rows.push({
      instrument_token: 0,
      exchange_token: 0,
      tradingsymbol: "",
      name: "",
      last_price: 0,
      expiry: "",
      strike: 0,
      tick_size: 0.05,
      lot_size: 0,
      instrument_type: "",
      segment: "",
      exchange: "",
      ...o,
    });

  // Spot rows: one INDEX (via the INDICES segment) and one EQUITY.
  push({ instrument_token: 256265, tradingsymbol: "NIFTY 50", name: "NIFTY 50", segment: "INDICES", exchange: "NSE", instrument_type: "EQ" });
  push({ instrument_token: 738561, tradingsymbol: "RELIANCE", name: "RELIANCE INDUSTRIES LTD", segment: "NSE", exchange: "NSE", instrument_type: "EQ" });

  // Futures rows: REQUIRED, because deriveFnoBoard iterates them to build the board.
  push({ instrument_token: 11, tradingsymbol: "NIFTY26SEPFUT", name: "NIFTY", exchange: "NFO", segment: "NFO-FUT", instrument_type: "FUT", expiry, lot_size: 75 });
  push({ instrument_token: 12, tradingsymbol: "RELIANCE26SEPFUT", name: "RELIANCE", exchange: "NFO", segment: "NFO-FUT", instrument_type: "FUT", expiry, lot_size: 500 });

  // Option chains: 7 strikes each side-by-side CE/PE, so a box has pairs to form.
  let token = 5000;
  for (const [name, base, step, lot] of [
    ["NIFTY", 24500, 50, 75],
    ["RELIANCE", 1400, 20, 500],
  ]) {
    for (let k = -3; k <= 3; k++) {
      const strike = base + k * step;
      for (const type of ["CE", "PE"]) {
        // `lotMismatch` deliberately corrupts ONE leg's lot size, which is how a real post-revision
        // expiry silently drops candidate pairs via singleLotLegViolation.
        const thisLot = lotMismatch && k === 0 && type === "PE" ? lot * 2 : lot;
        push({
          instrument_token: token++,
          tradingsymbol: `${name}26SEP${strike}${type}`,
          name,
          exchange: "NFO",
          segment: "NFO-OPT",
          instrument_type: type,
          expiry,
          strike,
          lot_size: thisLot,
        });
      }
    }
  }
  return rows;
}

/** A Dhan dump in the same internal shape (dhan/instruments.ts normalises to this). */
function dhanDump() {
  return zerodhaDump().map((r) => ({ ...r, instrument_token: r.instrument_token + 900_000 }));
}

/* ───────────────────────── fake transport ───────────────────────── */

class FakeWebSocket {
  static instances = [];
  static reset() {
    FakeWebSocket.instances = [];
  }
  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
  constructor(url) {
    this.url = url;
    this.binaryType = "";
    this.sent = [];
    this.closed = false;
    this.onopen = this.onclose = this.onerror = this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }
  send(p) {
    this.sent.push(p);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  closeWith(code = 1006) {
    this.onclose?.({ code });
  }
  /** Every JSON message written to this socket. */
  messages() {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** Tokens this socket was asked to subscribe, across all frames. */
  subscribedTokens() {
    const out = new Set();
    for (const m of this.messages()) if (m.a === "subscribe") for (const t of m.v) out.add(t);
    return out;
  }
  /** Tokens for which FULL depth mode was requested. */
  fullModeTokens() {
    const out = new Set();
    for (const m of this.messages()) {
      if (m.a === "mode" && m.v?.[0] === "full") for (const t of m.v[1]) out.add(t);
    }
    return out;
  }
  /** A Kite binary tick frame carrying a full 184-byte depth packet. */
  depthTick(token, bid = 100, ask = 100.5) {
    const P = 184;
    const buf = new ArrayBuffer(4 + P);
    const v = new DataView(buf);
    v.setInt16(0, 1, false);
    v.setInt16(2, P, false);
    const p = 4;
    v.setUint32(p, token, false);
    v.setInt32(p + 4, Math.round(((bid + ask) / 2) * 100), false);
    v.setInt32(p + 40, Math.round(bid * 100), false);
    v.setInt32(p + 48, 1234, false);
    v.setUint32(p + 60, Math.floor(Date.now() / 1000), false);
    for (let i = 0; i < 5; i++) {
      const at = p + 64 + i * 12;
      v.setInt32(at, 500, false);
      v.setInt32(at + 4, Math.round((bid - i * 0.5) * 100), false);
      v.setInt16(at + 8, 3, false);
    }
    for (let i = 0; i < 5; i++) {
      const at = p + 124 + i * 12;
      v.setInt32(at, 500, false);
      v.setInt32(at + 4, Math.round((ask + i * 0.5) * 100), false);
      v.setInt16(at + 8, 3, false);
    }
    this.onmessage?.({ data: buf });
  }
  heartbeat() {
    this.onmessage?.({ data: new ArrayBuffer(1) });
  }
}

/**
 * Install the fake transport for the duration of an ASYNC body.
 *
 * `await fn(...)` rather than `return fn(...)`: with a bare return the `finally` runs as soon as the
 * body's promise is created, uninstalling `globalThis.WebSocket` before the first `await` inside it
 * resolves — so the production code would construct a REAL WebSocket and the fixture would see no
 * socket at all. This whole suite is asynchronous, so the distinction is load-bearing.
 *
 * `setTimeout` is captured too, so the reconnect backoff can be asserted exactly instead of waited
 * for. Note the engine's own timers are `unref`ed intervals, which are unaffected.
 */
async function withFakeSockets(fn) {
  const prevWs = globalThis.WebSocket;
  const prevST = globalThis.setTimeout;
  const timers = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.setTimeout = (cb, ms) => {
    const h = { cb, ms, unref: () => h };
    timers.push(h);
    return h;
  };
  FakeWebSocket.reset();
  try {
    return await fn({
      timers,
      runNextTimer: () => {
        const t = timers.shift();
        assert.ok(t, "expected a scheduled timer");
        t.cb();
        return t;
      },
    });
  } finally {
    globalThis.WebSocket = prevWs;
    globalThis.setTimeout = prevST;
    FakeWebSocket.reset();
  }
}

/* ───────────────────────── the real composition ───────────────────────── */

/** A ticker-hub stub. The SHARED lane, which must stay irrelevant to the box lane. */
function stubHub() {
  return {
    addTickListener: () => () => {},
    addConnectionListener: () => () => {},
    retain: () => () => {},
    seed: () => {},
    ingestExternalTicks: () => {},
    setExternalConnected: () => {},
    getLatestTick: () => null,
    subscribeTokens: () => {},
    unsubscribeTokens: () => {},
    subscribedCount: () => 0,
    isConnected: () => false,
  };
}

/**
 * Build the REAL ActiveBrokerManager, and a REAL BoxEngine wired to it exactly as src/index.ts does.
 *
 * `spies` records which broker APIs were actually reached, which is how "the provider was invoked"
 * and "Dhan was never touched" become assertions rather than assumptions.
 */
async function buildComposition({
  active = "zerodha",
  kiteInstruments,
  dhanInstruments,
  spotPrices = { 256265: 24_500, 738561: 1_400 },
  quoteFullThrows = null,
} = {}) {
  const { ActiveBrokerManager } = await import(`${DIST}/brokers/registry.js`);
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const { deriveFnoBoard, makeIdResolver, istDayKey } = await import(`${DIST}/boxSupport.js`);

  const spies = { kiteGetInstruments: 0, dhanLoad: 0, getQuoteFull: 0, kiteQuote: 0 };

  const kite = {
    getApiKey: () => "test-api-key",
    getAccessToken: () => "test-access-token",
    clearSession: () => {},
    installProvidedToken: () => {},
    getInstruments: async () => {
      spies.kiteGetInstruments++;
      if (typeof kiteInstruments === "function") return kiteInstruments();
      return kiteInstruments ?? [];
    },
    // A THROWING SPY. Case B requires that the Dhan path never depends on these.
    getQuoteFull: async () => {
      spies.kiteQuote++;
      throw new Error("kite.getQuoteFull must not be reached on the Dhan path");
    },
    getBasketMargin: async () => ({}),
  };

  const saved = process.env.DEFAULT_ACTIVE_BROKER;
  process.env.DEFAULT_ACTIVE_BROKER = active;
  let manager;
  try {
    manager = new ActiveBrokerManager({
      kite,
      tickerHub: stubHub(),
      boxConfig: () => ({}),
      istDayKey: () => "2026-09-15",
      zerodhaCredentials: () => ({ apiKey: "test-api-key", accessToken: "test-access-token" }),
      onBoxLaneTicks: (ticks) => {
        manager.noteTick();
        engine.ingestBoxLaneTicks(ticks);
      },
      onBoxLaneConnection: (c) => engine.onBoxLaneConnection(c),
      onBoxLaneHeartbeat: () => engine.onBoxLaneHeartbeat(),
      onBoxLaneTransportFault: (r) => engine.onBoxLaneTransportFault(r),
      onBoxLaneSessionLost: (r) => engine.onMarketDataSessionLost(r),
      onDhanTicks: () => {},
      onDhanConnection: () => {},
      onSessionLost: () => {},
    });
  } finally {
    if (saved === undefined) delete process.env.DEFAULT_ACTIVE_BROKER;
    else process.env.DEFAULT_ACTIVE_BROKER = saved;
  }

  // Replace the Dhan instrument store's loader with a spy, keeping the real object graph.
  const dhanStore = manager.dhanInstrumentStore;
  dhanStore.load = async () => {
    spies.dhanLoad++;
    if (typeof dhanInstruments === "function") return dhanInstruments();
    if (dhanInstruments === undefined) throw new Error("DHAN MUST NOT BE LOADED on the Zerodha path");
    return dhanInstruments;
  };

  // EXACTLY the wiring in src/index.ts — this is the point of the suite.
  const engine = new BoxEngine({
    marketData: {
      isAuthenticated: () => true,
      getQuoteFull: async (ids) => {
        spies.getQuoteFull++;
        if (quoteFullThrows) throw new Error(quoteFullThrows);
        const resolveBack = new Map();
        for (const [token, price] of Object.entries(spotPrices)) resolveBack.set(Number(token), price);
        // Mirror the real REST shape: rows keyed by instrument_token with a last_price.
        return [...resolveBack.entries()]
          .filter(([token]) => ids.some((s) => typeof s === "string"))
          .map(([token, last_price]) => ({ instrument_token: token, last_price }));
      },
    },
    activeBroker: () => manager.activeBroker,
    feed: {
      addTickListener: () => () => {},
      addConnectionListener: () => () => {},
      retain: () => () => {},
      subscribeTokens: () => {},
      unsubscribeTokens: () => {},
      setStrategyTokens: () => {},
      // THE LOAD-BEARING WIRE: the engine's desired box tokens go to the real manager, which
      // refcounts them and lazily constructs the real box-lane socket.
      setBoxTokens: (tokens) => manager.setBoxTokens(tokens),
      subscribedCount: () => 0,
      isConnected: () => false,
    },
    charges: { broker: active, rateVersion: "test", estimate: () => null },
    getAllInstruments: () => manager.instruments(),
    getBoard: async () => deriveFnoBoard(await manager.instruments()),
    priceChargeGroups: async () => null,
    istDayKey: () => "2026-09-15",
    makeIdResolver,
    isMarketOpen: () => true,
    margins: {
      broker: active,
      basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }),
    },
    brokerAccountRef: () => "AB1234",
  });

  return { manager, engine, spies, kite };
}

/**
 * Turn discovery ON.
 *
 * `start()` cannot be used: it requires PostgreSQL through `isBoxDbEnabled()`. Only the operator's
 * RUN flag is set — every stage this suite exercises (instruments → board → chains → windows →
 * candidates → subscriptions → socket → ticks) runs unchanged.
 */
function startDiscovery(engine) {
  engine.running = true;
  engine.marketOpen = true;
  engine.scanner.setMarketOpen(true);
}

/* ═══════════════════ A. THE ZERODHA UNIVERSE ═══════════════════ */

test("A: an authenticated Zerodha returns its instruments through ActiveBrokerManager.instruments()", async () => {
  const { manager, spies } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });

  const rows = await manager.instruments();

  // THE ASSERTION THE OLD CODE FAILS. `if (this.active === "zerodha") return []` makes this zero.
  assert.ok(
    rows.length > 0,
    "Zerodha must receive a real instrument universe — a hardcoded `return []` fails here, which is " +
      "precisely the bug that starved the board, the chains, the windows and the subscriptions",
  );
  assert.equal(rows.length, zerodhaDump().length);
  assert.equal(manager.activeBroker, "zerodha");

  // The PROVIDER was actually used, not a bypass.
  assert.equal(spies.kiteGetInstruments, 1, "the instrument provider invoked the Kite loader");
  assert.equal(spies.dhanLoad, 0, "the Dhan store must never be touched on the Zerodha path");

  // The dump really does satisfy all three consumers.
  assert.ok(rows.some((r) => r.exchange === "NFO" && r.instrument_type === "FUT"), "has futures");
  assert.ok(rows.some((r) => r.exchange === "NFO" && r.instrument_type === "CE"), "has calls");
  assert.ok(rows.some((r) => r.segment === "INDICES"), "has an index spot row");
  assert.ok(rows.some((r) => r.exchange === "NSE" && r.instrument_type === "EQ"), "has an equity spot row");
});

test("A: concurrent universe/board requests share ONE download (provider dedup, not a new cache)", async () => {
  const { manager, spies } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });

  // This is the real call pattern: refreshUniverse does Promise.all([getAllInstruments(), getBoard()]).
  const [a, b, c] = await Promise.all([manager.instruments(), manager.instruments(), manager.instruments()]);

  assert.equal(spies.kiteGetInstruments, 1, "three concurrent callers, ONE multi-megabyte download");
  assert.equal(a.length, b.length);
  assert.equal(b.length, c.length);

  // And a later call is served from the provider's cache rather than re-downloading.
  await manager.instruments();
  assert.equal(spies.kiteGetInstruments, 1, "the cached dump is reused");
});

test("A: an instrument-load FAILURE propagates instead of becoming a silently empty universe", async () => {
  let fail = true;
  const { manager } = await buildComposition({
    active: "zerodha",
    kiteInstruments: () => {
      if (fail) throw new Error("HTTP 503 from the instruments endpoint");
      return zerodhaDump();
    },
  });

  await assert.rejects(
    () => manager.instruments(),
    /503/,
    "a failed load must REJECT — returning [] is what made this invisible",
  );

  // And it recovers without any intervention once the broker is healthy again.
  fail = false;
  const rows = await manager.instruments();
  assert.ok(rows.length > 0, "the next call succeeds; no restart or token regeneration needed");
});

/* ═══════════════════ B. DHAN ISOLATION ═══════════════════ */

test("B: an active Dhan returns DHAN instruments, and the Kite APIs can be poisoned", async () => {
  const { manager, engine, spies, kite } = await buildComposition({
    active: "dhan",
    // Poison the Kite loader outright: the Dhan path must not depend on it in any way.
    kiteInstruments: () => {
      throw new Error("kite.getInstruments must not be reached on the Dhan path");
    },
    dhanInstruments: dhanDump(),
  });
  // Belt and braces: make every Kite instrument/quote entry point throw.
  kite.getInstruments = async () => {
    throw new Error("kite.getInstruments must not be reached on the Dhan path");
  };

  assert.equal(manager.activeBroker, "dhan");
  const rows = await manager.instruments();

  assert.ok(rows.length > 0, "Dhan receives its own universe");
  assert.equal(spies.dhanLoad, 1, "through the Dhan store");
  assert.equal(spies.kiteGetInstruments, 0, "and the Kite loader was never called");
  assert.equal(spies.kiteQuote, 0);
  // Dhan tokens live in their own namespace.
  assert.ok(rows.every((r) => r.instrument_token >= 900_000), "Dhan tokens, not Kite tokens");
  engine.dispose?.();
});

/* ═══════════════════ C. STARTUP CREATES REAL SUBSCRIPTIONS ═══════════════════ */

test("C: startup builds board, chains, windows and candidates, and SUBSCRIBES on the real box socket", async () => {
  await withFakeSockets(async () => {
    const { manager, engine, spies } = await buildComposition({
      active: "zerodha",
      kiteInstruments: zerodhaDump(),
    });
    try {
      startDiscovery(engine);

      // Before: nothing has been asked for and no socket exists.
      assert.equal(FakeWebSocket.instances.length, 0, "no box socket before any subscription");
      assert.equal(engine.getStatus().universe.stage, "instruments_never_loaded");

      // THE PRODUCTION UNIVERSE PASS.
      await engine.refreshUniverse();

      const s = engine.getStatus();
      const u = s.universe;

      // Every stage of the pipeline produced something.
      assert.ok(u.counts.instruments > 0, "instruments loaded");
      assert.equal(u.instrument_load, "loaded");
      assert.equal(u.counts.board_rows, 2, "NIFTY + RELIANCE board rows");
      assert.equal(u.counts.chains_indexed, 2, "both option chains indexed");
      assert.equal(u.counts.board_with_chains, 2, "and the board joined the chains");
      assert.equal(u.counts.underlyings_missing_spot, 0, "spots were seeded over REST");
      assert.ok(spies.getQuoteFull >= 1, "the REST spot seed really ran");

      assert.equal(s.underlyings, 2, "two ATM windows were built");
      assert.ok(s.candidates > 0, `candidates were created (got ${s.candidates})`);
      assert.ok(
        s.subscribed_option_tokens > 0,
        `desired option subscriptions must be non-zero (got ${s.subscribed_option_tokens})`,
      );

      /*
       * THE HEART OF IT: a real socket was constructed and real subscribe frames went out.
       * With the old `return []` there was nothing to subscribe, so no socket was ever created.
       */
      const ws = FakeWebSocket.last;
      assert.ok(ws, "the box-lane socket was CONSTRUCTED as a consequence of a real subscription");
      assert.match(ws.url, /^wss:\/\/ws\.kite\.trade\?api_key=test-api-key/);
      ws.open();

      const subscribed = ws.subscribedTokens();
      const full = ws.fullModeTokens();
      assert.ok(subscribed.size > 0, "subscribe frames reached the transport");
      assert.equal(
        full.size,
        subscribed.size,
        "FULL depth mode was requested for every subscribed token — paper prices on the same ladder as live",
      );

      // The tokens are the engine's actual option legs, not an arbitrary set.
      const optionTokens = zerodhaDump()
        .filter((r) => r.instrument_type === "CE" || r.instrument_type === "PE")
        .map((r) => r.instrument_token);
      const subscribedOptions = [...subscribed].filter((t) => optionTokens.includes(t));
      assert.ok(subscribedOptions.length > 0, "real option legs are on the wire");
      // And the spot tokens are there too, so the ATM window can stay centred.
      assert.ok(subscribed.has(256265) || subscribed.has(738561), "spot tokens are subscribed");
    } finally {
      engine.dispose?.();
    }
  });
});

test("C: delivered frames flow through parsing into the engine, and evaluation begins", async () => {
  await withFakeSockets(async () => {
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();

      const ws = FakeWebSocket.last;
      ws.open();
      const before = engine.getStatus();
      assert.equal(before.universe.counts.frames_observed, 0, "no frame yet");
      assert.equal(before.universe.stage, "awaiting_first_tick");
      assert.equal(before.quote_updates, 0);

      // Deliver REAL binary frames on the REAL socket for the tokens the engine subscribed.
      const subscribed = [...ws.subscribedTokens()];
      const optionTokens = new Set(
        zerodhaDump()
          .filter((r) => r.instrument_type === "CE" || r.instrument_type === "PE")
          .map((r) => r.instrument_token),
      );
      const legs = subscribed.filter((t) => optionTokens.has(t)).slice(0, 8);
      assert.ok(legs.length >= 4, "a box needs four legs to evaluate");
      for (const t of legs) ws.depthTick(t, 100, 100.5);

      const after = engine.getStatus();
      assert.ok(after.universe.counts.frames_observed > 0, "frames were observed");
      assert.ok(after.universe.counts.depth_observations > 0, "usable depth was observed");
      assert.ok(after.quotes > 0, `the quote store filled (got ${after.quotes})`);
      assert.ok(after.quote_updates > 0, `quote_updates increased (got ${after.quote_updates})`);
      assert.ok(after.universe.counts.usable_books > 0, "executable books exist");
      assert.equal(
        after.universe.stage,
        "evaluating",
        `the pipeline is complete end to end (detail: ${after.universe.detail})`,
      );
      assert.equal(after.universe.readyToEvaluate, true);
      assert.equal(after.market_data_state, "READY");
      assert.equal(after.box_lane_connected, true);
    } finally {
      engine.dispose?.();
    }
  });
});

/* ═══════════════════ D. FAILURE AND RECOVERY ═══════════════════ */

test("D: an instrument download failure is DIAGNOSED, then recovers on its own", async () => {
  await withFakeSockets(async () => {
    let fail = true;
    const { engine } = await buildComposition({
      active: "zerodha",
      kiteInstruments: () => {
        if (fail) throw new Error("HTTP 503 from the instruments endpoint");
        return zerodhaDump();
      },
    });
    try {
      startDiscovery(engine);
      await assert.rejects(() => engine.refreshUniverse(), /503/);

      let u = engine.getStatus().universe;
      assert.equal(u.stage, "instruments_failed", "the blocking stage is named");
      assert.equal(u.instrument_load, "failed");
      assert.match(u.instruments_error, /503/, "with the broker's OWN message, verbatim");
      assert.ok(u.instrument_load_failures >= 1);
      assert.equal(u.readyToEvaluate, false);
      assert.equal(u.transient, false, "a failed load needs investigation, not patience");
      assert.match(u.detail, /instrument master could not be loaded/);

      // Recovery needs no click, no restart, no new token.
      fail = false;
      await engine.refreshUniverse();
      u = engine.getStatus().universe;
      assert.equal(u.instrument_load, "loaded");
      assert.equal(u.instruments_error, null, "the stale error is cleared");
      assert.equal(u.instrument_load_failures, 0, "and the failure counter resets");
      assert.ok(u.counts.board_rows > 0);
    } finally {
      engine.dispose?.();
    }
  });
});

test("D: an EMPTY instrument master is diagnosed as empty, not as a quiet market", async () => {
  await withFakeSockets(async () => {
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: [] });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();

      const u = engine.getStatus().universe;
      // THE ORIGINAL BUG'S SIGNATURE. It must be nameable, not a bare `underlyings: 0`.
      assert.equal(u.stage, "instruments_empty");
      assert.equal(u.instrument_load, "loaded", "the load SUCCEEDED — that is what made it invisible");
      assert.equal(u.counts.instruments, 0);
      assert.equal(u.readyToEvaluate, false);
      assert.match(u.detail, /ZERO rows/);
      assert.match(u.detail, /broker or endpoint problem/);
      assert.equal(engine.getStatus().underlyings, 0);
    } finally {
      engine.dispose?.();
    }
  });
});

test("D: an unresolved SPOT is diagnosed as awaiting prices, with the REST failure attached", async () => {
  await withFakeSockets(async () => {
    const { engine } = await buildComposition({
      active: "zerodha",
      kiteInstruments: zerodhaDump(),
      quoteFullThrows: "HTTP 500 from the quote endpoint",
    });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();

      const u = engine.getStatus().universe;
      assert.equal(u.counts.board_with_chains, 2, "the universe itself is fine");
      assert.equal(u.counts.windows_built, 0, "but no window could be centred");
      assert.equal(u.stage, "awaiting_spot_prices");
      assert.equal(u.spot_seed_failed, true, "the seed failure is PUBLISHED, not just logged");
      assert.match(u.spot_seed_error, /HTTP 500/);
      assert.match(u.detail, /HTTP 500/, "and the reason reaches the operator");
      assert.ok(u.counts.underlyings_missing_spot > 0);
      // The circular dependency is named in the detail so nobody re-derives it.
      assert.match(u.detail, /seeded over REST/);
    } finally {
      engine.dispose?.();
    }
  });
});

test("D: a connected socket with NO depth, and heartbeat-only traffic, never reaches `evaluating`", async () => {
  await withFakeSockets(async () => {
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();
      const ws = FakeWebSocket.last;
      ws.open();

      for (let i = 0; i < 20; i++) ws.heartbeat();

      const u = engine.getStatus().universe;
      assert.ok(u.counts.frames_observed > 0, "the keep-alives WERE observed");
      assert.equal(u.counts.depth_observations, 0, "but none of them is a book");
      assert.equal(u.counts.usable_books, 0);
      assert.equal(u.stage, "awaiting_usable_depth");
      assert.equal(u.readyToEvaluate, false, "heartbeats must never qualify a candidate");
      assert.match(u.detail, /LTP-only packet keeps the transport alive/);
    } finally {
      engine.dispose?.();
    }
  });
});

test("D: a reconnect RESTORES subscriptions and rejects the previous generation's books", async () => {
  await withFakeSockets(async ({ runNextTimer }) => {
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();
      const first = FakeWebSocket.last;
      first.open();
      const legs = [...first.subscribedTokens()].slice(0, 6);
      for (const t of legs) first.depthTick(t);
      assert.ok(engine.getStatus().quotes > 0, "books exist before the drop");
      const genBefore = engine.getStatus().operational_readiness.market_data.generation;

      first.closeWith(1006);
      assert.equal(engine.getStatus().quotes, 0, "old-generation books are invalidated, not reused");

      runNextTimer();
      const second = FakeWebSocket.last;
      assert.notEqual(second, first, "a new socket");
      second.open();

      // Subscriptions restored on the NEW socket, in full depth mode.
      assert.ok(second.subscribedTokens().size > 0, "the wanted set was resubscribed");
      assert.equal(second.fullModeTokens().size, second.subscribedTokens().size, "depth mode re-armed");

      const after = engine.getStatus();
      assert.ok(
        after.operational_readiness.market_data.generation > genBefore,
        "a new socket is a new generation",
      );
      assert.notEqual(after.universe.stage, "evaluating", "not executable until fresh depth arrives");

      for (const t of legs) second.depthTick(t);
      assert.equal(engine.getStatus().universe.stage, "evaluating", "and it recovers");
    } finally {
      engine.dispose?.();
    }
  });
});

test("D: broker switching cannot mix instruments or quotes", async () => {
  await withFakeSockets(async () => {
    const { manager, engine, spies } = await buildComposition({
      active: "zerodha",
      kiteInstruments: zerodhaDump(),
      dhanInstruments: dhanDump(),
    });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();
      // Open the socket: `connectTicker` writes its constructor token list on `onopen`, so nothing is
      // on the wire until then.
      FakeWebSocket.last.open();
      const zerodhaTokens = new Set(FakeWebSocket.last.subscribedTokens());
      assert.ok(zerodhaTokens.size > 0, "Zerodha subscribed real tokens on its own socket");
      assert.ok([...zerodhaTokens].every((t) => t < 900_000), "Kite-namespace tokens");

      // The provider is per-broker, so the Dhan universe is a different set entirely.
      manager.instrumentProvider.invalidate();
      const savedActive = manager.activeBroker;
      assert.equal(savedActive, "zerodha");

      // Load Dhan's universe through the SAME provider by flipping the active broker.
      const dhanRows = await (async () => {
        // `active` is private to the manager; exercise the provider's own broker dispatch, which is
        // the mechanism that guarantees isolation.
        const { InstrumentProvider } = await import(`${DIST}/brokers/instrumentProvider.js`);
        const p = new InstrumentProvider({
          activeBroker: () => "dhan",
          kite: {
            getInstruments: async () => {
              throw new Error("Kite must not be called for Dhan");
            },
          },
          dhanInstruments: { load: async () => dhanDump() },
          generation: () => 1,
        });
        return p.load();
      })();

      assert.ok(dhanRows.every((r) => r.instrument_token >= 900_000), "Dhan tokens only");
      const overlap = dhanRows.filter((r) => zerodhaTokens.has(r.instrument_token));
      assert.equal(overlap.length, 0, "no token appears in both namespaces");
      assert.equal(spies.dhanLoad, 0, "and the Zerodha path never loaded Dhan");
    } finally {
      engine.dispose?.();
    }
  });
});

/* ═══════════════════ E. EXECUTION ISOLATION ═══════════════════ */

test("E: paper mode reaches evaluation from streamed fixtures with ZERO real order mutations", async () => {
  await withFakeSockets(async () => {
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();
      const ws = FakeWebSocket.last;
      ws.open();
      for (const t of [...ws.subscribedTokens()].slice(0, 12)) ws.depthTick(t, 100, 100.5);

      const s = engine.getStatus();
      assert.equal(s.execution_mode, "paper_latency");
      assert.equal(s.universe.stage, "evaluating", "the scanner is genuinely working");

      /*
       * THE STRUCTURAL GUARANTEE: the objects capable of touching a real order do not exist.
       * This is asserted on the live engine instance after the FULL startup path has run — the
       * previous suite could only assert it after hand-delivered ticks.
       */
      assert.equal(engine.orderManager ?? null, null, "no order manager exists in paper");
      assert.equal(engine.liveAdapter ?? null, null, "no live broker adapter exists in paper");
      assert.equal(engine.orderStreamConsumer ?? null, null, "no order-stream consumer exists");
      assert.equal(engine.dhanOrderFeed ?? null, null, "no Dhan order socket exists");

      // Fills are simulated, and labelled as such.
      const d = s.operational_readiness;
      assert.equal(d.paper_execution.simulated, true);
      assert.equal(d.paper_execution.using_streamed_quotes, true, "priced off REAL streamed depth");
      assert.match(d.paper_execution.detail, /Real broker WebSocket quotes · simulated execution/);
      assert.equal(d.fill_observation.mechanism, "simulated_paper_fills");
      for (const b of s.order_stream.brokers) {
        assert.equal(b.wiring, "not_applicable_paper");
        assert.equal(b.fills_observed_by, "simulated_paper_fills");
      }
    } finally {
      engine.dispose?.();
    }
  });
});

/* ═══════════════════ F. STATUS HONESTY ═══════════════════ */

test("F: an authenticated session with a DISCONNECTED box socket is rendered accurately", async () => {
  await withFakeSockets(async () => {
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();
      // The socket exists but has NOT opened, so it is not connected.
      const s = engine.getStatus();
      assert.equal(s.authenticated, true, "the session IS valid");
      assert.equal(s.box_lane_connected, false, "and the box socket is NOT connected");
      assert.equal(
        s.universe.stage,
        "box_socket_disconnected",
        "a valid session is never presented as usable market data",
      );
      assert.ok(s.subscribed_option_tokens > 0, "subscriptions were requested");
      assert.equal(
        s.universe.subscriptions_requested,
        true,
        "a WRITTEN subscribe frame — never claimed as a broker acknowledgement",
      );
      assert.equal(s.universe.counts.depth_observations, 0, "which is why depth is tracked separately");
    } finally {
      engine.dispose?.();
    }
  });
});

test("F: a connected SHARED lane does not imply box readiness", async () => {
  await withFakeSockets(async () => {
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    try {
      // The shared/futures hub reports CONNECTED; the box lane has never opened.
      engine.deps.feed.isConnected = () => true;
      engine.deps.feed.subscribedCount = () => 812;
      startDiscovery(engine);
      await engine.refreshUniverse();

      const s = engine.getStatus();
      assert.equal(s.hub_connected, true, "the shared board lane is up");
      assert.equal(s.box_lane_dedicated, true, "and it is a DIFFERENT socket");
      assert.equal(s.box_lane_connected, false, "the box lane is not");
      assert.equal(s.universe.readyToEvaluate, false, "so the scanner is NOT ready");
      assert.notEqual(s.market_data_state, "READY");
    } finally {
      engine.dispose?.();
    }
  });
});

test("F: an inactive/unconfigured Dhan does not create a Zerodha readiness failure", async () => {
  await withFakeSockets(async () => {
    const { engine } = await buildComposition({
      active: "zerodha",
      kiteInstruments: zerodhaDump(),
      // Dhan is entirely unconfigured: loading it would throw.
    });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();
      const ws = FakeWebSocket.last;
      ws.open();
      for (const t of [...ws.subscribedTokens()].slice(0, 12)) ws.depthTick(t);

      const s = engine.getStatus();
      assert.equal(s.universe.stage, "evaluating", "Zerodha scans perfectly well");
      assert.equal(s.universe.readyToEvaluate, true);
      assert.equal(s.market_data_state, "READY");

      // Dhan appears in the order-stream list as not-applicable, and blocks nothing.
      const dhan = s.order_stream.brokers.find((b) => b.broker === "dhan");
      assert.ok(dhan);
      assert.equal(dhan.wiring, "not_applicable_paper", "inactive Dhan is not a fault");
      const entryCodes = s.operational_readiness.entry.reasons.map((r) => r.code);
      assert.ok(
        !entryCodes.some((c) => String(c).includes("dhan")),
        `no Dhan-derived entry blocker (got ${entryCodes.join(", ")})`,
      );
      // Exposure management is unaffected.
      assert.equal(s.operational_readiness.exposure_management.protective_cancel, true);
    } finally {
      engine.dispose?.();
    }
  });
});

test("F: live-only disarming is never described as a broken paper quote feed", async () => {
  await withFakeSockets(async () => {
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();
      const ws = FakeWebSocket.last;
      ws.open();
      for (const t of [...ws.subscribedTokens()].slice(0, 12)) ws.depthTick(t);

      const d = engine.getStatus().operational_readiness;
      assert.equal(d.identity.deployment_live_capable, false, "live is genuinely NOT armed");
      assert.equal(d.identity.live_runtime_armed, false);

      // And yet the quote feed is reported as healthy, because it IS.
      assert.equal(d.market_data.state, "READY");
      assert.equal(d.market_data.usable_for_entry, true);
      assert.equal(d.market_data.source, "broker_websocket");
      assert.equal(d.market_data.ticks_observed, true);
      const codes = [...d.entry.reasons, ...d.exposure_management.blocked_reasons].map((r) => r.code);
      assert.ok(
        !codes.includes("market_data_not_configured"),
        `market data is configured in paper (got ${codes.join(", ")})`,
      );
    } finally {
      engine.dispose?.();
    }
  });
});

test("F: a mixed-lot expiry drops pairs and is reported as `no_candidates`, not as a feed fault", async () => {
  await withFakeSockets(async () => {
    // Only ONE underlying, whose ATM put carries a doubled lot size. Every pair through that strike
    // is dropped by the single-lot invariant.
    const dump = zerodhaDump({ lotMismatch: true }).filter(
      (r) => r.name === "NIFTY" || r.tradingsymbol === "NIFTY 50",
    );
    const { engine } = await buildComposition({
      active: "zerodha",
      kiteInstruments: dump,
      spotPrices: { 256265: 24_500 },
    });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();
      const u = engine.getStatus().universe;
      // The universe itself is healthy; the loss is at candidate construction.
      assert.equal(u.counts.board_with_chains, 1);
      assert.equal(u.counts.windows_built, 1);
      assert.equal(u.instrument_load, "loaded");
      if (u.counts.candidates === 0) {
        assert.equal(u.stage, "no_candidates");
        assert.match(u.detail, /every leg must carry the chain's lot size/);
      } else {
        // Some pairs survive (those not through the corrupted strike) — still not a feed fault.
        assert.notEqual(u.stage, "instruments_empty");
        assert.notEqual(u.stage, "no_board_rows");
      }
    } finally {
      engine.dispose?.();
    }
  });
});


/* ═══════════════════ G. THE BOUNDED RETRY AND ITS LIFECYCLE ═══════════════════ */

/*
 * These cover the mechanism that recovers a transient instrument-master failure without an operator
 * pressing anything. Every case here was a defect found in review before it shipped.
 */

test("G: the retry backoff is EXPONENTIAL and capped, even when the failure is after the load", async () => {
  await withFakeSockets(async ({ timers }) => {
    /*
     * THE DEFECT THIS PINS. The delay was derived from `instrumentLoadFailures`, which is reset to 0
     * immediately after a successful load — so any failure occurring AFTER the load left the counter
     * at 0 and the backoff pinned at the 2s base forever, re-running the REST spot seed every 2s.
     * Here the load SUCCEEDS every time and the spot seed throws, which is exactly that shape.
     */
    let seedCalls = 0;
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    engine.deps.marketData.getQuoteFull = async () => {
      seedCalls++;
      throw new Error("HTTP 500 from the quote endpoint");
    };
    // Make the pass itself reject after the load, so the retry path is exercised.
    const realApply = engine.applySubscriptions.bind(engine);
    let failApply = true;
    engine.applySubscriptions = (a, b) => {
      if (failApply) throw new Error("post-load failure");
      return realApply(a, b);
    };
    try {
      startDiscovery(engine);

      const delays = [];
      for (let i = 0; i < 8; i++) {
        await engine.refreshUniverseWithRetry().catch(() => undefined);
        const t = timers.shift();
        assert.ok(t, `attempt ${i + 1} must arm a retry`);
        delays.push(t.ms);
        // Mirror what the real timer does the instant it fires: release its own handle, so the next
        // arm is not refused by the (correct) no-double-arm guard. The pass itself is driven
        // explicitly above rather than from the callback, to keep the sequence deterministic.
        engine.universeRetryTimer = null;
      }

      assert.deepEqual(
        delays.slice(0, 6),
        [2_000, 4_000, 8_000, 16_000, 32_000, 60_000],
        "the backoff must actually back off — a flat 2s is a retry storm against the broker",
      );
      for (const d of delays) assert.ok(d <= 60_000, `capped (got ${d})`);
      assert.deepEqual(delays.slice(6), [60_000, 60_000], "and stays capped");

      // A success clears the pending retry AND resets the curve, so the next incident starts fresh.
      failApply = false;
      await engine.refreshUniverseWithRetry();
      assert.equal(timers.length, 0, "success cancels the pending retry");
      failApply = true;
      await engine.refreshUniverseWithRetry().catch(() => undefined);
      assert.equal(timers.shift()?.ms, 2_000, "and the backoff restarts at the base delay");
      assert.ok(seedCalls > 0, "the spot seed really was the failing dependency");
    } finally {
      // Restore the real method BEFORE dispose: dispose() → stop() → shrinkToOpenPositions() calls
      // applySubscriptions, and the poisoned override would throw out of teardown.
      failApply = false;
      engine.applySubscriptions = realApply;
      engine.dispose?.();
    }
  });
});

test("G: STOP cancels a pending retry, so a stopped scanner does no universe work", async () => {
  await withFakeSockets(async ({ timers }) => {
    // The defect: `stop()` cleared the recurring universe timer but not the retry, so the retry fired,
    // ran a full pass (instrument load + REST spot seed) and re-armed — for a scanner the operator
    // had switched off.
    const { engine } = await buildComposition({
      active: "zerodha",
      kiteInstruments: () => {
        throw new Error("HTTP 503");
      },
    });
    try {
      startDiscovery(engine);
      await engine.refreshUniverseWithRetry().catch(() => undefined);
      assert.equal(timers.length, 1, "a retry is armed while running");

      engine.stop();
      assert.equal(timers.length, 1, "the timer object still exists in the fixture...");
      // ...but the engine has cancelled its handle, so a fired timer must not re-arm.
      const t = timers.shift();
      t.cb();
      assert.equal(
        timers.length,
        0,
        "a stopped engine must not re-arm the retry — otherwise it loops forever after STOP",
      );
    } finally {
      engine.dispose?.();
    }
  });
});

test("G: a repeated failure keeps saying FAILED — it never downgrades to `loading`", async () => {
  await withFakeSockets(async () => {
    /*
     * The defect: the pass set `loading` whenever the state was not `loaded`, so every retry flipped a
     * KNOWN failure back to `loading` — which is classified transient, whose entire message is "this
     * resolves on its own, wait rather than restarting". An operator was told to wait while a 503 sat
     * unreported in the headline.
     */
    const { engine } = await buildComposition({
      active: "zerodha",
      kiteInstruments: () => {
        throw new Error("HTTP 503 from the instruments endpoint");
      },
    });
    try {
      startDiscovery(engine);
      for (let i = 0; i < 3; i++) await engine.refreshUniverse().catch(() => undefined);

      const u = engine.getStatus().universe;
      assert.equal(u.instrument_load, "failed", "sticky until a load actually succeeds");
      assert.equal(u.stage, "instruments_failed");
      assert.equal(u.transient, false, "and it must NOT tell the operator to wait");
      assert.ok(u.instrument_load_failures >= 3);
      assert.match(u.instruments_error, /503/);
      assert.doesNotMatch(u.detail, /resolves on its own/);
    } finally {
      engine.dispose?.();
    }
  });
});

test("G: overlapping universe passes are deduplicated", async () => {
  await withFakeSockets(async () => {
    // The retry timer, the 60s timer, RUN and a strike-level change can all trigger a pass. The
    // provider dedups the DOWNLOAD; this dedups the PASS, so the REST spot seed does not run twice.
    let seedCalls = 0;
    const { engine, spies } = await buildComposition({
      active: "zerodha",
      kiteInstruments: zerodhaDump(),
    });
    const realSeed = engine.deps.marketData.getQuoteFull;
    engine.deps.marketData.getQuoteFull = async (ids) => {
      seedCalls++;
      return realSeed(ids);
    };
    try {
      startDiscovery(engine);
      await Promise.all([
        engine.refreshUniverseWithRetry(),
        engine.refreshUniverseWithRetry(),
        engine.refreshUniverseWithRetry(),
      ]);
      assert.equal(seedCalls, 1, "three concurrent triggers, ONE REST spot seed");
      assert.equal(spies.kiteGetInstruments, 1, "and one instrument download");
      assert.equal(engine.getStatus().universe.counts.board_with_chains, 2, "the pass still completed");
    } finally {
      engine.dispose?.();
    }
  });
});

test("G: a stopped scanner holding indicative windows is `scanner_stopped`, not a red fault", async () => {
  await withFakeSockets(async () => {
    /*
     * `refreshUniverse` builds windows when `running || (!marketOpen && indicativeDiscovery)` and
     * deliberately does NOT subscribe the indicative ones — they are priced from last-close prices
     * over REST. So a stopped scanner after hours with the DEFAULT BOX_INDICATIVE_DISCOVERY=true holds
     * windows and candidates with zero subscriptions. Diagnosing that as `no_desired_subscriptions`
     * produced a red "nothing will ever tick" badge every evening and all weekend, on an engine
     * behaving exactly as designed.
     */
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    try {
      // Stopped, market shut — the indicative path.
      engine.running = false;
      engine.marketOpen = false;
      engine.scanner.setMarketOpen(false);
      await engine.refreshUniverse();

      const u = engine.getStatus().universe;
      assert.equal(u.counts.desired_option_subscriptions, 0, "nothing is streamed, by design");
      assert.equal(u.stage, "scanner_stopped", "and that is simply a stopped scanner");
      assert.equal(u.readyToEvaluate, false);
      assert.doesNotMatch(u.detail, /nothing will ever tick/, "which would be false here");
      assert.match(u.detail, /scanner is STOPPED/);
    } finally {
      engine.dispose?.();
    }
  });
});

test("G: frame evidence is GENERATION-scoped, so a superseded socket cannot vouch for a new one", async () => {
  await withFakeSockets(async ({ runNextTimer }) => {
    // The defect: only `depthObservations` was reset on re-authentication, so `frames` carried the
    // previous socket's total. That made `awaiting_first_tick` unreachable after the first generation
    // and let the diagnosis assert "Frames are arriving (12)" about a socket delivering nothing.
    const { engine } = await buildComposition({ active: "zerodha", kiteInstruments: zerodhaDump() });
    try {
      startDiscovery(engine);
      await engine.refreshUniverse();
      const first = FakeWebSocket.last;
      first.open();
      for (const t of [...first.subscribedTokens()].slice(0, 6)) first.depthTick(t);
      assert.ok(engine.getStatus().universe.counts.frames_observed > 0, "frames on generation 1");

      first.closeWith(1006);
      runNextTimer();
      FakeWebSocket.last.open();

      const u = engine.getStatus().universe;
      assert.equal(u.counts.frames_observed, 0, "the new generation starts with NO frame evidence");
      assert.equal(u.counts.depth_observations, 0);
      assert.equal(u.stage, "awaiting_first_tick", "which is reportable again, as it must be");
      assert.doesNotMatch(u.detail, /Frames are arriving/);
    } finally {
      engine.dispose?.();
    }
  });
});

test("G: a 403 on the PUBLIC instruments dump does not log the deployment out", async () => {
  await withFakeSockets(async () => {
    /*
     * `kite.getInstruments()` tries UNAUTHENTICATED first because the dump is public, so a 403 there
     * says more about the endpoint or a gateway than about the token. It used to call `clearSession()`,
     * and since the box engine now reads this endpoint on a timer, one 403 would drop the in-memory
     * token and leave an unattended PM2 process unauthenticated until a human signed in again.
     */
    const { KiteClient } = await import(`${DIST}/kite.js`);
    const client = new KiteClient({ apiKey: "api-key", apiSecret: "" });
    client.installProvidedToken("api-key", "a-live-token");
    assert.equal(client.getAccessToken(), "a-live-token", "precondition: a live session");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      text: async () => "Forbidden by edge",
      json: async () => ({}),
      headers: { get: () => null },
    });
    try {
      await assert.rejects(() => client.getInstruments(), /403/);
      assert.equal(
        client.getAccessToken(),
        "a-live-token",
        "the session SURVIVES — a public-dump refusal is not evidence the credential is dead",
      );
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
