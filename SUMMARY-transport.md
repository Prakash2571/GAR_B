# SUMMARY-transport.md

Three confirmed defects in the GTS Algo Research broker HTTP transport (Zerodha "Kite" + Dhan), fixed on
branch `work/transport`. No real orders placed, no live trading enabled, no deploy, no credential
change; every test mocks all network I/O (injected `fetch` / fake client) and the hermetic-network
guard remains intact.

Baseline (unmodified main): 1742 tests / 1742 pass / 0 fail / 0 skipped.
After fix: **1757 tests / 1757 pass / 0 fail / 0 skipped** (1742 + 15 new).
Failing-first proof per defect is in `EVIDENCE-transport.md`. Handoffs in `HANDOFF-transport.md`.

---

## DEFECT 2 — Dhan immediate terminal response accounting

RE-VERIFIED against current code before changing:
- `src/box/dhanBrokerAdapter.ts` `dhanOrderState()` (its comment admits Dhan reports TRADED for a
  fully executed order and only guards "a TRADED label with a short fill").
- The placement path did `order.state = dhanOrderState(placed.orderStatus, 0, req.quantity)` — a
  terminal state derived from a status string with a **hardcoded 0** filled quantity. Dhan's
  `POST /orders` response (`DhanPlaceOrderResponse` in `src/brokers/dhan/client.ts`) carries ONLY
  `{orderId, orderStatus}` — no cumulative quantity, no average price. An immediate `TRADED`
  therefore became COMPLETE with filled_quantity 0 and NO follow-up order/trade read.

FILES CHANGED & WHY:
- `src/box/dhanBrokerAdapter.ts` (submitOrder post-placement block, ~L427; new
  `hasAuthoritativeQuantity()` ~L519; `refresh()` monotonic guard ~L677):
  - The placement label now only seeds a PROVISIONAL state. A label that CLAIMS a terminal outcome
    (TRADED / PART_TRADED / CANCELLED / CLOSED / EXPIRED / REJECTED) is VERIFIED via an order/trade
    read (`refresh()` → `project()` → real cumulative qty + avg price), never accepted on the label.
  - Evidence obtained → real state with real qty/price (COMPLETE only with a positive, priced fill;
    a short fill stays PARTIALLY_FILLED; a "CANCELLED with a nonzero fill" keeps its real exposure).
  - Evidence not yet visible (read projected a genuine working state) → poll to a verified terminal
    outcome, never COMPLETE-with-0.
  - Evidence impossible (read failed / terminal label with no substantiating qty) → RETAIN
    UNCERTAINTY: `RECONCILIATION_REQUIRED` + `BrokerAmbiguousSubmitError`, blocking dependent
    entries rather than guessing COMPLETE or REJECTED.
  - MISSING quantity vs EXPLICITLY VERIFIED ZERO are distinguished: a REJECTED read with a CONFIRMED
    zero fill is a clean rejection; a terminal claim with no readable quantity is not.
  - Cumulative fills kept MONOTONIC in `refresh()`: a later read can never regress the observed
    quantity (out-of-order REST/stream observations), and the richer fill record is retained;
    per-fill dedup is by `fill_id` at consumption.
  - Recovery/P&L consume only CONFIRMED quantities and prices (they read the projected order, which
    now only reaches a terminal executed state with a positive priced fill).

TESTS (`tests/box/defect2DhanTerminalAccounting.test.mjs`): immediate TRADED, TRADED with no
obtainable evidence (uncertain), TRADED short fill (partial), CANCELLED-with-nonzero-fill
(contradiction), REJECTED-with-confirmed-zero, delayed visibility.

---

## DEFECT 3 — final guards must be at the HTTP send boundary (both brokers)

RE-VERIFIED: the guard (`beforePost`) ran inside the ADAPTER pacer (`this.call(...)` →
`TransportPacer.run`), while the real `fetch` happened further down —
- Dhan: `src/brokers/dhan/http.ts` `request()` chained onto a serialized queue (`this.tail.then`)
  AND slept the residual pacing interval (`await sleep(gap)`) — TWO async waits after the guard.
- Kite: `src/box/kiteBrokerAdapter.ts` `KiteHttpTransport.request()` did `await accessToken()`
  before `fetch` — a promise hop after the guard.

FILES CHANGED & WHY:
- `src/brokers/dhan/http.ts`: added `RequestOptions.beforeSend`; `request()` now invokes it as the
  LAST statement before `fetch()` (~L204/208), after the queue+pacing waits, with NO `await`
  between. `src/brokers/dhan/client.ts` `placeOrder(req, {beforeSend})` forwards it to `write()`.
- `src/box/dhanBrokerAdapter.ts` `submitOrder`: `beforePost` is wrapped into a `beforeSend` passed
  through the pacer AND the lower HTTP queue to the true wire boundary (no longer called inside the
  pacer callback).
- `src/box/kiteBrokerAdapter.ts`: `KiteBrokerTransport.placeOrder(req, {beforeSend})`;
  `KiteHttpTransport.request()` fires `beforeSend()` AFTER the token await and immediately before
  `fetch` (~L231); `placeOrder`/`request` propagate a thrown `BrokerPreSubmitRefusedError`
  unchanged (never wrapped as ambiguous). The adapter passes `beforePost` as `beforeSend`.
- A LOCAL REFUSAL (guard throws) is a proven no-POST: `BrokerPreSubmitRefusedError` propagates
  untouched; nothing is transmitted; it is never a `BrokerAmbiguousSubmitError`. After transmission,
  failures remain ambiguous unless authoritative evidence proves rejection (unchanged).
- The existing `BeforeBrokerPost` caller contract is preserved verbatim: still a synchronous
  callback signalling refusal by THROWING `BrokerPreSubmitRefusedError`; callers pass it exactly as
  before. It is only threaded deeper.

TESTS (`tests/box/defect3SendBoundaryGuard.test.mjs`): use the REAL adapter + REAL transport (real
`DhanHttp` queue, real `KiteHttpTransport`) with only `fetch` injected. Prove (a) a refusal
transmits NO POST, (b) disarming while a POST is QUEUED behind pacing yields NO fetch, (c)
STRUCTURALLY there is no microtask/await/token-hop between guard and fetch. The structural tests
FAIL on the originals and PASS on the fix (see EVIDENCE).

---

## DEFECT 4 — end-to-end deadlines (`src/brokers/dhan/http.ts`, `src/kite.ts`)

RE-VERIFIED: in Dhan `request()` the AbortController timer was created after the pacing sleep and
cleared in `finally` as soon as `fetch` resolved (headers) — then `await res.text()` was UNBOUNDED.
Elapsed time used wall-clock `Date.now()`. `read()` looped `maxReadAttempts` with each attempt
getting a fresh full `timeoutMs`. In `src/kite.ts`, every `KiteClient` REST method did
`await fetch(...)` (no timeout) then `await res.json()`/`res.text()` — both unbounded.

NEW DEADLINE MODEL:
- `src/brokers/deadline.ts` (new): a `Deadline` is an ABSOLUTE expiry on a MONOTONIC clock
  (`performance.now()`), created ONCE and threaded through every layer. `remainingMs()`/`timerMs()`
  let each layer bound its wait by the ONE budget. `Date.now()` is retained only for calendar
  stamps (`created_at`/`updated_at`), never for durations.
- `src/brokers/dhan/http.ts`: one `Deadline` per attempt bounds the QUEUE wait, the pacing sleep,
  the network round trip AND the body read (the same AbortController now stays armed across
  `res.text()`). An expired queued write is abandoned BEFORE the wire (never transmitted late).
  `read()` builds ONE absolute deadline and threads it into every retry AND every backoff sleep, so
  retries share a single budget instead of restarting it. The pacing sleep never overruns the
  deadline. Order MUTATIONS still get exactly one attempt (`write()`), never retried on transport
  error — strengthened, not weakened. Uncertainty after a possible-reach is preserved
  (`DhanNetworkError` from the order path stays ambiguous). The `tail` is still recovered
  (`scheduled.catch(() => undefined)`) so a refusal/timeout cannot strand or wedge it.
- `src/kite.ts`: added `withDeadline()` + `getJson()`/`postJson()` helpers; every `KiteClient` REST
  call (profile, all quote variants, basket margin, order charges, historical candles) now reads
  BOTH headers and body inside one monotonic deadline (`KITE_HTTP_TIMEOUT_MS`, default 8s, env
  overridable). The historical path keeps its gate but also gains the hard network+body bound.
- Kite order path (`KiteHttpTransport.request`): the single AbortController already spans headers +
  `response.json()`; comment clarified. Protective actions (cancellation) already run via
  `withDeadline(...)` in the adapter with an explicit `cancelTimeoutMs`.

Cancellation / fill-confirmation / recovery deadlines are explicit: `cancelTimeoutMs` bounds the
protective cancel and its terminal-confirmation poll loop; the working/ack/partial deadlines bound
`waitForResolution`; both remain in force. Protective cancels use the fast pacing bucket so they
cannot wait indefinitely behind background reads.

TESTS (`tests/box/defect4EndToEndDeadlines.test.mjs`): stalled body aborts under the deadline;
a write that expires while queued NEVER transmits; read retries share one absolute budget; elapsed
time uses the INJECTED monotonic clock (not `Date.now()`). On the original `http.ts` the stalled-
body test HANGS unbounded (killed at 60s) — the defect itself; the fix passes promptly.

---

## Exact test counts
- Baseline main: 1742 / 1742 / 0 / 0.
- After fix (`node --test "tests/**/*.test.mjs"`): **1757 / 1757 / 0 / 0**.
- New: 6 (Defect 2) + 5 (Defect 3) + 4 (Defect 4) = 15.

## Files changed
- NEW `src/brokers/deadline.ts` — monotonic absolute `Deadline`.
- `src/brokers/dhan/http.ts` — deadline through queue/pacing/network/body; final send guard;
  retries share one budget.
- `src/brokers/dhan/client.ts` — `placeOrder` forwards `beforeSend`.
- `src/box/dhanBrokerAdapter.ts` — Defect-2 terminal verification + monotonic fills; Defect-3 guard
  threaded to the wire.
- `src/box/kiteBrokerAdapter.ts` — Defect-3 guard at the send boundary; refusal propagation.
- `src/kite.ts` — Defect-4 bounded reads for all KiteClient REST calls.
- NEW tests: `tests/box/defect2DhanTerminalAccounting.test.mjs`,
  `tests/box/defect3SendBoundaryGuard.test.mjs`, `tests/box/defect4EndToEndDeadlines.test.mjs`.
- Test fakes made faithful to the real send boundary (invoke `beforeSend`) in
  `tests/box/kiteBrokerAdapter.test.mjs`, `tests/box/dhanAdapter.test.mjs` — assertions unchanged.

## HANDOFF items (detail in HANDOFF-transport.md)
- No changes needed in the hedge- or pacing-owned files. `BeforeBrokerPost` contract preserved
  source-compatibly; `TransportPacer` used unchanged; Dhan HTTP floor still matches the pacing
  profile (120ms). No new config knob (reused `liveHttpTimeoutMs` / `DHAN_HTTP_TIMEOUT_MS`;
  `KITE_HTTP_TIMEOUT_MS` is a new optional env with a safe default, requiring no config.ts change).

## Remaining limitations only real broker observation could settle
- Whether Dhan's `POST /orders` EVER returns a cumulative quantity/price alongside `TRADED` in
  practice (the type says it does not); if a future API revision adds them, the verification read
  becomes a fast-path confirmation rather than the sole source — the fix is still correct either way.
- Real-world propagation delay between an immediate `TRADED` and the order/trade book showing the
  fill (the poll cadence and working/partial deadlines are configured, but the true distribution is
  only measurable live).
- Exact wall-clock ceilings for stalled headers vs stalled bodies at Dhan/Zerodha under load — the
  code now BOUNDS both by the same deadline, but the right default budget is an operational tuning
  question that only production latency histograms can settle.
