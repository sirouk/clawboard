#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible entrypoint.
# The canonical bootstrap script is now bootstrap_clawboard.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/bootstrap_clawboard.sh" "$@"
