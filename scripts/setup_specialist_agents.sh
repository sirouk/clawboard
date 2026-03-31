#!/usr/bin/env bash
set -euo pipefail

# Create execution-agent workspaces under the main workspace
# (for example workspace/worker-agent)
# and deploy minimal AGENTS.md / SOUL.md from agent-templates. Idempotent. Does not touch LLM config.
# Subagents keep their own instruction docs, but repo work should still happen in
# the main workspace checkout via explicit delegated paths.
# Usage: OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}" [INSTALL_DIR=<clawboard-repo>] bash scripts/setup_specialist_agents.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_HOME="${OPENCLAW_HOME%/}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_HOME/openclaw.json}"

TEMPLATES_BASE="$INSTALL_DIR/agent-templates"

log_info() { echo -e "\033[0;34minfo:\033[0m $1"; }
log_success() { echo -e "\033[0;32msuccess:\033[0m $1"; }
log_warn() { echo -e "\033[1;33mwarning:\033[0m $1"; }

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

default_subagent_workspace() {
  local agent_id="$1"
  if [ "$agent_id" = "worker" ]; then
    printf "%s/worker-agent" "$(resolve_default_openclaw_workspace_root)"
  else
    printf "%s/subagents/%s" "$(resolve_default_openclaw_workspace_root)" "$agent_id"
  fi
}

discover_specialist_ids() {
  python3 - "$OPENCLAW_CONFIG_PATH" "$TEMPLATES_BASE" <<'PY' 2>/dev/null || true
import json
import os
import re
import sys

cfg_path = sys.argv[1]
templates_base = sys.argv[2]
valid = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def normalize_agent_id(value):
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    if valid.match(raw):
        return raw
    raw = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")
    return raw[:64]


cfg = {}
try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        parsed = json.load(f)
        if isinstance(parsed, dict):
            cfg = parsed
except Exception:
    cfg = {}

configured = []
seen = set()
for entry in ((cfg.get("agents") or {}).get("list") or []):
    if not isinstance(entry, dict):
        continue
    agent_id = normalize_agent_id(entry.get("id"))
    if not agent_id or agent_id == "main" or agent_id in seen:
        continue
    configured.append(agent_id)
    seen.add(agent_id)

template_ids = []
for name in sorted(os.listdir(templates_base)) if os.path.isdir(templates_base) else []:
    if name.startswith("."):
        continue
    agent_id = normalize_agent_id(name)
    if not agent_id or agent_id == "main":
        continue
    if os.path.isdir(os.path.join(templates_base, name)):
        template_ids.append(agent_id)

if "worker" in configured:
    chosen = ["worker"]
elif "worker" in template_ids:
    chosen = ["worker"]
elif configured:
    chosen = configured
else:
    chosen = template_ids

for agent_id in chosen:
    print(agent_id)
PY
}

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

  local tmp
  tmp="$(mktemp "${dst}.tmp.XXXXXX")" || return 12
  if ! cp "$src" "$tmp"; then
    rm -f "$tmp" >/dev/null 2>&1 || true
    return 12
  fi
  if ! mv -f "$tmp" "$dst"; then
    rm -f "$tmp" >/dev/null 2>&1 || true
    return 12
  fi
  if ! cmp -s "$src" "$dst"; then
    return 12
  fi
  return 0
}

resolve_workspace_for_agent() {
  local agent_id="$1"
  local fallback
  fallback="$(default_subagent_workspace "$agent_id")"
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
target_id = (sys.argv[4] or "").strip().lower()

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
        return ""
    raw = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")
    return raw[:64]

def subagent_workspace(base_workspace, agent_id):
    main_workspace = normalize_path(base_workspace)
    safe = normalize_agent_id(agent_id)
    if not main_workspace or not safe or safe == "main":
        return main_workspace
    if safe == "worker":
        return os.path.join(main_workspace, "worker-agent")
    return os.path.join(main_workspace, "subagents", safe)

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

resolved = ""
agents = [entry for entry in ((cfg.get("agents") or {}).get("list") or []) if isinstance(entry, dict)]
for entry in agents:
    if normalize_agent_id(entry.get("id")) != target_id:
        continue
    candidate = entry.get("workspace")
    if isinstance(candidate, str) and candidate.strip():
        resolved = candidate.strip()
    break

legacy_managed_paths = {
    os.path.join(openclaw_home, f"workspace-{target_id}"),
    os.path.join(openclaw_home, "subagents", target_id),
}

resolved = normalize_path(resolved)
if resolved in legacy_managed_paths:
    resolved = ""

if not resolved:
    resolved = subagent_workspace(defaults_workspace, target_id)

resolved = normalize_path(resolved)
if not resolved or resolved == openclaw_home:
    resolved = subagent_workspace(defaults_workspace, target_id)

print(resolved, end="")
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

resolve_legacy_workspace_for_agent() {
  local agent_id="$1"
  [ -f "$OPENCLAW_CONFIG_PATH" ] || return 0

  python3 - "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_HOME" "$agent_id" <<'PY' 2>/dev/null || true
import json
import os
import re
import sys

cfg_path = sys.argv[1]
openclaw_home = os.path.abspath(os.path.expanduser(sys.argv[2]))
target_id = str(sys.argv[3] or "").strip().lower()


def normalize_agent_id(value):
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    raw = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")
    return raw[:64]


def normalize_path(value):
    p = os.path.expanduser(str(value or "").strip())
    if not p:
        return ""
    return os.path.abspath(p)


cfg = {}
try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        parsed = json.load(f)
        if isinstance(parsed, dict):
            cfg = parsed
except Exception:
    cfg = {}

legacy = ""
for entry in ((cfg.get("agents") or {}).get("list") or []):
    if not isinstance(entry, dict):
        continue
    if normalize_agent_id(entry.get("id")) != target_id:
        continue
    candidate = normalize_path(entry.get("workspace"))
    legacy_paths = {
        os.path.join(openclaw_home, f"workspace-{target_id}"),
        os.path.join(openclaw_home, "subagents", target_id),
    }
    if candidate in legacy_paths:
        legacy = candidate
    break

print(legacy, end="")
PY
}

migrate_legacy_workspace_if_needed() {
  local legacy_dir="$1"
  local target_dir="$2"

  [ -n "$legacy_dir" ] || return 0
  legacy_dir="${legacy_dir/#\~/$HOME}"
  target_dir="${target_dir/#\~/$HOME}"
  [ "$legacy_dir" != "$target_dir" ] || return 0

  if [ -L "$legacy_dir" ]; then
    return 0
  fi
  if [ ! -d "$legacy_dir" ]; then
    return 0
  fi

  python3 - "$legacy_dir" "$target_dir" <<'PY'
import os
import shutil
import sys

src = os.path.abspath(os.path.expanduser(sys.argv[1]))
dst = os.path.abspath(os.path.expanduser(sys.argv[2]))

if src == dst or not os.path.isdir(src):
    raise SystemExit(0)

os.makedirs(os.path.dirname(dst), exist_ok=True)
if not os.path.exists(dst):
    try:
        os.rename(src, dst)
    except OSError:
        shutil.copytree(src, dst, dirs_exist_ok=True)
        shutil.rmtree(src)
else:
    shutil.copytree(src, dst, dirs_exist_ok=True)
    shutil.rmtree(src)
PY
  log_info "Migrated legacy execution workspace: $legacy_dir -> $target_dir"
}

SPECIALISTS="$(discover_specialist_ids)"
[ -n "$SPECIALISTS" ] || SPECIALISTS="worker"

for name in $SPECIALISTS; do
  ws_dir="$(resolve_workspace_for_agent "$name")"
  legacy_dir="$(resolve_legacy_workspace_for_agent "$name")"
  tmpl_dir="$TEMPLATES_BASE/$name"
  if [ ! -d "$tmpl_dir" ]; then
    log_warn "Template dir missing: $tmpl_dir (skipping $name)."
    continue
  fi
  migrate_legacy_workspace_if_needed "$legacy_dir" "$ws_dir"
  mkdir -p "$ws_dir"
  mkdir -p "$ws_dir/memory" "$ws_dir/obsidian"

  deployed=0
  unchanged=0
  for f in AGENTS.md SOUL.md; do
    if [ -f "$tmpl_dir/$f" ]; then
      if deploy_file_atomic_if_changed "$tmpl_dir/$f" "$ws_dir/$f"; then
        deployed=$((deployed + 1))
      else
        rc=$?
        if [ "$rc" -eq 10 ]; then
          unchanged=$((unchanged + 1))
        else
          log_warn "Failed deploying $name template file: $f"
        fi
      fi
    fi
  done
  if [ "$deployed" -gt 0 ]; then
    log_success "Provisioned $name workspace at $ws_dir ($deployed updated, $unchanged unchanged)."
  elif [ "$unchanged" -gt 0 ]; then
    log_info "$name workspace already aligned at $ws_dir."
  fi
done
