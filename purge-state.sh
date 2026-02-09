#!/usr/bin/env bash
set -euo pipefail

# purge-state.sh
#
# PURPOSE
#   Purge local state for OpenClaw + Clawboard while keeping:
#     - identity (you + me)
#     - operating rules (SOUL/AGENTS/TOOLS/USER/etc.)
#     - credentials / access keys you provided
#     - installed skills + skill rules
#     - settings/config
#
#   Purges:
#     - sessions/conversations (OpenClaw workspaces)
#     - memory databases (OpenClaw sqlite)
#     - cron/time-based executions
#     - logs/subagent state
#     - clawboard queue sqlite
#     - clawboard DB/vector/index state (docker volumes + ./data)
#
# SAFETY MODEL
#   - Default is DRY RUN (touches nothing)
#   - --apply still does NOT run unless you also:
#       a) pass --force, OR
#       b) type YES (caps) when prompted
#   - --hard-delete is dangerous and has the same safeguards.
#   - Restore/merge requires explicit caps confirmation: HARD or MERGE.
#
# USAGE
#   ./purge-state.sh
#   ./purge-state.sh --apply                # will prompt; type YES
#   ./purge-state.sh --apply --force        # no prompt
#   ./purge-state.sh --apply --hard-delete  # will prompt; type YES
#   ./purge-state.sh --apply --no-manage-gateway  # skip gateway stop/start + doctor
#
#   # restore from an archive directory created by this script
#   ./purge-state.sh --restore /path/to/_purge-archive/20260208-194837 --mode MERGE
#   ./purge-state.sh --restore /path/to/_purge-archive/20260208-194837 --mode HARD
#
# NOTES
#   - Dry run prints every action plus where it would archive to.
#   - Archive mode moves files into: <this-repo>/_purge-archive/<timestamp>/
#   - Clawboard API health check can be overridden with: CLAWBOARD_HEALTH_URL=http://localhost:8010/api/health
#

APPLY=0
FORCE=0
HARD_DELETE=0
MANAGE_GATEWAY=1  # stop/start OpenClaw gateway around purge/restore (use --no-manage-gateway to disable)

RESTORE_DIR=""
RESTORE_MODE=""  # HARD|MERGE

# Robust arg parsing (script can be run from any directory)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --force) FORCE=1; shift ;;
    --hard-delete) HARD_DELETE=1; shift ;;
    --manage-gateway) MANAGE_GATEWAY=1; shift ;;
    --no-manage-gateway) MANAGE_GATEWAY=0; shift ;;
    --restore)
      RESTORE_DIR="${2:-}";
      shift 2
      ;;
    --mode)
      RESTORE_MODE="${2:-}";
      shift 2
      ;;
    -h|--help)
      sed -n '1,240p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

say() { printf "%s\n" "$*"; }

run() {
  if [[ "$APPLY" == "1" ]]; then
    eval "$@"
  else
    say "DRY_RUN: $*"
  fi
}

need_cmd() {
  local c="$1"
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "Missing required command: $c" >&2
    return 1
  fi
}

read_env_value() {
  # Minimal .env reader (no eval). Matches deploy.sh behavior closely enough.
  local file_path="$1"
  local key="$2"
  local line
  [[ -f "$file_path" ]] || return 1
  line="$(awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "=" {
      print substr($0, index($0, "=") + 1)
    }
  ' "$file_path" | tail -n1)"
  line="${line//$'\r'/}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  [[ -n "$line" ]] || return 1
  printf "%s" "$line"
}

is_web_hot_reload_enabled() {
  local v=""
  v="$(read_env_value "$CLAWBOARD_ENV_FILE" "CLAWBOARD_WEB_HOT_RELOAD" 2>/dev/null || true)"
  case "$v" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

have_clawboard_compose() {
  # Consider compose "present" if a compose file exists in the repo root.
  # (Covers docker-compose.yml and docker-compose.yaml.)
  compgen -G "$CLAWBOARD_DIR/docker-compose.y*ml" >/dev/null 2>&1
}

clawboard_down() {
  if ! command -v docker >/dev/null 2>&1; then
    say "SKIP: docker not installed; cannot manage Clawboard containers"
    return 0
  fi
  if ! have_clawboard_compose; then
    say "SKIP: no docker compose file found in $CLAWBOARD_DIR"
    return 0
  fi

  # Best-effort; don't abort purge if docker is in a weird state.
  # Important: run with --profile dev first so web-dev is torn down too (deploy.sh does this).
  run "cd \"$CLAWBOARD_DIR\" && docker compose --profile dev stop >/dev/null 2>&1 || true"
  run "cd \"$CLAWBOARD_DIR\" && docker compose stop >/dev/null 2>&1 || true"
  run "cd \"$CLAWBOARD_DIR\" && docker compose --profile dev down -v --remove-orphans >/dev/null 2>&1 || true"
  run "cd \"$CLAWBOARD_DIR\" && docker compose down -v --remove-orphans || true"
}

clawboard_up() {
  if ! command -v docker >/dev/null 2>&1; then
    say "SKIP: docker not installed; cannot manage Clawboard containers"
    return 0
  fi
  if ! have_clawboard_compose; then
    say "SKIP: no docker compose file found in $CLAWBOARD_DIR"
    return 0
  fi

  if is_web_hot_reload_enabled; then
    # Avoid port conflicts: web and web-dev both bind host 3010.
    run "cd \"$CLAWBOARD_DIR\" && docker compose stop web >/dev/null 2>&1 || true"
    run "cd \"$CLAWBOARD_DIR\" && docker compose rm -f web >/dev/null 2>&1 || true"
    run "cd \"$CLAWBOARD_DIR\" && docker compose --profile dev up -d api classifier qdrant web-dev"
  else
    run "cd \"$CLAWBOARD_DIR\" && docker compose stop web-dev >/dev/null 2>&1 || true"
    run "cd \"$CLAWBOARD_DIR\" && docker compose rm -f web-dev >/dev/null 2>&1 || true"
    run "cd \"$CLAWBOARD_DIR\" && docker compose up -d"
  fi

  # Compose can report "Created" before containers are fully running/healthy.
  # Wait for the API to come up so downstream steps (OpenClaw logger, classifier) don't spam errors.
  if [[ "$APPLY" == "1" ]]; then
    if command -v curl >/dev/null 2>&1; then
      local url="${CLAWBOARD_HEALTH_URL:-http://localhost:8010/api/health}"
      local deadline=$(( $(date +%s) + 90 ))
      while true; do
        if curl -fsS -m 2 "$url" >/dev/null 2>&1; then
          break
        fi
        if [[ "$(date +%s)" -ge "$deadline" ]]; then
          say "WARN: Clawboard API not healthy yet ($url). Continuing."
          break
        fi
        sleep 1
      done
    else
      say "WARN: curl not found; cannot wait for Clawboard API health."
    fi
  fi
}

confirm_yes() {
  local prompt="$1"
  if [[ "$FORCE" == "1" ]]; then
    return 0
  fi
  read -r -p "$prompt Type YES to proceed: " ans
  if [[ "$ans" != "YES" ]]; then
    echo "Aborted (did not type YES)." >&2
    exit 2
  fi
}

confirm_caps() {
  local expected="$1"   # e.g. HARD or MERGE
  local prompt="$2"
  if [[ "$FORCE" == "1" ]]; then
    # still require explicit mode keyword; force only skips prompts
    return 0
  fi
  read -r -p "$prompt Type $expected to proceed: " ans
  if [[ "$ans" != "$expected" ]]; then
    echo "Aborted (did not type $expected)." >&2
    exit 2
  fi
}

GATEWAY_TRAP_ACTIVE=0

gateway_recover() {
  # Best-effort recovery if a purge/restore fails after the gateway was stopped.
  local exit_code=$?

  if [[ "$GATEWAY_TRAP_ACTIVE" != "1" ]]; then
    return 0
  fi

  GATEWAY_TRAP_ACTIVE=0
  trap - EXIT

  if [[ "$APPLY" != "1" || "$MANAGE_GATEWAY" != "1" ]]; then
    return 0
  fi

  set +e
  echo ""
  echo "== Gateway recovery (best effort) =="
  echo "Attempting: openclaw gateway install"
  openclaw gateway install >/dev/null 2>&1 || openclaw gateway install || true
  echo "Attempting: openclaw gateway start"
  openclaw gateway start >/dev/null 2>&1 || openclaw gateway start || true
  echo "Attempting: openclaw doctor --fix"
  openclaw doctor --fix || true

  # Preserve the original failure code.
  exit "$exit_code"
}

gateway_begin() {
  if [[ "$MANAGE_GATEWAY" != "1" ]]; then
    return 0
  fi

  if [[ "$APPLY" == "1" ]]; then
    GATEWAY_TRAP_ACTIVE=1
    trap gateway_recover EXIT
  fi

  run "openclaw gateway stop || true"
}

gateway_end() {
  if [[ "$MANAGE_GATEWAY" != "1" ]]; then
    return 0
  fi

  # Keep the EXIT trap active through 'gateway start' so we recover if it fails.
  run "openclaw gateway install || true"
  run "openclaw gateway start"

  # After the gateway is up, disable recovery so doctor failures don't trigger a restart loop.
  if [[ "$APPLY" == "1" ]]; then
    GATEWAY_TRAP_ACTIVE=0
    trap - EXIT
  fi

  run "openclaw doctor --fix"
  # Doctor can (re)install or update the service; ensure it's started at the end.
  run "openclaw gateway start || true"
}

archive_or_delete() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    say "SKIP (missing): $path"
    return 0
  fi

  if [[ "$HARD_DELETE" == "1" ]]; then
    run "rm -rf \"$path\""
  else
    run "mkdir -p \"$ARCHIVE_DIR\""
    run "mv \"$path\" \"$ARCHIVE_DIR/\""
  fi
}

archive_or_delete_into() {
  local path="$1"
  local dest_dir="$2"
  if [[ ! -e "$path" ]]; then
    say "SKIP (missing): $path"
    return 0
  fi

  if [[ "$HARD_DELETE" == "1" ]]; then
    run "rm -rf \"$path\""
  else
    run "mkdir -p \"$dest_dir\""
    run "mv \"$path\" \"$dest_dir/\""
  fi
}

restore_dir_contents() {
  # Restore a directory from archive.
  # HARD: overwrite dst (remove dst first) then mv src -> dst
  # MERGE: ensure dst exists, then mv any missing children from src into dst
  local src="$1"
  local dst="$2"

  if [[ ! -e "$src" ]]; then
    say "SKIP (missing in archive): $src"
    return 0
  fi

  if [[ "$RESTORE_MODE" == "HARD" ]]; then
    run "rm -rf \"$dst\""
    run "mkdir -p \"$(dirname "$dst")\""
    run "mv \"$src\" \"$dst\""
    return 0
  fi

  # MERGE
  if [[ -d "$src" ]]; then
    run "mkdir -p \"$dst\""
    # Move individual children so an existing (possibly empty) dst dir doesn't block restore.
    (
      shopt -s nullglob dotglob
      for child in "$src"/*; do
        base="$(basename "$child")"
        if [[ -e "$dst/$base" ]]; then
          say "SKIP (exists, merge mode): $dst/$base"
          continue
        fi
        run "mv \"$child\" \"$dst/\""
      done
    )
    # Best-effort cleanup if we drained the src dir.
    run "rmdir \"$src\" 2>/dev/null || true"
  else
    # If src isn't a directory, fall back to file semantics.
    if [[ -e "$dst" ]]; then
      say "SKIP (exists, merge mode): $dst"
      return 0
    fi
    run "mkdir -p \"$(dirname "$dst")\""
    run "mv \"$src\" \"$dst\""
  fi
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +"%Y%m%d-%H%M%S")"
ARCHIVE_ROOT="$script_dir/_purge-archive"
ARCHIVE_DIR="$ARCHIVE_ROOT/$TS"

# Auto-sense paths (override via env vars if needed)
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
CLAWD_REPO="${CLAWD_REPO:-$HOME/clawd}"
CLAWBOARD_DIR="$script_dir"  # this repo
CLAWBOARD_ENV_FILE="${CLAWBOARD_ENV_FILE:-$CLAWBOARD_DIR/.env}"

print_plan() {
  say "== Purge/Restore tool =="
  say "Location: $script_dir"
  say "Mode: $( [[ $APPLY == 1 ]] && echo APPLY || echo DRY_RUN )"
  say "Gateway management: $( [[ $MANAGE_GATEWAY == 1 ]] && echo ENABLED || echo DISABLED )"
  if [[ "$HARD_DELETE" == "1" ]]; then
    say "Delete behavior: HARD_DELETE (rm -rf)"
  else
    say "Delete behavior: ARCHIVE (move to: $ARCHIVE_DIR)"
  fi
  if have_clawboard_compose; then
    local mode="prod (web)"
    if is_web_hot_reload_enabled; then
      mode="dev (web-dev)"
    fi
    say "Clawboard compose: $mode (env: $CLAWBOARD_ENV_FILE)"
  fi
  say ""

  say "== Explicit KEEP list (never touched by this script) =="
  say "OpenClaw settings/identity/credentials/skills:"
  say "  - $OPENCLAW_DIR/openclaw.json*"
  say "  - $OPENCLAW_DIR/credentials/"
  say "  - $OPENCLAW_DIR/identity/"
  say "  - $OPENCLAW_DIR/skills/"
  say "  - $OPENCLAW_DIR/agents/ (except agents/*/sessions; those are purged)"
  say "  - $OPENCLAW_DIR/devices/"
  say "  - $OPENCLAW_DIR/extensions/"
  say ""
  say "Clawboard config/source (this repo):"
  say "  - $CLAWBOARD_DIR/.env*"
  say "  - $CLAWBOARD_DIR/docker-compose.y*ml"
  say "  - $CLAWBOARD_DIR/Dockerfile*"
  say "  - $CLAWBOARD_DIR/src/ backend/ classifier/ scripts/ tests/ (all code)"
  say ""
  say "Clawd repo identity/rules (kept):"
  say "  - $CLAWD_REPO/IDENTITY.md"
  say "  - $CLAWD_REPO/USER.md"
  say "  - $CLAWD_REPO/SOUL.md"
  say "  - $CLAWD_REPO/AGENTS.md"
  say "  - $CLAWD_REPO/TOOLS.md"
  say ""
}

validate_environment() {
  # In dry-run we still validate commands/paths to catch errors early.
  need_cmd date
  need_cmd mv
  need_cmd rm
  need_cmd mkdir
  if [[ "$MANAGE_GATEWAY" == "1" ]]; then
    need_cmd openclaw
  fi

  # docker is optional unless we are applying purge of clawboard docker state.
  if [[ -d "$CLAWBOARD_DIR" ]]; then
    if command -v docker >/dev/null 2>&1; then
      :
    else
      say "WARN: docker not found; Clawboard docker purge steps would fail on apply."
    fi
  fi

  if [[ ! -d "$OPENCLAW_DIR" ]]; then
    say "WARN: $OPENCLAW_DIR not found; OpenClaw purge steps will be skipped."
  fi
}

purge() {
  say "== What would change =="
  say "OpenClaw (sessions/conversations):"
  say "  - $OPENCLAW_DIR/workspace-* (workspace-main/coding/web/social)"
  say "  - $OPENCLAW_DIR/agents/*/sessions (per-agent session stores + jsonl)"
  say "OpenClaw (memories):"
  say "  - $OPENCLAW_DIR/memory/*.sqlite*"
  say "OpenClaw (cron/time-based):"
  say "  - $OPENCLAW_DIR/cron"
  say "OpenClaw (logs/subagents):"
  say "  - $OPENCLAW_DIR/logs, $OPENCLAW_DIR/subagents"
  say "OpenClaw (queues):"
  say "  - $OPENCLAW_DIR/clawboard-queue.sqlite*"
  say "Clawboard (DB/vectors/indexes):"
  say "  - docker volumes (docker compose down -v)"
  say "  - $CLAWBOARD_DIR/data (qdrant storage, embeddings db, sqlite, etc.)"
  say "Clawd repo (local archives from prior manual purges):"
  say "  - $CLAWD_REPO/_purged and $CLAWD_REPO/_purged-db"
  say ""

  if [[ "$APPLY" == "1" ]]; then
    confirm_yes "About to run purge. "
  fi

  # Bring down Clawboard before touching OpenClaw state so we stop ingestion and release any locks.
  # (Also reduces chance of network/volume removal issues later.)
  clawboard_down

  gateway_begin

  # OpenClaw workspaces (session/conversation state)
  archive_or_delete "$OPENCLAW_DIR/workspace-main"
  archive_or_delete "$OPENCLAW_DIR/workspace-coding"
  archive_or_delete "$OPENCLAW_DIR/workspace-web"
  archive_or_delete "$OPENCLAW_DIR/workspace-social"

  # OpenClaw per-agent sessions (these are the real session stores in newer installs)
  if [[ -d "$OPENCLAW_DIR/agents" ]]; then
    for agent_dir in "$OPENCLAW_DIR/agents"/*; do
      [[ -d "$agent_dir" ]] || continue
      if [[ -d "$agent_dir/sessions" ]]; then
        agent_name="$(basename "$agent_dir")"
        say "Purging agent sessions: $agent_name"
        archive_or_delete_into "$agent_dir/sessions" "$ARCHIVE_DIR/openclaw-agent-sessions/$agent_name"
      else
        say "SKIP (missing): $agent_dir/sessions"
      fi
    done
  fi

  # OpenClaw local memory DBs (sqlite)
  if [[ -d "$OPENCLAW_DIR/memory" ]]; then
    if [[ "$HARD_DELETE" == "1" ]]; then
      run "rm -f \"$OPENCLAW_DIR/memory\"/*.sqlite \"$OPENCLAW_DIR/memory\"/*.sqlite-* 2>/dev/null || true"
    else
      run "mkdir -p \"$ARCHIVE_DIR/openclaw-memory\""
      run "mv \"$OPENCLAW_DIR/memory\"/*.sqlite \"$ARCHIVE_DIR/openclaw-memory/\" 2>/dev/null || true"
      run "mv \"$OPENCLAW_DIR/memory\"/*.sqlite-* \"$ARCHIVE_DIR/openclaw-memory/\" 2>/dev/null || true"
    fi
  fi

  # Cron
  archive_or_delete "$OPENCLAW_DIR/cron"

  # Logs / subagent state
  archive_or_delete "$OPENCLAW_DIR/logs"
  archive_or_delete "$OPENCLAW_DIR/subagents"

  # Queue DBs
  archive_or_delete "$OPENCLAW_DIR/clawboard-queue.sqlite"
  archive_or_delete "$OPENCLAW_DIR/clawboard-queue.sqlite-wal"
  archive_or_delete "$OPENCLAW_DIR/clawboard-queue.sqlite-shm"

  # Clawboard data (host-mounted state)
  archive_or_delete "$CLAWBOARD_DIR/data"

  # Clawd repo archives from earlier manual purges
  archive_or_delete "$CLAWD_REPO/_purged"
  archive_or_delete "$CLAWD_REPO/_purged-db"

  say ""
  if [[ "$HARD_DELETE" == "1" ]]; then
    say "Purge completed with HARD_DELETE. (No archive created by design.)"
  else
    say "Purge completed in ARCHIVE mode. Archive location: $ARCHIVE_DIR"
    say "Restore options:"
    say "  - Merge restore: $0 --restore $ARCHIVE_DIR --mode MERGE --apply"
    say "  - Hard restore (overwrite targets): $0 --restore $ARCHIVE_DIR --mode HARD --apply"
  fi

  gateway_end

  # Bring Clawboard back up last (after doctor may update gateway/service config).
  clawboard_up
}

restore_from_archive() {
  if [[ -z "$RESTORE_DIR" ]]; then
    echo "--restore requires a directory" >&2
    exit 1
  fi
  if [[ -z "$RESTORE_MODE" ]]; then
    echo "--mode MERGE|HARD required for restore" >&2
    exit 1
  fi
  if [[ "$RESTORE_MODE" != "HARD" && "$RESTORE_MODE" != "MERGE" ]]; then
    echo "Invalid --mode: $RESTORE_MODE (must be HARD or MERGE)" >&2
    exit 1
  fi
  if [[ ! -d "$RESTORE_DIR" ]]; then
    echo "Restore dir not found: $RESTORE_DIR" >&2
    exit 1
  fi

  say "== Restore plan =="
  say "From: $RESTORE_DIR"
  say "Mode: $RESTORE_MODE"
  say ""
  say "HARD: overwrite destinations (removes existing targets first)."
  say "MERGE: move back only items that do not already exist."
  say ""

  if [[ "$APPLY" == "1" ]]; then
    confirm_caps "$RESTORE_MODE" "About to restore ($RESTORE_MODE). "
  else
    say "DRY_RUN: restore will not execute without --apply"
  fi

  # Bring down Clawboard first to avoid restoring into a live app and to release file/volume locks.
  clawboard_down

  gateway_begin

  restore_item() {
    local src="$1"
    local dst="$2"
    if [[ ! -e "$src" ]]; then
      say "SKIP (missing in archive): $src"
      return 0
    fi

    if [[ "$RESTORE_MODE" == "HARD" ]]; then
      # remove dst then move src back
      run "rm -rf \"$dst\""
      run "mkdir -p \"$(dirname "$dst")\""
      run "mv \"$src\" \"$dst\""
    else
      # MERGE: only restore if dst does not exist
      if [[ -e "$dst" ]]; then
        say "SKIP (exists, merge mode): $dst"
        return 0
      fi
      run "mkdir -p \"$(dirname "$dst")\""
      run "mv \"$src\" \"$dst\""
    fi
  }

  # Restore OpenClaw workspaces
  restore_item "$RESTORE_DIR/workspace-main" "$OPENCLAW_DIR/workspace-main"
  restore_item "$RESTORE_DIR/workspace-coding" "$OPENCLAW_DIR/workspace-coding"
  restore_item "$RESTORE_DIR/workspace-web" "$OPENCLAW_DIR/workspace-web"
  restore_item "$RESTORE_DIR/workspace-social" "$OPENCLAW_DIR/workspace-social"

  # Restore per-agent session stores
  if [[ -d "$RESTORE_DIR/openclaw-agent-sessions" ]]; then
    for agent_dir in "$RESTORE_DIR/openclaw-agent-sessions"/*; do
      [[ -d "$agent_dir" ]] || continue
      agent_name="$(basename "$agent_dir")"
      restore_dir_contents "$agent_dir/sessions" "$OPENCLAW_DIR/agents/$agent_name/sessions"
    done
  fi

  # Restore OpenClaw cron/logs/subagents
  restore_item "$RESTORE_DIR/cron" "$OPENCLAW_DIR/cron"
  restore_item "$RESTORE_DIR/logs" "$OPENCLAW_DIR/logs"
  restore_item "$RESTORE_DIR/subagents" "$OPENCLAW_DIR/subagents"

  # Restore queue DBs
  restore_item "$RESTORE_DIR/clawboard-queue.sqlite" "$OPENCLAW_DIR/clawboard-queue.sqlite"
  restore_item "$RESTORE_DIR/clawboard-queue.sqlite-wal" "$OPENCLAW_DIR/clawboard-queue.sqlite-wal"
  restore_item "$RESTORE_DIR/clawboard-queue.sqlite-shm" "$OPENCLAW_DIR/clawboard-queue.sqlite-shm"

  # Restore memory DBs
  if [[ -d "$RESTORE_DIR/openclaw-memory" ]]; then
    # move back all sqlite files
    run "mkdir -p \"$OPENCLAW_DIR/memory\""
    if [[ "$RESTORE_MODE" == "HARD" ]]; then
      run "rm -f \"$OPENCLAW_DIR/memory\"/*.sqlite \"$OPENCLAW_DIR/memory\"/*.sqlite-* 2>/dev/null || true"
    fi
    run "mv \"$RESTORE_DIR/openclaw-memory\"/* \"$OPENCLAW_DIR/memory/\" 2>/dev/null || true"
  fi

  # Restore Clawboard data dir
  restore_item "$RESTORE_DIR/data" "$CLAWBOARD_DIR/data"

  # Restore Clawd repo archives (optional)
  restore_item "$RESTORE_DIR/_purged" "$CLAWD_REPO/_purged"
  restore_item "$RESTORE_DIR/_purged-db" "$CLAWD_REPO/_purged-db"

  say ""
  say "Restore complete."

  gateway_end

  # Bring Clawboard back up last (after doctor may update gateway/service config).
  clawboard_up
}

print_plan
validate_environment

if [[ -n "$RESTORE_DIR" || -n "$RESTORE_MODE" ]]; then
  restore_from_archive
else
  purge
fi
