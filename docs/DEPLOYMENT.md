# GTS Box deployment

Production deployment: PostgreSQL, migrations, build/start, PM2, nginx (with the
SSE settings), health check, backup/restore, rollback, the safe migration
procedure, and — most importantly — the **CalSpread → GTS Box cutover**.

PostgreSQL is GTS Box's operational authority; treat it accordingly.

> **Going live in Mumbai (`ap-south-1`)?** Read
> [`docs/MUMBAI_EC2_PROFILE.md`](MUMBAI_EC2_PROFILE.md) first. It holds the conservative
> starting profile (real trading disabled, one lot, one box), the ready-to-edit
> [`deploy/mumbai-ec2-conservative.env.example`](../deploy/mumbai-ec2-conservative.env.example),
> and the EC2-specific requirements: stable outbound IP, clock sync, PostgreSQL
> durability, monitoring, restart/recovery, config precedence, and the requirement that
> CalSpread Box execution be disabled first.

## 1. PostgreSQL installation, database and role

Install PostgreSQL (14+; 15/16 fine) from your distro or the PGDG repo. Then
create a database and a role. Either a **local Unix socket** or a **localhost TCP**
connection is supported.

Local Unix socket (peer auth — simplest for a single-host deploy):

```bash
sudo -u postgres createuser --pwprompt strikedge      # or peer-auth role matching the OS user
sudo -u postgres createdb --owner=strikedge strikedge
# .env:
#   DATABASE_URL=postgres:///strikedge
```

localhost TCP with a password:

```sql
CREATE ROLE strikedge LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE strikedge OWNER strikedge;
```

```
# .env:
DATABASE_URL=postgresql://strikedge:CHANGE_ME@127.0.0.1:5432/strikedge
```

The role needs ordinary DDL/DML on its own database (it creates tables via
migrations). It does not need superuser.

## 2. Migrations

Migrations live in `migrations/*.sql` and run under a PostgreSQL advisory lock, so
two processes starting together cannot both apply the same migration. Each file's
checksum is recorded; editing an already-applied migration is refused.

```bash
npm run migrate                 # apply pending migrations
npm run migrate -- --check      # assert-only: exits non-zero if the schema is behind
```

`PG_MIGRATE_ON_BOOT=true` (default) applies migrations during boot. Set it
`false` and use `npm run migrate` as an explicit release step; boot then refuses
to start if the schema is behind (surfaced clearly in logs).

## 3. Production build and start

```bash
npm ci
npm run build          # tsc -b → dist/
npm run migrate        # (or rely on PG_MIGRATE_ON_BOOT)
node dist/box/effectiveConfig.js   # confirm the EFFECTIVE resolved config + provenance
npm start              # node dist/index.js
```

> Run `node dist/box/effectiveConfig.js` after the same `.env` is loaded but
> BEFORE starting the process. It prints every Box knob's resolved value and where
> it came from (`default` / `env` / `env_clamped` / `env_invalid_fallback`) and
> refuses (non-zero exit) to report a configuration that would not boot. A clamped
> or fallen-back value is flagged so you can see, for example, that
> `BOX_LIVE_MAX_OPEN_BOXES=99` is actually running as `20`. See
> `docs/CONFIGURATION.md` for precedence.

## 4. PM2

Use the checked-in `ecosystem.config.cjs` (fork mode, one instance, generous
`kill_timeout` above `SHUTDOWN_TIMEOUT_MS`).

```bash
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs strikedge
pm2 reload strikedge          # graceful: SIGTERM → wait kill_timeout → SIGKILL
pm2 stop strikedge
pm2 save                      # persist across reboots
pm2 startup                   # install the boot hook (run the command it prints)
```

Graceful shutdown runs: stop scanner → drain the outbox → close Mongo → **close
PostgreSQL last**, bounded by `SHUTDOWN_TIMEOUT_MS`. `kill_timeout` (30s) sits
above that so the sequence finishes before SIGKILL.

## 5. nginx and SSE

Use `deploy/nginx.conf`. The `/api/box/stream` location disables buffering and
caching, uses a long read timeout, and sets `X-Accel-Buffering: no`:

- `proxy_buffering off;` — otherwise nginx holds SSE frames and the live board
  looks frozen; off flushes each `data:` frame immediately.
- `proxy_cache off;` — a never-ending 200 must never be cached/coalesced.
- `proxy_read_timeout 3600s;` — SSE streams are long-lived and quiet between
  events; the default 60s would drop a healthy stream during a lull.
- `proxy_set_header X-Accel-Buffering no;` — per-response guarantee that this
  stream is unbuffered even if buffering is enabled elsewhere.

## 6. Health / readiness check

`GET /api/health` is an HONEST readiness probe: it reports operational readiness
only when the process has finished booting (PostgreSQL up, migrations
verified/applied, the authoritative broker restored, Box durable state adopted and
unresolved order reconciliation completed to the engine's safe boundary). It is
unauthenticated and deliberately CONTENTLESS beyond liveness/readiness — it carries
no broker, token, position, exposure or migration detail.

```bash
# Ready (boot complete):
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/api/health   # 200
curl -s https://<host>/api/health
# {"service":"strikedge","state":"ready","ready":true,"shutting_down":false}

# Still starting, boot failed, or shutting down:
#   HTTP 503, body {"service":"strikedge","state":"starting|failed|shutting_down","ready":false,...}
```

Response-code contract:

| State           | HTTP | `ready` | Meaning                                                        |
| --------------- | ---- | ------- | -------------------------------------------------------------- |
| `starting`      | 503  | false   | Socket is up but boot is still in progress — do not route yet. |
| `ready`         | 200  | true    | Boot complete; safe to route traffic.                          |
| `failed`        | 503  | false   | Boot failed; the process exits non-zero and PM2 restarts it.   |
| `shutting_down` | 503  | false   | Draining after SIGTERM — stop routing to it.                   |

The process uses **listen-with-503**: it binds the socket immediately (so nginx and
any load-balancer health check always have a reachable endpoint) and answers 503
until it is genuinely ready, rather than refusing connections during boot. Configure
your load balancer / nginx upstream health check to treat **200 = in service** and
**503 = out of service**. All mutating routes (POST/PUT/PATCH/DELETE) are also
refused with 503 until the process is `ready` and again once it is `shutting_down`.
Also watch `GET /api/runtime/status` and `GET /api/export/status` (see
`docs/RUNBOOK.md`).

### Manual risk reduction vs the readiness gate (deliberate tradeoff)

The single readiness gate refuses **all** mutating HTTP requests while the process
is not `ready`. That set includes the operator's **manual** risk-reducing routes:
`POST /api/box/live/flatten`, `/api/box/live/cancel-working`, `/api/box/live/reconcile`,
`/api/box/trades/:id/close`, and the emergency-flatten execution control. So:

- **Manual, operator-initiated reduction is UNAVAILABLE while `starting` and while
  `shutting_down`** (and `failed`). This is deliberate, not an oversight:
  - While `starting`, no durable exposure has been adopted yet and reconciliation has
    not run — a manual flatten would act on an **empty, un-reconciled world**, so it
    must be refused rather than operate on a system that has not yet learned what it owns.
  - Refusing mutations while `shutting_down` is **pre-existing** drain behaviour (the
    old `shuttingDown` middleware already did this); the consolidated gate preserves it.
- **AUTOMATIC reduction is UNAFFECTED.** Automatic exit, protective cancellation,
  reconciliation and emergency residual flattening are **engine-internal** and never
  pass through the HTTP readiness middleware at all — the `ReadinessController` is
  imported only by the HTTP layer (`src/index.ts`) and by no engine module. An HTTP
  gate can therefore never stop risk reduction. This is pinned by
  `tests/readiness/riskReductionGating.test.mjs` (structural + behavioural).
- **Positions are preserved and re-adopted on restart.** SIGTERM never liquidates;
  a restart re-adopts open positions, unresolved intents and residual exposure at boot
  before the process becomes `ready`, at which point manual reduction routes are
  reachable again.

In short: the window in which manual reduction is unavailable is exactly the window in
which the process either does not yet know its exposure (`starting`) or is draining
(`shutting_down`), and throughout both windows the engine's automatic reduction of any
exposure it does own continues untouched.

## 7. Backup and restore

**PostgreSQL is the backup of record.** Back it up; do not treat MongoDB Atlas as
your backup.

```bash
# Backup (custom format — compressed, restorable selectively)
pg_dump --format=custom --file=strikedge_$(date +%F).dump "$DATABASE_URL"

# Restore into a fresh database
createdb strikedge_restore
pg_restore --clean --if-exists --dbname=strikedge_restore strikedge_$(date +%F).dump
```

Schedule `pg_dump` (e.g. nightly + before every migration) and test a restore
periodically.

**Why MongoDB Atlas is NOT the backup of record.** Atlas is an *async reporting
replica* fed by a transactional outbox. It lags PostgreSQL, it can be disabled
(`MONGO_EXPORT_ENABLED=false` or no `MONGODB_URI`), and its documents are shaped
for reporting, not for reconstructing operational state (order-intent CAS
history, reservation ownership, day-state proofs). Restoring from Atlas would
give you a stale, lossy view and could not re-establish the durable guarantees.
Always restore from a PostgreSQL dump; use the outbox replay only to *re-populate
Atlas from PostgreSQL*, never the reverse.

## 8. Outbox replay

If the Mongo projection falls behind or Atlas was down, re-drive it from
PostgreSQL. `outbox:replay` **requires a selector** and is **dry-run by default**
(it prints what it would do and writes nothing without `--apply`):

```bash
# Dry-run (default): show what WOULD be replayed. Pick exactly one selector:
npm run outbox:replay -- --dead-letters                 # all dead-lettered rows
npm run outbox:replay -- --aggregate <type> <id>        # one aggregate
npm run outbox:replay -- --event-id <id>                # one event

# Actually write:
npm run outbox:replay -- --dead-letters --apply
```

Running it with no selector fails fast (`Choose a selector: …`) and changes
nothing.

## 9. Rollback

1. `pm2 stop strikedge`.
2. Deploy the previous build artifact (previous `dist/` or previous tag +
   `npm ci && npm run build`).
3. **Do not roll a migration backwards automatically.** Migrations are additive
   and checksum-locked. If the previous code is compatible with the current
   schema (usually true for additive migrations), just start the old code. If a
   migration must be undone, do it as a new, reviewed forward migration after
   following §10.
4. `pm2 start ecosystem.config.cjs` and wait for `/api/health` to return **200
   `ready:true`** (it returns 503 `ready:false` while still booting), then verify
   `/api/runtime/status`.

## 10. Safe database migration procedure

Never migrate under a live, armed process.

1. **Stop the scanner** — `POST /api/box/stop` (or via the UI).
2. **Disarm** live trading — `POST /api/box/session/disarm`.
3. **Verify flat** — `GET /api/runtime/status`: no open positions, no working
   orders, no execution in flight, no residual legs, no unresolved order intents,
   reconciliation complete.
4. **Back up** — `pg_dump` (see §7).
5. **Migrate** — `npm run migrate` (or `-- --check` first to see the delta).
6. **Verify** — `npm run migrate -- --check` returns OK; app boots; `/api/health`
   returns **200 `ready:true`** (503 `ready:false` until boot completes).
7. **Restart / re-arm** — start the process; only re-arm live trading
   deliberately, through the gates.

---

## 11. THE CRITICAL CUTOVER — CalSpread → GTS Box

> **CalSpread Box live execution for both Zerodha and Dhan must remain disabled
> before and while GTS Box owns Box live execution. GTS Box PostgreSQL
> cannot fence orders submitted independently by the old CalSpread process.**

CalSpread and GTS Box **must not both run active Box live scanners against the
same Zerodha or Dhan account.** Their reservation/order-intent stores are separate
(CalSpread's Mongo, GTS Box's PostgreSQL); neither can see or fence the other's
orders. Two live scanners on one account can double-enter, race the same
underlying and leave residuals nobody planned. The passcode/token routes are
shared and safe; **live execution is the thing that must be exclusive.**

Perform the cutover in this order:

1. **Stop the CalSpread Box scanner** (its Box scanning loop).
2. **Disable CalSpread Box entry control** (no new Box entries).
3. **Disable CalSpread Box live-order control** (no new live Box orders).
4. **Set CalSpread `BOX_LIVE_TRADING_ENABLED=false`.**
5. **Set CalSpread `DHAN_LIVE_TRADING_ENABLED=false`.**
6. **Confirm CalSpread is clean at BOTH brokers:** no in-flight Box entry, no
   working Box order, no ambiguous Box order, no unresolved Box order intent, and
   no residual Box exposure at Zerodha AND at Dhan.
7. **Make an explicit ownership decision for any existing Box position.** Either
   close it under CalSpread first, or import it into GTS Box with
   `npm run migrate:box-from-mongo` (dry-run first; it copies state verbatim,
   never marks anything flat) and reconcile each open position/nonterminal intent
   by hand. Decide per position — do not leave it ambiguous.
8. **Stop CalSpread's dedicated Box market feed.**
9. **Keep CalSpread running** only for its remaining, non-Box functions **and its
   two token routes** (`/api/kite/token`, `/api/dhan/token`) — GTS Box depends
   on those for the morning token.
10. **Start GTS Box in paper mode** (the shipped defaults: `paper_latency`,
    all live gates false).
11. **Verify token acquisition** — GTS Box's morning poll fetches the day's
    token from CalSpread; `/api/runtime/status` shows a healthy token.
12. **Verify the dedicated GTS Box feed** — one socket on the active
    broker, ticks flowing.
13. **Verify PostgreSQL restart recovery** — restart GTS Box and confirm it
    reloads open state from PostgreSQL and reconciles cleanly.
14. **Verify Mongo outbox replication** — `/api/export/status` shows the backlog
    draining to Atlas.
15. **Run observation** — shadow / paper_legging / live_parity — long enough to
    trust behaviour against live prices without risking capital.
16. **Only then enable live**, through **all** gates: shared deployment gate
    (`BOX_EXECUTION_MODE=live` + `BOX_LIVE_TRADING_ENABLED=true`), the **per-broker
    gate** for the active broker (`ZERODHA_LIVE_TRADING_ENABLED=true` **or**
    `DHAN_LIVE_TRADING_ENABLED=true`), plus explicit **runtime arming**
    (`POST /api/box/session/arm`).

### Expected socket topology after cutover

- **CalSpread:** its own non-Box feeds as before, **no dedicated Box feed**, and
  it continues to serve the two token routes. **No CalSpread Box live execution.**
- **GTS Box:** exactly **one** dedicated Box market-data socket on the
  **active** broker (never two brokers at once), plus the broker order/HTTP
  connections for the active broker only. One PM2 fork process, one PostgreSQL
  pool, one (optional) Mongo client for the reporting drain.

At no point do both systems hold a live Box order path to the same account. If you
must roll back to CalSpread, reverse the exclusivity the same way: disarm and
disable GTS Box live execution and stop its Box feed **before** re-enabling
CalSpread's.
