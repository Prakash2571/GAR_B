/**
 * AUDIT REGRESSION (finding 1, P0) — REPLACING THE SIGNED-IN ACCOUNT IS FENCED LIKE A BROKER SWITCH.
 *
 * Every assertion describes DESIRED behaviour and FAILS on the audited baseline (978b813).
 *
 * THE STRUCTURAL ASYMMETRY THIS CLOSES. `switchBroker` and `logoutZerodha` are both fenced by
 * `exposureBlockers` — open positions, working orders, execution in flight, incomplete
 * reconciliation, residual legs, unknown order states. `completeZerodhaLogin` was fenced by NOTHING.
 * It did not even compare the incoming `user_id` with the outgoing one, so a same-account token
 * refresh and a sign-in as a COMPLETELY DIFFERENT account executed byte-for-byte the same code.
 *
 * That matters because a different-account login reaches the SAME END STATE as a broker switch: every
 * durable intent, working order and attributed position recorded under the outgoing account now
 * belongs to a session that cannot legitimately act on it. The audit's second reproduction followed
 * directly — a long attributed under account A authorising an EXIT SELL under account B, which does
 * not close A's long but opens a SHORT in B.
 *
 * The guard deliberately REUSES `exposureBlockers` rather than assembling its own set: a gap in one
 * of three near-identical fences is how the same defect returns by a different route.
 *
 * FAILS LOUDLY WITHOUT POSTGRESQL — the manager persists the active broker to PG.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPgHarness, TEST_KEY_HEX } from "../tokens/helpers.mjs";
import { installHermeticNetwork } from "../helpers/hermeticNetwork.mjs";
import { makeManager } from "./helpers.mjs";

let h;
let hermetic;

before(async () => {
  hermetic = installHermeticNetwork();
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
  h = await createPgHarness("switch");
});
after(async () => {
  if (h) await h.cleanup();
  hermetic?.restore();
});
beforeEach(async () => {
  const c = await h.raw();
  await c.query(`TRUNCATE active_broker`);
  c.release();
});

/** A clean, flat exposure probe — nothing blocks anything. */
function flatProbe(overrides = {}) {
  return {
    scannerRunning: () => false,
    openPositionCount: () => 0,
    brokersWithOpenPositions: () => [],
    workingOrderCount: () => 0,
    executionInFlight: () => false,
    reconciliationComplete: () => true,
    residualLegCount: () => 0,
    unknownOrderCount: () => 0,
    unresolvedIntentsFor: async () => 0,
    ...overrides,
  };
}

/** Inert switch hooks. `accountReplacementBlockers` reads only the probe, but `attach` takes both. */
function inertHooks() {
  return {
    stopScanner: () => {},
    invalidateBooks: () => {},
    reloadUniverse: async () => {},
    publish: () => {},
    marketDataSessionRestored: () => {},
  };
}

async function managerWithProbe(probeOverrides) {
  const manager = await makeManager("zerodha");
  manager.attach(flatProbe(probeOverrides), inertHooks());
  return manager;
}

test("R1: an OPEN BOX POSITION blocks replacing the signed-in account", async () => {
  const manager = await managerWithProbe({
    openPositionCount: () => 1,
    brokersWithOpenPositions: () => ["zerodha"],
  });
  const blockers = await manager.accountReplacementBlockers("zerodha", "ZD-AAA", "ZD-BBB");
  assert.ok(blockers.length > 0, "an account replacement with open exposure must be refused");
  assert.ok(
    blockers.some((b) => b.reason === "open_box_positions"),
    `expected open_box_positions, got ${blockers.map((b) => b.reason).join(",")}`,
  );
  // The operator-facing sentence must name what is actually happening.
  assert.match(blockers[0].detail, /replacing the signed-in zerodha account \(ZD-AAA → ZD-BBB\)/);
});

test("R2: every exposure class that blocks a broker SWITCH also blocks an account REPLACEMENT", async () => {
  // The shared-set property, asserted class by class. If these two guards ever drift, this fails.
  const cases = [
    ["scanner_running", { scannerRunning: () => true }],
    ["open_box_positions", { openPositionCount: () => 2, brokersWithOpenPositions: () => ["zerodha"] }],
    ["working_orders", { workingOrderCount: () => 1 }],
    ["execution_in_flight", { executionInFlight: () => true }],
    ["unresolved_reconciliation", { reconciliationComplete: () => false }],
    ["residual_exposure", { residualLegCount: () => 3 }],
    ["unknown_order_state", { unknownOrderCount: () => 1 }],
  ];
  for (const [reason, overrides] of cases) {
    const manager = await managerWithProbe(overrides);
    const blockers = await manager.accountReplacementBlockers("zerodha", "ZD-AAA", "ZD-BBB");
    assert.ok(
      blockers.some((b) => b.reason === reason),
      `${reason} must block an account replacement, got ${blockers.map((b) => b.reason).join(",") || "none"}`,
    );
  }
});

test("R3: unresolved DURABLE INTENTS under the outgoing account block replacement", async () => {
  // Positions and working orders can both be clear while durable rows are still unresolved — those
  // rows name the OUTGOING account, and after a replacement nothing may act on them.
  const manager = await managerWithProbe({ unresolvedIntentsFor: async () => 4 });
  const blockers = await manager.accountReplacementBlockers("zerodha", "ZD-AAA", "ZD-BBB");
  assert.ok(
    blockers.some((b) => b.reason === "foreign_unresolved_intents"),
    `expected foreign_unresolved_intents, got ${blockers.map((b) => b.reason).join(",")}`,
  );
  const detail = blockers.find((b) => b.reason === "foreign_unresolved_intents").detail;
  assert.match(detail, /4 durable order intent\(s\)/);
  // It must tell the operator the option that is often correct: go back to the original account.
  assert.match(detail, /sign back into ZD-AAA/i);
});

test("R4: a FLAT deployment may replace the account freely", async () => {
  // The fence must not become a reason an operator cannot change accounts at all.
  const manager = await managerWithProbe();
  const blockers = await manager.accountReplacementBlockers("zerodha", "ZD-AAA", "ZD-BBB");
  assert.deepEqual(blockers, [], "with nothing outstanding there is nothing to protect");
});

test("R5: a probe-less deployment is not blocked by a guard it cannot evaluate", async () => {
  const manager = await makeManager("zerodha");
  const blockers = await manager.accountReplacementBlockers("zerodha", "ZD-AAA", "ZD-BBB");
  assert.deepEqual(blockers, [], "no probe means no evidence of exposure, not a refusal");
});

test("R6: a failing unresolved-intent query cannot wedge the login path", async () => {
  // Fail-open ONLY for this one diagnostic query, matching `switchBlockers`: the exposure set above
  // is the load-bearing guard, and a transient database error must not be a permanent lockout.
  const manager = await managerWithProbe({
    unresolvedIntentsFor: async () => {
      throw new Error("database unavailable");
    },
  });
  const blockers = await manager.accountReplacementBlockers("zerodha", "ZD-AAA", "ZD-BBB");
  assert.deepEqual(blockers, []);
});
