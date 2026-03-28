from __future__ import annotations

from typing import Any, List

from fastapi import Depends, FastAPI

from ..auth import require_token
from ..schemas import ChangesResponse, ContextResponse, LogChatCountsResponse, LogOut


def register_log_routes(app: FastAPI, handlers: Any) -> None:
    app.add_api_route(
        "/api/log",
        endpoint=handlers.list_logs,
        methods=["GET"],
        response_model=List[LogOut],
        tags=["logs"],
    )
    app.add_api_route(
        "/api/log/chat-counts",
        endpoint=handlers.get_log_chat_counts,
        methods=["GET"],
        response_model=LogChatCountsResponse,
        tags=["logs"],
    )
    app.add_api_route(
        "/api/log/{log_id}",
        endpoint=handlers.get_log,
        methods=["GET"],
        response_model=LogOut,
        tags=["logs"],
    )
    app.add_api_route(
        "/api/log",
        endpoint=handlers.append_log,
        methods=["POST"],
        dependencies=[Depends(require_token)],
        response_model=LogOut,
        tags=["logs"],
    )
    app.add_api_route(
        "/api/ingest",
        endpoint=handlers.enqueue_log,
        methods=["POST"],
        dependencies=[Depends(require_token)],
        tags=["logs"],
    )
    app.add_api_route(
        "/api/log/{log_id}",
        endpoint=handlers.patch_log,
        methods=["PATCH"],
        dependencies=[Depends(require_token)],
        response_model=LogOut,
        tags=["logs"],
    )
    app.add_api_route(
        "/api/log/{log_id}",
        endpoint=handlers.delete_log,
        methods=["DELETE"],
        dependencies=[Depends(require_token)],
        tags=["logs"],
    )
    app.add_api_route(
        "/api/log/{log_id}/purge_forward",
        endpoint=handlers.purge_log_forward,
        methods=["POST"],
        dependencies=[Depends(require_token)],
        tags=["logs"],
    )
    app.add_api_route(
        "/api/changes",
        endpoint=handlers.list_changes,
        methods=["GET"],
        response_model=ChangesResponse,
        tags=["changes"],
    )
    app.add_api_route(
        "/api/context",
        endpoint=handlers.context,
        methods=["GET"],
        response_model=ContextResponse,
        tags=["context"],
    )
    app.add_api_route("/api/search", endpoint=handlers.search, methods=["GET"], tags=["search"])
