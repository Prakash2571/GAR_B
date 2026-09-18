/**
 * BOX EXECUTION COORDINATION — contract-level exclusion.
 *
 * The behaviour under test is concurrency, so almost every test here drives TWO
 * executions that genuinely overlap in time (both started before either is awaited)
 * and then asserts on the interleaving that actually occurred. A test that starts
 * them sequentially would pass against completely broken code.
 *
 * The gateway underneath is a controllable fake, because what is being tested is the
 * coordinator's decisions — the real simulator and live adapter are exercised
 * elsewhere. The coordinator itself is the real code.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CoordinatedBoxExecutionGateway } from "../../dist/box/executionCoordinator.js";
import {
  InProcessInstrumentReservations,
  ChainedInstrumentReservations,
  DurableInstrumentReservations,
  InMemoryReservationDatabase,
  InMemoryReservationPort,
} from "../../dist/box/instrumentReservations.js";
import { instrumentKey, boxInstrumentRefs, keysOf } from "../../dist/box/instrumentKey.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg, goodCandidate } from "./helpers.mjs";

const NOW = 1_700_000_000_000;

/**
 * A fixed process identity.
 *
 * Owner ids are now globally unique (`deployment:host:pid:boot:kind-seq:uuid`) rather
 * than a bare per-process counter, because two PM2 workers would both mint `entry-7`
 * and could then renew or release each other's lease. Pinning the identity keeps the
 * deployment label deterministic in assertions; the uuid still makes each owner unique.
 */
const IDENTITY = workerIdentity("w0");

/** A distinct process identity per simulated worker. */
function workerIdentity(tag) {
  return {
    deployment: "test",
    instance: `host-${tag}`,
    pid: 1,
    boot: tag,
    processTag: `host-${tag}:p1:${tag}`,
  };
}

/**
 * Drain the microtask queue.
 *
 * The coordinator's wait path is several awaits deep (wake → re-acquire →
 * revalidate → delegate), and `sleep` is stubbed to resolve immediately, so the
 * whole thing settles in microtasks. `setImmediate` runs after all of them.
 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/* ───────────────────────────── fixtures ───────────────────────────── */

/** A candidate whose four legs are built from explicit strikes, so overlap is exact. */
function boxFor({ underlying = "RELIANCE", k1, k2, direction = "LONG_BOX", expiry = "2026-09-24" } = {}) {
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
    legs: {
      k1_ce: leg(k1, "CE"),
      k2_ce: leg(k2, "CE"),
      k2_pe: leg(k2, "PE"),
      k1_pe: leg(k1, "PE"),
    },
  };
}

function detectionFor(candidate, { grossEdge = 4000, tradable = true } = {}) {
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
    gross_edge_per_unit: grossEdge / 50,
    gross_edge: grossEdge,
    tradable,
    depth_ok: true,
    worst_age_ms: 5,
    quote_version: 1,
    reject: null,
  };
}

/**
 * A gateway whose entry call blocks until the test releases it.
 *
 * This is what makes real overlap testable: execution A can be held mid-flight while
 * B attempts the same contract, which is precisely the race being guarded.
 */
function controllableGateway({ mode = "paper_legging" } = {}) {
  const started = [];
  const gates = new Map();
  let seq = 0;
  return {
    mode,
    started,
    /** Let a held execution finish. */
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
    simulateLeggingEntry(args) {
      const index = seq++;
      started.push({ index, key: args.candidate.key, at: Date.now() });
      return new Promise((resolve) => gates.set(index, resolve));
    },
  };
}

/**
 * @param options.durable  when set, a real `DurableInstrumentReservations` over a shared
 *   in-memory database is chained under the in-process tier — the same topology as
 *   production, so the fail-closed and ownership paths are exercised against the real
 *   chain rather than a stand-in.
 */
function makeCoordinator({
  gateway,
  quotes = new Map(),
  config = {},
  broker = "zerodha",
  clock = { value: NOW },
  now = () => clock.value,
  durable = false,
  generation = { value: 1 },
  db = null,
  // Each simulated worker needs its OWN identity, exactly as two PM2 workers do. Sharing
  // one would make `clear()`'s owner-prefix scoping look like it deletes a sibling's
  // reservations when in reality it cannot.
  identity = IDENTITY,
  // The durable session ATTEMPT consume. Injectable so a test can assert WHETHER an attempt was
  // spent, which is the whole point of the gates that sit before it in the prologue. Undefined by
  // default, exactly as a deployment with no session ceiling configured behaves.
  sessionConsumeAttempt = undefined,
} = {}) {
  const local = new InProcessInstrumentReservations();
  const logs = [];
  const sleepMs = [];
  const brokerRef = { value: broker };
  const context = () => ({
    deployment: identity.deployment,
    broker: brokerRef.value,
    generation: generation.value,
    mode: gateway.mode,
  });

  let store = local;
  let durableStore = null;
  let database = db;
  if (durable) {
    database = database ?? new InMemoryReservationDatabase();
    durableStore = new DurableInstrumentReservations({
      port: new InMemoryReservationPort(database, { clock: now }),
      context,
      ownerPrefix: `${identity.deployment}:${identity.processTag}:`,
      skewGraceMs: 0,
      clockSyncIntervalMs: 1_000_000_000,
      now,
      log: () => {},
    });
    store = new ChainedInstrumentReservations([local, durableStore]);
  }

  const coordinator = new CoordinatedBoxExecutionGateway({
    inner: gateway,
    reservations: store,
    local,
    waitable: local,
    ...(sessionConsumeAttempt ? { sessionConsumeAttempt } : {}),
    cfg: cfg({
      conflictWaitMaxMs: 250,
      instrumentLockTtlMs: 5000,
      maxConcurrentPerUnderlying: 0,
      reservationClockSkewGraceMs: 0,
      durableReservationsEnabled: durable,
      ...config,
    }),
    quotes: { view: () => quotes },
    broker: () => brokerRef.value,
    generation: () => generation.value,
    identity,
    now,
    // Deterministic, and deliberately NOT `() => Promise.resolve()`.
    //
    // (The requested durations are recorded in `sleepMs` so a test can assert the retry
    // jitter is reproducible.)
    //
    // Two properties are needed. It must ADVANCE THE CLOCK, or the conflict-wait
    // deadline is never reached and a waiter that is never woken spins forever. And it
    // must yield a MACROTASK, or the wait loop is a pure microtask loop that starves the
    // event loop — the holder can then never make progress to release, which is a
    // livelock created entirely by the harness. `setImmediate` gives both without any
    // real elapsed time, so the suite stays fast and reproducible.
    sleep: (ms) => {
      sleepMs.push(ms);
      clock.value += Math.max(1, Math.round(ms));
      return new Promise((resolve) => setImmediate(resolve));
    },
    // No heartbeat timer at all. Renewal is driven explicitly via `renewTick()`, so a
    // test can decide exactly when it happens instead of racing a real interval.
    setTimer: () => null,
    clearTimer: () => {},
    log: (f) => logs.push(f),
  });
  // `reservations` keeps its historical meaning — the in-process tier — so the existing
  // assertions about what this process holds read unchanged.
  return { coordinator, reservations: local, durableStore, store, database, logs, sleepMs, brokerRef, generation, clock };
}

async function readyCoordinator(options = {}) {
  const made = makeCoordinator(options);
  if (made.durableStore !== null) await made.durableStore.initialise();
  return made;
}

/* ════════════════════ instrument identity & namespaces ════════════════════ */

test("T23: Zerodha and Dhan namespaces cannot collide on an identical token", () => {
  const inst = { token: 12345, tradingsymbol: "RELIANCE24SEP2550CE", exchange: "NFO" };
  const z = instrumentKey("zerodha", inst);
  const d = instrumentKey("dhan", inst);
  assert.notEqual(z, d, "the same contract under two brokers must be two keys");
  assert.match(z, /^ZERODHA:/);
  assert.match(d, /^DHAN:/);

  // And a token-only fallback is still namespaced.
  const zt = instrumentKey("zerodha", { token: 999, tradingsymbol: "", exchange: "NFO" });
  const dt = instrumentKey("dhan", { token: 999, tradingsymbol: "", exchange: "NFO" });
  assert.notEqual(zt, dt, "identical numeric tokens must not collide across brokers");
});

test("T9-a: instrument keys are emitted in a deterministic total order", () => {
  const a = boxFor({ k1: 2500, k2: 2550 });
  const refs1 = boxInstrumentRefs("zerodha", a.legs, (r) => entrySideFor(r, "LONG_BOX"), BOX_LEG_ROLES);
  const refs2 = boxInstrumentRefs("zerodha", a.legs, (r) => entrySideFor(r, "LONG_BOX"), [...BOX_LEG_ROLES].reverse());
  assert.deepEqual(keysOf(refs1), keysOf(refs2), "key order must not depend on role iteration order");
  const sorted = [...keysOf(refs1)].sort();
  assert.deepEqual(keysOf(refs1), sorted, "keys must be sorted, so a lock-ordering tier cannot deadlock");
});

/* ════════════════════════ reservation store ════════════════════════ */

/*
 * These now `await`. The store interface became asynchronous when a durable
 * cross-process tier was added — a shared correctness authority is a database, and a
 * database is I/O. The in-process tier is still atomic despite that: its methods are
 * `async` with NO `await` in the body, so the inspect-then-commit critical section
 * still runs to completion in a single turn of the event loop. `T8`/`T9-c` below prove
 * that behaviourally by racing two overlapping executions.
 */

test("T19: an owner cannot release another owner's reservation", async () => {
  const store = new InProcessInstrumentReservations();
  assert.equal((await store.tryAcquireAll({ owner: "A", keys: ["K1"], ttlMs: 1000, now: NOW })).ok, true);
  const released = await store.release({ owner: "B", keys: ["K1"], now: NOW });
  assert.equal(released, 0, "B must not be able to release K1");
  assert.equal(await store.ownerOf("K1", NOW), "A", "A still holds it");
  assert.equal(await store.release({ owner: "A", keys: ["K1"], now: NOW }), 1, "A can release its own");
  assert.equal(await store.ownerOf("K1", NOW), null);
});

test("T9-b: acquisition is all-or-none, so no partial state can deadlock", async () => {
  const store = new InProcessInstrumentReservations();
  await store.tryAcquireAll({ owner: "A", keys: ["X"], ttlMs: 1000, now: NOW });

  // B wants X and Y. X is taken, so B must get NEITHER.
  const outcome = await store.tryAcquireAll({ owner: "B", keys: ["X", "Y"], ttlMs: 1000, now: NOW });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "conflict");
  assert.deepEqual(outcome.conflicts.map((c) => c.key), ["X"]);
  assert.equal(await store.ownerOf("Y", NOW), null, "Y must NOT have been taken by the failed attempt");

  // Which is exactly what prevents the classic cycle: B never holds Y while waiting
  // for X, so A can still take Y and finish.
  assert.equal((await store.tryAcquireAll({ owner: "A", keys: ["Y"], ttlMs: 1000, now: NOW })).ok, true);
});

test("T18: a crashed owner's reservation is recoverable through TTL expiry", async () => {
  const store = new InProcessInstrumentReservations();
  await store.tryAcquireAll({ owner: "dead-process", keys: ["K"], ttlMs: 1000, now: NOW });
  assert.equal(await store.ownerOf("K", NOW + 999), "dead-process", "still held before expiry");
  assert.equal(await store.ownerOf("K", NOW + 1001), null, "expired, so recoverable without any cleanup");
  assert.equal((await store.tryAcquireAll({ owner: "new", keys: ["K"], ttlMs: 1000, now: NOW + 1001 })).ok, true);
});

test("T26: the store stays bounded — expired entries are swept, not accumulated", async () => {
  const store = new InProcessInstrumentReservations();
  for (let i = 0; i < 5000; i++) {
    await store.tryAcquireAll({ owner: `o${i}`, keys: [`K${i}`], ttlMs: 10, now: NOW });
  }
  assert.equal(store.activeCount(NOW), 5000, "all live before expiry");
  assert.equal(store.activeCount(NOW + 11), 0, "every expired entry is swept");
  assert.equal(store.activeKeys(NOW + 11).length, 0, "no residue left behind");
});

test("chained tiers roll back so all-or-none holds across tiers too", async () => {
  const primary = new InProcessInstrumentReservations();
  const secondary = new InProcessInstrumentReservations();
  // Secondary already holds K under a different owner, so the chain must fail AND
  // must not leave the primary holding it.
  await secondary.tryAcquireAll({ owner: "other", keys: ["K"], ttlMs: 1000, now: NOW });
  const chain = new ChainedInstrumentReservations([primary, secondary]);
  const outcome = await chain.tryAcquireAll({ owner: "me", keys: ["K"], ttlMs: 1000, now: NOW });
  assert.equal(outcome.ok, false);
  assert.equal(await primary.ownerOf("K", NOW), null, "primary must have been rolled back");
});

/* ════════════════════════ concurrency behaviour ════════════════════════ */

test("T7: two boxes sharing NO instrument execute concurrently", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });

  const reliance = boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 });
  const tcs = boxFor({ underlying: "TCS", k1: 3000, k2: 3050 });

  // Both started before either is awaited — genuinely overlapping.
  const pa = coordinator.simulateLeggingEntry({ candidate: reliance, detection: detectionFor(reliance), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: tcs, detection: detectionFor(tcs), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();

  assert.equal(gateway.started.length, 2, "both must reach the executor without waiting for each other");
  gateway.finish(0);
  gateway.finish(1);
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
});

test("T8: two boxes sharing ONE instrument cannot submit it simultaneously", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });

  // 2500/2550 and 2550/2600 both trade the 2550 strike.
  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();

  assert.equal(gateway.started.length, 1, "only ONE may be in the executor while they share 2550");
  assert.equal(gateway.started[0].key, a.key, "the first to reserve wins");

  gateway.finish(0);
  await pa;
  const rb = await pb;
  // B is not silently dropped: it either executed after A released, or aborted on
  // revalidation. Both are correct; simultaneous submission is not.
  assert.ok(rb.ok === true || rb.reason === "edge_disappeared", `B resolved as ${JSON.stringify(rb.reason ?? "ok")}`);
});

test("T9-c: two boxes sharing MULTIPLE instruments cannot deadlock", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });

  // Identical strikes, opposite directions: all four contracts overlap.
  const a = boxFor({ k1: 2500, k2: 2550, direction: "LONG_BOX" });
  const b = boxFor({ k1: 2500, k2: 2550, direction: "SHORT_BOX" });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();

  assert.equal(gateway.started.length, 1, "four-way overlap must serialise");
  gateway.finish(0);
  // The decisive assertion: both promises settle. A deadlock would hang here.
  const settled = await Promise.all([pa, pb]);
  assert.equal(settled.length, 2, "neither execution deadlocked");
});

test("T10/T11: same-side and opposite-side overlaps both serialise safely", async () => {
  for (const [label, dirA, dirB] of [
    ["same side", "LONG_BOX", "LONG_BOX"],
    ["opposite side", "LONG_BOX", "SHORT_BOX"],
  ]) {
    const gateway = controllableGateway();
    const { coordinator } = makeCoordinator({ gateway });
    // Share exactly the 2550 CE/PE pair.
    const a = boxFor({ k1: 2500, k2: 2550, direction: dirA });
    const b = boxFor({ k1: 2550, k2: 2600, direction: dirB });

    const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
    const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
    await flush();
    await flush();

    assert.equal(gateway.started.length, 1, `${label}: must serialise (no internal netting by default)`);
    gateway.finish(0);
    await Promise.all([pa, pb]);
  }
});

test("T20: an identical opportunity cannot execute twice concurrently", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: { ...a }, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();

  const rb = await pb;
  assert.equal(rb.ok, false);
  assert.equal(rb.reason, "duplicate", "the second identical opportunity is suppressed, not queued");
  assert.equal(coordinator.metrics().duplicateSuppressed, 1);
  gateway.finish(0);
  await pa;
});

/* ════════════════════════ revalidation ════════════════════════ */

test("T13: a deteriorated opportunity ABORTS after waiting", async () => {
  const gateway = controllableGateway();
  // Empty quote map ⇒ revalidation finds no book ⇒ not tradable.
  const { coordinator, logs } = makeCoordinator({ gateway, quotes: new Map() });

  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();

  gateway.finish(0); // release A, waking B
  await pa;
  const rb = await pb;

  assert.equal(rb.ok, false);
  assert.equal(rb.reason, "edge_disappeared", "queue position is not a reason to trade");
  assert.equal(gateway.started.length, 1, "B must never have reached the executor");
  assert.equal(coordinator.metrics().revalidationRejected, 1);
  assert.ok(logs.some((l) => l.status === "abort"), "the abort must be logged with its reason");
});

test("T12/T14: the waiting box is re-priced, and proceeds when still valid", async () => {
  const gateway = controllableGateway();
  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });

  // A live book good enough for B's revalidation to pass.
  const quotes = new Map();
  for (const cand of [a, b]) {
    for (const role of BOX_LEG_ROLES) {
      const inst = cand.legs[role];
      quotes.set(inst.token, {
        token: inst.token,
        bid: 100, ask: 100.05,
        bids: [{ price: 100, quantity: 500, orders: 1 }],
        asks: [{ price: 100.05, quantity: 500, orders: 1 }],
        last: 100, at: NOW, version: 1, source: "ws",
        exchange_at: null,
      });
    }
  }
  const { coordinator, logs } = makeCoordinator({ gateway, quotes });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  // B's detected edge is tiny, so whatever the fresh book says cannot be a
  // deterioration — this isolates "was it re-measured and allowed through".
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b, { grossEdge: 1 }), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();
  assert.equal(gateway.started.length, 1, "serialised while 2550 is shared");

  gateway.finish(0);
  await pa;
  // The wake → re-acquire → revalidate → delegate path is several awaits deep, so
  // drain the microtask queue rather than guessing a number of ticks.
  await flush();

  const m = coordinator.metrics();
  assert.equal(m.revalidationPassed + m.revalidationRejected, 1, "B was revalidated exactly once");
  if (m.revalidationPassed === 1) {
    assert.equal(gateway.started.length, 2, "a still-valid opportunity proceeds");
    assert.ok(logs.some((l) => l.status === "execute" && l.revalidated === true), "and logs the revalidated execute");
    gateway.finish(1);
  }
  await pb;
});

/* ════════════════════════ release semantics ════════════════════════ */

test("T15: a reservation is released after a clean terminal state", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(reservations.activeCount(NOW), 4, "all four legs reserved while executing");

  gateway.finish(0, { ok: true, legging: { residual_exposure: [] } });
  await pa;
  assert.equal(reservations.activeCount(NOW), 0, "released once the outcome is knowable");
});

test("T16/T17: residual exposure and unknown state do NOT release the reservation", async () => {
  for (const [label, result] of [
    ["residual exposure", { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [{ role: "k1_ce" }] } }],
    ["ambiguous terminal", { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [] } }],
    ["failed unwind", { ok: false, reason: "unwind_failed", legging: { residual_exposure: [] } }],
  ]) {
    const gateway = controllableGateway();
    const { coordinator, reservations } = makeCoordinator({ gateway });
    const a = boxFor({ k1: 2500, k2: 2550 });

    const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
    await flush();
    gateway.finish(0, result);
    await pa;

    assert.equal(
      reservations.activeCount(NOW),
      4,
      `${label}: the contracts must stay reserved so a second box cannot assume there is no exposure`,
    );
    // …and it is still bounded: the TTL, not a leak.
    assert.equal(reservations.activeCount(NOW + 5001), 0, `${label}: TTL still bounds it`);
    assert.equal(coordinator.metrics().reservationsHeldOnUncertainty, 1);
  }
});

test("a thrown execution holds the reservation rather than releasing on unknown state", async () => {
  const gateway = controllableGateway();
  gateway.simulateLeggingEntry = async () => {
    throw new Error("transport exploded mid-submit");
  };
  const { coordinator, reservations } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });

  await assert.rejects(
    () => coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) }),
    /transport exploded/,
  );
  assert.equal(reservations.activeCount(NOW), 4, "unknown state must not free the contracts");
  assert.equal(coordinator.metrics().reservationsHeldOnUncertainty, 1);
});

/* ════════════════════════ fail-closed & paper parity ════════════════════════ */

test("T25: live execution fails CLOSED when a durable store is required but absent", async () => {
  const gateway = controllableGateway({ mode: "live" });
  const { coordinator } = makeCoordinator({
    gateway,
    config: { reservationRequireDurable: true },
  });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const r = await coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });

  assert.equal(r.ok, false, "live must refuse rather than execute uncoordinated");
  assert.match(r.detail, /not durable/);
  assert.equal(gateway.started.length, 0, "nothing reached the executor");
  assert.equal(coordinator.metrics().failedClosed, 1);
});

test("T25-b: paper may continue on the in-process store, and says which store it is", async () => {
  const gateway = controllableGateway({ mode: "paper_legging" });
  const { coordinator } = makeCoordinator({ gateway, config: { reservationRequireDurable: true } });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const p = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(gateway.started.length, 1, "paper is not blocked, so development and tests still work");
  assert.equal(coordinator.metrics().store, "in-process");
  assert.equal(coordinator.metrics().durable, false, "and it is honest about not being durable");
  gateway.finish(0);
  await p;
});

test("T22: PAPER goes through the same coordinator as live — no shortcut", async () => {
  // The decisive structural check: the coordinator is mode-agnostic, so a paper
  // gateway is coordinated by exactly the same code path as a live one.
  for (const mode of ["paper_touch", "paper_latency", "paper_legging", "live"]) {
    const gateway = controllableGateway({ mode });
    const { coordinator } = makeCoordinator({ gateway });
    assert.equal(coordinator.mode, mode, "the coordinator reports the wrapped mode");

    const a = boxFor({ k1: 2500, k2: 2550 });
    const b = boxFor({ k1: 2550, k2: 2600 });
    const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
    const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
    await flush();
    await flush();
    assert.equal(gateway.started.length, 1, `${mode}: shared contract must serialise in every mode`);
    gateway.finish(0);
    await Promise.all([pa, pb]);
  }
});

test("the coordinator can be disabled, and then does not gate at all", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway, config: { executionCoordinatorEnabled: false } });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });
  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();
  assert.equal(gateway.started.length, 2, "the escape hatch genuinely bypasses coordination");
  gateway.finish(0);
  gateway.finish(1);
  await Promise.all([pa, pb]);
});

/* ════════════════════════ broker switch & budgets ════════════════════════ */

test("T24-adjacent: a broker switch clears every reservation", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const p = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(reservations.activeCount(NOW), 4);

  await coordinator.resetForBrokerSwitch();
  assert.equal(reservations.activeCount(NOW), 0, "old-namespace keys must not survive a switch");
  assert.equal(coordinator.metrics().activeExecutions, 0);
  gateway.finish(0);
  await p;
});

test("the per-underlying budget caps concurrency WITHOUT replacing per-contract exclusion", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway, config: { maxConcurrentPerUnderlying: 1 } });

  // Same underlying, ZERO shared contracts: excluded only by the budget.
  const a = boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 });
  const b = boxFor({ underlying: "RELIANCE", k1: 2800, k2: 2850 });
  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();
  assert.equal(gateway.started.length, 1, "budget of 1 admits one");
  gateway.finish(0);
  await Promise.all([pa, pb]);

  // With the budget OFF the same two run concurrently, proving the budget — not a
  // contract conflict — was the constraint.
  const g2 = controllableGateway();
  const { coordinator: c2 } = makeCoordinator({ gateway: g2, config: { maxConcurrentPerUnderlying: 0 } });
  const qa = c2.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const qb = c2.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();
  assert.equal(g2.started.length, 2, "2500/2550 and 2800/2850 share nothing and must run together");
  g2.finish(0);
  g2.finish(1);
  await Promise.all([qa, qb]);
});

test("residual flattening is never gated behind a reservation", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const p = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(reservations.activeCount(NOW), 4, "an entry holds all four legs");

  // Flattening reduces exposure that already exists; making it queue behind a
  // speculative entry would leave a naked leg open.
  const flat = await coordinator.flattenResidual({ keyPrefix: "t", residual: [] });
  assert.ok(flat, "flatten proceeded despite the reservation");
  gateway.finish(0);
  await p;
});

test("metrics expose coordination without high-cardinality labels", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });
  const m = coordinator.metrics();
  for (const field of [
    "activeExecutions", "activeInstrumentReservations", "waitingExecutions",
    "reservationConflicts", "duplicateSuppressed", "expiredWhileWaiting",
    "revalidationRejected", "reservationsHeldOnUncertainty", "failedClosed",
  ]) {
    assert.equal(typeof m[field], "number", `${field} must be a number`);
  }
  assert.ok("p50" in m.waitMs && "p95" in m.waitMs, "wait duration percentiles are exposed");
  // No ids or symbols anywhere in the snapshot.
  const json = JSON.stringify(m);
  assert.doesNotMatch(json, /entry-|exit-|RELIANCE|NFO:/, "metrics must not carry ids or symbols");
});


/* ════════════════ durable tier: fail-closed, ownership, generation ════════════════
 *
 * These drive the REAL chain — `InProcessInstrumentReservations` in front of a real
 * `DurableInstrumentReservations` over a shared in-memory database — so the coordinator's
 * behaviour is observed against the production topology rather than a stand-in.
 */

test("MPC1: two WORKERS sharing a database cannot both submit the same contract", async () => {
  // One database, two independent coordinators with their own in-process tiers: exactly
  // the PM2-cluster / two-replica topology. Under the old process-local store both of
  // these would have reached their executor.
  const db = new InMemoryReservationDatabase();
  const gatewayA = controllableGateway();
  const gatewayB = controllableGateway();
  const a = await readyCoordinator({ gateway: gatewayA, durable: true, db, identity: workerIdentity("wa") });
  const b = await readyCoordinator({ gateway: gatewayB, durable: true, db, identity: workerIdentity("wb") });

  // 2500/2550 and 2550/2600 both trade the 2550 strike.
  const boxA = boxFor({ k1: 2500, k2: 2550 });
  const boxB = boxFor({ k1: 2550, k2: 2600 });

  const pa = a.coordinator.simulateLeggingEntry({ candidate: boxA, detection: detectionFor(boxA), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = b.coordinator.simulateLeggingEntry({ candidate: boxB, detection: detectionFor(boxB), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();

  const submitted = gatewayA.started.length + gatewayB.started.length;
  assert.equal(submitted, 1, "only ONE worker may submit while they share the 2550 strike");

  const winner = gatewayA.started.length === 1 ? gatewayA : gatewayB;
  winner.finish(0);
  const [ra, rb] = await Promise.all([pa, pb]);
  // The loser either executed after the release or aborted on revalidation. Never both
  // at once, which is the whole point.
  for (const r of [ra, rb]) {
    assert.ok(r.ok === true || r.ok === false, "both settled");
  }
  assert.equal(db.docs.size, 0, "no durable reservation leaked");
});

test("MPC2: two WORKERS on unrelated boxes still execute concurrently", async () => {
  const db = new InMemoryReservationDatabase();
  const gatewayA = controllableGateway();
  const gatewayB = controllableGateway();
  const a = await readyCoordinator({ gateway: gatewayA, durable: true, db, identity: workerIdentity("wa") });
  const b = await readyCoordinator({ gateway: gatewayB, durable: true, db, identity: workerIdentity("wb") });

  const reliance = boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 });
  const tcs = boxFor({ underlying: "TCS", k1: 3000, k2: 3050 });

  const pa = a.coordinator.simulateLeggingEntry({ candidate: reliance, detection: detectionFor(reliance), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = b.coordinator.simulateLeggingEntry({ candidate: tcs, detection: detectionFor(tcs), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();

  assert.equal(gatewayA.started.length, 1, "RELIANCE proceeds");
  assert.equal(gatewayB.started.length, 1, "TCS proceeds — distributed locking must not serialise the world");
  gatewayA.finish(0);
  gatewayB.finish(0);
  await Promise.all([pa, pb]);
});

test("MPC3 (mandatory): a durable OUTAGE blocks a LIVE entry, and says exactly why", async () => {
  const gateway = controllableGateway({ mode: "live" });
  const made = await readyCoordinator({ gateway, durable: true });
  made.database.failure = new Error("connection timed out");

  const a = boxFor({ k1: 2500, k2: 2550 });
  const r = await made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });

  assert.equal(r.ok, false, "live must not open new exposure it cannot exclude other workers from");
  assert.match(r.detail, /durable_reservation_unavailable/, "the reason is machine-greppable");
  assert.equal(gateway.started.length, 0, "nothing reached the executor");

  const m = made.coordinator.metrics();
  assert.equal(m.durableUnavailableRefusals, 1);
  assert.equal(m.failedClosed, 1);
  // And the local tier is not left holding phantom contracts.
  assert.equal(made.reservations.activeCount(NOW), 0, "the local reservation was rolled back");
  assert.equal(m.activeExecutions, 0, "the claim was released, so the opportunity is not self-suppressed");

  // The health surface makes it unmissable.
  const h = made.coordinator.coordinationHealth();
  assert.equal(h.liveEntryBlocked, true);
  assert.match(h.liveEntryBlockedReason, /durable_reservation_unavailable/);
  assert.equal(h.durableReady, false);
});

test("MPC4 (mandatory): PAPER degrades to an explicitly-labelled local_only mode", async () => {
  const gateway = controllableGateway({ mode: "paper_legging" });
  const made = await readyCoordinator({ gateway, durable: true });
  made.database.failure = new Error("primary stepped down");

  const a = boxFor({ k1: 2500, k2: 2550 });
  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();

  assert.equal(gateway.started.length, 1, "paper is not blocked, so a machine with no database still works");
  const m = made.coordinator.metrics();
  assert.equal(m.localOnlyFallbacks, 1, "and the degradation is COUNTED, not silent");
  assert.equal(m.failedClosed, 0);
  assert.ok(made.logs.some((l) => l.reservationDurability === "local_only"), "and labelled in the log");
  // Paper never reaches a broker, so live entry blocking does not apply to it.
  assert.equal(made.coordinator.coordinationHealth().liveEntryBlocked, false);
  gateway.finish(0);
  await p;
});

test("MPC5 (mandatory): emergency residual flattening survives a total durable outage", async () => {
  const gateway = controllableGateway({ mode: "live" });
  const made = await readyCoordinator({ gateway, durable: true });
  made.database.failure = new Error("cluster unreachable");

  // "Cannot flatten a naked leg because a database lock is unavailable" must be
  // unreachable: reducing existing exposure outranks cross-process exclusion.
  const flat = await made.coordinator.flattenResidual({ keyPrefix: "emergency", residual: [] });
  assert.ok(flat, "residual flattening proceeded with the authority completely down");
});

test("MPC6: an EXIT proceeds on the local tier during a durable outage", async () => {
  const gateway = controllableGateway({ mode: "live" });
  const made = await readyCoordinator({ gateway, durable: true });
  const position = { ...boxFor({ k1: 2500, k2: 2550 }), id: "p1" };
  made.database.failure = new Error("down");

  const r = await made.coordinator.simulateLeggingExit({ position, detectionLegs: [], detectedAt: NOW });
  assert.equal(r.ok, true, "an exit must not be blocked by a database outage — that would strand a position");
  assert.equal(made.coordinator.metrics().localOnlyFallbacks, 1, "and it is recorded as a degraded exit");
});

test("MPC7 (mandatory): ownership loss mid-execution aborts the remaining legs", async () => {
  const gateway = controllableGateway();
  const made = await readyCoordinator({ gateway, durable: true });
  const a = boxFor({ k1: 2500, k2: 2550 });

  let invariants = [];
  gateway.invariantViolation = (reason) => invariants.push(reason);

  // Capture the composed `stillWanted` the coordinator hands to the executor.
  let handed = null;
  const inner = gateway.simulateLeggingEntry.bind(gateway);
  gateway.simulateLeggingEntry = (args) => {
    handed = args.stillWanted;
    return inner(args);
  };

  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(gateway.started.length, 1);
  assert.equal(typeof handed, "function", "the coordinator composes its own ownership predicate in");
  assert.equal(handed(), true, "ownership holds while the lease is fresh");

  // Another worker takes the contracts out from under this one: delete the lease and let
  // a rival claim it, which is what a GC stall plus TTL expiry looks like from here.
  made.database.docs.clear();
  made.database.uniqueIndex.clear();

  // The heartbeat is driven explicitly, so this is the renewal that discovers the loss.
  await made.coordinator.renewTick();

  assert.equal(handed(), false, "ownership loss must abort the remaining legs");
  assert.equal(made.coordinator.metrics().reservationOwnershipLost, 1);
  assert.equal(made.coordinator.metrics().reservationRenewFailure, 1);
  assert.equal(invariants.length, 1, "losing a lease mid-execution is an INVARIANT VIOLATION, not a retry");
  assert.match(invariants[0], /ownership/);

  gateway.finish(0, { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [] } });
  await p;
});

test("MPC8: a healthy long execution keeps its lease by renewing", async () => {
  const gateway = controllableGateway();
  const made = await readyCoordinator({ gateway, durable: true });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();

  // Walk the clock most of the way to expiry, renewing as the heartbeat would.
  for (let i = 0; i < 5; i++) {
    made.clock.value += 1500;
    await made.coordinator.renewTick();
  }
  const m = made.coordinator.metrics();
  assert.equal(m.reservationRenewSuccess, 5, "every renewal succeeded");
  assert.equal(m.reservationOwnershipLost, 0, "so ownership was never in doubt");
  assert.equal(made.database.docs.size, 1, "and exactly one durable reservation exists throughout");

  gateway.finish(0);
  await p;
  assert.equal(made.database.docs.size, 0, "released on a clean terminal state");
});

test("MPC9 (mandatory): a STALE BROKER GENERATION refuses execution", async () => {
  const gateway = controllableGateway({ mode: "live" });
  const generation = { value: 10 };
  const made = await readyCoordinator({ gateway, durable: true, generation });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });

  // Hold the 2550 strike so the second entry has to WAIT — which is the window in which
  // a broker switch can land.
  const held = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(gateway.started.length, 1);

  const waiting = made.coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();

  // The broker switches while the second entry is queued.
  generation.value = 11;
  gateway.finish(0);
  await held;
  const r = await waiting;

  assert.equal(r.ok, false, "a reservation from generation 10 must not authorise a trade under generation 11");
  assert.match(r.detail, /stale_broker_generation|edge_disappeared|revalidation/, `got ${r.detail}`);
  assert.equal(gateway.started.length, 1, "the stale-generation entry never reached the executor");
});

test("MPC10: renewal itself refuses a superseded generation, so a heartbeat cannot keep a stale lease alive", async () => {
  const gateway = controllableGateway();
  const generation = { value: 10 };
  const made = await readyCoordinator({ gateway, durable: true, generation });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();

  generation.value = 11;
  await made.coordinator.renewTick();

  assert.equal(made.coordinator.metrics().reservationOwnershipLost, 1, "the lease is treated as lost, not extended");
  gateway.finish(0, { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [] } });
  await p;
});

test("MPC11: an uncertain terminal state keeps the durable reservation AND keeps renewing it", async () => {
  const gateway = controllableGateway();
  const made = await readyCoordinator({ gateway, durable: true, config: { reservationUncertainHoldMaxMs: 10_000 } });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  // Residual exposure: the terminal state is NOT knowable.
  gateway.finish(0, { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [{ role: "k1_ce" }] } });
  await p;

  assert.equal(made.database.docs.size, 1, "protection is HELD — releasing would imply there is no exposure");
  assert.equal(made.coordinator.metrics().uncertainHoldsActive, 1);

  // A healthy process keeps the hold alive rather than letting it lapse at the TTL.
  made.clock.value += 2000;
  await made.coordinator.renewTick();
  assert.equal(made.database.docs.size, 1, "still protected past the original TTL");
  assert.ok(made.coordinator.metrics().reservationRenewSuccess >= 1);

  // But it is BOUNDED: one ambiguous outcome must not lock a strike all day.
  made.clock.value += 10_001;
  await made.coordinator.renewTick();
  assert.equal(made.coordinator.metrics().uncertainHoldsActive, 0, "the hold stops being renewed");
  assert.equal(made.coordinator.metrics().uncertainHoldsAbandoned, 1);
  // Left to EXPIRE, never actively released — releasing is the "assume no exposure" mistake.
  assert.equal(made.database.docs.size, 1, "the document is left to lapse by TTL");
});

test("MPC12: a broker switch clears this process's durable reservations but NOT a sibling worker's", async () => {
  const db = new InMemoryReservationDatabase();
  const gatewayA = controllableGateway();
  const gatewayB = controllableGateway();
  const mine = await readyCoordinator({ gateway: gatewayA, durable: true, db, identity: workerIdentity("mine") });
  const sibling = await readyCoordinator({ gateway: gatewayB, durable: true, db, identity: workerIdentity("sibling") });

  const boxA = boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 });
  const boxB = boxFor({ underlying: "TCS", k1: 3000, k2: 3050 });
  const pa = mine.coordinator.simulateLeggingEntry({ candidate: boxA, detection: detectionFor(boxA), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = sibling.coordinator.simulateLeggingEntry({ candidate: boxB, detection: detectionFor(boxB), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();
  assert.equal(db.docs.size, 2, "both workers hold a reservation");

  await mine.coordinator.resetForBrokerSwitch();

  assert.equal(db.docs.size, 1, "only MY reservations are dropped");
  assert.equal(mine.reservations.activeCount(NOW), 0);
  // Deleting the sibling's live lease would be exactly the multi-process violation this
  // whole subsystem exists to prevent.
  assert.equal(sibling.reservations.activeCount(NOW), 4, "the sibling worker is untouched");

  gatewayA.finish(0);
  gatewayB.finish(0);
  await Promise.all([pa, pb]);
});

test("MPC13: the local tier answers a same-process conflict without touching the database", async () => {
  const gateway = controllableGateway();
  const made = await readyCoordinator({ gateway, durable: true });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });

  const pa = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  const opsBefore = made.database.operations;

  const pb = made.coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  // One microtask: enough for the local tier to reject, not enough to have waited.
  await Promise.resolve();
  assert.equal(
    made.database.operations,
    opsBefore,
    "a conflict this process already knows about must never cost a network round trip",
  );

  gateway.finish(0);
  await pa;
  await pb;
});

test("MPC14: metrics and health expose durable state with no high-cardinality labels", async () => {
  const gateway = controllableGateway();
  const made = await readyCoordinator({ gateway, durable: true });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();

  const m = made.coordinator.metrics();
  for (const field of [
    "durableAcquireAttempts", "durableAcquireSuccess", "durableConflicts", "durableErrors",
    "reservationRenewSuccess", "reservationRenewFailure", "reservationOwnershipLost",
    "expiredReservationsObserved", "durableUnavailableRefusals", "localOnlyFallbacks",
    "staleGenerationAborts", "uncertainHoldsActive", "uncertainHoldsAbandoned",
  ]) {
    assert.equal(typeof m[field], "number", `${field} must be a number`);
  }
  assert.equal(m.reservationStore, "in-process+memory");
  assert.equal(m.reservationDurability, "durable");
  assert.equal(m.durableReservationsEnabled, true);
  assert.equal(m.durableReady, true);
  assert.ok(m.durableAcquireSuccess >= 1);

  const h = made.coordinator.coordinationHealth();
  assert.equal(h.enabled, true);
  assert.equal(h.localStore, "in-process");
  assert.equal(h.durableStore, "memory");
  assert.equal(h.durableReady, true);
  assert.equal(h.deployment, "test");
  assert.equal(h.activeReservations, 4);
  assert.equal(h.ownershipLosses, 0);
  assert.ok(Array.isArray(h.tiers) && h.tiers.length === 2, "per-tier health, so an operator sees WHICH tier is degraded");

  // The same rule as the local-only metrics test: counts and statuses only.
  assert.doesNotMatch(JSON.stringify(m), /entry-|exit-|RELIANCE|NFO:/, "metrics must not carry ids or symbols");

  gateway.finish(0);
  await p;
});

test("MPC15: a durable conflict rolls the local tier back, so a sibling execution is not blocked", async () => {
  const db = new InMemoryReservationDatabase();
  const gatewayA = controllableGateway();
  const gatewayB = controllableGateway();
  const rival = await readyCoordinator({ gateway: gatewayA, durable: true, db, identity: workerIdentity("rival") });
  const mine = await readyCoordinator({ gateway: gatewayB, durable: true, db, config: { conflictWaitMaxMs: 0 }, identity: workerIdentity("mine") });

  const shared = boxFor({ k1: 2500, k2: 2550 });
  const pRival = rival.coordinator.simulateLeggingEntry({ candidate: shared, detection: detectionFor(shared), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();
  assert.equal(gatewayA.started.length, 1);

  // With no wait budget this fails immediately on the DURABLE tier, after the local tier
  // had already granted it.
  const r = await mine.coordinator.simulateLeggingEntry({ candidate: shared, detection: detectionFor(shared), stillWanted: () => true, qualify: () => ({ ok: true }) });
  assert.equal(r.ok, false);
  assert.equal(
    mine.reservations.activeCount(NOW),
    0,
    "the local tier must not keep contracts for a lease the authority refused",
  );

  // Proof it is not blocked: an unrelated box in the same process proceeds at once.
  const other = boxFor({ underlying: "TCS", k1: 3000, k2: 3050 });
  const pOther = mine.coordinator.simulateLeggingEntry({ candidate: other, detection: detectionFor(other), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  await flush();
  assert.equal(gatewayB.started.length, 1, "an unrelated box in this process is unaffected");

  gatewayA.finish(0);
  gatewayB.finish(0);
  await Promise.all([pRival, pOther]);
});

test("MPC16: retry jitter is REPRODUCIBLE per worker and DIFFERENT between workers", async () => {
  // Two properties are needed at once, and they pull in opposite directions.
  //
  // Reproducible, because the execution model must stay fully deterministic — a recorded
  // scenario has to replay identically, and there is a test asserting `Math.random`
  // appears nowhere in src/box.
  //
  // Different between workers, because several workers woken by the same release or the
  // same lease expiry would otherwise retry in lockstep and stampede the authority.
  //
  // A per-process seed derived from the boot token gives both.
  const runOnce = async (identity) => {
    const gateway = controllableGateway();
    // No wait budget would skip the loop entirely; a generous one lets it iterate.
    const made = await readyCoordinator({
      gateway,
      durable: true,
      identity,
      config: { conflictWaitMaxMs: 1000 },
      quotes: new Map(),
    });
    const a = boxFor({ k1: 2500, k2: 2550 });
    const b = boxFor({ k1: 2550, k2: 2600 });
    const pa = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
    await flush();
    // B conflicts on 2550 and enters the bounded retry loop. A is never released, so the
    // loop runs to its deadline — which is exactly the sequence of delays under test.
    const rb = await made.coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
    assert.equal(rb.ok, false, "the waiter gives up rather than waiting forever");
    gateway.finish(0);
    await pa;
    return made.sleepMs;
  };

  const w1a = await runOnce(workerIdentity("alpha"));
  const w1b = await runOnce(workerIdentity("alpha"));
  const w2 = await runOnce(workerIdentity("beta"));

  assert.ok(w1a.length >= 3, `the wait loop must actually iterate (got ${w1a.length} delays)`);
  assert.deepEqual(w1a, w1b, "the same worker replaying the same scenario must produce identical delays");
  assert.notDeepEqual(w1a, w2, "a different worker must NOT retry in lockstep with the first");
  // Bounded: jitter is ±20% around the 100 ms poll interval. The FINAL delay is exempt
  // because it is clamped to whatever remains of `conflictWaitMaxMs` — the wait must never
  // overshoot its deadline, which is what makes it bounded in the first place.
  for (const [i, ms] of w1a.entries()) {
    assert.ok(Number.isInteger(ms), `delay ${ms} should be a whole number of ms`);
    assert.ok(ms >= 1 && ms <= 120, `delay ${ms}ms must never exceed the poll interval band`);
    if (i < w1a.length - 1) {
      assert.ok(ms >= 80, `delay ${ms}ms must stay within ±20% of the poll interval`);
    }
  }
  // And the whole wait respected its budget.
  assert.ok(
    w1a.reduce((sum, ms) => sum + ms, 0) <= 1000,
    "the total wait must stay inside BOX_CONFLICT_WAIT_MAX_MS",
  );
});


/* ════════════════ regression guards for the adversarial review ════════════════
 *
 * Each of these reproduces a bug that was found by adversarially reviewing this change
 * and that the rest of the suite did not catch. They fail against the pre-fix code.
 */

test("MPC17: a heartbeat SUCCEEDS when the tiers' fence counters are out of step", async () => {
  // The in-process fence is a per-process counter; the durable fence is a persisted
  // per-deployment `$inc`. They only agree on a pristine process, which is why the rest of
  // the suite missed this. Pre-advancing the durable counter — what a second worker or any
  // restart does — used to make EVERY renewal report ownership lost, raise
  // `invariantViolation`, and flip the ownership guard, aborting legs mid-execution.
  const db = new InMemoryReservationDatabase();
  db.fences.set("test", 5000);
  const gateway = controllableGateway();
  const invariants = [];
  gateway.invariantViolation = (reason) => invariants.push(reason);
  const made = await readyCoordinator({ gateway, durable: true, db });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(gateway.started.length, 1);

  for (let i = 0; i < 5; i++) {
    made.clock.value += 1500;
    await made.coordinator.renewTick();
  }

  const m = made.coordinator.metrics();
  assert.equal(m.reservationRenewSuccess, 5, "every renewal must succeed");
  assert.equal(m.reservationOwnershipLost, 0, "ownership was never in doubt");
  assert.deepEqual(invariants, [], "and no invariant violation was raised");

  gateway.finish(0);
  await p;
  assert.equal(db.docs.size, 0, "released cleanly, so the fence dispatch works on release too");
});

test("MPC18: a durable outage does NOT abort the remaining legs of an in-flight EXIT", async () => {
  // Exit safety and entry safety are different problems. If a lost or unverifiable lease
  // aborted an exit's remaining legs, a half-closed box would be left with naked legs —
  // the exact inversion of the protection this class exists for.
  const gateway = controllableGateway({ mode: "live" });
  const made = await readyCoordinator({ gateway, durable: true });
  const position = { ...boxFor({ k1: 2500, k2: 2550 }), id: "p1" };

  let handed = "unset";
  gateway.simulateLeggingExit = async (args) => {
    handed = args.stillWanted;
    return { ok: true, record: { residual_exposure: [] } };
  };

  // Kill the authority mid-exit and force the heartbeat to notice.
  const p = made.coordinator.simulateLeggingExit({ position, detectionLegs: [], detectedAt: NOW });
  made.database.failure = new Error("connection reset");
  await made.coordinator.renewTick();
  const r = await p;

  assert.equal(r.ok, true, "the exit completed");
  assert.equal(
    handed,
    undefined,
    "the coordinator must NOT inject an ownership predicate into an exit — closing exposure is never gated",
  );
});

test("MPC19: a local_only lease is renewed against the LOCAL tier, and survives the outage", async () => {
  // The whole point of the local_only fallback is to keep working while the authority is
  // down. Renewing it against the chain asks that same down authority to confirm a lease it
  // never issued, so ownership was declared lost on the first heartbeat and the documented
  // degraded mode lasted exactly one interval.
  const gateway = controllableGateway({ mode: "paper_legging" });
  const invariants = [];
  gateway.invariantViolation = (reason) => invariants.push(reason);
  const made = await readyCoordinator({ gateway, durable: true });
  made.database.failure = new Error("primary stepped down");

  const a = boxFor({ k1: 2500, k2: 2550 });
  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(gateway.started.length, 1);
  assert.equal(made.coordinator.metrics().localOnlyFallbacks, 1);

  // Several heartbeats with the authority still down.
  for (let i = 0; i < 3; i++) {
    made.clock.value += 1500;
    await made.coordinator.renewTick();
  }

  const m = made.coordinator.metrics();
  assert.equal(m.reservationRenewSuccess, 3, "the local tier renews it happily");
  assert.equal(m.reservationOwnershipLost, 0, "a lease the authority never issued cannot be 'lost' by it");
  assert.deepEqual(invariants, [], "and no invariant violation was raised");

  gateway.finish(0);
  await p;
});

test("MPC20: an uncertain hold survives a TRANSIENT authority blip", async () => {
  // Dropping the hold on any renewal failure would cut protection from
  // `reservationUncertainHoldMaxMs` down to one lock TTL, at exactly the moment broker
  // state is ambiguous and a second box must not assume there is no exposure.
  const gateway = controllableGateway();
  const made = await readyCoordinator({ gateway, durable: true, config: { reservationUncertainHoldMaxMs: 60_000 } });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  gateway.finish(0, { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [{ role: "k1_ce" }] } });
  await p;
  assert.equal(made.coordinator.metrics().uncertainHoldsActive, 1);

  // A blip: ownership becomes UNKNOWN, not lost.
  made.database.failure = new Error("election in progress");
  made.clock.value += 1500;
  await made.coordinator.renewTick();
  assert.equal(made.coordinator.metrics().uncertainHoldsActive, 1, "the hold is retained through the blip");
  assert.equal(made.database.docs.size, 1, "and the reservation was NOT deleted");

  // Recovered: renewal resumes.
  made.database.failure = null;
  made.clock.value += 1500;
  await made.coordinator.renewTick();
  assert.equal(made.coordinator.metrics().uncertainHoldsActive, 1);
  assert.ok(made.coordinator.metrics().reservationRenewSuccess >= 1);
});

test("MPC21: the ownership horizon covers a broker round trip, not just clock error", async () => {
  // The clock-skew grace is sized for measurement error between this process and the
  // authority. It says nothing about how long an order takes. A leg permitted 300ms before
  // expiry can still be working seconds later, when another worker legitimately owns the
  // contract — and no broker accepts a fencing token that could reject it.
  const gateway = controllableGateway();
  const made = await readyCoordinator({
    gateway,
    durable: true,
    config: { instrumentLockTtlMs: 5000, reservationClockSkewGraceMs: 250, reservationOwnershipMarginMs: 1500 },
  });
  const a = boxFor({ k1: 2500, k2: 2550 });

  let handed = null;
  const inner = gateway.simulateLeggingEntry.bind(gateway);
  gateway.simulateLeggingEntry = (args) => {
    handed = args.stillWanted;
    return inner(args);
  };
  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(handed(), true, "plenty of lease remaining");

  // 3400ms in: 1600ms of lease left, which is more than the 1500ms margin.
  made.clock.value += 3400;
  assert.equal(handed(), true, "still enough lease for an order to complete");

  // 3600ms in: only 1400ms left — less than a worst-case submit. No further legs.
  made.clock.value += 200;
  assert.equal(
    handed(),
    false,
    "a leg must not be opened when the lease could expire before the order is acknowledged",
  );

  gateway.finish(0, { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [] } });
  await p;
});

test("MPC22: an execution the coordinator no longer tracks fails CLOSED", async () => {
  // `resetForBrokerSwitch` clears the table while legs may be in flight. Returning "still
  // wanted" for an untracked execution would let a leg be opened against a contract in the
  // OUTGOING broker's namespace.
  const gateway = controllableGateway();
  const made = await readyCoordinator({ gateway, durable: true });
  const a = boxFor({ k1: 2500, k2: 2550 });

  let handed = null;
  const inner = gateway.simulateLeggingEntry.bind(gateway);
  gateway.simulateLeggingEntry = (args) => {
    handed = args.stillWanted;
    return inner(args);
  };
  const p = made.coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await flush();
  assert.equal(handed(), true);

  await made.coordinator.resetForBrokerSwitch();
  assert.equal(handed(), false, "a broker switch must stop further legs, not permit them");

  gateway.finish(0, { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [] } });
  await p;
});


/* ═══════════════ the quantity envelope, refused before it costs an attempt ═══════════════ */

/**
 * WHY THIS GATE EXISTS, and why "before the consume" is the entire point.
 *
 * The per-leg and gross quantity caps are enforced by BoxOrderManager, three layers below the
 * coordinator and — critically — AFTER `sessionConsumeAttempt()`. So an instrument whose LOT SIZE
 * simply exceeds the configured envelope used to:
 *
 *   1. spend a session entry attempt (on a one-attempt supervised live test, that ends the test
 *      before a single byte reaches the broker);
 *   2. take the underlying hold and the contract reservations, then hand them back;
 *   3. run the ECONOMIC admission, which performs real broker round-trips for funds and margin
 *      evidence, for an entry that could never be sent;
 *   4. and worst: `submit()` refuses with a plain `Error`, which the entry path's `provenNoExposure`
 *      test does not recognise (only `BrokerPreSubmitRefusedError`/`BrokerOrderRejectedError` count).
 *      All four legs rejecting therefore made `uncertain` true → `manager.invariantViolation(...)` →
 *      `recoveryActive = true` AND a trip of the STICKY circuit breaker. A statically-knowable
 *      configuration mismatch reported "broker terminal quantity is uncertain" and closed the entry
 *      path, having posted nothing anywhere.
 *
 * Everything needed is known synchronously from the candidate and config, so it belongs beside the
 * blocklist in the no-await prologue.
 */

function oversized(candidate, lotSize) {
  // Only the lot changes; everything else must stay a genuinely qualifying candidate so the test
  // cannot pass for an unrelated reason.
  return { ...candidate, lot_size: lotSize };
}

test("T-CAP: a lot above the per-leg cap is refused WITHOUT consuming a session attempt (live)", async () => {
  const gateway = controllableGateway({ mode: "live" });
  let consumed = 0;
  const { coordinator } = makeCoordinator({
    gateway,
    config: { liveMaxOpenLegQuantity: 100, liveMaxGrossOpenLegQuantity: 4000 },
    sessionConsumeAttempt: async () => {
      consumed++;
      return { ok: true, detail: null };
    },
  });
  const a = oversized(boxFor({ k1: 2500, k2: 2550 }), 725);
  const r = await coordinator.simulateLeggingEntry({
    candidate: a,
    detection: detectionFor(a),
    stillWanted: () => true,
    qualify: () => ({ ok: true }),
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "lot_exceeds_quantity_cap", "NOT insufficient_quantity — depth is irrelevant here");
  assert.equal(consumed, 0, "THE POINT: a statically-knowable refusal must not spend the attempt budget");
  assert.equal(gateway.started.length, 0, "and nothing reached the executor, so no broker round trip");
  // The message must name the number to change, and the lot that broke it.
  assert.match(r.detail, /725/);
  assert.match(r.detail, /BOX_LIVE_MAX_OPEN_LEG_QUANTITY=100/);
  assert.equal(coordinator.metrics().quantityCapRefusals, 1);
});

test("T-CAP-b: four legs above the GROSS cap are refused the same way", async () => {
  const gateway = controllableGateway({ mode: "live" });
  let consumed = 0;
  const { coordinator } = makeCoordinator({
    gateway,
    // Per-leg allows 150; four legs of 150 = 600, above the 400 gross cap.
    config: { liveMaxOpenLegQuantity: 150, liveMaxGrossOpenLegQuantity: 400 },
    sessionConsumeAttempt: async () => {
      consumed++;
      return { ok: true, detail: null };
    },
  });
  const a = oversized(boxFor({ k1: 2500, k2: 2550 }), 150);
  const r = await coordinator.simulateLeggingEntry({
    candidate: a,
    detection: detectionFor(a),
    stillWanted: () => true,
    qualify: () => ({ ok: true }),
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "lot_exceeds_quantity_cap");
  assert.equal(consumed, 0);
  assert.match(r.detail, /600 unit\(s\)/, "the four-leg total, not the lot");
  assert.match(r.detail, /BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=400/);
});

test("T-CAP-c: a lot WITHIN the envelope is unaffected — the gate is not a blanket refusal", async () => {
  const gateway = controllableGateway({ mode: "live" });
  let consumed = 0;
  const { coordinator } = makeCoordinator({
    gateway,
    config: { liveMaxOpenLegQuantity: 100, liveMaxGrossOpenLegQuantity: 400 },
    sessionConsumeAttempt: async () => {
      consumed++;
      return { ok: true, detail: null };
    },
  });
  // 75 is NIFTY's lot: 75 <= 100 per leg, and 4 x 75 = 300 <= 400 gross. Both bounds are exercised.
  const a = oversized(boxFor({ k1: 2500, k2: 2550 }), 75);
  const p = coordinator.simulateLeggingEntry({
    candidate: a,
    detection: detectionFor(a),
    stillWanted: () => true,
    qualify: () => ({ ok: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 1, "an admissible lot must still reach the executor");
  assert.equal(consumed, 1, "and it legitimately spends an attempt, because it really is an attempt");
  assert.equal(coordinator.metrics().quantityCapRefusals, 0);
  gateway.finish(0);
  await p;
});

test("T-CAP-d: PAPER is untouched — these are BOX_LIVE_* caps the order manager owns", async () => {
  // Paper never constructs BoxOrderManager, so the caps are not enforced there. Applying them in
  // paper would change which names a rehearsal covers, and the universe board already reports
  // lot_exceeds_per_leg_cap in every mode for pre-live screening.
  const gateway = controllableGateway({ mode: "paper_legging" });
  const { coordinator } = makeCoordinator({
    gateway,
    config: { liveMaxOpenLegQuantity: 100, liveMaxGrossOpenLegQuantity: 400 },
  });
  const a = oversized(boxFor({ k1: 2500, k2: 2550 }), 725);
  const p = coordinator.simulateLeggingEntry({
    candidate: a,
    detection: detectionFor(a),
    stillWanted: () => true,
    qualify: () => ({ ok: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 1, "paper must still simulate a large-lot name");
  assert.equal(coordinator.metrics().quantityCapRefusals, 0);
  gateway.finish(0);
  await p;
});

test("T-CAP-e: a cap of 0 disables the gate rather than refusing everything", async () => {
  // 0 means "no cap" for both settings (strictLimitInt with min 1 makes 0 unreachable from env, but
  // the guard must not invert if a caller ever passes it).
  const gateway = controllableGateway({ mode: "live" });
  const { coordinator } = makeCoordinator({
    gateway,
    config: { liveMaxOpenLegQuantity: 0, liveMaxGrossOpenLegQuantity: 0 },
  });
  const a = oversized(boxFor({ k1: 2500, k2: 2550 }), 100000);
  const p = coordinator.simulateLeggingEntry({
    candidate: a,
    detection: detectionFor(a),
    stillWanted: () => true,
    qualify: () => ({ ok: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 1, "0 must mean unbounded, not impossible-to-satisfy");
  gateway.finish(0);
  await p;
});
