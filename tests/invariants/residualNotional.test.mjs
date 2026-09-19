/**
 * RESIDUAL ECONOMIC OBSERVABILITY — measured, never modelled, and never reassuring by accident.
 *
 * "3 residual legs" says nothing about scale. These tests pin the two figures that do, and pin harder
 * on the cases where NO figure is honest:
 *
 *   MARKED     quantity x freshest usable last-traded price. UNKNOWN when missing/stale/unusable.
 *   COMMITTED  quantity x `average_price`, the durable acquisition price. Survives a dead feed.
 *
 * UNKNOWN IS NEVER ZERO. Zero appears only when residual quantity is genuinely zero. A zero shown for
 * "we could not tell" reads as "nothing outstanding", the exact opposite of the truth being reported.
 * A PARTIAL total is unknown too: summing the legs that could be priced is confidently too small,
 * which is the worst kind of wrong on an exposure readout.
 *
 * IT IS NOT RISK. Notional is quantity times a price. An option position's loss can exceed it (a short
 * leg) or fall well below it (a long leg), and nothing here computes which — so nothing here is
 * allowed to call itself maximum loss, VaR, risk or capital at risk.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deriveResidualNotional, residualNotionalSummary } from "../../dist/box/residualNotional.js";

const src = (rel) => readFileSync(new URL(`../../src/box/${rel}`, import.meta.url), "utf8");

const NOW = 1_700_000_000_000;
const MAX_AGE = 3_000;

/** One NIFTY-lot leg: 65 individual contracts, already lot-multiplied. */
const leg = (over = {}) => ({ token: 111, quantity: 65, average_price: 12.5, ...over });

/** A price lookup over a token -> {last, at} table. */
const prices = (table) => (token) => table[token];

const fresh = (last) => ({ last, at: NOW - 500 });

/* ══════════════════ 1. known quantity + fresh price ══════════════════ */

test("a fresh usable price gives the correct marked notional", () => {
  const view = deriveResidualNotional({
    legs: [leg({ quantity: 65, average_price: 12.5 })],
    price: prices({ 111: fresh(20) }),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(view.markedNotionalRupees, 65 * 20, "65 contracts x ₹20");
  assert.equal(view.committedNotionalRupees, Math.round(65 * 12.5), "and the acquisition price figure");
  assert.equal(view.priceSource, "last_traded_fresh");
  assert.equal(view.markedUnknownReason, null);
  assert.equal(view.legsPriced, 1);
  assert.equal(view.legsUnpriced, 0);
  assert.equal(view.totalQuantity, 65);
});

test("multiple legs sum, and the two bases stay distinct", () => {
  const view = deriveResidualNotional({
    legs: [
      { token: 1, quantity: 65, average_price: 10 },
      { token: 2, quantity: 130, average_price: 5 },
    ],
    // Prices chosen so the two bases cannot coincide — otherwise the assertion below proves nothing.
    price: prices({ 1: fresh(18), 2: fresh(9) }),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(view.markedNotionalRupees, 65 * 18 + 130 * 9, "marked uses the last traded price");
  assert.equal(view.committedNotionalRupees, 65 * 10 + 130 * 5, "committed uses the acquisition price");
  assert.notEqual(view.markedNotionalRupees, view.committedNotionalRupees, "two different questions");
  assert.equal(view.totalQuantity, 195);
});

/* ══════════════════ 2-4. missing / stale / invalid price ⇒ UNKNOWN ══════════════════ */

test("a MISSING price is unknown, never zero — and committed still answers", () => {
  const view = deriveResidualNotional({
    legs: [leg()],
    price: prices({}),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(view.markedNotionalRupees, null, "unknown, not 0");
  assert.equal(view.priceSource, "unknown");
  assert.match(view.markedUnknownReason, /no market price available/);
  assert.equal(
    view.committedNotionalRupees,
    Math.round(65 * 12.5),
    "the durable acquisition price still gives a figure with no feed at all",
  );
});

test("a STALE price is unknown", () => {
  const view = deriveResidualNotional({
    legs: [leg()],
    price: prices({ 111: { last: 20, at: NOW - (MAX_AGE + 1) } }),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(view.markedNotionalRupees, null);
  assert.match(view.markedUnknownReason, /is stale \(age \d+ms > 3000ms\)/);
});

test("a price exactly AT the ceiling is still usable; one millisecond past is not", () => {
  const at = (age) =>
    deriveResidualNotional({
      legs: [leg()],
      price: prices({ 111: { last: 20, at: NOW - age } }),
      nowWall: NOW,
      maxPriceAgeMs: MAX_AGE,
    }).markedNotionalRupees;
  assert.equal(at(MAX_AGE), 65 * 20, "the boundary is inclusive");
  assert.equal(at(MAX_AGE + 1), null);
});

test("an INVALID price is unknown — including zero, NaN, Infinity and negative", () => {
  for (const last of [0, Number.NaN, Number.POSITIVE_INFINITY, -20]) {
    const view = deriveResidualNotional({
      legs: [leg()],
      price: prices({ 111: { last, at: NOW - 100 } }),
      nowWall: NOW,
      maxPriceAgeMs: MAX_AGE,
    });
    assert.equal(view.markedNotionalRupees, null, `last=${String(last)} must be unknown`);
    assert.match(view.markedUnknownReason, /not a usable price|is stale/);
  }
});

test("a price stamped in the FUTURE is refused rather than treated as maximally fresh", () => {
  const view = deriveResidualNotional({
    legs: [leg()],
    price: prices({ 111: { last: 20, at: NOW + 60_000 } }),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(view.markedNotionalRupees, null, "a negative age is a clock fault, not freshness");
});

test("a PARTIAL total is unknown — three priced legs must not look like a complete answer", () => {
  const view = deriveResidualNotional({
    legs: [
      { token: 1, quantity: 65, average_price: 10 },
      { token: 2, quantity: 65, average_price: 10 },
      { token: 3, quantity: 65, average_price: 10 },
      { token: 4, quantity: 65, average_price: 10 },
    ],
    price: prices({ 1: fresh(10), 2: fresh(10), 3: fresh(10) }), // token 4 has no price
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(view.markedNotionalRupees, null, "a confidently-too-small number is worse than unknown");
  assert.equal(view.legsPriced, 3);
  assert.equal(view.legsUnpriced, 1);
  assert.match(view.markedUnknownReason, /no market price available for token 4/);
});

/* ══════════════════ 5. zero residual ══════════════════ */

test("NO residual legs is genuinely zero, and says not_applicable rather than unknown", () => {
  const view = deriveResidualNotional({ legs: [], price: prices({}), nowWall: NOW, maxPriceAgeMs: MAX_AGE });
  assert.equal(view.markedNotionalRupees, 0, "zero is the truthful answer here, and the only such case");
  assert.equal(view.committedNotionalRupees, 0);
  assert.equal(view.markedUnknownReason, null);
  assert.equal(view.priceSource, "not_applicable");
  assert.equal(residualNotionalSummary(view), "No unresolved residual exposure.");
});

/* ══════════════════ 6. no double lot multiplication ══════════════════ */

test("quantity is used AS GIVEN — no second multiplication by a lot size", () => {
  /*
   * `ResidualLegExposure.quantity` is "outstanding quantity still on our book", already in individual
   * contracts (65 for a one-lot NIFTY leg, not 1). Multiplying by 65 again would overstate by exactly
   * the lot size, which is the specific error this case exists to catch.
   */
  const view = deriveResidualNotional({
    legs: [leg({ quantity: 65 })],
    price: prices({ 111: fresh(100) }),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(view.markedNotionalRupees, 6_500, "65 x 100, not 65 x 65 x 100");
  assert.notEqual(view.markedNotionalRupees, 65 * 65 * 100);

  // A one-contract leg proves it from the other direction: the figure is simply the price.
  const single = deriveResidualNotional({
    legs: [leg({ quantity: 1 })],
    price: prices({ 111: fresh(100) }),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(single.markedNotionalRupees, 100);
});

/* ══════════════════ 7. sign ══════════════════ */

test("a SHORT residual contributes its absolute economic size", () => {
  const short = deriveResidualNotional({
    legs: [leg({ quantity: -65 })],
    price: prices({ 111: fresh(20) }),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(short.markedNotionalRupees, 1_300, "magnitude, not a signed value that could cancel out");
  assert.equal(short.totalQuantity, 65);

  // A long and a short of equal size must SUM, not net to zero — both are unresolved exposure.
  const both = deriveResidualNotional({
    legs: [
      { token: 1, quantity: 65, average_price: 10 },
      { token: 2, quantity: -65, average_price: 10 },
    ],
    price: prices({ 1: fresh(20), 2: fresh(20) }),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(both.markedNotionalRupees, 2_600, "offsetting legs must not vanish from the readout");
});

/* ══════════════════ 8-9. overflow and bounded output ══════════════════ */

test("a quantity or price large enough to lose integer precision reports UNKNOWN", () => {
  const view = deriveResidualNotional({
    legs: [leg({ quantity: Number.MAX_SAFE_INTEGER })],
    price: prices({ 111: fresh(1_000) }),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  assert.equal(view.markedNotionalRupees, null, "an inexact figure must not be presented as exact");
  assert.match(view.markedUnknownReason, /exceeded the range where the figure would be exact/);
});

test("a non-finite quantity makes both figures unknown rather than silently skipped", () => {
  for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const view = deriveResidualNotional({
      legs: [leg({ quantity })],
      price: prices({ 111: fresh(20) }),
      nowWall: NOW,
      maxPriceAgeMs: MAX_AGE,
    });
    assert.equal(view.markedNotionalRupees, null);
    assert.equal(view.committedNotionalRupees, null, "an uncertain quantity makes committed unanswerable too");
    assert.match(view.markedUnknownReason, /not a usable number/);
  }
});

test("the summary is bounded, names its price basis, and never claims to be risk", () => {
  const view = deriveResidualNotional({
    legs: Array.from({ length: 200 }, (_, i) => ({ token: i, quantity: 65, average_price: 10 })),
    price: prices(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [i, fresh(12)]))),
    nowWall: NOW,
    maxPriceAgeMs: MAX_AGE,
  });
  const summary = residualNotionalSummary(view);
  assert.ok(summary.length < 600, `the summary must stay bounded, got ${summary.length} chars`);
  assert.match(summary, /at the last traded price/, "the marked basis must be named");
  assert.match(summary, /at the acquisition price/, "and so must the committed basis");
  assert.match(summary, /NOTIONAL, not a loss estimate and not a risk/);
  for (const forbidden of [/maximum loss/i, /\bVaR\b/, /worst-case/i, /capital at risk/i]) {
    assert.ok(!forbidden.test(summary), `the summary must not claim ${forbidden}`);
  }
});

/* ══════════════════ 10-12. it cannot block any reduction ══════════════════ */

/**
 * There is no threshold, no comparison and no gate in the module, so there is no code path by which it
 * could refuse anything. Asserted structurally, which is stronger than testing three purposes: it also
 * holds for any purpose added later.
 */
test("the module has no ability to refuse or act", () => {
  // Comments STRIPPED: the module names these operations in prose to explain what it cannot do, and
  // that warning is the documentation working. Only their presence in CODE would be the regression.
  const code = src("residualNotional.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  for (const token of ["submitOrder", "cancelOrder", "flatten", "unwind", "throw ", "blockReason"]) {
    assert.ok(!code.includes(token), `an observability module must not contain ${token}`);
  }
  assert.ok(!/\basync\b|\bawait\b|\bPromise\b/.test(code), "pure and synchronous");
  assert.ok(!/^import\s+\{/m.test(code), "and it imports nothing, so it cannot acquire I/O indirectly");
});

test("no reduction path — and no entry gate — consumes the notional", () => {
  const om = src("orderManager.ts");
  const start = om.indexOf("canManageExposure(): boolean {");
  const reasonFn = om.indexOf("exposureReductionBlockReason(): string | null {");
  assert.ok(start > 0 && reasonFn > start, "fixture: both reduction predicates must be locatable");
  const after = om.slice(reasonFn);
  const reductionBody = om.slice(start, reasonFn) + after.slice(0, after.indexOf("\n  }\n"));
  for (const token of ["residualNotional", "deriveResidualNotional", "markedNotionalRupees"]) {
    assert.ok(!reductionBody.includes(token), `a reduction must not depend on ${token}`);
  }
  // It is observability only: the order manager must not consult it for ENTRY either.
  assert.ok(
    !om.includes("deriveResidualNotional"),
    "residual notional must not become an entry gate — §12 is diagnostics, not a monetary threshold",
  );

  // And the live EXIT / residual-flatten paths must not depend on it.
  const gw = src("executionGateway.ts");
  assert.ok(!gw.includes("deriveResidualNotional"), "the gateway must not gate a reduction on a notional");
});
