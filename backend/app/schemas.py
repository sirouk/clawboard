from __future__ import annotations

from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
from pydantic.config import ConfigDict


class ModelBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)


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
        description="Whether write endpoints require X-Clawboard-Token.",
        examples=[False],
    )


class InstanceOut(ModelBase):
    id: int = Field(description="Singleton config row ID (always 1).", examples=[1])
    title: str = Field(description="Instance title displayed in the UI.", examples=["Clawboard Ops"])
    integrationLevel: str = Field(description="Integration depth (manual | write | full).", examples=["manual"])
    updatedAt: str = Field(description="ISO timestamp of the last config update.", examples=["2026-02-03T20:05:00.000Z"])


class TopicOut(ModelBase):
    id: str = Field(description="Topic ID.", examples=["topic-1"])
    name: str = Field(description="Topic name.", examples=["Clawboard"])
    description: Optional[str] = Field(description="Topic description.", examples=["Product and platform work."])
    priority: Optional[str] = Field(description="Priority (low | medium | high).", examples=["high"])
    status: Optional[str] = Field(description="Status (active | archived).", examples=["active"])
    tags: List[str] = Field(description="Freeform tags.", examples=[["product", "platform"]])
    parentId: Optional[str] = Field(description="Parent topic ID (for subtopics).", examples=["topic-1"])
    pinned: Optional[bool] = Field(description="Pinned topics sort to the top.", examples=[True])
    createdAt: str = Field(description="ISO timestamp when the topic was created.", examples=["2026-02-01T14:00:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp of last activity/update.", examples=["2026-02-03T20:05:00.000Z"])


class TaskOut(ModelBase):
    id: str = Field(description="Task ID.", examples=["task-1"])
    topicId: Optional[str] = Field(description="Parent topic ID (nullable).", examples=["topic-1"])
    title: str = Field(description="Task title.", examples=["Ship onboarding wizard"])
    status: str = Field(description="Task status (todo | doing | blocked | done).", examples=["doing"])
    pinned: Optional[bool] = Field(description="Pinned tasks sort to the top.", examples=[True])
    priority: Optional[str] = Field(description="Priority (low | medium | high).", examples=["high"])
    dueDate: Optional[str] = Field(description="Optional due date (ISO).", examples=["2026-02-05T00:00:00.000Z"])
    createdAt: str = Field(description="ISO timestamp when the task was created.", examples=["2026-02-02T10:00:00.000Z"])
    updatedAt: str = Field(description="ISO timestamp of last update.", examples=["2026-02-03T19:55:00.000Z"])


class LogOut(ModelBase):
    id: str = Field(description="Log entry ID.", examples=["log-1"])
    topicId: Optional[str] = Field(description="Associated topic ID (nullable).", examples=["topic-1"])
    taskId: Optional[str] = Field(description="Associated task ID (nullable).", examples=["task-1"])
    relatedLogId: Optional[str] = Field(description="Link to original log (for notes).", examples=["log-12"])
    type: str = Field(description="Log type (conversation | action | note | system | import).", examples=["conversation"])
    content: str = Field(description="Full log content.", examples=["Defined onboarding wizard steps and token flow."])
    summary: Optional[str] = Field(description="Concise summary.", examples=["Defined onboarding wizard steps."])
    raw: Optional[str] = Field(description="Raw prompt/response payload.", examples=["User: ...\nAssistant: ..."])
    createdAt: str = Field(description="ISO timestamp when the log was created.", examples=["2026-02-02T10:05:00.000Z"])
    agentId: Optional[str] = Field(description="Agent identifier.", examples=["main"])
    agentLabel: Optional[str] = Field(description="Agent label.", examples=["User"])
    source: Optional[Dict[str, Any]] = Field(
        description="Source metadata (channel, sessionKey, messageId).",
        examples=[{"channel": "discord", "sessionKey": "main", "messageId": "msg-001"}],
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
    description: Optional[str] = Field(default=None, description="Topic description.", examples=["Product work."])
    priority: Optional[str] = Field(default=None, description="Priority (low | medium | high).", examples=["high"])
    status: Optional[str] = Field(default=None, description="Status (active | archived).", examples=["active"])
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
    status: Optional[str] = Field(
        default=None, description="Task status (todo | doing | blocked | done).", examples=["doing"]
    )
    pinned: Optional[bool] = Field(default=None, description="Pin task to top.", examples=[True])
    priority: Optional[str] = Field(default=None, description="Priority (low | medium | high).", examples=["high"])
    dueDate: Optional[str] = Field(default=None, description="Optional due date (ISO).", examples=["2026-02-05T00:00:00.000Z"])


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


class ChangesResponse(BaseModel):
    topics: List[TopicOut] = Field(description="Topics updated since timestamp.")
    tasks: List[TaskOut] = Field(description="Tasks updated since timestamp.")
    logs: List[LogOut] = Field(description="Logs created since timestamp.")
