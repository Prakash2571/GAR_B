# Secrets and configuration

How credentials and operational configuration reach this backend, why they are kept apart, and how to
rotate a broker secret without taking the system down.

## The split, and why

| | Protected secrets file | Server `.env` |
|---|---|---|
| Path | `/etc/gts/secrets.env` | `<repo>/.env` |
| Mode | `0600` — refused if wider | ordinary |
| Contents | credentials only | operational BOX configuration |
| Written by | a rotation, or the sync workflow | an operator, by hand |
| Lifecycle | once per rotation | edited between sessions |
| In git | never (outside the tree) | never (`.gitignore`) |

They are separate because they fail differently. Losing `.env` means losing the risk limits, feed
windows and execution mode someone tuned for a live system — a deployment must therefore never
overwrite it. Leaking the secrets file means rotating every broker credential. Keeping them in one file
forced both problems to share one blast radius, and meant an operator editing a risk limit had to open
a file containing broker keys.

## Precedence

```
1. explicit process environment      (what a deploy or your shell exported)
2. /etc/gts/secrets.env              (credentials)
3. .env                              (operational configuration)
4. code defaults
```

Nothing lower ever overwrites anything higher, so a credential injected at deploy time cannot be
shadowed by a stale copy in a file. Implemented in `src/env/layer.ts`; the order of the two file loads
in `src/env/load.ts` is what makes the secrets file beat `.env`.

**A blank counts as absent.** An injected `FOO=` does not mask a real value further down — process
managers and CI runners routinely inject empty variables for things they have no value for, and letting
that win would produce a missing credential with no visible cause.

`dotenv` is still used, but only its `parse` function. The precedence rule is ours, in eleven lines, so
a dependency upgrade cannot silently change which value wins.

## GitHub Secrets to create

Repository → Settings → Secrets and variables → Actions → **New repository secret**.

**Required for the sync workflow itself:**

| Secret | What it is |
|---|---|
| `DEPLOY_SSH_KEY` | private key of a deploy user on the host |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -H <host>` — without it a spoofed host would be trusted |
| `DEPLOY_HOST` | hostname or IP |
| `DEPLOY_USER` | the SSH user |

**The credentials themselves** — create only the ones your deployment actually uses:

| Secret | Required when |
|---|---|
| `SITE_ACCESS_SECRET` | always in live; warns otherwise |
| `BROKER_TOKEN_ENCRYPTION_KEY` | always in live. Must decode to exactly 32 bytes |
| `DATABASE_URL` | always in live |
| `KITE_API_KEY`, `KITE_API_SECRET` | live + `DEFAULT_ACTIVE_BROKER=zerodha` + `BROKER_LOGIN_MODE=in_app` |
| `KITE_TOKEN_BROKER_PASSCODE` | live + zerodha + `BROKER_LOGIN_MODE=provider` |
| `DHAN_API_KEY`, `DHAN_API_SECRET` | live + `DEFAULT_ACTIVE_BROKER=dhan` + `in_app` |
| `DHAN_TOKEN_BROKER_PASSCODE` | live + dhan + `provider` |
| `MONGODB_URI` | only when `MONGO_EXPORT_ENABLED=true` |
| `TOKEN_EXPOSURE_KEY` | optional; absence disables `GET /api/tokens/*` |

Optional repository **variables** (not secrets): `GTS_SECRETS_FILE` if you moved the file, `PM2_APP` if
your PM2 app is not `gts-backend`.

Do **not** put risk limits or feed windows in GitHub Secrets. They are not secret, they belong in
`.env`, and moving them would mean a deployment could change your risk configuration.

## One-time server setup

Run once, as a user with sudo, on the deployment host:

```bash
# 1. Create the directory. Root-owned, not world-traversable.
sudo install -d -m 750 -o root -g root /etc/gts

# 2. Create the secrets file owned by the account PM2 runs as, readable only by it.
#    Replace $(id -un) if PM2 runs as a different user than your login.
sudo install -m 600 -o "$(id -un)" -g "$(id -gn)" /dev/null /etc/gts/secrets.env

# 3. Fill it in with an editor that does not leave a world-readable backup.
sudo -e /etc/gts/secrets.env     # or: sudoedit /etc/gts/secrets.env

# 4. Confirm the mode. Anything other than 600 (or 400) will be REFUSED at startup.
stat -c '%a %U:%G %n' /etc/gts/secrets.env
```

The file is plain `KEY=value` lines, credentials only:

```
SITE_ACCESS_SECRET=...
BROKER_TOKEN_ENCRYPTION_KEY=...
DATABASE_URL=postgres://user:password@host:5432/db
KITE_API_KEY=...
KITE_API_SECRET=...
```

Generate key material with `openssl rand -base64 48` for the passcode and
`openssl rand -hex 32` for `BROKER_TOKEN_ENCRYPTION_KEY` (which must be exactly 32 bytes).

## How the secrets survive PM2 and reboots

The backend reads the file **itself, on every process start** (`src/env/boot.ts`, imported first in
`src/index.ts`). Nothing is inherited from whoever launched PM2, so credentials survive all of:

| Event | Works because |
|---|---|
| `pm2 restart` | the new process re-reads the file |
| `pm2 reload` | same |
| crash auto-restart | same |
| `pm2 save` + `pm2 resurrect` | same — the file is read at startup, not restored from the dump |
| server reboot | same, via PM2's startup script |
| `.env` edited | `pm2 restart` re-reads it and the new BOX configuration applies |

**Why the secrets are not in `ecosystem.config.cjs`.** `pm2 save` serialises the running environment
into `~/.pm2/dump.pm2`, and `pm2 resurrect` restores from *that*. A secret in the PM2 `env` block would
therefore be written in clear text into a second file nobody audits, and restored from that copy — so a
rotated key would leave its predecessor live in the dump. CI enforces that the ecosystem file contains
no credential assignment.

If you **move** the secrets file, set `GTS_SECRETS_FILE` in the PM2 `env` block, not in `.env`. The
loader resolves that variable from the real process environment before any file is parsed, because a
file cannot name the file that has to be read to find it. Set it only in your shell and
`pm2 resurrect` after a reboot will look in the default location and find nothing.

## Deployment

`start.sh` on the server owns deployment: it pulls, builds, migrates, validates the effective
configuration and restarts PM2. It reads `DATABASE_URL` and `PORT` from the secrets file first and then
`.env` — the same order the application applies — so the release can never validate against a different
value than the one that will be in force. It checks the secrets file's mode and fails loudly if it is
too wide, because the application would refuse to read it and would then start with no credentials.

**Deployment never writes `.env`.** No script copies `.env.example` over it, deletes it or redirects
into it, and CI has a check that fails if one ever does.

The `Sync secrets to server` workflow is **manual only** (`workflow_dispatch`) and writes exactly one
path — the secrets file. It never touches `.env`, never interpolates a secret into a shell command
(which would put it in the log and in the runner's process table), streams the payload over SSH stdin so
no temporary file exists, and creates the file with `install -m 600` so there is no window where it is
world-readable. Restarting afterwards is opt-in, which is the right default for a rotation you want to
verify before it takes effect.

## Rotating a broker secret

Rotating an **API key or passcode** (Zerodha, Dhan, the site passcode, a DSN):

1. Create the new value at the broker.
2. Update the GitHub Secret, or edit `/etc/gts/secrets.env` directly with `sudo -e`.
3. Run the sync workflow with `restart: false`, or leave the file edited but do not restart yet. The old
   value stays in force — nothing has changed yet.
4. When you are ready: `pm2 restart gts-backend --update-env && pm2 save --force`.
5. Verify with the commands below. Rotate outside market hours, or at least while flat.

Rotating **`BROKER_TOKEN_ENCRYPTION_KEY`** is different: stored broker tokens are sealed with it, so
replacing it without re-encrypting makes every stored session permanently unreadable. Use the script:

```bash
# Prove the old key is correct and every row is intact. Writes nothing.
BROKER_TOKEN_OLD_KEY=<old> BROKER_TOKEN_NEW_KEY=<new> \
  npm run rotate:broker-token-key -- --dry-run

# Re-encrypt every row in ONE transaction.
BROKER_TOKEN_OLD_KEY=<old> BROKER_TOKEN_NEW_KEY=<new> \
  npm run rotate:broker-token-key
```

Then put the new key in the secrets file and restart. The keys are read from the environment and never
from `argv`, because a process's command line is visible in `ps` to any user on the box.

## Verification — none of these reveal a credential

```bash
# 1. The startup report: every credential as `configured` or `missing`, never a value.
pm2 logs gts-backend --lines 200 --nostream | grep '\[Config\]'

# 2. Nothing is missing.
pm2 logs gts-backend --lines 200 --nostream | grep '\[Config\]' | grep missing

# 3. Is live trading actually on?
pm2 logs gts-backend --lines 200 --nostream | grep 'EFFECTIVE:'

# 4. File mode and ownership — no contents.
stat -c '%a %U:%G %n' /etc/gts/secrets.env

# 5. Which credential NAMES are present, without any value.
sudo grep -oE '^[A-Z_]+=' /etc/gts/secrets.env | tr -d '='

# 6. How many lines, as a sanity check after a sync.
sudo grep -cE '^[A-Z_]+=' /etc/gts/secrets.env

# 7. The full resolved BOX configuration with provenance (non-secret only).
node --import ./dist/env/boot.js dist/box/effectiveConfig.js

# 8. Health.
curl -fsS http://127.0.0.1:3001/api/health
```

Never run `cat /etc/gts/secrets.env`, `env`, `printenv`, or `pm2 env <id>` while sharing a screen or
pasting output — the last one prints the whole process environment including every credential.

## What fails, and how

| Situation | Result |
|---|---|
| live + a required broker secret missing | **startup fails**, listing every missing variable by name |
| live + `BROKER_TOKEN_ENCRYPTION_KEY` malformed | **startup fails** (shape checked, not just presence) |
| live + no `SITE_ACCESS_SECRET` | **startup fails** — an unsupervisable live process |
| paper + no broker credentials | boots normally; they are not needed |
| paper + no `SITE_ACCESS_SECRET` | boots, warns; the gate fails closed so every route 401s |
| secrets file mode `0644` | file **refused**, nothing read from it; live then fails on missing secrets |
| a credential in `.env` | works, reported loudly at every startup by name |
| `BOX_LIVE_TRADING_ENABLED=ture` | resolves **false**; live stays off, and the typo is reported |
| `BOX_EXECUTION_MODE=livee` | **startup fails** — execution selection is never resolved to a default |
| `BOX_MAX_OPEN_BOXES=one` | **startup fails** — a malformed safety limit is never defaulted |

Every failure message names a **variable**, never a value.
