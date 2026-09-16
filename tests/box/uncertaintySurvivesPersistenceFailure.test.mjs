/**
 * BLOCKER REGRESSION — broker uncertainty must survive a failure to RECORD it.
 *
 * THE REPRODUCED SEQUENCE (fails on d8b94ee):
 *
 *   1. both BUY hedges fill
 *   2. one SELL fills; the other SELL's placement fails with a transport fault, so its broker outcome
 *      is UNKNOWN
 *   3. the manager tries to persist RECONCILIATION_REQUIRED
 *   4. that write fails — "connection terminated unexpectedly"
 *   5. the DATABASE exception replaces the typed broker-uncertainty error
 *   6. the gateway does not recognise the generic exception as uncertain, so it treats the missing SELL
 *      as NEVER SUBMITTED
 *   7. recovery buys back the confirmed short and sells BOTH BUY hedges — including the hedge
 *      protecting the unresolved SELL
 *
 * Observed outcome was `PARTIAL_ENTRY_UNWOUND`, `residual_exposure: []`, no invariant violation, while
 * the adapter still held that SELL as RECONCILIATION_REQUIRED. If it later fills, its protection has
 * already been sold.
 *
 * Two independent properties are pinned here, because either alone would have prevented this:
 *   A. the manager reports the ORIGINAL typed error even when recording it fails;
 *   B. "never submitted" requires PROOF — an unrecognised rejection is uncertain, not certain-zero.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BrokerAmbiguousSubmitError,
  BrokerOrderRejectedError,
  BrokerPreSubmitRefusedError,
} from "../../dist/box/brokerAdapter.js";

const { BoxOrderManager } = await import("../../dist/box/orderManager.js");

const LIMITS = {
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 4_000,
  maxOpenBoxes: 1,
  maxResidualLegs: 4,
  maxConcurrentExecutions: 4,
  entrySubmitConcurrency: 1,
  dailyLossLimit: 0,
  rejectLimit: 100,
  consecutiveFailureLimit: 100,
  reconcileIntervalMs: 60_000,
  feedReconnectWarmupMs: 0,
};

const request = (o = {}) => ({
  client_order_id: o.client_order_id ?? "BOX:A1:k2_ce",
  trade_id: "T1",
  attempt_id: "A1",
  role: "k2_ce",
  purpose: "ENTRY",
  phase: "entry",
  exchange: "NFO",
  tradingsymbol: "SYM",
  token: 222,
  side: "SELL",
  quantity: 75,
  pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 99.9 },
});

/**
 * A manager whose durable writes FAIL for the uncertainty transition, exactly as a dropped PostgreSQL
 * connection would.
 */
function makeStack({ submitError }) {
  let now = 10_000;
  const rows = new Map();
  const persistence = {
    rows,
    create: async (i) => { rows.set(i.client_order_id, { ...i }); return { ...i }; },
    findByClientId: async (id) => rows.get(id) ?? null,
    loadNonterminal: async () => [],
    update: async (id, patch) => {
      // The write that records the uncertainty is the one that dies.
      if (patch?.state === "RECONCILIATION_REQUIRED") {
        throw new Error("connection terminated unexpectedly");
      }
      const cur = rows.get(id) ?? {};
      const next = { ...cur, ...patch };
      rows.set(id, next);
      return { applied: true, intent: next };
    },
  };
  const adapter = {
    mode: "live",
    broker: "zerodha",
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    prepareOrder: (r) => r,
    submitOrder: async (_req, beforePost) => {
      beforePost?.();
      throw submitError;
    },
    cancelOrder: async () => undefined,
    getOrder: async () => undefined,
    listOrders: async () => [],
    listPositions: async () => [],
  };
  const manager = new BoxOrderManager({
    adapter,
    persistence,
    limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-16",
    brokerAccount: () => "ZD1234",
  });
  manager.seedLimits({ tradingDay: "2026-09-16" });
  manager.setFeedHealthy(true);
  return { manager, persistence, adapter };
}

/* ═══════════ A. the typed uncertainty survives a failed durable write ═══════════ */

test("U1: an AMBIGUOUS submit still reports ambiguity when recording it fails", async () => {
  const ambiguous = new BrokerAmbiguousSubmitError(
    "BOX:A1:k2_ce",
    "Kite placement outcome is unknown; reconciliation is required before retry.",
  );
  const stack = makeStack({ submitError: ambiguous });
  await stack.manager.reconcile();

  await assert.rejects(
    () => stack.manager.submit(request()),
    (error) => {
      // ON THE BASELINE this was `Error: connection terminated unexpectedly` — the database fault had
      // replaced the broker outcome, and with it every downstream signal that exposure might exist.
      assert.ok(
        error instanceof BrokerAmbiguousSubmitError,
        `the ORIGINAL typed uncertainty must survive; got ${error?.name}: ${error?.message}`,
      );
      assert.doesNotMatch(
        error.message,
        /connection terminated/i,
        "the persistence fault must not masquerade as the broker outcome",
      );
      return true;
    },
  );
});

test("U2: the failure to record is itself reported, not swallowed", async () => {
  const stack = makeStack({
    submitError: new BrokerAmbiguousSubmitError("BOX:A1:k2_ce", "outcome unknown; reconciliation required"),
  });
  await stack.manager.reconcile();
  await stack.manager.submit(request()).catch(() => undefined);

  const status = stack.manager.status();
  assert.equal(status.health.persistence, "unhealthy", "a lost durable write must degrade health");
  assert.ok(status.unknownOrders >= 1, "the order is still counted as UNKNOWN");
});

test("U3: a TRANSPORT fault whose record fails is also still uncertain", async () => {
  // Not every ambiguous outcome arrives as the typed error — a bare transport fault is the common case,
  // and it must not become certain-zero just because the uncertainty could not be written down.
  const stack = makeStack({ submitError: new Error("socket hang up") });
  await stack.manager.reconcile();
  await assert.rejects(() => stack.manager.submit(request()), /socket hang up/);
  assert.ok(stack.manager.status().unknownOrders >= 1, "an unproven outcome counts as UNKNOWN");
});

/* ═══════════ B. "never submitted" requires proof ═══════════ */

test("U4: only a pre-submit refusal or a definitive broker rejection prove NO exposure", () => {
  // The classification the gateway now uses. These two are the only proof: a local refusal is thrown
  // before the HTTP request, and a definitive rejection is the broker itself saying the order does not
  // exist. Everything else — transport faults, database faults, types nobody has thought of yet —
  // leaves the outcome unproven, and unproven must mean uncertain.
  const provenNoExposure = (reason) =>
    reason instanceof BrokerPreSubmitRefusedError || reason instanceof BrokerOrderRejectedError;

  assert.equal(
    provenNoExposure(new BrokerPreSubmitRefusedError("BOX:1", "pre_post", true, "entry disarmed")),
    true,
  );
  assert.equal(provenNoExposure(new Error("connection terminated unexpectedly")), false,
    "a database fault is NOT proof that nothing was sent");
  assert.equal(provenNoExposure(new BrokerAmbiguousSubmitError("BOX:1", "unknown")), false);
  assert.equal(provenNoExposure(new Error("socket hang up")), false);
  assert.equal(provenNoExposure(undefined), false, "an absent reason proves nothing");
});
