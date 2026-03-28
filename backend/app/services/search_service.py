from __future__ import annotations

import time
from typing import Any


def search_cache_stats(main_module: Any) -> dict[str, Any]:
    with main_module._SEARCH_RESULT_CACHE_LOCK:
        cache_size = len(main_module._SEARCH_RESULT_CACHE)
    return {
        "size": cache_size,
        "maxKeys": int(main_module.SEARCH_RESULT_CACHE_MAX_KEYS),
        "ttlSeconds": float(main_module.SEARCH_RESULT_CACHE_TTL_SECONDS),
        "mode": str(main_module.SEARCH_MODE),
        "busyFallbackLimitTopics": int(main_module.SEARCH_BUSY_FALLBACK_LIMIT_TOPICS),
        "busyFallbackLimitLogs": int(main_module.SEARCH_BUSY_FALLBACK_LIMIT_LOGS),
    }


def build_search_response(
    main_module: Any,
    *,
    q: str,
    semantic_query: str | None,
    topic_id: str | None,
    session_key: str | None,
    space_id: str | None,
    allowed_space_ids_raw: str | None,
    include_pending: bool,
    limit_topics: int,
    limit_logs: int,
) -> dict[str, Any]:
    query = (q or "").strip()
    started_at = time.perf_counter()
    query_tokens = main_module._search_query_tokens(query.lower())
    query_has_deep_signal = len(query_tokens) >= 2 and len(query) >= 6
    if len(query) < 1:
        return {
            "query": "",
            "mode": "empty",
            "topics": [],
            "logs": [],
            "notes": [],
            "matchedTopicIds": [],
            "matchedLogIds": [],
            "searchMeta": {
                "degraded": False,
                "gateAcquired": True,
                "gateWaitMs": 0.0,
                "durationMs": round((time.perf_counter() - started_at) * 1000.0, 2),
            },
        }

    wait_seconds = max(0.0, main_module.SEARCH_CONCURRENCY_WAIT_SECONDS)
    gate_wait_started = time.perf_counter()
    acquired = main_module._SEARCH_QUERY_GATE.acquire(timeout=wait_seconds)
    gate_wait_ms = round((time.perf_counter() - gate_wait_started) * 1000.0, 2)
    degraded_busy_fallback = not acquired
    effective_limit_topics = int(limit_topics)
    effective_limit_logs = int(limit_logs)
    allow_deep_content_scan = bool(query_has_deep_signal)
    if degraded_busy_fallback:
        effective_limit_topics = min(
            effective_limit_topics,
            max(1, main_module.SEARCH_BUSY_FALLBACK_LIMIT_TOPICS),
        )
        effective_limit_logs = min(
            effective_limit_logs,
            max(10, main_module.SEARCH_BUSY_FALLBACK_LIMIT_LOGS),
        )
        allow_deep_content_scan = False
    try:
        with main_module.get_session() as session:
            resolved_source_space_id = main_module._resolve_source_space_id(
                session,
                explicit_space_id=space_id,
                session_key=session_key,
            )
            allowed_space_ids = main_module._resolve_allowed_space_ids(
                session,
                source_space_id=resolved_source_space_id,
                allowed_space_ids_raw=allowed_space_ids_raw,
            )
            revision = main_module._graph_revision_token(session)
            cache_key = main_module._search_result_cache_key(
                query=query,
                semantic_query=semantic_query,
                revision=revision,
                topic_id=topic_id,
                session_key=session_key,
                include_pending=include_pending,
                limit_topics=effective_limit_topics,
                limit_logs=effective_limit_logs,
                allow_deep_content_scan=allow_deep_content_scan,
                allowed_space_ids=allowed_space_ids,
            )
            cached_result = main_module._search_result_cache_get(cache_key)
            if cached_result is not None:
                duration_ms = round((time.perf_counter() - started_at) * 1000.0, 2)
                cached_meta = dict(cached_result.get("searchMeta") or {})
                cached_meta.update(
                    {
                        "degraded": bool(degraded_busy_fallback),
                        "gateAcquired": bool(acquired),
                        "gateWaitMs": float(gate_wait_ms),
                        "durationMs": float(duration_ms),
                        "allowDeepContentScan": bool(allow_deep_content_scan),
                        "effectiveLimits": {
                            "topics": int(effective_limit_topics),
                            "logs": int(effective_limit_logs),
                        },
                        "cacheHit": True,
                    }
                )
                cached_result["searchMeta"] = cached_meta
                if degraded_busy_fallback:
                    mode = str(cached_result.get("mode") or "")
                    cached_result["mode"] = f"{mode}+busy-fallback" if mode else "busy-fallback"
                    cached_result["degraded"] = True
                return cached_result
            result = main_module._search_impl(
                session,
                query,
                topic_id=topic_id,
                allowed_space_ids=allowed_space_ids,
                session_key=session_key,
                include_pending=include_pending,
                limit_topics=effective_limit_topics,
                limit_logs=effective_limit_logs,
                allow_deep_content_scan=allow_deep_content_scan,
                semantic_query=semantic_query,
            )
            duration_ms = round((time.perf_counter() - started_at) * 1000.0, 2)
            meta = dict(result.get("searchMeta") or {})
            meta.update(
                {
                    "degraded": bool(degraded_busy_fallback),
                    "gateAcquired": bool(acquired),
                    "gateWaitMs": float(gate_wait_ms),
                    "durationMs": float(duration_ms),
                    "allowDeepContentScan": bool(allow_deep_content_scan),
                    "effectiveLimits": {
                        "topics": int(effective_limit_topics),
                        "logs": int(effective_limit_logs),
                    },
                    "cacheHit": False,
                }
            )
            enriched = dict(result)
            enriched["searchMeta"] = meta
            if degraded_busy_fallback:
                mode = str(enriched.get("mode") or "")
                enriched["mode"] = f"{mode}+busy-fallback" if mode else "busy-fallback"
                enriched["degraded"] = True
                return enriched
            main_module._search_result_cache_set(cache_key, enriched)
            return enriched
    finally:
        if acquired:
            main_module._SEARCH_QUERY_GATE.release()
