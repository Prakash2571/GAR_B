# Dead-surface audit — "a claim that nothing verifies"

Auditor pass over the pushed GTS Algo Research backend (`GTSAlgoResearch_B`) hunting the defect class
that produced the two known bugs (the frontend contract drift where every field was
optional, and the Dhan token persisted-but-never-loaded): a surface — a symbol, a status
field, a projected field, an error message — that the 1,613-test green suite never checks,
so it can drift into a lie without failing anything.

Scope of edits made by this pass (everything else is analysis only):

- **Fixed** one misleading error message in `src/kite.ts` (Section D).
- **Deleted** one orphaned function in `src/brokers/dhan/auth.ts` (Section A).
- **Added** `tests/pg/outboxPayloadContract.test.mjs` pinning the projection contract and one
  finding (Section C).
- **This report.**

## Verification

Environment: `DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge`,
`MONGODB_URI=mongodb://127.0.0.1:57017/strikedge_test`.

`npm run build` — green (`tsc -b`, exit 0) after every change.

Final suite counts (0 fail, 0 skipped throughout):

| Suite | Baseline | After this pass |
|-------|----------|-----------------|
| unit | 1477 | 1477 |
| tokens | 47 | 47 |
| access | 19 | 19 |
| switch | 14 | 14 |
| shutdown | 11 | 11 |
| pg | 30 | **37** (+7 new contract tests) |
| projector | 15 | 15 |
| **Total** | **1613** | **1620** |

No suite regressed. The +7 is the new `tests/pg/outboxPayloadContract.test.mjs`.

---

## A. Orphaned code from the extraction

### DELETED — `dhanLoginUrl` (`src/brokers/dhan/auth.ts`)

- **Where it came from.** the predecessor codebase's Dhan browser-consent OAuth flow. There it was called
  once, by `generateDhanConsent` (`.../dhan/auth.ts:171` in the read-only source), which
  returned `{ consentAppId, loginUrl: dhanLoginUrl(consentAppId) }`.
- **Why it is dead now.** This backend neutralised the consent flow: `generateDhanConsent` is a
  throwing stub ("Dhan consent login is disabled in this backend…"). With its only caller
  neutralised, `dhanLoginUrl` had **zero references** anywhere in `src/**` or `tests/**`
  (verified by whole-tree token search). This is exactly the category "functions kept alive
  only by a neutralised OAuth stub."
- **Action.** Removed the function and its now-dead `import { DHAN_AUTH_ROOT }`. Build and all
  suites stay green.
- **Left in place, noted:** `DHAN_AUTH_ROOT` (`src/brokers/dhan/http.ts:28`) is now
  unreferenced (it was `dhanLoginUrl`'s only consumer). Kept deliberately — it is a benign
  host-name **constant** grouped with `DHAN_API_ROOT` and the scrip-master URLs, is not
  executable dead logic, and the CI hostname guard (`.github/ci/no-live-hostnames.sh`, not
  owned by this agent) reasons about those constants. Deleting it would broaden the change
  into a second module's surface for no runtime benefit. Recorded here so it is not a silent
  orphan.

### KEPT — frozen repository surface (Seam 1)

`INTERNAL_SEAMS.md` Seam 1 declares `src/box/repository.ts`'s exported names/signatures
**frozen** — they are the predecessor codebase's surface the 1,488 ported unit tests are written against.
The following are currently unreferenced by `src/**`/`tests/**` but must stay:

| Symbol | Why kept |
|--------|----------|
| `markBoxTradeError` | Documented frozen surface — `docs/PG_PERSISTENCE.md:67`. |
| `loadBoxTradesClosedBetween` | Documented frozen surface — `docs/PG_PERSISTENCE.md:68`. |
| `loadBoxDailyPnl`, `loadBoxDailyPnlTradeIds` | Frozen repository read surface. |
| `isDuplicateKeyError` | Frozen error-classification helper (`"preserved for callers that branch on it"`). |

### KEPT — referenced only by tests (NOT dead)

Per the brief, a symbol referenced only by a test is not dead. The `pnlCache.ts` pure
helpers survived the "REDIS REMOVED" gutting precisely so the ported unit test still
exercises the day-selection/partition logic:

- `buildTradeEvictionPlan`, `indexedTradeDays`, `partitionDayIndex`, `shouldPruneDayIndex` —
  all imported by `tests/box/pnlArchive.test.mjs`. Keep.
- `RedisCommand`, `BoxPnlCache` — used within `pnlCache.ts` / `engine.ts`. Keep.

### KEPT — unreferenced but plausible module API / too ambiguous to delete safely

These exported symbols currently have no consumer in `src/**` or `tests/**`, but deleting
them is not justified by evidence of intent — they are documented API pairs, diagnostic
helpers, or narrow module surfaces. Recorded as candidates rather than removed:

| Symbol | File | Note |
|--------|------|------|
| `enqueueOutboxBatch` | `outbox/writer.ts` | Documented batch sibling of `enqueueOutbox`; intended writer API. |
| `isCheckViolation`, `isRetryableTxError` | `pg/pool.ts` | PostgreSQL error-classification helpers; natural pool surface. |
| `createDisabledTimingRecorder` | `box/executionTiming.ts` | Disabled-recorder factory paired with the enabled one. |
| `zerodhaOnlyLiveAdapterFactory` | `brokers/zerodha/liveAdapter.ts` | Broker adapter factory surface. |
| `historicalQueueDepth` | `kite.ts` | Kite historical-charts diagnostic; this backend does not ship history. |
| `buildChargeLegsFromEvaluations`, `sameChargeLegs` | `box/charges.ts` | Charge-leg helpers. |
| `keysEqual` | `brokerState/tokenCrypto.ts` | Constant-time key compare. |
| `isIstWeekend` | `tokens/istClock.ts`, `isExpiryToday` `box/instruments.ts`, `isFeedUsable` `brokers/feedHealth.ts`, `laneLabel` `brokers/marketDataLane.ts`, `isPaperExecutionMode` `box/types.ts` | Small pure predicates. |
| Type-only exports: `BoxMetricsSnapshot`, `BoxTouch`, `CoordinationState`, `EXECUTION_MODE(S)`, `HistoryInterval`, `IBoxCalibrationSample`, `IBoxPnlDayState`, `IBoxPnlDeletion`, `LatencyComponent`, `_BoxChargeProofs` | various | Declared types / compile-time proofs; removing risks the `AssertAssignable` proofs (`model.ts`) and interface surfaces. |

If a future cleanup wants these gone, do it as a dedicated dead-code sweep with the module
owners; an auditor pass should not guess intent on 30 low-risk symbols.

### Config knob wired to an inert feature (degraded, not dead) — `pnlCacheEnabled`

`src/box/config.ts` reads `BOX_PNL_CACHE_ENABLED` → `cfg.pnlCacheEnabled`, and `pnlArchive.ts`
gates a mirror scheduler on it. But `BoxPnlCache` is the "REDIS REMOVED" no-op (`enabled()`
always `false`, `writeSnapshot()` a no-op). So `pnlCacheEnabled=true` now schedules a
mirror against an inert cache. Not deleted — the knob defaults to `false`, the archiver's
durable PostgreSQL path is independent of it, and `pnlCache.ts` documents the removal
honestly. **But the config comment is a stale claim (see Section D / note below).**

---

## B. Fields the backend sends that nothing consumes (and vice versa)

### Health booleans — all real, read the code that computes each

- `database_healthy` = `isBoxDbEnabled() && (!live || live.health.persistence === "healthy")`.
  `isBoxDbEnabled()` → `isPgReady()` (`repository.ts:277`). **Reflects PostgreSQL, not Mongo.** ✓
- `market_data_healthy` = `isFeedHealthy()` (`engine.ts:1963`): market-open AND a raw tick
  within `feedMaxAgeMs`. `lastRawTickAt` is fed by the ACTIVE broker's feed. ✓
- `broker_auth_healthy` = `live.health.broker_auth === "healthy"` from the order manager,
  which tracks the ACTIVE broker's auth. ✓
- `hub_subscribed` / `hub_connected` = `brokerManager.subscribedCount()` /
  `feedConnected()` (`index.ts:283–284`). These map to the active broker's real feed state —
  **not** a stranded constant from the removed the predecessor codebase SSE hub. ✓

No misleading always-constant status field was found in the sampled extraction-affected
fields (redis/mongo/hub/analytics/calendar/subscriptions/market-data-session names).

### `margin_source` gap — CONFIRMED ACCURATE (not fixed, per instruction)

The claim in `docs/EXTRACTION_MANIFEST.md:330–338` is correct:

- **Projected to Mongo:** yes — `repository.ts:548`, `tradeProjectionPayload` sets
  `margin_source: trade.margin == null ? "unknown" : "broker"`. (Derived at projection time.)
- **Absent from every HTTP response:** yes — `src/box/serialize.ts` carries `margin`
  (the raw object, line 65) but **not** the `margin_source` provenance label; no route adds it.
  `registry.ts` exposes a *different* `last_margin_source` diagnostic, not the trade's field.
- **Left untouched** as instructed. Recorded only to confirm the documented finding holds.

---

## C. The outbox payload contract

`enqueueOutbox` is called from **5** aggregate-producing sites in `src/box/repository.ts`
(the 6th allow-listed aggregate is discussed below). Per-aggregate provenance, read from the
code and pinned by the new `tests/pg/outboxPayloadContract.test.mjs` against real PostgreSQL:

| Aggregate | Call site | source_id | broker | broker gen. | charge_origin | charge_rate_version | margin_source | execution_mode | schema_version |
|-----------|-----------|:---------:|:------:|:-----------:|:-------------:|:-------------------:|:-------------:|:--------------:|:--------------:|
| `box_trade` | `repository.ts:525` (`tradeProjectionPayload`) | ✅ | ✅ | n/a¹ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `box_trade_event` | `repository.ts:1027` (`appendBoxEvent`) | ✅ | ✅ | n/a¹ | — ² | — ² | — ² | ✅ | ✅ |
| `box_order_intent` | `repository.ts:1225` (`enqueueIntentProjection`) | ✅ | ✅ | via `broker_mode`³ | — ² | — ² | — ² | ✅ | ✅ |
| `box_execution_attempt` | `repository.ts:1593` (`enqueueAttemptProjection`) | ✅ | ✅ | n/a¹ | ✅ (null by design⁴) | ✅ | (spread⁵) | ✅ | ✅ |
| `box_calibration_sample` | `repository.ts:2924` (`persistBoxCalibrationSamples`) | ✅ | ✅ | n/a¹ | — ² | — ² | — ² | — ² | ✅ |

¹ Broker *generation* is a switch-fencing counter on reservations/leases; these aggregates are
  single-broker records that do not carry it. "Where relevant" is satisfied — generation lives
  on the durable reservation record (`box/reservations/durable.ts`), not on the trade/event.
² Not relevant to this aggregate (an immutable decision snapshot, an intent, or a latency
  sample does not carry charge/margin provenance). Not a defect.
³ The intent carries `broker_mode` (paper|live) and maps it to `execution_mode`.
⁴ `charge_origin: null` is set explicitly — an execution *attempt* has no charge origin. The
  key is present so the shape is stable; the test asserts the key exists.
⁵ `box_execution_attempt` spreads `...attempt`, so `margin_source` appears only if the attempt
  record itself carries one. The required *provenance* (source_id/broker/rate_version/mode/
  schema) is always present.

**Universal invariants** (`source_id`, `broker`, `projection_schema_version` matching the
outbox row's `schema_version`) are asserted for every aggregate in the new test. Result:
**all 5 live-projected aggregates satisfy the contract.** No missing-field defect found in the
projected aggregates.

### FINDING (C) — `box_daily_pnl` is a projected aggregate that is never projected

`box_daily_pnl` is:

- allow-listed in `OUTBOX_AGGREGATES` (`src/outbox/writer.ts:31`),
- collection-mapped in `src/outbox/mongo.ts:29` (`box_daily_pnl → box_daily_pnl`),
- listed as a projected collection in `docs/MONGO_PROJECTION.md`,
- claimed by `src/box/config.ts:759–769` to be "drained into the `box_daily_pnl` Mongo
  collection once a night."

But **no live write path enqueues it.** Every daily-P&L write — `upsertDailyPnlRow`
(`repository.ts:2756`) and `rewriteBoxDailyPnlSummary` (`repository.ts:2323`) — goes through
plain `query(...)` / `mutateDurablePnlDay`, never `enqueueOutbox`. The only code that ever
populates the Mongo `box_daily_pnl` collection is the **one-off legacy import**
(`src/scripts/migrateBoxFromMongo.ts`). So ongoing daily P&L reaches PostgreSQL but **never**
the reporting replica, contradicting the doc/config/allow-list claim.

This is precisely the audited defect class: a claim (doc + allow-list + config comment) that
nothing verified. It is **pinned** by the last test in `outboxPayloadContract.test.mjs`, which
proves a daily-P&L archive write produces **zero** `box_daily_pnl` outbox rows.

**Not "fixed" by adding a projection**, deliberately: whether daily P&L *should* reach the
Mongo reporting replica in this backend (where PostgreSQL is authoritative and holds the durable
`box_daily_pnl` archive + day-proof) is a product decision for the module owners, not an
auditor's unilateral behaviour change. The config comment (`config.ts`) additionally describes
a predecessor-era Redis-mirror-then-nightly-Mongo-drain flow that no longer exists (Redis
removed); it is a stale claim. `config.ts` is owned by this agent's editable surface, but the
correct remedy (project daily_pnl, or drop it from the allow-list/doc/config claim) is a
decision, not a mechanical fix — flagged here for an explicit follow-up.

---

## D. Error paths that cannot work

### FIXED — `src/kite.ts` `authHeader()` pointed operators at a dead `/login` flow

- **The bug.** `authHeader()` threw, on any unauthenticated Kite API call:
  `"Not authenticated. Complete the Zerodha login flow first (/login)."`
- **Why it cannot work.** GTS Algo Research removed the Zerodha OAuth login entirely
  (`index.ts:7`: "the Zerodha OAuth login … is gone"); there is **no `/login` route**
  (verified: zero matches for a `/login` handler in `src/**`). The token is provisioned by
  the external CalSpread token acquisition service and installed via `installProvidedToken`. The
  message sent an operator to a flow that does not exist — the exact sibling of the fixed
  "set MONGODB_URI when PostgreSQL was the real cause" scanner-start bug. `generateSession`
  right beside it was correctly updated at extraction; `authHeader` was missed.
- **Provenance.** Confirmed the string is copied unchanged from the predecessor codebase
  (`Cal_Spread_Backend/src/kite.ts:469`), where `/login` was a real route
  (`KITE_LOGIN_ROOT = https://kite.zerodha.com/connect/login`). No GTS Algo Research test pins the
  string.
- **Fix.** Rewrote the message to state the real cause and the real remedy: the token is
  installed by the token acquisition service, this backend has no interactive login flow, and
  the operator should watch `GET /api/runtime/status`. HTTP status unchanged (401).

### JUDGED CLEAN — no second-error-while-handling-first, other subsystem strings are honest

- Scanner-start refusals (`engine.ts:1382`): the PostgreSQL-not-Mongo message is already the
  fixed version, pinned by `tests/box/scannerStartRefusals.test.mjs`. ✓
- `generateSession` (`kite.ts`) / `generateDhanConsent` + `consumeDhanConsent`
  (`brokers/dhan/auth.ts`): throwing stubs whose messages correctly name the external CalSpread token
  provider as the source of truth. ✓
- The many Redis/Mongo mentions in `box/pnlCache.ts`, `box/closedCache.ts`, `box/config.ts`,
  `box/engine.ts` comments are **doc comments describing the removal**, not user-facing error
  strings, except the `config.ts` daily-P&L drain comment noted under Section C as a stale
  claim. `index.ts:697` and `outbox/*` mongo strings are accurate (Mongo *is* the reporting
  replica). No catch block was found that references a removed symbol or throws a second error
  while handling the first.

---

## Summary of deliberate non-actions

- `margin_source` HTTP gap — confirmed accurate, left untouched (instructed).
- 30 unreferenced-but-frozen/type/ambiguous exports — kept with reasons (Section A).
- `DHAN_AUTH_ROOT` constant — kept (benign host constant, CI guard reasons about it).
- `box_daily_pnl` non-projection and the stale `config.ts` drain comment — **pinned by test
  and reported**, not silently "fixed", because projecting it (or retracting the claim) is a
  product decision for the owners.
