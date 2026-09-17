/**
 * BOX_MAX_OPEN_BOXES — THE MODE-INDEPENDENT INVENTORY CEILING.
 *
 * WHY THIS CONTROL EXISTS, and why it is not `BOX_LIVE_MAX_OPEN_BOXES`.
 *
 * The live cap lives in `BoxOrderManager`, which is constructed only on the live path. That gives it
 * two properties this ceiling deliberately does not share:
 *
 *   1. it is INVISIBLE in every paper mode, so a paper rehearsal cannot exercise it — "paper never
 *      breached the cap" is evidence about nothing;
 *   2. it is read from a count the engine refreshes only AFTER a position has been created, so it
 *      cannot refuse the second of two entries admitted in the same instant.
 *
 * The properties asserted here are the ones an operator who cannot afford a second box depends on:
 *
 *   - it refuses in PAPER, not just live;
 *   - it refuses a second box on a DIFFERENT underlying (contract reservations never collide there,
 *     so nothing else would);
 *   - it refuses a SHORT box after a LONG box on the same strikes. Those two share reservation keys
 *     only while both are in flight — once the first settles, its lease is released and the key
 *     collision is gone, so without this ceiling the second one proceeds;
 *   - it counts COMMITTED exposure, not just established positions: an unresolved partial entry is
 *     still capital at risk;
 *   - it counts an in-flight entry pipeline, so two same-tick admissions cannot both pass;
 *   - it does NOT count an exit acquisition, which also lives in `this.active` and must never make a
 *     closing box look like a held one;
 *   - `0` means unlimited, so existing deployments are unaffected.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CoordinatedBoxExecutionGateway } from "../../dist/box/executionCoordinator.js";
import { InProcessInstrumentReservations } from "../../dist/box/instrumentReservations.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg } from "./helpers.mjs";

const NOW = 1_700_000_000_000;

const IDENTITY = {
  deployment: "test",
  instance: "host-w0",
  pid: 1,
  boot: "w0",
  processTag: "host-w0:p1:w0",
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

function boxFor({ underlying = "RELIANCE", k1 = 2500, k2 = 2600, direction = "LONG_BOX" } = {}) {
  const expiry = "2026-09-24";
  const leg = (strike, type) => ({
    token: Number(`${strike}${type === "CE" ? 1 : 2}`),
    tradingsymbol: `${underlying}${expiry.slice(2, 4)}SEP${strike}${type}`,
    exchange: "NFO",
    strike,
    instrument_type: type,
    expiry,
    lot_size: 50,
    tick_size: 0.05,
  });
  return {
    key: `${underlying}|${expiry}|${k1}|${k2}|${direction}`,
    underlying,
    name: underlying,
    is_index: false,
    expiry,
    direction,
    lower_strike: k1,
    upper_strike: k2,
    box_width: k2 - k1,
    lot_size: 50,
    legs: { k1_ce: leg(k1, "CE"), k2_ce: leg(k2, "CE"), k2_pe: leg(k2, "PE"), k1_pe: leg(k1, "PE") },
  };
}

function detectionFor(candidate) {
  return {
    candidate,
    at: NOW,
    legs: BOX_LEG_ROLES.map((role) => ({
      role,
      side: entrySideFor(role, candidate.direction),
      token: candidate.legs[role].token,
      tradingsymbol: candidate.legs[role].tradingsymbol,
      strike: candidate.legs[role].strike,
      instrument_type: candidate.legs[role].instrument_type,
      price: 100,
      qty_at_touch: 50,
      bid: 99, bid_qty: 50, ask: 100, ask_qty: 50,
      quote_at: NOW, exchange_at: null, quote_version: 1, depth: null,
      age_ms: 5, fresh: true, executable: true,
    })),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80,
    gross_edge: 4000,
    tradable: true,
    depth_ok: true,
    worst_age_ms: 5,
    quote_version: 1,
    reject: null,
  };
}

/** A gateway whose entry blocks until the test releases it, so real overlap is testable. */
function controllableGateway({ mode = "paper_legging" } = {}) {
  const gates = new Map();
  let seq = 0;
  return {
    mode,
    finish(index, result) {
      const gate = gates.get(index);
      assert.ok(gate, `no execution at index ${index}`);
      gate(result ?? { ok: true, legging: { residual_exposure: [] } });
    },
    hasCapacity: () => true,
    invariantViolation: () => {},
    estimateExecutableExit: () => [],
    flattenResidual: async () => ({ flattened: {}, remaining: [], charges: 0 }),
    simulateEntry: async () => ({ ok: true }),
    simulateExit: async () => ({ ok: true }),
    simulateLeggingExit: async () => ({ ok: true, record: { residual_exposure: [] } }),
    simulateLeggingEntry() {
      const index = seq++;
      return new Promise((resolve) => gates.set(index, resolve));
    },
  };
}

/** `inventory` is a mutable box so a test can grow the engine-side count mid-run. */
function makeCoordinator({ gateway, config = {}, inventory = { value: 0 } } = {}) {
  const local = new InProcessInstrumentReservations();
  const clock = { value: NOW };
  const coordinator = new CoordinatedBoxExecutionGateway({
    inner: gateway,
    reservations: local,
    local,
    waitable: local,
    cfg: cfg({
      conflictWaitMaxMs: 0,
      instrumentLockTtlMs: 5000,
      maxConcurrentPerUnderlying: 0,
      oneActiveBoxPerUnderlying: false,
      reservationClockSkewGraceMs: 0,
      durableReservationsEnabled: false,
      ...config,
    }),
    quotes: { view: () => new Map() },
    broker: () => "zerodha",
    generation: () => 1,
    identity: IDENTITY,
    now: () => clock.value,
    boxInventory: () => inventory.value,
    sleep: (ms) => {
      clock.value += Math.max(1, Math.round(ms));
      return new Promise((resolve) => setImmediate(resolve));
    },
    setTimer: () => null,
    clearTimer: () => {},
    log: () => {},
  });
  return { coordinator, inventory, clock, local };
}

/* ─────────────────────────── the ceiling refuses ─────────────────────────── */

test("PAPER: a second box on a DIFFERENT underlying is refused once the ceiling is met", async () => {
  const gateway = controllableGateway();
  const { coordinator, inventory } = makeCoordinator({ gateway, config: { maxOpenBoxes: 1 } });

  // One box is already held durably — nothing is in flight.
  inventory.value = 1;

  const candidate = boxFor({ underlying: "INFY", k1: 1500, k2: 1600 });
  const result = await coordinator.simulateLeggingEntry({
    candidate,
    detection: detectionFor(candidate),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "box_inventory_limit", "the refusal must name the inventory ceiling");
  assert.match(result.detail, /BOX_MAX_OPEN_BOXES=1/);
  assert.match(result.detail, /1 durable/);
  assert.match(
    result.detail,
    /Exits, reductions and protective cancels are unaffected/,
    "the refusal must state that reduction is not blocked",
  );
  assert.equal(coordinator.metrics().inventoryLimitRefusals, 1);
});

test("a SHORT box is refused after a LONG box on the SAME strikes — the key collision is gone by then", async () => {
  const gateway = controllableGateway();
  const { coordinator, inventory } = makeCoordinator({ gateway, config: { maxOpenBoxes: 1 } });

  const long = boxFor({ direction: "LONG_BOX", k1: 2500, k2: 2600 });
  const entry = coordinator.simulateLeggingEntry({ candidate: long, detection: detectionFor(long) });
  await settle();
  // The LONG box completes cleanly, which RELEASES its four contract reservations. From here the
  // SHORT box shares no lease with it, and its candidate key differs, so neither the reservation
  // layer nor the duplicate guard would stop it.
  gateway.finish(0, { ok: true, legging: { residual_exposure: [], trade_id: "t1" } });
  await entry;
  inventory.value = 1; // the engine has now recorded the open position

  const short = boxFor({ direction: "SHORT_BOX", k1: 2500, k2: 2600 });
  const result = await coordinator.simulateLeggingEntry({
    candidate: short,
    detection: detectionFor(short),
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    "box_inventory_limit",
    "the opposite direction on the same strikes must be refused by the ceiling",
  );
  assert.match(result.detail, /in either direction/);
});

test("an IN-FLIGHT entry pipeline counts, so two same-tick admissions cannot both pass", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway, config: { maxOpenBoxes: 1 } });

  // Nothing durable yet — this is exactly the window BOX_LIVE_MAX_OPEN_BOXES cannot see.
  const a = boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2600 });
  const b = boxFor({ underlying: "INFY", k1: 1500, k2: 1600 });

  const first = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a) });
  const second = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b) });
  await settle();

  const secondResult = await second;
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.reason, "box_inventory_limit");
  assert.match(secondResult.detail, /1 entry pipeline\(s\) in flight/);

  gateway.finish(0);
  await first;
});

test("an unresolved PARTIAL entry still counts — a half-filled box is capital at risk", async () => {
  const gateway = controllableGateway();
  const { coordinator, inventory } = makeCoordinator({ gateway, config: { maxOpenBoxes: 1 } });

  // No open POSITION, but the engine reports one unit of committed exposure (a residual attempt).
  // A ceiling that counted only established positions would admit a second box on top of this.
  inventory.value = 1;

  const candidate = boxFor({ underlying: "TCS", k1: 3000, k2: 3100 });
  const result = await coordinator.simulateLeggingEntry({
    candidate,
    detection: detectionFor(candidate),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "box_inventory_limit");
});

/* ─────────────────────────── and does not over-refuse ─────────────────────────── */

test("0 means UNLIMITED, so an existing deployment is unaffected", async () => {
  const gateway = controllableGateway();
  const { coordinator, inventory } = makeCoordinator({ gateway, config: { maxOpenBoxes: 0 } });
  inventory.value = 25;

  const candidate = boxFor({ underlying: "WIPRO", k1: 400, k2: 450 });
  const entry = coordinator.simulateLeggingEntry({ candidate, detection: detectionFor(candidate) });
  await settle();
  gateway.finish(0);
  const result = await entry;

  assert.equal(result.ok, true, "with the ceiling disabled a 26th box must still be admitted");
  assert.equal(coordinator.metrics().inventoryLimitRefusals, 0);
});

test("below the ceiling, entry proceeds", async () => {
  const gateway = controllableGateway();
  const { coordinator, inventory } = makeCoordinator({ gateway, config: { maxOpenBoxes: 2 } });
  inventory.value = 1;

  const candidate = boxFor({ underlying: "INFY", k1: 1500, k2: 1600 });
  const entry = coordinator.simulateLeggingEntry({ candidate, detection: detectionFor(candidate) });
  await settle();
  gateway.finish(0);
  const result = await entry;

  assert.equal(result.ok, true, "1 held against a ceiling of 2 must admit");
});

test("an EXIT is never refused by the ceiling, however full the inventory is", async () => {
  const gateway = controllableGateway();
  const { coordinator, inventory } = makeCoordinator({ gateway, config: { maxOpenBoxes: 1 } });
  inventory.value = 99;

  const position = { ...boxFor({ underlying: "RELIANCE" }), id: "t1", remaining_qty_by_role: {} };
  const result = await coordinator.simulateLeggingExit({ position, detection: detectionFor(position) });

  assert.notEqual(
    result.reason,
    "box_inventory_limit",
    "a full inventory must never be a reason exposure cannot be reduced",
  );
  assert.equal(coordinator.metrics().inventoryLimitRefusals, 0);
});
