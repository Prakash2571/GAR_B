# Fault matrix — what is asserted, and by which test

**Compiled 2026-09-13.** One row per fault. Each row names the test that actually asserts it, so a
claim in this table can be checked rather than believed.

> **Scope and honesty.** This is an **inventory of existing, passing coverage**, cross-referenced
> against the fault list, plus an explicit list of what is **NOT covered**. It is not a claim that
> the system handles every fault correctly — only that these specific properties are asserted by
> tests that run in CI against a real PostgreSQL and a real MongoDB.
>
> **Broker transport is mocked in every row.** Production normalization, state transitions and
> persistence are in the test path; the socket and the HTTP transport are not. No row here is
> evidence of live broker behaviour. See [`docs/BROKER_ADAPTER_AUDIT.md`](./BROKER_ADAPTER_AUDIT.md).

## Legend

| Mark | Meaning |
|---|---|
| **PG** | Asserted against a **real PostgreSQL** (`npm run test:pg` / `test:contract`) — transactional, ownership and restart claims |
| **UNIT** | Asserted in the hermetic suite (`test:unit` / `test:invariants`) with production modules in the path |
| **NOT COVERED** | No test asserts this. Stated so it is not mistaken for coverage. |

---

## 1. Submission-boundary faults

| Fault | Asserted outcome | Where | Kind |
|---|---|---|---|
| **Broker accepts POST but the response is lost** | Durable intent already exists in `SUBMITTING` before the POST. The order is **adopted** by correlation/tag rather than resubmitted; the ambiguous submission is **never blindly retried**. | `tests/box/ambiguousSubmitAdoption.test.mjs` | UNIT |
| **Timeout before acceptance is known** | Treated as **ambiguous, not failed**. No second POST for the same intent; resolution comes from reconciliation. | `tests/box/ambiguousSubmitAdoption.test.mjs` | UNIT |
| **Database failure BEFORE the POST** | The POST **does not happen**. A local refusal at the `post_persist` stage is a **proven no-POST**, distinguished in the audit trail from a broker rejection. | `tests/box/defect3SendBoundaryGuard.test.mjs`, `tests/pg/orderIntentCas.test.mjs` | UNIT + PG |
| **Broker accepts but subsequent local persistence fails** | The fill is **not lost**: `onPersistenceLossAfterFill` moves affected positions to `RECOVERY` with `exit_blocked_reason` set, and the loss is surfaced rather than swallowed. | `tests/pg/tradesAndRecovery.test.mjs` | PG |
| **Crash/restart at the durable submission boundary** | Intent state machine is CAS-guarded, so a half-written transition cannot be observed; recovery re-derives working orders from durable intent. | `tests/pg/orderIntentCas.test.mjs`, `tests/box/crashRecovery.test.mjs` | PG + UNIT |
| **Duplicate worker / duplicate submission ownership** | Two tiers refuse it: the in-process reservation store and the **durable** PostgreSQL reservation with globally-unique owner ids. | `tests/pg/reservations.test.mjs` | PG |

## 2. Partial-execution faults

| Fault | Asserted outcome | Where | Kind |
|---|---|---|---|
| **Partial hedge fill then failure** | Short entry legs are submitted **only after sufficient confirmed hedge fills**; a shortfall stops the sequence rather than proceeding naked. | `tests/box/partialEntryGateway.test.mjs`, `tests/box/hedgeCoverage*.test.mjs` | UNIT |
| **First short fills, another leg fails** | Bounded risk-reduction: the unwind reverses **shorts first** (wave 0), then long hedges only up to the quantity **proven** no longer needed as cover (wave 1). | `tests/box/partialEntryRecovery.test.mjs`, `tests/box/exitDependencies.test.mjs` | UNIT |
| **Residual that cannot be flattened** | Retained as **explicit unresolved exposure** and worked by the flatten loop. **Never reported as flat.** | `tests/box/residualRecovery.test.mjs` | UNIT |
| **Overfill (broker reports more than requested)** | Applied — broker truth wins — and **escalated** as a reconciliation condition, never clamped away. | `tests/box/statusVsFillSeparation.test.mjs` | UNIT |

## 3. Observation-channel faults

| Fault | Asserted outcome | Where | Kind |
|---|---|---|---|
| **WebSocket lost, REST available** | Lifecycle → `DISCONNECTED`; new entry refused, **exit/cancel/reduce continue**; a missing event is never a zero fill. A reconciliation is owed. | `tests/box/streamGovernance.test.mjs`, `tests/box/dhanOrderStreamLifecycle.test.mjs` | UNIT |
| **REST fails while WebSocket continues** | The reconciliation sweep fails **closed for readiness** (stays `RECONCILING`, entry refused) and retries with bounded backoff, without blocking the socket callback. | `tests/box/dhanOrderStreamLifecycle.test.mjs` | UNIT |
| **Both channels unavailable** | Nothing can prove consistency, so the stream stays `RECONCILING` and entry stays refused rather than assuming an empty gap. | `tests/box/dhanOrderStreamLifecycle.test.mjs` | UNIT |
| **Duplicate observation across REST and WS (both orders)** | Counted exactly once, in either arrival order; the later-arriving **lower** cumulative never wins. | `tests/box/statusVsFillSeparation.test.mjs` | UNIT |
| **Late confirmed fill after an observed cancellation** | The fill is **preserved** — it is real, irreversible exposure — while the terminal state stands for the remainder. | `tests/box/statusVsFillSeparation.test.mjs` | UNIT |
| **Cancel acknowledgement without a confirmed terminal state** | Cancel-requested is **not** terminal; the order is only settled on confirmed terminal evidence. | `tests/box/statusVsFillSeparation.test.mjs`, `tests/box/orderStreamConsumer.test.mjs` | UNIT |
| **Restart with working orders / replay** | Ownership is rebuilt from **durable intent**, and replaying the whole history plus a redelivery produces the same exposure exactly once (cumulative monotonicity is restart-safe). | `tests/pg/orderStreamRestart.test.mjs`, `tests/box/statusVsFillSeparation.test.mjs` | PG + UNIT |

## 4. Market-data and rate faults

| Fault | Asserted outcome | Where | Kind |
|---|---|---|---|
| **Quote loss after exposure exists** | Entry refused (candidate evidence fails); **exit and protective cancel are not blocked** by a stale book. | `tests/box/candidateMarketData.test.mjs`, `tests/invariants/exitImmunityProtectiveCancel.test.mjs` | UNIT |
| **Shared transport failure with fresh-looking cached books** | Refused as a **shared** failure: a book observed before the socket died is not evidence about now. | `tests/box/candidateMarketData.test.mjs` | UNIT |
| **Rate limiting during entry** | Pacing ledger enforces the documented per-broker budgets; a `429` does not become a retry storm. | `tests/box/brokerPacing.test.mjs`, `tests/box/rateBudget*.test.mjs` | UNIT |
| **Rate limiting during recovery** | Recovery capacity is **preserved**: the reconciliation retry uses bounded exponential backoff so recovery cannot flood the budget that exits and cancels also need. | `tests/box/dhanOrderStreamLifecycle.test.mjs` | UNIT |

## 5. Authority and store faults

| Fault | Asserted outcome | Where | Kind |
|---|---|---|---|
| **PostgreSQL unavailable** | Actions requiring authoritative persistence are refused: the scanner refuses to discover new boxes rather than trade unrecorded, and readiness reports it. | `tests/readiness/readiness.test.mjs`, `tests/box/crashRecovery.test.mjs` | UNIT |
| **PostgreSQL unavailable at boot (ordering)** | No durable boot ordinal ⇒ readiness is **unorderable** ⇒ the server itself refuses entry (`instance_epoch_unknown`) and the UI disables entry. | `tests/box/readinessInstanceOrdering.test.mjs`, `GTSAlgoResearch_F tests/readinessOrder.test.mjs` | UNIT |
| **Mongo replica unavailable** | Must **not** become an alternative source of truth, and must not block the scanner: Mongo is the asynchronous reporting replica. Distinguished from "no Box database configured". | `tests/projector/*.test.mjs`, `tests/box/tradingSession*.test.mjs` | PG + UNIT |
| **Session state unreadable** | Entry refused with `session_state_unreadable` — an unread session is **not** an unarmed one, so a transient outage cannot hand back a spent one-shot budget. | `tests/box/sessionAttemptBudget.test.mjs`, `tests/box/tradingSessionStore.test.mjs` | UNIT |
| **Consumption write fails** | Entry stays closed until the write lands, because a restart would otherwise resurrect the budget. | `tests/box/sessionAttemptBudget.test.mjs` | UNIT |
| **Kill switch while orders are working** | `emergencyFlatten` reduces exposure and is **never queued behind another control**; entry blockers do not disable it. | `tests/invariants/exitImmunityProtectiveCancel.test.mjs`, `tests/readiness/riskReductionGating.test.mjs` | UNIT |
| **Market close with unresolved exposure** | Entry refused (`market_closed`); residual exposure remains **explicitly unresolved** rather than being reported flat. | `tests/box/residualRecovery.test.mjs` | UNIT |

---

## 6. NOT COVERED — stated explicitly

These are real gaps. None is claimed as handled.

| # | Gap | Why it matters |
|---|---|---|
| 6.1 | **No test drives a real broker socket or a real HTTP transport.** Every row above mocks the transport. | Behaviour under genuine broker framing, partial TCP reads, TLS resets and real `429` bodies is **unobserved**. |
| 6.2 | **No end-to-end test of `engine.startOrderStreamTransports()` with a live adapter + PostgreSQL + broker session.** The Dhan lifecycle is covered by driving the **extracted production handlers**; the method itself is covered only by source-level assertions. | This is precisely how the original Dhan reconciliation defect survived ~2,000 tests. The extraction narrows the gap but does not close it. |
| 6.3 | **Multi-process / cluster topology is not tested.** The supported topology is a single fork-mode process, enforced by documentation and by the readiness-ordering incompatibility check rather than by a test. | Running two processes is out of contract; the failure would be detected but is not exercised. |
| 6.4 | **Clock-skew and NTP-step scenarios are not simulated.** Correctness was instead made **independent of wall clocks** (monotonic clocks for durations; a DB-minted ordinal for instance ordering). | The property is argued structurally, not demonstrated under skew. |
| 6.5 | ~~**Loss/capital budget enforcement is not asserted end-to-end.**~~ **CLOSED.** `tests/box/dailyLossLimitEntryBrake.test.mjs` now drives realised P&L past `BOX_LIVE_DAILY_LOSS_LIMIT` at its production default (₹5,000) and asserts a new entry is refused with **zero broker POSTs**; that a restart re-seeded from durable state re-trips it; that an incomplete reconstruction fails closed; that re-arming entry and rolling the trading day do not clear it; and that reduction is never blocked by it. | The brake is real and **entry-only**. Two residual caveats are documented rather than fixed: `BOX_LIVE_DAILY_LOSS_LIMIT=0` **disables** the gate (it does not mean "no loss allowed"), and the limit is a frozen copy in the manager's limits, so tightening it while armed needs a limits-republish path. Enforcement is also **indirect** — via the sticky circuit breaker, not a direct checkpoint comparison — so it engages only when an `evaluateLimits()`-calling event fires (every P&L mutation and the boot/day-roll seed do). |
| 6.6 | **Exchange-level rejections** (freeze quantity, price band, ban period) are classified from codes/text but never observed. | `classifyDhanReject` mapping is **NOT VERIFIED** against real rejections. |

## 7. How to re-run

```bash
npm ci
npm run build            # tsc -b; noEmitOnError, so a type error emits nothing
npm run test:unit        # hermetic
npm run test:invariants  # safety invariants
npm run test:pg          # REAL PostgreSQL
npm run test:projector   # REAL MongoDB
npm run test:contract    # REAL serialized responses vs contract/schemas
npm run test:readiness
```

CI runs all of these plus a fail-closed egress guard and a **no-silent-skips** gate that fails the
build if any database-dependent suite reports even one skipped test.
