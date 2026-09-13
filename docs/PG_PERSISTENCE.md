# Box persistence on PostgreSQL

This note documents how CalSpread's Mongo Box repository was ported onto PostgreSQL as
GTS Box's operational authority, table by table, operation by operation. MongoDB
Atlas becomes an async **reporting replica**, fed by the transactional outbox
(`enqueueOutbox`), never on the execution hot path.

## HTTP CONTRACT CHANGE — closed-today `source` tier label

The `GET /api/box/trades/history?scope=today` response field `source` — the tier that
answered the read — changes its value set:

| Before (CalSpread) | After (GTS Box) |
| --- | --- |
| `"memory" \| "redis" \| "mongo" \| "none"` | `"memory" \| "postgres" \| "none"` |

Upstash Redis is removed as a tier. The in-memory tier is unchanged; the durable tier
is PostgreSQL. `scope=all` likewise reports `source: "postgres"`. A client that switched
on the old literals must be updated: `"redis"` and `"mongo"` no longer occur.

## Identity and readiness

- `allocateBoxTradeId()` mints an opaque 24-hex string (`crypto.randomBytes(12)`), so
  legacy 24-hex ObjectId strings remain importable and `_id` stays opaque.
- `isValidBoxId` accepts any 24-hex string (legacy ObjectId **or** new id).
- `isBoxDbEnabled()` / `isBoxEventLedgerEnabled()` = "PostgreSQL is configured and ready"
  (`isPgReady()`).
- `initBoxConnection()` → `ensureBoxPersistenceReady()`: verifies the pool is up and
  migration 002 has run.

## Redis removal

`pnlCache.ts` and `closedCache.ts` keep their exported surface but drop every
`../redis.js` import. Both were **pure caches** over a durable source; the durable P&L
tier is now `box_daily_pnl` and the complete "closed today" source is
`loadBoxTradesClosedSince`. Each cache reports itself disabled and every method returns
the neutral value it already returned when Redis was unreachable, so the engine
transparently uses PostgreSQL. The pure planning/partitioning helpers are unchanged.

## Outbox provenance

Every mutation that needs a Mongo projection calls `enqueueOutbox(client, …)` on the
SAME `PoolClient` inside the SAME transaction. `eventId` is derived from durable facts
(trade id + discriminator, intent id + audit id, day + trade id, row id) so a retry
upserts instead of duplicating. Every payload carries: `broker`, `charge_origin`,
`charge_rate_version`, `margin_source`, `execution_mode`, the PostgreSQL `source_id`, and
`projection_schema_version`. The writer throws on any secret-bearing key.

## Table-by-table: Mongo operation → SQL

### box_trades  (BoxTrade)
| Repository op | Mongo | PostgreSQL |
| --- | --- | --- |
| `loadOpenBoxTrades` | `find({status:"open"}).sort(opened_at desc)` | `SELECT … WHERE status='open' ORDER BY opened_at DESC` |
| `loadBoxTrades` | `find().sort().limit()` | `SELECT … ORDER BY opened_at DESC LIMIT $1` |
| `loadClosedBoxTrades` | `find({status:{$in}}).select(exclude audit).sort(closed_at desc)` | `SELECT <list cols> WHERE status = ANY($1) [AND closed_at>=$] ORDER BY closed_at DESC NULLS LAST, opened_at DESC LIMIT` |
| `findBoxTradeById` | `findById` | `SELECT … WHERE id=$1` |
| `filterExistingBoxTradeIds` | `find({_id:{$in}},{_id:1})` | `SELECT id WHERE id = ANY($1)` |
| `insertBoxTrade` | `create` (dup key → null) | `INSERT … RETURNING`; unique-violation → null; enqueues `trade_opened` |
| `setBoxTradeMargin` | `updateOne $set margin` | `UPDATE … SET margin RETURNING`; enqueues `trade_margin` |
| `updateBoxTradeLive` | `updateOne $set fields` | `UPDATE … SET <fields>` |
| `setBoxChargeReconciliation` | `updateOne $set` + dotted `computed_by` | `UPDATE` + `jsonb_set(charge doc,'{computed_by}')`; enqueues |
| `closeBoxTrade` | `findOneAndUpdate({_id,status:"open"})` + idempotency read | `UPDATE … WHERE id=$1 AND status='open' RETURNING`; else idempotency SELECT; enqueues `trade_closed` |
| `applyBoxPartialExit` | `updateOne({_id,status:"open"}) $set` | `UPDATE … WHERE id=$1 AND status='open' RETURNING`; enqueues `trade_partial_exit` |
| `deleteBoxTrade` | `deleteOne({_id,execution_mode:{$ne:"live"}})` | `DELETE … WHERE id=$1 AND execution_mode <> 'live'` |
| `applyBoxReconciledProjection` | `updateOne({_id,status:"open"})` | `UPDATE … WHERE id=$1 AND status='open'` |
| `markBoxTradeRecovery` / `markBoxTradeError` | guarded `updateOne` | `UPDATE …` |
| `loadBoxTradesClosedBetween/Since` | `find({status:{$in},closed_at…})` | `SELECT … WHERE status=ANY AND closed_at …` |
| `loadBoxMarginIntervalsSince` | `find($or open / closed_at)` | `SELECT id,opened_at,closed_at,margin WHERE status='open' OR closed_at>=$1` |
| `loadFlatBoxTradeIds` | `find({_id:{$in},status:"closed"})` | `SELECT id WHERE id=ANY AND status='closed'` |

**Uniqueness:** partial unique index `box_open_unique_pair_dir` on
`(broker,underlying,expiry,lower_strike,upper_strike,direction) WHERE status='open'`.

### box_trade_events  (BoxTradeEvent)
| `appendBoxEvent` | `create` (best-effort) | `INSERT … RETURNING id` + enqueue; failure logged/swallowed |
| `loadBoxEvents` | `find().sort(at desc).limit` | `SELECT … ORDER BY at DESC LIMIT $1` |

### box_order_intents  (BoxOrderIntent)  — the CAS core
| `createBoxOrderIntent` | `findOneAndUpdate($setOnInsert, upsert)` | `INSERT … ON CONFLICT (client_order_id) DO NOTHING RETURNING`; else read; `assertIntentImmutableMatch` |
| `findBy…ClientId/BrokerId` | `findOne` | `SELECT … WHERE client_order_id / broker_order_id` |
| `loadNonterminalBoxOrderIntents` | `find({state:{$in}}).sort(updated_at)` | `SELECT … WHERE state=ANY ORDER BY updated_at ASC` |
| `countUnresolvedBoxOrderIntentsForBroker` | `countDocuments` broker-scoped | `SELECT count(*) WHERE broker_mode='live' AND state=ANY AND broker=$2` |
| `loadOwnedBoxOrderIntents` | `find({broker_mode:"live"}).sort(created_at desc)` | `SELECT … WHERE broker_mode='live' ORDER BY created_at DESC` |
| `updateBoxOrderIntent` | `findOneAndUpdate(guards, aggregation `$set` pre-image)` | `SELECT … FOR UPDATE` → validate predecessor map + fill/broker guards → `UPDATE … SET previous_filled_quantity = <locked pre-image>, … RETURNING`; idempotent audit append by `audit_id`; enqueues |

**Uniqueness:** `box_order_intent_client_order_id` (global); `box_order_intent_broker_order_id`
`(broker,broker_order_id) WHERE broker_order_id IS NOT NULL`; `box_order_intent_broker_correlation_id`
`(broker,broker_correlation_id) WHERE … IS NOT NULL`. **Immutability:** BEFORE UPDATE trigger
`box_order_intents_assert_immutable` + in-code `assertIntentImmutableMatch`. **Fill guards:**
CHECK `filled_quantity>=0`, `<=quantity`, `>=previous_filled_quantity`. **Audit:** queryable
`box_order_intent_transitions` with `audit_id` PRIMARY KEY (idempotent replay).

The CAS returns the authoritative **durable** pre/post cumulative filled quantities from
the locked row — never a caller snapshot.

### box_execution_attempts  (BoxExecutionAttempt)
| `insertBoxExecutionAttempt` | `create` (best-effort) | `INSERT … RETURNING` + enqueue |
| `loadBoxExecutionAttempts` | `find().sort(resolved_at desc).limit` | `SELECT … ORDER BY resolved_at DESC LIMIT` |
| `loadUnresolvedBoxExecutionAttempts` | `find({resolved:false [,candidate_key≠recovery]})` | `SELECT … WHERE resolved=false [AND candidate_key<>$2]` (quarantine crash-only until gate ready) |
| `ensureBoxRecoveryExecutionAttempt` | read + `findOneAndUpdate($setOnInsert)` | read + `INSERT … ON CONFLICT (id) DO NOTHING`; unique-violation → adopt winner |
| `applyBoxExecutionAttemptProjection` | `findOneAndUpdate(version/identity/appId guards, aggregation)` | `SELECT … FOR UPDATE` → version/identity/application guards → `UPDATE … RETURNING`; `applied`/`already_applied`/`stale`/`not_found` |
| `loadBoxLiveRiskSeed` | 3 bounded `find().sort().limit` + dedup by `_id` | 3 bounded `SELECT … ORDER BY … LIMIT` + `attemptsById` dedup; `incomplete` on full page |

**Single crash recovery:** partial unique index `box_single_unresolved_crash_recovery`
`(candidate_key) WHERE candidate_key='boot-recovery' AND resolved=false`. The
`BoxRecoveryPersistenceGate` + `boxRecoveryPersistenceValidationError` are ported verbatim;
`establishBoxExecutionAttemptPersistence` verifies the SQL index via `pg_get_indexdef`.

### box_daily_pnl / box_pnl_deletions / box_pnl_day_states
The `run*` protocol functions (`runBoxPnlDayMutation`, `runSourceSafePnlRowUpsert`,
`runBoxPnlDayProofCommit`, `runBoxPnlDayProofRepair`, `runLegacyBoxPnlDayMigration`,
`runIndependentBoxPnlRepairs`, `boxPnlDayProofFromState`, `shouldReproveBoxPnlDay`,
`isArchivedPnlRowInvalid`) are **DB-agnostic** and ported verbatim; the pg layer drives them.
| `rewriteBoxDailyPnlSummary` | scan + `updateOne(upsert summary)` | keyset-paged `SELECT` scan + `INSERT … ON CONFLICT (day,trade_id) DO UPDATE` |
| `upsertBoxDailyPnl` | source-safe handshake + `updateOne(upsert)` | same handshake + `ON CONFLICT (day,trade_id) DO UPDATE` |
| `deleteBoxDailyPnlForTrade` | fence + paged deletes + reproof | `DELETE`/paged `SELECT DISTINCT day` + fence rows + reproof |
| `markBoxDailyPnlComplete` / `…Incomplete` | `updateOne(upsert state)` | `INSERT … ON CONFLICT (day) DO UPDATE` on `box_pnl_day_states` |
| `reconcileBoxDailyPnlOrphans` | 4 keyset-paged passes | 4 keyset-paged `SELECT` passes (`> $after ORDER BY … LIMIT`) |
| `prepareBoxPnlDeletion` / `cancelBoxPnlDeletion` | upsert / delete pending fence | `INSERT … ON CONFLICT DO UPDATE` / `DELETE … WHERE status='pending'` |

### box_settings / box_trading_session / box_calibration_samples
| `loadBoxSettings` / `saveBoxSettings` | `find` / `bulkWrite` (one batch) | `SELECT` / one transaction of `INSERT … ON CONFLICT (key) DO UPDATE` |
| `loadBoxTradingSession` / `saveBoxTradingSession` | `findById("current")` / `updateOne(upsert)` | `SELECT WHERE id='current'` / `INSERT … ON CONFLICT (id) DO UPDATE` (throws on failure) |
| `persistBoxCalibrationSamples` | `insertMany(ordered:false)` | transaction of `INSERT … RETURNING id` + enqueue |
| `loadBoxCalibrationSamples` | `find({region,observed_at≥}).sort.limit` | `SELECT … WHERE region … AND observed_at>=$ ORDER BY observed_at ASC LIMIT` |

## Reservations  (box_reservation_owners + box_reservation_keys)
`PgReservationPort` implements the frozen `DurableReservationPort`. Mongo's UNIQUE
MULTIKEY index over `(deployment,keys)` becomes a normalised child table with
`PRIMARY KEY (deployment_id, broker, instrument_key)`. `insert` writes the owner row and
every key row in ONE transaction — the first conflicting key rolls the whole insert back
(all-or-none). `key_conflict` vs `owner_exists` are distinguished by which constraint
raised. Fences come from `nextval('box_reservation_fence_seq')`; authority time from
`clock_timestamp()`. Renewal is guarded by `owner [+ fence + broker + generation] AND
expires_at > now`; release requires exact owner (+ fence); `deleteExpired` is GC only;
an advisory lock is never the reservation record.

## Tests
`tests/pg/*.test.mjs` run against a real PostgreSQL and fail loudly if it is missing.
Each file uses its own uniquely-named schema (`options=-csearch_path=<schema>`) so files
run in any order. They cover: concurrent CAS (one winner), stale expected state, durable
pre/post fill attribution, illegal predecessor, conflicting broker order id, idempotent
audit replay, the crash windows (before POST / after POST before response / after partial
fill), restart adoption, duplicate-open refusal, all-or-none reservation acquisition,
fencing + renewal, expiry boundary, partial-exit over-close prevention, and one-shot
session survival across restart.
