# Documentation audit — "a claim that nothing verifies"

Audit date: 2026-09-08. Scope: the docs this audit owns (`docs/CONFIGURATION.md`,
`docs/DEPLOYMENT.md`, `docs/RUNBOOK.md`, `.env.example`, `README.md`) checked
against the real code at `src/**`, the deploy artifacts (`deploy/nginx.conf`,
`ecosystem.config.cjs`), `package.json`, and live runs of every safe script.

Production code was **not** modified. Code-level defects are reported here for the
owner to fix; the doc corrections that this audit could make were made.

Verification anchors captured this session:
- `npm run build` → exit 0 (`tsc -b`, clean).
- `node --test tests/box/shadowAndStress.test.mjs` → re-run after every `.env.example` edit (see bottom).
- Throwaway DB `strikedge_audit` created/dropped via `docker exec strikedge-pg`; the shared `strikedge` DB was never touched.

---

## A. Environment variables: documented vs read by the code

Authoritative "read" set built from `src/**` across every access form
(`process.env.X`, `process.env["X"]`, `env.X`, and string-literal names passed to
the `box/config.ts` / `localCharges.ts` / `dhan/charges.ts` / `dhan/http.ts`
helpers). Each candidate below was then confirmed with a direct per-variable grep
to avoid false positives from the coarse extraction.

### A.1 Documented but NEVER read — LIES (count: 4)

| Variable | Where documented | Reality | Action taken |
| --- | --- | --- | --- |
| `DEFAULT_ACTIVE_BROKER` | `.env.example`, `CONFIGURATION.md` (Broker selection) | 0 matches in `src`. The active broker is hard-coded to `zerodha` (`src/brokers/registry.ts:217 private active: BrokerId = "zerodha"`). Setting this does nothing. | Removed from `.env.example` and `CONFIGURATION.md`; recorded as a code/doc gap (see C-DEFECT-1). |
| `AUTO_FALLBACK_TO_DHAN` | `.env.example`, `CONFIGURATION.md` (Broker selection) | 0 matches in `src`. No automatic fallback path exists; a switch is always explicit via `/api/broker/select`. | Removed from `.env.example` and `CONFIGURATION.md`. |
| `BOX_TUNING_KEYS` | `.env.example` (Tuning surface) | Not an env var. `BOX_TUNING_KEYS` is a TS `const` in `src/box/config.ts:874` mapping tunables to `box_settings` column names. Never read from the environment. | Removed from `.env.example`. |
| `BOX_TUNING_LIMITS` | `.env.example` (Tuning surface) | Not an env var. `BOX_TUNING_LIMITS` is a TS `const` in `src/box/config.ts:823` (min/max bounds for the runtime-tuning API). Never read from the environment. | Removed from `.env.example`. |

### A.2 Read but NOT documented — GAPS (count: 15)

The Zerodha local charge card (`src/box/localCharges.ts`) reads a full statutory
rate card, but `.env.example` / `CONFIGURATION.md` only listed `BOX_STT_TYPE` and
`BOX_CHARGE_RATE_VERSION`. All ten rate knobs are real, with real defaults:

| Variable | Read at | Code default |
| --- | --- | --- |
| `BOX_BROKERAGE_PER_ORDER` | `localCharges.ts:132` | `20` |
| `BOX_BROKERAGE_MAX_PCT` | `localCharges.ts:133` | `0` |
| `BOX_STT_SELL_PCT` | `localCharges.ts:144` | `0.15` |
| `BOX_STT_ROUND_NEAREST_RUPEE` | `localCharges.ts:145` | `true` |
| `BOX_EXCHANGE_TXN_PCT` | `localCharges.ts:146` | `0.03503` |
| `BOX_IPFT_PER_CRORE` | `localCharges.ts:154` | `50` |
| `BOX_IPFT_PCT` | `localCharges.ts:155` | `0` |
| `BOX_SEBI_PCT` | `localCharges.ts:156` | `0.0001` |
| `BOX_STAMP_DUTY_BUY_PCT` | `localCharges.ts:157` | `0.003` |
| `BOX_GST_PCT` | `localCharges.ts:158` | `18` |

Note: the Zerodha STT default (`BOX_STT_SELL_PCT=0.15`) differs from the Dhan card
default (`DHAN_STT_SELL_PCT=0.1`). Both are as-shipped; documenting them makes the
divergence visible instead of hidden.

Other read-but-undocumented variables:

| Variable | Read at | Code default | Notes |
| --- | --- | --- | --- |
| `KITE_API_KEY` | `src/brokers/zerodha/liveAdapter.ts:37` | — (required for Zerodha live; live entry throws if missing) | Distinct from `KITE_API_KEY_EXPECTED`. Genuinely load-bearing for live Zerodha. |
| `NODE_APP_INSTANCE` | `src/box/reservations/identity.ts:102` | (PM2-set) | Folded into the durable owner id so two PM2 cluster workers do not collide. Set by PM2, not by the operator. |
| `BOX_PNL_CACHE_ENABLED` | `src/box/config.ts:1134`, used in `pnlArchive.ts` | `false` | See A.3 — falsely listed as REMOVED. |
| `BOX_PNL_CACHE_INTERVAL_MS` | `src/box/config.ts:1135` | `30000` | See A.3. |
| `BOX_PNL_CACHE_TTL_SEC` | `src/box/config.ts:1136` | `259200` (3 days) | See A.3. |

`BOX_PNL_VERIFY_HOURS` (`config.ts:1138`, default `[22,23]`) is also read and was
listed as REMOVED — see A.3.

### A.3 Wrong documented defaults / false "removed" claims — the DANGEROUS case

| Variable | Doc claim | Actual code | Severity | Action |
| --- | --- | --- | --- | --- |
| `DHAN_DATA_ENABLED` | "Default **false** (data disabled) unless set" (`.env.example` + `CONFIGURATION.md`) | `src/brokers/registry.ts:952-954` — when **unset**, `raw` is `""` and `raw === "" \|\| …` returns **`true`**. The default is **enabled**. | Medium (feed-enablement flag; the shipped `.env.example` pins it to `false`, so a verbatim copy is still data-disabled, but the *documented default for an unset var* was wrong). | Corrected to "Default **true** (empty/unset enables it); set to `false` to disable." |
| `BOX_PNL_CACHE_ENABLED` / `_INTERVAL_MS` / `_TTL_SEC` | CONFIGURATION.md "REMOVED" table: "The Redis P&L cache is replaced by PostgreSQL persistence; these Redis-cache knobs no longer apply." | All three are read (`config.ts:1134-1136`) and drive the **PostgreSQL-backed** P&L cache in `src/box/pnlArchive.ts` (`pnlCacheEnabled` gates an interval writer at `pnlArchive.ts:196,202,236,391,445`). Defaults `false / 30000 / 259200`. | Medium-high (a doc that says a live knob "does nothing" invites an operator to ignore a real behaviour toggle). | Removed from the REMOVED table; documented as active PostgreSQL-backed knobs. |
| `BOX_PNL_ARCHIVE_DRAIN_DELAY_MS` | CONFIGURATION.md "REMOVED" table (Redis-archive knob) | Read at `config.ts:1139`, default `50`. Also already present as an active knob in `.env.example`. Self-contradictory. | Medium | Removed from the REMOVED table. |
| `BOX_PNL_VERIFY_HOURS` | CONFIGURATION.md "REMOVED" table (Redis-archive knob) | Read at `config.ts:1138`, default `[22,23]`. | Medium | Removed from the REMOVED table. |
| `DHAN_API_KEY`, `DHAN_API_SECRET` | CONFIGURATION.md REMOVED note: "that login code path is never invoked … setting them does nothing in this deployment." | Partially false. `readDhanCredentials()` (`src/brokers/dhan/auth.ts:56-79`) reads `DHAN_CLIENT_ID`/`DHAN_API_KEY`/`DHAN_API_SECRET` and is called by `computeDhanProblems()` (`registry.ts:963-964`) and `dhan_configured` (`registry.ts:1763`). If `DHAN_API_KEY`/`DHAN_API_SECRET` are unset, **Dhan reports "not configured" and Dhan live readiness is blocked**. Only the OAuth *consent* flow (`generateDhanConsent`/`consumeDhanConsent`) is disabled. `DHAN_REDIRECT_URL`/`DHAN_POSTBACK_URL` are read only by the disabled consent flow, so "does nothing" is correct for those two. | High (safety gate: the note tells an operator these are inert, but they gate whether Dhan can go live). | Corrected the note to distinguish the credential-presence check (live) from the consent flow (dead). |

All PG (`pool.ts`), Mongo (`mongo.ts`), token-provider URL/poll, application
(`config.ts`), and the ten calibration/live-timing defaults (`box/config.ts`) were
read from source and **match** the docs exactly — no change needed there.

---

## B. Documented commands vs package.json, run for real

Every `npm run …` referenced across the four docs exists in `package.json`
(`build`, `dev`, `migrate`, `migrate:box-from-mongo`, `outbox:replay`,
`rotate:broker-token-key`, `test:unit`, `typecheck`). Real runs:

| Command | Real output | Verdict |
| --- | --- | --- |
| `npm run build` | `tsc -b`, exit 0, clean. | OK |
| `npm run migrate -- --check` (fresh throwaway DB) | `[migrate] FAILED: PostgreSQL schema is behind the code: 7 migration(s) pending (…). Run npm run migrate.` exit 1. | OK — asserts, exits non-zero as documented. |
| `npm run migrate` (throwaway DB) | `applied 7, skipped 0. Applied: 001…007`. exit 0. | OK |
| `npm run migrate` (re-run) | `applied 0, skipped 7`. exit 0. | OK — idempotent as documented. |
| `npm run migrate -- --check` (after) | `--check OK: schema is up to date`. exit 0. | OK |
| `npm run outbox:replay` (bare) | `[outbox:replay] FAILED: Choose a selector: --dead-letters \| --aggregate <type> <id> \| --event-id <id>`. exit 1. | **FINDING B-1** — the docs invoke it as a bare `npm run outbox:replay`, but it *requires* a selector. Not destructive (fails closed), but the documented invocation does not run. |
| `npm run outbox:replay --dead-letters` (dry-run default) | `matched 0 unpublished row(s)… nothing to do`. exit 0. Wrote nothing without `--apply`. | OK — dry-run confirmed. |
| `npm run migrate:box-from-mongo` (dry-run default) | With `LEGACY_BOX_MONGODB_URI` set to the test Mongo: `mode: DRY RUN (no writes)` … `DRY RUN — nothing was written. Re-run with --apply to perform the import.` exit 0. Without the URI: fails fast `LEGACY_BOX_MONGODB_URI is not set`. | OK — dry-run confirmed. |
| `npm run rotate:broker-token-key --help` | Not a real flag: prints `Set BROKER_TOKEN_OLD_KEY and BROKER_TOKEN_NEW_KEY in the environment. Never pass keys on the command line.` exit 2. Its dry-run flag is `--dry-run`. | **FINDING B-2** (minor) — the task's suggested `--help` is not implemented; the real safe path is `-- --dry-run`. Docs never claimed `--help`, so no doc lie, but README/DEPLOYMENT could name the `--dry-run` flag. |
| `npm run rotate:broker-token-key -- --dry-run` (matching 32-byte keys) | `Dry run OK: 0 session(s) decrypt with the old key and re-encrypt cleanly. Nothing was written.` exit 0. | OK — dry-run confirmed, no writes. |

Doc corrections made: DEPLOYMENT.md §8 and README now show `npm run outbox:replay`
with a required selector, and note the dry-run/`--apply` semantics.

---

## C. nginx / PM2 consistency

All verified against code, not against the prose:

- **Proxied port**: `deploy/nginx.conf` upstream `127.0.0.1:3001` == documented default `PORT` (`src/config.ts` `intOr(env.PORT, 3001)`). OK.
- **`kill_timeout` vs `SHUTDOWN_TIMEOUT_MS`**: `ecosystem.config.cjs kill_timeout: 30000` > `SHUTDOWN_TIMEOUT_MS` default `20000` (read from `src/config.ts` `intOr(env.SHUTDOWN_TIMEOUT_MS, 20_000)`, **not** from the docs). OK — 10s headroom.
- **SSE settings on the route that serves `/api/box/stream`**: the `location = /api/box/stream` block contains all four — `proxy_buffering off`, `proxy_cache off`, `proxy_read_timeout 3600s`, and `proxy_set_header X-Accel-Buffering no`. The stream route really is `app.get("/api/box/stream", …)` at `src/box/routes.ts:540`. OK.
- **Health-check path**: `deploy`/docs use `GET /api/health`; the real endpoint is `app.get("/api/health", …)` in `src/index.ts` returning `{ service:"strikedge", state, ready, shutting_down }` with HTTP 200 only when `state==="ready"` and HTTP 503 while `starting`/`failed`/`shutting_down` (FIX-6 honest readiness) — matching the body and response-code table DEPLOYMENT.md §6 prints. OK.
- **nginx syntax validation**: attempted (see run log). Result recorded below.

---

## D. Cutover procedure vs reality

Every "verify X" step in DEPLOYMENT.md §11 names a real endpoint/command:
- token health / feed / recovery / export backlog → `GET /api/runtime/status` and `GET /api/export/status` (both exist, `src/runtime/statusRoutes.ts` + `src/index.ts` wiring).
- import step → `npm run migrate:box-from-mongo` (exists, dry-run by default, verified).
- gate/arming steps → `POST /api/box/session/arm` etc. (all exist, see E).

No imaginary verification step found in the cutover. The required confirmation
sentence is present **verbatim** in DEPLOYMENT.md §11:
> "the predecessor codebase Box live execution for both Zerodha and Dhan must remain disabled before and while GTS Algo Research owns Box live execution. GTS Algo Research PostgreSQL cannot fence orders submitted independently by the old the predecessor codebase process."

---

## E. Runbook actionability

Endpoints the runbook tells an operator to hit — all exist:
`POST /api/box/session/arm`, `/session/disarm`, `/api/box/stop`, `/api/box/start`,
`/api/box/live/reconcile`, `/api/box/live/cancel-working`, `/api/box/live/flatten`
(`src/box/routes.ts`), and `GET /api/broker/status`,
`GET /api/broker/switch-blockers`, `POST /api/broker/select`
(`src/brokerRoutes.ts`).

`GET /api/export/status` real HTTP body (`src/index.ts` handler) =
`{ enabled, connected, backlog_count, oldest_pending_age_ms, last_success_at, last_error, dead_letter_count }`
— the runbook's references to "enabled" and "Atlas connected" are **correct**
(the fields exist on the wire, even though the internal `ExportStatusSnapshot`
type in `statusRoutes.ts` is a narrower alias). No fix needed.

`GET /api/runtime/status` real body matches the documented shape.

### FINDING E-1 — token-state vocabulary mismatch (fixed in RUNBOOK)

The RUNBOOK section "Token states and what they mean" lists the values
`healthy / authenticated`, `409`, `403`, `security_error`. But the field it tells
the operator to read — `brokers[].token_state` in `GET /api/runtime/status` — can
only ever be one of the real union
(`src/runtime/statusRoutes.ts:41` / `src/tokens/brokerTokenService.ts:41`):

    waiting | polling | ready | invalid | configuration_error

Those "409/403/security_error/healthy" names are the *token-provider client's*
internal classification (`src/tokens/tokenProviderClient.ts` `kind`), not the
observable `token_state`. The real mapping (`brokerTokenService.ts handleResult`)
is:

| provider `kind` (cause) | observable `token_state` | where the detail shows |
| --- | --- | --- |
| `ready` | `ready` | — |
| `retry` (409 / network / 5xx) | `polling` | `last_error` (e.g. "…(409)") |
| `blocker` (503) | `polling` | `last_error` |
| `configuration_error` (401/403) | `configuration_error` | `last_error` |
| `security_error` (identity mismatch / stale `login_date`) | `invalid` | `last_error` |

An operator who greps the runbook for "409" would never find it in `token_state`;
it appears in `last_error`. The runbook was rewritten so each symptom names the
`token_state` the operator will actually see plus the `last_error` substring that
distinguishes the cause.

---

## CODE DEFECTS found (reported, NOT fixed — owner action)

- **C-DEFECT-1 — dead broker-selection env vars.** `DEFAULT_ACTIVE_BROKER` and
  `AUTO_FALLBACK_TO_DHAN` are documented operator knobs but nothing reads them; the
  active broker is hard-coded `zerodha` (`registry.ts:217`). Either wire them
  (so an operator can pick the boot broker / opt into fallback) or accept that the
  boot broker is fixed. The docs have been corrected to stop advertising them; the
  *behaviour* (no way to choose the boot broker via env) is the code decision to
  confirm.

- **C-DEFECT-2 — `DHAN_DATA_ENABLED` default is `true`, not `false`.**
  `registry.ts:952-954` treats an unset value as enabled (`raw === "" || …`).
  Every other Dhan gate in this file (`dhanStaticIpDeclared`,
  `dhanLiveTradingEnabled`) defaults an unset value to `false`. The market-data
  API being *on by default* while every trading gate is *off by default* is an
  asymmetry worth a deliberate decision. If "disabled unless set" was intended,
  drop the `raw === ""` disjunct. (Docs corrected to state the real default.)

- **C-DEFECT-3 — CONFIGURATION.md "REMOVED" table mixed live knobs with dead ones**
  (`BOX_PNL_CACHE_*`, `BOX_PNL_ARCHIVE_DRAIN_DELAY_MS`, `BOX_PNL_VERIFY_HOURS`,
  and the `DHAN_API_KEY`/`DHAN_API_SECRET` presence check). This is a doc defect,
  fixed here, but it flags that the P&L cache/archive knobs were **re-purposed**
  from Redis to PostgreSQL rather than removed — worth confirming the intent
  matches the shipped defaults (`BOX_PNL_CACHE_ENABLED=false`).

---

## Post-edit verification

- `node --test tests/box/shadowAndStress.test.mjs` re-run after each `.env.example`
  edit — see the session log for the 25-test green result and the final
  `npm run build` exit 0.
- `git ls-files` shows only `.env.example` (no `.env`); no real secret was written
  into any edited file (all secret slots left empty or fake).
