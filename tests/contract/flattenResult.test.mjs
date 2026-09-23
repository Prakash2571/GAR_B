/**
 * CONTRACT — the emergency-flatten response shape.
 *
 * [SERDE] The real production builder `buildAttributedFlattenResult()` (src/box/flattenOutcome.ts) is
 * called with items produced by the real classifiers, and its output is JSON round-tripped to get
 * exactly the bytes `POST /api/box/live/flatten` emits. The route body is
 * `{ ...result, status: engine.getStatus() }`, so the only thing added on the wire is the engine's
 * status blob, which the schema declares OPEN and `box-status.schema.json` validates in full.
 *
 * Driving the route itself would need a live BoxEngine — Mongo, PostgreSQL and a market feed — which is
 * why the serializer is validated directly, exactly as the other engine-owned shapes in this suite are.
 *
 * WHY THIS SCHEMA EXISTS AT ALL. There was none. The route answered a hardcoded `ok: true` with HTTP
 * 200 over a `results: unknown[]`, so nothing validated or closed the response and per-position
 * failures had no place to be reported.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { check, wire } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");

const assertValid = (errs, name) =>
  assert.deepEqual(errs, [], `${name} must satisfy its schema; errors: ${JSON.stringify(errs)}`);

const load = () => import(resolve(DIST, "box", "flattenOutcome.js"));

/**
 * The builder produces the exposure outcome; the ENGINE adds the operation identity
 * (`BoxEngine.flattenAttributedBoxExposure` wraps the builder in
 * `exposureOperations.run("flatten", ...)`) and the ROUTE adds `status`. Compose them the same way so
 * these fixtures are the shape that actually reaches a client, not a subset of it.
 */
const onWire = (result, overrides = {}) => wire({
  ...result,
  operation_id: "flatten:11111111-2222-3333-4444-555555555555",
  deduplicated: false,
  ...overrides,
});

test("[SERDE] every flatten outcome shape satisfies box-flatten-result.schema.json", async () => {
  const {
    buildAttributedFlattenResult, classifyPositionClose, classifyResidualFlatten, flattenHttpStatus,
  } = await load();

  const clean = { cancelled: 2, failures: [], blocked: null, reconciled: true };

  /* 1. the reported defect: clean settlement, every position refused. */
  const refused = onWire(buildAttributedFlattenResult({
    requested: 2,
    attempted: 2,
    settlement: clean,
    items: [
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
        result: { ok: false, code: 409, error: "Cannot manually close a RECOVERY position." },
      }),
    ],
  }));
  assertValid(await check(refused, "box-flatten-result.schema.json"), "flatten refused");
  assert.equal(refused.ok, false);
  assert.equal(flattenHttpStatus(refused), 409);
  assert.equal(
    refused.remaining_quantity, null,
    "the wire must carry null, not 0, when a quantity is unknown — JSON has a null, so use it",
  );

  /* 2. full success. */
  const flat = onWire(buildAttributedFlattenResult({
    requested: 1,
    attempted: 1,
    settlement: clean,
    items: [classifyPositionClose({ id: "pos-1", label: "NIFTY", result: { ok: true } })],
  }));
  assertValid(await check(flat, "box-flatten-result.schema.json"), "flatten flat");
  assert.equal(flattenHttpStatus(flat), 200);

  /* 3. unresolved after a throw, plus a partially reduced residual. */
  const mixed = onWire(buildAttributedFlattenResult({
    requested: 2,
    attempted: 2,
    settlement: { cancelled: 0, failures: ["cancel failed for BOX:x"], blocked: null, reconciled: false },
    items: [
      classifyPositionClose({ id: "pos-1", label: "NIFTY", result: null, thrown: "socket hang up" }),
      classifyResidualFlatten({
        id: "rec-1",
        label: "NIFTY26SEP25000CE",
        requestedQuantity: 150,
        result: { remaining: [{ role: "k1_ce", quantity: 75 }] },
      }),
    ],
  }));
  assertValid(await check(mixed, "box-flatten-result.schema.json"), "flatten mixed");
  assert.equal(flattenHttpStatus(mixed), 207);

  /* 4. nothing attributed. */
  const empty = onWire(buildAttributedFlattenResult({
    requested: 0, attempted: 0, settlement: clean, items: [],
  }));
  assertValid(await check(empty, "box-flatten-result.schema.json"), "flatten empty");

  /* 5. with the status blob the route actually appends. */
  const withStatus = wire({ ...flat, status: { execution_mode: "live", anything: { nested: true } } });
  assertValid(await check(withStatus, "box-flatten-result.schema.json"), "flatten + status");

  /* 6. a DEDUPLICATED response: a retry that joined the operation already running. */
  const joined = onWire(buildAttributedFlattenResult({
    requested: 1,
    attempted: 1,
    settlement: clean,
    items: [classifyPositionClose({ id: "pos-1", label: "NIFTY", result: { ok: true } })],
  }), { deduplicated: true });
  assertValid(await check(joined, "box-flatten-result.schema.json"), "flatten deduplicated");
  assert.equal(
    joined.ok, true,
    "a joiner receives the REAL result of the operation it joined, not a fabricated refusal",
  );
});

test("[SERDE] each flatten item satisfies box-flatten-item.schema.json", async () => {
  const { classifyPositionClose, classifyResidualFlatten } = await load();
  const items = [
    classifyPositionClose({ id: "p", label: "NIFTY", result: { ok: true } }),
    classifyPositionClose({
      id: "p2", label: null,
      result: {
        ok: false, partial: true, code: 409, error: "partial",
        remaining_qty_by_role: { k1_ce: 0, k2_ce: 75, k2_pe: 75, k1_pe: 0 },
      },
    }),
    classifyPositionClose({ id: "p3", label: "X", result: null, thrown: "boom" }),
    classifyResidualFlatten({ id: "r", label: "SYM", requestedQuantity: 75, result: { remaining: [] } }),
    classifyResidualFlatten({ id: "r2", label: "SYM", requestedQuantity: 75, result: {} }),
  ];
  for (const item of items) {
    assertValid(await check(wire(item), "box-flatten-item.schema.json"), `item ${item.id}`);
  }
});

test("the schema is CLOSED, so an added field is caught", async () => {
  const { buildAttributedFlattenResult } = await load();
  const base = onWire(buildAttributedFlattenResult({
    requested: 0, attempted: 0, items: [],
    settlement: { cancelled: 0, failures: [], blocked: null, reconciled: true },
  }));
  const errs = await check({ ...base, surprise: 1 }, "box-flatten-result.schema.json");
  assert.ok(
    errs.length > 0,
    "NON-VACUITY: an unexpected top-level field must fail, or this schema proves nothing",
  );
});

test("the schema REJECTS a hardcoded-success shape that omits the derived fields", async () => {
  // The pre-fix body, verbatim. It must not validate, which is what stops a regression to it.
  const old = { ok: true, attempted: 2, results: [{ ok: false, error: "nope", code: 409 }], settlement: {
    cancelled: 0, failures: [], blocked: null, reconciled: true,
  } };
  const errs = await check(old, "box-flatten-result.schema.json");
  assert.ok(
    errs.length > 0,
    "the old hardcoded-ok body must NOT satisfy the new schema; otherwise nothing prevents a revert",
  );
  assert.ok(
    errs.some((e) => /requested|outcome|blockers|next_action|remaining/.test(`${e.path} ${e.message}`)),
    `the failure must be about the missing derived fields: ${JSON.stringify(errs)}`,
  );
});
