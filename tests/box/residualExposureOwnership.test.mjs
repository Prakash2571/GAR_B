/**
 * RESIDUAL EXPOSURE KEEPS ITS MARKET DATA, AND RESTORED STATE IS NOT EXECUTED UNDER THE WRONG MODE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE DEFECTS THESE TESTS PIN
 *
 * A. STOP STRANDED RESIDUAL EXPOSURE BY REMOVING ITS MARKET DATA.
 *    An incomplete entry can leave RESIDUAL legs behind without ever creating an ordinary open box.
 *    Every subscription decision was computed from `positions.tokens()` alone:
 *
 *      shrinkToOpenPositions()  wantOption = new Set(this.positions.tokens())
 *      maybeReleaseFeed()       if (this.running || this.positions.size > 0) return;
 *      refreshUniverse()        mustKeep = positions' underlyings; the one unconditional union was
 *                               positions.tokens()
 *      registerResidual()       called ensureFeed() but NEVER subscribed the residual instruments
 *
 *    So pressing STOP — an operator SAFETY control — unsubscribed the very books the flatten loop
 *    needs, `quotes.forget()` them, and then released the tick listener and the feed retainer. The
 *    exposure stayed on, and nothing failed: the flatten loop simply never saw a priceable book again.
 *
 * B. RESTORED PAPER/LIVE STATE WAS NOT SEPARATED AT THE EXECUTION BOUNDARY.
 *    Adoption faithfully records the mode a position was created under, and then no exit path read
 *    it: the only paper/live fork was the process-wide `this.mode`. Both directions were unsafe —
 *    a live process would send REAL orders for a paper record, and a paper process would SIMULATE
 *    the close of a real one and mark it closed.
 *
 * C. AN UNREADABLE RESIDUAL PICTURE WAS REPORTED AS "NO RESIDUALS".
 *    `loadUnresolvedBoxExecutionAttempts()` caught database errors and returned `[]`, so "none" and
 *    "unknown" were indistinguishable. Because `flattenResiduals()` clears its own interval the first
 *    time it finds the map empty, one spurious `[]` meant the rows were never revisited again.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE NOT MIRRORS OF THE IMPLEMENTATION
 *
 * They drive the REAL `BoxEngine` and the REAL `CentralBoxExecutionGateway` and assert on OBSERVABLE
 * outcomes: the token set actually published to the feed, whether the retainer was actually released,
 * and whether an order actually reached the adapter. Each group carries a NON-VACUOUS CONTROL — the
 * case that must still work — so none of them can pass by simply doing nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");

/* ═══════════════════════════ hermetic engine: no network, no db, no broker ═══════════════════════ */

/**
 * Records what the engine actually asked the feed for.
 *
 * `setBoxTokens` is REPLACE-semantics, so the last call is the whole intent — which is exactly why a
 * token missing from it is unsubscribed AND forgotten from the quote store.
 */
function feedSpy() {
  const spy = {
    boxTokenCalls: [],
    retained: 0,
    released: 0,
    tickListeners: 0,
    tickRemovals: 0,
  };
  spy.feed = {
    addTickListener: () => {
      spy.tickListeners++;
      return () => {
        spy.tickRemovals++;
      };
    },
    addConnectionListener: () => () => {},
    retain: () => {
      spy.retained++;
      return () => {
        spy.released++;
      };
    },
    subscribeTokens: () => {},
    unsubscribeTokens: () => {},
    setStrategyTokens: () => {},
    setBoxTokens: (tokens) => spy.boxTokenCalls.push([...tokens]),
    subscribedCount: () => 0,
    isConnected: () => false,
  };
  return spy;
}

function engineDeps(spy, { broker = "zerodha", marketOpen = true } = {}) {
  return {
    marketData: { isAuthenticated: () => true, getQuoteFull: async () => ({}) },
    activeBroker: () => broker,
    feed: spy.feed,
    charges: { broker, rateVersion: "test", estimate: () => null },
    getAllInstruments: async () => [],
    getBoard: async () => [],
    priceChargeGroups: async () => null,
    istDayKey: () => "2026-09-16",
    makeIdResolver: () => () => null,
    isMarketOpen: () => marketOpen,
    margins: {
      broker,
      basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }),
    },
    brokerAccountRef: () => "AB1234",
  };
}

async function makeEngine(spy, opts) {
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  return new BoxEngine(engineDeps(spy, opts));
}

/** One residual leg. `token` is what every subscription decision must now see. */
const residualLeg = (token, side = "SELL") => ({
  role: side === "SELL" ? "k2_ce" : "k1_ce",
  token,
  tradingsymbol: `SYM-${token}`,
  exchange: "NFO",
  side,
  quantity: 75,
  average_price: 100,
  source: "partial_entry",
  created_at: 1_000,
});

/* ═════════════ A. RESIDUAL EXPOSURE KEEPS ITS SUBSCRIPTIONS AND ITS FEED ═════════════ */

test("A1: registering a residual SUBSCRIBES its instruments, not merely the transport", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  engine.registerResidual("attempt-A1", [residualLeg(9001)], 0, "id-A1", "RELIANCE");

  assert.ok(
    engine.subscribedOptionTokens.has(9001),
    "the residual instrument must be in the engine's subscription intent",
  );
  const last = spy.boxTokenCalls.at(-1) ?? [];
  assert.ok(
    last.includes(9001),
    `the residual token must be published to the feed; last setBoxTokens was ${JSON.stringify(last)}`,
  );
  assert.ok(spy.retained > 0, "outstanding exposure must retain the feed");

  engine.dispose();
});

test("A2: STOP's subscription shrink KEEPS residual tokens (the reported defect)", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  // Residual exposure with NO ordinary open position — exactly the state an incomplete entry leaves.
  engine.registerResidual("attempt-A2", [residualLeg(9101), residualLeg(9102, "BUY")], 0, "id-A2", "RELIANCE");
  assert.equal(engine.positions.size, 0, "precondition: no ordinary open position");

  engine.shrinkToOpenPositions();

  assert.ok(engine.subscribedOptionTokens.has(9101), "short residual leg must stay subscribed after STOP");
  assert.ok(engine.subscribedOptionTokens.has(9102), "long residual leg must stay subscribed after STOP");
  const last = spy.boxTokenCalls.at(-1) ?? [];
  assert.ok(
    last.includes(9101) && last.includes(9102),
    `STOP must not unsubscribe residual legs; last setBoxTokens was ${JSON.stringify(last)}`,
  );

  engine.dispose();
});

test("A3: STOP does NOT release the feed while residual exposure is outstanding", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  engine.registerResidual("attempt-A3", [residualLeg(9201)], 0, "id-A3", "RELIANCE");
  const releasedBefore = spy.released;
  const removalsBefore = spy.tickRemovals;

  engine.shrinkToOpenPositions(); // ends in maybeReleaseFeed()
  engine.maybeReleaseFeed(); // and again, directly

  assert.equal(spy.released, releasedBefore, "the feed retainer must NOT be released while residuals are on");
  assert.equal(spy.tickRemovals, removalsBefore, "the tick listener must NOT be removed while residuals are on");

  engine.dispose();
});

test("A4 (non-vacuous control): with NO exposure at all, STOP still releases the feed", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  // Register then RESOLVE the residual, so the engine has held and then genuinely finished exposure.
  engine.registerResidual("attempt-A4", [residualLeg(9301)], 0, "id-A4", "RELIANCE");
  assert.ok(spy.retained > 0, "precondition: the feed was retained while exposure existed");
  engine.registerResidual("attempt-A4", [], 1, "id-A4-resolved", "RELIANCE"); // resolved

  engine.shrinkToOpenPositions();

  assert.equal(engine.residualLegCount(), 0, "precondition: exposure is genuinely gone");
  assert.ok(spy.released > 0, "with nothing outstanding the retainer MUST be released — otherwise A3 is vacuous");
  assert.equal(
    (spy.boxTokenCalls.at(-1) ?? []).length,
    0,
    "with nothing outstanding the token set MUST be empty — otherwise A2 is vacuous",
  );

  engine.dispose();
});

test("A5: a resolved residual stops holding the feed and drops its ownership record", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  engine.registerResidual("attempt-A5", [residualLeg(9401)], 0, "id-A5", "RELIANCE");
  assert.equal(engine.residualOwnershipByAttempt.has("attempt-A5"), true);

  engine.registerResidual("attempt-A5", [], 1, "id-A5b", "RELIANCE");

  assert.equal(engine.residualOwnershipByAttempt.has("attempt-A5"), false, "ownership must not outlive the exposure");
  assert.equal(engine.residualLegCount(), 0);

  engine.dispose();
});

/* ═════════════ B. MODE ISOLATION AT THE EXECUTION BOUNDARY ═════════════ */

const LEG = (token) => ({
  token,
  tradingsymbol: `SYM-${token}`,
  exchange: "NFO",
  strike: 100,
  instrument_type: "CE",
  expiry: "2026-09-24",
  lot_size: 75,
  tick_size: 0.05,
});

/** A position carrying an explicit `execution_mode` — the field every exit path used to ignore. */
function position(executionMode, id = "trade-1") {
  return {
    id,
    key: `RELIANCE|2026-09-24|100|110|LONG_BOX`,
    broker: "zerodha",
    execution_mode: executionMode,
    underlying: "RELIANCE",
    name: "Reliance",
    is_index: false,
    expiry: "2026-09-24",
    direction: "LONG_BOX",
    lower_strike: 100,
    upper_strike: 110,
    box_width: 10,
    lot_size: 75,
    quantity: 75,
    legs: { k1_ce: LEG(8001), k2_ce: LEG(8002), k2_pe: LEG(8003), k1_pe: LEG(8004) },
    entry_prices: { k1_ce: 10, k2_ce: 5, k2_pe: 4, k1_pe: 8 },
    remaining_qty_by_role: { k1_ce: 75, k2_ce: 75, k2_pe: 75, k1_pe: 75 },
    position_state: "BOX",
    cumulative_exit_charges: 0,
    exit_attempts: [],
    metrics: null,
    exit_blocked_reason: null,
    expiry_safety: false,
    closing: false,
    last_persist_at: 0,
    entry_box_cost_per_unit: 1,
    entry_gross_edge: 1,
    entry_net_edge: 1,
    entry_charges_total: 0,
    estimated_exit_charges_total: 0,
    safety_buffer: 0,
    margin: null,
    opened_at: 0,
    config: {},
  };
}

const detectionLegs = () =>
  ["k1_ce", "k2_ce", "k2_pe", "k1_pe"].map((role, i) => ({
    role,
    side: "SELL",
    token: 8001 + i,
    tradingsymbol: `SYM-${8001 + i}`,
    strike: 100,
    instrument_type: "CE",
    price: 10,
    qty_at_touch: 750,
    bid: 10,
    bid_qty: 750,
    ask: 10.5,
    ask_qty: 750,
    quote_at: 1_000,
    age_ms: 5,
    fresh: true,
    executable: true,
  }));

async function makeGateway(mode, simulator) {
  const { CentralBoxExecutionGateway } = await import(`${DIST}/box/executionGateway.js`);
  const { BoxQuoteStore } = await import(`${DIST}/box/quotes.js`);
  const { loadBoxConfig } = await import(`${DIST}/box/config.js`);
  const mismatches = [];
  const gateway = new CentralBoxExecutionGateway({
    cfg: { ...loadBoxConfig(), executionMode: mode },
    simulator,
    quotes: new BoxQuoteStore(),
    feedGeneration: () => 0,
    chargeTotal: () => 20,
    onExecutionModeMismatch: (detail) => mismatches.push(detail),
  });
  return { gateway, mismatches };
}

test("B1: a LIVE process refuses to send real orders for a PAPER position", async () => {
  const { gateway, mismatches } = await makeGateway("live", {
    simulateLeggingExit: async () => {
      throw new Error("SIMULATOR MUST NOT BE REACHED");
    },
  });

  const result = await gateway.simulateLeggingExit({
    position: position("paper_legging"),
    detectionLegs: detectionLegs(),
    detectedAt: 1_000,
  });

  assert.equal(result.ok, false, "a paper record must not be exited by a live process");
  assert.equal(result.reason, "execution_mode_mismatch");
  assert.match(result.detail, /Refusing to send REAL orders/);
  assert.equal(mismatches.length, 1, "the refusal must be reported, never silent");
});

test("B2: a PAPER process refuses to SIMULATE the close of a LIVE position", async () => {
  let simulatorCalls = 0;
  const { gateway, mismatches } = await makeGateway("paper_latency", {
    simulateLeggingExit: async () => {
      simulatorCalls++;
      return { ok: true, legs: [], record: {}, booksAtFill: new Map() };
    },
  });

  const result = await gateway.simulateLeggingExit({
    position: position("live"),
    detectionLegs: detectionLegs(),
    detectedAt: 1_000,
  });

  assert.equal(result.ok, false, "real exposure must never be closed by simulation");
  assert.equal(result.reason, "execution_mode_mismatch");
  assert.match(result.detail, /Refusing to SIMULATE/);
  assert.equal(simulatorCalls, 0, "the simulator must not run for a live record");
  assert.equal(mismatches.length, 1);
});

test("B3 (non-vacuous control): matching modes reach the simulator normally", async () => {
  let simulatorCalls = 0;
  const { gateway, mismatches } = await makeGateway("paper_latency", {
    simulateLeggingExit: async () => {
      simulatorCalls++;
      return { ok: true, legs: [], record: {}, booksAtFill: new Map() };
    },
  });

  const result = await gateway.simulateLeggingExit({
    position: position("paper_latency"),
    detectionLegs: detectionLegs(),
    detectedAt: 1_000,
  });

  assert.equal(result.ok, true, "a matching record must still be exitable — otherwise B1/B2 are vacuous");
  assert.equal(simulatorCalls, 1);
  assert.equal(mismatches.length, 0);
});

test("B4: paper modes are interchangeable — the check is the paper/live BOUNDARY, not equality", async () => {
  let simulatorCalls = 0;
  const { gateway, mismatches } = await makeGateway("paper_latency", {
    simulateLeggingExit: async () => {
      simulatorCalls++;
      return { ok: true, legs: [], record: {}, booksAtFill: new Map() };
    },
  });

  // paper_touch adopted by a paper_latency process: both simulated, so this must NOT be refused.
  const result = await gateway.simulateLeggingExit({
    position: position("paper_touch"),
    detectionLegs: detectionLegs(),
    detectedAt: 1_000,
  });

  assert.equal(result.ok, true, "paper_touch and paper_latency must stay interchangeable");
  assert.equal(simulatorCalls, 1);
  assert.equal(mismatches.length, 0, "an interchangeable pair must not be reported as a mismatch");
});

test("B5: the non-legging exit path is guarded too, with a correctly shaped record", async () => {
  let simulatorCalls = 0;
  const { gateway } = await makeGateway("paper_latency", {
    simulateExit: async () => {
      simulatorCalls++;
      return { ok: true, legs: [], record: {} };
    },
  });

  const result = await gateway.simulateExit({
    position: position("live"),
    detectionLegs: detectionLegs(),
    detectedAt: 1_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "execution_mode_mismatch");
  assert.equal(simulatorCalls, 0);
  // BoxExecutionRecord, not PaperLeggingExecutionRecord — the two exit paths carry different shapes.
  assert.equal(result.record.filled, false);
  assert.equal(result.record.failure_reason, "execution_mode_mismatch");
  assert.deepEqual(result.record.legs, []);
});

/* ═════════════ B'. RESIDUAL OWNERSHIP IS CARRIED AND HONOURED ═════════════ */

test("B6: a residual restored from another MODE is held and reported, but never flattened here", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  // A live-created residual adopted by this paper process (what boot reconciliation passes through).
  engine.registerResidual("attempt-B6", [residualLeg(9501)], 0, "id-B6", "RELIANCE", {
    mode: "live",
    broker: "zerodha",
  });

  assert.equal(engine.residualLegCount(), 1, "exposure must STILL be counted — the switch guard reads this");
  const mismatches = engine.residualOwnershipMismatches();
  assert.equal(mismatches.length, 1, "the foreign residual must be reported");
  assert.match(mismatches[0].reason, /refusing to SIMULATE flattening real broker exposure/);

  engine.dispose();
});

test("B7: a residual restored from another BROKER is not flattened by the active one", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy, { broker: "zerodha" });

  engine.registerResidual("attempt-B7", [residualLeg(9601)], 0, "id-B7", "RELIANCE", {
    mode: engine.cfg.executionMode,
    broker: "dhan",
  });

  const mismatches = engine.residualOwnershipMismatches();
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0].reason, /order-id spaces are unrelated/);

  engine.dispose();
});

test("B8 (non-vacuous control): a residual created by THIS process is workable", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  engine.registerResidual("attempt-B8", [residualLeg(9701)], 0, "id-B8", "RELIANCE");

  assert.deepEqual(
    engine.residualOwnershipMismatches(),
    [],
    "this process's own residual must be workable — otherwise B6/B7 are vacuous",
  );

  engine.dispose();
});

/* ═════════════ C. AN UNREADABLE RESIDUAL PICTURE REFUSES ENTRY, NOT REDUCTION ═════════════ */

test("C1: an unreadable residual picture REFUSES ENTRY and names itself", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  engine.residualRecoveryLoadError = "connection terminated unexpectedly";

  const verdict = engine.entryGateVerdict();
  assert.equal(verdict.allowed, false, "entry must be refused while residual exposure is unknown");
  assert.equal(verdict.reason, "residual_state_unknown");
  assert.match(verdict.detail, /Unknown is not none/);

  engine.dispose();
});

test("C2 (non-vacuous control): a readable residual picture does not refuse entry for this reason", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  engine.residualRecoveryLoadError = null;

  const verdict = engine.entryGateVerdict();
  assert.notEqual(
    verdict.reason,
    "residual_state_unknown",
    "a readable picture must not raise this refusal — otherwise C1 is vacuous",
  );

  engine.dispose();
});

test("C3: the unknown-residual refusal is ENTRY-scoped, so reduction is never blocked by it", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  engine.residualRecoveryLoadError = "permission denied for table box_execution_attempts";

  const decision = engine.operationalReadiness();
  const blocker = decision.blockers.find((b) => b.code === "residual_state_unknown");
  assert.ok(blocker, "the condition must appear in the ONE authoritative readiness decision");
  assert.equal(
    blocker.scope,
    "entry",
    "not knowing what exposure exists must never become a reason exposure cannot be REDUCED",
  );
  assert.match(blocker.detail, /permission denied/, "the operator needs the actual cause");

  engine.dispose();
});

test("C4: exposure this process must not execute is published as a REDUCTION blocker", async () => {
  const spy = feedSpy();
  const engine = await makeEngine(spy);

  engine.registerResidual("attempt-C4", [residualLeg(9801)], 0, "id-C4", "RELIANCE", {
    mode: "live",
    broker: "zerodha",
  });

  const decision = engine.operationalReadiness();
  const blocker = decision.blockers.find((b) => b.code === "execution_mode_mismatch");
  assert.ok(blocker, "a position/residual this process cannot close must be named");
  assert.equal(
    blocker.scope,
    "reduction",
    "a real position that cannot be closed here is the most serious scope there is",
  );

  engine.dispose();
});
