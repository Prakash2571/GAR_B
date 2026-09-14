/**
 * THE MERGE STATE TABLE, ENUMERATED.
 *
 * `mergeBrokerOrderSnapshot` is the single authority deciding which of two observations of one
 * broker order is believed, field by field. The adapter/manager tests exercise it through realistic
 * scenarios, but a scenario test only visits the combinations that scenario happens to produce, and
 * a review found three real defects sitting in combinations none of them reached.
 *
 * So this file enumerates the table directly: terminal vs terminal, terminal vs working, the
 * UNCERTAIN pair, the three `observedCumulativeQty` modes (number / null / absent), identity
 * mismatch, broker-order-id conflict, price selection and fill-record selection.
 *
 * THE TWO RULES EVERY CASE IS MEASURED AGAINST:
 *   1. A confirmed cumulative quantity may never decrease, and may never be fabricated.
 *   2. Uncertainty may never be dissolved by an observation that is provably older, and certainty
 *      may never be manufactured from a contradiction. Where the two observations genuinely
 *      disagree the answer is RECONCILIATION_REQUIRED with a named conflict — never a guess.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { mergeBrokerOrderSnapshot, cloneBrokerOrder } from "../../dist/box/brokerOrderMerge.js";

const QTY = 100;

/** A BrokerOrder with only the fields the merge reasons about varied per case. */
function order(overrides = {}) {
  const filled = overrides.filled_quantity ?? 0;
  return {
    client_order_id: "C1",
    broker_order_id: "B1",
    tag: null,
    role: "k1_ce",
    trade_id: "t1",
    attempt_id: "a1",
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: "NIFTY26SEP19900CE",
    token: 1001,
    side: "BUY",
    quantity: QTY,
    pricing: { order_type: "LIMIT", reference_price: 10, tick_size: 0.05, max_chase_ticks: 0, limit_price: 10 },
    limit_price: 10,
    state: "OPEN",
    filled_quantity: filled,
    pending_quantity: Math.max(0, QTY - filled),
    average_price: null,
    fills: [],
    reject_family: null,
    reject_reason: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

const confirmed = { quantity: "confirmed", price: "confirmed", accounting: "complete" };

/** Merge helper: `observed` is the candidate's RAW reading (omit to compare filled_quantity). */
function merge(current, candidate, observed) {
  return observed === undefined
    ? mergeBrokerOrderSnapshot(current, candidate)
    : mergeBrokerOrderSnapshot(current, candidate, { observedCumulativeQty: observed });
}

/* ═══════════════════════ the UNCERTAIN pair ═══════════════════════ */

test("UNKNOWN survives a provably STALE observation — uncertainty is not dissolved by older evidence", () => {
  const m = merge(
    order({ state: "UNKNOWN", filled_quantity: 75, average_price: 12, execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 30, average_price: 11, execution_evidence: confirmed }),
    30,
  );
  // UNKNOWN is what an empty/failed read records: "the broker may own something we cannot read".
  // Two protections key on it — executionAccountingComplete() short-circuits to false, and the
  // manager's RECONCILE_STATES path credits NO hedge coverage. An older observation must not remove
  // either of them. The quantity floor is not what is at stake; 75 is preserved regardless.
  assert.equal(m.order.state, "UNKNOWN", "a stale observation may not resolve an uncertain state");
  assert.equal(m.order.filled_quantity, 75, "and the proven quantity still stands");
});

test("RECONCILIATION_REQUIRED is sticky against a stale observation", () => {
  const m = merge(
    order({ state: "RECONCILIATION_REQUIRED", filled_quantity: 75, execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 30, execution_evidence: confirmed }),
    30,
  );
  assert.equal(m.order.state, "RECONCILIATION_REQUIRED");
});

test("a FRESH successful read DOES clear UNKNOWN — the fail-safe is not a trap", () => {
  const m = merge(
    order({ state: "UNKNOWN", filled_quantity: 30, execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 50, execution_evidence: confirmed }),
    50,
  );
  assert.equal(m.order.state, "PARTIALLY_FILLED", "a newer observation legitimately resolves uncertainty");
  assert.equal(m.order.filled_quantity, 50);
});

test("a newer empty read may still RAISE uncertainty on a working order", () => {
  const m = merge(
    order({ state: "OPEN", filled_quantity: 30, execution_evidence: confirmed }),
    order({ state: "UNKNOWN", filled_quantity: 30, execution_evidence: confirmed }),
    30,
  );
  assert.equal(m.order.state, "UNKNOWN");
  assert.equal(m.order.filled_quantity, 30, "raising uncertainty must not lose the fill");
});

test("uncertainty may NOT reopen a confirmed terminal order", () => {
  for (const terminal of ["COMPLETE", "CANCELLED", "REJECTED"]) {
    const filled = terminal === "COMPLETE" ? QTY : 0;
    const m = merge(
      order({ state: terminal, filled_quantity: filled, execution_evidence: confirmed }),
      order({ state: "UNKNOWN", filled_quantity: filled, execution_evidence: confirmed }),
      filled,
    );
    assert.equal(m.order.state, terminal, `${terminal} must not be reopened by UNKNOWN`);
  }
});

/* ═══════════════════════ terminal vs terminal ═══════════════════════ */

test("a COMPLETE label contradicting the cumulative quantity is escalated, from EVERY cached state", () => {
  // The contradiction is the same fact regardless of what we already held, so the verdict must be
  // the same. Reachable on Kite: `kiteState` returns COMPLETE on the label before it inspects the
  // quantity, so a COMPLETE row whose filled_quantity lags produces exactly this candidate.
  for (const cached of ["OPEN", "PARTIALLY_FILLED", "CANCELLED"]) {
    const m = merge(
      order({ state: cached, filled_quantity: 30, execution_evidence: confirmed }),
      order({ state: "COMPLETE", filled_quantity: 30, execution_evidence: confirmed }),
      30,
    );
    assert.equal(
      m.order.state,
      "RECONCILIATION_REQUIRED",
      `cached ${cached} + observed COMPLETE at 30/${QTY} is a contradiction and must reconcile`,
    );
    assert.ok(m.conflict, `and the conflict must be named (cached ${cached})`);
    assert.equal(m.order.filled_quantity, 30, "exposure is preserved either way");
  }
});

test("a cancellation that raced a FULL fill resolves to COMPLETE however both sides label it", () => {
  const cases = [
    ["CANCELLED", "COMPLETE"],
    ["COMPLETE", "CANCELLED"],
    ["CANCELLED", "CANCELLED"], // both label it cancelled, but the whole request is filled
  ];
  for (const [cached, observed] of cases) {
    const m = merge(
      order({ state: cached, filled_quantity: QTY, execution_evidence: confirmed }),
      order({ state: observed, filled_quantity: QTY, execution_evidence: confirmed }),
      QTY,
    );
    assert.equal(
      m.order.state,
      "COMPLETE",
      `${cached} + ${observed} with the full quantity filled is a completion — nothing remained to cancel`,
    );
    assert.equal(m.order.pending_quantity, 0);
  }
});

test("a partial fill then a cancellation is an ordinary, consistent outcome", () => {
  const m = merge(
    order({ state: "CANCELLED", filled_quantity: 30, execution_evidence: confirmed }),
    order({ state: "CANCELLED", filled_quantity: 30, execution_evidence: confirmed }),
    30,
  );
  assert.equal(m.order.state, "CANCELLED");
  assert.equal(m.conflict, null);
  assert.equal(m.order.pending_quantity, QTY - 30);
});

test("REJECTED against a confirmed positive fill is a contradiction, and keeps the broker's classification", () => {
  const m = merge(
    order({ state: "PARTIALLY_FILLED", filled_quantity: 40, execution_evidence: confirmed }),
    order({
      state: "REJECTED",
      filled_quantity: 0,
      reject_family: "margin",
      reject_reason: "insufficient margin",
      execution_evidence: confirmed,
    }),
    0,
  );
  assert.equal(m.order.state, "RECONCILIATION_REQUIRED", "REJECTED asserts nothing executed");
  assert.equal(m.order.filled_quantity, 40, "the confirmed fill is not erased by the rejection");
  assert.ok(m.conflict);
  // An operator reconciling this needs the broker's own words, and `outcomeStore.recordReject`
  // attributes on the family. Neither may be discarded on the way to reconciliation.
  assert.equal(m.order.reject_family, "margin", "the broker's reject family survives");
  assert.match(m.order.reject_reason, /insufficient margin/, "and its message survives");
});

/* ═══════════════════════ terminal vs working ═══════════════════════ */

test("a stale working observation cannot reopen a terminal order", () => {
  const m = merge(
    order({ state: "COMPLETE", filled_quantity: QTY, execution_evidence: confirmed }),
    order({ state: "OPEN", filled_quantity: 30, execution_evidence: confirmed }),
    30,
  );
  assert.equal(m.order.state, "COMPLETE");
  assert.equal(m.order.filled_quantity, QTY);
});

test("a LATE fill completing a cancelled order is accepted, not frozen out", () => {
  const m = merge(
    order({ state: "CANCELLED", filled_quantity: 30, execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: QTY, execution_evidence: confirmed }),
    QTY,
  );
  assert.equal(m.order.state, "COMPLETE", "the whole request is filled, so it completed");
  assert.equal(m.order.filled_quantity, QTY);
});

test("a late PARTIAL fill on a cancelled order raises the quantity but keeps CANCELLED", () => {
  const m = merge(
    order({ state: "CANCELLED", filled_quantity: 30, execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 50, execution_evidence: confirmed }),
    50,
  );
  assert.equal(m.order.state, "CANCELLED");
  assert.equal(m.order.filled_quantity, 50);
  assert.equal(m.order.pending_quantity, QTY - 50);
});

/* ═══════════════════════ identity and attribution ═══════════════════════ */

test("a broker-order-id conflict forces reconciliation and never silently reassigns", () => {
  const m = merge(
    order({ state: "COMPLETE", filled_quantity: QTY, broker_order_id: "B1", execution_evidence: confirmed }),
    order({ state: "COMPLETE", filled_quantity: QTY, broker_order_id: "B2", execution_evidence: confirmed }),
    QTY,
  );
  // The durable layer treats a broker-id reassignment as a HARD guard failure
  // (repository.updateBoxOrderIntent). The session projection must not be more permissive: two
  // different broker orders claiming one client order id is an attribution fault, not a data question.
  assert.ok(m.conflict, "the conflict must be reported");
  assert.equal(m.order.broker_order_id, "B1", "the learned id is never reassigned");
  assert.equal(
    m.order.state,
    "RECONCILIATION_REQUIRED",
    "an attribution conflict must not be left on a terminal order",
  );
});

test("a broker id is LEARNED when the cached one is null", () => {
  const m = merge(
    order({ state: "OPEN", broker_order_id: null }),
    order({ state: "OPEN", broker_order_id: "B9" }),
    0,
  );
  assert.equal(m.order.broker_order_id, "B9");
  assert.equal(m.conflict, null);
});

test("a client-order-identity mismatch refuses to blend the two orders", () => {
  const m = merge(
    order({ client_order_id: "C1", filled_quantity: 40, execution_evidence: confirmed }),
    order({ client_order_id: "C2", filled_quantity: 90, execution_evidence: confirmed }),
    90,
  );
  assert.match(m.conflict, /identity mismatch/);
  assert.equal(m.order.client_order_id, "C1", "the cached order the key belongs to is kept");
  assert.equal(m.order.filled_quantity, 40, "the other order's quantity is NOT adopted");
});

test("no cached order means the candidate is adopted as-is", () => {
  const candidate = order({ state: "COMPLETE", filled_quantity: QTY });
  const m = merge(undefined, candidate, QTY);
  assert.equal(m.order.state, "COMPLETE");
  assert.equal(m.order.filled_quantity, QTY);
  assert.equal(m.conflict, null);
});

/* ═══════════════════════ observedCumulativeQty modes ═══════════════════════ */

test("ABSENT observed quantity (null) is not evidence and cannot donate a price", () => {
  // Absence is not zero. A snapshot that reported no cumulative quantity cannot outrank a fill we
  // already hold, and its price describes an unknown quantity, so it must not be adopted.
  const m = merge(
    order({ state: "PARTIALLY_FILLED", filled_quantity: 75, average_price: 12, execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 75, average_price: 99, execution_evidence: confirmed }),
    null,
  );
  assert.equal(m.order.filled_quantity, 75);
  assert.equal(m.order.average_price, 12, "the price of an unquantified snapshot is not adopted");
});

test("OMITTED options mean the candidate is raw-faithful and compared on filled_quantity", () => {
  const m = merge(
    order({ state: "PARTIALLY_FILLED", filled_quantity: 30, average_price: 11, execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 60, average_price: 13, execution_evidence: confirmed }),
  );
  assert.equal(m.order.filled_quantity, 60);
  assert.equal(m.order.average_price, 13, "the advancing observation supplies the price");
});

/* ═══════════════════════ price and evidence ═══════════════════════ */

test("an advancing fill with NO price yields null and pending_price, never a carried-over average", () => {
  const m = merge(
    order({ state: "PARTIALLY_FILLED", filled_quantity: 30, average_price: 11, execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 80, average_price: null, execution_evidence: { quantity: "confirmed", price: "missing", accounting: "pending_price" } }),
    80,
  );
  assert.equal(m.order.filled_quantity, 80, "exposure stands");
  assert.equal(m.order.average_price, null, "the 30-lot average is NOT the average of 80");
  assert.equal(m.order.execution_evidence.accounting, "pending_price");
});

test("an equal-quantity observation may ENRICH a missing price", () => {
  const m = merge(
    order({ state: "PARTIALLY_FILLED", filled_quantity: 50, average_price: null, execution_evidence: { quantity: "confirmed", price: "missing", accounting: "pending_price" } }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 50, average_price: 14, execution_evidence: confirmed }),
    50,
  );
  assert.equal(m.order.average_price, 14);
  assert.equal(m.order.execution_evidence.accounting, "complete");
});

test("a zero accepted quantity carries no price", () => {
  const m = merge(
    order({ state: "CANCELLED", filled_quantity: 0, execution_evidence: confirmed }),
    order({ state: "CANCELLED", filled_quantity: 0, average_price: 7, execution_evidence: confirmed }),
    0,
  );
  assert.equal(m.order.average_price, null);
  assert.equal(m.order.execution_evidence.price, "not_applicable");
});

/* ═══════════════════════ fill records ═══════════════════════ */

test("a single STALE aggregate row is replaced, never left describing a smaller fill", () => {
  const m = merge(
    order({ state: "PARTIALLY_FILLED", filled_quantity: 30, average_price: 11, fills: [{ fill_id: "f30", quantity: 30, price: 11, at: 1 }], execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 80, average_price: 12, fills: [], execution_evidence: confirmed }),
    80,
  );
  const summed = m.order.fills.reduce((t, f) => t + f.quantity, 0);
  assert.equal(summed, 80, "a lone aggregate row must equal the accepted cumulative quantity");
});

test("multi-row per-trade detail is KEPT even when it lags the aggregate (granularity, not exposure)", () => {
  const rows = [
    { fill_id: "t1", quantity: 20, price: 11, at: 1 },
    { fill_id: "t2", quantity: 20, price: 12, at: 2 },
  ];
  const m = merge(
    order({ state: "PARTIALLY_FILLED", filled_quantity: 40, fills: rows, execution_evidence: confirmed }),
    order({ state: "PARTIALLY_FILLED", filled_quantity: 60, fills: rows, execution_evidence: confirmed }),
    60,
  );
  assert.equal(m.order.fills.length, 2, "a lagging trade book degrades detail, not exposure");
  assert.equal(m.order.filled_quantity, 60);
});

test("repeating the identical observation is idempotent — fills never accumulate", () => {
  const cached = order({ state: "PARTIALLY_FILLED", filled_quantity: 50, average_price: 12, fills: [{ fill_id: "f50", quantity: 50, price: 12, at: 1 }], execution_evidence: confirmed });
  const obs = cloneBrokerOrder(cached);
  const once = merge(cached, obs, 50);
  const twice = merge(once.order, cloneBrokerOrder(obs), 50);
  assert.equal(twice.order.filled_quantity, 50);
  assert.equal(twice.order.fills.length, 1);
  assert.equal(twice.order.fills.reduce((t, f) => t + f.quantity, 0), 50);
});

/* ═══════════════════════ invariants that must hold everywhere ═══════════════════════ */

test("INVARIANT: across the whole table, quantity never decreases and pending always follows it", () => {
  const states = ["OPEN", "PARTIALLY_FILLED", "COMPLETE", "CANCELLED", "REJECTED", "UNKNOWN", "RECONCILIATION_REQUIRED"];
  const quantities = [0, 30, QTY];
  for (const cs of states) {
    for (const cq of quantities) {
      for (const ns of states) {
        for (const nq of quantities) {
          const m = merge(
            order({ state: cs, filled_quantity: cq, execution_evidence: confirmed }),
            order({ state: ns, filled_quantity: nq, execution_evidence: confirmed }),
            nq,
          );
          const expected = Math.max(cq, nq);
          assert.equal(
            m.order.filled_quantity,
            expected,
            `${cs}/${cq} + ${ns}/${nq}: accepted quantity must be the monotonic maximum`,
          );
          assert.equal(
            m.order.pending_quantity,
            Math.max(0, QTY - expected),
            `${cs}/${cq} + ${ns}/${nq}: pending must follow the accepted quantity`,
          );
          assert.ok(
            m.order.average_price === null || m.order.average_price > 0,
            `${cs}/${cq} + ${ns}/${nq}: a price is never zero or negative`,
          );
          const summed = m.order.fills.reduce((t, f) => t + f.quantity, 0);
          assert.ok(
            summed <= expected,
            `${cs}/${cq} + ${ns}/${nq}: fills must never exceed the accepted quantity`,
          );
        }
      }
    }
  }
});

test("INVARIANT: a confirmed terminal state is never reopened by a NON-terminal observation", () => {
  for (const terminal of ["COMPLETE", "CANCELLED", "REJECTED"]) {
    for (const working of ["OPEN", "PARTIALLY_FILLED", "ACKNOWLEDGED", "UNKNOWN", "RECONCILIATION_REQUIRED"]) {
      // Same quantity on both sides, so no late fill is in play and the only question is the state.
      const filled = terminal === "COMPLETE" ? QTY : 20;
      const m = merge(
        order({ state: terminal, filled_quantity: filled, execution_evidence: confirmed }),
        order({ state: working, filled_quantity: filled, execution_evidence: confirmed }),
        filled,
      );
      const reopened = !["COMPLETE", "CANCELLED", "REJECTED", "RECONCILIATION_REQUIRED"].includes(m.order.state);
      assert.ok(
        !reopened,
        `${terminal} was reopened as ${m.order.state} by a ${working} observation`,
      );
    }
  }
});
