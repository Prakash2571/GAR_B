/**
 * A fully executed exit MUST be durably persistable — against real PostgreSQL.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THESE TESTS PIN
 *
 * `BoxEngine.closePaperTrade()` (used for live closes too) builds its close payload with dotted
 * per-leg keys:
 *
 *     setFields[`legs.${i}.exit_price`] = …
 *     setFields[`legs.${i}.exit_bid`]   = …
 *
 * and `buildTradePatch()` interpolated every key straight into the SQL SET list, producing
 *
 *     UPDATE box_trades SET legs.0.exit_price = $2 …
 *
 * which PostgreSQL rejects: `syntax error at or near ".0"`.
 *
 * The consequence is not a cosmetic logging failure. All four entry legs and all four exit legs
 * execute at the broker, the operator is genuinely FLAT — and the backend cannot record it. The trade
 * row stays `open`, the in-memory position enters RECOVERY, and the retry re-issues the identical
 * invalid statement indefinitely. A restart then reconciles an OPEN trade projection against broker
 * exposure that no longer exists, which is the single worst disagreement to carry into recovery.
 *
 * WHY IT NEEDED A REAL DATABASE. Every unit-level suite passes: the engine builds a correct-looking
 * payload and the repository is a well-tested module. The defect lives only in the composition, and
 * only PostgreSQL can reject the SQL. That is precisely the gap this file closes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, loadRepository, baseTrade } from "./helpers.mjs";

let ctx;
let repo;

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];

/** Four legs shaped like the entry writes them, so the jsonb paths `{i,field}` exist. */
const entryLegs = () =>
  ROLES.map((role, i) => ({
    role,
    tradingsymbol: `NIFTY26SEP2500${i}CE`,
    token: 1000 + i,
    side: i < 2 ? "BUY" : "SELL",
    quantity: 75,
    entry_price: 100 + i,
    entry_bid: 99 + i,
    entry_ask: 101 + i,
    exit_price: null,
    exit_bid: null,
    exit_ask: null,
  }));

/** The engine's real close payload shape, dotted per-leg keys included. */
function enginePayload() {
  const setFields = {
    status: "closed",
    closed_at: new Date(),
    net_pnl: 1234.5,
    realised_net_pnl: 1234.5,
    exit_blocked_reason: null,
  };
  for (const [i] of ROLES.entries()) {
    setFields[`legs.${i}.exit_price`] = 110 + i;
    setFields[`legs.${i}.exit_bid`] = 109 + i;
    setFields[`legs.${i}.exit_bid_qty`] = 750;
    setFields[`legs.${i}.exit_ask`] = 111 + i;
    setFields[`legs.${i}.exit_ask_qty`] = 900;
    setFields[`legs.${i}.exit_quote_at`] = new Date(1_800_000_000_000 + i);
    setFields[`legs.${i}.exit_depth`] = { bids: [[109 + i, 750]], asks: [[111 + i, 900]] };
    setFields[`legs.${i}.exit_detected_price`] = 110.5 + i;
    setFields[`legs.${i}.exit_slippage`] = 0.5;
  }
  return setFields;
}

test.before(async () => {
  ctx = await setup("tradeclose");
  repo = await loadRepository();
});
test.after(async () => { await teardown(ctx); });

test("the engine's real close payload persists, and the trade actually reaches closed", async () => {
  const open = await repo.insertBoxTrade(
    baseTrade({ lower_strike: 31000, upper_strike: 31200, legs: entryLegs() }),
  );
  assert.ok(open, "the box opened");

  // This is the call that used to throw `syntax error at or near ".0"`.
  const closed = await repo.closeBoxTrade(open._id, enginePayload(), "close-key-1");

  assert.ok(closed, "closeBoxTrade returned a record rather than throwing or returning null");
  assert.equal(closed.status, "closed", "the trade is durably CLOSED, not left open");
  assert.equal(Number(closed.net_pnl), 1234.5);
});

test("every leg's exit evidence lands on the right leg, and entry fields survive", async () => {
  const open = await repo.insertBoxTrade(
    baseTrade({ lower_strike: 31400, upper_strike: 31600, legs: entryLegs() }),
  );
  const closed = await repo.closeBoxTrade(open._id, enginePayload(), "close-key-2");
  assert.ok(closed);

  assert.equal(closed.legs.length, 4, "still four legs — the array was patched, not replaced");
  for (const [i, role] of ROLES.entries()) {
    const leg = closed.legs[i];
    assert.equal(leg.role, role, `leg ${i} is still ${role} (order preserved)`);
    // The exit evidence written by this close.
    assert.equal(Number(leg.exit_price), 110 + i, `leg ${i} exit_price`);
    assert.equal(Number(leg.exit_bid), 109 + i, `leg ${i} exit_bid`);
    assert.equal(Number(leg.exit_ask), 111 + i, `leg ${i} exit_ask`);
    assert.equal(Number(leg.exit_bid_qty), 750);
    assert.equal(Number(leg.exit_slippage), 0.5);
    assert.ok(leg.exit_depth, `leg ${i} keeps its depth snapshot object`);
    assert.ok(leg.exit_quote_at, `leg ${i} keeps its quote timestamp`);
    // ENTRY fields must be untouched: a per-leg patch must not clobber the rest of the leg.
    assert.equal(Number(leg.entry_price), 100 + i, `leg ${i} entry_price preserved`);
    assert.equal(leg.tradingsymbol, `NIFTY26SEP2500${i}CE`, `leg ${i} contract preserved`);
    assert.equal(Number(leg.quantity), 75, `leg ${i} quantity preserved`);
  }
});

test("an ABSENT observation clears one field without destroying the legs document", async () => {
  /*
   * `jsonb_set(doc, path, NULL)` returns NULL for the WHOLE DOCUMENT. The engine legitimately sends
   * `null` for a leg whose exit quote was never observed, so a naive binding would erase all four
   * legs — turning missing evidence into lost evidence.
   */
  const open = await repo.insertBoxTrade(
    baseTrade({ lower_strike: 31800, upper_strike: 32000, legs: entryLegs() }),
  );
  const payload = enginePayload();
  payload["legs.1.exit_price"] = null;
  payload["legs.1.exit_depth"] = null;

  const closed = await repo.closeBoxTrade(open._id, payload, "close-key-3");
  assert.ok(closed);
  assert.equal(closed.legs.length, 4, "the legs document survived a null-valued patch");
  assert.equal(closed.legs[1].exit_price, null, "the unobserved field is null");
  assert.equal(closed.legs[1].exit_depth, null);
  assert.equal(Number(closed.legs[1].entry_price), 101, "its entry evidence is intact");
  assert.equal(Number(closed.legs[2].exit_price), 112, "and the OTHER legs are untouched");
});

test("the close is idempotent under retry", async () => {
  // The failure mode this replaces retried forever. A retry must now find the closed row, not
  // re-close it and not report failure.
  const open = await repo.insertBoxTrade(
    baseTrade({ lower_strike: 32200, upper_strike: 32400, legs: entryLegs() }),
  );
  const first = await repo.closeBoxTrade(open._id, enginePayload(), "retry-key");
  assert.ok(first && first.status === "closed");

  const again = await repo.closeBoxTrade(open._id, enginePayload(), "retry-key");
  assert.ok(again, "the retry resolves through the idempotency key instead of returning null");
  assert.equal(again.status, "closed");
  assert.equal(again._id, first._id);
});

test("a non-whitelisted leg field is refused at the boundary, not at the database", async () => {
  // A typo must not silently create a phantom leg property that no reader checks.
  const open = await repo.insertBoxTrade(
    baseTrade({ lower_strike: 32600, upper_strike: 32800, legs: entryLegs() }),
  );
  await assert.rejects(
    () => repo.closeBoxTrade(open._id, { status: "closed", "legs.0.exit_pricce": 1 }, "bad-field"),
    /not in the patchable set/,
    "the whitelist names the problem instead of emitting invalid or surprising SQL",
  );
  // And the trade is untouched.
  const still = await repo.loadOpenBoxTrades?.();
  if (Array.isArray(still)) {
    assert.ok(still.some((t) => String(t._id) === String(open._id)), "the trade is still open");
  }
});
