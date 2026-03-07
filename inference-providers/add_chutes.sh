#!/usr/bin/env bash
set -euo pipefail

# Minimal Chutes -> OpenClaw provider bootstrap
# Goal: vanilla OpenClaw install + add Chutes as provider (no code changes)

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
close_tty_fd() {
  exec 3<&- 3>&- 2>/dev/null || true
}

sync_main_agent_auth() {
  local token="$1"
  local auth_path="$HOME/.openclaw/agents/main/agent/auth-profiles.json"

  mkdir -p "$(dirname "$auth_path")"

  CHUTES_MAIN_AGENT_TOKEN="$token" CHUTES_MAIN_AGENT_AUTH_PATH="$auth_path" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["CHUTES_MAIN_AGENT_AUTH_PATH"])
token = os.environ["CHUTES_MAIN_AGENT_TOKEN"]

data = {
    "version": 1,
    "profiles": {},
    "lastGood": {},
    "usageStats": {},
}

if path.exists():
    try:
        data = json.loads(path.read_text())
    except Exception:
        pass

data.setdefault("version", 1)
profiles = data.setdefault("profiles", {})
profiles["chutes:default"] = {
    "provider": "chutes",
    "type": "api_key",
    "key": token,
}
profiles["chutes:manual"] = {
    "provider": "chutes",
    "type": "api_key",
    "key": token,
}
data.setdefault("lastGood", {})["chutes"] = "chutes:default"
data.setdefault("usageStats", {})

path.write_text(json.dumps(data, indent=2) + "\n")
PY

  log_success "Main agent auth synced."
}

resolve_default_model_ref() {
  MODELS_JSON="$1" \
  CHUTES_DEFAULT_MODEL_ID="${CHUTES_DEFAULT_MODEL_ID:-}" \
  CHUTES_DEFAULT_MODEL_REF="${CHUTES_DEFAULT_MODEL_REF:-}" \
  node - <<'NODE'
const models = JSON.parse(process.env.MODELS_JSON || '[]');
const explicitRef = (process.env.CHUTES_DEFAULT_MODEL_REF || '').trim();
if (explicitRef) {
  console.log(explicitRef.startsWith('chutes/') ? explicitRef : `chutes/${explicitRef}`);
  process.exit(0);
}

const ids = new Set(models.map((model) => model.id));
const preferred = [
  (process.env.CHUTES_DEFAULT_MODEL_ID || '').trim(),
  'zai-org/GLM-4.7-TEE',
  'Qwen/Qwen3-Coder-Next-TEE',
  'moonshotai/Kimi-K2.5-TEE',
  'zai-org/GLM-5-TEE',
  'Qwen/Qwen3-32B',
].filter(Boolean);

for (const modelId of preferred) {
  if (ids.has(modelId)) {
    console.log(`chutes/${modelId}`);
    process.exit(0);
  }
}

const firstModel = models[0]?.id || 'zai-org/GLM-4.7-TEE';
console.log(`chutes/${firstModel}`);
NODE
}

CHUTES_BASE_URL="${CHUTES_BASE_URL:-https://llm.chutes.ai/v1}"
CHUTES_DEFAULT_MODEL_ID="${CHUTES_DEFAULT_MODEL_ID:-}"
CHUTES_DEFAULT_MODEL_REF="${CHUTES_DEFAULT_MODEL_REF:-}"
CHUTES_AUTH_TOKEN=""

check_node_version() {

  echo -e "${GREEN}"
  echo "   ______ __             __               ___    ____ "
  echo "  / ____// /_   __  __  / /_ ___   _____ /   |  /  _/ "
  echo " / /    / __ \ / / / / / __// _ \ / ___// /| |  / /   "
  echo "/ /___ / / / // /_/ / / /_ /  __/(__  )/ ___ |_/ /    "
  echo "\____//_/ /_/ \__,_/  \__/ \___//____//_/  |_/___/    "
  echo -e "      🪂 x OpenClaw${NC} 🦞"
  echo ""

  log_info "Checking Node.js and npm..."

  install_node_with_nvm() {
    curl -s -o- https://raw.githubusercontent.com/nvm-sh/nvm/$(curl -s https://api.github.com/repos/nvm-sh/nvm/releases/latest | grep tag_name | cut -d : -f 2 | tr -d ' ", ')/install.sh | bash \
    && source "$HOME/.nvm/nvm.sh" \
    && nvm install node \
    && nvm use node \
    && npm install -g npm@latest
  }

  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.nvm/nvm.sh"
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    log_warn "Node.js or npm not found. Installing via nvm..."
    install_node_with_nvm || log_error "Failed to install Node.js via nvm."
  fi

  command -v node >/dev/null 2>&1 || log_error "Node.js is not installed. OpenClaw requires Node.js 22+."
  command -v npm  >/dev/null 2>&1 || log_error "npm is not installed. Install Node.js (includes npm)."

  local node_version major
  node_version="$(node -v | sed 's/^v//')"
  major="$(echo "$node_version" | cut -d'.' -f1)"
  if [ "${major:-0}" -lt 22 ]; then
    log_warn "Node.js ${node_version} is too old. Updating via nvm..."
    install_node_with_nvm || log_error "Failed to update Node.js via nvm."
    node_version="$(node -v | sed 's/^v//')"
    major="$(echo "$node_version" | cut -d'.' -f1)"
  fi
  if [ "${major:-0}" -lt 22 ]; then
    log_error "Node.js ${node_version} is too old. Need Node.js 22+."
  fi
  log_success "Node.js ${node_version} OK."
}

ensure_openclaw() {
  if command -v openclaw >/dev/null 2>&1; then
    log_success "OpenClaw already installed: $(openclaw --version 2>/dev/null || echo unknown)"
    return
  fi

  log_info "Installing OpenClaw globally..."
  # We install 'long' alongside openclaw because the WhatsApp library (baileys) 
  # often fails to find it in global ESM environments.
  npm install -g openclaw@latest long@latest >/dev/null 2>&1 || log_error "Failed to install OpenClaw via npm."
  command -v openclaw >/dev/null 2>&1 || log_error "OpenClaw install completed but binary not found on PATH."
  log_success "OpenClaw installed: $(openclaw --version 2>/dev/null || echo unknown)"
}

ensure_onboarded() {
  if [ -f "$HOME/.openclaw/openclaw.json" ]; then
    log_success "OpenClaw config exists."
    return
  fi

  log_info "Initializing OpenClaw config..."
  openclaw setup >/dev/null 2>&1 || log_error "OpenClaw setup failed."
  
  openclaw config set gateway.mode --json '"local"' >/dev/null 2>&1
  openclaw config set gateway.port --json '18789' >/dev/null 2>&1
  openclaw config set gateway.bind --json '"loopback"' >/dev/null 2>&1
  
  log_success "Initialization complete."
}

configure_memory() {
  log_info "Configuring memory settings..."
  openclaw config set agents.defaults.compaction.memoryFlush.enabled --json 'true' >/dev/null 2>&1
  openclaw config set agents.defaults.memorySearch.experimental.sessionMemory --json 'false' >/dev/null 2>&1
  openclaw config set agents.defaults.memorySearch.sources --json '["memory"]' >/dev/null 2>&1
  openclaw config set agents.defaults.memorySearch.enabled --json 'true' >/dev/null 2>&1
  log_success "Memory settings configured."
}

configure_gateway() {
  log_info "Ensuring Gateway configuration..."
  openclaw config set gateway.mode --json '"local"' >/dev/null 2>&1
  openclaw config set gateway.port --json '18789' >/dev/null 2>&1
  openclaw config set gateway.bind --json '"loopback"' >/dev/null 2>&1
  
  if ! openclaw config get gateway.auth.token >/dev/null 2>&1; then
      TOKEN=$(openssl rand -hex 24)
      openclaw config set gateway.auth.token --json "\"$TOKEN\"" >/dev/null 2>&1
      openclaw config set gateway.auth.mode --json '"token"' >/dev/null 2>&1
  fi
}

add_chutes_auth() {
  log_info "Configuring Chutes auth via OpenClaw auth profiles..."
  local env_token token
  env_token="${CHUTES_API_KEY:-}"

  # Opt-in env mode only. Default is interactive prompt every run.
  if [ "${CHUTES_USE_ENV_TOKEN:-0}" = "1" ]; then
    if [ -z "${env_token//[[:space:]]/}" ]; then
      log_error "CHUTES_USE_ENV_TOKEN=1 but CHUTES_API_KEY is empty."
    fi
    CHUTES_AUTH_TOKEN="$env_token"
    sync_main_agent_auth "$env_token"
    log_success "Chutes auth stored (from env)."
    return 0
  fi

  if [ -n "${env_token//[[:space:]]/}" ]; then
    log_info "CHUTES_API_KEY detected; prompting interactively (set CHUTES_USE_ENV_TOKEN=1 to use env token)."
  fi

  if ! [ -t 2 ] || ! exec 3<>/dev/tty 2>/dev/null; then
    log_error "CHUTES_API_KEY is not set and no interactive TTY is available for token input."
  fi

  token=""
  echo ""
  printf "Paste token for Chutes: " >&3
  # Read from /dev/tty so this works when script is executed via curl|bash.
  local restore_echo=false
  if stty -echo <&3 2>/dev/null; then
    restore_echo=true
  fi
  IFS= read -r token <&3
  if [ "$restore_echo" = true ]; then
    stty echo <&3 2>/dev/null || true
  fi
  printf "\n" >&3
  close_tty_fd

  token="${token//$'\r'/}"
  if [ -z "${token//[[:space:]]/}" ]; then
    log_error "Chutes token cannot be empty."
  fi

  CHUTES_AUTH_TOKEN="$token"
  sync_main_agent_auth "$token"
  log_success "Chutes auth stored."
}

configure_provider() {
  log_info "Fetching dynamic model list from Chutes API..."
  
  MODELS_JSON=$(node -e '
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
    process.exit(1);
  }
}
run();' 2>/dev/null || echo "")

  if [ -z "$MODELS_JSON" ]; then
    log_warn "Failed to fetch dynamic model list. Using fallback default."
    MODELS_JSON='[{"id":"zai-org/GLM-4.7-TEE","name":"zai-org/GLM-4.7-TEE","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":128000,"maxTokens":4096}]'
  else
    log_success "Fetched $(echo "$MODELS_JSON" | grep -o 'id' | wc -l) models from Chutes."
  fi

  CHUTES_DEFAULT_MODEL_REF="$(resolve_default_model_ref "$MODELS_JSON")"

  log_info "Adding Chutes provider config..."
  
  PROVIDER_CONFIG=$(node -e "
    const config = {
      baseUrl: '$CHUTES_BASE_URL',
      api: 'openai-completions',
      auth: 'api-key',
      apiKey: '$CHUTES_AUTH_TOKEN',
      models: $MODELS_JSON
    };
    console.log(JSON.stringify(config));
  ")
  
  openclaw config set models.providers.chutes --json "$PROVIDER_CONFIG" >/dev/null 2>&1 || log_error "Failed to set models.providers.chutes"

  log_info "Setting default model to ${CHUTES_DEFAULT_MODEL_REF}..."
  openclaw config set agents.defaults.model.primary --json "\"${CHUTES_DEFAULT_MODEL_REF}\"" >/dev/null 2>&1 \
    || log_error "Failed to set agents.defaults.model.primary"

  log_info "Scheduling model list update (every 4 hours)..."
  
  NODE_BIN_DIR=$(dirname "$(command -v node 2>/dev/null || echo "/usr/bin")")

  # Generate update script without heredoc to avoid EOF issues
  UPDATE_SCRIPT="$HOME/.openclaw/update_chutes_models.sh"
  echo '#!/usr/bin/env bash' > "$UPDATE_SCRIPT"
  echo "export PATH=\"\$PATH:$NODE_BIN_DIR:/usr/local/bin:/opt/homebrew/bin\"" >> "$UPDATE_SCRIPT"
  echo 'set -e' >> "$UPDATE_SCRIPT"
  echo '' >> "$UPDATE_SCRIPT"
  echo 'MODELS_JSON=$(node -e "' >> "$UPDATE_SCRIPT"
  echo 'async function run() {' >> "$UPDATE_SCRIPT"
  echo '  try {' >> "$UPDATE_SCRIPT"
  echo '    const res = await fetch(\"https://llm.chutes.ai/v1/models\");' >> "$UPDATE_SCRIPT"
  echo '    if (!res.ok) process.exit(1);' >> "$UPDATE_SCRIPT"
  echo '    const data = await res.json();' >> "$UPDATE_SCRIPT"
  echo '    const mapped = data.data.map(m => ({' >> "$UPDATE_SCRIPT"
  echo '      id: m.id,' >> "$UPDATE_SCRIPT"
  echo '      name: m.id,' >> "$UPDATE_SCRIPT"
  echo '      reasoning: m.supported_features?.includes(\"reasoning\") || false,' >> "$UPDATE_SCRIPT"
  echo '      input: (m.input_modalities || [\"text\"]).filter(i => i === \"text\" || i === \"image\"),' >> "$UPDATE_SCRIPT"
  echo '      cost: {' >> "$UPDATE_SCRIPT"
  echo '        input: m.pricing?.prompt || 0,' >> "$UPDATE_SCRIPT"
  echo '        output: m.pricing?.completion || 0,' >> "$UPDATE_SCRIPT"
  echo '        cacheRead: 0,' >> "$UPDATE_SCRIPT"
  echo '        cacheWrite: 0' >> "$UPDATE_SCRIPT"
  echo '      },' >> "$UPDATE_SCRIPT"
  echo '      contextWindow: m.context_length || 128000,' >> "$UPDATE_SCRIPT"
  echo '      maxTokens: m.max_output_length || 4096' >> "$UPDATE_SCRIPT"
  echo '    }));' >> "$UPDATE_SCRIPT"
  echo '    console.log(JSON.stringify(mapped));' >> "$UPDATE_SCRIPT"
  echo '  } catch (e) { process.exit(1); }' >> "$UPDATE_SCRIPT"
  echo '}' >> "$UPDATE_SCRIPT"
  echo 'run();")' >> "$UPDATE_SCRIPT"
  echo '' >> "$UPDATE_SCRIPT"
  echo 'if [ -n "$MODELS_JSON" ]; then' >> "$UPDATE_SCRIPT"
  echo '  CURRENT_CONFIG=$(openclaw config get models.providers.chutes --json)' >> "$UPDATE_SCRIPT"
  echo '  NEW_CONFIG=$(node -e "' >> "$UPDATE_SCRIPT"
  echo '    const current = JSON.parse(process.argv[1] || \"{}\");' >> "$UPDATE_SCRIPT"
  echo '    current.models = JSON.parse(process.argv[2]);' >> "$UPDATE_SCRIPT"
  echo '    console.log(JSON.stringify(current));' >> "$UPDATE_SCRIPT"
  echo '  " "$CURRENT_CONFIG" "$MODELS_JSON")' >> "$UPDATE_SCRIPT"
  echo '  openclaw config set models.providers.chutes --json "$NEW_CONFIG"' >> "$UPDATE_SCRIPT"
  echo 'fi' >> "$UPDATE_SCRIPT"

  chmod +x "$UPDATE_SCRIPT"

  if command -v crontab >/dev/null 2>&1; then
    if [ -t 2 ] && exec 3<>/dev/tty 2>/dev/null; then
      echo ""
      echo "There's a helper script to refresh Chutes models update_chutes_models.sh added to your openclaw workspace."
      printf "Would you like to schedule it to run every 4 hours? [N/y] : " >&3
      SCHEDULE_CHUTES=""
      IFS= read -r SCHEDULE_CHUTES <&3 || true
      close_tty_fd
      SCHEDULE_CHUTES="${SCHEDULE_CHUTES//$'\r'/}"
      if [[ "$SCHEDULE_CHUTES" =~ ^[yY]$ ]]; then
        crontab -l 2>/dev/null | grep -v "update_chutes_models.sh" | crontab - 2>/dev/null || true
        (crontab -l 2>/dev/null; echo "0 */4 * * * $UPDATE_SCRIPT >/dev/null 2>&1") | crontab -
        log_success "Update job scheduled (every 4 hours)."
      else
        log_info "Skipping scheduled updates."
      fi
    else
      log_info "No TTY available; skipping scheduled updates."
    fi
  else
    log_warn "crontab not found. Auto-updates not scheduled."
  fi

  echo ""
  log_info "Manual refresh: run $UPDATE_SCRIPT"
  log_info "This script refreshes the Chutes model list and updates OpenClaw config."

  log_success "Provider + default model configured."
}

restart_gateway() {
  log_info "Restarting OpenClaw Gateway..."
  pkill -f "openclaw gateway" || true
  nohup openclaw gateway --force > "$HOME/.openclaw/gateway.log" 2>&1 &
  GATEWAY_PID=$!
  
  log_info "Waiting for OpenClaw gateway to start..."
  for i in {1..30}; do
    if openclaw gateway status >/dev/null 2>&1; then
      log_success "Gateway restarted (PID $GATEWAY_PID)."
      return 0
    fi
    sleep 1
  done

  log_warn "Gateway process not found or status check failed. Check ~/.openclaw/gateway.log"
}

verify() {
  log_info "Verifying configuration..."
  
  if ! openclaw models status >/dev/null 2>&1; then
    log_warn "models status check failed (may be expected if gateway isn't fully ready)."
  fi

  log_info "Running a quick test completion..."
  local verify_output verify_reply
  if verify_output="$(openclaw agent --agent main --session-id chutes-bootstrap-verify --message "Reply with exactly: OK" --json --timeout 120 2>/dev/null)" \
    && verify_reply="$(CHUTES_VERIFY_OUTPUT="$verify_output" python3 - <<'PY'
import json
import os
import sys

raw = os.environ.get("CHUTES_VERIFY_OUTPUT", "").strip()
if not raw:
    raise SystemExit(1)

data = json.loads(raw)
texts = []

targets = [data]
if isinstance(data, dict) and isinstance(data.get("result"), dict):
    targets.append(data["result"])

for target in targets:
    if not isinstance(target, dict):
        continue
    reply = target.get("reply")
    if isinstance(reply, dict):
        for key in ("text", "message"):
            value = reply.get(key)
            if isinstance(value, str) and value.strip():
                texts.append(value.strip())
    for payload in target.get("payloads") or []:
        if isinstance(payload, dict):
            text = payload.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())

joined = "\n".join(texts).strip()
if "OK" not in joined:
    raise SystemExit(1)

print(joined.splitlines()[0])
PY
)"; then
    VERSION=$(openclaw --version 2>/dev/null || echo "unknown")
    
    echo ""
    log_success "Chutes responded! Setup verified and persistent."
    echo ""
    echo "----------------------------------------------------------------------"
    echo -e "   🪂 ${BLUE}Chutes AI x OpenClaw Instance Summary${NC} 🦞"
    echo "----------------------------------------------------------------------"
    echo "   Version:           $VERSION"
    echo "   Gateway URL:       http://localhost:18789"
    echo "   Control UI:        openclaw dashboard"
    echo "   Active Provider:   Chutes AI"
    echo "   Primary Model:     $CHUTES_DEFAULT_MODEL_REF"
    echo "   Smoke Reply:       $verify_reply"
    echo "----------------------------------------------------------------------"
    echo "   Next Steps:"
    echo "   1. Chat with Agent:  openclaw agent -m \"Hello!\" --agent main"
    echo "   2. Open TUI:         openclaw tui"
    echo "   3. Launch Dashboard: openclaw dashboard"
    echo "   4. Check Status:     openclaw status --all"
    echo "----------------------------------------------------------------------"
  else
    log_warn "Agent test failed. Check: openclaw models status --json and your token/provider config."
    log_warn "Smoke output: ${verify_output:-<empty>}"
    log_warn "Gateway log: ~/.openclaw/gateway.log"
  fi
}

main() {
  cd "$HOME" || log_error "Failed to change directory to HOME ($HOME)"
  
  check_node_version
  ensure_openclaw
  ensure_onboarded
  configure_gateway
  configure_memory
  add_chutes_auth
  configure_provider
  restart_gateway
  verify
}

main "$@"
exit 0
