/**
 * "ONE LOT" CANNOT BE A FIXED UNIT NUMBER WHEN THE UNIVERSE IS OPEN.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `BOX_LIVE_MAX_OPEN_LEG_QUANTITY` is an ABSOLUTE UNIT ceiling. For a trial pinned to one underlying
 * that is fine: set it to that instrument's lot size and it reads as "one lot".
 *
 * It breaks the moment `BOX_LIVE_ALLOWED_UNDERLYINGS` is emptied to trade any name with the blocklist
 * as the exclusion mechanism — a perfectly coherent posture the code already supports. Exchange lot
 * sizes differ by an order of magnitude across the F&O universe, so ONE unit number cannot mean "one
 * lot" for more than one instrument. The shipped trial profile sets 65; a name whose lot is 500 is
 * then refused as `lot_exceeds_quantity_cap` while the configuration still reads like a one-lot bound.
 *
 * Raising the unit cap to cover the largest lot is not a fix: it stops bounding one lot for everything
 * smaller, which is the entire rest of the universe.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE FIX, AND THE SAFETY CONSTRAINT THAT SHAPED IT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `BOX_LIVE_MAX_LOTS_PER_LEG` adds a LOT-RELATIVE bound beside the unit one. Both are enforced and
 * the tighter governs.
 *
 * The unit cap is deliberately NOT made disableable, and that is a safety finding rather than a
 * preference: `BoxOrderManager.queuedActionBlockReason` gates a queued REDUCTION on
 * `request.quantity <= maxOpenLegQuantity`, so a cap of 0 would refuse to send exits and strand real
 * exposure. `liveMaxOpenLegQuantity` is clamped to a minimum of 1, the lot bound is ADDITIVE, and no
 * reduction path changed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateQuantityEnvelope, ENVELOPE_LEG_COUNT } from "../../dist/box/quantityEnvelope.js";
import { loadBoxConfig } from "../../dist/box/config.js";
import { allowlistEntryRefusal } from "../../dist/box/underlyingExclusions.js";

/** Real-ish spread of F&O lot sizes, to make the point that one number cannot serve them all. */
const LOTS = { NIFTY: 75, BANKNIFTY: 35, RELIANCE: 500, INFY: 400, ITC: 1600 };

const envelope = (over = {}) =>
  evaluateQuantityEnvelope({
    lotSize: 75,
    perLegUnitCap: 100,
    grossUnitCap: 400,
    maxLotsPerLeg: 0,
    ...over,
  });

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

/* ═══════════════════ 1. the default is UNCHANGED ═══════════════════ */

test("DISABLED BY DEFAULT: lots=0 reproduces the absolute-unit-cap behaviour exactly", () => {
  assert.equal(loadBoxConfig().liveMaxLotsPerLeg, 0, "unset means disabled");

  // At the shipped caps, 75 fits and 101 does not — exactly as before this change.
  assert.equal(envelope({ lotSize: 75 }).admits, true);
  assert.equal(envelope({ lotSize: 100 }).admits, true, "equal to the cap is admitted");
  assert.equal(envelope({ lotSize: 101 }).admits, false);
  assert.equal(envelope({ lotSize: 101 }).perLegLimitSource, "unit_cap");
});

test("THE DEFECT: with only a unit cap, most of the universe is refused", () => {
  // The shipped trial profile's cap of 65, against a real spread of lot sizes.
  const refused = [];
  const admitted = [];
  for (const [name, lotSize] of Object.entries(LOTS)) {
    const v = envelope({ lotSize, perLegUnitCap: 65, grossUnitCap: 260 });
    (v.admits ? admitted : refused).push(name);
  }
  // Only the names whose lot happens to fit UNDER 65 survive — which is an accident of that
  // instrument's lot size, not a risk decision anyone made.
  assert.deepEqual(admitted, ["BANKNIFTY"], "only the lot smaller than the cap gets through");
  assert.deepEqual(
    refused,
    ["NIFTY", "RELIANCE", "INFY", "ITC"],
    "a cap of 65 refuses NIFTY at 75 and everything larger",
  );
  // And note what "passing" means for the one that got through: the cap is NOT bounding it to one
  // lot, it is bounding it to 65 units of a 35-unit lot — i.e. it would admit one lot and no more
  // only by coincidence. That is the incoherence the lot-relative bound removes.
  assert.equal(envelope({ lotSize: 35, perLegUnitCap: 65, grossUnitCap: 260 }).perLegLimit, 65);
});

/* ═══════════════════ 2. the lot-relative bound admits one lot of anything ═══════════════════ */

test("THE FIX: lots=1 with a generous unit backstop admits one lot of EVERY underlying", () => {
  for (const [name, lotSize] of Object.entries(LOTS)) {
    const v = evaluateQuantityEnvelope({
      lotSize,
      // A real absolute backstop, sized above the largest lot we are willing to carry.
      perLegUnitCap: 2_000,
      grossUnitCap: 8_000,
      maxLotsPerLeg: 1,
    });
    assert.equal(v.admits, true, `one lot of ${name} (${lotSize}) must be admissible: ${v.refusal}`);
    assert.equal(v.quantityPerLeg, lotSize);
    assert.equal(v.gross, lotSize * ENVELOPE_LEG_COUNT);
  }
});

test("lots=1 still refuses TWO lots, whatever the instrument", () => {
  for (const [name, lotSize] of Object.entries(LOTS)) {
    const v = evaluateQuantityEnvelope({
      lotSize,
      perLegUnitCap: 100_000,
      grossUnitCap: 400_000,
      maxLotsPerLeg: 1,
      quantityPerLeg: lotSize * 2,
    });
    assert.equal(v.admits, false, `two lots of ${name} must be refused`);
    assert.equal(v.perLegLimitSource, "lots");
    assert.match(v.refusal, /BOX_LIVE_MAX_LOTS_PER_LEG=1/);
    assert.match(v.refusal, /expressed in LOTS/);
  }
});

test("the lot bound scales with the instrument, which is the entire point", () => {
  const reliance = evaluateQuantityEnvelope({ lotSize: 500, perLegUnitCap: 2_000, grossUnitCap: 8_000, maxLotsPerLeg: 1 });
  const nifty = evaluateQuantityEnvelope({ lotSize: 75, perLegUnitCap: 2_000, grossUnitCap: 8_000, maxLotsPerLeg: 1 });

  assert.equal(reliance.perLegLimit, 500, "one lot of RELIANCE");
  assert.equal(nifty.perLegLimit, 75, "one lot of NIFTY");
  assert.notEqual(reliance.perLegLimit, nifty.perLegLimit, "a fixed unit number could not do this");
});

/* ═══════════════════ 3. the TIGHTER of the two governs ═══════════════════ */

test("BOTH bounds configured: the tighter one governs, and it names which", () => {
  // Unit cap tighter: lot 500, lots=1 would allow 500, but the unit cap says 300.
  const unitTighter = evaluateQuantityEnvelope({
    lotSize: 500, perLegUnitCap: 300, grossUnitCap: 8_000, maxLotsPerLeg: 1,
  });
  assert.equal(unitTighter.perLegLimit, 300);
  assert.equal(unitTighter.perLegLimitSource, "unit_cap");
  assert.equal(unitTighter.admits, false, "500 > 300");
  assert.match(unitTighter.refusal, /BOX_LIVE_MAX_OPEN_LEG_QUANTITY=300/);
  // The refusal must point at the lot-relative bound as the remedy for a multi-underlying posture.
  assert.match(unitTighter.refusal, /BOX_LIVE_MAX_LOTS_PER_LEG=1/);

  // Lots tighter: unit cap 2000 would allow it, one lot is 500.
  const lotsTighter = evaluateQuantityEnvelope({
    lotSize: 500, perLegUnitCap: 2_000, grossUnitCap: 8_000, maxLotsPerLeg: 1, quantityPerLeg: 1_000,
  });
  assert.equal(lotsTighter.perLegLimit, 500);
  assert.equal(lotsTighter.perLegLimitSource, "lots");
  assert.equal(lotsTighter.admits, false, "1000 > 500");
});

test("the unit cap remains a real absolute backstop, not decoration", () => {
  // THE SAFETY PROPERTY. Even with a lot bound configured, a pathologically large lot is still
  // refused by the absolute ceiling — the lot bound cannot be used to smuggle unlimited size in.
  const v = evaluateQuantityEnvelope({
    lotSize: 50_000, perLegUnitCap: 2_000, grossUnitCap: 8_000, maxLotsPerLeg: 1,
  });
  assert.equal(v.admits, false);
  assert.equal(v.perLegLimitSource, "unit_cap");
});

test("the GROSS cap is still enforced, and names the 4x relationship", () => {
  const v = evaluateQuantityEnvelope({
    lotSize: 500, perLegUnitCap: 2_000, grossUnitCap: 1_000, maxLotsPerLeg: 1,
  });
  assert.equal(v.admits, false, "4 x 500 = 2000 > 1000");
  assert.match(v.refusal, /BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=1000/);
  assert.match(v.refusal, /at least 4x/);
});

test("a zero or missing lot size does not silently refuse everything", () => {
  // A lot-relative bound needs a lot size to mean anything. With none, the bound does not apply
  // rather than collapsing to 0 and refusing every instrument.
  const v = evaluateQuantityEnvelope({
    lotSize: 0, perLegUnitCap: 100, grossUnitCap: 400, maxLotsPerLeg: 1, quantityPerLeg: 75,
  });
  assert.equal(v.perLegLimitSource, "unit_cap", "the lot bound is inert without a lot size");
  assert.equal(v.admits, true, "75 still fits the unit cap");
});

/* ═══════════════════ 4. the config surface ═══════════════════ */

test("the loader clamps the lot count and refuses a typo", () => {
  withEnv({ BOX_LIVE_MAX_LOTS_PER_LEG: "1" }, () => {
    assert.equal(loadBoxConfig().liveMaxLotsPerLeg, 1);
  });
  withEnv({ BOX_LIVE_MAX_LOTS_PER_LEG: "one" }, () => {
    // strictLimitInt: a typo must not silently disable a ceiling.
    assert.throws(() => loadBoxConfig(), /BOX_LIVE_MAX_LOTS_PER_LEG/);
  });
});

test("EXACT_ONE_LOT and a MULTI-lot allowance is a contradiction, and is refused at boot", () => {
  const base = {
    BOX_EXECUTION_MODE: "live",
    BOX_LIVE_TRADING_ENABLED: "true",
    BOX_LIVE_EXACT_ONE_LOT: "true",
    BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "2000",
    BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "8000",
    BOX_LIVE_MAX_BOX_CAPITAL_RUPEES: "100000",
  };
  // lots=1 is CONSISTENT with "exactly one lot" — and is the intended any-underlying pairing.
  withEnv({ ...base, BOX_LIVE_MAX_LOTS_PER_LEG: "1" }, () => {
    assert.doesNotThrow(() => loadBoxConfig(), "one lot per leg agrees with the assertion");
  });
  // lots=3 contradicts it, so it is refused rather than one of them silently winning.
  withEnv({ ...base, BOX_LIVE_MAX_LOTS_PER_LEG: "3" }, () => {
    assert.throws(() => loadBoxConfig(), /declares an envelope of exactly ONE lot per leg/);
    assert.throws(() => loadBoxConfig(), /BOX_LIVE_MAX_LOTS_PER_LEG=3/);
  });
});

/* ═══════════════════ 5. "any underlying EXCEPT the excluded" ═══════════════════ */

test("an EMPTY allowlist means any underlying — the posture the operator asked for", () => {
  // This already worked and must keep working: unset is how every deployment is configured, and
  // reading it as "nothing may trade" would be a silent total halt.
  for (const name of Object.keys(LOTS)) {
    assert.equal(allowlistEntryRefusal([], name), null, `${name} is admissible with no allowlist`);
  }
  assert.equal(loadBoxConfig().liveAllowedUnderlyings.length, 0, "unset resolves to unconstrained");
});

test("a NON-empty allowlist still fails CLOSED on anything not named", () => {
  assert.equal(allowlistEntryRefusal(["NIFTY"], "NIFTY"), null);
  const refused = allowlistEntryRefusal(["NIFTY"], "RELIANCE");
  assert.notEqual(refused, null, "a name not on a non-empty list cannot be entered");
});

test("the two mechanisms compose: open allowlist, blocklist still refuses", () => {
  /*
   * The operator's stated posture — "any stock except the ones I excluded" — is the empty allowlist
   * plus a populated blocklist. These are separate controls on purpose: an allowlist fails closed on
   * names added after it was written, a blocklist fails open on them. For "everything except a few",
   * the blocklist is the right tool and the allowlist must be empty.
   */
  assert.equal(allowlistEntryRefusal([], "RELIANCE"), null, "the allowlist permits it");
  // And the blocklist is what withholds it; exercised against the real exclusion verdict in
  // tests/box/underlyingExclusions*.test.mjs, so this asserts only the composition point.
  assert.equal(loadBoxConfig().liveAllowedUnderlyings.length, 0);
});
