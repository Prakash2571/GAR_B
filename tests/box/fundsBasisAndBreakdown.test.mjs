/**
 * THE FUNDS HEADLINE MUST BE EXPLAINABLE, AND ITS BASIS MUST BE DELIBERATE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE REPORTED PROBLEM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * An operator saw roughly ₹96,000 of "available margin to trade" while their Zerodha account had
 * about ₹3.9 lakh available. The adapter read exactly two numbers out of a response carrying a dozen
 * — `available.live_balance` and `utilised.debits` — and discarded the rest, so there was no way to
 * see WHICH component accounted for the difference. `available.collateral` was never read anywhere in
 * the repository, and an account whose trading power comes from pledged holdings carries most of its
 * margin there.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT FIXED HERE, DELIBERATELY
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The DEFAULT figure is UNCHANGED. Silently switching to a larger number would be the dangerous
 * direction: `fundsSemantics.ts` documents the asymmetry — overstating spendable funds admits an
 * entry the account cannot fund, the broker rejects a leg mid-sequence, and there is
 * partially-executed exposure to recover from. Understating merely refuses affordable entries.
 *
 * And it is genuinely ambiguous which figure is right without the account's own payload: ₹96,000 may
 * be CORRECT (₹3.9L of cash with ₹2.94L already utilised nets to exactly that). Zerodha's support
 * documentation also states the available figure already reflects collateral benefits — if true for
 * `live_balance`, adding collateral would DOUBLE-COUNT it.
 *
 * So: the full breakdown is published so the question is answerable from evidence, and the choice is
 * exposed as configuration with the conservative default. These tests pin both halves.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FUNDS_BASIS,
  FUNDS_BASES,
  isFundsBasis,
  resolveAvailableForBasis,
  usableFundsRupees,
} from "../../dist/box/fundsSemantics.js";
import { AccountFundsTracker, unavailableFunds } from "../../dist/box/accountFunds.js";
import { loadBoxConfig } from "../../dist/box/config.js";

/**
 * A realistic Kite equity payload for the reported account shape: the cash side is small and the
 * trading power is pledged collateral.
 */
const COLLATERAL_ACCOUNT = {
  net: 96_000,
  "available.cash": 96_000,
  "available.live_balance": 96_000,
  "available.collateral": 294_000,
  "available.opening_balance": 96_000,
  "utilised.debits": 0,
  "utilised.span": 0,
};

/** The other explanation for the same headline: plenty of cash, most of it already utilised. */
const UTILISED_ACCOUNT = {
  net: 96_000,
  "available.cash": 390_000,
  "available.live_balance": 96_000,
  "available.collateral": 0,
  "utilised.debits": 294_000,
};

const zerodha = (components, basis) =>
  usableFundsRupees({
    broker: "zerodha",
    availableRupees: components["available.live_balance"] ?? null,
    utilisedRupees: components["utilised.debits"] ?? null,
    components,
    basis,
  });

/* ═══════════════════ 1. the default is UNCHANGED ═══════════════════ */

test("the DEFAULT basis is live_balance, and it is what the shipped behaviour always was", () => {
  assert.equal(DEFAULT_FUNDS_BASIS, "live_balance");

  // Omitting the basis entirely must equal asking for the default explicitly, and both must equal
  // the raw field the adapter has always returned.
  const omitted = usableFundsRupees({
    broker: "zerodha",
    availableRupees: 96_000,
    utilisedRupees: 0,
    components: COLLATERAL_ACCOUNT,
  });
  assert.equal(omitted.value_rupees, 96_000);
  assert.equal(zerodha(COLLATERAL_ACCOUNT, "live_balance").value_rupees, 96_000);
  assert.equal(zerodha(COLLATERAL_ACCOUNT, undefined).value_rupees, 96_000);
});

test("callers that supply NO breakdown behave exactly as before", () => {
  // The components argument is optional on purpose: every existing caller and test keeps working, and
  // a broker adapter that cannot supply a breakdown is not penalised for it.
  const v = usableFundsRupees({ broker: "zerodha", availableRupees: 47_250, utilisedRupees: 12_000 });
  assert.equal(v.value_rupees, 47_250);
  assert.equal(v.encumbranceNettedFromAvailable, true, "utilised is NOT subtracted for zerodha");
});

test("an unrecognised BOX_ZERODHA_FUNDS_BASIS falls back to the CONSERVATIVE default", () => {
  // A typo must never resolve to the permissive basis. This is the same discipline the other safety
  // switches use, and it matters more here because the permissive value is the one that can admit an
  // entry the account cannot fund.
  assert.equal(isFundsBasis("live_balance_plus_collateral"), true);
  assert.equal(isFundsBasis("live_balance_plus_colateral"), false, "a typo is not a basis");
  assert.equal(isFundsBasis("NET"), false, "case-sensitive after the loader lowercases");
  assert.equal(isFundsBasis(""), false);
  assert.equal(isFundsBasis(undefined), false);

  const saved = process.env.BOX_ZERODHA_FUNDS_BASIS;
  try {
    process.env.BOX_ZERODHA_FUNDS_BASIS = "live_balance_plus_colateral";
    assert.equal(loadBoxConfig().zerodhaFundsBasis, "live_balance", "typo -> conservative default");
    process.env.BOX_ZERODHA_FUNDS_BASIS = "NET";
    assert.equal(loadBoxConfig().zerodhaFundsBasis, "net", "case and whitespace are tolerated");
    delete process.env.BOX_ZERODHA_FUNDS_BASIS;
    assert.equal(loadBoxConfig().zerodhaFundsBasis, "live_balance", "unset -> default");
  } finally {
    if (saved === undefined) delete process.env.BOX_ZERODHA_FUNDS_BASIS;
    else process.env.BOX_ZERODHA_FUNDS_BASIS = saved;
  }
});

/* ═══════════════════ 2. each basis computes what it claims ═══════════════════ */

test("THE REPORTED CASE: collateral explains the gap, and the basis makes it selectable", () => {
  assert.equal(zerodha(COLLATERAL_ACCOUNT, "live_balance").value_rupees, 96_000);
  assert.equal(zerodha(COLLATERAL_ACCOUNT, "net").value_rupees, 96_000, "net equals live_balance here");

  const withCollateral = zerodha(COLLATERAL_ACCOUNT, "live_balance_plus_collateral");
  assert.equal(withCollateral.value_rupees, 390_000, "96,000 + 294,000");
  // The audit sentence must carry the WARNING, because this is the only basis that can overstate.
  assert.match(withCollateral.basis, /OVERSTATES spendable funds/);
  assert.match(withCollateral.basis, /available\.collateral ₹294000/);
  assert.match(withCollateral.basis, /\[basis=live_balance_plus_collateral\]/);
});

test("THE OTHER EXPLANATION: the same headline from cash that is already utilised", () => {
  /*
   * ₹96,000 can be entirely CORRECT. This account holds ₹3.9L of cash with ₹2.94L already blocked,
   * so the spendable figure really is ₹96,000 and adding collateral would add nothing (there is
   * none). The point of publishing the breakdown is that these two accounts are indistinguishable
   * from the headline alone and obvious from the components.
   */
  assert.equal(zerodha(UTILISED_ACCOUNT, "live_balance").value_rupees, 96_000);
  assert.equal(
    zerodha(UTILISED_ACCOUNT, "live_balance_plus_collateral").value_rupees,
    96_000,
    "no collateral to add, so the permissive basis changes nothing",
  );
  assert.equal(UTILISED_ACCOUNT["available.cash"], 390_000, "the 3.9L is cash, not availability");
});

test("a requested component the broker did not report FALLS BACK and says so", () => {
  // Never ₹0, and never a refusal either: the DEFAULT reading may still be perfectly usable. The
  // substitution is reported so it is not silent.
  const noNet = { "available.live_balance": 50_000, "utilised.debits": 0 };
  const v = resolveAvailableForBasis({ basis: "net", components: noNet, availableRupees: 50_000 });
  assert.equal(v.value, 50_000);
  assert.equal(v.satisfied, false);
  assert.match(v.detail, /'net' was not reported/);

  const noCollateral = resolveAvailableForBasis({
    basis: "live_balance_plus_collateral",
    components: noNet,
    availableRupees: 50_000,
  });
  assert.equal(noCollateral.value, 50_000, "falls back to live_balance alone");
  assert.equal(noCollateral.satisfied, false);
  assert.match(noCollateral.detail, /the conservative outcome/);
});

test("every declared basis is reachable and none throws", () => {
  for (const basis of FUNDS_BASES) {
    const v = zerodha(COLLATERAL_ACCOUNT, basis);
    assert.equal(typeof v.value_rupees, "number", `${basis} yields a figure`);
    assert.ok(v.basis.length > 0, `${basis} carries an audit sentence`);
  }
});

test("a missing available figure stays UNKNOWN under every basis — never ₹0", () => {
  for (const basis of FUNDS_BASES) {
    const v = usableFundsRupees({
      broker: "zerodha",
      availableRupees: null,
      utilisedRupees: null,
      components: {},
      basis,
    });
    assert.equal(v.value_rupees, null, `${basis}: null is unknown, not zero`);
  }
});

/* ═══════════════════ 3. the published breakdown ═══════════════════ */

function trackerWith(components, basis) {
  const tracker = new AccountFundsTracker({ freshnessMaxAgeMs: 45_000, now: () => 1_000_000, ...(basis ? { basis } : {}) });
  tracker.record(
    "zerodha",
    {
      availableRupees: components["available.live_balance"] ?? null,
      utilisedRupees: components["utilised.debits"] ?? null,
      components,
    },
    1_000_000,
  );
  return tracker.snapshot({ sessionReady: true, supported: true });
}

test("the snapshot publishes the FULL breakdown, keyed by the broker's own field names", () => {
  const snap = trackerWith(COLLATERAL_ACCOUNT);

  // Vendor field names, deliberately — so it can be held beside the broker's screen and compared.
  assert.equal(snap.components["available.collateral"], 294_000);
  assert.equal(snap.components["available.cash"], 96_000);
  assert.equal(snap.components["available.live_balance"], 96_000);
  assert.equal(snap.components.net, 96_000);
  assert.equal(snap.components["utilised.debits"], 0);

  // THE POINT: the headline and the component that explains the gap are both on screen.
  assert.equal(snap.free_to_trade_rupees, 96_000);
  assert.equal(snap.basis, "live_balance");
});

test("the snapshot's basis field reports what actually produced the headline", () => {
  const withCollateral = trackerWith(COLLATERAL_ACCOUNT, "live_balance_plus_collateral");
  assert.equal(withCollateral.basis, "live_balance_plus_collateral");
  assert.equal(withCollateral.free_to_trade_rupees, 390_000);
  assert.match(withCollateral.note, /OVERSTATES|collateral/i, "the caveat travels to the operator");
});

test("a snapshot with no breakdown publishes an EMPTY object, never a fabricated one", () => {
  const tracker = new AccountFundsTracker({ freshnessMaxAgeMs: 45_000, now: () => 1_000_000 });
  tracker.record("zerodha", { availableRupees: 47_250, utilisedRupees: 12_000 }, 1_000_000);
  const snap = tracker.snapshot({ sessionReady: true, supported: true });

  assert.deepEqual(snap.components, {}, "absent is empty, not invented");
  assert.equal(snap.free_to_trade_rupees, 47_250, "and the headline is unaffected");
});

test("the unavailable snapshots carry the new fields too, so the shape is stable", () => {
  // A client destructuring `components` must not have to special-case the error states.
  for (const reason of ["no_session", "not_supported", "never_read", "read_failed"]) {
    const snap = unavailableFunds(reason, "x", "zerodha");
    assert.deepEqual(snap.components, {});
    assert.equal(snap.basis, "live_balance");
    assert.equal(snap.free_to_trade_rupees, null);
  }
});

/* ═══════════════════ 4. the tile and the gate cannot diverge ═══════════════════ */

test("ONE derivation: the tile and the admission gate resolve the same basis to the same rupee", () => {
  /*
   * `usableFundsRupees` is the single place the basis is honoured, and both the dashboard tracker and
   * the gateway call it. If the basis were resolved at either call site instead, one account could
   * show two different spendable figures depending on which surface was asked — which is exactly the
   * class of defect the module header warns about for the netting arithmetic.
   */
  for (const basis of FUNDS_BASES) {
    const tile = trackerWith(COLLATERAL_ACCOUNT, basis).free_to_trade_rupees;
    const gate = zerodha(COLLATERAL_ACCOUNT, basis).value_rupees;
    assert.equal(tile, gate, `${basis}: the tile and the gate must agree`);
  }
});

test("the netting semantics are NOT changed by the basis — the two questions stay independent", () => {
  // "Which number is the spendable side?" and "is that number already net of the encumbrance?" are
  // separate. Zerodha stays net_of_encumbrance under every basis, so utilised is never subtracted.
  for (const basis of FUNDS_BASES) {
    const v = zerodha(COLLATERAL_ACCOUNT, basis);
    assert.equal(v.encumbranceNettedFromAvailable, true, `${basis}: still net_of_encumbrance`);
    assert.equal(v.semanticsUnverified, false);
    assert.match(v.basis, /NOT subtracted again/);
  }
});
