#!/usr/bin/env bash
#
# GTS Algo Research — production release script.
#
#   ./start.sh                 full release
#   ./start.sh --dry-run       print every command, change nothing
#   ./start.sh --help          all flags
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# THE PIPELINE
# ─────────────────────────────────────────────────────────────────────────────────────────────
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

DRY_RUN=0
SKIP_PULL=0
SKIP_BACKUP=0
SKIP_FRONTEND=0
ASSUME_YES=0

usage() {
  sed -n '2,48p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

FLAGS
  --dry-run          Print what would run. Changes nothing.
  --skip-pull        Deploy the working tree as-is (no git pull).
  --skip-frontend    Backend only; leaves the web root and nginx untouched.
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
    --no-backup) SKIP_BACKUP=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown flag: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

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

step "Preflight"

for c in git npm node curl tar; do need_cmd "$c"; done
have rsync || log "rsync not present — using the tar fallback for the frontend copy"
need_cmd pm2
(( SKIP_FRONTEND )) || need_cmd nginx
[[ -d "$GAR_B_DIR/.git" ]] || die "not a git repo: ${GAR_B_DIR}"
[[ -d "$GAR_F_DIR/.git" ]] || die "frontend repo not found at ${GAR_F_DIR} (set GAR_F_DIR in deploy.env)"
[[ -f "$GAR_B_DIR/ecosystem.config.cjs" ]] || die "missing ecosystem.config.cjs in ${GAR_B_DIR}"
[[ -f "$GAR_B_DIR/.env" ]] || die "missing ${GAR_B_DIR}/.env — the release cannot validate config or reach the database"

# `.env` supplies DATABASE_URL and PORT. index.ts and migrate.ts load it themselves via
# `dotenv/config`, but effectiveConfig.js does NOT, and neither does pg_dump.
#
# IT IS PARSED, NOT SOURCED. `. .env` would run the file as shell: a value containing `<`, `&`,
# backticks or `$(...)` either breaks the release or executes on this host, and a real .env is full
# of passwords, URLs and JSON. The reader below only ever assigns the ONE key it is asked for.
# Values are passed in through the environment so no shell quoting is involved anywhere.
read_env() {
  ENV_FILE="$GAR_B_DIR/.env" ENV_KEY="$1" node <<'NODE'
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

DATABASE_URL="$(read_env DATABASE_URL)"
[[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is not set in ${GAR_B_DIR}/.env"
export DATABASE_URL
PORT="$(read_env PORT)"; PORT="${PORT:-3001}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"
(( SKIP_BACKUP )) || need_cmd pg_dump

node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 20 )) || die "Node 20+ required, found $(node -v)"
ok "node $(node -v), npm $(npm -v), pm2 $(pm2 -v 2>/dev/null | tail -1)"

run $SUDO mkdir -p "$LOG_DIR" "$BACKUP_DIR"
ok "preflight passed"

# ── 1. git pull ──────────────────────────────────────────────────────────────────────────────

step "Pull GAR_B and GAR_F"

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

pull_repo "$GAR_B_DIR" GAR_B; GAR_B_BEFORE="$PULL_BEFORE"
pull_repo "$GAR_F_DIR" GAR_F; GAR_F_BEFORE="$PULL_BEFORE"

# ── 2. npm ci ────────────────────────────────────────────────────────────────────────────────

step "Install dependencies (npm ci, from the lockfiles)"

# From here on the host has been changed, so a failure prints the recovery report.
MUTATED=1

# `npm ci` deletes node_modules and installs EXACTLY the lockfile. devDependencies are required:
# both repos build with TypeScript, and the frontend needs vite.
( cd "$GAR_B_DIR" && run npm ci --no-audit --no-fund )
ok "GAR_B dependencies installed"
( cd "$GAR_F_DIR" && run npm ci --no-audit --no-fund )
ok "GAR_F dependencies installed"

# ── 3. build ─────────────────────────────────────────────────────────────────────────────────

step "Build backend and frontend"

# tsconfig sets noEmitOnError, so a type error produces NO dist rather than a half-built one.
( cd "$GAR_B_DIR" && run npm run build )
[[ -f "$GAR_B_DIR/dist/index.js" ]] || (( DRY_RUN )) || die "backend build produced no dist/index.js"
ok "backend built"

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
  backend_digest="$(cd "$GAR_B_DIR" && node contract/digest.mjs)"
  frontend_pin="$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.schemas_sha256??"")' \
    "$GAR_F_DIR/contract/BACKEND_CONTRACT.json")"
  backend_version="$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.contract_version??"")' \
    "$GAR_B_DIR/contract/version.json")"
  frontend_version="$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.contract_version??"")' \
    "$GAR_F_DIR/contract/BACKEND_CONTRACT.json")"

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

step "Back up PostgreSQL"

# PostgreSQL is the backup of record (docs/DEPLOYMENT.md §7 — MongoDB Atlas is an async reporting
# replica and is NOT a backup). Taken BEFORE the schema can change, and a failure here stops the
# release: migrating without a backup is the one irreversible step in this pipeline.
if (( SKIP_BACKUP )); then
  warn "--no-backup: skipping pg_dump"
else
  BACKUP_FILE="${BACKUP_DIR}/gts_$(date +%Y%m%d-%H%M%S).dump"
  run $SUDO mkdir -p "$BACKUP_DIR"
  if (( DRY_RUN )); then
    printf '%s      would run:%s pg_dump --format=custom --file=%s "$DATABASE_URL"\n' \
      "$C_DIM" "$C_RESET" "$BACKUP_FILE"
  else
    $SUDO -E pg_dump --format=custom --no-owner --file="$BACKUP_FILE" "$DATABASE_URL" \
      || die "pg_dump FAILED — refusing to continue to migrations without a backup"
    $SUDO test -s "$BACKUP_FILE" || die "pg_dump produced an empty file: ${BACKUP_FILE}"
    ok "backup written: ${BACKUP_FILE} ($($SUDO du -h "$BACKUP_FILE" | cut -f1))"
    # Prune old dumps, but only ever inside BACKUP_DIR.
    $SUDO find "$BACKUP_DIR" -maxdepth 1 -name 'gts_*.dump' -mtime "+${BACKUP_RETENTION_DAYS}" \
      -delete 2>/dev/null || true
  fi
fi

# ── 6. migrate ───────────────────────────────────────────────────────────────────────────────

step "Database migrations"

# `migrate -- --check` is assert-only: exit 0 = schema current, non-zero = behind. Asking first
# means a release with no schema change never stops the app, and a release WITH one stops it before
# touching the schema — docs/DEPLOYMENT.md: "Never migrate under a live, armed process."
MIGRATION_PENDING=0
if (( DRY_RUN )); then
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

step "Validate the effective backend configuration"

# A .env is a REQUEST for a configuration; the value in force can differ (unset → default,
# out-of-range → clamped, unparseable → default). This prints what will ACTUALLY run, with
# provenance, and refuses a config that would not boot (the CLI exits 2 for that).
if (( DRY_RUN )); then
  printf '%s      would run:%s node dist/box/effectiveConfig.js\n' "$C_DIM" "$C_RESET"
else
  # `-r dotenv/config` is how index.ts gets its environment; effectiveConfig.js has no dotenv import
  # of its own, so the same loader is applied here rather than re-implementing .env resolution.
  ( cd "$GAR_B_DIR" && node -r dotenv/config dist/box/effectiveConfig.js ) \
    || die "effective configuration is invalid — the backend would not boot"

  # Report the safety-relevant state WITHOUT changing it. This script never arms anything.
  effective_json="$(mktemp)"
  ( cd "$GAR_B_DIR" && node -r dotenv/config dist/box/effectiveConfig.js --json ) > "$effective_json"
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

step "Start / reload ${PM2_APP}"

if (( DRY_RUN )); then
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
run pm2 save --force

# ── 9. health ────────────────────────────────────────────────────────────────────────────────

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

check_url() {
  local url="$1" want="$2" desc="$3" code
  if (( DRY_RUN )); then printf '%s      would check:%s %s\n' "$C_DIM" "$C_RESET" "$url"; return 0; fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || echo 000)"
  if [[ "$code" == "$want" ]]; then
    ok "${code}  ${url}  (${desc})"
  else
    die "${url} returned ${code}, expected ${want} (${desc})"
  fi
}

check_url "${PUBLIC_BASE}/"           200 "public site"
check_url "${PUBLIC_BASE}/box"        200 "SPA route — nginx try_files must fall back to index.html"
if ! (( DRY_RUN )); then
  health="$(curl -fsS --max-time 15 "${PUBLIC_BASE}/api/health" 2>/dev/null)" \
    || die "${PUBLIC_BASE}/api/health did not return 200 — nginx is not reaching the backend"
  [[ "$(printf '%s' "$health" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).ready' 2>/dev/null)" == "true" ]] \
    || die "${PUBLIC_BASE}/api/health reports not-ready: ${health}"
  ok "200  ${PUBLIC_BASE}/api/health  (${health})"

  # The UI is only usable if it was built against the contract this backend serves. Compare the
  # digest the running backend reports with what the frontend pinned.
  served="$(curl -fsS --max-time 15 "${PUBLIC_BASE}/api/box/status" 2>/dev/null \
    | node -pe 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).contract?.schemas_sha256??""}catch{""}' 2>/dev/null || true)"
  if [[ -n "$served" && -n "${frontend_pin:-}" && "$served" != "$frontend_pin" ]]; then
    die "the RUNNING backend serves contract ${served:0:12}… but the frontend pinned ${frontend_pin:0:12}…"
  fi
fi

# ── done ─────────────────────────────────────────────────────────────────────────────────────

trap - EXIT
printf '\n%s%sRELEASE COMPLETE%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
if ! (( DRY_RUN )); then
  printf '  GAR_B      %s\n' "$(git -C "$GAR_B_DIR" rev-parse --short HEAD)"
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
