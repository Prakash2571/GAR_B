# GTS Algo Research internal seams

This file is the contract between the subsystems of `GTSAlgoResearch_B`. It exists because the
extraction replaced the predecessor codebase's two implicit seams (a 5,584-line `index.ts` and a Mongoose
model layer) with explicit ones. Anything crossing a seam listed here is a breaking change
and must be recorded in `docs/EXTRACTION_MANIFEST.md`.

## Module ownership

| Area | Files | Owns |
| --- | --- | --- |
| Foundation | `src/config.ts`, `src/pg/pool.ts`, `src/pg/migrate.ts`, `src/outbox/writer.ts`, `src/types/charges.ts`, `src/boxSupport.ts`, `migrations/001_outbox.sql` | Pool, transactions, migration runner, outbox enqueue, the helpers the predecessor codebase's `index.ts` used to inject |
| Box persistence | `src/box/repository.ts`, `src/box/model.ts`, `src/box/reservations/*`, `src/box/pnlCache.ts`, `src/box/closedCache.ts`, `migrations/002`–`004` | PostgreSQL implementation of every durable Box operation |
| Projection | `src/outbox/projector.ts`, `src/outbox/mongo.ts`, `src/outbox/status.ts`, `src/scripts/migrateBoxFromMongo.ts`, `src/scripts/outboxReplay.ts` | Draining the outbox into MongoDB Atlas; legacy import |
| Broker sessions | `src/brokerState/*`, `src/tokens/*`, `src/brokers/registry.ts`, `src/kite.ts`, `migrations/005`–`006`, `src/scripts/rotateBrokerTokenKey.ts` | Dual token acquisition, AES-256-GCM at rest, durable active-broker record |
| Access | `src/access/*`, `src/box/routes.ts`, `src/runtime/*`, `src/brokerRoutes.ts`, `migrations/007` | Site passcode gate, CSRF, session cookies, protected status endpoints |
| Boot | `src/index.ts`, `src/shutdown.ts` | Boot order, shutdown order, wiring |

## Seam 1 — `src/box/repository.ts`

The Box domain (`engine.ts`, `orderManager.ts`, `positionMonitor.ts`, `executionGateway.ts`,
`executionCoordinator.ts`, …) reaches durable state ONLY through this module. Its **exported
names and signatures are frozen**: they are the predecessor codebase's surface, and every one of the 1,488
ported unit tests is written against them. The implementation moved from Mongoose to `pg`; the
surface did not move at all.

Two behavioural additions are permitted and required:

1. Every mutation that must reach MongoDB Atlas calls `enqueueOutbox(client, …)` on the same
   `PoolClient` inside the same transaction.
2. `updateBoxOrderIntent` returns the authoritative **durable** pre-write and post-write
   cumulative filled quantities, read under a row lock — never derived from a caller snapshot.

## Seam 2 — `src/box/model.ts`

Was Mongoose schemas. Is now pure types plus the `AssertAssignable` compile-time proof that
`BoxLegCharges`/`BoxCharges` stay interchangeable with `ILegCharges`/`ITradeCharges` (now in
`src/types/charges.ts`). `BoxTradeRecord`, `BoxOrderIntentRecord`, `BoxExecutionAttemptRecord`
and `BoxDailyPnlRecord` keep their names and their `_id: string` opaque identity, because
`src/box/serialize.ts` and the frontend depend on IDs being opaque strings.

## Seam 3 — reservations

`src/box/reservations/port.ts` is unchanged. `mongoStore.ts` is replaced by `pgStore.ts`
implementing the same `DurableReservationStore` port. Fences come from a PostgreSQL sequence
and authority time from `clock_timestamp()`; an advisory lock is never the reservation record.

## Seam 4 — outbox

`enqueueOutbox` (writer, inside the operational transaction) and the projector (reader, an
independent background loop) share only the `mongo_outbox` table. The projector never calls
into the Box domain and the Box domain never awaits the projector.

## Seam 5 — broker sessions

`src/brokerState/brokerSessions.ts` exposes `loadDhanSession`, `saveDhanSession`,
`clearDhanSession`, `loadActiveBroker`, `saveActiveBroker` with the predecessor codebase's signatures, so
`ActiveBrokerManager` is ported with a single changed import line. Tokens are decrypted only
inside this module's provider; nothing else in the process sees ciphertext or plaintext except
`src/kite.ts` and the Dhan client, which receive plaintext in memory only.

## Seam 6 — access

`src/access/middleware.ts` exports `requireOperator` and `getOperatorRole`, which are what
`registerBoxRoutes` receives in place of the predecessor codebase's `requireAdmin` / `getAdminRole`. The
`RequestHandler` shape is identical, so `src/box/routes.ts` changes only at the import and the
parameter names.

## Invariants no subsystem may weaken

- `synchronous_commit` stays on. No session-level override anywhere.
- MongoDB is never awaited before a broker POST, and never consulted to decide whether an
  order may be submitted.
- Paper mode never constructs a mutation-capable adapter.
- Live requires `BOX_EXECUTION_MODE=live` **and** `BOX_LIVE_TRADING_ENABLED=true` **and** the
  active broker's own gate, and still starts runtime-disarmed.
- Entering the site passcode arms nothing.
- Entry-side guards (capital cap, one-active-underlying, session budget, scanner STOP, entry
  disabled, reservation-authority outage) may block ENTRY only. They may never block an exit,
  a protective cancellation, an emergency residual flatten or a reconciliation-required
  reduction.
