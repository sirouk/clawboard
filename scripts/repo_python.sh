#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  exec "$ROOT_DIR/.venv/bin/python" "$@"
fi

if command -v python3.12 >/dev/null 2>&1; then
  exec python3.12 "$@"
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 "$@"
fi

echo "repo python not found: expected .venv/bin/python, python3.12, or python3" >&2
exit 1
