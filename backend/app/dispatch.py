from __future__ import annotations

"""OpenClaw chat dispatch system — queue management, workers, and session locks."""

import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, exists, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased
from sqlmodel import select

from .attachments import _normalize_mime_type
from .background import _BACKGROUND_STOP_EVENT, _background_sleep, _log_background_worker_exception
from .db import get_session
from .models import Attachment, LogEntry, OpenClawChatDispatchQueue

logger = logging.getLogger(__name__)

__all__ = [
    # Configuration
    "_openclaw_chat_dispatch_enabled",
    "_openclaw_chat_dispatch_poll_seconds",
    "_openclaw_chat_dispatch_workers",
    "_openclaw_chat_dispatch_hot_window_seconds",
    "_openclaw_chat_dispatch_stale_processing_seconds",
    "_openclaw_chat_dispatch_max_retry_delay_seconds",
    "_openclaw_chat_dispatch_max_attempts",
    "_openclaw_chat_dispatch_recovery_lookback_seconds",
    "_openclaw_chat_dispatch_recovery_max_rows",
    "_openclaw_chat_dispatch_recovery_interval_seconds",
    "_openclaw_chat_dispatch_auto_quarantine_enabled",
    "_openclaw_chat_dispatch_auto_quarantine_seconds",
    "_openclaw_chat_dispatch_auto_quarantine_limit",
    "_openclaw_chat_dispatch_auto_quarantine_synthetic_only",
    # Queue management
    "_iso_after_seconds",
    "_openclaw_chat_dispatch_backoff_seconds",
    "_openclaw_chat_dispatch_is_terminal_error",
    "_enqueue_openclaw_chat_dispatch",
    "_openclaw_chat_dispatch_claim_next_job",
    "_openclaw_chat_dispatch_mark_sent",
    "_openclaw_chat_dispatch_mark_retry",
    "_openclaw_chat_dispatch_mark_failed",
    "_openclaw_chat_dispatch_recover_stale_processing_jobs",
    "_openclaw_chat_dispatch_auto_quarantine_stale_rows",
    "_openclaw_chat_dispatch_resolve_attachments",
    "_recover_openclaw_chat_dispatch_queue",
    "_openclaw_chat_dispatch_wakeup",
    "_openclaw_chat_dispatch_worker",
    "_openclaw_chat_dispatch_row_looks_synthetic",
    # Global state
    "_OPENCLAW_CHAT_DISPATCH_CLAIM_LOCK",
    "_OPENCLAW_CHAT_DISPATCH_PROCESS_STARTED_AT_ISO",
    "_OPENCLAW_CHAT_DISPATCH_MAINTENANCE_LOCK",
    "_OPENCLAW_CHAT_DISPATCH_LAST_RECOVERY_AT",
    "_OPENCLAW_CHAT_DISPATCH_WAKEUP",
    "_OPENCLAW_CHAT_DISPATCH_SYNTHETIC_MARKERS",
    # Session lock management
    "_OPENCLAW_CHAT_SESSION_LOCKS",
    "_OPENCLAW_CHAT_SESSION_LOCKS_GUARD",
    "_openclaw_chat_dispatch_session_key",
    "_openclaw_chat_session_lock_ttl_seconds",
    "_openclaw_chat_session_lock_max_entries",
    "_openclaw_chat_prune_session_locks_locked",
    "_openclaw_chat_acquire_session_lock",
    "_openclaw_chat_release_session_lock",
    # Utilities (local copies)
    "now_iso",
    "normalize_iso",
    "_clip",
]


# ---------------------------------------------------------------------------
# Utility helpers (local copies to avoid circular imports with main)
# ---------------------------------------------------------------------------


def now_iso() -> str:
    # Always emit a stable, lexicographically sortable UTC ISO string.
    # Using a fixed timespec avoids mixed precision (seconds vs micros) which can break ordering.
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_iso(value: str | None) -> str | None:
    """Normalize a timestamp to our canonical UTC ISO string (milliseconds + Z)."""
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        # Python can't parse trailing "Z" via fromisoformat.
        candidate = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
        dt = datetime.fromisoformat(candidate)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except Exception:
        return None


def _clip(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "\u2026"


# ---------------------------------------------------------------------------
# Configuration functions
# ---------------------------------------------------------------------------


def _openclaw_chat_dispatch_enabled() -> bool:
    return os.getenv("OPENCLAW_CHAT_DISPATCH_DISABLE", "").strip() != "1"


def _openclaw_chat_dispatch_poll_seconds() -> float:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_POLL_SECONDS", "1.0").strip()
    try:
        value = float(raw)
    except Exception:
        value = 1.0
    return max(0.2, min(30.0, value))


def _openclaw_chat_dispatch_workers() -> int:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_WORKERS", "4").strip()
    try:
        value = int(raw)
    except Exception:
        value = 4
    return max(1, min(32, value))


def _openclaw_chat_dispatch_hot_window_seconds() -> int:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_HOT_WINDOW_SECONDS", "900").strip()
    try:
        value = int(raw)
    except Exception:
        value = 900
    return max(30, min(604800, value))


def _openclaw_chat_dispatch_stale_processing_seconds() -> float:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_STALE_PROCESSING_SECONDS", "180").strip()
    try:
        value = float(raw)
    except Exception:
        value = 180.0
    return max(10.0, min(86400.0, value))


def _openclaw_chat_dispatch_max_retry_delay_seconds() -> float:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_MAX_RETRY_DELAY_SECONDS", "300").strip()
    try:
        value = float(raw)
    except Exception:
        value = 300.0
    return max(5.0, min(86400.0, value))


def _openclaw_chat_dispatch_max_attempts() -> int:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_MAX_ATTEMPTS", "0").strip()
    try:
        value = int(raw)
    except Exception:
        value = 0
    return max(0, min(100000, value))


def _openclaw_chat_dispatch_recovery_lookback_seconds() -> int:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_RECOVERY_LOOKBACK_SECONDS", "604800").strip()
    try:
        value = int(raw)
    except Exception:
        value = 604800
    return max(300, min(2592000, value))


def _openclaw_chat_dispatch_recovery_max_rows() -> int:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_RECOVERY_MAX_ROWS", "5000").strip()
    try:
        value = int(raw)
    except Exception:
        value = 5000
    return max(100, min(50000, value))


def _openclaw_chat_dispatch_recovery_interval_seconds() -> float:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_RECOVERY_INTERVAL_SECONDS", "300").strip()
    try:
        value = float(raw)
    except Exception:
        value = 300.0
    return max(30.0, min(3600.0, value))


def _openclaw_chat_dispatch_auto_quarantine_enabled() -> bool:
    return os.getenv("OPENCLAW_CHAT_DISPATCH_AUTO_QUARANTINE_DISABLE", "").strip() != "1"


def _openclaw_chat_dispatch_auto_quarantine_seconds() -> int:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_AUTO_QUARANTINE_SECONDS", "21600").strip()
    try:
        value = int(raw)
    except Exception:
        value = 21600
    return max(0, min(60 * 60 * 24 * 30, value))


def _openclaw_chat_dispatch_auto_quarantine_limit() -> int:
    raw = os.getenv("OPENCLAW_CHAT_DISPATCH_AUTO_QUARANTINE_LIMIT", "200").strip()
    try:
        value = int(raw)
    except Exception:
        value = 200
    return max(10, min(5000, value))


def _openclaw_chat_dispatch_auto_quarantine_synthetic_only() -> bool:
    return os.getenv("OPENCLAW_CHAT_DISPATCH_AUTO_QUARANTINE_SYNTHETIC_ONLY", "1").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


# ---------------------------------------------------------------------------
# Queue management helpers
# ---------------------------------------------------------------------------


def _iso_after_seconds(base: datetime, seconds: float) -> str:
    # Accept both positive and negative offsets (used for future schedules and past cutoffs).
    return (base + timedelta(seconds=float(seconds or 0.0))).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _openclaw_chat_dispatch_backoff_seconds(attempts: int) -> float:
    exponent = max(0, min(12, int(attempts or 0) - 1))
    delay = float(2**exponent)
    return max(1.0, min(_openclaw_chat_dispatch_max_retry_delay_seconds(), delay))


def _openclaw_chat_dispatch_is_terminal_error(error_text: str) -> bool:
    text = str(error_text or "").strip().lower()
    if not text:
        return False
    if re.search(r"\btool(?:\s+error)?\b[^\n]{0,120}\bnot found\b", text):
        return True
    status_match = re.search(r"\b([1-5]\d{2})\s+status code\b", text)
    if status_match:
        try:
            status_code = int(status_match.group(1))
        except Exception:
            status_code = 0
        if status_code in {
            400,
            401,
            403,
            404,
            405,
            406,
            407,
            409,
            410,
            411,
            412,
            413,
            414,
            415,
            416,
            422,
            423,
            424,
            426,
            428,
            431,
            451,
        }:
            return True
    terminal_tokens = [
        "attachment missing on disk",
        "unable to read attachment",
        "attachment metadata missing",
        "openclaw gateway token is required",
        "openclaw_base_url is not configured",
        "tool not found",
        "unknown tool",
        "unknown method",
        "invalid params",
        "invalid request",
        "validation error",
    ]
    return any(token in text for token in terminal_tokens)


def _enqueue_openclaw_chat_dispatch(
    *,
    request_id: str,
    session_key: str,
    agent_id: str,
    sent_at: str,
    message: str,
    attachment_ids: list[str] | None = None,
    session: Any | None = None,
) -> None:
    rid = str(request_id or "").strip()
    key = str(session_key or "").strip()
    msg = str(message or "")
    if not rid or not key or not msg:
        raise RuntimeError("dispatch queue requires request_id, session_key, and message")
    attachment_list = [str(att_id).strip() for att_id in (attachment_ids or []) if str(att_id).strip()]
    stamp = now_iso()

    def _build_row() -> OpenClawChatDispatchQueue:
        return OpenClawChatDispatchQueue(
            requestId=rid,
            sessionKey=key,
            agentId=str(agent_id or "main").strip() or "main",
            sentAt=normalize_iso(sent_at) or stamp,
            message=msg,
            attachmentIds=attachment_list,
            status="pending",
            attempts=0,
            nextAttemptAt=stamp,
            claimedAt=None,
            completedAt=None,
            lastError=None,
            createdAt=stamp,
            updatedAt=stamp,
        )

    if session is not None:
        try:
            with session.begin_nested():
                existing = session.exec(
                    select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == rid).limit(1)
                ).first()
                if existing is not None:
                    return
                session.add(_build_row())
                session.flush()
        except IntegrityError:
            return
        _openclaw_chat_dispatch_wakeup()
        return

    with get_session() as write_session:
        existing = write_session.exec(
            select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == rid).limit(1)
        ).first()
        if existing is not None:
            return
        row = _build_row()
        write_session.add(row)
        try:
            write_session.commit()
            _openclaw_chat_dispatch_wakeup()
        except IntegrityError:
            write_session.rollback()


# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

_OPENCLAW_CHAT_DISPATCH_CLAIM_LOCK = threading.Lock()
_OPENCLAW_CHAT_DISPATCH_PROCESS_STARTED_AT_ISO = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
    "+00:00", "Z"
)


def _openclaw_chat_dispatch_claim_next_job(now_iso_value: str) -> dict[str, Any] | None:
    with _OPENCLAW_CHAT_DISPATCH_CLAIM_LOCK:
        with get_session() as session:
            prior = aliased(OpenClawChatDispatchQueue)
            hot_cutoff_iso = _iso_after_seconds(datetime.now(timezone.utc), -float(_openclaw_chat_dispatch_hot_window_seconds()))
            cold_backlog_rank = case((OpenClawChatDispatchQueue.sentAt < hot_cutoff_iso, 1), else_=0)
            voice_rank = case((OpenClawChatDispatchQueue.message.like("/voice%"), 0), (OpenClawChatDispatchQueue.message.like("/skill%"), 0), else_=1)
            retry_rank = case((OpenClawChatDispatchQueue.status == "pending", 0), else_=1)
            has_prior_undelivered = exists(
                select(1)
                .select_from(prior)
                .where(prior.sessionKey == OpenClawChatDispatchQueue.sessionKey)
                .where(prior.id < OpenClawChatDispatchQueue.id)
                .where(prior.status.in_(["pending", "retry", "processing"]))
            )
            row = session.exec(
                select(OpenClawChatDispatchQueue)
                .where(OpenClawChatDispatchQueue.status.in_(["pending", "retry"]))
                .where(OpenClawChatDispatchQueue.nextAttemptAt <= now_iso_value)
                .where(~has_prior_undelivered)
                .order_by(
                    voice_rank.asc(),
                    retry_rank.asc(),
                    cold_backlog_rank.asc(),
                    OpenClawChatDispatchQueue.nextAttemptAt.asc(),
                    OpenClawChatDispatchQueue.createdAt.asc(),
                    OpenClawChatDispatchQueue.id.asc(),
                )
                .limit(1)
            ).first()
            if row is None:
                return None
            row.status = "processing"
            row.attempts = int(row.attempts or 0) + 1
            row.claimedAt = now_iso_value
            row.updatedAt = now_iso_value
            session.add(row)
            session.commit()
            return {
                "id": int(row.id),
                "requestId": str(row.requestId or ""),
                "sessionKey": str(row.sessionKey or ""),
                "agentId": str(row.agentId or "main"),
                "sentAt": str(row.sentAt or ""),
                "message": str(row.message or ""),
                "attachmentIds": list(row.attachmentIds or []),
                "attempts": int(row.attempts or 0),
            }


def _openclaw_chat_dispatch_mark_sent(job_id: int, now_iso_value: str) -> None:
    with get_session() as session:
        row = session.get(OpenClawChatDispatchQueue, job_id)
        if row is None:
            return
        row.status = "sent"
        row.completedAt = now_iso_value
        row.claimedAt = None
        row.lastError = None
        row.updatedAt = now_iso_value
        session.add(row)
        session.commit()


def _openclaw_chat_dispatch_mark_retry(job_id: int, *, error: str, now_dt: datetime) -> None:
    with get_session() as session:
        row = session.get(OpenClawChatDispatchQueue, job_id)
        if row is None:
            return
        attempts = int(row.attempts or 0)
        delay_seconds = _openclaw_chat_dispatch_backoff_seconds(attempts)
        row.status = "retry"
        row.nextAttemptAt = _iso_after_seconds(now_dt, delay_seconds)
        row.claimedAt = None
        row.lastError = _clip(str(error or "").strip(), 1600)
        row.updatedAt = now_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        session.add(row)
        session.commit()


def _openclaw_chat_dispatch_mark_failed(job_id: int, *, error: str, now_iso_value: str) -> None:
    with get_session() as session:
        row = session.get(OpenClawChatDispatchQueue, job_id)
        if row is None:
            return
        row.status = "failed"
        row.completedAt = now_iso_value
        row.claimedAt = None
        row.lastError = _clip(str(error or "").strip(), 1600)
        row.updatedAt = now_iso_value
        session.add(row)
        session.commit()


def _openclaw_chat_dispatch_recover_stale_processing_jobs(now_dt: datetime) -> int:
    now_iso_value = now_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    cutoff_iso = _iso_after_seconds(now_dt, -_openclaw_chat_dispatch_stale_processing_seconds())
    process_started_iso = str(_OPENCLAW_CHAT_DISPATCH_PROCESS_STARTED_AT_ISO or "").strip()
    stale_predicates = [OpenClawChatDispatchQueue.claimedAt < cutoff_iso]
    if process_started_iso:
        # Any claim older than this process start belongs to a previous worker lifecycle.
        stale_predicates.append(OpenClawChatDispatchQueue.claimedAt < process_started_iso)
    with get_session() as session:
        rows = session.exec(
            select(OpenClawChatDispatchQueue)
            .where(OpenClawChatDispatchQueue.status == "processing")
            .where(OpenClawChatDispatchQueue.claimedAt.is_not(None))
            .where(or_(*stale_predicates))
            .order_by(OpenClawChatDispatchQueue.claimedAt.asc())
            .limit(200)
        ).all()
        if not rows:
            return 0
        for row in rows:
            row.status = "retry"
            row.nextAttemptAt = now_iso_value
            row.claimedAt = None
            if not str(row.lastError or "").strip():
                row.lastError = "Recovered stale processing dispatch row after restart/crash."
            row.updatedAt = now_iso_value
            session.add(row)
        session.commit()
        return len(rows)


_OPENCLAW_CHAT_DISPATCH_SYNTHETIC_MARKERS = (
    "topic-smoke",
    "topic-live-",
    "topic-debug",
    "topic-canary",
    "durable-smoke",
    "restart-canary",
    "hot-canary",
    "priority-check",
    "synthetic",
    "e2e",
    "probe",
)


def _openclaw_chat_dispatch_row_looks_synthetic(row: OpenClawChatDispatchQueue) -> bool:
    haystack_parts = [
        str(getattr(row, "sessionKey", "") or "").lower(),
        str(getattr(row, "message", "") or "").lower(),
        str(getattr(row, "requestId", "") or "").lower(),
    ]
    for part in haystack_parts:
        if not part:
            continue
        for marker in _OPENCLAW_CHAT_DISPATCH_SYNTHETIC_MARKERS:
            if marker in part:
                return True
    return False


def _openclaw_chat_dispatch_auto_quarantine_stale_rows(now_dt: datetime) -> int:
    """Fail stale synthetic/test rows so they cannot permanently block hot traffic."""
    if not _openclaw_chat_dispatch_auto_quarantine_enabled():
        return 0
    older_than_seconds = _openclaw_chat_dispatch_auto_quarantine_seconds()
    if older_than_seconds <= 0:
        return 0
    cutoff_iso = _iso_after_seconds(now_dt, -float(older_than_seconds))
    stamp = now_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    synthetic_only = _openclaw_chat_dispatch_auto_quarantine_synthetic_only()
    reason = "auto_quarantined:stale_dispatch_backlog"
    quarantined = 0

    with get_session() as session:
        rows = session.exec(
            select(OpenClawChatDispatchQueue)
            .where(OpenClawChatDispatchQueue.status.in_(["pending", "retry", "processing"]))
            .where(OpenClawChatDispatchQueue.createdAt <= cutoff_iso)
            .order_by(OpenClawChatDispatchQueue.createdAt.asc(), OpenClawChatDispatchQueue.id.asc())
            .limit(_openclaw_chat_dispatch_auto_quarantine_limit())
        ).all()
        if not rows:
            return 0
        for row in rows:
            if synthetic_only and not _openclaw_chat_dispatch_row_looks_synthetic(row):
                continue
            row.status = "failed"
            row.completedAt = stamp
            row.claimedAt = None
            row.nextAttemptAt = stamp
            row.lastError = reason
            row.updatedAt = stamp
            session.add(row)
            quarantined += 1
        if quarantined > 0:
            session.commit()
    return quarantined


def _openclaw_chat_dispatch_resolve_attachments(attachment_ids: list[str]) -> list[dict[str, Any]] | None:
    ids = [str(att_id).strip() for att_id in attachment_ids if str(att_id).strip()]
    if not ids:
        return None
    unique_ids: list[str] = []
    seen: set[str] = set()
    for att_id in ids:
        if att_id in seen:
            continue
        seen.add(att_id)
        unique_ids.append(att_id)
    with get_session() as session:
        rows = session.exec(select(Attachment).where(Attachment.id.in_(unique_ids))).all()
    by_id = {row.id: row for row in rows}
    missing = [att_id for att_id in unique_ids if att_id not in by_id]
    if missing:
        raise RuntimeError(f"attachment metadata missing: {', '.join(missing)}")
    attachments_task: list[dict[str, Any]] = []
    for att_id in unique_ids:
        row = by_id[att_id]
        attachments_task.append(
            {
                "id": row.id,
                "fileName": row.fileName,
                "mimeType": _normalize_mime_type(row.mimeType),
                "sizeBytes": row.sizeBytes,
                "storagePath": row.storagePath,
            }
        )
    return attachments_task


def _recover_openclaw_chat_dispatch_queue() -> int:
    # Late imports to avoid circular dependency with main.
    from .main import _openclaw_watchdog_has_assistant_by_request, _openclaw_watchdog_has_terminal_system_log

    lookback_seconds = _openclaw_chat_dispatch_recovery_lookback_seconds()
    max_rows = _openclaw_chat_dispatch_recovery_max_rows()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=lookback_seconds)).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )
    recovered = 0
    with get_session() as session:
        rows = (
            session.exec(
                select(LogEntry)
                .where(LogEntry.type == "conversation")
                .where(func.lower(func.coalesce(LogEntry.agentId, "")) == "user")
                .where(LogEntry.createdAt >= cutoff)
                .order_by(LogEntry.createdAt.desc())
                .limit(max_rows)
            ).all()
        )
        for row in rows:
            source = row.source if isinstance(row.source, dict) else None
            if not source:
                continue
            if str(source.get("channel") or "").strip().lower() != "openclaw":
                continue
            request_id = str(source.get("requestId") or source.get("messageId") or "").strip()
            session_key = str(source.get("sessionKey") or "").strip()
            if not request_id or not session_key:
                continue
            if not request_id.lower().startswith("occhat-"):
                continue
            existing = session.exec(
                select(OpenClawChatDispatchQueue.id).where(OpenClawChatDispatchQueue.requestId == request_id).limit(1)
            ).first()
            if existing is not None:
                continue
            if _openclaw_watchdog_has_terminal_system_log(session, request_id):
                continue
            if _openclaw_watchdog_has_assistant_by_request(session, request_id, row.createdAt):
                continue
            attachment_ids: list[str] = []
            if isinstance(row.attachments, list):
                for attachment_meta in row.attachments:
                    if not isinstance(attachment_meta, dict):
                        continue
                    att_id = str(attachment_meta.get("id") or "").strip()
                    if att_id:
                        attachment_ids.append(att_id)
            queue_row = OpenClawChatDispatchQueue(
                requestId=request_id,
                sessionKey=session_key,
                agentId=str(source.get("agentId") or "main").strip() or "main",
                sentAt=normalize_iso(str(row.createdAt or "")) or now_iso(),
                message=str(row.content or ""),
                attachmentIds=attachment_ids,
                status="pending",
                attempts=0,
                nextAttemptAt=now_iso(),
                claimedAt=None,
                completedAt=None,
                lastError=None,
                createdAt=now_iso(),
                updatedAt=now_iso(),
            )
            session.add(queue_row)
            recovered += 1
        if recovered > 0:
            session.commit()
    return recovered


_OPENCLAW_CHAT_DISPATCH_MAINTENANCE_LOCK = threading.Lock()
_OPENCLAW_CHAT_DISPATCH_LAST_RECOVERY_AT = 0.0
_OPENCLAW_CHAT_DISPATCH_WAKEUP = threading.Event()


def _openclaw_chat_dispatch_wakeup() -> None:
    """Signal all dispatch workers that a new job is available, bypassing the poll interval."""
    _OPENCLAW_CHAT_DISPATCH_WAKEUP.set()


def _openclaw_chat_dispatch_worker(*, worker_index: int = 1) -> None:
    # Late imports to avoid circular dependency with main.
    from .main import _log_openclaw_chat_error, _run_openclaw_chat

    global _OPENCLAW_CHAT_DISPATCH_LAST_RECOVERY_AT
    poll_seconds = _openclaw_chat_dispatch_poll_seconds()
    max_attempts = _openclaw_chat_dispatch_max_attempts()

    while not _BACKGROUND_STOP_EVENT.is_set():
        job: dict[str, Any] | None = None
        now_dt = datetime.now(timezone.utc)
        now_iso_value = now_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            now_mono = time.monotonic()
            if _OPENCLAW_CHAT_DISPATCH_MAINTENANCE_LOCK.acquire(blocking=False):
                try:
                    _openclaw_chat_dispatch_auto_quarantine_stale_rows(now_dt)
                    _openclaw_chat_dispatch_recover_stale_processing_jobs(now_dt)
                    if now_mono - _OPENCLAW_CHAT_DISPATCH_LAST_RECOVERY_AT >= _openclaw_chat_dispatch_recovery_interval_seconds():
                        _recover_openclaw_chat_dispatch_queue()
                        _OPENCLAW_CHAT_DISPATCH_LAST_RECOVERY_AT = now_mono
                finally:
                    _OPENCLAW_CHAT_DISPATCH_MAINTENANCE_LOCK.release()

            job = _openclaw_chat_dispatch_claim_next_job(now_iso_value)
            if job is None:
                _OPENCLAW_CHAT_DISPATCH_WAKEUP.wait(timeout=poll_seconds)
                _OPENCLAW_CHAT_DISPATCH_WAKEUP.clear()
                if _BACKGROUND_STOP_EVENT.is_set():
                    break
                continue

            base_url = os.getenv("OPENCLAW_BASE_URL", "http://localhost:18789").strip().rstrip("/")
            gateway_token = (os.getenv("OPENCLAW_GATEWAY_TOKEN") or "").strip()
            if not base_url:
                raise RuntimeError("OPENCLAW_BASE_URL is not configured")
            if not gateway_token:
                raise RuntimeError("OPENCLAW_GATEWAY_TOKEN is required")

            attachments = _openclaw_chat_dispatch_resolve_attachments(list(job.get("attachmentIds") or []))
            _run_openclaw_chat(
                str(job.get("requestId") or ""),
                base_url=base_url,
                token=gateway_token,
                session_key=str(job.get("sessionKey") or ""),
                agent_id=str(job.get("agentId") or "main"),
                sent_at=str(job.get("sentAt") or ""),
                message=str(job.get("message") or ""),
                attachments=attachments,
                dispatch_attempt=int(job.get("attempts") or 1),
                raise_on_error=True,
                log_errors=False,
            )
            _openclaw_chat_dispatch_mark_sent(int(job.get("id") or 0), now_iso_value)
            if _background_sleep(0.05):
                break
            continue
        except Exception as exc:
            error_text = _clip(str(exc) or type(exc).__name__, 1600)
            try:
                if job is not None and int(job.get("id") or 0) > 0:
                    attempts = int(job.get("attempts", 0) or 0)
                    exhausted = max_attempts > 0 and attempts >= max_attempts
                    terminal = exhausted or _openclaw_chat_dispatch_is_terminal_error(error_text)
                    if terminal:
                        _openclaw_chat_dispatch_mark_failed(int(job.get("id") or 0), error=error_text, now_iso_value=now_iso_value)
                        detail = f"OpenClaw durable dispatch failed. requestId={str(job.get('requestId') or '')}"
                        if exhausted:
                            detail = (
                                "OpenClaw durable dispatch exhausted retry attempts "
                                f"({attempts}/{max_attempts}). requestId={str(job.get('requestId') or '')}"
                            )
                        _log_openclaw_chat_error(
                            session_key=str(job.get("sessionKey") or ""),
                            request_id=str(job.get("requestId") or ""),
                            detail=detail,
                            raw=error_text,
                        )
                    else:
                        _openclaw_chat_dispatch_mark_retry(int(job.get("id") or 0), error=error_text, now_dt=now_dt)
            except Exception:
                logger.exception(
                    "clawboard-openclaw-dispatch-%s failed to persist retry/failure state for requestId=%s",
                    worker_index,
                    str(job.get("requestId") or "") if job is not None else "",
                )
            _log_background_worker_exception(f"clawboard-openclaw-dispatch-{worker_index}")
            if _background_sleep(poll_seconds):
                break


# ---------------------------------------------------------------------------
# Session lock management
# ---------------------------------------------------------------------------

_OPENCLAW_CHAT_SESSION_LOCKS: dict[str, dict[str, Any]] = {}
_OPENCLAW_CHAT_SESSION_LOCKS_GUARD = threading.Lock()


def _openclaw_chat_dispatch_session_key(session_key: str) -> str:
    base_key = (str(session_key or "").split("|", 1)[0] or "").strip()
    return base_key or str(session_key or "").strip()


def _openclaw_chat_session_lock_ttl_seconds() -> float:
    raw = os.getenv("OPENCLAW_CHAT_SESSION_LOCK_TTL_SECONDS", "21600").strip()
    try:
        value = float(raw)
    except Exception:
        value = 21600.0
    return max(60.0, min(7 * 24 * 60 * 60.0, value))


def _openclaw_chat_session_lock_max_entries() -> int:
    raw = os.getenv("OPENCLAW_CHAT_SESSION_LOCK_MAX_ENTRIES", "4096").strip()
    try:
        value = int(raw)
    except Exception:
        value = 4096
    return max(32, min(65536, value))


def _openclaw_chat_prune_session_locks_locked(now_mono: float | None = None) -> None:
    now_value = time.monotonic() if now_mono is None else float(now_mono)
    ttl_seconds = _openclaw_chat_session_lock_ttl_seconds()
    max_entries = _openclaw_chat_session_lock_max_entries()

    stale_keys = [
        key
        for key, state in _OPENCLAW_CHAT_SESSION_LOCKS.items()
        if int(state.get("refs") or 0) <= 0 and (now_value - float(state.get("lastUsedMonotonic") or 0.0)) >= ttl_seconds
    ]
    for key in stale_keys:
        _OPENCLAW_CHAT_SESSION_LOCKS.pop(key, None)

    overflow = len(_OPENCLAW_CHAT_SESSION_LOCKS) - max_entries
    if overflow <= 0:
        return

    removable = sorted(
        (
            (key, float(state.get("lastUsedMonotonic") or 0.0))
            for key, state in _OPENCLAW_CHAT_SESSION_LOCKS.items()
            if int(state.get("refs") or 0) <= 0
        ),
        key=lambda item: item[1],
    )
    for key, _last_used in removable[:overflow]:
        _OPENCLAW_CHAT_SESSION_LOCKS.pop(key, None)


def _openclaw_chat_acquire_session_lock(session_key: str) -> tuple[str, threading.Lock]:
    key = _openclaw_chat_dispatch_session_key(session_key)
    now_mono = time.monotonic()
    with _OPENCLAW_CHAT_SESSION_LOCKS_GUARD:
        _openclaw_chat_prune_session_locks_locked(now_mono)
        state = _OPENCLAW_CHAT_SESSION_LOCKS.get(key)
        if state is None:
            state = {
                "lock": threading.Lock(),
                "refs": 0,
                "lastUsedMonotonic": now_mono,
            }
            _OPENCLAW_CHAT_SESSION_LOCKS[key] = state
        state["refs"] = int(state.get("refs") or 0) + 1
        state["lastUsedMonotonic"] = now_mono
        return key, state["lock"]


def _openclaw_chat_release_session_lock(lock_key: str, lock: threading.Lock) -> None:
    try:
        lock.release()
    finally:
        now_mono = time.monotonic()
        with _OPENCLAW_CHAT_SESSION_LOCKS_GUARD:
            state = _OPENCLAW_CHAT_SESSION_LOCKS.get(lock_key)
            if state is not None and state.get("lock") is lock:
                state["refs"] = max(0, int(state.get("refs") or 0) - 1)
                state["lastUsedMonotonic"] = now_mono
            _openclaw_chat_prune_session_locks_locked(now_mono)
