/**
 * Dhan support layers: segment translation, instrument normalization, the charge
 * rate card, auth expiry handling, and history chunking/transposition.
 *
 * These are the quiet-failure areas. A wrong exchange segment returns the WRONG
 * instrument rather than an error; Dhan's column-wise candles silently transpose if
 * you assume Kite's row layout; and costing a Dhan trade with Zerodha brokerage makes
 * the ₹1,200 entry gate quietly wrong. All three are asserted here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  dhanSegmentFor,
  dhanSegmentFromCode,
  internalExchangeFor,
  DHAN_CODE_BY_SEGMENT,
} from "../../dist/brokers/dhan/segments.js";
import {
  dhanIdentityFromToken,
  dhanInternalToken,
  normalizeDhanExpiry,
  normalizeDhanInstrumentType,
  parseDhanScripMaster,
  getDhanParseReport,
  splitCsvLine,
} from "../../dist/brokers/dhan/instruments.js";
import {
  calculateDhanCharges,
  calculateDhanLegCharges,
  dhanRoundTrip,
  loadDhanChargeRates,
} from "../../dist/brokers/dhan/charges.js";
import { isDhanTokenExpired, parseExpiry, redactedSession } from "../../dist/brokers/dhan/auth.js";
// NOTE: The Kite/Dhan historical-charts provider (src/brokers/history.ts) is deliberately
// EXCLUDED from GTS Box — it is not part of the Box-arbitrage backend. The former
// `/* history */` block (dhanCandlesToRows / chunkDateRange) was removed with that module;
// every other Dhan assertion below is in scope and retained. See tests/README.md.
import { normalizeDhanError, isRetryableRead, DhanAuthError, DhanRateLimitError, DhanNetworkError, DhanError } from "../../dist/brokers/dhan/errors.js";

/* -------------------------------- segments -------------------------------- */

test("internal exchanges translate to Dhan segments", () => {
  assert.equal(dhanSegmentFor("NFO"), "NSE_FNO");
  assert.equal(dhanSegmentFor("NSE"), "NSE_EQ");
  assert.equal(dhanSegmentFor("BSE"), "BSE_EQ");
  assert.equal(dhanSegmentFor("MCX"), "MCX_COMM");
});

test("an index resolves to IDX_I regardless of exchange", () => {
  assert.equal(dhanSegmentFor("NSE", true), "IDX_I");
  assert.equal(dhanSegmentFor("INDICES"), "IDX_I");
});

test("an unknown exchange returns null rather than guessing a segment", () => {
  // A wrong segment silently returns the wrong instrument, which is worse than an error.
  assert.equal(dhanSegmentFor("NASDAQ"), null);
  assert.equal(dhanSegmentFor(""), null);
});

test("segment names and binary codes round-trip", () => {
  for (const [name, code] of Object.entries(DHAN_CODE_BY_SEGMENT)) {
    assert.equal(dhanSegmentFromCode(code), name);
  }
  assert.equal(dhanSegmentFromCode(99), null);
});

test("Dhan segments map back to Zerodha-style internal exchange labels", () => {
  // Dhan instruments must be structurally indistinguishable from Kite ones downstream.
  assert.equal(internalExchangeFor("NSE_FNO"), "NFO");
  assert.equal(internalExchangeFor("NSE_EQ"), "NSE");
  assert.equal(internalExchangeFor("IDX_I"), "INDICES");
});

/* ------------------------------- token identity --------------------------- */

test("an internal token folds in the SEGMENT so security ids cannot collide", () => {
  // The same security id in two segments is two different contracts.
  const eq = dhanInternalToken("NSE_EQ", 1333);
  const fno = dhanInternalToken("NSE_FNO", 1333);
  assert.notEqual(eq, fno);
});

test("an internal token round-trips back to (segment, securityId)", () => {
  const token = dhanInternalToken("NSE_FNO", 45678);
  assert.deepEqual(dhanIdentityFromToken(token), { segment: "NSE_FNO", securityId: 45678 });
});

test("token derivation is STABLE, so positions adopted at boot still match", () => {
  assert.equal(dhanInternalToken("NSE_FNO", 45678), dhanInternalToken("NSE_FNO", 45678));
});

test("an unrecognisable token yields null rather than a wrong instrument", () => {
  assert.equal(dhanIdentityFromToken(0), null);
});

/* -------------------------------- CSV parsing ------------------------------ */

test("CSV splitting respects quoted commas", () => {
  // Instrument names contain commas; a naive split corrupts every later field.
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ["a", 'say "hi"', "c"]);
});

test("expiry formats normalize to ISO, and garbage yields empty rather than a wrong date", () => {
  assert.equal(normalizeDhanExpiry("2026-09-29"), "2026-09-29");
  assert.equal(normalizeDhanExpiry("29/09/2026"), "2026-09-29");
  assert.equal(normalizeDhanExpiry("2026-09-29 14:30:00"), "2026-09-29");
  // A wrong expiry would file an option into the wrong chain.
  assert.equal(normalizeDhanExpiry("NA"), "");
  assert.equal(normalizeDhanExpiry(""), "");
});

test("Dhan instrument classes map to Kite's CE/PE/FUT vocabulary", () => {
  // Box code branches on these strings, so translating here avoids broker branches
  // everywhere downstream.
  assert.equal(normalizeDhanInstrumentType("OPTSTK", "CE"), "CE");
  assert.equal(normalizeDhanInstrumentType("OPTIDX", "PE"), "PE");
  assert.equal(normalizeDhanInstrumentType("FUTSTK", ""), "FUT");
  assert.equal(normalizeDhanInstrumentType("INDEX", ""), "INDEX");
});

test("the instrument master parses into the internal Instrument shape", () => {
  const csv = [
    "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,INSTRUMENT_TYPE,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE",
    "NSE,D,45678,OPTSTK,OPTSTK,ASTRAL25SEP2500CE,ASTRAL,1512,275,2026-09-29,2500,CE,0.05",
    "NSE,E,1333,EQUITY,ES,HDFCBANK,HDFCBANK,1333,1,,0,,0.05",
  ].join("\n");

  const rows = parseDhanScripMaster(csv);
  assert.equal(rows.length, 2);

  const option = rows[0];
  assert.equal(option.tradingsymbol, "ASTRAL25SEP2500CE");
  assert.equal(option.exchange, "NFO", "Zerodha-style label");
  assert.equal(option.instrument_type, "CE");
  assert.equal(option.strike, 2500);
  assert.equal(option.lot_size, 275);
  assert.equal(option.tick_size, 0.05);
  assert.equal(option.expiry, "2026-09-29");
  assert.equal(option.dhan_security_id, 45678, "Dhan's own id is retained");
  assert.equal(option.dhan_segment, "NSE_FNO");
  assert.equal(option.dhan_underlying_security_id, 1512);
  assert.equal(option.instrument_token, dhanInternalToken("NSE_FNO", 45678));

  const equity = rows[1];
  assert.equal(equity.exchange, "NSE");
  assert.equal(equity.dhan_segment, "NSE_EQ");
});

test("the master parser maps by column NAME, so an added column is harmless", () => {
  // Positional parsing would shift every field when Dhan adds a column.
  const csv = [
    "NEW_COL,EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,LOT_SIZE,TICK_SIZE",
    "ignored,NSE,D,999,FUTSTK,ASTRAL25SEPFUT,275,0.05",
  ].join("\n");
  const rows = parseDhanScripMaster(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dhan_security_id, 999);
  assert.equal(rows[0].instrument_type, "FUT");
});

test("a master with no SECURITY_ID column throws instead of returning an empty universe", () => {
  // Silently returning [] would look like "Dhan has no instruments today".
  assert.throws(() => parseDhanScripMaster("A,B\n1,2"), /no SECURITY_ID column/);
});

test("malformed rows are skipped, not fatal", () => {
  const csv = [
    "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,LOT_SIZE,TICK_SIZE",
    "NSE,D,,OPTSTK,BAD,275,0.05",
    "NSE,D,4242,OPTSTK,GOOD25SEP100CE,275,0.05",
  ].join("\n");
  const rows = parseDhanScripMaster(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tradingsymbol, "GOOD25SEP100CE");
});

/* --------------------------------- charges -------------------------------- */

test("Dhan charges are labelled as Dhan, never as local or Kite", () => {
  // The UI must not display a Dhan-costed trade as if Zerodha priced it.
  const rates = loadDhanChargeRates();
  const charges = calculateDhanCharges(
    [{ side: "BUY", tradingsymbol: "X", quantity: 275, price: 12.5 }],
    rates,
  );
  assert.equal(charges.computed_by, "dhan_estimate");
  assert.equal(charges.broker, "dhan");
  assert.match(rates.rateVersion, /^dhan-/);
});

test("STT applies to the SELL side only", () => {
  const rates = loadDhanChargeRates();
  const buy = calculateDhanLegCharges({ side: "BUY", tradingsymbol: "X", quantity: 275, price: 100 }, rates);
  const sell = calculateDhanLegCharges({ side: "SELL", tradingsymbol: "X", quantity: 275, price: 100 }, rates);
  assert.equal(buy.stt, 0, "buying an option incurs no STT");
  assert.ok(sell.stt > 0);
});

test("stamp duty applies to the BUY side only", () => {
  const rates = loadDhanChargeRates();
  const buy = calculateDhanLegCharges({ side: "BUY", tradingsymbol: "X", quantity: 275, price: 100 }, rates);
  const sell = calculateDhanLegCharges({ side: "SELL", tradingsymbol: "X", quantity: 275, price: 100 }, rates);
  assert.ok(buy.stamp_duty > 0);
  assert.equal(sell.stamp_duty, 0);
});

test("GST is charged on brokerage + exchange + SEBI only, never on STT or stamp duty", () => {
  const rates = loadDhanChargeRates();
  const leg = calculateDhanLegCharges({ side: "SELL", tradingsymbol: "X", quantity: 275, price: 100 }, rates);
  const expected = Math.round(((leg.brokerage + leg.exchange_txn + leg.sebi) * rates.gstPct) / 100 * 100) / 100;
  assert.equal(leg.gst, expected);
});

test("a leg total is the sum of its rounded heads", () => {
  const rates = loadDhanChargeRates();
  const leg = calculateDhanLegCharges({ side: "SELL", tradingsymbol: "X", quantity: 275, price: 42.5 }, rates);
  const sum =
    Math.round((leg.brokerage + leg.stt + leg.exchange_txn + leg.sebi + leg.stamp_duty + leg.gst) * 100) / 100;
  assert.equal(leg.total, sum);
});

test("a four-leg box round trip costs eight orders of brokerage", () => {
  const rates = loadDhanChargeRates();
  const legs = [
    { side: "BUY", tradingsymbol: "K1CE", quantity: 275, price: 50 },
    { side: "SELL", tradingsymbol: "K2CE", quantity: 275, price: 30 },
    { side: "BUY", tradingsymbol: "K2PE", quantity: 275, price: 40 },
    { side: "SELL", tradingsymbol: "K1PE", quantity: 275, price: 20 },
  ];
  const trip = dhanRoundTrip(legs, rates);
  assert.equal(trip.entry.legs.length, 4);
  assert.equal(trip.estimated_exit.legs.length, 4);
  // Eight orders total, so total brokerage is 8 × the per-order rate.
  const totalBrokerage = trip.entry.brokerage + trip.estimated_exit.brokerage;
  assert.equal(totalBrokerage, rates.brokeragePerOrder * 8);
});

test("the exit projection reverses every side", () => {
  const rates = loadDhanChargeRates();
  const trip = dhanRoundTrip(
    [{ side: "BUY", tradingsymbol: "X", quantity: 275, price: 50 }],
    rates,
  );
  assert.equal(trip.entry.legs[0].side, "BUY");
  assert.equal(trip.estimated_exit.legs[0].side, "SELL");
});

/* ---------------------------------- auth ---------------------------------- */

test("expiry parses from ms, seconds and ISO strings", () => {
  assert.equal(parseExpiry(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(parseExpiry(1_800_000_000), 1_800_000_000_000, "seconds are scaled to ms");
  assert.equal(parseExpiry("2026-09-04T00:00:00.000Z"), Date.parse("2026-09-04T00:00:00.000Z"));
});

test("an unparseable expiry is null, meaning UNKNOWN", () => {
  assert.equal(parseExpiry("not a date"), null);
  assert.equal(parseExpiry(undefined), null);
  assert.equal(parseExpiry(null), null);
});

test("an UNKNOWN expiry is NOT treated as expired", () => {
  // Treating unknown as expired would discard a perfectly good session; treating it
  // as immortal would keep a dead one. Unknown means "validate by using it".
  assert.equal(isDhanTokenExpired(null), false);
});

test("a stated past expiry IS expired, and a future one is not", () => {
  const now = 1_800_000_000_000;
  assert.equal(isDhanTokenExpired(now - 1, now), true);
  assert.equal(isDhanTokenExpired(now + 60_000, now), false);
  assert.equal(isDhanTokenExpired(now, now), true, "expiry is inclusive");
});

test("a redacted session NEVER contains the access token", () => {
  const redacted = redactedSession({
    dhan_client_id: "C1",
    dhan_client_name: "Trader",
    dhan_client_ucc: "UCC1",
    given_power_of_attorney: true,
    expiry_time: 1_800_000_000_000,
    login_date: "2026-09-03",
    login_at: new Date("2026-09-03T04:00:00.000Z"),
  });
  const serialized = JSON.stringify(redacted);
  assert.ok(!/access_token|accessToken/i.test(serialized), serialized);
  assert.ok(!/app_secret|apiSecret/i.test(serialized));
  assert.equal(redacted.client_id, "C1");
  assert.equal(redacted.power_of_attorney, true);
});

/* --------------------------------- errors --------------------------------- */

test("401/403 normalize to an auth error that is NOT retried", () => {
  const err = normalizeDhanError(401, { errorMessage: "Invalid token" }, "fallback");
  assert.ok(err instanceof DhanAuthError);
  assert.equal(isRetryableRead(err), false, "retrying is pointless until re-login");
});

test("429 normalizes to a rate-limit error that IS retryable for reads", () => {
  const err = normalizeDhanError(429, {}, "fallback");
  assert.ok(err instanceof DhanRateLimitError);
  assert.equal(isRetryableRead(err), true);
});

test("a 4xx is DEFINITIVE but a 429 is not — the write-safety distinction", () => {
  // isDefinitive gates whether a failed order submission may be recorded as
  // rejected. A 429 tells us nothing about whether the order landed.
  assert.equal(new DhanError("x", 400).isDefinitive, true);
  assert.equal(new DhanError("x", 404).isDefinitive, true);
  assert.equal(new DhanError("x", 429).isDefinitive, false);
  assert.equal(new DhanError("x", 500).isDefinitive, false);
  assert.equal(new DhanNetworkError("timeout").isDefinitive, false);
});

test("5xx and network failures are retryable for reads", () => {
  assert.equal(isRetryableRead(new DhanError("boom", 502)), true);
  assert.equal(isRetryableRead(new DhanNetworkError("timeout")), true);
});

/* --------------------------------- history -------------------------------- */
// REMOVED: the six history tests ("COLUMN-wise candles transpose", "candles come back
// oldest-first", "a candle with a bad timestamp is dropped", "missing columns become 0",
// "long ranges chunk", "a range within the limit is a single chunk"). They exercised
// dhanCandlesToRows / chunkDateRange from src/brokers/history.ts — the Kite historical-charts
// provider that GTS Box deliberately does NOT ship. See tests/README.md for the rationale.


/* ------------------- instrument-master quality filtering ------------------- */

/**
 * These exist because the live board came up showing `01INSETEST` … `14INSETEST` with
 * expiries 3736 days out, and only 20 "underlyings". Those are NSE's TEST series: they
 * parse perfectly and look exactly like ordinary futures, so nothing rejected them and
 * they crowded out the real universe.
 */

test("exchange TEST scrips are excluded from the universe", () => {
  const csv = [
    "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
    "NSE,D,101,FUTSTK,01INSETEST-Nov2036-FUT,01INSETEST,1,2036-11-27,0.05",
    "NSE,D,102,FUTSTK,TESTSCRIP26SEPFUT,TESTSCRIP,1,2026-09-29,0.05",
    "NSE,D,103,FUTSTK,RELIANCE26SEPFUT,RELIANCE,250,2026-09-29,0.05",
  ].join("\n");
  const rows = parseDhanScripMaster(csv);
  assert.equal(rows.length, 1, "only the real future survived");
  assert.equal(rows[0].name, "RELIANCE");
});

test("implausibly long-dated derivatives are excluded", () => {
  // 10 years out is a test/long-dated artefact, not something the strategies can trade.
  const far = new Date(Date.now() + 3736 * 86_400_000).toISOString().slice(0, 10);
  const near = new Date(Date.now() + 26 * 86_400_000).toISOString().slice(0, 10);
  const csv = [
    "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
    `NSE,D,201,FUTSTK,LONGDATEDFUT,LONGDATED,250,${far},0.05`,
    `NSE,D,202,FUTSTK,ASTRALFUT,ASTRAL,275,${near},0.05`,
  ].join("\n");
  const rows = parseDhanScripMaster(csv);
  assert.deepEqual(rows.map((r) => r.name), ["ASTRAL"]);
});

test("EQUITY and INDEX rows are NOT expiry-filtered", () => {
  // They legitimately have no expiry; applying the derivative rule would delete every
  // spot instrument and leave the board with no underlying prices.
  const csv = [
    "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
    "NSE,E,1512,EQUITY,ASTRAL,ASTRAL,1,,0.05",
    "NSE,I,13,INDEX,NIFTY 50,NIFTY,0,,0.05",
  ].join("\n");
  const rows = parseDhanScripMaster(csv);
  assert.equal(rows.length, 2);
});

test("the parse report records what was found and why rows were skipped", () => {
  // This report is the diagnosis tool: guessing at Dhan's column names has already
  // cost two cycles, so the parser now states what it actually saw.
  const csv = [
    "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
    "NSE,D,101,FUTSTK,01INSETEST-FUT,01INSETEST,1,2036-11-27,0.05",
    "NSE,D,103,FUTSTK,RELIANCE26SEPFUT,RELIANCE,250,2026-09-29,0.05",
    "NSE,D,,FUTSTK,BROKEN,BROKEN,250,2026-09-29,0.05",
  ].join("\n");
  parseDhanScripMaster(csv);
  const report = getDhanParseReport();
  assert.ok(report, "a report was produced");
  assert.equal(report.totalRows, 3);
  assert.equal(report.skippedTest, 1);
  assert.equal(report.skippedNoSecurityId, 1);
  assert.equal(report.parsed, 1);
  assert.equal(report.fnoFutures, 1);
  // The columns that were actually located, so a renamed column is obvious.
  assert.ok(report.columns.SECURITY_ID >= 0);
  assert.ok(Array.isArray(report.missingColumns));
});

test("the report NAMES missing columns rather than silently reading them empty", () => {
  const csv = ["EXCH_ID,SECURITY_ID,SYMBOL_NAME", "NSE,999,SOMETHING"].join("\n");
  parseDhanScripMaster(csv);
  const report = getDhanParseReport();
  // LOT_SIZE and TICK_SIZE genuinely are absent here; saying so is the point.
  assert.ok(report.missingColumns.includes("LOT_SIZE"));
  assert.ok(report.missingColumns.includes("TICK_SIZE"));
});

test("the report samples REAL F&O futures, which is what the board needs", () => {
  const rows = [
    "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
  ];
  const near = new Date(Date.now() + 26 * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < 12; i++) {
    rows.push(`NSE,D,${900 + i},FUTSTK,SYM${i}FUT,SYM${i},250,${near},0.05`);
  }
  parseDhanScripMaster(rows.join("\n"));
  const report = getDhanParseReport();
  assert.equal(report.fnoFutures, 12);
  assert.equal(report.samples.length, 8, "capped, so the payload stays small");
  assert.equal(report.samples[0].instrument_type, "FUT");
  assert.ok(report.samples[0].token > 1_000_000_000, "a Dhan-namespaced token");
});
