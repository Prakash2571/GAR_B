# Conservative Mumbai EC2 profile (`ap-south-1`)

The deliberately over-cautious starting posture for GTS Box live box arbitrage on a
Mumbai EC2 host. It is designed so the FIRST live session risks as little as possible
while producing the broker observations you actually need — not so it trades often.

Read `docs/DEPLOYMENT.md` for PostgreSQL install, migrations, PM2, nginx and the
CalSpread cutover; `docs/RUNBOOK.md` for the trading day; `docs/CONFIGURATION.md` for
every variable and its precedence. This document is the *profile* and the Mumbai/EC2
concerns. The machine-readable starting point is
`deploy/mumbai-ec2-conservative.env.example`.

Every default cited here was read from `src/box/config.ts` (`loadBoxConfig`),
`src/pg/pool.ts` and `src/box/executionSchedulingPolicy.ts` at this commit. Where a
value equals the shipped default it is marked "(default)".

---

## 1. What this profile does and does not promise

**Mumbai hosting guarantees nothing.** Co-locating in `ap-south-1` reduces expected
network round-trip to Zerodha/Dhan endpoints relative to a distant region. It does not
guarantee any latency, any queue position, or any fill rate. The exchange matching
engine, the broker's own infrastructure and your queue position at a price are all
outside this application. A low measured HTTP round trip is not evidence a box will fill.

**Broker data is best-effort.** Neither broker promises lossless delivery, replay after
a disconnect, or exchange sequence numbers (see `docs/BROKER_STREAM_DOCS.md`). Every
reconnect owes a REST reconciliation; REST remains the authority of record.

**A loss breaker is not a guaranteed maximum loss.** `BOX_LIVE_DAILY_LOSS_LIMIT` stops
NEW entries once realised losses cross the threshold. It cannot cap loss on exposure you
already hold, prevent unwind slippage, act faster than the broker confirms fills, or
bound a gap move. Treat it as "stop digging", not "maximum loss".

**No four-leg atomicity.** Four independent orders are submitted; concurrency does not
make them a single exchange transaction. Partial entry is possible and is handled by
protective unwind / attributed reduction, not prevented.

---

## 2. Configuration precedence and the EFFECTIVE runtime surface

### Precedence (lowest to highest)

1. **Code default** — `src/box/config.ts`, `src/config.ts`, `src/pg/pool.ts`.
2. **Process environment** — the `.env` loaded into `process.env` by the process
   manager (or a PM2 `env` block). Higher wins.

There is no separate "config file" layer: a `.env` is loaded INTO the environment
before the code runs, so environment IS the only external source. Two rules make the
effective value differ from what you typed:

- an **out-of-range** numeric value is **clamped** into range (`clampInt`/`clampPct`);
- an **unparseable** value **falls back** to the default (`num`/`bool`), and an
  unrecognised boolean is treated as `false` so a safety gate is never armed by a typo.

Runtime operator API controls (entry arming, execution permission) are a SEPARATE,
session-scoped permission plane. They can withdraw a permission but never widen a
configured numeric limit, and they are reported by `/api/box/status` `.arm`.

### Show the effective values — do not trust the file

A dedicated runtime surface resolves every knob AND reports its provenance
(`default` / `env` / `env_clamped` / `env_invalid_fallback`):

```bash
# On the deployment host, AFTER the same .env is loaded into the environment:
node dist/box/effectiveConfig.js            # human-readable table
node dist/box/effectiveConfig.js --json     # structured, for tooling
```

It reads the SAME `process.env` and applies the SAME parse/clamp rules as
`loadBoxConfig` (a test — `tests/box/effectiveConfig.test.mjs` — asserts the resolved
values equal the loaded config field-for-field, so it cannot drift), and it REFUSES to
report a configuration the process would not boot with (e.g. `BOX_EXECUTION_MODE=live`
without the kill switch exits non-zero). Example: `BOX_LIVE_MAX_OPEN_BOXES=99` is
reported as `20 (env_clamped)` — the value actually in force — not `99`.

`/api/box/status` `.config` also publishes the parsed configuration in force, including
the pacing intervals with their `broker_order_interval_source` provenance and the
capital cap with its metric label. **If the status or the surface disagrees with your
`.env`, they are what is running.**

---

## 3. The conservative profile table

Copy `deploy/mumbai-ec2-conservative.env.example`. Every value below is either a
conservative default or a clearly-marked placeholder. The capital cap is **not** an
approved budget — see §4.

| Setting | Value | Reason |
|---|---|---|
| `BOX_EXECUTION_MODE` | `paper_latency` (default) | Real trading off. `live` is rejected at boot unless the kill switch is also set. |
| `BOX_LIVE_TRADING_ENABLED` | `false` (default) | The independent second gate; both must be set to place a real order. |
| `BOX_SHADOW_MODE_ENABLED` | `false` (default) | Shadow is structurally incapable of placing an order; not needed here. |
| `BOX_PAPER_EXECUTION_PROFILE` | `standard` (default) | `stress` injects synthetic faults and is rejected in live; never near real money. |
| `BOX_LIVE_MAX_OPEN_BOXES` | `1` (default) | One active box. |
| `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS` | `1` (default) | One execution pipeline at a time. |
| `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING` | `true` (code default `false`) | One box per underlying, on top of exact-contract exclusion. |
| `BOX_SESSION_MAX_COMPLETED_TRADES` | `1` (code default `0`) | Explicitly ARM a one-completed-box session; off unless set. |
| `BOX_MAX_CONCURRENT_PER_UNDERLYING` | `1` (code default `2`) | Tightened for early sessions. |
| `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY` | `1` (default) | Benchmark shows 2/4 do not materially help; pacing floor + hedge-first dependency bind. |
| `BOX_LIVE_MAX_OPEN_LEG_QUANTITY` | `100` (default) | Per-leg quantity ceiling; a single lot is well under it. |
| `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY` | `400` (default) | Sum of open leg quantities ceiling. |
| `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` | `100000` **PLACEHOLDER** | GROSS order notional, NOT margin/peak/max-loss. **Set your own approved figure.** |
| `BOX_LIVE_REQUIRE_FUNDS_COVER` | `true` (code default `false`) | Refuse entry unless fresh broker funds cover the requirement. |
| `BOX_LIVE_REQUIRE_MARGIN_EVIDENCE` | `false` (default) | Fails CLOSED until a basket-margin source is wired; leave off until then. |
| `BOX_LIVE_FUNDS_FRESHNESS_MAX_AGE_MS` | `5000` (default) | Funds older than this are not "fresh". |
| `BOX_LIVE_MARGIN_FRESHNESS_MAX_AGE_MS` | `5000` (default) | As above, for planned margin. |
| `BOX_LIVE_DAILY_LOSS_LIMIT` | `5000` (default) | Loss breaker — stops new entry, not a max loss (§1). |
| `BOX_LIVE_REJECT_LIMIT` | `3` (default) | Reject count that trips the breaker. |
| `BOX_LIVE_CONSECUTIVE_FAILURE_LIMIT` | `3` (default) | Consecutive failures that trip the breaker. |
| `BOX_QUOTE_MAX_AGE_MS` | `15000` (default) | How long an UNCHANGED book stays valid (silence ≠ staleness). |
| `BOX_FEED_MAX_AGE_MS` | `5000` (default) | Whole-universe feed liveness; trips → no entry and no auto exit. |
| `BOX_UNDERLYING_MAX_AGE_MS` | `10000` (default) | Underlying spot age for ATM centring. |
| `BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS` | `500` (default) | Primary LIVE coherence gate; always available (Dhan has no book stamp, Kite's is 1s). |
| `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS` | `1000` (code default `250`) | Raised to ≥ Kite's whole-second precision; a sub-second value would reject coherent books. |
| `BOX_MAX_RECEIVE_TO_EXCHANGE_DELAY_MS` | `5000` (default) | Tolerates coarse (1s) exchange stamps + feed lag. |
| `BOX_COHERENCE_ZERO_DISPERSION_DISABLES_IN_LIVE` | `false` (default) | A 0 limit stays impossible-to-satisfy, not a silent bypass. |
| `BOX_LIVE_ORDER_MUTATION_DEADLINE_MS` | `4000` (default) | ONE end-to-end budget per mutation, started before queue admission. |
| `BOX_LIVE_HTTP_TIMEOUT_MS` | `5000` (default) | Transport deadline. |
| `BOX_LIVE_ACK_TIMEOUT_MS` | `3000` (default) | Acknowledgement deadline. |
| `BOX_LIVE_WORKING_TIMEOUT_MS` | `30000` (default) | Working-order deadline. |
| `BOX_LIVE_PARTIAL_TIMEOUT_MS` | `10000` (default) | Partial-fill resolution deadline. |
| `BOX_LIVE_CANCEL_TIMEOUT_MS` | `5000` (default) | Cancel deadline. |
| `BOX_LIVE_MAX_MODIFICATIONS` | `2` (default) | Bounded modifications per order. |
| `BOX_LIVE_MAX_CHASE_TICKS` | `2` (default) | Marketable-limit chase band; not a market order. |
| `BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS` | `0` (default) | Derive the order-mutation interval from the broker floor; a positive override is clamped UP, never below the floor. |
| `BOX_LIVE_BROKER_MIN_INTERVAL_MS` | `250` (default) | General poll/list/margin/health cadence (distinct from the rate limit). |
| `BOX_LIVE_RECONCILE_INTERVAL_MS` | `60000` (default) | Low-frequency broker reconciliation. |
| `BOX_LIVE_FEED_RECONNECT_WARMUP_MS` | `5000` (default) | Quiet period after a feed reconnect before a new entry. |
| `BOX_ORDER_EVENT_QUEUE_PRESSURE` | `512` (default) | Never-drop backpressure THRESHOLD; overload blocks new entry + reconciles, never drops events. |
| `BOX_DURABLE_RESERVATIONS_ENABLED` | `true` (default) | Cross-process contract exclusion via the DB. |
| `BOX_RESERVATION_REQUIRE_DURABLE` | `false` (default) | Single PM2 fork; set `true` for multi-worker so live fails closed without a durable tier. |
| `BOX_INSTRUMENT_LOCK_TTL_MS` | `5000` (default) | Crash-recovery lease bound. |
| `BOX_EXECUTION_COORDINATOR_ENABLED` | `true` (default) | Do not disable while trading. |
| `BOX_INTERNAL_NETTING_ENABLED` | `false` (default) | Must stay off until the ledger can represent virtual ownership. |
| `BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED` | `true` (default) | Event-loop lag monitor (§7); fail-open, never affects trading. |
| `BOX_EXECUTION_TIMING_METRICS_ENABLED` | `true` (default) | Fail-open latency calibration. |
| `BOX_DEPLOYMENT_REGION` | `mumbai` | Stamps calibration datasets; NEVER auto-detected from cloud metadata. |
| `BOX_MIN_EXPECTED_NET_PROFIT` | `1200` (default) | THE entry gate: expected net profit after every cost. |
| `BOX_SAFETY_BUFFER` | `150` (default) | Risk allowance inside the net figure. |
| `ZERODHA_ORDER_STREAM_ENABLED` | `false` (default) | Streams ARE wired (see §5); enable deliberately after supervised REST baseline. |
| `DHAN_ORDER_STREAM_ENABLED` | `false` (default) | As above; Dhan uses a dedicated order-update socket. |
| `PG_POOL_MAX` | `10` (default) | Generous for a single-process app; pool acquisition bounded (§6). |
| `PG_STATEMENT_TIMEOUT_MS` | `5000` (default) | Per-connection; a wedged statement fails, not hangs. |
| `PG_LOCK_TIMEOUT_MS` | `2000` (default) | Bounds lock waits on the order path. |
| `PG_MIGRATE_ON_BOOT` | `true` (default) | `false` = boot refuses on a stale schema. |

---

## 4. The capital cap is a PLACEHOLDER, not an approved budget

`BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` in the example is a placeholder. It is the GROSS
option-order notional of one four-leg box — `SUM(|limit_price × quantity|)` — and it is
**NOT** broker margin, **NOT** peak capital while legging, and **NOT** maximum loss (see
`docs/ECONOMIC_ADMISSION.md`, which explains why conflating notional with margin misleads
by roughly an order of magnitude). The code default is `0` (disabled). You must set your
own approved figure; do not treat the example number as sanctioned. The fresh-funds gate
(`BOX_LIVE_REQUIRE_FUNDS_COVER`) is the evidence-based control and is independent of this cap.

---

## 5. Entry authorization is SEPARATE from exposure-management permission

Two independent controls, and the distinction is the point. Both default to `false`
(`src/box/orderManager.ts:590-591`), so a default process refuses BOTH until armed.

| Control | Governs | Set to |
|---|---|---|
| `entryEnabled` | May a NEW box be entered? | Off outside a supervised window |
| `liveOrderEnabled` | May we act on exposure we ALREADY hold? | **On** whenever exposure can exist |

Verified in code:

- `canEnter()` requires **both** — `src/box/orderManager.ts:813`
  (`if (!this.controls.entryEnabled || !this.controls.liveOrderEnabled) return false;`).
- `canManageExposure()` requires **only** `liveOrderEnabled` —
  `src/box/orderManager.ts:831` (`return !this.disposed && this.controls.liveOrderEnabled;`).
- Attributed reduction hangs off the same permission — `canSafelyReduceAttributedExposure()`
  at `src/box/orderManager.ts:835`.

So you can disarm new entries and still cancel working orders and reduce owned exposure.
`tests/box/effectiveConfig.test.mjs` proves this directly against the real
`BoxOrderManager`: arming only `liveOrderEnabled` leaves `canEnter()===false` while
`canManageExposure()===true`, and disarming entry on a fully-armed manager does not
disable exposure management. **Never disable `liveOrderEnabled` while any exposure or
unresolved order exists** — that strands risk you can no longer manage.

New entries are ALSO refused automatically (not merely warned) on unresolved/unknown
orders, unproven reservation ownership, unsafe residual exposure, failed reconciliation,
and an open circuit breaker — the ENTRY-ONLY gate `evaluateLiveEntryGuard`
(`src/box/liveEntryGuard.ts`), which can never block protective reduction.

---

## 6. Freshness, coherence, timeouts and recovery — and WHY

- **`BOX_QUOTE_MAX_AGE_MS=15000`** — a depth feed only sends on change, so silence is not
  staleness; a resting book is still executable. This bounds an UNCHANGED book, not feed death.
- **`BOX_FEED_MAX_AGE_MS=5000`** — feed liveness across the whole universe; on trip, no
  entry and no automatic exit.
- **Receive-time dispersion (`500`) is the primary LIVE coherence gate**, because Dhan
  publishes no order-book exchange timestamp and Kite's is whole-second. It bounds arrival
  spread across the four legs even when no usable exchange stamp exists.
- **Exchange-time dispersion (`1000`, raised from the `250` default)** applies only when
  every leg carries a real book timestamp. Kite's stamp is whole SECONDS, so any value
  below ~1000 could reject coherent books on quantisation alone. **No sub-second exchange
  threshold is set anywhere** — that would reject valid coarse data
  (`docs/BROKER_STREAM_DOCS.md`).
- **One end-to-end mutation deadline (`4000`)** is started before queue admission
  (`src/brokers/deadline.ts`), so the pacer, HTTP pacing queue, network and response all
  draw on ONE budget; a mutation whose budget lapses while queued transmits nothing.
- **Recovery:** durable intent is written to PostgreSQL BEFORE any transport call, so a
  crash between persist and POST leaves a recoverable record. On boot, reconciliation runs
  before entry is admissible; a reconnect advances the market-data generation and
  invalidates previous-generation executable books (`MarketDataStateMachine`, driven from
  the live feed lifecycle — see `EVIDENCE-marketdata.md`). Feeds use bounded backoff and
  distinguish auth-close from a transient drop.

---

## 7. Stable outbound IP and broker static-IP requirements

Broker API access is commonly bound to a whitelisted static egress IP, and a default EC2
public IP is **not** stable across stop/start.

- Attach an **Elastic IP**, or place the instance behind a **NAT Gateway** with an EIP,
  so outbound broker traffic presents ONE registered address.
- **Dhan requires a DECLARED static IP.** The app verifies it:
  `ActiveBrokerManager.dhanStaticIpReady()` (`src/brokers/registry.ts:972`) and
  `verifyDhanStaticIp()` (`registry.ts:992`) gate Dhan live placement, which is BLOCKED
  until the IP is ready (`registry.ts:1145`). Set `DHAN_STATIC_IP_EXPECTED=true` only once
  the address is actually registered in the Dhan console; the flag is an additional kill
  switch, not a substitute for registration.
- Register the same address with **both** brokers if you run both.
- Re-verify after any resize, AMI change or network reconfiguration:
  `curl -s https://checkip.amazonaws.com`. Confirm the current whitelisting rule in the
  broker console rather than assuming this document is current.

---

## 8. Clock synchronization

Coherence checks, deadlines and audit ordering all depend on the host clock.

- Use **Amazon Time Sync Service** (link-local `169.254.169.123`) via `chrony`.
- Verify: `chronyc tracking` — system time offset well under 50 ms.
- The coherence policy tolerates a bounded exchange-ahead skew precisely because exchange
  stamps are coarse and clocks differ; that tolerance is not licence to run unsynchronised.
  A large offset surfaces as `clock_anomaly` refusals and corrupts every measured span.
- Monotonic time is used for elapsed durations and deadlines (`src/box/executionClock.ts`
  `mono()`/`wall()`), so a clock STEP cannot extend a deadline — but wall-clock stamps in
  the audit trail would still be wrong.

---

## 9. PostgreSQL durability and bounded pool acquisition

PostgreSQL on the same host is the operational authority.

- **Do not** set `synchronous_commit = off`. `src/pg/pool.ts` documents that order-intent
  transitions must be durable before transport; turning it off voids the crash-safety
  argument. `fsync = on`, `full_page_writes = on`. Use an **EBS gp3** volume; do not put
  the data directory on instance store.
- **Bounded pool acquisition:** the pool sets `connectionTimeoutMillis: 10_000` and
  `idleTimeoutMillis: 30_000` (`src/pg/pool.ts`), and every physical connection gets
  `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` on connect,
  so a wedged statement or a saturated pool fails a bounded wait rather than hanging the
  order path.
- `PG_POOL_MAX=10` against a single-process app is generous. Watch `pg_stat_activity` for
  saturation rather than raising it blindly; pool exhaustion shows up as latency on the
  order path.
- Take a base backup plus WAL archiving before the first live session (`docs/DEPLOYMENT.md`).

---

## 10. Monitoring — CPU, memory, event-loop and queue lag

Watch these and alert on them. Wire thresholds to the EXISTING measurements; do not add a
parallel monitor.

| Signal | Why | Where |
|---|---|---|
| Event-loop lag | A blocked loop delays the send guard, deadlines and cancels | `monitorEventLoopDelay` histogram in `src/box/executionEnvironment.ts` (native, no per-turn JS cost) and `EventLoopLagMonitor` in `src/box/metrics.ts:183`; exposed in status `metrics.event_loop_lag_ms` |
| Order-event queue lag | Ingestion backpressure; overload blocks entry | `StagePipeline` depth / oldest-queued age / overload signal (`src/box/boundedQueue.ts`); threshold `BOX_ORDER_EVENT_QUEUE_PRESSURE` |
| Market-data readiness | Entry is gated on per-instrument fresh depth in the current generation | `MarketDataStateMachine`; status `market_data_state` / `market_data_health` |
| CPU steal / credit | A burstable instance that exhausts credits stalls unpredictably | CloudWatch `CPUCreditBalance`, `CPUSurplusCreditBalance` — prefer a non-burstable type |
| Memory / RSS | GC pauses show up as latency outliers | CloudWatch agent; `executionEnvironment` process snapshot |
| DB contention | Lock waits on the order path | `pg_stat_activity`, `pg_locks`, lock-timeout errors |
| Feed age | Distinct time facts | `/api/box/status` `feed_age_ms`, `book_observation_age_ms` |
| Order-stream wiring | Whether fills are stream- or REST-observed | `/api/box/status` `.order_stream.brokers[].fills_observed_by` |
| Unresolved exposure | Entry auto-suspension cause | `residual_exposure_count`, `unknown_orders`, `recovery_active` |

Do not alert on "market data healthy" as a proxy for fill observation — they are different
signals and the status payload says so.

---

## 11. Order-update streams ARE wired (opt-in)

Unlike earlier builds, the order-update stream consumers are constructed and driven from
live execution (see `EVIDENCE-streams-wiring.md`): `OrderStreamConsumer`
(`src/box/orderStreamConsumer.ts`) is built per active broker at engine start, fed from
Kite's market-data socket TEXT frames and Dhan's dedicated order socket, with ownership
registered BEFORE the POST and one deduplicated projection shared with REST snapshots.

They still default OFF. Enable them deliberately after a supervised REST-baseline session
and confirm `/api/box/status` `.order_stream` reports the consumer wired and reconciled.
Neither broker promises replay after a disconnect, so a reconnect always owes a REST
reconciliation; the stream is an additional fast observation path, never the authority.

---

## 12. CalSpread must be disabled first

**Requirement:** CalSpread Box execution MUST be disabled before activating GTS Box
live execution against a shared broker account. Both place orders through the same broker
credentials. If both run:

- Rate-budget ledgers are per-application, so both believe they are within limits while
  the account is throttled.
- Reservations and "one active box" guarantees are per-application, so both can believe
  they hold the only active box.
- Reconciliation may adopt or cancel orders it did not create.

GTS Box cannot detect requests made by another application on the same account. This
is **operational coordination**, not a code guarantee.

**How an operator verifies it before cutover:**

1. Confirm the CalSpread process is stopped: `pm2 list` shows no CalSpread app online (or
   the CalSpread host/service is down).
2. Confirm CalSpread holds no open box or working order on the shared account — check the
   broker console order book and the CalSpread status page; the account order book must
   show no CalSpread-tagged working orders.
3. Only then arm GTS Box. See the cutover procedure in `docs/DEPLOYMENT.md`.

---

## 13. Restart, recovery and rollback (follow under pressure)

### Migration and deployment

```bash
# 1. Back up FIRST (schema + data).
pg_dump --format=custom --file=/backup/strikedge-$(date +%F-%H%M).dump strikedge

# 2. Fetch and verify the release WITHOUT switching to it.
git fetch origin && git log --oneline origin/main -5

# 3. Clean install and build. A type error emits NOTHING (noEmitOnError), so a
#    successful build is meaningful evidence.
npm ci && npm run build

# 4. Run the full suite against a REAL PostgreSQL.
DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge npm test

# 5. Apply migrations (with PG_MIGRATE_ON_BOOT=false, apply explicitly).
npm run migrate

# 6. Confirm the EFFECTIVE config before starting anything.
node dist/box/effectiveConfig.js

# 7. Start in PAPER first. Confirm /api/box/status .config and .order_stream.
pm2 restart strikedge --update-env

# 8. Only then, in a supervised window, arm exposure management, then entry (§5),
#    and watch a single box.
```

### Restart behaviour

- Durable intent is written to PostgreSQL BEFORE any transport call, so a crash between
  persist and POST leaves a recoverable record rather than an invisible order.
- On boot, reconciliation runs before entry is admissible. New entries stay suspended
  while reconciliation is incomplete or unresolved orders exist; exposure management
  remains permitted (§5).
- Under PM2, use a restart policy that does not thrash: a crash loop that restarts
  mid-recovery repeatedly is worse than staying down. Prefer `--max-restarts` with a
  backoff and alert on restart count.
- **After any unclean shutdown with open exposure, reconcile manually before re-arming
  entry.** Automatic reconciliation is designed to be correct, not to be trusted blindly
  on its first live outing.

### Rollback

```bash
# a. Disarm ENTRY first — but leave exposure management ON so you can still act.
#    Use the execution-control API; do NOT just kill the process while exposed.

# b. Confirm flat before touching code.
curl -s localhost:PORT/api/box/status | jq '{open_positions, residual_exposure_count, unknown_orders, recovery_active}'

# c. Only when flat, roll the code back.
git checkout <previous-sha> && npm ci && npm run build && pm2 restart strikedge --update-env

# d. If the release included a migration, restore from the backup rather than
#    hand-reverting schema. Contract version is pinned in contract/version.json; a
#    backend rollback that lowers contract_version REQUIRES a matching frontend
#    rollback, or the SPA validates against a contract the backend no longer emits.
```

**Never roll back while exposure exists.** A rollback that changes recovery logic
underneath live exposure is how a recoverable partial becomes an unrecoverable one.

---

## 14. Required supervised live validation

Nothing in this repository can prove a future trade will fill. Before trusting this
profile, obtain real broker observations for at least: a full four-leg entry with measured
per-leg spans; a partial entry that triggers protective unwind and its realised cost; a
no-fill cancellation; a deliberate rate-limit encounter confirming no mutation is replayed;
a process restart with open exposure confirming reconciliation recovers it; and a
measurement of whether the order-update stream is worth enabling against the REST baseline.
Until those exist, every latency figure is simulated and every fill expectation is unproven.
