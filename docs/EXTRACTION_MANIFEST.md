# GTS Algo Research extraction manifest

This is the authoritative record of how GTS Algo Research was extracted from the predecessor codebase:
what was copied, what was adapted, what was deliberately left behind, and every
contract that changed. It is generated against the source trees and verified
against the target code, not from memory.

## 1. Commit SHAs

| Repo | Role | SHA |
| --- | --- | --- |
| `Cal_Spread` | the predecessor codebase frontend (source, READ ONLY) | `3ac5abe07a9e580a0ecc0c8c173aff7dff346184` |
| `Cal_Spread_Backend` | the predecessor codebase backend (source, READ ONLY) | `803ffe58a25d5ad5d42023d8c063d419b058da56` |
| `GTSAlgoResearch_B` | GTS Algo Research backend (target) | `9a305888479ddd775b9c46e21624e1fc5e90850e` — the first `main` push |
| `GTSAlgoResearch_F` | GTS Algo Research frontend (target) | `0230bcecb947e6f9328b9a5403c6f08a644c7e93` — the first `main` push |

Those two target SHAs are the commits at which the whole extraction was verified green:
backend `npm run build` clean, 1,594 tests passing across seven suites with zero failures
and zero skips, both repositories building from clean checkouts. Only this manifest
paragraph changed afterwards, which is why its own commit is one ahead of the SHA it
names.

## 2. Copied source files

Classification is mechanical: each `src/**` file in the target was compared with
`Cal_Spread_Backend/src/<same path>` using `diff -q`. Identical ⇒ **verbatim**;
present-but-different ⇒ **adapted**; absent in source ⇒ **new**.

### 2a. Copied verbatim (byte-for-byte identical to source)

These carry the predecessor codebase's behaviour unchanged. The Box strategy core — the
mathematics, execution simulation, calibration, order lifecycle, reservations
port, charge cards and broker adapters — is here, which is why the migration
fixtures still pin the same numbers.

```
boundedCache.ts, hub.ts, indexSpot.ts, marketDataSession.ts, ratelimit.ts,
shutdown.ts, ticker.ts, trackedTimers.ts

box/LIVE_EXECUTION.md, box/boxCapital.ts, box/brokerAdapter.ts,
box/brokerContext.ts, box/brokerPacing.ts, box/brokerTimingStore.ts,
box/calibratedLatencySource.ts, box/calibrationPersistence.ts,
box/chargeReconciler.ts, box/charges.ts, box/config.ts, box/dhanBrokerAdapter.ts,
box/entrySubmissionOrder.ts, box/executionAttemptProjection.ts,
box/executionCalibration.ts, box/executionClock.ts, box/executionCoordinator.ts,
box/executionEnvironment.ts, box/executionFaults.ts, box/executionGateway.ts,
box/executionOutcomes.ts, box/executionPolicy.ts, box/executionSchedulingPolicy.ts,
box/executionShortfall.ts, box/executionSimulator.ts, box/executionTiming.ts,
box/instrumentKey.ts, box/instrumentReservations.ts, box/instruments.ts,
box/kiteBrokerAdapter.ts, box/latencyModel.ts, box/latencySource.ts,
box/legExecutor.ts, box/liquidityLedger.ts, box/liveEntryGuard.ts,
box/liveModeTransition.ts, box/localCharges.ts, box/marginReplay.ts, box/math.ts,
box/metrics.ts, box/orderLifecycle.ts, box/orderManager.ts, box/orderPricing.ts,
box/pairedComparison.ts, box/paperLegTimeline.ts, box/paperScheduler.ts,
box/parityReport.ts, box/partialEntryRecovery.ts, box/partialExitPnl.ts,
box/pnlArchive.ts, box/pnlSnapshot.ts, box/positionMonitor.ts, box/positions.ts,
box/queueCalibration.ts, box/quotes.ts, box/residualFlatten.ts, box/scanner.ts,
box/serialize.ts, box/shadowMode.ts, box/singleLotInvariant.ts, box/stressProfile.ts,
box/tradingSession.ts, box/tradingSessionStore.ts, box/types.ts, box/underlyingLock.ts

box/reservations/chained.ts, box/reservations/core.ts, box/reservations/durable.ts,
box/reservations/identity.ts, box/reservations/inProcess.ts,
box/reservations/memoryStore.ts, box/reservations/port.ts, box/reservations/types.ts

brokers/boardDiagnostics.ts, brokers/dhan/charges.ts, brokers/dhan/client.ts,
brokers/dhan/correlation.ts, brokers/dhan/errors.ts, brokers/dhan/feed.ts,
brokers/dhan/feedDecoder.ts, brokers/dhan/http.ts, brokers/dhan/instruments.ts,
brokers/dhan/segments.ts, brokers/feedHealth.ts, brokers/instrumentProvider.ts,
brokers/marketDataLane.ts, brokers/quoteProvider.ts, brokers/subscriptions.ts,
brokers/types.ts, brokers/zerodha/feed.ts, brokers/zerodha/liveAdapter.ts
```

### 2b. Copied and adapted (what changed, one line each)

| File | What changed |
| --- | --- |
| `box/repository.ts` | The whole Mongo/Mongoose repository was rewritten onto PostgreSQL (`UPDATE … RETURNING`, `SELECT … FOR UPDATE`, `ON CONFLICT`, transactional outbox enqueue). Behaviour preserved; storage completely different. See §5. |
| `box/model.ts` | Mongoose schemas/models replaced by PostgreSQL row types and (de)serialisation; opaque `_id` strings preserved so legacy ids stay importable. |
| `box/pnlCache.ts` | **Redis removed.** The Upstash day-P&L mirror is gone; every method degrades to the neutral value it already returned when Redis was down. Pure planning/partitioning helpers unchanged; exported surface preserved so no caller changed. |
| `box/closedCache.ts` | **Redis removed.** The Upstash "closed today" mirror is gone; the cache reports itself disabled and reads fall through to PostgreSQL (`loadBoxTradesClosedSince`). Exported surface preserved. |
| `box/engine.ts` | Small wiring changes to consume the PostgreSQL persistence/closed-today path instead of Mongo+Redis (~14 lines). Strategy logic unchanged. |
| `box/index.ts` | `registerBoxModule` wiring adjusted for this backend's collaborators and the new persistence readiness (~19 lines). |
| `box/routes.ts` | Trades-history `source` tier label changed to `"postgres"`; SSE stream (`/api/box/stream`) now guarded by the cookie-session `requireOperator` middleware instead of a query-string token; auth wiring for the new access model. |
| `box/reservations/index.ts` | Factory now assembles the PostgreSQL-backed `PgReservationPort` instead of the Mongo store (~10 lines). |
| `brokers/registry.ts` | 2-line adjustment (broker wiring); effectively verbatim. |
| `brokers/dhan/auth.ts` | Present but the OAuth/login path is dead in this backend (tokens come from the external CalSpread provider); retained only so shared types compile. Not on any live path. |
| `kite.ts` | Trimmed to the Box-relevant client surface (charges, basket margin, order ops, instruments); calendar/history/analytics helpers dropped (~94 lines). |
| `index.ts` | **Fully replaced** — see §3. The 5,500+ line the predecessor codebase entrypoint became a small Box-only bootstrap; ~6,000 lines differ. |

### 2c. New files (no source counterpart)

```
config.ts                         (app config + deployment gates)
boxSupport.ts                     (the collaborators the predecessor codebase's index.ts injected — see §4)
brokerRoutes.ts                   (broker status / switch-blockers / select)
runtime/statusRoutes.ts           (GET /api/runtime/status, /api/export/status)

access/cookies.ts, access/csrf.ts, access/middleware.ts, access/rateLimit.ts,
access/routes.ts, access/sessionStore.ts     (site-passcode session gate)

brokerState/tokenCrypto.ts, brokerState/brokerSessions.ts   (AES-256-GCM token store)

tokens/brokerTokenService.ts, tokens/tokenProviderClient.ts, tokens/istClock.ts
                                  (morning token acquisition from the external CalSpread provider)

pg/pool.ts, pg/migrate.ts         (PostgreSQL authority)
box/reservations/pgStore.ts       (PostgreSQL reservation port)

outbox/writer.ts, outbox/mongo.ts, outbox/projector.ts, outbox/status.ts
                                  (transactional outbox → Mongo reporting replica)

scripts/migrate.ts, scripts/migrateBoxFromMongo.ts, scripts/outboxReplay.ts,
scripts/rotateBrokerTokenKey.ts

types/charges.ts
```

## 3. Intentionally excluded source files

Each of the following exists in `Cal_Spread_Backend/src` and is **absent** from
the target on purpose (verified: all present in source, all absent in target
except `index.ts`, which was replaced in place).

| Source file | Why excluded |
| --- | --- |
| `index.ts` | **Replaced.** the predecessor codebase's entrypoint bundled calendar spreads, analytics, OI capture, Yahoo dividends and admin/token routes into one file. this backend's `index.ts` is a Box-only bootstrap; the injected collaborators moved to `boxSupport.ts` (§4). |
| `db.ts` | **Replaced by PostgreSQL.** Mongoose connection management is gone; `pg/pool.ts` is the operational authority. |
| `redis.ts` | **Upstash removed.** The analytics/P&L Redis caches do not exist in this backend; durable state is PostgreSQL. |
| `eodCapture.ts` | End-of-day F&O capture is a calendar-scanner feature, out of scope. |
| `hourlyCapture.ts` | Intraday OI/chain capture is a calendar-scanner feature, out of scope. |
| `yahoo.ts` | Yahoo dividend feed is out of scope. |
| `marketDataRoutes.ts` | The market-data recorder endpoints (calendar analytics) are out of scope. |
| `adminToken.ts` | Full-admin token auth replaced by the site-passcode session (`access/*`). |
| `tokenRouteAuth.ts` | GTS Algo Research hosts no token routes; it is a **client** of the external CalSpread routes, so the route-auth guard is unneeded. |
| `brokers/history.ts` | Historical charts/candles are out of scope. |
| `brokers/routes.ts` | The calendar broker routes (login/history/market-data) are replaced by this backend's Box-only `brokerRoutes.ts`. |
| `box/reservations/mongoStore.ts` | The Mongo durable reservation store is replaced by `box/reservations/pgStore.ts` (PostgreSQL). |

## 4. Collaborators the predecessor codebase's `index.ts` passed to `registerBoxModule`

In the predecessor codebase these were closures defined inside the monolithic `index.ts`. In
GTS Algo Research the pure ones live in **`src/boxSupport.ts`** (verbatim ports — the
board derivation, IST arithmetic, market-hours window and charge folding are
byte-for-byte, pinned by the migration fixtures), and the stateful ones are
supplied by the broker registry / access layer.

| Dependency (arg to `registerBoxModule`) | Where it lives now |
| --- | --- |
| `istDayKey` | `boxSupport.ts` (verbatim IST day-key). |
| `isMarketOpen` | `boxSupport.ts` (verbatim NSE hours window). |
| `makeIdResolver` | `boxSupport.ts` (token → `EXCHANGE:SYMBOL`). |
| `getBoard` / `deriveFnoBoard` | `boxSupport.ts` (F&O board derivation, verbatim). |
| `priceChargeGroups` / `makePriceChargeGroups` | `boxSupport.ts` (Zerodha virtual-contract-note batching). |
| `getBasketMargin` | `kite.ts` client, invoked from `index.ts`. |
| `getAllInstruments` | `brokers/registry.ts` (`brokerManager.instruments()`). |
| `kite` / `tickerHub` / `feed.*` | `brokers/registry.ts` (active-broker market-data lane and the dedicated Box feed). |
| `charges` (active-broker fee schedule) | `brokers/registry.ts` — `LocalChargeCalculator` (Zerodha) or the Dhan charge calculator. |
| `createLiveAdapter` | `brokers/registry.ts` — refuses to build an adapter for any but the active broker. |
| `activeBroker` / `brokerGeneration` | `brokers/registry.ts` — stamped on reservations and re-checked before execution. |
| `requireOperator` / `getOperatorRole` | `access/middleware.ts` — the site-passcode session replacing admin-token auth. |

## 5. Mongo repository operations replaced by PostgreSQL

The full table-by-table, operation-by-operation mapping is in
**`docs/PG_PERSISTENCE.md`** and is not duplicated here. In summary:

- **`box_trades`** — `create`/`findOneAndUpdate` → `INSERT … RETURNING` /
  `SELECT … FOR UPDATE` + `UPDATE … RETURNING`; unique-violation → null.
- **`box_trade_events`** — append-only inserts, idempotent by audit id.
- **`box_order_intents`** (the CAS core) — Mongo `findOneAndUpdate` guards →
  `SELECT … FOR UPDATE` + validated predecessor/fill/broker guards +
  `UPDATE … SET previous_filled_quantity = <locked pre-image> … RETURNING`, with
  an in-DB immutability constraint and in-code `assertIntentImmutableMatch`.
- **`box_execution_attempts`** — version/identity/application-guarded projection
  via `SELECT … FOR UPDATE` + `UPDATE … RETURNING` returning
  `applied`/`already_applied`/`stale`/`not_found`.
- **`box_daily_pnl` / `box_pnl_deletions` / `box_pnl_day_states`,
  `box_settings` / `box_trading_session` / `box_calibration_samples`** — mapped to
  their PostgreSQL tables (see the doc).
- **Reservations** — Mongo's UNIQUE MULTIKEY `(deployment, keys)` index becomes a
  normalised `box_reservation_owners` + `box_reservation_keys` pair implementing
  the frozen `DurableReservationPort`.
- Every mutation that needs a Mongo projection enqueues an **outbox** row on the
  same transactional `client`, which is what makes the projection transactional
  rather than best-effort.

## 6. Redis-backed features replaced or removed

the predecessor codebase used Upstash Redis (`src/redis.ts`) for analytics caches and two Box
caches. **GTS Algo Research removes Redis entirely.**

| the predecessor codebase Redis feature | GTS Algo Research |
| --- | --- |
| Analytics OI/chain caches | **Removed** — the analytics feature is out of scope. |
| `box/pnlCache.ts` — day-P&L mirror | **Redis removed.** Was always best-effort (durable correctness was in Mongo). The durable P&L tier is now PostgreSQL (`box_daily_pnl` + day-state proof). Every method degrades to its old neutral value; the pure planning helpers and the exported surface are unchanged so no caller changed. |
| `box/closedCache.ts` — closed-today mirror | **Redis removed.** Was always a read-path accelerator. The complete source for "closed today" is now PostgreSQL (`loadBoxTradesClosedSince` / `engine.getClosedToday`); the cache reports itself disabled and reads fall through. |

## 7. HTTP / SSE contract changes

Verified against `src/box/routes.ts`, `src/access/routes.ts`,
`src/runtime/statusRoutes.ts`, `src/brokerRoutes.ts` (target) and
`Cal_Spread_Backend/src/index.ts` (source).

### Changed

- **Trades-history `source` tier label.** Was `"memory" | "redis" | "mongo" |
  "none"`; is now `"memory" | "postgres" | "none"` (`src/box/routes.ts` reports
  `"postgres"`; also documented in `docs/PG_PERSISTENCE.md`).
- **SSE authentication.** The Box event stream `GET /api/box/stream` no longer
  accepts a query-string token; it is guarded by the HttpOnly, same-origin
  cookie session via the `requireOperator` middleware (401 without a valid
  session).
- **Admin auth → site passcode session.** the predecessor codebase's `/api/admin/verify` /
  admin-token model is replaced by the site-passcode session in `access/*`.

### New endpoints

```
GET  /api/runtime/status        (src/runtime/statusRoutes.ts)
GET  /api/export/status         (src/runtime/statusRoutes.ts)
POST /api/access/verify         (src/access/routes.ts)
GET  /api/access/status         (src/access/routes.ts)
POST /api/access/logout         (src/access/routes.ts)
GET  /api/broker/status         (src/brokerRoutes.ts)
GET  /api/broker/switch-blockers(src/brokerRoutes.ts)
POST /api/broker/select         (src/brokerRoutes.ts)
```

The Box endpoints (`/api/box/*`: status, config, opportunities, chains, trades,
trades/open, trades/history, execution-*, session arm/disarm, live
reconcile/cancel-working/flatten, stream, events, trades/:id/close) are carried
over.

### Removed endpoints

All of the predecessor codebase's non-Box surface is gone. Verified present in the source
`index.ts` and absent from the target:

```
/api/login, /api/logout, /api/profile, /api/session, /api/status,
/api/admin/status, /api/admin/verify, /api/access/verify (old admin form),
/api/kite/access-token, /api/kite/token, /api/internal/kite-token, /api/rf,
/api/rf/current, /api/instruments, /api/debug/indices,
/api/fno-board, /api/fno-stocks, /api/fno-stocks/:symbol,
/api/history/:symbol, /api/intraday/:symbol, /api/minute/:symbol,
/api/fivemin/:symbol, /api/dividends, /api/spread-history/:symbol,
/api/spread-stats/:symbol, /api/option-chain/:underlying,
/api/option-oi-frame/:underlying, /api/option-oi-series/:underlying,
/api/option-oi-baseline/:underlying, /api/option-prev-close/:underlying,
/api/futures-oi-frame/:underlying, /api/trades, /api/trades/:id,
/api/trades/:id/close  (calendar trades)
```

That is: every calendar, analytics, history, market-data, Dhan-login and admin
route. GTS Algo Research hosts **no token routes** — it is a client of the external CalSpread routes.

## 8. Known behaviour differences

- **PostgreSQL is required to boot.** the predecessor codebase degraded gracefully with no
  Mongo (trades feature off); GTS Algo Research refuses to start without `DATABASE_URL`
  because PostgreSQL is the operational authority.
- **Mongo is now optional and read-only.** With no `MONGODB_URI`, GTS Algo Research runs
  fully; only the reporting projection is skipped. In the predecessor codebase, Mongo was the
  store of record.
- **No Redis warm-load.** A restart no longer warm-loads caches from Redis; the
  durable read comes straight from PostgreSQL, so the first read after boot is a
  DB query rather than a cache hit. Correctness is identical; latency profile
  differs.
- **No broker OAuth.** GTS Algo Research cannot log a user into Zerodha/Dhan; it depends
  on the external CalSpread token routes being reachable each morning. If that provider is down
  at 09:00 IST, this backend has no token until it recovers.
- **Single active broker.** Exactly one of Zerodha/Dhan is active; switching is
  explicit and blocker-gated. the predecessor codebase's broker handling differed.
- **Auth model.** One site passcode + runtime arming replaces the two-tier
  admin/access secrets. The passcode grants UI access only and arms nothing.
- **Multi-worker safety** now rests on the PostgreSQL durable reservation tier
  and globally-unique owner ids rather than a Mongo unique index.
- **Two scanner-start refusal messages were corrected.** `BoxEngine.start()`
  refuses for two reasons and both messages were inherited from the predecessor codebase, where
  they were true, and were wrong here:
  - *"Box persistence is not configured (set MONGODB_URI)"* → now names
    PostgreSQL, `DATABASE_URL` and `GET /api/runtime/status`. `isBoxDbEnabled()`
    resolves to `isPgReady()`, so PostgreSQL is the only thing that can trip that
    branch; MongoDB Atlas is an asynchronous reporting replica whose absence must
    never block the scanner. The old text would have sent an operator to debug the
    wrong database while the authoritative store was down.
  - *"Connect to Zerodha before starting the box scanner"* → now names the ACTIVE
    broker, so a Dhan-active deployment no longer displays an instruction about a
    broker it is not using.

  This is a behaviour change in operator-facing copy only — no gate, threshold or
  code path moved, and the refusal conditions are unchanged. Pinned by
  `tests/box/scannerStartRefusals.test.mjs` so neither can silently regress.

## 8a. Frontend/backend contract drift, found and fixed

The two repositories were built separately and their types for the NEW GTS Algo Research
endpoints drifted badly. Verified by capturing real responses from a running
backend and comparing them with the frontend's declarations:

| Endpoint | Frontend fields that actually arrived |
| --- | --- |
| `GET /api/runtime/status` | 1 of 9 (`residual_exposure`) |
| `GET /api/export/status` | 1 of 5 (`enabled`) |
| `GET /api/broker/status` | structurally different — the frontend expected a single predecessor-shaped broker; the backend returns `{active_broker, generation, brokers[]}` |

`blockers` is `string[]`, not `{reason, detail}[]`. `POST /api/broker/select`
returns `{ok, broker, blockers}`, not a status object. `last_margin_source`
existed **nowhere** in the backend — the frontend had invented it.

Every drifted field was either optional or read off a cast `fetch` result, so
TypeScript could not see any of it. The frontend typechecked, built and passed 38
tests while every readiness banner stayed dark and the broker panel rendered
`undefined`. **A green build proved nothing about the contract.**

Fixed by making the frontend types exact (which turned the drift into compiler
errors) and rewiring the banners and the broker panel. Pinned by
`GTSAlgoResearch_F/tests/apiContract.test.mjs`, which asserts against responses captured
from a running backend and was verified to fail when the old shape is restored.
Fixture provenance and the re-capture procedure are in
`GTSAlgoResearch_F/tests/fixtures/README.md`.

Two states the old shape could not express are now shown: a token-provider
**configuration error** (fatal — retrying on a timer will never clear it, so it is
not the same as "waiting") and **dead-lettered projections**. And
`live_entry.reasons` is now displayed, so "live entry is blocked" says why.

### Margin provenance is now persisted and served

The margin source (`kite_basket` / `dhan_multi` / `dhan_per_leg_fallback` /
`unavailable`) is persisted on `box_trades.margin_source` (migration
`008_trade_margin_source.sql`), projected to MongoDB, exposed on the serialised
trade, and displayed on the dashboard.

This closes a real gap rather than a cosmetic one. `margin` stored a single number
and nothing recorded which model produced it, even though the models are not
interchangeable: `kite_basket` and `dhan_multi` are position-aware netted figures,
while `dhan_per_leg_fallback` is a summed per-leg **upper bound** that materially
over-states a hedged four-leg Box. `src/box/engine.ts` warned on the console when it
fell back, and its own comment stated the problem: *"Only `res.total` is persisted,
so once stored an inflated per-leg sum is indistinguishable from a real basket
margin — and it is plausible enough to go unnoticed."* The specification requires
the opposite: *"Never silently use Dhan per-leg margin as if it were hedge-adjusted
basket margin. Persist the margin source."*

The outbox payload had additionally **derived** `margin_source` as
`margin === null ? "unknown" : "broker"`, which recorded only whether a number
existed — so the projected history could not distinguish two figures that differ by
roughly an order of magnitude. It now carries the real model name.

`NULL` is meaningful and is the default for pre-existing rows: it means "recorded
before provenance was captured", which is deliberately distinct from `unavailable`
("asked, and got nothing"). Back-filling a guess would manufacture provenance that
was never observed. Covered by `tests/pg/marginProvenance.test.mjs` (7 tests),
including that an omitted source never erases provenance a previous write recorded.

### `DHAN_DATA_ENABLED` defaults true, deliberately

Every other Dhan gate defaults false, so this looks asymmetric. It is intentional
and is preserved byte-for-byte from the predecessor codebase: `dhanDataEnabled()` treats an unset
value as **true** because it gates only quote/instrument access, which cannot place
an order, whereas `dhanLiveTradingEnabled()` treats an unset value as **false**
because it gates real orders. Verified by diffing both predicates against
`Cal_Spread_Backend/src/brokers/registry.ts` — identical. Changing it would be an
unrequested behavioural divergence from the source, so it stands.

## 8b. Box math parity, verified by regeneration

The 22 golden fixtures under `tests/migration-fixtures/` (113 cases: 42 in
`box/`, 71 in `box-parity/`) are **byte-for-byte identical** to the predecessor codebase's
baseline, generators included.

That alone only proves the files were copied. The stronger check was also run:
`tests/migration-fixtures/generate.mjs` and `generate-parity.mjs` were executed
against **this backend's own compiled build**, which rewrites every fixture from the
live implementation. The regenerated output is byte-identical to the predecessor codebase's
baseline.

So the persistence layer moved from Mongoose to `pg`, the reservation store was
reimplemented, Redis was removed and the entrypoint was rewritten — and the
candidate economics, charges, direction selection, exit economics, order pricing,
position-state derivation, quote evaluation, slippage, bounded-limit walking,
cumulative-fill ledger, implementation shortfall, latency sourcing, liquidity
ledger, order-lifecycle staging, paper scheduling, queue calibration, structured
latency and time-of-day bucketing all still produce the same numbers.

Regenerating a fixture remains a deliberate act: a changed fixture means trading
behaviour changed, and that is a finding rather than a chore.

## 9. The unavoidable four-leg broker risk

A Box is four option legs. **A four-leg Box entry is NOT atomic at Zerodha or at
Dhan.** Neither broker offers an all-or-nothing multi-leg primitive, so between
the first accepted leg and the fourth there is a real, unavoidable window in
which the position is partially on.

GTS Algo Research **bounds** that exposure — it does not eliminate it:

- **Hedge-first submission ordering** submits the legs that reduce risk before
  the legs that add it, so a partial fill leans safe rather than naked.
- **Durable order intents** in PostgreSQL are written before the broker POST and
  drive deterministic recovery/residual-flatten after a crash or a rejected leg,
  so the system always knows what it tried and can reconcile it.

These make a partial entry *survivable and recoverable*. They cannot make four
independent broker acknowledgements happen simultaneously, and they cannot
prevent a broker-side reject, timeout or ambiguous submit from leaving a residual
leg that must be flattened at whatever the market then offers.

**No test result in this repository may be read as proof of real-money safety.**
The tests prove the *logic* is deterministic, the recovery paths fire, and the
gates hold. Real capital adds broker latency, partial fills, rejects, feed gaps
and slippage that no simulation fully reproduces. Live trading is enabled only
behind the double deployment gates, the per-broker gate and explicit runtime
arming — and even then the four-leg risk above remains inherent to the strategy.

## 10. Test hermeticity

This is a behaviour difference from the predecessor codebase in the test tree, recorded here
next to §8. The ported predecessor suite reached **live broker endpoints** while
running: a full run made 24 outbound HTTPS requests — 23 to `images.dhan.co`
(the live Dhan scrip master, roughly 201,075 rows at about 4.5s per parse, so
about 90s of a 2m34s CI job) and 1 to `api.kite.trade`. Those requests
originated from three files: `tests/box/singleBroker.test.mjs`,
`tests/tokens/morningDefault.test.mjs` and `tests/switch/managerSwitch.test.mjs`.

this backend's suite does not. A fetch-interceptor scan across all seven suite
directories now reports **zero non-loopback requests**. The scrip master the
tests parse is served from `tests/fixtures/dhan-scrip-master-detailed.sample.csv`,
a **trimmed sample derived from the real upstream file** — not a live snapshot,
and deliberately not a checked-in 201k-row blob.

The property is **enforced in CI, not merely asserted in a comment**. A runtime,
fail-closed network interceptor (`.github/ci/no-egress-guard.mjs`, injected into
the test process via `NODE_OPTIONS=--import`) throws on any request to a
non-loopback host — only `127.0.0.0/8`, `::1` and `localhost` are permitted, so
it composes with the local mock HTTP servers the token/access suites drive on
`127.0.0.1` and with the PostgreSQL/MongoDB drivers. Alongside it a Node-
independent static scan (`.github/ci/no-live-hostnames.sh`) fails the build if a
live broker hostname (`images.dhan.co`, `api.dhan.co`, `auth.dhan.co`,
`api.kite.trade`, `calspread.online`) appears in executable — as opposed to
commented — test code. Together they make a regression to live egress turn the
build red rather than quietly making real HTTPS calls.

Why it matters: the live scrip master changes daily, so a test that parses it
could pass today and fail tomorrow for reasons entirely unrelated to the code —
the worst property a trading-system test can have. The move also grew the suite
from **1,594 to 1,603 tests**, as the hermetic-network helper gained its own
regression tests. (The 1,594 count in §1 records the state at the first `main`
push SHA named there; this subsection records the current count.)
