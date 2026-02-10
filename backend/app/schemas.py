from __future__ import annotations

from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, model_validator
from pydantic.config import ConfigDict


class ModelBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class AttachmentRef(BaseModel):
    """Minimal attachment metadata embedded on a LogEntry."""

    id: str = Field(description="Attachment ID.", examples=["att-123"])
    fileName: str = Field(description="Original filename.", examples=["design-notes.pdf"])
    mimeType: str = Field(description="MIME type.", examples=["application/pdf"])
    sizeBytes: int = Field(description="Size in bytes.", examples=[12345])


class AttachmentOut(ModelBase):
    id: str = Field(description="Attachment ID.", examples=["att-123"])
    logId: Optional[str] = Field(description="Owning log entry ID once attached.", examples=["log-1"])
    fileName: str = Field(description="Original filename (sanitized).", examples=["design-notes.pdf"])
    mimeType: str = Field(description="MIME type.", examples=["application/pdf"])
    sizeBytes: int = Field(description="Size in bytes.", examples=[12345])
    sha256: str = Field(description="SHA-256 digest (hex).", examples=["abc123..."])
    createdAt: str = Field(description="ISO timestamp when stored.", examples=["2026-02-09T18:00:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp when last updated.", examples=["2026-02-09T18:00:00.000Z"])


class StartFreshReplayRequest(BaseModel):
    """Admin-only: clear derived state and mark all logs as pending for classifier replay."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "integrationLevel": "full",
            }
        }
    )
    integrationLevel: Literal["manual", "write", "full"] = Field(
        default="full",
        description="Set instance integrationLevel after reset.",
        examples=["full"],
    )


class InstanceUpdate(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "title": "Clawboard Ops",
                "integrationLevel": "manual",
            }
        }
    )
    title: Optional[str] = Field(
        default=None,
        description="Instance title displayed in the UI.",
        examples=["Clawboard Ops"],
    )
    integrationLevel: Optional[str] = Field(
        default=None,
        description="Integration depth (manual | write | full).",
        examples=["manual"],
    )


class InstanceResponse(BaseModel):
    instance: InstanceOut = Field(description="Instance configuration object.")
    tokenRequired: bool = Field(
        description="Whether API token auth is enforced (writes and non-localhost reads).",
        examples=[True],
    )
    tokenConfigured: bool = Field(
        description="Whether CLAWBOARD_TOKEN is configured on the API server.",
        examples=[True],
    )


class InstanceOut(ModelBase):
    id: int = Field(description="Singleton config row ID (always 1).", examples=[1])
    title: str = Field(description="Instance title displayed in the UI.", examples=["Clawboard Ops"])
    integrationLevel: str = Field(description="Integration depth (manual | write | full).", examples=["manual"])
    updatedAt: str = Field(description="ISO timestamp of the last config update.", examples=["2026-02-03T20:05:00.000Z"])


class TopicOut(ModelBase):
    id: str = Field(description="Topic ID.", examples=["topic-1"])
    name: str = Field(description="Topic name.", examples=["Clawboard"])
    createdBy: Optional[str] = Field(
        description="Creation source (user | classifier | import).",
        examples=["user"],
    )
    sortIndex: int = Field(description="Manual ordering index (lower comes first).", examples=[0])
    color: Optional[str] = Field(description="Topic color #RRGGBB.", examples=["#FF8A4A"])
    description: Optional[str] = Field(description="Topic description.", examples=["Product and platform work."])
    priority: Optional[str] = Field(description="Priority (low | medium | high).", examples=["high"])
    status: Optional[str] = Field(description="Status (active | paused | archived).", examples=["active"])
    snoozedUntil: Optional[str] = Field(
        description="ISO timestamp when a snoozed topic should re-activate (nullable).",
        examples=["2026-02-09T18:00:00.000Z"],
    )
    tags: List[str] = Field(description="Freeform tags.", examples=[["product", "platform"]])
    parentId: Optional[str] = Field(description="Parent topic ID (for subtopics).", examples=["topic-1"])
    pinned: Optional[bool] = Field(description="Pinned topics sort to the top.", examples=[True])
    createdAt: str = Field(description="ISO timestamp when the topic was created.", examples=["2026-02-01T14:00:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp of last activity/update.", examples=["2026-02-03T20:05:00.000Z"])


class TaskOut(ModelBase):
    id: str = Field(description="Task ID.", examples=["task-1"])
    topicId: Optional[str] = Field(description="Parent topic ID (nullable).", examples=["topic-1"])
    title: str = Field(description="Task title.", examples=["Ship onboarding wizard"])
    sortIndex: int = Field(description="Manual ordering index within the topic (lower comes first).", examples=[0])
    color: Optional[str] = Field(description="Task color #RRGGBB.", examples=["#4EA1FF"])
    status: str = Field(description="Task status (todo | doing | blocked | done).", examples=["doing"])
    pinned: Optional[bool] = Field(description="Pinned tasks sort to the top.", examples=[True])
    priority: Optional[str] = Field(description="Priority (low | medium | high).", examples=["high"])
    dueDate: Optional[str] = Field(description="Optional due date (ISO).", examples=["2026-02-05T00:00:00.000Z"])
    snoozedUntil: Optional[str] = Field(
        description="ISO timestamp when a snoozed task should re-activate (nullable).",
        examples=["2026-02-09T18:00:00.000Z"],
    )
    tags: List[str] = Field(description="Freeform tags.", examples=[["ops", "follow-up"]])
    createdAt: str = Field(description="ISO timestamp when the task was created.", examples=["2026-02-02T10:00:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp of last update.", examples=["2026-02-03T19:55:00.000Z"])


class LogOut(ModelBase):
    id: str = Field(description="Log entry ID.", examples=["log-1"])
    topicId: Optional[str] = Field(description="Associated topic ID (nullable).", examples=["topic-1"])
    taskId: Optional[str] = Field(description="Associated task ID (nullable).", examples=["task-1"])
    relatedLogId: Optional[str] = Field(description="Link to original log (for notes).", examples=["log-12"])
    idempotencyKey: Optional[str] = Field(description="Idempotency key if provided.", examples=["discord:msg:assistant"])
    type: str = Field(description="Log type (conversation | action | note | system | import).", examples=["conversation"])
    content: str = Field(description="Full log content.", examples=["Defined onboarding wizard steps and token flow."])
    summary: Optional[str] = Field(description="Concise summary.", examples=["Defined onboarding wizard steps."])
    raw: Optional[str] = Field(description="Raw prompt/response payload.", examples=["User: ...\nAssistant: ..."])

    classificationStatus: str = Field(description="Classification status.", examples=["pending"])
    classificationAttempts: int = Field(description="Classifier attempt count.", examples=[0])
    classificationError: Optional[str] = Field(description="Last classifier error.", examples=[None])

    createdAt: str = Field(description="ISO timestamp when the log was created.", examples=["2026-02-02T10:05:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp when the log was last updated.", examples=["2026-02-02T10:05:00.000Z"])
    agentId: Optional[str] = Field(description="Agent identifier.", examples=["main"])
    agentLabel: Optional[str] = Field(description="Agent label.", examples=["User"])
    source: Optional[Dict[str, Any]] = Field(
        description="Source metadata (channel, sessionKey, messageId).",
        examples=[{"channel": "discord", "sessionKey": "main", "messageId": "msg-001"}],
    )
    attachments: Optional[List[AttachmentRef]] = Field(
        default=None,
        description="Optional attachments metadata embedded on the log entry.",
    )


class LogOutLite(ModelBase):
    """Lightweight log shape for high-frequency polling (classifier, live UI lists)."""

    id: str = Field(description="Log entry ID.", examples=["log-1"])
    topicId: Optional[str] = Field(description="Associated topic ID (nullable).", examples=["topic-1"])
    taskId: Optional[str] = Field(description="Associated task ID (nullable).", examples=["task-1"])
    relatedLogId: Optional[str] = Field(description="Link to original log (for notes).", examples=["log-12"])
    idempotencyKey: Optional[str] = Field(description="Idempotency key if provided.", examples=["discord:msg:assistant"])
    type: str = Field(description="Log type (conversation | action | note | system | import).", examples=["conversation"])
    content: str = Field(description="Full log content.", examples=["Defined onboarding wizard steps and token flow."])
    summary: Optional[str] = Field(description="Concise summary.", examples=["Defined onboarding wizard steps."])

    classificationStatus: str = Field(description="Classification status.", examples=["pending"])
    classificationAttempts: int = Field(description="Classifier attempt count.", examples=[0])
    classificationError: Optional[str] = Field(description="Last classifier error.", examples=[None])

    createdAt: str = Field(description="ISO timestamp when the log was created.", examples=["2026-02-02T10:05:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp when the log was last updated.", examples=["2026-02-02T10:05:00.000Z"])
    agentId: Optional[str] = Field(description="Agent identifier.", examples=["main"])
    agentLabel: Optional[str] = Field(description="Agent label.", examples=["User"])
    source: Optional[Dict[str, Any]] = Field(
        description="Source metadata (channel, sessionKey, messageId).",
        examples=[{"channel": "discord", "sessionKey": "main", "messageId": "msg-001"}],
    )
    attachments: Optional[List[AttachmentRef]] = Field(
        default=None,
        description="Optional attachments metadata embedded on the log entry.",
    )


class TopicUpsert(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "topic-1",
                "name": "Clawboard",
                "description": "Product work.",
                "priority": "high",
                "status": "active",
                "tags": ["product", "platform"],
                "parentId": "topic-1",
                "pinned": True,
            }
        }
    )
    id: Optional[str] = Field(default=None, description="Topic ID (omit to create).", examples=["topic-1"])
    name: str = Field(description="Topic name.", examples=["Clawboard"])
    color: Optional[str] = Field(default=None, description="Optional topic color #RRGGBB.", examples=["#FF8A4A"])
    description: Optional[str] = Field(default=None, description="Topic description.", examples=["Product work."])
    priority: Optional[str] = Field(default=None, description="Priority (low | medium | high).", examples=["high"])
    status: Optional[str] = Field(default=None, description="Status (active | paused | archived).", examples=["active"])
    snoozedUntil: Optional[str] = Field(
        default=None,
        description="ISO timestamp when a snoozed topic should re-activate (nullable).",
        examples=["2026-02-09T18:00:00.000Z"],
    )
    tags: Optional[List[str]] = Field(default=None, description="Tags list.", examples=[["product", "platform"]])
    parentId: Optional[str] = Field(default=None, description="Parent topic ID.", examples=["topic-1"])
    pinned: Optional[bool] = Field(default=None, description="Pin topic to top.", examples=[True])


class TaskUpsert(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "task-1",
                "topicId": "topic-1",
                "title": "Ship onboarding wizard",
                "status": "doing",
                "pinned": True,
                "priority": "high",
                "dueDate": "2026-02-05T00:00:00.000Z",
            }
        }
    )
    id: Optional[str] = Field(default=None, description="Task ID (omit to create).", examples=["task-1"])
    topicId: Optional[str] = Field(default=None, description="Parent topic ID.", examples=["topic-1"])
    title: str = Field(description="Task title.", examples=["Ship onboarding wizard"])
    color: Optional[str] = Field(default=None, description="Optional task color #RRGGBB.", examples=["#4EA1FF"])
    status: Optional[str] = Field(
        default=None, description="Task status (todo | doing | blocked | done).", examples=["doing"]
    )
    pinned: Optional[bool] = Field(default=None, description="Pin task to top.", examples=[True])
    priority: Optional[str] = Field(default=None, description="Priority (low | medium | high).", examples=["high"])
    dueDate: Optional[str] = Field(default=None, description="Optional due date (ISO).", examples=["2026-02-05T00:00:00.000Z"])
    snoozedUntil: Optional[str] = Field(
        default=None,
        description="ISO timestamp when a snoozed task should re-activate (nullable).",
        examples=["2026-02-09T18:00:00.000Z"],
    )
    tags: Optional[List[str]] = Field(default=None, description="Tags list.", examples=[["ops", "follow-up"]])


class TopicReorderRequest(BaseModel):
    orderedIds: List[str] = Field(
        description="Topic IDs in the desired order (use the full list for stable ordering).",
        examples=[["topic-1", "topic-2", "topic-3"]],
    )

    @model_validator(mode="after")
    def _validate_unique(self):
        if not self.orderedIds:
            raise ValueError("orderedIds cannot be empty")
        if len(set(self.orderedIds)) != len(self.orderedIds):
            raise ValueError("orderedIds must be unique")
        return self


class TaskReorderRequest(BaseModel):
    topicId: Optional[str] = Field(
        default=None,
        description="Scope reorder to tasks belonging to this topic ID. Omit/null to reorder unassigned tasks.",
        examples=["topic-1"],
    )
    orderedIds: List[str] = Field(
        description="Task IDs in the desired order (use the full list for stable ordering).",
        examples=[["task-1", "task-2", "task-3"]],
    )

    @model_validator(mode="after")
    def _validate_unique(self):
        if not self.orderedIds:
            raise ValueError("orderedIds cannot be empty")
        if len(set(self.orderedIds)) != len(self.orderedIds):
            raise ValueError("orderedIds must be unique")
        return self


class LogAppend(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
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
            }
        }
    )
    topicId: Optional[str] = Field(default=None, description="Topic ID (nullable).", examples=["topic-1"])
    taskId: Optional[str] = Field(default=None, description="Task ID (nullable).", examples=["task-1"])
    relatedLogId: Optional[str] = Field(default=None, description="Link to original log (for notes).", examples=["log-12"])
    idempotencyKey: Optional[str] = Field(
        default=None,
        description="Optional idempotency key to enforce exact-once ingestion.",
        examples=["discord:1469:assistant:conversation"],
    )

    # Stage-1 capture should leave logs as pending; stage-2 classifier PATCHes.
    classificationStatus: Optional[str] = Field(
        default=None,
        description="Optional override: classification status (pending|classified|failed).",
        examples=["pending"],
    )

    type: str = Field(
        description="Log type (conversation | action | note | system | import).",
        examples=["conversation"],
    )
    content: str = Field(description="Full log content.", examples=["Defined onboarding wizard steps and token flow."])
    summary: Optional[str] = Field(default=None, description="Concise summary.", examples=["Defined onboarding wizard steps."])
    raw: Optional[str] = Field(default=None, description="Raw prompt/response payload.", examples=["User: ...\nAssistant: ..."])
    createdAt: Optional[str] = Field(default=None, description="ISO timestamp override.", examples=["2026-02-02T10:05:00.000Z"])
    agentId: Optional[str] = Field(default=None, description="Agent identifier.", examples=["main"])
    agentLabel: Optional[str] = Field(default=None, description="Agent label.", examples=["User"])
    source: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Source metadata (channel, sessionKey, messageId).",
        examples=[{"channel": "discord", "sessionKey": "main", "messageId": "msg-001"}],
    )
    attachments: Optional[List[AttachmentRef]] = Field(
        default=None,
        description="Optional attachments metadata embedded on the log entry.",
    )


class LogPatch(BaseModel):
    """Patch fields on an existing log entry (idempotent reclassification)."""

    topicId: Optional[str] = Field(default=None, description="Topic ID.")
    taskId: Optional[str] = Field(default=None, description="Task ID.")
    relatedLogId: Optional[str] = Field(default=None, description="Related log ID.")
    content: Optional[str] = Field(default=None, description="Content override.")
    summary: Optional[str] = Field(default=None, description="Summary override.")
    raw: Optional[str] = Field(default=None, description="Raw override.")
    classificationStatus: Optional[str] = Field(default=None, description="pending|classified|failed")
    classificationAttempts: Optional[int] = Field(default=None, description="Attempt count")
    classificationError: Optional[str] = Field(default=None, description="Last error")


class DraftUpsert(BaseModel):
    """Upsert a draft value by key (used for cross-device draft persistence)."""

    key: str = Field(
        ...,
        min_length=1,
        max_length=240,
        description="Stable draft key (e.g. draft:chat:clawboard:topic:topic-123).",
        examples=["draft:chat:clawboard:topic:topic-123"],
    )
    value: str = Field(
        default="",
        max_length=50_000,
        description="Draft value (may be empty to clear).",
        examples=["Working on the onboarding flow..."],
    )


class DraftOut(ModelBase):
    key: str = Field(description="Draft key.", examples=["draft:chat:clawboard:topic:topic-123"])
    value: str = Field(description="Draft value.", examples=["Working on the onboarding flow..."])
    createdAt: str = Field(description="ISO timestamp when created.", examples=["2026-02-09T18:00:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp when updated.", examples=["2026-02-09T18:05:00.000Z"])


class ChangesResponse(BaseModel):
    topics: List[TopicOut] = Field(description="Topics updated since timestamp.")
    tasks: List[TaskOut] = Field(description="Tasks updated since timestamp.")
    logs: List[LogOutLite] = Field(description="Logs created since timestamp (lightweight, excludes raw).")
    drafts: List[DraftOut] = Field(description="Drafts updated since timestamp.")


class OpenClawChatRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "sessionKey": "clawboard:thread-123",
                "message": "Summarize what we did today and propose next steps.",
                "agentId": "main",
            }
        }
    )
    sessionKey: str = Field(
        ...,
        description="OpenClaw session key for thread continuity. Use a stable value per thread.",
        examples=["clawboard:thread-123"],
        min_length=1,
        max_length=240,
    )
    message: str = Field(
        ...,
        description="User message content to send to OpenClaw.",
        examples=["Hello from Clawboard."],
        min_length=1,
        max_length=20_000,
    )
    agentId: Optional[str] = Field(
        default="main",
        description="OpenClaw agent id to route this request to.",
        examples=["main"],
    )
    attachmentIds: Optional[List[str]] = Field(
        default=None,
        description="Attachment IDs (from POST /api/attachments) to include in the OpenClaw request.",
        examples=[["att-123", "att-456"]],
        max_length=16,
    )


class OpenClawChatQueuedResponse(BaseModel):
    queued: bool = Field(description="Whether the request was accepted for processing.", examples=[True])
    requestId: str = Field(description="Server request identifier.", examples=["occhat-123e4567-e89b-12d3-a456-426614174000"])


class ReindexRequest(BaseModel):
    kind: Literal["topic", "task", "log"] = Field(description="Embedding namespace kind.")
    id: str = Field(description="Topic/task/log ID.")
    op: Literal["upsert", "delete"] = Field(default="upsert", description="Queue operation.")
    text: Optional[str] = Field(default=None, description="Canonical label text to embed.")
    topicId: Optional[str] = Field(default=None, description="Task parent topic ID when kind=task.")

    @model_validator(mode="after")
    def validate_for_operation(self):
        if self.op == "upsert":
            text = (self.text or "").strip()
            if not text:
                raise ValueError("text is required when op=upsert")
            self.text = text
        return self


class ClawgraphNode(BaseModel):
    id: str = Field(description="Stable graph node ID.", examples=["topic:topic-1"])
    label: str = Field(description="Human label.", examples=["Clawboard"])
    type: str = Field(description="Node type (topic|task|entity|agent).", examples=["topic"])
    score: float = Field(description="Node score (importance/centrality).", examples=[3.42])
    size: float = Field(description="Visual node size hint.", examples=[18.4])
    color: str = Field(description="Node color hint.", examples=["#ff8a4a"])
    meta: Dict[str, Any] = Field(description="Node metadata.", examples=[{"topicId": "topic-1"}])


class ClawgraphEdge(BaseModel):
    id: str = Field(description="Stable edge ID.", examples=["edge-1"])
    source: str = Field(description="Source node ID.", examples=["topic:topic-1"])
    target: str = Field(description="Target node ID.", examples=["task:task-2"])
    type: str = Field(
        description="Edge type (has_task|mentions|co_occurs|related_topic|related_task|agent_focus).",
        examples=["has_task"],
    )
    weight: float = Field(description="Relationship strength.", examples=[1.23])
    evidence: int = Field(description="Evidence count.", examples=[4])


class ClawgraphStats(BaseModel):
    nodeCount: int = Field(description="Total nodes in graph.")
    edgeCount: int = Field(description="Total edges in graph.")
    topicCount: int = Field(description="Topic nodes.")
    taskCount: int = Field(description="Task nodes.")
    entityCount: int = Field(description="Entity nodes.")
    agentCount: int = Field(description="Agent nodes.")
    density: float = Field(description="Approximate graph density.", examples=[0.12])


class ClawgraphResponse(BaseModel):
    generatedAt: str = Field(description="ISO timestamp for graph generation.")
    stats: ClawgraphStats = Field(description="Graph-level statistics.")
    nodes: List[ClawgraphNode] = Field(description="Graph nodes.")
    edges: List[ClawgraphEdge] = Field(description="Graph edges.")


class SessionRoutingItem(BaseModel):
    """One routing decision for a session (topic mandatory, task optional)."""

    ts: str = Field(description="Decision timestamp (ISO).", examples=["2026-02-10T18:00:00.000Z"])
    topicId: str = Field(description="Chosen topic id.", examples=["topic-1"])
    topicName: Optional[str] = Field(default=None, description="Chosen topic name (best-effort).", examples=["Clawboard"])
    taskId: Optional[str] = Field(default=None, description="Chosen task id (optional).", examples=["task-1"])
    taskTitle: Optional[str] = Field(default=None, description="Chosen task title (best-effort).", examples=["Ship onboarding wizard"])
    anchor: Optional[str] = Field(
        default=None,
        description="Compact intent anchor text used to resolve future follow-ups.",
        examples=["Fix the login redirect bug in NIMBUS."],
    )


class SessionRoutingMemoryOut(ModelBase):
    sessionKey: str = Field(description="Session key (source.sessionKey).")
    items: List[SessionRoutingItem] = Field(default_factory=list, description="Recent routing decisions (newest last).")
    createdAt: Optional[str] = Field(default=None, description="ISO timestamp when created.")
    updatedAt: Optional[str] = Field(default=None, description="ISO timestamp when last updated.")


class SessionRoutingAppend(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "sessionKey": "channel:discord|thread:123",
                "topicId": "topic-1",
                "topicName": "Clawboard",
                "taskId": "task-1",
                "taskTitle": "Ship onboarding wizard",
                "anchor": "Fix the login redirect bug in NIMBUS.",
                "ts": "2026-02-10T18:00:00.000Z",
            }
        }
    )

    sessionKey: str = Field(description="Session key to update.", min_length=1, max_length=512)
    topicId: str = Field(description="Chosen topic id.", min_length=1, max_length=128)
    topicName: Optional[str] = Field(default=None, description="Chosen topic name (best-effort).", max_length=200)
    taskId: Optional[str] = Field(default=None, description="Chosen task id (optional).", max_length=128)
    taskTitle: Optional[str] = Field(default=None, description="Chosen task title (best-effort).", max_length=200)
    anchor: Optional[str] = Field(default=None, description="Compact anchor text.", max_length=800)
    ts: Optional[str] = Field(default=None, description="Optional explicit timestamp (ISO).")
