# Honest economic and capital admission

This document explains the five DISTINCT economic quantities the Box admission path reasons
about, exactly what each can and cannot prove, and the provenance / freshness / failure
semantics enforced in `src/box/boxCapital.ts`.

The governing rule: **these five quantities are never conflated or substituted for one
another.** Each is measured or estimated independently and carries its own provenance.

## The five quantities

| # | Quantity | Type / provenance | What it PROVES | What it does NOT prove |
|---|----------|-------------------|----------------|------------------------|
| 1 | **Available broker funds** | `EconomicFigure`, `broker_confirmed` when fresh | What the account can deploy right now | Nothing about the box itself |
| 2 | **Margin required by the planned execution sequence** | `EconomicFigure`, `broker_confirmed` when fresh (Kite basket / Dhan multi) | The broker's *estimate* of the four-leg basket requirement | That the broker will ACCEPT the orders; it is an estimate, not a guarantee |
| 3 | **Peak temporary exposure (legging window)** | `EconomicFigure`, `estimate` | An upper bound on capital tied up before all legs + hedge benefit exist | The exact peak — that depends on fill order, which this pure module does not observe |
| 4 | **Gross order notional** | `EconomicFigure`, `estimate` (the existing metric, unchanged label) | The largest ₹ the four immutable LIMIT orders can transact | Broker margin, peak capital, or maximum loss |
| 5 | **Bounded worst-case entry cost** | `EconomicFigure`, `estimate` | The largest the LIMIT orders can cost (gross), the settled net debit, and estimated charges | That fills occur at these prices — they are worst-case bounds |

### On #4 (gross notional) — label preserved

`grossEntryOrderNotional()` and its label are unchanged. Its header already warns it
OVER-states a hedged box and must never be called "margin". This remains the deterministic,
offline, conservative admission gate. `evaluateBoxCapitalAdmission()` is untouched; the new
`evaluateEconomicAdmission()` keeps the gross-cap semantics in step with it.

## Provenance and freshness semantics

`EconomicProvenance` is one of:

- `broker_confirmed` — returned by a supported broker facility THIS session, within the
  freshness bound. The only provenance that satisfies `requireMarginEvidence`.
- `estimate` — computed by us from the bounded requests. Deterministic, but NOT a promise the
  broker will accept the orders.
- `stale` — a figure was obtained but is older than the configured freshness bound. **Treated
  as unusable for admission** (`usable === false`) while its value is retained for display.
- `unavailable` — no figure obtained. `value_rupees` is `null`, never `0`.

`brokerFigure()` applies the freshness bound: a value older than `maxAgeMs` is downgraded to
`stale`. `estimateFigure()` tags locally computed values and always states they are not
broker-confirmed. The distinction is enforced in the **types** (`value_rupees: number | null`
forces callers to branch on provenance before trusting a number).

## Failure behaviour (fail closed)

`evaluateEconomicAdmission()` enforces four controls, each failing closed:

- **Gross cap** (`grossCapRupees > 0`): refuse if gross notional exceeds it or is incomplete.
  This is a NOTIONAL limit and is never a margin or available-funds proof.
- **Margin evidence** (`requireMarginEvidence`): refuse unless #2 is `broker_confirmed` AND
  fresh. A stale or missing margin fetch produces `margin_evidence_stale_or_missing` — an
  explicit refusal, never optimistic admission.
- **Funds cover** (`requireFundsCover`): refuse unless #1 is usable and covers the **binding
  stage requirement** (see below) when a funding model could be built, else the usable broker
  basket margin. If neither can be established the result is `metric_incomplete` — a refusal.
  There is **no worst-case-entry-cost fallback**: the conservative entry cost (#5) is reported
  but is explicitly NOT a funding basis, because it is not what the broker will block.
- **Stage funding** (`requireStageFunding`): refuse unless EVERY stage of the real hedge-first
  submission sequence has an establishable requirement AND the sequence is genuinely
  hedge-first. This is the control that stops `final` (completed-basket, spread-benefit) margin
  being used as proof that the account can fund the sequence that CREATES the box.

Multiple failing controls are reported together so an operator sees every problem at once.

### The three gates are NOT independent

`requireStageFunding` **implies** `requireFundsCover` and `requireMarginEvidence`. Computing a
precise per-stage requirement and then never comparing it against money would be a gate in name
only, so the evaluator raises the effective flags itself and publishes the EFFECTIVE values.
`fundingReadiness()` (`src/box/fundingReadiness.ts`) reports `*_configured` and `*_effective`
separately, so no surface can claim the funds check is off while stage funding is running it.

### Intermediate exposure, not just the finished box

`buildFundingStages()` walks `entrySubmissionOrder(direction)` and produces one stage per leg.
Non-final stages are priced against the **initial** basket margin and only the LAST stage may use
the **final** basket margin. `buildFundingPicture()` then takes the **worst** stage, not the last.
So the requirement covers the peak hedge-first exposure while the box is still being built — the
moment a naked-ish intermediate state exists — rather than only the netted end state.

The **binding requirement** is:

```
binding = worst stage requirement
        + estimated charges
        + recovery reserve
        + encumbrance          (only when it is not already netted out of available funds)
```

Any null component makes `binding_requirement` unknown, which refuses.

## "Checks disabled" is not "funding verified"

All four funding knobs default OFF. With all three booleans off, `evaluateEntryEconomics` returns
before reading any evidence and `economic_admission` is published as `null`, which means *nothing
was checked and nothing is claimed* — **not** "no problems found".

`fundingReadiness()` names which of five mutually exclusive states a deployment is in:

| status | meaning | `funding_verified` | readiness blocker |
| --- | --- | --- | --- |
| `not_applicable` | not a live deployment | `false` | none |
| `checks_disabled` | live, every evidence gate off — nothing is known | `false` | **none** (see below) |
| `not_evaluated` | gates on, no entry judged yet this session | `false` | none |
| `verified` | gates on, last entry admitted on fresh bound evidence | `true` | none |
| `refused` | gates on, last entry refused | `false` | one per reason, `scope: "entry"` |

`checks_disabled` deliberately emits **no** blocker: converting the default-off configuration into
a trading stop would change a deployment's controls rather than report on them. Review the gates
themselves with the pre-flight surface, which now lists all four knobs:

```
node dist/box/effectiveConfig.js          # human-readable table with provenance
node dist/box/effectiveConfig.js --json   # structured
```

Funding blockers are **entry-scoped only**. `buildOperationalReadiness` filters by scope, so a
funding refusal can never stop a safely attributed risk reduction — an account that cannot fund a
NEW box must still be able to exit, reduce and protectively cancel the one it already holds.

## Evidence binding

Evidence is not merely fresh, it is BOUND:

- to the broker **account/session** — `evidenceIdentity()` snapshots `{broker, account_ref,
  session_id}` before the reads and `ageEvidence()` invalidates anything acquired under a
  different identity;
- to the **immutable order plan** — `orderPlanFingerprint(requests)` is recorded on the decision
  and re-checked per leg at the send boundary, so a plan that changed after admission is refused.

Both are re-verified at the final send boundary (`economicSendBoundary()`), together with a
monotonic expiry check per side, so evidence cannot silently age between admission and the POST.

## Sizing the recovery reserve

`BOX_LIVE_RECOVERY_RESERVE_RUPEES` defaults to `0`, meaning **nothing is held back**. It is an
additive component of the binding requirement, so raising it makes entry stricter.

**This project does not compute a safe value for you, and no default should be read as adequate.**
A reserve exists to guarantee that a *recovery* action is not blocked for want of money. To size
it, an operator must decide, for their own account and instruments:

1. the worst intermediate state this deployment can reach (one partially filled box at the
   configured `BOX_LIVE_MAX_OPEN_BOXES` and lot size);
2. the margin the broker would demand to **complete** that box from that state — the completing
   leg is a real order with its own margin, not free;
3. the cost of the alternative action, **unwinding** the filled legs, including charges and
   realistic adverse slippage;
4. the broker's own intraday margin-call and square-off behaviour, which can demand funds before
   any of the above completes.

Take the largest of (2) and (3), add (4)'s buffer, and set the reserve to that. Verify the effect
with `GET /api/box/status` → `economic_admission.picture.funding.binding_requirement` and
`economic_admission.funding_readiness`. If the reserve is left at `0`,
`funding_readiness.limitations` states that no funds are reserved.

## Per-broker evidence limitations

| broker | initial (execute-the-orders) basket margin | available-funds semantics |
| --- | --- | --- |
| Zerodha | provided (`kite_basket`) | declared NET of encumbrance from vendor docs; **not verified against a live account** |
| Dhan | **not published** | **unverified**; conservative (understating) reading applied |

Consequence, and it is by design: with `BOX_LIVE_REQUIRE_STAGE_FUNDING=true` and Dhan active, live
entry is **refused** with `funding_stage_unknown` rather than admitted on the completed-box margin.
`brokerFundingLimitations()` reports this on the readiness surface so an operator learns it before
arming, not from a refused entry. No substitute evidence is guessed.

## Before exposure vs. once partially exposed

- **Before any leg is sent**, the bounded four-leg plan must satisfy the configured controls
  above. This is a pre-trade check on immutable, one-lot LIMIT requests.
- **Once partially exposed**, `decidePartialRecovery()` applies an explicit recovery policy
  instead of chasing the original profit threshold:
  - margin/funds evidence not usable → `hold_and_reassess` (do not act on a stale number);
  - completion affordable & priceable → `complete_remaining_legs` (a hedge is safer than a
    naked partial);
  - completion not provable → `unwind_filled_legs` (shed the unhedged exposure).
  Every branch sets `one_lot_preserved: true` — the policy never resizes a partially filled
  box into an unsupported strategy.

## What the system fundamentally cannot prove

- It cannot guarantee broker acceptance from a margin ESTIMATE (#2) — only the broker's own
  acceptance at order time is authoritative.
- It cannot observe the exact peak legging exposure (#3) without the execution sequence owner
  (`orderManager`), so #3 is a conservative upper bound.
- Basket-margin support is used only where the broker actually provides it (Kite basket / Dhan
  `POST /margincalculator/multi`); no basket-margin facility is invented.

## Wiring status

**Wired.** `CentralBoxExecutionGateway.evaluateEntryEconomics()` calls the evaluator from
`simulateLeggingEntry` before any leg is sent, sources funds from the engine's broker adapter
(`margins()`) and planned margin from `createPlannedMarginProvider()`, and re-checks the retained
evidence at the send boundary. `fundingReadiness()` publishes the state, and a refusal appears as
an entry-scoped blocker in `operational_readiness`.

The one part that remains entry-only by design is the gate itself: `evaluateEntryEconomics` is
called from `simulateLeggingEntry` and from nowhere else, so protective reduction once partially
exposed is never subject to new-entry economics.

## Production configuration example

A conservative live profile that enables every supported funding safeguard. The full annotated
file is `deploy/mumbai-ec2-conservative.env.example`; the funding-relevant lines are:

```dotenv
# ── FUNDING SAFEGUARDS ────────────────────────────────────────────────────────
# All four default OFF/0 in code. Setting them is what makes funding VERIFIED
# rather than merely unchecked.

BOX_LIVE_REQUIRE_FUNDS_COVER=true         # (code default false)
BOX_LIVE_REQUIRE_MARGIN_EVIDENCE=true     # (code default false)
BOX_LIVE_REQUIRE_STAGE_FUNDING=true       # (code default false) implies BOTH of the above

# EDIT THIS. 0 reserves nothing. There is no safe default; size it per
# docs/ECONOMIC_ADMISSION.md § Sizing the recovery reserve.
BOX_LIVE_RECOVERY_RESERVE_RUPEES=0

BOX_LIVE_FUNDS_FRESHNESS_MAX_AGE_MS=5000
BOX_LIVE_MARGIN_FRESHNESS_MAX_AGE_MS=5000
BOX_LIVE_EVIDENCE_READ_TIMEOUT_MS=2500
BOX_LIVE_EVIDENCE_CONCURRENT_READS=false

# GROSS order notional cap — a DIFFERENT quantity from margin and from available
# funds. Never summed with them, never relabelled as either.
BOX_LIVE_MAX_BOX_CAPITAL_RUPEES=0         # EDIT: set a real ceiling
```

Verify before arming, and do not infer any of it from the absence of an error:

```
node dist/box/effectiveConfig.js | grep BOX_LIVE_       # what is ACTUALLY in force, with provenance
curl -s .../api/box/status | jq '.economic_admission.funding_readiness'
```

`funding_readiness.status` must read `verified` (or `not_evaluated` before the first candidate) —
**not** `checks_disabled`. With Dhan active and stage funding on, expect
`funding_stage_unknown`: that is the documented, intended refusal, not a misconfiguration to work
around by disabling the gate.
