#!/usr/bin/env bash
set -euo pipefail

# Create specialist agent workspaces (workspace-coding, workspace-docs, workspace-web, workspace-social)
# and deploy minimal AGENTS.md / SOUL.md from agent-templates. Idempotent. Does not touch LLM config.
# Usage: OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}" [INSTALL_DIR=<clawboard-repo>] bash scripts/setup_specialist_agents.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_HOME="${OPENCLAW_HOME%/}"

TEMPLATES_BASE="$INSTALL_DIR/agent-templates"
SPECIALISTS="coding docs web social"

log_info() { echo -e "\033[0;34minfo:\033[0m $1"; }
log_success() { echo -e "\033[0;32msuccess:\033[0m $1"; }
log_warn() { echo -e "\033[1;33mwarning:\033[0m $1"; }

for name in $SPECIALISTS; do
  ws_dir="$OPENCLAW_HOME/workspace-$name"
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
