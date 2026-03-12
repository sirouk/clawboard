from __future__ import annotations

import colorsys
import hashlib
import os
import re
from difflib import SequenceMatcher
from typing import Any

from sqlmodel import select

from .models import SessionRoutingMemory, Task, Topic
from .spaces import _normalize_space_id, _space_id_for_task, _space_id_for_topic
from .text_processing import _clip, _normalize_label, _sanitize_log_text

__all__ = [
    "_normalize_hex_color",
    "_auto_pick_color",
    "_label_similarity",
    "_find_similar_topic",
    "_find_similar_task",
    "_RESOLVER_NAME_STOPWORDS",
    "_resolver_float_env",
    "_resolver_topic_similarity_threshold",
    "_resolver_task_similarity_threshold",
    "_resolver_semantic_topic_score_threshold",
    "_resolver_semantic_task_score_threshold",
    "_resolver_fallback_mode",
    "_resolver_clean_name",
    "_resolver_title_case_token",
    "_resolver_terms_from_message",
    "_resolver_derive_topic_name",
    "_resolver_derive_task_title",
    "_resolver_pick_semantic_topic_id",
    "_resolver_pick_semantic_task",
    "_resolver_recent_routing_hints",
    "_next_sort_index_for_new_topic",
    "_next_sort_index_for_new_task",
]


def _normalize_hex_color(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return text.upper()
    return None


def _auto_pick_color(seed: str, used: set[str], offset: float = 0.0) -> str:
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    base_hue = ((int(digest[:8], 16) % 360) + offset) % 360
    sat = 0.62 + (int(digest[8:12], 16) % 13) / 100.0
    lig = 0.50 + (int(digest[12:16], 16) % 11) / 100.0
    for step in range(24):
        hue = (base_hue + (step * 29.0)) % 360
        r, g, b = colorsys.hls_to_rgb(hue / 360.0, min(0.66, lig), min(0.80, sat))
        color = f"#{int(r * 255):02X}{int(g * 255):02X}{int(b * 255):02X}"
        if color not in used:
            return color
    return color


def _label_similarity(a: str | None, b: str | None) -> float:
    na = _normalize_label(a)
    nb = _normalize_label(b)
    if not na or not nb:
        return 0.0
    seq = SequenceMatcher(None, na, nb).ratio()
    ta = {part for part in na.split(" ") if len(part) > 2}
    tb = {part for part in nb.split(" ") if len(part) > 2}
    token = len(ta & tb) / len(ta | tb) if (ta or tb) else 0.0
    return (seq * 0.72) + (token * 0.28)


def _find_similar_topic(session, name: str, threshold: float = 0.80, space_id: str | None = None):
    if not name.strip():
        return None
    topics = session.exec(select(Topic)).all()
    normalized_space_id = _normalize_space_id(space_id)
    if normalized_space_id:
        topics = [topic for topic in topics if _space_id_for_topic(topic) == normalized_space_id]
    best = None
    best_score = 0.0
    for topic in topics:
        score = _label_similarity(topic.name, name)
        if score > best_score:
            best_score = score
            best = topic
    if best and best_score >= threshold:
        return best
    return None


def _find_similar_task(
    session,
    topic_id: str | None,
    title: str,
    threshold: float = 0.88,
    space_id: str | None = None,
):
    if not title.strip():
        return None
    tasks = session.exec(select(Task)).all()
    normalized_space_id = _normalize_space_id(space_id)
    if topic_id is not None:
        tasks = [task for task in tasks if task.topicId == topic_id]
    else:
        tasks = [task for task in tasks if task.topicId is None]
        if normalized_space_id:
            tasks = [task for task in tasks if _space_id_for_task(task) == normalized_space_id]
    best = None
    best_score = 0.0
    for task in tasks:
        score = _label_similarity(task.title, title)
        if score > best_score:
            best_score = score
            best = task
    if best and best_score >= threshold:
        return best
    return None


_RESOLVER_NAME_STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "help",
    "i",
    "in",
    "into",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "please",
    "the",
    "to",
    "with",
}


def _resolver_float_env(name: str, fallback: float, minimum: float, maximum: float) -> float:
    raw = str(os.getenv(name) or "").strip()
    value = fallback
    if raw:
        try:
            value = float(raw)
        except Exception:
            value = fallback
    return max(minimum, min(maximum, value))


def _resolver_topic_similarity_threshold() -> float:
    return _resolver_float_env("CLAWBOARD_RESOLVER_TOPIC_SIM_THRESHOLD", 0.80, 0.40, 0.98)


def _resolver_task_similarity_threshold() -> float:
    return _resolver_float_env("CLAWBOARD_RESOLVER_TASK_SIM_THRESHOLD", 0.88, 0.45, 0.99)


def _resolver_semantic_topic_score_threshold() -> float:
    return _resolver_float_env("CLAWBOARD_RESOLVER_SEMANTIC_TOPIC_THRESHOLD", 0.78, 0.35, 0.98)


def _resolver_semantic_task_score_threshold() -> float:
    return _resolver_float_env("CLAWBOARD_RESOLVER_SEMANTIC_TASK_THRESHOLD", 0.80, 0.35, 0.99)


def _resolver_fallback_mode() -> str:
    raw = str(os.getenv("CLAWBOARD_RESOLVER_FALLBACK_MODE") or "deterministic").strip().lower()
    if raw in {"deterministic", "strict"}:
        return raw
    return "deterministic"


def _resolver_clean_name(value: str | None, *, fallback: str, max_chars: int = 72) -> str:
    text = _sanitize_log_text(value or "")
    if not text:
        return fallback
    text = re.sub(r"[\s\-–—_:;|]+", " ", text).strip()
    if not text:
        return fallback
    if len(text) <= max_chars:
        return text
    return _clip(text, max_chars)


def _resolver_title_case_token(token: str, force_capitalize: bool) -> str:
    raw = str(token or "").strip()
    if not raw:
        return ""
    if re.fullmatch(r"[A-Z0-9]{2,}", raw):
        return raw
    lower = raw.lower()
    if not force_capitalize and lower in _RESOLVER_NAME_STOPWORDS:
        return lower
    return lower[:1].upper() + lower[1:]


def _resolver_terms_from_message(message: str, *, limit: int = 10) -> list[str]:
    cleaned = _sanitize_log_text(message)
    if not cleaned:
        return []
    sentence = cleaned.split("\n", 1)[0]
    sentence = re.split(r"[.!?]", sentence, 1)[0]
    sentence = re.sub(r"^[\-*#>\d.()\[\]\s]+", "", sentence).strip()
    if not sentence:
        sentence = cleaned
    tokens = [
        re.sub(r"^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$", "", part).strip()
        for part in sentence.split(" ")
    ]
    out: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        if not token:
            continue
        key = token.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(token)
        if len(out) >= limit:
            break
    return out


def _resolver_derive_topic_name(message: str, *, context_payload: dict[str, Any] | None = None) -> str:
    semantic = ((context_payload or {}).get("data") or {}).get("semantic") if isinstance((context_payload or {}).get("data"), dict) else None
    if isinstance(semantic, dict):
        topics = semantic.get("topics")
        if isinstance(topics, list):
            top = topics[0] if topics else None
            if isinstance(top, dict):
                top_name = _resolver_clean_name(str(top.get("name") or "").strip(), fallback="", max_chars=72)
                top_score = float(top.get("score") or 0.0) if top.get("score") is not None else 0.0
                if top_name and top_score >= _resolver_semantic_topic_score_threshold():
                    return top_name

    terms = _resolver_terms_from_message(message, limit=10)
    if not terms:
        return "Untitled Topic"
    keyword_terms = [term for term in terms if term.lower() not in _RESOLVER_NAME_STOPWORDS]
    chosen = (keyword_terms or terms)[:6]
    titled = " ".join(
        _resolver_title_case_token(token, idx == 0 or idx == len(chosen) - 1)
        for idx, token in enumerate(chosen)
    ).strip()
    return _resolver_clean_name(titled, fallback="Untitled Topic", max_chars=72)


def _resolver_derive_task_title(message: str, *, context_payload: dict[str, Any] | None = None) -> str:
    semantic = ((context_payload or {}).get("data") or {}).get("semantic") if isinstance((context_payload or {}).get("data"), dict) else None
    if isinstance(semantic, dict):
        tasks = semantic.get("tasks")
        if isinstance(tasks, list):
            top = tasks[0] if tasks else None
            if isinstance(top, dict):
                top_title = _resolver_clean_name(str(top.get("title") or "").strip(), fallback="", max_chars=84)
                top_score = float(top.get("score") or 0.0) if top.get("score") is not None else 0.0
                if top_title and top_score >= _resolver_semantic_task_score_threshold():
                    return top_title

    terms = _resolver_terms_from_message(message, limit=12)
    if not terms:
        return "New Task"
    keyword_terms = [term for term in terms if term.lower() not in _RESOLVER_NAME_STOPWORDS]
    chosen = (keyword_terms or terms)[:8]
    titled = " ".join(
        _resolver_title_case_token(token, idx == 0 or idx == len(chosen) - 1)
        for idx, token in enumerate(chosen)
    ).strip()
    return _resolver_clean_name(titled, fallback="New Task", max_chars=84)


def _resolver_pick_semantic_topic_id(
    session: Any,
    *,
    context_payload: dict[str, Any] | None,
    source_space_id: str | None,
) -> str | None:
    data = (context_payload or {}).get("data")
    if not isinstance(data, dict):
        return None
    semantic = data.get("semantic")
    if not isinstance(semantic, dict):
        return None
    topics = semantic.get("topics")
    if not isinstance(topics, list):
        return None
    threshold = _resolver_semantic_topic_score_threshold()
    for row in topics:
        if not isinstance(row, dict):
            continue
        candidate_id = str(row.get("id") or "").strip()
        if not candidate_id:
            continue
        score = float(row.get("score") or 0.0) if row.get("score") is not None else 0.0
        if score < threshold:
            continue
        topic = session.get(Topic, candidate_id)
        if not topic:
            continue
        if source_space_id and _space_id_for_topic(topic) != source_space_id:
            continue
        return topic.id
    return None


def _resolver_pick_semantic_task(
    session: Any,
    *,
    topic_id: str,
    context_payload: dict[str, Any] | None,
) -> Task | None:
    data = (context_payload or {}).get("data")
    if not isinstance(data, dict):
        return None
    semantic = data.get("semantic")
    if not isinstance(semantic, dict):
        return None
    tasks = semantic.get("tasks")
    if not isinstance(tasks, list):
        return None
    threshold = _resolver_semantic_task_score_threshold()
    for row in tasks:
        if not isinstance(row, dict):
            continue
        candidate_id = str(row.get("id") or "").strip()
        if not candidate_id:
            continue
        score = float(row.get("score") or 0.0) if row.get("score") is not None else 0.0
        if score < threshold:
            continue
        task = session.get(Task, candidate_id)
        if not task:
            continue
        if str(getattr(task, "topicId", "") or "").strip() != topic_id:
            continue
        return task
    return None


def _resolver_recent_routing_hints(
    session: Any,
    *,
    selected_topic_id: str | None,
    selected_task_id: str | None,
    limit: int = 16,
) -> list[dict[str, Any]]:
    rows = session.exec(
        select(SessionRoutingMemory).order_by(SessionRoutingMemory.updatedAt.desc()).limit(64)
    ).all()
    out: list[dict[str, Any]] = []
    for row in rows:
        items = list(getattr(row, "items", None) or [])
        for item in reversed(items):
            if not isinstance(item, dict):
                continue
            topic_id = str(item.get("topicId") or "").strip()
            task_id = str(item.get("taskId") or "").strip()
            if selected_topic_id and topic_id and topic_id != selected_topic_id:
                continue
            if selected_task_id and task_id and task_id != selected_task_id:
                continue
            out.append(
                {
                    "ts": str(item.get("ts") or "").strip(),
                    "topicId": topic_id or None,
                    "topicName": str(item.get("topicName") or "").strip() or None,
                    "taskId": task_id or None,
                    "taskTitle": str(item.get("taskTitle") or "").strip() or None,
                    "anchor": _clip(_sanitize_log_text(str(item.get("anchor") or "")), 220) or None,
                }
            )
            if len(out) >= max(1, limit):
                return out
    return out


def _next_sort_index_for_new_topic(session, pinned: bool) -> int:
    """Return a sortIndex that places new topics at the top of their pinned group."""
    topics = session.exec(select(Topic)).all()
    indices = [int(getattr(topic, "sortIndex", 0)) for topic in topics if bool(getattr(topic, "pinned", False)) == pinned]
    if not indices:
        return 0
    return min(indices) - 1


def _next_sort_index_for_new_task(session, topic_id: str | None, pinned: bool) -> int:
    """Return a sortIndex that places new tasks at the top of their pinned group within the topic."""
    tasks = session.exec(select(Task)).all()
    scoped = [task for task in tasks if task.topicId == topic_id]
    indices = [int(getattr(task, "sortIndex", 0)) for task in scoped if bool(getattr(task, "pinned", False)) == pinned]
    if not indices:
        return 0
    return min(indices) - 1
