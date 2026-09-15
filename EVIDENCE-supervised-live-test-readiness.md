# Readiness for ONE supervised, one-lot Zerodha four-leg box attempt

**Reviewed baseline:** `544dd5577980969011d1a343121e4955975c248a` (GAR_B `main` at the time of review;
confirmed identical to the commit the findings were raised against).

**Scope of the target.** ONE four-leg Box **entry attempt**, one lot per leg, one underlying, under
continuous human supervision. That is four entry orders plus whatever protective cancel/unwind the
recovery path needs — **not** one HTTP order request. Every bound below is sized against the whole
attempt, because the attempt, not the request, is the unit of risk.

**Verdict: CONDITIONAL GO.** Conditions are listed in [§9](#9-verdict). Two P0 defects were
reproduced and fixed; twelve further gaps of the same class were found and fixed, three of them in
the fixes themselves ([§8](#8-review-round)). The remaining conditions are runtime evidence that only
the deployment can produce, plus one test gate that **cannot be run in this environment**
([§6](#6-what-is-not-proven-here)).

---

## 1. Confirmed defects, reproduced before fixing

### P0-1 — Turning off new orders silently turned off *getting flat*

```ts
canManageExposure(): boolean {
  return !this.disposed && this.controls.liveOrderEnabled;
}

async cancelWorkingBoxOrders(): Promise<BrokerOrder[]> {
  if (!this.canManageExposure()) return [];        // ← empty SUCCESS
  …
}
```

`box_live_order_enabled = false` — the obvious operator response to "stop trading" — disabled every
risk-**reduction** path at once: `cancelWorkingBoxOrders()` returned `[]`, and `submit()` refused
every `EXIT`, `PROTECTIVE_CANCEL` and `EMERGENCY_RESIDUAL`. The route published that as
`{ ok: true, orders: [] }` with **HTTP 200**. Reproduced with `emergencyFlatten = true`: no working
intents were loaded and no cancellation was attempted.

An empty array is also what a genuinely quiet account returns, so "swept clean" and "refused without
trying" were indistinguishable. A control meaning *do not take new exposure* must never remove the
ability to *shed* exposure already taken — those are opposite directions of risk.

### P0-2 — No live order knew which account placed it

```ts
private liveBrokerAccount(): string | null {
  return this.deps.marketData.isAuthenticated() ? null : null;   // both branches null
}
```

A ternary whose branches are identical, plus `account: null` hard-coded at both order-stream
ownership registrations. The order-update projection's `foreign_account` rejection could therefore
**never fire**, and attribution rested entirely on the per-order tag. Tag uniqueness is not account
ownership: after a re-login to a *different* account under the same API key, nothing structural
stopped the new session adopting, cancelling or flattening the previous account's exposure.

The identity was already in the process — `deps.brokerAccountRef` was wired in `src/index.ts` to the
Kite login's `user_id` for margin-evidence attribution. It simply never reached the order path.

---

## 2. Fixes

All line references are post-change.

| # | Fix | Files |
|---|---|---|
| 1 | `canManageExposure()` no longer consults `controls.liveOrderEnabled`. Replaced by `exposureReductionBlockReason()`, which blocks **only on genuine inability**: disposed, or `broker_auth === "unhealthy"`. | `src/box/orderManager.ts` |
| 2 | `cancelWorkingBoxOrders()` returns `CancelWorkingBoxOrdersResult` (`ok`, `attempted`, `blocked_reason`, `examined`, `eligible`, `cancelled`, `failures`) instead of a bare array. The route maps a refusal to **409** and a partial sweep to **207**, keeping the `orders` alias for compatibility. | `src/box/orderManager.ts`, `src/box/routes.ts` |
| 3 | `canEnter()` became a thin wrapper over `entryBlockReason()`; every precondition now returns a named reason. `submit()` reports `Entry cannot be sent: <reason>` and `Exposure reduction cannot be sent: <reason>` instead of a generic "controls or limits are closed". | `src/box/orderManager.ts` |
| 4 | Engine resolves the real account (`liveBrokerAccount()` → `deps.brokerAccountRef()`, trimmed) and wires it into both the `OrderStreamConsumer` and the order manager. | `src/box/engine.ts` |
| 5 | Every live intent is **stamped with the account before the broker POST**; both ownership registrations carry the intent's own account (never a live-session substitute); `accountConsistencyBlockReason()` refuses a mutation derived from a **provably foreign** row. | `src/box/orderManager.ts`, `src/box/types.ts`, `src/box/repository.ts` |
| 6 | Additive migration adding a **nullable** `broker_account` with **no backfill** — NULL means UNPROVEN. Added to `IMMUTABLE_INTENT_FIELDS`, so client-order-id reuse under a different account is refused. | `migrations/011_order_intent_broker_account.sql`, `src/box/repository.ts` |
| 7 | **Whole-attempt quantity envelope.** `entryQuantityEnvelopeBlockReason()` checks `gross + reserved + 4 × lot` on the attempt's **first** leg. | `src/box/orderManager.ts` |
| 8 | `ZERODHA_LIVE_TRADING_ENABLED` is now **enforced** — `createLiveAdapter` refuses to build the Zerodha adapter unless armed — and feeds `trading_ready`. Default FALSE. | `src/brokers/registry.ts` |
| 9 | Stale `trading_ready` and static-IP claims corrected. | `src/brokers/registry.ts`, `src/index.ts` |
| 10 | `POST /api/box/session/arm` now accepts and forwards `max_entry_attempts` (previously parsed and silently dropped); `sessionMaxEntryAttempts` added to the effective-config provenance table. | `src/box/routes.ts`, `src/box/effectiveConfig.ts` |
| 11 | `brokerAccountKey()` returns the real account when nameable, so the hedge ledger's "coverage is not fungible across accounts" axis is no longer degenerate. | `src/box/orderManager.ts` |
| 12 | `unverifiedAccountCount` counts owned order-update events accepted **without** a verifiable account, so a zero `foreignAccount` tally is not mistaken for "the check was enforced". | `src/box/orderUpdateProjection.ts` |
| 13 | The `POST /api/box/live/control` response now **forwards the exposure report** (`open_positions`, `residual_legs`, `working_orders`, `consequence`, `reduction_available`, `reduction_blocked_reason`). The engine computed it; the route was discarding it and answering a bare `{ ok: true }` — the same silent-success shape this work removes elsewhere. | `src/box/routes.ts` |
| 14 | The hedge `account_mismatch` reason **no longer interpolates account ids**. That string is persisted into the intent's transition note and audit JSONB and copied verbatim into the Mongo projection payload, so once the account provider became real it would have written the raw Kite `user_id` into a durable, replicated record — while every other surface masks that identifier. | `src/box/hedgeCoverageLedger.ts` |

### A defect of the same class, introduced by the fix and caught in review

The first version of fix 1 refused **all** exposure reduction when the session could not name its
broker account, reasoning that a mutation must be attributable. That was the original defect in a
different costume: a condition unrelated to our ability to shed risk was again allowed to disable
every cancel, exit and flatten at once.

It was reachable with a completely healthy trading session. `liveBrokerAccount()` requires
`marketData.isAuthenticated()` — a **market-data** property. On Dhan, `DHAN_DATA_ENABLED=false` makes
it false on its own; on Zerodha, a stored-session adoption can null the session metadata while leaving
the access token live. In both cases the broker would still have accepted a cancel while we refused to
send one.

**Corrected.** Reduction no longer consults the session account at all. Ownership of a reduction is
proven by **attribution** — a reduction may only trade against an attributed position, on the
reducing side, and may not overshoot it — and, for anything derived from a durable row, by the account
recorded **on that row**. Neither requires the session to introduce itself. New **entry** remains
hard-blocked when the account cannot be named, because refusing to take new risk is always safe. Test
`D2` pins both halves of that asymmetry.

`accountConsistencyBlockReason()` was corrected in the same direction: it now blocks **only on
positive proof of foreignness** (both accounts known and different). An unnameable current account or
an unproven pre-migration row no longer blocks a cancel. For exposure-*reducing* operations the two
error directions are not symmetric — a refused cancel guarantees the exposure stays, while an
attempted cancel of a genuinely foreign order cannot succeed anyway, because the broker scopes
cancellation-by-order-id to the authenticated account.

### Other design decisions worth stating explicitly

**Reduction is blocked by `broker_auth === "unhealthy"`, not `!== "healthy"`.** `broker_auth` starts
`"unknown"` and only becomes healthy after a successful reconcile. Blocking on `!== "healthy"` would
disable the panic button at boot and immediately after every restart — the same failure again.

**The reduction guard has no side effects.** An early version called `rollTradingDay()` from it, which
resets the daily P&L, reject and failure counters, clears `reconciliation_complete` and starts an
async seed load. Since the guard runs on every reduction submit, dequeue re-check and cancel sweep,
the first cancel after IST midnight would have performed all of that from inside a synchronous
"may I reduce?" question. The roll stays on the entry path and the periodic reconciliation.

**The hedge-coverage account key is frozen per attempt.** Coverage compares the account on a
requirement (stamped *before* a hedge posts) with the account on its evidence (stamped *after*).
Reading it live at both moments meant an identity change inside that window produced
`account_mismatch` and refused the dependent uncovered SELLs *after* the hedge BUYs had filled —
stranding exposure. The key is now captured once, on the attempt's transport gate. Two different
attempts still cannot share coverage, which is the property that matters.

**Unproven never becomes fabricated.** Both order-stream registrations pass `intent.broker_account ??
null` and never fall back to the live session. Stamping a pre-migration row with the currently
signed-in account would fabricate the attribution migration 011 refuses to backfill — and would make
the projection reject a frame naming the real account as `foreign_account`, **discarding an owned
fill**. Test `B5b` pins it.

**An absent account *provider* is not the same as a provider returning null.** Absent means
pre-binding construction (paper, fixtures) and does not block. Wired-and-returning-null means a live
deployment that cannot name its own account, and **does** block. The engine always wires it in live
mode, so production always gets the strict behaviour.

### The quantity envelope, and the bug found while building it

The gross cap was previously checked **incrementally per leg**. With
`BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=200` and a 75-unit lot, legs 1 and 2 pass (75, 150) and leg 3
is refused at 225 — after the hedge legs have already reached the broker and possibly filled. A
configuration mistake became live exposure that then had to be unwound.

The first implementation of the whole-attempt check re-asked the envelope question on *every* entry
leg, which double-counted the attempt's own committed legs into a false refusal — stranding the
attempt in precisely the state the check existed to prevent. Test `C1-negative` caught it.

The envelope is therefore asked **once per attempt**, keyed on whether any leg of that attempt has
**reached the broker** (`postedEntryAttempts`); later legs use the incremental check. The second
version of this bookkeeping keyed on the *reservation* instead, taken in `submit()` before the queue —
but a queued leg can still be refused at the dequeue re-check, and that path releases the reservation
and leaves no exposure behind. Marking the attempt there meant a retry under the same attempt id
skipped the envelope entirely and posted its first leg under the weaker incremental check, silently
disabling the protection. Only a POSTed leg can create something for the envelope to double-count, so
that is what it now keys on. The restart reconstruction path marks recovered attempts too — a durable
non-terminal intent is proof its leg reached the broker — so recovered legs are not refused.

**Both fallbacks are exactly the pre-change incremental check**, so no path is weaker than the
baseline; the first-leg branch is strictly stronger.

---

## 3. Tests

New: **`tests/box/liveExposureControlAndAccount.test.mjs`** — 26 tests driving the real
`BoxOrderManager` and real `BoxEngine` with fake transport/persistence boundaries.

| Group | Covers |
|---|---|
| A1–A6 | Reduction survives `liveOrderEnabled=false`; refusal carries a reason; entry restrictions never reach a reduction; ownership still mandatory |
| B1–B8b | Account stamped pre-POST; missing identity blocks new entry with a specific reason; token refresh preserves attribution; a **provably foreign** row refused; an **unproven** row still cancellable (B5) but never stamped with the live account (B5b); account reaches the stream registration; engine resolves it; masked in diagnostics and never emitted raw |
| C1–C6 | Four-leg envelope refused before any leg posts; shipped defaults admit NIFTY/BANKNIFTY and refuse a 500-lot; held and reserved exposure counted; governs the real `submit()` path; **never** applied to a reduction |
| D1–D2 | The control response reports the exposure it leaves behind; an unnameable session account does **not** disable reduction, while still blocking new entry |

`tests/invariants/exitImmunityProtectiveCancel.test.mjs` test 3 was **rewritten**. It had asserted
that "the single legitimate way to stop a protective cancel is to disable exposure management
entirely (`box_live_order_enabled=false`)" — i.e. it encoded the defect as a guarantee. The
non-vacuous positive/negative structure was preserved, with a confirmed unauthenticated session as
the negative case.

Three Zerodha arming tests were added and one rewritten in `tests/box/singleBroker.test.mjs`; the old
test asserted `trading_ready === true` with the arming switch off.

### Negative controls

Each fix was reverted in the built output and the suite re-run, to prove the tests fail for the right
reason:

| Defect restored | Result |
|---|---|
| Reduction re-gated on `liveOrderEnabled` | **A1 and A4** fail |
| Account binding removed | **3** fail (B4, B5, B7) |
| Engine `liveBrokerAccount()` defect | **B8** fails |
| Whole-attempt envelope branch disabled | **C1 and C5** fail |
| Stream registration fabricates the live account | **B5b** fails |

### Suite state

| Suite | Result |
|---|---|
| `test:unit` (`tests/box`) | **2191 pass / 0 fail** |
| `test:invariants` | **9 / 9** |
| `test:shutdown` | **11 / 11** |
| `test:tokens` | 59 pass / 32 fail — *environment* |
| `test:access` | 7 pass / 2 fail — *environment* |
| `test:switch` | 0 pass / 32 fail — *environment* |
| `test:readiness` | 0 pass / 2 fail — *environment* |
| `test:contract` | 28 pass / 3 fail — *environment* |
| `test:pg`, `test:projector` | **NOT RUN** — see [§6](#6-what-is-not-proven-here) |

Every failure marked *environment* is the sandbox, not the code: the npm registry returns **403**, so
`node_modules` is hollow. `switch`/`tokens` failures are the suites' own guards reporting no reachable
PostgreSQL; `access`/`readiness`/`contract` failures are a missing `express`. These counts match the
pre-change baseline exactly. **CI is the authority for all of them.**

Typecheck: 58 errors both with and without these changes — identical normalised error sets, **0 new,
0 masked**. All 58 are pre-existing artifacts of the local `pg`/`express`/`mongodb` shims.

Contract digest **unchanged** (`a0a89b20e3a33bcffa0ef549e5ec9feec01224c7fc35cca49550572231462415`).
No `contract/` file was touched and no version bump is required: the cancel-working response gained
fields additively and kept its `orders` alias, and the new projection counter is diagnostic-only with
no wire path.

---

## 4. Migration

`migrations/011_order_intent_broker_account.sql` — additive and idempotent:

* `ADD COLUMN IF NOT EXISTS broker_account TEXT` (**nullable**)
* a `COMMENT` recording that NULL means *unproven*, not *ours*
* a partial index `box_order_intents_live_account_idx` for live-account lookups

**No backfill, deliberately.** Assigning historical intents to the current account would fabricate
exactly the attribution the column exists to prove. Pre-migration rows read as UNPROVEN, and
`accountConsistencyBlockReason()` refuses to act on them — which is the correct, conservative
outcome for an order this deployment cannot prove it placed.

---

## 5. Configuration

New template: **`deploy/supervised-live-test.env.template`**. It is a template, not a deployment
artifact — the production `.env` was not touched, and `BOX_EXECUTION_MODE=live` is left **commented
out**, so applying the file as-is cannot place an order.

### Changes from the last posted production configuration

| Setting | Was | Template | Why |
|---|---|---|---|
| `BOX_SESSION_MAX_ENTRY_ATTEMPTS` | unset ⇒ **0 = unlimited** | `1` | Bounds risk-taking. A cycle is consumed only when a Box is *established*, so an unlimited attempt ceiling let a "one trade" trial submit orders indefinitely. |
| `BOX_SESSION_MAX_COMPLETED_TRADES` | — | `1` | Bounds success. |
| `BOX_LIVE_MAX_OPEN_BOXES` | — | `1` | ⚠ `0` means **never open** (guard is `>=`), not unlimited. |
| `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING` | `false` | `true` | The only limit that counts partial, residual, recovering and in-flight exposure. |
| `BOX_LIVE_MAX_RESIDUAL_LEGS` | `1` (default) | `0` | ⚠ comparison is strictly `>`, so `1` **tolerates** one unresolved residual leg. |
| `BOX_LIVE_MAX_OPEN_LEG_QUANTITY` | `100` | `75` (one NIFTY lot) | Set to the selected instrument's lot — **not** raised globally. |
| `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY` | `400` | `300` (= 4 × 75) | Must be ≥ 4 × lot or the attempt is impossible. |
| `BOX_LIVE_REQUIRE_FUNDS_COVER` | `false` | `true` | Missing/stale evidence must refuse. |
| `BOX_LIVE_REQUIRE_MARGIN_EVIDENCE` | `false` | `true` | — |
| `BOX_LIVE_REQUIRE_STAGE_FUNDING` | `false` | `true` | **Not redundant.** Zerodha's basket total is the *final*, post-spread-benefit figure — their own example shows initial ₹96,504.98 vs final ₹34,786.73. Margin evidence alone can be satisfied by under a third of the real legging requirement. |
| `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` | **0 = disabled** | `100000` (edit) | ⚠ `0` disables the cap at all three enforcement sites. |
| `BOX_LIVE_RECOVERY_RESERVE_RUPEES` | **0** | `25000` (edit) | ⚠ `0` holds nothing back to fund the cancel/unwind that recovers the entry. Produces only an advisory string, never a refusal. |
| `ZERODHA_LIVE_TRADING_ENABLED` | unenforced | `false` until the window | Now a real gate. |
| Market data | 15000 / 5000 / 250 / 500 | **unchanged** | The market-data posture must not differ between the paper run that built confidence and the live attempt. |

### Two configuration traps the template documents

**Silent unlimited.** The integer loader turns an unparseable, blank or negative value into the
default **without warning**, and the default for both session ceilings is `0 = unlimited`. So
`BOX_SESSION_MAX_ENTRY_ATTEMPTS=one` and `=-1` both mean *unlimited attempts*. Verify with
`node dist/box/effectiveConfig.js`, never by eye.

**Ceilings are snapshotted at arm.** Both session ceilings are copied into the session row when it is
armed. Editing the environment and restarting does **not** retroactively bind an already-armed
session — it keeps whatever it was armed with, possibly `0`. Arm a fresh session after the
environment is in place, or pass both ceilings to `POST /api/box/session/arm`, then confirm
`max_entry_attempts: 1` and `remaining_entry_attempts: 1` on the status endpoint. **This is the most
likely way to believe the one-attempt bound is in force while it is not.**

**Exchange-dispersion precision trap.** `250 ms` is preserved from the running deployment, but Kite's
order-book timestamp is whole-**second** granular, so a limit below `1000 ms` can reject four
genuinely coherent books on quantisation alone. The error direction is safe (it refuses entries, it
never admits an incoherent one) but it may mean the attempt is **never admitted**. If refusals cite
`cross_leg_time_skew`, that is the knob; `1000` is the documented Zerodha-appropriate value. Decide
before the window, not during it.

---

## 6. What is NOT proven here

### The PostgreSQL gate is BLOCKED locally

`test:pg` and `test:projector` — the real-PostgreSQL and Mongo suites that exercise **crash recovery,
restart reconciliation and durable session-budget behaviour** — **could not be run in this
environment**. There is no reachable PostgreSQL and the npm registry is unavailable, so `pg` itself is
not installed.

Accordingly, and explicitly: **crash recovery is NOT marked verified, and this work is NOT called
live-ready on the strength of local testing.** The reasoning about durability in this document is
*source-level verification* — the write ordering, the fail-closed rollback, the serialized critical
section, the boot reload — and source reading is not a substitute for executing the suites.

CI **does** run both against real PostgreSQL and MongoDB, and job 3 includes a *"Fail if any database
suite skipped tests (no silent skips)"* step. **CI passing is a precondition of the verdict below.**

### Verified by source reading only, not by execution here

* Session attempt budget durability, serialization, fail-closed rollback and boot reload.
* Restart classification of a durable non-terminal intent unknown to the broker (breaker trip +
  `recoveryActive`).
* Crash-recovery quarantine set/clear behaviour.

### Runtime evidence only the deployment can produce

1. **Account identity present.** `identity.account_present: true` and a non-null `account_masked`.
   Some Zerodha session-adoption paths leave the session metadata unset, in which case live entry is
   refused as *"the broker account could not be identified"*. That is fail-closed and correct, but it
   will **look like an authentication fault** — diagnose it as an account-identity problem and
   re-login through the in-app flow.
2. **Migration 011 applied.** Live order persistence fails without the `broker_account` column.
3. **Market data READY with `ticks_observed: true`** — a connected socket is not evidence of ticks.
4. **`reconciliation_complete: true`**, zero unknown orders, breaker closed, no residual legs.
5. **Funding gates actually satisfied against the live account** — the gates are armed, but only a
   real broker read can show they *pass*.
6. **Static IP confirmed out-of-band.** `static_ip_configured` is `null` for Zerodha, meaning **not
   modelled** — it does not mean not required. `docs/BROKER_ADAPTER_AUDIT.md` findings 1.1/1.2 record
   that the SEBI mandate applies to Zerodha and that gap 5.1 (no Zerodha static-IP gate) is **OPEN**.

### Known remaining gaps, not fixed

| Gap | Assessment |
|---|---|
| `foreign_account` is **fail-open** when an order-update frame carries no account. Kite's parser reads `user_id`, but whether every production postback includes it cannot be settled from source. | Fail-open is the **safer** direction here: dropping a fill we do own would leave real exposure unobserved. Now **counted** (`unverifiedAccount`) so the blind spot is visible rather than silent. REST observations always carry an account and are fully guarded. |
| `evaluateLiveArm()` is advisory; `setLiveControl` does not consult it. Same for `instance_epoch_unknown` and `migrations_pending`. | An API/UI honesty gap, **not** an unguarded order path: every one of those conditions is independently re-checked by `entryBlockReason()` at order time. |
| `market_data.authenticated` reflects **local token presence**, not a broker-verified session. | Misleading field name; the real gates are elsewhere. |
| `market_data.usable_books` is documented as "instruments with a currently usable executable book" but implemented as a raw store count. | Possible over-claim; not verified either way. |
| One attempt bounds ~4 entry legs plus an uncounted number of protective/recovery orders. | Deliberate: refusing to reduce exposure is never the safer failure. |

---

## 7. Deployment order

Nothing here was deployed. The intended order:

1. Merge to `main` with CI green, **including** the real-PostgreSQL suites and the no-silent-skips step.
2. Apply **migration 011** before deploying the new build. The build stamps `broker_account` on every
   live intent and will fail to persist without the column.
3. Deploy the build with `BOX_EXECUTION_MODE=paper_latency` and all three live switches **off**.
4. Confirm the effective configuration with `node dist/box/effectiveConfig.js`.
5. Work the pre-attempt checklist in the template (§10 of that file).
6. **Arm a fresh session** with both ceilings and verify them on the status endpoint.
7. Only then, with an operator watching and the abort procedure open, arm the three live switches.
8. Revert to `paper_latency` immediately afterwards.

**Abort path.** Exposure reduction is independent of the entry controls — turning entry off does not
disable getting flat, which was the P0-1 inversion and is now regression-tested. Escalate: disarm the
session → `box_entry_enabled=false` → cancel working orders (409 on refusal with a reason, 207 on a
partial sweep with per-order failures; it can no longer report an empty success) → exit/flatten →
revert the mode and restart.

---

## 8. Review round

This change was reviewed behaviourally before being pushed, and the review returned
**NEEDS_CHANGES** with three blocking findings. All three were real, and all three were the *same
class of defect as the ones being fixed* — a condition unrelated to shedding risk being allowed to
disable it, or a silent success hiding a refusal:

1. **Reduction gated on a market-data-derived identity** — fixed by removing the session-account
   condition from the reduction guard entirely (see §2), and by narrowing
   `accountConsistencyBlockReason()` to block only on proof of foreignness.
2. **The exposure report was computed and then discarded by the route** — fixed, and now pinned by
   test `D1`, which is why nothing caught it the first time.
3. **The stream registration fabricated an account for pre-migration rows**, which could cause an
   owned fill to be discarded as `foreign_account` — fixed, pinned by `B5b`.

Four non-blocking findings were also fixed: the envelope's admission bookkeeping (keyed on the POST
rather than the reservation), the hedge-coverage account key (frozen per attempt), the
`rollTradingDay()` side effect inside the reduction guard, and a raw account id reaching the durable
audit through the hedge `account_mismatch` reason. One test whose name contradicted its body was
renamed.

Worth recording plainly: **three of the seven fixes in this round were repairs to my own fixes.** The
value was not in the individual catches but in the pattern — the defect class this work exists to
remove is easy to reintroduce while removing it, because "be strict about attribution" and "never
strand exposure" pull in opposite directions and only one of them is safe to get wrong.

---

## 9. Verdict

### CONDITIONAL GO for one supervised box attempt

The two P0 defects that made a supervised live attempt indefensible are fixed, negative-controlled
and regression-tested, and five further defects of the same class — an unenforced per-broker kill
switch, a `trading_ready` that meant only "a token exists", a silently-dropped attempt ceiling, an
unauditable ceiling, and a degenerate hedge-coverage account axis — were found and fixed along the
way. The submission safeguards the attempt depends on (write-ahead durable intent, deterministic
client order id under a global unique index, no blind retry of an ambiguous submission, genuinely
hedge-first ordering with positive proof of hedge coverage before any dependent SELL) were verified
to hold as claimed.

**It is not an unconditional GO, for one reason above all:** the real-PostgreSQL crash-recovery and
restart-reconciliation suites **could not be executed here**. Their behaviour is argued from source,
and that is not the same as having run them.

Proceed only when **all** of the following hold:

1. **CI is green on the merge commit** — all six checks, including *"3. Tests (real PostgreSQL +
   MongoDB)"* and its no-silent-skips step. This is what discharges the blocked gate in §6.
2. **Migration 011 is applied** before the new build serves live traffic.
3. All six items of runtime evidence in §6 are observed on the deployment — in particular a **present,
   masked account identity**, which is now load-bearing rather than cosmetic.
4. **A fresh session is armed** with `max_entry_attempts: 1` and `max_completed_trades: 1`, and both
   are **confirmed on the status endpoint** rather than inferred from the environment file.
5. Per-leg and gross quantities are set to the **selected instrument's** one-lot values, with gross
   ≥ 4 × lot.
6. The capital cap and recovery reserve are **non-zero**.
7. A human is watching, with the abort procedure to hand.

If any of 1–7 cannot be shown, the answer is **NO-GO** — not because a specific defect is known to
remain, but because the bound would rest on an assumption rather than on evidence, which is the
failure mode this entire review was about.
