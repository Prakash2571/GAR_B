/**
 * A PROFILE CLAIMING "EXACTLY ONE LOT" MUST BE ARITHMETICALLY CAPABLE OF MEANING IT.
 *
 * The order quantity actually sent is always `candidate.lot_size`, read from the live instrument
 * master. It is never a number from an env file, and nothing here changes that. The two live
 * quantity ceilings are a CONTAINMENT CHECK on that quantity — which means they have to agree with
 * it, and when they stop agreeing the failure is silent in one direction and total in the other:
 *
 *   per-leg cap BELOW one lot  -> every entry refused, indistinguishable from "nothing qualifies"
 *   gross cap ABOVE four lots  -> more exposure permitted than the profile advertises
 *
 * THIS ALREADY HAPPENED. `FINAL-one-box-live.env.template` shipped 75 / 300 with a note reading
 * "75 is only right while NIFTY's is 75". NIFTY's lot moved to 65. The per-leg figure was updated
 * and the gross figure was not, leaving a gross ceiling of 300 against a real four-leg lot of 260 —
 * an envelope 15% wider than the profile claimed, reported nowhere.
 *
 * WHAT IS CHECKED AT BOOT, AND WHY NOT MORE. The lot size is not knowable at config load: it belongs
 * to an instrument master that has not loaded yet, and hardcoding it here would recreate the exact
 * staleness being guarded against. What IS knowable is internal consistency — four legs of one lot
 * is four times one leg of one lot, whatever the lot is. So the boot check is `gross === 4 x perLeg`,
 * which catches the 300-vs-260 drift without asserting what the lot size is.
 *
 * Comparing the ceilings against the SELECTED underlying's real `lot_size` is a runtime readiness
 * question and is deliberately not attempted at boot.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

/**
 * The minimum a live boot needs before it reaches the exact-one-lot check. Every earlier refusal in
 * `loadBoxConfig` is satisfied here deliberately, so a failure in this file is about THIS check and
 * not about an unrelated live precondition.
 */
const LIVE = {
  BOX_EXECUTION_MODE: "live",
  BOX_LIVE_TRADING_ENABLED: "true",
  BOX_PAPER_EXECUTION_PROFILE: "standard",
  BOX_SHADOW_MODE_ENABLED: "false",
  BOX_EXECUTION_COORDINATOR_ENABLED: "true",
  BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "100000",
};

/* ───────────────── the declared relationship is enforced in live ───────────────── */

test("a consistent one-lot profile loads (65 / 260)", () => {
  withEnv(
    {
      ...LIVE,
      BOX_LIVE_EXACT_ONE_LOT: "true",
      BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "65",
      BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "260",
    },
    () => {
      const cfg = loadBoxConfig();
      assert.equal(cfg.liveMaxOpenLegQuantity, 65);
      assert.equal(cfg.liveMaxGrossOpenLegQuantity, 260);
      assert.equal(cfg.liveExactOneLot, true);
    },
  );
});

test("the EXACT drift that shipped — per-leg updated to 65, gross left at 300 — refuses to boot", () => {
  withEnv(
    {
      ...LIVE,
      BOX_LIVE_EXACT_ONE_LOT: "true",
      BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "65",
      BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "300",
    },
    () => {
      assert.throws(
        () => loadBoxConfig(),
        (err) => {
          assert.match(err.message, /BOX_LIVE_EXACT_ONE_LOT/);
          assert.match(err.message, /260/, "the refusal must name the figure that would be correct");
          assert.match(err.message, /instrument master/, "and must say where quantity really comes from");
          return true;
        },
      );
    },
  );
});

test("the reverse drift — gross updated, per-leg left stale — also refuses", () => {
  withEnv(
    {
      ...LIVE,
      BOX_LIVE_EXACT_ONE_LOT: "true",
      BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "75",
      BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "260",
    },
    () => assert.throws(() => loadBoxConfig(), /BOX_LIVE_EXACT_ONE_LOT/),
  );
});

test("the check is lot-size agnostic: any lot works so long as the two agree", () => {
  // PAYTM's 725 is as valid as NIFTY's 65 — the check asserts a RELATIONSHIP, never a lot size.
  for (const [perLeg, gross] of [["725", "2900"], ["25", "100"], ["1", "4"]]) {
    withEnv(
      {
        ...LIVE,
        BOX_LIVE_EXACT_ONE_LOT: "true",
        BOX_LIVE_MAX_OPEN_LEG_QUANTITY: perLeg,
        BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: gross,
      },
      () => {
        assert.equal(loadBoxConfig().liveMaxGrossOpenLegQuantity, Number(gross));
      },
    );
  }
  // ...and 65 with a gross that is 3x or 5x is refused, so the multiplier itself is pinned at 4.
  for (const wrong of ["195", "325"]) {
    withEnv(
      {
        ...LIVE,
        BOX_LIVE_EXACT_ONE_LOT: "true",
        BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "65",
        BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: wrong,
      },
      () => assert.throws(() => loadBoxConfig(), /BOX_LIVE_EXACT_ONE_LOT/),
    );
  }
});

/* ───────────────── scope: opt-in, live-only, and typo-proof ───────────────── */

test("an inconsistent pair is allowed when the profile does NOT claim exactly one lot", () => {
  // A multi-lot or multi-box posture legitimately sizes gross to something other than 4x.
  withEnv(
    {
      ...LIVE,
      BOX_LIVE_EXACT_ONE_LOT: undefined,
      BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "65",
      BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "1300",
    },
    () => {
      const cfg = loadBoxConfig();
      assert.equal(cfg.liveExactOneLot, false, "unset means the profile makes no such claim");
      assert.equal(cfg.liveMaxGrossOpenLegQuantity, 1300);
    },
  );
});

test("PAPER is untouched even with an inconsistent pair and the flag set", () => {
  withEnv(
    {
      BOX_EXECUTION_MODE: "paper_latency",
      BOX_LIVE_EXACT_ONE_LOT: "true",
      BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "65",
      BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "300",
    },
    () => {
      // The ceilings are live-only, so a paper rehearsal must not be blocked by their arithmetic.
      assert.equal(loadBoxConfig().executionMode, "paper_latency");
    },
  );
});

test("a typo in the declaration cannot silently disable the check", () => {
  // `strictBool`, not `bool`: reading "ture" as false would turn the guard off in the one profile
  // that asked for it, which is the failure mode the guard exists to prevent.
  withEnv(
    {
      ...LIVE,
      BOX_LIVE_EXACT_ONE_LOT: "ture",
      BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "65",
      BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "300",
    },
    () => assert.throws(() => loadBoxConfig(), /BOX_LIVE_EXACT_ONE_LOT/),
  );
});

/* ───────────── the shipped profile must satisfy its own claim ───────────── */

/**
 * The template is the artefact an operator actually copies, so it is asserted directly. Without
 * this, the boot check would be correct and the shipped file could still be wrong — which is the
 * situation that produced 65/300 in the first place.
 */
test("deploy/FINAL-one-box-live.env.template is internally consistent with its own claim", () => {
  const text = readFileSync(new URL("../../deploy/FINAL-one-box-live.env.template", import.meta.url), "utf8");
  const value = (name) => {
    const match = text.match(new RegExp(`^${name}=(\\S+)`, "m"));
    assert.ok(match, `${name} must be present in the final one-box profile`);
    return match[1];
  };

  assert.equal(value("BOX_LIVE_EXACT_ONE_LOT"), "true", "the final one-box profile claims exactly one lot");
  const perLeg = Number(value("BOX_LIVE_MAX_OPEN_LEG_QUANTITY"));
  const gross = Number(value("BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY"));
  assert.equal(
    gross,
    perLeg * 4,
    `the profile claims exactly one lot, so gross (${gross}) must be 4 x per-leg (${perLeg}) = ${perLeg * 4}`,
  );

  // The supervised posture the brief pins: serial submission and one concurrent execution.
  assert.equal(value("BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY"), "1", "first live run submits serially");
  assert.equal(value("BOX_LIVE_MAX_CONCURRENT_EXECUTIONS"), "1");

  // The tightened individual quote age — low single-digit seconds, not the general 15s ceiling.
  const quoteAge = Number(value("BOX_QUOTE_MAX_AGE_MS"));
  assert.ok(
    quoteAge > 0 && quoteAge <= 5000,
    `the supervised profile must tighten the quote age to low single-digit seconds, got ${quoteAge}`,
  );

  /*
   * The cross-leg EXCHANGE dispersion bound must NOT have been "tightened" to match. Kite stamps
   * books in whole seconds, so any value below 1000 is a hair trigger that refused 100% of entries
   * on a healthy feed once already. Sub-second coherence is the RECEIVE-time gate's job.
   */
  const exchangeDispersion = Number(value("BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS"));
  assert.ok(
    exchangeDispersion === 0 || exchangeDispersion >= 1000,
    `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS=${exchangeDispersion} recreates the 250ms hair trigger; ` +
      `Kite's whole-second stamps make anything in (0,1000) unsatisfiable`,
  );
  assert.ok(
    Number(value("BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS")) > 0,
    "receive-time dispersion is the precise sub-second gate and must stay enabled",
  );
});
