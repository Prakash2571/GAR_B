/**
 * COMPOSED REGRESSION — a stale adapter snapshot must not reach coverage, unwind sizing or
 * downstream exposure arithmetic.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM tests/box/restStreamFillRace.test.mjs
 * That file proves the two live adapters no longer LOSE a fill. This one proves the second half of
 * the defect, which lives in the manager: `persistOrder()` returns the DURABLE row, and that row can
 * hold a HIGHER cumulative quantity than the snapshot just written — the PostgreSQL compare-and-set
 * refuses a regressing `filled_quantity` and returns the current row instead, which is exactly what
 * happens when a stream-fed reconcile pass has already persisted more. Every caller but one
 * discarded that return value and resolved the ORIGINAL adapter snapshot, so an under-reported
 * quantity flowed into:
 *   • the hedge-coverage ledger (a dependent SELL judged against too little proven cover),
 *   • `unwindConfirmed`, whose `exposure` map is built from the resolved orders — an undersized
 *     unwind leaves real broker exposure behind while the system believes it flattened,
 *   • `residualAfterUnwind` and the quantity-conservation check, which are computed from the SAME
 *     under-reported numbers and therefore agree with each other and miss the gap.
 *
 * These tests run the REAL CentralBoxExecutionGateway → BoxOrderManager → durable persistence
 * stack from tests/box/liveEntryHarness.mjs. Only the two genuine process boundaries are faked.
 *
 * HOW THE DIVERGENCE IS MODELLED, AND WHY IT IS FAITHFUL
 * `duringPacing` fires inside the adapter while one leg is waiting to be transmitted — the real
 * window in which a concurrent observer can persist a fill. The hook does exactly what a
 * stream-fed reconcile pass does in production:
 *   1. writes the higher cumulative quantity to the durable row, and
 *   2. attributes that durable truth to the manager (via the production
 *      `setAttributedBoxPositions`, recomputed from the durable rows — the API's documented use).
 * The submitting leg's own `persistOrder` then patches the LOWER figure, the fill guard in the
 * in-memory persistence refuses it exactly as `repository.updateBoxOrderIntent`'s `fillOk` guard
 * does, and returns the current row. No production check is bypassed or relaxed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BOX_ENTRY_SIDES_BY_DIRECTION } from "../../dist/box/types.js";
import { entrySubmissionOrder } from "../../dist/box/entrySubmissionOrder.js";
import { brokerOrderFor, liveStack, runEntry } from "./liveEntryHarness.mjs";

const LOTS = 75;

/** Hedge (BUY) and short (SELL) roles for a direction, in entry submission order. */
function geometry(direction) {
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];
  const order = entrySubmissionOrder(direction);
  return {
    sides,
    hedges: order.filter((slot) => slot.hedge).map((slot) => slot.role),
    shorts: order.filter((slot) => !slot.hedge).map((slot) => slot.role),
  };
}

/**
 * Re-attribute signed exposure from the DURABLE rows.
 *
 * This is what a reconcile pass does after it persists an observation: attribution follows the
 * durable truth, never a caller's snapshot.
 */
function attributeFromDurable(manager, persistence) {
  const bySymbol = new Map();
  for (const row of persistence.rows.values()) {
    if (!row.filled_quantity) continue;
    const key = `${row.exchange}:${row.tradingsymbol}`;
    const signed = row.side === "BUY" ? row.filled_quantity : -row.filled_quantity;
    const prior = bySymbol.get(key);
    bySymbol.set(key, {
      exchange: row.exchange,
      tradingsymbol: row.tradingsymbol,
      token: row.token,
      net_quantity: (prior?.net_quantity ?? 0) + signed,
      average_price: row.average_price ?? 0,
    });
  }
  manager.setAttributedBoxPositions([...bySymbol.values()]);
}

/**
 * A live stack in which ONE role's adapter snapshot under-reports the fill while the durable row
 * (and attribution) already hold the full quantity.
 *
 * @param staleRole   the role whose adapter snapshot reports `staleFilled` instead of the truth
 * @param failRole    a role that genuinely does not fill, forcing the partial-entry unwind
 */
async function divergentStack({ direction, staleRole, staleFilled, failRole }) {
  let stack;
  const adapterOptions = {
    // Fires while the leg waits in adapter pacing — before its POST and before persistOrder.
    duringPacing: async (req) => {
      if (req.role !== staleRole || req.purpose !== "ENTRY") return;
      const row = stack.persistence.rows.get(req.client_order_id);
      if (!row) return;
      // A concurrent observer proved the FULL fill and persisted it. A reconcile pass writes the
      // quantity AND the state it implies together, so the model does too.
      row.filled_quantity = req.quantity;
      row.average_price = req.pricing.reference_price;
      row.previous_filled_quantity = 0;
      row.state = "COMPLETE";
      row.terminal_at = new Date(row.updated_at);
      stack.persistence.rows.set(req.client_order_id, row);
      attributeFromDurable(stack.manager, stack.persistence);
    },
    submit: async (req) => {
      if (req.purpose !== "ENTRY") {
        // Unwind / reduction legs fill completely so the test measures SIZING, not slippage.
        return brokerOrderFor(req, req.quantity, "COMPLETE");
      }
      if (failRole && req.role === failRole) return brokerOrderFor(req, 0, "CANCELLED");
      if (req.role === staleRole) {
        // THE STALE SNAPSHOT: an older REST read that under-reports the cumulative quantity.
        return brokerOrderFor(req, staleFilled, "PARTIALLY_FILLED");
      }
      return brokerOrderFor(req, req.quantity, "COMPLETE");
    },
  };
  stack = await liveStack({ direction, adapterOptions });
  return stack;
}

/** POSTs that reached the (recording) broker for a role, by purpose. */
function postsFor(adapter, role, purpose) {
  return adapter.posts.filter((post) => post.role === role && (!purpose || post.purpose === purpose));
}

for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
  const { hedges, shorts, sides } = geometry(direction);
  const staleHedge = hedges[0];
  const failingShort = shorts[shorts.length - 1];

  test(`${direction}: the unwind is sized from the DURABLE quantity, not a stale adapter snapshot`, async () => {
    const stack = await divergentStack({
      direction,
      staleRole: staleHedge,
      staleFilled: 30,
      failRole: failingShort,
    });

    const result = await runEntry(stack);
    assert.equal(result.ok, false, "one leg did not fill, so there is no valid box");

    // The protective unwind reverses confirmed exposure. For the diverged hedge that means selling
    // back what the DURABLE row proved (the full quantity), not the stale 30.
    const unwind = postsFor(stack.adapter, staleHedge).filter((post) => post.purpose === "EMERGENCY_RESIDUAL");
    assert.ok(unwind.length > 0, `${staleHedge} must be unwound: the durable row proves real exposure`);
    const unwoundQty = unwind.reduce((total, post) => total + post.quantity, 0);
    assert.equal(
      unwoundQty,
      LOTS,
      `${staleHedge} unwind was sized ${unwoundQty} but the durable row holds ${LOTS}; ` +
        "a stale adapter snapshot produced an UNDERSIZED unwind and left real exposure at the broker",
    );
    // The reversal must be on the reducing side of the exposure the entry created.
    assert.equal(
      unwind[0].side,
      sides[staleHedge] === "BUY" ? "SELL" : "BUY",
      "the unwind reverses the entry side",
    );
  });

  test(`${direction}: coverage for a dependent short uses the DURABLE hedge quantity`, async () => {
    // No failing leg here: every other leg fills. The only question is whether the hedge whose
    // adapter snapshot under-reported is nevertheless treated as fully covering its dependent SELL.
    const stack = await divergentStack({
      direction,
      staleRole: staleHedge,
      staleFilled: 30,
      failRole: null,
    });

    await runEntry(stack);

    // Every leg must have been transmitted: an under-reported hedge previously starved the
    // dependent SELL of proven cover, so the box could not complete.
    for (const role of [...hedges, ...shorts]) {
      assert.ok(
        postsFor(stack.adapter, role, "ENTRY").length > 0,
        `${role} must reach the broker; the hedge was durably proven at ${LOTS}`,
      );
    }

    // And the durable truth is what the system believes for the diverged leg.
    const staleRow = [...stack.persistence.rows.values()].find(
      (row) => row.role === staleHedge && row.purpose === "ENTRY",
    );
    assert.equal(staleRow.filled_quantity, LOTS, "the durable row retains the proven quantity");
    assert.ok(
      !stack.violations.some((reason) => /conservation/i.test(reason)),
      `quantity conservation must hold: ${stack.violations.join("; ")}`,
    );
  });
}
