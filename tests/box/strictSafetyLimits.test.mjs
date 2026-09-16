/**
 * A SAFETY LIMIT MUST NEVER BE DEFAULTED AWAY BY A TYPO.
 *
 * Every assertion describes DESIRED behaviour and FAILS on 7653e26, where `clampInt` funnelled every
 * kind of bad input to the fallback or the nearest bound. For the containment limits — the ones where
 * `fallback === min === 0` AND `0` means "unlimited" — that turned an operator's typo into the silent
 * REMOVAL of the limit:
 *
 *     BOX_SESSION_MAX_ENTRY_ATTEMPTS="one"  -> NaN -> fallback 0 -> UNLIMITED attempts
 *     BOX_SESSION_MAX_ENTRY_ATTEMPTS="-1"   -> -1  -> clamp to 0 -> UNLIMITED attempts
 *     BOX_SESSION_MAX_ENTRY_ATTEMPTS="0.2"  -> 0.2 -> round to 0 -> UNLIMITED attempts
 *
 * For a one-attempt supervised trial that is the single most important containment on the page, and it
 * failed in the most permissive direction available.
 *
 * The distinction being pinned is MISSING vs EXPLICITLY WRONG: an unset variable is a deliberate
 * "use the default" and must stay silent, while a value the operator took the trouble to set
 * incorrectly must be refused rather than reinterpreted.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { loadBoxConfig } = await import("../../dist/box/config.js");

/** Load config with `env` applied, always restoring the previous environment. */
function withEnv(env, fn) {
  const saved = new Map();
  for (const key of Object.keys(env)) {
    saved.set(key, process.env[key]);
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The containment limits where an invalid value used to mean "no limit". */
const CONTAINMENT = [
  "BOX_SESSION_MAX_ENTRY_ATTEMPTS",
  "BOX_SESSION_MAX_COMPLETED_TRADES",
  "BOX_LIVE_MAX_BOX_CAPITAL_RUPEES",
  "BOX_LIVE_RECOVERY_RESERVE_RUPEES",
  "BOX_LIVE_MAX_OPEN_LEG_QUANTITY",
  "BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY",
  "BOX_LIVE_MAX_OPEN_BOXES",
  "BOX_LIVE_DAILY_LOSS_LIMIT",
];

test("C1: a NON-NUMERIC safety limit is refused, not silently defaulted", () => {
  for (const key of CONTAINMENT) {
    assert.throws(
      () => withEnv({ [key]: "one" }, () => loadBoxConfig()),
      (error) => {
        assert.match(error.message, new RegExp(key), "the message must name the offending variable");
        assert.match(error.message, /is not a number/);
        return true;
      },
      `${key}="one" must be refused`,
    );
  }
});

test("C2: a NEGATIVE safety limit is refused, not clamped to the unlimited value", () => {
  // This is the subtler half: rejecting only NaN would still let "-1" clamp to 0 = unlimited.
  for (const key of CONTAINMENT) {
    assert.throws(
      () => withEnv({ [key]: "-1" }, () => loadBoxConfig()),
      /outside the permitted range/,
      `${key}="-1" must be refused`,
    );
  }
});

test("C3: a FRACTIONAL safety limit is refused, not rounded", () => {
  // "0.2" rounded to 0 means UNLIMITED; "0.6" rounded to 1 means one attempt. Rounding a containment
  // limit silently changes what the operator asked for, in a direction they cannot predict.
  for (const key of CONTAINMENT) {
    assert.throws(
      () => withEnv({ [key]: "0.2" }, () => loadBoxConfig()),
      /must be a WHOLE number/,
      `${key}="0.2" must be refused`,
    );
  }
});

test("C4: an OUT-OF-RANGE limit is refused rather than silently narrowed", () => {
  assert.throws(
    () => withEnv({ BOX_SESSION_MAX_ENTRY_ATTEMPTS: "999999" }, () => loadBoxConfig()),
    /outside the permitted range/,
    "silently narrowing a limit hides the mistake",
  );
});

test("C5: an ABSENT variable still uses the default, silently", () => {
  const cfg = withEnv(Object.fromEntries(CONTAINMENT.map((k) => [k, undefined])), () => loadBoxConfig());
  assert.equal(cfg.sessionMaxEntryAttempts, 0, "unset means unlimited, which is the documented default");
  assert.equal(cfg.sessionMaxCompletedTrades, 0);
  assert.ok(cfg.liveMaxGrossOpenLegQuantity > 0, "the quantity caps keep their real defaults");
});

test("C6: a BLANK variable is treated as absent, not as invalid", () => {
  // Empty values are routine in generated .env files and must not be a boot failure.
  const cfg = withEnv({ BOX_SESSION_MAX_ENTRY_ATTEMPTS: "   " }, () => loadBoxConfig());
  assert.equal(cfg.sessionMaxEntryAttempts, 0);
});

test("C7: VALID explicit values are honoured exactly — including a deliberate 0", () => {
  const one = withEnv(
    { BOX_SESSION_MAX_ENTRY_ATTEMPTS: "1", BOX_SESSION_MAX_COMPLETED_TRADES: "1" },
    () => loadBoxConfig(),
  );
  assert.equal(one.sessionMaxEntryAttempts, 1, "the one-attempt supervised trial setting must work");
  assert.equal(one.sessionMaxCompletedTrades, 1);

  // An EXPLICIT zero is a legitimate choice (unlimited) and must be distinguishable from a typo.
  const explicitZero = withEnv({ BOX_SESSION_MAX_ENTRY_ATTEMPTS: "0" }, () => loadBoxConfig());
  assert.equal(explicitZero.sessionMaxEntryAttempts, 0);
});

test("C8: the quantity caps accept a real one-lot configuration", () => {
  const cfg = withEnv(
    { BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "75", BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "300" },
    () => loadBoxConfig(),
  );
  assert.equal(cfg.liveMaxOpenLegQuantity, 75);
  assert.equal(cfg.liveMaxGrossOpenLegQuantity, 300);
});

test("C9: unrelated lenient parsing is UNCHANGED — this fix is scoped", () => {
  // `BOX_MAX_UNDERLYINGS` legitimately uses 0 for "unbounded universe" and is not a live-risk
  // containment limit; widening the strict treatment to every knob was explicitly out of scope.
  assert.doesNotThrow(() => withEnv({ BOX_MAX_UNDERLYINGS: "not-a-number" }, () => loadBoxConfig()));
});
