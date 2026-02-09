from __future__ import annotations

import os
import json
import hashlib
import colorsys
import asyncio
import threading
import time
import re
import urllib.request
import urllib.error
from difflib import SequenceMatcher
from datetime import datetime, timezone
from fastapi import Request
from uuid import uuid4
from fastapi import FastAPI, Depends, Query, Body, HTTPException, Header, BackgroundTasks
from fastapi.responses import JSONResponse, StreamingResponse
from typing import List, Any
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import defer
from sqlmodel import select

from .auth import ensure_read_access, ensure_write_access, is_token_configured, is_token_required, require_token
from .db import DATABASE_URL, init_db, get_session
from .models import InstanceConfig, Topic, Task, LogEntry, IngestQueue
from .schemas import (
    StartFreshReplayRequest,
    InstanceUpdate,
    InstanceResponse,
    InstanceOut,
    TopicUpsert,
    TopicOut,
    TopicReorderRequest,
    TaskUpsert,
    TaskOut,
    TaskReorderRequest,
    LogAppend,
    LogOut,
    LogOutLite,
    LogPatch,
    ChangesResponse,
    ClawgraphResponse,
    OpenClawChatRequest,
    OpenClawChatQueuedResponse,
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


def create_id(prefix: str) -> str:
    return f"{prefix}-{uuid4()}"


REINDEX_QUEUE_PATH = os.getenv("CLAWBOARD_REINDEX_QUEUE_PATH", "./data/reindex-queue.jsonl")
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


def _log_reindex_text(entry: LogEntry) -> str:
    log_type = str(getattr(entry, "type", "") or "")
    if log_type in ("system", "import"):
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


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    if os.getenv("CLAWBOARD_INGEST_MODE", "").lower() == "queue":
        thread = threading.Thread(target=_queue_worker, daemon=True)
        thread.start()
    if os.getenv("CLAWBOARD_DISABLE_SNOOZE_WORKER", "").strip() != "1":
        thread = threading.Thread(target=_snooze_worker, daemon=True)
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
                    if (topic.status or "active") == "paused":
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
    # NOTE: When an idempotency key is present (header or payload), the unique index on
    # LogEntry.idempotencyKey is the canonical dedupe mechanism. The source.messageId
    # fallback is only needed for legacy senders that omit idempotency keys.
    if not idempotency_key and payload.source and isinstance(payload.source, dict):
        msg_id = payload.source.get("messageId")
        if msg_id and payload.type == "conversation":
            msg_id_text = str(msg_id).strip()
            if msg_id_text:
                channel = payload.source.get("channel")
                channel_text = str(channel).strip().lower() if channel else ""
                agent_id = (payload.agentId or "").strip()

                query = select(LogEntry).where(LogEntry.type == payload.type)
                if agent_id:
                    query = query.where(LogEntry.agentId == agent_id)

                if DATABASE_URL.startswith("sqlite"):
                    query = query.where(text("json_extract(source, '$.messageId') = :msg_id")).params(msg_id=msg_id_text)
                    if channel_text:
                        query = query.where(text("json_extract(source, '$.channel') = :channel")).params(
                            channel=channel_text
                        )
                else:
                    query = query.where(LogEntry.source["messageId"].as_string() == msg_id_text)
                    if channel_text:
                        query = query.where(LogEntry.source["channel"].as_string() == channel_text)

                existing = session.exec(query).first()
                if existing:
                    return existing

    topic_id = payload.topicId
    task_id = payload.taskId

    task_row = None
    if task_id:
        task_row = session.get(Task, task_id)
        if not task_row:
            task_id = None
            task_row = None

    if topic_id:
        exists = session.get(Topic, topic_id)
        if not exists:
            topic_id = None

    # Enforce valid topic/task combinations at ingest time: a task implies its topic.
    # This prevents "impossible" UI states where a log references a task from a different topic.
    if task_row:
        topic_id = task_row.topicId

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
        createdAt=created_at,
        updatedAt=updated_at,
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
    # raw payloads can be large; keep log events lightweight for SSE + in-memory buffer safety.
    event_hub.publish({"type": "log.appended", "data": entry.model_dump(exclude={"raw"}), "eventTs": entry.updatedAt})
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
    key = (session_key or "").strip()
    if key.startswith(BOARD_TOPIC_SESSION_PREFIX):
        topic_id = key[len(BOARD_TOPIC_SESSION_PREFIX) :].strip()
        return (topic_id or None, None)
    if key.startswith(BOARD_TASK_SESSION_PREFIX):
        rest = key[len(BOARD_TASK_SESSION_PREFIX) :].strip()
        if not rest:
            return (None, None)
        parts = rest.split(":", 1)
        if len(parts) != 2:
            return (None, None)
        topic_id = parts[0].strip()
        task_id = parts[1].strip()
        return (topic_id or None, task_id or None)
    return (None, None)


def _run_openclaw_chat(request_id: str, *, base_url: str, token: str, session_key: str, agent_id: str, message: str) -> None:
    url = f"{base_url.rstrip('/')}/v1/chat/completions"
    timeout_seconds_raw = os.getenv("OPENCLAW_CHAT_TIMEOUT_SECONDS", "120").strip()
    try:
        timeout_seconds = float(timeout_seconds_raw)
        timeout_seconds = max(5.0, min(600.0, timeout_seconds))
    except Exception:
        timeout_seconds = 120.0

    body = {
        "model": "openclaw",
        "messages": [{"role": "user", "content": message}],
    }
    data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-openclaw-agent-id": agent_id,
            "x-openclaw-session-key": session_key,
        },
    )

    try:
        event_hub.publish(
            {
                "type": "openclaw.typing",
                "data": {"sessionKey": session_key, "requestId": request_id, "typing": True},
                "eventTs": now_iso(),
            }
        )
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            # We don't need the response body; OpenClaw logs the conversation via plugins.
            resp.read()
    except urllib.error.HTTPError as exc:
        raw = ""
        try:
            raw = exc.read().decode("utf-8", errors="replace")
        except Exception:
            raw = str(exc)
        _log_openclaw_chat_error(
            session_key=session_key,
            request_id=request_id,
            detail=f"OpenClaw chat failed (HTTP {exc.code}). requestId={request_id}",
            raw=raw,
        )
    except Exception as exc:
        _log_openclaw_chat_error(
            session_key=session_key,
            request_id=request_id,
            detail=f"OpenClaw chat failed. requestId={request_id}",
            raw=str(exc),
        )
    finally:
        try:
            event_hub.publish(
                {
                    "type": "openclaw.typing",
                    "data": {"sessionKey": session_key, "requestId": request_id, "typing": False},
                    "eventTs": now_iso(),
                }
            )
        except Exception:
            pass


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
    if not session_key:
        raise HTTPException(status_code=400, detail="sessionKey is required")
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    request_id = create_id("occhat")

    # Persist the user message immediately so the UI can render it without waiting for OpenClaw plugins.
    # OpenClaw is still responsible for logging assistant output + tool traces via plugins.
    topic_id, task_id = _parse_board_session_key(session_key)
    created_at = now_iso()
    try:
        payload_log = LogAppend(
            topicId=topic_id,
            taskId=task_id,
            type="conversation",
            content=message,
            summary=_clip(_sanitize_log_text(message), 160),
            raw=None,
            createdAt=created_at,
            agentId="user",
            agentLabel="User",
            source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            classificationStatus="pending",
        )
        with get_session() as session:
            append_log_entry(session, payload_log, idempotency_key=f"openclaw-chat:user:{request_id}")
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
        message=message,
    )
    return {"queued": True, "requestId": request_id}


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


@app.get("/api/topics", response_model=List[TopicOut], tags=["topics"])
def list_topics():
    """List topics (pinned first, newest activity first)."""
    with get_session() as session:
        topics = session.exec(select(Topic)).all()
        # Most recently updated first, then manual order, then pinned first.
        topics.sort(key=lambda t: t.updatedAt, reverse=True)
        topics.sort(key=lambda t: getattr(t, "sortIndex", 0))
        topics.sort(key=lambda t: not bool(getattr(t, "pinned", False)))
        return topics


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
        timestamp = now_iso()
        changed: list[str] = []
        for idx, topic_id in enumerate(final_ids):
            topic = topics_by_id.get(topic_id)
            if not topic:
                continue
            prior = before_sort.get(topic_id)
            if prior != idx:
                topic.sortIndex = idx
                topic.updatedAt = timestamp
                session.add(topic)
                changed.append(topic_id)
        session.commit()
        for topic_id in changed:
            topic = topics_by_id.get(topic_id)
            if not topic:
                continue
            event_hub.publish({"type": "topic.upserted", "data": topic.model_dump(), "eventTs": topic.updatedAt})
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
            if payload.snoozedUntil is not None:
                topic.snoozedUntil = payload.snoozedUntil
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
                if payload.snoozedUntil is not None:
                    duplicate.snoozedUntil = payload.snoozedUntil
                if payload.pinned is not None:
                    duplicate.pinned = payload.pinned
                duplicate.updatedAt = timestamp
                session.add(duplicate)
                session.commit()
                session.refresh(duplicate)
                event_hub.publish({"type": "topic.upserted", "data": duplicate.model_dump(), "eventTs": duplicate.updatedAt})
                enqueue_reindex_request({"op": "upsert", "kind": "topic", "id": duplicate.id, "text": duplicate.name})
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
            topic = Topic(
                id=payload.id or create_id("topic"),
                name=payload.name,
                sortIndex=sort_index,
                color=resolved_color,
                description=payload.description,
                priority=payload.priority or "medium",
                status=payload.status or "active",
                snoozedUntil=payload.snoozedUntil,
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
        enqueue_reindex_request({"op": "upsert", "kind": "topic", "id": topic.id, "text": topic.name})
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
                    "text": task.title,
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
    )
):
    """List tasks (pinned first, newest activity first)."""
    with get_session() as session:
        tasks = session.exec(select(Task)).all()
        if topicId:
            tasks = [t for t in tasks if t.topicId == topicId]
        tasks.sort(key=lambda t: t.updatedAt, reverse=True)
        tasks.sort(key=lambda t: getattr(t, "sortIndex", 0))
        tasks.sort(key=lambda t: not bool(getattr(t, "pinned", False)))
        return tasks


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
        timestamp = now_iso()
        for idx, task_id in enumerate(ordered_ids):
            task = tasks_by_id.get(task_id)
            if not task:
                continue
            task.sortIndex = idx
            task.updatedAt = timestamp
            session.add(task)
        session.commit()
        for task_id in ordered_ids:
            task = tasks_by_id.get(task_id)
            if not task:
                continue
            event_hub.publish({"type": "task.upserted", "data": task.model_dump(), "eventTs": task.updatedAt})
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
            if payload.tags is not None:
                task.tags = payload.tags
            if payload.snoozedUntil is not None:
                task.snoozedUntil = payload.snoozedUntil
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
                if payload.tags is not None:
                    duplicate.tags = payload.tags
                if payload.snoozedUntil is not None:
                    duplicate.snoozedUntil = payload.snoozedUntil
                duplicate.updatedAt = timestamp
                session.add(duplicate)
                session.commit()
                session.refresh(duplicate)
                event_hub.publish({"type": "task.upserted", "data": duplicate.model_dump(), "eventTs": duplicate.updatedAt})
                enqueue_reindex_request(
                    {"op": "upsert", "kind": "task", "id": duplicate.id, "topicId": duplicate.topicId, "text": duplicate.title}
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
            task = Task(
                id=payload.id or create_id("task"),
                topicId=payload.topicId,
                title=payload.title,
                sortIndex=sort_index,
                color=resolved_color,
                status=payload.status or "todo",
                pinned=payload.pinned or False,
                priority=payload.priority or "medium",
                dueDate=payload.dueDate,
                snoozedUntil=payload.snoozedUntil,
                tags=payload.tags or [],
                createdAt=timestamp,
                updatedAt=timestamp,
            )
        session.add(task)
        session.commit()
        session.refresh(task)
        event_hub.publish({"type": "task.upserted", "data": task.model_dump(), "eventTs": task.updatedAt})
        enqueue_reindex_request({"op": "upsert", "kind": "task", "id": task.id, "topicId": task.topicId, "text": task.title})
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
):
    """List pending conversation logs without heavy fields (raw) for classifier polling."""
    with get_session() as session:
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
            .offset(offset)
            .limit(limit)
        )
        return session.exec(query).all()


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
        query = query.order_by(
            LogEntry.createdAt.desc(),
            (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
        ).offset(offset).limit(limit)
        rows = session.exec(query).all()
        if not includeRaw:
            # Avoid DetachedInstanceError when response serialization touches deferred columns
            # after the session is closed.
            for row in rows:
                row.raw = None
        return rows


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

        entry.updatedAt = now_iso()

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
        for deleted_id in deleted_ids:
            enqueue_reindex_request({"op": "delete", "kind": "log", "id": deleted_id})
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
):
    """Return topics/tasks/logs changed since timestamp (ISO).

    NOTE: For large instances, returning *all* logs can exhaust memory in the API process and
    crash the container. This endpoint caps logs by default and is intended for incremental sync.
    """
    with get_session() as session:
        if not since:
            topics = session.exec(select(Topic)).all()
            tasks = session.exec(select(Task)).all()
            log_query = select(LogEntry).order_by(
                LogEntry.createdAt.desc(),
                (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
            ).limit(limitLogs)
            if not includeRaw:
                log_query = log_query.options(defer(LogEntry.raw))
            logs = session.exec(log_query).all()
        else:
            topics = session.exec(select(Topic).where(Topic.updatedAt >= since)).all()
            tasks = session.exec(select(Task).where(Task.updatedAt >= since)).all()
            log_query = (
                select(LogEntry)
                .where(LogEntry.updatedAt >= since)
                .order_by(LogEntry.updatedAt.desc(), LogEntry.createdAt.desc(), LogEntry.id.desc())
                .limit(limitLogs)
            )
            if not includeRaw:
                log_query = log_query.options(defer(LogEntry.raw))
            logs = session.exec(log_query).all()

        if not includeRaw:
            for row in logs:
                row.raw = None

        topics.sort(key=lambda t: t.updatedAt, reverse=True)
        tasks.sort(key=lambda t: t.updatedAt, reverse=True)
        # Preserve query ordering for logs (it may include SQLite rowid tiebreaks).
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
        # Raw payloads can be very large; exclude from bulk graph extraction.
        log_query = select(LogEntry).options(defer(LogEntry.raw))
        if not includePending:
            log_query = log_query.where(LogEntry.classificationStatus == "classified")
        log_query = log_query.order_by(
            LogEntry.createdAt.desc(),
            LogEntry.updatedAt.desc(),
            (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
        ).limit(limitLogs)
        logs = session.exec(log_query).all()

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
        # Never load the entire log table into memory for search.
        # This endpoint is used from the UI and must remain safe for large instances.
        window_logs = max(2000, min(20000, limitLogs * 8))
        # Raw payloads can be very large; exclude from bulk search window.
        # Content can also be huge (tool output, long transcripts). For search ranking we can
        # rely on summary text and avoid pulling full content into memory.
        log_query = select(LogEntry).options(defer(LogEntry.raw), defer(LogEntry.content))
        if topicId:
            log_query = log_query.where(LogEntry.topicId == topicId)
        if not includePending:
            log_query = log_query.where(LogEntry.classificationStatus == "classified")
        log_query = log_query.order_by(
            LogEntry.createdAt.desc(),
            LogEntry.updatedAt.desc(),
            (text("rowid DESC") if DATABASE_URL.startswith("sqlite") else LogEntry.id.desc()),
        ).limit(window_logs)
        logs = session.exec(log_query).all()

        if topicId:
            tasks = [task for task in tasks if task.topicId == topicId]

        # Preserve query ordering for logs (it may include SQLite rowid tiebreaks).

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

        # Build a lightweight log payload for semantic_search without touching deferred columns.
        # If we access entry.content here, SQLAlchemy will lazy-load it and defeat the point.
        log_payloads: list[dict[str, Any]] = []
        for entry in logs:
            summary_text = str(entry.summary or "").strip()
            log_payloads.append(
                {
                    "id": entry.id,
                    "topicId": entry.topicId,
                    "taskId": entry.taskId,
                    "relatedLogId": entry.relatedLogId,
                    "idempotencyKey": entry.idempotencyKey,
                    "type": entry.type,
                    "summary": summary_text,
                    "content": summary_text,
                    "raw": "",
                    "createdAt": entry.createdAt,
                    "updatedAt": entry.updatedAt,
                    "agentId": entry.agentId,
                    "agentLabel": entry.agentLabel,
                    "source": entry.source,
                }
            )

        search_result = semantic_search(
            query,
            [item.model_dump() for item in topics],
            [item.model_dump() for item in tasks],
            log_payloads,
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
                    "summary": _clip(_sanitize_log_text(entry.summary or ""), 140),
                    "content": _clip(_sanitize_log_text(entry.summary or ""), 320),
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
                        "summary": _clip(_sanitize_log_text(note.summary or ""), 140),
                        "content": _clip(_sanitize_log_text(note.summary or ""), 280),
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
        topics = session.exec(select(Topic)).all()
        tasks = session.exec(select(Task)).all()
        now = datetime.now(timezone.utc)

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

        cutoff = now.timestamp() - 24 * 60 * 60
        topics_created_24h = sum(
            1
            for t in topics
            if (parsed := parse_iso(getattr(t, "createdAt", None))) and parsed.timestamp() >= cutoff
        )
        tasks_created_24h = sum(
            1
            for t in tasks
            if (parsed := parse_iso(getattr(t, "createdAt", None))) and parsed.timestamp() >= cutoff
        )

        gate = {
            "topics": {"allowedTotal": 0, "blockedTotal": 0, "allowed24h": 0, "blocked24h": 0},
            "tasks": {"allowedTotal": 0, "blockedTotal": 0, "allowed24h": 0, "blocked24h": 0},
        }
        audit_path = os.getenv("CLAWBOARD_CREATION_AUDIT_PATH") or os.getenv("CLASSIFIER_CREATION_AUDIT_PATH") or "/data/creation-gate.jsonl"
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
                        if ts and ts.timestamp() >= cutoff:
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
                "topics": {"total": len(topics), "created24h": topics_created_24h},
                "tasks": {"total": len(tasks), "created24h": tasks_created_24h},
                "gate": gate,
            },
        }
