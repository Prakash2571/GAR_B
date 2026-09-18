#!/usr/bin/env bash
#
# GTS Algo Research — production release script.
#
#   ./start.sh                 full release
#   ./start.sh --frontend-only publish the UI only; never touches the DB or the backend process
#   ./start.sh --dry-run       print every command, change nothing
#   ./start.sh --help          all flags
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# THE PIPELINE
# ─────────────────────────────────────────────────────────────────────────────────────────────
#    0  preflight           tools, paths, .env, AND that PostgreSQL actually answers — every
#                           check that can fail is made BEFORE the host is modified
#    1  git pull            GAR_B and GAR_F (fast-forward only, refuses a dirty tree)
#    2  npm ci              both repos, from the lockfiles
#    3  build               backend (tsc -b) and frontend (tsc -b && vite build)
#    4  contract            frontend's vendored contract must match THIS backend's schemas
#    5  backup              pg_dump BEFORE anything touches the schema
#    6  migrate             only when a migration is actually pending
#    7  config              report the EFFECTIVE backend config and refuse on a fatal gap
#    8  pm2                 start or reload gts-backend
#    9  health              wait until /api/health really reports ready
#   10  frontend            publish GAR_F/dist to the web root (previous kept for rollback)
#   11  nginx -t            validate the config BEFORE reloading
#   12  nginx reload
#   13  verify              the three public URLs
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# WHAT THIS SCRIPT WILL NOT DO
# ─────────────────────────────────────────────────────────────────────────────────────────────
# It NEVER arms trading. It sets no BOX_* variable, never edits .env, and never flips an entry
# gate. Arming stays a deliberate human action through the operator API. The script only REPORTS
# the funding/arming state it found so a release cannot quietly change it.
#
# It also never runs a migration underneath a live armed process: if a migration is pending the
# backend is STOPPED first (docs/DEPLOYMENT.md — "Never migrate under a live, armed process"),
# and when nothing is pending the app is reloaded without stopping.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# FAILURE BEHAVIOUR
# ─────────────────────────────────────────────────────────────────────────────────────────────
# Fails CLOSED and stops at the first error — a half-applied release is worse than a refused one.
# The frontend is published only after the backend is confirmed healthy, and the previous web root
# is kept so a bad nginx validation rolls the frontend back automatically.
#
# One thing is deliberately NOT automatic: once a migration has been applied, this script will not
# "undo" it by checking out the old commit, because that would leave code older than the schema.
# On failure it prints the exact previous commits and the backup file so a human can decide.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# --frontend-only
# ─────────────────────────────────────────────────────────────────────────────────────────────
# Ships a UI change when the backend is fine as it is (or when the database is broken and the fix
# is unrelated). It pulls, builds and publishes the frontend and reloads nginx, and it does NOT
# back up, migrate, restart the backend or wait for health — so a database problem cannot block a
# frontend fix, and a frontend fix cannot disturb a running engine.
#
# It is still safe because the contract check is NOT skipped: before publishing, the digest the
# RUNNING backend serves is compared with the one the frontend pinned, so a UI can never be
# published against a wire shape that process does not speak.
#
# Safe to re-run: every step is idempotent, and a second run with nothing to do is a no-op.

set -Eeuo pipefail

# ── configuration ────────────────────────────────────────────────────────────────────────────
# Every value can be overridden by the environment or by a `deploy.env` file beside this script
# (which is gitignored — put host-specific paths there rather than editing this file).

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/deploy.env" ]]; then
  # shellcheck disable=SC1091
  set -a; . "${SCRIPT_DIR}/deploy.env"; set +a
fi

GAR_B_DIR="${GAR_B_DIR:-$SCRIPT_DIR}"
GAR_F_DIR="${GAR_F_DIR:-$(cd -- "${SCRIPT_DIR}/.." && pwd)/GAR_F}"
WEB_ROOT="${WEB_ROOT:-/var/www/gts}"
PM2_APP="${PM2_APP:-gts-backend}"          # must match ecosystem.config.cjs `name`
BACKUP_DIR="${BACKUP_DIR:-/var/backups/gts}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
PUBLIC_BASE="${PUBLIC_BASE:-https://gtsalgoresearch.online}"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-180}"
LOG_DIR="${LOG_DIR:-/var/log/gts}"
GIT_REMOTE="${GIT_REMOTE:-origin}"

# The PROTECTED SECRETS FILE — credentials only, mode 0600, deliberately OUTSIDE the repository.
#
# Outside because a path inside the working tree is one `git add -A` away from being committed and
# would be destroyed by a deploy that re-clones. This is the file that makes credentials survive
# `pm2 restart`, a crash restart, `pm2 resurrect` and a reboot: the backend re-reads it on every
# process start, so nothing depends on an SSH session still being open.
#
# Exported as GTS_SECRETS_FILE so the backend and the effective-config preload resolve the SAME path
# this script validated. Override in deploy.env for a container or a non-standard layout.
SECRETS_FILE="${GTS_SECRETS_FILE:-${SECRETS_FILE:-/etc/gts/secrets.env}}"
export GTS_SECRETS_FILE="$SECRETS_FILE"

DRY_RUN=0
SKIP_PULL=0
SKIP_BACKUP=0
SKIP_FRONTEND=0
FRONTEND_ONLY=0
ASSUME_YES=0

usage() {
  sed -n '2,63p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

FLAGS
  --dry-run          Print what would run. Changes nothing.
  --skip-pull        Deploy the working tree as-is (no git pull).
  --skip-frontend    Backend only; leaves the web root and nginx untouched.
  --frontend-only    UI only. No pg_dump, no migration, no pm2, no health wait.
                     The running backend's contract is still verified before publishing.
  --no-backup        Skip pg_dump. REFUSED when a migration is pending.
  -y, --yes          Do not prompt.
  -h, --help         This text.

HOST-SPECIFIC PATHS
  Put overrides in deploy.env beside this script, e.g.:
    GAR_F_DIR=/srv/GAR_F
    WEB_ROOT=/var/www/gts
    BACKUP_DIR=/var/backups/gts
    PUBLIC_BASE=https://gtsalgoresearch.online
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-pull) SKIP_PULL=1 ;;
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --frontend-only) FRONTEND_ONLY=1 ;;
    --no-backup) SKIP_BACKUP=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown flag: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

if (( FRONTEND_ONLY && SKIP_FRONTEND )); then
  printf -- '--frontend-only and --skip-frontend are opposites; pick one\n' >&2; exit 2
fi
# --frontend-only means the backup and the migration are not merely skipped, they are not reached.
# Setting SKIP_BACKUP keeps a single source of truth for "no pg_dump was taken in this run".
(( FRONTEND_ONLY )) && SKIP_BACKUP=1

# ── output helpers ───────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BOLD=''
fi

STEP_NO=0
ts()   { date '+%Y-%m-%d %H:%M:%S'; }
log()  { printf '%s%s%s %s\n' "$C_DIM" "$(ts)" "$C_RESET" "$*"; }
ok()   { printf '%s%s%s %s✓%s %s\n' "$C_DIM" "$(ts)" "$C_RESET" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s%s%s %sWARN%s %s\n' "$C_DIM" "$(ts)" "$C_RESET" "$C_YELLOW" "$C_RESET" "$*" >&2; }
step() { STEP_NO=$((STEP_NO + 1)); printf '\n%s──[ %02d ] %s%s\n' "$C_BOLD" "$STEP_NO" "$*" "$C_RESET"; }
die()  { printf '\n%s%sRELEASE FAILED:%s %s\n' "$C_BOLD" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# Run a side-effecting command, honouring --dry-run.
run() {
  if (( DRY_RUN )); then printf '%s      would run:%s %s\n' "$C_DIM" "$C_RESET" "$*"; return 0; fi
  "$@"
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
have()     { command -v "$1" >/dev/null 2>&1; }

# Mirror SRC/ into DEST/, deleting anything DEST has that SRC does not.
#
# `--delete` semantics matter: vite emits content-hashed asset filenames, so without removing
# extraneous files the web root accumulates every asset from every past release forever. rsync is
# used when present; otherwise the same result is achieved with tar, so rsync is not a hard
# dependency of a release.
sync_dir() {
  local src="${1%/}/" dest="${2%/}"
  if have rsync; then
    run $SUDO rsync -a --delete "$src" "${dest}/"
  else
    run $SUDO mkdir -p "$dest"
    # Clear then repopulate. Safe because the caller has already snapshotted the previous root,
    # and the glob is scoped strictly to $dest.
    run $SUDO find "$dest" -mindepth 1 -delete
    if (( DRY_RUN )); then
      printf '%s      would run:%s tar -C %s -cf - . | %s tar -C %s -xf -\n' \
        "$C_DIM" "$C_RESET" "$src" "$SUDO" "$dest"
    else
      tar -C "$src" -cf - . | $SUDO tar -C "$dest" -xf - \
        || die "failed to copy ${src} to ${dest}"
    fi
  fi
}

# nginx and the web root need root; PM2 must NOT be sudo'd (its daemon is per-user, so sudo would
# talk to a different daemon than the one running the app).
SUDO=""
if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "not root and sudo is unavailable; cannot manage nginx or ${WEB_ROOT}"
  SUDO="sudo"
fi

confirm() {
  (( ASSUME_YES || DRY_RUN )) && return 0
  local reply
  printf '%s%s%s [y/N] ' "$C_BOLD" "$1" "$C_RESET"
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || die "aborted by operator"
}

# ── rollback ─────────────────────────────────────────────────────────────────────────────────

WEB_BACKUP=""          # previous web root, kept until the release succeeds
BACKUP_FILE=""         # pg_dump path, printed on failure
GAR_B_BEFORE=""
GAR_F_BEFORE=""
MIGRATED=0
MUTATED=0              # set once the release has changed anything on this host

on_failure() {
  local code=$?
  [[ $code -eq 0 ]] && return 0
  # Nothing has been changed yet, so there is nothing to recover from — say so plainly instead of
  # printing a rollback report that implies a partial release.
  if (( ! MUTATED )); then
    printf '\n%sNothing was changed — the release stopped before modifying anything.%s\n' \
      "$C_DIM" "$C_RESET" >&2
    return 0
  fi
  printf '\n%s%s── ROLLBACK / RECOVERY ──%s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET"
  if [[ -n "$WEB_BACKUP" ]] && $SUDO test -d "$WEB_BACKUP"; then
    warn "restoring the previous frontend from ${WEB_BACKUP}"
    sync_dir "$WEB_BACKUP" "$WEB_ROOT" || warn "frontend restore FAILED — do it by hand"
    if $SUDO nginx -t >/dev/null 2>&1; then
      $SUDO systemctl reload nginx >/dev/null 2>&1 || $SUDO nginx -s reload >/dev/null 2>&1 || true
      warn "previous frontend restored and nginx reloaded"
    fi
  fi
  echo
  warn "the backend was NOT rolled back automatically. Current state:"
  printf '    pm2 status:      pm2 describe %s\n' "$PM2_APP"
  printf '    backend logs:    pm2 logs %s --lines 100\n' "$PM2_APP"
  [[ -n "$GAR_B_BEFORE" ]] && printf '    GAR_B was at:    %s\n' "$GAR_B_BEFORE"
  [[ -n "$GAR_F_BEFORE" ]] && printf '    GAR_F was at:    %s\n' "$GAR_F_BEFORE"
  [[ -n "$BACKUP_FILE" ]]  && printf '    DB backup:       %s\n' "$BACKUP_FILE"
  if (( MIGRATED )); then
    echo
    warn "A MIGRATION WAS APPLIED IN THIS RUN. Do NOT simply check out the previous commit —"
    warn "that would run code older than the schema. Decide deliberately: fix forward, or"
    warn "restore ${BACKUP_FILE} and then revert the code. See docs/DEPLOYMENT.md §rollback."
  fi
}
trap on_failure EXIT

# ── single instance ──────────────────────────────────────────────────────────────────────────

LOCK_FILE="${TMPDIR:-/tmp}/gts-release.lock"
exec 9>"$LOCK_FILE" || die "cannot open lock file ${LOCK_FILE}"
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || die "another release is already running (lock: ${LOCK_FILE})"
fi

# ═════════════════════════════════════════════════════════════════════════════════════════════

printf '%s%sGTS Algo Research — production release%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
log "backend    ${GAR_B_DIR}"
log "frontend   ${GAR_F_DIR}"
log "web root   ${WEB_ROOT}"
log "pm2 app    ${PM2_APP}"
log "public     ${PUBLIC_BASE}"
(( DRY_RUN )) && warn "DRY RUN — nothing will be changed"
(( FRONTEND_ONLY )) && log "mode       FRONTEND ONLY — the database and ${PM2_APP} will not be touched"

step "Preflight"

for c in git npm node curl tar; do need_cmd "$c"; done
have rsync || log "rsync not present — using the tar fallback for the frontend copy"
(( FRONTEND_ONLY )) || need_cmd pm2
(( SKIP_FRONTEND )) || need_cmd nginx
[[ -d "$GAR_B_DIR/.git" ]] || die "not a git repo: ${GAR_B_DIR}"
[[ -d "$GAR_F_DIR/.git" ]] || die "frontend repo not found at ${GAR_F_DIR} (set GAR_F_DIR in deploy.env)"
# Normalise to absolute paths so a relative value in deploy.env cannot change meaning once the
# script cd's into a repo.
GAR_B_DIR="$(cd -- "$GAR_B_DIR" && pwd)"
GAR_F_DIR="$(cd -- "$GAR_F_DIR" && pwd)"
if ! (( FRONTEND_ONLY )); then
  [[ -f "$GAR_B_DIR/ecosystem.config.cjs" ]] || die "missing ecosystem.config.cjs in ${GAR_B_DIR}"
  [[ -f "$GAR_B_DIR/.env" ]] || die "missing ${GAR_B_DIR}/.env — the release cannot validate config or reach the database"
fi

# CONFIGURATION COMES FROM TWO FILES, and this script must look in both.
#
#   ${SECRETS_FILE}  credentials only (DATABASE_URL, broker keys, SITE_ACCESS_SECRET). Mode 0600,
#                    outside the repo so a deploy cannot destroy it and `git add -A` cannot commit it.
#   ${GAR_B_DIR}/.env  operational BOX configuration (risk limits, feed windows, execution mode).
#
# The backend reads BOTH itself at startup (src/env/boot.ts, precedence: process env > secrets file >
# .env > default). This script needs only DATABASE_URL (for pg_dump and the reachability probe) and
# PORT, so it looks for each in the secrets file first and then in .env — matching the app's order, so
# the release validates against the same value the app will use.
#
# IT IS PARSED, NOT SOURCED. `. .env` would run the file as shell: a value containing `<`, `&`,
# backticks or `$(...)` either breaks the release or executes on this host, and a real .env is full
# of passwords, URLs and JSON. The reader below only ever assigns the ONE key it is asked for.
# Values are passed in through the environment so no shell quoting is involved anywhere.
# Read one field from a JSON file.
#
# Deliberately NOT `require(path)`: require resolves a path without a leading ./ as a MODULE, so a
# relative directory in deploy.env made the read fail and return an empty string. Comparing an empty
# string then produced a confusing "contract mismatch" for what was really a bad path. This reads the
# file explicitly and fails loudly with the real reason.
json_field() {
  JSON_FILE="$1" JSON_FIELD="$2" node <<'NODE'
const fs = require("node:fs");
try {
  const obj = JSON.parse(fs.readFileSync(process.env.JSON_FILE, "utf8"));
  const v = obj[process.env.JSON_FIELD];
  process.stdout.write(v === undefined || v === null ? "" : String(v));
} catch (err) {
  process.stderr.write(`cannot read ${process.env.JSON_FIELD} from ${process.env.JSON_FILE}: ${err.message}\n`);
  process.exit(1);
}
NODE
}

read_env_file() {
  ENV_FILE="$1" ENV_KEY="$2" node <<'NODE'
const fs = require("node:fs");
const key = process.env.ENV_KEY;
let value = "";
for (let line of fs.readFileSync(process.env.ENV_FILE, "utf8").split(/\r?\n/)) {
  line = line.trim();
  if (line === "" || line.startsWith("#")) continue;
  if (line.startsWith("export ")) line = line.slice(7).trim();
  const eq = line.indexOf("=");
  if (eq <= 0 || line.slice(0, eq).trim() !== key) continue;
  let v = line.slice(eq + 1).trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.length > 1 && v.endsWith(q)) v = v.slice(1, -1);
  else { const hash = v.indexOf(" #"); if (hash >= 0) v = v.slice(0, hash).trim(); }
  value = v; // last assignment wins, matching dotenv
}
process.stdout.write(value);
NODE
}

# Look one key up in the secrets file first, then .env — the SAME precedence the app applies, so this
# script can never validate against a different value than the one that will be in force.
# It writes the value to stdout for capture and NEVER to the log.
read_env() {
  local key="$1" value=""
  if [[ -f "$SECRETS_FILE" && -r "$SECRETS_FILE" ]]; then
    value="$(read_env_file "$SECRETS_FILE" "$key")"
  fi
  if [[ -z "$value" && -f "$GAR_B_DIR/.env" ]]; then
    value="$(read_env_file "$GAR_B_DIR/.env" "$key")"
  fi
  printf '%s' "$value"
}

# ── The protected secrets file ───────────────────────────────────────────────────────────────
#
# Checked for MODE, not just presence. The backend REFUSES to read a secrets file that is readable
# beyond its owner (src/env/load.ts) — so a 0644 file means the app boots with no credentials at all,
# which in live mode is a startup failure. Catching it here turns that into one clear line during the
# release instead of a puzzling fatal after restart.
if ! (( FRONTEND_ONLY )); then
  if [[ -e "$SECRETS_FILE" ]]; then
    secrets_mode="$(stat -c '%a' "$SECRETS_FILE" 2>/dev/null || stat -f '%Lp' "$SECRETS_FILE" 2>/dev/null || echo '')"
    if [[ -n "$secrets_mode" ]] && (( 8#${secrets_mode} & 8#077 )); then
      die "${SECRETS_FILE} is mode 0${secrets_mode}, readable beyond its owner. The backend will REFUSE
    to read it and will start with NO credentials. Fix with:  sudo chmod 600 ${SECRETS_FILE}
    Then assume the contents were exposed and rotate them."
    fi
    ok "secrets file ${SECRETS_FILE} present, mode 0${secrets_mode:-unknown}"
  else
    warn "no secrets file at ${SECRETS_FILE} — credentials must then come from .env or the process
    environment. Live startup will FAIL without broker credentials. See docs/SECRETS_AND_CONFIG.md."
  fi
fi

DATABASE_URL=""
PORT=""
PORT="$(read_env PORT)"
if ! (( FRONTEND_ONLY )); then
  DATABASE_URL="$(read_env DATABASE_URL)"
  [[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is set in neither ${SECRETS_FILE} nor ${GAR_B_DIR}/.env.
    It is a credential (it carries the database password), so it belongs in the secrets file."
  export DATABASE_URL
fi
PORT="${PORT:-3001}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"
LOCAL_API="${LOCAL_API:-http://127.0.0.1:${PORT}}"
(( SKIP_BACKUP )) || need_cmd pg_dump

node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 20 )) || die "Node 20+ required, found $(node -v)"
if (( FRONTEND_ONLY )); then
  ok "node $(node -v), npm $(npm -v)"
else
  ok "node $(node -v), npm $(npm -v), pm2 $(pm2 -v 2>/dev/null | tail -1)"
fi

# Print a connection string with the password removed, so a failure can name the URL it used
# without putting the credential into a terminal, a log file or a screenshot.
#
# STRING SURGERY, NOT `new URL(...).href`. The WHATWG parser silently REPAIRS a malformed URL — it
# re-encodes a stray '@' in the password as %40 — so printing its href would display a perfectly
# valid URL while reporting that the URL is invalid, hiding the exact defect being diagnosed. The
# password is masked from the first ':' to the FIRST '@', which is where libpq ends the userinfo, so
# a second unencoded '@' stays visible in the output instead of being absorbed into the mask.
redact_url() {
  RAW_URL="$1" node <<'NODE' 2>/dev/null || printf '%s' "the DATABASE_URL in .env"
const raw = process.env.RAW_URL ?? "";
const i = raw.indexOf("://");
if (i < 0) { process.stdout.write("(not a URI — keyword/value conninfo?)"); }
else {
  const head = raw.slice(0, i + 3);
  const rest = raw.slice(i + 3);
  let end = rest.length;
  for (const ch of ["/", "?"]) { const j = rest.indexOf(ch); if (j >= 0 && j < end) end = j; }
  const auth = rest.slice(0, end), tail = rest.slice(end);
  const colon = auth.indexOf(":"), at = auth.indexOf("@");
  process.stdout.write(colon >= 0 && at > colon
    ? head + auth.slice(0, colon + 1) + "***" + auth.slice(at) + tail
    : head + auth + tail);
}
NODE
}

# ── the database must answer BEFORE the host is modified ─────────────────────────────────────
#
# This check exists because of a real failure: the release reached the pg_dump step, found the
# database refusing connections, and stopped — but by then `npm ci` had already deleted and
# reinstalled node_modules in both repos and both had been rebuilt. A connection problem is a
# PREFLIGHT problem: the right time to discover it is while nothing has been touched.
#
# It is read-only (a schema dump discarded to /dev/null), so it also runs under --dry-run, and it
# deliberately uses the SAME tool and the SAME connection string the backup step will use. That
# proves more than an open port: it proves the server answers, the credentials are accepted, and
# the database exists.
if ! (( FRONTEND_ONLY )); then
  # ── the URL is linted as a STRING first, before anything tries to connect ───────────────────
  #
  # The node driver and the PostgreSQL command-line tools DO NOT parse this URL the same way, and a
  # password containing '@' is exactly where they disagree:
  #
  #   * src/pg/pool.ts passes DATABASE_URL to pg.Pool({connectionString}), which follows the WHATWG
  #     URL rules and splits the userinfo at the LAST '@'. It reads such a password correctly.
  #   * pg_dump, psql and pg_isready use libpq, which stops at the FIRST '@' and reads everything
  #     after it as the HOST.
  #
  # The result is a release that looks impossible: the backend has been serving traffic for weeks,
  # and the release's backup step cannot connect at all. A parse bug must not be reported as "the
  # server is down", so the shape is diagnosed by name here.
  #
  # Nothing secret is printed — never the password, only which of its characters need encoding.
  db_lint="$(RAW_URL="$DATABASE_URL" node <<'NODE'
const raw = process.env.RAW_URL ?? "";
const notes = [];      // advisory
const faults = [];     // certain to break libpq
const enc = (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
// Characters that terminate or re-delimit the userinfo for libpq. A password may contain any of
// them, but only percent-encoded.
const MUST_ENCODE = ["@", "/", "?", "#", "[", "]", " "];

const m = /^(postgres(?:ql)?):\/\/([\s\S]*)$/i.exec(raw);
if (!m) {
  if (/^\s*[A-Za-z_]+\s*=/.test(raw)) {
    notes.push("this is a keyword/value conninfo string, not a URI — its shape is not linted here.");
  } else {
    faults.push(`does not begin with postgres:// or postgresql://, so libpq will not read it as a connection URI.`);
  }
} else {
  const rest = m[2];
  let end = rest.length;
  for (const ch of ["/", "?"]) { const i = rest.indexOf(ch); if (i >= 0 && i < end) end = i; }
  const authority = rest.slice(0, end);
  const dbname = rest.slice(end).replace(/^\//, "").split("?")[0];
  const atCount = (authority.match(/@/g) || []).length;

  if (atCount >= 2) {
    // THE case this lint exists for.
    const first = authority.indexOf("@");
    const libpqHost = authority.slice(first + 1).replace(/:\d*$/, "");
    const badChars = [...new Set([...authority.slice(authority.indexOf(":") + 1, authority.lastIndexOf("@"))]
      .filter((c) => MUST_ENCODE.includes(c)))];
    faults.push(
      `the userinfo section contains ${atCount} unencoded '@' characters.\n` +
      `  libpq stops at the FIRST one, so pg_dump/psql read the host as:  ${libpqHost}\n` +
      `  which is not a host at all — hence a connection that cannot possibly succeed.\n` +
      `  The node driver splits at the LAST '@' instead, which is why the backend still works.\n` +
      `  Percent-encode ${badChars.map((c) => `'${c}' as ${enc(c)}`).join(", ") || "the offending characters"} in the PASSWORD.`
    );
  } else {
    const at = authority.indexOf("@");
    const userinfo = at >= 0 ? authority.slice(0, at) : "";
    let hostport = at >= 0 ? authority.slice(at + 1) : authority;
    const colon = userinfo.indexOf(":");
    const password = colon >= 0 ? userinfo.slice(colon + 1) : "";
    const user = colon >= 0 ? userinfo.slice(0, colon) : userinfo;

    const bad = [...new Set([...password].filter((c) => MUST_ENCODE.includes(c)))];
    if (bad.length) {
      faults.push(`the password contains unencoded ${bad.map((c) => `'${c}' (write it as ${enc(c)})`).join(", ")}.`);
    }
    // A lone '%' that is not a valid escape is decoded inconsistently between the two parsers.
    if (/%(?![0-9A-Fa-f]{2})/.test(password)) {
      faults.push("the password contains a '%' that is not a valid percent-escape. A literal '%' must be written as %25.");
    }

    // IPv6 literals are bracketed; strip the bracketed part before looking for the port.
    let host = hostport.startsWith("[")
      ? hostport.slice(0, hostport.indexOf("]") + 1)
      : hostport.replace(/:\d*$/, "");
    const portMatch = hostport.slice(host.length).match(/^:(\d*)$/);
    const port = portMatch ? (portMatch[1] || "(empty)") : "5432 (default)";
    let decodedHost = host;
    try { decodedHost = decodeURIComponent(host); } catch { /* leave as-is */ }

    if (decodedHost.startsWith("/")) {
      // This is the shape that produces: connection to server on socket "<dir>/.s.PGSQL.<port>"
      const line = `host resolves to the Unix-socket DIRECTORY ${decodedHost}` +
        `, so libpq connects to ${decodedHost}/.s.PGSQL.${/^\d+$/.test(port) ? port : "5432"} and never uses TCP.`;
      if (/^\/(\d{1,3}\.){3}\d{1,3}$/.test(decodedHost) || /^\/localhost$/.test(decodedHost)) {
        faults.push(line + `\n  A leading '/' in front of an address is almost always a mistake: for TCP write ` +
          `${decodedHost.slice(1)} with no slash.`);
      } else {
        notes.push(line);
      }
    } else if (host === "") {
      notes.push("no host given, so libpq uses its default Unix-socket directory (peer authentication).");
    } else {
      notes.push(`host ${decodedHost}, port ${port} over TCP.`);
    }
    // A '/' inside the password ends the authority early, so the real '@' lands in what libpq then
    // reads as the DATABASE NAME. That is the tell, and it is unambiguous.
    if (dbname.includes("@")) {
      faults.push("the database-name section contains '@', which means the password contains an unencoded '/'." +
        "\n  A '/' ends the host section, so everything after it is misread. Write it as %2F.");
    }
    // Whatever is left as the host must not still contain a ':' — that means the ':' was not a port
    // separator, so the split happened in the wrong place.
    if (!host.startsWith("[") && host.includes(":")) {
      faults.push(`the host section reads as '${host}', which still contains ':' — that is not a host:port pair.` +
        "\n  Usually a character in the password ('@', '/' or a space) was not percent-encoded.");
    }
    if (user) notes.push(`role ${user}${password ? "" : ", no password in the URL (.pgpass or peer auth)"}.`);
    if (dbname) notes.push(`database ${dbname}.`); else faults.push("no database name in the URL.");
  }
}
for (const n of notes) console.log("  " + n);
for (const f of faults) console.log("  PROBLEM: " + f);
process.exit(faults.length ? 1 : 0);
NODE
)" && lint_ok=1 || lint_ok=0
  [[ -n "$db_lint" ]] && printf '%s\n' "$db_lint" >&2
  if ! (( lint_ok )); then
    die "DATABASE_URL is malformed — no connection was attempted and nothing on this host was changed.

    as written (password masked) : $(redact_url "$DATABASE_URL")
    read from                    : ${GAR_B_DIR}/.env

    Fix the DATABASE_URL line above, then re-run. Percent-encoding the password does NOT change the
    password: both the node driver and libpq decode the escapes, so the backend keeps working.

    To ship a FRONTEND change while this is being fixed:  ./start.sh --frontend-only"
  fi

  db_err=""
  if have pg_dump; then
    # `-w` (never prompt): without it a missing password makes pg_dump sit waiting on a terminal,
    # and an unattended release would hang instead of failing. PGCONNECT_TIMEOUT bounds a host
    # that accepts the TCP connection but never completes the handshake.
    db_err="$(PGCONNECT_TIMEOUT=10 pg_dump -w --schema-only --no-owner --no-acl \
      --file=/dev/null "$DATABASE_URL" 2>&1)" && db_ok=1 || db_ok=0
  elif have pg_isready; then
    db_err="$(PGCONNECT_TIMEOUT=10 pg_isready -d "$DATABASE_URL" 2>&1)" && db_ok=1 || db_ok=0
  else
    db_ok=1
    warn "neither pg_dump nor pg_isready is installed — the database cannot be verified before deploying"
  fi
  if ! (( db_ok )); then
    printf '%s\n' "$db_err" | sed 's/^/      /' >&2
    die "cannot reach PostgreSQL — nothing on this host has been changed.

    connection string : $(redact_url "$DATABASE_URL")
    read from         : ${GAR_B_DIR}/.env

    Check in this order:
      1. is the server running?        systemctl status postgresql   (or: pg_isready)
      2. is host/port right?           the DATABASE_URL line in ${GAR_B_DIR}/.env
      3. can the role log in?          sudo -u postgres psql -c '\\du'
      4. does the database exist?      sudo -u postgres psql -c '\\l'

    The backup, the migrations and the backend all need this database, so the release stops here.
    To ship a FRONTEND change while this is being fixed:  ./start.sh --frontend-only"
  fi
  have pg_dump && ok "PostgreSQL reachable and credentials accepted"
fi

run $SUDO mkdir -p "$LOG_DIR"
(( SKIP_BACKUP )) || run $SUDO mkdir -p "$BACKUP_DIR"
ok "preflight passed"

# ── 1. git pull ──────────────────────────────────────────────────────────────────────────────

if (( FRONTEND_ONLY )); then step "Pull GAR_F"; else step "Pull GAR_B and GAR_F"; fi

# Reports the pre-pull commit in the global PULL_BEFORE rather than on stdout: this function LOGS,
# and capturing it with $(...) would swallow every log line into the variable instead of showing it.
PULL_BEFORE=""
pull_repo() {
  local dir="$1" name="$2"
  local before after branch
  before="$(git -C "$dir" rev-parse HEAD)"
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  PULL_BEFORE="$before"
  if [[ -n "$(git -C "$dir" status --porcelain)" ]]; then
    git -C "$dir" status --short >&2
    die "${name} has local changes. Commit, stash or discard them — a release must deploy a known commit."
  fi
  if (( SKIP_PULL )); then
    log "${name} ${branch} @ ${before:0:9} (pull skipped)"
    return 0
  fi
  run git -C "$dir" fetch --quiet --prune "$GIT_REMOTE"
  # FAST-FORWARD ONLY: never create a merge commit on a production host, and never silently
  # rewrite local history. A refusal here means the host has diverged and needs a human.
  run git -C "$dir" merge --ff-only "${GIT_REMOTE}/${branch}"
  after="$(git -C "$dir" rev-parse HEAD)"
  if [[ "$before" == "$after" ]]; then
    log "${name} ${branch} already up to date @ ${after:0:9}"
  else
    ok "${name} ${branch} ${before:0:9} → ${after:0:9}"
    git -C "$dir" --no-pager log --oneline "${before}..${after}" | sed 's/^/      /'
  fi
}

# --frontend-only leaves GAR_B COMPLETELY alone — not even a pull.
#
# That is deliberate, and it is what makes the mode trustworthy. Pulling the backend would move its
# source ahead of the dist/ the live process is actually running, so the next pm2 restart (including
# an automatic one after a crash) would run stale code against new source. Leaving the repo where it
# is also means GAR_B/contract/ still describes the backend that is genuinely deployed, which is
# precisely what the frontend needs to be checked against.
if (( FRONTEND_ONLY )); then
  log "GAR_B is not pulled, built or restarted in --frontend-only mode"
  GAR_B_BEFORE="$(git -C "$GAR_B_DIR" rev-parse HEAD)"
else
  pull_repo "$GAR_B_DIR" GAR_B; GAR_B_BEFORE="$PULL_BEFORE"
fi
pull_repo "$GAR_F_DIR" GAR_F; GAR_F_BEFORE="$PULL_BEFORE"

# ── 2. npm ci ────────────────────────────────────────────────────────────────────────────────

if (( FRONTEND_ONLY )); then
  step "Install frontend dependencies (npm ci, from the lockfile)"
else
  step "Install dependencies (npm ci, from the lockfiles)"
fi

# From here on the host has been changed, so a failure prints the recovery report.
MUTATED=1

# `npm ci` deletes node_modules and installs EXACTLY the lockfile. devDependencies are required:
# both repos build with TypeScript, and the frontend needs vite.
#
# In --frontend-only the backend install is skipped for a safety reason, not just for speed: `npm ci`
# DELETES node_modules, and doing that under a live process means any restart in that window — a pm2
# reload, or an automatic restart after a crash — boots into a directory with no dependencies.
if (( FRONTEND_ONLY )); then
  log "GAR_B node_modules left in place (removing it under the live process is not worth the risk)"
else
  ( cd "$GAR_B_DIR" && run npm ci --no-audit --no-fund )
  ok "GAR_B dependencies installed"
fi
( cd "$GAR_F_DIR" && run npm ci --no-audit --no-fund )
ok "GAR_F dependencies installed"

# ── 3. build ─────────────────────────────────────────────────────────────────────────────────

if (( FRONTEND_ONLY )); then step "Build frontend"; else step "Build backend and frontend"; fi

# tsconfig sets noEmitOnError, so a type error produces NO dist rather than a half-built one.
if (( FRONTEND_ONLY )); then
  log "GAR_B dist/ untouched — the running process keeps the build it was started with"
else
  ( cd "$GAR_B_DIR" && run npm run build )
  [[ -f "$GAR_B_DIR/dist/index.js" ]] || (( DRY_RUN )) || die "backend build produced no dist/index.js"
  ok "backend built"
fi

( cd "$GAR_F_DIR" && run npm run build )
[[ -f "$GAR_F_DIR/dist/index.html" ]] || (( DRY_RUN )) || die "frontend build produced no dist/index.html"
ok "frontend built"

# ── 4. contract ──────────────────────────────────────────────────────────────────────────────

step "Verify the frontend/backend contract"

# TWO checks, because they answer different questions.
#
#   (a) GAR_F's own `contract:verify` proves its VENDORED schemas are internally consistent — the
#       recomputed digest matches both version.json and BACKEND_CONTRACT.json. Its own header is
#       explicit that it CANNOT prove those schemas match the backend being deployed.
#
#   (b) So this script closes exactly that gap: it recomputes the digest from THIS backend's
#       contract/ and compares it with what the frontend pinned. A frontend built against an older
#       or newer wire shape than the backend now serving it is the failure that check (a) misses,
#       and it must stop the release BEFORE anything is published.
( cd "$GAR_F_DIR" && run npm run contract:verify )
ok "frontend contract is internally consistent"

if ! (( DRY_RUN )); then
  backend_digest="$(cd "$GAR_B_DIR" && node contract/digest.mjs)" \
    || die "could not compute the backend contract digest"
  frontend_pin="$(json_field "$GAR_F_DIR/contract/BACKEND_CONTRACT.json" schemas_sha256)" \
    || die "could not read the frontend's pinned contract digest"
  backend_version="$(json_field "$GAR_B_DIR/contract/version.json" contract_version)" || die "unreadable backend contract/version.json"
  frontend_version="$(json_field "$GAR_F_DIR/contract/BACKEND_CONTRACT.json" contract_version)" || die "unreadable frontend BACKEND_CONTRACT.json"

  # An EMPTY value means the file or field is missing, which is a different problem from a genuine
  # mismatch and must not be reported as one.
  [[ -n "$backend_digest" ]] || die "the backend contract digest came back empty"
  [[ -n "$frontend_pin" ]] || die "GAR_F/contract/BACKEND_CONTRACT.json has no schemas_sha256"

  if [[ "$backend_digest" != "$frontend_pin" ]]; then
    printf '    backend  contract/ digest : %s\n' "$backend_digest" >&2
    printf '    frontend pinned  digest   : %s\n' "$frontend_pin" >&2
    die "CONTRACT MISMATCH — the frontend was built against a different backend wire contract.
    Re-vendor the contract into GAR_F (copy GAR_B/contract/{schemas,protocol.json,version.json},
    refresh contract/BACKEND_CONTRACT.json, run 'npm run contract:types') and redeploy.
    Publishing this pair would give the UI a shape the backend does not serve."
  fi
  [[ "$backend_version" == "$frontend_version" ]] \
    || die "contract_version differs: backend ${backend_version} vs frontend ${frontend_version}"
  ok "contract matches this backend (v${backend_version}, ${backend_digest:0:12}…)"
fi

# ── 5. backup ────────────────────────────────────────────────────────────────────────────────

if (( FRONTEND_ONLY )); then step "PostgreSQL backup (skipped)"; else step "Back up PostgreSQL"; fi

# PostgreSQL is the backup of record (docs/DEPLOYMENT.md §7 — MongoDB Atlas is an async reporting
# replica and is NOT a backup). Taken BEFORE the schema can change, and a failure here stops the
# release: migrating without a backup is the one irreversible step in this pipeline.
if (( SKIP_BACKUP )); then
  if (( FRONTEND_ONLY )); then
    log "--frontend-only: the database is not touched, so no backup is taken"
  else
    warn "--no-backup: skipping pg_dump"
  fi
else
  backup_target="${BACKUP_DIR}/gts_$(date +%Y%m%d-%H%M%S).dump"
  run $SUDO mkdir -p "$BACKUP_DIR"
  if (( DRY_RUN )); then
    printf '%s      would run:%s pg_dump --format=custom "$DATABASE_URL" -> %s\n' \
      "$C_DIM" "$C_RESET" "$backup_target"
  else
    # THE DUMP RUNS AS THE INVOKING USER. THE SUDO IS ONLY FOR THE FILE.
    #
    # This step used to be `sudo -E pg_dump --file=/var/backups/...`, which conflated two entirely
    # different needs: permission to WRITE into /var/backups/gts (root), and identity to CONNECT to
    # PostgreSQL (this user). Running the dump through sudo broke the second one two ways:
    #
    #   * a normal sudoers policy refuses `-E` outright — "preserving the entire environment is not
    #     supported, '-E' is ignored" — so DATABASE_URL did not even reach pg_dump, and
    #   * as root the connection loses this user's identity: peer/ident authentication, ~/.pgpass,
    #     PGUSER/PGHOST. The dump then connects as the wrong role, or not at all.
    #
    # So the dump is taken as the invoking user into a private temp file, and root is used for the
    # one thing that genuinely requires it: installing the finished file into BACKUP_DIR, 0600,
    # because a database dump must not be world-readable.
    tmp_dump="$(mktemp "${TMPDIR:-/tmp}/gts-dump.XXXXXXXX")"
    if ! PGCONNECT_TIMEOUT=10 pg_dump -w --format=custom --no-owner \
        --file="$tmp_dump" "$DATABASE_URL"; then
      rm -f "$tmp_dump"
      die "pg_dump FAILED — refusing to continue to migrations without a backup.
    The database answered during preflight, so this is a dump-time problem (permissions on a
    specific table, disk space in ${TMPDIR:-/tmp}, or the server going away mid-dump)."
    fi
    # An empty dump is worse than no dump, because it looks like a backup.
    if [[ ! -s "$tmp_dump" ]]; then
      rm -f "$tmp_dump"
      die "pg_dump exited 0 but produced an empty file — treating that as no backup at all"
    fi
    backup_size="$(du -h "$tmp_dump" | cut -f1)"
    if ! $SUDO install -m 600 "$tmp_dump" "$backup_target"; then
      rm -f "$tmp_dump"
      die "the dump was taken but could not be installed into ${BACKUP_DIR} — check the directory's ownership"
    fi
    rm -f "$tmp_dump"
    # Set only now that the file really exists, so the recovery report never points at a dump that
    # was never written.
    BACKUP_FILE="$backup_target"
    ok "backup written: ${BACKUP_FILE} (${backup_size})"
    # Prune old dumps, but only ever inside BACKUP_DIR.
    $SUDO find "$BACKUP_DIR" -maxdepth 1 -name 'gts_*.dump' -mtime "+${BACKUP_RETENTION_DAYS}" \
      -delete 2>/dev/null || true
  fi
fi

# ── 6. migrate ───────────────────────────────────────────────────────────────────────────────

if (( FRONTEND_ONLY )); then step "Database migrations (skipped)"; else step "Database migrations"; fi

# `migrate -- --check` is assert-only: exit 0 = schema current, non-zero = behind. Asking first
# means a release with no schema change never stops the app, and a release WITH one stops it before
# touching the schema — docs/DEPLOYMENT.md: "Never migrate under a live, armed process."
MIGRATION_PENDING=0
if (( FRONTEND_ONLY )); then
  log "--frontend-only: the schema is neither inspected nor changed"
elif (( DRY_RUN )); then
  printf '%s      would run:%s npm run migrate -- --check\n' "$C_DIM" "$C_RESET"
else
  if ( cd "$GAR_B_DIR" && npm run --silent migrate -- --check >/dev/null 2>&1 ); then
    ok "schema is already current — no migration, no downtime"
  else
    MIGRATION_PENDING=1
    warn "migrations are PENDING"
  fi
fi

STOPPED_FOR_MIGRATION=0
if (( MIGRATION_PENDING )); then
  (( SKIP_BACKUP )) && die "refusing to migrate with --no-backup: take a pg_dump first"
  confirm "Stop ${PM2_APP}, apply migrations, then restart. Continue?"
  if pm2 describe "$PM2_APP" >/dev/null 2>&1; then
    log "stopping ${PM2_APP} so no armed process runs against a changing schema"
    run pm2 stop "$PM2_APP"
    STOPPED_FOR_MIGRATION=1
  fi
  ( cd "$GAR_B_DIR" && run npm run migrate ) || die "migration FAILED — app is stopped; restore ${BACKUP_FILE} if needed"
  MIGRATED=1
  ( cd "$GAR_B_DIR" && run npm run --silent migrate -- --check ) || die "schema still reports behind after migrating"
  ok "migrations applied and verified"
fi

# ── 7. effective config ──────────────────────────────────────────────────────────────────────

if (( FRONTEND_ONLY )); then
  step "Backend configuration (skipped)"
else
  step "Validate the effective backend configuration"
fi

# A .env is a REQUEST for a configuration; the value in force can differ (unset → default,
# out-of-range → clamped, unparseable → default). This prints what will ACTUALLY run, with
# provenance, and refuses a config that would not boot (the CLI exits 2 for that).
if (( FRONTEND_ONLY )); then
  log "--frontend-only: the running backend keeps the configuration it booted with"
elif (( DRY_RUN )); then
  printf '%s      would run:%s node --import ./dist/env/boot.js dist/box/effectiveConfig.js\n' "$C_DIM" "$C_RESET"
else
  # `--import ./dist/env/boot.js` is how index.ts gets its environment (protected secrets file, then
  # .env, neither overriding the process environment). effectiveConfig.js has no such import of its own
  # because it is also a library imported by tests, so the loader is applied here instead of
  # re-implementing .env resolution. `--import` not `-r`: the loader is ESM.
  ( cd "$GAR_B_DIR" && node --import ./dist/env/boot.js dist/box/effectiveConfig.js ) \
    || die "effective configuration is invalid — the backend would not boot"

  # Report the safety-relevant state WITHOUT changing it. This script never arms anything.
  effective_json="$(mktemp)"
  ( cd "$GAR_B_DIR" && node --import ./dist/env/boot.js dist/box/effectiveConfig.js --json ) > "$effective_json"
  EFFECTIVE_JSON="$effective_json" node <<'NODE'
const report = JSON.parse(require("node:fs").readFileSync(process.env.EFFECTIVE_JSON, "utf8"));
const byEnv = new Map(report.values.map((v) => [v.envVar, v]));
const show = (k) => { const v = byEnv.get(k); return v ? `${v.value} (${v.source})` : "ABSENT"; };
const gates = [
  "BOX_LIVE_REQUIRE_FUNDS_COVER",
  "BOX_LIVE_REQUIRE_MARGIN_EVIDENCE",
  "BOX_LIVE_REQUIRE_STAGE_FUNDING",
  "BOX_LIVE_RECOVERY_RESERVE_RUPEES",
];
console.log("");
console.log("  EXECUTION / FUNDING STATE (reported, never changed by this script)");
console.log(`    live trading armed      : ${report.liveTradingArmed}`);
console.log(`    execution mode          : ${show("BOX_EXECUTION_MODE")}`);
for (const g of gates) console.log(`    ${g.padEnd(24)}: ${show(g)}`);
const off = gates.slice(0, 3).filter((g) => byEnv.get(g)?.value !== true);
if (report.liveTradingArmed && off.length > 0) {
  console.log("");
  console.log(`  WARNING: live trading is armed but ${off.length} funding evidence gate(s) are OFF:`);
  for (const g of off) console.log(`    - ${g}`);
  console.log("  Entry can be admitted WITHOUT funds/margin evidence being read. This is a");
  console.log("  configuration choice, not a verified-funding state. See docs/ECONOMIC_ADMISSION.md.");
}
if (byEnv.get("BOX_LIVE_RECOVERY_RESERVE_RUPEES")?.value === 0) {
  console.log("  NOTE: BOX_LIVE_RECOVERY_RESERVE_RUPEES=0 — no funds are held back for a recovery");
  console.log("  action. There is no safe default; size it per docs/ECONOMIC_ADMISSION.md.");
}
NODE
  rm -f "$effective_json"
  ok "configuration validated"
fi

# ── 8. pm2 ───────────────────────────────────────────────────────────────────────────────────

if (( FRONTEND_ONLY )); then step "${PM2_APP} (untouched)"; else step "Start / reload ${PM2_APP}"; fi

if (( FRONTEND_ONLY )); then
  # Not restarting is the POINT of this mode: a UI fix must not interrupt an engine that may be
  # holding open positions.
  log "--frontend-only: ${PM2_APP} is left running exactly as it is"
elif (( DRY_RUN )); then
  printf '%s      would run:%s pm2 start ecosystem.config.cjs  (or reload if already running)\n' \
    "$C_DIM" "$C_RESET"
elif pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  if (( STOPPED_FOR_MIGRATION )); then
    # It was stopped for the migration, so start it rather than reload a stopped app.
    ( cd "$GAR_B_DIR" && run pm2 start ecosystem.config.cjs --only "$PM2_APP" )
    ok "${PM2_APP} started after migration"
  else
    # `reload` is graceful: SIGTERM, then up to kill_timeout (30s) for the shutdown sequence
    # (stop scanner → drain outbox → close Mongo → close PostgreSQL last) before SIGKILL.
    ( cd "$GAR_B_DIR" && run pm2 reload "$PM2_APP" --update-env )
    ok "${PM2_APP} reloaded"
  fi
else
  ( cd "$GAR_B_DIR" && run pm2 start ecosystem.config.cjs --only "$PM2_APP" )
  ok "${PM2_APP} started"
fi
(( FRONTEND_ONLY )) || run pm2 save --force

# ── 9. health ────────────────────────────────────────────────────────────────────────────────

if (( FRONTEND_ONLY )); then
  step "Check the RUNNING backend's contract before publishing"

  # This is the check that makes --frontend-only safe.
  #
  # Step 4 proved the frontend matches the backend SOURCE now checked out. In this mode the backend
  # process was NOT restarted, so it is still serving whatever it booted with — which may be older
  # than that source. Publishing a UI built for a newer wire shape than the live process speaks is
  # exactly the breakage this mode could otherwise introduce, so it is caught here, BEFORE the web
  # root is touched and while a refusal costs nothing.
  if (( DRY_RUN )); then
    printf '%s      would read:%s %s/api/box/status and compare its contract digest\n' \
      "$C_DIM" "$C_RESET" "$LOCAL_API"
  else
    running_digest="$(curl -fsS --max-time 10 "${LOCAL_API}/api/box/status" 2>/dev/null \
      | node -pe 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).contract?.schemas_sha256??""}catch{""}' 2>/dev/null || true)"
    if [[ -z "$running_digest" ]]; then
      # The status surface is behind the access gate, so an empty answer can mean "not authorised"
      # just as easily as "not running". Either way it is unknowable from here, and this must not be
      # reported as a mismatch.
      warn "could not read the running backend's contract digest from ${LOCAL_API}/api/box/status"
      warn "(it may be down, or the status surface may require the access gate). Publishing anyway"
      warn "because --frontend-only was requested. If the UI shows shape errors, run a full release."
    elif [[ "$running_digest" != "${frontend_pin:-}" ]]; then
      printf '    running backend serves : %s\n' "$running_digest" >&2
      printf '    frontend pinned        : %s\n' "${frontend_pin:-<unread>}" >&2
      die "the RUNNING backend speaks a different contract than this frontend was built for.
    Nothing was published. The backend source in ${GAR_B_DIR} is probably ahead of the process
    that is live, so a frontend-only release is not enough here — run a full ./start.sh."
    else
      ok "the running backend serves the contract this frontend pinned (${running_digest:0:12}…)"
    fi
  fi
else
step "Wait for the backend to report ready"

# The backend binds its socket EARLY and answers /api/health with 503 until boot finishes
# (listen-with-503), so "the port is open" proves nothing. Ready means HTTP 200 AND ready:true.
if (( DRY_RUN )); then
  printf '%s      would poll:%s %s until ready\n' "$C_DIM" "$C_RESET" "$HEALTH_URL"
else
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
  attempt=0
  until body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)" \
        && [[ "$(printf '%s' "$body" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).ready' 2>/dev/null)" == "true" ]]; do
    attempt=$((attempt + 1))
    if (( $(date +%s) >= deadline )); then
      echo
      warn "last 40 log lines:"
      pm2 logs "$PM2_APP" --lines 40 --nostream 2>/dev/null || true
      die "${PM2_APP} did not become ready within ${HEALTH_TIMEOUT_SECS}s (${HEALTH_URL})"
    fi
    if ! pm2 describe "$PM2_APP" 2>/dev/null | grep -qE 'status.*online'; then
      echo
      pm2 logs "$PM2_APP" --lines 40 --nostream 2>/dev/null || true
      die "${PM2_APP} is not online — it crashed during boot"
    fi
    (( attempt % 5 == 1 )) && log "waiting for ready… (${attempt})"
    sleep 2
  done
  ok "backend is ready: ${body}"
fi
fi

# ── 10. publish the frontend ─────────────────────────────────────────────────────────────────

if (( SKIP_FRONTEND )); then
  step "Frontend (skipped)"
  warn "--skip-frontend: ${WEB_ROOT} and nginx left untouched"
else
  step "Publish the frontend to ${WEB_ROOT}"

  # Published only AFTER the backend is confirmed ready, so the new UI never talks to an old or
  # dead API. The previous root is kept so a failed `nginx -t` rolls straight back.
  run $SUDO mkdir -p "$WEB_ROOT"
  if [[ -d "$WEB_ROOT" ]] && [[ -n "$($SUDO ls -A "$WEB_ROOT" 2>/dev/null)" ]]; then
    WEB_BACKUP="${WEB_ROOT%/}.prev-$(date +%Y%m%d-%H%M%S)"
    sync_dir "$WEB_ROOT" "$WEB_BACKUP"
    log "previous frontend kept at ${WEB_BACKUP}"
  fi
  sync_dir "${GAR_F_DIR}/dist" "$WEB_ROOT"
  ok "frontend published"

  step "Validate the nginx configuration"
  run $SUDO nginx -t || die "nginx -t FAILED — configuration not reloaded"
  ok "nginx configuration is valid"

  step "Reload nginx"
  if ! run $SUDO systemctl reload nginx 2>/dev/null; then
    run $SUDO nginx -s reload || die "nginx reload FAILED"
  fi
  ok "nginx reloaded"
fi

# ── 13. verify the public surface ────────────────────────────────────────────────────────────

step "Verify the public URLs"

# ── WHY THESE CHECKS TALK TO THE ORIGIN, NOT THE PUBLIC EDGE ─────────────────────────────────
#
# This step used to curl PUBLIC_BASE directly, and a release was rolled back because
# `https://gtsalgoresearch.online/` returned 403. Nothing was wrong with the deployment: nginx had
# validated and reloaded, the backend was ready, the files were published. CLOUDFLARE'S BOT/CHALLENGE
# LAYER had simply decided a command-line curl was not a human and answered 403 on its behalf.
#
# That is a FALSE DEPLOYMENT FAILURE, and an expensive one: it discarded a good frontend and left the
# operator reading a rollback banner for a site that was serving perfectly in a browser. It was also
# the LAST step, so everything before it had already succeeded.
#
# Worse, the same flaw was in the two API checks below. A challenged /api/health would have hit
# `die "…could not be reached at all — nginx is not reaching the backend"`, which is a confident and
# completely wrong diagnosis; and the contract-digest check used `curl -fsS`, so a 403 produced an
# empty string and the check SILENTLY PASSED — a verification that cannot fail is not one.
#
# So the release now verifies the ORIGIN: the public hostname pinned to the loopback address with
# `--resolve`, which exercises the real TLS vhost, the real published files, the real SPA fallback and
# the real API proxy, while bypassing any CDN or WAF in front of them. Those are the things this
# script actually changed, so those are the things it is entitled to fail on.
#
# The public edge is still probed, but as a REPORT rather than a gate — see `probe_public_url`.
PUBLIC_HOST="${PUBLIC_BASE#*://}"; PUBLIC_HOST="${PUBLIC_HOST%%/*}"
case "$PUBLIC_BASE" in https://*) ORIGIN_DEFAULT_PORT=443 ;; *) ORIGIN_DEFAULT_PORT=80 ;; esac
case "$PUBLIC_HOST" in
  *:*) PUBLIC_PORT="${PUBLIC_HOST##*:}"; PUBLIC_HOST="${PUBLIC_HOST%%:*}" ;;
  *)   PUBLIC_PORT="$ORIGIN_DEFAULT_PORT" ;;
esac
# Overridable for a host where nginx does not listen on loopback (containers, a bound public IP).
ORIGIN_ADDR="${ORIGIN_ADDR:-127.0.0.1}"
log "origin     ${PUBLIC_HOST}:${PUBLIC_PORT} → ${ORIGIN_ADDR} (CDN bypassed for verification)"

# One curl invocation shape for every origin request, so they cannot drift apart.
#
# `-k` IS DELIBERATE AND IS NOT A WEAKENING OF THIS GATE. Resolving to the loopback still sends the
# real SNI, so the origin presents its own certificate — which on a Cloudflare-fronted host is
# routinely a Cloudflare Origin CA cert that is not in the system trust store and cannot validate
# locally. This check exists to prove CONTENT AND ROUTING, not chain-of-trust; the public probe below
# is what exercises the real edge certificate. Verifying trust here would fail on a correct
# deployment, which is the exact class of false failure this whole section is fixing.
origin_curl() {
  curl -sS -k --max-time 15 --resolve "${PUBLIC_HOST}:${PUBLIC_PORT}:${ORIGIN_ADDR}" "$@"
}

check_origin_url() {
  local url="$1" want="$2" desc="$3" code
  if (( DRY_RUN )); then printf '%s      would check (origin):%s %s\n' "$C_DIM" "$C_RESET" "$url"; return 0; fi
  # curl prints %{http_code} (as "000") on a failed transfer, so an `|| echo 000` fallback would
  # concatenate two codes and never compare equal to anything.
  code="$(origin_curl -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" || true
  code="${code:-000}"
  if [[ "$code" == "$want" ]]; then
    ok "${code}  ${url}  (origin — ${desc})"
  else
    die "${url} returned ${code} AT THE ORIGIN, expected ${want} (${desc}).
    This is a real deployment fault: the CDN was bypassed, so nginx, the published files and the
    proxy answered this themselves. Check:  sudo tail -40 /var/log/nginx/error.log"
  fi
}

# The public edge, reported and never fatal.
#
# A CDN challenge here says nothing about the deployment, and a genuine edge fault (DNS, CDN origin
# settings, an expired edge certificate) is not something rolling back the frontend would repair. The
# origin checks above already established that what this script deployed is correct, so this probe's
# job is to tell the operator what the outside world currently sees — not to undo their release.
probe_public_url() {
  local url="$1" want="$2" desc="$3" hdrs code server mitigated
  if (( DRY_RUN )); then printf '%s      would probe (public):%s %s\n' "$C_DIM" "$C_RESET" "$url"; return 0; fi
  hdrs="$(mktemp)"
  code="$(curl -sS -o /dev/null -D "$hdrs" -w '%{http_code}' --max-time 15 "$url" 2>/dev/null)" || true
  code="${code:-000}"
  server="$(grep -i '^server:' "$hdrs" 2>/dev/null | tail -1 | tr -d '\r' | cut -d' ' -f2- || true)"
  mitigated="$(grep -i '^cf-mitigated:' "$hdrs" 2>/dev/null | tail -1 | tr -d '\r' | cut -d' ' -f2- || true)"
  rm -f "$hdrs"
  if [[ "$code" == "$want" ]]; then
    ok "${code}  ${url}  (public — ${desc})"
  elif [[ -n "$mitigated" ]] || [[ "$code" == "403" && "$server" == *[Cc]loudflare* ]] \
       || [[ "$code" == "503" && "$server" == *[Cc]loudflare* ]]; then
    warn "${url} returned ${code} from ${server:-the CDN}${mitigated:+ (cf-mitigated: ${mitigated})}"
    warn "  INCONCLUSIVE, not a failure: the CDN challenged an automated request. The origin check"
    warn "  above already proved this path serves correctly. Confirm in a browser if unsure."
  else
    warn "${url} returned ${code}, expected ${want} (${desc}) — but the ORIGIN served it correctly,"
    warn "  so this is an edge/DNS/CDN condition and NOT a fault in what was just deployed. The"
    warn "  release is being kept. Investigate the CDN configuration separately."
  fi
}

check_origin_url "${PUBLIC_BASE}/"    200 "public site"
check_origin_url "${PUBLIC_BASE}/box" 200 "SPA route — nginx try_files must fall back to index.html"
probe_public_url "${PUBLIC_BASE}/"    200 "what the outside world sees"
if ! (( DRY_RUN )); then
  # DELIBERATELY NOT `curl -f`. The backend answers /api/health with 503 AND a JSON body saying WHY
  # it is not ready. `-f` discards that body and leaves only "did not return 200", which then reads
  # like an nginx routing problem when the truth might be "PostgreSQL is unavailable". The body IS
  # the diagnosis, so the status line and the body are captured separately and both are reported.
  # No `|| printf '\n000'` fallback: curl writes its --write-out string even when the transfer
  # FAILS, so a fallback appended a second code and the body then rendered as a stray "000" line.
  # curl's own output already ends in "\n000" on a failure, so only its exit status is discarded.
  # THROUGH THE ORIGIN, for the reason given above. Previously this went to the public edge, so a
  # Cloudflare challenge landed on the `health_code == "000"`/else branches and killed the release
  # with "nginx is not reaching the backend" — a confident, wrong, and very misleading diagnosis of a
  # backend that was answering ready:true the whole time.
  health_raw="$(origin_curl -w '\n%{http_code}' "${PUBLIC_BASE}/api/health" 2>/dev/null)" || true
  health_code="${health_raw##*$'\n'}"      # text after the LAST newline
  health_code="${health_code:-000}"        # curl produced nothing at all
  health="${health_raw%$'\n'*}"            # everything before it
  health_ready="$(printf '%s' "$health" | node -pe 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).ready===true}catch{false}' 2>/dev/null || echo false)"
  if [[ "$health_code" == "200" && "$health_ready" == "true" ]]; then
    ok "200  ${PUBLIC_BASE}/api/health  (${health})"
  elif (( FRONTEND_ONLY )); then
    # A frontend-only release did not start, reload or configure the backend, so its state is not
    # this run's result and must not be reported as this run's failure. Rolling the UI back would
    # not fix a backend that was already unhealthy before the script ran — it would only discard the
    # change that did succeed. So: say it plainly, and leave the published frontend in place.
    warn "${PUBLIC_BASE}/api/health returned HTTP ${health_code}: ${health:-<empty body>}"
    warn "This run did not touch the backend, so that is a PRE-EXISTING condition, not a failure of"
    warn "this release. The frontend was published and is being kept. Investigate separately:"
    warn "  pm2 logs ${PM2_APP} --lines 50"
  elif [[ "$health_code" == "000" ]]; then
    die "${PUBLIC_BASE}/api/health could not be reached at all — nginx is not reaching the backend"
  else
    die "${PUBLIC_BASE}/api/health returned HTTP ${health_code} and does not report ready: ${health:-<empty body>}"
  fi

  # The UI is only usable if it was built against the contract this backend serves. Compare the
  # digest the running backend reports with what the frontend pinned.
  #
  # ALSO MOVED TO THE ORIGIN, and this one mattered most of the three. It used `curl -fsS`, so a CDN
  # challenge (or any non-2xx) produced an EMPTY string, the `-n "$served"` guard skipped the
  # comparison, and the release reported success having verified nothing. A check that silently passes
  # when it cannot run is worse than no check, because it is mistaken for evidence.
  served="$(origin_curl "${PUBLIC_BASE}/api/box/status" 2>/dev/null \
    | node -pe 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).contract?.schemas_sha256??""}catch{""}' 2>/dev/null || true)"
  if [[ -z "$served" ]]; then
    # Legitimately possible: /api/box/status sits behind the site access gate, so an unauthenticated
    # probe cannot read it. That is not a fault, but it does mean this comparison did not happen — and
    # after the silent-pass bug above, saying so out loud is the whole point.
    warn "could not read the served contract digest from ${PUBLIC_BASE}/api/box/status at the origin"
    warn "  (most likely the access gate). The frontend/backend contract match was NOT verified here;"
    warn "  step 05 did verify the frontend against the backend SOURCE that was checked out."
  elif [[ -n "${frontend_pin:-}" && "$served" != "$frontend_pin" ]]; then
    die "the RUNNING backend serves contract ${served:0:12}… but the frontend pinned ${frontend_pin:0:12}…"
  else
    ok "the running backend serves the contract this frontend pinned (${served:0:12}…)"
  fi
fi

# ── done ─────────────────────────────────────────────────────────────────────────────────────

trap - EXIT
if (( FRONTEND_ONLY )); then
  printf '\n%s%sFRONTEND RELEASE COMPLETE%s  (backend and database untouched)\n' \
    "$C_BOLD" "$C_GREEN" "$C_RESET"
else
  printf '\n%s%sRELEASE COMPLETE%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
fi
if ! (( DRY_RUN )); then
  printf '  GAR_B      %s%s\n' "$(git -C "$GAR_B_DIR" rev-parse --short HEAD)" \
    "$( (( FRONTEND_ONLY )) && printf '  (not pulled, not rebuilt, not restarted)' || true )"
  printf '  GAR_F      %s\n' "$(git -C "$GAR_F_DIR" rev-parse --short HEAD)"
  [[ -n "$BACKUP_FILE" ]] && printf '  DB backup  %s\n' "$BACKUP_FILE"
  (( MIGRATED )) && printf '  migrations APPLIED in this run\n'
  [[ -n "$WEB_BACKUP" ]] && printf '  prev UI    %s  (delete when satisfied)\n' "$WEB_BACKUP"
  printf '\n  pm2 logs %s --lines 50\n' "$PM2_APP"
  printf '  %s/box\n' "$PUBLIC_BASE"
fi

# TRADING IS NOT ARMED BY A RELEASE. If this deployment is meant to trade, arm it deliberately
# through the operator API and confirm on the status surface:
#   GET /api/box/status -> operational_readiness.entry.permitted
#                       -> economic_admission.funding_readiness.status
# `checks_disabled` there means no funding evidence was read at all — it is NOT "funding verified".
