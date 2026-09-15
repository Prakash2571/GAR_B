# External execution audit — remediation

**Audit baseline:** GAR_B `544dd55`, verdict **NO-GO**, order-punching score 2/10, six critical blockers
and seven high-risk issues.

**Remediated on:** `64214fd` (which already contained the exposure-control and account-binding work
from PR #23, itself a response to an earlier review).

**Every finding this document claims was verified was re-confirmed on `64214fd` before being touched.**
Nothing was accepted on the audit's word and nothing was dismissed as already-fixed without reading the
code. Of the items checked, **all were still present.**

---

## 1. What was fixed

Seven findings, prioritised strictly by how directly they can create or strand real exposure.

### C3 — Cancellation-PENDING treated as terminal cancellation  ·  *naked short*

`src/box/kiteBrokerAdapter.ts`

```ts
if (value === "COMPLETE") return "COMPLETE";
if (value.includes("CANCEL")) return "CANCELLED";      // ← the defect
if (value.includes("REJECT")) return "REJECTED";
```

Kite publishes `CANCEL PENDING` and `CANCEL VALIDATION PENDING` while a cancellation is still being
worked. Both contain `"CANCEL"`, so both mapped to `CANCELLED` — which `isBrokerOrderTerminal` treats as
**terminal**. `waitForResolution` stopped waiting and reported `filled: 0, pending: 75` for an order
still live at the exchange.

That is a naked-exposure bug, not a labelling one: the hedge-coverage ledger releases a BUY hedge once
its dependent SELL is deemed dead. A short entry in `CANCEL PENDING` was deemed dead, its long hedge was
sold, and then the short filled.

**Now:** terminal is an **exact** match against a small table (`COMPLETE`, `CANCELLED`, `CANCELLED AMO`,
`REJECTED`). Anything containing `PENDING` is non-terminal by definition — it is Kite's own statement
that the outcome is unsettled — and an *unrecognised* status is `UNKNOWN`, also non-terminal, so a status
Kite adds later fails closed rather than being guessed into terminality.

The error directions are deliberately asymmetric: over-waiting on a finished order costs latency and ends
in an honest quarantine; under-waiting on a live one destroys a hedge.

### C1 — Residual flattening could sell the hedges  ·  *naked short*

`src/box/executionGateway.ts`, `src/box/residualFlatten.ts`

```ts
for (const residual of args.residual) {
  passes.push(await this.flattenOneResidual(manager, args.keyPrefix, residual));
}
```

Every residual reversed independently, in whatever order the array arrived. Normal exits and the
immediate protective unwind understand hedge dependencies; this separate *periodic* recovery path did
not. It sold both long hedges — the liquid, protective side, which fills easily — and then failed to
close the shorts.

**Now:** shorts are closed first, and a long is released **only if every short pass is proven
`flattened`** (the broker's own terminal outcome accounting for the full requested quantity). Working,
rejected, ambiguous, partially filled and not-sent all count as *not closed*. A held long gets a new
disposition, `hedge_cover_retained`, which sends nothing and leaves its durable identity untouched so the
next pass reconsiders it.

Sorting alone would not have been enough, and test `C1-c` pins that: a short-close that *fails* must
still prevent the later sale of its cover. Ordering cannot express a dependency; only a gate can. The
gate is whole-position rather than per-contract on purpose — a box's protection is not a neat
one-to-one pairing, and holding a long one extra cycle costs time value whereas releasing it one cycle
early can cost without bound.

### C6 — A working order recovered on restart counted as "reconciled"  ·  *naked short*

`src/box/orderManager.ts`, `src/box/engine.ts`

Readiness was scored from `unknownOrders`, which counts only `UNKNOWN` and `RECONCILIATION_REQUIRED`. An
intent that reconciliation **matched** against a real broker order in `OPEN` / `ACKNOWLEDGED` /
`PARTIALLY_FILLED` counted as nothing, so after a restart mid-attempt `reconciliation_complete`,
`safe_reduction_ready` and `can_enter` all read **true** while an order that could still fill was live.

**Now, two parts:**

1. `unattendedWorkingOrders` counts non-terminal matched intents that **no waiter in this process owns**,
   and blocks new **entry** with a specific reason. `!activeClientIds.has(...)` is the discriminator that
   makes this safe — a live four-leg attempt's own in-flight legs are *attended*, so they never block
   their siblings (test `W3`).
2. `flattenAttributedBoxExposure` now **settles before it plans**: latch entry off → cancel working
   orders → re-reconcile → *then* judge readiness and compute reductions. A cancellation refusal is
   reported in a new `settlement` block but never aborts the flatten, because cancellation failing is
   exactly when flattening matters most.

Reduction is deliberately **not** blocked by an unsettled quantity (test `W2`): that would strand the
very exposure that needs unwinding.

### C2 — Reconciliation could resurrect closed exposure  ·  *reverse position*

`src/box/orderManager.ts`

`performReconcile` loads a journal snapshot, awaits two broker round trips, then rebuilds the
attributed-position map **absolutely** from that snapshot. A fill committed during those awaits is
applied incrementally to the same map, and the rebuild overwrites it:

```
actual long 75 → reconcile starts → an EXIT sells 75 (actual now 0)
               → reconcile restores internal exposure to long 75
               → another "reduction" sells 75 → actual is now SHORT 75
```

The circuit breaker is no defence — reduction admission reads the same corrupted map and stays permitted
while the breaker is open.

**Now:** an obsolete rebuild is **refused**. Staleness is detected per-intent against `knownIntents`
(updated by `persistOrder` on every commit): an intent touching a symbol about to be rebuilt is stale if
it is **absent** from the snapshot or **ahead** of it. Absent matters most — the dangerous case is a
brand-new EXIT the snapshot cannot represent at all. The newer incremental value is kept, the
position-mismatch comparison is skipped (its `expected` would be the stale figure, so it would trip the
breaker on our own staleness), and reconciliation is reported **incomplete** so the next pass reconciles
fresh.

> **A first attempt at this was wrong and is worth recording.** A global "did any exposure change"
> counter broke three adoption tests, because a reconcile pass legitimately commits fills of its own —
> that is what adopting broker truth *means* — and a global flag cannot tell those from a concurrent
> exit's write. It would have discarded every adopting pass.

It is also **not** raised as an invariant violation: that trips a breaker needing an operator to clear
*and* re-enters `reconcile()` from inside `reconcile()`. Reporting incomplete self-heals.

### C5 — A fully executed exit could not be persisted  ·  *deterministic failure*

`src/box/repository.ts`

The engine's close payload carries dotted per-leg keys (`legs.0.exit_price`, …) and `buildTradePatch`
interpolated every key straight into the SQL `SET` list:

```
UPDATE box_trades SET legs.0.exit_price = $2 …   →  syntax error at or near ".0"
```

So a box whose four entry legs *and* four exit legs had all executed could not be marked closed: the row
stayed `open`, the position went to RECOVERY, and the retry re-issued the identical invalid statement
forever. The operator is flat at the broker while the backend insists otherwise — the worst disagreement
to carry into a restart.

**Now:** dotted keys are folded into one `jsonb_set` chain on the `legs` column. The path literal is
built from a digits-only index and a **whitelisted** field name (an unlisted field throws at the
boundary); the value always travels as a bound parameter. `null` becomes the JSON literal `'null'`,
because `jsonb_set(doc, path, SQL NULL)` returns **NULL for the whole document** and would erase all four
legs. A whole-array `legs` replacement in the same patch becomes the base of the chain rather than a
second, conflicting assignment.

### C4 — Session disarm was not authoritative at the POST boundary  ·  *unwanted orders*

`src/box/orderManager.ts`, `src/box/engine.ts`

Session authorisation was checked only at **admission**. Between admission and transmit an attempt sits
in the priority queue and behind broker pacing — a real window. Disarming in that window changed the
session record and nothing re-read it, so a one-attempt session the operator had explicitly stopped still
sent all four orders.

**Now:** a fail-closed, **entry-only** `entryAuthorizationBlockReason` hook runs at CHECKPOINT 5 — the
last instant before the HTTP POST. The engine wires it to the session: a no-op when sessions do not
enforce, a refusal when the session is no longer armed, and a refusal when it was re-armed under a new
`session_id`. It is deliberately **not** a budget re-check: an admitted attempt has legitimately spent
its allowance and must not reject itself for that.

Test `W6` pins the other half — the hook is never consulted for a reduction, so a disarmed session can
still get flat.

The audit's other C4 limb, `ZERODHA_LIVE_TRADING_ENABLED` being unenforced, was already closed on
`64214fd`: it now refuses to build the Zerodha adapter at all, and feeds `trading_ready`.

### H3 — The durable state machine refused real broker outcomes

`src/box/repository.ts`

`SUBMITTING` was not a predecessor of `CANCELLED`, `CANCEL_REQUESTED` or `PARTIALLY_FILLED`. But the
manager writes `SUBMITTING`, awaits the adapter's *entire* lifecycle (place, poll, possibly
protective-cancel), then persists the snapshot it gets back — with no obligation to have written an
interim label. So a legitimate outcome was refused, the intent stayed at `SUBMITTING` with a possibly-null
broker order id, and a cancelled leg carrying a **partial fill** had its attribution withheld — which is
what blocks the unwind of exactly the exposure that most needs unwinding.

**Now:** `SUBMITTING` is a valid predecessor of all three. A refused transition is not a safe no-op when
the broker has already acted.

### H6 — The recovery reserve was unusable, and 429 cooldowns were lost

`src/box/brokerPacing.ts`, `src/box/kiteBrokerAdapter.ts`

Two independent defects:

1. Reserve eligibility was inferred from the **broker's endpoint class**: only `order_cancel` and
   `order_modify` could spend it. But every new order is metered as `order_place`, *including* an EXIT and
   an emergency buyback that closes a naked short — so a protective placement was refused with reserved
   capacity sitting unused, at exactly the moment the reserve exists for.
2. `penalizeIfRateLimited` tested only `error instanceof KiteHttpError`. A rate-limited **placement** is
   wrapped in `BrokerAmbiguousSubmitError` (correctly — a 429'd POST may or may not exist at the broker),
   so the check missed the case that matters most. An HTTP 429 with `Retry-After: 30` produced no penalty
   and no cooldown, and the next request went straight back into a budget the broker had just told us to
   back off from.

**Now:** `check()` takes an explicit `protective` flag driven by the order's **risk purpose**
(`EXIT`/`EMERGENCY_RESIDUAL`/`PROTECTIVE_CANCEL`; an unknown purpose is treated as *not* protective, which
can only withhold the reserve). The reserve remains a reservation *within* the published cap, never an
extension of it. And `penalizeIfRateLimited` walks the error cause chain, so a 429 is honoured wherever
it was wrapped.

---

## 2. Tests

| File | Tests | Notes |
|---|---|---|
| `tests/box/residualFlattenHedgeCover.test.mjs` | **7** new | Drives the real `CentralBoxExecutionGateway` in live mode over the real `BoxOrderManager`; asserts on **what reached the adapter** |
| `tests/box/restartWorkingOrderReadiness.test.mjs` | **10** new | W1×4 states, W2 reduction not blocked, W3 own-legs control, W4 `CREATED` excluded, W5 disarm at POST boundary, W6 reduction exempt, W7 mid-reconcile fill |
| `tests/box/brokerRateBudget.test.mjs` | **+3** | Protective placement uses the reserve; `protective: false` still refused; still bounded by the account budget |
| `tests/pg/tradeClosePersistence.test.mjs` | **5** new | **CI only** — needs real PostgreSQL. The engine's exact dotted close payload, per-leg targeting, null-safety, retry idempotency, whitelist refusal |

### Negative controls

Every fix was reverted in the built output and the suite re-run, to prove the tests fail for the right
reason rather than passing by construction:

| Defect restored | Result |
|---|---|
| C1 hedge-cover gate removed | **5 of 7** fail — and the 2 that pass are correctly the shorts-closed control and the long-only case |
| C6 unattended counter zeroed | **5 of 9** fail — the 2 passing correctly assert zero |
| C2 stale rebuild applied unconditionally | **W7** fails |
| H6 reserve keyed on endpoint class only | tests 20 and 22 fail; 21 (the "must not become a bypass" control) correctly still passes |

### Suite state

| Suite | Local | CI (real PostgreSQL + MongoDB) |
|---|---|---|
| `test:unit` | 2211 / 0 fail | **2211 pass / 0 fail / 0 skipped** |
| `test:invariants` | 9 / 9 | **9 / 0 / 0** |
| `test:pg` | **NOT RUN** — no PostgreSQL | **80 pass / 0 fail / 0 skipped** (was 75) |
| `test:projector` | **NOT RUN** — no MongoDB | **17 / 0 / 0** |
| `test:tokens` | 59 / 32 fail — *environment* | **90 / 0 / 0** |
| `test:switch` | 0 / 32 fail — *environment* | **32 / 0 / 0** |
| `test:access` | 7 / 2 fail — *environment* | **31 / 0 / 0** |
| `test:shutdown` | 11 / 11 | **11 / 0 / 0** |
| `test:readiness` | 0 / 2 fail — *environment* | **24 / 0 / 0** |
| `test:contract` | 28 / 3 fail — *environment* | **59 / 0 / 0** |

Every *environment* failure is the sandbox, not the code (npm registry returns 403, so `node_modules` is
hollow); all match the pre-change baseline exactly. In CI: **2,564 tests, zero failures, zero skips**,
with the workflow's own *"Fail if any database suite skipped tests"* step green.

### CI caught a bad test fixture

The first push failed `test:pg` on **my own new test**: the retry-idempotency case asserted that a second
`closeBoxTrade` with the same key resolves to the closed row, and it returned `null`.

The cause was the **fixture, not the code**. `closeBoxTrade`'s retry fallback matches on the
`close_idempotency_key` *column*, and the engine writes that key as part of the close payload
(`engine.ts:3835`) — my payload omitted it, so I was testing a payload production never sends. Fixed by
making the fixture carry it exactly as the engine does, and strengthened so that a *different* key does
not resolve someone else's close (proving the key is what identifies the retry, not merely that the row
is closed).

Worth recording because it is the same lesson as C5 itself: a test that does not reproduce the real
payload proves nothing about the real path.

Typecheck: **zero new errors** (167 both with and without these changes, identical normalised sets). That
check earned its keep twice — it caught `BoxTradingSessionManager.enforcing()` being `private` and a
missing `BoxOrderPurpose` type import, both of which would have failed CI's job 2.

---

## 3. What was NOT fixed

Reported honestly rather than quietly dropped. None of these is closed by this work.

| # | Finding | Why deferred |
|---|---|---|
| **H1** (partial) | Owned-intent loading is not broker/account-scoped; a Zerodha re-login replaces the running token without checking exposure or requiring the same account | Needs an execution-session epoch threaded through intents, positions, fills and recovery. The *hedge* account key and `liveBrokerAccount()` were fixed in PR #23; the query scoping and login-time exposure check were not. |
| **H2** | Live/paper isolation protects the transport, not the durable position lifecycle: `loadOpenBoxTrades` / residual adoption are not mode-scoped, and the monitor picks paper-vs-live from the *process* mode rather than the position's | Requires mode/broker/account scoping on every management query plus a refusal at the monitor boundary. Real, and it means a paper process restarted against the same database can advance a live position's recovery records. |
| **H4** | STOP/restart can leave residual exposure without market-data subscriptions, so the flatten loop has no executable book | Needs subscription ownership to become the union of open positions, residuals, unresolved orders and in-flight executions, restored before recovery starts. |
| **H5** | Funding checks and trial limits still default **off** | `deploy/supervised-live-test.env.template` turns them all on and documents the traps, but the *defaults* are unchanged and the profile is not mandatory. |
| **H7** | Multiple workers are not safely excluded from managing the same exposure — the boot ordinal orders status responses, it is not an exclusive execution lease; reduction reservations and session serialization are process-local | Needs a durable leadership lease. **Mitigate operationally: run exactly one execution process.** |
| **M1** | Tick/lot metadata is lost on restore and residual reconstruction | Can send broker-invalid prices/quantities during recovery. |
| **M2** | Kite timestamps are parsed timezone-dependently; lifecycle deadlines use wall time | A backward clock correction can extend an order's working timeout. |
| **M3** | Quote thresholds need a strict, measured live-trial profile | The 250 ms exchange-dispersion trap is documented in the template; the thresholds themselves are unchanged. |
| **C4** limb 3 | `setLiveControl` does not apply the `evaluateLiveArm` preconditions it displays | An API/UI honesty gap, not an unguarded order path: every one of those conditions is independently re-checked by `entryBlockReason()` at order time. |
| — | The audit's request for **one** exposure-aware reduction planner shared by normal exits, immediate unwinds, periodic residual flattening and crash recovery | C1 fixes the specific path that could sell hedges. Unifying all four behind a single planner is the right architecture and remains outstanding. |

---

## 4. Verdict

### Still NO-GO for a real-money attempt on this revision.

Seven findings are fixed, negative-controlled and regression-tested, including all four that could
directly create naked short exposure or a reverse position. That is a material change from the audit
baseline. It is **not** sufficient.

**Why not GO:**

1. **H7 is unresolved and is a correctness precondition, not a nicety.** Two processes managing the same
   account can each pass their local quantity checks and cross through flat. Until there is an exclusive
   execution lease, single-process operation is an *operational* guarantee, not a *structural* one.
2. **H2 means a paper process can advance a live position's durable lifecycle.** C5's SQL failure was
   masking that; fixing C5 removes the accidental brake.
3. **H4 can leave recovery without the books it needs to act**, which is precisely when it must act.
4. **H1's remaining half** — unscoped owned-intent loading and a token swap that ignores open exposure —
   is exactly the class of defect this whole effort has been removing.
5. **No end-to-end fault test exists** across engine → manager → Kite adapter → PostgreSQL for process
   death after POST / ACK / fill / cancel-request / exit-fill-before-persistence. The audit asked for
   this explicitly and it is the gap that let C5 and C2 survive: passing adapter tests plus passing
   repository tests did not prove the composition works.

**A one-lot limit bounds the size of a mistake. It does not make an unresolved recovery path safe.** The
honest position is that the *known* naked-exposure routes are now closed and the remaining risk is
concentrated in multi-process safety, live/paper isolation, and untested crash composition.

### Before reconsidering

1. Close H7 (exclusive execution lease) and H2 (mode-scoped management), or accept them in writing with
   compensating operational controls.
2. Add the composed engine → manager → adapter → PostgreSQL fault tests, covering death after POST, ACK,
   fill, cancel-request, and exit-fill-before-persistence.
3. Prove every recovery sequence preserves hedge cover and cannot cross through flat — C1's tests do this
   for the periodic path only.
4. Close H4 so recovery always has an executable book.
5. Verify the intended account, current contract metadata, funding semantics and single-worker ownership
   on the real deployment.
6. Obtain a complete green run **including** deployment-profile checks.
