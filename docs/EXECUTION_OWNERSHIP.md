# Exclusive execution ownership — what it guarantees, and what it cannot

This document exists because the guarantee is partial and the partiality matters. Read the
limits section before relying on any of this.

## The problem it solves

The deployment has always assumed one Node process. Until now that assumption was enforced by
nothing.

- `box_trading_session`'s mutex is a **per-instance promise chain**
  (`src/box/tradingSessionStore.ts`). It orders this object's mutations. It orders nothing
  between two objects, in one process or two.
- `backend_instance_epoch` (migration 009) hands out strictly increasing **boot ordinals**.
  They let a *browser* totally-order readiness decisions across a restart. They grant nothing
  and revoke nothing. Worse, because the increment is atomic, two live processes always receive
  **different** ordinals — so the "two instances" branch of `orderReadinessDecision()`, which
  fires only on *equal* ordinals, is unreachable for exactly the topology it was written to
  catch. A client simply adopts the higher ordinal while the lower-ordinal process keeps
  trading. **UI restart ordering is not execution fencing and must never be read as such.**
- `box_reservation_keys` (migration 004) is a genuine distributed lease, but it is scoped to
  **instrument keys**. It stops two workers reserving the same option contract. It cannot
  express "who may POST to Zerodha account AB1234".

Reproduced before the fix, against real PostgreSQL
(`tests/pg/sessionBudgetTwoManagers.test.mjs`):

| scenario | before | after |
| --- | --- | --- |
| two managers, `max_entry_attempts=1` | both admitted, row said 1 | one admitted, row says 1 |
| ten managers, ceiling 4 | **all ten admitted**, row said 4 | four admitted, row says 4 |
| stale `recordAborted()` after 2 spent | counter reset to **0** | counter stays 2 |

## The two mechanisms

### 1. Atomic session-budget consumption

`consumeBoxTradingSessionEntryAttempt()` decides the whole thing in one statement:

```sql
UPDATE box_trading_session
   SET entry_attempts = entry_attempts + 1, updated_at = $3
 WHERE id = 'current'
   AND session_id = $2
   AND (max_entry_attempts = 0 OR entry_attempts < max_entry_attempts)
RETURNING entry_attempts, max_entry_attempts
```

One row lock serialises every contender. No caller snapshot participates, so there is nothing
to lose. The `session_id` predicate stops an attempt authorised under an old arming from
spending a new allowance. A zero `rowCount` is the refusal.

For this to mean anything, `saveBoxTradingSession` **preserves** the durable attempt columns on
conflict unless the caller passes `claimsAttemptBudget` (only `arm` does). Without that, the
atomic increment is simply overwritten by the next unrelated save — which is the stale-rollback
row in the table above.

### 2. The account-scoped execution lease

`box_execution_leases` (migration 015), one row per `(deployment, broker, account)` as the
PRIMARY KEY, so mutual exclusion is the database's to enforce.

- **TTL + heartbeat**, not a held connection. `kill -9` leaves no chance to release anything, so
  expiry must be the backstop and explicit release merely an optimisation.
- **The server's clock decides expiry.** Every predicate compares against `clock_timestamp()`
  evaluated inside PostgreSQL. Two processes with skewed clocks still agree.
- **The fence** comes from `box_reservation_fence_seq`, so every successor's fence is strictly
  greater than every predecessor's.
- **Renewal and release are pinned to `owner` AND `fence` AND an unexpired row.** A lapsed lease
  cannot be renewed back to life, and a dead predecessor cannot delete its successor's row.
- **`takeover_reconciled_at`** is NULL until the owner has reconciled pending and ambiguous
  broker operations. While NULL the lease permits reduction, cancellation and reconciliation but
  **not new entry**.

Enforced at `src/box/orderManager.ts` CHECKPOINT 5 — the last synchronous instant before the
broker POST — via `executionOwnershipBlockReason`, and again at the entry gate so an operator
sees it as a block reason rather than as four orders that each fail at the last instant.

### The entry/reduction asymmetry

This is the most important design decision here, and it mirrors
`orderManager.dispatchAccountBlockReason`, which blocks only on *positive proof* of a different
account.

| lease state | new entry | reduction / cancel / reconcile |
| --- | --- | --- |
| held, reconciled, fresh observation | permitted | permitted |
| held, **not yet reconciled** | refused | **permitted** |
| held, observation older than the guard margin | refused | refused |
| **refused** — another live instance holds it | refused | refused |
| **lost** — ours lapsed, may be taken over | refused | refused |
| unavailable — no lease table, no PostgreSQL | refused | **permitted** |
| inactive — account not provable | refused | **permitted** |
| paper deployment | permitted | permitted |

The two shaded groups are genuinely different:

- **Cannot tell** (no lease table, no provable account). There is no evidence another instance
  exists. Creating new exposure without provable exclusivity is the hazard, so entry is refused.
  Reducing is permitted, because refusing it would strand real positions for a reason that is
  not evidence of anything. A refused exit guarantees the position stays.
- **Proven foreign** (held elsewhere, lost, or unprovable-by-staleness). Now there *is* evidence
  of a second owner, and both directions must stop: two processes flattening the same position
  double-close it, and two cancelling race each other.

Collapsing these into one answer breaks one invariant or the other, whichever way it is
collapsed.

## LIMITS — what this does not do

### It cannot cancel a request already on the wire

If a lease lapses while an HTTP POST is in flight, that POST still reaches the broker and may
still be accepted. A database row has no authority over a TCP connection. **A database lease
does not cancel an already-sent HTTP request.** This is why takeover must reconcile before it
starts new entry.

### The broker does not enforce it

Neither Zerodha's nor Dhan's order API accepts a fencing token, an epoch, or a
conditional-on-generation placement. There is no way to ask the broker to reject an order from a
superseded owner. **The fence orders our decisions; the broker never sees it.**

Consequence: a genuinely partitioned old owner that can still reach the broker but not the
database is stopped only by its own guard — its cached lease observation ages past
`guardMarginMs` and it refuses itself. That is a real, bounded residual risk, not a proof. It is
bounded by `guardMarginMs` (default 5 s) and nothing else.

### It does not survive an unbounded process pause

A process stopped between the guard and the wire for longer than `guardMarginMs` — SIGSTOP, a
pathological GC pause, a suspended VM — can emit an order after a successor has taken over. The
margin bounds this; it does not eliminate it.

The trade-off is deliberate: a shorter TTL narrows the takeover delay but widens the false-loss
rate (a healthy owner briefly unable to reach PostgreSQL stops dispatching).

`tests/pg/twoProcessOwnership.test.mjs` test 6 pins what *is* true — a stalled owner refuses its
own dispatch in both directions — and deliberately does not assert what is not.

### What it therefore is

A mechanism that makes **two instances trading one account** a refused, reported state instead
of a silent one, with a bounded residual window during network partition or process suspension.
It is not a proof that two orders can never both reach the broker.

## Operating it

Configuration (all optional; defaults in `src/box/executionLease.ts`):

| knob | default | meaning |
| --- | --- | --- |
| TTL | 30 s | how long after an owner stops renewing before a successor may take over |
| heartbeat | 8 s | renewal period; comfortably under a third of the TTL so two failures are harmless |
| guard margin | 5 s | minimum provable life the dispatch guard demands |

`CALSPREAD_DEPLOYMENT_ID` **should be set explicitly.** An inferred deployment id means two
environments can share a lock namespace — the engine already warns about this for instrument
reservations and the same warning applies here.

### "The execution lease is held by another instance"

The status projection reports `state: "refused"` and names the holder. That message means what
it says: another process has the account. Do not restart this process expecting to win — a
restart draws a new fence but the incumbent's lease is still live.

1. Identify the holder. The owner id embeds deployment, instance label, pid and a per-boot
   token: `<deployment>:<instance>:p<pid>:<boot>:<kind>-<seq>:<uuid>`.
2. Stop the other instance, or wait for its lease to lapse (≤ TTL after it stops renewing).
3. If the holder is a process you believe is dead, wait out the TTL. Do **not** delete the row
   by hand while any doubt remains about whether that process can still reach the broker.

### Migration and rollback

`migrations/015_execution_leases.sql` is additive: one new table, two indexes, and a defensive
`CREATE SEQUENCE IF NOT EXISTS` for the fence sequence migration 004 already creates. It
preserves every existing record — there is nothing to convert, because a lease is live state
with a TTL, not a record of anything that happened.

**Upgrade.** Apply the migration before starting the new build (`npm run migrate`). A new build
started against a database without the table reports `unavailable`, refuses new entry, and keeps
reduction available — it does not crash, and it does not silently assume exclusivity.

**Rollback.** An older build never reads the table, so rolling the code back needs no schema
change. If the table must also be dropped, do it only while no new-build process is running:
`DROP TABLE box_execution_leases;`. Do **not** drop `box_reservation_fence_seq` — migration 004
owns it and the instrument reservations use it.

There is no data-loss risk in either direction. The only cost of dropping the table while a new
build runs is that the build refuses new entry until it is restored.
