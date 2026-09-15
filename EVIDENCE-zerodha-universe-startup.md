# The Zerodha empty-universe bug — root cause, fix, diagnostics, evidence

Scope: `GAR_B` + `GAR_F`, `BOX_EXECUTION_MODE=paper_latency`, EC2 Mumbai / PM2 / Nginx /
`gtsalgoresearch.online`. Verified against backend `f4f9114`.

**No live trading enabled, no production `.env` read or written, no broker order submitted, modified,
cancelled or flattened, nothing deployed.**

---

## 1. Confirmed root cause

### The bug: `instruments()` returned `[]` for Zerodha

`src/brokers/registry.ts` — `ActiveBrokerManager.instruments()`:

```ts
async instruments(): Promise<Instrument[]> {
  if (this.active === "zerodha") return [];      // ← the defect
  const rows = await this.dhanInstruments.load();
  return rows;
}
```

`src/index.ts` feeds **both** of the box engine's universe dependencies from this one method:

```ts
getAllInstruments: () => brokerManager.instruments(),
getBoard: async () => deriveFnoBoard(await brokerManager.instruments()),
```

With Zerodha active — the production configuration — the engine received an empty dump and every
stage collapsed **in order and in silence**:

| Stage | Result | Why |
|---|---|---|
| `deriveFnoBoard([])` | 0 board rows | it iterates NFO `FUT` rows grouped by `name` |
| `indexOptionChains([])` | 0 chains | it needs NFO `CE`/`PE` rows |
| `board.filter(chains.has(…))` | 0 joined | nothing to join |
| universe loop | 0 windows, 0 candidates | the loop body never runs |
| `applySubscriptions(∅, ∅)` | 0 desired tokens | nothing to want |
| `setBoxTokens([])` | no 0→1 refcount edge | so `subscribeUpstream("box", …)` is never called |
| **box lane socket** | **never constructed** | it is created **lazily, only on a subscription** |

That is the entire reported picture — box lane disconnected, 0 desired subscriptions, 0 frames, 0
underlyings — while the broker panel correctly showed an authenticated session. **No market-data
health work could have fixed it**: there was nothing to subscribe to, so there was no socket to be
healthy about. The previous PR's lifecycle and clock fixes were necessary and are still correct; they
were simply downstream of this.

`QuoteProvider` was already constructed with `instruments: () => this.instrumentProvider.load()`, so
the correct pattern existed in the same constructor — `instruments()` was the only path that bypassed
it.

### Why no test caught it

The existing paper tests hand ticks directly to `engine.ingestBoxLaneTicks(...)` and supply
`getAllInstruments: async () => []`. That is a reasonable way to test **ingestion**, but it hardcodes
the very value that was the bug, so it could never fail because of it — and it proves nothing about
whether startup can create a subscription.

### Defects found by the pre-merge review, and fixed before pushing

A behavioural review of this change reproduced seven further problems against the built `dist/`. All
are fixed here, and each now has a regression test (suite **G**):

| # | Problem | Fix |
|---|---|---|
| R1 | The retry backoff was derived from `instrumentLoadFailures`, which resets to `0` after every successful load — so any failure **after** the load retried at a flat 2s forever, re-running the REST spot seed each pass (~30 broker quote calls/min). | A dedicated `universeRetryAttempts` counter. Verified curve: 2s→4s→8s→16s→32s→60s, capped. |
| R2 | `stop()` cleared the recurring universe timer but **not** the retry, so a pending retry kept running full universe passes and re-arming after the operator pressed STOP. | `cancelUniverseRetry()` in `stop()`, and `scheduleUniverseRetry` refuses to arm when `!running`. |
| R3 | A stopped scanner after hours with the **default** `BOX_INDICATIVE_DISCOVERY=true` legitimately holds windows with zero subscriptions (they are REST-priced by design), but was diagnosed `no_desired_subscriptions` / `transient: false` — a red "nothing will ever tick" badge every evening and weekend. | `scanner_stopped` is resolved before the subscription stages when nothing is wanted from the feed. |
| R4 | Every retry downgraded a known `failed` load back to `loading`, which is classified *transient* — so the headline told the operator to wait while a 503 sat unreported. | `failed` is sticky until a load actually succeeds. |
| R5 | `awaiting_spot_prices` triggered on **any** missing spot, so a token-budget or underlying-cap exhaustion read as transient "wait for prices" and `no_windows_built` was unreachable. | Requires **all** joined underlyings to lack a spot, or an actual seed failure. |
| R6 | `counts.frames_observed` was process-cumulative but published (and schema-documented) as current-generation: `awaiting_first_tick` became unreachable after the first socket, and the detail asserted "Frames are arriving (12)" about a socket delivering nothing. | `frames` and `heartbeats` now reset with `depthObservations` on every (re)authentication. |
| R7 | `kite.getInstruments()` called `clearSession()` on 401/403. Harmless when only a browser request reached that endpoint — but the universe pass now reads it on a timer, so one 403 on a **public** dump would log an unattended PM2 process out until a human signed in. | The session is no longer cleared from this path; the error carries the response body instead. Genuine token rejection is still detected at authenticated calls and at the socket's policy close codes. |

Two further review findings were also addressed: overlapping universe passes are now deduplicated by
an in-flight guard (the provider dedups the *download*, not the second REST spot seed), and `start()`
now goes through `refreshUniverseWithRetry()` so a failed load at RUN arms the fast retry instead of
waiting a full `universeRefreshMs`.

### Secondary defects found while verifying the chain

- **B. A zero-universe scanner was indistinguishable from a quiet market.** `box-status` published
  `underlyings: this.windows.size` and no instrument, board or chain figure at all, so `0` meant both
  "the dump was empty" and "nothing is trading". The header said `SCANNING` because `running` was the
  only input to it.
- **C. `seedSpots()` swallowed its failure.** A bare `console.warn`, touching no published field.
  Because the universe loop skips an underlying with no spot (`if (!state) continue`), a failed REST
  seed produces zero windows, zero candidates and zero subscriptions — observationally identical to
  an empty dump, with the reason only in the process log.
- **D. A transient instrument-load failure had no fast recovery.** The only retry was the
  `universeRefreshMs` timer, and `lastError` is a single last-writer-wins scalar routinely overwritten
  by transport messages. The observed operator response was to press RUN again, restart, or regenerate
  a token — none of which was the problem.
- **E. `hub_connected` was the only lane fact published.** It is the **shared/board** feed, which with
  `BOX_DEDICATED_MARKET_FEED=true` (the default) is a **different socket** from the box lane. So a
  connected board lane read as proof the box lane was up — exactly the inconsistency in the
  screenshots (broker panel connected / box panel disconnected).
- **F. A live regression from the previous PR.** `GAR_F`'s hand-written `MarketDataHealth` still
  declared `lastHeartbeatAt` / `lastFrameAt` / `lastDepthAt`, and `BoxOperationalState.tsx` rendered
  them through an "ago" helper. The backend stopped emitting those three when ages began being
  computed inside the monotonic domain that stamps them. Because `market_data_health` is an **open**
  schema leaf and the type was hand-written, TypeScript had nothing to object to — **three stats had
  been rendering "never observed" on a healthy feed.**

---

## 2. Changes

### Backend

| File | Change |
|---|---|
| `src/brokers/registry.ts` | `instruments()` now returns `this.instrumentProvider.load()`. Preserves the provider's per-broker cache, in-flight dedup, generation stamping and broker dispatch. No second cache; no unconditional Kite call. Failures propagate instead of becoming an empty universe. |
| `src/box/universeReadiness.ts` **(new)** | Pure diagnosis. Walks the real pipeline in order and returns the **first** unsatisfied stage (17 values), a plain-language `detail`, a `transient` wait/investigate flag, and the count behind every stage. Knows nothing of clocks or I/O. |
| `src/box/engine.ts` | Records each stage as an **observation**: instrument-load state (4 values), the broker's own error, instrument/board/chain/join counts, underlyings missing a spot, spot-seed result, last successful build. Adds `universeReadiness()`, publishes `universe`, `box_lane_connected`, `box_lane_dedicated`. `seedSpots` failure is now published. Adds `refreshUniverseWithRetry()` — a bounded (2s→60s), deduplicated, self-clearing retry — and a `disposed` flag so it cannot re-arm during shutdown. Warns loudly when a successful load yields an unusable universe. |
| `contract/schemas/box-status.schema.json` | Declares `universe`, `box_lane_connected`, `box_lane_dedicated` (all required); documents `hub_connected` as the shared lane and **not** evidence about the box lane. |
| `contract/version.json` | `1.11.0 → 1.12.0`, digest `a0a89b20…`. |

### Frontend

| File | Change |
|---|---|
| `src/api/types.ts` | Adds `UniverseReadiness` / `UniverseStage` / `InstrumentLoadState`, `box_lane_connected`, `box_lane_dedicated`. **Corrects the stale `MarketDataHealth`** to the ages + wall-stamps + counters shape the backend actually publishes (defect F). |
| `src/lib/operationalState.ts` | `universeBand`, `universeStageLabel`, `deriveUniverse`, and `scannerHeadline(running, universe)` — which refuses to say `SCANNING` unless the engine can actually evaluate, and otherwise names the blocking stage. |
| `src/BoxOperationalState.tsx` | New **Scanner pipeline** block: stage badge, the backend's own sentence verbatim, a wait-vs-investigate line, and stats for instrument master, board→chains→joined, windows/candidates, underlyings missing a spot, desired subscriptions, subscribe-frames-written, box socket, frames/depth/usable books, last successful build. Market-data stats now read the **ages** (fixing defect F) and state the enforced freshness bounds. |
| `contract/` | Re-vendored and re-pinned to `1.12.0` / `a0a89b20…`; `contract.generated.ts` regenerated; the version literal in `readinessOrder.test.mjs` moved with its acknowledgement note. |
| `tests/fixtures/box-status.json` | Regenerated from the fixed backend, so it stays authoritative rather than hand-written. |

### Deliberately not changed (verified, per §8 of the brief)

`BOX_EXECUTION_MODE=paper_latency`; all live-trading flags false; quote-age **15,000 ms**; feed-age
**5,000 ms**; **exchange-time dispersion 250 ms vs receive-time dispersion 500 ms** — two distinct
knobs, both untouched; latency settings; profit thresholds and safety buffer; selected ATM window;
order/position/reservation controls. `MARKET_DATA_PERMISSIONS.DISCONNECTED.exitAndReduce` stays
`false` with `protectiveCancel` `true`. No freshness, coherence or subscription check was loosened.
REST remains for instrument discovery and the initial spot snapshot only — the ongoing option quote
feed is WebSocket, and REST fallback data is labelled `rest_snapshot_fallback`.

---

## 3. Test results

### The negative control that matters

With the fix reverted to the original `if (this.active === "zerodha") return []`, the new suite
fails **20 of 25**. With the fix in place, **25 of 25** pass. The five that pass either way are the
Dhan-isolation case and four that deliberately drive an empty or non-Zerodha path.

That is the difference from the previous round: the old suite passed with the bug present.

### `tests/box/zerodhaUniverseStartup.test.mjs` (25 new)

Real `ActiveBrokerManager` + real `InstrumentProvider` + real `BoxEngine`, wired exactly as
`src/index.ts` wires them, with a fake `WebSocket` and captured timers. Nothing is hand-delivered.

- **A** — Zerodha returns its fixtures through `manager.instruments()`; the provider's Kite loader was
  actually invoked; the Dhan store is a throwing spy and is never touched; three concurrent callers
  cause **one** download and a later call is cached; a load failure **rejects** and then recovers.
- **B** — active Dhan returns Dhan instruments with `kite.getInstruments`/`getQuoteFull` replaced by
  throwing stubs; token namespaces do not overlap.
- **C** — startup produces 2 board rows, 2 chains, a 2-row join, 2 windows and candidates; **a real
  socket is constructed as a consequence of a real subscription**; subscribe frames and `mode: full`
  reach the transport for every token; delivered binary frames flow through parsing into the quote
  store; `quotes`/`quote_updates` increase and the stage reaches `evaluating`.
- **D** — download failure is diagnosed with the broker's own message and recovers unaided; an empty
  master is `instruments_empty` (not a quiet market); a failed spot seed is `awaiting_spot_prices`
  with the REST error attached; 20 heartbeats never reach `evaluating`; a reconnect restores
  subscriptions and full depth while invalidating old books; broker switching cannot mix namespaces.
- **E** — paper reaches `evaluating` from streamed fixtures with **no** order manager, live adapter,
  order-stream consumer or Dhan order socket in existence, and fills labelled
  `simulated_paper_fills`.
- **F** — an authenticated session with a disconnected box socket renders as such; a connected shared
  lane does **not** imply box readiness; an unconfigured Dhan does not block Zerodha; live-only
  disarming is not described as a broken quote feed; a mixed-lot expiry is `no_candidates`, not a feed
  fault.

- **G** — the bounded retry and its lifecycle: the backoff is exponential and capped **even when the
  failure is after the load** (the R1 defect); STOP cancels a pending retry and a fired timer does not
  re-arm (R2); a repeated failure keeps saying `failed` and never tells the operator to wait (R4);
  three concurrent triggers produce **one** REST spot seed (overlap); a stopped scanner holding
  indicative windows is `scanner_stopped`, not a red fault (R3); frame evidence resets per generation
  so `awaiting_first_tick` is reportable again (R6); and a 403 on the public instruments dump leaves
  the session intact (R7).

### Suite totals

| Suite | Result | Note |
|---|---|---|
| GAR_B `tests/box` | **2163 pass / 0 fail** | +25 new |
| GAR_B `tests/invariants` | 9 / 9 | exit & exposure invariants preserved |
| GAR_B `tests/shutdown` | 11 / 11 | |
| GAR_B `tests/contract` | 28 pass / 3 fail | 3 need Express — **baseline** |
| GAR_B `tests/readiness` | 0 / 2 | needs Express — baseline |
| GAR_B `tests/access` | 7 / 9 | needs PostgreSQL |
| GAR_B `tests/switch` | 0 / 32 | suite's own guard: *PostgreSQL not reachable* |
| GAR_B `tests/tokens` | 59 / 91 | same guard |
| GAR_F | **242 pass / 0 fail** | +11 new (`tests/universePipeline.test.mjs`) |
| GAR_F `contract:verify` | OK | 37 schemas, digest matches both pins |

Every non-pass is a suite declining to start without a real database or HTTP server — **not one is an
assertion failure**, and the counts are identical to the pre-change baseline.

### Typecheck

`npm run typecheck` / `npm run build` (`tsc -b`) **could not be run as written**: the npm registry is
blocked (403) and `node_modules` is empty, so `@types/node` and the pinned TypeScript 5.7.2 are
unavailable. A local ambient shim restored a signal: **58 errors in GAR_B and 42 in GAR_F, all
pre-existing shim artifacts, and zero in any file this change touches** — confirmed by measuring the
same baseline with `src/` stashed, and negative-controlled by injecting a bad enum value and a field
typo (both caught, both cleared on restore). **CI must remain the gate.**

---

## 4. Remaining limitations

1. **No EC2 access and no broker credentials, so the production WebSocket is not proven fixed.**
   Everything here is fixture-driven against fake transports. The real Kite handshake, the real CSV
   dump, real binary frames and real close codes are untested. §6 is the procedure that closes this.
2. **`tsc -b` never executed locally** (see above). CI runs it.
3. **DB-backed suites did not run locally**: `tests/switch` (which covers broker switching, touched
   here), `tests/tokens`, `tests/pg`, `tests/projector`, part of `tests/access`. Broker-switch
   *namespace isolation* is covered at the transport level locally; the durable-generation path is not.
4. **`engine.start()` is not exercised** — it requires PostgreSQL via `isBoxDbEnabled()`. The new
   suite sets the RUN flag and drives `refreshUniverse()`; every stage of the previously-broken path
   runs unchanged, but the boot ordering inside `start()` itself is not covered locally.
5. **The real instrument master is far larger and messier than the fixture.** The fixture proves the
   join works when labels are well-formed. Residual real-world risks, all now *diagnosable* rather
   than silent: an option row whose `name` disagrees with its futures row (`no_board_chain_overlap`);
   an expiry that is not bare `YYYY-MM-DD` (`no_option_chains`); a mixed-lot expiry
   (`no_candidates`); an index missing from `INDEX_SPOT_MAP` (`no_board_rows`).
6. **`boardDiagnostics.ts` remains unwired.** It reproduces the board join stage by stage and would
   add per-underlying detail. `universe.counts` covers the aggregate question; the per-symbol
   breakdown is still only reachable from tests.
7. **The bounded retry's ceiling is a judgement call** (2s→60s, no attempt cap). A prolonged broker
   outage retries every 60s indefinitely rather than giving up — deliberate, since giving up would
   require an operator action the diagnostics are designed to avoid.
8. **`vite build` did not run**, and the new panel was not visually confirmed. Its logic is covered
   through the pure derivations plus the shimmed typecheck.

---

## 5. Deployment — existing PM2 / Nginx setup

**Check the existing configuration first. Do not overwrite the production `.env`. Do not enable live
trading.** No new environment variable is introduced and no existing one changes meaning.

### Order: **backend first, then frontend.**

`universe`, `box_lane_connected` and `box_lane_dedicated` are **required** on an
`additionalProperties: false` schema, so a `1.12.0` frontend against a `1.11.0` backend rejects the
whole `box-status` response.

```bash
# ── 0. Confirm what is running now ────────────────────────────────────────────
pm2 list
pm2 describe <backend-app-name>
pm2 env 0 | grep -E 'BOX_EXECUTION_MODE|BOX_LIVE_TRADING_ENABLED|BOX_DEDICATED_MARKET_FEED'
#   EXPECT BOX_EXECUTION_MODE=paper_latency and BOX_LIVE_TRADING_ENABLED unset/false.
#   Anything else: STOP and reconcile before continuing.

# ── 1. Record a rollback point ───────────────────────────────────────────────
cd /path/to/GAR_B
git rev-parse HEAD > ~/gar_b_rollback_sha.txt
cp .env ~/gar_b_env_backup_$(date +%F).bak      # backup only; never overwritten by deploy

# ── 2. Check out, install, BUILD (must be green before restarting) ────────────
git fetch origin && git checkout main && git pull
npm ci
npm run typecheck                # tsc -b — must exit 0
npm run build                    # noEmitOnError, so dist/ only appears if it typechecked

# ── 3. Tests ─────────────────────────────────────────────────────────────────
npm run test:unit
npm run test:invariants
npm run test:contract
#   With DATABASE_URL / MONGODB_URI reachable from the box, also:
# npm run test:integration && npm run test:switch && npm run test:tokens

# ── 4. Restart. --update-env re-reads .env WITHOUT modifying it ───────────────
pm2 restart <backend-app-name> --update-env
pm2 logs <backend-app-name> --lines 120
```

Expect in the logs, within a minute of a RUN during market hours:

```
[Broker] Zerodha universe loaded: 90,000+ instruments      ← was NEVER logged before this fix
```

and **not**:

```
[Box] universe unusable: N instrument(s) produced 0 board row(s) …
```

Then the frontend:

```bash
cd /path/to/GAR_F
git fetch origin && git checkout main && git pull
npm ci
npm run contract:verify          # digest must match the backend's 1.12.0 pin
npm run contract:types:check     # generated types in sync
npm test
npm run build                    # tsc -b && vite build
# publish dist/ to the path Nginx serves, then:
sudo nginx -t && sudo systemctl reload nginx
```

### Rollback

```bash
cd /path/to/GAR_B && git checkout $(cat ~/gar_b_rollback_sha.txt)
npm ci && npm run build && pm2 restart <backend-app-name> --update-env
```

No database or schema migration is involved. The only cross-repo coupling is the contract version —
roll **both** back together.

---

## 6. Post-deployment verification

Run on the EC2 box, signed in, market open, broker session established. Read the passcode with
`read -rs` rather than pasting it into shell history.

```bash
curl -sS -c /tmp/gar.jar -X POST https://gtsalgoresearch.online/api/access/verify \
  -H 'Content-Type: application/json' --data "{\"passcode\":\"$PASSCODE\"}" >/dev/null
```

### Step 1 — deployed commit and session

```bash
git -C /path/to/GAR_B rev-parse --short HEAD
curl -sS -b /tmp/gar.jar https://gtsalgoresearch.online/api/box/status \
| python3 -c '
import json,sys
s=json.load(sys.stdin)
print("execution_mode :", s["execution_mode"])
print("authenticated  :", s["authenticated"])
print("broker         :", s["broker"])
print("running        :", s["running"])
'
```

### Step 2 — the universe pipeline (**the decisive check**)

```bash
curl -sS -b /tmp/gar.jar https://gtsalgoresearch.online/api/box/status \
| python3 -c '
import json,sys
u=json.load(sys.stdin)["universe"]; c=u["counts"]
print("stage             :", u["stage"])
print("ready_to_evaluate :", u["readyToEvaluate"])
print("instrument_load   :", u["instrument_load"], "err:", u["instruments_error"])
print("instruments       :", c["instruments"])
print("board -> chains -> joined :", c["board_rows"], c["chains_indexed"], c["board_with_chains"])
print("missing spots     :", c["underlyings_missing_spot"], "seed_failed:", u["spot_seed_failed"], u["spot_seed_error"])
print("windows/candidates:", c["windows_built"], c["candidates"])
print("desired subs      :", c["desired_option_subscriptions"], "requested:", u["subscriptions_requested"])
print("box socket        :", u["box_socket_connected"])
print("frames/depth/books:", c["frames_observed"], c["depth_observations"], c["usable_books"])
print("detail            :", u["detail"])
'
```

**Pass criteria** (scanner started, market open):

| Field | Required |
|---|---|
| `instrument_load` | `loaded` |
| `counts.instruments` | **> 0** — this is the bug's direct signature; it was `0` before |
| `counts.board_rows` / `chains_indexed` / `board_with_chains` | all **> 0** |
| `counts.windows_built` / `candidates` | **> 0** |
| `counts.desired_option_subscriptions` | **> 0** |
| `box_socket_connected` | `true` |
| `counts.depth_observations` / `usable_books` | **> 0** |
| `stage` | `evaluating` |
| `readyToEvaluate` | `true` |

### Step 3 — counters increasing and ages fresh

```bash
for i in 1 2 3 4 5 6; do
  curl -sS -b /tmp/gar.jar https://gtsalgoresearch.online/api/box/status \
  | python3 -c '
import json,sys,time
s=json.load(sys.stdin); c=s["universe"]["counts"]; ev=s["operational_readiness"]["evidence"]
print(time.strftime("%H:%M:%S"),
      "quote_updates",s["quote_updates"], "frames",c["frames_observed"], "depth",c["depth_observations"],
      "books",c["usable_books"], "tick_age",ev["market_data_frame_age_ms"],
      "depth_age",ev["market_data_depth_age_ms"], "stage",s["universe"]["stage"])'
  sleep 10
done
```

**Pass:** `quote_updates`, `frames` and `depth` strictly increase; `tick_age` and `depth_age` stay
small integers (never `null`, never ~1.7e12); `stage` stays `evaluating`.

**A profitable opportunity is not required and must not be used as the criterion.** Streaming is
proven by the counters and the ages.

### Step 4 — lane separation and paper labelling

```bash
curl -sS -b /tmp/gar.jar https://gtsalgoresearch.online/api/box/status \
| python3 -c '
import json,sys
s=json.load(sys.stdin); d=s["operational_readiness"]
print("hub (shared lane) :", s["hub_connected"], "subs", s["hub_subscribed"])
print("box lane          :", s["box_lane_connected"], "dedicated", s["box_lane_dedicated"])
print("market_data_state :", s["market_data_state"])
print("paper_execution   :", d["paper_execution"]["detail"])
print("fills_observed_by :", d["fill_observation"]["mechanism"])
for b in s["order_stream"]["brokers"]:
    print("  ", b["broker"].ljust(8), b["wiring"].ljust(22), b["fills_observed_by"])
print("exposure exit/cancel:", d["exposure_management"]["exit_and_reduce"], d["exposure_management"]["protective_cancel"])
'
```

**Pass:** `box_lane_connected` is `true` **independently** of `hub_connected`;
`fills_observed_by` is `simulated_paper_fills` for **every** broker (never `rest_polling_only`);
`paper_execution.detail` contains *"Real broker WebSocket quotes · simulated execution"*;
`protective_cancel` is `true`.

### Step 5 — no real order mutations

```bash
pm2 logs <backend-app-name> --lines 500 --nostream \
  | grep -Ei 'place_?order|modify_?order|cancel_?order|POST /orders' || echo "CLEAN: no order mutation attempted"
```

**Pass:** `CLEAN`. A paper process constructs no order manager, so there should be nothing to find.

### Step 6 — the dashboard

Open the workspace. The **Scanner pipeline** block should read `evaluating`, with a non-zero
instrument count, a `board → chains → joined` triple that is non-zero throughout, non-zero
windows/candidates, `Subscribe frames written: yes`, `Box socket: connected`, and non-zero
frames/depth/usable books. The header must **not** read `SCANNING` while any of those is zero — it
will read `STARTING — <stage>` instead.
