#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  echo "error: not in a git repository" >&2
  exit 2
fi
cd "${ROOT}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL is not set" >&2
  exit 2
fi

echo "==> compatibility DB retention cleanup"
echo "    database: ${DATABASE_URL}"
npx prisma db execute --schema prisma/schema.prisma --file scripts/sql/cleanup_compat_logs.sql
