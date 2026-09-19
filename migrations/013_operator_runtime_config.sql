-- 013_operator_runtime_config.sql
--
-- GENERALISE `box_settings` INTO THE DURABLE HOME FOR OPERATOR RUNTIME CONFIGURATION,
-- AND GIVE CONFIGURATION CHANGES A VERSION AND AN AUDIT TRAIL.
--
-- WHY THIS EXISTS
--
-- `.env.example` declares 213 variables and every one of them is genuinely read. 135 are
-- `BOX_*`/`MIN_BOX_*` strategy and risk knobs. A minority of those are real OPERATOR POLICY — the
-- entry threshold, the capital cap, the inventory ceiling, the coherence bounds — and changing one
-- currently means editing a server `.env` and restarting the process. That is error-prone in exactly
-- the moment it matters most. See docs/OPERATOR_CONFIG_AUDIT.md for the per-setting classification.
--
-- WHY EXTEND `box_settings` RATHER THAN CREATE A SECOND STORE
--
-- `box_settings` (migration 003) already IS this mechanism, in miniature: two admin-set thresholds
-- (`min_expected_net_profit`, `safety_buffer`) persisted so they survive a restart. Introducing a
-- parallel table would leave two places that answer "what is the entry gate?", and the existing rows
-- would have to be migrated or shadowed. Extending it keeps ONE answer and keeps the existing rows
-- working untouched.
--
-- Migration 003 cannot be edited: the runner (src/pg/migrate.ts) records a sha256 per applied file and
-- REFUSES a file that changed after it was applied. Hence a new migration with additive DDL.
--
-- THE THREE THINGS 003 CANNOT DO
--
--   1. `value numeric NOT NULL` cannot hold a boolean, an enum or a string. Migration 012 hit exactly
--      this wall and wrote its own table rather than reuse this one. Adding `value_json jsonb` fixes
--      it for every future setting without disturbing the two numeric rows already present.
--   2. There is no actor column, so a persisted risk change records WHAT but never WHO.
--   3. There is no version, so two operators (or two browser tabs) can overwrite each other silently.
--
-- WHY `value` BECOMES NULLABLE
--
-- A boolean or enum setting has no numeric value to put in `value`. Dropping NOT NULL is the smallest
-- change that admits them. The CHECK constraint below then enforces the real rule: a row must carry
-- EXACTLY ONE of the two value columns, so "which column is authoritative?" is never a question a
-- reader has to answer by inspection. Existing numeric rows satisfy it unchanged.
--
-- WHY A SINGLE-ROW VERSION TABLE RATHER THAN A SEQUENCE
--
-- The version is the optimistic-concurrency token for the configuration AS A WHOLE, not per setting: a
-- PATCH says "I am editing version 17" and is refused if anything has moved since. A sequence would
-- hand out a number per call including rejected ones, so a client could never predict the next value
-- and a gap would look like a lost update. One row, read and bumped inside the same transaction as the
-- settings write, makes the version mean exactly "the configuration has changed this many times".
--
-- NO CREDENTIAL MAY EVER BE STORED HERE
--
-- This table holds operator POLICY. Secrets stay in the protected secrets file and in the process
-- environment (see src/env/secrets.ts, which classifies every variable as secret/identity/config). The
-- application refuses to register a non-`config` variable as a runtime setting, and a test asserts it.
-- The audit table below records configuration values, so the same rule applies there: it must never
-- receive a credential.
--
-- MISSING MEANS "FALL THROUGH", NEVER ZERO
--
-- No row is created for a setting an operator has not changed. An absent row means the effective value
-- comes from the environment, and failing that from the code default. This is load-bearing: several
-- ceilings read `0` as UNLIMITED (`BOX_MAX_OPEN_BOXES`, `BOX_LIVE_DAILY_LOSS_LIMIT`,
-- `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES`), so reading a missing row as `0` would silently convert a finite
-- risk limit into no limit at all. Nothing in this migration backfills a row for that reason.
--
-- Safe to run on a live database: ADD COLUMN with no default and DROP NOT NULL are metadata-only
-- operations in PostgreSQL and take no table rewrite; the two new tables lock nothing else.

/* ---------------------------- box_settings, generalised --------------------------- */

-- A JSON value, so a boolean/enum/string setting can be stored. Numeric settings may continue to use
-- `value`; both are accepted and the CHECK below requires exactly one.
ALTER TABLE box_settings ADD COLUMN IF NOT EXISTS value_json JSONB;

-- The operator ROLE that last wrote the row (never a token, key or session identifier).
ALTER TABLE box_settings ADD COLUMN IF NOT EXISTS updated_by TEXT;

-- Booleans and enums have no numeric value to supply.
ALTER TABLE box_settings ALTER COLUMN value DROP NOT NULL;

-- EXACTLY ONE value column per row. Without this, a row could carry both and disagree with itself, or
-- neither and mean nothing — and a settings row that means nothing resolves to a permissive default,
-- which is the failure direction that matters for a risk limit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'box_settings_exactly_one_value'
  ) THEN
    ALTER TABLE box_settings ADD CONSTRAINT box_settings_exactly_one_value
      CHECK ((value IS NULL) <> (value_json IS NULL));
  END IF;
END
$$;

COMMENT ON TABLE box_settings IS
  'Durable operator runtime configuration: one row per setting an operator has explicitly changed. '
  'A setting with NO row falls through to the environment and then to the code default — a missing '
  'row is NEVER read as 0, because several ceilings treat 0 as UNLIMITED. Holds operator POLICY '
  'only; no credential is ever stored here.';

COMMENT ON COLUMN box_settings.key IS
  'Stable snake_case setting identity (e.g. live_max_box_capital_rupees). Decoupled from both the '
  'TypeScript field name and the legacy environment variable so neither can be renamed into a '
  'silently orphaned row.';

COMMENT ON COLUMN box_settings.value IS
  'Numeric value, for numeric settings. NULL when the setting is a boolean, enum or string — see '
  'value_json. Exactly one of value/value_json is non-NULL.';

COMMENT ON COLUMN box_settings.value_json IS
  'JSON value, for boolean, enum and string settings. Exactly one of value/value_json is non-NULL.';

COMMENT ON COLUMN box_settings.updated_by IS
  'The operator ROLE that last wrote this row (never a token, key or session identifier).';

/* ------------------------------- box_config_version ------------------------------ */
--
-- One row, forever. `id` is pinned to TRUE by a CHECK so a second row is impossible: a configuration
-- with two version numbers has no version number.

CREATE TABLE IF NOT EXISTS box_config_version (
  id         BOOLEAN     PRIMARY KEY DEFAULT TRUE,
  version    BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT box_config_version_single_row CHECK (id IS TRUE),
  CONSTRAINT box_config_version_non_negative CHECK (version >= 0)
);

-- Seed the single row. ON CONFLICT DO NOTHING so re-running is harmless and an existing version is
-- never reset — resetting it would make every client's cached version spuriously valid again.
INSERT INTO box_config_version (id, version) VALUES (TRUE, 0)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE box_config_version IS
  'Single-row optimistic-concurrency token for the operator configuration as a whole. Read and '
  'incremented inside the SAME transaction as a settings write, so a PATCH carrying a stale version '
  'is refused rather than silently overwriting another operator''s change.';

/* -------------------------------- box_settings_audit ----------------------------- */
--
-- APPEND-ONLY. No UPDATE and no DELETE path exists in the application, and there is deliberately no
-- unique constraint that a retry could violate: an operator who submits the same change twice made
-- two decisions, and the trail should show both.
--
-- BOTH configured AND effective values are recorded, before and after. They differ whenever a
-- deployment ceiling is clamping an operator's value, and "I set 150,000" versus "120,000 was
-- enforced" is precisely the distinction an incident review needs. Recording only one of them would
-- make the trail misleading in the exact case it matters.

CREATE TABLE IF NOT EXISTS box_settings_audit (
  id                  BIGSERIAL   PRIMARY KEY,
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The operator ROLE ('full' | 'trade'). Never a token, passcode or session identifier.
  actor_role          TEXT,
  setting_key         TEXT        NOT NULL,
  previous_configured JSONB,
  new_configured      JSONB,
  previous_effective  JSONB,
  new_effective       JSONB,
  -- The policy under which the change was admitted (HOT_SAFE, TIGHTEN_ONLY_WHILE_ARMED, …), so the
  -- trail explains WHY a change was allowed in the state the system was in.
  mutation_policy     TEXT,
  -- Where the effective value came from after the change (default | env | runtime |
  -- runtime_clamped_by_env). This is what makes a clamp visible in the trail.
  new_source          TEXT,
  -- The armed trading session at the time, when there was one.
  session_id          TEXT,
  reason              TEXT,
  -- The box_config_version this change PRODUCED, linking the trail to the snapshot it created.
  config_version      BIGINT      NOT NULL,
  CONSTRAINT box_settings_audit_key_not_blank CHECK (length(btrim(setting_key)) > 0),
  CONSTRAINT box_settings_audit_reason_bounded CHECK (reason IS NULL OR length(reason) <= 280)
);

-- The UI shows a short recent-changes list, and an incident review reads the tail. Both are
-- newest-first over the whole table.
CREATE INDEX IF NOT EXISTS box_settings_audit_changed_at_idx
  ON box_settings_audit (changed_at DESC, id DESC);

-- "How did THIS limit get to its current value?" is the other question asked of this table.
CREATE INDEX IF NOT EXISTS box_settings_audit_key_changed_at_idx
  ON box_settings_audit (setting_key, changed_at DESC);

COMMENT ON TABLE box_settings_audit IS
  'Append-only trail of operator configuration changes affecting trading and risk. Records the '
  'configured AND effective value before and after, because a deployment ceiling can make those '
  'differ and that difference is what an incident review needs. NEVER receives a credential: only '
  'settings classified as plain config are registrable, and the actor is a ROLE, not a token.';

COMMENT ON COLUMN box_settings_audit.actor_role IS
  'The operator ROLE that made the change (full | trade). Never a token, passcode or session id.';

COMMENT ON COLUMN box_settings_audit.previous_effective IS
  'The value the engine was ENFORCING before the change — which is not necessarily the previously '
  'configured value, because a deployment ceiling may have been clamping it.';

COMMENT ON COLUMN box_settings_audit.new_source IS
  'Provenance of the effective value after the change: default | env | runtime | '
  'runtime_clamped_by_env. A clamp is therefore visible in the trail rather than inferred.';

COMMENT ON COLUMN box_settings_audit.config_version IS
  'The box_config_version value this change produced, linking each trail entry to the configuration '
  'snapshot it created.';
