/**
 * THE OPERATOR BLOCKLIST — underlyings that must never be ENTERED.
 *
 * The properties that matter, and why each is worth a test rather than a comment:
 *
 *   - normalisation is total: `" nifty "` and `"NIFTY"` are the SAME name. A blocklist that stores
 *     one form and compares another is protection that reads as present and is not;
 *   - `&` survives. `M&M` and `M&MFIN` are real NSE underlyings, and a naive `A-Z0-9` filter silently
 *     drops exactly the names an operator is most likely to exclude during a corporate action;
 *   - an UNREADABLE blocklist REFUSES entry. "We could not read the list" is not "the list is empty";
 *   - `unpersisted` does NOT refuse, because no exclusion could ever have been stored, so none is
 *     being forgotten;
 *   - the refusal names the symbol and carries the operator's reason, so an operator reading a log or
 *     a UI badge learns why rather than only that;
 *   - excluding a name twice is idempotent, matching the primary key in migration 012;
 *   - the cap counts only NEW symbols, so restating an existing exclusion at the cap still works.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_EXCLUDED_UNDERLYINGS,
  MAX_EXCLUSION_REASON_LENGTH,
  UnderlyingExclusionBook,
  exclusionEntryRefusal,
  normaliseUnderlyingSymbol,
  validateExclusionInput,
} from "../../dist/box/underlyingExclusions.js";

const entry = (symbol, reason = null) => ({
  symbol,
  reason,
  excluded_by: "full",
  excluded_at: 1_758_000_000_000,
});

/* ------------------------------- normalisation ------------------------------- */

test("normalisation: trims, uppercases, and treats the results as the same name", () => {
  assert.equal(normaliseUnderlyingSymbol("  nifty "), "NIFTY");
  assert.equal(normaliseUnderlyingSymbol("Reliance"), "RELIANCE");
  assert.equal(normaliseUnderlyingSymbol("NIFTY"), "NIFTY");
});

test("normalisation: keeps & - and _, because M&M and M&MFIN are real underlyings", () => {
  assert.equal(normaliseUnderlyingSymbol("m&m"), "M&M");
  assert.equal(normaliseUnderlyingSymbol("M&MFIN"), "M&MFIN");
  assert.equal(normaliseUnderlyingSymbol("BAJAJ-AUTO"), "BAJAJ-AUTO");
  assert.equal(normaliseUnderlyingSymbol("A_B"), "A_B");
});

test("normalisation: rejects blank, over-long, non-string and punctuated input", () => {
  for (const bad of ["", "   ", "NIF TY", "NIFTY;DROP", "NIFTY*", null, undefined, 42, {}, []]) {
    assert.equal(normaliseUnderlyingSymbol(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.equal(normaliseUnderlyingSymbol("A".repeat(33)), null, "33 chars must be refused");
  assert.equal(normaliseUnderlyingSymbol("A".repeat(32)), "A".repeat(32), "32 chars is the boundary and must pass");
});

/* --------------------------------- validation -------------------------------- */

test("validation: returns the NORMALISED symbol, so what is stored is what is matched", () => {
  const v = validateExclusionInput({ symbol: " nifty ", reason: "  illiquid today  " });
  assert.equal(v.ok, true);
  assert.equal(v.symbol, "NIFTY");
  assert.equal(v.reason, "illiquid today", "reason is trimmed");
});

test("validation: an absent, null or whitespace-only reason all become null, never an empty string", () => {
  for (const reason of [undefined, null, "", "   "]) {
    const v = validateExclusionInput({ symbol: "NIFTY", reason });
    assert.equal(v.ok, true);
    assert.equal(v.reason, null, `reason ${JSON.stringify(reason)} must normalise to null`);
  }
});

test("validation: a bad symbol is refused with an actionable message naming the allowed characters", () => {
  const v = validateExclusionInput({ symbol: "NIF TY" });
  assert.equal(v.ok, false);
  assert.match(v.error, /symbol must be/);
  assert.match(v.error, /M&M/, "the message must show that & is allowed");
});

test("validation: a reason longer than the bound is refused, and the bound itself is accepted", () => {
  const atBound = validateExclusionInput({ symbol: "NIFTY", reason: "x".repeat(MAX_EXCLUSION_REASON_LENGTH) });
  assert.equal(atBound.ok, true);
  const over = validateExclusionInput({ symbol: "NIFTY", reason: "x".repeat(MAX_EXCLUSION_REASON_LENGTH + 1) });
  assert.equal(over.ok, false);
  assert.match(over.error, /at most 280 characters/);
});

test("validation: a non-string reason is refused rather than coerced", () => {
  const v = validateExclusionInput({ symbol: "NIFTY", reason: 7 });
  assert.equal(v.ok, false);
  assert.match(v.error, /reason must be a string/);
});

/* ----------------------------------- the book ---------------------------------- */

test("book: starts never_loaded, which is NOT readable — an unloaded list cannot permit a name", () => {
  const book = new UnderlyingExclusionBook();
  assert.equal(book.loadState, "never_loaded");
  assert.equal(book.readable, false);
  assert.equal(book.size, 0);
});

test("book: loaded() makes it readable and holds exactly what it was given, ordered by symbol", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded([entry("RELIANCE"), entry("BANKNIFTY"), entry("NIFTY")]);
  assert.equal(book.loadState, "loaded");
  assert.equal(book.readable, true);
  assert.deepEqual(book.symbols(), ["BANKNIFTY", "NIFTY", "RELIANCE"]);
});

test("book: membership is case- and whitespace-insensitive", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded([entry("NIFTY")]);
  assert.equal(book.has("NIFTY"), true);
  assert.equal(book.has(" nifty "), true);
  assert.equal(book.has("Nifty"), true);
  assert.equal(book.has("RELIANCE"), false);
});

test("book: set() is idempotent by symbol, matching the primary key in migration 012", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded([]);
  book.set(entry("NIFTY", "first"));
  book.set(entry("NIFTY", "second"));
  assert.equal(book.size, 1, "the same name twice must not create two entries");
  assert.equal(book.get("NIFTY").reason, "second", "the later statement wins");
});

test("book: delete() reports whether the name was actually present", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded([entry("NIFTY")]);
  assert.equal(book.delete("nifty"), true, "normalised delete must find it");
  assert.equal(book.delete("NIFTY"), false, "a second delete removes nothing");
  assert.equal(book.size, 0);
});

test("book: the cap counts only NEW symbols, so restating an existing one at the cap still works", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded(Array.from({ length: MAX_EXCLUDED_UNDERLYINGS }, (_, i) => entry(`SYM${i}`)));
  assert.equal(book.size, MAX_EXCLUDED_UNDERLYINGS);
  assert.equal(book.wouldExceedCap("BRANDNEW"), true, "a new symbol at the cap must be refused");
  assert.equal(book.wouldExceedCap("SYM0"), false, "restating an existing exclusion must still be allowed");
});

test("book: unpersisted() clears the list and permits entry — nothing could have been stored", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded([entry("NIFTY")]);
  book.unpersisted();
  assert.equal(book.loadState, "unpersisted");
  assert.equal(book.readable, true, "no durable list can exist, so none is being forgotten");
  assert.equal(book.persistent, false);
  assert.equal(book.size, 0);
});

test("book: loadFailed() keeps whatever it held but stops being readable", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded([entry("NIFTY")]);
  book.loadFailed("connection terminated");
  assert.equal(book.loadState, "failed");
  assert.equal(book.readable, false);
  assert.equal(book.loadError, "connection terminated");
  assert.equal(book.has("NIFTY"), true, "an unreadable book can still prove a name is FORBIDDEN");
});

/* --------------------------------- the verdict --------------------------------- */

test("verdict: a name not on a readable list is permitted", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded([entry("NIFTY")]);
  assert.equal(exclusionEntryRefusal(book, "RELIANCE"), null);
});

test("verdict: an excluded name is refused, and the refusal names it and carries the reason", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded([entry("NIFTY", "ban period")]);
  const refusal = exclusionEntryRefusal(book, " nifty ");
  assert.equal(refusal.code, "underlying_excluded");
  assert.match(refusal.detail, /NIFTY/);
  assert.match(refusal.detail, /ban period/);
  assert.match(refusal.detail, /still monitored and will still exit/, "the detail must say exposure is not trapped");
});

test("verdict: an excluded name with NO reason still produces a clean sentence", () => {
  const book = new UnderlyingExclusionBook();
  book.loaded([entry("NIFTY", null)]);
  const refusal = exclusionEntryRefusal(book, "NIFTY");
  assert.match(refusal.detail, /NIFTY is on the operator blocklist/);
  assert.doesNotMatch(refusal.detail, /null/, "a missing reason must never surface as the text 'null'");
});

test("verdict: an UNREADABLE blocklist refuses EVERY name — unknown is not the same as none", () => {
  const book = new UnderlyingExclusionBook();
  book.loadFailed("pool exhausted");
  const refusal = exclusionEntryRefusal(book, "ANYTHING");
  assert.equal(refusal.code, "underlying_exclusions_unreadable");
  assert.match(refusal.detail, /pool exhausted/);
  assert.match(refusal.detail, /Exits, reductions and protective cancels are unaffected/);
});

test("verdict: a never-loaded blocklist also refuses, so the closed default is not bypassable", () => {
  const book = new UnderlyingExclusionBook();
  const refusal = exclusionEntryRefusal(book, "NIFTY");
  assert.equal(refusal.code, "underlying_exclusions_unreadable");
});

test("verdict: unpersisted permits every name, so paper development is unaffected", () => {
  const book = new UnderlyingExclusionBook();
  book.unpersisted();
  assert.equal(exclusionEntryRefusal(book, "NIFTY"), null);
});
