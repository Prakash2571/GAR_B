/**
 * SECTION 7 — ONE AUTHORITATIVE READINESS DECISION (and the disagreement it replaces).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT (a): THE ORDER-STREAM CONSUMER PUBLISHED TWO CONTRADICTORY TRUTHS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `OrderStreamConsumer` held TWO independent state holders:
 *
 *   this.machine  (OrderStreamStateMachine)  → lifecycleState(), which GOVERNS new entry
 *   this.proj     (OrderUpdateProjection)    → health(), which is PUBLISHED to the operator
 *
 * `onIdle()` / `evaluateIdle()` demoted the MACHINE to DEGRADED (correctly: connected but not
 * delivering while a fill is expected) and never told the PROJECTION, which stayed `LIVE` —
 * because `OrderStreamState` had no way to represent "connected but not delivering" at all.
 *
 * The consequence was not cosmetic. `engine.getStatus()` publishes `order_stream` from
 * `consumer.health()` (via refreshOrderStreamConsumerHealth), and `orderStreamStatus()` scores
 * `fills_observed_by` from `health.state === "LIVE"`. So the operator was told fills were being
 * observed on the FAST PATH (`stream_primary_rest_reconcile`, `any_stream_live: true`) at the very
 * moment the engine was refusing new entry because that same stream was DEGRADED. A dashboard
 * cannot be trusted to explain a refusal it is simultaneously contradicting.
 *
 * These tests assert the disagreement is now STRUCTURALLY IMPOSSIBLE: one lifecycle authority,
 * one published state derived from it, and a fill-observation mechanism scored off that same
 * single authority.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE UNIFIED DECISION
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `buildOperationalReadiness` is the ONE place a readiness answer is computed, from the SAME
 * `streamHealthPolicy` permission tables the live-entry checkpoint consults. It carries both
 * transport lifecycles, masked identity, generations, reconciliation blockers, entry permission,
 * exposure-management permission WITH its real limitations, the fill-observation mechanism,
 * evidence freshness, and its own generation/version/timestamp so a stale answer is detectable.
 *
 * The load-bearing invariant asserted here: ENTRY restrictions must NEVER independently block a
 * REDUCTION of already-owned exposure.
 *
 * Deterministic: injected clock, no sockets, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { OrderStreamConsumer } from "../../dist/box/orderStreamConsumer.js";
import { orderStreamStatus } from "../../dist/box/orderStreamStatus.js";
import {
  entryPermittedFromStreams,
  combinedPermissions,
} from "../../dist/box/streamHealthPolicy.js";
import {
  buildOperationalReadiness,
  maskAccountId,
  OPERATIONAL_READINESS_VERSION,
} from "../../dist/box/operationalReadiness.js";

/* ─────────────────────────── deterministic harness ─────────────────────────── */

function makeClock() {
  let t = 1_700_000_000_000;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

function makeConsumer(clock, { streamEnabled = true, expectedIdleMs = 5000 } = {}) {
  return new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter: null,
    streamEnabled,
    expectedIdleMs,
    now: () => clock.now(),
  });
}

function bringToReady(consumer) {
  consumer.onConnecting();
  consumer.onSocketOpen();
  consumer.onAuthenticated();
  consumer.markSynchronized();
}

/** Drive a consumer to the exact production situation: READY, then idle with a working order. */
function driveToIdleDegraded(clock) {
  const consumer = makeConsumer(clock, { expectedIdleMs: 5000 });
  bringToReady(consumer);
  consumer.registerIntent({
    clientOrderId: "BOX:T1:ENTRY:k1_ce:a1",
    ownerTag: "TAG1",
    account: "AB1234",
    requestedQty: 75,
  });
  clock.advance(6000);
  // This is EXACTLY what engine.orderStreamState() does on every status read.
  consumer.evaluateIdle(clock.now());
  return consumer;
}

/* ═══════════════ 1. DEFECT (a): DEGRADED lifecycle vs LIVE published health ═══════════════ */

test("defect (a): an idle-DEGRADED order stream must NOT publish health state LIVE", () => {
  const clock = makeClock();
  const consumer = driveToIdleDegraded(clock);

  assert.equal(consumer.lifecycleState(), "DEGRADED", "the lifecycle authority says DEGRADED");
  // PRE-FIX this was "LIVE": the projection had no idle state and was never told.
  assert.notEqual(
    consumer.health().state,
    "LIVE",
    "published health must not claim LIVE while the lifecycle that governs entry says DEGRADED",
  );
  assert.equal(consumer.health().state, "DEGRADED", "the published state is the lifecycle truth");
});

test("defect (a): the published health state is DERIVED from the single lifecycle authority", () => {
  // Every lifecycle state must map to a published state, and the two can never disagree about
  // whether the stream is trustworthy. Walked over the real transitions, not a table lookup.
  const clock = makeClock();

  const disabled = makeConsumer(clock, { streamEnabled: false });
  assert.equal(disabled.lifecycleState(), "DISABLED");
  assert.equal(disabled.health().state, "DISABLED");

  const c = makeConsumer(clock);
  assert.equal(c.lifecycleState(), "DISCONNECTED");
  assert.equal(c.health().state, "DOWN", "an enabled stream that never connected is DOWN");

  c.onConnecting();
  assert.equal(c.lifecycleState(), "CONNECTING");
  assert.equal(c.health().state, "CONNECTING");

  c.onSocketOpen();
  assert.equal(c.lifecycleState(), "AUTHENTICATING");
  assert.equal(c.health().state, "CONNECTING", "socket open is NOT live — authorisation is still owed");

  c.onAuthenticated();
  assert.equal(c.lifecycleState(), "RECONCILING");
  assert.equal(c.health().state, "RECONNECTED_PENDING_RECONCILE", "a gap repair is owed before trust");
  assert.equal(c.health().reconcilePending, true);

  c.markSynchronized();
  assert.equal(c.lifecycleState(), "READY");
  assert.equal(c.health().state, "LIVE");
  assert.equal(c.health().reconcilePending, false);

  c.onDisconnected();
  assert.equal(c.lifecycleState(), "DISCONNECTED");
  assert.equal(c.health().state, "DOWN");

  c.onSessionLost("token rejected");
  assert.equal(c.lifecycleState(), "AUTH_EXPIRED");
  assert.equal(c.health().state, "AUTH_EXPIRED", "an expired session is its OWN published state, not DOWN");
});

test("defect (a): the published health carries the authoritative lifecycle verbatim", () => {
  const clock = makeClock();
  const consumer = driveToIdleDegraded(clock);
  assert.equal(
    consumer.health().lifecycle,
    consumer.lifecycleState(),
    "health must carry the lifecycle it was derived from, so a reader can never be misled",
  );
});

/* ═══════ 2. DEFECT (a) in the PRODUCTION status path: order_stream must not claim the fast path ═══════ */

test("defect (a): a DEGRADED stream is reported as REST-observed, never as the fast fill path", () => {
  const clock = makeClock();
  const consumer = driveToIdleDegraded(clock);

  // Precisely the call engine.getStatus() makes: the consumer's health into orderStreamStatus.
  const snapshot = orderStreamStatus({
    brokers: ["zerodha", "dhan"],
    gateEnabled: (b) => b === "zerodha",
    consumers: new Map([["zerodha", consumer.health()]]),
  });
  const z = snapshot.brokers.find((b) => b.broker === "zerodha");

  assert.equal(z.wiring, "armed");
  // PRE-FIX: "stream_primary_rest_reconcile" — the operator was told fills were on the fast path
  // while the engine refused entry for exactly the opposite reason.
  assert.equal(
    z.fills_observed_by,
    "rest_polling_only",
    "a DEGRADED stream is not observing fills; REST polling is",
  );
  assert.equal(snapshot.any_stream_live, false, "no stream is live when the only armed one is DEGRADED");
});

test("defect (a): the published fill mechanism and the entry gate can never contradict", () => {
  // The invariant that was violated: if the entry gate refuses BECAUSE of the order stream, the
  // published status must not simultaneously advertise that stream as the live fill path.
  const clock = makeClock();
  const consumer = driveToIdleDegraded(clock);

  const gate = entryPermittedFromStreams({
    marketData: "READY",
    orderStream: consumer.lifecycleState(),
  });
  assert.equal(gate.permitted, false, "the order stream blocks new entry");

  const snapshot = orderStreamStatus({
    brokers: ["zerodha"],
    gateEnabled: () => true,
    consumers: new Map([["zerodha", consumer.health()]]),
  });
  assert.equal(
    snapshot.any_stream_live,
    false,
    "a stream that blocks entry must never be published as live",
  );
});

/* ═══════════════ 3. THE ONE AUTHORITATIVE DECISION ═══════════════ */

const READY_INPUT = {
  now: 1_700_000_000_000,
  generation: 7,
  decisionGeneration: 42,
  identity: {
    broker: "zerodha",
    account: "AB1234",
    executionMode: "live",
    liveRuntimeArmed: true,
    deploymentLiveCapable: true,
  },
  /*
   * AGES, NOT TIMESTAMPS. The builder used to take monotonic timestamps and subtract a WALL `now`
   * from them, which published every market-data age as ~55 years. It now takes ages already
   * computed inside the machine's own clock domain, so the mixed-domain subtraction cannot be
   * written here at all.
   */
  marketData: {
    state: "READY",
    generation: 7,
    desiredInstruments: 4,
    readyInstruments: 4,
    frameAgeMs: 200,
    heartbeatAgeMs: 200,
    depthAgeMs: 300,
    lastFrameWallAt: 1_700_000_000_000 - 200,
    lastHeartbeatWallAt: 1_700_000_000_000 - 200,
    lastDepthWallAt: 1_700_000_000_000 - 300,
    frames: 1_200,
    heartbeats: 40,
    depthObservations: 900,
    backlog: false,
    source: "broker_websocket",
    socketConnected: true,
    authenticated: true,
    subscriptionsRequested: true,
    usableBooks: 4,
  },
  orderStream: {
    lifecycle: "READY",
    publishedState: "LIVE",
    wiring: "armed",
    gateEnabled: true,
    connected: true,
    authorised: true,
    lastEventAt: 1_700_000_000_000 - 1000,
    disconnects: 0,
    reconcilePending: false,
    fillsObservedBy: "stream_primary_rest_reconcile",
  },
  paperExecution: { simulated: false, profile: null, usingStreamedQuotes: false },
  blockers: [],
  openExposure: { openPositions: 0, residualLegs: 0, workingOrders: 0 },
};

test("the readiness decision exposes every field the operator needs, and NO secret", () => {
  const d = buildOperationalReadiness(READY_INPUT);

  // Response identity: generation, version, timestamp — so a stale answer is detectable.
  assert.equal(typeof d.decision_generation, "number");
  assert.equal(d.decision_version, OPERATIONAL_READINESS_VERSION);
  assert.equal(d.decided_at, READY_INPUT.now);

  // Both ACTUAL lifecycles, not booleans.
  assert.equal(d.market_data.state, "READY");
  assert.equal(d.order_stream.lifecycle, "READY");

  // Feed/session generation.
  assert.equal(d.market_data.generation, 7);

  // Masked identity.
  assert.equal(d.identity.broker, "zerodha");
  assert.equal(d.identity.account_masked, maskAccountId("AB1234"));
  assert.equal(d.identity.account_present, true);

  // Observation mechanism, evidence freshness, reconciliation, permissions.
  assert.equal(d.fill_observation.mechanism, "stream_primary_rest_reconcile");
  assert.equal(typeof d.evidence.market_data_frame_age_ms, "number");
  assert.equal(d.reconciliation.pending, false);
  assert.equal(d.entry.permitted, true);
  assert.equal(d.exposure_management.exit_and_reduce, true);
  assert.ok(d.exposure_management.limitations.length > 0, "limitations are stated, never implied");

  // NO SECRETS: never the raw account, never a token.
  const blob = JSON.stringify(d);
  assert.doesNotMatch(blob, /AB1234/, "the raw account id must never be published");
  assert.doesNotMatch(blob, /access_token|Bearer|api_secret/i);
});

test("the decision refuses entry when the order stream is DEGRADED, and says WHY", () => {
  const clock = makeClock();
  const consumer = driveToIdleDegraded(clock);
  const d = buildOperationalReadiness({
    ...READY_INPUT,
    orderStream: {
      ...READY_INPUT.orderStream,
      lifecycle: consumer.lifecycleState(),
      publishedState: consumer.health().state,
      fillsObservedBy: "rest_polling_only",
    },
  });

  assert.equal(d.entry.permitted, false);
  assert.ok(
    d.entry.reasons.some((r) => r.code === "order_stream_lifecycle"),
    "the refusal names the transport that blocked",
  );
  // …and the SAME decision keeps exposure manageable.
  assert.equal(d.exposure_management.exit_and_reduce, true, "a degraded stream must not strand a position");
  assert.equal(d.exposure_management.protective_cancel, true);
});

test("the decision is the SAME answer the live-entry checkpoint computes (one matrix, not two)", () => {
  // Cross-check against the shared table directly: if these ever diverge, the frontend is being
  // shown a permission the engine does not actually enforce.
  for (const md of ["READY", "DEGRADED", "SYNCHRONIZING", "DISCONNECTED", "AUTH_EXPIRED", "DISABLED"]) {
    for (const os of ["READY", "DEGRADED", "RECONCILING", "DISCONNECTED", "AUTH_EXPIRED", "DISABLED"]) {
      const d = buildOperationalReadiness({
        ...READY_INPUT,
        marketData: { ...READY_INPUT.marketData, state: md },
        orderStream: { ...READY_INPUT.orderStream, lifecycle: os },
      });
      const table = combinedPermissions({ marketData: md, orderStream: os });
      assert.equal(d.entry.permitted, table.newEntry, `entry disagreement at md=${md} os=${os}`);
      assert.equal(
        d.exposure_management.exit_and_reduce,
        table.exitAndReduce,
        `exit disagreement at md=${md} os=${os}`,
      );
      assert.equal(
        d.exposure_management.protective_cancel,
        table.protectiveCancel,
        `cancel disagreement at md=${md} os=${os}`,
      );
    }
  }
});

test("INVARIANT: entry-only blockers never independently block a REDUCTION", () => {
  // Every entry-only restriction in the real system, applied at once, with both transports in a
  // state that still prices a reduction. Reduction must survive all of them.
  const d = buildOperationalReadiness({
    ...READY_INPUT,
    blockers: [
      { code: "scanner_stopped", scope: "entry", detail: "the scanner is stopped" },
      { code: "entry_disabled", scope: "entry", detail: "entry is disabled" },
      { code: "session_budget_exhausted", scope: "entry", detail: "the session cycle budget is spent" },
      { code: "max_entry_capital", scope: "entry", detail: "entry capital cap reached" },
      { code: "one_active_underlying", scope: "entry", detail: "another underlying is active" },
      { code: "reservation_service_unavailable", scope: "entry", detail: "reservations unavailable" },
      { code: "unrelated_symbol_stale", scope: "entry", detail: "an unrelated symbol is stale" },
    ],
  });

  assert.equal(d.entry.permitted, false, "entry is blocked by the entry-scoped blockers");
  assert.equal(d.entry.reasons.length >= 7, true);
  assert.equal(
    d.exposure_management.exit_and_reduce,
    true,
    "an entry-scoped blocker must NEVER block reduction of already-owned exposure",
  );
  assert.equal(d.exposure_management.protective_cancel, true);
  assert.equal(
    d.exposure_management.blocked_reasons.length,
    0,
    "no entry-scoped reason may appear as a reduction blocker",
  );
});

test("a reduction-scoped blocker DOES block reduction (reduction keeps its own real requirements)", () => {
  const d = buildOperationalReadiness({
    ...READY_INPUT,
    marketData: { ...READY_INPUT.marketData, state: "AUTH_EXPIRED" },
  });
  assert.equal(d.exposure_management.exit_and_reduce, false, "an expired session cannot price a reduction");
  assert.ok(d.exposure_management.blocked_reasons.length > 0, "and it says why");
});

test("evidence freshness is reported as an AGE, and an absent observation is null — never 0", () => {
  const d = buildOperationalReadiness({
    ...READY_INPUT,
    marketData: {
      ...READY_INPUT.marketData,
      depthAgeMs: null,
      frameAgeMs: null,
      heartbeatAgeMs: null,
      lastDepthWallAt: null,
      lastFrameWallAt: null,
      lastHeartbeatWallAt: null,
      frames: 0,
      heartbeats: 0,
      depthObservations: 0,
    },
    orderStream: { ...READY_INPUT.orderStream, lastEventAt: null },
  });
  assert.equal(d.evidence.market_data_depth_age_ms, null, "never-observed depth is null, not a fresh 0");
  assert.equal(d.evidence.market_data_frame_age_ms, null);
  assert.equal(d.evidence.market_data_heartbeat_age_ms, null);
  assert.equal(d.evidence.order_stream_event_age_ms, null);
  // Wall stamps follow the same rule: absent means absent.
  assert.equal(d.evidence.market_data_last_frame_at, null);
  assert.equal(d.evidence.market_data_last_depth_at, null);
  // And no tick evidence means the payload must not claim any.
  assert.equal(d.market_data.ticks_observed, false);
});

test("market-data ages are published in the MONOTONIC domain, never wall-minus-monotonic", () => {
  /*
   * THE REGRESSION GUARD for the defect that made "last frame never observed" appear while ticks
   * were arriving normally. The engine stamps frame/depth/heartbeat times with
   * `executionClock.mono()` (a small number — process uptime), but passed `executionClock.wall()`
   * as the builder's `now` (~1.7e12). Subtracting them yielded ages of roughly 55 years, always
   * positive so the `Math.max(0, …)` floor could not reveal it.
   *
   * `now` here is a realistic WALL value while the ages are small monotonic spans. If the builder
   * ever recomputed an age from `now` again, these numbers would come back in the trillions.
   */
  const d = buildOperationalReadiness({
    ...READY_INPUT,
    now: 1_700_000_000_000,
    marketData: { ...READY_INPUT.marketData, frameAgeMs: 137.4, depthAgeMs: 412.9, heartbeatAgeMs: 12.2 },
  });
  assert.equal(d.evidence.market_data_frame_age_ms, 137, "the age the machine measured, rounded");
  assert.equal(d.evidence.market_data_depth_age_ms, 413);
  assert.equal(d.evidence.market_data_heartbeat_age_ms, 12);
  assert.equal(d.evidence.market_data_age_clock, "monotonic", "the domain is published, not assumed");
  for (const age of [
    d.evidence.market_data_frame_age_ms,
    d.evidence.market_data_depth_age_ms,
    d.evidence.market_data_heartbeat_age_ms,
  ]) {
    assert.ok(age < 60_000, `a market-data age of ${age}ms betrays a mixed clock domain`);
    assert.ok(Number.isInteger(age), "the contract declares an integer");
  }
});

test("PAPER: the payload reports simulated fills and a not-applicable order stream, not a fault", () => {
  /*
   * The paper-mode reporting defect, end to end. A paper deployment constructs no order-stream
   * consumer by design, and the old code read that absence as `not_wired` (documented as "should be
   * running and is not") plus `rest_polling_only` — claiming a broker REST round trip for orders
   * that are never sent anywhere.
   */
  const paper = buildOperationalReadiness({
    ...READY_INPUT,
    identity: {
      ...READY_INPUT.identity,
      executionMode: "paper_latency",
      liveRuntimeArmed: false,
      deploymentLiveCapable: false,
    },
    orderStream: {
      ...READY_INPUT.orderStream,
      lifecycle: "DISABLED",
      publishedState: "DISABLED",
      wiring: "not_applicable_paper",
      gateEnabled: false,
      connected: false,
      authorised: false,
      lastEventAt: null,
      fillsObservedBy: "simulated_paper_fills",
    },
    paperExecution: { simulated: true, profile: "paper_latency", usingStreamedQuotes: true },
  });

  assert.equal(paper.paper_execution.simulated, true);
  assert.equal(paper.paper_execution.profile, "paper_latency");
  assert.equal(paper.paper_execution.using_streamed_quotes, true);
  assert.match(
    paper.paper_execution.detail,
    /Real broker WebSocket quotes · simulated execution/,
    "the claim is made — and only because there IS tick evidence",
  );
  assert.match(paper.paper_execution.detail, /NO order reaches the broker/);
  assert.equal(paper.fill_observation.mechanism, "simulated_paper_fills");
  assert.equal(paper.fill_observation.stream_assisted, false);

  // A DISABLED order stream never blocks entry: it is the documented paper baseline, not a fault.
  const entryCodes = paper.entry.reasons.map((r) => r.code);
  assert.ok(
    !entryCodes.some((c) => String(c).startsWith("order_stream")),
    `a not-applicable paper order stream must not block entry (got ${entryCodes.join(", ")})`,
  );

  // THE RED EXPOSURE WARNING. Paper must never report exposure management as blocked merely
  // because live readiness is off.
  assert.equal(paper.exposure_management.exit_and_reduce, true);
  assert.equal(paper.exposure_management.protective_cancel, true);
  assert.deepEqual(paper.exposure_management.blocked_reasons, []);
});

test("PAPER: the streamed-quotes claim is REFUSED when no tick has been observed", () => {
  // The honesty half of the test above: with an open socket but zero frames, the payload must not
  // say "real broker WebSocket quotes".
  const paper = buildOperationalReadiness({
    ...READY_INPUT,
    identity: { ...READY_INPUT.identity, executionMode: "paper_latency", deploymentLiveCapable: false },
    marketData: {
      ...READY_INPUT.marketData,
      state: "SYNCHRONIZING",
      frames: 0,
      heartbeats: 0,
      depthObservations: 0,
      frameAgeMs: null,
      depthAgeMs: null,
      heartbeatAgeMs: null,
      readyInstruments: 0,
      usableBooks: 0,
      socketConnected: true,
    },
    paperExecution: { simulated: true, profile: "paper_latency", usingStreamedQuotes: false },
  });

  assert.equal(paper.market_data.ticks_observed, false, "an open socket is not tick evidence");
  assert.equal(paper.market_data.socket_connected, true, "and the two are reported separately");
  assert.equal(paper.market_data.usable_for_entry, false);
  assert.doesNotMatch(
    paper.paper_execution.detail,
    /Real broker WebSocket quotes/,
    "no ticks ⇒ the claim must NOT be made",
  );
  assert.match(paper.paper_execution.detail, /NO tick has been observed/);
  assert.equal(paper.entry.permitted, false, "and entry is still refused");
});

/* ═══════════ 4. PRODUCTION WIRING: the decision must be FED and PUBLISHED, not merely built ═══════════ */

/**
 * A module that is built, unit-tested and never called reports nothing forever while looking
 * finished. These assertions pin the real CALL SITES, in the same style as
 * tests/box/wiredNotInert.test.mjs — comments stripped, so a mention in prose never counts.
 *
 * They matter most for `src/index.ts`, which cannot be booted hermetically (it needs PostgreSQL, a
 * token service and a broker registry): without these, the two changes that actually collapse the
 * three disagreeing readiness answers into one — the blocker source and the `live_entry` projection
 * — would have no automated evidence at all.
 */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");
const codeOf = (rel) => stripComments(readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8"));

test("WIRING: the engine BUILDS the decision and PUBLISHES it in getStatus()", () => {
  const engine = codeOf("box/engine.ts");
  assert.ok(engine.includes("buildOperationalReadiness({"), "the engine must build the decision");
  assert.ok(
    engine.includes("operational_readiness: this.operationalReadiness()"),
    "and getStatus() must publish it, or the dashboard receives nothing",
  );
  assert.ok(
    engine.includes("++this.readinessDecisionGeneration"),
    "the generation must be incremented per decision, or a client cannot detect a stale response",
  );
  // The decision must read the SAME accessors the live-entry checkpoint reads.
  assert.ok(engine.includes("const marketDataState = this.marketDataState()"));
  assert.ok(engine.includes("const orderStreamLifecycle = this.orderStreamState()"));
});

test("WIRING: src/index.ts FEEDS the env/DB/token evidence in as scoped blockers", () => {
  const index = codeOf("index.ts");
  assert.ok(
    index.includes("setExternalReadinessBlockers("),
    "the evidence only index.ts can see must reach the ONE decision",
  );
  // Each fact that used to be computed into a SECOND verdict must now be a blocker.
  for (const code of [
    "postgres_unavailable",
    "active_broker_token_not_ready",
    "box_live_trading_disabled",
    "migrations_pending",
  ]) {
    assert.ok(index.includes(code), `${code} must be supplied as a readiness blocker`);
  }
  // …and every one of them ENTRY-scoped, so none can block a reduction.
  assert.ok(!/scope: "reduction"/.test(index), "index.ts must not declare a reduction-scoped blocker");
  assert.ok(!/scope: "both"/.test(index), "nor a both-scoped one — none of these facts stops an exit");
});

test("WIRING: runtime status live_entry is PROJECTED from the decision, not recomputed", () => {
  const index = codeOf("index.ts");
  assert.ok(
    index.includes("boxModule.engine.operationalReadiness()"),
    "the runtime endpoint must read the ONE decision",
  );
  assert.ok(
    index.includes("blocked: !readiness.entry.permitted"),
    "live_entry.blocked must BE the decision's verdict",
  );
  assert.ok(
    index.includes("readiness.entry.reasons.map((r) => r.code)"),
    "and its reasons must be the decision's codes",
  );
  // The old second computation must be GONE, not merely bypassed.
  assert.ok(
    !index.includes('reasons.push("postgres_unavailable")'),
    "the old independent live_entry computation must be removed, or it will drift again",
  );
});

test("WIRING: the MASKED identity has a real production source, not just a tested code path", () => {
  // Found by audit: `brokerAccountRef` was never supplied to registerBoxModule, so
  // `identity.account_masked` published null forever. The masking function was correct and
  // unit-tested, and fed by nothing — the exact "built, tested and never called" failure this
  // section exists to remove. An operator could not tell WHICH account a live verdict was for.
  const index = codeOf("index.ts");
  assert.ok(
    index.includes("brokerAccountRef: () => brokerManager.sessionFor("),
    "the readiness decision's account reference must have a real source",
  );
  const engine = codeOf("box/engine.ts");
  assert.ok(
    engine.includes("account: this.deps.brokerAccountRef?.() ?? null"),
    "and the engine must pass it into the decision, where it is masked",
  );
  // It must be an IDENTIFIER accessor, never a token accessor.
  assert.ok(
    !/brokerAccountRef: \(\) => [^\n]*(access_token|Token|token)\b/.test(index),
    "the account reference must never be sourced from a token",
  );
});

test("WIRING: the consumer's published health is derived from the machine, at the only producer", () => {
  const consumer = codeOf("box/orderStreamConsumer.ts");
  assert.ok(
    consumer.includes("const lifecycle = this.machine.state();"),
    "health() must read the ONE lifecycle authority",
  );
  assert.ok(
    consumer.includes("const state = publishedStateForLifecycle(lifecycle);"),
    "and derive the published state from it via the total mapping",
  );
  assert.ok(
    !consumer.includes("return this.proj.orderStreamHealth();"),
    "the straight pass-through of the second state holder must be gone — it WAS defect (a)",
  );
  assert.ok(consumer.includes("this.proj.onStreamIdle()"), "an idle demotion must reach the projection");
  assert.ok(
    consumer.includes("this.onIdle();"),
    "evaluateIdle must route through onIdle, not poke the machine directly",
  );
});
