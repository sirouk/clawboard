#!/usr/bin/env bash
set -euo pipefail

# setup_obsidian_brain.sh
#
# Uses per-agent workspace obsidian directories (<workspace>/obsidian)
# as Obsidian vaults, installs Obsidian based on host OS, installs clawhub +
# obsidian-direct, and configures OpenClaw qmd memory paths for those vaults
# while preserving includeDefaultMemory behavior for workspace-native memory.
#
# Usage:
#   bash scripts/setup_obsidian_brain.sh

USE_COLOR=true
for arg in "$@"; do
  if [ "$arg" = "--no-color" ]; then
    USE_COLOR=false
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
log_error() { echo -e "${RED}error:${NC} $1"; }
die() { log_error "$1"; exit 1; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }
need_cmd() { has_cmd "$1" || die "Missing required command: $1"; }

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
if [ "$OPENCLAW_HOME" != "/" ]; then
  OPENCLAW_HOME="${OPENCLAW_HOME%/}"
fi
OPENCLAW_CONFIG_PATH="$OPENCLAW_HOME/openclaw.json"
OBSIDIAN_UBUNTU_INSTALLER_URL="${OBSIDIAN_UBUNTU_INSTALLER_URL:-https://raw.githubusercontent.com/oviniciusfeitosa/obsidian-ubuntu-installer/main/install.sh}"
OBSIDIAN_RELEASES_API="https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest"
BUN_INSTALLER_URL="${BUN_INSTALLER_URL:-https://bun.sh/install}"

MAIN_AGENT_ID=""
MAIN_AGENT_NAME=""
MAIN_AGENT_WORKSPACE=""
MAIN_AGENT_INDEX="-1"
MAIN_WORKSPACE_CONFIGURED="0"
OBSIDIAN_VAULT_DIR=""
QMD_MEMORY_DIR=""
QMD_COMMAND=""

detect_main_agent_and_workspace() {
  [ -f "$OPENCLAW_CONFIG_PATH" ] || die "OpenClaw config not found at: $OPENCLAW_CONFIG_PATH"
  need_cmd python3

  local resolved
  resolved="$(
    python3 - "$OPENCLAW_CONFIG_PATH" "$HOME" "$OPENCLAW_HOME" "${OPENCLAW_PROFILE:-}" <<'PY'
import json
import os
import re
import shlex
import sys

cfg_path = sys.argv[1]
home_dir = os.path.abspath(os.path.expanduser(sys.argv[2]))
openclaw_home = os.path.abspath(os.path.expanduser(sys.argv[3] or os.path.join(home_dir, ".openclaw")))
profile = (sys.argv[4] or "").strip()

def profile_workspace(base_dir, profile_name):
    raw = (profile_name or "").strip()
    if not raw or raw.lower() == "default":
        return os.path.join(base_dir, "workspace")
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", raw).strip("-")
    if not safe:
        return os.path.join(base_dir, "workspace")
    return os.path.join(base_dir, f"workspace-{safe}")

default_workspace_from_home = profile_workspace(openclaw_home, profile)

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
    p = os.path.expanduser((value or "").strip())
    if not p:
        return ""
    return os.path.abspath(p)

try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception as exc:
    print(f"Failed to parse {cfg_path}: {exc}", file=sys.stderr)
    sys.exit(1)

agents = ((cfg.get("agents") or {}).get("list") or [])
entries = [entry for entry in agents if isinstance(entry, dict)]
indexed_entries = list(enumerate(entries))
default_indexed = [pair for pair in indexed_entries if pair[1].get("default") is True]
default_index, default_entry = default_indexed[0] if default_indexed else (indexed_entries[0] if indexed_entries else (-1, {}))
default_agent_id = normalize_agent_id(default_entry.get("id") if isinstance(default_entry, dict) else "main")

main_indexed = [pair for pair in indexed_entries if normalize_agent_id(pair[1].get("id")) == "main"]
chosen_index, chosen_entry = main_indexed[0] if main_indexed else (default_index, default_entry)

main_id = normalize_agent_id(chosen_entry.get("id") if isinstance(chosen_entry, dict) else default_agent_id)
main_name = chosen_entry.get("name") if isinstance(chosen_entry, dict) and isinstance(chosen_entry.get("name"), str) and chosen_entry.get("name").strip() else main_id

workspace = ""
workspace_configured = False
if isinstance(chosen_entry, dict):
    candidate = chosen_entry.get("workspace")
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        workspace_configured = True

if not workspace and main_id == default_agent_id:
    candidate = (((cfg.get("agents") or {}).get("defaults") or {}).get("workspace"))
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        workspace_configured = True

if not workspace:
    # Some installs may persist a shared workspace under agents.workspace.
    candidate = ((cfg.get("agents") or {}).get("workspace"))
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        workspace_configured = True

if not workspace:
    # Back-compat with singular config key.
    candidate = ((cfg.get("agent") or {}).get("workspace"))
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        workspace_configured = True

if not workspace and main_id == default_agent_id:
    # Back-compat with older top-level workspace config.
    candidate = cfg.get("workspace")
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        workspace_configured = True

if not workspace:
    # Required fallback when config lacks main workspace.
    workspace = default_workspace_from_home

workspace = normalize_path(workspace)
# Safety guard: never use ~/.openclaw as a vault root; use ~/.openclaw/workspace.
if workspace == openclaw_home:
    workspace = default_workspace_from_home
    workspace_configured = False

print("MAIN_AGENT_ID=" + shlex.quote(main_id))
print("MAIN_AGENT_NAME=" + shlex.quote(main_name))
print("MAIN_AGENT_WORKSPACE=" + shlex.quote(workspace))
print("MAIN_AGENT_INDEX=" + str(chosen_index))
print("MAIN_WORKSPACE_CONFIGURED=" + ("1" if workspace_configured else "0"))
PY
  )" || die "Failed to resolve main agent and workspace from $OPENCLAW_CONFIG_PATH"

  eval "$resolved"
  [ -n "${MAIN_AGENT_ID:-}" ] || die "Failed to resolve main agent id"
  [ -n "${MAIN_AGENT_NAME:-}" ] || die "Failed to resolve main agent name"
  [ -n "${MAIN_AGENT_WORKSPACE:-}" ] || die "Failed to resolve main agent workspace"
  [ -n "${MAIN_AGENT_INDEX:-}" ] || MAIN_AGENT_INDEX="-1"
  [ -n "${MAIN_WORKSPACE_CONFIGURED:-}" ] || MAIN_WORKSPACE_CONFIGURED="0"
}

ensure_main_agent_workspace_configured() {
  if [ "${MAIN_WORKSPACE_CONFIGURED:-0}" = "1" ]; then
    return 0
  fi

  if ! has_cmd openclaw; then
    log_warn "openclaw CLI not found; cannot persist main workspace in config."
    return 0
  fi

  if [[ "${MAIN_AGENT_INDEX:-}" =~ ^[0-9]+$ ]]; then
    if openclaw config set "agents.list.${MAIN_AGENT_INDEX}.workspace" "$MAIN_AGENT_WORKSPACE" >/dev/null 2>&1; then
      MAIN_WORKSPACE_CONFIGURED="1"
      log_success "Configured main agent workspace: agents.list.${MAIN_AGENT_INDEX}.workspace=$MAIN_AGENT_WORKSPACE"
      return 0
    fi
  fi

  if openclaw config set agents.defaults.workspace "$MAIN_AGENT_WORKSPACE" >/dev/null 2>&1; then
    MAIN_WORKSPACE_CONFIGURED="1"
    log_success "Configured workspace fallback: agents.defaults.workspace=$MAIN_AGENT_WORKSPACE"
    return 0
  fi

  if openclaw config set agent.workspace "$MAIN_AGENT_WORKSPACE" >/dev/null 2>&1; then
    MAIN_WORKSPACE_CONFIGURED="1"
    log_success "Configured workspace fallback: agent.workspace=$MAIN_AGENT_WORKSPACE"
  else
    log_warn "Failed to persist workspace config; continuing with resolved path."
  fi
}

configured_agent_workspace_pairs() {
  need_cmd python3
  python3 - "$OPENCLAW_CONFIG_PATH" "$MAIN_AGENT_WORKSPACE" "$HOME" "$OPENCLAW_HOME" "${OPENCLAW_PROFILE:-}" <<'PY'
import json
import os
import re
import sys

cfg_path = sys.argv[1]
main_workspace = os.path.abspath(os.path.expanduser(sys.argv[2]))
home_dir = os.path.abspath(os.path.expanduser(sys.argv[3]))
openclaw_home = os.path.abspath(os.path.expanduser(sys.argv[4] or os.path.join(home_dir, ".openclaw")))
profile = (sys.argv[5] or "").strip()
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
    p = os.path.expanduser((value or "").strip())
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

main_workspace = normalize_path(main_workspace) or defaults_workspace
if main_workspace == openclaw_home:
    main_workspace = fallback_workspace

pairs = []
seen_ids = set()
for entry in ((cfg.get("agents") or {}).get("list") or []):
    if not isinstance(entry, dict):
        continue
    aid = normalize_agent_id(entry.get("id"))
    if aid in seen_ids:
        continue
    candidate = entry.get("workspace")
    if not isinstance(candidate, str) or not candidate.strip():
        candidate = defaults_workspace
    workspace = normalize_path(candidate) or defaults_workspace
    if workspace == openclaw_home:
        workspace = fallback_workspace
    if aid == "main":
        workspace = main_workspace
    pairs.append((aid, workspace))
    seen_ids.add(aid)

if "main" not in seen_ids:
    pairs.insert(0, ("main", main_workspace))

ordered = []
ordered.append(("main", main_workspace))
for aid, workspace in pairs:
    if aid == "main":
        continue
    ordered.append((aid, workspace))

for aid, workspace in ordered:
    print(f"{aid}\t{workspace}")
PY
}

configured_agent_workspaces() {
  configured_agent_workspace_pairs | awk -F '\t' '!seen[$2]++ {print $2}'
}

configured_agent_ids() {
  configured_agent_workspace_pairs | awk -F '\t' '!seen[$1]++ {print $1}'
}

configured_obsidian_vault_pairs() {
  while IFS=$'\t' read -r agent_id workspace_path; do
    [ -n "$agent_id" ] || continue
    [ -n "$workspace_path" ] || continue
    local vault_path vault_name
    vault_path="${workspace_path%/}/obsidian"
    if [ "$agent_id" = "main" ]; then
      vault_name="main-thinking-vault"
    else
      vault_name="${agent_id}-thinking-vault"
    fi
    printf "%s\t%s\t%s\n" "$agent_id" "$vault_path" "$vault_name"
  done < <(configured_agent_workspace_pairs) | awk -F '\t' '!seen[$2]++ {print $0}'
}

ensure_agent_workspace_dirs() {
  local workspace_path
  while IFS= read -r workspace_path; do
    [ -n "$workspace_path" ] || continue
    mkdir -p "$workspace_path/memory"
    mkdir -p "$workspace_path/obsidian"
  done < <(configured_agent_workspaces)
  log_info "Prepared memory + obsidian directories for configured agent workspaces."
}

resolve_obsidian_asset_url() {
  local kind="$1"
  local arch="${2:-}"
  need_cmd curl
  need_cmd python3

  curl -fsSL "$OBSIDIAN_RELEASES_API" | python3 - "$kind" "$arch" <<'PY'
import json
import sys

kind = sys.argv[1]
arch = (sys.argv[2] or "").lower()
data = json.load(sys.stdin)
assets = data.get("assets") or []

def pick(predicate):
    for asset in assets:
        name = (asset.get("name") or "")
        if predicate(name.lower()):
            url = (asset.get("browser_download_url") or "").strip()
            if url:
                print(url)
                return True
    return False

ok = False
if kind == "dmg":
    ok = pick(lambda name: name.endswith(".dmg"))
elif kind == "appimage":
    if arch in ("arm64", "aarch64"):
        ok = pick(lambda name: name.endswith("arm64.appimage"))
    else:
        ok = pick(lambda name: name.endswith(".appimage") and "arm64" not in name)
elif kind == "deb":
    if arch in ("arm64", "aarch64"):
        ok = pick(lambda name: name.endswith("_arm64.deb"))
    else:
        ok = pick(lambda name: name.endswith("_amd64.deb"))

if not ok:
    sys.exit(1)
PY
}

is_ubuntu_like() {
  [ -f /etc/os-release ] || return 1
  # shellcheck disable=SC1091
  . /etc/os-release
  local full="${ID:-} ${ID_LIKE:-}"
  case "$full" in
    *ubuntu*|*debian*) return 0 ;;
    *) return 1 ;;
  esac
}

install_obsidian_macos() {
  if [ -d "/Applications/Obsidian.app" ] || [ -d "$HOME/Applications/Obsidian.app" ]; then
    log_info "Obsidian app already present on macOS."
    return 0
  fi

  if has_cmd brew; then
    if brew list --cask obsidian >/dev/null 2>&1; then
      log_info "Obsidian cask already installed."
    else
      log_info "Installing Obsidian via Homebrew cask..."
      brew install --cask obsidian
    fi
    return 0
  fi

  log_info "Homebrew not found; installing Obsidian from latest macOS DMG..."
  local url tmpdir dmg_path attach_output mount_point target_app
  url="$(resolve_obsidian_asset_url dmg)" || die "Unable to resolve latest Obsidian DMG URL"
  tmpdir="$(mktemp -d)"
  dmg_path="$tmpdir/Obsidian.dmg"

  curl -fL "$url" -o "$dmg_path"
  attach_output="$(hdiutil attach "$dmg_path" -nobrowse 2>/dev/null || true)"
  mount_point="$(printf "%s\n" "$attach_output" | awk '/\/Volumes\// {print substr($0, index($0, "/Volumes/")); exit}')"
  [ -n "$mount_point" ] || {
    rm -rf "$tmpdir"
    die "Failed to mount Obsidian DMG"
  }
  [ -d "$mount_point/Obsidian.app" ] || {
    hdiutil detach "$mount_point" >/dev/null 2>&1 || true
    rm -rf "$tmpdir"
    die "Mounted DMG does not contain Obsidian.app"
  }

  if [ -w "/Applications" ] || [ -d "/Applications/Obsidian.app" ]; then
    target_app="/Applications/Obsidian.app"
  else
    mkdir -p "$HOME/Applications"
    target_app="$HOME/Applications/Obsidian.app"
  fi

  rm -rf "$target_app"
  cp -R "$mount_point/Obsidian.app" "$target_app"
  hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  rm -rf "$tmpdir"
  log_success "Obsidian installed at $target_app"
}

install_obsidian_linux_ubuntu() {
  local tmp_script
  tmp_script="$(mktemp)"
  log_info "Installing Obsidian via Ubuntu/Debian installer script..."
  curl -fsSL "$OBSIDIAN_UBUNTU_INSTALLER_URL" -o "$tmp_script"
  chmod +x "$tmp_script"
  bash "$tmp_script"
  rm -f "$tmp_script"
}

install_obsidian_linux_appimage() {
  local arch url install_dir bin_dir appimage_path
  arch="$(uname -m)"
  url="$(resolve_obsidian_asset_url appimage "$arch")" || die "Unable to resolve latest Obsidian AppImage URL"
  install_dir="${OBSIDIAN_INSTALL_DIR:-$HOME/.local/opt/obsidian}"
  bin_dir="$HOME/.local/bin"
  appimage_path="$install_dir/Obsidian.AppImage"

  mkdir -p "$install_dir" "$bin_dir"
  log_info "Installing Obsidian AppImage into $install_dir..."
  curl -fL "$url" -o "$appimage_path"
  chmod +x "$appimage_path"
  ln -sf "$appimage_path" "$bin_dir/obsidian"
  log_success "Obsidian AppImage installed; launcher: $bin_dir/obsidian"
}

install_obsidian() {
  if has_cmd obsidian; then
    log_info "Obsidian command already available: $(command -v obsidian)"
    return 0
  fi

  case "$(uname -s)" in
    Darwin)
      install_obsidian_macos
      ;;
    Linux)
      if is_ubuntu_like; then
        install_obsidian_linux_ubuntu
      else
        log_warn "Non-Ubuntu Linux detected; using generic AppImage install."
        install_obsidian_linux_appimage
      fi
      ;;
    *)
      die "Unsupported OS for automated Obsidian install: $(uname -s)"
      ;;
  esac
}

prefer_homebrew_sqlite_path() {
  local candidate
  for candidate in "/opt/homebrew/opt/sqlite/bin" "/usr/local/opt/sqlite/bin"; do
    if [ -d "$candidate" ]; then
      case ":$PATH:" in
        *":$candidate:"*) ;;
        *) PATH="$candidate:$PATH" ;;
      esac
    fi
  done
  export PATH
}

sqlite_has_load_command() {
  has_cmd sqlite3 || return 1
  printf ".help\n.quit\n" | sqlite3 ":memory:" 2>/dev/null | grep -Eq '^[[:space:]]*\.load[[:space:]]'
}

ensure_qmd_sqlite_prereq() {
  prefer_homebrew_sqlite_path
  if sqlite_has_load_command; then
    log_info "sqlite3 supports extension loading: $(command -v sqlite3)"
    return 0
  fi

  if [ "$(uname -s)" = "Darwin" ] && has_cmd brew; then
    log_info "Installing Homebrew sqlite (QMD prerequisite on macOS)..."
    brew install sqlite >/dev/null || true
    prefer_homebrew_sqlite_path
    if sqlite_has_load_command; then
      log_success "Using extension-capable sqlite3: $(command -v sqlite3)"
      return 0
    fi
  fi

  log_warn "sqlite3 does not expose '.load'; QMD may fail until an extension-capable sqlite is installed."
}

ensure_bun() {
  if has_cmd bun; then
    return 0
  fi

  if [ -x "$HOME/.bun/bin/bun" ]; then
    PATH="$HOME/.bun/bin:$PATH"
    export PATH
    has_cmd bun && return 0
  fi

  need_cmd curl
  log_info "Installing Bun (required for qmd)..."
  curl -fsSL "$BUN_INSTALLER_URL" | bash

  if [ -x "$HOME/.bun/bin/bun" ]; then
    PATH="$HOME/.bun/bin:$PATH"
    export PATH
  fi

  has_cmd bun || die "Bun installation finished, but 'bun' is not on PATH. Add \$HOME/.bun/bin and re-run."
}

qmd_is_usable() {
  has_cmd qmd || return 1
  qmd --help >/dev/null 2>&1
}

trust_bun_qmd_deps() {
  # Best-effort: Bun may block lifecycle scripts by default.
  bun pm -g trust @tobilu/qmd node-llama-cpp better-sqlite3 >/dev/null 2>&1 || true
}

ensure_qmd_cli() {
  if qmd_is_usable; then
    log_info "qmd CLI already present: $(command -v qmd)"
    return 0
  fi

  local github_rc bun_pkg_rc npm_pkg_rc
  github_rc=1
  bun_pkg_rc=1
  npm_pkg_rc=1

  ensure_bun
  if has_cmd qmd; then
    log_warn "qmd binary exists but is not runnable; reinstalling."
  fi

  log_info "Installing qmd CLI via Bun (GitHub source)..."
  set +e
  bun install -g https://github.com/tobi/qmd
  github_rc=$?
  set -e
  if [ "$github_rc" -eq 0 ]; then
    trust_bun_qmd_deps
  else
    log_warn "GitHub-source qmd install failed (exit $github_rc). Trying registry fallback..."
  fi

  if ! has_cmd qmd && [ -x "$HOME/.bun/bin/qmd" ]; then
    PATH="$HOME/.bun/bin:$PATH"
    export PATH
  fi

  if qmd_is_usable; then
    log_success "qmd CLI installed: $(command -v qmd)"
    return 0
  fi

  log_warn "GitHub-source qmd install is not runnable here. Falling back to npm package @tobilu/qmd..."
  bun remove -g @tobilu/qmd >/dev/null 2>&1 || true
  set +e
  bun install -g @tobilu/qmd
  bun_pkg_rc=$?
  set -e
  if [ "$bun_pkg_rc" -eq 0 ]; then
    trust_bun_qmd_deps
  else
    log_warn "Bun registry qmd install failed (exit $bun_pkg_rc)."
  fi

  if ! has_cmd qmd && [ -x "$HOME/.bun/bin/qmd" ]; then
    PATH="$HOME/.bun/bin:$PATH"
    export PATH
  fi

  if qmd_is_usable; then
    log_success "qmd CLI installed: $(command -v qmd)"
    return 0
  fi

  if has_cmd npm; then
    log_warn "Trying npm global install for @tobilu/qmd..."
    set +e
    npm install -g @tobilu/qmd
    npm_pkg_rc=$?
    set -e
    if [ "$npm_pkg_rc" -eq 0 ]; then
      if ! has_cmd qmd && [ -x "$HOME/.bun/bin/qmd" ]; then
        PATH="$HOME/.bun/bin:$PATH"
        export PATH
      fi
      if qmd_is_usable; then
        log_success "qmd CLI installed via npm: $(command -v qmd)"
        return 0
      fi
    else
      log_warn "npm global install for @tobilu/qmd failed (exit $npm_pkg_rc)."
    fi
  fi

  if ! has_cmd qmd && [ -x "$HOME/.bun/bin/qmd" ]; then
    PATH="$HOME/.bun/bin:$PATH"
    export PATH
  fi

  qmd_is_usable || die "qmd installation failed (github rc=$github_rc, bun-package rc=$bun_pkg_rc, npm-package rc=$npm_pkg_rc). Ensure bun global bin is on PATH and retry."
  log_success "qmd CLI installed: $(command -v qmd)"
}

ensure_qmd_prereqs() {
  ensure_qmd_sqlite_prereq
  ensure_qmd_cli
}

obsidian_config_path() {
  case "$(uname -s)" in
    Darwin)
      printf "%s" "$HOME/Library/Application Support/obsidian/obsidian.json"
      ;;
    Linux)
      printf "%s" "${XDG_CONFIG_HOME:-$HOME/.config}/obsidian/obsidian.json"
      ;;
    *)
      return 1
      ;;
  esac
}

register_obsidian_vault() {
  local vault_path="$1"
  [ -n "$vault_path" ] || return 0

  local cfg_path
  cfg_path="$(obsidian_config_path)" || {
    log_warn "Skipping Obsidian vault registration: unsupported OS $(uname -s)"
    return 0
  }

  need_cmd python3
  python3 - "$cfg_path" "$vault_path" <<'PY'
import hashlib
import json
import os
import sys
import time

cfg_path = sys.argv[1]
vault_path = os.path.abspath(os.path.expanduser(sys.argv[2]))
cfg_dir = os.path.dirname(cfg_path)
os.makedirs(cfg_dir, exist_ok=True)

data = {}
try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        raw = f.read().strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                data = parsed
except FileNotFoundError:
    pass
except Exception:
    data = {}

vaults = data.get("vaults")
if not isinstance(vaults, dict):
    vaults = {}

existing_key = None
for key, value in vaults.items():
    if isinstance(value, dict):
        current_path = os.path.abspath(os.path.expanduser(str(value.get("path", ""))))
        if current_path == vault_path:
            existing_key = key
            break

if not existing_key:
    base = hashlib.sha256(vault_path.encode("utf-8")).hexdigest()[:16]
    candidate = base
    index = 1
    while candidate in vaults:
        candidate = f"{base[:12]}{index:04x}"[:16]
        index += 1
    existing_key = candidate

entry = vaults.get(existing_key)
if not isinstance(entry, dict):
    entry = {}

entry["path"] = vault_path
entry["ts"] = int(time.time() * 1000)
entry["open"] = True
vaults[existing_key] = entry
data["vaults"] = vaults

tmp_path = f"{cfg_path}.tmp-{os.getpid()}"
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(data, f, separators=(",", ":"))
os.replace(tmp_path, cfg_path)
PY

  log_success "Registered Obsidian vault path: $vault_path"
}

register_all_obsidian_vaults() {
  local _agent_id vault_path _vault_name
  while IFS=$'\t' read -r _agent_id vault_path _vault_name; do
    [ -n "$vault_path" ] || continue
    register_obsidian_vault "$vault_path"
  done < <(configured_obsidian_vault_pairs)
}

try_open_obsidian_vault() {
  case "$(uname -s)" in
    Darwin)
      open -a Obsidian "$OBSIDIAN_VAULT_DIR" >/dev/null 2>&1 || true
      ;;
    Linux)
      if has_cmd obsidian; then
        nohup obsidian "$OBSIDIAN_VAULT_DIR" >/dev/null 2>&1 &
      fi
      ;;
  esac
}

install_clawhub_and_skill() {
  need_cmd npm
  log_info "Installing clawhub globally..."
  npm install -g clawhub@latest

  need_cmd clawhub
  mkdir -p "$OPENCLAW_HOME/skills"
  local max_attempts attempt delay_s max_delay_s rc install_output
  max_attempts="${OBSIDIAN_DIRECT_INSTALL_MAX_ATTEMPTS:-12}"
  delay_s="${OBSIDIAN_DIRECT_INSTALL_RETRY_DELAY_SEC:-10}"
  max_delay_s="${OBSIDIAN_DIRECT_INSTALL_RETRY_MAX_DELAY_SEC:-120}"
  attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    log_info "Installing obsidian-direct via clawhub into $OPENCLAW_HOME/skills (--force) [attempt $attempt/$max_attempts]..."
    set +e
    install_output="$(clawhub --workdir "$OPENCLAW_HOME" --dir "skills" install obsidian-direct --force 2>&1)"
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
      [ -n "$install_output" ] && printf "%s\n" "$install_output"
      break
    fi

    [ -n "$install_output" ] && printf "%s\n" "$install_output" >&2
    if printf "%s" "$install_output" | grep -qi "rate limit exceeded"; then
      if [ "$attempt" -lt "$max_attempts" ]; then
        log_warn "clawhub rate-limited. Retrying in ${delay_s}s..."
        sleep "$delay_s"
        delay_s=$((delay_s * 2))
        if [ "$delay_s" -gt "$max_delay_s" ]; then
          delay_s="$max_delay_s"
        fi
        attempt=$((attempt + 1))
        continue
      fi
      die "Failed to install obsidian-direct after $max_attempts attempts due to clawhub rate limiting."
    fi
    die "Failed to install obsidian-direct (non-rate-limit error)."
  done

  # Clean up accidental repo-local installs from prior runs.
  local repo_skill_copy
  repo_skill_copy="$MAIN_AGENT_WORKSPACE/projects/clawboard/skills/obsidian-direct"
  if [ -d "$repo_skill_copy" ] && [ "$repo_skill_copy" != "$OPENCLAW_HOME/skills/obsidian-direct" ]; then
    rm -rf "$repo_skill_copy"
    log_info "Removed repo-local obsidian-direct copy: $repo_skill_copy"
  fi
}

configure_openclaw_memory() {
  need_cmd openclaw
  need_cmd python3

  local payload qmd_command
  qmd_command="${QMD_COMMAND:-$(command -v qmd || true)}"
  payload="$(
    python3 - "$OPENCLAW_CONFIG_PATH" "$MAIN_AGENT_WORKSPACE" "$HOME" "$OPENCLAW_HOME" "${OPENCLAW_PROFILE:-}" "$qmd_command" <<'PY'
import copy
import json
import os
import re
import sys

cfg_path = sys.argv[1]
main_workspace = os.path.abspath(os.path.expanduser(sys.argv[2]))
home_dir = os.path.abspath(os.path.expanduser(sys.argv[3]))
openclaw_home = os.path.abspath(os.path.expanduser(sys.argv[4] or os.path.join(home_dir, ".openclaw")))
profile = (sys.argv[5] or "").strip()
qmd_command = str(sys.argv[6] or "").strip()
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

def profile_workspace(base_dir, profile_name):
    raw = (profile_name or "").strip()
    if not raw or raw.lower() == "default":
        return os.path.join(base_dir, "workspace")
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", raw).strip("-")
    if not safe:
        return os.path.join(base_dir, "workspace")
    return os.path.join(base_dir, f"workspace-{safe}")

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

main_workspace = normalize_path(main_workspace) or defaults_workspace
if main_workspace == openclaw_home:
    main_workspace = fallback_workspace

agent_workspace_pairs = []
seen_ids = set()
for entry in ((cfg.get("agents") or {}).get("list") or []):
    if not isinstance(entry, dict):
        continue
    aid = normalize_agent_id(entry.get("id"))
    if aid in seen_ids:
        continue
    candidate = entry.get("workspace")
    if not isinstance(candidate, str) or not candidate.strip():
        candidate = defaults_workspace
    workspace = normalize_path(candidate) or defaults_workspace
    if workspace == openclaw_home:
        workspace = fallback_workspace
    if aid == "main":
        workspace = main_workspace
    agent_workspace_pairs.append((aid, workspace))
    seen_ids.add(aid)

if "main" not in seen_ids:
    agent_workspace_pairs.insert(0, ("main", main_workspace))

ordered_pairs = [("main", main_workspace)]
for aid, workspace in agent_workspace_pairs:
    if aid == "main":
        continue
    ordered_pairs.append((aid, workspace))

target_paths = []
target_path_set = set()
for aid, workspace in ordered_pairs:
    obsidian_path = normalize_path(os.path.join(workspace, "obsidian"))
    if not obsidian_path or obsidian_path in target_path_set:
        continue
    target_path_set.add(obsidian_path)
    if aid == "main":
        name = "main-thinking-vault"
    else:
        name = f"{aid}-thinking-vault"
    target_paths.append(
        {
            "path": obsidian_path,
            "name": name,
            "pattern": "**/*.md",
        }
    )

memory_cfg = cfg.get("memory")
if not isinstance(memory_cfg, dict):
    memory_cfg = {}
else:
    memory_cfg = copy.deepcopy(memory_cfg)

memory_cfg["backend"] = "qmd"
qmd_cfg = memory_cfg.get("qmd")
if not isinstance(qmd_cfg, dict):
    qmd_cfg = {}
else:
    qmd_cfg = copy.deepcopy(qmd_cfg)

qmd_cfg["includeDefaultMemory"] = True
if qmd_command:
    qmd_cfg["command"] = qmd_command

raw_paths = qmd_cfg.get("paths")
if not isinstance(raw_paths, list):
    raw_paths = []

normalized_paths = []
seen = set()

for item in target_paths:
    dedupe_key = (item["path"], item["name"], item["pattern"])
    if dedupe_key in seen:
        continue
    seen.add(dedupe_key)
    normalized_paths.append(item)

for entry in raw_paths:
    if not isinstance(entry, dict):
        continue

    item = copy.deepcopy(entry)
    path_value = normalize_path(item.get("path"))
    if not path_value:
        continue

    if path_value in target_path_set:
        # Canonical per-agent thinking vault entries are managed above.
        continue

    item["path"] = path_value
    name = str(item.get("name") or "").strip()
    pattern = str(item.get("pattern") or "").strip()

    if name:
        item["name"] = name
    else:
        item.pop("name", None)

    if pattern:
        item["pattern"] = pattern
    else:
        item.pop("pattern", None)

    dedupe_key = (item["path"], item.get("name", ""), item.get("pattern", ""))
    if dedupe_key in seen:
        continue
    seen.add(dedupe_key)
    normalized_paths.append(item)

qmd_cfg["paths"] = normalized_paths
memory_cfg["qmd"] = qmd_cfg
print(json.dumps(memory_cfg))
PY
  )"

  log_info "Configuring OpenClaw memory backend (qmd) with includeDefaultMemory + per-agent obsidian vault paths."
  openclaw config set memory --json "$payload"
  log_success "OpenClaw memory config updated in $OPENCLAW_CONFIG_PATH"
}

ensure_memory_search_defaults() {
  need_cmd openclaw

  local memory_search_enabled flush_enabled
  memory_search_enabled="$(openclaw config get agents.defaults.memorySearch.enabled 2>/dev/null || true)"
  flush_enabled="$(openclaw config get agents.defaults.compaction.memoryFlush.enabled 2>/dev/null || true)"

  if [ -z "$memory_search_enabled" ]; then
    openclaw config set agents.defaults.memorySearch.enabled true --json >/dev/null 2>&1 || true
    log_info "Enabled agents.defaults.memorySearch.enabled for memory tools."
  fi

  if [ -z "$flush_enabled" ]; then
    openclaw config set agents.defaults.compaction.memoryFlush.enabled true --json >/dev/null 2>&1 || true
    log_info "Enabled agents.defaults.compaction.memoryFlush.enabled."
  fi
}

refresh_memory_indexes() {
  need_cmd openclaw

  local scope raw_id agent_id
  local -a agent_ids ordered_ids
  scope="$(printf "%s" "${OBSIDIAN_MEMORY_INDEX_SCOPE:-all}" | tr '[:upper:]' '[:lower:]')"

  if [ "$scope" = "main" ]; then
    agent_ids=("$MAIN_AGENT_ID")
  else
    while IFS= read -r raw_id; do
      agent_id="${raw_id//$'\r'/}"
      agent_id="${agent_id#"${agent_id%%[![:space:]]*}"}"
      agent_id="${agent_id%"${agent_id##*[![:space:]]}"}"
      [ -n "$agent_id" ] || continue
      agent_ids+=("$agent_id")
    done < <(configured_agent_ids)
    if [ "${#agent_ids[@]}" -eq 0 ]; then
      agent_ids=("$MAIN_AGENT_ID")
    fi
  fi

  ordered_ids=("$MAIN_AGENT_ID")
  for agent_id in "${agent_ids[@]}"; do
    [ -n "$agent_id" ] || continue
    if [ "$agent_id" = "$MAIN_AGENT_ID" ]; then
      continue
    fi
    ordered_ids+=("$agent_id")
  done

  log_info "Refreshing OpenClaw memory index for: ${ordered_ids[*]} (scope=${scope}, force=true)"
  for agent_id in "${ordered_ids[@]}"; do
    [ -n "$agent_id" ] || continue
    log_info "Running: openclaw memory index --agent $agent_id --force"
    if openclaw memory index --agent "$agent_id" --force; then
      log_success "Memory index refreshed for agent '$agent_id'."
    else
      log_warn "Memory index refresh failed for agent '$agent_id'. Retry manually: openclaw memory index --agent $agent_id --force"
    fi
  done
}

main() {
  log_info "Resolving main agent and workspace from $OPENCLAW_CONFIG_PATH..."
  detect_main_agent_and_workspace
  ensure_main_agent_workspace_configured
  log_success "Main agent: $MAIN_AGENT_NAME ($MAIN_AGENT_ID)"
  log_success "Main workspace: $MAIN_AGENT_WORKSPACE"

  ensure_agent_workspace_dirs
  QMD_MEMORY_DIR="$MAIN_AGENT_WORKSPACE/obsidian"
  OBSIDIAN_VAULT_DIR="$QMD_MEMORY_DIR"
  log_success "Main thinking vault path ready: $OBSIDIAN_VAULT_DIR"
  log_success "Default memory path ready: $MAIN_AGENT_WORKSPACE/memory"

  # Cleanup from older script versions that used <workspace>/obsidian-brain.
  if [ -d "$MAIN_AGENT_WORKSPACE/obsidian-brain" ]; then
    rmdir "$MAIN_AGENT_WORKSPACE/obsidian-brain" >/dev/null 2>&1 || true
  fi

  install_obsidian
  register_all_obsidian_vaults
  try_open_obsidian_vault
  ensure_qmd_prereqs
  install_clawhub_and_skill
  configure_openclaw_memory
  ensure_memory_search_defaults
  refresh_memory_indexes

  echo ""
  log_success "Obsidian brain setup complete."
  echo "Main agent id: $MAIN_AGENT_ID"
  echo "Main agent name: $MAIN_AGENT_NAME"
  echo "Main workspace: $MAIN_AGENT_WORKSPACE"
  echo "Main Obsidian vault path: $OBSIDIAN_VAULT_DIR"
  echo "Main qmd thinking path: $QMD_MEMORY_DIR"
}

main "$@"
