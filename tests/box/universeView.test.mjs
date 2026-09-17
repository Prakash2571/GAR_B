/**
 * THE PRE-RUN UNIVERSE PROJECTION.
 *
 * The properties that matter, and why each is worth a test rather than a comment:
 *
 *   - A NAME WHOSE LOT EXCEEDS THE PER-LEG CAP CANNOT TRADE, EVER. That is the whole reason this
 *     module exists: with one chosen underlying the cap could be set to exactly its lot, but across
 *     ~200 F&O names any single value is either too small for most or too large to bound anything.
 *     The verdict must be visible BEFORE arming, because the real refusal happens deep on the entry
 *     path where it reads as an execution failure rather than a configuration mismatch.
 *   - ORDERING MATCHES `prioritiseUniverse` (indices first, then alphabetical). A picker sorted
 *     differently from the selector would mislead about which names survive a token-budget squeeze.
 *   - A board row with no chain is DROPPED, not shown as unusable — the board∩chains join is what
 *     defines the universe.
 *   - `blocked_by_caps` counts only names the operator has NOT excluded. A name they already declined
 *     is not a configuration problem they need told about.
 *   - A cap of 0 means "no limit", matching every other quantity knob in this codebase.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOX_ENTRY_LEG_COUNT,
  judgeAdmissibility,
  projectUniverse,
  summariseUniverse,
} from "../../dist/box/universeView.js";

const CAPS = { maxOpenLegQuantity: 75, maxGrossOpenLegQuantity: 300 };

const chain = (lot, strikes = [100, 200, 300], expiry = "2026-09-24") => ({
  lot_size: lot,
  expiry,
  strikes,
});

function board(...symbols) {
  return symbols.map((s) =>
    typeof s === "string" ? { symbol: s, name: s, is_index: false } : s,
  );
}

/* ─────────────────────────── admissibility ─────────────────────────── */

test("a lot within the caps is admissible", () => {
  assert.equal(judgeAdmissibility(chain(75), CAPS), null);
});

test("a lot ABOVE the per-leg cap can never trade, and the message names the variable", () => {
  const v = judgeAdmissibility(chain(725), CAPS);
  assert.equal(v.reason, "lot_exceeds_per_leg_cap");
  assert.match(v.detail, /725 unit/);
  assert.match(v.detail, /BOX_LIVE_MAX_OPEN_LEG_QUANTITY=75/);
  assert.match(v.detail, /before the first leg is sent/);
});

test("a lot that fits per-leg but whose FOUR legs exceed the gross cap is refused", () => {
  // 80 fits a 100 per-leg cap, but 4 x 80 = 320 exceeds a 300 gross cap.
  const v = judgeAdmissibility(chain(80), { maxOpenLegQuantity: 100, maxGrossOpenLegQuantity: 300 });
  assert.equal(v.reason, "four_legs_exceed_gross_cap");
  assert.match(v.detail, /320 unit/);
  assert.match(v.detail, /before any leg posts/);
});

test("the per-leg cap is reported BEFORE the gross cap when both are breached", () => {
  // The per-leg message is the one that names the number to change first.
  const v = judgeAdmissibility(chain(5000), CAPS);
  assert.equal(v.reason, "lot_exceeds_per_leg_cap");
});

test("a cap of 0 means NO LIMIT, matching every other quantity knob", () => {
  const v = judgeAdmissibility(chain(5000), { maxOpenLegQuantity: 0, maxGrossOpenLegQuantity: 0 });
  assert.equal(v, null, "0 must not be read as an impossible-to-satisfy limit here");
});

test("an unusable lot size is refused before any cap arithmetic is attempted", () => {
  for (const bad of [0, -1]) {
    const v = judgeAdmissibility(chain(bad), CAPS);
    assert.equal(v.reason, "unusable_lot_size", `lot ${bad} must be unusable`);
  }
  assert.equal(judgeAdmissibility(undefined, CAPS).reason, "unusable_lot_size");
});

test("a chain with fewer than two paired strikes cannot form a box", () => {
  const v = judgeAdmissibility(chain(75, [100]), CAPS);
  assert.equal(v.reason, "no_paired_strikes");
  assert.match(v.detail, /needs two such strikes/);
});

test("BOX_ENTRY_LEG_COUNT is 4 — the gross arithmetic depends on it", () => {
  assert.equal(BOX_ENTRY_LEG_COUNT, 4);
});

/* ─────────────────────────── the projection ─────────────────────────── */

test("ordering is INDICES FIRST then alphabetical, matching prioritiseUniverse", () => {
  const rows = projectUniverse({
    board: [
      { symbol: "RELIANCE", name: "RELIANCE", is_index: false },
      { symbol: "NIFTY", name: "NIFTY", is_index: true },
      { symbol: "ASIANPAINT", name: "ASIANPAINT", is_index: false },
      { symbol: "BANKNIFTY", name: "BANKNIFTY", is_index: true },
    ],
    chains: new Map([
      ["RELIANCE", chain(50)],
      ["NIFTY", chain(75)],
      ["ASIANPAINT", chain(50)],
      ["BANKNIFTY", chain(35)],
    ]),
    exclusions: new Map(),
    caps: { maxOpenLegQuantity: 0, maxGrossOpenLegQuantity: 0 },
  });
  assert.deepEqual(
    rows.map((r) => r.symbol),
    ["BANKNIFTY", "NIFTY", "ASIANPAINT", "RELIANCE"],
  );
});

test("a board row with NO chain is dropped, not surfaced as unusable", () => {
  const rows = projectUniverse({
    board: board("HASCHAIN", "NOCHAIN"),
    chains: new Map([["HASCHAIN", chain(75)]]),
    exclusions: new Map(),
    caps: CAPS,
  });
  assert.deepEqual(rows.map((r) => r.symbol), ["HASCHAIN"]);
});

test("exclusion state and the operator's reason are carried through", () => {
  const rows = projectUniverse({
    board: board("NYKAA", "TCS"),
    chains: new Map([["NYKAA", chain(75)], ["TCS", chain(75)]]),
    exclusions: new Map([["NYKAA", { reason: "illiquid strikes" }]]),
    caps: CAPS,
  });
  const nykaa = rows.find((r) => r.symbol === "NYKAA");
  const tcs = rows.find((r) => r.symbol === "TCS");
  assert.equal(nykaa.excluded, true);
  assert.equal(nykaa.excluded_reason, "illiquid strikes");
  assert.equal(tcs.excluded, false);
  assert.equal(tcs.excluded_reason, null);
});

test("an excluded name still reports its admissibility honestly", () => {
  // Excluding a name does not change whether the caps would have permitted it. Conflating the two
  // would hide a misconfigured cap behind an operator's unrelated decision.
  const rows = projectUniverse({
    board: board("BIGLOT"),
    chains: new Map([["BIGLOT", chain(5000)]]),
    exclusions: new Map([["BIGLOT", { reason: "too big" }]]),
    caps: CAPS,
  });
  assert.equal(rows[0].excluded, true);
  assert.equal(rows[0].admissible, false);
  assert.equal(rows[0].inadmissible_reason, "lot_exceeds_per_leg_cap");
});

test("lot size, expiry and paired-strike count are projected for the picker", () => {
  const rows = projectUniverse({
    board: board("TCS"),
    chains: new Map([["TCS", chain(175, [3000, 3100, 3200, 3300], "2026-10-29")]]),
    exclusions: new Map(),
    caps: { maxOpenLegQuantity: 0, maxGrossOpenLegQuantity: 0 },
  });
  assert.equal(rows[0].lot_size, 175);
  assert.equal(rows[0].expiry, "2026-10-29");
  assert.equal(rows[0].paired_strikes, 4);
});

test("an unusable lot is projected as 0 rather than a negative", () => {
  const rows = projectUniverse({
    board: board("BROKEN"),
    chains: new Map([["BROKEN", chain(-5)]]),
    exclusions: new Map(),
    caps: CAPS,
  });
  assert.equal(rows[0].lot_size, 0);
  assert.equal(rows[0].admissible, false);
});

test("name falls back to the symbol when the board row carries none", () => {
  const rows = projectUniverse({
    board: [{ symbol: "M&M" }],
    chains: new Map([["M&M", chain(75)]]),
    exclusions: new Map(),
    caps: CAPS,
  });
  assert.equal(rows[0].name, "M&M");
  assert.equal(rows[0].is_index, false, "a missing is_index must not read as an index");
});

/* ─────────────────────────── the summary ─────────────────────────── */

test("the summary separates EXCLUDED from BLOCKED-BY-CAPS, and counts neither as watchable", () => {
  const rows = projectUniverse({
    board: [
      { symbol: "NIFTY", name: "NIFTY", is_index: true },
      ...board("OKSTOCK", "BIGLOT", "DECLINED"),
    ],
    chains: new Map([
      ["NIFTY", chain(75)],
      ["OKSTOCK", chain(50)],
      ["BIGLOT", chain(5000)],
      ["DECLINED", chain(50)],
    ]),
    exclusions: new Map([["DECLINED", { reason: null }]]),
    caps: CAPS,
  });
  const s = summariseUniverse(rows);
  assert.equal(s.total, 4);
  assert.equal(s.indices, 1);
  assert.equal(s.excluded, 1, "DECLINED");
  assert.equal(s.blocked_by_caps, 1, "BIGLOT — not excluded, but can never trade");
  assert.equal(s.watchable, 2, "NIFTY + OKSTOCK");
});

test("an EXCLUDED and inadmissible name counts once, as excluded", () => {
  // Otherwise a single name would inflate two different counters and the totals would not add up.
  const rows = projectUniverse({
    board: board("BIGLOT"),
    chains: new Map([["BIGLOT", chain(5000)]]),
    exclusions: new Map([["BIGLOT", { reason: "too big" }]]),
    caps: CAPS,
  });
  const s = summariseUniverse(rows);
  assert.equal(s.excluded, 1);
  assert.equal(s.blocked_by_caps, 0, "already declined, so not reported as a config problem");
  assert.equal(s.watchable, 0);
  assert.equal(s.excluded + s.blocked_by_caps + s.watchable, s.total);
});

test("an empty universe summarises to zeroes rather than throwing", () => {
  const s = summariseUniverse([]);
  assert.deepEqual(s, { total: 0, indices: 0, excluded: 0, watchable: 0, blocked_by_caps: 0 });
});
