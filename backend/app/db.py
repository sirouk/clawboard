from __future__ import annotations

import os
import hashlib
import colorsys
import re
import json
from datetime import datetime, timezone
from pathlib import Path
from sqlmodel import SQLModel, create_engine, Session, select

# SQLite + Docker bind mounts can behave poorly with long-lived pooled connections
# (sporadic "disk I/O error" under concurrent access). Using NullPool keeps each
# request on a fresh connection and avoids reusing a bad file descriptor.
try:  # pragma: no cover
    from sqlalchemy.pool import NullPool
except Exception:  # pragma: no cover
    NullPool = None  # type: ignore

DATABASE_URL = os.getenv("CLAWBOARD_DB_URL", "sqlite:///./data/clawboard.db")

# SQLite busy timeout (seconds). Keep it low so ingest requests fail fast under write contention,
# allowing upstream queues/retries (OpenClaw logger + classifier) to recover without stalling.
SQLITE_TIMEOUT_SECONDS = float(os.getenv("CLAWBOARD_SQLITE_TIMEOUT_SECONDS", "3"))

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False, "timeout": SQLITE_TIMEOUT_SECONDS}

engine_kwargs = {"echo": False, "connect_args": connect_args}
if DATABASE_URL.startswith("sqlite") and NullPool is not None:
    engine_kwargs["poolclass"] = NullPool
engine = create_engine(DATABASE_URL, **engine_kwargs)

DEFAULT_SPACE_ID = "space-default"
DEFAULT_SPACE_NAME = "Default"
SPACE_DEFAULT_VISIBILITY_KEY = "__claw_default_visible"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _normalize_hex_color(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return text.upper()
    return None


def _auto_color(seed: str, offset: float = 0.0) -> str:
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    hue = ((int(digest[:8], 16) % 360) + offset) % 360
    sat = 0.62 + (int(digest[8:12], 16) % 13) / 100.0
    lig = 0.50 + (int(digest[12:16], 16) % 11) / 100.0
    r, g, b = colorsys.hls_to_rgb(hue / 360.0, min(0.66, lig), min(0.80, sat))
    return f"#{int(r * 255):02X}{int(g * 255):02X}{int(b * 255):02X}"


def _normalize_space_connectivity(value: object) -> dict[str, bool]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            value = {}
    if not isinstance(value, dict):
        return {}
    out: dict[str, bool] = {}
    for raw_key, raw_enabled in value.items():
        key = str(raw_key or "").strip()
        if not key or key == SPACE_DEFAULT_VISIBILITY_KEY:
            continue
        out[key] = bool(raw_enabled)
    return out


def init_db() -> None:
    if DATABASE_URL.startswith("sqlite"):
        db_path = DATABASE_URL.replace("sqlite:///", "", 1)
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    # Create tables.
    SQLModel.metadata.create_all(engine)

    # Lightweight migration for sqlite (create_all does not add columns).
    if DATABASE_URL.startswith("sqlite"):
        # Use an explicit commit so ALTER TABLE / index creation reliably persists.
        # (SQLAlchemy's Connection context manager rolls back on close unless committed.)
        with engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA journal_mode=WAL;")
            conn.exec_driver_sql("PRAGMA synchronous=NORMAL;")
            conn.exec_driver_sql("PRAGMA foreign_keys=ON;")

            cols = conn.exec_driver_sql("PRAGMA table_info(logentry);").fetchall()
            existing = {row[1] for row in cols}  # name
            if "classificationStatus" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN classificationStatus TEXT NOT NULL DEFAULT 'pending';")
            if "classificationAttempts" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN classificationAttempts INTEGER NOT NULL DEFAULT 0;")
            if "classificationError" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN classificationError TEXT;")
            if "updatedAt" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN updatedAt TEXT NOT NULL DEFAULT '';")
            if "idempotencyKey" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN idempotencyKey TEXT;")
            if "attachments" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN attachments JSON;")
            if "spaceId" not in existing:
                conn.exec_driver_sql(
                    f"ALTER TABLE logentry ADD COLUMN spaceId TEXT NOT NULL DEFAULT '{DEFAULT_SPACE_ID}';"
                )
            duplicate_keys = conn.exec_driver_sql(
                'SELECT "idempotencyKey", COUNT(*) FROM logentry '
                'WHERE "idempotencyKey" IS NOT NULL GROUP BY "idempotencyKey" HAVING COUNT(*) > 1;'
            ).fetchall()
            for key_value, _count in duplicate_keys:
                rows = conn.exec_driver_sql(
                    'SELECT id FROM logentry WHERE "idempotencyKey" = ? '
                    'ORDER BY "createdAt" ASC, id ASC;',
                    (key_value,),
                ).fetchall()
                for row in rows[1:]:
                    conn.exec_driver_sql("DELETE FROM logentry WHERE id = ?;", (row[0],))
            conn.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_logentry_idempotency_key "
                'ON logentry("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;'
            )
            # Speed up session-thread queries (UI thread view + classifier session bucketing).
            # Expression index so we don't need to denormalize `source.sessionKey` into a dedicated column.
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_logentry_source_session_key "
                "ON logentry(json_extract(source, '$.sessionKey'));"
            )
            # Core list queries (pending classifier work + timeline views) need to be fast even
            # when the log table grows large. Without these, SQLite can do full scans + sorts and
            # the classifier can time out while polling pending work.
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_logentry_status_type_created_at "
                'ON logentry("classificationStatus", "type", "createdAt");'
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_logentry_topic_created_at "
                'ON logentry("topicId", "createdAt");'
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_logentry_task_created_at "
                'ON logentry("taskId", "createdAt");'
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_logentry_related_created_at "
                'ON logentry("relatedLogId", "createdAt");'
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_logentry_space_created_at "
                'ON logentry("spaceId", "createdAt");'
            )
            # Incremental sync and graph fetches rely heavily on updatedAt/createdAt ordering.
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_logentry_updated_created_at "
                'ON logentry("updatedAt", "createdAt");'
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_logentry_created_at "
                'ON logentry("createdAt");'
            )

            # Session routing memory: keep GC fast for large instances.
            try:
                conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_sessionroutingmemory_updated_at "
                    'ON sessionroutingmemory("updatedAt");'
                )
            except Exception:
                # Table may not exist if the model isn't loaded yet; create_all will handle later.
                pass

            topic_cols = conn.exec_driver_sql("PRAGMA table_info(topic);").fetchall()
            topic_existing = {row[1] for row in topic_cols}
            if "color" not in topic_existing:
                conn.exec_driver_sql("ALTER TABLE topic ADD COLUMN color TEXT;")
            if "sortIndex" not in topic_existing:
                conn.exec_driver_sql("ALTER TABLE topic ADD COLUMN sortIndex INTEGER NOT NULL DEFAULT 0;")
                # Preserve current ordering (pinned first, most recently updated first) so upgrading instances
                # do not suddenly reshuffle topics when the UI starts using sortIndex.
                rows = conn.exec_driver_sql(
                    'SELECT id FROM topic ORDER BY COALESCE(pinned, 0) DESC, "updatedAt" DESC, id ASC;'
                ).fetchall()
                for idx, row in enumerate(rows):
                    conn.exec_driver_sql("UPDATE topic SET sortIndex = ? WHERE id = ?;", (idx, row[0]))
            if "snoozedUntil" not in topic_existing:
                conn.exec_driver_sql("ALTER TABLE topic ADD COLUMN snoozedUntil TEXT;")
            if "createdBy" not in topic_existing:
                conn.exec_driver_sql("ALTER TABLE topic ADD COLUMN createdBy TEXT NOT NULL DEFAULT 'user';")
            if "digest" not in topic_existing:
                conn.exec_driver_sql("ALTER TABLE topic ADD COLUMN digest TEXT;")
            if "digestUpdatedAt" not in topic_existing:
                conn.exec_driver_sql("ALTER TABLE topic ADD COLUMN digestUpdatedAt TEXT;")
            if "spaceId" not in topic_existing:
                conn.exec_driver_sql(
                    f"ALTER TABLE topic ADD COLUMN spaceId TEXT NOT NULL DEFAULT '{DEFAULT_SPACE_ID}';"
                )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_topic_space_updated_at "
                'ON topic("spaceId", "updatedAt");'
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_topic_created_at "
                'ON topic("createdAt");'
            )
            conn.exec_driver_sql("UPDATE topic SET tags = '[]' WHERE tags IS NULL;")
            conn.exec_driver_sql(
                f"UPDATE topic SET spaceId = '{DEFAULT_SPACE_ID}' WHERE spaceId IS NULL OR trim(spaceId) = '';"
            )

            task_cols = conn.exec_driver_sql("PRAGMA table_info(task);").fetchall()
            task_existing = {row[1] for row in task_cols}
            if "color" not in task_existing:
                conn.exec_driver_sql("ALTER TABLE task ADD COLUMN color TEXT;")
            if "sortIndex" not in task_existing:
                conn.exec_driver_sql("ALTER TABLE task ADD COLUMN sortIndex INTEGER NOT NULL DEFAULT 0;")
                # Preserve current ordering within each topic (pinned first, most recently updated first).
                rows = conn.exec_driver_sql(
                    'SELECT id, "topicId" FROM task '
                    'ORDER BY COALESCE("topicId", \'\') ASC, COALESCE(pinned, 0) DESC, "updatedAt" DESC, id ASC;'
                ).fetchall()
                last_topic_id = object()
                local_idx = 0
                for row in rows:
                    task_id, topic_id = row[0], row[1]
                    if topic_id != last_topic_id:
                        last_topic_id = topic_id
                        local_idx = 0
                    conn.exec_driver_sql("UPDATE task SET sortIndex = ? WHERE id = ?;", (local_idx, task_id))
                    local_idx += 1
            if "tags" not in task_existing:
                conn.exec_driver_sql("ALTER TABLE task ADD COLUMN tags JSON;")
            if "snoozedUntil" not in task_existing:
                conn.exec_driver_sql("ALTER TABLE task ADD COLUMN snoozedUntil TEXT;")
            if "digest" not in task_existing:
                conn.exec_driver_sql("ALTER TABLE task ADD COLUMN digest TEXT;")
            if "digestUpdatedAt" not in task_existing:
                conn.exec_driver_sql("ALTER TABLE task ADD COLUMN digestUpdatedAt TEXT;")
            if "spaceId" not in task_existing:
                conn.exec_driver_sql(
                    f"ALTER TABLE task ADD COLUMN spaceId TEXT NOT NULL DEFAULT '{DEFAULT_SPACE_ID}';"
                )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_task_space_updated_at "
                'ON task("spaceId", "updatedAt");'
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_task_created_at "
                'ON task("createdAt");'
            )
            conn.exec_driver_sql("UPDATE task SET tags = '[]' WHERE tags IS NULL;")
            conn.exec_driver_sql(
                "UPDATE task "
                "SET spaceId = COALESCE((SELECT spaceId FROM topic WHERE topic.id = task.topicId), spaceId, "
                f"'{DEFAULT_SPACE_ID}') "
                "WHERE topicId IS NOT NULL;"
            )
            conn.exec_driver_sql(
                f"UPDATE task SET spaceId = '{DEFAULT_SPACE_ID}' WHERE spaceId IS NULL OR trim(spaceId) = '';"
            )

            # Keep log space in sync with task/topic ownership.
            conn.exec_driver_sql(
                "UPDATE logentry "
                "SET spaceId = COALESCE((SELECT spaceId FROM task WHERE task.id = logentry.taskId), "
                "(SELECT spaceId FROM topic WHERE topic.id = logentry.topicId), spaceId, "
                f"'{DEFAULT_SPACE_ID}');"
            )
            conn.exec_driver_sql(
                f"UPDATE logentry SET spaceId = '{DEFAULT_SPACE_ID}' WHERE spaceId IS NULL OR trim(spaceId) = '';"
            )

            space_cols = conn.exec_driver_sql("PRAGMA table_info(space);").fetchall()
            space_existing = {row[1] for row in space_cols}
            if "connectivity" not in space_existing:
                conn.exec_driver_sql("ALTER TABLE space ADD COLUMN connectivity JSON NOT NULL DEFAULT '{}';")
            if "defaultVisible" not in space_existing:
                conn.exec_driver_sql("ALTER TABLE space ADD COLUMN defaultVisible INTEGER NOT NULL DEFAULT 1;")
            conn.exec_driver_sql("UPDATE space SET connectivity = '{}' WHERE connectivity IS NULL;")
            conn.exec_driver_sql("UPDATE space SET defaultVisible = 1 WHERE defaultVisible IS NULL;")

            # Ensure default space row exists (table is created via SQLModel metadata).
            stamp = _now_iso()
            conn.exec_driver_sql(
                "INSERT OR IGNORE INTO space (id, name, color, defaultVisible, connectivity, createdAt, updatedAt) "
                "VALUES (?, ?, NULL, ?, ?, ?, ?);",
                (DEFAULT_SPACE_ID, DEFAULT_SPACE_NAME, 1, "{}", stamp, stamp),
            )

            # Migrate legacy default visibility key out of connectivity into the first-class column.
            rows = conn.exec_driver_sql("SELECT id, connectivity, defaultVisible FROM space;").fetchall()
            for row in rows:
                space_id = str(row[0] or "").strip()
                if not space_id:
                    continue
                raw_connectivity = row[1]
                raw_default_visible = row[2]
                parsed = {}
                if isinstance(raw_connectivity, dict):
                    parsed = raw_connectivity
                elif isinstance(raw_connectivity, str):
                    try:
                        decoded = json.loads(raw_connectivity)
                        if isinstance(decoded, dict):
                            parsed = decoded
                    except Exception:
                        parsed = {}
                has_legacy_default_key = isinstance(parsed, dict) and SPACE_DEFAULT_VISIBILITY_KEY in parsed
                normalized_connectivity = _normalize_space_connectivity(parsed)
                serialized_connectivity = json.dumps(normalized_connectivity, separators=(",", ":"), sort_keys=True)

                current_default_visible = bool(raw_default_visible) if raw_default_visible is not None else True
                next_default_visible = current_default_visible
                if has_legacy_default_key:
                    next_default_visible = bool(parsed.get(SPACE_DEFAULT_VISIBILITY_KEY))

                connectivity_needs_update = has_legacy_default_key
                if isinstance(raw_connectivity, str):
                    connectivity_needs_update = connectivity_needs_update or (raw_connectivity.strip() != serialized_connectivity)
                elif isinstance(raw_connectivity, dict):
                    connectivity_needs_update = connectivity_needs_update or (raw_connectivity != normalized_connectivity)
                else:
                    connectivity_needs_update = True

                default_needs_update = (raw_default_visible is None) or (current_default_visible != next_default_visible)

                if connectivity_needs_update or default_needs_update:
                    conn.exec_driver_sql(
                        "UPDATE space SET defaultVisible = ?, connectivity = ? WHERE id = ?;",
                        (
                            1 if next_default_visible else 0,
                            serialized_connectivity,
                            space_id,
                        ),
                    )

            # Seed missing explicit connectivity edges once from defaultVisible.
            # Runtime visibility checks use explicit edges only.
            rows = conn.exec_driver_sql("SELECT id, connectivity, defaultVisible FROM space;").fetchall()
            by_id: dict[str, tuple[dict[str, bool], bool]] = {}
            for row in rows:
                space_id = str(row[0] or "").strip()
                if not space_id:
                    continue
                parsed = _normalize_space_connectivity(row[1])
                default_visible = bool(row[2]) if row[2] is not None else True
                by_id[space_id] = (parsed, default_visible)

            if by_id:
                valid_ids = set(by_id.keys())
                seed_stamp = _now_iso()
                for source_id, (connectivity, _default_visible) in by_id.items():
                    next_connectivity: dict[str, bool] = {}
                    changed = False
                    for target_id, enabled in connectivity.items():
                        if target_id == source_id:
                            changed = True
                            continue
                        if target_id not in valid_ids:
                            changed = True
                            continue
                        next_connectivity[target_id] = bool(enabled)
                    for target_id in valid_ids:
                        if target_id == source_id:
                            continue
                        if target_id in next_connectivity:
                            continue
                        target_default = by_id[target_id][1]
                        next_connectivity[target_id] = bool(target_default)
                        changed = True
                    if not changed:
                        continue
                    serialized_connectivity = json.dumps(next_connectivity, separators=(",", ":"), sort_keys=True)
                    conn.exec_driver_sql(
                        "UPDATE space SET connectivity = ?, updatedAt = ? WHERE id = ?;",
                        (serialized_connectivity, seed_stamp, source_id),
                    )

            conn.commit()

    # Backfill missing topic/task colors once so existing instances get stable hues.
    try:
        from .models import Topic, Task, Space  # local import avoids circulars at module import time

        with Session(engine) as session:
            if not session.get(Space, DEFAULT_SPACE_ID):
                stamp = _now_iso()
                session.add(
                    Space(
                        id=DEFAULT_SPACE_ID,
                        name=DEFAULT_SPACE_NAME,
                        color=None,
                        defaultVisible=True,
                        connectivity={},
                        createdAt=stamp,
                        updatedAt=stamp,
                    )
                )

            topics = session.exec(select(Topic)).all()
            topic_updates = 0
            for topic in topics:
                # Legacy normalization: older versions used "paused" for snoozed topics.
                status = str(getattr(topic, "status", "") or "").strip().lower()
                if status == "paused":
                    topic.status = "snoozed"
                    topic_updates += 1

                normalized = _normalize_hex_color(getattr(topic, "color", None))
                if normalized:
                    if topic.color != normalized:
                        topic.color = normalized
                        topic_updates += 1
                    continue
                topic.color = _auto_color(f"topic:{topic.id}:{topic.name}", 0.0)
                topic_updates += 1

                if not str(getattr(topic, "spaceId", "") or "").strip():
                    topic.spaceId = DEFAULT_SPACE_ID
                    topic_updates += 1

            tasks = session.exec(select(Task)).all()
            task_updates = 0
            for task in tasks:
                topic_space_id = None
                if getattr(task, "topicId", None):
                    parent = next((item for item in topics if item.id == task.topicId), None)
                    if parent and str(getattr(parent, "spaceId", "") or "").strip():
                        topic_space_id = parent.spaceId
                if topic_space_id:
                    if task.spaceId != topic_space_id:
                        task.spaceId = topic_space_id
                        task_updates += 1
                elif not str(getattr(task, "spaceId", "") or "").strip():
                    task.spaceId = DEFAULT_SPACE_ID
                    task_updates += 1

                normalized = _normalize_hex_color(getattr(task, "color", None))
                if normalized:
                    if task.color != normalized:
                        task.color = normalized
                        task_updates += 1
                    continue
                task.color = _auto_color(f"task:{task.id}:{task.title}", 21.0)
                task_updates += 1

            if topic_updates or task_updates:
                session.commit()
    except Exception:
        pass


def get_session() -> Session:
    return Session(engine)
