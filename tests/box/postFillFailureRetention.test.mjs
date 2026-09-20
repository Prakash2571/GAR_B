/**
 * FAILURES AFTER FOUR CONFIRMED ENTRY FILLS — the exposure must survive our own bookkeeping.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO DEFECTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Once all four legs report a confirmed cumulative fill, a complete four-leg position exists AT THE
 * BROKER. Two paths after that point could fail without recording it.
 *
 * (1) `simulateLeggingEntry` calls `args.qualify(evaluation, measured)` — a scanner-supplied callback
 *     that runs the final charge/economics calculation. There was no try/catch. A throw propagated
 *     out of the gateway with the four `BrokerOrder` snapshots held only in a local array, which was
 *     discarded: no failure record, so no durable attempt row and no `residual_exposure`; no
 *     `outcome_class`; no `invariantViolation`, so the breaker never tripped and new entry was never
 *     blocked. The scanner's catch then classified it as a technical fault, recorded
 *     `ENTRY_REJECTED_EXECUTION` with `exposure_existed: false`, and released the candidate —
 *     publishing a live four-leg position as an ordinary rejected candidate that never traded.
 *
 * (2) `finalizeOpen` persists the opened position. Both of its post-fill failure branches ended in
 *     `positions.release(cand.key)` after a `console.error`, with a comment admitting that
 *     "durable retry / residual-exposure adoption for this path is not built yet". So a filled box
 *     was handed back to the candidate pool with a log line as its only trace.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE REQUIRED BEHAVIOUR
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Preserve every confirmed fill and its broker identity; never report it as an ordinary rejected
 * candidate; never release exposure ownership as though nothing filled; make it operator-visible;
 * block new entry; retain or reconstruct the exposure for broker-authoritative reconciliation; and
 * state explicitly when durable storage cannot be confirmed. Do not blindly retry, and do not unwind
 * on an economic verdict that was never reached.
 *
 * Offline: real gateway → manager → adapter → durable persistence with a recording (fake) broker
 * transport, and the real scanner over the real position book.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxScanner } from "../../dist/box/scanner.js";
import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxMetrics } from "../../dist/box/metrics.js";
import { BoxPositionBook } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { BoxChargeEstimator } from "../../dist/box/charges.js";
import { ExecutionFaultLog } from "../../dist/box/executionFaults.js";
import { cfg, chargeStub, goodCandidate, localChargesStub, quotesFor } from "./helpers.mjs";
import { brokerOrderFor, entryPosts, liveStack, runEntry } from "./liveEntryHarness.mjs";

const LOTS = 75;
const unwindsOf = (adapter) => adapter.posts.filter((p) => p.purpose === "EMERGENCY_RESIDUAL");

/* ═════════════════ 1. QUALIFICATION THREW after 4/4 filled (live gateway) ═════════════════ */

async function filledThenQualifyThrows(message = "charge rate card unavailable") {
  const stack = await liveStack({
    adapterOptions: { submit: async (req) => brokerOrderFor(req, req.quantity, "COMPLETE") },
  });
  const result = await runEntry(stack, {
    qualify: () => { throw new Error(message); },
  });
  return { stack, result };
}

test("a qualification THROW after 4/4 fills does not escape the gateway", async () => {
  // The whole defect began with an exception crossing this boundary. If it escapes, every assertion
  // below is unreachable and the scanner classifies a live position as a technical fault.
  const { result } = await filledThenQualifyThrows();
  assert.equal(typeof result, "object", "the gateway must return a record, not throw");
  assert.equal(result.ok, false);
});

test("a qualification THROW after 4/4 fills is labelled FILLED_EXPOSURE_UNRECORDED, not a rejected candidate", async () => {
  const { stack, result } = await filledThenQualifyThrows();

  assert.equal(entryPosts(stack.adapter).length, 4, "fixture: all four legs really were transmitted");
  assert.equal(
    result.legging.outcome_class, "FILLED_EXPOSURE_UNRECORDED",
    "a filled-but-unrecorded box must have its own label",
  );
  assert.notEqual(result.legging.outcome_class, "NO_FILL");
  assert.notEqual(result.legging.outcome_class, "REFUSED_BEFORE_SUBMIT");
  assert.equal(result.legging.filled_leg_count, 4, "four legs filled, and the record says so");
  // The operator-facing detail must name the cause and the broker identities to check.
  assert.match(result.detail, /all four legs FILLED/);
  assert.match(result.detail, /charge rate card unavailable/, "the underlying cause is carried");
  assert.match(result.detail, /NOT unwound/);
  assert.match(result.detail, /broker_order_id=/, "broker identity is preserved for reconciliation");
});

test("a qualification THROW retains every confirmed fill as residual exposure, with broker identity", async () => {
  const { stack, result } = await filledThenQualifyThrows();

  const residual = result.legging.residual_exposure;
  assert.equal(residual.length, 4, "all four confirmed legs are retained as exposure");
  for (const leg of residual) {
    assert.equal(leg.quantity, LOTS, `${leg.role} retains its full confirmed quantity`);
    assert.ok(leg.average_price > 0, `${leg.role} carries a real acquisition price, never a fabricated 0`);
    assert.ok(Number.isFinite(leg.token) && leg.token > 0, `${leg.role} carries its instrument token`);
    assert.ok(typeof leg.tradingsymbol === "string" && leg.tradingsymbol.length > 0);
    assert.ok(["BUY", "SELL"].includes(leg.side));
  }
  assert.equal(new Set(residual.map((l) => l.role)).size, 4, "one residual per role");

  // BROKER IDENTITY. The durable intents are the authority a reconciler asks the broker about.
  const rows = [...stack.persistence.rows.values()].filter((r) => r.purpose === "ENTRY");
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.filled_quantity, LOTS, `${row.role} durable row keeps its confirmed fill`);
    assert.ok(row.broker_order_id, `${row.role} durable row keeps its broker order id`);
  }
});

test("a qualification THROW does NOT unwind — no economic verdict was ever reached", async () => {
  // The economics-abort branch may reverse the box because `qualify` RETURNED a verdict. A throw is
  // the absence of a verdict, so reversing would pay a four-leg round trip on a position that may
  // have been perfectly good. Retention is the correct conservative action.
  const { stack } = await filledThenQualifyThrows();
  assert.deepEqual(unwindsOf(stack.adapter), [], "nothing may be unwound on an unknown verdict");
  assert.equal(entryPosts(stack.adapter).length, 4, "and no leg is re-sent");
});

test("a qualification THROW BLOCKS NEW ENTRY and opens the breaker", async () => {
  const { stack } = await filledThenQualifyThrows();

  assert.equal(stack.manager.canEnter(), false, "new entry must be blocked while exposure is unrecorded");
  const blocked = String(stack.manager.entryBlockReason());
  assert.match(blocked, /recovery|breaker/i, `expected a recovery/breaker refusal, got: ${blocked}`);
  assert.equal(stack.manager.status().health.circuit, "open", "the circuit is open");
  assert.ok(
    stack.violations.some((v) => /final qualification THREW/i.test(v)),
    `the invariant names the cause, got ${JSON.stringify(stack.violations)}`,
  );
});

test("the retained exposure is what a RESTART would adopt, and it blocks entry after restart", async () => {
  // The breaker is process-local. What survives a restart is the residual projection, so a fresh
  // process seeded from it must also refuse entry — otherwise a restart buys a clean slate on top of
  // exposure that still exists at the broker.
  const { result } = await filledThenQualifyThrows();
  const residual = result.legging.residual_exposure;

  // `maxResidualLegs: 0` is the supervised one-box posture: ANY outstanding residual leg refuses new
  // entry. (The shared harness default is 10, which would let four retained legs through.)
  const restarted = await liveStack({ limitOverrides: { maxResidualLegs: 0 } });
  assert.equal(restarted.manager.canEnter(), true, "a fresh process starts clean");

  restarted.manager.setExposure({
    openBoxes: 0,
    residualLegs: residual.length,
    grossOpenLegQuantity: residual.reduce((total, leg) => total + leg.quantity, 0),
  });

  assert.equal(
    restarted.manager.canEnter(), false,
    "adopting the retained residual must refuse entry after a restart",
  );
  assert.match(String(restarted.manager.entryBlockReason()), /residual|exposure/i);
});

test("a qualification that RETURNS a negative verdict still unwinds — the fix is not a blanket retention", async () => {
  // Non-vacuity: the pre-existing FILLED_THEN_ECONOMICS_ABORT behaviour must be untouched, or these
  // tests would pass simply because nothing ever unwinds any more.
  const stack = await liveStack({
    adapterOptions: { submit: async (req) => brokerOrderFor(req, req.quantity, "COMPLETE") },
  });
  const result = await runEntry(stack, {
    qualify: () => ({ qualifies: false, expected_net_profit: 10, min_expected_net_profit: 1_200 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.legging.outcome_class, "FILLED_THEN_ECONOMICS_ABORT");
  assert.equal(result.legging.abort_after_fill, true);
  assert.equal(unwindsOf(stack.adapter).length, 4, "a real verdict still reverses all four legs");
});

/* ═════════════════ 2. POSITION PERSISTENCE FAILED after 4/4 filled (scanner) ═════════════════ */

/**
 * Real `BoxScanner` over the real `BoxPositionBook`, `ExecutionFaultLog` and execution gateway, with
 * the durable position insert as the injected fault.
 *
 * `finalizeOpen` is mode-independent — it is the same code for `paper_legging` and `live` — and the
 * live gateway/manager/adapter composition is exercised by the suite above, so the fault is injected
 * here at the `openPaperTrade` durable seam.
 */
function scannerHarness({ insert = async () => "trade-1" } = {}) {
  const { candidate, all } = goodCandidate();
  // The ATOMIC paper path (`simulateEntry`) fills synchronously and reaches `finalizeOpen` in the
  // same tick, so the durable-insert fault is injected without fighting order-lifecycle timers.
  // `finalizeOpen` and `retainUnrecordedFill` are the SAME code for every mode; the live
  // gateway/manager/adapter composition is covered by the suite above.
  const conf = cfg({});
  const quotes = new BoxQuoteStore();
  const positions = new BoxPositionBook();
  const metrics = new BoxMetrics(conf.metricsWindow);
  const faults = new ExecutionFaultLog(20);
  const attempts = [];
  const rejections = [];
  const violations = [];

  const executionSim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => true,
    isFeedHealthy: () => true,
    metrics,
  });
  const originalViolation = executionSim.invariantViolation?.bind(executionSim);
  executionSim.invariantViolation = (reason) => {
    violations.push(reason);
    originalViolation?.(reason);
  };

  const scanner = new BoxScanner({
    cfg: conf,
    quotes,
    charges: new BoxChargeEstimator(chargeStub({ entryTotal: 150, exitTotal: 150 }).fn, conf),
    localCharges: localChargesStub({ entryTotal: 150, exitTotal: 150 }),
    executionSim,
    positions,
    metrics,
    faults,
    activeBroker: () => "zerodha",
    openPaperTrade: insert,
    onExecutionAttempt: (cand, legging, reason, detail) => attempts.push({ key: cand.key, legging, reason, detail }),
    onEntryRejected: (rejection) => rejections.push(rejection),
    onEvent: () => {},
  });

  scanner.setCandidatesForUnderlying("NIFTY", all);
  scanner.setMarketOpen(true);
  scanner.setFeedHealthy(true);
  scanner.setDiscovering(true);

  const seed = () => {
    const now = Date.now();
    const map = quotesFor(candidate, {}, { at: now });
    for (const [token, q] of map) {
      quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], now);
    }
  };

  return { scanner, quotes, positions, faults, attempts, rejections, violations, candidate, seed };
}

/** Drive one entry attempt through the real scanner and let its async work settle. */
async function runScannerEntry(h) {
  h.seed();
  h.scanner.onTokensUpdated([h.candidate.legs.k1_ce.token]);
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("a failed position insert after 4/4 fills does NOT release exposure ownership", async () => {
  // THE CORE OF DEFECT (2). Releasing the key hands the underlying back to the candidate pool while
  // a filled position exists, so the next tick can enter again on top of it.
  const h = scannerHarness({ insert: async () => null });
  await runScannerEntry(h);

  assert.ok(
    h.positions.isTaken(h.candidate.key),
    "the candidate key must stay reserved: exposure exists and nothing else owns it",
  );
  assert.equal(h.positions.getByKey(h.candidate.key), undefined, "fixture: no position row was created");
});

test("a failed position insert records the exposure as FILLED_EXPOSURE_UNRECORDED with residual legs", async () => {
  const h = scannerHarness({ insert: async () => null });
  await runScannerEntry(h);

  // The retained exposure is named in the operator-facing detail, per role, side, quantity and
  // price — reconstructed from the evaluation on the atomic path and from the broker legs on the
  // legging path.
  const alert = h.rejections.at(-1);
  assert.ok(alert, "an operator alert must be raised");
  assert.equal(alert.reason, "filled_exposure_unrecorded");
  for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) {
    assert.match(alert.detail, new RegExp(role), `${role} is named in the retained exposure`);
  }
  assert.match(alert.detail, /@ \d/, "each retained leg carries an acquisition price");
});

test("a failed position insert BLOCKS NEW ENTRY and names the limitation honestly", async () => {
  const h = scannerHarness({ insert: async () => null });
  await runScannerEntry(h);

  assert.ok(
    h.violations.some((v) => /LOST FILL/.test(v)),
    `entry must be blocked via an invariant violation, got ${JSON.stringify(h.violations)}`,
  );

  assert.equal(h.rejections.length >= 1, true, "the operator alert surface is used");
  const alert = h.rejections.at(-1);
  assert.equal(
    alert.reason, "filled_exposure_unrecorded",
    "it must not be reported under a generic or market reason",
  );
  // DO NOT CLAIM THE EXPOSURE WAS SAFELY PERSISTED.
  assert.match(alert.detail, /could NOT be confirmed/, "the durable-storage limitation is explicit");
  assert.match(alert.detail, /NOT\s+unwound/);
  assert.match(alert.detail, /verify the legs at the broker/i);
});

test("a failed position insert logs a fault that asserts exposure DID exist", async () => {
  // The generic catch reports `exposure_existed: positions.getByKey(key) !== undefined`, which is
  // false for exactly this case — the fault log itself used to deny the exposure.
  const h = scannerHarness({ insert: async () => null });
  await runScannerEntry(h);

  const entries = h.faults.recent();
  const lost = entries.find((e) => /LOST FILL/.test(e.message ?? ""));
  assert.ok(lost, `expected a fault entry for the lost fill, got ${JSON.stringify(entries)}`);
  assert.equal(lost.exposure_existed, true, "the fault log must not deny exposure that exists");
  assert.equal(lost.stage, "trade_persistence");
});

test("a SUCCESSFUL insert is unaffected — ownership transfers to the position, entry stays open", async () => {
  // Non-vacuity control for the whole section.
  const h = scannerHarness({ insert: async () => "trade-ok-1" });
  await runScannerEntry(h);

  assert.deepEqual(h.violations, [], "a normal open raises no invariant");
  assert.ok(
    !h.rejections.some((r) => r.reason === "filled_exposure_unrecorded"),
    "and no lost-fill alert is raised",
  );
});
