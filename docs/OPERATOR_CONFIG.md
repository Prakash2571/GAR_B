# Operator runtime configuration

The design of the configuration authority boundary, the precedence rule, and the mutation policies.

- The per-setting classification and the evidence behind each decision: [`OPERATOR_CONFIG_AUDIT.md`](./OPERATOR_CONFIG_AUDIT.md).
- The environment-variable reference, unchanged: [`CONFIGURATION.md`](./CONFIGURATION.md).

> **Implementation status.** The decision core, the wire contract, the database migration and the
> frontend are implemented and tested. The engine/route wiring that makes the persisted values
> actually reach `BoxConfig` is **not yet landed** — see [§7](#7-what-remains). Until it does, every
> value still resolves from the environment exactly as before, which is the intended migration
> behaviour for step one.

---

## 1. The four authorities

The problem this separates: `.env.example` declares 213 variables, all of them genuinely read, and
four different kinds of authority share one file. Changing an ordinary risk parameter therefore means
editing a server `.env` and restarting the process.

| Authority | Owner | Where it lives | Mutable at runtime? |
|---|---|---|---|
| **Secrets** | the deployment's operator | protected secrets file / process env | never; never exposed anywhere |
| **Deployment capability** | the deployment | environment only | never — display-only in the UI |
| **Operator policy** | the trading operator | PostgreSQL (`box_settings`), backend-validated | yes, under a mutation policy |
| **Session authority** | the backend | the durable trading-session record | frozen at arm |

The rule that ties them together: **a runtime control may only remove permission beneath the
deployment's ceiling. It may never widen it.**

### Secrets

Classified by `src/env/secrets.ts` as `secret` | `identity` | `config`. The runtime subsystem
**refuses to register any key whose class is not `config`** — `assertNoSensitiveKeys()` in
`src/box/operatorConfig/registry.ts`, asserted against the real classifier by
`tests/operatorConfig/registry.test.mjs`, including a test that the guard genuinely throws.

No secret appears in the configuration API, in status payloads, in the audit trail, in logs, in SSE,
or in a contract fixture — not even masked. `tests/operatorConfig/contractShape.test.mjs` serialises
the whole payload and searches it for every credential name the backend knows, plus DSN and
bearer-token patterns.

### Deployment capability — env only, four gates

`BOX_EXECUTION_MODE`, `BOX_LIVE_TRADING_ENABLED`, `ZERODHA_LIVE_TRADING_ENABLED`,
`DHAN_LIVE_TRADING_ENABLED`, plus `BOX_SHADOW_MODE_ENABLED` and
`BOX_EXECUTION_COORDINATOR_ENABLED`.

These are **not registered as settings at all**, which is what makes it impossible to turn a paper
deployment live from a browser. Two tests assert it: none of those names is a registered `envVar`,
and no setting writes a capability field on `BoxConfig`. The frontend *displays* their resolved state
and the backend's own `live_capable` verdict, and `DeploymentFacts.tsx` contains no input, no
`onChange` and no mutation import — the read-only-ness is a property of the code rather than a
`disabled` attribute.

---

## 2. Precedence

```
code default  (src/box/config.ts — unchanged, still the floor)
      ↓
deployment / env override  (legacy bootstrap input)
      ↓
persisted runtime operator override  (box_settings)
      ↓
session snapshot  (arm-time freeze; applies only to the two session ceilings)
```

With two mandatory deviations from naive layering.

### 2.1 Capability is not overridable

Category C never enters the registry. A runtime value resolving "live" where the deployment says
paper is a bug, not a precedence question.

### 2.2 Safety bounds compose; they do not replace

Each setting declares a `containment` mode:

| Mode | The env value means | Effective |
|---|---|---|
| `replace` | a default | the runtime value supersedes it |
| `ceiling` | an **absolute deployment maximum** | the stricter of the two |
| `floor` | an **absolute deployment minimum** | the stricter of the two |

Two details make this correct rather than approximately correct:

**"Explicitly set" is the hinge.** A ceiling only contains when the deployment actually stated one.
If an unset variable were treated as a ceiling, the code default would silently become an unraisable
maximum, so a deployment that never mentioned a limit could never have it raised from the UI. That is
not containment; it is an accident that looks like containment. `envPresent` uses the same "blank is
not a value" rule as `src/env/layer.ts`, so a process manager injecting `FOO=` cannot create a
phantom ceiling.

**`Math.min` is wrong here.** Several ceilings read `0` as UNLIMITED — `BOX_MAX_OPEN_BOXES`,
`BOX_LIVE_DAILY_LOSS_LIMIT`, `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES`. `Math.min(5, 0)` is `0`, which would
convert a finite deployment limit into no limit at all. Every comparison happens in a normalised
space where `0` has become `+Infinity`, and the result is denormalised on the way out.

`0` does **not** mean unlimited everywhere, and the difference is enforced per setting:

| Setting | `zero_means` | Why |
|---|---|---|
| `maxOpenBoxes`, `liveDailyLossLimit`, `liveMaxBoxCapitalRupees`, `maxUnderlyings`, `maxConcurrentPerUnderlying`, `sessionMax*` | `unlimited` | the code tests `limit > 0` before enforcing, so `0` disables the gate |
| `liveMaxOpenBoxes`, `liveMaxResidualLegs` | `value` | the order manager tests `openBoxes >= limit` / `residualLegs > limit`, so `0` is the **most** restrictive value, not the least |
| coherence/dispersion bounds | `disabled` | `0` switches the check off but is not a comparable magnitude |

### 2.3 One deliberate exception

`minExpectedNetProfit` and `safetyBuffer` keep `replace` semantics. They are **already**
database-authoritative through the existing `box_settings` rows, and an existing deployment may have
deliberately persisted a value below its env figure. Changing them to `max(env, runtime)` would alter
the behaviour of a live deployment on upgrade. Called out here rather than smoothed over.

### 2.4 Provenance

Every setting reports where its effective value came from: `default` | `env` | `runtime` |
`runtime_clamped_by_env`. The last is the one that matters — the operator's value is **not** in force
— and it travels with `clamped_by_deployment: true` and the `deployment_bound`, so the UI shows both
numbers instead of quietly displaying the smaller one.

---

## 3. Mutation policies

| Policy | Meaning |
|---|---|
| `HOT_SAFE` | apply immediately; cannot widen risk in any state |
| `TIGHTEN_ONLY_WHILE_ARMED` | while armed, only a change in the safer direction is accepted |
| `FLAT_AND_DISARMED` | no open box, no residual exposure, no working orders, nothing in flight, reconciliation clean, session disarmed |
| `NEXT_SESSION` | store the configured value; never touch the armed snapshot |
| `RESTART_REQUIRED` | read-only from the API |

"Tighten" is defined **per setting** by `safe_direction`, because it is not a property of the number:
raising `minExpectedNetProfit` is safer, raising `maxOpenBoxes` is not, and both are a bigger number.
`safe_direction` is published on the wire so the frontend decides which edits need confirmation from
backend metadata rather than reimplementing the rule.

Refusals are always **named**. Nothing is silently deferred, and nothing is partially applied: one
invalid field refuses the whole patch, and the success path returns no `values` at all on failure, so
there is nothing a caller could half-apply.

### 3.1 Why four settings are `FLAT_AND_DISARMED` rather than tighten-only

`liveMaxBoxCapitalRupees`, `liveMaxOpenLegQuantity`, `liveMaxGrossOpenLegQuantity` and
`quoteMaxAgeMs` are each read **twice, from two different places**:

| Setting | Live read | Construction-time copy |
|---|---|---|
| `liveMaxBoxCapitalRupees` | `executionGateway.capitalLimitRupees()` at admission | `orderManagerLimitsFromConfig` → the dequeue re-check |
| `liveMaxOpenLegQuantity` / `...Gross...` | coordinator entry prologue | order-manager quantity envelope |
| `quoteMaxAgeMs` | scanner/gateway/coordinator per evaluation | `MarketDataStateMachine` book age |

Raising one while armed would let admission accept a Box that the send boundary then refuses against
the stale copy — **and by then a session entry attempt has already been spent.** Refusing unless flat
and disarmed is the safe answer for the first release. Republishing the derived copies atomically
(a `BoxOrderManager.setLimits()`) is the better operator experience and is deliberately deferred
behind its own tests.

### 3.2 The session ceilings are never retroactive

`sessionMaxCompletedTrades` and `sessionMaxEntryAttempts` are snapshotted into the durable session
record by `tradingSession.armSession()`, and every per-attempt decision compares counters against
**that record**, never against configuration. A change is therefore accepted while armed — it is a
configured value — and reported as `takes_effect: "next_arm"` with the armed session's frozen figure
sent alongside it as `session_snapshot_value`. The UI renders the two separately, so a newly
configured budget can never be read as the one in force.

One live read survives arming: `tradingSessionStore.enforcing()` consults current configuration to
decide whether the session layer has any opinion at all. Raising a ceiling from `0` can therefore
switch the layer **on** mid-process. It can never widen an armed session's ceilings.

---

## 4. The exit / risk-reduction invariant

**Configuration may block speculative ENTRY. It must never block risk reduction.**

This is structural, not a rule the code remembers. The configuration subsystem decides whether a
*configuration write* is permitted; it is never consulted on an order path. Exit, protective
cancellation, emergency residual flatten, reconciliation-required reduction and recovery/unwind do not
import it and cannot be refused by it.

`tests/operatorConfig/exitInvariant.test.mjs` asserts this against the real backend source rather
than trusting the prose:

- `exposureReductionBlockReason` references no registered setting, no registered env var, and no
  `deps.limits` at all; it depends only on `disposed` and a **known-bad** broker session
  (`=== "unhealthy"`, never `!== "healthy"`, so an unverified session can still get flat).
- `capitalBlockReason` has exactly **one** call site, and the `purpose === "ENTRY"` guard provably
  dominates it inside the enclosing method.
- `acquireForExit` / `refsForExit` apply none of the entry admission gates and reference no
  registered setting.
- `EXPIRY_SAFETY` overrides profitability and is not gated by `minExitNetPnl`, whose `clearsFloor`
  only ever feeds the two voluntary profit rules. `minExitNetPnl` is absent from the order manager,
  the coordinator and the gateway entirely.
- No execution module imports `operatorConfig/policy` or `operatorConfig/validate`.

`minExitNetPnl` is therefore safe as `HOT_SAFE`: raising it delays an automatic take-profit, which is
a legitimate strategy decision, and cannot prevent getting flat. The UI labels it "Minimum profit to
take" and states that it is not an exit permission.

---

## 5. Performance

No PostgreSQL read on any market tick, scanner candidate or broker order.

- The durable store is consulted at boot and on an accepted mutation, never on a hot path.
- Between mutations every read is a synchronous lookup against a frozen snapshot.
- A mutation builds a **whole new** snapshot at `version + 1` rather than patching in place, so a
  derived value cannot be left over from the previous version and a rollback is exact — the same
  discipline `engine.applyTuning()` already uses when it re-derives the gross prefilter from an
  immutable baseline.

`BoxConfig` itself is **not** frozen, deliberately. `applyTuning()` assigns to its fields and the
scanner, simulator, gateway and coordinator all see the change because they share the reference.
`Object.freeze`-ing it would break the existing tuning API, so the snapshot is a new layer beside it.

`tests/operatorConfig/registry.test.mjs` asserts the subsystem imports nothing outside its own
directory, which is what keeps it off the hot path — and is why the suite can run against `src/**.ts`
directly with no build and no devDependencies.

---

## 6. Persistence and migration

Migration `013_operator_runtime_config.sql`, additive only. Migration `003` is untouched: the runner
records a sha256 per applied file and refuses one that changed after it was applied.

- `box_settings` gains `value_json jsonb` (so booleans and enums can be stored at all — migration
  `012` hit exactly this wall and wrote its own table rather than reuse a numeric-only column) and
  `updated_by`. `value` becomes nullable, with a CHECK requiring **exactly one** of the two value
  columns, so a row can neither disagree with itself nor mean nothing.
- `box_config_version` — a structurally single-row optimistic-concurrency token for the configuration
  as a whole. A PATCH echoes the version it believes it is editing and is refused if anything moved.
- `box_settings_audit` — append-only, recording the configured **and** effective value before and
  after, plus the mutation policy, the new provenance, the session id and the version produced. Those
  two values differ precisely when a deployment ceiling is clamping an operator's figure, and
  "I set ₹150,000" versus "₹120,000 was enforced" is what an incident review needs.

### The migration-safety property

**Nothing is backfilled.** A setting with no row falls through to the environment and then to the
code default. A missing row is never read as `0`, and never as "unlimited".

This is load-bearing rather than tidy: a backfilled `0` on `maxOpenBoxes`, `liveDailyLossLimit` or
`liveMaxBoxCapitalRupees` would convert a finite risk limit into no limit at all. A test asserts the
migration contains no `INSERT INTO box_settings`, and that the only INSERT in the file is the single
version row with `ON CONFLICT DO NOTHING`.

On first deployment, effective behaviour is therefore identical to pre-migration. That is checked
rather than asserted: `registry.test.mjs` reads every code default out of `loadBoxConfig()`'s own
source and compares it to the registry, so the two cannot drift.

---

## 7. What remains

Deliberately not landed, because it cannot be compiled or tested in the environment this work was
produced in (no npm registry access, so no `typescript`/`@types` and no build). Shipping unverified
changes to `engine.ts`, `orderManager.ts` and the route layer of a live-trading system is the one
thing worth refusing.

1. **Repository read/write** for the new columns: a discriminated `{ ok, ... }` result following the
   `loadBoxExcludedUnderlyings` precedent rather than the error-swallowing `loadBoxSettings`, so an
   unreadable store fails entry closed instead of looking like "no rows".
2. **`GET` / `PATCH /api/box/operator-config`** routes, using `projectOperatorConfig` /
   `projectRefusal` from `src/box/operatorConfig/wire.ts`. Risk-increasing changes must be behind the
   existing `requireFull` helper — note that today's `POST /api/box/settings` is `requireOperator`
   only, so a `trade`-role operator can move the live entry gate. Tightening that is a **behaviour
   change** and belongs in release notes.
3. **Snapshot publication**: resolve the snapshot onto the shared `BoxConfig` in one place, following
   `applyTuning`'s re-derive-from-baseline discipline, and decide the dual-authority question in
   §3.1 (refuse, as specified, or add `BoxOrderManager.setLimits()`).
4. **Audit-trail writes**, in the same transaction as the settings write and the version bump.
5. **`effectiveConfig.ts`** needs a `runtime` provenance. It is a CLI pre-flight tool with no database
   awareness and already reports `source: "env"` for the two values the DB can override, so it is
   *already* misleading and will get more so.
6. **`.env.example` regrouping.** The authority map is documented in the file header now, but no
   variable has been moved or marked optional, because until (1)–(4) land the environment genuinely
   *is* the only source. Claiming otherwise in the file operators copy would be the worst possible
   place to be premature.
7. **`tests/pg/`** behavioural tests for the migration and the persistence layer. The current
   migration tests are static hygiene checks; they cannot prove the SQL executes.
