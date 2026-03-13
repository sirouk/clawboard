from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Callable, Iterable

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.exc import DataError

from .db import get_session
from .models import LogEntry

logger = logging.getLogger(__name__)

__all__ = [
    # Constants / compiled regexes
    "_OPENCLAW_UNTRUSTED_METADATA_PREFIX_RE",
    "_OPENCLAW_UNTRUSTED_METADATA_FENCED_RE",
    "_OPENCLAW_UNTRUSTED_METADATA_JSON_DECODER",
    "_CLAWBOARD_CONTEXT_BLOCK_RE",
    "_CLAWBOARD_CONTEXT_HEURISTIC_RE",
    "SEARCH_INCLUDE_TOOL_CALL_LOGS",
    "SEARCH_DIRECT_LABEL_EXACT_BOOST",
    "SEARCH_DIRECT_LABEL_PREFIX_BOOST",
    "SEARCH_DIRECT_LABEL_COVERAGE_BOOST",
    "SLASH_COMMANDS",
    # Functions
    "_normalize_label",
    "_extract_openclaw_untrusted_metadata_wrapper",
    "_is_injected_clawboard_context_artifact",
    "_coerce_safe_text",
    "_sanitize_json_textish",
    "_sanitize_log_text",
    "_preserve_markdown_text",
    "_search_query_tokens",
    "_direct_label_match_boost",
    "_extract_query_snippet",
    "_safe_log_attr_text",
    "_is_command_log",
    "_clip",
    "_escape_sql_like_term",
    "_chunked_values",
    "_is_search_row_encoding_error",
    "_exec_search_rows_resilient",
    "_combined_log_text",
    "_is_tool_trace_text",
    "_is_memory_action_text",
    "_is_subagent_session_key",
    "_session_key_supports_bundle_tool_scoping",
    "_is_subagent_scaffold_text",
    "_is_heartbeat_control_plane_text",
    "_is_control_plane_conversation_payload",
    "_is_tool_call_log",
    "_log_reindex_text",
    "_is_memory_action_log",
    "_log_allowed_for_semantic_search",
    "_enqueue_log_reindex",
    "_session_keys_equivalent",
    "_log_matches_session",
]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SEARCH_INCLUDE_TOOL_CALL_LOGS = str(os.getenv("CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS", "0") or "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

SEARCH_DIRECT_LABEL_EXACT_BOOST = float(os.getenv("CLAWBOARD_SEARCH_DIRECT_LABEL_EXACT_BOOST", "0.38") or "0.38")
SEARCH_DIRECT_LABEL_PREFIX_BOOST = float(os.getenv("CLAWBOARD_SEARCH_DIRECT_LABEL_PREFIX_BOOST", "0.2") or "0.2")
SEARCH_DIRECT_LABEL_COVERAGE_BOOST = float(os.getenv("CLAWBOARD_SEARCH_DIRECT_LABEL_COVERAGE_BOOST", "0.16") or "0.16")

SLASH_COMMANDS = {
    "/new",
    "/topic",
    "/topics",
    "/log",
    "/logs",
    "/board",
    "/graph",
    "/help",
    "/commands",
    "/reset",
    "/clear",
    "/skill",
    "/model",
    "/models",
    "/think",
    "/verbose",
    "/reasoning",
    "/elevated",
    "/exec",
    "/status",
    "/whoami",
    "/id",
    "/context",
    "/subagents",
    "/usage",
    "/stop",
    "/voice",
    "/bash",
    "/config",
    "/debug",
    "/restart",
    "/scripts",
    "/edit",
    "/delete",
    "/read",
    "/write",
    "/browser",
    "/message",
    "/thought",
    "/v",
    "/e",
    "/settings",
    "/r",
    "/t",
    "/th",
    "/think-level",
    "/thinklevel",
    "/u",
    "/m",
    "/provider",
    "/providers",
    "/subagent",
    "/subs",
    "/me",
    "/who-am-i",
    "/h",
    "/cmds",
    "/s",
    "/ctx",
    "/tts",
    "/sh",
    "/d",
    "/abort",
    "/sk",
    "/top",
    "/tk",
    "/l",
    "/b",
    "/g",
    "/thinking",
    "/reason",
    "/reasoning",
    "/commands",
    "/help",
    "/whoami",
    "/status",
    "/context",
    "/subagents",
    "/usage",
    "/model",
    "/models",
    "/think",
    "/verbose",
    "/elevated",
    "/exec",
    "/read",
    "/write",
    "/reset",
    "/clear",
    "/new",
    "/stop",
    "/skill",
    "/topic",
    "/topics",
    "/log",
    "/logs",
    "/board",
    "/graph",
    "/voice",
    "/bash",
    "/config",
    "/debug",
    "/restart",
    "/scripts",
    "/edit",
    "/delete",
}

# ---------------------------------------------------------------------------
# Compiled regexes
# ---------------------------------------------------------------------------

_OPENCLAW_UNTRUSTED_METADATA_PREFIX_RE = re.compile(
    r"^\s*conversation info\s*\(untrusted metadata\)\s*:\s*",
    flags=re.IGNORECASE,
)
_OPENCLAW_UNTRUSTED_METADATA_FENCED_RE = re.compile(
    r"^\s*```(?:json)?\s*(\{[\s\S]*?\})\s*```",
    flags=re.IGNORECASE,
)
_OPENCLAW_UNTRUSTED_METADATA_JSON_DECODER = json.JSONDecoder()
_CLAWBOARD_CONTEXT_BLOCK_RE = re.compile(
    r"\[CLAWBOARD_CONTEXT_BEGIN\][\s\S]*?\[CLAWBOARD_CONTEXT_END\]\s*",
    flags=re.IGNORECASE,
)
_CLAWBOARD_CONTEXT_HEURISTIC_RE = re.compile(
    r"clawboard continuity hook is active for this turn\.[\s\S]*?clawboard context \(layered\)\s*:\s*",
    flags=re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------


def _normalize_label(value: str | None) -> str:
    if not value:
        return ""
    text = value.lower()
    replacements = {
        "ops": "operations",
        "msg": "message",
        "msgs": "messages",
    }
    for short, full in replacements.items():
        text = re.sub(rf"\b{short}\b", full, text)
    text = re.sub(r"[^a-z0-9\s]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _extract_openclaw_untrusted_metadata_wrapper(value: str | None) -> tuple[dict[str, Any] | None, str]:
    raw = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return (None, "")
    if not _OPENCLAW_UNTRUSTED_METADATA_PREFIX_RE.match(raw):
        return (None, raw)

    remainder = _OPENCLAW_UNTRUSTED_METADATA_PREFIX_RE.sub("", raw, count=1).lstrip()
    metadata: dict[str, Any] | None = None
    body = remainder

    fenced = _OPENCLAW_UNTRUSTED_METADATA_FENCED_RE.match(remainder)
    if fenced:
        candidate = str(fenced.group(1) or "").strip()
        if candidate:
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    metadata = parsed
            except Exception:
                metadata = None
        body = remainder[fenced.end() :].strip()
    elif remainder.startswith("{"):
        try:
            parsed, idx = _OPENCLAW_UNTRUSTED_METADATA_JSON_DECODER.raw_decode(remainder)
            if isinstance(parsed, dict):
                metadata = parsed
                body = remainder[idx:].strip()
        except Exception:
            metadata = None

    return (metadata, body)


def _is_injected_clawboard_context_artifact(value: str | None) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    lower = raw.lower()
    if "[clawboard_context_begin]" in lower and "[clawboard_context_end]" in lower:
        return True
    # Backward-compatible heuristic for legacy context wrappers that may not preserve tags.
    if (
        "clawboard continuity hook is active for this turn" in lower
        and ("clawboard context (layered):" in lower or "use this clawboard retrieval context" in lower)
    ):
        return True
    return False


def _coerce_safe_text(value: Any | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="replace")
    else:
        text = str(value)
    if not text:
        return ""
    text = text.replace("\x00", "")
    try:
        return text.encode("utf-8", errors="surrogatepass").decode("utf-8", errors="replace")
    except Exception:
        return text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


def _sanitize_json_textish(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, (str, bytes)):
        return _coerce_safe_text(value)
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            normalized[str(_coerce_safe_text(key) or "")] = _sanitize_json_textish(item)
        return normalized
    if isinstance(value, (list, tuple, set)):
        return [_sanitize_json_textish(item) for item in value]
    return _coerce_safe_text(value)


def _sanitize_log_text(value: str | None) -> str:
    """Sanitize text for search indexing and summaries. Collapses whitespace."""
    if not value:
        return ""
    text = _coerce_safe_text(value).replace("\r\n", "\n").replace("\r", "\n").strip()
    _, text = _extract_openclaw_untrusted_metadata_wrapper(text)
    text = _CLAWBOARD_CONTEXT_BLOCK_RE.sub(" ", text)
    text = _CLAWBOARD_CONTEXT_HEURISTIC_RE.sub(" ", text)
    text = re.sub(
        r"(?:\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]|\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\])\s*",
        " ",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"^\s*summary\s*[:\-]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"^\[Discord [^\]]+\]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"\[message[_\s-]?id:[^\]]+\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _preserve_markdown_text(value: str | None) -> str:
    """Sanitize text for message content while preserving markdown formatting (newlines, indentation).

    This function performs the same metadata/context cleanup as _sanitize_log_text but
    preserves newlines and significant whitespace needed for markdown rendering.
    """
    if not value:
        return ""
    text = _coerce_safe_text(value).replace("\r\n", "\n").replace("\r", "\n").strip()
    _, text = _extract_openclaw_untrusted_metadata_wrapper(text)
    text = _CLAWBOARD_CONTEXT_BLOCK_RE.sub("\n", text)  # Preserve line breaks
    text = _CLAWBOARD_CONTEXT_HEURISTIC_RE.sub("\n", text)  # Preserve line breaks
    text = re.sub(
        r"(?:\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]|\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\])\s*",
        "\n",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"^\s*summary\s*[:\-]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"^\[Discord [^\]]+\]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"\[message[_\s-]?id:[^\]]+\]", "", text, flags=re.IGNORECASE)
    # Preserve newlines and indentation - only collapse multiple consecutive newlines
    text = re.sub(r"\n{3,}", "\n\n", text)  # Max 2 consecutive newlines (one blank line)
    return text


def _search_query_tokens(value: str | None) -> set[str]:
    normalized = _sanitize_log_text(value).lower()
    if not normalized:
        return set()
    words = re.findall(r"[a-z0-9][a-z0-9'/_:-]*", normalized)
    return {token for token in words if len(token) > 1}


def _direct_label_match_boost(label: str | None, normalized_query: str, query_tokens: set[str]) -> float:
    cleaned_label = _sanitize_log_text(label).lower()
    if not cleaned_label:
        return 0.0
    label_tokens = _search_query_tokens(cleaned_label)
    if not label_tokens:
        return 0.0

    if normalized_query and normalized_query in cleaned_label:
        if len(query_tokens) >= 2:
            return max(0.0, SEARCH_DIRECT_LABEL_EXACT_BOOST + 0.04)
        return max(0.0, SEARCH_DIRECT_LABEL_EXACT_BOOST)

    if len(query_tokens) == 1:
        query_token = next(iter(query_tokens))
        if query_token in label_tokens:
            return max(0.0, SEARCH_DIRECT_LABEL_EXACT_BOOST)
        if len(query_token) >= 3 and any(token.startswith(query_token) for token in label_tokens):
            return max(0.0, SEARCH_DIRECT_LABEL_PREFIX_BOOST)
        return 0.0

    overlap = len(query_tokens & label_tokens)
    if query_tokens and overlap >= len(query_tokens):
        return max(0.0, SEARCH_DIRECT_LABEL_COVERAGE_BOOST)
    if len(query_tokens) >= 3 and overlap >= 2:
        return max(0.0, SEARCH_DIRECT_LABEL_COVERAGE_BOOST * 0.6)
    return 0.0


def _extract_query_snippet(value: str | None, terms: list[str], *, radius: int = 220, cap: int = 720) -> str:
    cleaned = _sanitize_log_text(value)
    if not cleaned:
        return ""
    hay = cleaned.lower()
    first_pos = -1
    for term in terms:
        pos = hay.find(term.lower())
        if pos >= 0 and (first_pos < 0 or pos < first_pos):
            first_pos = pos
    if first_pos < 0:
        return _clip(cleaned, cap)
    start = max(0, first_pos - max(40, radius))
    end = min(len(cleaned), first_pos + max(80, radius))
    snippet = cleaned[start:end].strip()
    if start > 0:
        snippet = f"\u2026{snippet}"
    if end < len(cleaned):
        snippet = f"{snippet}\u2026"
    return _clip(snippet, cap)


def _safe_log_attr_text(entry: LogEntry, field: str) -> str:
    """Return a log field without triggering ORM lazy-load queries for deferred columns."""
    name = str(field or "").strip()
    if not name:
        return ""
    try:
        state = sa_inspect(entry)
        unloaded = getattr(state, "unloaded", None)
        if unloaded and name in unloaded:
            return ""
    except Exception:
        pass
    try:
        return _coerce_safe_text(getattr(entry, name) or "")
    except Exception:
        return ""


def _is_command_log(entry: LogEntry) -> bool:
    if getattr(entry, "type", None) != "conversation":
        return False
    text = _sanitize_log_text(
        _safe_log_attr_text(entry, "content")
        or _safe_log_attr_text(entry, "summary")
        or _safe_log_attr_text(entry, "raw")
        or ""
    )
    if not text.startswith("/"):
        return False
    command = text.split(None, 1)[0].lower()
    if command in SLASH_COMMANDS:
        return True
    # For better forwardslash command support, match any single-word /token
    # unless it is clearly just markdown formatting (like / in a path).
    return bool(re.fullmatch(r"/[a-z0-9_-]{2,}", command))


def _clip(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "\u2026"


def _escape_sql_like_term(value: str | None) -> str:
    token = str(value or "")
    return token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _chunked_values(values: list[str], chunk_size: int) -> Iterable[list[str]]:
    size = max(1, int(chunk_size or 1))
    for index in range(0, len(values), size):
        chunk = values[index : index + size]
        if chunk:
            yield chunk


def _is_search_row_encoding_error(exc: Exception) -> bool:
    lowered = str(exc or "").lower()
    return "invalid byte sequence" in lowered or "characternotinrepertoire" in lowered


def _exec_search_rows_resilient(
    session: Any,
    ids: list[str],
    build_query: Callable[[list[str]], Any],
    *,
    label: str,
) -> list[Any]:
    clean_ids = [str(item or "").strip() for item in ids if str(item or "").strip()]
    if not clean_ids:
        return []
    try:
        return list(session.exec(build_query(clean_ids)).all())
    except DataError as exc:
        if not _is_search_row_encoding_error(exc):
            raise
        try:
            session.rollback()
        except Exception:
            pass
        if len(clean_ids) == 1:
            logger.warning("search skipping malformed UTF-8 row during %s fetch: %s", label, clean_ids[0])
            return []
        midpoint = max(1, len(clean_ids) // 2)
        rows: list[Any] = []
        for retry_ids in (clean_ids[:midpoint], clean_ids[midpoint:]):
            if not retry_ids:
                continue
            with get_session() as retry_session:
                rows.extend(_exec_search_rows_resilient(retry_session, retry_ids, build_query, label=label))
        return rows


def _combined_log_text(content: str | None, summary: str | None, raw: str | None) -> str:
    parts = [
        _sanitize_log_text(content or ""),
        _sanitize_log_text(summary or ""),
        _sanitize_log_text(raw or ""),
    ]
    return " ".join(part for part in parts if part).strip()


def _is_tool_trace_text(content: str | None, summary: str | None, raw: str | None) -> bool:
    combined = _combined_log_text(content, summary, raw).lower()
    if not combined:
        return False
    return (
        "tool call:" in combined
        or "tool result:" in combined
        or "tool error:" in combined
    )


def _is_memory_action_text(content: str | None, summary: str | None, raw: str | None) -> bool:
    combined = _combined_log_text(content, summary, raw).lower()
    if not combined:
        return False
    if "tool call:" in combined or "tool result:" in combined or "tool error:" in combined:
        if re.search(r"\bmemory[_-]?(search|get|query|fetch|retrieve|read|write|store|list|prune|delete)\b", combined):
            return True
    return False


def _is_subagent_session_key(session_key: str | None) -> bool:
    key = str(session_key or "").strip().lower()
    if not key:
        return False
    base = key.split("|", 1)[0].strip()
    return ":subagent:" in base


def _session_key_supports_bundle_tool_scoping(session_key: str | None) -> bool:
    base = str(session_key or "").strip().lower().split("|", 1)[0].strip()
    if not base:
        return False
    if base.startswith("channel:"):
        return True
    if base.startswith("clawboard:topic:"):
        return True
    return ":clawboard:topic:" in base


def _is_subagent_scaffold_text(content: str | None, summary: str | None, raw: str | None) -> bool:
    combined = _combined_log_text(content, summary, raw)
    if not combined:
        return False
    return bool(re.match(r"^\s*\[subagent context\]", combined, flags=re.IGNORECASE))


def _is_heartbeat_control_plane_text(content: str | None, summary: str | None, raw: str | None) -> bool:
    combined = _combined_log_text(content, summary, raw)
    if not combined:
        return False
    if re.match(r"^\s*\[cron:[^\]]+\]", combined, flags=re.IGNORECASE):
        return True
    if re.match(r"^\s*heartbeat\s*:", combined, flags=re.IGNORECASE):
        return True
    if re.match(r"^\s*heartbeat_ok\s*$", combined, flags=re.IGNORECASE):
        return True
    return bool(re.search(r"heartbeat and watchdog recovery check", combined, flags=re.IGNORECASE))


def _is_control_plane_conversation_payload(
    *,
    content: str | None,
    summary: str | None,
    raw: str | None,
    source_channel: str | None,
    source_session_key: str | None,
) -> bool:
    channel = str(source_channel or "").strip().lower()
    session_key = str(source_session_key or "").strip().lower()
    is_main_session = (session_key.split("|", 1)[0].strip() == "agent:main:main")
    if channel in {"heartbeat", "cron-event"}:
        return True
    if not is_main_session:
        return False
    return _is_heartbeat_control_plane_text(content, summary, raw)


def _is_tool_call_log(entry: LogEntry) -> bool:
    if getattr(entry, "type", None) != "action":
        return False
    return _is_tool_trace_text(
        _safe_log_attr_text(entry, "content"),
        _safe_log_attr_text(entry, "summary"),
        _safe_log_attr_text(entry, "raw"),
    )


def _log_reindex_text(entry: LogEntry) -> str:
    log_type = str(getattr(entry, "type", "") or "")
    if log_type in ("system", "import"):
        return ""
    if not SEARCH_INCLUDE_TOOL_CALL_LOGS and _is_tool_call_log(entry):
        return ""
    if _is_memory_action_log(entry) or _is_command_log(entry):
        return ""
    parts = [
        _sanitize_log_text(_safe_log_attr_text(entry, "summary")),
        _sanitize_log_text(_safe_log_attr_text(entry, "content")),
        _sanitize_log_text(_safe_log_attr_text(entry, "raw")),
    ]
    text = " ".join(part for part in parts if part)
    return _clip(text, 1200)


def _is_memory_action_log(entry: LogEntry) -> bool:
    if getattr(entry, "type", None) != "action":
        return False
    combined = " ".join(
        part
        for part in [
            _safe_log_attr_text(entry, "summary"),
            _safe_log_attr_text(entry, "content"),
            _safe_log_attr_text(entry, "raw"),
        ]
        if part
    ).lower()
    if "tool call:" in combined or "tool result:" in combined or "tool error:" in combined:
        if re.search(r"\bmemory[_-]?(search|get|query|fetch|retrieve|read|write|store|list|prune|delete)\b", combined):
            return True
    return False


def _log_allowed_for_semantic_search(entry: LogEntry) -> bool:
    log_type = str(getattr(entry, "type", "") or "")
    if log_type in ("system", "import"):
        return False
    if not SEARCH_INCLUDE_TOOL_CALL_LOGS and _is_tool_call_log(entry):
        return False
    if _is_memory_action_log(entry) or _is_command_log(entry):
        return False
    return True


def _enqueue_log_reindex(entry: LogEntry) -> None:
    # Late import to avoid circular dependency with main.py
    from .main import enqueue_reindex_request

    text = _log_reindex_text(entry)
    if not text:
        enqueue_reindex_request({"op": "delete", "kind": "log", "id": entry.id})
        return
    enqueue_reindex_request({"op": "upsert", "kind": "log", "id": entry.id, "text": text, "topicId": entry.topicId})


def _session_keys_equivalent(source_key: str | None, target_key: str | None) -> bool:
    lhs = str(source_key or "").strip()
    rhs = str(target_key or "").strip()
    if not lhs or not rhs:
        return False
    if lhs == rhs:
        return True

    lhs_base = lhs.split("|", 1)[0].strip()
    rhs_base = rhs.split("|", 1)[0].strip()
    if not lhs_base or not rhs_base:
        return False
    if lhs_base == rhs_base:
        return True
    if lhs.startswith(f"{rhs_base}|") or rhs.startswith(f"{lhs_base}|"):
        return True

    # Board sessions can be wrapped by agent prefixes
    # (`agent:main:clawboard:topic:*`, etc.).
    # Late import to avoid circular dependency with main.py
    from .main import _parse_board_session_key

    lhs_topic = _parse_board_session_key(lhs)
    rhs_topic = _parse_board_session_key(rhs)
    return bool(lhs_topic and rhs_topic and lhs_topic == rhs_topic)


def _log_matches_session(entry: LogEntry, session_key: str) -> bool:
    source = getattr(entry, "source", None)
    if not isinstance(source, dict):
        return False
    source_key = str(source.get("sessionKey") or "").strip()
    target_key = str(session_key or "").strip()
    return _session_keys_equivalent(source_key, target_key)
