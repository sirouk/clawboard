#!/usr/bin/env bash
set -euo pipefail

# Compact, durable OpenClaw updater:
# - hard-resets local repo state on every run, then updates to latest tag (or OPENCLAW_UPDATE_TAG)
# - builds with auto-detected package manager
# - persists gateway runtime tuning in ~/.openclaw/openclaw.json
# - repairs/reinstalls/restarts gateway
# - verifies gateway health with retries and recovery

OPENCLAW_REPO="${OPENCLAW_REPO:-$HOME/openclaw}"
OPENCLAW_UPDATE_REMOTE="${OPENCLAW_UPDATE_REMOTE:-origin}"
OPENCLAW_UPDATE_TAG="${OPENCLAW_UPDATE_TAG:-}"
OPENCLAW_UPDATE_ALLOW_PRERELEASE="${OPENCLAW_UPDATE_ALLOW_PRERELEASE:-0}"
OPENCLAW_UPDATE_LOCK_DIR="${OPENCLAW_UPDATE_LOCK_DIR:-}"
OPENCLAW_PACKAGE_MANAGER="${OPENCLAW_PACKAGE_MANAGER:-auto}"
OPENCLAW_GATEWAY_STATUS_ATTEMPTS="${OPENCLAW_GATEWAY_STATUS_ATTEMPTS:-6}"
OPENCLAW_GATEWAY_STATUS_SLEEP_SECONDS="${OPENCLAW_GATEWAY_STATUS_SLEEP_SECONDS:-5}"
OPENCLAW_GATEWAY_RECOVER_ON_RETRY="${OPENCLAW_GATEWAY_RECOVER_ON_RETRY:-1}"

OPENCLAW_GATEWAY_RESERVE_MB="${OPENCLAW_GATEWAY_RESERVE_MB:-1024}"
OPENCLAW_GATEWAY_MAX_OLD_SPACE_MB="${OPENCLAW_GATEWAY_MAX_OLD_SPACE_MB:-}"
OPENCLAW_GATEWAY_UV_THREADPOOL_SIZE="${OPENCLAW_GATEWAY_UV_THREADPOOL_SIZE:-}"

LOCK_DIR=""
OPENCLAW_CLI_NODE=""
OPENCLAW_CLI_NODE_OPTIONS=""
OPENCLAW_ENTRY=""

log_info() { printf "info: %s\n" "$1"; }
log_warn() { printf "warn: %s\n" "$1" >&2; }
die() { printf "error: %s\n" "$1" >&2; exit 1; }

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

is_uint() { printf "%s" "${1:-}" | grep -Eq '^[0-9]+$'; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

release_lock() {
  [ -z "$LOCK_DIR" ] && return 0
  rm -f "$LOCK_DIR/pid" >/dev/null 2>&1 || true
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

acquire_lock() {
  local pid=""
  LOCK_DIR="${OPENCLAW_UPDATE_LOCK_DIR:-${OPENCLAW_REPO}/.update_openclaw.lock}"

  if mkdir "$LOCK_DIR" >/dev/null 2>&1; then
    printf "%s\n" "$$" >"$LOCK_DIR/pid" 2>/dev/null || true
    log_info "Acquired update lock: ${LOCK_DIR}"
    return 0
  fi

  if [ -f "$LOCK_DIR/pid" ]; then
    pid="$(tr -dc '0-9' <"$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      die "Another update appears to be running (pid ${pid}, lock: ${LOCK_DIR})"
    fi
    log_warn "Detected stale update lock (pid ${pid:-unknown}); recovering"
  fi

  rm -f "$LOCK_DIR/pid" >/dev/null 2>&1 || true
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || die "Another update appears to be running (lock exists: ${LOCK_DIR})"
  mkdir "$LOCK_DIR" >/dev/null 2>&1 || die "Unable to recover stale lock: ${LOCK_DIR}"
  printf "%s\n" "$$" >"$LOCK_DIR/pid" 2>/dev/null || true
  log_info "Recovered stale update lock: ${LOCK_DIR}"
}

on_err() {
  local exit_code="$1"
  local line_no="$2"
  local failed_cmd="$3"
  log_warn "Update failed at line ${line_no}: ${failed_cmd} (exit=${exit_code})"
  if command -v openclaw >/dev/null 2>&1; then
    log_warn "Last known gateway status:"
    openclaw gateway status --json 2>/dev/null || true
  fi
  exit "$exit_code"
}

json_quote() {
  python3 - "$1" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1]))
PY
}

resolve_system_node() {
  local c major
  local candidates=()
  case "$(uname -s)" in
    Darwin) candidates=("/opt/homebrew/bin/node" "/usr/local/bin/node" "/usr/bin/node") ;;
    Linux) candidates=("/usr/local/bin/node" "/usr/bin/node") ;;
  esac

  for c in "${candidates[@]}"; do
    [ -x "$c" ] || continue
    major="$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    if is_uint "$major" && [ "$major" -ge 22 ]; then
      printf "%s\n" "$c"
      return 0
    fi
  done
  return 1
}

detect_total_memory_mb() {
  case "$(uname -s)" in
    Darwin)
      local bytes
      bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
      if is_uint "$bytes" && [ "$bytes" -gt 0 ]; then
        echo $((bytes / 1024 / 1024))
        return 0
      fi
      ;;
    Linux)
      local kb
      kb="$(awk '/MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true)"
      if is_uint "$kb" && [ "$kb" -gt 0 ]; then
        echo $((kb / 1024))
        return 0
      fi
      ;;
  esac
  echo 8192
}

detect_cpu_count() {
  case "$(uname -s)" in
    Darwin)
      local cpus
      cpus="$(sysctl -n hw.ncpu 2>/dev/null || true)"
      if is_uint "$cpus" && [ "$cpus" -gt 0 ]; then
        echo "$cpus"
        return 0
      fi
      ;;
    Linux)
      if command -v nproc >/dev/null 2>&1; then
        local cpus
        cpus="$(nproc 2>/dev/null || true)"
        if is_uint "$cpus" && [ "$cpus" -gt 0 ]; then
          echo "$cpus"
          return 0
        fi
      fi
      ;;
  esac
  echo 4
}

run_openclaw() {
  local node entry opts
  node="${OPENCLAW_CLI_NODE:-$(command -v node 2>/dev/null || true)}"
  entry="${OPENCLAW_ENTRY:-$OPENCLAW_REPO/dist/entry.js}"
  opts="${NODE_OPTIONS:-}"

  if [ -n "$OPENCLAW_CLI_NODE_OPTIONS" ] && [[ "$opts" != *"--max-old-space-size="* ]]; then
    opts="${opts:+${opts} }${OPENCLAW_CLI_NODE_OPTIONS}"
  fi

  if [ -n "$node" ] && [ -f "$entry" ]; then
    if [ -n "$opts" ]; then
      NODE_OPTIONS="$opts" "$node" "$entry" "$@"
    else
      "$node" "$entry" "$@"
    fi
    return 0
  fi

  openclaw "$@"
}

set_openclaw_env_key() {
  local key="$1"
  local value="$2"
  run_openclaw config set "env.${key}" "$(json_quote "$value")" --json >/dev/null
}

normalize_package_manager() {
  case "${1:-}" in
    ""|auto) echo "auto" ;;
    pnpm|npnm) echo "pnpm" ;;
    npm|bun) echo "$1" ;;
    *) die "OPENCLAW_PACKAGE_MANAGER must be auto, pnpm, npm, or bun" ;;
  esac
}

package_manager_hint() {
  [ -f package.json ] || { echo ""; return 0; }
  python3 - <<'PY'
import json
import pathlib
try:
    pkg = json.loads(pathlib.Path("package.json").read_text())
except Exception:
    print("")
    raise SystemExit(0)
pm = str(pkg.get("packageManager", "")).strip().lower().split("@", 1)[0]
if pm in {"pnpm", "npnm"}:
    print("pnpm")
elif pm in {"npm", "bun"}:
    print(pm)
else:
    print("")
PY
}

detect_package_manager() {
  local requested hint
  requested="$(normalize_package_manager "$OPENCLAW_PACKAGE_MANAGER")"
  if [ "$requested" != "auto" ]; then
    command -v "$requested" >/dev/null 2>&1 || die "Requested package manager not found: $requested"
    echo "$requested"
    return 0
  fi

  hint="$(package_manager_hint || true)"
  if [ -n "$hint" ] && command -v "$hint" >/dev/null 2>&1; then
    echo "$hint"
    return 0
  elif [ -n "$hint" ]; then
    log_warn "package.json prefers ${hint}, but it is not installed"
  fi

  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then echo "pnpm"; return 0; fi
  if { [ -f bun.lock ] || [ -f bun.lockb ]; } && command -v bun >/dev/null 2>&1; then echo "bun"; return 0; fi
  if [ -f package-lock.json ] && command -v npm >/dev/null 2>&1; then echo "npm"; return 0; fi

  if command -v pnpm >/dev/null 2>&1; then echo "pnpm"; return 0; fi
  if command -v npm >/dev/null 2>&1; then echo "npm"; return 0; fi
  if command -v bun >/dev/null 2>&1; then echo "bun"; return 0; fi
  die "No supported package manager found (pnpm, npm, bun)"
}

run_build() {
  local pm="$1"
  log_info "Detected package manager: ${pm}"
  case "$pm" in
    pnpm)
      if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile || pnpm install; else pnpm install; fi
      pnpm ui:build
      pnpm build
      ;;
    npm)
      if [ -f package-lock.json ]; then npm ci || npm install; else npm install; fi
      npm run ui:build
      npm run build
      ;;
    bun)
      if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile || bun install; else bun install; fi
      bun run ui:build
      bun run build
      ;;
  esac
}

resolve_target_tag() {
  if [ -n "$OPENCLAW_UPDATE_TAG" ]; then
    git rev-parse -q --verify "refs/tags/${OPENCLAW_UPDATE_TAG}" >/dev/null 2>&1 \
      || die "Requested OPENCLAW_UPDATE_TAG does not exist: ${OPENCLAW_UPDATE_TAG}"
    echo "$OPENCLAW_UPDATE_TAG"
    return 0
  fi

  local tag
  if is_truthy "$OPENCLAW_UPDATE_ALLOW_PRERELEASE"; then
    tag="$(git tag --sort=-v:refname | head -n1 || true)"
  else
    tag="$(
      git tag --sort=-v:refname \
        | grep -Eiv '(^|[-._])(alpha|beta|rc|pre|preview|dev)([-._]?[0-9]*)?$' \
        | head -n1 || true
    )"
  fi
  [ -n "$tag" ] || tag="$(git for-each-ref --sort=-creatordate --format='%(refname:short)' refs/tags | head -n1 || true)"
  [ -n "$tag" ] || die "No tags found in repository"
  echo "$tag"
}

persist_gateway_tuning() {
  local reserve total cpu max_old uv node_opts

  reserve="$OPENCLAW_GATEWAY_RESERVE_MB"
  is_uint "$reserve" || die "OPENCLAW_GATEWAY_RESERVE_MB must be an integer"

  total="$(detect_total_memory_mb)"
  cpu="$(detect_cpu_count)"
  max_old="$OPENCLAW_GATEWAY_MAX_OLD_SPACE_MB"
  uv="$OPENCLAW_GATEWAY_UV_THREADPOOL_SIZE"

  if [ -z "$max_old" ]; then
    max_old=$((total - reserve))
    [ "$max_old" -lt 2048 ] && max_old=2048
  fi
  if [ -z "$uv" ]; then
    uv=$((cpu * 2))
    [ "$uv" -lt 8 ] && uv=8
    [ "$uv" -gt 128 ] && uv=128
  fi

  is_uint "$max_old" || die "OPENCLAW_GATEWAY_MAX_OLD_SPACE_MB must be an integer"
  is_uint "$uv" || die "OPENCLAW_GATEWAY_UV_THREADPOOL_SIZE must be an integer"
  [ "$max_old" -ge 1024 ] || die "OPENCLAW_GATEWAY_MAX_OLD_SPACE_MB must be >= 1024"
  [ "$uv" -ge 1 ] || die "OPENCLAW_GATEWAY_UV_THREADPOOL_SIZE must be >= 1"

  node_opts="--max-old-space-size=${max_old}"
  set_openclaw_env_key "NODE_OPTIONS" "$node_opts"
  set_openclaw_env_key "UV_THREADPOOL_SIZE" "$uv"
  OPENCLAW_CLI_NODE_OPTIONS="$node_opts"

  log_info "Persisted durable gateway tuning in config:"
  log_info "  env.NODE_OPTIONS=${node_opts}"
  log_info "  env.UV_THREADPOOL_SIZE=${uv}"
}

restart_gateway() {
  run_openclaw gateway restart >/dev/null 2>&1 || run_openclaw gateway start >/dev/null 2>&1
}

verify_gateway_status() {
  local attempts sleep_seconds attempt status_json
  attempts="$OPENCLAW_GATEWAY_STATUS_ATTEMPTS"
  sleep_seconds="$OPENCLAW_GATEWAY_STATUS_SLEEP_SECONDS"
  is_uint "$attempts" || die "OPENCLAW_GATEWAY_STATUS_ATTEMPTS must be an integer"
  is_uint "$sleep_seconds" || die "OPENCLAW_GATEWAY_STATUS_SLEEP_SECONDS must be an integer"
  [ "$attempts" -ge 1 ] || die "OPENCLAW_GATEWAY_STATUS_ATTEMPTS must be >= 1"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    status_json="$(run_openclaw gateway status --json 2>/dev/null || true)"
    if [ -z "$status_json" ]; then
      log_warn "Gateway status returned empty output (attempt ${attempt}/${attempts})"
    elif printf "%s\n" "$status_json" | python3 -c '
import json
import sys

text = sys.stdin.read().strip()
if not text:
    print("error: empty gateway status payload", file=sys.stderr)
    raise SystemExit(3)

try:
    data = json.loads(text)
except Exception as exc:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        print(f"error: unable to parse gateway status JSON: {exc}", file=sys.stderr)
        raise SystemExit(4)
    try:
        data = json.loads(text[start : end + 1])
    except Exception as inner:
        print(f"error: unable to parse gateway status JSON: {inner}", file=sys.stderr)
        raise SystemExit(4)

service = data.get("service") or {}
rpc = data.get("rpc") or {}
args = ((service.get("command") or {}).get("programArguments") or [])
runtime = args[0] if args else ""
errors = []

if not service.get("loaded"):
    errors.append("gateway service is not loaded")
if not rpc.get("ok"):
    rpc_error = rpc.get("error") or ""
    if isinstance(rpc_error, str) and rpc_error:
        rpc_error = rpc_error.splitlines()[0]
    errors.append("gateway RPC probe failed" + (f": {rpc_error}" if rpc_error else ""))

if runtime:
    print(f"info: gateway runtime executable: {runtime}")
    lowered = runtime.lower()
    markers = ["/.nvm/", "/.fnm/", "/.volta/", "/.asdf/", "/.n/", "/.nodenv/", "/.nodebrew/", "/nvs/"]
    if any(m in lowered for m in markers):
        print(f"warn: gateway runtime still uses version-manager path ({runtime})", file=sys.stderr)
    if lowered.endswith("/bun") or lowered.endswith("\\\\bun.exe"):
        print("warn: gateway runtime is bun; node runtime is recommended", file=sys.stderr)

if errors:
    for err in errors:
        print(f"error: {err}", file=sys.stderr)
    raise SystemExit(2)
'; then
      return 0
    fi

    if [ "$attempt" -lt "$attempts" ]; then
      if is_truthy "$OPENCLAW_GATEWAY_RECOVER_ON_RETRY"; then
        log_warn "Attempting gateway recover restart before retry"
        restart_gateway || true
      fi
      log_warn "Gateway not healthy yet (attempt ${attempt}/${attempts}); retrying in ${sleep_seconds}s"
      sleep "$sleep_seconds"
    fi
  done

  die "Gateway health verification failed after ${attempts} attempts"
}

main() {
  trap 'on_err $? $LINENO "$BASH_COMMAND"' ERR
  trap 'release_lock' EXIT

  need_cmd git
  need_cmd python3
  is_uint "$OPENCLAW_GATEWAY_STATUS_ATTEMPTS" || die "OPENCLAW_GATEWAY_STATUS_ATTEMPTS must be an integer"
  is_uint "$OPENCLAW_GATEWAY_STATUS_SLEEP_SECONDS" || die "OPENCLAW_GATEWAY_STATUS_SLEEP_SECONDS must be an integer"

  git -C "$OPENCLAW_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "OPENCLAW_REPO is not a git checkout: $OPENCLAW_REPO"

  acquire_lock
  cd "$OPENCLAW_REPO"
  git remote get-url "$OPENCLAW_UPDATE_REMOTE" >/dev/null 2>&1 \
    || die "Configured remote does not exist: ${OPENCLAW_UPDATE_REMOTE}"

  log_info "Fetching updates from ${OPENCLAW_UPDATE_REMOTE}"
  git fetch "$OPENCLAW_UPDATE_REMOTE" --tags --prune

  log_warn "Hard resetting local checkout to ensure a clean update state"
  git reset --hard HEAD
  git clean -fd

  local tag pm system_node
  tag="$(resolve_target_tag)"
  log_info "Checking out tag: ${tag}"
  git checkout --detach "tags/${tag}"

  pm="$(detect_package_manager)"
  run_build "$pm"

  OPENCLAW_ENTRY="${OPENCLAW_REPO}/dist/entry.js"
  [ -f "$OPENCLAW_ENTRY" ] || die "OpenClaw entrypoint not found after build: $OPENCLAW_ENTRY"

  system_node="$(resolve_system_node || true)"
  if [ -n "$system_node" ]; then
    OPENCLAW_CLI_NODE="$system_node"
    log_info "Using system Node for maintenance: $("$system_node" -p 'process.execPath' 2>/dev/null || echo "$system_node")"
  else
    OPENCLAW_CLI_NODE="$(command -v node 2>/dev/null || true)"
    log_warn "No system Node 22+ found in standard paths; using current node (${OPENCLAW_CLI_NODE:-unknown})"
  fi

  persist_gateway_tuning

  log_info "Running doctor repair"
  run_openclaw doctor --fix --yes

  log_info "Reinstalling gateway service to apply updated config + runtime"
  run_openclaw gateway install --force

  log_info "Restarting gateway service"
  restart_gateway

  verify_gateway_status
  log_info "OpenClaw update + durable gateway tuning complete"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
