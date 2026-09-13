# GTS Box — backend

**GTS Box is a box-arbitrage research desk for NSE F&O.** This repository is its backend and
its **sole trading authority**: it scans NSE F&O for four-leg option box opportunities, prices
them, decides whether each one clears the entry gate on its own arithmetic, and — only when
deliberately and fully enabled — executes it at a broker. PostgreSQL is its single operational
authority.

It does **one thing**, and the narrowness is the design: box arbitrage, one lot, with every
refusal named and every number attributable. There is no calendar-spread scanner, no
options/futures analytics, no OI capture, no historical charts and no dividend feed here.

The backend is deliberately the only component that decides anything. The frontend
(`Prakash2571/Strikedge_F`) renders what this service reports and holds no market logic, so a
label in the UI can never disagree with the system's real state: the execution mode, the
readiness verdict, the entry gate and the arming controls are all reported from here.

## Brokers

GTS Box supports **Zerodha (Kite)** and **Dhan**, with **exactly one active at
a time**. The two are never live simultaneously; switching is an explicit,
operator-driven action that is refused while there is live Box exposure.

GTS Box performs **no broker OAuth**. It does not log a user into Zerodha or
Dhan. Instead it fetches the day's access token from **CalSpread's token routes**
(`/api/kite/token`, `/api/dhan/token`) using a shared passcode, decrypts/stores it
under AES-256-GCM, and uses it for the trading day. Token acquisition runs on a
morning IST poll (default 09:00). See `docs/BROKER_TOKENS.md`.

## Data authority

- **PostgreSQL is authoritative.** Order intents, instrument reservations, trades,
  trade events, execution attempts, P&L and sessions are durable in PostgreSQL.
  Every operational compare-and-set is a real SQL transaction.
- **MongoDB Atlas is an async reporting replica.** A transactional outbox is
  drained to Atlas by a background projector for reporting/analytics. Atlas is
  never on the execution hot path and is **not the backup of record** — a lost or
  unreachable Atlas costs you reporting lag, never trading state. See
  `docs/MONGO_PROJECTION.md` and `docs/PG_PERSISTENCE.md`.

## Quick start

```bash
# 1. Dependencies
npm ci

# 2. Configure
cp .env.example .env
#   - set DATABASE_URL to your PostgreSQL
#   - set SITE_ACCESS_SECRET (site passcode) and BROKER_TOKEN_ENCRYPTION_KEY
#     (openssl rand -hex 32)
#   - set KITE_TOKEN_BROKER_PASSCODE / DHAN_TOKEN_BROKER_PASSCODE
#   Leave every BOX_* live gate at its default: you start in PAPER.

# 3. Build
npm run build

# 4. Migrate the database (or set PG_MIGRATE_ON_BOOT=true and let boot do it)
npm run migrate
npm run migrate -- --check      # assert-only: fails if schema is behind

# 5. Run
npm start                        # node dist/index.js
```

Readiness / health check: `GET /api/health` — **200 `{…,"state":"ready","ready":true}`**
only once boot has fully completed, **503 `ready:false`** while starting, after a boot
failure, or while shutting down (contentless beyond liveness/readiness). Runtime state:
`GET /api/runtime/status`.
Projection backlog: `GET /api/export/status`.

For production (PostgreSQL setup, PM2, nginx/SSE, backup, the CalSpread→GTS Box
cutover), read **`docs/DEPLOYMENT.md`**. For daily operations read
**`docs/RUNBOOK.md`**. For every environment variable read
**`docs/CONFIGURATION.md`**. For what was carried across from CalSpread read
**`docs/EXTRACTION_MANIFEST.md`**.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Type-check and compile (`tsc -b`) to `dist/`. |
| `npm start` | Run the compiled server (`node dist/index.js`). |
| `npm run dev` | Build then start. |
| `npm run typecheck` | Type-check only. |
| `npm run migrate` | Apply pending SQL migrations. `-- --check` asserts only. |
| `npm run migrate:box-from-mongo` | ONE-TIME legacy Box import from Mongo (dry-run by default). |
| `npm run rotate:broker-token-key` | Re-encrypt stored broker tokens under a new key. Set `BROKER_TOKEN_OLD_KEY`/`BROKER_TOKEN_NEW_KEY` in the env (never on the CLI); `-- --dry-run` verifies without writing. |
| `npm run outbox:replay` | Re-enqueue/replay outbox rows to the Mongo projection. **Requires a selector** (`-- --dead-letters` \| `-- --aggregate <type> <id>` \| `-- --event-id <id>`) and is **dry-run** until you add `--apply`. |
| `npm test` | Full suite: unit, tokens, access, switch, shutdown, integration. |
| `npm run test:unit` / `test:pg` / `test:projector` / `test:tokens` / `test:access` / `test:switch` / `test:shutdown` | Individual suites. |

## Safety

Real orders are impossible until **several independent gates are all explicit AND
the runtime is armed**. None of these is the site passcode.

1. **Deployment gate 1 (shared):** `BOX_EXECUTION_MODE=live` **and**
   `BOX_LIVE_TRADING_ENABLED=true`. `BOX_EXECUTION_MODE=live` without
   `BOX_LIVE_TRADING_ENABLED=true` refuses to start.
2. **Deployment gate 2 (per broker):** the **active** broker's own switch —
   `ZERODHA_LIVE_TRADING_ENABLED=true` or `DHAN_LIVE_TRADING_ENABLED=true`. The
   inactive broker's gate is irrelevant.
3. **Runtime arming:** an operator must **arm** the trading session at runtime
   (`POST /api/box/session/arm`). Disarming (`/session/disarm`) is always allowed.
4. **The site passcode arms nothing.** `SITE_ACCESS_SECRET` lets an operator into
   the UI. It does **not** enable live trading, does not arm the session, and does
   not flip any gate above.

Dhan additionally enforces a **static-IP guard**: it refuses to go live from an
egress IP other than the whitelisted `DHAN_STATIC_PUBLIC_IP`.

A four-leg Box entry is **not atomic** at either broker. Hedge-first ordering and
durable intents bound the exposure; they do not eliminate it. **No test result is
proof of real-money safety.** See `docs/EXTRACTION_MANIFEST.md` §
"The unavoidable four-leg broker risk" and `src/box/LIVE_EXECUTION.md`.

## Paper-execution calibration variables

The paper execution model calibrates itself from observed timings. These ten
variables are documented here, in `.env.example`, in `docs/CONFIGURATION.md` and
in `src/box/LIVE_EXECUTION.md`; the defaults are the shipped specification:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOX_PAPER_CALIBRATION_MIN_SAMPLES` | `30` | Minimum samples before the calibrated latency source is trusted overall. |
| `BOX_PAPER_CALIBRATION_BUCKET_MIN_SAMPLES` | `60` | Minimum samples per time-of-day bucket. |
| `BOX_PAPER_CALIBRATION_MAX_AGE_MS` | `604800000` | How long (ms) a calibration sample stays eligible (7 days). |
| `BOX_PAPER_CALIBRATION_TIME_BUCKETS` | `true` | Bucket calibration by time of day. |
| `BOX_PAPER_CANCEL_LATENCY_MS` | `150` | Simulated cancel latency (ms) in paper. |
| `BOX_LIVE_TIMING_PERSIST_ENABLED` | `false` | Persist live execution timing samples to PostgreSQL. |
| `BOX_LIVE_TIMING_BATCH_SIZE` | `50` | Rows per live-timing flush batch. |
| `BOX_LIVE_TIMING_FLUSH_MS` | `15000` | Live-timing flush interval (ms). |
| `BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED` | `true` | Emit event-loop lag metrics for the execution path. |
| `BOX_SHADOW_MODE_ENABLED` | `false` | Run live logic against paper fills with no broker contact; cannot combine with live mode. |
