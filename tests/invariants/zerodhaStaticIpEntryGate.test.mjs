/**
 * ZERODHA STATIC-IP: ENFORCEMENT AND OBSERVABILITY ARE DIFFERENT THINGS, PROVEN SEPARATELY.
 *
 * Zerodha requires the public egress IP that sends API order requests to be registered in the Kite
 * developer console. GAR_B cannot verify that whitelist — no authoritative endpoint exists — so the
 * gate records an OPERATOR CONFIRMATION and says so in every string it produces. Reporting it as
 * broker-verified would be inventing evidence on a real-money path.
 *
 * TWO SURFACES, AND WHY BOTH ARE TESTED. `operationalReadiness()` is consumed by `getStatus()` and
 * the runtime-status HTTP projection and by NOTHING in the entry decision path, so a readiness
 * blocker reports and cannot enforce. Enforcement is a single line in
 * `entryBlockReasonAfterControls`. If only one were tested, a future refactor could delete the
 * enforcement while the status surface kept truthfully describing the condition — which reads
 * exactly like a working gate.
 *
 * REDUCTION IMMUNITY IS PROVEN STRUCTURALLY, WHICH IS STRONGER THAN CASE-BY-CASE. Rather than assert
 * that three particular purposes are unaffected, the tests below prove the gate is UNREACHABLE from
 * any non-ENTRY path: it is read exactly once, inside a function only `canEnter` calls, and `submit`
 * consults `canEnter` only under `purpose === "ENTRY"`. That covers EXIT, PROTECTIVE_CANCEL,
 * EMERGENCY_RESIDUAL, reconciliation and any purpose added later, which an enumerated list would not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ZERODHA_STATIC_IP_UNCONFIRMED,
  normaliseEgressIp,
  readZerodhaStaticIpPolicy,
  zerodhaStaticIpEntryRefusal,
  zerodhaStaticIpReadinessBlocker,
} from "../../dist/box/zerodhaStaticIp.js";
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

const src = (rel) => readFileSync(new URL(`../../src/box/${rel}`, import.meta.url), "utf8");

/* ══════════════════ 1. the confirmation parses FAIL CLOSED ══════════════════ */

test("only an explicit affirmative counts as confirmation — everything else fails closed", () => {
  for (const raw of ["true", "TRUE", "1", "yes", " yes "]) {
    assert.equal(readZerodhaStaticIpPolicy({ ZERODHA_STATIC_IP_CONFIRMED: raw }).confirmed, true, raw);
  }
  // Unset, blank, explicit false AND an unrecognised value all read as NOT confirmed. The point of
  // the gate is that it cannot be satisfied by accident, so "ture" must never resolve to true.
  for (const raw of [undefined, "", "   ", "false", "no", "0", "ture", "maybe", "confirmed"]) {
    assert.equal(
      readZerodhaStaticIpPolicy({ ZERODHA_STATIC_IP_CONFIRMED: raw }).confirmed,
      false,
      `${JSON.stringify(raw)} must not confirm`,
    );
  }
});

test("the expected egress IP is validated strictly, and a bad value is not carried as though usable", () => {
  assert.equal(normaliseEgressIp("203.0.113.7"), "203.0.113.7");
  assert.equal(normaliseEgressIp("  10.0.0.1  "), "10.0.0.1");
  // Each of these is a realistic hand-copy error from a console, and none is a single address.
  for (const bad of ["256.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4:80", "10.0.0.0/24", "example.com", "", null]) {
    assert.equal(normaliseEgressIp(bad), null, `${JSON.stringify(bad)} must not be accepted`);
  }
  const malformed = readZerodhaStaticIpPolicy({ ZERODHA_EXPECTED_EGRESS_IP: "10.0.0.0/24" });
  assert.equal(malformed.expectedEgressIp, null, "an unusable value is not evidence of anything");
  assert.equal(malformed.expectedEgressIpMalformed, true, "...but the operator is told it was ignored");
});

/* ══════════════════ 2. the policy verdict, scoped correctly ══════════════════ */

const policy = (confirmed, ip = "203.0.113.7") => ({ confirmed, expectedEgressIp: ip });

test("live + zerodha + unconfirmed REFUSES, and names the honest reason", () => {
  const reason = zerodhaStaticIpEntryRefusal({ live: true, broker: "zerodha", policy: policy(false) });
  assert.ok(reason, "an unconfirmed live Zerodha entry must be refused");
  assert.match(reason, new RegExp(ZERODHA_STATIC_IP_UNCONFIRMED));
  assert.match(reason, /ZERODHA_STATIC_IP_CONFIRMED=true/, "the fix must be named");
  assert.match(reason, /not a broker-verified fact|cannot query Zerodha/, "must not claim broker verification");
  assert.match(
    reason,
    /Exits, protective cancels, emergency residual\s+flattening and reconciliation are NOT gated/,
    "must state that reduction is unaffected",
  );
});

test("confirmation missing entirely also refuses — absence is not permission", () => {
  const reason = zerodhaStaticIpEntryRefusal({
    live: true,
    broker: "zerodha",
    policy: readZerodhaStaticIpPolicy({}),
  });
  assert.ok(reason, "an unset confirmation must refuse, not pass");
  assert.match(reason, /no expected egress IP is configured/);
});

test("confirmed=true means THIS policy raises no objection (other gates are untouched)", () => {
  assert.equal(zerodhaStaticIpEntryRefusal({ live: true, broker: "zerodha", policy: policy(true) }), null);
});

test("PAPER is unaffected — a paper profile places no broker order", () => {
  assert.equal(zerodhaStaticIpEntryRefusal({ live: false, broker: "zerodha", policy: policy(false) }), null);
});

test("another broker is unaffected — Dhan has its own, API-verified mechanism", () => {
  assert.equal(zerodhaStaticIpEntryRefusal({ live: true, broker: "dhan", policy: policy(false) }), null);
  // An unselected broker is deliberately not refused here: broker auth, token readiness and
  // reconciliation already refuse entry, and guessing would block a Dhan-only deployment on a
  // Zerodha variable it has no reason to set.
  assert.equal(zerodhaStaticIpEntryRefusal({ live: true, broker: undefined, policy: policy(false) }), null);
});

/* ══════════════════ 3. observability: the readiness blocker ══════════════════ */

test("readiness reports the precise reason, entry-scoped, and never claims broker verification", () => {
  const blocker = zerodhaStaticIpReadinessBlocker({
    live: true,
    broker: "zerodha",
    policy: readZerodhaStaticIpPolicy({ ZERODHA_EXPECTED_EGRESS_IP: "203.0.113.7" }),
  });
  assert.ok(blocker, "the condition must be visible on the status surface");
  assert.equal(blocker.code, ZERODHA_STATIC_IP_UNCONFIRMED, "a precise code, not a generic failure");
  assert.equal(blocker.scope, "entry", "entry-scoped or it could reach the reduction verdict");
  assert.match(blocker.detail, /NOT a\s+broker-verified fact/);
  assert.match(blocker.detail, /203\.0\.113\.7/, "the expected IP is diagnostic, not a secret");
  assert.match(blocker.detail, /exited, reduced, protectively\s+cancelled and reconciled/);
  // It must also explain that the broker may still reject a reduction for the real infrastructure
  // reason — otherwise an operator reads "reduction is fine" and is surprised.
  assert.match(blocker.detail, /Zerodha may\s+reject those requests itself/);
});

test("readiness stays silent in exactly the cases the policy permits", () => {
  for (const input of [
    { live: false, broker: "zerodha", policy: readZerodhaStaticIpPolicy({}) },
    { live: true, broker: "dhan", policy: readZerodhaStaticIpPolicy({}) },
    { live: true, broker: "zerodha", policy: readZerodhaStaticIpPolicy({ ZERODHA_STATIC_IP_CONFIRMED: "true" }) },
  ]) {
    assert.equal(zerodhaStaticIpReadinessBlocker(input), null);
  }
});

/* ══════════════════ 4. the config → limits hand-off ══════════════════ */

test("loadBoxConfig carries the parsed policy, fail-closed in live and permissive in paper", () => {
  const LIVE = {
    BOX_EXECUTION_MODE: "live",
    BOX_LIVE_TRADING_ENABLED: "true",
    BOX_PAPER_EXECUTION_PROFILE: "standard",
    BOX_SHADOW_MODE_ENABLED: "false",
    BOX_EXECUTION_COORDINATOR_ENABLED: "true",
    BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "100000",
  };
  withEnv({ ...LIVE, ZERODHA_STATIC_IP_CONFIRMED: undefined, ZERODHA_EXPECTED_EGRESS_IP: undefined }, () => {
    const cfg = loadBoxConfig();
    assert.equal(cfg.zerodhaStaticIp.confirmed, false, "an unset confirmation must not load as true");
    assert.equal(cfg.zerodhaStaticIp.expectedEgressIp, null);
    // The live+zerodha+unconfirmed combination is what the order manager refuses.
    assert.ok(zerodhaStaticIpEntryRefusal({ live: true, broker: "zerodha", policy: cfg.zerodhaStaticIp }));
  });
  withEnv({ ...LIVE, ZERODHA_STATIC_IP_CONFIRMED: "true", ZERODHA_EXPECTED_EGRESS_IP: "203.0.113.7" }, () => {
    const cfg = loadBoxConfig();
    assert.equal(cfg.zerodhaStaticIp.confirmed, true);
    assert.equal(cfg.zerodhaStaticIp.expectedEgressIp, "203.0.113.7");
    assert.equal(zerodhaStaticIpEntryRefusal({ live: true, broker: "zerodha", policy: cfg.zerodhaStaticIp }), null);
  });
});

/**
 * The limits object folds the execution mode in at its single construction point, so the order
 * manager needs no knowledge of the mode and paper cannot be gated. Asserted over the source rather
 * than by importing `orderManagerLimitsFromConfig`, because that module uses TypeScript parameter
 * properties and cannot be loaded by a source-only harness; CI exercises the real builder through
 * every suite that constructs an order manager.
 */
test("the limits builder folds the mode in, so a paper profile is never gated", () => {
  const om = readFileSync(new URL("../../src/box/orderManager.ts", import.meta.url), "utf8");
  const builder = om.slice(om.indexOf("export function orderManagerLimitsFromConfig"));
  const body = builder.slice(0, builder.indexOf("\n}"));
  assert.match(
    body,
    /zerodhaEntryStaticIpConfirmed:\s*\n?\s*cfg\.executionMode === "live" \? cfg\.zerodhaStaticIp\.confirmed : true/,
    "paper must be folded to true at construction, not special-cased at the point of use",
  );
});

/* ══════════════════ 5. enforcement is where it must be, and ONLY there ══════════════════ */

/**
 * The enforcement claim is positional, so it is asserted over the source. A behavioural test that
 * an EXIT is unaffected would pass just as well if the gate were in the wrong place and merely
 * happened not to fire for that one purpose.
 */
test("the gate is read EXACTLY ONCE, inside the ENTRY-only admission function", () => {
  const om = src("orderManager.ts");
  const reads = om.split("zerodhaEntryStaticIpConfirmed").length - 1;
  // Three: the interface field, the builder that sets it, and the single read that enforces it.
  assert.equal(reads, 3, "the field must be declared, set once, and read exactly once");

  const enforcement = om.indexOf("!this.deps.limits.zerodhaEntryStaticIpConfirmed");
  assert.ok(enforcement > 0, "the enforcement read must exist");

  const fnStart = om.indexOf("entryBlockReasonAfterControls");
  const fnEnd = om.indexOf("MAY THIS PROCESS REDUCE EXPOSURE IT ALREADY OWNS?");
  assert.ok(fnStart > 0 && fnEnd > fnStart, "fixture: the two functions must be locatable in order");
  assert.ok(
    enforcement > fnStart && enforcement < fnEnd,
    "the gate must live inside entryBlockReasonAfterControls, which only canEnter calls",
  );
});

test("the gate appears in NO submit, cancel, modify or reduction path", () => {
  const om = src("orderManager.ts");
  /*
   * Both reduction predicates, taken together: `canManageExposure` is the boolean a reduction path
   * consults and `exposureReductionBlockReason` is the reason-returning form. Neither may mention the
   * entry gate.
   */
  const start = om.indexOf("canManageExposure(): boolean {");
  const reasonFn = om.indexOf("exposureReductionBlockReason(): string | null {");
  assert.ok(start > 0 && reasonFn > start, "fixture: both reduction predicates must be locatable");
  const afterReason = om.slice(reasonFn);
  const reductionBody = om.slice(start, reasonFn) + afterReason.slice(0, afterReason.indexOf("\n  }\n"));
  assert.ok(reductionBody.length > 0, "fixture: the reduction bodies must be non-empty");
  assert.ok(
    !reductionBody.includes("zerodhaEntryStaticIpConfirmed") &&
      !reductionBody.includes(ZERODHA_STATIC_IP_UNCONFIRMED),
    "an operator forgetting a confirmation flag must never stop GAR_B ATTEMPTING a reduction",
  );

  // And the adapter layer must not have acquired a Dhan-style ensureTradingReady() equivalent, which
  // is called from cancelOrder and modifyOrder and would therefore block protective cancels.
  for (const file of ["kiteBrokerAdapter.ts", "brokerAdapter.ts"]) {
    const text = src(file);
    assert.ok(
      !text.includes("zerodhaEntryStaticIpConfirmed") && !text.includes(ZERODHA_STATIC_IP_UNCONFIRMED),
      `${file} must not consume the entry policy gate — it guards cancel and modify too`,
    );
  }
});

/* ══════════════════ 6. no network on the order hot path ══════════════════ */

test("the policy module performs no IP discovery and no I/O at all", () => {
  const text = src("zerodhaStaticIp.ts");
  // Every function is pure and synchronous: no fetch, no http, no dns, no await, no Promise. This is
  // what keeps order placement, the pre-POST guard, cancel, modify, flatten and reconciliation free
  // of an external dependency introduced by this feature.
  for (const forbidden of ["fetch(", "http.", "https.", "node:http", "node:dns", "await ", "Promise", "async "]) {
    assert.ok(!text.includes(forbidden), `zerodhaStaticIp.ts must contain no ${forbidden} — it must stay pure`);
  }
  assert.ok(!/^import\s/m.test(text), "and it must import nothing, so it cannot acquire I/O indirectly");
});

test("no egress-discovery call was introduced into any order path", () => {
  for (const file of ["orderManager.ts", "executionGateway.ts", "kiteBrokerAdapter.ts"]) {
    const text = src(file);
    for (const probe of ["ifconfig.me", "api.ipify.org", "checkip", "icanhazip", "EXPECTED_EGRESS_IP"]) {
      assert.ok(!text.includes(probe), `${file} must not reference ${probe} — no IP lookup on the order path`);
    }
  }
});

/* ══════════════════ 7. the shipped profile states the requirement ══════════════════ */

test("the supervised profile sets the confirmation and an expected egress IP placeholder", () => {
  const text = readFileSync(new URL("../../deploy/FINAL-one-box-live.env.template", import.meta.url), "utf8");
  assert.match(text, /^ZERODHA_STATIC_IP_CONFIRMED=/m, "the profile must make the operator answer this");
  assert.match(text, /^ZERODHA_EXPECTED_EGRESS_IP=/m);
  assert.match(text, /Kite developer console/, "the profile must say where the registration happens");
  assert.match(text, /not.{0,40}broker-verified|cannot.{0,30}verify/is, "and must not imply verification");
});
