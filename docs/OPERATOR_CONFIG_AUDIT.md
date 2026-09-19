# OPERATOR CONFIGURATION AUDIT

**Status:** Phase 1 deliverable — audit only. No behaviour has been changed by this document.
**Scope:** `Prakash2571/GAR_B` @ `ffa1847` (`main`), cross-referenced against `Prakash2571/GAR_F` @ `main`.
**Purpose:** establish, before any code moves, exactly which configuration inputs exist, who consumes
them, *when* their value is captured, and which of them may safely become runtime operator
configuration.

---

## 1. Why this audit exists

The backend currently has **213 environment variables declared in `.env.example`, all of which are
genuinely read by `src/**`** — there are no dead variables to delete. **135 of those are
`BOX_*`/`MIN_BOX_*` strategy, risk, execution and tuning knobs**, and **131 individual field mappings
are parsed inside `loadBoxConfig()` in `src/box/config.ts` alone**.

The operational consequence is the problem statement: changing an ordinary strategy or risk parameter
— an entry threshold, a capital cap, an inventory ceiling — currently requires editing a server `.env`
file and restarting the process. That is error-prone in exactly the moment it matters most, and the
`.env` file has become the single undifferentiated home for four genuinely different kinds of
authority.

This audit separates those four kinds of authority so the refactor can put each in the right place.

### Method

Every variable was traced to its actual consumer, not classified by name. Concretely:

- `process.env` direct reads: 48 occurrences across 27 files.
- Helper-parsed reads in `src/box/config.ts`: `num`, `bool`, `clampInt`, `strictLimitInt`,
  `nonNegativeNum`, `strictBool`, `clampPct`, `paperProfile`, `executionMode`, `queueModel`,
  `latencyMode`, `msSamples`, `periodMs`, `hours`, `clampHour` — 131 field mappings extracted
  mechanically from the `loadBoxConfig()` object literal.
- Reads via the `env` parameter pattern (`loadAppConfig(env = process.env)`) in `src/config.ts`,
  `src/pg/pool.ts`, `src/outbox/mongo.ts`.
- Each candidate setting was then followed to its *enforcement point* to determine whether changing it
  mid-process is safe. This is the part that cannot be done by name.

---

## 2. The existing security classification (reuse, do not reinvent)

`src/env/secrets.ts` already defines the right taxonomy and it must remain the authority:

| Class | Meaning | Treatment |
|---|---|---|
| `secret` | A credential. | Never printed, never returned over HTTP, belongs in the protected secrets file. |
| `identity` | Names a real account/key/host but cannot authenticate. | Masked in diagnostics (`AB••34`); may live in `.env`. |
| `config` | Non-sensitive operational configuration. | May be shown in full — that is the point. |

`EXPLICIT_ENV_CLASS` enumerates the entire non-`config` surface. The runtime-configuration subsystem
must **refuse to register any key whose `EnvClass` is `secret` or `identity`**, enforced by a test
rather than by convention.

### Category A — SECRET (never exposed, never runtime-configurable)

`SITE_ACCESS_SECRET`, `BROKER_TOKEN_ENCRYPTION_KEY`, `BROKER_TOKEN_OLD_KEY`, `BROKER_TOKEN_NEW_KEY`,
`TOKEN_EXPOSURE_KEY`, `DATABASE_URL`, `MONGODB_URI`, `LEGACY_BOX_MONGODB_URI`, `KITE_API_KEY`,
`KITE_API_SECRET`, `KITE_TOKEN_BROKER_PASSCODE`, `DHAN_API_KEY`, `DHAN_API_SECRET`,
`DHAN_TOKEN_BROKER_PASSCODE`, `GTS_SECRETS_FILE` (path to the secrets file).

Identity-class (masked, still not runtime-configurable): `KITE_API_KEY_EXPECTED`, `DHAN_CLIENT_ID`,
`DHAN_CLIENT_ID_EXPECTED`, `DHAN_STATIC_PUBLIC_IP`, `DHAN_STATIC_IP_EXPECTED`.

**These must not appear in the operator-config API at all — not even masked.** There is no operational
reason to round-trip them through a browser, and a masked field is still a field an
over-broad serialiser can un-mask.

---

## 3. The capture-semantics map — the most important finding

There is **exactly one `BoxConfig` object per process**. `loadBoxConfig()` (`src/box/config.ts:1157`)
builds it once; the engine assigns it at `src/box/engine.ts:909` and passes it **by reference** to the
simulator, gateway, coordinator, scanner and position monitor. It is **not** `Object.freeze`d, and it
is deliberately mutated in place in exactly one function.

That single design fact determines the whole refactor, because it means most knobs are read *live, per
use*, and a handful are *copied* and therefore frozen. Mixing the two up is how a configuration
refactor silently widens a live limit.

### 3.1 Live-read (visible on the next evaluation)

Read through `this.cfg.X` / `this.deps.cfg.X` at point of use. Changing the field on the shared object
takes effect immediately:

- Strategy economics: `minExpectedNetProfit`, `safetyBuffer`, `minGrossEdge`, `minNetEdge`,
  `expectedEntrySlippage`, `expectedExitSlippage` (`src/box/math.ts:628`, `src/box/scanner.ts:813`,
  `1033`).
- Coordinator entry prologue (all live): `maxOpenBoxes`, `oneActiveBoxPerUnderlying`,
  `maxConcurrentPerUnderlying`, `liveMaxOpenLegQuantity`, `liveMaxGrossOpenLegQuantity`,
  `reservationRequireDurable`, `conflictRevalidateMinEdgeRatio`
  (`src/box/executionCoordinator.ts:719`–`1014`).
- Freshness/coherence: `quoteMaxAgeMs`, `maxCrossLegReceiveDispersionMs`,
  `maxCrossLegExchangeDispersionMs`, `maxReceiveToExchangeDelayMs`. The coherence policy is rebuilt
  **per call** (`executionGateway.ts:2052`, `2062`; `executionSimulator.ts:745`), so these are live.
- Capital cap **at admission**: `executionGateway.ts:1668-1691` reads
  `cfg.liveMaxBoxCapitalRupees` / `cfg.paperMaxBoxCapitalRupees` live.

### 3.2 Construction-time value copies (frozen until the owner is rebuilt)

`orderManagerLimitsFromConfig(cfg)` (`src/box/orderManager.ts:425-441`) copies **twelve** limits into a
new object at `BoxOrderManager` construction (`engine.ts:1206`), which happens on live adapter wiring
and is re-taken on a broker switch:

`liveMaxOpenBoxes`, `liveMaxConcurrentExecutions`, `liveEntrySubmitConcurrency`,
`liveMaxBoxCapitalRupees`, `liveMaxResidualLegs`, `liveDailyLossLimit`, `liveRejectLimit`,
`liveConsecutiveFailureLimit`, `liveMaxOpenLegQuantity`, `liveMaxGrossOpenLegQuantity`,
`liveReconcileIntervalMs`, `liveFeedReconnectWarmupMs`.

Also copied at construction: `MarketDataStateMachine` ages (`heartbeatMaxAgeMs: cfg.feedMaxAgeMs`,
`bookMaxAgeMs: cfg.quoteMaxAgeMs`, `engine.ts:954-962`), the ingest queue capacity
(`orderEventQueuePressureThreshold`, `engine.ts:969`), the account-funds freshness bound
(`engine.ts:1490`), `this.baseMinGrossEdge` (`engine.ts:916`), and both broker adapter configs
(`kiteBrokerAdapter.ts:447`, `dhanBrokerAdapter.ts:168`) including `enabled: cfg.liveTradingEnabled`.

### 3.3 The dual-authority hazard (must be designed for, not ignored)

Four settings are read **both** live *and* from a frozen copy. These are the dangerous ones:

| Setting | Live read | Frozen copy | Consequence of a naive runtime raise |
|---|---|---|---|
| `liveMaxBoxCapitalRupees` | gateway admission (`executionGateway.ts:1668`) | order-manager dequeue re-check (`orderManager.ts:1934-1949`) | Admission accepts the larger box; the dequeue re-check refuses against the **old lower** copy. The entry dies at transmission **having already spent a session attempt**. |
| `liveMaxOpenLegQuantity` | coordinator prologue (`executionCoordinator.ts:859-925`) | `quantityLimitBlockReason` (`orderManager.ts:2547`, `3731`) | Same shape: early check passes, send boundary refuses. |
| `liveMaxGrossOpenLegQuantity` | coordinator prologue | order-manager quantity envelope | Same. |
| `quoteMaxAgeMs` | scanner/gateway/coordinator per evaluation | `MarketDataStateMachine` bookMaxAgeMs | Feed-health lifecycle and candidate admission would disagree about staleness. |

**Design conclusion:** a runtime mutation of any of these must either (a) be refused unless the system
is flat and disarmed, or (b) atomically republish the derived copies. Option (b) means giving
`BoxOrderManager` a `setLimits()` and re-deriving the market-data ages — real work, and it must be done
deliberately rather than by accident.

### 3.4 Session-snapshotted (category E) — frozen at ARM

`sessionMaxCompletedTrades` and `sessionMaxEntryAttempts` are the **only** two values captured at
session arm. The env value is consulted *only* inside `armLocked()`
(`src/box/tradingSessionStore.ts:351-397`); every per-attempt decision compares counters against the
**durable record's** `max_completed_trades` / `max_entry_attempts`
(`src/box/tradingSession.ts:195-213`, `367-396`).

The route documents the invariant explicitly (`src/box/routes.ts:433-476`):

> The session record SNAPSHOTS both ceilings at arm time, so `BOX_SESSION_MAX_ENTRY_ATTEMPTS` in the
> environment does not retroactively bind a session that was already armed.

One live read survives arming: `enforcing()` (`tradingSessionStore.ts:288-304`) consults *current*
config to decide whether the session layer has any opinion at all. Raising a ceiling from `0` can
therefore switch the layer **on** mid-process; it can never widen an armed session's ceilings.

**This is a safety property and must be preserved exactly.** The refactor must not route session
ceilings through a live read at attempt time.

### 3.5 Per-trade freeze

`configSnapshot(cfg)` (`src/box/config.ts:1616-1675`) writes ~60 values onto every trade document at
establishment (`engine.ts:4344`) as `scanner_config_snapshot`. This is what keeps an execution
interpretable after a retune, and it already includes the operator-facing fields
(`min_expected_net_profit`, `safety_buffer`, `live_max_box_capital_rupees`,
`session_max_entry_attempts`, `max_cross_leg_receive_dispersion_ms`, …). **It needs no change**, but
any new runtime setting that affects admission should be added to it.

---

## 4. The existing runtime-config mechanism (to be generalised, not duplicated)

Today exactly **two** knobs are runtime-mutable and persisted:

```ts
// src/box/config.ts:1093
export interface BoxTuning {
  minExpectedNetProfit: number;   // THE ENTRY GATE (₹)
  safetyBuffer: number;           // risk allowance inside the expected-net figure (₹)
}
export const BOX_TUNING_LIMITS = {          // config.ts:1101 — iteration source of truth
  minExpectedNetProfit: { min: 0, max: 1_000_000 },
  safetyBuffer:         { min: 0, max: 1_000_000 },
};
export const BOX_TUNING_KEYS = {            // config.ts:1152 — stable persisted names
  minExpectedNetProfit: "min_expected_net_profit",
  safetyBuffer: "safety_buffer",
};
```

Persistence — `migrations/003_box_pnl_settings_session.sql:82-89`:

```sql
CREATE TABLE IF NOT EXISTS box_settings (
  key        text        PRIMARY KEY,
  value      numeric     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Read/write: `loadBoxSettings()` / `saveBoxSettings()` (`src/box/repository.ts:3042-3077`). Apply path:
`applyTuning()` (`engine.ts:2568-2576`) mutates the shared cfg and re-derives the prefilter from the
immutable `baseMinGrossEdge` captured at construction. HTTP: `POST /api/box/settings`
(`routes.ts:121-148`).

### 4.1 Gaps this refactor must close

1. **`value numeric NOT NULL` cannot hold booleans, enums or strings.** Migration `012` already
   documented this constraint as its reason for *not* reusing `box_settings`. A `013_*.sql` must add a
   JSON-typed column; migration `003` **cannot be edited** (the runner enforces sha256 immutability,
   `src/pg/migrate.ts:70-77`).
2. **No version column, no actor column, no audit/history table.** Only `updated_at`.
3. **`loadBoxSettings()` swallows errors to an empty Map** — "DB unreachable" and "no rows" are
   indistinguishable. For safety-critical keys this must become a discriminated result, following the
   existing `loadBoxExcludedUnderlyings()` precedent (`repository.ts:3086+`) which fails closed.
4. **DB unconditionally overrides env, with no containment.** A persisted
   `min_expected_net_profit = 0` today *lowers* the entry gate below an env-configured ₹1,200. There is
   no `min()`/`max()` composition step anywhere in the codebase. This is precisely the
   "do not blindly implement DB-always-wins" hazard.
5. **`POST /api/box/settings` is `requireOperator` only** — not `requireFull`. A `trade`-role operator
   can move the live entry gate today, while editing the blocklist requires full admin. Risk-affecting
   keys must move behind `requireFull`.
6. **`src/box/effectiveConfig.ts` is a CLI-only pre-flight tool** with no DB awareness. It already
   reports `source: "env"` for the two values the DB may have overridden — i.e. it is *already* wrong,
   and will get more wrong as keys move. It needs a `runtime`/`db` provenance and the persisted map fed
   in.
7. **No cross-process invalidation.** Two backend instances would not see each other's setting change
   until restart.

---

## 5. The live-capability gating model (must survive unchanged)

Four independent gates that **AND** together. None may become runtime-writable.

1. **`BOX_EXECUTION_MODE`** — decides which execution engine is *constructed*. Startup-only, immutable
   for process life (`src/box/liveModeTransition.ts:9-31`). Unrecognised values are refused, not
   defaulted (`src/env/validate.ts:148-160`).
2. **`BOX_LIVE_TRADING_ENABLED`** — enforced three times: hard `process.exit(1)` at boot
   (`src/index.ts:183-196`), a throw inside `loadBoxConfig()` (`config.ts:1158-1164`), and copied into
   both adapter configs as `enabled`, where the Kite send predicate is
   `executionMode === "live" && enabled === true` (`kiteBrokerAdapter.ts:1690`).
3. **`ZERODHA_LIVE_TRADING_ENABLED`** / 4. **`DHAN_LIVE_TRADING_ENABLED`** — per-broker gates,
   re-read from `process.env` on **every** call (`registry.ts:1752-1782`) and enforced by **refusing to
   build the live adapter at all** (`registry.ts:2359-2395`). With no adapter there is no transport.

Additional boot refusals that are effectively capability gates (all in `config.ts:1158-1232`):
`mode=live` + `BOX_PAPER_EXECUTION_PROFILE=stress`; `mode=live` + `BOX_SHADOW_MODE_ENABLED`;
`mode=live` + `BOX_EXECUTION_COORDINATOR_ENABLED=false` (because the coordinator's prologue is the
*only* enforcement point for `BOX_MAX_OPEN_BOXES`, the session attempt budget,
`BOX_ONE_ACTIVE_BOX_PER_UNDERLYING`, the duplicate guard and all instrument reservations).

> **Note a real divergence worth preserving deliberately:** `src/index.ts:183-186` captures its four
> booleans **once at module load** for the readiness-blocker report, while the registry gate **re-reads
> env live**. The blocker report can therefore be staler than the gate. The frontend displays the
> blocker report; it must not be presented as the authority.

### Category C — HARD SAFETY / EXECUTION CAPABILITY (env/deployment only, display-only in UI)

`BOX_EXECUTION_MODE`, `BOX_LIVE_TRADING_ENABLED`, `ZERODHA_LIVE_TRADING_ENABLED`,
`DHAN_LIVE_TRADING_ENABLED`, `BOX_SHADOW_MODE_ENABLED`, `BOX_EXECUTION_COORDINATOR_ENABLED`,
`BOX_RESERVATION_REQUIRE_DURABLE`, `BOX_DURABLE_RESERVATIONS_ENABLED`, `BOX_LEG_EXECUTION_MODE`,
`BOX_INTERNAL_NETTING_ENABLED`.

Runtime controls may only **remove** permission beneath this ceiling (the existing `entryEnabled` /
`liveOrderEnabled` session controls already work this way). They must never widen it.

### Category B — DEPLOYMENT / INFRASTRUCTURE (env only, not on the trading screen)

`PORT`, `NODE_ENV`, `APP_TIMEZONE` (pinned to `Asia/Kolkata`, refuses anything else), `FRONTEND_URL`,
`CSRF_ALLOWED_ORIGIN`, `SESSION_COOKIE_NAME`, `SITE_SESSION_TTL_HOURS`, `SHUTDOWN_TIMEOUT_MS`,
`PG_MIGRATE_ON_BOOT`, `PG_POOL_MAX`, `PG_STATEMENT_TIMEOUT_MS`, `PG_LOCK_TIMEOUT_MS`,
`PG_APPLICATION_NAME`, all `MONGO_EXPORT_*`, `BOX_TRUSTED_PROXY_IPS`, `CALSPREAD_DEPLOYMENT_ID`,
`CALSPREAD_INSTANCE_ID`, `BOX_DEPLOYMENT_REGION`, `BOX_EXECUTION_CALIBRATION_REGION`, all
`KITE_*_URL` / `KITE_API_ROOT` / `KITE_HTTP_TIMEOUT_MS`, all `DHAN_AUTH_*` / `DHAN_CONSENT_*` /
`DHAN_TOKEN_URL` / `DHAN_POSTBACK_URL` / `DHAN_REDIRECT_URL`, `DHAN_DATA_ENABLED`,
`ZERODHA_ORDER_STREAM_ENABLED`, `DHAN_ORDER_STREAM_ENABLED`, `BROKER_TOKEN_POLL_*`,
`AUTO_FALLBACK_TO_DHAN`, `BOX_STT_TYPE`, `BOX_CHARGE_RATE_VERSION`, `DHAN_CHARGE_RATE_VERSION`.

---

## 6. Proposed classification and mutation policy

Policies as defined in the brief: `HOT_SAFE`, `TIGHTEN_ONLY_WHILE_ARMED`, `FLAT_AND_DISARMED`,
`NEXT_SESSION`, `RESTART_REQUIRED`.

"Tighten" is defined **per setting**, by direction of risk — not by numeric direction. For a threshold
(`minExpectedNetProfit`) tightening means *raising*; for a ceiling (`maxOpenBoxes`) it means
*lowering*; for a freshness bound it means *shortening*.

### 6.1 Category D — STRATEGY (operator runtime config)

| Domain key | Env (legacy bootstrap) | Current capture | Policy | Notes |
|---|---|---|---|---|
| `minExpectedNetProfit` | `BOX_MIN_EXPECTED_NET_PROFIT` | live; already DB-backed | `TIGHTEN_ONLY_WHILE_ARMED` | Raising is safe; lowering admits worse trades. Already re-derives `minGrossEdge`. |
| `safetyBuffer` | `BOX_SAFETY_BUFFER` | live; already DB-backed | `TIGHTEN_ONLY_WHILE_ARMED` | Raising is safer. |
| `minGrossEdge` | `MIN_BOX_GROSS_EDGE` | live, clamped by `baseMinGrossEdge` | `TIGHTEN_ONLY_WHILE_ARMED` | Prefilter only; must stay ≤ required net. |
| `minNetEdge` | `MIN_BOX_NET_EDGE` | live | `TIGHTEN_ONLY_WHILE_ARMED` | Legacy stricter floor; `requiredNetProfit` takes the max. |
| `expectedEntrySlippage` | `BOX_EXPECTED_ENTRY_SLIPPAGE` | live | `TIGHTEN_ONLY_WHILE_ARMED` | **Lowering makes expected profit look larger** → risk-increasing. |
| `expectedExitSlippage` | `BOX_EXPECTED_EXIT_SLIPPAGE` | live | `TIGHTEN_ONLY_WHILE_ARMED` | Same. |
| `strikeLevel` | `BOX_STRIKE_LEVEL` | live (1..3) | `FLAT_AND_DISARMED` | Changes which contracts are subscribed; changing mid-session makes fills incomparable. |
| `atmHysteresis` | `BOX_ATM_HYSTERESIS` | live | `HOT_SAFE` | Window-churn damping. |
| `enableShortBox` | `BOX_ENABLE_SHORT_BOX` | live, `strictBool` | `FLAT_AND_DISARMED` + `dangerous` | Enabling admits a whole additional direction. |
| `convergenceFloor` | `BOX_CONVERGENCE_FLOOR` | live | `HOT_SAFE` | Exit-target input. |
| `convergencePct` | `BOX_CONVERGENCE_PCT` | live | `HOT_SAFE` | |
| `minExitNetPnl` | `BOX_MIN_EXIT_NET_PNL` | live | `HOT_SAFE` | **See §7** — this is a profit-taking target, *not* a protective-exit gate. Must be proven not to gate emergency paths. |
| `profitCapturePct` | `BOX_PROFIT_CAPTURE_PCT` | live | `HOT_SAFE` | |
| `minCapturedPct` | `BOX_MIN_CAPTURED_PCT` | live | `HOT_SAFE` | |
| `exitUseRealisableNet` | `BOX_EXIT_USE_REALISABLE` | live | `HOT_SAFE` | |
| `expirySafetyMinutes` | `BOX_EXPIRY_SAFETY_MINUTES` | live | `TIGHTEN_ONLY_WHILE_ARMED` | Lowering permits entry closer to expiry. |

### 6.2 Category D — RISK

| Domain key | Env | Current capture | Policy | Notes |
|---|---|---|---|---|
| `maxOpenBoxes` | `BOX_MAX_OPEN_BOXES` | **live**, coordinator prologue — sole enforcement point | `TIGHTEN_ONLY_WHILE_ARMED` | Lowering is honoured immediately. Raising → `FLAT_AND_DISARMED`. `0` = unlimited; `strictLimitInt`. |
| `oneActiveBoxPerUnderlying` | `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING` | **live**, 3 layers | `TIGHTEN_ONLY_WHILE_ARMED` | Enabling = tightening. **Disabling is `FLAT_AND_DISARMED` + `dangerous`**; `engine.ts:5925-5928` already anticipates disable-then-enable producing two boxes on one name. |
| `maxConcurrentPerUnderlying` | `BOX_MAX_CONCURRENT_PER_UNDERLYING` | live | `TIGHTEN_ONLY_WHILE_ARMED` | `0` disables. |
| `maxBoxCapitalRupees` (live) | `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` | **dual** (§3.3) | `FLAT_AND_DISARMED` | Raising while armed is the worst case in §3.3 — burns an attempt at the send boundary. Must be refused, or the order-manager copy republished atomically. |
| `maxBoxCapitalRupees` (paper) | `BOX_PAPER_MAX_BOX_CAPITAL_RUPEES` | live (gateway) | `HOT_SAFE` | Paper only. |
| `liveMaxOpenBoxes` | `BOX_LIVE_MAX_OPEN_BOXES` | frozen copy | `FLAT_AND_DISARMED` | Distinct from `maxOpenBoxes`; read from a count refreshed only *after* a position exists. |
| `dailyLossLimit` | `BOX_LIVE_DAILY_LOSS_LIMIT` | frozen copy | `TIGHTEN_ONLY_WHILE_ARMED` (lower) / `FLAT_AND_DISARMED` (raise) | Requires a limits-republish path to take effect while armed. |
| `maxResidualLegs` | `BOX_LIVE_MAX_RESIDUAL_LEGS` | frozen copy | `FLAT_AND_DISARMED` | |
| `rejectLimit` / `consecutiveFailureLimit` | `BOX_LIVE_REJECT_LIMIT`, `..._CONSECUTIVE_FAILURE_LIMIT` | frozen copy | `FLAT_AND_DISARMED` | Breaker sensitivity. |
| `maxOpenLegQuantity` / `maxGrossOpenLegQuantity` | `BOX_LIVE_MAX_OPEN_LEG_QUANTITY`, `..._GROSS_...` | **dual** (§3.3) | `FLAT_AND_DISARMED` | |
| `liveMaxConcurrentExecutions` | `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS` | frozen copy | `FLAT_AND_DISARMED` + `dangerous` | 1..4. |
| `requireFundsCover` / `requireMarginEvidence` / `requireStageFunding` | `BOX_LIVE_REQUIRE_*` | live | `TIGHTEN_ONLY_WHILE_ARMED` | Enabling = tightening. **Disabling is risk-increasing.** |
| `recoveryReserveRupees` | `BOX_LIVE_RECOVERY_RESERVE_RUPEES` | live | `TIGHTEN_ONLY_WHILE_ARMED` | |

### 6.3 Category E — SESSION-SNAPSHOTTED

| Domain key | Env | Policy | Notes |
|---|---|---|---|
| `sessionMaxCompletedTrades` | `BOX_SESSION_MAX_COMPLETED_TRADES` | `NEXT_SESSION` | Stored as configured value; the **armed record is never mutated**. UI must show configured vs armed separately. |
| `sessionMaxEntryAttempts` | `BOX_SESSION_MAX_ENTRY_ATTEMPTS` | `NEXT_SESSION` | Same. Note `enforcing()` may switch the layer on from `0`. |

### 6.4 Category D — MARKET DATA

| Domain key | Env | Capture | Policy |
|---|---|---|---|
| `quoteMaxAgeMs` | `BOX_QUOTE_MAX_AGE_MS` | **dual** (§3.3) | `TIGHTEN_ONLY_WHILE_ARMED` (shorten); loosening `FLAT_AND_DISARMED` |
| `feedMaxAgeMs` | `BOX_FEED_MAX_AGE_MS` | frozen (state machine) | `FLAT_AND_DISARMED` |
| `underlyingMaxAgeMs` | `BOX_UNDERLYING_MAX_AGE_MS` | live | `TIGHTEN_ONLY_WHILE_ARMED` |
| `maxCrossLegReceiveDispersionMs` | `BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS` | live (rebuilt per call) | `TIGHTEN_ONLY_WHILE_ARMED` — **the primary live coherence gate** |
| `maxCrossLegExchangeDispersionMs` | `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS` | live | `TIGHTEN_ONLY_WHILE_ARMED` |
| `maxReceiveToExchangeDelayMs` | `BOX_MAX_RECEIVE_TO_EXCHANGE_DELAY_MS` | live | `TIGHTEN_ONLY_WHILE_ARMED` |
| `coherenceZeroDispersionDisablesInLive` | `BOX_COHERENCE_ZERO_DISPERSION_DISABLES_IN_LIVE` | live | `FLAT_AND_DISARMED` + `dangerous` |

**UI requirement carried from the code comments:** `config.ts:1470-1500` explains at length that Kite's
book timestamp is **epoch seconds**, so exchange dispersion can only ever measure 0, 1000, 2000 ms —
any threshold below ~1000 ms is unsatisfiable-by-noise, and a 250 ms setting produced 100 % refusals.
The Market Data screen must state this, because the number looks tighter and is actually broken.

### 6.5 Category D — PAPER / CALIBRATION (paper only ⇒ `HOT_SAFE` in paper, `RESTART_REQUIRED` in live)

`paperExecutionProfile`, `paperMaxConcurrentExecutions`, `paperLatencyMode`, `paperLatencySeed`,
`paperLatencySamples`, `paperLatencyAckToTerminalSamples`, `paperCalibrationMinSamples`,
`paperCalibrationBucketMinSamples`, `paperCalibrationMaxAgeMs`, `paperCalibrationTimeBuckets`,
`paperCancelLatencyMs`, `paperPersistenceMs`, `simulatedDecisionMs`, `simulatedLatencyMs`.

`BOX_PAPER_EXECUTION_PROFILE=stress` must remain impossible to combine with live — the boot refusal
stays, and the runtime API must refuse the value when `executionMode === "live"`.

### 6.6 Category D — UNIVERSE / SCANNER

`maxUnderlyings` (`BOX_MAX_UNDERLYINGS`, 0 = unbounded), `maxSubscribedTokens`,
`indicativeMaxUnderlyings`, `indicativeDiscovery`, `maxPublishedOpportunities`, `windowMinIntervalMs`,
`universeRefreshMs`, `indicativeRefreshMs`. Policy `HOT_SAFE`, except `maxSubscribedTokens` and
`maxUnderlyings` which should be `TIGHTEN_ONLY_WHILE_ARMED` (raising them widens broker rate-limit
pressure on the feed the whole strategy depends on). Changing any of these must trigger the existing
universe-refresh quartet used by `applyExclusionChange()` (`engine.ts:2519-2531`).

The existing exclusions/blocklist surface (`box_excluded_underlyings`, migration `012`,
`UniversePicker`) is already a correctly-designed runtime operator control. **Keep it as-is**; do not
fold it into the generic key/value store — its per-entry provenance is exactly why migration `012`
declined to reuse `box_settings`.

### 6.7 Category D — CHARGE MODEL (operator-facing subset)

`requirePricedCharges` (`TIGHTEN_ONLY_WHILE_ARMED` — disabling admits unpriced charges),
`prefilterChargeAllowance` (`HOT_SAFE`), `reconcileCharges` (`HOT_SAFE`),
`chargeReconcileWarnPct` (`HOT_SAFE`). `BOX_STT_TYPE` and `*_CHARGE_RATE_VERSION` stay deployment-side
(category B) — they describe a statutory rate card, not an operator preference.

### 6.8 Category F — INTERNAL IMPLEMENTATION / TUNING (stay env; `RESTART_REQUIRED`, read-only in UI)

These are the ones the brief explicitly warns against moving. Keeping them out is the difference
between reducing operator complexity and moving the `.env` into a web form:

Reservation machinery (`BOX_INSTRUMENT_LOCK_TTL_MS`, `BOX_RESERVATION_RENEW_INTERVAL_MS`,
`BOX_RESERVATION_CLOCK_SKEW_GRACE_MS`, `BOX_RESERVATION_UNCERTAIN_HOLD_MAX_MS`,
`BOX_RESERVATION_OWNERSHIP_MARGIN_MS`, `BOX_CONFLICT_WAIT_MAX_MS`,
`BOX_CONFLICT_REVALIDATE_MIN_EDGE_RATIO`); transport/pacing (`BOX_LIVE_BROKER_MIN_INTERVAL_MS`,
`BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS`, `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY`); all live
timeouts (`BOX_LIVE_HTTP_TIMEOUT_MS`, `..._ACK_...`, `..._WORKING_...`, `..._PARTIAL_...`,
`..._CANCEL_...`, `..._ORDER_MUTATION_DEADLINE_MS`); chase/queue pricing
(`BOX_LEG_MAX_CHASE_TICKS`, `BOX_UNWIND_MAX_CHASE_TICKS`, `BOX_LIVE_MAX_CHASE_TICKS`,
`BOX_LIVE_MAX_MODIFICATIONS`, `BOX_QUEUE_MODEL`, `BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT`,
`BOX_DEFAULT_TICK_SIZE`); loops and metrics (`BOX_MONITOR_INTERVAL_MS`, `BOX_PERSIST_INTERVAL_MS`,
`BOX_PUBLISH_INTERVAL_MS`, `BOX_EXECUTION_MAX_WAIT_MS`, `BOX_EXECUTION_POLL_MS`,
`BOX_METRICS_WINDOW`, `BOX_EXECUTION_TIMING_*`, `BOX_LIVE_TIMING_*`,
`BOX_ORDER_EVENT_QUEUE_PRESSURE`); caches (`BOX_PNL_CACHE_*`, `BOX_CLOSED_CACHE_*`,
`BOX_CHARGE_CACHE_TTL_MS`, `BOX_CHARGE_CONCURRENCY`, `BOX_CHARGE_RECONCILE_CONCURRENCY`,
`BOX_CHARGE_RECONCILE_MAX_ATTEMPTS`, `BOX_CHARGE_RECONCILE_RETRY_BASE_MS`); reconciliation
(`BOX_LIVE_RECONCILE_INTERVAL_MS`, `BOX_LIVE_FEED_RECONNECT_WARMUP_MS`); evidence plumbing
(`BOX_LIVE_EVIDENCE_READ_TIMEOUT_MS`, `..._FUTURE_SKEW_GRACE_MS`, `..._CONCURRENT_READS`,
`BOX_LIVE_FUNDS_FRESHNESS_MAX_AGE_MS`, `BOX_LIVE_MARGIN_FRESHNESS_MAX_AGE_MS`); diagnostics
(`BOX_ACCOUNT_FUNDS_*`, `BOX_DEDICATED_MARKET_FEED`, `BOX_PNL_ARCHIVE_HOUR`,
`BOX_PNL_VERIFY_HOURS`, `BOX_PNL_ARCHIVE_DRAIN_DELAY_MS`, `BOX_EXPIRY_*` diagnostics).

### 6.9 Category G — OBSOLETE / UNUSED

**Empty.** Every one of the 213 variables declared in `.env.example` is referenced by `src/**`.
Five variables are read but *undocumented* in `.env.example` and should be added to it:
`BOX_TRUSTED_PROXY_IPS`, `KITE_HTTP_TIMEOUT_MS`, `ZERODHA_ORDER_STREAM_ENABLED`,
`DHAN_ORDER_STREAM_ENABLED`, and `DHAN_DATA_ENABLED` (documented only in prose).

---

## 7. The exit / risk-reduction invariant

This is the invariant most at risk from a configuration refactor, and the codebase already defends it
explicitly. The relevant proofs to preserve:

- `orderManager.ts:1097-1164` — `exposureReductionBlockReason()` carries a long comment recording a real
  defect where turning off `box_live_order_enabled` silently disabled **every** risk-reduction path
  (`cancelWorkingBoxOrders()` returned an empty *success*). The policy now: `entryEnabled` /
  `liveOrderEnabled` gate **new exposure only**; reduction requires only that the process can still act
  (not disposed, broker session not *known*-bad — `=== "unhealthy"`, not `!== "healthy"`, so an
  unverified session can still get flat).
- `orderManager.ts:1919-1949` — `capitalBlockReason()` is reached **only** for `purpose === "ENTRY"`.
  EXIT, PROTECTIVE_CANCEL and EMERGENCY_RESIDUAL bypass the capital cap by construction.
- `executionCoordinator.ts:831-857` — the operator blocklist has **no counterpart** in
  `acquireForExit` / `coordinateExit`: "excluding a name must never trap an open Box."
- `executionCoordinator.ts:957-992` — the inventory ceiling is annotated "ENTRY ONLY. A full inventory
  is never a reason exposure cannot be reduced."
- `executionCoordinator.ts:1547-1560` — `refsForEntry` deliberately omits the underlying key, because a
  previous version made a Box's own exit collide with its own claim and deferred auto-exit, manual
  close and emergency flatten *forever*.
- `tradingSessionStore.ts` / `tradingSession.ts` — every session refusal string ends with a variant of
  "Exit, residual flattening and reconciliation are unaffected."

**Refactor requirement:** every new runtime setting must be consumed on an ENTRY-only code path, and
this must be proven by regression tests that (a) drive entry configuration to its most restrictive
possible value and (b) assert that EXIT, protective cancel, emergency residual flatten,
reconciliation-required reduction and recovery/unwind all still succeed.

One setting needed particular care: **`minExitNetPnl`** (`BOX_MIN_EXIT_NET_PNL`, default ₹600).
**Resolved — it is safe as `HOT_SAFE`.** Traced through its only decision consumer,
`evaluateExitDecision()` (`src/box/math.ts:968-1081`):

- It gates **only** the two voluntary profit-taking rules, via `clearsFloor = floorNet >= cfg.minExitNetPnl`
  (`math.ts:1042`): `EDGE_CONVERGED` and `PROFIT_CAPTURE`.
- `EXPIRY_SAFETY` is applied as a **fallback that overrides profitability** and is not gated by the
  floor at all (`math.ts:1063-1066`): `reason = executable ? (ruleReason ?? (expirySafety ? "EXPIRY_SAFETY" : null)) : null`.
  The comment states the intent: *"Expiry safety is the fallback that overrides profitability — an
  abandoned box at expiry is a far worse outcome."*
- It appears on **no** manual-close, protective-cancel, emergency-residual-flatten or reconciliation
  path. Its only other references are the published config view (`engine.ts:6629`) and the per-trade
  snapshot (`math.ts:1187`).

Raising it therefore delays an *automatic take-profit*, which is a legitimate strategy decision, and
cannot prevent risk reduction. The UI should still label it as "when the engine will take profit", not
as an exit permission, so an operator does not read it as a stop.

---

## 8. Proposed precedence model

```
code default  (src/box/config.ts — unchanged, still the floor)
      ↓
deployment/env override  (legacy bootstrap input; marked LEGACY in .env.example)
      ↓
persisted runtime operator override  (box_settings, generalised)
      ↓
session snapshot  (arm-time freeze; applies only to §6.3 keys)
```

With **two mandatory deviations** from naive layering:

1. **Deployment capability is not overridable at all.** Category C never appears in the runtime store.
   A runtime setting resolving "live" where the deployment says paper is a bug, not a precedence
   question.
2. **Safety ceilings compose with `min()`/`max()`, not replacement.** For each ceiling the audit must
   declare whether the env value is a *default* or an *absolute deployment maximum*. Proposal:

   | Setting | Env value means | Effective |
   |---|---|---|
   | `maxBoxCapitalRupees` | absolute deployment maximum | `min(env, runtime)` |
   | `maxOpenBoxes`, `liveMaxOpenBoxes` | absolute maximum | `min(env, runtime)` treating `0` as ∞ |
   | `maxOpenLegQuantity`, `maxGrossOpenLegQuantity` | absolute maximum | `min(env, runtime)` |
   | `dailyLossLimit` | absolute maximum | `min(env, runtime)` treating `0` as ∞ |
   | `sessionMax*` | default | runtime replaces (then arm-snapshots) |
   | `minExpectedNetProfit`, `safetyBuffer` | default | runtime replaces — **but see below** |
   | freshness/coherence bounds | absolute maximum (looseness) | `min(env, runtime)` |

   The `0 = unlimited` convention makes `min()` subtle and it must be implemented via an explicit
   helper with tests, not inline — `0` must be normalised to `+Infinity` before comparison and back
   afterwards. Getting this wrong is exactly the "turn a finite limit into unlimited" failure the brief
   warns about.

   `minExpectedNetProfit` / `safetyBuffer` keep today's replace semantics for **backward compatibility**
   — they are already DB-authoritative and changing them to `max(env, runtime)` would alter the
   behaviour of existing deployments that have deliberately persisted a *lower* gate. This is called
   out as a conscious exception rather than smoothed over.

---

## 9. Migration behaviour

The controlling requirement: **on first deployment, effective behaviour must be identical to
pre-migration.**

1. `013_*.sql` adds columns to `box_settings` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) — a
   JSON-typed value column, `updated_by`, and a monotonic `version`; plus a
   `box_settings_audit` append-only table. Migration `003` is **not** edited (sha256 immutability guard).
2. **No backfill of rows.** The store is seeded empty apart from the two existing
   `min_expected_net_profit` / `safety_buffer` rows, which keep working through the legacy numeric
   column.
3. **A missing row means "fall through to env, then to code default."** It must never be read as `0`,
   and never as "unlimited". This is the single most dangerous migration failure mode and needs a
   dedicated test per ceiling.
4. **Unreadable store ⇒ fail closed for entry, open for reduction.** Following the
   `loadBoxExcludedUnderlyings()` precedent, not the error-swallowing `loadBoxSettings()` one.
5. Env variables remain readable forever as bootstrap defaults, relabelled
   `LEGACY / BOOTSTRAP OVERRIDE` in `.env.example`. Provenance in the API reports which layer won, so
   there is no ambiguous double authority.

---

## 10. Performance constraints

Non-negotiable: **no PostgreSQL read on any market tick, scanner candidate, or broker order.**

The design that satisfies this and matches the existing architecture:

- A single immutable, versioned snapshot object built at boot and rebuilt only on a successful
  mutation. `Object.freeze` the snapshot — but **not** `BoxConfig` itself, because `applyTuning()`
  depends on in-place mutation of the shared object (`engine.ts:2568-2577`) and the runtime tuning API's
  visibility depends on reference sharing. Freezing `BoxConfig` would break the existing feature.
- Execution code continues to read fields synchronously, exactly as today.
- A successful mutation: validate → compose effective values → persist in one transaction → publish the
  new snapshot → re-derive dependent copies (`orderManagerLimitsFromConfig`, market-data ages) →
  refresh/publish. Any failure rolls back in memory, following the existing `setTuning()` pattern
  (`engine.ts:2615-2619`) which re-applies the previous values precisely *because* derived values are
  recomputed from an immutable baseline.
- Derived values must keep the `private readonly base*` + "re-derive wholesale" pattern
  (`baseMinGrossEdge`, `engine.ts:594`/`916`) so repeated applications cannot ratchet.

---

## 11. Frontend findings (GAR_F)

`src/Box.tsx` is **101 KB** and `src/api/types.ts` is **80 KB**. Configuration is already rendered in
several places: `BoxExecutionControl.tsx` (31 KB), `BoxRiskControl.tsx` (14 KB),
`BoxSessionControl.tsx` (14 KB), `BoxGates.tsx`, `BoxExclusions.tsx` (10 KB), plus the read-only status
strip and the Params tables inside `BoxHelp.tsx` (41 KB).

`ControlBox.tsx` is already the right shape — a pure container that re-parents existing panels into a
tab strip and deliberately owns no state, so each panel keeps its own single-flight guard. Its header
comment states the rule to preserve: *"Hoisting those here would have meant reimplementing them, which
is exactly how a refactor of a safety surface introduces a double-submit."* The new Configuration area
should follow the same discipline and must not absorb control state into a parent.

Existing safeguards to preserve (each has tests): `src/lib/readinessOrder.ts`,
`src/lib/statusIntegrity.ts`, `src/lib/operationalState.ts`, `src/lib/honestLabels.ts`,
`src/api/contract.assert.ts`, and the 269-test suite in `tests/`.

Contract mechanism: both repos vendor `contract/` with `version.json`
(`contract_version: 1.18.0`, `schemas_sha256: 935d0adc…`), a `digest.mjs`, and GAR_F additionally has
`generate-types.mjs` → `src/api/contract.generated.ts` with a `contract:types:check` script that fails
on drift. 44 schemas are currently verified. Adding the configuration surface means new schemas in
**both** repos, a regenerated `contract.generated.ts`, and an updated digest/version in both.

---

## 12. Open questions to resolve before implementation

1. ~~`minExitNetPnl`~~ — **resolved during this audit, see §7.** It gates only the voluntary
   profit-taking rules; `EXPIRY_SAFETY` overrides it and no protective/emergency path consults it.
2. **Republish vs refuse** for the four dual-authority settings (§3.3). Adding
   `BoxOrderManager.setLimits()` is more useful to an operator but is a new mutation path into the live
   order manager; refusing unless flat/disarmed is safer and simpler. Recommendation: **refuse for the
   first release**, with `FLAT_AND_DISARMED` and a clear blocker, and add republishing later behind its
   own tests.
3. **`enforcing()` switch-on semantics** (§3.4) — moving `sessionMax*` to the runtime store means
   `enforcing()` reads the runtime value. Confirm the intended behaviour when an operator sets a ceiling
   while a session is armed with `0`: today the layer switches on and refuses entry. That is safe but
   surprising, and the UI must say so.
4. **Role boundary** — `POST /api/box/settings` is currently `requireOperator`. Tightening it to
   `requireFull` for risk keys is correct but is a **behaviour change for existing `trade`-role
   operators** and should be called out in the release notes.

---

## 13. Verification status of this audit

Established mechanically (re-runnable): the 213 / 135 / 131 counts, the field→env→parser→bounds table,
the declared-vs-read cross-check, and the ten `strictLimitInt`/`strictBool` safety limits.

Established by reading the code and its comments: all capture points in §3, the gating model in §5,
and the exit invariant in §7.

**Not yet verified by execution.** The sandbox this audit was produced in has no access to the npm
registry (`registry.npmjs.org` returns 403 through the proxy), so `npm ci`, `tsc -b` and the test suites
could not be run. `contract/validate.mjs` and `contract/digest.mjs` are dependency-free and *were* run
successfully in both repos, as was GAR_F's full 269-test suite. Every claim in this document is a
code-reading claim, not a test-backed one, and §12.1 in particular should be confirmed by test before
the implementation lands.
