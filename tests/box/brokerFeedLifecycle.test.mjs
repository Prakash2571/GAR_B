/**
 * BROKER QUOTE-FEED LIFECYCLE — the REAL `ZerodhaFeed` and `DhanFeed`, driven by fake sockets.
 *
 * These are the production classes, constructed exactly as `ActiveBrokerManager` constructs them,
 * with `globalThis.WebSocket` replaced by a controllable fake. Nothing here greps source for a
 * method name: every assertion is about what the feed actually put on the wire, which callback it
 * actually invoked, and whether a reconnect actually happened.
 *
 * THE PRIMARY DEFECT COVERED (Zerodha)
 *
 * `ZerodhaFeed.onError` used to call `onDead(message)` and then `teardown()`. Both halves were
 * wrong, and together they killed the Zerodha box lane PERMANENTLY on the first network hiccup:
 *
 *   1. `ws.onerror` fires for ANY abnormal condition (DNS, TCP reset, TLS, idle timeout) and carries
 *      no code, so it is not evidence about the credential. But `onDead` drives the market-data
 *      health machine to AUTH_EXPIRED, which is terminal — and that blocker's scope is `both`, so it
 *      also reported exposure management as blocked.
 *   2. `teardown()` nulls `this.handle`, and `onClose` opens with `if (this.handle !== handle) return`.
 *      So the close that ALWAYS follows an error returned early and `scheduleReconnect()` was never
 *      reached. No socket, no pending reconnect, and nothing able to create one — for the life of
 *      the process. That is a complete standalone explanation for "last frame never observed".
 *
 * Recovery is now driven from `onclose`, which carries a code, exactly as `DhanFeed` already did.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ZerodhaFeed } from "../../dist/brokers/zerodha/feed.js";
import { DhanFeed } from "../../dist/brokers/dhan/feed.js";
import { DHAN_FEED_CODE } from "../../dist/brokers/dhan/feedDecoder.js";

/* ─────────────────────────────── fake transport ─────────────────────────────── */

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
    this.failSend = false;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }

  send(payload) {
    if (this.failSend) throw new Error("simulated send failure");
    this.sent.push(payload);
  }
  close() {
    this.closed = true;
  }

  /* ── driving the socket from the test ── */
  open() {
    this.onopen?.();
  }
  error() {
    this.onerror?.();
  }
  /** Close with a code. `1006` is the ordinary abnormal close a network blip produces. */
  closeWith(code = 1006) {
    this.onclose?.({ code });
  }
  frame(buffer) {
    this.onmessage?.({ data: buffer });
  }
  text(str) {
    this.onmessage?.({ data: str });
  }
  /** Kite's 1-byte keep-alive: a binary frame too short to hold a packet count. */
  kiteHeartbeat() {
    this.frame(new ArrayBuffer(1));
  }

  /** A Kite binary tick frame with a full (184-byte) depth packet. */
  kiteDepthTick(token, bid = 100, ask = 100.5) {
    const PACKET = 184;
    const buf = new ArrayBuffer(4 + PACKET);
    const v = new DataView(buf);
    v.setInt16(0, 1, false); // one packet
    v.setInt16(2, PACKET, false); // its length
    const p = 4;
    v.setUint32(p + 0, token, false);
    v.setInt32(p + 4, Math.round(((bid + ask) / 2) * 100), false); // ltp (paise)
    v.setInt32(p + 40, Math.round(bid * 100), false); // close
    v.setInt32(p + 48, 1234, false); // oi
    v.setUint32(p + 60, Math.floor(Date.now() / 1000), false); // exchange ts (seconds)
    // 5 bid levels at +64, 5 ask levels at +124; 12 bytes each: qty(4) price(4) orders(2) pad(2)
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
    this.frame(buf);
  }

  /** A Dhan FULL packet (code 8, 162 bytes) carrying both ladders. */
  dhanFullPacket(segmentCode, securityId, bid = 100, ask = 100.5) {
    const LEN = 162;
    const buf = new ArrayBuffer(LEN);
    const v = new DataView(buf);
    v.setUint8(0, DHAN_FEED_CODE.FULL);
    v.setInt16(1, LEN, true);
    v.setUint8(3, segmentCode);
    v.setInt32(4, securityId, true);
    v.setFloat32(8, (bid + ask) / 2, true); // ltp
    v.setInt16(12, 10, true); // last qty
    v.setInt32(14, Math.floor(Date.now() / 1000), true); // last trade time
    v.setFloat32(18, (bid + ask) / 2, true); // avg
    v.setInt32(22, 9999, true); // volume
    v.setInt32(34, 4321, true); // oi
    v.setFloat32(50, bid, true); // close
    for (let i = 0; i < 5; i++) {
      const at = 62 + i * 20;
      v.setInt32(at, 500, true); // bid qty
      v.setInt32(at + 4, 400, true); // ask qty
      v.setInt16(at + 8, 3, true); // bid orders
      v.setInt16(at + 10, 2, true); // ask orders
      v.setFloat32(at + 12, bid - i * 0.5, true);
      v.setFloat32(at + 16, ask + i * 0.5, true);
    }
    this.frame(buf);
  }

  /** A Dhan MARKET_STATUS packet: inbound traffic that carries no book. */
  dhanMarketStatus() {
    const LEN = 8;
    const buf = new ArrayBuffer(LEN);
    const v = new DataView(buf);
    v.setUint8(0, DHAN_FEED_CODE.MARKET_STATUS);
    v.setInt16(1, LEN, true);
    this.frame(buf);
  }
}

/** Run `fn` with the fake transport installed, and a deterministic timer capture. */
function withFakeSockets(fn) {
  const prevWs = globalThis.WebSocket;
  const prevSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.WebSocket = FakeWebSocket;
  // Capture reconnect timers instead of waiting for them, so backoff is asserted exactly.
  globalThis.setTimeout = (cb, ms) => {
    const handle = { cb, ms, unref() { return this; } };
    timers.push(handle);
    return handle;
  };
  FakeWebSocket.reset();
  try {
    return fn({
      timers,
      /** Fire the most recently scheduled timer. */
      runNextTimer: () => {
        const t = timers.shift();
        assert.ok(t, "a timer was expected to be scheduled");
        t.cb();
        return t;
      },
    });
  } finally {
    globalThis.WebSocket = prevWs;
    globalThis.setTimeout = prevSetTimeout;
    FakeWebSocket.reset();
  }
}

/** The real ZerodhaFeed, wired the way the registry wires the box lane. */
function makeZerodhaLane({ generation = () => 1, accessToken = "tok-1" } = {}) {
  const events = {
    ticks: [],
    heartbeats: 0,
    connections: [],
    dead: [],
    faults: [],
    textFrames: [],
  };
  let token = accessToken;
  const feed = new ZerodhaFeed({
    lane: "box",
    credentials: () => ({ apiKey: "api-key", accessToken: token }),
    generation,
    onTicks: (t) => events.ticks.push(...t),
    onHeartbeat: () => {
      events.heartbeats++;
    },
    onConnectionChange: (c) => events.connections.push(c),
    onDead: (m) => events.dead.push(m),
    onTransportFault: (m) => events.faults.push(m),
    onTextFrame: (raw) => events.textFrames.push(raw),
  });
  return { feed, events, setToken: (t) => (token = t) };
}

/** The real DhanFeed, wired the way the registry wires the box lane. */
function makeDhanLane({ resolve, accessToken = "dhan-tok-1" } = {}) {
  const events = { ticks: [], heartbeats: 0, connections: [], sessionLost: [] };
  let token = accessToken;
  const feed = new DhanFeed({
    accessToken: () => token,
    clientId: () => "client-1",
    onTicks: (t) => events.ticks.push(...t),
    onHeartbeat: () => {
      events.heartbeats++;
    },
    onConnection: (c) => events.connections.push(c),
    onSessionLost: (r) => events.sessionLost.push(r),
    resolve,
    depthLevel: 5,
  });
  return { feed, events, setToken: (t) => (token = t) };
}

/** Parse every JSON message the fake socket received. */
function sentMessages(ws) {
  return ws.sent.map((s) => JSON.parse(s));
}

/* ═══════════════════════ ZERODHA ═══════════════════════ */

test("ZERODHA: the initial connection subscribes the wanted set in FULL depth mode", () => {
  withFakeSockets(() => {
    const { feed, events } = makeZerodhaLane();
    feed.subscribeTokens([111, 222]);

    const ws = FakeWebSocket.last;
    assert.ok(ws, "a socket was opened");
    assert.match(ws.url, /^wss:\/\/ws\.kite\.trade\?api_key=api-key&access_token=tok-1$/);

    ws.open();
    assert.deepEqual(events.connections, [true]);

    const msgs = sentMessages(ws);
    assert.deepEqual(msgs[0], { a: "subscribe", v: [111, 222] });
    assert.deepEqual(
      msgs[1],
      { a: "mode", v: ["full", [111, 222]] },
      "FULL depth is requested unconditionally — paper must price against the same ladder as live",
    );
    assert.equal(feed.subscribedCount(), 2);
  });
});

test("ZERODHA: a transport error is NOT terminal — the lane reconnects and RESTORES subscriptions", () => {
  withFakeSockets(({ runNextTimer }) => {
    const { feed, events } = makeZerodhaLane();
    feed.subscribeTokens([111, 222]);
    const first = FakeWebSocket.last;
    first.open();
    first.kiteDepthTick(111);
    assert.equal(events.ticks.length, 1, "the lane was genuinely streaming before the fault");

    // A network blip: onerror, then the close that always follows it.
    first.error();
    assert.deepEqual(events.dead, [], "a bare transport error must NOT be reported as token death");
    assert.equal(events.faults.length, 1, "it IS reported, as a reconnectable fault");

    first.closeWith(1006);
    assert.deepEqual(events.connections, [true, false]);

    // THE REGRESSION: a reconnect must actually be scheduled.
    const timer = runNextTimer();
    // Full jitter over [backoff/2, backoff) decorrelates the two Zerodha lanes, which share
    // credentials and are therefore knocked over by the same events. The BAND is the contract, not
    // an exact delay.
    assert.ok(
      timer.ms >= 250 && timer.ms <= 500,
      `first retry must fall in the jittered base band [250,500], got ${timer.ms}`,
    );

    const second = FakeWebSocket.last;
    assert.notEqual(second, first, "a NEW socket was created");
    second.open();

    // Subscriptions are restored on the new socket, in full mode.
    const msgs = sentMessages(second);
    assert.deepEqual(msgs[0], { a: "subscribe", v: [111, 222] }, "the whole wanted set is restored");
    assert.deepEqual(msgs[1], { a: "mode", v: ["full", [111, 222]] }, "and depth mode is re-armed");

    // And it streams again.
    second.kiteDepthTick(222);
    assert.equal(events.ticks.length, 2, "the feed recovered");
    assert.deepEqual(events.dead, [], "still no false token-death report");
  });
});

test("ZERODHA: reconnect backoff is bounded, exponential and jittered", () => {
  withFakeSockets(({ runNextTimer }) => {
    const { feed } = makeZerodhaLane();
    feed.subscribeTokens([111]);
    FakeWebSocket.last.open();

    const delays = [];
    for (let i = 0; i < 8; i++) {
      FakeWebSocket.last.closeWith(1006);
      delays.push(runNextTimer().ms);
    }
    /*
     * Uncapped growth is 500, 1000, 2000, 4000, 8000, then capped at 15000 — and each delay carries
     * FULL JITTER over [backoff/2, backoff).
     *
     * The jitter is asserted as a band rather than pinned to an exact value because the point of it
     * is that it is not predictable: both Zerodha lanes share one api_key and are knocked over by
     * the same faults, so a deterministic backoff retries them in lockstep against an endpoint that
     * is already refusing connections, and makes them exhaust their failed-reopen budgets on the
     * same tick.
     */
    const uncapped = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000];
    for (const [i, delay] of delays.entries()) {
      const ceiling = uncapped[i];
      assert.ok(
        delay >= ceiling / 2 && delay <= ceiling,
        `retry ${i} must fall in the jittered band [${ceiling / 2},${ceiling}], got ${delay}`,
      );
      assert.ok(delay <= 15_000, `backoff ${delay}ms must stay capped — an unbounded retry storm is an outage`);
    }
    // Growth is still monotonic in expectation: the last (capped) delays cannot be smaller than the
    // jitter floor of the first.
    assert.ok(delays.slice(5).every((d) => d >= 7_500), "it keeps trying at the capped interval");
  });
});

test("ZERODHA: a POLICY close code IS terminal, and schedules no reconnect", () => {
  for (const code of [1008, 4001, 4401, 4403]) {
    withFakeSockets(({ timers }) => {
      const { feed, events } = makeZerodhaLane();
      feed.subscribeTokens([111]);
      const ws = FakeWebSocket.last;
      ws.open();
      ws.closeWith(code);

      assert.equal(events.dead.length, 1, `close ${code} must report a lost session`);
      assert.match(events.dead[0], /invalid or expired/);
      assert.equal(timers.length, 0, `close ${code} must NOT schedule a reconnect`);
    });
  }
});

test("ZERODHA: a token invalidated MID-SESSION eventually reports a lost session, not an endless retry loop", () => {
  /*
   * THE DEFAULT DAILY FAILURE PATH, and it used to be silent forever.
   *
   * Kite invalidates an access token every morning around 06:00 IST regardless of activity, and
   * immediately whenever the account signs in anywhere else (one active token per api_key). A process
   * that stays up across either event sees its socket close, and every reconnect is then refused at
   * the HTTP upgrade — which surfaces as close code 1006, so the policy-code path (1008/4001/4401/
   * 4403) never fires.
   *
   * The escalation used to be gated on the lane having NEVER opened in its lifetime, so once it had
   * connected at 09:10 the check was permanently unreachable: the lane reconnect-looped forever while
   * `index.ts`'s auth-death wiring never ran. The token stayed in memory, the encrypted session row
   * stayed valid, the health machine never reached AUTH_EXPIRED, and the operator was shown
   * `authenticated: true` with no problems against a dead session.
   */
  withFakeSockets(({ runNextTimer }) => {
    const { feed, events } = makeZerodhaLane();
    feed.subscribeTokens([111]);

    // It worked first: this is what made the old guard unreachable for the rest of the process.
    const live = FakeWebSocket.last;
    live.open();
    live.kiteDepthTick(111);
    assert.equal(events.ticks.length, 1, "the lane was genuinely streaming before the token died");

    // The token is now dead. Every reopen is refused at the upgrade — 1006, never a policy code.
    live.closeWith(1006);
    let attempts = 0;
    while (events.dead.length === 0 && attempts < 40) {
      attempts++;
      runNextTimer();
      FakeWebSocket.last.closeWith(1006);
    }

    assert.equal(
      events.dead.length, 1,
      `a mid-session token death must be reported, got ${attempts} attempts with no report`,
    );
    assert.match(events.dead[0], /RE-establish/, "the message must name this as a re-connect failure");
    assert.match(events.dead[0], /06:00 IST|signs in elsewhere/, "and point at the real cause");
    assert.ok(
      attempts > 5,
      "a lane that HAS worked gets more tolerance than a never-opened one: a genuine network " +
        `outage must not clear the stored session on the fifth blip (took ${attempts})`,
    );
    assert.ok(attempts <= 20, `and it must not take forever to notice (took ${attempts})`);
  });
});

test("ZERODHA: a socket that NEVER opens reports a lost session only after bounded retries", () => {
  withFakeSockets(({ timers, runNextTimer }) => {
    const { feed, events } = makeZerodhaLane();
    feed.subscribeTokens([111]);

    // Kite refuses a bad token at the HTTP upgrade, which arrives as an ordinary 1006 — so a single
    // failure must NOT be read as token death (that would kill the lane over a DNS blip), but
    // repeated failure to EVER open is genuine evidence.
    let attempts = 0;
    while (events.dead.length === 0 && attempts < 20) {
      FakeWebSocket.last.closeWith(1006);
      attempts++;
      if (events.dead.length > 0) break;
      assert.ok(timers.length > 0, `attempt ${attempts} must still be retrying`);
      runNextTimer();
    }
    assert.equal(events.dead.length, 1, "eventually the credential is declared the problem");
    assert.ok(attempts >= 5, `must retry several times first (took ${attempts})`);
    assert.ok(attempts <= 6, `but must not retry forever (took ${attempts})`);
    assert.match(events.dead[0], /could not establish a session/);
    assert.match(events.dead[0], /sign in again/, "and it must say what to DO about it");
  });
});

test("ZERODHA: a heartbeat frame is a heartbeat, never a tick", () => {
  withFakeSockets(() => {
    const { feed, events } = makeZerodhaLane();
    feed.subscribeTokens([111]);
    const ws = FakeWebSocket.last;
    ws.open();

    for (let i = 0; i < 5; i++) ws.kiteHeartbeat();

    assert.equal(events.heartbeats, 5, "the keep-alives were observed — they used to be observed by NOTHING");
    assert.equal(events.ticks.length, 0, "and not one of them became a tick");

    // The lane reports transport liveness separately from tick liveness.
    const stats = feed.stats();
    assert.equal(stats.lastTickAgeMs, null, "no tick has EVER arrived");
    assert.ok(stats.lastHeartbeatAgeMs !== null, "but the transport is provably alive");
  });
});

test("ZERODHA: a SUPERSEDED socket cannot emit ticks, heartbeats or postbacks", () => {
  withFakeSockets(({ runNextTimer }) => {
    let generation = 1;
    const { feed, events } = makeZerodhaLane({ generation: () => generation });
    feed.subscribeTokens([111]);
    const first = FakeWebSocket.last;
    first.open();
    first.closeWith(1006);
    runNextTimer();
    const second = FakeWebSocket.last;
    second.open();

    const ticksBefore = events.ticks.length;
    const beatsBefore = events.heartbeats;

    // The old socket wakes up late.
    first.kiteDepthTick(111);
    first.kiteHeartbeat();
    first.text('{"type":"order"}');

    assert.equal(events.ticks.length, ticksBefore, "a superseded socket's tick is rejected");
    assert.equal(events.heartbeats, beatsBefore, "and so is its keep-alive");
    assert.deepEqual(events.textFrames, [], "and so is its postback");

    // A BROKER-GENERATION change also invalidates the current socket's output: Zerodha and Dhan
    // token namespaces differ, so an integer means a different contract on each.
    generation = 2;
    second.kiteDepthTick(111);
    assert.equal(events.ticks.length, ticksBefore, "a stale-generation tick is rejected too");
  });
});

test("ZERODHA: a REPLACEMENT token is used on the next connect", () => {
  withFakeSockets(({ runNextTimer }) => {
    const { feed, setToken } = makeZerodhaLane({ accessToken: "old-token" });
    feed.subscribeTokens([111]);
    assert.match(FakeWebSocket.last.url, /access_token=old-token/);
    FakeWebSocket.last.open();

    // The operator signs in again; credentials are read FRESH on every connect.
    setToken("new-token");
    FakeWebSocket.last.closeWith(1006);
    runNextTimer();

    assert.match(
      FakeWebSocket.last.url,
      /access_token=new-token/,
      "the reconnect must authenticate with the CURRENT token, not the one captured at construction",
    );
  });
});

/* ═══════════════════════ DHAN ═══════════════════════ */

/** Two option instruments in NSE F&O (segment code 2). */
const DHAN_UNIVERSE = new Map([
  [9001, { segment: "NSE_FNO", securityId: 55001 }],
  [9002, { segment: "NSE_FNO", securityId: 55002 }],
]);
const dhanResolve = (token) => DHAN_UNIVERSE.get(token) ?? null;

test("DHAN: the initial connection subscribes with the FULL-depth request code", () => {
  withFakeSockets(() => {
    const { feed, events } = makeDhanLane({ resolve: dhanResolve });
    feed.subscribeTokens([9001, 9002]);

    const ws = FakeWebSocket.last;
    assert.match(ws.url, /authType=2/, "Dhan authenticates by URL");
    assert.match(ws.url, /token=dhan-tok-1/);
    ws.open();
    assert.deepEqual(events.connections, [true]);

    const msgs = sentMessages(ws);
    assert.equal(msgs.length, 1, "one batch is enough for two instruments");
    assert.equal(msgs[0].RequestCode, 21, "21 = SUBSCRIBE_FULL: the ladder, not just an LTP");
    assert.equal(msgs[0].InstrumentCount, 2);
    assert.deepEqual(msgs[0].InstrumentList, [
      { ExchangeSegment: "NSE_FNO", SecurityId: "55001" },
      { ExchangeSegment: "NSE_FNO", SecurityId: "55002" },
    ]);
  });
});

test("DHAN: a FULL packet becomes a tick with BOTH ladders", () => {
  withFakeSockets(() => {
    const { feed, events } = makeDhanLane({ resolve: dhanResolve });
    feed.subscribeTokens([9001]);
    const ws = FakeWebSocket.last;
    ws.open();
    ws.dhanFullPacket(2, 55001, 100, 100.5);

    assert.equal(events.ticks.length, 1);
    const tick = events.ticks[0];
    assert.equal(tick.token, 9001, "resolved back to the internal token");
    assert.equal(tick.depth_updated, true, "this packet DID carry an authoritative book");
    assert.equal(tick.bids.length, 5);
    assert.equal(tick.asks.length, 5);
    assert.ok(Math.abs(tick.bid - 100) < 0.01);
    assert.ok(Math.abs(tick.ask - 100.5) < 0.01);
    assert.equal(
      tick.exchange_ts,
      undefined,
      "Dhan's LTT is a TRADE time, never published as a book timestamp",
    );
  });
});

test("DHAN: a non-tick frame is a heartbeat, never a tick", () => {
  withFakeSockets(() => {
    const { feed, events } = makeDhanLane({ resolve: dhanResolve });
    feed.subscribeTokens([9001]);
    const ws = FakeWebSocket.last;
    ws.open();

    ws.dhanMarketStatus(); // decodes, but yields no tick
    ws.text("informational"); // a text frame on a binary feed

    assert.equal(events.ticks.length, 0, "neither produced a tick");
    assert.equal(events.heartbeats, 2, "both proved the transport is alive");
  });
});

test("DHAN: one failed subscription batch does not abandon the remaining ones", () => {
  withFakeSockets(() => {
    // 250 instruments ⇒ 3 batches at the 100-instrument protocol cap.
    const universe = new Map();
    const tokens = [];
    for (let i = 0; i < 250; i++) {
      const token = 20_000 + i;
      universe.set(token, { segment: "NSE_FNO", securityId: 70_000 + i });
      tokens.push(token);
    }
    const { feed } = makeDhanLane({ resolve: (t) => universe.get(t) ?? null });
    feed.subscribeTokens(tokens);
    const ws = FakeWebSocket.last;

    // Fail only the FIRST batch. The old code `return`ed here, silently abandoning ~150
    // instruments while the lane still looked connected.
    let call = 0;
    const realSend = ws.send.bind(ws);
    ws.send = (payload) => {
      call++;
      if (call === 1) throw new Error("simulated send failure");
      realSend(payload);
    };
    ws.open();

    const msgs = sentMessages(ws);
    assert.equal(msgs.length, 2, "batches 2 and 3 were still sent after batch 1 failed");
    assert.equal(msgs[0].InstrumentCount, 100);
    assert.equal(msgs[1].InstrumentCount, 50);
    // The wanted set is unchanged, so the next reconnect restores everything.
    assert.equal(feed.wantedCount(), 250);
  });
});

test("DHAN: an AUTH close is terminal; any other close reconnects and resubscribes", () => {
  // Terminal half.
  for (const code of [1008, 4001, 4401, 4403]) {
    withFakeSockets(({ timers }) => {
      const { feed, events } = makeDhanLane({ resolve: dhanResolve });
      feed.subscribeTokens([9001]);
      FakeWebSocket.last.open();
      FakeWebSocket.last.closeWith(code);

      assert.equal(events.sessionLost.length, 1, `close ${code} is a dead token`);
      assert.equal(timers.length, 0, `close ${code} must not reconnect`);
    });
  }

  // Recoverable half.
  withFakeSockets(({ runNextTimer }) => {
    const { feed, events } = makeDhanLane({ resolve: dhanResolve });
    feed.subscribeTokens([9001, 9002]);
    const first = FakeWebSocket.last;
    first.open();
    first.dhanFullPacket(2, 55001);
    assert.equal(events.ticks.length, 1);

    first.closeWith(1006);
    assert.deepEqual(events.sessionLost, [], "a blip is not a dead token");
    runNextTimer();

    const second = FakeWebSocket.last;
    assert.notEqual(second, first);
    second.open();
    const msgs = sentMessages(second);
    assert.equal(msgs[0].RequestCode, 21, "full depth is re-armed on the new socket");
    assert.equal(msgs[0].InstrumentCount, 2, "the whole wanted set is restored");

    second.dhanFullPacket(2, 55002);
    assert.equal(events.ticks.length, 2, "the feed recovered");
  });
});

test("DHAN: a reconnect DISCARDS retained ladders so a partial packet cannot republish an old book", () => {
  withFakeSockets(({ runNextTimer }) => {
    const { feed, events } = makeDhanLane({ resolve: dhanResolve });
    feed.subscribeTokens([9001]);
    const first = FakeWebSocket.last;
    first.open();
    first.dhanFullPacket(2, 55001, 100, 100.5);
    const generationBefore = feed.feedGeneration();

    first.closeWith(1006);
    runNextTimer();
    const second = FakeWebSocket.last;
    second.open();

    assert.ok(
      feed.feedGeneration() > generationBefore,
      "a new socket is a new generation, so consumers can discard the old books",
    );
    // A MARKET_STATUS frame on the new socket must not resurrect the previous ladder.
    second.dhanMarketStatus();
    assert.equal(events.ticks.length, 1, "still only the ONE tick from before the reconnect");
  });
});

test("DHAN: an unresolvable token is dropped loudly, not sent as a silently shorter list", () => {
  withFakeSockets(() => {
    const { feed } = makeDhanLane({ resolve: dhanResolve });
    // 9003 is not in the universe — e.g. a token from the other broker's namespace.
    feed.subscribeTokens([9001, 9003]);
    const ws = FakeWebSocket.last;
    ws.open();

    const msgs = sentMessages(ws);
    assert.equal(msgs[0].InstrumentCount, 1, "only the resolvable instrument goes upstream");
    assert.deepEqual(msgs[0].InstrumentList, [{ ExchangeSegment: "NSE_FNO", SecurityId: "55001" }]);
  });
});

/* ═══════════════════════ CROSS-BROKER ISOLATION ═══════════════════════ */

test("BROKER SWITCH: stopping a lane forgets its tokens so no book can cross namespaces", () => {
  withFakeSockets(() => {
    const { feed: zerodha, events: zEvents } = makeZerodhaLane();
    zerodha.subscribeTokens([111, 222]);
    const zws = FakeWebSocket.last;
    zws.open();
    zws.kiteDepthTick(111);
    assert.equal(zEvents.ticks.length, 1);
    assert.equal(zerodha.wantedCount(), 2);

    // The switch stops the outgoing broker's lane.
    zerodha.stop();
    assert.equal(
      zerodha.wantedCount(),
      0,
      "Kite tokens are meaningless — worse, misleading — to Dhan, so they must not survive",
    );
    assert.equal(zws.closed, true);

    // Late traffic from the stopped lane's socket reaches nobody.
    const before = zEvents.ticks.length;
    zws.kiteDepthTick(222);
    zws.kiteHeartbeat();
    assert.equal(zEvents.ticks.length, before, "a disposed lane cannot emit");

    // The incoming broker starts clean, with its OWN namespace.
    const { feed: dhan, events: dEvents } = makeDhanLane({ resolve: dhanResolve });
    dhan.subscribeTokens([9001]);
    FakeWebSocket.last.open();
    FakeWebSocket.last.dhanFullPacket(2, 55001);
    assert.equal(dEvents.ticks.length, 1);
    assert.equal(dEvents.ticks[0].token, 9001, "a Dhan token, resolved through Dhan's own universe");
    assert.equal(zEvents.ticks.length, before, "and nothing leaked back into the stopped lane");
  });
});

test("a lane with NOTHING wanted does not hold a socket open", () => {
  withFakeSockets(({ timers }) => {
    const { feed } = makeZerodhaLane();
    feed.subscribeTokens([111]);
    FakeWebSocket.last.open();
    feed.unsubscribeTokens([111]);
    FakeWebSocket.last.closeWith(1006);
    assert.equal(
      timers.length,
      0,
      "nothing is being streamed, so there is no reason to reconnect",
    );
  });
});
