/**
 * MIGRATION HYGIENE for 013_operator_runtime_config.sql — static, no database required.
 *
 * WHAT THIS CAN AND CANNOT PROVE
 *
 * It CANNOT prove the SQL executes; that needs a live PostgreSQL and belongs in `tests/pg/`. What it
 * CAN prove are the properties that make the migration safe to apply to a running production database,
 * and every one of them has a specific failure it prevents:
 *
 *   · the file does not contain its own BEGIN/COMMIT — the runner wraps each file in a transaction
 *     (src/pg/migrate.ts:82-88) and a nested COMMIT would break that guarantee;
 *   · every statement is idempotent, because a migration that fails midway is rolled back and retried;
 *   · NOTHING backfills a settings row — a backfilled `0` would silently turn several finite risk
 *     ceilings into unlimited ones, which is the single worst outcome available to this refactor;
 *   · migration 003 is untouched, because the runner records a sha256 per applied file and refuses a
 *     file that changed after it was applied;
 *   · no credential name appears anywhere in the schema.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

import { registry, repoPath } from "./_harness.mjs";

register(pathToFileURL(repoPath("tests", "helpers", "tsResolve.mjs")).href);
const secrets = await import(pathToFileURL(repoPath("src", "env", "secrets.ts")).href);

const FILE = "013_operator_runtime_config.sql";
/** The follow-up that repairs 013's cluster-wide constraint-existence guard. */
const REPAIR = "014_box_settings_constraint_scope.sql";
const sql = readFileSync(repoPath("migrations", FILE), "utf8");

/** SQL with `--` comments stripped, so the file's own prose cannot satisfy or trip an assertion. */
const code = sql
  .split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/* ═════════════════ 1. Ordering and the immutability guard ═════════════════ */

test("migration numbers are unique and zero-padded, and 013 precedes its repair", () => {
  const files = readdirSync(repoPath("migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes(FILE), `${FILE} is missing`);
  assert.ok(files.includes(REPAIR), `${REPAIR} is missing`);
  // 014 repairs an existence guard in 013, so it must apply AFTER it.
  assert.ok(files.indexOf(REPAIR) > files.indexOf(FILE), "the repair does not sort after 013");

  const numbers = files.map((f) => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "two migrations share a number");
  // Lexical sort is load-bearing in the runner, so the zero padding must be intact.
  for (const n of numbers) assert.match(n, /^\d{3}$/);
});

test("EVERY migration scopes a pg_constraint lookup to its own table", () => {
  /*
   * THE CLASS OF BUG THIS CATCHES, generalised beyond the one instance.
   *
   * `ALTER TABLE ... ADD CONSTRAINT` has no `IF NOT EXISTS` form, so a migration that needs to be
   * re-runnable guards it with a catalog lookup. `pg_constraint` is CLUSTER-WIDE and `conname` is only
   * unique per table, so an unqualified `WHERE conname = '...'` asks "is anything anywhere called
   * this?" when it meant "does MY table have it?". Another schema in the same database then satisfies
   * the guard and the constraint is silently skipped — the migration reports success and the table has
   * no constraint.
   *
   * Migration 013 shipped with exactly that, and it was caught only because the pg harness gives every
   * test file its own schema. Any deployment applying these migrations into more than one schema would
   * hit it silently. So the requirement is pinned for every migration, not just the one that got it
   * wrong: a `pg_constraint` lookup must narrow by `conrelid` (or by `connamespace`/`relnamespace`).
   */
  /*
   * ONE EXEMPTION, and it is a frozen file rather than an accepted exception.
   *
   * 013 contains the original unscoped guard. It CANNOT be corrected: the runner records a sha256 per
   * applied file and refuses one whose contents changed after it was applied, so editing it would break
   * boot for any database that already ran it. 014 repairs the outcome instead, and the two tests
   * either side of this one prove 014 exists, sorts after 013, and adds the constraint correctly
   * scoped. Listing 013 by name keeps the rule live for every other migration — including every future
   * one — while recording exactly why this file is allowed to keep the defect.
   */
  const FROZEN_WITH_KNOWN_DEFECT = new Set([FILE]);

  let scanned = 0;
  for (const file of readdirSync(repoPath("migrations")).filter((f) => f.endsWith(".sql"))) {
    const body = readFileSync(repoPath("migrations", file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    if (!/pg_constraint/.test(body)) continue;
    scanned++;
    if (FROZEN_WITH_KNOWN_DEFECT.has(file)) continue;
    assert.match(
      body,
      /conrelid|connamespace|relnamespace/,
      `${file} looks up pg_constraint without scoping it to a table — another schema's constraint of the same name would silently satisfy the guard`,
    );
  }
  // The exemption must not be the only thing this test ever sees, or it guards nothing.
  assert.ok(scanned > FROZEN_WITH_KNOWN_DEFECT.size, "no non-exempt migration was actually scanned");
});

test("the repair migration adds the constraint scoped to its own schema", () => {
  const body = readFileSync(repoPath("migrations", REPAIR), "utf8");
  assert.match(body, /conrelid = 'box_settings'::regclass/);
  assert.match(body, /ADD CONSTRAINT box_settings_exactly_one_value/);
  // It must not try to rewrite 013's history.
  assert.equal(/DROP CONSTRAINT/i.test(body), false, "the repair drops a constraint instead of adding the missing one");
  // And it must not manage its own transaction, like every other migration.
  assert.equal(/^\s*(BEGIN|COMMIT)\s*;/im.test(body), false);
});

test("migration 003 still declares box_settings as it originally did", () => {
  // 013 EXTENDS box_settings; it must not have been achieved by editing 003, which the runner would
  // reject at boot with "was modified after it was applied".
  const original = readFileSync(repoPath("migrations", "003_box_pnl_settings_session.sql"), "utf8");
  assert.match(original, /CREATE TABLE IF NOT EXISTS box_settings \(/);
  assert.match(original, /key\s+text\s+PRIMARY KEY/i);
  assert.match(original, /value\s+numeric\s+NOT NULL/i);
  // The new columns belong to 013 alone.
  assert.equal(original.includes("value_json"), false, "003 was edited to add value_json");
  assert.equal(original.includes("updated_by"), false, "003 was edited to add updated_by");
});

/* ═════════════════ 2. Transaction and idempotency discipline ═════════════════ */

test("the migration does not manage its own transaction", () => {
  assert.equal(/^\s*BEGIN\s*;/im.test(code), false, "013 opens its own transaction");
  assert.equal(/^\s*COMMIT\s*;/im.test(code), false, "013 commits its own transaction");
  assert.equal(/^\s*ROLLBACK\s*;/im.test(code), false);
});

test("every CREATE is guarded so a rolled-back retry is safe", () => {
  for (const m of code.matchAll(/CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\s+(?!IF NOT EXISTS)/gi)) {
    assert.fail(`unguarded ${m[1]} — every CREATE needs IF NOT EXISTS: ${m[0]}`);
  }
  assert.ok(/CREATE TABLE IF NOT EXISTS box_config_version/i.test(code));
  assert.ok(/CREATE TABLE IF NOT EXISTS box_settings_audit/i.test(code));
});

test("every ADD COLUMN is guarded, and the added constraint is existence-checked", () => {
  for (const m of code.matchAll(/ADD\s+COLUMN\s+(?!IF NOT EXISTS)/gi)) {
    assert.fail(`unguarded ADD COLUMN: ${m[0]}`);
  }
  // ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL, so it needs the pg_constraint guard.
  if (/ADD CONSTRAINT/i.test(code)) {
    assert.match(code, /pg_constraint/, "ADD CONSTRAINT is not guarded against a retry");
  }
});

test("the seeded version row cannot be reset by a re-run", () => {
  // Resetting the version would make every client's cached version spuriously valid again.
  assert.match(code, /INSERT INTO box_config_version[\s\S]*?ON CONFLICT \(id\) DO NOTHING/i);
  assert.equal(/ON CONFLICT \(id\) DO UPDATE/i.test(code), false);
});

/* ═════════════════ 3. The migration-safety property: nothing is backfilled ═════════════════ */

test("no settings row is created by the migration", () => {
  // THE important assertion. A backfilled row would become an operator override nobody chose, and for
  // maxOpenBoxes / liveDailyLossLimit / liveMaxBoxCapitalRupees a backfilled 0 means UNLIMITED.
  assert.equal(
    /INSERT\s+INTO\s+box_settings\b/i.test(code),
    false,
    "the migration backfills box_settings — a missing row must mean 'fall through', not a stored value",
  );
  // The only INSERT permitted is the single version row.
  const inserts = [...code.matchAll(/INSERT\s+INTO\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual(inserts, ["box_config_version"]);
});

test("the migration does not delete or rewrite existing settings", () => {
  assert.equal(/DELETE\s+FROM\s+box_settings/i.test(code), false);
  assert.equal(/UPDATE\s+box_settings\s+SET/i.test(code), false);
  assert.equal(/DROP\s+TABLE/i.test(code), false);
  assert.equal(/DROP\s+COLUMN/i.test(code), false);
  // Existing rows must keep their values; only the NOT NULL is relaxed.
  assert.match(code, /ALTER COLUMN value DROP NOT NULL/i);
});

/* ═════════════════ 4. Shape the application depends on ═════════════════ */

test("box_settings can hold non-numeric values and records an actor", () => {
  assert.match(code, /ADD COLUMN IF NOT EXISTS value_json\s+JSONB/i);
  assert.match(code, /ADD COLUMN IF NOT EXISTS updated_by\s+TEXT/i);
});

test("a settings row must carry exactly one of value/value_json", () => {
  // Both set = a row that disagrees with itself; neither set = a row that means nothing, which
  // resolves to a permissive default.
  assert.match(code, /CHECK \(\(value IS NULL\) <> \(value_json IS NULL\)\)/i);
});

test("box_config_version is structurally single-row", () => {
  assert.match(code, /CHECK \(id IS TRUE\)/i);
  assert.match(code, /version\s+BIGINT\s+NOT NULL/i);
  assert.match(code, /CHECK \(version >= 0\)/i);
});

test("the audit table records configured AND effective values, before and after", () => {
  for (const column of [
    "previous_configured",
    "new_configured",
    "previous_effective",
    "new_effective",
    "mutation_policy",
    "new_source",
    "config_version",
  ]) {
    assert.ok(new RegExp(`\\b${column}\\b`).test(code), `box_settings_audit lacks ${column}`);
  }
  assert.match(code, /config_version\s+BIGINT\s+NOT NULL/i, "an audit row must name the version it produced");
});

test("the audit table is append-only in shape: no unique constraint a retry could violate", () => {
  const auditBlock = /CREATE TABLE IF NOT EXISTS box_settings_audit \(([\s\S]*?)\n\);/i.exec(code);
  assert.notEqual(auditBlock, null);
  assert.equal(/UNIQUE/i.test(auditBlock[1]), false, "a unique constraint would reject a repeated decision");
});

test("the audit table is indexed for the two questions actually asked of it", () => {
  assert.match(code, /CREATE INDEX IF NOT EXISTS box_settings_audit_changed_at_idx/i);
  assert.match(code, /CREATE INDEX IF NOT EXISTS box_settings_audit_key_changed_at_idx/i);
});

/* ═════════════════ 5. No credential reaches the schema ═════════════════ */

test("no credential name appears anywhere in the migration", () => {
  for (const name of secrets.registeredSecretNames()) {
    assert.equal(sql.includes(name), false, `013 mentions the secret ${name}`);
  }
});

test("the audit actor is a role, never a token", () => {
  assert.match(code, /actor_role\s+TEXT/i);
  for (const forbidden of ["passcode", "token", "secret", "api_key", "session_cookie"]) {
    // `session_id` is legitimate; a token column is not.
    const columnLike = new RegExp(`\\b\\w*${forbidden}\\w*\\s+(TEXT|JSONB|BYTEA)`, "i");
    assert.equal(columnLike.test(code), false, `013 declares a ${forbidden}-like column`);
  }
});

/* ═════════════════ 6. Persisted key agreement with the application ═════════════════ */

test("every registered setting produces a key the schema can store", () => {
  // `key text PRIMARY KEY` is unbounded text, so the real risk is a key the app cannot round-trip.
  for (const s of registry.OPERATOR_SETTINGS) {
    const k = registry.persistedKeyFor(s.key);
    assert.match(k, /^[a-z][a-z0-9_]*$/, `${s.key} produces an unstorable persisted key "${k}"`);
    assert.ok(k.length <= 63, `${k} exceeds a comfortable identifier length`);
  }
});
