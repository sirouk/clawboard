# Data Retention and Redaction Policy

## Scope and Last Review
- Scope: all persistence and queue surfaces reachable via Next compatibility APIs, FastAPI canonical APIs, and plugin workers.
- Last updated: 2026-02-16.

## Retention lifecycle map

| Surface | Path / Config | Data retained | Default retention | Cleanup action |
| --- | --- | --- | --- | --- |
| Backend DB | `CLAWBOARD_DB_URL` (`sqlite` file), SQLModel tables | `topic`, `task`, `logentry`, `event`, `ingestqueue`, reindex metadata | `logentry`: 90 days default | `sqlite3 "$CLAWBOARD_DB_PATH" "DELETE FROM logentry WHERE datetime(createdAt) < datetime('now', '-90 days')"` |
| Compatibility DB | `DATABASE_URL` + `src/lib/db.ts` + Prisma schema | compatibility topics, tasks, logs, events, import jobs | 30 days default | `npx prisma db execute --schema prisma/schema.prisma --file scripts/sql/cleanup_compat_logs.sql` |
| Data artifacts | `data/` (`portal.json`, import queue snapshots, staging manifests) | bootstrap/cache/import staging artifacts | 30 days default | `find data -type f -name '*.jsonl' -mtime +30 -delete` or equivalent rotation policy |
| Plugin queue artifacts | `~/.openclaw/clawboard-queue.sqlite`, `data/reindex-queue.jsonl`, `data/creation-gate.jsonl` | plugin outbound queue, reindex backlog, creation audit trail | 30 days for completed/failed entries | `sqlite3 "$HOME/.openclaw/clawboard-queue.sqlite" "DELETE FROM queue WHERE state IN ('done','failed') OR created_at < datetime('now', '-30 days')"` plus `truncate -s 0 "$CLAWBOARD_REINDEX_QUEUE_PATH"` |
| Attachments | `CLAWBOARD_ATTACHMENTS_DIR` (defaults `./data/attachments`) | uploaded binaries and derived metadata | 180 days or project-specific policy | `find "$CLAWBOARD_ATTACHMENTS_DIR" -type f -mtime +180 -delete` or object-store lifecycle settings |

## Redaction rules
- **Prohibit token leakage in URLs and referrers**: query-param tokens are rejected in middleware and helper auth paths; tokens are header-only.
- **Limit sensitive log metadata**: avoid embedding API credentials or raw auth payloads in persisted plugin-facing fields.
- **Scrub debug and support traces**: token-like strings are removed from incident response logs and command snippets.
- **Avoid persistent environment secret material**: never persist token configuration values or other runtime secrets in queue/artifact payloads.

## Cleanup and incident commands
- Backend DB: `sqlite3 "$CLAWBOARD_DB_PATH" "DELETE FROM logentry WHERE datetime(createdAt) < datetime('now', '-90 days')"`
- Compatibility DB: `scripts/cleanup_compat_db.sh` (runbook) or `npx prisma db execute --schema prisma/schema.prisma --file scripts/sql/cleanup_compat_logs.sql`
- Data artifacts: `find data -type f \\( -name '*.jsonl' -o -name '*.json' -o -name '*.tmp' \\) -mtime +30 -delete`
- Plugin queue artifacts:
  - `sqlite3 "$HOME/.openclaw/clawboard-queue.sqlite" "DELETE FROM queue WHERE state IN ('done','failed') OR created_at < datetime('now', '-30 days')"`
  - `truncate -s 0 "$CLAWBOARD_REINDEX_QUEUE_PATH"`
- Attachments: `find "$CLAWBOARD_ATTACHMENTS_DIR" -type f -mtime +180 -delete`
- Vector artifacts: `rm -f "$CLAWBOARD_VECTOR_DB_PATH"` before replay/reindex, then regenerate.
- Incident scrub: `rg -n "PORTAL_TOKEN|CLAWBOARD_TOKEN|x-clawboard-token" "$LOG_DIR"` and remove matches through approved incident workflow.

## Action plan
- Owners should codify every row above into a runbook entry or CI maintenance job before build consent.
- Pending hardening:
  - automate compatibility DB and plugin queue cleanup cadence,
  - add attachment lifecycle enforcement in deployment manifests,
  - keep retention windows versioned in runbook.
