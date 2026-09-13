# GTS Algo Research configuration

Every variable GTS Algo Research reads, grouped by concern. Defaults are the code
fallbacks (from `src/config.ts`, `src/box/config.ts`, `src/pg/pool.ts`,
`src/outbox/mongo.ts`, `src/brokers/*`). Configuration is validated at boot and
**fails closed** with the full list of problems.

Legend: **Req?** = required. "yes" means the process cannot function without it;
"prod" means required in production only; "no" means it has a safe default.

## Configuration precedence and the effective-config surface

Precedence, lowest to highest:

1. **Code default** — `src/config.ts`, `src/box/config.ts`, `src/pg/pool.ts`.
2. **Process environment** — the `.env` loaded into `process.env` by the process
   manager (or a PM2 `env` block). Higher wins.

There is no separate config-file layer: a `.env` is loaded INTO the environment
before the code runs, so environment is the only external source. Two rules make an
effective value differ from what you typed: an **out-of-range** numeric value is
**clamped** into range, and an **unparseable** value **falls back** to the default
(an unrecognised boolean reads as `false`, so a safety gate is never armed by a typo).
Runtime operator API controls (arming, execution permission) are a separate,
session-scoped permission plane that can withdraw a permission but never widen a
configured numeric limit.

To see the RESOLVED value of every Box knob AND where it came from
(`default` / `env` / `env_clamped` / `env_invalid_fallback`), run the effective-config
surface on the deployment host after the `.env` is loaded:

```bash
node dist/box/effectiveConfig.js            # human-readable table
node dist/box/effectiveConfig.js --json     # structured
```

It uses the SAME parser as `loadBoxConfig` (proven by `tests/box/effectiveConfig.test.mjs`)
and refuses to report a configuration that would not boot. `/api/box/status` `.config`
also publishes the parsed configuration in force. If either disagrees with your `.env`,
they are what is running.


## Application (`src/config.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `PORT` | `3001` | no | TCP port to listen on. | Non-1..65535 fails boot. |
| `NODE_ENV` | `development` | no | `development` \| `test` \| `production`. | Unknown value is treated as `development`. |
| `APP_TIMEZONE` | `Asia/Kolkata` | no | Trading-day / token / P&L timezone. | Any value other than `Asia/Kolkata` fails boot — every day boundary is IST. |
| `FRONTEND_URL` | — | yes | Exact CORS origin (with credentials) and redirect target. | Missing/relative fails boot. Non-https in production fails boot (cookie is Secure). |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | no | Max graceful-shutdown time (ms). | `< 1000` fails boot. Must sit below PM2 `kill_timeout`. |

## Site access (`src/config.ts`, `src/access/*`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `SITE_ACCESS_SECRET` | — | yes | The site passcode, hashed into a session. **Arms nothing** — UI access only. | Unset ⇒ nobody can pass the access gate. |
| `SITE_SESSION_TTL_HOURS` | `24` | no | Session lifetime (hours). | Outside `0 < h <= 720` fails boot. |
| `SESSION_COOKIE_NAME` | `gts_session` | no | HttpOnly session cookie name. | Illegal chars fail boot. |
| `CSRF_ALLOWED_ORIGIN` | `FRONTEND_URL` | no | Origin required on mutating requests. | Non-absolute origin fails boot. |

## PostgreSQL (`src/pg/pool.ts`, `src/config.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | — | yes | libpq URL. Unix socket (`postgres:///strikedge`) or TCP. | Unset ⇒ boot throws `PgUnavailableError`; PostgreSQL is not optional. |
| `PG_POOL_MAX` | `10` | no | Max pooled connections. | Non-positive ⇒ default. |
| `PG_STATEMENT_TIMEOUT_MS` | `5000` | no | Per-statement timeout applied on connect. | Too low ⇒ legitimate statements abort; too high ⇒ a wedged statement can stall the execution path. |
| `PG_LOCK_TIMEOUT_MS` | `2000` | no | Lock-acquisition timeout. | Too high ⇒ contention stalls. |
| `PG_MIGRATE_ON_BOOT` | `true` | no | Apply migrations at boot vs assert-only. | `false` ⇒ boot refuses if schema is behind (run `npm run migrate`). |
| `PG_APPLICATION_NAME` | `gts` | no | `application_name` in `pg_stat_activity`. | Cosmetic. |

## Token encryption (`src/brokerState/tokenCrypto.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BROKER_TOKEN_ENCRYPTION_KEY` | — | yes | AES-256-GCM key for tokens at rest. **Exactly 32 bytes**, as 64-char hex OR base64/base64url decoding to 32 bytes. | Wrong length/encoding ⇒ typed error. Changing it ⇒ old sealed tokens unreadable (re-acquired next morning). |

## Zerodha token provider (`src/tokens/*`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `KITE_TOKEN_BROKER_URL` | `https://calspread.online/api/kite/token` | no | the external CalSpread Zerodha token endpoint. | Wrong URL ⇒ token fetch fails; no Zerodha trading. |
| `KITE_TOKEN_BROKER_PASSCODE` | — | yes (Zerodha) | Shared passcode for the external CalSpread token routes. | Unset/wrong ⇒ token fetch rejected. |
| `KITE_API_KEY` | — | yes (Zerodha-live) | Zerodha API key used by the live order adapter (`src/brokers/zerodha/liveAdapter.ts`). Distinct from `KITE_API_KEY_EXPECTED`. | Unset ⇒ Zerodha live execution throws "KITE_API_KEY is missing" and refuses to go live. |
| `KITE_API_KEY_EXPECTED` | — | prod | If set, fetched token's api_key must equal this. | Mismatch ⇒ token rejected as foreign (a safety feature). |

## Dhan token provider (`src/tokens/*`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `DHAN_TOKEN_URL` | `https://calspread.online/api/dhan/token` | no | the external CalSpread Dhan token endpoint. | Wrong URL ⇒ no Dhan trading. |
| `DHAN_TOKEN_BROKER_PASSCODE` | — | yes (Dhan) | Shared passcode for the Dhan token route. | Unset/wrong ⇒ token fetch rejected. |
| `DHAN_API_KEY` | — | yes (Dhan-live) | Dhan app API key. Read by `readDhanCredentials()` and required for Dhan live readiness. | Unset ⇒ Dhan reports "not configured"; Dhan live is blocked. |
| `DHAN_API_SECRET` | — | yes (Dhan-live) | Dhan app secret. Same credential check as above; never leaves the server. | Unset ⇒ Dhan "not configured"; Dhan live blocked. |
| `DHAN_CLIENT_ID_EXPECTED` | — | prod | If set, fetched token's client_id must equal this. | Mismatch ⇒ token rejected. |

## Token scheduling (`src/tokens/*`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BROKER_TOKEN_POLL_START` | `09:00` | no | IST HH:MM the morning poll starts. | Bad format ⇒ falls back to default. |
| `BROKER_TOKEN_POLL_INTERVAL_MS` | `60000` | no | Re-poll interval until a token is obtained. | Too small ⇒ hammers the external CalSpread provider. |
| `BROKER_TOKEN_REQUEST_TIMEOUT_MS` | `10000` | no | Per-request token-fetch timeout. | Too low ⇒ spurious failures on a slow morning. |

## Broker selection (`src/brokers/registry.ts`, `src/brokerRoutes.ts`)

Exactly one broker is active at a time.

| Variable | Default | Required | What it does |
| --- | --- | --- | --- |
| `DEFAULT_ACTIVE_BROKER` | `zerodha` | no | The broker a **fresh** deployment starts on. Honoured only when PostgreSQL holds no `active_broker` row — `restore()` always overrides it from the durable record, so a restart can never silently revert an operator's switch. An unrecognised value warns and falls back to `zerodha`. |
| `AUTO_FALLBACK_TO_DHAN` | `false` | no | Whether losing Zerodha may move **speculative entry** to Dhan by itself. Keep it false. False means Zerodha is reported unavailable and Dhan "ready — standby"; nothing scans or enters on Dhan without an operator. It never gates reduction — exits, protective cancellation, emergency flattening and reconciliation always run through whichever broker owns the exposure. |

A broker **switch** is always an explicit, blocker-checked `POST /api/broker/select`.
Neither variable above can perform one.

> An audit correctly found that these two were documented but unread, and removed them
> from the docs. That was the wrong direction: both are required by the specification, so
> they were implemented instead (`defaultActiveBrokerFromEnv` and
> `autoFallbackToDhanFromEnv` in `src/brokers/registry.ts`, covered by
> `tests/pg/auditGapFixes.test.mjs`). See `docs/DOC_AUDIT.md` finding C-DEFECT-1 for the
> original observation.

## Shared Box live gates — GATE 1 (`src/box/config.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BOX_EXECUTION_MODE` | `paper_latency` | no | `paper_latency` \| `paper_legging` \| `live_parity` \| `live`. | `live` **requires** `BOX_LIVE_TRADING_ENABLED=true` or the loader refuses to start. |
| `BOX_LIVE_TRADING_ENABLED` | `false` | no | Shared live master switch. | Strict boolean: a typo is read as `false` (fail-safe). |

## Broker-specific live gates — GATE 2 (`src/brokers/registry.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `ZERODHA_LIVE_TRADING_ENABLED` | `false` | no | Per-broker gate for Zerodha. | Must be `true` when Zerodha is active and going live. |
| `DHAN_LIVE_TRADING_ENABLED` | `false` | no | Per-broker gate for Dhan. | Must be `true` when Dhan is active and going live. |

## Dhan safety & charge card (`src/brokers/dhan/http.ts`, `src/brokers/registry.ts`, `src/brokers/dhan/charges.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `DHAN_STATIC_PUBLIC_IP` | — | Dhan-live | The whitelisted egress IP presented to Dhan. | Empty while `DHAN_STATIC_IP_EXPECTED=true` ⇒ live blocked. |
| `DHAN_STATIC_IP_EXPECTED` | `true` | no | Require observed egress IP to match. | `false` disables the guard — do not, in production. |
| `DHAN_DATA_ENABLED` | `true` | no | Enable the Dhan market-data API. **An unset/empty value counts as enabled** (`registry.ts`). | `false` while Dhan is active ⇒ no Dhan feed. |
| `DHAN_CLIENT_ID` | (from token session) | no | Dhan client id (non-secret). | Wrong ⇒ order calls fail. |
| `DHAN_HTTP_TIMEOUT_MS` | `8000` | no | Per-HTTP-call timeout (range 500..60000). | Too low ⇒ spurious timeouts. |
| `DHAN_MIN_INTERVAL_MS` | `120` | no | Broker-side HTTP pacing floor (range 0..5000). | A smaller Box-level value cannot beat this. |
| `DHAN_MAX_READ_ATTEMPTS` | `3` | no | Order-status read attempts (range 1..6). | Too low ⇒ premature "unknown" on a slow read. |
| `DHAN_BROKERAGE_PER_ORDER` | `20` | no | Dhan F&O brokerage per order (₹). | Wrong ⇒ mis-priced net edge. |
| `DHAN_BROKERAGE_MAX_PCT` | `0` | no | Cap brokerage as % of value (0 = off). | — |
| `DHAN_STT_SELL_PCT` | `0.1` | no | STT on sell side (%). | Statutory; change only on a rate change. |
| `DHAN_STT_ROUND_NEAREST_RUPEE` | `true` | no | Round STT to nearest rupee. | — |
| `DHAN_EXCHANGE_TXN_PCT` | `0.03503` | no | Exchange transaction charge (%). | Statutory. |
| `DHAN_IPFT_PER_CRORE` | `50` | no | IPFT per crore turnover (folded into exchange head). | Statutory. |
| `DHAN_SEBI_PCT` | `0.0001` | no | SEBI turnover charge (%). | Statutory. |
| `DHAN_STAMP_DUTY_BUY_PCT` | `0.003` | no | Stamp duty on buy side (%). | Statutory. |
| `DHAN_GST_PCT` | `18` | no | GST (%). | Statutory. |
| `DHAN_CHARGE_RATE_VERSION` | `dhan-nse-options-2026-04-01` | no | Label stamped on the charge record. | Cosmetic/audit. |

## Zerodha charge card (`src/box/localCharges.ts`)

`loadLocalChargeRates()` reads a full statutory rate card, not just the two
labels. Only brokerage is a genuine broker choice; the statutory heads match the
Dhan card because they are the same statutory rates. **Note the Zerodha STT
default (`0.15`) differs from the Dhan card default (`0.1`).**

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BOX_STT_TYPE` | `stt` | no | STT type label on the local charge record. | Cosmetic/audit. |
| `BOX_CHARGE_RATE_VERSION` | `zerodha-nse-options-2026-04-01` | no | Zerodha charge-card version label. | Cosmetic/audit. |
| `BOX_BROKERAGE_PER_ORDER` | `20` | no | Zerodha F&O brokerage per order (₹). | Wrong ⇒ mis-priced net edge. |
| `BOX_BROKERAGE_MAX_PCT` | `0` | no | Cap brokerage as % of value (0 = off). | — |
| `BOX_STT_SELL_PCT` | `0.15` | no | STT on sell side (%). | Statutory; change only on a rate change. |
| `BOX_STT_ROUND_NEAREST_RUPEE` | `true` | no | Round STT to nearest rupee. | — |
| `BOX_EXCHANGE_TXN_PCT` | `0.03503` | no | Exchange transaction charge (%). | Statutory. |
| `BOX_IPFT_PER_CRORE` | `50` | no | IPFT per crore turnover. | Statutory. |
| `BOX_IPFT_PCT` | `0` | no | IPFT as a percentage (alternative to per-crore). | Statutory. |
| `BOX_SEBI_PCT` | `0.0001` | no | SEBI turnover charge (%). | Statutory. |
| `BOX_STAMP_DUTY_BUY_PCT` | `0.003` | no | Stamp duty on buy side (%). | Statutory. |
| `BOX_GST_PCT` | `18` | no | GST (%). | Statutory. |

## Mongo projection (`src/outbox/mongo.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `MONGODB_URI` | — | no | Atlas connection string (reporting replica). Never logged. | Blank ⇒ export disabled; the rest of the system is unaffected. |
| `MONGO_EXPORT_ENABLED` | `true` | no | Master export switch. | Export runs only when `true` **and** `MONGODB_URI` set. |
| `MONGO_EXPORT_BATCH_SIZE` | `100` | no | Rows per drain batch. | — |
| `MONGO_EXPORT_INTERVAL_MS` | `1000` | no | Drain interval. | — |
| `MONGO_EXPORT_MAX_BACKOFF_MS` | `60000` | no | Max backoff when Atlas fails. | — |
| `MONGO_EXPORT_SERVER_SELECTION_TIMEOUT_MS` | `5000` | no | Bounded server-selection timeout. | Too high ⇒ slow drain when Atlas is down. |
| `MONGO_EXPORT_MAX_ATTEMPTS` | `10` | no | Attempts before a poison row is dead-lettered. | — |
| `MONGO_EXPORT_DB` | (parsed from URI, else `strikedge`) | no | Explicit target db. | — |

## Legacy import (`src/scripts/migrateBoxFromMongo.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `LEGACY_BOX_MONGODB_URI` | — | import-only | Source legacy Box Mongo (read-only). | Only read by `npm run migrate:box-from-mongo`; unset elsewhere is fine. |

## Reservation identity (`src/box/reservations/identity.ts`)

`CALSPREAD_DEPLOYMENT_ID` and `CALSPREAD_INSTANCE_ID` are read by the **reservation
layer** — these are the actual names the code reads (`identity.ts` resolves the
lock namespace from `CALSPREAD_DEPLOYMENT_ID`, falling back to `NODE_ENV`, and the
instance label from `CALSPREAD_INSTANCE_ID`, falling back to the hostname).

> **These two names were deliberately NOT renamed in the GTS Algo Research rebrand.**
> They are compatibility-sensitive. `CALSPREAD_DEPLOYMENT_ID` is the namespace
> component of the **durable owner id** written into the PostgreSQL reservation
> rows, and owner-verified release compares that id byte-for-byte. Renaming the
> variable would make a restarted process resolve a *different* namespace: it would
> no longer recognise its own outstanding reservations, and could release or
> "renew" a lease it does not own. That is a multi-process safety mechanism, not a
> label — so the prefix stays, the durable owner-id format stays unchanged, and a
> mixed fleet keeps reading the same keys. Set the values; do not rename the keys.

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `CALSPREAD_DEPLOYMENT_ID` | `NODE_ENV` else `development` | no | Durable lock namespace. **Staging and production must not share one.** | Sharing ⇒ a laptop could take a lock the production process needs. |
| `CALSPREAD_INSTANCE_ID` | hostname | no | Host/replica label in owner ids and conflict logs. | Cosmetic but useful in logs. |

## Box strategy knobs (`src/box/config.ts`)

Every `BOX_*` strategy knob in `.env.example` is **optional**; the defaults are
the shipped specification and keep execution in `paper_latency`. The loader
validates and clamps each one and fails closed. The full annotated list lives in
`.env.example`; the live/safety and calibration variables are below.

### Live execution, safety and admission (`src/box/config.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BOX_EXECUTION_MODE` | `paper_latency` | no | `paper_touch`\|`paper_latency`\|`paper_legging`\|`live`. | Unknown value FAILS boot; `live` needs the kill switch. |
| `BOX_LIVE_TRADING_ENABLED` | `false` | no | The deployment kill switch; `live` mode is rejected at boot without it. | Both this and `live` mode required to place a real order. |
| `BOX_LIVE_MAX_OPEN_BOXES` | `1` | no | Concurrent open boxes (clamp 0..20). | Higher ⇒ more concurrent risk. |
| `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS` | `1` | no | Concurrent execution pipelines (clamp 1..4). | — |
| `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING` | `false` | no | One box per underlying, on top of contract exclusion. | Set `true` for the conservative profile. |
| `BOX_SESSION_MAX_COMPLETED_TRADES` | `0` | no | Completed-box cap for an armed session; `0`=unlimited (clamp 0..10000). | Set `1` to arm a one-shot session. |
| `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` | `0` | no | GROSS order notional cap (₹), NOT margin/max-loss; `0`=disabled (clamp 0..1e9). | A placeholder to set, never an approved budget. |
| `BOX_LIVE_REQUIRE_FUNDS_COVER` | `false` | no | Refuse entry unless fresh broker funds cover the requirement. | `true` recommended for live; blocks on stale/missing funds. |
| `BOX_LIVE_REQUIRE_MARGIN_EVIDENCE` | `false` | no | Refuse entry without fresh basket-margin evidence. | Fails CLOSED (no source wired) — leave off until wired. |
| `BOX_LIVE_FUNDS_FRESHNESS_MAX_AGE_MS` | `5000` | no | Max age of a funds observation counted fresh (clamp 250..600000). | — |
| `BOX_LIVE_MARGIN_FRESHNESS_MAX_AGE_MS` | `5000` | no | Max age of a margin observation counted fresh (clamp 250..600000). | — |
| `BOX_LIVE_DAILY_LOSS_LIMIT` | `5000` | no | Loss breaker: stops NEW entry, not a max loss (clamp 0..1e7). | — |
| `BOX_LIVE_ORDER_MUTATION_DEADLINE_MS` | `4000` | no | ONE end-to-end budget per mutation, started before queue admission (clamp 250..30000). | Too low ⇒ premature abandonment; too high ⇒ slow give-up. |
| `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY` | `1` | no | Entry-role submissions in transport at once (1..4). | 4 does NOT make entry atomic. |
| `BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS` | `0` | no | Order-mutation pacing; `0`=derive from broker floor, override clamped UP (clamp 0..5000). | Never goes below the broker's hard floor. |
| `BOX_ORDER_EVENT_QUEUE_PRESSURE` | `512` | no | Never-drop order-event backpressure THRESHOLD; overload blocks entry + reconciles, never drops. | Not a cap; data is never dropped. |
| `BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS` | `500` | no | Primary LIVE four-leg coherence gate (clamp 0..60000). | `0` is impossible-to-satisfy in live unless explicitly opted out. |
| `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS` | `250` | no | Exchange-time dispersion gate (clamp 0..60000). | Kite stamps are whole SECONDS — set ≥1000 or rely on the receive gate. |
| `BOX_DEPLOYMENT_REGION` | — | no | Calibration dataset region label (e.g. `mumbai`); NEVER auto-detected. | Wrong label pools cross-region latency. |

### The calibration / live-timing variables


| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BOX_PAPER_CALIBRATION_MIN_SAMPLES` | `30` | no | Min samples before the calibrated latency source is trusted overall (clamp 5..100000). | Too low ⇒ noisy calibration. |
| `BOX_PAPER_CALIBRATION_BUCKET_MIN_SAMPLES` | `60` | no | Min samples per time bucket (clamp 5..100000). | Too low ⇒ noisy per-bucket latency. |
| `BOX_PAPER_CALIBRATION_MAX_AGE_MS` | `604800000` | no | Max age (ms) a sample stays eligible (7 days). | Too small ⇒ calibration starves. |
| `BOX_PAPER_CALIBRATION_TIME_BUCKETS` | `true` | no | Bucket calibration by time of day. | `false` ⇒ one pooled distribution. |
| `BOX_PAPER_CANCEL_LATENCY_MS` | `150` | no | Simulated cancel latency (ms) in paper (clamp 0..60000). | Unrealistic paper cancel timing. |
| `BOX_LIVE_TIMING_PERSIST_ENABLED` | `false` | no | Persist live execution timing samples to PostgreSQL. | `true` ⇒ extra writes; needed to build a live calibration corpus. |
| `BOX_LIVE_TIMING_BATCH_SIZE` | `50` | no | Rows per live-timing flush batch (clamp 1..10000). | — |
| `BOX_LIVE_TIMING_FLUSH_MS` | `15000` | no | Live-timing flush interval (ms) (clamp 250..600000). | — |
| `BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED` | `true` | no | Emit event-loop lag metrics for the execution path. | `false` ⇒ blind to event-loop stalls. |
| `BOX_SHADOW_MODE_ENABLED` | `false` | no | Run live logic against paper fills with no broker contact. | Cannot combine with `BOX_EXECUTION_MODE=live` (loader refuses). |

---

## Identifiers the GTS Algo Research rebrand deliberately did NOT rename

Renaming an identifier that something durable depends on is how a rebrand turns into an
outage. These were audited individually and **left alone on purpose**:

| Identifier | Where | Why it must not change |
| --- | --- | --- |
| `CALSPREAD_DEPLOYMENT_ID`, `CALSPREAD_INSTANCE_ID` | env vars, `src/box/reservations/identity.ts` | Namespace components of the **durable owner id** in the PostgreSQL reservation rows. Owner-verified release compares that id byte-for-byte, so a rename makes a restarted process stop recognising its own leases. See §Reservation identity. |
| `migrations/*.sql` (contents, **including comments**) | `src/pg/migrate.ts` | Each applied migration's **sha256 is recorded** in `schema_migrations`, and editing an applied file is a HARD BOOT ERROR ("Migration … was modified after it was applied"). Even a comment edit changes the hash and would refuse to start the process. The historical terminology in those comments therefore stays. |
| PostgreSQL role / database name (`DATABASE_URL`) | deployment | Names a live database holding every order intent, reservation, trade and session. Renaming it is a migration with downtime, not a rebrand. |
| MongoDB reporting-replica database name (`MONGO_EXPORT_DB` fallback) | `src/outbox/mongo.ts` | Names a live database holding the reporting replica. A change would silently start writing into a new empty database while the populated one went stale. |
| `calspread:box:pnl:day:*` | `src/box/pnlCache.ts` | The durable day-key prefix already written by earlier deployments. A rename orphans archived P&L days instead of failing loudly. |
| `strikedge-access-breadcrumb` | `src/access/sessionStore.ts` | Part of a hash input. Changing it changes every digest, so breadcrumbs already stored no longer correlate with new ones. |
| `strikedge-<group>-<leg>` | `src/boxSupport.ts` | A correlation token inside one charge-pricing round trip, matched byte-for-byte against the broker response. On the charge-pricing path, which the rebrand does not touch. |
| `calspread.online` token routes | `KITE_TOKEN_BROKER_URL`, `DHAN_TOKEN_URL` | A **real external third-party service** this backend is a client of. Renaming it would be factually wrong and would break token acquisition. |
| `/api/box/*`, `/api/access/*`, `/api/broker/*` | HTTP surface | Stable API contract. There is no benefit to changing a working path for branding. |

---

## Predecessor variables that were REMOVED

This backend deliberately **does not read** the following predecessor variables. They
belong to features that were left behind in the extraction, so shipping them in
`.env.example` would be a lie about what the process does. If any appear in a
copied `.env`, they are silently ignored.

| Removed variable(s) | Why it is gone |
| --- | --- |
| `KITE_API_SECRET` | This backend performs no Zerodha OAuth; it fetches a ready token from the external CalSpread provider. No secret is exchanged. |
| `ADMIN_SECRET` | The full-admin login is replaced by the site passcode session (`SITE_ACCESS_SECRET`) plus the runtime arming controls. |
| `ACCESS_SECRET` | The separate trade-access password is replaced by the single site passcode. |
| `INTERNAL_TOKEN_SECRET` | The `/api/internal/kite-token` route that fed a separate market-data recorder is gone. |
| `TOKEN_ROUTE_SECRET` | This backend does not host token routes; it is a **client** of the external CalSpread routes, using `KITE_TOKEN_BROKER_PASSCODE` / `DHAN_TOKEN_BROKER_PASSCODE`. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis is removed entirely; the P&L and closed-trade caches are PostgreSQL-backed. |
| `TRADE_LOG_URI` | The calendar-spread ledger is out of scope. |
| `NSE_FNO_ARCHIVE_URI`, `NSE_FNO_CURRENT_URI`, `NSE_FNO_SPREAD_URI` | Historical F&O capture / spread computation are calendar-scanner features, not Box. |
| `EXTRA_SESSION_DAYS` | Only the intraday capture (removed) consumed the special-session list. |
| `BOX_MONGODB_URI` | Mongo is no longer the operational store; PostgreSQL (`DATABASE_URL`) is. Mongo is reporting-only via `MONGODB_URI`. |
| `DHAN_REDIRECT_URL`, `DHAN_POSTBACK_URL` | Read only by the disabled Dhan OAuth consent flow (`src/brokers/dhan/auth.ts`), which this backend never invokes. Setting them does nothing. |

> **Correction (2026-09 audit).** `DHAN_API_KEY` and `DHAN_API_SECRET` are NOT
> inert. `readDhanCredentials()` (`src/brokers/dhan/auth.ts`) reads
> `DHAN_CLIENT_ID` / `DHAN_API_KEY` / `DHAN_API_SECRET`, and
> `computeDhanProblems()` (`src/brokers/registry.ts`) uses it: if the key/secret
> are unset, Dhan reports **"not configured"** and Dhan **live readiness is
> blocked** (`dhan_configured=false`). Only the browser *consent* flow
> (`generateDhanConsent` / `consumeDhanConsent`) is disabled — the token itself
> still comes from the external CalSpread Dhan route. So these two are required for Dhan
> live; they are documented in the Dhan section, not here. `DHAN_REDIRECT_URL` /
> `DHAN_POSTBACK_URL` are the only genuinely inert ones (consent-flow only).

### P&L cache / archive knobs — re-purposed, NOT removed (`src/box/config.ts`)

An earlier draft listed these as removed Redis knobs. They are read and drive the
**PostgreSQL-backed** P&L cache/archive (`src/box/pnlArchive.ts`):

| Variable | Default | What it does |
| --- | --- | --- |
| `BOX_PNL_CACHE_ENABLED` | `false` | Enable the PostgreSQL-backed P&L snapshot cache writer. |
| `BOX_PNL_CACHE_INTERVAL_MS` | `30000` | Snapshot write interval (ms). |
| `BOX_PNL_CACHE_TTL_SEC` | `259200` | Cached-snapshot TTL (seconds, 3 days). |
| `BOX_PNL_ARCHIVE_HOUR` | `21` | IST hour the daily P&L archive runs. |
| `BOX_PNL_ARCHIVE_DRAIN_DELAY_MS` | `50` | Delay (ms) between archive drain steps. |
| `BOX_PNL_VERIFY_HOURS` | `[22,23]` | IST hours the archive-verification pass runs. |
