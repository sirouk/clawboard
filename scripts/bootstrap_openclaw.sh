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
INSTALL_DIR="${CLAWBOARD_DIR:-$HOME/clawboard}"
API_URL="${CLAWBOARD_API_URL:-http://localhost:8010}"
WEB_URL="${CLAWBOARD_WEB_URL:-http://localhost:3010}"
PUBLIC_API_BASE="${CLAWBOARD_PUBLIC_API_BASE:-}"
PUBLIC_WEB_URL="${CLAWBOARD_PUBLIC_WEB_URL:-}"
TOKEN="${CLAWBOARD_TOKEN:-}"
TITLE="${CLAWBOARD_TITLE:-Clawboard}"
INTEGRATION_LEVEL="${CLAWBOARD_INTEGRATION_LEVEL:-write}"
CHUTES_FAST_PATH_URL="${CHUTES_FAST_PATH_URL:-https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh}"

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
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --web-url) WEB_URL="$2"; shift 2 ;;
    --public-api-base) PUBLIC_API_BASE="$2"; shift 2 ;;
    --public-web-url) PUBLIC_WEB_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --integration-level) INTEGRATION_LEVEL="$2"; shift 2 ;;
    --update) UPDATE_REPO=true; shift ;;
    --skip-docker) SKIP_DOCKER=true; shift ;;
    --skip-openclaw) SKIP_OPENCLAW=true; shift ;;
    --skip-skill) SKIP_SKILL=true; shift ;;
    --skip-plugin) SKIP_PLUGIN=true; shift ;;
    --skip-chutes-prompt) SKIP_CHUTES_PROMPT=true; shift ;;
    --install-chutes-if-missing-openclaw) INSTALL_CHUTES_IF_MISSING_OPENCLAW=true; shift ;;
    --no-access-url-prompt) PROMPT_ACCESS_URL=false; shift ;;
    --no-access-url-detect) AUTO_DETECT_ACCESS_URL=false; shift ;;
    --no-backfill) INTEGRATION_LEVEL="manual"; shift ;;
    --no-color) shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: bash scripts/bootstrap_openclaw.sh [options]

Options:
  --dir <path>         Install directory (default: ~/clawboard)
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
  --no-backfill        Shortcut for --integration-level manual
  --update             Pull latest repo if already present
  --skip-docker        Skip docker compose up
  --skip-openclaw      Skip OpenClaw CLI steps
  --skip-skill         Skip copying skill into ~/.openclaw/skills
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

if [ -z "${CLAWBOARD_INTEGRATION_LEVEL:-}" ] && [ -t 0 ]; then
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

log_info "Preparing Clawboard checkout..."
if [ -d "$INSTALL_DIR/.git" ]; then
  if [ "$UPDATE_REPO" = true ]; then
    git -C "$INSTALL_DIR" pull
  fi
else
  git clone "$REPO_URL" "$INSTALL_DIR"
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

# Default to production-style web service unless the user opts in.
if ! read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_WEB_HOT_RELOAD" >/dev/null 2>&1; then
  log_info "Writing CLAWBOARD_WEB_HOT_RELOAD=0 in $INSTALL_DIR/.env..."
  upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_WEB_HOT_RELOAD" "0"
fi

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
      log_info "Installing Clawboard skill..."
      mkdir -p "$HOME/.openclaw/skills"
      rm -rf "$HOME/.openclaw/skills/clawboard"
      cp -R "$INSTALL_DIR/skills/clawboard" "$HOME/.openclaw/skills/clawboard"
      log_success "Skill installed to ~/.openclaw/skills/clawboard."
    fi

    if [ "$SKIP_PLUGIN" = false ]; then
      log_info "Installing Clawboard logger plugin..."
      openclaw plugins install -l "$INSTALL_DIR/extensions/clawboard-logger"
      openclaw plugins enable clawboard-logger

      log_info "Configuring logger plugin..."
      if [ -n "$TOKEN" ]; then
        CONFIG_JSON=$(printf '{"baseUrl":"%s","token":"%s","enabled":true}' "$API_URL" "$TOKEN")
      else
        CONFIG_JSON=$(printf '{"baseUrl":"%s","enabled":true}' "$API_URL")
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
  fi
fi

echo ""
log_success "Bootstrap complete."
echo "Clawboard UI (access):   $ACCESS_WEB_URL"
echo "Clawboard API (access):  ${ACCESS_API_URL%/}/docs"
echo "Clawboard API (internal): $API_URL"
echo "Token:         $TOKEN"
echo "Security note: CLAWBOARD_TOKEN is required for all writes and non-localhost reads."
echo "               Localhost reads can run tokenless. Keep network ACLs strict (no Funnel/public exposure)."
echo ""
echo "If OpenClaw was not installed, run this later:"
echo "  bash scripts/bootstrap_openclaw.sh --skip-docker --update"
echo "If you want Chutes before Clawboard skill wiring:"
echo "  tmp=\$(mktemp -t add-chutes.sh.XXXXXX) && curl -fsSL $CHUTES_FAST_PATH_URL -o \"\$tmp\" && bash \"\$tmp\" && rm -f \"\$tmp\""
