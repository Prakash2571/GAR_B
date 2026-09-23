/**
 * The position monitor: automatic exits, the refusal to fake an exit without
 * liquidity, manual close, expiry safety, and the guarantee that monitoring is
 * independent of the scanner's RUN state.
 *
 * Exit charges are now priced by the LOCAL calculator synchronously, and the
 * fill goes through the execution simulator (paper_touch here for determinism;
 * paper_latency is exercised in execution.test.mjs).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BoxPositionMonitor,
  describeLiquidityGap,
  liquidityGapKey,
} from "../../dist/box/positionMonitor.js";
import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxPositionBook } from "../../dist/box/positions.js";
import { BoxScanner } from "../../dist/box/scanner.js";
import { BoxChargeEstimator } from "../../dist/box/charges.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import {
  GOOD_BOX,
  LOT,
  cfg,
  chargeStub,
  exitQuotes,
  goodCandidate,
  localChargesStub,
  seedStore,
} from "./helpers.mjs";

/**
 * A monitor holding one open box, with the exit book set to produce a chosen
 * exit box value per unit.
 */
function harness({
  exitValuePerUnit = 198,
  qty = 150,
  entryCost = GOOD_BOX.costPerUnit,
  entryNetEdge = 1425,
  exitFees = 150,
  ageMs = 0,
  expiry = "2026-09-24",
  istDay = "2026-08-29",
  istMinutes = 11 * 60,
  marketOpen = true,
  feedHealthy = true,
  config = {},
} = {}) {
  const { candidate } = goodCandidate();
  const conf = cfg(config);
  const now = Date.now();
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, exitValuePerUnit, { at: now - ageMs, qty }), now - ageMs);

  const positions = new BoxPositionBook();
  const localCharges = localChargesStub({ entryTotal: exitFees, exitTotal: exitFees });

  let mktOpen = marketOpen;
  let feedOk = feedHealthy;
  const executionSim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => mktOpen,
    isFeedHealthy: () => feedOk,
  });

  const position = {
    id: "box1",
    key: candidate.key,
    underlying: candidate.underlying,
    name: candidate.name,
    is_index: candidate.is_index,
    expiry,
    direction: "LONG_BOX",
    lower_strike: candidate.lower_strike,
    upper_strike: candidate.upper_strike,
    box_width: candidate.box_width,
    lot_size: LOT,
    quantity: LOT,
    entry_box_cost_per_unit: entryCost,
    entry_gross_edge: GOOD_BOX.grossEdge,
    entry_net_edge: entryNetEdge,
    entry_charges_total: 150,
    estimated_exit_charges_total: 150,
    safety_buffer: 150,
    expected_net_profit: entryNetEdge,
    entry_execution_cost: 0,
    charge_origin: "local",
    entry_execution: null,
    margin: null,
    opened_at: now - 60_000,
    legs: candidate.legs,
    entry_prices: { k1_ce: 300, k2_ce: 220, k2_pe: 200, k1_pe: 105 },
    metrics: null,
    exit_blocked_reason: null,
    expiry_safety: false,
    closing: false,
    last_persist_at: now,
    config: {},
  };
  positions.add(position);

  const closes = [];
  const events = [];
  const persisted = [];
  const monitor = new BoxPositionMonitor({
    cfg: conf,
    quotes,
    localCharges,
    executionSim,
    positions,
    closePaperTrade: async (args) => {
      closes.push(args);
      positions.remove(args.position.id);
      return true;
    },
    persistLive: async (pos) => {
      persisted.push(pos.id);
    },
    onEvent: (event, pos, metrics, detail) => events.push({ event, detail, metrics }),
    istDayKey: () => istDay,
    istMinutesOfDay: () => istMinutes,
    isMarketOpen: () => mktOpen,
    isFeedHealthy: () => feedOk,
  });

  return {
    monitor,
    positions,
    position,
    candidate,
    closes,
    events,
    persisted,
    conf,
    quotes,
    setMarket: (v) => (mktOpen = v),
    setFeed: (v) => (feedOk = v),
  };
}

/* -------------------------------------------------------------- auto exit --- */

test("a converged, comfortably profitable box is closed automatically", async () => {
  const h = harness({ exitValuePerUnit: 198 });
  await h.monitor.cycle();

  assert.equal(h.closes.length, 1);
  const { metrics, reason } = h.closes[0];
  assert.equal(reason, "EDGE_CONVERGED");
  assert.equal(metrics.remaining_edge, (200 - 198) * LOT);
  assert.ok(metrics.current_net_pnl >= 600);
  assert.equal(h.positions.size, 0);
  assert.ok(h.events.some((e) => e.event === "EXIT_TRIGGERED"));
  // The captured-edge convergence figures are populated.
  assert.equal(metrics.captured_edge, metrics.entry_edge - metrics.remaining_edge);
  assert.ok(metrics.captured_pct > 0);
});

test("a WebSocket leg update evaluates and closes immediately without waiting for the watchdog", async () => {
  const h = harness({ exitValuePerUnit: 198 });
  h.monitor.onTokensUpdated([h.candidate.legs.k1_ce.token]);
  await h.monitor.cycle();

  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "EDGE_CONVERGED");
  assert.equal(h.positions.size, 0);
});

test("the exit fill records the executable touches with their depth", async () => {
  const h = harness({ exitValuePerUnit: 198 });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 1);
  const closed = h.closes[0];
  assert.equal(closed.metrics.exit_box_value_per_unit, 198);
  assert.equal(closed.metrics.legs.every((leg) => leg.qty_at_touch >= LOT), true);
  // The execution record and per-leg depth are attached for the audit trail.
  assert.ok(closed.execution, "an execution record is attached");
  for (const leg of closed.metrics.legs) {
    assert.ok(leg.depth, "the fill depth is captured");
    const side = leg.side === "BUY" ? leg.depth.asks : leg.depth.bids;
    assert.ok(side.some((level) => level.price === leg.price));
  }
});

test("23/24. a converged box that is unprofitable or under ₹600 is left open", async () => {
  const losing = harness({ exitValuePerUnit: 198, entryCost: 199 });
  await losing.monitor.cycle();
  assert.equal(losing.closes.length, 0, "never close at a loss");
  assert.equal(losing.positions.size, 1);
  // The block is exposed as a held reason, not hidden.
  assert.equal(losing.position.metrics.blocked_reason, "net_below_floor");

  const thin = harness({ exitValuePerUnit: 198, entryCost: 191 });
  await thin.monitor.cycle();
  assert.equal(thin.closes.length, 0, "below the ₹600 floor");
  assert.equal(thin.positions.size, 1);
  assert.equal(thin.position.metrics.current_net_pnl, 225);
});

test("25. the 75% profit-capture rule closes a box whose edge has not converged", async () => {
  const h = harness({ exitValuePerUnit: 190, entryNetEdge: 1000 });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "PROFIT_CAPTURE");
  assert.ok(h.closes[0].metrics.remaining_edge > h.closes[0].metrics.convergence_threshold);
});

/* -------------------------------------------------------------------- 26 --- */

test("26. without one-lot touch liquidity the exit is SKIPPED and the box stays open", async () => {
  const h = harness({ exitValuePerUnit: 198, qty: 40 });
  await h.monitor.cycle();

  assert.equal(h.closes.length, 0, "an exit must never be faked");
  assert.equal(h.positions.size, 1, "the position stays open");
  const skipped = h.events.filter((e) => e.event === "EXIT_SKIPPED_LIQUIDITY");
  assert.equal(skipped.length, 1);
  assert.match(h.position.exit_blocked_reason, /needs 75/);
  assert.ok(h.position.metrics.remaining_edge !== null);
  await h.monitor.cycle();
  assert.equal(h.positions.size, 1);
});

test("a book quiet for a few seconds is still valid and DOES close", async () => {
  const h = harness({ exitValuePerUnit: 198, ageMs: 5000 });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "EDGE_CONVERGED");
});

test("a book quiet beyond the trust window DOES block the exit", async () => {
  const h = harness({ exitValuePerUnit: 198, ageMs: 20_000 });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 0);
  assert.equal(h.positions.size, 1);
  assert.match(h.position.exit_blocked_reason ?? "", /stale/);
});

test("a DEAD feed pauses exits without pretending it is a liquidity problem", async () => {
  const h = harness({ exitValuePerUnit: 198, feedHealthy: false });
  await h.monitor.cycle();

  assert.equal(h.closes.length, 0, "no exit on books of unknown age");
  assert.equal(h.positions.size, 1);
  assert.ok(h.position.metrics);

  // THE ORIGINAL INTENT, UNCHANGED: a dead feed is not a thin book. Labelling it a liquidity skip
  // would send the operator looking at depth that is simply unobserved.
  assert.equal(
    h.events.filter((e) => e.event === "EXIT_SKIPPED_LIQUIDITY").length, 0,
    "a dead feed must NOT be reported as a liquidity problem",
  );

  /*
   * THE ADDED REQUIREMENT: it must not be SILENT either.
   *
   * This previously asserted `events.length === 0` and `exit_blocked_reason === null`, which pinned the
   * defect rather than the intent: the monitor returned above its liquidity gate, so a feed outage
   * recorded nothing at all. An operator watching a position through an outage saw no reason, and on
   * expiry day the EXPIRY_SAFETY alarm demanded an exit that was blocked with no explanation.
   *
   * Blocked-but-not-by-the-market goes on the ERROR channel, the same one the RECOVERY block uses.
   */
  assert.equal(
    typeof h.position.exit_blocked_reason, "string",
    "the position must carry WHY it is not being reduced",
  );
  assert.match(h.position.exit_blocked_reason, /feed/i);
  assert.match(
    h.position.exit_blocked_reason, /still owned|still monitored/i,
    "and it must say the exposure is unchanged rather than implying anything was resolved",
  );
  const errors = h.events.filter((e) => e.event === "ERROR");
  assert.equal(errors.length, 1, "exactly one ERROR event, not one per cycle");
  assert.match(errors[0].detail, /feed/i);

  // Deduplicated: a dead socket must not flood the event ledger.
  await h.monitor.cycle();
  await h.monitor.cycle();
  assert.equal(
    h.events.filter((e) => e.event === "ERROR").length, 1,
    "repeated cycles under one unchanged outage must not repeat the event",
  );

  const back = harness({ exitValuePerUnit: 198, feedHealthy: true });
  await back.monitor.cycle();
  assert.equal(back.closes.length, 1);
});

test("describeLiquidityGap names the leg and the shortfall", () => {
  const legs = [
    { role: "k1_ce", side: "SELL", tradingsymbol: "A", price: 10, qty_at_touch: 40, fresh: true, quote_at: 1, age_ms: 5 },
    { role: "k2_ce", side: "BUY", tradingsymbol: "B", price: 10, qty_at_touch: 200, fresh: true, quote_at: 1, age_ms: 5 },
    { role: "k2_pe", side: "SELL", tradingsymbol: "C", price: null, qty_at_touch: 0, fresh: true, quote_at: 1, age_ms: 5 },
    { role: "k1_pe", side: "BUY", tradingsymbol: "D", price: 10, qty_at_touch: 200, fresh: false, quote_at: 1, age_ms: 9000 },
  ];
  const text = describeLiquidityGap(legs, 75);
  assert.match(text, /A shows 40 at 10 \(needs 75\)/);
  assert.match(text, /C has no bid/);
  assert.match(text, /D book is stale/);
  assert.doesNotMatch(text, /\bB\b/);
});

/* -------------------------------------------------------------------- 27 --- */

test("27. manual close fills at the current executable touch", async () => {
  const h = harness({ exitValuePerUnit: 180, entryNetEdge: 1425 });
  const pre = h.monitor.measure(h.position);
  assert.equal(pre.exit_eligible, false, "no automatic exit is due");

  const result = await h.monitor.closeManually("box1");
  assert.equal(result.ok, true);
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "MANUAL");
  const byRole = new Map(h.closes[0].metrics.legs.map((l) => [l.role, l]));
  assert.equal(byRole.get("k1_ce").side, "SELL");
  assert.equal(byRole.get("k2_ce").side, "BUY");
  assert.equal(h.closes[0].metrics.exit_box_value_per_unit, 180);
  assert.equal(h.positions.size, 0);
});

test("27. manual close REFUSES rather than inventing a price when the market is not there", async () => {
  const h = harness({ exitValuePerUnit: 198, qty: 40 });
  const result = await h.monitor.closeManually("box1");

  assert.equal(result.ok, false);
  assert.equal(result.code, 409);
  assert.match(result.error, /Cannot close at an executable price/);
  assert.match(result.error, /still open and being monitored/);
  assert.equal(h.closes.length, 0);
  assert.equal(h.positions.size, 1, "refusing must leave the position open");
  assert.ok(h.events.some((e) => e.event === "EXIT_SKIPPED_LIQUIDITY"));
});

test("manual close of an unknown position is a 404, not a crash", async () => {
  const h = harness();
  const result = await h.monitor.closeManually("nope");
  assert.equal(result.ok, false);
  assert.equal(result.code, 404);
});

/* -------------------------------------------------------------------- 30 --- */

test("30. STOP stops discovery but the monitor keeps managing and exiting", async () => {
  const h = harness({ exitValuePerUnit: 198 });

  const scanner = new BoxScanner({
    cfg: h.conf,
    quotes: new BoxQuoteStore(),
    charges: new BoxChargeEstimator(chargeStub({}).fn, h.conf),
    localCharges: localChargesStub(),
    executionSim: new BoxExecutionSimulator({
      cfg: h.conf,
      quotes: new BoxQuoteStore(),
      isMarketOpen: () => true,
      isFeedHealthy: () => true,
    }),
    positions: h.positions,
    openPaperTrade: async () => {
      throw new Error("discovery must not run while stopped");
    },
    onEvent: () => {},
  });
  scanner.setDiscovering(false);
  assert.equal(scanner.isDiscovering(), false);
  assert.equal(h.positions.size, 1, "the open box survives STOP");

  await h.monitor.cycle();
  assert.equal(h.closes.length, 1, "the open box still auto-exits while stopped");
  assert.equal(h.closes[0].reason, "EDGE_CONVERGED");
  assert.equal(h.positions.size, 0);
});

test("the monitor keeps refreshing metrics and periodically persists them", async () => {
  const h = harness({ exitValuePerUnit: 180 });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 0);
  assert.ok(h.position.metrics, "metrics are refreshed every cycle");
  assert.equal(h.position.metrics.exit_box_value_per_unit, 180);

  h.position.last_persist_at = 0;
  await h.monitor.cycle();
  assert.deepEqual(h.persisted, ["box1"]);
  assert.ok(h.monitor.getStats().cycles >= 2);
});

test("cycles never overlap, so a slow evaluation cannot double-close a box", async () => {
  const h = harness({ exitValuePerUnit: 198 });
  await Promise.all([h.monitor.cycle(), h.monitor.cycle(), h.monitor.cycle()]);
  assert.equal(h.closes.length, 1);
});

/* ----------------------------- expiry safety ------------------------------ */

test("the expiry-safety window is entered on expiry day near the close", async () => {
  const h = harness({
    exitValuePerUnit: 180,
    expiry: "2026-08-29",
    istDay: "2026-08-29",
    istMinutes: 15 * 60,
  });
  await h.monitor.cycle();

  assert.equal(h.position.expiry_safety ?? false, true);
  assert.ok(h.events.some((e) => e.event === "EXPIRY_SAFETY"));
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "EXPIRY_SAFETY");
});

test("expiry safety still refuses to invent prices when the touch is not there", async () => {
  const h = harness({
    exitValuePerUnit: 180,
    qty: 40,
    expiry: "2026-08-29",
    istDay: "2026-08-29",
    istMinutes: 15 * 60,
  });
  await h.monitor.cycle();

  assert.equal(h.closes.length, 0, "no fabricated expiry close");
  assert.equal(h.positions.size, 1);
  assert.ok(h.events.some((e) => e.event === "EXPIRY_SAFETY"));
  assert.ok(h.events.some((e) => e.event === "EXIT_SKIPPED_LIQUIDITY"));
  assert.ok(h.position.exit_blocked_reason, "the condition is exposed, not hidden");
});

test("a box expiring later is not in the expiry-safety window", async () => {
  const h = harness({
    exitValuePerUnit: 180,
    expiry: "2026-09-24",
    istDay: "2026-08-29",
    istMinutes: 15 * 60,
  });
  await h.monitor.cycle();
  assert.equal(h.position.expiry_safety, false);
  assert.equal(h.closes.length, 0);
});

test("a position whose expiry has ALREADY PASSED is flagged and escalated, not forgotten", async () => {
  /*
   * THE PREDICATE WAS AN EQUALITY: `if (pos.expiry !== istDayKey()) return false;`.
   *
   * So the only day expiry safety could ever fire was the expiry date itself. A position that
   * survived past it — the process was down across expiry, or the exit was refused for liquidity
   * right to the bell (which the test above shows is a real and deliberate outcome) — fell
   * PERMANENTLY out of the window on D+1. Never force-exited, never flagged, never escalated. It sat
   * in the book indefinitely, marking against a contract that no longer existed.
   *
   * It is also the most expensive state the system can be in. The box has gone to settlement, and
   * exercise STT of 0.15% of intrinsic value is payable on every in-the-money LONG leg — a box always
   * has in-the-money legs, and the cost is unbounded in how far the underlying travelled. The one
   * position nobody was told about is the one whose cost cannot be bounded.
   */
  const h = harness({
    exitValuePerUnit: 180,
    expiry: "2026-08-28",
    istDay: "2026-08-29", // D+1: the contract expired YESTERDAY
    istMinutes: 11 * 60, // and the time of day is irrelevant — it is already past settlement
  });
  await h.monitor.cycle();

  assert.equal(h.position.expiry_safety, true, "an expired position must be in the safety state");
  const event = h.events.find((e) => e.event === "EXPIRY_SAFETY");
  assert.ok(event, "it must be escalated, not silently dropped");
  assert.match(
    event.detail, /STILL OPEN|settlement/i,
    "the message must say the contract expired and the position went to settlement, rather than " +
      "reusing the ordinary 'entered the window' wording",
  );
});

test("expiry safety is detected and ALERTED even when the feed is dead", async () => {
  /*
   * Detection used to sit BELOW `if (!this.deps.isFeedHealthy()) return;`, so a feed outage at 14:45
   * on expiry day skipped the deadline entirely: `expiry_safety` was never set and no EXPIRY_SAFETY
   * event was ever emitted. The alarm was suppressed at exactly the moment it mattered most —
   * settlement approaching on a position the engine cannot price.
   *
   * The window is pure clock arithmetic, so it can always be evaluated. Only the EXECUTION of the
   * exit needs a live book, and that is still correctly withheld here.
   */
  const h = harness({
    exitValuePerUnit: 180,
    expiry: "2026-08-29",
    istDay: "2026-08-29",
    istMinutes: 15 * 60,
    feedHealthy: false,
  });
  await h.monitor.cycle();

  assert.equal(h.position.expiry_safety, true, "the deadline is detected without a feed");
  assert.ok(
    h.events.some((e) => e.event === "EXPIRY_SAFETY"),
    "and the operator is woken up — they can still act manually",
  );
  assert.equal(h.closes.length, 0, "but nothing is executed against a book we cannot see");

  /*
   * AND THE BLOCKED REASON IS NOW THERE TOO, alongside the alarm.
   *
   * This is the pairing that used to be missing and that made the outage hardest to act on: the alarm
   * said "settlement is approaching on this position" and the next four lines silently refused to do
   * anything about it. Both must be present, and the reason must name the remaining route.
   */
  assert.ok(
    h.events.some((e) => e.event === "EXPIRY_SAFETY"),
    "the expiry alarm must survive the outage",
  );
  assert.equal(
    typeof h.position.exit_blocked_reason, "string",
    "and the position must also carry WHY the exit the alarm demands is not happening",
  );
  assert.match(h.position.exit_blocked_reason, /broker terminal/i);
});

test("expiry safety is detected even when the market is closed", async () => {
  // Same reasoning as the feed case: if a box has survived to a closed market on its expiry day, the
  // operator needs to know it has gone to settlement. Refreshing metrics silently is not enough.
  const h = harness({
    exitValuePerUnit: 180,
    expiry: "2026-08-29",
    istDay: "2026-08-29",
    istMinutes: 15 * 60,
    marketOpen: false,
  });
  await h.monitor.cycle();

  assert.equal(h.position.expiry_safety, true);
  assert.ok(h.events.some((e) => e.event === "EXPIRY_SAFETY"));
  assert.equal(h.closes.length, 0, "a closed market is not a liquidity event");
});

/* ---------------------------- market closed ------------------------------- */

test("market CLOSED: metrics keep refreshing but no exit is attempted", async () => {
  const h = harness({ exitValuePerUnit: 198, marketOpen: false });
  await h.monitor.cycle();

  assert.equal(h.closes.length, 0, "there is nothing to close into after hours");
  assert.equal(h.positions.size, 1);
  assert.ok(h.position.metrics, "metrics are still refreshed");
  assert.equal(h.position.metrics.remaining_edge, (200 - 198) * LOT);
  assert.equal(h.events.length, 0);
  assert.equal(h.position.exit_blocked_reason, null);
});

test("market CLOSED does not fabricate an expiry-safety close either", async () => {
  const h = harness({
    exitValuePerUnit: 180,
    expiry: "2026-08-29",
    istDay: "2026-08-29",
    istMinutes: 16 * 60,
    marketOpen: false,
  });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 0);
  assert.equal(h.positions.size, 1);
});

/* --------------------------- ledger de-duplication ------------------------ */

test("a persistent liquidity gap is logged once, not once per cycle", async () => {
  const h = harness({ exitValuePerUnit: 198, qty: 40 });

  for (let i = 0; i < 5; i++) await h.monitor.cycle();

  const skipped = h.events.filter((e) => e.event === "EXIT_SKIPPED_LIQUIDITY");
  assert.equal(skipped.length, 1, "the same blockage must not spam the ledger");
  assert.equal(h.positions.size, 1);
  assert.match(h.position.exit_blocked_reason, /needs 75/);
});

test("liquidityGapKey is stable across cycles but changes when the cause does", () => {
  const base = (over = {}) => ({
    role: "k1_ce",
    side: "SELL",
    tradingsymbol: "A",
    price: 10,
    qty_at_touch: 40,
    fresh: true,
    quote_at: 1,
    age_ms: 5,
    ...over,
  });
  const ok = { role: "k2_ce", side: "BUY", tradingsymbol: "B", price: 10, qty_at_touch: 200, fresh: true, quote_at: 1, age_ms: 5 };

  const a = liquidityGapKey([base({ age_ms: 5 }), ok], 75);
  const b = liquidityGapKey([base({ age_ms: 900, qty_at_touch: 41 }), ok], 75);
  assert.equal(a, b);
  assert.equal(a, "k1_ce:thin");

  const stale = liquidityGapKey([base({ fresh: false }), ok], 75);
  assert.notEqual(stale, a);
  assert.equal(stale, "k1_ce:stale");

  assert.equal(liquidityGapKey([base({ qty_at_touch: 200 }), ok], 75), "ok");
});
