from __future__ import annotations

from typing import Any

from fastapi import Depends, FastAPI

from ..auth import require_token
from ..schemas import InstanceResponse


def register_system_routes(app: FastAPI, handlers: Any) -> None:
    app.add_api_route("/api/health", endpoint=handlers.health, methods=["GET"])
    app.add_api_route("/api/stream", endpoint=handlers.stream_events, methods=["GET"])
    app.add_api_route(
        "/api/config",
        endpoint=handlers.get_config,
        methods=["GET"],
        response_model=InstanceResponse,
        tags=["config"],
    )
    app.add_api_route(
        "/api/config",
        endpoint=handlers.update_config,
        methods=["POST"],
        dependencies=[Depends(require_token)],
        response_model=InstanceResponse,
        tags=["config"],
    )
    app.add_api_route("/api/metrics", endpoint=handlers.metrics, methods=["GET"], tags=["metrics"])
