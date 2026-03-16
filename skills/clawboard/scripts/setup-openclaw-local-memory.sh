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
#   OPENCLAW_MEMORY_SKIP_INDEX            (true|false, default: false)
#   OPENCLAW_MEMORY_INDEX_SCOPE           (all|main, default: all)
#   OPENCLAW_MEMORY_FORCE_INDEX           (true|false, default: false)
#   OPENCLAW_MEMORY_INDEX_MAX_ATTEMPTS    (default: 3)
#   OPENCLAW_MEMORY_INDEX_RETRY_DELAY_SEC (default: 10)
#   OPENCLAW_MEMORY_INDEX_TIMEOUT_SEC     (default: 180)
#   OPENCLAW_MEMORY_AGENT_ID              (optional override when scope=main)

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

log_info() { echo "info: $1"; }
log_warn() { echo "warn: $1" >&2; }
log_success() { echo "success: $1"; }
die() { echo "error: $1" >&2; exit 1; }

OPENCLAW_DOCTOR_FIX_ATTEMPTED=false

run_doctor_fix_safe() {
  if openclaw doctor --fix --non-interactive --yes >/dev/null 2>&1; then
    return 0
  fi
  if openclaw doctor --fix --non-interactive >/dev/null 2>&1; then
    return 0
  fi
  if openclaw doctor --fix >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

run_doctor_fix_once() {
  if [[ "$OPENCLAW_DOCTOR_FIX_ATTEMPTED" == "true" ]]; then
    return 1
  fi
  OPENCLAW_DOCTOR_FIX_ATTEMPTED=true
  if run_doctor_fix_safe; then
    log_warn "Detected config schema drift; applied openclaw doctor --fix and retrying config writes."
    return 0
  fi
  return 1
}

run_with_timeout_capture() {
  local timeout_s="$1"
  shift
  local output=""
  local rc=0

  if command -v timeout >/dev/null 2>&1; then
    set +e
    output="$(timeout "${timeout_s}s" "$@" 2>&1)"
    rc=$?
    set -e
  elif command -v gtimeout >/dev/null 2>&1; then
    set +e
    output="$(gtimeout "${timeout_s}s" "$@" 2>&1)"
    rc=$?
    set -e
  elif command -v python3 >/dev/null 2>&1; then
    set +e
    output="$(python3 - "$timeout_s" "$@" <<'PY'
import subprocess
import sys

timeout_s = float(sys.argv[1])
cmd = sys.argv[2:]
if not cmd:
    raise SystemExit(1)

try:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    if proc.stdout:
        sys.stdout.write(proc.stdout)
    if proc.stderr:
        sys.stdout.write(proc.stderr)
    raise SystemExit(proc.returncode)
except subprocess.TimeoutExpired as exc:
    stdout = exc.stdout
    stderr = exc.stderr
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", errors="replace")
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", errors="replace")
    if stdout:
        sys.stdout.write(stdout)
    if stderr:
        sys.stdout.write(stderr)
    sys.stdout.write(f"error: command timed out after {int(timeout_s)}s: {' '.join(cmd)}\n")
    raise SystemExit(124)
PY
)"
    rc=$?
    set -e
  else
    set +e
    output="$("$@" 2>&1)"
    rc=$?
    set -e
  fi

  printf "%s" "$output"
  return "$rc"
}

memory_index_output_has_errors() {
  local output="${1:-}"
  if [[ -z "$output" ]]; then
    return 1
  fi
  if grep -Eqi 'qmd collection add failed|sqliteerror|sqlite_constraint|constraint failed' <<<"$output"; then
    return 0
  fi
  return 1
}

normalize_scalar_json_output() {
  local raw="${1:-}"
  raw="$(printf "%s" "$raw" | tr -d '\r' | tail -n1 | tr -d '"' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  printf "%s" "$raw"
}

read_memory_backend() {
  local backend
  backend="$(openclaw config get memory.backend --json 2>/dev/null || true)"
  backend="$(normalize_scalar_json_output "$backend")"
  if [[ -z "$backend" || "$backend" == "null" ]]; then
    if run_doctor_fix_once; then
      backend="$(openclaw config get memory.backend --json 2>/dev/null || true)"
      backend="$(normalize_scalar_json_output "$backend")"
    fi
  fi
  printf "%s" "$backend"
}

CFG_TXN_ACTIVE=false
CFG_TXN_SNAPSHOT=""
declare -a CFG_TXN_KEYS=()
declare -a CFG_TXN_EXPECTED=()
declare -a CFG_TXN_REQUIRED=()

record_cfg_expectation() {
  local key="$1"
  local expected_json="$2"
  local required="$3"
  local i
  for i in "${!CFG_TXN_KEYS[@]}"; do
    if [[ "${CFG_TXN_KEYS[$i]}" == "$key" ]]; then
      CFG_TXN_EXPECTED[$i]="$expected_json"
      if [[ "$required" == "true" ]]; then
        CFG_TXN_REQUIRED[$i]="true"
      fi
      return 0
    fi
  done
  CFG_TXN_KEYS+=("$key")
  CFG_TXN_EXPECTED+=("$expected_json")
  CFG_TXN_REQUIRED+=("$required")
}

begin_cfg_txn() {
  if [[ "$CFG_TXN_ACTIVE" == "true" ]]; then
    return 0
  fi
  ensure_openclaw_config_file || die "OpenClaw config not found at: $OPENCLAW_CONFIG_PATH"
  CFG_TXN_SNAPSHOT="$(mktemp "${OPENCLAW_CONFIG_PATH}.txn.XXXXXX")"
  cp "$OPENCLAW_CONFIG_PATH" "$CFG_TXN_SNAPSHOT"
  CFG_TXN_ACTIVE=true
  CFG_TXN_KEYS=()
  CFG_TXN_EXPECTED=()
  CFG_TXN_REQUIRED=()
  log_info "Started OpenClaw config transaction."
}

rollback_cfg_txn() {
  if [[ "$CFG_TXN_ACTIVE" != "true" ]]; then
    return 0
  fi
  if [[ -n "$CFG_TXN_SNAPSHOT" && -f "$CFG_TXN_SNAPSHOT" ]]; then
    cp "$CFG_TXN_SNAPSHOT" "$OPENCLAW_CONFIG_PATH"
    log_warn "Rolled back OpenClaw config transaction."
  fi
  CFG_TXN_ACTIVE=false
  CFG_TXN_KEYS=()
  CFG_TXN_EXPECTED=()
  CFG_TXN_REQUIRED=()
}

commit_cfg_txn() {
  if [[ "$CFG_TXN_ACTIVE" != "true" ]]; then
    return 0
  fi
  CFG_TXN_ACTIVE=false
  if [[ -n "$CFG_TXN_SNAPSHOT" && -f "$CFG_TXN_SNAPSHOT" ]]; then
    rm -f "$CFG_TXN_SNAPSHOT"
  fi
  CFG_TXN_SNAPSHOT=""
  CFG_TXN_KEYS=()
  CFG_TXN_EXPECTED=()
  CFG_TXN_REQUIRED=()
  log_success "Committed OpenClaw config transaction."
}

parse_json_payload() {
  local raw="${1:-}"
  python3 - "$raw" <<'PY'
import json
import sys

raw = sys.argv[1]
if not raw.strip():
    raise SystemExit(1)

decoder = json.JSONDecoder()
text = raw.strip()

try:
    obj = json.loads(text)
except Exception:
    obj = None
    starts = "{[\"-0123456789tfn"
    for idx, ch in enumerate(text):
        if ch not in starts:
            continue
        try:
            candidate, _ = decoder.raw_decode(text[idx:])
            obj = candidate
        except Exception:
            continue
    if obj is None:
        raise SystemExit(1)

print(json.dumps(obj, separators=(",", ":"), sort_keys=True))
PY
}

cfg_get_json() {
  local key="$1"
  openclaw config get "$key" --json 2>/dev/null || true
}

cfg_output_has_unsupported_key() {
  local msg="${1:-}"
  if printf "%s" "$msg" | grep -Eqi 'unrecognized key|unknown config key|unknown config keys'; then
    return 0
  fi
  return 1
}

set_cfg_file_fallback() {
  local key="$1"
  local value="$2"
  local mode="${3:-string}" # string | json
  python3 - "$OPENCLAW_CONFIG_PATH" "$key" "$value" "$mode" <<'PY'
import json
import os
import sys
import tempfile

cfg_path, key, raw_value, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
parts = [p for p in key.split(".") if p]
if not parts:
    raise SystemExit(1)

try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}

if mode == "json":
    value = json.loads(raw_value)
else:
    value = raw_value

cur = data
for idx, part in enumerate(parts):
    is_last = idx == len(parts) - 1
    next_part = parts[idx + 1] if not is_last else None
    want_list = bool(next_part and next_part.isdigit())

    if isinstance(cur, dict):
        if is_last:
            cur[part] = value
            break
        child = cur.get(part)
        if want_list:
            if not isinstance(child, list):
                child = []
                cur[part] = child
        else:
            if not isinstance(child, dict):
                child = {}
                cur[part] = child
        cur = child
        continue

    if isinstance(cur, list):
        if not part.isdigit():
            raise SystemExit(1)
        list_idx = int(part)
        while len(cur) <= list_idx:
            cur.append([] if want_list else {})
        if is_last:
            cur[list_idx] = value
            break
        child = cur[list_idx]
        if want_list:
            if not isinstance(child, list):
                child = []
                cur[list_idx] = child
        else:
            if not isinstance(child, dict):
                child = {}
                cur[list_idx] = child
        cur = child
        continue

    raise SystemExit(1)

cfg_dir = os.path.dirname(cfg_path) or "."
fd, tmp_path = tempfile.mkstemp(prefix=".openclaw.json.tmp.", dir=cfg_dir, text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp_path, cfg_path)
finally:
    if os.path.exists(tmp_path):
        os.unlink(tmp_path)
PY
}

cfg_file_fallback_enabled() {
  local raw
  raw="$(printf "%s" "${OPENCLAW_CONFIG_FILE_FALLBACK:-true}" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    0|false|no|off) return 1 ;;
    *) return 0 ;;
  esac
}

seed_minimal_openclaw_config() {
  local workspace="$1"
  local tmp
  tmp="$(mktemp "${OPENCLAW_CONFIG_PATH}.seed.XXXXXX")" || return 1
  if ! python3 - "$tmp" "$workspace" <<'PY'; then
import json
import os
import sys

path = sys.argv[1]
workspace = os.path.abspath(os.path.expanduser(sys.argv[2] or ""))
if not workspace:
    raise SystemExit(1)

data = {
    "agents": {
        "defaults": {"workspace": workspace},
        "list": [{"id": "main", "default": True, "workspace": workspace}],
    }
}

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
    rm -f "$tmp" >/dev/null 2>&1 || true
    return 1
  fi
  mv -f "$tmp" "$OPENCLAW_CONFIG_PATH"
}

ensure_openclaw_config_file() {
  if [[ -f "$OPENCLAW_CONFIG_PATH" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$OPENCLAW_CONFIG_PATH")"
  if openclaw doctor --fix >/dev/null 2>&1; then
    if [[ -f "$OPENCLAW_CONFIG_PATH" ]]; then
      log_info "Initialized OpenClaw config via openclaw doctor --fix."
      return 0
    fi
  fi
  openclaw config get agents.defaults.workspace --json >/dev/null 2>&1 || true
  if [[ -f "$OPENCLAW_CONFIG_PATH" ]]; then
    log_info "Initialized OpenClaw config via openclaw config command."
    return 0
  fi

  local workspace="$OPENCLAW_HOME/workspace"
  mkdir -p "$workspace"
  if seed_minimal_openclaw_config "$workspace"; then
    log_warn "OpenClaw config was missing; wrote minimal config at $OPENCLAW_CONFIG_PATH."
    return 0
  fi

  return 1
}

verify_cfg_txn() {
  if [[ "$CFG_TXN_ACTIVE" != "true" ]]; then
    return 0
  fi
  local i key expected required actual_raw expected_norm actual_norm
  for i in "${!CFG_TXN_KEYS[@]}"; do
    key="${CFG_TXN_KEYS[$i]}"
    expected="${CFG_TXN_EXPECTED[$i]}"
    required="${CFG_TXN_REQUIRED[$i]}"
    actual_raw="$(cfg_get_json "$key")"
    expected_norm="$(parse_json_payload "$expected" 2>/dev/null || true)"
    actual_norm="$(parse_json_payload "$actual_raw" 2>/dev/null || true)"
    if [[ -n "$expected_norm" && -n "$actual_norm" && "$expected_norm" == "$actual_norm" ]]; then
      continue
    fi
    if [[ "$required" == "true" ]]; then
      rollback_cfg_txn
      die "Config verification failed for required key: $key"
    fi
    log_warn "Config verification failed for optional key: $key"
  done
}

cleanup_cfg_txn_on_exit() {
  local rc=$?
  if [[ "$CFG_TXN_ACTIVE" == "true" ]]; then
    rollback_cfg_txn || true
  fi
  if [[ -n "$CFG_TXN_SNAPSHOT" && -f "$CFG_TXN_SNAPSHOT" ]]; then
    rm -f "$CFG_TXN_SNAPSHOT" || true
    CFG_TXN_SNAPSHOT=""
  fi
  return "$rc"
}

set_cfg() {
  local key="$1"
  local value="$2"
  local mode="${3:-string}"     # string | json
  local required="${4:-true}"   # true | false
  local allow_file_fallback="${5:-}"
  local expected_json=""
  local actual_raw expected_norm actual_norm
  local cmd=(openclaw config set "$key" "$value")
  local cmd_output=""

  if [[ -z "$allow_file_fallback" ]]; then
    allow_file_fallback="$required"
  fi

  begin_cfg_txn
  if [[ "$mode" == "json" ]]; then
    cmd+=(--json)
    expected_json="$value"
  else
    expected_json="$(python3 - "$value" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1]))
PY
)"
  fi
  if cmd_output="$("${cmd[@]}" 2>&1)"; then
    log_info "set $key"
    record_cfg_expectation "$key" "$expected_json" "$required"
    return 0
  fi
  if run_doctor_fix_once && cmd_output="$("${cmd[@]}" 2>&1)"; then
    log_info "set $key"
    record_cfg_expectation "$key" "$expected_json" "$required"
    return 0
  fi
  if cfg_output_has_unsupported_key "$cmd_output"; then
    if [[ "$required" == "true" ]]; then
      rollback_cfg_txn
      die "Required config key is unsupported by this OpenClaw version: $key"
    fi
    log_warn "Skipping optional unsupported config key: $key"
    return 1
  fi
  if [[ "$allow_file_fallback" == "true" ]] && cfg_file_fallback_enabled && set_cfg_file_fallback "$key" "$value" "$mode"; then
    log_warn "set $key via direct config file fallback after CLI set failure."
    record_cfg_expectation "$key" "$expected_json" "$required"
    return 0
  fi
  # Some OpenClaw builds may return non-zero while still persisting the value.
  actual_raw="$(cfg_get_json "$key")"
  expected_norm="$(parse_json_payload "$expected_json" 2>/dev/null || true)"
  actual_norm="$(parse_json_payload "$actual_raw" 2>/dev/null || true)"
  if [[ -n "$expected_norm" && -n "$actual_norm" && "$expected_norm" == "$actual_norm" ]]; then
    log_warn "set $key reported failure but desired value is already present; continuing."
    record_cfg_expectation "$key" "$expected_json" "$required"
    return 0
  fi
  if [[ "$required" == "true" ]]; then
    rollback_cfg_txn
    die "Failed to set required config key: $key"
  fi
  log_warn "Could not set optional key (likely unsupported on this OpenClaw version): $key"
}

# run_cfg_set is an alias for set_cfg — same signature: (key, value, mode, required)
run_cfg_set() { set_cfg "$@"; }

OPENCLAW_VERSION_RAW=""
OPENCLAW_SUPPORTS_LOOP_DETECTION=""

openclaw_version_raw() {
  if [[ -n "$OPENCLAW_VERSION_RAW" ]]; then
    printf "%s\n" "$OPENCLAW_VERSION_RAW"
    return 0
  fi
  OPENCLAW_VERSION_RAW="$(openclaw --version 2>/dev/null | tr '\r' '\n' | sed -n '1p' | tr -d '[:space:]')"
  printf "%s\n" "$OPENCLAW_VERSION_RAW"
}

openclaw_supports_loop_detection() {
  if [[ -n "$OPENCLAW_SUPPORTS_LOOP_DETECTION" ]]; then
    printf "%s\n" "$OPENCLAW_SUPPORTS_LOOP_DETECTION"
    return 0
  fi
  local ver
  ver="$(openclaw_version_raw)"
  OPENCLAW_SUPPORTS_LOOP_DETECTION="$(
    python3 - "$ver" <<'PY'
import re
import sys

raw = (sys.argv[1] or "").strip()
m = re.search(r"(\d+)\.(\d+)\.(\d+)", raw)
if not m:
    print("false")
    raise SystemExit(0)
major, minor, patch = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
print("true" if (major, minor, patch) >= (2026, 3, 0) else "false")
PY
  )"
  printf "%s\n" "$OPENCLAW_SUPPORTS_LOOP_DETECTION"
}

sanitize_openclaw_config_schema() {
  if run_doctor_fix_safe; then
    log_info "OpenClaw config schema sanitized for current CLI version."
  else
    log_warn "Could not auto-sanitize OpenClaw config schema (openclaw doctor --fix failed)."
  fi
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
trap cleanup_cfg_txn_on_exit EXIT

need_cmd openclaw
need_cmd python3

MAIN_AGENT_ID="main"
declare -a AGENT_IDS=()
declare -a WORKSPACES=()
MAIN_ALLOW_AGENTS_JSON='[]'

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
MEMORY_SKIP_INDEX="$(as_bool "${OPENCLAW_MEMORY_SKIP_INDEX:-false}" "false")"
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
  local backend="${2:-}"

  # Optional across OpenClaw versions: some builds do not expose memoryFlush.
  # Keep best-effort so bootstrap remains portable/idempotent instead of hard-failing.
  set_cfg agents.defaults.compaction.memoryFlush.enabled true json false
  set_cfg agents.defaults.memorySearch.enabled true json true
  set_cfg agents.defaults.memorySearch.provider local string true
  set_cfg agents.defaults.memorySearch.fallback "$MEMORY_FALLBACK" string false
  set_cfg agents.defaults.memorySearch.local.modelPath "$model_path" string true

  if [[ "$MEMORY_ENABLE_SESSIONS" == "true" && "$backend" != "qmd" ]]; then
    set_cfg agents.defaults.memorySearch.sources '["memory","sessions"]' json true
    set_cfg agents.defaults.memorySearch.experimental.sessionMemory true json true
  else
    set_cfg agents.defaults.memorySearch.sources '["memory"]' json true
    set_cfg agents.defaults.memorySearch.experimental.sessionMemory false json true
    if [[ "$MEMORY_ENABLE_SESSIONS" == "true" && "$backend" == "qmd" ]]; then
      log_warn "Requested session memory source, but memory.backend=qmd is active; using memory-only source to match effective runtime behavior."
    fi
  fi

  # Background sync + cache/vector acceleration.
  set_cfg agents.defaults.memorySearch.sync.watch true json false
  set_cfg agents.defaults.memorySearch.sync.sessions.deltaBytes 100000 json false
  set_cfg agents.defaults.memorySearch.sync.sessions.deltaMessages 50 json false
  set_cfg agents.defaults.memorySearch.cache.enabled true json false
  set_cfg agents.defaults.memorySearch.cache.maxEntries 50000 json false
  set_cfg agents.defaults.memorySearch.store.vector.enabled true json false

  # Hybrid retrieval tuning: BM25 + vector weighting and candidate expansion.
  # Note: older tuning keys under `hybrid.mmr.*` and `hybrid.temporalDecay.*`
  # are no longer recognized by current OpenClaw config schema.
  set_cfg agents.defaults.memorySearch.query.hybrid.enabled true json false
  set_cfg agents.defaults.memorySearch.query.hybrid.vectorWeight 0.7 json false
  set_cfg agents.defaults.memorySearch.query.hybrid.textWeight 0.3 json false
  set_cfg agents.defaults.memorySearch.query.hybrid.candidateMultiplier 4 json false
}

configure_qmd_memory_boost() {
  local backend="${1:-}"
  if [[ "$backend" != "qmd" ]]; then
    return 0
  fi

  log_info "Detected memory.backend=qmd; applying qmd-side tuning."
  set_cfg memory.qmd.includeDefaultMemory true json true
  # Keep session transcripts out of QMD. We intentionally route continuity/state recovery
  # through Clawboard context/search, while QMD remains documentation/thinking-vault focused.
  # This avoids session transcript chunks crowding out documentation recall.
  set_cfg memory.qmd.sessions.enabled false json true
  set_cfg memory.qmd.update.interval "5m" string false
  set_cfg memory.qmd.update.debounceMs 15000 json false
  # Run the embed pass on the same cadence as the update pass so new files get
  # vector embeddings automatically. "0" disables automatic embedding — avoid it.
  set_cfg memory.qmd.update.embedInterval "5m" string false
  # 20 results gives enough headroom for documentation across 5 thinking vaults.
  set_cfg memory.qmd.limits.maxResults 20 json true
  # 8 s timeout gives QMD time to rank across large vaults without blocking chat.
  set_cfg memory.qmd.limits.timeoutMs 8000 json true
  set_cfg memory.citations auto string false
}

configure_tool_loop_detection() {
  if [[ "$(openclaw_supports_loop_detection)" != "true" ]]; then
    log_warn "Skipping tools.loopDetection writes: unsupported by OpenClaw $(openclaw_version_raw)."
    return 0
  fi

  # OpenClaw tool-loop guardrails are disabled by default.
  # Enable conservative defaults to stop repeated no-progress retries
  # (for example unknown tool name loops like run/exec in main-agent turns).
  set_cfg tools.loopDetection.enabled true json false
  set_cfg tools.loopDetection.historySize 30 json false
  set_cfg tools.loopDetection.warningThreshold 3 json false
  set_cfg tools.loopDetection.criticalThreshold 6 json false
  set_cfg tools.loopDetection.globalCircuitBreakerThreshold 9 json false
  set_cfg tools.loopDetection.detectors.genericRepeat true json false
  set_cfg tools.loopDetection.detectors.knownPollNoProgress true json false
  set_cfg tools.loopDetection.detectors.pingPong true json false

  local enabled_norm
  enabled_norm="$(normalize_scalar_json_output "$(cfg_get_json tools.loopDetection.enabled)")"
  if [[ "$enabled_norm" == "true" ]]; then
    log_success "Global tool-loop detection configured."
    return 0
  fi

  # Best-effort fallback for older/legacy OpenClaw schemas.
  set_cfg tools.loopDetection.detectorCooldownMs 12000 json false
  set_cfg tools.loopDetection.repeatThreshold 3 json false
  set_cfg tools.loopDetection.detectors.repeatedFailure true json false
  set_cfg tools.loopDetection.detectors.knownPollLoop true json false
  set_cfg tools.loopDetection.detectors.repeatingNoProgress true json false

  enabled_norm="$(normalize_scalar_json_output "$(cfg_get_json tools.loopDetection.enabled)")"
  if [[ "$enabled_norm" == "true" ]]; then
    log_success "Legacy-compatible tool-loop detection configured."
  else
    log_warn "Could not verify tools.loopDetection.enabled=true on this OpenClaw version."
  fi
}

index_agent() {
  local agent_id="$1"
  local max_attempts delay_s attempt rc output timeout_s
  local -a cmd
  max_attempts="${OPENCLAW_MEMORY_INDEX_MAX_ATTEMPTS:-3}"
  delay_s="${OPENCLAW_MEMORY_INDEX_RETRY_DELAY_SEC:-10}"
  timeout_s="${OPENCLAW_MEMORY_INDEX_TIMEOUT_SEC:-180}"
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
    output="$(run_with_timeout_capture "$timeout_s" "${cmd[@]}")"
    rc=$?
    set -e
    if [[ "$rc" -eq 0 ]] && ! memory_index_output_has_errors "$output"; then
      [[ -n "$output" ]] && printf "%s\n" "$output"
      log_success "Memory index refreshed for agent '$agent_id'."
      return 0
    fi

    [[ -n "$output" ]] && printf "%s\n" "$output" >&2
    if memory_index_output_has_errors "$output"; then
      if [[ "$attempt" -lt "$max_attempts" ]]; then
        log_warn "Indexer output reported qmd/sqlite errors for '$agent_id'. Retrying in ${delay_s}s..."
        sleep "$delay_s"
        delay_s=$((delay_s * 2))
        attempt=$((attempt + 1))
        continue
      fi
      break
    fi
    if [[ "$rc" -eq 124 ]]; then
      if [[ "$attempt" -lt "$max_attempts" ]]; then
        log_warn "Index refresh timed out for '$agent_id' after ${timeout_s}s. Retrying in ${delay_s}s..."
        sleep "$delay_s"
        delay_s=$((delay_s * 2))
        attempt=$((attempt + 1))
        continue
      fi
      break
    fi
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
  local timeout_s="${OPENCLAW_MEMORY_STATUS_TIMEOUT_SEC:-20}"
  local out_file err_file pid elapsed rc
  out_file="$(mktemp "${OPENCLAW_HOME}/.memory-status.out.XXXXXX")"
  err_file="$(mktemp "${OPENCLAW_HOME}/.memory-status.err.XXXXXX")"

  openclaw memory status --json >"$out_file" 2>"$err_file" &
  pid=$!
  elapsed=0
  while kill -0 "$pid" >/dev/null 2>&1; do
    if [[ "$elapsed" -ge "$timeout_s" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      sleep 1
      kill -9 "$pid" >/dev/null 2>&1 || true
      log_warn "Timed out while querying memory status (>${timeout_s}s)."
      rm -f "$out_file" "$err_file"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  set +e
  wait "$pid"
  rc=$?
  set -e

  if [[ -s "$out_file" ]]; then
    cat "$out_file"
  fi
  if [[ -s "$err_file" ]]; then
    cat "$err_file" >&2
  fi
  rm -f "$out_file" "$err_file"

  if [[ "$rc" -ne 0 ]]; then
    log_warn "Failed to query memory status via openclaw memory status --json"
  fi
}

configure_main_agent_tools() {
  # Set the main agent's tool policy to explicitly allow delegation + memory tools.
  # Uses an explicit allow list — do NOT set profile:minimal here.
  # profile:minimal only grants session_status and intersects (not unions) with allow,
  # which silently blocks sessions_spawn and breaks all delegation.
  # Find the main agent index in the JSON config
  local main_idx
  main_idx="$(python3 - "$OPENCLAW_CONFIG_PATH" "$MAIN_AGENT_ID" <<'PY'
import json, sys
path, main_id = sys.argv[1], sys.argv[2]
with open(path) as f:
    cfg = json.load(f)
for i, a in enumerate(cfg.get("agents", {}).get("list", [])):
    if str(a.get("id","")).strip().lower() == main_id.strip().lower():
        print(i)
        break
PY
)" || true
  if [[ -z "$main_idx" ]]; then
    log_warn "Could not find main agent ($MAIN_AGENT_ID) index — skipping tool policy configuration."
    return 0
  fi

  local base="agents.list.${main_idx}"
  local allow_agents_json
  log_info "Configuring main agent tool policy (index $main_idx)..."

  # Cross-agent supervision only works reliably when session tools can see across
  # agent boundaries and sandbox clamping does not silently reduce that scope.
  run_cfg_set "tools.sessions.visibility" "all" string true
  run_cfg_set "tools.agentToAgent.enabled" true json true
  run_cfg_set "agents.defaults.sandbox.sessionToolsVisibility" "all" string true

  # Keep main delegation targets aligned with actual configured agents.
  # This allows an elastic specialist pool without hardcoding ids in this script.
  allow_agents_json="$(
    python3 - "$MAIN_AGENT_ID" "${AGENT_IDS[@]}" <<'PY'
import json
import sys

main_id = (sys.argv[1] or "").strip().lower()
out = []
seen = set()
for raw in sys.argv[2:]:
    item = (raw or "").strip()
    if not item:
        continue
    low = item.lower()
    if low == main_id:
        continue
    if low in seen:
        continue
    seen.add(low)
    out.append(item)
print(json.dumps(out, separators=(",", ":")))
PY
  )"
  allow_agents_json="${allow_agents_json//$'\r'/}"
  [[ -n "$allow_agents_json" ]] || allow_agents_json='[]'
  MAIN_ALLOW_AGENTS_JSON="$allow_agents_json"

  run_cfg_set "${base}.subagents.allowAgents" "$allow_agents_json" json true

  # Explicit allow: delegation + memory + Clawboard ledger + image inspection for staged attachments.
  # cron allows durable one-shot follow-up jobs per delegation.
  # image lets main inspect screenshot-style attachments directly inside its own workspace.
  # clawboard_* tools allow reading/writing the external topic ledger for restart-resilient state recovery.
  run_cfg_set "${base}.tools.allow" \
    '["sessions_spawn","sessions_list","sessions_send","session_status","memory_search","memory_get","cron","image","clawboard_search","clawboard_update_topic","clawboard_get_topic","clawboard_update_task","clawboard_context","clawboard_get_task"]' \
    json true

  # Deny filesystem, runtime, web, UI, gateway, nodes, messaging.
  # Note: group:automation (cron+gateway) is split — gateway denied, cron allowed above.
  run_cfg_set "${base}.tools.deny" \
    '["group:fs","group:runtime","group:web","group:ui","gateway","group:nodes","group:messaging"]' \
    json true

  run_cfg_set "${base}.tools.elevated.enabled" false json true

  if [[ "$(openclaw_supports_loop_detection)" == "true" ]]; then
    # Main agent is most sensitive to orchestration loops. Use tighter thresholds
    # than global defaults so repeated no-progress tool calls are stopped quickly.
    run_cfg_set "${base}.tools.loopDetection.enabled" true json false
    run_cfg_set "${base}.tools.loopDetection.historySize" 20 json false
    run_cfg_set "${base}.tools.loopDetection.warningThreshold" 2 json false
    run_cfg_set "${base}.tools.loopDetection.criticalThreshold" 4 json false
    run_cfg_set "${base}.tools.loopDetection.globalCircuitBreakerThreshold" 6 json false
    run_cfg_set "${base}.tools.loopDetection.detectors.genericRepeat" true json false
    run_cfg_set "${base}.tools.loopDetection.detectors.knownPollNoProgress" true json false
    run_cfg_set "${base}.tools.loopDetection.detectors.pingPong" true json false
  else
    log_info "Skipping main-agent loopDetection overrides on unsupported OpenClaw version."
  fi

  # Heartbeat: 5m interval as a durable sweep. Per-delegation follow-up cadence is
  # model-driven via cron ladder (1m, 3m, 10m, 15m, 30m, 1h).
  run_cfg_set "${base}.heartbeat.every" "5m" string true
  run_cfg_set "${base}.heartbeat.target" "last" string true
  run_cfg_set "${base}.heartbeat.prompt" \
    "Heartbeat: (1) read the Clawboard context already injected at the top of this prompt — if any task has status 'doing' and a tag like 'session:<key>', that's an in-flight delegation; (2) call clawboard_search(\"delegating\") as a backup sweep; (3) for each tagged child session key, call session_status(sessionKey=<childSessionKey>); (4) enforce follow-up ladder 1m->3m->10m->15m->30m->1h (cap 1h): each in-flight delegation must have a one-shot cron follow-up and the next wait must come from this ladder; (5) if any queued sub-agent completion message is present, treat it as an internal supervision wake-up, read the current task thread first, and if the result is already visible there, do not restate or paraphrase the full body or re-dispatch the same specialists; if sibling specialists from the same workflow are still active, keep partial results internal unless they change the user's next decision or the user has gone >5m without a visible update; do not send a user-facing message that only says you are checking or waiting on the remaining specialists; close the loop with validation, key delta/caveats, and a clear satisfied-or-blocked status; (6) if any tagged run is missing or terminal without a relayed result: re-spawn and reset follow-up to +1m; (7) if any run is still active beyond 5 minutes, send the user a brief status update with next check ETA; if nothing materially changed and the last visible status is newer than 5 minutes, do not send another status-only update. If nothing needs attention, reply HEARTBEAT_OK." \
    string true
  run_cfg_set "${base}.heartbeat.ackMaxChars" 300 json true

  log_success "Main agent tool policy configured."
}

ensure_watchdog_cron() {
  # Upsert a persistent sub-agent watchdog cron job in ~/.openclaw/cron/jobs.json.
  # This job fires every 5 minutes in the main session. It checks tagged child
  # session keys with session_status plus clawboard_search("delegating") so it can
  # recover lost delegations even after
  # a gateway restart — pure infrastructure, survives inference failures.
  # Idempotent: removes any existing watchdog and writes the current version.
  local cron_dir="${OPENCLAW_HOME}/cron"
  local cron_file="${cron_dir}/jobs.json"

  mkdir -p "$cron_dir"

  if [ ! -f "$cron_file" ]; then
    echo '{"version":1,"jobs":[]}' > "$cron_file"
  fi

  log_info "Upserting sub-agent watchdog cron job in $cron_file..."
  python3 - "$cron_file" "$MAIN_AGENT_ID" <<'PY'
import json, sys, uuid, time

cron_file, agent_id = sys.argv[1], sys.argv[2]
with open(cron_file) as f:
    data = json.load(f)

if isinstance(data, list):
    jobs = data
    data = {"version": 1, "jobs": jobs}
else:
    jobs = data.setdefault("jobs", [])

# Remove any existing watchdog (upsert — ensures payload stays current on re-runs)
jobs[:] = [j for j in jobs if "watchdog" not in j.get("name", "").lower()]

now_ms = int(time.time() * 1000)
watchdog_text = (
    "WATCHDOG RECOVERY:\n"
    "1. Call clawboard_search(\"delegating\") to find all topics tagged \"delegating\" in Clawboard.\n"
    "2. For each Clawboard topic with status \"doing\": extract childSessionKey from tag starting with \"session:\", "
    "extract agentId from tag starting with \"agent:\". Call session_status(childSessionKey). "
    "COMPLETE (queued sub-agent result already arrived): treat this as an internal supervision wake-up, not a fresh user request; read the current topic thread before any extra tool call or ledger write; if the result is already visible there, do not restate or paraphrase the full body or re-dispatch the same specialists; validate the work, add only the key delta/caveats, clawboard_update_topic(topicId, { status: \"done\", tags: [] }), and close the loop with the user. "
    "STILL RUNNING: send brief status if >5 minutes and include next check ETA from ladder [1,3,10,15,30,60] minutes. "
    "LOST (session missing or terminal without relayed output): sessions_spawn(agentId, originalTask), "
    "clawboard_update_topic(topicId, { tags: [\"delegating\",\"agent:<agentId>\",\"session:<newKey>\"] }), "
    "cron.add new follow-up at +1 minute and continue ladder progression.\n"
    "3. If a queued sub-agent completion message is present at wake-up, treat it as internal supervision rather than a fresh user request; read the current topic thread first; if the result is already visible there, do not parrot it back or re-dispatch the same specialists; if sibling specialists from the same workflow are still active, keep partial results internal unless they change the user's next decision or the user has gone >5m without a visible update; do not send a user-facing message that only says you are checking or waiting on the rest; add only the supervisor delta, clear delegation tags, and close the loop.\n"
    "If nothing needs attention, reply HEARTBEAT_OK."
  )
jobs.append({
    "id": str(uuid.uuid4()),
    "name": "sub-agent-watchdog",
    "enabled": True,
    "createdAtMs": now_ms,
    "updatedAtMs": now_ms,
    "agentId": agent_id,
    "schedule": {"kind": "every", "everyMs": 300000, "anchorMs": now_ms},
    "sessionTarget": "main",
    "wakeMode": "now",
    "payload": {
        "kind": "systemEvent",
        "text": watchdog_text
    }
})

with open(cron_file, "w") as f:
    json.dump(data, f, indent=2)

print(f"Watchdog cron job upserted in {cron_file}")
PY
  log_success "Sub-agent watchdog cron job upserted (every 5m, main session, Clawboard-aware)."
}

main() {
  ensure_openclaw_config_file || die "OpenClaw config not found at: $OPENCLAW_CONFIG_PATH"
  sanitize_openclaw_config_schema
  log_info "Resolving agents/workspaces from $OPENCLAW_CONFIG_PATH..."
  discover_agents_and_workspaces
  ensure_memory_dirs

  local backend
  backend="$(read_memory_backend)"

  local model_path
  model_path="$(resolve_model_path)"
  configure_memory_search "$model_path" "$backend"
  configure_qmd_memory_boost "$backend"
  configure_tool_loop_detection
  configure_main_agent_tools
  verify_cfg_txn
  commit_cfg_txn
  # ensure_watchdog_cron is intentionally omitted: the main agent's built-in heartbeat
  # (heartbeat.every: 5m in openclaw.json) already runs the same watchdog sweep once per
  # tick. Adding a separate cron with payload.kind=systemEvent on a main-session target
  # causes triple-delivery per tick (systemEvent injects twice + heartbeat once), generating
  # unnecessary background noise without any additional recovery coverage.
  if [[ "$MEMORY_SKIP_INDEX" == "true" ]]; then
    log_info "Skipping memory index refresh (OPENCLAW_MEMORY_SKIP_INDEX=true)."
  else
    refresh_indexes
  fi
  print_status

  echo ""
  log_success "Local memory setup complete."
  echo "Main agent: $MAIN_AGENT_ID"
  echo "Agent ids: ${AGENT_IDS[*]}"
  echo "Workspaces: ${WORKSPACES[*]}"
  echo "Model path: $model_path"
  echo "Session memory source requested: $MEMORY_ENABLE_SESSIONS"
  if [[ "$backend" == "qmd" ]]; then
    echo "Session memory source effective: false (memory.backend=qmd + memory.qmd.sessions.enabled=false)"
  else
    echo "Session memory source effective: $MEMORY_ENABLE_SESSIONS"
  fi
  echo "Main allowAgents: $MAIN_ALLOW_AGENTS_JSON"
  echo ""
  echo "Delegation tools: sessions_spawn, session_status, sessions_list, sessions_send, cron"
  echo "Clawboard ledger tools: clawboard_search, clawboard_update_topic, clawboard_get_topic, clawboard_update_task, clawboard_context, clawboard_get_task"
  echo "Delegation check-in cadence: 1m -> 3m -> 10m -> 15m -> 30m -> 1h (cap 1h; >5m user updates)"
  echo "Follow-up guarantee: heartbeat watchdog + session-start clawboard_search + delegation cron ladder"
}

main "$@"
