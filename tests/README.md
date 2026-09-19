# GTS Algo Research backend — test suites

GTS Algo Research is the standalone Box-arbitrage backend extracted from the predecessor codebase. PostgreSQL is
the operational authority; MongoDB is an async replica fed by a bounded outbox. The test
suites below reflect that architecture. Where the predecessor codebase proved a guarantee against MongoDB,
GTS Algo Research proves the SAME guarantee against PostgreSQL.

Run everything with a local PostgreSQL and (for the outbox projector) MongoDB reachable:

```
export DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge
export MONGODB_URI=mongodb://127.0.0.1:57017/strikedge_test
npm run build
npm run test:unit        # tests/box/**   — pure/offline Box engine unit suite (NO database, NO network)
npm run test:pg          # tests/pg/**     — real-PostgreSQL integration (fails loud if PG is down)
npm run test:projector   # tests/projector/** — Mongo outbox projector
npm run test:tokens      # tests/tokens/** — broker-token acquisition/rotation/redaction
npm run test:access      # tests/access/** — site passcode gate (replaces the admin-token layer)
npm run test:switch      # tests/switch/** — broker switch / durable generation
npm run test:shutdown    # tests/shutdown/** — graceful shutdown coordinator + declared order
npm run test:readiness   # tests/readiness/** — startup-readiness state machine (NO database, NO network)
```

## Suite boundaries — what each suite needs

The unit suite is DATABASE-FREE and NETWORK-FREE by design, and this is now ENFORCED (see
"The unit-suite hermetic guard" below). The table records exactly which external service each
suite requires, so an accidental future dependency is obvious:

| Suite | PostgreSQL? | MongoDB? | Network? | Notes |
|-------|-------------|----------|----------|-------|
| unit (`tests/box/`) | **no** | **no** | **no** | Pure/offline. Any test needing a real database belongs in another suite; a static guard fails the suite otherwise. |
| invariants (`tests/invariants/`) | no | no | no | Pure safety invariants. |
| operator-config (`tests/operatorConfig/`) | no | no | no | Pure/offline, and the ONLY suite that runs against `src/**.ts` directly — **no `npm run build` required**. See below. |
| tokens (`tests/tokens/`) | no | no | loopback only | Drives a LOCAL mock HTTP server (127.0.0.1); no real broker. |
| access (`tests/access/`) | no | no | loopback only | Site passcode gate; loopback express app only. |
| switch (`tests/switch/`) | no | no | loopback only | Broker switch; broker egress served from fixtures (hermetic). |
| shutdown (`tests/shutdown/`) | no | no | no | Coordinator driven with fakes. |
| readiness (`tests/readiness/`) | no | no | loopback only | Readiness state machine + loopback express app. |
| pg (`tests/pg/`) | **YES** | no | loopback only | Real-PostgreSQL authority. Fails LOUDLY if PG is down. |
| projector (`tests/projector/`) | no | **YES** | loopback only | Real-MongoDB bounded outbox projector. |

Only `pg` requires PostgreSQL; only `projector` requires MongoDB; every other suite needs
neither. `npm test` runs each suite EXACTLY once (unit → invariants → tokens → access → switch →
shutdown → readiness → `test:integration`, where `test:integration` = pg → projector).

## What each suite covers

| Suite | Directory | Covers |
|-------|-----------|--------|
| unit | `tests/box/` | The Box engine: math, execution, order manager, calibration, reservations (algorithm), Dhan support, projection bookkeeping, config invariants. **Fully pure/offline — needs NO database and NO network.** The one real-PostgreSQL test that used to live here (the daily-risk index probe) was moved to `tests/pg/` so the unit suite is truly database-free, and a static guard (`tests/box/unitSuiteHermetic.test.mjs`) now stops any DB dependency from creeping back in. |
| pg | `tests/pg/` | Real-PostgreSQL authority: reservation port (fences, all-or-none, TTL/expiry, release, GC), order-intent CAS, residual-projection CAS, trades/crash-recovery, one-shot session, **and the residual-projection bookkeeping + daily-risk seed index catalog probe (`executionAttemptProjection.test.mjs`, moved here from `tests/box/` so the unit suite stays database-free)**. Fails LOUDLY if PostgreSQL is unreachable — it never skips silently. |
| projector | `tests/projector/` | The bounded Mongo outbox projector and its resilience/secret-redaction guarantees. |
| tokens | `tests/tokens/` | Outbound broker-token acquisition, key rotation, IST clock, redaction, provider client. |
| access | `tests/access/` | The site passcode gate (`src/access/*`) — cookies, CSRF, rate limit, session store, middleware. |
| switch | `tests/switch/` | Broker switching and durable generation fencing. |
| shutdown | `tests/shutdown/` | The `ShutdownCoordinator` behaviour and the declared step ORDER in `src/index.ts`. |

## Hermetic network — tests NEVER contact a real broker

Every test runs offline against loopback services only (PostgreSQL, MongoDB). No test may
reach a live broker endpoint. This is enforced, not merely intended.

**Why.** Three suites used to make 24 real outbound HTTPS calls per run — 23 to
`images.dhan.co` for the ~201,075-row Dhan scrip master, 1 to `api.kite.trade` for the
Zerodha instrument dump — through the REAL code paths:

- `DhanInstrumentStore.fetchMaster()` (`src/brokers/dhan/instruments.ts`) downloads the
  scrip master on every `switchBroker("dhan", …)` and every `InstrumentProvider.load()`
  while Dhan is active.
- `KiteClient.getInstruments()` (`src/kite.ts`) downloads the Zerodha dump whenever
  `InstrumentProvider.load()` runs while Zerodha is active (e.g. a morning switch back).

That made the suite **non-deterministic** (the live master changes daily), **slow**
(~4.5 s per parse, ~90 s of a CI run) and **network-dependent** (a slow or unreachable
`images.dhan.co` turned CI red for reasons unrelated to the code). A trading system's
tests must not have those properties, and the CI workflow's claim that it never contacts
a real broker must be true.

**How.** `tests/helpers/hermeticNetwork.mjs` installs a `globalThis.fetch` interceptor —
a production-faithful seam that needs NO change to `src/`, because both code paths already
go through `fetch`. It:

1. serves the Dhan scrip master (detailed AND fallback URL) from the trimmed, checked-in
   fixture `tests/fixtures/dhan-scrip-master-detailed.sample.csv`;
2. serves the Zerodha instrument dump from a minimal CSV stub with the exact Kite header;
3. always allows loopback (`127.0.0.1` / `localhost` / `::1`);
4. **fails closed** — a request to any other host THROWS, naming the URL, so an accidental
   future dial-out is a red test rather than a silent egress.

Suites that drive these paths (`tests/box/singleBroker.test.mjs`,
`tests/switch/managerSwitch.test.mjs`, `tests/tokens/morningDefault.test.mjs`) arm the
guard in a `before()` hook and `restore()` it in `after()` so it cannot leak between files.
`tests/box/hermeticNetwork.test.mjs` is the regression guard: it proves the fail-closed
throw fires, that both broker URLs are served from fixtures, and that a real
`DhanInstrumentStore` load touches only `images.dhan.co` (intercepted, never forwarded).

**Fixture provenance.** See `tests/fixtures/README.md`. The fixture is a TRIMMED SAMPLE of
the live master (14 data rows vs ~201k), with the exact upstream header row so the
header-driven parser maps every column by name exactly as in production. It is derived
from real rows, not invented.

**Adding a new stub.** If a new test exercises a code path that calls another broker
endpoint, register it explicitly rather than letting it dial out:

```js
import { installHermeticNetwork } from "../helpers/hermeticNetwork.mjs";

let hermetic;
before(() => { hermetic = installHermeticNetwork(); });
after(() => { hermetic?.restore(); });

// inside a test, before the code path runs:
hermetic.stub("api.dhan.co", (url, init) =>
  new Response(JSON.stringify({ /* whatever the endpoint returns */ }), { status: 200 }));
```

`stub(matcher, responder)` accepts a substring/host string or a `(url) => boolean`
predicate. If you find yourself stubbing a broker's *data* dump broadly, prefer adding a
checked-in fixture (as with the scrip master) so the assertion tests real shape. Never
weaken the guard to "pass through" an unknown host.

## The unit-suite hermetic guard — the unit suite stays database-free

`npm run test:unit` is `node --test "tests/box/*.test.mjs"` and is intended as the
DATABASE-FREE, NETWORK-FREE unit suite. It regressed once: `executionAttemptProjection.test.mjs`
imported the `pg` driver and opened a real connection to PostgreSQL on port 55432, so the "unit"
suite silently depended on a database. That real-PostgreSQL test now lives in `tests/pg/`.

`tests/box/unitSuiteHermetic.test.mjs` makes that regression impossible to reintroduce silently.
It is a STATIC source scan (it reads the source of every sibling `tests/box/*.test.mjs`, it does
not execute them, and it strips comments so documentation cannot false-positive). A unit test
FAILS the guard if it:

1. imports the `pg` or `mongodb` driver (static `import … from`, dynamic `import(…)`, or
   `require(…)` — the only two real database clients in `package.json`);
2. embeds a database port (PostgreSQL `55432`, MongoDB `57017`) — the signature of a hard-coded
   real connection string; or
3. embeds a connection URL (`postgres://` / `mongodb://`) to a non-loopback host.

The guard also asserts a FLOOR on the number of unit files, so an accidental empty glob or a mass
deletion cannot make it (and the suite) vacuously pass. It complements — and does not replace —
the RUNTIME broker-egress interception in `tests/box/hermeticNetwork.test.mjs` +
`tests/helpers/hermeticNetwork.mjs`: that guard fails closed on live broker HTTP egress; this one
closes the database-driver hole. **Keep both.**

## Test files removed during the extraction, and why

Three ported predecessor test files targeted modules this backend deliberately did NOT copy.
Deleting them is correct: a test importing a `dist/*.js` that will never exist is not coverage.

| Removed file | Why | Where the coverage lives now |
|--------------|-----|------------------------------|
| `tests/box/adminToken.test.mjs` | GTS Algo Research REPLACED the predecessor codebase's admin-token layer with the site passcode gate. `src/adminToken.ts` was not copied, so `dist/adminToken.js` never exists. | `tests/access/` (19 tests) — the passcode gate that supersedes the admin token bearer credential. |
| `tests/box/tokenRouteAuth.test.mjs` | GTS Algo Research is a CONSUMER of the predecessor codebase's broker-token routes, not a host of them. `src/tokenRouteAuth.ts` was not copied. | `tests/tokens/providerClient.test.mjs` — the outbound counterpart (GTS Algo Research calling the token provider). |
| `tests/box/mongoReservationIntegration.test.mjs` | Exercised the DELETED `src/box/reservations/mongoStore.ts` (MI1–MI10). PostgreSQL owns reservations now; the Mongo store no longer exists, so these could never pass again. | `tests/pg/reservations.test.mjs` — see the one-to-one map below. |

### Tests trimmed (not deleted)

- **`tests/box/dhanSupport.test.mjs`** — the six `/* history */` tests exercised
  `dhanCandlesToRows` / `chunkDateRange` from `src/brokers/history.ts`, the Kite historical-charts
  provider this backend does not ship. Only those six were removed:
  "Dhan's COLUMN-wise candles transpose into rows", "candles come back oldest-first",
  "a candle with a bad timestamp is dropped", "missing columns become 0",
  "long ranges chunk", "a range within the limit is a single chunk".
  Every other Dhan assertion (segments, token identity, CSV parsing, charges, auth, errors,
  instrument-master quality filtering) is in scope and retained — the file passes with 38 tests.

- **`tests/pg/executionAttemptProjection.test.mjs`** (moved from `tests/box/`) — the five
  `real Mongo:` env-gated tests were removed with the Mongo store and their SQL equivalents
  written (see map). The offline "every daily-risk seed branch is bounded and index-ordered" test
  was REWRITTEN (see below). The whole file moved from the unit suite to the pg suite because its
  index-catalog probe connects to a real PostgreSQL; keeping it under `tests/box/` was the exact
  reason the unit suite was not truly database-free.

## The obsolete Mongo integration tests → their PostgreSQL equivalents

All 17 previously-skipped tests were `BOX_TEST_MONGODB_URI`-gated tests of stores that no longer
exist (the Mongo reservation store and the Mongo order-intent/projection CAS). A test that skips
because its subject was deleted looks like coverage while proving nothing, so each was deleted and
mapped one-to-one to a real-PostgreSQL test. Where no equivalent existed, the missing test was
WRITTEN (marked ✚).

### From `mongoReservationIntegration.test.mjs` (10) → `tests/pg/reservations.test.mjs`

| Deleted Mongo case | PostgreSQL equivalent |
|--------------------|-----------------------|
| MI1 unique multikey index enforces one contract, one reservation | "concurrent acquisition of an overlapping set is all-or-none: one winner" (UNIQUE(deployment,broker,instrument_key); the loser leaves NO key rows) |
| MI2 the unique index is actually created and unique | "ensureReady verifies the schema and answers the clock" + the all-or-none test proving the unique key rejects the overlap |
| MI3 200 concurrent overlapping acquisitions, exactly one winner | "concurrent acquisition of an overlapping set is all-or-none: one winner" (a single transaction rolls back on the first conflicting key) |
| MI4 unrelated boxes execute concurrently | "concurrent acquisition of an overlapping set is all-or-none" (non-overlapping keys both insert) + "deleteByOwnerPrefix removes only this process's leases" |
| MI5 crashed worker's lease reclaimed after TTL, not before | "expiry boundary: a lapsed lease cannot be renewed" + "deleteExpired garbage-collects only lapsed owners, never live ones" (expiry decided from the stored `expiresAt`, not a background monitor) |
| MI6 a stale owner cannot release the new owner's reservation | "release requires exact owner AND fence" (wrong fence releases nothing) |
| MI7 renewal keeps a challenger out until the renewed expiry passes | "renewal is guarded by owner + fence + not-expired" |
| MI8 fencing token monotonic; server clock is authority | "fences are strictly increasing and monotonic" + "ensureReady … answers the clock" (`serverTimeMs` from `clock_timestamp()`) |
| MI9 measured durable acquisition latency | Not reproduced — a benchmark, not a correctness guarantee. Latency is not a behaviour to pin; it is reported at runtime. (Justified omission, not a coverage gap.) |
| MI10 cleanup — drop throwaway collections | N/A — the pg harness gives each file its own schema and `teardown()` drops it. |

### From `fillAttribution.test.mjs` A11/A11b (2) → `tests/pg/orderIntentCas.test.mjs`

| Deleted Mongo case | PostgreSQL equivalent |
|--------------------|-----------------------|
| A11 concurrent guarded updates report deltas that sum to the final cumulative quantity | "two concurrent CAS writers: exactly one wins the same fill" + "concurrent DISTINCT fills: deltas sum to final cumulative" (durable deltas summed under `SELECT … FOR UPDATE`) |
| A11b the pre-image is stamped by the same atomic write; a replay reports a zero-width transition | "idempotent audit replay does not double-append or double-count" (replay reports current−previous = 0) |

### From `executionAttemptProjection.test.mjs` real-Mongo (5)

| Deleted Mongo case | PostgreSQL equivalent |
|--------------------|-----------------------|
| real Mongo: concurrent projection writers apply one charge/version | ✚ `tests/pg/projectionCas.test.mjs` "concurrent projection writers apply one version and record the charge exactly once" |
| real Mongo: a physically legacy row accepts one version-zero CAS | ✚ `tests/pg/projectionCas.test.mjs` "a legacy row with a NULL projection_version accepts exactly one version-zero CAS" |
| real Mongo: recovery index established and duplicate unresolved rows fail closed | `tests/pg/tradesAndRecovery.test.mjs` "single unresolved crash-recovery attempt: the partial unique index admits exactly one" (`box_single_unresolved_crash_recovery` partial UNIQUE index) |
| real Mongo: crash-only recovery adopts existing boundary across snapshot changes | `tests/pg/tradesAndRecovery.test.mjs` "single unresolved crash-recovery attempt …" (a second `ensureBoxRecoveryExecutionAttempt` adopts the same row rather than minting a competitor) |
| real Mongo: the bounded daily-risk seed is indexed and counts an overlapping row once | ✚ replaced by `tests/pg/executionAttemptProjection.test.mjs` "the daily-risk seed's supporting indexes actually exist in PostgreSQL (pg_indexes)" — asserts the indexes against `pg_indexes`, plus the dedup-by-id assertion in the SQL-source test |

## Tests WRITTEN to close a coverage gap

- ✚ **`tests/pg/projectionCas.test.mjs`** (new file, 3 tests). The residual-projection CAS
  (`applyBoxExecutionAttemptProjection`) had NO PostgreSQL test — only the two deleted Mongo ones.
  Added: concurrent writers apply one version/charge exactly once; a legacy (NULL identity)
  row accepts exactly one version-zero CAS; a stale expected version is rejected without mutating
  the row.
- ✚ **`tests/pg/executionAttemptProjection.test.mjs`** "the daily-risk seed's supporting indexes
  actually exist in PostgreSQL (pg_indexes)" — proves, against PostgreSQL's own catalog, the three
  indexes the seed's `ORDER BY` relies on.

## The rewritten daily-risk seed test

`tests/pg/executionAttemptProjection.test.mjs` — "every daily-risk seed branch is bounded and
index-ordered (SQL source)" + the pg_indexes probe. The original asserted on the literal Mongoose
query text (`.sort()/.limit()/$or`) and a `boxExecutionAttemptSchema.index(...)` call in the old
`model.ts`; both are gone by design. The rewrite pins the SAME behavioural guarantee against the
SQL implementation (`loadBoxLiveRiskSeed`, migration 002):

1. **Bounded** — no `$or`; every one of the three attempt reads carries `LIMIT $n`
   (`BOX_DAILY_RISK_SEED_LIMIT`), so no branch can scan the whole table.
2. **Index-ordered** — each bounded read is ordered so truncation drops the least significant rows:
   - day-scoped: `WHERE flatten_charge_day = $1 ORDER BY flatten_charges_for_day DESC`
   - resolved-today: `WHERE resolved_at >= $1 ORDER BY resolved_at DESC`
   - still-unresolved: `WHERE resolved = false ORDER BY resolved_at DESC`
3. **Deduplicated by id** — overlapping branches merge via `attemptsById.set(r._id, r)`, so a day
   is never charged twice.
4. **Indexes actually exist** — asserted by querying `pg_indexes` (strictly stronger than matching
   source text): `box_execution_attempt_flatten_charge_day (flatten_charge_day, flatten_charges_for_day DESC)`,
   `box_execution_attempts_resolved_at_idx (resolved_at DESC)`,
   `box_execution_attempts_resolved_idx (resolved, resolved_at DESC)`.

## A behavioural fix made in `src/box/repository.ts`

The projection-CAS pg test revealed a genuine gap in `applyBoxExecutionAttemptProjection`. The
version-zero legacy-adoption fallback compared the stored residual to the command's expected
residual with a raw `JSON.stringify(...) === JSON.stringify(...)`. PostgreSQL stores
`residual_exposure` as `jsonb`, which does NOT preserve object key order, so that byte-for-byte
comparison never matched a multi-field leg — a legacy row could never be adopted in production.
The fix compares residual CONTENT via `residualProjectionIdentity(...)`, which canonicalises the
field set and array order (the same order-independent identity used everywhere else). This
restores the exact guarantee the deleted Mongo test proved.

## The shutdown suite (`tests/shutdown/coordinator.test.mjs`)

`ShutdownCoordinator` is driven directly with recording/fake steps (importing `src/index.ts` would
boot a server). A separate group parses the declared step names out of `src/index.ts` to pin the
ordering that cannot be executed offline. Cases:

- steps run in the declared order;
- a second signal is idempotent and BOTH callers observe the same result object;
- a step that throws does not prevent later steps (especially the database closes);
- PostgreSQL is closed LAST, after every other step including a throwing one;
- the deadline is honoured and produces a NON-ZERO exit code (virtual clock);
- SIGTERM NEVER calls anything that could flatten a position (flatten spy asserted uncalled);
- the Mongo flush is BOUNDED — one `runOnce()` pass, not drain-until-empty;
- (source) the declared order matches the specified order:
  block new Box entry → stop scanner discovery → stop mutating HTTP → stop token polling →
  stop market-data subscriptions/socket → stop monitoring/timers → flush bounded Mongo outbox →
  close HTTP/SSE → close Mongo → close PostgreSQL last;
- (source) PostgreSQL is the last declared step and Mongo precedes it;
- (source) the outbox flush is declared as BOUNDED;
- (source) NO declared step names a flatten/liquidate/close-position action.
```


## The operator-config suite (`tests/operatorConfig/`) — the one suite that skips the build

`npm run test:operator-config` is
`node --experimental-strip-types --test "tests/operatorConfig/*.test.mjs"`, and it is the only suite
that imports `src/**.ts` rather than `dist/**.js`.

**Why it is different.** Every other suite asserts against the BUILT output, which is the right
default: it proves the thing that ships. The operator-configuration modules
(`src/box/operatorConfig/`) get a second, narrower treatment because their defining property is that
they are PURE — no `pg`, no `express`, no `mongodb`, no `node:fs`, no reach into the engine, nothing
but types and arithmetic. Running them straight from source, with no build and no devDependencies, is
EVIDENCE of that purity rather than a way around the toolchain. If someone later adds a database call
to `policy.ts`, this suite stops working, which is precisely the alarm we want. Two tests in
`registry.test.mjs` assert the property directly as well:

- `operatorConfig modules import nothing outside their own directory`
- `operatorConfig modules use erasable TypeScript only`

The second matters because `--experimental-strip-types` strips types but TRANSFORMS nothing, so these
modules must stay within erasable syntax (no `enum`, no `namespace`, no constructor parameter
properties). That constraint is what keeps `npm run build` and this harness compiling the same source.

**The resolve hook.** The repo compiles under NodeNext, so a `.ts` file importing a sibling writes
`./precedence.js`. `tests/helpers/tsResolve.mjs` rewrites a RELATIVE `.js` specifier to `.ts` when the
`.ts` exists, and passes everything else to the default resolver — so it can never silently redirect a
package import. `tests/operatorConfig/_harness.mjs` registers it and re-exports the modules.

### What the suite covers (92 tests)

| File | Covers |
|------|--------|
| `precedence.test.mjs` | The containment rule. Missing rows fall through and NEVER resolve to 0; `0 = unlimited` is normalised to `+Infinity` before any comparison so `Math.min(5, 0)` cannot turn a finite ceiling into an unlimited one; a ceiling may be lowered at runtime and never raised; a floor may be raised and never lowered; boolean containment follows the SAFE direction, so an env-enabled protection cannot be disabled and an env-disabled risky feature cannot be enabled; an UNSET env var expresses no bound, so the code default does not become an unraisable ceiling; `isSafer` is direction-aware rather than magnitude-aware. |
| `validate.test.mjs` | Unknown keys refused (including env-var-style names — the API speaks domain keys only); `NaN`/±`Infinity` refused; numeric strings refused rather than coerced; fractions refused for integers; present-but-`null` refused rather than treated as "leave alone"; every numeric setting's declared bounds enforced at both inclusive ends; enum membership; and ALL-OR-NOTHING — one bad field refuses the whole patch and `values` is absent, so nothing can be half-applied. |
| `policy.test.mjs` | The mutation policies. Flatness is all five conditions (open boxes, residual legs, working orders, in-flight executions, clean reconciliation), each with its own named blocker; tightening while armed is allowed and widening is REFUSED with the route to it named; `FLAT_AND_DISARMED` settings are refused while armed even when tightening (the dual-authority settings); `NEXT_SESSION` settings are storable while armed but report `next_arm`, never touching the armed snapshot; a deployment bound is refused rather than clamped; widening requires full admin; the fault-injecting paper profile can never be selected in live. |
| `registry.test.mjs` | The security boundary and the migration guarantee. No registered setting maps to a `secret` or `identity` variable — checked against the REAL `classifyEnvVar` in `src/env/secrets.ts`, plus a test proving the guard throws when one is; no credential name appears in executable code anywhere in the subsystem; no deployment live gate (`BOX_EXECUTION_MODE`, `BOX_LIVE_TRADING_ENABLED`, `ZERODHA_`/`DHAN_LIVE_TRADING_ENABLED`, …) is runtime-configurable and no setting writes a capability field; **every code default is read out of `loadBoxConfig()`'s own source and compared**, which is what makes "first deployment behaves exactly as before" true rather than hoped for; `0 = unlimited` is declared only where a bigger number really is looser; anything `dangerous` is also admin-gated. |
| `snapshot.test.mjs` | Immutability and atomicity. The snapshot and every resolved entry are frozen; a mutation produces version + 1 and leaves the previous snapshot untouched; rebuilding wholesale means a reset row cannot leave a stale value behind; a stale OR ABSENT expected version is refused (absent is stale, not "force"); a deployment clamp is reported on the resolved entry rather than silently applied; accessors throw on an unregistered key instead of returning `undefined`, so a typo in execution code crashes at first use rather than becoming a permissive limit. |
| `exitInvariant.test.mjs` | **The exit / risk-reduction invariant, asserted against the real backend source.** `exposureReductionBlockReason` references no runtime-configurable setting, no `deps.limits`, and depends only on `disposed` + a KNOWN-bad broker session (`=== "unhealthy"`, never `!== "healthy"`); the per-Box capital cap has exactly ONE call site and it is dominated by a `purpose === "ENTRY"` guard; `acquireForExit`/`refsForExit` apply none of the entry admission gates; `EXPIRY_SAFETY` overrides profitability and is not gated by `minExitNetPnl`, whose `clearsFloor` only ever feeds the two VOLUNTARY profit rules; `minExitNetPnl` is absent from the order manager, coordinator and gateway entirely; no execution module imports the config policy/validation modules. |

**A note on the source assertions in `exitInvariant.test.mjs`.** Several of the functions it inspects
take an inline object type (`refsForExit(position: {`, `evaluateExitDecision(args: {`), so
brace-counting from the first `{` after the signature captures the PARAMETER TYPE rather than the
body — and for an assert-this-is-absent test that is a silent false pass, which is worse than a
failure. `functionBody()` therefore skips the parameter list by matching parentheses first, and every
absence assertion is paired with an `assertRealBody()` tripwire naming a token the real body is known
to contain. Keep the tripwires when adding a case.
