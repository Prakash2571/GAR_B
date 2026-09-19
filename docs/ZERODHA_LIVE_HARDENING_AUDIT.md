# Zerodha live hardening — §13 order-state audit and §15 live-execution audit

Traced against the source at the head of `fix/zerodha-live-hardening`, not against earlier summaries.
Every claim below cites the file that makes it true. Where a property is enforced by construction
rather than by a check, that is said explicitly, because the two have very different failure modes.

Nothing in this document was produced by running a live session. No broker order was placed.

---

## §13 — Zerodha order-state truth: AUDIT RESULT, NO CODE CHANGE

The brief permits an audit-only outcome, and that is the honest finding here. Each required property
already holds, and each is already covered.

### Authority when observations conflict

`mergeBrokerOrderSnapshot` (`src/box/brokerOrderMerge.ts`) is the single reconciliation point, and it
is **transport-agnostic**: both adapters funnel every observation through it —
`kiteBrokerAdapter.ts:1391` and `dhanBrokerAdapter.ts:518` / `:1111`. There is no separate "stream
path" and "REST path" that could diverge, which is what makes the monotonicity property structural
rather than something each caller must remember.

The authority is not a transport. It is the **highest confirmed cumulative quantity**, with terminal
status resolved against it.

### Monotonic cumulative fill — by construction

```
brokerOrderMerge.ts:196    const accepted = Math.max(curFilled, candFilled);
```

One line, applied to every observation from either transport. So both directions the brief names are
covered by the same code:

| sequence | result |
|---|---|
| stream says 55, later stale REST says 20 | retains 55 |
| REST says 55, later stale stream says 20 | retains 55 |

`updated_at` is likewise floored (`:310` `Math.max`), and the exchange stamp is merged **separately**
(`:315-322`) with the comment that the two are different clocks — a detail worth preserving, since
collapsing them would let one clock's skew rewind the other.

`pending_quantity` is derived from the accepted figure (`:301`), so it cannot disagree with it.

### ACK is not execution

`src/box/orderLifecycle.ts:31` — *"An ACK is not an execution. Neither is an HTTP 200."* — with
`stageProvesExecution` as the mechanism. A dependent SELL is authorised by the hedge coverage ledger
against confirmed terminal cumulative fill, never by an `order_id`.

### Stream health: configured ≠ connected ≠ healthy

The contract itself enforces the distinction. `contract/schemas/order-stream-status.schema.json`
**requires** a field literally named `market_data_health_is_not_order_stream_health`, alongside
`any_stream_live`. A configuration flag cannot masquerade as evidence that events are arriving,
because the schema does not have a shape in which it could.

### REST remains the fallback authority

REST reconciliation is independent of stream state and is what the recovery path uses. A stale or
disconnected stream cannot manufacture order state: an observation only ever raises the accepted
cumulative quantity, and an absent observation raises uncertainty rather than resolving it
(`brokerOrderMergeTable.test.mjs`: *"a newer empty read may still RAISE uncertainty on a working
order"*).

### First-live profile

`deploy/FINAL-one-box-live.env.template:552` already sets `ZERODHA_ORDER_STREAM_ENABLED=false`. Left
as it is, deliberately. REST polling is sufficient for one bounded box, and the first run should be
optimised for correctness and legibility rather than for shaving polling latency. Priorities, in
order: correctness, no duplicate order, correct cumulative fills, correct recovery, reduction
availability — latency last.

### Existing coverage (cited rather than duplicated)

No new §13 tests were written, because these already prove the required behaviour:

- **`tests/box/brokerOrderMergeTable.test.mjs`** — 26 cases, including: UNKNOWN surviving a provably
  stale observation; `RECONCILIATION_REQUIRED` sticky against a stale observation; a fresh successful
  read clearing UNKNOWN (the fail-safe is not a trap); uncertainty not reopening a confirmed terminal
  order; a COMPLETE label contradicting the cumulative quantity being escalated; a cancellation that
  raced a full fill resolving to COMPLETE **however both sides label it**; a late partial fill on a
  cancelled order raising the quantity while keeping CANCELLED; a broker-order-id conflict forcing
  reconciliation rather than silently reassigning.
- **`tests/box/ambiguousSubmitAdoption.test.mjs`** — 10 cases on ambiguous placement and
  attribute-verified tag adoption.
- **`tests/box/fillAttribution.test.mjs`** — 10 cases on attribution.

**Gap, stated honestly:** the cancel/fill and stale-observation cases are proven at the *merge* layer,
which is the layer that decides. I did not add an end-to-end Kite-transport test driving a real
WebSocket frame against a real REST body, because the merge is transport-agnostic and such a test
would re-prove the same line through more machinery. If Zerodha order streaming is ever enabled for a
live run, that end-to-end test should be written first.

---

## §15 — Live execution audit

### Successful entry path

| # | step | where | authoritative state | on failure |
|---|---|---|---|---|
| 1 | candidate qualification | `engine.ts` scanner pass | quote store + universe | candidate skipped, no cost |
| 2 | **underlying allowlist** | `underlyingExclusionRefusal` → `allowlistEntryRefusal` | `cfg.liveAllowedUnderlyings` | refused at 4 enforcement points |
| 3 | operator blocklist | same chokepoint | `UnderlyingExclusionBook` | refused; unreadable ⇒ refused |
| 4 | duplicate-opportunity guard | coordinator prologue | in-process set | refused |
| 5 | **session attempt budget** | coordinator prologue | durable | refused; survives restart |
| 6 | one-active-per-underlying | coordinator prologue | durable hold | refused |
| 7 | global open-box limit | coordinator prologue | committed-exposure count | refused |
| 8 | contract reservation | coordinator | durable lease | refused |
| 9 | coherence / feed | `recheckEntryCoherence` | quote receive times | refused pre-submit |
| 10 | **static-IP confirmation** | `entryBlockReasonAfterControls` | `limits.zerodhaEntryStaticIpConfirmed` | refused before POST |
| 11 | **funding gates present** | `entryBlockReasonAfterControls` | `limits.liveFundingChecksDisabled` | refused before POST |
| 12 | funds / margin / stage funding | `evaluateEntryEconomics` | broker evidence + identity | `REFUSED_BEFORE_SUBMIT` |
| 13 | capital ceiling | `capitalBlockReason` | integer paise | refused |
| 14 | quantity containment | `quantityLimitBlockReason` | `lot_size` from instrument master | refused |
| 15 | **attempt-scoped evidence created** | `evaluateEntryEconomics` returns it | immutable, closure-captured | — |
| 16 | BUY hedge requests | `entrySubmissionOrder` | hedge-first ordering | — |
| 17 | intent persistence | order manager | durable | refused, nothing sent |
| 18 | dequeue guard | `evaluateEntryGuard("dequeue")` | live controls | refused |
| 19 | post-persist guard | `evaluateEntryGuard("post_persist")` | live controls | refused |
| 20 | **pre_post guard** | `evaluateEntryGuard("pre_post")` | **this attempt's own evidence** | refused, no POST |
| 21 | Zerodha LIMIT POST | `kiteBrokerAdapter` | broker | ambiguity ⇒ reconcile, never blind retry |
| 22 | ACK | adapter | **not execution** | — |
| 23 | terminal cumulative BUY fill | `mergeBrokerOrderSnapshot` | `Math.max` floor | uncertainty is sticky |
| 24 | hedge coverage ledger | `hedgeCoverageLedger` | attributed positive fill | SELL withheld |
| 25 | dependent SELL pre_post | as 20 | own evidence | refused |
| 26 | four terminal quantities | merge layer | monotonic | conservation checked |
| 27 | Box ownership | durable | Mongo + PG | — |
| 28 | session cycle consumed | durable | survives restart | second attempt refused |
| 29 | monitoring → exit → flat | monitor / gateway | broker truth | reduction never entry-gated |

### Failure matrix

Columns: **E** new ENTRY possible · **U** uncovered SELL possible · **D** duplicate POST possible ·
**F** highest cumulative fill retained · **R** protective cancel / EXIT / emergency reduction
available · **C** reconciliation continues · **S** survives restart · **V** operationally visible.

| # | scenario | E | U | D | F | R | C | S | V |
|---|---|---|---|---|---|---|---|---|---|
| 1 | first BUY rejected | no | no | no | n/a | yes | yes | yes | yes |
| 2 | first BUY partial fill | no | **no** | no | yes | yes | yes | yes | yes |
| 3 | BUY cancel races extra fill | no | no | no | **yes** | yes | yes | yes | yes |
| 4 | BUY 1 fills, BUY 2 rejects | no | **no** | no | yes | yes | yes | yes | yes |
| 5 | hedge fills, feed goes stale | no | no | no | yes | yes | yes | yes | yes |
| 6 | hedge fills, funding evidence expires | no | no | no | yes | yes | yes | yes | yes |
| 7 | SELL queued, ENTRY disarmed | no | no | no | yes | yes | yes | yes | yes |
| 8 | SELL pre_post, evidence expired | no | no | no | yes | yes | yes | yes | yes |
| 9 | POST sent, client times out | no | no | **no** | yes | yes | yes | yes | yes |
| 10 | broker order exists, response lost | no | no | **no** | yes | yes | yes | yes | yes |
| 11 | multiple tag matches | no | no | no | yes | yes | yes | yes | yes |
| 12 | one tag match, attributes mismatch | no | no | no | yes | yes | yes | yes | yes |
| 13 | DB fails before POST | no | no | no | n/a | yes | yes | yes | yes |
| 14 | DB fails after broker order exists | no | no | no | yes | yes | yes | yes | yes |
| 15 | crash immediately after POST | no | no | no | yes | yes | yes | yes | yes |
| 16 | restart while order WORKING | no | no | no | yes | yes | yes | yes | yes |
| 17 | restart with residual exposure | no | no | no | yes | yes | yes | yes | yes |
| 18 | cancel timeout before DELETE sent | no | no | no | yes | yes | yes | yes | yes |
| 19 | cancel ambiguous after DELETE | no | no | no | **yes** | yes | yes | yes | yes |
| 20 | REST and stream disagree | no | no | no | **yes** | yes | yes | yes | yes |
| 21 | static-IP confirmation false | **no** | no | no | yes | **yes** | yes | yes | yes |
| 22 | IP actually wrong despite flag | no | no | no | yes | attempted¹ | yes | yes | yes |
| 23 | underlying outside allowlist | **no** | no | no | n/a | yes | yes | yes | yes |
| 24 | malformed risk env | **boot refused** | no | no | n/a | n/a² | n/a² | n/a | yes |
| 25 | recovery unresolved > threshold | no | no | no | yes | **yes** | yes | yes | **yes** |
| 26 | repeated restarts, non-durable condition | no | no | no | yes | yes | yes | partial³ | yes |
| 27 | second candidate during first attempt | no | no | no | yes | yes | yes | yes | yes |
| 28 | scanner stops after exposure exists | no | no | no | yes | **yes** | yes | yes | yes |
| 29 | breaker trips after exposure exists | no | no | no | yes | **yes** | yes | yes | yes |
| 30 | live entry disabled after exposure | no | no | no | yes | **yes** | yes | yes | yes |
| 31 | session attempt consumed | **no** | no | no | yes | yes | yes | yes | yes |
| 32 | completed-trade limit reached | **no** | no | no | yes | yes | yes | yes | yes |
| 33 | residual state unreadable | **no** | no | no | yes | **yes** | yes | yes | yes |

¹ **Scenario 22 is the one case where GAR_B cannot help, and it is honest about that.** A confirmed
flag with a genuinely unregistered egress IP means Zerodha rejects the requests — including exits.
GAR_B still *attempts* every reduction, and the rejection surfaces as a broker/infrastructure failure
rather than as a GAR_B policy refusal. This is precisely why the confirmation is never described as
broker-verified, and why the preflight `curl` is documented in the profile. **Mitigation is
operational, not code.**

² Scenario 24 refuses at config load, before any component exists. That is safe when starting
*fresh*; if broker exposure already exists, a malformed env means the process cannot start and
therefore cannot reconcile. Recorded as a limitation below.

³ Scenario 26: residual age survives restart (durable `created_at`); the non-durable half
(unknown orders, unattended working orders, incomplete reconciliation) resets per process, so a crash
loop can keep resetting that clock. Reported via `ageSource`, never disguised.

### Release blockers found

**None outstanding.** Every blocker from the brief's list was checked:

- uncovered dependent SELL — impossible: coverage ledger requires attributed positive terminal fill
- ACK mistaken for fill — impossible: `orderLifecycle.ts` `stageProvesExecution`
- cumulative fill moving backwards — impossible: `Math.max` floor, transport-agnostic
- ambiguous POST blindly retried — no: reconcile/adopt by stable tag with attribute verification
- cancellation losing later fills — no: late fills raise quantity, keep CANCELLED
- **economic evidence crossing attempts — FIXED this cycle** (§10)
- **allowlist bypass — FIXED** (§6, composed into the shared 4-point chokepoint)
- **static-IP status-only — FIXED** (§3, real enforcement in the ENTRY path)
- **disabled funding checks allowing live entry — FIXED** (§4 + enforcement follow-up)
- **malformed safety config falling back — FIXED** (§7)
- second attempt exceeding the session — no: durable budget, consumed in the prologue
- restart losing ownership — no: durable intents, adoption, reconciliation
- residual recovery / escalation / notional blocking reduction — no: all entry-scoped or inert

### Unresolved limitations

1. **Scenario 22** — an operator-confirmed flag cannot prove the broker-side whitelist. Operational
   mitigation only.
2. **Malformed env with live exposure** (scenario 24) — boot refusal prevents reconciliation. Correct
   for a fresh start; a hazard mid-incident. Fixing it would mean a degraded reduce-only boot mode,
   which is a design change, not a hardening patch.
3. **Non-durable recovery age resets on restart** (§11) — reported, not hidden.
4. **Residual notional and escalation counts live in a blocker detail**, not first-class status
   fields, because `operational-readiness.schema.json` is closed at the root and at
   `exposure_management`. A dedicated field is a contract bump across two repositories.
5. **No end-to-end Kite stream/REST transport test** — see §13 above. Required before enabling
   `ZERODHA_ORDER_STREAM_ENABLED=true`.
6. **Deferred from the earlier review, unchanged:** `persistLocalPreSubmitRefusal` is unwrapped at
   four call sites; the session attempt is consumed above the underlying hold; `checkedFeedBlockReason`
   is purpose-blind so unwind/exit/flatten are bounded-LIMIT best-effort; the `uncertain`
   short-circuit returns before `unwindConfirmed`. None is a new regression, and each touches the live
   order path — they are named here so they are not forgotten rather than quietly carried.

### Lot size remains instrument-master driven

Order quantity is always `candidate.lot_size` from the live instrument master. No lot size is
hardcoded in execution logic. `BOX_LIVE_EXACT_ONE_LOT=true` asserts only the *relationship*
`gross === 4 × perLeg`, which is lot-size agnostic — `725/2900` passes exactly as `65/260` does. The
profile's `65/260` is a value to verify at preflight, not an assumption the engine makes; the
comparison against the *selected* instrument's real lot size remains a runtime readiness question and
is not attempted at boot.
