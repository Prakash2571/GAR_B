/**
 * DEFECT C — DUPLICATE ADMISSION AROUND SESSION ATTEMPT CONSUMPTION.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `coordinateEntry()` carried an explicit comment saying that everything from the duplicate guard
 * to `claim()` "RUNS SYNCHRONOUSLY, AND MUST", and that "no `await` may be added between the
 * guards below and `this.claim(...)`". Two awaits had since been added in exactly that window:
 *
 *     const incumbent = this.activeOpportunities.get(opportunityId);   // CHECK
 *     ...
 *     await this.deps.sessionConsumeAttempt();                         // YIELD  ← spends budget
 *     await this.holdUnderlying(...);                                  // YIELD
 *     ...
 *     this.claim(executionId, opportunityId, ...);                     // ACT
 *
 * So two identical candidates dispatched on the same tick both read `activeOpportunities` as
 * empty, both yielded, and both spent an attempt from the session budget before either became
 * visible to the other. `duplicateSuppressed` stayed 0, the attempt counter was decremented twice
 * for one opportunity, and the second `claim()` OVERWROTE the first execution's
 * `activeOpportunities` entry — after which execution #1's `abandon()` no longer removed its own
 * key, because that delete is guarded on the key still mapping to itself.
 *
 * SCOPE, STATED HONESTLY: in the reviewed configuration the two racers were usually still
 * serialised further downstream by the contract reservation and by the exclusive per-underlying
 * hold, so this is a reproducible SESSION-BUDGET corruption and a duplicate-admission window, NOT
 * a demonstrated duplicate-order incident. The budget corruption is the part that matters for a
 * supervised one-attempt trial: the trial's whole safety property is the attempt ceiling.
 *
 * A second, independent defect sits underneath it. `BoxTradingSessionManager.commit()` is an
 * unserialised read-modify-write:
 *     const previous = this.record; this.record = next; await save(next);
 *     // on failure: this.record = previous
 * Two overlapping mutations both derive `next` from the same snapshot, so the later `save()`
 * discards the earlier increment; and a failed write can roll back over a NEWER successful
 * mutation, because `previous` was captured before the other writer ran.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THESE TESTS ARE RUNTIME TESTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The existing coverage of this area (tests/box/sessionAttemptBudget.test.mjs section 9) asserts
 * on the SOURCE TEXT of executionCoordinator.ts — that a given call appears, and that a string
 * appears within 700 characters of it. That cannot distinguish "the consume call is before the
 * claim" from "after", which is the entire defect. Everything below drives the REAL
 * `CoordinatedBoxExecutionGateway` over the REAL reservation chain with the REAL
 * `BoxTradingSessionManager`, and observes behaviour.
 *
 * Failing-first: C1, C2, C5, C7b, C8 and C11 fail against 24ecfdb.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CoordinatedBoxExecutionGateway } from "../../dist/box/executionCoordinator.js";
import { InProcessInstrumentReservations } from "../../dist/box/instrumentReservations.js";
import { BoxTradingSessionManager } from "../../dist/box/tradingSessionStore.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg } from "./helpers.mjs";

/** The refusal reason the underlying lock uses, imported rather than hard-coded as a string. */
const UNDERLYING_ALREADY_ACTIVE = "underlying_already_active";

const NOW = 1_700_000_000_000;
const IDENTITY = {
  deployment: "test", instance: "host-w0", pid: 1, boot: "w0", processTag: "host-w0:p1:w0",
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Settle a promise or report it as still pending.
 *
 * Used instead of a bare `await` on the racing entries, because the PRE-FIX behaviour is not a
 * clean wrong answer — both racers claim, then collide in the contract-reservation conflict wait,
 * and the loser's promise never settles at all. A bare await would HANG the suite instead of
 * failing it, and a hang is a much worse regression signal than an assertion diff.
 */
async function settled(promise, ms = 400) {
  const PENDING = Symbol("pending");
  const outcome = await Promise.race([
    promise.then((v) => v, (e) => ({ ok: false, threw: e instanceof Error ? e.message : String(e) })),
    new Promise((r) => setTimeout(() => r(PENDING), ms)),
  ]);
  if (outcome === PENDING) {
    return { ok: false, pending: true, reason: "<never settled>", detail: "still pending" };
  }
  return outcome;
}

/**
 * Let in-flight session persistence finish.
 *
 * `commit()` applies to memory BEFORE awaiting the write, so the in-memory counter is correct
 * immediately while the DURABLE row lags by the write latency. Assertions about what was PERSISTED
 * must wait for that, or they race the very delay the test injected on purpose.
 */
const settleWrites = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/**
 * Let admission run to a stable point.
 *
 * `flush()` alone drains microtasks and immediates, which is NOT enough here: the injected
 * persistence delay is a real `setTimeout`, so an entry awaiting its durable attempt write has not
 * progressed at all when the immediates drain. This waits real time as well, which is exactly the
 * production shape (the write is a network round trip to PostgreSQL).
 */
async function letAdmissionSettle(ms = 60) {
  for (let i = 0; i < 6; i++) await flush();
  await settleWrites(ms);
  for (let i = 0; i < 6; i++) await flush();
}

/* ────────────────────────────── fixtures ────────────────────────────── */

function boxFor({ underlying = "RELIANCE", k1, k2, direction = "LONG_BOX", expiry = "2026-09-24" } = {}) {
  const leg = (strike, type) => ({
    token: Number(`${strike}${type === "CE" ? 1 : 2}`),
    tradingsymbol: `${underlying}${expiry.slice(2, 4)}SEP${strike}${type}`,
    exchange: "NFO", strike, instrument_type: type, expiry, lot_size: 50, tick_size: 0.05,
  });
  return {
    key: `${underlying}|${expiry}|${k1}|${k2}|${direction}`,
    underlying, name: underlying, is_index: false, expiry, direction,
    lower_strike: k1, upper_strike: k2, box_width: k2 - k1, lot_size: 50,
    legs: { k1_ce: leg(k1, "CE"), k2_ce: leg(k2, "CE"), k2_pe: leg(k2, "PE"), k1_pe: leg(k1, "PE") },
  };
}

function detectionFor(candidate) {
  return {
    candidate, at: NOW,
    legs: BOX_LEG_ROLES.map((role) => ({
      role, side: entrySideFor(role, candidate.direction),
      token: candidate.legs[role].token, tradingsymbol: candidate.legs[role].tradingsymbol,
      strike: candidate.legs[role].strike, instrument_type: candidate.legs[role].instrument_type,
      price: 100, qty_at_touch: 50, bid: 99, bid_qty: 50, ask: 100, ask_qty: 50,
      quote_at: NOW, exchange_at: null, quote_version: 1, depth: null,
      age_ms: 5, fresh: true, executable: true,
    })),
    entry_net_debit_per_unit: 20, entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80, gross_edge: 4000,
    tradable: true, depth_ok: true, worst_age_ms: 5, quote_version: 1, reject: null,
  };
}

/** A gateway whose entry blocks until released, so real overlap is observable. */
function controllableGateway({ mode = "paper_legging" } = {}) {
  const started = [];
  const gates = new Map();
  let seq = 0;
  return {
    mode, started,
    finish(i, value) {
      const g = gates.get(i);
      if (g) g.resolve(value ?? { ok: true, trade_id: `t${i}`, legs: [] });
    },
    /**
     * Release EVERY held execution.
     *
     * Called from a `finally` in each test. Without it, a failed assertion leaves a blocked entry
     * promise pending forever, and node's runner then cancels every LATER test in the file with
     * "Promise resolution is still pending" — turning one real failure into thirteen unreadable
     * ones.
     */
    finishAll() {
      for (const [i, g] of gates) g.resolve({ ok: true, trade_id: `t${i}`, legs: [] });
    },
    failWith(i, err) {
      const g = gates.get(i);
      if (g) g.reject(err);
    },
    simulateLeggingEntry(args) {
      const i = seq++;
      started.push(args);
      return new Promise((resolve, reject) => gates.set(i, { resolve, reject }));
    },
    simulateEntry(args) { return this.simulateLeggingEntry(args); },
    simulateLeggingExit: async () => ({ ok: true, legs: [] }),
    simulateExit: async () => ({ ok: true, legs: [] }),
    flattenResidual: async () => ({ ok: true }),
    hasCapacity: () => true,
    estimateExecutableExit: () => [],
  };
}

/* ─────────────────── a real session manager over in-memory persistence ─────────────────── */

/**
 * In-memory persistence with an injectable delay and failure switch.
 *
 * `delayMs > 0` is what turns the consume hook into a genuine yield, which is the production
 * reality (it is a PostgreSQL upsert) and the condition the pre-fix prologue could not survive.
 */
function memoryPersistence({ delayMs = 0, failFrom = null } = {}) {
  const state = { record: null, saves: 0, failing: false };
  return {
    io: {
      load: async () => ({ ok: true, record: state.record }),
      save: async (record) => {
        state.saves++;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (state.failing || (failFrom !== null && state.saves >= failFrom)) {
          throw new Error("persistence unavailable");
        }
        state.record = JSON.parse(JSON.stringify(record));
      },
      flatTradeIds: async () => [],
    },
    state,
  };
}

async function armedSession({ maxAttempts = 1, maxTrades = 1, delayMs = 0, failFrom = null, persistence } = {}) {
  const p = persistence ?? memoryPersistence({ delayMs, failFrom });
  const manager = new BoxTradingSessionManager({
    persistence: p.io,
    configuredMaxCompletedTrades: () => maxTrades,
    configuredMaxEntryAttempts: () => maxAttempts,
    persistenceAvailable: () => true,
    now: () => NOW,
    log: () => {},
  });
  await manager.initialise();
  const armed = await manager.arm({
    armedBy: "test", openBoxes: 0, residualLegs: 0, recoveryActive: false,
  });
  assert.equal(armed.ok, true, `arming failed: ${armed.ok === false ? armed.reason : ""}`);
  return { manager, persistence: p };
}

/* ─────────────────── the real coordinator with the real session hooks ─────────────────── */

function makeCoordinator({ gateway, session, config = {}, activeUnderlyings } = {}) {
  const local = new InProcessInstrumentReservations();
  const consumeCalls = { count: 0 };
  const coordinator = new CoordinatedBoxExecutionGateway({
    inner: gateway,
    reservations: local,
    local,
    waitable: local,
    cfg: cfg({
      conflictWaitMaxMs: 250, instrumentLockTtlMs: 5000, maxConcurrentPerUnderlying: 0,
      reservationClockSkewGraceMs: 0, oneActiveBoxPerUnderlying: false,
      ...config,
    }),
    quotes: { view: () => new Map() },
    broker: () => "zerodha",
    generation: () => 1,
    identity: IDENTITY,
    now: () => NOW,
    sleep: () => new Promise((r) => setImmediate(r)),
    setTimer: () => null,
    clearTimer: () => {},
    log: () => {},
    ...(activeUnderlyings ? { activeUnderlyings } : {}),
    ...(session
      ? {
          sessionEntryGate: () => session.evaluateEntry(false),
          // THE PRODUCTION WIRING, and deliberately asynchronous: in production this is a
          // PostgreSQL upsert. A test that supplies a synchronous stub cannot see this defect,
          // which is why none of the pre-existing tests did.
          sessionConsumeAttempt: () => {
            consumeCalls.count++;
            return session.recordAttemptStarted();
          },
        }
      : {}),
  });
  return { coordinator, local, consumeCalls };
}

function enter(coordinator, candidate) {
  return coordinator.simulateLeggingEntry({
    candidate, detection: detectionFor(candidate),
    stillWanted: () => true, qualify: () => ({ ok: true }),
  });
}

/* ═════════════ C1. the reproduction ═════════════ */

test("C1 REPRODUCTION: two identical candidates with an ASYNC session hook — one suppressed, ONE attempt spent", async (t) => {
  const gateway = controllableGateway();
  // Release any still-blocked entry even if an assertion below throws.
  t.after(() => gateway.finishAll());
  const { manager, persistence } = await armedSession({ maxAttempts: 5, delayMs: 5 });
  const { coordinator, consumeCalls } = makeCoordinator({ gateway, session: manager });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const pa = enter(coordinator, a);
  const pb = enter(coordinator, { ...a });
  await letAdmissionSettle();

  const rb = await settled(pb);
  assert.equal(rb.pending, undefined, "pre-fix the loser never settles at all — it deadlocks in the reservation wait");
  assert.equal(rb.ok, false, "the second identical opportunity must be refused");
  assert.equal(rb.reason, "duplicate", `expected 'duplicate', got '${rb.reason}': ${rb.detail}`);
  assert.equal(coordinator.metrics().duplicateSuppressed, 1);

  // THE BUDGET ASSERTION. Pre-fix both racers reached the consume hook and `entry_attempts`
  // became 2 for a single opportunity — on a one-attempt trial that is the entire safety budget
  // spent by a duplicate.
  assert.equal(consumeCalls.count, 1, "the suppressed duplicate must NOT reach the consume hook");
  assert.equal(manager.snapshot().entry_attempts, 1, "exactly ONE attempt was consumed");
  await settleWrites();
  assert.equal(persistence.state.record.entry_attempts, 1, "and exactly one was persisted");

  gateway.finishAll();
  await pa;
});

test("C11 a duplicate suppressed BEFORE admission consumes no attempt at all (sequential)", async (t) => {
  const gateway = controllableGateway();
  // Release any still-blocked entry even if an assertion below throws.
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 5, delayMs: 2 });
  const { coordinator, consumeCalls } = makeCoordinator({ gateway, session: manager });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const pa = enter(coordinator, a);
  // Let A get all the way through its claim, its durable attempt write and its reservation
  // acquire, so this is unambiguously a LATER duplicate rather than a same-tick race.
  await letAdmissionSettle();

  const rb = await settled(enter(coordinator, { ...a }));
  assert.equal(rb.reason, "duplicate", `expected duplicate, got '${rb.reason}': ${rb.detail}`);
  assert.equal(consumeCalls.count, 1, "a later duplicate must not spend a second attempt either");
  assert.equal(manager.snapshot().entry_attempts, 1);

  gateway.finishAll();
  await pa;
});

/* ═════════════ C2. competing for the FINAL allowance ═════════════ */

test("C2 two DIFFERENT candidates competing for the last attempt: exactly one is admitted", async (t) => {
  const gateway = controllableGateway();
  // Release any still-blocked entry even if an assertion below throws.
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 1, maxTrades: 5, delayMs: 5 });
  const { coordinator } = makeCoordinator({ gateway, session: manager });
  // Different underlyings and different contracts, so neither the duplicate guard nor the
  // contract reservation can serialise them. Only the attempt budget can.
  const a = boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 });
  const b = boxFor({ underlying: "INFY", k1: 1500, k2: 1550 });

  const pa = enter(coordinator, a);
  const pb = enter(coordinator, b);
  await letAdmissionSettle();

  assert.equal(
    manager.snapshot().entry_attempts,
    1,
    "a budget of ONE must never record two consumed attempts",
  );
  assert.equal(gateway.started.length, 1, "exactly one entry reached execution");

  // Whichever lost must be REFUSED, and must name the budget.
  const [ra, rb] = [await settled(pa, 200), await settled(pb, 200)];
  const refusals = [ra, rb].filter((r) => r.ok === false && r.pending === undefined);
  assert.equal(refusals.length, 1, "exactly one of the two was refused");
  assert.equal(
    refusals[0].reason,
    "session_limit_reached",
    `the refusal must name the budget, got '${refusals[0].reason}': ${refusals[0].detail}`,
  );

  // Release the admitted one and confirm it completed normally.
  gateway.finish(0);
  const after = await Promise.all([pa.catch(() => null), pb.catch(() => null)]);
  assert.equal(after.filter((r) => r && r.ok === true).length, 1, "exactly one admitted");
});

test("C7 the LAST allowed attempt proceeds and the NEXT is refused", async (t) => {
  const gateway = controllableGateway();
  // Release any still-blocked entry even if an assertion below throws.
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 1, maxTrades: 5, delayMs: 2 });
  const { coordinator } = makeCoordinator({ gateway, session: manager });

  const first = enter(coordinator, boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 }));
  await letAdmissionSettle();
  assert.equal(gateway.started.length, 1, "the last allowed attempt proceeded");
  assert.equal(manager.snapshot().entry_attempts, 1);

  // C12: exhausting the budget must not retroactively invalidate the attempt that spent it.
  const verdict = manager.evaluateEntry(false);
  assert.equal(verdict.allowed, false, "the budget is now exhausted for FUTURE attempts");
  gateway.finish(0);
  const done = await first;
  assert.equal(done.ok, true, "the already-admitted attempt still completes normally");

  const second = await enter(coordinator, boxFor({ underlying: "INFY", k1: 1500, k2: 1550 }));
  assert.equal(second.ok, false);
  assert.equal(second.reason, "session_limit_reached");
  assert.equal(gateway.started.length, 1, "no second entry reached execution");
});

/* ═════════════ C3/C4. delayed and failing persistence ═════════════ */

test("C3 DELAYED persistence does not open a duplicate window", async (t) => {
  const gateway = controllableGateway();
  // Release any still-blocked entry even if an assertion below throws.
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 5, delayMs: 40 });
  const { coordinator, consumeCalls } = makeCoordinator({ gateway, session: manager });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const pa = enter(coordinator, a);
  const pb = enter(coordinator, { ...a });
  const pc = enter(coordinator, { ...a });
  await new Promise((r) => setTimeout(r, 120));

  const [rb, rc] = [await settled(pb), await settled(pc)];
  assert.equal(rb.reason, "duplicate", `pb: ${rb.detail}`);
  assert.equal(rc.reason, "duplicate", `pc: ${rc.detail}`);
  assert.equal(consumeCalls.count, 1, "a 40ms write must not let two more racers through");
  assert.equal(manager.snapshot().entry_attempts, 1);
  gateway.finish(0);
  await pa;
});

test("C4 a persistence FAILURE refuses the entry, sends nothing, and leaks no claim", async (t) => {
  const gateway = controllableGateway();
  // Release any still-blocked entry even if an assertion below throws.
  t.after(() => gateway.finishAll());
  // failFrom: 2 → initialise/arm write succeeds, the attempt write fails.
  const { manager } = await armedSession({ maxAttempts: 5, failFrom: 2 });
  const { coordinator } = makeCoordinator({ gateway, session: manager });

  const r = await enter(coordinator, boxFor({ k1: 2500, k2: 2550 }));
  assert.equal(r.ok, false, "an attempt that cannot be counted must not be started");
  assert.equal(r.reason, "session_limit_reached");
  assert.match(String(r.detail), /durably|counted|recorded/i);
  assert.equal(gateway.started.length, 0, "ZERO order-placement paths were entered");

  const m = coordinator.metrics();
  assert.equal(m.activeExecutions, 0, "no local claim leaked");
  assert.equal(m.activeInstrumentReservations, 0, "no instrument reservation leaked");

  // And the opportunity is retryable rather than permanently wedged as a phantom incumbent.
  const again = await enter(coordinator, boxFor({ k1: 2500, k2: 2550 }));
  assert.notEqual(again.reason, "duplicate", "a failed attempt must not leave a phantom incumbent");
});

/* ═════════════ C8. no leaked claims on any refusal path ═════════════ */

test("C8 every refusal path leaves zero active executions and zero reservations", async (t) => {
  const gateway = controllableGateway();
  // Release any still-blocked entry even if an assertion below throws.
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 1, maxTrades: 5, delayMs: 2 });
  const { coordinator } = makeCoordinator({ gateway, session: manager });

  const first = enter(coordinator, boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 }));
  await letAdmissionSettle();
  gateway.finish(0);
  await first;

  // Budget now exhausted: this refusal happens at the session gate, before any claim.
  const refused = await enter(coordinator, boxFor({ underlying: "INFY", k1: 1500, k2: 1550 }));
  assert.equal(refused.ok, false);
  const m = coordinator.metrics();
  assert.equal(m.activeExecutions, 0, "refusals must not leave claims behind");
  assert.equal(m.activeInstrumentReservations, 0);
});

/* ═════════════ C5. concurrent session mutations ═════════════ */

/**
 * SCOPE NOTE, stated precisely because it would be easy to overclaim here.
 *
 * C5 and C5b below PASS against the pre-fix build. `commit()` assigns `this.record = next`
 * SYNCHRONOUSLY before awaiting the write, and both of these mutators derive `next` from
 * `this.record` synchronously too, so for this particular pair the in-memory increments happen to
 * compose and the later `save()` happens to land last. They are kept as INVARIANT tests — they pin
 * behaviour the serialization must not break — not as reproductions.
 *
 * C5c is the reproduction. The genuine, demonstrable corruption is the ROLLBACK: a failed write
 * restores a snapshot captured before an interleaved writer ran, so it erases a mutation that had
 * already succeeded durably.
 */
test("C5 INVARIANT: overlapping session writes do not lose a counter", async () => {
  const { manager, persistence } = await armedSession({ maxAttempts: 10, delayMs: 10 });
  const [a, b] = await Promise.all([
    manager.recordAttemptStarted(),
    manager.recordAttemptStarted(),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(manager.snapshot().entry_attempts, 2, "both increments must survive");
  assert.equal(persistence.state.record.entry_attempts, 2, "and both must be persisted");
});

test("C5b INVARIANT: overlapping DIFFERENT mutations do not overwrite newer state", async () => {
  const { manager, persistence } = await armedSession({ maxAttempts: 10, delayMs: 10 });
  await Promise.all([
    manager.recordAttemptStarted(),
    manager.recordAborted(),
    manager.recordAttemptStarted(),
  ]);
  const snap = manager.snapshot();
  assert.equal(snap.entry_attempts, 2, "both attempts recorded");
  assert.equal(snap.aborted_attempts, 1, "the abort was not lost either");
  assert.equal(persistence.state.record.entry_attempts, 2);
  assert.equal(persistence.state.record.aborted_attempts, 1);
});

test("C5c REPRODUCTION: a FAILED SLOW write must not roll back a newer write that already succeeded", async () => {
  // THE INTERLEAVING THAT CORRUPTS THE BUDGET.
  //
  //   write #1 (SLOW, 40ms, FAILS)  : previous := {attempts 0}; record := {attempts 1}; save…
  //   write #2 (FAST,  1ms, OK)     :                            record := {attempts 2}; save OK  ⇒ DURABLE 2
  //   write #1 rejects              : rollbackOnFailure ⇒ record := previous = {attempts 0}
  //
  // In-memory now says ZERO attempts spent while the durable row says TWO. The in-memory figure is
  // the one `evaluateEntry` consults, so the process has just handed itself its whole attempt
  // budget back — the exact failure the budget exists to prevent, and it survives until a restart.
  //
  // Serializing the mutations removes the interleaving: #1 runs to completion (fails, rolls back to
  // 0, durable stays 0) and only then does #2 run, deriving from the current record.
  let n = 0;
  const state = { record: null, saved: [] };
  const io = {
    load: async () => ({ ok: true, record: state.record }),
    save: async (record) => {
      n++;
      if (n === 2) {
        // The SLOW, FAILING write. (n===1 is the arm.)
        await new Promise((r) => setTimeout(r, 40));
        throw new Error("persistence timed out");
      }
      await new Promise((r) => setTimeout(r, 1));
      state.record = JSON.parse(JSON.stringify(record));
      state.saved.push(record.entry_attempts);
    },
    flatTradeIds: async () => [],
  };
  const manager = new BoxTradingSessionManager({
    persistence: io,
    configuredMaxCompletedTrades: () => 5,
    configuredMaxEntryAttempts: () => 10,
    persistenceAvailable: () => true,
    now: () => NOW,
    log: () => {},
  });
  await manager.initialise();
  assert.equal((await manager.arm({ armedBy: "t", openBoxes: 0, residualLegs: 0, recoveryActive: false })).ok, true);

  const slow = manager.recordAttemptStarted(); // will fail after 40ms
  const fast = manager.recordAttemptStarted(); // succeeds quickly
  const [a, b] = await Promise.all([slow, fast]);

  const inMemory = manager.snapshot().entry_attempts;
  const durable = state.record?.entry_attempts ?? 0;

  assert.notEqual(
    inMemory,
    0,
    "a rollback must never reset the spent-attempt counter to zero — that hands the budget back",
  );
  assert.ok(
    inMemory >= durable,
    `in-memory (${inMemory}) must never be BEHIND the durable row (${durable}); ` +
      "the in-memory value is what gates entry, so trailing it re-authorises spent attempts",
  );
  // Exactly one of the two succeeded, and the surviving count reflects it.
  const succeeded = [a, b].filter((r) => r.ok).length;
  assert.equal(succeeded, 1, "one write failed, so exactly one attempt was successfully consumed");
  assert.equal(inMemory, 1, "and the counter shows that one attempt");
  assert.equal(durable, 1, "durable and in-memory agree");
});

/* ═════════════ C6. restart after consumption ═════════════ */

test("C6 a RESTART after consumption does not resurrect the budget", async () => {
  const p = memoryPersistence();
  const { manager } = await armedSession({ maxAttempts: 1, maxTrades: 5, persistence: p });
  const consumed = await manager.recordAttemptStarted();
  assert.equal(consumed.ok, true);
  assert.equal(p.state.record.entry_attempts, 1);

  // A fresh process reading the same durable row.
  const restarted = new BoxTradingSessionManager({
    persistence: p.io,
    configuredMaxCompletedTrades: () => 5,
    configuredMaxEntryAttempts: () => 1,
    persistenceAvailable: () => true,
    now: () => NOW,
    log: () => {},
  });
  await restarted.initialise();
  assert.equal(restarted.snapshot().entry_attempts, 1, "the spent attempt survived the restart");
  const verdict = restarted.evaluateEntry(false);
  assert.equal(verdict.allowed, false, "restarting must not buy another attempt");
  const retry = await restarted.recordAttemptStarted();
  assert.equal(retry.ok, false, "and the budget refuses a further consumption");
});

/* ═════════════ C9. exits and recovery are unaffected ═════════════ */

test("C9 exits and residual flattening are never gated by the attempt budget", async (t) => {
  const gateway = controllableGateway();
  // Release any still-blocked entry even if an assertion below throws.
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 1, maxTrades: 1, delayMs: 2 });
  const { coordinator, consumeCalls } = makeCoordinator({ gateway, session: manager });

  // Spend the entire budget.
  const first = enter(coordinator, boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 }));
  await letAdmissionSettle();
  gateway.finish(0);
  await first;
  assert.equal(manager.evaluateEntry(false).allowed, false, "entry is now closed");
  const consumedBefore = consumeCalls.count;

  const position = { id: "t1", underlying: "RELIANCE", legs: boxFor({ k1: 2500, k2: 2550 }).legs };
  const exit = await coordinator.simulateLeggingExit({
    position, detectionLegs: [], detectedAt: NOW, stillWanted: () => true,
  });
  assert.equal(exit.ok, true, "an exhausted ENTRY budget must never block reducing exposure");

  const flat = await coordinator.flattenResidual({ keyPrefix: "a1", residual: [] });
  assert.ok(flat, "residual flattening is likewise ungated");

  assert.equal(
    consumeCalls.count,
    consumedBefore,
    "no reduction path may consume an ENTRY attempt",
  );
});

/* ═════════════ C10. disarm during an awaited persistence operation ═════════════ */

test("C10 DISARM during the awaited attempt write lets no new order escape", async (t) => {
  const gateway = controllableGateway();
  // Release any still-blocked entry even if an assertion below throws.
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 5, maxTrades: 5, delayMs: 30 });
  const { coordinator } = makeCoordinator({ gateway, session: manager });

  const p = enter(coordinator, boxFor({ k1: 2500, k2: 2550 }));
  // Disarm WHILE the attempt write is in flight (the write takes 30ms; this queues behind it).
  await flush();
  await manager.disarm();
  const r = await settled(p, 300);

  if (r.ok === true) {
    // If the entry won the mutation lock before the disarm queued behind it, it was legitimately
    // admitted — and at most that ONE entry may exist. The final pre-POST guard (arm/ownership) is
    // what stops it going further; nothing new may be admitted after the disarm.
    assert.ok(gateway.started.length <= 1, "at most the one already-admitted entry exists");
  }
  assert.equal(
    manager.snapshot().armed_at,
    null,
    "the session is disarmed and no further attempt may be admitted",
  );
  const after = await enter(coordinator, boxFor({ underlying: "INFY", k1: 1500, k2: 1550 }));
  assert.equal(after.ok, false, "a disarmed session admits nothing new");
  assert.equal(after.reason, "session_limit_reached");
  gateway.finish(0);
  await p.catch(() => {});
});


/* ═════════════════════════════════════════════════════════════════════════════════════════
 * SECTION E — WHICH REFUSALS SPEND AN ATTEMPT, AFTER THE PROLOGUE REORDER
 *
 * Moving the claim above the two awaits also moved two GATES relative to the point where the
 * attempt budget is spent, and that is a behavioural change worth pinning rather than
 * discovering later:
 *
 *   BEFORE:  cycle gate → CONSUME → Layer 1a (durable underlying) → Layer 1b (hold) → budget → claim
 *   AFTER:   duplicate → cycle gate → Layer 1a → per-underlying budget → CLAIM → CONSUME → Layer 1b
 *
 * So a candidate refused because the underlying is ALREADY ACTIVE — an open Box, a partial, a
 * recovery position, or an unresolved RESIDUAL leg — no longer burns an attempt. On a
 * one-attempt supervised trial that distinction is the difference between "the trial is over"
 * and "that candidate was not eligible". It also matches the stated rule that candidates
 * suppressed BEFORE admission must not consume budget.
 *
 * The complement is deliberate and equally pinned: once the attempt has been consumed, a later
 * refusal does NOT refund it (E4). An attempt that got as far as competing for the cross-process
 * underlying lease was a real attempt.
 *
 * These also re-assert invariant E8 (residual quantities block incompatible new entry) through
 * the reordered path. The residual FLATTENING behaviour itself is covered in
 * tests/box/residualRecovery.test.mjs, and the underlying-lock layers in
 * tests/box/underlyingLockCoordinator.test.mjs; this file covers only their interaction with the
 * attempt budget, which is what changed.
 * ═════════════════════════════════════════════════════════════════════════════════════════ */

/** The durable-activity map Layer 1a consults, keyed by normalised underlying. */
function activeUnderlyingMap(underlying, kinds, detail) {
  return () =>
    new Map([[underlying.toUpperCase(), { underlying: underlying.toUpperCase(), kinds, detail }]]);
}

test("E1 an UNDERLYING-ALREADY-ACTIVE refusal spends NO attempt and leaks no claim", async (t) => {
  const gateway = controllableGateway();
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 1, maxTrades: 5, delayMs: 2 });
  const { coordinator, consumeCalls } = makeCoordinator({
    gateway,
    session: manager,
    config: { oneActiveBoxPerUnderlying: true },
    activeUnderlyings: activeUnderlyingMap("RELIANCE", ["open_box"], "an open RELIANCE Box"),
  });

  const r = await settled(enter(coordinator, boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 })));
  assert.equal(r.ok, false, "a second Box on an active underlying is refused");
  assert.equal(consumeCalls.count, 0, "and the refusal must NOT spend the one available attempt");
  assert.equal(manager.snapshot().entry_attempts, 0);
  assert.equal(gateway.started.length, 0, "nothing reached execution");

  const m = coordinator.metrics();
  assert.equal(m.activeExecutions, 0, "no claim leaked");
  assert.equal(m.activeInstrumentReservations, 0, "no reservation leaked");

  // The budget is genuinely intact: a DIFFERENT, eligible underlying can still use it.
  const ok = enter(coordinator, boxFor({ underlying: "INFY", k1: 1500, k2: 1550 }));
  await letAdmissionSettle();
  assert.equal(manager.snapshot().entry_attempts, 1, "the attempt was still available afterwards");
  gateway.finishAll();
  await ok;
});

test("E2 an unresolved RESIDUAL leg blocks a new Box on that underlying without spending an attempt", async (t) => {
  const gateway = controllableGateway();
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 1, maxTrades: 5, delayMs: 2 });
  const { coordinator, consumeCalls } = makeCoordinator({
    gateway,
    session: manager,
    config: { oneActiveBoxPerUnderlying: true },
    activeUnderlyings: activeUnderlyingMap(
      "RELIANCE",
      ["residual_leg"],
      "an unresolved residual RELIANCE leg",
    ),
  });

  const r = await settled(enter(coordinator, boxFor({ underlying: "RELIANCE", k1: 2600, k2: 2650 })));
  assert.equal(r.ok, false, "residual exposure blocks an incompatible new entry");
  assert.match(
    String(r.detail),
    /residual/i,
    "and the refusal names the residual rather than looking like a contract conflict",
  );
  assert.equal(consumeCalls.count, 0, "an ineligible candidate must not consume trial budget");
  assert.equal(manager.snapshot().entry_attempts, 0);
});

test("E3 a CONSUME refusal releases the claim and leaves the underlying free for a later entry", async (t) => {
  const gateway = controllableGateway();
  t.after(() => gateway.finishAll());
  // The attempt write fails, so the consume refuses AFTER the claim has been taken.
  const { manager } = await armedSession({ maxAttempts: 5, failFrom: 2 });
  const { coordinator } = makeCoordinator({
    gateway,
    session: manager,
    config: { oneActiveBoxPerUnderlying: true },
  });

  const r = await settled(enter(coordinator, boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 })));
  assert.equal(r.ok, false);
  assert.equal(gateway.started.length, 0, "ZERO order-placement paths were entered");

  const m = coordinator.metrics();
  assert.equal(m.activeExecutions, 0, "the claim taken before the consume was released");
  assert.equal(m.activeInstrumentReservations, 0);

  // THE POINT: the underlying must not be left held. A leaked exclusive hold here would block
  // this underlying for the rest of the process's life, which a database blip must not cause.
  const retry = await settled(enter(coordinator, boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 })));
  assert.notEqual(
    retry.reason,
    UNDERLYING_ALREADY_ACTIVE,
    "a failed attempt must not leave the underlying permanently held",
  );
  assert.notEqual(retry.reason, "duplicate", "nor leave a phantom incumbent");
});

test("E4 once CONSUMED, a later refusal does NOT refund the attempt", async (t) => {
  const gateway = controllableGateway();
  t.after(() => gateway.finishAll());
  const { manager } = await armedSession({ maxAttempts: 2, maxTrades: 5, delayMs: 2 });

  // Two coordinators sharing one session, as two competing pipelines would: the second takes the
  // same underlying's exclusive hold and is refused at Layer 1b — AFTER consuming.
  const { coordinator, consumeCalls } = makeCoordinator({
    gateway,
    session: manager,
    config: { oneActiveBoxPerUnderlying: true },
  });

  const first = enter(coordinator, boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 }));
  await letAdmissionSettle();
  assert.equal(manager.snapshot().entry_attempts, 1, "the first attempt was consumed");

  // A second, DIFFERENT-CONTRACT Box on the SAME underlying. Layer 1a sees nothing durable yet,
  // so it reaches the consume and then loses the exclusive underlying hold.
  const second = await settled(enter(coordinator, boxFor({ underlying: "RELIANCE", k1: 2600, k2: 2650 })));
  assert.equal(second.ok, false, "the second pipeline on the same underlying is refused");
  assert.equal(
    manager.snapshot().entry_attempts,
    2,
    "the attempt it had already consumed is NOT handed back — it really did attempt",
  );
  assert.equal(consumeCalls.count, 2);

  gateway.finishAll();
  await first;
});
