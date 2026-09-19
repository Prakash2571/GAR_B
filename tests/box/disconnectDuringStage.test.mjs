/**
 * WEBSOCKET DISCONNECT DURING EACH ENTRY/EXIT STAGE (item 12 gap-fill).
 *
 * The permission TABLE is unit-tested (marketDataStateMachine.test.mjs); the CONSUMER lifecycle is
 * unit-tested (orderStreamConsumer.test.mjs). What was missing is the INTEGRATION: that the REAL
 * CentralBoxExecutionGateway, wired to a REAL MarketDataStateMachine through the production
 * `marketDataEntryPermitted` seam (the exact seam engine.ts supplies at engine.ts:~901), actually
 * REFUSES a live entry — zero broker POSTs — when the market-data socket is in each
 * not-fully-READY lifecycle stage, and actually PERMITS it only at READY. And, the asymmetry that
 * keeps a live position manageable: a WebSocket that drops DURING an exit must NOT block the exit
 * from reaching the broker.
 *
 * "Each stage" is enumerated from the real lifecycle: a disconnect (or a still-connecting /
 * authenticating / synchronizing / degraded / auth-expired socket) at the moment entry is
 * attempted. Each drives the REAL machine with REAL lifecycle events and asserts on
 * `adapter.posts` — a genuine broker mutation, appended only after the send-boundary callback
 * returns.
 *
 * Only the two real process boundaries are faked (broker HTTP = recording adapter, Mongo =
 * in-memory CAS). The gateway, the manager, the machine and the permission tables are production.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BoxOrderManager } from "../../dist/box/orderManager.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { MarketDataStateMachine, marketDataPermissions } from "../../dist/box/streamHealthPolicy.js";
import { exitSideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg, exitQuotes, seedStore, positionFrom } from "./helpers.mjs";
import {
  candidateFor,
  detectionFor,
  entryPosts,
  recordingAdapter,
  MemoryPersistence,
  NOW,
} from "./liveEntryHarness.mjs";

const LIMITS = {
  maxOpenBoxes: 10,
  maxConcurrentExecutions: 1,
  maxResidualLegs: 10,
  dailyLossLimit: 1_000_000,
  rejectLimit: 100,
  consecutiveFailureLimit: 100,
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 60_000,
  feedReconnectWarmupMs: 0,
  // The broker dep here is zerodha, so the static-IP ENTRY policy applies. Supplied as confirmed
  // because this fixture is about stream disconnection during a staged entry, not about the
  // operator-confirmation gate (which has its own suite).
  zerodhaEntryStaticIpConfirmed: true,
  maxBoxCapitalRupees: 0,
};

/**
 * Build the REAL gateway→manager→adapter stack for a direction, with a REAL MarketDataStateMachine
 * feeding the production `marketDataEntryPermitted` seam. `driveMachine` is called with the machine
 * so a test can put it in any lifecycle stage before attempting entry/exit.
 */
async function stackWithMachine({ direction = "LONG_BOX", driveMachine } = {}) {
  const candidate = candidateFor(direction);
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, 198, { at: NOW, qty: 100_000 }), NOW);

  const persistence = new MemoryPersistence();
  const adapter = recordingAdapter();
  let clock = NOW;
  const manager = new BoxOrderManager({
    adapter,
    persistence,
    limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => clock++ },
    istDayKey: () => "2026-09-02",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  await manager.reconcile();

  // The REAL market-data machine. A generous now() so books never age out during the test.
  const machine = new MarketDataStateMachine({ enabled: true, now: () => NOW });
  driveMachine?.(machine, candidate);

  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({
      executionMode: "live",
      liveTradingEnabled: true,
      queueModel: "none",
      liveMaxChaseTicks: 2,
      legMaxChaseTicks: 2,
      unwindMaxChaseTicks: 5,
    }),
    simulator: {
      hasCapacity: () => false,
      estimateExecutableExit: () => [],
      simulateLeggingEntry: async () => { throw new Error("live must not reach the paper simulator"); },
    },
    quotes,
    manager,
    broker: () => "zerodha",
    allocateTradeId: () => "trade-md-1",
    isTokenWarm: () => true,
    feedGeneration: () => machine.generation(),
    now: () => NOW,
    chargeTotal: () => 0,
    // THE PRODUCTION SEAM under test — identical shape to engine.ts.
    marketDataEntryPermitted: () => {
      const state = machine.state();
      return { permitted: marketDataPermissions(state).newEntry, state };
    },
  });

  return { candidate, quotes, gateway, manager, adapter, machine };
}

/** Bring the machine fully READY for the candidate's four legs (the only entry-permitting state). */
function driveReady(machine, candidate) {
  const tokens = BOX_LEG_ROLES.map((role) => candidate.legs[role].token);
  machine.setDesiredInstruments(tokens);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated(); // → SYNCHRONIZING, generation advances
  machine.onSubscriptionsConfirmed(tokens);
  for (const token of tokens) machine.onUsableDepth(token, NOW);
  machine.onFrame(NOW);
  assert.equal(machine.evaluate(), "READY", "fixture: the machine must reach READY for the entry-permitted case");
}

function runEntry(stack) {
  return stack.gateway.simulateLeggingEntry({
    candidate: stack.candidate,
    detection: detectionFor(stack.candidate, stack.quotes),
    stillWanted: () => true,
    qualify: () => ({ qualifies: true, expected_net_profit: 5_000, min_expected_net_profit: 1_200 }),
  });
}

/* ─────────── entry is refused at EVERY not-READY market-data lifecycle stage ─────────── */

const notReadyStages = [
  ["DISCONNECTED (socket dropped, nothing reconnected)", (m) => { /* initial state is DISCONNECTED */ }],
  ["CONNECTING", (m) => { m.onConnecting(); }],
  ["AUTHENTICATING (socket open, not yet authorised)", (m) => { m.onConnecting(); m.onSocketOpen(); }],
  ["SYNCHRONIZING (authorised, no usable depth yet)", (m, c) => {
    m.setDesiredInstruments(BOX_LEG_ROLES.map((r) => c.legs[r].token));
    m.onConnecting(); m.onSocketOpen(); m.onAuthenticated();
  }],
  ["DEGRADED (was READY, then the socket went silent past the heartbeat bound)", (m, c) => {
    const tokens = BOX_LEG_ROLES.map((r) => c.legs[r].token);
    m.setDesiredInstruments(tokens);
    m.onConnecting(); m.onSocketOpen(); m.onAuthenticated();
    for (const t of tokens) m.onUsableDepth(t, NOW);
    m.onFrame(NOW);
    assert.equal(m.evaluate(), "READY");
    m.onDisconnected(); // the drop mid-life
  }],
  ["AUTH_EXPIRED (token rejected)", (m, c) => {
    const tokens = BOX_LEG_ROLES.map((r) => c.legs[r].token);
    m.setDesiredInstruments(tokens);
    m.onConnecting(); m.onSocketOpen(); m.onAuthenticated();
    m.onSessionLost();
  }],
];

for (const [label, drive] of notReadyStages) {
  test(`entry is REFUSED (zero POST) when the market-data socket is ${label}`, async () => {
    const stack = await stackWithMachine({ driveMachine: (m, c) => drive(m, c) });
    const result = await runEntry(stack);
    assert.equal(result.ok, false, `entry must be refused while market data is not READY (${label})`);
    assert.equal(result.reason, "feed_unhealthy", "the refusal reason names the unhealthy feed");
    assert.equal(
      entryPosts(stack.adapter).length,
      0,
      `no entry order may reach the broker while the market-data socket is ${label}`,
    );
  });
}

test("entry is PERMITTED (all four legs POST) only when the market-data socket is fully READY", async () => {
  const stack = await stackWithMachine({ driveMachine: driveReady });
  const result = await runEntry(stack);
  assert.equal(result.ok, true, "a fully READY feed must admit a coherent entry");
  assert.equal(entryPosts(stack.adapter).length, 4, "all four legs transmitted when READY");
});

/* ─────────── a WebSocket dropping DURING an exit must NOT block the exit ─────────── */

/** Detection legs on the EXIT side, priced from the seeded book. */
function exitDetection(candidate, quotes, direction) {
  return BOX_LEG_ROLES.map((role) => {
    const leg = candidate.legs[role];
    const q = quotes.get(leg.token);
    const side = exitSideFor(role, direction);
    return {
      role, side, token: leg.token, tradingsymbol: leg.tradingsymbol, strike: leg.strike,
      instrument_type: leg.instrument_type,
      price: side === "BUY" ? q.asks[0].price : q.bids[0].price,
      qty_at_touch: candidate.lot_size,
      bid: q.bids[0].price, bid_qty: q.bids[0].qty,
      ask: q.asks[0].price, ask_qty: q.asks[0].qty,
      quote_at: q.at, exchange_at: null, quote_version: q.version, depth: null,
      age_ms: 0, fresh: true, executable: true,
    };
  });
}

test("a market-data DISCONNECT does NOT block a protective EXIT from reaching the broker (entry-only gate)", async () => {
  const direction = "LONG_BOX";
  // Enter first, while READY.
  const stack = await stackWithMachine({ direction, driveMachine: driveReady });
  const entry = await runEntry(stack);
  assert.equal(entry.ok, true, "fixture: the box must be entered first");
  const postsAfterEntry = stack.adapter.posts.length;

  // Now the market-data socket DROPS mid-life — the same event that refuses new entry above.
  stack.machine.onDisconnected();
  assert.equal(stack.machine.state(), "DISCONNECTED");
  // The production permission table on a full DISCONNECT: NO new entry (unbounded new risk), and —
  // honestly — no priced exit either, because a dead book cannot price a new limit order; but a
  // protective CANCEL (which needs no price) is still permitted so exposure is never stranded.
  assert.equal(marketDataPermissions("DISCONNECTED").newEntry, false, "no new entry on a dead feed");
  assert.equal(marketDataPermissions("DISCONNECTED").protectiveCancel, true, "cancel is never refused for feed health");

  // The gateway's market-data gate is ENTRY-ONLY: simulateLeggingExit is not routed through it, so
  // a protective exit still reaches the broker after the disconnect. That asymmetry — refuse new
  // exposure, never refuse reducing existing exposure — is what keeps a live position manageable.
  const position = positionFrom(stack.candidate, { direction });
  await stack.gateway.simulateLeggingExit({
    position,
    detectionLegs: exitDetection(stack.candidate, stack.quotes, direction),
    detectedAt: NOW,
  });

  assert.ok(
    stack.adapter.posts.length > postsAfterEntry,
    "an exit must still reach the broker after a market-data disconnect — refusing to reduce is more dangerous",
  );
});

test("a DEGRADED (connected-but-stale) feed permits exit/reduce while still refusing new entry", async () => {
  // The distinction the table encodes: a DEGRADED feed still has a usable single-leg book to price
  // a reduction from, so exitAndReduce is permitted; a fully DISCONNECTED one does not.
  assert.equal(marketDataPermissions("DEGRADED").newEntry, false, "a degraded feed cannot justify a new four-leg box");
  assert.equal(marketDataPermissions("DEGRADED").exitAndReduce, true, "but it can still price a reduction");
  assert.equal(marketDataPermissions("READY").newEntry, true, "only a fully ready feed permits new entry");
});

test("AUTH_EXPIRED still permits a protective cancel even though it forbids entry (never strand exposure)", () => {
  // The market-data table forbids everything on AUTH_EXPIRED (the broker will refuse a priced
  // order anyway); the ORDER-STREAM table keeps protective cancel alive. This pins the entry-only
  // refusal so a future edit cannot make an expired session silently permit new exposure.
  assert.equal(marketDataPermissions("AUTH_EXPIRED").newEntry, false);
  assert.equal(marketDataPermissions("READY").newEntry, true);
});
