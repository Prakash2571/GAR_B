# Supervised one-lot preflight checklist

For **one** four-leg box entry attempt, **one current exchange lot per leg**, with an operator watching.

**Secret-free by construction.** Nothing here asks you to paste a token, passcode or key. Every item is
either a value you read from a status surface or a fact you confirm with the broker.

**Read this first:** every item below is a *runtime* fact. **None of it is verified by the offline test
suite.** The suite proves internal consistency against mocked broker boundaries; it makes no statement
about your account, your permissions, your egress, or the instrument you are about to trade.

---

## 1. Corrections to earlier guidance

Some previously published operational instructions were wrong. Where you find them, this section wins.

| Stale claim | Correct |
|---|---|
| "MongoDB is the authority." | **PostgreSQL is the operational authority; MongoDB is an async read replica.** Durable order intents, sessions and the active-broker record live in PostgreSQL. Anything reconstructed from Mongo alone is a projection, not truth. |
| "Send `x-admin-token` to control the engine." | **There is no admin-token header.** Control uses a **cookie session** minted by `POST /api/access/verify`, plus a **CSRF header** on every mutating request and a same-origin check. A request without the cookie/CSRF pair is refused regardless of any token you supply. |
| "`ok: true` from cancel-working means the account is flat." | **It never did, and it no longer over-claims.** `ok` means *every eligible intent was attempted and none reported a failure*. An intent this session cannot act on is now reported in `failures` with an unresolved reason, which flips `ok` to false and the route to **207**. Read `cancelled`, `failures` and `eligible` — not just `ok`. |
| "Disabling live orders stops everything safely." | Disarming entry must **not** block cancellation, and does not. Exposure reduction (cancel / exit / residual flatten) stays available whenever the session can act on the account at all. |
| "Broker timestamps are comparable with our own." | They are **second-resolution IST wall clock on a different clock**. They are now kept on a separate field (`exchange_updated_at`) precisely so they cannot be subtracted from our clock. Latency figures are derived from our clock only. |

---

## 2. Deployment identity

- [ ] **Deployed revision** matches the commit you reviewed. Read it from the running process, not from your local checkout.
- [ ] **Migrations applied** to the PostgreSQL database the process is actually connected to.
- [ ] The process booted **without** config refusals. The eight containment limits now fail closed on an
      explicitly-set invalid value, so a boot failure here is the system telling you a limit you set was
      not usable — fix the value, never remove the variable.

## 3. Instrument

- [ ] Underlying selected, and **only one**.
- [ ] Expiry confirmed against the exchange calendar.
- [ ] **Current lot size** confirmed with the broker today. Lot sizes change; a stale value silently
      changes your position size.
- [ ] Tick size confirmed.
- [ ] `BOX_LIVE_MAX_OPEN_LEG_QUANTITY` set to **exactly one lot**, and
      `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY` to **exactly four lots**. Do not round up "for headroom" —
      the caps are the containment.

## 4. Session limits

- [ ] `BOX_SESSION_MAX_ENTRY_ATTEMPTS=1`
- [ ] `BOX_SESSION_MAX_COMPLETED_TRADES=1`

Both. They are consumed by **different events**: an attempt is spent by *starting* (at admission, before
any POST), a cycle by *succeeding*. Setting only one leaves the other unbounded.

- [ ] Status shows the session **ARMED** before you begin, and you understand that once the attempt is
      spent it will read **BLOCKED** when idle — not ARMED. If you see ARMED alongside an exhausted
      budget, stop: that combination is the defect this release fixed and its presence means you are not
      running what you think you are.

## 5. Exposure is genuinely clean

- [ ] Zero open box positions.
- [ ] Zero working broker orders.
- [ ] Zero residual legs.
- [ ] Zero orders in an unknown state.
- [ ] Reconciliation **complete**, and the reconciled owned exposure matches what you see in the broker's
      own terminal. Check both; agreement between them is the point.

## 6. Market data and fill observation

- [ ] Fresh depth on **all four legs** — not three.
- [ ] You know **how fills will be observed**. Zerodha order streaming is **off by default**; unless it is
      explicitly enabled and demonstrably working, fills arrive via REST polling and are correspondingly
      slower to see.
- [ ] Quote age bound understood: coherence between legs does not make an old price actionable.

## 7. Money

- [ ] Available funds read from the **current account**, and you know **which field** the broker means by
      available margin. This is on the unverified list below.
- [ ] Planned/stage margin for the four legs checked against those funds.
- [ ] `BOX_LIVE_RECOVERY_RESERVE_RUPEES` set to a **justified non-zero** value. Zero withholds nothing for
      unwinding, which is the situation you least want when an entry goes wrong.
- [ ] Capital cap set deliberately, not left at the disabled default.

## 8. Broker and network

- [ ] API permissions active for the product and segment you are trading.
- [ ] **Static egress IP** approved and in force, verified from the deployed host.
- [ ] Rate limits understood. Note that the rate-budget history is **in memory**: a restart forgets prior
      spend, and other applications trading the same account are invisible to this process.

## 9. Recovery

- [ ] **Broker-native access open** in another window, and you have used it before — not for the first time
      under pressure.
- [ ] You have **tested** whatever alerting you rely on. An untested alert is not an alert.
- [ ] You know what you will do if an order goes to `RECONCILIATION_REQUIRED` or a cancellation reports
      unresolved. Decide now, not then.
- [ ] Do not switch to paper mode or restart while assuming live DAY orders have disappeared. They have not.

---

## 10. Still unverified by anything in this repository

These cannot be established by code, and the offline suite does not attempt to:

- Current Zerodha API permissions for this account
- The approved static egress IP
- Funds-field semantics — which field is genuinely available margin
- Current lot size and expiry rules for the chosen underlying
- The published per-endpoint rate limits

The limits encoded in `src/box/brokerPacing.ts` carry `sourceUrl` / `verifiedOn` / `confirmed` fields so
an unverified limit is visible **as** unverified rather than silently trusted. Treat every item above as
an assumption until you have confirmed it externally.

## 11. What the green test suite does and does not tell you

It tells you the system is internally consistent against mocked broker boundaries, with real PostgreSQL
and MongoDB, and that no suite silently skipped.

It does **not** tell you that this code has ever placed a real order — **it has not** — nor that the
broker behaves as modelled. Every assumption about status labels, timestamp formats, error bodies,
rate-limit responses and cancel semantics is a model written from documentation and validated against
itself.

**The single cheapest piece of missing evidence is a paper session against the live feed during market
hours: real ticks, real timestamps, real rate limits, real socket behaviour, zero orders.** It exercises
nearly every broker-shaped assumption in the codebase and risks nothing.
