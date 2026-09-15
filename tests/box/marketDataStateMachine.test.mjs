/**
 * MARKET-DATA STATE MACHINE — the driven health machine for the market-data transport.
 *
 * GAP 1 of the live-execution integration: MarketDataState was DEFINED in streamHealthPolicy.ts
 * but NOTHING transitioned it, so "socket open" could still read as ready via the crude
 * feed-liveness boolean. This suite pins the behaviours the brief requires of the DRIVEN machine
 * (as opposed to the pure permission table, which streamHealthPolicy already covers):
 *
 *   - READY is UNREACHABLE by mere socket-open: connecting → authenticating → synchronizing, and
 *     only reaches READY once EVERY traded instrument has fresh usable depth in the CURRENT
 *     generation;
 *   - a socket open but supplying no usable data is NOT READY (stays SYNCHRONIZING);
 *   - partial subscription recovery keeps the machine SYNCHRONIZING until the LAST traded
 *     instrument confirms;
 *   - a reconnect advances the generation and drops confirmed readiness: books observed under the
 *     previous generation do not make an instrument executable again;
 *   - a heartbeat gap / stale book / processing backlog degrades a READY machine to DEGRADED
 *     (exposure management continues, new entry stops) and recovers on fresh depth;
 *   - socket loss → DISCONNECTED; token rejection → AUTH_EXPIRED (no recovery from any DATA event;
 *     cleared ONLY by an explicit credential replacement via onSessionRestored);
 *   - ages are computed in the machine's own MONOTONIC domain and published finished, with wall
 *     stamps alongside for audit — so no caller can subtract a wall `now` from a monotonic stamp;
 *   - the four time facts (transport heartbeat, last received frame, last valid depth, per-leg
 *     book age) are kept DISTINCT — the machine never reads a heartbeat as a depth update;
 *   - DESIRED subscriptions are kept separate from CONFIRMED/OBSERVED readiness.
 *
 * Fully deterministic and PURE: no sockets, no timers, no clock of its own. The caller feeds it
 * events and reads state(); a fixed clock is injected where a time comparison is needed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MarketDataStateMachine,
  marketDataPermissions,
} from "../../dist/box/streamHealthPolicy.js";

/** A machine armed for a single traded instrument set, with an injected clock. */
function makeMachine(instruments = [1, 2, 3, 4], opts = {}) {
  let now = opts.start ?? 1_000;
  const clock = { mono: () => now };
  // Two INDEPENDENT clocks, deliberately far apart. `now` is a small monotonic counter and
  // `nowWall` is a realistic epoch value, so any code that mixed the two domains would produce an
  // age in the trillions and every age assertion in this file would fail loudly. That separation is
  // the regression guard for the wall-minus-monotonic defect.
  let wall = opts.startWall ?? 1_760_000_000_000;
  const machine = new MarketDataStateMachine({
    enabled: true,
    now: () => now,
    nowWall: () => wall,
    heartbeatMaxAgeMs: opts.heartbeatMaxAgeMs ?? 5_000,
    bookMaxAgeMs: opts.bookMaxAgeMs ?? 10_000,
  });
  machine.setDesiredInstruments(instruments);
  return {
    machine,
    advance: (ms) => {
      now += ms;
      wall += ms;
    },
    at: () => now,
    atWall: () => wall,
    clock,
  };
}

test("READY is unreachable by socket-open alone; needs auth AND depth actually flowing", () => {
  // CHANGED DELIBERATELY. The final step used to require depth for EVERY desired instrument, which
  // in production meant the whole streamed universe and therefore an outage from one dead strike
  // (see the header of tests/box/candidateMarketData.test.mjs). The properties this test exists to
  // protect — a socket that has merely opened is never READY, and authentication alone is never
  // READY — are unchanged and still asserted. Per-instrument admissibility is asserted per candidate
  // in candidateMarketData.test.mjs, where it applies to the instruments that actually matter.
  const { machine } = makeMachine([10, 20]);
  assert.equal(machine.state(), "DISCONNECTED");

  machine.onConnecting();
  assert.equal(machine.state(), "CONNECTING");

  machine.onSocketOpen();
  assert.equal(machine.state(), "AUTHENTICATING", "socket open is a route only, never READY");

  machine.onAuthenticated();
  assert.equal(machine.state(), "SYNCHRONIZING", "authenticated still owes real depth");

  machine.onSubscriptionsConfirmed([10, 20]);
  assert.equal(machine.state(), "SYNCHRONIZING", "subs confirmed but no usable depth yet ⇒ not READY");
  assert.equal(machine.permissions().newEntry, false);

  // First usable depth proves the pipeline is genuinely delivering end to end.
  machine.onUsableDepth(10);
  assert.equal(machine.state(), "READY", "the TRANSPORT is delivering depth");
  assert.equal(machine.permissions().newEntry, true);
  // But instrument 20 is still individually inadmissible, and coverage says so. A candidate whose
  // leg is instrument 20 is refused by the candidate-scoped gate, not by the transport state.
  assert.equal(machine.isInstrumentReady(20), false);
  assert.equal(machine.coverage().missing, 1);

  machine.onUsableDepth(20);
  assert.equal(machine.state(), "READY");
  assert.equal(machine.coverage().missing, 0);
});

test("a socket that opens but supplies no usable data is never READY", () => {
  const { machine, advance } = makeMachine([7]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([7]);
  // Heartbeats keep arriving but NO depth ever does.
  machine.onHeartbeat();
  advance(1_000);
  machine.onHeartbeat();
  assert.equal(machine.state(), "SYNCHRONIZING", "heartbeats are not depth; must not reach READY");
  assert.equal(marketDataPermissions(machine.state()).newEntry, false);
});

test("partial subscription recovery is READY as a TRANSPORT but reports the missing coverage", () => {
  // CHANGED DELIBERATELY, and the change is a fix rather than a relaxation.
  //
  // This used to assert SYNCHRONIZING while 2 of 3 instruments were restored, encoding the rule that
  // EVERY desired instrument must be fresh before READY. In production the desired set is the whole
  // streamed option universe (engine.subscribedOptionTokens), so that rule meant one illiquid strike
  // in an unrelated underlying held the machine below READY — and READY is the only market-data state
  // that licenses new entry, so EVERY box was refused with `feed_unhealthy`, including boxes whose own
  // four books were fresh and executable.
  //
  // READY is a TRANSPORT verdict: authenticated, live, un-backlogged, and demonstrably delivering
  // depth. The per-instrument requirement did not disappear — it moved to where it can be asked about
  // the right instruments, in candidateMarketData.ts, which requires ALL FOUR of a candidate's legs to
  // be subscribed and fresh in the current generation (see tests/box/candidateMarketData.test.mjs).
  // Coverage over the whole desired set remains reported, as observability rather than a hidden gate.
  const { machine } = makeMachine([1, 2, 3]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([1, 2]); // only 2 of 3 restored
  machine.onUsableDepth(1);
  machine.onUsableDepth(2);

  assert.equal(machine.state(), "READY", "the transport is genuinely delivering depth");
  const cov = machine.coverage();
  assert.equal(cov.desired, 3);
  assert.equal(cov.fresh, 2);
  assert.equal(cov.missing, 1, "and the missing instrument is reported, not hidden");
  assert.deepEqual(cov.missingSample, [3]);
  // The instrument that never confirmed is still individually NOT ready, which is what a
  // candidate-scoped gate consults.
  assert.equal(machine.isInstrumentReady(3), false, "instrument 3 is not admissible for a candidate");
  assert.equal(machine.isInstrumentReady(1), true);

  // Now 3 comes in: full coverage.
  machine.onSubscriptionsConfirmed([3]);
  machine.onUsableDepth(3);
  assert.equal(machine.state(), "READY");
  assert.equal(machine.coverage().missing, 0);
  assert.equal(machine.isInstrumentReady(3), true);
});

test("reconnect advances the generation and drops prior-generation readiness", () => {
  const { machine } = makeMachine([100, 200]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([100, 200]);
  machine.onUsableDepth(100);
  machine.onUsableDepth(200);
  assert.equal(machine.state(), "READY");
  const gen1 = machine.generation();

  // Socket drops, then reconnects.
  machine.onDisconnected();
  assert.equal(machine.state(), "DISCONNECTED");
  assert.equal(machine.permissions().newEntry, false);
  assert.equal(machine.permissions().protectiveCancel, true, "cancel still allowed while disconnected");

  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  const gen2 = machine.generation();
  assert.ok(gen2 > gen1, "a reconnect must advance the generation");

  // Depth observed under the OLD generation must not count. This is the load-bearing property and it
  // is asserted PER INSTRUMENT, which is where it belongs: immediately after the reconnect, before
  // anything re-ticks, NEITHER instrument is admissible even though both were fresh a moment ago.
  machine.onSubscriptionsConfirmed([100, 200]);
  assert.equal(machine.isInstrumentReady(100), false, "prior-generation depth is not evidence");
  assert.equal(machine.isInstrumentReady(200), false, "prior-generation depth is not evidence");
  assert.equal(machine.coverage().missing, 2, "the whole set is un-evidenced after a reconnect");
  assert.equal(machine.state(), "SYNCHRONIZING", "and the transport has not yet proven it delivers");

  machine.onUsableDepth(100);
  assert.equal(machine.state(), "READY", "the transport is delivering again");
  assert.equal(machine.isInstrumentReady(100), true, "but only THIS instrument is re-evidenced");
  assert.equal(machine.isInstrumentReady(200), false, "instrument 200 is not fresh THIS generation");

  machine.onUsableDepth(200);
  assert.equal(machine.state(), "READY");
  assert.equal(machine.coverage().missing, 0);
});

test("heartbeat gap degrades a READY machine; fresh data recovers it", () => {
  const { machine, advance } = makeMachine([5], { heartbeatMaxAgeMs: 3_000, bookMaxAgeMs: 10_000 });
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([5]);
  machine.onHeartbeat();
  machine.onUsableDepth(5);
  assert.equal(machine.state(), "READY");

  // No heartbeat and no frame for longer than the heartbeat bound.
  advance(4_000);
  machine.evaluate();
  assert.equal(machine.state(), "DEGRADED", "heartbeat gap ⇒ DEGRADED");
  assert.equal(machine.permissions().newEntry, false);
  assert.equal(machine.permissions().exitAndReduce, true, "exposure management continues in DEGRADED");

  // A fresh frame + depth recovers.
  machine.onHeartbeat();
  machine.onUsableDepth(5);
  machine.evaluate();
  assert.equal(machine.state(), "READY");
});

test("a stale book (older than bookMaxAge) degrades even while heartbeats flow", () => {
  const { machine, advance } = makeMachine([9], { heartbeatMaxAgeMs: 30_000, bookMaxAgeMs: 5_000 });
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([9]);
  machine.onHeartbeat();
  machine.onUsableDepth(9);
  assert.equal(machine.state(), "READY");

  advance(6_000); // book now older than 5s, but heartbeats still fine
  machine.onHeartbeat();
  machine.evaluate();
  assert.equal(machine.state(), "DEGRADED", "book aged past bookMaxAge ⇒ DEGRADED even with heartbeats");
});

test("processing backlog degrades a READY machine and clears when it drains", () => {
  const { machine } = makeMachine([1]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([1]);
  machine.onHeartbeat();
  machine.onUsableDepth(1);
  assert.equal(machine.state(), "READY");

  machine.onProcessingBacklog(true);
  machine.evaluate();
  assert.equal(machine.state(), "DEGRADED", "an ingestion backlog blocks new entry");
  assert.equal(machine.permissions().newEntry, false);

  machine.onProcessingBacklog(false);
  machine.onHeartbeat();
  machine.onUsableDepth(1);
  machine.evaluate();
  assert.equal(machine.state(), "READY");
});

test("auth expiry is terminal: no auto-recovery, cancel forbidden by table", () => {
  const { machine } = makeMachine([1]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onSessionLost();
  assert.equal(machine.state(), "AUTH_EXPIRED");
  const perms = machine.permissions();
  assert.equal(perms.newEntry, false);
  assert.equal(perms.manageWorkingOrders, false);
  assert.equal(perms.exitAndReduce, false);
  // A stray depth event must NOT resurrect an expired session.
  machine.onUsableDepth(1);
  machine.onHeartbeat();
  machine.evaluate();
  assert.equal(machine.state(), "AUTH_EXPIRED", "an expired session cannot be revived by data");
});

test("the four time facts are distinct: a heartbeat is not a depth update", () => {
  const { machine, advance } = makeMachine([1], { heartbeatMaxAgeMs: 10_000, bookMaxAgeMs: 2_000 });
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([1]);
  machine.onHeartbeat();
  machine.onUsableDepth(1);
  assert.equal(machine.state(), "READY");

  // Only heartbeats keep arriving; the book goes stale. A machine that conflated the two facts
  // would stay READY. The correct one degrades.
  advance(3_000);
  machine.onHeartbeat();
  machine.evaluate();
  assert.equal(machine.state(), "DEGRADED", "a heartbeat must not stand in for a depth update");

  // The machine now publishes finished AGES (computed in its own monotonic domain) plus wall
  // stamps for audit, instead of raw monotonic timestamps a caller could subtract a wall `now`
  // from. Assert the ages directly: it is a stronger check than "is a number", because it pins
  // the RELATIONSHIP the four-time-facts rule is about.
  const diag = machine.diagnostics();
  assert.equal(typeof diag.heartbeatAgeMs, "number");
  assert.equal(typeof diag.frameAgeMs, "number");
  assert.equal(typeof diag.depthAgeMs, "number");
  assert.equal(diag.heartbeatAgeMs, 0, "the heartbeat just arrived");
  assert.equal(diag.frameAgeMs, 0, "a heartbeat IS an inbound frame");
  assert.equal(
    diag.depthAgeMs,
    3_000,
    "the DEPTH clock did not move: heartbeats must never refresh a book's freshness",
  );
  assert.ok(
    diag.depthAgeMs > diag.heartbeatAgeMs,
    "the book is older than the transport — which is exactly why the state is DEGRADED",
  );
  // Wall stamps travel alongside for display, and are never the basis of an age.
  assert.equal(typeof diag.lastHeartbeatWallAt, "number");
  assert.equal(typeof diag.lastDepthWallAt, "number");
  // Evidence counters separate "connected" from "delivering".
  assert.equal(diag.depthObservations, 1, "exactly one usable book was ever observed");
  assert.equal(diag.heartbeats, 2);
});

test("a heartbeat can never CREATE readiness: an open, heart-beating socket with no depth is not READY", () => {
  // The converse of the test above, and the case the dashboard was getting wrong: a socket that is
  // open and alive but has delivered no book at all must not be reported as executable.
  const { machine } = makeMachine([1, 2], { heartbeatMaxAgeMs: 10_000, bookMaxAgeMs: 2_000 });
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([1, 2]);

  for (let i = 0; i < 50; i++) machine.onHeartbeat();

  assert.equal(
    machine.state(),
    "SYNCHRONIZING",
    "fifty heartbeats prove the transport is alive and prove nothing about any book",
  );
  assert.equal(machine.permissions().newEntry, false, "and they must not license new entry");
  const diag = machine.diagnostics();
  assert.equal(diag.depthAgeMs, null, "never observed stays NULL — never a fresh-looking 0");
  assert.equal(diag.lastDepthWallAt, null);
  assert.equal(diag.depthObservations, 0);
  assert.equal(diag.transportLive, true, "the transport genuinely IS live");
  assert.equal(diag.readyInstruments, 0);
});

test("a REPLACEMENT credential is the only thing that clears AUTH_EXPIRED", () => {
  // Before this, AUTH_EXPIRED survived a successful re-login for the life of the process: every
  // path back out of it early-returned on AUTH_EXPIRED, so the feed recovered but the machine that
  // gates entry did not — and that blocker's scope is `both`, so it also reported exposure
  // management as blocked.
  const { machine } = makeMachine([1]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onUsableDepth(1);
  assert.equal(machine.state(), "READY");
  const generationWhenLive = machine.generation();

  machine.onSessionLost();
  assert.equal(machine.state(), "AUTH_EXPIRED");

  // No DATA event may revive it — a tick on a socket the broker already rejected proves nothing.
  machine.onFrame();
  machine.onHeartbeat();
  machine.onUsableDepth(1);
  machine.onSocketOpen();
  machine.onAuthenticated();
  assert.equal(machine.state(), "AUTH_EXPIRED", "data cannot vouch for a rejected credential");
  assert.equal(machine.generation(), generationWhenLive, "and cannot advance the generation");

  // A replacement credential can, because it comes from the AUTH path.
  machine.onSessionRestored();
  assert.equal(machine.state(), "DISCONNECTED", "restored, but NOT optimistically ready");
  assert.equal(machine.permissions().newEntry, false);
  const diag = machine.diagnostics();
  assert.equal(diag.depthAgeMs, null, "books from the dead session are not evidence for the new one");
  assert.equal(diag.frameAgeMs, null);

  // And it still has to earn READY the normal way.
  machine.onSocketOpen();
  machine.onAuthenticated();
  assert.equal(machine.state(), "SYNCHRONIZING");
  assert.ok(machine.generation() > generationWhenLive, "the new session is a new generation");
  machine.onUsableDepth(1);
  assert.equal(machine.state(), "READY");
});

test("DISABLED permits nothing and ignores lifecycle events", () => {
  const machine = new MarketDataStateMachine({ enabled: false });
  assert.equal(machine.state(), "DISABLED");
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  assert.equal(machine.state(), "DISABLED", "a disabled machine never leaves DISABLED via events");
  const perms = machine.permissions();
  assert.equal(perms.newEntry, false);
  assert.equal(perms.protectiveCancel, false);
});

test("desired instruments are separate from observed readiness, and narrowing the set narrows COVERAGE", () => {
  // Also changed deliberately: the state no longer swings on whether ONE unobserved instrument is in
  // the desired set, because a universe-wide universal quantifier is the defect. What narrowing the
  // set changes is COVERAGE and per-instrument readiness, which is what callers actually need.
  const { machine } = makeMachine([1, 2, 3]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([1, 2, 3]);
  machine.onUsableDepth(1);
  machine.onUsableDepth(2);
  assert.equal(machine.state(), "READY", "the transport is delivering; instrument 3 is a coverage gap");
  assert.equal(machine.coverage().missing, 1);
  assert.deepEqual(machine.readyInstruments().sort(), [1, 2]);
  assert.equal(machine.isSubscribed(3), true);

  // Instrument 3 is dropped from the DESIRED set (no longer traded). Coverage completes on the
  // remaining two without inventing depth for 3.
  machine.setDesiredInstruments([1, 2]);
  machine.evaluate();
  assert.equal(machine.state(), "READY");
  assert.equal(machine.coverage().missing, 0, "coverage is complete over the NARROWED set");
  assert.equal(machine.isSubscribed(3), false, "and 3 is no longer part of the subscription intent");
  assert.deepEqual(machine.readyInstruments().sort(), [1, 2]);
});
