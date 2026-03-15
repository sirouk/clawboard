from __future__ import annotations

import logging
import os
import queue
import threading
import time
from typing import Any, Callable, Iterable

logger = logging.getLogger(__name__)

__all__ = [
    # Configuration constants
    "PRECOMPILE_ENABLED",
    "PRECOMPILE_TTL_SECONDS",
    "PRECOMPILE_MAX_KEYS",
    "PRECOMPILE_WARM_ON_STARTUP",
    "PRECOMPILE_WARM_LISTENER_ENABLED",
    "PRECOMPILE_WARM_MIN_INTERVAL_SECONDS",
    # Functions
    "_precompile_cache_key",
    "_precompile_key_lock",
    "_precompile_cache_get",
    "_precompile_cache_set",
    "_get_or_build_precompiled",
    "_warm_precompiled_defaults",
    "_precompile_warm_worker",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "1" if default else "0")
    return str(raw or "").strip().lower() in {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

PRECOMPILE_ENABLED = _env_flag("CLAWBOARD_PRECOMPILE_ENABLED", True)
PRECOMPILE_TTL_SECONDS = max(1.0, float(os.getenv("CLAWBOARD_PRECOMPILE_TTL_SECONDS", "8") or "8"))
PRECOMPILE_MAX_KEYS = max(8, int(os.getenv("CLAWBOARD_PRECOMPILE_MAX_KEYS", "32") or "32"))
PRECOMPILE_WARM_ON_STARTUP = _env_flag("CLAWBOARD_PRECOMPILE_WARM_ON_STARTUP", True)
PRECOMPILE_WARM_LISTENER_ENABLED = _env_flag("CLAWBOARD_PRECOMPILE_WARM_LISTENER_ENABLED", True)
PRECOMPILE_WARM_MIN_INTERVAL_SECONDS = max(
    0.25,
    float(os.getenv("CLAWBOARD_PRECOMPILE_WARM_MIN_INTERVAL_SECONDS", "1.5") or "1.5"),
)
CHANGES_PRECOMPILE_LIMIT_LOGS = max(
    100,
    min(20000, int(os.getenv("CLAWBOARD_CHANGES_PRECOMPILE_LIMIT_LOGS", "500") or "500")),
)
_PRECOMPILE_WARM_TRIGGER_EVENTS = {
    "space.upserted",
    "topic.upserted",
    "topic.deleted",
    "log.appended",
    "log.patched",
    "log.deleted",
    "draft.upserted",
}

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

_PRECOMPILE_CACHE_LOCK = threading.Lock()
_PRECOMPILE_CACHE: dict[str, dict[str, Any]] = {}
_PRECOMPILE_KEY_LOCKS: dict[str, threading.Lock] = {}

# ---------------------------------------------------------------------------
# Cache functions
# ---------------------------------------------------------------------------


def _precompile_cache_key(namespace: str, parts: Iterable[str]) -> str:
    normalized = [str(part).strip() for part in parts]
    return f"{namespace}|{'|'.join(normalized)}"


def _precompile_key_lock(cache_key: str) -> threading.Lock:
    with _PRECOMPILE_CACHE_LOCK:
        lock = _PRECOMPILE_KEY_LOCKS.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _PRECOMPILE_KEY_LOCKS[cache_key] = lock
        return lock


def _precompile_cache_get(cache_key: str, revision: str) -> Any | None:
    if not PRECOMPILE_ENABLED:
        return None
    now_mono = time.monotonic()
    with _PRECOMPILE_CACHE_LOCK:
        entry = _PRECOMPILE_CACHE.get(cache_key)
        if not entry:
            return None
        if str(entry.get("revision") or "") != revision:
            _PRECOMPILE_CACHE.pop(cache_key, None)
            return None
        expires_at = float(entry.get("expiresAtMonotonic") or 0.0)
        if expires_at < now_mono:
            _PRECOMPILE_CACHE.pop(cache_key, None)
            return None
        return entry.get("payload")


def _precompile_cache_set(cache_key: str, revision: str, payload: Any) -> None:
    if not PRECOMPILE_ENABLED:
        return
    now_mono = time.monotonic()
    with _PRECOMPILE_CACHE_LOCK:
        _PRECOMPILE_CACHE[cache_key] = {
            "revision": revision,
            "payload": payload,
            "builtAtMonotonic": now_mono,
            "expiresAtMonotonic": now_mono + PRECOMPILE_TTL_SECONDS,
        }
        if len(_PRECOMPILE_CACHE) <= PRECOMPILE_MAX_KEYS:
            return
        # Keep eviction deterministic: remove the oldest built entries first.
        overflow = len(_PRECOMPILE_CACHE) - PRECOMPILE_MAX_KEYS
        oldest = sorted(
            _PRECOMPILE_CACHE.items(),
            key=lambda item: float(item[1].get("builtAtMonotonic") or 0.0),
        )
        for stale_key, _entry in oldest[:overflow]:
            _PRECOMPILE_CACHE.pop(stale_key, None)
            _PRECOMPILE_KEY_LOCKS.pop(stale_key, None)


def _get_or_build_precompiled(
    *,
    namespace: str,
    key_parts: list[str],
    revision: str,
    build_fn: Callable[[], Any],
) -> tuple[Any, bool]:
    if not PRECOMPILE_ENABLED:
        return build_fn(), False
    cache_key = _precompile_cache_key(namespace, key_parts)
    cached = _precompile_cache_get(cache_key, revision)
    if cached is not None:
        return cached, True
    lock = _precompile_key_lock(cache_key)
    with lock:
        cached = _precompile_cache_get(cache_key, revision)
        if cached is not None:
            return cached, True
        payload = build_fn()
        _precompile_cache_set(cache_key, revision, payload)
        return payload, False


# ---------------------------------------------------------------------------
# Warmup functions
# ---------------------------------------------------------------------------


def _warm_precompiled_defaults() -> None:
    if not PRECOMPILE_ENABLED:
        return
    try:
        # Late imports to avoid circular dependencies.
        from .main import (
            _graph_revision_token,
            _clawgraph_cache_key_parts,
            _build_clawgraph_payload,
            _changes_revision_token,
            _changes_cache_key_parts,
            _build_changes_payload,
            _metrics_revision_token,
            _build_metrics_payload,
        )
        from .db import get_session

        with get_session() as session:
            # Warm the graph shape used by the UI and the endpoint defaults.
            graph_presets = [
                (140, 320, 0.08, 3200, True),  # src/components/clawgraph-live.tsx
                (120, 260, 0.16, 2400, True),  # /api/clawgraph defaults
            ]
            graph_revision = _graph_revision_token(session)
            for max_entities, max_nodes, min_edge_weight, limit_logs, include_pending in graph_presets:
                key_parts = _clawgraph_cache_key_parts(
                    max_entities=max_entities,
                    max_nodes=max_nodes,
                    min_edge_weight=min_edge_weight,
                    limit_logs=limit_logs,
                    include_pending=include_pending,
                    allowed_space_ids=None,
                )
                _get_or_build_precompiled(
                    namespace="clawgraph",
                    key_parts=key_parts,
                    revision=graph_revision,
                    build_fn=lambda me=max_entities, mn=max_nodes, ew=min_edge_weight, ll=limit_logs, ip=include_pending: _build_clawgraph_payload(
                        session,
                        max_entities=me,
                        max_nodes=mn,
                        min_edge_weight=ew,
                        limit_logs=ll,
                        include_pending=ip,
                        allowed_space_ids=None,
                    ),
                )

            changes_revision = _changes_revision_token(session)
            _get_or_build_precompiled(
                namespace="changes",
                key_parts=_changes_cache_key_parts(
                    limit_logs=CHANGES_PRECOMPILE_LIMIT_LOGS,
                    include_raw=False,
                    allowed_space_ids=None,
                ),
                revision=changes_revision,
                build_fn=lambda: _build_changes_payload(
                    session,
                    since=None,
                    since_seq=None,
                    limit_logs=CHANGES_PRECOMPILE_LIMIT_LOGS,
                    include_raw=False,
                    allowed_space_ids=None,
                ),
            )

            metrics_revision = _metrics_revision_token(session)
            _get_or_build_precompiled(
                namespace="metrics",
                key_parts=["default"],
                revision=metrics_revision,
                build_fn=lambda: _build_metrics_payload(session),
            )
    except Exception:
        logger.exception("precompile warmup failed")
        return


def _precompile_warm_worker() -> None:
    if not PRECOMPILE_ENABLED:
        return

    # Late imports to avoid circular dependencies.
    from .background import _BACKGROUND_STOP_EVENT
    from .events import event_hub

    if PRECOMPILE_WARM_ON_STARTUP:
        _warm_precompiled_defaults()

    subscriber = event_hub.subscribe()
    pending = False
    next_warm_at = 0.0
    try:
        while not _BACKGROUND_STOP_EVENT.is_set():
            timeout = 30.0
            if pending:
                timeout = max(0.05, next_warm_at - time.monotonic())
            try:
                _event_id, payload = subscriber.get(timeout=min(timeout, 1.0))
            except queue.Empty:
                if pending and time.monotonic() >= next_warm_at:
                    _warm_precompiled_defaults()
                    pending = False
                continue

            event_type = str((payload or {}).get("type") or "")
            if event_type not in _PRECOMPILE_WARM_TRIGGER_EVENTS:
                continue
            pending = True
            next_warm_at = time.monotonic() + PRECOMPILE_WARM_MIN_INTERVAL_SECONDS
    finally:
        event_hub.unsubscribe(subscriber)
