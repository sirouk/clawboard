#!/usr/bin/env bash
set -euo pipefail

# Clawboard: Chutes x OpenClaw Bootstrap Script (self-contained)
# Usage (recommended):
#   curl -fsSL https://raw.githubusercontent.com/sirouk/Clawboard/main/inference-providers/add_chutes.sh | bash
# Usage (local):
#   bash inference-providers/add_chutes.sh

# Handle --no-color flag
USE_COLOR=true
for arg in "$@"; do
  if [ "$arg" == "--no-color" ]; then
    USE_COLOR=false
    break
  fi
done

# Colors for output
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

# Constants
CHUTES_BASE_URL="https://llm.chutes.ai/v1"
CHUTES_DEFAULT_MODEL_ID="zai-org/GLM-4.7-Flash"
CHUTES_DEFAULT_MODEL_REF="chutes/${CHUTES_DEFAULT_MODEL_ID}"
GATEWAY_PORT=18789
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"

# Helper functions
log_info() { echo -e "${BLUE}info:${NC} $1"; }
log_success() { echo -e "${GREEN}success:${NC} $1"; }
log_warn() { echo -e "${YELLOW}warning:${NC} $1"; }
log_error() { echo -e "${RED}error:${NC} $1"; exit 1; }

# Progress indicator helper
show_progress() {
  local pid=$1
  local delay=0.2
  local spinstr='|/-\\'
  while [ "$(ps -p "$pid" -o state= 2>/dev/null)" ]; do
    local temp=${spinstr#?}
    printf " [%c]  " "$spinstr"
    local spinstr=$temp${spinstr%"$temp"}
    sleep "$delay"
    printf "\b\b\b\b\b\b"
  done
  printf "    \b\b\b\b"
}

check_node_version() {
  log_info "Checking Node.js and npm version..."
  if ! command -v node >/dev/null 2>&1; then
    log_error "Node.js is not installed. OpenClaw requires Node.js 22+. Visit https://nodejs.org to install it."
  fi

  if ! command -v npm >/dev/null 2>&1; then
    log_error "npm is not installed. OpenClaw requires npm for global installation. Please install Node.js which includes npm."
  fi

  NODE_VERSION=$(node -v | cut -d'v' -f2)
  MAJOR_VERSION=$(echo "$NODE_VERSION" | cut -d'.' -f1)

  if [ "$MAJOR_VERSION" -lt 22 ]; then
    log_error "Node.js version $NODE_VERSION is too old. OpenClaw requires Node.js 22+."
  fi
  log_success "Node.js version $NODE_VERSION detected."
}

check_openclaw_installed() {
  hash -r 2>/dev/null || true

  local npm_prefix=$(npm config get prefix 2>/dev/null || echo "")
  if [ -n "$npm_prefix" ] && [ -f "$npm_prefix/bin/openclaw" ]; then
    export PATH="$npm_prefix/bin:$PATH"
    if "$npm_prefix/bin/openclaw" --version >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v openclaw >/dev/null 2>&1; then
    if openclaw --version >/dev/null 2>&1; then
      return 0
    fi
  fi

  local pnpm_locations=(
    "$HOME/Library/pnpm/openclaw"
    "$HOME/.local/share/pnpm/openclaw"
    "/usr/local/bin/openclaw"
  )

  for loc in "${pnpm_locations[@]}"; do
    if [ -f "$loc" ]; then
      export PATH="$(dirname "$loc"):$PATH"
      if openclaw --version >/dev/null 2>&1; then
        return 0
      fi
    fi
  done

  return 1
}

install_openclaw() {
  log_info "Installing OpenClaw globally..."

  npm uninstall -g openclaw >/dev/null 2>&1 || true
  pnpm remove -g openclaw >/dev/null 2>&1 || true

  npm install -g openclaw@latest long@latest > /tmp/openclaw-install.log 2>&1 &
  local install_pid=$!
  show_progress "$install_pid"
  wait "$install_pid"
  local exit_code=$?

  if [ $exit_code -ne 0 ]; then
    log_error "Installation failed. Check /tmp/openclaw-install.log for details."
  fi

  if ! check_openclaw_installed; then
    log_warn "OpenClaw installed but failed to start. Error detail:"
    openclaw --version || true
    log_error "Failed to verify OpenClaw installation."
  fi
  log_success "OpenClaw $(openclaw --version) installed."
}

seed_initial_config() {
  log_info "Seeding initial configuration..."
  if [ ! -f "$CONFIG_PATH" ]; then
    openclaw onboard --non-interactive --accept-risk --auth-choice skip >/dev/null 2>&1 || true
  fi

  local current_mode
  current_mode=$(openclaw config get gateway.mode 2>/dev/null || echo "unset")
  if [ "$current_mode" != "local" ] && [ "$current_mode" != "remote" ]; then
    openclaw config set gateway.mode local >/dev/null 2>&1
  fi
}

add_chutes_auth() {
  log_info "Checking Chutes authentication..."

  if openclaw models status --json 2>/dev/null | node -e "
    try {
      const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const chutesAuth = data.auth?.providers?.find(p => p.provider === 'chutes');
      const hasAuth = (chutesAuth && chutesAuth.profiles?.count > 0) || (data.auth?.shellEnvFallback?.appliedKeys || []).includes('CHUTES_API_KEY');
      process.exit(hasAuth ? 0 : 1);
    } catch (e) { process.exit(1); }
  "; then
    log_success "Chutes authentication already configured."
    return
  fi

  if [ -n "${CHUTES_API_KEY:-}" ]; then
    log_info "Using Chutes API key found in environment variable."
    echo "$CHUTES_API_KEY" | openclaw models auth paste-token --provider chutes >/dev/null 2>&1
  else
    log_info "Redirecting to OpenClaw's official auth helper..."
    openclaw models auth paste-token --provider chutes

    if [ -t 0 ]; then
      echo -ne "\033[12A\033[J"
    fi
  fi

  log_success "Chutes authentication added (secret hidden)."
}

apply_atomic_config() {
  log_info "Fetching latest model list from Chutes API..."
  local models_json
  models_json=$(node -e '
async function run() {
  try {
    const res = await fetch("https://llm.chutes.ai/v1/models");
    if (!res.ok) throw new Error("API request failed: " + res.statusText);
    const data = await res.json();
    if (!data.data || !Array.isArray(data.data)) throw new Error("Invalid response format");
    const mapped = data.data.map(m => ({
      id: m.id,
      name: m.id,
      reasoning: m.supported_features?.includes("reasoning") || false,
      input: (m.input_modalities || ["text"]).filter(i => i === "text" || i === "image"),
      cost: {
        input: m.pricing?.prompt || 0,
        output: m.pricing?.completion || 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: m.context_length || 128000,
      maxTokens: m.max_output_length || 4096
    }));
    console.log(JSON.stringify(mapped));
  } catch (e) {
    process.stderr.write(e.message + "\n");
    process.exit(1);
  }
}
run();' 2>/tmp/chutes-fetch-error.log || echo "")

  if [ -z "$models_json" ]; then
    if [ -f /tmp/chutes-fetch-error.log ]; then
      log_warn "Failed to fetch dynamic model list: $(cat /tmp/chutes-fetch-error.log)"
    fi
    log_warn "Using a minimal default list."
    models_json='[{"id":"zai-org/GLM-4.7-Flash","name":"GLM 4.7 Flash","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":128000,"maxTokens":4096}]'
  fi

  log_info "Applying Chutes provider configuration..."

  local provider_config
  provider_config=$(node -e "
    const config = {
      baseUrl: '$CHUTES_BASE_URL',
      api: 'openai-completions',
      auth: 'api-key',
      models: $models_json
    };
    console.log(JSON.stringify(config));
  ")

  openclaw config set models.providers.chutes --json "$provider_config" >/dev/null 2>&1

  # Only set the agent's primary model (no aliases, no image models)
  openclaw config set agents.defaults.model.primary "$CHUTES_DEFAULT_MODEL_REF" >/dev/null 2>&1

  # Ensure auth profile exists for the provider
  openclaw config set auth.profiles."chutes:manual" --json '{"provider":"chutes","mode":"api_key"}' >/dev/null 2>&1

  log_success "Chutes configuration applied successfully."
}

start_gateway() {
  log_info "Ensuring gateway is fresh..."
  if command -v pkill >/dev/null 2>&1; then
    pkill -9 -f "openclaw gateway run" || true
  else
    ps aux | grep "openclaw gateway run" | grep -v grep | awk '{print $2}' | xargs kill -9 >/dev/null 2>&1 || true
  fi
  sleep 1

  log_info "Starting OpenClaw gateway..."
  nohup openclaw gateway run --bind loopback --port "$GATEWAY_PORT" > /tmp/openclaw-gateway.log 2>&1 &

  log_info "Waiting for gateway initialization..."
  local max_retries=15
  local count=0
  local success=0
  while [ $count -lt $max_retries ]; do
    if curl -s "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null 2>&1; then
      success=1
      break
    fi
    printf "."
    sleep 1
    count=$((count + 1))
  done
  echo ""

  if [ $success -eq 1 ]; then
    sleep 2
    log_success "Gateway is ready."
  else
    log_warn "Gateway failed to start within timeout."
    if [ -f /tmp/openclaw-gateway.log ]; then
      echo "--- Last 20 lines of Gateway log (/tmp/openclaw-gateway.log) ---"
      tail -n 20 /tmp/openclaw-gateway.log
      echo "---------------------------------------------------------------"
    fi
    log_error "Setup cannot continue without a running Gateway."
  fi
}

verify_setup() {
  log_info "Running quick verification test..."

  local ts
  local rand
  ts=$(date +"%H:%M:%S")
  rand=$((100 + RANDOM % 899))

  echo -e "${YELLOW}Prompting Chutes (Time: $ts, Salt: $rand)...${NC}"
  echo ""

  if ! openclaw agent --local --agent main --message "The secret code is $ts-$rand. Keep it short! In 2 sentences as a caffeinated space lobster, mention the code $ts-$rand and why Chutes is the best provider for OpenClaw." --thinking off 2>/dev/null; then
    log_warn "Verification test turn failed. This can happen on fresh systems before first sync."
  else
    echo ""
    log_success "Chutes responded! Setup verified and persistent."
  fi
}

show_summary_card() {
  local version
  version=$(openclaw --version 2>/dev/null || echo "unknown")

  local ip_addr="localhost"
  if command -v ipconfig >/dev/null 2>&1; then
    ip_addr=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")
  elif command -v hostname >/dev/null 2>&1; then
    if grep -qi "microsoft" /proc/version 2>/dev/null; then
      ip_addr=$(hostname -I | awk '{print $1}' || echo "localhost")
    else
      ip_addr=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    fi
  fi

  echo -e "${GREEN}"
  echo "----------------------------------------------------------------------"
  echo "   Chutes AI x OpenClaw Instance Summary"
  echo "----------------------------------------------------------------------"
  printf "   %-18s %s\n" "Version:" "$version"
  printf "   %-18s %s\n" "Gateway URL:" "http://localhost:$GATEWAY_PORT"
  printf "   %-18s %s\n" "Control UI:" "openclaw dashboard"
  printf "   %-18s %s\n" "Active Provider:" "Chutes AI"
  printf "   %-18s %s\n" "Primary Model:" "$CHUTES_DEFAULT_MODEL_REF"
  echo "----------------------------------------------------------------------"
  echo "   Next Steps:"
  echo "   1. Chat with Agent:  openclaw agent -m \"Hello!\"" --agent main
  echo "   2. Open TUI:         openclaw tui"
  echo "   3. Launch Dashboard: openclaw dashboard"
  echo "   4. Check Status:     openclaw status --all"
  echo "----------------------------------------------------------------------"
  echo -e "${NC}"
}

main() {
  if [[ "$(uname -s)" == *"NT"* ]] || [[ "$(uname -s)" == *"MINGW"* ]] || [[ "$(uname -s)" == *"CYGWIN"* ]] || [[ "$(uname -s)" == *"MSYS"* ]]; then
    if grep -qE "(Microsoft|microsoft|WSL)" /proc/version 2>/dev/null; then
      log_info "WSL detected. Running in Linux mode."
    else
      echo -e "${RED}error: This Bash script is intended for macOS and Linux.${NC}"
      echo -e "${YELLOW}For Windows, run from PowerShell with Git Bash or WSL installed:${NC}"
      echo -e "${BLUE}iwr -useb https://raw.githubusercontent.com/sirouk/Clawboard/main/inference-providers/add_chutes.sh | bash${NC}"
      exit 1
    fi
  fi

  echo -e "${GREEN}"
  echo "   ______ __             __               ___    ____ "
  echo "  / ____// /_   __  __  / /_ ___   _____ /   |  /  _/ "
  echo " / /    / __ \\ / / / / / __// _ \\ / ___// /| |  / /   "
  echo "/ /___ / / / // /_/ / / /_ /  __/(__  )/ ___ |_/ /    "
  echo "\\____//_/ /_/ \\__,_/  \\__/ \\___//____//_/  |_/___/    "
  echo -e "      x OpenClaw${NC}"
  echo ""

  check_node_version

  local is_new_user=0
  if ! check_openclaw_installed || [ ! -f "$CONFIG_PATH" ]; then
    is_new_user=1
  fi

  if [ "$is_new_user" -eq 1 ]; then
    log_info "New user journey detected. Setting up OpenClaw from scratch..."
    check_openclaw_installed || install_openclaw
    seed_initial_config
    add_chutes_auth
    apply_atomic_config

    if [ -t 0 ]; then
      log_info "Launching OpenClaw interactive onboarding..."
      log_info "Your Chutes configuration has been pre-seeded."
      openclaw onboard --auth-choice skip --skip-ui
    else
      log_warn "Non-interactive environment detected. Skipping interactive onboarding."
      log_info "You can complete onboarding later by running: openclaw onboard"
    fi
  else
    log_info "Existing user journey detected. Adding Chutes to your current setup..."
    add_chutes_auth
    apply_atomic_config
  fi

  start_gateway
  verify_setup
  show_summary_card

  if [ "$is_new_user" -eq 1 ] && [ -t 0 ]; then
    echo -ne "${YELLOW}Would you like to launch the TUI and talk to your bot now? (y/n): ${NC}"
    read -r launch_tui
    if [[ "$launch_tui" =~ ^[Yy]$ ]]; then
      log_info "Launching OpenClaw TUI..."
      openclaw tui --message "Wake up, my friend!"
    fi
  fi

  log_success "Setup complete! Enjoy your Chutes-powered OpenClaw."
}

main "$@"
