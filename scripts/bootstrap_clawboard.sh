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

run_with_timeout_capture() {
  local timeout_s="$1"
  shift
  local rc=0
  local output=""

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

  if [ -n "$output" ]; then
    printf "%s\n" "$output"
  fi
  return "$rc"
}

memory_index_output_has_errors() {
  local output="${1:-}"
  if [ -z "$output" ]; then
    return 1
  fi
  if grep -Eqi 'qmd collection add failed|sqliteerror|sqlite_constraint|constraint failed' <<<"$output"; then
    return 0
  fi
  return 1
}

# Canonical docs copied into main workspace during bootstrap so shipped policy/docs stay
# aligned with repo source of truth on every machine.
CLAWBOARD_CONTRACT_DOCS=(
  "ANATOMY.md"
  "CONTEXT.md"
  "CLASSIFICATION.md"
  "OPENCLAW_CLAWBOARD_UML.md"
  "TESTING.md"
)

REPO_URL="${CLAWBOARD_REPO_URL:-https://github.com/sirouk/clawboard}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
if [ "$OPENCLAW_HOME" != "/" ]; then
  OPENCLAW_HOME="${OPENCLAW_HOME%/}"
fi
OPENCLAW_CONFIG_PATH="$OPENCLAW_HOME/openclaw.json"
OPENCLAW_SKILLS_DIR="$OPENCLAW_HOME/skills"

OPENCLAW_CFG_TXN_ACTIVE=false
OPENCLAW_CFG_TXN_SNAPSHOT=""
declare -a OPENCLAW_CFG_TXN_KEYS=()
declare -a OPENCLAW_CFG_TXN_EXPECTED=()
declare -a OPENCLAW_CFG_TXN_REQUIRED=()
OPENCLAW_DOCTOR_FIX_ATTEMPTED=false

openclaw_doctor_fix_safe() {
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

seed_minimal_openclaw_config() {
  local workspace="${1:-}"
  local tmp
  tmp="$(mktemp "${OPENCLAW_CONFIG_PATH}.seed.XXXXXX")" || return 1
  if command -v python3 >/dev/null 2>&1; then
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
  else
    printf '{\n  "agents": {\n    "defaults": {\n      "workspace": "%s"\n    },\n    "list": [\n      {\n        "id": "main",\n        "default": true,\n        "workspace": "%s"\n      }\n    ]\n  }\n}\n' "$workspace" "$workspace" >"$tmp" || {
      rm -f "$tmp" >/dev/null 2>&1 || true
      return 1
    }
  fi
  mv -f "$tmp" "$OPENCLAW_CONFIG_PATH"
}

ensure_openclaw_config_file() {
  if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$OPENCLAW_CONFIG_PATH")"

  if command -v openclaw >/dev/null 2>&1; then
    openclaw doctor --fix >/dev/null 2>&1 || true
    if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
      log_info "Initialized OpenClaw config via openclaw doctor --fix."
      return 0
    fi
    openclaw config get agents.defaults.workspace --json >/dev/null 2>&1 || true
    if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
      log_info "Initialized OpenClaw config via openclaw config command."
      return 0
    fi
  fi

  local workspace="${OPENCLAW_WORKSPACE_DIR:-}"
  if [ -z "$workspace" ]; then
    workspace="$(resolve_default_openclaw_workspace_root)"
  fi
  workspace="${workspace/#\~/$HOME}"
  mkdir -p "$workspace"
  if seed_minimal_openclaw_config "$workspace"; then
    log_warn "OpenClaw config was missing; wrote minimal bootstrap config at $OPENCLAW_CONFIG_PATH."
    return 0
  fi

  return 1
}

openclaw_doctor_fix_once() {
  if [ "$OPENCLAW_DOCTOR_FIX_ATTEMPTED" = true ]; then
    return 1
  fi
  OPENCLAW_DOCTOR_FIX_ATTEMPTED=true
  if openclaw_doctor_fix_safe; then
    log_warn "Detected config schema drift; applied openclaw doctor --fix and retrying config writes."
    return 0
  fi
  return 1
}

openclaw_cfg_txn_record_expectation() {
  local key="$1"
  local expected_json="$2"
  local required="$3"
  local i
  for i in "${!OPENCLAW_CFG_TXN_KEYS[@]}"; do
    if [ "${OPENCLAW_CFG_TXN_KEYS[$i]}" = "$key" ]; then
      OPENCLAW_CFG_TXN_EXPECTED[$i]="$expected_json"
      if [ "$required" = true ]; then
        OPENCLAW_CFG_TXN_REQUIRED[$i]="true"
      fi
      return 0
    fi
  done
  OPENCLAW_CFG_TXN_KEYS+=("$key")
  OPENCLAW_CFG_TXN_EXPECTED+=("$expected_json")
  OPENCLAW_CFG_TXN_REQUIRED+=("$required")
}

openclaw_cfg_txn_begin() {
  if [ "$OPENCLAW_CFG_TXN_ACTIVE" = true ]; then
    return 0
  fi
  if ! ensure_openclaw_config_file; then
    log_error "OpenClaw config not found: $OPENCLAW_CONFIG_PATH"
  fi
  OPENCLAW_CFG_TXN_SNAPSHOT="$(mktemp "${OPENCLAW_CONFIG_PATH}.txn.XXXXXX")"
  cp "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_CFG_TXN_SNAPSHOT"
  OPENCLAW_CFG_TXN_ACTIVE=true
  OPENCLAW_CFG_TXN_KEYS=()
  OPENCLAW_CFG_TXN_EXPECTED=()
  OPENCLAW_CFG_TXN_REQUIRED=()
  log_info "Started OpenClaw bootstrap config transaction."
}

openclaw_cfg_txn_rollback() {
  if [ "$OPENCLAW_CFG_TXN_ACTIVE" != true ]; then
    return 0
  fi
  if [ -n "$OPENCLAW_CFG_TXN_SNAPSHOT" ] && [ -f "$OPENCLAW_CFG_TXN_SNAPSHOT" ]; then
    cp "$OPENCLAW_CFG_TXN_SNAPSHOT" "$OPENCLAW_CONFIG_PATH"
    log_warn "Rolled back OpenClaw bootstrap config transaction."
  fi
  OPENCLAW_CFG_TXN_ACTIVE=false
  OPENCLAW_CFG_TXN_KEYS=()
  OPENCLAW_CFG_TXN_EXPECTED=()
  OPENCLAW_CFG_TXN_REQUIRED=()
}

openclaw_cfg_txn_commit() {
  if [ "$OPENCLAW_CFG_TXN_ACTIVE" != true ]; then
    return 0
  fi
  OPENCLAW_CFG_TXN_ACTIVE=false
  if [ -n "$OPENCLAW_CFG_TXN_SNAPSHOT" ] && [ -f "$OPENCLAW_CFG_TXN_SNAPSHOT" ]; then
    rm -f "$OPENCLAW_CFG_TXN_SNAPSHOT"
  fi
  OPENCLAW_CFG_TXN_SNAPSHOT=""
  OPENCLAW_CFG_TXN_KEYS=()
  OPENCLAW_CFG_TXN_EXPECTED=()
  OPENCLAW_CFG_TXN_REQUIRED=()
  log_success "Committed OpenClaw bootstrap config transaction."
}

openclaw_cfg_parse_json() {
  local raw="${1:-}"
  python3 - "$raw" <<'PY'
import json
import sys

raw = sys.argv[1]
if not raw.strip():
    raise SystemExit(1)

text = raw.strip()
decoder = json.JSONDecoder()
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

openclaw_cfg_get_json() {
  local key="$1"
  openclaw config get "$key" --json 2>/dev/null || true
}

openclaw_cfg_get_scalar_normalized() {
  local key="$1"
  local raw parsed
  raw="$(openclaw_cfg_get_json "$key")"
  parsed="$(openclaw_cfg_parse_json "$raw" 2>/dev/null || true)"
  if [ -z "$parsed" ] || [ "$parsed" = "null" ]; then
    printf ""
    return 0
  fi
  python3 - "$parsed" <<'PY'
import json
import sys

v = json.loads(sys.argv[1])
if v is None:
    print("", end="")
elif isinstance(v, bool):
    print("true" if v else "false", end="")
elif isinstance(v, (int, float)):
    print(v, end="")
elif isinstance(v, (list, dict)):
    print(json.dumps(v, separators=(",", ":"), sort_keys=True), end="")
else:
    print(str(v), end="")
PY
}

openclaw_cfg_get_scalar_from_file() {
  local key="$1"
  python3 - "$OPENCLAW_CONFIG_PATH" "$key" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
key = sys.argv[2]

try:
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
except Exception:
    print("", end="")
    raise SystemExit(0)

cur = data
for part in [p for p in key.split(".") if p]:
    if isinstance(cur, dict):
        cur = cur.get(part)
    elif isinstance(cur, list) and part.isdigit():
        idx = int(part)
        cur = cur[idx] if 0 <= idx < len(cur) else None
    else:
        cur = None
    if cur is None:
        print("", end="")
        raise SystemExit(0)

if isinstance(cur, bool):
    print("true" if cur else "false", end="")
elif isinstance(cur, (int, float)):
    print(cur, end="")
elif isinstance(cur, (list, dict)):
    print(json.dumps(cur, separators=(",", ":"), sort_keys=True), end="")
else:
    print(str(cur), end="")
PY
}

openclaw_cfg_file_fallback_enabled() {
  local raw
  raw="$(printf "%s" "${OPENCLAW_CONFIG_FILE_FALLBACK:-true}" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    0|false|no|off) return 1 ;;
    *) return 0 ;;
  esac
}

openclaw_cfg_set_file_fallback() {
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

openclaw_cfg_set_txn() {
  local key="$1"
  local value="$2"
  local mode="${3:-string}"      # string | json
  local required="${4:-true}"    # true | false
  local allow_file_fallback="${5:-}" # true | false
  local expected_json=""
  local cmd=(openclaw config set "$key" "$value")
  local attempt actual_raw expected_norm actual_norm cmd_output cmd_rc cmd_preview

  if [ -z "$allow_file_fallback" ]; then
    allow_file_fallback="$required"
  fi

  openclaw_cfg_txn_begin
  if [ "$mode" = "json" ]; then
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

  for attempt in 1 2 3; do
    set +e
    cmd_output="$("${cmd[@]}" 2>&1)"
    cmd_rc=$?
    set -e
    if [ "$cmd_rc" -eq 0 ]; then
      openclaw_cfg_txn_record_expectation "$key" "$expected_json" "$required"
      return 0
    fi
    cmd_preview="$(printf "%s" "$cmd_output" | tr '\r' '\n' | sed -n '1,3p' | paste -sd ' | ' -)"
    log_warn "OpenClaw config set attempt $attempt failed for $key (rc=$cmd_rc): ${cmd_preview:-no output}"
    if [ "$attempt" -eq 1 ]; then
      openclaw_doctor_fix_once || true
    fi
    sleep 1
  done

  if printf "%s" "$cmd_output" | grep -Eqi 'unrecognized key|unknown config key|unknown config keys'; then
    if [ "$required" = true ]; then
      openclaw_cfg_txn_rollback
      log_error "Required config key is unsupported by this OpenClaw version: $key"
    fi
    log_warn "Skipping optional unsupported OpenClaw key: $key"
    return 1
  fi

  if [ "$allow_file_fallback" = true ] && openclaw_cfg_file_fallback_enabled && openclaw_cfg_set_file_fallback "$key" "$value" "$mode"; then
    log_warn "Applied direct config file fallback for $key after CLI set failures."
    openclaw_cfg_txn_record_expectation "$key" "$expected_json" "$required"
    return 0
  fi

  # Some OpenClaw builds can return non-zero while still applying the value.
  # If the desired value is already present, proceed idempotently.
  actual_raw="$(openclaw_cfg_get_json "$key")"
  expected_norm="$(openclaw_cfg_parse_json "$expected_json" 2>/dev/null || true)"
  actual_norm="$(openclaw_cfg_parse_json "$actual_raw" 2>/dev/null || true)"
  if [ -n "$expected_norm" ] && [ -n "$actual_norm" ] && [ "$expected_norm" = "$actual_norm" ]; then
    log_warn "OpenClaw config set returned non-zero but desired value is already present: $key"
    openclaw_cfg_txn_record_expectation "$key" "$expected_json" "$required"
    return 0
  fi

  if [ "$required" = true ]; then
    openclaw_cfg_txn_rollback
    log_error "Failed required OpenClaw config write: $key"
  fi
  log_warn "Failed optional OpenClaw config write: $key"
  return 1
}

openclaw_cfg_txn_verify_or_rollback() {
  if [ "$OPENCLAW_CFG_TXN_ACTIVE" != true ]; then
    return 0
  fi
  local i key expected required actual expected_norm actual_norm
  for i in "${!OPENCLAW_CFG_TXN_KEYS[@]}"; do
    key="${OPENCLAW_CFG_TXN_KEYS[$i]}"
    expected="${OPENCLAW_CFG_TXN_EXPECTED[$i]}"
    required="${OPENCLAW_CFG_TXN_REQUIRED[$i]}"
    actual="$(openclaw_cfg_get_json "$key")"
    expected_norm="$(openclaw_cfg_parse_json "$expected" 2>/dev/null || true)"
    actual_norm="$(openclaw_cfg_parse_json "$actual" 2>/dev/null || true)"
    if [ -n "$expected_norm" ] && [ -n "$actual_norm" ] && [ "$expected_norm" = "$actual_norm" ]; then
      continue
    fi
    if [ "$required" = true ]; then
      openclaw_cfg_txn_rollback
      log_error "OpenClaw config verification failed for required key: $key"
    fi
    log_warn "OpenClaw config verification failed for optional key: $key"
  done
}

openclaw_cfg_txn_cleanup_on_exit() {
  local rc=$?
  if [ "$OPENCLAW_CFG_TXN_ACTIVE" = true ]; then
    openclaw_cfg_txn_rollback || true
  fi
  if [ -n "$OPENCLAW_CFG_TXN_SNAPSHOT" ] && [ -f "$OPENCLAW_CFG_TXN_SNAPSHOT" ]; then
    rm -f "$OPENCLAW_CFG_TXN_SNAPSHOT" || true
    OPENCLAW_CFG_TXN_SNAPSHOT=""
  fi
  return "$rc"
}

trap openclaw_cfg_txn_cleanup_on_exit EXIT

# Atomic file deploy helper:
# - returns 0 when deployed/updated
# - returns 10 when destination is already up to date
# - returns 11 when source is missing
# - returns 12 on copy/move error
deploy_file_atomic_if_changed() {
  local src="$1"
  local dst="$2"
  if [ ! -f "$src" ]; then
    return 11
  fi

  local dst_dir
  dst_dir="$(dirname "$dst")"
  mkdir -p "$dst_dir"

  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    return 10
  fi

  local base tmp
  base="$(basename "$dst")"
  tmp="$(mktemp "$dst_dir/.${base}.tmp.XXXXXX")" || return 12

  if ! cp "$src" "$tmp"; then
    rm -f "$tmp" >/dev/null 2>&1 || true
    return 12
  fi
  if ! mv -f "$tmp" "$dst"; then
    rm -f "$tmp" >/dev/null 2>&1 || true
    return 12
  fi
  return 0
}

canonical_path_or_empty() {
  local raw="${1:-}"
  python3 - "$raw" <<'PY'
import os
import sys

raw = sys.argv[1] if len(sys.argv) > 1 else ""
if not raw:
    print("", end="")
    raise SystemExit(0)

print(os.path.realpath(os.path.abspath(os.path.expanduser(raw))), end="")
PY
}

path_is_within_dir() {
  local parent="$1"
  local candidate="$2"
  python3 - "$parent" "$candidate" <<'PY'
import os
import sys

parent = os.path.realpath(os.path.abspath(os.path.expanduser(sys.argv[1])))
candidate = os.path.realpath(os.path.abspath(os.path.expanduser(sys.argv[2])))
try:
    common = os.path.commonpath([parent, candidate])
except ValueError:
    raise SystemExit(1)
raise SystemExit(0 if common == parent else 1)
PY
}

path_is_symlink_to() {
  local path="$1"
  local target="$2"
  [ -L "$path" ] || return 1
  local actual expected
  actual="$(canonical_path_or_empty "$path" 2>/dev/null || true)"
  expected="$(canonical_path_or_empty "$target" 2>/dev/null || true)"
  [ -n "$actual" ] && [ -n "$expected" ] && [ "$actual" = "$expected" ]
}

compute_directory_digest() {
  local src="$1"
  python3 - "$src" <<'PY'
import hashlib
import os
import sys

root = os.path.realpath(os.path.abspath(os.path.expanduser(sys.argv[1])))
h = hashlib.sha256()

for base, dirs, files in os.walk(root):
    dirs.sort()
    files.sort()
    rel_base = os.path.relpath(base, root)
    h.update(f"D {rel_base}\n".encode("utf-8"))
    for name in files:
        path = os.path.join(base, name)
        rel_path = os.path.relpath(path, root)
        st = os.lstat(path)
        h.update(f"F {rel_path}\n".encode("utf-8"))
        if os.path.islink(path):
            h.update(b"LINK\n")
            h.update(os.readlink(path).encode("utf-8", errors="surrogateescape"))
            h.update(b"\n")
            continue
        h.update(f"{st.st_mode}:{st.st_size}\n".encode("utf-8"))
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                h.update(chunk)

print(h.hexdigest()[:16], end="")
PY
}

prepare_managed_skill_copy() {
  local src="$1"
  local managed_root="$2"
  local skill_name="$3"
  [ -d "$src" ] || return 11

  mkdir -p "$managed_root"

  local digest desired_dir tmp_root staged_dir
  digest="$(compute_directory_digest "$src")" || return 12
  desired_dir="$managed_root/${skill_name}-${digest}"

  if [ -d "$desired_dir" ]; then
    printf "%s" "$desired_dir"
    return 0
  fi

  tmp_root="$(mktemp -d "$managed_root/.${skill_name}.tmp.XXXXXX")" || return 12
  staged_dir="$tmp_root/payload"
  if ! cp -R "$src" "$staged_dir"; then
    rm -rf "$tmp_root" >/dev/null 2>&1 || true
    return 12
  fi
  if [ -e "$desired_dir" ]; then
    rm -rf "$tmp_root" >/dev/null 2>&1 || true
    printf "%s" "$desired_dir"
    return 0
  fi
  if ! mv "$staged_dir" "$desired_dir"; then
    rm -rf "$tmp_root" >/dev/null 2>&1 || true
    return 12
  fi
  rm -rf "$tmp_root" >/dev/null 2>&1 || true
  printf "%s" "$desired_dir"
}

atomic_symlink_swap() {
  local target="$1"
  local dst="$2"
  local dst_dir base tmp_link backup_path

  dst_dir="$(dirname "$dst")"
  base="$(basename "$dst")"
  mkdir -p "$dst_dir"

  tmp_link="$(mktemp "$dst_dir/.${base}.link.XXXXXX")" || return 12
  rm -f "$tmp_link" >/dev/null 2>&1 || true
  if ! ln -s "$target" "$tmp_link"; then
    rm -f "$tmp_link" >/dev/null 2>&1 || true
    return 12
  fi

  if [ -d "$dst" ] && [ ! -L "$dst" ]; then
    backup_path="$dst_dir/.${base}.bootstrap-backup.$$.$RANDOM"
    while [ -e "$backup_path" ]; do
      backup_path="$dst_dir/.${base}.bootstrap-backup.$$.$RANDOM"
    done
    if ! mv "$dst" "$backup_path"; then
      rm -f "$tmp_link" >/dev/null 2>&1 || true
      return 12
    fi
    if ! python3 - "$tmp_link" "$dst" <<'PY'; then
import os
import sys

os.replace(sys.argv[1], sys.argv[2])
PY
      rm -f "$tmp_link" >/dev/null 2>&1 || true
      mv "$backup_path" "$dst" >/dev/null 2>&1 || true
      return 12
    fi
    rm -rf "$backup_path" >/dev/null 2>&1 || true
    return 0
  fi

  if ! python3 - "$tmp_link" "$dst" <<'PY'; then
import os
import sys

os.replace(sys.argv[1], sys.argv[2])
PY
    rm -f "$tmp_link" >/dev/null 2>&1 || true
    return 12
  fi
  return 0
}

install_skill_directory_atomic() {
  local src="$1"
  local dst="$2"
  local mode="$3"
  local managed_root="$4"
  local skill_name="$5"
  [ -d "$src" ] || return 11

  local desired_target old_target=""
  if [ "$mode" = "copy" ]; then
    desired_target="$(prepare_managed_skill_copy "$src" "$managed_root" "$skill_name")" || return $?
  else
    desired_target="$(canonical_path_or_empty "$src")" || return 12
  fi

  [ -n "$desired_target" ] && [ -d "$desired_target" ] || return 12

  if path_is_symlink_to "$dst" "$desired_target"; then
    return 10
  fi

  if [ -L "$dst" ]; then
    old_target="$(canonical_path_or_empty "$dst" 2>/dev/null || true)"
  fi

  atomic_symlink_swap "$desired_target" "$dst" || return $?

  if [ "$mode" = "copy" ] && [ -n "$old_target" ] && [ "$old_target" != "$desired_target" ]; then
    if path_is_within_dir "$managed_root" "$old_target"; then
      rm -rf "$old_target" >/dev/null 2>&1 || true
    fi
  fi

  return 0
}

snapshot_existing_file() {
  local file_path="$1"
  [ -f "$file_path" ] || {
    printf ""
    return 0
  }

  local snapshot
  snapshot="$(mktemp "${file_path}.snapshot.XXXXXX")" || return 1
  if ! cp "$file_path" "$snapshot"; then
    rm -f "$snapshot" >/dev/null 2>&1 || true
    return 1
  fi
  printf "%s" "$snapshot"
}

restore_file_snapshot() {
  local snapshot="$1"
  local file_path="$2"
  [ -n "$snapshot" ] || return 0
  [ -f "$snapshot" ] || return 0
  cp "$snapshot" "$file_path"
}

cleanup_file_snapshot() {
  local snapshot="$1"
  [ -n "$snapshot" ] || return 0
  rm -f "$snapshot" >/dev/null 2>&1 || true
}

backup_existing_path() {
  local path="$1"
  [ -e "$path" ] || {
    printf ""
    return 0
  }

  local dir base backup
  dir="$(dirname "$path")"
  base="$(basename "$path")"
  backup="$dir/.${base}.bootstrap-backup.$$.$RANDOM"
  while [ -e "$backup" ]; do
    backup="$dir/.${base}.bootstrap-backup.$$.$RANDOM"
  done
  if ! mv "$path" "$backup"; then
    return 1
  fi
  printf "%s" "$backup"
}

restore_backup_path() {
  local backup="$1"
  local path="$2"
  [ -n "$backup" ] || return 0
  [ -e "$backup" ] || return 0
  rm -rf "$path" >/dev/null 2>&1 || true
  mv "$backup" "$path"
}

discard_backup_path() {
  local backup="$1"
  [ -n "$backup" ] || return 0
  rm -rf "$backup" >/dev/null 2>&1 || true
}

install_clawboard_logger_plugin_transactional() {
  local plugin_src="$1"
  local plugin_ext_dir="$2"
  local plugin_config_json="${3:-}"
  local plugin_enabled_json="${4:-false}"
  local cfg_snapshot ext_backup stage_root staged_dir preview

  cfg_snapshot=""
  ext_backup=""
  stage_root=""
  staged_dir=""

  ensure_openclaw_config_file || return 1
  cfg_snapshot="$(snapshot_existing_file "$OPENCLAW_CONFIG_PATH")" || return 1

  if [ -e "$plugin_ext_dir" ]; then
    ext_backup="$(backup_existing_path "$plugin_ext_dir")" || {
      cleanup_file_snapshot "$cfg_snapshot"
      return 1
    }
    log_info "Staged existing logger plugin payload at $ext_backup."
  fi

  sanitize_clawboard_logger_stale_refs

  # OpenClaw validates discovered plugins against their config schema on CLI startup.
  # Seed a valid config entry before the plugin directory becomes visible so later
  # bootstrap CLI calls do not deadlock on an invalid intermediate state.
  if [ -n "$plugin_config_json" ]; then
    if ! openclaw_cfg_set_file_fallback "plugins.entries.clawboard-logger.config" "$plugin_config_json" json; then
      restore_file_snapshot "$cfg_snapshot" "$OPENCLAW_CONFIG_PATH" >/dev/null 2>&1 || true
      restore_backup_path "$ext_backup" "$plugin_ext_dir" >/dev/null 2>&1 || true
      cleanup_file_snapshot "$cfg_snapshot"
      preview="failed to seed clawboard-logger config in $OPENCLAW_CONFIG_PATH"
      log_warn "Rolled back logger plugin install after failure: ${preview:-no output}"
      return 1
    fi
    if ! openclaw_cfg_set_file_fallback "plugins.entries.clawboard-logger.enabled" "$plugin_enabled_json" json; then
      restore_file_snapshot "$cfg_snapshot" "$OPENCLAW_CONFIG_PATH" >/dev/null 2>&1 || true
      restore_backup_path "$ext_backup" "$plugin_ext_dir" >/dev/null 2>&1 || true
      cleanup_file_snapshot "$cfg_snapshot"
      preview="failed to seed clawboard-logger enabled flag in $OPENCLAW_CONFIG_PATH"
      log_warn "Rolled back logger plugin install after failure: ${preview:-no output}"
      return 1
    fi
  fi

  mkdir -p "$(dirname "$plugin_ext_dir")"
  stage_root="$(mktemp -d "$(dirname "$plugin_ext_dir")/.clawboard-logger.tmp.XXXXXX")" || {
    restore_file_snapshot "$cfg_snapshot" "$OPENCLAW_CONFIG_PATH" >/dev/null 2>&1 || true
    restore_backup_path "$ext_backup" "$plugin_ext_dir" >/dev/null 2>&1 || true
    cleanup_file_snapshot "$cfg_snapshot"
    return 1
  }
  staged_dir="$stage_root/clawboard-logger"

  # Install directly into the global extensions directory. OpenClaw auto-discovers
  # ~/.openclaw/extensions/*, while `openclaw plugins install` currently writes
  # an enabled entry before required plugin config exists.
  if ! cp -R "$plugin_src" "$staged_dir"; then
    restore_file_snapshot "$cfg_snapshot" "$OPENCLAW_CONFIG_PATH" >/dev/null 2>&1 || true
    restore_backup_path "$ext_backup" "$plugin_ext_dir" >/dev/null 2>&1 || true
    rm -rf "$stage_root" >/dev/null 2>&1 || true
    cleanup_file_snapshot "$cfg_snapshot"
    preview="copy failed for $plugin_src"
    log_warn "Rolled back logger plugin install after failure: ${preview:-no output}"
    return 1
  fi

  if ! mv "$staged_dir" "$plugin_ext_dir"; then
    restore_file_snapshot "$cfg_snapshot" "$OPENCLAW_CONFIG_PATH" >/dev/null 2>&1 || true
    restore_backup_path "$ext_backup" "$plugin_ext_dir" >/dev/null 2>&1 || true
    rm -rf "$stage_root" >/dev/null 2>&1 || true
    cleanup_file_snapshot "$cfg_snapshot"
    preview="atomic move failed for $plugin_ext_dir"
    log_warn "Rolled back logger plugin install after failure: ${preview:-no output}"
    return 1
  fi

  rm -rf "$stage_root" >/dev/null 2>&1 || true
  discard_backup_path "$ext_backup"
  cleanup_file_snapshot "$cfg_snapshot"
  return 0
}

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

resolve_agent_workspace_path() {
  local agent_id="${1:-main}"
  local fallback=""
  if [ "$agent_id" = "main" ]; then
    fallback="$(resolve_default_openclaw_workspace_root)"
  else
    fallback="$OPENCLAW_HOME/workspace-$agent_id"
  fi

  local resolved=""
  if [ -f "$OPENCLAW_CONFIG_PATH" ] && command -v python3 >/dev/null 2>&1; then
    resolved="$(
      python3 - "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_HOME" "${OPENCLAW_PROFILE:-}" "$agent_id" <<'PY' 2>/dev/null || true
import json
import os
import re
import sys

cfg_path = sys.argv[1]
openclaw_home = os.path.abspath(os.path.expanduser(sys.argv[2]))
profile = (sys.argv[3] or "").strip()
target_id = (sys.argv[4] or "main").strip().lower() or "main"

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

def normalize_agent_id(value):
    raw = str(value or "").strip().lower()
    if not raw:
        return "main"
    raw = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")
    return (raw[:64] or "main")

cfg = {}
try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        parsed = json.load(f)
        if isinstance(parsed, dict):
            cfg = parsed
except Exception:
    cfg = {}

fallback_main = profile_workspace(openclaw_home, profile)
defaults_workspace = (
    (((cfg.get("agents") or {}).get("defaults") or {}).get("workspace"))
    or ((cfg.get("agents") or {}).get("workspace"))
    or ((cfg.get("agent") or {}).get("workspace"))
    or cfg.get("workspace")
    or fallback_main
)
defaults_workspace = normalize_path(defaults_workspace) or fallback_main
if defaults_workspace == openclaw_home:
    defaults_workspace = fallback_main

agents = [entry for entry in ((cfg.get("agents") or {}).get("list") or []) if isinstance(entry, dict)]

resolved = ""
if target_id == "main":
    main_entry = next((entry for entry in agents if normalize_agent_id(entry.get("id")) == "main"), None)
    default_entry = next((entry for entry in agents if entry.get("default") is True), agents[0] if agents else None)
    chosen_entry = main_entry if isinstance(main_entry, dict) else default_entry
    if isinstance(chosen_entry, dict):
        candidate = chosen_entry.get("workspace")
        if isinstance(candidate, str) and candidate.strip():
            resolved = candidate.strip()
    if not resolved:
        resolved = defaults_workspace
else:
    target_entry = next((entry for entry in agents if normalize_agent_id(entry.get("id")) == target_id), None)
    if isinstance(target_entry, dict):
        candidate = target_entry.get("workspace")
        if isinstance(candidate, str) and candidate.strip():
            resolved = candidate.strip()
    if not resolved:
        resolved = os.path.join(openclaw_home, f"workspace-{target_id}")

resolved = normalize_path(resolved)
if target_id == "main":
    if not resolved or resolved == openclaw_home:
        resolved = fallback_main
else:
    if not resolved or resolved == openclaw_home:
        resolved = os.path.join(openclaw_home, f"workspace-{target_id}")

print(resolved or "", end="")
PY
    )"
  fi
  resolved="${resolved//$'\r'/}"
  if [ -z "$resolved" ]; then
    resolved="$fallback"
  fi
  resolved="${resolved/#\~/$HOME}"
  printf "%s" "$resolved"
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
WORKSPACE_IDE_BASE_URL_VALUE="${CLAWBOARD_WORKSPACE_IDE_BASE_URL:-}"
WORKSPACE_IDE_PASSWORD_VALUE="${CLAWBOARD_WORKSPACE_IDE_PASSWORD:-}"
WORKSPACE_IDE_PORT_VALUE="${CLAWBOARD_WORKSPACE_IDE_PORT:-13337}"
WORKSPACE_IDE_PROVIDER_VALUE="${CLAWBOARD_WORKSPACE_IDE_PROVIDER:-code-server}"
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
WORKSPACE_IDE_BASE_URL_EXPLICIT=false
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
if [ -n "${CLAWBOARD_WORKSPACE_IDE_BASE_URL+x}" ]; then
  WORKSPACE_IDE_BASE_URL_EXPLICIT=true
fi
if [ -n "${OPENCLAW_BASE_URL+x}" ]; then
  OPENCLAW_BASE_URL_EXPLICIT=true
fi
CHUTES_FAST_PATH_URL="${CHUTES_FAST_PATH_URL:-https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh}"
WEB_HOT_RELOAD_OVERRIDE=""
ALLOWED_DEV_ORIGINS_OVERRIDE=""
CONTEXT_MODE_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_MODE:-}"
CONTEXT_FETCH_TIMEOUT_MS_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS:-}"
CONTEXT_FETCH_RETRIES_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_FETCH_RETRIES:-}"
CONTEXT_FALLBACK_MODES_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODES:-}"
CONTEXT_MAX_CHARS_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS:-}"
CONTEXT_CACHE_TTL_MS_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_CACHE_TTL_MS:-}"
CONTEXT_CACHE_MAX_ENTRIES_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_CACHE_MAX_ENTRIES:-}"
CONTEXT_USE_CACHE_ON_FAILURE_OVERRIDE="${CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE:-}"
SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="${CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS:-}"
VECTOR_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="${CLAWBOARD_VECTOR_INCLUDE_TOOL_CALL_LOGS:-}"
SKILL_INSTALL_MODE="${CLAWBOARD_SKILL_INSTALL_MODE:-symlink}"
AGENTIC_TEAM_SETUP_MODE="${CLAWBOARD_AGENTIC_TEAM_SETUP:-ask}"
AGENTIC_TEAM_SETUP_STATUS="not-run"
AGENTIC_TEAM_AGENT_IDS=""
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
OPENCLAW_GATEWAY_DEVICE_AUTH_OVERRIDE="${CLAWBOARD_OPENCLAW_GATEWAY_USE_DEVICE_AUTH:-}"
APPLY_AGENT_DIRECTIVES_SETTING="${CLAWBOARD_APPLY_AGENT_DIRECTIVES:-1}"
SKIP_AGENT_DIRECTIVES=false
SKIP_LOCAL_MEMORY_SETUP=false
case "$(printf "%s" "${CLAWBOARD_SKIP_LOCAL_MEMORY_SETUP:-0}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) SKIP_LOCAL_MEMORY_SETUP=true ;;
esac
ENV_FILE_CREATED=false

case "$(printf "%s" "$APPLY_AGENT_DIRECTIVES_SETTING" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off) SKIP_AGENT_DIRECTIVES=true ;;
  *) SKIP_AGENT_DIRECTIVES=false ;;
esac

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
    --openclaw-gateway-device-auth) OPENCLAW_GATEWAY_DEVICE_AUTH_OVERRIDE="1"; shift ;;
    --no-openclaw-gateway-device-auth) OPENCLAW_GATEWAY_DEVICE_AUTH_OVERRIDE="0"; shift ;;
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
    --context-fetch-retries)
      [ $# -ge 2 ] || log_error "--context-fetch-retries requires a value"
      CONTEXT_FETCH_RETRIES_OVERRIDE="$2"; shift 2
      ;;
    --context-fallback-modes)
      [ $# -ge 2 ] || log_error "--context-fallback-modes requires a value"
      CONTEXT_FALLBACK_MODES_OVERRIDE="$2"; shift 2
      ;;
    --context-max-chars)
      [ $# -ge 2 ] || log_error "--context-max-chars requires a value"
      CONTEXT_MAX_CHARS_OVERRIDE="$2"; shift 2
      ;;
    --context-cache-ttl-ms)
      [ $# -ge 2 ] || log_error "--context-cache-ttl-ms requires a value"
      CONTEXT_CACHE_TTL_MS_OVERRIDE="$2"; shift 2
      ;;
    --context-cache-max-entries)
      [ $# -ge 2 ] || log_error "--context-cache-max-entries requires a value"
      CONTEXT_CACHE_MAX_ENTRIES_OVERRIDE="$2"; shift 2
      ;;
    --context-use-cache-on-failure)
      [ $# -ge 2 ] || log_error "--context-use-cache-on-failure requires a value"
      CONTEXT_USE_CACHE_ON_FAILURE_OVERRIDE="$2"; shift 2
      ;;
    --include-tool-call-logs) SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="1"; shift ;;
    --exclude-tool-call-logs) SEARCH_INCLUDE_TOOL_CALL_LOGS_OVERRIDE="0"; shift ;;
    --setup-agentic-team) AGENTIC_TEAM_SETUP_MODE="always"; shift ;;
    --skip-agentic-team-setup) AGENTIC_TEAM_SETUP_MODE="never"; shift ;;
    --setup-memory-backup) MEMORY_BACKUP_SETUP_MODE="always"; shift ;;
    --skip-memory-backup-setup) MEMORY_BACKUP_SETUP_MODE="never"; shift ;;
    --setup-obsidian-memory) OBSIDIAN_MEMORY_SETUP_MODE="always"; shift ;;
    --skip-obsidian-memory-setup) OBSIDIAN_MEMORY_SETUP_MODE="never"; shift ;;
    --setup-openclaw-heap) OPENCLAW_HEAP_SETUP_MODE="always"; shift ;;
    --skip-openclaw-heap-setup) OPENCLAW_HEAP_SETUP_MODE="never"; shift ;;
    --skip-local-memory-setup) SKIP_LOCAL_MEMORY_SETUP=true; shift ;;
    --apply-agent-directives) SKIP_AGENT_DIRECTIVES=false; shift ;;
    --skip-agent-directives) SKIP_AGENT_DIRECTIVES=true; shift ;;
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
  CLAWBOARD_AGENTIC_TEAM_SETUP=<ask|always|never>
                              Offer/run specialist team enrollment during bootstrap (default: ask)
  CLAWBOARD_MEMORY_BACKUP_SETUP=<ask|always|never>
                              Offer/run memory+Clawboard backup setup during bootstrap (default: ask)
  CLAWBOARD_OBSIDIAN_MEMORY_SETUP=<ask|always|never>
                              Offer/run Obsidian + memory tuning setup during bootstrap (default: ask)
  CLAWBOARD_OPENCLAW_HEAP_SETUP=<ask|always|never>
                              Offer/run OpenClaw launcher heap tuning at bootstrap end (default: ask)
  CLAWBOARD_OPENCLAW_MAX_OLD_SPACE_MB=<int>
                              Heap size for launcher patch (default: 6144)
  CLAWBOARD_SKIP_LOCAL_MEMORY_SETUP=<0|1>
                              Skip setup-openclaw-local-memory.sh during bootstrap
  CLAWBOARD_APPLY_AGENT_DIRECTIVES=<0|1>
                              Reconcile AGENTS/docs roster from directives during bootstrap (default: 1)
  CLAWBOARD_ENV_WIZARD=<0|1>  Force disable/enable interactive .env connection wizard
  CLAWBOARD_OPENCLAW_GATEWAY_USE_DEVICE_AUTH=<0|1>
                              Configure OPENCLAW_GATEWAY_USE_DEVICE_AUTH for Clawboard backend
  --api-url <url>      Clawboard API base (default: http://localhost:8010)
  --web-url <url>      Clawboard web URL (default: http://localhost:3010)
  --public-api-base <url>
                       Browser-facing API base (used for web clients / NEXT_PUBLIC_CLAWBOARD_API_BASE)
  --public-web-url <url>
                       Browser-facing UI URL shown in output summary
  --openclaw-base-url <url>
                       OpenClaw gateway URL used by classifier (writes OPENCLAW_BASE_URL)
  --openclaw-gateway-device-auth
                       Enable OPENCLAW_GATEWAY_USE_DEVICE_AUTH=1 for backend gateway RPC (advanced)
  --no-openclaw-gateway-device-auth
                       Set OPENCLAW_GATEWAY_USE_DEVICE_AUTH=0 for backend gateway RPC (recommended)
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
  --context-fetch-retries <n>
                       Retries per mode when /api/context retrieval fails (writes CLAWBOARD_LOGGER_CONTEXT_FETCH_RETRIES)
  --context-fallback-modes <csv>
                       Ordered fallback context modes (e.g. full,auto,cheap) written to CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODES
  --context-max-chars <n>
                       Hard cap for injected context block size (writes CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS)
  --context-cache-ttl-ms <ms>
                       Context cache TTL for transient failures (writes CLAWBOARD_LOGGER_CONTEXT_CACHE_TTL_MS)
  --context-cache-max-entries <n>
                       Max cached context blocks in plugin memory (writes CLAWBOARD_LOGGER_CONTEXT_CACHE_MAX_ENTRIES)
  --context-use-cache-on-failure <0|1|true|false>
                       Whether plugin should use cached context if live retrieval fails (writes CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE)
  --include-tool-call-logs
                       Include tool call/result/error action logs in semantic indexing + retrieval
                       (writes CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS=1)
  --exclude-tool-call-logs
                       Exclude tool call/result/error action logs from semantic indexing + retrieval
                       (writes CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS=0; default)
  --setup-agentic-team
                      Enroll coding/docs/web/social specialists during bootstrap
  --skip-agentic-team-setup
                      Skip specialist enrollment prompt/setup
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
  --skip-local-memory-setup
                      Skip local memory/model setup during bootstrap
  --apply-agent-directives
                      Reconcile directives + team roster in agent AGENTS.md files
  --skip-agent-directives
                      Skip automatic directive/roster reconciliation
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

case "$(printf "%s" "$AGENTIC_TEAM_SETUP_MODE" | tr '[:upper:]' '[:lower:]')" in
  ask|always|never) AGENTIC_TEAM_SETUP_MODE="$(printf "%s" "$AGENTIC_TEAM_SETUP_MODE" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    log_warn "Invalid agentic team setup mode: $AGENTIC_TEAM_SETUP_MODE (expected ask|always|never). Using ask."
    AGENTIC_TEAM_SETUP_MODE="ask"
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

is_placeholder_token() {
  local value lowered
  value="$(trim_whitespace "${1:-}")"
  [ -n "$value" ] || return 1
  lowered="$(printf "%s" "$value" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    your-token-here|your_token_here|change-me|change_me|changeme|replace-me|replace_me|replace-with-token|replace_with_token|example-token|example_token|token-here|token_here)
      return 0
      ;;
  esac
  return 1
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

prompt_yes_no_tty() {
  local prompt="$1"
  local default_answer="${2:-y}"
  local input=""
  local suffix="[Y/n]"

  case "$(printf "%s" "$default_answer" | tr '[:upper:]' '[:lower:]')" in
    n|no)
      default_answer="n"
      suffix="[y/N]"
      ;;
    *)
      default_answer="y"
      suffix="[Y/n]"
      ;;
  esac

  if [ ! -r /dev/tty ]; then
    return 2
  fi

  printf "\n%s %s: " "$prompt" "$suffix" > /dev/tty
  read -r input < /dev/tty || input=""
  input="$(trim_whitespace "$input")"
  input="$(printf "%s" "$input" | tr '[:upper:]' '[:lower:]')"
  case "$input" in
    "") input="$default_answer" ;;
    y|yes) input="y" ;;
    n|no) input="n" ;;
    *) input="$default_answer" ;;
  esac
  [ "$input" = "y" ]
}

ensure_env_file() {
  local repo_dir="$1"
  local env_file="$repo_dir/.env"
  ENV_FILE_CREATED=false
  if [ -f "$env_file" ]; then
    return
  fi
  if [ -f "$repo_dir/.env.example" ]; then
    cp "$repo_dir/.env.example" "$env_file"
    ENV_FILE_CREATED=true
    log_info "Seeded $env_file from .env.example."
    return
  fi
  touch "$env_file"
  ENV_FILE_CREATED=true
}

normalize_bool01() {
  local raw
  raw="$(trim_whitespace "${1:-}")"
  raw="$(printf "%s" "$raw" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    1|true|yes|on) printf "1" ;;
    0|false|no|off) printf "0" ;;
    *) printf "" ;;
  esac
}

resolve_openclaw_gateway_device_auth_value() {
  local env_file="$1"
  local is_onboarding="${2:-false}"
  local normalized_override=""
  local normalized_existing=""
  local selected=""

  if [ -n "${OPENCLAW_GATEWAY_DEVICE_AUTH_OVERRIDE:-}" ]; then
    normalized_override="$(normalize_bool01 "$OPENCLAW_GATEWAY_DEVICE_AUTH_OVERRIDE")"
    if [ -z "$normalized_override" ]; then
      log_warn "Invalid CLAWBOARD_OPENCLAW_GATEWAY_USE_DEVICE_AUTH=$OPENCLAW_GATEWAY_DEVICE_AUTH_OVERRIDE. Using recommended default: 0"
      normalized_override="0"
    fi
    printf "%s" "$normalized_override"
    return
  fi

  if read_env_value_from_file "$env_file" "OPENCLAW_GATEWAY_USE_DEVICE_AUTH" >/dev/null 2>&1; then
    normalized_existing="$(normalize_bool01 "$(read_env_value_from_file "$env_file" "OPENCLAW_GATEWAY_USE_DEVICE_AUTH" || true)")"
    if [ -n "$normalized_existing" ]; then
      selected="$normalized_existing"
    fi
  fi
  if [ -z "$selected" ]; then
    selected="0"
  fi

  # On first-run onboarding, ask explicitly so users understand why default is off.
  if [ "$is_onboarding" = true ] && [ -t 0 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
    local prompt_choice=""
    local prompt_default="1"
    if [ "$selected" = "1" ]; then
      prompt_default="2"
    fi
    printf "\nOpenClaw backend device auth for Clawboard:\n" > /dev/tty
    printf "  1) off (recommended): token auth only; avoids CLI/backend pairing metadata conflicts\n" > /dev/tty
    printf "  2) on  (advanced): requires a dedicated backend device identity paired once\n" > /dev/tty
    printf "Select [1-2] (default: %s): " "$prompt_default" > /dev/tty
    read -r prompt_choice < /dev/tty || prompt_choice=""
    prompt_choice="$(trim_whitespace "$prompt_choice")"
    if [ -z "$prompt_choice" ]; then
      prompt_choice="$prompt_default"
    fi
    case "$prompt_choice" in
      1) selected="0" ;;
      2) selected="1" ;;
      *)
        log_warn "Unrecognized choice. Using default: off."
        selected="0"
        ;;
    esac
  fi

  printf "%s" "$selected"
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

sanitize_clawboard_logger_stale_refs() {
  local plugin_ext_dir="$OPENCLAW_HOME/extensions/clawboard-logger"
  [ -e "$plugin_ext_dir" ] && return 0
  [ -f "$OPENCLAW_CONFIG_PATH" ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  local changed=""
  changed="$(
    python3 - "$OPENCLAW_CONFIG_PATH" <<'PY' 2>/dev/null || true
import json
import sys

path = sys.argv[1]
try:
  with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
except Exception:
  print("0")
  raise SystemExit(0)

plug = data.get("plugins")
if not isinstance(plug, dict):
  print("0")
  raise SystemExit(0)

changed = False

load_cfg = plug.get("load")
if isinstance(load_cfg, dict):
  paths = load_cfg.get("paths")
  if isinstance(paths, list):
    filtered = [p for p in paths if "clawboard-logger" not in str(p or "")]
    if filtered != paths:
      load_cfg["paths"] = filtered
      changed = True

allow = plug.get("allow")
if isinstance(allow, list):
  filtered = [a for a in allow if str(a or "") != "clawboard-logger"]
  if filtered != allow:
    plug["allow"] = filtered
    changed = True

for key in ("entries", "installs"):
  bucket = plug.get(key)
  if isinstance(bucket, dict) and "clawboard-logger" in bucket:
    del bucket["clawboard-logger"]
    changed = True

if changed:
  data["plugins"] = plug
  with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print("1" if changed else "0")
PY
  )"

  if [ "${changed:-0}" = "1" ]; then
    log_warn "Removed stale clawboard-logger config references before OpenClaw bootstrap."
  fi
}

reconcile_openclaw_gateway_launchagent_token() {
  local service_plist="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
  local gateway_token=""
  local plist_state=""
  local launchd_domain=""

  if [ "$(uname -s)" != "Darwin" ]; then
    return 0
  fi
  if [ ! -f "$service_plist" ]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "python3 not found; skipping macOS OpenClaw gateway LaunchAgent token reconciliation."
    return 0
  fi

  gateway_token="$(openclaw_cfg_get_scalar_normalized gateway.auth.token || true)"
  if [ "$gateway_token" = "__OPENCLAW_REDACTED__" ] || [ -z "$gateway_token" ]; then
    gateway_token="$(openclaw_cfg_get_scalar_from_file gateway.auth.token || true)"
  fi
  if [ -z "$gateway_token" ]; then
    log_warn "OpenClaw gateway auth token is missing; skipping macOS LaunchAgent token reconciliation."
    return 0
  fi

  plist_state="$(
    python3 - "$service_plist" "$gateway_token" <<'PY' 2>/dev/null || true
import plistlib
import sys
from pathlib import Path

plist_path = Path(sys.argv[1])
expected_token = sys.argv[2]

try:
    with plist_path.open("rb") as f:
        data = plistlib.load(f)
except Exception:
    print("error")
    raise SystemExit(0)

env = data.get("EnvironmentVariables")
if not isinstance(env, dict):
    env = {}
    data["EnvironmentVariables"] = env

current_token = str(env.get("OPENCLAW_GATEWAY_TOKEN") or "")
if current_token == expected_token:
    print("unchanged")
    raise SystemExit(0)

env["OPENCLAW_GATEWAY_TOKEN"] = expected_token
with plist_path.open("wb") as f:
    plistlib.dump(data, f, sort_keys=False)

print("updated")
PY
  )"

  case "$plist_state" in
    unchanged)
      log_success "OpenClaw gateway LaunchAgent token already matches current config."
      return 0
      ;;
    updated)
      log_warn "Updated macOS OpenClaw gateway LaunchAgent token to match current config."
      ;;
    *)
      log_warn "Could not inspect/update macOS OpenClaw gateway LaunchAgent token automatically."
      return 0
      ;;
  esac

  if ! command -v launchctl >/dev/null 2>&1; then
    log_warn "launchctl not found; LaunchAgent token was updated on disk but not reloaded."
    return 0
  fi

  launchd_domain="gui/$(id -u)"
  launchctl bootout "$launchd_domain" "$service_plist" >/dev/null 2>&1 || true
  if launchctl bootstrap "$launchd_domain" "$service_plist" >/dev/null 2>&1; then
    launchctl kickstart -k "$launchd_domain/ai.openclaw.gateway" >/dev/null 2>&1 || true
    log_success "Reloaded macOS OpenClaw gateway LaunchAgent after token reconciliation."
  else
    log_warn "Updated macOS LaunchAgent token but could not reload it automatically. Run: launchctl bootout $launchd_domain $service_plist && launchctl bootstrap $launchd_domain $service_plist"
  fi
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
  local -a curl_args
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "curl not found. Skipping API readiness check."
    return 1
  fi
  while [ "$attempt" -le "$max_attempts" ]; do
    curl_args=(-fsS)
    if [ -n "$TOKEN" ]; then
      curl_args+=(-H "X-Clawboard-Token: $TOKEN")
    fi
    curl_args+=("$health_url")
    if curl "${curl_args[@]}" >/dev/null 2>&1; then
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

report_openclaw_pending_device_approvals() {
  if ! command -v openclaw >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "python3 not found; skipping OpenClaw pending-approval origin check. Run: openclaw devices list"
    return 0
  fi

  local raw parsed rc count
  raw="$(OPENCLAW_HOME="$OPENCLAW_HOME" openclaw devices list --json 2>&1 || true)"
  if ! parsed="$(
    printf "%s" "$raw" | python3 - <<'PY'
import json
import sys

raw = sys.stdin.read()
decoder = json.JSONDecoder()
payload = None
for idx, ch in enumerate(raw):
    if ch != "{":
        continue
    try:
        candidate, _ = decoder.raw_decode(raw[idx:])
    except Exception:
        continue
    if isinstance(candidate, dict):
        payload = candidate
        break

if payload is None:
    sys.exit(2)

pending = payload.get("pending") if isinstance(payload.get("pending"), list) else []
paired = payload.get("paired") if isinstance(payload.get("paired"), list) else []
paired_by_device = {}
for item in paired:
    if not isinstance(item, dict):
        continue
    device_id = str(item.get("deviceId") or "").strip()
    if device_id:
        paired_by_device[device_id] = item

print(f"count\t{len(pending)}")

for item in pending:
    if not isinstance(item, dict):
        continue
    request_id = str(item.get("requestId") or "").strip() or "-"
    device_id = str(item.get("deviceId") or "").strip() or "-"
    platform = str(item.get("platform") or "").strip() or "unknown"
    client_id = str(item.get("clientId") or "").strip() or "unknown"
    client_mode = str(item.get("clientMode") or "").strip() or "unknown"
    role = str(item.get("role") or "").strip() or "unknown"
    state = "repair" if bool(item.get("isRepair")) else "new"

    if client_id == "cli" and client_mode == "cli":
        origin_hint = "local CLI session"
    elif client_id == "openclaw-control-ui":
        origin_hint = "web Control UI client"
    elif client_id == "openclaw-macos":
        origin_hint = "OpenClaw macOS app"
    elif client_id == "gateway-client":
        origin_hint = "gateway backend service client"
    elif client_mode == "webchat":
        origin_hint = "webchat client"
    else:
        origin_hint = f"{client_mode} client"

    mismatch = ""
    paired_item = paired_by_device.get(device_id)
    if isinstance(paired_item, dict):
        paired_client = str(paired_item.get("clientId") or "").strip() or "unknown"
        paired_platform = str(paired_item.get("platform") or "").strip() or "unknown"
        if paired_client != client_id or paired_platform != platform:
            mismatch = f"paired as clientId={paired_client}, platform={paired_platform}"

    print(
        "\t".join(
            [
                "pending",
                request_id,
                device_id,
                platform,
                client_id,
                client_mode,
                role,
                state,
                origin_hint,
                mismatch,
            ]
        )
    )
PY
  )"; then
    log_warn "Could not parse OpenClaw pending device approvals automatically. Review manually: openclaw devices list"
    return 0
  fi

  count="0"
  while IFS=$'\t' read -r kind value _rest; do
    if [ "$kind" = "count" ]; then
      count="$value"
      break
    fi
  done <<< "$parsed"

  if [ "$count" = "0" ]; then
    log_info "No pending OpenClaw device approvals."
    return 0
  fi

  log_warn "OpenClaw has $count pending device approval(s). Review origin before approving."
  while IFS=$'\t' read -r kind request_id device_id platform client_id client_mode role state origin_hint mismatch; do
    [ "$kind" = "pending" ] || continue
    local short_device_id="$device_id"
    if [ "${#short_device_id}" -gt 16 ]; then
      short_device_id="${short_device_id:0:16}..."
    fi
    log_warn "Pending request: requestId=$request_id device=$short_device_id origin=$origin_hint (clientId=$client_id mode=$client_mode platform=$platform role=$role state=$state)"
    if [ -n "$mismatch" ]; then
      log_warn "  Repair mismatch detected for device $short_device_id: $mismatch"
    fi
  done <<< "$parsed"
  log_warn "Approve explicitly: openclaw devices approve <requestId>"
  log_warn "Avoid blind approval with --latest unless only one trusted request is pending."
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

# Deploy main agent templates (AGENTS.md, SOUL.md, HEARTBEAT.md, BOOTSTRAP.md) from the Clawboard repo.
# Source of truth: INSTALL_DIR/agent-templates/main/ (repo). No policy text is hardcoded in this script.
# Copies into the main agent workspace with atomic per-file updates only when content changed.
# Call after skill/plugin install, before gateway restart.
maybe_deploy_agent_templates() {
  local templates_dir="$INSTALL_DIR/agent-templates/main"
  local workspace_root=""
  workspace_root="$(resolve_agent_workspace_path "main" 2>/dev/null || true)"
  workspace_root="${workspace_root//$'\r'/}"
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
  local unchanged=0
  local failed=0
  local rc=0
  local src=""
  local dst=""
  for f in AGENTS.md SOUL.md HEARTBEAT.md BOOTSTRAP.md; do
    src="$templates_dir/$f"
    dst="$workspace_root/$f"
    if deploy_file_atomic_if_changed "$src" "$dst"; then
      rc=0
    else
      rc=$?
    fi
    if [ "$rc" -eq 0 ]; then
      log_info "Deployed $f to $workspace_root"
      deployed=$((deployed + 1))
    elif [ "$rc" -eq 10 ]; then
      unchanged=$((unchanged + 1))
      log_info "$f already up to date in $workspace_root"
    elif [ "$rc" -eq 11 ]; then
      log_warn "Template missing in repo source: $src"
    else
      failed=$((failed + 1))
      log_warn "Failed deploying $f to $workspace_root"
    fi
  done
  if [ "$failed" -gt 0 ]; then
    log_error "Agent template deploy failed for $failed file(s)."
  fi
  if [ "$deployed" -gt 0 ]; then
    log_success "Deployed/updated $deployed agent template(s) to main workspace."
  elif [ "$unchanged" -gt 0 ]; then
    log_success "Agent templates already up to date in main workspace."
  fi
}

audit_openclaw_bootstrap_budget() {
  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "python3 not found; skipping bootstrap prompt-budget audit."
    return 0
  fi

  local audit_output rc line
  set +e
  audit_output="$(
    python3 - "$OPENCLAW_HOME" "$OPENCLAW_CONFIG_PATH" "${OPENCLAW_PROFILE:-}" <<'PY'
import glob
import json
import os
import re
import sys

openclaw_home = os.path.abspath(os.path.expanduser(sys.argv[1]))
config_path = os.path.abspath(os.path.expanduser(sys.argv[2]))
profile = (sys.argv[3] or "").strip()

DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000
DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 150_000
WARN_RATIO = 0.85
BOOTSTRAP_FILES = [
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
    "MEMORY.md",
    "memory.md",
]


def normalize_path(value: str) -> str:
    if not value:
        return ""
    return os.path.realpath(os.path.abspath(os.path.expanduser(str(value).strip())))


def profile_workspace(base_dir: str, profile_name: str) -> str:
    raw = (profile_name or "").strip()
    if not raw or raw.lower() == "default":
        return os.path.join(base_dir, "workspace")
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", raw).strip("-")
    if not safe:
        return os.path.join(base_dir, "workspace")
    return os.path.join(base_dir, f"workspace-{safe}")


config = {}
try:
    with open(config_path, "r", encoding="utf-8") as fh:
        loaded = json.load(fh)
    if isinstance(loaded, dict):
        config = loaded
except Exception:
    config = {}

agents_cfg = config.get("agents") or {}
defaults_cfg = agents_cfg.get("defaults") or {}
max_chars = defaults_cfg.get("bootstrapMaxChars")
total_max_chars = defaults_cfg.get("bootstrapTotalMaxChars")
if not isinstance(max_chars, (int, float)) or max_chars <= 0:
    max_chars = DEFAULT_BOOTSTRAP_MAX_CHARS
if not isinstance(total_max_chars, (int, float)) or total_max_chars <= 0:
    total_max_chars = DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS
max_chars = int(max_chars)
total_max_chars = int(total_max_chars)

workspaces = []
seen = set()

def add_workspace(value: str) -> None:
    normalized = normalize_path(value)
    if not normalized or normalized in seen:
        return
    seen.add(normalized)
    workspaces.append(normalized)


fallback_workspace = profile_workspace(openclaw_home, profile)
add_workspace(fallback_workspace)
add_workspace(defaults_cfg.get("workspace") or "")
add_workspace((config.get("agent") or {}).get("workspace") if isinstance(config.get("agent"), dict) else "")
add_workspace(config.get("workspace") or "")

for entry in agents_cfg.get("list") or []:
    if isinstance(entry, dict):
        add_workspace(entry.get("workspace") or "")

for candidate in sorted(glob.glob(os.path.join(openclaw_home, "workspace*"))):
    add_workspace(candidate)

had_any = False
for workspace in workspaces:
    if not os.path.isdir(workspace):
        continue
    file_sizes = []
    total_chars = 0
    for name in BOOTSTRAP_FILES:
        path = os.path.join(workspace, name)
        if not os.path.isfile(path):
            continue
        try:
            content = open(path, "r", encoding="utf-8").read()
        except Exception:
            continue
        size = len(content)
        total_chars += size
        file_sizes.append((name, path, size))
    if not file_sizes:
        continue

    had_any = True
    for name, path, size in file_sizes:
        if size > max_chars:
            print(
                f"ERROR\tBootstrap file exceeds OpenClaw per-file limit: {path} is {size}/{max_chars} chars.",
            )
        elif size >= int(max_chars * WARN_RATIO):
            pct = int(round((size / max_chars) * 100))
            print(
                f"WARN\tBootstrap file near OpenClaw per-file limit: {path} is {size}/{max_chars} chars ({pct}%).",
            )

    if total_chars > total_max_chars:
        print(
            f"ERROR\tWorkspace bootstrap payload exceeds total limit: {workspace} is {total_chars}/{total_max_chars} chars.",
        )
    elif total_chars >= int(total_max_chars * WARN_RATIO):
        pct = int(round((total_chars / total_max_chars) * 100))
        print(
            f"WARN\tWorkspace bootstrap payload near total limit: {workspace} is {total_chars}/{total_max_chars} chars ({pct}%).",
        )

    largest_name, _, largest_size = max(file_sizes, key=lambda item: item[2])
    print(
        f"OK\tBootstrap budget: {workspace} total={total_chars}/{total_max_chars}, largest={largest_name}:{largest_size}/{max_chars}.",
    )

if not had_any:
    print("INFO\tNo bootstrap files found yet; skipped budget checks.")
PY
  )"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    log_warn "Bootstrap prompt-budget audit failed unexpectedly."
    return 0
  fi

  while IFS= read -r line; do
    [ -n "${line:-}" ] || continue
    if [[ "$line" == $'ERROR\t'* ]]; then
      log_error "${line#ERROR	}"
    elif [[ "$line" == $'WARN\t'* ]]; then
      log_warn "${line#WARN	}"
    elif [[ "$line" == $'OK\t'* ]]; then
      log_info "${line#OK	}"
    elif [[ "$line" == $'INFO\t'* ]]; then
      log_info "${line#INFO	}"
    fi
  done <<< "$audit_output"
}

# Copy canonical Clawboard contract docs into the main workspace so AGENTS.md references
# (ANATOMY/CONTEXT/CLASSIFICATION) always resolve to the latest repo versions.
# Deploy is idempotent and atomic per-file.
maybe_deploy_contract_docs() {
  local workspace_root=""
  workspace_root="$(resolve_agent_workspace_path "main" 2>/dev/null || true)"
  workspace_root="${workspace_root//$'\r'/}"
  workspace_root="${workspace_root/#\~/$HOME}"
  if [ ! -d "$workspace_root" ]; then
    log_warn "Workspace root not found: $workspace_root (skipping contract doc deploy)."
    return 0
  fi

  local deployed=0
  local unchanged=0
  local missing=0
  local failed=0
  local rc=0
  local src=""
  local dst=""
  local doc=""
  for doc in "${CLAWBOARD_CONTRACT_DOCS[@]}"; do
    src="$INSTALL_DIR/$doc"
    dst="$workspace_root/$doc"
    if deploy_file_atomic_if_changed "$src" "$dst"; then
      rc=0
    else
      rc=$?
    fi
    if [ "$rc" -eq 0 ]; then
      log_info "Deployed $doc to $workspace_root"
      deployed=$((deployed + 1))
    elif [ "$rc" -eq 10 ]; then
      unchanged=$((unchanged + 1))
      log_info "$doc already up to date in $workspace_root"
    elif [ "$rc" -eq 11 ]; then
      missing=$((missing + 1))
      log_warn "Contract doc missing in repo source: $src"
    else
      failed=$((failed + 1))
      log_warn "Failed deploying $doc to $workspace_root"
    fi
  done
  if [ "$failed" -gt 0 ]; then
    log_error "Contract doc deploy failed for $failed file(s)."
  fi
  if [ "$deployed" -gt 0 ]; then
    log_success "Deployed/updated $deployed Clawboard contract doc(s) to main workspace."
  elif [ "$unchanged" -gt 0 ]; then
    log_success "Clawboard contract docs already up to date in main workspace."
  fi
  if [ "$missing" -gt 0 ]; then
    log_warn "$missing contract doc(s) were missing in repository source and were not deployed."
  fi
}

# Verify that deployed main-agent docs/rails contain the expected supervision and execution-lane markers.
# This is a non-fatal guardrail: bootstrap continues, but emits explicit warnings when alignment drifts.
verify_agent_contract_alignment() {
  local workspace_root=""
  workspace_root="$(resolve_agent_workspace_path "main" 2>/dev/null || true)"
  workspace_root="${workspace_root//$'\r'/}"
  workspace_root="${workspace_root/#\~/$HOME}"
  if [ ! -d "$workspace_root" ]; then
    log_warn "Workspace root not found: $workspace_root (skipping contract alignment verification)."
    return 0
  fi

  local agents_path="$workspace_root/AGENTS.md"
  local soul_path="$workspace_root/SOUL.md"
  local heartbeat_path="$workspace_root/HEARTBEAT.md"
  local bootstrap_path="$workspace_root/BOOTSTRAP.md"
  local all_ok=true

  verify_marker() {
    local file_path="$1"
    local pattern="$2"
    local label="$3"
    if [ ! -f "$file_path" ]; then
      log_warn "Contract verification: missing $file_path ($label)."
      all_ok=false
      return 0
    fi
    if ! grep -Eiq "$pattern" "$file_path"; then
      log_warn "Contract verification: marker '$label' not found in $file_path."
      all_ok=false
    fi
  }

  verify_marker "$agents_path" "main-only direct|trivial and faster than delegation|only execute directly" "main direct lane"
  verify_marker "$agents_path" "single-specialist|single specialist" "single-specialist lane"
  verify_marker "$agents_path" "multi-specialist|huddle|federated" "multi-specialist lane"
  verify_marker "$agents_path" "ECOSYSTEM MODEL|operating surface" "ecosystem model"
  verify_marker "$agents_path" "SPECIALIST CAPABILITY MAP|specialist map" "specialist capability map"
  verify_marker "$agents_path" "(1m[[:space:]]*(->|=>|-|=)>?[[:space:]]*3m[[:space:]]*(->|=>|-|=)>?[[:space:]]*10m[[:space:]]*(->|=>|-|=)>?[[:space:]]*15m[[:space:]]*(->|=>|-|=)>?[[:space:]]*30m[[:space:]]*(->|=>|-|=)>?[[:space:]]*1h|\[[[:space:]]*1m[[:space:]]*,[[:space:]]*3m[[:space:]]*,[[:space:]]*10m[[:space:]]*,[[:space:]]*15m[[:space:]]*,[[:space:]]*30m[[:space:]]*,[[:space:]]*1h[[:space:]]*\])" "delegation ladder"
  verify_marker "$soul_path" "sessions_spawn" "sessions_spawn contract"
  verify_marker "$soul_path" "OpenClaw is the runtime|OpenClaw is where sessions" "runtime/ledger model"
  verify_marker "$heartbeat_path" "(1m[[:space:]]*(->|=>|-|=)>?[[:space:]]*3m[[:space:]]*(->|=>|-|=)>?[[:space:]]*10m[[:space:]]*(->|=>|-|=)>?[[:space:]]*15m[[:space:]]*(->|=>|-|=)>?[[:space:]]*30m[[:space:]]*(->|=>|-|=)>?[[:space:]]*1h|\[[[:space:]]*1m[[:space:]]*,[[:space:]]*3m[[:space:]]*,[[:space:]]*10m[[:space:]]*,[[:space:]]*15m[[:space:]]*,[[:space:]]*30m[[:space:]]*,[[:space:]]*1h[[:space:]]*\])" "heartbeat ladder"
  verify_marker "$heartbeat_path" "user decision" "decision escalation"
  verify_marker "$bootstrap_path" "clawboard_update_task|cron.add" "bootstrap delegation rails"

  local doc=""
  for doc in "${CLAWBOARD_CONTRACT_DOCS[@]}"; do
    if [ ! -f "$workspace_root/$doc" ]; then
      log_warn "Contract verification: missing deployed doc $workspace_root/$doc"
      all_ok=false
    fi
  done

  if [ "$all_ok" = true ]; then
    log_success "Verified main-agent contract alignment (execution lanes, ladder, deployed docs)."
  fi
}

# Provision specialist agent workspaces (workspace-coding, workspace-docs, workspace-web, workspace-social).
# Runs scripts/setup_specialist_agents.sh when present. Idempotent.
setup_specialist_agents() {
  if [ ! -f "$INSTALL_DIR/scripts/setup_specialist_agents.sh" ]; then
    log_warn "setup_specialist_agents.sh not found; skipping specialist workspace provisioning."
    return 0
  fi
  OPENCLAW_HOME="$OPENCLAW_HOME" \
  OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
  OPENCLAW_PROFILE="${OPENCLAW_PROFILE:-}" \
  INSTALL_DIR="$INSTALL_DIR" \
  bash "$INSTALL_DIR/scripts/setup_specialist_agents.sh"
}

# Optionally add specialist agents (coding, docs, web, social) to openclaw.json
# so the main agent can delegate. Uses `openclaw agents add` when enabled. Idempotent.
maybe_offer_agentic_team_setup() {
  local mode="${1:-ask}"
  local existing_ids=""
  local raw=""
  local id=""
  local ws_path=""
  local added=0
  local missing_workspaces=0
  local prompt_rc=0
  local specialist_ids="coding docs web social"

  if ! command -v openclaw >/dev/null 2>&1; then
    AGENTIC_TEAM_SETUP_STATUS="openclaw-missing"
    log_warn "openclaw not in PATH; skipping agentic team setup. Install OpenClaw and run: openclaw agents add <id> --workspace <resolved-workspace> --non-interactive"
    return 0
  fi

  case "$mode" in
    never)
      AGENTIC_TEAM_SETUP_STATUS="skipped-mode-never"
      return 0
      ;;
    always) ;;
    ask)
      if prompt_yes_no_tty "Set up the agentic team (main + coding, docs, web, social) so the main agent can delegate to specialists?" "y"; then
        :
      else
        prompt_rc=$?
        case "$prompt_rc" in
          2)
            AGENTIC_TEAM_SETUP_STATUS="skipped-no-tty"
            log_info "No interactive TTY available for the agentic team prompt. Re-run with --setup-agentic-team or CLAWBOARD_AGENTIC_TEAM_SETUP=always to enroll specialists automatically."
            return 0
            ;;
          *)
            AGENTIC_TEAM_SETUP_STATUS="skipped-by-user"
            log_info "Skipped agentic team setup. Add specialists later with: openclaw agents add <id> --workspace <resolved-workspace> --non-interactive"
            return 0
            ;;
        esac
      fi
      ;;
    *)
      AGENTIC_TEAM_SETUP_STATUS="skipped-invalid-mode"
      return 0
      ;;
  esac

  if raw="$(OPENCLAW_HOME="$OPENCLAW_HOME" openclaw config get agents.list --json 2>/dev/null)"; then
    if command -v jq >/dev/null 2>&1; then
      existing_ids=$(printf '%s' "$raw" | jq -r '.[].id' 2>/dev/null | tr '\n' ' ')
    elif command -v python3 >/dev/null 2>&1; then
      existing_ids=$(printf '%s' "$raw" | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(x.get('id','') for x in d))" 2>/dev/null)
    fi
  fi
  existing_ids=" ${existing_ids} "

  for id in $specialist_ids; do
    case "$existing_ids" in *" $id "*) continue ;; *) ;; esac
    ws_path="$(resolve_agent_workspace_path "$id" 2>/dev/null || true)"
    ws_path="${ws_path//$'\r'/}"
    ws_path="${ws_path/#\~/$HOME}"
    if [ -z "$ws_path" ]; then
      ws_path="$OPENCLAW_HOME/workspace-$id"
    fi
    if [ ! -d "$ws_path" ]; then
      missing_workspaces=$((missing_workspaces + 1))
      log_warn "Workspace $ws_path missing; run setup_specialist_agents first. Skipping agent $id."
      continue
    fi
    log_info "Adding agent: $id (workspace: $ws_path)"
    if OPENCLAW_HOME="$OPENCLAW_HOME" openclaw agents add "$id" --workspace "$ws_path" --non-interactive 2>/dev/null; then
      added=$((added + 1))
    else
      log_warn "Failed to add agent $id (may already exist). Continue."
    fi
  done

  if [ "$added" -gt 0 ]; then
    AGENTIC_TEAM_SETUP_STATUS="configured"
    OPENCLAW_GATEWAY_RESTART_NEEDED=true
    log_success "Added $added specialist agent(s) to config. Gateway will restart to apply."
    return 0
  fi

  if [ "$missing_workspaces" -gt 0 ]; then
    AGENTIC_TEAM_SETUP_STATUS="incomplete"
    log_warn "Agentic team setup could not enroll every specialist because $missing_workspaces workspace(s) were missing."
    return 0
  fi

  AGENTIC_TEAM_SETUP_STATUS="already-configured"
  log_success "Agentic team already present in OpenClaw config."
}

sync_main_subagent_allow_agents() {
  local payload=""
  local main_idx=""
  local allow_agents_json=""
  local allow_agents_display=""
  local current_allow=""

  if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
    log_warn "OpenClaw config not found at $OPENCLAW_CONFIG_PATH; skipping main subagents.allowAgents sync."
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "python3 not found; skipping main subagents.allowAgents sync."
    return 0
  fi

  payload="$(
    python3 - "$OPENCLAW_CONFIG_PATH" <<'PY' 2>/dev/null || true
import json
import sys

cfg_path = sys.argv[1]

try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}

agents = [entry for entry in ((data.get("agents") or {}).get("list") or []) if isinstance(entry, dict)]
main_idx = None
for idx, entry in enumerate(agents):
    if str(entry.get("id") or "").strip().lower() == "main":
        main_idx = idx
        break
if main_idx is None:
    for idx, entry in enumerate(agents):
        if entry.get("default") is True:
            main_idx = idx
            break

allow = []
seen = set()
for entry in agents:
    agent_id = str(entry.get("id") or "").strip().lower()
    if not agent_id or agent_id == "main" or agent_id in seen:
        continue
    seen.add(agent_id)
    allow.append(agent_id)

display = ", ".join(allow)
main_part = "" if main_idx is None else str(main_idx)
print("\t".join([main_part, json.dumps(allow, separators=(",", ":")), display]), end="")
PY
  )"
  payload="${payload//$'\r'/}"
  if [ -z "$payload" ]; then
    log_warn "Could not inspect OpenClaw config for main subagents.allowAgents sync."
    return 0
  fi

  main_idx="${payload%%$'\t'*}"
  payload="${payload#*$'\t'}"
  allow_agents_json="${payload%%$'\t'*}"
  allow_agents_display="${payload#*$'\t'}"
  if [ -z "$main_idx" ]; then
    log_warn "Could not find main agent entry in OpenClaw config; skipping main subagents.allowAgents sync."
    return 0
  fi
  if [ -z "$allow_agents_json" ]; then
    allow_agents_json='[]'
  fi

  AGENTIC_TEAM_AGENT_IDS="${allow_agents_display:-none}"

  if command -v openclaw >/dev/null 2>&1; then
    current_allow="$(openclaw_cfg_get_scalar_normalized "agents.list.${main_idx}.subagents.allowAgents" || true)"
    if [ "$current_allow" = "$allow_agents_json" ]; then
      log_success "Main subagents.allowAgents already aligned with configured specialists (${AGENTIC_TEAM_AGENT_IDS})."
      return 0
    fi
  fi

  openclaw_cfg_txn_begin
  if openclaw_cfg_set_txn "agents.list.${main_idx}.subagents.allowAgents" "$allow_agents_json" json false true; then
    openclaw_cfg_txn_commit
    OPENCLAW_GATEWAY_RESTART_NEEDED=true
    log_success "Synced main subagents.allowAgents to configured specialists (${AGENTIC_TEAM_AGENT_IDS})."
  else
    openclaw_cfg_txn_rollback
    log_warn "Failed syncing main subagents.allowAgents from configured specialists."
  fi
}

maybe_apply_agent_directives() {
  if [ "$SKIP_AGENT_DIRECTIVES" = true ]; then
    log_info "Skipping agent directive reconciliation by configuration."
    return 0
  fi
  if [ ! -f "$INSTALL_DIR/scripts/apply_directives_to_agents.sh" ]; then
    log_warn "apply_directives_to_agents.sh not found; skipping directive reconciliation."
    return 0
  fi
  if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
    log_warn "OpenClaw config not found at $OPENCLAW_CONFIG_PATH; skipping directive reconciliation."
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "python3 not found; skipping directive reconciliation."
    return 0
  fi

  log_info "Reconciling agent directives + team roster from repository source of truth..."
  if OPENCLAW_HOME="$OPENCLAW_HOME" \
     OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
     bash "$INSTALL_DIR/scripts/apply_directives_to_agents.sh" --yes --no-color; then
    log_success "Agent directives reconciled."
  else
    log_warn "Agent directive reconciliation failed. Re-run: bash $INSTALL_DIR/scripts/apply_directives_to_agents.sh --yes"
  fi
}

# Run setup-openclaw-local-memory.sh unconditionally (no user prompt). Tool policy + watchdog
# are always applied. Call before the Obsidian prompt. Bootstrap defers any full memory reindex
# so the overall flow only does one QMD refresh pass. Handles missing openclaw/script gracefully.
maybe_run_local_memory_setup() {
  local script_path=""
  if [ "$SKIP_LOCAL_MEMORY_SETUP" = true ]; then
    log_info "Skipping local memory setup by configuration."
    return 0
  fi
  if ! script_path="$(resolve_local_memory_setup_script 2>/dev/null)"; then
    log_warn "setup-openclaw-local-memory.sh not found; skipping local memory setup (tool allow list, heartbeat, watchdog)."
    return 0
  fi
  if ! command -v openclaw >/dev/null 2>&1; then
    log_warn "openclaw not installed; skipping local memory setup. Run later: bash $script_path"
    return 0
  fi
  log_info "Running local memory setup (tool allow list, heartbeat, watchdog)..."
  if OPENCLAW_MEMORY_SKIP_INDEX=true bash "$script_path"; then
    log_success "Local memory setup completed."
  else
    log_error "setup-openclaw-local-memory.sh failed. Bootstrap aborted to avoid partial agent/memory configuration. Re-run: bash $script_path"
  fi
}

maybe_offer_obsidian_memory_setup() {
  local mode="${1:-ask}"
  local obsidian_script=""
  local answer=""
  local should_run=false
  local rc=0
  local -a obsidian_args=()
  [ "$USE_COLOR" = false ] && obsidian_args+=(--no-color)

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
  if [ "${#obsidian_args[@]}" -gt 0 ]; then
    if ! bash "$obsidian_script" "${obsidian_args[@]}"; then
      rc=1
      log_warn "setup_obsidian_brain.sh did not complete successfully."
    fi
  else
    if ! bash "$obsidian_script"; then
      rc=1
      log_warn "setup_obsidian_brain.sh did not complete successfully."
    fi
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
  local should_run=false
  local prompt_rc=0

  case "$mode" in
    never)
      MEMORY_BACKUP_SETUP_STATUS="skipped-mode-never"
      return 0
      ;;
    always) should_run=true ;;
    ask)
      printf "\nBackups are strongly recommended for continuity + Clawboard state safety.\n" > /dev/tty 2>/dev/null || true
      if prompt_yes_no_tty "Set up automated continuity + Clawboard backups now?" "y"; then
        should_run=true
      else
        prompt_rc=$?
        case "$prompt_rc" in
          2)
            MEMORY_BACKUP_SETUP_STATUS="skipped-no-tty"
            log_info "No interactive TTY available for the backup prompt. Re-run with --setup-memory-backup or CLAWBOARD_MEMORY_BACKUP_SETUP=always to configure backups automatically."
            return 0
            ;;
          *)
            should_run=false
            ;;
        esac
      fi
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

# Keep workspace IDE state on host paths with deterministic ownership.
mkdir -p "$INSTALL_DIR/data/code-server/config" "$INSTALL_DIR/data/code-server/local"
chmod 700 "$INSTALL_DIR/data/code-server/config" "$INSTALL_DIR/data/code-server/local" 2>/dev/null || true
mkdir -p "$INSTALL_DIR/data/code-server/local/User"

CODE_SERVER_SETTINGS_FILE="$INSTALL_DIR/data/code-server/local/User/settings.json"
if command -v python3 >/dev/null 2>&1; then
  python3 - "$CODE_SERVER_SETTINGS_FILE" <<'PY'
import json
import os
import sys

path = sys.argv[1]
os.makedirs(os.path.dirname(path), exist_ok=True)
defaults = {
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.preferredDarkColorTheme": "Default Dark Modern",
    "window.autoDetectColorScheme": False,
    "security.workspace.trust.enabled": False,
}

data = {}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            parsed = json.load(handle)
        if isinstance(parsed, dict):
            data = parsed
    except Exception:
        data = {}

for key, value in defaults.items():
    data[key] = value

with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
elif [ ! -f "$CODE_SERVER_SETTINGS_FILE" ]; then
  cat >"$CODE_SERVER_SETTINGS_FILE" <<'EOF'
{
  "security.workspace.trust.enabled": false,
  "window.autoDetectColorScheme": false,
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.preferredDarkColorTheme": "Default Dark Modern"
}
EOF
fi

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

if [ -n "$TOKEN" ] && is_placeholder_token "$TOKEN"; then
  log_warn "Found placeholder CLAWBOARD_TOKEN value; generating a secure token."
  TOKEN=""
fi

if [ -z "$TOKEN" ]; then
  TOKEN="$(generate_token)"
fi

log_info "Writing CLAWBOARD_TOKEN in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_TOKEN" "$TOKEN"
log_info "Writing OPENCLAW_HOME in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "OPENCLAW_HOME" "$OPENCLAW_HOME"
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
WORKSPACE_IDE_PORT_VALUE="$(clamp_int "$WORKSPACE_IDE_PORT_VALUE" 1 65535 || echo "13337")"
WORKSPACE_IDE_PROVIDER_VALUE="$(printf "%s" "$WORKSPACE_IDE_PROVIDER_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
case "$WORKSPACE_IDE_PROVIDER_VALUE" in
  code-server|"") ;;
  *) WORKSPACE_IDE_PROVIDER_VALUE="code-server" ;;
esac
if [ -z "$WORKSPACE_IDE_PASSWORD_VALUE" ]; then
  WORKSPACE_IDE_PASSWORD_VALUE="$TOKEN"
fi
if [ "$WORKSPACE_IDE_BASE_URL_EXPLICIT" = false ]; then
  IDE_HOST="$(extract_url_host "$ACCESS_WEB_URL")"
  [ -n "$IDE_HOST" ] || IDE_HOST="localhost"
  if [[ "$ACCESS_WEB_URL" =~ ^https:// ]]; then
    WORKSPACE_IDE_BASE_URL_VALUE="https://$IDE_HOST:$WORKSPACE_IDE_PORT_VALUE"
  else
    WORKSPACE_IDE_BASE_URL_VALUE="http://$IDE_HOST:$WORKSPACE_IDE_PORT_VALUE"
  fi
fi
WORKSPACE_IDE_BASE_URL_VALUE="$(normalize_http_url "$WORKSPACE_IDE_BASE_URL_VALUE")"
log_info "Writing CLAWBOARD_WORKSPACE_IDE_PROVIDER in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_WORKSPACE_IDE_PROVIDER" "$WORKSPACE_IDE_PROVIDER_VALUE"
log_info "Writing CLAWBOARD_WORKSPACE_IDE_PORT in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_WORKSPACE_IDE_PORT" "$WORKSPACE_IDE_PORT_VALUE"
log_info "Writing CLAWBOARD_WORKSPACE_IDE_BASE_URL in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_WORKSPACE_IDE_BASE_URL" "$WORKSPACE_IDE_BASE_URL_VALUE"
log_info "Writing CLAWBOARD_WORKSPACE_IDE_PASSWORD in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_WORKSPACE_IDE_PASSWORD" "$WORKSPACE_IDE_PASSWORD_VALUE"
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
OPENCLAW_CHAT_TRANSPORT_VALUE=""
if [ -n "${OPENCLAW_CHAT_TRANSPORT:-}" ]; then
  OPENCLAW_CHAT_TRANSPORT_VALUE="$OPENCLAW_CHAT_TRANSPORT"
elif read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_CHAT_TRANSPORT" >/dev/null 2>&1; then
  OPENCLAW_CHAT_TRANSPORT_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_CHAT_TRANSPORT" || true)"
else
  OPENCLAW_CHAT_TRANSPORT_VALUE="auto"
fi
OPENCLAW_CHAT_TRANSPORT_VALUE="$(printf "%s" "$OPENCLAW_CHAT_TRANSPORT_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
case "$OPENCLAW_CHAT_TRANSPORT_VALUE" in
  rpc|openresponses|auto) ;;
  *) OPENCLAW_CHAT_TRANSPORT_VALUE="auto" ;;
esac
log_info "Writing OPENCLAW_CHAT_TRANSPORT=$OPENCLAW_CHAT_TRANSPORT_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "OPENCLAW_CHAT_TRANSPORT" "$OPENCLAW_CHAT_TRANSPORT_VALUE"
OPENCLAW_GATEWAY_USE_DEVICE_AUTH_VALUE="$(resolve_openclaw_gateway_device_auth_value "$INSTALL_DIR/.env" "$ENV_FILE_CREATED")"
log_info "Writing OPENCLAW_GATEWAY_USE_DEVICE_AUTH=$OPENCLAW_GATEWAY_USE_DEVICE_AUTH_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "OPENCLAW_GATEWAY_USE_DEVICE_AUTH" "$OPENCLAW_GATEWAY_USE_DEVICE_AUTH_VALUE"
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

DEFAULT_CONTEXT_FETCH_TIMEOUT_MS="3000"
DEFAULT_CONTEXT_FETCH_RETRIES="1"
DEFAULT_CONTEXT_FALLBACK_MODES="full,auto,cheap"
DEFAULT_CONTEXT_MAX_CHARS="2200"
DEFAULT_CONTEXT_CACHE_TTL_MS="45000"
DEFAULT_CONTEXT_CACHE_MAX_ENTRIES="120"
DEFAULT_CONTEXT_USE_CACHE_ON_FAILURE="1"
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

CONTEXT_FETCH_RETRIES_VALUE=""
if [ -n "$CONTEXT_FETCH_RETRIES_OVERRIDE" ]; then
  CONTEXT_FETCH_RETRIES_VALUE="$CONTEXT_FETCH_RETRIES_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FETCH_RETRIES" >/dev/null 2>&1; then
  CONTEXT_FETCH_RETRIES_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FETCH_RETRIES" || true)"
else
  CONTEXT_FETCH_RETRIES_VALUE="$DEFAULT_CONTEXT_FETCH_RETRIES"
fi
CONTEXT_FETCH_RETRIES_VALUE="$(clamp_int "$CONTEXT_FETCH_RETRIES_VALUE" 0 3 || echo "$DEFAULT_CONTEXT_FETCH_RETRIES")"
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_FETCH_RETRIES=$CONTEXT_FETCH_RETRIES_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FETCH_RETRIES" "$CONTEXT_FETCH_RETRIES_VALUE"

CONTEXT_FALLBACK_MODES_VALUE=""
if [ -n "$CONTEXT_FALLBACK_MODES_OVERRIDE" ]; then
  CONTEXT_FALLBACK_MODES_VALUE="$CONTEXT_FALLBACK_MODES_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODES" >/dev/null 2>&1; then
  CONTEXT_FALLBACK_MODES_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODES" || true)"
else
  CONTEXT_FALLBACK_MODES_VALUE="$DEFAULT_CONTEXT_FALLBACK_MODES"
fi
CONTEXT_FALLBACK_MODES_VALUE="$(printf "%s" "$CONTEXT_FALLBACK_MODES_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
CONTEXT_FALLBACK_MODES_VALUE="$(printf "%s" "$CONTEXT_FALLBACK_MODES_VALUE" | tr -d '[:space:]')"
VALIDATED_CONTEXT_FALLBACK_MODES=""
IFS=',' read -r -a _context_fallback_modes <<< "$CONTEXT_FALLBACK_MODES_VALUE"
for _mode in "${_context_fallback_modes[@]}"; do
  [ -n "$_mode" ] || continue
  if ! is_valid_context_mode "$_mode"; then
    log_warn "Ignoring invalid context fallback mode: $_mode"
    continue
  fi
  case ",$VALIDATED_CONTEXT_FALLBACK_MODES," in
    *",$_mode,"*) continue ;;
  esac
  if [ -z "$VALIDATED_CONTEXT_FALLBACK_MODES" ]; then
    VALIDATED_CONTEXT_FALLBACK_MODES="$_mode"
  else
    VALIDATED_CONTEXT_FALLBACK_MODES="$VALIDATED_CONTEXT_FALLBACK_MODES,$_mode"
  fi
done
if [ -z "$VALIDATED_CONTEXT_FALLBACK_MODES" ]; then
  VALIDATED_CONTEXT_FALLBACK_MODES="$DEFAULT_CONTEXT_FALLBACK_MODES"
fi
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODES=$VALIDATED_CONTEXT_FALLBACK_MODES in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODES" "$VALIDATED_CONTEXT_FALLBACK_MODES"

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

CONTEXT_CACHE_TTL_MS_VALUE=""
if [ -n "$CONTEXT_CACHE_TTL_MS_OVERRIDE" ]; then
  CONTEXT_CACHE_TTL_MS_VALUE="$CONTEXT_CACHE_TTL_MS_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_CACHE_TTL_MS" >/dev/null 2>&1; then
  CONTEXT_CACHE_TTL_MS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_CACHE_TTL_MS" || true)"
else
  CONTEXT_CACHE_TTL_MS_VALUE="$DEFAULT_CONTEXT_CACHE_TTL_MS"
fi
CONTEXT_CACHE_TTL_MS_VALUE="$(clamp_int "$CONTEXT_CACHE_TTL_MS_VALUE" 0 300000 || echo "$DEFAULT_CONTEXT_CACHE_TTL_MS")"
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_CACHE_TTL_MS=$CONTEXT_CACHE_TTL_MS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_CACHE_TTL_MS" "$CONTEXT_CACHE_TTL_MS_VALUE"

CONTEXT_CACHE_MAX_ENTRIES_VALUE=""
if [ -n "$CONTEXT_CACHE_MAX_ENTRIES_OVERRIDE" ]; then
  CONTEXT_CACHE_MAX_ENTRIES_VALUE="$CONTEXT_CACHE_MAX_ENTRIES_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_CACHE_MAX_ENTRIES" >/dev/null 2>&1; then
  CONTEXT_CACHE_MAX_ENTRIES_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_CACHE_MAX_ENTRIES" || true)"
else
  CONTEXT_CACHE_MAX_ENTRIES_VALUE="$DEFAULT_CONTEXT_CACHE_MAX_ENTRIES"
fi
CONTEXT_CACHE_MAX_ENTRIES_VALUE="$(clamp_int "$CONTEXT_CACHE_MAX_ENTRIES_VALUE" 8 1000 || echo "$DEFAULT_CONTEXT_CACHE_MAX_ENTRIES")"
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_CACHE_MAX_ENTRIES=$CONTEXT_CACHE_MAX_ENTRIES_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_CACHE_MAX_ENTRIES" "$CONTEXT_CACHE_MAX_ENTRIES_VALUE"

CONTEXT_USE_CACHE_ON_FAILURE_VALUE=""
if [ -n "$CONTEXT_USE_CACHE_ON_FAILURE_OVERRIDE" ]; then
  CONTEXT_USE_CACHE_ON_FAILURE_VALUE="$CONTEXT_USE_CACHE_ON_FAILURE_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE" >/dev/null 2>&1; then
  CONTEXT_USE_CACHE_ON_FAILURE_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE" || true)"
else
  CONTEXT_USE_CACHE_ON_FAILURE_VALUE="$DEFAULT_CONTEXT_USE_CACHE_ON_FAILURE"
fi
CONTEXT_USE_CACHE_ON_FAILURE_VALUE="$(printf "%s" "$CONTEXT_USE_CACHE_ON_FAILURE_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
case "$CONTEXT_USE_CACHE_ON_FAILURE_VALUE" in
  1|true|yes|on) CONTEXT_USE_CACHE_ON_FAILURE_VALUE="1" ;;
  0|false|no|off) CONTEXT_USE_CACHE_ON_FAILURE_VALUE="0" ;;
  *)
    log_warn "Invalid CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE=$CONTEXT_USE_CACHE_ON_FAILURE_VALUE. Using default: $DEFAULT_CONTEXT_USE_CACHE_ON_FAILURE"
    CONTEXT_USE_CACHE_ON_FAILURE_VALUE="$DEFAULT_CONTEXT_USE_CACHE_ON_FAILURE"
    ;;
esac
log_info "Writing CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE=$CONTEXT_USE_CACHE_ON_FAILURE_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE" "$CONTEXT_USE_CACHE_ON_FAILURE_VALUE"

# Controls whether OpenClaw memory_search/memory_get is allowed during normal turns.
# Default is off (0): prefer Clawboard retrieval context.
LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH" >/dev/null 2>&1; then
  LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH" || true)"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_DISABLE_OPENCLAW_MEMORY_SEARCH" >/dev/null 2>&1; then
  LEGACY_DISABLE_OPENCLAW_MEMORY_SEARCH_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_DISABLE_OPENCLAW_MEMORY_SEARCH" || true)"
  LEGACY_DISABLE_OPENCLAW_MEMORY_SEARCH_VALUE="$(printf "%s" "$LEGACY_DISABLE_OPENCLAW_MEMORY_SEARCH_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  case "$LEGACY_DISABLE_OPENCLAW_MEMORY_SEARCH_VALUE" in
    1|true|yes|on) LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE="0" ;;
    0|false|no|off) LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE="1" ;;
    *)
      log_warn "Invalid legacy CLAWBOARD_LOGGER_DISABLE_OPENCLAW_MEMORY_SEARCH=$LEGACY_DISABLE_OPENCLAW_MEMORY_SEARCH_VALUE. Using default enable=0"
      LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE="0"
      ;;
  esac
else
  LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE="0"
fi
LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE="$(printf "%s" "$LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
case "$LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE" in
  1|true|yes|on) LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE="1" ;;
  0|false|no|off) LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE="0" ;;
  *)
    log_warn "Invalid CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH=$LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE. Using default: 0"
    LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE="0"
    ;;
esac
log_info "Writing CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH=$LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH" "$LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE"
remove_env_key "$INSTALL_DIR/.env" "CLAWBOARD_LOGGER_DISABLE_OPENCLAW_MEMORY_SEARCH"

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

OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS" >/dev/null 2>&1; then
  OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS" || true)"
else
  OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS_VALUE="1209600"
fi
OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS_VALUE="$(clamp_int "$OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS_VALUE" 60 7776000 || echo "1209600")"
log_info "Writing OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS=$OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS" "$OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS_VALUE"

OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES" >/dev/null 2>&1; then
  OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES" || true)"
else
  OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES_VALUE="24"
fi
OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES_VALUE="$(clamp_int "$OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES_VALUE" 1 200 || echo "24")"
log_info "Writing OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES=$OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES" "$OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES_VALUE"

OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD" >/dev/null 2>&1; then
  OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD" || true)"
else
  OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD_VALUE="3"
fi
OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD_VALUE="$(clamp_int "$OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD_VALUE" 0 20 || echo "3")"
log_info "Writing OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD=$OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD" "$OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD_VALUE"

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

VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE=""
if [ -n "$VECTOR_INCLUDE_TOOL_CALL_LOGS_OVERRIDE" ]; then
  VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE="$VECTOR_INCLUDE_TOOL_CALL_LOGS_OVERRIDE"
elif read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_VECTOR_INCLUDE_TOOL_CALL_LOGS" >/dev/null 2>&1; then
  VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_VECTOR_INCLUDE_TOOL_CALL_LOGS" || true)"
else
  VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE="0"
fi
VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE="$(printf "%s" "$VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
case "$VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE" in
  1|true|yes|on) VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE="1" ;;
  *) VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE="0" ;;
esac
log_info "Writing CLAWBOARD_VECTOR_INCLUDE_TOOL_CALL_LOGS=$VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_VECTOR_INCLUDE_TOOL_CALL_LOGS" "$VECTOR_INCLUDE_TOOL_CALL_LOGS_VALUE"

SEARCH_EFFECTIVE_LIMIT_TOPICS_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TOPICS" >/dev/null 2>&1; then
  SEARCH_EFFECTIVE_LIMIT_TOPICS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TOPICS" || true)"
else
  SEARCH_EFFECTIVE_LIMIT_TOPICS_VALUE="120"
fi
SEARCH_EFFECTIVE_LIMIT_TOPICS_VALUE="$(clamp_int "$SEARCH_EFFECTIVE_LIMIT_TOPICS_VALUE" 1 120 || echo "120")"
log_info "Writing CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TOPICS=$SEARCH_EFFECTIVE_LIMIT_TOPICS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TOPICS" "$SEARCH_EFFECTIVE_LIMIT_TOPICS_VALUE"

SEARCH_EFFECTIVE_LIMIT_TASKS_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TASKS" >/dev/null 2>&1; then
  SEARCH_EFFECTIVE_LIMIT_TASKS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TASKS" || true)"
else
  SEARCH_EFFECTIVE_LIMIT_TASKS_VALUE="240"
fi
SEARCH_EFFECTIVE_LIMIT_TASKS_VALUE="$(clamp_int "$SEARCH_EFFECTIVE_LIMIT_TASKS_VALUE" 1 240 || echo "240")"
log_info "Writing CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TASKS=$SEARCH_EFFECTIVE_LIMIT_TASKS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TASKS" "$SEARCH_EFFECTIVE_LIMIT_TASKS_VALUE"

SEARCH_EFFECTIVE_LIMIT_LOGS_VALUE=""
if read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_LOGS" >/dev/null 2>&1; then
  SEARCH_EFFECTIVE_LIMIT_LOGS_VALUE="$(read_env_value_from_file "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_LOGS" || true)"
else
  SEARCH_EFFECTIVE_LIMIT_LOGS_VALUE="320"
fi
SEARCH_EFFECTIVE_LIMIT_LOGS_VALUE="$(clamp_int "$SEARCH_EFFECTIVE_LIMIT_LOGS_VALUE" 10 320 || echo "320")"
log_info "Writing CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_LOGS=$SEARCH_EFFECTIVE_LIMIT_LOGS_VALUE in $INSTALL_DIR/.env..."
upsert_env_value "$INSTALL_DIR/.env" "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_LOGS" "$SEARCH_EFFECTIVE_LIMIT_LOGS_VALUE"

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
    report_openclaw_pending_device_approvals
    sanitize_clawboard_logger_stale_refs
    openclaw_doctor_fix_once || true

    openclaw_cfg_txn_begin

    log_info "Enabling OpenClaw OpenResponses endpoint (POST /v1/responses)..."
    CURRENT_RESPONSES_ENABLED="$(openclaw_cfg_get_scalar_normalized gateway.http.endpoints.responses.enabled)"
    if [ "$CURRENT_RESPONSES_ENABLED" != "true" ]; then
      openclaw_cfg_set_txn gateway.http.endpoints.responses.enabled true json true
      OPENCLAW_GATEWAY_RESTART_NEEDED=true
      log_success "OpenResponses endpoint enabled."
    else
      log_success "OpenResponses endpoint already enabled."
    fi

    log_info "Cross-agent follow-up checks will use session_status + queued subagent announces, with explicit cross-agent session visibility for supervised recovery."

    CURRENT_SESSION_TOOLS_VISIBILITY="$(openclaw_cfg_get_scalar_normalized tools.sessions.visibility)"
    if [ "$CURRENT_SESSION_TOOLS_VISIBILITY" != "all" ]; then
      openclaw_cfg_set_txn tools.sessions.visibility all string true
      OPENCLAW_GATEWAY_RESTART_NEEDED=true
      log_success "Set tools.sessions.visibility=all."
    else
      log_success "tools.sessions.visibility already set to all."
    fi

    CURRENT_SANDBOX_SESSION_VISIBILITY="$(openclaw_cfg_get_scalar_normalized agents.defaults.sandbox.sessionToolsVisibility)"
    if [ "$CURRENT_SANDBOX_SESSION_VISIBILITY" != "all" ]; then
      openclaw_cfg_set_txn agents.defaults.sandbox.sessionToolsVisibility all string true
      OPENCLAW_GATEWAY_RESTART_NEEDED=true
      log_success "Set agents.defaults.sandbox.sessionToolsVisibility=all."
    else
      log_success "agents.defaults.sandbox.sessionToolsVisibility already set to all."
    fi

    CURRENT_AGENT_TO_AGENT_ENABLED="$(openclaw_cfg_get_scalar_normalized tools.agentToAgent.enabled)"
    if [ "$CURRENT_AGENT_TO_AGENT_ENABLED" != "true" ]; then
      openclaw_cfg_set_txn tools.agentToAgent.enabled true json true
      OPENCLAW_GATEWAY_RESTART_NEEDED=true
      log_success "Set tools.agentToAgent.enabled=true."
    else
      log_success "tools.agentToAgent.enabled already true."
    fi

    log_info "Reconciling iMessage group allowlist config (prevents silent group drops + doctor warnings)..."
    CURRENT_IMESSAGE_GROUP_POLICY="$(openclaw_cfg_get_scalar_normalized channels.imessage.groupPolicy)"
    CURRENT_IMESSAGE_GROUP_ALLOW_FROM="$(openclaw_cfg_get_scalar_normalized channels.imessage.groupAllowFrom)"
    if [ "$CURRENT_IMESSAGE_GROUP_POLICY" = "allowlist" ]; then
      if [ -z "$CURRENT_IMESSAGE_GROUP_ALLOW_FROM" ] || [ "$CURRENT_IMESSAGE_GROUP_ALLOW_FROM" = "[]" ] || [ "$CURRENT_IMESSAGE_GROUP_ALLOW_FROM" = "null" ]; then
        if openclaw_cfg_set_txn channels.imessage.groupAllowFrom '["*"]' json false; then
          OPENCLAW_GATEWAY_RESTART_NEEDED=true
          log_success "Set channels.imessage.groupAllowFrom=[\"*\"] for allowlist policy."
        else
          log_warn "Failed to set channels.imessage.groupAllowFrom. Continuing."
        fi
      else
        log_success "channels.imessage.groupAllowFrom already set for allowlist policy."
      fi
    else
      log_success "channels.imessage.groupPolicy is not allowlist; no groupAllowFrom patch needed."
    fi

    openclaw_cfg_txn_verify_or_rollback
    openclaw_cfg_txn_commit

    if [ "$SKIP_SKILL" = false ]; then
      log_info "Installing Clawboard skill (mode: $SKILL_INSTALL_MODE)..."
      SKILL_REPO_SRC="$INSTALL_DIR/skills/clawboard"
      SKILL_OPENCLAW_DST="$OPENCLAW_SKILLS_DIR/clawboard"
      LOGGER_SKILL_REPO_SRC="$INSTALL_DIR/skills/clawboard-logger"
      LOGGER_SKILL_OPENCLAW_DST="$OPENCLAW_SKILLS_DIR/clawboard-logger"
      SKILL_MANAGED_COPY_ROOT="$OPENCLAW_HOME/.clawboard/skill-copies"

      if [ ! -d "$SKILL_REPO_SRC" ]; then
        log_warn "Repo skill directory not found: $SKILL_REPO_SRC"
      else
        mkdir -p "$OPENCLAW_SKILLS_DIR"
        if install_skill_directory_atomic "$SKILL_REPO_SRC" "$SKILL_OPENCLAW_DST" "$SKILL_INSTALL_MODE" "$SKILL_MANAGED_COPY_ROOT" "clawboard"; then
          log_success "Skill installed: $SKILL_OPENCLAW_DST"
        else
          rc=$?
          if [ "$rc" -eq 10 ]; then
            log_success "Skill already up to date: $SKILL_OPENCLAW_DST"
          else
            log_error "Failed installing skill to $SKILL_OPENCLAW_DST"
          fi
        fi
      fi

      if [ "$SKILL_INSTALL_MODE" = "copy" ]; then
        log_warn "Using copy mode for skills. Repo edits will not appear in OpenClaw until bootstrap is rerun; OpenClaw skill paths are swapped atomically to managed copies."
      fi

      if [ -d "$LOGGER_SKILL_REPO_SRC" ]; then
        if install_skill_directory_atomic "$LOGGER_SKILL_REPO_SRC" "$LOGGER_SKILL_OPENCLAW_DST" "$SKILL_INSTALL_MODE" "$SKILL_MANAGED_COPY_ROOT" "clawboard-logger"; then
          log_success "Logger skill installed: $LOGGER_SKILL_OPENCLAW_DST"
        else
          rc=$?
          if [ "$rc" -eq 10 ]; then
            log_success "Logger skill already up to date: $LOGGER_SKILL_OPENCLAW_DST"
          else
            log_error "Failed installing logger skill to $LOGGER_SKILL_OPENCLAW_DST"
          fi
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
      # Compile TypeScript source to index.js before installing so the plugin reflects the
      # latest source. Non-fatal: if tsc is unavailable the existing index.js is used as-is.
      if [ -f "$INSTALL_DIR/node_modules/.bin/tsc" ] && [ -f "$INSTALL_DIR/extensions/clawboard-logger/tsconfig.plugin.json" ]; then
        log_info "Compiling clawboard-logger TypeScript plugin..."
        (cd "$INSTALL_DIR" && node_modules/.bin/tsc -p extensions/clawboard-logger/tsconfig.plugin.json 2>/dev/null) \
          || log_warn "Plugin TypeScript compile failed; using existing index.js"
      fi
      PLUGIN_EXT_DIR="$OPENCLAW_HOME/extensions/clawboard-logger"
      _PLUGIN_BASE_URL_INIT="${API_URL:-}"
      if [ -z "$_PLUGIN_BASE_URL_INIT" ]; then
        _PLUGIN_BASE_URL_INIT="http://localhost:8010"
      fi
      LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_JSON=false
      if [ "$LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_VALUE" = "1" ]; then
        LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_JSON=true
      fi
      CONTEXT_USE_CACHE_ON_FAILURE_JSON=false
      if [ "$CONTEXT_USE_CACHE_ON_FAILURE_VALUE" = "1" ]; then
        CONTEXT_USE_CACHE_ON_FAILURE_JSON=true
      fi
      CONTEXT_FALLBACK_MODES_JSON="["
      IFS=',' read -r -a _fallback_modes_for_json <<< "$VALIDATED_CONTEXT_FALLBACK_MODES"
      for _mode in "${_fallback_modes_for_json[@]}"; do
        [ -n "$_mode" ] || continue
        if [ "$CONTEXT_FALLBACK_MODES_JSON" != "[" ]; then
          CONTEXT_FALLBACK_MODES_JSON="$CONTEXT_FALLBACK_MODES_JSON,"
        fi
        CONTEXT_FALLBACK_MODES_JSON="$CONTEXT_FALLBACK_MODES_JSON\"$_mode\""
      done
      CONTEXT_FALLBACK_MODES_JSON="$CONTEXT_FALLBACK_MODES_JSON]"
      _LOGGER_API_PORT="$(extract_url_port "$API_URL" "8010")"
      _LOGGER_FALLBACK_1="http://127.0.0.1:${_LOGGER_API_PORT}"
      _LOGGER_FALLBACK_2="http://localhost:${_LOGGER_API_PORT}"
      if [ -n "$TOKEN" ]; then
        CONFIG_JSON=$(printf '{"baseUrl":"%s","token":"%s","enabled":true,"contextMode":"%s","contextFetchTimeoutMs":%s,"contextFetchRetries":%s,"contextFallbackModes":%s,"contextMaxChars":%s,"contextCacheTtlMs":%s,"contextCacheMaxEntries":%s,"contextUseCacheOnFailure":%s,"enableOpenClawMemorySearch":%s,"baseUrlFallbacks":["%s","%s"]}' "$API_URL" "$TOKEN" "$CONTEXT_MODE_VALUE" "$CONTEXT_FETCH_TIMEOUT_MS_VALUE" "$CONTEXT_FETCH_RETRIES_VALUE" "$CONTEXT_FALLBACK_MODES_JSON" "$CONTEXT_MAX_CHARS_VALUE" "$CONTEXT_CACHE_TTL_MS_VALUE" "$CONTEXT_CACHE_MAX_ENTRIES_VALUE" "$CONTEXT_USE_CACHE_ON_FAILURE_JSON" "$LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_JSON" "$_LOGGER_FALLBACK_1" "$_LOGGER_FALLBACK_2")
      else
        CONFIG_JSON=$(printf '{"baseUrl":"%s","enabled":true,"contextMode":"%s","contextFetchTimeoutMs":%s,"contextFetchRetries":%s,"contextFallbackModes":%s,"contextMaxChars":%s,"contextCacheTtlMs":%s,"contextCacheMaxEntries":%s,"contextUseCacheOnFailure":%s,"enableOpenClawMemorySearch":%s,"baseUrlFallbacks":["%s","%s"]}' "$API_URL" "$CONTEXT_MODE_VALUE" "$CONTEXT_FETCH_TIMEOUT_MS_VALUE" "$CONTEXT_FETCH_RETRIES_VALUE" "$CONTEXT_FALLBACK_MODES_JSON" "$CONTEXT_MAX_CHARS_VALUE" "$CONTEXT_CACHE_TTL_MS_VALUE" "$CONTEXT_CACHE_MAX_ENTRIES_VALUE" "$CONTEXT_USE_CACHE_ON_FAILURE_JSON" "$LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH_JSON" "$_LOGGER_FALLBACK_1" "$_LOGGER_FALLBACK_2")
      fi
      if ! install_clawboard_logger_plugin_transactional "$INSTALL_DIR/extensions/clawboard-logger" "$PLUGIN_EXT_DIR" "$CONFIG_JSON" true; then
        log_error "Failed installing clawboard-logger plugin atomically."
      fi

      log_info "Configuring logger plugin..."
      _LOGGER_CFG_BASEURL="$(openclaw_cfg_get_scalar_normalized plugins.entries.clawboard-logger.config.baseUrl || true)"
      if [ -z "$_LOGGER_CFG_BASEURL" ] || [ "$_LOGGER_CFG_BASEURL" = "null" ]; then
        log_error "Logger plugin config missing required baseUrl after configuration write."
      fi
      OPENCLAW_GATEWAY_RESTART_NEEDED=true
      log_success "Logger plugin installed and enabled."
      ensure_clawboard_logger_in_allow
    fi

    maybe_deploy_agent_templates
    maybe_deploy_contract_docs

    setup_specialist_agents

    maybe_offer_agentic_team_setup "$AGENTIC_TEAM_SETUP_MODE"
    sync_main_subagent_allow_agents
    maybe_apply_agent_directives
    audit_openclaw_bootstrap_budget
    verify_agent_contract_alignment

    maybe_run_local_memory_setup

    # Enforce QMD settings only when QMD is the active memory backend.
    CURRENT_MEMORY_BACKEND="$(openclaw_cfg_get_scalar_normalized memory.backend | tr '[:upper:]' '[:lower:]')"
    if [ "$CURRENT_MEMORY_BACKEND" = "qmd" ]; then
      openclaw_cfg_txn_begin
      # The skill script's configure_qmd_memory_boost() may write QMD config values;
      # this block runs last and guarantees the correct values are always applied.
      log_info "Enforcing QMD memory search settings (sessions off, memorySearch sources=memory, maxResults=20, timeoutMs=8000)..."
      CURRENT_QMD_SESSIONS_ENABLED="$(openclaw_cfg_get_scalar_normalized memory.qmd.sessions.enabled)"
      if [ "$CURRENT_QMD_SESSIONS_ENABLED" != "false" ]; then
        openclaw_cfg_set_txn memory.qmd.sessions.enabled false json true
        OPENCLAW_GATEWAY_RESTART_NEEDED=true
        log_success "Disabled QMD session indexing (memory.qmd.sessions.enabled=false)."
      else
        log_success "QMD session indexing already disabled."
      fi

      CURRENT_MEMORY_SOURCES="$(openclaw_cfg_get_scalar_normalized agents.defaults.memorySearch.sources)"
      if [ "$CURRENT_MEMORY_SOURCES" != '["memory"]' ]; then
        openclaw_cfg_set_txn agents.defaults.memorySearch.sources '["memory"]' json true
        OPENCLAW_GATEWAY_RESTART_NEEDED=true
        log_success "Aligned memorySearch sources for QMD backend (agents.defaults.memorySearch.sources=[\"memory\"])."
      else
        log_success "memorySearch sources already aligned for QMD backend."
      fi

      CURRENT_SESSION_MEMORY_FLAG="$(openclaw_cfg_get_scalar_normalized agents.defaults.memorySearch.experimental.sessionMemory)"
      if [ "$CURRENT_SESSION_MEMORY_FLAG" != "false" ]; then
        openclaw_cfg_set_txn agents.defaults.memorySearch.experimental.sessionMemory false json true
        OPENCLAW_GATEWAY_RESTART_NEEDED=true
        log_success "Disabled memorySearch.experimental.sessionMemory under QMD backend."
      else
        log_success "sessionMemory flag already disabled for QMD backend."
      fi

      CURRENT_QMD_MAX_RESULTS="$(openclaw_cfg_get_scalar_normalized memory.qmd.limits.maxResults)"
      if [ -z "$CURRENT_QMD_MAX_RESULTS" ] || { [ -n "$CURRENT_QMD_MAX_RESULTS" ] && [ "$CURRENT_QMD_MAX_RESULTS" -lt 20 ] 2>/dev/null; }; then
        openclaw_cfg_set_txn memory.qmd.limits.maxResults 20 json true
        log_success "Set memory.qmd.limits.maxResults=20."
      else
        log_success "QMD max results already set to $CURRENT_QMD_MAX_RESULTS (>=20)."
      fi

      CURRENT_QMD_TIMEOUT="$(openclaw_cfg_get_scalar_normalized memory.qmd.limits.timeoutMs)"
      if [ -z "$CURRENT_QMD_TIMEOUT" ] || { [ -n "$CURRENT_QMD_TIMEOUT" ] && [ "$CURRENT_QMD_TIMEOUT" -lt 8000 ] 2>/dev/null; }; then
        openclaw_cfg_set_txn memory.qmd.limits.timeoutMs 8000 json true
        log_success "Set memory.qmd.limits.timeoutMs=8000."
      else
        log_success "QMD timeout already set to ${CURRENT_QMD_TIMEOUT}ms (>=8000)."
      fi

      openclaw_cfg_txn_verify_or_rollback
      openclaw_cfg_txn_commit
    else
      log_info "Skipping QMD enforcement; memory.backend=${CURRENT_MEMORY_BACKEND:-unset}."
    fi

    log_info "Running openclaw doctor --fix to remove any config keys unrecognized by the current gateway version..."
    if openclaw_doctor_fix_safe; then
      log_success "openclaw doctor --fix completed."
    else
      log_warn "openclaw doctor --fix returned non-zero (may be safe to ignore)."
    fi

    reconcile_openclaw_gateway_launchagent_token

    maybe_offer_obsidian_memory_setup "$OBSIDIAN_MEMORY_SETUP_MODE"
    maybe_offer_memory_backup_setup "$MEMORY_BACKUP_SETUP_MODE"


    # Run at most one bootstrap-managed QMD refresh pass. setup_obsidian_brain.sh already
    # performs its own full refresh after registering vault paths, so skip the duplicate
    # bootstrap sweep when that setup completed successfully.
    # Ongoing re-indexing of new files is handled automatically by qmd's built-in
    # update.interval: "5m" — no cron job is needed for normal operation.
    # To manually re-index at any time: openclaw memory index --agent <id> --force
    if [ "$OBSIDIAN_MEMORY_SETUP_STATUS" = "configured" ]; then
      log_info "Skipping bootstrap QMD refresh because setup_obsidian_brain.sh already refreshed indexes."
    elif [ "$SKIP_LOCAL_MEMORY_SETUP" = true ]; then
      log_info "Skipping bootstrap memory index refresh because local memory setup was skipped."
    elif command -v openclaw >/dev/null 2>&1; then
      log_info "Refreshing QMD memory indexes for all configured agents..."
      _idx_timeout_s="${OPENCLAW_MEMORY_INDEX_TIMEOUT_SEC:-180}"
      _idx_agent_ids=()
      _idx_raw=""
      _idx_raw="$(python3 - "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" <<'PY'
import json, sys, re
VALID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
def norm(v):
    raw = re.sub(r"[^a-z0-9-]+", "-", (v or "").strip().lower()).strip("-")[:64]
    return raw if raw and VALID.match(raw) else "main"
try:
    cfg = json.load(open(sys.argv[1]))
    seen = set()
    for e in (cfg.get("agents") or {}).get("list") or []:
        aid = norm(e.get("id"))
        if aid not in seen:
            seen.add(aid)
            print(aid)
except Exception:
    print("main")
PY
      2>/dev/null)" || _idx_raw="main"
      while IFS= read -r _aid; do
        [[ -n "$_aid" ]] || continue
        _idx_agent_ids+=("$_aid")
      done <<< "$_idx_raw"
      [[ ${#_idx_agent_ids[@]} -gt 0 ]] || _idx_agent_ids=("main")

      _idx_failures=0
      for _aid in "${_idx_agent_ids[@]}"; do
        log_info "  openclaw memory index --agent $_aid --force"
        set +e
        _idx_output="$(run_with_timeout_capture "$_idx_timeout_s" openclaw memory index --agent "$_aid" --force)"
        _idx_rc=$?
        set -e
        if [[ -n "${_idx_output:-}" ]]; then
          printf "%s\n" "$_idx_output"
        fi
        if [[ "$_idx_rc" -eq 0 ]] && ! memory_index_output_has_errors "${_idx_output:-}"; then
          log_success "  Agent '$_aid' memory index refreshed."
        else
          if [[ "$_idx_rc" -eq 124 ]]; then
            log_warn "  Agent '$_aid' index refresh timed out after ${_idx_timeout_s}s; continuing."
          elif memory_index_output_has_errors "${_idx_output:-}"; then
            log_warn "  Agent '$_aid' index output reported qmd/sqlite errors; retry: openclaw memory index --agent $_aid --force"
          else
            log_warn "  Agent '$_aid' index refresh failed. Retry: openclaw memory index --agent $_aid --force"
          fi
          _idx_failures=$((_idx_failures + 1))
        fi
      done
      if [[ "$_idx_failures" -eq 0 ]]; then
        log_success "QMD memory index refresh complete for all agents."
      else
        log_warn "QMD memory index refresh completed with $_idx_failures warning(s)."
      fi
    else
      log_warn "openclaw CLI not found; skipping QMD index refresh."
    fi

    if [ "$OBSIDIAN_MEMORY_SETUP_STATUS" = "configured" ]; then
      ensure_clawboard_logger_in_allow
    fi
    if [ "$OPENCLAW_GATEWAY_RESTART_NEEDED" = true ] || [ "$OBSIDIAN_MEMORY_SETUP_STATUS" = "configured" ]; then
      if [ "$OBSIDIAN_MEMORY_SETUP_STATUS" = "configured" ]; then
        log_info "Restarting OpenClaw gateway after bootstrap memory configuration..."
      else
        log_info "Restarting OpenClaw gateway to apply configuration..."
      fi
      if openclaw gateway restart >/dev/null 2>&1; then
        log_success "OpenClaw gateway restarted."
      elif openclaw gateway start >/dev/null 2>&1; then
        log_success "OpenClaw gateway started."
      else
        log_warn "Unable to restart OpenClaw gateway automatically. Run: openclaw gateway restart"
      fi
    fi
    ensure_clawboard_logger_in_allow
  fi
fi

maybe_offer_openclaw_heap_setup "$OPENCLAW_HEAP_SETUP_MODE"

echo ""
log_success "Bootstrap complete."
echo "Clawboard UI (access):   $ACCESS_WEB_URL"
echo "Clawboard API (access):  ${ACCESS_API_URL%/}/docs"
echo "Clawboard API (internal): $API_URL"
echo "Workspace IDE:  $WORKSPACE_IDE_BASE_URL_VALUE"
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
case "$AGENTIC_TEAM_SETUP_STATUS" in
  configured|already-configured)
    echo "Agentic team:  configured (${AGENTIC_TEAM_AGENT_IDS:-none})"
    ;;
  incomplete)
    echo "Agentic team:  setup attempted but some specialist workspaces were missing"
    echo "               Current delegation pool: ${AGENTIC_TEAM_AGENT_IDS:-none}"
    echo "               Re-run: bash $INSTALL_DIR/scripts/setup_specialist_agents.sh"
    ;;
  openclaw-missing)
    echo "Agentic team:  openclaw not found on PATH during bootstrap"
    echo "               Add later: openclaw agents add <id> --workspace <resolved-workspace> --non-interactive"
    ;;
  skipped-mode-never|skipped-by-user|skipped-no-tty|skipped-invalid-mode|not-run)
    if [ -n "${AGENTIC_TEAM_AGENT_IDS:-}" ] && [ "$AGENTIC_TEAM_AGENT_IDS" != "none" ]; then
      echo "Agentic team:  current delegation pool = ${AGENTIC_TEAM_AGENT_IDS}"
    else
      echo "Agentic team:  not configured in this run"
      echo "               Use --setup-agentic-team or CLAWBOARD_AGENTIC_TEAM_SETUP=always to enroll specialists"
    fi
    ;;
esac
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
echo "──────────────────────────────────────────────────────────────────────────"
echo "Memory status"
echo "──────────────────────────────────────────────────────────────────────────"
if command -v openclaw >/dev/null 2>&1; then
  MEMORY_STATUS_TIMEOUT_SEC="${OPENCLAW_MEMORY_STATUS_TIMEOUT_SEC:-20}"
  if ! [[ "$MEMORY_STATUS_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || [ "$MEMORY_STATUS_TIMEOUT_SEC" -lt 5 ] || [ "$MEMORY_STATUS_TIMEOUT_SEC" -gt 300 ]; then
    log_warn "Invalid OPENCLAW_MEMORY_STATUS_TIMEOUT_SEC=${MEMORY_STATUS_TIMEOUT_SEC}; using 20s."
    MEMORY_STATUS_TIMEOUT_SEC=20
  fi
  set +e
  MEMORY_STATUS_OUTPUT="$(run_with_timeout_capture "$MEMORY_STATUS_TIMEOUT_SEC" openclaw memory status --deep)"
  MEMORY_STATUS_RC=$?
  set -e
  if [ -n "$MEMORY_STATUS_OUTPUT" ]; then
    printf "%s\n" "$MEMORY_STATUS_OUTPUT"
  fi
  if [ "$MEMORY_STATUS_RC" -eq 124 ]; then
    log_warn "openclaw memory status timed out after ${MEMORY_STATUS_TIMEOUT_SEC}s; continuing."
  elif [ "$MEMORY_STATUS_RC" -ne 0 ]; then
    log_warn "openclaw memory status exited with code $MEMORY_STATUS_RC; continuing."
  fi
else
  echo "(openclaw not on PATH — skipping memory status)"
fi
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
