/**
 * UNOWNED BROKER EXPOSURE IS AN ENFORCED ENTRY GATE, NOT JUST A BANNER.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `operational_readiness` reported `unowned_attributed_exposure` — Box legs confirmed at the broker
 * with no open trade and no residual row accounting for them — and the new-box ADMISSION PATH never
 * consulted it. A readiness blocker is a STATEMENT, not a control. So with four orphaned legs sitting
 * at the broker, a brand-new candidate would claim an execution slot, SPEND the session attempt,
 * take contract reservations and POST four more live orders.
 *
 * `tests/box/postFillRestartRecovery.test.mjs` proved the VERDICT is correct. This file proves the
 * ENGINE now acts on it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY NO PRE-EXISTING GATE CAUGHT IT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every other inventory gate is derived from the durable position book, and the defining property of
 * this exposure is that the book has NO row for it — the position write is exactly what failed:
 *
 *   `box_inventory_limit`         counts positions/residuals/establishments → sees nothing.
 *   Layer 1a per-underlying lock  keyed on the same book → sees nothing, and is per-underlying
 *                                 besides, so it could not stop a DIFFERENT name even if it did.
 *   `BOX_LIVE_MAX_OPEN_BOXES`     a manager count refreshed from that book → sees nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS REAL HERE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Production `CoordinatedBoxExecutionGateway` (the real admission prologue), production
 * `BoxOrderManager` (the real attribution rebuild), the production live entry gateway from
 * `liveEntryHarness`, and a FAKE BROKER TRANSPORT that records every POST. The gate is fed by the
 * production `unownedAttributedExposureBlocker` — the same call `engine.unownedAttributedExposure()`
 * makes for both the operator verdict and this gate — so nothing here asserts a fixture.
 *
 * The central assertion is the one that matters: ZERO new broker POSTs.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager } from "../../dist/box/orderManager.js";
import { CoordinatedBoxExecutionGateway } from "../../dist/box/executionCoordinator.js";
import { InProcessInstrumentReservations } from "../../dist/box/instrumentReservations.js";
import { unownedAttributedExposureBlocker } from "../../dist/box/operationalReadiness.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import {
  brokerOrderFor,
  detectionFor,
  entryPosts,
  liveStack,
  runEntry,
  MemoryPersistence,
} from "./liveEntryHarness.mjs";
import { cfg } from "./helpers.mjs";

const LOTS = 75;
const NOW = 1_700_000_000_000;

const IDENTITY = { deployment: "test", instance: "host-w0", pid: 1, boot: "w0", processTag: "host-w0:p1:w0" };

/* ══════════════════════ phase 1: fill four legs, then lose the record ══════════════════════ */

/**
 * Drive a REAL live entry to broker-confirmed fills, then lose the recording step.
 *
 * `qualify` throwing is the production route to `FILLED_EXPOSURE_UNRECORDED`: every leg is terminal
 * in the durable journal and no position/attempt row is ever written. The journal is the ONLY thing
 * the restart inherits — which is precisely what survives a process stop.
 */
async function fillThenLoseTheRecord({ fillByRole = () => LOTS, failUnwind = false } = {}) {
  const journal = new MemoryPersistence();
  const stack = await liveStack({
    persistence: journal,
    adapterOptions: {
      submit: async (req) => {
        // A PARTIAL entry never reaches `qualify` — it routes through partial-entry recovery, which
        // tries to REVERSE the confirmed fills. For the partial scenario that reversal must fail, or
        // the exposure is cleanly unwound and there is nothing orphaned to inherit.
        if (failUnwind && req.purpose === "EMERGENCY_RESIDUAL") {
          throw new Error("the process died before the protective unwind could be sent");
        }
        const filled = fillByRole(req.role);
        return brokerOrderFor(req, filled, filled >= req.quantity ? "COMPLETE" : "PARTIALLY_FILLED");
      },
    },
  });
  const result = await runEntry(stack, {
    qualify: () => {
      throw new Error("the process died recording this attempt");
    },
  });
  return { journal, stack, result };
}

/** What the broker really holds, derived from the fills that actually happened. */
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

/* ══════════════════════ phase 2: the restarted process ══════════════════════ */

/**
 * A RESTARTED process: a brand-new production manager and transport inheriting only the journal.
 *
 * `isCrashRecoveryPersistenceReady: () => true` models the HONEST case — the database came back and
 * the recovery index verifies. That is what made the old behaviour unsafe, so asserting against a
 * healthy restart is the entire point; an unverified index would have been quarantined anyway.
 */
async function restartFrom(journal, brokerPositions) {
  const adapter = {
    mode: "live",
    posts: [],
    orders: new Map(),
    prepareOrder: (r) => r,
    submitOrder: async () => {
      throw new Error("the restarted manager must not POST anything of its own accord");
    },
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

/* ══════════════════════ the shared derivation, exactly as the engine calls it ══════════════════════ */

/**
 * THE PRODUCTION DERIVATION — not a re-implementation.
 *
 * `engine.unownedAttributedExposure()` is literally these two lines: the manager's reconstructed
 * attribution, and the symbol set the durable position book projects. Building the blocker here by
 * hand is what made an earlier attempt at this test pass against unpatched `main` — it asserted the
 * fixture rather than the system. `projected` models a surviving position book; empty by default,
 * because in this scenario no position row survived.
 */
function orphanGate(manager, projected = []) {
  return () =>
    unownedAttributedExposureBlocker({
      attributed: manager.attributedRecoveryExposure(),
      projectedSymbols: new Set(projected),
    });
}

/** Every symbol the four legs of a candidate project, as the position book would. */
function symbolsOf(candidate) {
  return BOX_LEG_ROLES.map((role) => `NFO:${candidate.legs[role].tradingsymbol}`);
}

/**
 * The REAL admission path: the production coordinator wrapping the production live entry gateway.
 *
 * `inner` is a genuine `liveStack` gateway with a recording broker transport, so if admission is
 * granted the entry really does reach the broker and `entryPosts()` really does grow. That is what
 * makes "zero POSTs" evidence rather than a tautology.
 *
 * `sessionConsumeAttempt` and the reservation store are the real ones, so the test can also prove
 * the refusal costs no attempt and no reservation — the two things the brief requires be untouched.
 */
async function admissionPath({ orphaned, config = {} } = {}) {
  const target = await liveStack({
    adapterOptions: { submit: async (req) => brokerOrderFor(req, req.quantity, "COMPLETE") },
  });
  const reservations = new InProcessInstrumentReservations();
  const attempts = { consumed: 0 };
  const innerCalls = { entries: 0, exits: 0, flattens: 0 };
  const instrumented = {
    ...target.gateway,
    mode: target.gateway.mode,
    hasCapacity: () => true,
    invariantViolation: () => {},
    estimateExecutableExit: () => [],
    flattenResidual: async () => {
      innerCalls.flattens++;
      return { flattened: {}, remaining: [], charges: 0 };
    },
    simulateLeggingExit: async () => {
      innerCalls.exits++;
      return { ok: true, record: { residual_exposure: [] } };
    },
    simulateExit: async () => {
      innerCalls.exits++;
      return { ok: true };
    },
    simulateLeggingEntry: (args) => {
      innerCalls.entries++;
      return target.gateway.simulateLeggingEntry(args);
    },
  };
  const coordinator = new CoordinatedBoxExecutionGateway({
    inner: instrumented,
    reservations,
    local: reservations,
    waitable: reservations,
    cfg: cfg({
      conflictWaitMaxMs: 0,
      instrumentLockTtlMs: 5_000,
      maxConcurrentPerUnderlying: 0,
      oneActiveBoxPerUnderlying: false,
      reservationClockSkewGraceMs: 0,
      durableReservationsEnabled: false,
      reservationRequireDurable: false,
      // Generous, so the live quantity envelope never pre-empts the gate under test.
      liveMaxOpenLegQuantity: 10_000,
      liveMaxGrossOpenLegQuantity: 100_000,
      maxOpenBoxes: 0,
      ...config,
    }),
    quotes: { view: () => new Map() },
    broker: () => "zerodha",
    generation: () => 1,
    identity: IDENTITY,
    now: () => NOW,
    boxInventory: () => 0,
    orphanedExposureGate: orphaned,
    sessionConsumeAttempt: async () => {
      attempts.consumed++;
      return { ok: true, detail: null };
    },
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    setTimer: () => null,
    clearTimer: () => {},
    log: () => {},
  });
  return { coordinator, target, reservations, attempts, innerCalls };
}

/** Attempt one entry through the real admission path. */
function attemptEntry(path, candidate = path.target.candidate) {
  const base = path.target.candidate;
  // A candidate on another underlying has no seeded book in this fixture's quote store. Re-label the
  // base candidate's real detection with the other box's contract identities: admission is decided
  // in the prologue before any quote is read, so the prices are irrelevant — but a detection that
  // throws while being BUILT would fail the test for a reason it is not about.
  const detection =
    candidate === base
      ? detectionFor(base, path.target.quotes)
      : (() => {
          const d = detectionFor(base, path.target.quotes);
          return {
            ...d,
            candidate,
            legs: d.legs.map((leg, i) => {
              const other = candidate.legs[BOX_LEG_ROLES[i]];
              return { ...leg, token: other.token, tradingsymbol: other.tradingsymbol, strike: other.strike };
            }),
          };
        })();
  return path.coordinator.simulateLeggingEntry({
    candidate,
    detection,
    qualify: () => ({ qualifies: true, expected_net_profit: 5_000, min_expected_net_profit: 1_200 }),
  });
}

/**
 * MODEL A COMPLETED, BROKER-CONFIRMED FLATTEN in the durable journal.
 *
 * This is what the emergency control leaves behind: one offsetting COMPLETE intent per leg. Reconcile
 * rebuilds attribution as `Σ (BUY ? +1 : -1) × filled_quantity` per symbol, so the offsetting rows
 * net every affected symbol to exactly zero — which is how `attributedRecoveryExposure()` stops
 * reporting them. Appending rows rather than deleting the entry fills is deliberate: a flatten never
 * erases history, and a test that cleared the blocker by forgetting the fills would prove nothing.
 */
function flattenInJournal(journal) {
  for (const row of [...journal.rows.values()]) {
    if (row.purpose !== "ENTRY" || row.filled_quantity <= 0) continue;
    const id = `${row.client_order_id}-flat`;
    journal.rows.set(id, {
      ...row,
      client_order_id: id,
      broker_order_id: `${row.broker_order_id}-flat`,
      purpose: "EMERGENCY_RESIDUAL",
      side: row.side === "BUY" ? "SELL" : "BUY",
      state: "COMPLETE",
      audit: [],
    });
  }
}

/**
 * A GENUINELY DIFFERENT BOX: another underlying, other strikes, other tokens, other symbols.
 *
 * Shares not one contract with the orphaned legs, so neither the contract reservation layer nor the
 * per-underlying lock has anything to say about it. This is the candidate the old code admitted.
 */
function differentUnderlyingBox(base) {
  const legs = {};
  for (const role of BOX_LEG_ROLES) {
    const leg = base.legs[role];
    legs[role] = {
      ...leg,
      token: leg.token + 500_000,
      tradingsymbol: `BANKNIFTY26SEP${leg.strike + 20_000}${leg.instrument_type}`,
      strike: leg.strike + 20_000,
    };
  }
  return {
    ...base,
    key: `BANKNIFTY|${base.expiry}|${base.lower_strike + 20_000}|${base.upper_strike + 20_000}|LONG_BOX`,
    underlying: "BANKNIFTY",
    name: "NIFTY BANK",
    lower_strike: base.lower_strike + 20_000,
    upper_strike: base.upper_strike + 20_000,
    legs,
  };
}

/* ═══════════════════════════ 1. the precondition is real ═══════════════════════════ */

test("precondition: four legs are broker-confirmed and NOTHING owns them", async () => {
  const { journal, stack, result } = await fillThenLoseTheRecord();
  assert.equal(result.ok, false);
  assert.equal(result.legging.outcome_class, "FILLED_EXPOSURE_UNRECORDED");

  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));
  assert.equal(manager.attributedRecoveryExposure().length, 4, "all four legs are reconstructed");

  const status = manager.status();
  assert.equal(status.openBoxes, 0, "no position row survived");
  assert.equal(status.residualLegs, 0, "and no residual row either");

  // The dangerous shape in one line: exposure exists, and the book that every other gate reads
  // from is empty. Without the new gate, nothing at all stands between this and four more orders.
  assert.notEqual(orphanGate(manager)(), null, "the shared derivation sees unowned exposure");
});

/* ═══════════════ 2. THE CENTRAL ASSERTION: a new box cannot reach the broker ═══════════════ */

test("THE GATE: a genuinely new box is refused with ZERO broker POSTs", async () => {
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));
  const path = await admissionPath({ orphaned: orphanGate(manager) });

  const result = await attemptEntry(path);

  // THE REQUIREMENT, stated as plainly as it can be.
  assert.deepEqual(entryPosts(path.target.adapter), [], "NOT ONE order may reach the broker");
  assert.deepEqual(path.target.adapter.posts, [], "and nothing of any purpose either");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unowned_attributed_exposure", "the refusal must name the real cause");
  assert.equal(path.coordinator.metrics().orphanedExposureRefusals, 1);
  assert.equal(path.innerCalls.entries, 0, "the entry gateway is never even entered");
});

test("the refusal costs NO attempt, NO reservation and NO claim", async () => {
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));
  const path = await admissionPath({ orphaned: orphanGate(manager) });

  await attemptEntry(path);

  // On a one-attempt supervised trial, spending the attempt on a refusal ENDS the trial without a
  // single order having been sent. The gate sits before `sessionConsumeAttempt` for this reason.
  assert.equal(path.attempts.consumed, 0, "the session attempt budget is untouched");
  assert.equal(path.reservations.activeCount(NOW), 0, "no contract reservation was acquired");
  assert.equal(path.coordinator.metrics().activeExecutions, 0, "no claim leaked");

  // And it is repeatable — a refusal must not self-suppress the opportunity for the process's life.
  const again = await attemptEntry(path);
  assert.equal(again.reason, "unowned_attributed_exposure", "still the same honest answer, not 'duplicate'");
  assert.equal(path.attempts.consumed, 0);
  assert.deepEqual(path.target.adapter.posts, []);
});

test("the refusal is ACTIONABLE: it names the legs, the remedy, and what still works", async () => {
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));
  const path = await admissionPath({ orphaned: orphanGate(manager) });

  const { detail } = await attemptEntry(path);

  assert.match(detail, /OPERATOR ACTION REQUIRED/, "it must say a human has to do something");
  assert.match(detail, /verify these positions at the broker/, "it must say WHERE to look");
  assert.match(detail, /flatten|reconcile/i, "it must name the remedy");
  assert.match(
    detail,
    /exits, protective cancellation and reconciliation remain/i,
    "it must say reduction is NOT blocked, or an operator may restart trying to clear it",
  );
  // The specific legs, so an operator can check them one by one against the terminal.
  const symbol = stack.candidate.legs.k1_ce.tradingsymbol;
  assert.ok(detail.includes(symbol), `the refusal names the affected contracts (${symbol})`);
  assert.match(detail, /EVERY underlying/, "it must be clear this is not limited to these contracts");
});

/* ═══════════════ 3. a DIFFERENT underlying — the case nothing else covers ═══════════════ */

test("a second candidate on a DIFFERENT underlying is refused too", async () => {
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));
  const path = await admissionPath({ orphaned: orphanGate(manager) });

  const other = differentUnderlyingBox(path.target.candidate);
  // Sanity: this really is a disjoint box. If it ever shared a contract the test would be proving
  // the reservation layer instead of the gate.
  const orphanedSymbols = new Set(manager.attributedRecoveryExposure().map((l) => l.tradingsymbol));
  for (const role of BOX_LEG_ROLES) {
    assert.ok(!orphanedSymbols.has(other.legs[role].tradingsymbol), `${role} shares no contract`);
  }
  assert.notEqual(other.underlying, stack.candidate.underlying);

  const result = await attemptEntry(path, other);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unowned_attributed_exposure");
  assert.match(result.detail, /BANKNIFTY/, "the refusal names the candidate it refused");
  assert.deepEqual(path.target.adapter.posts, [], "zero POSTs on the unrelated underlying too");
  assert.equal(path.attempts.consumed, 0);
  assert.equal(path.innerCalls.entries, 0);
});

/* ═══════════════ 4. a PARTIAL orphaned fill is still orphaned exposure ═══════════════ */

test("a PARTIALLY filled orphaned entry blocks new entry just the same", async () => {
  // Two legs filled, two never did, and the protective unwind could not be sent — a naked spread
  // rather than a box. Strictly more dangerous than the four-leg case, and easier to overlook.
  const fillByRole = (role) => (role === "k1_ce" || role === "k2_ce" ? LOTS : 0);
  const { journal, stack } = await fillThenLoseTheRecord({ fillByRole, failUnwind: true });
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack, fillByRole));

  const attributed = manager.attributedRecoveryExposure();
  assert.ok(attributed.length > 0 && attributed.length < 4, `a partial orphan (${attributed.length} legs)`);

  const path = await admissionPath({ orphaned: orphanGate(manager) });
  const result = await attemptEntry(path);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unowned_attributed_exposure");
  assert.deepEqual(path.target.adapter.posts, [], "zero POSTs on a partial orphan");
  assert.equal(path.attempts.consumed, 0);
});

/* ═══════════════ 5. it CLEARS — the gate must not be a one-way door ═══════════════ */

test("CLEARED by a verified flatten: the exposure is gone, so entry is admitted again", async () => {
  const { journal, stack } = await fillThenLoseTheRecord();

  // Before: blocked.
  const before = await restartFrom(journal, brokerPositionsFor(stack));
  assert.notEqual(orphanGate(before.manager)(), null);

  // The operator ran the emergency flatten the refusal told them to run, and it was confirmed. The
  // broker now reports nothing in these contracts and the journal carries the offsetting fills.
  flattenInJournal(journal);
  const { manager } = await restartFrom(journal, []);
  assert.deepEqual(manager.attributedRecoveryExposure(), [], "nothing is attributed once it is flat");
  assert.equal(orphanGate(manager)(), null, "the shared derivation goes quiet");

  const path = await admissionPath({ orphaned: orphanGate(manager) });
  const result = await attemptEntry(path);

  assert.equal(result.ok, true, "a cleared account trades again — the gate is not a one-way door");
  assert.equal(path.coordinator.metrics().orphanedExposureRefusals, 0);
  assert.equal(path.attempts.consumed, 1, "and NOW the attempt is legitimately spent");
  assert.equal(entryPosts(path.target.adapter).length, 4, "the real entry really does reach the broker");
});

test("CLEARED by reconciling it into a trade: the position book now accounts for the legs", async () => {
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));

  // The other legitimate remedy: the exposure is adopted into a real trade row, so the durable
  // position book projects these symbols. The exposure did not go away — it acquired an OWNER.
  assert.equal(manager.attributedRecoveryExposure().length, 4, "the legs are still held");
  const owned = orphanGate(manager, symbolsOf(stack.candidate));
  assert.equal(owned(), null, "owned exposure is not orphaned exposure");

  const path = await admissionPath({ orphaned: owned });
  const result = await attemptEntry(path);

  assert.equal(result.ok, true, "reconciled exposure does not block entry");
  assert.equal(path.coordinator.metrics().orphanedExposureRefusals, 0);
});

test("an unrelated ORDINARY open position does not trip the gate", async () => {
  // THE FALSE-POSITIVE GUARD. A normal open box also produces attributed legs. If the gate fired on
  // "attribution is non-empty" it would refuse all entry on any deployment holding any position —
  // indistinguishable, to an operator, from the engine being broken.
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));

  const projected = symbolsOf(stack.candidate);
  assert.equal(manager.attributedRecoveryExposure().length, 4, "attribution is deliberately NON-empty");
  assert.equal(orphanGate(manager, projected)(), null, "yet the gate stays silent");

  const path = await admissionPath({ orphaned: orphanGate(manager, projected) });
  assert.equal((await attemptEntry(path)).ok, true);
  assert.equal(path.coordinator.metrics().orphanedExposureRefusals, 0);
});

/* ═══════════════ 6. reduction is NEVER gated — the block must not strand exposure ═══════════════ */

test("exits, protective cancellation and residual flattening stay available while blocked", async () => {
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));
  const path = await admissionPath({ orphaned: orphanGate(manager) });

  // Entry is refused...
  assert.equal((await attemptEntry(path)).reason, "unowned_attributed_exposure");

  // ...and every REDUCTION path is untouched. These are the only operations that can clear this
  // state, so gating them on it would make the block permanent and strand real broker exposure.
  const position = {
    trade_id: "t-open",
    candidate: path.target.candidate,
    direction: "LONG_BOX",
    legs: path.target.candidate.legs,
    remaining_qty_by_role: { k1_ce: LOTS, k2_ce: LOTS, k2_pe: LOTS, k1_pe: LOTS },
  };

  const exit = await path.coordinator.simulateLeggingExit({ position, detection: null, reason: "TARGET" });
  assert.equal(exit.ok, true, "an exit is not gated on unowned exposure");

  const flat = await path.coordinator.flattenResidual({ attemptId: "a1", legs: [] });
  assert.ok(flat, "residual flattening is not gated either");

  assert.equal(path.innerCalls.exits, 1, "the exit really reached the gateway");
  assert.equal(path.innerCalls.flattens, 1, "so did the flatten");

  // The emergency control an operator is told to use must still be armed.
  assert.equal(manager.status().controls.emergencyFlatten, true);
});

test("the operator verdict and the enforced gate come from ONE derivation", async () => {
  // If these ever diverge, an operator is told one thing while the engine does another — which is
  // the exact failure this whole change is about, merely relocated.
  const { journal, stack } = await fillThenLoseTheRecord();
  const { manager } = await restartFrom(journal, brokerPositionsFor(stack));
  const verdict = orphanGate(manager)();
  const path = await admissionPath({ orphaned: orphanGate(manager) });
  const refusal = await attemptEntry(path);

  assert.equal(verdict.code, "unowned_attributed_exposure");
  assert.equal(verdict.scope, "entry", "the readiness blocker is ENTRY-scoped — reduction stays open");
  assert.ok(
    refusal.detail.startsWith(verdict.detail),
    "the refusal an operator sees at admission must be the blocker they see in readiness",
  );
});
