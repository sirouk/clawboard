#!/usr/bin/env bash
set -euo pipefail

# Clawboard bootstrap: deploy Clawboard + install OpenClaw skill + logger plugin.
# Usage: bash scripts/bootstrap_clawboard.sh

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
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
if [ "$OPENCLAW_HOME" != "/" ]; then
  OPENCLAW_HOME="${OPENCLAW_HOME%/}"
fi
OPENCLAW_CONFIG_PATH="$OPENCLAW_HOME/openclaw.json"
OPENCLAW_SKILLS_DIR="$OPENCLAW_HOME/skills"

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
resolve_default_openclaw_workspace_root() {
  local profile="${OPENCLAW_PROFILE:-}"
  local profile_lc
  profile_lc="$(printf "%s" "$profile" | tr '[:upper:]' '[:lower:]')"
  if [ -n "$profile" ] && [ "$profile_lc" != "default" ]; then
    printf "%s" "$OPENCLAW_HOME/workspace-$profile"
  else
    printf "%s" "$OPENCLAW_HOME/workspace"
  fi
}

detect_openclaw_workspace_root() {
  if [ -n "${OPENCLAW_WORKSPACE_DIR:-}" ]; then
    printf "%s" "${OPENCLAW_WORKSPACE_DIR}"
    return 0
  fi
  local cfg="$OPENCLAW_CONFIG_PATH"
  if [ -f "$cfg" ] && command -v python3 >/dev/null 2>&1; then
    python3 - "$cfg" <<'PY' 2>/dev/null || true
import json, sys
path = sys.argv[1]
try:
  with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
except Exception:
  sys.exit(0)

# Resolve default agent id (mirrors OpenClaw behavior).
agents = ((data.get("agents") or {}).get("list") or [])
entries = [entry for entry in agents if isinstance(entry, dict)]
default_entries = [entry for entry in entries if entry.get("default") is True]
default_entry = default_entries[0] if default_entries else (entries[0] if entries else {})
default_id = str(default_entry.get("id") or "main").strip().lower() if isinstance(default_entry, dict) else "main"

# Prefer explicit main agent workspace if present.
main_entry = next((entry for entry in entries if str(entry.get("id") or "").strip().lower() == "main"), None)
chosen_entry = main_entry if isinstance(main_entry, dict) else default_entry
chosen_id = str((chosen_entry or {}).get("id") or default_id).strip().lower()

ws = ""
if isinstance(chosen_entry, dict):
  candidate = chosen_entry.get("workspace")
  if isinstance(candidate, str) and candidate.strip():
    ws = candidate.strip()

# Newer configs: agents.defaults.workspace (for default agent when unset at agent level)
if not ws and chosen_id == default_id:
  candidate = (((data.get("agents") or {}).get("defaults") or {}).get("workspace"))
  if isinstance(candidate, str) and candidate.strip():
    ws = candidate.strip()

# Older configs: top-level workspace
if not ws:
  candidate = data.get("workspace")
  if isinstance(candidate, str) and candidate.strip():
    ws = candidate.strip()

if ws:
  print(ws, end="")
PY
  fi
}

ensure_openclaw_workspace_root_configured() {
  if [ -n "${OPENCLAW_WORKSPACE_DIR:-}" ]; then
    return 0
  fi

  local ws fallback
  ws="$(detect_openclaw_workspace_root || true)"
  ws="${ws//$'\r'/}"

  if [ -n "$ws" ]; then
    OPENCLAW_WORKSPACE_DIR="$ws"
    return 0
  fi

  fallback="$(resolve_default_openclaw_workspace_root)"
  OPENCLAW_WORKSPACE_DIR="$fallback"
  log_info "No OpenClaw workspace configured; defaulting to $fallback"

  if ! command -v openclaw >/dev/null 2>&1; then
    log_warn "openclaw CLI not found; set agents.defaults.workspace manually if needed."
    return 0
  fi

  # Keep workspace explicit for bootstrap auto-detection and consistency.
  if openclaw config set agents.defaults.workspace "$fallback" >/dev/null 2>&1; then
    log_success "Configured OpenClaw workspace: agents.defaults.workspace=$fallback"
  else
    log_warn "Failed to persist agents.defaults.workspace via openclaw config set."
  fi
}

ensure_openclaw_workspace_root_configured

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
OPENCLAW_BASE_URL_VALUE="${OPENCLAW_BASE_URL:-}"
TOKEN="${CLAWBOARD_TOKEN:-}"
TITLE="${CLAWBOARD_TITLE:-Clawboard}"
INTEGRATION_LEVEL="${CLAWBOARD_INTEGRATION_LEVEL:-write}"
INTEGRATION_LEVEL_EXPLICIT=false
if [ -n "${CLAWBOARD_INTEGRATION_LEVEL:-}" ]; then
  INTEGRATION_LEVEL_EXPLICIT=true
fi
API_URL_EXPLICIT=false
WEB_URL_EXPLICIT=false
PUBLIC_API_BASE_EXPLICIT=false
PUBLIC_WEB_URL_EXPLICIT=false
OPENCLAW_BASE_URL_EXPLICIT=false
if [ -n "${CLAWBOARD_API_URL+x}" ]; then
  API_URL_EXPLICIT=true
fi
if [ -n "${CLAWBOARD_WEB_URL+x}" ]; then
  WEB_URL_EXPLICIT=true
fi
if [ -n "${CLAWBOARD_PUBLIC_API_BASE+x}" ]; then
  PUBLIC_API_BASE_EXPLICIT=true
fi
if [ -n "${CLAWBOARD_PUBLIC_WEB_URL+x}" ]; then
  PUBLIC_WEB_URL_EXPLICIT=true
fi
if [ -n "${OPENCLAW_BASE_URL+x}" ]; then
  OPENCLAW_BASE_URL_EXPLICIT=true
fi
CHUTES_FAST_PATH_URL="${CHUTES_FAST_PATH_URL:-https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh}"
WEB_HOT_RELOAD_OVERRIDE=""
ALLOWED_DEV_ORIGINS_OVERRIDE=""
CONTEXT_MODE_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_MODE:-}"
CONTEXT_FETCH_TIMEOUT_MS_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS:-}"
CONTEXT_MAX_CHARS_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS:-}"
SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="${CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS:-}"
SKILL_INSTALL_MODE="${CLAWBOARD_SKILL_INSTALL_MODE:-symlink}"
MEMORY_BACKUP_SETUP_MODE="${CLAWBOARD_MEMORY_BACKUP_SETUP:-ask}"
MEMORY_BACKUP_SETUP_STATUS="not-run"
MEMORY_BACKUP_SETUP_SCRIPT=""
OBSIDIAN_MEMORY_SETUP_MODE="${CLAWBOARD_OBSIDIAN_MEMORY_SETUP:-ask}"
OBSIDIAN_MEMORY_SETUP_STATUS="not-run"
OBSIDIAN_BRAIN_SETUP_SCRIPT=""
LOCAL_MEMORY_SETUP_SCRIPT=""
OPENCLAW_HEAP_SETUP_MODE="${CLAWBOARD_OPENCLAW_HEAP_SETUP:-ask}"
OPENCLAW_HEAP_SETUP_STATUS="not-run"
OPENCLAW_HEAP_TARGET=""
OPENCLAW_HEAP_MB="${CLAWBOARD_OPENCLAW_MAX_OLD_SPACE_MB:-6144}"

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
ENV_WIZARD_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || log_error "--dir requires a value"
      INSTALL_DIR="$2"; INSTALL_DIR_REASON="--dir"; DIR_EXPLICIT=true; shift 2
      ;;
    --api-url)
      [ $# -ge 2 ] || log_error "--api-url requires a value"
      API_URL="$2"; API_URL_EXPLICIT=true; shift 2
      ;;
    --web-url)
      [ $# -ge 2 ] || log_error "--web-url requires a value"
      WEB_URL="$2"; WEB_URL_EXPLICIT=true; shift 2
      ;;
    --public-api-base)
      [ $# -ge 2 ] || log_error "--public-api-base requires a value"
      PUBLIC_API_BASE="$2"; PUBLIC_API_BASE_EXPLICIT=true; shift 2
      ;;
    --public-web-url)
      [ $# -ge 2 ] || log_error "--public-web-url requires a value"
      PUBLIC_WEB_URL="$2"; PUBLIC_WEB_URL_EXPLICIT=true; shift 2
      ;;
    --openclaw-base-url)
      [ $# -ge 2 ] || log_error "--openclaw-base-url requires a value"
      OPENCLAW_BASE_URL_VALUE="$2"; OPENCLAW_BASE_URL_EXPLICIT=true; shift 2
      ;;
    --token)
      [ $# -ge 2 ] || log_error "--token requires a value"
      TOKEN="$2"; shift 2
      ;;
    --title)
      [ $# -ge 2 ] || log_error "--title requires a value"
      TITLE="$2"; shift 2
      ;;
    --integration-level)
      [ $# -ge 2 ] || log_error "--integration-level requires a value"
      INTEGRATION_LEVEL="$2"; INTEGRATION_LEVEL_EXPLICIT=true; shift 2
      ;;
    --web-hot-reload) WEB_HOT_RELOAD_OVERRIDE="1"; shift ;;
    --no-web-hot-reload) WEB_HOT_RELOAD_OVERRIDE="0"; shift ;;
    --allowed-dev-origins)
      [ $# -ge 2 ] || log_error "--allowed-dev-origins requires a value"
      ALLOWED_DEV_ORIGINS_OVERRIDE="$2"; shift 2
      ;;
    --context-mode)
      [ $# -ge 2 ] || log_error "--context-mode requires a value"
      CONTEXT_MODE_OVERRIDE="$2"; shift 2
      ;;
    --context-fetch-timeout-ms)
      [ $# -ge 2 ] || log_error "--context-fetch-timeout-ms requires a value"
      CONTEXT_FETCH_TIMEOUT_MS_OVERRIDE="$2"; shift 2
      ;;
    --context-max-chars)
      [ $# -ge 2 ] || log_error "--context-max-chars requires a value"
      CONTEXT_MAX_CHARS_OVERRIDE="$2"; shift 2
      ;;
    --include-tool-call-logs) SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="1"; shift ;;
    --exclude-tool-call-logs) SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="0"; shift ;;
    --setup-memory-backup) MEMORY_BACKUP_SETUP_MODE="always"; shift ;;
    --skip-memory-backup-setup) MEMORY_BACKUP_SETUP_MODE="never"; shift ;;
    --setup-obsidian-memory) OBSIDIAN_MEMORY_SETUP_MODE="always"; shift ;;
    --skip-obsidian-memory-setup) OBSIDIAN_MEMORY_SETUP_MODE="never"; shift ;;
    --setup-openclaw-heap) OPENCLAW_HEAP_SETUP_MODE="always"; shift ;;
    --skip-openclaw-heap-setup) OPENCLAW_HEAP_SETUP_MODE="never"; shift ;;
    --openclaw-max-old-space-mb)
      [ $# -ge 2 ] || log_error "--openclaw-max-old-space-mb requires a value"
      OPENCLAW_HEAP_MB="$2"; shift 2
      ;;
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
    --env-wizard) ENV_WIZARD_OVERRIDE="1"; shift ;;
    --no-env-wizard) ENV_WIZARD_OVERRIDE="0"; shift ;;
    --no-backfill) INTEGRATION_LEVEL="manual"; INTEGRATION_LEVEL_EXPLICIT=true; shift ;;
    --no-color) shift ;;
    -h|--help)
      cat <<USAGE
Usage: bash scripts/bootstrap_clawboard.sh [options]

Options:
  --dir <path>         Install directory (default: auto; prefers OpenClaw workspace projects/, else ~/clawboard)
Environment overrides:
  CLAWBOARD_DIR=<path>        Install directory (overrides everything)
  CLAWBOARD_PARENT_DIR=<path> Install parent directory (repo goes in <path>/clawboard)
  OPENCLAW_HOME=<path>        OpenClaw home directory (default: ~/.openclaw)
  CLAWBOARD_SKILL_INSTALL_MODE=<copy|symlink>
                              Skill install strategy for \$OPENCLAW_HOME/skills (default: symlink)
  CLAWBOARD_MEMORY_BACKUP_SETUP=<ask|always|never>
                              Offer/run memory+Clawboard backup setup during bootstrap (default: ask)
  CLAWBOARD_OBSIDIAN_MEMORY_SETUP=<ask|always|never>
                              Offer/run Obsidian + memory tuning setup during bootstrap (default: ask)
  CLAWBOARD_OPENCLAW_HEAP_SETUP=<ask|always|never>
                              Offer/run OpenClaw launcher heap tuning at bootstrap end (default: ask)
  CLAWBOARD_OPENCLAW_MAX_OLD_SPACE_MB=<int>
                              Heap size for launcher patch (default: 6144)
  CLAWBOARD_ENV_WIZARD=<0|1>  Force disable/enable interactive .env connection wizard
  --api-url <url>      Clawboard API base (default: http://localhost:8010)
  --web-url <url>      Clawboard web URL (default: http://localhost:3010)
  --public-api-base <url>
                       Browser-facing API base (used for web clients / NEXT_PUBLIC_CLAWBOARD_API_BASE)
  --public-web-url <url>
                       Browser-facing UI URL shown in output summary
  --openclaw-base-url <url>
                       OpenClaw gateway URL used by classifier (writes OPENCLAW_BASE_URL)
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
  --context-fetch-timeout-ms <ms>
                       Per-request timeout for /api/context calls made by the OpenClaw plugin (writes CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS)
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
  --setup-obsidian-memory
                      Run Obsidian + memory tuning setup at the end of bootstrap (interactive)
  --skip-obsidian-memory-setup
                      Skip the Obsidian + memory tuning setup prompt
  --setup-openclaw-heap
                      Apply OpenClaw launcher heap tuning at the end of bootstrap (interactive)
  --skip-openclaw-heap-setup
                      Skip the OpenClaw launcher heap tuning prompt
  --openclaw-max-old-space-mb <int>
                      Heap limit for launcher patch (default: 6144)
  --skill-copy         Install skill by copying files into \$OPENCLAW_HOME/skills
  --skill-symlink      Install skill as symlink to repo copy (default; best for local skill development)
  --no-backfill        Shortcut for --integration-level manual
  --update             Pull latest repo if already present
  --skip-docker        Skip docker compose up
  --skip-openclaw      Skip OpenClaw CLI steps
  --skip-skill         Skip skill install into \$OPENCLAW_HOME/skills
  --skip-plugin        Skip installing logger plugin
  --skip-chutes-prompt Do not prompt to run Chutes fast path when openclaw is missing
  --install-chutes-if-missing-openclaw
                      Auto-run Chutes fast path if openclaw is missing
  --no-access-url-prompt
                      Do not prompt for public/domain access URLs
  --no-access-url-detect
                      Do not auto-detect Tailscale/local access URL defaults
  --env-wizard         Force-enable interactive .env connection wizard
  --no-env-wizard      Disable interactive .env connection wizard
  --no-color           Disable ANSI colors
USAGE
      exit 0
      ;;
    *)
      log_error "Unknown option: $1 (run with --help)"
      ;;
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

case "$(printf "%s" "$OBSIDIAN_MEMORY_SETUP_MODE" | tr '[:upper:]' '[:lower:]')" in
  ask|always|never) OBSIDIAN_MEMORY_SETUP_MODE="$(printf "%s" "$OBSIDIAN_MEMORY_SETUP_MODE" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    log_warn "Invalid Obsidian memory setup mode: $OBSIDIAN_MEMORY_SETUP_MODE (expected ask|always|never). Using ask."
    OBSIDIAN_MEMORY_SETUP_MODE="ask"
    ;;
esac

case "$(printf "%s" "$OPENCLAW_HEAP_SETUP_MODE" | tr '[:upper:]' '[:lower:]')" in
  ask|always|never) OPENCLAW_HEAP_SETUP_MODE="$(printf "%s" "$OPENCLAW_HEAP_SETUP_MODE" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    log_warn "Invalid OpenClaw heap setup mode: $OPENCLAW_HEAP_SETUP_MODE (expected ask|always|never). Using ask."
    OPENCLAW_HEAP_SETUP_MODE="ask"
    ;;
esac

if ! [[ "$OPENCLAW_HEAP_MB" =~ ^[0-9]+$ ]] || [ "$OPENCLAW_HEAP_MB" -lt 1024 ] || [ "$OPENCLAW_HEAP_MB" -gt 65536 ]; then
  log_warn "Invalid OpenClaw heap size: $OPENCLAW_HEAP_MB (expected 1024-65536). Using 6144."
  OPENCLAW_HEAP_MB="6144"
fi

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

remove_env_key() {
  local file_path="$1"
  local key="$2"
  local temp_file
  [ -f "$file_path" ] || return 0
  temp_file="$(mktemp "${file_path}.tmp.XXXXXX")"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "=" { next }
    { print }
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

trim_whitespace() {
  local value="${1:-}"
  value="${value//$'\r'/}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

normalize_http_url() {
  local value
  value="$(trim_whitespace "${1:-}")"
  if [ -z "$value" ]; then
    printf ""
    return
  fi
  case "$value" in
    http://*|https://*) ;;
    *) value="http://$value" ;;
  esac
  printf "%s" "${value%/}"
}

prompt_with_default_tty() {
  local prompt="$1"
  local default_value="$2"
  local input=""
  if [ ! -r /dev/tty ]; then
    printf "%s" "$default_value"
    return
  fi
  if [ -n "$default_value" ]; then
    printf "%s [%s]: " "$prompt" "$default_value" > /dev/tty
  else
    printf "%s: " "$prompt" > /dev/tty
  fi
  read -r input < /dev/tty || input=""
  input="$(trim_whitespace "$input")"
  if [ -z "$input" ]; then
    input="$default_value"
  fi
  printf "%s" "$input"
}

ensure_env_file() {
  local repo_dir="$1"
  local env_file="$repo_dir/.env"
  if [ -f "$env_file" ]; then
    return
  fi
  if [ -f "$repo_dir/.env.example" ]; then
    cp "$repo_dir/.env.example" "$env_file"
    log_info "Seeded $env_file from .env.example."
    return
  fi
  touch "$env_file"
}

# Idempotent: ensure clawboard-logger is in plugins.allow (append only, never replace the list).
ensure_clawboard_logger_in_allow() {
  [ -f "$OPENCLAW_CONFIG_PATH" ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$OPENCLAW_CONFIG_PATH" <<'PY' 2>/dev/null || true
import json, sys
path = sys.argv[1]
try:
  with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
except Exception:
  sys.exit(0)
plug = data.get("plugins") or {}
allow = list(plug.get("allow") or []) if isinstance(plug.get("allow"), list) else []
if "clawboard-logger" not in allow:
  allow.append("clawboard-logger")
  plug["allow"] = allow
  data["plugins"] = plug
  with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
PY
}

should_run_env_wizard() {
  case "${ENV_WIZARD_OVERRIDE:-}" in
    1|true|TRUE|yes|YES) return 0 ;;
    0|false|FALSE|no|NO) return 1 ;;
  esac
  if [ "$PROMPT_ACCESS_URL" = false ]; then
    return 1
  fi
  if [ -n "${CLAWBOARD_ENV_WIZARD:-}" ]; then
    case "$CLAWBOARD_ENV_WIZARD" in
      1|true|TRUE|yes|YES) return 0 ;;
      0|false|FALSE|no|NO) return 1 ;;
    esac
  fi
  [ -r /dev/tty ]
}

run_env_connection_wizard() {
  if ! should_run_env_wizard; then
    return
  fi

  local api_port web_port tail_ip profile_choice default_profile
  local default_web_access default_api_access host_default host_input
  local custom_web custom_api internal_api_default internal_web_default openclaw_default

  api_port="$(extract_url_port "$API_URL" "8010")"
  web_port="$(extract_url_port "$WEB_URL" "3010")"

  if [ -n "$PUBLIC_API_BASE" ]; then
    ACCESS_API_URL="$(normalize_http_url "$PUBLIC_API_BASE")"
  fi
  if [ -n "$PUBLIC_WEB_URL" ]; then
    ACCESS_WEB_URL="$(normalize_http_url "$PUBLIC_WEB_URL")"
  fi
  if [ -z "$ACCESS_API_URL" ]; then
    ACCESS_API_URL="$(normalize_http_url "$API_URL")"
  fi
  if [ -z "$ACCESS_WEB_URL" ]; then
    ACCESS_WEB_URL="$(normalize_http_url "$WEB_URL")"
  fi

  default_profile="1"
  if ! is_local_host "$(extract_url_host "$ACCESS_API_URL")"; then
    if [[ "$(extract_url_host "$ACCESS_API_URL")" =~ ^100\. ]] || [[ "$(extract_url_host "$ACCESS_API_URL")" == *.ts.net ]]; then
      default_profile="2"
    else
      default_profile="3"
    fi
  fi

  printf "\nConnection setup for %s/.env:\n" "$INSTALL_DIR" > /dev/tty
  printf "  1) Local machine only (localhost)\n" > /dev/tty
  printf "  2) LAN/Tailscale access from other devices\n" > /dev/tty
  printf "  3) Custom domain/proxy URLs\n" > /dev/tty
  printf "  4) Keep current values\n" > /dev/tty
  printf "Select [1-4] (default: %s): " "$default_profile" > /dev/tty
  read -r profile_choice < /dev/tty || profile_choice=""
  profile_choice="$(trim_whitespace "$profile_choice")"
  if [ -z "$profile_choice" ]; then
    profile_choice="$default_profile"
  fi

  case "$profile_choice" in
    1)
      default_web_access="http://localhost:$web_port"
      default_api_access="http://localhost:$api_port"
      if [ "$PUBLIC_WEB_URL_EXPLICIT" = false ]; then ACCESS_WEB_URL="$default_web_access"; fi
      if [ "$PUBLIC_API_BASE_EXPLICIT" = false ]; then ACCESS_API_URL="$default_api_access"; fi
      ;;
    2)
      host_default="$(extract_url_host "$ACCESS_WEB_URL")"
      if is_local_host "$host_default"; then
        if tail_ip="$(detect_tailscale_ipv4)"; then
          host_default="$tail_ip"
        else
          host_default="localhost"
        fi
      fi
      if [ "$PUBLIC_WEB_URL_EXPLICIT" = false ] || [ "$PUBLIC_API_BASE_EXPLICIT" = false ]; then
        host_input="$(prompt_with_default_tty "Hostname/IP for browser access" "$host_default")"
        host_input="$(trim_whitespace "$host_input")"
        if [ -z "$host_input" ]; then
          host_input="$host_default"
        fi
        host_input="${host_input#http://}"
        host_input="${host_input#https://}"
        host_input="${host_input%%/*}"
        host_input="${host_input#\[}"
        host_input="${host_input%\]}"
        host_input="${host_input%%:*}"
        if [ -z "$host_input" ]; then
          host_input="$host_default"
        fi
        if [ "$PUBLIC_WEB_URL_EXPLICIT" = false ]; then
          ACCESS_WEB_URL="$(normalize_http_url "http://$host_input:$web_port")"
        fi
        if [ "$PUBLIC_API_BASE_EXPLICIT" = false ]; then
          ACCESS_API_URL="$(normalize_http_url "http://$host_input:$api_port")"
        fi
      fi
      ;;
    3)
      if [ "$PUBLIC_WEB_URL_EXPLICIT" = false ]; then
        custom_web="$(prompt_with_default_tty "Public Clawboard Web URL" "$ACCESS_WEB_URL")"
        ACCESS_WEB_URL="$(normalize_http_url "$custom_web")"
      fi
      if [ "$PUBLIC_API_BASE_EXPLICIT" = false ]; then
        custom_api="$(prompt_with_default_tty "Public Clawboard API base URL" "$ACCESS_API_URL")"
        ACCESS_API_URL="$(normalize_http_url "$custom_api")"
      fi
      ;;
    4)
      ;;
    *)
      log_warn "Unrecognized choice ($profile_choice). Keeping current values."
      ;;
  esac

  if [ "$PUBLIC_WEB_URL_EXPLICIT" = false ]; then
    PUBLIC_WEB_URL="$ACCESS_WEB_URL"
  fi
  if [ "$PUBLIC_API_BASE_EXPLICIT" = false ]; then
    PUBLIC_API_BASE="$ACCESS_API_URL"
  fi

  if [ "$API_URL_EXPLICIT" = false ]; then
    internal_api_default="$(normalize_http_url "$API_URL")"
    if [ "$profile_choice" = "3" ] && [ -n "$ACCESS_API_URL" ]; then
      internal_api_default="$ACCESS_API_URL"
    fi
    API_URL="$(normalize_http_url "$(prompt_with_default_tty "API URL used by bootstrap + logger plugin (must be reachable by OpenClaw)" "$internal_api_default")")"
  fi

  if [ "$WEB_URL_EXPLICIT" = false ]; then
    internal_web_default="$(normalize_http_url "$WEB_URL")"
    if [ "$profile_choice" = "3" ] && [ -n "$ACCESS_WEB_URL" ]; then
      internal_web_default="$ACCESS_WEB_URL"
    fi
    WEB_URL="$(normalize_http_url "$(prompt_with_default_tty "Web URL to check after startup" "$internal_web_default")")"
  fi

  if [ "$OPENCLAW_BASE_URL_EXPLICIT" = false ]; then
    openclaw_default="$(normalize_http_url "$OPENCLAW_BASE_URL_VALUE")"
    if [ -z "$openclaw_default" ]; then
      openclaw_default="http://host.docker.internal:18789"
    fi
    OPENCLAW_BASE_URL_VALUE="$(normalize_http_url "$(prompt_with_default_tty "OpenClaw gateway URL for classifier (OPENCLAW_BASE_URL)" "$openclaw_default")")"
  fi
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

  if [ "$PROMPT_ACCESS_URL" = true ] && [ -r /dev/tty ] && ! should_run_env_wizard && { [ -z "$PUBLIC_API_BASE" ] || [ -z "$PUBLIC_WEB_URL" ]; }; then
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
  local max_attempts=60
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

wait_for_web_health() {
  local web_url="${WEB_URL%/}"
  local max_attempts=45
  local attempt=1
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "curl not found. Skipping web readiness check."
    return 1
  fi
  while [ "$attempt" -le "$max_attempts" ]; do
    if curl -fsS "$web_url" >/dev/null 2>&1; then
      log_success "Clawboard web is reachable at $web_url."
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  log_warn "Clawboard web did not become ready in time: $web_url"
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

resolve_obsidian_brain_setup_script() {
  local workspace_root="${OPENCLAW_WORKSPACE_DIR:-}"
  workspace_root="${workspace_root/#\~/$HOME}"

  if [ -n "${OBSIDIAN_BRAIN_SETUP_SCRIPT:-}" ] && [ -f "$OBSIDIAN_BRAIN_SETUP_SCRIPT" ]; then
    printf "%s" "$OBSIDIAN_BRAIN_SETUP_SCRIPT"
    return 0
  fi

  if [ -f "$INSTALL_DIR/scripts/setup_obsidian_brain.sh" ]; then
    OBSIDIAN_BRAIN_SETUP_SCRIPT="$INSTALL_DIR/scripts/setup_obsidian_brain.sh"
  elif [ -n "$workspace_root" ] && [ -f "$workspace_root/projects/clawboard/scripts/setup_obsidian_brain.sh" ]; then
    OBSIDIAN_BRAIN_SETUP_SCRIPT="$workspace_root/projects/clawboard/scripts/setup_obsidian_brain.sh"
  elif [ -n "$workspace_root" ] && [ -f "$workspace_root/project/clawboard/scripts/setup_obsidian_brain.sh" ]; then
    OBSIDIAN_BRAIN_SETUP_SCRIPT="$workspace_root/project/clawboard/scripts/setup_obsidian_brain.sh"
  elif [ -f "$OPENCLAW_HOME/workspace/projects/clawboard/scripts/setup_obsidian_brain.sh" ]; then
    OBSIDIAN_BRAIN_SETUP_SCRIPT="$OPENCLAW_HOME/workspace/projects/clawboard/scripts/setup_obsidian_brain.sh"
  else
    return 1
  fi

  printf "%s" "$OBSIDIAN_BRAIN_SETUP_SCRIPT"
}

resolve_local_memory_setup_script() {
  local workspace_root="${OPENCLAW_WORKSPACE_DIR:-}"
  workspace_root="${workspace_root/#\~/$HOME}"

  if [ -n "${LOCAL_MEMORY_SETUP_SCRIPT:-}" ] && [ -f "$LOCAL_MEMORY_SETUP_SCRIPT" ]; then
    printf "%s" "$LOCAL_MEMORY_SETUP_SCRIPT"
    return 0
  fi

  if [ -f "$OPENCLAW_SKILLS_DIR/clawboard/scripts/setup-openclaw-local-memory.sh" ]; then
    LOCAL_MEMORY_SETUP_SCRIPT="$OPENCLAW_SKILLS_DIR/clawboard/scripts/setup-openclaw-local-memory.sh"
  elif [ -f "$INSTALL_DIR/skills/clawboard/scripts/setup-openclaw-local-memory.sh" ]; then
    LOCAL_MEMORY_SETUP_SCRIPT="$INSTALL_DIR/skills/clawboard/scripts/setup-openclaw-local-memory.sh"
  elif [ -n "$workspace_root" ] && [ -f "$workspace_root/projects/clawboard/skills/clawboard/scripts/setup-openclaw-local-memory.sh" ]; then
    LOCAL_MEMORY_SETUP_SCRIPT="$workspace_root/projects/clawboard/skills/clawboard/scripts/setup-openclaw-local-memory.sh"
  elif [ -n "$workspace_root" ] && [ -f "$workspace_root/project/clawboard/skills/clawboard/scripts/setup-openclaw-local-memory.sh" ]; then
    LOCAL_MEMORY_SETUP_SCRIPT="$workspace_root/project/clawboard/skills/clawboard/scripts/setup-openclaw-local-memory.sh"
  else
    return 1
  fi

  printf "%s" "$LOCAL_MEMORY_SETUP_SCRIPT"
}

# Deploy main agent templates (AGENTS.md, SOUL.md, HEARTBEAT.md) from the Clawboard repo.
# Source of truth: INSTALL_DIR/agent-templates/main/ (repo). No policy text is hardcoded in this script.
# Copies into the main agent workspace. Idempotent (overwrites). Call after skill/plugin install, before gateway restart.
maybe_deploy_agent_templates() {
  local templates_dir="$INSTALL_DIR/agent-templates/main"
  local workspace_root=""
  workspace_root="$(detect_openclaw_workspace_root 2>/dev/null || true)"
  workspace_root="${workspace_root//$'\r'/}"
  if [ -z "$workspace_root" ]; then
    OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-}"
    if [ -n "${OPENCLAW_WORKSPACE_DIR:-}" ]; then
      workspace_root="${OPENCLAW_WORKSPACE_DIR}"
    else
      workspace_root="$(resolve_default_openclaw_workspace_root)"
    fi
  fi
  workspace_root="${workspace_root/#\~/$HOME}"
  if [ ! -d "$templates_dir" ]; then
    log_warn "Agent templates directory not found: $templates_dir (skipping deploy)."
    return 0
  fi
  if [ ! -d "$workspace_root" ]; then
    log_warn "Workspace root not found: $workspace_root (skipping agent template deploy)."
    return 0
  fi
  local deployed=0
  for f in AGENTS.md SOUL.md HEARTBEAT.md; do
    if [ -f "$templates_dir/$f" ]; then
      cp "$templates_dir/$f" "$workspace_root/$f"
      log_info "Deployed $f to $workspace_root"
      deployed=$((deployed + 1))
    fi
  done
  if [ "$deployed" -gt 0 ]; then
    log_success "Deployed $deployed agent template(s) to main workspace."
  fi
}

# Provision specialist agent workspaces (workspace-coding, workspace-docs, workspace-web, workspace-social).
# Runs scripts/setup_specialist_agents.sh when present. Idempotent.
setup_specialist_agents() {
  if [ ! -f "$INSTALL_DIR/scripts/setup_specialist_agents.sh" ]; then
    log_warn "setup_specialist_agents.sh not found; skipping specialist workspace provisioning."
    return 0
  fi
  OPENCLAW_HOME="$OPENCLAW_HOME" INSTALL_DIR="$INSTALL_DIR" bash "$INSTALL_DIR/scripts/setup_specialist_agents.sh"
}

# Optionally ask the user to add specialist agents (coding, docs, web, social) to openclaw.json
# so the main agent can delegate. Uses `openclaw agents add` when the user agrees. Idempotent.
maybe_offer_agentic_team_setup() {
  local answer=""
  local existing_ids=""
  local raw=""
  local id=""
  local added=0
  local specialist_ids="coding docs web social"

  if [ ! -t 0 ]; then
    log_info "No TTY; skipping agentic team prompt. Add specialists later with: openclaw agents add <id> --workspace \$OPENCLAW_HOME/workspace-<id> --non-interactive"
    return 0
  fi
  if ! command -v openclaw >/dev/null 2>&1; then
    log_warn "openclaw not in PATH; skipping agentic team setup. Install OpenClaw and run: openclaw agents add <id> --workspace \$OPENCLAW_HOME/workspace-<id> --non-interactive"
    return 0
  fi

  printf "\nSet up the agentic team (main + coding, docs, web, social) so the main agent can delegate to specialists? [Y/n]: "
  read -r answer
  case "$(printf "%s" "$answer" | tr '[:upper:]' '[:lower:]')" in
    n|no) log_info "Skipped. You can add specialists later: openclaw agents add <id> --workspace %s/workspace-<id> --non-interactive" "$OPENCLAW_HOME"; return 0 ;;
    *) ;;
  esac

  if raw="$(OPENCLAW_HOME="$OPENCLAW_HOME" openclaw config get agents.list 2>/dev/null)"; then
    if command -v jq >/dev/null 2>&1; then
      existing_ids=$(printf '%s' "$raw" | jq -r '.[].id' 2>/dev/null | tr '\n' ' ')
    elif command -v python3 >/dev/null 2>&1; then
      existing_ids=$(printf '%s' "$raw" | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(x.get('id','') for x in d))" 2>/dev/null)
    fi
  fi
  existing_ids=" ${existing_ids} "

  for id in $specialist_ids; do
    case "$existing_ids" in *" $id "*) continue ;; *) ;; esac
    if [ ! -d "$OPENCLAW_HOME/workspace-$id" ]; then
      log_warn "Workspace $OPENCLAW_HOME/workspace-$id missing; run setup_specialist_agents first. Skipping agent $id."
      continue
    fi
    log_info "Adding agent: $id"
    if OPENCLAW_HOME="$OPENCLAW_HOME" openclaw agents add "$id" --workspace "$OPENCLAW_HOME/workspace-$id" --non-interactive 2>/dev/null; then
      added=$((added + 1))
    else
      log_warn "Failed to add agent $id (may already exist). Continue."
    fi
  done

  if [ "$added" -gt 0 ]; then
    OPENCLAW_GATEWAY_RESTART_NEEDED=true
    log_success "Added $added specialist agent(s) to config. Gateway will restart to apply."
  fi
}

# Run setup-openclaw-local-memory.sh unconditionally (no user prompt). Tool policy + watchdog
# are always applied. Call before the Obsidian prompt. Handles missing openclaw/script gracefully.
maybe_run_local_memory_setup() {
  local script_path=""
  if ! script_path="$(resolve_local_memory_setup_script 2>/dev/null)"; then
    log_warn "setup-openclaw-local-memory.sh not found; skipping local memory setup (tool allow list, heartbeat, watchdog)."
    return 0
  fi
  if ! command -v openclaw >/dev/null 2>&1; then
    log_warn "openclaw not installed; skipping local memory setup. Run later: bash $script_path"
    return 0
  fi
  log_info "Running local memory setup (tool allow list, heartbeat, watchdog)..."
  if bash "$script_path"; then
    log_success "Local memory setup completed."
  else
    log_warn "setup-openclaw-local-memory.sh did not complete successfully. Re-run: bash $script_path"
  fi
}

maybe_offer_obsidian_memory_setup() {
  local mode="${1:-ask}"
  local obsidian_script=""
  local answer=""
  local should_run=false
  local rc=0
  local obsidian_extra=""
  [ "$USE_COLOR" = false ] && obsidian_extra="--no-color"

  case "$mode" in
    never)
      OBSIDIAN_MEMORY_SETUP_STATUS="skipped-mode-never"
      return 0
      ;;
    always) should_run=true ;;
    ask)
      if [ ! -t 0 ]; then
        OBSIDIAN_MEMORY_SETUP_STATUS="skipped-no-tty"
        return 0
      fi
      printf "\nSet up Obsidian thinking vaults + memory tuning now? [Y/n]: "
      read -r answer
      case "$(printf "%s" "$answer" | tr '[:upper:]' '[:lower:]')" in
        ""|y|yes) should_run=true ;;
        *) should_run=false ;;
      esac
      ;;
    *)
      OBSIDIAN_MEMORY_SETUP_STATUS="skipped-invalid-mode"
      return 0
      ;;
  esac

  if [ "$should_run" = false ]; then
    OBSIDIAN_MEMORY_SETUP_STATUS="skipped-by-user"
    if obsidian_script="$(resolve_obsidian_brain_setup_script)"; then
      log_warn "Obsidian/memory setup skipped. Recommended when ready: bash $obsidian_script"
    else
      log_warn "Obsidian/memory setup skipped. Run setup_obsidian_brain.sh later when available."
    fi
    return 0
  fi

  if ! obsidian_script="$(resolve_obsidian_brain_setup_script)"; then
    OBSIDIAN_MEMORY_SETUP_STATUS="missing-script"
    log_warn "Missing setup_obsidian_brain.sh. Cannot run Obsidian/memory setup."
    return 0
  fi

  log_info "Launching Obsidian thinking vault + qmd setup..."
  if ! bash "$obsidian_script" $obsidian_extra; then
    rc=1
    log_warn "setup_obsidian_brain.sh did not complete successfully."
  fi

  if [ "$rc" -eq 0 ]; then
    OBSIDIAN_MEMORY_SETUP_STATUS="configured"
    log_success "Obsidian setup completed."
  else
    OBSIDIAN_MEMORY_SETUP_STATUS="failed"
    log_warn "Obsidian setup had errors. Re-run script when ready."
  fi
}

resolve_openclaw_launcher_script() {
  local openclaw_cmd="${1:-}"
  local candidate=""
  local resolved=""

  if [ -z "$openclaw_cmd" ]; then
    if ! command -v openclaw >/dev/null 2>&1; then
      return 1
    fi
    openclaw_cmd="$(command -v openclaw)"
  fi

  openclaw_cmd="${openclaw_cmd%$'\r'}"
  if [ -z "$openclaw_cmd" ] || [ ! -e "$openclaw_cmd" ]; then
    return 1
  fi

  if [ -f "$openclaw_cmd" ]; then
    candidate="$openclaw_cmd"
  else
    return 1
  fi

  if [ -L "$candidate" ] && command -v python3 >/dev/null 2>&1; then
    resolved="$(python3 - "$candidate" <<'PY'
import os, sys
p = sys.argv[1]
print(os.path.realpath(os.path.expanduser(p)))
PY
)"
    resolved="${resolved//$'\r'/}"
    if [ -n "$resolved" ] && [ -f "$resolved" ]; then
      candidate="$resolved"
    fi
  fi

  printf "%s" "$candidate"
}

apply_openclaw_heap_patch() {
  local launcher_path="$1"
  local heap_mb="$2"
  need_cmd python3

  python3 - "$launcher_path" "$heap_mb" <<'PY'
import os
import re
import stat
import sys

path = os.path.abspath(os.path.expanduser(sys.argv[1]))
heap_mb = str(sys.argv[2]).strip()

if not path or not os.path.exists(path) or not os.path.isfile(path):
    print("missing")
    sys.exit(2)
if not os.access(path, os.R_OK):
    print("not-readable")
    sys.exit(3)
if not os.access(path, os.W_OK):
    print("not-writable")
    sys.exit(4)

with open(path, "r", encoding="utf-8") as f:
    original = f.read()

if not re.search(r"^#!.*\b(?:bash|sh)\b", original.splitlines()[0] if original else "", re.IGNORECASE):
    print("unsupported-launcher")
    sys.exit(5)

if "exec node " not in original:
    print("unsupported-launcher")
    sys.exit(5)

desired_block = (
    "# Keep doctor and other heavy commands from hitting Node's default ~2GB heap.\n"
    "# Respect explicit user-provided max-old-space-size in NODE_OPTIONS.\n"
    'if [[ "${NODE_OPTIONS:-}" != *"--max-old-space-size="* ]]; then\n'
    f'  export NODE_OPTIONS="${{NODE_OPTIONS:+${{NODE_OPTIONS}} }}--max-old-space-size={heap_mb}"\n'
    "fi\n"
)

commented_block_re = re.compile(
    r"# Keep doctor and other heavy commands from hitting Node's default ~2GB heap\.\n"
    r"# Respect explicit user-provided max-old-space-size in NODE_OPTIONS\.\n"
    r"if \[\[ \"\$\{NODE_OPTIONS:-\}\" != \*\"--max-old-space-size=\"\* \]\]; then\n"
    r"  export NODE_OPTIONS=\"\$\{NODE_OPTIONS:\+\$\{NODE_OPTIONS\} \}--max-old-space-size=\d+\"\n"
    r"fi\n?",
    re.MULTILINE,
)
generic_block_re = re.compile(
    r"if \[\[ \"\$\{NODE_OPTIONS:-\}\" != \*\"--max-old-space-size=\"\* \]\]; then\n"
    r"\s*export NODE_OPTIONS=\"[^\n\"]*--max-old-space-size=\d+\"\n"
    r"fi\n?",
    re.MULTILINE,
)

updated = original
if commented_block_re.search(updated):
    updated = commented_block_re.sub(desired_block, updated, count=1)
elif generic_block_re.search(updated):
    updated = generic_block_re.sub(desired_block, updated, count=1)
else:
    marker = "set -euo pipefail\n"
    idx = updated.find(marker)
    if idx == -1:
        print("unsupported-launcher")
        sys.exit(5)
    insert_at = idx + len(marker)
    prefix = updated[:insert_at]
    suffix = updated[insert_at:]
    if not prefix.endswith("\n\n"):
        prefix = prefix + "\n"
    updated = prefix + desired_block + "\n" + suffix.lstrip("\n")

if updated == original:
    print("already")
    sys.exit(0)

st = os.stat(path)
tmp = f"{path}.tmp-{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(updated)
os.chmod(tmp, stat.S_IMODE(st.st_mode))
os.replace(tmp, path)
print("patched")
PY
}

maybe_offer_openclaw_heap_setup() {
  local mode="${1:-ask}"
  local answer=""
  local should_run=false
  local launcher_path=""
  local patch_result=""

  case "$mode" in
    never)
      OPENCLAW_HEAP_SETUP_STATUS="skipped-mode-never"
      return 0
      ;;
    always) should_run=true ;;
    ask)
      if [ ! -t 0 ]; then
        OPENCLAW_HEAP_SETUP_STATUS="skipped-no-tty"
        return 0
      fi
      printf "\nTune OpenClaw launcher heap to --max-old-space-size=%s? [Y/n]: " "$OPENCLAW_HEAP_MB"
      read -r answer
      case "$(printf "%s" "$answer" | tr '[:upper:]' '[:lower:]')" in
        ""|y|yes) should_run=true ;;
        *) should_run=false ;;
      esac
      ;;
    *)
      OPENCLAW_HEAP_SETUP_STATUS="skipped-invalid-mode"
      return 0
      ;;
  esac

  if [ "$should_run" = false ]; then
    OPENCLAW_HEAP_SETUP_STATUS="skipped-by-user"
    return 0
  fi

  if ! launcher_path="$(resolve_openclaw_launcher_script)"; then
    OPENCLAW_HEAP_SETUP_STATUS="openclaw-missing"
    log_warn "openclaw launcher not found on PATH. Skipping heap patch."
    return 0
  fi
  OPENCLAW_HEAP_TARGET="$launcher_path"

  set +e
  patch_result="$(apply_openclaw_heap_patch "$launcher_path" "$OPENCLAW_HEAP_MB" 2>/dev/null)"
  local rc=$?
  set -e

  case "$patch_result" in
    patched)
      OPENCLAW_HEAP_SETUP_STATUS="configured"
      log_success "Updated OpenClaw launcher heap setting at $launcher_path"
      ;;
    already)
      OPENCLAW_HEAP_SETUP_STATUS="already-configured"
      log_success "OpenClaw launcher heap setting already configured at $launcher_path"
      ;;
    not-writable)
      OPENCLAW_HEAP_SETUP_STATUS="not-writable"
      log_warn "OpenClaw launcher is not writable: $launcher_path"
      ;;
    unsupported-launcher)
      OPENCLAW_HEAP_SETUP_STATUS="unsupported-launcher"
      log_warn "OpenClaw launcher format is unsupported for automatic patching: $launcher_path"
      ;;
    missing|not-readable|*)
      if [ "$rc" -eq 0 ]; then
        OPENCLAW_HEAP_SETUP_STATUS="failed"
      else
        OPENCLAW_HEAP_SETUP_STATUS="failed"
      fi
      log_warn "Could not apply OpenClaw heap patch automatically."
      ;;
  esac
}

resolve_memory_backup_setup_script() {
  if [ -n "${MEMORY_BACKUP_SETUP_SCRIPT:-}" ] && [ -f "$MEMORY_BACKUP_SETUP_SCRIPT" ]; then
    printf "%s" "$MEMORY_BACKUP_SETUP_SCRIPT"
    return 0
  fi

  if [ -f "$OPENCLAW_SKILLS_DIR/clawboard/scripts/setup-openclaw-memory-backup.sh" ]; then
    MEMORY_BACKUP_SETUP_SCRIPT="$OPENCLAW_SKILLS_DIR/clawboard/scripts/setup-openclaw-memory-backup.sh"
  elif [ -f "$INSTALL_DIR/skills/clawboard/scripts/setup-openclaw-memory-backup.sh" ]; then
    MEMORY_BACKUP_SETUP_SCRIPT="$INSTALL_DIR/skills/clawboard/scripts/setup-openclaw-memory-backup.sh"
  elif [ -f "$INSTALL_DIR/scripts/setup-openclaw-memory-backup.sh" ]; then
    MEMORY_BACKUP_SETUP_SCRIPT="$INSTALL_DIR/scripts/setup-openclaw-memory-backup.sh"
  else
    return 1
  fi

  printf "%s" "$MEMORY_BACKUP_SETUP_SCRIPT"
}

maybe_offer_memory_backup_setup() {
  local mode="${1:-ask}"
  local setup_script=""
  local answer=""
  local should_run=false

  case "$mode" in
    never)
      MEMORY_BACKUP_SETUP_STATUS="skipped-mode-never"
      return 0
      ;;
    always) should_run=true ;;
    ask)
      if [ ! -t 0 ]; then
        MEMORY_BACKUP_SETUP_STATUS="skipped-no-tty"
        return 0
      fi
      printf "\nBackups are strongly recommended for continuity + Clawboard state safety.\n"
      printf "Set up automated continuity + Clawboard backups now? [Y/n]: "
      read -r answer
      case "$(printf "%s" "$answer" | tr '[:upper:]' '[:lower:]')" in
        ""|y|yes) should_run=true ;;
        *) should_run=false ;;
      esac
      ;;
    *)
      MEMORY_BACKUP_SETUP_STATUS="skipped-invalid-mode"
      return 0
      ;;
  esac

  if [ "$should_run" = false ]; then
    MEMORY_BACKUP_SETUP_STATUS="skipped-by-user"
    if setup_script="$(resolve_memory_backup_setup_script)"; then
      log_warn "Backup setup skipped. Recommended when ready: bash $setup_script"
    else
      log_warn "Backup setup skipped. Run setup-openclaw-memory-backup.sh later when available."
    fi
    return 0
  fi

  if ! setup_script="$(resolve_memory_backup_setup_script)"; then
    MEMORY_BACKUP_SETUP_STATUS="missing-script"
    log_warn "Memory backup setup script not found. Run manually when available."
    return 0
  fi

  log_info "Launching memory + Clawboard backup setup..."
  if bash "$setup_script"; then
    MEMORY_BACKUP_SETUP_STATUS="configured"
    log_success "Memory + Clawboard backup setup completed."
  else
    MEMORY_BACKUP_SETUP_STATUS="failed"
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

ensure_env_file "$INSTALL_DIR"

if [ "$PUBLIC_API_BASE_EXPLICIT" = false ] && read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_PUBLIC_API_BASE" >/dev/null 2>&1; then
  PUBLIC_API_BASE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_PUBLIC_API_BASE" || true)"
fi
if [ "$PUBLIC_WEB_URL_EXPLICIT" = false ] && read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_PUBLIC_WEB_URL" >/dev/null 2>&1; then
  PUBLIC_WEB_URL="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_PUBLIC_WEB_URL" || true)"
fi
if [ "$OPENCLAW_BASE_URL_EXPLICIT" = false ] && read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_BASE_URL" >/dev/null 2>&1; then
  OPENCLAW_BASE_URL_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_BASE_URL" || true)"
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
run_env_connection_wizard
ACCESS_API_URL="$(normalize_http_url "$ACCESS_API_URL")"
ACCESS_WEB_URL="$(normalize_http_url "$ACCESS_WEB_URL")"
API_URL="$(normalize_http_url "$API_URL")"
WEB_URL="$(normalize_http_url "$WEB_URL")"
if [ -z "$OPENCLAW_BASE_URL_VALUE" ]; then
  OPENCLAW_BASE_URL_VALUE="http://host.docker.internal:18789"
fi
OPENCLAW_BASE_URL_VALUE="$(normalize_http_url "$OPENCLAW_BASE_URL_VALUE")"
log_info "Writing CLAWBOARD_PUBLIC_API_BASE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_PUBLIC_API_BASE" "$ACCESS_API_URL"
log_info "Writing CLAWBOARD_PUBLIC_WEB_URL in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_PUBLIC_WEB_URL" "$ACCESS_WEB_URL"
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SERVER_API_BASE" >/dev/null 2>&1; then
  SERVER_API_BASE_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SERVER_API_BASE" || true)"
else
  SERVER_API_BASE_VALUE="http://api:8000"
fi
SERVER_API_BASE_VALUE="$(normalize_http_url "$SERVER_API_BASE_VALUE")"
log_info "Writing CLAWBOARD_SERVER_API_BASE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_SERVER_API_BASE" "$SERVER_API_BASE_VALUE"
log_info "Writing OPENCLAW_BASE_URL in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "OPENCLAW_BASE_URL" "$OPENCLAW_BASE_URL_VALUE"
# Legacy compatibility key used by removed Next.js Prisma storage path.
remove_env_key "$INSTALL_DIR/.env" "DATABASE_URL"

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
DEFAULT_CONTEXT_MAX_CHARS="2200"
DEFAULT_SEARCH_CONCURRENCY_LIMIT="2"
DEFAULT_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS="900"
DEFAULT_SEARCH_EMBED_QUERY_CACHE_SIZE="256"
DEFAULT_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS="2400"
case "$CONTEXT_MODE_VALUE" in
  full)
    DEFAULT_CONTEXT_FETCH_TIMEOUT_MS="2500"
    DEFAULT_CONTEXT_MAX_CHARS="3500"
    ;;
  patient)
    DEFAULT_CONTEXT_FETCH_TIMEOUT_MS="8000"
    DEFAULT_CONTEXT_MAX_CHARS="6000"
    ;;
esac

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

# Long-running subagent board-scope persistence (hours). Plugin uses this when resolving scope from DB; 48h keeps day-long agents aligned.
BOARD_SCOPE_SUBAGENT_TTL_HOURS_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_BOARD_SCOPE_SUBAGENT_TTL_HOURS" >/dev/null 2>&1; then
  BOARD_SCOPE_SUBAGENT_TTL_HOURS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_BOARD_SCOPE_SUBAGENT_TTL_HOURS" || true)"
else
  BOARD_SCOPE_SUBAGENT_TTL_HOURS_VALUE="48"
fi
BOARD_SCOPE_SUBAGENT_TTL_HOURS_VALUE="$(clamp_int "$BOARD_SCOPE_SUBAGENT_TTL_HOURS_VALUE" 1 168 || echo "48")"
log_info "Writing CLAWBOARD_BOARD_SCOPE_SUBAGENT_TTL_HOURS=$BOARD_SCOPE_SUBAGENT_TTL_HOURS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_BOARD_SCOPE_SUBAGENT_TTL_HOURS" "$BOARD_SCOPE_SUBAGENT_TTL_HOURS_VALUE"

# Plugin request-id cache (for unlabeled follow-up events / cross-agent handoffs). Keep long enough for multi-day runs.
OPENCLAW_REQUEST_ID_TTL_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ID_TTL_SECONDS" >/dev/null 2>&1; then
  OPENCLAW_REQUEST_ID_TTL_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ID_TTL_SECONDS" || true)"
else
  OPENCLAW_REQUEST_ID_TTL_VALUE="604800"
fi
OPENCLAW_REQUEST_ID_TTL_VALUE="$(clamp_int "$OPENCLAW_REQUEST_ID_TTL_VALUE" 300 7776000 || echo "604800")"
log_info "Writing OPENCLAW_REQUEST_ID_TTL_SECONDS=$OPENCLAW_REQUEST_ID_TTL_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ID_TTL_SECONDS" "$OPENCLAW_REQUEST_ID_TTL_VALUE"
OPENCLAW_REQUEST_ID_MAX_ENTRIES_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ID_MAX_ENTRIES" >/dev/null 2>&1; then
  OPENCLAW_REQUEST_ID_MAX_ENTRIES_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ID_MAX_ENTRIES" || true)"
else
  OPENCLAW_REQUEST_ID_MAX_ENTRIES_VALUE="5000"
fi
OPENCLAW_REQUEST_ID_MAX_ENTRIES_VALUE="$(clamp_int "$OPENCLAW_REQUEST_ID_MAX_ENTRIES_VALUE" 200 50000 || echo "5000")"
log_info "Writing OPENCLAW_REQUEST_ID_MAX_ENTRIES=$OPENCLAW_REQUEST_ID_MAX_ENTRIES_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ID_MAX_ENTRIES" "$OPENCLAW_REQUEST_ID_MAX_ENTRIES_VALUE"

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

  # Match deploy.sh option 3 then 1: full tear-down + rebuild (fresh), then start.
  log_info "Tearing down existing Clawboard stack (like deploy.sh fresh)..."
  (cd "$INSTALL_DIR" && $COMPOSE --profile dev down --remove-orphans 2>/dev/null || true)
  (cd "$INSTALL_DIR" && $COMPOSE down --remove-orphans 2>/dev/null || true)
  log_info "Building and starting Clawboard via docker compose..."
  WEB_HOT_RELOAD="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_WEB_HOT_RELOAD" || true)"
  case "$WEB_HOT_RELOAD" in
    1|true|TRUE|yes|YES)
      (cd "$INSTALL_DIR" && $COMPOSE --profile dev up -d --build --force-recreate api classifier qdrant web-dev)
      ;;
    *)
      (cd "$INSTALL_DIR" && $COMPOSE up -d --build --force-recreate)
      ;;
  esac
  log_success "Clawboard services running."
  wait_for_web_health || log_warn "Check WEB_URL/CLAWBOARD_PUBLIC_WEB_URL in .env if the UI is not loading."
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
      SKILL_OPENCLAW_DST="$OPENCLAW_SKILLS_DIR/clawboard"
      LOGGER_SKILL_REPO_SRC="$INSTALL_DIR/skills/clawboard-logger"
      LOGGER_SKILL_OPENCLAW_DST="$OPENCLAW_SKILLS_DIR/clawboard-logger"

      if [ ! -d "$SKILL_REPO_SRC" ]; then
        log_warn "Repo skill directory not found: $SKILL_REPO_SRC"
      else
        mkdir -p "$OPENCLAW_SKILLS_DIR"
        rm -rf "$SKILL_OPENCLAW_DST"
        if [ "$SKILL_INSTALL_MODE" = "symlink" ]; then
          ln -s "$SKILL_REPO_SRC" "$SKILL_OPENCLAW_DST"
          log_success "Skill linked: $SKILL_OPENCLAW_DST -> $SKILL_REPO_SRC"
        else
          cp -R "$SKILL_REPO_SRC" "$SKILL_OPENCLAW_DST"
          log_success "Skill installed to $SKILL_OPENCLAW_DST."
        fi
      fi

      if [ "$SKILL_INSTALL_MODE" = "copy" ]; then
        log_warn "Using copy mode for skills. Repo edits will not appear in OpenClaw until synced/copied again."
      fi

      if [ -d "$LOGGER_SKILL_REPO_SRC" ]; then
        rm -rf "$LOGGER_SKILL_OPENCLAW_DST"
        if [ "$SKILL_INSTALL_MODE" = "symlink" ]; then
          ln -s "$LOGGER_SKILL_REPO_SRC" "$LOGGER_SKILL_OPENCLAW_DST"
          log_success "Logger skill linked: $LOGGER_SKILL_OPENCLAW_DST -> $LOGGER_SKILL_REPO_SRC"
        else
          cp -R "$LOGGER_SKILL_REPO_SRC" "$LOGGER_SKILL_OPENCLAW_DST"
          log_success "Logger skill installed to $LOGGER_SKILL_OPENCLAW_DST."
        fi
      elif [ -e "$LOGGER_SKILL_OPENCLAW_DST" ]; then
        log_warn "Found $LOGGER_SKILL_OPENCLAW_DST, but repo copy is missing at $LOGGER_SKILL_REPO_SRC (left unchanged)."
      else
        log_info "Optional logger skill directory not present in repo ($LOGGER_SKILL_REPO_SRC); skipping."
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
      PLUGIN_EXT_DIR="$OPENCLAW_HOME/extensions/clawboard-logger"
      if [ -e "$PLUGIN_EXT_DIR" ]; then
        rm -rf "$PLUGIN_EXT_DIR"
        log_info "Removed existing plugin at $PLUGIN_EXT_DIR for idempotent re-install."
      fi
      # If plugin dir is missing, config may still reference it (e.g. from a previous run). Strip so openclaw commands succeed.
      if [ ! -e "$PLUGIN_EXT_DIR" ] && [ -f "$OPENCLAW_CONFIG_PATH" ] && command -v python3 >/dev/null 2>&1; then
        log_info "Removing stale clawboard-logger references from OpenClaw config so install can run..."
        python3 - "$OPENCLAW_CONFIG_PATH" <<'PY' 2>/dev/null || true
import json, sys
path = sys.argv[1]
try:
  with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
except Exception:
  sys.exit(0)
plug = data.get("plugins") or {}
# Remove from load.paths
paths = (plug.get("load") or {}).get("paths") or []
if isinstance(paths, list):
  paths[:] = [p for p in paths if "clawboard-logger" not in (p or "")]
  if plug.get("load") is not None:
    plug["load"]["paths"] = paths
# Remove from allow
allow = plug.get("allow") or []
if isinstance(allow, list):
  allow[:] = [a for a in allow if a != "clawboard-logger"]
  plug["allow"] = allow
# Remove entries and installs
for key in ("entries", "installs"):
  if isinstance(plug.get(key), dict) and "clawboard-logger" in plug[key]:
    del plug[key]["clawboard-logger"]
data["plugins"] = plug
with open(path, "w", encoding="utf-8") as f:
  json.dump(data, f, indent=2)
PY
      fi
      openclaw plugins install -l "$INSTALL_DIR/extensions/clawboard-logger"
      openclaw plugins enable clawboard-logger

      log_info "Configuring logger plugin..."
      if [ -n "$TOKEN" ]; then
        CONFIG_JSON=$(printf '{"baseUrl":"%s","token":"%s","enabled":true,"contextMode":"%s","contextFetchTimeoutMs":%s,"contextMaxChars":%s}' "$API_URL" "$TOKEN" "$CONTEXT_MODE_VALUE" "$CONTEXT_FETCH_TIMEOUT_MS_VALUE" "$CONTEXT_MAX_CHARS_VALUE")
      else
        CONFIG_JSON=$(printf '{"baseUrl":"%s","enabled":true,"contextMode":"%s","contextFetchTimeoutMs":%s,"contextMaxChars":%s}' "$API_URL" "$CONTEXT_MODE_VALUE" "$CONTEXT_FETCH_TIMEOUT_MS_VALUE" "$CONTEXT_MAX_CHARS_VALUE")
      fi
      openclaw config set plugins.entries.clawboard-logger.config --json "$CONFIG_JSON" >/dev/null 2>&1 || true
      openclaw config set plugins.entries.clawboard-logger.enabled --json true >/dev/null 2>&1 || true
      OPENCLAW_GATEWAY_RESTART_NEEDED=true
      log_success "Logger plugin installed and enabled."
      ensure_clawboard_logger_in_allow
    fi

    maybe_deploy_agent_templates

    setup_specialist_agents

    maybe_offer_agentic_team_setup

    maybe_run_local_memory_setup

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

    maybe_offer_obsidian_memory_setup "$OBSIDIAN_MEMORY_SETUP_MODE"
    if [ "$OBSIDIAN_MEMORY_SETUP_STATUS" = "configured" ]; then
      ensure_clawboard_logger_in_allow
      log_info "Restarting OpenClaw gateway after Obsidian/memory setup..."
      if openclaw gateway restart >/dev/null 2>&1; then
        log_success "OpenClaw gateway restarted."
      elif openclaw gateway start >/dev/null 2>&1; then
        log_success "OpenClaw gateway started."
      else
        log_warn "Unable to restart OpenClaw gateway automatically. Run: openclaw gateway restart"
      fi
    fi

    maybe_offer_memory_backup_setup "$MEMORY_BACKUP_SETUP_MODE"

    ensure_clawboard_logger_in_allow
  fi
fi

maybe_offer_openclaw_heap_setup "$OPENCLAW_HEAP_SETUP_MODE"

echo ""
log_success "Bootstrap complete."
echo "Clawboard UI (access):   $ACCESS_WEB_URL"
echo "Clawboard API (access):  ${ACCESS_API_URL%/}/docs"
echo "Clawboard API (internal): $API_URL"
echo "OpenClaw gateway (classifier): $OPENCLAW_BASE_URL_VALUE"
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
BACKUP_SETUP_HINT="$OPENCLAW_SKILLS_DIR/clawboard/scripts/setup-openclaw-memory-backup.sh"
if backup_setup_path="$(resolve_memory_backup_setup_script 2>/dev/null)"; then
  BACKUP_SETUP_HINT="$backup_setup_path"
fi
case "$MEMORY_BACKUP_SETUP_STATUS" in
  configured)
    echo "Backups:       configured (automation setup complete)"
    ;;
  failed)
    echo "Backups:       setup attempted but did not complete"
    echo "               Rerun: bash $BACKUP_SETUP_HINT"
    ;;
  missing-script)
    echo "Backups:       setup helper not found in this install"
    ;;
  skipped-mode-never|skipped-by-user|skipped-no-tty|skipped-invalid-mode|not-run)
    echo "Backups:       not configured in this run"
    echo "               Recommended: bash $BACKUP_SETUP_HINT"
    ;;
esac
OBSIDIAN_SETUP_HINT="$INSTALL_DIR/scripts/setup_obsidian_brain.sh"
LOCAL_MEMORY_SETUP_HINT="$OPENCLAW_SKILLS_DIR/clawboard/scripts/setup-openclaw-local-memory.sh"
if obsidian_setup_path="$(resolve_obsidian_brain_setup_script 2>/dev/null)"; then
  OBSIDIAN_SETUP_HINT="$obsidian_setup_path"
fi
if local_memory_setup_path="$(resolve_local_memory_setup_script 2>/dev/null)"; then
  LOCAL_MEMORY_SETUP_HINT="$local_memory_setup_path"
fi
case "$OBSIDIAN_MEMORY_SETUP_STATUS" in
  configured)
    echo "Obsidian/Memory: configured (vaults + tuning setup complete)"
    ;;
  failed)
    echo "Obsidian/Memory: setup attempted but did not complete"
    echo "                 Rerun: bash $OBSIDIAN_SETUP_HINT"
    echo "                 Then:  bash $LOCAL_MEMORY_SETUP_HINT"
    ;;
  missing-script)
    echo "Obsidian/Memory: setup helper script(s) not found in this install"
    ;;
  skipped-mode-never|skipped-by-user|skipped-no-tty|skipped-invalid-mode|not-run)
    echo "Obsidian/Memory: not configured in this run"
    echo "                 Recommended: bash $OBSIDIAN_SETUP_HINT"
    echo "                 Then:        bash $LOCAL_MEMORY_SETUP_HINT"
    ;;
esac
case "$OPENCLAW_HEAP_SETUP_STATUS" in
  configured)
    echo "OpenClaw heap:  configured (${OPENCLAW_HEAP_MB}MB in launcher)"
    if [ -n "$OPENCLAW_HEAP_TARGET" ]; then
      echo "               file: $OPENCLAW_HEAP_TARGET"
    fi
    ;;
  already-configured)
    echo "OpenClaw heap:  already configured"
    if [ -n "$OPENCLAW_HEAP_TARGET" ]; then
      echo "               file: $OPENCLAW_HEAP_TARGET"
    fi
    ;;
  not-writable)
    echo "OpenClaw heap:  launcher is not writable"
    if [ -n "$OPENCLAW_HEAP_TARGET" ]; then
      echo "               file: $OPENCLAW_HEAP_TARGET"
    fi
    ;;
  unsupported-launcher)
    echo "OpenClaw heap:  launcher format unsupported for auto patch"
    if [ -n "$OPENCLAW_HEAP_TARGET" ]; then
      echo "               file: $OPENCLAW_HEAP_TARGET"
    fi
    ;;
  openclaw-missing)
    echo "OpenClaw heap:  openclaw not found on PATH"
    ;;
  skipped-mode-never|skipped-by-user|skipped-no-tty|skipped-invalid-mode|not-run)
    echo "OpenClaw heap:  not configured in this run"
    ;;
  *)
    echo "OpenClaw heap:  setup attempted but did not complete"
    ;;
esac
echo "Security note: CLAWBOARD_TOKEN is required for all writes and non-localhost reads."
echo "               Localhost reads can run tokenless. Keep network ACLs strict (no Funnel/public exposure)."
echo ""
echo "If OpenClaw was not installed, run this later:"
echo "  bash scripts/bootstrap_clawboard.sh --skip-docker --update"
echo "Set up automated continuity + Clawboard backups:"
echo "  bash $BACKUP_SETUP_HINT"
echo "Set up Obsidian thinking vaults + memory tuning:"
echo "  bash $OBSIDIAN_SETUP_HINT"
echo "  bash $LOCAL_MEMORY_SETUP_HINT"
echo "Tune OpenClaw launcher heap (idempotent patch helper via bootstrap):"
echo "  bash scripts/bootstrap_clawboard.sh --setup-openclaw-heap --skip-docker --skip-skill --skip-plugin --skip-memory-backup-setup --skip-obsidian-memory-setup"
echo "If you want Chutes before Clawboard skill wiring:"
echo "  tmp=\$(mktemp -t add-chutes.sh.XXXXXX) && curl -fsSL $CHUTES_FAST_PATH_URL -o \"\$tmp\" && bash \"\$tmp\" && rm -f \"\$tmp\""
