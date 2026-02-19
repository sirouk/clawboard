#!/usr/bin/env bash
set -euo pipefail

# apply_directives_to_agents.sh
#
# Interactive helper to append directive markdown files into each discovered
# agent workspace AGENTS.md, idempotently.
#
# Behavior:
# 1) Process directives/all/*.md first.
# 2) Process directives/<folder>/*.md for all folders except "all".
# 3) For every directive, prompt per discovered agent workspace.
# 4) Append directive block once (marker-based idempotency).
#
# Usage:
#   bash scripts/apply_directives_to_agents.sh
#   bash scripts/apply_directives_to_agents.sh --yes --dry-run

USE_COLOR=true
AUTO_YES=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --no-color) USE_COLOR=false ;;
    --yes) AUTO_YES=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      cat <<'USAGE'
Usage: apply_directives_to_agents.sh [options]

Options:
  --yes       Auto-approve all prompts.
  --dry-run   Show what would change, but do not write files.
  --no-color  Disable ANSI colors.
  -h, --help  Show this help.
USAGE
      exit 0
      ;;
    *)
      echo "error: Unknown option: $arg" >&2
      exit 2
      ;;
  esac
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

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIRECTIVES_DIR="$REPO_DIR/directives"

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
if [ "$OPENCLAW_HOME" != "/" ]; then
  OPENCLAW_HOME="${OPENCLAW_HOME%/}"
fi
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_HOME/openclaw.json}"

need_cmd python3
[ -d "$DIRECTIVES_DIR" ] || die "Directives directory not found: $DIRECTIVES_DIR"
[ -f "$OPENCLAW_CONFIG_PATH" ] || die "OpenClaw config not found: $OPENCLAW_CONFIG_PATH"

declare -a AGENT_IDS=()
declare -a AGENT_NAMES=()
declare -a AGENT_WORKSPACES=()

discover_agents() {
  local rows
  rows="$(
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

agents = [entry for entry in ((cfg.get("agents") or {}).get("list") or []) if isinstance(entry, dict)]
indexed = list(enumerate(agents))
defaults = [pair for pair in indexed if pair[1].get("default") is True]
default_index, default_entry = defaults[0] if defaults else (indexed[0] if indexed else (-1, {}))
default_agent_id = normalize_agent_id(default_entry.get("id") if isinstance(default_entry, dict) else "main")
default_name = (
    default_entry.get("name")
    if isinstance(default_entry, dict) and isinstance(default_entry.get("name"), str) and default_entry.get("name").strip()
    else "Main Agent"
)

main_entries = [entry for entry in agents if normalize_agent_id(entry.get("id")) == "main"]
main_entry = main_entries[0] if main_entries else default_entry
main_workspace = (
    main_entry.get("workspace")
    if isinstance(main_entry, dict) and isinstance(main_entry.get("workspace"), str) and main_entry.get("workspace").strip()
    else defaults_workspace
)
main_workspace = normalize_path(main_workspace) or defaults_workspace
if main_workspace == openclaw_home:
    main_workspace = fallback_workspace

seen = set()
rows = []
for entry in agents:
    agent_id = normalize_agent_id(entry.get("id"))
    if agent_id in seen:
        continue
    name = entry.get("name") if isinstance(entry.get("name"), str) and entry.get("name").strip() else agent_id
    workspace = entry.get("workspace") if isinstance(entry.get("workspace"), str) and entry.get("workspace").strip() else defaults_workspace
    workspace = normalize_path(workspace) or defaults_workspace
    if workspace == openclaw_home:
        workspace = fallback_workspace
    if agent_id == "main":
        workspace = main_workspace
    rows.append((agent_id, name, workspace))
    seen.add(agent_id)

if "main" not in seen:
    rows.insert(0, ("main", default_name, main_workspace))

for agent_id, name, workspace in rows:
    print("\t".join([agent_id, str(name), workspace]))
PY
  )" || die "Failed to discover agents from $OPENCLAW_CONFIG_PATH"

  AGENT_IDS=()
  AGENT_NAMES=()
  AGENT_WORKSPACES=()
  while IFS=$'\t' read -r agent_id agent_name workspace; do
    [ -n "${agent_id:-}" ] || continue
    [ -n "${workspace:-}" ] || continue
    AGENT_IDS+=("$agent_id")
    AGENT_NAMES+=("${agent_name:-$agent_id}")
    AGENT_WORKSPACES+=("$workspace")
  done <<< "$rows"

  [ "${#AGENT_IDS[@]}" -gt 0 ] || die "No agents discovered."
}

declare -a ALL_DIRECTIVES=()
declare -a SCOPED_DIRECTIVES=()

discover_directives() {
  ALL_DIRECTIVES=()
  SCOPED_DIRECTIVES=()

  while IFS= read -r path; do
    [ -n "${path:-}" ] || continue
    ALL_DIRECTIVES+=("$path")
  done < <(find "$DIRECTIVES_DIR/all" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort)

  while IFS= read -r path; do
    [ -n "${path:-}" ] || continue
    SCOPED_DIRECTIVES+=("$path")
  done < <(find "$DIRECTIVES_DIR" -mindepth 2 -type f -name '*.md' ! -path "$DIRECTIVES_DIR/all/*" 2>/dev/null | sort)
}

prompt_yes_no_quit() {
  local question="$1"
  local answer

  if [ "$AUTO_YES" = true ]; then
    return 0
  fi

  while true; do
    read -r -p "$question [y/N/q]: " answer
    case "$(printf "%s" "${answer:-}" | tr '[:upper:]' '[:lower:]')" in
      y|yes) return 0 ;;
      ""|n|no) return 1 ;;
      q|quit) return 2 ;;
      *) echo "Please answer y, n, or q." ;;
    esac
  done
}

append_directive_block() {
  local agents_file="$1"
  local directive_file="$2"
  local directive_rel="$3"
  local mode="$4"

  python3 - "$agents_file" "$directive_file" "$directive_rel" "$mode" <<'PY'
import os
import sys

agents_file = sys.argv[1]
directive_file = sys.argv[2]
directive_rel = sys.argv[3]
mode = sys.argv[4]

start_marker = f"<!-- CLAWBOARD_DIRECTIVE:START {directive_rel} -->"
end_marker = f"<!-- CLAWBOARD_DIRECTIVE:END {directive_rel} -->"

existing = ""
if os.path.exists(agents_file):
    with open(agents_file, "r", encoding="utf-8") as f:
        existing = f.read()

if start_marker in existing:
    print("exists")
    sys.exit(0)

if mode == "dry-run":
    print("would-append")
    sys.exit(0)

with open(directive_file, "r", encoding="utf-8") as f:
    directive_content = f.read().rstrip("\n")

os.makedirs(os.path.dirname(agents_file), exist_ok=True)
with open(agents_file, "a", encoding="utf-8") as f:
    if existing and not existing.endswith("\n"):
        f.write("\n")
    f.write("\n")
    f.write(start_marker + "\n")
    f.write("<!-- Source: clawboard/directives/" + directive_rel + " -->\n\n")
    f.write(directive_content + "\n\n")
    f.write(end_marker + "\n")

print("appended")
PY
}

process_directive_file() {
  local directive_file="$1"
  local directive_rel="$2"
  local scope_label="$3"
  local directive_name
  directive_name="$(basename "$directive_file")"

  local idx agent_id agent_name workspace agents_file decision rc status
  idx=0
  while [ "$idx" -lt "${#AGENT_IDS[@]}" ]; do
    agent_id="${AGENT_IDS[$idx]}"
    agent_name="${AGENT_NAMES[$idx]}"
    workspace="${AGENT_WORKSPACES[$idx]}"
    agents_file="$workspace/AGENTS.md"

    decision="Apply [$scope_label] $directive_name to agent '$agent_name' ($agent_id)?"
    set +e
    prompt_yes_no_quit "$decision"
    rc=$?
    set -e

    if [ "$rc" -eq 2 ]; then
      return 2
    fi
    if [ "$rc" -ne 0 ]; then
      DECLINED_COUNT=$((DECLINED_COUNT + 1))
      idx=$((idx + 1))
      continue
    fi

    if [ "$DRY_RUN" = true ]; then
      status="$(append_directive_block "$agents_file" "$directive_file" "$directive_rel" "dry-run")"
    else
      status="$(append_directive_block "$agents_file" "$directive_file" "$directive_rel" "write")"
    fi

    case "$status" in
      appended)
        APPLIED_COUNT=$((APPLIED_COUNT + 1))
        log_success "Applied $directive_rel -> $agents_file"
        ;;
      exists)
        EXISTS_COUNT=$((EXISTS_COUNT + 1))
        log_info "Already present, skipping: $directive_rel -> $agents_file"
        ;;
      would-append)
        APPLIED_COUNT=$((APPLIED_COUNT + 1))
        log_info "(dry-run) Would append $directive_rel -> $agents_file"
        ;;
      *)
        ERROR_COUNT=$((ERROR_COUNT + 1))
        log_warn "Unexpected status '$status' for $directive_rel -> $agents_file"
        ;;
    esac

    idx=$((idx + 1))
  done

  return 0
}

APPLIED_COUNT=0
EXISTS_COUNT=0
DECLINED_COUNT=0
ERROR_COUNT=0
TEAM_ROSTER_STATUS="not-run"

upsert_main_team_roster_section() {
  local idx main_workspace main_agents_file
  local mode auto_yes_int status
  main_workspace=""

  idx=0
  while [ "$idx" -lt "${#AGENT_IDS[@]}" ]; do
    if [ "${AGENT_IDS[$idx]}" = "main" ]; then
      main_workspace="${AGENT_WORKSPACES[$idx]}"
      break
    fi
    idx=$((idx + 1))
  done

  if [ -z "$main_workspace" ] && [ "${#AGENT_WORKSPACES[@]}" -gt 0 ]; then
    main_workspace="${AGENT_WORKSPACES[0]}"
  fi
  if [ -z "$main_workspace" ]; then
    TEAM_ROSTER_STATUS="missing-main-workspace"
    log_warn "Could not resolve main workspace for team roster section."
    return 0
  fi

  main_agents_file="$main_workspace/AGENTS.md"
  mkdir -p "$main_workspace"
  if [ ! -f "$main_agents_file" ] && [ "$DRY_RUN" = false ]; then
    : > "$main_agents_file"
  fi

  mode="write"
  if [ "$DRY_RUN" = true ]; then
    mode="dry-run"
  fi

  auto_yes_int=0
  if [ "$AUTO_YES" = true ]; then
    auto_yes_int=1
  fi

  local status_output_file
  status_output_file="$(mktemp -t clawboard-team-roster.XXXXXX)"
  python3 - "$OPENCLAW_CONFIG_PATH" "$main_agents_file" "$mode" "$auto_yes_int" "$status_output_file" <<'PY'
import json
import os
import re
import sys
from pathlib import Path

config_path = sys.argv[1]
main_agents_path = os.path.abspath(os.path.expanduser(sys.argv[2]))
mode = sys.argv[3]
auto_yes = sys.argv[4] == "1"
status_path = sys.argv[5]

start_marker = "<!-- CLAWBOARD_TEAM_ROSTER:START -->"
end_marker = "<!-- CLAWBOARD_TEAM_ROSTER:END -->"
meta_prefix = "<!-- CLAWBOARD_TEAM_ROSTER_META:"
meta_suffix = "-->"


def set_status(value: str) -> None:
    try:
        Path(status_path).write_text(str(value).strip() + "\n", encoding="utf-8")
    except Exception:
        pass


def read_text(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8")
    except Exception:
        return ""


def parse_identity(identity_text: str) -> dict:
    out = {}
    for line in identity_text.splitlines():
        m = re.match(r"^\s*-\s*\*\*(.+?)\*\*:\s*(.*)\s*$", line)
        if not m:
            continue
        key = m.group(1).strip().lower()
        value = m.group(2).strip()
        out[key] = value
    return out


def first_heading(text: str) -> str:
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#"):
            return s.lstrip("#").strip()
    return ""


def first_paragraph(text: str, skip_heading: bool = True) -> str:
    lines = text.splitlines()
    buf = []
    seen_non_heading = False
    for raw in lines:
        s = raw.strip()
        if not s:
            if buf:
                break
            continue
        if s.startswith("<!--"):
            if buf:
                break
            continue
        if skip_heading and s.startswith("#") and not seen_non_heading:
            continue
        seen_non_heading = True
        if s.startswith("```"):
            if buf:
                break
            continue
        buf.append(s)
        if len(" ".join(buf)) >= 220:
            break
    return " ".join(buf).strip()


def compact(value: str, limit: int = 260) -> str:
    s = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(s) <= limit:
        return s
    return s[: limit - 1].rstrip() + "…"


def normalize_profile_entry(value) -> dict:
    out = {}
    if isinstance(value, str):
        desc = compact(value, 400)
        if desc:
            out["description"] = desc
        return out
    if not isinstance(value, dict):
        return out

    key_map = {
        "heading": "heading",
        "title": "heading",
        "summary": "summary",
        "agentsSummary": "summary",
        "soulSummary": "soulSummary",
        "description": "description",
        "teamDescription": "description",
    }
    for src_key, dst_key in key_map.items():
        raw = value.get(src_key)
        if not isinstance(raw, str):
            continue
        normalized = compact(raw, 400)
        if normalized:
            out[dst_key] = normalized
    return out


def normalize_bool(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        raw = value.strip().lower()
        if raw in {"1", "true", "yes", "y", "on", "enabled"}:
            return True
        if raw in {"0", "false", "no", "n", "off", "disabled"}:
            return False
    return bool(default)


def normalize_main_directives(value) -> dict:
    out = {
        "forbidMainDoingSubagentJobs": False,
        "preferHuddleMode": False,
    }
    if not isinstance(value, dict):
        return out
    out["forbidMainDoingSubagentJobs"] = normalize_bool(
        value.get("forbidMainDoingSubagentJobs"),
        out["forbidMainDoingSubagentJobs"],
    )
    out["preferHuddleMode"] = normalize_bool(
        value.get("preferHuddleMode"),
        out["preferHuddleMode"],
    )
    return out


def parse_existing_meta(existing_doc: str):
    profiles = {}
    directives = {
        "forbidMainDoingSubagentJobs": False,
        "preferHuddleMode": False,
    }
    start_idx = existing_doc.find(start_marker)
    if start_idx == -1:
        return profiles, directives
    end_idx = existing_doc.find(end_marker, start_idx + len(start_marker))
    if end_idx == -1:
        return profiles, directives
    section = existing_doc[start_idx:end_idx + len(end_marker)]
    m = re.search(
        r"<!--\s*CLAWBOARD_TEAM_ROSTER_META:\s*(.*?)\s*-->",
        section,
        flags=re.DOTALL,
    )
    if not m:
        return profiles, directives
    raw_json = m.group(1).strip()
    try:
        parsed = json.loads(raw_json)
    except Exception:
        return profiles, directives

    if not isinstance(parsed, dict):
        return profiles, directives

    source_profiles = None
    source_directives = None

    if isinstance(parsed.get("agentProfiles"), dict):
        source_profiles = parsed.get("agentProfiles")
        source_directives = parsed.get("mainDirectives")
    else:
        source_profiles = {
            k: v
            for k, v in parsed.items()
            if isinstance(k, str) and not k.startswith("__")
        }
        source_directives = parsed.get("__mainDirectives")

    if isinstance(source_profiles, dict):
        for k, v in source_profiles.items():
            if not isinstance(k, str):
                continue
            entry = normalize_profile_entry(v)
            if entry:
                profiles[k] = entry

    directives = normalize_main_directives(source_directives)

    return profiles, directives


def resolve_agents(config: dict) -> list:
    agents = [a for a in ((config.get("agents") or {}).get("list") or []) if isinstance(a, dict)]
    if not agents:
        return []
    rows = []
    seen = set()
    for entry in agents:
        aid = str(entry.get("id") or "").strip() or "main"
        if aid in seen:
            continue
        seen.add(aid)
        rows.append(
            {
                "id": aid,
                "name": str(entry.get("name") or aid).strip() or aid,
                "workspace": str(entry.get("workspace") or "").strip(),
                "model": str(entry.get("model") or "").strip(),
                "toolsProfile": str(((entry.get("tools") or {}).get("profile") or "")).strip(),
                "subagentAllowAgents": list(((entry.get("subagents") or {}).get("allowAgents") or [])),
            }
        )
    return rows


def choose_main_agent(rows: list) -> dict:
    for row in rows:
        if str(row.get("id") or "").strip().lower() == "main":
            return row
    return rows[0] if rows else {}


cfg = {}
try:
    with open(config_path, "r", encoding="utf-8") as f:
        parsed = json.load(f)
        if isinstance(parsed, dict):
            cfg = parsed
except Exception:
    cfg = {}

all_agents = resolve_agents(cfg)
if not all_agents:
    set_status("no-agents")
    sys.exit(0)

main_agent = choose_main_agent(all_agents)
main_agent_id = str(main_agent.get("id") or "main")
main_allow = set()
for entry in (main_agent.get("subagentAllowAgents") or []):
    if isinstance(entry, str) and entry.strip():
        main_allow.add(entry.strip())

subagents = []
for row in all_agents:
    if str(row.get("id") or "") == main_agent_id:
        continue
    subagents.append(row)

main_doc = read_text(main_agents_path)
existing_profiles, existing_main_directives = parse_existing_meta(main_doc)
updated_profiles = {k: dict(v) for k, v in existing_profiles.items()}
updated_main_directives = dict(existing_main_directives)

tty_in = None
tty_out = None
interactive = False
if not auto_yes:
    try:
        # On macOS, opening /dev/tty with r+ can fail for non-seekable streams.
        tty_in = open("/dev/tty", "r", encoding="utf-8", errors="replace")
        tty_out = open("/dev/tty", "w", encoding="utf-8", errors="replace")
        interactive = True
    except Exception:
        tty_in = None
        tty_out = None
        interactive = sys.stdin.isatty()

print("")
print("Team roster routine: collecting non-main agent details for main AGENTS.md")
if not subagents:
    print("No non-main agents discovered in config; section will note this.")
elif (not interactive) and (not auto_yes):
    print("No interactive terminal detected for team fields; keeping existing fields.")


def ask_toggle(field_label: str, explain: str, current: bool):
    if not interactive:
        return ("keep", current)

    default_yes = bool(current)
    lines = [f"  {field_label}: {explain}"]
    lines.append(f"  current: {'enabled' if current else 'disabled'}")
    lines.append(f"  {field_label} [ {'Y/n' if default_yes else 'y/N'} / q=quit ]: ")

    response = ""
    if tty_in is not None and tty_out is not None:
        try:
            tty_out.write("\n".join(lines))
            tty_out.flush()
            response = (tty_in.readline() or "").strip()
        except Exception:
            response = ""
    else:
        for line in lines[:-1]:
            print(line)
        try:
            response = input(lines[-1]).strip()
        except EOFError:
            response = ""

    lowered = response.lower()
    if lowered in {"q", "quit"}:
        return ("quit", current)
    if lowered in {"", "y", "yes"}:
        return ("set", True if lowered != "" else default_yes)
    if lowered in {"n", "no"}:
        return ("set", False)
    return ("keep", current)


def ask_field(field_label: str, explain: str, current: str, suggestion: str = ""):
    if not interactive:
        return ("keep", current)

    lines = [f"  {field_label}: {explain}"]
    if current:
        lines.append(f"  current: {compact(current, 260)}")
    if suggestion:
        lines.append(f"  suggestion: {compact(suggestion, 260)}")
    lines.append(f"  {field_label} [Enter=keep, -=clear, q=quit]: ")

    if tty_in is not None and tty_out is not None:
        try:
            tty_out.write("\n".join(lines))
            tty_out.flush()
            response = (tty_in.readline() or "").strip()
        except Exception:
            response = ""
    else:
        for line in lines[:-1]:
            print(line)
        try:
            response = input(lines[-1]).strip()
        except EOFError:
            response = ""

    lowered = response.lower()
    if lowered in {"q", "quit"}:
        return ("quit", current)
    if response == "":
        return ("keep", current)
    if response == "-":
        return ("set", "")
    return ("set", compact(response, 400))


stop_prompts = False

print("")
print("Main agent directives:")
print("  These directives apply to the main agent and shape delegation behavior.")

action, value = ask_toggle(
    "forbid main doing subagent jobs",
    "Main should delegate specialist work to subagents instead of doing it directly.",
    bool(updated_main_directives.get("forbidMainDoingSubagentJobs", False)),
)
if action == "quit":
    stop_prompts = True
elif action == "set":
    updated_main_directives["forbidMainDoingSubagentJobs"] = bool(value)

if not stop_prompts:
    action, value = ask_toggle(
        "prefer huddle mode",
        "For deep/perplexing questions, main should often request a federated team response.",
        bool(updated_main_directives.get("preferHuddleMode", False)),
    )
    if action == "quit":
        stop_prompts = True
    elif action == "set":
        updated_main_directives["preferHuddleMode"] = bool(value)

for index, agent in enumerate(subagents, start=1):
    agent_id = str(agent.get("id") or "").strip()
    name = str(agent.get("name") or agent_id).strip() or agent_id
    workspace = os.path.abspath(os.path.expanduser(str(agent.get("workspace") or "").strip() or ""))
    model = str(agent.get("model") or "").strip()
    tools_profile = str(agent.get("toolsProfile") or "").strip()

    identity_text = read_text(os.path.join(workspace, "IDENTITY.md")) if workspace else ""
    soul_text = read_text(os.path.join(workspace, "SOUL.md")) if workspace else ""
    agents_text = read_text(os.path.join(workspace, "AGENTS.md")) if workspace else ""
    identity = parse_identity(identity_text)

    memory_dir = os.path.join(workspace, "memory") if workspace else ""
    memory_md_count = 0
    if memory_dir and os.path.isdir(memory_dir):
        try:
            memory_md_count = sum(1 for _ in Path(memory_dir).glob("*.md"))
        except Exception:
            memory_md_count = 0

    workspace_md = []
    if workspace and os.path.isdir(workspace):
        try:
            workspace_md = sorted(p.name for p in Path(workspace).glob("*.md"))
        except Exception:
            workspace_md = []

    allowed_hint = "yes" if (agent_id in main_allow) else ("no" if main_allow else "unspecified")
    detected_heading = compact(first_heading(agents_text), 180)
    detected_agents_summary = compact(first_paragraph(agents_text), 260)
    detected_soul_summary = compact(first_paragraph(soul_text), 260)

    profile = dict(updated_profiles.get(agent_id, {}))
    current_heading = compact(profile.get("heading", ""), 400)
    current_summary = compact(profile.get("summary", ""), 400)
    current_soul_summary = compact(profile.get("soulSummary", ""), 400)
    current_description = compact(profile.get("description", ""), 400)

    print("")
    print(f"[{index}/{len(subagents)}] {name} ({agent_id})")
    print(f"  workspace: {workspace or '(unset)'}")
    if model:
        print(f"  model: {model}")
    if tools_profile:
        print(f"  tools profile: {tools_profile}")
    print(f"  delegated by main allowAgents: {allowed_hint}")
    if identity:
        print(
            "  identity: "
            + ", ".join(
                x for x in [
                    f"name={identity.get('name', '')}" if identity.get("name") else "",
                    f"creature={identity.get('creature', '')}" if identity.get("creature") else "",
                    f"vibe={identity.get('vibe', '')}" if identity.get("vibe") else "",
                    f"emoji={identity.get('emoji', '')}" if identity.get("emoji") else "",
                ] if x
            )
        )
    if detected_heading:
        print(f"  detected AGENTS heading: {detected_heading}")
    if detected_agents_summary:
        print(f"  detected AGENTS summary: {detected_agents_summary}")
    if detected_soul_summary:
        print(f"  detected SOUL summary: {detected_soul_summary}")
    print(f"  memory/*.md files: {memory_md_count}")
    if workspace_md:
        print(f"  workspace root docs: {', '.join(workspace_md)}")
    else:
        print("  workspace root docs: (none)")
    if current_heading:
        print(f"  current team heading: {current_heading}")
    if current_summary:
        print(f"  current team summary: {current_summary}")
    if current_soul_summary:
        print(f"  current team soul summary: {current_soul_summary}")
    if current_description:
        print(f"  current team description: {current_description}")

    if interactive and not stop_prompts:
        action, value = ask_field(
            "team heading",
            "Short role title for this subagent on your team.",
            current_heading,
            detected_heading,
        )
        if action == "quit":
            stop_prompts = True
        elif action == "set":
            current_heading = value

        if not stop_prompts:
            action, value = ask_field(
                "team summary",
                "One-line responsibility summary (what this agent is for).",
                current_summary,
                detected_agents_summary,
            )
            if action == "quit":
                stop_prompts = True
            elif action == "set":
                current_summary = value

        if not stop_prompts:
            action, value = ask_field(
                "team soul summary",
                "How this agent tends to think/behave (tone, style, strengths).",
                current_soul_summary,
                detected_soul_summary,
            )
            if action == "quit":
                stop_prompts = True
            elif action == "set":
                current_soul_summary = value

        if not stop_prompts:
            action, value = ask_field(
                "team description",
                "Anything else main should know when delegating work to this agent.",
                current_description,
                "",
            )
            if action == "quit":
                stop_prompts = True
            elif action == "set":
                current_description = value

        if stop_prompts:
            print("Team roster prompts stopped by user; keeping remaining fields unchanged.")

    normalized_profile = {}
    if current_heading:
        normalized_profile["heading"] = compact(current_heading, 400)
    if current_summary:
        normalized_profile["summary"] = compact(current_summary, 400)
    if current_soul_summary:
        normalized_profile["soulSummary"] = compact(current_soul_summary, 400)
    if current_description:
        normalized_profile["description"] = compact(current_description, 400)

    if normalized_profile:
        updated_profiles[agent_id] = normalized_profile
    else:
        updated_profiles.pop(agent_id, None)

meta_payload = {
    "agentProfiles": updated_profiles,
    "mainDirectives": normalize_main_directives(updated_main_directives),
}
meta_json = json.dumps(meta_payload, separators=(",", ":"), ensure_ascii=True, sort_keys=True)

lines = []
lines.append(start_marker)
lines.append("## Team Roster")
lines.append("")
lines.append("This section is maintained by `scripts/apply_directives_to_agents.sh`.")
lines.append("Main agent guidance:")
lines.append("- Treat this roster as your delegation map and accountability list for subagent work.")
lines.append("- When tasks are delegated, assign intentionally, monitor follow-through, and avoid dropped work.")
lines.append("- Check in frequently at first, then moderately, then periodically as work stabilizes.")
lines.append("- Keep the user up to speed with concise updates on what each subagent is doing, progress made, risks, and blockers.")
if normalize_bool(updated_main_directives.get("forbidMainDoingSubagentJobs"), False):
    lines.append("- Directive (Main): Do not do specialist subagent work directly when a capable subagent exists; delegate first, then synthesize.")
else:
    lines.append("- Directive (Main): Delegation is preferred, but main may execute specialist work directly when necessary.")
if normalize_bool(updated_main_directives.get("preferHuddleMode"), False):
    lines.append("- Directive (Main): Use Huddle Mode often for deep/perplexing questions to generate a federated team response.")
else:
    lines.append("- Directive (Main): Huddle Mode is optional; use when higher confidence or wider perspective is needed.")
lines.append(f"{meta_prefix} {meta_json} {meta_suffix}")
lines.append("")

if not subagents:
    lines.append("No non-main agents are currently configured.")
else:
    for agent in subagents:
        agent_id = str(agent.get("id") or "").strip()
        name = str(agent.get("name") or agent_id).strip() or agent_id
        workspace = os.path.abspath(os.path.expanduser(str(agent.get("workspace") or "").strip() or ""))
        model = str(agent.get("model") or "").strip()
        tools_profile = str(agent.get("toolsProfile") or "").strip()

        identity_text = read_text(os.path.join(workspace, "IDENTITY.md")) if workspace else ""
        soul_text = read_text(os.path.join(workspace, "SOUL.md")) if workspace else ""
        agents_text = read_text(os.path.join(workspace, "AGENTS.md")) if workspace else ""
        identity = parse_identity(identity_text)

        memory_dir = os.path.join(workspace, "memory") if workspace else ""
        memory_md_count = 0
        if memory_dir and os.path.isdir(memory_dir):
            try:
                memory_md_count = sum(1 for _ in Path(memory_dir).glob("*.md"))
            except Exception:
                memory_md_count = 0

        allowed_hint = "yes" if (agent_id in main_allow) else ("no" if main_allow else "unspecified")
        profile = normalize_profile_entry(updated_profiles.get(agent_id, {}))
        team_heading = compact(profile.get("heading", ""), 400)
        team_summary = compact(profile.get("summary", ""), 400)
        team_soul_summary = compact(profile.get("soulSummary", ""), 400)
        team_description = compact(profile.get("description", ""), 400)

        lines.append(f"### {name} (`{agent_id}`)")
        lines.append(f"- Workspace: `{workspace or '(unset)'}`")
        if model:
            lines.append(f"- Model: `{model}`")
        if tools_profile:
            lines.append(f"- Tools profile: `{tools_profile}`")
        lines.append(f"- Delegated by main `allowAgents`: `{allowed_hint}`")

        identity_parts = []
        for key in ("name", "creature", "vibe", "emoji"):
            value = compact(identity.get(key, ""), 120)
            if value:
                identity_parts.append(f"{key}: {value}")
        if identity_parts:
            lines.append(f"- Identity: {'; '.join(identity_parts)}")
        if team_heading:
            lines.append(f"- Team heading: {team_heading}")
        else:
            lines.append("- Team heading: _(none)_")
        if team_summary:
            lines.append(f"- Team summary: {team_summary}")
        else:
            lines.append("- Team summary: _(none)_")
        if team_soul_summary:
            lines.append(f"- Team soul summary: {team_soul_summary}")
        else:
            lines.append("- Team soul summary: _(none)_")
        lines.append(f"- Memory files (`memory/*.md`): `{memory_md_count}`")
        if team_description:
            lines.append(f"- Team description: {team_description}")
        else:
            lines.append("- Team description: _(none)_")
        lines.append("")

lines.append(end_marker)
new_section = "\n".join(lines).rstrip() + "\n"

current = main_doc
start_idx = current.find(start_marker)
end_idx = current.find(end_marker, start_idx + len(start_marker)) if start_idx != -1 else -1

if start_idx != -1 and end_idx != -1 and end_idx >= start_idx:
    end_after = end_idx + len(end_marker)
    if end_after < len(current) and current[end_after:end_after + 1] == "\n":
        end_after += 1
    prefix = current[:start_idx].rstrip("\n")
    suffix = current[end_after:].lstrip("\n")
    if prefix:
        updated = prefix + "\n\n" + new_section
    else:
        updated = new_section
    if suffix:
        updated = updated.rstrip("\n") + "\n\n" + suffix
else:
    updated = current
    if updated and not updated.endswith("\n"):
        updated += "\n"
    if updated and not updated.endswith("\n\n"):
        updated += "\n"
    updated += new_section

if updated == current:
    set_status("unchanged")
    sys.exit(0)

if mode == "dry-run":
    set_status("would-update")
    sys.exit(0)

Path(main_agents_path).parent.mkdir(parents=True, exist_ok=True)
Path(main_agents_path).write_text(updated, encoding="utf-8")
set_status("updated")

if tty_in is not None:
    try:
        tty_in.close()
    except Exception:
        pass
if tty_out is not None:
    try:
        tty_out.close()
    except Exception:
        pass
PY
  status="$(cat "$status_output_file" 2>/dev/null | tr -d '\r' | tail -n 1)"
  rm -f "$status_output_file"

  case "$status" in
    updated)
      TEAM_ROSTER_STATUS="updated"
      log_success "Updated team roster section in $main_agents_file"
      ;;
    unchanged)
      TEAM_ROSTER_STATUS="unchanged"
      log_info "Team roster section already up to date: $main_agents_file"
      ;;
    would-update)
      TEAM_ROSTER_STATUS="would-update"
      log_info "(dry-run) Would update team roster section in $main_agents_file"
      ;;
    no-agents)
      TEAM_ROSTER_STATUS="no-agents"
      log_warn "No agents discovered while building team roster section."
      ;;
    *)
      TEAM_ROSTER_STATUS="error"
      log_warn "Unexpected team roster status: $status"
      ;;
  esac
}

main() {
  discover_agents
  discover_directives

  log_info "Discovered ${#AGENT_IDS[@]} agent(s):"
  local idx
  idx=0
  while [ "$idx" -lt "${#AGENT_IDS[@]}" ]; do
    log_info "  - ${AGENT_IDS[$idx]} (${AGENT_NAMES[$idx]}): ${AGENT_WORKSPACES[$idx]}"
    idx=$((idx + 1))
  done

  local directive_file directive_rel rc scope_label
  if [ "${#ALL_DIRECTIVES[@]}" -eq 0 ] && [ "${#SCOPED_DIRECTIVES[@]}" -eq 0 ]; then
    log_warn "No directive markdown files found under $DIRECTIVES_DIR"
  else
    log_info "Phase 1: applying directives/all/*.md"
    for directive_file in "${ALL_DIRECTIVES[@]}"; do
      directive_rel="${directive_file#$DIRECTIVES_DIR/}"
      scope_label="all"
      set +e
      process_directive_file "$directive_file" "$directive_rel" "$scope_label"
      rc=$?
      set -e
      if [ "$rc" -eq 2 ]; then
        log_warn "Stopped by user."
        break
      fi
    done

    if [ "${#SCOPED_DIRECTIVES[@]}" -gt 0 ]; then
      log_info "Phase 2: applying directives/<scope>/*.md (excluding all)"
    fi
    for directive_file in "${SCOPED_DIRECTIVES[@]}"; do
      directive_rel="${directive_file#$DIRECTIVES_DIR/}"
      scope_label="$(basename "$(dirname "$directive_file")")"
      set +e
      process_directive_file "$directive_file" "$directive_rel" "$scope_label"
      rc=$?
      set -e
      if [ "$rc" -eq 2 ]; then
        log_warn "Stopped by user."
        break
      fi
    done
  fi

  log_info "Phase 3: updating team roster section in main AGENTS.md"
  upsert_main_team_roster_section

  echo ""
  log_success "Directive apply run complete."
  echo "Applied: $APPLIED_COUNT"
  echo "Already present (idempotent skips): $EXISTS_COUNT"
  echo "Declined: $DECLINED_COUNT"
  echo "Errors: $ERROR_COUNT"
  echo "Team roster status: $TEAM_ROSTER_STATUS"
  if [ "$DRY_RUN" = true ]; then
    echo "Mode: dry-run (no files were modified)"
  fi
}

main "$@"
