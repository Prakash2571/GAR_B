/**
 * `funding_checks_disabled` MUST ENFORCE, NOT ONLY REPORT.
 *
 * THE GAP THIS CLOSES. `fundingReadinessBlockers` already publishes `funding_checks_disabled` when a
 * deployment is live with all three funding evidence gates off. But `operationalReadiness()` is
 * consumed by `getStatus()` and the runtime-status HTTP projection and by NOTHING in the entry
 * decision path — so that blocker reports the condition and cannot stop an order.
 *
 * The argument for leaving it there was that the three env flags prevent the entry indirectly: they
 * are what switch economic admission on, so with all three off `evaluateEntryEconomics` returns
 * early and no funding refusal can occur. That is precisely the problem restated. "The check is off,
 * so the check cannot refuse" is the ABSENCE of a gate, not a gate. All three flags default to
 * false, so it is what a live deployment gets by forgetting three lines, and nothing between the
 * scanner and the broker POST would have objected.
 *
 * So the same condition is now also refused in `entryBlockReasonAfterControls`, the ENTRY-only
 * admission function — the identical enforcement slot used by the Zerodha static-IP gate.
 *
 * NOT BROKER-SCOPED, unlike the static-IP gate. The condition is a property of the deployment, and
 * `buildFundingReadiness` computes it the same way, so scoping enforcement to Zerodha would leave a
 * live Dhan deployment unprotected while its status surface still reported the problem — recreating
 * the enforcement/observability split this file exists to close.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FUNDING_CHECKS_DISABLED, buildFundingReadiness, fundingReadinessBlockers } from "../../dist/box/fundingReadiness.js";
import { loadBoxConfig } from "../../dist/box/config.js";

function withEnv(vars, body) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const om = () => readFileSync(new URL("../../src/box/orderManager.ts", import.meta.url), "utf8");

/** A live config that clears every refusal earlier in `loadBoxConfig` than the funding question. */
const LIVE = {
  BOX_EXECUTION_MODE: "live",
  BOX_LIVE_TRADING_ENABLED: "true",
  BOX_PAPER_EXECUTION_PROFILE: "standard",
  BOX_SHADOW_MODE_ENABLED: "false",
  BOX_EXECUTION_COORDINATOR_ENABLED: "true",
  BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "100000",
};

const GATES = [
  "BOX_LIVE_REQUIRE_FUNDS_COVER",
  "BOX_LIVE_REQUIRE_MARGIN_EVIDENCE",
  "BOX_LIVE_REQUIRE_STAGE_FUNDING",
];
const allGatesOff = Object.fromEntries(GATES.map((g) => [g, undefined]));

/**
 * The limits builder is asserted over source rather than imported: `orderManager.ts` uses TypeScript
 * parameter properties, which a source-only harness cannot load. CI exercises the real builder
 * through every suite that constructs an order manager.
 */
function builderBody() {
  const text = om();
  const start = text.indexOf("export function orderManagerLimitsFromConfig");
  assert.ok(start > 0, "fixture: the limits builder must be locatable");
  return text.slice(start, text.indexOf("\n}", start));
}

/* ══════ 1. funding checks disabled → the ENTRY path refuses, before any submission ══════ */

test("the condition is computed into the limits the ENTRY admission reads", () => {
  /*
   * The value enforcement depends on is derived from config, so this asserts the derivation matches
   * `buildFundingReadiness`'s `checks_disabled` branch: live AND not one gate on.
   */
  assert.match(
    builderBody(),
    /liveFundingChecksDisabled:\s*\n?\s*cfg\.executionMode === "live" &&\s*\n?\s*!cfg\.liveRequireFundsCover &&\s*\n?\s*!cfg\.liveRequireMarginEvidence &&\s*\n?\s*!cfg\.liveRequireStageFunding/,
    "the enforced condition must be exactly live && no gate on",
  );
});

test("the ENTRY admission refuses on it, naming the shared reason and the fix", () => {
  const text = om();
  const fnStart = text.indexOf("entryBlockReasonAfterControls");
  const fnEnd = text.indexOf("MAY THIS PROCESS REDUCE EXPOSURE IT ALREADY OWNS?");
  assert.ok(fnStart > 0 && fnEnd > fnStart, "fixture: the two functions must be locatable in order");

  const guard = text.indexOf("if (this.deps.limits.liveFundingChecksDisabled)");
  assert.ok(guard > 0, "the enforcement guard must exist");
  assert.ok(
    guard > fnStart && guard < fnEnd,
    "it must sit inside entryBlockReasonAfterControls, which only canEnter calls",
  );

  const body = text.slice(guard, guard + 900);
  assert.match(body, /FUNDING_CHECKS_DISABLED/, "the refusal must use the shared reason constant");
  assert.match(body, /BOX_LIVE_REQUIRE_STAGE_FUNDING=true/, "and must name the fix");
  assert.match(body, /NOT gated by this/, "and must state that reduction is unaffected");
});

test("enforcement and observability agree on the reason token", () => {
  assert.equal(FUNDING_CHECKS_DISABLED, "funding_checks_disabled");
  const readiness = buildFundingReadiness({
    live: true,
    requireFundsCover: false,
    requireMarginEvidence: false,
    requireStageFunding: false,
    recoveryReserveRupees: 0,
    freshness: { fundsMaxAgeMs: 5_000, marginMaxAgeMs: 5_000 },
    report: null,
  });
  assert.equal(readiness.status, "checks_disabled");
  const blockers = fundingReadinessBlockers(readiness);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, FUNDING_CHECKS_DISABLED, "one token, both surfaces");
  // ...and the order manager refers to the same constant rather than a duplicated literal.
  assert.ok(
    om().includes("import { FUNDING_CHECKS_DISABLED }"),
    "the enforcement path must import the shared constant, not restate the string",
  );
});

/* ══════ 2. funding checks enabled → this specific blocker disappears ══════ */

test("ANY one gate on clears the condition — stage funding alone is sufficient", () => {
  for (const gate of GATES) {
    withEnv({ ...LIVE, ...allGatesOff, [gate]: "true" }, () => {
      const cfg = loadBoxConfig();
      const disabled =
        cfg.executionMode === "live" &&
        !cfg.liveRequireFundsCover &&
        !cfg.liveRequireMarginEvidence &&
        !cfg.liveRequireStageFunding;
      assert.equal(disabled, false, `${gate}=true must clear the condition`);
    });
  }
  // ...and with all three off in live it is present.
  withEnv({ ...LIVE, ...allGatesOff }, () => {
    const cfg = loadBoxConfig();
    assert.equal(cfg.liveRequireFundsCover, false);
    assert.equal(cfg.liveRequireMarginEvidence, false);
    assert.equal(cfg.liveRequireStageFunding, false);
    assert.equal(cfg.executionMode, "live", "so the derived condition is true and entry is refused");
  });
});

test("the readiness blocker disappears once a gate is on, matching enforcement", () => {
  const readiness = buildFundingReadiness({
    live: true,
    requireFundsCover: false,
    requireMarginEvidence: false,
    requireStageFunding: true,
    recoveryReserveRupees: 25_000,
    freshness: { fundsMaxAgeMs: 5_000, marginMaxAgeMs: 5_000 },
    report: null,
  });
  assert.notEqual(readiness.status, "checks_disabled");
  assert.deepEqual(
    fundingReadinessBlockers(readiness).filter((b) => b.code === FUNDING_CHECKS_DISABLED),
    [],
    "with a gate on, this specific blocker must be gone from the status surface too",
  );
});

/* ══════ 3. paper / non-live is unchanged ══════ */

test("PAPER is unaffected — the condition requires live", () => {
  withEnv({ BOX_EXECUTION_MODE: "paper_latency", ...allGatesOff }, () => {
    const cfg = loadBoxConfig();
    const disabled =
      cfg.executionMode === "live" &&
      !cfg.liveRequireFundsCover &&
      !cfg.liveRequireMarginEvidence &&
      !cfg.liveRequireStageFunding;
    assert.equal(disabled, false, "a paper profile places no broker order and must never be gated");
  });
  const paper = buildFundingReadiness({
    live: false,
    requireFundsCover: false,
    requireMarginEvidence: false,
    requireStageFunding: false,
    recoveryReserveRupees: 0,
    freshness: { fundsMaxAgeMs: 5_000, marginMaxAgeMs: 5_000 },
    report: null,
  });
  assert.equal(paper.status, "not_applicable", "paper is not_applicable, never checks_disabled");
  assert.deepEqual(fundingReadinessBlockers(paper), []);
});

/* ══════ 4. every risk-reducing path remains available ══════ */

/**
 * Proven structurally, which is stronger than enumerating purposes: the gate is read exactly once,
 * inside a function only `canEnter` calls, and `submit()` consults `canEnter` only under
 * `purpose === "ENTRY"`. That covers EXIT, PROTECTIVE_CANCEL, EMERGENCY_RESIDUAL,
 * reconciliation-authorised reduction and any purpose added later.
 */
test("the gate is read EXACTLY ONCE and appears in no reduction path", () => {
  const text = om();
  // Three occurrences: the interface field, the builder that sets it, the single read that enforces.
  assert.equal(
    text.split("liveFundingChecksDisabled").length - 1,
    3,
    "the field must be declared, set once, and read exactly once",
  );

  const start = text.indexOf("canManageExposure(): boolean {");
  const reasonFn = text.indexOf("exposureReductionBlockReason(): string | null {");
  assert.ok(start > 0 && reasonFn > start, "fixture: both reduction predicates must be locatable");
  const afterReason = text.slice(reasonFn);
  const reductionBody = text.slice(start, reasonFn) + afterReason.slice(0, afterReason.indexOf("\n  }\n"));
  assert.ok(
    !reductionBody.includes("liveFundingChecksDisabled") && !reductionBody.includes(FUNDING_CHECKS_DISABLED),
    "a deployment with funding checks off must still ATTEMPT to reduce exposure it already owns",
  );

  // The adapters must not have acquired it either — Dhan's ensureTradingReady() equivalent guards
  // cancelOrder and modifyOrder, so a policy gate there would block protective cancels.
  for (const file of ["kiteBrokerAdapter.ts", "brokerAdapter.ts"]) {
    const adapter = readFileSync(new URL(`../../src/box/${file}`, import.meta.url), "utf8");
    assert.ok(
      !adapter.includes("liveFundingChecksDisabled") && !adapter.includes(FUNDING_CHECKS_DISABLED),
      `${file} must not consume the entry gate — it guards cancel and modify too`,
    );
  }
});

test("every funding blocker stays entry-scoped, so none can reach the reduction verdict", () => {
  const readiness = buildFundingReadiness({
    live: true,
    requireFundsCover: false,
    requireMarginEvidence: false,
    requireStageFunding: false,
    recoveryReserveRupees: 0,
    freshness: { fundsMaxAgeMs: 5_000, marginMaxAgeMs: 5_000 },
    report: null,
  });
  for (const blocker of fundingReadinessBlockers(readiness)) {
    assert.equal(blocker.scope, "entry", `${blocker.code} must be entry-scoped`);
  }
});
