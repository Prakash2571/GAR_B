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
| Allowed instrument scope | **Partly** | Candidate admission validates exchange identity, lot size, tick size and expiry per leg. **Not** an allow-list of specific underlyings — see gap 1a. |
| Maximum lot size | **Yes** | One lot per leg (`quantity: candidate.lot_size`); `live_max_open_leg_quantity` / `live_max_gross_open_leg_quantity` cap open quantity. |
| **Maximum entry attempts (counting failed/recovered)** | **Yes — new** | `BOX_SESSION_MAX_ENTRY_ATTEMPTS`. Consumed at **admission, before any broker POST**, so an attempt that submits and is then unwound still spends it. Durable, so a restart does not reset it. |
| Maximum completed trades | **Yes** | `BOX_SESSION_MAX_COMPLETED_TRADES`. Consumed at **establishment**. |
| Maximum concurrent intent | **Yes** | `BOX_MAX_CONCURRENT_EXECUTIONS`, `BOX_MAX_CONCURRENT_PER_UNDERLYING`, `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING`; plus the in-process **and** durable PostgreSQL reservation tiers. |
| Maximum unresolved exposure | **Partly** | Residual legs are tracked durably and block re-entry via readiness blockers. **No single configurable rupee ceiling on unresolved exposure** — see gap 1b. |
| Maximum order submissions | **Partly** | Bounded indirectly by the attempt budget (4 legs/attempt) and by the rate-limit ledger. **No independent submission counter** — see gap 1c. |
| Recovery duration | **Partly** | Bounded retry/backoff on the reconciliation sweep; ack/working/partial/cancel timeouts bound each order. **No global "give up and escalate after N minutes"** — see gap 1d. |
| Capital / loss budget | **Partly — do not rely on it** | Daily risk seed and charge watermarks exist and are durable. **No test proves a rupee loss ceiling halts entry** (FAULT_MATRIX 6.5). Treat the loss budget as **observability, not a brake**. |
| Kill switch | **Yes** | `emergencyFlatten` reduces exposure and is never queued behind another control; entry blockers cannot disable risk reduction (`tests/invariants/exitImmunityProtectiveCancel.test.mjs`). |
| Preconditions before entry | **Yes** | The single authoritative readiness decision; the server revalidates **every** entry request independently of any UI. |
| Restart does not reset budgets | **Yes** | Cycle **and** attempt budgets are durable in PostgreSQL; an unreadable session refuses entry rather than assuming a clean slate. |

### Known gaps in the control set

| # | Gap | Consequence for the trial |
|---|---|---|
| 1a | No underlying allow-list | Scope the trial by configuring **one** underlying in the universe, and verify it in the read-only checklist (§4 step 6). |
| 1b | No rupee ceiling on unresolved exposure | The **manual** stop condition in §6 is the control. Watch `residual_legs`. |
| 1c | No independent submission counter | With 4 legs/attempt, `MAX_ENTRY_ATTEMPTS × 4` is the practical submission ceiling. Recovery/unwind orders are **additional and not counted**. |
| 1d | No global recovery deadline | The manual escalation procedure in §6 is the control. |

---

## 2. Supported live configuration for a bounded trial

```bash
# ── Execution mode ───────────────────────────────────────────────────────────
BOX_EXECUTION_MODE=live
BOX_LIVE_TRADING_ENABLED=true          # plus the runtime ENTRY control must be armed

# ── THE TRIAL BOUNDS ─────────────────────────────────────────────────────────
BOX_SESSION_MAX_COMPLETED_TRADES=1     # one completed box
BOX_SESSION_MAX_ENTRY_ATTEMPTS=3       # ...and AT MOST three attempts to get it
#   Both are required. The cycle budget alone does not bound a run of failed attempts:
#   an attempt that submits, partially fills and is unwound spends NO cycle.

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

| # | Check | How | Pass condition |
|---|---|---|---|
| 1 | **Deployed version** | `git rev-parse HEAD` on the host; compare to the merged SHA | Matches the intended commit exactly |
| 2 | **Migrations applied** | `SELECT name FROM <migrations table> ORDER BY name;` | Includes `009_backend_instance_epoch` and `010_session_entry_attempts` |
| 3 | **Effective configuration** | `GET /api/runtime/status`, `GET /api/box/status` → `effective_config` | `session_max_entry_attempts` and `session_max_completed_trades` are the intended values, **not 0** |
| 4 | **Readiness is orderable** | `GET /api/box/status` → `operational_readiness.instance` | `boot_ordinal` is a **positive integer**, not null. Null ⇒ entry is refused (`instance_epoch_unknown`) |
| 5 | **Broker authentication** | `operational_readiness.identity` | `broker` correct; `account_present: true`; `account_masked` is the expected masked id |
| 6 | **Instrument scope** | `box_status.underlyings` | **Only** the intended trial underlying |
| 7 | **Static IP** | Compare the host's outbound IP to the broker dashboard allow-list | Registered. See BROKER_ADAPTER_AUDIT §1.1 — mandatory since 2026-04-01 |
| 8 | **Retail algo registration** | Account-level with the broker | Order rate stays under 10/s/segment, or the strategy is exchange-registered (audit §1.2) |
| 9 | **Market-data freshness** | `market_data_state`, `market_data_health` | `READY`; frame/heartbeat/depth ages within bounds; `coverage.missing` understood |
| 10 | **Order-stream readiness** | `order_stream` | `lifecycle: READY`. If Dhan: `detail` must **not** still say authorisation is assumed — a completed sweep upgrades it to `rest_verified` |
| 11 | **Baseline reconciliation** | `reconciliation.pending` and the last sweep verdict | `pending: false`, **zero** discrepancies, no unresolved orders |
| 12 | **Baseline is genuinely flat** | Broker order book **and** position book | No pre-existing position or working order in the trial instruments. **Broker-confirmed, not inferred** |
| 13 | **Funding evidence** | `economic_admission` | `available_funds` usable and fresh; `planned_margin` broker-confirmed; the **binding stage requirement** establishable and covered |
| 14 | **Dhan funds semantics** | Read the fund-limit response with a known open position; check whether `availabelBalance + utilizedAmount` equals the pre-trade figure | Resolves audit gap 5.3. Until then the conservative understating reading applies |
| 15 | **Session budget unspent** | `session` in box status | `remaining_entry_attempts` and `remaining_trades` are the full configured values |
| 16 | **Kill switch reachable** | Confirm the emergency control is present and not queued behind another control | Present and independently actionable |

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

### Escalation when automatic recovery is impossible

1. **Kill switch** — stop new entry. Risk reduction stays permitted by design.
2. **Do not restart to "clear" anything.** Budgets are durable; a restart resolves nothing and loses
   in-flight context.
3. **Reconcile from the broker, not from us.** The broker's order book and position book are the
   authority for what exists.
4. **Flatten manually at the broker** if the system cannot. Then let reconciliation adopt reality —
   never hand-edit the database.
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
