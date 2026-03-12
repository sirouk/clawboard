from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

__all__ = [
    "_BACKGROUND_STOP_EVENT",
    "_BACKGROUND_THREADS",
    "_BACKGROUND_THREADS_LOCK",
    "_BACKGROUND_ERROR_LOG_LOCK",
    "_BACKGROUND_ERROR_LOG_LAST_AT",
    "_ENV_CLAMP_WARNING_LOCK",
    "_ENV_CLAMP_WARNED",
    "_background_sleep",
    "_start_background_thread",
    "_log_background_worker_exception",
    "_warn_env_clamp_once",
]

_BACKGROUND_STOP_EVENT = threading.Event()
_BACKGROUND_THREADS: list[threading.Thread] = []
_BACKGROUND_THREADS_LOCK = threading.Lock()
_BACKGROUND_ERROR_LOG_LOCK = threading.Lock()
_BACKGROUND_ERROR_LOG_LAST_AT: dict[str, float] = {}
_ENV_CLAMP_WARNING_LOCK = threading.Lock()
_ENV_CLAMP_WARNED: set[str] = set()


def _background_sleep(timeout_seconds: float) -> bool:
    """Sleep until timeout or shutdown. Returns True when shutdown was requested."""
    return _BACKGROUND_STOP_EVENT.wait(max(0.0, float(timeout_seconds)))


def _start_background_thread(
    *,
    target: Callable[..., Any],
    name: str,
    kwargs: dict[str, Any] | None = None,
) -> threading.Thread:
    thread = threading.Thread(
        target=target,
        kwargs=kwargs or {},
        name=name,
        daemon=True,
    )
    thread.start()
    with _BACKGROUND_THREADS_LOCK:
        _BACKGROUND_THREADS.append(thread)
    return thread


def _log_background_worker_exception(worker_name: str, *, throttle_seconds: float = 60.0) -> None:
    now_mono = time.monotonic()
    with _BACKGROUND_ERROR_LOG_LOCK:
        last_at = _BACKGROUND_ERROR_LOG_LAST_AT.get(worker_name)
        if last_at is not None and (now_mono - last_at) < max(1.0, float(throttle_seconds)):
            return
        _BACKGROUND_ERROR_LOG_LAST_AT[worker_name] = now_mono
    logger.exception("%s crashed; continuing background loop", worker_name)


def _warn_env_clamp_once(name: str, raw: str, *, clamped: float, min_value: float, max_value: float) -> None:
    with _ENV_CLAMP_WARNING_LOCK:
        if name in _ENV_CLAMP_WARNED:
            return
        _ENV_CLAMP_WARNED.add(name)
    logger.warning(
        "%s=%s is outside the supported range [%s, %s]; using %s instead",
        name,
        raw,
        min_value,
        max_value,
        clamped,
    )
