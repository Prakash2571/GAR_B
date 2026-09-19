# Pre-live deployment verification — commit `d1d7121`

**Written 2026-09-19, for the Zerodha live-hardening release.** This document does two things:

1. **Records** what was and was not verified for `d1d7121` before any live use — §1 and §2.
2. **Hands over** the host-side procedure that could not be executed from the authoring
   environment — §3 onward.

**Nothing here authorises real-money trading.** Completing every step leaves ENTRY **disarmed**; arming
is a separate, explicitly authorised act.

### How this relates to the other live-test documents

Three documents cover adjacent ground. They are not interchangeable, and this one does not restate them:

| Document | Scope | Use it for |
|---|---|---|
| `docs/PREFLIGHT_CHECKLIST.md` | Account, instrument and money facts | The externally-confirmed facts no code can establish |
| `docs/TRIAL_RUNBOOK.md` §4 | Gate B read-only status checks | Reading the deployed status surfaces before arming |
| **this document** | **Getting `d1d7121` onto the host correctly** | Egress IP, deploy, restart, the blockers this release added |

Run this document **first** (it produces a correctly deployed process), then `TRIAL_RUNBOOK.md` §4,
then `PREFLIGHT_CHECKLIST.md`. Where this document and Gate B both mention the static IP, they agree:
Gate B row 7 is the check, §3.1 below is the procedure.

---

## 1. Verified for `d1d7121`

Every item below was established by direct inspection and is reproducible.

| Item | Evidence |
|---|---|
| `main` == `origin/main` == `d1d7121d917f2f3a5b0d0e86ccfd33f48b129009` | `git rev-parse HEAD`, `git rev-parse origin/main` |
| Working tree clean, no unmerged feature work | `git status --porcelain` empty |
| Rollback point exists | tag `pre-zerodha-live-hardening-20260919` → `b66cbe8` |
| CI green on the merge commit | 6/6 jobs; **3146 tests, 3146 pass, 0 fail, 0 skipped**; `tsc -b` clean |
| Database suites genuinely ran | `test:pg` against real PostgreSQL, `test:projector` against real Mongo, plus the repo's own *fail if any database suite skipped tests* step |

**What that does not establish** is unchanged from `PREFLIGHT_CHECKLIST.md` §11: the suite proves
internal consistency against mocked broker boundaries. This code has still never placed a real order.

## 2. NOT verified — no deployment access

The authoring environment had **no network egress and no credentials for the production host**.
Recorded so a later reader does not mistake silence for a pass:

```
curl -4 --max-time 5  https://api.ipify.org   -> 000 (no connection)
curl -4 --max-time 5  https://ifconfig.me     -> 000
curl -4 --max-time 5  https://api.kite.trade  -> 000
pm2 / nginx / psql / mongosh                  -> not installed
~/.ssh                                        -> does not exist (no keys)
```

Consequently **none** of the following was verified, and all of it is delegated to §3:

- the actual public egress IP, and whether it is registered with Zerodha
- the deployed `.env`, the deployed commit, the PM2 process list
- production PostgreSQL and Mongo state
- broker session, funds, positions, orders
- market-data health and the **current NIFTY lot size**

No order was placed, no session was armed, no configuration was changed, nothing was restarted —
because none of it was reachable, not because it was checked and found safe.

---

## 3. Host procedure

Run in order on the production host. **Stop at the first failure.**

### 3.1 Egress IP — do this first

Everything else is moot if this fails.

```bash
curl -4 --max-time 5 -s https://api.ipify.org; echo
curl -4 --max-time 5 -s https://ifconfig.me;   echo   # independent second opinion
```

Record the result as `ACTUAL_EGRESS_IP`. It must be the host's **outbound public** address. Do **not**
substitute the VM private IP, the EC2/Azure internal IP, a DNS record, the Nginx bind address or the
domain's A record — none of those is what Zerodha sees.

Then, in the **Kite developer console** → your app → confirm `ACTUAL_EGRESS_IP` is in the registered IP
list. **GAR_B cannot do this for you.** Kite exposes no endpoint answering *"is this IP registered for my
key"*, so the flag below is an operator attestation and is never reported as broker-verified.

Set in the deployed `.env`:

```properties
ZERODHA_STATIC_IP_CONFIRMED=true                 # only after the console step above
ZERODHA_EXPECTED_EGRESS_IP=<ACTUAL_EGRESS_IP>    # replace the template placeholder
```

Two properties of these variables that are easy to get wrong:

- **`ZERODHA_EXPECTED_EGRESS_IP` is diagnostics only.** It is recorded and reported
  (`src/box/zerodhaStaticIp.ts`), never compared against a live lookup — by design, so the order path
  acquires no external dependency. It cannot catch a mismatch for you.
- **`deploy/FINAL-one-box-live.env.template` ships `CHANGEME_STATIC_PUBLIC_IP`** (line 377). That is not
  a usable IPv4, so the parser discards it and sets `expectedEgressIpMalformed`; readiness then reports
  that the value *was ignored*. If the deployed `.env` was copied from the template verbatim, this is
  already true of production.

A matching egress IP is **not** proof of registration, and a confirmed flag is **not** proof of a
matching IP. Both facts are yours to establish.

### 3.2 Exactly one order engine on the account

```bash
pm2 list
ps -ef | grep -iE 'node|cal_spread|strikeedge|tradeedge|gts' | grep -v grep
```

**Stop** if any of these can reach the live Zerodha account: `Cal_Spread`, `StrikeEdge`, `TradeEdge`, a
second `gts-backend`, or a development backend. Two independent engines on one account is not something
code can recover from — they consume the same funds and each sees the other's fills as foreign.

`TRIAL_RUNBOOK.md` §7.8 states the same limit from the other direction: single-process topology is
*assumed*, detected as an incompatible readiness epoch, but not enforced.

### 3.3 Record the rollback point, then deploy

```bash
cd /path/to/GAR_B
git rev-parse HEAD > /tmp/rollback-sha.txt && cat /tmp/rollback-sha.txt   # SAVE THIS
git fetch origin && git pull --ff-only origin main
git rev-parse HEAD        # expect d1d7121d917f2f3a5b0d0e86ccfd33f48b129009
npm ci && npm run build
```

To roll back: `git checkout $(cat /tmp/rollback-sha.txt)`, or the tag
`pre-zerodha-live-hardening-20260919`. Never `git reset --hard` or `git clean -fd` on the host —
an untracked `.env` is the thing you would lose.

### 3.4 Restart, and read **stderr**

```bash
pm2 restart gts-backend --update-env
pm2 logs gts-backend --lines 200 --nostream --err    # [FATAL] appears ONLY here
pm2 logs gts-backend --lines 200 --nostream --out    # [Config] / [PG] / [shutdown]
```

Three failure modes worth knowing in advance:

- **`[FATAL]` goes to stderr; `[Config]` goes to stdout, and PM2 writes them to different files.**
  Reading only `--out` after a failed boot shows you nothing at all.
- **Env validation runs before the config dump** (`assertEnvironmentValid()`, `src/index.ts:150`). A bad
  variable therefore produces a `[FATAL]` line and **no** `[Config]` output. Empty stdout is a symptom,
  not a mystery.
- **A live boot needs an authenticated Zerodha session.** `src/box/engine.ts:1830` throws when
  `marketData.isAuthenticated()` is false. The order is: start → log in through the UI → *then* consider
  arming. A fresh deployment cannot boot straight into a live-ready engine.

### 3.5 Confirm the running process

```bash
curl -s localhost:<PORT>/api/health | jq
```

`/api/health` is deliberately unauthenticated and deliberately thin, but it carries the contract digest.
Expect `8bdf7afaadc549ea63d375db78073c5dbe415df33cb0477db3abde6975eadc45`. A mismatch means the running
process and the frontend bundle disagree about the wire contract; `null` means unverifiable, never
matching.

### 3.6 Read readiness through the logged-in UI

`/api/box/status`, `/api/runtime/status` and `/api/broker/status` are all behind `requireOperator`. Raw
`curl` without an operator session returns **403** — read them in the browser while logged in, or carry a
session cookie. Only `/api/health` answers unauthenticated.

Expect these codes **absent** from `operational_readiness.entry.reasons`:

| Code | Meaning |
|---|---|
| `zerodha_static_ip_unconfirmed` | §3.1 not completed |
| `funding_checks_disabled` | live with every funding evidence gate off |
| `recovery_escalation_timeout` | residual exposure unresolved past `BOX_LIVE_RECOVERY_ESCALATION_MS` |
| `reconciliation_incomplete` | durable and broker state do not agree yet |
| `recovery_active` | exposure being resolved |
| `residual_state_unknown` | residual legs exist that cannot be valued |
| `instance_epoch_unknown` | `boot_ordinal` null |

And expect **ENTRY disarmed**. A clean readiness surface with entry disarmed is the correct end state of
this document.

### 3.7 Lot size — read it, never assume it

From the loaded instrument master (or the Box row), record the **actual** NIFTY one-lot quantity `L`.
Confirm:

```
BOX_LIVE_MAX_OPEN_LEG_QUANTITY        == L
BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY  == 4 × L
```

`BOX_LIVE_EXACT_ONE_LOT=true` asserts the **relationship**, never a specific number — `725/2900` passes
exactly as `65/260` does — and refuses live boot when the two disagree. Order quantity always comes from
`candidate.lot_size` in the instrument master, never from these variables.

The template ships `65/260` (lines 409–410), correct only while `L == 65`. If `L` has changed, update
**both** together or the boot assertion will refuse — which is the intended behaviour, not a bug.
`PREFLIGHT_CHECKLIST.md` §10 already lists current lot size among the facts this repository cannot
verify.

### 3.8 Broker reads only

Profile, funds, positions, orders. **No place-order call anywhere in this procedure.** Confirm available
funds clear `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` plus `BOX_LIVE_RECOVERY_RESERVE_RUPEES` (template:
₹100,000 + ₹25,000).

---

## 4. Readiness reports; the order manager enforces

Worth internalising before trusting a green panel.

`operationalReadiness()` (defined at `src/box/engine.ts:7742`) is consumed in exactly two places —
`src/box/engine.ts:7291`, inside `getStatus()`, and `src/index.ts:991`, the runtime-status projection.
**Neither is in the entry decision path.** Readiness is an observability surface.

Authoritative ENTRY enforcement is `BoxOrderManager.entryBlockReasonAfterControls`
(`src/box/orderManager.ts`), reached only through `canEnter`, which `submit()` consults only when
`purpose === "ENTRY"`. The two gates this release added live there:

| Gate | Site | Condition |
|---|---|---|
| `zerodha_static_ip_unconfirmed` | `orderManager.ts:1209` | `!limits.zerodhaEntryStaticIpConfirmed && broker() === "zerodha"` |
| `funding_checks_disabled` | `orderManager.ts:1201` | `limits.liveFundingChecksDisabled` |

Both **fail closed**: unset, blank, `false` and a typo such as `"ture"` all read as *not confirmed*.

Neither gates **reduction**, deliberately. Exits, protective cancels, emergency residual flattening and
reconciliation are still attempted with the static-IP flag unset — a forgotten checkbox must never become
a reason to leave real exposure unmanaged. The consequence is stated plainly in
`ZERODHA_LIVE_HARDENING_AUDIT.md` scenario 22: if the host genuinely egresses from an unregistered
address, Zerodha may reject requests **including exits**, and that surfaces as a broker failure while you
hold exposure. The mitigation is §3.1 done honestly. No code can cover it.

A green readiness panel is therefore **necessary evidence, not sufficient proof**.

---

## 5. Open items

Decide on these before a first live order, not after.

1. **Migration count discrepancy — unresolved.** A production check reported **16** applied migrations.
   This tree ships **14**, `001_outbox.sql` through `014_box_settings_constraint_scope.sql` (verified by
   `ls migrations/*.sql | wc -l`). Two unexplained migrations on a live trading database is not a
   rounding error. Run:
   ```sql
   select filename, applied_at from schema_migrations order by filename desc limit 6;
   ```
   The migrator records every applied file in `schema_migrations (filename, checksum, applied_at)` —
   `src/pg/migrate.ts:85` — so anything beyond `014_…` was applied by something other than this tree.
2. **The frontend has not been redeployed.** `GAR_F` main is green, but production still serves the older
   bundle, so recent Configuration-tab and Box-page work is absent. Readiness will be read through the
   older UI. Contract digests still match, so this is a cosmetic and workflow gap, not a protocol one.
3. **`ZERODHA_EXPECTED_EGRESS_IP` placeholder** — see §3.1. Must be a real IPv4 before live use.
4. **Scenario 22** — see §4. Operational mitigation only.

---

## 6. Verdict recorded at authoring time

> **NOT READY — production-side verification not performed.** No network egress and no host credentials,
> therefore: the actual egress IP is undetermined; no Zerodha call was made; the deployed `.env`, PM2
> process list, PostgreSQL and Mongo state are unread; the current NIFTY lot size is unknown; and the
> live template still carries the egress-IP placeholder.

The code at `d1d7121` is reviewed and green. What is missing is host-side evidence, and §3 is how to
obtain it. Re-issue the verdict only when each §3 step has actually been executed and its output read.
