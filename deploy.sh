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
  start-fresh-replay [--yes]           One-time: clear topics/tasks, reset classifier, wipe vectors, restart
  status                               Show container status
  logs [service]                       Tail logs
  pull [service]                       Pull images (if using registry images)
  test                                 Run full test suite (npm run test:all)
  demo-load                            Load demo data into the API database
  demo-clear                           Clear API data via seed helper

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
  cfg_path="$(_oc_config_path)"
  [ -n "$cfg_path" ] && command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$cfg_path" <<'PY'
import sys, json, os
cfg_path = sys.argv[1]
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(0)
printed = []
# Per-agent workspace/memory (daily long-term memories)
for a in cfg.get("agents", {}).get("list", []):
    if not isinstance(a, dict):
        continue
    ws = str(a.get("workspace", "") or "").strip()
    aid = str(a.get("id", "") or "").strip()
    if ws:
        mem = os.path.join(ws, "memory")
        printed.append(f"  {mem}  [{aid} long-term memories]")
# QMD vault paths
for p in cfg.get("memory", {}).get("qmd", {}).get("paths", []):
    if isinstance(p, dict) and p.get("path"):
        label = str(p.get("name", "")).strip() or "qmd"
        printed.append(f"  {p['path']}  [QMD vault: {label}]")
# agent/ credential dirs
for a in cfg.get("agents", {}).get("list", []):
    if not isinstance(a, dict):
        continue
    aid = str(a.get("id", "") or "").strip()
    if aid:
        printed.append(f"  <oc_home>/agents/{aid}/agent/  [credentials + model config]")
        printed.append(f"  <oc_home>/agents/{aid}/qmd/    [QMD vector index]")
for line in printed:
    print(line)
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
  echo "Clawboard data reset complete. OpenClaw data was not touched."
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
    count=$(find "$sessions_dir" -maxdepth 1 \( -name "*.jsonl" -o -name "*.jsonl.deleted.*" \) 2>/dev/null | wc -l | tr -d ' ')

    # Active and soft-deleted session files
    find "$sessions_dir" -maxdepth 1 -name "*.jsonl"            -delete 2>/dev/null || true
    find "$sessions_dir" -maxdepth 1 -name "*.jsonl.deleted.*"  -delete 2>/dev/null || true
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
  if [ -z "$api_base" ]; then
    api_base="http://localhost:8010"
  fi

  openclaw plugins install -l "$plugin_path"
  openclaw plugins enable clawboard-logger

  if [ -n "$token" ]; then
    CONFIG_JSON=$(printf '{"baseUrl":"%s","token":"%s","enabled":true}' "$api_base" "$token")
  else
    CONFIG_JSON=$(printf '{"baseUrl":"%s","enabled":true}' "$api_base")
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
  echo "13) Quit"
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
    13) exit 0 ;;
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
  start-fresh-replay|start_fresh_replay) shift; start_fresh_replay "$@" ;;
  status) status ;;
  logs) shift; logs "$@" ;;
  pull) shift; pull "$@" ;;
  test) run_tests ;;
  demo-load) demo_load ;;
  demo-clear) demo_clear ;;
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
