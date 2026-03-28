from __future__ import annotations

from typing import Any

from fastapi import Depends, FastAPI

from ..auth import require_token
from ..schemas import (
    OpenClawChatCancelResponse,
    OpenClawChatQueuedResponse,
    OpenClawResolveBoardSendResponse,
)
from ..schemas_openclaw_skills import OpenClawSkillsResponse, OpenClawWorkspacesResponse


def register_openclaw_routes(app: FastAPI, handlers: Any) -> None:
    app.add_api_route(
        "/api/openclaw/resolve-board-send",
        endpoint=handlers.resolve_board_send,
        methods=["POST"],
        dependencies=[Depends(require_token)],
        response_model=OpenClawResolveBoardSendResponse,
        tags=["openclaw"],
    )
    app.add_api_route(
        "/api/openclaw/chat",
        endpoint=handlers.openclaw_chat,
        methods=["POST"],
        dependencies=[Depends(require_token)],
        response_model=OpenClawChatQueuedResponse,
        tags=["openclaw"],
    )
    app.add_api_route(
        "/api/openclaw/chat",
        endpoint=handlers.openclaw_chat_cancel,
        methods=["DELETE"],
        dependencies=[Depends(require_token)],
        response_model=OpenClawChatCancelResponse,
        tags=["openclaw"],
    )
    app.add_api_route(
        "/api/openclaw/workspaces",
        endpoint=handlers.openclaw_workspaces,
        methods=["GET"],
        dependencies=[Depends(require_token)],
        response_model=OpenClawWorkspacesResponse,
        tags=["openclaw"],
    )
    app.add_api_route(
        "/api/openclaw/skills",
        endpoint=handlers.openclaw_skills,
        methods=["GET"],
        dependencies=[Depends(require_token)],
        response_model=OpenClawSkillsResponse,
        tags=["openclaw"],
    )
    app.add_api_route(
        "/api/openclaw/chat-dispatch/status",
        endpoint=handlers.openclaw_chat_dispatch_status,
        methods=["GET"],
        dependencies=[Depends(require_token)],
        tags=["openclaw"],
    )
    app.add_api_route(
        "/api/openclaw/history-sync/status",
        endpoint=handlers.openclaw_history_sync_status,
        methods=["GET"],
        dependencies=[Depends(require_token)],
        tags=["openclaw"],
    )
