#!/usr/bin/env bash
set -euo pipefail

# Create specialist agent workspaces (workspace-coding, workspace-docs, workspace-web, workspace-social)
# and deploy minimal AGENTS.md / SOUL.md from agent-templates. Idempotent. Does not touch LLM config.
# Usage: OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}" [INSTALL_DIR=<clawboard-repo>] bash scripts/setup_specialist_agents.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_HOME="${OPENCLAW_HOME%/}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_HOME/openclaw.json}"

TEMPLATES_BASE="$INSTALL_DIR/agent-templates"
SPECIALISTS="coding docs web social"

log_info() { echo -e "\033[0;34minfo:\033[0m $1"; }
log_success() { echo -e "\033[0;32msuccess:\033[0m $1"; }
log_warn() { echo -e "\033[1;33mwarning:\033[0m $1"; }

resolve_workspace_for_agent() {
  local agent_id="$1"
  local fallback="$OPENCLAW_HOME/workspace-$agent_id"
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

if not resolved:
    resolved = os.path.join(openclaw_home, f"workspace-{target_id}")

resolved = normalize_path(resolved)
if not resolved or resolved == openclaw_home:
    resolved = os.path.join(openclaw_home, f"workspace-{target_id}")

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

for name in $SPECIALISTS; do
  ws_dir="$(resolve_workspace_for_agent "$name")"
  tmpl_dir="$TEMPLATES_BASE/$name"
  if [ ! -d "$tmpl_dir" ]; then
    log_warn "Template dir missing: $tmpl_dir (skipping $name)."
    continue
  fi
  mkdir -p "$ws_dir"
  deployed=0
  for f in AGENTS.md SOUL.md; do
    if [ -f "$tmpl_dir/$f" ]; then
      cp "$tmpl_dir/$f" "$ws_dir/$f"
      deployed=$((deployed + 1))
    fi
  done
  if [ "$deployed" -gt 0 ]; then
    log_success "Provisioned $name workspace at $ws_dir ($deployed file(s))."
  fi
done
