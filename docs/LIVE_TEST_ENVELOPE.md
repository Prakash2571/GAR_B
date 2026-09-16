# The live-test envelope: what the defaults actually are

This document exists because the audit found that several operational claims in this repository were
stale, and that the *effective* value of a limit was often not the value an operator would guess from
its name. It states the shipped defaults, corrects the specific stale guidance the audit named, and —
most importantly — lists what is still **not verified** against the broker.

Nothing here changes behaviour. It is a description, and it is written to be falsifiable: every row
names the environment variable and the source line so it can be checked rather than believed.

## 1. Corrections to previously published guidance

| Stale claim | The truth |
|---|---|
| "MongoDB is the authority." | **PostgreSQL is the operational authority; MongoDB is an async read replica.** Any document implying Mongo is authoritative describes an architecture this backend no longer has. `package.json`'s own description is correct; some prose was not. |
| "A cancellation timeout means the order was not sent." | **Never true, and now structurally distinguished.** A timeout has three possible meanings, and the code now reports which one: acknowledged, *proven* un-transmitted (`BrokerCancelNotTransmittedError` — withdrawn while still queued, so nothing left), or ambiguous (dispatched, outcome unknown, reconcile). Before this change a timed-out cancellation could still be transmitted afterwards. |
| "Selecting live mode creates a supervised-test envelope." | **It does not.** Session attempt caps default to unlimited, funding gates default off, and the cash recovery reserve defaults to zero. The envelope must be built explicitly — see §3. |
| "Zerodha fills arrive on the order stream." | **Only if explicitly enabled and working.** Zerodha order streaming is off by default; otherwise fills are observed through REST polling. |
| "Broker timestamps are reliable wall-clock." | They are IST wall clock with **no zone suffix and whole-second resolution**. They are now parsed as IST regardless of host timezone (`src/box/brokerTimestamps.ts`); before, a UTC host shifted every one by +5h30m. Second resolution still means a broker-vs-local comparison carries up to ~1s of quantisation on top of any host/exchange clock skew. |

## 2. Effective defaults, and why the name can mislead

| Setting | Env var | Default | What it actually means |
|---|---|---|---|
| Entry concurrency | `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY` | **1** | Whole order lifecycles serialise. Raising it does **not** proportionally reduce time-to-complete, because placements are still rate-spaced (below) and the hedge-first barrier still holds dependent SELLs until a hedge fill is proven. |
| Order-mutation spacing | `BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS` | **110 ms** (Zerodha floor 100 ms) | Four posts have an **idealised 330 ms minimum** first-to-last dispatch span. That is a floor, not a ceiling: database writes, funding reads, hedge fills and queue waits all add to it. |
| General/poll spacing | `BOX_LIVE_BROKER_MIN_INTERVAL_MS` | 250 ms | Also the REST poll cadence in the resolution loop. |
| HTTP timeout | `BOX_LIVE_HTTP_TIMEOUT_MS` | 5 000 ms | Covers headers **and** the body read. |
| Working-order timeout | `BOX_LIVE_WORKING_TIMEOUT_MS` | 30 000 ms | Then a protective cancel is attempted. |
| Partial-continuation timeout | `BOX_LIVE_PARTIAL_TIMEOUT_MS` | 10 000 ms | |
| Cancellation timeout | `BOX_LIVE_CANCEL_TIMEOUT_MS` | 5 000 ms | One absolute budget now governing **both** the pacing queue and the wire. |
| Entry leg chase | `BOX_LEG_MAX_CHASE_TICKS` | 2 ticks | |
| Unwind chase | `BOX_UNWIND_MAX_CHASE_TICKS` | 5 ticks | **The effective unwind chase is `min(2, 5) = 2` ticks**, not 5, because the per-leg cap also applies. Flattening is LIMIT-only and best-effort: a thin or moving book can leave residual exposure. |
| Quote age | `BOX_QUOTE_MAX_AGE_MS` | 15 000 ms | Coherence between legs does **not** make a 15-second-old price economically actionable. |
| Session completed-trade cap | `BOX_SESSION_MAX_COMPLETED_TRADES` | **0 = unlimited** | |
| Session entry-attempt cap | `BOX_SESSION_MAX_ENTRY_ATTEMPTS` | **0 = unlimited** | |
| Stage-funding requirement | `BOX_LIVE_REQUIRE_STAGE_FUNDING` | **false** | |
| Cash recovery reserve | `BOX_LIVE_RECOVERY_RESERVE_RUPEES` | **0** | |

**These timeouts are not one bounded end-to-end deadline.** They are independent per-stage budgets, so
the worst-case wall clock for an attempt is closer to their sum than to any single one of them.

## 3. Arming a genuine one-attempt test

The defaults above do not constitute a supervised envelope. To get one, all of these must be set —
setting only some of them leaves a gap that the others do not cover:

1. `BOX_SESSION_MAX_ENTRY_ATTEMPTS=1` **and** `BOX_SESSION_MAX_COMPLETED_TRADES=1`. Both: the first
   bounds attempts, the second bounds completions, and neither implies the other.
2. Restrict to one underlying, one box attempt, one current lot per leg.
3. Enable and satisfy the funds, planned-margin and stage-funding checks, and justify the capital cap
   and the recovery reserve rather than leaving them at zero.
4. Confirm zero unresolved orders/residuals and a reconciled broker position set **before** arming.
5. Verify the **deployed** build and migrations, not a local checkout.
6. Keep broker-native access available, and an operator watching.

One lot bounds *size*. It does not remove legging, margin, execution or settlement risk.

## 4. Known limits of our own accounting

- **Rate-budget history is in memory.** A restart forgets prior spend, so the first requests after a
  restart are budgeted as if the account were untouched. Other applications trading the same account
  are invisible to us entirely — the budget snapshot reports this as
  `external_consumers_unobservable`.
- **A 429 is never evidence about the order.** It now produces a real cooldown honouring the broker's
  `Retry-After` header, but it says nothing about whether the exchange saw the request. No mutation is
  ever replayed automatically.
- **Exchange time and our clock are different clocks.** Broker stamps are second-resolution IST;
  latency figures derived from mixing them with our local clock carry that quantisation.
- **250 ms exchange-time dispersion vs whole-second book timestamps** means legitimate opportunities
  can be refused around second boundaries.

## 5. Still unverified against the broker

The audit could not confirm these from official sources (documentation requests returned HTTP 403),
and **repository claims are not a substitute for current official confirmation**:

- Current Zerodha API permissions for this account.
- The approved static egress IP.
- Funds-field semantics (which field is genuinely available margin).
- Lot sizes and expiry rules for the intended underlying.
- The exact published rate limits per endpoint class.

Until each is verified externally, treat the corresponding configuration as an assumption. The rate
limits encoded in `src/box/brokerPacing.ts` carry `sourceUrl` / `verifiedOn` / `confirmed` fields
precisely so that an unverified limit is visible as unverified rather than silently trusted.
