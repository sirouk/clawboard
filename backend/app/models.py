from __future__ import annotations

from typing import Optional, List, Dict, Any
from sqlmodel import SQLModel, Field
from sqlalchemy import Column, JSON


class InstanceConfig(SQLModel, table=True):
    id: Optional[int] = Field(default=1, primary_key=True)
    title: str
    integrationLevel: str
    updatedAt: str


class Topic(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    description: Optional[str] = None
    priority: Optional[str] = "medium"
    status: Optional[str] = "active"
    tags: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    parentId: Optional[str] = None
    pinned: Optional[bool] = False
    createdAt: str
    updatedAt: str


class Task(SQLModel, table=True):
    id: str = Field(primary_key=True)
    topicId: Optional[str] = Field(default=None, foreign_key="topic.id")
    title: str
    status: str
    pinned: Optional[bool] = False
    priority: Optional[str] = "medium"
    dueDate: Optional[str] = None
    createdAt: str
    updatedAt: str


class LogEntry(SQLModel, table=True):
    id: str = Field(primary_key=True)
    topicId: Optional[str] = Field(default=None, foreign_key="topic.id")
    taskId: Optional[str] = Field(default=None, foreign_key="task.id")
    relatedLogId: Optional[str] = None
    type: str
    content: str
    summary: Optional[str] = None
    raw: Optional[str] = None
    createdAt: str
    agentId: Optional[str] = None
    agentLabel: Optional[str] = None
    source: Optional[Dict[str, Any]] = Field(default=None, sa_column=Column(JSON))
