import json
import os
import re
import sqlite3
import time
import shutil
from difflib import SequenceMatcher
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
MAX_SESSIONS_PER_CYCLE = int(os.environ.get("CLASSIFIER_MAX_SESSIONS_PER_CYCLE", "8"))

WINDOW_SIZE = int(os.environ.get("CLASSIFIER_WINDOW_SIZE", "24"))
LOOKBACK_LOGS = int(os.environ.get("CLASSIFIER_LOOKBACK_LOGS", "80"))
TOPIC_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TOPIC_SIM_THRESHOLD", "0.78"))
TASK_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TASK_SIM_THRESHOLD", "0.80"))
EMBED_MODEL = os.environ.get("CLASSIFIER_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
TOPIC_NAME_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TOPIC_NAME_SIM_THRESHOLD", "0.86"))
TASK_NAME_SIM_THRESHOLD = float(os.environ.get("CLASSIFIER_TASK_NAME_SIM_THRESHOLD", "0.88"))
SUMMARY_MAX = int(os.environ.get("CLASSIFIER_SUMMARY_MAX", "72"))

LOCK_PATH = os.environ.get("CLASSIFIER_LOCK_PATH", "/data/classifier.lock")
REINDEX_QUEUE_PATH = os.environ.get("CLASSIFIER_REINDEX_QUEUE_PATH", "/data/reindex-queue.jsonl")

OPENCLAW_MEMORY_DB_PATH = os.environ.get("OPENCLAW_MEMORY_DB_PATH")
OPENCLAW_MEMORY_DB_FALLBACK = os.environ.get("OPENCLAW_MEMORY_DB_FALLBACK", "/data/openclaw-memory/main.sqlite")
OPENCLAW_MEMORY_MAX_HITS = int(os.environ.get("OPENCLAW_MEMORY_MAX_HITS", "6"))

_embedder = None
_embed_failed = False


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
    global _embedder, _embed_failed
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
    emb = embedder()
    if emb is None:
        return None
    try:
        vec = next(emb.embed([text]))
        return vec
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


def _token_set(text: str) -> set[str]:
    stop_words = {
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
    return {w for w in _normalize_text(text).split(" ") if len(w) > 2 and w not in stop_words}


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


def _concise_summary(text: str) -> str:
    clean = _strip_transport_noise(text)
    clean = re.sub(r"\s+", " ", clean)
    clean = clean.strip("`* ")
    if len(clean) <= SUMMARY_MAX:
        return clean
    sentence = re.split(r"(?<=[.!?])\s+", clean)[0].strip()
    if sentence and len(sentence) <= SUMMARY_MAX:
        return sentence
    return f"{clean[: SUMMARY_MAX - 1].rstrip()}…"


def _looks_actionable(text: str) -> bool:
    t = _normalize_text(text)
    if not t:
        return False
    cues = [
        "todo",
        "to do",
        "next step",
        "action item",
        "follow up",
        "please",
        "need to",
        "should",
        "must",
        "fix",
        "build",
        "create",
        "implement",
        "update",
        "check",
        "review",
        "investigate",
        "test",
        "deploy",
        "refactor",
        "add",
        "remove",
        "restore",
        "restart",
        "audit",
    ]
    return any(cue in t for cue in cues)


def _latest_conversation_text(window: list[dict]) -> str:
    for item in reversed(window):
        if item.get("type") != "conversation":
            continue
        text = _strip_transport_noise(item.get("content") or item.get("summary") or item.get("raw") or "")
        if text:
            return text
    return ""


def _derive_topic_name(window: list[dict]) -> str:
    text = _latest_conversation_text(window)
    if not text:
        return "General"
    text = _strip_transport_noise(text)
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
    text = _latest_conversation_text(window)
    if not text:
        return None
    if not _looks_actionable(text):
        return None
    title = _concise_summary(text)
    if len(title) < 8:
        return None
    return title[:120]


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
        kind = str(item.get("kind") or "").strip().lower()
        item_id = str(item.get("id") or "").strip()
        topic_id = str(item.get("topicId") or "").strip()
        if not kind or not item_id:
            continue
        latest[(kind, item_id, topic_id)] = item

    for (kind, item_id, topic_id), item in latest.items():
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        vec = embed_text(text)
        if vec is None:
            continue
        try:
            if kind == "topic":
                embed_upsert("topic", item_id, vec)
            elif kind == "task":
                namespace = f"task:{topic_id or 'unassigned'}"
                embed_upsert(namespace, item_id, vec)
        except Exception as exc:
            print(f"classifier: reindex update failed for {kind}:{item_id}: {exc}")


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
    topics = list_topics()
    if not topics:
        return []

    vector_scores: dict[str, float] = {}
    q = embed_text(query_text)
    if q is not None:
        for topic_id, score in embed_topk("topic", q, k=max(k * 4, 20)):
            vector_scores[topic_id] = max(vector_scores.get(topic_id, 0.0), max(0.0, float(score)))

    out = []
    for topic in topics:
        tid = topic.get("id")
        name = topic.get("name") or ""
        if not tid or not name:
            continue
        lexical = _name_similarity(query_text, name)
        vector = vector_scores.get(tid, 0.0)
        hybrid = (vector * 0.72) + (lexical * 0.28)
        out.append(
            {
                "id": tid,
                "name": name,
                "score": hybrid,
                "vectorScore": vector,
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

    out = []
    for task in tasks:
        tid = task.get("id")
        title = task.get("title") or ""
        if not tid or not title:
            continue
        lexical = _name_similarity(query_text, title)
        vector = vector_scores.get(tid, 0.0)
        hybrid = (vector * 0.7) + (lexical * 0.3)
        out.append(
            {
                "id": tid,
                "title": title,
                "score": hybrid,
                "vectorScore": vector,
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


def call_classifier(
    window: list[dict],
    candidate_topics: list[dict],
    candidate_tasks: list[dict],
    notes_index: dict[str, list[str]],
    topic_contexts: dict[str, list[dict]],
    task_contexts: dict[str, list[dict]],
    memory_hits: list[dict],
):
    def build_prompt(compact: bool):
        content_limit = 360 if compact else 800
        recent_limit = 3 if compact else 6
        memory_limit = 3 if compact else len(memory_hits)
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
            "instructions": (
                "Return STRICT JSON only with shape: "
                "{\"topic\": {\"id\": string|null, \"name\": string, \"create\": boolean}, "
                "\"task\": {\"id\": string|null, \"title\": string|null, \"create\": boolean}|null, "
                "\"summaries\": [{\"id\": string, \"summary\": string}]}. "
                "Rules: (1) Prefer existing topics/tasks when they clearly match; "
                "(2) Use notes/curation and memory snippets as high-signal context; "
                "(3) Only create when needed; (4) Topic/task names must be short and human; "
                "(5) If an action item exists, pick or create a task; "
                "(6) If in doubt, return task=null; "
                "(7) For summaries, return very short one-liners <=72 chars; "
                "telegraphic style is acceptable; never prefix with 'SUMMARY:' or transport metadata."
            ),
        }

    for compact in (False, True):
        body = {
            "model": OPENCLAW_MODEL,
            "messages": [
                {"role": "system", "content": "You are a high-precision classifier for an ops dashboard. STRICT JSON only."},
                {"role": "user", "content": json.dumps(build_prompt(compact))},
            ],
            "temperature": 0,
            "max_tokens": 420 if compact else 600,
        }
        try:
            r = requests.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=oc_headers(),
                data=json.dumps(body),
                timeout=20 if compact else 30,
            )
            r.raise_for_status()
            data = r.json()
            text = data["choices"][0]["message"]["content"]
            try:
                return json.loads(text)
            except Exception:
                match = re.search(r"\{.*\}", text, flags=re.DOTALL)
                if not match:
                    raise
                return json.loads(match.group(0))
        except requests.exceptions.ReadTimeout:
            if compact:
                raise
            continue


def classify_without_llm(window: list[dict], ctx_logs: list[dict], topic_cands: list[dict], text: str):
    topics = list_topics()
    topics_by_id = {t.get("id"): t for t in topics if t.get("id")}

    chosen_topic_id = None
    chosen_topic_name = None
    create_topic = False

    # 1) Reuse session topic if one is already classified in this stream.
    for item in reversed(ctx_logs):
        if (item.get("classificationStatus") or "pending") != "classified":
            continue
        tid = item.get("topicId")
        if tid and tid in topics_by_id:
            chosen_topic_id = tid
            chosen_topic_name = topics_by_id[tid].get("name")
            break

    # 2) Otherwise use best hybrid candidate.
    if not chosen_topic_id and topic_cands:
        top = topic_cands[0]
        if float(top.get("score") or 0.0) >= 0.52:
            chosen_topic_id = top.get("id")
            chosen_topic_name = top.get("name")

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

    topic = upsert_topic(chosen_topic_id if not create_topic else None, chosen_topic_name)
    topic_id = topic["id"]

    task_id = None
    task_title = _derive_task_title(window)
    task_cands = task_candidates(topic_id, text, k=8)
    if task_cands and float(task_cands[0].get("score") or 0.0) >= 0.56:
        task_id = task_cands[0]["id"]
    elif task_title:
        existing = list_tasks(topic_id)
        match, score = _best_name_match(task_title, existing, "title")
        if match and score >= 0.78:
            task_id = match.get("id")
        else:
            task = upsert_task(None, topic_id, task_title)
            task_id = task["id"]

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
        "topic": {"id": topic_id, "name": topic.get("name") or chosen_topic_name, "create": False},
        "task": {"id": task_id, "title": task_title, "create": False} if task_id else None,
        "summaries": summaries,
    }


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

    # Window focus: a context window around the oldest pending conversation.
    # This avoids starving older pending rows when new traffic keeps arriving.
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

    anchor_id = pending_conversations[0].get("id")
    anchor_idx = next((idx for idx, item in enumerate(conversations) if item.get("id") == anchor_id), 0)
    window_start = max(0, anchor_idx - (WINDOW_SIZE - 1))
    window = conversations[window_start : window_start + WINDOW_SIZE]
    pending_ids = [
        e["id"]
        for e in window
        if (e.get("classificationStatus") or "pending") == "pending"
        and int(e.get("classificationAttempts") or 0) < MAX_ATTEMPTS
    ]
    if not pending_ids:
        return

    def mark_window_failure(error_code: str):
        for e in window:
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

    fallback_error: str | None = None
    try:
        result = call_classifier(window, topic_cands, task_cands, notes_index, topic_contexts, task_contexts, memory_hits)
    except requests.exceptions.ReadTimeout:
        fallback_error = "llm_timeout"
    except Exception as exc:
        fallback_error = f"classifier_error:{str(exc)[:120]}"

    if fallback_error:
        try:
            result = classify_without_llm(window, ctx_logs, topic_cands, text)
        except Exception:
            mark_window_failure(fallback_error)
            return

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

    all_topics = list_topics()
    topic_name_match, topic_name_score = _best_name_match(chosen_topic_name, all_topics, "name")
    if topic_name_match and topic_name_score >= TOPIC_NAME_SIM_THRESHOLD:
        chosen_topic_id = topic_name_match["id"]
        chosen_topic_name = topic_name_match.get("name") or chosen_topic_name
        create_topic = False

    topic = upsert_topic(chosen_topic_id if not create_topic else None, chosen_topic_name)
    topic_id = topic["id"]

    # Task selection/creation (within topic)
    task_id = None
    task_cands2 = task_candidates(topic_id, text)
    task_result = result.get("task")
    if isinstance(task_result, dict):
        task_title = task_result.get("title")
        create_task = bool(task_result.get("create"))
        proposed_task_id = task_result.get("id")

        ensure_task_index_seeded(topic_id)
        if task_cands2 and task_cands2[0]["score"] >= TASK_SIM_THRESHOLD:
            task_id = task_cands2[0]["id"]
        else:
            if proposed_task_id and not create_task:
                task_id = proposed_task_id
            elif create_task and task_title:
                existing_tasks = list_tasks(topic_id)
                task_name_match, task_name_score = _best_name_match(task_title, existing_tasks, "title")
                if task_name_match and task_name_score >= TASK_NAME_SIM_THRESHOLD:
                    task_id = task_name_match["id"]
                else:
                    task = upsert_task(None, topic_id, task_title)
                    task_id = task["id"]

    # Keep task continuity without creating duplicates.
    if not task_id:
        if task_cands2 and float(task_cands2[0].get("score") or 0.0) >= max(0.46, TASK_SIM_THRESHOLD - 0.24):
            task_id = task_cands2[0]["id"]

    if not task_id:
        continuity_task = _latest_classified_task_for_topic(ctx_logs, topic_id)
        if continuity_task:
            task_id = continuity_task

    if not task_id and _looks_actionable(text):
        existing_tasks = list_tasks(topic_id)
        open_tasks = [task for task in existing_tasks if (task.get("status") or "todo") != "done"]
        if len(open_tasks) == 1:
            task_id = open_tasks[0].get("id")
        else:
            task_title = _derive_task_title(window)
            if task_title:
                task_name_match, task_name_score = _best_name_match(task_title, existing_tasks, "title")
                if task_name_match and task_name_score >= 0.74:
                    task_id = task_name_match["id"]
                else:
                    task = upsert_task(None, topic_id, task_title)
                    task_id = task["id"]

    summary_updates: dict[str, str] = {}
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
            if concise:
                summary_updates[sid] = concise

    for e in window:
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


def main():
    while True:
        process_reindex_queue()
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

            session_stats: dict[str, dict] = {}
            for e in pending:
                sk = ((e.get("source") or {}) or {}).get("sessionKey")
                if not sk:
                    continue
                stats = session_stats.setdefault(sk, {"count": 0, "user": 0, "assistant": 0, "channel": False, "messageId": 0})
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

            session_keys: list[str] = []
            for sk, stats in session_stats.items():
                if sk.startswith("agent:classifier"):
                    continue
                if stats["channel"]:
                    session_keys.append(sk)
                    continue
                # Fallback for environments where channel session keys are unavailable:
                # only classify non-channel sessions that still carry real message ids.
                if stats["messageId"] > 0 and stats["count"] >= 2 and stats["user"] > 0 and stats["assistant"] > 0:
                    session_keys.append(sk)

            session_keys.sort(
                key=lambda sk: (
                    0 if session_stats.get(sk, {}).get("channel") else 1,
                    -int(session_stats.get(sk, {}).get("count") or 0),
                )
            )
            session_keys = session_keys[:MAX_SESSIONS_PER_CYCLE]
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
