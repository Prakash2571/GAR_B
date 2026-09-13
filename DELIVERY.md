# Delivery record — live-execution integration

Branch `feat/order-stream-integration`, 40 commits past `main` (`e357b83`).

Verified on 2026-09-10 in a **pristine clone** (`git clone` + `npm ci`), not just the working tree:

| Check | Result |
| --- | --- |
| `npm ci` | exit 0, 0 vulnerabilities |
| `npm run build` (`tsc -b`) | exit 0 |
| All 10 suites | **2036 pass · 0 fail · 0 skipped** |
| `.github/ci/no-live-hostnames.sh` | PASS |
| `.github/ci/no-egress-guard.mjs` | PASS |
| `contract/validate.mjs` | PASS (33 schemas) |

Per-suite: unit 1752 · invariants 3 · tokens 48 · access 31 · switch 32 · shutdown 11 ·
readiness 24 · contract 44 · pg 74 · projector 17. Baseline at `main` was 1871; at the start of
this integration work, 1903.

---

## 1. Production wiring table

Every module below is **constructed and called by a production code path**, not only by tests.
`file:line` references are at branch HEAD.

| Module | Constructor | Production caller | Event source | Durable consumer | Proving test |
| --- | --- | --- | --- | --- | --- |
| `OrderUpdateProjection` | `orderStreamConsumer.ts:104` | `OrderStreamConsumer` (`engine.ts:790`); ingest via `engine.ts:5463`, `orderManager.ts:2349` | Kite text postbacks + Dhan `order_alert` + REST snapshots | adapter session → `orderManager.persistence.update` | `orderUpdateStreams.test.mjs`, `orderStreamConsumer.test.mjs` |
| `DhanOrderFeed` | `registry.ts:553` (`null` unless Dhan active) | `engine.ts:5529` `startOrderStreamTransports` ← `engine.ts:1316` | `wss://api-order-update.dhan.co` | same projection chain | `orderStreamConsumer.test.mjs` |
| `parseKiteOrderFrame` | pure fn `orderUpdates.ts:86` | `engine.ts:5461` `processOrderEventFrame` | `ticker.ts:110` text frame → `feed.ts:106` → `registry.ts:496` → `engine.ts:5447` | same projection chain | `orderStreamRealWaiter.test.mjs` |
| `OrderStreamConsumer` | `engine.ts:790` | `BoxOrderManager` (`engine.ts:817`) | both broker streams + REST | PostgreSQL via order manager | `orderStreamConsumer.test.mjs` |
| `MarketDataStateMachine` | `engine.ts:657` | gates entry: `engine.ts:925` → `executionGateway.ts:285` | feed lifecycle `engine.ts:5390`, depth `engine.ts:2186` | entry refusal record | `marketDataStateMachine.test.mjs`, `disconnectDuringStage.test.mjs` |
| `OrderStreamStateMachine` | inside consumer, `engine.ts:790` | **`entryPermittedFromStreams`** at `engine.ts:932` | stream connect/auth/idle/disconnect | entry refusal record | `streamGovernance.test.mjs` |
| `RateBudgetLedger` | `registry.ts:1557` (memoised per account) | `kiteBrokerAdapter.ts:1049/1073`, `dhanBrokerAdapter.ts:520/535` at the send boundary | HTTP mutation attempts | refusal counters + metrics | `rateBudgetProductionWiring.test.mjs` |
| `evaluateEconomicAdmission` / `buildEconomicPicture` | `boxCapital.ts:593` / `:506` | `executionGateway.ts:1308`, called `:393`, refuses `:394` | broker funds/margin reads | entry refusal record | `economicAdmissionWiring.test.mjs` |
| `ExecutionFunnel` | `engine.ts:394` | `engine.ts:1036-1037`, `~4344-4350`; published `engine.ts:5196` | scanner + gateway + order manager + exit path | `/api/box/status` payload | `funnelProductionWiring.test.mjs` |
| `StagePipeline` (bounded queue) | `engine.ts:667`, `order_events` `:668` | `engine.ts:5455` enqueue; overload → `engine.ts:676-681` | WS ingestion | blocks entry + triggers `orderManager.reconcile()` | `boundedQueue.test.mjs` |
| `exitDependencies` | pure module | `executionGateway.ts:734/815/1523` | exit planning | durable residual exposure | `defectAExitHedgeDependencies.test.mjs` |
| `brokerExecutionEvidence` | pure module | `dhanBrokerAdapter.ts:429/1093/1420`, `kiteBrokerAdapter.ts:857/1170` | every observation path | evidence quality on the durable order | `defectBDhanEvidenceValidation.test.mjs` |
| `effectiveConfig` | `effectiveConfig.ts:263` | **operator CLI only** (`:353`) — deliberately *not* in the running process | — | — | `effectiveConfig.test.mjs` |

`effectiveConfig` is listed honestly as a pre-flight operator tool. It is not claimed as part of
the running trading path.

## 2. Defects found by independent audit, and their fixes

An independent read-only audit was run before merge. It found the integration real for the
observation path but the **order-stream health machine behaviourally inert**. All findings fixed:

| ID | Defect | Fix |
| --- | --- | --- |
| D1 | Order-stream permission table had zero production callers, so stream loss did **not** restrict new entry | Entry gate is now the intersection of both transports via the shared `combinedPermissions` table (`engine.ts:932`). Entry-only: protective cancel, exit and attributed reduction are never routed through it. A **DISABLED** stream never blocks, because REST polling is the documented baseline. |
| D2 | `ZERODHA_ORDER_STREAM_ENABLED` did not gate the fill path — the flag only moved a label | The flag now genuinely gates consumption (`engine.ts:5541` `zerodhaTextFramesConsumed()`); unset means the frame is dropped before parse and fills are observed by REST only. |
| D3 | Two `CumulativeFillLedger` stores, one commented "ONE TRUTH" | The second store is a genuine independent overfill tripwire (only it calls `trip()`). Kept deliberately, renamed `overfillTripwireLedgers` / `checkOverfillTripwire`, comments corrected, and a real-PostgreSQL test pins that the two can never disagree and that a re-fed snapshot counts exactly once. |
| D4 | Reconnect left `RECONCILING` only incidentally | Explicit post-reconnect gap-repair sweep; stays reconciling until consistent; updates arriving during reconciliation merge without double-count. |
| D5 | `onIdle()` uncalled, so "connected but not delivering" was undetectable | Idleness driven against an expected-idle bound, **scoped to working-order expectation** so a quiet account is not a false alarm. |
| D6 | Zerodha order-stream health stuck at `CONNECTING` | Lifecycle driven from the same quote-socket connection that carries the postbacks. |
| D7 | `effectiveConfig` header claimed a status-route caller it did not have | Comment corrected to describe it as an operator pre-flight CLI. |

Safety audit result: no guard removed or loosened, no test deleted, skipped or weakened, and none
of the five forbidden promises present. Confirmed independently by diffing `main..HEAD`: the only
removed assertions are in `partialEntryGateway.test.mjs` and `executionGateway.test.mjs`, both
**strengthened** rewrites required by the exposure-aware exit change (the hedge is now retained
rather than sold away, and exit order is derived as a property instead of a hardcoded snapshot).

## 3. Confirmed fixes

- **Exits (1A).** Exposure-aware dependency waves: short-closing BUYs and unpaired longs first, a
  hedge release only after proven closure of the short it covers. Handles both directions, partial
  fills by attributed remaining quantity, and long-only residual geometry.
- **Dhan evidence (1B).** Absent ≠ confirmed zero on every observation path. A terminal label with
  no cumulative quantity yields `RECONCILIATION_REQUIRED`, not a zero fill. Missing price keeps the
  confirmed quantity but blocks fabricated P&L.
- **Send-boundary coherence (1C).** Four-leg coherence re-checked at the real send boundary after
  queueing and pacing, not only at admission.
- **Deadlines (1D).** Deadline starts before queue admission and is settled promptly on expiry;
  expired queued entry work can never execute later.
- **Order streams (2).** Real consumers on both brokers, ownership registered before POST,
  account-wide events attributed or rejected, one projection for REST + WebSocket, waiters woken on
  the event rather than the next poll.
- **Health machines (3).** Market-data and order-update health are separate types with separate
  state machines and an explicit permission table that now actually gates entry.
- **Market data (4/5/6).** Generation invalidation, per-instrument depth readiness, four distinct
  time facts, jittered bounded backoff, auth-expiry vs transient, bounded queues with overload
  exposure.
- **Rate/economics/outcomes (8).** Shared per-account rate budget enforced at the send boundary,
  economic admission refusing entry on missing or stale evidence, funnel with explicit denominators.
- **Benchmark (9).** Composed production path with a correct discrete-event scheduler; the
  old benchmark's ACK-as-fill and skipped-REST-confirmation flaws are structurally impossible.

## 4. Remaining limitations — stated plainly

- **No lossless data, no zero outages.** Both streams are best-effort account-wide delivery. REST
  remains the authority of record.
- **No exchange ordering guarantee.** Neither broker documents sequence numbers or event replay
  (`docs/BROKER_STREAM_DOCS.md`, verified 2026-09-09). Deduplication rests on cumulative
  monotonicity plus composite event identity. We detect regressions and duplicates; we cannot prove
  exchange order.
- **No atomic four-leg execution.** Four legs are four independent orders. Partial entry is a real
  outcome with a real recovery path, not an edge case.
- **No guaranteed fills or profitability.**
- **Whole-second exchange timestamps only.** Sub-second exchange thresholds are therefore invalid
  and are not set.
- **Dhan order socket:** no documented auth-ack frame and no documented connection cap, so
  "socket open" is not treated as "authorised and delivering", and no redundancy is claimed.
- **External account activity is unobservable** to our rate budget.
- **Benchmark numbers are offline** against assumed delays. They are not Mumbai broker latency.

## 5. Supervised live evidence still required

Before anyone asserts fill-rate or latency performance, a supervised live session must produce:

1. Real Mumbai→broker POST and status-read latency distributions, replacing the assumed inputs.
2. Real postback/`order_alert` arrival timing versus the REST poll, to confirm the fast path wins
   in practice and by how much.
3. Observed reconnect frequency and actual gap contents during a live session.
4. Confirmation that Dhan's order socket behaves as documented on auth rejection and on reconnect.
5. At least one supervised partial-entry recovery, end to end, with its true cost.
6. Rate-limit headroom under real concurrent load, including any undocumented account activity.

## 6. Deployment

Do **not** deploy or enable live trading from this branch without explicit sign-off. See
`docs/MUMBAI_EC2_PROFILE.md` for the conservative profile, `docs/DEPLOYMENT.md` for the
effective-config pre-flight, and `docs/RUNBOOK.md` for arming order and rollback.

Real trading is OFF by default (`config.ts:952`), both order streams are OFF by default, and the
live order manager starts with `entryEnabled: false` and `liveOrderEnabled: false`. CalSpread Box
execution must be disabled before GTS Box is armed against a shared account.
