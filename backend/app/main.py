from __future__ import annotations

import os
import json
import hashlib
import base64
import heapq
import queue
from io import BytesIO
import colorsys
import asyncio
import threading
import time
import re
from pathlib import Path
import urllib.request
import urllib.error
from difflib import SequenceMatcher
from datetime import datetime, timezone, timedelta
from fastapi import Request
from uuid import uuid4
from fastapi import FastAPI, Depends, Query, Body, HTTPException, Header, BackgroundTasks, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from typing import List, Any, Iterable, Callable
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, text, or_, and_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import defer
from sqlmodel import select

from .auth import ensure_read_access, ensure_write_access, is_token_configured, is_token_required, require_token
from .db import DATABASE_URL, init_db, get_session
from .models import Space, InstanceConfig, Topic, Task, LogEntry, DeletedLog, SessionRoutingMemory, IngestQueue, Attachment, Draft
from .schemas import (
    SpaceOut,
    SpaceUpsert,
    SpaceConnectivityPatch,
    SpaceAllowedResponse,
    StartFreshReplayRequest,
    InstanceUpdate,
    InstanceResponse,
    InstanceOut,
    TopicUpsert,
    TopicOut,
    TopicReorderRequest,
    TopicPatch,
    TaskUpsert,
    TaskOut,
    TaskReorderRequest,
    TaskPatch,
    LogAppend,
    LogOut,
    LogOutLite,
    LogPatch,
    ChangesResponse,
    ClawgraphResponse,
    ContextResponse,
    OpenClawChatRequest,
    OpenClawChatQueuedResponse,
    ReindexRequest,
    AttachmentOut,
    DraftUpsert,
    DraftOut,
    SessionRoutingMemoryOut,
    SessionRoutingAppend,
    ClassifierReplayRequest,
    ClassifierReplayResponse,
)
from .schemas_openclaw_skills import OpenClawSkillsResponse
from .openclaw_gateway import gateway_rpc
from .events import event_hub
from .clawgraph import build_clawgraph
from .vector_search import semantic_search

app = FastAPI(
    title="Clawboard API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    description="Clawboard API for topics, tasks, logs, and live updates.",
)

cors_origins = os.getenv("CLAWBOARD_CORS_ORIGINS", "*")
allowed_origins = [o.strip() for o in cors_origins.split(",") if o.strip()]
if not allowed_origins:
    allowed_origins = ["*"]

# In development, be permissive with local and Tailscale origins
if os.getenv("CLAWBOARD_WEB_HOT_RELOAD") == "1" or "*" in allowed_origins:
    allowed_origins = ["*"]
else:
    # Ensure both local and Tailscale origins are allowed
    extra_origins = [
        "http://localhost:3010",
        "http://100.91.119.30:3010",
        "http://localhost:3000",
        "http://127.0.0.1:3010",
        "http://127.0.0.1:3000",
    ]
    for origin in extra_origins:
        if origin not in allowed_origins:
            allowed_origins.append(origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if "*" in allowed_origins else allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def enforce_api_access_policy(request: Request, call_next):
    path = request.url.path
    if not path.startswith("/api"):
        return await call_next(request)

    method = request.method.upper()
    if method == "OPTIONS":
        return await call_next(request)

    if request.query_params.get("token") is not None:
        return JSONResponse(
            status_code=400,
            content={
                "detail": "Do not pass token via query param. Use X-Clawboard-Token header."
            },
        )

    provided_token = request.headers.get("x-clawboard-token")
    try:
        if method in {"GET", "HEAD"}:
            ensure_read_access(request, provided_token)
        else:
            ensure_write_access(provided_token)
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    return await call_next(request)


def now_iso() -> str:
    # Always emit a stable, lexicographically sortable UTC ISO string.
    # Using a fixed timespec avoids mixed precision (seconds vs micros) which can break ordering.
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_iso(value: str | None) -> str | None:
    """Normalize a timestamp to our canonical UTC ISO string (milliseconds + Z)."""
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        # Python can't parse trailing "Z" via fromisoformat.
        candidate = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
        dt = datetime.fromisoformat(candidate)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except Exception:
        return None


def normalize_topic_status(value: str | None) -> str | None:
    """Normalize topic status values.

    Canonical values are: active | snoozed | archived.
    Legacy alias: paused -> snoozed.
    """

    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered == "paused":
        return "snoozed"
    if lowered in {"active", "snoozed", "archived"}:
        return lowered
    return raw


def create_id(prefix: str) -> str:
    return f"{prefix}-{uuid4()}"


DEFAULT_SPACE_ID = (os.getenv("CLAWBOARD_DEFAULT_SPACE_ID", "space-default") or "space-default").strip() or "space-default"
DEFAULT_SPACE_NAME = (os.getenv("CLAWBOARD_DEFAULT_SPACE_NAME", "Default") or "Default").strip() or "Default"
# Legacy key supported only for one-way migration compatibility.
SPACE_DEFAULT_VISIBILITY_KEY = "__claw_default_visible"


def _normalize_space_id(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


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
    for candidate_id, candidate_row in by_id.items():
        if candidate_id == source_id:
            continue
        enabled = toggles.get(candidate_id)
        if enabled is None:
            enabled = _space_default_visibility(candidate_row)
        if enabled:
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


def _normalize_tag_value(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered.startswith("system:"):
        suffix = lowered.split(":", 1)[1].strip()
        return f"system:{suffix}" if suffix else "system"
    slug = re.sub(r"\s+", "-", lowered)
    slug = re.sub(r"[^a-z0-9-]+", "", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug or None


def _normalize_tags(values: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values or []:
        tag = _normalize_tag_value(raw)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        out.append(tag)
        if len(out) >= 32:
            break
    return out


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

    board_topic_id, board_task_id = _parse_board_session_key(normalized_session_key)
    base_session_key = normalized_session_key.split("|", 1)[0].strip()
    session_candidates = [normalized_session_key]
    if base_session_key and base_session_key != normalized_session_key:
        session_candidates.append(base_session_key)

    session_expr = func.json_extract(LogEntry.source, "$.sessionKey")
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


def _publish_space_upserted(space: Space | None) -> None:
    if not space:
        return
    event_hub.publish({"type": "space.upserted", "data": space.model_dump(), "eventTs": space.updatedAt})


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
    return row


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


REINDEX_QUEUE_PATH = os.getenv("CLAWBOARD_REINDEX_QUEUE_PATH", "./data/reindex-queue.jsonl")
SEARCH_INCLUDE_TOOL_CALL_LOGS = str(os.getenv("CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS", "0") or "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
TOPIC_LOG_PROPAGATION_FACTOR = 0.22
TOPIC_LOG_PROPAGATION_PER_LOG_CAP = 0.18
TOPIC_LOG_PROPAGATION_TOP_K = 6
TOPIC_LOG_PROPAGATION_CAP = 0.42
TOPIC_TASK_PROPAGATION_FACTOR = 0.32
TOPIC_TASK_PROPAGATION_PER_TASK_CAP = 0.24
TOPIC_TASK_PROPAGATION_LEXICAL_FACTOR = 2.8
TOPIC_TASK_PROPAGATION_LEXICAL_CAP = 0.34
TOPIC_TASK_PROPAGATION_EXACT_BONUS = 0.22
TOPIC_TASK_PROPAGATION_PER_TASK_TOTAL_CAP = 0.62
TOPIC_TASK_PROPAGATION_TOP_K = 3
TOPIC_TASK_PROPAGATION_CAP = 0.72
TOPIC_TASK_PROPAGATION_TOPIC_EXACT_BONUS = 0.12
TASK_LOG_PROPAGATION_FACTOR = 0.25
TASK_LOG_PROPAGATION_PER_LOG_CAP = 0.2
TASK_LOG_PROPAGATION_TOP_K = 6
TASK_LOG_PROPAGATION_CAP = 0.48
SEARCH_LOG_CONTENT_SNIPPET_CHARS = int(os.getenv("CLAWBOARD_SEARCH_LOG_CONTENT_SNIPPET_CHARS", "640") or "640")
SEARCH_LOG_TEXT_BUDGET_CHARS = int(os.getenv("CLAWBOARD_SEARCH_LOG_TEXT_BUDGET_CHARS", "960") or "960")
SEARCH_LOG_CONTENT_PREVIEW_SCAN_LIMIT = int(os.getenv("CLAWBOARD_SEARCH_LOG_CONTENT_PREVIEW_SCAN_LIMIT", "320") or "320")
SEARCH_LOG_CONTENT_MATCH_SCAN_LIMIT = int(os.getenv("CLAWBOARD_SEARCH_LOG_CONTENT_MATCH_SCAN_LIMIT", "120") or "120")
SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS = int(os.getenv("CLAWBOARD_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS", "1800") or "1800")
SEARCH_LOG_CONTENT_ID_CHUNK_SIZE = 320
SEARCH_EFFECTIVE_LIMIT_TOPICS = int(os.getenv("CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TOPICS", "120") or "120")
SEARCH_EFFECTIVE_LIMIT_TASKS = int(os.getenv("CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TASKS", "240") or "240")
SEARCH_EFFECTIVE_LIMIT_LOGS = int(os.getenv("CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_LOGS", "320") or "320")
SEARCH_WINDOW_MULTIPLIER = int(os.getenv("CLAWBOARD_SEARCH_WINDOW_MULTIPLIER", "2") or "2")
SEARCH_WINDOW_MIN_LOGS = int(os.getenv("CLAWBOARD_SEARCH_WINDOW_MIN_LOGS", "320") or "320")
SEARCH_WINDOW_MAX_LOGS = int(os.getenv("CLAWBOARD_SEARCH_WINDOW_MAX_LOGS", "2000") or "2000")
SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS = int(os.getenv("CLAWBOARD_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS", "360") or "360")
SEARCH_CONCURRENCY_LIMIT = int(os.getenv("CLAWBOARD_SEARCH_CONCURRENCY_LIMIT", "3") or "3")
SEARCH_CONCURRENCY_WAIT_SECONDS = float(os.getenv("CLAWBOARD_SEARCH_CONCURRENCY_WAIT_SECONDS", "0.25") or "0.25")
SEARCH_BUSY_FALLBACK_LIMIT_TOPICS = int(os.getenv("CLAWBOARD_SEARCH_BUSY_FALLBACK_LIMIT_TOPICS", "64") or "64")
SEARCH_BUSY_FALLBACK_LIMIT_TASKS = int(os.getenv("CLAWBOARD_SEARCH_BUSY_FALLBACK_LIMIT_TASKS", "160") or "160")
SEARCH_BUSY_FALLBACK_LIMIT_LOGS = int(os.getenv("CLAWBOARD_SEARCH_BUSY_FALLBACK_LIMIT_LOGS", "180") or "180")
SEARCH_DIRECT_LABEL_EXACT_BOOST = float(os.getenv("CLAWBOARD_SEARCH_DIRECT_LABEL_EXACT_BOOST", "0.38") or "0.38")
SEARCH_DIRECT_LABEL_PREFIX_BOOST = float(os.getenv("CLAWBOARD_SEARCH_DIRECT_LABEL_PREFIX_BOOST", "0.2") or "0.2")
SEARCH_DIRECT_LABEL_COVERAGE_BOOST = float(os.getenv("CLAWBOARD_SEARCH_DIRECT_LABEL_COVERAGE_BOOST", "0.16") or "0.16")
_SEARCH_QUERY_GATE = threading.BoundedSemaphore(max(1, SEARCH_CONCURRENCY_LIMIT))


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "1" if default else "0")
    return str(raw or "").strip().lower() in {"1", "true", "yes", "on"}


PRECOMPILE_ENABLED = _env_flag("CLAWBOARD_PRECOMPILE_ENABLED", True)
PRECOMPILE_TTL_SECONDS = max(1.0, float(os.getenv("CLAWBOARD_PRECOMPILE_TTL_SECONDS", "8") or "8"))
PRECOMPILE_MAX_KEYS = max(8, int(os.getenv("CLAWBOARD_PRECOMPILE_MAX_KEYS", "32") or "32"))
PRECOMPILE_WARM_ON_STARTUP = _env_flag("CLAWBOARD_PRECOMPILE_WARM_ON_STARTUP", True)
PRECOMPILE_WARM_LISTENER_ENABLED = _env_flag("CLAWBOARD_PRECOMPILE_WARM_LISTENER_ENABLED", True)
PRECOMPILE_WARM_MIN_INTERVAL_SECONDS = max(
    0.25,
    float(os.getenv("CLAWBOARD_PRECOMPILE_WARM_MIN_INTERVAL_SECONDS", "1.5") or "1.5"),
)
_PRECOMPILE_WARM_TRIGGER_EVENTS = {
    "space.upserted",
    "topic.upserted",
    "topic.deleted",
    "task.upserted",
    "task.deleted",
    "log.appended",
    "log.patched",
    "log.deleted",
    "draft.upserted",
}
_PRECOMPILE_CACHE_LOCK = threading.Lock()
_PRECOMPILE_CACHE: dict[str, dict[str, Any]] = {}
_PRECOMPILE_KEY_LOCKS: dict[str, threading.Lock] = {}


def _precompile_cache_key(namespace: str, parts: Iterable[str]) -> str:
    normalized = [str(part).strip() for part in parts]
    return f"{namespace}|{'|'.join(normalized)}"


def _precompile_key_lock(cache_key: str) -> threading.Lock:
    with _PRECOMPILE_CACHE_LOCK:
        lock = _PRECOMPILE_KEY_LOCKS.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _PRECOMPILE_KEY_LOCKS[cache_key] = lock
        return lock


def _precompile_cache_get(cache_key: str, revision: str) -> Any | None:
    if not PRECOMPILE_ENABLED:
        return None
    now_mono = time.monotonic()
    with _PRECOMPILE_CACHE_LOCK:
        entry = _PRECOMPILE_CACHE.get(cache_key)
        if not entry:
            return None
        if str(entry.get("revision") or "") != revision:
            _PRECOMPILE_CACHE.pop(cache_key, None)
            return None
        expires_at = float(entry.get("expiresAtMonotonic") or 0.0)
        if expires_at < now_mono:
            _PRECOMPILE_CACHE.pop(cache_key, None)
            return None
        return entry.get("payload")


def _precompile_cache_set(cache_key: str, revision: str, payload: Any) -> None:
    if not PRECOMPILE_ENABLED:
        return
    now_mono = time.monotonic()
    with _PRECOMPILE_CACHE_LOCK:
        _PRECOMPILE_CACHE[cache_key] = {
            "revision": revision,
            "payload": payload,
            "builtAtMonotonic": now_mono,
            "expiresAtMonotonic": now_mono + PRECOMPILE_TTL_SECONDS,
        }
        if len(_PRECOMPILE_CACHE) <= PRECOMPILE_MAX_KEYS:
            return
        # Keep eviction deterministic: remove the oldest built entries first.
        overflow = len(_PRECOMPILE_CACHE) - PRECOMPILE_MAX_KEYS
        oldest = sorted(
            _PRECOMPILE_CACHE.items(),
            key=lambda item: float(item[1].get("builtAtMonotonic") or 0.0),
        )
        for stale_key, _entry in oldest[:overflow]:
            _PRECOMPILE_CACHE.pop(stale_key, None)
            _PRECOMPILE_KEY_LOCKS.pop(stale_key, None)


def _get_or_build_precompiled(
    *,
    namespace: str,
    key_parts: list[str],
    revision: str,
    build_fn: Callable[[], Any],
) -> tuple[Any, bool]:
    if not PRECOMPILE_ENABLED:
        return build_fn(), False
    cache_key = _precompile_cache_key(namespace, key_parts)
    cached = _precompile_cache_get(cache_key, revision)
    if cached is not None:
        return cached, True
    lock = _precompile_key_lock(cache_key)
    with lock:
        cached = _precompile_cache_get(cache_key, revision)
        if cached is not None:
            return cached, True
        payload = build_fn()
        _precompile_cache_set(cache_key, revision, payload)
        return payload, False


def _allowed_space_ids_cache_key(allowed_space_ids: set[str] | None) -> str:
    if allowed_space_ids is None:
        return "*"
    if not allowed_space_ids:
        return "-"
    return ",".join(sorted({str(space_id).strip() for space_id in allowed_space_ids if str(space_id).strip()}))


def _clawgraph_cache_key_parts(
    *,
    max_entities: int,
    max_nodes: int,
    min_edge_weight: float,
    limit_logs: int,
    include_pending: bool,
    allowed_space_ids: set[str] | None,
) -> list[str]:
    return [
        f"maxEntities={int(max_entities)}",
        f"maxNodes={int(max_nodes)}",
        f"minEdgeWeight={float(min_edge_weight):.4f}",
        f"limitLogs={int(limit_logs)}",
        f"includePending={1 if include_pending else 0}",
        f"allowed={_allowed_space_ids_cache_key(allowed_space_ids)}",
    ]


def _changes_cache_key_parts(*, limit_logs: int, include_raw: bool, allowed_space_ids: set[str] | None) -> list[str]:
    return [
        f"limitLogs={int(limit_logs)}",
        f"includeRaw={1 if include_raw else 0}",
        f"allowed={_allowed_space_ids_cache_key(allowed_space_ids)}",
    ]


def _table_count_and_max_ts(session: Any, model: Any, ts_column: Any) -> tuple[int, str]:
    row = session.exec(select(func.count(), func.max(ts_column)).select_from(model)).one()
    total_raw = 0
    max_raw = ""
    if row is not None:
        try:
            total_raw = row[0]  # tuple-like (Row / tuple)
        except Exception:
            total_raw = row
        try:
            max_raw = row[1]
        except Exception:
            max_raw = ""
    total = int(total_raw or 0)
    max_ts = str(max_raw or "")
    return total, max_ts


def _graph_revision_token(session: Any) -> str:
    topic_count, topic_max = _table_count_and_max_ts(session, Topic, Topic.updatedAt)
    task_count, task_max = _table_count_and_max_ts(session, Task, Task.updatedAt)
    log_count, log_max = _table_count_and_max_ts(session, LogEntry, LogEntry.updatedAt)
    return "|".join(
        [
            f"topic:{topic_count}:{topic_max}",
            f"task:{task_count}:{task_max}",
            f"log:{log_count}:{log_max}",
        ]
    )


def _changes_revision_token(session: Any) -> str:
    space_count, space_max = _table_count_and_max_ts(session, Space, Space.updatedAt)
    topic_count, topic_max = _table_count_and_max_ts(session, Topic, Topic.updatedAt)
    task_count, task_max = _table_count_and_max_ts(session, Task, Task.updatedAt)
    log_count, log_max = _table_count_and_max_ts(session, LogEntry, LogEntry.updatedAt)
    draft_count, draft_max = _table_count_and_max_ts(session, Draft, Draft.updatedAt)
    deleted_count, deleted_max = _table_count_and_max_ts(session, DeletedLog, DeletedLog.deletedAt)
    return "|".join(
        [
            f"space:{space_count}:{space_max}",
            f"topic:{topic_count}:{topic_max}",
            f"task:{task_count}:{task_max}",
            f"log:{log_count}:{log_max}",
            f"draft:{draft_count}:{draft_max}",
            f"deleted:{deleted_count}:{deleted_max}",
        ]
    )


def _creation_audit_path() -> str:
    return (
        os.getenv("CLAWBOARD_CREATION_AUDIT_PATH")
        or os.getenv("CLASSIFIER_CREATION_AUDIT_PATH")
        or "/data/creation-gate.jsonl"
    )


def _file_revision_token(path: str) -> str:
    try:
        stat = os.stat(path)
        return f"{int(stat.st_mtime_ns)}:{int(stat.st_size)}"
    except Exception:
        return "missing"


def _metrics_revision_token(session: Any) -> str:
    topic_count, topic_max = _table_count_and_max_ts(session, Topic, Topic.updatedAt)
    task_count, task_max = _table_count_and_max_ts(session, Task, Task.updatedAt)
    log_count, log_max = _table_count_and_max_ts(session, LogEntry, LogEntry.updatedAt)
    audit_token = _file_revision_token(_creation_audit_path())
    return "|".join(
        [
            f"topic:{topic_count}:{topic_max}",
            f"task:{task_count}:{task_max}",
            f"log:{log_count}:{log_max}",
            f"audit:{audit_token}",
        ]
    )
SLASH_COMMANDS = {
    "/new",
    "/topic",
    "/topics",
    "/task",
    "/tasks",
    "/log",
    "/logs",
    "/board",
    "/graph",
    "/help",
    "/reset",
    "/clear",
}

ATTACHMENTS_DIR = os.getenv("CLAWBOARD_ATTACHMENTS_DIR", "./data/attachments").strip() or "./data/attachments"
ATTACHMENT_MAX_FILES = int(os.getenv("CLAWBOARD_ATTACHMENT_MAX_FILES", "8") or "8")
ATTACHMENT_MAX_BYTES = int(os.getenv("CLAWBOARD_ATTACHMENT_MAX_BYTES", str(10 * 1024 * 1024)) or str(10 * 1024 * 1024))
ATTACHMENT_ALLOWED_MIME_TYPES = {
    mt.strip().lower()
    for mt in (
        os.getenv(
            "CLAWBOARD_ATTACHMENT_ALLOWED_MIME_TYPES",
            ",".join(
                [
                    "image/png",
                    "image/jpeg",
                    "image/gif",
                    "image/webp",
                    "application/pdf",
                    "text/plain",
                    "text/markdown",
                    "application/json",
                    "text/csv",
                    "audio/mpeg",
                    "audio/wav",
                    "audio/x-wav",
                    "audio/mp4",
                    "audio/webm",
                    "audio/ogg",
                ]
            ),
        )
        or ""
    ).split(",")
    if mt.strip()
}
ATTACHMENT_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
ATTACHMENT_TEXT_MIME_TYPES = {"text/plain", "text/markdown", "text/csv", "application/json"}
OPENCLAW_EXTRACTED_TEXT_LIMIT = int(os.getenv("OPENCLAW_EXTRACTED_TEXT_LIMIT", "15000") or "15000")


def _sanitize_attachment_filename(name: str) -> str:
    # Prevent path traversal + keep filenames readable.
    text = (name or "").replace("\\", "/").split("/")[-1].strip()
    text = re.sub(r"[\x00-\x1f\x7f]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return "attachment"
    if len(text) > 180:
        root, dot, ext = text.rpartition(".")
        if dot and ext and len(ext) <= 12:
            root = root[: 180 - (len(ext) + 1)].rstrip()
            text = f"{root}.{ext}"
        else:
            text = text[:180].rstrip()
    return text


def _normalize_mime_type(value: str | None) -> str:
    raw = (value or "").strip().lower()
    if raw == "image/jpg":
        return "image/jpeg"
    return raw


def _infer_mime_type_from_filename(filename: str) -> str:
    name = (filename or "").strip().lower()
    _, dot, ext = name.rpartition(".")
    if not dot or not ext:
        return ""
    ext = f".{ext}"
    mapping = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".json": "application/json",
        ".csv": "text/csv",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
    }
    return mapping.get(ext, "")


def _decode_text_attachment(data: bytes, *, limit: int = OPENCLAW_EXTRACTED_TEXT_LIMIT) -> str:
    if not data:
        return ""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("utf-8", errors="replace")
    return _clip(text.strip(), limit)


def _extract_pdf_text(data: bytes, *, limit: int = OPENCLAW_EXTRACTED_TEXT_LIMIT) -> str:
    """Best-effort PDF text extraction. Returns empty string if unavailable/failed."""
    if not data:
        return ""
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception:
        return ""
    try:
        reader = PdfReader(BytesIO(data))
        parts: list[str] = []
        used = 0
        for page in reader.pages:
            if used >= limit:
                break
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            text = text.strip()
            if not text:
                continue
            remaining = limit - used
            if remaining <= 0:
                break
            if len(text) > remaining:
                text = text[:remaining]
            parts.append(text)
            used += len(text)
        return _clip("\n\n".join(parts).strip(), limit)
    except Exception:
        return ""


def _verify_attachment_magic(path: Path, mime_type: str, filename: str) -> None:
    """Best-effort content sniffing to catch obvious MIME spoofing."""
    mt = _normalize_mime_type(mime_type)
    try:
        head = path.read_bytes()[:64]
    except Exception:
        return

    if mt == "application/pdf":
        if not head.startswith(b"%PDF-"):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid PDF: {filename}.")
        return

    if mt == "image/png":
        if not head.startswith(b"\x89PNG\r\n\x1a\n"):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid PNG: {filename}.")
        return

    if mt == "image/jpeg":
        if not head.startswith(b"\xff\xd8\xff"):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid JPEG: {filename}.")
        return

    if mt == "image/gif":
        if not (head.startswith(b"GIF87a") or head.startswith(b"GIF89a")):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid GIF: {filename}.")
        return

    if mt == "image/webp":
        if not (head.startswith(b"RIFF") and len(head) >= 12 and head[8:12] == b"WEBP"):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid WebP: {filename}.")
        return

    if mt.startswith("text/") or mt == "application/json":
        # Keep this permissive: allow UTF-8 text and reject obvious binary blobs.
        if b"\x00" in head:
            raise HTTPException(status_code=400, detail=f"Attachment appears to be binary: {filename}.")
        return

def _validate_attachment_mime_type(mime_type: str) -> None:
    if not mime_type:
        raise HTTPException(status_code=400, detail="Attachment MIME type missing.")
    if mime_type not in ATTACHMENT_ALLOWED_MIME_TYPES:
        allowed = ", ".join(sorted(ATTACHMENT_ALLOWED_MIME_TYPES))
        raise HTTPException(status_code=400, detail=f"Attachment type not allowed: {mime_type}. Allowed: {allowed}")


def _attachments_root() -> Path:
    root = Path(ATTACHMENTS_DIR).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return root


def enqueue_reindex_request(payload: dict) -> None:
    try:
        queue_path = os.path.abspath(REINDEX_QUEUE_PATH)
        queue_dir = os.path.dirname(queue_path)
        if queue_dir:
            os.makedirs(queue_dir, exist_ok=True)
        with open(queue_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({**payload, "requestedAt": now_iso()}) + "\n")
    except Exception:
        # Non-fatal: classifier can still reseed embeddings during normal runs.
        pass


def _normalize_label(value: str | None) -> str:
    if not value:
        return ""
    text = value.lower()
    replacements = {
        "ops": "operations",
        "msg": "message",
        "msgs": "messages",
    }
    for short, full in replacements.items():
        text = re.sub(rf"\b{short}\b", full, text)
    text = re.sub(r"[^a-z0-9\s]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _sanitize_log_text(value: str | None) -> str:
    if not value:
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"^\s*summary\s*[:\-]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"^\[Discord [^\]]+\]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"\[message[_\s-]?id:[^\]]+\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _search_query_tokens(value: str | None) -> set[str]:
    normalized = _sanitize_log_text(value).lower()
    if not normalized:
        return set()
    words = re.findall(r"[a-z0-9][a-z0-9'/_:-]*", normalized)
    return {token for token in words if len(token) > 1}


def _direct_label_match_boost(label: str | None, normalized_query: str, query_tokens: set[str]) -> float:
    cleaned_label = _sanitize_log_text(label).lower()
    if not cleaned_label:
        return 0.0
    label_tokens = _search_query_tokens(cleaned_label)
    if not label_tokens:
        return 0.0

    if normalized_query and normalized_query in cleaned_label:
        if len(query_tokens) >= 2:
            return max(0.0, SEARCH_DIRECT_LABEL_EXACT_BOOST + 0.04)
        return max(0.0, SEARCH_DIRECT_LABEL_EXACT_BOOST)

    if len(query_tokens) == 1:
        query_token = next(iter(query_tokens))
        if query_token in label_tokens:
            return max(0.0, SEARCH_DIRECT_LABEL_EXACT_BOOST)
        if len(query_token) >= 3 and any(token.startswith(query_token) for token in label_tokens):
            return max(0.0, SEARCH_DIRECT_LABEL_PREFIX_BOOST)
        return 0.0

    overlap = len(query_tokens & label_tokens)
    if query_tokens and overlap >= len(query_tokens):
        return max(0.0, SEARCH_DIRECT_LABEL_COVERAGE_BOOST)
    if len(query_tokens) >= 3 and overlap >= 2:
        return max(0.0, SEARCH_DIRECT_LABEL_COVERAGE_BOOST * 0.6)
    return 0.0


def _extract_query_snippet(value: str | None, terms: list[str], *, radius: int = 220, cap: int = 720) -> str:
    cleaned = _sanitize_log_text(value)
    if not cleaned:
        return ""
    hay = cleaned.lower()
    first_pos = -1
    for term in terms:
        pos = hay.find(term.lower())
        if pos >= 0 and (first_pos < 0 or pos < first_pos):
            first_pos = pos
    if first_pos < 0:
        return _clip(cleaned, cap)
    start = max(0, first_pos - max(40, radius))
    end = min(len(cleaned), first_pos + max(80, radius))
    snippet = cleaned[start:end].strip()
    if start > 0:
        snippet = f"…{snippet}"
    if end < len(cleaned):
        snippet = f"{snippet}…"
    return _clip(snippet, cap)


def _is_command_log(entry: LogEntry) -> bool:
    if getattr(entry, "type", None) != "conversation":
        return False
    text = _sanitize_log_text(str(entry.content or entry.summary or entry.raw or ""))
    if not text.startswith("/"):
        return False
    command = text.split(None, 1)[0].lower()
    if command in SLASH_COMMANDS:
        return True
    return bool(re.fullmatch(r"/[a-z0-9_-]{2,}", command))


def _clip(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def _chunked_values(values: list[str], chunk_size: int) -> Iterable[list[str]]:
    size = max(1, int(chunk_size or 1))
    for index in range(0, len(values), size):
        chunk = values[index : index + size]
        if chunk:
            yield chunk


def _is_tool_call_log(entry: LogEntry) -> bool:
    if getattr(entry, "type", None) != "action":
        return False
    combined = " ".join(
        part
        for part in [
            str(entry.summary or ""),
            str(entry.content or ""),
            str(entry.raw or ""),
        ]
        if part
    ).lower()
    return "tool call:" in combined or "tool result:" in combined or "tool error:" in combined


def _log_reindex_text(entry: LogEntry) -> str:
    log_type = str(getattr(entry, "type", "") or "")
    if log_type in ("system", "import"):
        return ""
    if not SEARCH_INCLUDE_TOOL_CALL_LOGS and _is_tool_call_log(entry):
        return ""
    if _is_memory_action_log(entry) or _is_command_log(entry):
        return ""
    parts = [
        _sanitize_log_text(entry.summary or ""),
        _sanitize_log_text(entry.content or ""),
        _sanitize_log_text(entry.raw or ""),
    ]
    text = " ".join(part for part in parts if part)
    return _clip(text, 1200)


def _is_memory_action_log(entry: LogEntry) -> bool:
    if getattr(entry, "type", None) != "action":
        return False
    combined = " ".join(
        part
        for part in [
            str(entry.summary or ""),
            str(entry.content or ""),
            str(entry.raw or ""),
        ]
        if part
    ).lower()
    if "tool call:" in combined or "tool result:" in combined or "tool error:" in combined:
        if re.search(r"\bmemory[_-]?(search|get|query|fetch|retrieve|read|write|store|list|prune|delete)\b", combined):
            return True
    return False


def _log_allowed_for_semantic_search(entry: LogEntry) -> bool:
    log_type = str(getattr(entry, "type", "") or "")
    if log_type in ("system", "import"):
        return False
    if not SEARCH_INCLUDE_TOOL_CALL_LOGS and _is_tool_call_log(entry):
        return False
    if _is_memory_action_log(entry) or _is_command_log(entry):
        return False
    return True


def _enqueue_log_reindex(entry: LogEntry) -> None:
    text = _log_reindex_text(entry)
    if not text:
        enqueue_reindex_request({"op": "delete", "kind": "log", "id": entry.id})
        return
    enqueue_reindex_request({"op": "upsert", "kind": "log", "id": entry.id, "text": text, "topicId": entry.topicId})


def _log_matches_session(entry: LogEntry, session_key: str) -> bool:
    source = getattr(entry, "source", None)
    if not isinstance(source, dict):
        return False
    source_key = str(source.get("sessionKey") or "").strip()
    target_key = str(session_key or "").strip()
    if not source_key or not target_key:
        return False
    if source_key == target_key:
        return True
    target_base = target_key.split("|", 1)[0].strip()
    if not target_base:
        return False
    if source_key == target_base:
        return True
    return source_key.startswith(f"{target_base}|")


def _normalize_hex_color(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return text.upper()
    return None


def _auto_pick_color(seed: str, used: set[str], offset: float = 0.0) -> str:
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    base_hue = ((int(digest[:8], 16) % 360) + offset) % 360
    sat = 0.62 + (int(digest[8:12], 16) % 13) / 100.0
    lig = 0.50 + (int(digest[12:16], 16) % 11) / 100.0
    for step in range(24):
        hue = (base_hue + (step * 29.0)) % 360
        r, g, b = colorsys.hls_to_rgb(hue / 360.0, min(0.66, lig), min(0.80, sat))
        color = f"#{int(r * 255):02X}{int(g * 255):02X}{int(b * 255):02X}"
        if color not in used:
            return color
    return color


def _label_similarity(a: str | None, b: str | None) -> float:
    na = _normalize_label(a)
    nb = _normalize_label(b)
    if not na or not nb:
        return 0.0
    seq = SequenceMatcher(None, na, nb).ratio()
    ta = {part for part in na.split(" ") if len(part) > 2}
    tb = {part for part in nb.split(" ") if len(part) > 2}
    token = len(ta & tb) / len(ta | tb) if (ta or tb) else 0.0
    return (seq * 0.72) + (token * 0.28)


def _find_similar_topic(session, name: str, threshold: float = 0.80, space_id: str | None = None):
    if not name.strip():
        return None
    topics = session.exec(select(Topic)).all()
    normalized_space_id = _normalize_space_id(space_id)
    if normalized_space_id:
        topics = [topic for topic in topics if _space_id_for_topic(topic) == normalized_space_id]
    best = None
    best_score = 0.0
    for topic in topics:
        score = _label_similarity(topic.name, name)
        if score > best_score:
            best_score = score
            best = topic
    if best and best_score >= threshold:
        return best
    return None


def _find_similar_task(
    session,
    topic_id: str | None,
    title: str,
    threshold: float = 0.88,
    space_id: str | None = None,
):
    if not title.strip():
        return None
    tasks = session.exec(select(Task)).all()
    normalized_space_id = _normalize_space_id(space_id)
    if topic_id is not None:
        tasks = [task for task in tasks if task.topicId == topic_id]
    else:
        tasks = [task for task in tasks if task.topicId is None]
        if normalized_space_id:
            tasks = [task for task in tasks if _space_id_for_task(task) == normalized_space_id]
    best = None
    best_score = 0.0
    for task in tasks:
        score = _label_similarity(task.title, title)
        if score > best_score:
            best_score = score
            best = task
    if best and best_score >= threshold:
        return best
    return None


def _next_sort_index_for_new_topic(session, pinned: bool) -> int:
    """Return a sortIndex that places new topics at the top of their pinned group."""
    topics = session.exec(select(Topic)).all()
    indices = [int(getattr(topic, "sortIndex", 0)) for topic in topics if bool(getattr(topic, "pinned", False)) == pinned]
    if not indices:
        return 0
    return min(indices) - 1


def _next_sort_index_for_new_task(session, topic_id: str | None, pinned: bool) -> int:
    """Return a sortIndex that places new tasks at the top of their pinned group within the topic."""
    tasks = session.exec(select(Task)).all()
    scoped = [task for task in tasks if task.topicId == topic_id]
    indices = [int(getattr(task, "sortIndex", 0)) for task in scoped if bool(getattr(task, "pinned", False)) == pinned]
    if not indices:
        return 0
    return min(indices) - 1


def _warm_precompiled_defaults() -> None:
    if not PRECOMPILE_ENABLED:
        return
    try:
        with get_session() as session:
            # Warm the graph shape used by the UI and the endpoint defaults.
            graph_presets = [
                (140, 320, 0.08, 3200, True),  # src/components/clawgraph-live.tsx
                (120, 260, 0.16, 2400, True),  # /api/clawgraph defaults
            ]
            graph_revision = _graph_revision_token(session)
            for max_entities, max_nodes, min_edge_weight, limit_logs, include_pending in graph_presets:
                key_parts = _clawgraph_cache_key_parts(
                    max_entities=max_entities,
                    max_nodes=max_nodes,
                    min_edge_weight=min_edge_weight,
                    limit_logs=limit_logs,
                    include_pending=include_pending,
                    allowed_space_ids=None,
                )
                _get_or_build_precompiled(
                    namespace="clawgraph",
                    key_parts=key_parts,
                    revision=graph_revision,
                    build_fn=lambda me=max_entities, mn=max_nodes, ew=min_edge_weight, ll=limit_logs, ip=include_pending: _build_clawgraph_payload(
                        session,
                        max_entities=me,
                        max_nodes=mn,
                        min_edge_weight=ew,
                        limit_logs=ll,
                        include_pending=ip,
                        allowed_space_ids=None,
                    ),
                )

            changes_revision = _changes_revision_token(session)
            _get_or_build_precompiled(
                namespace="changes",
                key_parts=_changes_cache_key_parts(limit_logs=2000, include_raw=False, allowed_space_ids=None),
                revision=changes_revision,
                build_fn=lambda: _build_changes_payload(
                    session,
                    since=None,
                    limit_logs=2000,
                    include_raw=False,
                    allowed_space_ids=None,
                ),
            )

            metrics_revision = _metrics_revision_token(session)
            _get_or_build_precompiled(
                namespace="metrics",
                key_parts=["default"],
                revision=metrics_revision,
                build_fn=lambda: _build_metrics_payload(session),
            )
    except Exception:
        # Best-effort warmup only.
        return


def _precompile_warm_worker() -> None:
    if not PRECOMPILE_ENABLED:
        return
    if PRECOMPILE_WARM_ON_STARTUP:
        _warm_precompiled_defaults()

    subscriber = event_hub.subscribe()
    pending = False
    next_warm_at = 0.0
    try:
        while True:
            timeout = 30.0
            if pending:
                timeout = max(0.05, next_warm_at - time.monotonic())
            try:
                _event_id, payload = subscriber.get(timeout=timeout)
            except queue.Empty:
                if pending and time.monotonic() >= next_warm_at:
                    _warm_precompiled_defaults()
                    pending = False
                continue

            event_type = str((payload or {}).get("type") or "")
            if event_type not in _PRECOMPILE_WARM_TRIGGER_EVENTS:
                continue
            pending = True
            next_warm_at = time.monotonic() + PRECOMPILE_WARM_MIN_INTERVAL_SECONDS
    finally:
        event_hub.unsubscribe(subscriber)


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    if PRECOMPILE_ENABLED and PRECOMPILE_WARM_LISTENER_ENABLED:
        thread = threading.Thread(target=_precompile_warm_worker, daemon=True)
        thread.start()
    elif PRECOMPILE_ENABLED and PRECOMPILE_WARM_ON_STARTUP:
        thread = threading.Thread(target=_warm_precompiled_defaults, daemon=True)
        thread.start()
    if os.getenv("CLAWBOARD_INGEST_MODE", "").lower() == "queue":
        thread = threading.Thread(target=_queue_worker, daemon=True)
        thread.start()
    if os.getenv("CLAWBOARD_DISABLE_SNOOZE_WORKER", "").strip() != "1":
        thread = threading.Thread(target=_snooze_worker, daemon=True)
        thread.start()
    if os.getenv("CLAWBOARD_DISABLE_SESSION_ROUTING_GC", "").strip() != "1":
        thread = threading.Thread(target=_session_routing_gc_worker, daemon=True)
        thread.start()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


def _queue_worker() -> None:
    poll_interval = float(os.getenv("CLAWBOARD_QUEUE_POLL_SECONDS", "1.5"))
    batch_size = int(os.getenv("CLAWBOARD_QUEUE_BATCH", "25"))
    while True:
        try:
            with get_session() as session:
                pending = session.exec(
                    select(IngestQueue).where(IngestQueue.status == "pending").order_by(IngestQueue.id).limit(batch_size)
                ).all()
                for job in pending:
                    job.status = "processing"
                session.commit()

                for job in pending:
                    try:
                        payload = LogAppend.model_validate(job.payload)
                        idem = _idempotency_key(payload, None)
                        append_log_entry(session, payload, idem)
                        job.status = "done"
                        job.attempts += 1
                        job.lastError = None
                    except Exception as exc:
                        job.status = "failed"
                        job.attempts += 1
                        job.lastError = str(exc)
                    session.add(job)
                session.commit()
        except Exception:
            pass
        time.sleep(poll_interval)


def _snooze_worker() -> None:
    poll_interval = float(os.getenv("CLAWBOARD_SNOOZE_POLL_SECONDS", "15"))
    while True:
        try:
            now = now_iso()
            with get_session() as session:
                due_topics = (
                    session.exec(select(Topic).where(Topic.snoozedUntil.is_not(None)).where(Topic.snoozedUntil <= now)).all()
                )
                due_tasks = (
                    session.exec(select(Task).where(Task.snoozedUntil.is_not(None)).where(Task.snoozedUntil <= now)).all()
                )
                if not due_topics and not due_tasks:
                    time.sleep(poll_interval)
                    continue

                for topic in due_topics:
                    topic.snoozedUntil = None
                    status = str(topic.status or "active").strip().lower()
                    if status in {"snoozed", "paused"}:
                        topic.status = "active"
                    topic.updatedAt = now
                    session.add(topic)

                for task in due_tasks:
                    task.snoozedUntil = None
                    task.updatedAt = now
                    session.add(task)

                session.commit()

                for topic in due_topics:
                    event_hub.publish({"type": "topic.upserted", "data": topic.model_dump(), "eventTs": topic.updatedAt})
                for task in due_tasks:
                    event_hub.publish({"type": "task.upserted", "data": task.model_dump(), "eventTs": task.updatedAt})
        except Exception:
            pass
        time.sleep(poll_interval)


def _session_routing_gc_worker() -> None:
    """Garbage-collect old session routing memory rows.

    This keeps the table bounded over time for large deployments.
    """

    poll_interval = float(os.getenv("CLAWBOARD_SESSION_ROUTING_GC_SECONDS", str(6 * 60 * 60)))
    ttl_days = float(os.getenv("CLAWBOARD_SESSION_ROUTING_TTL_DAYS", "90"))
    if ttl_days <= 0:
        return
    batch_size = int(os.getenv("CLAWBOARD_SESSION_ROUTING_GC_BATCH", "500"))
    # Best-effort: run forever, never crash the API.
    while True:
        try:
            cutoff_dt = datetime.now(timezone.utc) - timedelta(days=ttl_days)
            cutoff = cutoff_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            with get_session() as session:
                rows = (
                    session.exec(
                        select(SessionRoutingMemory)
                        .where(SessionRoutingMemory.updatedAt < cutoff)
                        .order_by(SessionRoutingMemory.updatedAt.asc())
                        .limit(batch_size)
                    ).all()
                )
                if rows:
                    for row in rows:
                        session.delete(row)
                    session.commit()
        except Exception:
            pass
        time.sleep(poll_interval)


def _idempotency_key(payload: LogAppend, header_key: str | None) -> str | None:
    if header_key and header_key.strip():
        return header_key.strip()
    if payload.idempotencyKey and payload.idempotencyKey.strip():
        return payload.idempotencyKey.strip()
    source = payload.source if isinstance(payload.source, dict) else None
    if source:
        message_id = str(source.get("messageId") or "").strip()
        if message_id:
            channel = str(source.get("channel") or "").strip().lower()
            actor = str(payload.agentId or payload.agentLabel or "").strip().lower()
            entry_type = str(payload.type or "").strip().lower()
            return f"src:{entry_type}:{channel}:{actor}:{message_id}"
    return None


def _find_by_idempotency(session, key: str):
    return session.exec(select(LogEntry).where(LogEntry.idempotencyKey == key)).first()


def append_log_entry(session, payload: LogAppend, idempotency_key: str | None = None) -> LogEntry:
    created_at = normalize_iso(payload.createdAt) or now_iso()
    # Use ingest time for updatedAt to guarantee stable ordering even when a source provides
    # identical/low-precision createdAt values.
    updated_at = now_iso()

    if idempotency_key:
        existing = _find_by_idempotency(session, idempotency_key)
        if existing:
            return existing

    # Idempotency guard: if the source messageId is present, avoid duplicating
    # logs when the logger retries / replays its queue.
    # OpenClaw also uses requestId as an authoritative per-send identifier, and plugin rows can
    # arrive with that identifier in `source.messageId`, so treat them as the same operation.
    # NOTE: When an idempotency key is present (header or payload), the unique index on
    # LogEntry.idempotencyKey is the canonical dedupe mechanism. The source.messageId
    # fallback is only needed for legacy senders that omit idempotency keys.
    if not idempotency_key and payload.source and isinstance(payload.source, dict):
        msg_id_text = str(payload.source.get("messageId") or "").strip()
        request_id_text = str(payload.source.get("requestId") or "").strip()
        identifiers = [value for value in [msg_id_text, request_id_text] if value]
        if identifiers and payload.type == "conversation":
            channel = payload.source.get("channel")
            channel_text = str(channel).strip().lower() if isinstance(channel, str) else ""
            agent_id = (payload.agentId or "").strip()
            unique_identifiers = list(dict.fromkeys(identifiers))

            query = select(LogEntry).where(LogEntry.type == payload.type)
            if agent_id:
                query = query.where(LogEntry.agentId == agent_id)

            if DATABASE_URL.startswith("sqlite"):
                # Query matches either legacy messageId or OpenClaw requestId sent as messageId.
                query_text_parts: list[str] = []
                query_params = {}
                for idx, identifier in enumerate(unique_identifiers):
                    key = f"did_{idx}"
                    scope = "(1=1)"
                    if channel_text:
                        query_params["channel"] = channel_text
                        scope = "(" + " OR ".join(
                            [
                                f"json_extract(source, '$.channel') = :channel",
                                "json_extract(source, '$.channel') IS NULL",
                                "lower(json_extract(source, '$.channel')) = 'openclaw'",
                            ]
                        ) + ")"
                    query_text_parts.append(
                        f"((json_extract(source, '$.messageId') = :{key} OR "
                        f"json_extract(source, '$.requestId') = :{key}) AND {scope})"
                    )
                    query_params[key] = identifier
                query = query.where(text(" OR ".join(query_text_parts))).params(**query_params)
            else:
                # Query matches either messageId or requestId by identifier.
                message_matches = []
                for identifier in unique_identifiers:
                    msg_cond = LogEntry.source["messageId"].as_string() == identifier
                    req_cond = LogEntry.source["requestId"].as_string() == identifier
                    if channel_text:
                        channel_filter = or_(
                            func.lower(LogEntry.source["channel"].as_string()) == channel_text,
                            LogEntry.source["channel"].is_(None),
                            func.lower(LogEntry.source["channel"].as_string()) == "openclaw",
                        )
                        msg_cond = and_(msg_cond, channel_filter)
                        req_cond = and_(req_cond, channel_filter)
                    message_matches.append(or_(msg_cond, req_cond))
                if message_matches:
                    query = query.where(or_(*message_matches))

            existing = session.exec(query).first()
            if existing:
                return existing

    source_meta = payload.source.copy() if isinstance(payload.source, dict) else None
    space_id = _normalize_space_id(payload.spaceId)
    topic_id = payload.topicId
    task_id = payload.taskId

    source_scope_space_id: str | None = None
    source_scope_topic_id: str | None = None
    source_scope_task_id: str | None = None
    scope_lock = False

    if source_meta:
        explicit_space = _normalize_space_id(source_meta.get("boardScopeSpaceId"))
        if explicit_space:
            source_scope_space_id = explicit_space
            if not space_id:
                space_id = explicit_space
        session_key = str(source_meta.get("sessionKey") or "").strip()
        if session_key:
            derived_topic_id, derived_task_id = _parse_board_session_key(session_key)
            if derived_task_id:
                source_scope_topic_id = derived_topic_id or source_scope_topic_id
                source_scope_task_id = derived_task_id
                scope_lock = True
            elif derived_topic_id:
                source_scope_topic_id = derived_topic_id
                scope_lock = True

        explicit_topic = str(source_meta.get("boardScopeTopicId") or "").strip()
        explicit_task = str(source_meta.get("boardScopeTaskId") or "").strip()
        lock_raw = source_meta.get("boardScopeLock")
        if lock_raw is True:
            scope_lock = True
        elif isinstance(lock_raw, str) and lock_raw.strip().lower() in {"1", "true", "yes", "on"}:
            scope_lock = True

        if explicit_topic:
            source_scope_topic_id = explicit_topic
        if explicit_task:
            source_scope_task_id = explicit_task
            scope_lock = True

        # Clawboard routing: if a sender only provides source-scoped metadata (common for nested
        # OpenClaw sessions), derive topic/task so thread affinity remains stable.
        if source_scope_task_id and (scope_lock or not task_id):
            task_id = source_scope_task_id
        if source_scope_topic_id and (scope_lock or not topic_id):
            topic_id = source_scope_topic_id

    source_channel = ""
    if source_meta:
        source_channel = str(source_meta.get("channel") or "").strip().lower()

    # OpenClaw cron delivery/control messages should never be routed into user topics/tasks.
    # Treat them as terminal noise at ingest time so they can't briefly appear in Unified View
    # before the classifier cycle runs.
    cron_event_filtered = source_channel == "cron-event"
    if cron_event_filtered:
        if not space_id:
            space_id = source_scope_space_id or DEFAULT_SPACE_ID
        topic_id = None
        task_id = None

    task_row = None
    if task_id:
        task_row = session.get(Task, task_id)
        if not task_row:
            task_id = None
            task_row = None

    # Enforce valid topic/task combinations at ingest time: a task implies its topic.
    # This prevents "impossible" UI states where a log references a task from a different topic.
    if task_row:
        topic_id = task_row.topicId
        space_id = _space_id_for_task(task_row)

    topic_row = None
    if topic_id:
        topic_row = session.get(Topic, topic_id)
        if not topic_row:
            topic_id = None
            topic_row = None
        else:
            space_id = _space_id_for_topic(topic_row)

    if not space_id:
        space_id = source_scope_space_id or DEFAULT_SPACE_ID

    # Normalize source-level board scope metadata so downstream classifier/UI can reliably
    # keep nested/subagent logs in the originating board Topic/Task.
    if source_meta is not None:
        canonical_space = str(source_scope_space_id or space_id or "").strip()
        canonical_topic = str(topic_id or "").strip()
        canonical_task = str(task_id or "").strip()
        if source_scope_topic_id and not canonical_topic:
            canonical_topic = source_scope_topic_id
        if source_scope_task_id and not canonical_task:
            canonical_task = source_scope_task_id
        if canonical_task and not canonical_topic and task_row and task_row.topicId:
            canonical_topic = str(task_row.topicId).strip()

        if canonical_topic:
            source_meta["boardScopeTopicId"] = canonical_topic
            source_meta["boardScopeKind"] = "task" if canonical_task else "topic"
            source_meta["boardScopeLock"] = bool(scope_lock or canonical_task)
            if canonical_space:
                source_meta["boardScopeSpaceId"] = canonical_space
            if canonical_task:
                source_meta["boardScopeTaskId"] = canonical_task
            else:
                source_meta.pop("boardScopeTaskId", None)
        elif scope_lock:
            source_meta["boardScopeLock"] = True
        if canonical_space:
            source_meta["boardScopeSpaceId"] = canonical_space

    attachments = None
    if payload.attachments:
        attachments = []
        for item in payload.attachments:
            if hasattr(item, "model_dump"):
                attachments.append(item.model_dump())
            elif isinstance(item, dict):
                attachments.append(item)
            else:
                attachments.append({"value": str(item)})

    _ensure_default_space(session)
    if not space_id:
        space_id = DEFAULT_SPACE_ID
    if not session.get(Space, space_id):
        space_id = DEFAULT_SPACE_ID

    entry = LogEntry(
        id=create_id("log"),
        spaceId=space_id or DEFAULT_SPACE_ID,
        topicId=topic_id,
        taskId=task_id,
        relatedLogId=payload.relatedLogId,
        idempotencyKey=idempotency_key,
        type=payload.type,
        content=payload.content,
        summary=payload.summary,
        raw=payload.raw,
        createdAt=created_at,
        updatedAt=updated_at,
        agentId=payload.agentId,
        agentLabel=payload.agentLabel,
        source=source_meta,
        attachments=attachments,
        classificationStatus="failed" if cron_event_filtered else (payload.classificationStatus or "pending"),
        classificationAttempts=1 if cron_event_filtered else 0,
        classificationError="filtered_cron_event" if cron_event_filtered else None,
    )
    session.add(entry)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        if idempotency_key:
            existing = _find_by_idempotency(session, idempotency_key)
            if existing:
                return existing
        raise
    except OperationalError as exc:
        # SQLite can transiently fail with "database is locked" under concurrent writes
        # (logger + classifier). Keep this fast so upstream hooks don't time out.
        if not DATABASE_URL.startswith("sqlite") or "database is locked" not in str(exc).lower():
            raise
        session.rollback()
        last_exc: OperationalError | None = exc
        for attempt in range(6):
            try:
                # rollback() can detach pending instances; ensure this insert is part of the new transaction.
                session.add(entry)
                time.sleep(min(0.75, 0.05 * (2**attempt)))
                session.commit()
                last_exc = None
                break
            except IntegrityError:
                session.rollback()
                # Another writer may have committed the same idempotency key while we were
                # backing off from a SQLite lock; treat as idempotent.
                if idempotency_key:
                    existing = _find_by_idempotency(session, idempotency_key)
                    if existing:
                        return existing
                raise
            except OperationalError as retry_exc:
                if "database is locked" not in str(retry_exc).lower():
                    raise
                session.rollback()
                last_exc = retry_exc
        if last_exc is not None:
            raise last_exc
    try:
        session.refresh(entry)
    except Exception:
        # Best-effort: on some SQLite lock/retry paths the instance can become detached.
        # Reload by primary key so the API can still respond successfully.
        persisted = session.get(LogEntry, entry.id)
        if persisted:
            entry = persisted
        else:
            raise

    # Gmail-style behavior: new conversation activity should revive snoozed items.
    # This ensures a topic/task doesn't stay hidden if new messages arrive while snoozed.
    revived_topic: Topic | None = None
    revived_task: Task | None = None
    if str(payload.type or "").strip().lower() == "conversation":
        now = entry.updatedAt
        try:
            if task_id:
                row = task_row or session.get(Task, task_id)
                if row and row.snoozedUntil:
                    row.snoozedUntil = None
                    row.updatedAt = now
                    session.add(row)
                    revived_task = row

            if topic_id:
                row = topic_row or session.get(Topic, topic_id)
                if row and (
                    row.snoozedUntil
                    or str(row.status or "active").strip().lower() in {"snoozed", "paused", "archived"}
                ):
                    row.snoozedUntil = None
                    row.status = "active"
                    row.updatedAt = now
                    session.add(row)
                    revived_topic = row

            if revived_topic or revived_task:
                try:
                    session.commit()
                except OperationalError as exc:
                    if not DATABASE_URL.startswith("sqlite") or "database is locked" not in str(exc).lower():
                        session.rollback()
                        revived_topic = None
                        revived_task = None
                    else:
                        session.rollback()
                        last_exc: OperationalError | None = exc
                        for attempt in range(6):
                            try:
                                time.sleep(min(0.75, 0.05 * (2**attempt)))
                                session.commit()
                                last_exc = None
                                break
                            except OperationalError as retry_exc:
                                if "database is locked" not in str(retry_exc).lower():
                                    raise
                                session.rollback()
                                last_exc = retry_exc
                        if last_exc is not None:
                            revived_topic = None
                            revived_task = None
        except Exception:
            # Best-effort only: never break log ingestion for snooze revival.
            try:
                session.rollback()
            except Exception:
                pass
            revived_topic = None
            revived_task = None

    if revived_topic:
        event_hub.publish({"type": "topic.upserted", "data": revived_topic.model_dump(), "eventTs": revived_topic.updatedAt})
    if revived_task:
        event_hub.publish({"type": "task.upserted", "data": revived_task.model_dump(), "eventTs": revived_task.updatedAt})

    # raw payloads can be large; keep log events lightweight for SSE + in-memory buffer safety.
    event_hub.publish({"type": "log.appended", "data": entry.model_dump(exclude={"raw"}), "eventTs": entry.updatedAt})
    # If this is an assistant log entry, publish a stop typing event to clear the typing indicator
    if entry.agentId and entry.agentId.lower() == "assistant" and entry.source:
        session_key = entry.source.get("sessionKey") if isinstance(entry.source, dict) else None
        if session_key:
            event_hub.publish({
                "type": "openclaw.typing",
                "data": {
                    "sessionKey": session_key,
                    "typing": False,
                    "requestId": entry.source.get("requestId") if isinstance(entry.source, dict) else None
                },
                "eventTs": entry.updatedAt
            })
    _enqueue_log_reindex(entry)
    return entry


def _log_openclaw_chat_error(*, session_key: str, request_id: str, detail: str, raw: str | None = None) -> None:
    """Persist a visible error inside the originating session thread."""
    try:
        payload = LogAppend(
            type="system",
            content=detail,
            summary=_clip(detail, 160),
            raw=_clip(raw or "", 5000) if raw else None,
            agentId="system",
            agentLabel="Clawboard",
            source={"sessionKey": session_key, "channel": "clawboard", "requestId": request_id},
            classificationStatus="classified",
        )
        with get_session() as session:
            append_log_entry(session, payload, idempotency_key=f"openclaw-chat:error:{request_id}")
    except Exception:
        # Non-fatal: if we can't log, the client will still see the HTTP error.
        pass


BOARD_TOPIC_SESSION_PREFIX = "clawboard:topic:"
BOARD_TASK_SESSION_PREFIX = "clawboard:task:"


def _parse_board_session_key(session_key: str) -> tuple[str | None, str | None]:
    key = str(session_key or "").strip()
    if not key:
        return (None, None)

    # OpenClaw may attach thread suffixes (`|thread:...`). Strip those for routing.
    base = (key.split("|", 1)[0] or "").strip()
    if not base:
        return (None, None)

    # Robust matching: handles agent: prefixes and other wrappers.
    # Task format must be checked before topic format, because `clawboard:task:...`
    # contains a `clawboard:topic:` substring and would otherwise be misclassified.
    task_match = re.search(r"clawboard:task:(topic-[a-zA-Z0-9-]+):(task-[a-zA-Z0-9-]+)", base)
    if task_match:
        return (task_match.group(1), task_match.group(2))

    # Topic format: clawboard:topic:<topic-id>
    topic_match = re.search(r"clawboard:topic:(topic-[a-zA-Z0-9-]+)", base)
    if topic_match:
        return (topic_match.group(1), None)

    return (None, None)


@app.get("/api/attachments/policy", tags=["attachments"])
def get_attachment_policy():
    """Return attachment allowlist + limits so clients can validate before upload."""
    return {
        "allowedMimeTypes": sorted(ATTACHMENT_ALLOWED_MIME_TYPES),
        "maxFiles": ATTACHMENT_MAX_FILES,
        "maxBytes": ATTACHMENT_MAX_BYTES,
    }


@app.post(
    "/api/attachments",
    dependencies=[Depends(require_token)],
    response_model=List[AttachmentOut],
    tags=["attachments"],
)
async def upload_attachments(files: List[UploadFile] = File(..., description="Files to attach (multipart).")):
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")
    if len(files) > ATTACHMENT_MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Too many files. Max is {ATTACHMENT_MAX_FILES}.")

    root = _attachments_root()
    tmp_dir = root / ".tmp" / create_id("upload")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    staged: list[dict[str, Any]] = []
    moved: list[Path] = []
    try:
        # Stage all files first; if any fails validation we do not persist partial uploads.
        for upload in files:
            filename = _sanitize_attachment_filename(upload.filename or "")
            mime_type = _normalize_mime_type(getattr(upload, "content_type", None))
            if not mime_type or mime_type == "application/octet-stream":
                mime_type = _infer_mime_type_from_filename(filename)
            _validate_attachment_mime_type(mime_type)

            attachment_id = create_id("att")
            tmp_path = tmp_dir / attachment_id
            sha = hashlib.sha256()
            size = 0

            try:
                with tmp_path.open("wb") as out:
                    while True:
                        chunk = await upload.read(1024 * 256)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > ATTACHMENT_MAX_BYTES:
                            raise HTTPException(
                                status_code=413,
                                detail=f"Attachment too large: {filename}. Max is {ATTACHMENT_MAX_BYTES} bytes.",
                            )
                        sha.update(chunk)
                        out.write(chunk)
            finally:
                try:
                    await upload.close()
                except Exception:
                    pass

            if size <= 0:
                raise HTTPException(status_code=400, detail=f"Attachment was empty: {filename}.")

            _verify_attachment_magic(tmp_path, mime_type, filename)

            staged.append(
                {
                    "id": attachment_id,
                    "fileName": filename,
                    "mimeType": mime_type,
                    "sizeBytes": size,
                    "sha256": sha.hexdigest(),
                    "tmpPath": tmp_path,
                }
            )

        stored_at = now_iso()
        persisted: list[Attachment] = []
        with get_session() as session:
            try:
                for item in staged:
                    final_path = root / item["id"]
                    # Atomic move into the stable path.
                    os.replace(str(item["tmpPath"]), str(final_path))
                    moved.append(final_path)

                    row = Attachment(
                        id=item["id"],
                        logId=None,
                        fileName=item["fileName"],
                        mimeType=item["mimeType"],
                        sizeBytes=item["sizeBytes"],
                        sha256=item["sha256"],
                        storagePath=item["id"],
                        createdAt=stored_at,
                        updatedAt=stored_at,
                    )
                    session.add(row)
                    persisted.append(row)

                session.commit()
                for row in persisted:
                    session.refresh(row)
                return persisted
            except Exception:
                session.rollback()
                # Best-effort cleanup: avoid leaving orphaned files when DB write fails.
                for path in moved:
                    try:
                        if path.exists():
                            path.unlink()
                    except Exception:
                        pass
                raise
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Failed to upload attachments.") from exc
    finally:
        # Clean up any remaining staged files.
        try:
            for item in staged:
                path = item.get("tmpPath")
                if path and isinstance(path, Path) and path.exists():
                    try:
                        path.unlink()
                    except Exception:
                        pass
        finally:
            try:
                if tmp_dir.exists():
                    for child in tmp_dir.iterdir():
                        try:
                            child.unlink()
                        except Exception:
                            pass
                    try:
                        tmp_dir.rmdir()
                    except Exception:
                        pass
            except Exception:
                pass


@app.get("/api/attachments/{attachment_id}", tags=["attachments"])
def download_attachment(attachment_id: str):
    """Serve a stored attachment by ID."""
    att_id = (attachment_id or "").strip()
    if not att_id:
        raise HTTPException(status_code=404, detail="Attachment not found")
    with get_session() as session:
        row = session.get(Attachment, att_id)
        if not row:
            raise HTTPException(status_code=404, detail="Attachment not found")

    root = _attachments_root()
    path = root / str(row.storagePath or row.id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Attachment file missing on disk")

    filename = _sanitize_attachment_filename(row.fileName)
    disposition = f'inline; filename="{filename}"'
    return FileResponse(
        str(path),
        media_type=row.mimeType or "application/octet-stream",
        filename=filename,
        headers={"Content-Disposition": disposition},
    )


def _run_openclaw_chat(
    request_id: str,
    *,
    base_url: str,
    token: str,
    session_key: str,
    agent_id: str,
    sent_at: str,
    message: str,
    attachments: list[dict[str, Any]] | None = None,
) -> None:
    """Dispatch a message to OpenClaw via the Gateway WebSocket (chat.send).

    Clawboard is an external client of the OpenClaw Gateway.
    """

    # NOTE: We intentionally do not use OpenResponses here; we speak directly to
    # the Gateway WS and call the same RPC method used by WebChat clients.
    try:
        event_hub.publish(
            {
                "type": "openclaw.typing",
                "data": {"sessionKey": session_key, "requestId": request_id, "typing": True},
                "eventTs": now_iso(),
            }
        )

        ws_attachments: list[dict[str, Any]] = []
        if attachments:
            root = _attachments_root()
            for att in attachments:
                att_id = str(att.get("id") or "").strip()
                if not att_id:
                    continue
                storage_path = str(att.get("storagePath") or att_id).strip()
                path = root / storage_path
                if not path.exists():
                    _log_openclaw_chat_error(
                        session_key=session_key,
                        request_id=request_id,
                        detail=f"OpenClaw chat failed: attachment missing on disk ({att_id}). requestId={request_id}",
                    )
                    return
                try:
                    data_bytes = path.read_bytes()
                except Exception as exc:
                    _log_openclaw_chat_error(
                        session_key=session_key,
                        request_id=request_id,
                        detail=f"OpenClaw chat failed: unable to read attachment ({att_id}). requestId={request_id}",
                        raw=str(exc),
                    )
                    return

                mime_type = _normalize_mime_type(str(att.get("mimeType") or "application/octet-stream"))
                filename = _sanitize_attachment_filename(str(att.get("fileName") or "attachment"))
                b64 = base64.b64encode(data_bytes).decode("ascii")
                ws_attachments.append(
                    {
                        "mimeType": mime_type,
                        "fileName": filename,
                        "content": b64,
                    }
                )

        payload = asyncio.run(
            gateway_rpc(
                "chat.send",
                {
                    "sessionKey": session_key,
                    "message": message,
                    "attachments": ws_attachments if ws_attachments else [],
                    "timeoutMs": int(float(os.getenv("OPENCLAW_CHAT_TIMEOUT_SECONDS", "120")) * 1000),
                    "idempotencyKey": request_id,
                },
                scopes=["operator.write"],
            )
        )
        # We don't need the response body; OpenClaw logs the conversation via plugins.
        _ = payload
        _schedule_openclaw_assistant_log_check(session_key=session_key, request_id=request_id, sent_at=sent_at)
    except Exception as exc:
        raw = str(exc)
        if not raw:
            raw = f"{type(exc).__name__}"
        detail = f"OpenClaw chat failed. requestId={request_id}"
        _log_openclaw_chat_error(
            session_key=session_key,
            request_id=request_id,
            detail=detail,
            raw=raw,
        )
    finally:
        # Reliable termination: always broadcast typing: False once the gateway call returns or fails.
        # This is now in the outer finally block to ensure it runs regardless of early returns or exceptions.
        event_hub.publish(
            {
                "type": "openclaw.typing",
                "data": {"sessionKey": session_key, "requestId": request_id, "typing": False},
                "eventTs": now_iso(),
            }
        )


def _openclaw_chat_assistant_log_grace_seconds() -> float:
    """Seconds after a successful OpenClaw gateway call to wait for plugin logs."""
    raw = os.getenv("OPENCLAW_CHAT_ASSISTANT_LOG_GRACE_SECONDS", "30").strip()
    try:
        value = float(raw)
    except Exception:
        value = 30.0
    if value <= 0:
        return 0.0
    return max(1.0, min(600.0, value))


class _OpenClawAssistantLogWatchdog:
    """Single watchdog thread that checks whether assistant logs arrive after a send.

    This avoids spawning one thread per message and prevents premature warnings while
    the gateway request is still in-flight.
    """

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._heap: list[tuple[float, str, str, str]] = []
        self._thread = threading.Thread(target=self._run, name="clawboard-openclaw-watchdog", daemon=True)
        self._started = False

    def start(self) -> None:
        with self._cv:
            if self._started:
                return
            self._started = True
            self._thread.start()

    def schedule(self, *, session_key: str, request_id: str, sent_at: str, delay_seconds: float) -> None:
        base_key = (str(session_key or "").split("|", 1)[0] or "").strip()
        if not base_key:
            return
        due = time.time() + max(0.0, float(delay_seconds))
        with self._cv:
            heapq.heappush(self._heap, (due, base_key, str(request_id or "").strip(), str(sent_at or "").strip()))
            self._cv.notify()

    def _run(self) -> None:
        while True:
            with self._cv:
                while not self._heap:
                    self._cv.wait()
                due, base_key, request_id, sent_at = self._heap[0]
                now = time.time()
                if due > now:
                    self._cv.wait(timeout=due - now)
                    continue
                heapq.heappop(self._heap)
            try:
                self._check(base_key=base_key, request_id=request_id, sent_at=sent_at)
            except Exception:
                # Never crash the watchdog thread.
                pass

    def _check(self, *, base_key: str, request_id: str, sent_at: str) -> None:
        if not base_key or not request_id or not sent_at:
            return

        try:
            with get_session() as session:
                # If we already emitted a system terminal event for this requestId (error/warn), do nothing.
                terminal_query = select(LogEntry.id)
                if DATABASE_URL.startswith("sqlite"):
                    terminal_query = terminal_query.where(
                        text("json_extract(source, '$.requestId') = :rid AND lower(agentId) = 'system'")
                    ).params(rid=request_id)
                else:
                    terminal_query = terminal_query.where(
                        and_(
                            LogEntry.source["requestId"].as_string() == request_id,
                            func.lower(LogEntry.agentId) == "system",
                        )
                    )
                terminal_query = terminal_query.limit(1)
                if session.exec(terminal_query).first():
                    return

                # If any assistant log shows up for this session after the send, the logger plugin is working.
                # Match exact session key, thread variant, and known board task/topic patterns.
                topic_id, task_id = _parse_board_session_key(base_key)
                query = select(LogEntry.id)
                if DATABASE_URL.startswith("sqlite"):
                    conditions = [
                        "json_extract(source, '$.sessionKey') = :base_key",
                        "json_extract(source, '$.sessionKey') LIKE :like_key",
                    ]
                    query_params = {
                        "base_key": base_key,
                        "like_key": f"{base_key}|%",
                    }
                    if topic_id:
                        condition = "json_extract(source, '$.sessionKey') LIKE :contains_topic_key"
                        conditions.append(condition)
                        query_params["contains_topic_key"] = f"%:clawboard:topic:{topic_id}%"
                    if task_id:
                        condition = "json_extract(source, '$.sessionKey') LIKE :contains_task_key"
                        conditions.append(condition)
                        query_params["contains_task_key"] = f"%:clawboard:task:{topic_id}:{task_id}%"
                    query = query.where(
                        text(f"({' OR '.join(conditions)})")
                    ).params(**query_params)
                else:
                    expr = LogEntry.source["sessionKey"].as_string()
                    exprs = [expr == base_key, expr.like(f"{base_key}|%")]
                    if topic_id:
                        exprs.append(expr.like(f"%:clawboard:topic:{topic_id}%"))
                    if task_id:
                        exprs.append(expr.like(f"%:clawboard:task:{topic_id}:{task_id}%"))
                    query = query.where(or_(*exprs))
                query = (
                    query.where(func.lower(LogEntry.agentId) == "assistant")
                    .where(LogEntry.createdAt >= sent_at)
                    .order_by(LogEntry.createdAt.desc())
                    .limit(1)
                )
                if session.exec(query).first():
                    return
        except Exception:
            return

        _log_openclaw_chat_error(
            session_key=base_key,
            request_id=request_id,
            detail=(
                "OpenClaw gateway returned, but no assistant output was logged back to Clawboard yet. "
                "Most common cause: clawboard-logger plugin is disabled or misconfigured (baseUrl/token). "
                f"requestId={request_id}"
            ),
        )


_OPENCLAW_ASSISTANT_LOG_WATCHDOG: _OpenClawAssistantLogWatchdog | None = None
_OPENCLAW_ASSISTANT_LOG_WATCHDOG_LOCK = threading.Lock()


def _schedule_openclaw_assistant_log_check(*, session_key: str, request_id: str, sent_at: str) -> None:
    grace = _openclaw_chat_assistant_log_grace_seconds()
    if grace <= 0:
        return

    global _OPENCLAW_ASSISTANT_LOG_WATCHDOG
    with _OPENCLAW_ASSISTANT_LOG_WATCHDOG_LOCK:
        if _OPENCLAW_ASSISTANT_LOG_WATCHDOG is None:
            _OPENCLAW_ASSISTANT_LOG_WATCHDOG = _OpenClawAssistantLogWatchdog()
            _OPENCLAW_ASSISTANT_LOG_WATCHDOG.start()
        watchdog = _OPENCLAW_ASSISTANT_LOG_WATCHDOG

    watchdog.schedule(session_key=session_key, request_id=request_id, sent_at=sent_at, delay_seconds=grace)


@app.post(
    "/api/openclaw/chat",
    dependencies=[Depends(require_token)],
    response_model=OpenClawChatQueuedResponse,
    tags=["openclaw"],
)
def openclaw_chat(payload: OpenClawChatRequest, background_tasks: BackgroundTasks):
    """Send a user message to OpenClaw via the Gateway and tie it to a stable sessionKey."""
    base_url = os.getenv("OPENCLAW_BASE_URL", "http://127.0.0.1:18789").strip().rstrip("/")
    gateway_token = (os.getenv("OPENCLAW_GATEWAY_TOKEN") or "").strip()
    if not base_url:
        raise HTTPException(status_code=503, detail="OPENCLAW_BASE_URL is not configured")
    if not gateway_token:
        raise HTTPException(status_code=503, detail="OPENCLAW_GATEWAY_TOKEN is required")

    agent_id = (payload.agentId or "main").strip() or "main"
    session_key = payload.sessionKey.strip()
    message = payload.message.strip()
    space_scope_id = _normalize_space_id(getattr(payload, "spaceId", None))
    attachment_ids = [str(att_id).strip() for att_id in (payload.attachmentIds or []) if str(att_id).strip()]
    if not session_key:
        raise HTTPException(status_code=400, detail="sessionKey is required")
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    if len(attachment_ids) > ATTACHMENT_MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Too many attachments. Max is {ATTACHMENT_MAX_FILES}.")
    request_id = create_id("occhat")

    # Persist the user message immediately so the UI can render it without waiting for OpenClaw plugins.
    # OpenClaw is still responsible for logging assistant output + tool traces via plugins.
    topic_id, task_id = _parse_board_session_key(session_key)
    created_at = now_iso()
    try:
        attachments_meta: list[dict[str, Any]] | None = None
        attachments_task: list[dict[str, Any]] | None = None
        with get_session() as session:
            if attachment_ids:
                # Preserve client ordering while validating IDs.
                unique_ids: list[str] = []
                seen: set[str] = set()
                for att_id in attachment_ids:
                    if att_id in seen:
                        continue
                    seen.add(att_id)
                    unique_ids.append(att_id)
                attachment_ids = unique_ids

                rows = session.exec(select(Attachment).where(Attachment.id.in_(attachment_ids))).all()
                by_id = {row.id: row for row in rows}
                missing = [att_id for att_id in attachment_ids if att_id not in by_id]
                if missing:
                    raise HTTPException(status_code=400, detail=f"Attachment(s) not found: {', '.join(missing)}")

                attachments_meta = []
                attachments_task = []
                for att_id in attachment_ids:
                    row = by_id[att_id]
                    mime_type = _normalize_mime_type(row.mimeType)
                    # Defensive re-validation (upload already enforced allowlist).
                    _validate_attachment_mime_type(mime_type)
                    attachments_meta.append(
                        {
                            "id": row.id,
                            "fileName": row.fileName,
                            "mimeType": mime_type,
                            "sizeBytes": row.sizeBytes,
                        }
                    )
                    attachments_task.append(
                        {
                            "id": row.id,
                            "fileName": row.fileName,
                            "mimeType": mime_type,
                            "sizeBytes": row.sizeBytes,
                            "storagePath": row.storagePath,
                        }
                    )

            source_meta: dict[str, Any] = {
                "sessionKey": session_key,
                "channel": "openclaw",
                "requestId": request_id,
                "messageId": request_id,
            }
            if space_scope_id:
                source_meta["boardScopeSpaceId"] = space_scope_id

            payload_log = LogAppend(
                spaceId=space_scope_id,
                topicId=topic_id,
                taskId=task_id,
                type="conversation",
                content=message,
                summary=_clip(_sanitize_log_text(message), 160),
                raw=None,
                createdAt=created_at,
                agentId="user",
                agentLabel="User",
                source=source_meta,
                attachments=attachments_meta,
                classificationStatus="pending",
            )
            entry = append_log_entry(session, payload_log, idempotency_key=f"openclaw-chat:user:{request_id}")

            # Best-effort ownership marker (useful for cleanup/analytics). Do not fail the send
            # if this update can't be persisted.
            if attachment_ids:
                stamp = now_iso()
                for att_id in attachment_ids:
                    row = by_id.get(att_id)
                    if not row:
                        continue
                    if not row.logId:
                        row.logId = entry.id
                    row.updatedAt = stamp
                    session.add(row)
                try:
                    session.commit()
                except Exception:
                    session.rollback()
    except HTTPException:
        raise
    except Exception as exc:
        # Fail closed: if we can't persist the user message, do not send it to OpenClaw.
        # Otherwise Clawboard can show assistant replies/tool traces without the user prompt that triggered them.
        raise HTTPException(status_code=503, detail="Failed to persist user message. Please retry.") from exc

    background_tasks.add_task(
        _run_openclaw_chat,
        request_id,
        base_url=base_url,
        token=gateway_token,
        session_key=session_key,
        agent_id=agent_id,
        sent_at=created_at,
        message=message,
        attachments=attachments_task,
    )
    return {"queued": True, "requestId": request_id}


@app.get(
    "/api/openclaw/skills",
    dependencies=[Depends(require_token)],
    response_model=OpenClawSkillsResponse,
    tags=["openclaw"],
)
async def openclaw_skills(agentId: str = Query(default="main", description="OpenClaw agent id")):
    """Fetch live OpenClaw skill directory via gateway RPC (skills.status)."""
    agent_id = (agentId or "main").strip() or "main"
    try:
        payload = await gateway_rpc("skills.status", {"agentId": agent_id})
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to fetch skills from OpenClaw gateway: {exc}",
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=503, detail="Invalid skills response from OpenClaw gateway")

    # Reduce payload size + keep schema stable for the UI.
    skills_raw = payload.get("skills")
    skills = []
    if isinstance(skills_raw, list):
        for row in skills_raw:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            skills.append(
                {
                    "name": name,
                    "description": str(row.get("description") or "").strip() or None,
                    "emoji": str(row.get("emoji") or "").strip() or None,
                    "eligible": bool(row.get("eligible")) if row.get("eligible") is not None else None,
                    "disabled": bool(row.get("disabled")) if row.get("disabled") is not None else None,
                    "always": bool(row.get("always")) if row.get("always") is not None else None,
                    "source": str(row.get("source") or "").strip() or None,
                }
            )

    return {
        "agentId": agent_id,
        "workspaceDir": str(payload.get("workspaceDir") or "").strip() or None,
        "skills": skills,
    }


@app.get("/api/stream")
async def stream_events(request: Request):
    """Server-sent events stream for real-time UI updates."""
    subscriber = event_hub.subscribe()
    last_event_id = request.headers.get("last-event-id")
    try:
        last_id = int(last_event_id) if last_event_id else None
    except ValueError:
        last_id = None

    async def event_generator():
        try:
            yield "event: ready\ndata: {}\n\n"
            if last_id is not None:
                oldest = event_hub.oldest_id()
                if oldest is not None and last_id < oldest:
                    reset_payload = {"type": "stream.reset"}
                    yield event_hub.encode(None, reset_payload)
                else:
                    for event_id, payload in event_hub.replay(last_id):
                        yield event_hub.encode(event_id, payload)
            while True:
                try:
                    event = await asyncio.wait_for(
                        asyncio.get_running_loop().run_in_executor(None, subscriber.get),
                        timeout=25,
                    )
                    event_id, payload = event
                    yield event_hub.encode(event_id, payload)
                except asyncio.TimeoutError:
                    # Emit a lightweight heartbeat as a normal SSE message so clients can detect stale
                    # connections without user interaction. Avoid `eventTs` so clients don't advance
                    # incremental sync cursors based on heartbeats alone.
                    yield event_hub.encode(None, {"type": "stream.ping", "ts": now_iso()})
        except asyncio.CancelledError:
            pass
        finally:
            event_hub.unsubscribe(subscriber)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Prevent proxy buffering (nginx) from stalling SSE delivery.
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/config", response_model=InstanceResponse, tags=["config"])
def get_config():
    """Return instance configuration plus token requirement info."""
    with get_session() as session:
        instance = session.get(InstanceConfig, 1)
        if not instance:
            instance = InstanceConfig(
                id=1,
                title="Clawboard",
                integrationLevel="write",
                updatedAt=now_iso(),
            )
            session.add(instance)
            session.commit()
            session.refresh(instance)
        return {
            "instance": instance.model_dump(),
            "tokenRequired": is_token_required(),
            "tokenConfigured": is_token_configured(),
        }


@app.post("/api/config", dependencies=[Depends(require_token)], response_model=InstanceResponse, tags=["config"])
def update_config(
    payload: InstanceUpdate = Body(
        ...,
        examples={
            "default": {
                "summary": "Update instance config",
                "value": {"title": "Clawboard Ops", "integrationLevel": "write"},
            }
        },
    )
):
    """Update instance title/integration level."""
    with get_session() as session:
        instance = session.get(InstanceConfig, 1)
        if not instance:
            instance = InstanceConfig(
                id=1,
                title=payload.title or "Clawboard",
                integrationLevel=payload.integrationLevel or "write",
                updatedAt=now_iso(),
            )
        else:
            if payload.title is not None:
                instance.title = payload.title
            if payload.integrationLevel is not None:
                instance.integrationLevel = payload.integrationLevel
            instance.updatedAt = now_iso()
        session.add(instance)
        session.commit()
        session.refresh(instance)
        event_hub.publish(
            {
                "type": "config.updated",
                "data": instance.model_dump(),
                "eventTs": instance.updatedAt,
            }
        )
        return {
            "instance": instance.model_dump(),
            "tokenRequired": is_token_required(),
            "tokenConfigured": is_token_configured(),
        }


@app.post("/api/admin/start-fresh-replay", dependencies=[Depends(require_token)], tags=["admin"])
def admin_start_fresh_replay(
    payload: StartFreshReplayRequest = Body(
        default=StartFreshReplayRequest(),
        examples={
            "default": {
                "summary": "Start fresh replay",
                "value": {"integrationLevel": "full"},
            }
        },
    )
):
    """Admin-only: clear topics/tasks and mark all logs pending so the classifier replays derived state."""
    timestamp = now_iso()
    with get_session() as session:
        instance = session.get(InstanceConfig, 1)
        if not instance:
            instance = InstanceConfig(
                id=1,
                title="Clawboard",
                integrationLevel=payload.integrationLevel,
                updatedAt=timestamp,
            )
        else:
            instance.integrationLevel = payload.integrationLevel
            instance.updatedAt = timestamp
        session.add(instance)

        # Reset derived associations and classifier state without deleting history.
        session.exec(
            text(
                """
                UPDATE logentry
                SET topicId = NULL,
                    taskId = NULL,
                    classificationStatus = 'pending',
                    classificationAttempts = 0,
                    classificationError = NULL,
                    updatedAt = :updated_at
                ;
                """
            ).bindparams(updated_at=timestamp)
        )

        # Derived objects: wipe so classifier can rebuild cleanly.
        session.exec(text("DELETE FROM ingestqueue;"))
        session.exec(text("DELETE FROM task;"))
        session.exec(text("DELETE FROM topic;"))

        session.commit()

    return {"ok": True, "resetAt": timestamp, "integrationLevel": payload.integrationLevel}


@app.get("/api/spaces", response_model=List[SpaceOut], tags=["spaces"])
def list_spaces():
    """List spaces (deterministic order)."""
    with get_session() as session:
        spaces = _list_spaces(session)
        spaces.sort(key=lambda item: (0 if item.id == DEFAULT_SPACE_ID else 1, item.name.lower(), item.id))
        return spaces


@app.post("/api/spaces", dependencies=[Depends(require_token)], response_model=SpaceOut, tags=["spaces"])
def upsert_space(payload: SpaceUpsert = Body(...)):
    """Create or update a space."""
    with get_session() as session:
        _ensure_default_space(session)
        stamp = now_iso()
        candidate_id = _normalize_space_id(payload.id) if payload.id is not None else None
        if candidate_id:
            row = session.get(Space, candidate_id)
            if row:
                row.name = payload.name
                if "color" in payload.model_fields_set:
                    if payload.color is None:
                        row.color = None
                    else:
                        normalized = _normalize_hex_color(payload.color)
                        if not normalized:
                            raise HTTPException(status_code=400, detail="Invalid color (expected #RRGGBB)")
                        row.color = normalized
                row.updatedAt = stamp
                session.add(row)
                session.commit()
                session.refresh(row)
                _publish_space_upserted(row)
                return row
            space_id = candidate_id
        else:
            space_id = create_id("space")

        normalized_color = _normalize_hex_color(payload.color) if payload.color is not None else None
        if payload.color is not None and not normalized_color:
            raise HTTPException(status_code=400, detail="Invalid color (expected #RRGGBB)")
        row = Space(
            id=space_id,
            name=payload.name,
            color=normalized_color,
            defaultVisible=True,
            connectivity={},
            createdAt=stamp,
            updatedAt=stamp,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        _publish_space_upserted(row)
        return row


@app.patch(
    "/api/spaces/{space_id}/connectivity",
    dependencies=[Depends(require_token)],
    response_model=SpaceOut,
    tags=["spaces"],
)
def patch_space_connectivity(space_id: str, payload: SpaceConnectivityPatch = Body(...)):
    """Patch default visibility policy and explicit connectivity toggles for one source space."""
    normalized_id = _normalize_space_id(space_id)
    if not normalized_id:
        raise HTTPException(status_code=400, detail="space_id is required")
    with get_session() as session:
        _ensure_default_space(session)
        touched = False
        row = session.get(Space, normalized_id)
        if not row:
            row = _ensure_space_row(session, space_id=normalized_id, name=_space_display_name_from_id(normalized_id))
            touched = True

        spaces = _list_spaces(session)
        valid_ids = {str(item.id) for item in spaces}
        if touched:
            session.commit()
            row = session.get(Space, normalized_id)
            if not row:
                raise HTTPException(status_code=404, detail="Space not found")

        connectivity = _normalize_connectivity(getattr(row, "connectivity", None))
        if "defaultVisible" in payload.model_fields_set and payload.defaultVisible is not None:
            row.defaultVisible = bool(payload.defaultVisible)
        for raw_target, enabled in payload.connectivity.items():
            target = _normalize_space_id(raw_target)
            if not target:
                continue
            if target == normalized_id:
                continue
            if target not in valid_ids:
                continue
            connectivity[target] = bool(enabled)

        row.connectivity = connectivity
        row.updatedAt = now_iso()
        session.add(row)
        session.commit()
        session.refresh(row)
        _publish_space_upserted(row)
        return row


@app.get("/api/spaces/allowed", response_model=SpaceAllowedResponse, tags=["spaces"])
def get_allowed_spaces(
    spaceId: str = Query(..., min_length=1, description="Source space id to resolve connectivity for."),
):
    with get_session() as session:
        resolved_source = _normalize_space_id(spaceId) or DEFAULT_SPACE_ID
        allowed = sorted(_allowed_space_ids_for_source(session, resolved_source))
        if resolved_source not in allowed:
            resolved_source = DEFAULT_SPACE_ID
        return {"spaceId": resolved_source, "allowedSpaceIds": allowed}


@app.post("/api/spaces/{space_id}/cleanup-tag", dependencies=[Depends(require_token)], tags=["spaces"])
def cleanup_space_tag(space_id: str):
    """Remove one space tag association from every topic.

    This removes tags that resolve to `space_id`, and re-homes topics currently owned by
    that space to the next derived tag space (or default) to keep scope queries consistent.
    """

    normalized_id = _normalize_space_id(space_id)
    if not normalized_id:
        raise HTTPException(status_code=400, detail="space_id is required")
    if normalized_id == DEFAULT_SPACE_ID:
        raise HTTPException(status_code=400, detail="Cannot cleanup default space tag")

    stamp = now_iso()
    with get_session() as session:
        _ensure_default_space(session)

        topics = session.exec(select(Topic)).all()
        prior_space_by_topic_id: dict[str, str] = {}
        changed_topic_ids: list[str] = []
        removed_tag_count = 0

        for topic in topics:
            topic_id = str(getattr(topic, "id", "") or "").strip()
            if not topic_id:
                continue

            prior_space_id = _space_id_for_topic(topic)
            prior_tags = _normalize_tags(topic.tags or [])
            next_tags: list[str] = []
            removed_for_topic = 0

            for raw_tag in prior_tags:
                mapped = _topic_space_candidates_from_tags([raw_tag])
                mapped_space_id = mapped[0][0] if mapped else None
                if mapped_space_id == normalized_id:
                    removed_for_topic += 1
                    continue
                next_tags.append(raw_tag)

            touched = False
            if removed_for_topic > 0:
                topic.tags = next_tags
                removed_tag_count += removed_for_topic
                touched = True

            if prior_space_id == normalized_id:
                resolved_space_id = _resolve_space_id_from_topic_tags(
                    session,
                    topic.tags or next_tags,
                    fallback_space_id=DEFAULT_SPACE_ID,
                )
                if resolved_space_id != prior_space_id:
                    topic.spaceId = resolved_space_id
                touched = True

            if not touched:
                continue

            prior_space_by_topic_id[topic_id] = prior_space_id
            topic.updatedAt = stamp
            session.add(topic)
            changed_topic_ids.append(topic_id)

        if changed_topic_ids:
            session.commit()
            changed_topics = session.exec(select(Topic).where(Topic.id.in_(changed_topic_ids))).all()

            propagated = False
            for topic in changed_topics:
                topic_id = str(getattr(topic, "id", "") or "").strip()
                if not topic_id:
                    continue
                previous_space = prior_space_by_topic_id.get(topic_id)
                if not previous_space:
                    continue
                if _space_id_for_topic(topic) == previous_space:
                    continue
                _propagate_topic_space(session, topic, stamp=stamp)
                propagated = True

            if propagated:
                session.commit()
                changed_topics = session.exec(select(Topic).where(Topic.id.in_(changed_topic_ids))).all()

            for topic in changed_topics:
                event_hub.publish({"type": "topic.upserted", "data": topic.model_dump(), "eventTs": topic.updatedAt})
                topic_text = " ".join(
                    [
                        str(topic.name or "").strip(),
                        str(topic.description or "").strip(),
                        " ".join(
                            [
                                str(t).strip()
                                for t in (topic.tags or [])
                                if str(t).strip() and not str(t).strip().lower().startswith("system:")
                            ]
                        ),
                    ]
                ).strip()
                enqueue_reindex_request({"op": "upsert", "kind": "topic", "id": topic.id, "text": topic_text})

        space_rows = session.exec(select(Space)).all()
        touched_spaces: list[str] = []
        for row in space_rows:
            row_id = str(getattr(row, "id", "") or "").strip()
            if not row_id:
                continue
            connectivity = _normalize_connectivity(getattr(row, "connectivity", None))
            if normalized_id not in connectivity:
                continue
            del connectivity[normalized_id]
            row.connectivity = connectivity
            row.updatedAt = stamp
            session.add(row)
            touched_spaces.append(row_id)

        if touched_spaces:
            session.commit()
            for row_id in touched_spaces:
                refreshed = session.get(Space, row_id)
                if refreshed:
                    _publish_space_upserted(refreshed)

        return {
            "ok": True,
            "spaceId": normalized_id,
            "updatedTopicCount": len(changed_topic_ids),
            "removedTagCount": removed_tag_count,
        }


@app.get("/api/topics", response_model=List[TopicOut], tags=["topics"])
def list_topics(
    sessionKey: str | None = Query(default=None, description="Session key continuity scope (source.sessionKey)."),
    spaceId: str | None = Query(default=None, description="Resolve visibility from this source space id."),
    allowedSpaceIds: str | None = Query(default=None, description="Explicit allowed space ids (comma-separated)."),
):
    """List topics (pinned first, newest activity first)."""
    with get_session() as session:
        topics = session.exec(select(Topic)).all()
        resolved_source_space_id = _resolve_source_space_id(
            session,
            explicit_space_id=spaceId,
            session_key=sessionKey,
        )
        allowed_space_ids = _resolve_allowed_space_ids(
            session,
            source_space_id=resolved_source_space_id,
            allowed_space_ids_raw=allowedSpaceIds,
        )
        if allowed_space_ids is not None:
            topics = [item for item in topics if _topic_matches_allowed_spaces(item, allowed_space_ids)]
        # Most recently updated first, then manual order, then pinned first.
        topics.sort(key=lambda t: t.updatedAt, reverse=True)
        topics.sort(key=lambda t: getattr(t, "sortIndex", 0))
        topics.sort(key=lambda t: not bool(getattr(t, "pinned", False)))
        return topics


@app.get("/api/topics/{topic_id}", response_model=TopicOut, tags=["topics"])
def get_topic(topic_id: str):
    """Fetch one topic by id."""
    with get_session() as session:
        topic = session.get(Topic, topic_id)
        if not topic:
            raise HTTPException(status_code=404, detail="Topic not found")
        return topic


@app.patch("/api/topics/{topic_id}", dependencies=[Depends(require_token)], response_model=TopicOut, tags=["topics"])
def patch_topic(topic_id: str, payload: TopicPatch = Body(...)):
    """Patch an existing topic (partial update)."""
    with get_session() as session:
        topic = session.get(Topic, topic_id)
        if not topic:
            raise HTTPException(status_code=404, detail="Topic not found")

        fields = payload.model_fields_set
        stamp = now_iso()
        touched = False
        reindex_needed = False
        prior_space_id = _space_id_for_topic(topic)

        if "spaceId" in fields:
            normalized_space_id = _normalize_space_id(payload.spaceId)
            if not normalized_space_id:
                raise HTTPException(status_code=400, detail="spaceId is required")
            _ensure_default_space(session)
            target_space = session.get(Space, normalized_space_id)
            if not target_space:
                raise HTTPException(status_code=400, detail="spaceId not found")
            topic.spaceId = normalized_space_id
            touched = True

        if "name" in fields:
            name = (payload.name or "").strip()
            if not name:
                raise HTTPException(status_code=400, detail="name cannot be empty")
            if name != topic.name:
                reindex_needed = True
            topic.name = name
            touched = True

        if "color" in fields:
            if payload.color is None:
                topic.color = None
                touched = True
            else:
                normalized = _normalize_hex_color(payload.color)
                if not normalized:
                    raise HTTPException(status_code=400, detail="Invalid color (expected #RRGGBB)")
                topic.color = normalized
                touched = True

        if "description" in fields:
            desc = payload.description
            desc_clean = desc.strip() if isinstance(desc, str) else None
            if desc_clean == "":
                desc_clean = None
            if desc_clean != (topic.description or None):
                reindex_needed = True
            topic.description = desc_clean
            touched = True

        if "priority" in fields:
            topic.priority = payload.priority
            touched = True

        if "status" in fields:
            topic.status = normalize_topic_status(payload.status)
            touched = True

        if "snoozedUntil" in fields:
            topic.snoozedUntil = payload.snoozedUntil
            touched = True

        # Normalize snooze invariants.
        if "status" in fields or "snoozedUntil" in fields:
            normalized_status = normalize_topic_status(topic.status) or "active"

            # If the caller cleared snoozedUntil without explicitly setting status,
            # treat that as an unsnooze request.
            if "snoozedUntil" in fields and payload.snoozedUntil is None and "status" not in fields:
                if normalized_status in {"snoozed", "paused"}:
                    topic.status = "active"
                    normalized_status = "active"
                    touched = True

            # Active/archived topics should not carry a snooze timer.
            if normalized_status in {"active", "archived"}:
                if topic.snoozedUntil is not None:
                    topic.snoozedUntil = None
                    touched = True
            # A snooze timer implies snoozed status.
            elif topic.snoozedUntil is not None and normalized_status != "snoozed":
                topic.status = "snoozed"
                touched = True

        if "tags" in fields:
            next_tags = _normalize_tags(payload.tags or [])
            topic.tags = next_tags
            for resolved_space_id, label in _topic_space_candidates_from_tags(next_tags):
                _ensure_space_row(
                    session,
                    space_id=resolved_space_id,
                    name=label if resolved_space_id != DEFAULT_SPACE_ID else DEFAULT_SPACE_NAME,
                )
            if "spaceId" not in fields:
                topic.spaceId = _resolve_space_id_from_topic_tags(
                    session,
                    next_tags,
                    fallback_space_id=DEFAULT_SPACE_ID,
                )
            reindex_needed = True
            touched = True

        if "parentId" in fields:
            topic.parentId = payload.parentId
            touched = True

        if "pinned" in fields:
            topic.pinned = payload.pinned
            touched = True

        # Digest fields are system-managed and should not reorder topics by activity.
        if "digest" in fields:
            topic.digest = payload.digest
        if "digestUpdatedAt" in fields:
            topic.digestUpdatedAt = payload.digestUpdatedAt

        if touched:
            topic.updatedAt = stamp

        space_changed = _space_id_for_topic(topic) != prior_space_id

        session.add(topic)
        session.commit()
        session.refresh(topic)
        if space_changed:
            _propagate_topic_space(session, topic, stamp=stamp)
            session.commit()
            session.refresh(topic)
        _publish_space_upserted(session.get(Space, _space_id_for_topic(topic)))
        event_hub.publish({"type": "topic.upserted", "data": topic.model_dump(), "eventTs": topic.updatedAt})

        if reindex_needed:
            topic_text = " ".join(
                [
                    str(topic.name or "").strip(),
                    str(topic.description or "").strip(),
                    " ".join(
                        [
                            str(t).strip()
                            for t in (topic.tags or [])
                            if str(t).strip() and not str(t).strip().lower().startswith("system:")
                        ]
                    ),
                ]
            ).strip()
            enqueue_reindex_request({"op": "upsert", "kind": "topic", "id": topic.id, "text": topic_text})

        return topic


@app.post("/api/topics/reorder", dependencies=[Depends(require_token)], tags=["topics"])
def reorder_topics(payload: TopicReorderRequest):
    """Persist a manual topic order by assigning sortIndex sequentially."""
    ordered_ids: list[str] = []
    seen: set[str] = set()
    for value in payload.orderedIds:
        candidate = (value or "").strip()
        if not candidate:
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        ordered_ids.append(candidate)
    with get_session() as session:
        topics = session.exec(select(Topic)).all()
        all_ids = {topic.id for topic in topics}
        extra = sorted(seen - all_ids)
        if extra:
            detail = {
                "extra": extra[:50],
                "message": "orderedIds may omit topic ids, but must not contain unknown ids.",
            }
            raise HTTPException(status_code=400, detail=detail)

        # Start from the persisted order (pinned first) so partial reorders keep hidden topics
        # in their existing slots (ex: snoozed topics that are not currently visible).
        persisted = sorted(
            topics,
            key=lambda t: (
                0 if bool(getattr(t, "pinned", False)) else 1,
                int(getattr(t, "sortIndex", 0) or 0),
                getattr(t, "updatedAt", "") or "",
                t.id,
            ),
        )
        persisted_ids = [topic.id for topic in persisted]
        if not ordered_ids:
            final_ids = persisted_ids
        else:
            provided = set(ordered_ids)
            i = 0
            final_ids: list[str] = []
            for topic_id in persisted_ids:
                if topic_id in provided:
                    if i < len(ordered_ids):
                        final_ids.append(ordered_ids[i])
                        i += 1
                    else:
                        # Should be unreachable, but keep best-effort behavior.
                        continue
                else:
                    final_ids.append(topic_id)
            while i < len(ordered_ids):
                final_ids.append(ordered_ids[i])
                i += 1

            # Safety: if something went off the rails, fall back to a deterministic full order.
            if set(final_ids) != all_ids or len(final_ids) != len(all_ids):
                remainder = [topic_id for topic_id in persisted_ids if topic_id not in provided]
                final_ids = [*ordered_ids, *remainder]

        topics_by_id = {topic.id: topic for topic in topics}
        before_sort = {topic.id: int(getattr(topic, "sortIndex", 0) or 0) for topic in topics}
        # Reordering is not a meaningful content update; do not touch updatedAt.
        event_ts = now_iso()
        changed: list[str] = []
        for idx, topic_id in enumerate(final_ids):
            topic = topics_by_id.get(topic_id)
            if not topic:
                continue
            prior = before_sort.get(topic_id)
            if prior != idx:
                topic.sortIndex = idx
                session.add(topic)
                changed.append(topic_id)
        session.commit()
        for topic_id in changed:
            topic = topics_by_id.get(topic_id)
            if not topic:
                continue
            event_hub.publish({"type": "topic.upserted", "data": topic.model_dump(), "eventTs": event_ts})
        return {"ok": True, "count": len(final_ids), "changed": len(changed)}


@app.post("/api/topics", dependencies=[Depends(require_token)], response_model=TopicOut, tags=["topics"])
def upsert_topic(
    payload: TopicUpsert = Body(
        ...,
        examples={
            "default": {
                "summary": "Upsert topic",
                "value": {
                    "id": "topic-1",
                    "name": "Clawboard",
                    "description": "Product work.",
                    "priority": "high",
                    "status": "active",
                    "tags": ["product", "platform"],
                    "parentId": "topic-1",
                    "pinned": True,
                },
            }
        },
    ),
    x_clawboard_actor: str | None = Header(default=None, alias="X-Clawboard-Actor"),
):
    """Create or update a topic."""
    with get_session() as session:
        _ensure_default_space(session)
        topic = session.get(Topic, payload.id) if payload.id else None
        timestamp = now_iso()
        fields = payload.model_fields_set
        if topic:
            prior_space_id = _space_id_for_topic(topic)
            topic.name = payload.name or topic.name
            if "spaceId" in fields:
                normalized_space_id = _normalize_space_id(payload.spaceId)
                if not normalized_space_id:
                    raise HTTPException(status_code=400, detail="spaceId is required")
                target_space = session.get(Space, normalized_space_id)
                if not target_space:
                    raise HTTPException(status_code=400, detail="spaceId not found")
                topic.spaceId = normalized_space_id
            if "color" in fields:
                if payload.color is None:
                    topic.color = None
                else:
                    normalized_color = _normalize_hex_color(payload.color)
                    if normalized_color:
                        topic.color = normalized_color
            if "description" in fields:
                topic.description = payload.description
            if "priority" in fields:
                topic.priority = payload.priority
            if "status" in fields:
                topic.status = normalize_topic_status(payload.status)
            if "snoozedUntil" in fields:
                topic.snoozedUntil = payload.snoozedUntil
            if "tags" in fields:
                topic.tags = _normalize_tags(payload.tags or [])
                for resolved_space_id, label in _topic_space_candidates_from_tags(topic.tags or []):
                    _ensure_space_row(
                        session,
                        space_id=resolved_space_id,
                        name=label if resolved_space_id != DEFAULT_SPACE_ID else DEFAULT_SPACE_NAME,
                    )
                if "spaceId" not in fields:
                    topic.spaceId = _resolve_space_id_from_topic_tags(
                        session,
                        topic.tags or [],
                        fallback_space_id=DEFAULT_SPACE_ID,
                    )
            if "parentId" in fields:
                topic.parentId = payload.parentId
            if "pinned" in fields:
                topic.pinned = payload.pinned

            normalized_status = normalize_topic_status(topic.status) or "active"
            if "snoozedUntil" in fields and payload.snoozedUntil is None and "status" not in fields:
                if normalized_status in {"snoozed", "paused"}:
                    topic.status = "active"
                    normalized_status = "active"
            if normalized_status in {"active", "archived"}:
                topic.status = normalized_status
                topic.snoozedUntil = None
            elif topic.snoozedUntil is not None and normalized_status != "snoozed":
                topic.status = "snoozed"

            topic.updatedAt = timestamp
            session.add(topic)
            session.commit()
            session.refresh(topic)
            if _space_id_for_topic(topic) != prior_space_id:
                _propagate_topic_space(session, topic, stamp=timestamp)
                session.commit()
                session.refresh(topic)
            _publish_space_upserted(session.get(Space, _space_id_for_topic(topic)))
        else:
            actor = str(x_clawboard_actor or "").strip().lower()
            created_by = "classifier" if actor == "classifier" else "user"
            if "spaceId" in fields:
                requested_space_id = _normalize_space_id(payload.spaceId)
                if not requested_space_id:
                    raise HTTPException(status_code=400, detail="spaceId is required")
                target_space = session.get(Space, requested_space_id)
                if not target_space:
                    raise HTTPException(status_code=400, detail="spaceId not found")
            else:
                requested_space_id = _resolve_space_id_from_topic_tags(
                    session,
                    payload.tags or [],
                    fallback_space_id=DEFAULT_SPACE_ID,
                )
            duplicate = _find_similar_topic(session, payload.name, space_id=requested_space_id)
            if duplicate:
                duplicate_prior_space_id = _space_id_for_topic(duplicate)
                if "color" in fields:
                    if payload.color is None:
                        duplicate.color = None
                    else:
                        normalized_color = _normalize_hex_color(payload.color)
                        if normalized_color:
                            duplicate.color = normalized_color
                elif not _normalize_hex_color(getattr(duplicate, "color", None)):
                    used_colors = {
                        _normalize_hex_color(getattr(item, "color", None))
                        for item in session.exec(select(Topic)).all()
                        if _normalize_hex_color(getattr(item, "color", None))
                    }
                    duplicate.color = _auto_pick_color(f"topic:{duplicate.id}:{duplicate.name}", used_colors, 0.0)
                if "description" in fields and payload.description is not None and not duplicate.description:
                    duplicate.description = payload.description
                if "tags" in fields and payload.tags:
                    merged = _normalize_tags([*(duplicate.tags or []), *payload.tags])
                    duplicate.tags = merged
                    for resolved_space_id, label in _topic_space_candidates_from_tags(duplicate.tags or []):
                        _ensure_space_row(
                            session,
                            space_id=resolved_space_id,
                            name=label if resolved_space_id != DEFAULT_SPACE_ID else DEFAULT_SPACE_NAME,
                        )
                elif "tags" in fields:
                    duplicate.tags = []
                if "priority" in fields and payload.priority is not None:
                    duplicate.priority = payload.priority
                if "status" in fields:
                    duplicate.status = normalize_topic_status(payload.status)
                if "snoozedUntil" in fields:
                    duplicate.snoozedUntil = payload.snoozedUntil
                if "pinned" in fields:
                    duplicate.pinned = payload.pinned
                if "spaceId" in fields:
                    normalized_space_id = _normalize_space_id(payload.spaceId)
                    if not normalized_space_id:
                        raise HTTPException(status_code=400, detail="spaceId is required")
                    target_space = session.get(Space, normalized_space_id)
                    if not target_space:
                        raise HTTPException(status_code=400, detail="spaceId not found")
                    duplicate.spaceId = normalized_space_id
                elif "tags" in fields:
                    duplicate.spaceId = _resolve_space_id_from_topic_tags(
                        session,
                        duplicate.tags or [],
                        fallback_space_id=DEFAULT_SPACE_ID,
                    )

                normalized_status = normalize_topic_status(duplicate.status) or "active"
                if "snoozedUntil" in fields and payload.snoozedUntil is None and "status" not in fields:
                    if normalized_status in {"snoozed", "paused"}:
                        duplicate.status = "active"
                        normalized_status = "active"
                if normalized_status in {"active", "archived"}:
                    duplicate.status = normalized_status
                    duplicate.snoozedUntil = None
                elif duplicate.snoozedUntil is not None and normalized_status != "snoozed":
                    duplicate.status = "snoozed"

                duplicate.updatedAt = timestamp
                session.add(duplicate)
                session.commit()
                session.refresh(duplicate)
                if _space_id_for_topic(duplicate) != duplicate_prior_space_id:
                    _propagate_topic_space(session, duplicate, stamp=timestamp)
                    session.commit()
                    session.refresh(duplicate)
                _publish_space_upserted(session.get(Space, _space_id_for_topic(duplicate)))
                event_hub.publish({"type": "topic.upserted", "data": duplicate.model_dump(), "eventTs": duplicate.updatedAt})
                topic_text = " ".join(
                    [
                        str(duplicate.name or "").strip(),
                        str(duplicate.description or "").strip(),
                        " ".join(
                            [
                                str(t).strip()
                                for t in (duplicate.tags or [])
                                if str(t).strip() and not str(t).strip().lower().startswith("system:")
                            ]
                        ),
                    ]
                ).strip()
                enqueue_reindex_request({"op": "upsert", "kind": "topic", "id": duplicate.id, "text": topic_text})
                return duplicate
            used_colors = {
                _normalize_hex_color(getattr(item, "color", None))
                for item in session.exec(select(Topic)).all()
                if _normalize_hex_color(getattr(item, "color", None))
            }
            resolved_color = _normalize_hex_color(payload.color)
            if not resolved_color:
                resolved_color = _auto_pick_color(f"topic:{payload.id or ''}:{payload.name}", used_colors, 0.0)
            sort_index = _next_sort_index_for_new_topic(session, bool(payload.pinned or False))
            resolved_status = normalize_topic_status(payload.status) or "active"
            resolved_snoozed_until = payload.snoozedUntil
            if resolved_status in {"active", "archived"}:
                resolved_snoozed_until = None
            elif resolved_snoozed_until is not None and resolved_status != "snoozed":
                resolved_status = "snoozed"
            resolved_space_id = _normalize_space_id(requested_space_id) or DEFAULT_SPACE_ID
            if resolved_space_id == DEFAULT_SPACE_ID:
                _ensure_default_space(session)
            topic = Topic(
                id=payload.id or create_id("topic"),
                spaceId=resolved_space_id,
                name=payload.name,
                createdBy=created_by,
                sortIndex=sort_index,
                color=resolved_color,
                description=payload.description,
                priority=payload.priority or "medium",
                status=resolved_status,
                snoozedUntil=resolved_snoozed_until,
                tags=_normalize_tags(payload.tags or []),
                parentId=payload.parentId,
                pinned=payload.pinned or False,
                createdAt=timestamp,
                updatedAt=timestamp,
            )
            for resolved_tag_space_id, label in _topic_space_candidates_from_tags(topic.tags or []):
                _ensure_space_row(
                    session,
                    space_id=resolved_tag_space_id,
                    name=label if resolved_tag_space_id != DEFAULT_SPACE_ID else DEFAULT_SPACE_NAME,
                )
            session.add(topic)
            session.commit()
            session.refresh(topic)
            _publish_space_upserted(session.get(Space, _space_id_for_topic(topic)))
        event_hub.publish({"type": "topic.upserted", "data": topic.model_dump(), "eventTs": topic.updatedAt})
        topic_text = " ".join(
            [
                str(topic.name or "").strip(),
                str(topic.description or "").strip(),
                " ".join(
                    [str(t).strip() for t in (topic.tags or []) if str(t).strip() and not str(t).strip().lower().startswith("system:")]
                ),
            ]
        ).strip()
        enqueue_reindex_request({"op": "upsert", "kind": "topic", "id": topic.id, "text": topic_text})
        return topic


@app.delete("/api/topics/{topic_id}", dependencies=[Depends(require_token)], tags=["topics"])
def delete_topic(topic_id: str):
    """Delete a topic and detach dependent tasks/logs to keep history intact."""
    with get_session() as session:
        topic = session.get(Topic, topic_id)
        if not topic:
            return {"ok": True, "deleted": False, "detachedTasks": 0, "detachedLogs": 0}

        detached_at = now_iso()
        tasks = session.exec(select(Task).where(Task.topicId == topic_id)).all()
        logs = session.exec(select(LogEntry).where(LogEntry.topicId == topic_id)).all()

        for task in tasks:
            task.topicId = None
            task.updatedAt = detached_at
            session.add(task)

        for entry in logs:
            entry.topicId = None
            entry.updatedAt = detached_at
            session.add(entry)

        session.delete(topic)
        session.commit()

        enqueue_reindex_request({"op": "delete", "kind": "topic", "id": topic_id})
        for task in tasks:
            enqueue_reindex_request(
                {
                            "op": "upsert",
                            "kind": "task",
                            "id": task.id,
                            "topicId": task.topicId,
                            "text": " ".join(
                                [
                                    str(task.title or "").strip(),
                                    str(task.status or "").strip(),
                                    " ".join(
                                        [str(t).strip() for t in (task.tags or []) if str(t).strip() and not str(t).strip().lower().startswith("system:")]
                                    ),
                                ]
                            ).strip(),
                        }
                    )

        for task in tasks:
            event_hub.publish({"type": "task.upserted", "data": task.model_dump(), "eventTs": task.updatedAt})
        for entry in logs:
            event_hub.publish({"type": "log.patched", "data": entry.model_dump(exclude={"raw"}), "eventTs": entry.updatedAt})
        event_hub.publish({"type": "topic.deleted", "data": {"id": topic_id}, "eventTs": detached_at})

        return {
            "ok": True,
            "deleted": True,
            "id": topic_id,
            "detachedTasks": len(tasks),
            "detachedLogs": len(logs),
        }


@app.get("/api/tasks", response_model=List[TaskOut], tags=["tasks"])
def list_tasks(
    topicId: str | None = Query(
        default=None,
        description="Filter tasks by topic ID.",
        example="topic-1",
    ),
    sessionKey: str | None = Query(default=None, description="Session key continuity scope (source.sessionKey)."),
    spaceId: str | None = Query(default=None, description="Resolve visibility from this source space id."),
    allowedSpaceIds: str | None = Query(default=None, description="Explicit allowed space ids (comma-separated)."),
):
    """List tasks (pinned first, newest activity first)."""
    with get_session() as session:
        tasks = session.exec(select(Task)).all()
        resolved_source_space_id = _resolve_source_space_id(
            session,
            explicit_space_id=spaceId,
            session_key=sessionKey,
        )
        allowed_space_ids = _resolve_allowed_space_ids(
            session,
            source_space_id=resolved_source_space_id,
            allowed_space_ids_raw=allowedSpaceIds,
        )
        if allowed_space_ids is not None:
            topic_by_id = _load_topics_by_ids(
                session,
                [str(getattr(task, "topicId", "") or "").strip() for task in tasks],
            )
            tasks = [item for item in tasks if _task_matches_allowed_spaces(item, allowed_space_ids, topic_by_id)]
        if topicId:
            tasks = [t for t in tasks if t.topicId == topicId]
        tasks.sort(key=lambda t: t.updatedAt, reverse=True)
        tasks.sort(key=lambda t: getattr(t, "sortIndex", 0))
        tasks.sort(key=lambda t: not bool(getattr(t, "pinned", False)))
        return tasks


@app.get("/api/tasks/{task_id}", response_model=TaskOut, tags=["tasks"])
def get_task(task_id: str):
    """Fetch one task by id."""
    with get_session() as session:
        task = session.get(Task, task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        return task


@app.patch("/api/tasks/{task_id}", dependencies=[Depends(require_token)], response_model=TaskOut, tags=["tasks"])
def patch_task(task_id: str, payload: TaskPatch = Body(...)):
    """Patch an existing task (partial update)."""
    with get_session() as session:
        task = session.get(Task, task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        fields = payload.model_fields_set
        stamp = now_iso()
        touched = False
        reindex_needed = False
        space_changed = False

        if "spaceId" in fields:
            normalized_space_id = _normalize_space_id(payload.spaceId)
            if not normalized_space_id:
                raise HTTPException(status_code=400, detail="spaceId is required")
            _ensure_default_space(session)
            target_space = session.get(Space, normalized_space_id)
            if not target_space:
                raise HTTPException(status_code=400, detail="spaceId not found")
            if _space_id_for_task(task) != normalized_space_id:
                space_changed = True
            task.spaceId = normalized_space_id
            touched = True

        if "title" in fields:
            title = (payload.title or "").strip()
            if not title:
                raise HTTPException(status_code=400, detail="title cannot be empty")
            if title != task.title:
                reindex_needed = True
            task.title = title
            touched = True

        if "color" in fields:
            if payload.color is None:
                task.color = None
                touched = True
            else:
                normalized = _normalize_hex_color(payload.color)
                if not normalized:
                    raise HTTPException(status_code=400, detail="Invalid color (expected #RRGGBB)")
                task.color = normalized
                touched = True

        if "topicId" in fields:
            if payload.topicId:
                parent = session.get(Topic, payload.topicId)
                if not parent:
                    raise HTTPException(status_code=400, detail="topicId not found")
                task.topicId = payload.topicId
                parent_space_id = _space_id_for_topic(parent)
                if _space_id_for_task(task) != parent_space_id:
                    task.spaceId = parent_space_id
                    space_changed = True
            else:
                task.topicId = None
            touched = True
            reindex_needed = True

        if "status" in fields:
            task.status = payload.status or task.status
            touched = True
            reindex_needed = True

        if "priority" in fields:
            task.priority = payload.priority
            touched = True

        if "dueDate" in fields:
            task.dueDate = payload.dueDate
            touched = True

        if "snoozedUntil" in fields:
            task.snoozedUntil = payload.snoozedUntil
            touched = True

        if "pinned" in fields:
            task.pinned = payload.pinned
            touched = True

        if "tags" in fields:
            task.tags = _normalize_tags(payload.tags or [])
            touched = True
            reindex_needed = True

        # Digest fields are system-managed and should not reorder tasks by activity.
        if "digest" in fields:
            task.digest = payload.digest
        if "digestUpdatedAt" in fields:
            task.digestUpdatedAt = payload.digestUpdatedAt

        if touched:
            task.updatedAt = stamp

        session.add(task)
        session.commit()
        session.refresh(task)
        if space_changed:
            task_space_id = _space_id_for_task(task)
            scoped_logs = session.exec(select(LogEntry).where(LogEntry.taskId == task.id)).all()
            for scoped_log in scoped_logs:
                scoped_log.spaceId = task_space_id
                scoped_log.updatedAt = stamp
                session.add(scoped_log)
            session.commit()
            session.refresh(task)
        event_hub.publish({"type": "task.upserted", "data": task.model_dump(), "eventTs": task.updatedAt})

        if reindex_needed:
            task_text = " ".join(
                [
                    str(task.title or "").strip(),
                    str(task.status or "").strip(),
                    " ".join(
                        [
                            str(t).strip()
                            for t in (task.tags or [])
                            if str(t).strip() and not str(t).strip().lower().startswith("system:")
                        ]
                    ),
                ]
            ).strip()
            enqueue_reindex_request(
                {
                    "op": "upsert",
                    "kind": "task",
                    "id": task.id,
                    "topicId": task.topicId,
                    "text": task_text,
                }
            )

        return task


@app.post("/api/tasks/reorder", dependencies=[Depends(require_token)], tags=["tasks"])
def reorder_tasks(payload: TaskReorderRequest):
    """Persist a manual task order within a topic by assigning sortIndex sequentially."""
    ordered_ids = [value.strip() for value in payload.orderedIds if value.strip()]
    with get_session() as session:
        query = select(Task)
        if payload.topicId is None:
            query = query.where(Task.topicId.is_(None))
        else:
            query = query.where(Task.topicId == payload.topicId)
        scope_tasks = session.exec(query).all()
        scope_ids = {task.id for task in scope_tasks}
        provided = set(ordered_ids)
        missing = sorted(scope_ids - provided)
        extra = sorted(provided - scope_ids)
        if missing or extra:
            detail = {
                "missing": missing[:50],
                "extra": extra[:50],
                "message": "orderedIds must contain every task id for the provided topic scope.",
            }
            raise HTTPException(status_code=400, detail=detail)

        tasks_by_id = {task.id: task for task in scope_tasks}
        # Reordering is not a meaningful content update; do not touch updatedAt.
        event_ts = now_iso()
        for idx, task_id in enumerate(ordered_ids):
            task = tasks_by_id.get(task_id)
            if not task:
                continue
            task.sortIndex = idx
            session.add(task)
        session.commit()
        for task_id in ordered_ids:
            task = tasks_by_id.get(task_id)
            if not task:
                continue
            event_hub.publish({"type": "task.upserted", "data": task.model_dump(), "eventTs": event_ts})
        return {"ok": True, "count": len(ordered_ids)}


@app.post("/api/tasks", dependencies=[Depends(require_token)], response_model=TaskOut, tags=["tasks"])
def upsert_task(
    payload: TaskUpsert = Body(
        ...,
        examples={
            "default": {
                "summary": "Upsert task",
                "value": {
                    "id": "task-1",
                    "topicId": "topic-1",
                    "title": "Ship onboarding wizard",
                    "status": "doing",
                    "pinned": True,
                    "priority": "high",
                    "dueDate": "2026-02-05T00:00:00.000Z",
                },
            }
        },
    )
):
    """Create or update a task."""
    with get_session() as session:
        _ensure_default_space(session)
        task = session.get(Task, payload.id) if payload.id else None
        timestamp = now_iso()
        fields = payload.model_fields_set
        if task:
            task.title = payload.title or task.title
            if "color" in fields:
                if payload.color is None:
                    task.color = None
                else:
                    normalized_color = _normalize_hex_color(payload.color)
                    if normalized_color:
                        task.color = normalized_color
            if "topicId" in fields:
                task.topicId = payload.topicId
                if payload.topicId:
                    parent = session.get(Topic, payload.topicId)
                    if not parent:
                        raise HTTPException(status_code=400, detail="topicId not found")
                    task.spaceId = _space_id_for_topic(parent)
            if "spaceId" in fields and ("topicId" not in fields or not payload.topicId):
                normalized_space_id = _normalize_space_id(payload.spaceId)
                if not normalized_space_id:
                    raise HTTPException(status_code=400, detail="spaceId is required")
                target_space = session.get(Space, normalized_space_id)
                if not target_space:
                    raise HTTPException(status_code=400, detail="spaceId not found")
                task.spaceId = normalized_space_id
            if "status" in fields and payload.status is not None:
                task.status = payload.status
            if "priority" in fields:
                task.priority = payload.priority
            if "dueDate" in fields:
                task.dueDate = payload.dueDate
            if "pinned" in fields:
                task.pinned = payload.pinned
            if "tags" in fields:
                task.tags = _normalize_tags(payload.tags or [])
            if "snoozedUntil" in fields:
                task.snoozedUntil = payload.snoozedUntil
            task.updatedAt = timestamp
        else:
            parent_space_id_for_create = None
            if payload.topicId:
                parent_for_create = session.get(Topic, payload.topicId)
                if not parent_for_create:
                    raise HTTPException(status_code=400, detail="topicId not found")
                parent_space_id_for_create = _space_id_for_topic(parent_for_create)
            requested_space_id = parent_space_id_for_create or _normalize_space_id(payload.spaceId) or DEFAULT_SPACE_ID
            duplicate = _find_similar_task(
                session,
                payload.topicId,
                payload.title,
                space_id=requested_space_id,
            )
            if duplicate:
                if "color" in fields:
                    if payload.color is None:
                        duplicate.color = None
                    else:
                        normalized_color = _normalize_hex_color(payload.color)
                        if normalized_color:
                            duplicate.color = normalized_color
                elif not _normalize_hex_color(getattr(duplicate, "color", None)):
                    used_colors = {
                        _normalize_hex_color(getattr(item, "color", None))
                        for item in session.exec(select(Task)).all()
                        if _normalize_hex_color(getattr(item, "color", None))
                    }
                    duplicate.color = _auto_pick_color(f"task:{duplicate.id}:{duplicate.title}", used_colors, 21.0)
                if "status" in fields and payload.status is not None:
                    duplicate.status = payload.status
                if "topicId" in fields and payload.topicId:
                    parent = session.get(Topic, payload.topicId)
                    if not parent:
                        raise HTTPException(status_code=400, detail="topicId not found")
                    duplicate.spaceId = _space_id_for_topic(parent)
                elif "spaceId" in fields and ("topicId" not in fields or not payload.topicId):
                    normalized_space_id = _normalize_space_id(payload.spaceId)
                    if not normalized_space_id:
                        raise HTTPException(status_code=400, detail="spaceId is required")
                    target_space = session.get(Space, normalized_space_id)
                    if not target_space:
                        raise HTTPException(status_code=400, detail="spaceId not found")
                    duplicate.spaceId = normalized_space_id
                if "priority" in fields:
                    duplicate.priority = payload.priority
                if "dueDate" in fields:
                    duplicate.dueDate = payload.dueDate
                if "pinned" in fields:
                    duplicate.pinned = payload.pinned
                if "tags" in fields:
                    duplicate.tags = _normalize_tags(payload.tags or [])
                if "snoozedUntil" in fields:
                    duplicate.snoozedUntil = payload.snoozedUntil
                duplicate.updatedAt = timestamp
                session.add(duplicate)
                session.commit()
                session.refresh(duplicate)
                if "topicId" in fields or "spaceId" in fields:
                    duplicate_space_id = _space_id_for_task(duplicate)
                    scoped_logs = session.exec(select(LogEntry).where(LogEntry.taskId == duplicate.id)).all()
                    for scoped_log in scoped_logs:
                        scoped_log.spaceId = duplicate_space_id
                        scoped_log.updatedAt = timestamp
                        session.add(scoped_log)
                    session.commit()
                    session.refresh(duplicate)
                event_hub.publish({"type": "task.upserted", "data": duplicate.model_dump(), "eventTs": duplicate.updatedAt})
                enqueue_reindex_request(
                    {
                        "op": "upsert",
                        "kind": "task",
                        "id": duplicate.id,
                        "topicId": duplicate.topicId,
                        "text": " ".join(
                            [
                                str(duplicate.title or "").strip(),
                                str(duplicate.status or "").strip(),
                                " ".join(
                                    [
                                        str(t).strip()
                                        for t in (duplicate.tags or [])
                                        if str(t).strip() and not str(t).strip().lower().startswith("system:")
                                    ]
                                ),
                            ]
                        ).strip(),
                    }
                )
                return duplicate
            used_colors = {
                _normalize_hex_color(getattr(item, "color", None))
                for item in session.exec(select(Task)).all()
                if _normalize_hex_color(getattr(item, "color", None))
            }
            resolved_color = _normalize_hex_color(payload.color)
            if not resolved_color:
                resolved_color = _auto_pick_color(f"task:{payload.id or ''}:{payload.title}", used_colors, 21.0)
            sort_index = _next_sort_index_for_new_task(session, payload.topicId, bool(payload.pinned or False))
            resolved_space_id = requested_space_id
            target_space = session.get(Space, resolved_space_id)
            if not target_space:
                raise HTTPException(status_code=400, detail="spaceId not found")
            task = Task(
                id=payload.id or create_id("task"),
                spaceId=resolved_space_id,
                topicId=payload.topicId,
                title=payload.title,
                sortIndex=sort_index,
                color=resolved_color,
                status=payload.status or "todo",
                pinned=payload.pinned or False,
                priority=payload.priority or "medium",
                dueDate=payload.dueDate,
                snoozedUntil=payload.snoozedUntil,
                tags=_normalize_tags(payload.tags or []),
                createdAt=timestamp,
                updatedAt=timestamp,
            )
        session.add(task)
        session.commit()
        session.refresh(task)
        if "topicId" in fields or "spaceId" in fields:
            task_space_id = _space_id_for_task(task)
            scoped_logs = session.exec(select(LogEntry).where(LogEntry.taskId == task.id)).all()
            for scoped_log in scoped_logs:
                scoped_log.spaceId = task_space_id
                scoped_log.updatedAt = timestamp
                session.add(scoped_log)
            session.commit()
            session.refresh(task)
        event_hub.publish({"type": "task.upserted", "data": task.model_dump(), "eventTs": task.updatedAt})
        enqueue_reindex_request(
            {
                "op": "upsert",
                "kind": "task",
                "id": task.id,
                "topicId": task.topicId,
                "text": " ".join(
                    [
                        str(task.title or "").strip(),
                        str(task.status or "").strip(),
                        " ".join(
                            [str(t).strip() for t in (task.tags or []) if str(t).strip() and not str(t).strip().lower().startswith("system:")]
                        ),
                    ]
                ).strip(),
            }
        )
        return task


@app.delete("/api/tasks/{task_id}", dependencies=[Depends(require_token)], tags=["tasks"])
def delete_task(task_id: str):
    """Delete a task and detach dependent logs so conversation history remains visible."""
    with get_session() as session:
        task = session.get(Task, task_id)
        if not task:
            return {"ok": True, "deleted": False, "detachedLogs": 0}

        detached_at = now_iso()
        logs = session.exec(select(LogEntry).where(LogEntry.taskId == task_id)).all()

        for entry in logs:
            entry.taskId = None
            entry.updatedAt = detached_at
            session.add(entry)

        session.delete(task)
        session.commit()

        enqueue_reindex_request({"op": "delete", "kind": "task", "id": task_id})

        for entry in logs:
            event_hub.publish({"type": "log.patched", "data": entry.model_dump(exclude={"raw"}), "eventTs": entry.updatedAt})
        event_hub.publish({"type": "task.deleted", "data": {"id": task_id}, "eventTs": detached_at})

        return {
            "ok": True,
            "deleted": True,
            "id": task_id,
            "detachedLogs": len(logs),
        }


@app.get("/api/classifier/pending", response_model=List[LogOutLite], tags=["classifier"])
def list_pending_conversations_for_classifier(
    limit: int = Query(default=500, ge=1, le=1000, description="Max results.", example=500),
    offset: int = Query(default=0, ge=0, description="Offset for pagination.", example=0),
    spaceId: str | None = Query(default=None, description="Resolve visibility from this source space id."),
    allowedSpaceIds: str | None = Query(default=None, description="Explicit allowed space ids (comma-separated)."),
):
    """List pending conversation logs without heavy fields (raw) for classifier polling."""
    with get_session() as session:
        allowed_space_ids = _resolve_allowed_space_ids(
            session,
            source_space_id=spaceId,
            allowed_space_ids_raw=allowedSpaceIds,
        )
        query = (
            select(LogEntry)
            .options(defer(LogEntry.raw))
            .where(LogEntry.type == "conversation")
            .where(LogEntry.classificationStatus == "pending")
            .order_by(
                LogEntry.createdAt.desc(),
                # SQLite needs a deterministic tie-break when timestamps collide.
                (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
            )
        )
        rows = session.exec(query).all()
        if allowed_space_ids is not None:
            topic_by_id, task_by_id = _load_related_maps_for_logs(session, rows)
            rows = [row for row in rows if _log_matches_allowed_spaces(row, allowed_space_ids, topic_by_id, task_by_id)]
        if offset > 0:
            rows = rows[offset:]
        if limit >= 0:
            rows = rows[:limit]
        return rows


@app.get(
    "/api/classifier/session-routing",
    response_model=SessionRoutingMemoryOut,
    dependencies=[Depends(require_token)],
    tags=["classifier"],
)
def get_session_routing_memory(
    sessionKey: str = Query(..., min_length=1, max_length=512, description="Session key (source.sessionKey)."),
):
    """Fetch recent routing decisions for a session (best-effort)."""
    with get_session() as session:
        row = session.get(SessionRoutingMemory, sessionKey)
        if not row:
            return {"sessionKey": sessionKey, "items": []}
        return row


@app.post(
    "/api/classifier/session-routing",
    response_model=SessionRoutingMemoryOut,
    dependencies=[Depends(require_token)],
    tags=["classifier"],
)
def append_session_routing_memory(payload: SessionRoutingAppend):
    """Append one routing decision to a session memory row.

    Used by the classifier to resolve ambiguous follow-ups without expanding context windows.
    """

    max_items = int(os.getenv("CLAWBOARD_SESSION_ROUTING_MAX_ITEMS", "12"))
    max_items = max(2, min(64, max_items))
    now = now_iso()
    ts = normalize_iso(payload.ts) or now

    def _clip_text(value: str | None, limit: int) -> str | None:
        if value is None:
            return None
        text = str(value).replace("\r\n", "\n").replace("\r", "\n").strip()
        if not text:
            return None
        if len(text) <= limit:
            return text
        return text[: limit - 1].rstrip() + "…"

    item = {
        "ts": ts,
        "topicId": payload.topicId,
        "topicName": _clip_text(payload.topicName, 200),
        "taskId": payload.taskId,
        "taskTitle": _clip_text(payload.taskTitle, 200),
        "anchor": _clip_text(payload.anchor, 800),
    }

    with get_session() as session:
        row = session.get(SessionRoutingMemory, payload.sessionKey)
        if row:
            items = list(row.items or [])
            items.append(item)
            # Keep newest last; bound growth.
            row.items = items[-max_items:]
            row.updatedAt = now
            session.add(row)
        else:
            row = SessionRoutingMemory(
                sessionKey=payload.sessionKey,
                items=[item],
                createdAt=now,
                updatedAt=now,
            )
            session.add(row)
        session.commit()
        session.refresh(row)
        return row


@app.post(
    "/api/classifier/replay",
    response_model=ClassifierReplayResponse,
    dependencies=[Depends(require_token)],
    tags=["classifier"],
)
def replay_classifier_bundle(payload: ClassifierReplayRequest):
    """Mark a request/response bundle as pending so the classifier re-runs routing/summaries.

    This is a user-triggered escape hatch when a Topic Chat thread should be re-checked for
    task allocation (or other classifier updates) starting from an anchor user message.
    """

    anchor_log_id = (payload.anchorLogId or "").strip()
    if not anchor_log_id:
        raise HTTPException(status_code=400, detail="anchorLogId is required")

    # Mirror classifier.py's bundle segmentation enough for predictable UX.
    AFFIRMATIONS = {
        "yes",
        "y",
        "yep",
        "yeah",
        "ok",
        "okay",
        "sounds good",
        "do it",
        "please do",
        "go ahead",
        "ship it",
        "works for me",
    }

    def _strip_slash_command(text: str) -> str:
        cleaned = (text or "").strip()
        if not cleaned.startswith("/"):
            return cleaned
        parts = cleaned.split(None, 1)
        command = parts[0].lower()
        if command in SLASH_COMMANDS:
            return parts[1].strip() if len(parts) > 1 else ""
        return ""

    def _is_affirmation(text: str) -> bool:
        cleaned = _sanitize_log_text(text)
        cleaned = re.sub(r"[^a-zA-Z0-9\\s]+", " ", cleaned)
        cleaned = re.sub(r"\\s+", " ", cleaned).strip().lower()
        if not cleaned:
            return False
        if len(cleaned) > 24:
            return False
        if cleaned in AFFIRMATIONS:
            return True
        if cleaned.startswith("yes "):
            return cleaned[4:].strip() in AFFIRMATIONS
        if cleaned.startswith("ok "):
            return cleaned[3:].strip() in AFFIRMATIONS
        if cleaned.startswith("okay "):
            return cleaned[5:].strip() in AFFIRMATIONS
        return False

    def _conversation_agent(entry: LogEntry) -> str:
        return str(getattr(entry, "agentId", "") or "").strip().lower()

    def _conversation_text(entry: LogEntry) -> str:
        return _sanitize_log_text(str(getattr(entry, "content", None) or getattr(entry, "summary", None) or getattr(entry, "raw", None) or ""))

    def _bundle_range(conversations: list[LogEntry], anchor_idx: int) -> tuple[int, int]:
        """Return (start_idx, end_idx) for one coherent request/response bundle."""
        if not conversations:
            return 0, 0
        anchor_idx = max(0, min(anchor_idx, len(conversations) - 1))

        start_idx = anchor_idx
        anchor = conversations[anchor_idx]
        if _conversation_agent(anchor) != "user":
            for j in range(anchor_idx, -1, -1):
                if _conversation_agent(conversations[j]) == "user":
                    start_idx = j
                    break
        else:
            anchor_text = _strip_slash_command(_conversation_text(anchor))
            if anchor_text and _is_affirmation(anchor_text):
                for j in range(anchor_idx - 1, -1, -1):
                    if _conversation_agent(conversations[j]) != "user":
                        continue
                    prev_text = _strip_slash_command(_conversation_text(conversations[j]))
                    if prev_text and not _is_affirmation(prev_text):
                        start_idx = j
                        break

        seen_assistant = False
        end_idx = start_idx
        for i in range(start_idx, len(conversations)):
            entry = conversations[i]
            end_idx = i + 1
            agent = _conversation_agent(entry)
            if agent != "user":
                seen_assistant = True
                continue
            if i == start_idx:
                continue
            user_text = _strip_slash_command(_conversation_text(entry))
            if seen_assistant and user_text and not _is_affirmation(user_text):
                end_idx = i
                break

        return start_idx, max(start_idx + 1, end_idx)

    with get_session() as session:
        anchor = session.get(LogEntry, anchor_log_id)
        if not anchor:
            raise HTTPException(status_code=404, detail="Anchor log not found")
        if str(getattr(anchor, "type", "") or "") != "conversation":
            raise HTTPException(status_code=400, detail="Anchor log must be a conversation")
        if (str(getattr(anchor, "agentId", "") or "").strip().lower() or "") != "user":
            raise HTTPException(status_code=400, detail="Anchor log must be a user message")

        source = anchor.source if isinstance(anchor.source, dict) else None
        session_key = str(source.get("sessionKey") or "").strip() if source else ""
        if not session_key:
            raise HTTPException(status_code=400, detail="Anchor log is missing source.sessionKey")

        base_session_key = (session_key.split("|", 1)[0] or "").strip()
        if not base_session_key:
            raise HTTPException(status_code=400, detail="Anchor log sessionKey is invalid")

        topic_id, task_id = _parse_board_session_key(base_session_key)
        if not topic_id or task_id:
            raise HTTPException(status_code=400, detail="Replay is only supported for Topic Chat sessions")

        query = select(LogEntry)
        if DATABASE_URL.startswith("sqlite"):
            # Match the base sessionKey plus any OpenClaw thread suffixes (`|thread:...`) so
            # a replay includes assistant/tool logs even when providers decorate sessionKey.
            query = query.where(
                text(
                    "(json_extract(source, '$.sessionKey') = :base_key OR json_extract(source, '$.sessionKey') LIKE :like_key)"
                )
            ).params(base_key=base_session_key, like_key=f"{base_session_key}|%")
        else:
            expr = LogEntry.source["sessionKey"].as_string()
            query = query.where(or_(expr == base_session_key, expr.like(f"{base_session_key}|%")))
        query = query.order_by(
            LogEntry.createdAt.asc(),
            (text("rowid ASC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.asc()),
        )
        all_logs = session.exec(query).all()
        if not all_logs:
            return {
                "ok": True,
                "anchorLogId": anchor_log_id,
                "sessionKey": base_session_key,
                "topicId": topic_id,
                "logCount": 0,
                "logIds": [],
            }

        conversations = [row for row in all_logs if (getattr(row, "type", None) == "conversation")]
        anchor_idx = next((idx for idx, row in enumerate(conversations) if row.id == anchor_log_id), -1)
        if anchor_idx < 0:
            raise HTTPException(status_code=400, detail="Anchor log is not part of the session conversation thread")

        bundle_start_idx, bundle_end_idx = _bundle_range(conversations, anchor_idx)
        if payload.mode == "from_here":
            bundle_end_idx = len(conversations)

        start_id = conversations[bundle_start_idx].id if bundle_start_idx < len(conversations) else anchor_log_id
        boundary_id = conversations[bundle_end_idx].id if bundle_end_idx < len(conversations) else ""

        pos_by_id: dict[str, int] = {str(row.id): idx for idx, row in enumerate(all_logs) if getattr(row, "id", None)}
        scope_start_pos = pos_by_id.get(str(start_id), 0)
        scope_end_pos = pos_by_id.get(str(boundary_id)) if boundary_id else len(all_logs)
        if scope_end_pos is None:
            scope_end_pos = len(all_logs)
        if scope_end_pos < scope_start_pos:
            scope_end_pos = len(all_logs)

        scope_logs = all_logs[scope_start_pos:scope_end_pos]
        stamp = now_iso()
        updated_ids: list[str] = []
        for entry in scope_logs:
            entry.taskId = None
            entry.classificationStatus = "pending"
            entry.classificationAttempts = 0
            entry.classificationError = None
            entry.updatedAt = stamp
            session.add(entry)
            updated_ids.append(entry.id)

        try:
            session.commit()
        except OperationalError as exc:
            if not DATABASE_URL.startswith("sqlite") or "database is locked" not in str(exc).lower():
                raise
            session.rollback()
            last_exc: OperationalError | None = exc
            for attempt in range(6):
                try:
                    for entry in scope_logs:
                        entry.taskId = None
                        entry.classificationStatus = "pending"
                        entry.classificationAttempts = 0
                        entry.classificationError = None
                        entry.updatedAt = stamp
                        session.add(entry)
                    time.sleep(min(0.75, 0.05 * (2**attempt)))
                    session.commit()
                    last_exc = None
                    break
                except OperationalError as retry_exc:
                    if "database is locked" not in str(retry_exc).lower():
                        raise
                    session.rollback()
                    last_exc = retry_exc
            if last_exc is not None:
                raise last_exc

        for entry in scope_logs:
            event_hub.publish({"type": "log.patched", "data": entry.model_dump(exclude={"raw"}), "eventTs": entry.updatedAt})
            _enqueue_log_reindex(entry)

        return {
            "ok": True,
            "anchorLogId": anchor_log_id,
            "sessionKey": base_session_key,
            "topicId": topic_id,
            "logCount": len(updated_ids),
            "logIds": updated_ids,
        }


@app.get("/api/log", response_model=List[LogOut], tags=["logs"])
def list_logs(
    topicId: str | None = Query(default=None, description="Filter logs by topic ID.", example="topic-1"),
    taskId: str | None = Query(default=None, description="Filter logs by task ID.", example="task-1"),
    relatedLogId: str | None = Query(
        default=None,
        description="Filter logs by relatedLogId (comma-separated allowed).",
        example="log-12",
    ),
    sessionKey: str | None = Query(
        default=None,
        description="Filter logs by source.sessionKey.",
        example="channel:discord",
    ),
    type: str | None = Query(
        default=None,
        description="Filter logs by type (conversation|action|note|system|import).",
        example="conversation",
    ),
    classificationStatus: str | None = Query(
        default=None,
        description="Filter logs by classification status (pending|classified|failed).",
        example="pending",
    ),
    spaceId: str | None = Query(default=None, description="Resolve visibility from this source space id."),
    allowedSpaceIds: str | None = Query(default=None, description="Explicit allowed space ids (comma-separated)."),
    includeRaw: bool = Query(
        default=False,
        description="Include raw payload field (can be large).",
        example=False,
    ),
    limit: int = Query(default=200, ge=1, le=1000, description="Max results.", example=200),
    offset: int = Query(default=0, ge=0, description="Offset for pagination.", example=0),
):
    """List timeline entries (newest first)."""
    with get_session() as session:
        allowed_space_ids = _resolve_allowed_space_ids(
            session,
            source_space_id=spaceId,
            allowed_space_ids_raw=allowedSpaceIds,
        )
        query = select(LogEntry)
        if not includeRaw:
            query = query.options(defer(LogEntry.raw))
        if topicId:
            query = query.where(LogEntry.topicId == topicId)
        if taskId:
            query = query.where(LogEntry.taskId == taskId)
        if relatedLogId:
            related_ids = {rid.strip() for rid in relatedLogId.split(",") if rid.strip()}
            if related_ids:
                query = query.where(LogEntry.relatedLogId.in_(related_ids))
        if sessionKey:
            if DATABASE_URL.startswith("sqlite"):
                # SQLite: inline the JSON path literal so our expression index can be used.
                # SQLAlchemy's JSON accessor parameterizes the path (json_extract(source, ?)),
                # which prevents SQLite from using the index and can make session-thread reads slow.
                query = query.where(text("json_extract(source, '$.sessionKey') = :session_key")).params(
                    session_key=sessionKey
                )
            else:
                # JSON query that works on Postgres dialects.
                query = query.where(LogEntry.source["sessionKey"].as_string() == sessionKey)
        if type:
            query = query.where(LogEntry.type == type)
        if classificationStatus:
            query = query.where(LogEntry.classificationStatus == classificationStatus)
        ordered_query = query.order_by(
            LogEntry.createdAt.desc(),
            (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
        )

        if allowed_space_ids is None:
            rows = session.exec(ordered_query.offset(offset).limit(limit)).all()
            return [LogOut.model_validate(row) for row in rows]

        rows: list[LogEntry] = []
        skip = max(0, int(offset))
        scan_offset = 0
        page_size = max(120, min(1000, max(60, int(limit) * 3)))
        while len(rows) < limit:
            chunk = session.exec(ordered_query.offset(scan_offset).limit(page_size)).all()
            if not chunk:
                break
            topic_by_id, task_by_id = _load_related_maps_for_logs(session, chunk)
            for row in chunk:
                if not _log_matches_allowed_spaces(row, allowed_space_ids, topic_by_id, task_by_id):
                    continue
                if skip > 0:
                    skip -= 1
                    continue
                rows.append(row)
                if len(rows) >= limit:
                    break
            scan_offset += len(chunk)
            if len(chunk) < page_size:
                break
        # Detach from session to avoid DetachedInstanceError during serialization.
        # This is especially important when columns are deferred (like 'raw').
        return [LogOut.model_validate(row) for row in rows]


@app.get("/api/log/{log_id}", response_model=LogOut, tags=["logs"])
def get_log(
    log_id: str,
    includeRaw: bool = Query(
        default=False,
        description="Include raw payload field (can be large).",
        example=False,
    ),
):
    """Fetch one log entry by id (optionally with raw)."""
    with get_session() as session:
        query = select(LogEntry).where(LogEntry.id == log_id)
        if not includeRaw:
            query = query.options(defer(LogEntry.raw))
        entry = session.exec(query).first()
        if not entry:
            raise HTTPException(status_code=404, detail="Log not found")
        if not entry:
            raise HTTPException(status_code=404, detail="Log not found")
        return LogOut.model_validate(entry)


@app.post("/api/log", dependencies=[Depends(require_token)], response_model=LogOut, tags=["logs"])
def append_log(
    payload: LogAppend = Body(
        ...,
        examples={
            "default": {
                "summary": "Append log entry",
                "value": {
                    "topicId": "topic-1",
                    "taskId": "task-1",
                    "type": "conversation",
                    "content": "Defined onboarding wizard steps and token flow.",
                    "summary": "Defined onboarding wizard steps.",
                    "raw": "User: ...\\nAssistant: ...",
                    "createdAt": "2026-02-02T10:05:00.000Z",
                    "agentId": "main",
                    "agentLabel": "User",
                    "source": {"channel": "discord", "sessionKey": "main", "messageId": "msg-001"},
                },
            }
        },
    ),
    x_idempotency_key: str | None = Header(default=None, alias="X-Idempotency-Key"),
):
    """Append a timeline entry."""
    with get_session() as session:
        idem = _idempotency_key(payload, x_idempotency_key)
        return append_log_entry(session, payload, idem)


@app.post("/api/ingest", dependencies=[Depends(require_token)], tags=["logs"])
def enqueue_log(
    payload: LogAppend = Body(...),
):
    """Queue a log entry for async ingestion (high-scale mode)."""
    if os.getenv("CLAWBOARD_INGEST_MODE", "").lower() != "queue":
        raise HTTPException(status_code=400, detail="Queue ingestion not enabled")
    with get_session() as session:
        job = IngestQueue(
            payload=payload.model_dump(),
            status="pending",
            attempts=0,
            lastError=None,
            createdAt=now_iso(),
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        return {"queued": True, "id": job.id}


@app.patch("/api/log/{log_id}", dependencies=[Depends(require_token)], response_model=LogOut, tags=["logs"])
def patch_log(log_id: str, payload: LogPatch = Body(...)):
    """Patch an existing log entry (used by async classifier; idempotent)."""
    with get_session() as session:
        entry = session.get(LogEntry, log_id)
        if not entry:
            raise HTTPException(status_code=404, detail="Log not found")

        fields = payload.model_fields_set
        if "spaceId" in fields:
            normalized_space_id = _normalize_space_id(payload.spaceId)
            if not normalized_space_id:
                raise HTTPException(status_code=400, detail="spaceId is required")
            _ensure_default_space(session)
            space = session.get(Space, normalized_space_id)
            if not space:
                raise HTTPException(status_code=400, detail="spaceId not found")
            entry.spaceId = normalized_space_id

        if "topicId" in fields:
            entry.topicId = payload.topicId
        if "taskId" in fields:
            if payload.taskId:
                task = session.get(Task, payload.taskId)
                if not task:
                    raise HTTPException(status_code=400, detail="Task not found")
                if "topicId" in fields:
                    if task.topicId != entry.topicId:
                        raise HTTPException(status_code=400, detail="Task does not belong to selected topic")
                else:
                    # Align topic to the task if topic wasn't explicitly patched.
                    entry.topicId = task.topicId
                entry.taskId = task.id
                entry.spaceId = _space_id_for_task(task)
            else:
                entry.taskId = None
        if "relatedLogId" in fields:
            entry.relatedLogId = payload.relatedLogId
        if "content" in fields:
            entry.content = payload.content or ""
        if "summary" in fields:
            entry.summary = payload.summary
        if "raw" in fields:
            entry.raw = payload.raw
        if "classificationStatus" in fields:
            entry.classificationStatus = payload.classificationStatus
        if "classificationAttempts" in fields:
            entry.classificationAttempts = payload.classificationAttempts
        if "classificationError" in fields:
            entry.classificationError = payload.classificationError

        # If only topicId changed (taskId not explicitly provided), drop taskId if it no longer matches.
        if "topicId" in fields and "taskId" not in fields and entry.taskId:
            task = session.get(Task, entry.taskId)
            if not task or task.topicId != entry.topicId:
                entry.taskId = None

        # Keep log space in sync with routed entity ownership.
        if entry.taskId:
            task = session.get(Task, entry.taskId)
            if task:
                entry.spaceId = _space_id_for_task(task)
        elif entry.topicId:
            topic = session.get(Topic, entry.topicId)
            if topic:
                entry.spaceId = _space_id_for_topic(topic)
        elif not _normalize_space_id(getattr(entry, "spaceId", None)):
            entry.spaceId = DEFAULT_SPACE_ID

        stamp = now_iso()

        # Best-effort: if a conversation is routed into a snoozed/archived topic or task,
        # revive it so it surfaces again in the Unified view.
        revived_topic: Topic | None = None
        revived_task: Task | None = None
        if str(getattr(entry, "type", "") or "").strip().lower() == "conversation":
            try:
                if entry.taskId:
                    task = session.get(Task, entry.taskId)
                    if task and task.snoozedUntil:
                        task.snoozedUntil = None
                        task.updatedAt = stamp
                        session.add(task)
                        revived_task = task

                if entry.topicId:
                    topic = session.get(Topic, entry.topicId)
                    if topic and (
                        topic.snoozedUntil
                        or str(topic.status or "active").strip().lower() in {"snoozed", "paused", "archived"}
                    ):
                        topic.snoozedUntil = None
                        topic.status = "active"
                        topic.updatedAt = stamp
                        session.add(topic)
                        revived_topic = topic
            except Exception:
                revived_topic = None
                revived_task = None

        entry.updatedAt = stamp

        session.add(entry)
        try:
            session.commit()
        except OperationalError as exc:
            if not DATABASE_URL.startswith("sqlite") or "database is locked" not in str(exc).lower():
                raise
            session.rollback()
            last_exc: OperationalError | None = exc
            for attempt in range(6):
                try:
                    session.commit()
                    last_exc = None
                    break
                except OperationalError as retry_exc:
                    if "database is locked" not in str(retry_exc).lower():
                        raise
                    session.rollback()
                    last_exc = retry_exc
                    time.sleep(min(0.75, 0.05 * (2**attempt)))
            if last_exc is not None:
                raise last_exc
        session.refresh(entry)
        event_hub.publish({"type": "log.patched", "data": entry.model_dump(exclude={"raw"}), "eventTs": entry.updatedAt})
        _enqueue_log_reindex(entry)
        if revived_topic:
            event_hub.publish({"type": "topic.upserted", "data": revived_topic.model_dump(), "eventTs": revived_topic.updatedAt})
        if revived_task:
            event_hub.publish({"type": "task.upserted", "data": revived_task.model_dump(), "eventTs": revived_task.updatedAt})
        return entry


@app.delete("/api/log/{log_id}", dependencies=[Depends(require_token)], tags=["logs"])
def delete_log(log_id: str):
    """Delete a log entry and its attached note rows."""
    with get_session() as session:
        to_delete = session.exec(
            select(LogEntry).where((LogEntry.id == log_id) | (LogEntry.relatedLogId == log_id))
        ).all()
        if not to_delete:
            return {"ok": True, "deleted": False, "deletedIds": []}
        deleted_ids = [row.id for row in to_delete]
        for row in to_delete:
            session.delete(row)
        session.commit()
        stamp = now_iso()
        for deleted_id in deleted_ids:
            enqueue_reindex_request({"op": "delete", "kind": "log", "id": deleted_id})
            # Best-effort tombstone insert (ignore if it already exists).
            try:
                session.add(DeletedLog(id=deleted_id, deletedAt=stamp))
                session.commit()
            except Exception:
                session.rollback()

        event_ts = stamp
        for deleted_id in deleted_ids:
            event_hub.publish({"type": "log.deleted", "data": {"id": deleted_id, "rootId": log_id}, "eventTs": event_ts})
        return {"ok": True, "deleted": True, "deletedIds": deleted_ids}


@app.post(
    "/api/topics/{topic_id}/topic_chat/purge",
    dependencies=[Depends(require_token)],
    tags=["topics"],
)
def purge_topic_chat(topic_id: str):
    """Permanently delete Topic Chat logs (topic-scoped logs with no taskId).

    This is intentionally irreversible (no soft-delete). The UI should provide a double
    confirmation before calling this endpoint.
    """
    topic_id = (topic_id or "").strip()
    if not topic_id:
        raise HTTPException(status_code=400, detail="topic_id is required")

    with get_session() as session:
        topic = session.get(Topic, topic_id)
        if not topic:
            raise HTTPException(status_code=404, detail="Topic not found")

        roots = session.exec(select(LogEntry).where(LogEntry.topicId == topic_id, LogEntry.taskId.is_(None))).all()
        if not roots:
            return {"ok": True, "topicId": topic_id, "deleted": False, "deletedCount": 0, "deletedIds": []}

        root_ids = [row.id for row in roots]
        notes = session.exec(select(LogEntry).where(LogEntry.relatedLogId.in_(root_ids))).all() if root_ids else []
        to_delete = list(roots) + [row for row in notes if row.id not in set(root_ids)]

        deleted_ids = [row.id for row in to_delete]

        # Best-effort attachment cleanup (DB rows + on-disk files).
        attachment_ids: set[str] = set()
        for row in roots:
            atts = row.attachments if isinstance(row.attachments, list) else []
            for att in atts:
                if not isinstance(att, dict):
                    continue
                att_id = str(att.get("id") or "").strip()
                if att_id:
                    attachment_ids.add(att_id)

        if attachment_ids:
            try:
                attachment_rows = session.exec(select(Attachment).where(Attachment.id.in_(list(attachment_ids)))).all()
            except Exception:
                attachment_rows = []
            root = _attachments_root()
            for att_row in attachment_rows:
                storage_path = str(att_row.storagePath or att_row.id)
                path = root / storage_path
                try:
                    if path.exists():
                        path.unlink()
                except Exception:
                    pass
                try:
                    session.delete(att_row)
                except Exception:
                    pass

        for row in to_delete:
            session.delete(row)
        session.commit()

        stamp = now_iso()
        for deleted_id in deleted_ids:
            enqueue_reindex_request({"op": "delete", "kind": "log", "id": deleted_id})
            try:
                session.add(DeletedLog(id=deleted_id, deletedAt=stamp))
                session.commit()
            except Exception:
                session.rollback()

        event_ts = stamp
        for deleted_id in deleted_ids:
            event_hub.publish({"type": "log.deleted", "data": {"id": deleted_id, "rootId": deleted_id}, "eventTs": event_ts})

        return {"ok": True, "topicId": topic_id, "deleted": True, "deletedCount": len(deleted_ids), "deletedIds": deleted_ids}


@app.post(
    "/api/log/{log_id}/purge_forward",
    dependencies=[Depends(require_token)],
    tags=["logs"],
)
def purge_log_forward(log_id: str):
    """Permanently delete the given log entry and everything after it in the same board chat session.

    Intended for Topic Chat cleanup when a thread goes in a bad direction.
    """
    anchor_id = (log_id or "").strip()
    if not anchor_id:
        raise HTTPException(status_code=400, detail="log_id is required")

    with get_session() as session:
        anchor = session.get(LogEntry, anchor_id)
        if not anchor:
            raise HTTPException(status_code=404, detail="Anchor log not found")

        topic_id = str(getattr(anchor, "topicId", "") or "").strip()
        task_id = getattr(anchor, "taskId", None)
        if not topic_id or task_id is not None:
            raise HTTPException(status_code=400, detail="Purge forward is only supported for Topic Chat messages")

        # Purge within Topic Chat scope only: same topicId + taskId is NULL, from anchor onward.
        query = (
            select(LogEntry)
            .where(LogEntry.topicId == topic_id, LogEntry.taskId.is_(None))
            .order_by(
                LogEntry.createdAt.asc(),
                (text("rowid ASC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.asc()),
            )
        )
        topic_chat_logs = session.exec(query).all()
        if not topic_chat_logs:
            return {"ok": True, "deleted": False, "deletedCount": 0, "deletedIds": []}

        # Purge from the anchor's position forward.
        start_idx = next((idx for idx, row in enumerate(topic_chat_logs) if row.id == anchor_id), -1)
        if start_idx < 0:
            raise HTTPException(status_code=400, detail="Anchor log is not part of Topic Chat")

        roots = topic_chat_logs[start_idx:]
        root_ids = [row.id for row in roots]

        notes = session.exec(select(LogEntry).where(LogEntry.relatedLogId.in_(root_ids))).all() if root_ids else []
        to_delete = list(roots) + [row for row in notes if row.id not in set(root_ids)]
        deleted_ids = [row.id for row in to_delete]

        # Best-effort attachment cleanup (DB rows + on-disk files).
        attachment_ids: set[str] = set()
        for row in roots:
            atts = row.attachments if isinstance(row.attachments, list) else []
            for att in atts:
                if not isinstance(att, dict):
                    continue
                att_id = str(att.get("id") or "").strip()
                if att_id:
                    attachment_ids.add(att_id)

        if attachment_ids:
            try:
                attachment_rows = session.exec(select(Attachment).where(Attachment.id.in_(list(attachment_ids)))).all()
            except Exception:
                attachment_rows = []
            root = _attachments_root()
            for att_row in attachment_rows:
                storage_path = str(att_row.storagePath or att_row.id)
                path = root / storage_path
                try:
                    if path.exists():
                        path.unlink()
                except Exception:
                    pass
                try:
                    session.delete(att_row)
                except Exception:
                    pass

        for row in to_delete:
            session.delete(row)
        session.commit()

        stamp = now_iso()
        for deleted_id in deleted_ids:
            enqueue_reindex_request({"op": "delete", "kind": "log", "id": deleted_id})
            try:
                session.add(DeletedLog(id=deleted_id, deletedAt=stamp))
                session.commit()
            except Exception:
                session.rollback()

        event_ts = stamp
        for deleted_id in deleted_ids:
            event_hub.publish({"type": "log.deleted", "data": {"id": deleted_id, "rootId": anchor_id}, "eventTs": event_ts})

        return {"ok": True, "deleted": True, "deletedCount": len(deleted_ids), "deletedIds": deleted_ids, "anchorLogId": anchor_id}


def _serialize_changes_payload(
    *,
    spaces: list[Space],
    topics: list[Topic],
    tasks: list[Task],
    logs: list[LogEntry],
    drafts: list[Draft],
    deleted_log_ids: list[str],
) -> dict[str, Any]:
    return {
        "spaces": [SpaceOut.model_validate(row).model_dump() for row in spaces],
        "topics": [TopicOut.model_validate(row).model_dump() for row in topics],
        "tasks": [TaskOut.model_validate(row).model_dump() for row in tasks],
        "logs": [LogOutLite.model_validate(row).model_dump() for row in logs],
        "drafts": [DraftOut.model_validate(row).model_dump() for row in drafts],
        "deletedLogIds": [str(item) for item in deleted_log_ids if str(item).strip()],
    }


def _build_changes_payload(
    session: Any,
    *,
    since: str | None,
    limit_logs: int,
    include_raw: bool,
    allowed_space_ids: set[str] | None,
) -> dict[str, Any]:
    if not since:
        space_query = select(Space)
        topic_query = select(Topic)
        task_query = select(Task)
        if allowed_space_ids is not None:
            space_query = space_query.where(Space.id.in_(list(allowed_space_ids)))
        spaces = session.exec(space_query).all()
        topics = session.exec(topic_query).all()
        if allowed_space_ids is not None:
            topics = [topic for topic in topics if _topic_matches_allowed_spaces(topic, allowed_space_ids)]
        topic_by_id = {str(getattr(topic, "id", "") or ""): topic for topic in topics if getattr(topic, "id", None)}
        tasks = session.exec(task_query).all()
        if allowed_space_ids is not None:
            parent_topics = _load_topics_by_ids(
                session,
                [str(getattr(task, "topicId", "") or "").strip() for task in tasks],
            )
            merged_topic_by_id = {**parent_topics, **topic_by_id}
            tasks = [task for task in tasks if _task_matches_allowed_spaces(task, allowed_space_ids, merged_topic_by_id)]
        drafts = session.exec(select(Draft)).all()
        log_query = select(LogEntry).order_by(
            LogEntry.createdAt.desc(),
            (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
        ).limit(limit_logs)
        if not include_raw:
            log_query = log_query.options(defer(LogEntry.raw))
        logs = session.exec(log_query).all()
        if allowed_space_ids is not None:
            seeded_tasks = {str(getattr(task, "id", "") or ""): task for task in tasks if getattr(task, "id", None)}
            topic_by_id_for_logs, task_by_id_for_logs = _load_related_maps_for_logs(
                session,
                logs,
                seeded_topics=topic_by_id,
                seeded_tasks=seeded_tasks,
            )
            logs = [
                row
                for row in logs
                if _log_matches_allowed_spaces(row, allowed_space_ids, topic_by_id_for_logs, task_by_id_for_logs)
            ]
    else:
        space_query = select(Space).where(Space.updatedAt >= since)
        topic_query = select(Topic).where(Topic.updatedAt >= since)
        task_query = select(Task).where(Task.updatedAt >= since)
        if allowed_space_ids is not None:
            space_query = space_query.where(Space.id.in_(list(allowed_space_ids)))
        spaces = session.exec(space_query).all()
        topics = session.exec(topic_query).all()
        if allowed_space_ids is not None:
            topics = [topic for topic in topics if _topic_matches_allowed_spaces(topic, allowed_space_ids)]
        topic_by_id = {str(getattr(topic, "id", "") or ""): topic for topic in topics if getattr(topic, "id", None)}
        tasks = session.exec(task_query).all()
        if allowed_space_ids is not None:
            parent_topics = _load_topics_by_ids(
                session,
                [str(getattr(task, "topicId", "") or "").strip() for task in tasks],
            )
            merged_topic_by_id = {**parent_topics, **topic_by_id}
            tasks = [task for task in tasks if _task_matches_allowed_spaces(task, allowed_space_ids, merged_topic_by_id)]
        drafts = session.exec(select(Draft).where(Draft.updatedAt >= since)).all()
        log_query = (
            select(LogEntry)
            .where(LogEntry.updatedAt >= since)
            .order_by(LogEntry.updatedAt.desc(), LogEntry.createdAt.desc(), LogEntry.id.desc())
            .limit(limit_logs)
        )
        if not include_raw:
            log_query = log_query.options(defer(LogEntry.raw))
        logs = session.exec(log_query).all()
        if allowed_space_ids is not None:
            seeded_tasks = {str(getattr(task, "id", "") or ""): task for task in tasks if getattr(task, "id", None)}
            topic_by_id_for_logs, task_by_id_for_logs = _load_related_maps_for_logs(
                session,
                logs,
                seeded_topics=topic_by_id,
                seeded_tasks=seeded_tasks,
            )
            logs = [
                row
                for row in logs
                if _log_matches_allowed_spaces(row, allowed_space_ids, topic_by_id_for_logs, task_by_id_for_logs)
            ]

    if not include_raw:
        for row in logs:
            row.raw = None

    spaces.sort(key=lambda s: s.updatedAt, reverse=True)
    topics.sort(key=lambda t: t.updatedAt, reverse=True)
    tasks.sort(key=lambda t: t.updatedAt, reverse=True)
    drafts.sort(key=lambda d: d.updatedAt, reverse=True)

    deleted_log_ids: list[str] = []
    if since:
        try:
            deleted_rows = session.exec(select(DeletedLog).where(DeletedLog.deletedAt >= since)).all()
            deleted_log_ids = [row.id for row in deleted_rows if getattr(row, "id", None)]
        except Exception:
            deleted_log_ids = []

    return _serialize_changes_payload(
        spaces=spaces,
        topics=topics,
        tasks=tasks,
        logs=logs,
        drafts=drafts,
        deleted_log_ids=deleted_log_ids,
    )


@app.get("/api/changes", response_model=ChangesResponse, tags=["changes"])
def list_changes(
    since: str | None = Query(
        default=None,
        description="Return items updated/created at or after this ISO timestamp.",
        example="2026-02-02T10:05:00.000Z",
    ),
    limitLogs: int = Query(
        default=2000,
        ge=0,
        le=20000,
        description="Safety cap for logs returned (prevents large-memory full dumps).",
        example=2000,
    ),
    includeRaw: bool = Query(
        default=False,
        description="Include raw payload field (can be large).",
        example=False,
    ),
    spaceId: str | None = Query(default=None, description="Resolve visibility from this source space id."),
    allowedSpaceIds: str | None = Query(default=None, description="Explicit allowed space ids (comma-separated)."),
):
    """Return topics/tasks/logs changed since timestamp (ISO).

    NOTE: For large instances, returning *all* logs can exhaust memory in the API process and
    crash the container. This endpoint caps logs by default and is intended for incremental sync.
    """
    with get_session() as session:
        allowed_space_ids = _resolve_allowed_space_ids(
            session,
            source_space_id=spaceId,
            allowed_space_ids_raw=allowedSpaceIds,
        )

        def _build() -> dict[str, Any]:
            return _build_changes_payload(
                session,
                since=since,
                limit_logs=limitLogs,
                include_raw=includeRaw,
                allowed_space_ids=allowed_space_ids,
            )

        if not since and not includeRaw:
            revision = _changes_revision_token(session)
            payload, _cached = _get_or_build_precompiled(
                namespace="changes",
                key_parts=_changes_cache_key_parts(
                    limit_logs=limitLogs,
                    include_raw=includeRaw,
                    allowed_space_ids=allowed_space_ids,
                ),
                revision=revision,
                build_fn=_build,
            )
            return payload

        return _build()


@app.post(
    "/api/drafts",
    dependencies=[Depends(require_token)],
    response_model=DraftOut,
    tags=["drafts"],
)
def upsert_draft(payload: DraftUpsert = Body(...)):
    """Upsert a draft value by key (cross-browser draft persistence)."""
    key = (payload.key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Draft key is required.")

    value = payload.value or ""
    stamp = now_iso()

    with get_session() as session:
        row = session.get(Draft, key)
        if row:
            row.value = value
            row.updatedAt = stamp
        else:
            row = Draft(key=key, value=value, createdAt=stamp, updatedAt=stamp)
        session.add(row)
        try:
            session.commit()
        except OperationalError as exc:
            if not DATABASE_URL.startswith("sqlite") or "database is locked" not in str(exc).lower():
                raise
            session.rollback()
            last_exc: OperationalError | None = exc
            for attempt in range(6):
                try:
                    # rollback() can detach pending instances; ensure this upsert is part of the new transaction.
                    session.add(row)
                    time.sleep(min(0.75, 0.05 * (2**attempt)))
                    session.commit()
                    last_exc = None
                    break
                except OperationalError as retry_exc:
                    if "database is locked" not in str(retry_exc).lower():
                        raise
                    session.rollback()
                    last_exc = retry_exc
            if last_exc is not None:
                raise last_exc
        session.refresh(row)

        event_hub.publish({"type": "draft.upserted", "data": row.model_dump(), "eventTs": row.updatedAt})
        return row


def _build_clawgraph_payload(
    session: Any,
    *,
    max_entities: int,
    max_nodes: int,
    min_edge_weight: float,
    limit_logs: int,
    include_pending: bool,
    allowed_space_ids: set[str] | None,
) -> dict[str, Any]:
    all_topics = session.exec(select(Topic)).all()
    all_topic_by_id = {str(getattr(topic, "id", "") or ""): topic for topic in all_topics if getattr(topic, "id", None)}
    topics = (
        [topic for topic in all_topics if _topic_matches_allowed_spaces(topic, allowed_space_ids)]
        if allowed_space_ids is not None
        else all_topics
    )
    all_tasks = session.exec(select(Task)).all()
    tasks = (
        [task for task in all_tasks if _task_matches_allowed_spaces(task, allowed_space_ids, all_topic_by_id)]
        if allowed_space_ids is not None
        else all_tasks
    )
    all_task_by_id = {str(getattr(task, "id", "") or ""): task for task in all_tasks if getattr(task, "id", None)}
    # Raw payloads can be very large; exclude from bulk graph extraction.
    log_query = select(LogEntry).options(defer(LogEntry.raw))
    if not include_pending:
        log_query = log_query.where(LogEntry.classificationStatus == "classified")
    log_query = log_query.order_by(
        LogEntry.createdAt.desc(),
        LogEntry.updatedAt.desc(),
        (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
    ).limit(limit_logs)
    logs = session.exec(log_query).all()
    if allowed_space_ids is not None:
        logs = [
            entry
            for entry in logs
            if _log_matches_allowed_spaces(entry, allowed_space_ids, all_topic_by_id, all_task_by_id)
        ]

    graph = build_clawgraph(
        topics,
        tasks,
        logs,
        max_entities=max_entities,
        max_nodes=max_nodes,
        min_edge_weight=min_edge_weight,
    )
    graph["generatedAt"] = now_iso()
    return graph


@app.get("/api/clawgraph", response_model=ClawgraphResponse, tags=["clawgraph"])
def clawgraph(
    maxEntities: int = Query(default=120, ge=20, le=400, description="Maximum number of entity nodes."),
    maxNodes: int = Query(default=260, ge=40, le=800, description="Maximum total nodes."),
    minEdgeWeight: float = Query(default=0.16, ge=0.0, le=2.0, description="Edge weight threshold."),
    limitLogs: int = Query(default=2400, ge=100, le=20000, description="Recent log window used for graph build."),
    includePending: bool = Query(default=True, description="Include pending logs in graph extraction."),
    spaceId: str | None = Query(default=None, description="Resolve visibility from this source space id."),
    allowedSpaceIds: str | None = Query(default=None, description="Explicit allowed space ids (comma-separated)."),
):
    """Build and return an entity-relationship graph from topics/tasks/logs."""
    with get_session() as session:
        allowed_space_ids = _resolve_allowed_space_ids(
            session,
            source_space_id=spaceId,
            allowed_space_ids_raw=allowedSpaceIds,
        )

        def _build() -> dict[str, Any]:
            return _build_clawgraph_payload(
                session,
                max_entities=maxEntities,
                max_nodes=maxNodes,
                min_edge_weight=minEdgeWeight,
                limit_logs=limitLogs,
                include_pending=includePending,
                allowed_space_ids=allowed_space_ids,
            )

        revision = _graph_revision_token(session)
        payload, _cached = _get_or_build_precompiled(
            namespace="clawgraph",
            key_parts=_clawgraph_cache_key_parts(
                max_entities=maxEntities,
                max_nodes=maxNodes,
                min_edge_weight=minEdgeWeight,
                limit_logs=limitLogs,
                include_pending=includePending,
                allowed_space_ids=allowed_space_ids,
            ),
            revision=revision,
            build_fn=_build,
        )
        return payload


def _search_impl(
    session: Any,
    query: str,
    *,
    topic_id: str | None,
    allowed_space_ids: set[str] | None,
    session_key: str | None,
    include_pending: bool,
    limit_topics: int,
    limit_tasks: int,
    limit_logs: int,
    allow_deep_content_scan: bool = True,
) -> dict:
    normalized_query = str(query or "").strip().lower()
    query_tokens = _search_query_tokens(normalized_query)
    max_query_token_length = max((len(token) for token in query_tokens), default=0)
    single_token_query = len(query_tokens) == 1
    require_sparse_for_propagation = len(query_tokens) >= 2 or max_query_token_length >= 5
    propagation_scale = 1.0
    if single_token_query:
        propagation_scale = 0.72 if max_query_token_length >= 5 else 0.9

    effective_limit_topics = max(1, min(int(limit_topics), max(1, SEARCH_EFFECTIVE_LIMIT_TOPICS)))
    effective_limit_tasks = max(1, min(int(limit_tasks), max(1, SEARCH_EFFECTIVE_LIMIT_TASKS)))
    effective_limit_logs = max(10, min(int(limit_logs), max(10, SEARCH_EFFECTIVE_LIMIT_LOGS)))

    all_topics = session.exec(select(Topic)).all()
    all_topic_by_id = {str(getattr(topic, "id", "") or ""): topic for topic in all_topics if getattr(topic, "id", None)}
    topics = (
        [topic for topic in all_topics if _topic_matches_allowed_spaces(topic, allowed_space_ids)]
        if allowed_space_ids is not None
        else all_topics
    )
    all_tasks = session.exec(select(Task)).all()
    tasks = (
        [task for task in all_tasks if _task_matches_allowed_spaces(task, allowed_space_ids, all_topic_by_id)]
        if allowed_space_ids is not None
        else all_tasks
    )
    all_task_by_id = {str(getattr(task, "id", "") or ""): task for task in all_tasks if getattr(task, "id", None)}
    # Never load the entire log table into memory for search.
    # This endpoint is used from the UI and must remain safe for large instances.
    window_multiplier = max(1, SEARCH_WINDOW_MULTIPLIER)
    window_min_logs = max(200, SEARCH_WINDOW_MIN_LOGS)
    window_max_logs = max(window_min_logs, SEARCH_WINDOW_MAX_LOGS)
    window_logs = max(window_min_logs, min(window_max_logs, effective_limit_logs * window_multiplier))
    if single_token_query:
        single_token_window_cap = max(200, SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS)
        window_logs = min(window_logs, single_token_window_cap)
    # Raw payloads can be very large; exclude from bulk search window.
    # For content, we fetch bounded snippets in a separate query so lexical/BM25 can still
    # use query terms that were not preserved in summaries.
    log_query = select(LogEntry).options(defer(LogEntry.raw), defer(LogEntry.content))
    if topic_id:
        log_query = log_query.where(LogEntry.topicId == topic_id)
    if not include_pending:
        log_query = log_query.where(LogEntry.classificationStatus == "classified")
    log_fetch_limit = window_logs
    if allowed_space_ids is not None:
        log_fetch_limit = min(max(window_logs * 4, window_logs + 320), max(window_logs, SEARCH_WINDOW_MAX_LOGS))
    log_query = log_query.order_by(
        LogEntry.createdAt.desc(),
        LogEntry.updatedAt.desc(),
        (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
    ).limit(log_fetch_limit)
    logs = session.exec(log_query).all()
    if allowed_space_ids is not None:
        logs = [
            entry
            for entry in logs
            if _log_matches_allowed_spaces(entry, allowed_space_ids, all_topic_by_id, all_task_by_id)
        ][:window_logs]
    recent_log_ids = [str(entry.id or "").strip() for entry in logs if getattr(entry, "id", None)]
    preview_scan_cap_base = max(0, int(SEARCH_LOG_CONTENT_PREVIEW_SCAN_LIMIT))
    preview_dynamic_cap = max(80, min(320, effective_limit_logs * 2))
    preview_scan_cap = min(preview_scan_cap_base, preview_dynamic_cap) if preview_scan_cap_base > 0 else 0
    if not allow_deep_content_scan:
        preview_scan_cap = min(preview_scan_cap, max(48, min(120, effective_limit_logs)))
    if preview_scan_cap > 0:
        preview_scan_ids = recent_log_ids[:preview_scan_cap]
    else:
        preview_scan_ids = []

    content_preview_by_log_id: dict[str, str] = {}
    if SEARCH_LOG_CONTENT_SNIPPET_CHARS > 0 and preview_scan_ids:
        snippet_head_chars = max(220, SEARCH_LOG_CONTENT_SNIPPET_CHARS // 2)
        snippet_tail_chars = max(220, SEARCH_LOG_CONTENT_SNIPPET_CHARS // 2)
        content_expr = func.coalesce(LogEntry.content, "")
        for id_chunk in _chunked_values(preview_scan_ids, SEARCH_LOG_CONTENT_ID_CHUNK_SIZE):
            content_query = select(
                LogEntry.id,
                func.substr(content_expr, 1, snippet_head_chars).label("contentHead"),
                func.substr(content_expr, func.length(content_expr) - snippet_tail_chars + 1, snippet_tail_chars).label("contentTail"),
            ).where(LogEntry.id.in_(id_chunk))
            for row in session.exec(content_query).all():
                try:
                    log_id = str(row[0] or "").strip()
                    head_raw = str(row[1] or "")
                    tail_raw = str(row[2] or "")
                except Exception:
                    continue
                if not log_id:
                    continue
                if head_raw and tail_raw and head_raw != tail_raw:
                    preview_raw = f"{head_raw}\n{tail_raw}"
                else:
                    preview_raw = head_raw or tail_raw
                if not preview_raw:
                    continue
                preview = _clip(_sanitize_log_text(preview_raw), SEARCH_LOG_CONTENT_SNIPPET_CHARS)
                if preview:
                    content_preview_by_log_id[log_id] = preview

    if query_tokens and SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS > 0:
        query_terms = [token for token in sorted(query_tokens) if len(token) >= 3][:6]
        max_query_token_length = max((len(token) for token in query_tokens), default=0)
        allow_query_term_scan = len(query_tokens) >= 2 or max_query_token_length >= 7
        match_scan_cap_base = max(0, int(SEARCH_LOG_CONTENT_MATCH_SCAN_LIMIT))
        if len(query_tokens) >= 2:
            match_dynamic_cap = max(60, min(240, effective_limit_logs))
        else:
            match_dynamic_cap = max(30, min(120, effective_limit_logs))
        match_scan_cap = min(match_scan_cap_base, match_dynamic_cap) if match_scan_cap_base > 0 else 0
        if not allow_deep_content_scan:
            match_scan_cap = 0
        if not allow_query_term_scan:
            match_scan_cap = 0
        match_scan_ids = preview_scan_ids[:match_scan_cap] if match_scan_cap > 0 else []
        if query_terms and match_scan_ids:
            content_clip_chars = max(1000, int(SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS))
            content_expr = func.coalesce(LogEntry.content, "")
            for id_chunk in _chunked_values(match_scan_ids, SEARCH_LOG_CONTENT_ID_CHUNK_SIZE):
                content_match_query = select(
                    LogEntry.id,
                    func.substr(content_expr, 1, content_clip_chars).label("contentClip"),
                ).where(LogEntry.id.in_(id_chunk))
                for row in session.exec(content_match_query).all():
                    try:
                        log_id = str(row[0] or "").strip()
                        content_raw = str(row[1] or "")
                    except Exception:
                        continue
                    if not log_id or not content_raw:
                        continue
                    lowered = content_raw.lower()
                    if not any(term in lowered for term in query_terms):
                        continue
                    snippet = _extract_query_snippet(
                        content_raw,
                        query_terms,
                        radius=max(180, SEARCH_LOG_CONTENT_SNIPPET_CHARS // 2),
                        cap=max(280, SEARCH_LOG_CONTENT_SNIPPET_CHARS),
                    )
                    if not snippet:
                        continue
                    prior = content_preview_by_log_id.get(log_id) or ""
                    if prior and snippet in prior:
                        continue
                    merged = _clip(" ".join(part for part in [prior, snippet] if part), max(280, SEARCH_LOG_CONTENT_SNIPPET_CHARS))
                    content_preview_by_log_id[log_id] = merged

    if topic_id:
        tasks = [task for task in tasks if task.topicId == topic_id]

    topic_map: dict[str, Topic] = {item.id: item for item in topics}
    task_map: dict[str, Task] = {item.id: item for item in tasks}
    log_map: dict[str, LogEntry] = {item.id: item for item in logs}

    notes = [entry for entry in logs if entry.type == "note" and entry.relatedLogId]
    note_count_by_log: dict[str, int] = {}
    note_items_by_log: dict[str, list[LogEntry]] = {}
    for note in notes:
        related_id = str(note.relatedLogId or "")
        if not related_id:
            continue
        note_count_by_log[related_id] = (note_count_by_log.get(related_id) or 0) + 1
        note_items_by_log.setdefault(related_id, []).append(note)

    note_weight_by_topic: dict[str, float] = {}
    note_weight_by_task: dict[str, float] = {}
    for related_id, count in note_count_by_log.items():
        related = log_map.get(related_id)
        if not related:
            continue
        weight = min(0.24, 0.07 * count)
        if related.topicId:
            note_weight_by_topic[related.topicId] = (note_weight_by_topic.get(related.topicId) or 0.0) + weight
        if related.taskId:
            note_weight_by_task[related.taskId] = (note_weight_by_task.get(related.taskId) or 0.0) + weight

    session_topic_ids: set[str] = set()
    session_task_ids: set[str] = set()
    session_log_ids: set[str] = set()
    if session_key:
        for entry in logs:
            if not _log_matches_session(entry, session_key):
                continue
            session_log_ids.add(entry.id)
            if entry.topicId:
                session_topic_ids.add(entry.topicId)
            if entry.taskId:
                session_task_ids.add(entry.taskId)

    # Build a lightweight log payload for semantic_search without touching deferred columns.
    # If we access entry.content here, SQLAlchemy will lazy-load it and defeat the point.
    log_payloads: list[dict[str, Any]] = []
    log_text_limit = max(280, SEARCH_LOG_TEXT_BUDGET_CHARS)
    for entry in logs:
        summary_text = _clip(_sanitize_log_text(str(entry.summary or "")), 280)
        content_preview = content_preview_by_log_id.get(str(entry.id), "")
        if content_preview and summary_text and summary_text.lower() in content_preview.lower():
            content_text = _clip(content_preview, log_text_limit)
        else:
            content_text = _clip(" ".join(part for part in [summary_text, content_preview] if part), log_text_limit)
        if not content_text:
            content_text = summary_text
        log_payloads.append(
            {
                "id": entry.id,
                "topicId": entry.topicId,
                "taskId": entry.taskId,
                "relatedLogId": entry.relatedLogId,
                "idempotencyKey": entry.idempotencyKey,
                "type": entry.type,
                "summary": summary_text,
                "content": content_text,
                "raw": "",
                "createdAt": entry.createdAt,
                "updatedAt": entry.updatedAt,
                "agentId": entry.agentId,
                "agentLabel": entry.agentLabel,
                "source": entry.source,
            }
        )

    topic_query_hints: dict[str, list[str]] = {}

    def _append_topic_hint(topic_id_hint: str | None, text_hint: str, *, max_items: int = 8) -> None:
        topic_key = str(topic_id_hint or "").strip()
        if not topic_key:
            return
        cleaned_hint_raw = _sanitize_log_text(text_hint)
        if not cleaned_hint_raw:
            return
        if query_tokens:
            hint_tokens = _search_query_tokens(cleaned_hint_raw)
            overlap = len(query_tokens & hint_tokens)
            phrase_hit = bool(normalized_query and normalized_query in cleaned_hint_raw.lower())
            if overlap <= 0 and not phrase_hit:
                return
        cleaned_hint = _clip(cleaned_hint_raw, 420)
        bucket = topic_query_hints.setdefault(topic_key, [])
        if cleaned_hint in bucket:
            return
        if len(bucket) >= max_items:
            return
        bucket.append(cleaned_hint)

    if query_tokens:
        for task in tasks:
            _append_topic_hint(task.topicId, str(task.title or ""))
        for entry in logs:
            if not _log_allowed_for_semantic_search(entry):
                continue
            topic_key = str(entry.topicId or "").strip()
            if not topic_key:
                continue
            _append_topic_hint(topic_key, str(entry.summary or ""))
            preview = content_preview_by_log_id.get(str(entry.id), "")
            if preview:
                _append_topic_hint(topic_key, preview)

    topics_payload: list[dict[str, Any]] = []
    for topic in topics:
        payload = topic.model_dump()
        hints = topic_query_hints.get(topic.id) or []
        if hints:
            payload["searchText"] = _clip(" ".join(hints), 900)
        topics_payload.append(payload)

    search_result = semantic_search(
        query,
        topics_payload,
        [item.model_dump() for item in tasks],
        log_payloads,
        topic_limit=effective_limit_topics,
        task_limit=effective_limit_tasks,
        log_limit=effective_limit_logs,
    )

    topic_base_score: dict[str, float] = {
        str(item.get("id") or ""): float(item.get("score") or 0.0) for item in search_result.get("topics", [])
    }
    topic_search_rows: dict[str, dict[str, Any]] = {
        str(item.get("id") or ""): item for item in search_result.get("topics", []) if item.get("id")
    }
    task_base_score: dict[str, float] = {
        str(item.get("id") or ""): float(item.get("score") or 0.0) for item in search_result.get("tasks", [])
    }
    task_search_rows: dict[str, dict[str, Any]] = {
        str(item.get("id") or ""): item for item in search_result.get("tasks", []) if item.get("id")
    }
    log_base_score: dict[str, float] = {
        str(item.get("id") or ""): float(item.get("score") or 0.0) for item in search_result.get("logs", [])
    }
    log_search_rows: dict[str, dict[str, Any]] = {
        str(item.get("id") or ""): item for item in search_result.get("logs", []) if item.get("id")
    }

    def _aggregate_parent_boosts(
        candidates: dict[str, list[float]],
        *,
        top_k: int,
        total_cap: float,
    ) -> dict[str, float]:
        boosts: dict[str, float] = {}
        effective_top_k = max(1, int(top_k))
        effective_cap = max(0.0, float(total_cap))
        for parent_id, values in candidates.items():
            if not parent_id or not values:
                continue
            clipped: list[float] = []
            for value in values:
                score = float(value or 0.0)
                if score > 0:
                    clipped.append(score)
            if not clipped:
                continue
            clipped.sort(reverse=True)
            boosts[parent_id] = min(effective_cap, sum(clipped[:effective_top_k]))
        return boosts

    # Parent propagation from matched logs.
    # Keep this bounded so one large topic with many weak matches cannot dominate.
    topic_boost_candidates: dict[str, list[float]] = {}
    task_boost_candidates: dict[str, list[float]] = {}
    for log_id, score in log_base_score.items():
        entry = log_map.get(log_id)
        if not entry:
            continue
        log_row = log_search_rows.get(log_id) or {}
        bm25_score = max(0.0, float(log_row.get("bm25Score") or 0.0))
        lexical_score = max(0.0, float(log_row.get("lexicalScore") or 0.0))
        chunk_score = max(0.0, float(log_row.get("chunkScore") or 0.0))
        best_chunk_text = ""
        best_chunk = log_row.get("bestChunk")
        if isinstance(best_chunk, dict):
            best_chunk_text = str(best_chunk.get("text") or "").strip().lower()
        exact_phrase_hit = bool(normalized_query and best_chunk_text and normalized_query in best_chunk_text)
        if require_sparse_for_propagation and not (bm25_score > 0 or lexical_score > 0 or chunk_score > 0 or exact_phrase_hit):
            continue
        if entry.topicId:
            topic_boost_candidates.setdefault(entry.topicId, []).append(
                min(
                    TOPIC_LOG_PROPAGATION_PER_LOG_CAP * propagation_scale,
                    score * TOPIC_LOG_PROPAGATION_FACTOR * propagation_scale,
                )
            )
        if entry.taskId:
            task_boost_candidates.setdefault(entry.taskId, []).append(
                min(
                    TASK_LOG_PROPAGATION_PER_LOG_CAP * propagation_scale,
                    score * TASK_LOG_PROPAGATION_FACTOR * propagation_scale,
                )
            )

    topic_log_boost = _aggregate_parent_boosts(
        topic_boost_candidates,
        top_k=TOPIC_LOG_PROPAGATION_TOP_K,
        total_cap=TOPIC_LOG_PROPAGATION_CAP,
    )
    task_log_boost = _aggregate_parent_boosts(
        task_boost_candidates,
        top_k=TASK_LOG_PROPAGATION_TOP_K,
        total_cap=TASK_LOG_PROPAGATION_CAP,
    )
    topic_task_boost_candidates: dict[str, list[float]] = {}
    topic_task_exact_match_bonus: dict[str, float] = {}
    for task_id2, task_score in task_base_score.items():
        task = task_map.get(task_id2)
        topic_id2 = str(getattr(task, "topicId", "") or "")
        if not topic_id2:
            continue
        task_row = task_search_rows.get(task_id2) or {}
        support = min(
            TOPIC_TASK_PROPAGATION_PER_TASK_CAP * propagation_scale,
            float(task_score or 0.0) * TOPIC_TASK_PROPAGATION_FACTOR * propagation_scale,
        )
        bm25_score = max(0.0, float(task_row.get("bm25Score") or 0.0))
        lexical_score = max(0.0, float(task_row.get("lexicalScore") or 0.0))
        chunk_score = max(0.0, float(task_row.get("chunkScore") or 0.0))
        support += min(
            TOPIC_TASK_PROPAGATION_LEXICAL_CAP * propagation_scale,
            lexical_score * TOPIC_TASK_PROPAGATION_LEXICAL_FACTOR * propagation_scale,
        )
        best_chunk = task_row.get("bestChunk")
        best_chunk_text = ""
        if isinstance(best_chunk, dict):
            best_chunk_text = str(best_chunk.get("text") or "").strip().lower()
        exact_phrase_hit = bool(normalized_query and best_chunk_text and normalized_query in best_chunk_text)
        if exact_phrase_hit:
            support += TOPIC_TASK_PROPAGATION_EXACT_BONUS * propagation_scale
            topic_task_exact_match_bonus[topic_id2] = TOPIC_TASK_PROPAGATION_TOPIC_EXACT_BONUS * propagation_scale
        if require_sparse_for_propagation and not (bm25_score > 0 or lexical_score > 0 or chunk_score > 0 or exact_phrase_hit):
            continue
        support = min(TOPIC_TASK_PROPAGATION_PER_TASK_TOTAL_CAP * propagation_scale, support)
        if support > 0:
            topic_task_boost_candidates.setdefault(topic_id2, []).append(support)
    topic_task_boost = _aggregate_parent_boosts(
        topic_task_boost_candidates,
        top_k=TOPIC_TASK_PROPAGATION_TOP_K,
        total_cap=TOPIC_TASK_PROPAGATION_CAP,
    )

    for topic_id2, boost in topic_log_boost.items():
        topic_base_score[topic_id2] = topic_base_score.get(topic_id2, 0.0) + boost
    for topic_id2, boost in topic_task_boost.items():
        topic_base_score[topic_id2] = topic_base_score.get(topic_id2, 0.0) + boost
    for topic_id2, bonus in topic_task_exact_match_bonus.items():
        topic_base_score[topic_id2] = topic_base_score.get(topic_id2, 0.0) + bonus
    for task_id2, boost in task_log_boost.items():
        task_base_score[task_id2] = task_base_score.get(task_id2, 0.0) + boost

    topic_direct_match_boost: dict[str, float] = {}
    for topic in topics:
        boost = _direct_label_match_boost(getattr(topic, "name", None), normalized_query, query_tokens)
        if boost > 0:
            topic_direct_match_boost[topic.id] = boost

    task_direct_match_boost: dict[str, float] = {}
    for task in tasks:
        boost = _direct_label_match_boost(getattr(task, "title", None), normalized_query, query_tokens)
        if boost > 0:
            task_direct_match_boost[task.id] = boost

    topic_rows: list[dict[str, Any]] = []
    for topic_id2, base_score in topic_base_score.items():
        topic = topic_map.get(topic_id2)
        if not topic:
            continue
        score = base_score
        direct_match_boost = topic_direct_match_boost.get(topic_id2, 0.0)
        score += direct_match_boost
        score += min(0.26, note_weight_by_topic.get(topic_id2, 0.0))
        if topic_id2 in session_topic_ids:
            score += 0.12
        topic_rows.append(
            {
                "id": topic.id,
                "name": topic.name,
                "description": topic.description,
                "score": round(score, 6),
                "vectorScore": float((topic_search_rows.get(topic_id2) or {}).get("vectorScore") or 0.0),
                "bm25Score": float((topic_search_rows.get(topic_id2) or {}).get("bm25Score") or 0.0),
                "lexicalScore": float((topic_search_rows.get(topic_id2) or {}).get("lexicalScore") or 0.0),
                "rrfScore": float((topic_search_rows.get(topic_id2) or {}).get("rrfScore") or 0.0),
                "rerankScore": float((topic_search_rows.get(topic_id2) or {}).get("rerankScore") or 0.0),
                "bestChunk": (topic_search_rows.get(topic_id2) or {}).get("bestChunk"),
                "logPropagationWeight": round(topic_log_boost.get(topic_id2, 0.0), 6),
                "taskPropagationWeight": round(topic_task_boost.get(topic_id2, 0.0), 6),
                "taskExactMatchBonus": round(topic_task_exact_match_bonus.get(topic_id2, 0.0), 6),
                "directMatchBoost": round(direct_match_boost, 6),
                "noteWeight": round(min(0.26, note_weight_by_topic.get(topic_id2, 0.0)), 6),
                "sessionBoosted": topic_id2 in session_topic_ids,
            }
        )
    topic_rows.sort(key=lambda item: float(item["score"]), reverse=True)
    topic_rows = topic_rows[:effective_limit_topics]

    task_rows: list[dict[str, Any]] = []
    for task_id2, base_score in task_base_score.items():
        task = task_map.get(task_id2)
        if not task:
            continue
        score = base_score
        direct_match_boost = task_direct_match_boost.get(task_id2, 0.0)
        score += direct_match_boost
        score += min(0.26, note_weight_by_task.get(task_id2, 0.0))
        if task_id2 in session_task_ids:
            score += 0.1
        task_rows.append(
            {
                "id": task.id,
                "topicId": task.topicId,
                "title": task.title,
                "status": task.status,
                "score": round(score, 6),
                "vectorScore": float((task_search_rows.get(task_id2) or {}).get("vectorScore") or 0.0),
                "bm25Score": float((task_search_rows.get(task_id2) or {}).get("bm25Score") or 0.0),
                "lexicalScore": float((task_search_rows.get(task_id2) or {}).get("lexicalScore") or 0.0),
                "rrfScore": float((task_search_rows.get(task_id2) or {}).get("rrfScore") or 0.0),
                "rerankScore": float((task_search_rows.get(task_id2) or {}).get("rerankScore") or 0.0),
                "bestChunk": (task_search_rows.get(task_id2) or {}).get("bestChunk"),
                "logPropagationWeight": round(task_log_boost.get(task_id2, 0.0), 6),
                "directMatchBoost": round(direct_match_boost, 6),
                "noteWeight": round(min(0.26, note_weight_by_task.get(task_id2, 0.0)), 6),
                "sessionBoosted": task_id2 in session_task_ids,
            }
        )
    task_rows.sort(key=lambda item: float(item["score"]), reverse=True)
    task_rows = task_rows[:effective_limit_tasks]

    log_rows: list[dict[str, Any]] = []
    for log_id2, base_score in log_base_score.items():
        entry = log_map.get(log_id2)
        if not entry:
            continue
        search_row = log_search_rows.get(log_id2) or {}
        best_chunk = search_row.get("bestChunk")
        best_chunk_text = ""
        if isinstance(best_chunk, dict):
            best_chunk_text = _sanitize_log_text(str(best_chunk.get("text") or ""))
        content_preview = _sanitize_log_text(content_preview_by_log_id.get(log_id2, ""))
        response_content = content_preview or best_chunk_text or _sanitize_log_text(entry.summary or "")
        score = base_score
        note_count = int(note_count_by_log.get(log_id2) or 0)
        note_weight = min(0.24, 0.06 * note_count)
        score += note_weight
        if log_id2 in session_log_ids:
            score += 0.08
        log_rows.append(
            {
                "id": entry.id,
                "topicId": entry.topicId,
                "taskId": entry.taskId,
                "type": entry.type,
                "agentId": entry.agentId,
                "agentLabel": entry.agentLabel,
                "summary": _clip(_sanitize_log_text(entry.summary or ""), 140),
                "content": _clip(response_content, 320),
                "createdAt": entry.createdAt,
                "score": round(score, 6),
                "vectorScore": float(search_row.get("vectorScore") or 0.0),
                "bm25Score": float(search_row.get("bm25Score") or 0.0),
                "lexicalScore": float(search_row.get("lexicalScore") or 0.0),
                "rrfScore": float(search_row.get("rrfScore") or 0.0),
                "rerankScore": float(search_row.get("rerankScore") or 0.0),
                "bestChunk": best_chunk if isinstance(best_chunk, dict) else None,
                "noteCount": note_count,
                "noteWeight": round(note_weight, 6),
                "sessionBoosted": log_id2 in session_log_ids,
            }
        )
    log_rows.sort(
        key=lambda item: (
            float(item["score"]),
            item.get("createdAt") or "",
        ),
        reverse=True,
    )
    log_rows = log_rows[:effective_limit_logs]

    note_rows: list[dict[str, Any]] = []
    emitted_note_ids: set[str] = set()
    for item in log_rows:
        log_id3 = str(item.get("id") or "")
        for note in note_items_by_log.get(log_id3, [])[:3]:
            if note.id in emitted_note_ids:
                continue
            emitted_note_ids.add(note.id)
            note_content_preview = _sanitize_log_text(content_preview_by_log_id.get(str(note.id), ""))
            note_content = note_content_preview or _sanitize_log_text(note.summary or "")
            note_rows.append(
                {
                    "id": note.id,
                    "relatedLogId": note.relatedLogId,
                    "topicId": note.topicId,
                    "taskId": note.taskId,
                    "summary": _clip(_sanitize_log_text(note.summary or ""), 140),
                    "content": _clip(note_content, 280),
                    "createdAt": note.createdAt,
                }
            )
        if len(note_rows) >= 160:
            break

    return {
        "query": query,
        "mode": search_result.get("mode") or "lexical",
        "topics": topic_rows,
        "tasks": task_rows,
        "logs": log_rows,
        "notes": note_rows,
        "matchedTopicIds": [item["id"] for item in topic_rows],
        "matchedTaskIds": [item["id"] for item in task_rows],
        "matchedLogIds": [item["id"] for item in log_rows],
        "searchMeta": {
            "effectiveLimits": {
                "topics": int(effective_limit_topics),
                "tasks": int(effective_limit_tasks),
                "logs": int(effective_limit_logs),
            },
            "queryTokenCount": int(len(query_tokens)),
            "singleTokenQuery": bool(single_token_query),
            "requireSparseForPropagation": bool(require_sparse_for_propagation),
            "windowLogs": int(len(logs)),
            "allowDeepContentScan": bool(allow_deep_content_scan),
        },
    }


_CONTEXT_AFFIRMATIONS = {
    "yes",
    "y",
    "yep",
    "yeah",
    "ok",
    "okay",
    "sounds good",
    "do it",
    "please do",
    "go ahead",
    "ship it",
    "works for me",
}

_CONTEXT_META_TOKENS = {
    # Very common "filler" / continuity prompts that should not trigger expensive recall in auto mode.
    "a",
    "about",
    "again",
    "and",
    "any",
    "anything",
    "are",
    "can",
    "check",
    "continue",
    "could",
    "do",
    "feedback",
    "go",
    "hello",
    "help",
    "hey",
    "hi",
    "how",
    "i",
    "it",
    "lets",
    "let",
    "look",
    "me",
    "next",
    "no",
    "now",
    "of",
    "off",
    "ok",
    "okay",
    "on",
    "opinion",
    "or",
    "please",
    "pls",
    "pick",
    "resume",
    "review",
    "see",
    "ship",
    "should",
    "something",
    "sure",
    "steps",
    "tell",
    "thanks",
    "thx",
    "the",
    "then",
    "think",
    "this",
    "thoughts",
    "to",
    "up",
    "us",
    "we",
    "what",
    "where",
    "who",
    "why",
    "would",
    "yes",
    "you",
    "your",
}


def _normalize_for_signal(text: str) -> str:
    cleaned = _sanitize_log_text(text)
    cleaned = re.sub(r"[^a-zA-Z0-9\s]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().lower()
    return cleaned


def _is_affirmation(text: str) -> bool:
    cleaned = _normalize_for_signal(text)
    if not cleaned:
        return False
    if len(cleaned) > 24:
        return False
    if cleaned in _CONTEXT_AFFIRMATIONS:
        return True
    if cleaned.startswith("yes "):
        return cleaned[4:].strip() in _CONTEXT_AFFIRMATIONS
    if cleaned.startswith("ok "):
        return cleaned[3:].strip() in _CONTEXT_AFFIRMATIONS
    if cleaned.startswith("okay "):
        return cleaned[5:].strip() in _CONTEXT_AFFIRMATIONS
    return False


def _is_low_signal_context_query(text: str) -> bool:
    """Detect short, meta continuity prompts that shouldn't trigger expensive deep recall in auto mode."""
    cleaned = _normalize_for_signal(text)
    if not cleaned:
        return True
    # If the user actually provided detail, don't treat it as low-signal.
    if len(cleaned) >= 80:
        return False
    tokens = [tok for tok in cleaned.split(" ") if tok]
    if not tokens:
        return True
    # Examples:
    # - "do you think"
    # - "let's resume this"
    # - "continue"
    # - "thoughts / feedback"
    if len(tokens) <= 8 and all(tok in _CONTEXT_META_TOKENS for tok in tokens):
        return True
    return False


def _query_has_signal(text: str) -> bool:
    cleaned = _normalize_for_signal(text)
    if not cleaned:
        return False
    if len(cleaned) >= 6:
        return True
    tokens = cleaned.split(" ")
    if len(tokens) >= 2:
        return True
    return any(len(tok) >= 4 for tok in tokens)


def _parse_dt(value: str | None) -> datetime | None:
    normalized = normalize_iso(value)
    if not normalized:
        return None
    raw = normalized[:-1] + "+00:00" if normalized.endswith("Z") else normalized
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _is_snoozed(snoozed_until: str | None, now: datetime) -> bool:
    dt = _parse_dt(snoozed_until)
    if not dt:
        return False
    return dt > now


def _topic_visible(topic: Topic, now: datetime) -> bool:
    status = str(getattr(topic, "status", "active") or "active").strip().lower()
    if status == "archived":
        return False
    if _is_snoozed(getattr(topic, "snoozedUntil", None), now):
        return False
    return True


def _task_visible(task: Task, topic_by_id: dict[str, Topic], now: datetime) -> bool:
    if _is_snoozed(getattr(task, "snoozedUntil", None), now):
        return False
    topic_id = str(getattr(task, "topicId", None) or "").strip()
    if topic_id:
        parent = topic_by_id.get(topic_id)
        if parent and not _topic_visible(parent, now):
            return False
    return True


def _task_rank(task: Task, now: datetime) -> tuple:
    pinned = 0 if bool(getattr(task, "pinned", False)) else 1
    status = str(getattr(task, "status", "") or "").strip().lower()
    status_bucket = {"blocked": 0, "doing": 1, "todo": 2, "done": 4}.get(status, 3)
    priority = str(getattr(task, "priority", "medium") or "medium").strip().lower()
    priority_bucket = {"high": 0, "medium": 1, "low": 2}.get(priority, 1)
    due_dt = _parse_dt(getattr(task, "dueDate", None))
    overdue_bucket = 1
    due_bucket = 2
    if due_dt:
        if due_dt < now:
            overdue_bucket = 0
            due_bucket = 0
        elif due_dt < (now + timedelta(days=7)):
            due_bucket = 1
    updated = str(getattr(task, "updatedAt", "") or "")
    return (pinned, status_bucket, overdue_bucket, due_bucket, priority_bucket, updated)


@app.get("/api/context", response_model=ContextResponse, tags=["context"])
def context(
    q: str | None = Query(default=None, description="Current user input/query."),
    sessionKey: str | None = Query(default=None, description="Session key for continuity (source.sessionKey)."),
    spaceId: str | None = Query(default=None, description="Resolve visibility from this source space id."),
    allowedSpaceIds: str | None = Query(default=None, description="Explicit allowed space ids (comma-separated)."),
    mode: str = Query(default="auto", description="auto|cheap|full|patient"),
    includePending: bool = Query(default=True, description="Include pending logs in recall."),
    maxChars: int = Query(default=2200, ge=400, le=12000, description="Hard cap for returned block size."),
    workingSetLimit: int = Query(default=6, ge=0, le=40, description="Max tasks/topics in working set sections."),
    timelineLimit: int = Query(default=6, ge=0, le=40, description="Max session timeline lines."),
):
    """Return a prompt-ready, layered context block for agent runs (Layer A always; Layer B optional)."""
    raw_query = _sanitize_log_text(q or "")
    normalized_query = _clip(raw_query, 500)
    requested_mode = (mode or "auto").strip().lower()
    effective_mode = requested_mode if requested_mode in {"auto", "cheap", "full", "patient"} else "auto"

    low_signal = (
        _is_affirmation(normalized_query)
        or normalized_query.strip().startswith("/")
        or _is_low_signal_context_query(normalized_query)
    )
    if effective_mode in {"full", "patient"}:
        run_semantic = True
    elif effective_mode == "cheap":
        run_semantic = False
    else:
        run_semantic = (not low_signal) and _query_has_signal(normalized_query)

    now_dt = datetime.now(timezone.utc)
    data: dict[str, Any] = {}
    layers: list[str] = []
    lines: list[str] = []

    lines.append("Clawboard context (layered):")
    if normalized_query:
        lines.append(f"Current user intent: {_clip(normalized_query, 180)}")
    if effective_mode != "auto":
        lines.append(f"Mode: {effective_mode}")

    with get_session() as session:
        resolved_source_space_id = _resolve_source_space_id(
            session,
            explicit_space_id=spaceId,
            session_key=sessionKey,
        )
        allowed_space_ids = _resolve_allowed_space_ids(
            session,
            source_space_id=resolved_source_space_id,
            allowed_space_ids_raw=allowedSpaceIds,
        )

        routing_items: list[dict[str, Any]] = []
        if sessionKey:
            row = session.get(SessionRoutingMemory, sessionKey)
            if not row and "|" in sessionKey:
                row = session.get(SessionRoutingMemory, sessionKey.split("|", 1)[0])
            if row and isinstance(getattr(row, "items", None), list):
                routing_items = list(row.items or [])[-6:]
                data["routingMemory"] = row.model_dump()
                layers.append("A:routing_memory")

        timeline: list[dict[str, Any]] = []
        if sessionKey and timelineLimit > 0:
            base_key = (sessionKey.split("|", 1)[0] or "").strip()
            if base_key:
                query_logs = select(LogEntry).options(defer(LogEntry.raw))
                if DATABASE_URL.startswith("sqlite"):
                    query_logs = query_logs.where(
                        text(
                            "(json_extract(source, '$.sessionKey') = :base_key OR json_extract(source, '$.sessionKey') LIKE :like_key)"
                        )
                    ).params(base_key=base_key, like_key=f"{base_key}|%")
                else:
                    expr = LogEntry.source["sessionKey"].as_string()
                    query_logs = query_logs.where(or_(expr == base_key, expr.like(f"{base_key}|%")))
                query_logs = query_logs.where(LogEntry.type == "conversation").order_by(
                    LogEntry.createdAt.desc(),
                    (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
                ).limit(max(20, timelineLimit * 5))
                rows = session.exec(query_logs).all()
                if allowed_space_ids is not None:
                    topic_by_id_for_timeline, task_by_id_for_timeline = _load_related_maps_for_logs(session, rows)
                    rows = [
                        entry
                        for entry in rows
                        if _log_matches_allowed_spaces(
                            entry,
                            allowed_space_ids,
                            topic_by_id_for_timeline,
                            task_by_id_for_timeline,
                        )
                    ]
                for entry in rows:
                    if _is_command_log(entry):
                        continue
                    summary = _sanitize_log_text(entry.summary or "") or _clip(_sanitize_log_text(entry.content or ""), 220)
                    who = (
                        "User"
                        if str(entry.agentId or "").strip().lower() == "user"
                        else (entry.agentLabel or entry.agentId or "Agent")
                    )
                    timeline.append(
                        {
                            "id": entry.id,
                            "topicId": entry.topicId,
                            "taskId": entry.taskId,
                            "agentId": entry.agentId,
                            "agentLabel": entry.agentLabel,
                            "createdAt": entry.createdAt,
                            "text": _clip(f"{who}: {summary}", 160),
                        }
                    )
                    if len(timeline) >= timelineLimit:
                        break
                if timeline:
                    data["timeline"] = timeline
                    layers.append("A:timeline")

        all_topics = session.exec(select(Topic)).all()
        all_topic_by_id = {str(getattr(topic, "id", "") or ""): topic for topic in all_topics if getattr(topic, "id", None)}
        topics = (
            [topic for topic in all_topics if _topic_matches_allowed_spaces(topic, allowed_space_ids)]
            if allowed_space_ids is not None
            else all_topics
        )
        topic_by_id = {t.id: t for t in topics}
        all_tasks = session.exec(select(Task)).all()
        tasks = (
            [task for task in all_tasks if _task_matches_allowed_spaces(task, allowed_space_ids, all_topic_by_id)]
            if allowed_space_ids is not None
            else all_tasks
        )
        tasks_by_id = {t.id: t for t in tasks}

        visible_topics = [t for t in topics if _topic_visible(t, now_dt)]
        pinned_topics = [t for t in visible_topics if bool(getattr(t, "pinned", False))]
        pinned_topics.sort(key=lambda t: getattr(t, "sortIndex", 0))
        pinned_topics.sort(key=lambda t: t.updatedAt, reverse=True)

        visible_tasks = [t for t in tasks if _task_visible(t, topic_by_id, now_dt)]
        ranked_tasks = [
            t
            for t in visible_tasks
            if str(getattr(t, "status", "") or "").strip().lower() != "done" or bool(getattr(t, "pinned", False))
        ]
        ranked_tasks.sort(key=lambda t: _task_rank(t, now_dt))

        working_topics = pinned_topics[: max(0, min(12, workingSetLimit))]
        working_tasks = ranked_tasks[: max(0, min(18, workingSetLimit * 3))]

        # Board chat location: Clawboard Topic/Task chat sessions carry a stable sessionKey that
        # identifies the active Topic/Task. Always surface that entity first so the model knows
        # "where the user is speaking from" even on vague turns like "resume" or "thoughts?".
        board_topic_id, board_task_id = _parse_board_session_key(sessionKey or "")
        board_topic = topic_by_id.get(board_topic_id) if board_topic_id else None
        board_task = tasks_by_id.get(board_task_id) if board_task_id else None
        if board_task and board_task.topicId and not board_topic:
            board_topic = topic_by_id.get(board_task.topicId)

        if board_topic or board_task:
            data["boardSession"] = {
                "kind": "task" if board_task else "topic",
                "topicId": board_topic.id if board_topic else board_topic_id or None,
                "topicName": board_topic.name if board_topic else None,
                "taskId": board_task.id if board_task else board_task_id or None,
                "taskTitle": board_task.title if board_task else None,
            }
            layers.append("A:board_session")
            if board_task:
                status = str(getattr(board_task, "status", "") or "").strip()
                suffix = f" [{status}]" if status else ""
                topic_name = board_topic.name if board_topic else (board_topic_id or "Unknown topic")
                lines.append("Active board location:")
                lines.append(f"- Task Chat: {topic_name} -> {board_task.title}{suffix}")
            elif board_topic:
                lines.append("Active board location:")
                lines.append(f"- Topic Chat: {board_topic.name}")

            if board_topic:
                # Promote the active board entity to the top even if it would normally rank lower.
                working_topics = [board_topic, *[t for t in working_topics if t.id != board_topic.id]]
            if board_task:
                working_tasks = [board_task, *[t for t in working_tasks if t.id != board_task.id]]

        continuity_topic_ids: list[str] = []
        continuity_task_ids: list[str] = []
        for item in routing_items[-4:]:
            tid = str(item.get("topicId") or "").strip()
            if tid:
                continuity_topic_ids.append(tid)
            kid = str(item.get("taskId") or "").strip()
            if kid:
                continuity_task_ids.append(kid)
        for item in timeline[: max(0, min(12, timelineLimit * 2))]:
            tid = str(item.get("topicId") or "").strip()
            if tid:
                continuity_topic_ids.append(tid)
            kid = str(item.get("taskId") or "").strip()
            if kid:
                continuity_task_ids.append(kid)

        seen_topic_ids = {t.id for t in working_topics}
        for tid in continuity_topic_ids:
            if len(working_topics) >= max(0, min(12, workingSetLimit)):
                break
            t = topic_by_id.get(tid)
            if t and _topic_visible(t, now_dt) and tid not in seen_topic_ids:
                working_topics.append(t)
                seen_topic_ids.add(tid)

        seen_task_ids = {t.id for t in working_tasks}
        for kid in continuity_task_ids:
            if len(working_tasks) >= max(0, min(18, workingSetLimit * 3)):
                break
            t = tasks_by_id.get(kid)
            if t and _task_visible(t, topic_by_id, now_dt) and kid not in seen_task_ids:
                working_tasks.append(t)
                seen_task_ids.add(kid)

        data["workingSet"] = {
            "topics": [t.model_dump() for t in working_topics[:workingSetLimit]],
            "tasks": [t.model_dump() for t in working_tasks[:workingSetLimit]],
        }
        layers.append("A:working_set")

        if working_topics:
            lines.append("Working set topics:")
            for t in working_topics[:workingSetLimit]:
                digest = _sanitize_log_text(getattr(t, "digest", None))
                suffix = f" | digest: {_clip(digest, 140)}" if digest else ""
                lines.append(f"- {t.name}{suffix}")

        if working_tasks:
            lines.append("Working set tasks:")
            for t in working_tasks[:workingSetLimit]:
                status = str(getattr(t, "status", "") or "").strip()
                suffix = f" [{status}]" if status else ""
                extra: list[str] = []
                if getattr(t, "dueDate", None):
                    extra.append(f"due {str(getattr(t, 'dueDate'))}")
                digest = _sanitize_log_text(getattr(t, "digest", None))
                if digest:
                    extra.append(f"digest: {_clip(digest, 120)}")
                tail = f" ({'; '.join(extra)})" if extra else ""
                lines.append(f"- {t.title}{suffix}{tail}")

        if routing_items:
            lines.append("Session routing memory (newest last):")
            for item in routing_items[-4:]:
                topic_name = str(item.get("topicName") or item.get("topicId") or "").strip()
                task_title = str(item.get("taskTitle") or item.get("taskId") or "").strip()
                anchor = str(item.get("anchor") or "").strip()
                head = topic_name
                if task_title:
                    head = f"{head} -> {task_title}"
                if anchor:
                    lines.append(f"- {head} | anchor: {_clip(_sanitize_log_text(anchor), 120)}")
                else:
                    lines.append(f"- {head}")

        if timeline:
            lines.append("Recent session timeline:")
            for item in timeline[:timelineLimit]:
                lines.append(f"- {item['text']}")

        semantic = None
        if run_semantic and normalized_query:
            limit_topics = 8
            limit_tasks = 12
            limit_logs = max(24, timelineLimit * 6)
            if effective_mode == "patient":
                limit_topics = 12
                limit_tasks = 18
                limit_logs = max(60, timelineLimit * 10)
            semantic = _search_impl(
                session,
                normalized_query,
                topic_id=None,
                allowed_space_ids=allowed_space_ids,
                session_key=sessionKey,
                include_pending=includePending,
                limit_topics=limit_topics,
                limit_tasks=limit_tasks,
                limit_logs=limit_logs,
                allow_deep_content_scan=False,
            )
            data["semantic"] = semantic
            layers.append("B:semantic")

        if semantic:
            topics_hit_limit = 3
            tasks_hit_limit = 4
            logs_hit_limit = 6
            notes_hit_limit = 6
            if effective_mode == "patient":
                topics_hit_limit = 5
                tasks_hit_limit = 8
                logs_hit_limit = 12
                notes_hit_limit = 10

            topics_hit = list(semantic.get("topics") or [])[:topics_hit_limit]
            tasks_hit = list(semantic.get("tasks") or [])[:tasks_hit_limit]
            logs_hit = list(semantic.get("logs") or [])[:logs_hit_limit]
            notes_hit = list(semantic.get("notes") or [])[:notes_hit_limit]

            if topics_hit:
                lines.append("Semantic recall topics:")
                for item in topics_hit:
                    name = str(item.get("name") or item.get("id") or "").strip()
                    score = item.get("score")
                    lines.append(f"- {name} (score {score})")
            if tasks_hit:
                lines.append("Semantic recall tasks:")
                for item in tasks_hit:
                    title = str(item.get("title") or item.get("id") or "").strip()
                    status = str(item.get("status") or "").strip()
                    suffix = f" [{status}]" if status else ""
                    lines.append(f"- {title}{suffix}")
            if logs_hit:
                lines.append("Semantic recall logs:")
                for item in logs_hit:
                    who = (
                        "User"
                        if str(item.get("agentId") or "").strip().lower() == "user"
                        else (item.get("agentLabel") or item.get("agentId") or "Agent")
                    )
                    text2 = _sanitize_log_text(str(item.get("summary") or item.get("content") or ""))
                    lines.append(f"- {who}: {_clip(text2, 140)}")
            if notes_hit:
                lines.append("Curated notes:")
                for item in notes_hit:
                    note_text = _sanitize_log_text(str(item.get("summary") or item.get("content") or ""))
                    lines.append(f"- {_clip(note_text, 160)}")

    block = _clip("\n".join(lines).strip(), maxChars)
    return {
        "ok": True,
        "sessionKey": sessionKey,
        "q": normalized_query,
        "mode": effective_mode,
        "layers": layers,
        "block": block,
        "data": data,
    }


@app.get("/api/search", tags=["search"])
def search(
    q: str = Query(..., min_length=1, description="Natural language query."),
    topicId: str | None = Query(default=None, description="Restrict search to one topic ID."),
    sessionKey: str | None = Query(default=None, description="Session key continuity boost (source.sessionKey)."),
    spaceId: str | None = Query(default=None, description="Resolve visibility from this source space id."),
    allowedSpaceIds: str | None = Query(default=None, description="Explicit allowed space ids (comma-separated)."),
    includePending: bool = Query(default=True, description="Include pending logs in matching."),
    limitTopics: int = Query(default=24, ge=1, le=800, description="Max topic matches."),
    limitTasks: int = Query(default=48, ge=1, le=2000, description="Max task matches."),
    limitLogs: int = Query(default=360, ge=10, le=5000, description="Max log matches."),
):
    """Hybrid semantic + lexical search across topics, tasks, and logs."""
    query = (q or "").strip()
    started_at = time.perf_counter()
    if len(query) < 1:
        return {
            "query": "",
            "mode": "empty",
            "topics": [],
            "tasks": [],
            "logs": [],
            "notes": [],
            "matchedTopicIds": [],
            "matchedTaskIds": [],
            "matchedLogIds": [],
            "searchMeta": {
                "degraded": False,
                "gateAcquired": True,
                "gateWaitMs": 0.0,
                "durationMs": round((time.perf_counter() - started_at) * 1000.0, 2),
            },
        }

    wait_seconds = max(0.0, SEARCH_CONCURRENCY_WAIT_SECONDS)
    gate_wait_started = time.perf_counter()
    acquired = _SEARCH_QUERY_GATE.acquire(timeout=wait_seconds)
    gate_wait_ms = round((time.perf_counter() - gate_wait_started) * 1000.0, 2)
    degraded_busy_fallback = not acquired
    effective_limit_topics = int(limitTopics)
    effective_limit_tasks = int(limitTasks)
    effective_limit_logs = int(limitLogs)
    allow_deep_content_scan = True
    if degraded_busy_fallback:
        # If the deep-search gate is saturated, run a bounded degraded pass instead of
        # returning a hard 429. This preserves semantic ordering while avoiding UI fallback.
        effective_limit_topics = min(effective_limit_topics, max(1, SEARCH_BUSY_FALLBACK_LIMIT_TOPICS))
        effective_limit_tasks = min(effective_limit_tasks, max(1, SEARCH_BUSY_FALLBACK_LIMIT_TASKS))
        effective_limit_logs = min(effective_limit_logs, max(10, SEARCH_BUSY_FALLBACK_LIMIT_LOGS))
        allow_deep_content_scan = False
    try:
        with get_session() as session:
            resolved_source_space_id = _resolve_source_space_id(
                session,
                explicit_space_id=spaceId,
                session_key=sessionKey,
            )
            allowed_space_ids = _resolve_allowed_space_ids(
                session,
                source_space_id=resolved_source_space_id,
                allowed_space_ids_raw=allowedSpaceIds,
            )
            result = _search_impl(
                session,
                query,
                topic_id=topicId,
                allowed_space_ids=allowed_space_ids,
                session_key=sessionKey,
                include_pending=includePending,
                limit_topics=effective_limit_topics,
                limit_tasks=effective_limit_tasks,
                limit_logs=effective_limit_logs,
                allow_deep_content_scan=allow_deep_content_scan,
            )
            duration_ms = round((time.perf_counter() - started_at) * 1000.0, 2)
            meta = dict(result.get("searchMeta") or {})
            meta.update(
                {
                    "degraded": bool(degraded_busy_fallback),
                    "gateAcquired": bool(acquired),
                    "gateWaitMs": float(gate_wait_ms),
                    "durationMs": float(duration_ms),
                    "allowDeepContentScan": bool(allow_deep_content_scan),
                    "effectiveLimits": {
                        "topics": int(effective_limit_topics),
                        "tasks": int(effective_limit_tasks),
                        "logs": int(effective_limit_logs),
                    },
                }
            )
            enriched = dict(result)
            enriched["searchMeta"] = meta
            if degraded_busy_fallback:
                mode = str(enriched.get("mode") or "")
                enriched["mode"] = f"{mode}+busy-fallback" if mode else "busy-fallback"
                enriched["degraded"] = True
                return enriched
            return enriched
    finally:
        if acquired:
            _SEARCH_QUERY_GATE.release()


@app.post("/api/reindex", dependencies=[Depends(require_token)], tags=["classifier"])
def request_reindex(payload: ReindexRequest = Body(...)):
    """Queue a targeted embedding refresh request for classifier vector stores."""
    enqueue_reindex_request(payload.model_dump())
    return {"ok": True, "queued": True}


def _build_metrics_payload(session: Any) -> dict[str, Any]:
    total = int(session.exec(select(func.count()).select_from(LogEntry)).one() or 0)
    pending_count = int(
        session.exec(
            select(func.count()).select_from(LogEntry).where(LogEntry.classificationStatus == "pending")
        ).one()
        or 0
    )
    failed_count = int(
        session.exec(
            select(func.count()).select_from(LogEntry).where(LogEntry.classificationStatus == "failed")
        ).one()
        or 0
    )
    classified_count = max(0, total - pending_count - failed_count)
    newest = session.exec(select(func.max(LogEntry.createdAt))).one()
    oldest_pending = session.exec(
        select(func.min(LogEntry.createdAt)).where(LogEntry.classificationStatus == "pending")
    ).one()

    topics_total = int(session.exec(select(func.count()).select_from(Topic)).one() or 0)
    tasks_total = int(session.exec(select(func.count()).select_from(Task)).one() or 0)

    cutoff_dt = datetime.now(timezone.utc) - timedelta(hours=24)
    cutoff_iso = cutoff_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    topics_created_24h = int(session.exec(select(func.count()).select_from(Topic).where(Topic.createdAt >= cutoff_iso)).one() or 0)
    tasks_created_24h = int(session.exec(select(func.count()).select_from(Task).where(Task.createdAt >= cutoff_iso)).one() or 0)

    gate = {
        "topics": {"allowedTotal": 0, "blockedTotal": 0, "allowed24h": 0, "blocked24h": 0},
        "tasks": {"allowedTotal": 0, "blockedTotal": 0, "allowed24h": 0, "blocked24h": 0},
    }
    audit_path = _creation_audit_path()

    def parse_iso(value: str | None) -> datetime | None:
        if not value:
            return None
        raw = str(value).strip()
        if not raw:
            return None
        try:
            if raw.endswith("Z"):
                raw = raw[:-1] + "+00:00"
            ts = datetime.fromisoformat(raw)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            return ts.astimezone(timezone.utc)
        except Exception:
            return None

    cutoff_ts = cutoff_dt.timestamp()
    try:
        if audit_path and os.path.exists(audit_path):
            with open(audit_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except Exception:
                        continue
                    kind = str(item.get("kind") or "").lower()
                    decision = str(item.get("decision") or "").lower()
                    if kind not in ("topic", "task"):
                        continue
                    bucket = gate["topics" if kind == "topic" else "tasks"]
                    is_allowed = decision == "allow"
                    if is_allowed:
                        bucket["allowedTotal"] += 1
                    else:
                        bucket["blockedTotal"] += 1
                    ts = parse_iso(item.get("ts"))
                    if ts and ts.timestamp() >= cutoff_ts:
                        if is_allowed:
                            bucket["allowed24h"] += 1
                        else:
                            bucket["blocked24h"] += 1
    except Exception:
        pass

    return {
        "logs": {
            "total": total,
            "pending": pending_count,
            "classified": classified_count,
            "failed": failed_count,
            "newestCreatedAt": newest,
            "oldestPendingAt": oldest_pending,
        },
        "creation": {
            "topics": {"total": topics_total, "created24h": topics_created_24h},
            "tasks": {"total": tasks_total, "created24h": tasks_created_24h},
            "gate": gate,
        },
    }


@app.get("/api/metrics", tags=["metrics"])
def metrics():
    """Operational metrics for ingestion + classifier lag."""
    with get_session() as session:
        revision = _metrics_revision_token(session)
        payload, _cached = _get_or_build_precompiled(
            namespace="metrics",
            key_parts=["default"],
            revision=revision,
            build_fn=lambda: _build_metrics_payload(session),
        )
        return payload
