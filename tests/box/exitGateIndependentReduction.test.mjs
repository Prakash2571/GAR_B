/**
 * THE PRODUCTION CALLER CHAIN — the position monitor must let an independently reducible exit
 * REACH the gateway.
 *
 * WHY THIS IS A SEPARATE DEFECT FROM tests/box/exitLegIsolation.test.mjs
 * That file proves `simulateLeggingExit` now isolates per leg. But in production nothing calls
 * `simulateLeggingExit` directly: the chain is
 *
 *     BoxPositionMonitor.cycle() → evaluate → runExit → runLeggingExit
 *                                → deps.executionSim.simulateLeggingExit(...)
 *
 * and `runExit` is guarded by `exitExecutionOk`, which was:
 *
 *     return est.every((e) => e.fresh && e.executable >= e.remaining);
 *
 * `estimateExecutableExit` reports `{ executable: 0, fresh: false }` for a role whose book is
 * missing, so ONE unusable leg made the predicate false, `evaluate` returned at the
 * EXIT_SKIPPED_LIQUIDITY branch, and the gateway was NEVER CALLED. The per-leg isolation inside the
 * gateway was therefore unreachable in production, and a risk-reducing close on a leg with perfectly
 * good depth was suppressed by an unrelated leg.
 *
 * WHAT THE GATE IS AND IS NOT. `exitExecutionOk` only decides whether an attempt is worth making.
 * It does NOT decide what is transmitted: the gateway prechecks every leg individually and the order
 * manager re-validates at CHECKPOINT 3 (dequeue) and CHECKPOINT 5 (immediately pre-POST). Relaxing
 * it from `every` to `some` therefore cannot send anything against an unusable book — proven by
 * tests/box/exitLegIsolation.test.mjs — it can only stop the monitor refusing to look.
 *
 * `paper_legging` deliberately KEEPS `every`: its simulator resolves a wave as one unit and has no
 * per-leg withholding, so admitting a partially executable position there would model an execution
 * the paper executor cannot perform. That difference is asserted below so it cannot silently drift.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxPositionMonitor } from "../../dist/box/positionMonitor.js";
import { BoxPositionBook } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import {
  LOT,
  cfg,
  exitQuotes,
  goodCandidate,
  localChargesStub,
  positionFrom,
  seedStore,
} from "./helpers.mjs";

/**
 * A monitor holding one open box, with a STUB execution simulator whose executable-exit estimate is
 * supplied by the test.
 *
 * The stub is the seam this defect lives at: `exitExecutionOk` consults
 * `estimateExecutableExit` and nothing else, and the question under test is purely whether
 * `simulateLeggingExit` is reached.
 */
function harness({ executionMode, estimate }) {
  const { candidate } = goodCandidate();
  const conf = cfg({ executionMode, liveTradingEnabled: executionMode === "live" });
  const now = Date.now();
  const quotes = new BoxQuoteStore();
  // A converged, comfortably profitable book, so the profitability gate is satisfied and the only
  // thing that can stop the exit is the executable-liquidity gate.
  seedStore(quotes, exitQuotes(candidate, 198, { at: now, qty: 150 }), now);

  const positions = new BoxPositionBook();
  const position = positionFrom(candidate, { opened_at: now - 60_000, last_persist_at: now });
  positions.add(position);

  const exitCalls = [];
  const executionSim = {
    estimateExecutableExit: () => estimate,
    simulateLeggingExit: async (args) => {
      exitCalls.push(args);
      // A partial outcome with nothing confirmed closed: the position stays open and the monitor
      // records the blocked reason. Enough to prove the call happened without dragging the durable
      // partial-exit projection into this test.
      return {
        ok: false,
        record: {
          mode: "live",
          detected_at: args.detectedAt,
          completed_at: args.detectedAt + 1,
          legs: [],
          submitted: 2,
          filled: 0,
          aborted: false,
        },
        reason: "legging_incomplete",
        detail: "live exit preserved required hedge cover: k1_ce held back 75 covering k2_ce",
        legs: [],
        booksAtFill: new Map(),
      };
    },
    simulateExit: async () => { throw new Error("not used"); },
    hasCapacity: () => false,
  };

  const events = [];
  const closes = [];
  const monitor = new BoxPositionMonitor({
    cfg: conf,
    quotes,
    localCharges: localChargesStub({ entryTotal: 150, exitTotal: 150 }),
    executionSim,
    positions,
    closePaperTrade: async (args) => { closes.push(args); positions.remove(args.position.id); return true; },
    persistLive: async () => {},
    persistPartialExit: async () => true,
    onEvent: (event, pos, metrics, detail) => events.push({ event, detail }),
    istDayKey: () => "2026-08-29",
    istMinutesOfDay: () => 11 * 60,
    isMarketOpen: () => true,
    isFeedHealthy: () => true,
  });

  return { monitor, positions, position, events, closes, exitCalls, quotes, candidate };
}

/** Every outstanding role can execute its full remaining quantity. */
const allExecutable = [
  { role: "k1_ce", side: "SELL", remaining: LOT, executable: LOT, fresh: true },
  { role: "k2_ce", side: "BUY", remaining: LOT, executable: LOT, fresh: true },
  { role: "k2_pe", side: "SELL", remaining: LOT, executable: LOT, fresh: true },
  { role: "k1_pe", side: "BUY", remaining: LOT, executable: LOT, fresh: true },
];

/**
 * ONE role has no book at all — exactly what `estimateExecutableExit` reports when
 * `quotes.get(token)` is undefined — while the other three are fully executable.
 */
const oneLegUnavailable = [
  { role: "k1_ce", side: "SELL", remaining: LOT, executable: LOT, fresh: true },
  { role: "k2_ce", side: "BUY", remaining: LOT, executable: 0, fresh: false },
  { role: "k2_pe", side: "SELL", remaining: LOT, executable: LOT, fresh: true },
  { role: "k1_pe", side: "BUY", remaining: LOT, executable: LOT, fresh: true },
];

/** Nothing is executable anywhere: there is genuinely no work to attempt. */
const noneExecutable = allExecutable.map((leg) => ({ ...leg, executable: 0, fresh: false }));

test("LIVE: a fully executable exit reaches the gateway (control)", async () => {
  const h = harness({ executionMode: "live", estimate: allExecutable });
  await h.monitor.cycle();
  assert.equal(h.exitCalls.length, 1, "the exit reached simulateLeggingExit");
});

test("LIVE: one unavailable leg no longer suppresses the whole exit attempt", async () => {
  const h = harness({ executionMode: "live", estimate: oneLegUnavailable });
  await h.monitor.cycle();

  assert.equal(
    h.exitCalls.length,
    1,
    "three legs are independently executable, so the exit MUST reach the gateway — " +
      "the gateway then withholds only the leg whose book is unusable",
  );
  // The position is not closed and the operator is told why the attempt was incomplete.
  assert.equal(h.positions.size, 1, "nothing was closed: no leg confirmed a fill");
  assert.ok(
    h.position.exit_blocked_reason !== null || h.events.length > 0,
    "the incomplete attempt is reported rather than being silent",
  );
});

test("LIVE: an exit with NOTHING executable is still skipped, without calling the gateway", async () => {
  const h = harness({ executionMode: "live", estimate: noneExecutable });
  await h.monitor.cycle();

  assert.equal(
    h.exitCalls.length,
    0,
    "with no executable leg anywhere there is no independent reduction to attempt; " +
      "the gate must still refuse rather than churn the broker",
  );
  assert.ok(
    h.events.some((event) => event.event === "EXIT_SKIPPED_LIQUIDITY"),
    "and it is recorded as a liquidity skip",
  );
});

test("LIVE: an empty executable estimate is refused (fail closed)", async () => {
  const h = harness({ executionMode: "live", estimate: [] });
  await h.monitor.cycle();
  assert.equal(h.exitCalls.length, 0, "no estimate is not evidence of executability");
});

test("PAPER_LEGGING: the whole-position gate is UNCHANGED — one unavailable leg still skips", async () => {
  const h = harness({ executionMode: "paper_legging", estimate: oneLegUnavailable });
  await h.monitor.cycle();

  assert.equal(
    h.exitCalls.length,
    0,
    "paper_legging resolves a wave as one unit and has no per-leg withholding, so its gate " +
      "deliberately still requires EVERY outstanding role to be executable",
  );
  assert.ok(h.events.some((event) => event.event === "EXIT_SKIPPED_LIQUIDITY"));
});

test("PAPER_LEGGING: a fully executable exit still reaches the simulator (control)", async () => {
  const h = harness({ executionMode: "paper_legging", estimate: allExecutable });
  await h.monitor.cycle();
  assert.equal(h.exitCalls.length, 1);
});
