#!/usr/bin/env bash
set -euo pipefail

# Clawboard bootstrap: deploy Clawboard + install OpenClaw skill + logger plugin.
# Usage: bash scripts/bootstrap_openclaw.sh

USE_COLOR=true
for arg in "$@"; do
  if [ "$arg" == "--no-color" ]; then
    USE_COLOR=false
    break
  fi
done

if [ "$USE_COLOR" = true ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

log_info() { echo -e "${BLUE}info:${NC} $1"; }
log_success() { echo -e "${GREEN}success:${NC} $1"; }
log_warn() { echo -e "${YELLOW}warning:${NC} $1"; }
log_error() { echo -e "${RED}error:${NC} $1"; exit 1; }

REPO_URL="${CLAWBOARD_REPO_URL:-https://github.com/sirouk/clawboard}"

# Where to clone Clawboard.
#
# Back-compat: if ~/clawboard already exists, we stick with it.
# If the user has an OpenClaw workspace configured AND that workspace already uses a
# `projects/` (or `project/`) convention, prefer placing the repo there so installs
# live next to the user's agent workspace.
#
# Explicit overrides:
# - `--dir <path>` / `CLAWBOARD_DIR=<path>`
# - `CLAWBOARD_PARENT_DIR=<path>` (repo goes under `<path>/clawboard`)
detect_openclaw_workspace_root() {
  if [ -n "${OPENCLAW_WORKSPACE_DIR:-}" ]; then
    printf "%s" "${OPENCLAW_WORKSPACE_DIR}"
    return 0
  fi
  local cfg="$HOME/.openclaw/openclaw.json"
  if [ -f "$cfg" ] && command -v python3 >/dev/null 2>&1; then
    python3 - "$cfg" <<'PY' 2>/dev/null || true
import json, sys
path = sys.argv[1]
try:
  with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
except Exception:
  sys.exit(0)

# Newer configs: agents.defaults.workspace
ws = (((data.get("agents") or {}).get("defaults") or {}).get("workspace"))
if isinstance(ws, str) and ws.strip():
  print(ws.strip(), end="")
  sys.exit(0)

# Older configs: top-level workspace
ws = data.get("workspace")
if isinstance(ws, str) and ws.strip():
  print(ws.strip(), end="")
PY
  fi
}

DIR_EXPLICIT=false
if [ -n "${CLAWBOARD_DIR:-}" ]; then
  DIR_EXPLICIT=true
fi

PARENT_DIR_SET=false
if [ -n "${CLAWBOARD_PARENT_DIR:-}" ] && [ -z "${CLAWBOARD_DIR:-}" ]; then
  PARENT_DIR_SET=true
fi

DEFAULT_INSTALL_DIR="$HOME/clawboard"
DEFAULT_INSTALL_REASON="fallback"
if [ -z "${CLAWBOARD_DIR:-}" ]; then
  # If the legacy location already exists, stick with it.
  if [ -d "$HOME/clawboard/.git" ]; then
    DEFAULT_INSTALL_DIR="$HOME/clawboard"
    DEFAULT_INSTALL_REASON="existing ~/clawboard"
  elif [ -n "${CLAWBOARD_PARENT_DIR:-}" ]; then
    parent="${CLAWBOARD_PARENT_DIR%/}"
    if [ -n "$parent" ]; then
      DEFAULT_INSTALL_DIR="$parent/clawboard"
      DEFAULT_INSTALL_REASON="CLAWBOARD_PARENT_DIR"
    fi
  else
    ws="$(detect_openclaw_workspace_root || true)"
    ws="${ws//$'\r'/}"
    if [ -n "$ws" ] && [ -d "$ws" ]; then
      if [ -d "$ws/projects/clawboard/.git" ]; then
        DEFAULT_INSTALL_DIR="$ws/projects/clawboard"
        DEFAULT_INSTALL_REASON="existing workspace/projects/clawboard"
      elif [ -d "$ws/project/clawboard/.git" ]; then
        DEFAULT_INSTALL_DIR="$ws/project/clawboard"
        DEFAULT_INSTALL_REASON="existing workspace/project/clawboard"
      elif [ -d "$ws/projects" ]; then
        DEFAULT_INSTALL_DIR="$ws/projects/clawboard"
        DEFAULT_INSTALL_REASON="workspace/projects convention"
      elif [ -d "$ws/project" ]; then
        DEFAULT_INSTALL_DIR="$ws/project/clawboard"
        DEFAULT_INSTALL_REASON="workspace/project convention"
      fi
    fi
  fi
fi

INSTALL_DIR="${CLAWBOARD_DIR:-$DEFAULT_INSTALL_DIR}"
if [ -n "${CLAWBOARD_DIR:-}" ]; then
  INSTALL_DIR_REASON="CLAWBOARD_DIR"
else
  INSTALL_DIR_REASON="$DEFAULT_INSTALL_REASON"
fi
API_URL="${CLAWBOARD_API_URL:-http://localhost:8010}"
WEB_URL="${CLAWBOARD_WEB_URL:-http://localhost:3010}"
PUBLIC_API_BASE="${CLAWBOARD_PUBLIC_API_BASE:-}"
PUBLIC_WEB_URL="${CLAWBOARD_PUBLIC_WEB_URL:-}"
TOKEN="${CLAWBOARD_TOKEN:-}"
TITLE="${CLAWBOARD_TITLE:-Clawboard}"
INTEGRATION_LEVEL="${CLAWBOARD_INTEGRATION_LEVEL:-write}"
INTEGRATION_LEVEL_EXPLICIT=false
if [ -n "${CLAWBOARD_INTEGRATION_LEVEL:-}" ]; then
  INTEGRATION_LEVEL_EXPLICIT=true
fi
CHUTES_FAST_PATH_URL="${CHUTES_FAST_PATH_URL:-https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh}"
WEB_HOT_RELOAD_OVERRIDE=""
ALLOWED_DEV_ORIGINS_OVERRIDE=""
CONTEXT_MODE_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_MODE:-}"
CONTEXT_FALLBACK_MODE_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODE:-}"
CONTEXT_FETCH_TIMEOUT_MS_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS:-}"
CONTEXT_TOTAL_BUDGET_MS_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_TOTAL_BUDGET_MS:-}"
CONTEXT_MAX_CHARS_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS:-}"
SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="${CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS:-}"
SKILL_INSTALL_MODE="${CLAWBOARD_SKILL_INSTALL_MODE:-symlink}"
MEMORY_BACKUP_SETUP_MODE="${CLAWBOARD_MEMORY_BACKUP_SETUP:-ask}"

SKIP_DOCKER=false
SKIP_OPENCLAW=false
SKIP_SKILL=false
SKIP_PLUGIN=false
UPDATE_REPO=false
SKIP_CHUTES_PROMPT=false
INSTALL_CHUTES_IF_MISSING_OPENCLAW=false
PROMPT_ACCESS_URL=true
AUTO_DETECT_ACCESS_URL=true
ACCESS_API_URL=""
ACCESS_WEB_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; INSTALL_DIR_REASON="--dir"; DIR_EXPLICIT=true; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --web-url) WEB_URL="$2"; shift 2 ;;
    --public-api-base) PUBLIC_API_BASE="$2"; shift 2 ;;
    --public-web-url) PUBLIC_WEB_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --integration-level) INTEGRATION_LEVEL="$2"; INTEGRATION_LEVEL_EXPLICIT=true; shift 2 ;;
    --web-hot-reload) WEB_HOT_RELOAD_OVERRIDE="1"; shift ;;
    --no-web-hot-reload) WEB_HOT_RELOAD_OVERRIDE="0"; shift ;;
    --allowed-dev-origins) ALLOWED_DEV_ORIGINS_OVERRIDE="$2"; shift 2 ;;
    --context-mode) CONTEXT_MODE_OVERRIDE="$2"; shift 2 ;;
    --context-fallback-mode) CONTEXT_FALLBACK_MODE_OVERRIDE="$2"; shift 2 ;;
    --context-fetch-timeout-ms) CONTEXT_FETCH_TIMEOUT_MS_OVERRIDE="$2"; shift 2 ;;
    --context-total-budget-ms) CONTEXT_TOTAL_BUDGET_MS_OVERRIDE="$2"; shift 2 ;;
    --context-max-chars) CONTEXT_MAX_CHARS_OVERRIDE="$2"; shift 2 ;;
    --include-tool-call-logs) SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="1"; shift ;;
    --exclude-tool-call-logs) SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="0"; shift ;;
    --setup-memory-backup) MEMORY_BACKUP_SETUP_MODE="always"; shift ;;
    --skip-memory-backup-setup) MEMORY_BACKUP_SETUP_MODE="never"; shift ;;
    --skill-copy) SKILL_INSTALL_MODE="copy"; shift ;;
    --skill-symlink) SKILL_INSTALL_MODE="symlink"; shift ;;
    --update) UPDATE_REPO=true; shift ;;
    --skip-docker) SKIP_DOCKER=true; shift ;;
    --skip-openclaw) SKIP_OPENCLAW=true; shift ;;
    --skip-skill) SKIP_SKILL=true; shift ;;
    --skip-plugin) SKIP_PLUGIN=true; shift ;;
    --skip-chutes-prompt) SKIP_CHUTES_PROMPT=true; shift ;;
    --install-chutes-if-missing-openclaw) INSTALL_CHUTES_IF_MISSING_OPENCLAW=true; shift ;;
    --no-access-url-prompt) PROMPT_ACCESS_URL=false; shift ;;
    --no-access-url-detect) AUTO_DETECT_ACCESS_URL=false; shift ;;
    --no-backfill) INTEGRATION_LEVEL="manual"; INTEGRATION_LEVEL_EXPLICIT=true; shift ;;
    --no-color) shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: bash scripts/bootstrap_openclaw.sh [options]

Options:
  --dir <path>         Install directory (default: auto; prefers OpenClaw workspace projects/, else ~/clawboard)
Environment overrides:
  CLAWBOARD_DIR=<path>        Install directory (overrides everything)
  CLAWBOARD_PARENT_DIR=<path> Install parent directory (repo goes in <path>/clawboard)
  CLAWBOARD_SKILL_INSTALL_MODE=<copy|symlink>
                              Skill install strategy for ~/.openclaw/skills (default: symlink)
  CLAWBOARD_MEMORY_BACKUP_SETUP=<ask|always|never>
                              Offer/run memory+Clawboard backup setup during bootstrap (default: ask)
  --api-url <url>      Clawboard API base (default: http://localhost:8010)
  --web-url <url>      Clawboard web URL (default: http://localhost:3010)
  --public-api-base <url>
                       Browser-facing API base (used for web clients / NEXT_PUBLIC_CLAWBOARD_API_BASE)
  --public-web-url <url>
                       Browser-facing UI URL shown in output summary
  --token <token>      Use a specific CLAWBOARD_TOKEN
  --title <title>      Instance display name (default: Clawboard)
  --integration-level <manual|write|full>
                       Integration level for /api/config (default: write)
  --web-hot-reload     Enable dev web hot reload (sets CLAWBOARD_WEB_HOT_RELOAD=1)
  --no-web-hot-reload  Disable dev web hot reload (sets CLAWBOARD_WEB_HOT_RELOAD=0)
  --allowed-dev-origins <csv>
                       Extra allowed dev origins/hosts for Next dev server (writes CLAWBOARD_ALLOWED_DEV_ORIGINS)
  --context-mode <auto|cheap|full|patient>
                       Context retrieval mode for the OpenClaw clawboard-logger plugin (writes CLAWBOARD_LOGGER_CONTEXT_MODE)
  --context-fallback-mode <auto|cheap|full|patient>
                       Fallback context mode for the OpenClaw clawboard-logger plugin (writes CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODE)
  --context-fetch-timeout-ms <ms>
                       Per-request timeout for /api/context calls made by the OpenClaw plugin (writes CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS)
  --context-total-budget-ms <ms>
                       Total budget for before_agent_start context retrieval in the OpenClaw plugin (writes CLAWBOARD_LOGGER_CONTEXT_TOTAL_BUDGET_MS)
  --context-max-chars <n>
                       Hard cap for injected context block size (writes CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS)
  --include-tool-call-logs
                       Include tool call/result/error action logs in semantic indexing + retrieval
                       (writes CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS=1)
  --exclude-tool-call-logs
                       Exclude tool call/result/error action logs from semantic indexing + retrieval
                       (writes CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS=0; default)
  --setup-memory-backup
                      Run memory+Clawboard backup setup at the end of bootstrap (interactive)
  --skip-memory-backup-setup
                      Skip the memory+Clawboard backup setup prompt
  --skill-copy         Install skill by copying files into ~/.openclaw/skills
  --skill-symlink      Install skill as symlink to repo copy (default; best for local skill development)
  --no-backfill        Shortcut for --integration-level manual
  --update             Pull latest repo if already present
  --skip-docker        Skip docker compose up
  --skip-openclaw      Skip OpenClaw CLI steps
  --skip-skill         Skip skill install into ~/.openclaw/skills
  --skip-plugin        Skip installing logger plugin
  --skip-chutes-prompt Do not prompt to run Chutes fast path when openclaw is missing
  --install-chutes-if-missing-openclaw
                      Auto-run Chutes fast path if openclaw is missing
  --no-access-url-prompt
                      Do not prompt for public/domain access URLs
  --no-access-url-detect
                      Do not auto-detect Tailscale/local access URL defaults
  --no-color           Disable ANSI colors
USAGE
      exit 0
      ;;
    *) shift ;;
  esac
done

is_valid_integration_level() {
  case "$1" in
    manual|write|full) return 0 ;;
    *) return 1 ;;
  esac
}

if ! is_valid_integration_level "$INTEGRATION_LEVEL"; then
  log_error "Invalid integration level: $INTEGRATION_LEVEL (expected manual|write|full)"
fi

case "$SKILL_INSTALL_MODE" in
  copy|symlink) ;;
  *)
    log_warn "Invalid skill install mode: $SKILL_INSTALL_MODE (expected copy|symlink). Falling back to symlink."
    SKILL_INSTALL_MODE="symlink"
    ;;
esac

case "$(printf "%s" "$MEMORY_BACKUP_SETUP_MODE" | tr '[:upper:]' '[:lower:]')" in
  ask|always|never) MEMORY_BACKUP_SETUP_MODE="$(printf "%s" "$MEMORY_BACKUP_SETUP_MODE" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    log_warn "Invalid memory backup setup mode: $MEMORY_BACKUP_SETUP_MODE (expected ask|always|never). Using ask."
    MEMORY_BACKUP_SETUP_MODE="ask"
    ;;
esac

if [ "$INTEGRATION_LEVEL_EXPLICIT" = false ] && [ -t 0 ]; then
  echo ""
  echo "Choose integration level:"
  echo "  1) full   (backfill + live logging)"
  echo "  2) write  (live logging only)"
  echo "  3) manual (UI edits only)"
  printf "Select [1-3] (default: 2): "
  read -r INTEGRATION_CHOICE
  case "$INTEGRATION_CHOICE" in
    1) INTEGRATION_LEVEL="full" ;;
    2) INTEGRATION_LEVEL="write" ;;
    3) INTEGRATION_LEVEL="manual" ;;
    "") INTEGRATION_LEVEL="write" ;;
    *) log_warn "Unrecognized choice. Using default: write."; INTEGRATION_LEVEL="write" ;;
  esac
fi

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

read_env_value_from_file() {
  local file_path="$1"
  local key="$2"
  local line
  [ -f "$file_path" ] || return 1
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
  [ -n "$line" ] || return 1
  printf "%s" "$line"
}

is_valid_context_mode() {
  case "$1" in
    auto|cheap|full|patient) return 0 ;;
    *) return 1 ;;
  esac
}

is_positive_int() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

clamp_int() {
  local value="${1:-}"
  local min="${2:-0}"
  local max="${3:-2147483647}"
  if ! is_positive_int "$value"; then
    return 1
  fi
  if [ "$value" -lt "$min" ]; then
    echo "$min"
  elif [ "$value" -gt "$max" ]; then
    echo "$max"
  else
    echo "$value"
  fi
}

extract_url_host() {
  local url="$1"
  local raw="${url#*://}"
  raw="${raw%%/*}"
  raw="${raw#\[}"
  raw="${raw%\]}"
  echo "${raw%%:*}"
}

extract_url_port() {
  local url="$1"
  local fallback="$2"
  local raw="${url#*://}"
  raw="${raw%%/*}"
  if [[ "$raw" == *:* ]]; then
    local maybe="${raw##*:}"
    if [[ "$maybe" =~ ^[0-9]+$ ]]; then
      echo "$maybe"
      return
    fi
  fi
  if [[ "$url" =~ ^https:// ]]; then
    echo "443"
  else
    echo "$fallback"
  fi
}

is_local_host() {
  case "$1" in
    localhost|127.0.0.1|0.0.0.0|::1|"") return 0 ;;
    *) return 1 ;;
  esac
}

detect_tailscale_ipv4() {
  if ! command -v tailscale >/dev/null 2>&1; then
    return 1
  fi
  local ip
  ip="$(tailscale ip -4 2>/dev/null | head -n1 | tr -d '\r' | tr -d '[:space:]')"
  if [ -z "$ip" ]; then
    return 1
  fi
  echo "$ip"
}

configure_access_urls() {
  local api_port web_port api_host web_host tail_ip answer
  ACCESS_API_URL="$API_URL"
  ACCESS_WEB_URL="$WEB_URL"

  if [ -n "$PUBLIC_API_BASE" ]; then
    ACCESS_API_URL="$PUBLIC_API_BASE"
  fi
  if [ -n "$PUBLIC_WEB_URL" ]; then
    ACCESS_WEB_URL="$PUBLIC_WEB_URL"
  fi

  api_port="$(extract_url_port "$API_URL" "8010")"
  web_port="$(extract_url_port "$WEB_URL" "3010")"
  api_host="$(extract_url_host "$API_URL")"
  web_host="$(extract_url_host "$WEB_URL")"

  if [ "$AUTO_DETECT_ACCESS_URL" = true ]; then
    if tail_ip="$(detect_tailscale_ipv4)"; then
      if [ -z "$PUBLIC_API_BASE" ] && is_local_host "$api_host"; then
        ACCESS_API_URL="http://$tail_ip:$api_port"
      fi
      if [ -z "$PUBLIC_WEB_URL" ] && is_local_host "$web_host"; then
        ACCESS_WEB_URL="http://$tail_ip:$web_port"
      fi
    else
      if [ -z "$PUBLIC_API_BASE" ] && is_local_host "$api_host"; then
        ACCESS_API_URL="http://localhost:$api_port"
      fi
      if [ -z "$PUBLIC_WEB_URL" ] && is_local_host "$web_host"; then
        ACCESS_WEB_URL="http://localhost:$web_port"
      fi
    fi
  fi

  if [ "$PROMPT_ACCESS_URL" = true ] && [ -r /dev/tty ] && { [ -z "$PUBLIC_API_BASE" ] || [ -z "$PUBLIC_WEB_URL" ]; }; then
    printf "\nDetected access URLs:\n" > /dev/tty
    printf "  Web: %s\n" "$ACCESS_WEB_URL" > /dev/tty
    printf "  API: %s\n" "$ACCESS_API_URL" > /dev/tty
    printf "Use these URLs for browser access? [Y/n/custom]: " > /dev/tty
    read -r answer < /dev/tty
    case "$answer" in
      n|N|no|NO)
        if [ -z "$PUBLIC_WEB_URL" ]; then ACCESS_WEB_URL="$WEB_URL"; fi
        if [ -z "$PUBLIC_API_BASE" ]; then ACCESS_API_URL="$API_URL"; fi
        ;;
      c|C|custom|CUSTOM)
        if [ -z "$PUBLIC_WEB_URL" ]; then
          printf "Enter public Web URL (example https://clawboard.example.com): " > /dev/tty
          read -r ACCESS_WEB_URL < /dev/tty
        fi
        if [ -z "$PUBLIC_API_BASE" ]; then
          printf "Enter public API base URL (example https://api.example.com): " > /dev/tty
          read -r ACCESS_API_URL < /dev/tty
        fi
        ;;
      *)
        ;;
    esac
  fi

  ACCESS_API_URL="${ACCESS_API_URL//$'\r'/}"
  ACCESS_WEB_URL="${ACCESS_WEB_URL//$'\r'/}"
  if [ -z "${ACCESS_API_URL//[[:space:]]/}" ]; then
    ACCESS_API_URL="$API_URL"
  fi
  if [ -z "${ACCESS_WEB_URL//[[:space:]]/}" ]; then
    ACCESS_WEB_URL="$WEB_URL"
  fi
}

wait_for_api_health() {
  local health_url="${API_URL%/}/api/health"
  local max_attempts=45
  local attempt=1
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "curl not found. Skipping API readiness check."
    return 1
  fi
  while [ "$attempt" -le "$max_attempts" ]; do
    if curl -fsS "$health_url" >/dev/null 2>&1; then
      log_success "Clawboard API is reachable at $health_url."
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  log_warn "Clawboard API did not become ready in time: $health_url"
  return 1
}

maybe_run_chutes_fast_path() {
  local should_run=false
  local answer=""
  if [ "$INSTALL_CHUTES_IF_MISSING_OPENCLAW" = true ]; then
    should_run=true
  elif [ "$SKIP_CHUTES_PROMPT" = false ] && [ -r /dev/tty ]; then
    printf "\nOpenClaw CLI was not found.\n" > /dev/tty
    printf "If you want Chutes as provider, create an account first at https://chutes.ai\n" > /dev/tty
    printf "Run Chutes fast-path installer now? [y/N]: " > /dev/tty
    read -r answer < /dev/tty
    case "$answer" in
      y|Y|yes|YES) should_run=true ;;
      *) should_run=false ;;
    esac
  elif [ "$SKIP_CHUTES_PROMPT" = false ]; then
    log_warn "No interactive TTY for Chutes prompt. Use --install-chutes-if-missing-openclaw to auto-run it."
  fi

  if [ "$should_run" = false ]; then
    return 1
  fi

  local script_path=""
  local temp_script=""
  if command -v curl >/dev/null 2>&1; then
    temp_script="$(mktemp -t add-chutes.sh.XXXXXX)"
    if curl -fsSL "$CHUTES_FAST_PATH_URL" -o "$temp_script"; then
      chmod +x "$temp_script"
      script_path="$temp_script"
      log_info "Using remote Chutes installer: $CHUTES_FAST_PATH_URL"
    else
      log_warn "Failed to fetch remote Chutes installer. Will try local fallback."
      rm -f "$temp_script"
      temp_script=""
    fi
  fi

  if [ -z "$script_path" ] && [ -f "$INSTALL_DIR/inference-providers/add_chutes.sh" ]; then
    script_path="$INSTALL_DIR/inference-providers/add_chutes.sh"
    log_info "Using local Chutes installer: $script_path"
  fi

  if [ -z "$script_path" ]; then
    log_warn "Could not locate Chutes installer script."
    return 1
  fi

  if [ "$USE_COLOR" = false ]; then
    bash "$script_path" --no-color || log_warn "Chutes installer returned a non-zero status."
  else
    bash "$script_path" || log_warn "Chutes installer returned a non-zero status."
  fi

  if [ -n "$temp_script" ]; then
    rm -f "$temp_script"
  fi
  return 0
}

maybe_offer_memory_backup_setup() {
  local mode="${1:-ask}"
  local setup_script=""
  local answer=""
  local should_run=false

  case "$mode" in
    never) return 0 ;;
    always) should_run=true ;;
    ask)
      if [ ! -t 0 ]; then
        return 0
      fi
      printf "\nSet up automated continuity + Clawboard git backups now? [y/N]: "
      read -r answer
      case "$answer" in
        y|Y|yes|YES) should_run=true ;;
        *) should_run=false ;;
      esac
      ;;
    *)
      return 0
      ;;
  esac

  if [ "$should_run" = false ]; then
    return 0
  fi

  if [ -f "$HOME/.openclaw/skills/clawboard/scripts/setup-openclaw-memory-backup.sh" ]; then
    setup_script="$HOME/.openclaw/skills/clawboard/scripts/setup-openclaw-memory-backup.sh"
  elif [ -f "$INSTALL_DIR/skills/clawboard/scripts/setup-openclaw-memory-backup.sh" ]; then
    setup_script="$INSTALL_DIR/skills/clawboard/scripts/setup-openclaw-memory-backup.sh"
  fi

  if [ -z "$setup_script" ]; then
    log_warn "Memory backup setup script not found. Run manually when available."
    return 0
  fi

  log_info "Launching memory + Clawboard backup setup..."
  if bash "$setup_script"; then
    log_success "Memory + Clawboard backup setup completed."
  else
    log_warn "Memory + Clawboard backup setup did not complete. You can rerun: bash $setup_script"
  fi
}

if [ "$PARENT_DIR_SET" = true ]; then
  log_info "Install dir from CLAWBOARD_PARENT_DIR: $INSTALL_DIR"
elif [ "$DIR_EXPLICIT" = false ] && [ -n "${INSTALL_DIR_REASON:-}" ]; then
  log_info "Auto-selected install dir ($INSTALL_DIR_REASON): $INSTALL_DIR"
fi

log_info "Preparing Clawboard checkout in: $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  if [ "$UPDATE_REPO" = true ]; then
    git -C "$INSTALL_DIR" pull
  fi
else
  if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
    log_error "Install path exists and is not a directory: $INSTALL_DIR (use --dir to pick another path)"
  fi
  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
    log_error "Install directory exists but is not a git repo: $INSTALL_DIR (use --dir to pick an empty path)"
  fi
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

if [ -z "$TOKEN" ]; then
  if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_TOKEN" >/dev/null 2>&1; then
    TOKEN="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_TOKEN" || true)"
  fi
fi

if [ -z "$TOKEN" ]; then
  TOKEN="$(generate_token)"
fi

log_info "Writing CLAWBOARD_TOKEN in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_TOKEN" "$TOKEN"
configure_access_urls
log_info "Writing CLAWBOARD_PUBLIC_API_BASE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_PUBLIC_API_BASE" "$ACCESS_API_URL"
log_info "Writing CLAWBOARD_PUBLIC_WEB_URL in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_PUBLIC_WEB_URL" "$ACCESS_WEB_URL"

# Web hot reload (dev web service).
WEB_HOT_RELOAD_VALUE=""
if [ -n "$WEB_HOT_RELOAD_OVERRIDE" ]; then
  WEB_HOT_RELOAD_VALUE="$WEB_HOT_RELOAD_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_WEB_HOT_RELOAD" >/dev/null 2>&1; then
  WEB_HOT_RELOAD_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_WEB_HOT_RELOAD" || true)"
else
  if [ -t 0 ]; then
    echo ""
    echo "Enable Clawboard web hot reload (dev web service)?"
    echo "  1) yes (recommended for local dev)"
    echo "  2) no  (production-style web service)"
    printf "Select [1-2] (default: 1): "
    read -r WEB_HOT_RELOAD_CHOICE
    case "$WEB_HOT_RELOAD_CHOICE" in
      1|"") WEB_HOT_RELOAD_VALUE="1" ;;
      2) WEB_HOT_RELOAD_VALUE="0" ;;
      *) log_warn "Unrecognized choice. Using default: yes."; WEB_HOT_RELOAD_VALUE="1" ;;
    esac
  else
    WEB_HOT_RELOAD_VALUE="1"
  fi
fi
log_info "Writing CLAWBOARD_WEB_HOT_RELOAD=$WEB_HOT_RELOAD_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_WEB_HOT_RELOAD" "$WEB_HOT_RELOAD_VALUE"

# Extra allowed dev origins/hosts for Next dev server.
if [ -n "$ALLOWED_DEV_ORIGINS_OVERRIDE" ]; then
  log_info "Writing CLAWBOARD_ALLOWED_DEV_ORIGINS in $INSTALL_DIR/.env..."
  upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_ALLOWED_DEV_ORIGINS" "$ALLOWED_DEV_ORIGINS_OVERRIDE"
elif ! read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_ALLOWED_DEV_ORIGINS" >/dev/null 2>&1 && [ -t 0 ]; then
  echo ""
  echo "Optional: add extra allowed dev origins/hosts for the Next dev server."
  echo "Enter a comma-separated list (examples: https://my-host.ts.net:3010, my-mac-mini.local), or leave blank."
  printf "CLAWBOARD_ALLOWED_DEV_ORIGINS: "
  read -r ALLOWED_DEV_ORIGINS_INPUT
  ALLOWED_DEV_ORIGINS_INPUT="$(printf "%s" "$ALLOWED_DEV_ORIGINS_INPUT" | tr -d '\r')"
  if [ -n "$ALLOWED_DEV_ORIGINS_INPUT" ]; then
    upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_ALLOWED_DEV_ORIGINS" "$ALLOWED_DEV_ORIGINS_INPUT"
  fi
fi

# OpenClaw clawboard-logger context retrieval tuning (used for prompt augmentation).
#
# These values are stored in $INSTALL_DIR/.env for convenience, but are applied to OpenClaw
# via plugin config (plugins.entries.clawboard-logger.config.*) during bootstrap.
CONTEXT_MODE_VALUE=""
if [ -n "$CONTEXT_MODE_OVERRIDE" ]; then
  CONTEXT_MODE_VALUE="$CONTEXT_MODE_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_MODE" >/dev/null 2>&1; then
  CONTEXT_MODE_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_MODE" || true)"
else
  if [ -t 0 ]; then
    echo ""
    echo "OpenClaw logger context mode (controls /api/context retrieval before each agent run):"
    echo "  1) auto    (recommended; cheap by default, recalls when needed)"
    echo "  2) cheap   (fastest; no semantic recall)"
    echo "  3) full    (always semantic recall; can be slower)"
    echo "  4) patient (deep recall; longer timeouts; best for planning)"
    printf "Select [1-4] (default: 1): "
    read -r CONTEXT_MODE_CHOICE
    case "$CONTEXT_MODE_CHOICE" in
      1|"") CONTEXT_MODE_VALUE="auto" ;;
      2) CONTEXT_MODE_VALUE="cheap" ;;
      3) CONTEXT_MODE_VALUE="full" ;;
      4) CONTEXT_MODE_VALUE="patient" ;;
      *) log_warn "Unrecognized choice. Using default: auto."; CONTEXT_MODE_VALUE="auto" ;;
    esac
  else
    CONTEXT_MODE_VALUE="auto"
  fi
fi
CONTEXT_MODE_VALUE="$(printf "%s" "$CONTEXT_MODE_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
if ! is_valid_context_mode "$CONTEXT_MODE_VALUE"; then
  log_warn "Invalid CLAWBOARD_LOGGER_CONTEXT_MODE=$CONTEXT_MODE_VALUE. Using auto."
  CONTEXT_MODE_VALUE="auto"
fi
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_MODE=$CONTEXT_MODE_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_MODE" "$CONTEXT_MODE_VALUE"

DEFAULT_CONTEXT_FETCH_TIMEOUT_MS="1200"
DEFAULT_CONTEXT_TOTAL_BUDGET_MS="2200"
DEFAULT_CONTEXT_MAX_CHARS="2200"
DEFAULT_SEARCH_CONCURRENCY_LIMIT="2"
DEFAULT_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS="900"
DEFAULT_SEARCH_EMBED_QUERY_CACHE_SIZE="256"
DEFAULT_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS="2400"
case "$CONTEXT_MODE_VALUE" in
  full)
    DEFAULT_CONTEXT_FETCH_TIMEOUT_MS="2500"
    DEFAULT_CONTEXT_TOTAL_BUDGET_MS="4500"
    DEFAULT_CONTEXT_MAX_CHARS="3500"
    ;;
  patient)
    DEFAULT_CONTEXT_FETCH_TIMEOUT_MS="8000"
    DEFAULT_CONTEXT_TOTAL_BUDGET_MS="12000"
    DEFAULT_CONTEXT_MAX_CHARS="6000"
    ;;
esac

CONTEXT_FALLBACK_MODE_VALUE=""
if [ -n "$CONTEXT_FALLBACK_MODE_OVERRIDE" ]; then
  CONTEXT_FALLBACK_MODE_VALUE="$CONTEXT_FALLBACK_MODE_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODE" >/dev/null 2>&1; then
  CONTEXT_FALLBACK_MODE_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODE" || true)"
else
  CONTEXT_FALLBACK_MODE_VALUE="cheap"
fi
CONTEXT_FALLBACK_MODE_VALUE="$(printf "%s" "$CONTEXT_FALLBACK_MODE_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
if ! is_valid_context_mode "$CONTEXT_FALLBACK_MODE_VALUE"; then
  log_warn "Invalid CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODE=$CONTEXT_FALLBACK_MODE_VALUE. Using cheap."
  CONTEXT_FALLBACK_MODE_VALUE="cheap"
fi
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODE=$CONTEXT_FALLBACK_MODE_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODE" "$CONTEXT_FALLBACK_MODE_VALUE"

CONTEXT_FETCH_TIMEOUT_MS_VALUE=""
if [ -n "$CONTEXT_FETCH_TIMEOUT_MS_OVERRIDE" ]; then
  CONTEXT_FETCH_TIMEOUT_MS_VALUE="$CONTEXT_FETCH_TIMEOUT_MS_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS" >/dev/null 2>&1; then
  CONTEXT_FETCH_TIMEOUT_MS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS" || true)"
else
  CONTEXT_FETCH_TIMEOUT_MS_VALUE="$DEFAULT_CONTEXT_FETCH_TIMEOUT_MS"
fi
CONTEXT_FETCH_TIMEOUT_MS_VALUE="$(clamp_int "$CONTEXT_FETCH_TIMEOUT_MS_VALUE" 200 20000 || echo "$DEFAULT_CONTEXT_FETCH_TIMEOUT_MS")"
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS=$CONTEXT_FETCH_TIMEOUT_MS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS" "$CONTEXT_FETCH_TIMEOUT_MS_VALUE"

CONTEXT_TOTAL_BUDGET_MS_VALUE=""
if [ -n "$CONTEXT_TOTAL_BUDGET_MS_OVERRIDE" ]; then
  CONTEXT_TOTAL_BUDGET_MS_VALUE="$CONTEXT_TOTAL_BUDGET_MS_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_TOTAL_BUDGET_MS" >/dev/null 2>&1; then
  CONTEXT_TOTAL_BUDGET_MS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_TOTAL_BUDGET_MS" || true)"
else
  CONTEXT_TOTAL_BUDGET_MS_VALUE="$DEFAULT_CONTEXT_TOTAL_BUDGET_MS"
fi
CONTEXT_TOTAL_BUDGET_MS_VALUE="$(clamp_int "$CONTEXT_TOTAL_BUDGET_MS_VALUE" 400 45000 || echo "$DEFAULT_CONTEXT_TOTAL_BUDGET_MS")"
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_TOTAL_BUDGET_MS=$CONTEXT_TOTAL_BUDGET_MS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_TOTAL_BUDGET_MS" "$CONTEXT_TOTAL_BUDGET_MS_VALUE"

CONTEXT_MAX_CHARS_VALUE=""
if [ -n "$CONTEXT_MAX_CHARS_OVERRIDE" ]; then
  CONTEXT_MAX_CHARS_VALUE="$CONTEXT_MAX_CHARS_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS" >/dev/null 2>&1; then
  CONTEXT_MAX_CHARS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS" || true)"
else
  CONTEXT_MAX_CHARS_VALUE="$DEFAULT_CONTEXT_MAX_CHARS"
fi
CONTEXT_MAX_CHARS_VALUE="$(clamp_int "$CONTEXT_MAX_CHARS_VALUE" 400 12000 || echo "$DEFAULT_CONTEXT_MAX_CHARS")"
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS=$CONTEXT_MAX_CHARS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS" "$CONTEXT_MAX_CHARS_VALUE"

SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE=""
if [ -n "$SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE" ]; then
  SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE="$SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS" >/dev/null 2>&1; then
  SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS" || true)"
else
  SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE="0"
fi
SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE="$(printf "%s" "$SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
case "$SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE" in
  1|true|yes|on) SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE="1" ;;
  *) SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE="0" ;;
esac
log_info "Writing CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS=$SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS" "$SEARCH_INCLUDE_TOOL_CALL_LOGS_VALUE"

SEARCH_CONCURRENCY_LIMIT_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_CONCURRENCY_LIMIT" >/dev/null 2>&1; then
  SEARCH_CONCURRENCY_LIMIT_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_CONCURRENCY_LIMIT" || true)"
else
  SEARCH_CONCURRENCY_LIMIT_VALUE="$DEFAULT_SEARCH_CONCURRENCY_LIMIT"
fi
SEARCH_CONCURRENCY_LIMIT_VALUE="$(clamp_int "$SEARCH_CONCURRENCY_LIMIT_VALUE" 1 8 || echo "$DEFAULT_SEARCH_CONCURRENCY_LIMIT")"
log_info "Writing CLAWBOARD_SEARCH_CONCURRENCY_LIMIT=$SEARCH_CONCURRENCY_LIMIT_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_CONCURRENCY_LIMIT" "$SEARCH_CONCURRENCY_LIMIT_VALUE"

SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS" >/dev/null 2>&1; then
  SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS" || true)"
else
  SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS_VALUE="$DEFAULT_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS"
fi
SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS_VALUE="$(clamp_int "$SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS_VALUE" 200 5000 || echo "$DEFAULT_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS")"
log_info "Writing CLAWBOARD_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS=$SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS" "$SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS_VALUE"

SEARCH_EMBED_QUERY_CACHE_SIZE_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EMBED_QUERY_CACHE_SIZE" >/dev/null 2>&1; then
  SEARCH_EMBED_QUERY_CACHE_SIZE_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EMBED_QUERY_CACHE_SIZE" || true)"
else
  SEARCH_EMBED_QUERY_CACHE_SIZE_VALUE="$DEFAULT_SEARCH_EMBED_QUERY_CACHE_SIZE"
fi
SEARCH_EMBED_QUERY_CACHE_SIZE_VALUE="$(clamp_int "$SEARCH_EMBED_QUERY_CACHE_SIZE_VALUE" 0 4096 || echo "$DEFAULT_SEARCH_EMBED_QUERY_CACHE_SIZE")"
log_info "Writing CLAWBOARD_SEARCH_EMBED_QUERY_CACHE_SIZE=$SEARCH_EMBED_QUERY_CACHE_SIZE_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EMBED_QUERY_CACHE_SIZE" "$SEARCH_EMBED_QUERY_CACHE_SIZE_VALUE"

SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS" >/dev/null 2>&1; then
  SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS" || true)"
else
  SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS_VALUE="$DEFAULT_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS"
fi
SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS_VALUE="$(clamp_int "$SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS_VALUE" 800 50000 || echo "$DEFAULT_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS")"
log_info "Writing CLAWBOARD_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS=$SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS" "$SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS_VALUE"

chmod 600 "$INSTALL_DIR/.env" || true

if [ "$SKIP_DOCKER" = false ]; then
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$(uname -s)" = "Darwin" ]; then
      log_error "Docker is required. Install Docker Desktop for macOS first: https://www.docker.com/products/docker-desktop/"
    fi

    if ! command -v curl >/dev/null 2>&1; then
      log_error "Docker is required and curl is missing. Install curl, then re-run."
    fi

    log_warn "Docker not found. Installing via get.docker.com..."
    INSTALLER="$(mktemp -t install-docker.sh.XXXXXX)"
    curl -fsSL https://get.docker.com -o "$INSTALLER"
    chmod +x "$INSTALLER"
    if [ "$(id -u)" -eq 0 ]; then
      sh "$INSTALLER"
    elif command -v sudo >/dev/null 2>&1; then
      sudo sh "$INSTALLER"
    else
      log_error "Docker install requires root privileges. Please install Docker manually."
    fi
    rm -f "$INSTALLER"

    if ! command -v docker >/dev/null 2>&1; then
      log_error "Docker install did not complete successfully. Please install manually."
    fi
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  else
    log_error "Docker Compose not found. Install docker compose v2 or docker-compose."
  fi

  log_info "Starting Clawboard via docker compose..."
  WEB_HOT_RELOAD="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_WEB_HOT_RELOAD" || true)"
  case "$WEB_HOT_RELOAD" in
    1|true|TRUE|yes|YES)
      # Avoid port conflicts: stop the production web service if it is running.
      (cd "$INSTALL_DIR" && $COMPOSE stop web >/dev/null 2>&1 || true)
      (cd "$INSTALL_DIR" && $COMPOSE rm -f web >/dev/null 2>&1 || true)
      (cd "$INSTALL_DIR" && $COMPOSE --profile dev up -d --build api classifier qdrant web-dev)
      ;;
    *)
      # Avoid port conflicts: stop the dev web service if it is running.
      (cd "$INSTALL_DIR" && $COMPOSE stop web-dev >/dev/null 2>&1 || true)
      (cd "$INSTALL_DIR" && $COMPOSE rm -f web-dev >/dev/null 2>&1 || true)
      (cd "$INSTALL_DIR" && $COMPOSE up -d --build)
      ;;
  esac
  log_success "Clawboard services running."
fi

if command -v curl >/dev/null 2>&1; then
  if wait_for_api_health; then
    log_info "Configuring Clawboard instance..."
    CONFIG_PAYLOAD=$(printf '{"title":"%s","integrationLevel":"%s"}' "$TITLE" "$INTEGRATION_LEVEL")
    CURL_ARGS=(-sS -X POST "$API_URL/api/config" -H "Content-Type: application/json" -d "$CONFIG_PAYLOAD")
    if [ -n "$TOKEN" ]; then
      CURL_ARGS+=(-H "X-Clawboard-Token: $TOKEN")
    fi
    if ! curl "${CURL_ARGS[@]}" >/dev/null 2>&1; then
      log_warn "Unable to update /api/config (check API URL and token)."
    else
      log_success "Clawboard config set: title=$TITLE, integrationLevel=$INTEGRATION_LEVEL."
    fi
  else
    log_warn "Skipping /api/config update until API is reachable."
  fi
else
  log_warn "curl not found. Skipping /api/config update."
fi

if [ "$SKIP_OPENCLAW" = false ]; then
  if ! command -v openclaw >/dev/null 2>&1; then
    log_warn "openclaw CLI not found."
    maybe_run_chutes_fast_path || true
  fi

  if ! command -v openclaw >/dev/null 2>&1; then
    log_warn "OpenClaw is still unavailable. Skipping skill/plugin setup."
  else
    OPENCLAW_GATEWAY_RESTART_NEEDED=false

    log_info "Enabling OpenClaw OpenResponses endpoint (POST /v1/responses)..."
    CURRENT_RESPONSES_ENABLED="$(openclaw config get gateway.http.endpoints.responses.enabled 2>/dev/null || true)"
    CURRENT_RESPONSES_ENABLED="$(printf "%s" "$CURRENT_RESPONSES_ENABLED" | tr -d '\r' | tail -n1 | tr -d '[:space:]')"
    if [ "$CURRENT_RESPONSES_ENABLED" != "true" ]; then
      if openclaw config set gateway.http.endpoints.responses.enabled --json true >/dev/null 2>&1; then
        OPENCLAW_GATEWAY_RESTART_NEEDED=true
        log_success "OpenResponses endpoint enabled."
      else
        log_warn "Failed to enable OpenResponses endpoint. You can run: openclaw config set gateway.http.endpoints.responses.enabled --json true"
      fi
    else
      log_success "OpenResponses endpoint already enabled."
    fi

    if [ "$SKIP_SKILL" = false ]; then
      log_info "Installing Clawboard skill (mode: $SKILL_INSTALL_MODE)..."
      SKILL_REPO_SRC="$INSTALL_DIR/skills/clawboard"
      SKILL_OPENCLAW_DST="$HOME/.openclaw/skills/clawboard"
      LOGGER_SKILL_REPO_SRC="$INSTALL_DIR/skills/clawboard-logger"
      LOGGER_SKILL_OPENCLAW_DST="$HOME/.openclaw/skills/clawboard-logger"

      if [ ! -d "$SKILL_REPO_SRC" ]; then
        log_warn "Repo skill directory not found: $SKILL_REPO_SRC"
      else
        mkdir -p "$HOME/.openclaw/skills"
        rm -rf "$SKILL_OPENCLAW_DST"
        if [ "$SKILL_INSTALL_MODE" = "symlink" ]; then
          ln -s "$SKILL_REPO_SRC" "$SKILL_OPENCLAW_DST"
          log_success "Skill linked: ~/.openclaw/skills/clawboard -> $SKILL_REPO_SRC"
        else
          cp -R "$SKILL_REPO_SRC" "$SKILL_OPENCLAW_DST"
          log_success "Skill installed to ~/.openclaw/skills/clawboard."
        fi
      fi

      if [ "$SKILL_INSTALL_MODE" = "copy" ]; then
        log_warn "Using copy mode for skills. Repo edits will not appear in OpenClaw until synced/copied again."
      fi

      if [ -d "$LOGGER_SKILL_REPO_SRC" ]; then
        rm -rf "$LOGGER_SKILL_OPENCLAW_DST"
        if [ "$SKILL_INSTALL_MODE" = "symlink" ]; then
          ln -s "$LOGGER_SKILL_REPO_SRC" "$LOGGER_SKILL_OPENCLAW_DST"
          log_success "Logger skill linked: ~/.openclaw/skills/clawboard-logger -> $LOGGER_SKILL_REPO_SRC"
        else
          cp -R "$LOGGER_SKILL_REPO_SRC" "$LOGGER_SKILL_OPENCLAW_DST"
          log_success "Logger skill installed to ~/.openclaw/skills/clawboard-logger."
        fi
      elif [ -e "$LOGGER_SKILL_OPENCLAW_DST" ]; then
        log_warn "Found ~/.openclaw/skills/clawboard-logger, but repo copy is missing at $LOGGER_SKILL_REPO_SRC (left unchanged)."
      fi
    fi

    # Harden OpenClaw cron jobs created by the Clawboard skill so they don't inject "cron-event"
    # messages into active chats (these messages can interrupt streaming and pollute routing).
    # Best-effort: patch any existing cron jobs that run the memory backup script.
    if command -v python3 >/dev/null 2>&1; then
      log_info "Hardening OpenClaw cron delivery (disable announce for Clawboard memory backup jobs)..."
      CRON_PATCH_IDS="$(python3 - <<'PY'
import json
import subprocess
import sys

needle = "backup_openclaw_curated_memories.sh"

try:
  raw = subprocess.check_output(["openclaw", "cron", "list", "--json"], stderr=subprocess.DEVNULL)
  data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
except Exception:
  print("", end="")
  sys.exit(0)

jobs = data.get("jobs") if isinstance(data, dict) else []
jobs = jobs or []
ids: list[str] = []

for j in jobs:
  if not isinstance(j, dict):
    continue
  if str(j.get("sessionTarget") or "").strip() != "isolated":
    continue
  payload = j.get("payload") if isinstance(j.get("payload"), dict) else {}
  msg = str(payload.get("message") or "")
  if needle not in msg:
    continue
  delivery = j.get("delivery") if isinstance(j.get("delivery"), dict) else {}
  mode = str(delivery.get("mode") or "").strip().lower()
  # Missing delivery means OpenClaw will default to announce for isolated agentTurn jobs.
  if mode == "none":
    continue
  job_id = str(j.get("id") or j.get("jobId") or "").strip()
  if job_id:
    ids.append(job_id)

print(" ".join(ids), end="")
PY
)"
      if [ -n "${CRON_PATCH_IDS:-}" ]; then
        for id in $CRON_PATCH_IDS; do
          if openclaw cron edit "$id" --no-deliver >/dev/null 2>&1; then
            log_success "Cron job updated: $id (delivery=none)."
          else
            log_warn "Failed to update cron job delivery for: $id"
          fi
        done
      else
        log_success "No memory-backup cron jobs needed delivery changes."
      fi
    else
      log_warn "python3 not found; skipping cron hardening step."
    fi

    if [ "$SKIP_PLUGIN" = false ]; then
      log_info "Installing Clawboard logger plugin..."
      openclaw plugins install -l "$INSTALL_DIR/extensions/clawboard-logger"
      openclaw plugins enable clawboard-logger

      log_info "Configuring logger plugin..."
      if [ -n "$TOKEN" ]; then
        CONFIG_JSON=$(printf '{"baseUrl":"%s","token":"%s","enabled":true,"contextMode":"%s","contextFallbackMode":"%s","contextFetchTimeoutMs":%s,"contextTotalBudgetMs":%s,"contextMaxChars":%s}' "$API_URL" "$TOKEN" "$CONTEXT_MODE_VALUE" "$CONTEXT_FALLBACK_MODE_VALUE" "$CONTEXT_FETCH_TIMEOUT_MS_VALUE" "$CONTEXT_TOTAL_BUDGET_MS_VALUE" "$CONTEXT_MAX_CHARS_VALUE")
      else
        CONFIG_JSON=$(printf '{"baseUrl":"%s","enabled":true,"contextMode":"%s","contextFallbackMode":"%s","contextFetchTimeoutMs":%s,"contextTotalBudgetMs":%s,"contextMaxChars":%s}' "$API_URL" "$CONTEXT_MODE_VALUE" "$CONTEXT_FALLBACK_MODE_VALUE" "$CONTEXT_FETCH_TIMEOUT_MS_VALUE" "$CONTEXT_TOTAL_BUDGET_MS_VALUE" "$CONTEXT_MAX_CHARS_VALUE")
      fi
      openclaw config set plugins.entries.clawboard-logger.config --json "$CONFIG_JSON" >/dev/null 2>&1 || true
      openclaw config set plugins.entries.clawboard-logger.enabled --json true >/dev/null 2>&1 || true
      OPENCLAW_GATEWAY_RESTART_NEEDED=true
      log_success "Logger plugin installed and enabled."
    fi

    if [ "$OPENCLAW_GATEWAY_RESTART_NEEDED" = true ]; then
      log_info "Restarting OpenClaw gateway to apply configuration..."
      if openclaw gateway restart >/dev/null 2>&1; then
        log_success "OpenClaw gateway restarted."
      elif openclaw gateway start >/dev/null 2>&1; then
        log_success "OpenClaw gateway started."
      else
        log_warn "Unable to restart OpenClaw gateway automatically. Run: openclaw gateway restart"
      fi
    fi

    maybe_offer_memory_backup_setup "$MEMORY_BACKUP_SETUP_MODE"
  fi
fi

echo ""
log_success "Bootstrap complete."
echo "Clawboard UI (access):   $ACCESS_WEB_URL"
echo "Clawboard API (access):  ${ACCESS_API_URL%/}/docs"
echo "Clawboard API (internal): $API_URL"
MASKED_TOKEN="(not set)"
if [ -n "${TOKEN:-}" ]; then
  if [ "${#TOKEN}" -le 10 ]; then
    MASKED_TOKEN="<set>"
  else
    first6="${TOKEN:0:6}"
    last4="$(printf "%s" "$TOKEN" | tail -c 4 || true)"
    MASKED_TOKEN="${first6}...${last4}"
  fi
fi
echo "Token:         $MASKED_TOKEN"
echo "Security note: CLAWBOARD_TOKEN is required for all writes and non-localhost reads."
echo "               Localhost reads can run tokenless. Keep network ACLs strict (no Funnel/public exposure)."
echo ""
echo "If OpenClaw was not installed, run this later:"
echo "  bash scripts/bootstrap_openclaw.sh --skip-docker --update"
echo "Set up automated continuity + Clawboard backups:"
echo "  bash ~/.openclaw/skills/clawboard/scripts/setup-openclaw-memory-backup.sh"
echo "If you want Chutes before Clawboard skill wiring:"
echo "  tmp=\$(mktemp -t add-chutes.sh.XXXXXX) && curl -fsSL $CHUTES_FAST_PATH_URL -o \"\$tmp\" && bash \"\$tmp\" && rm -f \"\$tmp\""
