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


class Space(SQLModel, table=True):
    id: str = Field(primary_key=True, description="Space ID.")
    name: str = Field(description="Space name.")
    color: Optional[str] = Field(
        default=None,
        description="Optional space display color in #RRGGBB format.",
    )
    connectivity: Dict[str, bool] = Field(
        default_factory=dict,
        sa_column=Column(JSON),
        description="Outbound connectivity toggles by target space id (missing => enabled).",
    )
    createdAt: str = Field(description="ISO timestamp when the space was created.")
    updatedAt: str = Field(description="ISO timestamp of last update.")


class Topic(SQLModel, table=True):
    id: str = Field(primary_key=True, description="Topic ID.")
    spaceId: str = Field(
        default="space-default",
        foreign_key="space.id",
        description="Owning space ID.",
    )
    name: str = Field(description="Topic name.")
    createdBy: str = Field(
        default="user",
        description="Creation source (user | classifier | import).",
    )
    sortIndex: int = Field(
        default=0,
        description="Manual ordering index (lower comes first).",
    )
    color: Optional[str] = Field(
        default=None,
        description="Topic display color in #RRGGBB format.",
    )
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
        description="Status (active | snoozed | archived).",
    )
    snoozedUntil: Optional[str] = Field(
        default=None,
        description="ISO timestamp when a snoozed topic should re-activate (nullable).",
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
    digest: Optional[str] = Field(
        default=None,
        description="Durable topic digest (system-managed summary; optional).",
    )
    digestUpdatedAt: Optional[str] = Field(
        default=None,
        description="ISO timestamp when digest was last updated (nullable).",
    )
    createdAt: str = Field(
        description="ISO timestamp when the topic was created.",
    )
    updatedAt: str = Field(
        description="ISO timestamp of last activity/update.",
    )


class Task(SQLModel, table=True):
    id: str = Field(primary_key=True, description="Task ID.")
    spaceId: str = Field(
        default="space-default",
        foreign_key="space.id",
        description="Owning space ID.",
    )
    topicId: Optional[str] = Field(
        default=None,
        foreign_key="topic.id",
        description="Parent topic ID (nullable).",
    )
    title: str = Field(description="Task title.")
    sortIndex: int = Field(
        default=0,
        description="Manual ordering index within the topic (lower comes first).",
    )
    color: Optional[str] = Field(
        default=None,
        description="Task display color in #RRGGBB format.",
    )
    status: str = Field(
        description="Task status (todo | doing | blocked | done).",
    )
    tags: List[str] = Field(
        default_factory=list,
        sa_column=Column(JSON),
        description="Freeform tags.",
    )
    snoozedUntil: Optional[str] = Field(
        default=None,
        description="ISO timestamp when a snoozed task should re-activate (nullable).",
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
    digest: Optional[str] = Field(
        default=None,
        description="Durable task digest (system-managed summary; optional).",
    )
    digestUpdatedAt: Optional[str] = Field(
        default=None,
        description="ISO timestamp when digest was last updated (nullable).",
    )
    createdAt: str = Field(
        description="ISO timestamp when the task was created.",
    )
    updatedAt: str = Field(
        description="ISO timestamp of last update.",
    )


class LogEntry(SQLModel, table=True):
    id: str = Field(primary_key=True, description="Log entry ID.")
    spaceId: str = Field(
        default="space-default",
        foreign_key="space.id",
        description="Owning space ID.",
    )
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
    attachments: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        sa_column=Column(JSON),
        description="Optional attachments metadata (id, fileName, mimeType, sizeBytes).",
    )


class DeletedLog(SQLModel, table=True):
    """Tombstone rows so clients can learn about deletions via /api/changes.

    SSE is best-effort (connections drop, background tabs throttle). This table provides a
    durable-ish deletion feed for incremental reconciliation.
    """

    id: str = Field(primary_key=True, description="Deleted log entry ID.")
    deletedAt: str = Field(description="ISO timestamp when the log was deleted.")


class SessionRoutingMemory(SQLModel, table=True):
    """Small per-session memory to improve routing under low-signal follow-ups.

    Stores recent topic/task decisions for a given `source.sessionKey` so the
    classifier can resolve ambiguous turns (e.g., "yes", "ship it") without
    expanding the LLM/context window.
    """

    sessionKey: str = Field(primary_key=True, description="Session key (source.sessionKey).")
    items: List[Dict[str, Any]] = Field(
        default_factory=list,
        sa_column=Column(JSON),
        description="Recent routing decisions (bounded list, newest last).",
    )
    createdAt: str = Field(description="ISO timestamp when the memory was created.")
    updatedAt: str = Field(description="ISO timestamp of last update.")


class IngestQueue(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    payload: Dict[str, Any] = Field(sa_column=Column(JSON))
    status: str = Field(default="pending", description="pending|processing|failed|done")
    attempts: int = Field(default=0)
    lastError: Optional[str] = Field(default=None)
    createdAt: str = Field(description="ISO timestamp when enqueued.")


class Attachment(SQLModel, table=True):
    """Binary attachment metadata stored alongside logs.

    The file bytes live on disk under CLAWBOARD_ATTACHMENTS_DIR; this table stores
    stable IDs + metadata so logs can reference attachments reliably.
    """

    id: str = Field(primary_key=True, description="Attachment ID.")
    logId: Optional[str] = Field(
        default=None,
        foreign_key="logentry.id",
        description="Owning log entry ID once attached to a chat message.",
    )
    fileName: str = Field(description="Original filename (sanitized).")
    mimeType: str = Field(description="MIME type (validated allowlist).")
    sizeBytes: int = Field(description="File size in bytes.")
    sha256: str = Field(description="SHA-256 digest (hex) of the file bytes.")
    storagePath: str = Field(description="Path relative to CLAWBOARD_ATTACHMENTS_DIR.")
    createdAt: str = Field(description="ISO timestamp when the attachment was stored.")
    updatedAt: str = Field(description="ISO timestamp when the attachment metadata was last updated.")


class Draft(SQLModel, table=True):
    """Ephemeral UI drafts (message composers, new topic/task names, note drafts, etc.).

    Drafts are keyed by a stable string so multiple browsers can share in-progress input.
    """

    key: str = Field(primary_key=True, description="Stable draft key.")
    value: str = Field(description="Draft value (may be empty).")
    createdAt: str = Field(description="ISO timestamp when the draft was created.")
    updatedAt: str = Field(description="ISO timestamp when the draft was last updated.")
