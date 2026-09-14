/**
 * FUNDING READINESS — "evidence checks are disabled" must be a DIFFERENT, machine-readable fact
 * from "funding is verified".
 *
 * THE CONFIGURATION RISK. All four funding controls default OFF:
 *   BOX_LIVE_REQUIRE_FUNDS_COVER=false, BOX_LIVE_REQUIRE_MARGIN_EVIDENCE=false,
 *   BOX_LIVE_REQUIRE_STAGE_FUNDING=false, BOX_LIVE_RECOVERY_RESERVE_RUPEES=0.
 * With all three booleans off, `evaluateEntryEconomics` returns before reading any evidence and
 * `economicDiagnostics()` stays null forever. Null is honest but ambiguous, and two of the four
 * knobs were not even present on the effective-config surface an operator reviews before boot.
 *
 * WHAT IS ASSERTED HERE
 *   1. The five funding states are distinct, and `funding_verified` is true ONLY for `verified`.
 *   2. Stage funding's IMPLICATION of the funds/margin checks is reported, so no surface can claim
 *      the funds check is off while stage funding is running it.
 *   3. Disabled gates produce NO readiness blocker — the default-off configuration must be
 *      REPORTED, not silently converted into a trading stop.
 *   4. A refusal produces entry-scoped blockers, one per reason, and those blockers can never
 *      reach the reduction verdict.
 *   5. Broker evidence limitations are stated (Dhan cannot supply an INITIAL basket margin).
 *   6. All four funding knobs are on the deployment-review surface with the code defaults.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  brokerFundingLimitations,
  buildFundingReadiness,
  fundingReadinessBlockers,
} from "../../dist/box/fundingReadiness.js";
import { buildOperationalReadiness } from "../../dist/box/operationalReadiness.js";
import { resolveEffectiveConfig } from "../../dist/box/effectiveConfig.js";

const FRESHNESS = { funds_max_age_ms: 5_000, margin_max_age_ms: 5_000, read_timeout_ms: 2_500 };

/** A minimal admission report; only the fields funding readiness reads are populated. */
function report({ allowed, reasons = [] }) {
  return {
    allowed,
    reasons,
    detail: null,
    picture: {},
    controls: {
      gross_cap_enabled: false,
      funds_check_enabled: true,
      margin_evidence_required: true,
      stage_funding_required: true,
    },
    evaluated_at: 1_700_000_000_000,
    plan_fingerprint: "k1_ce|k2_ce|k2_pe|k1_pe",
    evidence_context: { broker: "zerodha", account_ref: "AB1234", session_id: "s-1" },
    read_elapsed_ms: { funds: 12, margin: 20 },
  };
}

const base = (overrides = {}) => buildFundingReadiness({
  live: true,
  requireFundsCover: false,
  requireMarginEvidence: false,
  requireStageFunding: false,
  recoveryReserveRupees: 0,
  freshness: FRESHNESS,
  report: null,
  ...overrides,
});

/* ═════════════════ 1. the five states are distinct ═════════════════ */

test("all gates OFF is `checks_disabled`, and that is NOT `funding_verified`", () => {
  const r = base();
  assert.equal(r.status, "checks_disabled");
  assert.equal(r.funding_verified, false, "nothing was read, so nothing may be claimed");
  assert.match(
    r.claim,
    /EVIDENCE CHECKS ARE DISABLED/,
    "the claim must say plainly that nothing is known, not imply an all-clear",
  );
  assert.match(r.claim, /NOT a statement that funding is sufficient/);
  assert.ok(
    r.limitations.some((l) => /gates are all disabled/i.test(l)),
    "the disabled state is a standing limitation an operator must see",
  );
});

test("a non-live deployment is `not_applicable`, not `verified`", () => {
  const r = base({ live: false, requireFundsCover: true });
  assert.equal(r.status, "not_applicable");
  assert.equal(r.funding_verified, false);
});

test("gates ON with no decision yet is `not_evaluated`, not `verified`", () => {
  const r = base({ requireFundsCover: true });
  assert.equal(r.status, "not_evaluated");
  assert.equal(r.funding_verified, false, "no entry has been judged, so funding is unproven");
  assert.equal(r.reasons.length, 0);
});

test("gates ON with an ADMITTED decision is `verified`", () => {
  const r = base({ requireStageFunding: true, report: report({ allowed: true }) });
  assert.equal(r.status, "verified");
  assert.equal(r.funding_verified, true);
  assert.equal(r.plan_fingerprint, "k1_ce|k2_ce|k2_pe|k1_pe", "the decision is bound to the order plan");
  assert.deepEqual(
    r.evidence_context,
    { broker: "zerodha", account_ref: "AB1234", session_id: "s-1" },
    "and to the broker account/session the evidence was read under",
  );
});

test("gates ON with a REFUSED decision is `refused`, carrying the reasons", () => {
  const r = base({
    requireStageFunding: true,
    report: report({ allowed: false, reasons: ["funding_stage_unknown", "insufficient_available_funds"] }),
  });
  assert.equal(r.status, "refused");
  assert.equal(r.funding_verified, false);
  assert.deepEqual(r.reasons, ["funding_stage_unknown", "insufficient_available_funds"]);
});

/* ═════════════════ 2. the stage-funding implication ═════════════════ */

test("stage funding IMPLIES the funds and margin checks, and says so explicitly", () => {
  const r = base({
    requireFundsCover: false,
    requireMarginEvidence: false,
    requireStageFunding: true,
  });
  // As CONFIGURED, both are off …
  assert.equal(r.gates.funds_cover_configured, false);
  assert.equal(r.gates.margin_evidence_configured, false);
  // … but EFFECTIVELY both run, because a per-stage requirement that is never compared against
  // money would be a gate in name only.
  assert.equal(r.gates.funds_cover_effective, true, "stage funding cannot skip the money comparison");
  assert.equal(r.gates.margin_evidence_effective, true, "stage funding needs the basket margin");
  assert.equal(r.gates.stage_funding_effective, true);
});

test("gross notional, margin and available funds stay distinct concerns in the reported reasons", () => {
  const r = base({
    requireFundsCover: true,
    report: report({ allowed: false, reasons: ["gross_notional_over_cap"] }),
  });
  const blockers = fundingReadinessBlockers(r);
  assert.equal(blockers.length, 1);
  assert.match(
    blockers[0].detail,
    /NOTIONAL limit, not a margin or available-funds check/,
    "a notional cap must never be described as a funding or margin proof",
  );
});

/* ═════════════════ 3. the recovery reserve is documented, never invented ═════════════════ */

test("a zero recovery reserve with gates ON is reported as a limitation, not silently accepted", () => {
  const r = base({ requireFundsCover: true, recoveryReserveRupees: 0 });
  assert.equal(r.recovery_reserve_rupees, 0);
  assert.ok(
    r.limitations.some((l) => /RECOVERY_RESERVE_RUPEES is 0/.test(l)),
    "the operator must be told no funds are held back for a recovery action",
  );
  // And no amount is invented on their behalf.
  assert.ok(
    !r.limitations.some((l) => /recommend|should be|use \u20b9?\d/i.test(l)),
    "no reserve amount may be recommended: only the operator can size it",
  );
});

test("a configured recovery reserve is reported and drops the limitation", () => {
  const r = base({ requireFundsCover: true, recoveryReserveRupees: 50_000 });
  assert.equal(r.recovery_reserve_rupees, 50_000);
  assert.ok(!r.limitations.some((l) => /RECOVERY_RESERVE_RUPEES is 0/.test(l)));
});

/* ═════════════════ 4. blockers: entry-only, and never for a disabled gate ═════════════════ */

test("DISABLED gates produce NO blocker — reporting a risk is not the same as halting trading", () => {
  assert.deepEqual(
    fundingReadinessBlockers(base()),
    [],
    "turning the default-off configuration into a trading stop would change a deployment's " +
      "controls rather than report on them",
  );
});

test("`verified` and `not_evaluated` produce no blocker", () => {
  assert.deepEqual(fundingReadinessBlockers(base({ requireFundsCover: true, report: report({ allowed: true }) })), []);
  assert.deepEqual(fundingReadinessBlockers(base({ requireFundsCover: true })), []);
});

test("a refusal produces ONE entry-scoped blocker per reason", () => {
  const r = base({
    requireStageFunding: true,
    report: report({ allowed: false, reasons: ["funding_stage_unknown", "margin_evidence_stale_or_missing"] }),
  });
  const blockers = fundingReadinessBlockers(r);
  assert.equal(blockers.length, 2);
  assert.deepEqual(blockers.map((b) => b.code), [
    "funding_funding_stage_unknown",
    "funding_margin_evidence_stale_or_missing",
  ]);
  for (const blocker of blockers) {
    assert.equal(blocker.scope, "entry", "a funding gate is ENTRY-ONLY and may never block a reduction");
    assert.match(blocker.detail, /exposure .*can still be exited, reduced and protectively cancelled/);
  }
});

test("a refusal with no enumerated reason still refuses, and says so", () => {
  const blockers = fundingReadinessBlockers(base({
    requireFundsCover: true,
    report: report({ allowed: false, reasons: [] }),
  }));
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "funding_refused_unspecified");
  assert.equal(blockers[0].scope, "entry");
});

test("INVARIANT: a funding blocker refuses ENTRY and leaves risk reduction permitted", () => {
  const funding = fundingReadinessBlockers(base({
    requireStageFunding: true,
    report: report({ allowed: false, reasons: ["insufficient_available_funds"] }),
  }));
  const decision = buildOperationalReadiness({
    now: 1_700_000_000_000,
    generation: 7,
    decisionGeneration: 1,
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
      lastFrameAt: 1_700_000_000_000 - 200,
      lastHeartbeatAt: 1_700_000_000_000 - 200,
      lastDepthAt: 1_700_000_000_000 - 300,
      backlog: false,
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
    blockers: funding,
    openExposure: { openPositions: 1, residualLegs: 0, workingOrders: 0 },
  });

  assert.equal(decision.entry.permitted, false, "entry is refused on funding grounds");
  assert.ok(
    decision.entry.reasons.some((r) => r.code === "funding_insufficient_available_funds"),
    "and the reason is named in the ONE authoritative readiness decision",
  );
  assert.equal(
    decision.exposure_management.exit_and_reduce,
    true,
    "an account that cannot fund a NEW box must still be able to close the one it holds",
  );
  assert.equal(decision.exposure_management.protective_cancel, true);
  assert.ok(
    !decision.exposure_management.blocked_reasons.some((r) => r.code.startsWith("funding_")),
    "no funding reason may appear in the reduction verdict",
  );
});

/* ═════════════════ 5. broker evidence limitations are stated ═════════════════ */

test("Dhan's missing INITIAL basket margin is reported as a limitation, not discovered by surprise", () => {
  const limits = brokerFundingLimitations("dhan");
  assert.ok(
    limits.some((l) => /INITIAL\) basket margin/.test(l) && /funding_stage_unknown/.test(l)),
    "the operator must know stage funding blocks Dhan BY DESIGN before arming it",
  );
  assert.ok(limits.some((l) => /UNVERIFIED/.test(l)), "and that its funds semantics are unverified");
});

test("Zerodha's unverified funds semantics are reported", () => {
  const limits = brokerFundingLimitations("zerodha");
  assert.ok(limits.some((l) => /NOT been verified against a live account/.test(l)));
});

test("broker limitations travel into the funding readiness surface", () => {
  const r = base({ requireStageFunding: true, brokerLimitations: brokerFundingLimitations("dhan") });
  assert.ok(r.limitations.some((l) => /funding_stage_unknown/.test(l)));
});

/* ═════════════════ 6. all four knobs are deployment-reviewable ═════════════════ */

test("every funding knob appears on the effective-config surface with its code default", () => {
  const resolved = resolveEffectiveConfig({});
  const byEnv = new Map(resolved.values.map((v) => [v.envVar, v]));

  const expected = [
    ["BOX_LIVE_REQUIRE_FUNDS_COVER", false],
    ["BOX_LIVE_REQUIRE_MARGIN_EVIDENCE", false],
    ["BOX_LIVE_REQUIRE_STAGE_FUNDING", false],
    ["BOX_LIVE_RECOVERY_RESERVE_RUPEES", 0],
  ];
  for (const [envVar, def] of expected) {
    const knob = byEnv.get(envVar);
    assert.ok(knob, `${envVar} MUST be on the effective-config surface an operator reviews`);
    assert.equal(knob.value, def, `${envVar} default`);
    assert.equal(knob.source, "default", `${envVar} unset resolves from the code default`);
  }
});

test("an operator override of the funding gates is reported as env-sourced", () => {
  const resolved = resolveEffectiveConfig({
    BOX_LIVE_REQUIRE_STAGE_FUNDING: "true",
    BOX_LIVE_RECOVERY_RESERVE_RUPEES: "75000",
  });
  const byEnv = new Map(resolved.values.map((v) => [v.envVar, v]));
  assert.equal(byEnv.get("BOX_LIVE_REQUIRE_STAGE_FUNDING").value, true);
  assert.equal(byEnv.get("BOX_LIVE_REQUIRE_STAGE_FUNDING").source, "env");
  assert.equal(byEnv.get("BOX_LIVE_RECOVERY_RESERVE_RUPEES").value, 75_000);
  assert.equal(byEnv.get("BOX_LIVE_RECOVERY_RESERVE_RUPEES").source, "env");
});
