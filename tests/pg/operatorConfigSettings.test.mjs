/**
 * MIGRATION 013 AND THE LEGACY `box_settings` PATH, against a real PostgreSQL.
 *
 * WHY THIS FILE EXISTS
 *
 * `tests/operatorConfig/migration.test.mjs` is a STATIC hygiene check: it proves the migration is
 * idempotent, backfills nothing and manages no transaction of its own. What it cannot prove is that
 * the SQL executes, that the constraints actually reject what they claim to, or that the EXISTING
 * reader and writer still behave correctly now that `box_settings.value` is nullable. Those are facts
 * about a database, so they belong here.
 *
 * THE TWO DEFECTS THIS PINS, both found by review rather than by a failing test:
 *
 *   1. `loadBoxSettings` coerced with `num(v)`, and `num(null)` is `Number(null)` which is `0`, not
 *      `NaN`. So once a JSON-valued setting row existed, the legacy numeric map reported it as the
 *      number ZERO — and for a ceiling, zero means UNLIMITED. The fix filters `value IS NOT NULL` in
 *      SQL.
 *
 *   2. `saveBoxSettings` upserted `SET value = $2` without clearing `value_json`. Migration 013 adds a
 *      CHECK requiring exactly one of the two columns, so writing a numeric value over a key that
 *      already held a JSON value left both non-NULL and failed the whole transaction. The fix sets
 *      `value_json = NULL` on both the insert and the conflict path.
 *
 * Neither was reachable at the time — the only keys the legacy path writes are the two numeric tuning
 * thresholds — but both fire precisely when the operator-config wiring starts writing JSON-valued
 * settings, which is the worst possible moment to discover them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, loadRepository } from "./helpers.mjs";

let ctx;
let repo;

test.before(async () => {
  ctx = await setup("opcfg");
  repo = await loadRepository();
});

test.after(async () => {
  await teardown(ctx);
});

/** Run raw SQL on the test schema through the initialised pool. */
const sql = (text, params = []) => ctx.pool.query(text, params);

/* ═════════════════ 1. The migration applied and produced the declared shape ═════════════════ */

test("box_settings carries the generalised columns", async () => {
  const { rows } = await sql(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'box_settings'
      ORDER BY column_name`,
    [ctx.schema],
  );
  const byName = new Map(rows.map((r) => [r.column_name, r]));

  assert.ok(byName.has("value_json"), "value_json was not added");
  assert.equal(byName.get("value_json").data_type, "jsonb");
  assert.ok(byName.has("updated_by"), "updated_by was not added");

  // `value` must now be nullable — a boolean or enum setting has no numeric value to store.
  assert.equal(byName.get("value").is_nullable, "YES", "value is still NOT NULL");
});

test("box_config_version exists, is seeded once, and is structurally single-row", async () => {
  const { rows } = await sql(`SELECT id, version FROM box_config_version`);
  assert.equal(rows.length, 1, "the version row was not seeded exactly once");
  assert.equal(rows[0].id, true);
  assert.equal(Number(rows[0].version), 0);

  // The CHECK pins id to TRUE, so a second row is impossible: a configuration with two version
  // numbers has no version number.
  await assert.rejects(
    () => sql(`INSERT INTO box_config_version (id, version) VALUES (false, 1)`),
    /box_config_version_single_row|check constraint/i,
  );
  await assert.rejects(
    () => sql(`UPDATE box_config_version SET version = -1`),
    /box_config_version_non_negative|check constraint/i,
  );
});

test("box_settings_audit exists with both before/after value pairs", async () => {
  const { rows } = await sql(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'box_settings_audit'`,
    [ctx.schema],
  );
  const cols = new Set(rows.map((r) => r.column_name));
  for (const c of [
    "changed_at",
    "actor_role",
    "setting_key",
    "previous_configured",
    "new_configured",
    "previous_effective",
    "new_effective",
    "mutation_policy",
    "new_source",
    "session_id",
    "reason",
    "config_version",
  ]) {
    assert.ok(cols.has(c), `box_settings_audit lacks ${c}`);
  }
});

test("the audit indexes the two questions actually asked of it", async () => {
  const { rows } = await sql(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'box_settings_audit'`,
    [ctx.schema],
  );
  const names = rows.map((r) => r.indexname);
  assert.ok(names.includes("box_settings_audit_changed_at_idx"), `missing newest-first index: ${names}`);
  assert.ok(names.includes("box_settings_audit_key_changed_at_idx"), `missing per-key index: ${names}`);
});

/* ═════════════════ 2. The constraints reject what they claim to ═════════════════ */

test("the exactly-one-value constraint exists on THIS schema's table", async () => {
  /*
   * Asserted directly against the catalog, scoped by `conrelid`, BEFORE the behavioural test below.
   *
   * This is the regression guard for the defect migration 014 repairs. Migration 013 guarded its
   * `ALTER TABLE ... ADD CONSTRAINT` with `SELECT 1 FROM pg_constraint WHERE conname = ...`, and
   * `pg_constraint` is cluster-wide — so another test file's schema (this harness gives every file its
   * own) satisfied the guard and the constraint was silently skipped here. The behavioural test then
   * failed on `main` having passed on the branch, because the outcome depended on which file ran first.
   *
   * Checking the catalog by `conrelid` says "MY table has it" rather than "something somewhere is
   * called that", and it fails with a clear cause instead of as a missing rejection.
   */
  const { rows } = await sql(
    `SELECT conname FROM pg_constraint
      WHERE conname = 'box_settings_exactly_one_value'
        AND conrelid = 'box_settings'::regclass`,
  );
  assert.equal(
    rows.length,
    1,
    "box_settings_exactly_one_value is missing from this schema — the migration's existence guard matched another schema's constraint",
  );
});

test("a settings row must carry EXACTLY ONE of value / value_json", async () => {
  // Both set — a row that disagrees with itself.
  await assert.rejects(
    () => sql(`INSERT INTO box_settings (key, value, value_json) VALUES ('both', 5, '7'::jsonb)`),
    /box_settings_exactly_one_value|check constraint/i,
  );
  // Neither set — a row that means nothing, which would resolve to a permissive default.
  await assert.rejects(
    () => sql(`INSERT INTO box_settings (key, value, value_json) VALUES ('neither', NULL, NULL)`),
    /box_settings_exactly_one_value|check constraint/i,
  );
  // Each alone is accepted.
  await sql(`INSERT INTO box_settings (key, value) VALUES ('numeric_only', 1200)`);
  await sql(`INSERT INTO box_settings (key, value_json) VALUES ('json_only', 'true'::jsonb)`);
  const { rows } = await sql(`SELECT count(*)::int AS n FROM box_settings WHERE key LIKE '%_only'`);
  assert.equal(rows[0].n, 2);
});

test("an existing numeric row from migration 003 still satisfies the new constraint", async () => {
  // The upgrade path: rows written before 013 have value NOT NULL and value_json NULL.
  await sql(`INSERT INTO box_settings (key, value) VALUES ('min_expected_net_profit', 1200)`);
  const { rows } = await sql(
    `SELECT value::text AS v, value_json FROM box_settings WHERE key = 'min_expected_net_profit'`,
  );
  assert.equal(Number(rows[0].v), 1200);
  assert.equal(rows[0].value_json, null);
});

/* ═════════════════ 3. DEFECT 1 — the legacy reader must not report a JSON row as 0 ═════════════════ */

test("loadBoxSettings ignores JSON-valued rows instead of reading them as zero", async () => {
  await sql(`DELETE FROM box_settings`);
  await sql(`INSERT INTO box_settings (key, value) VALUES ('safety_buffer', 150)`);
  // A boolean setting, as the operator-config subsystem will store it.
  await sql(
    `INSERT INTO box_settings (key, value_json) VALUES ('one_active_box_per_underlying', 'true'::jsonb)`,
  );
  await sql(`INSERT INTO box_settings (key, value_json) VALUES ('paper_execution_profile', '"standard"'::jsonb)`);

  const loaded = await repo.loadBoxSettings();

  assert.equal(loaded.get("safety_buffer"), 150, "the numeric row was lost");
  // THE DEFECT: num(null) is 0, and Number.isFinite(0) is true, so these used to arrive as 0 — which
  // for a ceiling means UNLIMITED.
  assert.equal(
    loaded.has("one_active_box_per_underlying"),
    false,
    "a JSON-valued row was reported as a number (it would have been 0)",
  );
  assert.equal(loaded.has("paper_execution_profile"), false);
  assert.equal(loaded.size, 1, `expected only the numeric row, got ${[...loaded.keys()]}`);
});

/* ═════════════════ 4. DEFECT 2 — the legacy writer must not violate the new constraint ═════════════════ */

test("saveBoxSettings can overwrite a JSON-valued key without violating the constraint", async () => {
  await sql(`DELETE FROM box_settings`);
  // A key that currently holds a JSON value.
  await sql(`INSERT INTO box_settings (key, value_json) VALUES ('min_expected_net_profit', '1500'::jsonb)`);

  // THE DEFECT: the old upsert set `value` and left `value_json` in place, leaving both non-NULL and
  // failing the whole transaction on the CHECK.
  await repo.saveBoxSettings(new Map([["min_expected_net_profit", 1300]]));

  const { rows } = await sql(
    `SELECT value::text AS v, value_json FROM box_settings WHERE key = 'min_expected_net_profit'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].v), 1300, "the numeric value was not written");
  assert.equal(rows[0].value_json, null, "value_json was not cleared, so the row disagrees with itself");
});

test("saveBoxSettings still round-trips through loadBoxSettings", async () => {
  await sql(`DELETE FROM box_settings`);
  await repo.saveBoxSettings(
    new Map([
      ["min_expected_net_profit", 1400],
      ["safety_buffer", 250],
    ]),
  );
  const loaded = await repo.loadBoxSettings();
  assert.equal(loaded.get("min_expected_net_profit"), 1400);
  assert.equal(loaded.get("safety_buffer"), 250);
  assert.equal(loaded.size, 2);
});

test("a fresh insert from the legacy writer leaves value_json NULL", async () => {
  await sql(`DELETE FROM box_settings`);
  await repo.saveBoxSettings(new Map([["safety_buffer", 300]]));
  const { rows } = await sql(`SELECT value_json FROM box_settings WHERE key = 'safety_buffer'`);
  assert.equal(rows[0].value_json, null);
});

/* ═════════════════ 5. Missing means missing — never zero ═════════════════ */

test("an empty settings table yields an empty map, not a map of zeros", async () => {
  await sql(`DELETE FROM box_settings`);
  const loaded = await repo.loadBoxSettings();
  assert.equal(loaded.size, 0);
  // The property the whole precedence model rests on: absence must fall through to env/default, and
  // a caller asking for a key that was never persisted gets `undefined`, never 0.
  assert.equal(loaded.get("min_expected_net_profit"), undefined);
});
