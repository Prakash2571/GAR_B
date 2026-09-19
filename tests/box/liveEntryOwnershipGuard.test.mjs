/**
 * DEFECT 1 — THE OWNERSHIP / "STILL WANTED" GUARD WAS NEVER WIRED INTO LIVE ENTRY.
 *
 * The coordinator composes an ownership-aware `stillWanted` (its own reservation-lease check folded
 * together with the caller's predicate) and passes it to the gateway. The live branch of
 * `simulateLeggingEntry` ignored it; only the PAPER simulator consulted it. So in live mode a Box
 * whose lease had been lost, whose scanner decision had gone stale, or whose entry had been
 * disarmed while its legs sat in broker pacing, still POSTed every leg.
 *
 * Every test below asserts on `adapter.posts`, which the recording adapter appends to ONLY after
 * the pre-POST callback has returned without throwing — i.e. exactly where the real HTTP request
 * would be issued. "Zero POSTs" is therefore a statement about broker mutations, not about
 * internal bookkeeping.
 *
 * The final group proves the guard is ENTRY-ONLY: the very same conditions must not impede an exit
 * or an emergency reduction, because those remove risk that is already on the book.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BrokerPreSubmitRefusedError } from "../../dist/box/brokerAdapter.js";
import {
  evaluateLiveEntryGuard,
  stillWantedSafely,
} from "../../dist/box/liveEntryGuard.js";
import { hasDurableLocalNoPostProvenance } from "../../dist/box/executionGateway.js";
import { entryPosts, liveStack, runEntry } from "./liveEntryHarness.mjs";

const allow = {
  stage: "pre_post",
  stillWanted: true,
  entryEnabled: true,
  liveOrderEntryEnabled: true,
  circuitClosed: true,
  entryAdmissible: true,
  attemptAborted: null,
  hedgeCoverageGap: null,
  crossLegCoherenceGap: null,
};

/* ── the pure decision ────────────────────────────────────────────────────────────────── */

test("the guard allows only when every condition holds", () => {
  assert.deepEqual(evaluateLiveEntryGuard(allow), { allowed: true });
});

test("each condition refuses with its own distinct cause", () => {
  const cases = [
    [{ stillWanted: false }, "not_still_wanted"],
    [{ liveOrderEntryEnabled: false }, "live_orders_disarmed"],
    [{ entryEnabled: false }, "entry_disarmed"],
    [{ circuitClosed: false }, "circuit_open"],
    [{ attemptAborted: "sibling k1_ce rejected" }, "attempt_aborted"],
    // INVERSION: a dependent SELL is refused when its hedge coverage is NOT PROVEN, not merely when
    // a hedge was named as failed. A non-null coverage gap is the specific unprovable-coverage
    // reason (here: a hedge that came back CANCELLED with zero fills — the exact case the old
    // failure-signal contract let through as a naked SELL).
    [{ hedgeCoverageGap: "hedge k2_ce not proven covered: confirmed 0 of required 75" }, "hedge_coverage_unproven"],
    // DEFECT C: the four books stopped being a usable simultaneous snapshot while the leg waited in
    // the queue and adapter pacing. Per-leg freshness cannot see this — each book is young, they are
    // young at four different instants.
    [{ crossLegCoherenceGap: "[receive_dispersion] receive-time dispersion 1000ms exceeds 500ms" }, "cross_leg_incoherent"],
    [{ entryAdmissible: false }, "entry_not_admissible"],
  ];
  for (const [override, refusal] of cases) {
    const decision = evaluateLiveEntryGuard({ ...allow, ...override });
    assert.equal(decision.allowed, false, JSON.stringify(override));
    assert.equal(decision.refusal, refusal);
    assert.match(decision.reason, /at pre_post/);
  }
});

test("ownership loss is reported ahead of every other simultaneous failure", () => {
  // Stable, most-fundamental-first reporting: an operator sees the condition that made the POST
  // unsafe, not whichever check happened to be written first.
  const decision = evaluateLiveEntryGuard({
    ...allow,
    stillWanted: false,
    entryEnabled: false,
    circuitClosed: false,
    entryAdmissible: false,
  });
  assert.equal(decision.refusal, "not_still_wanted");
});

test("a stillWanted predicate that throws is treated as a refusal, never as permission", () => {
  assert.equal(stillWantedSafely(() => { throw new Error("coordinator blew up"); }), false);
  assert.equal(stillWantedSafely(() => false), false);
  assert.equal(stillWantedSafely(() => true), true);
  // Absent predicate = no opinion from that layer.
  assert.equal(stillWantedSafely(undefined), true);
  // A non-boolean truthy value is not a proof of permission.
  assert.equal(stillWantedSafely(() => "yes"), false);
});

/* ── end-to-end: ZERO POSTs through the real stack ────────────────────────────────────── */

test("ownership lost BEFORE the attempt starts: no requests, no durable rows, no POSTs", async () => {
  const stack = await liveStack();
  const result = await runEntry(stack, { stillWanted: () => false });

  assert.equal(result.ok, false);
  assert.equal(result.legging.outcome_class, "REFUSED_BEFORE_SUBMIT");
  assert.deepEqual(stack.adapter.posts, []);
  // Refused before the first `manager.submit`, so not even a CREATED intent exists.
  assert.equal(stack.persistence.rows.size, 0);
  assert.match(result.detail, /no longer wanted/);
});

test("ownership lost DURING durable persistence: zero POSTs for the affected legs", async () => {
  // `stillWanted` is true while the gateway builds and enqueues, then flips during the manager's
  // CREATED → SUBMITTING writes. The post-persistence checkpoint is the one that must catch it.
  const stack = await liveStack();
  let allowed = true;
  const originalCreate = stack.persistence.create.bind(stack.persistence);
  stack.persistence.create = async (intent) => {
    const created = await originalCreate(intent);
    allowed = false; // the lease is lost the instant the first durable row lands
    return created;
  };

  const result = await runEntry(stack, { stillWanted: () => allowed });

  assert.equal(result.ok, false);
  assert.deepEqual(stack.adapter.posts, [], "no broker mutation may occur after ownership loss");
  // Durable rows exist and are terminalized as PROVEN LOCAL NO-POST.
  assert.ok(stack.persistence.rows.size > 0);
  for (const row of stack.persistence.rows.values()) {
    assert.equal(row.state, "REJECTED");
    assert.equal(row.filled_quantity, 0);
    assert.equal(row.broker_order_id, null);
    assert.ok(hasDurableLocalNoPostProvenance(row), `${row.client_order_id} carries no-POST provenance`);
  }
});

test("ownership lost while waiting in broker pacing: refused at the final boundary", async () => {
  // The hardest case, and the one the old code could not stop: the leg is durably SUBMITTING and is
  // sitting in adapter pacing when the lease expires. The refusal must happen inside the pre-POST
  // callback, before the HTTP request begins.
  let allowed = true;
  const stack = await liveStack({
    adapterOptions: { duringPacing: async () => { allowed = false; } },
  });

  const result = await runEntry(stack, { stillWanted: () => allowed });

  assert.equal(result.ok, false);
  assert.deepEqual(stack.adapter.posts, []);
  const rows = [...stack.persistence.rows.values()];
  assert.equal(rows.length, 4, "all four legs became durable before the refusal");
  const stages = [];
  for (const row of rows) {
    assert.ok(hasDurableLocalNoPostProvenance(row), `${row.role} terminalized without a POST`);
    const audit = row.audit.find((event) => event.payload?.origin === "local_pre_submit_refusal");
    stages.push(audit.payload.stage);
  }
  // The leg that was ALREADY IN PACING when the lease expired can only be caught at the final
  // boundary — that is the case the old code had no way to stop. Its siblings, still queued behind
  // it under concurrency 1, are caught earlier and more cheaply at dequeue. Both are proven no-POST.
  assert.ok(stages.includes("pre_post"), `expected a pre_post refusal, got ${stages.join(", ")}`);
  assert.ok(stages.every((stage) => ["dequeue", "post_persist", "pre_post"].includes(stage)));
});

test("entry DISARMED during pacing: zero POSTs", async () => {
  let stack;
  stack = await liveStack({
    adapterOptions: { duringPacing: async () => { stack.manager.setControls({ entryEnabled: false }); } },
  });

  const result = await runEntry(stack, { stillWanted: () => true });

  assert.equal(result.ok, false);
  assert.deepEqual(entryPosts(stack.adapter), []);
  for (const row of stack.persistence.rows.values()) {
    if (row.purpose !== "ENTRY") continue;
    assert.ok(hasDurableLocalNoPostProvenance(row));
  }
});

test("circuit breaker TRIPS during pacing: zero POSTs", async () => {
  let stack;
  stack = await liveStack({
    adapterOptions: {
      duringPacing: async () => { stack.manager.invariantViolation("synthetic breaker trip"); },
    },
  });

  const result = await runEntry(stack, { stillWanted: () => true });

  assert.equal(result.ok, false);
  assert.deepEqual(entryPosts(stack.adapter), []);
});

test("the scanner decision becomes unwanted during pacing: zero POSTs", async () => {
  let wanted = true;
  const stack = await liveStack({
    adapterOptions: { duringPacing: async () => { wanted = false; } },
  });

  const result = await runEntry(stack, { stillWanted: () => wanted });

  assert.equal(result.ok, false);
  assert.deepEqual(stack.adapter.posts, []);
});

test("a refusal is classified as neither a broker rejection nor ambiguous", async () => {
  let allowed = true;
  const stack = await liveStack({
    adapterOptions: { duringPacing: async () => { allowed = false; } },
  });

  const before = stack.manager.status();
  const result = await runEntry(stack, { stillWanted: () => allowed });
  const after = stack.manager.status();

  assert.equal(result.ok, false);
  assert.equal(after.rejects, before.rejects, "a local refusal is not a broker rejection");
  assert.equal(after.unknownOrders, before.unknownOrders, "a local refusal is not ambiguous");
  /*
   * UPDATED EXPECTATION (was `NO_FILL`).
   *
   * Both labels agree that nothing filled; they disagree about whether anything was SENT.
   * `NO_FILL` is a SUBMITTED failure to `executionFunnel` (`submittedFailureByReason.no_fill`),
   * whereas `REFUSED_BEFORE_SUBMIT` routes to `recordZeroPostRefusal`. Every leg here was refused by
   * a local authority before its POST — which the assertion below proves — so counting the attempt
   * as submitted inflated the submitted-attempt denominator and described a risk-control refusal as
   * a liquidity outcome.
   *
   * This test's stated point ("neither a broker rejection nor ambiguous") is unchanged and is
   * asserted by the two checks above; the label is now the third, correct alternative.
   */
  assert.equal(
    result.legging.outcome_class,
    "REFUSED_BEFORE_SUBMIT",
    "nothing was submitted at all, so this is a zero-POST refusal rather than a no-fill",
  );
  assert.deepEqual(stack.adapter.posts, [], "and the zero-POST claim is literally true");
  assert.deepEqual(result.legging.residual_exposure, []);
});

test("the refusal error itself proves no POST was attempted", async () => {
  let allowed = true;
  const errors = [];
  const stack = await liveStack({
    adapterOptions: { duringPacing: async () => { allowed = false; } },
  });
  const original = stack.manager.submit.bind(stack.manager);
  stack.manager.submit = (req, feed, capital, entry) =>
    original(req, feed, capital, entry).catch((error) => { errors.push(error); throw error; });

  const result = await runEntry(stack, { stillWanted: () => allowed });

  assert.equal(result.ok, false);
  assert.deepEqual(stack.adapter.posts, []);
  assert.equal(errors.length, 4, "every leg rejected with a refusal, not a broker error");
  for (const error of errors) {
    assert.ok(error instanceof BrokerPreSubmitRefusedError, `got ${error?.name}: ${error?.message}`);
    assert.equal(error.durableIdentitySpent, true);
    assert.match(error.message, /no longer wanted/);
  }
});

test("every guard refusal is counted, by checkpoint", async () => {
  let allowed = true;
  const stack = await liveStack({
    adapterOptions: { duringPacing: async () => { allowed = false; } },
  });
  await runEntry(stack, { stillWanted: () => allowed });

  const diagnostics = stack.manager.entryGuardDiagnostics();
  const refusals = Object.values(diagnostics).reduce((sum, count) => sum + count, 0);
  // One leg was in pacing (pre_post); the other three were still queued (dequeue). Four legs, four
  // refusals, zero POSTs — the exact split depends on concurrency, the total does not.
  assert.ok(diagnostics.pre_post >= 1, `expected a pre_post refusal, got ${JSON.stringify(diagnostics)}`);
  assert.ok(refusals >= 4, `expected at least four counted refusals, got ${JSON.stringify(diagnostics)}`);
});

/* ── the guard must NOT touch exits or reductions ─────────────────────────────────────── */

/**
 * Attribute real, owned exposure to the manager, so that a reduction has something to reduce.
 * `setAttributedBoxPositions` is the production seam the engine itself uses after reconciliation;
 * raw account positions are deliberately not accepted there.
 */
function ownFourLegs(stack, { quantity = 75 } = {}) {
  const legs = stack.candidate.legs;
  stack.manager.setAttributedBoxPositions([
    { exchange: "NFO", tradingsymbol: legs.k1_ce.tradingsymbol, net_quantity: quantity },
    { exchange: "NFO", tradingsymbol: legs.k2_ce.tradingsymbol, net_quantity: -quantity },
    { exchange: "NFO", tradingsymbol: legs.k2_pe.tradingsymbol, net_quantity: quantity },
    { exchange: "NFO", tradingsymbol: legs.k1_pe.tradingsymbol, net_quantity: -quantity },
  ]);
}

test("an EXIT is unaffected by ownership loss, disarmed entry and an open breaker", async () => {
  // THE NON-NEGOTIABLE RISK-REDUCTION RULE. None of the entry conditions is a reason to leave real
  // exposure on the book, so a reduction must proceed even when every one of them is against us.
  const stack = await liveStack();
  ownFourLegs(stack);
  stack.manager.setControls({ entryEnabled: false });
  stack.manager.invariantViolation("breaker open during exit");
  assert.equal(stack.manager.canEnter(), false, "entry really is closed");
  assert.equal(stack.manager.canManageExposure(), true, "reduction remains permitted");

  const exitRequest = {
    client_order_id: "BOX:trade-live-1:EXIT:k1_ce:exit-1",
    role: "k1_ce",
    trade_id: "trade-live-1",
    attempt_id: "exit-1",
    purpose: "EXIT",
    phase: "exit",
    exchange: "NFO",
    tradingsymbol: stack.candidate.legs.k1_ce.tradingsymbol,
    token: stack.candidate.legs.k1_ce.token,
    side: "SELL",
    quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 99.9 },
  };

  // No entry guard is supplied for a reduction — and even the ownership predicate is irrelevant
  // here, because the manager only ever consults one for `purpose === "ENTRY"`.
  const order = await stack.manager.submit(exitRequest);
  assert.equal(order.state, "COMPLETE");
  assert.equal(stack.adapter.posts.length, 1);
  assert.equal(stack.adapter.posts[0].purpose, "EXIT");
});

test("an EMERGENCY_RESIDUAL reduction proceeds while entry is fully locked down", async () => {
  const stack = await liveStack();
  ownFourLegs(stack);
  stack.manager.setControls({ entryEnabled: false });
  stack.manager.invariantViolation("breaker open during residual flatten");

  const flatten = {
    client_order_id: "BOX:trade-live-1:EMERGENCY_RESIDUAL:k2_pe:flat-1",
    role: "k2_pe",
    trade_id: "trade-live-1",
    attempt_id: "flat-1",
    purpose: "EMERGENCY_RESIDUAL",
    phase: "unwind",
    exchange: "NFO",
    tradingsymbol: stack.candidate.legs.k2_pe.tradingsymbol,
    token: stack.candidate.legs.k2_pe.token,
    side: "SELL",
    quantity: 40,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 5, limit_price: 99.9 },
  };

  const order = await stack.manager.submit(flatten);
  assert.equal(order.filled_quantity, 40);
  assert.equal(stack.adapter.posts.length, 1);
  assert.equal(stack.adapter.posts[0].purpose, "EMERGENCY_RESIDUAL");
  // And the guard was never even consulted on this path.
  assert.deepEqual(stack.manager.entryGuardDiagnostics(), {
    pre_build: 0, post_evidence: 0, pre_enqueue: 0, dequeue: 0, post_persist: 0, pre_post: 0,
  });
});

test("a reduction is not refused even when its own stillWanted-style predicate would say no", async () => {
  // Belt and braces: passing an entry-guard object on a NON-entry purpose must be ignored, so a
  // future caller cannot accidentally arm an entry-only gate against a reduction.
  const stack = await liveStack();
  ownFourLegs(stack);
  const order = await stack.manager.submit(
    {
      client_order_id: "BOX:trade-live-1:EXIT:k2_ce:exit-2",
      role: "k2_ce",
      trade_id: "trade-live-1",
      attempt_id: "exit-2",
      purpose: "EXIT",
      phase: "exit",
      exchange: "NFO",
      tradingsymbol: stack.candidate.legs.k2_ce.tradingsymbol,
      token: stack.candidate.legs.k2_ce.token,
      side: "BUY",
      quantity: 75,
      pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
    },
    undefined,
    undefined,
    { stillWanted: () => false, transportRank: 0, hedge: false, hedgeCount: 2 },
  );

  assert.equal(order.state, "COMPLETE");
  assert.equal(stack.adapter.posts.length, 1);
});
