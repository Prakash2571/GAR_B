# Live execution map

What each module does during a live trade, in what order it acts, and what happens on success,
failure, partial fill, ambiguity and stale data.

Every line reference is against `main`. Where a threshold is stated, it is the shipped default from
`src/box/config.ts` — check the deployed process with `node dist/box/effectiveConfig.js`, because a
default is not evidence of what is running.

---

## 1. Module map — who does what

### The decision path (a tick becomes an order)

| Module | Lines | Job | Acts when |
| --- | --- | --- | --- |
| `engine.ts` | 7735 | The orchestrator. Owns the lifecycle, the feed, the universe, subscriptions, SSE, readiness. | Continuously |
| `scanner.ts` | 1046 | Evaluates candidates and decides *this one should be entered*. | Every tick batch |
| `math.ts` | 1199 | The box arithmetic: net debit, gross edge, expected net. Pure. | Per evaluation |
| `instruments.ts` | — | Builds the ATM±3 strike windows and chain index. | Per universe pass |
| `candidateMarketData.ts` | 403 | Per-candidate (four-leg) market-data admission. 15 blocker codes. | Twice per entry |
| `executionCoherence.ts` | 484 | Cross-leg time skew — are the four books one snapshot? | Twice per entry |
| `boxCapital.ts` | 1403 | The ₹ cap on one box's gross notional. | Pre-submit |
| `charges.ts` / `localCharges.ts` | 371 | Brokerage/STT/GST per leg. Feeds the expected-net gate. | Per evaluation |

### The execution path (an order reaches the broker)

| Module | Lines | Job | Acts when |
| --- | --- | --- | --- |
| `executionCoordinator.ts` | 2268 | Ownership: duplicate suppression, session budget, underlying lock, contract reservations. | Before every entry |
| `executionGateway.ts` | 2599 | The one mode-neutral facade. Paper delegates to the simulator; live goes through the manager. Holds checkpoints 1–2. | Every entry/exit/flatten |
| `orderManager.ts` | 4218 | The durable order authority. Checkpoints 3–5, the hedge-first barrier, the circuit breaker, reconciliation. | Every order |
| `kiteBrokerAdapter.ts` | 2164 | Zerodha HTTP: place, modify, cancel, read. Pacing, idempotency, quarantine. | Every broker call |
| `brokerPacing.ts` | 1735 | Priority transport queue. Reserves capacity for recovery; promotes starved work. | Every broker call |
| `orderLifecycle.ts` | 624 | Order stages and the **`CumulativeFillLedger`** — the sole fill authority. | Every observation |
| `orderStreamConsumer.ts` | 1187 | Websocket order updates → ownership → projection. | Per frame |
| `orderUpdateProjection.ts` | 614 | One truth per order, shared by stream *and* REST. Dedup + monotonicity. | Per observation |

### The safety path (getting flat, staying honest)

| Module | Lines | Job | Acts when |
| --- | --- | --- | --- |
| `positionMonitor.ts` | 1448 | Re-prices open boxes, triggers exits, owns manual close. | Several times/sec |
| `exitDependencies.ts` | — | Exit wave plan: short-closing BUYs before hedge releases. | Per exit |
| `partialEntryRecovery.ts` | 376 | The 8-step plan when an entry half-fills. | Per incomplete entry |
| `residualFlatten.ts` | 301 | Retry state machine for leftover exposure. Identity/generation rules. | Every 2 s |
| `streamHealthPolicy.ts` | 1136 | Two state machines + the permission tables. **The asymmetry lives here.** | Continuously |
| `operationalReadiness.ts` | 851 | The one readiness verdict, scoped by blocker. | Per status read |
| `tradingSession.ts` | 553 | Durable attempt/cycle budgets. | Per entry |
| `underlyingLock.ts` | 407 | One active box per underlying, across processes. | Per entry |
| `repository.ts` | 3225 | PostgreSQL: trades, intents, attempts, projections, CAS. | Every write |

---

## 2. The live entry pipeline — every gate, in order

Twenty-plus gates across four modules. **A refusal at any point means no order was sent.**

### Stage 0 — tick arrives

```
broker socket → registry (box lane) → engine.ingestBoxLaneTicks (6494) → engine.onTicks (2771)
                                    → BoxQuoteStore.applyTicks        → scanner.onTokensUpdated (294)
```

The **box lane is a second physical socket**, separate from the futures/board lane, with its own
refcount table and token budget (`BOX_DEDICATED_MARKET_FEED=true`). A busy board cannot displace
option strikes, and a board-lane reconnect cannot blind the scanner.

### Stage 1 — `scanner.evaluateAndMaybeEnter` (scanner.ts:369)

| # | Line | Check | Knob / default | On refusal |
| --- | --- | --- | --- | --- |
| 1 | 378 | Per-leg freshness + executable depth at the touch | `quoteMaxAgeMs` **15 000** | not tradable |
| 2 | 391 | Gross prefilter | derived from `requiredNetProfit` | silent |
| 3 | 395 | **Publishes the card regardless** — including why it was rejected | — | visible as WATCHING/REJECTED |
| 4 | 401 | Discovery running (RUN/STOP) | — | silent |
| 5 | 402 | Market open | — | silent |
| 6 | 403 | Feed healthy | `feedMaxAgeMs` **5 000** | silent |
| 7 | 404 | Strike pair not already open | — | silent |
| 8 | 409 | Passed prefilter | — | silent |
| 9 | 410 | No entry already in flight for this key | — | silent |
| 10 | 411 | Execution capacity available | concurrency | silent |
| 11 | 415 | **Expected NET ≥ required** — the decisive gate | `BOX_MIN_EXPECTED_NET_PROFIT` | rejected |
| 12 | 430 | Re-evaluate **capturing full depth** — the immutable audit snapshot | — | — |
| 13 | 437 | → `attemptEntry` | — | **the trigger** |

The expected-net gate is the real one; gross edge is only a cheap prefilter:

```
expected_net = gross_edge
             − entry_charges − estimated_exit_charges
             − entry_slippage_allowance − future_exit_slippage_allowance
             − safety_buffer
```

### Stage 2 — `executionCoordinator.coordinateEntry` (685) — ownership

| # | Line | Gate | Refusal reason |
| --- | --- | --- | --- |
| 1 | 701 | Durable reservation tier required in live | `feed_unhealthy` |
| 2 | 752 | Duplicate opportunity already executing | `duplicate` |
| 3 | 773 | **Session cycle budget** | `session_limit_reached` |
| 4 | 806 | Underlying lock **layer 1a** (durable state) | `underlying_already_active` |
| 5 | 831 | Per-underlying concurrency budget | `duplicate` |
| 6 | 846 | **Synchronous claim** — no `await` may appear between 2 and here | — |
| 7 | 863 | **Session attempt budget spent** — before any reservation, long before any POST | `session_limit_reached` |
| 8 | 907 | Underlying lock **layer 1b** (exclusive CAS hold) | `underlying_already_active` |
| 9 | 949 | Contract reservations on all four legs | — |
| 10 | 963 | Conflict → wait for shared contract | `price_moved` |
| 11 | 1017 | **Revalidate after waiting** | `edge_disappeared` |
| 12 | 1072 | Pre-submit ownership confirmation | `feed_unhealthy` |

An attempt is **consumed at admission, not at completion** — that is the point of bounding attempts
rather than fills. A refused entry has still spent its budget.

### Stage 3 — `executionGateway.simulateLeggingEntry` (364)

| # | Line | Gate | Refusal reason |
| --- | --- | --- | --- |
| 1 | 366 | Single-lot invariant | `insufficient_quantity` |
| 2 | 380 | Durable trade id preallocated | `legging_incomplete` |
| 3 | 387 | **CHECKPOINT 1/5 `pre_build`** | — |
| 4 | 407 | Market-data + order-stream transport permission (**intersection**) | `feed_unhealthy` |
| 5 | 434 | Per-candidate four-leg evidence | `feed_unhealthy` |
| 6 | 455 | **Hedge-first build order** (BUYs first) | — |
| 7 | 489 | **Four-leg coherence admission** | `cross_leg_time_skew` |
| 8 | 518 | **₹ cap per box** (gross notional) | `box_capital_limit` |
| 9 | 541 | **Economic admission** — real funds/margin round trips | `box_capital_limit` |
| 10 | 564 | Re-check after the evidence reads (they take real time) | — |
| 11 | 582 | **CHECKPOINT 2/5 `pre_enqueue`** | — |
| 12 | 591 | **Coherence re-check before transmit** | `cross_leg_time_skew` |
| 13 | 613 | **The wave** — `Promise.allSettled` over four `manager.submit` | — |

### Stage 4 — `orderManager` — checkpoints 3, 4, 5

| CP | Line | Re-validates | Why here |
| --- | --- | --- | --- |
| **3** | 2705 | Feed stamp still authoritative · dispatch account · entry guard | At dequeue: the queue wait is a real window |
| — | 2729 | **CAS `CREATED → SUBMITTING`** | Lost CAS ⇒ another process owns this identity ⇒ **never POST** |
| — | 2741 | `registerStreamOwnership` **before** the POST | So a fill that beats the HTTP response has a ledger to land in |
| **4** | 2757 | Dispatch account **for every purpose** — not entry-only | An audit reproduction of this was an *exit* |
| — | 2802 | **Hedge-first barrier** | Building in order is not enough; four legs dequeue together |
| **5** | 2806 | Everything, inside the pre-POST callback | Pacing is done; next instruction is the POST — **throwing here proves no broker mutation** |

**Entry conditions can never block a reduction.** At `orderManager.ts:1352` the entry guard is
attached only when `purpose === "ENTRY"`; an EXIT, PROTECTIVE_CANCEL or EMERGENCY_RESIDUAL never
carries one.

### Hedge-first and "proven cover"

`entrySubmissionOrder` puts **BUYs (hedges) first, then SELLs**. Hedge legs never wait, so the two
BUYs still overlap. Each dependent SELL parks on a barrier until its hedges have decided.

Permission requires **positive proof**, not the absence of a named failure:

> `entryHedgeCoverageGap` (2010) only evaluates at `pre_post` — the one checkpoint where coverage is
> knowable. It requires `claimCoverage` to succeed: single-use, attempt-scoped proof that every BUY
> hedge filled its **full required quantity on the right contract, side and account**. No gate, or an
> undeclared hedge rank, means **blocked**.

That inversion matters because a hedge can come back `CANCELLED` with zero fills — no named failure,
and zero cover. The naked-short scenario is what this prevents.

---

## 3. Exchange data — what arrives, and when it is too old

### The quote store

`BoxQuoteStore` replaces the whole object per packet and never mutates in place, so a held reference
is a permanent record. Per token it keeps bid/ask/qty, a five-level ladder, a monotonic `version`,
and **two separate timestamps**:

| Field | Meaning | Used for |
| --- | --- | --- |
| `at` | when **we received** it | freshness, feed health — a dead feed is only visible in receive time |
| `exchange_at` | when the **exchange published** it | cross-leg coherence — whether four books are one snapshot |

Mixing these two is the bug class `brokerTimestamps.ts` exists to prevent: Kite states IST with no
offset, so the parse is explicit (`IST_UTC_OFFSET_MS`) rather than `new Date(string)`.

Three packet kinds are **rejected**: depthless, malformed levels, and authoritative-empty.

### Every staleness threshold

| Knob | Env | Default | Governs |
| --- | --- | --- | --- |
| `quoteMaxAgeMs` | `BOX_QUOTE_MAX_AGE_MS` | **15 000** | per-leg book freshness (receive time) |
| `feedMaxAgeMs` | `BOX_FEED_MAX_AGE_MS` | **5 000** | global feed liveness / heartbeat gap |
| `underlyingMaxAgeMs` | `BOX_UNDERLYING_MAX_AGE_MS` | **10 000** | spot staleness |
| `maxCrossLegExchangeDispersionMs` | `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS` | **250** | spread of the four exchange timestamps |
| `maxCrossLegReceiveDispersionMs` | `BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS` | **500** | spread of the four receive times |
| `maxReceiveToExchangeDelayMs` | `BOX_MAX_RECEIVE_TO_EXCHANGE_DELAY_MS` | **5 000** | our lag behind the exchange |
| `maxExchangeAheadOfReceiveMs` | *(policy, no env)* | **1 500** | clock anomaly — exchange ahead of us |
| `orderEventQueuePressureThreshold` | `BOX_ORDER_EVENT_QUEUE_PRESSURE` | **512** | ingestion backlog → DEGRADED |

Coherence refusal reasons: `stale_generation`, `generation_split`, `clock_anomaly`, `per_leg_stale`,
`receive_dispersion`, `exchange_dispersion`, `duplicate_stall`. Exits use a **weaker** check
(`evaluateReductionCoherence`) — a single current leg book can price a reduction; it can never
justify creating a new four-leg box.

### Market-data state machine — and what each state permits

Eight states: `DISABLED`, `CONNECTING`, `AUTHENTICATING`, `SYNCHRONIZING`, `READY`, `DEGRADED`,
`DISCONNECTED`, `AUTH_EXPIRED`.

| State | New entry | Exit / reduce | Manage working | Protective cancel |
| --- | --- | --- | --- | --- |
| `DISABLED` | ✗ | ✗ | ✗ | ✗ |
| `CONNECTING` | ✗ | ✗ | ✓ | ✓ |
| `AUTHENTICATING` | ✗ | ✗ | ✓ | ✓ |
| `SYNCHRONIZING` | ✗ | ✗ | ✓ | ✓ |
| **`READY`** | **✓** | ✓ | ✓ | ✓ |
| `DEGRADED` | ✗ | **✓** | ✓ | ✓ |
| `DISCONNECTED` | ✗ | ✗ | ✓ | ✓ |
| `AUTH_EXPIRED` | ✗ | ✗ | ✗ | ✗ |

`newEntry` is permitted in **exactly one state**, and that is machine-checked
(`permissionInvariantViolations`): no state may permit entry without exit, and none may permit
either without cancel.

**Four demoters:** heartbeat/frame gap > 5 s · no desired instrument with depth newer than 15 s *in
the current generation* · ingestion backlog · auth expiry.

`generation` is the connection epoch, bumped on every re-authentication. A book observed under a
superseded socket is **not stale, it is meaningless** — `isInstrumentFresh` requires
`depthAt.gen === gen`. This is what stops a reconnect from trusting pre-reconnect depth.

Only `onUsableDepth` makes an instrument fresh. A **heartbeat is not a tick**: it proves the
transport is alive and deliberately cannot warm a book, otherwise a feed with no depth at all could
report itself executable.

### Order stream — separate machine, different asymmetry

`DISABLED`, `CONNECTING`, `AUTHENTICATING`, `RECONCILING`, `READY`, `DEGRADED`, `DISCONNECTED`,
`AUTH_EXPIRED`.

**`DISABLED` permits everything** — REST polling is the documented fill authority and was the only
mechanism before streams existed. Only an *enabled-but-unhealthy* stream blocks new entry.

> **REST is the authority; the stream is a latency optimisation.** A stream only ever makes the same
> truth arrive *sooner*, never differently — both funnel through one `OrderUpdateProjection` so dedup
> and monotonicity hold across sources.

`onAuthenticated` **always** lands in `RECONCILING`, never `READY`: every reconnect owes a REST
sweep, and only a completed sweep reaches `READY`. **Missing ≠ zero** — an observation with an absent
quantity is attributed but applies no quantity and schedules a targeted re-poll.

---

## 4. Outcome matrix — what happens after the orders go out

| Outcome | Detected by | Action | Durable result |
| --- | --- | --- | --- |
| **4/4 filled, economics hold** | `filled_quantity >= quantity` on all four (`>=`, so an overfill is complete, not underfilled) | Open the box | `BOX`, `outcome_class=OPENED` |
| **4/4 filled, economics fail** | `qualify()` on **executed** prices | Immediately reverse all four; book the true round-trip cost | `abort_after_fill` |
| **1–3 legs filled** | not fully filled | 8-step recovery: stop unsubmitted → cancel outstanding → **wait for authoritative terminal quantities** → compute exact confirmed exposure → unwind only that | `PARTIAL_ENTRY_UNWOUND` or `PARTIAL_ENTRY_RESIDUAL` |
| **0 filled** | no exposure | Nothing to unwind | `NO_FILL` |
| **Any outcome unprovable** | see §5 | **Quarantine before recovery runs** — never unwind on a guess | `legging_incomplete`, `QUARANTINED_UNKNOWN`, `recoveryActive` |
| **Broker filled, our write failed** | `OrderPersistenceAfterFillError` | Broker truth wins; retry persistence with the same identity | fill retained |

### Fill authority

The **only** fill authority is `CumulativeFillLedger`, one per `client_order_id`:

- `cumulative` — the evidence execution occurred
- `remaining = requested − cumulative` — a retry must use this, never the original quantity, or a
  partial fill doubles exposure
- `hasExposure = cumulative > 0` — real, irreversible

`apply(event)` in checking order: malformed → `invalid`; duplicate event id → `duplicate_event`;
**`observed <= cumulative` → `stale_cumulative`, discarded** (rewind protection); otherwise applied,
with overfill **applied and reported, never clamped**. Sequence numbers are diagnostic only —
cumulative monotonicity already guarantees correctness.

The cancel race is arithmetic, not a guess: requested 75, 40 filled at cancel-request, 12 more raced
in ⇒ `filled 52 / cancelled 23, racedQuantity 12`.

### Partial exit

`remaining_qty_by_role` is canonical. `deriveBoxPositionState`: `FLAT` only when all four roles are
exactly 0; **`RECOVERY` is sticky**; `BOX` only when all four are equal and non-zero; otherwise
`PARTIALLY_EXITED`.

- **`PARTIALLY_EXITED`** — geometry known but unequal. A real, arithmetically consistent partial. It
  is routed to *flattening*, not normal management: it is no longer a whole box.
- **`RECOVERY`** — the truth is not established. Uncertain exit, unattributed order, or a conservation
  violation. Cannot be closed through ordinary execution; requires reconciliation, and is promoted
  back only inside emergency flatten.

A 1/4, 2/4 or 3/4 exit is **not** a closed box; the trade stays `open` until every role is 0.

---

## 5. The evidence rule — what proves nothing was sent

This is the single most important table in the system.

| Error | Proves no exposure? | Meaning |
| --- | --- | --- |
| `BrokerPreSubmitRefusedError` | **YES** | Thrown before the transport. No POST was attempted. |
| `BrokerOrderRejectedError` | **YES** | The broker itself refused. |
| `BrokerAmbiguousSubmitError` | no — **UNKNOWN** | The order may or may not exist. |
| `BrokerCancelNotTransmittedError` | no | The *cancel* provably never left — but the **order is unchanged and may still be working**. |
| `BrokerCancelUnresolvedError` | no — **UNKNOWN** | Durable non-terminal intent this session cannot act on. |
| `OrderPersistenceAfterFillError` | no | Broker filled; our write failed. Broker truth wins. |

```ts
// executionGateway.ts:668
const provenNoExposure = (reason: unknown): boolean =>
  reason instanceof BrokerPreSubmitRefusedError || reason instanceof BrokerOrderRejectedError;
```

**Two types prove safety. Everything else is uncertain.** The default is fail-closed by
construction: uncertainty is decided by *type*, not by matching words in a message.

Related invariant — **`stageProvesExecution()` always returns `false`**, with the literal type
`false`. No stage proves a fill: not HTTP 200, not a broker order id, not an acknowledgement. Only a
cumulative quantity does. And `stageAcceptsFurtherFills` is **true** for `CANCEL_REQUESTED`,
`CANCEL_PENDING`, `UNKNOWN` and `RECONCILIATION_REQUIRED` — a cancel response is not proof the order
is gone.

### Cancellation — three evidence-based outcomes

`sendCancelWithinDeadline` runs one absolute deadline across both the pacing queue and the network:

1. **Acknowledged** — the broker accepted the cancel request.
2. **Withdrawn before dispatch** — proof nothing was transmitted ⇒ `BrokerCancelNotTransmittedError`
   carrying the latest snapshot. Retryable.
3. **Dispatched then failed or timed out** — genuinely ambiguous ⇒ quarantine and rethrow.

`CANCEL_REQUESTED` is committed *from inside the dispatched closure*, so it means "the DELETE is on
the wire", and it is written **through** the map rather than mutated in place, so a fill arriving
mid-cancel is not lost.

---

## 6. What stops when the feed goes bad

| Activity | Behaviour |
| --- | --- |
| Scanner evaluation / detection | **STOPS** |
| New entry (transport + per-candidate) | **REFUSED**, naming which transport blocked |
| Order manager actions | **REFUSED**; a warm-up window applies on recovery |
| Automatic exit evaluation | **STOPS** |
| In-flight exit | **ABORTS mid-flight** (`stillWanted` re-evaluates) |
| **Manual close** | **REFUSED — HTTP 409** |
| Residual flatten | **STOPS**; residual retained and still reported as exposure |
| Protective cancel | **STILL PERMITTED** (except `AUTH_EXPIRED`/`DISABLED`) |
| Managing working orders | **STILL PERMITTED** (except `AUTH_EXPIRED`/`DISABLED`) |

### The manual-close gate — five refusals in order

`positionMonitor.closeManually` (1135):

1. Not open → **404**
2. `position_state === "RECOVERY"` → **409** reconcile first
3. Already closing → **409**
4. Market closed → **409**
5. **Feed unavailable → 409** "The position is still monitored."

> **This is the operating limit that matters most on the day.** Refusing to price an exit off a dead
> feed is correct — the alternative is trading on invented prices. But it means the application
> cannot guarantee an exit during a feed outage. **Independent broker access (Kite web, logged in and
> ready to flatten by hand) is not optional.**

---

## 7. Crash safety — what is durable before anything is sent

Ordered, and every step is before the POST:

1. `intent = intentFromRequest(...)` — **the account is stamped before the durable write**, so a crash
   leaves a row naming the account that owns whatever reached the broker.
2. `persistence.create(intent)` → durable `CREATED` in `box_order_intents`, one row per
   `client_order_id`, guarded by `INTENT_STATE_PREDECESSORS`.
3. If the row is **not** `CREATED`, a prior submission exists → read the broker, reconcile, resolve.
   **Never re-POST an identity that may already exist.**
4. CAS `CREATED → SUBMITTING`. Lost ⇒ another process owns it ⇒ never POST.
5. `registerStreamOwnership` — before the POST.
6. Checkpoint 5, then the POST.

Boot recovery matches journal rows to broker orders **by durable identity only**. A `BOX:` tag can
classify an orphan but never authorises acting on it. Unmatched non-terminal rows become
`RECONCILIATION_REQUIRED` **without resubmitting**.

Residual projections use order-independent sha256 identity plus version CAS, so two workers cannot
double-count one flatten.

---

## 8. Residual flattening — the retry loop

Runs every **2 s** while the market is open and the feed is healthy.

**Dispositions:** `flattened` · `retire_attempt` (**the only one that advances the generation**) ·
`reuse` · `adopt_attempt`.

**Failure kinds:** `no_executable_book`, `gate_refused`, `already_in_flight`,
`local_pre_submit_refused`, `broker_rejected`, `persistence_after_fill`, `broker_state_unknown`,
`identity_conflict`, `hedge_withheld`.

**The cover rule:** all short residuals are worked first; a long is released only when **every** short
is `flattened`. "Proven" means the broker's own terminal outcome accounted for the full quantity —
working, rejected, ambiguous and partially-filled all count as *not* closed. The gate is
whole-position, not per-contract: holding a long one extra cycle costs time value; releasing it one
cycle early can cost without bound.

Ownership is checked before action: a residual states the mode and broker it was created under, and a
process that does not match **holds and reports it without trading against it**.

---

## 9. Emergency flatten — ordered, and the order is the point

`engine.flattenAttributedBoxExposure` (2254):

| # | Step | Note |
| --- | --- | --- |
| 0 | Permission gate | `box_emergency_flatten` must be armed |
| 1 | **Disable entry** | Reduction is untouched — `box_entry_enabled` never gates getting flat |
| 2 | **Cancel working orders** | Failures are recorded and **never abort the flatten** |
| 3 | **Re-reconcile** | So the plan is built on post-cancellation broker truth |
| 4 | Re-read and gate | Reconciliation complete, or reduction provably safe |
| 5 | **Plan reductions** | The only place a `RECOVERY` position is promoted |
| 6 | Crash-only exposure | Persisted under a recovery attempt id |

Planning a reduction against a quantity another working order is still changing is the whole problem.
Refusing would strand exposure. So the fix is **ordering, not refusal**.

---

## 10. Readiness — blockers are scoped, structurally

`BlockerScope` is `entry | reduction | both`, and the split is enforced in the published shape:

| Scope | Published at | Meaning |
| --- | --- | --- |
| `entry` | `decision.entry.reasons` | May stop **new exposure only**. Can never reach the reduction verdict. |
| `reduction` | `decision.exposure_management.blocked_reasons` | A position genuinely cannot be closed right now. Rare and serious. |
| `both` | both | Truly stops everything (an expired session). |

Current entry-scoped codes include `scanner_stopped`, `market_closed`, `entry_disabled`,
`recovery_active`, `reconciliation_incomplete`, `residual_state_unknown`,
`readiness_evidence_unavailable`. Reduction-scoped: `execution_mode_mismatch`.

The recurring principle: **unverified is not the same as verified.** An unreadable evidence source is
a blocker, never an all-clear.

---

## 11. What this map does not tell you

Stated plainly, because the rest of this document could otherwise read as reassurance:

- **No real order has ever been placed by this code.** Every guarantee above is a property of the
  code and its tests, not a measurement of broker behaviour.
- **Broker-behaviour validation is the weakest area.** Rate limits per endpoint, funds-field
  semantics, actual fill behaviour on marketable limits, and Zerodha's real error taxonomy under load
  are inferred from documentation, not observed.
- **Run exactly one execution process.** Overlapping workers are not proven to coordinate every
  recovery and exit path; instrument reservations alone do not establish it.
- **Verify the deployed process, not the repository.** Both ceilings at 1 *in the armed session*,
  correct lot size, funds/margin checks enabled, migrations complete, clean reconciliation.
- **An accepted order is not a fill.** Zerodha requires subsequent status verification, which is why
  `stageProvesExecution` always returns `false`.
