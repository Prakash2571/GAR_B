# Backend ⇄ Frontend API Contract (`contract/`)

This directory is the **backend-owned, versioned source of truth** for the shape of
every HTTP/SSE response the frontend depends on. It exists to make a breaking
backend response-shape change **fail CI** instead of silently going stale.

## Why this exists

The frontend's contract tests used to rely on **manually captured JSON fixtures**
(`GTSAlgoResearch_F tests/fixtures/*.json`). Those drift silently: the backend changes a
field, the frontend fixture keeps the old shape, and **both repos keep passing
independently** while production is broken. This contract closes that gap
mechanically:

- The backend **describes** its real response shapes here as JSON-Schema files.
- The backend's own `tests/contract/*.test.mjs` validate **real serialized
  responses** (off a real loopback HTTP server, or from the real serializer/engine
  functions) against these schemas — so a schema that lies about the API fails the
  backend build.
- The frontend **pins** this directory by **commit SHA + digest** (see below) and
  runs the *same* schemas against its decoders — so a backend shape change that the
  frontend has not adopted fails the frontend build.

## What is here

| File | Purpose |
|------|---------|
| `version.json` | `{ contract_version, schemas_sha256 }`. The version the frontend pins. |
| `validate.mjs` | A **dependency-free** JSON-Schema (draft 2020-12 **subset**) validator. Returns a list of precise error paths; a schema using an **unsupported keyword is a LOUD error**, never a silent pass. |
| `digest.mjs` | Computes `schemas_sha256` deterministically over `schemas/**` **and** `protocol.json` (schemas sorted by filename, then `protocol.json` last, exact bytes). |
| `schemas/*.schema.json` | One schema per response shape. |
| `protocol.json` | **Machine-readable protocol constants that are not JSON-Schema shapes** but are still part of the versioned wire contract: `csrf_header` (the request header the SPA echoes the CSRF token in), `session_cookie_default` (the default `SESSION_COOKIE_NAME` from `src/config.ts`), and `csrf_cookie_suffix` (appended to the session cookie name to form the readable CSRF cookie). **The backend owns these values; the frontend MUST read them from this file, never hardcode its own copies.** Covered by `digest.mjs`, so renaming the CSRF header changes `schemas_sha256` exactly as a schema edit would. |

No runtime dependency is added: the backend still ships only `express`, `pg`,
`mongodb`, `dotenv`. `validate.mjs` is a small, unit-tested subset validator
(`tests/contract/validator.test.mjs`).

### The validator subset

Supported keywords ONLY: `type` (incl. unions, which is how nullable is modelled),
`required`, `properties`, `additionalProperties`, `items`, `prefixItems`, `enum`,
`const`, `oneOf`, `anyOf`, `$ref` (to a sibling `*.schema.json`), `minimum`,
`maximum`, and `format: "date-time"` (shallow). Annotation keywords (`$schema`,
`$id`, `title`, `description`, `$comment`, `examples`, `default`, `deprecated`,
`readOnly`, `writeOnly`) are accepted and impose no obligation. **Anything else
throws** — a validator that silently skips a keyword is worse than none.

### Closed vs open shapes

Most shapes use `additionalProperties: false` so an **added** field is also caught,
not just a removed/renamed one. Where a shape is legitimately open (an engine-owned
diagnostic/audit sub-object whose internal fields are not part of the frontend
contract, e.g. `box-status.metrics`, `box-trade.entry_execution`), the property
carries a `$comment` explaining why it is open and the contract pins only its
**presence and JSON type**.

## Protocol constants (`protocol.json`) — the CSRF header is single-sourced here

`protocol.json` holds machine-readable protocol constants that are **not** response
shapes but are nonetheless part of the versioned contract:

| Key | Meaning | Backend source of truth |
|-----|---------|-------------------------|
| `csrf_header` | The request header the SPA must echo the CSRF token in. | `src/access/csrf.ts` `CSRF_HEADER` |
| `session_cookie_default` | The default `SESSION_COOKIE_NAME`. | `src/config.ts` `loadAppConfig` default |
| `csrf_cookie_suffix` | Appended to the session cookie name to form the readable CSRF cookie. | `src/access/cookies.ts` `csrfCookieName` |

**Why this file exists.** The CSRF header name `x-csrf-token` used to be hardcoded
**independently** in the backend (`src/access/csrf.ts`) and the frontend
(`src/api/http.ts`), and each repo tested only its **own** literal. A one-sided
rename therefore passed its own CI while silently breaking authentication. Making
`protocol.json` the single source of truth — and covering it with the digest — closes
that gap: a rename now changes `schemas_sha256`, forcing the coordinated
version-bump procedure below.

- **Backend:** `tests/contract/protocolConstants.test.mjs` asserts `CSRF_HEADER` equals
  `protocol.json.csrf_header`, that `csrfCookieName()` equals
  `<sessionCookieName><csrf_cookie_suffix>`, and that the `src/config.ts` default
  session cookie name equals `session_cookie_default`. A rename on **either** side
  fails the backend contract suite.
- **Frontend (REQUIRED):** the frontend MUST **read the CSRF header name from the
  vendored `contract/protocol.json`** (the same digest-verified copy it pins for the
  schemas) and MUST NOT hardcode its own `"x-csrf-token"` literal. Reading from the
  contract is what makes a rename impossible to ship one-sided: the frontend would
  pick up the new name from the vendored contract, and the digest/version pin forces
  it to re-vendor deliberately.

## The coordinated cross-repo update procedure (FOLLOW EXACTLY)

When you change an API response shape, do this **in order**:

1. **Change the backend serializer / route.** Make the code change in `GTSAlgoResearch_B`
   (`src/box/serialize.ts`, `src/box/engine.ts`, `src/runtime/statusRoutes.ts`,
   `src/brokerRoutes.ts`, `src/access/routes.ts`, `src/box/routes.ts`, …).
2. **Update the schema.** Edit the matching `contract/schemas/*.schema.json` so it
   describes the new shape (add/remove/rename fields, adjust types/enums).
3. **Bump `contract_version`.** In `contract/version.json`, increment
   `contract_version` (semver: patch for additive-optional, minor/major for
   anything the frontend must adapt to).
4. **Regenerate `schemas_sha256`.** Run `node contract/digest.mjs` and paste the hex
   into `contract/version.json`. (The backend test
   `digest: version.json schemas_sha256 MATCHES …` FAILS until you do this, so a
   schema edit without a version bump cannot ship.)
5. **Run the backend contract tests.**
   `npm run test:contract` — this validates the **real** new responses against the
   updated schemas and runs the negative controls. Fix until green.
6. **Copy `contract/` into the frontend and update the pinned SHA + digest.** In
   `GTSAlgoResearch_F`, replace its vendored copy of this directory and update its pin to
   the **backend commit SHA** and the **`schemas_sha256`** from step 4.
7. **Run the frontend contract tests.** In `GTSAlgoResearch_F`, run its contract suite so
   its decoders are checked against the new schemas. Fix the frontend until green.
8. **Merge order: backend FIRST, then frontend.** The backend change is what
   produces the new bytes; merging the frontend first would point it at a shape the
   deployed backend does not yet emit.

### The frontend pins a COMMIT SHA and a DIGEST — never an unpinned download

The frontend must vendor `contract/` at a specific **backend commit SHA** and
verify `schemas_sha256` against `version.json`. A normal frontend build therefore
**never depends on an unpinned, mutable fetch of `main`**: it reads the vendored,
digest-verified copy. Updating the contract is an explicit, reviewed step (6–7
above), not an implicit consequence of the backend moving.

## Schema inventory

Access: `access-verify`, `access-status`.
Runtime/export: `runtime-status` (+ `broker-runtime-status`), `export-status`.
Broker: `broker-status` (+ `broker-session`, `broker-health`),
`broker-switch-blockers`, `broker-select-success`, `broker-select-refusal`.
Box: `box-status`, `box-config`, `box-execution-control` (+ `arm-verdict`),
`box-opportunities` (+ `box-opportunity`, `box-leg-evaluation`),
`box-chains` (+ `box-chain-quote`), `box-open-trades` (+ `box-open-position`),
`box-trades-history` (+ `box-trade`, `box-trade-leg`), `box-execution-attempts`,
`box-events` (+ `box-event-leg`), `box-sse-snapshot`, `sse-envelope`,
`margin-provenance`.

Each schema's `description` states **how the contract test obtains a real sample of
it** — real HTTP against the mounted registrar, or a direct call to the real
serializer/engine method — so the provenance of every validated shape is auditable.

## Shared production projections (`src/runtime/projections.ts`)

Several public shapes are **re-projected** from internal read models inside
`src/index.ts` (the outbox status snapshot → `export-status`; the internal
`BrokerSessionState`/`BrokerHealthState` → `broker-session`/`broker-health`) so an
internal field cannot silently leak onto the wire. Those re-projections live in
`src/runtime/projections.ts` as pure exported functions (`projectExportStatus`,
`projectBrokerSession`, `projectBrokerHealth`). **Production and the contract test
call the identical function**, so the schema is validated against the shape the
endpoint actually emits — not against a hand-written stub that might omit a field.
The `regression: each re-projected shape's REAL key set …` test asserts, in both
directions, that each projection's emitted key set reconciles with its schema.

## Version history

| `contract_version` | Change |
|--------------------|--------|
| `1.0.0` | Initial contract. |
| `1.1.0` | **Additive, backward-compatible clarification.** Declared two fields the backend was *already sending* but the schemas omitted: `enabled` + `connected` on `export-status`, and `state` (`"waiting"｜"expired"｜"ready"｜"standby"`) on `broker-session`. **No wire shape changed** — the endpoints emitted these fields before and after; only the declared types + schemas were corrected to match the real projection. Chosen **minor** (not major) because no consumer that already tolerated the real responses breaks: the fields were present all along, so the change only tightens the schema to document what shipped. Also extracted the inline re-projections into `src/runtime/projections.ts` (zero behaviour change) so the contract tests validate the real projection. |
| `1.2.0` | **Additive protocol surface + schema-fidelity tightening. No wire shape changed.** (A) Added `protocol.json` as the single source of truth for the CSRF header name (`csrf_header`), the default session cookie name (`session_cookie_default`) and the CSRF cookie suffix (`csrf_cookie_suffix`), and extended `digest.mjs` to cover it so a rename changes `schemas_sha256`. The frontend must now read the header name from the vendored contract instead of hardcoding it. (B) `broker-session.schema.json` now marks `account_label`, `established_at` and `expires_at` **required** (nullable type `["string","null"]`) instead of optional, and `src/brokerRoutes.ts` `RedactedBrokerSession` declares them `string｜null` instead of `?` — matching the real `projectBrokerSession`, which has **always** populated all three (possibly `null`). The bytes on the wire are identical before and after; only the declared type/schema now match reality. |

| `1.3.0` | **Additive.** Added `order_stream` to `box-status` (new `order-stream-status.schema.json`): order-update stream health, structurally distinct from market-data health. A healthy tick feed is no evidence that fills are observed promptly, so the two are separate objects. No existing field changed shape. |
| `1.4.0` | **Additive.** Added `execution_funnel` (open observability object — outcome counts with explicit denominators, incremented from real execution events) and `economic_admission` (`object｜null` — the last economic-admission decision with five distinct labelled quantities, or null when no economic control is enabled) to `box-status`. No existing field changed shape. |
| `1.5.0` | **Additive.** Added `market_data_state` (enum: `DISABLED｜CONNECTING｜AUTHENTICATING｜SYNCHRONIZING｜READY｜DEGRADED｜DISCONNECTED｜AUTH_EXPIRED`) and `market_data_health` (open diagnostics object) to `box-status`. `market_data_state` is DISTINCT from the crude `market_data_healthy` boolean and from `order_stream`: `READY` is reachable only after fresh usable depth is observed per traded instrument in the current connection generation — a socket merely being open is not `READY`. No existing field changed shape. |
| `1.18.0` | **Additive, but REQUIRED — the frontend must adopt it.** Added `entry_alerts` to `box-status` (new `entry-alerts.schema.json` + `entry-alert.schema.json`): the per-underlying, aggregated ledger of refused entry attempts, carrying the symbol, the reason, the category, an exact count, first/last timestamps, the newest detail and an operator remedy. **Why it had to exist:** `metrics.execution.rejection_categories` is a process-lifetime metric label space and therefore structurally cannot carry a symbol, `box_execution_attempts` rows are written only once a leg has actually filled, and the `ENTRY_REJECTED_*` trade events are throttled per candidate — so "which stock was refused, and why" was being discarded three separate ways, and a deployment whose session budget was simply spent reported `UNKNOWN_INTERNAL_ERROR: 354`. Chosen **minor** rather than patch because the property is required in a closed schema, so a frontend that has not vendored this contract will fail its own validation. Shipped alongside the backend fix that stopped six real refusal reasons (`session_limit_reached`, `underlying_excluded`, `box_inventory_limit`, `box_capital_limit`, `underlying_already_active`, `execution_mode_mismatch`) from being folded into `unknown_internal_error`; that fix changes which labels appear in the existing open `metrics` object but no field's shape. |

| `1.23.0` | **Additive, but REQUIRED — the frontend must adopt it.** Added seven properties to `box-config` (`GET /api/box/config`): `lot_relative_thresholds` (boolean) plus the six per-unit rates `min_expected_net_profit_per_unit`, `min_gross_edge_per_unit`, `safety_buffer_per_unit`, `expected_entry_slippage_per_unit`, `expected_exit_slippage_per_unit` and `min_exit_net_pnl_per_unit`. **Why it had to exist:** a box's gross edge is `grossEdgePerUnit × lotSize`, but the entry gate, the safety buffer, both slippage allowances and the exit floor were flat rupee figures, so one configured policy meant a *different* per-unit hurdle on every instrument — roughly ₹53/unit on a 35-lot index against ₹0.05/unit on a 40,000-lot single stock, a ~1000x spread. Across a wide universe that is not one policy screening 150 names, it is "never trade the small lots, take almost anything on the large ones", which is why opportunities were scarce and always in the same handful of underlyings. Thresholds now resolve as `max(flat, rate × lotSize)` per candidate; every rate defaults to `0`, which reproduces the previous flat arithmetic exactly, so this release changes no deployment's behaviour until a rate is set. `lot_relative_thresholds` is published because the flat figures alone cannot express which regime is in force. Chosen **minor** rather than patch because the properties are required in a closed schema, so a frontend that has not vendored this contract will fail its own validation. `scanner_config_snapshot` (open by design) additionally freezes the six rates onto every trade, so a fill stays interpretable after the rates are retuned. |
