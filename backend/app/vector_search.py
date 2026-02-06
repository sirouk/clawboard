from __future__ import annotations

import os
import re
import sqlite3
import threading
from typing import Iterable

try:
    import numpy as np
except Exception:  # pragma: no cover - optional dependency
    np = None  # type: ignore[assignment]

try:
    from fastembed import TextEmbedding
except Exception:  # pragma: no cover - optional dependency
    TextEmbedding = None  # type: ignore[assignment]


EMBED_DB_PATH = os.getenv("CLAWBOARD_VECTOR_DB_PATH", "./data/classifier_embeddings.db")
EMBED_MODEL = os.getenv("CLAWBOARD_VECTOR_MODEL", "BAAI/bge-small-en-v1.5")

_MODEL = None
_MODEL_LOCK = threading.Lock()

STOP_WORDS = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "about",
    "where",
    "what",
    "when",
    "have",
    "has",
    "been",
    "were",
    "is",
    "are",
    "to",
    "of",
    "on",
    "in",
    "a",
    "an",
}


def vector_runtime_available() -> bool:
    return np is not None and TextEmbedding is not None


def _normalize_text(value: str | None) -> str:
    if not value:
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"^\s*summary\s*[:\-]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"^\[Discord [^\]]+\]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"\[message[_\s-]?id:[^\]]+\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _token_set(value: str) -> set[str]:
    normalized = re.sub(r"[^a-z0-9\s]+", " ", value.lower())
    return {
        token
        for token in (part.strip() for part in normalized.split(" "))
        if len(token) > 2 and token not in STOP_WORDS
    }


def lexical_similarity(query: str, text: str) -> float:
    s1 = _token_set(query)
    s2 = _token_set(text)
    if not s1 or not s2:
        return 0.0
    inter = len(s1 & s2)
    union = len(s1 | s2)
    if union <= 0:
        return 0.0
    return inter / union


def _get_model():
    global _MODEL
    if not vector_runtime_available():
        return None
    with _MODEL_LOCK:
        if _MODEL is None:
            try:
                _MODEL = TextEmbedding(EMBED_MODEL)
            except Exception:
                _MODEL = None
        return _MODEL


def _embed_query(text: str):
    model = _get_model()
    if model is None:
        return None
    try:
        vec = next(model.embed([text]), None)
    except Exception:
        return None
    if vec is None:
        return None
    arr = np.asarray(vec, dtype=np.float32)
    if arr.size == 0:
        return None
    return arr


def _load_vectors(kind_exact: str | None = None, kind_prefix: str | None = None) -> list[tuple[str, str, "np.ndarray"]]:
    if np is None:
        return []
    db_path = os.path.abspath(EMBED_DB_PATH)
    if not os.path.exists(db_path):
        return []
    conn = sqlite3.connect(db_path)
    try:
        if kind_exact:
            rows = conn.execute("SELECT kind, id, vector, dim FROM embeddings WHERE kind=?", (kind_exact,)).fetchall()
        elif kind_prefix:
            rows = conn.execute("SELECT kind, id, vector, dim FROM embeddings WHERE kind LIKE ?", (f"{kind_prefix}%",)).fetchall()
        else:
            rows = conn.execute("SELECT kind, id, vector, dim FROM embeddings").fetchall()
    except Exception:
        rows = []
    finally:
        conn.close()

    output: list[tuple[str, str, "np.ndarray"]] = []
    for kind, item_id, blob, dim in rows:
        try:
            vec = np.frombuffer(blob, dtype=np.float32, count=int(dim))
            if vec.size == 0:
                continue
            output.append((str(kind), str(item_id), vec))
        except Exception:
            continue
    return output


def _vector_topk(query_vec, *, kind_exact: str | None = None, kind_prefix: str | None = None, limit: int = 120) -> dict[str, float]:
    if np is None or query_vec is None:
        return {}
    q_norm = float(np.linalg.norm(query_vec))
    if q_norm == 0.0:
        return {}
    ranked: list[tuple[str, float]] = []
    for _, item_id, vec in _load_vectors(kind_exact=kind_exact, kind_prefix=kind_prefix):
        v_norm = float(np.linalg.norm(vec))
        if v_norm == 0.0:
            continue
        score = float(np.dot(query_vec, vec) / (q_norm * v_norm))
        ranked.append((item_id, score))
    ranked.sort(key=lambda item: item[1], reverse=True)
    best: dict[str, float] = {}
    for item_id, score in ranked[: max(limit * 2, 40)]:
        best[item_id] = max(best.get(item_id, 0.0), score)
    return dict(sorted(best.items(), key=lambda item: item[1], reverse=True)[:limit])


def _clip(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def _log_text(log: dict) -> str:
    summary = _normalize_text(str(log.get("summary") or ""))
    content = _normalize_text(str(log.get("content") or ""))
    raw = _normalize_text(str(log.get("raw") or ""))
    return _clip(" ".join(part for part in [summary, content, raw] if part), 1200)


def semantic_search(
    query: str,
    topics: Iterable[dict],
    tasks: Iterable[dict],
    logs: Iterable[dict],
    *,
    topic_limit: int = 24,
    task_limit: int = 48,
    log_limit: int = 360,
):
    q = _normalize_text(query)
    if len(q) < 2:
        return {
            "query": q,
            "mode": "empty",
            "topics": [],
            "tasks": [],
            "logs": [],
        }

    query_vec = _embed_query(q)
    topic_vec = _vector_topk(query_vec, kind_exact="topic", limit=max(topic_limit * 4, 40))
    task_vec = _vector_topk(query_vec, kind_prefix="task:", limit=max(task_limit * 4, 80))
    log_vec = _vector_topk(query_vec, kind_exact="log", limit=max(log_limit * 2, 120))

    topic_ranked: list[dict] = []
    for topic in topics:
        topic_id = str(topic.get("id") or "")
        if not topic_id:
            continue
        lex = lexical_similarity(q, _normalize_text(f"{topic.get('name') or ''} {topic.get('description') or ''}"))
        vec = float(topic_vec.get(topic_id, 0.0))
        hybrid = max(vec * 0.7 + lex * 0.3, lex * 0.68)
        if hybrid < 0.08:
            continue
        topic_ranked.append(
            {
                "id": topic_id,
                "score": round(hybrid, 6),
                "vectorScore": round(vec, 6),
                "lexicalScore": round(lex, 6),
            }
        )
    topic_ranked.sort(key=lambda item: item["score"], reverse=True)
    topic_ranked = topic_ranked[:topic_limit]
    topic_ids = {item["id"] for item in topic_ranked}

    task_ranked: list[dict] = []
    for task in tasks:
        task_id = str(task.get("id") or "")
        if not task_id:
            continue
        text = _normalize_text(f"{task.get('title') or ''} {task.get('status') or ''}")
        lex = lexical_similarity(q, text)
        vec = float(task_vec.get(task_id, 0.0))
        parent_boost = 0.06 if str(task.get("topicId") or "") in topic_ids else 0.0
        hybrid = max(vec * 0.72 + lex * 0.28 + parent_boost, lex * 0.68 + parent_boost)
        if hybrid < 0.08:
            continue
        task_ranked.append(
            {
                "id": task_id,
                "topicId": task.get("topicId"),
                "score": round(hybrid, 6),
                "vectorScore": round(vec, 6),
                "lexicalScore": round(lex, 6),
            }
        )
    task_ranked.sort(key=lambda item: item["score"], reverse=True)
    task_ranked = task_ranked[:task_limit]
    task_ids = {item["id"] for item in task_ranked}

    log_ranked: list[dict] = []
    for log in logs:
        log_id = str(log.get("id") or "")
        if not log_id:
            continue
        lex = lexical_similarity(q, _log_text(log))
        vec = float(log_vec.get(log_id, 0.0))
        parent_boost = 0.0
        topic_id = str(log.get("topicId") or "")
        task_id = str(log.get("taskId") or "")
        if topic_id and topic_id in topic_ids:
            parent_boost += 0.04
        if task_id and task_id in task_ids:
            parent_boost += 0.04
        hybrid = max(vec * 0.72 + lex * 0.28 + parent_boost, lex * 0.68 + parent_boost)
        if hybrid < 0.06:
            continue
        log_ranked.append(
            {
                "id": log_id,
                "topicId": log.get("topicId"),
                "taskId": log.get("taskId"),
                "score": round(hybrid, 6),
                "vectorScore": round(vec, 6),
                "lexicalScore": round(lex, 6),
            }
        )
    log_ranked.sort(key=lambda item: item["score"], reverse=True)
    log_ranked = log_ranked[:log_limit]

    mode = "vector+lexical" if query_vec is not None else "lexical"
    return {
        "query": q,
        "mode": mode,
        "topics": topic_ranked,
        "tasks": task_ranked,
        "logs": log_ranked,
    }
