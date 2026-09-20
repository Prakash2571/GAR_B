# Bounded one-lot trial — controls, runbook, and Gate B checklist

**Written 2026-09-13.** For a **later, separately authorised** trial. Nothing in this document
authorises real-money trading, and following it does not make the system safe — it makes the trial
**bounded and observable**.

> **This runbook does not claim the trial will succeed, or that execution is safe.** It bounds the
> loss, makes the state observable, and defines when to stop. Residual risks are in §7 and are not
> hypothetical.

---

## 1. What is enforced in code, and what is only documented

The distinction matters more than the list. A control that is "documented" is a control an operator
must remember under pressure.

| Control | Enforced in code? | Mechanism |
|---|---|---|
| Broker / account scope | **Yes** | Active broker owns the token namespace; a switch invalidates every book and drops sessions. Evidence identity (`broker`, masked account, session generation) is checked **before and after** every async broker read. |
| Allowed instrument scope | **Yes** | Candidate admission validates exchange identity, lot size, tick size and expiry per leg, **and** `BOX_LIVE_ALLOWED_UNDERLYINGS` is a live ENTRY allow-list of specific underlyings. Evaluated in `engine.ts` (`allowlistEntryRefusal`, `underlyingExclusions.ts`) **before** the operator blocklist, and it fails **closed**: a name that is not on a non-empty list cannot be entered. An **empty** list means "no identity constraint", so scoping the trial requires actually setting it. ENTRY-only by design — removing a name mid-session keeps every exit, reduction and reconciliation route for exposure already owned. |
| Maximum lot size | **Yes** | One lot per leg (`quantity: candidate.lot_size`); `live_max_open_leg_quantity` / `live_max_gross_open_leg_quantity` cap open quantity. |
| **Maximum entry attempts (counting failed/recovered)** | **Yes — new** | `BOX_SESSION_MAX_ENTRY_ATTEMPTS`. Consumed at **admission, before any broker POST**, so an attempt that submits and is then unwound still spends it. Durable, so a restart does not reset it. |
| Maximum completed trades | **Yes** | `BOX_SESSION_MAX_COMPLETED_TRADES`. Consumed at **establishment**. |
| Maximum concurrent intent | **Yes** | `BOX_MAX_CONCURRENT_EXECUTIONS`, `BOX_MAX_CONCURRENT_PER_UNDERLYING`, `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING`; plus the in-process **and** durable PostgreSQL reservation tiers. |
| Maximum unresolved exposure | **Partly** | Residual legs are tracked durably and block re-entry. **Corrected:** this row used to say "via readiness blockers". A readiness blocker is a **report, not a control** — publishing one refuses nothing. What actually refuses is the coordinator's admission prologue (`BOX_MAX_OPEN_BOXES` counts unresolved residual attempts; `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING` Layer 1a counts residual legs) plus the order manager's `entryBlockReason` at the send boundary. Verify the mechanism, not the banner — see §1.1. **No single configurable rupee ceiling on unresolved exposure** — see gap 1b. |
| **Unowned broker exposure after a crash** | **Yes — new** | Box legs confirmed at the broker that **no** open trade and **no** residual row accounts for — a fill that landed before the process could record it. Enforced in the coordinator's admission prologue (`unowned_attributed_exposure`), **before** the attempt budget, any reservation and any broker POST, on **every** underlying. Previously this condition was only *reported* by readiness and nothing consulted it, so a new box POSTed four more live orders on top of it. Operator-in-the-loop to clear: verify at the broker, then emergency-flatten or reconcile. `tests/box/orphanedExposureEntryGate.test.mjs` |
| Maximum order submissions | **Partly** | Bounded indirectly by the attempt budget (4 legs/attempt) and by the rate-limit ledger. **No independent submission counter** — see gap 1c. |
| Recovery duration | **Partly** | Bounded retry/backoff on the reconciliation sweep; ack/working/partial/cancel timeouts bound each order. **No global "give up and escalate after N minutes"** — see gap 1d. |
| Capital / loss budget | **Yes — entry only** | `BOX_LIVE_DAILY_LOSS_LIMIT` (default **₹5,000**) halts NEW ENTRY. Enforcement is **indirect**: `evaluateLimits()` is its only consumer and it trips the **sticky** circuit breaker, which `entryBlockReason` then refuses on at all five entry checkpoints. The figure is reconstructed at boot from **durable** state (`box_trades` + `box_execution_attempts`), so it **survives a restart**; an **incomplete** reconstruction refuses entry rather than trusting an understated loss. It **never** blocks an exit, protective cancel or reconciliation. Proven end to end by `tests/box/dailyLossLimitEntryBrake.test.mjs` (previously untested — this row used to say "observability, not a brake"). **Two caveats:** `BOX_LIVE_DAILY_LOSS_LIMIT=0` means the gate is **DISABLED**, not "no loss allowed"; and the limit is a frozen copy in the manager's limits, so tightening it while armed needs a limits-republish path to take effect. |
| Kill switch | **Yes** | `emergencyFlatten` reduces exposure and is never queued behind another control; entry blockers cannot disable risk reduction (`tests/invariants/exitImmunityProtectiveCancel.test.mjs`). |
| **Failure AFTER four confirmed fills** | **Yes — new** | A `qualify` throw or a failed position insert no longer discards the fill. The exposure is **retained** (never unwound on an absent economic verdict), ownership is **not released**, it is reconstructed as `residual_exposure`, new entry is **blocked** via the breaker, and it is labelled `FILLED_EXPOSURE_UNRECORDED` with alert reason `filled_exposure_unrecorded`. Durable persistence is fire-and-forget, so the message says it **could not be confirmed** rather than claiming the exposure was saved. **Manual step:** the candidate key stays reserved until restart. `tests/box/postFillFailureRetention.test.mjs` |
| **Proven zero-fill EXIT rejection** | **Yes — new** | A broker rejection whose snapshot passes `verifyZeroBrokerExposure` is reported as a failed reduction with the broker's reason and the still-open quantity. It no longer invents uncertainty, trips the breaker or moves the whole position to RECOVERY; the leg's quantity stays known and its hedge stays on. Contradicted/ambiguous rejections and persistence failures still quarantine. `tests/box/exitProvenZeroFillRejection.test.mjs` |
| Preconditions before entry | **Yes** | The single authoritative readiness decision; the server revalidates **every** entry request independently of any UI. |
| Restart does not reset budgets | **Yes** | Cycle **and** attempt budgets are durable in PostgreSQL; an unreadable session refuses entry rather than assuming a clean slate. |

### 1.1 A readiness blocker is a STATEMENT, not a control

**Read this before trusting any row above, and before trusting any banner during the trial.**

`operational_readiness` is a **report**. It renders banners and sets fields. Publishing a blocker —
even an `scope: "entry"` one — **refuses nothing by itself.** Something on the actual admission path
has to read it.

This is not a hypothetical distinction. It shipped:

- `unowned_attributed_exposure` was published correctly for months and **nothing consulted it**. With
  four broker-confirmed legs that no record owned, a brand-new candidate still passed every admission
  gate and POSTed four more live orders. Measured at commit `2b14729`:
  `k1_ce BUY 75`, `k2_pe BUY 75`, `k2_ce SELL 75`, `k1_pe SELL 75`.
- This runbook's own "Maximum unresolved exposure" row said re-entry was blocked "via readiness
  blockers". It is not, and never was — it is blocked by `BOX_MAX_OPEN_BOXES` and the Layer 1a
  underlying lock in the coordinator prologue.

**The three places a NEW live box can actually be refused**, in the order they run:

1. **`CoordinatedBoxExecutionGateway.coordinateEntry()`'s synchronous prologue** — the duplicate
   guard, `unowned_attributed_exposure`, the session cycle budget, the operator blocklist, the live
   per-leg/gross quantity caps, the Layer 1a underlying lock, `BOX_MAX_OPEN_BOXES`, the per-underlying
   budget. Everything here refuses **before** `claim()`, **before** the attempt budget is consumed,
   **before** any reservation and long before any POST. `BOX_EXECUTION_COORDINATOR_ENABLED=false` is
   rejected at boot in live, so this prologue cannot be bypassed on a live deployment.
2. **`sessionConsumeAttempt()` and the reservation acquisition** — still pre-POST, but an attempt is
   spent here, so a refusal at this point costs the trial its budget.
3. **`BoxOrderManager.submit()` / `execute()`** — the per-leg send boundary: `entryBlockReason`, the
   quantity envelope, the circuit breaker, the durable CREATED→SUBMITTING compare-and-set.

**So when a banner tells you entry is blocked, the correct question is "which of those three
refused?", not "the banner says we are safe".** When in doubt, the honest test is the one the
regression suites use: assert that **no order reached the broker**.

### Known gaps in the control set

| # | Gap | Consequence for the trial |
|---|---|---|
| 1a | ~~No underlying allow-list~~ — **CLOSED.** `BOX_LIVE_ALLOWED_UNDERLYINGS` now exists and is enforced as an ENTRY gate. | Still scope the trial by setting it explicitly to the **one** underlying you intend to trade, and verify the deployed value in the read-only checklist (§4 step 6). An **empty** list is not a scoped trial — it means no identity constraint at all. |
| 1b | No rupee ceiling on unresolved exposure | The **manual** stop condition in §6 is the control. Watch `residual_legs`. |
| 1c | No independent submission counter | With 4 legs/attempt, `MAX_ENTRY_ATTEMPTS × 4` is the practical submission ceiling. Recovery/unwind orders are **additional and not counted**. |
| 1d | No global recovery deadline | The manual escalation procedure in §6 is the control. |

---

## 2. Supported live configuration for a bounded trial

```bash
# ── Execution mode ───────────────────────────────────────────────────────────
BOX_EXECUTION_MODE=live
BOX_LIVE_TRADING_ENABLED=true          # plus the runtime ENTRY control must be armed

# ── THE TRIAL BOUNDS: ONE LOT, ONE BOX, ONE ATTEMPT ──────────────────────────
#
# CORRECTED. This block previously read BOX_SESSION_MAX_ENTRY_ATTEMPTS=3, which is not a one-attempt
# trial: three attempts is up to TWELVE live orders, and each attempt that partially fills and is
# unwound takes real exposure and pays real charges. If three attempts are genuinely wanted, that is a
# different, separately authorised test — say so explicitly rather than letting a "one-lot trial"
# quietly permit it.
BOX_SUPERVISED_ONE_LOT_TRIAL=true      # REFUSES BOOT unless all four below are exactly 1
BOX_MAX_OPEN_BOXES=1                   # mode-independent inventory ceiling. Code default 0 = UNLIMITED
BOX_LIVE_MAX_OPEN_BOXES=1              # live-only ceiling at the send boundary
BOX_SESSION_MAX_COMPLETED_TRADES=1     # one completed box — still refuses AFTER it closes
BOX_SESSION_MAX_ENTRY_ATTEMPTS=1       # one attempt, counted at ADMISSION, incl. one that aborts
#
#   ALL FOUR ARE REQUIRED, and they are not redundant — each is blind to a case the others catch:
#     BOX_MAX_OPEN_BOXES               counts in-flight entry claims, so it is the only gate that can
#                                      refuse two entries admitted in the same instant; the only
#                                      mode-independent one, so the only one a PAPER rehearsal
#                                      exercises at all.
#     BOX_LIVE_MAX_OPEN_BOXES          live-only, read from a post-position count.
#     BOX_SESSION_MAX_COMPLETED_TRADES counts CONSUMED cycles, so it keeps refusing once the first box
#                                      CLOSES — when inventory is back to 0 and both ceilings admit.
#     BOX_SESSION_MAX_ENTRY_ATTEMPTS   the ONLY bound on an attempt that ABORTED. It completes no
#                                      cycle and leaves no inventory, so nothing else counts it.
#
#   Three of the four default to 0 = UNLIMITED, so omitting one is not a narrower trial — it is an
#   unbounded one. BOX_SUPERVISED_ONE_LOT_TRIAL=true makes that a BOOT FAILURE instead of a surprise.
#   Verify: node dist/box/effectiveConfig.js --supervised-trial --lot-size=L   (Gate B step 21, §4.1)

BOX_MAX_CONCURRENT_EXECUTIONS=1
BOX_MAX_CONCURRENT_PER_UNDERLYING=1
BOX_ONE_ACTIVE_BOX_PER_UNDERLYING=true

# ── Economic admission: ALL THREE, or the strictness is partly cosmetic ───────
BOX_LIVE_REQUIRE_MARGIN_EVIDENCE=true
BOX_LIVE_REQUIRE_STAGE_FUNDING=true
BOX_LIVE_REQUIRE_FUNDS_COVER=true      # implied by stage funding, but set it explicitly
# BOX_LIVE_RECOVERY_RESERVE_RUPEES=  # set a real rupee figure; a placeholder is NaN and now refuses at boot

# ── The ₹ ceiling on ONE box: REQUIRED in live, refused at boot if absent ─────
BOX_LIVE_MAX_BOX_CAPITAL_RUPEES=100000 # EDIT: the most a single box may commit
#   Unset and 0 both mean "no ceiling", so neither is accepted while the mode is live. The two
#   quantity ceilings are not a substitute: they bound LOTS, and a box can satisfy both while
#   committing an arbitrary rupee amount, because notional is price × quantity.

# ── Order streams: observe fills on the fast path ────────────────────────────
DHAN_ORDER_STREAM_ENABLED=true         # or ZERODHA_ORDER_STREAM_ENABLED
DHAN_STATIC_IP_EXPECTED=true           # ONLY after the EIP is genuinely whitelisted

# ── Durable authority ────────────────────────────────────────────────────────
DATABASE_URL=<PostgreSQL>              # authoritative; migrations 001..010 applied
MONGODB_URI=<Atlas>                    # asynchronous reporting replica only
```

**Why all three economic controls.** `BOX_LIVE_REQUIRE_STAGE_FUNDING=true` now *implies* the
funds-cover check in code. Before that fix, stage funding without funds cover computed a precise
stage requirement, confirmed the sequence was hedge-first, and **never checked the account could pay
for it** — a configuration that read as the strictest available while omitting the only check
involving money.

---

## 3. Timing metrics — and which are real

Recorded by `brokerTimingStore` / `executionTiming` / `latencySource`.

| Metric | Meaning | Local simulated vs observed live |
|---|---|---|
| Broker evidence read | funds / margin round trip | **Both.** Paper runs record simulated timings; live runs record observed. `executionCalibration` keeps them apart and reports `UNCALIBRATED` rather than guessing. |
| Submission → acknowledgement | POST to broker ack | **Live only.** Paper values are modelled and must not be read as broker latency. |
| Confirmed fill observation | ack to confirmed cumulative | **Live only.** |
| Recovery duration | first fault to resolution | **Live only.** |

> **Do not compare a paper number with a live number.** They are different quantities that share a
> unit. Calibration reports its own state precisely so this mistake is visible.

---

## 4. Gate B — deployed read-only verification checklist

**Read-only. Executes no order, changes no configuration, restarts nothing.**

**Status in this task: NOT VERIFIED — I had no deployed access, no credentials and no network
egress to the deployment.** Every step below is written to be executed by an authorised operator.

> **Deploy first.** Gate B reads a *correctly deployed* process. Getting the commit, the egress IP and
> the effective `.env` onto the host is `docs/PRE_LIVE_DEPLOYMENT_VERIFICATION.md`; run that first. Row 7
> below is the static-IP *check*; that document §3.1 is the *procedure*, including why a matching egress
> IP is not proof of broker-side registration.

| # | Check | How | Pass condition |
|---|---|---|---|
| 1 | **Deployed version** | `git rev-parse HEAD` on the host; compare to the merged SHA | Matches the intended commit exactly |
| 2 | **Migrations applied** | `SELECT filename FROM schema_migrations ORDER BY filename;` — the table and column the migrator actually writes (`src/pg/migrate.ts:85`) | Includes `009_backend_instance_epoch` and `010_session_entry_attempts`. **Nothing above the highest file in `migrations/`** — see `PRE_LIVE_DEPLOYMENT_VERIFICATION.md` §5, open item 1 |
| 3 | **Effective configuration** | `GET /api/runtime/status`, `GET /api/box/status` → `effective_config` | `session_max_entry_attempts` and `session_max_completed_trades` are the intended values, **not 0** |
| 4 | **Readiness is orderable** | `GET /api/box/status` → `operational_readiness.instance` | `boot_ordinal` is a **positive integer**, not null. Null ⇒ entry is refused (`instance_epoch_unknown`) |
| 5 | **Broker authentication** | `operational_readiness.identity` | `broker` correct; `account_present: true`; `account_masked` is the expected masked id |
| 6 | **Instrument scope** | `box_status.underlyings` | **Only** the intended trial underlying |
| 7 | **Static IP** | Compare the host's outbound IP to the broker dashboard allow-list | Registered. See BROKER_ADAPTER_AUDIT §1.1 — mandatory since 2026-04-01. **Now also a code gate for Zerodha** — see row 17 |
| 8 | **Retail algo registration** | Account-level with the broker | Order rate stays under 10/s/segment, or the strategy is exchange-registered (audit §1.2) |
| 9 | **Market-data freshness** | `market_data_state`, `market_data_health` | `READY`; frame/heartbeat/depth ages within bounds; `coverage.missing` understood |
| 10 | **Order-stream readiness** | `order_stream` | `lifecycle: READY`. If Dhan: `detail` must **not** still say authorisation is assumed — a completed sweep upgrades it to `rest_verified` |
| 11 | **Baseline reconciliation** | `reconciliation.pending` and the last sweep verdict | `pending: false`, **zero** discrepancies, no unresolved orders |
| 12 | **Baseline is genuinely flat** | Broker order book **and** position book | No pre-existing position or working order in the trial instruments. **Broker-confirmed, not inferred** |
| 13 | **Funding evidence** | `economic_admission` | `available_funds` usable and fresh; `planned_margin` broker-confirmed; the **binding stage requirement** establishable and covered |
| 14 | **Dhan funds semantics** | Read the fund-limit response with a known open position; check whether `availabelBalance + utilizedAmount` equals the pre-trade figure | Resolves audit gap 5.3. Until then the conservative understating reading applies |
| 15 | **Session budget unspent** | `session` in box status | `remaining_entry_attempts` and `remaining_trades` are the full configured values |
| 16 | **Kill switch reachable** | Confirm the emergency control is present and not queued behind another control | Present and independently actionable |
| 17 | **Zerodha static-IP gate** | `operational_readiness.entry.reasons` | `zerodha_static_ip_unconfirmed` **absent**. Fails closed: unset, blank, `false` and a typo all read as not confirmed. Does **not** gate exits, by design |
| 18 | **Funding gates not all off** | `operational_readiness.entry.reasons` | `funding_checks_disabled` **absent**. Live with every funding evidence gate disabled now refuses new entry, it no longer merely reports |
| 19 | **Residual escalation clear** | `operational_readiness.entry.reasons` | `recovery_escalation_timeout` and `residual_state_unknown` **absent**. Escalation age is measured from durable `created_at` where available, so it survives a restart |
| 20 | **Lot relationship holds** | The loaded instrument master vs the two quantity ceilings | `BOX_LIVE_MAX_OPEN_LEG_QUANTITY == L` and `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY == 4 × L` for the **actual** current lot `L`. `BOX_LIVE_EXACT_ONE_LOT=true` refuses boot otherwise. **Read `L`, never assume it** |
| 21 | **One lot, one box, one attempt — all four bounds** | On the host, with the trial `.env` loaded: `node dist/box/effectiveConfig.js --supervised-trial --lot-size=L` | `BOX_SUPERVISED_ONE_LOT_TRIAL=true` and **all four** of `BOX_MAX_OPEN_BOXES`, `BOX_LIVE_MAX_OPEN_BOXES`, `BOX_SESSION_MAX_COMPLETED_TRADES`, `BOX_SESSION_MAX_ENTRY_ATTEMPTS` report `ok … =1`. Verdict line reads *"the four required settings are satisfied and the quantity arithmetic is shown above"*. See §4.1 for the arithmetic to check |
| 22 | **No unowned broker exposure** | `operational_readiness.entry.reasons` and `exposure_management.blocked_reasons` | `unowned_attributed_exposure` **absent**. If present, the trial cannot start on **any** underlying and §6.1 applies — this is operator-in-the-loop, nothing clears it automatically |
| 23 | **Durable store writable NOW, not merely at boot** | `operational_readiness` blockers **and** the three `exposure_management` permissions | `durable_store_unavailable` **absent**, and `exit_and_reduce` / `protective_cancel` / `manage_working_orders` all **true**. **Do not read `pg_ready` for this** — it is a startup latch and stays `true` after a mid-session failure (§6.2) |

### 4.1 The quantity arithmetic to verify at step 21

`--lot-size=L` is **read from the live instrument master** for the contract actually being traded. It
is not optional and it is **not guessable**: the whole envelope scales with it, the test fixtures use
`75`, and an earlier note in this repository guessed `65`.

**The command's exit status is the verdict — read it, not just the last line.** A wrapper script must
branch on it:

| Exit | Meaning | What to do |
|---|---|---|
| **0** | `VERDICT: PASS` — the four bounds are 1 **and** one lot of `L` fits both caps | Proceed to the rest of Gate B |
| **1** | `VERDICT: FAILED` (a cap refuses the lot) or `VERDICT: NOT VERIFIED` (no `--lot-size` given) or the profile is off | Do not arm. Fix the cause named in the verdict |
| **2** | Unusable `--lot-size`, or a configuration that would not boot | Do not arm. Re-read the lot size, or fix the four bounds |

**Bad input is refused, never coerced.** `--lot-size=65.5` is **rejected** with exit 2 — it is not
rounded to `65`. A lot size is an integer contract property, so a fractional value means it was
mistyped, read from the wrong field, or guessed; rounding it would print a lot size nobody read in the
one report whose entire purpose is that the number is not invented. Zero, negative, empty and
non-numeric values are refused the same way.

**Omitting `--lot-size` prints `UNVERIFIED` and exits 1, not 0.** "We did not check" must not be
mistakable for "we checked".

For a lot size `L`, a one-lot box is:

```
per-leg quantity = 1 lot                     = L
gross quantity   = L × 4 legs                = 4L
per-leg cap      BOX_LIVE_MAX_OPEN_LEG_QUANTITY        must satisfy L  <= cap
gross cap        BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY  must satisfy 4L <= cap
boxes the gross cap alone permits            = floor(gross cap / 4L)
```

Worked, at the shipped caps (`100` per leg, `400` gross):

| Lot `L` | Per leg | Gross `4L` | Per-leg cap 100 | Gross cap 400 | Boxes gross cap alone permits | Exit |
|---|---|---|---|---|---|---|
| 75 | 75 | 300 | PASS | PASS | `floor(400/300)` = **1** | **0** |
| 65 | 65 | 260 | PASS | PASS | `floor(400/260)` = **1** | **0** |
| 100 | 100 | 400 | PASS (equal) | PASS (equal) | `floor(400/400)` = **1** | **0** |
| 50 | 50 | 200 | PASS | PASS | `floor(400/200)` = **2** ⚠ | **0** |
| 101 | 101 | 404 | **REFUSED** | **REFUSED** | `floor(400/404)` = 0 | **1** |
| 150 | 150 | 600 | **REFUSED** | **REFUSED** | 0 | **1** |

**Three things to take from that table.**

1. **A lot that breaches either cap means the trial cannot run at all** — every entry would be refused
   before any order is sent, and the preflight now exits **1** so that is impossible to miss. Better
   to learn it from this command than from a refusal at 09:20.
2. **At the shipped caps the two rules move together**, because the gross cap (`400`) is exactly
   4 × the per-leg cap (`100`): any lot that breaches gross has already breached per-leg. A
   gross-only rejection is only reachable if you raise one cap without the other — and if you do, the
   preflight reports it on its own.
3. **The "boxes the gross cap alone permits" column is the one nobody computes.** At a *smaller* lot
   the caps permit **more than one box**, so the quantity caps are **not** a one-box control.
   `BOX_MAX_OPEN_BOXES=1` is what bounds the trial to a single box — which is why it is a required
   setting, and why its previous absence from two shipped profiles mattered.

> **Rows 3, 4, 5, 9, 10, 11, 13, 15 and 17–19 are read from a surface that reports rather than
> enforces.** `operationalReadiness()` is consumed only by `getStatus()` and the runtime-status
> projection — never in the entry decision path, where `BoxOrderManager.entryBlockReasonAfterControls`
> is the authority. Gate B is necessary evidence, not sufficient proof; see
> `PRE_LIVE_DEPLOYMENT_VERIFICATION.md` §4.

---

## 5. Arming sequence (only after Gate B passes and authorisation is granted)

1. Confirm §4 end to end. **Any NOT VERIFIED row is a stop.**
2. Arm the session with **explicit** bounds:
   `POST /api/box/session/arm { "maxCompletedTrades": 1, "maxEntryAttempts": 3 }`
   Explicit values are snapshotted, so a later env change cannot widen the session.
3. Verify the arm response echoes both ceilings.
4. Arm the runtime **ENTRY** control (separate and deliberate).
5. Watch — do not walk away. Have the kill switch and §6 open.

---

## 6. Stop conditions and manual escalation

**Stop immediately and use the kill switch when any of these is true.** These are the control for
gaps 1b and 1d.

| Condition | Why |
|---|---|
| `residual_legs > 0` and not decreasing within **2 minutes** | Unresolved exposure is not converging |
| Any position in `RECOVERY` | Our view of our own exposure is known to be wrong |
| `reconciliation.pending` true for more than **2 minutes** while connected | The gap is not being repaired |
| `entry.permitted` true while the UI shows readiness it cannot order | Contradiction; trust neither |
| Loss approaching the intended budget | It is **not** reliably enforced in code (§1) |
| Any overfill, or a contradictory terminal observation | Escalated conditions by design |
| Attempt budget exhausted with exposure still open | The trial is over; only reduction remains |
| `unowned_attributed_exposure` raised | Broker legs nobody owns. New entry is refused engine-wide; **nothing reduces them automatically.** See §6.1 |
| `durable_store_unavailable` raised, **or** the dashboard shows `PostgreSQL FAILED MID-SESSION` | Automated reduction is **refused, not queued**. See §6.2 |
| A **partial fill** that does not converge within **2 minutes** | See §6.3 |
| A leg **withheld** on a stale/absent book for more than **2 minutes** while exposure is open | See §6.3 |

### 6.1 Unowned broker exposure after a crash (`unowned_attributed_exposure`)

**What it means.** Box legs are confirmed **at the broker** that no open trade and no residual row
accounts for — a fill that landed just before the recording write failed. The engine reconstructs
them from the durable intent journal, so it *knows* they exist; it has no position row for them.

**What the engine does and does not do.**

- **Does:** refuses every NEW box, on **every** underlying, in the coordinator's admission prologue,
  before an attempt is spent or any order is sent.
- **Does NOT:** reduce them. There is no residual row, so the flatten loop has nothing to work, and
  **no timer escalates.** This is an **operator-in-the-loop limit**, deliberately: the alternative is
  an automated order into a book nobody is watching.

**Procedure.**

1. Read the blocker detail — it names each leg as `EXCHANGE:TRADINGSYMBOL SIDE QUANTITY`.
2. **Verify every named leg in the broker terminal.** The broker is the authority; our journal is a
   reconstruction.
3. Then **one** of:
   - **Emergency flatten** — acts on exactly this crash-only set, so clearing the blocker necessarily
     clears the admission gate; or
   - **Reconcile it into a trade** — gives the exposure an owner without closing it, which also clears
     the gate.
4. If the broker does **not** confirm a leg, that is a journal/broker mismatch: reconciliation trips
   the breaker and entry stays blocked by that route instead. Do not flatten what the broker says you
   do not hold.
5. **Do not restart to clear it.** It is rebuilt from the durable journal every boot.

### 6.2 PostgreSQL outage — during the trial

**PostgreSQL is the authoritative operational store, and every reduction needs it BEFORE the broker.**
An exit, an emergency flatten, the working-order cancel sweep and reconciliation each perform (or
read) the durable order-intent journal before anything is transmitted. During an outage they are
**REFUSED, not queued — nothing reaches the broker.**

**Detecting it — and the trap.** `pg_ready` is a **STARTUP LATCH**: it records whether PostgreSQL
answered when the process booted. A store that dies **mid-session leaves it `true` for the rest of the
day.** So:

| Signal | Meaning |
|---|---|
| `pg_ready: false` | Outage present at startup. Banner `PostgreSQL is unavailable`. |
| `pg_ready: true` **and** `durable_store_unavailable` in **either** `/api/runtime/status` `live_entry.reasons` **or** the Box readiness blockers | **Mid-session failure.** Banner `PostgreSQL FAILED MID-SESSION`. The PostgreSQL indicator elsewhere may still read healthy — **the banner is authoritative, the field is not.** |
| All three of `exposure_management.exit_and_reduce`, `.protective_cancel`, `.manage_working_orders` false | Confirms automated reduction is unavailable, whatever any other field says. |
| Banner `CONFLICTING READINESS SNAPSHOTS` | The two payloads **disagree** — see below. Treat the restrictive reading as correct. |

**The dashboard reads two sources, on separate timers, and they can disagree.**
`/api/runtime/status` and the Box status' `operational_readiness` are fetched independently and share
no ordering field, so a fresh runtime response carrying `durable_store_unavailable` can sit beside an
older readiness snapshot that still lists all three reduction permissions as available. The display
now **fails closed**: a durable-store outage from *either* source overrides a "reduction available"
claim from the other, and it raises the `CONFLICTING READINESS SNAPSHOTS` banner so you know the
display made that choice rather than silently picking one.

Two consequences for you as operator:

- **Never resolve the disagreement in favour of the reassuring panel.** An unwritable store blocks
  exiting, protective cancellation and working-order management alike; the permissive snapshot is
  either stale or wrong.
- **A stale or failed refresh makes the exit claim `UNKNOWN`, not "available".** If the readiness
  reading on screen is not current, a permission read from it is not a permission. Verify at the
  broker.

**Procedure.**

1. **Do not wait for the system to exit the position.** It will not, and it will not retry later — the
   order is never built.
2. Decide on **exposure**, not on the database: if the open box can tolerate the time PostgreSQL needs,
   hold. If it cannot, go to step 3 immediately.
3. **Reduce from the broker terminal.** This is the only remaining route. Record every order id and
   timestamp as you go — reconciliation will need to adopt this later.
4. **Do not restart the engine to "reconnect".** A restart cannot write either, budgets are durable so
   nothing is reset, and you lose the in-flight diagnostic context.
5. **Do not hand-edit the database** to make the state look right.
6. When PostgreSQL returns, let **reconciliation adopt reality** from the broker before considering any
   re-arm. `canArm` will refuse while consumed cycles have not reached FLAT; respect that refusal.

### 6.3 Partial fills and stale books

**A partial entry is the expected failure mode of a first live session**, because four-leg atomicity
does not exist — the system legs in, hedge-first, and bounds the damage.

| Observation | What it means | Action |
|---|---|---|
| Some legs filled, `residual_legs > 0`, **decreasing** | Automatic residual flattening is working | Watch. Stop if it stalls for 2 minutes |
| `residual_legs > 0` and **flat for 2 minutes** | Not converging | Kill switch, then §6 escalation |
| `FILLED_EXPOSURE_UNRECORDED` | All four legs filled and the box could not be **recorded**. Exposure is **retained**, ownership **not released**, new entry blocked via the breaker | Verify at the broker, then reconcile or flatten. The candidate key stays reserved until restart |
| A leg **withheld**, exposure open | Every order is a **bounded LIMIT**; nothing escalates to market. Without a current, fresh, deep-enough book the leg is **not sent** | See below |

**The stale-book limit, stated plainly: automated reduction can be withheld indefinitely while
exposure stays open.** That is deliberate — an unbounded order into a thin options book can cost more
than the exposure it removes. But it means **a quiet dashboard is not a closing position.**

- A withheld leg is **never** counted as reduced: exposure decrements only from a broker cumulative
  fill, so the outstanding quantity is durable and re-planned next cycle.
- The withheld set is **prose only** — it is joined into a detail string and is **not** a structured
  field, metric or SSE event. A machine consumer reading `reason: "legging_incomplete"` cannot
  distinguish "nothing was transmitted" from "we transmitted and got a partial". **A human reading the
  detail can — so a human must.**
- **Stop condition:** a leg withheld for more than 2 minutes with exposure open → reduce that leg from
  the broker terminal. Do not wait for a book that may not return before the close.

### Escalation when automatic recovery is impossible

1. **Kill switch** — stop new entry. Risk reduction stays permitted by design.
2. **Do not restart to "clear" anything.** Budgets are durable; a restart resolves nothing and loses
   in-flight context.
3. **Reconcile from the broker, not from us.** The broker's order book and position book are the
   authority for what exists.
4. **Flatten manually at the broker** if the system cannot. Then let reconciliation adopt reality —
   never hand-edit the database.

#### THE BROKER TERMINAL IS THE FALLBACK, AND IT IS NOT OPTIONAL

**Know before you arm: there are states in which this system will not reduce your exposure, and will
not retry later.** In every one of them the broker terminal is the only remaining route. Have it
**open, logged in and tested** before the trial begins — discovering an expired terminal session while
holding an unmanaged position is the worst version of this.

| State | Why automated reduction will not happen | Detect it by |
|---|---|---|
| `durable_store_unavailable` / `PostgreSQL FAILED MID-SESSION` | Every reduction needs a durable write **before** the broker POST. The order is never built, and it is **not queued for later** | The banner, and all three `exposure_management` permissions false. **Not** `pg_ready` |
| `unowned_attributed_exposure` | No position or residual row exists, so the flatten loop has nothing to work. No timer escalates | The blocker; it names each leg |
| Leg **withheld** on a stale/absent book | Every order is a bounded LIMIT; nothing escalates to market. Without a fresh, deep-enough book the leg is **not sent** | Exposure open and not decreasing; the withheld set is **prose only**, in the detail string |
| Circuit breaker tripped on an ambiguous terminal state | Deliberate quarantine — our view of our own exposure is known to be unreliable | `circuit_state`, positions in `RECOVERY` |

**When you use the terminal:** record every order id, quantity and timestamp as you go. Reconciliation
will have to adopt what you did, and it can only do that from the broker's record — so do **not**
hand-edit the database to match, and do not re-arm until reconciliation is clean.
5. **Record** the trade ids, order ids, timestamps and the readiness decision (`instance.boot_ordinal`
   + `decision_generation`) so the sequence can be reconstructed.
6. **Do not re-arm** until residuals are zero and reconciliation is clean; `canArm` refuses while
   consumed cycles have not reached FLAT, and that refusal should be respected rather than worked
   around.

---

## 7. Residual risks — read before authorising

1. **No live broker behaviour is verified.** Every test mocks the transport (FAULT_MATRIX 6.1).
2. **Four-leg atomicity does not exist.** The system legs in, hedge-first, and bounds the damage of a
   partial. It cannot make four orders atomic.
3. **The loss budget is not a reliable brake** (§1, FAULT_MATRIX 6.5).
4. **Shared-account activity is only partly defended.** Manual or external orders on the same account
   consume the same funds. Orphan orders are reported but deliberately **do not** block entry —
   otherwise any manual order would disable the strategy indefinitely.
5. **Dhan authorisation is assumed until a REST call succeeds.** The socket publishes no auth
   acknowledgement; a rejected login surfaces only as a later close.
6. **Dhan funds semantics unresolved** (audit 5.3) — conservative reading applied, may refuse
   affordable entries.
7. **Reservations are not released on local timeout alone**, so a stuck reservation needs operator
   attention rather than expiring quietly.
8. **Single-process topology is assumed.** Two processes would be detected as an incompatible readiness
   epoch, but the topology is not enforced by code.
9. **Regulatory posture is an account-level fact** this system cannot see (audit §1).

---

## 8. Rollback

| Step | Action |
|---|---|
| 1 | Disarm the ENTRY control, then disarm the session. Counters are **preserved**, never cleared. |
| 2 | Set `BOX_LIVE_TRADING_ENABLED=false` (and/or `BOX_EXECUTION_MODE=paper_latency`). |
| 3 | Deploy the previous commit if needed. **Migrations 009 and 010 are additive and need no down-migration**; an older build simply ignores the columns. |
| 4 | **Do not roll the frontend back past contract 1.7.0 while the backend is at 1.7.0** without checking: an older frontend loses restart-aware ordering and reverts to rejecting a restarted backend. Roll **frontend first, then backend** — the reverse of the forward order. |
| 5 | Verify residual exposure is zero **at the broker** before considering the rollback complete. |

**Persistence note.** Both migrations only add. Rolling code back leaves the columns populated and
harmless; rolling **forward again** preserves any spent budget, which is the intended behaviour.
