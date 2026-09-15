# Paper mode consumes the real broker WebSocket feed — root causes, fixes, evidence

Scope: `GAR_B` (backend) and `GAR_F` (frontend), `BOX_EXECUTION_MODE=paper_latency`, EC2 Mumbai /
PM2 / Nginx / `gtsalgoresearch.online`, both Zerodha and Dhan through the existing broker
architecture.

**No live trading was enabled, no production `.env` was read or written, no broker order was
submitted, modified, cancelled or flattened, and nothing was deployed.**

---

## 1. Confirmed root causes

Eleven defects, each traced to a specific line and each reproduced by a test that fails without the
fix. The reported dashboard symptoms — `SCANNING`, `DISABLED` market-data lifecycle, generation `0`,
"no observed frame/depth", zero evaluated candidates, "REST polling for order updates", and a red
exposure warning — are fully accounted for by **A**, **B**, **C**, **J** and **G**.

### A. Market-data monitoring was gated on live-order execution — *the primary defect*

`src/box/engine.ts:684`

```ts
this.marketDataMachine = new MarketDataStateMachine({
  enabled: this.cfg.executionMode === "live",   // ← paper ⇒ DISABLED
```

`MarketDataState` is the *quote feed's* health. `live` and all three paper modes consume the same
broker socket with the same full-depth subscriptions, so this coupling had no basis. Because almost
every transition in `MarketDataStateMachine` early-returns while `DISABLED`, the entire diagnostic
surface was dead in exactly the reported pattern:

| Consequence | Mechanism | Dashboard symptom |
|---|---|---|
| generation stuck at `0` | `onAuthenticated()` early-returns | "generation 0" |
| depth never recorded | `onUsableDepth()` early-returns ⇒ `depthAt` never written, `lastDepthAt` stays `null`, `readyInstruments` always `0` | "no observed depth", "zero evaluated candidates" |
| lifecycle never leaves `DISABLED` | constructor sets `DISABLED` | "DISABLED market-data lifecycle" |
| **exposure management reported blocked** | `marketDataEntryBlocker("DISABLED")` returns **`scope: "both"`** | **the red exposure warning** |

The red warning was therefore *caused by* paper mode, not by any feed fault: the only reason
exposure management appeared blocked was that live readiness was off.

### B. Market-data ages were computed across two clock domains

`src/box/engine.ts:5928` passed `now: this.executionClock.wall()` into `buildOperationalReadiness`,
which then did `ageOf(now, marketData.lastFrameAt)` — but `lastFrameAt`/`lastDepthAt`/
`lastHeartbeatAt` are readings of `executionClock.mono()` (the machine is constructed with
`now: () => this.executionClock.mono()`).

Every published market-data age was therefore ≈ `1.7e12 ms` (**about 55 years**). Always positive,
so `Math.max(0, …)` could not expose it, and a dashboard could only render it as garbage or as
"never observed". **This is why "last frame never observed" appeared even while ticks were arriving
normally.** `executionClock.ts` states the rule the call site broke: *"MEASURE with `mono()`. AUDIT
with `wall()`. NEVER mix them in one subtraction."*

Gating was unaffected (the machine compares monotonic-to-monotonic internally), so this was purely a
reporting defect — but it is the one that made the feed look dead.

### C. The Zerodha box lane died permanently on the first network blip

`src/brokers/zerodha/feed.ts` — two mistakes that compounded:

```ts
onError: (message) => {
  this.opts.onDead?.(message);   // (1)
  this.teardown();               // (2)
},
```

1. `ws.onerror` fires for **any** abnormal condition (DNS, TCP reset, TLS, idle timeout) and carries
   no code — it is not evidence about the credential. But `onDead` → `onMarketDataSessionLost` →
   `AUTH_EXPIRED`, which is documented as **terminal**, and whose blocker scope is **`both`**.
2. `teardown()` sets `this.handle = null`, and `onClose` begins
   `if (this.handle !== handle || this.disposed) return;`. So the close that **always** follows an
   error returned early and **`scheduleReconnect()` was never reached**.

Result: no socket, no pending reconnect, and no code path able to create one — **for the life of the
process**. This is a complete standalone explanation for "last frame never observed" persisting all
session. Dhan already did this correctly (`onerror` no-ops; `onclose` classifies by close code),
so the two brokers behaved differently for the same fault.

### D. `AUTH_EXPIRED` was unrecoverable in-process

`onSocketOpen()` and `onAuthenticated()` both early-return on `AUTH_EXPIRED`. Correct with respect to
*data* — a tick on a socket the broker already rejected proves nothing — but there was **no path out
at all**. An operator could sign in again, the lane would reconnect and stream happily, and the
machine that gates entry still reported an expired session forever (and, scope `both`, exposure
management as blocked).

### E. A reconnect could escape the terminal state and re-reach `READY` on a dead token

**Found by one of the new tests, not by inspection.** `onConnecting()` guarded only `DISABLED`:

```ts
onConnecting(): void {
  if (this.current === "DISABLED") return;   // AUTH_EXPIRED not guarded
  this.current = "CONNECTING";
}
```

So the first step of the reconnect the feed performs anyway moved the machine out of `AUTH_EXPIRED`;
`onSocketOpen` → `onAuthenticated` then saw a non-terminal state and proceeded, and a **rejected
token reached `READY` again on the next tick**. A hole straight through the terminal guarantee, in
the opposite direction from D.

### F. `onHeartbeat()` had no production caller anywhere

Kite sends a 1-byte keep-alive when nothing has ticked. `src/ticker.ts:167` drops frames
`< 2` bytes and only calls `onTick` for a non-empty batch, so the keep-alive was observed by
**nothing**: a quiet-but-perfectly-alive socket was indistinguishable from a dead one. Dhan's
non-tick frames (market status, informational text) were likewise unobserved.

### G. A futures-lane reconnect wiped the box engine's books — cross-lane contamination

`ensureFeed()` installed a connection listener on the **shared/futures** feed that called
`invalidateFeedGeneration()` and `driveMarketDataConnection()`. With `BOX_DEDICATED_MARKET_FEED=true`
(the default) the box engine's quotes come from the *separate box lane*, so a **board-lane** flap
would, for a completely unrelated socket: bump the box feed generation, wipe the quote store, clear
the spot cache, clear every detected opportunity, and re-authenticate the box health machine
(dropping all per-instrument readiness). A flapping board lane repeatedly blinded the box scanner —
consistent with "zero evaluated candidates" alongside an otherwise healthy-looking socket.

### H. The desired-instrument set could be published one generation stale

`applySubscriptions` assigned `this.subscribedOptionTokens` **after** calling `setBoxTokens`, which
can synchronously create the socket. The resulting `onBoxLaneConnection(true)` edge calls
`setDesiredInstruments(this.subscribedOptionTokens)` — reading the *previous* set, empty on the very
first subscription. `anyDesiredFresh()` returns `false` for an empty desired set, so the machine
stayed below `READY` until the next 15 s market-watch tick re-asserted it.

### I. One failed Dhan subscription chunk abandoned all remaining chunks

`src/brokers/dhan/feed.ts` `sendInstrumentRequest` did `return` inside the batching loop on a send
failure. At ~2,200 box tokens that is 22 chunks, so a transient failure on chunk 3 silently left
~1,900 instruments unsubscribed while the lane still reported itself connected.

### J. A paper deployment's order stream was reported as broken

`src/box/orderStreamStatus.ts:105-109` mapped "absent from the `consumers` map" to **`not_wired`**,
whose documented meaning is *"this should be running and is not"*. But a paper process constructs no
order-stream consumer **by design** — building one implies a live order manager, and a paper process
must contain no object capable of touching a real order. So every paper deployment permanently
reported a broken fast fill path that was never meant to exist, and `fills_observed_by:
"rest_polling_only"` claimed a broker REST round trip for orders **never sent to a broker**.

### K. Zerodha `isOpen` was never reset on close

`src/ticker.ts` set `isOpen = true` on open and never cleared it, so `subscribe`/`unsubscribe` would
attempt sends on a closed socket; `sendSubscribe` was also unguarded and could throw into the
WebSocket callback.

### Frontend (GAR_F)

- **L.** `BoxOperationalState.tsx:284` asserted *"the broker itself will reject it on an expired
  session"* for **any** refused protective cancellation — a diagnosis invented from one false
  boolean. `protective_cancel: false` does not mean the token expired: the verdict is the combined
  permission table **plus** reduction-scoped external blockers, so a PostgreSQL outage, a reservation
  fault or a recovery hold all landed there and were reported as a credential problem. Chasing an
  invented expiry while the real cause is untouched is the wrong action, under time pressure, with
  open exposure.
- **M.** `severity()` in `BoxOrderStreamStatus.tsx` fell through to `is-bad`, and
  `orderStreamBrokerBand` to `paused`, for paper — painting a deliberately-absent capability red.
- **N.** The panel had only `market_data_state` to render, so "socket open" and "executable depth
  exists" could not be distinguished on screen.

---

## 2. Implemented changes

### Backend

| File | Change |
|---|---|
| `src/box/streamHealthPolicy.ts` | `enabled` documented as **not** an execution-mode switch. Dual clocks (`now` monotonic, `nowWall` for audit); ages computed **inside** the monotonic domain and published finished; raw monotonic timestamps **no longer exported at all**, so the mixed subtraction is unavailable, not merely absent. New `onSessionRestored()` (the only thing that may clear `AUTH_EXPIRED`). `onConnecting()`/`onFrame()`/`onHeartbeat()` guarded on `AUTH_EXPIRED` (fixes **E**). Evidence counters (`frames`, `heartbeats`, `depthObservations`). New exported `MarketDataDiagnostics`. |
| `src/box/engine.ts` | `enabled: true` — market data monitored in **every** mode (**A**). Ages passed pre-computed (**B**). New `onBoxLaneHeartbeat()`, `onBoxLaneTransportFault()`, `onMarketDataSessionRestored()`, `marketDataSource()`, `marketDataSocketConnected`. Shared-feed connection listener no longer speaks for the box lane (**G**). `applySubscriptions` records intent **before** publishing upstream (**H**). Passes `paperSimulated` and the `paperExecution` block. |
| `src/box/operationalReadiness.ts` | Input takes **ages, not timestamps**. New required `paper_execution` block; nine new `market_data` fields; three new `evidence` fields incl. `market_data_age_clock: "monotonic"`. `intAge()` rounds a fractional monotonic span. `describePaperExecution()` makes the streamed-quotes claim **only** with tick evidence. Third `fill_observation.detail` branch for simulated fills. |
| `src/box/orderStreamStatus.ts` | New `wiring: "not_applicable_paper"` and `fills_observed_by: "simulated_paper_fills"`, plus a `paperSimulated` argument (**J**). A broker that *does* have a live consumer is never relabelled. |
| `src/ticker.ts` | `onHeartbeat` for `< 2`-byte keep-alives (**F**). `onClose` now carries `{ code, everOpened }`. `isOpen` cleared on close; `sendSubscribe` guarded (**K**). Full-depth `mode` documented as unconditional. |
| `src/brokers/zerodha/feed.ts` | **`onerror` is no longer terminal** (**C**): recovery is driven from `onclose`, exactly as Dhan already did. `isAuthClose()` (1008/4001/4401/4403) is terminal; a socket that never opens reports a lost session only after `MAX_FAILED_OPENS = 5` bounded retries, with an actionable message. Heartbeat forwarding; `lastHeartbeatAgeMs` in stats. |
| `src/brokers/dhan/feed.ts` | Heartbeat forwarding for non-tick and text frames (**F**). Failed subscription chunk `continue`s and is counted and warned (**I**). |
| `src/brokers/marketDataLane.ts` | `LaneFeedStats.lastHeartbeatAgeMs` — "quiet but alive" vs "dead". |
| `src/brokers/registry.ts` | `onBoxLaneHeartbeat` / `onBoxLaneTransportFault` deps; `SwitchHooks.marketDataSessionRestored` invoked on Zerodha re-login, Dhan token refresh (scoped to when Dhan is active) and broker switch (**D**). |
| `src/index.ts` | Wires the two new box-lane callbacks and `marketDataSessionRestored`. |
| `contract/schemas/*`, `contract/version.json` | Schemas extended; digest regenerated; `1.10.0 → 1.11.0`. |

### Frontend

| File | Change |
|---|---|
| `src/api/types.ts` | New `market_data` transport fields, `paper_execution`, `evidence` additions; widened `wiring` and `fills_observed_by`. |
| `src/api/contract.generated.ts` | Regenerated from the vendored schemas. |
| `src/lib/operationalState.ts` | `mechanismLabel` returns **"Simulated fills"**; `orderStreamBrokerBand` returns `absent` for paper; `WIRING_LABEL` gains a neutral paper label. |
| `src/BoxOrderStreamStatus.tsx` | Paper is `is-muted`, not `is-bad` (**M**); headline reads "not applicable · simulated fills" instead of "REST polling"; the `not_wired` warning no longer fires for paper and paper gets its own neutral explanation. |
| `src/BoxOperationalState.tsx` | Renders the **backend's** reduction reasons instead of inferring expiry (**L**). New stats: quote source, socket/auth/subscribed, desired-vs-usable books, frames/depth/heartbeats, paper execution (**N**). |
| `src/styles.css` | `is-muted` for a capability inactive **by design**. |
| `contract/` | Re-vendored, re-pinned to `1.11.0` / `2a7f1905…`. |

### Deliberately **not** changed

- `BOX_EXECUTION_MODE=paper_latency` and every live-trading flag remain as they are.
- No live order manager, live adapter or order-stream consumer is constructed to obtain WebSocket
  status — asserted on a real engine instance, not by reading source.
- Quote-age, coherence, feed-age, latency and strategy settings are untouched.
  `MARKET_DATA_PERMISSIONS.DISCONNECTED.exitAndReduce` stays `false` (no book ⇒ no priced
  reduction); `protectiveCancel` stays `true`.
- REST is retained where legitimate (instrument discovery, spot seed, indicative/last-close view,
  reconciliation) and is now **labelled** `rest_snapshot_fallback`, never presented as executable
  depth.
- The `READY` definition remains existential (`anyDesiredFresh`) — one illiquid strike does not
  refuse every box — while per-candidate admission stays strict in `candidateMarketData.ts`.

---

## 3. Build / typecheck / test results

### Environment limitation, stated up front

This sandbox has **no npm registry access** (`403 Forbidden` on `registry.npmjs.org`) and the
checked-out `node_modules` trees are empty. Consequently:

- `npm ci` cannot run in either repo.
- **`npm run build` / `npm run typecheck` (`tsc -b`) could not be run as written**, because
  `@types/node` is absent and the pinned TypeScript `5.7.2` is unavailable (only a global `7.0.2`).
- The DB-backed suites cannot reach PostgreSQL/MongoDB, and the Express-dependent suites cannot boot
  the app.

To avoid shipping unverified code, three **local-only** harnesses were used and then **deleted**
(none is committed):

1. **Emit** — `tsc --noCheck` with `types: []` produced all 166 `dist/` files, which is what the
   suites import.
2. **Typecheck** — an ambient `.d.ts` shim for the node/express/pg/mongodb surface reduced noise from
   729 errors to a **54-error baseline, none in any file this change touches**. Verified by negative
   control: injecting a bad enum value and a field typo into `BoxOperationalState.tsx` produced
   exactly two errors, which disappeared on restore. The GAR_B harness likewise caught the intended
   `MarketDataDiagnostics` breakage during development.
3. **`pg` stub** — a loudly-failing stand-in (`node_modules/`, gitignored) so the engine could be
   *imported*; any actual query throws, so no test can pass against a fake database.

### GAR_B

| Suite | Result | Note |
|---|---|---|
| `tests/box` (**2138**) | **2138 pass / 0 fail** | includes the 3 new suites (37 new tests) |
| `tests/invariants` | 9 / 9 | exit & exposure invariants preserved |
| `tests/shutdown` | 11 / 11 | |
| `tests/contract` | 28 pass / 3 fail | 3 need Express — **same as baseline** |
| `tests/readiness` | 0 / 2 | needs Express — same as baseline |
| `tests/access` | 7 / 9 | needs PostgreSQL |
| `tests/switch` | 0 / 32 | suite's own guard: *"PostgreSQL is required … not reachable"* |
| `tests/tokens` | 59 / 91 | same guard |

Every non-pass is the suite refusing to run without a real database or HTTP server — **not one is an
assertion failure**. Baseline before any change was byte-identical in kind.

### GAR_F

`node --experimental-strip-types --test "tests/*.test.mjs"` → **231 pass / 0 fail** (224 before,
+7 new). `node contract/verify.mjs` → **OK**, 37 schemas, digest matches both pins.

### New regression coverage (37 tests)

Fake broker transports driving the **actual production classes** — no test asserts that a method name
appears in a file.

`tests/box/brokerFeedLifecycle.test.mjs` (**17**) — real `ZerodhaFeed` / `DhanFeed` / `connectTicker`
with a controllable `globalThis.WebSocket` and captured timers:

- Zerodha initial connect subscribes in **`mode: full`**; Dhan uses **`RequestCode 21`** (full depth).
- **A transport error is not terminal**: the lane reconnects and restores the whole wanted set in
  full mode, and streams again — with `onDead` never called.
- Backoff is exponential and **capped** (`500 → 1 000 → 2 000 → 4 000 → 8 000 → 15 000 …`).
- Policy close codes (1008/4001/4401/4403) **are** terminal and schedule **no** reconnect — both
  brokers.
- A never-opening socket reports a lost session only after bounded retries, with an actionable
  message.
- Heartbeat frames become heartbeats, **never** ticks; `lastTickAgeMs` stays `null` while
  `lastHeartbeatAgeMs` is set.
- A superseded socket's ticks, keep-alives and postbacks are all rejected; a broker-generation change
  also rejects the current socket's output.
- A replacement token is used on the next connect (credentials read fresh).
- Dhan: a `FULL` packet yields both ladders and **no** `exchange_ts`; one failed chunk does not
  abandon the other two; a reconnect bumps the generation and discards retained ladders; an
  unresolvable token is dropped rather than silently shortening the list.
- Broker switch: stopping a lane forgets its tokens, late traffic reaches nobody, and the incoming
  broker resolves through its **own** namespace.

`tests/box/paperModeMarketDataWiring.test.mjs` (**13**) — a real `BoxEngine` in `paper_latency`,
driven through `onBoxLaneConnection` / `ingestBoxLaneTicks` / `onBoxLaneHeartbeat`:

- The machine is **armed** (`DISCONNECTED`, not `DISABLED`).
- Socket ticks reach the quote store, generation advances past `0`, state reaches `READY`, and ages
  are small integers in one clock domain.
- An LTP-only tick keeps the transport alive but creates **no** executable book.
- 25 heartbeats on an open socket do **not** claim readiness; 10 more cannot rewind a book's age.
- A reconnect invalidates prior books, requires fresh depth, and recovers.
- **Token replacement recovers a terminal expired session**; no data event can.
- A reconnectable fault is never reported as expiry.
- Paper fills are `simulated_paper_fills` / `not_applicable_paper`, and the streamed-quotes claim is
  **withheld** until a tick arrives.
- **No order manager, live adapter, order-stream consumer or Dhan order socket exists**, and driving
  the full market-data path does not create one.
- Paper never reports exposure management blocked; **and** a genuinely dead feed still refuses entry
  and says market data is why.

`tests/box/paperModeContractShape.test.mjs` (**7**) — the real payload against the real schemas, for
**both** brokers, with negative controls proving the schema rejects a float age, a wrong clock
domain, a missing `paper_execution`, an undeclared field and a bad enum.

`GAR_F/tests/paperModeLabels.test.mjs` (**7**) — paper renders as `absent` / "Simulated fills";
genuinely broken and genuinely absent states are unchanged; a live stream is never mislabelled; a
refused cancellation carries the backend's reason; a genuinely expired session still says so.

---

## 4. Remaining limitations — what is **not** verified

**The production WebSocket is not proven fixed by these tests.** The tests prove the wiring,
lifecycle, labelling and contract behaviour against fake transports. They cannot prove behaviour
against the real brokers.

Unverified here, and requiring the runtime procedure in §6:

1. **No EC2 access and no broker credentials.** Nothing was run against `ws.kite.trade` or
   `api-feed.dhan.co`. The real handshake, real binary frames, real close codes and real keep-alive
   cadence are untested.
2. **`npm run build` / `npm run typecheck` as written never executed** (no `@types/node`, no
   TypeScript 5.7.2). Types were checked with a shimmed configuration whose clean baseline and
   negative controls are documented above, but **CI must be the gate**.
3. **DB-backed suites did not run**: `tests/switch` (32), `tests/tokens` (32), `tests/access` (2),
   `tests/pg`, `tests/projector`. `tests/switch` in particular covers broker switching, which this
   change touches (`marketDataSessionRestored` in `switchBroker`). Broker-switch isolation **is**
   covered locally at the transport level, but the durable-generation path is not.
4. **Express-dependent suites did not run**: `tests/contract/responses`, `negativeControls`,
   `section7Readiness`, `tests/readiness`. The readiness payload is validated against the same
   schemas without HTTP by the new suite, so the gap is the HTTP layer, not the shape.
5. **The bounded never-opened heuristic is a judgement call.** Kite refuses a bad token at the HTTP
   upgrade, surfacing as an ordinary `1006` — indistinguishable on one sample from a network failure.
   Five failed opens is the chosen threshold; if a site's network routinely fails five consecutive
   connects, this will report a credential problem that is really a network one. The message says
   "most likely", and the condition is recoverable by signing in again.
6. **Dhan `depthLevel: 20` remains a dead branch** in `sendSubscribe` (both ternary arms are
   `SUBSCRIBE_FULL`). Left as-is — 20/200-level depth is a different Dhan architecture with far
   tighter instrument limits and is not suitable for thousands of strikes.
7. **`market_data_healthy` / `feed_healthy` booleans are still published** for older clients. They
   remain crude by design; the new fields are the honest ones.
8. **Frontend rendering was not visually verified** — no browser, and `vite build` cannot run.
   Component logic is covered through the pure derivations plus the typecheck.

---

## 5. Deployment — existing PM2 setup

**Check the existing configuration before changing anything. Do not overwrite the production `.env`.
Do not enable live trading.**

```bash
# ── 0. On the EC2 box, confirm what is running now ─────────────────────────────
pm2 list
pm2 describe <backend-app-name>          # note: cwd, script, exec_mode, instances
pm2 env 0 | grep -E 'BOX_EXECUTION_MODE|BOX_LIVE_TRADING_ENABLED|BOX_DEDICATED_MARKET_FEED'
#   EXPECT: BOX_EXECUTION_MODE=paper_latency, BOX_LIVE_TRADING_ENABLED unset/false.
#   If BOX_EXECUTION_MODE is anything else, STOP and reconcile before continuing.
```

No new environment variable is introduced by this change, and no existing one changes meaning.
`.env` needs **no edit**.

```bash
# ── 1. Back up the current release (so rollback is a checkout, not a rebuild) ──
cd /path/to/GAR_B
git rev-parse HEAD > ~/gar_b_rollback_sha.txt
cp .env ~/gar_b_env_backup_$(date +%F).bak     # backup only; never overwritten by deploy

# ── 2. Fetch and check out the reviewed commit ────────────────────────────────
git fetch origin
git checkout fix/paper-mode-websocket-market-data     # or the merge commit on main
git log --oneline -1

# ── 3. Install and BUILD. The build must be green before restarting. ──────────
npm ci
npm run typecheck        # tsc -b — must exit 0
npm run build            # noEmitOnError:true, so dist/ only appears if it typechecked

# ── 4. Run the suites that need no database, plus the DB ones if available ────
npm run test:unit
npm run test:invariants
npm run test:contract
#   With DATABASE_URL/MONGODB_URI reachable from the box, also:
# npm run test:integration && npm run test:switch && npm run test:tokens

# ── 5. Restart. --update-env re-reads .env WITHOUT modifying it. ──────────────
pm2 restart <backend-app-name> --update-env
pm2 logs <backend-app-name> --lines 100
```

Expected in the logs shortly after start (during market hours):

- `[DhanFeed] firstTick internalToken=… batch=… wanted=… subscribed=…` (Dhan active), or Zerodha
  ticks flowing with **no** `box lane (zerodha) feed died` line.
- A `box lane (zerodha) transport fault (recovering)` line is now **informational** — the lane
  reconnects. It must **not** be followed by an `AUTH_EXPIRED` market-data state.

### Frontend

```bash
cd /path/to/GAR_F
git fetch origin && git checkout fix/paper-mode-websocket-market-data
npm ci
npm run contract:verify          # digest must match the backend's 1.11.0 pin
npm run contract:types:check     # generated types must be in sync
npm test
npm run build                    # tsc -b && vite build
# publish dist/ to the path Nginx serves, then:
sudo nginx -t && sudo systemctl reload nginx
```

**Deploy the backend first.** The frontend pins contract `1.11.0`, and `paper_execution` is a
*required* field on an `additionalProperties: false` schema — a `1.11.0` frontend against a `1.10.0`
backend will reject the whole `box-status` response.

### Rollback

```bash
cd /path/to/GAR_B && git checkout $(cat ~/gar_b_rollback_sha.txt)
npm ci && npm run build && pm2 restart <backend-app-name> --update-env
```

Nothing in this change writes to PostgreSQL or MongoDB schemas, so rollback needs no migration. The
only cross-repo coupling is the contract version, so roll **both** back together.

---

## 6. Authenticated runtime verification (during market hours)

This is the evidence that is still owed. Run it on the EC2 box, signed in, with the market open and
a broker session established.

```bash
# Authenticate to the protected surface and keep the session cookie.
curl -sS -c /tmp/gar.jar -X POST https://gtsalgoresearch.online/api/access/verify \
  -H 'Content-Type: application/json' \
  --data '{"passcode":"<REDACTED>"}' | python3 -m json.tool
# Do NOT paste the passcode into a shell that records history; use `read -rs` into a variable.
```

### Step 1 — the market-data lifecycle is armed and advancing

```bash
curl -sS -b /tmp/gar.jar https://gtsalgoresearch.online/api/box/status \
| python3 -c '
import json,sys
s=json.load(sys.stdin); r=s["operational_readiness"]; md=r["market_data"]; ev=r["evidence"]
print("execution_mode      :", s["execution_mode"])
print("market_data_state   :", md["state"], "generation", md["generation"])
print("source              :", md["source"])
print("socket/auth/subs    :", md["socket_connected"], md["authenticated"], md["subscriptions_requested"])
print("desired / usable    :", md["desired_instruments"], "/", md["usable_books"])
print("frames/depth/beats  :", md["frames_observed"], md["depth_observations"], md["heartbeats_observed"])
print("raw_tick_age_ms     :", ev["market_data_frame_age_ms"])
print("depth_age_ms        :", ev["market_data_depth_age_ms"])
print("age_clock           :", ev["market_data_age_clock"])
print("paper_execution     :", r["paper_execution"]["detail"])
print("fills_observed_by   :", r["fill_observation"]["mechanism"])
print("exposure exit/cancel:", r["exposure_management"]["exit_and_reduce"], r["exposure_management"]["protective_cancel"])
'
```

**Pass criteria**

| Field | Required |
|---|---|
| `execution_mode` | `paper_latency` |
| `market_data_state` | `READY` (or `SYNCHRONIZING` briefly after start) — **never `DISABLED`** |
| `generation` | **≥ 1** |
| `source` | `broker_websocket` |
| `market_data_frame_age_ms` | a **small integer** (typically < 5 000) — **never null**, never ~1.7e12 |
| `market_data_depth_age_ms` | a small integer, `≤ BOX_QUOTE_MAX_AGE_MS` |
| `age_clock` | `monotonic` |
| `depth_observations` / `usable_books` | **> 0** |
| `fills_observed_by` | `simulated_paper_fills` — **never `rest_polling_only`** |
| `paper_execution.detail` | contains *"Real broker WebSocket quotes · simulated execution"* |
| `exposure_management.protective_cancel` | `true` |

### Step 2 — `quote_updates` is increasing and ages stay fresh

```bash
for i in 1 2 3 4 5 6; do
  curl -sS -b /tmp/gar.jar https://gtsalgoresearch.online/api/box/status \
  | python3 -c '
import json,sys,time
s=json.load(sys.stdin); r=s["operational_readiness"]
print(time.strftime("%H:%M:%S"),
      "frames",  r["market_data"]["frames_observed"],
      "depth",   r["market_data"]["depth_observations"],
      "books",   r["market_data"]["usable_books"],
      "tick_age",r["evidence"]["market_data_frame_age_ms"],
      "state",   r["market_data"]["state"])'
  sleep 10
done
```

**Pass:** `frames` and `depth` strictly increase across samples; `tick_age` stays small (it must not
climb monotonically); `state` stays `READY`.

**This is the step that actually proves the production WebSocket is delivering.** If `frames`
increases but `depth` does not, the socket is alive and the ladder is not arriving — a real fault,
now correctly distinguishable rather than hidden.

### Step 3 — candidates are being evaluated

```bash
curl -sS -b /tmp/gar.jar https://gtsalgoresearch.online/api/box/status \
| python3 -c '
import json,sys
s=json.load(sys.stdin)
print("scanner running :", s.get("running"))
print("opportunities   :", len(s.get("opportunities") or []))
f=s.get("execution_funnel") or {}
for k in ("candidates","qualified","attempted","entered"):
    if k in f: print(f"{k:16}:", f[k])
'
```

**Pass:** with the scanner started during market hours, `candidates` > 0. Zero candidates while
`depth_observations` > 0 and `usable_books` > 0 points at the strategy gates (edge, coherence,
economics), **not** at market data — which is precisely the separation this change makes legible.

### Step 4 — the order stream is reported as inactive, not broken

```bash
curl -sS -b /tmp/gar.jar https://gtsalgoresearch.online/api/box/status \
| python3 -c '
import json,sys
snap=json.load(sys.stdin)["order_stream"]
print("any_stream_live:", snap["any_stream_live"])
for b in snap["brokers"]:
    print("  ", b["broker"].ljust(8), "wiring=", b["wiring"].ljust(22), "fills=", b["fills_observed_by"])
'
```

**Pass:** every broker reports `wiring: not_applicable_paper` and
`fills_observed_by: simulated_paper_fills`. **No broker reports `not_wired`.**

### Step 5 — reconnect recovery (optional, out of hours)

Confirms fix **C** against the real broker without touching orders:

```bash
pm2 logs <backend-app-name> --lines 0 &
sudo iptables -A OUTPUT -p tcp --dport 443 -d ws.kite.trade -j DROP   # or block briefly at the SG
sleep 20
sudo iptables -D OUTPUT -p tcp --dport 443 -d ws.kite.trade -j DROP
```

**Pass:** logs show a transport fault and a **reconnect with restored subscriptions**; the
market-data state returns to `READY`; it does **not** become `AUTH_EXPIRED`, and the lane does not
stay dead. Before this change, that blip killed the box lane for the life of the process.

### Step 6 — the dashboard

Open `https://gtsalgoresearch.online`, sign in, open the operational panel. Expect: no red exposure
warning; "Real broker WebSocket quotes · simulated execution"; "Simulated fills"; the order stream
"not applicable (paper)" in neutral styling; quote source, socket/auth/subscribed, desired-vs-usable
books and frames/depth/heartbeats all populated; evidence ages small and in seconds — not "never
observed".
