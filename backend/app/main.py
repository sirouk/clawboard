from __future__ import annotations

import os
from datetime import datetime, timezone
import asyncio
from fastapi import Request
from uuid import uuid4
from fastapi import FastAPI, Depends, Query, Body, HTTPException
from fastapi.responses import StreamingResponse
from typing import List
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import select

from .auth import require_token, is_token_required
from .db import init_db, get_session
from .models import InstanceConfig, Topic, Task, LogEntry
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
)
from .events import event_hub

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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_id(prefix: str) -> str:
    return f"{prefix}-{uuid4()}"


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


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
                integrationLevel="manual",
                updatedAt=now_iso(),
            )
            session.add(instance)
            session.commit()
            session.refresh(instance)
        return {"instance": instance.model_dump(), "tokenRequired": is_token_required()}


@app.post("/api/config", dependencies=[Depends(require_token)], response_model=InstanceResponse, tags=["config"])
def update_config(
    payload: InstanceUpdate = Body(
        ...,
        examples={
            "default": {
                "summary": "Update instance config",
                "value": {"title": "Clawboard Ops", "integrationLevel": "manual"},
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
                integrationLevel=payload.integrationLevel or "manual",
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
        return {"instance": instance.model_dump(), "tokenRequired": is_token_required()}


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
            topic = Topic(
                id=payload.id or create_id("topic"),
                name=payload.name,
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
        return topic


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
            task = Task(
                id=payload.id or create_id("task"),
                topicId=payload.topicId,
                title=payload.title,
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
        return task


@app.get("/api/log", response_model=List[LogOut], tags=["logs"])
def list_logs(
    topicId: str | None = Query(default=None, description="Filter logs by topic ID.", example="topic-1"),
    taskId: str | None = Query(default=None, description="Filter logs by task ID.", example="task-1"),
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
    )
):
    """Append a timeline entry."""
    with get_session() as session:
        timestamp = payload.createdAt or now_iso()
        entry = LogEntry(
            id=create_id("log"),
            topicId=payload.topicId,
            taskId=payload.taskId,
            relatedLogId=payload.relatedLogId,
            type=payload.type,
            content=payload.content,
            summary=payload.summary,
            raw=payload.raw,
            classificationStatus=payload.classificationStatus or "pending",
            classificationAttempts=0,
            classificationError=None,
            createdAt=timestamp,
            agentId=payload.agentId,
            agentLabel=payload.agentLabel,
            source=payload.source,
        )
        session.add(entry)
        session.commit()
        session.refresh(entry)
        event_hub.publish({"type": "log.appended", "data": entry.model_dump(), "eventTs": entry.createdAt})
        return entry


@app.patch("/api/log/{log_id}", dependencies=[Depends(require_token)], response_model=LogOut, tags=["logs"])
def patch_log(log_id: str, payload: LogPatch = Body(...)):
    """Patch an existing log entry (used by async classifier; idempotent)."""
    with get_session() as session:
        entry = session.get(LogEntry, log_id)
        if not entry:
            raise HTTPException(status_code=404, detail="Log not found")

        if payload.topicId is not None:
            entry.topicId = payload.topicId
        if payload.taskId is not None:
            entry.taskId = payload.taskId
        if payload.relatedLogId is not None:
            entry.relatedLogId = payload.relatedLogId
        if payload.summary is not None:
            entry.summary = payload.summary
        if payload.raw is not None:
            entry.raw = payload.raw
        if payload.classificationStatus is not None:
            entry.classificationStatus = payload.classificationStatus
        if payload.classificationAttempts is not None:
            entry.classificationAttempts = payload.classificationAttempts
        if payload.classificationError is not None:
            entry.classificationError = payload.classificationError

        session.add(entry)
        session.commit()
        session.refresh(entry)
        event_hub.publish({"type": "log.patched", "data": entry.model_dump(), "eventTs": entry.createdAt})
        return entry


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
            logs = session.exec(select(LogEntry).where(LogEntry.createdAt >= since)).all()

        topics.sort(key=lambda t: t.updatedAt, reverse=True)
        tasks.sort(key=lambda t: t.updatedAt, reverse=True)
        logs.sort(key=lambda l: l.createdAt, reverse=True)
        return {"topics": topics, "tasks": tasks, "logs": logs}
