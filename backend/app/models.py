from __future__ import annotations

from typing import Optional, List, Dict, Any
from sqlmodel import SQLModel, Field
from sqlalchemy import Column, JSON


class InstanceConfig(SQLModel, table=True):
    id: Optional[int] = Field(
        default=1,
        primary_key=True,
        description="Singleton config row ID (always 1).",
    )
    title: str = Field(
        description="Instance title displayed in the UI.",
    )
    integrationLevel: str = Field(
        description="Integration depth (manual | write | full).",
    )
    updatedAt: str = Field(
        description="ISO timestamp of the last config update.",
    )


class Topic(SQLModel, table=True):
    id: str = Field(primary_key=True, description="Topic ID.")
    name: str = Field(description="Topic name.")
    description: Optional[str] = Field(
        default=None,
        description="Topic description.",
    )
    priority: Optional[str] = Field(
        default="medium",
        description="Priority level (low | medium | high).",
    )
    status: Optional[str] = Field(
        default="active",
        description="Status (active | archived).",
    )
    tags: List[str] = Field(
        default_factory=list,
        sa_column=Column(JSON),
        description="Freeform tags.",
    )
    parentId: Optional[str] = Field(
        default=None,
        description="Parent topic ID (for subtopics).",
    )
    pinned: Optional[bool] = Field(
        default=False,
        description="Pinned topics sort to the top.",
    )
    createdAt: str = Field(
        description="ISO timestamp when the topic was created.",
    )
    updatedAt: str = Field(
        description="ISO timestamp of last activity/update.",
    )


class Task(SQLModel, table=True):
    id: str = Field(primary_key=True, description="Task ID.")
    topicId: Optional[str] = Field(
        default=None,
        foreign_key="topic.id",
        description="Parent topic ID (nullable).",
    )
    title: str = Field(description="Task title.")
    status: str = Field(
        description="Task status (todo | doing | blocked | done).",
    )
    pinned: Optional[bool] = Field(
        default=False,
        description="Pinned tasks sort to the top within their topic.",
    )
    priority: Optional[str] = Field(
        default="medium",
        description="Priority level (low | medium | high).",
    )
    dueDate: Optional[str] = Field(
        default=None,
        description="Optional due date (ISO).",
    )
    createdAt: str = Field(
        description="ISO timestamp when the task was created.",
    )
    updatedAt: str = Field(
        description="ISO timestamp of last update.",
    )


class LogEntry(SQLModel, table=True):
    id: str = Field(primary_key=True, description="Log entry ID.")
    topicId: Optional[str] = Field(
        default=None,
        foreign_key="topic.id",
        description="Associated topic ID (nullable).",
    )
    taskId: Optional[str] = Field(
        default=None,
        foreign_key="task.id",
        description="Associated task ID (nullable).",
    )
    relatedLogId: Optional[str] = Field(
        default=None,
        description="If this is a curated note, link to the original log ID.",
    )
    idempotencyKey: Optional[str] = Field(
        default=None,
        description="Optional idempotency key for exact-once ingestion.",
    )
    type: str = Field(
        description="Log type (conversation | action | note | system | import).",
    )
    content: str = Field(description="Full log content.")
    summary: Optional[str] = Field(
        default=None,
        description="Concise summary for list view.",
    )
    raw: Optional[str] = Field(
        default=None,
        description="Raw prompt/response payload if available.",
    )

    # Async classification metadata (stage-2 classifier updates these fields).
    classificationStatus: str = Field(
        default="pending",
        description="Classification status (pending | classified | failed).",
    )
    classificationAttempts: int = Field(
        default=0,
        description="Number of classifier attempts.",
    )
    classificationError: Optional[str] = Field(
        default=None,
        description="Last classifier error (if any).",
    )

    createdAt: str = Field(
        description="ISO timestamp when the log was created.",
    )
    updatedAt: str = Field(
        description="ISO timestamp when the log was last updated.",
    )
    agentId: Optional[str] = Field(
        default=None,
        description="Agent identifier (main, coding, web, social, system).",
    )
    agentLabel: Optional[str] = Field(
        default=None,
        description="Human-readable agent label.",
    )
    source: Optional[Dict[str, Any]] = Field(
        default=None,
        sa_column=Column(JSON),
        description="Source metadata (channel, sessionKey, messageId).",
    )


class IngestQueue(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    payload: Dict[str, Any] = Field(sa_column=Column(JSON))
    status: str = Field(default="pending", description="pending|processing|failed|done")
    attempts: int = Field(default=0)
    lastError: Optional[str] = Field(default=None)
    createdAt: str = Field(description="ISO timestamp when enqueued.")
