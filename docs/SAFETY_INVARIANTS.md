# Box Safety Invariants — Audit & Durable Checklist

Auditor pass over the 20 "must-not-regress" Box safety invariants, looking for the defect class
**"a claim that nothing verifies"**. Method: for each invariant, locate the enforcement in `src/`
and the test that actually *asserts* it (not merely names it), then classify. Test *existence* was
never treated as proof — the assertions were read.

Baseline at audit: unit 1477, tokens 47, access 19, switch 14, shutdown 11, pg 30, projector 15 =
**1613**, 0 fail, 0 skip. After this audit: **+3** in `tests/invariants/` (see invariant 20). No
production code changed — every invariant was found already enforced.

Legend: **E+T** enforced+tested · **E,U→+T** was enforced-but-untested, test added here ·
**NE** not enforced · **N/A** not applicable.

| # | Invariant | Class | Enforcement (file:line) | Test (file) |
|---|-----------|-------|-------------------------|-------------|
| 1 | Paper mode can never call a mutation-capable broker adapter | **E+T** | `executionGateway.ts` fork `if (this.mode !== "live") return simulator…`; engine constructs a manager only in `live` mode (`engine.ts:640`); `executionSimulator` refuses a live entry (defense-in-depth) | `paperNeverReachesBroker.test.mjs` — poison manager + **positive control** proves the poison is reachable, so paper silence is meaningful |
| 2 | Live requires BOTH `BOX_EXECUTION_MODE=live` AND `BOX_LIVE_TRADING_ENABLED=true` | **E+T** | `config.ts` `loadBoxConfig` (unknown modes fail closed, no paper fallback) | config.test.mjs: "LIVE is REFUSED when the deployment gate is off", "live mode loads only when BOX_LIVE_TRADING_ENABLED=true", "unknown BOX_EXECUTION_MODE values fail closed" |
| 3 | Even then, startup remains runtime-disarmed | **E+T** | `engine.ts:646` hardcodes `controls: { entryEnabled:false, liveOrderEnabled:false, emergencyFlatten:false }` at manager construction | tradingSession/liveModeTransition: "a fresh deployment loads as IDLE and refuses entry until armed", "the three permissions are INDEPENDENT: arming one never implies another" |
| 4 | Entering the site passcode does not arm live trading | **E+T** | Access gate (site passcode) is fully separate from the three runtime controls + full-admin `x-admin-token` arm; `LiveArm` requires deployment capability, not a session | access `primitives/gate` suites; `singleBroker.test.mjs`: "session state is never derived from admin authentication"; `liveModeTransition.test.mjs`: "a UI toggle cannot bypass deployment authorisation at ANY level of quiet", "without deployment capability NO live permission may be armed" |
| 5 | Live orders are LIMIT only | **E+T** | `orderPricing.ts` bounded-LIMIT construction; adapters enforce bounded chase; MARKET is structurally unrepresentable | "REQUIRED 19: bounded LIMIT enforcement still makes a MARKET order unrepresentable"; kiteBrokerAdapter: "Kite adapter enforces bounded LIMIT chase…"; "an unbounded LIMIT envelope is refused before anything is sent" |
| 6 | A normal Box entry is exactly one valid lot across all four instruments | **E+T** | `singleLotInvariant.ts` (`singleLotCandidateViolation`/`exactEntryFillViolation`, all four roles == lot) | singleLotInvariant.test.mjs: "size is always exactly one lot", "entry fills must be exactly one lot per role; overfill truth remains distinguishable" |
| 7 | Four-leg entry is not atomic at broker and is never documented as atomic | **E+T** | `LIVE_EXECUTION.md` "Remaining broker leg risk" states non-atomicity explicitly and repeatedly; no code path claims atomicity | "LIVE_EXECUTION.md documents the paper-vs-live latency distinction" + the doc-driven noArtificialLiveLatency source-audit; residual/recovery suites exercise the non-atomic recovery path (partialEntryRecovery) |
| 8 | The existing hedge-first submission ordering is used | **E+T** | `entrySubmissionOrder.ts` (`entryTransportRank`, hedge-first); `orderManager.ts` `EntryTransportGate` barrier — uncovered SELL waits on all BUY hedge POST round-trips | hedgeFirstEntryOrder.test.mjs: "SHORT_BOX: every BUY hedge reaches the broker before any uncovered SELL", "a rejected BUY hedge stops the dependent uncovered SELLs BEFORE they POST", "a hedge whose submission is AMBIGUOUS also stops the dependent SELL" |
| 9 | A durable intent exists before external submission | **E+T** | `orderManager.ts` CREATED→SUBMITTING expected-state CAS before any POST; deterministic identity persisted first | orderLifecycle/liveEntryOwnershipGuard: "CREATED and SUBMITTING are durable before transport submission"; "ownership lost DURING durable persistence: zero POSTs" (rows exist, terminalized no-POST) |
| 10 | Immediately before every broker POST, the full checklist is revalidated | **E+T** | `liveEntryGuard.ts` `evaluateLiveEntryGuard` (pure, fail-closed) consulted at 5 checkpoints; feed-generation/depth revalidated in adapter pre-POST | liveEntryOwnershipGuard.test.mjs (whole suite): each condition refuses distinctly; "entry DISARMED during pacing: zero POSTs"; "the scanner decision becomes unwanted during pacing: zero POSTs"; "circuit breaker TRIPS during pacing: zero POSTs" |
| 11 | Timeout/ambiguous broker reply is quarantined & reconciled, never blindly resubmitted | **E+T** | Kite/Dhan adapters return `BrokerAmbiguousSubmitError` → `RECONCILIATION_REQUIRED`, no broker id claimed | ambiguousSubmitAdoption.test.mjs: "a 200 with no orderId is ambiguous and reconciles rather than re-POSTing"; "ambiguous submit is durable and never blindly retried" |
| 12 | Only a uniquely matching broker order whose immutable attributes match is adopted | **E+T** | Adapter adoption checks unique tag/client-id + immutable attribute equality; a collision quarantines | ambiguousSubmitAdoption.test.mjs: "a tag match whose immutable attributes disagree is never adopted", "SEVERAL orders sharing our tag are never adopted", "an order already attributed to a different client id is never stolen" |
| 13 | Cumulative fills are monotonic and attributed exactly once | **E+T** | `CumulativeFillLedger` (orderLifecycle.ts): idempotent, never decreases, overfill flagged not clamped; attribution via durable delta | fillAttribution.test.mjs A1–A10 (out-of-order, duplicate, over-reduction, 400 randomised races) |
| 14 | Cancel can race fills; broker truth never rounded down or overwritten | **E+T** | partialEntryRecovery cancel-race plan unwinds the *terminal* cumulative quantity | partialEntryRecovery.test.mjs: "a cancel that RACED a fill is unwound at the larger terminal quantity" (55 not stale 20); crashRecovery "a stale lower broker snapshot cannot rewind the recorded remainder" |
| 15 | Partial exits never over-close or reverse a role | **E+T** | `partialExitPnl`/exit sizing submits only the exact nonzero remainder per role; reductions cannot cross flat | partialExit.test.mjs: "repeated partial fills on one role never over-close", "reductions must use the exact reducing side/quantity and cannot cross flat", "an over-close is quarantined without clamping or changing quantities" |
| 16 | Restart adopts open positions, unresolved intents and residual exposure | **E+T** | Live boot reconciliation (`orderManager.reconcile`) + `partialEntryRecovery` + residual journal; engine adopts before RUN | crashRecovery/residualRecovery/residualFlattenIdentity: "RESTART" family, "a crash after a FULL/PARTIAL fill…", "R8/R9/R10/R11" crash-before/after-POST adoption |
| 17 | Graceful shutdown stops new discovery first; SIGTERM never auto-liquidates | **E+T** | `index.ts:720` shutdown step 1 = "block new Box entry and stop scanner discovery" before HTTP; steps preserve positions; `index.ts:35` "SIGTERM IS NOT AN INSTRUCTION TO LIQUIDATE" | shutdown/coordinator.test.mjs: flatten spy that must never be called **and** source step-name scan for any flatten/liquidate/close verb |
| 18 | Same-contract overlaps serialise & revalidate; unrelated stay concurrent; no global four-leg mutex | **E+T** | `executionCoordinator` exact-contract reservations; `maxConcurrentPerUnderlying` budget does not replace per-contract exclusion; no whole-underlying lock for unrelated contracts | executionCoordinator/underlyingLockCoordinator/durableInstrumentReservations: T7/T8/T10/T11, MP2/MP3/MP4, "the per-underlying budget caps concurrency WITHOUT replacing per-contract exclusion" |
| 19 | One-active-box-per-underlying, entry capital max, session max block NEW ENTRY ONLY | **E+T** | `orderManager.canEnter()` (open-box/quantity limits) is consulted only for `purpose==="ENTRY"` (submit gate `orderManager.ts:794`); `boxCapital`/session/underlyingLock stamp/consult ENTRY only | boxCapital: "the per-Box ₹ cap blocks ENTRY but not an EXIT"; underlyingLock: "the UNDERLYING LOCK blocks entry but not an exit"; tradingSession: "a CONSUMED SESSION BUDGET blocks entry but not an exit" |
| 20 | **THE MOST IMPORTANT ONE** — no entry blocker may prevent a valid reduction of owned exposure | **E, U→+T** | Mechanical: `orderManager.ts:794-799` gates ENTRY on `canEnter()` (all six-plus blockers) but non-ENTRY only on `canManageExposure()` (`orderManager.ts:759`, = `liveOrderEnabled`); coordinator exit path deliberately omits the ownership guard (`executionCoordinator.ts:585`); `flattenResidual` ungated (`executionCoordinator.ts:468`) | See detailed table below |

## Invariant 20 — the six blockers × the four reduction operations

Invariant 20 names six blockers (max Box entry amount; one-active-underlying; session max; scanner
STOP; entry disabled; reservation-authority outage) and four reduction operations that must survive
them all (EXIT; protective cancellation; emergency residual flatten; reconciliation-required
reduction). I mapped every blocker to the operation(s) proven against it.

`tests/box/exitImmunity.test.mjs` was read line-by-line as instructed. It covers **five** of the six
blockers at the coordinator/gateway layer (capital cap, session budget incl. unreadable, underlying
lock, max-open-boxes, durable reservation outage) — for EXIT and residual flatten. It does **not**
cover scanner STOP or entry-disabled — those live in other files:

- **scanner STOP → exit**: `monitor.test.mjs` test 30 ("STOP stops discovery but the monitor keeps
  managing and exiting") — the monitor, not the scanner, drives exits, and it runs regardless of
  RUN/STOP. `engine.ts:10-13` documents DISCOVERY(RUN/STOP) vs MONITORING(always on).
- **entry disabled + open breaker → EXIT & EMERGENCY_RESIDUAL**:
  `liveEntryOwnershipGuard.test.mjs` ("an EXIT is unaffected by ownership loss, disarmed entry and
  an open breaker"; "an EMERGENCY_RESIDUAL reduction proceeds while entry is fully locked down").

### The gap I found and closed

The four reduction operations were covered at the manager layer for EXIT, EMERGENCY_RESIDUAL and
(via `estimateExecutableExit`/reconciliation) reconciliation-required reduction — but **protective
cancellation was NOT** exercised at the order-manager boundary under a disarmed entry / open
breaker. `BoxOrderManager.cancelWorkingBoxOrders()` (`orderManager.ts:942-943`) and a
`purpose:"PROTECTIVE_CANCEL"` `submit()` (`orderManager.ts:797`) are both gated **only** by
`canManageExposure()` — never by `canEnter()` — so the enforcement was already correct; it was the
*verification* that was missing. This is exactly the "a claim that nothing verifies" class: the
`LIVE_EXECUTION.md` "protective cancellation" guarantee had no test at the manager boundary.

Tests added — `tests/invariants/exitImmunityProtectiveCancel.test.mjs` (3 tests, all green):

1. *a PROTECTIVE_CANCEL submit reaches the broker while entry is disarmed and the breaker is open* —
   real POST occurs (`adapter.posts[0].purpose === "PROTECTIVE_CANCEL"`).
2. *cancelWorkingBoxOrders() cancels working legs while entry is disarmed and the breaker is open* —
   real broker cancel issued for the working BOX order.
3. *cancelWorkingBoxOrders() is refused ONLY when live-order authorization itself is withdrawn* —
   the **negative control**: proves the gate is `canManageExposure()` (not an accidental dependence
   on entry state), and that test 2 is not vacuous.

### The HTTP readiness gate can NEVER block AUTOMATIC risk reduction

The consolidated HTTP readiness gate (`src/index.ts`) refuses **all** mutating HTTP requests while
the process is not `ready`, which includes the operator's **manual** risk-reducing routes
(`/api/box/live/flatten`, `/api/box/live/cancel-working`, `/api/box/live/reconcile`,
`/api/box/trades/:id/close`, and the emergency-flatten execution control). This is a **deliberate,
bounded** restriction on MANUAL reduction only:

- While `starting`, no durable exposure has been adopted and reconciliation has not run, so a manual
  flatten would act on an empty, un-reconciled world — it must be refused. While `shutting_down`,
  refusing mutations is pre-existing drain behaviour (the old `shuttingDown` middleware). `failed`
  likewise refuses.
- **AUTOMATIC reduction is never gated.** Automatic exit, protective cancellation, reconciliation
  and emergency residual flattening are engine-internal and do NOT pass through the HTTP readiness
  middleware at all. Structurally, `ReadinessController` is imported **only** by `src/index.ts`; no
  engine module under `src/box/**` references it or its `mutationsAllowed()`. An HTTP gate therefore
  cannot stop risk reduction — the invariant that actually matters.
- Positions are preserved and re-adopted on restart (SIGTERM never liquidates; boot re-adopts before
  becoming `ready`), so the manual-reduction window closes as soon as the process is `ready`.

Tests added — `tests/readiness/riskReductionGating.test.mjs` (7 tests, all green): each manual route
returns 503 with the readiness reason while `starting` and while `shutting_down`, is reachable once
`ready`; the ReadinessController is imported only by the HTTP layer (structural, both directions);
and a PROTECTIVE_CANCEL and an EXIT reach the broker through the real engine order manager with **no
readiness controller anywhere in the stack** (behavioural).

### package.json changed

Added `"test:invariants": "node --test \"tests/invariants/*.test.mjs\""`. **Flagged for
reconciliation** — another agent may also be editing package.json.

## Tests judged and NOT found misleading

Spot-checked for the "green but hollow" pattern that hid the two prior defects. These looked strong
and *are* strong (real assertions, real broker boundary, negative/positive controls):
`paperNeverReachesBroker` (positive control), `liveEntryOwnershipGuard` (asserts on `adapter.posts`
= real POST boundary), `fillAttribution` A1–A10, `partialEntryRecovery` cancel-race (55 not 20),
`ambiguousSubmitAdoption` immutable-mismatch, `shutdown/coordinator` (spy + source scan).

No misleading test was found. No production defect was found — all 20 invariants are enforced; the
sole gap was a missing *verification* for one clause of invariant 20, now closed.

## The one deliberate exception to "no route returns a token"

`GET /api/tokens/zerodha` and `GET /api/tokens/dhan` (`src/tokenExposureRoutes.ts`)
return a **plaintext broker access token**. Everywhere else in this backend that is a
hard invariant, so the exception is called out here rather than left for a reviewer to
discover.

**Why it exists.** Sibling services need the token this deployment already minted. The
alternative — each service running its own broker login — means several logins per day,
several places a secret can leak, and no single place that knows which session is live.

**Why it is not a hole.**

| Fence | Enforcement |
| --- | --- |
| Off by default | `TOKEN_EXPOSURE_KEY` unset ⇒ `503` for every request. Opt-in only. |
| No weak keys | Shorter than 32 characters ⇒ `503` (misconfiguration), not honoured. |
| Dedicated credential | `x-token-access-key` **header**, constant-time compared. Never a query string; never the site passcode, so it is independently revocable and cannot drive the UI. |
| Brute-force bounded | 30 requests/minute/IP — but see the note below: this raises the cost of noise, it is NOT the reason the secret is safe. |
| Read-only | No branch mints, refreshes, invalidates or switches anything. It cannot change what this deployment trades. |
| No leakage | Never logged (zero `console.*` calls in the module) and never cached (`Cache-Control: no-store`). |
| Honest freshness | A token is served only while usable; otherwise `409` with a reason, so a caller never receives a dead credential. |
| Scoped prefix | Not under `/api/broker/*`, so that prefix's no-token invariant remains literally true. |

**What the rate limiter does and does not do.** `rateLimit` now keys on the **trusted** client
address (`src/clientIp.ts`): forwarding headers are consulted only when the connection itself
arrives from a trusted proxy, and then it reads the hop *our* nginx appended — not the leftmost
entry, which is the value the caller supplies. It previously keyed on the first
`X-Forwarded-For` value, so a direct caller could rotate it and reset its own budget; that is
fixed, along with a duplicated-header `TypeError` that let a request escape being counted at all,
and the limiter map is now bounded.

That closes the trivial bypass. It does **not** make the limiter a brute-force defence on its
own: the **32-character key floor** is what makes the shared secret unguessable, and the network
restriction below is the second real control. Do not read "rate limited" as "brute-force proof".

**Sign-out is not revocation.** `POST /api/broker/{broker}/logout` makes THIS deployment forget
the token and stops serving it here. It does **not** invalidate the token at the broker, so any
sibling service that already fetched it keeps a working credential until the broker expires it
(end of the IST day for Zerodha; the stated expiry for Dhan). If a token must be considered
compromised, rotate it at the broker — signing out here is not sufficient.

**Operator obligation.** TLS-terminate in front of it and restrict the route at the
network/nginx layer to the hosts that need it. The response body is a bearer credential
and the code cannot enforce transport security from behind a proxy that already
terminated the connection.

## Dropping a broker session is guarded like changing broker

`POST /api/broker/{broker}/logout` drops the credential that exits, protective cancellation
and reconciliation depend on. Doing that while a Box is open, an order is working or an
execution is in flight would strand real exposure with no way to reduce it.

`POST /api/broker/select` has always refused in exactly those conditions. Sign-out reaches the
same end state — no usable session for the broker that owns the position — so it is held to the
same standard, from the **same** `ExposureProbe` (`ActiveBrokerManager.exposureBlockers`, shared
by `switchBlockers` and `logoutBlockers`) rather than a second opinion that could drift.

- Signing out of the **standby** broker is never blocked: it owns nothing.
- Signing out of the **active** broker returns `409 logout_refused` with the full blocker list.

The frontend also confirms first, and says plainly that open positions are not closed. That
dialog is a courtesy, not a control — the refusal is enforced server-side, because anything
holding an operator session can call the API directly.
