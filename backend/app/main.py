from __future__ import annotations

import os
import json
import hashlib
import colorsys
import asyncio
import threading
import time
import re
from difflib import SequenceMatcher
from datetime import datetime, timezone
from fastapi import Request
from uuid import uuid4
from fastapi import FastAPI, Depends, Query, Body, HTTPException, Header
from fastapi.responses import JSONResponse, StreamingResponse
from typing import List, Any
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from .auth import ensure_read_access, ensure_write_access, is_token_configured, is_token_required, require_token
from .db import init_db, get_session
from .models import InstanceConfig, Topic, Task, LogEntry, IngestQueue
from .schemas import (
    InstanceUpdate,
    InstanceResponse,
    InstanceOut,
    TopicUpsert,
    TopicOut,
    TaskUpsert,
    TaskOut,
    LogAppend,
    LogOut,
    LogPatch,
    ChangesResponse,
    ClawgraphResponse,
    ReindexRequest,
)
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
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

    provided_token = request.headers.get("x-clawboard-token") or request.query_params.get("token")
    try:
        if method in {"GET", "HEAD"}:
            ensure_read_access(request, provided_token)
        else:
            ensure_write_access(provided_token)
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    return await call_next(request)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_id(prefix: str) -> str:
    return f"{prefix}-{uuid4()}"


REINDEX_QUEUE_PATH = os.getenv("CLAWBOARD_REINDEX_QUEUE_PATH", "./data/reindex-queue.jsonl")


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


def _clip(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def _log_reindex_text(entry: LogEntry) -> str:
    parts = [
        _sanitize_log_text(entry.summary or ""),
        _sanitize_log_text(entry.content or ""),
        _sanitize_log_text(entry.raw or ""),
    ]
    text = " ".join(part for part in parts if part)
    return _clip(text, 1200)


def _enqueue_log_reindex(entry: LogEntry) -> None:
    text = _log_reindex_text(entry)
    if not text:
        return
    enqueue_reindex_request({"kind": "log", "id": entry.id, "text": text, "topicId": entry.topicId})


def _log_matches_session(entry: LogEntry, session_key: str) -> bool:
    source = getattr(entry, "source", None)
    if not isinstance(source, dict):
        return False
    return str(source.get("sessionKey") or "") == session_key


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


def _find_similar_topic(session, name: str, threshold: float = 0.80):
    if not name.strip():
        return None
    topics = session.exec(select(Topic)).all()
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


def _find_similar_task(session, topic_id: str | None, title: str, threshold: float = 0.88):
    if not title.strip():
        return None
    tasks = session.exec(select(Task)).all()
    if topic_id is not None:
        tasks = [task for task in tasks if task.topicId == topic_id]
    else:
        tasks = [task for task in tasks if task.topicId is None]
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


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    if os.getenv("CLAWBOARD_INGEST_MODE", "").lower() == "queue":
        thread = threading.Thread(target=_queue_worker, daemon=True)
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
    timestamp = payload.createdAt or now_iso()

    if idempotency_key:
        existing = _find_by_idempotency(session, idempotency_key)
        if existing:
            return existing

    # Idempotency guard: if the source messageId is present, avoid duplicating
    # logs when the logger retries / replays its queue.
    if payload.source and isinstance(payload.source, dict):
        msg_id = payload.source.get("messageId")
        if msg_id and payload.type == "conversation":
            existing = session.exec(select(LogEntry).where(LogEntry.type == payload.type)).all()
            for entry in existing:
                src = getattr(entry, "source", None) or {}
                if not isinstance(src, dict):
                    continue
                if src.get("messageId") != msg_id:
                    continue
                if entry.type != payload.type:
                    continue
                if (entry.agentId or None) != (payload.agentId or None):
                    continue
                return entry

    topic_id = payload.topicId
    task_id = payload.taskId

    if topic_id:
        exists = session.get(Topic, topic_id)
        if not exists:
            topic_id = None

    if task_id:
        exists = session.get(Task, task_id)
        if not exists:
            task_id = None

    entry = LogEntry(
        id=create_id("log"),
        topicId=topic_id,
        taskId=task_id,
        relatedLogId=payload.relatedLogId,
        idempotencyKey=idempotency_key,
        type=payload.type,
        content=payload.content,
        summary=payload.summary,
        raw=payload.raw,
        createdAt=timestamp,
        updatedAt=timestamp,
        agentId=payload.agentId,
        agentLabel=payload.agentLabel,
        source=payload.source,
        classificationStatus=payload.classificationStatus or "pending",
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
    session.refresh(entry)
    event_hub.publish({"type": "log.appended", "data": entry.model_dump(), "eventTs": entry.updatedAt})
    _enqueue_log_reindex(entry)
    return entry


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
                    yield ": ping\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            event_hub.unsubscribe(subscriber)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
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


@app.get("/api/topics", response_model=List[TopicOut], tags=["topics"])
def list_topics():
    """List topics (pinned first, newest activity first)."""
    with get_session() as session:
        topics = session.exec(select(Topic)).all()
        # Most recently updated first, then pinned first
        topics.sort(key=lambda t: t.updatedAt, reverse=True)
        topics.sort(key=lambda t: not bool(t.pinned))
        return topics


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
    )
):
    """Create or update a topic."""
    with get_session() as session:
        topic = session.get(Topic, payload.id) if payload.id else None
        timestamp = now_iso()
        if topic:
            topic.name = payload.name or topic.name
            if payload.color is not None:
                normalized_color = _normalize_hex_color(payload.color)
                if normalized_color:
                    topic.color = normalized_color
            if payload.description is not None:
                topic.description = payload.description
            if payload.priority is not None:
                topic.priority = payload.priority
            if payload.status is not None:
                topic.status = payload.status
            if payload.tags is not None:
                topic.tags = payload.tags
            if payload.parentId is not None:
                topic.parentId = payload.parentId
            if payload.pinned is not None:
                topic.pinned = payload.pinned
            topic.updatedAt = timestamp
        else:
            duplicate = _find_similar_topic(session, payload.name)
            if duplicate:
                if payload.color is not None:
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
                if payload.description is not None and not duplicate.description:
                    duplicate.description = payload.description
                if payload.tags:
                    merged = list(dict.fromkeys([*(duplicate.tags or []), *payload.tags]))
                    duplicate.tags = merged
                if payload.priority is not None:
                    duplicate.priority = payload.priority
                if payload.status is not None:
                    duplicate.status = payload.status
                if payload.pinned is not None:
                    duplicate.pinned = payload.pinned
                duplicate.updatedAt = timestamp
                session.add(duplicate)
                session.commit()
                session.refresh(duplicate)
                event_hub.publish({"type": "topic.upserted", "data": duplicate.model_dump(), "eventTs": duplicate.updatedAt})
                enqueue_reindex_request({"kind": "topic", "id": duplicate.id, "text": duplicate.name})
                return duplicate
            used_colors = {
                _normalize_hex_color(getattr(item, "color", None))
                for item in session.exec(select(Topic)).all()
                if _normalize_hex_color(getattr(item, "color", None))
            }
            resolved_color = _normalize_hex_color(payload.color)
            if not resolved_color:
                resolved_color = _auto_pick_color(f"topic:{payload.id or ''}:{payload.name}", used_colors, 0.0)
            topic = Topic(
                id=payload.id or create_id("topic"),
                name=payload.name,
                color=resolved_color,
                description=payload.description,
                priority=payload.priority or "medium",
                status=payload.status or "active",
                tags=payload.tags or [],
                parentId=payload.parentId,
                pinned=payload.pinned or False,
                createdAt=timestamp,
                updatedAt=timestamp,
            )
        session.add(topic)
        session.commit()
        session.refresh(topic)
        event_hub.publish({"type": "topic.upserted", "data": topic.model_dump(), "eventTs": topic.updatedAt})
        enqueue_reindex_request({"kind": "topic", "id": topic.id, "text": topic.name})
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

        for task in tasks:
            event_hub.publish({"type": "task.upserted", "data": task.model_dump(), "eventTs": task.updatedAt})
        for entry in logs:
            event_hub.publish({"type": "log.patched", "data": entry.model_dump(), "eventTs": entry.updatedAt})
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
    )
):
    """List tasks (pinned first, newest activity first)."""
    with get_session() as session:
        tasks = session.exec(select(Task)).all()
        if topicId:
            tasks = [t for t in tasks if t.topicId == topicId]
        tasks.sort(key=lambda t: t.updatedAt, reverse=True)
        tasks.sort(key=lambda t: not bool(t.pinned))
        return tasks


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
        task = session.get(Task, payload.id) if payload.id else None
        timestamp = now_iso()
        if task:
            task.title = payload.title or task.title
            if payload.color is not None:
                normalized_color = _normalize_hex_color(payload.color)
                if normalized_color:
                    task.color = normalized_color
            if payload.topicId is not None:
                task.topicId = payload.topicId
            if payload.status is not None:
                task.status = payload.status
            if payload.priority is not None:
                task.priority = payload.priority
            if payload.dueDate is not None:
                task.dueDate = payload.dueDate
            if payload.pinned is not None:
                task.pinned = payload.pinned
            task.updatedAt = timestamp
        else:
            duplicate = _find_similar_task(session, payload.topicId, payload.title)
            if duplicate:
                if payload.color is not None:
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
                if payload.status is not None:
                    duplicate.status = payload.status
                if payload.priority is not None:
                    duplicate.priority = payload.priority
                if payload.dueDate is not None:
                    duplicate.dueDate = payload.dueDate
                if payload.pinned is not None:
                    duplicate.pinned = payload.pinned
                duplicate.updatedAt = timestamp
                session.add(duplicate)
                session.commit()
                session.refresh(duplicate)
                event_hub.publish({"type": "task.upserted", "data": duplicate.model_dump(), "eventTs": duplicate.updatedAt})
                enqueue_reindex_request(
                    {"kind": "task", "id": duplicate.id, "topicId": duplicate.topicId, "text": duplicate.title}
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
            task = Task(
                id=payload.id or create_id("task"),
                topicId=payload.topicId,
                title=payload.title,
                color=resolved_color,
                status=payload.status or "todo",
                pinned=payload.pinned or False,
                priority=payload.priority or "medium",
                dueDate=payload.dueDate,
                createdAt=timestamp,
                updatedAt=timestamp,
            )
        session.add(task)
        session.commit()
        session.refresh(task)
        event_hub.publish({"type": "task.upserted", "data": task.model_dump(), "eventTs": task.updatedAt})
        enqueue_reindex_request({"kind": "task", "id": task.id, "topicId": task.topicId, "text": task.title})
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

        for entry in logs:
            event_hub.publish({"type": "log.patched", "data": entry.model_dump(), "eventTs": entry.updatedAt})
        event_hub.publish({"type": "task.deleted", "data": {"id": task_id}, "eventTs": detached_at})

        return {
            "ok": True,
            "deleted": True,
            "id": task_id,
            "detachedLogs": len(logs),
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
    limit: int = Query(default=200, ge=1, le=1000, description="Max results.", example=200),
    offset: int = Query(default=0, ge=0, description="Offset for pagination.", example=0),
):
    """List timeline entries (newest first)."""
    with get_session() as session:
        logs = session.exec(select(LogEntry)).all()
        if topicId:
            logs = [l for l in logs if l.topicId == topicId]
        if taskId:
            logs = [l for l in logs if l.taskId == taskId]
        if relatedLogId:
            related_ids = {rid.strip() for rid in relatedLogId.split(",") if rid.strip()}
            logs = [l for l in logs if getattr(l, "relatedLogId", None) in related_ids]
        if sessionKey:
            logs = [
                l
                for l in logs
                if isinstance(getattr(l, "source", None), dict)
                and (l.source or {}).get("sessionKey") == sessionKey
            ]
        if type:
            logs = [l for l in logs if l.type == type]
        if classificationStatus:
            logs = [l for l in logs if getattr(l, "classificationStatus", "pending") == classificationStatus]
        logs = sorted(logs, key=lambda l: l.createdAt, reverse=True)
        return logs[offset : offset + limit]


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

        if "topicId" in fields:
            entry.topicId = payload.topicId
        if "taskId" in fields:
            entry.taskId = payload.taskId
        if "relatedLogId" in fields:
            entry.relatedLogId = payload.relatedLogId
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

        entry.updatedAt = now_iso()

        session.add(entry)
        session.commit()
        session.refresh(entry)
        event_hub.publish({"type": "log.patched", "data": entry.model_dump(), "eventTs": entry.updatedAt})
        _enqueue_log_reindex(entry)
        return entry


@app.delete("/api/log/{log_id}", dependencies=[Depends(require_token)], tags=["logs"])
def delete_log(log_id: str):
    """Delete a log entry and its attached note rows."""
    with get_session() as session:
        rows = session.exec(select(LogEntry)).all()
        to_delete = [row for row in rows if row.id == log_id or row.relatedLogId == log_id]
        if not to_delete:
            return {"ok": True, "deleted": False, "deletedIds": []}
        deleted_ids = [row.id for row in to_delete]
        for row in to_delete:
            session.delete(row)
        session.commit()
        event_ts = now_iso()
        for deleted_id in deleted_ids:
            event_hub.publish({"type": "log.deleted", "data": {"id": deleted_id, "rootId": log_id}, "eventTs": event_ts})
        return {"ok": True, "deleted": True, "deletedIds": deleted_ids}


@app.get("/api/changes", response_model=ChangesResponse, tags=["changes"])
def list_changes(
    since: str | None = Query(
        default=None,
        description="Return items updated/created at or after this ISO timestamp.",
        example="2026-02-02T10:05:00.000Z",
    )
):
    """Return topics/tasks/logs changed since timestamp (ISO)."""
    with get_session() as session:
        if not since:
            topics = session.exec(select(Topic)).all()
            tasks = session.exec(select(Task)).all()
            logs = session.exec(select(LogEntry)).all()
        else:
            topics = session.exec(select(Topic).where(Topic.updatedAt >= since)).all()
            tasks = session.exec(select(Task).where(Task.updatedAt >= since)).all()
            logs = session.exec(select(LogEntry).where(LogEntry.updatedAt >= since)).all()

        topics.sort(key=lambda t: t.updatedAt, reverse=True)
        tasks.sort(key=lambda t: t.updatedAt, reverse=True)
        logs.sort(key=lambda l: l.createdAt, reverse=True)
        return {"topics": topics, "tasks": tasks, "logs": logs}


@app.get("/api/clawgraph", response_model=ClawgraphResponse, tags=["clawgraph"])
def clawgraph(
    maxEntities: int = Query(default=120, ge=20, le=400, description="Maximum number of entity nodes."),
    maxNodes: int = Query(default=260, ge=40, le=800, description="Maximum total nodes."),
    minEdgeWeight: float = Query(default=0.16, ge=0.0, le=2.0, description="Edge weight threshold."),
    limitLogs: int = Query(default=2400, ge=100, le=20000, description="Recent log window used for graph build."),
    includePending: bool = Query(default=True, description="Include pending logs in graph extraction."),
):
    """Build and return an entity-relationship graph from topics/tasks/logs."""
    with get_session() as session:
        topics = session.exec(select(Topic)).all()
        tasks = session.exec(select(Task)).all()
        logs = session.exec(select(LogEntry)).all()
        logs.sort(key=lambda l: l.createdAt, reverse=True)
        if not includePending:
            logs = [entry for entry in logs if (entry.classificationStatus or "pending") == "classified"]
        logs = logs[:limitLogs]

        graph = build_clawgraph(
            topics,
            tasks,
            logs,
            max_entities=maxEntities,
            max_nodes=maxNodes,
            min_edge_weight=minEdgeWeight,
        )
        graph["generatedAt"] = now_iso()
        return graph


@app.get("/api/search", tags=["search"])
def search(
    q: str = Query(..., min_length=1, description="Natural language query."),
    topicId: str | None = Query(default=None, description="Restrict search to one topic ID."),
    sessionKey: str | None = Query(default=None, description="Session key continuity boost (source.sessionKey)."),
    includePending: bool = Query(default=True, description="Include pending logs in matching."),
    limitTopics: int = Query(default=24, ge=1, le=800, description="Max topic matches."),
    limitTasks: int = Query(default=48, ge=1, le=2000, description="Max task matches."),
    limitLogs: int = Query(default=360, ge=10, le=5000, description="Max log matches."),
):
    """Hybrid semantic + lexical search across topics, tasks, and logs."""
    query = (q or "").strip()
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
        }

    with get_session() as session:
        topics = session.exec(select(Topic)).all()
        tasks = session.exec(select(Task)).all()
        logs = session.exec(select(LogEntry)).all()

        if topicId:
            tasks = [task for task in tasks if task.topicId == topicId]
            logs = [entry for entry in logs if entry.topicId == topicId]

        if not includePending:
            logs = [entry for entry in logs if (entry.classificationStatus or "pending") == "classified"]

        logs.sort(key=lambda entry: entry.createdAt, reverse=True)

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
        if sessionKey:
            for entry in logs:
                if not _log_matches_session(entry, sessionKey):
                    continue
                session_log_ids.add(entry.id)
                if entry.topicId:
                    session_topic_ids.add(entry.topicId)
                if entry.taskId:
                    session_task_ids.add(entry.taskId)

        search_result = semantic_search(
            query,
            [item.model_dump() for item in topics],
            [item.model_dump() for item in tasks],
            [item.model_dump() for item in logs],
            topic_limit=limitTopics,
            task_limit=limitTasks,
            log_limit=limitLogs,
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

        # Parent propagation from matched logs.
        for log_id, score in log_base_score.items():
            entry = log_map.get(log_id)
            if not entry:
                continue
            if entry.topicId:
                boosted = topic_base_score.get(entry.topicId, 0.0) + min(0.18, score * 0.22)
                topic_base_score[entry.topicId] = boosted
            if entry.taskId:
                boosted = task_base_score.get(entry.taskId, 0.0) + min(0.2, score * 0.25)
                task_base_score[entry.taskId] = boosted

        topic_rows: list[dict[str, Any]] = []
        for topic_id, base_score in topic_base_score.items():
            topic = topic_map.get(topic_id)
            if not topic:
                continue
            score = base_score
            score += min(0.26, note_weight_by_topic.get(topic_id, 0.0))
            if topic_id in session_topic_ids:
                score += 0.12
            topic_rows.append(
                {
                    "id": topic.id,
                    "name": topic.name,
                    "description": topic.description,
                    "score": round(score, 6),
                    "vectorScore": float((topic_search_rows.get(topic_id) or {}).get("vectorScore") or 0.0),
                    "bm25Score": float((topic_search_rows.get(topic_id) or {}).get("bm25Score") or 0.0),
                    "lexicalScore": float((topic_search_rows.get(topic_id) or {}).get("lexicalScore") or 0.0),
                    "rrfScore": float((topic_search_rows.get(topic_id) or {}).get("rrfScore") or 0.0),
                    "rerankScore": float((topic_search_rows.get(topic_id) or {}).get("rerankScore") or 0.0),
                    "bestChunk": (topic_search_rows.get(topic_id) or {}).get("bestChunk"),
                    "noteWeight": round(min(0.26, note_weight_by_topic.get(topic_id, 0.0)), 6),
                    "sessionBoosted": topic_id in session_topic_ids,
                }
            )
        topic_rows.sort(key=lambda item: float(item["score"]), reverse=True)
        topic_rows = topic_rows[:limitTopics]

        task_rows: list[dict[str, Any]] = []
        for task_id, base_score in task_base_score.items():
            task = task_map.get(task_id)
            if not task:
                continue
            score = base_score
            score += min(0.26, note_weight_by_task.get(task_id, 0.0))
            if task_id in session_task_ids:
                score += 0.1
            task_rows.append(
                {
                    "id": task.id,
                    "topicId": task.topicId,
                    "title": task.title,
                    "status": task.status,
                    "score": round(score, 6),
                    "vectorScore": float((task_search_rows.get(task_id) or {}).get("vectorScore") or 0.0),
                    "bm25Score": float((task_search_rows.get(task_id) or {}).get("bm25Score") or 0.0),
                    "lexicalScore": float((task_search_rows.get(task_id) or {}).get("lexicalScore") or 0.0),
                    "rrfScore": float((task_search_rows.get(task_id) or {}).get("rrfScore") or 0.0),
                    "rerankScore": float((task_search_rows.get(task_id) or {}).get("rerankScore") or 0.0),
                    "bestChunk": (task_search_rows.get(task_id) or {}).get("bestChunk"),
                    "noteWeight": round(min(0.26, note_weight_by_task.get(task_id, 0.0)), 6),
                    "sessionBoosted": task_id in session_task_ids,
                }
            )
        task_rows.sort(key=lambda item: float(item["score"]), reverse=True)
        task_rows = task_rows[:limitTasks]

        log_rows: list[dict[str, Any]] = []
        for log_id, base_score in log_base_score.items():
            entry = log_map.get(log_id)
            if not entry:
                continue
            score = base_score
            note_count = int(note_count_by_log.get(log_id) or 0)
            note_weight = min(0.24, 0.06 * note_count)
            score += note_weight
            if log_id in session_log_ids:
                score += 0.08
            log_rows.append(
                {
                    "id": entry.id,
                    "topicId": entry.topicId,
                    "taskId": entry.taskId,
                    "type": entry.type,
                    "agentId": entry.agentId,
                    "agentLabel": entry.agentLabel,
                    "summary": _clip(_sanitize_log_text(entry.summary or entry.content or ""), 140),
                    "content": _clip(_sanitize_log_text(entry.content or ""), 320),
                    "createdAt": entry.createdAt,
                    "score": round(score, 6),
                    "vectorScore": float((log_search_rows.get(log_id) or {}).get("vectorScore") or 0.0),
                    "bm25Score": float((log_search_rows.get(log_id) or {}).get("bm25Score") or 0.0),
                    "lexicalScore": float((log_search_rows.get(log_id) or {}).get("lexicalScore") or 0.0),
                    "rrfScore": float((log_search_rows.get(log_id) or {}).get("rrfScore") or 0.0),
                    "rerankScore": float((log_search_rows.get(log_id) or {}).get("rerankScore") or 0.0),
                    "bestChunk": (log_search_rows.get(log_id) or {}).get("bestChunk"),
                    "noteCount": note_count,
                    "noteWeight": round(note_weight, 6),
                    "sessionBoosted": log_id in session_log_ids,
                }
            )
        log_rows.sort(
            key=lambda item: (
                float(item["score"]),
                item.get("createdAt") or "",
            ),
            reverse=True,
        )
        log_rows = log_rows[:limitLogs]

        note_rows: list[dict[str, Any]] = []
        emitted_note_ids: set[str] = set()
        for item in log_rows:
            log_id = str(item.get("id") or "")
            for note in note_items_by_log.get(log_id, [])[:3]:
                if note.id in emitted_note_ids:
                    continue
                emitted_note_ids.add(note.id)
                note_rows.append(
                    {
                        "id": note.id,
                        "relatedLogId": note.relatedLogId,
                        "topicId": note.topicId,
                        "taskId": note.taskId,
                        "summary": _clip(_sanitize_log_text(note.summary or note.content or ""), 140),
                        "content": _clip(_sanitize_log_text(note.content or ""), 280),
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
        }


@app.post("/api/reindex", dependencies=[Depends(require_token)], tags=["classifier"])
def request_reindex(payload: ReindexRequest = Body(...)):
    """Queue a targeted embedding refresh request for classifier vector stores."""
    enqueue_reindex_request(payload.model_dump())
    return {"ok": True, "queued": True}


@app.get("/api/metrics", tags=["metrics"])
def metrics():
    """Operational metrics for ingestion + classifier lag."""
    with get_session() as session:
        logs = session.exec(select(LogEntry)).all()
        total = len(logs)
        pending = [l for l in logs if (l.classificationStatus or "pending") == "pending"]
        failed = [l for l in logs if (l.classificationStatus or "pending") == "failed"]
        classified = total - len(pending) - len(failed)
        newest = max((l.createdAt for l in logs), default=None)
        oldest_pending = min((l.createdAt for l in pending), default=None)
        return {
            "logs": {
                "total": total,
                "pending": len(pending),
                "classified": classified,
                "failed": len(failed),
                "newestCreatedAt": newest,
                "oldestPendingAt": oldest_pending,
            }
        }
