from __future__ import annotations

from typing import Optional, List, Dict, Any
from pydantic import BaseModel


class InstanceUpdate(BaseModel):
    title: Optional[str] = None
    integrationLevel: Optional[str] = None


class InstanceResponse(BaseModel):
    instance: Dict[str, Any]
    tokenRequired: bool


class TopicUpsert(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    tags: Optional[List[str]] = None
    parentId: Optional[str] = None
    pinned: Optional[bool] = None


class TaskUpsert(BaseModel):
    id: Optional[str] = None
    topicId: Optional[str] = None
    title: str
    status: Optional[str] = None
    pinned: Optional[bool] = None
    priority: Optional[str] = None
    dueDate: Optional[str] = None


class LogAppend(BaseModel):
    topicId: Optional[str] = None
    taskId: Optional[str] = None
    relatedLogId: Optional[str] = None
    type: str
    content: str
    summary: Optional[str] = None
    raw: Optional[str] = None
    createdAt: Optional[str] = None
    agentId: Optional[str] = None
    agentLabel: Optional[str] = None
    source: Optional[Dict[str, Any]] = None
