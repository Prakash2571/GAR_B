-- 015_execution_leases.sql
--
-- AN ACCOUNT-SCOPED EXECUTION LEASE, SO TWO PROCESSES CANNOT BOTH SUBMIT ORDERS FOR ONE ACCOUNT.
--
-- WHAT WAS MISSING
--
-- The deployment assumes ONE Node process, and until now that was the only thing enforcing it.
-- Nothing in the code established exclusive execution ownership:
--
--   · `box_trading_session`'s mutex is a per-instance promise chain (`tradingSessionStore.ts`), so it
--     orders nothing between two managers. Migration 015's sibling change made the ATTEMPT COUNTER
--     atomic, which stops two processes over-spending a budget — but a bounded budget spent by the
--     wrong number of processes is still two processes trading the same account.
--   · `backend_instance_epoch` (migration 009) hands out strictly increasing boot ordinals. Those
--     order a FRONTEND's readiness decisions across a restart. They grant nothing and revoke nothing:
--     the atomic increment guarantees two live processes get DIFFERENT ordinals, so the
--     "two instances" detection branch in `orderReadinessDecision()` (which requires EQUAL ordinals)
--     is unreachable for exactly the topology it was meant to catch, and a client simply adopts the
--     higher ordinal while the lower-ordinal process keeps trading. UI restart ordering is not
--     execution fencing and must never be mistaken for it.
--   · `box_reservation_keys` (migration 004) is a real distributed lease, but it is scoped to
--     INSTRUMENT KEYS. It stops two workers reserving the same option contract. It cannot express
--     "who may POST to Zerodha account AB1234", which is the question that matters for an account
--     whose positions and margin are shared by everything that touches it.
--
-- WHAT THIS TABLE IS
--
-- One row per (deployment, broker, account) — the PRIMARY KEY, so mutual exclusion is the database's
-- to enforce rather than the application's to remember. The holder is a `reservations/identity.ts`
-- owner id, which already embeds deployment, instance, pid and a per-boot token, so a restarted
-- process with a recycled pid is correctly "not me".
--
-- TTL + HEARTBEAT, not a held connection. `kill -9` leaves no chance to release anything, so expiry
-- has to be the backstop and explicit release merely an optimisation — the same model
-- `box_reservation_owners` uses, and for the same reason. A challenger may only take over a row whose
-- `expires_at` has passed ON THE SERVER'S CLOCK (`clock_timestamp()`), never on its own.
--
-- THE FENCE comes from `box_reservation_fence_seq` (migration 004), reused deliberately: one sequence
-- means an execution lease and an instrument reservation can never be confused for one another by
-- number, and monotonicity is already proven there. Every successor's fence is strictly greater than
-- every predecessor's.
--
-- `takeover_reconciled_at` IS THE HONEST PART
--
-- Acquiring the row proves nobody else may START a new broker mutation. It proves nothing about
-- requests the previous owner ALREADY SENT: an HTTP POST in flight when a lease lapses still lands,
-- and neither Zerodha nor Dhan accepts a fencing token that would let the broker reject it. So a
-- taking-over owner is admitted to the row but NOT yet to dispatch: it must first reconcile pending
-- and ambiguous broker operations and then stamp this column. Until it is stamped, the lease grants
-- protective reduction and reconciliation only — never new entry. See `executionLease.ts` for the
-- state machine and `docs/EXECUTION_OWNERSHIP.md` for what the fence can and cannot do.
--
-- WHY A NEW TABLE RATHER THAN A SYNTHETIC `box_reservation_keys` ROW
--
-- A synthetic `instrument_key = 'execution-lease:<account>'` row would work and would need no DDL.
-- It is rejected because it makes every existing reservation query ambiguous: `countLive()`,
-- `findLiveByKeys()` and the broker-switch `deleteByOwnerPrefix()` sweep would all have to learn to
-- exclude a magic key prefix, and forgetting that in one place turns an execution lease into an
-- instrument reservation or silently deletes it. A separate table cannot be confused with a contract.
--
-- ROLLBACK. Dropping this table is safe for an OLDER build (which never reads it) and is the
-- documented rollback step; a NEWER build with the table absent fails its readiness check and refuses
-- new entry rather than assuming exclusivity it cannot verify. There is no data to preserve: a lease
-- is live-state with a TTL, not a record of anything that happened.

CREATE TABLE IF NOT EXISTS box_execution_leases (
  -- '<deployment>|<broker>|<account>'. Materialised as the key rather than a composite PK so the
  -- scope a process asked for is exactly the scope stored, with no re-derivation on read.
  scope                  text PRIMARY KEY,
  deployment             text NOT NULL,
  broker                 text NOT NULL,
  account                text NOT NULL,
  owner                  text NOT NULL,
  instance               text NOT NULL DEFAULT '',
  fence                  bigint NOT NULL,
  acquired_at            timestamptz NOT NULL,
  renewed_at             timestamptz NOT NULL,
  expires_at             timestamptz NOT NULL,
  -- NULL until this owner has reconciled the previous owner's pending/ambiguous broker operations.
  -- NULL therefore means "owns the account, may reduce and reconcile, may NOT start new entry".
  takeover_reconciled_at timestamptz,
  -- Why the previous owner lost it, carried forward for the operator: 'fresh' (no incumbent),
  -- 'expired' (TTL lapsed), 'released' (clean handover). Never used to decide anything.
  takeover_reason        text NOT NULL DEFAULT 'fresh',
  CONSTRAINT box_execution_leases_expiry_after_acquire CHECK (expires_at >= acquired_at),
  CONSTRAINT box_execution_leases_fence_positive CHECK (fence > 0),
  CONSTRAINT box_execution_leases_account_present CHECK (account <> '')
);

-- Find a process's own leases without scanning: used by the broker-switch and shutdown paths, which
-- must act on THIS owner's rows and never on a successor's.
CREATE INDEX IF NOT EXISTS box_execution_leases_owner_idx
  ON box_execution_leases (owner);

-- Reaping lapsed rows at boot, and reporting how many live owners exist.
CREATE INDEX IF NOT EXISTS box_execution_leases_expires_idx
  ON box_execution_leases (expires_at);

-- The fence sequence is created by migration 004. Recreate defensively so this migration can be
-- applied into a schema built from 015 alone (a restore into a scratch schema, for instance) without
-- depending on apply order. `IF NOT EXISTS` makes it a no-op in the normal case.
CREATE SEQUENCE IF NOT EXISTS box_reservation_fence_seq AS bigint START 1;
