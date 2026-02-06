import json
import os
import re
import sqlite3
import time
import requests

from fastembed import TextEmbedding

from embeddings_store import topk as embed_topk, upsert as embed_upsert

CLAWBOARD_API_BASE = os.environ.get("CLAWBOARD_API_BASE", "http://localhost:8010").rstrip("/")
CLAWBOARD_TOKEN = os.environ.get("CLAWBOARD_TOKEN")

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "http://127.0.0.1:18789").rstrip("/")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN")
OPENCLAW_MODEL = os.environ.get("OPENCLAW_MODEL", "openai-codex/gpt-5.2")

INTERVAL = int(os.environ.get("CLASSIFIER_INTERVAL_SECONDS", "10"))
MAX_ATTEMPTS = int(os.environ.get("CLASSIFIER_MAX_ATTEMPTS", "3"))

WINDOW_SIZE = int(os.environ.get("CLASSIFIER_WINDOW_SIZE", "24"))
LOOKBACK_LOGS = int(os.environ.get("CLASSIFIER_LOOKBACK_LOGS", "80"))
TOPIC_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TOPIC_SIM_THRESHOLD", "0.78"))
TASK_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TASK_SIM_THRESHOLD", "0.80"))
EMBED_MODEL = os.environ.get("CLASSIFIER_EMBED_MODEL", "BAAI/bge-small-en-v1.5")

LOCK_PATH = os.environ.get("CLASSIFIER_LOCK_PATH", "/data/classifier.lock")

OPENCLAW_MEMORY_DB_PATH = os.environ.get("OPENCLAW_MEMORY_DB_PATH")
OPENCLAW_MEMORY_DB_FALLBACK = os.environ.get("OPENCLAW_MEMORY_DB_FALLBACK", "/data/openclaw-memory/main.sqlite")
OPENCLAW_MEMORY_MAX_HITS = int(os.environ.get("OPENCLAW_MEMORY_MAX_HITS", "6"))

_embedder = None


def headers_clawboard():
    h = {"Content-Type": "application/json"}
    if CLAWBOARD_TOKEN:
        h["X-Clawboard-Token"] = CLAWBOARD_TOKEN
    return h


def oc_headers():
    if not OPENCLAW_GATEWAY_TOKEN:
        raise RuntimeError("OPENCLAW_GATEWAY_TOKEN is required")
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
    }


def embedder():
    global _embedder
    if _embedder is None:
        _embedder = TextEmbedding(model_name=EMBED_MODEL)
    return _embedder


def embed_text(text: str):
    vec = next(embedder().embed([text]))
    return vec


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
    markers = ["\"window\"", "\"candidateTopics\"", "\"topic\"", "\"task\"", "\"instructions\""]
    return any(m in t for m in markers)


def _is_context_log(entry: dict) -> bool:
    if entry.get("type") not in ("conversation", "note"):
        return False
    if _is_classifier_payload(_log_text(entry)):
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


def list_logs(params: dict):
    r = requests.get(f"{CLAWBOARD_API_BASE}/api/log", params=params, timeout=15)
    r.raise_for_status()
    return r.json()


def list_pending_conversations(limit=500, offset=0):
    # Only classify user/assistant conversations from real message threads.
    # Skip classifier/agent internal convo-like logs that can be present.
    return list_logs(
        {
            "classificationStatus": "pending",
            "type": "conversation",
            "limit": limit,
            "offset": offset,
        }
    )


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
    r = requests.get(f"{CLAWBOARD_API_BASE}/api/topics", timeout=15)
    r.raise_for_status()
    return r.json()


def list_tasks(topic_id: str):
    r = requests.get(f"{CLAWBOARD_API_BASE}/api/tasks", params={"topicId": topic_id}, timeout=15)
    r.raise_for_status()
    return r.json()


def upsert_topic(topic_id: str | None, name: str):
    payload = {"name": name, "tags": ["classified"]}
    if topic_id:
        payload["id"] = topic_id
    r = requests.post(
        f"{CLAWBOARD_API_BASE}/api/topics",
        headers=headers_clawboard(),
        data=json.dumps(payload),
        timeout=15,
    )
    r.raise_for_status()
    topic = r.json()
    try:
        embed_upsert("topic", topic["id"], embed_text(topic.get("name") or topic["id"]))
    except Exception:
        pass
    return topic


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
        embed_upsert(f"task:{task['topicId']}", task["id"], embed_text(task.get("title") or task["id"]))
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
    try:
        for t in list_topics():
            if not t.get("id"):
                continue
            name = t.get("name") or t["id"]
            embed_upsert("topic", t["id"], embed_text(name))
    except Exception:
        pass


def ensure_task_index_seeded(topic_id: str):
    try:
        for t in list_tasks(topic_id):
            if not t.get("id"):
                continue
            title = t.get("title") or t["id"]
            embed_upsert(f"task:{topic_id}", t["id"], embed_text(title))
    except Exception:
        pass


def topic_candidates(query_text: str, k: int = 6):
    q = embed_text(query_text)
    scored = embed_topk("topic", q, k=k)
    if not scored:
        return []
    topics = {t["id"]: t for t in list_topics()}
    out = []
    for topic_id, score in scored:
        t = topics.get(topic_id)
        if not t:
            continue
        out.append({"id": t["id"], "name": t["name"], "score": score})
    return out


def task_candidates(topic_id: str, query_text: str, k: int = 8):
    ensure_task_index_seeded(topic_id)
    q = embed_text(query_text)
    scored = embed_topk(f"task:{topic_id}", q, k=k)
    if not scored:
        return []
    tasks = {t["id"]: t for t in list_tasks(topic_id)}
    out = []
    for task_id, score in scored:
        t = tasks.get(task_id)
        if not t:
            continue
        out.append({"id": t["id"], "title": t["title"], "score": score})
    return out


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
            "summary": e.get("summary"),
            "content": (e.get("content") or "")[:400],
            "agentLabel": e.get("agentLabel") or e.get("agentId"),
        }
        notes = notes_index.get(e.get("id") or "", [])
        if notes:
            entry["notes"] = notes[:3]
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def window_text(window: list[dict], notes_index: dict[str, list[str]] | None = None) -> str:
    parts = []
    notes_index = notes_index or {}
    for e in window:
        who = e.get("agentLabel") or e.get("agentId") or "?"
        text = (e.get("content") or e.get("summary") or "").strip()
        if not text:
            continue
        line = f"{who}: {text}"
        notes = notes_index.get(e.get("id") or "", [])
        if notes:
            line += " | Notes: " + " ; ".join(notes[:3])
        parts.append(line)
    return "\n".join(parts)[-6000:]


def call_classifier(
    window: list[dict],
    candidate_topics: list[dict],
    candidate_tasks: list[dict],
    notes_index: dict[str, list[str]],
    topic_contexts: dict[str, list[dict]],
    task_contexts: dict[str, list[dict]],
    memory_hits: list[dict],
):
    prompt = {
        "window": [
            {
                "id": e.get("id"),
                "createdAt": e.get("createdAt"),
                "agentLabel": e.get("agentLabel"),
                "summary": e.get("summary"),
                "content": (e.get("content") or "")[:800],
                "notes": notes_index.get(e.get("id") or "", [])[:3],
            }
            for e in window
        ],
        "candidateTopics": [
            {
                **t,
                "recent": topic_contexts.get(t.get("id") or "", [])[:6],
            }
            for t in candidate_topics
        ],
        "candidateTasks": [
            {
                **t,
                "recent": task_contexts.get(t.get("id") or "", [])[:6],
            }
            for t in candidate_tasks
        ],
        "memory": memory_hits,
        "instructions": (
            "Return STRICT JSON only with shape: "
            "{\"topic\": {\"id\": string|null, \"name\": string, \"create\": boolean}, "
            "\"task\": {\"id\": string|null, \"title\": string|null, \"create\": boolean}|null}. "
            "Rules: (1) Prefer existing topics/tasks when they clearly match; "
            "(2) Use notes/curation and memory snippets as high-signal context; "
            "(3) Only create when needed; (4) Topic/task names must be short and human; "
            "(5) If an action item exists, pick or create a task; "
            "(6) If in doubt, return task=null."
        ),
    }

    body = {
        "model": OPENCLAW_MODEL,
        "messages": [
            {"role": "system", "content": "You are a high-precision classifier for an ops dashboard. STRICT JSON only."},
            {"role": "user", "content": json.dumps(prompt)},
        ],
        "temperature": 0,
        "max_tokens": 600,
    }

    r = requests.post(
        f"{OPENCLAW_BASE_URL}/v1/chat/completions",
        headers=oc_headers(),
        data=json.dumps(body),
        timeout=75,
    )
    r.raise_for_status()
    data = r.json()
    text = data["choices"][0]["message"]["content"]
    return json.loads(text)


def classify_session(session_key: str):
    # Pull a lookback window of logs for context (conversation + actions).
    ctx_logs = list_logs_by_session(session_key, limit=LOOKBACK_LOGS, offset=0)
    ctx_logs = sorted(ctx_logs, key=lambda e: e.get("createdAt") or "")
    ctx_context = [e for e in ctx_logs if _is_context_log(e)]

    # Window focus: the most recent WINDOW_SIZE conversation items.
    conversations = [e for e in ctx_context if e.get("type") == "conversation"]
    if not conversations:
        # Still clean up classifier payload noise if present.
        for e in ctx_logs:
            if (e.get("classificationStatus") or "pending") != "pending":
                continue
            attempts = int(e.get("classificationAttempts") or 0)
            if attempts >= MAX_ATTEMPTS:
                continue
            if e.get("type") == "conversation" and _is_classifier_payload(_log_text(e)):
                patch_log(
                    e["id"],
                    {
                        "classificationStatus": "failed",
                        "classificationAttempts": attempts + 1,
                        "classificationError": "classifier_payload_noise",
                    },
                )
        return
    window = conversations[-WINDOW_SIZE:]

    # If there's nothing pending in the window, nothing to do.
    pending_ids = [e["id"] for e in window if (e.get("classificationStatus") or "pending") == "pending"]
    if not pending_ids:
        # Still clean up classifier payload noise if present.
        for e in ctx_logs:
            if (e.get("classificationStatus") or "pending") != "pending":
                continue
            attempts = int(e.get("classificationAttempts") or 0)
            if attempts >= MAX_ATTEMPTS:
                continue
            if e.get("type") == "conversation" and _is_classifier_payload(_log_text(e)):
                patch_log(
                    e["id"],
                    {
                        "classificationStatus": "failed",
                        "classificationAttempts": attempts + 1,
                        "classificationError": "classifier_payload_noise",
                    },
                )
        return

    # Skip if any are already max-attempts.
    for e in window:
        attempts = int(e.get("classificationAttempts") or 0)
        if (e.get("classificationStatus") or "pending") == "pending" and attempts >= MAX_ATTEMPTS:
            return

    notes_index = build_notes_index(ctx_context)
    text = window_text(window, notes_index)
    memory_hits = memory_snippets(text)

    ensure_topic_index_seeded()
    topic_cands = topic_candidates(text)

    # If we have a strong top topic, also propose task candidates for it.
    task_cands = []
    if topic_cands and topic_cands[0]["score"] >= TOPIC_SIM_THRESHOLD:
        task_cands = task_candidates(topic_cands[0]["id"], text)

    topic_contexts: dict[str, list[dict]] = {}
    for t in topic_cands:
        tid = t.get("id")
        if not tid:
            continue
        logs = list_logs_by_topic(tid, limit=10, offset=0)
        topic_notes = build_notes_index(logs)
        topic_contexts[tid] = summarize_logs(logs, topic_notes, limit=6)

    task_contexts: dict[str, list[dict]] = {}
    for t in task_cands:
        tid = t.get("id")
        if not tid:
            continue
        logs = list_logs_by_task(tid, limit=10, offset=0)
        task_notes = build_notes_index(logs)
        task_contexts[tid] = summarize_logs(logs, task_notes, limit=6)

    result = call_classifier(window, topic_cands, task_cands, notes_index, topic_contexts, task_contexts, memory_hits)

    chosen_topic_id = (result.get("topic") or {}).get("id")
    chosen_topic_name = (result.get("topic") or {}).get("name")
    create_topic = bool((result.get("topic") or {}).get("create"))

    # Guardrails: if vector search is confident, do not allow a duplicate topic.
    if topic_cands and topic_cands[0]["score"] >= TOPIC_SIM_THRESHOLD:
        chosen_topic_id = topic_cands[0]["id"]
        create_topic = False
        if not chosen_topic_name:
            chosen_topic_name = topic_cands[0]["name"]

    if not chosen_topic_name:
        chosen_topic_name = "General"

    topic = upsert_topic(chosen_topic_id if not create_topic else None, chosen_topic_name)
    topic_id = topic["id"]

    # Task selection/creation (within topic)
    task_id = None
    task_result = result.get("task")
    if isinstance(task_result, dict):
        task_title = task_result.get("title")
        create_task = bool(task_result.get("create"))
        proposed_task_id = task_result.get("id")

        ensure_task_index_seeded(topic_id)
        task_cands2 = task_candidates(topic_id, text)

        if task_cands2 and task_cands2[0]["score"] >= TASK_SIM_THRESHOLD:
            task_id = task_cands2[0]["id"]
        else:
            if proposed_task_id and not create_task:
                task_id = proposed_task_id
            elif create_task and task_title:
                task = upsert_task(None, topic_id, task_title)
                task_id = task["id"]

    # Patch all pending logs in this session lookback that are close in time.
    # For now: patch all pending logs in ctx_logs (conversation+action) to this topic.
    for e in ctx_logs:
        if (e.get("classificationStatus") or "pending") != "pending":
            continue
        attempts = int(e.get("classificationAttempts") or 0)
        if attempts >= MAX_ATTEMPTS:
            continue
        if e.get("type") == "conversation" and _is_classifier_payload(_log_text(e)):
            patch_log(
                e["id"],
                {
                    "classificationStatus": "failed",
                    "classificationAttempts": attempts + 1,
                    "classificationError": "classifier_payload_noise",
                },
            )
            continue
        patch_log(
            e["id"],
            {
                "topicId": topic_id,
                "taskId": task_id,
                "classificationStatus": "classified",
                "classificationAttempts": attempts + 1,
                "classificationError": None,
            },
        )


def main():
    while True:
        if not acquire_lock():
            time.sleep(INTERVAL)
            continue

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

            session_keys: list[str] = []
            seen = set()
            for e in pending:
                sk = ((e.get("source") or {}) or {}).get("sessionKey")
                if not sk:
                    continue
                # Only classify real channel threads for now.
                if not sk.startswith("channel:"):
                    continue
                if sk in seen:
                    continue
                seen.add(sk)
                session_keys.append(sk)

            session_keys = session_keys[:50]
            for sk in session_keys:
                try:
                    classify_session(sk)
                except Exception as e:
                    print(f"classifier: classify_session failed for {sk}: {e}")

        finally:
            release_lock()

        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
