# Supervised one-lot live test — the gate

Authored against `main` at **`329d3853c9d3050588ace40ca4df80c40f592f6e`**, which at the time of
writing is **identical to the last reviewed commit**: there are zero commits between the reviewed
revision and current `main`. Everything below therefore describes the reviewed tree plus the changes
on this branch, and nothing else.

This document exists because the previous records mixed five very different kinds of claim into one
tone of voice. Every statement here is tagged, and the tags are not interchangeable.

| Tag | Means |
|---|---|
| **[CODE]** | Proven in code and enforced by a test in this repository. |
| **[REPORTED]** | A status surface says so. The surface is only as good as the evidence behind it. |
| **[HOST]** | Requires verification on the production host. **Not done.** |
| **[BROKER]** | Requires verification with the broker (Zerodha/Dhan). **Not done.** |
| **[UNVERIFIED]** | Nobody has established this either way. |

A **[REPORTED]** claim is never promoted to **[CODE]**, and neither is ever promoted to **[BROKER]**.
The whole purpose of the taxonomy is that a green panel is *necessary evidence, not sufficient proof*.

---

## 1. The test-coverage boundary — read this before trusting any [CODE] tag

Every automated test in this repository, including every test added on this branch, drives a **fake
in-process transport**. No test has ever placed an order with Zerodha or Dhan.

- **[CODE]** The adapter → manager → gateway → durable-persistence composition is real in tests: the
  suites instantiate the production `KiteBrokerAdapter` / `DhanBrokerAdapter`, the production
  `BoxOrderManager` and the production `CentralBoxExecutionGateway`.
- **[CODE]** What is faked is the HTTP boundary (a transport that records instead of sending) and, in
  the unit suites, PostgreSQL/Mongo (an in-memory store that models the compare-and-set).
- **[UNVERIFIED]** Whether a real Zerodha or Dhan response — field names, status vocabulary, error
  bodies, timing, partial-fill sequencing — matches the fixtures. Fixtures were written from
  documentation and from the reviewed code's own expectations, which is **not** the same as a captured
  live response.

So: **"broker-verified" is a phrase that may not be used about anything in this repository.** A
mocked-transport test proves our logic is self-consistent. It cannot prove the broker agrees.

---

## 2. What this branch changed

### 2.1 A broker rejection is no longer proof of zero exposure — **[CODE]**

A placement POST can be definitively rejected *after* an order update has already reported a positive
cumulative fill for the same client order id. `mergeBrokerOrderSnapshot` correctly refuses to choose a
side (RECONCILIATION_REQUIRED, fill preserved), but both adapters then threw that snapshot inside a
`BrokerOrderRejectedError` — the one error type the gateway accepts as proof the leg does not exist.
Partial-entry recovery consequently treated the disputed leg as absent and **unwound the confirmed BUY
hedges that may still have been protecting its real short fill**.

The invariant now enforced: *"the broker rejected the request" proves zero exposure only when the
authoritative merged snapshot establishes a terminal `REJECTED` state with a verified
`filled_quantity === 0`.* A nonterminal or contradictory state, a positive cumulative fill, fill
records, missing quantity evidence, a conflicting broker order id, or a failed durable write all leave
the outcome unproven — and unproven means uncertain.

Reachability, both brokers, **[CODE]**: the window is **not** stream-only. Even with order streaming
disabled, the adapter's order map is mutated during an in-flight POST by `refresh`/`getOrder`,
`listOrders`, tag/correlation reconciliation, `modifyOrder`, and the REST observations the manager
feeds back through `applyOrderUpdate`. Disabling the Zerodha order stream does **not** close it.

### 2.2 Three reporting defects that told the operator the wrong thing — **[CODE]**

These were found while testing 2.1. None of them corrupted accounting; all of them corrupted what a
human would read, which on this path is the control surface.

1. The uncertain-entry quarantine returned with `legging.outcome_class` **undefined**, and `engine.ts`
   then *inferred* `PARTIAL_ENTRY_UNWOUND` from the leg counts. A quarantine in which **nothing was
   unwound** — exposure still live, awaiting reconciliation — was published as exposure that had been
   protectively reversed. Now stamped `QUARANTINED_UNKNOWN` and carries each disputed leg's role,
   side, state, cumulative quantity and broker order id.
2. A reduction leg refused at the send boundary (CHECKPOINT 3/5) was not recorded as withheld, so the
   exit detail fell through to the literal string **"live exit partially filled"** for a leg that was
   provably never transmitted. Now reported as `NOT SUBMITTED`, with the still-open quantity named and
   an explicit instruction to reduce manually at the broker terminal if automation keeps failing.
3. An entry refused by a limit (daily-loss breaker, paused entry, unestablished risk seed, missing
   account identity) rejected with a bare `Error`. The gateway recognises proven-no-exposure by
   *type*, so every such refusal was published as `QUARANTINED_UNKNOWN` / "broker terminal quantity is
   uncertain" — **inventing uncertainty about a broker that was never contacted**. It now rejects with
   `BrokerPreSubmitRefusedError`, and an attempt in which every leg was refused before its POST is
   labelled `REFUSED_BEFORE_SUBMIT` rather than `NO_FILL` (which the funnel counts as a *submitted*
   failure).

### 2.3 The daily rupee loss limit is a real entry brake — **[CODE]**, newly proven

Previously this runbook said *"treat the loss budget as observability, not a brake"*. That was a
statement about test coverage, not about the code: every suite set the limit to 1,000,000 or 0.

- **[CODE]** `BOX_LIVE_DAILY_LOSS_LIMIT` (default **₹5,000**) halts new entry. Enforcement is
  indirect — `evaluateLimits()` trips the **sticky** breaker, and `entryBlockReason` refuses on it at
  all five entry checkpoints.
- **[CODE]** Reconstructed at boot from durable state (`box_trades` + `box_execution_attempts`), so it
  survives a restart. An **incomplete** reconstruction refuses entry rather than trusting an
  understated loss.
- **[CODE]** Entry-only: it never blocks an exit, protective cancel or reconciliation.
- **[CODE]** Re-arming the entry control and rolling the trading day do **not** clear it.
- **[CODE]** `BOX_LIVE_DAILY_LOSS_LIMIT=0` means the gate is **DISABLED**, not "no loss allowed".
- **[UNVERIFIED]** Whether the *deployed* value is the one you intend. See §4.

---

### 2.4 A failure after four confirmed fills no longer loses the position — **[CODE]**

Two paths could take a complete four-leg fill and leave no record of it.

- **[CODE]** `simulateLeggingEntry` called the scanner-supplied `qualify` callback with no `try/catch`.
  A throw propagated out of the gateway and discarded the four `BrokerOrder` snapshots: no failure
  record, so no durable attempt row and no `residual_exposure`; no `outcome_class`; no
  `invariantViolation`, so the breaker never tripped and new entry was never blocked. The scanner
  classified it as a technical fault with `exposure_existed: false` and released the candidate.
- **[CODE]** `finalizeOpen`'s two post-fill failure branches (unbuildable charge legs, and a null
  insert from a duplicate-open-box index or a failed write) ended in `positions.release(cand.key)`
  after a `console.error`, with a comment admitting residual adoption "is not built yet".

Both now route through one path. It **retains** the exposure (never unwound: a throw is the *absence*
of an economic verdict, so reversing would pay a four-leg round trip on a position that may have been
fine), **keeps ownership** (`positions.release` is deliberately not called), **reconstructs the
exposure** as `residual_exposure` for the flatten loop, **blocks new entry** via `invariantViolation`
→ breaker, and labels it `FILLED_EXPOSURE_UNRECORDED` with a new `filled_exposure_unrecorded` alert
reason whose remedy tells the operator to verify the four legs at the broker. Because the durable
write is fire-and-forget, the message states that persistence **could not be confirmed** rather than
claiming the exposure was saved.

**Remaining limits, [CODE]:**
- The candidate key stays reserved, so that strike pair cannot be re-entered until the process
  restarts. Deliberate and fail-closed, but it is a manual cleanup, not self-healing.
- On the **atomic** paper path there is no per-leg broker record, so the retained quantities are
  reconstructed from the evaluation's touch prices rather than from broker fills. Live mode always
  uses the legging path, which carries real fill detail.
- `onExecutionAttempt` returns `void`, so the gateway/scanner cannot verify the durable row landed.
  The breaker is the backstop that holds when it does not.

### 2.5 A proven zero-fill exit rejection is no longer treated as broker uncertainty — **[CODE]**

`BrokerOrderRejectedError` had no branch in the exit wave, so it fell into the catch-all that sets
`uncertain = true`. That tripped the breaker (blocking **new entry**) and produced the detail
"exit terminal quantity uncertain", which `positionMonitor` regex-matches to move the **whole
position** to RECOVERY — on the strength of the one outcome the broker was explicit about.

- **[CODE]** A rejection whose snapshot passes `verifyZeroBrokerExposure` (terminal `REJECTED`,
  verified `filled_quantity === 0`, no fill records, no missing quantity evidence) is now reported as
  a **failed reduction with the broker's reason**: `REJECTED BY BROKER: <role> … <reason>`, with the
  still-open quantity named. No invented uncertainty, no breaker trip, no whole-position RECOVERY.
- **[CODE]** The leg's outstanding quantity is unchanged and its hedge stays on. `certain: true` with
  a zero fill cannot release cover — `releasableHedgeQuantity` requires `confirmedClosed > 0` — and a
  test asserts zero hedge POSTs.
- **[CODE]** A **contradicted** rejection, an ambiguous submission and a persistence-after-fill
  failure all still quarantine and fail closed, unchanged.
- **[CODE]** A partial fill on another leg is still credited, and its hedge release is still sized
  only from the proven closed quantity.

### 2.6 A PostgreSQL outage stops reduction too, and the surfaces now say so — **[CODE]**

The architecture is **PostgreSQL-authoritative**. MongoDB is an asynchronous, non-authoritative
reporting replica fed through an outbox: a Mongo backlog, dead-letter or outage delays reporting and
blocks nothing operational. (`src/box/LIVE_EXECUTION.md` has been corrected — it previously described
Mongo as the durable store and told operators to restore Mongo before trading live.)

- **[CODE]** Every order reaching the broker needs PostgreSQL FIRST, for every purpose.
  `BoxOrderManager.execute()` performs two awaited durable writes before the transport call —
  `persistence.create` and the `CREATED → SUBMITTING` compare-and-set — and the guard after the CAS
  reads "broker POST blocked".
- **[CODE]** So during an outage: a normal EXIT and an EMERGENCY_RESIDUAL flatten are **refused with
  nothing transmitted**; the protective-cancel sweep is refused because it must first READ the intent
  journal to know what to cancel; and reconciliation fails closed on the same read.
- **[CODE]** A reduction is therefore **refused, not queued**. Exposure is unchanged and still owned,
  and **the broker terminal is the only remaining route**.
- **[CODE]** Readiness now reports this: a `both`-scoped `durable_store_unavailable` blocker, with
  `exit_and_reduce`, `protective_cancel` and `manage_working_orders` all `false`. The frontend banner
  no longer claims "Exits, protective cancellation and reconciliation are unaffected."
- **[CODE]** The cancel sweep now returns its structured `{ ok: false, attempted: false,
  blocked_reason }` refusal instead of throwing a raw database error.
- **[CODE]** `pg_ready` is a pool latch probed once at init and never re-probed, so it can read `true`
  while every query fails. The observed-write latch `health.persistence` catches that, and the verdict
  consults both. Paper deployments are exempt — they have no durable intent journal.

### 2.7 A confirmed fill that outlived its process blocks new entry — **[CODE]**

All four legs broker-confirmed FILLED, then the position/execution-attempt write fails and the process
stops. On restart, reconciliation **reconstructs** the exposure from the intent journal and the broker,
so `attributedRecoveryExposure()` reports all four legs.

- **[CODE]** But **no position or residual row is ever rebuilt from intents alone.** `openBoxes` and
  `residualLegs` stay `0`, so the residual flatten loop has nothing to work and nothing reduces it
  automatically.
- **[CODE]** Measured on the real wiring before the fix: `canEnter()` returned `true` and
  `entryBlockReason()` returned `null` — a brand-new four-leg box was admissible on top of four legs
  nobody was managing. `crashRecoveryEntryQuarantined` did not cover it (it is refreshed only from
  `onReconciliationIssue`, and additionally requires the crash-recovery *index* to be unverified, so a
  clean restart with a healthy database never triggers it).
- **[CODE]** New ENTRY is now blocked by the ENTRY-scoped `unowned_attributed_exposure` blocker, which
  names the symbols, quantities and the required operator action. Reduction stays fully available,
  because reducing is how it gets resolved.
- **Remaining limit, [CODE]:** this is an **operator-in-the-loop** stop, not automatic recovery.
  Nothing reconstructs a durable position or residual row from the journal. The operator must verify
  the positions at the broker and then flatten the attributed exposure with the emergency control
  (which acts on exactly this crash-only set) or reconcile it into a trade.
- **[CODE]** If the broker does **not** confirm the reconstructed exposure, that is a
  journal/broker mismatch: reconcile trips the breaker and blocks entry that way instead.

## 3. Reduction under degraded market data — the accepted trade-off

- **[CODE]** Every order, entry and reduction alike, is a **bounded LIMIT** order. Nothing anywhere
  escalates to a market order; there is no `order_type: "MARKET"` on any path.
- **[CODE]** A reduction leg can therefore only be sent while it has a current, fresh, deep-enough
  executable book. If the book dies after admission, the leg is **withheld**, per-leg — one dead book
  does not abort the wave.
- **[CODE]** A withheld leg is never counted as reduced. Exposure is decremented only from a broker
  cumulative fill, and a withheld leg leaves the position's outstanding quantity untouched, so it is
  durable and re-planned on the next cycle.
- **[CODE]** The consequence, stated plainly: **automated reduction can be withheld indefinitely while
  exposure stays open.** That is deliberate — an unbounded order on a thin options book can cost more
  than the exposure it was removing — which makes the reporting in §2.2(2) the operative control.
- **[CODE]** Entry-scoped brakes do not stop reduction. Three independent mechanisms: the entry guard
  is passed only for `purpose === "ENTRY"`; `queuedActionBlockReason` forks entry vs reduction; and
  readiness blockers carry a `scope: "entry" | "reduction" | "both"`.
- **Residual risk, [CODE] but unaddressed:** the withheld set is **prose only**. It is joined into a
  detail string and is not a structured field, metric, SSE event or readiness blocker. A machine
  consumer reading `reason: "legging_incomplete"` still cannot distinguish "nothing was transmitted"
  from "we transmitted and got a partial". A human reading the detail can.
- **Residual risk, [CODE]:** the residual-flatten cover gate is deliberately **whole-position** — one
  short residual with no executable book withholds *every* long residual, to avoid manufacturing a
  naked short. Correct, but it means a single dead book can stall the whole flatten loop.

### Disarming entry is not an emergency stop — **[CODE]**

Two different things that an operator under pressure will conflate:

- **Disarming ENTRY** stops *new* exposure. It does nothing to exposure you already hold, and by
  design it must not: every exit, protective cancel, residual flatten and reconciliation route stays
  open.
- **Broker-native emergency handling** — cancelling and squaring off from the Zerodha/Dhan terminal —
  is the only thing that acts on existing exposure without this process's cooperation. If automated
  reduction is withheld (§3) or quarantined (§2.2), **that is the control**, and no amount of
  disarming will substitute for it.

---

## 4. Host-side and broker-side facts that are NOT established

None of the following is verifiable from this repository, and none was verified for this change.

| # | Fact | Status | How to establish it |
|---|---|---|---|
| 1 | The production database's migration provenance (16 applied vs 14 shipped) | **[UNVERIFIED]** | `PRE_LIVE_DEPLOYMENT_VERIFICATION.md` §5.1 — read-only commands and stop conditions |
| 2 | The host's actual public egress IP | **[HOST]** | Observe it from the host itself |
| 3 | That the egress IP is registered in the Kite developer console | **[BROKER]** | Read the broker dashboard |
| 4 | The deployed `.env` — especially `BOX_LIVE_DAILY_LOSS_LIMIT`, `BOX_LIVE_MAX_OPEN_LEG_QUANTITY`, `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY`, `BOX_LIVE_ALLOWED_UNDERLYINGS`, `BOX_SESSION_MAX_ENTRY_ATTEMPTS`, `BOX_SESSION_MAX_COMPLETED_TRADES` | **[HOST]** | Read the deployed file; do not infer from defaults |
| 5 | The current NIFTY lot size in the live instrument master | **[BROKER]** | See §4.1 |
| 6 | That a real broker order response matches our fixtures | **[UNVERIFIED]** | Only a supervised live order can show this |
| 7 | Deployed process/PM2 state, PostgreSQL and Mongo contents | **[HOST]** | Read them |

### 4.1 The static-IP gate is an attestation, not proof — **[CODE]**

`src/box/zerodhaStaticIp.ts` is explicit and correct about this, and the phrasing must not drift:

- **[CODE]** `ZERODHA_STATIC_IP_CONFIRMED=true` records that an **operator asserted** the egress IP is
  registered. It fails closed (unset, blank, `false` and a typo all read as not confirmed) and gates
  **entry only** — never a cancel or an exit.
- **[CODE]** There is no network call on this path. `ZERODHA_EXPECTED_EGRESS_IP` is recorded for
  diagnostics and **nothing compares it against an observed address**.
- **[BROKER]** Whether Zerodha has actually whitelisted the host's real outbound address. Kite exposes
  no endpoint that answers this, so the flag can never become proof. **A green static-IP row means
  "the paperwork box is ticked", not "the broker will accept our orders."**

### 4.2 NIFTY lot size versus the configured caps

- **[CODE]** Entry quantity is `candidate.lot_size` per leg — taken from the **instrument master at
  runtime**, never hardcoded.
- **[CODE]** Defaults: `BOX_LIVE_MAX_OPEN_LEG_QUANTITY` = **100**, `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY`
  = **400**.
- **[CODE]** The test fixtures use a lot size of **75**. At 75: one leg = 75 (under the 100 per-leg
  cap), a four-leg box = 300 gross (under the 400 gross cap), and a **second** box = 600 gross, which
  the gross cap refuses. So the shipped defaults permit **exactly one one-lot box** at a lot size of 75
  — which is the intended trial envelope, but only *at that lot size*.
- **[UNVERIFIED] / [BROKER]** The lot size the live instrument master will actually return. This is the
  single most important arithmetic to re-check before arming, because it is an exchange parameter that
  has changed before and it is **not** under this repository's control:
  - if the lot size rose above **100**, the per-leg cap refuses **every** entry (the trial cannot run);
  - if it rose above **133**, a single four-leg box exceeds the 400 gross cap;
  - if it fell well below 75, the caps would silently permit **more than one** box.

  Read the deployed caps (§4 item 4) and the live lot size together, and confirm the product is the
  envelope you intend. Do not assume 75.

---

## 5. Readiness fields: which are gates and which are only reports — **[CODE]**

`buildOperationalReadiness` carries an explicit `scope` per blocker (`"entry" | "reduction" | "both"`),
and that scope — not the field's position on a panel — is what decides whether it can stop anything.

- **Authoritative ENTRY gates** (the server re-validates every entry request independently of any UI):
  the circuit breaker (including the daily-loss trip), the daily-risk-seed health, the underlying
  allow-list and operator blocklist, capital/economic admission, per-leg and gross quantity caps,
  session attempt and completed-trade budgets, broker/account identity, reservations, the Zerodha
  static-IP attestation, and the per-leg executable-book precheck.
- **Reporting only:** counters and diagnostics such as realised P&L, latency and pacing statistics,
  stream-observation tallies, and the published `daily_loss_limit` / `realised_pnl_today` pair. These
  describe; they do not refuse.
- **The trap:** a field can be *derived from* an authoritative gate and still not *be* one. Treat a
  panel row as a gate only if it names a blocker code with an entry scope.

---

## 6. Verdict

**NO-GO for a supervised one-lot live test at the time of writing.**

The code-side blockers found so far are closed and tested: the rejection/fill race (§2.1), three
operator-facing misreports (§2.2), the two post-fill failure paths that could lose a confirmed
four-leg position (§2.4), the exit rejection that manufactured broker uncertainty (§2.5), the
PostgreSQL-outage claim that exits were unaffected (§2.6), and the restart that admitted a new box on
top of un-owned exposure (§2.7).

**Fixing code does not authorise a live test.** The following are each independently disqualifying and
**all four remain open**:

1. The production migration discrepancy (16 applied vs 14 shipped) is **unexplained**. §4 item 1.
2. The host's egress IP and the Zerodha whitelist are **unconfirmed**. §4 items 2–3, §4.1.
3. The deployed configuration and the live NIFTY lot size are **unread**. §4 items 4–5, §4.2.
4. No behaviour on this path has ever been **broker-verified**. §1.

Do not arm live ENTRY. Re-issue this verdict only when each item above has been executed on the host
and its actual output recorded here.
