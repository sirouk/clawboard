#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CLAWBOARD_VECTOR_PREWARM=0
export HF_HUB_DISABLE_PROGRESS_BARS=1

COMMON_IGNORE_DIRS="/usr${PATH_SEPARATOR:-:}/opt${PATH_SEPARATOR:-:}$ROOT_DIR/.venv${PATH_SEPARATOR:-:}$ROOT_DIR/backend/.venv"

cleanup_trace_artifacts() {
  find "$ROOT_DIR/backend" -name '*.cover' -delete
  find "$ROOT_DIR/classifier" -name '*.cover' -delete
  if [[ -d "$ROOT_DIR/.venv" ]]; then
    find "$ROOT_DIR/.venv" -name '*.cover' -delete
  fi
  if [[ -d "$ROOT_DIR/backend/.venv" ]]; then
    find "$ROOT_DIR/backend/.venv" -name '*.cover' -delete
  fi
}

cleanup_trace_artifacts
trap cleanup_trace_artifacts EXIT

PYTHONPATH="$ROOT_DIR/backend${PYTHONPATH:+:$PYTHONPATH}" \
  bash "$ROOT_DIR/scripts/repo_python.sh" "$ROOT_DIR/scripts/trace_coverage_gate.py" \
    --coverdir "$ROOT_DIR/coverage/trace/backend" \
    --ignore-dir "$COMMON_IGNORE_DIRS" \
    --target "$ROOT_DIR/backend/app/clawgraph.py=90" \
    --target "$ROOT_DIR/backend/app/vector_maintenance.py=90" \
    --target "$ROOT_DIR/backend/app/vector_search.py=90" \
    --runner-module unittest \
    -- discover -s "$ROOT_DIR/backend/tests" -p "test_*.py"

PYTHONPATH="$ROOT_DIR${PYTHONPATH:+:$PYTHONPATH}" \
  bash "$ROOT_DIR/scripts/repo_python.sh" "$ROOT_DIR/scripts/trace_coverage_gate.py" \
    --coverdir "$ROOT_DIR/coverage/trace/classifier" \
    --ignore-dir "$COMMON_IGNORE_DIRS" \
    --target "$ROOT_DIR/classifier/classifier.py=90" \
    --runner-module unittest \
    -- discover -s "$ROOT_DIR/classifier/tests" -p "test_*.py"
