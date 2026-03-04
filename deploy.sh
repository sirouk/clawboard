#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CLAWBOARD_ENV_FILE:-$ROOT_DIR/.env}"
DATA_DIR="$ROOT_DIR/data"

COMPOSE_CMD=()
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
fi

compose() {
  if [ "${#COMPOSE_CMD[@]}" -eq 0 ]; then
    echo "error: Docker Compose not found. Install docker compose v2 or docker-compose." >&2
    exit 1
  fi
  "${COMPOSE_CMD[@]}" "$@"
}

ensure_env_file() {
  if [ -f "$ENV_FILE" ]; then
    return
  fi
  if [ -f "$ROOT_DIR/.env.example" ]; then
    cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  else
    touch "$ENV_FILE"
  fi
}

generate_token() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
    return
  fi
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]'
    return
  fi
  echo "clawboard-token-$(date +%s)"
}

upsert_env_value() {
  local file_path="$1"
  local key="$2"
  local value="$3"
  local temp_file
  mkdir -p "$(dirname "$file_path")"
  touch "$file_path"
  temp_file="$(mktemp "${file_path}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { updated=0 }
    $0 ~ "^[[:space:]]*" key "=" {
      if (!updated) {
        print key "=" value
        updated=1
      }
      next
    }
    { print }
    END {
      if (!updated) print key "=" value
    }
  ' "$file_path" > "$temp_file"
  mv "$temp_file" "$file_path"
}

read_env_value() {
  local key="$1"
  local line
  [ -f "$ENV_FILE" ] || return 1
  line="$(awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "=" {
      print substr($0, index($0, "=") + 1)
    }
  ' "$ENV_FILE" | tail -n1)"
  line="${line//$'\r'/}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  [ -n "$line" ] || return 1
  printf "%s" "$line"
}

is_web_hot_reload_enabled() {
  local v=""
  v="$(read_env_value "CLAWBOARD_WEB_HOT_RELOAD" || true)"
  case "$v" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

mask_token() {
  local token="$1"
  local len="${#token}"
  if [ "$len" -le 8 ]; then
    printf "%s" "$token"
    return
  fi
  printf "%s...%s" "${token:0:4}" "${token:len-4:4}"
}

confirm_or_abort() {
  local prompt="$1"
  local force="${2:-false}"
  local answer=""
  if [ "$force" = "true" ]; then
    return
  fi
  if [ ! -t 0 ]; then
    echo "error: confirmation required. Re-run with --yes." >&2
    exit 1
  fi
  read -r -p "$prompt [y/N]: " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Cancelled."; exit 1 ;;
  esac
}

usage() {
  cat <<'USAGE'
Usage: bash deploy.sh [command]

Commands:
  up [services...]                     Start services without rebuilding
  rebuild [services...]                Rebuild and force-recreate services
  fresh                                Tear down + rebuild everything anew
  restart [services...]                Restart running services
  down                                 Stop services (keep data)
  nuke [--yes]                         Stop services + remove volumes
  reset-data [--yes]                   Stop services and wipe local Clawboard data/* (OpenClaw untouched)
  reset-openclaw-sessions [--yes]      Wipe OpenClaw agent session history; keeps memories + credentials
  reset-all-fresh [--yes]              Wipe OpenClaw memories/sessions + Clawboard data; remove Clawboard OpenClaw cron jobs (preserves qmd indexes + workspace templates/rules)
  start-fresh-replay [--yes]           One-time: clear topics/tasks, reset classifier, wipe vectors, restart
  status                               Show container status
  logs [service]                       Tail logs
  pull [service]                       Pull images (if using registry images)
  test                                 Run full test suite (npm run test:all)
  demo-load                            Load demo data into the API database
  demo-clear                           Clear API data via seed helper
  cleanup-orphan-tools [--dry-run] [--yes]
                                       Remove unscoped OpenClaw control-plane tool traces from Logs
  reconcile-allocation-guardrails [--dry-run] [--yes]
                                       Reconcile control-plane/tool log allocation to match routing guardrails
  verify-production-ready [--skip-tests] [--live-smoke] [--strict]
                                       Run deployability audit with hard pass/fail summary

  token-show                           Show masked backend/frontend token values
  token-be [value|--generate]          Set CLAWBOARD_TOKEN in .env
  token-fe [value|--copy-be|--generate]
                                       Set NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN in .env
  token-both [backend] [frontend]      Set both tokens (frontend defaults to backend)
  token-sync-fe                        Copy backend token to frontend token

  ensure-skill                         Install/update skill at ~/.openclaw/skills/clawboard
  ensure-plugin                        Install/enable clawboard-logger plugin in OpenClaw
  bootstrap [args...]                  Run scripts/bootstrap_openclaw.sh with passthrough args


If no command is provided, an interactive menu is shown.
USAGE
}

up() {
  local args=("$@")
  local services=()

  if is_web_hot_reload_enabled; then
    # Default services when none specified: swap prod web -> dev web.
    if [ "${#args[@]}" -eq 0 ]; then
      services=(api classifier qdrant web-dev)
    else
      for s in "${args[@]}"; do
        if [ "$s" = "web" ]; then
          services+=("web-dev")
        else
          services+=("$s")
        fi
      done
    fi

    # Avoid port conflicts when switching modes.
    for s in "${services[@]}"; do
      if [ "$s" = "web-dev" ]; then
        compose stop web >/dev/null 2>&1 || true
        compose rm -f web >/dev/null 2>&1 || true
        break
      fi
    done

    compose --profile dev up -d "${services[@]}"
    return
  fi

  # Production-style web: map accidental web-dev arg back to web.
  if [ "${#args[@]}" -gt 0 ]; then
    for s in "${args[@]}"; do
      if [ "$s" = "web-dev" ]; then
        services+=("web")
      else
        services+=("$s")
      fi
    done
    for s in "${services[@]}"; do
      if [ "$s" = "web" ]; then
        compose stop web-dev >/dev/null 2>&1 || true
        compose rm -f web-dev >/dev/null 2>&1 || true
        break
      fi
    done
    compose up -d "${services[@]}"
    return
  fi

  compose up -d
}

rebuild() {
  local args=("$@")
  local services=()

  if is_web_hot_reload_enabled; then
    if [ "${#args[@]}" -eq 0 ]; then
      services=(api classifier qdrant web-dev)
    else
      for s in "${args[@]}"; do
        if [ "$s" = "web" ]; then
          services+=("web-dev")
        else
          services+=("$s")
        fi
      done
    fi

    for s in "${services[@]}"; do
      if [ "$s" = "web-dev" ]; then
        compose stop web >/dev/null 2>&1 || true
        compose rm -f web >/dev/null 2>&1 || true
        break
      fi
    done

    # No build needed for web-dev (runs from node base image + bind mount), but --build
    # is harmless and keeps api/classifier up to date when requested.
    compose --profile dev up -d --build --force-recreate "${services[@]}"
    return
  fi

  if [ "${#args[@]}" -gt 0 ]; then
    for s in "${args[@]}"; do
      if [ "$s" = "web-dev" ]; then
        services+=("web")
      else
        services+=("$s")
      fi
    done
    for s in "${services[@]}"; do
      if [ "$s" = "web" ]; then
        compose stop web-dev >/dev/null 2>&1 || true
        compose rm -f web-dev >/dev/null 2>&1 || true
        break
      fi
    done
    compose up -d --build --force-recreate "${services[@]}"
    return
  fi

  compose up -d --build --force-recreate
}

fresh() {
  down
  if is_web_hot_reload_enabled; then
    compose --profile dev up -d --build --force-recreate api classifier qdrant web-dev
    return
  fi
  compose up -d --build --force-recreate
}

down() {
  # Ensure dev-profile services (web-dev) are torn down too.
  compose --profile dev down --remove-orphans >/dev/null 2>&1 || true
  compose down --remove-orphans
}

nuke() {
  local force=false
  if [ "${1:-}" = "--yes" ]; then
    force=true
  fi
  confirm_or_abort "This will remove containers and volumes. Continue?" "$force"
  compose --profile dev down -v --remove-orphans >/dev/null 2>&1 || true
  compose down -v --remove-orphans
}

restart() {
  if [ "$#" -gt 0 ]; then
    if is_web_hot_reload_enabled; then
      local args=("$@")
      local services=()
      for s in "${args[@]}"; do
        if [ "$s" = "web" ]; then
          services+=("web-dev")
        else
          services+=("$s")
        fi
      done
      compose --profile dev restart "${services[@]}"
      return
    fi
    compose restart "$@"
    return
  fi
  compose restart
}

# ===========================================================================
# OpenClaw config helpers — resolve paths dynamically from openclaw.json so
# these functions work correctly even if the install is non-default.
# ===========================================================================

# Resolve the OpenClaw home directory.  Respects OPENCLAW_HOME and the legacy
# OPENCLAW_STATE_DIR override used by --profile / --dev flags.
_oc_home() {
  printf "%s" "${OPENCLAW_HOME:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}}"
}

# Locate openclaw.json: explicit env var > <oc-home>/openclaw.json.
# Prints the path (empty string if not found).
_oc_config_path() {
  if [ -n "${OPENCLAW_CONFIG_PATH:-}" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
    printf "%s" "$OPENCLAW_CONFIG_PATH"
    return
  fi
  local cfg
  cfg="$(_oc_home)/openclaw.json"
  [ -f "$cfg" ] && printf "%s" "$cfg"
}

# Emit tab-separated lines: "<agent-id>\t<sessions-dir>"
# Source: agents.list[] in openclaw.json.  Falls back to filesystem walk.
_oc_agent_sessions() {
  local oc_home cfg_path
  oc_home="$(_oc_home)"
  cfg_path="$(_oc_config_path)"

  if [ -n "$cfg_path" ] && command -v python3 >/dev/null 2>&1; then
    python3 - "$cfg_path" "$oc_home" <<'PY'
import sys, json, os
cfg_path, oc_home = sys.argv[1], sys.argv[2]
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(1)
agents = cfg.get("agents", {}).get("list", [])
if not isinstance(agents, list):
    sys.exit(1)
for a in agents:
    if not isinstance(a, dict):
        continue
    aid = str(a.get("id", "")).strip()
    if not aid:
        continue
    sessions_dir = os.path.join(oc_home, "agents", aid, "sessions")
    print(f"{aid}\t{sessions_dir}")
PY
    return $?
  fi

  # Fallback: walk the filesystem
  local agents_dir="$oc_home/agents"
  [ -d "$agents_dir" ] || return 0
  for agent_dir in "$agents_dir"/*/; do
    [ -d "$agent_dir" ] || continue
    local aid
    aid="$(basename "$agent_dir")"
    printf "%s\t%s\n" "$aid" "$agent_dir/sessions"
  done
}

# Print a human-readable summary of paths that will NOT be touched.
# Reads workspace/memory dirs and QMD vault paths from openclaw.json.
_oc_preserved_paths_summary() {
  local cfg_path
  local oc_home
  cfg_path="$(_oc_config_path)"
  oc_home="$(_oc_home)"
  [ -n "$cfg_path" ] && command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$cfg_path" "$oc_home" <<'PY'
import sys, json, os
cfg_path, oc_home = sys.argv[1], os.path.abspath(os.path.expanduser(sys.argv[2]))
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(0)

printed = []
seen = set()
agents = cfg.get("agents", {}).get("list", [])
if not isinstance(agents, list):
    agents = []


def add(line):
    text = str(line or "").strip()
    if not text or text in seen:
        return
    seen.add(text)
    printed.append(text)


# Per-agent workspace/memory (daily long-term memories)
for a in agents:
    if not isinstance(a, dict):
        continue
    ws = os.path.abspath(os.path.expanduser(str(a.get("workspace", "") or "").strip()))
    aid = str(a.get("id", "") or "").strip()
    if ws:
        mem = os.path.join(ws, "memory")
        label = f"{aid} long-term memories" if aid else "long-term memories"
        add(f"  {mem}  [{label}]")

# QMD vault paths
for p in cfg.get("memory", {}).get("qmd", {}).get("paths", []):
    if isinstance(p, dict) and p.get("path"):
        label = str(p.get("name", "")).strip() or "qmd"
        add(f"  {p['path']}  [QMD vault: {label}]")

# agent/ credential dirs
for a in agents:
    if not isinstance(a, dict):
        continue
    aid = str(a.get("id", "") or "").strip()
    if aid:
        add(f"  {os.path.join(oc_home, 'agents', aid, 'agent')}  [credentials + model config]")
        add(f"  {os.path.join(oc_home, 'agents', aid, 'qmd')}    [QMD vector index]")

for line in printed:
    print(line)
PY
}

# Resolve configured OpenClaw workspaces from openclaw.json. Output:
#   WORKSPACE<TAB><abs-path>
# Falls back to common workspace directories when config parsing is unavailable.
_oc_agent_workspaces() {
  local cfg_path
  local oc_home
  cfg_path="$(_oc_config_path)"
  oc_home="$(_oc_home)"

  if [ -n "$cfg_path" ] && command -v python3 >/dev/null 2>&1; then
    python3 - "$cfg_path" "$oc_home" "${OPENCLAW_PROFILE:-}" <<'PY'
import json
import os
import re
import sys


cfg_path, openclaw_home, profile = sys.argv[1], os.path.abspath(os.path.expanduser(sys.argv[2])), (sys.argv[3] or "").strip()


def normalize_path(value):
    p = os.path.expanduser(str(value or "").strip())
    if not p:
        return ""
    return os.path.abspath(p)


def profile_workspace(base_dir, profile_name):
    raw = (profile_name or "").strip()
    if not raw or raw.lower() == "default":
        return os.path.join(base_dir, "workspace")
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", raw).strip("-")
    if not safe:
        return os.path.join(base_dir, "workspace")
    return os.path.join(base_dir, f"workspace-{safe}")


cfg = {}
try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        parsed = json.load(f)
        if isinstance(parsed, dict):
            cfg = parsed
except Exception:
    cfg = {}

agents = cfg.get("agents", {}).get("list")
if not isinstance(agents, list):
    agents = []

defaults_workspace = (
    (((cfg.get("agents") or {}).get("defaults") or {}).get("workspace"))
    or ((cfg.get("agents") or {}).get("workspace"))
    or ((cfg.get("agent") or {}).get("workspace"))
    or cfg.get("workspace")
)
defaults_workspace = normalize_path(defaults_workspace) or profile_workspace(openclaw_home, profile)

workspaces = []
seen = set()

for entry in agents:
    if not isinstance(entry, dict):
        continue
    ws = normalize_path(entry.get("workspace"))
    if not ws:
        ws = defaults_workspace
    if ws == openclaw_home:
        ws = profile_workspace(openclaw_home, profile)
    if not ws or ws in seen:
        continue
    seen.add(ws)
    workspaces.append(ws)

if not workspaces:
    ws = defaults_workspace
    if ws and ws not in seen:
        workspaces.append(ws)

if not workspaces:
    fallback = profile_workspace(openclaw_home, profile)
    if fallback:
        workspaces.append(fallback)

for ws in workspaces:
    print(f"WORKSPACE\t{ws}")
PY
    return
  fi

  if [ -d "$oc_home/workspace" ]; then
    echo "WORKSPACE	$oc_home/workspace"
  fi
  for ws in "$oc_home"/workspace-*; do
    [ -d "$ws" ] || continue
    case "$ws" in
      "$oc_home/workspace") continue ;;
      *) echo "WORKSPACE	$ws" ;;
    esac
  done
}

_reindex_openclaw_memory() {
  local -a agent_ids=()
  local aid

  if ! command -v openclaw >/dev/null 2>&1; then
    echo "openclaw CLI not found: skipped memory reindex."
    return
  fi

  while IFS=$'\t' read -r aid _path; do
    aid="${aid//$'\r'/}"
    if [ -z "$aid" ]; then
      continue
    fi
    agent_ids+=("$aid")
  done < <(_oc_agent_sessions)

  if [ "${#agent_ids[@]}" -eq 0 ]; then
    agent_ids=("main")
  fi

  echo "Re-indexing OpenClaw memory (memory + qmd) for:"
  local id
  local attempts=0
  local failures=0
  for id in "${agent_ids[@]}"; do
    attempts=$((attempts + 1))
    if openclaw memory index --agent "$id" --force; then
      echo "  [$id] memory index refreshed."
    else
      echo "  [$id] memory index failed; continuing."
      failures=$((failures + 1))
    fi
  done

  echo "Done: $attempts agents indexed, $failures failures."
}

# Wipe agent session files + workspace memory directories for all configured agents.
_wipe_openclaw_agent_data() {
  local oc_home="$(_oc_home)"
  local oc_home_display
  local aid
  local sessions_dir
  local count
  local memory_count
  local workspace
  local memory_dir
  local seen_workspace
  local ws_path

  oc_home_display="$(printf "%s" "$oc_home" | sed "s|$HOME|~|")"
  echo "OpenClaw data targets:"
  echo "  - session trace files: $oc_home_display/agents/*/sessions"
  echo "  - workspace memory: <workspace>/memory"
  echo "  - legacy top-level memory: $oc_home_display/memory (if present)"
  echo ""

  # Wipe all session files for each agent.
  while IFS=$'\t' read -r aid sessions_dir; do
    [ -n "$aid" ] && [ -n "$sessions_dir" ] || continue
    sessions_dir="${sessions_dir//$'\r'/}"
    if [ ! -d "$sessions_dir" ]; then
      echo "  [$aid] no sessions directory — skipping"
      continue
    fi

    count=$(find "$sessions_dir" -maxdepth 1 \( -name "*.jsonl" -o -name "*.jsonl.deleted.*" -o -name "*.jsonl.tmp" \) 2>/dev/null | wc -l | tr -d ' ')

    find "$sessions_dir" -maxdepth 1 -name "*.jsonl" -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "*.jsonl.deleted.*" -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "*.jsonl.tmp" -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "sessions.json.*.tmp" -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "sessions.json.backup*" -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "sessions.json.bak.*" -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "sessions.json.pre-prune-backup" -delete 2>/dev/null || true
    [ -f "$sessions_dir/sessions.json" ] && echo '{}' > "$sessions_dir/sessions.json"

    echo "  [$aid] cleared $count session file(s)"
  done < <(_oc_agent_sessions)

  # Wipe workspace memory dirs for configured agents.
  while IFS=$'\t' read -r _kind workspace; do
    workspace="${workspace//$'\r'/}"
    [ -n "$workspace" ] || continue
    if [ -n "$seen_workspace" ] && printf '%s\n' "$seen_workspace" | grep -Fxq "$workspace"; then
      continue
    fi
    seen_workspace="${seen_workspace}${seen_workspace:+\n}${workspace}"
    memory_dir="${workspace}/memory"
    if [ ! -d "$memory_dir" ]; then
      continue
    fi

    memory_count=$(find "$memory_dir" -type f 2>/dev/null | wc -l | tr -d ' ')
    rm -rf "$memory_dir"
    mkdir -p "$memory_dir"
    ws_path="${workspace#/}"
    echo "  [$ws_path] memory dir reset (${memory_count} file(s) removed)"
  done < <(_oc_agent_workspaces)

  # Preserve and clear legacy top-level OpenClaw memory directory (if present).
  if [ -d "$oc_home/memory" ]; then
    memory_count=$(find "$oc_home/memory" -type f 2>/dev/null | wc -l | tr -d ' ')
    rm -rf "$oc_home/memory"
    mkdir -p "$oc_home/memory"
    echo "  [$(printf "%s" "$oc_home" | sed "s|$HOME|~|")/memory] reset ($memory_count file(s) removed)"
  fi
}

# ===========================================================================
# cleanup_openclaw_cron_jobs — remove OpenClaw cron jobs tied to this Clawboard
# workspace (for a true fresh reset). Non-matching jobs are preserved.
# ===========================================================================
_cleanup_openclaw_cron_jobs() {
  local workspace

  if ! command -v openclaw >/dev/null 2>&1; then
    echo "openclaw CLI not found: skipped cron cleanup."
    return
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found: skipped cron cleanup."
    return
  fi

  workspace="$(cd "$ROOT_DIR" && pwd)"

  python3 - "$workspace" <<'PY'
import json
import os
import re
import subprocess
import sys

workspace = os.path.abspath(sys.argv[1])
root_match = os.path.normpath(workspace).lower()

def flatten_strings(value):
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, dict):
        rows = []
        for key, nested in value.items():
            rows.extend(flatten_strings(key))
            rows.extend(flatten_strings(nested))
        return rows
    if isinstance(value, list):
        rows = []
        for nested in value:
            rows.extend(flatten_strings(nested))
        return rows
    if value is None:
        return []
    text = str(value).strip()
    return [text] if text else []

try:
    raw = subprocess.check_output(["openclaw", "cron", "list", "--json"], stderr=subprocess.DEVNULL)
    data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
except Exception:
    print("Failed to list OpenClaw cron jobs; skipped cleanup.")
    sys.exit(0)

jobs = data.get("jobs") if isinstance(data, dict) else []
if not isinstance(jobs, list):
    jobs = []

print(f"Scanned OpenClaw cron jobs: {len(jobs)}")
matches = []
for job in jobs:
    if not isinstance(job, dict):
        continue

    job_id = str(job.get("id") or job.get("jobId") or "").strip()
    if not job_id:
        continue

    name = str(job.get("name") or "").strip().lower()
    all_text = "\n".join(piece.lower() for piece in flatten_strings(job))

    reasons = []
    if root_match and root_match in all_text:
        reasons.append("workspace_path")
    if "clawboard" in all_text:
        reasons.append("clawboard_marker")
    if "backup_openclaw_curated_memories.sh" in all_text:
        reasons.append("memory_backup")
    if "sub-agent-watchdog" in name:
        reasons.append("watchdog_name")
    if "watchdog recovery" in all_text and "clawboard_search" in all_text:
        reasons.append("watchdog_payload")
    if re.search(r"clawboard:(?:topic|task):", all_text):
        reasons.append("board_session")
    if not reasons:
        continue
    matches.append((job_id, sorted(set(reasons))))

if not matches:
    print("No matching OpenClaw cron jobs to clean.")
    sys.exit(0)

print("Cleaning OpenClaw cron jobs:")
removed = 0
failed = 0
for job_id, reasons in matches:
    ok = subprocess.call(["openclaw", "cron", "rm", job_id], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0
    reason_text = ",".join(reasons)
    if ok:
        removed += 1
        print(f"  removed cron job [{job_id}] ({reason_text})")
    else:
        failed += 1
        print(f"  failed to remove cron job [{job_id}] ({reason_text})")

preserved = max(0, len(jobs) - len(matches))
print(f"  matched: {len(matches)}, removed: {removed}, failed: {failed}, preserved: {preserved}")
PY
}

# ===========================================================================
# reset_data — wipe Clawboard's local data/ (Postgres + Qdrant).
# OpenClaw data is never touched; the scope is $ROOT_DIR/data only.
# ===========================================================================
reset_data() {
  local force=false
  local project_name=""
  local api_db_volume=""
  if [ "${1:-}" = "--yes" ]; then
    force=true
  fi

  local oc_home
  oc_home="$(_oc_home)"
  echo "Clawboard data directory : $DATA_DIR"
  echo "OpenClaw home (untouched): $oc_home"
  echo ""

  confirm_or_abort "Delete Clawboard data under data/ (Postgres + Qdrant) and any legacy SQLite volume? OpenClaw data is NOT affected. Continue?" "$force"
  down

  # Legacy cleanup: older deployments used a named SQLite volume for /db/clawboard.db.
  project_name="${COMPOSE_PROJECT_NAME:-$(basename "$ROOT_DIR")}"
  for api_db_volume in "${project_name}_clawboard_api_db" "clawboard_api_db"; do
    docker volume rm -f "$api_db_volume" >/dev/null 2>&1 || true
  done

  # Scope is intentionally $DATA_DIR = $ROOT_DIR/data — never $oc_home.
  rm -rf "$DATA_DIR"
  mkdir -p "$DATA_DIR/qdrant" "$DATA_DIR/postgres"
  echo "Clawboard data reset complete. OpenClaw config/credentials were not touched by this step."
}

# ===========================================================================
# reset_openclaw_sessions — wipe agent session history; preserve everything
# else (memories, credentials, QMD indexes).  Agent list and paths are read
# dynamically from openclaw.json so this works for any install layout.
# ===========================================================================
reset_openclaw_sessions() {
  local force=false
  if [ "${1:-}" = "--yes" ]; then
    force=true
  fi

  local oc_home cfg_path
  oc_home="$(_oc_home)"
  cfg_path="$(_oc_config_path)"

  echo "OpenClaw home : $oc_home"
  if [ -n "$cfg_path" ]; then
    echo "Config file   : $cfg_path"
  else
    echo "Config file   : not found — falling back to filesystem discovery"
  fi
  echo ""
  echo "The following paths will be PRESERVED:"
  if ! _oc_preserved_paths_summary 2>/dev/null; then
    echo "  (config unreadable — agent/ and qmd/ dirs will not be touched)"
  fi
  echo ""

  confirm_or_abort "Delete all OpenClaw session conversation history for every agent? Continue?" "$force"

  local total_agents=0 total_files=0

  while IFS=$'\t' read -r aid sessions_dir; do
    [ -n "$aid" ] && [ -n "$sessions_dir" ] || continue

    if [ ! -d "$sessions_dir" ]; then
      echo "  [$aid] no sessions directory — skipping"
      continue
    fi

    local count=0
    count=$(find "$sessions_dir" -maxdepth 1 \( -name "*.jsonl" -o -name "*.jsonl.deleted.*" -o -name "*.jsonl.tmp" \) 2>/dev/null | wc -l | tr -d ' ')

    # Active and soft-deleted session files
    find "$sessions_dir" -maxdepth 1 -name "*.jsonl"            -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "*.jsonl.deleted.*"  -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "*.jsonl.tmp"        -delete 2>/dev/null || true
    # Stale atomic-write temp files and doctor backup snapshots
    find "$sessions_dir" -maxdepth 1 -name "sessions.json.*.tmp"          -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "sessions.json.backup*"        -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "sessions.json.bak.*"          -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "sessions.json.pre-prune-backup" -delete 2>/dev/null || true
    # Reset the index to an empty store (preserved so openclaw doesn't recreate it with stale keys)
    [ -f "$sessions_dir/sessions.json" ] && echo '{}' > "$sessions_dir/sessions.json"

    echo "  [$aid] cleared $count session file(s)  ($sessions_dir)"
    total_agents=$((total_agents + 1))
    total_files=$((total_files + count))
  done < <(_oc_agent_sessions)

  echo ""
  echo "Done: $total_agents agent(s), $total_files session file(s) removed."
  echo "Memories, credentials, and QMD indexes were not touched."
  echo ""
  echo "Tip: run 'openclaw gateway restart' to pick up the cleared state."
}

start_fresh_replay() {
  local force=false
  if [ "${1:-}" = "--yes" ]; then
    force=true
  fi
  confirm_or_abort "This will clear topics/tasks and reset classifier state (logs remain). Continue?" "$force"
  python3 "$ROOT_DIR/scripts/one_time_start_fresh_replay.py" --yes --integration-level full
}

reset_all_fresh() {
  local force=false
  local oc_home
  if [ "${1:-}" = "--yes" ]; then
    force=true
  elif [ -n "${1:-}" ]; then
    echo "Unknown option for reset-all-fresh: $1"
    echo "Usage: bash deploy.sh reset-all-fresh [--yes]"
    exit 1
  fi

  oc_home="$(_oc_home)"
  echo "OpenClaw home : $oc_home"
  echo "Clawboard dir : $ROOT_DIR"
  if [ -d "$ROOT_DIR/data" ]; then
    echo "Clawboard data: $ROOT_DIR/data"
  fi
  echo ""
  echo "Preserved:"
  echo "  - qmd index stores under agents/<id>/qmd/"
  echo "  - OpenClaw config/credentials in $oc_home (agents/*/agent)"
  echo "  - workspace rule files (AGENTS.md, SOUL.md, HEARTBEAT.md, etc.)"
  echo "  - cron jobs not matching Clawboard workspace are preserved"
  echo ""

  confirm_or_abort "This will wipe all Clawboard data + OpenClaw sessions/memory and remove Clawboard OpenClaw cron jobs. Continue?" "$force"

  echo "Stopping services..."
  down

  echo "Resetting OpenClaw agent memory/session state..."
  _wipe_openclaw_agent_data

  echo "Cleaning OpenClaw cron jobs..."
  _cleanup_openclaw_cron_jobs

  echo "Resetting Clawboard data..."
  reset_data --yes

  echo "OpenClaw sessions/memory were reset above; config/credentials and non-Clawboard cron jobs were preserved."

  echo "Starting services..."
  up

  echo "Reindexing OpenClaw memory + qmd indexes..."
  _reindex_openclaw_memory

  echo "Done."
}

cleanup_orphan_tools() {
  local apply=true
  local force=false

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) apply=false ;;
      --yes) force=true ;;
      *)
        echo "error: unknown flag for cleanup-orphan-tools: $1" >&2
        echo "usage: bash deploy.sh cleanup-orphan-tools [--dry-run] [--yes]" >&2
        exit 1
        ;;
    esac
    shift
  done

  if [ "$apply" = "true" ]; then
    confirm_or_abort "Delete orphaned tool logs (unallocated control-plane traces)?" "$force"
  fi

  local apply_flag="0"
  if [ "$apply" = "true" ]; then
    apply_flag="1"
  fi

  if ! compose exec -T -e CLAWBOARD_CLEANUP_APPLY="$apply_flag" api python - <<'PY'; then
import os
from collections import Counter

from sqlmodel import select

from app.db import get_session
from app.models import LogEntry


CONTROL_CHANNEL_BUCKETS = {"channel:openclaw", "channel:clawboard"}
TOOL_PREFIXES = ("tool call:", "tool result:", "tool error:")
APPLY = os.getenv("CLAWBOARD_CLEANUP_APPLY", "0").strip() == "1"


def _text(value):
    return str(value or "").strip()


def _is_orphan_tool_log(entry):
    if _text(getattr(entry, "type", "")).lower() != "action":
        return False
    content = _text(getattr(entry, "content", "")).lower()
    if not content.startswith(TOOL_PREFIXES):
        return False
    if _text(getattr(entry, "topicId", "")) or _text(getattr(entry, "taskId", "")):
        return False

    source = getattr(entry, "source", None)
    source = source if isinstance(source, dict) else {}
    session_key = _text(source.get("sessionKey")).lower()
    has_specific_session = bool(session_key and session_key not in CONTROL_CHANNEL_BUCKETS)
    has_board_scope = bool(_text(source.get("boardScopeTopicId")) or _text(source.get("boardScopeTaskId")))
    return not has_specific_session and not has_board_scope


def _tool_name(content):
    raw = _text(content)
    if ":" not in raw:
        return "(unknown)"
    value = raw.split(":", 1)[1].strip()
    return value or "(unknown)"


with get_session() as session:
    rows = session.exec(select(LogEntry).where(LogEntry.type == "action")).all()
    candidates = [row for row in rows if _is_orphan_tool_log(row)]
    tool_counts = Counter(_tool_name(row.content) for row in candidates)

    print(f"Scanned action logs: {len(rows)}")
    print(f"Matched orphaned tool logs: {len(candidates)}")
    if tool_counts:
        print("Top tools:")
        for name, count in tool_counts.most_common(10):
            print(f"  - {name}: {count}")

    if APPLY and candidates:
        for row in candidates:
            session.delete(row)
        session.commit()
        print(f"Deleted: {len(candidates)}")
    elif APPLY:
        print("Deleted: 0")
    else:
        print("Dry run only (no rows deleted).")
PY
    echo "error: failed to run cleanup in API container. Ensure API is running (e.g. 'bash deploy.sh up api')." >&2
    exit 1
  fi
}

reconcile_allocation_guardrails() {
  local apply=true
  local force=false

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) apply=false ;;
      --yes) force=true ;;
      *)
        echo "error: unknown flag for reconcile-allocation-guardrails: $1" >&2
        echo "usage: bash deploy.sh reconcile-allocation-guardrails [--dry-run] [--yes]" >&2
        exit 1
        ;;
    esac
    shift
  done

  if [ "$apply" = "true" ]; then
    confirm_or_abort "Reconcile control-plane/tool logs to enforce allocation guardrails?" "$force"
  fi

  local apply_flag="0"
  if [ "$apply" = "true" ]; then
    apply_flag="1"
  fi

  if ! compose exec -T -e CLAWBOARD_RECONCILE_APPLY="$apply_flag" api python - <<'PY'; then
import os
import re
from collections import Counter

from sqlmodel import select

from app.db import get_session
from app.models import LogEntry, Task, Topic


APPLY = os.getenv("CLAWBOARD_RECONCILE_APPLY", "0").strip() == "1"
TOOL_TRACE_RE = re.compile(r"(tool call:|tool result:|tool error:)", flags=re.IGNORECASE)
MEMORY_ACTION_RE = re.compile(
    r"\bmemory[_-]?(search|get|query|fetch|retrieve|read|write|store|list|prune|delete)\b",
    flags=re.IGNORECASE,
)
BOARD_TASK_RE = re.compile(r"clawboard:task:(topic-[a-zA-Z0-9-]+):(task-[a-zA-Z0-9-]+)")
BOARD_TOPIC_RE = re.compile(r"clawboard:topic:(topic-[a-zA-Z0-9-]+)")
TRUE_VALUES = {"1", "true", "yes", "on"}
SCOPE_PRUNE_KEYS = (
    "boardScopeTopicId",
    "boardScopeTaskId",
    "boardScopeKind",
    "boardScopeLock",
    "boardScopeTopicOnly",
)


def _text(value):
    return str(value or "").strip()


def _source_map(row):
    src = getattr(row, "source", None)
    return dict(src) if isinstance(src, dict) else {}


def _combined_text(row):
    return " ".join(part for part in (_text(getattr(row, "content", None)), _text(getattr(row, "summary", None)), _text(getattr(row, "raw", None))) if part).strip()


def _to_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return int(default)


def _terminal_attempts(row):
    return max(1, _to_int(getattr(row, "classificationAttempts", 0), 0))


def _truthy(value):
    if isinstance(value, bool):
        return value
    return _text(value).lower() in TRUE_VALUES


def _base_session_key(source):
    return (_text((source or {}).get("sessionKey")).split("|", 1)[0] or "").strip()


def _parse_board_session_key(base):
    key = _text(base)
    if not key:
        return (None, None)
    task_match = BOARD_TASK_RE.search(key)
    if task_match:
        return (task_match.group(1), task_match.group(2))
    topic_match = BOARD_TOPIC_RE.search(key)
    if topic_match:
        return (topic_match.group(1), None)
    return (None, None)


def _is_subagent_scaffold(row_type, base_session_key, text):
    if row_type != "conversation":
        return False
    if ":subagent:" not in _text(base_session_key).lower():
        return False
    return bool(re.match(r"^\s*\[subagent context\]", text, flags=re.IGNORECASE))


def _is_heartbeat_text(text):
    if not text:
        return False
    if re.match(r"^\s*\[cron:[^\]]+\]", text, flags=re.IGNORECASE):
        return True
    if re.match(r"^\s*heartbeat\s*:", text, flags=re.IGNORECASE):
        return True
    if re.match(r"^\s*heartbeat_ok\s*$", text, flags=re.IGNORECASE):
        return True
    return bool(re.search(r"heartbeat and watchdog recovery check", text, flags=re.IGNORECASE))


def _is_control_plane_conversation(row_type, source, text):
    if row_type != "conversation":
        return False
    channel = _text((source or {}).get("channel")).lower()
    if channel == "heartbeat":
        return True
    if _text(_base_session_key(source)).lower() != "agent:main:main":
        return False
    return _is_heartbeat_text(text)


def _is_tool_trace(row_type, text):
    return row_type == "action" and bool(TOOL_TRACE_RE.search(text or ""))


def _is_memory_tool_action(text):
    combined = _text(text)
    if not combined:
        return False
    if not TOOL_TRACE_RE.search(combined):
        return False
    return bool(MEMORY_ACTION_RE.search(combined))


def _supports_bundle_tool_scoping(base_session_key):
    base = _text(base_session_key).lower()
    if not base:
        return False
    if base.startswith("channel:"):
        return True
    if base.startswith("clawboard:topic:") or base.startswith("clawboard:task:"):
        return True
    return ":clawboard:topic:" in base or ":clawboard:task:" in base


def _prune_scope(source):
    out = dict(source or {})
    for key in SCOPE_PRUNE_KEYS:
        out.pop(key, None)
    return out


def _canonical_source_for_anchor(source, *, topic_id, task_id, space_id):
    out = dict(source or {})
    if topic_id:
        out["boardScopeTopicId"] = topic_id
        if task_id:
            out["boardScopeTaskId"] = task_id
            out["boardScopeKind"] = "task"
            out["boardScopeLock"] = True
            out.pop("boardScopeTopicOnly", None)
        else:
            out.pop("boardScopeTaskId", None)
            if _truthy(out.get("boardScopeTopicOnly")):
                out["boardScopeTopicOnly"] = True
                out["boardScopeKind"] = "topic_only"
                out["boardScopeLock"] = True
            else:
                out.pop("boardScopeTopicOnly", None)
                out["boardScopeKind"] = "topic"
                if "boardScopeLock" in out:
                    out["boardScopeLock"] = _truthy(out.get("boardScopeLock"))
                else:
                    out["boardScopeLock"] = False
    else:
        out = _prune_scope(out)

    if space_id:
        out["boardScopeSpaceId"] = space_id
    return out


def _resolve_anchor(row, source, topic_by_id, task_by_id):
    topic_id = _text(getattr(row, "topicId", None)) or _text((source or {}).get("boardScopeTopicId"))
    task_id = _text(getattr(row, "taskId", None)) or _text((source or {}).get("boardScopeTaskId"))
    parsed_topic, parsed_task = _parse_board_session_key(_base_session_key(source))
    if not topic_id and parsed_topic:
        topic_id = parsed_topic
    if not task_id and parsed_task:
        task_id = parsed_task

    task_row = task_by_id.get(task_id) if task_id else None
    if task_id and not task_row:
        task_id = ""
    if task_row:
        owner_topic = _text(task_row.get("topicId"))
        if owner_topic:
            topic_id = owner_topic
        else:
            task_id = ""
            task_row = None

    topic_row = topic_by_id.get(topic_id) if topic_id else None
    if topic_id and not topic_row:
        topic_id = ""
        topic_row = None
        if task_id:
            task_id = ""
            task_row = None

    if task_id and task_row:
        owner_topic = _text(task_row.get("topicId"))
        if owner_topic and owner_topic != topic_id:
            topic_id = owner_topic
            topic_row = topic_by_id.get(topic_id)

    space_id = ""
    if task_row:
        space_id = _text(task_row.get("spaceId"))
    if not space_id and topic_row:
        space_id = _text(topic_row.get("spaceId"))

    return (topic_id or None, task_id or None, space_id or None)


with get_session() as session:
    topic_by_id = {}
    for row in session.exec(select(Topic)).all():
        topic_id = _text(getattr(row, "id", None))
        if topic_id:
            topic_by_id[topic_id] = {"spaceId": _text(getattr(row, "spaceId", None))}

    task_by_id = {}
    for row in session.exec(select(Task)).all():
        task_id = _text(getattr(row, "id", None))
        if task_id:
            task_by_id[task_id] = {
                "topicId": _text(getattr(row, "topicId", None)),
                "spaceId": _text(getattr(row, "spaceId", None)),
            }

    rows = session.exec(select(LogEntry).where(LogEntry.type.in_(["conversation", "action", "system", "import"]))).all()

    touched = 0
    reasons = Counter()

    for row in rows:
        source = _source_map(row)
        row_type = _text(getattr(row, "type", None)).lower()
        text = _combined_text(row)
        base_session_key = _base_session_key(source)
        channel = _text(source.get("channel")).lower()
        current_status = _text(getattr(row, "classificationStatus", None)).lower() or "pending"

        desired = None
        desired_source = None
        reason = None

        if channel == "cron-event":
            desired = {
                "topicId": None,
                "taskId": None,
                "classificationStatus": "failed",
                "classificationAttempts": _terminal_attempts(row),
                "classificationError": "filtered_cron_event",
            }
            desired_source = _prune_scope(source)
            reason = "control:filtered_cron_event"
        elif _is_subagent_scaffold(row_type, base_session_key, text):
            desired = {
                "topicId": None,
                "taskId": None,
                "classificationStatus": "failed",
                "classificationAttempts": _terminal_attempts(row),
                "classificationError": "filtered_subagent_scaffold",
            }
            desired_source = _prune_scope(source)
            reason = "control:filtered_subagent_scaffold"
        elif _is_control_plane_conversation(row_type, source, text):
            desired = {
                "topicId": None,
                "taskId": None,
                "classificationStatus": "failed",
                "classificationAttempts": _terminal_attempts(row),
                "classificationError": "filtered_control_plane",
            }
            desired_source = _prune_scope(source)
            reason = "control:filtered_control_plane"
        elif _is_tool_trace(row_type, text):
            anchor_topic_id, anchor_task_id, anchor_space_id = _resolve_anchor(
                row,
                source,
                topic_by_id,
                task_by_id,
            )
            anchored = bool(anchor_topic_id or anchor_task_id)
            is_memory_action = _is_memory_tool_action(text)

            target_topic_id = anchor_topic_id if anchored else None
            target_task_id = anchor_task_id if anchored else None
            target_space_id = anchor_space_id if anchored else None

            if is_memory_action:
                desired = {
                    "topicId": target_topic_id,
                    "taskId": target_task_id,
                    "classificationStatus": "classified",
                    "classificationAttempts": _terminal_attempts(row),
                    "classificationError": "filtered_memory_action",
                }
                reason = "tool:filtered_memory_action"
            elif anchored:
                desired = {
                    "topicId": target_topic_id,
                    "taskId": target_task_id,
                    "classificationStatus": "classified",
                    "classificationAttempts": _terminal_attempts(row),
                    "classificationError": "filtered_tool_activity",
                }
                reason = "tool:filtered_tool_activity"
            elif _supports_bundle_tool_scoping(base_session_key) and current_status == "pending":
                desired = {
                    "topicId": None,
                    "taskId": None,
                    "classificationStatus": "pending",
                    "classificationAttempts": 0,
                    "classificationError": None,
                }
                reason = "tool:deferred_unanchored_bundle_scope"
            else:
                desired = {
                    "topicId": None,
                    "taskId": None,
                    "classificationStatus": "failed",
                    "classificationAttempts": _terminal_attempts(row),
                    "classificationError": "filtered_unanchored_tool_activity",
                }
                reason = "tool:filtered_unanchored_tool_activity"

            if target_space_id and (target_topic_id or target_task_id):
                desired["spaceId"] = target_space_id
            desired_source = _canonical_source_for_anchor(
                source,
                topic_id=target_topic_id,
                task_id=target_task_id,
                space_id=target_space_id,
            )

        if not desired or not reason:
            continue

        changed = False
        for key, value in desired.items():
            if getattr(row, key) != value:
                changed = True
                if APPLY:
                    setattr(row, key, value)

        if desired_source is not None:
            current_source = _source_map(row)
            if current_source != desired_source:
                changed = True
                if APPLY:
                    row.source = desired_source

        if not changed:
            continue

        touched += 1
        reasons[reason] += 1
        if APPLY:
            session.add(row)

    print(f"Scanned logs: {len(rows)}")
    print(f"Rows needing reconciliation: {touched}")
    if reasons:
        print("Reconciled by reason:")
        for name, count in reasons.most_common():
            print(f"  - {name}: {count}")

    if APPLY and touched:
        session.commit()
        print(f"Updated rows: {touched}")
    elif APPLY:
        print("Updated rows: 0")
    else:
        print("Dry run only (no rows updated).")
PY
    echo "error: failed to run reconciliation in API container. Ensure API is running (e.g. 'bash deploy.sh up api')." >&2
    exit 1
  fi
}

verify_production_ready() {
  local run_tests=true
  local run_live_smoke=false
  local strict=false

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --skip-tests) run_tests=false ;;
      --live-smoke) run_live_smoke=true ;;
      --strict) strict=true ;;
      *)
        echo "error: unknown flag for verify-production-ready: $1" >&2
        echo "usage: bash deploy.sh verify-production-ready [--skip-tests] [--live-smoke] [--strict]" >&2
        exit 1
        ;;
    esac
    shift
  done

  local pass_count=0
  local warn_count=0
  local fail_count=0

  _verify_pass() {
    pass_count=$((pass_count + 1))
    echo "PASS  $1"
  }

  _verify_warn() {
    warn_count=$((warn_count + 1))
    echo "WARN  $1"
  }

  _verify_fail() {
    fail_count=$((fail_count + 1))
    echo "FAIL  $1"
  }

  echo "Production readiness audit"
  echo "Root: $ROOT_DIR"
  echo "Options: run_tests=$run_tests live_smoke=$run_live_smoke strict=$strict"
  echo ""

  # -------------------------------------------------------------------------
  # Stack health
  # -------------------------------------------------------------------------
  local running_services=""
  if running_services="$(compose ps --services --filter status=running 2>/dev/null)"; then
    _verify_pass "Docker Compose is reachable."
  else
    _verify_fail "Docker Compose status query failed."
    running_services=""
  fi

  local required_svc
  for required_svc in api classifier db qdrant; do
    if printf "%s\n" "$running_services" | grep -Fxq "$required_svc"; then
      _verify_pass "Service running: $required_svc"
    else
      _verify_fail "Service not running: $required_svc"
    fi
  done
  if printf "%s\n" "$running_services" | grep -Eq '^(web|web-dev)$'; then
    _verify_pass "Web service running (web or web-dev)."
  else
    _verify_fail "No web service running (expected web or web-dev)."
  fi

  # -------------------------------------------------------------------------
  # OpenClaw config + contract wiring checks
  # -------------------------------------------------------------------------
  if ! command -v openclaw >/dev/null 2>&1; then
    _verify_fail "openclaw CLI is not available."
  else
    _verify_pass "openclaw CLI available."
  fi

  local cfg_path=""
  cfg_path="$(_oc_config_path)"
  if [ -z "$cfg_path" ] || [ ! -f "$cfg_path" ]; then
    _verify_fail "OpenClaw config file not found."
  else
    _verify_pass "OpenClaw config file found at $cfg_path."
    local cfg_checks=""
    if cfg_checks="$(python3 - "$cfg_path" <<'PY'
import json
import os
import sys

cfg_path = sys.argv[1]
rows = []

def emit(level, name, detail):
    detail = str(detail).replace("\t", " ").replace("\n", " ").strip()
    rows.append(f"{level}\t{name}\t{detail}")

try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception as exc:
    emit("FAIL", "config.parse", f"unable to parse openclaw.json: {exc}")
    print("\n".join(rows))
    raise SystemExit(0)

memory = cfg.get("memory") or {}
tools = cfg.get("tools") or {}
agents = cfg.get("agents") or {}
agent_list = agents.get("list") or []
defaults = agents.get("defaults") or {}
plugins = (cfg.get("plugins") or {}).get("entries") or {}
logger = plugins.get("clawboard-logger") or {}

backend = memory.get("backend")
if backend == "qmd":
    emit("PASS", "memory.backend", "qmd")
else:
    emit("FAIL", "memory.backend", f"expected qmd, got {backend!r}")

qmd_sessions_enabled = ((memory.get("qmd") or {}).get("sessions") or {}).get("enabled")
if qmd_sessions_enabled is False:
    emit("PASS", "memory.qmd.sessions.enabled", "false")
else:
    emit("FAIL", "memory.qmd.sessions.enabled", f"expected false, got {qmd_sessions_enabled!r}")

sources = ((defaults.get("memorySearch") or {}).get("sources") or [])
if isinstance(sources, list) and sorted(set(str(v) for v in sources)) == ["memory"] and len(sources) == 1:
    emit("PASS", "agents.defaults.memorySearch.sources", json.dumps(sources))
else:
    emit("FAIL", "agents.defaults.memorySearch.sources", f"expected ['memory'], got {json.dumps(sources)}")

loop_detection = tools.get("loopDetection")
if isinstance(loop_detection, dict):
    if loop_detection.get("enabled") is True:
        emit("PASS", "tools.loopDetection.enabled", "true")
    else:
        emit("WARN", "tools.loopDetection.enabled", f"configured but not enabled (got {loop_detection.get('enabled')!r})")

    warning = loop_detection.get("warningThreshold")
    critical = loop_detection.get("criticalThreshold")
    breaker = loop_detection.get("globalCircuitBreakerThreshold")
    if all(isinstance(v, int) and v > 0 for v in (warning, critical, breaker)):
        if warning < critical < breaker:
            emit("PASS", "tools.loopDetection.thresholds", f"{warning}<{critical}<{breaker}")
        else:
            emit("FAIL", "tools.loopDetection.thresholds", f"invalid ordering: {warning}, {critical}, {breaker}")
    else:
        emit("WARN", "tools.loopDetection.thresholds", f"not fully configured: warning={warning!r} critical={critical!r} breaker={breaker!r}")

    detectors = loop_detection.get("detectors")
    if isinstance(detectors, dict):
        missing_detectors = [
            key for key in ("genericRepeat", "knownPollNoProgress", "pingPong")
            if detectors.get(key) is not True
        ]
        if missing_detectors:
            emit("WARN", "tools.loopDetection.detectors", f"missing/disabled: {', '.join(missing_detectors)}")
        else:
            emit("PASS", "tools.loopDetection.detectors", "genericRepeat,knownPollNoProgress,pingPong")
    else:
        emit("WARN", "tools.loopDetection.detectors", "missing detector config object")
else:
    emit("WARN", "tools.loopDetection", "not present (may be unsupported on this OpenClaw build)")

if logger.get("enabled") is True:
    emit("PASS", "plugins.entries.clawboard-logger.enabled", "true")
else:
    emit("FAIL", "plugins.entries.clawboard-logger.enabled", f"expected true, got {logger.get('enabled')!r}")

logger_cfg = logger.get("config")
if not isinstance(logger_cfg, dict):
    emit("FAIL", "plugins.entries.clawboard-logger.config", "missing config object")
else:
    base_url = logger_cfg.get("baseUrl")
    if base_url:
        emit("PASS", "plugins.entries.clawboard-logger.config.baseUrl", base_url)
    else:
        emit("FAIL", "plugins.entries.clawboard-logger.config.baseUrl", "missing")

    context_mode = logger_cfg.get("contextMode")
    if context_mode in {"full", "auto", "cheap", "patient"}:
        emit("PASS", "plugins.entries.clawboard-logger.config.contextMode", context_mode)
    else:
        emit("FAIL", "plugins.entries.clawboard-logger.config.contextMode", f"invalid mode: {context_mode!r}")

main_agent = None
for item in agent_list:
    if isinstance(item, dict) and str(item.get("id", "")).strip() == "main":
        main_agent = item
        break

if main_agent is None:
    emit("FAIL", "agents.main.exists", "main agent missing from agents.list")
else:
    emit("PASS", "agents.main.exists", "main agent present")
    allow = set(str(v) for v in ((main_agent.get("subagents") or {}).get("allowAgents") or []))
    needed_allow = {"coding", "web", "social", "docs"}
    missing_allow = sorted(needed_allow - allow)
    if missing_allow:
        emit("FAIL", "agents.main.subagents.allowAgents", f"missing: {', '.join(missing_allow)}")
    else:
        emit("PASS", "agents.main.subagents.allowAgents", "coding,web,social,docs")

    hb_every = ((main_agent.get("heartbeat") or {}).get("every"))
    if hb_every == "5m":
        emit("PASS", "agents.main.heartbeat.every", "5m")
    else:
        emit("FAIL", "agents.main.heartbeat.every", f"expected 5m, got {hb_every!r}")

    tools_allow = set(str(v) for v in ((main_agent.get("tools") or {}).get("allow") or []))
    needed_tools = {
        "sessions_spawn",
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "cron",
        "clawboard_search",
        "clawboard_update_task",
        "clawboard_context",
        "clawboard_get_task",
    }
    missing_tools = sorted(needed_tools - tools_allow)
    if missing_tools:
        emit("FAIL", "agents.main.tools.allow", f"missing: {', '.join(missing_tools)}")
    else:
        emit("PASS", "agents.main.tools.allow", "delegation + clawboard tools present")

    main_loop = (main_agent.get("tools") or {}).get("loopDetection")
    if isinstance(main_loop, dict):
        if main_loop.get("enabled") is True:
            emit("PASS", "agents.main.tools.loopDetection.enabled", "true")
        else:
            emit("WARN", "agents.main.tools.loopDetection.enabled", f"configured but not enabled (got {main_loop.get('enabled')!r})")
    else:
        emit("WARN", "agents.main.tools.loopDetection", "not present (may be unsupported on this OpenClaw build)")

    main_workspace = str(main_agent.get("workspace", "")).strip()
    if not main_workspace:
        emit("FAIL", "agents.main.workspace", "missing workspace path")
    else:
        agents_md = os.path.join(os.path.abspath(os.path.expanduser(main_workspace)), "AGENTS.md")
        if not os.path.isfile(agents_md):
            emit("FAIL", "agents.main.workspace.AGENTS.md", f"missing at {agents_md}")
        else:
            try:
                text = open(agents_md, "r", encoding="utf-8").read()
            except Exception as exc:
                emit("FAIL", "agents.main.workspace.AGENTS.md", f"unreadable: {exc}")
            else:
                markers = [
                    "Main Agent Operating Contract",
                    "BOARD SESSION RESPONSE GUARANTEE",
                    "CLAWBOARD LEDGER RECOVERY",
                    "Tool Contract (MANDATORY)",
                ]
                missing_markers = [m for m in markers if m not in text]
                if missing_markers:
                    emit("FAIL", "agents.main.workspace.AGENTS.md", f"missing markers: {', '.join(missing_markers)}")
                else:
                    emit("PASS", "agents.main.workspace.AGENTS.md", "contract markers present")

print("\n".join(rows))
PY
)"; then
      while IFS=$'\t' read -r level name detail; do
        [ -n "${level:-}" ] || continue
        case "$level" in
          PASS) _verify_pass "$name :: $detail" ;;
          WARN) _verify_warn "$name :: $detail" ;;
          FAIL) _verify_fail "$name :: $detail" ;;
          *) _verify_warn "$name :: $detail" ;;
        esac
      done <<< "$cfg_checks"
    else
      _verify_fail "Unable to run OpenClaw config audit checks."
    fi
  fi

  # -------------------------------------------------------------------------
  # Runtime memory/QMD checks
  # -------------------------------------------------------------------------
  if command -v openclaw >/dev/null 2>&1; then
    local memory_status_raw=""
    local memory_status_rc=0
    set +e
    memory_status_raw="$(
      python3 - <<'PY'
import subprocess
import sys

cmd = ["openclaw", "memory", "status", "--json"]
try:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
except subprocess.TimeoutExpired as exc:
    if exc.stderr:
        err = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else exc.stderr
        if err:
            sys.stderr.write(err)
    raise SystemExit(124)

if proc.returncode != 0:
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    raise SystemExit(proc.returncode)

out = (proc.stdout or "").strip()
if out:
    print(out)
PY
    )"
    memory_status_rc=$?
    set -e
    if [ "$memory_status_rc" -eq 0 ]; then
      local memory_checks=""
      if memory_checks="$(python3 - "$memory_status_raw" <<'PY'
import json
import sys

rows = []

def emit(level, name, detail):
    detail = str(detail).replace("\t", " ").replace("\n", " ").strip()
    rows.append(f"{level}\t{name}\t{detail}")

raw = sys.argv[1]
try:
    data = json.loads(raw)
except Exception as exc:
    emit("FAIL", "openclaw.memory.status", f"invalid JSON payload: {exc}")
    print("\n".join(rows))
    raise SystemExit(0)

if isinstance(data, dict):
    if isinstance(data.get("agents"), list):
        data = data.get("agents") or []
    elif "agentId" in data and isinstance(data.get("status"), dict):
        data = [data]
    else:
        emit("WARN", "openclaw.memory.status", f"unexpected payload shape: {sorted(data.keys())[:8]}")
        print("\n".join(rows))
        raise SystemExit(0)

if not isinstance(data, list) or not data:
    emit("WARN", "openclaw.memory.status", "no agent status rows")
    print("\n".join(rows))
    raise SystemExit(0)

emit("PASS", "openclaw.memory.status", f"rows={len(data)}")
for row in data:
    aid = str((row or {}).get("agentId", "")).strip() or "(unknown)"
    row_obj = row or {}
    st = row_obj.get("status") or {}
    backend = st.get("backend", row_obj.get("backend"))
    provider = st.get("provider", row_obj.get("provider"))
    dirty = st.get("dirty", row_obj.get("dirty"))
    sources = st.get("sources", row_obj.get("sources")) or []

    if backend is None and provider is None:
        emit("WARN", f"memory.status.{aid}.backend_provider", "missing backend/provider fields")
    elif backend == "qmd" and provider == "qmd":
        emit("PASS", f"memory.status.{aid}.backend_provider", "qmd/qmd")
    else:
        emit("FAIL", f"memory.status.{aid}.backend_provider", f"expected qmd/qmd, got {backend!r}/{provider!r}")

    if dirty is None:
        emit("WARN", f"memory.status.{aid}.dirty", "missing dirty field")
    elif dirty is False:
        emit("PASS", f"memory.status.{aid}.dirty", "false")
    else:
        emit("FAIL", f"memory.status.{aid}.dirty", f"expected false, got {dirty!r}")

    if not isinstance(sources, list) or not sources:
        emit("WARN", f"memory.status.{aid}.sources", f"missing/empty sources field ({json.dumps(sources)})")
    elif sorted(set(str(v) for v in sources)) == ["memory"]:
        emit("PASS", f"memory.status.{aid}.sources", json.dumps(sources))
    else:
        emit("FAIL", f"memory.status.{aid}.sources", f"expected memory-only, got {json.dumps(sources)}")

print("\n".join(rows))
PY
)"; then
        while IFS=$'\t' read -r level name detail; do
          [ -n "${level:-}" ] || continue
          case "$level" in
            PASS) _verify_pass "$name :: $detail" ;;
            WARN) _verify_warn "$name :: $detail" ;;
            FAIL) _verify_fail "$name :: $detail" ;;
            *) _verify_warn "$name :: $detail" ;;
          esac
        done <<< "$memory_checks"
      else
        _verify_fail "Unable to parse openclaw memory status payload."
      fi
    elif [ "$memory_status_rc" -eq 124 ]; then
      _verify_warn "openclaw memory status timed out after 25s; skipping runtime memory status checks."
    else
      _verify_fail "openclaw memory status query failed."
    fi
  fi

  # -------------------------------------------------------------------------
  # Logger ingestion + DB checks
  # -------------------------------------------------------------------------
  local db_metrics=""
  if db_metrics="$(compose exec -T db psql -U clawboard -d clawboard -At -c "SELECT (SELECT COUNT(*) FROM logentry),(SELECT COUNT(*) FROM logentry WHERE \"classificationStatus\"='classified'),(SELECT COUNT(*) FROM logentry WHERE \"classificationStatus\"='failed'),(SELECT COUNT(*) FROM logentry WHERE \"classificationStatus\"='pending'),(SELECT COUNT(*) FROM logentry WHERE content LIKE '%[clawboard_context_begin]%'),(SELECT COUNT(*) FROM logentry WHERE content ILIKE '%clawboard_context%');" 2>/dev/null | tail -n1)"; then
    _verify_pass "Database connectivity (logentry metrics query)."
    local logs_total classified_total failed_total pending_total injected_block_rows context_tool_rows
    IFS='|' read -r logs_total classified_total failed_total pending_total injected_block_rows context_tool_rows <<< "$db_metrics"
    logs_total="${logs_total:-0}"
    classified_total="${classified_total:-0}"
    failed_total="${failed_total:-0}"
    pending_total="${pending_total:-0}"
    injected_block_rows="${injected_block_rows:-0}"
    context_tool_rows="${context_tool_rows:-0}"

    if [ "$logs_total" -gt 0 ]; then
      _verify_pass "Logger ingestion rows present: logentry=$logs_total"
    else
      _verify_fail "No logentry rows found; logger ingestion appears inactive."
    fi

    if [ "$classified_total" -gt 0 ]; then
      _verify_pass "Classified logs present: classified=$classified_total"
    else
      _verify_warn "No classified logs detected yet."
    fi

    if [ "$injected_block_rows" -eq 0 ]; then
      _verify_pass "Context block sanitization verified ([clawboard_context_begin] persisted rows = 0)."
    else
      _verify_fail "Found persisted raw context block rows: $injected_block_rows"
    fi

    if [ "$context_tool_rows" -gt 0 ]; then
      _verify_pass "Context tool trace rows present: clawboard_context references=$context_tool_rows"
    else
      _verify_warn "No clawboard_context tool traces found in current logentry set."
    fi

    if [ "$failed_total" -gt 0 ] || [ "$pending_total" -gt 0 ]; then
      _verify_warn "classificationStatus mix: classified=$classified_total failed=$failed_total pending=$pending_total"
    else
      _verify_pass "classificationStatus mix: no failed/pending rows."
    fi
  else
    _verify_fail "Database connectivity check failed (db container/psql unavailable)."
  fi

  # -------------------------------------------------------------------------
  # Session history freshness snapshot (informational)
  # -------------------------------------------------------------------------
  local session_jsonl_count="0"
  if session_jsonl_count="$(python3 - <<'PY'
from pathlib import Path
root = Path.home() / ".openclaw" / "agents"
total = 0
for sessions_dir in root.glob("*/sessions"):
    total += sum(1 for _ in sessions_dir.glob("*.jsonl"))
print(total)
PY
 2>/dev/null)"; then
    if [ "${session_jsonl_count:-0}" -eq 0 ]; then
      _verify_pass "OpenClaw session history clean snapshot (0 *.jsonl files)."
    else
      _verify_warn "OpenClaw session history contains ${session_jsonl_count} *.jsonl file(s)."
    fi
  else
    _verify_warn "Unable to inspect OpenClaw session history snapshot."
  fi

  # -------------------------------------------------------------------------
  # Targeted tests
  # -------------------------------------------------------------------------
  if [ "$run_tests" = "true" ]; then
    if (cd "$ROOT_DIR" && node --test tests/scripts/bootstrap-clawboard.test.mjs >/tmp/clawboard-verify-scripts.log 2>&1); then
      _verify_pass "Script regression tests passed (tests/scripts/bootstrap-clawboard.test.mjs)."
    else
      _verify_fail "Script regression tests failed (see /tmp/clawboard-verify-scripts.log)."
    fi

    if (cd "$ROOT_DIR" && npm run test:logger >/tmp/clawboard-verify-logger.log 2>&1); then
      _verify_pass "Logger test suite passed (npm run test:logger)."
    else
      _verify_fail "Logger test suite failed (see /tmp/clawboard-verify-logger.log)."
    fi
  else
    _verify_warn "Skipped tests (--skip-tests)."
  fi

  if [ "$run_live_smoke" = "true" ]; then
    local smoke_token=""
    smoke_token="${PLAYWRIGHT_CLAWBOARD_TOKEN:-}"
    if [ -z "$smoke_token" ]; then
      smoke_token="$(read_env_value "CLAWBOARD_TOKEN" || true)"
    fi
    if [ -z "$smoke_token" ]; then
      _verify_fail "Live smoke requested but no token available (PLAYWRIGHT_CLAWBOARD_TOKEN or CLAWBOARD_TOKEN)."
    else
      if (
        cd "$ROOT_DIR" && \
        PLAYWRIGHT_CLAWBOARD_TOKEN="$smoke_token" npm run test:e2e:live-smoke >/tmp/clawboard-verify-live-smoke.log 2>&1
      ); then
        _verify_pass "Live stack smoke test passed (npm run test:e2e:live-smoke)."
      else
        _verify_fail "Live stack smoke test failed (see /tmp/clawboard-verify-live-smoke.log)."
      fi
    fi
  fi

  # -------------------------------------------------------------------------
  # Summary
  # -------------------------------------------------------------------------
  echo ""
  echo "Audit summary"
  echo "  PASS: $pass_count"
  echo "  WARN: $warn_count"
  echo "  FAIL: $fail_count"

  if [ "$strict" = "true" ] && [ "$warn_count" -gt 0 ]; then
    echo "STRICT mode: warnings are treated as failures."
    fail_count=$((fail_count + warn_count))
  fi

  if [ "$fail_count" -gt 0 ]; then
    echo "VERDICT: FAIL"
    return 1
  fi
  echo "VERDICT: PASS"
  return 0
}

status() {
  compose ps
}

logs() {
  compose logs -f --tail=200 "$@"
}

pull() {
  compose pull "$@"
}

run_tests() {
  npm run test:all
}

demo_load() {
  bash "$ROOT_DIR/tests/load_or_remove_fixtures.sh" load
}

demo_clear() {
  bash "$ROOT_DIR/tests/load_or_remove_fixtures.sh" remove
}

token_show() {
  local be=""
  local fe=""
  be="$(read_env_value "CLAWBOARD_TOKEN" || true)"
  fe="$(read_env_value "NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN" || true)"
  if [ -n "$be" ]; then
    echo "CLAWBOARD_TOKEN=$(mask_token "$be")"
  else
    echo "CLAWBOARD_TOKEN=<unset>"
  fi
  if [ -n "$fe" ]; then
    echo "NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN=$(mask_token "$fe")"
  else
    echo "NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN=<unset>"
  fi
}

token_be() {
  ensure_env_file
  local value="${1:-}"
  if [ -z "$value" ] || [ "$value" = "--generate" ]; then
    value="$(generate_token)"
  fi
  upsert_env_value "$ENV_FILE" "CLAWBOARD_TOKEN" "$value"
  chmod 600 "$ENV_FILE" || true
  echo "Updated CLAWBOARD_TOKEN in $ENV_FILE"
}

token_fe() {
  ensure_env_file
  local value="${1:---copy-be}"
  local be=""
  if [ "$value" = "--generate" ]; then
    value="$(generate_token)"
  elif [ "$value" = "--copy-be" ]; then
    be="$(read_env_value "CLAWBOARD_TOKEN" || true)"
    if [ -z "$be" ]; then
      echo "error: CLAWBOARD_TOKEN is unset. Run: bash deploy.sh token-be --generate" >&2
      exit 1
    fi
    value="$be"
  fi
  upsert_env_value "$ENV_FILE" "NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN" "$value"
  chmod 600 "$ENV_FILE" || true
  echo "Updated NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN in $ENV_FILE"
  echo "Note: frontend token is baked into the web bundle; run: bash deploy.sh rebuild web"
}

token_both() {
  local be="${1:---generate}"
  local fe="${2:-}"
  if [ "$be" = "--generate" ] || [ -z "$be" ]; then
    be="$(generate_token)"
  fi
  if [ -z "$fe" ]; then
    fe="$be"
  elif [ "$fe" = "--generate" ]; then
    fe="$(generate_token)"
  fi
  token_be "$be"
  token_fe "$fe"
}

token_sync_fe() {
  token_fe --copy-be
}

ensure_skill() {
  local src="$ROOT_DIR/skills/clawboard"
  local dst="$HOME/.openclaw/skills/clawboard"
  if [ ! -d "$src" ]; then
    echo "error: skill source not found: $src" >&2
    exit 1
  fi
  mkdir -p "$HOME/.openclaw/skills"
  rm -rf "$dst"
  cp -R "$src" "$dst"
  echo "Skill installed at $dst"
}

ensure_plugin() {
  local plugin_path="$ROOT_DIR/extensions/clawboard-logger"
  local token=""
  local api_base=""
  local context_mode="auto"
  local context_fetch_timeout_ms="3000"
  local context_fetch_retries="1"
  local context_fallback_modes_csv="full,auto,cheap"
  local context_fallback_modes_json='["full","auto","cheap"]'
  local context_max_chars="2200"
  local context_cache_ttl_ms="45000"
  local context_cache_max_entries="120"
  local context_use_cache_on_failure_json="true"
  local enable_openclaw_memory_search_json="false"
  if ! command -v openclaw >/dev/null 2>&1; then
    echo "error: openclaw CLI not found. Install OpenClaw first." >&2
    exit 1
  fi
  if [ ! -d "$plugin_path" ]; then
    echo "error: plugin path not found: $plugin_path" >&2
    exit 1
  fi

  token="$(read_env_value "CLAWBOARD_TOKEN" || true)"
  api_base="$(read_env_value "CLAWBOARD_PUBLIC_API_BASE" || true)"
  context_mode="$(read_env_value "CLAWBOARD_LOGGER_CONTEXT_MODE" || echo "auto")"
  context_fetch_timeout_ms="$(read_env_value "CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS" || echo "3000")"
  context_fetch_retries="$(read_env_value "CLAWBOARD_LOGGER_CONTEXT_FETCH_RETRIES" || echo "1")"
  context_fallback_modes_csv="$(read_env_value "CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODES" || echo "full,auto,cheap")"
  context_max_chars="$(read_env_value "CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS" || echo "2200")"
  context_cache_ttl_ms="$(read_env_value "CLAWBOARD_LOGGER_CONTEXT_CACHE_TTL_MS" || echo "45000")"
  context_cache_max_entries="$(read_env_value "CLAWBOARD_LOGGER_CONTEXT_CACHE_MAX_ENTRIES" || echo "120")"

  case "$(read_env_value "CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE" || echo "1")" in
    0|false|FALSE|no|NO|off|OFF) context_use_cache_on_failure_json="false" ;;
    *) context_use_cache_on_failure_json="true" ;;
  esac
  case "$(read_env_value "CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH" || echo "0")" in
    1|true|TRUE|yes|YES|on|ON) enable_openclaw_memory_search_json="true" ;;
    *) enable_openclaw_memory_search_json="false" ;;
  esac

  context_fallback_modes_json="["
  IFS=',' read -r -a _fallback_modes <<< "$context_fallback_modes_csv"
  for _mode in "${_fallback_modes[@]}"; do
    _mode="$(printf "%s" "$_mode" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    [ -n "$_mode" ] || continue
    case "$_mode" in
      auto|cheap|full|patient) ;;
      *) continue ;;
    esac
    if [ "$context_fallback_modes_json" != "[" ]; then
      context_fallback_modes_json="$context_fallback_modes_json,"
    fi
    context_fallback_modes_json="$context_fallback_modes_json\"$_mode\""
  done
  context_fallback_modes_json="$context_fallback_modes_json]"
  if [ "$context_fallback_modes_json" = "[]" ]; then
    context_fallback_modes_json='["full","auto","cheap"]'
  fi

  if [ -z "$api_base" ]; then
    api_base="http://localhost:8010"
  fi

  openclaw plugins install -l "$plugin_path"
  openclaw plugins enable clawboard-logger

  if [ -n "$token" ]; then
    CONFIG_JSON=$(printf '{"baseUrl":"%s","token":"%s","enabled":true,"contextMode":"%s","contextFetchTimeoutMs":%s,"contextFetchRetries":%s,"contextFallbackModes":%s,"contextMaxChars":%s,"contextCacheTtlMs":%s,"contextCacheMaxEntries":%s,"contextUseCacheOnFailure":%s,"enableOpenClawMemorySearch":%s}' "$api_base" "$token" "$context_mode" "$context_fetch_timeout_ms" "$context_fetch_retries" "$context_fallback_modes_json" "$context_max_chars" "$context_cache_ttl_ms" "$context_cache_max_entries" "$context_use_cache_on_failure_json" "$enable_openclaw_memory_search_json")
  else
    CONFIG_JSON=$(printf '{"baseUrl":"%s","enabled":true,"contextMode":"%s","contextFetchTimeoutMs":%s,"contextFetchRetries":%s,"contextFallbackModes":%s,"contextMaxChars":%s,"contextCacheTtlMs":%s,"contextCacheMaxEntries":%s,"contextUseCacheOnFailure":%s,"enableOpenClawMemorySearch":%s}' "$api_base" "$context_mode" "$context_fetch_timeout_ms" "$context_fetch_retries" "$context_fallback_modes_json" "$context_max_chars" "$context_cache_ttl_ms" "$context_cache_max_entries" "$context_use_cache_on_failure_json" "$enable_openclaw_memory_search_json")
  fi
  openclaw config set plugins.entries.clawboard-logger.config --json "$CONFIG_JSON" >/dev/null 2>&1 || true
  openclaw config set plugins.entries.clawboard-logger.enabled true >/dev/null 2>&1 || true
  openclaw gateway restart >/dev/null 2>&1 || openclaw gateway start >/dev/null 2>&1 || true
  echo "Plugin installed/enabled and config refreshed."
}

bootstrap_openclaw() {
  bash "$ROOT_DIR/scripts/bootstrap_openclaw.sh" --dir "$ROOT_DIR" "$@"
}

run_interactive() {
  echo "Clawboard deploy menu"
  echo "1)  Up (start only, no build)"
  echo "2)  Rebuild (force recreate)"
  echo "3)  Fresh (tear down + rebuild all)"
  echo "4)  Down (stop)"
  echo "5)  Status"
  echo "6)  Logs"
  echo "7)  Run tests"
  echo "8)  Reset Clawboard data (wipes DB + vectors; OpenClaw untouched)"
  echo "9)  Load demo data"
  echo "10) Clear demo data"
  echo "11) Ensure skill installed"
  echo "12) Reset OpenClaw sessions (clears agent session history, keeps memories)"
  echo "13) Reset all fresh (Clawboard data + OpenClaw sessions/memories/crons; keeps qmd indexes)"
  echo "14) Cleanup orphaned tool logs (control-plane noise)"
  echo "15) Reconcile allocation guardrails (control-plane + tool traces)"
  echo "16) Verify production readiness"
  echo "17) Quit"
  read -r -p "Select an option: " choice

  case "$choice" in
    1)  up ;;
    2)  rebuild ;;
    3)  fresh ;;
    4)  down ;;
    5)  status ;;
    6)  logs ;;
    7)  run_tests ;;
    8)  reset_data ;;
    9)  demo_load ;;
    10) demo_clear ;;
    11) ensure_skill ;;
    12) reset_openclaw_sessions ;;
    13) reset_all_fresh ;;
    14) cleanup_orphan_tools ;;
    15) reconcile_allocation_guardrails ;;
    16) verify_production_ready ;;
    17) exit 0 ;;
    *) echo "Invalid choice"; exit 1 ;;
  esac
}

cmd="${1:-}"
case "$cmd" in
  up) shift; up "$@" ;;
  rebuild|build) shift; rebuild "$@" ;;
  fresh|rebuild-new) fresh ;;
  restart) shift; restart "$@" ;;
  down) down ;;
  nuke) shift; nuke "$@" ;;
  reset-data) shift; reset_data "$@" ;;
  reset-openclaw-sessions|reset_openclaw_sessions) shift; reset_openclaw_sessions "$@" ;;
  reset-all-fresh|reset_all_fresh) shift; reset_all_fresh "$@" ;;
  start-fresh-replay|start_fresh_replay) shift; start_fresh_replay "$@" ;;
  status) status ;;
  logs) shift; logs "$@" ;;
  pull) shift; pull "$@" ;;
  test) run_tests ;;
  demo-load) demo_load ;;
  demo-clear) demo_clear ;;
  cleanup-orphan-tools|cleanup_orphan_tools) shift; cleanup_orphan_tools "$@" ;;
  reconcile-allocation-guardrails|reconcile_allocation_guardrails) shift; reconcile_allocation_guardrails "$@" ;;
  verify-production-ready|verify_production_ready|verify) shift; verify_production_ready "$@" ;;
  token-show) token_show ;;
  token-be) shift; token_be "${1:-}" ;;
  token-fe) shift; token_fe "${1:-}" ;;
  token-both) shift; token_both "${1:-}" "${2:-}" ;;
  token-sync-fe) token_sync_fe ;;
  ensure-skill) ensure_skill ;;
  ensure-plugin) ensure_plugin ;;
  bootstrap) shift; bootstrap_openclaw "$@" ;;
  "") run_interactive ;;
  -h|--help) usage ;;
  *)
    echo "Unknown command: $cmd"
    usage
    exit 1
    ;;
  esac
