-- 011_order_intent_broker_account.sql
--
-- BIND EVERY LIVE ORDER INTENT TO THE BROKER ACCOUNT THAT PLACED IT.
--
-- WHY THIS IS NEEDED
--
-- `box_order_intents` already carries `broker` (zerodha | dhan), so reconciliation can never look an
-- unresolved Zerodha order up through Dhan. It carried NOTHING about WHICH ACCOUNT placed the order,
-- and nothing on the live path could name one: the engine's account provider was
--
--     private liveBrokerAccount(): string | null {
--       return this.deps.marketData.isAuthenticated() ? null : null;   -- always null
--     }
--
-- and both order-stream ownership registrations hard-coded `account: null`. So the order-update
-- projection's `foreign_account` rejection could never fire, and attribution rested entirely on the
-- per-order tag.
--
-- The exposure that creates: a re-login to a DIFFERENT account under the same API key leaves nothing
-- structural to stop the new session adopting, reconciling, cancelling or flattening the PREVIOUS
-- account's orders and positions. The tag is unique per order, so a collision is unlikely — but "the
-- tag did not collide" is not the same guarantee as "this order belongs to the account we are
-- authenticated as", and only the second one is safe to act on.
--
-- ADDITIVE AND NULLABLE, DELIBERATELY
--
-- The column is NULLABLE with NO DEFAULT and NO BACKFILL. A historical row genuinely does not record
-- which account placed it, and silently stamping it with whatever account happens to be signed in now
-- would MANUFACTURE the very attribution this column exists to prove — the worst possible outcome,
-- because it would look like evidence.
--
-- NULL therefore means "unknown, predates account binding", and the application treats it as
-- requiring broker evidence or explicit operator resolution before it may be acted upon. See
-- `BoxOrderManager.accountConsistencyBlockReason`.
--
-- Safe to run on a live database: ADD COLUMN ... NULL takes no table rewrite on PostgreSQL 11+, and
-- the partial index only covers live rows that carry an account.

ALTER TABLE box_order_intents
  ADD COLUMN IF NOT EXISTS broker_account TEXT;

COMMENT ON COLUMN box_order_intents.broker_account IS
  'The broker account (Kite user_id / Dhan client id) this intent was submitted under. NULL means the '
  'row predates account binding and its attribution is UNPROVEN — it must be reconciled against broker '
  'evidence or explicitly resolved by an operator before being acted upon. Never backfilled: stamping '
  'a historical row with the currently signed-in account would fabricate attribution.';

-- Reconciliation and the foreign-account guard both filter live, non-terminal intents by account.
CREATE INDEX IF NOT EXISTS box_order_intents_live_account_idx
  ON box_order_intents (broker, broker_account)
  WHERE broker_mode = 'live' AND broker_account IS NOT NULL;
