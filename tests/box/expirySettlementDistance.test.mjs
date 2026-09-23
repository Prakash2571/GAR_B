/**
 * EXPIRY DISTANCE AND SETTLEMENT COST — keeping a box out of settlement, and pricing it when it gets
 * there anyway.
 *
 * WHAT WAS MISSING. There was no days-to-expiry rule anywhere in the system, and the universe always
 * selected the nearest non-expired series INCLUDING today's. So a box could be opened at 14:00 on
 * expiry day, in the expiring contract, and the only thing between it and settlement was a 45-minute
 * expiry-safety window — which by design refuses to fill against an untradeable book, because it will
 * not invent a price. An illiquid wing at 15:15 therefore went to settlement, and the charge model had
 * no exercise-STT head at all: `BoxChargeOrder` carried no strike, so the cost was not merely omitted,
 * it was structurally impossible to compute. The realised P&L of a settled box was never booked.
 *
 * Settlement is not a neutral alternative to closing. Exercise STT is 0.15% of INTRINSIC value
 * (raised from 0.125% effective 1 April 2026), payable by the BUYER of an exercised option, and a box
 * ALWAYS has in-the-money legs at expiry.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { indexOptionChains } from "../../dist/box/instruments.js";
import {
  calculateSettlementCharges,
  loadBoxChargeRates,
} from "../../dist/box/localCharges.js";
import { tradingDaysUntil, isTradingDay } from "../../dist/marketCalendar.js";

/* ───────────────────────────── fixtures ───────────────────────────── */

/** A minimal NFO CE/PE dump for one underlying across several expiries. */
function chainDump(name, expiries, { strikes = [24400, 24450, 24500], lot = 75 } = {}) {
  const rows = [];
  let token = 1000;
  for (const expiry of expiries) {
    for (const strike of strikes) {
      for (const type of ["CE", "PE"]) {
        rows.push({
          instrument_token: token++,
          tradingsymbol: `${name}${expiry.replace(/-/g, "")}${strike}${type}`,
          name,
          exchange: "NFO",
          segment: "NFO-OPT",
          instrument_type: type,
          expiry,
          strike,
          lot_size: lot,
          tick_size: 0.05,
        });
      }
    }
  }
  return rows;
}

/* ══════════════════ trading-day distance ══════════════════ */

test("distance to expiry is counted in TRADING days, not calendar days", () => {
  /*
   * THE WHOLE REASON THE RULE IS NOT IN CALENDAR DAYS. Friday 2026-09-25 to Monday 2026-09-28 is
   * three CALENDAR days but only ONE session — one chance to unwind four legs. A calendar-day rule
   * would admit exactly the trades it exists to refuse, and would do so around long weekends, when
   * the gap is widest and the intuition least reliable.
   */
  assert.equal(tradingDaysUntil("2026-09-25", "2026-09-28"), 1, "Fri → Mon is ONE session");
  assert.equal(tradingDaysUntil("2026-09-25", "2026-09-29"), 2, "Fri → Tue is two");

  // 2026-10-02 is Gandhi Jayanti (a Friday closure on the verified NSE calendar), so the holiday
  // makes the Thursday-to-Monday span one session shorter than the weekday count suggests.
  assert.equal(isTradingDay("2026-10-02"), false, "2 Oct 2026 is a trading holiday");
  assert.equal(
    tradingDaysUntil("2026-10-01", "2026-10-05"), 1,
    "Thu → Mon across the Gandhi Jayanti closure is ONE session, not two",
  );
});

test("an unparseable or absurd span yields null rather than a guess", () => {
  assert.equal(tradingDaysUntil("not-a-date", "2026-09-28"), null);
  assert.equal(tradingDaysUntil("2026-09-25", "nope"), null);
  assert.equal(tradingDaysUntil("2026-09-25", "2099-01-01"), null, "beyond the bounded scan");
  assert.equal(tradingDaysUntil("2026-09-25", "2026-09-25"), 0, "same day is zero, not null");
  assert.equal(tradingDaysUntil("2026-09-28", "2026-09-25"), 0, "a past expiry is zero, not negative");
});

/* ══════════════════ expiry selection ══════════════════ */

test("the expiring series is REFUSED for new boxes and the next one is used instead", () => {
  // Today is Tuesday 2026-09-15. 2026-09-17 is 2 sessions out; 2026-09-24 is 7.
  const dump = chainDump("NIFTY", ["2026-09-17", "2026-09-24", "2026-10-29"]);

  const permissive = indexOptionChains(dump, "2026-09-15", { minTradingDays: 0 });
  assert.equal(
    permissive.get("NIFTY").expiry, "2026-09-17",
    "with the rule disabled the behaviour is unchanged: nearest live expiry",
  );

  const strict = indexOptionChains(dump, "2026-09-15", { minTradingDays: 3 });
  const chain = strict.get("NIFTY");
  assert.equal(chain.expiry, "2026-09-24", "2 sessions is inside a 3-session minimum, so it rolls");
  assert.deepEqual(
    chain.skipped_near_expiries, ["2026-09-17"],
    "the skipped series is RECORDED — 'trading a later series' and 'has no chain' are different " +
      "situations and an operator who cannot tell them apart will hunt a feed bug that does not exist",
  );
  assert.equal(chain.trading_days_to_expiry, 7, "the distance actually used is reported");
});

test("today's own expiry can never be selected once a minimum is set", () => {
  const dump = chainDump("NIFTY", ["2026-09-15", "2026-09-24"]);
  const chain = indexOptionChains(dump, "2026-09-15", { minTradingDays: 1 }).get("NIFTY");
  assert.equal(
    chain.expiry, "2026-09-24",
    "a box opened in the expiring series at 14:00 has 45 minutes and an illiquid book between it " +
      "and settlement — minTradingDays 1 means 'not the expiring series'",
  );
  assert.deepEqual(chain.skipped_near_expiries, ["2026-09-15"]);
});

test("an underlying whose ONLY series are too close is dropped entirely, not admitted", () => {
  const dump = chainDump("NIFTY", ["2026-09-16"]);
  const chains = indexOptionChains(dump, "2026-09-15", { minTradingDays: 5 });
  assert.equal(
    chains.has("NIFTY"), false,
    "no eligible series means no chain — it must not fall back to the ineligible one",
  );
});

test("a series whose distance cannot be computed is SKIPPED, never admitted", () => {
  /*
   * An unknown distance to settlement is not evidence of a SAFE distance. This is the one decision
   * where guessing has an unbounded downside (exercise STT is unbounded in |S − K|, and a stock box
   * becomes a delivery obligation), so an uncomputable span fails closed.
   */
  const dump = chainDump("NIFTY", ["2026-09-17", "2026-09-24"]);
  const chains = indexOptionChains(dump, "2026-09-15", {
    minTradingDays: 2,
    tradingDaysUntil: (_from, to) => (to === "2026-09-17" ? null : 7),
  });
  assert.equal(chains.get("NIFTY").expiry, "2026-09-24");
  assert.deepEqual(chains.get("NIFTY").skipped_near_expiries, ["2026-09-17"]);
});

/* ══════════════════ settlement cost ══════════════════ */

const rates = loadBoxChargeRates();

/**
 * A LONG_BOX at expiry: BUY K1 CE, SELL K2 CE, BUY K2 PE, SELL K1 PE.
 * `side` is the side we HOLD.
 */
function longBoxLegs(k1, k2, qty = 75) {
  return [
    { side: "BUY", tradingsymbol: "K1CE", instrument_type: "CE", strike: k1, quantity: qty },
    { side: "SELL", tradingsymbol: "K2CE", instrument_type: "CE", strike: k2, quantity: qty },
    { side: "BUY", tradingsymbol: "K2PE", instrument_type: "PE", strike: k2, quantity: qty },
    { side: "SELL", tradingsymbol: "K1PE", instrument_type: "PE", strike: k1, quantity: qty },
  ];
}

test("exercise STT is charged on LONG in-the-money legs only — a writer pays none", () => {
  // Settles BETWEEN the strikes: the long K1 call is 300 ITM, the long K2 put is 100 ITM.
  // Their intrinsics sum to exactly the width (400), which is the structural floor for any box.
  const s = calculateSettlementCharges(longBoxLegs(23_900, 24_300), 24_200, rates);

  const byLeg = Object.fromEntries(s.legs.map((l) => [l.tradingsymbol, l]));
  assert.equal(byLeg.K1CE.exercised_long, true, "long call 300 ITM is exercised and pays");
  assert.equal(byLeg.K2PE.exercised_long, true, "long put 100 ITM is exercised and pays");
  assert.equal(
    byLeg.K1PE.exercised_long, false,
    "the short K1 put is out of the money AND short — a writer never pays exercise STT",
  );
  assert.equal(byLeg.K2CE.exercised_long, false, "the short K2 call is out of the money");

  // 0.15% of intrinsic value, rounded to the nearest rupee per leg (the statutory STT rule).
  // K1CE: 300 × 75 = 22,500 → 0.15% = 33.75 → ₹34.  K2PE: 100 × 75 = 7,500 → 11.25 → ₹11.
  assert.equal(byLeg.K1CE.stt_exercise, 34);
  assert.equal(byLeg.K2PE.stt_exercise, 11);
  assert.equal(s.stt_exercise, 45);
  assert.equal(s.total, s.stt_exercise, "the total equals the sum of the itemised heads");
});

test("a SHORT leg that finishes deep in the money still pays no exercise STT", () => {
  // Settles far ABOVE both strikes: the short K2 call is 1,700 ITM and is ASSIGNED.
  const s = calculateSettlementCharges(longBoxLegs(23_900, 24_300), 26_000, rates);
  const byLeg = Object.fromEntries(s.legs.map((l) => [l.tradingsymbol, l]));

  assert.ok(byLeg.K2CE.intrinsic_per_unit > 0, "fixture: the short call really is deep ITM");
  assert.equal(
    byLeg.K2CE.stt_exercise, 0,
    "assignment is not exercise: the writer pays no exercise STT, so the side test must not be " +
      "made symmetric",
  );
  // Only the long K1 call pays: 2,100 × 75 = 157,500 → 0.15% = ₹236.25 → ₹236.
  assert.equal(byLeg.K1CE.stt_exercise, 236);
  assert.equal(s.stt_exercise, 236);
});

test("exercise STT is UNBOUNDED in how far the underlying travels — this is the box-killer", () => {
  /*
   * The economic point of modelling this at all. A 400-wide NIFTY box on a 75 lot has a maximum
   * payoff of ₹30,000 and, at the gate's ₹1,200 minimum expected net profit, an edge of order ₹1,200.
   * Settlement cost is a function of |S − K1|, not of the width, so it scales without limit.
   */
  const near = calculateSettlementCharges(longBoxLegs(23_900, 24_300), 24_200, rates);
  const far = calculateSettlementCharges(longBoxLegs(23_900, 24_300), 28_000, rates);

  assert.equal(near.stt_exercise, 45, "between the strikes: a floor of ~0.15% × width × lot");
  // 4,100 × 75 = 307,500 → 0.15% = ₹461.25 → ₹461.
  assert.equal(far.stt_exercise, 461);
  assert.ok(
    far.stt_exercise > 10 * near.stt_exercise,
    "the same box settles at ten times the cost purely because the underlying moved — a cost the " +
      "engine previously could not see at all",
  );
});

test("a box settling exactly AT a strike pays the width floor on the other leg", () => {
  // S = K1: the long call is worthless, the long K2 put is the full width ITM.
  const s = calculateSettlementCharges(longBoxLegs(23_900, 24_300), 23_900, rates);
  const byLeg = Object.fromEntries(s.legs.map((l) => [l.tradingsymbol, l]));
  assert.equal(byLeg.K1CE.intrinsic_per_unit, 0, "at-the-money is not in-the-money");
  assert.equal(byLeg.K1CE.stt_exercise, 0);
  assert.equal(byLeg.K2PE.intrinsic_per_unit, 400, "the long put carries the whole width");
  // 400 × 75 = 30,000 → 0.15% = ₹45.
  assert.equal(s.stt_exercise, 45);
});

test("the settlement price and rate version are recorded for audit", () => {
  const s = calculateSettlementCharges(longBoxLegs(23_900, 24_300), 24_200.4, rates);
  assert.equal(s.settlement_price, 24_200.4);
  assert.equal(s.rate_version, rates.rateVersion, "so pre- and post-revision P&L stays comparable");
});

test("the exercise rate is a SEPARATE knob from sell-side premium STT", () => {
  /*
   * They are numerically equal today (both 0.15% since 1 April 2026) but they are different taxes on
   * different bases: premium STT is paid by the WRITER on PREMIUM at the time of sale, exercise STT by
   * the HOLDER on INTRINSIC VALUE at settlement. They have moved independently before — the October
   * 2024 revision took premium STT from 0.0625% to 0.10% and left exercise at 0.125% — so one knob
   * would guarantee a wrong number the next time only one changes.
   */
  assert.equal(typeof rates.sttExercisePct, "number");
  assert.equal(typeof rates.sttSellPct, "number");
  const doubled = { ...rates, sttExercisePct: rates.sttExercisePct * 2 };
  const base = calculateSettlementCharges(longBoxLegs(23_900, 24_300), 24_200, rates);
  const twice = calculateSettlementCharges(longBoxLegs(23_900, 24_300), 24_200, doubled);
  assert.ok(
    twice.stt_exercise > base.stt_exercise,
    "the exercise head must respond to sttExercisePct, not to sttSellPct",
  );
});
