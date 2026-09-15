/**
 * SECTION 7 CONTRACT TESTS — the ONE readiness decision on the REAL wire.
 *
 * These are contract tests in the strict sense used by this suite: they validate the bytes a client
 * actually receives, produced by the REAL producers in src/ —
 *
 *   (A) REAL HTTP for `GET /api/runtime/status`, mounted from the real route registrar with a
 *       provider that projects a REAL `buildOperationalReadiness` decision, driven over a real
 *       loopback listener with a REAL PG-backed operator session.
 *   (B) REAL BoxEngine for `box-status.operational_readiness` and `order_stream`, obtained from a
 *       DIRECT call to the real `BoxEngine.getStatus()` on a hermetically-constructed engine (inert
 *       deps, no network) — the same method the `/api/box/status` route serialises verbatim.
 *
 * THE SCENARIOS COVERED (each is a way the two repositories previously disagreed):
 *   backend/frontend disagreement · stale data · reconnect · HTTP 401 · HTTP 403 · timeout ·
 *   mode change · broker switch.
 *
 * PostgreSQL is required for the HTTP paths and FAILS LOUDLY if unreachable — never silently skips.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  authGet,
  check,
  createDbSchema,
  login,
  makeBrokerProvider,
  makeExportProvider,
  startApp,
  wire,
} from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");
const PASSCODE = "section7-contract-passcode";

function assertValid(errors, label) {
  assert.deepEqual(errors, [], `${label} must satisfy its schema; errors: ${JSON.stringify(errors)}`);
}

/* ─────────────────────────── a hermetic engine (no network, no DB) ─────────────────────────── */

function engineWith({ authenticated = true, broker = "zerodha" } = {}) {
  return {
    marketData: { isAuthenticated: () => authenticated, getQuoteFull: async () => ({}) },
    activeBroker: () => broker,
    feed: {
      addTickListener: () => () => {}, addConnectionListener: () => () => {}, retain: () => () => {},
      subscribeTokens: () => {}, unsubscribeTokens: () => {}, setStrategyTokens: () => {}, setBoxTokens: () => {},
      subscribedCount: () => 0, isConnected: () => false,
    },
    charges: { broker, rateVersion: "test", estimate: () => null },
    getAllInstruments: async () => [], getBoard: async () => [],
    priceChargeGroups: async () => null, istDayKey: () => "2026-09-08",
    makeIdResolver: () => () => null, isMarketOpen: () => false,
    margins: { broker, basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "kite_basket" }) },
    // A NON-SECRET account reference, exactly as the production dep is documented.
    brokerAccountRef: () => "AB1234",
  };
}

/* ═══════════════ 1. THE DECISION IS ON THE WIRE, AND IT IS THE SAME ONE THE GATE USES ═══════════════ */

test("[SERDE] box-status carries the ONE readiness decision, schema-valid, with no secret", async () => {
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const e = new BoxEngine(engineWith());
  try {
    const status = wire(e.getStatus());
    assertValid(await check(status, "box-status.schema.json"), "box-status");
    assertValid(
      await check(status.operational_readiness, "operational-readiness.schema.json"),
      "operational-readiness",
    );

    const d = status.operational_readiness;
    // Response identity: generation, version and timestamp all present, so a client can detect a
    // stale or out-of-order answer instead of rendering it as current.
    assert.ok(Number.isInteger(d.decision_generation) && d.decision_generation >= 1);
    assert.equal(typeof d.decision_version, "string");
    assert.ok(Number.isInteger(d.decided_at));

    // MASKED identity: the reference is present but the raw value never appears anywhere.
    assert.equal(d.identity.account_present, true);
    assert.equal(d.identity.account_masked, "AB••34");
    const blob = JSON.stringify(status);
    assert.doesNotMatch(blob, /AB1234/, "the account reference must never be published unmasked");
    assert.doesNotMatch(blob, /access_token|api_secret|Bearer |passcode/i, "no secret on the wire");

    // Both ACTUAL lifecycles, the reconciliation answer, and both permissions are published.
    assert.ok(typeof d.market_data.state === "string");
    assert.ok(typeof d.order_stream.lifecycle === "string");
    assert.equal(typeof d.reconciliation.pending, "boolean");
    assert.equal(typeof d.entry.permitted, "boolean");
    assert.equal(typeof d.exposure_management.exit_and_reduce, "boolean");
    assert.ok(d.exposure_management.limitations.length > 0, "limitations are stated, never implied");
  } finally {
    e.dispose();
  }
});

test("[SERDE] decision_generation is MONOTONIC across reads, so an out-of-order response is detectable", async () => {
  // This is the field a client uses to IGNORE a response that would overwrite newer state. If it
  // ever repeated or went backwards, an out-of-order guard built on it would be unsound.
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const e = new BoxEngine(engineWith());
  try {
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push(e.getStatus().operational_readiness.decision_generation);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] > seen[i - 1], `generation must strictly increase: ${seen.join(",")}`);
    }
  } finally {
    e.dispose();
  }
});

test("[SERDE] DISAGREEMENT: a paper engine never claims the stream fill path, and says so consistently", async () => {
  // The disagreement class of defect (a): the published fill mechanism, the published order-stream
  // lifecycle and the entry verdict must all tell ONE story.
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const e = new BoxEngine(engineWith());
  try {
    const status = wire(e.getStatus());
    const d = status.operational_readiness;
    const activeBroker = status.broker;
    const published = status.order_stream.brokers.find((b) => b.broker === activeBroker);

    // The decision's mechanism IS the published mechanism — not a second computation of it.
    assert.equal(d.fill_observation.mechanism, published.fills_observed_by);
    assert.equal(d.order_stream.lifecycle, published.lifecycle ?? "DISABLED");
    // And when no stream is observing fills, the payload never says it is.
    if (d.fill_observation.mechanism === "rest_polling_only") {
      assert.equal(d.fill_observation.stream_assisted, false);
      assert.equal(status.order_stream.any_stream_live, false);
    }
  } finally {
    e.dispose();
  }
});

test("[SERDE] STALE DATA: never-observed evidence is null, never a fresh zero", async () => {
  // An engine that has seen no frame, no heartbeat, no depth and no order event must report NULL
  // ages. A 0 would read as "observed just now" — the most dangerous possible rounding.
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const e = new BoxEngine(engineWith());
  try {
    const d = wire(e.getStatus()).operational_readiness;
    assert.equal(d.evidence.market_data_depth_age_ms, null, "no depth ever ⇒ null, not 0");
    assert.equal(d.evidence.market_data_frame_age_ms, null);
    assert.equal(d.evidence.order_stream_event_age_ms, null);
    // …and a feed that has proven nothing is not usable for entry.
    assert.equal(d.market_data.usable_for_entry, false);
    assert.equal(d.entry.permitted, false, "unproven data must never permit entry");
    assert.ok(d.entry.reasons.length > 0, "and it must say why");
  } finally {
    e.dispose();
  }
});

test("[SERDE] RECONNECT: an owed gap repair is published as a blocker, and never blocks reduction", async () => {
  // Driven through the REAL consumer + the REAL decision builder, not a hand-written payload.
  const { OrderStreamConsumer } = await import(`${DIST}/box/orderStreamConsumer.js`);
  const { buildOperationalReadiness } = await import(`${DIST}/box/operationalReadiness.js`);

  let t = 1_700_000_000_000;
  const consumer = new OrderStreamConsumer({
    broker: "zerodha", account: () => "AB1234", adapter: null, streamEnabled: true, now: () => t,
  });
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated();
  consumer.markSynchronized();
  // A real reconnect: the socket dropped and came back. A gap now exists.
  consumer.onDisconnected();
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated();
  assert.equal(consumer.lifecycleState(), "RECONCILING");
  assert.equal(consumer.reconcilePending(), true);

  const health = consumer.health();
  const d = wire(
    buildOperationalReadiness({
      now: t, decisionGeneration: 1,
      identity: { broker: "zerodha", account: "AB1234", executionMode: "live", liveRuntimeArmed: true, deploymentLiveCapable: true },
      marketData: {
        state: "READY", generation: 2, desiredInstruments: 4, readyInstruments: 4,
        frameAgeMs: 100, heartbeatAgeMs: 100, depthAgeMs: 150, backlog: false,
        lastFrameWallAt: t - 100, lastHeartbeatWallAt: t - 100, lastDepthWallAt: t - 150,
        frames: 200, heartbeats: 8, depthObservations: 180,
        source: "broker_websocket", socketConnected: true, authenticated: true,
        subscriptionsRequested: true, usableBooks: 4,
      },
      orderStream: {
        lifecycle: consumer.lifecycleState(), publishedState: health.state, wiring: "armed", gateEnabled: true,
        connected: health.connected, authorised: health.authorised, lastEventAt: health.lastEventAt,
        disconnects: health.disconnects, reconcilePending: consumer.reconcilePending(),
        fillsObservedBy: "rest_polling_only",
      },
      paperExecution: { simulated: false, profile: null, usingStreamedQuotes: false },
      blockers: [], openExposure: { openPositions: 1, residualLegs: 0, workingOrders: 0 },
    }),
  );
  assertValid(await check(d, "operational-readiness.schema.json"), "operational-readiness (reconnect)");

  assert.equal(d.reconciliation.pending, true);
  assert.ok(d.reconciliation.blockers.length > 0, "an owed gap repair is named, not implied");
  assert.equal(d.entry.permitted, false, "no new exposure on top of an unrepaired gap");
  // THE INVARIANT: the reconnect blocks ENTRY only.
  assert.equal(d.exposure_management.exit_and_reduce, true, "a reconnect must never strand a position");
  assert.equal(d.exposure_management.protective_cancel, true);
  assert.equal(d.exposure_management.blocked_reasons.length, 0);
});

test("[SERDE] MODE CHANGE and BROKER SWITCH are reflected in the decision's identity", async () => {
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  // BROKER SWITCH: the decision names the broker the verdict was computed FOR, so a switch can
  // never leave a stale broker's readiness on screen.
  for (const broker of ["zerodha", "dhan"]) {
    const e = new BoxEngine(engineWith({ broker }));
    try {
      const d = wire(e.getStatus()).operational_readiness;
      assert.equal(d.identity.broker, broker);
      assertValid(await check(d, "operational-readiness.schema.json"), `readiness (${broker})`);
    } finally {
      e.dispose();
    }
  }
  // MODE CHANGE: the execution mode travels WITH the verdict. A paper deployment is not
  // live-capable, and the decision says so rather than leaving the label to the client.
  const paper = new BoxEngine(engineWith());
  try {
    const d = wire(paper.getStatus()).operational_readiness;
    assert.equal(typeof d.identity.execution_mode, "string");
    assert.equal(d.identity.deployment_live_capable, d.identity.execution_mode === "live");
  } finally {
    paper.dispose();
  }
});

test("[SERDE] a THROWING external evidence provider yields a BLOCKER, never an all-clear", async () => {
  // "We could not check" must never render as "nothing is wrong". This is the fail-safe direction.
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const e = new BoxEngine(engineWith());
  try {
    e.setExternalReadinessBlockers(() => {
      throw new Error("token service unavailable");
    });
    const d = wire(e.getStatus()).operational_readiness;
    assertValid(await check(d, "operational-readiness.schema.json"), "operational-readiness (provider threw)");
    assert.equal(d.entry.permitted, false);
    assert.ok(
      d.entry.reasons.some((r) => r.code === "readiness_evidence_unavailable"),
      "an unreadable evidence source is itself a named blocker",
    );
    // The thrown message must not leak into the payload.
    assert.doesNotMatch(JSON.stringify(d), /token service unavailable/);
  } finally {
    e.dispose();
  }
});

test("[SERDE] every entry-scoped external blocker leaves REDUCTION permitted", async () => {
  // The whole invariant, driven through the REAL engine seam that src/index.ts uses in production.
  //
  // Stated as a DIFFERENCE, not an absolute: this hermetic engine has market data DISABLED, and the
  // permission table deliberately refuses even a priced protective cancel in that state (a strategy
  // with no market data cannot price a replacement limit — see streamHealthPolicy.ts). So the claim
  // under test is the one that matters: adding five entry-scoped blockers must change the ENTRY
  // verdict and leave every REDUCTION answer byte-identical.
  const { BoxEngine } = await import(`${DIST}/box/engine.js`);
  const e = new BoxEngine(engineWith());
  try {
    const before = wire(e.getStatus()).operational_readiness.exposure_management;

    e.setExternalReadinessBlockers(() => [
      { code: "execution_mode_paper", scope: "entry", detail: "paper mode" },
      { code: "box_live_trading_disabled", scope: "entry", detail: "gate unarmed" },
      { code: "postgres_unavailable", scope: "entry", detail: "authoritative store unavailable" },
      { code: "active_broker_token_not_ready", scope: "entry", detail: "token not ready" },
      { code: "migrations_pending", scope: "entry", detail: "migrations pending" },
    ]);
    const after = wire(e.getStatus());
    const d = after.operational_readiness;

    assert.equal(d.entry.permitted, false);
    assert.ok(d.entry.reasons.length >= 5, "every entry blocker is named");
    assert.equal(
      d.exposure_management.blocked_reasons.filter((r) => r.scope === "entry").length,
      0,
      "an entry-scoped blocker can never appear as a reduction blocker",
    );
    // Byte-identical reduction answer: the entry blockers moved nothing on the reduction side.
    assert.equal(d.exposure_management.exit_and_reduce, before.exit_and_reduce);
    assert.equal(d.exposure_management.protective_cancel, before.protective_cancel);
    assert.equal(d.exposure_management.manage_working_orders, before.manage_working_orders);
    assert.deepEqual(d.exposure_management.blocked_reasons, before.blocked_reasons);
  } finally {
    e.dispose();
  }
});

/* ═══════════════ 2. REAL HTTP: the operator endpoint is a PROJECTION of the same decision ═══════════════ */

/**
 * A runtime provider that projects a REAL `buildOperationalReadiness` decision into the
 * runtime-status shape, exactly as `src/index.ts` now does. This is what pins the two surfaces
 * together: if the projection drifted, `live_entry` would stop matching `entry`.
 */
async function makeReadinessBackedRuntimeProvider({ marketData = "DEGRADED", orderStream = "DEGRADED" } = {}) {
  const { buildOperationalReadiness } = await import(`${DIST}/box/operationalReadiness.js`);
  const now = 1_700_000_000_000;
  const decision = buildOperationalReadiness({
    now, decisionGeneration: 9,
    identity: { broker: "zerodha", account: "AB1234", executionMode: "live", liveRuntimeArmed: true, deploymentLiveCapable: true },
    marketData: {
      state: marketData, generation: 3, desiredInstruments: 4, readyInstruments: 2,
      frameAgeMs: 9000, heartbeatAgeMs: 9000, depthAgeMs: 30000, backlog: false,
      lastFrameWallAt: now - 9000, lastHeartbeatWallAt: now - 9000, lastDepthWallAt: now - 30000,
      frames: 300, heartbeats: 12, depthObservations: 150,
      source: "broker_websocket", socketConnected: true, authenticated: true,
      subscriptionsRequested: true, usableBooks: 2,
    },
    orderStream: {
      lifecycle: orderStream, publishedState: "DEGRADED", wiring: "armed", gateEnabled: true,
      connected: true, authorised: true, lastEventAt: now - 60000, disconnects: 1,
      reconcilePending: false, fillsObservedBy: "rest_polling_only",
    },
    blockers: [{ code: "postgres_unavailable", scope: "entry", detail: "authoritative store unavailable" }],
    paperExecution: { simulated: false, profile: null, usingStreamedQuotes: false },
    openExposure: { openPositions: 1, residualLegs: 0, workingOrders: 1 },
  });
  return {
    decision,
    provider: {
      getRuntimeStatus: () => ({
        brokers: [],
        active_broker: "zerodha",
        pg_ready: false,
        migration_state: { applied: 12, pending: 0 },
        recovery_ready: true,
        live_entry: {
          blocked: !decision.entry.permitted,
          reasons: decision.entry.reasons.map((r) => r.code),
        },
        recovery_pending: false,
        residual_exposure: false,
      }),
    },
  };
}

test("[HTTP] runtime status live_entry is a PROJECTION of the readiness decision (no second verdict)", async () => {
  const db = await createDbSchema("s7ready");
  const { decision, provider } = await makeReadinessBackedRuntimeProvider();
  const app = await startApp(db.databaseUrl, {
    env: { SITE_ACCESS_SECRET: PASSCODE },
    runtimeProvider: provider,
    exportProvider: makeExportProvider(),
    brokerProvider: makeBrokerProvider({ active: "zerodha" }),
  });
  try {
    const auth = await login(app.origin, PASSCODE);
    const runtime = await authGet(app.origin, "/api/runtime/status", auth.cookieHeader);
    assert.equal(runtime.res.status, 200);
    assertValid(await check(runtime.body, "runtime-status.schema.json"), "runtime-status");

    // The endpoint's verdict IS the decision's verdict, and its reasons are the decision's codes.
    assert.equal(runtime.body.live_entry.blocked, !decision.entry.permitted);
    assert.deepEqual(runtime.body.live_entry.reasons, decision.entry.reasons.map((r) => r.code));
    assert.ok(
      runtime.body.live_entry.reasons.includes("market_data_lifecycle"),
      "the transport lifecycle now reaches live_entry — the old computation could not see it at all",
    );
    assert.ok(runtime.body.live_entry.reasons.includes("postgres_unavailable"));
  } finally {
    await app.close();
    await db.drop();
  }
});

test("[HTTP] 401: an UNAUTHENTICATED runtime-status request is refused and leaks no readiness", async () => {
  const db = await createDbSchema("s7401");
  const { provider } = await makeReadinessBackedRuntimeProvider();
  const app = await startApp(db.databaseUrl, {
    env: { SITE_ACCESS_SECRET: PASSCODE },
    runtimeProvider: provider,
    exportProvider: makeExportProvider(),
    brokerProvider: makeBrokerProvider({ active: "zerodha" }),
  });
  try {
    const res = await fetch(`${app.origin}/api/runtime/status`);
    assert.equal(res.status, 401, "readiness is operator-only; UI restrictions are not the boundary");
    const text = await res.text();
    assert.doesNotMatch(text, /live_entry|market_data_lifecycle|AB1234/, "a refusal reveals nothing");
  } finally {
    await app.close();
    await db.drop();
  }
});

test("[HTTP] 403: a mutating request WITHOUT the CSRF header is refused by the backend, not the UI", async () => {
  const db = await createDbSchema("s7403");
  const { provider } = await makeReadinessBackedRuntimeProvider();
  const app = await startApp(db.databaseUrl, {
    env: { SITE_ACCESS_SECRET: PASSCODE },
    runtimeProvider: provider,
    exportProvider: makeExportProvider(),
    brokerProvider: makeBrokerProvider({ active: "zerodha" }),
  });
  try {
    const auth = await login(app.origin, PASSCODE);
    // A REAL authenticated session, but the CSRF token is deliberately omitted.
    const res = await fetch(`${app.origin}/api/broker/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: auth.cookieHeader },
      body: JSON.stringify({ broker: "dhan" }),
    });
    assert.equal(res.status, 403, "authorisation is enforced server-side for every mutation");
  } finally {
    await app.close();
    await db.drop();
  }
});

test("[HTTP] TIMEOUT: a runtime provider that never resolves is answered 503, not a fabricated OK", async () => {
  const db = await createDbSchema("s7timeout");
  const app = await startApp(db.databaseUrl, {
    env: { SITE_ACCESS_SECRET: PASSCODE },
    // A provider that REJECTS stands in for an evidence source that timed out. The route must
    // answer "unavailable" — never an empty-but-successful readiness a client would render green.
    runtimeProvider: { getRuntimeStatus: async () => { throw new Error("evidence read timed out"); } },
    exportProvider: makeExportProvider(),
    brokerProvider: makeBrokerProvider({ active: "zerodha" }),
  });
  try {
    const auth = await login(app.origin, PASSCODE);
    const runtime = await authGet(app.origin, "/api/runtime/status", auth.cookieHeader);
    assert.equal(runtime.res.status, 503, "unavailable evidence answers 503, never 200 with a blank readiness");
    assert.match(runtime.body.error, /temporarily unavailable/);
    // The underlying error text must not escape to the client.
    assert.doesNotMatch(JSON.stringify(runtime.body), /timed out/);
  } finally {
    await app.close();
    await db.drop();
  }
});
