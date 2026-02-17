#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

docker compose build api
CLAWBOARD_VECTOR_PREWARM=0 HF_HUB_DISABLE_PROGRESS_BARS=1 \
docker compose run --rm -T \
  -v "$ROOT_DIR/backend/tests:/app/tests:ro" \
  -v clawboard_classifier_cache:/root/.cache \
  api \
  python -m unittest discover -s /app/tests -p "test_*.py"
