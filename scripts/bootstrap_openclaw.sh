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
TOKEN="${CLAWBOARD_TOKEN:-}"
TITLE="${CLAWBOARD_TITLE:-Clawboard}"
INTEGRATION_LEVEL="${CLAWBOARD_INTEGRATION_LEVEL:-full}"

SKIP_DOCKER=false
SKIP_OPENCLAW=false
SKIP_SKILL=false
SKIP_PLUGIN=false
UPDATE_REPO=false

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --web-url) WEB_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --integration-level) INTEGRATION_LEVEL="$2"; shift 2 ;;
    --update) UPDATE_REPO=true; shift ;;
    --skip-docker) SKIP_DOCKER=true; shift ;;
    --skip-openclaw) SKIP_OPENCLAW=true; shift ;;
    --skip-skill) SKIP_SKILL=true; shift ;;
    --skip-plugin) SKIP_PLUGIN=true; shift ;;
    --no-backfill) INTEGRATION_LEVEL="manual"; shift ;;
    --no-color) shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: bash scripts/bootstrap_openclaw.sh [options]

Options:
  --dir <path>         Install directory (default: ~/clawboard)
  --api-url <url>      Clawboard API base (default: http://localhost:8010)
  --web-url <url>      Clawboard web URL (default: http://localhost:3010)
  --token <token>      Use a specific CLAWBOARD_TOKEN
  --title <title>      Instance display name (default: Clawboard)
  --integration-level <manual|write|full>
                       Integration level for /api/config (default: full)
  --no-backfill        Shortcut for --integration-level manual
  --update             Pull latest repo if already present
  --skip-docker         Skip docker compose up
  --skip-openclaw       Skip OpenClaw CLI steps
  --skip-skill          Skip copying skill into ~/.openclaw/skills
  --skip-plugin         Skip installing logger plugin
  --no-color            Disable ANSI colors
USAGE
      exit 0
      ;;
    *) shift ;;
  esac
done

if [ -z "${CLAWBOARD_INTEGRATION_LEVEL:-}" ] && [ -t 0 ]; then
  echo ""
  echo "Choose integration level:"
  echo "  1) full   (backfill + live logging)"
  echo "  2) write  (live logging only)"
  echo "  3) manual (UI edits only)"
  printf "Select [1-3] (default: 1): "
  read -r INTEGRATION_CHOICE
  case "$INTEGRATION_CHOICE" in
    2) INTEGRATION_LEVEL="write" ;;
    3) INTEGRATION_LEVEL="manual" ;;
    ""|1) INTEGRATION_LEVEL="full" ;;
    *) log_warn "Unrecognized choice. Using default: full."; INTEGRATION_LEVEL="full" ;;
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

log_info "Writing .env with CLAWBOARD_TOKEN..."
printf "CLAWBOARD_TOKEN=%s\n" "$TOKEN" > "$INSTALL_DIR/.env"
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
  (cd "$INSTALL_DIR" && $COMPOSE up -d --build)
  log_success "Clawboard services running."
fi

if command -v curl >/dev/null 2>&1; then
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
  log_warn "curl not found. Skipping /api/config update."
fi

if [ "$SKIP_OPENCLAW" = false ]; then
  if ! command -v openclaw >/dev/null 2>&1; then
    log_warn "openclaw CLI not found. Install OpenClaw first, then re-run this script."
  else
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
      CONFIG_JSON=$(printf '{"baseUrl":"%s","token":"%s","enabled":true}' "$API_URL" "$TOKEN")
      openclaw config set plugins.entries.clawboard-logger.config --json "$CONFIG_JSON" >/dev/null 2>&1 || true
      openclaw config set plugins.entries.clawboard-logger.enabled true >/dev/null 2>&1 || true

      openclaw gateway restart >/dev/null 2>&1 || openclaw gateway start >/dev/null 2>&1 || true
      log_success "Logger plugin installed and enabled."
    fi
  fi
fi

echo ""
log_success "Bootstrap complete."
echo "Clawboard UI:  $WEB_URL"
echo "Clawboard API: $API_URL/docs"
echo "Token:         $TOKEN"
echo ""
echo "If OpenClaw was not installed, run this later:"
echo "  bash scripts/bootstrap_openclaw.sh --skip-docker --update"
