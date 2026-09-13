# MongoDB projection (the async reporting replica)

GTS Box's authoritative operational store is PostgreSQL. MongoDB Atlas is an
**async reporting replica**, fed by a transactional outbox. It is never on the
execution hot path, never awaited before a broker POST, and never consulted to
decide whether an order may be submitted. If Atlas is down, misconfigured, or
disabled, GTS Box keeps trading — only the reporting replica falls behind.

## The two halves

| Half | File | Runs where |
| --- | --- | --- |
| Writer (enqueue) | `src/outbox/writer.ts` | INSIDE the operational PostgreSQL transaction |
| Reader (projector) | `src/outbox/projector.ts` | An INDEPENDENT background loop |

They share only the `mongo_outbox` table (`migrations/001_outbox.sql`). The writer
inserts a projection row in the SAME transaction as the operational fact it
describes, so after COMMIT the fact and its projection intent are either both
durable or neither is. The projector later drains those rows to Atlas.

Because the enqueue is a local `INSERT` and the projector is the only thing that
awaits Mongo:

- a Mongo outage cannot fail, delay or block an order-intent transition, an exit,
  a protective cancel, a reconciliation or a residual flatten;
- a crash after PostgreSQL COMMIT but before the Mongo write is recovered on
  restart purely by re-reading unpublished rows — no in-memory queue is ever the
  source of truth.

## Configuration (`src/outbox/mongo.ts`)

| Env | Default | Meaning |
| --- | --- | --- |
| `MONGODB_URI` | (unset) | Atlas connection string. **Unset ⇒ projector does not run.** |
| `MONGO_EXPORT_ENABLED` | `true` | `false` ⇒ projector does not run. |
| `MONGO_EXPORT_BATCH_SIZE` | `100` | Rows claimed per drain pass. |
| `MONGO_EXPORT_INTERVAL_MS` | `1000` | Delay between drain passes. |
| `MONGO_EXPORT_MAX_BACKOFF_MS` | `60000` | Cap on per-row exponential backoff. |
| `MONGO_EXPORT_SERVER_SELECTION_TIMEOUT_MS` | `5000` | Bounded connect/selection timeout. |
| `MONGO_EXPORT_MAX_ATTEMPTS` | `10` | Attempt budget before a row is dead-lettered. |
| `MONGO_EXPORT_DB` | (from URI) | Overrides the database name parsed from the URI. |

Disabling export or leaving `MONGODB_URI` unset is a **non-event**: the projector
simply never starts, and nothing else is affected.

## Projected document shape

Each outbox row becomes exactly one Mongo document, keyed by the row's `event_id`:

```json
{
  "_id": "<event_id>",            // the stable, caller-chosen outbox identity
  "aggregate_type": "box_trade",  // routing discriminator
  "aggregate_id": "<trade id>",   // the aggregate the event belongs to
  "event_type": "trade_opened",   // domain event name
  "schema_version": 1,            // bumped when the shape changes
  "sequence": 4242,               // monotonic per-aggregate order (from the outbox)
  "data": { /* the projected payload, exactly as enqueued */ },
  "projected_at": "2026-09-08T…"  // when the projector wrote this document
}
```

Collections mirror the legacy Box-oriented names:

| `aggregate_type` | Collection |
| --- | --- |
| `box_trade` | `box_trades` |
| `box_trade_event` | `box_trade_events` |
| `box_order_intent` | `box_order_intents` |
| `box_execution_attempt` | `box_execution_attempts` |
| `box_daily_pnl` | `box_daily_pnl` |
| `box_calibration_sample` | `box_calibration_samples` |

### Guarantees

- **Idempotent (exactly-once effect).** The write is `replaceOne({_id}, doc, {upsert:true})`.
  A redelivery — a crash between the Mongo write and the PostgreSQL mark-published,
  or a hand replay — overwrites the same document. It never appends a second trade
  event or doubles a P&L figure.
- **Ordered per aggregate.** `FOR UPDATE SKIP LOCKED` alone does not order work. The
  projector groups a claimed batch by `(aggregate_type, aggregate_id)` and applies
  each group strictly in `sequence` order. The FIRST failure in a group STOPS that
  group, so a trade's `CLOSED` projection can never land before its `OPENED`
  projection. Unrelated aggregates in the same batch still publish.
- **Secret-free.** `assertNoSecretFields` (from the writer) runs immediately before
  every Mongo write as a second line of defence. A payload that somehow reached the
  table carrying a broker access token, an access-session token, the site passcode,
  a CSRF secret or a database credential is refused at the boundary and dead-lettered.

## Retry, backoff and dead-lettering

A failed delivery increments `attempts`, records a **bounded** (`<= 500` char,
single-line, no SQL text, no credentials) `last_error`, and pushes `next_attempt_at`
out with capped exponential backoff (`1s · 2^attempts`, clamped to
`MONGO_EXPORT_MAX_BACKOFF_MS`).

A row is **dead-lettered** (`dead_lettered_at` set) when:

- it exhausts its attempt budget (`MONGO_EXPORT_MAX_ATTEMPTS`), or
- it is **poison** — its `aggregate_type` maps to no collection, or its payload
  trips the secret guard. Poison rows are dead-lettered immediately rather than
  burning the budget, because no number of retries will make them deliverable.

A dead-lettered row is:

- **visible** in diagnostics (`GET /api/export/status`, `deadLettered` count);
- **never deleted**;
- **never blocking** the rows behind it (the drain skips it and continues);
- **replayable by hand** with `npm run outbox:replay` (see below).

## Status snapshot (`src/outbox/status.ts`)

`getExportStatus(pool, enabled)` returns a secret-free `ExportStatusSnapshot`:
`enabled`, `connected`, `backlog`, `oldestPendingAgeMs`, `lastSuccessAt`,
`lastError`, `deadLettered`, `publishedTotal`, `attemptsHistogram`. It is consumed
by `src/runtime/statusRoutes.ts` via an injected provider — this module never
imports the HTTP layer.

## Operating

- **Run migrations:** `npm run migrate` (or `npm run migrate -- --check` to assert
  the schema is current without applying).
- **Replay stuck rows:** `npm run outbox:replay` — dry-run by default; `--apply`
  required to write. Selectors: `--dead-letters`, `--aggregate <type> <id>`,
  `--event-id <id>`. Options: `--reset-attempts`, `--drain` (one foreground pass).
  It prints only ids and counts, never a payload.
