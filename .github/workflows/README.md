# CI workflows

`ci.yml` is the GTS Algo Research backend pipeline. It runs on every push to `main` and every pull
request, with a read-only token and no repository secrets.

## What it guarantees

1. **Deterministic install** — strict `npm ci` (no `npm install` fallback) plus a lockfile-in-sync
   check, so a stale `package-lock.json` fails the build instead of being silently rewritten.
2. **Build / typecheck** — `npm run build` (which is `tsc -b`, also the typecheck) and an assertion
   that `dist/index.js` was actually emitted.
3. **All suites against REAL databases** — PostgreSQL (`postgres:17.2-alpine`) and MongoDB
   (`mongo:7.0.14`) run as pinned service containers, health-checked and then re-probed from inside
   the job before any test runs. Suites run in order: `test:unit`, `test:invariants`, `test:pg`,
   `test:projector`, `test:tokens`, `test:switch`, `test:access`, `test:shutdown`, `test:readiness`.
   (`test:readiness` is hermetic and DB-independent — it drives the startup-readiness state machine
   plus a loopback express app — but runs here alongside the others under the armed egress guard.)
4. **No silent skips** — each suite's output is captured, and a dedicated step fails the build if
   any database-dependent suite (`pg`, `projector`, `tokens`, `switch`, `access`) — plus the
   always-run `readiness` suite — reports a non-zero `skipped` count or no summary line at all. A
   test that starts skipping because a database went missing turns the build **red**, not green.
5. **Safety defaults** — asserts `.env.example` never sets `BOX_EXECUTION_MODE=live` or
   `BOX_LIVE_TRADING_ENABLED=true`.
6. **No committed secrets** — greps the tracked tree for `.env` / credential / key files (allowing
   only the `.env.example` template).
7. **No broker egress (enforced, two ways)** — a runtime fail-closed guard armed into every test
   suite, plus a Node-independent static backstop job. See "No secrets, no broker" below.

## No secrets, no broker

This workflow requires no repository secret and contacts no real broker, and **both halves are
enforced**, not merely asserted in prose:

- The token suite drives a local mock HTTP server on `127.0.0.1`; the three formerly
  network-dialling suites serve the Dhan scrip master / Kite instrument dump from checked-in
  fixtures via `tests/helpers/hermeticNetwork.mjs`. Every secret referenced (`SITE_ACCESS_SECRET`,
  `BROKER_TOKEN_ENCRYPTION_KEY`) is an obviously fake, inline test value.
- **Runtime enforcement — `.github/ci/no-egress-guard.mjs`.** Every suite in job `test` runs with
  `NODE_OPTIONS=--import .github/ci/no-egress-guard.mjs`. The guard wraps `fetch`, `node:http` /
  `node:https` `request`/`get`, and raw `net`/`tls` sockets so any request to a **non-loopback**
  host throws immediately (fail-closed). Only `127.0.0.0/8`, `::1` and `localhost` are permitted —
  which is exactly what PostgreSQL, MongoDB and the local mock servers use. On a violation it also
  prints a grep-able marker `CI-EGRESS-GUARD: BLOCKED <method> <url>`; the **"Assert the egress
  guard armed and blocked nothing"** step fails the build if that marker appears in any captured
  suite log (so a suite that swallows the thrown error still cannot hide the egress) and also
  requires the guard's `armed` marker in every log (so a `NODE_OPTIONS` regression that silently
  stops loading the guard is caught).
- **Static backstop — `.github/ci/no-live-hostnames.sh` (job `no-live-hostnames`).** A pure
  git + grep scan of the tracked test tree that fails if a live broker hostname
  (`images.dhan.co`, `api.dhan.co`, `auth.dhan.co`, `api.kite.trade`, `calspread.online`) appears
  in **executable** (non-comment) test code. It is Node-independent, so it holds even if the
  runtime guard were removed. Comments and Markdown prose are ignored. The hermetic interception
  seam — `tests/helpers/hermeticNetwork.mjs` and its regression test `tests/box/hermeticNetwork.test.mjs` —
  must name those hosts by design (that is how it serves fixtures) and is allow-listed by path.

### Adding an allowed destination

- **A new loopback service** needs no change: `127.0.0.0/8`, `::1` and `localhost` are always
  allowed by the runtime guard.
- **A test must exercise a broker-shaped endpoint** → drive a local mock on `127.0.0.1` (see
  `tests/tokens/helpers.mjs`) or register a fixture stub via `installHermeticNetwork().stub(...)`
  in `tests/helpers/hermeticNetwork.mjs`. Do **not** loosen the runtime guard.
- **A new file legitimately owns an interception seam** (i.e. it must reference a broker hostname
  as executable code to serve a fixture) → add its repo-relative path to `FILE_ALLOWLIST` in
  `.github/ci/no-live-hostnames.sh` with a one-line justification. Narrow the allowance to the
  specific file; never relax the hostname pattern itself.

## Pinned versions

| Component  | Pin                    |
| ---------- | ---------------------- |
| Node       | `22.23.2`              |
| npm        | `11.4.2`               |
| PostgreSQL | `postgres:17.2-alpine` |
| MongoDB    | `mongo:7.0.14`         |

## Cross-dependency

The `safety-defaults` job reads `.env.example`, which is authored by a separate agent. If that file
has not landed yet, the job fails by design — a runnable backend without a safe example config is
itself worth flagging.
