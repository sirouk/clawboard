from __future__ import annotations

from typing import Any, List

from fastapi import Depends, FastAPI

from ..auth import require_token
from ..schemas import TopicOut, TopicThreadResponse


def register_topic_routes(app: FastAPI, handlers: Any) -> None:
    app.add_api_route(
        "/api/topics",
        endpoint=handlers.list_topics,
        methods=["GET"],
        response_model=List[TopicOut],
        tags=["topics"],
    )
    app.add_api_route(
        "/api/topics/{topic_id}",
        endpoint=handlers.get_topic,
        methods=["GET"],
        response_model=TopicOut,
        tags=["topics"],
    )
    app.add_api_route(
        "/api/topics/{topic_id}",
        endpoint=handlers.patch_topic,
        methods=["PATCH"],
        dependencies=[Depends(require_token)],
        response_model=TopicOut,
        tags=["topics"],
    )
    app.add_api_route(
        "/api/topics/reorder",
        endpoint=handlers.reorder_topics,
        methods=["POST"],
        dependencies=[Depends(require_token)],
        tags=["topics"],
    )
    app.add_api_route(
        "/api/topics",
        endpoint=handlers.upsert_topic,
        methods=["POST"],
        dependencies=[Depends(require_token)],
        response_model=TopicOut,
        tags=["topics"],
    )
    app.add_api_route(
        "/api/topics/{topic_id}",
        endpoint=handlers.delete_topic,
        methods=["DELETE"],
        dependencies=[Depends(require_token)],
        tags=["topics"],
    )
    app.add_api_route(
        "/api/topics/{topic_id}/thread",
        endpoint=handlers.get_topic_thread,
        methods=["GET"],
        response_model=TopicThreadResponse,
        tags=["topics"],
    )
