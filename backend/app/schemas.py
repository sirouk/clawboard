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
    """Admin-only replay controls for classifier backfill."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "integrationLevel": "full",
                "replayMode": "reclassify",
            }
        }
    )
    integrationLevel: Literal["manual", "write", "full"] = Field(
        default="full",
        description="Set instance integrationLevel after reset.",
        examples=["full"],
    )
    replayMode: Literal["reclassify", "fresh"] = Field(
        default="reclassify",
        description=(
            "Replay strategy: 'reclassify' keeps existing topic/task links and only re-queues unassigned/failed "
            "conversation logs for classification; "
            "'fresh' clears derived topics/tasks first."
        ),
        examples=["reclassify"],
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


class SpaceOut(ModelBase):
    id: str = Field(description="Space ID.", examples=["space-default"])
    name: str = Field(description="Space name.", examples=["Default"])
    color: Optional[str] = Field(description="Optional space color #RRGGBB.", examples=["#FF8A4A"])
    defaultVisible: bool = Field(
        default=True,
        description="Seed policy used when new spaces are added and missing explicit connectivity edges are initialized.",
        examples=[True],
    )
    connectivity: Dict[str, bool] = Field(
        default_factory=dict,
        description="Outbound connectivity toggles by target space id.",
        examples=[{"space-work": True, "space-personal": False}],
    )
    createdAt: str = Field(description="ISO timestamp when the space was created.", examples=["2026-02-03T20:05:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp of last update.", examples=["2026-02-03T20:05:00.000Z"])


class SpaceUpsert(BaseModel):
    id: Optional[str] = Field(default=None, description="Space ID (omit to create).", examples=["space-work"])
    name: str = Field(description="Space name.", examples=["Work"])
    color: Optional[str] = Field(default=None, description="Optional space color #RRGGBB.", examples=["#4EA1FF"])


class SpaceConnectivityPatch(BaseModel):
    defaultVisible: Optional[bool] = Field(
        default=None,
        description=(
            "Optional seed visibility policy used for future spaces when missing connectivity edges are initialized. "
            "Does not retroactively override existing explicit connectivity edges."
        ),
        examples=[False],
    )
    connectivity: Dict[str, bool] = Field(
        default_factory=dict,
        description="Outbound connectivity toggles by target space id.",
        examples=[{"space-work": True, "space-personal": False}],
    )


class SpaceAllowedResponse(BaseModel):
    spaceId: str = Field(description="Resolved source space id.", examples=["space-default"])
    allowedSpaceIds: List[str] = Field(
        default_factory=list,
        description="Space ids that are currently visible/retrievable from the source space.",
        examples=[["space-default", "space-work"]],
    )


class TopicOut(ModelBase):
    id: str = Field(description="Topic ID.", examples=["topic-1"])
    spaceId: str = Field(description="Owning space ID.", examples=["space-default"])
    name: str = Field(description="Topic name.", examples=["Clawboard"])
    createdBy: Optional[str] = Field(
        description="Creation source (user | classifier | import).",
        examples=["user"],
    )
    sortIndex: int = Field(description="Manual ordering index (lower comes first).", examples=[0])
    color: Optional[str] = Field(description="Topic color #RRGGBB.", examples=["#FF8A4A"])
    description: Optional[str] = Field(description="Topic description.", examples=["Product and platform work."])
    priority: Optional[str] = Field(description="Priority (low | medium | high).", examples=["high"])
    status: Optional[str] = Field(description="Status (active | snoozed | archived).", examples=["active"])
    snoozedUntil: Optional[str] = Field(
        description="ISO timestamp when a snoozed topic should re-activate (nullable).",
        examples=["2026-02-09T18:00:00.000Z"],
    )
    tags: List[str] = Field(description="Freeform tags.", examples=[["product", "platform"]])
    parentId: Optional[str] = Field(description="Parent topic ID (for subtopics).", examples=["topic-1"])
    pinned: Optional[bool] = Field(description="Pinned topics sort to the top.", examples=[True])
    digest: Optional[str] = Field(
        default=None,
        description="Durable topic digest (system-managed summary; optional).",
        examples=["Focus: ship attachments + SSE watchdog; Next: roll out /api/context."],
    )
    digestUpdatedAt: Optional[str] = Field(
        default=None,
        description="ISO timestamp when digest was last updated (nullable).",
        examples=["2026-02-10T18:00:00.000Z"],
    )
    createdAt: str = Field(description="ISO timestamp when the topic was created.", examples=["2026-02-01T14:00:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp of last activity/update.", examples=["2026-02-03T20:05:00.000Z"])


class TaskOut(ModelBase):
    id: str = Field(description="Task ID.", examples=["task-1"])
    spaceId: str = Field(description="Owning space ID.", examples=["space-default"])
    topicId: Optional[str] = Field(description="Parent topic ID (nullable).", examples=["topic-1"])
    title: str = Field(description="Task title.", examples=["Ship onboarding wizard"])
    sortIndex: int = Field(description="Manual ordering index within the topic (lower comes first).", examples=[0])
    color: Optional[str] = Field(description="Task color #RRGGBB.", examples=["#4EA1FF"])
    status: str = Field(description="Task status (todo | doing | blocked | done).", examples=["doing"])
    pinned: Optional[bool] = Field(description="Pinned tasks sort to the top.", examples=[True])
    priority: Optional[str] = Field(description="Priority (low | medium | high).", examples=["high"])
    dueDate: Optional[str] = Field(description="Optional due date (ISO).", examples=["2026-02-05T00:00:00.000Z"])
    digest: Optional[str] = Field(
        default=None,
        description="Durable task digest (system-managed summary; optional).",
        examples=["Goal: make /api/context single-call; Progress: endpoint + plugin update merged."],
    )
    digestUpdatedAt: Optional[str] = Field(
        default=None,
        description="ISO timestamp when digest was last updated (nullable).",
        examples=["2026-02-10T18:00:00.000Z"],
    )
    snoozedUntil: Optional[str] = Field(
        description="ISO timestamp when a snoozed task should re-activate (nullable).",
        examples=["2026-02-09T18:00:00.000Z"],
    )
    tags: List[str] = Field(description="Freeform tags.", examples=[["ops", "follow-up"]])
    createdAt: str = Field(description="ISO timestamp when the task was created.", examples=["2026-02-02T10:00:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp of last update.", examples=["2026-02-03T19:55:00.000Z"])


class LogOut(ModelBase):
    id: str = Field(description="Log entry ID.", examples=["log-1"])
    spaceId: str = Field(description="Owning space ID.", examples=["space-default"])
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
    spaceId: str = Field(description="Owning space ID.", examples=["space-default"])
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


class LogChatCountsResponse(BaseModel):
    topicChatCounts: Dict[str, int] = Field(
        default_factory=dict,
        description="Aggregate topic-chat entry counts keyed by topic id (taskId is null).",
        examples=[{"topic-1": 12, "topic-2": 3}],
    )
    taskChatCounts: Dict[str, int] = Field(
        default_factory=dict,
        description="Aggregate task-chat entry counts keyed by task id.",
        examples=[{"task-1": 28, "task-2": 4}],
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
    spaceId: Optional[str] = Field(default=None, description="Owning space ID.", examples=["space-default"])
    name: str = Field(description="Topic name.", examples=["Clawboard"])
    color: Optional[str] = Field(default=None, description="Optional topic color #RRGGBB.", examples=["#FF8A4A"])
    description: Optional[str] = Field(default=None, description="Topic description.", examples=["Product work."])
    priority: Optional[str] = Field(default=None, description="Priority (low | medium | high).", examples=["high"])
    status: Optional[str] = Field(default=None, description="Status (active | snoozed | archived).", examples=["active"])
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
    spaceId: Optional[str] = Field(default=None, description="Owning space ID.", examples=["space-default"])
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
    spaceId: Optional[str] = Field(default=None, description="Owning space ID override.", examples=["space-default"])
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

    spaceId: Optional[str] = Field(default=None, description="Owning space ID.")
    topicId: Optional[str] = Field(default=None, description="Topic ID.")
    taskId: Optional[str] = Field(default=None, description="Task ID.")
    relatedLogId: Optional[str] = Field(default=None, description="Related log ID.")
    content: Optional[str] = Field(default=None, description="Content override.")
    summary: Optional[str] = Field(default=None, description="Summary override.")
    raw: Optional[str] = Field(default=None, description="Raw override.")
    classificationStatus: Optional[str] = Field(default=None, description="pending|classified|failed")
    classificationAttempts: Optional[int] = Field(default=None, description="Attempt count")
    classificationError: Optional[str] = Field(default=None, description="Last error")


class TopicPatch(BaseModel):
    """Patch fields on an existing topic (partial update)."""

    spaceId: Optional[str] = Field(default=None, description="Owning space ID.")
    name: Optional[str] = Field(default=None, description="Topic name.")
    color: Optional[str] = Field(default=None, description="Optional topic color #RRGGBB.")
    description: Optional[str] = Field(default=None, description="Topic description.")
    priority: Optional[str] = Field(default=None, description="Priority (low | medium | high).")
    status: Optional[str] = Field(default=None, description="Status (active | snoozed | archived).")
    snoozedUntil: Optional[str] = Field(default=None, description="ISO timestamp when snoozed topic re-activates.")
    tags: Optional[List[str]] = Field(default=None, description="Freeform tags.")
    parentId: Optional[str] = Field(default=None, description="Parent topic id.")
    pinned: Optional[bool] = Field(default=None, description="Pinned topic.")
    digest: Optional[str] = Field(default=None, description="Durable digest text (system-managed).")
    digestUpdatedAt: Optional[str] = Field(default=None, description="Digest updated timestamp (ISO).")


class TaskPatch(BaseModel):
    """Patch fields on an existing task (partial update)."""

    spaceId: Optional[str] = Field(default=None, description="Owning space ID.")
    title: Optional[str] = Field(default=None, description="Task title.")
    color: Optional[str] = Field(default=None, description="Optional task color #RRGGBB.")
    status: Optional[str] = Field(default=None, description="Task status (todo | doing | blocked | done).")
    priority: Optional[str] = Field(default=None, description="Priority (low | medium | high).")
    dueDate: Optional[str] = Field(default=None, description="Optional due date (ISO).")
    snoozedUntil: Optional[str] = Field(default=None, description="ISO timestamp when snoozed task re-activates.")
    pinned: Optional[bool] = Field(default=None, description="Pinned task.")
    tags: Optional[List[str]] = Field(default=None, description="Freeform tags.")
    topicId: Optional[str] = Field(default=None, description="Parent topic id (nullable).")
    digest: Optional[str] = Field(default=None, description="Durable digest text (system-managed).")
    digestUpdatedAt: Optional[str] = Field(default=None, description="Digest updated timestamp (ISO).")


class ContextResponse(BaseModel):
    """Prompt-ready layered context for an agent turn (plus structured data)."""

    ok: bool = Field(default=True, description="Whether context generation succeeded.")
    sessionKey: Optional[str] = Field(default=None, description="Session key used for continuity.")
    q: str = Field(default="", description="Normalized query used for retrieval.")
    mode: str = Field(default="auto", description="Context mode (auto|cheap|full|patient).")
    layers: List[str] = Field(default_factory=list, description="Emitted context layers/sections.")
    block: str = Field(default="", description="Prompt-ready context block (clipped to maxChars).")
    data: Dict[str, Any] = Field(default_factory=dict, description="Structured context payload.")


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
    spaces: List[SpaceOut] = Field(description="Spaces updated since timestamp.")
    topics: List[TopicOut] = Field(description="Topics updated since timestamp.")
    tasks: List[TaskOut] = Field(description="Tasks updated since timestamp.")
    logs: List[LogOutLite] = Field(description="Logs created since timestamp (lightweight, excludes raw).")
    drafts: List[DraftOut] = Field(description="Drafts updated since timestamp.")
    deletedLogIds: List[str] = Field(
        default_factory=list,
        description="Log IDs deleted since timestamp (tombstones for clients that missed SSE).",
        examples=[["log-123", "log-456"]],
    )


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
    spaceId: Optional[str] = Field(
        default=None,
        description="Optional board source space id to scope context/retrieval (e.g. space-work).",
        examples=["space-default"],
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
    topicOnly: Optional[bool] = Field(
        default=None,
        description="When true on a topic-scoped session, keep this send in topic chat only (no task routing).",
        examples=[True],
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


class OpenClawChatCancelRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "sessionKey": "clawboard:task:topic-abc:task-def",
                "requestId": "occhat-abc123",
            }
        }
    )
    sessionKey: str = Field(
        description="Session key to abort. All pending/retry/processing dispatch rows for this session are cancelled.",
        min_length=1,
        max_length=512,
    )
    requestId: Optional[str] = Field(
        default=None,
        description="Optional: narrow cancellation to a specific request ID (occhat-...). When omitted, all open queue rows for the session are cancelled.",
        max_length=128,
    )


class OpenClawChatCancelResponse(BaseModel):
    aborted: bool = Field(description="Whether chat.abort was sent to the gateway (best-effort).")
    queueCancelled: int = Field(description="Number of dispatch queue rows cancelled.")
    sessionKey: str = Field(description="Session key targeted.")
    sessionKeys: List[str] = Field(
        default_factory=list,
        description="All session keys targeted for cancellation (primary + linked subagent sessions).",
    )
    gatewayAbortCount: int = Field(
        default=0,
        description="Number of chat.abort RPC attempts issued to the gateway.",
    )


class OpenClawChatDispatchQuarantineRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "dryRun": True,
                "olderThanSeconds": 21600,
                "limit": 1000,
                "statuses": ["pending", "retry", "processing"],
                "syntheticOnly": True,
                "sessionKeyContains": "topic-smoke",
                "reason": "synthetic_backlog_quarantine",
            }
        }
    )
    dryRun: bool = Field(
        default=True,
        description="When true, return the matched rows without changing DB state.",
        examples=[True],
    )
    olderThanSeconds: int = Field(
        default=21600,
        ge=60,
        le=60 * 60 * 24 * 30,
        description="Only include rows created at least this many seconds ago.",
        examples=[21600],
    )
    limit: int = Field(
        default=1000,
        ge=1,
        le=20000,
        description="Maximum number of queue rows to inspect in one request.",
        examples=[1000],
    )
    statuses: List[str] = Field(
        default_factory=lambda: ["pending", "retry", "processing"],
        description="Dispatch statuses eligible for quarantine.",
        examples=[["pending", "retry", "processing"]],
    )
    syntheticOnly: bool = Field(
        default=True,
        description="Restrict matches to synthetic/test-like session/message markers.",
        examples=[True],
    )
    sessionKeyContains: Optional[str] = Field(
        default=None,
        max_length=240,
        description="Optional case-insensitive substring filter on sessionKey.",
        examples=["topic-smoke"],
    )
    requestIdContains: Optional[str] = Field(
        default=None,
        max_length=240,
        description="Optional case-insensitive substring filter on requestId.",
        examples=["occhat-"],
    )
    messageContains: Optional[str] = Field(
        default=None,
        max_length=240,
        description="Optional case-insensitive substring filter on message text.",
        examples=["canary"],
    )
    reason: Optional[str] = Field(
        default="admin_quarantine",
        max_length=160,
        description="Reason string stored in lastError for quarantined rows.",
        examples=["synthetic_backlog_quarantine"],
    )

    @model_validator(mode="after")
    def _normalize(self):
        allowed = {"pending", "retry", "processing"}
        normalized: List[str] = []
        seen: set[str] = set()
        for raw in self.statuses or []:
            status = str(raw or "").strip().lower()
            if status not in allowed or status in seen:
                continue
            seen.add(status)
            normalized.append(status)
        if not normalized:
            raise ValueError("statuses must include at least one of: pending, retry, processing")
        self.statuses = normalized
        self.sessionKeyContains = (self.sessionKeyContains or "").strip() or None
        self.requestIdContains = (self.requestIdContains or "").strip() or None
        self.messageContains = (self.messageContains or "").strip() or None
        reason = (self.reason or "").strip()
        self.reason = reason or "admin_quarantine"
        return self


class OpenClawChatDispatchQuarantineResponse(BaseModel):
    dryRun: bool = Field(description="Whether DB writes were skipped.")
    matched: int = Field(description="Number of rows matching the filters.")
    quarantined: int = Field(description="Number of rows updated to failed/quarantined.")
    cutoffCreatedAt: str = Field(description="Computed cutoff timestamp (UTC ISO).")
    statuses: List[str] = Field(description="Statuses included in this run.")
    syntheticOnly: bool = Field(description="Whether synthetic-only matching was enforced.")
    limit: int = Field(description="Max rows inspected.")
    reason: str = Field(description="Reason written to row lastError when quarantined.")
    filters: Dict[str, Optional[str]] = Field(description="Applied optional substring filters.")
    sample: List[Dict[str, Any]] = Field(description="Sample of matched rows.")


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


class ClassifierReplayRequest(BaseModel):
    """User-triggered classifier replay for an existing session thread."""

    anchorLogId: str = Field(
        description="Anchor log id (usually a user message) that starts the replay window.",
        min_length=1,
        max_length=128,
        examples=["log-123"],
    )
    mode: Literal["bundle", "from_here"] = Field(
        default="bundle",
        description="Replay scope: 'bundle' replays one request/response bundle; 'from_here' replays until end of session.",
        examples=["bundle"],
    )


class ClassifierReplayResponse(BaseModel):
    ok: bool = Field(default=True, description="Whether the replay request was accepted.", examples=[True])
    anchorLogId: str = Field(description="Anchor log id that started the replay.", examples=["log-123"])
    sessionKey: str = Field(description="Session key being replayed (source.sessionKey).", examples=["clawboard:topic:topic-1"])
    topicId: Optional[str] = Field(description="Resolved topic id for the session (if board-scoped).", examples=["topic-1"])
    logCount: int = Field(description="Number of logs marked pending for replay.", examples=[6])
    logIds: List[str] = Field(default_factory=list, description="IDs of logs marked pending for replay.")
