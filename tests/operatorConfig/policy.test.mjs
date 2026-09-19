/**
 * LIVE MUTATION SAFETY.
 *
 * The central asymmetry under test: while the system is armed, a risk limit may be made TIGHTER
 * immediately, and may not be made LOOSER at all. Widening requires the deployment to be flat and the
 * session disarmed, and the refusal must name every reason rather than returning a bare false.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { policy, baseState, spec } from "./_harness.mjs";

const { evaluateMutation, isFlat, isArmed, notFlatBlockers } = policy;

const blockerCodes = (d) => d.blockers.map((b) => b.code).sort();

/* ═════════════════ 1. Flatness is all five conditions ═════════════════ */

test("isFlat requires no exposure, nothing in flight and clean reconciliation", () => {
  assert.equal(isFlat(baseState()), true);
  assert.equal(isFlat(baseState({ openBoxes: 1 })), false);
  assert.equal(isFlat(baseState({ residualLegs: 1 })), false);
  assert.equal(isFlat(baseState({ workingOrders: 1 })), false);
  assert.equal(isFlat(baseState({ inFlightExecutions: 1 })), false);
  assert.equal(isFlat(baseState({ reconciliationClean: false })), false);
});

test("each non-flat condition produces its own named blocker", () => {
  const all = notFlatBlockers(
    baseState({
      openBoxes: 2,
      residualLegs: 1,
      workingOrders: 3,
      inFlightExecutions: 1,
      reconciliationClean: false,
    }),
  );
  assert.deepEqual(
    all.map((b) => b.code).sort(),
    ["in_flight_execution", "open_box", "reconciliation_pending", "residual_exposure", "working_orders"],
  );
});

test("armed means entry permission OR an armed session", () => {
  assert.equal(isArmed(baseState()), false);
  assert.equal(isArmed(baseState({ entryArmed: true })), true);
  assert.equal(isArmed(baseState({ sessionArmed: true })), true);
});

/* ═════════════════ 2. TIGHTEN_ONLY_WHILE_ARMED ═════════════════ */

test("tightening a ceiling while armed is allowed immediately", () => {
  const d = evaluateMutation({
    spec: spec("maxOpenBoxes"),
    current: 5,
    requested: 2,
    state: baseState({ entryArmed: true, sessionArmed: true, openBoxes: 1 }),
  });
  assert.equal(d.allowed, true);
  assert.equal(d.tightening, true);
  assert.equal(d.takesEffect, "next_candidate");
});

test("widening a ceiling while armed is REFUSED and says how to proceed", () => {
  const d = evaluateMutation({
    spec: spec("maxOpenBoxes"),
    current: 2,
    requested: 5,
    state: baseState({ entryArmed: true, openBoxes: 1 }),
  });
  assert.equal(d.allowed, false);
  assert.ok(blockerCodes(d).includes("widening_while_armed"));
  assert.ok(blockerCodes(d).includes("open_box"));
  assert.match(d.blockers[0].message, /disarm the session and flatten/i);
});

test("raising a threshold (safer) while armed is allowed; lowering it is refused", () => {
  const gate = spec("minExpectedNetProfit");
  const armed = baseState({ entryArmed: true });

  const up = evaluateMutation({ spec: gate, current: 1200, requested: 1500, state: armed });
  assert.equal(up.allowed, true);
  assert.equal(up.tightening, true);

  const down = evaluateMutation({ spec: gate, current: 1200, requested: 900, state: armed });
  assert.equal(down.allowed, false);
  assert.ok(blockerCodes(down).includes("widening_while_armed"));
});

test("widening the same setting while flat AND disarmed succeeds", () => {
  const d = evaluateMutation({
    spec: spec("maxOpenBoxes"),
    current: 2,
    requested: 5,
    state: baseState(),
  });
  assert.equal(d.allowed, true);
  assert.equal(d.tightening, false);
});

test("enabling a protection while armed is a tightening; disabling it is not", () => {
  const s = spec("oneActiveBoxPerUnderlying");
  const armed = baseState({ sessionArmed: true });

  assert.equal(evaluateMutation({ spec: s, current: false, requested: true, state: armed }).allowed, true);

  const off = evaluateMutation({ spec: s, current: true, requested: false, state: armed });
  assert.equal(off.allowed, false);
  assert.ok(blockerCodes(off).includes("widening_while_armed"));
});

/* ═════════════════ 3. FLAT_AND_DISARMED ═════════════════ */

test("a FLAT_AND_DISARMED setting is refused while armed even when TIGHTENING", () => {
  // The capital cap is dual-authority: admission reads it live but the send boundary uses a copy
  // captured when the order manager was built. Changing it under an armed session is refused in
  // BOTH directions, because the two layers would disagree mid-flight.
  const s = spec("liveMaxBoxCapitalRupees");
  assert.equal(s.policy, "FLAT_AND_DISARMED");
  const d = evaluateMutation({
    spec: s,
    current: 120_000,
    requested: 90_000, // strictly safer
    state: baseState({ entryArmed: true }),
  });
  assert.equal(d.allowed, false);
  assert.ok(blockerCodes(d).includes("session_armed"));
});

test("a FLAT_AND_DISARMED setting is refused while exposure exists, even when disarmed", () => {
  const d = evaluateMutation({
    spec: spec("liveMaxBoxCapitalRupees"),
    current: 120_000,
    requested: 150_000,
    state: baseState({ openBoxes: 1, residualLegs: 2 }),
  });
  assert.equal(d.allowed, false);
  assert.ok(blockerCodes(d).includes("open_box"));
  assert.ok(blockerCodes(d).includes("residual_exposure"));
});

test("a FLAT_AND_DISARMED setting succeeds when flat and disarmed", () => {
  const d = evaluateMutation({
    spec: spec("liveMaxBoxCapitalRupees"),
    current: 120_000,
    requested: 150_000,
    state: baseState(),
  });
  assert.equal(d.allowed, true);
  assert.equal(d.takesEffect, "immediately");
});

/* ═════════════════ 4. NEXT_SESSION never touches an armed snapshot ═════════════════ */

test("a session ceiling is storable while armed but reports `next_arm`", () => {
  for (const key of ["sessionMaxEntryAttempts", "sessionMaxCompletedTrades"]) {
    const s = spec(key);
    assert.equal(s.policy, "NEXT_SESSION");
    const d = evaluateMutation({
      spec: s,
      current: 1,
      requested: 5, // a WIDENING, deliberately
      state: baseState({ sessionArmed: true, entryArmed: true, openBoxes: 1 }),
    });
    // Accepted as a CONFIGURED value — and explicitly not applied to the armed session.
    assert.equal(d.allowed, true, `${key} was refused`);
    assert.equal(d.takesEffect, "next_arm", `${key} did not defer to the next arm`);
  }
});

/* ═════════════════ 5. Deployment bounds are refused, not clamped ═════════════════ */

test("raising past an explicit deployment ceiling is refused with a named blocker", () => {
  const d = evaluateMutation({
    spec: spec("maxOpenBoxes"),
    current: 2,
    requested: 8,
    state: baseState(),
    deploymentBound: 4,
  });
  assert.equal(d.allowed, false);
  assert.ok(blockerCodes(d).includes("deployment_bound"));
  assert.match(d.blockers.find((b) => b.code === "deployment_bound").message, /BOX_MAX_OPEN_BOXES/);
});

test("requesting `unlimited` past a finite deployment ceiling is refused", () => {
  const d = evaluateMutation({
    spec: spec("maxOpenBoxes"),
    current: 2,
    requested: 0, // unlimited
    state: baseState(),
    deploymentBound: 4,
  });
  assert.equal(d.allowed, false);
  assert.ok(blockerCodes(d).includes("deployment_bound"));
});

test("moving up to, but not past, the deployment ceiling is allowed", () => {
  const d = evaluateMutation({
    spec: spec("maxOpenBoxes"),
    current: 2,
    requested: 4,
    state: baseState(),
    deploymentBound: 4,
  });
  assert.equal(d.allowed, true);
});

/* ═════════════════ 6. Role ═════════════════ */

test("a widening change requires full admin; a tightening one does not", () => {
  const s = spec("maxOpenBoxes");
  const trade = baseState({ operatorRole: "trade" });

  const widen = evaluateMutation({ spec: s, current: 2, requested: 5, state: trade });
  assert.equal(widen.allowed, false);
  assert.ok(blockerCodes(widen).includes("full_admin_required"));

  const tighten = evaluateMutation({ spec: s, current: 5, requested: 2, state: trade });
  assert.equal(tighten.allowed, true);
});

/* ═════════════════ 7. Mode-specific refusals ═════════════════ */

test("the fault-injecting paper profile can never be selected in live", () => {
  const s = spec("paperExecutionProfile");
  const d = evaluateMutation({
    spec: s,
    current: "standard",
    requested: "stress",
    state: baseState({ executionMode: "live" }),
  });
  assert.equal(d.allowed, false);
  assert.ok(blockerCodes(d).includes("forbidden_in_live"));
});

test("the same profile is selectable in paper", () => {
  const d = evaluateMutation({
    spec: spec("paperExecutionProfile"),
    current: "standard",
    requested: "stress",
    state: baseState({ executionMode: "paper_latency" }),
  });
  assert.equal(d.allowed, true);
});

/* ═════════════════ 8. No-op changes ═════════════════ */

test("a no-op is allowed and is not reported as a tightening", () => {
  const d = evaluateMutation({
    spec: spec("maxOpenBoxes"),
    current: 3,
    requested: 3,
    state: baseState({ entryArmed: true }),
  });
  assert.equal(d.allowed, true);
  assert.equal(d.tightening, false);
});
