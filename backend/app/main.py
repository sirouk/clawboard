from __future__ import annotations

import os
from datetime import datetime, timezone
from uuid import uuid4
from fastapi import FastAPI, Depends, Query
from typing import List
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import select

from .auth import require_token, is_token_required
from .db import init_db, get_session
from .models import InstanceConfig, Topic, Task, LogEntry
from .schemas import InstanceUpdate, TopicUpsert, TaskUpsert, LogAppend

app = FastAPI(title="Clawboard API", version="1.0.0")

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


@app.get("/api/config")
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


@app.post("/api/config", dependencies=[Depends(require_token)])
def update_config(payload: InstanceUpdate):
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
        return {"instance": instance.model_dump(), "tokenRequired": is_token_required()}


@app.get("/api/topics", response_model=List[Topic])
def list_topics():
    """List topics (pinned first, newest activity first)."""
    with get_session() as session:
        topics = session.exec(select(Topic)).all()
        # Most recently updated first, then pinned first
        topics.sort(key=lambda t: t.updatedAt, reverse=True)
        topics.sort(key=lambda t: not bool(t.pinned))
        return topics


@app.post("/api/topics", dependencies=[Depends(require_token)], response_model=Topic)
def upsert_topic(payload: TopicUpsert):
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
        return topic


@app.get("/api/tasks", response_model=List[Task])
def list_tasks(topicId: str | None = Query(default=None)):
    """List tasks (pinned first, newest activity first)."""
    with get_session() as session:
        tasks = session.exec(select(Task)).all()
        if topicId:
            tasks = [t for t in tasks if t.topicId == topicId]
        tasks.sort(key=lambda t: t.updatedAt, reverse=True)
        tasks.sort(key=lambda t: not bool(t.pinned))
        return tasks


@app.post("/api/tasks", dependencies=[Depends(require_token)], response_model=Task)
def upsert_task(payload: TaskUpsert):
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
        return task


@app.get("/api/log", response_model=List[LogEntry])
def list_logs(
    topicId: str | None = Query(default=None),
    taskId: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    """List timeline entries (newest first)."""
    with get_session() as session:
        logs = session.exec(select(LogEntry)).all()
        if topicId:
            logs = [l for l in logs if l.topicId == topicId]
        if taskId:
            logs = [l for l in logs if l.taskId == taskId]
        logs = sorted(logs, key=lambda l: l.createdAt, reverse=True)
        return logs[offset : offset + limit]


@app.post("/api/log", dependencies=[Depends(require_token)], response_model=LogEntry)
def append_log(payload: LogAppend):
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
            createdAt=timestamp,
            agentId=payload.agentId,
            agentLabel=payload.agentLabel,
            source=payload.source,
        )
        session.add(entry)
        session.commit()
        session.refresh(entry)
        return entry
