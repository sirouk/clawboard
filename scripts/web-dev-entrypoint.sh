#!/bin/sh
set -eu

log() {
  printf '[web-dev-entrypoint] %s\n' "$*"
}

probe_url() {
  probe_path="$1"
  probe_timeout_ms="$2"
  WEB_DEV_PROBE_PATH="$probe_path" WEB_DEV_PROBE_TIMEOUT_MS="$probe_timeout_ms" node <<'NODE'
const http = require("http");

const path = process.env.WEB_DEV_PROBE_PATH || "/";
const timeoutMs = Number(process.env.WEB_DEV_PROBE_TIMEOUT_MS || "1200");

const req = http.get(
  {
    host: "127.0.0.1",
    port: 3000,
    path,
    headers: { "User-Agent": "clawboard-web-prewarm/1.0" },
  },
  (res) => {
    res.resume();
    res.on("end", () => process.exit(0));
  }
);

req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
req.on("error", () => process.exit(1));
NODE
}

prewarm_route() {
  warm_path="$1"
  warm_timeout_ms="$2"
  WEB_DEV_WARM_PATH="$warm_path" WEB_DEV_WARM_TIMEOUT_MS="$warm_timeout_ms" node <<'NODE'
const http = require("http");

const path = process.env.WEB_DEV_WARM_PATH || "/";
const timeoutMs = Number(process.env.WEB_DEV_WARM_TIMEOUT_MS || "180000");
const start = Date.now();

const req = http.get(
  {
    host: "127.0.0.1",
    port: 3000,
    path,
    headers: { "User-Agent": "clawboard-web-prewarm/1.0" },
  },
  (res) => {
    res.resume();
    res.on("end", () => {
      const elapsed = Date.now() - start;
      console.log(`[web-dev-entrypoint] prewarm ${path} -> ${res.statusCode} (${elapsed}ms)`);
      process.exit(0);
    });
  }
);

req.setTimeout(timeoutMs, () => {
  const elapsed = Date.now() - start;
  console.log(`[web-dev-entrypoint] prewarm ${path} timeout (${elapsed}ms)`);
  req.destroy(new Error("timeout"));
});

req.on("error", (err) => {
  const elapsed = Date.now() - start;
  console.log(`[web-dev-entrypoint] prewarm ${path} error (${elapsed}ms): ${err.message}`);
  process.exit(1);
});
NODE
}

LOCK_HASH_FILE="node_modules/.clawboard-lockfile-sha256"
LOCK_HASH="$(sha256sum package-lock.json 2>/dev/null | awk '{print $1}' || true)"
INSTALLED_HASH="$(cat "$LOCK_HASH_FILE" 2>/dev/null || true)"

if [ ! -d node_modules/.bin ] || [ -z "$LOCK_HASH" ] || [ "$LOCK_HASH" != "$INSTALLED_HASH" ]; then
  log "Installing dependencies (npm ci)..."
  npm ci
  if [ -n "$LOCK_HASH" ]; then
    echo "$LOCK_HASH" > "$LOCK_HASH_FILE"
  fi
fi

log "Starting Next.js dev server..."
npm run dev -- -H 0.0.0.0 -p 3000 &
NEXT_PID=$!

stop_server() {
  if kill -0 "$NEXT_PID" 2>/dev/null; then
    kill "$NEXT_PID" 2>/dev/null || true
    wait "$NEXT_PID" 2>/dev/null || true
  fi
}

trap stop_server INT TERM

READY_WAIT_SECONDS="${CLAWBOARD_WEB_DEV_READY_WAIT_SECONDS:-180}"
READY_WAIT_SECONDS="$(printf '%s' "$READY_WAIT_SECONDS" | tr -cd '0-9')"
if [ -z "$READY_WAIT_SECONDS" ]; then
  READY_WAIT_SECONDS=180
fi
READY_PROBE_PATH="${CLAWBOARD_WEB_DEV_READY_PROBE_PATH:-/favicon.ico}"

READY=0
i=0
while [ "$i" -lt "$READY_WAIT_SECONDS" ]; do
  if probe_url "$READY_PROBE_PATH" 1200; then
    READY=1
    break
  fi
  if ! kill -0 "$NEXT_PID" 2>/dev/null; then
    log "Dev server exited before becoming ready."
    wait "$NEXT_PID"
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$READY" -eq 0 ]; then
  log "Timed out waiting for dev server readiness."
  stop_server
  exit 1
fi

log "Dev server is accepting connections."
PREWARM_ENABLED="$(printf '%s' "${CLAWBOARD_WEB_DEV_PREWARM:-true}" | tr '[:upper:]' '[:lower:]')"
case "$PREWARM_ENABLED" in
  1|true|yes|on)
    PREWARM_PATHS="${CLAWBOARD_WEB_DEV_PREWARM_PATHS:-/ /u /graph /log /stats}"
    PREWARM_TIMEOUT_MS="${CLAWBOARD_WEB_DEV_PREWARM_TIMEOUT_MS:-180000}"
    for path in $PREWARM_PATHS; do
      log "Prewarming ${path}..."
      prewarm_route "$path" "$PREWARM_TIMEOUT_MS" || true
    done
    ;;
  *)
    log "Prewarm disabled."
    ;;
esac

wait "$NEXT_PID"
