from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Iterable

from sqlalchemy import func, text
from sqlmodel import select

from .db import DATABASE_URL, get_session
from .events import event_hub
from .models import Space, Topic, Task, LogEntry, SessionRoutingMemory

__all__ = [
    "DEFAULT_SPACE_ID",
    "DEFAULT_SPACE_NAME",
    "SPACE_DEFAULT_VISIBILITY_KEY",
    "now_iso",
    "_normalize_space_id",
    "_normalize_connectivity",
    "_space_default_visibility",
    "_seed_missing_space_connectivity",
    "_ensure_default_space",
    "_list_spaces",
    "_parse_space_ids_csv",
    "_allowed_space_ids_for_source",
    "_resolve_allowed_space_ids",
    "_normalize_tag_value",
    "_clean_tag_label",
    "_normalize_tags",
    "_space_id_for_topic",
    "_space_id_for_task",
    "_space_id_from_log_scope",
    "_infer_space_id_from_session_key",
    "_resolve_source_space_id",
    "_publish_space_upserted",
    "_space_display_name_from_id",
    "_space_id_from_label",
    "_ensure_space_row",
    "_topic_space_candidates_from_tags",
    "_resolve_space_id_from_topic_tags",
    "_topic_space_ids",
    "_topic_matches_allowed_spaces",
    "_task_matches_allowed_spaces",
    "_load_topics_by_ids",
    "_load_tasks_by_ids",
    "_load_related_maps_for_logs",
    "_log_matches_allowed_spaces",
    "_propagate_topic_space",
    "_allowed_space_ids_cache_key",
]


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_SPACE_ID = (os.getenv("CLAWBOARD_DEFAULT_SPACE_ID", "space-default") or "space-default").strip() or "space-default"
DEFAULT_SPACE_NAME = (os.getenv("CLAWBOARD_DEFAULT_SPACE_NAME", "Default") or "Default").strip() or "Default"
# Legacy key supported only for one-way migration compatibility.
SPACE_DEFAULT_VISIBILITY_KEY = "__claw_default_visible"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def now_iso() -> str:
    # Always emit a stable, lexicographically sortable UTC ISO string.
    # Using a fixed timespec avoids mixed precision (seconds vs micros) which can break ordering.
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _chunked_values(values: list[str], chunk_size: int) -> Iterable[list[str]]:
    size = max(1, int(chunk_size or 1))
    for index in range(0, len(values), size):
        chunk = values[index : index + size]
        if chunk:
            yield chunk


# ---------------------------------------------------------------------------
# Space normalisation & connectivity
# ---------------------------------------------------------------------------

def _normalize_space_id(value: str | None) -> str | None:
    if value is None:
        return None
    text_ = str(value).strip()
    return text_ or None


def _normalize_connectivity(value: Any) -> dict[str, bool]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, bool] = {}
    for raw_key, raw_value in value.items():
        key = _normalize_space_id(str(raw_key))
        if not key:
            continue
        if key == SPACE_DEFAULT_VISIBILITY_KEY:
            continue
        out[key] = bool(raw_value)
    return out


def _space_default_visibility(space: Space | None) -> bool:
    if not space:
        return True
    raw = getattr(space, "defaultVisible", None)
    if isinstance(raw, bool):
        return raw
    if raw is not None:
        return bool(raw)
    # Legacy fallback when serving very old rows before migration has run.
    legacy = getattr(space, "connectivity", None)
    if isinstance(legacy, dict) and SPACE_DEFAULT_VISIBILITY_KEY in legacy:
        return bool(legacy.get(SPACE_DEFAULT_VISIBILITY_KEY))
    return True


def _seed_missing_space_connectivity(
    session: Any,
    *,
    spaces: list[Space] | None = None,
    seed_space_ids: set[str] | None = None,
    stamp: str | None = None,
) -> list[Space]:
    """Seed missing explicit connectivity entries from target defaultVisible.

    This is a one-time expansion strategy: once an edge exists in connectivity, runtime
    visibility resolution relies on that explicit edge only. If `seed_space_ids` is
    provided, only edges touching those spaces are auto-initialized.
    """

    rows = list(spaces) if spaces is not None else session.exec(select(Space)).all()
    by_id: dict[str, Space] = {
        str(item.id): item for item in rows if str(getattr(item, "id", "") or "").strip()
    }
    if not by_id:
        return []

    valid_ids = set(by_id.keys())
    seeded_ids = (
        {space_id for space_id in (seed_space_ids or set()) if space_id in valid_ids}
        if seed_space_ids is not None
        else None
    )
    next_stamp = stamp or now_iso()
    touched: list[Space] = []

    for source_id, source_row in by_id.items():
        current = _normalize_connectivity(getattr(source_row, "connectivity", None))
        next_connectivity: dict[str, bool] = {}
        changed = False

        for target_id, enabled in current.items():
            if target_id == source_id:
                changed = True
                continue
            if target_id not in valid_ids:
                changed = True
                continue
            next_connectivity[target_id] = bool(enabled)

        for target_id, target_row in by_id.items():
            if target_id == source_id:
                continue
            if target_id in next_connectivity:
                continue
            if seeded_ids is not None and source_id not in seeded_ids and target_id not in seeded_ids:
                continue
            next_connectivity[target_id] = _space_default_visibility(target_row)
            changed = True

        if not changed and next_connectivity == current:
            continue

        source_row.connectivity = next_connectivity
        source_row.updatedAt = next_stamp
        session.add(source_row)
        touched.append(source_row)

    return touched


def _ensure_default_space(session: Any) -> Space:
    row = session.get(Space, DEFAULT_SPACE_ID)
    if row:
        changed = False
        resolved_default_visible = _space_default_visibility(row)
        if not str(getattr(row, "name", "") or "").strip():
            row.name = DEFAULT_SPACE_NAME
            changed = True
        normalized = _normalize_connectivity(getattr(row, "connectivity", None))
        if normalized != (row.connectivity or {}):
            row.connectivity = normalized
            changed = True
        if not isinstance(getattr(row, "defaultVisible", None), bool):
            row.defaultVisible = resolved_default_visible
            changed = True
        if changed:
            row.updatedAt = now_iso()
            session.add(row)
            session.commit()
            session.refresh(row)
        return row

    stamp = now_iso()
    row = Space(
        id=DEFAULT_SPACE_ID,
        name=DEFAULT_SPACE_NAME,
        color=None,
        defaultVisible=True,
        connectivity={},
        createdAt=stamp,
        updatedAt=stamp,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def _list_spaces(session: Any) -> list[Space]:
    _ensure_default_space(session)
    touched = False
    for topic in session.exec(select(Topic)).all():
        for resolved_space_id, label in _topic_space_candidates_from_tags(getattr(topic, "tags", None)):
            if session.get(Space, resolved_space_id):
                continue
            _ensure_space_row(
                session,
                space_id=resolved_space_id,
                name=label if resolved_space_id != DEFAULT_SPACE_ID else DEFAULT_SPACE_NAME,
            )
            touched = True
    if touched:
        session.commit()
    spaces = session.exec(select(Space)).all()
    if not spaces:
        spaces = [_ensure_default_space(session)]
    return spaces


# ---------------------------------------------------------------------------
# Space ID parsing & resolution
# ---------------------------------------------------------------------------

def _parse_space_ids_csv(value: str | None) -> set[str] | None:
    if value is None:
        return None
    parts = [part.strip() for part in str(value).split(",")]
    ids = {part for part in parts if part}
    return ids


def _allowed_space_ids_for_source(session: Any, source_space_id: str | None) -> set[str]:
    spaces = _list_spaces(session)
    by_id: dict[str, Space] = {str(item.id): item for item in spaces if str(getattr(item, "id", "")).strip()}
    if not by_id:
        return {DEFAULT_SPACE_ID}

    normalized_source = _normalize_space_id(source_space_id)
    source_id = normalized_source if normalized_source in by_id else DEFAULT_SPACE_ID
    source_row = by_id.get(source_id) or by_id.get(DEFAULT_SPACE_ID) or next(iter(by_id.values()))
    source_id = str(source_row.id)

    toggles = _normalize_connectivity(getattr(source_row, "connectivity", None))
    allowed = {source_id}
    for candidate_id in by_id.keys():
        if candidate_id == source_id:
            continue
        if bool(toggles.get(candidate_id)):
            allowed.add(candidate_id)
    return allowed


def _resolve_allowed_space_ids(
    session: Any,
    *,
    source_space_id: str | None = None,
    allowed_space_ids_raw: str | None = None,
) -> set[str] | None:
    explicit = _parse_space_ids_csv(allowed_space_ids_raw)
    normalized = _normalize_space_id(source_space_id)
    if explicit is not None:
        if normalized:
            baseline = _allowed_space_ids_for_source(session, normalized)
            return explicit & baseline
        return explicit
    if not normalized:
        return None
    return _allowed_space_ids_for_source(session, normalized)


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

def _normalize_tag_value(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered.startswith("system:"):
        suffix = lowered.split(":", 1)[1].strip()
        return f"system:{suffix}" if suffix else "system"
    slug = re.sub(r"\s+", "-", lowered)
    slug = re.sub(r"[^a-z0-9:_-]+", "", slug)
    slug = re.sub(r":{2,}", ":", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug or None


def _clean_tag_label(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _normalize_tags(values: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values or []:
        label = _clean_tag_label(raw)
        tag = _normalize_tag_value(label)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        out.append(label)
        if len(out) >= 32:
            break
    return out


# ---------------------------------------------------------------------------
# Space ID for entities
# ---------------------------------------------------------------------------

def _space_id_for_topic(topic: Topic | None) -> str:
    if not topic:
        return DEFAULT_SPACE_ID
    normalized = _normalize_space_id(getattr(topic, "spaceId", None))
    return normalized or DEFAULT_SPACE_ID


def _space_id_for_task(task: Task | None) -> str:
    if not task:
        return DEFAULT_SPACE_ID
    normalized = _normalize_space_id(getattr(task, "spaceId", None))
    return normalized or DEFAULT_SPACE_ID


def _space_id_from_log_scope(entry: LogEntry | None) -> str | None:
    if not entry:
        return None
    source = getattr(entry, "source", None)
    if isinstance(source, dict):
        scoped = _normalize_space_id(source.get("boardScopeSpaceId"))
        if scoped:
            return scoped
    return _normalize_space_id(getattr(entry, "spaceId", None))


def _infer_space_id_from_session_key(session: Any, session_key: str | None) -> str | None:
    normalized_session_key = str(session_key or "").strip()
    if not normalized_session_key:
        return None

    # Late import to avoid circular dependency.
    from .main import _parse_board_session_key

    board_topic_id, board_task_id = _parse_board_session_key(normalized_session_key)
    base_session_key = normalized_session_key.split("|", 1)[0].strip()
    session_candidates = [normalized_session_key]
    if base_session_key and base_session_key != normalized_session_key:
        session_candidates.append(base_session_key)

    if DATABASE_URL.startswith("sqlite"):
        session_expr = func.json_extract(LogEntry.source, "$.sessionKey")
    else:
        session_expr = LogEntry.source["sessionKey"].as_string()
    for candidate in session_candidates:
        query = (
            select(LogEntry)
            .where(session_expr == candidate)
            .order_by(
                LogEntry.createdAt.desc(),
                (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
            )
            .limit(12)
        )
        rows = session.exec(query).all()
        for row in rows:
            scoped = _space_id_from_log_scope(row)
            if scoped:
                return scoped

    if base_session_key:
        query = (
            select(LogEntry)
            .where(session_expr.like(f"{base_session_key}|%"))
            .order_by(
                LogEntry.createdAt.desc(),
                (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
            )
            .limit(20)
        )
        rows = session.exec(query).all()
        for row in rows:
            scoped = _space_id_from_log_scope(row)
            if scoped:
                return scoped

    if board_task_id:
        task = session.get(Task, board_task_id)
        if task:
            return _space_id_for_task(task)
    if board_topic_id:
        topic = session.get(Topic, board_topic_id)
        if topic:
            return _space_id_for_topic(topic)

    for candidate in session_candidates:
        memory = session.get(SessionRoutingMemory, candidate)
        if not memory:
            continue
        task_id = str(getattr(memory, "taskId", "") or "").strip()
        if task_id:
            task = session.get(Task, task_id)
            if task:
                return _space_id_for_task(task)
        topic_id = str(getattr(memory, "topicId", "") or "").strip()
        if topic_id:
            topic = session.get(Topic, topic_id)
            if topic:
                return _space_id_for_topic(topic)

    return None


def _resolve_source_space_id(
    session: Any,
    *,
    explicit_space_id: str | None = None,
    session_key: str | None = None,
) -> str | None:
    normalized_explicit = _normalize_space_id(explicit_space_id)
    if normalized_explicit:
        return normalized_explicit
    return _infer_space_id_from_session_key(session, session_key)


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

def _publish_space_upserted(space: Space | None) -> None:
    if not space:
        return
    event_hub.publish({"type": "space.upserted", "data": space.model_dump(), "eventTs": space.updatedAt})


# ---------------------------------------------------------------------------
# Label / display helpers
# ---------------------------------------------------------------------------

def _space_display_name_from_id(space_id: str | None) -> str:
    normalized_id = _normalize_space_id(space_id) or DEFAULT_SPACE_ID
    if normalized_id == DEFAULT_SPACE_ID:
        return DEFAULT_SPACE_NAME
    base = re.sub(r"^space[-_]+", "", normalized_id, flags=re.IGNORECASE)
    label = re.sub(r"[-_]+", " ", base).strip()
    if not label:
        return normalized_id
    return " ".join(part.capitalize() for part in label.split(" "))


def _space_id_from_label(label: str | None) -> str:
    raw = str(label or "").strip()
    if not raw:
        return DEFAULT_SPACE_ID
    slug = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
    if not slug:
        return DEFAULT_SPACE_ID
    if slug in {"default", "global", "all", "all-spaces"}:
        return DEFAULT_SPACE_ID
    return f"space-{slug}"


# ---------------------------------------------------------------------------
# Space row persistence
# ---------------------------------------------------------------------------

def _ensure_space_row(session: Any, *, space_id: str, name: str | None = None) -> Space:
    normalized_id = _normalize_space_id(space_id) or DEFAULT_SPACE_ID
    if normalized_id == DEFAULT_SPACE_ID:
        return _ensure_default_space(session)

    row = session.get(Space, normalized_id)
    normalized_name = " ".join(str(name or "").split()).strip()
    if row:
        if normalized_name and row.name != normalized_name:
            row.name = normalized_name
            row.updatedAt = now_iso()
            session.add(row)
        return row

    stamp = now_iso()
    row = Space(
        id=normalized_id,
        name=normalized_name or _space_display_name_from_id(normalized_id),
        color=None,
        defaultVisible=True,
        connectivity={},
        createdAt=stamp,
        updatedAt=stamp,
    )
    session.add(row)
    known_spaces = session.exec(select(Space)).all()
    if not any(str(getattr(item, "id", "") or "").strip() == normalized_id for item in known_spaces):
        known_spaces.append(row)
    _seed_missing_space_connectivity(session, spaces=known_spaces, seed_space_ids={normalized_id})
    return row


# ---------------------------------------------------------------------------
# Tag-based space candidates
# ---------------------------------------------------------------------------

def _topic_space_candidates_from_tags(tags: list[str] | None) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw_tag in tags or []:
        tag = str(raw_tag or "").strip()
        if not tag:
            continue
        lowered = tag.lower()
        if lowered.startswith("system:"):
            continue
        if lowered.startswith("space:"):
            tag = tag.split(":", 1)[1].strip()
            if not tag:
                continue
        label = " ".join(tag.split()).strip()
        if not label:
            continue
        resolved_space_id = _space_id_from_label(label)
        if resolved_space_id in seen:
            continue
        seen.add(resolved_space_id)
        out.append((resolved_space_id, label))
    return out


def _resolve_space_id_from_topic_tags(
    session: Any,
    tags: list[str] | None,
    *,
    fallback_space_id: str | None = None,
) -> str:
    _ensure_default_space(session)
    candidates = _topic_space_candidates_from_tags(tags)
    for resolved_space_id, label in candidates:
        _ensure_space_row(
            session,
            space_id=resolved_space_id,
            name=label if resolved_space_id != DEFAULT_SPACE_ID else DEFAULT_SPACE_NAME,
        )
    if candidates:
        return candidates[0][0]

    fallback = _normalize_space_id(fallback_space_id) or DEFAULT_SPACE_ID
    if fallback == DEFAULT_SPACE_ID:
        _ensure_default_space(session)
        return DEFAULT_SPACE_ID
    if session.get(Space, fallback):
        return fallback
    return DEFAULT_SPACE_ID


# ---------------------------------------------------------------------------
# Space matching
# ---------------------------------------------------------------------------

def _topic_space_ids(topic: Topic | None) -> set[str]:
    if not topic:
        return {DEFAULT_SPACE_ID}
    out = {_space_id_for_topic(topic)}
    for resolved_space_id, _label in _topic_space_candidates_from_tags(getattr(topic, "tags", None)):
        out.add(resolved_space_id)
    return out or {DEFAULT_SPACE_ID}


def _topic_matches_allowed_spaces(topic: Topic | None, allowed_space_ids: set[str]) -> bool:
    return bool(_topic_space_ids(topic) & allowed_space_ids)


def _task_matches_allowed_spaces(task: Task | None, allowed_space_ids: set[str], topic_by_id: dict[str, Topic]) -> bool:
    if not task:
        return False
    if _space_id_for_task(task) in allowed_space_ids:
        return True
    topic_id = str(getattr(task, "topicId", "") or "").strip()
    if not topic_id:
        return False
    topic = topic_by_id.get(topic_id)
    if not topic:
        return False
    return _topic_matches_allowed_spaces(topic, allowed_space_ids)


# ---------------------------------------------------------------------------
# Bulk loading
# ---------------------------------------------------------------------------

def _load_topics_by_ids(session: Any, topic_ids: Iterable[str]) -> dict[str, Topic]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in topic_ids:
        topic_id = str(raw or "").strip()
        if not topic_id or topic_id in seen:
            continue
        seen.add(topic_id)
        normalized.append(topic_id)
    if not normalized:
        return {}
    out: dict[str, Topic] = {}
    for chunk in _chunked_values(normalized, 300):
        rows = session.exec(select(Topic).where(Topic.id.in_(chunk))).all()
        for row in rows:
            row_id = str(getattr(row, "id", "") or "").strip()
            if row_id:
                out[row_id] = row
    return out


def _load_tasks_by_ids(session: Any, task_ids: Iterable[str]) -> dict[str, Task]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in task_ids:
        task_id = str(raw or "").strip()
        if not task_id or task_id in seen:
            continue
        seen.add(task_id)
        normalized.append(task_id)
    if not normalized:
        return {}
    out: dict[str, Task] = {}
    for chunk in _chunked_values(normalized, 300):
        rows = session.exec(select(Task).where(Task.id.in_(chunk))).all()
        for row in rows:
            row_id = str(getattr(row, "id", "") or "").strip()
            if row_id:
                out[row_id] = row
    return out


def _load_related_maps_for_logs(
    session: Any,
    logs: Iterable[LogEntry],
    *,
    seeded_topics: dict[str, Topic] | None = None,
    seeded_tasks: dict[str, Task] | None = None,
) -> tuple[dict[str, Topic], dict[str, Task]]:
    topic_by_id: dict[str, Topic] = dict(seeded_topics or {})
    task_by_id: dict[str, Task] = dict(seeded_tasks or {})

    missing_task_ids: set[str] = set()
    missing_topic_ids: set[str] = set()

    for entry in logs:
        task_id = str(getattr(entry, "taskId", "") or "").strip()
        if task_id and task_id not in task_by_id:
            missing_task_ids.add(task_id)
        topic_id = str(getattr(entry, "topicId", "") or "").strip()
        if topic_id and topic_id not in topic_by_id:
            missing_topic_ids.add(topic_id)

    if missing_task_ids:
        loaded_tasks = _load_tasks_by_ids(session, missing_task_ids)
        task_by_id.update(loaded_tasks)
        for task in loaded_tasks.values():
            topic_id = str(getattr(task, "topicId", "") or "").strip()
            if topic_id and topic_id not in topic_by_id:
                missing_topic_ids.add(topic_id)

    if missing_topic_ids:
        loaded_topics = _load_topics_by_ids(session, missing_topic_ids)
        topic_by_id.update(loaded_topics)

    return topic_by_id, task_by_id


def _log_matches_allowed_spaces(
    entry: LogEntry | None,
    allowed_space_ids: set[str],
    topic_by_id: dict[str, Topic],
    task_by_id: dict[str, Task],
) -> bool:
    if not entry:
        return False

    direct_space_id = _normalize_space_id(getattr(entry, "spaceId", None)) or DEFAULT_SPACE_ID
    if direct_space_id in allowed_space_ids:
        return True

    task_id = str(getattr(entry, "taskId", "") or "").strip()
    if task_id:
        task = task_by_id.get(task_id)
        if task and _task_matches_allowed_spaces(task, allowed_space_ids, topic_by_id):
            return True

    topic_id = str(getattr(entry, "topicId", "") or "").strip()
    if topic_id:
        topic = topic_by_id.get(topic_id)
        if topic and _topic_matches_allowed_spaces(topic, allowed_space_ids):
            return True

    return False


def _propagate_topic_space(session: Any, topic: Topic, *, stamp: str) -> None:
    topic_space_id = _space_id_for_topic(topic)
    scoped_tasks = session.exec(select(Task).where(Task.topicId == topic.id)).all()
    for scoped_task in scoped_tasks:
        if _space_id_for_task(scoped_task) == topic_space_id:
            continue
        scoped_task.spaceId = topic_space_id
        scoped_task.updatedAt = stamp
        session.add(scoped_task)
    scoped_logs = session.exec(select(LogEntry).where(LogEntry.topicId == topic.id)).all()
    for scoped_log in scoped_logs:
        current_log_space = _normalize_space_id(getattr(scoped_log, "spaceId", None)) or DEFAULT_SPACE_ID
        if current_log_space == topic_space_id:
            continue
        scoped_log.spaceId = topic_space_id
        scoped_log.updatedAt = stamp
        session.add(scoped_log)


# ---------------------------------------------------------------------------
# Cache key helper
# ---------------------------------------------------------------------------

def _allowed_space_ids_cache_key(allowed_space_ids: set[str] | None) -> str:
    if allowed_space_ids is None:
        return "*"
    if not allowed_space_ids:
        return "-"
    return ",".join(sorted({str(space_id).strip() for space_id in allowed_space_ids if str(space_id).strip()}))
