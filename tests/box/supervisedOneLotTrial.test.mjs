/**
 * ONE LOT, ONE BOX, ONE ATTEMPT — REQUIRED AND VERIFIED, NOT HOPED FOR.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE TRIAL NEEDS, AND WHY FOUR SETTINGS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The first supervised live test must take exactly one lot, in one box, on one attempt. Four
 * independent settings decide that, enforced in four different places against four different
 * counts, and THREE OF THEM DEFAULT TO UNLIMITED:
 *
 *   BOX_MAX_OPEN_BOXES                 default 0 → unlimited
 *   BOX_LIVE_MAX_OPEN_BOXES            default 1
 *   BOX_SESSION_MAX_COMPLETED_TRADES   default 0 → unlimited
 *   BOX_SESSION_MAX_ENTRY_ATTEMPTS     default 0 → unlimited
 *
 * So "configure a one-shot trial" is three chances to leave a bound off, with no feedback. The
 * profile makes all four MANDATORY and refuses startup otherwise.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO CASES THAT MOTIVATE THE LAST TWO SETTINGS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Inventory ceilings alone are not a one-shot trial, and these tests prove it on the real
 * coordinator:
 *
 *   AFTER THE FIRST BOX CLOSES   inventory returns to 0, so every inventory ceiling admits a second
 *                                box. Only the CONSUMED-cycle count still refuses.
 *   AFTER AN ATTEMPT ABORTS      a rejected/unwound/recovered attempt completes no cycle and leaves
 *                                no inventory, so the cycle gate and both ceilings see a clean
 *                                slate. Only the ATTEMPT budget still refuses.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND THE QUANTITY IS READ, NEVER ASSUMED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * One lot is whatever the LIVE instrument master says. The fixtures use 75 and an earlier note
 * guessed 65; the arithmetic scales entirely with that number, so it is supplied, and a missing one
 * is reported as UNVERIFIED rather than filled in.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SUPERVISED_ONE_SHOT_SETTINGS,
  SUPERVISED_TRIAL_ENV,
  renderSupervisedTrialPreflight,
  supervisedTrialQuantities,
  supervisedTrialStartupRefusal,
  supervisedTrialViolations,
} from "../../dist/box/supervisedTrial.js";
import { loadBoxConfig } from "../../dist/box/config.js";
import {
  armSession,
  evaluateSessionEntry,
  idleSessionRecord,
  recordAbortedAttempt,
  recordCompletedBox,
  recordEntryAttemptStarted,
  recordEstablishedBox,
} from "../../dist/box/tradingSession.js";
import { CoordinatedBoxExecutionGateway } from "../../dist/box/executionCoordinator.js";
import { InProcessInstrumentReservations } from "../../dist/box/instrumentReservations.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg } from "./helpers.mjs";

const NOW = 1_700_000_000_000;
const ONE_SHOT = { maxOpenBoxes: 1, liveMaxOpenBoxes: 1, sessionMaxCompletedTrades: 1, sessionMaxEntryAttempts: 1 };

/* ═══════════════════ 1. the four settings are REQUIRED, not recommended ═══════════════════ */

test("the profile requires all four settings to be exactly 1", () => {
  assert.deepEqual(supervisedTrialViolations(ONE_SHOT), [], "a correct trial has no violations");

  // Each one, individually left at its default, must be caught. Three of the four defaults are 0.
  for (const spec of SUPERVISED_ONE_SHOT_SETTINGS) {
    const broken = { ...ONE_SHOT, [spec.field]: 0 };
    const violations = supervisedTrialViolations(broken);
    assert.equal(violations.length, 1, `${spec.env}=0 must be caught on its own`);
    assert.equal(violations[0].env, spec.env);
    assert.equal(violations[0].actual, 0);
    assert.match(violations[0].detail, /UNLIMITED/, "0 must be named as unlimited, not as 'smaller'");
    assert.ok(violations[0].detail.includes(spec.why), "the refusal explains why this setting matters");
  }
});

test("a value ABOVE 1 is refused too — the bound must be exact", () => {
  const violations = supervisedTrialViolations({ ...ONE_SHOT, maxOpenBoxes: 2 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].actual, 2);
  assert.match(violations[0].detail, /requires exactly 1/);
  assert.doesNotMatch(violations[0].detail, /UNLIMITED/, "2 is bounded — it must not be called unlimited");
});

test("the startup refusal names EVERY offender at once", () => {
  // An operator fixing one setting per restart is how a supervised trial slips to the next day.
  const refusal = supervisedTrialStartupRefusal(true, {
    maxOpenBoxes: 0,
    liveMaxOpenBoxes: 3,
    sessionMaxCompletedTrades: 0,
    sessionMaxEntryAttempts: 0,
  });
  assert.ok(refusal);
  for (const spec of SUPERVISED_ONE_SHOT_SETTINGS) assert.ok(refusal.includes(spec.env), `${spec.env} is named`);
  assert.match(refusal, /4 of the 4 required setting\(s\)/);
  assert.match(refusal, /Startup is refused/);
});

test("with the profile OFF nothing is required — the general-purpose defaults stand", () => {
  // THE PROPERTY THAT KEEPS THIS SAFE TO MERGE. Every existing deployment runs with three of these
  // at 0, and turning that into a startup failure would be a far worse defect than the one fixed.
  const allDefaults = { maxOpenBoxes: 0, liveMaxOpenBoxes: 1, sessionMaxCompletedTrades: 0, sessionMaxEntryAttempts: 0 };
  assert.equal(supervisedTrialStartupRefusal(false, allDefaults), null);
  assert.equal(supervisedTrialStartupRefusal(false, { ...allDefaults, maxOpenBoxes: 25 }), null);
});

/* ═══════════════════ 2. the real loader enforces it ═══════════════════ */

/** Run a body with a patched environment, always restoring it. */
function withEnv(vars, body) {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("loadBoxConfig REFUSES TO BOOT when the profile is on and a bound is missing", () => {
  withEnv(
    {
      BOX_SUPERVISED_ONE_LOT_TRIAL: "true",
      BOX_MAX_OPEN_BOXES: "1",
      BOX_LIVE_MAX_OPEN_BOXES: "1",
      BOX_SESSION_MAX_COMPLETED_TRADES: "1",
      // The one that is easiest to forget and the only bound on an aborted attempt.
      BOX_SESSION_MAX_ENTRY_ATTEMPTS: undefined,
    },
    () => {
      assert.throws(() => loadBoxConfig(), /BOX_SESSION_MAX_ENTRY_ATTEMPTS=0.*requires exactly 1/s);
    },
  );
});

test("loadBoxConfig BOOTS when all four are 1, and reports the profile as on", () => {
  withEnv(
    {
      BOX_SUPERVISED_ONE_LOT_TRIAL: "true",
      BOX_MAX_OPEN_BOXES: "1",
      BOX_LIVE_MAX_OPEN_BOXES: "1",
      BOX_SESSION_MAX_COMPLETED_TRADES: "1",
      BOX_SESSION_MAX_ENTRY_ATTEMPTS: "1",
    },
    () => {
      const c = loadBoxConfig();
      assert.equal(c.supervisedOneLotTrial, true);
      for (const spec of SUPERVISED_ONE_SHOT_SETTINGS) {
        assert.equal(c[spec.field], 1, `${spec.env} resolved to 1`);
      }
    },
  );
});

test("the profile flag is STRICT: a typo does not silently disable it", () => {
  // `strictBool`, like every other safety switch. `=ture` resolving to false would drop the profile
  // AND the requirement that the four bounds be 1 — the exact failure the profile prevents.
  withEnv({ BOX_SUPERVISED_ONE_LOT_TRIAL: "ture" }, () => {
    assert.throws(() => loadBoxConfig(), /BOX_SUPERVISED_ONE_LOT_TRIAL/);
  });
});

test("the loader is UNAFFECTED when the profile is off", () => {
  withEnv(
    {
      BOX_SUPERVISED_ONE_LOT_TRIAL: undefined,
      BOX_MAX_OPEN_BOXES: undefined,
      BOX_SESSION_MAX_COMPLETED_TRADES: undefined,
      BOX_SESSION_MAX_ENTRY_ATTEMPTS: undefined,
    },
    () => {
      const c = loadBoxConfig();
      assert.equal(c.supervisedOneLotTrial, false);
      assert.equal(c.maxOpenBoxes, 0, "still unlimited by default");
      assert.equal(c.sessionMaxCompletedTrades, 0);
      assert.equal(c.sessionMaxEntryAttempts, 0);
    },
  );
});

/* ═══════════════════ 3. ENFORCEMENT, on the real coordinator ═══════════════════ */

const IDENTITY = { deployment: "test", instance: "host-w0", pid: 1, boot: "w0", processTag: "host-w0:p1:w0" };

function boxFor({ underlying = "NIFTY", k1 = 19900, k2 = 20100, lot = 75 } = {}) {
  const expiry = "2026-09-24";
  const leg = (strike, type) => ({
    token: Number(`${strike}${type === "CE" ? 1 : 2}`),
    tradingsymbol: `${underlying}26SEP${strike}${type}`,
    exchange: "NFO",
    strike,
    instrument_type: type,
    expiry,
    lot_size: lot,
    tick_size: 0.05,
  });
  return {
    key: `${underlying}|${expiry}|${k1}|${k2}|LONG_BOX`,
    underlying,
    name: underlying,
    is_index: true,
    expiry,
    direction: "LONG_BOX",
    lower_strike: k1,
    upper_strike: k2,
    box_width: k2 - k1,
    lot_size: lot,
    legs: { k1_ce: leg(k1, "CE"), k2_ce: leg(k2, "CE"), k2_pe: leg(k2, "PE"), k1_pe: leg(k1, "PE") },
  };
}

function detectionFor(candidate) {
  return {
    candidate,
    at: NOW,
    legs: BOX_LEG_ROLES.map((role) => ({
      role,
      side: entrySideFor(role, "LONG_BOX"),
      token: candidate.legs[role].token,
      tradingsymbol: candidate.legs[role].tradingsymbol,
      strike: candidate.legs[role].strike,
      instrument_type: candidate.legs[role].instrument_type,
      price: 100,
      qty_at_touch: candidate.lot_size,
      bid: 99, bid_qty: candidate.lot_size, ask: 100, ask_qty: candidate.lot_size,
      quote_at: NOW, exchange_at: null, quote_version: 1, depth: null,
      age_ms: 5, fresh: true, executable: true,
    })),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80,
    gross_edge: 4_000,
    tradable: true,
    depth_ok: true,
    worst_age_ms: 5,
    quote_version: 1,
    reject: null,
  };
}

/**
 * The real coordinator, with the REAL session gate and the REAL attempt-budget consume.
 *
 * `session.record` is a live `BoxSessionRecord` the test mutates exactly as the engine does
 * (`recordEstablishedBox`, `recordCompletedBox`, `recordAbortedAttempt`), and the gate is the
 * production `evaluateSessionEntry`. `posts` records everything that would have reached a broker, so
 * "refused before submit" is an assertion about transmission and not about a return value.
 */
function trialCoordinator({ inventory = { value: 0 } } = {}) {
  const reservations = new InProcessInstrumentReservations();
  const session = { record: armSession({ sessionId: "s1", maxCompletedTrades: 1, maxEntryAttempts: 1, armedBy: "op", previous: idleSessionRecord(NOW), now: NOW }) };
  const posts = [];
  const inner = {
    mode: "live",
    hasCapacity: () => true,
    invariantViolation: () => {},
    estimateExecutableExit: () => [],
    flattenResidual: async () => ({ flattened: {}, remaining: [], charges: 0 }),
    simulateEntry: async () => ({ ok: true }),
    simulateExit: async () => ({ ok: true }),
    simulateLeggingExit: async () => ({ ok: true, record: { residual_exposure: [] } }),
    simulateLeggingEntry: async (args) => {
      // Stands in for the four broker POSTs an admitted entry performs.
      for (const role of BOX_LEG_ROLES) {
        posts.push({ role, underlying: args.candidate.underlying, quantity: args.candidate.lot_size });
      }
      return { ok: true, legging: { residual_exposure: [], trade_id: `t-${posts.length / 4}` } };
    },
  };
  const coordinator = new CoordinatedBoxExecutionGateway({
    inner,
    reservations,
    local: reservations,
    waitable: reservations,
    cfg: cfg({
      conflictWaitMaxMs: 0,
      instrumentLockTtlMs: 5_000,
      maxConcurrentPerUnderlying: 0,
      oneActiveBoxPerUnderlying: false,
      reservationClockSkewGraceMs: 0,
      durableReservationsEnabled: false,
      reservationRequireDurable: false,
      liveMaxOpenLegQuantity: 100,
      liveMaxGrossOpenLegQuantity: 400,
      // The trial profile's values.
      maxOpenBoxes: 1,
    }),
    quotes: { view: () => new Map() },
    broker: () => "zerodha",
    generation: () => 1,
    identity: IDENTITY,
    now: () => NOW,
    boxInventory: () => inventory.value,
    // THE PRODUCTION GATE over a real session record.
    sessionEntryGate: () => evaluateSessionEntry({ record: session.record, recoveryActive: false }),
    sessionConsumeAttempt: async () => {
      session.record = recordEntryAttemptStarted(session.record, NOW);
      return { ok: true, detail: null };
    },
    sleep: () => new Promise((r) => setImmediate(r)),
    setTimer: () => null,
    clearTimer: () => {},
    log: () => {},
  });
  const enter = (candidate) => coordinator.simulateLeggingEntry({ candidate, detection: detectionFor(candidate), qualify: () => ({ qualifies: true, expected_net_profit: 5_000, min_expected_net_profit: 1_200 }) });
  return { coordinator, session, posts, inventory, enter };
}

test("ONE ATTEMPT: the first entry is admitted and posts exactly four legs", () => {
  const t = trialCoordinator();
  return t.enter(boxFor()).then((result) => {
    assert.equal(result.ok, true);
    assert.equal(t.posts.length, 4, "one box = four legs, one lot each");
    assert.deepEqual([...new Set(t.posts.map((p) => p.quantity))], [75], "one lot per leg");
    assert.equal(t.session.record.entry_attempts, 1, "the attempt is spent");
  });
});

test("ONE BOX: a second candidate is refused while the first is still OPEN", async () => {
  const t = trialCoordinator();
  await t.enter(boxFor());
  t.session.record = recordEstablishedBox(t.session.record, "t-1", NOW);
  t.inventory.value = 1;
  const before = t.posts.length;

  const second = await t.enter(boxFor({ k1: 19800, k2: 20000 }));

  assert.equal(second.ok, false);
  assert.equal(t.posts.length, before, "NOT ONE additional leg reached the broker");
});

test("AFTER THE FIRST BOX CLOSES a second candidate is STILL refused", async () => {
  /*
   * THE CASE NO INVENTORY CEILING CATCHES. The box closed and is flat, so `boxInventory()` is back to
   * 0 and both BOX_MAX_OPEN_BOXES and BOX_LIVE_MAX_OPEN_BOXES admit freely. Only the CONSUMED-cycle
   * count still refuses — which is why BOX_SESSION_MAX_COMPLETED_TRADES=1 is a required setting and
   * not a duplicate of the ceilings.
   */
  const t = trialCoordinator();
  await t.enter(boxFor());
  t.session.record = recordEstablishedBox(t.session.record, "t-1", NOW);
  t.session.record = recordCompletedBox(t.session.record, "t-1", NOW);
  t.inventory.value = 0; // flat again: every inventory gate is satisfied
  const before = t.posts.length;

  const second = await t.enter(boxFor({ k1: 19800, k2: 20000 }));

  assert.equal(second.ok, false);
  assert.equal(second.reason, "session_limit_reached", "the CYCLE budget is what refuses here");
  assert.match(second.detail, /BOX_SESSION_MAX_COMPLETED_TRADES=1/);
  assert.match(second.detail, /only new entry is refused/i, "reduction must stay available");
  assert.equal(t.posts.length, before, "zero further POSTs after the trial's one box closed");
});

test("AFTER AN ATTEMPT ABORTS a second candidate is STILL refused", async () => {
  /*
   * THE OTHER CASE. A rejected, unwound or recovered attempt completes NO cycle and leaves NO
   * inventory, so the cycle gate and both ceilings all see a clean slate. Only the ATTEMPT budget
   * refuses — which is why BOX_SESSION_MAX_ENTRY_ATTEMPTS=1 is required. Without it a trial
   * configured for "one trade" can submit indefinitely provided nothing ever completes.
   */
  const t = trialCoordinator();
  await t.enter(boxFor()); // spends the one attempt
  t.session.record = recordAbortedAttempt(t.session.record, NOW);
  t.inventory.value = 0;

  assert.equal(t.session.record.completed_trade_ids.length, 0, "no cycle completed");
  assert.equal(t.session.record.established_trade_ids.length, 0, "and none was even established");
  const before = t.posts.length;

  const second = await t.enter(boxFor({ k1: 19800, k2: 20000 }));

  assert.equal(second.ok, false);
  assert.equal(second.reason, "session_limit_reached");
  assert.match(second.detail, /BOX_SESSION_MAX_ENTRY_ATTEMPTS=1/);
  assert.match(second.detail, /bounds ATTEMPTS, not completions/);
  assert.equal(t.posts.length, before, "zero further POSTs after the trial's one attempt aborted");
});

test("the refusal happens BEFORE the attempt budget is touched a second time", async () => {
  const t = trialCoordinator();
  await t.enter(boxFor());
  t.session.record = recordCompletedBox(recordEstablishedBox(t.session.record, "t-1", NOW), "t-1", NOW);

  await t.enter(boxFor({ k1: 19800, k2: 20000 }));

  // The session gate sits BEFORE `sessionConsumeAttempt`, so a refused candidate cannot inflate the
  // attempt count — which would otherwise make the trial's own audit trail wrong.
  assert.equal(t.session.record.entry_attempts, 1, "still exactly one attempt on the record");
  assert.equal(t.coordinator.metrics().activeExecutions, 0, "and no claim leaked");
});

/* ═══════════════════ 4. the quantity is DERIVED from the live lot size ═══════════════════ */

test("the arithmetic scales with the lot size — nothing is hardcoded", () => {
  const a = supervisedTrialQuantities({ lotSize: 75, perLegCap: 100, grossCap: 400 });
  assert.equal(a.perLeg, 75);
  assert.equal(a.gross, 300, "75 x 4");
  assert.equal(a.admits, true);
  assert.equal(a.boxesPermittedByGrossCap, 1);

  // A DIFFERENT contract. Neither 75 nor 65 may be baked in anywhere.
  const b = supervisedTrialQuantities({ lotSize: 65, perLegCap: 100, grossCap: 400 });
  assert.equal(b.perLeg, 65);
  assert.equal(b.gross, 260);
  assert.equal(b.admits, true);

  assert.notDeepEqual(a.lines, b.lines, "the report differs with the lot size");
  assert.ok(a.lines.some((l) => l.includes("75 x 4 legs = 300")));
  assert.ok(b.lines.some((l) => l.includes("65 x 4 legs = 260")));
});

test("a lot size the caps cannot carry is reported as REFUSED, not silently passed", () => {
  // Above the per-leg cap: the trial cannot run at all, and the operator must know before arming.
  const tooBig = supervisedTrialQuantities({ lotSize: 150, perLegCap: 100, grossCap: 400 });
  assert.equal(tooBig.perLegOk, false);
  assert.equal(tooBig.admits, false);
  assert.ok(tooBig.lines.some((l) => l.includes("REFUSED")));

  // Under the per-leg cap but over the gross cap — four legs is what breaches it.
  const grossOnly = supervisedTrialQuantities({ lotSize: 120, perLegCap: 200, grossCap: 400 });
  assert.equal(grossOnly.perLegOk, true);
  assert.equal(grossOnly.grossOk, false, "480 > 400");
  assert.equal(grossOnly.admits, false);
});

test("THE TRAP: a SMALLER lot lets the caps permit more than one box, and it says so", () => {
  // The number nobody computes. Caps sized for one box at lot 75 permit TWO at lot 50, so the caps
  // are not a substitute for BOX_MAX_OPEN_BOXES — and an operator reading only the caps would
  // reasonably believe the envelope was one box.
  const small = supervisedTrialQuantities({ lotSize: 50, perLegCap: 100, grossCap: 400 });
  assert.equal(small.gross, 200);
  assert.equal(small.boxesPermittedByGrossCap, 2);
  assert.ok(
    small.lines.some((l) => /MORE THAN ONE/.test(l)),
    "the report must warn that the caps alone do not bound this to one box",
  );
});

test("a missing or nonsensical lot size is REFUSED, never defaulted", () => {
  // FRACTIONS ARE REFUSED TOO, and that is the important addition: this used to `Math.floor` the
  // input, so 65.5 silently became 65 and was then reported as a reading from the instrument master.
  // A lot size is an integer contract property, so a fractional value means the operator mistyped it
  // or is guessing — neither is something to tidy up.
  for (const bad of [0, -75, Number.NaN, Number.POSITIVE_INFINITY, 65.5, 74.9, 0.5]) {
    assert.throws(
      () => supervisedTrialQuantities({ lotSize: bad, perLegCap: 100, grossCap: 400 }),
      /POSITIVE INTEGER/,
      `lotSize=${String(bad)} must throw`,
    );
  }
  // And the refusal still says where to get the real number.
  assert.throws(
    () => supervisedTrialQuantities({ lotSize: 65.5, perLegCap: 100, grossCap: 400 }),
    /refused rather than rounded/,
  );
});

test("a disabled cap is reported as disabled, not as a pass", () => {
  const none = supervisedTrialQuantities({ lotSize: 75, perLegCap: 0, grossCap: 0 });
  assert.equal(none.admits, true, "no cap means nothing refuses");
  assert.equal(none.boxesPermittedByGrossCap, null);
  assert.ok(none.lines.some((l) => /disabled/.test(l)));
  assert.ok(
    none.lines.some((l) => /UNBOUNDED/.test(l)),
    "an operator must not read a disabled gross cap as a one-box envelope",
  );
});

/* ═══════════════════ 5. the preflight report ═══════════════════ */

test("the preflight report shows the four settings AND the arithmetic", () => {
  const text = renderSupervisedTrialPreflight({
    enabled: true,
    settings: ONE_SHOT,
    lotSize: 75,
    perLegCap: 100,
    grossCap: 400,
  });
  for (const spec of SUPERVISED_ONE_SHOT_SETTINGS) assert.ok(text.includes(`${spec.env}=1`), `${spec.env} shown`);
  assert.match(text, /per-leg quantity/);
  assert.match(text, /gross quantity     = 75 x 4 legs = 300/);
  // The verdict now states PASS explicitly, and only when the quantities are admissible too — the
  // old wording ("the four required settings are satisfied and the quantity arithmetic is shown
  // above") was printed even when both caps REFUSED the lot.
  assert.match(text, /VERDICT: PASS/);
  assert.match(text, /one lot of 75 unit\(s\) is admissible under both quantity caps/);
});

test("the preflight report says UNVERIFIED rather than guessing a lot size", () => {
  const text = renderSupervisedTrialPreflight({ enabled: true, settings: ONE_SHOT, lotSize: null, perLegCap: 100, grossCap: 400 });
  assert.match(text, /UNVERIFIED/);
  assert.match(text, /Do not assume 75 or 65/);
  assert.doesNotMatch(text, /gross quantity\s+=/, "no arithmetic may be printed without a real lot size");
  assert.match(text, /VERDICT: NOT VERIFIED/, "UNVERIFIED is not a pass");
  assert.doesNotMatch(text, /VERDICT: PASS/);
});

test("the preflight report does NOT cry FAIL when the profile is off", () => {
  // It previously marked the general-purpose defaults as failures and then concluded that the
  // required settings were satisfied — a self-contradicting report is worse than none.
  const text = renderSupervisedTrialPreflight({
    enabled: false,
    settings: { maxOpenBoxes: 0, liveMaxOpenBoxes: 1, sessionMaxCompletedTrades: 0, sessionMaxEntryAttempts: 0 },
    lotSize: null,
    perLegCap: 100,
    grossCap: 400,
  });
  assert.doesNotMatch(text, /FAIL/);
  assert.match(text, /not required while it is off/);
  assert.match(text, /\(0 = unlimited\)/);
  assert.match(text, /NOT CONFIGURED FOR THE SUPERVISED TRIAL/);
  assert.ok(text.includes(SUPERVISED_TRIAL_ENV));
});

test("the preflight report names STARTUP WOULD BE REFUSED when a bound is wrong", () => {
  const text = renderSupervisedTrialPreflight({
    enabled: true,
    settings: { ...ONE_SHOT, sessionMaxEntryAttempts: 0 },
    lotSize: 75,
    perLegCap: 100,
    grossCap: 400,
  });
  assert.match(text, /STARTUP WOULD BE REFUSED/);
  assert.match(text, /FAIL {2}BOX_SESSION_MAX_ENTRY_ATTEMPTS=0/);
});


/* ═══════════════════ 6. EVERY SHIPPED PROFILE, through the real loader ═══════════════════ */

/*
 * THE AUDIT THIS FOUND, AND WHY A PER-PROFILE TEST WAS NOT ENOUGH.
 *
 * `deploy/mumbai-ec2-conservative.env.example` set BOX_LIVE_MAX_OPEN_BOXES=1,
 * BOX_SESSION_MAX_COMPLETED_TRADES=1 and BOX_SESSION_MAX_ENTRY_ATTEMPTS=1 under a heading that read
 * "one lot per leg, one active box" — and OMITTED `BOX_MAX_OPEN_BOXES` entirely. That is a DIFFERENT
 * variable whose code default is 0 = UNLIMITED, and it is the only MODE-INDEPENDENT inventory
 * ceiling: the only one enforced in the coordinator's admission prologue, therefore the only one
 * that counts in-flight entry claims, and the only one a PAPER rehearsal exercises at all. The file
 * read as a one-box trial and was not one. `deploy/live-1lot-4concurrent.env.template` had the same
 * hole under a section literally headed "ONE BOX".
 *
 * The existing `trialProfile.test.mjs` asserts one profile, key by key, so a second profile with the
 * same omission passes unnoticed. This sweeps EVERY shipped profile and derives the requirement from
 * the profile's OWN declared intent, so a newly added trial profile is covered the day it lands.
 */

import { readdirSync, readFileSync } from "node:fs";

function parseEnvFile(text) {
  const out = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    const value = line
      .slice(eq + 1)
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^["']|["']$/g, "");
    out.set(key, value);
  }
  return out;
}

/** Resolve one profile through the REAL loader in a pristine environment. */
function configFromProfile(vars) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("BOX_") || key.startsWith("DHAN_") || key.startsWith("ZERODHA_")) delete process.env[key];
    }
    for (const [k, v] of vars) process.env[k] = v;
    return loadBoxConfig();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const PROFILES = readdirSync(new URL("../../deploy/", import.meta.url))
  .filter((name) => name.includes(".env."))
  .map((name) => ({
    name,
    vars: parseEnvFile(readFileSync(new URL(`../../deploy/${name}`, import.meta.url), "utf8")),
  }));

test("every shipped profile still LOADS — the new requirement breaks none of them", () => {
  assert.ok(PROFILES.length >= 6, `the deploy directory should hold the profiles (found ${PROFILES.length})`);
  for (const { name, vars } of PROFILES) {
    assert.doesNotThrow(() => configFromProfile(vars), `${name} must resolve through loadBoxConfig`);
  }
});

test("every profile that CLAIMS the supervised trial actually satisfies all four bounds", () => {
  const claiming = PROFILES.filter(({ vars }) => vars.get("BOX_SUPERVISED_ONE_LOT_TRIAL") === "true");
  assert.ok(claiming.length >= 5, `the supervised profiles should declare the flag (found ${claiming.length})`);

  for (const { name, vars } of claiming) {
    const c = configFromProfile(vars);
    assert.equal(c.supervisedOneLotTrial, true, `${name} resolves the flag as on`);
    // Guaranteed by the loader's refusal, asserted here so the guarantee is visible and so a
    // regression in the refusal itself is caught rather than silently widening every trial profile.
    assert.deepEqual(supervisedTrialViolations(c), [], `${name} has no unbounded one-shot setting`);
    for (const spec of SUPERVISED_ONE_SHOT_SETTINGS) {
      assert.equal(c[spec.field], 1, `${name}: ${spec.env} must be 1`);
    }
  }
});

test("THE REGRESSION: a one-box profile may not leave BOX_MAX_OPEN_BOXES absent", () => {
  /*
   * Derived from each profile's OWN declaration rather than from a hardcoded list of filenames, so
   * this cannot rot: any profile that pins the session to a single cycle AND a single attempt is a
   * one-shot trial by construction, whatever it is called, and must bound inventory too.
   */
  const oneShot = PROFILES.filter(({ vars }) => {
    const c = configFromProfile(vars);
    return c.sessionMaxCompletedTrades === 1 && c.sessionMaxEntryAttempts === 1;
  });
  assert.ok(oneShot.length >= 5, `expected the one-shot profiles (found ${oneShot.length})`);

  for (const { name, vars } of oneShot) {
    assert.ok(
      vars.has("BOX_MAX_OPEN_BOXES"),
      `${name} bounds the session to one cycle and one attempt but never sets BOX_MAX_OPEN_BOXES — ` +
        `a DIFFERENT variable from BOX_LIVE_MAX_OPEN_BOXES, defaulting to 0 = UNLIMITED, and the only ` +
        `mode-independent inventory ceiling`,
    );
    assert.equal(configFromProfile(vars).maxOpenBoxes, 1, `${name}: the effective ceiling must be 1`);
  }
});

test("the MULTIBOX paper profile is deliberately NOT a supervised trial", () => {
  // The other half of "preserve general-purpose defaults outside that profile": a profile that means
  // to hold several boxes must keep working, and must not be swept up by the new requirement.
  const multibox = PROFILES.find((p) => p.name.includes("paper-parity-multibox"));
  assert.ok(multibox, "the multibox paper profile should exist");

  const c = configFromProfile(multibox.vars);
  assert.equal(c.supervisedOneLotTrial, false, "it must NOT claim the profile");
  assert.ok(c.maxOpenBoxes > 1, `and it keeps its real ceiling (${c.maxOpenBoxes})`);
  assert.ok(c.sessionMaxCompletedTrades > 1);
  assert.ok(c.sessionMaxEntryAttempts > 1);
  // Which means violations exist — and are correctly irrelevant, because the flag is off.
  assert.ok(supervisedTrialViolations(c).length > 0, "it would violate the profile, which is fine");
  assert.equal(supervisedTrialStartupRefusal(false, c), null, "and nothing refuses it");
});
