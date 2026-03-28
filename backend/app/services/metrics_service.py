from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func
from sqlmodel import select

from ..models import IngestQueue, LogEntry, OpenClawGatewayHistorySyncState, Topic
from ..precompile import (
    PRECOMPILE_ENABLED,
    PRECOMPILE_MAX_KEYS,
    PRECOMPILE_TTL_SECONDS,
    _PRECOMPILE_CACHE,
    _PRECOMPILE_CACHE_LOCK,
)
from ..vector_search import (
    QDRANT_COLLECTION,
    QDRANT_URL,
    _qdrant_request,
    vector_runtime_available,
)
from .orchestration_service import (
    build_openclaw_chat_dispatch_status_payload,
    build_openclaw_history_sync_status_payload,
)
from .search_service import search_cache_stats


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        ts = datetime.fromisoformat(raw)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc)
    except Exception:
        return None


def _creation_gate_metrics(main_module: Any) -> dict[str, Any]:
    cutoff_dt = datetime.now(timezone.utc) - timedelta(hours=24)
    cutoff_ts = cutoff_dt.timestamp()
    gate = {
        "topics": {"allowedTotal": 0, "blockedTotal": 0, "allowed24h": 0, "blocked24h": 0},
    }
    audit_path = main_module._creation_audit_path()
    try:
        if audit_path and os.path.exists(audit_path):
            with open(audit_path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except Exception:
                        continue
                    kind = str(item.get("kind") or "").lower()
                    decision = str(item.get("decision") or "").lower()
                    if kind != "topic":
                        continue
                    bucket = gate["topics"]
                    is_allowed = decision == "allow"
                    if is_allowed:
                        bucket["allowedTotal"] += 1
                    else:
                        bucket["blockedTotal"] += 1
                    ts = _parse_iso(item.get("ts"))
                    if ts and ts.timestamp() >= cutoff_ts:
                        if is_allowed:
                            bucket["allowed24h"] += 1
                        else:
                            bucket["blocked24h"] += 1
    except Exception:
        pass
    return gate


def _vector_status() -> dict[str, Any]:
    configured = bool(QDRANT_URL)
    reachable: bool | None = None
    collection_exists: bool | None = None
    error_text: str | None = None
    if configured:
        try:
            response = _qdrant_request("GET", f"/collections/{QDRANT_COLLECTION}")
            reachable = response is not None
            collection_exists = bool(response)
        except Exception as exc:
            reachable = False
            collection_exists = False
            error_text = str(exc)
    status = "disabled"
    if configured:
        status = "ok" if reachable else "degraded"
    return {
        "status": status,
        "configured": configured,
        "runtimeAvailable": vector_runtime_available(),
        "backend": "qdrant" if configured else "disabled",
        "collection": QDRANT_COLLECTION,
        "qdrantReachable": reachable,
        "collectionPresent": collection_exists,
        "error": error_text,
    }


def _precompile_cache_stats() -> dict[str, Any]:
    now_mono = None
    try:
        import time as _time

        now_mono = _time.monotonic()
    except Exception:
        now_mono = None
    with _PRECOMPILE_CACHE_LOCK:
        cache_size = len(_PRECOMPILE_CACHE)
        oldest_expiry: float | None = None
        newest_build: float | None = None
        for entry in _PRECOMPILE_CACHE.values():
            expires_at = float(entry.get("expiresAtMonotonic") or 0.0)
            built_at = float(entry.get("builtAtMonotonic") or 0.0)
            if expires_at > 0 and (oldest_expiry is None or expires_at < oldest_expiry):
                oldest_expiry = expires_at
            if built_at > 0 and (newest_build is None or built_at > newest_build):
                newest_build = built_at
    ttl_remaining = None
    if oldest_expiry is not None and now_mono is not None:
        ttl_remaining = max(0.0, round(oldest_expiry - now_mono, 3))
    return {
        "enabled": PRECOMPILE_ENABLED,
        "size": cache_size,
        "maxKeys": PRECOMPILE_MAX_KEYS,
        "ttlSeconds": PRECOMPILE_TTL_SECONDS,
        "earliestExpiryInSeconds": ttl_remaining,
        "hasWarmEntries": cache_size > 0 and newest_build is not None,
    }


def build_health_payload(session: Any, *, main_module: Any) -> dict[str, Any]:
    db_info = {
        "status": "ok",
        "backend": "postgresql" if str(main_module.DATABASE_URL).startswith("postgresql") else "sqlite",
        "configured": bool(main_module.DATABASE_URL),
    }
    ingest_counts: dict[str, int] = {}
    for status, count in session.exec(
        select(IngestQueue.status, func.count(IngestQueue.id)).group_by(IngestQueue.status)
    ).all():
        ingest_counts[str(status or "").strip().lower() or "unknown"] = int(count or 0)

    dispatch = build_openclaw_chat_dispatch_status_payload(session, main_module)
    history_sync = build_openclaw_history_sync_status_payload(session, main_module)
    vector = _vector_status()
    queues = {
        "ingest": {
            "status": "ok",
            "counts": ingest_counts,
            "backlog": int(ingest_counts.get("pending", 0) + ingest_counts.get("processing", 0)),
        },
        "dispatch": {
            "status": "ok"
            if int(dispatch.get("counts", {}).get("failed", 0) or 0) == 0
            else "degraded",
            "counts": dispatch.get("counts", {}),
            "oldestOpenCreatedAt": dispatch.get("oldestOpenCreatedAt"),
            "newestCompletedAt": dispatch.get("newestCompletedAt"),
        },
    }
    caches = {
        "precompile": _precompile_cache_stats(),
        "search": search_cache_stats(main_module),
    }
    return {
        "status": "ok",
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "checks": {
            "database": db_info,
            "vector": vector,
            "historySync": {
                "status": str(history_sync.get("state", {}).get("status") or "idle"),
                "enabled": bool(history_sync.get("enabled")),
                "sessionsListEnabled": bool(history_sync.get("sessionsListEnabled")),
                "lastRunAt": history_sync.get("state", {}).get("lastRunAt"),
                "lastSuccessAt": history_sync.get("state", {}).get("lastSuccessAt"),
                "lastErrorAt": history_sync.get("state", {}).get("lastErrorAt"),
                "lastError": history_sync.get("state", {}).get("lastError"),
                "lastDeferredCount": history_sync.get("state", {}).get("lastDeferredCount"),
            },
        },
        "queues": queues,
        "caches": caches,
    }


def build_metrics_payload(session: Any, *, main_module: Any) -> dict[str, Any]:
    total = int(session.exec(select(func.count()).select_from(LogEntry)).one() or 0)
    pending_count = int(
        session.exec(
            select(func.count()).select_from(LogEntry).where(LogEntry.classificationStatus == "pending")
        ).one()
        or 0
    )
    failed_count = int(
        session.exec(
            select(func.count()).select_from(LogEntry).where(LogEntry.classificationStatus == "failed")
        ).one()
        or 0
    )
    classified_count = max(0, total - pending_count - failed_count)
    newest = session.exec(select(func.max(LogEntry.createdAt))).one()
    oldest_pending = session.exec(
        select(func.min(LogEntry.createdAt)).where(LogEntry.classificationStatus == "pending")
    ).one()

    topics_total = int(session.exec(select(func.count()).select_from(Topic)).one() or 0)

    cutoff_dt = datetime.now(timezone.utc) - timedelta(hours=24)
    cutoff_iso = cutoff_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    topics_created_24h = int(
        session.exec(select(func.count()).select_from(Topic).where(Topic.createdAt >= cutoff_iso)).one() or 0
    )

    dispatch = build_openclaw_chat_dispatch_status_payload(session, main_module)
    history_sync = build_openclaw_history_sync_status_payload(session, main_module)
    vector = _vector_status()
    health = build_health_payload(session, main_module=main_module)

    ingest_counts: dict[str, int] = {}
    for status, count in session.exec(
        select(IngestQueue.status, func.count(IngestQueue.id)).group_by(IngestQueue.status)
    ).all():
        ingest_counts[str(status or "").strip().lower() or "unknown"] = int(count or 0)

    history_sync_row = session.get(OpenClawGatewayHistorySyncState, main_module._OPENCLAW_HISTORY_SYNC_STATE_ID)

    return {
        "logs": {
            "total": total,
            "pending": pending_count,
            "classified": classified_count,
            "failed": failed_count,
            "newestCreatedAt": newest,
            "oldestPendingAt": oldest_pending,
        },
        "creation": {
            "topics": {"total": topics_total, "created24h": topics_created_24h},
            "gate": _creation_gate_metrics(main_module),
        },
        "openclaw": {
            "historySync": {
                **history_sync.get("state", {}),
                "enabled": bool(history_sync.get("enabled")),
                "sessionsListEnabled": bool(history_sync.get("sessionsListEnabled")),
                "cycleBudgetSeconds": history_sync.get("cycleBudgetSeconds"),
                "cursorSeedLimit": history_sync.get("cursorSeedLimit"),
                "logSeedLimit": history_sync.get("logSeedLimit"),
                "logSeedLookbackSeconds": history_sync.get("logSeedLookbackSeconds"),
                "unresolvedSeedLimit": history_sync.get("unresolvedSeedLimit"),
                "unresolvedLookbackSeconds": history_sync.get("unresolvedLookbackSeconds"),
                "rpcTimeoutSeconds": history_sync.get("rpcTimeoutSeconds"),
                "maxBackoffSeconds": history_sync.get("maxBackoffSeconds"),
                "auth": history_sync.get("auth"),
            },
            "dispatchQueue": {
                "counts": dispatch.get("counts", {}),
                "oldestOpenCreatedAt": dispatch.get("oldestOpenCreatedAt"),
                "newestCompletedAt": dispatch.get("newestCompletedAt"),
                "maxObservedAttempts": dispatch.get("maxObservedAttempts"),
            },
        },
        "queues": {
            "ingest": {
                "counts": ingest_counts,
                "backlog": int(ingest_counts.get("pending", 0) + ingest_counts.get("processing", 0)),
            },
            "dispatch": dispatch.get("counts", {}),
        },
        "runtime": {
            "database": health.get("checks", {}).get("database", {}),
            "vector": vector,
            "caches": {
                "precompile": _precompile_cache_stats(),
                "search": search_cache_stats(main_module),
            },
            "historySync": {
                "rowPresent": history_sync_row is not None,
                "status": str(getattr(history_sync_row, "status", "") or "idle"),
            },
        },
    }
