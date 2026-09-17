-- 012_box_excluded_underlyings.sql
--
-- AN OPERATOR-OWNED BLOCKLIST OF UNDERLYINGS THAT MUST NEVER BE ENTERED.
--
-- WHY THIS IS NEEDED
--
-- Until now the traded universe was derived entirely from the broker's instrument dump: every F&O
-- underlying that joined an option chain and fitted the token budget became a candidate, and the
-- only ways to keep a symbol out were to shrink `BOX_MAX_UNDERLYINGS` (which selects by the board's
-- priority order, not by name) or to stop the scanner altogether. Neither expresses the thing an
-- operator actually needs to say: "this specific name is not tradable — for any reason I do not
-- have to justify to the engine — so do not enter it, in any execution mode, until I say otherwise."
--
-- Illiquid strikes, a name in a corporate-action window, a symbol whose lot size just changed, a
-- ban-period stock, or simply a name the operator does not want risk on during a supervised live
-- test: all of them share one requirement, and it is a REFUSAL, not a preference.
--
-- WHY A TABLE AND NOT `box_settings`
--
-- `box_settings` (migration 003) is `key text PRIMARY KEY, value numeric NOT NULL`. Its value column
-- is numeric, so it cannot hold a symbol list at all. A blocklist also wants per-entry provenance —
-- who excluded it, when, and why — which a single key/value row cannot carry either. So: its own
-- table, one row per excluded underlying.
--
-- WHY THE SYMBOL IS THE PRIMARY KEY
--
-- Excluding the same name twice is not an error and must not create a second row; it is the same
-- statement made again. A primary key on the normalised symbol makes the upsert idempotent, which
-- is what lets the HTTP route be safely retried by an operator hammering a button on a bad
-- connection.
--
-- NORMALISATION IS THE APPLICATION'S JOB, ENFORCED HERE
--
-- The application uppercases and trims before writing (see src/box/underlyingExclusions.ts). The
-- CHECK constraints below are a backstop, not the primary defence: they reject an empty symbol, a
-- symbol with surrounding whitespace, and a lowercased symbol, so a hand-written INSERT cannot
-- create a row that the in-memory Set would never match. A blocklist that silently fails to match
-- is worse than no blocklist, because it reads as protection.
--
-- `reason` AND `excluded_by` ARE NULLABLE, DELIBERATELY
--
-- An exclusion is valid without a stated reason — requiring prose would push operators towards
-- typing "x" to get past a validator, which produces worse provenance than an honest NULL. NULL
-- means "not recorded", never "no reason existed".
--
-- Safe to run on a live database: a new table takes no lock on anything else.

CREATE TABLE IF NOT EXISTS box_excluded_underlyings (
  symbol      TEXT        PRIMARY KEY,
  reason      TEXT,
  excluded_by TEXT,
  excluded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT box_excluded_underlyings_symbol_not_blank
    CHECK (length(btrim(symbol)) > 0),
  CONSTRAINT box_excluded_underlyings_symbol_normalised
    CHECK (symbol = upper(btrim(symbol))),
  CONSTRAINT box_excluded_underlyings_reason_bounded
    CHECK (reason IS NULL OR length(reason) <= 280)
);

COMMENT ON TABLE box_excluded_underlyings IS
  'Operator-owned blocklist of underlyings that must never be ENTERED, in any execution mode '
  '(paper_touch, paper_latency, paper_legging, live). Enforcement is in-memory at four independent '
  'entry chokepoints; this table is the durable source reloaded at boot. It NEVER blocks an exit, a '
  'reduction, a protective cancel or a flatten: excluding a name whose box is already open must not '
  'trap the position.';

COMMENT ON COLUMN box_excluded_underlyings.symbol IS
  'The underlying symbol as the board reports it (e.g. NIFTY, RELIANCE), uppercased and trimmed. '
  'Primary key so re-excluding a name is idempotent rather than duplicated.';

COMMENT ON COLUMN box_excluded_underlyings.reason IS
  'Free-text operator note, bounded to 280 characters. NULL means no reason was recorded — never '
  'that no reason existed.';

COMMENT ON COLUMN box_excluded_underlyings.excluded_by IS
  'The operator ROLE that added the exclusion (never a token, key or session identifier).';
