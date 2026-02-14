from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel


class OpenClawSkill(BaseModel):
    name: str
    description: Optional[str] = None
    emoji: Optional[str] = None
    eligible: Optional[bool] = None
    disabled: Optional[bool] = None
    always: Optional[bool] = None
    source: Optional[str] = None


class OpenClawSkillsResponse(BaseModel):
    agentId: str
    workspaceDir: Optional[str] = None
    skills: List[OpenClawSkill]
