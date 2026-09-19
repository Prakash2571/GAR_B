-- 014_box_settings_constraint_scope.sql
--
-- REPAIR AN EXISTENCE GUARD IN MIGRATION 013 THAT COULD SILENTLY SKIP A SAFETY CONSTRAINT.
--
-- WHAT WENT WRONG
--
-- Migration 013 adds `box_settings_exactly_one_value`, the CHECK that stops a settings row from
-- carrying both a numeric `value` and a JSON `value_json` (a row that disagrees with itself) or
-- neither (a row that means nothing, which resolves to a permissive default). `ALTER TABLE ... ADD
-- CONSTRAINT` has no `IF NOT EXISTS` form in PostgreSQL, so 013 guards it with a catalog lookup:
--
--     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'box_settings_exactly_one_value')
--
-- `pg_constraint` is CLUSTER-WIDE, and `conname` is only unique per table, not per database. So the
-- guard asks "does any object anywhere in this database carry that name?" when it meant to ask "does
-- MY table already have it?". Any other schema in the same database holding a constraint of that name
-- satisfies the guard, and the `ALTER TABLE` is skipped — leaving the table with no constraint and the
-- migration reporting success.
--
-- HOW IT WAS FOUND, WHICH IS THE ARGUMENT FOR FIXING IT RATHER THAN ONLY THE TESTS
--
-- `tests/pg/helpers.mjs` gives every test FILE its own schema and applies all migrations into it, so a
-- pg run has several schemas carrying these tables at once. `tests/pg/operatorConfigSettings.test.mjs`
-- asserts the constraint actually rejects a two-valued row, and it failed on `main` while having
-- passed on the branch — the outcome depended on which test file created the constraint first, i.e. it
-- was a race, and the "pass" was the lucky ordering.
--
-- The test harness is what EXPOSED it, but it is not a test-only problem. Any deployment that applies
-- these migrations into more than one schema of the same database — a staging schema alongside
-- production, a per-tenant layout, a restore into a scratch schema for comparison — gets a
-- `box_settings` table with no constraint, and nothing anywhere reports it. A safety constraint that is
-- silently absent is worse than one that fails loudly, because every later reader assumes it held.
--
-- WHY A NEW MIGRATION RATHER THAN A CORRECTION TO 013
--
-- The runner records a sha256 per applied file and REFUSES to run a file whose contents changed after
-- it was applied (src/pg/migrate.ts) — deliberately, so nobody can rewrite history that a live
-- database has already acted on. Editing 013 would break boot for any database that already ran it.
-- So 013 stays exactly as it is and this file repairs the outcome.
--
-- WHAT THIS DOES
--
-- Re-checks for the constraint scoped to THIS schema's `box_settings`, via
-- `conrelid = 'box_settings'::regclass` — `regclass` resolves through `search_path`, so it names the
-- table this migration is actually running against — and adds the constraint when it is genuinely
-- missing. Idempotent in both directions:
--
--   · 013 created the constraint correctly (the single-schema case): the scoped lookup finds it and
--     this is a no-op.
--   · 013 skipped it (the cross-schema case): this creates it.
--
-- The `ALTER TABLE` validates the constraint against existing rows, so a table that somehow already
-- holds a violating row will fail LOUDLY here rather than accept a constraint it does not satisfy.
-- That is the correct direction: such a row is a real data problem and must be seen.
--
-- Safe to run on a live database: the validation scan is over `box_settings`, which holds at most one
-- row per operator-configurable setting.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'box_settings_exactly_one_value'
       -- THE FIX: scoped to this schema's table, not to the whole cluster by name.
       AND conrelid = 'box_settings'::regclass
  ) THEN
    ALTER TABLE box_settings ADD CONSTRAINT box_settings_exactly_one_value
      CHECK ((value IS NULL) <> (value_json IS NULL));
  END IF;
END
$$;
