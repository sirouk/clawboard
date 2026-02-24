from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from urllib import error as url_error
from urllib import request as url_request


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return bool(default)
    text = str(raw or "").strip().lower()
    if not text:
        return bool(default)
    return text in {"1", "true", "yes", "on"}


# Keep vector cleanup behavior deterministic by default. This should only be enabled
# explicitly for cleanup jobs, independent from runtime search knobs.
SEARCH_INCLUDE_TOOL_CALL_LOGS = _env_flag("CLAWBOARD_VECTOR_INCLUDE_TOOL_CALL_LOGS", False)

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


def resolve_clawboard_db_path(db_url: str | None = None, fallback: str = "./data/clawboard.db") -> str:
    raw = (db_url or os.getenv("CLAWBOARD_DB_URL") or "").strip()
    if raw.startswith("sqlite:///"):
        return os.path.abspath(raw[len("sqlite:///") :])
    if raw.startswith("sqlite://"):
        return os.path.abspath(raw[len("sqlite://") :])
    if raw:
        return os.path.abspath(raw)
    return os.path.abspath(fallback)


def resolve_embeddings_db_path(fallback: str = "./data/classifier_embeddings.db") -> str:
    raw = (
        os.getenv("CLASSIFIER_EMBED_DB")
        or os.getenv("CLAWBOARD_VECTOR_DB_PATH")
        or os.getenv("EMBED_DB_PATH")
        or fallback
    )
    return os.path.abspath(raw)


def resolve_reindex_queue_path(fallback: str = "./data/reindex-queue.jsonl") -> str:
    raw = os.getenv("CLAWBOARD_REINDEX_QUEUE_PATH") or os.getenv("CLASSIFIER_REINDEX_QUEUE_PATH") or fallback
    return os.path.abspath(raw)


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (table_name,),
    ).fetchone()
    return bool(row)


def _sanitize_log_text(value: str | None) -> str:
    if not value:
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"^\s*summary\s*[:\-]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"^\[Discord [^\]]+\]\s*", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"\[message[_\s-]?id:[^\]]+\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _clip(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def _is_memory_action_log(log_type: str, summary: str, content: str, raw: str) -> bool:
    if log_type != "action":
        return False
    combined = " ".join(part for part in [summary, content, raw] if part).lower()
    if "tool call:" in combined or "tool result:" in combined or "tool error:" in combined:
        if re.search(r"\bmemory[_-]?(search|get|query|fetch|retrieve|read|write|store|list|prune|delete)\b", combined):
            return True
    return False


def _is_tool_call_log(log_type: str, summary: str, content: str, raw: str) -> bool:
    if log_type != "action":
        return False
    combined = " ".join(part for part in [summary, content, raw] if part).lower()
    return "tool call:" in combined or "tool result:" in combined or "tool error:" in combined


def _is_command_conversation(log_type: str, summary: str, content: str, raw: str) -> bool:
    if log_type != "conversation":
        return False
    text = _sanitize_log_text(content or summary or raw)
    if not text.startswith("/"):
        return False
    command = text.split(None, 1)[0].lower()
    if command in SLASH_COMMANDS:
        return True
    return bool(re.fullmatch(r"/[a-z0-9_-]{2,}", command))


def _log_embedding_text(log_type: str, summary: str, content: str, raw: str) -> str:
    if log_type in ("system", "import"):
        return ""
    if not SEARCH_INCLUDE_TOOL_CALL_LOGS and _is_tool_call_log(log_type, summary, content, raw):
        return ""
    if _is_memory_action_log(log_type, summary, content, raw):
        return ""
    if _is_command_conversation(log_type, summary, content, raw):
        return ""
    parts = [
        _sanitize_log_text(summary),
        _sanitize_log_text(content),
        _sanitize_log_text(raw),
    ]
    text = " ".join(part for part in parts if part)
    return _clip(text, 1200)


def _load_desired_embeddings(clawboard_db_path: str) -> dict[tuple[str, str], dict]:
    desired: dict[tuple[str, str], dict] = {}
    if not os.path.exists(clawboard_db_path):
        return desired

    conn = sqlite3.connect(clawboard_db_path)
    conn.row_factory = sqlite3.Row
    try:
        if _table_exists(conn, "topic"):
            rows = conn.execute("SELECT id, name FROM topic").fetchall()
            for row in rows:
                item_id = str(row["id"] or "").strip()
                text = str(row["name"] or "").strip()
                if not item_id or not text:
                    continue
                desired[("topic", item_id)] = {
                    "op": "upsert",
                    "kind": "topic",
                    "id": item_id,
                    "text": text,
                }

        if _table_exists(conn, "task"):
            rows = conn.execute("SELECT id, topicId, title FROM task").fetchall()
            for row in rows:
                item_id = str(row["id"] or "").strip()
                topic_id = str(row["topicId"] or "").strip()
                title = str(row["title"] or "").strip()
                if not item_id or not title:
                    continue
                namespace = f"task:{topic_id or 'unassigned'}"
                desired[(namespace, item_id)] = {
                    "op": "upsert",
                    "kind": "task",
                    "id": item_id,
                    "topicId": topic_id or None,
                    "text": title,
                }

        if _table_exists(conn, "logentry"):
            rows = conn.execute("SELECT id, topicId, type, summary, content, raw FROM logentry").fetchall()
            for row in rows:
                item_id = str(row["id"] or "").strip()
                topic_id = str(row["topicId"] or "").strip()
                log_type = str(row["type"] or "").strip()
                summary = str(row["summary"] or "")
                content = str(row["content"] or "")
                raw = str(row["raw"] or "")
                if not item_id:
                    continue
                text = _log_embedding_text(log_type, summary, content, raw)
                if not text:
                    continue
                desired[("log", item_id)] = {
                    "op": "upsert",
                    "kind": "log",
                    "id": item_id,
                    "topicId": topic_id or None,
                    "text": text,
                }
    finally:
        conn.close()

    return desired


def _load_existing_embedding_keys(embeddings_db_path: str) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    if not os.path.exists(embeddings_db_path):
        return out
    conn = sqlite3.connect(embeddings_db_path)
    try:
        if not _table_exists(conn, "embeddings"):
            return out
        rows = conn.execute("SELECT kind, id FROM embeddings").fetchall()
    finally:
        conn.close()
    for kind, item_id in rows:
        out.add((str(kind or "").strip(), str(item_id or "").strip()))
    return out


def _is_managed_kind(kind: str) -> bool:
    return kind == "topic" or kind == "log" or kind.startswith("task:")


def _delete_request_for_key(kind: str, item_id: str) -> dict:
    if kind.startswith("task:"):
        payload = {"op": "delete", "kind": "task", "id": item_id}
        task_topic = kind.split(":", 1)[1] if ":" in kind else ""
        if task_topic:
            payload["topicId"] = task_topic
        return payload
    if kind == "topic":
        return {"op": "delete", "kind": "topic", "id": item_id}
    return {"op": "delete", "kind": "log", "id": item_id}


def build_cleanup_plan(clawboard_db_path: str, embeddings_db_path: str) -> dict:
    desired = _load_desired_embeddings(clawboard_db_path)
    desired_keys = set(desired.keys())

    existing = _load_existing_embedding_keys(embeddings_db_path)
    managed_existing = {key for key in existing if _is_managed_kind(key[0])}

    delete_pairs = sorted(managed_existing - desired_keys, key=lambda item: (item[0], item[1]))
    missing_pairs = sorted(desired_keys - managed_existing, key=lambda item: (item[0], item[1]))

    delete_requests = [_delete_request_for_key(kind, item_id) for kind, item_id in delete_pairs]
    upsert_requests = [desired[key] for key in missing_pairs]

    return {
        "desiredCount": len(desired_keys),
        "managedExistingCount": len(managed_existing),
        "deletePairs": delete_pairs,
        "missingPairs": missing_pairs,
        "deleteRequests": delete_requests,
        "upsertRequests": upsert_requests,
    }


def _delete_pairs_from_sqlite(embeddings_db_path: str, delete_pairs: list[tuple[str, str]]) -> int:
    if not delete_pairs or not os.path.exists(embeddings_db_path):
        return 0
    conn = sqlite3.connect(embeddings_db_path)
    deleted = 0
    try:
        if not _table_exists(conn, "embeddings"):
            return 0
        for kind, item_id in delete_pairs:
            cursor = conn.execute(
                "DELETE FROM embeddings WHERE kind=? AND id=?",
                (kind, item_id),
            )
            deleted += int(cursor.rowcount or 0)
        conn.commit()
    finally:
        conn.close()
    return deleted


def _enqueue_requests(queue_path: str, requests: list[dict]) -> int:
    if not requests:
        return 0
    queue_path = os.path.abspath(queue_path)
    queue_dir = os.path.dirname(queue_path)
    if queue_dir:
        os.makedirs(queue_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat()
    with open(queue_path, "a", encoding="utf-8") as f:
        for payload in requests:
            f.write(json.dumps({**payload, "requestedAt": ts}) + "\n")
    return len(requests)


def _qdrant_point_id(kind: str, item_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"clawboard:{kind}:{item_id}"))


def _delete_pairs_from_qdrant(
    qdrant_url: str,
    qdrant_collection: str,
    qdrant_api_key: str | None,
    timeout_sec: float,
    delete_pairs: list[tuple[str, str]],
) -> tuple[int, int]:
    if not qdrant_url or not delete_pairs:
        return (0, 0)

    point_ids = [_qdrant_point_id(kind, item_id) for kind, item_id in delete_pairs]
    if not point_ids:
        return (0, 0)

    headers = {"Content-Type": "application/json"}
    if qdrant_api_key:
        headers["api-key"] = qdrant_api_key

    attempted = 0
    failed = 0
    endpoint = f"{qdrant_url.rstrip('/')}/collections/{qdrant_collection}/points/delete"
    batch_size = 256
    for idx in range(0, len(point_ids), batch_size):
        batch = point_ids[idx : idx + batch_size]
        attempted += len(batch)
        body = json.dumps({"points": batch}).encode("utf-8")
        req = url_request.Request(endpoint, method="POST", data=body, headers=headers)
        try:
            with url_request.urlopen(req, timeout=timeout_sec):
                pass
        except (url_error.URLError, TimeoutError, Exception):
            failed += len(batch)
    return (attempted, failed)


def run_one_time_vector_cleanup(
    clawboard_db_path: str,
    embeddings_db_path: str,
    queue_path: str,
    *,
    qdrant_url: str | None = None,
    qdrant_collection: str = "clawboard_embeddings",
    qdrant_api_key: str | None = None,
    qdrant_timeout_sec: float = 5.0,
    dry_run: bool = False,
) -> dict:
    plan = build_cleanup_plan(clawboard_db_path, embeddings_db_path)
    delete_pairs = list(plan["deletePairs"])
    delete_requests = list(plan["deleteRequests"])
    upsert_requests = list(plan["upsertRequests"])
    queue_requests = delete_requests + upsert_requests

    report = {
        "dryRun": bool(dry_run),
        "clawboardDbPath": os.path.abspath(clawboard_db_path),
        "embeddingsDbPath": os.path.abspath(embeddings_db_path),
        "queuePath": os.path.abspath(queue_path),
        "desiredEmbeddings": int(plan["desiredCount"]),
        "managedExistingEmbeddings": int(plan["managedExistingCount"]),
        "deleteCount": len(delete_pairs),
        "missingCount": len(upsert_requests),
        "deleteQueueCount": len(delete_requests),
        "upsertQueueCount": len(upsert_requests),
        "sqliteDeleted": 0,
        "queueEnqueued": 0,
        "qdrantDeleteAttempted": 0,
        "qdrantDeleteFailed": 0,
    }

    if dry_run:
        return report

    report["sqliteDeleted"] = _delete_pairs_from_sqlite(embeddings_db_path, delete_pairs)
    report["queueEnqueued"] = _enqueue_requests(queue_path, queue_requests)

    qdrant_attempted, qdrant_failed = _delete_pairs_from_qdrant(
        qdrant_url=qdrant_url or "",
        qdrant_collection=qdrant_collection,
        qdrant_api_key=qdrant_api_key,
        timeout_sec=qdrant_timeout_sec,
        delete_pairs=delete_pairs,
    )
    report["qdrantDeleteAttempted"] = qdrant_attempted
    report["qdrantDeleteFailed"] = qdrant_failed
    return report
