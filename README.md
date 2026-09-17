# GTS Algo Research — backend

**GTS Algo Research is an algorithmic trading research project from Ghatsila, developed by
the BeOnEdge team.**

This repository is its **backend**: a Box-arbitrage execution service that scans NSE F&O for
four-leg option Box opportunities, prices them, and — only when several independent gates are
all deliberately enabled AND the runtime is armed — executes them at a broker.

It does **one thing**: Box arbitrage. PostgreSQL is its single operational authority.

> ### ⚠️ This is algorithmic trading research and execution software
>
> Trading involves financial risk, and this software can place **real orders with real money**
> when configured to. A four-leg Box entry is **not atomic** at either broker: hedge-first
> ordering, durable order intents and the reservation layer BOUND the exposure, they do not
> eliminate it. No test result, backtest or paper run is proof of real-money safety.
>
> Nothing here is investment advice, a recommendation, or a claim about returns.

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
  Zerodha (Kite) ───▶│  market data lane   ──▶  scanner            │
  Dhan           ───▶│  (exactly ONE broker active at a time)      │
                    │         │                                    │
                    │         ▼                                    │
                    │   Box engine: pricing, charges, slippage,    │
                    │   economic admission, risk + session gates   │
                    │         │                                    │
                    │         ▼                                    │
                    │   execution coordinator ──▶ order manager    │
                    │   (hedge-first legging, durable intents)     │
                    └──────────┬──────────────────────┬────────────┘
                               │                      │
                    PostgreSQL │ AUTHORITATIVE        │ transactional outbox
                    (intents, reservations,           ▼
                     trades, P&L, sessions)     MongoDB Atlas
                               │                (async reporting replica)
                               ▼
                    HTTP API + SSE  ──▶  the frontend
```

**Repositories**

| Repository | What it is |
| --- | --- |
| `Prakash2571/GTSAlgoResearch_B` | This backend. The sole trading authority. |
| `Prakash2571/GTSAlgoResearch_F` | The public GTS Algo Research site and the protected **GTS Box** workspace. |

The frontend renders what this backend decides. It derives no readiness, no execution mode
and no tradability of its own, and it vendors this repository's `contract/` (pinned by commit
SHA + digest) so a wire-shape change cannot be shipped one-sided.

### Data authority

- **PostgreSQL is authoritative.** Order intents, instrument reservations, trades, trade
  events, execution attempts, P&L and access sessions are durable in PostgreSQL. Every
  operational compare-and-set is a real SQL transaction.
- **MongoDB Atlas is an async reporting replica.** A transactional outbox is drained to Atlas
  by a background projector. Atlas is never on the execution hot path and is **not the backup
  of record** — a lost or unreachable Atlas costs reporting lag, never trading state. See
  `docs/MONGO_PROJECTION.md` and `docs/PG_PERSISTENCE.md`.

---

## Brokers: Zerodha + Dhan

Both are supported, with **exactly one active at a time**. They are never live
simultaneously; switching is an explicit operator action that is **refused while there is
live Box exposure or unresolved broker state**.

This backend performs **its own broker OAuth**, for both brokers, and that is the
default (`BROKER_LOGIN_MODE=in_app`). An operator signs in to Zerodha and/or Dhan
**from the workspace**; the token is minted here, sealed with
`BROKER_TOKEN_ENCRYPTION_KEY` and stored in PostgreSQL. Set
`BROKER_LOGIN_MODE=provider` to keep the previous behaviour of pulling tokens from
an external service instead. Both brokers may hold a session simultaneously; which
one **trades** is a separate, blocker-checked choice (`POST /api/broker/select`).
Instead it fetches the day's access token from the **external CalSpread token routes**
(`/api/kite/token`, `/api/dhan/token`) using a shared passcode, stores it encrypted under
AES-256-GCM, and uses it for the trading day. Acquisition runs on a morning IST poll
(default 09:00). See `docs/BROKER_TOKENS.md`.

Dhan additionally enforces a **static-IP guard**: it refuses to go live from an egress IP
other than the whitelisted `DHAN_STATIC_PUBLIC_IP`.

---

## Authentication and the security model

The workspace is gated by a **single site passcode**, and the boundary is here — in the
backend — not in the browser.

| Route | Purpose |
| --- | --- |
| `POST /api/access/verify` | Check the passcode. On success, mint a session and set the cookies. The only public mutating route; rate-limited to 10 attempts / 5 min / IP. |
| `GET /api/access/status` | Whether the caller holds a live session. Public, so the site can ask "am I already in?" without a 401 loop. |
| `POST /api/access/logout` | Revoke the session row and clear the cookies. |

**How it is enforced**

- `SITE_ACCESS_SECRET` is **backend-only**. It is never sent to the browser, never returned by
  any API, never logged, and has no `VITE_` counterpart. The frontend's CI fails the build if
  that string appears anywhere in the shipped bundle.
- The passcode is compared in **constant time**, and **fails closed**: if the secret is unset,
  verification cannot succeed for any input. An unconfigured deployment is a locked one.
- A wrong passcode and an unset secret return an **identical 401 body**, so the response never
  reveals whether a passcode is configured.
- The session is a **256-bit CSPRNG token in an HttpOnly, Secure, SameSite=Strict cookie**.
  Only its digest is stored, in PostgreSQL, with an expiry. Nothing is stored client-side.
- **CSRF**: a session-bound token is delivered in the response body and must be echoed in the
  `x-csrf-token` **header** on every mutating request. The readable CSRF cookie is never
  accepted as a substitute — a cross-site POST would carry the cookie automatically but cannot
  read it to forge the header. An **exact allowed Origin** is required as well; CORS is
  exact-origin with credentials and never a wildcard.
- Every `/api/box/*` request is authorised **per request**. Frontend routing is UX; a 401 is
  the authority.
- **The passcode arms nothing.** It grants UI access. It does not enable live trading, does not
  arm the session, and does not flip any execution gate.

See `docs/ACCESS_GATE.md`.

---

## Safety: how real orders become possible

Real orders are impossible until **several independent gates are all explicit AND the runtime
is armed**. None of them is the site passcode.

1. **Deployment gate 1 (shared)** — `BOX_EXECUTION_MODE=live` **and**
   `BOX_LIVE_TRADING_ENABLED=true`. `BOX_EXECUTION_MODE=live` without
   `BOX_LIVE_TRADING_ENABLED=true` **refuses to start**.
2. **Deployment gate 2 (per broker)** — the **active** broker's own switch:
   `ZERODHA_LIVE_TRADING_ENABLED=true` or `DHAN_LIVE_TRADING_ENABLED=true`. The inactive
   broker's gate is irrelevant.
3. **Runtime arming** — an operator must arm the trading session
   (`POST /api/box/session/arm`). Disarming is always allowed.
4. **Readiness** — entry is refused unless the backend's own operational-readiness decision
   permits it (market-data state, order-stream/fill observation, reconciliation, recovery,
   durable reservations, economic admission, risk and session budgets).

A verbatim copy of `.env.example` starts the process in **paper** with live trading disabled at
both deployment gates and both per-broker gates.

See `src/box/LIVE_EXECUTION.md`, `docs/SAFETY_INVARIANTS.md` and `docs/FAULT_MATRIX.md`.

---

## Environment setup

```bash
npm ci
cp .env.example .env
```

At minimum set:

| Variable | Why |
| --- | --- |
| `DATABASE_URL` | PostgreSQL. **Not optional** — it is the operational authority. |
| `SITE_ACCESS_SECRET` | The site passcode. Backend-only. `openssl rand -base64 48` |
| `BROKER_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored broker tokens. `openssl rand -hex 32` |
| `FRONTEND_URL` | Exact frontend origin. CORS is exact-origin with credentials, never `*`. |
| `CSRF_ALLOWED_ORIGIN` | Origin required on mutating requests. Defaults to `FRONTEND_URL`. |
| `SESSION_COOKIE_NAME` | HttpOnly session cookie name. Default `gts_session`. |
| `SITE_SESSION_TTL_HOURS` | Session lifetime. Default 24. |
| `KITE_TOKEN_BROKER_PASSCODE` / `DHAN_TOKEN_BROKER_PASSCODE` | Shared passcode for the external token routes. |

Leave every `BOX_*` live gate at its default: you start in **paper**.

Every variable the process reads is documented in **`docs/CONFIGURATION.md`**, which also
lists the identifiers the GTS Algo Research rebrand deliberately did **not** rename and why
(durable reservation namespaces, applied-migration checksums, live database names).

> Never commit a real `.env`. Only `.env.example` is tracked, and it contains placeholders
> only. Secrets are never printed to logs: broker tokens are redacted, and error bodies are
> stripped of SQL and stacks before they leave the process.

---

## Development

```bash
npm run build            # tsc -b → dist/
npm run typecheck        # types only
npm run migrate          # apply pending SQL migrations
npm run migrate -- --check   # assert-only: fails if the schema is behind
npm start                # node dist/index.js
npm run dev              # build then start

node dist/box/effectiveConfig.js   # print the EFFECTIVE resolved config + provenance
```

### Tests

```bash
npm test                 # build + every suite below
npm run test:unit        # Box engine, pricing, charges, execution, state machines
npm run test:invariants  # exit-immunity / protective-cancel invariants
npm run test:access      # the site passcode gate, CSRF, rate limiting
npm run test:contract    # wire-contract shapes + protocol constants
npm run test:tokens      # broker token acquisition, crypto, redaction
npm run test:switch      # active-broker switching and fail-closed restore
npm run test:shutdown    # shutdown coordination
npm run test:readiness   # operational readiness and risk-reduction gating
npm run test:pg          # PostgreSQL integration (needs a real database)
npm run test:projector   # Mongo projector integration (needs a real Mongo)
```

The integration suites need real databases and **fail rather than skip** when they are
missing — a green run that only passed because PostgreSQL was absent would be a lie. CI
provisions real service containers. See `tests/README.md`.

---

## Production deployment

Target: **EC2 Mumbai (`ap-south-1`)** behind **nginx + HTTPS**, run under **PM2**.

```bash
npm ci && npm run build && npm run migrate
pm2 start ecosystem.config.cjs        # fork mode, ONE instance — deliberately not cluster
```

- **nginx** — use `deploy/nginx.conf`. `/api/box/stream` is Server-Sent Events and needs
  `proxy_buffering off`, `proxy_cache off`, a long `proxy_read_timeout` and
  `X-Accel-Buffering: no`, or the live board appears frozen. If nginx also serves the
  frontend, it **must** have the SPA fallback (`try_files $uri $uri/ /index.html`) — the
  frontend has a real `/box` URL, and without the fallback a refresh or bookmark 404s. The
  file documents both topologies. The backend port is never exposed directly.
- **PM2** — `ecosystem.config.cjs` runs **one fork-mode instance** on purpose: the
  in-process reservation tier is only globally authoritative for a single process. More than
  one worker is safe *only* via the durable PostgreSQL reservation tier, and is a deliberate,
  tested change — not a flip of `exec_mode`.
- **Readiness** — `GET /api/health` answers **200** `{"state":"ready","ready":true}` only once
  boot has fully completed, and **503** while starting, after a boot failure, or while
  shutting down. It binds the socket immediately, so it is always reachable; treat 200 as "in
  service" and 503 as "out of service". Mutating routes are refused with 503 until ready.
- **Cookies** — the session cookie is `Secure` in production, so `FRONTEND_URL` must be
  `https` (boot refuses otherwise).

Runtime state: `GET /api/runtime/status`. Projection backlog: `GET /api/export/status`.

Full procedures — PostgreSQL setup, migrations, backup/restore, rollback, the Mumbai profile
— are in **`docs/DEPLOYMENT.md`**, **`docs/MUMBAI_EC2_PROFILE.md`** and **`docs/RUNBOOK.md`**.

---

## Paper-execution calibration variables

The paper execution model calibrates itself from observed timings. These are documented here,
in `.env.example`, in `docs/CONFIGURATION.md` and in `src/box/LIVE_EXECUTION.md`; the defaults
are the shipped specification:

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

---

## Documentation map

| Document | What it covers |
| --- | --- |
| `docs/LIVE_EXECUTION_MAP.md` | **Start here for execution.** Which module acts when, every gate in order, and what happens on success, partial fill, failure, ambiguity and stale data. |
| `docs/CONFIGURATION.md` | Every environment variable, its default, and what breaks if it is wrong. |
| `docs/ACCESS_GATE.md` | The site passcode, sessions, CSRF, rate limiting. |
| `docs/DEPLOYMENT.md` | Production setup, migrations, backup, rollback. |
| `docs/MUMBAI_EC2_PROFILE.md` | The conservative `ap-south-1` profile. |
| `docs/RUNBOOK.md` | Daily operations and incident response. |
| `docs/SAFETY_INVARIANTS.md` | The invariants the execution path must never violate. |
| `docs/FAULT_MATRIX.md` | Failure modes, expected behaviour, and the test that proves it. |
| `docs/BROKER_TOKENS.md` | Token acquisition, encryption, rotation. |
| `docs/BROKER_LIMITS.md`, `docs/BROKER_STREAM_DOCS.md` | Broker rate limits and stream semantics. |
| `docs/PG_PERSISTENCE.md`, `docs/MONGO_PROJECTION.md` | The two storage tiers. |
| `docs/ECONOMIC_ADMISSION.md` | Gross notional vs margin admission. |
| `docs/INTERNAL_SEAMS.md` | The contract between subsystems. |
| `src/box/LIVE_EXECUTION.md` | What live execution does, and what it cannot promise. |
| `contract/README.md` | The versioned wire contract and how to change it safely. |
