/**
 * AN EMERGENCY FLATTEN MUST NOT REPORT SUCCESS IT DID NOT ACHIEVE.
 *
 * THE DEFECT
 *
 * `POST /api/box/live/flatten` answered `{ ok: true, ... }` as a LITERAL, always with HTTP 200, over a
 * `results: unknown[]` filled with `ManualCloseResult` objects that are frequently `{ ok: false }`:
 * exchange closed (409), feed unhealthy (409), position in RECOVERY (409), position already closing
 * (409), PostgreSQL down. The frontend inspected only `settlement.failures` and
 * `settlement.reconciled` — the CANCELLATION and RECONCILIATION halves — and never read `results`.
 *
 * So an operator who pressed the panic button while the feed was down got a GREEN success toast while
 * every position failed to close, provided the cancel sweep and the reconcile happened to come back
 * clean. The first test below is exactly that scenario.
 *
 * THE RULE THESE TESTS ENFORCE
 *
 * Unknown exposure must never become zero exposure. `remaining_quantity: null` means NOT KNOWN and is
 * not interchangeable with 0. A successful HTTP response, an accepted order and a cancellation
 * acknowledgement are each evidence that something was REQUESTED — none is evidence of flatness.
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  buildAttributedFlattenResult,
  classifyPositionClose,
  classifyResidualFlatten,
  flattenHttpStatus,
} = await import("../../dist/box/flattenOutcome.js");

const cleanSettlement = { cancelled: 2, failures: [], blocked: null, reconciled: true };

/* ════════════════════ 1. THE DEFECT SCENARIO ════════════════════ */

test("a clean settlement with every position refused is NOT ok, NOT 200, and names every reason", () => {
  // Precisely the reported case: the sweep and the reconcile succeeded; the closes did not.
  const items = [
    classifyPositionClose({
      id: "pos-1",
      label: "NIFTY 2026-09-24 25000/25200",
      result: {
        ok: false,
        code: 409,
        error: "Cannot close while the live WebSocket feed is unavailable. The position is still monitored.",
        remaining_qty_by_role: { k1_ce: 75, k2_ce: 75, k2_pe: 75, k1_pe: 75 },
      },
    }),
    classifyPositionClose({
      id: "pos-2",
      label: "BANKNIFTY 2026-09-24 54000/54200",
      result: {
        ok: false,
        code: 409,
        error: "Cannot manually close a RECOVERY position through ordinary execution.",
      },
    }),
  ];
  const result = buildAttributedFlattenResult({
    requested: 2, attempted: 2, items, settlement: cleanSettlement,
  });

  assert.equal(result.ok, false, "a flatten that reduced nothing must not report ok");
  assert.equal(
    flattenHttpStatus(result), 409,
    "nothing reduced with known reasons is a CONFLICT, not a 200",
  );
  assert.equal(result.outcome, "not_reduced");
  assert.equal(result.requested, 2);
  assert.equal(result.attempted, 2);

  // Every per-position reason must be surfaced — this is what the UI never saw.
  assert.ok(
    result.blockers.some((b) => /pos-1/.test(b) && /WebSocket feed is unavailable/.test(b)),
    `the feed refusal must be a blocker: ${JSON.stringify(result.blockers)}`,
  );
  assert.ok(
    result.blockers.some((b) => /pos-2/.test(b) && /RECOVERY/.test(b)),
    `the RECOVERY refusal must be a blocker: ${JSON.stringify(result.blockers)}`,
  );

  // pos-2 reported no per-role map, so the TOTAL is unknowable and must not be faked.
  assert.equal(result.remaining_exposure_known, false);
  assert.equal(
    result.remaining_quantity, null,
    "one item with an unknown quantity makes the total unknown — never 0",
  );
  assert.match(result.next_action, /EXPOSURE REMAINS|UNRESOLVED/);
  assert.doesNotMatch(result.next_action, /^No attributed Box exposure remains/);
});

/* ════════════════════ 2. positive evidence is required for ok ════════════════════ */

test("every position flat on fill evidence with clean settlement is ok and 200", () => {
  const items = [
    classifyPositionClose({ id: "pos-1", label: "NIFTY", result: { ok: true } }),
    classifyPositionClose({ id: "pos-2", label: "BANKNIFTY", result: { ok: true } }),
  ];
  const result = buildAttributedFlattenResult({
    requested: 2, attempted: 2, items, settlement: cleanSettlement,
  });
  assert.equal(result.ok, true);
  assert.equal(flattenHttpStatus(result), 200);
  assert.equal(result.outcome, "flat_on_fill_evidence");
  assert.equal(result.remaining_quantity, 0);
  assert.equal(result.remaining_exposure_known, true);
  assert.deepEqual(result.blockers, []);
  // Even the success message must not overclaim: this is fill evidence, not a broker position re-read.
  assert.match(
    result.next_action,
    /not an independent broker position re-read/,
    "success must not be presented as broker-confirmed flatness",
  );
});

test("an unreconciled settlement withholds ok even when every position reported flat", () => {
  const items = [classifyPositionClose({ id: "pos-1", label: "NIFTY", result: { ok: true } })];
  const result = buildAttributedFlattenResult({
    requested: 1,
    attempted: 1,
    items,
    settlement: { cancelled: 0, failures: [], blocked: null, reconciled: false },
  });
  assert.equal(
    result.ok, false,
    "an unreconciled snapshot is exactly the state in which a still-working order can fill after the " +
      "flatten 'succeeded'",
  );
  assert.equal(flattenHttpStatus(result), 207);
  assert.ok(result.blockers.some((b) => /reconcile did not complete/.test(b)));
});

test("a refused cancellation sweep withholds ok and is reported as a blocker", () => {
  const items = [classifyPositionClose({ id: "pos-1", label: "NIFTY", result: { ok: true } })];
  const result = buildAttributedFlattenResult({
    requested: 1,
    attempted: 1,
    items,
    settlement: {
      cancelled: 0,
      failures: [],
      blocked:
        "The durable order-intent journal could not be read, so the working orders to cancel cannot " +
        "be identified and NOTHING was attempted.",
      reconciled: true,
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.blockers.some((b) => /cancellation sweep was REFUSED and nothing was cancelled/.test(b)),
    `the refusal must be surfaced: ${JSON.stringify(result.blockers)}`,
  );
});

/* ════════════════════ 3. unresolved dominates everything ════════════════════ */

test("a thrown close is unresolved with UNKNOWN remaining, never 'not reduced'", () => {
  const item = classifyPositionClose({
    id: "pos-1", label: "NIFTY", result: null, thrown: "socket hang up",
  });
  assert.equal(item.disposition, "unresolved");
  assert.equal(
    item.remaining_quantity, null,
    "a throw establishes nothing about whether orders reached the broker",
  );
  assert.match(item.reason, /may already\s+have reached the broker/);
  assert.match(item.reason, /broker terminal/);
});

test("one unresolved item makes the whole flatten unresolved, 207, and not ok", () => {
  const items = [
    classifyPositionClose({ id: "pos-1", label: "NIFTY", result: { ok: true } }),
    classifyPositionClose({ id: "pos-2", label: "BANKNIFTY", result: null, thrown: "ETIMEDOUT" }),
  ];
  const result = buildAttributedFlattenResult({
    requested: 2, attempted: 2, items, settlement: cleanSettlement,
  });
  assert.equal(result.outcome, "unresolved");
  assert.equal(result.ok, false);
  assert.equal(flattenHttpStatus(result), 207);
  assert.equal(result.remaining_quantity, null);
  assert.match(result.next_action, /EXPOSURE IS UNRESOLVED/);
  assert.match(
    result.next_action, /Do NOT re-arm/,
    "an unresolved flatten must tell the operator not to re-arm",
  );
  assert.match(
    result.next_action, /pressing flatten again cannot establish what is already outstanding/,
    "it must warn against blind retry, which is how a double-close happens",
  );
});

test("a close that returned no result at all is unresolved, not silently dropped", () => {
  const item = classifyPositionClose({ id: "pos-1", label: null, result: null });
  assert.equal(item.disposition, "unresolved");
  assert.equal(item.remaining_quantity, null);
});

/* ════════════════════ 4. partial reduction is its own state ════════════════════ */

test("a partially closed position reports partially_reduced with the remaining per-role map", () => {
  const item = classifyPositionClose({
    id: "pos-1",
    label: "NIFTY",
    result: {
      ok: false,
      partial: true,
      code: 409,
      error: "Position partially closed; remaining exposure is still being managed.",
      remaining_qty_by_role: { k1_ce: 0, k2_ce: 75, k2_pe: 75, k1_pe: 0 },
    },
  });
  assert.equal(item.disposition, "partially_reduced");
  assert.equal(item.remaining_quantity, 150);
  assert.deepEqual(item.remaining_by_role, { k1_ce: 0, k2_ce: 75, k2_pe: 75, k1_pe: 0 });

  const result = buildAttributedFlattenResult({
    requested: 1, attempted: 1, items: [item], settlement: cleanSettlement,
  });
  assert.equal(result.outcome, "partially_reduced");
  assert.equal(result.ok, false);
  assert.equal(flattenHttpStatus(result), 207);
  assert.equal(result.remaining_quantity, 150, "a known partial total must be reported as a number");
  assert.equal(result.remaining_exposure_known, true);
});

/* ════════════════════ 5. residual classification ════════════════════ */

test("a residual reduced to nothing is flat; one reduced in part is partial; one untouched is not reduced", () => {
  const flat = classifyResidualFlatten({
    id: "rec-1", label: "SYM", requestedQuantity: 150, result: { remaining: [] },
  });
  assert.equal(flat.disposition, "flat_on_fill_evidence");
  assert.equal(flat.remaining_quantity, 0);

  const partial = classifyResidualFlatten({
    id: "rec-2",
    label: "SYM",
    requestedQuantity: 150,
    result: { remaining: [{ role: "k1_ce", quantity: 75 }] },
  });
  assert.equal(partial.disposition, "partially_reduced");
  assert.equal(partial.remaining_quantity, 75);

  const untouched = classifyResidualFlatten({
    id: "rec-3",
    label: "SYM",
    requestedQuantity: 150,
    result: { remaining: [{ role: "k1_ce", quantity: 75 }, { role: "k2_ce", quantity: 75 }] },
  });
  assert.equal(untouched.disposition, "not_reduced");
  assert.equal(untouched.remaining_quantity, 150);
  assert.match(untouched.reason, /watchdog keeps retrying/);
});

test("a residual pass that did not report what remains is unresolved", () => {
  const noReport = classifyResidualFlatten({
    id: "rec-1", label: "SYM", requestedQuantity: 150, result: {},
  });
  assert.equal(noReport.disposition, "unresolved");
  assert.equal(noReport.remaining_quantity, null);

  const nonsense = classifyResidualFlatten({
    id: "rec-2",
    label: "SYM",
    requestedQuantity: 150,
    result: { remaining: [{ role: "k1_ce", quantity: Number.NaN }] },
  });
  assert.equal(nonsense.disposition, "unresolved");
  assert.equal(
    nonsense.remaining_quantity, null,
    "an unusable quantity must not be coerced to a number",
  );
});

/* ════════════════════ 6. requested vs attempted ════════════════════ */

test("an item that was never attempted is reported as such", () => {
  const items = [classifyPositionClose({ id: "pos-1", label: "NIFTY", result: { ok: true } })];
  const result = buildAttributedFlattenResult({
    requested: 3, attempted: 1, items, settlement: cleanSettlement,
  });
  assert.ok(
    result.blockers.some((b) => /2 item\(s\) were never attempted/.test(b)),
    `unattempted items must be visible: ${JSON.stringify(result.blockers)}`,
  );
  assert.equal(result.ok, false, "a flatten that skipped items cannot be ok");
});

test("nothing to flatten with clean settlement is ok, and says so without claiming work was done", () => {
  const result = buildAttributedFlattenResult({
    requested: 0, attempted: 0, items: [], settlement: cleanSettlement,
  });
  assert.equal(result.outcome, "nothing_to_flatten");
  assert.equal(result.ok, true);
  assert.equal(flattenHttpStatus(result), 200);
  assert.equal(result.remaining_quantity, 0);
});

test("nothing to flatten with a DIRTY settlement is not ok", () => {
  const result = buildAttributedFlattenResult({
    requested: 0,
    attempted: 0,
    items: [],
    settlement: { cancelled: 0, failures: ["cancel failed for BOX:x"], blocked: null, reconciled: true },
  });
  assert.equal(
    result.ok, false,
    "no attributed positions does not mean no working orders — a failed sweep still matters",
  );
  assert.ok(result.blockers.some((b) => /cancel failed for BOX:x/.test(b)));
});

/* ════════════════════ 7. shape guarantees the wire depends on ════════════════════ */

test("blockers are deduplicated and the legacy results alias mirrors items", () => {
  const dup = {
    ok: false, code: 409, error: "Cannot close while the exchange is closed. The position is still monitored.",
    remaining_qty_by_role: { k1_ce: 75, k2_ce: 75, k2_pe: 75, k1_pe: 75 },
  };
  const items = [
    classifyPositionClose({ id: "pos-1", label: "A", result: dup }),
    classifyPositionClose({ id: "pos-2", label: "B", result: dup }),
  ];
  const result = buildAttributedFlattenResult({
    requested: 2,
    attempted: 2,
    items,
    settlement: { cancelled: 0, failures: ["same", "same"], blocked: null, reconciled: true },
  });
  assert.equal(
    result.blockers.filter((b) => b === "settlement: same").length, 1,
    "identical settlement failures must appear once",
  );
  // Per-item blockers are keyed by id, so two positions with the SAME reason stay distinct.
  assert.equal(result.blockers.filter((b) => /exchange is closed/.test(b)).length, 2);
  assert.deepEqual(
    result.results, result.items,
    "the legacy `results` alias must mirror `items` so an older client still sees the array",
  );
  assert.equal(result.remaining_quantity, 600);
});
