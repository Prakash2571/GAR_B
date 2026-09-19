# Live Box execution operations

This document describes the safety contract and operator workflow for live Box execution. Paper modes remain the default and continue through the paper simulator.

## Safety model

Live broker access is disabled unless both deployment gates are explicitly set:

```dotenv
BOX_EXECUTION_MODE=live
BOX_LIVE_TRADING_ENABLED=true
```

`BOX_EXECUTION_MODE` defaults to `paper_latency`; `BOX_LIVE_TRADING_ENABLED` defaults to `false`. Unknown execution modes fail during configuration instead of falling back to paper. Live startup also requires a ready Box Mongo connection, `KITE_API_KEY`, and a current restored Kite access-token session.

Live additionally requires `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` to name a positive rupee figure. Unset and `0` both mean "no ceiling" for that variable, so `loadBoxConfig()` refuses either while the mode is `live`: it is the only *monetary* containment on a single Box, and the two quantity ceilings are not a substitute because they bound lots, and a Box can satisfy both while committing an arbitrary rupee amount — notional is price × quantity, and neither cap constrains price. Paper is untouched, where the equivalent `BOX_PAPER_MAX_BOX_CAPITAL_RUPEES=0` costs nothing. Paper profiles cannot reach broker mutations even if credentials are present: no live manager/adapter is constructed, and poison-adapter regressions fail on any accidental mutation.

Every process start resets these in-memory runtime controls to `false`:

- `box_entry_enabled`: permits new Box entries.
- `box_live_order_enabled`: permits live exposure-management submissions. Leave this enabled when stopping entries if exits and recovery must continue.
- `box_emergency_flatten`: additionally arms the explicit flatten operation.

Scanner RUN/STOP is separate from these controls. STOP prevents discovery of new opportunities but does not stop monitoring or risk-reducing exits. A circuit-breaker trip disables entry but deliberately preserves the ability to cancel or reduce owned exposure.

### Entry guards versus reduction permissions

The controls above, the scanner decision, the reservation lease and the circuit breaker are **entry-only**. They may all refuse to create new exposure. None of them may prevent the reduction of exposure that is already owned and safely attributed.

Concretely, these may block a new ENTRY: scanner STOP, entry disarmed, reservation/ownership loss, an open circuit breaker, and order-manager entry admission (health, reconciliation completeness, open-box and residual limits, crash-recovery quarantine).

These may **not** be blocked by any of the above: EXIT, protective cancellation, partial risk reduction, emergency residual flattening, and reconciliation-authorized reduction. The enforcement point is mechanical rather than a convention: the composed entry guard is only ever consulted when `purpose === "ENTRY"`, and a reduction never carries one. Passing one on a non-entry purpose is ignored by construction.

### The composed entry guard, and the five checkpoints

The coordinator composes an ownership-aware `stillWanted` predicate — the caller's own condition folded together with "do we still hold the reservation lease" — and hands it to the gateway. Live entry re-evaluates that composed guard at **five** points, because an unbounded amount of wall-clock time can pass between a decision and a broker mutation:

1. before the four broker requests are constructed;
2. immediately before handing them to the order manager;
3. at order-manager dequeue, once a concurrency slot is held;
4. after the durable `CREATED -> SUBMITTING` writes complete;
5. inside the adapter callback, as the last instruction before the HTTP POST.

The final pre-POST decision folds in `stillWanted` (ownership/lease and scanner), entry armed, live-order authorization, a closed circuit breaker, full order-manager entry admission, the current feed-generation/depth check, and any hedge-leg failure for this attempt.

A refusal at any checkpoint makes **no broker mutation**. The durable intent is terminalized through the existing structured local-no-POST provenance (`origin: local_pre_submit_refusal`, `no_broker_post: true`, plus the refusing `stage`) under an expected-state CAS, so a concurrent process's real broker result can never be overwritten. Such a refusal is deliberately **not** counted as a broker rejection and **not** treated as ambiguous — it becomes ambiguous only if the CAS loses or the POST status cannot be proven. A predicate that throws counts as a refusal, never as permission.

### Hedge-first entry submission order

The four entry orders are transmitted **BUY hedges first**, then uncovered SELLs:

| Direction | Transport order |
| --- | --- |
| `LONG_BOX` | `k1_ce` BUY, `k2_pe` BUY, `k2_ce` SELL, `k1_pe` SELL |
| `SHORT_BOX` | `k2_ce` BUY, `k1_pe` BUY, `k1_ce` SELL, `k2_pe` SELL |

Previously the canonical role array `[k1_ce, k2_ce, k2_pe, k1_pe]` doubled as the transport order. For a `SHORT_BOX` that made the **first** broker POST a naked SELL, with its hedge second — so a failure between the two POSTs left uncovered short option exposure.

Ordering the requests is not sufficient on its own. With `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY=4` all four legs are dequeued together and each performs its own durable writes, so whichever finished first would reach the broker first. An uncovered SELL therefore also waits on a barrier until every BUY hedge of the same attempt has **completed its POST round trip**. Hedge legs do not wait on each other, so the two BUYs still overlap and entry does not degrade into four serial round trips.

Two consequences follow. A hedge that is rejected, or whose submission is ambiguous, stops the dependent uncovered SELLs *before* they POST — an unproven hedge is treated as a failed hedge, because guessing in the permissive direction would send a naked short against a hedge that may not exist. And role identities, sides, quantities and the four-leg economics are unchanged: only the transmission sequence differs. Output and accounting remain keyed by role, and the execution record's leg array stays in canonical role order.

This reduces, but does not remove, legging risk. See "Remaining broker leg risk" below.

## Source of truth and persistence

Broker orders and broker positions are authoritative for live fills and exposure. Mongo stores the durable strategy/accounting projection and the append-only order-intent journal. A deterministic identity such as `BOX:<trade-id>:ENTRY:k1_ce:attempt-1` is persisted before submission. `CREATED -> SUBMITTING` is an expected-state compare-and-set: only the manager whose durable transition was applied may POST, while losers adopt or reconcile the existing intent. Ambiguous or working outcomes retain identity and are never blindly resubmitted.

Residual reduction uses the same rule explicitly: **same logical submission means the same identity; a new flatten attempt for still-outstanding quantity means a new identity**. `ResidualLegExposure.flatten_attempt` advances only after a terminal broker result or an applied local `REJECTED` transition that proves no broker mutation occurred. Partial retries submit the exact durable remainder.

Guarded order persistence reports the durable pre-write and post-write cumulative quantities. Position attribution uses that durable delta, never a caller's potentially stale snapshot. Broker cumulative quantity remains fill authority; an ACK or state label alone never creates exposure.

Redis is a cache, **not** a write-ahead log. There is no filesystem WAL or broker-only recovery mode. During a total Mongo outage the service fails closed and cannot create a new durable exit or residual intent. If live boot fails because Mongo is unavailable, restore Mongo and restart the process before operating live Box execution. A mid-session persistence failure blocks new risk, trips the circuit breaker, and moves affected projections to recovery where applicable.

## Startup and reconciliation

Live boot performs these steps before discovery can be enabled:

1. Require Mongo and a current Kite session.
2. Restore open Box projections and unresolved residual attempts.
3. Seed daily P&L, rejection, and failure counters from durable state.
4. Reconcile the complete nonterminal intent/ownership journal with broker orders and positions.
5. Start the position monitor and low-frequency reconciliation loop.

Reconciliation runs immediately and then every `BOX_LIVE_RECONCILE_INTERVAL_MS` (default 60 seconds). It adopts orders only through durable client/broker identity or a unique validated Box tag. Missing, duplicate, ambiguous, orphaned-looking, or position-mismatched ownership enters reconciliation/recovery handling and blocks entry.

The system never treats arbitrary account positions as Box exposure. Cancel and flatten operations are limited to safely attributed Box orders, trade projections, and crash-only exposure reconstructed from the durable Box intent journal.

## Order policy and deadlines

All live entry, exit, and emergency-reduction orders are regular NRML DAY **LIMIT** orders. Market orders are not supported. Limits are bounded marketable prices derived from current executable depth and configured chase ticks. The full requested quantity must be executable within the bounded limit after the configured queue haircut.

Depth and fill have different authority. Authoritative depth permits construction and origination of a bounded LIMIT order; broker cumulative quantity alone proves a fill. The gateway checks executable depth at admission and stamps token, feed generation, quote version/time, and check time. The manager revalidates after durable intent classification and at dequeue. The adapter revalidates after pacing immediately before the external POST. A feed-generation change always refuses a new mutation; a newer book in the same generation is acceptable only if the immutable quantity still executes inside the immutable LIMIT. Existing non-`CREATED` intents are adopted/reconciled before feed validation so recovery is not blocked by a new-submission gate.

### Pacing: real broker rate limits, never simulated latency

**NO ARTIFICIAL SIMULATION LATENCY IS APPLIED TO LIVE EXECUTION. REAL SAFETY AND
RATE-LIMIT LATENCY REMAINS.** These are different things that look identical in a latency
chart, so the distinction is stated here rather than left implicit:

| | Artificial PAPER latency | Real LIVE transport latency |
|---|---|---|
| What | `BOX_SIMULATED_DECISION_MS`, `BOX_SIMULATED_LATENCY_MS`, recorded latency samples and distributions, paper POST→ACK and ACK→terminal models, the simulated cancel race, paper persistence simulation, the paper scheduler | Broker rate-limit pacing, durable Mongo writes, reservation acquisition, feed validation, the broker HTTP request, the broker ACK, working-order observation, cancellation confirmation, reconciliation, recovery |
| Purpose | A *model*, so a simulated fill is not instantaneous | A *constraint*, imposed by the broker, the network and our own durability requirements |
| On the live path? | **NEVER** | Always |

The live path is exactly: candidate qualifies → safety/admission validation → durable
intent transition → scheduler/rate-limit admission → **immediately call the broker** →
wait only for real broker/network responses → process real broker state. No `sleep()` was
added to make live resemble paper.

This is enforced, not merely asserted. `tests/box/noArtificialLiveLatency.test.mjs`:

1. builds the live gateway with every paper timing construct replaced by a function that
   **throws**, and runs entry, partial entry with unwind, economics abort and residual
   flattening without touching one;
2. audits the source so no live-path module even *imports* a paper timing module or reads
   `BOX_SIMULATED_*` (the simulator has 8 such references; the six live-path modules have 0);
3. asserts the API reports `artificial_latency_applied_to_live: false`.

The suite is mutation-tested: injecting a single `await simulator.simulatedLatency()` into
the live entry path fails 5 of its tests.

Two pacing buckets, because a broker rate limit and a poll cadence we chose ourselves are
not the same constraint:

| Setting | Default | Governs |
|---|---|---|
| `BOX_LIVE_BROKER_MIN_INTERVAL_MS` | 250 ms | GENERAL: order-status polls, order/position lists, funds, margins, health. Also the poll cadence while a working order resolves. **Unchanged.** |
| `BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS` | 0 → per-broker | ORDER MUTATION: place / modify / cancel. `0` derives from the broker's published limit; a positive override is **clamped up** to the broker floor. |

Per-broker floors (`src/box/brokerPacing.ts`): Zerodha 110 ms default / **100 ms floor**
(Kite Connect permits 10 order requests/second; the 10% headroom exists because the
limiter runs on the broker's clock and a rejected request still consumes the daily
order-request budget). Dhan 120 ms default / **120 ms floor**, matching the
`DHAN_MIN_INTERVAL_MS` pacing its own HTTP layer already imposes, so a smaller Box-level
value would be absorbed below and misreported here. An unrecognised broker falls back to
the strictest known profile.

`BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS` **cannot be used to disable pacing.** `0`,
negative, `NaN` and any below-floor value all resolve to at least the broker floor.
Cancellation is deliberately in the faster bucket: a protective cancel is the operation
least worth slowing down.

Splitting one bucket into two would otherwise raise the achievable *total* request rate,
so a third absolute-floor watermark bounds every transport call at the order interval —
total transport stays at 1/order-interval (10/s for Zerodha, its published ceiling).

The effective values in force are reported by `GET /api/box/execution-control` under
`execution.effective_broker_order_min_interval_ms`, read **from the adapter** rather than
re-derived from config, and tagged `pacing_source_of_truth`.

Distinct deadlines apply:

- HTTP request: `BOX_LIVE_HTTP_TIMEOUT_MS=5000`
- broker acknowledgement: `BOX_LIVE_ACK_TIMEOUT_MS=3000`
- working order: `BOX_LIVE_WORKING_TIMEOUT_MS=30000`
- partial-fill continuation: `BOX_LIVE_PARTIAL_TIMEOUT_MS=10000`
- cancellation/terminal confirmation: `BOX_LIVE_CANCEL_TIMEOUT_MS=5000`

A working or partial timeout triggers protective cancellation followed by terminal cumulative-quantity confirmation. If terminal quantity cannot be established, the order becomes `RECONCILIATION_REQUIRED`; no blind retry is allowed. The configured modification/chase bounds are safety ceilings; the current manager does not actively modify working orders.

The central priority is emergency residual reduction, protective cancellation, exit, then entry. `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS` defaults to 1, so multi-role work is queued and serialized rather than rejected.

### The four-leg entry burst

A concurrency slot is held for an order's **entire lifecycle** — submit through terminal
polling — so at `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS=1` leg 2 is not even persisted, let
alone transmitted, until leg 1 has fully resolved. First-to-last submit is therefore
bounded below by three complete order lifecycles, and between leg 1 filling and leg 4
reaching the broker the position is **UNHEDGED**. Shrinking that window is the most
valuable latency improvement available, and unlike removing a gate it costs nothing.

`BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY` (1–4, default 1) bounds how many ENTRY role
submissions of ONE Box pipeline may be in transport at once. It is not a global
concurrency increase:

- `ENTRY` purpose only, and all slots must belong to the same `attempt_id`, so two
  overlapping candidate Boxes can never use it to bypass contract reservations. The
  one-pipeline-at-a-time check covers **base** slots too, closing the window where a
  second candidate could take a freed base slot while the first still held burst slots.
- Burst slots are **invisible** to emergency, cancel and exit admission, which count base
  occupancy only. An entry burst therefore cannot delay protective work, and when the base
  slot frees, the priority queue hands it to a queued `EMERGENCY_RESIDUAL` /
  `PROTECTIVE_CANCEL` / `EXIT` ahead of any remaining `ENTRY`. This is strictly better
  than the pre-burst behaviour, where all four entry legs contended for the same single
  slot protective work needed.
- `pump()` peeks the priority-sorted head and stops when it cannot be admitted, rather
  than looking further down the queue — admitting a lower-priority `ENTRY` ahead of a
  blocked `EMERGENCY_RESIDUAL` would invert `BOX_ORDER_PRIORITY`.
- Rate limiting is unaffected: lifecycle concurrency and wire pacing are different
  mechanisms, and the adapter pacer still spaces the four placements.

`1` reproduces the pre-burst behaviour exactly. `4` is the recommended production value.

### Entry telemetry

Already-recorded raw stages (`executionTiming.ts`) cover `detected`, `qualified`,
`scheduler_enqueued`, `scheduler_dequeued`, `intent_persisted`, `transport_started`,
`http_request_started`, `http_response`, `broker_order_id`, `acknowledged`, `first_fill`,
`last_fill`, `full_fill`, `cancel_requested`, `cancel_acknowledged`, `terminal`,
`reconciled`. Box-level spans (`brokerTimingStore.ts`) cover
`detection_to_first_submit_ms`, `detection_to_last_submit_ms`, `detection_to_first_fill_ms`,
`detection_to_all_four_filled_ms`, `first_fill_to_last_fill_ms`,
`unhedged_exposure_duration_ms` and `unwind_duration_ms`. Exchange timestamps are never
fabricated when the broker does not supply them: `monoSpan()` returns `null` rather than a
guess.

## Exact quantity and position state

The irreversible invariant is:

> Once the broker/execution engine owns a fill, that filled quantity is irreversible state.

The entry-size invariant is separately explicit: the candidate lot must be a positive safe integer, it must equal all four instruments' lot sizes, and every normal opened role must equal **exactly one lot**. Live risk ceilings are not a substitute for this invariant, and general multi-lot execution is not implemented. Legitimate remaining role quantities may be any safe integer from zero through one lot; a `35/75` partial remainder is valid and is never rounded back to a lot.

Every trade persists exact outstanding quantity as `remaining_qty_by_role` for `k1_ce`, `k2_ce`, `k2_pe`, and `k1_pe`. An exit submits only the one to four roles whose remaining quantity is nonzero, and each submitted quantity equals that role's exact remainder. Broker-confirmed cumulative fill quantity is applied only to its role.

Position states are:

- `BOX`: all four roles have the same positive remaining quantity.
- `PARTIALLY_EXITED`: known terminal fills leave unequal or zero per-role remainders.
- `RECOVERY`: quantity is uncertain, an invariant was violated, persistence of a confirmed result failed, or reconciliation found an ownership mismatch.
- `FLAT`: all four role quantities are zero.

Over-close is never clamped to zero. Broker-confirmed safe-integer overfill is persisted as truth, records the invariant violation, enters `RECOVERY`, and blocks new entry. A malformed restored quantity also enters `RECOVERY`; compatibility fallback must not conceal malformed durable input. After explicit reconciliation, emergency reduction may submit the exact confirmed overfill quantity. For a known partial close, retry uses only the exact remainder—for example, a 75-unit role with 40 confirmed closed retries 35, never 75. Fractional, negative, non-finite, or otherwise invalid exit quantities fail before request construction. Manual and automatic close share the same execution engine and cumulative accounting path. `exit_attempts[]` is append-only; heavy audit data is omitted from bulk list/history responses.

Normal automatic flattening is intentionally paused for an uncertain `RECOVERY` projection until reconciliation establishes broker truth. The explicit attributed flatten workflow may then resume exact reduction.

## Feed health and reconnect warm-up

Raw feed liveness and executable-book readiness are deliberately separate. Any valid tick may refresh raw connection liveness for analytics, but an option becomes execution-ready only from a packet that actually carried usable depth. Zerodha full packets set depth provenance; Dhan derives provenance from the current packet rather than a retained merged ladder. Non-finite or fractional depth fails closed, while a valid one-sided book may still authorize the corresponding exposure-reducing side.

Every feed-generation reset invalidates stored executable books and readiness. After reconnect the manager waits `BOX_LIVE_FEED_RECONNECT_WARMUP_MS` (default 5 seconds), and every requested leg must receive authoritative usable depth in the new generation. An LTP-only tick cannot warm a leg. Queued requests carry an ephemeral checked-feed stamp and are revalidated at dequeue and immediately before POST, so a request cannot cross a reconnect generation using a stale book.

## Reservation authority and concurrency

Exact-contract reservations serialize boxes that share an option instrument, then force the waiter to re-evaluate. There is no global execution mutex or whole-underlying lock: unrelated contracts retain the configured execution concurrency. When the durable reservation tier is enabled and unavailable, live **entry** fails closed. Paper may continue only in explicitly reported `local_only` mode. Exposure-reducing exits use the local tier and residual flattening is not reservation-gated, so an authority outage does not prevent reducing owned exposure.

## Technical failure taxonomy

Internal execution failures use a fixed, bounded metric taxonomy: `reservation_error`, `reservation_authority_unavailable`, `execution_gateway_error`, `execution_simulator_error`, `execution_invariant_error`, `trade_persistence_error`, `position_book_error`, `charge_calculation_error`, `broker_state_error`, and `unknown_internal_error`. Exception text is bounded diagnostic context, never an unbounded label. Broker rejection, broker uncertainty, and proven local pre-submit refusal remain distinct outcomes.

## Runtime limits and circuit breaker

Conservative defaults are:

- `BOX_LIVE_MAX_OPEN_BOXES=1`
- `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS=1`
- `BOX_LIVE_MAX_RESIDUAL_LEGS=1`
- `BOX_LIVE_MAX_OPEN_LEG_QUANTITY=100`
- `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=400`
- `BOX_LIVE_DAILY_LOSS_LIMIT=5000` (`0` disables)
- `BOX_LIVE_REJECT_LIMIT=3`
- `BOX_LIVE_CONSECUTIVE_FAILURE_LIMIT=3`

The circuit breaker trips on invariant/quantity ambiguity, reconciliation failure, persistence loss after confirmed fills, attribution mismatch, or a configured risk limit. It is sticky: fixing the cause or toggling entry does not clear it, and day rollover does not re-arm it. Reconcile and inspect the incident, cancel/flatten only safely attributed exposure as needed, then restart the process to re-arm entry.

## Health and blockers

`GET /api/box/status` includes separate health for persistence/database, daily-risk seeding, broker authentication, broker orders API, broker positions API, reconciliation, market data/feed, and circuit state. It also reports unknown orders, recovery activity, orphan orders, open boxes, residual legs, queued/in-flight work, risk counters, and the live manager controls.

New entry requires all of the following: closed circuit, both entry and live-order controls enabled, healthy persistence and daily-risk seed, completed reconciliation, healthy broker auth/orders/positions APIs, no unknown orders, no active recovery, healthy warmed feed, and all exposure/concurrency/risk limits passing.

Treat `RECOVERY`, unknown orders, unhealthy persistence, failed/incomplete reconciliation, or an open circuit as an incident. Do not attempt to bypass a blocker by switching execution modes or resubmitting an ambiguous order.

## Full-admin operations

These POST routes require a full-admin token (`x-admin-token`):

- `/api/box/controls/box_entry_enabled`
- `/api/box/controls/box_live_order_enabled`
- `/api/box/controls/box_emergency_flatten`
- `/api/box/live/reconcile`
- `/api/box/live/cancel-working`
- `/api/box/live/flatten`

Recommended incident sequence:

1. Set `box_entry_enabled=false` while leaving `box_live_order_enabled=true` if risk reduction must continue.
2. Run `/api/box/live/reconcile` and inspect status/ownership blockers.
3. Use `/api/box/live/cancel-working` for durable nonterminal Box orders if required.
4. Set `box_emergency_flatten=true`, then call `/api/box/live/flatten` only after attribution is safe.
5. Confirm broker positions and Box status are flat, remediate the root cause, and restart if the sticky circuit breaker must be cleared.

Emergency flatten requires the explicit runtime arm plus completed reconciliation or the narrower safe-attributed-reduction proof. It does not flatten unrelated account positions.


---

## Remaining broker leg risk

**Four-leg Box entry is not atomic, and cannot be made atomic on these brokers.** Zerodha and Dhan expose four independent orders with no basket/atomic primitive and no fencing token, so some legging risk is irreducible. The guards above narrow the window; they do not close it.

### No database can make a four-leg broker entry atomic

This must not be misunderstood, because it is the single most dangerous misreading of the safety model:

- **Zerodha and Dhan provide no transaction spanning four independent orders.** There is no API in which the four legs commit or abort together. Each order is accepted, rejected or left working on its own.
- **A database transaction is not a broker transaction.** MongoDB CAS, MongoDB multi-document transactions, PostgreSQL, Redis, fencing tokens and idempotency keys all constrain *our own records*. None of them constrains the exchange.
- **A database rollback cannot undo an order already accepted or filled at the broker.** Rolling back our write only makes our books disagree with reality — which is strictly worse than recording the truth. This is why the durable intent is written *before* submission and why an ambiguous submission is quarantined rather than rolled back.
- **Migrating the database would change none of this.** A store swap addresses no part of broker-side non-atomicity, and would add migration risk for no safety gain.

What the durable CAS layer *does* buy is exactly this, and no more: exactly one process may own a deterministic order identity, our record of a fill can never regress or double-count, and a refusal before POST is provably a refusal. Those are prerequisites for safe recovery. They are not atomicity.

### The concrete residual exposure

- A **hedge BUY may be accepted while a later SELL is rejected**, leaving a real, one-sided position that exists at the broker regardless of what our database says.
- **Hedge-first ordering reduces this risk but does not eliminate it.** It guarantees the *unbounded-risk* leg is never the one left alone while its hedge is in flight; it cannot guarantee four fills.
- A leg can fill in the interval between the last guard evaluation and the broker's response, so a refusal never retroactively cancels an in-flight POST.
- Latency or an outage between POST and response yields an ambiguous leg whose true state is unknown until reconciliation proves it.

### Therefore the system depends on recovery, not prevention

Because entry cannot be made all-or-none, correctness rests on the mechanisms *after* submission:

1. **Protective cancellation**, with terminal confirmation — a cancel acknowledgement is not proof of cancellation.
2. **Reconciliation** against authoritative broker REST order and position data.
3. **Residual detection**, sized from broker cumulative filled quantity.
4. **Emergency flattening** of attributed residual exposure.

**Automatic flattening can itself fail** — no executable book, a rejected reduction, an authentication lapse, a broker outage, or exhausted retries. Unresolved or unprovable exposure must therefore raise a **high-priority operator alert** and must not be allowed to decay into a silent log line. Treat any of the following as requiring human attention: an intent in `RECONCILIATION_REQUIRED` or `UNKNOWN`, a quarantined attempt, a residual that has survived its flatten passes, a tripped circuit breaker with open exposure, and a shutdown that reported an unresolved drain.

None of this makes live Box execution "safe by construction". It makes failures *detectable and attributable*, which is the strongest property available on retail broker APIs.

What is genuinely guaranteed:

- no ENTRY leg POSTs after ownership loss, disarm, breaker trip or a withdrawn scanner decision is observed at any of the five checkpoints;
- an uncovered SELL is never the first order transmitted, and never POSTs before every BUY hedge of its attempt has completed a POST round trip;
- a rejected or ambiguous hedge stops its dependent uncovered SELLs before they POST;
- a local refusal is a proven zero-POST outcome with durable provenance, never a broker rejection and never silently ambiguous.

What remains genuinely unguaranteed:

- a hedge BUY can be accepted and then a subsequent SELL rejected, leaving a real hedged-side-only position that must be unwound at cost through the existing partial-entry recovery path;
- a leg can fill in the interval between the last guard evaluation and the broker's response, so "refused" never retroactively cancels an in-flight POST;
- broker-side latency or an outage between POST and response yields an ambiguous leg, which is quarantined for reconciliation rather than guessed;
- once all four legs are proven filled, a late local signal must **not** abort the established Box; it is unwound only on its own economics or exit rules.

Operators should read the hedge-first ordering as "the riskier half is never exposed first", not as "the Box either exists or it does not".

## Paper live-parity profile (`BOX_PAPER_EXECUTION_PROFILE=live_parity`)

Default is `standard` — today's paper behaviour, byte-for-byte. `live_parity` is an
opt-in layer **on top of `paper_legging`** that makes paper a closer shadow of the live
path. It changes nothing about the box maths, thresholds, fees, direction logic, exit
logic, live behaviour, API shapes or schemas.

### What each paper mode is

- **PAPER_LATENCY** — simplified: one simulated decision + send delay, then fill the four
  legs from the first book at/after arrival. Atomic-ish.
- **PAPER_LEGGING** — four genuinely independent bounded-LIMIT orders, each with its own
  arrival, resting, partial fills and timeout; emergency unwind on a partial; abort after
  a 4/4 fill whose executed economics no longer qualify.
- **PAPER LIVE PARITY** — `paper_legging` plus:
  - **shared-liquidity reservation** (`liquidityLedger.ts`) — concurrent attempts cannot
    double-consume one observed level; a new quote version is fresh liquidity;
  - **deterministic latency source** (`latencySource.ts`) — `constant | recorded_samples`,
    consumed in a fixed seeded order, ready for real measured samples;
  - **live-equivalent concurrency cap** — `BOX_PAPER_MAX_CONCURRENT_EXECUTIONS`, defaulting
    to the live cap (`BOX_LIVE_MAX_CONCURRENT_EXECUTIONS`).

### How it stays safe

- **Default off.** The profile is `standard` unless explicitly set. Every live-parity
  behaviour is gated on `paperExecutionProfile === "live_parity"`; the leg executor gets
  the ledger/latency deps only then, so the `standard` fill and submit paths are
  unchanged (proven by the existing execution suites passing untouched).
- **No new broker contact.** Paper still routes entirely through the simulator; the order
  manager and broker adapter are only constructed in `live` mode (`tests/box/
  paperNeverReachesBroker.test.mjs` pins this with a poison manager).
- **Same LIMIT pricing.** Reuses `orderPricing.buildOrderPricing` / `walkDepth`; the
  reservation only *subtracts already-reserved quantity* from a level's effective depth —
  it never widens a limit or turns a LIMIT into a market order.

### Scheduling parity — legs go through the same scheduler as live

Under `live_parity`, the four legs no longer all arrive at `submit + one latency`. Each
leg's simulated **exchange arrival** is computed by `planPaperSchedule`
(`src/box/paperScheduler.ts`) using the *same* policy the live `BoxOrderManager` enforces,
defined once in `src/box/executionSchedulingPolicy.ts` and imported by both:

- **Concurrency cap.** A slot is held for the whole lifecycle (submit → terminal), so
  `BOX_PAPER_MAX_CONCURRENT_EXECUTIONS = 1` (the default, = the live cap) serialises whole
  leg lifecycles, exactly as live cap=1 does — not just the POSTs.
- **Transport pacing.** Successive POSTs are spaced by `BOX_LIVE_BROKER_MIN_INTERVAL_MS`
  on a single shared transport channel, matching each adapter's `call()` throttle.
- **Priority.** `EMERGENCY_RESIDUAL > PROTECTIVE_CANCEL > EXIT > ENTRY`. A higher-priority
  operation claims the next free slot ahead of a queued lower one; an in-flight operation
  is never pre-empted (neither live nor paper interrupts a call already at the broker).
  Emergency unwinds run through the same planner (emergency-residual band).

The broker-side spans that feed the scheduler — POST→ACK and ACK→terminal — come from a
structured, calibration-fed latency source (below), not one opaque constant. Fills still
come exclusively from real observed books after the scheduled arrival; the scheduler only
decides *when* the order is live at the exchange, never at what price it fills.


### ACK is not fill

`src/box/orderLifecycle.ts` defines the observable stage vocabulary — a strict superset of the
durable states, adding the distinctions the durable enum collapses:

```
CREATED → QUEUED → POSTING → BROKER_ACCEPTED → ACKNOWLEDGED → WORKING
        → PARTIALLY_FILLED → FILLED
        → CANCEL_REQUESTED → CANCEL_PENDING → CANCELLED
        → REJECTED / EXPIRED / UNKNOWN / RECONCILIATION_REQUIRED
```

The durable vocabulary (`BoxOrderIntentState`) is **unchanged**, because it is enforced as a
Mongo query guard and is the mechanism that makes restart safety work; widening it would need a
migration for zero safety benefit. `durableStateForStage()` is the total mapping, and the lossy
choices are documented at the mapping itself (`QUEUED → CREATED`, `BROKER_ACCEPTED →
ACKNOWLEDGED`, `CANCEL_PENDING → CANCEL_REQUESTED`, `EXPIRED → CANCELLED`).

Three rules are expressed in code rather than in prose someone can skip:

- `stageProvesExecution()` returns **false for every stage**. Not an HTTP 200, not a broker ACK,
  not even `FILLED` — which is a *derived* summary of the fact that cumulative quantity reached
  the requested quantity. Quantity is the evidence; the stage is the description.
- `stageAcceptsFurtherFills()` is **true** for `CANCEL_REQUESTED`, `CANCEL_PENDING`, `UNKNOWN`
  and `RECONCILIATION_REQUIRED`. A cancel request is a request. Not knowing is not the same as
  knowing nothing happened.
- `CumulativeFillLedger` is the only sanctioned way to apply a filled quantity. It guarantees
  duplicate broker events contribute nothing, cumulative quantity never decreases whatever order
  events arrive in, and an overfill is applied as broker truth but **flagged** (and trips the
  live circuit breaker) rather than silently clamped.

### The cancel-vs-fill race

Real trading has a window: the order is working, a cancel is requested, the exchange may still
match some or all of the resting quantity, and the cancel confirmation arrives afterwards.

The live adapters already respected this (`confirmTerminalAfterCancel` re-reads until genuinely
terminal, and the durable table permits `CANCEL_REQUESTED → COMPLETE`). **Paper did not model it
at all** — `abandon()` was instantaneous, so a paper order could never fill after a cancel was
requested. That flattered paper in the most dangerous direction, because a lost live race leaves
real, irreversible exposure to unwind while paper reported a clean cancellation.

Under `live_parity` the leg executor models the two-phase cancel only for an order that has actually arrived: the order enters `CANCEL_REQUESTED` and **remains eligible to fill from observed books** until a confirmation deadline drawn from measured cancel latency. A leg still in `pre_submission` or `in_transport`—including a sequential leg never submitted—cannot fill merely because an abort requested cancellation. Therefore every positive fill satisfies `first_fill_at >= arrival_at`, while the legitimate post-arrival cancel race remains modelled. The brief's arithmetic is pinned as a test and a golden fixture:

```
75 requested
40 filled when the cancel was requested
12 more fill while the cancellation is in flight
remainder cancelled
→ filled = 52, cancelled = 23        NEVER filled = 40
```

An order that *completes* during the window is recorded `FILLED`, because that is a real
position. Without a cancel-race model (i.e. outside `live_parity`) the path is byte-for-byte what
it was, and a test asserts exactly that.

### Latency calibration — measured, per broker, never invented

The chain is now closed end to end:

```
live order  →  ExecutionTimingRecorder  →  ExecutionCalibrationStore  →  paper live_parity
                (per-order stage marks)      (dimensioned distributions)   (draws real samples)
```

**`src/box/executionClock.ts`** separates the two clocks. Durations come exclusively from
`performance.now()`; the wall clock is used only for audit, freshness and time-of-day bucketing.
They are never mixed in one subtraction, because a wall clock is adjusted by NTP and a latency
distribution built from it contains fabricated outliers. `monoSpan()` returns `null` for an
inverted pair rather than a negative or absolute value.

**`src/box/executionTiming.ts`** collects one trace per order, shared by the layers that witness
each event — the `OrderManager` marks the scheduler stages and the terminal publish, the Kite and
Dhan adapters mark transport start, HTTP request/response (on the failure path too, so a
timeout's duration is measurable), broker order id, ACK, each cumulative fill, and the cancel
request/acknowledgement. Every method is individually `try`/`catch`ed and performs no I/O and no
`await`: this code runs inside protective-cancel and unwind paths, so it must be structurally
incapable of throwing or blocking. Lost measurement is **counted and reported**, never hidden —
silent sample loss looks exactly like a broker that got faster.

**`src/box/executionCalibration.ts`** files samples under five dimensions, none of which is ever
pooled away: broker, operation kind, order profile, time-of-day bucket, and stage. It exposes
p50/p75/p90/p95/p99, sample counts and freshness, and resolves a request through an explicit
fallback ladder:

1. the exact time bucket — used only with `BOX_PAPER_CALIBRATION_BUCKET_MIN_SAMPLES` fresh
   samples, so a thin bucket never overfits;
2. buckets pooled for that broker + kind + profile;
3. kinds pooled for that broker + profile;
4. nothing → `measured: false`, and the caller uses its documented constant.

Steps 1–3 **never cross a broker boundary and never cross the marketable/passive boundary**.
Those are hard walls: Zerodha and Dhan are different networks, and a passive order's behaviour is
dominated by queue position we cannot see, so pooling either way produces a number describing no
real population.

Cancel spans are filed under `kind = CANCEL` even though a protective cancel shares the client
order id of the order it is pulling — otherwise cancel-confirmation latency would land in the
`ENTRY` bucket and contaminate the distribution that sizes paper's race window.

A sample measured **during a significant event-loop stall is excluded from calibration**. It is
evidence about our own process, not about the broker, and feeding it in would teach paper to
simulate broker slowness that never happened.

**`src/box/calibratedLatencySource.ts`** consumes the ACTUAL measured samples in a fixed
rotation, so paper inherits the real right-hand tail — the part a percentile summary flattens and
a constant erases. There is no randomness: the same samples in the same order produce the same
schedule, every run.

### Calibration honesty contract

Everything above is worthless if it can quietly present a constant as a measurement, so:

- `ResolvedCalibration.measured` and `CalibratedLatencyStatus.measured` are **false** whenever
  the numbers are a configured fallback. When false, percentiles are `null` and confidence is
  forced to `LOW`.
- `CalibratedLatencyStatus.measured` is the STRICT reading: true only when *both* broker-side
  stages are measured. Confidence is the **weaker** of the two stages, never the better one.
- The fallback constant is named in the status note whenever it is in use.
- A `STALE` set falls back rather than being reused "because it is better than nothing".
  Yesterday's tail is not today's.
- `classifyConfidence()` returns `LOW` for anything unmeasured or stale however large the sample
  count, caps a fallback at `MEDIUM`, and reserves `HIGH` for a large, fresh, non-fallback set.

`formatCalibrationBlock()` renders the header every report must carry, so a confidence claim is
never separated from its evidence:

```
CALIBRATION:
broker: zerodha
region: ap-south-1
sample count: 417
freshness: 26 min
profile: MARKETABLE_LIMIT
operation: ENTRY
time bucket: NORMAL
status: CALIBRATED
confidence: HIGH
measured: yes
```

### Marketable vs passive

`PaperOrderType` is now `MARKETABLE_LIMIT | PASSIVE_LIMIT`, and
`orderPricing.classifyOrderProfile()` decides which from an **observed book**, also reporting the
signed distance from the touch in ticks (the most useful covariate for queue calibration). The Box
strategy submits bounded marketable limits, so `MARKETABLE_LIMIT` is the normal answer — but the
classification is made against a real book, and `assumed: true` records the case where no opposite
touch was observable.

The classification is **performed in the fill path against the observed book**, not assumed at the
edges. `legExecutor` calls `classifyOrderProfile()` with the same depth snapshot it is about to walk
and stores the result on `leg.pricing.order_type`, together with `limit_offset_ticks`. Everything
downstream — outcome rates, queue observations, latency selection — reads that recorded
classification, so a leg that was genuinely behind the touch is filed as `PASSIVE_LIMIT` even though
the strategy intended a marketable limit. This replaced a hardcoded `"MARKETABLE_LIMIT"` constant,
which had made the profile split cosmetic: every sample landed in one bucket regardless of the book.

Statistics are keyed by profile everywhere. They are never pooled, because a blended fill rate
flatters passive orders, slanders marketable ones, and describes neither.

### Queue-model calibration — advisory, and explicit about what it is not

We cannot know NSE queue position. That is stated first and repeatedly in
`src/box/queueCalibration.ts`, and nothing there attempts to reconstruct it.

What it measures is the **realisation ratio**: of the executable depth we could actually see within
our limit, what fraction did we get? That is directly observable, and it is exactly what
the 30 % haircut is approximating.

The estimator is **fed per leg**, not left to be populated later. `legExecutor` captures
`executable_within_limit_at_arrival` and `displayed_qty_at_arrival` from the book the leg actually
arrived on — recorded *before* the `filled_qty <= 0` early return, so a leg that saw depth and got
nothing still counts as evidence rather than vanishing from the denominator — and
`BoxEngine.observeAttempt()` records one observation per leg, keyed by the profile that leg was
classified as. A leg with no observable executable depth is **skipped, not recorded as a zero**:
a zero there is absence of evidence, and treating it as a realisation of 0 % would drag the
recommended haircut upward on no information.

From these observations the estimator recommends a conservative haircut,
derived from the **p25** rather than the median — the haircut exists to stop paper over-filling,
so it should encode a bad-but-plausible realisation, and a median-derived haircut would let paper
over-fill half the time.

```
observed marketable-limit realisation ratio p50 = 1.0, p25 = 0.87
recommended conservative haircut = 13 %
configured haircut = 30 %
confidence = MEDIUM
```

It is **advisory only**. Nothing applies it automatically, for two deliberate reasons: a handful
of one-lot observations cannot justify moving a parameter that governs every simulated fill, and
a haircut change alters the meaning of every historical paper result, so it should be a reviewed
decision rather than an emergent one. A human applies it via
`BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT`.

### Market-impact honesty

One lot in a liquid option probably has negligible impact, but "probably negligible" is not
"zero". Requested size relative to visible executable depth is **exposed**
(`requested_qty / visible_qty_within_limit`, with the rate at which size exceeded visible depth),
and cases where simulated size is large against the book are flagged. No impact price model is
invented, because no observed data here supports a coefficient.

### Execution environment: event-loop and process pressure

`src/box/executionEnvironment.ts` measures event-loop delay via Node's native
`monitorEventLoopDelay` (no JS callback per loop turn) plus a single low-frequency drift sampler,
and reports p50/p95/p99 lag, stall events, memory, CPU utilisation and — optionally — GC pauses.

The reason is specific: "POST→ACK took 900 ms" has two completely different explanations, and
without loop instrumentation they are indistinguishable. One means the broker was slow; the other
means the broker replied in 90 ms and we did not run the continuation for 810 ms. They demand
opposite responses, and only one of them belongs in a broker latency distribution.

It is diagnostics, not a profiler: no CPU sampling, no heap snapshots. `process.memoryUsage()`
and `process.cpuUsage()` are called only from the cold snapshot path. Every method is fail-open;
a monitor that cannot attach reports `enabled: false` and returns `null` percentiles rather than
zeros that would look like a healthy loop.

### Shadow mode

Shadow mode runs the real feed and the real strategy, produces the paper orders it would have
produced, and submits nothing. It is enforced **three independent ways**, because a flag that is
merely checked before submitting gets bypassed by new code paths and error handlers:

1. `loadBoxConfig()` refuses to start if shadow mode is combined with `BOX_EXECUTION_MODE=live`.
   The contradiction stops startup rather than being resolved silently — one resolution places
   unwanted orders, the other silently disables trading somebody believed was on.
2. No live adapter is constructed outside `live` mode, so in shadow mode there is no object
   capable of reaching a broker.
3. `shadowGuardedAdapter()` turns any `submitOrder` / `modifyOrder` / `cancelOrder` into a loud,
   attributable throw. Reads stay open so after-the-fact comparison still works; `adoptOrder` is
   deliberately **not** forwarded, because adopting a live order means taking ownership of real
   exposure.

   **This third layer is currently UNREACHABLE BY CONSTRUCTION, and that is the point.** Because
   layers 1 and 2 mean no live adapter can exist in shadow mode, there is nothing for the wrapper to
   wrap today — it has no production call site. It exists as insurance against a future refactor
   that weakens layer 1 or 2, and is exercised only by its tests. Stated plainly so nobody reads
   "three layers" as "three active layers".

### Stress profile — separate, and never called live parity

`BOX_PAPER_EXECUTION_PROFILE=stress` is the profile reserved for resilience testing: broker
slowdown, feed outage, WebSocket gap, HTTP timeout, delayed ACK, delayed cancel, partial fill,
broker reject, Mongo failure, Redis failure, process restart, duplicate event, out-of-order event.

**STATUS: the profile and its isolation are complete; the fault injection itself is NOT yet plumbed
into the simulator's fill path.** `StressInjector` defines the fault schedule deterministically and
`createStressInjector()` refuses to exist outside this profile, so the containment guarantees below
hold today — but selecting `stress` currently produces the same behaviour as `live_parity` rather
than injecting anything. The scaffolding is deliberate and the gap is stated rather than implied.

The separation is structural, not conventional:

- `stress` is never a fallback — an unrecognised profile becomes `standard`, never `stress`;
- `loadBoxConfig()` **refuses to start** if `stress` is combined with live execution;
- `createStressInjector()` **throws** under any other profile, so "stress faults cannot appear in
  an evidence-driven run" is a property of the code rather than something to remember;
- `calibrationStatus()` reports `evidence_driven: false` and forces confidence to `LOW`;
- every rendered report carries a blunt banner saying the figures are synthetic.

Faults fire from an explicit schedule (`everyNth` / `atOperations`), never from `Math.random()`:
a resilience test that cannot be reproduced is not a test.

### Implementation shortfall and parity reporting

`src/box/executionShortfall.ts` attributes the full chain, per leg, with `unexplained` surfaced
rather than absorbed into another bucket:

```
THEORETICAL_DETECTED_EDGE − EDGE_DECAY − SLIPPAGE − BROKERAGE − TAXES_AND_FEES − UNWIND_COST
  = REALISED_NET_RESULT
```

Positive always means it cost us, whichever side the leg was. Failed and aborted attempts produce
records too — statistics that quietly exclude failures are why strategies look profitable on
paper and are not.

`src/box/pairedComparison.ts` answers "how realistic is the simulator?" the only honest way: for
the SAME candidate, what did paper predict and what actually happened? It reports **absolute
p50/p95/p99 error plus signed bias**, because a mean absolute error hides the tail and the tail
decides whether a four-leg entry completes. An unmatched prediction is excluded, never counted as
a zero error.

`computeExecutionShortfall` **is** called in production: `BoxEngine.observeAttempt()` runs it for
every finished legging attempt — filled, partial, aborted and failed alike — and the most recent
record is exposed on the diagnostics route as `last_implementation_shortfall`.

The **latency parity report** (`src/box/parityReport.ts`) is also produced now. It needs two
snapshots of the same shape, and previously only the live one existed; a separate paper-side
`BrokerTimingStore` is now fed from finished PAPER legs in `observeAttempt()`, so
`buildParityReports(liveSnapshot, paperSnapshot)` has two real sides to compare and appears on
diagnostics as `parity`. The two stores are kept strictly apart — paper legs are recorded only when
`executionMode !== "live"`, because feeding both halves from one population would compare a
distribution against itself and report perfect parity by construction.

**STATUS: the *paired candidate* comparison is a pure function with no production producer yet.**
That is a different thing from the latency parity report above: pairing real micro-size live
executions against paper predictions requires both sides to be captured for the same candidate id,
which needs a live run to capture. `buildPairedComparison` and `formatPairedComparison` are ready
and tested; nothing calls them in production. Likewise `computeAdverseSelection` (Phase 17) needs
book-at-submit/ACK/post-fill snapshots that are not yet captured, and `RecordedRejectReplayer` has
no replay harness wired. Those three are prepared primitives, not delivered reports.

### Admin diagnostics

`GET /api/box/execution-diagnostics` (same admin auth as every other box route, read-only, no
side effects) exposes: the active profile and its banner, what paper is running on, per-broker
calibration status with sample counts and freshness, the calibration distributions, live timing
percentiles, recent latency outliers, timing-recorder diagnostics including lost measurement,
event-loop and process health, measured outcome and reject rates, the advisory queue
recommendation, and shadow-mode status.

It exposes only latency numbers, counts, statuses and explicitly-configured labels. No token,
key or session identifier is reachable from it — the stores it reads never held one.

### Configuration

All defaults preserve today's behaviour. Nothing below enables live trading, and nothing below
changes the default execution mode.

| Variable | Default | Meaning |
|---|---|---|
| `BOX_PAPER_EXECUTION_PROFILE` | `standard` | `standard` (unchanged paper), `live_parity` (evidence-driven), or `stress` (fault injection — refuses to start with live execution) |
| `BOX_PAPER_MAX_CONCURRENT_EXECUTIONS` | live cap (`1`) | concurrent paper pipelines under `live_parity` |
| `BOX_PAPER_LATENCY_MODE` | `constant` | `constant` or `recorded_samples` (the config-supplied source, used when no calibration store is wired) |
| `BOX_PAPER_LATENCY_SAMPLES` | (empty) | observed POST→ACK latencies (ms), comma-separated |
| `BOX_PAPER_LATENCY_ACK_TERMINAL_SAMPLES` | (empty) | observed ACK→terminal latencies (ms) |
| `BOX_PAPER_LATENCY_SEED` | `0` | deterministic start offset into the samples (never randomness) |
| `BOX_PAPER_CALIBRATION_MIN_SAMPLES` | `30` | fresh measured samples before paper uses a calibrated distribution at all |
| `BOX_PAPER_CALIBRATION_BUCKET_MIN_SAMPLES` | `60` | fresh samples before a time-of-day bucket is trusted on its own — higher, to avoid overfitting |
| `BOX_PAPER_CALIBRATION_MAX_AGE_MS` | `259200000` (3 days) | samples older than this are excluded from ACTIVE calibration, but retained for analytics |
| `BOX_PAPER_CALIBRATION_TIME_BUCKETS` | `true` | enable coarse OPEN / NORMAL / CLOSE bucketing |
| `BOX_PAPER_CANCEL_LATENCY_MS` | `150` | fallback cancel-race window when no measured CANCEL latency exists. Non-zero on purpose: zero means "cancels are instantaneous" |
| `BOX_PAPER_PERSISTENCE_MS` | `0` | fallback durable-write delay before transmitting. Zero on purpose: unmeasured database latency is unknown, and guessing would be fabrication. The measured p50 is used once calibrated |
| `BOX_EXECUTION_TIMING_METRICS_ENABLED` | `true` | collect live timing for calibration (fail-open) |
| `BOX_EXECUTION_TIMING_WINDOW` | `500` | bounded ring size per timing distribution |
| `BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED` | `true` | monitor event-loop delay and process pressure (cheap, fail-open) |
| `BOX_DEPLOYMENT_REGION` / `BOX_EXECUTION_CALIBRATION_REGION` | (none) | region LABEL, never auto-detected. A calibration store refuses to import another region's samples |
| `BOX_LIVE_TIMING_PERSIST_ENABLED` | `false` | persist calibration observations so they survive a restart |
| `BOX_LIVE_TIMING_BATCH_SIZE` | `50` | observations buffered before a flush. Never a synchronous hot-path write |
| `BOX_LIVE_TIMING_FLUSH_MS` | `15000` | maximum time an observation waits in the buffer |
| `BOX_SHADOW_MODE_ENABLED` | `false` | SHADOW validation: real feed + real strategy, simulated orders, NO broker order ever. Refuses to start with live execution |

Scheduler pacing and the concurrency cap are sourced from the existing
`BOX_LIVE_BROKER_MIN_INTERVAL_MS` and `BOX_PAPER_MAX_CONCURRENT_EXECUTIONS`; leg timeouts come
from `BOX_LEG_TIMEOUT_MS` (and the `BOX_LIVE_*_TIMEOUT_MS` family for the live path). The profile
invents no separate paper timeout numbers.

### Recommended paper-validation configuration

Places **no real orders**: the execution mode stays paper and the live double gate is left exactly
as it is.

```
BOX_EXECUTION_MODE=paper_legging
BOX_PAPER_EXECUTION_PROFILE=live_parity
BOX_QUEUE_MODEL=haircut
BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT=30

# Scheduler parity — paper must use the SAME cap and pacing as live, otherwise its
# queueing model describes a deployment you are not running.
BOX_PAPER_MAX_CONCURRENT_EXECUTIONS=1      # = BOX_LIVE_MAX_CONCURRENT_EXECUTIONS
BOX_LIVE_BROKER_MIN_INTERVAL_MS=250        # shared by both schedulers

# Measure, and keep what was measured across restarts.
BOX_EXECUTION_TIMING_METRICS_ENABLED=true
BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED=true
BOX_LIVE_TIMING_PERSIST_ENABLED=true
BOX_DEPLOYMENT_REGION=ap-south-1           # a LABEL; samples never cross regions
```

`BOX_LIVE_TIMING_PERSIST_ENABLED=true` is what makes calibration survive a restart: observations
are batched into `box_calibration_samples` (TTL-bounded, region-scoped, latency numbers only) and
rehydrated on start.

**Do NOT set `BOX_EXECUTION_MODE=live` or `BOX_LIVE_TRADING_ENABLED=true` as part of validation.**
Enabling live trading is a separate, deliberate decision, and nothing in this work changes either
flag or weakens the double gate.

With no measured samples yet the calibration status is `UNCALIBRATED`, paper uses the documented
constants, and every report says `measured: no` and `confidence: LOW`. It never pretends a
constant is measured live latency. As real executions are observed the same store fills in and
paper's timing shifts onto evidence automatically.

To run the real strategy against the real feed while submitting nothing, add
`BOX_SHADOW_MODE_ENABLED=true`.

---

## Observable parity — what this simulator can and cannot claim

This section is the honest bottom line. It exists because "the simulator is N % realistic" is a
claim, and a claim needs evidence.

### What is now genuinely modelled from evidence

| Behaviour | Basis |
|---|---|
| Broker-side latency (POST→ACK, ACK→terminal) | measured live samples, consumed in a fixed rotation so the real tail survives |
| Scheduler queueing, concurrency and transport pacing | computed from the SAME policy object the live `OrderManager` uses |
| Cancel-vs-fill race window | measured `cancel_request_to_terminal_ms` |
| Fills, prices and partials | real observed WebSocket books, walked within a bounded LIMIT |
| Shared displayed liquidity across concurrent attempts | the reservation ledger; two attempts cannot double-spend one observed level |
| Time-of-day variation | OPEN / NORMAL / CLOSE buckets, activated only with enough samples of their own |
| Outcome and reject rates | counted from real observations, for comparison — paper is never steered to hit them |
| Marketable vs passive classification | decided in the fill path from the observed book, never assumed |
| Implementation shortfall | attributed per leg for every finished attempt, including aborted and failed ones |
| Live-vs-paper latency parity | two independently-fed timing stores compared stage by stage; paper is never fed from live samples, so the comparison can actually fail |

### What is a documented approximation

- **Queue position** → a conservative deterministic haircut. Advisory calibration measures the
  realisation ratio and recommends a value; it does not reconstruct queue position.
- **Liquidity depletion by other participants** → the ledger ensures our own concurrent attempts
  cannot double-spend one observed level, and a new book version is treated as fresh liquidity.
  It does not attempt to attribute *why* a level changed.
- **Cancel window length** → the measured p50 when calibrated, else a conservative constant
  (`BOX_PAPER_CANCEL_LATENCY_MS`, default 150 ms). Deliberately non-zero: an instantaneous cancel
  is the optimistic assumption.
- **Uncalibrated ACK→terminal** → 40 % of the single constant, so an uncalibrated run still
  separates "reaching the exchange" from "working at the exchange" instead of collapsing both.
- **Durable-persistence delay** → the measured `persistence_wait_ms` p50 when calibrated, else
  `BOX_PAPER_PERSISTENCE_MS` (default **0**). Zero is deliberate and it makes paper *optimistic*
  on this stage: the live path really does pay two Mongo round trips inside the held concurrency
  slot before it may transmit, but until that has been observed we do not know its size, and a
  guessed database latency would be a fabrication. `calibrationStatus()` reports
  `persistence_window_measured` so the difference is visible rather than assumed.

### What is NOT simulated, and will not be

**THIS IS NOT AN EXACT EXCHANGE SIMULATOR, and it must never be described as one.** It is a
deterministic digital twin of the *observable* execution path. Absolute physical exchange parity
is impossible, and pretending otherwise would be the most damaging thing this code could do.

`live_parity` explicitly **cannot reconstruct**:

- **true NSE queue position** of our order — level-2 depth aggregates quantity per price and
  reveals nothing about our place in the queue at that price;
- **hidden or iceberg liquidity** — by definition not displayed;
- **matching-engine ordering** — the exact sequence in which the exchange matches;
- **another participant's future order** — including the one that is about to take the liquidity
  we were relying on;
- **exact market impact** of our own order.

Nor does it fabricate:

- price movement that never appeared on the feed;
- broker OMS/RMS acceptance quirks;
- random slippage, random rejects, or random latency jitter — anywhere, under any profile called
  parity.

Where a stage has not been measured, paper uses a documented constant and says
`measured: false` / `confidence: LOW`. It never presents a constant as an observation.

### How to read a parity report

1. **Read `measured` and `confidence` first.** `LOW` means the report is diagnostic and justifies
   no realism claim, however tidy the percentiles look.
2. **Read the sample count and freshness.** They appear next to every figure for this reason.
3. **Check the profile banner.** A `stress` report is synthetic by construction.
4. **Prefer the p95/p99 error to the mean.** A four-leg entry is killed by the tail.
5. **Keep marketable and passive apart.** They are different populations with different
   epistemic status.

The intended trajectory is that the simulator becomes progressively more accurate on its own: as
real executions are observed, the live path writes measured samples into the same store paper
reads from, calibration status climbs from `UNCALIBRATED` toward `CALIBRATED`, confidence rises
with the evidence, and the paired comparison shows the error distribution shrinking. Until the
evidence exists, the system says so.
