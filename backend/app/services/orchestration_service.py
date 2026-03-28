from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlmodel import select

from ..models import OpenClawChatDispatchQueue, OpenClawGatewayHistorySyncState


def build_resolver_context_payload_for_board_send(
    main_module: Any,
    *,
    message: str,
    selected_topic_id: str | None,
    force_new_topic: bool,
    explicit_space_id: str | None,
) -> tuple[dict[str, Any] | None, str]:
    if force_new_topic:
        return None, "skipped_force_new_topic"
    if selected_topic_id:
        return None, "skipped_selected_topic"

    try:
        context_result = main_module.context(
            q=message,
            sessionKey=None,
            spaceId=explicit_space_id,
            mode="cheap",
            includePending=False,
            maxChars=1400,
            workingSetLimit=4,
            timelineLimit=4,
        )
    except Exception:
        return None, "cheap_error"

    if isinstance(context_result, dict):
        return context_result, "cheap"
    return None, "cheap_empty"


def build_openclaw_chat_dispatch_status_payload(session: Any, main_module: Any) -> dict[str, Any]:
    rows = session.exec(select(OpenClawChatDispatchQueue)).all()

    counts = {
        "pending": 0,
        "retry": 0,
        "processing": 0,
        "sent": 0,
        "failed": 0,
    }
    oldest_open: str | None = None
    newest_completed: str | None = None
    max_attempts = 0
    for row in rows:
        status = str(getattr(row, "status", "") or "").strip().lower()
        if status in counts:
            counts[status] += 1
        attempts = int(getattr(row, "attempts", 0) or 0)
        max_attempts = max(max_attempts, attempts)
        created_at = main_module.normalize_iso(str(getattr(row, "createdAt", "") or ""))
        completed_at = main_module.normalize_iso(str(getattr(row, "completedAt", "") or ""))
        if status in {"pending", "retry", "processing"} and created_at:
            if oldest_open is None or created_at < oldest_open:
                oldest_open = created_at
        if completed_at:
            if newest_completed is None or completed_at > newest_completed:
                newest_completed = completed_at

    return {
        "enabled": main_module._openclaw_chat_dispatch_enabled(),
        "workers": main_module._openclaw_chat_dispatch_workers(),
        "hotWindowSeconds": main_module._openclaw_chat_dispatch_hot_window_seconds(),
        "pollSeconds": main_module._openclaw_chat_dispatch_poll_seconds(),
        "staleProcessingSeconds": main_module._openclaw_chat_dispatch_stale_processing_seconds(),
        "maxRetryDelaySeconds": main_module._openclaw_chat_dispatch_max_retry_delay_seconds(),
        "maxAttempts": main_module._openclaw_chat_dispatch_max_attempts(),
        "recoveryLookbackSeconds": main_module._openclaw_chat_dispatch_recovery_lookback_seconds(),
        "recoveryIntervalSeconds": main_module._openclaw_chat_dispatch_recovery_interval_seconds(),
        "autoQuarantineEnabled": main_module._openclaw_chat_dispatch_auto_quarantine_enabled(),
        "autoQuarantineSeconds": main_module._openclaw_chat_dispatch_auto_quarantine_seconds(),
        "autoQuarantineLimit": main_module._openclaw_chat_dispatch_auto_quarantine_limit(),
        "autoQuarantineSyntheticOnly": main_module._openclaw_chat_dispatch_auto_quarantine_synthetic_only(),
        "counts": counts,
        "oldestOpenCreatedAt": oldest_open,
        "newestCompletedAt": newest_completed,
        "maxObservedAttempts": max_attempts,
    }


def build_openclaw_history_sync_status_payload(session: Any, main_module: Any) -> dict[str, Any]:
    row = session.get(OpenClawGatewayHistorySyncState, main_module._OPENCLAW_HISTORY_SYNC_STATE_ID)
    return {
        "enabled": main_module._openclaw_gateway_history_sync_enabled(),
        "pollSeconds": main_module._openclaw_gateway_history_sync_poll_seconds(),
        "activeMinutes": main_module._openclaw_gateway_history_sync_active_minutes(),
        "sessionLimit": main_module._openclaw_gateway_history_sync_session_limit(),
        "sessionsListEnabled": main_module._openclaw_gateway_history_sync_sessions_list_enabled(),
        "cycleBudgetSeconds": main_module._openclaw_gateway_history_sync_cycle_budget_seconds(),
        "cursorSeedLimit": main_module._openclaw_gateway_history_sync_cursor_seed_limit(),
        "logSeedLimit": main_module._openclaw_gateway_history_sync_log_seed_limit(),
        "logSeedLookbackSeconds": main_module._openclaw_gateway_history_sync_log_seed_lookback_seconds(),
        "unresolvedSeedLimit": main_module._openclaw_gateway_history_sync_unresolved_seed_limit(),
        "unresolvedLookbackSeconds": main_module._openclaw_gateway_history_sync_unresolved_lookback_seconds(),
        "rpcTimeoutSeconds": main_module._openclaw_gateway_history_sync_rpc_timeout_seconds(),
        "maxBackoffSeconds": main_module._openclaw_gateway_history_sync_max_backoff_seconds(),
        "sessionBackoffBaseSeconds": main_module._openclaw_gateway_history_sync_session_backoff_base_seconds(),
        "sessionBackoffTtlSeconds": main_module._openclaw_gateway_history_sync_session_backoff_ttl_seconds(),
        "transportRetryAttempts": main_module._openclaw_gateway_history_sync_transport_retry_attempts(),
        "transportRetryBaseSeconds": main_module._openclaw_gateway_history_sync_transport_retry_base_seconds(),
        "historyLimit": main_module._openclaw_gateway_history_sync_history_limit(),
        "overlapSeconds": main_module._openclaw_gateway_history_sync_overlap_seconds(),
        "runtime": {
            "sessionBackoffStateCount": main_module._openclaw_gateway_history_sync_backoff_state_size(),
            "checkedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        },
        "auth": {
            "tokenConfigured": bool(main_module._openclaw_gateway_history_sync_token()),
            "explicitDeviceAuthMode": main_module._openclaw_gateway_history_sync_use_device_auth(),
            "retryWithoutDeviceAuth": main_module._openclaw_gateway_history_sync_retry_without_device_auth(),
            "retryWithWriteScope": main_module._openclaw_gateway_history_sync_retry_with_write_scope(),
        },
        "state": {
            "status": str(getattr(row, "status", "idle") or "idle"),
            "lastRunAt": getattr(row, "lastRunAt", None),
            "lastSuccessAt": getattr(row, "lastSuccessAt", None),
            "lastErrorAt": getattr(row, "lastErrorAt", None),
            "lastError": getattr(row, "lastError", None),
            "consecutiveFailures": int(getattr(row, "consecutiveFailures", 0) or 0),
            "lastIngestedCount": int(getattr(row, "lastIngestedCount", 0) or 0),
            "lastSessionCount": int(getattr(row, "lastSessionCount", 0) or 0),
            "lastCursorUpdateCount": int(getattr(row, "lastCursorUpdateCount", 0) or 0),
            "lastDeferredCount": int(getattr(row, "lastDeferredCount", 0) or 0),
            "updatedAt": getattr(row, "updatedAt", None),
        },
    }
