# Reducing exposure when the market-data feed is unhealthy

## What was wrong

Every recovery path priced off `BoxQuoteStore`, which is WebSocket-only by explicit
construction — *"Executable books come exclusively from the shared Kite WebSocket; REST quotes are
never admitted to this store or its feed-health clock."* And every path was gated on one global
raw-tick recency test, `engine.isFeedHealthy()`:

| path | gate |
| --- | --- |
| automatic exit | `positionMonitor.evaluatePosition` returned before doing anything |
| manual close | `closeManually` refused; `stillWanted` re-checked mid-fill |
| emergency flatten | reuses `closeManually` for every projected position |
| residual flatten | the loop returned; the per-token gate demanded current WS depth |

So one quiet socket blocked every exit for every position. `recoveryEscalation.ts` — which is
explicit that it is *"observability and operator alerting"*, not permission to act — reported an
incident that nothing could act on.

The worst part was the silence. Because the monitor returned **above** its liquidity gate, an
outage emitted no event and set no `exit_blocked_reason`. The position simply went quiet. The only
alarm that still fired was `EXPIRY_SAFETY`, whose own comment concedes the gap: *"Only the
EXECUTION of the exit needs a live book, and that is still gated below."* On expiry day the alarm
said "settlement is approaching on this position" and the next four lines silently refused to do
anything about it.

## What is implemented now

### 1. The outage is visible and exact

`positionMonitor` no longer returns silently. It sets `exit_blocked_reason` and emits one
deduplicated event carrying the reason.

The event is **`ERROR`, not `EXIT_SKIPPED_LIQUIDITY`**. A dead feed is not a thin book, and
labelling it a liquidity skip would send an operator looking at depth that is simply unobserved.
`ERROR` is the channel the `RECOVERY` block already uses for "blocked, but not by the market".

Every blocker names what did **not** happen, states that the exposure is unresolved and still
owned, and names the broker terminal when that is the remaining route. None of them implies
flatness.

### 2. A REST-depth admission test that cannot be fooled

`admitRecoveryDepth()` in `src/box/degradedRecovery.ts` is the only thing permitted to turn
REST data into an executable reference price. It is **stricter** than the WS path, not looser, and
refuses on:

- a book that is not `source: "rest"` — the degraded path must not silently re-read the very store
  whose freshness clock is unhealthy
- a book from another broker, or from a **provably** different account (an unproven account on
  either side is "cannot tell" and does not refuse, mirroring `dispatchAccountBlockReason`, because
  a refused reduction strands exposure)
- a different token **or** a different tradingsymbol — tokens are recycled across expiries. Identity
  is checked *before* depth, so a wrong-instrument book can never be accepted on its content
- no usable observation time, a **future-dated** observation (the clocks disagree — refuse rather
  than guess), or one older than a **tighter** limit than the entry path's
- a relevant side with no real price or no real size. This is the specific trap:
  `kite.getQuoteDepth()` substitutes `last` for a missing touch
  (`const bid = v.depth?.buy?.[0]?.price ?? last`), manufacturing a two-sided price for an unquoted
  instrument. `brokers/quoteProvider.ts` already documents it for the entry path — *"inventing the
  LTP as a two-sided price would make an unquoted instrument look executable"*
- depth that does not cover the quantity **at or better than the bounded limit**
- an unbounded or non-positive limit price

The reducing side is read correctly: a reducing BUY consumes asks, a reducing SELL consumes bids.
Reading the wrong side would price against the spread and look executable when it is not.

### 3. An explicit policy

`degradedRecoveryVerdict()` returns `normal`, `degraded` or `blocked`. It is consulted **only for a
reduction**. New entry is not a caller and must not become one: entry needs four-leg coherence and
full readiness, and a degraded feed can never justify creating a new box.
`streamHealthPolicy.ts` already encodes that asymmetry as a table (`DEGRADED → newEntry: false,
exitAndReduce: true`); this is the runtime gate that was missing.

A closed exchange blocks but does **not** ask for broker-terminal intervention — nobody can trade a
closed exchange.

## LIMITS — what is NOT implemented, and why

**Degraded recovery does not currently place orders.** `degradedRecoveryCapability()` reports
`enabled: false` for both brokers. That is deliberate, not an oversight.

The REST depth exists and is usable:

| broker | source | notes |
| --- | --- | --- |
| Zerodha | `KiteClient.getQuoteLadder()` | real 5-level bids/asks filtered to `price > 0`. **Not** `getQuoteDepth()`, whose `?? last` fallback manufactures prices. Carries no exchange timestamp, so the observation must be stamped at fetch completion |
| Dhan | `DhanClient.marketFeedQuote()` | 5-level depth with per-level order counts. Segment-bucketed, capped at 1000 instruments per segment |

What is missing is **admission at the dispatch boundary**:

- `executionGateway.precheckOne` is **synchronous** and demands a WS quote that is warm in the
  current feed generation, present in `BoxQuoteStore`, and within `quoteMaxAgeMs`.
- `checkedFeedBlockReason` re-validates that same stamp at CHECKPOINT 3 (dequeue) and CHECKPOINT 5
  (the last instant before the POST).

A REST-priced order would therefore be refused at the last instant anyway. Wiring it properly needs
a parallel REST store that `precheckOne` can read synchronously, a `CheckedFeedStamp` variant
carrying `source: "rest"` and its own observation stamp, and matching logic in
`checkedFeedBlockReason`. That is a change to the most safety-critical code in the process, and
half-wiring it would be worse than reporting honestly: an order that passes a relaxed precheck and
is then refused at CHECKPOINT 5 has achieved nothing except to make the logs claim an attempt.

So the honest position is: **the policy and the admission test are complete and tested; the
execution path is not.** During a WS outage this process will not price a reduction, and it now says
so precisely, per position, naming the broker terminal.

### Other limits

- **Nothing here widens entry freshness.** `admitRecoveryDepth` is reachable only for a reduction.
- **Nothing here enables MARKET orders.** A reference price still produces a bounded LIMIT through
  `orderPricing.computeLimitPrice`, including its one-tick floor.
- **REST depth is never admitted into `BoxQuoteStore`** or into the feed-health clock. Entry
  coherence depends on that store meaning exactly one thing.
- Neither REST endpoint carries an exchange timestamp, so freshness is measured from **fetch
  completion**. That is strictly more conservative than an exchange stamp would be (it can only
  overstate age) but it cannot detect a broker serving a cached book.

## Operating it

There is no configuration to set: the degraded path reports and does not execute. When the feed is
unhealthy, `engine.degradedRecoveryState()` publishes `{ supported, enabled, detail, active,
blocked[] }`, and each affected position carries `exit_blocked_reason`.

**What an operator must do during a feed outage with open exposure:** reduce at the broker terminal.
The engine will not do it, and it now tells you that instead of going quiet.
