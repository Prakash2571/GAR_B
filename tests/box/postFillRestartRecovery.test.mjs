/**
 * A CONFIRMED FILL THAT OUTLIVED THE PROCESS THAT MADE IT.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SCENARIO
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * All four live legs are broker-confirmed FILLED, so four terminal COMPLETE rows exist in the durable
 * order-intent journal. The position / execution-attempt write then FAILS, and the process STOPS
 * before that attempt is durably recorded. On restart the only surviving evidence is:
 *
 *   (a) the order-intent journal in PostgreSQL, and
 *   (b) the broker's own positions.
 *
 * The requirement: the system must EITHER reconstruct and own the exposure, OR keep entry blocked
 * with an explicit operator action until reconciliation succeeds.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS FOUND, MEASURED ON THE REAL WIRING
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Restart DID reconstruct `attributedBoxPositions` from the journal — so the system knew it held four
 * legs — and the broker confirmed the same four positions, so nothing mismatched, nothing tripped,
 * and `reconciliation_complete` became true. But no position row was ever written, so `openBoxes` and
 * `residualLegs` were both 0 and the residual flatten loop had nothing to work. Measured:
 *
 *     canEnter()        → true
 *     entryBlockReason() → null
 *
 * A brand-new four-leg box was admissible on top of four legs nobody was managing.
 *
 * `crashRecoveryEntryQuarantined` did not cover it: it is refreshed only from `onReconciliationIssue`
 * (which does not fire when reconcile finds no mismatch), and it additionally requires the
 * crash-recovery INDEX to be unverified — so a clean restart with a healthy database never triggers
 * it. The fix adds an ENTRY-scoped readiness blocker, `unowned_attributed_exposure`, computed from the
 * same crash-only filter the emergency flatten control uses.
 *
 * Production `BoxOrderManager` + production `buildOperationalReadiness` + the real gateway entry path,
 * with a fake broker transport. No core decision logic is stubbed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager } from "../../dist/box/orderManager.js";
import {
  buildOperationalReadiness,
  unownedAttributedExposureBlocker,
} from "../../dist/box/operationalReadiness.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { brokerOrderFor, liveStack, runEntry, MemoryPersistence } from "./liveEntryHarness.mjs";

const LOTS = 75;

/* ───────────────────────── phase 1: fill, fail to record, stop ───────────────────────── */

/**
 * Drive a REAL live entry to four broker-confirmed fills, then lose the recording step.
 *
 * `qualify` throwing is the production path that reaches `FILLED_EXPOSURE_UNRECORDED`: all four legs
 * are terminal in the journal and no position/attempt row is written. The returned journal is the
 * ONLY thing phase 2 inherits — which is exactly what survives a process stop.
 */
async function fillThenLoseTheRecord({ fillByRole = () => LOTS, failUnwind = false } = {}) {
  const journal = new MemoryPersistence();
  const stack = await liveStack({
    persistence: journal,
    adapterOptions: {
      submit: async (req) => {
        /*
         * A PARTIAL entry never reaches `qualify` — it routes through partial-entry recovery, which
         * tries to REVERSE the confirmed fills. For the partial scenario we need that reversal to
         * fail, otherwise the exposure is cleanly unwound and there is nothing left to inherit. A
         * protective unwind that cannot be sent is exactly how real residual exposure arises.
         */
        if (failUnwind && req.purpose === "EMERGENCY_RESIDUAL") {
          throw new Error("the process died before the protective unwind could be sent");
        }
        const filled = fillByRole(req.role);
        return brokerOrderFor(req, filled, filled >= req.quantity ? "COMPLETE" : "PARTIALLY_FILLED");
      },
    },
  });
  const result = await runEntry(stack, {
    // Reached only when all four legs fill; a partial entry recovers before this.
    qualify: () => { throw new Error("the process died recording this attempt"); },
  });
  return { journal, stack, result };
}

/** What the broker holds, derived from the fills that really happened. */
function brokerPositionsFor(stack, fillByRole = () => LOTS) {
  return BOX_LEG_ROLES.map((role) => {
    const leg = stack.candidate.legs[role];
    const filled = fillByRole(role);
    if (filled <= 0) return null;
    const side = entrySideFor(role, "LONG_BOX");
    return {
      token: leg.token,
      exchange: "NFO",
      tradingsymbol: leg.tradingsymbol,
      net_quantity: side === "BUY" ? filled : -filled,
      average_price: 100,
    };
  }).filter((p) => p !== null);
}

/* ───────────────────────── phase 2: restart ───────────────────────── */

/**
 * A RESTARTED process: brand-new manager and adapter, inheriting only the journal.
 *
 * `isCrashRecoveryPersistenceReady: () => true` models the honest case — the database came back and
 * the recovery index verifies. That is what made the old behaviour unsafe, so asserting against a
 * healthy restart is the whole point; a failed index would have been quarantined anyway.
 */
async function restartFrom(journal, brokerPositions) {
  const adapter = {
    mode: "live",
    posts: [],
    orders: new Map(),
    prepareOrder: (r) => r,
    submitOrder: async () => { throw new Error("the restart must not POST anything on its own"); },
    cancelOrder: async () => undefined,
    getOrder: async () => undefined,
    listOrders: async () => [],
    listPositions: async () => brokerPositions,
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 0 }),
  };
  let t = 1;
  const manager = new BoxOrderManager({
    adapter,
    persistence: journal,
    limits: {
      maxOpenBoxes: 10, maxConcurrentExecutions: 1, maxResidualLegs: 10, dailyLossLimit: 0,
      rejectLimit: 100, consecutiveFailureLimit: 100, maxOpenLegQuantity: 1_000,
      maxGrossOpenLegQuantity: 10_000, reconcileIntervalMs: 60_000, feedReconnectWarmupMs: 0,
      zerodhaEntryStaticIpConfirmed: true, maxBoxCapitalRupees: 0,
    },
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => t++ },
    istDayKey: () => "2026-09-02",
    isCrashRecoveryPersistenceReady: () => true,
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  const report = await manager.reconcile();
  return { manager, adapter, report };
}

/** The production readiness decision, with NO durable position book (nothing was recorded). */
function readinessAfterRestart(manager, { openPositions = 0, residualLegs = 0, projected = [] } = {}) {
  // `projected` is the symbol set a surviving position book would contribute. Empty by default,
  // because in this scenario no position row survived.
  const projectedSymbols = new Set(projected);
  /*
   * THE PRODUCTION DERIVATION, not a re-implementation.
   *
   * An earlier version of this helper BUILT the blocker itself, which made the central test pass
   * against unpatched `main` — it was asserting the fixture, not the system. This calls the exact
   * function `engine.getOperationalReadiness()` calls, with the exact inputs (the manager's
   * reconstructed attribution, and the symbol set the durable position book projects).
   */
  const blocker = unownedAttributedExposureBlocker({
    attributed: manager.attributedRecoveryExposure(),
    projectedSymbols,
  });
  const blockers = blocker === null ? [] : [blocker];
  return buildOperationalReadiness({
    now: 1_700_000_000_000,
    decisionGeneration: 1,
    identity: {
      broker: "zerodha", account: "AB1234", executionMode: "live",
      liveRuntimeArmed: true, deploymentLiveCapable: true,
    },
    marketData: {
      state: "READY", generation: 7, desiredInstruments: 4, readyInstruments: 4,
      frameAgeMs: 200, heartbeatAgeMs: 200, depthAgeMs: 300,
      lastFrameWallAt: 1_700_000_000_000 - 200, lastHeartbeatWallAt: 1_700_000_000_000 - 200,
      lastDepthWallAt: 1_700_000_000_000 - 300, frames: 1_200, heartbeats: 40,
      depthObservations: 900, backlog: false, source: "broker_websocket",
      socketConnected: true, authenticated: true, subscriptionsRequested: true, usableBooks: 4,
    },
    orderStream: {
      lifecycle: "READY", publishedState: "LIVE", wiring: "armed", gateEnabled: true,
      connected: true, authorised: true, lastEventAt: 1_700_000_000_000 - 1000,
      disconnects: 0, reconcilePending: false, fillsObservedBy: "stream_primary_rest_reconcile",
    },
    paperExecution: { simulated: false, profile: null, usingStreamedQuotes: false },
    persistence: { durableStoreReady: true, durableWrites: "healthy" },
    blockers,
    openExposure: { openPositions, residualLegs, workingOrders: 0 },
  });
}

/* ═══════════════════ 1. the journal really is the only survivor ═══════════════════ */

test("phase 1: four legs are broker-confirmed filled and the attempt is NOT recorded", async () => {
  const { journal, result } = await fillThenLoseTheRecord();

  assert.equal(result.ok, false);
  assert.equal(result.legging.outcome_class, "FILLED_EXPOSURE_UNRECORDED");

  const rows = [...journal.rows.values()].filter((r) => r.purpose === "ENTRY");
  assert.equal(rows.length, 4, "four durable intents survive");
  for (const row of rows) {
    assert.equal(row.state, "COMPLETE", `${row.role} is terminal in the journal`);
    assert.equal(row.filled_quantity, LOTS, `${row.role} carries its confirmed fill`);
    assert.ok(row.broker_order_id, `${row.role} carries its broker identity`);
  }
});

/* ═══════════════════ 2. restart reconstructs and OWNS the exposure ═══════════════════ */

test("restart RECONSTRUCTS all four legs from the journal and the broker", async () => {
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));

  const exposure = manager.attributedRecoveryExposure();
  assert.equal(exposure.length, 4, "every confirmed leg is reconstructed");
  for (const leg of exposure) {
    assert.equal(leg.quantity, LOTS, `${leg.role} recovers its full confirmed quantity`);
    assert.ok(leg.token > 0 && leg.tradingsymbol, `${leg.role} is identifiable at the broker`);
  }
  // Signed correctly, or a flatten would trade the wrong way.
  const byRole = Object.fromEntries(exposure.map((l) => [l.role, l.side]));
  assert.equal(byRole.k1_ce, "BUY");
  assert.equal(byRole.k2_ce, "SELL");
  assert.equal(byRole.k2_pe, "BUY");
  assert.equal(byRole.k1_pe, "SELL");
});

test("restart does NOT re-POST anything of its own accord", async () => {
  // Re-submitting a durably-COMPLETE intent would duplicate live exposure. The adapter throws if
  // `submitOrder` is ever called, so reaching the assertions at all proves it was not.
  const { journal, stack } = await fillThenLoseTheRecord();
  const { adapter } = await restartFrom(journal, brokerPositionsFor(stack));
  assert.deepEqual(adapter.posts, []);
});

/* ═══════════════════ 3. ...and entry is BLOCKED with an operator action ═══════════════════ */

test("THE GAP: restart must not admit a new box on top of exposure nothing owns", async () => {
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));

  // Precondition: this is the dangerous shape — exposure reconstructed, nothing accounting for it.
  assert.equal(manager.attributedRecoveryExposure().length, 4);
  const status = manager.status();
  assert.equal(status.openBoxes, 0, "no position row survived");
  assert.equal(status.residualLegs, 0, "and no residual row either");

  // THE FIX: the authoritative readiness decision refuses a NEW box and names the action.
  const decision = readinessAfterRestart(manager);
  assert.equal(decision.entry.permitted, false, "a new box must NOT be admitted");
  const blocker = decision.entry.reasons.find((b) => b.code === "unowned_attributed_exposure");
  assert.ok(blocker, `expected the unowned-exposure blocker, got ${JSON.stringify(decision.entry.reasons)}`);
  assert.match(blocker.detail, /OPERATOR ACTION REQUIRED/);
  assert.match(blocker.detail, /flatten the attributed exposure/i, "the remedy is named");
});

test("the block is ENTRY-only — every reduction route stays available", async () => {
  // The exposure is real, so the operator must be able to remove it. Blocking reduction here would
  // strand precisely what needs removing.
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));

  const decision = readinessAfterRestart(manager);
  assert.equal(decision.entry.permitted, false);
  assert.equal(decision.exposure_management.exit_and_reduce, true, "exits stay available");
  assert.equal(decision.exposure_management.protective_cancel, true);
  assert.equal(decision.exposure_management.manage_working_orders, true);
  assert.deepEqual(
    decision.exposure_management.blocked_reasons, [],
    "an entry-scoped blocker must never reach the reduction verdict",
  );
  assert.equal(manager.canManageExposure(), true, "and the manager agrees");
});

test("once the exposure IS owned by a position row, entry is admitted again", async () => {
  // Non-vacuity and recovery: the block must clear when the exposure is accounted for, or it would be
  // a permanent halt rather than a gate.
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));

  // Model the operator/engine reconciling it into a trade: the position book now projects these
  // symbols, so the crash-only filter finds nothing.
  const projected = new Set(
    BOX_LEG_ROLES.map((role) => `NFO:${stack.candidate.legs[role].tradingsymbol}`),
  );
  const stillUnowned = manager.attributedRecoveryExposure().filter(
    (r) => !projected.has(`${r.exchange ?? "NFO"}:${r.tradingsymbol}`),
  );
  assert.deepEqual(stillUnowned, [], "nothing is crash-only once a trade projects these symbols");

  const decision = readinessAfterRestart(manager, { openPositions: 1, projected: [...projected] });
  // With the position accounted for there is no unowned blocker; entry is governed by the ordinary rules.
  assert.equal(
    decision.entry.reasons.some((b) => b.code === "unowned_attributed_exposure"), false,
    "the blocker clears once the exposure is owned",
  );
});

/* ═══════════════════ 4. a PARTIAL fill with residual exposure ═══════════════════ */

test("a PARTIAL fill that outlived its process is reconstructed at its exact quantity", async () => {
  // Two legs full, one partial, one empty — the realistic legging-interrupted shape.
  const fills = { k1_ce: LOTS, k2_ce: 30, k2_pe: LOTS, k1_pe: 0 };
  const fillByRole = (role) => fills[role] ?? 0;
  const { journal, stack } = await fillThenLoseTheRecord({ fillByRole, failUnwind: true });
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack, fillByRole));

  const byRole = Object.fromEntries(manager.attributedRecoveryExposure().map((l) => [l.role, l]));
  assert.equal(byRole.k1_ce.quantity, LOTS);
  assert.equal(byRole.k2_pe.quantity, LOTS);
  assert.equal(byRole.k2_ce.quantity, 30, "the partial is recovered at its EXACT confirmed quantity");
  assert.equal(byRole.k2_ce.side, "SELL", "and on the side actually held");
  assert.equal(byRole.k1_pe, undefined, "a leg that never filled creates no exposure");
});

test("a PARTIAL fill that outlived its process also blocks new entry, and is reducible", async () => {
  const fills = { k1_ce: LOTS, k2_ce: 30, k2_pe: LOTS, k1_pe: 0 };
  const fillByRole = (role) => fills[role] ?? 0;
  const { journal, stack } = await fillThenLoseTheRecord({ fillByRole, failUnwind: true });
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack, fillByRole));

  const decision = readinessAfterRestart(manager);
  assert.equal(decision.entry.permitted, false, "an unowned partial is still unowned exposure");
  assert.ok(decision.entry.reasons.some((b) => b.code === "unowned_attributed_exposure"));
  // A naked short is the dangerous residue here, so reduction must remain fully available.
  assert.equal(decision.exposure_management.exit_and_reduce, true);
  assert.equal(manager.canManageExposure(), true);
});

/* ═══════════════════ 5. the broker disagreeing is still caught ═══════════════════ */

test("if the broker does NOT hold the reconstructed exposure, reconcile trips instead", async () => {
  // The other half of the safety net, and a control proving the block above is not the only defence:
  // a journal/broker disagreement is a mismatch, which trips the breaker and blocks entry that way.
  const { journal } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, []); // broker reports nothing

  assert.equal(manager.canEnter(), false);
  assert.match(String(manager.entryBlockReason()), /mismatch|breaker/i);
  assert.equal(manager.status().health.circuit, "open", "a disagreement about live exposure trips");
  assert.equal(manager.canManageExposure(), true, "and reduction is STILL available");
});
