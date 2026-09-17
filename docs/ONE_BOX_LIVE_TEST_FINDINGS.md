# One-box live test — readiness findings

Written while adding the operator blocklist. Everything here was read from source at `main`
(`c5b0361`). It records what a supervised single-box live test will and will not do, because several
behaviours do not match the obvious reading of the configuration.

`EVIDENCE-supervised-live-test-readiness.md` remains the fuller review; this document only adds what
that review does not state, or states differently from the code.

---

## 1. What actually guarantees "only one box"

`BOX_LIVE_MAX_OPEN_BOXES=1` does **not** guarantee it. The guard in
`BoxOrderManager.entryBlockReasonAfterControls` (`orderManager.ts:1106`) reads `this.openBoxes`,
which the engine only refreshes after `positions.add()` + `syncManagerExposure()`
(`engine.ts:3752-3766`) — i.e. after the fills. Two entry pipelines admitted in the same instant both
observe `openBoxes === 0`.

Nor does the session cycle budget: a cycle is counted **CONSUMED at establishment**, so both
pipelines see `consumed === 0`. Nor do instrument reservations, which are per-contract and so never
collide across different underlyings. Nor `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING`, which is
same-underlying only by construction (`underlyingLock.ts:1-30`).

The only mechanism that refuses a second concurrent entry on a **different** underlying is
**`BOX_SESSION_MAX_ENTRY_ATTEMPTS`**, because `recordAttemptStarted()` runs inside the store's
`serialize()` mutex and re-evaluates the ceiling *inside* the critical section. **Its default is
`0` = unlimited.**

`deploy/supervised-live-test.env.template` already sets it to `1`. Its §5 justifies that as bounding
*risk-taking*; it should be recorded as **the** one-box guarantee.

Two related gaps:

- `BOX_LIVE_MAX_OPEN_BOXES` is **live-only** — the order manager is constructed only on the live path
  (`engine.ts:1123`), so a paper rehearsal does not exercise it. Paper can open more boxes than the
  live config would allow.
- The whole session layer is **inert** when both ceilings are `0` (`!enforcing()`) *or* when box
  persistence is unavailable. In live, persistence is independently required, so that half only bites
  in paper.

## 2. Nothing stops after the box goes flat

There is no auto-disarm and no auto-stop anywhere. After the single cycle reaches FLAT:

- the session stays `armed: true`, reporting `state: "COMPLETED"`, `remaining_trades: 0`;
- further entry is refused by the spent budget (`session_limit_reached`), not by disarming;
- the scanner keeps running and keeps publishing; every candidate is refused at the coordinator
  prologue and increments `stats.sessionLimitRefusals`;
- `maybeReleaseFeed()` (`engine.ts:2730`) returns early while `this.running`, so the feed is retained.

There is also **no session-summary surface**: no endpoint, no SSE payload, no schema. A grep for
`session_summary|sessionSummary|session_report|/summary` across `src/` and `contract/` returns
nothing. The numbers exist, but assembling them is a client-side join across
`/api/box/trades/history`, `/api/box/events` and `/api/box/execution-attempts`.

`deploy/one-box-live-4leg.env.template` §7 gives the operator sequence that substitutes for this.

## 3. A dead websocket suspends exiting, not just entering

`BoxPositionMonitor.evaluatePosition` returns early on `!this.deps.isFeedHealthy()`, and every exit's
`stillWanted` predicate also requires a healthy feed — so an in-flight exit is abandoned mid-flight if
the feed dies. There is no REST/LTP fallback on the exit path and no "feed dead for N seconds ⇒
flatten" escalation. Expiry-safety is evaluated *after* the feed-health check, so it is not a backstop
either.

Monitoring itself continues (the 1 s timer keeps recomputing metrics and persisting convergence
snapshots), and the feed is correctly retained while exposure exists. But **getting flat with a dead
feed is an operator action**: `POST /api/box/live/cancel-working` and `POST /api/box/live/flatten`,
both deliberately independent of the entry controls.

One honesty defect worth fixing separately: `getStatus().monitoring` is the literal `true`
(`engine.ts:6229`). The real signal is `monitor.getStats().running`, so the frontend's
"monitor loop is not reporting as running" warning in `honestLabels.ts` can never fire.

## 4. Four-leg concurrency cannot be four simultaneous orders

Entry is hedge-first in two waves: the two BUY legs, then the two uncovered SELLs parked until every
BUY has an attributed single-use proof of fill (`entrySubmissionOrder.ts:42-65`,
`orderManager.ts:185-206`). Concurrency overlaps legs *within* a wave and cannot overlap a SELL with
its hedge.

This is why `docs/LATENCY_BENCHMARK.md` §5 reports **identical** distributions for concurrency 2 and
4. Raising `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY` to 4 is worth doing — it removes an artificial
serialisation — but it does not make the box atomic, and inter-placement gaps remain real
rate-limit waits (Zerodha 110 ms default, 100 ms floor, `brokerPacing.ts`).

## 5. Exit timing data is stored but unreachable

Per-leg `send → ack → fill` transitions are persisted in `box_order_intents`, but **no `/api/box`
route exposes it**. What *is* reachable per exit: `exit_attempts[]` on the closed trade
(`types.ts:1438-1479`) carrying `detected_at`, `requested_at`, `submitted_at`, `completed_at`, plus
`broker_orders[]` with state and average price — but no per-order timestamps, and none of the deltas
are derived onto the trade.

Also missing for a post-trade review: no exit-latency scalars, no persisted per-trade
slippage-vs-expected (it goes into a bounded histogram only), no `session` SSE event, and no
partial-exit SSE event.

`exit_charge_reconciliation` begins `pending` — charges read immediately after flat are **local
estimates**, with broker-verified figures landing asynchronously.

## 6. One contradiction to settle before a live window

`EVIDENCE-supervised-live-test-readiness.md` §2 states that exposure reduction "no longer consults the
session account at all". The JSDoc still in `orderManager.ts:1143-1152` lists, as a precondition for
reduction, that "the ACCOUNT is known — reduction must be attributable to the account that owns the
exposure". One of the two is stale.

This matters because it is the same shape as the P0-1 defect that review fixed: an identity condition
disabling the panic button. It should be resolved by reading
`exposureReductionBlockReason()` end to end before anyone relies on flatten during a live window.

---

## What this change adds

The operator blocklist (`box_excluded_underlyings`, migration 012). Enforced at four independent
**synchronous** chokepoints, all ENTRY-only:

| # | Where | Bypassable? |
|---|---|---|
| 1 | `BoxScanner.evaluateAndMaybeEnter`, after `publish` | above the pipeline |
| 2 | `coordinateEntry` prologue, before `claim()` | yes — `BOX_EXECUTION_COORDINATOR_ENABLED=false` |
| 3 | `BoxExecutionSimulator.simulateEntry` / `simulateLeggingEntry` | **no** — every paper mode terminates here |
| 4 | `CentralBoxExecutionGateway.simulateLeggingEntry` live fork | **no** — live never reaches the simulator |

Design points that are deliberate rather than incidental:

- **It never blocks a reduction.** There is no counterpart on any exit, cancel or flatten path. An
  excluded name that carries exposure stays in `mustKeep`, so its legs keep streaming and the monitor
  can still exit it. Excluding a name must not trap a position.
- **An unreadable blocklist refuses entry.** `load_state: "failed"` (and `"never_loaded"`) raise the
  `underlying_exclusions_unreadable` readiness blocker, scope `entry`. A list we cannot read cannot
  confirm any name is permitted — the same discipline `BoxTradingSessionManager` applies to an
  unreadable session record. The read is retried on every universe pass, so it heals without a
  restart.
- **`unpersisted` does not refuse.** With no box persistence no exclusion could ever have been saved,
  so none is being forgotten, and refusing every entry would break paper development for no safety
  gain. Live independently requires healthy persistence.
- **Enforcement is in memory.** The coordinator prologue forbids any `await` between its guards and
  `claim()`; a blocklist queried over the network could not be placed there at all. A mid-session
  database outage therefore cannot lose the blocklist — only a *write* can fail, and a failed write is
  rolled back in memory and reported.

## What this change does not add

Deliberately out of scope, and worth separate PRs because both touch the exit path:

1. **Auto-stop and a session summary** (§2). The summary is a read-only projection over data that
   already exists; the auto-stop would call the existing `stop()` and `disarmTradingSession()` once a
   consumed cycle is durably flat, gated behind a default-off env var.
2. **Exposing exit timing** (§5) — a read path into `box_order_intents` plus derived latency scalars on
   the trade.
