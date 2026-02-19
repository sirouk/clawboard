#!/usr/bin/env bash
set -euo pipefail

# setup-openclaw-local-memory.sh
# Configure OpenClaw local memory search (privacy-first) with tuned defaults,
# ensure per-agent memory directories exist, then refresh indexes.
#
# Optional env vars:
#   OPENCLAW_HOME                         (default: ~/.openclaw)
#   OPENCLAW_CONFIG_PATH                  (default: $OPENCLAW_HOME/openclaw.json)
#   OPENCLAW_MODEL_DIR                    (default: ~/.openclaw/models)
#   OPENCLAW_MEMORY_MODEL_FILE            (default: embeddinggemma-300M-Q8_0.gguf in model dir)
#   OPENCLAW_MEMORY_MODEL_URL             (override download URL)
#   OPENCLAW_MEMORY_MODEL_PATH            (absolute path to existing model; skip download)
#   OPENCLAW_MEMORY_ENABLE_SESSIONS       (default: true)
#   OPENCLAW_MEMORY_FALLBACK              (default: none)
#   OPENCLAW_MEMORY_INDEX_SCOPE           (all|main, default: all)
#   OPENCLAW_MEMORY_FORCE_INDEX           (true|false, default: false)
#   OPENCLAW_MEMORY_INDEX_MAX_ATTEMPTS    (default: 3)
#   OPENCLAW_MEMORY_INDEX_RETRY_DELAY_SEC (default: 10)
#   OPENCLAW_MEMORY_AGENT_ID              (optional override when scope=main)

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

log_info() { echo "info: $1"; }
log_warn() { echo "warn: $1" >&2; }
log_success() { echo "success: $1"; }
die() { echo "error: $1" >&2; exit 1; }

set_cfg() {
  local key="$1"
  local value="$2"
  local mode="${3:-string}"     # string | json
  local required="${4:-true}"   # true | false
  local cmd=(openclaw config set "$key" "$value")
  if [[ "$mode" == "json" ]]; then
    cmd+=(--json)
  fi
  if "${cmd[@]}" >/dev/null 2>&1; then
    log_info "set $key"
    return 0
  fi
  if [[ "$required" == "true" ]]; then
    die "Failed to set required config key: $key"
  fi
  log_warn "Could not set optional key (likely unsupported on this OpenClaw version): $key"
}

as_bool() {
  local raw
  raw="$(printf "%s" "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    1|true|yes|on) echo "true" ;;
    0|false|no|off) echo "false" ;;
    *)
      if [[ -n "${2:-}" ]]; then
        echo "$2"
      else
        echo "false"
      fi
      ;;
  esac
}

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
if [[ "$OPENCLAW_HOME" != "/" ]]; then
  OPENCLAW_HOME="${OPENCLAW_HOME%/}"
fi
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_HOME/openclaw.json}"

need_cmd openclaw
need_cmd python3

MAIN_AGENT_ID="main"
declare -a AGENT_IDS=()
declare -a WORKSPACES=()

discover_agents_and_workspaces() {
  [[ -f "$OPENCLAW_CONFIG_PATH" ]] || die "OpenClaw config not found at: $OPENCLAW_CONFIG_PATH"

  local discovered
  discovered="$(
    python3 - "$OPENCLAW_CONFIG_PATH" "$HOME" "$OPENCLAW_HOME" "${OPENCLAW_PROFILE:-}" <<'PY'
import json
import os
import re
import sys

cfg_path = sys.argv[1]
home_dir = os.path.abspath(os.path.expanduser(sys.argv[2]))
openclaw_home = os.path.abspath(os.path.expanduser(sys.argv[3] or os.path.join(home_dir, ".openclaw")))
profile = (sys.argv[4] or "").strip()
VALID_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

def normalize_agent_id(value):
    raw = (value or "").strip().lower()
    if not raw:
        return "main"
    if VALID_ID_RE.match(raw):
        return raw
    raw = re.sub(r"[^a-z0-9-]+", "-", raw)
    raw = re.sub(r"^-+", "", raw)
    raw = re.sub(r"-+$", "", raw)
    raw = raw[:64]
    return raw or "main"

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

agents_list = [entry for entry in ((cfg.get("agents") or {}).get("list") or []) if isinstance(entry, dict)]
indexed = list(enumerate(agents_list))
defaults = [pair for pair in indexed if pair[1].get("default") is True]
default_idx, default_entry = defaults[0] if defaults else (indexed[0] if indexed else (-1, {}))
default_agent_id = normalize_agent_id(default_entry.get("id") if isinstance(default_entry, dict) else "main")

main_entries = [pair for pair in indexed if normalize_agent_id(pair[1].get("id")) == "main"]
_, main_entry = main_entries[0] if main_entries else (default_idx, default_entry)
main_agent_id = normalize_agent_id(main_entry.get("id") if isinstance(main_entry, dict) else default_agent_id)

fallback_workspace = profile_workspace(openclaw_home, profile)
defaults_workspace = (
    (((cfg.get("agents") or {}).get("defaults") or {}).get("workspace"))
    or ((cfg.get("agents") or {}).get("workspace"))
    or ((cfg.get("agent") or {}).get("workspace"))
    or cfg.get("workspace")
    or fallback_workspace
)
defaults_workspace = normalize_path(defaults_workspace) or fallback_workspace
if defaults_workspace == openclaw_home:
    defaults_workspace = fallback_workspace

agent_ids = []
seen_ids = set()
for entry in agents_list:
    aid = normalize_agent_id(entry.get("id"))
    if aid and aid not in seen_ids:
        seen_ids.add(aid)
        agent_ids.append(aid)
if "main" not in seen_ids:
    agent_ids.insert(0, "main")

workspaces = []
seen_ws = set()
for entry in agents_list:
    workspace = entry.get("workspace")
    if not isinstance(workspace, str) or not workspace.strip():
        workspace = defaults_workspace
    ws = normalize_path(workspace)
    if not ws:
        continue
    if ws == openclaw_home:
        ws = fallback_workspace
    if ws in seen_ws:
        continue
    seen_ws.add(ws)
    workspaces.append(ws)

if not workspaces:
    workspaces = [defaults_workspace]

print(f"MAIN_AGENT_ID\t{main_agent_id}")
for aid in agent_ids:
    print(f"AGENT_ID\t{aid}")
for ws in workspaces:
    print(f"WORKSPACE\t{ws}")
PY
  )" || die "Failed to resolve agents/workspaces from $OPENCLAW_CONFIG_PATH"

  MAIN_AGENT_ID="main"
  AGENT_IDS=()
  WORKSPACES=()

  while IFS=$'\t' read -r kind value; do
    [[ -n "${kind:-}" && -n "${value:-}" ]] || continue
    case "$kind" in
      MAIN_AGENT_ID) MAIN_AGENT_ID="$value" ;;
      AGENT_ID) AGENT_IDS+=("$value") ;;
      WORKSPACE) WORKSPACES+=("$value") ;;
    esac
  done <<< "$discovered"

  if [[ ${#AGENT_IDS[@]} -eq 0 ]]; then
    AGENT_IDS=("$MAIN_AGENT_ID")
  fi
}

ensure_memory_dirs() {
  local ws
  for ws in "${WORKSPACES[@]}"; do
    [[ -n "$ws" ]] || continue
    mkdir -p "$ws/memory"
  done
  log_success "Prepared memory directories for configured workspaces."
}

MODEL_DIR="${OPENCLAW_MODEL_DIR:-$HOME/.openclaw/models}"
MODEL_FILE_NAME="${OPENCLAW_MEMORY_MODEL_FILE:-embeddinggemma-300M-Q8_0.gguf}"
MODEL_FILE="$MODEL_DIR/$MODEL_FILE_NAME"
MODEL_URL_DEFAULT="https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf"
MODEL_URL="${OPENCLAW_MEMORY_MODEL_URL:-$MODEL_URL_DEFAULT}"
MODEL_PATH_OVERRIDE="${OPENCLAW_MEMORY_MODEL_PATH:-}"
MEMORY_ENABLE_SESSIONS="$(as_bool "${OPENCLAW_MEMORY_ENABLE_SESSIONS:-true}" "true")"
MEMORY_FALLBACK="${OPENCLAW_MEMORY_FALLBACK:-none}"
MEMORY_FORCE_INDEX="$(as_bool "${OPENCLAW_MEMORY_FORCE_INDEX:-false}" "false")"

resolve_model_path() {
  if [[ -n "$MODEL_PATH_OVERRIDE" ]]; then
    if [[ ! -f "$MODEL_PATH_OVERRIDE" ]]; then
      die "OPENCLAW_MEMORY_MODEL_PATH does not exist: $MODEL_PATH_OVERRIDE"
    fi
    printf "%s\n" "$MODEL_PATH_OVERRIDE"
    return 0
  fi

  mkdir -p "$MODEL_DIR"
  if [[ ! -f "$MODEL_FILE" ]]; then
    need_cmd curl
    log_info "Downloading embedding model -> $MODEL_FILE" >&2
    local tmp
    tmp="$MODEL_FILE.tmp"
    curl -fL --retry 3 --retry-delay 1 -o "$tmp" "$MODEL_URL"
    mv "$tmp" "$MODEL_FILE"
  else
    log_info "Embedding model already present: $MODEL_FILE" >&2
  fi
  printf "%s\n" "$MODEL_FILE"
}

configure_memory_search() {
  local model_path="$1"

  set_cfg agents.defaults.compaction.memoryFlush.enabled true json true
  set_cfg agents.defaults.memorySearch.enabled true json true
  set_cfg agents.defaults.memorySearch.provider local string true
  set_cfg agents.defaults.memorySearch.fallback "$MEMORY_FALLBACK" string false
  set_cfg agents.defaults.memorySearch.local.modelPath "$model_path" string true

  if [[ "$MEMORY_ENABLE_SESSIONS" == "true" ]]; then
    set_cfg agents.defaults.memorySearch.sources '["memory","sessions"]' json false
    set_cfg agents.defaults.memorySearch.experimental.sessionMemory true json false
  else
    set_cfg agents.defaults.memorySearch.sources '["memory"]' json false
    set_cfg agents.defaults.memorySearch.experimental.sessionMemory false json false
  fi

  # Background sync + cache/vector acceleration.
  set_cfg agents.defaults.memorySearch.sync.watch true json false
  set_cfg agents.defaults.memorySearch.sync.sessions.deltaBytes 100000 json false
  set_cfg agents.defaults.memorySearch.sync.sessions.deltaMessages 50 json false
  set_cfg agents.defaults.memorySearch.cache.enabled true json false
  set_cfg agents.defaults.memorySearch.cache.maxEntries 50000 json false
  set_cfg agents.defaults.memorySearch.store.vector.enabled true json false

  # Hybrid retrieval tuning: BM25 + vector + diversity + recency.
  set_cfg agents.defaults.memorySearch.query.hybrid.enabled true json false
  set_cfg agents.defaults.memorySearch.query.hybrid.vectorWeight 0.7 json false
  set_cfg agents.defaults.memorySearch.query.hybrid.textWeight 0.3 json false
  set_cfg agents.defaults.memorySearch.query.hybrid.candidateMultiplier 4 json false
  set_cfg agents.defaults.memorySearch.query.hybrid.mmr.enabled true json false
  set_cfg agents.defaults.memorySearch.query.hybrid.mmr.lambda 0.7 json false
  set_cfg agents.defaults.memorySearch.query.hybrid.temporalDecay.enabled true json false
  set_cfg agents.defaults.memorySearch.query.hybrid.temporalDecay.halfLifeDays 30 json false
}

configure_qmd_memory_boost() {
  local backend
  backend="$(openclaw config get memory.backend 2>/dev/null || true)"
  backend="$(printf "%s" "$backend" | tr -d '"' | tr '[:upper:]' '[:lower:]')"
  if [[ "$backend" != "qmd" ]]; then
    return 0
  fi

  log_info "Detected memory.backend=qmd; applying qmd-side tuning."
  set_cfg memory.qmd.includeDefaultMemory true json false
  set_cfg memory.qmd.sessions.enabled true json false
  set_cfg memory.qmd.update.interval "5m" string false
  set_cfg memory.qmd.update.debounceMs 15000 json false
  set_cfg memory.qmd.update.waitForBootSync false json false
  set_cfg memory.qmd.limits.maxResults 6 json false
  set_cfg memory.qmd.limits.timeoutMs 4000 json false
  set_cfg memory.citations auto string false
}

index_agent() {
  local agent_id="$1"
  local max_attempts delay_s attempt rc output
  local -a cmd
  max_attempts="${OPENCLAW_MEMORY_INDEX_MAX_ATTEMPTS:-3}"
  delay_s="${OPENCLAW_MEMORY_INDEX_RETRY_DELAY_SEC:-10}"
  attempt=1

  while [[ "$attempt" -le "$max_attempts" ]]; do
    cmd=(openclaw memory index --agent "$agent_id")
    if [[ "$MEMORY_FORCE_INDEX" == "true" ]]; then
      cmd+=(--force)
      log_info "Running: openclaw memory index --agent $agent_id --force (attempt $attempt/$max_attempts)"
    else
      log_info "Running: openclaw memory index --agent $agent_id (attempt $attempt/$max_attempts)"
    fi
    set +e
    output="$("${cmd[@]}" 2>&1)"
    rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then
      [[ -n "$output" ]] && printf "%s\n" "$output"
      log_success "Memory index refreshed for agent '$agent_id'."
      return 0
    fi

    [[ -n "$output" ]] && printf "%s\n" "$output" >&2
    if printf "%s" "$output" | grep -Eqi 'produced too much output'; then
      log_warn "Indexer output limit hit for '$agent_id'; continuing (QMD background sync may still complete)."
      return 0
    fi
    if printf "%s" "$output" | grep -Eqi 'rate limit|429'; then
      if [[ "$attempt" -lt "$max_attempts" ]]; then
        log_warn "Rate-limited while indexing '$agent_id'. Retrying in ${delay_s}s..."
        sleep "$delay_s"
        delay_s=$((delay_s * 2))
        attempt=$((attempt + 1))
        continue
      fi
    fi
    break
  done

  if [[ "$MEMORY_FORCE_INDEX" == "true" ]]; then
    log_warn "Index refresh failed for agent '$agent_id'. Retry manually: openclaw memory index --agent $agent_id --force"
  else
    log_warn "Index refresh failed for agent '$agent_id'. Retry manually: openclaw memory index --agent $agent_id"
  fi
  return 1
}

refresh_indexes() {
  local scope
  local -a ids
  scope="$(printf "%s" "${OPENCLAW_MEMORY_INDEX_SCOPE:-all}" | tr '[:upper:]' '[:lower:]')"

  if [[ "$scope" == "main" ]]; then
    ids=("${OPENCLAW_MEMORY_AGENT_ID:-$MAIN_AGENT_ID}")
  else
    ids=("$MAIN_AGENT_ID")
    local id
    for id in "${AGENT_IDS[@]}"; do
      [[ -n "$id" ]] || continue
      if [[ "$id" == "$MAIN_AGENT_ID" ]]; then
        continue
      fi
      ids+=("$id")
    done
  fi

  log_info "Refreshing memory indexes for: ${ids[*]} (scope=$scope)"
  local failures=0
  local id
  for id in "${ids[@]}"; do
    index_agent "$id" || failures=$((failures + 1))
  done

  if [[ "$failures" -gt 0 ]]; then
    log_warn "Completed with $failures indexing warning(s)."
  fi
}

print_status() {
  log_info "Current memory status:"
  if ! openclaw memory status --json; then
    log_warn "Failed to query memory status via openclaw memory status --json"
  fi
}

main() {
  log_info "Resolving agents/workspaces from $OPENCLAW_CONFIG_PATH..."
  discover_agents_and_workspaces
  ensure_memory_dirs

  local model_path
  model_path="$(resolve_model_path)"
  configure_memory_search "$model_path"
  configure_qmd_memory_boost
  refresh_indexes
  print_status

  echo ""
  log_success "Local memory setup complete."
  echo "Main agent: $MAIN_AGENT_ID"
  echo "Agent ids: ${AGENT_IDS[*]}"
  echo "Workspaces: ${WORKSPACES[*]}"
  echo "Model path: $model_path"
  echo "Session memory source enabled: $MEMORY_ENABLE_SESSIONS"
}

main "$@"
