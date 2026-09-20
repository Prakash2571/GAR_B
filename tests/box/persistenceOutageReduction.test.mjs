/**
 * A POSTGRESQL OUTAGE STOPS REDUCTION TOO, AND THE READINESS VERDICT MUST SAY SO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `buildOperationalReadiness` had NO persistence input. Every reduction verdict was computed from
 * transport lifecycle alone, so with PostgreSQL unavailable it published
 *
 *     exposure_management: { exit_and_reduce: true, protective_cancel: true, manage_working_orders: true }
 *
 * and its own `limitations` asserted that "Protective cancellation … is permitted in every state
 * except an expired session". The frontend rendered that as "Exits, protective cancellation and
 * reconciliation are unaffected."
 *
 * That is false for all four operations, because each needs PostgreSQL BEFORE it can reach the
 * broker:
 *   • EXIT and EMERGENCY_RESIDUAL — `BoxOrderManager.execute()` performs two awaited durable writes
 *     before the transport call (`persistence.create`, then the CREATED→SUBMITTING compare-and-set)
 *     for EVERY purpose. The guard after the CAS reads "broker POST blocked".
 *   • PROTECTIVE CANCEL — the bare cancel posts before writing, but its only caller
 *     (`cancelWorkingBoxOrders`) must first READ `loadNonterminal()` to learn what to cancel.
 *   • RECONCILIATION — opens with `loadNonterminal()` + `loadOwned()`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT THAT MUST SURVIVE THE FIX
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * An ENTRY-SCOPED control must still never block reduction. Persistence is not an entry control —
 * it is a shared physical precondition — so it is reported on BOTH scopes, while funding, budgets
 * and the daily-loss breaker remain entry-only and leave every reduction route open.
 *
 * Offline: the real builder and the real `BoxOrderManager`, no database.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildOperationalReadiness } from "../../dist/box/operationalReadiness.js";
import { BoxOrderManager } from "../../dist/box/orderManager.js";
import { brokerOrderFor, liveStack, runEntry } from "./liveEntryHarness.mjs";

/* ─────────────────────────── readiness fixture ─────────────────────────── */

const HEALTHY = {
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
  persistence: { durableStoreReady: true, durableWrites: "healthy" },
  blockers: [],
  openExposure: { openPositions: 1, residualLegs: 0, workingOrders: 2 },
};

const withPersistence = (persistence, extra = {}) =>
  buildOperationalReadiness({ ...HEALTHY, ...extra, persistence });

const reductionCodes = (d) => d.exposure_management.blocked_reasons.map((b) => b.code);

/* ═══════════════════ 1. the healthy control ═══════════════════ */

test("with PostgreSQL healthy, reduction is permitted and nothing is blocked", () => {
  // Non-vacuity: every assertion below must be caused by the outage, not by the fixture.
  const d = withPersistence({ durableStoreReady: true, durableWrites: "healthy" });
  assert.equal(d.exposure_management.exit_and_reduce, true);
  assert.equal(d.exposure_management.protective_cancel, true);
  assert.equal(d.exposure_management.manage_working_orders, true);
  assert.ok(!reductionCodes(d).includes("durable_store_unavailable"));
});

test("a persistence state of 'unknown' is NOT read as an outage", () => {
  // No write has been attempted yet. Absence of evidence is not evidence of failure, and treating
  // it as an outage would report every freshly started process as unable to reduce.
  const d = withPersistence({ durableStoreReady: true, durableWrites: "unknown" });
  assert.equal(d.exposure_management.exit_and_reduce, true);
  assert.equal(d.exposure_management.protective_cancel, true);
  assert.ok(!reductionCodes(d).includes("durable_store_unavailable"));
});

/* ═══════════════════ 2. the outage ═══════════════════ */

test("with the durable store DOWN, no reduction is reported as permitted", () => {
  const d = withPersistence({ durableStoreReady: false, durableWrites: "unknown" });

  assert.equal(d.exposure_management.exit_and_reduce, false, "an exit needs a durable write first");
  assert.equal(
    d.exposure_management.protective_cancel, false,
    "the cancel sweep must read the intent journal to know what to cancel",
  );
  assert.equal(d.exposure_management.manage_working_orders, false);
  assert.ok(reductionCodes(d).includes("durable_store_unavailable"), "and the reason is named");
});

test("a FAILED durable write is an outage even when the pool latch still reads ready", () => {
  // `pg_ready` / isPgReady() is probed once at init and never re-probed, so a mid-session outage
  // leaves it true while every query fails. The observed-write-outcome latch is what catches it.
  const d = withPersistence({ durableStoreReady: true, durableWrites: "unhealthy" });
  assert.equal(d.exposure_management.exit_and_reduce, false);
  assert.equal(d.exposure_management.protective_cancel, false);
  assert.ok(reductionCodes(d).includes("durable_store_unavailable"));
});

test("the outage blocker is ACTIONABLE: it says nothing was sent, exposure is still owned, and what to do", () => {
  const d = withPersistence({ durableStoreReady: false, durableWrites: "unhealthy" });
  const blocker = d.exposure_management.blocked_reasons.find((b) => b.code === "durable_store_unavailable");
  assert.ok(blocker, "the blocker must be present");

  // It must not leave the operator believing an order is queued and will go out later.
  assert.match(blocker.detail, /refused, not queued/i, "a refusal is not a queue");
  assert.match(blocker.detail, /nothing is transmitted|NOTHING was attempted/i);
  assert.match(blocker.detail, /unchanged and still owned/i, "the exposure did not go away");
  assert.match(blocker.detail, /broker terminal/i, "and the manual route is named");
});

test("the outage is reported on BOTH scopes — it stops creating exposure and reducing it", () => {
  const d = withPersistence({ durableStoreReady: false, durableWrites: "unhealthy" });
  assert.ok(d.exposure_management.blocked_reasons.some((b) => b.code === "durable_store_unavailable"));
  assert.ok(
    d.entry.reasons.some((b) => b.code === "durable_store_unavailable"),
    "entry is blocked by the same fact, and for the same reason",
  );
  assert.equal(d.entry.permitted, false);
});

test("the published limitations no longer claim protective cancel is permitted in every state", () => {
  // This string was the backend's own source for the frontend's false assurance.
  const limitations = withPersistence({ durableStoreReady: true, durableWrites: "healthy" })
    .exposure_management.limitations.join(" ");
  assert.doesNotMatch(
    limitations, /permitted in every state except an expired session/,
    "the corrected text must not reinstate the claim",
  );
  assert.match(limitations, /durable store is unavailable/i, "the real second exception is named");
  assert.match(limitations, /EVERY automated reduction/i, "and the general precondition is stated");
});

/* ═══════════════════ 3. recovery ═══════════════════ */

test("when PostgreSQL RECOVERS, the verdict clears without a restart", () => {
  const down = withPersistence({ durableStoreReady: false, durableWrites: "unhealthy" });
  assert.equal(down.exposure_management.exit_and_reduce, false);

  const recovered = withPersistence({ durableStoreReady: true, durableWrites: "healthy" });
  assert.equal(recovered.exposure_management.exit_and_reduce, true, "reduction is available again");
  assert.equal(recovered.exposure_management.protective_cancel, true);
  assert.ok(!reductionCodes(recovered).includes("durable_store_unavailable"), "and the blocker is gone");
  assert.equal(recovered.entry.reasons.some((b) => b.code === "durable_store_unavailable"), false);
});

/* ═══════════════════ 4. the entry-only invariant still holds ═══════════════════ */

test("an ENTRY-scoped blocker still never reaches the reduction verdict", () => {
  // The rule this fix must not break. A funding refusal, a spent attempt budget and a daily-loss
  // trip are all entry-scoped, and exposure must always remain reducible.
  const d = withPersistence(
    { durableStoreReady: true, durableWrites: "healthy" },
    {
      blockers: [
        { code: "funding_unproven", scope: "entry", detail: "Account funding could not be proven." },
        { code: "session_limit_reached", scope: "entry", detail: "The attempt budget is spent." },
      ],
    },
  );

  assert.equal(d.entry.permitted, false, "entry is refused");
  assert.equal(d.exposure_management.exit_and_reduce, true, "but reduction is untouched");
  assert.equal(d.exposure_management.protective_cancel, true);
  assert.deepEqual(reductionCodes(d), [], "no entry-scoped blocker leaks into the reduction verdict");
});

test("PAPER deployments are unaffected: no durable intent journal, so no persistence precondition", () => {
  // The mirror-image falsehood. PostgreSQL is optional for paper, whose reduction runs through the
  // deterministic simulator with no pre-POST intent write, so reporting a blocked reduction there
  // would be just as wrong as the claim being fixed.
  const d = buildOperationalReadiness({
    ...HEALTHY,
    identity: { ...HEALTHY.identity, executionMode: "paper_latency", deploymentLiveCapable: false },
    persistence: { durableStoreReady: false, durableWrites: "unhealthy" },
  });
  assert.equal(d.exposure_management.exit_and_reduce, true);
  assert.equal(d.exposure_management.protective_cancel, true);
  assert.ok(!reductionCodes(d).includes("durable_store_unavailable"));
});

/* ═══════════════════ 5. the cancel sweep refuses honestly, rather than throwing ═══════════════════ */

test("the working-order sweep REFUSES with a reason when the intent journal cannot be read", async () => {
  // `cancelWorkingBoxOrders` was rewritten to return a structured refusal precisely so a refused
  // panic button is distinguishable from a clean sweep. Its `loadNonterminal()` read was unguarded,
  // so a PostgreSQL outage threw instead — losing that shape.
  const stack = await liveStack();
  stack.persistence.loadNonterminal = async () => {
    throw new Error("Connection terminated unexpectedly");
  };

  const result = await stack.manager.cancelWorkingBoxOrders();

  assert.equal(result.ok, false);
  assert.equal(result.attempted, false, "nothing may be attempted against an unreadable journal");
  assert.equal(result.cancelled.length, 0);
  assert.equal(result.eligible, 0);
  assert.ok(result.blocked_reason, "the refusal must carry a reason, not throw");
  assert.match(result.blocked_reason, /could not be read/i);
  assert.match(result.blocked_reason, /NOTHING was attempted/i);
  assert.match(result.blocked_reason, /unchanged and still owned/i);
  assert.match(result.blocked_reason, /broker terminal/i);
  assert.equal(stack.manager.status().health.persistence, "unhealthy", "and the fault is recorded");
});

test("the sweep still reports a clean result when the journal IS readable", async () => {
  // Non-vacuity control: `eligible === 0` with no blocked_reason is the only legitimate
  // "there was nothing to cancel", and it must stay distinguishable from the refusal above.
  const stack = await liveStack();
  stack.persistence.loadNonterminal = async () => [];

  const result = await stack.manager.cancelWorkingBoxOrders();

  assert.equal(result.blocked_reason, null);
  assert.equal(result.attempted, true);
  assert.equal(result.eligible, 0);
  assert.deepEqual(result.failures, []);
});

/* ═══════════════════ 6. the manager itself refuses a reduction, having sent nothing ═══════════════════ */

test("an EXIT is refused and NOTHING is transmitted when the pre-POST durable write fails", async () => {
  // The fact the readiness verdict now reflects: the durable write precedes the broker POST for
  // EVERY purpose, so an outage means the order never leaves.
  //
  // A real box is entered first, so the reduction is backed by an attributed position and is
  // refused by the PERSISTENCE failure rather than by the quantity guard — otherwise this would
  // pass for the wrong reason.
  const stack = await liveStack({
    adapterOptions: { submit: async (req) => brokerOrderFor(req, req.quantity, "COMPLETE") },
  });
  const entry = await runEntry(stack);
  assert.equal(entry.ok, true, "fixture: a complete box must be open before it can be exited");
  const before = stack.adapter.posts.length;

  // PostgreSQL goes away AFTER the box is open.
  stack.persistence.create = async () => {
    throw new Error("Box persistence is unavailable; live order intent was not created.");
  };

  const leg = stack.candidate.legs.k1_ce;
  const error = await stack.manager.submit({
    client_order_id: "BOX:trade-live-1:EXIT:k1_ce:attempt-1",
    role: "k1_ce",
    trade_id: "trade-live-1",
    attempt_id: "exit-attempt-1",
    purpose: "EXIT",
    phase: "exit",
    exchange: "NFO",
    tradingsymbol: leg.tradingsymbol,
    token: leg.token,
    side: "SELL",
    quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 99.9 },
  }).then(() => null, (e) => e);

  assert.ok(error, "the reduction must be refused, not silently dropped");
  assert.match(String(error.message), /persistence is unavailable/i, "refused by the durable write");
  assert.equal(
    stack.adapter.posts.length, before,
    "NOT ONE broker request may be transmitted when the durable intent could not be written",
  );
  assert.equal(stack.manager.status().health.persistence, "unhealthy", "and the fault is recorded");
});

test("BoxOrderManager is the real class under test here", () => {
  // Guards against the suite silently exercising a stub if the harness changes.
  assert.equal(typeof BoxOrderManager, "function");
  assert.equal(typeof BoxOrderManager.prototype.cancelWorkingBoxOrders, "function");
});
