#!/usr/bin/env bash
set -euo pipefail

# setup-openclaw-memory-backup.sh
#
# Interactive setup:
# - Detect OpenClaw workspace scope from ~/.openclaw/openclaw.json
# - (Optional) Create a new private GitHub repo via `gh` (if available/auth'd)
# - Prefer GitHub Deploy Key (SSH) for auth (recommended)
#   - Generates a dedicated SSH keypair
#   - Prints instructions to add it as a Deploy Key (WRITE access reminder)
#   - Saves key path in ~/.openclaw/credentials/clawboard-memory-backup.env
# - Writes config to ~/.openclaw/credentials/clawboard-memory-backup.json (0600)
# - Optionally includes full Clawboard state export + attachment files in each backup run
# - Optionally installs an OpenClaw cron job (agentTurn) to run backup every 15m
#
# Non-interactive mode:
# - Pass --non-interactive (or CLAWBOARD_MEMORY_BACKUP_NON_INTERACTIVE=1)
# - Provide required values via env/flags (at minimum: repo URL unless using gh creation)
# - Useful for bootstrap/CI flows where no stdin prompts should occur.

say() { printf "%s\n" "$*"; }
die() { say "ERROR: $*" >&2; exit 2; }

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
OPENCLAW_JSON="$OPENCLAW_DIR/openclaw.json"
CRED_DIR="$OPENCLAW_DIR/credentials"
CRED_JSON="$CRED_DIR/clawboard-memory-backup.json"
CRED_ENV="$CRED_DIR/clawboard-memory-backup.env"

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }
need_cmd python3
need_cmd mkdir
need_cmd chmod
need_cmd cat
need_cmd ssh-keygen

has_cmd() { command -v "$1" >/dev/null 2>&1; }

# bash 3.2 compatibility (macOS default /bin/bash): no ${var,,}
lc() { tr '[:upper:]' '[:lower:]' <<<"${1:-}"; }
is_truthy() {
  case "$(lc "${1:-}")" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

NON_INTERACTIVE=false
RUN_BACKUP_NOW=""
INSTALL_CRON_PRESET=""
CREATE_REPO_PRESET=""
REPO_URL_PRESET=""
REPO_SSH_URL_PRESET=""
AUTH_METHOD_PRESET=""
DEPLOY_KEY_PATH_PRESET=""
GITHUB_USER_PRESET=""
GITHUB_PAT_PRESET=""
INCLUDE_OPENCLAW_CONFIG_PRESET=""
INCLUDE_OPENCLAW_SKILLS_PRESET=""
INCLUDE_CLAWBOARD_STATE_PRESET=""
CLAWBOARD_DIR_PRESET=""
CLAWBOARD_API_URL_PRESET=""
INCLUDE_CLAWBOARD_ATTACHMENTS_PRESET=""
INCLUDE_CLAWBOARD_ENV_PRESET=""
CLAWBOARD_BACKUP_TOKEN_PRESET=""
BACKUP_DIR_PRESET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    --repo-url)
      [ $# -ge 2 ] || die "--repo-url requires a value"
      REPO_URL_PRESET="$2"; shift 2
      ;;
    --repo-ssh-url)
      [ $# -ge 2 ] || die "--repo-ssh-url requires a value"
      REPO_SSH_URL_PRESET="$2"; shift 2
      ;;
    --auth-method)
      [ $# -ge 2 ] || die "--auth-method requires a value (ssh|pat)"
      AUTH_METHOD_PRESET="$2"; shift 2
      ;;
    --deploy-key-path)
      [ $# -ge 2 ] || die "--deploy-key-path requires a value"
      DEPLOY_KEY_PATH_PRESET="$2"; shift 2
      ;;
    --github-user)
      [ $# -ge 2 ] || die "--github-user requires a value"
      GITHUB_USER_PRESET="$2"; shift 2
      ;;
    --github-pat)
      [ $# -ge 2 ] || die "--github-pat requires a value"
      GITHUB_PAT_PRESET="$2"; shift 2
      ;;
    --backup-dir)
      [ $# -ge 2 ] || die "--backup-dir requires a value"
      BACKUP_DIR_PRESET="$2"; shift 2
      ;;
    --clawboard-dir)
      [ $# -ge 2 ] || die "--clawboard-dir requires a value"
      CLAWBOARD_DIR_PRESET="$2"; shift 2
      ;;
    --clawboard-api-url)
      [ $# -ge 2 ] || die "--clawboard-api-url requires a value"
      CLAWBOARD_API_URL_PRESET="$2"; shift 2
      ;;
    --run-backup-now) RUN_BACKUP_NOW="Y"; shift ;;
    --skip-run-backup-now) RUN_BACKUP_NOW="N"; shift ;;
    --install-cron) INSTALL_CRON_PRESET="Y"; shift ;;
    --skip-install-cron) INSTALL_CRON_PRESET="N"; shift ;;
    --create-repo) CREATE_REPO_PRESET="y"; shift ;;
    --no-create-repo) CREATE_REPO_PRESET="n"; shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: setup-openclaw-memory-backup.sh [options]

Options:
  --non-interactive          Disable prompts; use env/flags.
  --repo-url <https-url>     Backup repo URL (required in non-interactive unless --create-repo with gh auth).
  --repo-ssh-url <ssh-url>   Optional SSH remote URL override.
  --auth-method <ssh|pat>    Auth mode (default: ssh).
  --deploy-key-path <path>   Deploy key path for ssh mode.
  --github-user <user>       GitHub username for pat mode.
  --github-pat <token>       GitHub PAT for pat mode.
  --backup-dir <path>        Local backup clone dir.
  --clawboard-dir <path>     Clawboard install path.
  --clawboard-api-url <url>  Clawboard API base URL.
  --run-backup-now           Run immediate validation backup.
  --skip-run-backup-now      Skip immediate validation backup.
  --install-cron             Install OpenClaw cron job.
  --skip-install-cron        Skip OpenClaw cron install.
  --create-repo              Create private repo via gh.
  --no-create-repo           Do not create repo via gh.

Env overrides:
  CLAWBOARD_MEMORY_BACKUP_NON_INTERACTIVE=1
  CLAWBOARD_BACKUP_* (repo/auth/include/cron presets)
USAGE
      exit 0
      ;;
    *)
      die "Unknown option: $1 (run with --help)"
      ;;
  esac
done

if [ "$NON_INTERACTIVE" = false ] && is_truthy "${CLAWBOARD_MEMORY_BACKUP_NON_INTERACTIVE:-}"; then
  NON_INTERACTIVE=true
fi

workspace_from_config() {
  [[ -f "$OPENCLAW_JSON" ]] || return 1
  python3 - <<'PY' "$OPENCLAW_JSON" "$OPENCLAW_DIR" "$HOME" "${OPENCLAW_PROFILE:-}"
import json
import os
import re
import sys

cfg_path = sys.argv[1]
openclaw_dir = os.path.abspath(os.path.expanduser(sys.argv[2]))
home_dir = os.path.abspath(os.path.expanduser(sys.argv[3]))
profile = (sys.argv[4] or "").strip()

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

def agent_id(entry: dict) -> str:
    raw = str((entry or {}).get("id") or "").strip().lower()
    return raw

configured = False
workspace = ""
chosen_index = -1
workspaces = []
qmd_paths = []

try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        d = json.load(f)
except Exception:
    print(default_ws)
    print("0")
    print("-1")
    print("[]")
    print("[]")
    sys.exit(0)

agents = ((d.get("agents") or {}).get("list") or [])
entries = [entry for entry in agents if isinstance(entry, dict)]
indexed_entries = list(enumerate(entries))
default_indexed = [pair for pair in indexed_entries if pair[1].get("default") is True]
default_index, default_entry = default_indexed[0] if default_indexed else (indexed_entries[0] if indexed_entries else (-1, {}))
main_indexed = [pair for pair in indexed_entries if agent_id(pair[1]) == "main"]
chosen_index, chosen_entry = main_indexed[0] if main_indexed else (default_index, default_entry)

if isinstance(chosen_entry, dict):
    candidate = chosen_entry.get("workspace")
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        configured = True

if not workspace:
    candidate = (((d.get("agents") or {}).get("defaults") or {}).get("workspace"))
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        configured = True

if not workspace:
    candidate = ((d.get("agents") or {}).get("workspace"))
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        configured = True

if not workspace:
    candidate = ((d.get("agent") or {}).get("workspace"))
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        configured = True

if not workspace:
    candidate = d.get("workspace")
    if isinstance(candidate, str) and candidate.strip():
        workspace = candidate.strip()
        configured = True

if not workspace:
    workspace = default_ws

workspace = norm(workspace)
if workspace == openclaw_dir:
    workspace = default_ws
    configured = False

default_agent_workspace = workspace
for entry in entries:
    candidate = entry.get("workspace")
    if isinstance(candidate, str) and candidate.strip():
        resolved = norm(candidate)
    else:
        resolved = default_agent_workspace
    if resolved and resolved not in workspaces:
        workspaces.append(resolved)

if workspace and workspace not in workspaces:
    workspaces.insert(0, workspace)

memory_cfg = d.get("memory") if isinstance(d.get("memory"), dict) else {}
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
    qmd_paths.append(
        {
            "path": resolved,
            "name": str(raw.get("name") or "").strip(),
            "pattern": str(raw.get("pattern") or "").strip(),
        }
    )

print(workspace)
print("1" if configured else "0")
print(str(chosen_index))
print(json.dumps(workspaces, separators=(",", ":")))
print(json.dumps(qmd_paths, separators=(",", ":")))
PY
}

ensure_workspace_configured() {
  local workspace_path="$1"
  local configured="$2"
  local agent_index="$3"
  [[ "$configured" == "1" ]] && return 0

  if ! has_cmd openclaw; then
    say "WARN: openclaw CLI not found; using fallback workspace path without persisting config: $workspace_path"
    return 0
  fi

  if [[ "$agent_index" =~ ^[0-9]+$ ]]; then
    if openclaw config set "agents.list.${agent_index}.workspace" "$workspace_path" >/dev/null 2>&1; then
      say "Configured OpenClaw workspace: agents.list.${agent_index}.workspace=$workspace_path"
      return 0
    fi
  fi

  if openclaw config set agents.defaults.workspace "$workspace_path" >/dev/null 2>&1; then
    say "Configured OpenClaw workspace: agents.defaults.workspace=$workspace_path"
    return 0
  fi

  if openclaw config set agent.workspace "$workspace_path" >/dev/null 2>&1; then
    say "Configured OpenClaw workspace: agent.workspace=$workspace_path"
  else
    say "WARN: Failed to persist workspace in openclaw.json; continuing with $workspace_path"
  fi
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

detect_clawboard_dir() {
  local script_dir candidate
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  candidate="$(cd "$script_dir/../../.." >/dev/null 2>&1 && pwd || true)"
  if [[ -n "$candidate" && -f "$candidate/deploy.sh" && -f "$candidate/docker-compose.yaml" ]]; then
    printf "%s" "$candidate"
    return 0
  fi

  for candidate in \
    "${CLAWBOARD_DIR:-}" \
    "$WORKSPACE_PATH/projects/clawboard" \
    "$WORKSPACE_PATH/project/clawboard" \
    "$HOME/clawboard"
  do
    [[ -n "$candidate" ]] || continue
    if [[ -f "$candidate/deploy.sh" && -f "$candidate/docker-compose.yaml" ]]; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

prompt() {
  local var="$1"; shift
  local msg="$1"; shift
  local silent="${1:-0}"
  local val=""
  if [ "$NON_INTERACTIVE" = true ]; then
    val="${!var:-}"
    if [[ -z "$val" && "$msg" == *"[default:"* ]]; then
      val="${msg##*\[default: }"
      val="${val%]*}"
    fi
    printf -v "$var" "%s" "$val"
    return 0
  fi
  if [[ "$silent" == "1" ]]; then
    read -r -s -p "$msg" val; echo ""
  else
    read -r -p "$msg" val
  fi
  printf -v "$var" "%s" "$val"
}

say "== Clawboard: OpenClaw curated memory backup setup =="

WORKSPACE_INFO="$(workspace_from_config || true)"
WORKSPACE_PATH="$(printf "%s\n" "$WORKSPACE_INFO" | sed -n '1p')"
WORKSPACE_CONFIGURED="$(printf "%s\n" "$WORKSPACE_INFO" | sed -n '2p')"
WORKSPACE_AGENT_INDEX="$(printf "%s\n" "$WORKSPACE_INFO" | sed -n '3p')"
WORKSPACE_PATHS_JSON="$(printf "%s\n" "$WORKSPACE_INFO" | sed -n '4p')"
QMD_PATHS_JSON="$(printf "%s\n" "$WORKSPACE_INFO" | sed -n '5p')"

if [[ -z "${WORKSPACE_PATH:-}" ]]; then
  default_ws="$OPENCLAW_DIR/workspace"
  if [[ -n "${OPENCLAW_PROFILE:-}" && "${OPENCLAW_PROFILE:-}" != "default" ]]; then
    default_ws="$OPENCLAW_DIR/workspace-${OPENCLAW_PROFILE}"
  fi
  WORKSPACE_PATH="$default_ws"
  WORKSPACE_CONFIGURED="0"
  WORKSPACE_AGENT_INDEX="-1"
fi

if [[ -z "${WORKSPACE_PATHS_JSON:-}" ]]; then
  WORKSPACE_PATHS_JSON="$(python3 - <<'PY' "$WORKSPACE_PATH"
import json
import sys
print(json.dumps([sys.argv[1]], separators=(",", ":")))
PY
)"
fi
if [[ -z "${QMD_PATHS_JSON:-}" ]]; then
  QMD_PATHS_JSON="[]"
fi

if [[ ! -d "$WORKSPACE_PATH" ]]; then
  if [[ "$WORKSPACE_CONFIGURED" == "0" ]]; then
    mkdir -p "$WORKSPACE_PATH"
    say "Created fallback workspace path: $WORKSPACE_PATH"
  else
    die "Workspace path does not exist: $WORKSPACE_PATH"
  fi
fi

ensure_workspace_configured "$WORKSPACE_PATH" "${WORKSPACE_CONFIGURED:-0}" "${WORKSPACE_AGENT_INDEX:--1}"

mkdir -p "$CRED_DIR"

# Presets for non-interactive/automated usage.
if [ -z "$CREATE_REPO_PRESET" ]; then
  CREATE_REPO_PRESET="${CLAWBOARD_BACKUP_CREATE_REPO:-}"
fi
if [ -z "$REPO_URL_PRESET" ]; then
  REPO_URL_PRESET="${CLAWBOARD_BACKUP_REPO_URL:-}"
fi
if [ -z "$REPO_SSH_URL_PRESET" ]; then
  REPO_SSH_URL_PRESET="${CLAWBOARD_BACKUP_REPO_SSH_URL:-}"
fi
if [ -z "$AUTH_METHOD_PRESET" ]; then
  AUTH_METHOD_PRESET="${CLAWBOARD_BACKUP_AUTH_METHOD:-}"
fi
if [ -z "$DEPLOY_KEY_PATH_PRESET" ]; then
  DEPLOY_KEY_PATH_PRESET="${CLAWBOARD_BACKUP_DEPLOY_KEY_PATH:-}"
fi
if [ -z "$GITHUB_USER_PRESET" ]; then
  GITHUB_USER_PRESET="${CLAWBOARD_BACKUP_GITHUB_USER:-}"
fi
if [ -z "$GITHUB_PAT_PRESET" ]; then
  GITHUB_PAT_PRESET="${CLAWBOARD_BACKUP_GITHUB_PAT:-}"
fi
if [ -z "$INCLUDE_OPENCLAW_CONFIG_PRESET" ]; then
  INCLUDE_OPENCLAW_CONFIG_PRESET="${CLAWBOARD_BACKUP_INCLUDE_OPENCLAW_CONFIG:-}"
fi
if [ -z "$INCLUDE_OPENCLAW_SKILLS_PRESET" ]; then
  INCLUDE_OPENCLAW_SKILLS_PRESET="${CLAWBOARD_BACKUP_INCLUDE_OPENCLAW_SKILLS:-}"
fi
if [ -z "$INCLUDE_CLAWBOARD_STATE_PRESET" ]; then
  INCLUDE_CLAWBOARD_STATE_PRESET="${CLAWBOARD_BACKUP_INCLUDE_CLAWBOARD_STATE:-}"
fi
if [ -z "$CLAWBOARD_DIR_PRESET" ]; then
  CLAWBOARD_DIR_PRESET="${CLAWBOARD_BACKUP_CLAWBOARD_DIR:-${CLAWBOARD_DIR:-}}"
fi
if [ -z "$CLAWBOARD_API_URL_PRESET" ]; then
  CLAWBOARD_API_URL_PRESET="${CLAWBOARD_BACKUP_API_URL:-}"
fi
if [ -z "$INCLUDE_CLAWBOARD_ATTACHMENTS_PRESET" ]; then
  INCLUDE_CLAWBOARD_ATTACHMENTS_PRESET="${CLAWBOARD_BACKUP_INCLUDE_ATTACHMENTS:-}"
fi
if [ -z "$INCLUDE_CLAWBOARD_ENV_PRESET" ]; then
  INCLUDE_CLAWBOARD_ENV_PRESET="${CLAWBOARD_BACKUP_INCLUDE_CLAWBOARD_ENV:-}"
fi
if [ -z "$CLAWBOARD_BACKUP_TOKEN_PRESET" ]; then
  CLAWBOARD_BACKUP_TOKEN_PRESET="${CLAWBOARD_BACKUP_TOKEN:-}"
fi
if [ -z "$BACKUP_DIR_PRESET" ]; then
  BACKUP_DIR_PRESET="${CLAWBOARD_BACKUP_DIR:-}"
fi
if [ -z "$RUN_BACKUP_NOW" ]; then
  RUN_BACKUP_NOW="${CLAWBOARD_BACKUP_RUN_NOW:-}"
fi
if [ -z "$INSTALL_CRON_PRESET" ]; then
  INSTALL_CRON_PRESET="${CLAWBOARD_BACKUP_INSTALL_CRON:-}"
fi

if [ "$NON_INTERACTIVE" = true ]; then
  [ -n "$CREATE_REPO_PRESET" ] || CREATE_REPO_PRESET="n"
  [ -n "$INCLUDE_CLAWBOARD_STATE_PRESET" ] || INCLUDE_CLAWBOARD_STATE_PRESET="n"
  [ -n "$RUN_BACKUP_NOW" ] || RUN_BACKUP_NOW="N"
  [ -n "$INSTALL_CRON_PRESET" ] || INSTALL_CRON_PRESET="N"
fi

say ""
say "Step 1: GitHub repo"
say "We can create a *private* repo automatically if you have the GitHub CLI (gh) installed and authenticated."

CREATE_REPO=""
if [ -n "$CREATE_REPO_PRESET" ]; then
  CREATE_REPO="$CREATE_REPO_PRESET"
elif [ "$NON_INTERACTIVE" = true ]; then
  CREATE_REPO="n"
elif has_cmd gh; then
  # Check auth status quickly
  if gh auth status -h github.com >/dev/null 2>&1; then
    prompt CREATE_REPO "Create a new private repo now via gh? [y/N]: "
  else
    say "(gh found, but not authenticated. Run: gh auth login)"
    CREATE_REPO="n"
  fi
else
  say "(gh not found. We'll print browser instructions instead.)"
  CREATE_REPO="n"
fi

REPO_URL="$REPO_URL_PRESET"
REPO_SSH_URL="$REPO_SSH_URL_PRESET"

case "$(lc "${CREATE_REPO:-}")" in
  y|yes|1|true)
    if [ "$NON_INTERACTIVE" = true ]; then
      die "Non-interactive + create-repo is not supported yet. Set CLAWBOARD_BACKUP_REPO_URL or pass --repo-url."
    fi
    prompt REPO_OWNER "Repo owner (user or org): "
    prompt REPO_NAME "Repo name [default: openclaw-memories-backup]: "
    REPO_NAME="${REPO_NAME:-openclaw-memories-backup}"

    say "Creating private repo: $REPO_OWNER/$REPO_NAME"
    gh repo create "$REPO_OWNER/$REPO_NAME" --private --confirm >/dev/null

    REPO_URL="https://github.com/$REPO_OWNER/$REPO_NAME.git"
    REPO_SSH_URL="git@github.com:$REPO_OWNER/$REPO_NAME.git"

    say "Created: $REPO_URL"
    ;;
  *)
    say "Create a *private* GitHub repo for backups (do this in your browser)."
    say "  - Repo name suggestion: openclaw-memories-backup"
    say "  - Keep it private"
    say "  - You can leave it empty (no README needed)"
    say ""
    prompt REPO_URL "Paste the repo HTTPS URL (like https://github.com/OWNER/REPO or .../REPO.git): "
    if [[ -z "$REPO_URL" && "$NON_INTERACTIVE" = true ]]; then
      die "Non-interactive mode requires CLAWBOARD_BACKUP_REPO_URL (or --repo-url)."
    fi
    # Accept with or without .git suffix
    [[ "$REPO_URL" =~ ^https://github.com/[^/]+/[^/]+\.git$ ]] || [[ "$REPO_URL" =~ ^https://github.com/[^/]+/[^/]+$ ]] || die "Repo URL must look like: https://github.com/OWNER/REPO or https://github.com/OWNER/REPO.git"
    REPO_URL="${REPO_URL%.git}"
    REPO_URL="${REPO_URL}.git"
    if [[ -z "$REPO_SSH_URL" ]]; then
      REPO_SSH_URL="${REPO_URL/https:\/\/github.com\//git@github.com:}"
    fi
    ;;
esac

# Normalize GitHub HTTPS URL to end with .git (for preset or env URL that omitted it)
if [[ "$REPO_URL" =~ ^https://github.com/[^/]+/[^/]+$ ]]; then
  REPO_URL="${REPO_URL}.git"
fi
if [[ -z "$REPO_SSH_URL" && "$REPO_URL" =~ ^https://github.com/ ]]; then
  REPO_SSH_URL="${REPO_URL/https:\/\/github.com\//git@github.com:}"
fi

say ""
say "Step 2: Auth method"
say "Recommended: GitHub Deploy Key (SSH)."
say " - You must enable *Allow write access* when adding the key (reminder: otherwise pushes will fail)."

AUTH_METHOD="${AUTH_METHOD_PRESET:-}"
if [[ -z "$AUTH_METHOD" ]]; then
  prompt AUTH_METHOD "Use Deploy Key (SSH) instead of PAT? [Y/n]: "
fi
case "$(lc "${AUTH_METHOD:-}")" in
  n|no|pat) AUTH_METHOD="pat" ;;
  y|yes|ssh|"") AUTH_METHOD="ssh" ;;
  *)
    if [ "$NON_INTERACTIVE" = true ]; then
      die "Invalid auth method for non-interactive mode: $AUTH_METHOD (use ssh or pat)"
    fi
    AUTH_METHOD="ssh"
    ;;
esac

GITHUB_USER="$GITHUB_USER_PRESET"
GITHUB_PAT="$GITHUB_PAT_PRESET"
DEPLOY_KEY_PATH="$DEPLOY_KEY_PATH_PRESET"
DEPLOY_PUB_PATH=""

if [[ "$AUTH_METHOD" == "pat" ]]; then
  say ""
  say "PAT mode (legacy)"
  say "Create a fine-grained PAT (GitHub Settings → Developer settings → Fine-grained tokens)."
  say "  - Resource owner: your account/org"
  say "  - Repository access: ONLY the backup repo"
  say "  - Permissions: Contents = Read and write"
  say ""
  prompt GITHUB_USER "GitHub username (used for HTTPS auth): "
  prompt GITHUB_PAT "Paste the fine-grained PAT (input hidden): " 1
  if [[ "$NON_INTERACTIVE" == true && ( -z "$GITHUB_USER" || -z "$GITHUB_PAT" ) ]]; then
    die "Non-interactive pat mode requires both CLAWBOARD_BACKUP_GITHUB_USER and CLAWBOARD_BACKUP_GITHUB_PAT."
  fi
else
  say ""
  say "Deploy key (SSH) mode"
  say "We'll generate a dedicated SSH keypair and then you add the *public* key as a Deploy Key on the repo."

  DEFAULT_KEY_PATH="$OPENCLAW_DIR/credentials/clawboard-memory-backup-deploy-key"
  prompt DEPLOY_KEY_PATH "Deploy key path [default: $DEFAULT_KEY_PATH]: "
  DEPLOY_KEY_PATH="${DEPLOY_KEY_PATH:-$DEFAULT_KEY_PATH}"
  DEPLOY_PUB_PATH="$DEPLOY_KEY_PATH.pub"

  mkdir -p "$(dirname "$DEPLOY_KEY_PATH")"

  if [[ -f "$DEPLOY_KEY_PATH" && -f "$DEPLOY_PUB_PATH" ]]; then
    prompt REUSE_KEY "Key already exists at $DEPLOY_KEY_PATH. Reuse it? [Y/n]: "
    REUSE_KEY="${REUSE_KEY:-Y}"
    case "$(lc "${REUSE_KEY:-}")" in
      y|yes)
        say "Reusing existing deploy key."
        ;;
      *)
        prompt OVERWRITE "Overwrite existing keypair at $DEPLOY_KEY_PATH? [y/N]: "
        case "$(lc "${OVERWRITE:-}")" in
          y|yes)
            rm -f "$DEPLOY_KEY_PATH" "$DEPLOY_PUB_PATH"
            ssh-keygen -t ed25519 -C "clawboard-memory-backup" -f "$DEPLOY_KEY_PATH" -N "" >/dev/null
            chmod 600 "$DEPLOY_KEY_PATH"
            chmod 644 "$DEPLOY_PUB_PATH"
            ;;
          *)
            say "Keeping existing keypair (no changes)."
            ;;
        esac
        ;;
    esac
  else
    ssh-keygen -t ed25519 -C "clawboard-memory-backup" -f "$DEPLOY_KEY_PATH" -N "" >/dev/null
    chmod 600 "$DEPLOY_KEY_PATH"
    chmod 644 "$DEPLOY_PUB_PATH"
  fi

  say ""
  say "Deploy Key reminder (GitHub):"
  say "  Repo → Settings → Deploy keys → Add deploy key"
  say "  Title: clawboard-memory-backup"
  say "  Key: (paste the PUBLIC key below)"
  say "  IMPORTANT: check 'Allow write access' so backups can push."
  say ""
  cat "$DEPLOY_PUB_PATH"
  say ""
  prompt CONFIRM_DEPLOY_KEY "Press Enter once you've added the key (or Ctrl+C to abort): "
fi

say ""
say "Step 3: Choose what to back up (Option B buckets)."
INCLUDE_OPENCLAW_CONFIG="$INCLUDE_OPENCLAW_CONFIG_PRESET"
INCLUDE_OPENCLAW_SKILLS="$INCLUDE_OPENCLAW_SKILLS_PRESET"
prompt INCLUDE_OPENCLAW_CONFIG "Include ~/.openclaw/openclaw.json* ? [Y/n]: "
prompt INCLUDE_OPENCLAW_SKILLS "Include ~/.openclaw/skills/ ? [Y/n]: "

# defaults
case "$(lc "${INCLUDE_OPENCLAW_CONFIG:-}")" in n|no) INCLUDE_OPENCLAW_CONFIG=false ;; *) INCLUDE_OPENCLAW_CONFIG=true ;; esac
case "$(lc "${INCLUDE_OPENCLAW_SKILLS:-}")" in n|no) INCLUDE_OPENCLAW_SKILLS=false ;; *) INCLUDE_OPENCLAW_SKILLS=true ;; esac

say ""
say "Step 4: Clawboard state backup"
say "Recommended: include full Clawboard state export (config/topics/tasks/logs)."
INCLUDE_CLAWBOARD_STATE="$INCLUDE_CLAWBOARD_STATE_PRESET"
prompt INCLUDE_CLAWBOARD_STATE "Include Clawboard state export? [Y/n]: "
case "$(lc "${INCLUDE_CLAWBOARD_STATE:-}")" in
  n|no)
    INCLUDE_CLAWBOARD_STATE=false
    CLAWBOARD_DIR=""
    CLAWBOARD_API_URL=""
    INCLUDE_CLAWBOARD_ATTACHMENTS=false
    INCLUDE_CLAWBOARD_ENV=false
    CLAWBOARD_BACKUP_TOKEN=""
    ;;
  *)
    INCLUDE_CLAWBOARD_STATE=true
    CLAWBOARD_DIR="$CLAWBOARD_DIR_PRESET"
    DETECTED_CLAWBOARD_DIR="$(detect_clawboard_dir || true)"
    if [[ -n "$DETECTED_CLAWBOARD_DIR" ]]; then
      prompt CLAWBOARD_DIR "Clawboard install path [default: $DETECTED_CLAWBOARD_DIR]: "
      CLAWBOARD_DIR="${CLAWBOARD_DIR:-$DETECTED_CLAWBOARD_DIR}"
    else
      prompt CLAWBOARD_DIR "Clawboard install path (contains deploy.sh): "
    fi
    [[ -d "$CLAWBOARD_DIR" ]] || die "Clawboard path does not exist: $CLAWBOARD_DIR"
    [[ -f "$CLAWBOARD_DIR/deploy.sh" ]] || die "Clawboard path does not look valid (missing deploy.sh): $CLAWBOARD_DIR"

    DEFAULT_CLAWBOARD_API_URL="http://localhost:8010"
    if [[ -f "$CLAWBOARD_DIR/.env" ]]; then
      DEFAULT_CLAWBOARD_API_URL="$(read_env_value "$CLAWBOARD_DIR/.env" "CLAWBOARD_PUBLIC_API_BASE" || true)"
      if [[ -z "$DEFAULT_CLAWBOARD_API_URL" ]]; then
        DEFAULT_CLAWBOARD_API_URL="http://localhost:8010"
      fi
    fi
    CLAWBOARD_API_URL="$CLAWBOARD_API_URL_PRESET"
    prompt CLAWBOARD_API_URL "Clawboard API base URL [default: $DEFAULT_CLAWBOARD_API_URL]: "
    CLAWBOARD_API_URL="${CLAWBOARD_API_URL:-$DEFAULT_CLAWBOARD_API_URL}"

    INCLUDE_CLAWBOARD_ATTACHMENTS="$INCLUDE_CLAWBOARD_ATTACHMENTS_PRESET"
    INCLUDE_CLAWBOARD_ENV="$INCLUDE_CLAWBOARD_ENV_PRESET"
    CLAWBOARD_BACKUP_TOKEN="$CLAWBOARD_BACKUP_TOKEN_PRESET"
    prompt INCLUDE_CLAWBOARD_ATTACHMENTS "Include Clawboard attachment files? [Y/n]: "
    prompt INCLUDE_CLAWBOARD_ENV "Include Clawboard .env (contains secrets)? [y/N]: "
    prompt CLAWBOARD_BACKUP_TOKEN "Optional Clawboard token override (hidden, blank=read CLAWBOARD_TOKEN from .env): " 1

    case "$(lc "${INCLUDE_CLAWBOARD_ATTACHMENTS:-}")" in n|no) INCLUDE_CLAWBOARD_ATTACHMENTS=false ;; *) INCLUDE_CLAWBOARD_ATTACHMENTS=true ;; esac
    case "$(lc "${INCLUDE_CLAWBOARD_ENV:-}")" in y|yes) INCLUDE_CLAWBOARD_ENV=true ;; *) INCLUDE_CLAWBOARD_ENV=false ;; esac
    ;;
esac

say ""
BACKUP_DIR="$BACKUP_DIR_PRESET"
prompt BACKUP_DIR "Local backup repo directory [default: $OPENCLAW_DIR/memory-backup-repo]: "
BACKUP_DIR="${BACKUP_DIR:-$OPENCLAW_DIR/memory-backup-repo}"

REMOTE_NAME="origin"
BRANCH="main"

# Write env file for future use (esp. SSH key path)
# NOTE: This stores only the *path* to the private key, not the key material.
cat >"$CRED_ENV" <<ENV
# Clawboard memory backup auth/env
# This file is sourced by backup_openclaw_curated_memories.sh (set -a)

AUTH_METHOD="$AUTH_METHOD"
REPO_URL="$REPO_URL"
REPO_SSH_URL="$REPO_SSH_URL"
DEPLOY_KEY_PATH="${DEPLOY_KEY_PATH:-}"
GITHUB_USER="$GITHUB_USER"
GITHUB_PAT="$GITHUB_PAT"
CLAWBOARD_BACKUP_DIR="${CLAWBOARD_DIR}"
CLAWBOARD_BACKUP_API_URL="${CLAWBOARD_API_URL}"
CLAWBOARD_BACKUP_TOKEN="${CLAWBOARD_BACKUP_TOKEN:-}"
ENV
chmod 600 "$CRED_ENV"

# Write JSON config (0600)
cat >"$CRED_JSON" <<JSON
{
  "workspacePath": "${WORKSPACE_PATH}",
  "workspacePaths": ${WORKSPACE_PATHS_JSON},
  "qmdPaths": ${QMD_PATHS_JSON},
  "backupDir": "${BACKUP_DIR}",
  "repoUrl": "${REPO_URL}",
  "repoSshUrl": "${REPO_SSH_URL}",
  "authMethod": "${AUTH_METHOD}",
  "deployKeyPath": "${DEPLOY_KEY_PATH}",
  "githubUser": "${GITHUB_USER}",
  "githubPat": "${GITHUB_PAT}",
  "remoteName": "${REMOTE_NAME}",
  "branch": "${BRANCH}",
  "includeOpenclawConfig": ${INCLUDE_OPENCLAW_CONFIG},
  "includeOpenclawSkills": ${INCLUDE_OPENCLAW_SKILLS},
  "includeClawboardState": ${INCLUDE_CLAWBOARD_STATE},
  "clawboardDir": "${CLAWBOARD_DIR}",
  "clawboardApiUrl": "${CLAWBOARD_API_URL}",
  "includeClawboardAttachments": ${INCLUDE_CLAWBOARD_ATTACHMENTS},
  "includeClawboardEnv": ${INCLUDE_CLAWBOARD_ENV}
}
JSON

chmod 600 "$CRED_JSON"

say "Wrote config: $CRED_JSON"
say "Wrote env:    $CRED_ENV"

say ""
if [[ -z "$RUN_BACKUP_NOW" ]]; then
  if [ "$NON_INTERACTIVE" = true ]; then
    RUN_BACKUP_NOW="N"
  else
    RUN_BACKUP_NOW="Y"
  fi
fi
case "$(lc "${RUN_BACKUP_NOW:-}")" in
  y|yes)
    say "Running one backup now to validate..."
    "$(cd "$(dirname "$0")" && pwd)/backup_openclaw_curated_memories.sh"
    ;;
  *)
    say "Skipping immediate backup validation run."
    ;;
esac

say ""
say "Optional: install an OpenClaw cron job to run every 15 minutes."
say "If you say yes, we will create a Gateway cron job (isolated agent turn) that runs the backup script."

INSTALL_CRON="$INSTALL_CRON_PRESET"
if [[ -z "$INSTALL_CRON" && "$NON_INTERACTIVE" = true ]]; then
  INSTALL_CRON="N"
fi
prompt INSTALL_CRON "Install OpenClaw cron (every 15m)? [Y/n]: "
# default: yes
INSTALL_CRON="${INSTALL_CRON:-Y}"
case "$(lc "${INSTALL_CRON:-}")" in
  y|yes)
    need_cmd openclaw
    say ""
    say "Creating cron job via OpenClaw CLI..."

    JOB_NAME="Clawboard: backup continuity + state"
    JOB_EVERY="15m"
    JOB_SESSION="isolated"
    JOB_MESSAGE="Run the continuity + Clawboard state backup now (automated 15-minute backup). Execute: $HOME/.openclaw/skills/clawboard/scripts/backup_openclaw_curated_memories.sh . IMPORTANT: Only notify me if (a) there were changes pushed, or (b) the backup failed. If there were no changes and the script exited 0 without output, respond with NO_REPLY."

    # Retry cron install when gateway is flaky (e.g. gateway closed 1006). Re-attempt after doctor --fix.
    CRON_MAX_ATTEMPTS=3
    CRON_RETRY_DELAY=5
    cron_ok=0
    attempt=1
    while [[ "$attempt" -le "$CRON_MAX_ATTEMPTS" ]]; do
      existing_id=""
      cron_stderr=""
      if openclaw cron list --json 2>"${TMPDIR:-/tmp}/cron_list_stderr.$$" >/dev/null; then
        existing_id="$(
          openclaw cron list --json 2>/dev/null | python3 -c '
import json
import sys

data = json.load(sys.stdin)
jobs = data.get("jobs") if isinstance(data, dict) else []
jobs = jobs or []

name = "Clawboard: backup continuity + state"
needle = "backup_openclaw_curated_memories.sh"

cands = [
  j
  for j in jobs
  if isinstance(j, dict)
  and str(j.get("sessionTarget") or "").strip() == "isolated"
  and (
    str(j.get("name") or "") == name
    or needle in str(((j.get("payload") if isinstance(j.get("payload"), dict) else {}) or {}).get("message") or "")
  )
]

print((cands[0].get("id") or cands[0].get("jobId") or "") if cands else "", end="")
' 2>/dev/null || true
        )"
      else
        cron_stderr="$(cat "${TMPDIR:-/tmp}/cron_list_stderr.$$" 2>/dev/null || true)"
      fi

      if [[ -n "$existing_id" ]]; then
        say "Found existing cron job ($existing_id). Updating it... (attempt $attempt/$CRON_MAX_ATTEMPTS)"
        if openclaw cron edit "$existing_id" \
          --name "$JOB_NAME" \
          --every "$JOB_EVERY" \
          --session "$JOB_SESSION" \
          --no-deliver \
          --message "$JOB_MESSAGE" \
          --enable 2>"${TMPDIR:-/tmp}/cron_edit_stderr.$$"; then
          cron_ok=1
          break
        fi
        cron_stderr="$(cat "${TMPDIR:-/tmp}/cron_edit_stderr.$$" 2>/dev/null || true)"
      else
        say "No existing cron job found. Creating it... (attempt $attempt/$CRON_MAX_ATTEMPTS)"
        if openclaw cron add \
          --name "$JOB_NAME" \
          --every "$JOB_EVERY" \
          --session "$JOB_SESSION" \
          --no-deliver \
          --message "$JOB_MESSAGE" 2>"${TMPDIR:-/tmp}/cron_add_stderr.$$"; then
          cron_ok=1
          break
        fi
        cron_stderr="$(cat "${TMPDIR:-/tmp}/cron_add_stderr.$$" 2>/dev/null || true)"
      fi

      if [[ "$attempt" -lt "$CRON_MAX_ATTEMPTS" ]]; then
        if echo "$cron_stderr" | grep -qE 'gateway closed|1006|connection refused|timeout'; then
          say "Gateway may be unstable. Running openclaw doctor --fix and retrying in ${CRON_RETRY_DELAY}s..."
          openclaw doctor --fix 2>/dev/null || true
        fi
        sleep "$CRON_RETRY_DELAY"
      fi
      attempt=$((attempt + 1))
    done

    if [[ "$cron_ok" -ne 1 ]]; then
      say "If cron setup failed, create it manually with these settings:"
      say "  name: $JOB_NAME"
      say "  schedule: every $JOB_EVERY"
      say "  session: $JOB_SESSION"
      say "  delivery: none"
      say "  message: $JOB_MESSAGE"
      say "You can also run: openclaw doctor --fix then re-run this script to retry cron install."
    else
      say "Cron job installed/updated successfully."
    fi
    ;;
  *)
    say "Skipped cron install. You can run this script anytime to push updates."
    ;;
esac

say "Done."
