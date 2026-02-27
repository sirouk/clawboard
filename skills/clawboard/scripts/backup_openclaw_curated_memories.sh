#!/usr/bin/env bash
set -euo pipefail

# backup_openclaw_curated_memories.sh
#
# Sync a *curated* allowlist of continuity files into a dedicated backup git repo,
# then commit+push *only if changed*.
#
# Option B support:
# - Always backs up curated workspace text (MEMORY.md, memory/*.md, SOUL/USER/etc.)
# - Optionally backs up selected OpenClaw files (openclaw.json*, skills/) based on config flags.
# - Optionally exports full Clawboard state (config/topics/tasks/logs + optional attachments).
#
# Config is read from:
#   $HOME/.openclaw/credentials/clawboard-memory-backup.json
# Fallback (optional):
#   $HOME/.openclaw/credentials/clawboard-memory-backup.env
#
# Auth methods:
# - authMethod=ssh (recommended): uses a GitHub Deploy Key (write access must be enabled in repo settings)
# - authMethod=pat (legacy): uses HTTPS + fine-grained PAT via GIT_ASKPASS

say() { printf "%s\n" "$*"; }
die() { say "ERROR: $*" >&2; exit 2; }

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
OPENCLAW_JSON="${OPENCLAW_JSON:-$OPENCLAW_DIR/openclaw.json}"
CRED_JSON="$OPENCLAW_DIR/credentials/clawboard-memory-backup.json"
CRED_ENV="$OPENCLAW_DIR/credentials/clawboard-memory-backup.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPORT_CLAWBOARD_HELPER="$SCRIPT_DIR/export_clawboard_backup.py"

INTERACTIVE=0
VERBOSE=0
NO_PUSH=0

ARG_WORKSPACE_PATH=""
ARG_WORKSPACE_PATHS_JSON=""
ARG_BACKUP_DIR=""
ARG_REPO_URL=""
ARG_REPO_SSH_URL=""
ARG_AUTH_METHOD=""
ARG_DEPLOY_KEY_PATH=""
ARG_GITHUB_USER=""
ARG_GITHUB_PAT=""
ARG_REMOTE_NAME=""
ARG_BRANCH=""
ARG_INCLUDE_OPENCLAW_CONFIG=""
ARG_INCLUDE_OPENCLAW_SKILLS=""
ARG_INCLUDE_CLAWBOARD_STATE=""
ARG_CLAWBOARD_DIR=""
ARG_CLAWBOARD_API_URL=""
ARG_INCLUDE_CLAWBOARD_ATTACHMENTS=""
ARG_INCLUDE_CLAWBOARD_ENV=""
ARG_CLAWBOARD_TOKEN=""
ARG_CLAWBOARD_ATTACHMENTS_DIR=""
ARG_SWEEP_ORPHAN_ATTACHMENTS=""
ARG_ORPHAN_ATTACHMENT_MAX_AGE_DAYS=""
ARG_ORPHAN_ATTACHMENT_SWEEP_MODE=""

usage() {
  cat <<'EOF'
Usage:
  backup_openclaw_curated_memories.sh [options]

Modes:
  (default) non-interactive run for cron/automation
  --interactive              Prompt for missing/overridden values before backup

General options:
  -h, --help                Show this help
  --verbose                 Print extra run details
  --no-push                 Commit locally but do not push

Config source options:
  --credentials-json PATH   Override credentials JSON path
  --credentials-env PATH    Override credentials env path

Runtime override options:
  --workspace-path PATH
  --workspace-paths-json JSON
  --backup-dir PATH
  --repo-url URL
  --repo-ssh-url URL
  --auth-method ssh|pat
  --deploy-key-path PATH
  --github-user USER
  --github-pat TOKEN
  --remote-name NAME
  --branch NAME
  --clawboard-dir PATH
  --clawboard-api-url URL
  --clawboard-token TOKEN
  --clawboard-attachments-dir PATH
  --orphan-max-age-days N
  --orphan-sweep-mode report|prune

Boolean toggles:
  --include-openclaw-config | --exclude-openclaw-config
  --include-openclaw-skills | --exclude-openclaw-skills
  --include-clawboard-state | --exclude-clawboard-state
  --include-clawboard-attachments | --exclude-clawboard-attachments
  --include-clawboard-env | --exclude-clawboard-env
  --sweep-orphan-attachments | --no-sweep-orphan-attachments

Notes:
  - Cron should call this script with no args.
  - With attachments enabled, orphan attachment files in the backup snapshot
    (not referenced by export/attachments.json) are pruned when older than
    orphan-max-age-days (default: 14).
  - Source attachments are never deleted by this script.
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

json_get() {
  # Usage: json_get <file> <jq-filter>
  local f="$1"; shift
  local filter="$1"; shift || true
  python3 - <<'PY' "$f" "$filter"
import json,sys
p=sys.argv[1]
filt=sys.argv[2]
with open(p,'r') as fh:
  d=json.load(fh)
# extremely tiny "jq-like" getter for dot paths: .a.b.c
if not filt.startswith('.'):
  print('')
  sys.exit(0)
keys=[k for k in filt.split('.') if k]
cur=d
try:
  for k in keys:
    cur=cur[k]
except Exception:
  cur=""
if cur is None:
  cur=""
print(cur if isinstance(cur,str) else json.dumps(cur))
PY
}

load_env_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  # shellcheck disable=SC1090
  set -a; source "$f"; set +a
}

read_env_value() {
  local file_path="$1"
  local key="$2"
  local line
  [[ -f "$file_path" ]] || return 1
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
  [[ -n "$line" ]] || return 1
  printf "%s" "$line"
}

read_flag_value() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "Missing value for $flag"
  printf "%s" "$value"
}

prompt_value() {
  local prompt="$1"
  local current="${2:-}"
  local secret="${3:-0}"
  local answer=""

  if [[ "$secret" == "1" ]]; then
    if [[ -n "$current" ]]; then
      read -r -s -p "$prompt [set; Enter to keep]: " answer
    else
      read -r -s -p "$prompt: " answer
    fi
    printf "\n"
  else
    read -r -p "$prompt [${current}]: " answer
  fi

  if [[ -z "$answer" ]]; then
    printf "%s" "$current"
  else
    printf "%s" "$answer"
  fi
}

# bash 3.2 compatibility (macOS default /bin/bash): no ${var,,}
lc() { tr '[:upper:]' '[:lower:]' <<<"${1:-}"; }

# Booleans are stored as JSON true/false; our json_get returns a JSON string for non-strings.
# Accept: true/false/"true"/"false"/1/0/yes/no
as_bool() {
  local v="${1:-}"
  v="${v//\"/}"
  case "$(lc "$v")" in
    true|1|yes|y) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_bool() {
  local prompt="$1"
  local current="${2:-false}"
  local hint="y/N"
  local answer=""
  if as_bool "$current"; then
    hint="Y/n"
  fi
  while true; do
    read -r -p "$prompt [$hint]: " answer
    if [[ -z "$answer" ]]; then
      if as_bool "$current"; then
        printf "true"
      else
        printf "false"
      fi
      return 0
    fi
    case "$(lc "$answer")" in
      y|yes|true|1)
        printf "true"
        return 0
        ;;
      n|no|false|0)
        printf "false"
        return 0
        ;;
      *)
        say "Please answer yes or no."
        ;;
    esac
  done
}

derive_backup_scope_from_openclaw() {
  [[ -f "$OPENCLAW_JSON" ]] || return 0
  local resolved
  resolved="$(
    python3 - "$OPENCLAW_JSON" "$OPENCLAW_DIR" "$HOME" "${OPENCLAW_PROFILE:-}" <<'PY'
import json
import os
import re
import shlex
import sys

cfg_path = sys.argv[1]
openclaw_dir = os.path.abspath(os.path.expanduser(sys.argv[2]))
home_dir = os.path.abspath(os.path.expanduser(sys.argv[3]))
profile = (sys.argv[4] or "").strip()

def q(value: str) -> str:
    return shlex.quote(value)

def profile_workspace(base_dir: str, profile_name: str) -> str:
    raw = (profile_name or "").strip()
    if not raw or raw.lower() == "default":
        return os.path.join(base_dir, "workspace")
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", raw).strip("-")
    if not safe:
        return os.path.join(base_dir, "workspace")
    return os.path.join(base_dir, f"workspace-{safe}")

default_ws = profile_workspace(openclaw_dir, profile)

def norm(value: str) -> str:
    p = os.path.expanduser((value or "").strip())
    if not p:
        return ""
    return os.path.abspath(p)

def norm_id(value: str) -> str:
    raw = (value or "").strip().lower()
    if not raw:
        return "main"
    raw = re.sub(r"[^a-z0-9-]+", "-", raw)
    raw = re.sub(r"^-+", "", raw)
    raw = re.sub(r"-+$", "", raw)
    return raw[:64] or "main"

cfg = {}
try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        parsed = json.load(f)
        if isinstance(parsed, dict):
            cfg = parsed
except Exception:
    cfg = {}

agents = ((cfg.get("agents") or {}).get("list") or [])
entries = [entry for entry in agents if isinstance(entry, dict)]
indexed_entries = list(enumerate(entries))
default_indexed = [pair for pair in indexed_entries if pair[1].get("default") is True]
default_index, default_entry = default_indexed[0] if default_indexed else (indexed_entries[0] if indexed_entries else (-1, {}))
main_indexed = [pair for pair in indexed_entries if norm_id(str(pair[1].get("id") or "")) == "main"]
chosen_index, chosen_entry = main_indexed[0] if main_indexed else (default_index, default_entry)

workspace = ""
if isinstance(chosen_entry, dict):
    candidate = chosen_entry.get("workspace")
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()

if not workspace:
    candidate = (((cfg.get("agents") or {}).get("defaults") or {}).get("workspace"))
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()

if not workspace:
    candidate = ((cfg.get("agents") or {}).get("workspace"))
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()

if not workspace:
    candidate = ((cfg.get("agent") or {}).get("workspace"))
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()

if not workspace:
    candidate = cfg.get("workspace")
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()

if not workspace:
    workspace = default_ws

workspace = norm(workspace)
if workspace == openclaw_dir:
    workspace = default_ws

workspaces = []
if workspace:
    workspaces.append(workspace)

for entry in entries:
    candidate = entry.get("workspace")
    if isinstance(candidate, str) and candidate.strip():
        resolved = norm(candidate)
    else:
        resolved = workspace
    if resolved and resolved not in workspaces:
        workspaces.append(resolved)

qmd_paths = []
memory_cfg = cfg.get("memory") if isinstance(cfg.get("memory"), dict) else {}
qmd_cfg = memory_cfg.get("qmd") if isinstance(memory_cfg.get("qmd"), dict) else {}
raw_qmd_paths = qmd_cfg.get("paths") if isinstance(qmd_cfg.get("paths"), list) else []

for raw in raw_qmd_paths:
    if not isinstance(raw, dict):
        continue
    path_value = raw.get("path")
    if not isinstance(path_value, str) or not path_value.strip():
        continue
    expanded = os.path.expanduser(path_value.strip())
    resolved = os.path.abspath(expanded if os.path.isabs(expanded) else os.path.join(workspace, expanded))
    item = {"path": resolved}
    name = str(raw.get("name") or "").strip()
    pattern = str(raw.get("pattern") or "").strip()
    if name:
        item["name"] = name
    if pattern:
        item["pattern"] = pattern
    qmd_paths.append(item)

print("DERIVED_MAIN_WORKSPACE=" + q(workspace))
print("DERIVED_WORKSPACE_PATHS_JSON=" + q(json.dumps(workspaces, separators=(",", ":"))))
print("DERIVED_QMD_PATHS_JSON=" + q(json.dumps(qmd_paths, separators=(",", ":"))))
PY
  )" || return 1
  eval "$resolved"
}

resolve_backup_scope() {
  derive_backup_scope_from_openclaw || true

  local resolved
  resolved="$(
    python3 - \
      "${WORKSPACE_PATH:-}" \
      "${WORKSPACE_PATHS_JSON:-}" \
      "${QMD_PATHS_JSON:-}" \
      "${DERIVED_MAIN_WORKSPACE:-}" \
      "${DERIVED_WORKSPACE_PATHS_JSON:-[]}" \
      "${DERIVED_QMD_PATHS_JSON:-[]}" <<'PY'
import json
import os
import shlex
import sys

primary = sys.argv[1]
raw_workspace_paths = sys.argv[2]
raw_qmd_paths = sys.argv[3]
derived_main = sys.argv[4]
derived_workspaces = sys.argv[5]
derived_qmd_paths = sys.argv[6]

def q(value: str) -> str:
    return shlex.quote(value)

def norm(value: str) -> str:
    p = os.path.expanduser((value or "").strip())
    if not p:
        return ""
    return os.path.abspath(p)

def parse_json(value: str, fallback):
    if not isinstance(value, str) or not value.strip():
        return fallback
    try:
        parsed = json.loads(value)
        return parsed
    except Exception:
        return fallback

primary_path = norm(primary) or norm(derived_main)
workspace_paths = []

def add_workspace(value):
    path = ""
    if isinstance(value, str):
        path = norm(value)
    elif isinstance(value, dict):
        path = norm(str(value.get("path") or ""))
    if path and path not in workspace_paths:
        workspace_paths.append(path)

if primary_path:
    add_workspace(primary_path)

for raw in parse_json(raw_workspace_paths, []):
    add_workspace(raw)

for raw in parse_json(derived_workspaces, []):
    add_workspace(raw)

if not primary_path and workspace_paths:
    primary_path = workspace_paths[0]

if primary_path and primary_path not in workspace_paths:
    workspace_paths.insert(0, primary_path)

qmd_paths = []
seen_qmd = set()

def add_qmd_entry(raw):
    if isinstance(raw, str):
        candidate = {"path": raw}
    elif isinstance(raw, dict):
        candidate = dict(raw)
    else:
        return
    raw_path = str(candidate.get("path") or "").strip()
    if not raw_path:
        return
    expanded = os.path.expanduser(raw_path)
    if os.path.isabs(expanded):
        resolved_path = os.path.abspath(expanded)
    elif primary_path:
        resolved_path = os.path.abspath(os.path.join(primary_path, expanded))
    else:
        resolved_path = os.path.abspath(expanded)

    name = str(candidate.get("name") or "").strip()
    pattern = str(candidate.get("pattern") or "").strip()
    dedupe = (resolved_path, name, pattern)
    if dedupe in seen_qmd:
        return
    seen_qmd.add(dedupe)

    item = {"path": resolved_path}
    if name:
        item["name"] = name
    if pattern:
        item["pattern"] = pattern
    qmd_paths.append(item)

for raw in parse_json(raw_qmd_paths, []):
    add_qmd_entry(raw)
for raw in parse_json(derived_qmd_paths, []):
    add_qmd_entry(raw)

print("WORKSPACE_PATH=" + q(primary_path))
print("WORKSPACE_PATHS_JSON=" + q(json.dumps(workspace_paths, separators=(",", ":"))))
print("QMD_PATHS_JSON=" + q(json.dumps(qmd_paths, separators=(",", ":"))))
PY
  )" || die "Failed to resolve backup scope from OpenClaw config."

  eval "$resolved"
}

json_array_paths_to_lines() {
  local raw_json="${1:-[]}"
  python3 - "$raw_json" <<'PY'
import json
import sys

raw = sys.argv[1]
try:
    data = json.loads(raw) if raw.strip() else []
except Exception:
    data = []
if not isinstance(data, list):
    data = []

for item in data:
    if isinstance(item, str) and item.strip():
        print(item.strip())
    elif isinstance(item, dict):
        path = str(item.get("path") or "").strip()
        if path:
            print(path)
PY
}

qmd_paths_to_tsv() {
  local raw_json="${1:-[]}"
  python3 - "$raw_json" <<'PY'
import json
import sys

raw = sys.argv[1]
try:
    data = json.loads(raw) if raw.strip() else []
except Exception:
    data = []
if not isinstance(data, list):
    data = []

for item in data:
    if not isinstance(item, dict):
        continue
    path = str(item.get("path") or "").strip()
    if not path:
        continue
    name = str(item.get("name") or "").strip()
    pattern = str(item.get("pattern") or "").strip()
    print(f"{path}\t{name}\t{pattern}")
PY
}

path_slug() {
  local value="$1"
  python3 - "$value" <<'PY'
import hashlib
import re
import sys

raw = (sys.argv[1] or "").strip()
base = re.sub(r"[^a-zA-Z0-9._-]+", "-", raw).strip("-").lower()
if not base:
    base = "path"
if len(base) > 40:
    base = base[:40]
digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
print(f"{base}-{digest}")
PY
}

copy_curated_workspace() {
  local source_workspace="$1"
  local target_root="$2"
  local p

  for p in "${RSYNC_WORKSPACE[@]}"; do
    if [[ -e "$source_workspace/$p" ]]; then
      rsync -a --prune-empty-dirs \
        --exclude ".DS_Store" \
        "$source_workspace/$p" \
        "$target_root/" \
        >/dev/null
    fi
  done
}

clawboard_api_reachable() {
  local api_base="$1"
  [[ -n "${api_base:-}" ]] || return 1
  python3 - "$api_base" <<'PY'
import sys
import urllib.error
import urllib.request

base = (sys.argv[1] or "").strip().rstrip("/")
if not base:
    sys.exit(1)

targets = ("/api/config", "/api/health", "/health")
for target in targets:
    url = base + target
    req = urllib.request.Request(url, method="GET")
    try:
      with urllib.request.urlopen(req, timeout=3) as resp:
          code = getattr(resp, "status", 200)
          if 200 <= int(code) < 500:
              print(base, end="")
              sys.exit(0)
    except urllib.error.HTTPError as exc:
      if 200 <= int(getattr(exc, "code", 500)) < 500:
          print(base, end="")
          sys.exit(0)
    except Exception:
      pass

sys.exit(1)
PY
}

preserve_existing_clawboard_snapshot() {
  if [[ -d "$BACKUP_DIR/clawboard" ]]; then
    mkdir -p "$STAGE_DIR/clawboard"
    rsync -a --delete "$BACKUP_DIR/clawboard/" "$STAGE_DIR/clawboard/" >/dev/null
    say "WARN: Preserved prior clawboard snapshot from backup repo for this run."
  fi
}

first_reachable_clawboard_api() {
  local -a candidates=()
  local candidate seen existing

  add_candidate() {
    candidate="${1:-}"
    [[ -n "$candidate" ]] || return 0
    candidate="${candidate%/}"
    [[ -n "$candidate" ]] || return 0
    seen=0
    if [[ "${#candidates[@]}" -gt 0 ]]; then
      for existing in "${candidates[@]}"; do
        if [[ "$existing" == "$candidate" ]]; then
          seen=1
          break
        fi
      done
    fi
    if [[ "$seen" -eq 0 ]]; then
      candidates+=("$candidate")
    fi
  }

  add_candidate "${CLAWBOARD_API_URL:-}"
  add_candidate "${CLAWBOARD_API_URL_FROM_CONFIG:-}"
  add_candidate "http://127.0.0.1:8010"
  add_candidate "http://localhost:8010"

  for candidate in "${candidates[@]}"; do
    if clawboard_api_reachable "$candidate" >/dev/null 2>&1; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

apply_arg_overrides() {
  [[ -n "$ARG_WORKSPACE_PATH" ]] && WORKSPACE_PATH="$ARG_WORKSPACE_PATH"
  [[ -n "$ARG_WORKSPACE_PATHS_JSON" ]] && WORKSPACE_PATHS_JSON="$ARG_WORKSPACE_PATHS_JSON"
  [[ -n "$ARG_BACKUP_DIR" ]] && BACKUP_DIR="$ARG_BACKUP_DIR"
  [[ -n "$ARG_REPO_URL" ]] && REPO_URL="$ARG_REPO_URL"
  [[ -n "$ARG_REPO_SSH_URL" ]] && REPO_SSH_URL="$ARG_REPO_SSH_URL"
  [[ -n "$ARG_AUTH_METHOD" ]] && AUTH_METHOD="$ARG_AUTH_METHOD"
  [[ -n "$ARG_DEPLOY_KEY_PATH" ]] && DEPLOY_KEY_PATH="$ARG_DEPLOY_KEY_PATH"
  [[ -n "$ARG_GITHUB_USER" ]] && GITHUB_USER="$ARG_GITHUB_USER"
  [[ -n "$ARG_GITHUB_PAT" ]] && GITHUB_PAT="$ARG_GITHUB_PAT"
  [[ -n "$ARG_REMOTE_NAME" ]] && REMOTE_NAME="$ARG_REMOTE_NAME"
  [[ -n "$ARG_BRANCH" ]] && BRANCH="$ARG_BRANCH"
  [[ -n "$ARG_INCLUDE_OPENCLAW_CONFIG" ]] && INCLUDE_OPENCLAW_CONFIG="$ARG_INCLUDE_OPENCLAW_CONFIG"
  [[ -n "$ARG_INCLUDE_OPENCLAW_SKILLS" ]] && INCLUDE_OPENCLAW_SKILLS="$ARG_INCLUDE_OPENCLAW_SKILLS"
  [[ -n "$ARG_INCLUDE_CLAWBOARD_STATE" ]] && INCLUDE_CLAWBOARD_STATE="$ARG_INCLUDE_CLAWBOARD_STATE"
  [[ -n "$ARG_CLAWBOARD_DIR" ]] && CLAWBOARD_DIR="$ARG_CLAWBOARD_DIR"
  [[ -n "$ARG_CLAWBOARD_API_URL" ]] && CLAWBOARD_API_URL="$ARG_CLAWBOARD_API_URL"
  [[ -n "$ARG_INCLUDE_CLAWBOARD_ATTACHMENTS" ]] && INCLUDE_CLAWBOARD_ATTACHMENTS="$ARG_INCLUDE_CLAWBOARD_ATTACHMENTS"
  [[ -n "$ARG_INCLUDE_CLAWBOARD_ENV" ]] && INCLUDE_CLAWBOARD_ENV="$ARG_INCLUDE_CLAWBOARD_ENV"
  [[ -n "$ARG_CLAWBOARD_TOKEN" ]] && CLAWBOARD_TOKEN="$ARG_CLAWBOARD_TOKEN"
  [[ -n "$ARG_CLAWBOARD_ATTACHMENTS_DIR" ]] && CLAWBOARD_ATTACHMENTS_DIR="$ARG_CLAWBOARD_ATTACHMENTS_DIR"
  [[ -n "$ARG_SWEEP_ORPHAN_ATTACHMENTS" ]] && SWEEP_ORPHAN_ATTACHMENTS="$ARG_SWEEP_ORPHAN_ATTACHMENTS"
  [[ -n "$ARG_ORPHAN_ATTACHMENT_MAX_AGE_DAYS" ]] && ORPHAN_ATTACHMENT_MAX_AGE_DAYS="$ARG_ORPHAN_ATTACHMENT_MAX_AGE_DAYS"
  [[ -n "$ARG_ORPHAN_ATTACHMENT_SWEEP_MODE" ]] && ORPHAN_ATTACHMENT_SWEEP_MODE="$ARG_ORPHAN_ATTACHMENT_SWEEP_MODE"
  return 0
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --interactive)
        INTERACTIVE=1
        ;;
      --verbose)
        VERBOSE=1
        ;;
      --no-push)
        NO_PUSH=1
        ;;
      --credentials-json=*)
        CRED_JSON="${1#*=}"
        ;;
      --credentials-json)
        shift
        CRED_JSON="$(read_flag_value --credentials-json "${1:-}")"
        ;;
      --credentials-env=*)
        CRED_ENV="${1#*=}"
        ;;
      --credentials-env)
        shift
        CRED_ENV="$(read_flag_value --credentials-env "${1:-}")"
        ;;
      --workspace-path=*)
        ARG_WORKSPACE_PATH="${1#*=}"
        ;;
      --workspace-path)
        shift
        ARG_WORKSPACE_PATH="$(read_flag_value --workspace-path "${1:-}")"
        ;;
      --workspace-paths-json=*)
        ARG_WORKSPACE_PATHS_JSON="${1#*=}"
        ;;
      --workspace-paths-json)
        shift
        ARG_WORKSPACE_PATHS_JSON="$(read_flag_value --workspace-paths-json "${1:-}")"
        ;;
      --backup-dir=*)
        ARG_BACKUP_DIR="${1#*=}"
        ;;
      --backup-dir)
        shift
        ARG_BACKUP_DIR="$(read_flag_value --backup-dir "${1:-}")"
        ;;
      --repo-url=*)
        ARG_REPO_URL="${1#*=}"
        ;;
      --repo-url)
        shift
        ARG_REPO_URL="$(read_flag_value --repo-url "${1:-}")"
        ;;
      --repo-ssh-url=*)
        ARG_REPO_SSH_URL="${1#*=}"
        ;;
      --repo-ssh-url)
        shift
        ARG_REPO_SSH_URL="$(read_flag_value --repo-ssh-url "${1:-}")"
        ;;
      --auth-method=*)
        ARG_AUTH_METHOD="${1#*=}"
        ;;
      --auth-method)
        shift
        ARG_AUTH_METHOD="$(read_flag_value --auth-method "${1:-}")"
        ;;
      --deploy-key-path=*)
        ARG_DEPLOY_KEY_PATH="${1#*=}"
        ;;
      --deploy-key-path)
        shift
        ARG_DEPLOY_KEY_PATH="$(read_flag_value --deploy-key-path "${1:-}")"
        ;;
      --github-user=*)
        ARG_GITHUB_USER="${1#*=}"
        ;;
      --github-user)
        shift
        ARG_GITHUB_USER="$(read_flag_value --github-user "${1:-}")"
        ;;
      --github-pat=*)
        ARG_GITHUB_PAT="${1#*=}"
        ;;
      --github-pat)
        shift
        ARG_GITHUB_PAT="$(read_flag_value --github-pat "${1:-}")"
        ;;
      --remote-name=*)
        ARG_REMOTE_NAME="${1#*=}"
        ;;
      --remote-name)
        shift
        ARG_REMOTE_NAME="$(read_flag_value --remote-name "${1:-}")"
        ;;
      --branch=*)
        ARG_BRANCH="${1#*=}"
        ;;
      --branch)
        shift
        ARG_BRANCH="$(read_flag_value --branch "${1:-}")"
        ;;
      --clawboard-dir=*)
        ARG_CLAWBOARD_DIR="${1#*=}"
        ;;
      --clawboard-dir)
        shift
        ARG_CLAWBOARD_DIR="$(read_flag_value --clawboard-dir "${1:-}")"
        ;;
      --clawboard-api-url=*)
        ARG_CLAWBOARD_API_URL="${1#*=}"
        ;;
      --clawboard-api-url)
        shift
        ARG_CLAWBOARD_API_URL="$(read_flag_value --clawboard-api-url "${1:-}")"
        ;;
      --clawboard-token=*)
        ARG_CLAWBOARD_TOKEN="${1#*=}"
        ;;
      --clawboard-token)
        shift
        ARG_CLAWBOARD_TOKEN="$(read_flag_value --clawboard-token "${1:-}")"
        ;;
      --clawboard-attachments-dir=*)
        ARG_CLAWBOARD_ATTACHMENTS_DIR="${1#*=}"
        ;;
      --clawboard-attachments-dir)
        shift
        ARG_CLAWBOARD_ATTACHMENTS_DIR="$(read_flag_value --clawboard-attachments-dir "${1:-}")"
        ;;
      --orphan-max-age-days=*)
        ARG_ORPHAN_ATTACHMENT_MAX_AGE_DAYS="${1#*=}"
        ;;
      --orphan-max-age-days)
        shift
        ARG_ORPHAN_ATTACHMENT_MAX_AGE_DAYS="$(read_flag_value --orphan-max-age-days "${1:-}")"
        ;;
      --orphan-sweep-mode=*)
        ARG_ORPHAN_ATTACHMENT_SWEEP_MODE="${1#*=}"
        ;;
      --orphan-sweep-mode)
        shift
        ARG_ORPHAN_ATTACHMENT_SWEEP_MODE="$(read_flag_value --orphan-sweep-mode "${1:-}")"
        ;;
      --include-openclaw-config)
        ARG_INCLUDE_OPENCLAW_CONFIG="true"
        ;;
      --exclude-openclaw-config|--no-include-openclaw-config)
        ARG_INCLUDE_OPENCLAW_CONFIG="false"
        ;;
      --include-openclaw-skills)
        ARG_INCLUDE_OPENCLAW_SKILLS="true"
        ;;
      --exclude-openclaw-skills|--no-include-openclaw-skills)
        ARG_INCLUDE_OPENCLAW_SKILLS="false"
        ;;
      --include-clawboard-state)
        ARG_INCLUDE_CLAWBOARD_STATE="true"
        ;;
      --exclude-clawboard-state|--no-include-clawboard-state)
        ARG_INCLUDE_CLAWBOARD_STATE="false"
        ;;
      --include-clawboard-attachments)
        ARG_INCLUDE_CLAWBOARD_ATTACHMENTS="true"
        ;;
      --exclude-clawboard-attachments|--no-include-clawboard-attachments)
        ARG_INCLUDE_CLAWBOARD_ATTACHMENTS="false"
        ;;
      --include-clawboard-env)
        ARG_INCLUDE_CLAWBOARD_ENV="true"
        ;;
      --exclude-clawboard-env|--no-include-clawboard-env)
        ARG_INCLUDE_CLAWBOARD_ENV="false"
        ;;
      --sweep-orphan-attachments)
        ARG_SWEEP_ORPHAN_ATTACHMENTS="true"
        ;;
      --no-sweep-orphan-attachments)
        ARG_SWEEP_ORPHAN_ATTACHMENTS="false"
        ;;
      *)
        die "Unknown argument: $1 (use --help)"
        ;;
    esac
    shift
  done
}

sweep_orphan_attachments_in_backup() {
  local backup_root="$1"
  local attachments_dir="$2"
  local attachments_manifest="$3"
  local report_path="$4"
  local max_age_days="$5"
  local sweep_mode="$6"
  local summary=""
  local tracked="0"
  local total_files="0"
  local orphaned="0"
  local eligible="0"
  local deleted="0"
  local status="ok"

  case "$attachments_dir" in
    "$backup_root"/*) ;;
    *)
      die "Refusing orphan sweep outside backup dir: $attachments_dir"
      ;;
  esac

  summary="$(
    python3 - "$attachments_dir" "$attachments_manifest" "$report_path" "$max_age_days" "$sweep_mode" <<'PY'
import json
import pathlib
import sys
import time
from datetime import datetime, timezone

attachments_dir = pathlib.Path(sys.argv[1])
attachments_manifest = pathlib.Path(sys.argv[2])
report_path = pathlib.Path(sys.argv[3])
max_age_days = int(sys.argv[4])
sweep_mode = (sys.argv[5] or "prune").strip().lower()
if sweep_mode not in {"report", "prune"}:
    sweep_mode = "prune"
cutoff_ts = time.time() - (max_age_days * 86400)
now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

tracked_ids = set()
status = "ok"

raw = []
if attachments_manifest.exists():
    try:
        raw = json.loads(attachments_manifest.read_text(encoding="utf-8"))
    except Exception:
        status = "manifest-parse-error"
else:
    status = "missing-manifest"

if isinstance(raw, list):
    for row in raw:
        if isinstance(row, dict):
            item_id = str(row.get("id") or "").strip()
            if item_id:
                tracked_ids.add(item_id)

orphaned = 0
deleted = 0
eligible = 0
total_files = 0
sample_orphans = []

if attachments_dir.exists() and attachments_dir.is_dir():
    candidates = sorted([p for p in attachments_dir.iterdir() if p.is_file()], key=lambda p: p.name)
else:
    candidates = []
    if status == "ok":
        status = "missing-attachments-dir"
    else:
        status = f"{status}+missing-attachments-dir"

for candidate in candidates:
    total_files += 1
    if candidate.name in tracked_ids:
        continue
    orphaned += 1
    mtime = None
    age_days = None
    try:
        st = candidate.stat()
        mtime = st.st_mtime
        age_days = round((time.time() - mtime) / 86400, 2)
    except FileNotFoundError:
        continue

    is_eligible = mtime is not None and mtime <= cutoff_ts
    if is_eligible:
        eligible += 1
    if len(sample_orphans) < 50:
        sample_orphans.append(
            {
                "id": candidate.name,
                "ageDays": age_days,
                "eligibleForPrune": bool(is_eligible),
            }
        )

    if sweep_mode == "prune" and is_eligible:
        try:
            candidate.unlink()
            deleted += 1
        except FileNotFoundError:
            pass

report_payload = {
    "generatedAt": now_iso,
    "mode": sweep_mode,
    "maxAgeDays": max_age_days,
    "status": status,
    "counts": {
        "tracked": len(tracked_ids),
        "files": total_files,
        "orphaned": orphaned,
        "eligibleForPrune": eligible,
        "deleted": deleted,
        "keptOrphans": orphaned - deleted,
    },
    "sampleOrphans": sample_orphans,
    "notes": [
        "This report is generated from backup snapshot files.",
        "Source attachment files are never deleted by this backup script.",
    ],
}
report_path.parent.mkdir(parents=True, exist_ok=True)
report_path.write_text(json.dumps(report_payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

print(f"{len(tracked_ids)}|{total_files}|{orphaned}|{eligible}|{deleted}|{status}")
PY
  )"
  IFS='|' read -r tracked total_files orphaned eligible deleted status <<<"$summary"
  if [[ "$VERBOSE" == "1" || "${orphaned:-0}" != "0" || "${deleted:-0}" != "0" ]]; then
    say "Orphan attachment sweep: status=$status mode=$sweep_mode tracked=$tracked files=$total_files orphaned=$orphaned eligible=$eligible deleted=$deleted (older than ${max_age_days}d; source attachments untouched)"
    say "Orphan attachment report: $report_path"
  fi
}

parse_args "$@"

# --- Load config ---
if [[ -f "$CRED_JSON" ]]; then
  WORKSPACE_PATH="$(json_get "$CRED_JSON" '.workspacePath')"
  WORKSPACE_PATHS_JSON="$(json_get "$CRED_JSON" '.workspacePaths')"
  QMD_PATHS_JSON="$(json_get "$CRED_JSON" '.qmdPaths')"
  BACKUP_DIR="$(json_get "$CRED_JSON" '.backupDir')"
  REPO_URL="$(json_get "$CRED_JSON" '.repoUrl')"
  REPO_SSH_URL="$(json_get "$CRED_JSON" '.repoSshUrl')"
  AUTH_METHOD="$(json_get "$CRED_JSON" '.authMethod')"
  DEPLOY_KEY_PATH="$(json_get "$CRED_JSON" '.deployKeyPath')"
  GITHUB_USER="$(json_get "$CRED_JSON" '.githubUser')"
  GITHUB_PAT="$(json_get "$CRED_JSON" '.githubPat')"
  REMOTE_NAME="$(json_get "$CRED_JSON" '.remoteName')"
  BRANCH="$(json_get "$CRED_JSON" '.branch')"
  INCLUDE_OPENCLAW_CONFIG="$(json_get "$CRED_JSON" '.includeOpenclawConfig')"
  INCLUDE_OPENCLAW_SKILLS="$(json_get "$CRED_JSON" '.includeOpenclawSkills')"
  INCLUDE_CLAWBOARD_STATE="$(json_get "$CRED_JSON" '.includeClawboardState')"
  CLAWBOARD_DIR="$(json_get "$CRED_JSON" '.clawboardDir')"
  CLAWBOARD_API_URL="$(json_get "$CRED_JSON" '.clawboardApiUrl')"
  INCLUDE_CLAWBOARD_ATTACHMENTS="$(json_get "$CRED_JSON" '.includeClawboardAttachments')"
  INCLUDE_CLAWBOARD_ENV="$(json_get "$CRED_JSON" '.includeClawboardEnv')"
  CLAWBOARD_TOKEN="$(json_get "$CRED_JSON" '.clawboardToken')"
  CLAWBOARD_ATTACHMENTS_DIR="$(json_get "$CRED_JSON" '.clawboardAttachmentsDir')"
  SWEEP_ORPHAN_ATTACHMENTS="$(json_get "$CRED_JSON" '.sweepOrphanAttachments')"
  ORPHAN_ATTACHMENT_MAX_AGE_DAYS="$(json_get "$CRED_JSON" '.orphanAttachmentMaxAgeDays')"
  ORPHAN_ATTACHMENT_SWEEP_MODE="$(json_get "$CRED_JSON" '.orphanAttachmentSweepMode')"
else
  load_env_file "$CRED_ENV"
  WORKSPACE_PATH="${WORKSPACE_PATH:-}"
  WORKSPACE_PATHS_JSON="${WORKSPACE_PATHS_JSON:-}"
  QMD_PATHS_JSON="${QMD_PATHS_JSON:-}"
  BACKUP_DIR="${BACKUP_DIR:-}"
  REPO_URL="${REPO_URL:-}"
  REPO_SSH_URL="${REPO_SSH_URL:-}"
  AUTH_METHOD="${AUTH_METHOD:-}"
  DEPLOY_KEY_PATH="${DEPLOY_KEY_PATH:-}"
  GITHUB_USER="${GITHUB_USER:-}"
  GITHUB_PAT="${GITHUB_PAT:-}"
  REMOTE_NAME="${REMOTE_NAME:-}"
  BRANCH="${BRANCH:-}"
  INCLUDE_OPENCLAW_CONFIG="${INCLUDE_OPENCLAW_CONFIG:-}"
  INCLUDE_OPENCLAW_SKILLS="${INCLUDE_OPENCLAW_SKILLS:-}"
  INCLUDE_CLAWBOARD_STATE="${INCLUDE_CLAWBOARD_STATE:-}"
  CLAWBOARD_DIR="${CLAWBOARD_DIR:-}"
  CLAWBOARD_API_URL="${CLAWBOARD_API_URL:-}"
  INCLUDE_CLAWBOARD_ATTACHMENTS="${INCLUDE_CLAWBOARD_ATTACHMENTS:-}"
  INCLUDE_CLAWBOARD_ENV="${INCLUDE_CLAWBOARD_ENV:-}"
  CLAWBOARD_TOKEN="${CLAWBOARD_BACKUP_TOKEN:-${CLAWBOARD_TOKEN:-}}"
  CLAWBOARD_ATTACHMENTS_DIR="${CLAWBOARD_ATTACHMENTS_DIR:-}"
  SWEEP_ORPHAN_ATTACHMENTS="${SWEEP_ORPHAN_ATTACHMENTS:-}"
  ORPHAN_ATTACHMENT_MAX_AGE_DAYS="${ORPHAN_ATTACHMENT_MAX_AGE_DAYS:-}"
  ORPHAN_ATTACHMENT_SWEEP_MODE="${ORPHAN_ATTACHMENT_SWEEP_MODE:-}"
fi

# Env file values override JSON for secrets/runtime configuration.
CLAWBOARD_API_URL_FROM_CONFIG="${CLAWBOARD_API_URL:-}"
load_env_file "$CRED_ENV"
CLAWBOARD_TOKEN="${CLAWBOARD_BACKUP_TOKEN:-${CLAWBOARD_TOKEN:-}}"
CLAWBOARD_API_URL="${CLAWBOARD_BACKUP_API_URL:-${CLAWBOARD_API_URL:-}}"
CLAWBOARD_DIR="${CLAWBOARD_BACKUP_DIR:-${CLAWBOARD_DIR:-}}"
WORKSPACE_PATHS_JSON="${OPENCLAW_BACKUP_WORKSPACE_PATHS_JSON:-${WORKSPACE_PATHS_JSON:-}}"
QMD_PATHS_JSON="${OPENCLAW_BACKUP_QMD_PATHS_JSON:-${QMD_PATHS_JSON:-}}"
CLAWBOARD_ATTACHMENTS_DIR="${CLAWBOARD_BACKUP_ATTACHMENTS_DIR:-${CLAWBOARD_ATTACHMENTS_DIR:-}}"
SWEEP_ORPHAN_ATTACHMENTS="${CLAWBOARD_BACKUP_SWEEP_ORPHAN_ATTACHMENTS:-${SWEEP_ORPHAN_ATTACHMENTS:-}}"
ORPHAN_ATTACHMENT_MAX_AGE_DAYS="${CLAWBOARD_BACKUP_ORPHAN_ATTACHMENT_MAX_AGE_DAYS:-${ORPHAN_ATTACHMENT_MAX_AGE_DAYS:-}}"
ORPHAN_ATTACHMENT_SWEEP_MODE="${CLAWBOARD_BACKUP_ORPHAN_SWEEP_MODE:-${ORPHAN_ATTACHMENT_SWEEP_MODE:-}}"

apply_arg_overrides
resolve_backup_scope

REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH="${BRANCH:-main}"
AUTH_METHOD="${AUTH_METHOD:-ssh}"
CLAWBOARD_API_URL="${CLAWBOARD_API_URL:-http://localhost:8010}"
SWEEP_ORPHAN_ATTACHMENTS="${SWEEP_ORPHAN_ATTACHMENTS:-true}"
ORPHAN_ATTACHMENT_MAX_AGE_DAYS="${ORPHAN_ATTACHMENT_MAX_AGE_DAYS:-14}"
ORPHAN_ATTACHMENT_SWEEP_MODE="${ORPHAN_ATTACHMENT_SWEEP_MODE:-prune}"

if [[ "$INTERACTIVE" == "1" ]]; then
  [[ -t 0 ]] || die "--interactive requires a TTY"
  say "Interactive mode enabled. Press Enter to keep the shown value."

  WORKSPACE_PATH="$(prompt_value "workspacePath" "${WORKSPACE_PATH:-}")"
  BACKUP_DIR="$(prompt_value "backupDir" "${BACKUP_DIR:-}")"
  AUTH_METHOD="$(prompt_value "authMethod (ssh|pat)" "${AUTH_METHOD:-ssh}")"
  REMOTE_NAME="$(prompt_value "remoteName" "${REMOTE_NAME:-origin}")"
  BRANCH="$(prompt_value "branch" "${BRANCH:-main}")"

  case "$(lc "$AUTH_METHOD")" in
    ssh)
      REPO_SSH_URL="$(prompt_value "repoSshUrl" "${REPO_SSH_URL:-}")"
      DEPLOY_KEY_PATH="$(prompt_value "deployKeyPath" "${DEPLOY_KEY_PATH:-}")"
      ;;
    pat)
      REPO_URL="$(prompt_value "repoUrl" "${REPO_URL:-}")"
      GITHUB_USER="$(prompt_value "githubUser" "${GITHUB_USER:-}")"
      GITHUB_PAT="$(prompt_value "githubPat" "${GITHUB_PAT:-}" 1)"
      ;;
    *)
      die "Unknown authMethod: ${AUTH_METHOD}. Expected 'ssh' or 'pat'."
      ;;
  esac

  INCLUDE_OPENCLAW_CONFIG="$(prompt_bool "Include OpenClaw config backups?" "${INCLUDE_OPENCLAW_CONFIG:-false}")"
  INCLUDE_OPENCLAW_SKILLS="$(prompt_bool "Include OpenClaw skills backups?" "${INCLUDE_OPENCLAW_SKILLS:-false}")"
  INCLUDE_CLAWBOARD_STATE="$(prompt_bool "Include Clawboard state export?" "${INCLUDE_CLAWBOARD_STATE:-false}")"

  if as_bool "${INCLUDE_CLAWBOARD_STATE:-}"; then
    CLAWBOARD_API_URL="$(prompt_value "clawboardApiUrl" "${CLAWBOARD_API_URL:-http://localhost:8010}")"
    CLAWBOARD_DIR="$(prompt_value "clawboardDir (optional)" "${CLAWBOARD_DIR:-}")"
    CLAWBOARD_TOKEN="$(prompt_value "clawboardToken" "${CLAWBOARD_TOKEN:-}" 1)"
    INCLUDE_CLAWBOARD_ATTACHMENTS="$(prompt_bool "Include Clawboard attachments dir?" "${INCLUDE_CLAWBOARD_ATTACHMENTS:-true}")"
    INCLUDE_CLAWBOARD_ENV="$(prompt_bool "Include Clawboard .env in backup?" "${INCLUDE_CLAWBOARD_ENV:-false}")"
    if as_bool "${INCLUDE_CLAWBOARD_ATTACHMENTS:-}"; then
      CLAWBOARD_ATTACHMENTS_DIR="$(prompt_value "clawboardAttachmentsDir override (optional)" "${CLAWBOARD_ATTACHMENTS_DIR:-}")"
      SWEEP_ORPHAN_ATTACHMENTS="$(prompt_bool "Sweep orphaned backup attachments?" "${SWEEP_ORPHAN_ATTACHMENTS:-true}")"
      if as_bool "${SWEEP_ORPHAN_ATTACHMENTS:-}"; then
        ORPHAN_ATTACHMENT_MAX_AGE_DAYS="$(prompt_value "orphan attachment max age days" "${ORPHAN_ATTACHMENT_MAX_AGE_DAYS:-14}")"
        ORPHAN_ATTACHMENT_SWEEP_MODE="$(prompt_value "orphan sweep mode (report|prune)" "${ORPHAN_ATTACHMENT_SWEEP_MODE:-prune}")"
      fi
    fi
  fi

  proceed="$(prompt_bool "Proceed with backup run now?" "true")"
  if ! as_bool "$proceed"; then
    say "Canceled."
    exit 0
  fi
fi

[[ -n "${WORKSPACE_PATH:-}" ]] || die "workspacePath not configured. Run setup-openclaw-memory-backup.sh first."
if [[ ! -d "$WORKSPACE_PATH" ]]; then
  fallback_workspace=""
  while IFS= read -r candidate_workspace; do
    [[ -n "$candidate_workspace" ]] || continue
    if [[ -d "$candidate_workspace" ]]; then
      fallback_workspace="$candidate_workspace"
      break
    fi
  done < <(json_array_paths_to_lines "${WORKSPACE_PATHS_JSON:-[]}")

  if [[ -n "$fallback_workspace" ]]; then
    say "WARN: workspacePath does not exist: $WORKSPACE_PATH (using $fallback_workspace)"
    WORKSPACE_PATH="$fallback_workspace"
  else
    die "workspacePath does not exist: $WORKSPACE_PATH"
  fi
fi

[[ -n "${BACKUP_DIR:-}" ]] || die "backupDir not configured. Run setup-openclaw-memory-backup.sh first."

case "$(lc "${AUTH_METHOD:-}")" in
  ssh)
    [[ -n "${REPO_SSH_URL:-}" ]] || die "repoSshUrl not configured (needed for authMethod=ssh). Re-run setup."
    [[ -n "${DEPLOY_KEY_PATH:-}" ]] || die "deployKeyPath not configured (needed for authMethod=ssh). Re-run setup."
    [[ -f "$DEPLOY_KEY_PATH" ]] || die "deploy key not found: $DEPLOY_KEY_PATH"
    ;;
  pat)
    [[ -n "${REPO_URL:-}" ]] || die "repoUrl not configured (needed for authMethod=pat). Re-run setup."
    [[ -n "${GITHUB_USER:-}" ]] || die "githubUser not configured. Re-run setup."
    [[ -n "${GITHUB_PAT:-}" ]] || die "githubPat not configured. Re-run setup."
    ;;
  *)
    die "Unknown authMethod: ${AUTH_METHOD}. Expected 'ssh' or 'pat'."
    ;;
esac

if as_bool "${SWEEP_ORPHAN_ATTACHMENTS:-}"; then
  [[ "$ORPHAN_ATTACHMENT_MAX_AGE_DAYS" =~ ^[0-9]+$ ]] || die "orphan attachment max age must be a non-negative integer."
  case "$(lc "$ORPHAN_ATTACHMENT_SWEEP_MODE")" in
    report|prune) ;;
    *)
      die "orphan sweep mode must be 'report' or 'prune'."
      ;;
  esac
fi

need_cmd git
need_cmd rsync
need_cmd mktemp
need_cmd date
need_cmd python3

mkdir -p "$BACKUP_DIR"

# Avoid overlapping cron runs. If another backup is active, exit quietly.
LOCK_DIR="$BACKUP_DIR/.backup-lock"
if ! mkdir "$LOCK_DIR" >/dev/null 2>&1; then
  lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "${lock_pid:-}" ]] && kill -0 "$lock_pid" >/dev/null 2>&1; then
    exit 0
  fi
  rm -rf "$LOCK_DIR" >/dev/null 2>&1 || true
  mkdir "$LOCK_DIR" >/dev/null 2>&1 || exit 0
fi
printf "%s\n" "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

# Ensure backup repo exists
if [[ ! -d "$BACKUP_DIR/.git" ]]; then
  (cd "$BACKUP_DIR" && git init -b "$BRANCH" >/dev/null)
fi

# Ensure remote is set
REMOTE_URL=""
if [[ "$(lc "${AUTH_METHOD:-}")" == "ssh" ]]; then
  REMOTE_URL="$REPO_SSH_URL"
else
  REMOTE_URL="$REPO_URL"
fi

if ! (cd "$BACKUP_DIR" && git remote get-url "$REMOTE_NAME" >/dev/null 2>&1); then
  (cd "$BACKUP_DIR" && git remote add "$REMOTE_NAME" "$REMOTE_URL")
else
  (cd "$BACKUP_DIR" && git remote set-url "$REMOTE_NAME" "$REMOTE_URL")
fi

# Ensure commits can be created in clean environments without global git identity.
if [[ -z "$(git -C "$BACKUP_DIR" config --get user.name || true)" ]]; then
  git -C "$BACKUP_DIR" config user.name "Clawboard Backup Bot"
fi
if [[ -z "$(git -C "$BACKUP_DIR" config --get user.email || true)" ]]; then
  git -C "$BACKUP_DIR" config user.email "clawboard-backup@localhost"
fi

# Make a staging subdir so we can delete removed files cleanly without nuking .git
STAGE_DIR="$BACKUP_DIR/.stage"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# --- A) Curated workspace text (always) ---
# Note: do NOT use --delete when rsync'ing individual files into the same dest,
# or each call will delete what the previous call copied.
RSYNC_WORKSPACE=(
  "MEMORY.md"
  "USER.md"
  "SOUL.md"
  "AGENTS.md"
  "TOOLS.md"
  "IDENTITY.md"
  "HEARTBEAT.md"
  "memory"
)

# Primary workspace stays at backup root for backwards compatibility.
copy_curated_workspace "$WORKSPACE_PATH" "$STAGE_DIR"

# Derive a unique list of workspace paths for fallback + multi-agent memory.
WORKSPACE_PATH_LIST=("$WORKSPACE_PATH")
while IFS= read -r ws_path; do
  [[ -n "$ws_path" ]] || continue
  seen=0
  for existing_ws in "${WORKSPACE_PATH_LIST[@]}"; do
    if [[ "$existing_ws" == "$ws_path" ]]; then
      seen=1
      break
    fi
  done
  if [[ "$seen" -eq 0 ]]; then
    WORKSPACE_PATH_LIST+=("$ws_path")
  fi
done < <(json_array_paths_to_lines "${WORKSPACE_PATHS_JSON:-[]}")

has_primary_ws=0
for existing_ws in "${WORKSPACE_PATH_LIST[@]}"; do
  if [[ "$existing_ws" == "$WORKSPACE_PATH" ]]; then
    has_primary_ws=1
    break
  fi
done
if [[ "$has_primary_ws" -eq 0 ]]; then
  WORKSPACE_PATH_LIST=("$WORKSPACE_PATH" "${WORKSPACE_PATH_LIST[@]}")
fi

# Back up curated files from additional agent workspaces under agent-workspaces/<slug>/.
extra_workspace_count=0
for ws_path in "${WORKSPACE_PATH_LIST[@]}"; do
  [[ -n "$ws_path" ]] || continue
  [[ "$ws_path" == "$WORKSPACE_PATH" ]] && continue
  if [[ ! -d "$ws_path" ]]; then
    [[ "$VERBOSE" == "1" ]] && say "Skipping missing workspace from scope: $ws_path"
    continue
  fi

  ws_slug="$(path_slug "$ws_path")"
  ws_dest="$STAGE_DIR/agent-workspaces/$ws_slug"
  mkdir -p "$ws_dest"
  copy_curated_workspace "$ws_path" "$ws_dest"
  printf "%s\n" "$ws_path" > "$ws_dest/.workspace-path"
  extra_workspace_count=$((extra_workspace_count + 1))
done

# Back up explicit QMD memory paths (if configured) as markdown snapshots.
qmd_paths_count=0
while IFS=$'\t' read -r qmd_path qmd_name qmd_pattern; do
  [[ -n "$qmd_path" ]] || continue

  # Default workspace memory paths are already captured by curated workspace copies.
  skip_default_qmd_path=0
  for ws_path in "${WORKSPACE_PATH_LIST[@]}"; do
    if [[ "$qmd_path" == "$ws_path/memory" || "$qmd_path" == "$ws_path/MEMORY.md" ]]; then
      skip_default_qmd_path=1
      break
    fi
  done
  [[ "$skip_default_qmd_path" -eq 1 ]] && continue

  if [[ ! -e "$qmd_path" ]]; then
    [[ "$VERBOSE" == "1" ]] && say "Skipping missing qmd path from scope: $qmd_path"
    continue
  fi

  qmd_label="$qmd_path"
  [[ -n "$qmd_name" ]] && qmd_label="$qmd_name"
  qmd_slug="$(path_slug "$qmd_label")"
  qmd_dest="$STAGE_DIR/qmd-paths/$qmd_slug"
  mkdir -p "$qmd_dest"

  if [[ -f "$qmd_path" ]]; then
    rsync -a "$qmd_path" "$qmd_dest/" >/dev/null
  elif [[ -d "$qmd_path" ]]; then
    rsync -a --prune-empty-dirs \
      --exclude ".DS_Store" \
      --include "*/" \
      --include "*.md" \
      --exclude "*" \
      "$qmd_path/" \
      "$qmd_dest/" \
      >/dev/null
  fi

  {
    printf "path=%s\n" "$qmd_path"
    printf "name=%s\n" "$qmd_name"
    printf "pattern=%s\n" "$qmd_pattern"
  } > "$qmd_dest/.qmd-source"

  qmd_paths_count=$((qmd_paths_count + 1))
done < <(qmd_paths_to_tsv "${QMD_PATHS_JSON:-[]}")

if [[ "$VERBOSE" == "1" ]]; then
  say "Workspace scope: primary=$WORKSPACE_PATH, total=${#WORKSPACE_PATH_LIST[@]}, extra=$extra_workspace_count"
  if [[ "$qmd_paths_count" -gt 0 ]]; then
    say "Backed up explicit qmd paths: $qmd_paths_count"
  fi
fi

# --- B) Selected OpenClaw files (optional) ---
if as_bool "${INCLUDE_OPENCLAW_CONFIG:-}"; then
  mkdir -p "$STAGE_DIR/openclaw"
  if [[ -f "$OPENCLAW_DIR/openclaw.json" ]]; then
    rsync -a "$OPENCLAW_DIR/openclaw.json" "$STAGE_DIR/openclaw/" >/dev/null
  fi
  # include backups if present (small, useful)
  shopt -s nullglob
  for f in "$OPENCLAW_DIR"/openclaw.json.bak*; do
    rsync -a "$f" "$STAGE_DIR/openclaw/" >/dev/null
  done
  shopt -u nullglob
fi

if as_bool "${INCLUDE_OPENCLAW_SKILLS:-}"; then
  if [[ -d "$OPENCLAW_DIR/skills" ]]; then
    mkdir -p "$STAGE_DIR/openclaw"
    rsync -a --delete --prune-empty-dirs \
      --exclude ".DS_Store" \
      "$OPENCLAW_DIR/skills/" \
      "$STAGE_DIR/openclaw/skills/" \
      >/dev/null
  fi
fi

# --- C) Full Clawboard state backup (optional, best-effort) ---
CLAWBOARD_STATE_EXPORT_OK=0
if as_bool "${INCLUDE_CLAWBOARD_STATE:-}"; then
  SKIP_CLAWBOARD_EXPORT=0

  if [[ ! -f "$EXPORT_CLAWBOARD_HELPER" ]]; then
    say "WARN: Missing exporter helper: $EXPORT_CLAWBOARD_HELPER. Skipping Clawboard state export for this run."
    preserve_existing_clawboard_snapshot
    SKIP_CLAWBOARD_EXPORT=1
  fi

  if [[ "$SKIP_CLAWBOARD_EXPORT" -eq 0 ]]; then
    if [[ -n "${CLAWBOARD_DIR:-}" ]]; then
      # Expand "~" in a POSIX-safe way.
      case "$CLAWBOARD_DIR" in
        "~/"*) CLAWBOARD_DIR="$HOME/${CLAWBOARD_DIR#~/}" ;;
      esac
    fi

    if [[ -n "${CLAWBOARD_DIR:-}" && ! -d "$CLAWBOARD_DIR" ]]; then
      fallback_clawboard_dir=""
      for candidate in \
        "$WORKSPACE_PATH/projects/clawboard" \
        "$WORKSPACE_PATH/project/clawboard"
      do
        if [[ -f "$candidate/deploy.sh" && -f "$candidate/docker-compose.yaml" ]]; then
          fallback_clawboard_dir="$candidate"
          break
        fi
      done

      if [[ -z "$fallback_clawboard_dir" ]]; then
        for ws_path in "${WORKSPACE_PATH_LIST[@]}"; do
          for candidate in \
            "$ws_path/projects/clawboard" \
            "$ws_path/project/clawboard"
          do
            if [[ -f "$candidate/deploy.sh" && -f "$candidate/docker-compose.yaml" ]]; then
              fallback_clawboard_dir="$candidate"
              break
            fi
          done
          [[ -n "$fallback_clawboard_dir" ]] && break
        done
      fi

      if [[ -n "$fallback_clawboard_dir" ]]; then
        say "WARN: clawboardDir does not exist: $CLAWBOARD_DIR (using $fallback_clawboard_dir)"
        CLAWBOARD_DIR="$fallback_clawboard_dir"
      else
        say "WARN: clawboardDir does not exist: $CLAWBOARD_DIR. Will continue without path-based fallbacks."
        CLAWBOARD_DIR=""
      fi
    fi

    if [[ -z "${CLAWBOARD_TOKEN:-}" && -n "${CLAWBOARD_DIR:-}" && -f "$CLAWBOARD_DIR/.env" ]]; then
      CLAWBOARD_TOKEN="$(read_env_value "$CLAWBOARD_DIR/.env" "CLAWBOARD_TOKEN" || true)"
    fi
    if [[ -z "${CLAWBOARD_TOKEN:-}" ]]; then
      say "WARN: Clawboard token missing. Skipping Clawboard state export for this run."
      preserve_existing_clawboard_snapshot
      SKIP_CLAWBOARD_EXPORT=1
    fi
  fi

  if [[ "$SKIP_CLAWBOARD_EXPORT" -eq 0 ]]; then
    reachable_clawboard_api="$(first_reachable_clawboard_api || true)"
    if [[ -z "$reachable_clawboard_api" ]]; then
      say "WARN: Clawboard API unreachable at configured endpoints. Skipping Clawboard state export for this run."
      preserve_existing_clawboard_snapshot
      SKIP_CLAWBOARD_EXPORT=1
    else
      if [[ "$reachable_clawboard_api" != "${CLAWBOARD_API_URL:-}" ]]; then
        say "WARN: Clawboard API fallback selected: $reachable_clawboard_api"
      fi
      CLAWBOARD_API_URL="$reachable_clawboard_api"
    fi
  fi

  if [[ "$SKIP_CLAWBOARD_EXPORT" -eq 0 ]]; then
    CLAWBOARD_EXPORT_DIR="$STAGE_DIR/clawboard/export"
    mkdir -p "$CLAWBOARD_EXPORT_DIR"
    if python3 "$EXPORT_CLAWBOARD_HELPER" \
      --api-base "$CLAWBOARD_API_URL" \
      --token "$CLAWBOARD_TOKEN" \
      --out-dir "$CLAWBOARD_EXPORT_DIR" \
      --include-raw \
      >/dev/null; then
      CLAWBOARD_STATE_EXPORT_OK=1
    else
      say "WARN: Clawboard state export failed against $CLAWBOARD_API_URL. Preserving prior state snapshot."
      rm -rf "$STAGE_DIR/clawboard"
      preserve_existing_clawboard_snapshot
      SKIP_CLAWBOARD_EXPORT=1
    fi
  fi

  if [[ "$CLAWBOARD_STATE_EXPORT_OK" -eq 1 ]] && as_bool "${INCLUDE_CLAWBOARD_ATTACHMENTS:-}"; then
    attachments_path=""
    if [[ -n "${CLAWBOARD_ATTACHMENTS_DIR:-}" ]]; then
      attachments_path="$CLAWBOARD_ATTACHMENTS_DIR"
    elif [[ -n "${CLAWBOARD_DIR:-}" && -f "$CLAWBOARD_DIR/.env" ]]; then
      attachments_path="$(read_env_value "$CLAWBOARD_DIR/.env" "CLAWBOARD_ATTACHMENTS_DIR" || true)"
    fi
    if [[ -z "$attachments_path" && -n "${CLAWBOARD_DIR:-}" ]]; then
      attachments_path="$CLAWBOARD_DIR/data/attachments"
    fi
    if [[ -n "$attachments_path" ]]; then
      case "$attachments_path" in
        "~/"*) attachments_path="$HOME/${attachments_path#~/}" ;;
      esac
      if [[ "${attachments_path#/}" == "$attachments_path" && -n "${CLAWBOARD_DIR:-}" ]]; then
        attachments_path="$CLAWBOARD_DIR/$attachments_path"
      fi
      if [[ -d "$attachments_path" ]]; then
        mkdir -p "$STAGE_DIR/clawboard/attachments"
        rsync -a --delete --prune-empty-dirs \
          --exclude ".DS_Store" \
          "$attachments_path/" \
          "$STAGE_DIR/clawboard/attachments/" \
          >/dev/null
      fi
    fi
  fi

  if [[ "$CLAWBOARD_STATE_EXPORT_OK" -eq 1 ]] && as_bool "${INCLUDE_CLAWBOARD_ENV:-}" && [[ -n "${CLAWBOARD_DIR:-}" ]] && [[ -f "$CLAWBOARD_DIR/.env" ]]; then
    mkdir -p "$STAGE_DIR/clawboard"
    rsync -a "$CLAWBOARD_DIR/.env" "$STAGE_DIR/clawboard/" >/dev/null
  fi
fi

# Replace tracked content (keep .git)
rsync -a --delete --prune-empty-dirs \
  --exclude ".git" \
  --exclude ".stage" \
  "$STAGE_DIR/" \
  "$BACKUP_DIR/" \
  >/dev/null

rm -rf "$STAGE_DIR"

cd "$BACKUP_DIR"

if [[ "${CLAWBOARD_STATE_EXPORT_OK:-0}" -eq 1 ]] \
  && as_bool "${INCLUDE_CLAWBOARD_STATE:-}" \
  && as_bool "${INCLUDE_CLAWBOARD_ATTACHMENTS:-}" \
  && as_bool "${SWEEP_ORPHAN_ATTACHMENTS:-}"; then
  ORPHAN_REPORT_PATH="$BACKUP_DIR/clawboard/export/orphan_attachments_report.json"
  sweep_orphan_attachments_in_backup \
    "$BACKUP_DIR" \
    "$BACKUP_DIR/clawboard/attachments" \
    "$BACKUP_DIR/clawboard/export/attachments.json" \
    "$ORPHAN_REPORT_PATH" \
    "$ORPHAN_ATTACHMENT_MAX_AGE_DAYS" \
    "$ORPHAN_ATTACHMENT_SWEEP_MODE"
fi

# Keep Clawboard logs backup lightweight for GitHub limits:
# - store only a compressed tail snapshot for quick forensic context
# - never track the full growing logs.jsonl file
LOGS_PATH="$BACKUP_DIR/clawboard/export/logs.jsonl"
LOGS_TAIL_GZ_PATH="$BACKUP_DIR/clawboard/export/logs.tail.jsonl.gz"
LOGS_TAIL_LINES="${CLAWBOARD_BACKUP_LOG_TAIL_LINES:-20000}"

if [[ "$LOGS_TAIL_LINES" =~ ^[0-9]+$ ]] && [[ -f "$LOGS_PATH" ]]; then
  mkdir -p "$(dirname "$LOGS_TAIL_GZ_PATH")"
  tail -n "$LOGS_TAIL_LINES" "$LOGS_PATH" | gzip -9 > "$LOGS_TAIL_GZ_PATH"
fi

# Ensure oversized raw log file stays out of version control.
if ! grep -q '^clawboard/export/logs.jsonl$' .gitignore 2>/dev/null; then
  printf "
clawboard/export/logs.jsonl
" >> .gitignore
fi

if git ls-files --error-unmatch clawboard/export/logs.jsonl >/dev/null 2>&1; then
  git rm --cached --quiet --ignore-unmatch clawboard/export/logs.jsonl || true
fi
rm -f "$LOGS_PATH"

if [[ -z "$(git status --porcelain)" ]]; then
  # Silent success: cron should not notify when there is nothing new.
  exit 0
fi

git add -A

ts="$(date -u +"%Y-%m-%d %H:%M:%SZ")"
scope="OpenClaw continuity (curated + selected)"
if as_bool "${INCLUDE_CLAWBOARD_STATE:-}"; then
  scope="$scope + Clawboard state"
fi
msg="Clawboard: auto backup $scope ($ts)"
if ! git commit -m "$msg" >/dev/null 2>&1; then
  if [[ -z "$(git status --porcelain)" ]]; then
    exit 0
  fi
  die "git commit failed"
fi

# Ensure branch exists locally
if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  git checkout -b "$BRANCH" >/dev/null
else
  git checkout "$BRANCH" >/dev/null
fi

if [[ "$NO_PUSH" == "1" ]]; then
  say "Backed up changes locally (push skipped): $(git rev-parse --short HEAD)"
  exit 0
fi

# Push
if [[ "$(lc "${AUTH_METHOD:-}")" == "ssh" ]]; then
  # Use explicit key for this push so we don't depend on user-level ssh config.
  # Default: port 22 to github.com. If that fails (common on restrictive networks),
  # retry via ssh.github.com:443.
  export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY_PATH -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

  set +e
  out="$(git push -u "$REMOTE_NAME" "$BRANCH" 2>&1)"
  code=$?

  if [[ $code -ne 0 ]]; then
    # Retry over port 443
    export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY_PATH -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p 443 -o HostName=ssh.github.com"
    out2="$(git push -u "$REMOTE_NAME" "$BRANCH" 2>&1)"
    code2=$?
    if [[ $code2 -ne 0 ]]; then
      set -e
      say "$out" >&2
      say "--- retry over ssh.github.com:443 ---" >&2
      say "$out2" >&2
      die "git push failed (ssh). Confirm the Deploy Key was added AND 'Allow write access' is checked. If you're on a network blocking SSH, port 443 fallback may still be blocked."
    else
      set -e
      say "Backed up and pushed changes to $REPO_SSH_URL (via ssh.github.com:443)"
      exit 0
    fi
  fi
  set -e
  say "Backed up and pushed changes to $REPO_SSH_URL"
else
  # HTTPS + PAT via ephemeral askpass helper so we don't depend on OS keychains.
  ASKPASS="$(mktemp -t clawboard-git-askpass.XXXXXX)"
  chmod 700 "$ASKPASS"
  cat >"$ASKPASS" <<'SH'
#!/usr/bin/env bash
case "$1" in
  *Username*)
    printf "%s" "${GITHUB_USER}"
    ;;
  *Password*)
    printf "%s" "${GITHUB_PAT}"
    ;;
  *)
    printf "%s" "${GITHUB_PAT}"
    ;;
esac
SH

  export GIT_ASKPASS="$ASKPASS"
  export GIT_TERMINAL_PROMPT=0
  export GITHUB_USER
  export GITHUB_PAT

  set +e
  out="$(git push -u "$REMOTE_NAME" "$BRANCH" 2>&1)"
  code=$?
  set -e
  rm -f "$ASKPASS"

  if [[ $code -ne 0 ]]; then
    say "$out" >&2
    die "git push failed (pat)"
  fi
  say "Backed up and pushed changes to $REPO_URL"
fi
