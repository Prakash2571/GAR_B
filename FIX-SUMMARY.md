# GTS Box live box-arbitrage execution — fix summary

Backend: `Prakash2571/Strikedge_B`, branch `fix/live-execution-hardening`.
Frontend: `Prakash2571/Strikedge_F`, branch `fix/order-stream-status`.
Reviewed baseline: backend `8da7ca47846a64d93499c521772b0747b293e5ee`, frontend
`0d265548c8381ad48ebeeba9f09edb09d4d26e35`. Date: 2026-09-09.

**No real orders were placed, live trading was not enabled, nothing was deployed, and no
production credential was touched. No test contacts a real broker endpoint.**

---

## 1. Status of the twelve items

| # | Item | Status |
|---|---|---|
| 1 | Hedge-quantity barrier, both brokers | **Done** |
| 2 | Dhan immediate terminal response accounting | **Done** |
| 3 | Final guards at the real HTTP send boundary | **Done** |
| 4 | End-to-end deadlines | **Done** |
| 5 | Four-leg coherence in live execution | **Done** |
| 6 | Broker order-update streams | **PARTIAL — see §3** |
| 7 | Latency reduction + benchmark | **Done (offline/simulated only)** |
| 8 | Pacing matches current broker rules | **Done** |
| 9 | Honest economic/capital admission | **Done** |
| 10 | Conservative Mumbai EC2 profile | **Done** |
| 11 | Execution diagnostics + frontend status | **Done** |
| 12 | Validation and delivery | **Done** |

---

## 2. Affected files, by item

**Item 1 — hedge barrier:** `src/box/hedgeCoverageLedger.ts` (new),
`src/box/liveEntryGuard.ts`, `src/box/orderManager.ts`,
`tests/box/hedgeQuantityBarrier.test.mjs`, `tests/box/liveEntryOwnershipGuard.test.mjs`.

**Item 2 — Dhan terminal accounting:** `src/box/dhanBrokerAdapter.ts`,
`tests/box/defect2DhanTerminalAccounting.test.mjs`, `tests/box/dhanAdapter.test.mjs`.

**Items 3 & 4 — send boundary and deadlines:** `src/brokers/deadline.ts` (new),
`src/brokers/dhan/http.ts`, `src/brokers/dhan/client.ts`, `src/box/kiteBrokerAdapter.ts`,
`src/kite.ts`, `tests/box/defect3SendBoundaryGuard.test.mjs`,
`tests/box/defect4EndToEndDeadlines.test.mjs`, `tests/box/kiteBrokerAdapter.test.mjs`.

**Item 5 — coherence:** `src/box/executionCoherence.ts` (new),
`src/box/executionGateway.ts`, `src/box/executionSimulator.ts`, `src/box/config.ts`,
`src/box/types.ts`, `.env.example`, `tests/box/executionCoherence.test.mjs`.

**Item 6 — order-update streams:** `src/box/orderUpdateProjection.ts` (new),
`src/brokers/dhan/orderFeed.ts` (new), `src/brokers/zerodha/orderUpdates.ts` (new),
`src/ticker.ts`, `tests/box/orderUpdateStreams.test.mjs`.

**Items 8 & 9 — pacing and economics:** `src/box/brokerPacing.ts`,
`src/box/boxCapital.ts`, `docs/BROKER_LIMITS.md`, `docs/ECONOMIC_ADMISSION.md`,
`tests/box/brokerRateBudget.test.mjs`, `tests/box/economicAdmission.test.mjs`.

**Item 7 — benchmark:** `bench/executionLatency.mjs` (new).

**Item 10 — deployment profile:** `docs/MUMBAI_EC2_PROFILE.md` (new),
`deploy/mumbai-ec2-conservative.env.example` (new), `docs/DEPLOYMENT.md`.

**Item 11 — diagnostics and status:** `src/box/executionFunnel.ts` (new),
`src/box/orderStreamStatus.ts` (new), `src/box/engine.ts`,
`contract/schemas/order-stream-status.schema.json` (new),
`contract/schemas/box-status.schema.json`, `contract/version.json`,
`tests/box/executionFunnel.test.mjs`, `tests/box/orderStreamStatus.test.mjs`.
Frontend: `src/BoxOrderStreamStatus.tsx` (new), `src/Box.tsx`, `src/api/types.ts`,
`src/api/contract.generated.ts`, `src/styles.css`, `tests/fixtures/box-status.json`,
`contract/**`.

---

## 3. Item 6 is PARTIAL — read this before relying on fill latency

The order-update stream modules are **implemented and unit-tested but not consumed by any
running component.** Verified by grep: nothing outside their own files imports
`OrderUpdateProjection`, `DhanOrderFeed` or `parseKiteOrderFrame`. `src/ticker.ts` gained an
`onTextFrame?` seam (so Kite text postbacks are no longer discarded) but **no caller supplies
that callback**, and `DhanOrderFeed` is never instantiated.

**Consequence: fills are still observed by REST polling only.** Fill-observation latency is
bounded by the polling cadence and the broker pacing floor, not by broker push latency.

Rather than leave that invisible, it is now reported. `/api/box/status` `.order_stream`
distinguishes `not_built` / `not_wired` / `gated_off` / `armed` and names the mechanism
actually observing fills. An **armed env gate with no consumer still reports `not_wired`** —
a switch with nothing listening delivers no fills. The frontend renders `not_wired` as a
**warning**, not a neutral "off", and states the operational consequence.

This also closes the specific conflation item 6 warns about: `market_data_healthy` was
exposed while order-stream health was not, so a healthy tick feed could be read as evidence
that fills arrive promptly. The two now sit adjacent in the payload with an explicit
`market_data_health_is_not_order_stream_health: true` flag.

Wiring the consumers is deliberately **not** done here: it changes the live fill-observation
path, which is the single most safety-critical seam, and doing it without supervised broker
observation would be the kind of unverified change this whole exercise exists to avoid.

---

## 4. Item 5 — coherence, and the integration finding

`BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS` was defined at `src/box/config.ts:1106`, exposed
at `src/box/executionPolicy.ts:55-56`, and consumed in **exactly one place** — the paper
simulator. `src/box/executionGateway.ts` never read it, so live admitted books 8,000 ms apart
because each per-leg age stayed under the 15,000 ms allowance. Per-leg freshness is blind to
cross-leg skew.

Fixed with one shared pure decision (`src/box/executionCoherence.ts`) used by **both** paths:
live admission at `executionGateway.ts:261` (before any submit) plus a pre-transmit re-check at
`:327`, and the paper gate at `executionSimulator.ts:718`. They cannot drift because there is
one decision.

**Integration finding:** the streams work independently added Kite exchange-timestamp parsing
at `src/ticker.ts:205-214` (packet offset 60, epoch **seconds** ×1000, only for full packets,
0 treated as absent). That closes coherence handoff item #1, so the exchange-dispersion half
of the gate is now **active for Zerodha** rather than inert. Dhan still supplies no order-book
timestamp — only Last Trade Time, which is never substituted — so Dhan legs are governed by the
receive-time constraint.

**Broker timestamp semantics (verified 2026-09-09):**

- Zerodha Kite Connect v3 WebSocket, `full` mode: exchange timestamp at bytes 60-64 is epoch
  **seconds** → 1-second granularity. `quote`/`ltp` carry none.
  <https://kite.trade/docs/connect/v3/websocket/>
- DhanHQ v2 live market feed: neither Quote nor Full packet carries a depth-publication
  timestamp; the only time field is **LTT**, epoch seconds. LTT is a last-trade time, not a
  book time. <https://dhanhq.co/docs/v2/live-market-feed/>

A sub-second exchange threshold would therefore reject coherent Kite books on quantisation
alone. The shipped default (250 ms) is **below** Kite precision; the Mumbai profile raises it
to 1000 ms and explains that the receive-time gate is otherwise the effective constraint.

**Meaning of a 0 limit:** in live, 0 is **impossible-to-satisfy**, not a silent bypass, unless
`BOX_COHERENCE_ZERO_DISPERSION_DISABLES_IN_LIVE=true` is set explicitly. Paper reads 0 as
disabled, preserving historical behaviour.

**What receive-time coherence proves:** that the four packets *arrived* close together. It does
**not** prove the exchange published them simultaneously. Stated in code, in the reject text,
and via `CoherenceDecision.basis`.

---

## 5. Regression evidence per confirmed defect

Each defect has a failing-first record produced by restoring the pre-fix file via
`git show <baseline>:<path>`, rebuilding, running, capturing verbatim output, then restoring
the fix and capturing the passing output.

| Defect | Evidence file |
|---|---|
| 1 — hedge barrier | `EVIDENCE-hedge.md` |
| 2, 3, 4 — Dhan terminal, send boundary, deadlines | `EVIDENCE-transport.md` |
| 5 — coherence | `EVIDENCE-coherence.md` |
| 6 — order-update streams | `EVIDENCE-streams.md` |
| 8, 9 — pacing, economics | `SUMMARY-pacing-econ.md` |

For defect 5 specifically: the pre-fix live gateway **admitted** an 8,000 ms cross-leg-dispersed
book and submitted all four legs, both **with** and **without** exchange timestamps. Post-fix
the same probe **fails** with `0 !== 4` — nothing submitted. Kept assertions live in
`tests/box/executionCoherence.test.mjs` (22 tests).

---

## 6. Test counts — exact, including the honest denominator

Backend, from a clean `npm ci` (115 packages, 0 vulnerabilities) and a clean `tsc -b`
(`noEmitOnError`, so a successful build is meaningful evidence):

| Suite | tests | pass | fail | skipped | todo |
|---|---|---|---|---|---|
| unit (`tests/box`) | 1590 | 1590 | 0 | 0 | 0 |
| invariants | 3 | 3 | 0 | 0 | 0 |
| tokens | 48 | 48 | 0 | 0 | 0 |
| access | 31 | 31 | 0 | 0 | 0 |
| switch | 32 | 32 | 0 | 0 | 0 |
| shutdown | 11 | 11 | 0 | 0 | 0 |
| readiness | 24 | 24 | 0 | 0 | 0 |
| contract | 44 | 44 | 0 | 0 | 0 |
| pg | 71 | 71 | 0 | 0 | 0 |
| projector | 17 | 17 | 0 | 0 | 0 |
| **TOTAL** | **1871** | **1871** | **0** | **0** | **0** |

Frontend: `npm ci` (74 packages, 0 vulnerabilities), `tsc -b && vite build` clean,
**87 tests / 87 pass / 0 fail / 0 skipped / 0 todo**, `contract:verify OK` (1.3.0, digest
`ff81fb95…4e95c8dd`, 33 files), `contract:types:check` clean.

### The PostgreSQL denominator, stated honestly

The delivery requirement says mock database tests must not be counted as PostgreSQL
integration coverage. So, precisely:

- **52 of the 71 `tests/pg` tests are genuinely DB-backed.** The other **19** are pure
  in-memory unit tests co-located in `tests/pg/executionAttemptProjection.test.mjs` (the only
  file there with no `setup()` hook). They are legitimate tests but are **not** PostgreSQL
  coverage.
- **16 of the 17 projector tests** require live PostgreSQL *and* live MongoDB; the exception is
  `tests/projector/noSecrets.test.mjs`, a pure unit test.

**Proof the DB tests are real, not mocks** (measured, not asserted): against a dead port the
52 fail **loudly** as `hookFailed` with `PostgreSQL is required for the pg integration tests
but is not reachable at …` (`tests/pg/helpers.mjs:44` via `setup()` at `:57`); **0 skipped in
every configuration**; grep for `.skip|pg-mem|sqlite|mongodb-memory-server` across both
directories returns **zero matches**. Server: PostgreSQL 16.15. Captured *during* a run: 7 real
schemas, 98 real tables, 7 connections identified by `application_name strikedge-test-*`, real
`SELECT … FOR UPDATE` / `INSERT INTO mongo_outbox` traffic, and `pg_stat_database.xact_commit`
advancing 31,136 → 35,016.

One nuance worth knowing: an **unset** `DATABASE_URL` does not skip — `helpers.mjs:21` falls
back to the same hardcoded live URL. That is a fallback, not a guard.

---

## 7. Offline latency comparison and its assumptions

`node bench/executionLatency.mjs` — virtual clock, **real** `TransportPacer` and real
per-broker pacing profiles, mocked response delays. 500 iterations per cell, seed 20260909.

| Broker | Conc | first→last submit p50/p95/p99 (ms) | four-leg completion p50/p95/p99 (ms) | fill disp p95 |
|---|---|---|---|---|
| Zerodha | 1 | 446 / 1447 / 2209 | 596 / 1737 / 2400 | 1459 |
| Zerodha | 2 | 440 / 1341 / 2085 | 589 / 1646 / 2432 | 1411 |
| Zerodha | 4 | 440 / 1400 / 2216 | 594 / 1643 / 2337 | 1433 |
| Dhan | 1 | 480 / 1459 / 2219 | 621 / 1767 / 2440 | 1477 |
| Dhan | 2 | 480 / 1351 / 2095 | 613 / 1666 / 2452 | 1431 |
| Dhan | 4 | 464 / 1427 / 2228 | 619 / 1672 / 2337 | 1461 |

**Assumptions (inputs, not measurements):** POST 40/70/160 ms min/p50/p95 with a 900 ms outlier
at 5%; status read 30/50/90 ms; partial-fill rate 20%; rate-limit rate 3% with 1000 ms
Retry-After; durable PG intent write 2/4/12 ms; admission 1/2/6 ms.

**Conclusion — concurrency barely matters.** The four-leg pacing floor (330 ms Zerodha, 360 ms
Dhan) plus the hedge-first dependency (dependent SELLs cannot transmit until both BUY hedges
are confirmed) is the binding constraint. **Recommended profile: entry concurrency 1** — no
slower in the regime that matters and simpler to reason about. Concurrency 4 overlaps *within*
a wave only and does **not** make four-leg execution atomic.

Only pacing, queueing and serialisation are real code under test. These figures bound our own
application's behaviour, not the broker's.

---

## 8. Proposed Mumbai EC2 configuration

See `docs/MUMBAI_EC2_PROFILE.md` and `deploy/mumbai-ec2-conservative.env.example`. Every cited
default was verified programmatically against `loadBoxConfig()` rather than transcribed.

Headlines: real trading disabled by default behind two independent switches
(`BOX_EXECUTION_MODE=live` is rejected at boot unless `BOX_LIVE_TRADING_ENABLED=true`); one lot;
one active box; one active box per underlying; explicitly armed one-completed-box session;
entry concurrency 1; capital cap labelled **gross order notional** (not margin, not peak legging
capital, not max loss).

Entry authorization is separate from exposure management: `orderManager.ts:768` requires **both**
`entryEnabled` and `liveOrderEnabled` to enter, while `:787` requires only `liveOrderEnabled` for
protective work — so new entries can be disarmed while owned exposure stays manageable. Never
disable `liveOrderEnabled` while exposure exists.

Also documented: Elastic IP / NAT for broker static-IP whitelisting, Amazon Time Sync via chrony,
never `synchronous_commit = off`, pool and timeout settings, monitoring including event-loop lag
and CPU-credit exhaustion, restart/recovery, configuration precedence with the instruction to read
effective values back from `/api/box/status .config`, and the requirement that **CalSpread Box
execution be disabled before arming GTS Box live against a shared account** (shared rate
budgets neither application can observe — operational coordination, not a code guarantee).

**A loss breaker is not a guaranteed maximum loss.** It stops new entries; it cannot cap exposure
already held, unwind slippage, or a gap move.

---

## 9. Migration, deployment and rollback

Full procedure in `docs/MUMBAI_EC2_PROFILE.md` §10. Summary: back up first; `npm ci`; `npm run
build`; run the suite against real PostgreSQL; `npm run migrate`; start in **paper** and confirm
`/api/box/status .config` shows the intended effective values; only then arm live in a supervised
window.

Rollback: disarm entry first but leave exposure management on; confirm flat (`open_positions`,
`residual_exposure_count`, `unknown_orders`, `recovery_active`); only then roll code back. **Never
roll back while exposure exists.** A backend rollback that lowers `contract_version` requires a
matching frontend rollback.

---

## 10. Remaining limitations and required supervised live validation

1. **Item 6 is not wired** (§3). Fills are REST-observed. Wiring the consumers requires
   supervised validation.
2. **Every latency figure here is simulated.** No live broker observation exists.
3. **The migration-ledger logic is not exercised** by the pg harness — it applies migration
   files directly (001-004, 008) rather than through `npm run migrate`, and skips 005-007.
4. `tests/projector/resilience.test.mjs` contains a load-sensitive wall-clock assertion that
   could flake on a busy machine.
5. **Coherence receive-time evidence remains a proxy** for exchange simultaneity; correctly
   labelled, never over-claimed.
6. **Shared-account rate budgets cannot be observed** across applications. Coordination is
   operational.

**A code review cannot prove that most future trades will fill.** What is *demonstrated* is
that the confirmed defects reproduce before the fixes and do not after, that the suite is green
against real PostgreSQL, and that the status surface now reports the fill-observation mechanism
honestly. What is *only simulated* is every latency and dispersion figure. What **requires real
broker observations**: a completing four-leg entry, a partial entry and its recovery cost, a
no-fill cancellation, a deliberate rate-limit encounter, a restart with open exposure, and
whether the order-update stream is worth wiring measured against the REST baseline this build
actually uses.
