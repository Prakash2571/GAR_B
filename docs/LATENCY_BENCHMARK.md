# Offline Composed-Path Execution Benchmark (item 9)

This document describes the offline latency benchmark for the GTS Box live box-arbitrage
execution path, why the previous benchmark was misleading, what the replacement measures, and —
most importantly — what it **can** and **cannot** tell you.

> **Read this first.** Every broker/environment delay in this benchmark is an **ASSUMPTION we
> chose**, not a measurement. No number here is measured Mumbai broker latency, and no
> four-leg-completion count here is a guaranteed fill rate. The offline benchmark measures **our
> own code**; the broker is not modelled and cannot be. See *Limits* below.

---

## 1. The defect in the old benchmark (`bench/executionLatency.mjs`)

The old benchmark was a virtual-clock simulation of the pacing arithmetic only. It did **not**
run the composed production path, and it had three specific flaws (all reproduced before any
change):

### Flaw 1 — it treated most POST responses as fill confirmation
In `bench/executionLatency.mjs` the per-leg simulation set the leg's confirmation instant equal to
the POST response instant for the majority of legs:

```
bench/executionLatency.mjs:178   const respondedAt = await pacer.run(async () => { … return clock.now(); }, "order_mutation");
bench/executionLatency.mjs:195   let confirmedAt = respondedAt;           // ← POST response == "confirmed"
bench/executionLatency.mjs:196   if (rand() < ASSUMPTIONS.partial_fill_rate) {   // only the 20% partial path did more
bench/executionLatency.mjs:197     confirmedAt = await pacer.run(async () => { … }, "general");
bench/executionLatency.mjs:202   return { sentAt, confirmedAt };
```

So ~80% of legs were "confirmed" the instant the POST returned. In reality a POST/ACK proves an
order was *accepted*, never that any quantity *executed*.

### Flaw 2 — it skipped the ordinary REST confirmation the real adapters perform
Because `confirmedAt = respondedAt` for the non-partial majority (line 195), those legs never
performed the REST `getOrder` read that the real `KiteBrokerAdapter.waitForResolution` loop does on
every poll (`src/box/kiteBrokerAdapter.ts:976  transport.getOrder(...)`). The old benchmark's only
status read was the 20% partial-fill branch — the ordinary confirmation was absent.

### Flaw 3 — it summed concurrent waits on one shared virtual clock
The old virtual clock advanced a single counter on every wait:

```
bench/executionLatency.mjs:49   wait: async (ms) => {
bench/executionLatency.mjs:51     if (delta > 0) t += delta;      // every wait ADDS to one shared clock
bench/executionLatency.mjs:57   advance: (ms) => { t += guard(ms, "advance"); },
```

Reproduced empirically: two **concurrent** 100 ms waits complete at **t = 200**, not t = 100.
Every "concurrency 2 / 4" figure the old benchmark printed was therefore inflated by serialising
waits that a real event loop overlaps.

---

## 2. What the replacement measures — the ACTUAL composed production path

`bench/composedLatency.mjs` drives the **real production classes**, not reimplementations:

```
BoxOrderManager.submit                (real — persistence-before-transport, queueing, concurrency)
   → durable persistence (MemoryPersistence)   real guarded-write semantics + injectable PG delay
   → KiteBrokerAdapter.submitOrder     (real — pacer, waitForResolution loop, REST getOrder poll)
      → mocked Kite transport           (place / getOrder / cancel over the virtual clock)
      → mocked order-update stream       (delivered via OrderStreamConsumer.ingestStreamObservation)
   → OrderStreamConsumer                (real — projection + applyOrderUpdate wakes the waiter)
```

This is the wiring the recent commits established: the order-stream consumer
(`src/box/orderStreamConsumer.ts`, constructed in the engine) and the manager's
`orderStreamConsumer` registration BEFORE the POST. The benchmark exercises that path so the two
named flaws are **structurally impossible**:

- The real waiter only breaks on a broker-**confirmed terminal** snapshot
  (`COMPLETE`/`CANCELLED`/`REJECTED`); an ACK is never a fill. (Flaw 1 gone.)
- The real `waitForResolution` calls `transport.getOrder(...)` every poll; a healthy stream only
  makes the SAME confirmed truth arrive **sooner**, it never removes the REST confirmation.
  (Flaw 2 gone.)

Guarded by `tests/box/benchComposedPath.test.mjs`.

### Time base — a correct discrete-event scheduler
`bench/scheduler.mjs` replaces the summing clock. `wait(ms)` registers a timer at `now + ms` and
returns a promise; the clock only advances to the **next** scheduled event in `drain()`. Two timers
at the same instant both fire there, so **concurrent waits overlap**. It has the same `{now, wait}`
shape the real `KiteBrokerAdapter` accepts, so the adapter's pacer, waiter and REST cadence run
unmodified on it.

Correctness proof: `tests/box/benchScheduler.test.mjs` — *"two concurrent 100ms waits complete at
t=100, NOT t=200"* passes, alongside sequential-adds-to-200 and staggered-deadline tests.

### Dhan runs on wall time (separate harness)
The `DhanBrokerAdapter` pacer and poll loops use `Date.now()`/`sleep()` (only *duration deadlines*
take an injected monotonic clock), so it cannot run on virtual time. `bench/compositeRealTimed.mjs`
exercises the **real** `DhanBrokerAdapter` `submitOrder → waitForResolution → getOrder` path on real
wall time with deliberately small assumed delays. Its figures prove the real Dhan path executes and
measure our overhead on it; they are **not comparable** to the Kite cells and are not Dhan latency.

---

## 3. Scenarios

Run at concurrency 1, 2, 4 with **identical seeds** across configurations (so comparisons are
meaningful): `healthy_stream`, `rest_fallback` (stream off), `stream_flap` (disconnect/reconnect
mid-entry), `delayed_fills`, `partial_and_cancel`, `rate_limited` (elevated 429), `pg_delay` (slow
durable write on the critical path), `updates_precede_ack` (a push event resolves before the HTTP
ACK's first poll).

Metrics reported per cell as **distributions** (p50 / p95 / max), not just a mean:
detection→first-send, first→last-send, first observed fill, four-leg completion, cancel-to-terminal,
fill dispersion, persistence/pacing components, REST-poll vs applied-observation counts, a
four-leg-completion histogram, and honest per-leg outcome accounting
(completed/partial/cancelled/rejected).

---

## 4. How to run

```bash
cd /home/ubuntu/Cal/wt2/bench
npm run build
node bench/composedLatency.mjs                 # human-readable report (default 300 iters/cell)
node bench/composedLatency.mjs --json           # machine-readable
node bench/composedLatency.mjs --iterations=50  # quicker
node bench/compositeRealTimed.mjs               # REAL DhanBrokerAdapter, wall time (smoke)
```

No network, no broker, no database. The CI egress guard and the hostname scan both pass; the
benchmark makes no outbound requests.

---

## 5. Representative results (SIMULATED — assumptions labelled)

Iterations per cell: 300. Time base: discrete-event scheduler. Broker: **zerodha profile**.
Values are p50/p95/max in ms unless noted. **All broker delays below are ASSUMPTIONS, not
measurements.**

Assumed broker/environment delays (INPUTS we chose):

| assumption | spec (ms) |
| --- | --- |
| `post_ms` (POST→ACK) | min 40, p50 70, p95 160, outlier 900 @5% |
| `status_read_ms` (one REST getOrder) | min 30, p50 50, p95 90 |
| `fill_after_ack_ms` (ACK→COMPLETE snapshot) | min 60, p50 180, p95 650, outlier 1800 @4% |
| `partial_first_ms` | min 40, p50 110, p95 380 |
| `cancel_ms` (cancel→ack) | min 40, p50 80, p95 200 |
| `stream_delivery_ms` (terminal→push event) | min 5, p50 15, p95 45 |
| `pg_intent_write_ms` (durable write, normal) | min 2, p50 4, p95 12 |
| `pg_intent_write_slow_ms` (pg_delay scenario) | min 40, p50 90, p95 250 |
| `partial_fill_rate` | 0.20 |
| `rate_limit_rate` (baseline) | 0.03 (25% in `rate_limited`) |
| `retry_after_ms` | 1000 |

Four-leg completion (p50/p95/max ms) and REST-poll/applied-observation medians:

| scenario | conc | det→1st send | 1st→last send | first fill | four-leg complete | rest/extobs | 4/4 legs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| healthy_stream | 1 | 110/110/110 | 1546/2995/4555 | 465/1301/2857 | 2196/3778/5354 | 10/4 | 300/300 |
| healthy_stream | 2 | 110/110/110 | 857/2117/3768 | 443/1294/2171 | 1592/3110/5116 | 8/4 | 300/300 |
| healthy_stream | 4 | 110/110/110 | 857/2117/3768 | 443/1294/2171 | 1592/3110/5116 | 8/4 | 300/300 |
| rest_fallback | 2 | 110/110/110 | 940/2164/3280 | 553/1351/2346 | 1763/3298/4763 | 10/4 | 300/300 |
| stream_flap | 2 | 110/110/110 | 887/2130/3768 | 553/1308/2171 | 1658/3170/5116 | 9/4 | 300/300 |
| delayed_fills | 2 | 110/110/110 | 1770/3747/4758 | 902/1878/3125 | 3351/5445/7605 | 24/4 | 300/300 |
| partial_and_cancel | 2 | 110/110/110 | 887/2113/3197 | 437/1294/2172 | — (forced cancel) | 44/4 | 0/300 |
| rate_limited (25%) | 2 | 110/110/110 | 1593/3045/5027 | 668/2222/3162 | 2487/4381/7203 | 8/4 | 300/300 |
| pg_delay | 2 | 166/345/390 | 1195/2508/3891 | 670/1483/2150 | 2113/3574/5388 | 8/4 | 300/300 |
| updates_precede_ack | 2 | 110/110/110 | 1231/2135/3207 | 501/1083/1896 | 1730/2715/3710 | 0/4 | 300/300 |

Reading the table honestly:

- **Concurrency 2 and 4 are identical** because a hedge-first wave has only two legs; concurrency
  2 already saturates a wave, and concurrency 4 cannot overlap more than two legs per wave. Raising
  concurrency overlaps legs *within* a wave; it never overlaps a dependent SELL with the hedge it
  depends on, so it does **not** collapse four-leg execution to one round trip.
- **`pg_delay` moves `det→1st send` from 110 to 166–345 ms** — a real durable-write cost on the
  critical path, not the broker.
- **`updates_precede_ack` shows `rest polls` p50 = 0**: with a fast push stream the event resolves
  the waiter before the first REST poll fires. The REST poll is still *armed* as the fallback and
  is used the instant the stream is silent (see `rest_fallback`, where REST is the sole path).
- **`partial_and_cancel` shows 0/300 four-leg completions** — honest: forcing a protective cancel
  on one leg means no full box is expected. The cancelled legs are counted (300 cancelled), never
  hidden to flatter a success rate.

Dhan real-timed smoke (REAL `DhanBrokerAdapter`, wall time, small assumed delays — **not
comparable, not Dhan latency**): 20/20 four-leg completions; place calls = 4; REST getOrder
confirmations used = 4 per entry set — proving the real Dhan place→ACK→REST-poll→terminal path runs.

---

## 6. Limits — what this benchmark can and cannot tell you

**It CAN tell you:**
- The **cost of our own code** on the composed path: durable-intent write ordering, the adapter's
  pacing arithmetic, the `waitForResolution` loop, the REST-poll cadence, the order-stream
  projection/wake, and `BoxOrderManager` queueing/concurrency — all real code under test.
- How concurrency overlaps legs within a hedge-first wave (and why it does not make four-leg
  execution atomic).
- That a healthy order stream makes the SAME confirmed fill arrive sooner while REST remains the
  fallback.

**It CANNOT tell you (and must never be quoted as):**
- **Live Mumbai broker latency.** Every broker delay is an assumption we chose.
- **Any fill rate or four-leg-completion rate as a guarantee.** The completion counts are a
  property of the assumed reject/cancel/partial rates, not a promise.
- **Exchange queue position, matching-engine behaviour, TLS/network path, or broker-side load** —
  none are modelled and none can be, offline.

**Supervised live evidence still needed** before anyone may assert latency or fill-rate:
1. Timed, supervised paper/live sessions from the Mumbai EC2 host with the real brokers, recording
   detection→send→ack→fill from the adapter's own timing instrumentation.
2. Observed REST-poll vs stream-event confirmation timing against the real order stream.
3. Real 429/Retry-After behaviour and real partial-fill/cancel distributions per broker.
4. A real-timed Dhan run corroborated against live observations.

---

## 7. Files

| file | role |
| --- | --- |
| `bench/scheduler.mjs` | correct discrete-event scheduler (concurrent waits overlap) |
| `bench/assumptions.mjs` | the single, labelled source of all assumed broker delays + RNG |
| `bench/composedHarness.mjs` | durable-persistence mock + mocked Kite transport/stream (over the scheduler) |
| `bench/runner.mjs` | one four-leg entry through the composed real classes; span capture |
| `bench/scenarios.mjs` | scenario catalogue (identical seeds across configs) |
| `bench/composedLatency.mjs` | the benchmark driver + honest report |
| `bench/compositeRealTimed.mjs` | real `DhanBrokerAdapter` on wall time (separate, non-comparable) |
| `bench/executionLatency.mjs` | the OLD pacing-only benchmark, retained for reference/comparison |
| `tests/box/benchScheduler.test.mjs` | scheduler-correctness proof |
| `tests/box/benchComposedPath.test.mjs` | defect-regression guard on the composed path |
