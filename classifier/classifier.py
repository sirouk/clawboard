from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import time
import shutil
import signal
import uuid
from datetime import datetime, timezone
from difflib import SequenceMatcher
try:
    import requests  # type: ignore
except Exception:  # pragma: no cover
    requests = None  # type: ignore

try:
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover
    np = None  # type: ignore

try:
    from fastembed import TextEmbedding  # type: ignore
except Exception:  # pragma: no cover
    TextEmbedding = None  # type: ignore

try:
    from .embeddings_store import (  # type: ignore
        delete as embed_delete,
        delete_task_other_namespaces,
        topk as embed_topk,
        upsert as embed_upsert,
    )
except Exception:  # pragma: no cover
    from embeddings_store import (  # type: ignore
        delete as embed_delete,
        delete_task_other_namespaces,
        topk as embed_topk,
        upsert as embed_upsert,
    )

CLAWBOARD_API_BASE = os.environ.get("CLAWBOARD_API_BASE", "http://localhost:8010").rstrip("/")
CLAWBOARD_TOKEN = os.environ.get("CLAWBOARD_TOKEN")

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "http://127.0.0.1:18789").rstrip("/")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN")
OPENCLAW_MODEL = os.environ.get("OPENCLAW_MODEL", "openai-codex/gpt-5.2")
CLASSIFIER_LLM_MODE = os.environ.get("CLASSIFIER_LLM_MODE", "auto").strip().lower()

OPENCLAW_INTERNAL_SESSION_PREFIX = os.environ.get(
    "OPENCLAW_INTERNAL_SESSION_PREFIX",
    "internal:clawboard-classifier:",
).strip()

BOARD_TOPIC_SESSION_PREFIX = "clawboard:topic:"
BOARD_TASK_SESSION_PREFIX = "clawboard:task:"

INTERVAL = int(os.environ.get("CLASSIFIER_INTERVAL_SECONDS", "10"))
MAX_ATTEMPTS = int(os.environ.get("CLASSIFIER_MAX_ATTEMPTS", "3"))
MAX_SESSIONS_PER_CYCLE = int(os.environ.get("CLASSIFIER_MAX_SESSIONS_PER_CYCLE", "8"))
MAX_SESSION_SECONDS = float(os.environ.get("CLASSIFIER_MAX_SESSION_SECONDS", "75"))
CYCLE_BUDGET_SECONDS = float(
    os.environ.get(
        "CLASSIFIER_CYCLE_BUDGET_SECONDS",
        str(max(30, INTERVAL * 3)),
    )
)
LOG_TIMING = os.environ.get("CLASSIFIER_LOG_TIMING", "").strip().lower() in {"1", "true", "yes", "on"}


class _ClassifierTimeout(Exception):
    pass


def _timeout_handler(_signum, _frame):
    raise _ClassifierTimeout()


def _run_with_timeout(seconds: float, fn, *args, **kwargs):
    """Best-effort guardrail so one slow session doesn't block the whole cycle."""
    if seconds <= 0:
        return fn(*args, **kwargs)
    if not hasattr(signal, "SIGALRM"):
        return fn(*args, **kwargs)
    previous = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, _timeout_handler)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        return fn(*args, **kwargs)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        try:
            signal.signal(signal.SIGALRM, previous)
        except Exception:
            pass


def _parse_board_session_key(session_key: str) -> tuple[str | None, str | None]:
    key = str(session_key or "").strip()
    if not key:
        return (None, None)

    # OpenClaw may attach thread suffixes (`|thread:...`). Strip those for routing.
    base = (key.split("|", 1)[0] or "").strip()
    if not base:
        return (None, None)

    if base.startswith(BOARD_TOPIC_SESSION_PREFIX):
        topic_id = base[len(BOARD_TOPIC_SESSION_PREFIX) :].strip()
        return (topic_id or None, None)

    if base.startswith(BOARD_TASK_SESSION_PREFIX):
        rest = base[len(BOARD_TASK_SESSION_PREFIX) :].strip()
        if not rest:
            return (None, None)
        parts = rest.split(":", 1)
        if len(parts) != 2:
            return (None, None)
        topic_id = (parts[0] or "").strip()
        task_id = (parts[1] or "").strip()
        if not topic_id or not task_id:
            return (None, None)
        return (topic_id, task_id)

    return (None, None)

WINDOW_SIZE = int(os.environ.get("CLASSIFIER_WINDOW_SIZE", "24"))
LOOKBACK_LOGS = int(os.environ.get("CLASSIFIER_LOOKBACK_LOGS", "80"))
TOPIC_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TOPIC_SIM_THRESHOLD", "0.78"))
TASK_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TASK_SIM_THRESHOLD", "0.80"))
EMBED_MODEL = os.environ.get("CLASSIFIER_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
TOPIC_NAME_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TOPIC_NAME_SIM_THRESHOLD", "0.86"))
TASK_NAME_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TASK_NAME_SIM_THRESHOLD", "0.88"))
SUMMARY_MAX = int(os.environ.get("CLASSIFIER_SUMMARY_MAX", "56"))

LOCK_PATH = os.environ.get("CLASSIFIER_LOCK_PATH", "/data/classifier.lock")
REINDEX_QUEUE_PATH = os.environ.get("CLASSIFIER_REINDEX_QUEUE_PATH", "/data/reindex-queue.jsonl")
CREATION_AUDIT_PATH = os.environ.get("CLASSIFIER_CREATION_AUDIT_PATH", "/data/creation-gate.jsonl")
CLASSIFIER_AUDIT_PATH = (os.environ.get("CLASSIFIER_AUDIT_PATH") or "").strip() or None

SESSION_ROUTING_ENABLED = (os.environ.get("CLASSIFIER_SESSION_ROUTING_ENABLED", "1") or "1").strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}
SESSION_ROUTING_PROMPT_ITEMS = int(os.environ.get("CLASSIFIER_SESSION_ROUTING_PROMPT_ITEMS", "4"))

# Audit file retention/rotation (size-based). These logs are useful in production, but must be bounded.
CREATION_AUDIT_MAX_BYTES = int(os.environ.get("CLASSIFIER_CREATION_AUDIT_MAX_BYTES", str(8 * 1024 * 1024)))
CREATION_AUDIT_MAX_FILES = int(os.environ.get("CLASSIFIER_CREATION_AUDIT_MAX_FILES", "12"))
CLASSIFIER_AUDIT_MAX_BYTES = int(os.environ.get("CLASSIFIER_AUDIT_MAX_BYTES", str(16 * 1024 * 1024)))
CLASSIFIER_AUDIT_MAX_FILES = int(os.environ.get("CLASSIFIER_AUDIT_MAX_FILES", "8"))

OPENCLAW_MEMORY_DB_PATH = os.environ.get("OPENCLAW_MEMORY_DB_PATH")
OPENCLAW_MEMORY_DB_FALLBACK = os.environ.get("OPENCLAW_MEMORY_DB_FALLBACK", "/data/openclaw-memory/main.sqlite")
OPENCLAW_MEMORY_MAX_HITS = int(os.environ.get("OPENCLAW_MEMORY_MAX_HITS", "6"))

_embedder = None
_embed_failed = False
_embed_cache: dict[str, np.ndarray] = {}
_EMBED_CACHE_MAX = 1200
SUMMARY_DROP_WORDS = {
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "to",
    "of",
    "for",
    "in",
    "on",
    "at",
    "from",
    "with",
    "about",
    "into",
    "by",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "it",
    "this",
    "that",
    "these",
    "those",
    "i",
    "you",
    "we",
    "they",
    "he",
    "she",
    "can",
    "could",
    "would",
    "should",
    "will",
    "please",
    "just",
    "very",
}

GENERIC_TOPIC_NAMES = {
    "general",
    "misc",
    "miscellaneous",
    "new",
    "topic",
    "topics",
    "task",
    "tasks",
    "todo",
    "note",
    "notes",
    "log",
    "logs",
    "board",
    "graph",
    "clawgraph",
    "clawboard",
}

GENERIC_TASK_TITLES = {
    "todo",
    "task",
    "new task",
    "follow up",
    "next step",
    "action item",
}

SLASH_COMMANDS = {
    "/new",
    "/topic",
    "/topics",
    "/task",
    "/tasks",
    "/log",
    "/logs",
    "/board",
    "/graph",
    "/help",
    "/reset",
    "/clear",
}

TOPIC_INTENT_CUES = {
    "topic",
    "project",
    "initiative",
    "area",
    "stream",
    "workstream",
    "track",
    "focus",
    "category",
    "theme",
    "bucket",
}

TASK_INTENT_CUES = {
    "todo",
    "to do",
    "next step",
    "action item",
    "follow up",
    "need to",
    "must",
    "fix",
    "build",
    "create",
    "implement",
    "update",
    "investigate",
    "test",
    "deploy",
    "refactor",
    "add",
    "remove",
    "restore",
    "restart",
    "audit",
    "ship",
    "complete",
}

SMALL_TALK_CUES = (
    # Normalized (lowercased, punctuation stripped) substrings.
    "how s your day",
    "hows your day",
    "your day going",
    "no big plans",
    "taking it easy",
    "this weekend",
    "latte",
    "coffee",
    "cinnamon latte",
)

INFORMATIONAL_REQUEST_CUES = {
    "tell me",
    "all about",
    "what do you remember",
    "what do we know",
    "summarize",
    "summary",
    "recap",
    "explain",
    "walk me through",
    "deep in memory",
}

TOPIC_FOCUS_STOPWORDS = {
    "the",
    "this",
    "that",
    "these",
    "those",
    "work",
    "project",
    "topic",
    "task",
    "memory",
    "details",
    "history",
}

LOW_SIGNAL_TOPIC_PREFIXES = (
    "let ",
    "lets ",
    "let's ",
    "can ",
    "can you",
    "could ",
    "would ",
    "should ",
    "please ",
    "i ",
    "i'm ",
    "im ",
    "we ",
    "what ",
    "how ",
    "why ",
    "tell ",
    "show ",
    "review ",
    "summarize ",
)

LOW_SIGNAL_SUMMARY_PREFIXES = (
    "let ",
    "lets ",
    "let's ",
    "can ",
    "could ",
    "would ",
    "please ",
    "what ",
    "how ",
    "why ",
    "ok ",
    "okay ",
    "hey ",
    "hi ",
)

AFFIRMATIONS = {
    "yes",
    "y",
    "yep",
    "yeah",
    "ok",
    "okay",
    "sounds good",
    "do it",
    "please do",
    "go ahead",
    "ship it",
    "works for me",
}

def _llm_enabled() -> bool:
    mode = CLASSIFIER_LLM_MODE
    if mode in {"0", "false", "no", "off", "disable", "disabled", "heuristic", "no-llm"}:
        return False
    if requests is None:
        return False
    # "auto" only enables the LLM when credentials are configured.
    if not OPENCLAW_GATEWAY_TOKEN:
        return False
    if mode in {"1", "true", "yes", "on", "enable", "enabled", "auto"}:
        return True
    # Unknown value -> behave like auto (safe default).
    return True


def headers_clawboard(actor: str | None = None):
    if requests is None:
        raise RuntimeError("classifier dependency missing: requests")
    h = {"Content-Type": "application/json"}
    if CLAWBOARD_TOKEN:
        h["X-Clawboard-Token"] = CLAWBOARD_TOKEN
    if actor:
        h["X-Clawboard-Actor"] = str(actor).strip()
    return h


def oc_headers():
    if not OPENCLAW_GATEWAY_TOKEN:
        raise RuntimeError("OPENCLAW_GATEWAY_TOKEN is required")
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
    }


def oc_headers_with_session(session_key: str | None):
    headers = oc_headers()
    if session_key:
        # OpenClaw gateway honors this header and uses it as the session key for the run.
        # We tag classifier runs with a stable prefix so Clawboard logger can ignore them.
        headers["x-openclaw-session-key"] = session_key
    return headers


def _openclaw_internal_session_key(kind: str) -> str:
    prefix = (OPENCLAW_INTERNAL_SESSION_PREFIX or "internal:clawboard-classifier:").strip()
    if not prefix.endswith(":"):
        prefix = prefix + ":"
    safe_kind = re.sub(r"[^a-z0-9_-]+", "-", (kind or "run").strip().lower())[:32] or "run"
    return f"{prefix}{safe_kind}:{uuid.uuid4()}"


class _StrictJsonError(Exception):
    pass


def _parse_strict_json(text: str):
    if not isinstance(text, str):
        raise _StrictJsonError("expected JSON text response")
    raw = text.strip()
    if not raw:
        raise _StrictJsonError("empty JSON response")
    try:
        return json.loads(raw)
    except Exception as exc:
        preview = raw[:240].replace("\n", "\\n")
        raise _StrictJsonError(f"invalid JSON response: {preview}") from exc


def _validate_classifier_result(obj: object, pending_ids: list[str]) -> dict:
    if not isinstance(obj, dict):
        raise _StrictJsonError("classifier output must be a JSON object")

    pending_unique: list[str] = []
    pending_seen: set[str] = set()
    for sid in pending_ids:
        if not isinstance(sid, str):
            continue
        key = sid.strip()
        if not key or key in pending_seen:
            continue
        pending_seen.add(key)
        pending_unique.append(key)

    topic = obj.get("topic")
    if not isinstance(topic, dict):
        raise _StrictJsonError("classifier output.topic must be an object")
    topic_id = topic.get("id")
    if topic_id is not None and not isinstance(topic_id, str):
        raise _StrictJsonError("classifier output.topic.id must be string|null")
    topic_name = topic.get("name")
    if not isinstance(topic_name, str) or not topic_name.strip():
        raise _StrictJsonError("classifier output.topic.name must be a non-empty string")
    topic_create = topic.get("create")
    if not isinstance(topic_create, bool):
        raise _StrictJsonError("classifier output.topic.create must be a boolean")

    task_out: dict | None = None
    task_val = obj.get("task")
    if task_val is None:
        task_out = None
    elif isinstance(task_val, dict):
        task_id = task_val.get("id")
        if task_id is not None and not isinstance(task_id, str):
            raise _StrictJsonError("classifier output.task.id must be string|null")
        task_title = task_val.get("title")
        if task_title is not None and not isinstance(task_title, str):
            raise _StrictJsonError("classifier output.task.title must be string|null")
        task_create = task_val.get("create")
        if not isinstance(task_create, bool):
            raise _StrictJsonError("classifier output.task.create must be a boolean")
        task_out = {
            "id": task_id.strip() if isinstance(task_id, str) and task_id.strip() else None,
            "title": task_title.strip() if isinstance(task_title, str) and task_title.strip() else None,
            "create": task_create,
        }
    else:
        raise _StrictJsonError("classifier output.task must be object|null")

    summaries = obj.get("summaries")
    if not isinstance(summaries, list):
        raise _StrictJsonError("classifier output.summaries must be an array")

    by_id: dict[str, str] = {}
    for item in summaries:
        if not isinstance(item, dict):
            raise _StrictJsonError("classifier output.summaries entries must be objects")
        sid = item.get("id")
        summary = item.get("summary")
        if not isinstance(sid, str) or not sid.strip():
            raise _StrictJsonError("classifier output.summaries[].id must be a non-empty string")
        if not isinstance(summary, str) or not summary.strip():
            raise _StrictJsonError("classifier output.summaries[].summary must be a non-empty string")
        key = sid.strip()
        if key not in pending_seen:
            raise _StrictJsonError("classifier output contains summary for unknown id")
        if key in by_id:
            raise _StrictJsonError("classifier output contains duplicate summary ids")
        by_id[key] = summary.strip()

    missing = [sid for sid in pending_unique if sid not in by_id]
    if missing:
        raise _StrictJsonError(f"classifier output missing summaries for {len(missing)} id(s)")

    normalized = {
        "topic": {
            "id": topic_id.strip() if isinstance(topic_id, str) and topic_id.strip() else None,
            "name": topic_name.strip(),
            "create": topic_create,
        },
        "task": task_out,
        "summaries": [{"id": sid, "summary": by_id[sid]} for sid in pending_unique],
    }
    return normalized


def _validate_creation_gate_result(obj: object) -> dict:
    if not isinstance(obj, dict):
        raise _StrictJsonError("creation gate output must be a JSON object")

    create_topic = obj.get("createTopic")
    create_task = obj.get("createTask")
    if not isinstance(create_topic, bool):
        raise _StrictJsonError("creation gate createTopic must be boolean")
    if not isinstance(create_task, bool):
        raise _StrictJsonError("creation gate createTask must be boolean")

    topic_id = obj.get("topicId")
    task_id = obj.get("taskId")
    if topic_id is not None and not isinstance(topic_id, str):
        raise _StrictJsonError("creation gate topicId must be string|null")
    if task_id is not None and not isinstance(task_id, str):
        raise _StrictJsonError("creation gate taskId must be string|null")

    return {
        "createTopic": create_topic,
        "topicId": topic_id.strip() if isinstance(topic_id, str) and topic_id.strip() else None,
        "createTask": create_task,
        "taskId": task_id.strip() if isinstance(task_id, str) and task_id.strip() else None,
    }


def _validate_summary_repair_result(obj: object, pending_ids: list[str]) -> dict[str, str]:
    if not isinstance(obj, dict):
        raise _StrictJsonError("summary repair output must be a JSON object")
    summaries = obj.get("summaries")
    if not isinstance(summaries, list):
        raise _StrictJsonError("summary repair summaries must be an array")

    pending_set = {sid.strip() for sid in pending_ids if isinstance(sid, str) and sid.strip()}
    out: dict[str, str] = {}
    for item in summaries:
        if not isinstance(item, dict):
            raise _StrictJsonError("summary repair summaries entries must be objects")
        sid = item.get("id")
        stext = item.get("summary")
        if not isinstance(sid, str) or not sid.strip():
            raise _StrictJsonError("summary repair summaries[].id must be a non-empty string")
        if not isinstance(stext, str) or not stext.strip():
            raise _StrictJsonError("summary repair summaries[].summary must be a non-empty string")
        key = sid.strip()
        if key not in pending_set:
            raise _StrictJsonError("summary repair contains summary for unknown id")
        if key in out:
            raise _StrictJsonError("summary repair contains duplicate summary ids")
        out[key] = _concise_summary(stext.strip())

    missing = [sid for sid in pending_set if sid not in out]
    if missing:
        raise _StrictJsonError(f"summary repair missing {len(missing)} id(s)")
    return out


def embedder():
    global _embedder, _embed_failed
    if TextEmbedding is None or np is None:
        _embed_failed = True
        return None
    if _embed_failed:
        return None
    if _embedder is None:
        try:
            _embedder = TextEmbedding(model_name=EMBED_MODEL)
        except Exception as exc:
            message = str(exc)
            recoverable = "NO_SUCHFILE" in message or "File doesn't exist" in message
            if recoverable:
                # Corrupt/partial fastembed cache can happen on abrupt container restarts.
                # Reset cache and retry once.
                shutil.rmtree("/tmp/fastembed_cache", ignore_errors=True)
                try:
                    _embedder = TextEmbedding(model_name=EMBED_MODEL)
                except Exception as retry_exc:
                    print(f"classifier: embeddings unavailable after cache reset: {retry_exc}")
                    _embed_failed = True
                    return None
            else:
                print(f"classifier: embeddings init failed: {exc}")
                _embed_failed = True
                return None
    return _embedder


def embed_text(text: str):
    key = (text or "").strip()
    if not key:
        return None
    cached = _embed_cache.get(key)
    if cached is not None:
        return cached

    emb = embedder()
    if emb is None:
        return None
    try:
        vec = next(emb.embed([key]))
        arr = np.asarray(vec, dtype=np.float32)
        if arr.size == 0:
            return None
        if len(_embed_cache) >= _EMBED_CACHE_MAX:
            _embed_cache.clear()
        _embed_cache[key] = arr
        return arr
    except Exception as exc:
        print(f"classifier: embeddings encode failed: {exc}")
        return None


def _memory_db_path() -> str | None:
    if OPENCLAW_MEMORY_DB_PATH and os.path.exists(OPENCLAW_MEMORY_DB_PATH):
        return OPENCLAW_MEMORY_DB_PATH
    if OPENCLAW_MEMORY_DB_FALLBACK and os.path.exists(OPENCLAW_MEMORY_DB_FALLBACK):
        return OPENCLAW_MEMORY_DB_FALLBACK
    return None


def _fts_query(text: str) -> str | None:
    words = re.findall(r"[A-Za-z0-9]{4,}", text.lower())
    if not words:
        return None
    uniq: list[str] = []
    for w in words:
        if w not in uniq:
            uniq.append(w)
    return " OR ".join(uniq[:12])


def memory_snippets(query_text: str):
    path = _memory_db_path()
    if not path:
        return []
    q = _fts_query(query_text)
    if not q:
        return []
    try:
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            """
            SELECT id, path, start_line, end_line,
                   snippet(chunks_fts, 0, '', '', ' … ', 20) as snippet,
                   bm25(chunks_fts) as score
            FROM chunks_fts
            WHERE chunks_fts MATCH ?
              AND source = 'memory'
            ORDER BY score
            LIMIT ?
            """,
            (q, OPENCLAW_MEMORY_MAX_HITS),
        )
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    except Exception:
        return []


def _log_text(entry: dict) -> str:
    parts = [entry.get("content"), entry.get("summary"), entry.get("raw")]
    return "\n".join([p for p in parts if isinstance(p, str)]).strip()


def _is_classifier_payload(text: str) -> bool:
    if not text:
        return False
    t = text.strip()
    if not t.startswith("{"):
        return False
    markers = [
        "\"window\"",
        "\"candidateTopics\"",
        "\"candidateTasks\"",
        "\"topic\"",
        "\"task\"",
        "\"instructions\"",
        "\"summaries\"",
    ]
    if any(m in t for m in markers):
        return True

    # Some internal control payloads are small (e.g., topic/task creation gates).
    control_markers = ["\"createTopic\"", "\"createTask\"", "\"topicId\"", "\"taskId\""]
    hits = 0
    for m in control_markers:
        if m in t:
            hits += 1
    return hits >= 2


def _is_injected_context_artifact(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    if "[clawboard_context_begin]" in lower and "[clawboard_context_end]" in lower:
        return True
    return (
        "clawboard continuity hook is active for this turn" in lower
        and "use this clawboard retrieval context merged with existing openclaw memory/turn context" in lower
    )


def _noise_error_code(text: str) -> str:
    if _is_classifier_payload(text):
        return "classifier_payload_noise"
    if _is_injected_context_artifact(text):
        return "context_injection_noise"
    return "conversation_noise"


def _is_noise_conversation(entry: dict) -> bool:
    if entry.get("type") != "conversation":
        return False
    text = _log_text(entry)
    return _is_classifier_payload(text) or _is_injected_context_artifact(text)


def _is_memory_action(entry: dict) -> bool:
    if entry.get("type") != "action":
        return False
    text = _log_text(entry).lower()
    if "tool call:" in text or "tool result:" in text or "tool error:" in text:
        if re.search(r"\bmemory[_-]?(search|get|query|fetch|retrieve|read|write|store|list|prune|delete)\b", text):
            return True
    return False


def _is_command_conversation(entry: dict) -> bool:
    if entry.get("type") != "conversation":
        return False
    text = _strip_transport_noise(entry.get("content") or entry.get("summary") or entry.get("raw") or "")
    if not text:
        return False
    return _is_command_text(text)


def _is_context_log(entry: dict) -> bool:
    if entry.get("type") not in ("conversation", "note"):
        return False
    if _is_command_conversation(entry):
        return False
    if _is_noise_conversation(entry):
        return False
    return True


def _normalize_text(text: str) -> str:
    normalized = (text or "").lower()
    replacements = {
        "ops": "operations",
        "msg": "message",
        "msgs": "messages",
    }
    for short, full in replacements.items():
        normalized = re.sub(rf"\b{short}\b", full, normalized)
    normalized = re.sub(r"[^a-z0-9\s]+", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


TOKEN_STOP_WORDS = {
    "a",
    "an",
    "about",
    "and",
    "are",
    "been",
    "for",
    "from",
    "has",
    "have",
    "in",
    "into",
    "is",
    "of",
    "on",
    "that",
    "the",
    "this",
    "to",
    "were",
    "what",
    "when",
    "where",
    "with",
    # Meta tokens that frequently appear in instructions but are weak topic anchors.
    "e2e",
}


def _token_set(text: str) -> set[str]:
    return {w for w in _normalize_text(text).split(" ") if len(w) > 2 and w not in TOKEN_STOP_WORDS}


def _token_list(text: str) -> list[str]:
    return [w for w in _normalize_text(text).split(" ") if len(w) > 1 and w not in TOKEN_STOP_WORDS]


def _bm25_scores(query_text: str, docs: dict[str, str], k1: float = 1.6, b: float = 0.68):
    query_tokens = [token for token in _token_list(query_text) if token]
    if not query_tokens or not docs:
        return {}

    tokenized: dict[str, list[str]] = {doc_id: _token_list(text) for doc_id, text in docs.items()}
    tokenized = {doc_id: tokens for doc_id, tokens in tokenized.items() if tokens}
    if not tokenized:
        return {}

    doc_count = len(tokenized)
    avg_len = sum(len(tokens) for tokens in tokenized.values()) / max(1, doc_count)
    term_doc_freq: dict[str, int] = {}
    tf_per_doc: dict[str, dict[str, int]] = {}
    for doc_id, tokens in tokenized.items():
        counts: dict[str, int] = {}
        for token in tokens:
            counts[token] = counts.get(token, 0) + 1
        tf_per_doc[doc_id] = counts
        for token in counts.keys():
            term_doc_freq[token] = term_doc_freq.get(token, 0) + 1

    unique_query = list(dict.fromkeys(query_tokens))
    scores: dict[str, float] = {}
    for doc_id, tokens in tokenized.items():
        dl = max(1, len(tokens))
        counts = tf_per_doc.get(doc_id, {})
        score = 0.0
        for token in unique_query:
            tf = counts.get(token, 0)
            if tf <= 0:
                continue
            df = term_doc_freq.get(token, 0)
            idf = math.log(1 + ((doc_count - df + 0.5) / (df + 0.5)))
            numerator = tf * (k1 + 1.0)
            denominator = tf + k1 * (1.0 - b + b * (dl / max(1e-8, avg_len)))
            score += idf * (numerator / max(1e-8, denominator))
        if score > 0:
            scores[doc_id] = float(score)
    return scores


def _normalize_score_map(scores: dict[str, float]):
    if not scores:
        return {}
    values = [float(v) for v in scores.values()]
    hi = max(values)
    lo = min(values)
    if hi <= lo:
        # Degenerate case (all scores equal). Returning 1.0 here makes downstream
        # fusion treat a single candidate as "perfect match", which causes
        # false-positive topic/task attachments (especially when only one topic exists).
        #
        # Instead, preserve magnitude with a stable squash into [0, 1].
        def squash(x: float) -> float:
            x = float(x)
            if x <= 0:
                return 0.0
            if x <= 1:
                return x
            return x / (x + 1.0)

        return {k: squash(float(v)) for k, v in scores.items()}
    return {k: (float(v) - lo) / (hi - lo) for k, v in scores.items()}


def _rrf_fuse(score_maps: list[dict[str, float]], weights: list[float] | None = None, k: int = 60):
    if not score_maps:
        return {}
    if not weights:
        weights = [1.0 for _ in score_maps]
    fused: dict[str, float] = {}
    for score_map, weight in zip(score_maps, weights):
        ranked = sorted(score_map.items(), key=lambda item: item[1], reverse=True)
        for rank, (doc_id, _score) in enumerate(ranked, start=1):
            fused[doc_id] = fused.get(doc_id, 0.0) + (float(weight) / float(k + rank))
    return fused


def _late_interaction_score(query_text: str, candidate_text: str) -> float:
    lexical = _name_similarity(query_text, candidate_text)
    q_tokens = _token_set(query_text)
    c_tokens = _token_set(candidate_text)
    coverage = (len(q_tokens & c_tokens) / max(1, len(q_tokens))) if q_tokens else 0.0
    phrase = 1.0 if _normalize_text(query_text) in _normalize_text(candidate_text) else 0.0
    dense = 0.0
    q_vec = embed_text(query_text)
    c_vec = embed_text(candidate_text)
    if q_vec is not None and c_vec is not None:
        try:
            q_arr = np.asarray(q_vec, dtype=np.float32)
            c_arr = np.asarray(c_vec, dtype=np.float32)
            denom = float(np.linalg.norm(q_arr) * np.linalg.norm(c_arr))
            if denom > 0:
                dense = max(0.0, float(np.dot(q_arr, c_arr) / denom))
        except Exception:
            dense = 0.0
    return (dense * 0.56) + (coverage * 0.24) + (lexical * 0.16) + (phrase * 0.04)


def _name_similarity(a: str, b: str) -> float:
    na = _normalize_text(a)
    nb = _normalize_text(b)
    if not na or not nb:
        return 0.0
    seq = SequenceMatcher(None, na, nb).ratio()
    ta = _token_set(na)
    tb = _token_set(nb)
    token = len(ta & tb) / len(ta | tb) if (ta or tb) else 0.0
    return (seq * 0.72) + (token * 0.28)


def _best_name_match(name: str, items: list[dict], key: str):
    best = None
    best_score = 0.0
    for item in items:
        label = item.get(key)
        if not label:
            continue
        score = _name_similarity(name, str(label))
        if score > best_score:
            best_score = score
            best = item
    return best, best_score


def _strip_transport_noise(text: str) -> str:
    clean = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    clean = re.sub(r"(?im)^\s*summary\s*[:\-]\s*", "", clean)
    clean = re.sub(r"(?im)^\[Discord [^\]]+\]\s*", "", clean)
    clean = re.sub(r"(?i)\[message[_\s-]?id:[^\]]+\]", "", clean)
    clean = re.sub(r"\n{3,}", "\n\n", clean)
    return clean.strip()


def _strip_slash_command(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned.startswith("/"):
        return cleaned
    parts = cleaned.split(None, 1)
    command = parts[0].lower()
    if command in SLASH_COMMANDS:
        return parts[1].strip() if len(parts) > 1 else ""
    return ""


def _is_command_text(text: str) -> bool:
    cleaned = (text or "").strip()
    if not cleaned:
        return False
    if not cleaned.startswith("/"):
        return False
    command = cleaned.split(None, 1)[0].lower()
    if command in SLASH_COMMANDS:
        return True
    return bool(re.fullmatch(r"/[a-z0-9_-]{2,}", command))


def _is_system_artifact_text(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    if "tool call:" in lower or "tool result:" in lower or "tool error:" in lower:
        return True
    if "classifier" in lower and "payload" in lower:
        return True
    if re.search(r"\bmemory[_-]?(search|get|query|fetch|retrieve|read|write|store|list|prune|delete)\b", lower):
        return True
    return False


def _is_affirmation(text: str) -> bool:
    cleaned = _strip_transport_noise(text)
    cleaned = re.sub(r"[^a-zA-Z0-9\s]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().lower()
    if not cleaned:
        return False
    if len(cleaned) > 24:
        return False
    if cleaned in AFFIRMATIONS:
        return True
    # Common patterns like "yes, do it" should count as affirmation.
    if cleaned.startswith("yes "):
        rest = cleaned[4:].strip()
        return rest in AFFIRMATIONS
    if cleaned.startswith("ok "):
        rest = cleaned[3:].strip()
        return rest in AFFIRMATIONS
    if cleaned.startswith("okay "):
        rest = cleaned[5:].strip()
        return rest in AFFIRMATIONS
    return False


def _latest_user_text(window: list[dict]) -> tuple[str, int]:
    for idx in range(len(window) - 1, -1, -1):
        item = window[idx]
        if item.get("type") != "conversation":
            continue
        agent = str(item.get("agentId") or "").lower()
        if agent != "user":
            continue
        text = _strip_transport_noise(item.get("content") or item.get("summary") or item.get("raw") or "")
        if text:
            return text, idx
    return "", -1


def _latest_assistant_text_before(window: list[dict], idx: int) -> str:
    for j in range(min(idx - 1, len(window) - 1), -1, -1):
        item = window[j]
        if item.get("type") != "conversation":
            continue
        agent = str(item.get("agentId") or "").lower()
        if agent and agent != "assistant":
            continue
        text = _strip_transport_noise(item.get("content") or item.get("summary") or item.get("raw") or "")
        if text:
            return text
    return ""


def _dense_clause(text: str) -> str:
    clauses = [c.strip() for c in re.split(r"[.!?;\n]+", text) if c.strip()]
    if not clauses:
        return text

    def score(clause: str) -> tuple[int, int]:
        tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9'/_-]*", clause)
        dense = [t for t in tokens if t.lower() not in SUMMARY_DROP_WORDS]
        # Prefer information-dense clauses, then shorter for concision.
        return (len(set(dense)) * 2 + len(dense), -len(tokens))

    return max(clauses, key=score)


def _telegraphic_phrase(text: str, max_words: int = 14) -> str:
    tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9'/_-]*", text)
    if not tokens:
        return ""
    compact: list[str] = []
    drop_enabled = len(tokens) >= 8
    for token in tokens:
        if drop_enabled and token.lower() in SUMMARY_DROP_WORDS:
            continue
        compact.append(token)
        if len(compact) >= max_words:
            break
    if not compact:
        compact = tokens[:max_words]
    return " ".join(compact).strip()


def _strip_discourse_lead(text: str) -> str:
    candidate = (text or "").strip()
    if not candidate:
        return ""
    candidate = re.sub(
        r"(?i)^(?:let(?:'|’)s|please|can you|could you|would you|what(?:'s| is)?|how|why|ok(?:ay)?|hey|hi|i need to|we need to)\b[\s,:-]*",
        "",
        candidate,
    )
    return candidate.strip("`* ")


def _humanize_topic_name(text: str) -> str:
    raw = _strip_transport_noise(text)
    raw = _strip_discourse_lead(raw)
    raw = raw.replace("_", " ")
    raw = re.sub(r"\s+", " ", raw).strip("`* .,:;!?")
    if not raw:
        return ""
    tokens = [t for t in re.split(r"\s+", raw) if t]

    # Drop trailing run ids / hashes (e.g. "NIMBUS_AUTH_C5ED5D6C" -> "NIMBUS AUTH").
    while tokens and re.fullmatch(r"(?:[A-F0-9]{6,}|\d{6,})", tokens[-1]):
        tokens.pop()
    if not tokens:
        return ""

    acronyms = {
        "API",
        "CPU",
        "CSS",
        "DB",
        "DNS",
        "GPU",
        "HTML",
        "HTTP",
        "HTTPS",
        "ID",
        "JSON",
        "JWT",
        "LLM",
        "RAM",
        "SSE",
        "SQL",
        "SSH",
        "UI",
        "URL",
        "UX",
        "UUID",
        "WS",
    }
    pretty: list[str] = []
    for token in tokens[:6]:
        if re.fullmatch(r"[A-Z0-9-]{2,}", token):
            # Keep known acronyms, otherwise title-case plain ALLCAPS tokens.
            if token in acronyms:
                pretty.append(token)
            elif re.fullmatch(r"[A-Z]{2,}", token):
                pretty.append(token[:1] + token[1:].lower())
            else:
                pretty.append(token)
        elif re.search(r"[A-Z]", token[1:]):
            pretty.append(token)
        else:
            pretty.append(token.capitalize())
    return " ".join(pretty).strip()[:64]


def _focus_term_from_memory(memory_hits: list[dict]) -> str | None:
    counts: dict[str, int] = {}
    display: dict[str, str] = {}
    for hit in memory_hits[:10]:
        blob = " ".join(
            [
                str(hit.get("path") or ""),
                str(hit.get("snippet") or ""),
            ]
        )
        for token in re.findall(r"\b[A-Za-z][A-Za-z0-9_-]{2,}\b", blob):
            lower = token.lower()
            if lower in SUMMARY_DROP_WORDS or lower in TOPIC_FOCUS_STOPWORDS or lower in GENERIC_TOPIC_NAMES:
                continue
            if lower in {"openclaw", "clawboard", "memory", "snippet", "source", "line", "lines", "chunk"}:
                continue
            counts[lower] = counts.get(lower, 0) + 1
            if lower not in display:
                display[lower] = token
    if not counts:
        return None
    best = sorted(counts.items(), key=lambda item: (-item[1], -len(item[0]), item[0]))[0][0]
    return _humanize_topic_name(display.get(best, best))


def _is_low_signal_topic_name(name: str, window: list[dict]) -> bool:
    candidate = _humanize_topic_name(name)
    if not candidate:
        return True
    lower = candidate.lower()
    if lower in GENERIC_TOPIC_NAMES:
        return True
    if any(lower.startswith(prefix) for prefix in LOW_SIGNAL_TOPIC_PREFIXES):
        return True
    if candidate.endswith("?"):
        return True
    if len(candidate.split()) > 7:
        return True
    user_text, _ = _latest_user_text(window)
    source = _strip_transport_noise(_strip_slash_command(user_text) if user_text else _latest_conversation_text(window))
    return False


def _derive_focus_topic_name(window: list[dict], topic_cands: list[dict], memory_hits: list[dict] | None = None) -> str:
    memory_hits = memory_hits or []
    user_text, _idx = _latest_user_text(window)
    source = _strip_transport_noise(_strip_slash_command(user_text) if user_text else _latest_conversation_text(window))
    if source:
        phrase = re.search(
            r"\b(?:about|on|regarding|around|for)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_-]{2,}(?:\s+[A-Za-z][A-Za-z0-9_-]{2,}){0,2})\b",
            source,
            flags=re.IGNORECASE,
        )
        if phrase:
            words = [
                w
                for w in re.findall(r"[A-Za-z][A-Za-z0-9_-]{1,}", phrase.group(1))
                if w.lower() not in TOPIC_FOCUS_STOPWORDS and w.lower() not in SUMMARY_DROP_WORDS
            ]
            if words:
                return _humanize_topic_name(" ".join(words[:3]))
        caps = re.findall(r"\b[A-Z][A-Z0-9_-]{2,}\b", source)
        if caps:
            return caps[0][:48]
        proper = re.findall(r"\b[A-Z][a-z][A-Za-z0-9_-]{1,}\b", source)
        for token in proper:
            if token.lower() in TOPIC_FOCUS_STOPWORDS:
                continue
            return _humanize_topic_name(token)

    memory_focus = _focus_term_from_memory(memory_hits)
    if memory_focus:
        return memory_focus

    if topic_cands and float(topic_cands[0].get("score") or 0.0) >= 0.34 and topic_cands[0].get("name"):
        return _humanize_topic_name(str(topic_cands[0].get("name") or ""))

    concise = _concise_summary(source)
    words = [
        token
        for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9'/_-]*", concise)
        if token.lower() not in SUMMARY_DROP_WORDS and token.lower() not in TOPIC_FOCUS_STOPWORDS
    ]
    if words:
        return _humanize_topic_name(" ".join(words[:4]))
    return "General"


def _refine_topic_name(
    proposed_name: str | None,
    window: list[dict],
    topic_cands: list[dict],
    memory_hits: list[dict] | None = None,
) -> str:
    proposed = _humanize_topic_name(proposed_name or "")
    if not proposed or _is_low_signal_topic_name(proposed, window):
        proposed = _derive_focus_topic_name(window, topic_cands, memory_hits or [])
    return _humanize_topic_name(proposed) or "General"


def _concise_summary(text: str) -> str:
    clean = _strip_transport_noise(text)
    clean = re.sub(r"\s+", " ", clean)
    clean = clean.strip("`* ")
    clean = re.sub(r"(?i)\b(summary|message|content)\s*[:\-]\s*", "", clean).strip()
    if not clean:
        return ""

    dense = _dense_clause(clean)
    telegraphic = _telegraphic_phrase(dense)
    candidate = telegraphic if len(telegraphic) >= 8 else dense
    candidate = _strip_discourse_lead(candidate)
    candidate = re.sub(r"\s+", " ", candidate).strip("`* ")
    if not candidate:
        candidate = re.sub(r"\s+", " ", dense).strip("`* ")
    if len(candidate) <= SUMMARY_MAX:
        return candidate
    return f"{candidate[: SUMMARY_MAX - 1].rstrip()}…"


def _is_low_signal_summary(summary: str, source_text: str) -> bool:
    normalized_summary = _normalize_text(summary)
    if not normalized_summary:
        return True
    if any(normalized_summary.startswith(prefix) for prefix in LOW_SIGNAL_SUMMARY_PREFIXES):
        return True
    normalized_source = _normalize_text(source_text)
    if normalized_source and normalized_source.startswith(normalized_summary) and len(normalized_summary.split()) <= 5:
        return True
    return False


def _looks_actionable(text: str) -> bool:
    t = _strip_transport_noise(text)
    t = _strip_slash_command(t)
    if not t:
        return False
    if _is_system_artifact_text(t):
        return False
    lower = t.lower()
    strong_intent = any(cue in lower for cue in TASK_INTENT_CUES)
    if any(cue in lower for cue in INFORMATIONAL_REQUEST_CUES) and not strong_intent:
        return False
    if "?" in lower and not strong_intent:
        return False
    return strong_intent


def _latest_conversation_text(window: list[dict]) -> str:
    for item in reversed(window):
        if item.get("type") != "conversation":
            continue
        text = _strip_transport_noise(item.get("content") or item.get("summary") or item.get("raw") or "")
        if text:
            return text
    return ""


def _derive_topic_name(window: list[dict]) -> str:
    user_text, _idx = _latest_user_text(window)
    if user_text:
        user_text = _strip_slash_command(user_text)
    text = user_text or _latest_conversation_text(window)
    if not text:
        return "General"
    text = _strip_transport_noise(text)
    if _is_command_text(text) or _is_system_artifact_text(text):
        return "General"

    # Prefer explicit user-provided labels like "GraphQL caching: ..." when present.
    # This is a strong signal of the intended durable topic name.
    prefix = re.match(r"^\s*([A-Za-z][A-Za-z0-9][A-Za-z0-9 _/-]{1,48})\s*:\s*", text)
    if prefix:
        label = prefix.group(1).strip("`'\".,:;!?")
        lower = label.lower()
        if lower and lower not in TOPIC_FOCUS_STOPWORDS and lower not in GENERIC_TOPIC_NAMES:
            pretty = _humanize_topic_name(label)
            if pretty:
                return pretty[:64]

    focus = re.search(
        r"\b(?:about|on|regarding)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_-]{2,})\b",
        text,
        flags=re.IGNORECASE,
    )
    if focus:
        candidate = focus.group(1).strip("`'\".,:;!?")
        if candidate and candidate.lower() not in TOPIC_FOCUS_STOPWORDS:
            if candidate.isupper():
                return candidate[:48]
            return _humanize_topic_name(candidate)[:64] or candidate[:48].title()
    # Favor all-caps tokens like THOMAS when present.
    caps = re.findall(r"\b[A-Z][A-Z0-9_-]{2,}\b", text)
    if caps:
        return caps[0][:48]
    concise = _concise_summary(text)
    words = [w for w in re.split(r"\s+", concise) if w]
    if not words:
        return "General"
    return " ".join(words[:4])[:64]


def _derive_task_title(window: list[dict]) -> str | None:
    user_text, idx = _latest_user_text(window)
    base_text = _strip_slash_command(user_text) if user_text else ""
    if base_text and _is_affirmation(base_text):
        assistant_text = _latest_assistant_text_before(window, idx)
        base_text = assistant_text or base_text
    if not base_text:
        base_text = _latest_conversation_text(window)
    if not base_text or _is_command_text(base_text) or _is_system_artifact_text(base_text):
        return None
    if not _looks_actionable(base_text):
        return None
    title = _concise_summary(base_text)
    if len(title) < 8:
        return None
    return title[:120]


def _window_has_task_intent(window: list[dict], fallback_text: str | None = None) -> bool:
    if _derive_task_title(window):
        return True
    if fallback_text and _looks_actionable(fallback_text):
        return True
    return False


def _latest_classified_task_for_topic(ctx_logs: list[dict], topic_id: str) -> str | None:
    for item in reversed(ctx_logs):
        if (item.get("classificationStatus") or "pending") != "classified":
            continue
        if item.get("topicId") != topic_id:
            continue
        tid = item.get("taskId")
        if tid:
            return tid
    return None


def _has_topic_intent(window: list[dict], text: str) -> bool:
    user_text, _ = _latest_user_text(window)
    candidate = _strip_slash_command(user_text) if user_text else text
    candidate = _strip_transport_noise(candidate)
    if not candidate:
        return False
    lower = candidate.lower()
    if any(cue in lower for cue in TOPIC_INTENT_CUES):
        return True
    if re.search(r"\b(?:about|on|regarding|around|for)\s+[A-Za-z][A-Za-z0-9_-]{2,}\b", candidate, flags=re.IGNORECASE):
        return True
    if re.search(r"\b[A-Z][A-Za-z0-9_-]{2,}\b", candidate):
        return True
    tokens = [
        t
        for t in re.findall(r"[A-Za-z0-9][A-Za-z0-9'/_-]*", lower)
        if t not in SUMMARY_DROP_WORDS
    ]
    return len(tokens) >= 3 and len(lower) >= 24


def _is_small_talk_bundle(window: list[dict], text: str) -> bool:
    blob = _normalize_text(text)
    if not blob:
        return False
    # Never treat explicit work requests as small talk.
    if any(cue in blob for cue in TASK_INTENT_CUES):
        return False
    # Small talk requires at least one explicit cue.
    return any(cue in blob for cue in SMALL_TALK_CUES)


def _topic_creation_allowed(
    window: list[dict],
    derived_name: str,
    topic_cands: list[dict],
    text: str,
    topics: list[dict],
) -> bool:
    if not derived_name:
        return False
    if _is_command_text(derived_name):
        return False
    if derived_name.strip().lower() in GENERIC_TOPIC_NAMES:
        return False
    if _is_system_artifact_text(text):
        return False
    if topic_cands and float(topic_cands[0].get("score") or 0.0) >= max(0.48, TOPIC_SIM_THRESHOLD - 0.12):
        return False
    if topics and not _has_topic_intent(window, text):
        return False
    return True


def _task_creation_allowed(
    window: list[dict],
    task_title: str | None,
    task_cands: list[dict],
) -> bool:
    if not task_title:
        return False
    if task_title.strip().lower() in GENERIC_TASK_TITLES:
        return False
    user_text, idx = _latest_user_text(window)
    user_text = _strip_slash_command(user_text or "")
    if not user_text:
        return False
    if _is_system_artifact_text(user_text) or _is_command_text(user_text):
        return False
    if _is_affirmation(user_text):
        assistant_text = _latest_assistant_text_before(window, idx)
        if not assistant_text or not _looks_actionable(assistant_text):
            return False
    else:
        if not _looks_actionable(user_text):
            return False
    if task_cands and float(task_cands[0].get("score") or 0.0) >= max(0.5, TASK_SIM_THRESHOLD - 0.1):
        return False
    return True


def acquire_lock():
    """Single-flight lock with stale-lock recovery."""
    try:
        st = os.stat(LOCK_PATH)
        age = time.time() - st.st_mtime
        if age > max(60, INTERVAL * 3):
            try:
                os.unlink(LOCK_PATH)
            except FileNotFoundError:
                pass
    except FileNotFoundError:
        pass

    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode("utf-8"))
        os.close(fd)
        return True
    except FileExistsError:
        return False


def release_lock():
    try:
        os.unlink(LOCK_PATH)
    except FileNotFoundError:
        pass


def _drain_reindex_queue():
    queue_path = REINDEX_QUEUE_PATH
    if not queue_path:
        return []
    processing_path = f"{queue_path}.processing.{os.getpid()}"
    try:
        os.replace(queue_path, processing_path)
    except FileNotFoundError:
        return []
    except Exception as exc:
        print(f"classifier: failed to open reindex queue: {exc}")
        return []

    requests_out = []
    try:
        with open(processing_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    requests_out.append(json.loads(line))
                except Exception:
                    continue
    finally:
        try:
            os.unlink(processing_path)
        except Exception:
            pass
    return requests_out


def process_reindex_queue():
    pending = _drain_reindex_queue()
    if not pending:
        return

    # Keep the latest request per target.
    latest: dict[tuple[str, str, str], dict] = {}
    for item in pending:
        op = str(item.get("op") or "upsert").strip().lower()
        kind = str(item.get("kind") or "").strip().lower()
        item_id = str(item.get("id") or "").strip()
        topic_id = str(item.get("topicId") or "").strip()
        if op not in ("upsert", "delete"):
            continue
        if not kind or not item_id:
            continue
        latest[(op, kind, item_id)] = {"op": op, "kind": kind, "id": item_id, "topicId": topic_id, **item}

    for (_op, kind, item_id), item in latest.items():
        op = str(item.get("op") or "upsert")
        topic_id = str(item.get("topicId") or "").strip()
        try:
            if op == "delete":
                if kind == "topic":
                    embed_delete("topic", item_id)
                elif kind == "task":
                    if topic_id:
                        embed_delete(f"task:{topic_id}", item_id)
                    else:
                        delete_task_other_namespaces(item_id, keep_kind=None)
                elif kind == "log":
                    embed_delete("log", item_id)
                continue

            text = str(item.get("text") or "").strip()
            if not text:
                continue
            vec = embed_text(text)
            if vec is None:
                continue

            if kind == "topic":
                embed_upsert("topic", item_id, vec)
            elif kind == "task":
                namespace = f"task:{topic_id or 'unassigned'}"
                embed_upsert(namespace, item_id, vec)
                delete_task_other_namespaces(item_id, keep_kind=namespace)
            elif kind == "log":
                embed_upsert("log", item_id, vec)
        except Exception as exc:
            print(f"classifier: reindex {op} failed for {kind}:{item_id}: {exc}")


def _rotate_audit_file(path: str, *, max_bytes: int, max_files: int) -> None:
    """Best-effort size-based rotation for JSONL audit logs.

    Rotation is intentionally simple (no compression) and safe under failures.
    """

    if not path:
        return
    if max_bytes <= 0 or max_files <= 0:
        return
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return
    except Exception:
        return
    if st.st_size < max_bytes:
        return
    try:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    except Exception:
        ts = str(int(time.time()))
    rotated = f"{path}.{ts}"
    try:
        os.replace(path, rotated)
    except Exception:
        return
    try:
        dir_name = os.path.dirname(path) or "."
        base = os.path.basename(path)
        siblings = [name for name in os.listdir(dir_name) if name.startswith(base + ".")]
        siblings.sort(reverse=True)
        for name in siblings[max_files:]:
            try:
                os.unlink(os.path.join(dir_name, name))
            except Exception:
                pass
    except Exception:
        pass


def _record_creation_gate(kind: str, decision: str, proposed: str | None, selected_id: str | None = None):
    if not CREATION_AUDIT_PATH:
        return
    try:
        ts = datetime.now(timezone.utc).isoformat()
    except Exception:
        ts = str(time.time())
    payload = {
        "ts": ts,
        "kind": kind,
        "decision": decision,
        "proposed": proposed,
        "selectedId": selected_id,
    }
    try:
        os.makedirs(os.path.dirname(CREATION_AUDIT_PATH), exist_ok=True)
        _rotate_audit_file(
            CREATION_AUDIT_PATH,
            max_bytes=int(CREATION_AUDIT_MAX_BYTES),
            max_files=int(CREATION_AUDIT_MAX_FILES),
        )
        with open(CREATION_AUDIT_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload) + "\n")
    except Exception:
        pass


def _record_classifier_audit(payload: dict) -> None:
    if not CLASSIFIER_AUDIT_PATH:
        return
    out = dict(payload or {})
    if "ts" not in out:
        try:
            out["ts"] = datetime.now(timezone.utc).isoformat()
        except Exception:
            out["ts"] = str(time.time())
    try:
        dir_name = os.path.dirname(CLASSIFIER_AUDIT_PATH)
        if dir_name:
            os.makedirs(dir_name, exist_ok=True)
        _rotate_audit_file(
            CLASSIFIER_AUDIT_PATH,
            max_bytes=int(CLASSIFIER_AUDIT_MAX_BYTES),
            max_files=int(CLASSIFIER_AUDIT_MAX_FILES),
        )
        with open(CLASSIFIER_AUDIT_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(out) + "\n")
    except Exception:
        pass


def list_logs(params: dict):
    r = requests.get(
        f"{CLAWBOARD_API_BASE}/api/log",
        params=params,
        headers=headers_clawboard(),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def list_pending_conversations(limit=500, offset=0):
    # Only classify user/assistant conversations from real message threads.
    # Skip classifier/agent internal convo-like logs that can be present.
    r = requests.get(
        f"{CLAWBOARD_API_BASE}/api/classifier/pending",
        params={
            "limit": limit,
            "offset": offset,
        },
        headers=headers_clawboard(),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def get_session_routing_memory(session_key: str) -> dict | None:
    if not SESSION_ROUTING_ENABLED:
        return None
    if not requests or not CLAWBOARD_TOKEN:
        return None
    sk = (session_key or "").strip()
    if not sk:
        return None
    try:
        r = requests.get(
            f"{CLAWBOARD_API_BASE}/api/classifier/session-routing",
            params={"sessionKey": sk},
            headers=headers_clawboard(),
            timeout=4,
        )
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict):
            return None
        items = data.get("items")
        if not isinstance(items, list) or not items:
            return None
        return data
    except Exception:
        return None


def append_session_routing_memory(
    session_key: str,
    *,
    topic_id: str,
    topic_name: str | None,
    task_id: str | None,
    task_title: str | None,
    anchor: str | None,
    ts: str | None = None,
) -> None:
    if not SESSION_ROUTING_ENABLED:
        return
    if not requests or not CLAWBOARD_TOKEN:
        return
    sk = (session_key or "").strip()
    tid = (topic_id or "").strip()
    if not sk or not tid:
        return
    payload: dict = {
        "sessionKey": sk,
        "topicId": tid,
        "topicName": (str(topic_name).strip() if topic_name else None),
        "taskId": (str(task_id).strip() if task_id else None),
        "taskTitle": (str(task_title).strip() if task_title else None),
        "anchor": (str(anchor).strip() if anchor else None),
        "ts": ts,
    }
    try:
        requests.post(
            f"{CLAWBOARD_API_BASE}/api/classifier/session-routing",
            headers=headers_clawboard(),
            data=json.dumps(payload),
            timeout=4,
        )
    except Exception:
        return


def list_logs_by_session(session_key: str, limit: int = 200, offset: int = 0, classificationStatus: str | None = None):
    params = {"sessionKey": session_key, "limit": limit, "offset": offset}
    if classificationStatus:
        params["classificationStatus"] = classificationStatus
    return list_logs(params)


def list_logs_by_topic(topic_id: str, limit: int = 50, offset: int = 0):
    return list_logs({"topicId": topic_id, "limit": limit, "offset": offset})


def list_logs_by_task(task_id: str, limit: int = 50, offset: int = 0):
    return list_logs({"taskId": task_id, "limit": limit, "offset": offset})


def list_notes_by_related_ids(related_ids: list[str], limit: int = 200):
    if not related_ids:
        return []
    joined = ",".join(related_ids)
    return list_logs({"type": "note", "relatedLogId": joined, "limit": limit, "offset": 0})


def list_topics():
    r = requests.get(f"{CLAWBOARD_API_BASE}/api/topics", headers=headers_clawboard(), timeout=15)
    r.raise_for_status()
    return r.json()


def list_tasks(topic_id: str):
    r = requests.get(
        f"{CLAWBOARD_API_BASE}/api/tasks",
        params={"topicId": topic_id},
        headers=headers_clawboard(),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def _clip_text(value: str, limit: int = 1400) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _indexable_tags(tags: object) -> list[str]:
    """Filter tag values that should influence embeddings/lexical retrieval."""
    if not isinstance(tags, list):
        return []
    out: list[str] = []
    for t in tags:
        s = str(t).strip()
        if not s:
            continue
        if s.lower().startswith("system:"):
            continue
        out.append(s)
    return out


def _topic_index_text(topic: dict) -> str:
    name = str(topic.get("name") or "").strip()
    description = str(topic.get("description") or "").strip()
    tag_text = " ".join(_indexable_tags(topic.get("tags")))
    parts = [name, description, tag_text]
    return _clip_text(" ".join([p for p in parts if p]).strip(), 1400)


def _task_index_text(task: dict) -> str:
    title = str(task.get("title") or "").strip()
    status = str(task.get("status") or "").strip()
    tag_text = " ".join(_indexable_tags(task.get("tags")))
    parts = [title, status, tag_text]
    return _clip_text(" ".join([p for p in parts if p]).strip(), 1400)


def upsert_topic(topic_id: str | None, name: str, *, tags: list[str] | None = None, status: str | None = None):
    payload: dict = {"name": name}
    if topic_id:
        payload["id"] = topic_id
    if tags is not None:
        payload["tags"] = tags
    if status is not None:
        payload["status"] = status
    r = requests.post(
        f"{CLAWBOARD_API_BASE}/api/topics",
        headers=headers_clawboard("classifier" if not topic_id else None),
        data=json.dumps(payload),
        timeout=15,
    )
    r.raise_for_status()
    topic = r.json()
    try:
        text = _topic_index_text(topic) or str(topic.get("id") or "")
        embed_upsert("topic", topic["id"], embed_text(text))
    except Exception:
        pass
    return topic


def _ensure_topic_indexed(topic: dict) -> None:
    """Best-effort embeddings upsert for an existing topic without mutating it via the API."""
    try:
        topic_id = str(topic.get("id") or "").strip()
        if not topic_id:
            return
        text = _topic_index_text(topic) or topic_id
        vec = embed_text(text)
        if vec is None:
            return
        embed_upsert("topic", topic_id, vec)
    except Exception:
        pass


def upsert_task(task_id: str | None, topic_id: str, title: str, status: str = "todo"):
    payload = {"topicId": topic_id, "title": title, "status": status}
    if task_id:
        payload["id"] = task_id
    r = requests.post(
        f"{CLAWBOARD_API_BASE}/api/tasks",
        headers=headers_clawboard(),
        data=json.dumps(payload),
        timeout=15,
    )
    r.raise_for_status()
    task = r.json()
    try:
        text = _task_index_text(task) or str(task.get("id") or "")
        embed_upsert(f"task:{task['topicId']}", task["id"], embed_text(text))
    except Exception:
        pass
    return task


def patch_log(log_id: str, patch: dict):
    r = requests.patch(
        f"{CLAWBOARD_API_BASE}/api/log/{log_id}",
        headers=headers_clawboard(),
        data=json.dumps(patch),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def ensure_topic_index_seeded():
    """Populate embeddings index for existing topics (best-effort)."""
    global _topic_index_seeded_at
    try:
        if "_topic_index_seeded_at" not in globals():
            _topic_index_seeded_at = 0.0  # type: ignore[assignment]
        seed_ttl = float(os.environ.get("CLASSIFIER_SEED_TTL_SECONDS", "600") or "600")
        now = time.time()
        if seed_ttl > 0 and (now - float(_topic_index_seeded_at)) < seed_ttl:  # type: ignore[arg-type]
            return
        for t in list_topics():
            if not t.get("id"):
                continue
            text = _topic_index_text(t) or str(t.get("id") or "")
            vec = embed_text(text)
            if vec is None:
                continue
            embed_upsert("topic", t["id"], vec)
        _topic_index_seeded_at = now  # type: ignore[assignment]
    except Exception:
        pass


def ensure_task_index_seeded(topic_id: str):
    global _task_index_seeded_at
    try:
        if "_task_index_seeded_at" not in globals():
            _task_index_seeded_at = {}  # type: ignore[assignment]
        seed_ttl = float(os.environ.get("CLASSIFIER_SEED_TTL_SECONDS", "600") or "600")
        now = time.time()
        last = float((_task_index_seeded_at or {}).get(topic_id, 0.0))  # type: ignore[union-attr]
        if seed_ttl > 0 and (now - last) < seed_ttl:
            return
        for t in list_tasks(topic_id):
            if not t.get("id"):
                continue
            text = _task_index_text(t) or str(t.get("id") or "")
            vec = embed_text(text)
            if vec is None:
                continue
            embed_upsert(f"task:{topic_id}", t["id"], vec)
        (_task_index_seeded_at or {})[topic_id] = now  # type: ignore[index,union-attr]
    except Exception:
        pass


def topic_candidates(query_text: str, k: int = 6):
    topics = [t for t in list_topics() if isinstance(t.get("name"), str)]
    if not topics:
        return []

    vector_scores: dict[str, float] = {}
    q = embed_text(query_text)
    if q is not None:
        for topic_id, score in embed_topk("topic", q, k=max(k * 4, 20)):
            vector_scores[topic_id] = max(vector_scores.get(topic_id, 0.0), max(0.0, float(score)))

    topic_text: dict[str, str] = {}
    lexical_scores: dict[str, float] = {}
    for topic in topics:
        tid = topic.get("id")
        name = topic.get("name") or ""
        description = topic.get("description") or ""
        tag_text = " ".join(_indexable_tags(topic.get("tags")))
        if not tid or not name:
            continue
        text = f"{name} {description} {tag_text}".strip()
        topic_text[tid] = text
        lexical_scores[tid] = _name_similarity(query_text, name)

    bm25_scores = _bm25_scores(query_text, topic_text)
    # Normalize BM25 relative to the best matching doc. We include zero-scores for
    # non-matching docs so a single lexical hit can still score as a strong anchor.
    bm25_norm: dict[str, float] = {}
    if bm25_scores:
        hi = max(float(v) for v in bm25_scores.values())
        if hi > 0:
            for doc_id in topic_text.keys():
                bm25_norm[doc_id] = float(bm25_scores.get(doc_id, 0.0)) / hi
    q_tokens = _token_set(query_text)
    q_norm = _normalize_text(query_text)

    out = []
    for topic in topics:
        tid = topic.get("id")
        name = topic.get("name") or ""
        description = topic.get("description") or ""
        status = topic.get("status") or "active"
        tags = topic.get("tags") or []
        if not tid or not name:
            continue
        vector = vector_scores.get(tid, 0.0)
        lexical = lexical_scores.get(tid, 0.0)
        bm25 = bm25_scores.get(tid, 0.0)
        bm25n = bm25_norm.get(tid, 0.0)

        cand_text = topic_text.get(tid, name)
        c_tokens = _token_set(cand_text)
        coverage = (len(q_tokens & c_tokens) / max(1, len(q_tokens))) if q_tokens else 0.0
        phrase = 1.0 if q_norm and q_norm in _normalize_text(cand_text) else 0.0

        # Score semantics:
        # - Use absolute embedding similarity + lexical BM25 as the core signal.
        # - Avoid rank-based fusion (RRF) as the primary score; on small corpora it can
        #   overstate confidence and cause false-positive reuse.
        topical = max(vector, bm25n)
        support = min(vector, bm25n)
        score = (topical * 0.62) + (support * 0.18) + (lexical * 0.12) + (coverage * 0.06) + (phrase * 0.02)
        # Archived topics should be "sticky off": allow selection only on strong evidence.
        # Use a subtractive penalty (not multiplicative) so a perfect match can still win.
        normalized_status = str(status or "").strip().lower()
        if normalized_status == "archived":
            score = max(0.0, score - 0.22)
        elif normalized_status == "paused":
            score = max(0.0, score - 0.08)
        out.append(
            {
                "id": tid,
                "name": name,
                "description": description,
                "status": status,
                "tags": tags if isinstance(tags, list) else [],
                "score": score,
                "vectorScore": vector,
                "bm25Score": bm25,
                "bm25Norm": bm25n,
                "coverageScore": coverage,
                "phraseScore": phrase,
                "lexicalScore": lexical,
            }
        )

    out.sort(key=lambda item: item.get("score", 0.0), reverse=True)
    return out[:k]


def task_candidates(topic_id: str, query_text: str, k: int = 8):
    ensure_task_index_seeded(topic_id)
    tasks = list_tasks(topic_id)
    if not tasks:
        return []

    vector_scores: dict[str, float] = {}
    q = embed_text(query_text)
    if q is not None:
        for task_id, score in embed_topk(f"task:{topic_id}", q, k=max(k * 4, 24)):
            vector_scores[task_id] = max(vector_scores.get(task_id, 0.0), max(0.0, float(score)))

    task_text: dict[str, str] = {}
    lexical_scores: dict[str, float] = {}
    for task in tasks:
        tid = task.get("id")
        title = task.get("title") or ""
        status = task.get("status") or "todo"
        tag_text = " ".join(_indexable_tags(task.get("tags")))
        if not tid or not title:
            continue
        text = f"{title} {status} {tag_text}".strip()
        task_text[tid] = text
        lexical_scores[tid] = _name_similarity(query_text, title)

    bm25_scores = _bm25_scores(query_text, task_text)
    bm25_norm: dict[str, float] = {}
    if bm25_scores:
        hi = max(float(v) for v in bm25_scores.values())
        if hi > 0:
            for doc_id in task_text.keys():
                bm25_norm[doc_id] = float(bm25_scores.get(doc_id, 0.0)) / hi
    q_tokens = _token_set(query_text)
    q_norm = _normalize_text(query_text)

    out = []
    for task in tasks:
        tid = task.get("id")
        title = task.get("title") or ""
        status = task.get("status") or "todo"
        tags = task.get("tags") or []
        if not tid or not title:
            continue
        lexical = lexical_scores.get(tid, 0.0)
        vector = vector_scores.get(tid, 0.0)
        bm25 = bm25_scores.get(tid, 0.0)
        bm25n = bm25_norm.get(tid, 0.0)

        cand_text = task_text.get(tid, title)
        c_tokens = _token_set(cand_text)
        coverage = (len(q_tokens & c_tokens) / max(1, len(q_tokens))) if q_tokens else 0.0
        phrase = 1.0 if q_norm and q_norm in _normalize_text(cand_text) else 0.0

        topical = max(vector, bm25n)
        support = min(vector, bm25n)
        score = (topical * 0.62) + (support * 0.18) + (lexical * 0.12) + (coverage * 0.06) + (phrase * 0.02)
        # Completed tasks should require stronger intent to be selected.
        if str(status or "").strip().lower() == "done":
            score = max(0.0, score - 0.12)
        out.append(
            {
                "id": tid,
                "title": title,
                "status": status,
                "tags": tags if isinstance(tags, list) else [],
                "score": score,
                "vectorScore": vector,
                "bm25Score": bm25,
                "bm25Norm": bm25n,
                "coverageScore": coverage,
                "phraseScore": phrase,
                "lexicalScore": lexical,
            }
        )

    out.sort(key=lambda item: item.get("score", 0.0), reverse=True)
    return out[:k]


def build_notes_index(logs: list[dict]):
    log_ids = [e.get("id") for e in logs if e.get("id")]
    notes = list_notes_by_related_ids(log_ids, limit=300)
    index: dict[str, list[str]] = {}
    for n in notes:
        rid = n.get("relatedLogId")
        if not rid:
            continue
        text = (n.get("content") or n.get("summary") or "").strip()
        if not text:
            continue
        index.setdefault(rid, []).append(text[:600])
    return index


def summarize_logs(logs: list[dict], notes_index: dict[str, list[str]] | None = None, limit: int = 6):
    notes_index = notes_index or {}
    out = []
    for e in logs:
        if not _is_context_log(e):
            continue
        entry = {
            "id": e.get("id"),
            "createdAt": e.get("createdAt"),
            "type": e.get("type"),
            "summary": _concise_summary(e.get("summary") or e.get("content") or ""),
            "content": _strip_transport_noise(e.get("content") or "")[:400],
            "agentLabel": e.get("agentLabel") or e.get("agentId"),
        }
        notes = notes_index.get(e.get("id") or "", [])
        if notes:
            entry["notes"] = notes[:3]
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def _recent_context_profile_text(recent: list[dict]) -> str:
    """Build a compact text profile from recent summarized logs for late-interaction scoring."""
    parts: list[str] = []
    for e in recent or []:
        if not isinstance(e, dict):
            continue
        summary = str(e.get("summary") or "").strip()
        content = str(e.get("content") or "").strip()
        if summary:
            parts.append(summary)
        elif content:
            parts.append(content)
        notes = e.get("notes")
        if isinstance(notes, list):
            for n in notes[:1]:
                if isinstance(n, str) and n.strip():
                    parts.append(n.strip())
        if len(parts) >= 12:
            break
    return _clip_text(" \n".join([p for p in parts if p]).strip(), 1400)


def _attach_profile_scores(candidates: list[dict], contexts: dict[str, list[dict]], query_text: str) -> None:
    if not candidates or not contexts:
        return
    q = str(query_text or "").strip()
    if not q:
        return
    for cand in candidates:
        cid = str(cand.get("id") or "").strip()
        if not cid:
            continue
        recent = contexts.get(cid)
        if not recent:
            continue
        profile_text = _recent_context_profile_text(recent)
        if not profile_text:
            continue
        try:
            cand["profileScore"] = float(_late_interaction_score(q, profile_text))
        except Exception:
            continue


def window_text(window: list[dict], notes_index: dict[str, list[str]] | None = None) -> str:
    parts = []
    notes_index = notes_index or {}
    for e in window:
        who = e.get("agentLabel") or e.get("agentId") or "?"
        text = _strip_transport_noise(e.get("content") or e.get("summary") or "")
        if not text:
            continue
        line = f"{who}: {text}"
        notes = notes_index.get(e.get("id") or "", [])
        if notes:
            line += " | Notes: " + " ; ".join(notes[:3])
        parts.append(line)
    return "\n".join(parts)[-6000:]


def user_window_text(window: list[dict], notes_index: dict[str, list[str]] | None = None) -> str:
    """User-only retrieval text for stable topic/task candidate selection.

    Including assistant replies in the retrieval query can skew candidate selection
    toward broad disclaimers (auth/security/etc) instead of the user's intent.
    """

    parts: list[str] = []
    notes_index = notes_index or {}
    for e in window:
        if _conversation_agent(e) != "user":
            continue
        text = _strip_transport_noise(e.get("content") or e.get("summary") or "")
        if not text:
            continue
        line = text
        notes = notes_index.get(e.get("id") or "", [])
        if notes:
            line += " | Notes: " + " ; ".join(notes[:3])
        parts.append(line)
    return "\n".join(parts)[-6000:]


def call_classifier(
    window: list[dict],
    pending_ids: list[str],
    candidate_topics: list[dict],
    candidate_tasks: list[dict],
    notes_index: dict[str, list[str]],
    topic_contexts: dict[str, list[dict]],
    task_contexts: dict[str, list[dict]],
    memory_hits: list[dict],
    continuity: dict | None = None,
):
    def build_prompt(compact: bool):
        content_limit = 360 if compact else 800
        recent_limit = 3 if compact else 6
        memory_limit = 3 if compact else len(memory_hits)
        output_template = {
            "topic": {"id": None, "name": "", "create": False},
            "task": None,
            "summaries": [{"id": sid, "summary": ""} for sid in pending_ids if isinstance(sid, str) and sid],
        }
        return {
            "window": [
                {
                    "id": e.get("id"),
                    "createdAt": e.get("createdAt"),
                    "agentLabel": e.get("agentLabel"),
                    "summary": _concise_summary(e.get("summary") or e.get("content") or ""),
                    "content": _strip_transport_noise(e.get("content") or "")[:content_limit],
                    "notes": notes_index.get(e.get("id") or "", [])[:2 if compact else 3],
                }
                for e in window
            ],
            "candidateTopics": [
                {
                    **t,
                    "recent": topic_contexts.get(t.get("id") or "", [])[:recent_limit],
                }
                for t in candidate_topics
            ],
            "candidateTasks": [
                {
                    **t,
                    "recent": task_contexts.get(t.get("id") or "", [])[:recent_limit],
                }
                for t in candidate_tasks
            ],
            "memory": memory_hits[:memory_limit],
            "continuity": continuity,
            "pendingIds": pending_ids,
            "outputTemplate": output_template,
		            "instructions": (
		                "Return STRICT JSON only (no markdown, no code fences, no leading/trailing text). "
		                "Output MUST be a single JSON object that matches outputTemplate EXACTLY: "
		                "same keys, same nesting, no extra keys. Replace placeholder values with real values. "
		                "Context: pendingIds correspond to ONE coherent request/response bundle. "
		                "Anchor on the earliest meaningful user intent within that bundle; "
		                "if the earliest user turn is only an affirmation ('yes', 'ok', 'do it'), "
		                "anchor on the immediately preceding assistant plan in window. "
		                "Rules: (1) Topic is MANDATORY. Always return a meaningful topic name, never generic placeholders. "
		                "(2) Prefer an existing topic ONLY when it clearly matches the bundle's anchor intent + recent context. "
		                "Candidates may include profileScore (0..1) which measures similarity between this bundle and the candidate's recent context; "
		                "treat a very low profileScore as evidence AGAINST reusing that candidate. "
		                "If continuity.isAmbiguousBundle is true, strongly prefer continuity.suggested unless the user clearly introduces a new intent. "
		                "Do NOT pick an existing topic just because it exists or is the only candidate. "
		                "(3) If no existing topic clearly fits, set topic.id=null and topic.create=true and propose a durable topic.name. "
		                "(4) Topic names must be 1-5 words, noun-centric, human-readable; "
		                "avoid generic names and avoid copying the first words of the user prompt. "
		                "(5) Task is OPTIONAL. Only return/create a task when execution intent is explicit "
                "(build/fix/implement/ship/next step) or the user confirms an assistant action plan. "
                "(6) For recall/explanation/brainstorming/status chat, set task=null. "
                "(7) If task intent exists, prefer an existing matching task before creating. "
                "(8) Summaries are REQUIRED for every id in pendingIds (no omissions, one per id). "
                "(9) Each summary: <=56 chars, 4-10 words, telegraphic style; sacrifice grammar for brevity. "
                "(10) Semantic rewrite: do not copy the first sentence verbatim. "
                "(11) Never prefix with 'SUMMARY:' and never include transport metadata. "
                "(12) Do NOT create topics from system/tool/memory artifacts or slash commands like /new. "
                "(13) If unsure on task, set task=null."
            ),
        }

    for compact in (False, True):
        prompt = build_prompt(compact)
        body = {
            "model": OPENCLAW_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a high-precision classifier for an ops dashboard. "
                        "Return ONLY a single JSON object matching the provided outputTemplate. "
                        "Do not output markdown, code fences, comments, or any explanation."
                    ),
                },
                {"role": "user", "content": json.dumps(prompt)},
            ],
            "temperature": 0.1,
            "max_tokens": 420 if compact else 600,
        }
        try:
            r = requests.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=oc_headers_with_session(_openclaw_internal_session_key("classifier")),
                data=json.dumps(body),
                timeout=20 if compact else 30,
            )
            r.raise_for_status()
            data = r.json()
            text = data["choices"][0]["message"]["content"]
            try:
                parsed = _parse_strict_json(text)
                return _validate_classifier_result(parsed, pending_ids)
            except _StrictJsonError as exc:
                # One deterministic retry: ask the model to regenerate strict JSON from the same input.
                repair_body = {
                    "model": OPENCLAW_MODEL,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You repair/normalize classifier outputs. "
                                "Return ONLY a single JSON object matching outputTemplate exactly. "
                                "No markdown, no code fences, no extra text."
                            ),
                        },
                        {
                            "role": "user",
                            "content": json.dumps(
                                {
                                    "input": prompt,
                                    "invalidOutput": text,
                                    "validationError": str(exc),
                                    "instructions": "Return ONLY the JSON object matching input.outputTemplate.",
                                }
                            ),
                        },
                    ],
                    "temperature": 0,
                    "max_tokens": 520 if compact else 720,
                }
                rr = requests.post(
                    f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                    headers=oc_headers_with_session(_openclaw_internal_session_key("classifier-repair")),
                    data=json.dumps(repair_body),
                    timeout=18 if compact else 26,
                )
                rr.raise_for_status()
                repaired_text = rr.json()["choices"][0]["message"]["content"]
                repaired = _parse_strict_json(repaired_text)
                return _validate_classifier_result(repaired, pending_ids)
        except requests.exceptions.ReadTimeout:
            if compact:
                raise
            continue


def call_creation_gate(
    window: list[dict],
    candidate_topics: list[dict],
    candidate_tasks: list[dict],
    proposed_topic: str | None,
    proposed_task: str | None,
):
    if not proposed_topic and not proposed_task:
        return {"createTopic": False, "createTask": False, "topicId": None, "taskId": None}

    recent = []
    for entry in window[-8:]:
        if entry.get("type") != "conversation":
            continue
        text = _strip_transport_noise(entry.get("content") or entry.get("summary") or "")
        if not text:
            continue
        recent.append(
            {
                "agentLabel": entry.get("agentLabel") or entry.get("agentId"),
                "content": text[:260],
            }
        )
        if len(recent) >= 6:
            break

    def compact_rows(rows: list[dict], key: str) -> list[dict]:
        out = []
        for item in rows[:8]:
            label = item.get(key) or ""
            out.append(
                {
                    "id": item.get("id"),
                    key: label,
                    "score": round(float(item.get("score") or 0.0), 4),
                }
            )
        return out

    payload = {
        "recent": recent,
        "proposed": {
            "topic": proposed_topic,
            "task": proposed_task,
        },
        "candidateTopics": compact_rows(candidate_topics, "name"),
        "candidateTasks": compact_rows(candidate_tasks, "title"),
        "outputTemplate": {"createTopic": False, "topicId": None, "createTask": False, "taskId": None},
        "instructions": (
            "Return STRICT JSON only (no markdown, no code fences). "
            "Output MUST be a single JSON object that matches outputTemplate EXACTLY: "
            "same keys, no extra keys. Replace placeholder values with real values. "
            "Rules: (1) Topic creation is allowed when no candidate is a close fit and the conversation has a stable human theme/entity. "
            "(2) Task creation is stricter: allow only when execution intent is explicit or user confirmed an assistant action plan. "
            "(3) If an existing candidate is a close fit, set create=false and provide its id. "
            "(4) Never create from system/tool/memory artifacts or slash commands like /new. "
            "(5) If uncertain for task, set createTask=false."
        ),
    }

    body = {
        "model": OPENCLAW_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a cautious gatekeeper for topic/task creation. "
                    "Return ONLY a single JSON object matching outputTemplate. "
                    "No markdown, no code fences, no explanation."
                ),
            },
            {"role": "user", "content": json.dumps(payload)},
        ],
        "temperature": 0,
        "max_tokens": 180,
    }
    r = requests.post(
        f"{OPENCLAW_BASE_URL}/v1/chat/completions",
        headers=oc_headers_with_session(_openclaw_internal_session_key("creation-gate")),
        data=json.dumps(body),
        timeout=16,
    )
    r.raise_for_status()
    text = r.json()["choices"][0]["message"]["content"]
    try:
        parsed = _parse_strict_json(text)
        return _validate_creation_gate_result(parsed)
    except _StrictJsonError as exc:
        repair_body = {
            "model": OPENCLAW_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You repair/normalize gatekeeper outputs. "
                        "Return ONLY a single JSON object matching outputTemplate exactly. "
                        "No markdown, no code fences, no extra text."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "input": payload,
                            "invalidOutput": text,
                            "validationError": str(exc),
                            "instructions": "Return ONLY the JSON object matching input.outputTemplate.",
                        }
                    ),
                },
            ],
            "temperature": 0,
            "max_tokens": 220,
        }
        rr = requests.post(
            f"{OPENCLAW_BASE_URL}/v1/chat/completions",
            headers=oc_headers_with_session(_openclaw_internal_session_key("creation-gate-repair")),
            data=json.dumps(repair_body),
            timeout=14,
        )
        rr.raise_for_status()
        repaired_text = rr.json()["choices"][0]["message"]["content"]
        repaired = _parse_strict_json(repaired_text)
        return _validate_creation_gate_result(repaired)


def call_summary_repair(
    window: list[dict],
    pending_ids: list[str],
    notes_index: dict[str, list[str]],
):
    if not pending_ids:
        return {}

    pending_set = {sid for sid in pending_ids if isinstance(sid, str) and sid}
    if not pending_set:
        return {}

    best: dict[str, str] = {}
    for compact in (False, True):
        content_limit = 320 if compact else 520
        output_template = {
            "summaries": [{"id": sid, "summary": ""} for sid in pending_set],
        }
        prompt = {
            "window": [
                {
                    "id": e.get("id"),
                    "agentLabel": e.get("agentLabel") or e.get("agentId"),
                    "content": _strip_transport_noise(e.get("content") or e.get("summary") or "")[:content_limit],
                    "notes": notes_index.get(e.get("id") or "", [])[:2],
                }
                for e in window
                if e.get("id") in pending_set
            ],
            "pendingIds": list(pending_set),
            "outputTemplate": output_template,
            "instructions": (
                "Return STRICT JSON only (no markdown, no code fences). "
                "Output MUST be a single JSON object that matches outputTemplate EXACTLY: "
                "same keys, no extra keys. Replace placeholder values with real values. "
                "Rules: include every id in pendingIds exactly once; "
                "summary <=56 chars; 4-10 words; telegraphic style; "
                "sacrifice grammar for concision; semantic rewrite, not first sentence copy; "
                "no 'SUMMARY:' prefix; no transport metadata."
            ),
        }
        body = {
            "model": OPENCLAW_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a terse summarizer for dashboard message chips. "
                        "Return ONLY a single JSON object matching outputTemplate. "
                        "No markdown, no code fences, no explanation."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(prompt),
                },
            ],
            "temperature": 0,
            "max_tokens": 260 if compact else 360,
        }
        try:
            response = requests.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=oc_headers_with_session(_openclaw_internal_session_key("summary-repair")),
                data=json.dumps(body),
                timeout=15 if compact else 22,
            )
            response.raise_for_status()
            raw = response.json()["choices"][0]["message"]["content"]
            try:
                parsed = _parse_strict_json(raw)
                out = _validate_summary_repair_result(parsed, list(pending_set))
            except _StrictJsonError as exc:
                repair_body = {
                    "model": OPENCLAW_MODEL,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You repair/normalize summarizer outputs. "
                                "Return ONLY a single JSON object matching outputTemplate exactly. "
                                "No markdown, no code fences, no extra text."
                            ),
                        },
                        {
                            "role": "user",
                            "content": json.dumps(
                                {
                                    "input": prompt,
                                    "outputTemplate": output_template,
                                    "invalidOutput": raw,
                                    "validationError": str(exc),
                                    "instructions": "Return ONLY the JSON object matching outputTemplate.",
                                }
                            ),
                        },
                    ],
                    "temperature": 0,
                    "max_tokens": 320,
                }
                rr = requests.post(
                    f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                    headers=oc_headers_with_session(_openclaw_internal_session_key("summary-repair-repair")),
                    data=json.dumps(repair_body),
                    timeout=14 if compact else 18,
                )
                rr.raise_for_status()
                repaired_text = rr.json()["choices"][0]["message"]["content"]
                repaired = _parse_strict_json(repaired_text)
                out = _validate_summary_repair_result(repaired, list(pending_set))
            if len(out) > len(best):
                best = out
            if len(best) == len(pending_set):
                return best
        except Exception:
            continue

    return best


def classify_without_llm(
    window: list[dict],
    ctx_logs: list[dict],
    topic_cands: list[dict],
    text: str,
    *,
    prefer_continuity: bool = False,
):
    topics = list_topics()
    topics_by_id = {t.get("id"): t for t in topics if t.get("id")}

    chosen_topic_id = None
    chosen_topic_name = None
    create_topic = False

    last_topic_id = None
    last_topic_name = None
    for item in reversed(ctx_logs):
        if (item.get("classificationStatus") or "pending") != "classified":
            continue
        tid = item.get("topicId")
        if tid and tid in topics_by_id:
            last_topic_id = tid
            last_topic_name = topics_by_id[tid].get("name")
            break

    # Follow-up user turns (no assistant response yet) are often continuations of the
    # previous bundle; prefer continuity in those cases to avoid fragmenting topics.
    if prefer_continuity and last_topic_id:
        chosen_topic_id = last_topic_id
        chosen_topic_name = last_topic_name
    else:
        # 1) Prefer a strong current-bundle candidate. This prevents "topic lock-in" where
        # a previously-classified topic in the same session forces unrelated later bundles
        # into the same topic (multi-bundle sessions should be able to switch topics).
        if topic_cands:
            top = topic_cands[0]
            if float(top.get("score") or 0.0) >= 0.52:
                # Require at least one additional anchor beyond "broad semantic similarity"
                # to avoid false-positive topic reuse under busy, multi-thread sessions.
                lexical = float(top.get("lexicalScore") or 0.0)
                profile_val = top.get("profileScore")
                profile = float(profile_val) if profile_val is not None else None
                if lexical >= 0.22 or (profile is None or profile >= 0.24):
                    chosen_topic_id = top.get("id")
                    chosen_topic_name = top.get("name")

        # 2) Otherwise reuse the latest classified topic in this stream (continuity).
        if not chosen_topic_id and last_topic_id:
            chosen_topic_id = last_topic_id
            chosen_topic_name = last_topic_name

    # 3) Otherwise derive a new topic name from latest message context.
    if not chosen_topic_name:
        derived = _derive_topic_name(window)
        match, score = _best_name_match(derived, topics, "name")
        if match and score >= 0.72:
            chosen_topic_id = match.get("id")
            chosen_topic_name = match.get("name")
        else:
            chosen_topic_name = derived
            create_topic = True

    if not chosen_topic_name:
        chosen_topic_name = "General"
        create_topic = True

    if not chosen_topic_id:
        chosen_topic_name = _refine_topic_name(chosen_topic_name, window, topic_cands, [])
    else:
        # Never rename existing topics as a side-effect of classification.
        chosen_topic_name = str(chosen_topic_name or "").strip() or chosen_topic_name or "General"

    if create_topic and not _topic_creation_allowed(window, chosen_topic_name, topic_cands, text, topics):
        create_topic = False

    if not create_topic and not chosen_topic_id:
        if topic_cands:
            chosen_topic_id = topic_cands[0].get("id")
            chosen_topic_name = topic_cands[0].get("name") or chosen_topic_name
        elif topics:
            chosen_topic_id = topics[0].get("id")
            chosen_topic_name = topics[0].get("name") or chosen_topic_name

    if not chosen_topic_id and not topics:
        create_topic = True

    topic: dict | None = None
    if create_topic or not chosen_topic_id:
        topic = upsert_topic(None, chosen_topic_name)
        create_topic = True
    else:
        topic = topics_by_id.get(chosen_topic_id)
        if not topic:
            try:
                refreshed = list_topics()
                refreshed_by_id = {t.get("id"): t for t in refreshed if t.get("id")}
                topic = refreshed_by_id.get(chosen_topic_id)
                if topic:
                    topics = refreshed
                    topics_by_id = refreshed_by_id
            except Exception:
                topic = None
        if not topic:
            # Avoid mutating an unexpected/unknown id via upsert. If we can't find it,
            # create a new topic from the derived name.
            topic = upsert_topic(None, chosen_topic_name)
            create_topic = True
        else:
            _ensure_topic_indexed(topic)
    topic_id = str(topic.get("id") or "").strip() if isinstance(topic, dict) else None
    if not topic_id:
        topic = upsert_topic(None, chosen_topic_name)
        topic_id = topic["id"]
        create_topic = True

    task_id = None
    task_title = _derive_task_title(window)
    task_intent = _window_has_task_intent(window, text)
    task_cands = task_candidates(topic_id, text, k=8)
    if task_intent and task_cands and float(task_cands[0].get("score") or 0.0) >= 0.56:
        task_id = task_cands[0]["id"]
    elif task_intent and task_title:
        existing = list_tasks(topic_id)
        match, score = _best_name_match(task_title, existing, "title")
        if match and score >= 0.78:
            task_id = match.get("id")
        elif _task_creation_allowed(window, task_title, task_cands):
            task = upsert_task(None, topic_id, task_title)
            task_id = task["id"]
    if task_intent and not task_id:
        continuity_task = _latest_classified_task_for_topic(ctx_logs, topic_id)
        if continuity_task:
            task_id = continuity_task

    summaries = []
    for entry in window:
        lid = entry.get("id")
        if not lid:
            continue
        raw = (entry.get("summary") or entry.get("content") or entry.get("raw") or "").strip()
        summary = _concise_summary(raw)
        if summary:
            summaries.append({"id": lid, "summary": summary})

    return {
        "topic": {"id": topic_id, "name": (topic.get("name") if isinstance(topic, dict) else None) or chosen_topic_name, "create": False},
        "task": {"id": task_id, "title": task_title, "create": False} if task_id else None,
        "summaries": summaries,
    }


def _conversation_agent(entry: dict) -> str:
    return str(entry.get("agentId") or "").strip().lower()


def _conversation_text(entry: dict) -> str:
    return _strip_transport_noise(entry.get("content") or entry.get("summary") or entry.get("raw") or "")


def _bundle_range(conversations: list[dict], anchor_idx: int) -> tuple[int, int]:
    """Return (start_idx, end_idx) for one coherent request/response bundle."""
    if not conversations:
        return 0, 0
    anchor_idx = max(0, min(anchor_idx, len(conversations) - 1))

    # Prefer starting on a user intent. If the anchor is assistant, include the closest
    # preceding user message so the classifier has intent context.
    start_idx = anchor_idx
    anchor = conversations[anchor_idx]
    if _conversation_agent(anchor) != "user":
        for j in range(anchor_idx, -1, -1):
            if _conversation_agent(conversations[j]) == "user":
                start_idx = j
                break
    else:
        anchor_text = _strip_slash_command(_conversation_text(anchor))
        if anchor_text and _is_affirmation(anchor_text):
            # "Yes/ok" is ambiguous; anchor on the closest earlier non-affirmation user intent.
            for j in range(anchor_idx - 1, -1, -1):
                if _conversation_agent(conversations[j]) != "user":
                    continue
                prev_text = _strip_slash_command(_conversation_text(conversations[j]))
                if prev_text and not _is_affirmation(prev_text):
                    start_idx = j
                    break

    seen_assistant = False
    end_idx = start_idx
    for i in range(start_idx, len(conversations)):
        entry = conversations[i]
        end_idx = i + 1
        agent = _conversation_agent(entry)
        if agent != "user":
            seen_assistant = True
            continue
        if i == start_idx:
            continue
        user_text = _strip_slash_command(_conversation_text(entry))
        # Once the assistant has responded, the next non-affirmation user message
        # usually starts a new request.
        if seen_assistant and user_text and not _is_affirmation(user_text):
            end_idx = i
            break

    # Always return at least one entry.
    return start_idx, max(start_idx + 1, end_idx)


def classify_session(session_key: str):
    # Pull a lookback window of logs for context (conversation + actions).
    ctx_logs = list_logs_by_session(session_key, limit=LOOKBACK_LOGS, offset=0)
    pending_logs = list_logs_by_session(
        session_key,
        limit=max(LOOKBACK_LOGS, 500),
        offset=0,
        classificationStatus="pending",
    )
    if pending_logs:
        seen = {e.get("id") for e in ctx_logs}
        for item in pending_logs:
            if item.get("id") in seen:
                continue
            ctx_logs.append(item)
    ctx_logs = sorted(ctx_logs, key=lambda e: e.get("createdAt") or "")
    ctx_context = [e for e in ctx_logs if _is_context_log(e)]

    # Anchor on the oldest pending conversation so older rows don't starve.
    # We then classify one request/response bundle at a time within this session.
    conversations = [e for e in ctx_context if e.get("type") == "conversation"]
    if not conversations:
        # Still clean up classifier payload noise if present.
        for e in ctx_logs:
            if (e.get("classificationStatus") or "pending") != "pending":
                continue
            attempts = int(e.get("classificationAttempts") or 0)
            if attempts >= MAX_ATTEMPTS:
                continue
            if _is_command_conversation(e):
                patch_log(
                    e["id"],
                    {
                        "classificationStatus": "classified",
                        "classificationAttempts": attempts + 1,
                        "classificationError": "filtered_command",
                    },
                )
                continue
            if _is_noise_conversation(e):
                noise_text = _log_text(e)
                patch_log(
                    e["id"],
                    {
                        "classificationStatus": "failed",
                        "classificationAttempts": attempts + 1,
                        "classificationError": _noise_error_code(noise_text),
                    },
                )
        return
    pending_conversations = [
        e
        for e in conversations
        if (e.get("classificationStatus") or "pending") == "pending"
    ]
    if not pending_conversations:
        # Still clean up classifier payload noise if present.
        for e in ctx_logs:
            if (e.get("classificationStatus") or "pending") != "pending":
                continue
            attempts = int(e.get("classificationAttempts") or 0)
            if attempts >= MAX_ATTEMPTS:
                continue
            if _is_command_conversation(e):
                patch_log(
                    e["id"],
                    {
                        "classificationStatus": "classified",
                        "classificationAttempts": attempts + 1,
                        "classificationError": "filtered_command",
                    },
                )
                continue
            if _is_noise_conversation(e):
                noise_text = _log_text(e)
                patch_log(
                    e["id"],
                    {
                        "classificationStatus": "failed",
                        "classificationAttempts": attempts + 1,
                        "classificationError": _noise_error_code(noise_text),
                    },
                )
        return

    anchor_id = pending_conversations[0].get("id")
    anchor_idx = next((idx for idx, item in enumerate(conversations) if item.get("id") == anchor_id), 0)

    # Classify in request/response bundles so we don't collapse an entire session into one topic.
    bundle_start_idx, bundle_end_idx = _bundle_range(conversations, anchor_idx)
    bundle = conversations[bundle_start_idx:bundle_end_idx]

    # Provide limited prior context (primarily for "yes/ok" style turns) while keeping the
    # LLM window tight enough to avoid cross-topic contamination.
    max_context = max(4, int(WINDOW_SIZE / 4))
    context_slots = min(max_context, max(0, WINDOW_SIZE - len(bundle)))
    window_start = max(0, bundle_start_idx - context_slots)
    window = conversations[window_start:bundle_end_idx]

    pending_ids = [
        e["id"]
        for e in bundle
        if (e.get("classificationStatus") or "pending") == "pending"
        and int(e.get("classificationAttempts") or 0) < MAX_ATTEMPTS
    ]
    if not pending_ids:
        return

    # Patch scope: logs between bundle start and the next user request (exclusive), so
    # interleaved actions are attached to the same topic/task without stamping the whole session.
    pos_by_id: dict[str, int] = {str(e.get("id")): idx for idx, e in enumerate(ctx_logs) if e.get("id")}
    start_id = str(bundle[0].get("id") or "")
    boundary_id = str(conversations[bundle_end_idx].get("id") or "") if bundle_end_idx < len(conversations) else ""
    scope_start_pos = pos_by_id.get(start_id)
    if scope_start_pos is None:
        pending_positions = [pos_by_id.get(pid) for pid in pending_ids if pid in pos_by_id]
        scope_start_pos = min([p for p in pending_positions if isinstance(p, int)], default=0)
    scope_end_pos = pos_by_id.get(boundary_id) if boundary_id else len(ctx_logs)
    if scope_end_pos is None:
        scope_end_pos = len(ctx_logs)
    if scope_end_pos < scope_start_pos:
        scope_end_pos = len(ctx_logs)
    scope_logs = ctx_logs[scope_start_pos:scope_end_pos]

    board_topic_id, board_task_id = _parse_board_session_key(session_key)
    forced_topic_id = board_topic_id or None
    if board_topic_id and board_task_id:
        # Clawboard UI explicitly selects Topic/Task scope via `clawboard:topic:*` / `clawboard:task:*`.
        # Do not let the classifier re-route those logs into other topics/tasks (it can make the
        # user's message "disappear" from the chat pane they sent it from).
        for e in scope_logs:
            if (e.get("classificationStatus") or "pending") != "pending":
                continue
            attempts = int(e.get("classificationAttempts") or 0)
            if attempts >= MAX_ATTEMPTS:
                continue

            if _is_command_conversation(e):
                patch_log(
                    e["id"],
                    {
                        "topicId": board_topic_id,
                        "taskId": board_task_id,
                        "classificationStatus": "classified",
                        "classificationAttempts": attempts + 1,
                        "classificationError": "filtered_command",
                    },
                )
                continue
            if _is_noise_conversation(e):
                noise_text = _log_text(e)
                patch_log(
                    e["id"],
                    {
                        "topicId": board_topic_id,
                        "taskId": board_task_id,
                        "classificationStatus": "failed",
                        "classificationAttempts": attempts + 1,
                        "classificationError": _noise_error_code(noise_text),
                    },
                )
                continue
            log_type = str(e.get("type") or "")
            if log_type in ("system", "import"):
                patch_log(
                    e["id"],
                    {
                        "topicId": board_topic_id,
                        "taskId": board_task_id,
                        "classificationStatus": "classified",
                        "classificationAttempts": attempts + 1,
                        "classificationError": "filtered_non_semantic",
                    },
                )
                continue
            if _is_memory_action(e):
                patch_log(
                    e["id"],
                    {
                        "topicId": board_topic_id,
                        "taskId": board_task_id,
                        "classificationStatus": "classified",
                        "classificationAttempts": attempts + 1,
                        "classificationError": "filtered_memory_action",
                    },
                )
                continue

            patch_payload = {
                "topicId": board_topic_id,
                "taskId": board_task_id,
                "classificationStatus": "classified",
                "classificationAttempts": attempts + 1,
                "classificationError": None,
            }
            if e.get("type") == "conversation":
                summary = _concise_summary((e.get("content") or e.get("summary") or e.get("raw") or "").strip())
                if summary:
                    patch_payload["summary"] = summary
            patch_log(e["id"], patch_payload)

        return

    def mark_window_failure(error_code: str):
        for e in scope_logs:
            if (e.get("classificationStatus") or "pending") != "pending":
                continue
            attempts = int(e.get("classificationAttempts") or 0) + 1
            next_status = "failed" if attempts >= MAX_ATTEMPTS else "pending"
            patch_log(
                e["id"],
                {
                    "classificationStatus": next_status,
                    "classificationAttempts": attempts,
                    "classificationError": error_code,
                },
            )

    notes_index = build_notes_index(ctx_context)
    # If the bundle is just an affirmation ("yes/ok") without a prior user intent inside the
    # bundle, fall back to the limited-context window so we still have semantic signal.
    has_non_affirm_user = False
    for e in bundle:
        if _conversation_agent(e) != "user":
            continue
        utext = _strip_slash_command(_conversation_text(e))
        if utext and not _is_affirmation(utext):
            has_non_affirm_user = True
            break

    # Retrieval text should be anchored on user intent. Including assistant replies
    # can introduce broad disclaimers (auth/security/etc) that then dominate
    # candidate retrieval and cause false-positive topic reuse.
    text = user_window_text(bundle, notes_index) if has_non_affirm_user else window_text(window, notes_index)
    if not text:
        text = window_text(bundle, notes_index)

    # Avoid cross-topic contamination: only include prior context in the LLM window
    # when the bundle itself has no semantic anchor (e.g., "yes/ok" style turns).
    llm_window = bundle if has_non_affirm_user else window

    # Session routing memory: resolve low-signal follow-ups ("yes/ok/ship it") without
    # expanding the lookback/context window. This is persisted server-side so it
    # survives restarts and scales across multiple classifier instances.
    #
    # For scale, only fetch memory when the current bundle is ambiguous.
    continuity_prompt: dict | None = None
    continuity_topic_id: str | None = None
    continuity_topic_name: str | None = None
    continuity_task_id: str | None = None
    continuity_task_title: str | None = None
    continuity_anchor: str | None = None
    forced_by_continuity = False

    # Detect low-signal follow-ups where continuity should be preferred.
    latest_user_text, _latest_user_idx = _latest_user_text(bundle)
    latest_user_text = _strip_slash_command(latest_user_text or "")
    latest_user_norm = _normalize_text(latest_user_text)
    low_signal_followup = (not has_non_affirm_user) or (not latest_user_norm) or _is_affirmation(latest_user_text)
    if latest_user_norm and any(cue in latest_user_norm for cue in SMALL_TALK_CUES):
        low_signal_followup = True
    if latest_user_norm in {
        "also",
        "and",
        "another",
        "one more",
        "quick question",
        "btw",
        "by the way",
        "next",
        "continue",
    }:
        low_signal_followup = True

    # If the user clearly introduced a new intent, do not force continuity.
    has_new_intent = _has_topic_intent(llm_window, text)
    # Affirmations ("yes/ok") are almost never a new topic intent, even if capitalized.
    if _is_affirmation(latest_user_text) or (not has_non_affirm_user):
        has_new_intent = False

    if low_signal_followup and not has_new_intent:
        session_routing = get_session_routing_memory(session_key)
        if session_routing and isinstance(session_routing.get("items"), list):
            items = [it for it in session_routing.get("items") if isinstance(it, dict)]
            if items:
                latest = None
                # Avoid "Small Talk" becoming a sticky continuity bucket for real work sessions.
                for it in reversed(items):
                    name = str(it.get("topicName") or "").strip().lower()
                    if name == "small talk":
                        continue
                    latest = it
                    break
                if latest is None:
                    latest = items[-1]
                continuity_topic_id = str(latest.get("topicId") or "").strip() or None
                continuity_topic_name = str(latest.get("topicName") or "").strip() or None
                continuity_task_id = str(latest.get("taskId") or "").strip() or None
                continuity_task_title = str(latest.get("taskTitle") or "").strip() or None
                continuity_anchor = str(latest.get("anchor") or "").strip() or None

                prompt_items: list[dict] = []
                for it in items[-max(1, min(8, int(SESSION_ROUTING_PROMPT_ITEMS))):]:
                    prompt_items.append(
                        {
                            "ts": it.get("ts"),
                            "topicId": it.get("topicId"),
                            "topicName": it.get("topicName"),
                            "taskId": it.get("taskId"),
                            "taskTitle": it.get("taskTitle"),
                            "anchor": it.get("anchor"),
                        }
                    )
                continuity_prompt = {
                    "isAmbiguousBundle": True,
                    "suggested": {
                        "topicId": continuity_topic_id,
                        "topicName": continuity_topic_name,
                        "taskId": continuity_task_id,
                        "taskTitle": continuity_task_title,
                        "anchor": continuity_anchor,
                    },
                    "recent": prompt_items,
                }

        if (not forced_topic_id) and continuity_topic_id:
            try:
                topics = list_topics()
                if any(str(t.get("id") or "").strip() == continuity_topic_id for t in (topics or [])):
                    forced_topic_id = continuity_topic_id
                    forced_by_continuity = True
            except Exception:
                forced_by_continuity = False

        # When a follow-up is low-signal, augment retrieval text with the last known anchor.
        # This improves task candidate selection in heuristic mode and gives the LLM a stable handle.
        if continuity_anchor:
            text = (text + "\n\nPrior intent: " + continuity_anchor).strip()[-6000:]

    # Build a compact intent anchor to persist for future continuity decisions.
    anchor_for_memory: str | None = None
    if has_non_affirm_user:
        for e in bundle:
            if _conversation_agent(e) != "user":
                continue
            utext = _strip_slash_command(_conversation_text(e))
            if utext and not _is_affirmation(utext):
                anchor_for_memory = utext
                break
    if not anchor_for_memory:
        anchor_for_memory = continuity_anchor or latest_user_text or ""
    anchor_for_memory = _clip_text(anchor_for_memory or "", 800).strip() or None

    # Small-talk fast path: skip the LLM and attach to a stable "Small Talk" topic.
    # This avoids topic bloat (every small chat turn becoming a new topic) and keeps
    # the classifier loop fast under casual chatter.
    if not forced_topic_id and _is_small_talk_bundle(bundle, text):
        try:
            all_topics = list_topics()
            match, score = _best_name_match("Small Talk", all_topics, "name")
            existing = match if match and score >= 0.92 else None
            if existing and existing.get("id"):
                topic_id = str(existing.get("id") or "").strip()
                _ensure_topic_indexed(existing)
            else:
                topic = upsert_topic(None, "Small Talk")
                topic_id = topic["id"]
        except Exception:
            mark_window_failure("small_talk_topic_error")
            return

        for entry in scope_logs:
            if (entry.get("classificationStatus") or "pending") != "pending":
                continue
            attempts = int(entry.get("classificationAttempts") or 0)
            if attempts >= MAX_ATTEMPTS:
                continue
            payload = {
                "topicId": topic_id,
                "taskId": None,
                "classificationStatus": "classified",
                "classificationAttempts": attempts + 1,
                "classificationError": None,
            }
            if entry.get("type") == "conversation":
                summary = _concise_summary((entry.get("content") or entry.get("summary") or "").strip())
                if summary:
                    payload["summary"] = summary
            patch_log(entry["id"], payload)
        return
    memory_hits = memory_snippets(text)

    topic_cands: list[dict] = []
    task_cands: list[dict] = []
    topic_contexts: dict[str, list[dict]] = {}
    task_contexts: dict[str, list[dict]] = {}

    if forced_topic_id:
        forced_topic_name = None
        try:
            # Best-effort: include the board-selected topic as the only candidate so the
            # LLM can focus on whether a task should be inferred/created within it.
            all_topics = list_topics()
            match = next((t for t in all_topics if t.get("id") == forced_topic_id), None)
            if match and match.get("name"):
                forced_topic_name = str(match.get("name") or "").strip()
        except Exception:
            forced_topic_name = None
        if not forced_topic_name:
            forced_topic_name = "General"

        topic_cands = [
            {
                "id": forced_topic_id,
                "name": forced_topic_name,
                "score": 1.0,
                "vectorScore": 1.0,
                "bm25Score": 1.0,
                "bm25Norm": 1.0,
                "coverageScore": 1.0,
                "phraseScore": 1.0,
                "lexicalScore": 1.0,
            }
        ]

        try:
            logs = list_logs_by_topic(forced_topic_id, limit=10, offset=0)
            topic_notes = build_notes_index(logs)
            topic_contexts[forced_topic_id] = summarize_logs(logs, topic_notes, limit=6)
        except Exception:
            pass

        task_cands = task_candidates(forced_topic_id, text)
        for t in task_cands:
            tid = t.get("id")
            if not tid:
                continue
            try:
                logs = list_logs_by_task(tid, limit=10, offset=0)
                task_notes = build_notes_index(logs)
                task_contexts[tid] = summarize_logs(logs, task_notes, limit=6)
            except Exception:
                continue
    else:
        ensure_topic_index_seeded()
        topic_cands = topic_candidates(text)
        # "Small Talk" is a reserved topic handled by the fast path above. Excluding it
        # here prevents the LLM from using it as a generic bucket for unrelated bundles.
        topic_cands = [
            t for t in topic_cands if str(t.get("name") or "").strip().lower() != "small talk"
        ]

        # If we have a strong top topic, also propose task candidates for it.
        if topic_cands and topic_cands[0]["score"] >= TOPIC_SIM_THRESHOLD:
            task_cands = task_candidates(topic_cands[0]["id"], text)

        # Context hydration is expensive (API round-trips). Only fetch "recent" context
        # for candidates that are plausibly relevant.
        topic_ctx_min_score = max(0.42, TOPIC_SIM_THRESHOLD - 0.32)
        topic_ctx_cands = [t for t in topic_cands if float(t.get("score") or 0.0) >= topic_ctx_min_score][:3]
        for t in topic_ctx_cands:
            tid = t.get("id")
            if not tid:
                continue
            logs = list_logs_by_topic(tid, limit=10, offset=0)
            topic_notes = build_notes_index(logs)
            topic_contexts[tid] = summarize_logs(logs, topic_notes, limit=6)

        for t in task_cands:
            tid = t.get("id")
            if not tid:
                continue
            logs = list_logs_by_task(tid, limit=10, offset=0)
            task_notes = build_notes_index(logs)
            task_contexts[tid] = summarize_logs(logs, task_notes, limit=6)

    # Late-interaction profile scoring: compare the current bundle text against each candidate's
    # recent context (when hydrated). This helps avoid false-positive reuses under busy sessions.
    try:
        _attach_profile_scores(topic_cands, topic_contexts, text)
        _attach_profile_scores(task_cands, task_contexts, text)
    except Exception:
        pass

    fallback_error: str | None = None
    if _llm_enabled():
        try:
            result = call_classifier(
                llm_window,
                pending_ids,
                topic_cands,
                task_cands,
                notes_index,
                topic_contexts,
                task_contexts,
                memory_hits,
                continuity=continuity_prompt,
            )
        except requests.exceptions.ReadTimeout:
            fallback_error = "llm_timeout"
        except Exception as exc:
            fallback_error = f"classifier_error:{str(exc)[:120]}"
    else:
        fallback_error = "llm_disabled"

    if fallback_error:
        prefer_continuity = False
        try:
            bundle_has_assistant = any(_conversation_agent(e) == "assistant" for e in bundle)
            prefer_continuity = not bundle_has_assistant
            if forced_topic_id:
                task_id = None
                task_title = _derive_task_title(llm_window)
                task_intent = _window_has_task_intent(llm_window, text)
                task_cands2 = task_candidates(forced_topic_id, text, k=8)
                if task_intent and task_cands2 and float(task_cands2[0].get("score") or 0.0) >= 0.56:
                    task_id = task_cands2[0]["id"]
                elif task_intent and task_title:
                    existing_tasks = list_tasks(forced_topic_id)
                    match, score = _best_name_match(task_title, existing_tasks, "title")
                    if match and score >= 0.78:
                        task_id = match.get("id")
                    elif _task_creation_allowed(llm_window, task_title, task_cands2):
                        task = upsert_task(None, forced_topic_id, task_title)
                        task_id = task["id"]
                if task_intent and not task_id:
                    continuity_task = _latest_classified_task_for_topic(ctx_logs, forced_topic_id)
                    if continuity_task:
                        task_id = continuity_task

                summaries = []
                for entry in llm_window:
                    lid = entry.get("id")
                    if not lid:
                        continue
                    raw = (entry.get("summary") or entry.get("content") or entry.get("raw") or "").strip()
                    summary = _concise_summary(raw)
                    if summary:
                        summaries.append({"id": lid, "summary": summary})

                forced_topic_name = str((topic_cands[0].get("name") if topic_cands else "") or "").strip() or "General"
                result = {
                    "topic": {"id": forced_topic_id, "name": forced_topic_name, "create": False},
                    "task": {"id": task_id, "title": task_title, "create": False} if task_id else None,
                    "summaries": summaries,
                }
            else:
                result = classify_without_llm(llm_window, ctx_logs, topic_cands, text, prefer_continuity=prefer_continuity)
        except Exception:
            if forced_topic_id:
                # Keep the UI deterministic even under classifier failures: attach to the
                # board-selected topic without attempting topic creation or re-routing.
                for entry in scope_logs:
                    if (entry.get("classificationStatus") or "pending") != "pending":
                        continue
                    attempts = int(entry.get("classificationAttempts") or 0)
                    if attempts >= MAX_ATTEMPTS:
                        continue
                    payload = {
                        "topicId": forced_topic_id,
                        "taskId": None,
                        "classificationStatus": "classified",
                        "classificationAttempts": attempts + 1,
                        "classificationError": f"fallback:{fallback_error}",
                    }
                    if entry.get("type") == "conversation":
                        summary = _concise_summary((entry.get("content") or entry.get("summary") or "").strip())
                        if summary:
                            payload["summary"] = summary
                    patch_log(entry["id"], payload)
                return
            # Last-resort: keep the system moving even if both LLM and heuristic modes fail.
            # This avoids leaving logs stuck in "pending" forever (which breaks UI + E2E).
            continuity_topic_id = None
            for item in reversed(ctx_logs):
                if (item.get("classificationStatus") or "pending") != "classified":
                    continue
                tid = item.get("topicId")
                if tid:
                    continuity_topic_id = tid
                    break

            topic_id = None
            try:
                if prefer_continuity and continuity_topic_id:
                    topic_id = continuity_topic_id
                elif topic_cands and float(topic_cands[0].get("score") or 0.0) >= TOPIC_SIM_THRESHOLD:
                    topic_id = topic_cands[0].get("id")
                if not topic_id:
                    derived = _derive_topic_name(llm_window) or "General"
                    refined = _refine_topic_name(derived, llm_window, topic_cands, []) or derived
                    topic = upsert_topic(None, refined)
                    topic_id = topic.get("id")
            except Exception:
                mark_window_failure(fallback_error)
                return

            if not topic_id:
                mark_window_failure(fallback_error)
                return

            # Patch this bundle scope directly (topic-only, no tasks) and return.
            for entry in scope_logs:
                if (entry.get("classificationStatus") or "pending") != "pending":
                    continue
                attempts = int(entry.get("classificationAttempts") or 0)
                if attempts >= MAX_ATTEMPTS:
                    continue
                payload = {
                    "topicId": topic_id,
                    "taskId": None,
                    "classificationStatus": "classified",
                    "classificationAttempts": attempts + 1,
                    "classificationError": f"fallback:{fallback_error}",
                }
                if entry.get("type") == "conversation":
                    summary = _concise_summary((entry.get("content") or entry.get("summary") or "").strip())
                    if summary:
                        payload["summary"] = summary
                patch_log(entry["id"], payload)
            return

    if forced_topic_id:
        # Board Topic Chat pins the topic scope; classifier may still infer/create a task within it.
        topic_id = forced_topic_id
    else:
        chosen_topic_id = (result.get("topic") or {}).get("id")
        chosen_topic_name = (result.get("topic") or {}).get("name")
        create_topic = bool((result.get("topic") or {}).get("create"))

        # Enforce schema invariants from the prompt: a missing topic id means we are
        # creating a new topic; a create=true topic must not specify an id.
        if create_topic:
            chosen_topic_id = None
        if not chosen_topic_id:
            create_topic = True

        # If the LLM selected an existing topic but our retrieval says "no clear match",
        # prefer creating a new topic. This prevents generic buckets (e.g., "Docker") from
        # absorbing unrelated, clearly-scoped conversations.
        #
        # We only do this when the bundle shows topic intent; low-signal follow-ups should
        # keep continuity instead of spawning new topics.
        top_topic_score = float(topic_cands[0].get("score") or 0.0) if topic_cands else 0.0
        if (
            chosen_topic_id
            and not create_topic
            and top_topic_score < max(0.52, TOPIC_SIM_THRESHOLD - 0.2)
            and _has_topic_intent(llm_window, text)
        ):
            chosen_topic_id = None
            create_topic = True
            derived = _derive_topic_name(llm_window)
            if derived:
                chosen_topic_name = derived

        # Guardrail: prevent obvious duplicate topics when the LLM proposes a new topic but
        # the current-bundle search is already a very strong match to an existing one.
        #
        # Keep this conservative: dense/vector similarity alone can be too broad (e.g., many
        # infra questions matching a generic "Docker" topic). Require a lexical anchor too.
        if (
            create_topic
            and not chosen_topic_id
            and topic_cands
            and float(topic_cands[0].get("score") or 0.0) >= TOPIC_SIM_THRESHOLD
            and float(topic_cands[0].get("lexicalScore") or 0.0) >= 0.18
        ):
            chosen_topic_id = topic_cands[0].get("id")
            create_topic = False
            if not chosen_topic_name:
                chosen_topic_name = topic_cands[0].get("name")

        if not chosen_topic_name:
            chosen_topic_name = "General"

        if not chosen_topic_id:
            chosen_topic_name = _refine_topic_name(chosen_topic_name, llm_window, topic_cands, memory_hits)
        else:
            # Never rename existing topics as a side-effect of classification.
            chosen_topic_name = str(chosen_topic_name or "").strip() or chosen_topic_name or "General"

        all_topics = list_topics()
        existing_topic: dict | None = None
        if chosen_topic_id:
            existing_topic = next((t for t in all_topics if t.get("id") == chosen_topic_id), None)
            if existing_topic and existing_topic.get("name"):
                chosen_topic_name = str(existing_topic.get("name") or "").strip() or chosen_topic_name
        topic_name_match, topic_name_score = _best_name_match(chosen_topic_name, all_topics, "name")
        if topic_name_match and topic_name_score >= TOPIC_NAME_SIM_THRESHOLD:
            chosen_topic_id = topic_name_match["id"]
            chosen_topic_name = topic_name_match.get("name") or chosen_topic_name
            create_topic = False
        # Re-resolve after any id/name de-dupe adjustments above.
        existing_topic = next((t for t in all_topics if t.get("id") == chosen_topic_id), None) if chosen_topic_id else None

        if create_topic and not _topic_creation_allowed(llm_window, chosen_topic_name, topic_cands, text, all_topics):
            create_topic = False

        if create_topic:
            try:
                gate = call_creation_gate(llm_window, topic_cands, task_cands, chosen_topic_name, None)
                allowed = bool(gate.get("createTopic"))
                _record_creation_gate("topic", "allow" if allowed else "block", chosen_topic_name, gate.get("topicId"))
                if not allowed:
                    create_topic = False
                    gate_topic_id = gate.get("topicId")
                    if isinstance(gate_topic_id, str) and gate_topic_id:
                        chosen_topic_id = gate_topic_id
                        match = next((t for t in topic_cands if t.get("id") == gate_topic_id), None)
                        if match and match.get("name"):
                            chosen_topic_name = match.get("name")
            except Exception:
                _record_creation_gate("topic", "block", chosen_topic_name, None)
                create_topic = False

        if not create_topic and not chosen_topic_id:
            if topic_cands:
                chosen_topic_id = topic_cands[0].get("id")
                chosen_topic_name = topic_cands[0].get("name") or chosen_topic_name
            elif all_topics:
                chosen_topic_id = all_topics[0].get("id")
                chosen_topic_name = all_topics[0].get("name") or chosen_topic_name

        if not chosen_topic_id and not all_topics:
            create_topic = True

        topic_id: str | None = None
        if create_topic or not chosen_topic_id:
            topic = upsert_topic(None, chosen_topic_name)
            topic_id = str(topic.get("id") or "").strip()
        else:
            # If this is an existing topic, avoid mutating it (no renames/tag clobber).
            if not existing_topic:
                existing_topic = next((t for t in all_topics if t.get("id") == chosen_topic_id), None)
            if existing_topic and existing_topic.get("id"):
                topic_id = str(existing_topic.get("id") or "").strip()
                if existing_topic.get("name"):
                    chosen_topic_name = str(existing_topic.get("name") or "").strip() or chosen_topic_name
                _ensure_topic_indexed(existing_topic)
            else:
                topic = upsert_topic(None, chosen_topic_name)
                topic_id = str(topic.get("id") or "").strip()
        if not topic_id:
            topic = upsert_topic(None, chosen_topic_name)
            topic_id = str(topic.get("id") or "").strip()

    # Task selection/creation (within topic)
    task_id = None
    task_from_continuity = False
    task_cands2 = task_candidates(topic_id, text)
    task_result = result.get("task")
    task_intent = _window_has_task_intent(llm_window, text)
    if forced_topic_id and isinstance(task_result, dict):
        # Board Topic Chat: trust the LLM when it explicitly proposes/selects a task.
        # This prevents false negatives when heuristic intent detection is too conservative.
        if bool(task_result.get("create")) or bool(task_result.get("id")):
            task_intent = True
    existing_tasks: list[dict] = []
    try:
        existing_tasks = list_tasks(topic_id)
    except Exception:
        existing_tasks = []
    valid_task_ids: set[str] = {str(t.get("id") or "").strip() for t in existing_tasks if t.get("id")}

    # Sticky task continuity for low-signal follow-ups in the same session.
    # This keeps "ok/yes/thanks" turns attached to the active task even when intent
    # detection is too conservative and retrieval text is minimal.
    if (
        not task_id
        and low_signal_followup
        and not has_new_intent
        and continuity_topic_id
        and continuity_topic_id == topic_id
        and continuity_task_id
        and continuity_task_id in valid_task_ids
    ):
        task_id = continuity_task_id
        task_from_continuity = True

    if isinstance(task_result, dict):
        task_title = task_result.get("title")
        create_task = bool(task_result.get("create"))
        proposed_task_id = task_result.get("id")

        ensure_task_index_seeded(topic_id)
        if task_cands2 and task_cands2[0]["score"] >= TASK_SIM_THRESHOLD:
            task_id = task_cands2[0]["id"]
        else:
            if create_task and not _task_creation_allowed(llm_window, task_title, task_cands2):
                create_task = False
            if create_task:
                try:
                    gate = call_creation_gate(llm_window, topic_cands, task_cands2, None, task_title)
                    allowed = bool(gate.get("createTask"))
                    _record_creation_gate("task", "allow" if allowed else "block", task_title, gate.get("taskId"))
                    if not allowed:
                        gate_task_id = gate.get("taskId")
                        if isinstance(gate_task_id, str) and gate_task_id and gate_task_id in valid_task_ids:
                            create_task = False
                            task_id = gate_task_id
                        elif task_intent and _task_creation_allowed(llm_window, task_title, task_cands2):
                            _record_creation_gate("task", "allow_fallback", task_title, None)
                            create_task = True
                        else:
                            create_task = False
                except Exception:
                    if task_intent and _task_creation_allowed(llm_window, task_title, task_cands2):
                        _record_creation_gate("task", "allow_fallback", task_title, None)
                        create_task = True
                    else:
                        _record_creation_gate("task", "block", task_title, None)
                        create_task = False
            if proposed_task_id and not create_task:
                # Guardrail: ensure the chosen task belongs to the selected topic.
                if isinstance(proposed_task_id, str) and proposed_task_id in valid_task_ids:
                    task_id = proposed_task_id
            elif create_task and task_title:
                task_name_match, task_name_score = _best_name_match(task_title, existing_tasks, "title")
                if task_name_match and task_name_score >= TASK_NAME_SIM_THRESHOLD:
                    task_id = task_name_match["id"]
                else:
                    task = upsert_task(None, topic_id, task_title)
                    task_id = task["id"]

    if task_id and not task_intent and not task_from_continuity:
        task_id = None

    # Keep task continuity without creating duplicates.
    if task_intent and not task_id:
        if task_cands2 and float(task_cands2[0].get("score") or 0.0) >= max(0.46, TASK_SIM_THRESHOLD - 0.24):
            task_id = task_cands2[0]["id"]

    if task_intent and not task_id:
        continuity_task = _latest_classified_task_for_topic(ctx_logs, topic_id)
        if continuity_task:
            task_id = continuity_task

    if task_intent and not task_id and _looks_actionable(text):
        open_tasks = [task for task in existing_tasks if (task.get("status") or "todo") != "done"]
        if len(open_tasks) == 1:
            task_id = open_tasks[0].get("id")
        else:
            task_title = _derive_task_title(llm_window)
            if task_title:
                task_name_match, task_name_score = _best_name_match(task_title, existing_tasks, "title")
                if task_name_match and task_name_score >= 0.74:
                    task_id = task_name_match["id"]
                elif _task_creation_allowed(llm_window, task_title, task_cands2):
                    try:
                        gate = call_creation_gate(llm_window, topic_cands, task_cands2, None, task_title)
                        allowed = bool(gate.get("createTask"))
                        _record_creation_gate("task", "allow" if allowed else "block", task_title, gate.get("taskId"))
                        if not allowed:
                            gate_task_id = gate.get("taskId")
                            if isinstance(gate_task_id, str) and gate_task_id:
                                if gate_task_id in valid_task_ids:
                                    task_id = gate_task_id
                            else:
                                _record_creation_gate("task", "allow_fallback", task_title, None)
                                task = upsert_task(None, topic_id, task_title)
                                task_id = task["id"]
                        else:
                            task = upsert_task(None, topic_id, task_title)
                            task_id = task["id"]
                    except Exception:
                        _record_creation_gate("task", "allow_fallback", task_title, None)
                        task = upsert_task(None, topic_id, task_title)
                        task_id = task["id"]

    summary_updates: dict[str, str] = {}
    window_by_id: dict[str, dict] = {str(e.get("id")): e for e in llm_window if e.get("id")}
    raw_summaries = result.get("summaries")
    if isinstance(raw_summaries, list):
        for item in raw_summaries:
            if not isinstance(item, dict):
                continue
            sid = item.get("id")
            stext = item.get("summary")
            if not sid or not isinstance(stext, str):
                continue
            if sid not in pending_ids:
                continue
            concise = _concise_summary(stext)
            source_entry = window_by_id.get(sid) or {}
            source_text = str(source_entry.get("content") or source_entry.get("summary") or source_entry.get("raw") or "")
            if concise and not _is_low_signal_summary(concise, source_text):
                summary_updates[sid] = concise

    missing_pending = [sid for sid in pending_ids if sid not in summary_updates]
    if missing_pending:
        repaired = call_summary_repair(llm_window, missing_pending, notes_index)
        for sid, summary in repaired.items():
            source_entry = window_by_id.get(sid) or {}
            source_text = str(source_entry.get("content") or source_entry.get("summary") or source_entry.get("raw") or "")
            if sid in missing_pending and summary and not _is_low_signal_summary(summary, source_text):
                summary_updates[sid] = summary

    for e in llm_window:
        if (e.get("classificationStatus") or "pending") != "pending":
            continue
        if e.get("type") != "conversation":
            continue
        sid = e.get("id")
        if not sid or sid in summary_updates:
            continue
        concise = _concise_summary((e.get("summary") or e.get("content") or e.get("raw") or "").strip())
        if concise:
            summary_updates[sid] = concise

    # Optional: write a compact audit record for tuning/debugging classifier policies.
    _record_classifier_audit(
        {
            "sessionKey": session_key,
            "boardTopicId": board_topic_id,
            "boardTaskId": board_task_id,
            "forcedTopicId": forced_topic_id,
            "forcedByContinuity": bool(forced_by_continuity),
            "lowSignalFollowup": bool(low_signal_followup),
            "continuitySuggested": (continuity_prompt.get("suggested") if isinstance(continuity_prompt, dict) else None),
            "pendingIds": pending_ids,
            "scopeIds": [str(e.get("id")) for e in scope_logs if e.get("id")],
            "queryText": _clip_text(text or "", 2000),
            "fallbackError": fallback_error,
            "decision": {"topicId": topic_id, "taskId": task_id},
            "topicCandidates": [
                {
                    "id": t.get("id"),
                    "name": t.get("name"),
                    "status": t.get("status"),
                    "tags": (t.get("tags")[:8] if isinstance(t.get("tags"), list) else []),
                    "score": float(t.get("score") or 0.0),
                    "vectorScore": float(t.get("vectorScore") or 0.0),
                    "bm25Norm": float(t.get("bm25Norm") or 0.0),
                    "lexicalScore": float(t.get("lexicalScore") or 0.0),
                    "coverageScore": float(t.get("coverageScore") or 0.0),
                    "phraseScore": float(t.get("phraseScore") or 0.0),
                    "profileScore": (float(t.get("profileScore")) if t.get("profileScore") is not None else None),
                }
                for t in (topic_cands or [])[:8]
            ],
            "taskCandidates": [
                {
                    "id": t.get("id"),
                    "title": t.get("title"),
                    "status": t.get("status"),
                    "tags": (t.get("tags")[:8] if isinstance(t.get("tags"), list) else []),
                    "score": float(t.get("score") or 0.0),
                    "vectorScore": float(t.get("vectorScore") or 0.0),
                    "bm25Norm": float(t.get("bm25Norm") or 0.0),
                    "lexicalScore": float(t.get("lexicalScore") or 0.0),
                    "coverageScore": float(t.get("coverageScore") or 0.0),
                    "phraseScore": float(t.get("phraseScore") or 0.0),
                    "profileScore": (float(t.get("profileScore")) if t.get("profileScore") is not None else None),
                }
                for t in (task_cands or [])[:10]
            ],
        }
    )

    # Patch only logs in this bundle scope (conversation + interleaved actions), not the entire session.
    for e in scope_logs:
        if (e.get("classificationStatus") or "pending") != "pending":
            continue
        attempts = int(e.get("classificationAttempts") or 0)
        if attempts >= MAX_ATTEMPTS:
            continue
        if _is_command_conversation(e):
            patch_log(
                e["id"],
                {
                    "classificationStatus": "classified",
                    "classificationAttempts": attempts + 1,
                    "classificationError": "filtered_command",
                },
            )
            continue
        if _is_noise_conversation(e):
            noise_text = _log_text(e)
            patch_log(
                e["id"],
                {
                    "classificationStatus": "failed",
                    "classificationAttempts": attempts + 1,
                    "classificationError": _noise_error_code(noise_text),
                },
            )
            continue
        log_type = str(e.get("type") or "")
        if log_type in ("system", "import"):
            patch_log(
                e["id"],
                {
                    "classificationStatus": "classified",
                    "classificationAttempts": attempts + 1,
                    "classificationError": "filtered_non_semantic",
                },
            )
            continue
        if _is_memory_action(e):
            patch_log(
                e["id"],
                {
                    "classificationStatus": "classified",
                    "classificationAttempts": attempts + 1,
                    "classificationError": "filtered_memory_action",
                },
            )
            continue
        patch_payload = {
            "topicId": topic_id,
            "taskId": task_id,
            "classificationStatus": "classified",
            "classificationAttempts": attempts + 1,
            "classificationError": None,
        }
        if e.get("type") == "conversation":
            summary = summary_updates.get(e["id"])
            if summary:
                patch_payload["summary"] = summary
        patch_log(
            e["id"],
            patch_payload,
        )

    # Best-effort: persist continuity memory for this session so future low-signal
    # follow-ups can be routed without widening the context window.
    try:
        topic_name_for_memory: str | None = None
        candidate_topic_name = None
        try:
            for cand in (topic_cands or []):
                if str(cand.get("id") or "").strip() == str(topic_id or "").strip():
                    candidate_topic_name = cand.get("name")
                    break
        except Exception:
            candidate_topic_name = None
        if candidate_topic_name:
            topic_name_for_memory = str(candidate_topic_name).strip() or None

        chosen_topic_name_val = locals().get("chosen_topic_name")
        if not topic_name_for_memory and isinstance(chosen_topic_name_val, str) and chosen_topic_name_val.strip():
            topic_name_for_memory = chosen_topic_name_val.strip()

        if not topic_name_for_memory and continuity_topic_name:
            topic_name_for_memory = continuity_topic_name

        chosen_task_title: str | None = None
        if task_id:
            for t in (existing_tasks or []):
                if str(t.get("id") or "").strip() == str(task_id).strip():
                    title = t.get("title")
                    if title:
                        chosen_task_title = str(title).strip()
                        break
        if not chosen_task_title and task_from_continuity and continuity_task_title:
            chosen_task_title = continuity_task_title

        decision_ts = None
        try:
            if scope_logs and isinstance(scope_logs[-1], dict):
                decision_ts = scope_logs[-1].get("createdAt") or None
        except Exception:
            decision_ts = None

        append_session_routing_memory(
            session_key,
            topic_id=str(topic_id or "").strip(),
            topic_name=topic_name_for_memory,
            task_id=(str(task_id).strip() if task_id else None),
            task_title=chosen_task_title,
            anchor=anchor_for_memory,
            ts=(str(decision_ts).strip() if decision_ts else None),
        )
    except Exception:
        pass


def main():
    while True:
        process_reindex_queue()
        if not acquire_lock():
            time.sleep(INTERVAL)
            continue

        next_sleep = INTERVAL
        cycle_start = time.time()
        try:
            # Fetch pending conversations (paged) and group by sessionKey.
            pending: list[dict] = []
            try:
                offset = 0
                while True:
                    page = list_pending_conversations(limit=500, offset=offset)
                    if not page:
                        break
                    pending.extend(page)
                    if len(page) < 500:
                        break
                    offset += 500
                    if offset >= 5000:
                        break
            except Exception as e:
                # Common on startup when api container isn't ready.
                print(f"classifier: clawboard api unavailable: {e}")
                pending = []

            filtered_pending: list[dict] = []
            for e in pending:
                if not _is_noise_conversation(e):
                    filtered_pending.append(e)
                    continue
                attempts = int(e.get("classificationAttempts") or 0) + 1
                next_status = "failed" if attempts >= MAX_ATTEMPTS else "pending"
                noise_text = _log_text(e)
                try:
                    patch_log(
                        e["id"],
                        {
                            "classificationStatus": next_status,
                            "classificationAttempts": attempts,
                            "classificationError": _noise_error_code(noise_text),
                        },
                    )
                except Exception:
                    pass
            pending = filtered_pending

            session_stats: dict[str, dict] = {}
            for e in pending:
                sk = ((e.get("source") or {}) or {}).get("sessionKey")
                if not sk:
                    continue
                stats = session_stats.setdefault(
                    sk,
                    {
                        "count": 0,
                        "user": 0,
                        "assistant": 0,
                        "channel": False,
                        "messageId": 0,
                        # Used to prioritize freshly-active sessions so new messages get classified quickly.
                        "newestPendingAtTs": 0.0,
                    },
                )
                stats["count"] += 1
                agent = (e.get("agentId") or "").lower()
                if agent == "user":
                    stats["user"] += 1
                if agent == "assistant":
                    stats["assistant"] += 1
                source = (e.get("source") or {}) or {}
                if sk.startswith("channel:") or bool(source.get("channel")):
                    stats["channel"] = True
                if source.get("messageId"):
                    stats["messageId"] += 1
                created_at = str(e.get("createdAt") or "").strip()
                if created_at:
                    try:
                        raw = created_at[:-1] + "+00:00" if created_at.endswith("Z") else created_at
                        ts = datetime.fromisoformat(raw)
                        if ts.tzinfo is None:
                            ts = ts.replace(tzinfo=timezone.utc)
                        stats["newestPendingAtTs"] = max(stats["newestPendingAtTs"], float(ts.timestamp()))
                    except Exception:
                        pass

            session_keys: list[str] = []
            for sk, stats in session_stats.items():
                if sk.startswith("agent:classifier"):
                    continue
                if stats["channel"]:
                    session_keys.append(sk)
                    continue
                # Fallback for environments where channel session keys are unavailable:
                # classify any real conversation thread even with single pending turns
                # so each user/assistant message lands in a topic quickly.
                if stats["count"] >= 1 and (stats["user"] > 0 or stats["assistant"] > 0):
                    session_keys.append(sk)

            session_keys.sort(
                key=lambda sk: (
                    0 if session_stats.get(sk, {}).get("channel") else 1,
                    -float(session_stats.get(sk, {}).get("newestPendingAtTs") or 0.0),
                    -int(session_stats.get(sk, {}).get("count") or 0),
                )
            )
            session_keys = session_keys[:MAX_SESSIONS_PER_CYCLE]
            if session_keys:
                next_sleep = min(INTERVAL, 1.0)
            for sk in session_keys:
                if (time.time() - cycle_start) > CYCLE_BUDGET_SECONDS:
                    if LOG_TIMING:
                        print(
                            f"classifier: cycle budget reached ({CYCLE_BUDGET_SECONDS:.0f}s); "
                            f"deferring remaining sessions"
                        )
                    break
                try:
                    start = time.time()
                    _run_with_timeout(MAX_SESSION_SECONDS, classify_session, sk)
                    if LOG_TIMING:
                        elapsed = time.time() - start
                        print(f"classifier: classified {sk} in {elapsed:.2f}s")
                except _ClassifierTimeout:
                    print(f"classifier: classify_session timeout for {sk} after {MAX_SESSION_SECONDS:.0f}s")
                except Exception as e:
                    print(f"classifier: classify_session failed for {sk}: {e}")

        finally:
            release_lock()

        time.sleep(next_sleep)


if __name__ == "__main__":
    main()
