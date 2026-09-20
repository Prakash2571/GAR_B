/**
 * DEFECT D — THE SUPERVISED TRIAL PROFILE MUST ACTUALLY BOUND THE TRIAL.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `deploy/mumbai-ec2-conservative.env.example` set `BOX_SESSION_MAX_COMPLETED_TRADES=1` and read,
 * to an operator, as "one trade". It omitted `BOX_SESSION_MAX_ENTRY_ATTEMPTS` entirely, whose code
 * default is 0 = UNLIMITED.
 *
 * Those two ceilings bound different things. A cycle is consumed when a full four-leg Box is
 * ESTABLISHED, so an attempt that submits legs, partially fills and is unwound establishes nothing
 * and spends NO cycle. A profile with only the completed-trade ceiling therefore permits an
 * unbounded run of failed attempts — each of which places real orders — provided none of them ever
 * completes a Box. For a supervised one-lot trial that is the opposite of the intended bound, and
 * it is the failure mode most likely to occur in practice, because a first live session is exactly
 * when attempts fail.
 *
 * The same profile also disabled the margin-evidence gate and never enabled strict stage funding,
 * so the only economic check was funds-cover — which, before the defect-A/B fixes, could be
 * satisfied by comparing funds against the gross option premium.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS TEST DOES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It parses the shipped profile and then feeds it through the REAL `loadBoxConfig()`, so the
 * assertions are about the EFFECTIVE resolved configuration rather than about the text of a
 * comment. A profile whose numbers do not survive `loadBoxConfig` (clamped, mistyped, or silently
 * defaulted) would pass a text-only check and fail here.
 *
 * Failing-first: the `BOX_SESSION_MAX_ENTRY_ATTEMPTS` and funding-gate assertions fail against
 * 24ecfdb, where the key is absent (so the effective value is 0 = unlimited) and both
 * `BOX_LIVE_REQUIRE_MARGIN_EVIDENCE` and `BOX_LIVE_REQUIRE_STAGE_FUNDING` resolve false.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadBoxConfig, configSnapshot } from "../../dist/box/config.js";

const PROFILE_PATH = new URL("../../deploy/mumbai-ec2-conservative.env.example", import.meta.url);
const PROFILE_TEXT = readFileSync(PROFILE_PATH, "utf8");

/** Parse the profile the way a shell would: last uncommented assignment wins, quotes stripped. */
function parseEnvFile(text) {
  const out = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1);
    // Strip a trailing ` # comment`, then surrounding quotes.
    value = value.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    out.set(key, value);
  }
  return out;
}

const PROFILE = parseEnvFile(PROFILE_TEXT);

/**
 * Resolve the profile through the REAL production config loader.
 *
 * `loadBoxConfig()` reads `process.env`, so the profile is installed into a pristine environment
 * for the duration of the call. Every `BOX_`, `DHAN_` and `ZERODHA_` variable is cleared first, so
 * a value the profile FAILS to set cannot be supplied by the ambient environment and make the test
 * lie about what the profile guarantees.
 */
function effectiveConfigFromProfile(overrides = {}) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("BOX_") || key.startsWith("DHAN_") || key.startsWith("ZERODHA_")) {
        delete process.env[key];
      }
    }
    for (const [k, v] of PROFILE) process.env[k] = v;
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return loadBoxConfig();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/* ═════════════ 1. the attempt ceiling ═════════════ */

test("D1 REPRODUCTION: the trial profile sets an EXPLICIT one-attempt ceiling", () => {
  assert.equal(
    PROFILE.get("BOX_SESSION_MAX_ENTRY_ATTEMPTS"),
    "1",
    "the profile must set the attempt ceiling explicitly; omitting it means 0 = UNLIMITED",
  );
  const cfg = effectiveConfigFromProfile();
  assert.equal(cfg.sessionMaxEntryAttempts, 1, "and it must survive loadBoxConfig unclamped");
});

test("D2 the completed-trade ceiling is ALSO one, and the two are different bounds", () => {
  const cfg = effectiveConfigFromProfile();
  assert.equal(cfg.sessionMaxCompletedTrades, 1);
  assert.equal(cfg.sessionMaxEntryAttempts, 1);
  // Both are published, separately, so an operator can see which bound is which.
  const snap = configSnapshot(cfg);
  assert.equal(snap.session_max_completed_trades, 1);
  assert.equal(snap.session_max_entry_attempts, 1);
});

test("D3 a profile WITHOUT the attempt key resolves to UNLIMITED (why D1 matters)", () => {
  /*
   * Demonstrates the pre-fix state directly rather than asserting it about history.
   *
   * `BOX_SUPERVISED_ONE_LOT_TRIAL` must be cleared to observe it. The profile now sets that flag,
   * and the flag's whole purpose is that dropping this key can no longer resolve quietly to
   * unlimited — see D3b. Clearing it here isolates the CODE DEFAULT, which is the hazard this test
   * documents and which is unchanged: any deployment NOT running the supervised profile still gets
   * an unbounded attempt budget from an absent key, and that is exactly why the profile exists.
   */
  const cfg = effectiveConfigFromProfile({
    BOX_SESSION_MAX_ENTRY_ATTEMPTS: undefined,
    BOX_SUPERVISED_ONE_LOT_TRIAL: undefined,
  });
  assert.equal(cfg.sessionMaxEntryAttempts, 0, "0 is the code default and means unbounded");
});

test("D3b ...and with the supervised profile ON, dropping that key now REFUSES STARTUP", () => {
  // The upgrade. The hazard in D3 was silent: the profile read as "one trade" and permitted an
  // unbounded run of attempts. It is no longer reachable on a profile that claims the trial.
  assert.throws(
    () => effectiveConfigFromProfile({ BOX_SESSION_MAX_ENTRY_ATTEMPTS: undefined }),
    /BOX_SESSION_MAX_ENTRY_ATTEMPTS=0.*requires exactly 1/s,
    "the profile flag must convert a silently-unbounded trial into a boot failure",
  );
});

test("D3c the profile DECLARES itself a supervised one-lot trial", () => {
  // Without the flag the four bounds are advisory: correct today, unenforced tomorrow.
  const cfg = effectiveConfigFromProfile();
  assert.equal(cfg.supervisedOneLotTrial, true);
  assert.equal(cfg.maxOpenBoxes, 1, "the MODE-INDEPENDENT ceiling, previously absent and unlimited");
});

/* ═════════════ 2. one lot, one box, one pipeline ═════════════ */

test("D4 one active box, one execution pipeline, one box per underlying are preserved", () => {
  const cfg = effectiveConfigFromProfile();
  assert.equal(cfg.liveMaxOpenBoxes, 1);
  assert.equal(cfg.liveMaxConcurrentExecutions, 1, "one execution pipeline at a time");
  assert.equal(cfg.oneActiveBoxPerUnderlying, true);
  assert.equal(cfg.maxConcurrentPerUnderlying, 1);
  assert.equal(cfg.liveEntrySubmitConcurrency, 1);
});

test("D5 the one-lot quantity envelope is preserved", () => {
  const cfg = effectiveConfigFromProfile();
  assert.ok(cfg.liveMaxOpenLegQuantity > 0, "a per-leg quantity ceiling is set");
  assert.ok(cfg.liveMaxGrossOpenLegQuantity > 0, "a gross open-quantity ceiling is set");
});

/* ═════════════ 3. real trading stays disabled in the checked-in example ═════════════ */

test("D6 the checked-in profile NEVER enables real trading", () => {
  // Mirrors the CI `safety-defaults` job, which only guards .env.example — this profile is the
  // one an operator actually copies, so it needs the same guarantee.
  assert.notEqual(String(PROFILE.get("BOX_EXECUTION_MODE")).toLowerCase(), "live");
  assert.notEqual(String(PROFILE.get("BOX_LIVE_TRADING_ENABLED")).toLowerCase(), "true");
  assert.notEqual(String(PROFILE.get("BOX_SHADOW_MODE_ENABLED")).toLowerCase(), "true");
  const cfg = effectiveConfigFromProfile();
  assert.notEqual(cfg.executionMode, "live");
  assert.equal(cfg.liveTradingEnabled, false);
});

/* ═════════════ 4. the funding gates are actually required ═════════════ */

test("D7 REPRODUCTION: the profile requires usable funds AND complete margin AND stage funding", () => {
  const cfg = effectiveConfigFromProfile();
  assert.equal(cfg.liveRequireFundsCover, true, "usable funds must be required");
  assert.equal(
    cfg.liveRequireMarginEvidence,
    true,
    "complete broker margin evidence must be required, now that completeness is enforced",
  );
  assert.equal(
    cfg.liveRequireStageFunding,
    true,
    "defensible EXECUTION-STAGE funding must be required; the final hedged margin is not " +
      "evidence for the intermediate stages",
  );
});

test("D8 the profile documents the Dhan blocked status instead of weakening the gate", () => {
  // The gate is only honest if the consequence is written down where the operator will read it.
  assert.match(
    PROFILE_TEXT,
    /funding_stage_unknown/,
    "the profile must name the refusal reason an operator will see",
  );
  assert.match(
    PROFILE_TEXT,
    /BLOCKED/,
    "and must say plainly that Dhan entry is blocked under this profile",
  );
  assert.match(
    PROFILE_TEXT,
    /Do NOT set BOX_LIVE_REQUIRE_STAGE_FUNDING=false/,
    "and must warn against turning the gate off to get past it",
  );
});

test("D9 changing a ceiling requires a deliberate re-arm while flat", () => {
  assert.match(
    PROFILE_TEXT,
    /SNAPSHOTTED INTO THE ARMED SESSION|snapshotted at ARM|armed session/i,
    "the profile must explain that an armed session keeps the budget it was armed under",
  );
  assert.match(PROFILE_TEXT, /RE-ARM|re-arm/, "and that a re-arm is needed to change it");
  assert.match(PROFILE_TEXT, /FLAT|flat/, "and that it must be done while flat");
});

/* ═════════════ 5. order-stream truthfulness ═════════════ */

test("D10 order-update streams are OFF and REST reconciliation is the documented mechanism", () => {
  assert.equal(String(PROFILE.get("ZERODHA_ORDER_STREAM_ENABLED")).toLowerCase(), "false");
  assert.equal(String(PROFILE.get("DHAN_ORDER_STREAM_ENABLED")).toLowerCase(), "false");
  assert.match(PROFILE_TEXT, /REST-ONLY|REST RECONCILIATION/i, "REST-only mode is documented");
  assert.ok(
    Number(PROFILE.get("BOX_LIVE_RECONCILE_INTERVAL_MS")) > 0,
    "and the reconcile cadence that bounds fill-observation latency is set",
  );
});

test("D11 the profile distinguishes MARKET-DATA from ORDER-UPDATE streams", () => {
  assert.match(PROFILE_TEXT, /MARKET-DATA/, "the market-data lane is named");
  assert.match(PROFILE_TEXT, /ORDER-UPDATE/, "the order-update lane is named separately");
  // The Zerodha transport detail is the one most likely to be got wrong: its order updates are
  // TEXT frames on the SAME quote socket, so "the market-data socket is up" does not imply
  // order updates are being consumed.
  assert.match(
    PROFILE_TEXT,
    /TEXT frames on the SAME/i,
    "the profile must state that Zerodha order updates share the quote socket",
  );
});

test("D12 the profile does NOT claim an open Dhan socket proves authentication", () => {
  assert.match(
    PROFILE_TEXT,
    /OPEN DHAN SOCKET IS NOT PROOF/i,
    "the profile must refuse the socket-open-implies-authenticated claim",
  );
  assert.match(
    PROFILE_TEXT,
    /login_submitted/,
    "and should name the evidence level the code actually records",
  );
  assert.match(
    PROFILE_TEXT,
    /lifecycle: "READY"|lifecycle: READY|READY/,
    "and point at the signal that IS load-bearing",
  );
});

test("D13 the profile claims neither zero outages nor guaranteed fill updates", () => {
  assert.match(PROFILE_TEXT, /NO CLAIM OF ZERO OUTAGES|zero outages/i);
  assert.match(
    PROFILE_TEXT,
    /MISSING order event is never read as a zero fill|never read as a zero fill/i,
    "and must state the missing-event rule explicitly",
  );
});

/* ═════════════ 6. migration 010 is a documented pre-arm check ═════════════ */

test("D14 migration 010 and the effective/armed values are pre-arm verification steps", () => {
  const runbook = readFileSync(new URL("../../docs/TRIAL_RUNBOOK.md", import.meta.url), "utf8");
  assert.match(runbook, /010_session_entry_attempts/, "migration 010 must be verified before arming");
  assert.match(
    runbook,
    /session_max_entry_attempts/,
    "and the effective attempt ceiling must be confirmed, not assumed",
  );
  // The profile must point at BOTH the configured and the armed value, because they can differ.
  assert.match(PROFILE_TEXT, /effective_config\.session_max_entry_attempts/);
  assert.match(PROFILE_TEXT, /session\.max_entry_attempts/);
});
