/**
 * BOUNDED RECOVERY ESCALATION — an alert, never an instruction.
 *
 * ── WHAT THIS DOES AND DOES NOT ADD ──────────────────────────────────────────────────────────
 *
 * Every condition treated here as unresolved recovery ALREADY blocks new entry, in the authoritative
 * place — `BoxOrderManager.entryBlockReasonAfterControls`, reached only under `purpose === "ENTRY"`:
 * incomplete reconciliation, unknown orders, unattended working orders, active recovery, the
 * crash-recovery quarantine, and residual legs over the configured limit.
 *
 * So escalation adds NO new enforcement, deliberately. Two gates for one condition can disagree, and
 * an operator then cannot tell which is in force. What it adds is the distinction between "recovery is
 * in progress" and "recovery has been stuck longer than the operator said was acceptable", plus the
 * bounded numbers behind that — and a test below asserts the underlying enforcement still exists
 * independently, so the escalation can never be mistaken FOR the enforcement.
 *
 * Nothing here flattens, cancels or reverses anything because a timer expired.
 *
 * ── TIME ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Every case injects `nowWall` explicitly; there are no sleeps and no reliance on a real clock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_ESCALATION_ATTEMPT_SAMPLE,
  RECOVERY_ESCALATION_TIMEOUT,
  deriveRecoveryEscalation,
  recoveryEscalationBlocker,
} from "../../dist/box/recoveryEscalation.js";

const src = (rel) => readFileSync(new URL(`../../src/box/${rel}`, import.meta.url), "utf8");

const T0 = 1_700_000_000_000;
const THRESHOLD = 120_000;

/** Nothing unresolved. Each case turns on exactly what it is about. */
const clear = (over = {}) => ({
  nowWall: T0,
  escalateAfterMs: THRESHOLD,
  oldestResidualCreatedAtWall: null,
  firstObservedUnresolvedAtWall: null,
  residualLegCount: 0,
  unknownOrderCount: 0,
  unattendedWorkingOrderCount: 0,
  reconciliationComplete: true,
  recoveryActive: false,
  crashRecoveryQuarantined: false,
  residualStateUnknown: false,
  residualAttemptIds: [],
  ...over,
});

/* ══════════════════ 1-2. below and above the threshold ══════════════════ */

test("unresolved recovery BELOW the threshold does not escalate", () => {
  const e = deriveRecoveryEscalation(clear({
    residualLegCount: 2,
    oldestResidualCreatedAtWall: T0 - (THRESHOLD - 1),
    residualAttemptIds: ["attempt-1"],
  }));
  assert.equal(e.unresolved, true, "the condition is still reported well before the threshold");
  assert.equal(e.escalated, false);
  assert.equal(e.reason, null);
  assert.equal(recoveryEscalationBlocker(e), null, "no blocker below the threshold");
  assert.equal(e.oldestRecoveryAgeMs, THRESHOLD - 1, "the age is reported regardless");
});

test("reaching the threshold escalates, and the boundary is inclusive", () => {
  const exactly = deriveRecoveryEscalation(clear({
    residualLegCount: 1,
    oldestResidualCreatedAtWall: T0 - THRESHOLD,
    residualAttemptIds: ["attempt-1"],
  }));
  assert.equal(exactly.escalated, true, "at exactly the threshold, escalated");
  assert.equal(exactly.reason, RECOVERY_ESCALATION_TIMEOUT);

  const blocker = recoveryEscalationBlocker(exactly);
  assert.ok(blocker, "an escalation must be visible on the status surface");
  assert.equal(blocker.code, RECOVERY_ESCALATION_TIMEOUT, "a precise reason, not a vague not_ready");
  assert.equal(blocker.scope, "entry");
  assert.match(blocker.detail, /120s/, "the age must be legible to an operator");
  assert.match(blocker.detail, /ALERT, not an instruction/, "and must not read as authority to flatten");
  assert.match(blocker.detail, /survives a restart/, "and must state its own restart semantics");
});

test("`0` disables escalation without hiding the unresolved condition", () => {
  const e = deriveRecoveryEscalation(clear({
    escalateAfterMs: 0,
    residualLegCount: 3,
    oldestResidualCreatedAtWall: T0 - 10 * THRESHOLD,
    residualAttemptIds: ["a"],
  }));
  assert.equal(e.escalated, false, "0 disables the escalation");
  assert.equal(e.unresolved, true, "...but the condition is still reported");
  assert.equal(e.unresolvedResidualLegCount, 3);
  assert.equal(recoveryEscalationBlocker(e), null);
});

/* ══════════════════ 3. escalation adds NO new entry enforcement ══════════════════ */

/**
 * The refusal is already happening for the underlying state. This asserts that independently, so the
 * escalation cannot be mistaken for the thing that stops an order — the §3 lesson, applied here.
 */
test("the underlying recovery states already block ENTRY in the authoritative path", () => {
  const om = src("orderManager.ts");
  const start = om.indexOf("private entryBlockReasonAfterControls");
  const end = om.indexOf("MAY THIS PROCESS REDUCE EXPOSURE IT ALREADY OWNS?");
  assert.ok(start > 0 && end > start, "fixture: the ENTRY admission function must be locatable");
  const body = om.slice(start, end);

  for (const [what, needle] of [
    ["incomplete reconciliation", "!this.health.reconciliation_complete"],
    ["unknown orders", "this.unknownOrders > 0"],
    ["unattended working orders", "this.unattendedWorkingOrders > 0"],
    ["active recovery", "this.recoveryActive"],
    ["crash-recovery quarantine", "this.isCrashRecoveryEntryQuarantined()"],
    ["residual legs over the limit", "this.residualLegs > this.deps.limits.maxResidualLegs"],
  ]) {
    assert.ok(body.includes(needle), `${what} must already refuse ENTRY independently of escalation`);
  }

  // And escalation must NOT have added itself as a second, competing entry gate.
  assert.ok(
    !om.includes(RECOVERY_ESCALATION_TIMEOUT) && !om.includes("deriveRecoveryEscalation"),
    "escalation must not become a second entry gate — one condition, one enforcement point",
  );
});

/* ══════════════════ 4-7. reduction and reconciliation are untouched ══════════════════ */

test("the escalation blocker is entry-scoped, so it cannot reach the reduction verdict", () => {
  const escalated = deriveRecoveryEscalation(clear({
    residualLegCount: 4,
    oldestResidualCreatedAtWall: T0 - 5 * THRESHOLD,
    unknownOrderCount: 2,
    reconciliationComplete: false,
    residualAttemptIds: ["a", "b"],
  }));
  const blocker = recoveryEscalationBlocker(escalated);
  assert.equal(blocker.scope, "entry", "never 'reduction' and never 'both'");
  // The detail must say so too, because an operator reading only the message must not conclude that
  // exits have stopped.
  assert.match(blocker.detail, /exits, protective\s+cancels, emergency residual flattening, reconciliation and broker-state refresh all continue/i);
});

/**
 * Structural, and stronger than naming three purposes: the module is consumed only by the engine's
 * readiness composition, so no reduction path can reach it at all.
 */
test("nothing on a reduction path consumes the escalation module", () => {
  const om = src("orderManager.ts");
  const start = om.indexOf("canManageExposure(): boolean {");
  const reasonFn = om.indexOf("exposureReductionBlockReason(): string | null {");
  assert.ok(start > 0 && reasonFn > start, "fixture: both reduction predicates must be locatable");
  const after = om.slice(reasonFn);
  const reductionBody = om.slice(start, reasonFn) + after.slice(0, after.indexOf("\n  }\n"));
  for (const token of ["recoveryEscalation", "deriveRecoveryEscalation", RECOVERY_ESCALATION_TIMEOUT]) {
    assert.ok(!reductionBody.includes(token), `a reduction must not depend on ${token}`);
  }

  // The escalation module itself must contain no ability to act — it returns data, never an order.
  const mod = src("recoveryEscalation.ts");
  for (const token of ["submitOrder", "cancelOrder", "flatten", "unwind"]) {
    assert.ok(!new RegExp(`\\b${token}\\s*\\(`).test(mod), `escalation must not call ${token}()`);
  }
  assert.ok(!/\basync\b|\bawait\b/.test(mod), "it must stay pure and synchronous");
});

/* ══════════════════ 8. resolution clears escalation, with no latch ══════════════════ */

test("clearing recovery clears escalation, the age and the diagnostics in one pass", () => {
  // Escalated...
  const escalated = deriveRecoveryEscalation(clear({
    residualLegCount: 2,
    oldestResidualCreatedAtWall: T0 - 10 * THRESHOLD,
    residualAttemptIds: ["a"],
  }));
  assert.equal(escalated.escalated, true);

  // ...then resolved. Because the view is DERIVED rather than stored, there is no latch to clear.
  const resolved = deriveRecoveryEscalation(clear({ nowWall: T0 + 10 * THRESHOLD }));
  assert.equal(resolved.unresolved, false);
  assert.equal(resolved.escalated, false);
  assert.equal(resolved.oldestRecoveryAgeMs, null, "the age clears with the condition");
  assert.equal(resolved.ageSource, "none");
  assert.equal(resolved.unresolvedRecoveryCount, 0);
  assert.deepEqual(resolved.sampleAttemptIds, []);
  assert.equal(recoveryEscalationBlocker(resolved), null, "no sticky escalation after resolution");
});

/* ══════════════════ 9-10. counts and age ══════════════════ */

test("the unresolved count counts CONDITIONS, and every one is detected", () => {
  assert.equal(deriveRecoveryEscalation(clear()).unresolvedRecoveryCount, 0);
  const each = [
    { residualLegCount: 1 },
    { unknownOrderCount: 1 },
    { unattendedWorkingOrderCount: 1 },
    { reconciliationComplete: false },
    { recoveryActive: true },
    { crashRecoveryQuarantined: true },
    { residualStateUnknown: true },
  ];
  for (const one of each) {
    const e = deriveRecoveryEscalation(clear(one));
    assert.equal(e.unresolvedRecoveryCount, 1, `${JSON.stringify(one)} must count as one condition`);
    assert.equal(e.unresolved, true);
  }
  // All seven at once: a count of conditions, not a sum of orders.
  const all = deriveRecoveryEscalation(clear({
    residualLegCount: 9, unknownOrderCount: 7, unattendedWorkingOrderCount: 3,
    reconciliationComplete: false, recoveryActive: true, crashRecoveryQuarantined: true,
    residualStateUnknown: true, firstObservedUnresolvedAtWall: T0 - 1_000,
  }));
  assert.equal(all.unresolvedRecoveryCount, 7);
  assert.equal(all.unresolvedResidualLegCount, 9, "leg count is reported separately from the condition count");
  assert.equal(all.unknownOrderCount, 7);
  assert.equal(all.reconciliationRequired, true);
});

test("the durable residual stamp is preferred over the process-local mark", () => {
  /*
   * The process-local mark can only ever be LATER than the true start (it begins when this process
   * first looked), so the durable stamp wins even when the mark is more recent. Reporting the mark
   * would understate how long recovery has actually been stuck.
   */
  const e = deriveRecoveryEscalation(clear({
    residualLegCount: 1,
    oldestResidualCreatedAtWall: T0 - 600_000,
    firstObservedUnresolvedAtWall: T0 - 5_000,
    residualAttemptIds: ["a"],
  }));
  assert.equal(e.ageSource, "durable_residual_created_at");
  assert.equal(e.oldestRecoveryAgeMs, 600_000, "the true age, not the age since this process started");
});

test("with no residual, age falls back to the process-local mark and SAYS SO", () => {
  const e = deriveRecoveryEscalation(clear({
    unknownOrderCount: 2,
    firstObservedUnresolvedAtWall: T0 - 300_000,
  }));
  assert.equal(e.ageSource, "process_local_first_observed", "the weaker source must be named, not blurred");
  assert.equal(e.oldestRecoveryAgeMs, 300_000);
  const blocker = recoveryEscalationBlocker(e);
  assert.match(blocker.detail, /RESET at the last restart/, "the operator must be told it resets");
});

test("an unresolved condition with NO age source cannot escalate on a guess", () => {
  // Nothing durable and no mark yet (the very first observation pass).
  const e = deriveRecoveryEscalation(clear({ unknownOrderCount: 1 }));
  assert.equal(e.unresolved, true);
  assert.equal(e.oldestRecoveryAgeMs, null);
  assert.equal(e.ageSource, "none");
  assert.equal(e.escalated, false, "no age means no escalation — never a fabricated one");
});

test("a clock that moves backwards cannot produce a negative age", () => {
  const e = deriveRecoveryEscalation(clear({
    residualLegCount: 1,
    oldestResidualCreatedAtWall: T0 + 60_000, // stamp in the future (clock stepped back)
    residualAttemptIds: ["a"],
  }));
  assert.equal(e.oldestRecoveryAgeMs, 0, "floored at zero rather than reported as negative");
  assert.equal(e.escalated, false);
});

/* ══════════════════ 11. bounded ══════════════════ */

test("attempt identifiers are capped, de-duplicated and deterministic", () => {
  const many = Array.from({ length: 500 }, (_, i) => `attempt-${String(i).padStart(3, "0")}`);
  const e = deriveRecoveryEscalation(clear({
    residualLegCount: 500,
    oldestResidualCreatedAtWall: T0 - 10 * THRESHOLD,
    residualAttemptIds: [...many, ...many],
  }));
  assert.equal(e.sampleAttemptIds.length, MAX_ESCALATION_ATTEMPT_SAMPLE, "never the full set");
  assert.equal(MAX_ESCALATION_ATTEMPT_SAMPLE, 5);
  assert.deepEqual(
    [...e.sampleAttemptIds],
    ["attempt-000", "attempt-001", "attempt-002", "attempt-003", "attempt-004"],
    "sorted, so the sample is stable between reads rather than varying with map order",
  );
  // The blocker detail must stay bounded too — it is a status string, not a dump.
  const detail = recoveryEscalationBlocker(e).detail;
  assert.ok(detail.length < 1_200, `the detail must stay bounded, got ${detail.length} chars`);
  assert.ok(!detail.includes("attempt-005"), "only the capped sample may appear");
});

/* ══════════════════ 12. restart semantics, asserted rather than asserted-about ══════════════════ */

test("RESTART: a reloaded residual reports its ORIGINAL age, not zero", () => {
  /*
   * The durable stamp is what makes this true. A restarted process reloads the same residual with the
   * same `created_at`, so the age it reports is measured from when the exposure was recorded — not
   * from when the process came up. `firstObservedUnresolvedAtWall` is deliberately set to "just now",
   * exactly as a fresh process would have it, to prove the durable source wins.
   */
  const afterRestart = deriveRecoveryEscalation(clear({
    nowWall: T0 + 3_600_000,
    residualLegCount: 1,
    oldestResidualCreatedAtWall: T0,
    firstObservedUnresolvedAtWall: T0 + 3_600_000,
    residualAttemptIds: ["attempt-before-restart"],
  }));
  assert.equal(afterRestart.ageSource, "durable_residual_created_at");
  assert.equal(afterRestart.oldestRecoveryAgeMs, 3_600_000, "one hour of real unresolved time");
  assert.equal(afterRestart.escalated, true, "a restart must not silently de-escalate stuck recovery");
});

test("RESTART: the non-durable half resets, and the report admits it", () => {
  const afterRestart = deriveRecoveryEscalation(clear({
    nowWall: T0 + 3_600_000,
    unknownOrderCount: 1,
    firstObservedUnresolvedAtWall: T0 + 3_600_000, // this process just started
  }));
  assert.equal(afterRestart.oldestRecoveryAgeMs, 0, "the mark genuinely reset");
  assert.equal(afterRestart.escalated, false);
  assert.equal(
    afterRestart.ageSource,
    "process_local_first_observed",
    "the limitation is reported as a source label rather than dressed up as a real age",
  );
});

/* ══════════════════ the engine wiring ══════════════════ */

test("the engine derives escalation and starts/clears the mark in the same pass", () => {
  const engine = src("engine.ts");
  assert.match(engine, /const escalation = deriveRecoveryEscalation\(\{/);
  // The durable stamp is read from the residual map, not invented.
  assert.match(engine, /oldestResidualCreatedAtWall: this\.oldestResidualCreatedAtWall\(\)/);
  assert.match(engine, /private oldestResidualCreatedAtWall\(\): number \| null \{/);
  // One number of process-local state, set and cleared in the same pass that evaluated the conditions.
  assert.match(
    engine,
    /this\.recoveryUnresolvedSinceWall = escalation\.unresolved\s*\n?\s*\? \(this\.recoveryUnresolvedSinceWall \?\? this\.executionClock\.wall\(\)\)\s*\n?\s*: null;/,
  );
  assert.equal(
    engine.split("recoveryUnresolvedSinceWall").length - 1,
    4,
    "exactly one declaration and the read/write pair — no other state accumulates",
  );
});
