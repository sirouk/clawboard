from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import uuid
import heapq
from collections import Counter, OrderedDict, defaultdict
from dataclasses import dataclass
from typing import Iterable
from urllib import error as url_error
from urllib import request as url_request

try:
    import numpy as np
except Exception:  # pragma: no cover - optional dependency
    np = None  # type: ignore[assignment]

try:
    from fastembed import TextEmbedding
except Exception:  # pragma: no cover - optional dependency
    TextEmbedding = None  # type: ignore[assignment]


EMBED_MODEL = os.getenv("CLAWBOARD_VECTOR_MODEL", "BAAI/bge-small-en-v1.5")

QDRANT_URL = (os.getenv("CLAWBOARD_QDRANT_URL") or os.getenv("QDRANT_URL") or "").rstrip("/")
QDRANT_COLLECTION = os.getenv(
    "CLAWBOARD_QDRANT_COLLECTION",
    os.getenv("QDRANT_COLLECTION", "clawboard_embeddings"),
)
QDRANT_DIM = int(os.getenv("CLAWBOARD_QDRANT_DIM", os.getenv("QDRANT_DIM", "384")))
QDRANT_TIMEOUT = float(os.getenv("CLAWBOARD_QDRANT_TIMEOUT", "2.6"))
QDRANT_API_KEY = os.getenv("CLAWBOARD_QDRANT_API_KEY") or os.getenv("QDRANT_API_KEY")

RRF_K = int(os.getenv("CLAWBOARD_RRF_K", "60"))
RERANK_TOP_N = int(os.getenv("CLAWBOARD_RERANK_TOP_N", "64"))
CHUNK_WORDS = int(os.getenv("CLAWBOARD_CHUNK_WORDS", "72"))
CHUNK_OVERLAP = int(os.getenv("CLAWBOARD_CHUNK_OVERLAP", "18"))
MAX_CHUNKS_PER_DOC = int(os.getenv("CLAWBOARD_MAX_CHUNKS_PER_DOC", "18"))
SEARCH_INCLUDE_TOOL_CALL_LOGS = str(os.getenv("CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS", "0") or "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
RERANK_CHUNKS_PER_DOC = int(os.getenv("CLAWBOARD_RERANK_CHUNKS_PER_DOC", "6") or "6")
SEARCH_SOURCE_TOPK_MULTIPLIER = int(os.getenv("CLAWBOARD_SEARCH_SOURCE_TOPK_MULTIPLIER", "6") or "6")
SEARCH_SOURCE_TOPK_MIN = int(os.getenv("CLAWBOARD_SEARCH_SOURCE_TOPK_MIN", "120") or "120")
SEARCH_SOURCE_TOPK_MAX = int(os.getenv("CLAWBOARD_SEARCH_SOURCE_TOPK_MAX", "960") or "960")
EMBED_QUERY_CACHE_SIZE = int(os.getenv("CLAWBOARD_SEARCH_EMBED_QUERY_CACHE_SIZE", "256") or "256")
EMBED_TEXT_CACHE_SIZE = int(os.getenv("CLAWBOARD_SEARCH_EMBED_TEXT_CACHE_SIZE", "4096") or "4096")
VECTOR_PREWARM = str(os.getenv("CLAWBOARD_VECTOR_PREWARM", "1") or "").strip().lower() in {"1", "true", "yes", "on"}
VECTOR_REQUIRE_QDRANT = str(os.getenv("CLAWBOARD_VECTOR_REQUIRE_QDRANT", "0") or "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

_MODEL = None
_MODEL_LOCK = threading.Lock()
_MODEL_LOADING = False
_MODEL_LAST_FAILURE_AT = 0.0
_QDRANT_COLLECTION_READY = False
_EMBED_QUERY_CACHE_LOCK = threading.Lock()
_EMBED_QUERY_CACHE: "OrderedDict[str, np.ndarray]" = OrderedDict()
_EMBED_TEXT_CACHE_LOCK = threading.Lock()
_EMBED_TEXT_CACHE: "OrderedDict[str, np.ndarray]" = OrderedDict()

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
    "can",
    "will",
    "would",
    "should",
    "please",
    "just",
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


@dataclass(frozen=True)
class ChunkRecord:
    id: str
    parent_id: str
    kind: str
    text: str
    tokens: tuple[str, ...]
    chunk_index: int
    word_start: int
    word_end: int


@dataclass(frozen=True)
class SearchDocument:
    id: str
    kind: str
    text: str
    tokens: tuple[str, ...]
    token_set: frozenset[str]
    chunks: tuple[ChunkRecord, ...]


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


def _tokenize(value: str) -> list[str]:
    normalized = _normalize_text(value).lower()
    if not normalized:
        return []
    words = re.findall(r"[a-z0-9][a-z0-9'/_:-]*", normalized)
    return [token for token in words if len(token) > 1]


def _token_set(value: str) -> set[str]:
    tokens = _tokenize(value)
    return {token for token in tokens if len(token) > 2 and token not in STOP_WORDS}


def _hybrid_component_weights(query_token_count: int, *, sparse_available: bool) -> dict[str, float]:
    # Multi-token queries are usually higher intent and benefit from stronger sparse signals.
    if query_token_count >= 2 and sparse_available:
        return {
            "rrf": 0.33,
            "dense": 0.14,
            "bm25": 0.27,
            "lexical": 0.14,
            "phrase": 0.12,
        }
    return {
        "rrf": 0.46,
        "dense": 0.24,
        "bm25": 0.22,
        "lexical": 0.08,
        "phrase": 0.0,
    }


def lexical_similarity(query: str, text: str) -> float:
    q_tokens = _token_set(query)
    d_tokens = _token_set(text)
    return _lexical_similarity_tokens(q_tokens, d_tokens)


def _lexical_similarity_tokens(q_tokens: set[str] | frozenset[str], d_tokens: set[str] | frozenset[str]) -> float:
    if not q_tokens or not d_tokens:
        return 0.0

    # Exact token overlap (Jaccard) is too strict for common partial queries like "sql"
    # when the indexed token is "sqlmodel". Provide a small partial-match boost so
    # lexical-only deployments still behave like "contains" search for short terms.
    exact = q_tokens & d_tokens
    partial = 0.0
    remaining = [tok for tok in q_tokens if tok not in exact]
    if remaining:
        for qtok in remaining:
            if len(qtok) < 3:
                continue
            # Prefer prefix matches (e.g., "sql" -> "sqlmodel"), then substring matches
            # (e.g., "sql" -> "postgresql").
            if any(dtok.startswith(qtok) for dtok in d_tokens):
                partial += 0.85
            elif any(qtok in dtok for dtok in d_tokens):
                partial += 0.65

    inter = float(len(exact)) + partial
    union = len(q_tokens | d_tokens)
    if union <= 0:
        return 0.0
    return inter / float(union)


def _top_k_scores(scores: dict[str, float], limit: int) -> dict[str, float]:
    if not scores:
        return {}
    k = max(1, int(limit))
    if len(scores) <= k:
        return scores
    return {item_id: float(score) for item_id, score in heapq.nlargest(k, scores.items(), key=lambda item: float(item[1]))}


def _source_topk_limit(limit: int, corpus_size: int) -> int:
    dynamic = max(SEARCH_SOURCE_TOPK_MIN, int(limit) * max(2, SEARCH_SOURCE_TOPK_MULTIPLIER))
    if SEARCH_SOURCE_TOPK_MAX > 0:
        dynamic = min(dynamic, SEARCH_SOURCE_TOPK_MAX)
    if corpus_size > 0:
        dynamic = min(dynamic, corpus_size)
    return max(1, dynamic)


def _rerank_top_n_for_query(query_token_count: int) -> int:
    base = max(8, int(RERANK_TOP_N))
    if query_token_count <= 1:
        return min(base, 28)
    if query_token_count == 2:
        return min(base, 44)
    if query_token_count == 3:
        return min(base, 56)
    return base


def _rerank_chunks_per_doc_for_query(query_token_count: int) -> int:
    base = max(2, int(RERANK_CHUNKS_PER_DOC))
    if query_token_count <= 1:
        return min(base, 3)
    if query_token_count == 2:
        return min(base, 4)
    return base


def _split_words_with_offsets(text: str) -> list[tuple[str, int, int]]:
    return [(m.group(0), m.start(), m.end()) for m in re.finditer(r"\S+", text)]


def _chunk_text(parent_kind: str, parent_id: str, text: str) -> list[ChunkRecord]:
    cleaned = _normalize_text(text)
    if not cleaned:
        return []

    word_matches = _split_words_with_offsets(cleaned)
    if not word_matches:
        return []

    max_words = max(24, CHUNK_WORDS)
    overlap = max(4, min(CHUNK_OVERLAP, max_words - 1))
    chunks: list[ChunkRecord] = []

    start = 0
    chunk_index = 0
    total_words = len(word_matches)
    while start < total_words and chunk_index < max(1, MAX_CHUNKS_PER_DOC):
        end = min(total_words, start + max_words)
        first_char = word_matches[start][1]
        last_char = word_matches[end - 1][2]
        chunk_text = cleaned[first_char:last_char].strip()
        tokens = tuple(_tokenize(chunk_text))
        if chunk_text and tokens:
            chunks.append(
                ChunkRecord(
                    id=f"{parent_kind}:{parent_id}:chunk:{chunk_index}",
                    parent_id=parent_id,
                    kind=parent_kind,
                    text=chunk_text,
                    tokens=tokens,
                    chunk_index=chunk_index,
                    word_start=start,
                    word_end=end,
                )
            )
            chunk_index += 1
        if end >= total_words:
            break
        start = max(start + 1, end - overlap)

    if not chunks:
        tokens = tuple(_tokenize(cleaned))
        if tokens:
            chunks.append(
                ChunkRecord(
                    id=f"{parent_kind}:{parent_id}:chunk:0",
                    parent_id=parent_id,
                    kind=parent_kind,
                    text=cleaned,
                    tokens=tokens,
                    chunk_index=0,
                    word_start=0,
                    word_end=total_words,
                )
            )

    return chunks


def _clip(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def _log_text(log: dict) -> str:
    summary = _normalize_text(str(log.get("summary") or ""))
    content = _normalize_text(str(log.get("content") or ""))
    raw = _normalize_text(str(log.get("raw") or ""))
    return _clip(" ".join(part for part in [summary, content, raw] if part), 1200)


def _is_tool_call_log(log: dict) -> bool:
    if str(log.get("type") or "") != "action":
        return False
    combined = " ".join(
        part
        for part in [
            str(log.get("summary") or ""),
            str(log.get("content") or ""),
            str(log.get("raw") or ""),
        ]
        if part
    ).lower()
    return "tool call:" in combined or "tool result:" in combined or "tool error:" in combined


def _is_memory_action_log(log: dict) -> bool:
    if str(log.get("type") or "") != "action":
        return False
    combined = " ".join(
        part
        for part in [
            str(log.get("summary") or ""),
            str(log.get("content") or ""),
            str(log.get("raw") or ""),
        ]
        if part
    ).lower()
    if "tool call:" in combined or "tool result:" in combined or "tool error:" in combined:
        if re.search(r"\bmemory[_-]?(search|get|query|fetch|retrieve|read|write|store|list|prune|delete)\b", combined):
            return True
    return False


def _is_command_log(log: dict) -> bool:
    if str(log.get("type") or "") != "conversation":
        return False
    text = _normalize_text(str(log.get("content") or log.get("summary") or log.get("raw") or ""))
    if not text.startswith("/"):
        return False
    command = text.split(None, 1)[0].lower()
    if command in SLASH_COMMANDS:
        return True
    return bool(re.fullmatch(r"/[a-z0-9_-]{2,}", command))


def _prepare_docs(kind: str, rows: Iterable[dict], text_builder, *, chunk: bool = True) -> list[SearchDocument]:
    docs: list[SearchDocument] = []
    for row in rows:
        item_id = str(row.get("id") or "").strip()
        if not item_id:
            continue
        text = _normalize_text(text_builder(row))
        if not text:
            continue
        # Chunking is expensive for log-heavy searches. Allow callers to skip it and
        # compute chunks lazily only for top rerank candidates.
        chunks = _chunk_text(kind, item_id, text) if chunk else []
        tokens = tuple(_tokenize(text))
        if not tokens:
            continue
        token_set = frozenset(token for token in tokens if len(token) > 2 and token not in STOP_WORDS)
        docs.append(
            SearchDocument(
                id=item_id,
                kind=kind,
                text=text,
                tokens=tokens,
                token_set=token_set,
                chunks=tuple(chunks),
            )
        )
    return docs


def _bm25_scores(query_tokens: list[str], doc_tokens: dict[str, tuple[str, ...]], *, k1: float = 1.6, b: float = 0.68) -> dict[str, float]:
    if not query_tokens or not doc_tokens:
        return {}

    docs = list(doc_tokens.items())
    doc_count = len(docs)
    if doc_count == 0:
        return {}

    avgdl = sum(max(1, len(tokens)) for _, tokens in docs) / doc_count
    term_doc_freq: Counter[str] = Counter()
    tokenized_docs: dict[str, Counter[str]] = {}
    for doc_id, tokens in docs:
        counter = Counter(tokens)
        tokenized_docs[doc_id] = counter
        for token in counter.keys():
            term_doc_freq[token] += 1

    unique_query_tokens = [token for token in dict.fromkeys(query_tokens) if len(token) > 1]
    scores: dict[str, float] = {}
    for doc_id, tokens in docs:
        dl = max(1, len(tokens))
        tf = tokenized_docs[doc_id]
        score = 0.0
        for token in unique_query_tokens:
            freq = tf.get(token, 0)
            if freq <= 0:
                continue
            df = term_doc_freq.get(token, 0)
            # BM25 idf variant used by Lucene-like implementations.
            idf = math.log(1 + ((doc_count - df + 0.5) / (df + 0.5)))
            numerator = freq * (k1 + 1.0)
            denominator = freq + k1 * (1.0 - b + b * (dl / max(1e-8, avgdl)))
            score += idf * (numerator / max(1e-8, denominator))
        if score > 0:
            scores[doc_id] = float(score)
    return scores


def _normalize_scores(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    values = [float(v) for v in scores.values()]
    max_value = max(values)
    min_value = min(values)
    if max_value <= min_value:
        return {key: 1.0 for key in scores}
    return {key: (float(value) - min_value) / (max_value - min_value) for key, value in scores.items()}


def _rrf_fuse(score_maps: list[dict[str, float]], weights: list[float] | None = None, k: int = RRF_K) -> dict[str, float]:
    if not score_maps:
        return {}
    if not weights:
        weights = [1.0 for _ in score_maps]
    fused: dict[str, float] = defaultdict(float)
    for score_map, weight in zip(score_maps, weights):
        if not score_map:
            continue
        ranked = sorted(score_map.items(), key=lambda item: float(item[1]), reverse=True)
        for rank, (item_id, _value) in enumerate(ranked, start=1):
            fused[item_id] += float(weight) / float(k + rank)
    return dict(fused)


def _get_model():
    global _MODEL
    if not vector_runtime_available():
        return None
    # Never block request threads on model download/initialization. If the model isn't ready,
    # kick off a background load and fall back to lexical-only behavior for this request.
    if _MODEL is not None:
        return _MODEL
    _ensure_model_loading_async()
    return _MODEL


def _ensure_model_loading_async() -> None:
    """Start embedding model load in a daemon thread (non-blocking)."""
    global _MODEL_LOADING, _MODEL_LAST_FAILURE_AT, _MODEL
    if not vector_runtime_available():
        return
    now = time.time()
    with _MODEL_LOCK:
        if _MODEL is not None or _MODEL_LOADING:
            return
        # Avoid tight retry loops if the environment cannot load the model (no internet, etc).
        if _MODEL_LAST_FAILURE_AT and (now - _MODEL_LAST_FAILURE_AT) < 30.0:
            return
        _MODEL_LOADING = True

    def _loader():
        global _MODEL_LOADING, _MODEL_LAST_FAILURE_AT, _MODEL
        model = None
        try:
            model = TextEmbedding(EMBED_MODEL)
        except Exception:
            model = None
        with _MODEL_LOCK:
            _MODEL = model
            _MODEL_LOADING = False
            if model is None:
                _MODEL_LAST_FAILURE_AT = time.time()

    threading.Thread(target=_loader, name="clawboard-vector-model-loader", daemon=True).start()


def _embed_query(text: str):
    normalized = _normalize_text(text)
    if not normalized:
        return None
    if np is not None and EMBED_QUERY_CACHE_SIZE > 0:
        with _EMBED_QUERY_CACHE_LOCK:
            cached = _EMBED_QUERY_CACHE.get(normalized)
            if cached is not None:
                _EMBED_QUERY_CACHE.move_to_end(normalized)
                return cached

    model = _get_model()
    if model is None:
        return None
    try:
        vec = next(model.embed([normalized]), None)
    except Exception:
        return None
    if vec is None:
        return None
    arr = np.asarray(vec, dtype=np.float32)
    if arr.size == 0:
        return None
    if EMBED_QUERY_CACHE_SIZE > 0:
        with _EMBED_QUERY_CACHE_LOCK:
            _EMBED_QUERY_CACHE[normalized] = arr
            _EMBED_QUERY_CACHE.move_to_end(normalized)
            while len(_EMBED_QUERY_CACHE) > EMBED_QUERY_CACHE_SIZE:
                _EMBED_QUERY_CACHE.popitem(last=False)
    return arr


def _embed_many(texts: list[str]) -> dict[str, "np.ndarray"]:
    model = _get_model()
    if model is None or np is None:
        return {}
    unique_texts = [text for text in dict.fromkeys(texts) if text]
    if not unique_texts:
        return {}
    embedded: dict[str, "np.ndarray"] = {}
    pending: list[str] = []
    if EMBED_TEXT_CACHE_SIZE > 0:
        with _EMBED_TEXT_CACHE_LOCK:
            for text in unique_texts:
                cached = _EMBED_TEXT_CACHE.get(text)
                if cached is not None:
                    _EMBED_TEXT_CACHE.move_to_end(text)
                    embedded[text] = cached
                else:
                    pending.append(text)
    else:
        pending = unique_texts
    if not pending:
        return embedded
    try:
        vectors = list(model.embed(pending))
    except Exception:
        return embedded
    for text, vec in zip(pending, vectors):
        arr = np.asarray(vec, dtype=np.float32)
        if arr.size == 0:
            continue
        embedded[text] = arr
    if EMBED_TEXT_CACHE_SIZE > 0 and embedded:
        with _EMBED_TEXT_CACHE_LOCK:
            for text, arr in embedded.items():
                _EMBED_TEXT_CACHE[text] = arr
                _EMBED_TEXT_CACHE.move_to_end(text)
            while len(_EMBED_TEXT_CACHE) > EMBED_TEXT_CACHE_SIZE:
                _EMBED_TEXT_CACHE.popitem(last=False)
    return embedded


def _qdrant_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if QDRANT_API_KEY:
        headers["api-key"] = QDRANT_API_KEY
    return headers


def _qdrant_request(method: str, path: str, payload: dict | None = None) -> dict | None:
    if not QDRANT_URL:
        return None
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    req = url_request.Request(
        f"{QDRANT_URL}{path}",
        data=body,
        headers=_qdrant_headers(),
        method=method.upper(),
    )
    try:
        with url_request.urlopen(req, timeout=QDRANT_TIMEOUT) as response:
            raw = response.read()
            if not raw:
                return {}
            return json.loads(raw.decode("utf-8"))
    except (url_error.URLError, url_error.HTTPError, TimeoutError, ValueError):
        return None


def _ensure_qdrant_collection(dim_hint: int | None = None) -> bool:
    global _QDRANT_COLLECTION_READY
    if not QDRANT_URL:
        return False
    if _QDRANT_COLLECTION_READY:
        return True

    existing = _qdrant_request("GET", f"/collections/{QDRANT_COLLECTION}")
    if existing is not None:
        _QDRANT_COLLECTION_READY = True
        return True

    vector_size = int(dim_hint or QDRANT_DIM or 384)
    if vector_size <= 0:
        vector_size = 384
    payload = {
        "vectors": {"size": vector_size, "distance": "Cosine"},
        "hnsw_config": {"m": 32, "ef_construct": 256, "full_scan_threshold": 20000},
        "optimizers_config": {"default_segment_number": 2},
    }
    created = _qdrant_request("PUT", f"/collections/{QDRANT_COLLECTION}", payload)
    if created is None:
        return False
    _QDRANT_COLLECTION_READY = True
    return True


def _qdrant_id_from_hit(hit: dict) -> tuple[str | None, str | None]:
    payload = hit.get("payload") if isinstance(hit, dict) else None
    payload_kind = str((payload or {}).get("kind") or "").strip() if isinstance(payload, dict) else ""
    payload_id = str((payload or {}).get("id") or "").strip() if isinstance(payload, dict) else ""
    if payload_kind and payload_id:
        return payload_kind, payload_id

    point_id = hit.get("id") if isinstance(hit, dict) else None
    point_text = str(point_id or "").strip()
    if not point_text:
        return None, None
    if payload_kind and point_text.startswith(f"{payload_kind}:"):
        return payload_kind, point_text[len(payload_kind) + 1 :]
    if ":" in point_text:
        prefix, _, suffix = point_text.partition(":")
        return prefix, suffix
    return payload_kind or None, point_text


def _qdrant_point_id(kind: str, item_id: str) -> str:
    # Qdrant requires point ids as uint or UUID. Use deterministic UUIDv5 for idempotent upserts.
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"clawboard:{kind}:{item_id}"))


def _qdrant_topk(
    query_vec,
    *,
    kind_exact: str | None = None,
    kind_prefix: str | None = None,
    limit: int = 120,
) -> dict[str, float]:
    if np is None or query_vec is None or not QDRANT_URL:
        return {}
    dim_hint = int(query_vec.shape[0]) if hasattr(query_vec, "shape") else None
    if not _ensure_qdrant_collection(dim_hint=dim_hint):
        return {}

    # Prefix filters are resolved client-side to support legacy payloads.
    filter_payload = None
    if kind_exact and not kind_prefix:
        filter_payload = {"must": [{"key": "kind", "match": {"value": kind_exact}}]}

    query_limit = max(limit * 8, 160)
    payload = {
        "vector": query_vec.astype(float).tolist(),
        "limit": query_limit,
        "with_payload": True,
    }
    if filter_payload:
        payload["filter"] = filter_payload

    response = _qdrant_request(
        "POST",
        f"/collections/{QDRANT_COLLECTION}/points/search",
        payload,
    )
    if not response:
        return {}

    rows = response.get("result")
    if not isinstance(rows, list):
        return {}

    best: dict[str, float] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_kind, item_id = _qdrant_id_from_hit(row)
        if not item_id:
            continue
        row_kind = str(row_kind or "")
        if kind_exact and row_kind != kind_exact:
            continue
        if kind_prefix and not row_kind.startswith(kind_prefix):
            continue
        score = float(row.get("score") or 0.0)
        if score <= 0:
            continue
        best[item_id] = max(best.get(item_id, 0.0), score)

    if not best:
        return {}
    ranked = sorted(best.items(), key=lambda item: item[1], reverse=True)
    return dict(ranked[:limit])


def _vector_topk(query_vec, *, kind_exact: str | None = None, kind_prefix: str | None = None, limit: int = 120) -> tuple[dict[str, float], str]:
    if query_vec is None:
        return {}, "none"
    if VECTOR_REQUIRE_QDRANT and not QDRANT_URL:
        return {}, "qdrant-required"
    if QDRANT_URL:
        qdrant_scores = _qdrant_topk(query_vec, kind_exact=kind_exact, kind_prefix=kind_prefix, limit=limit)
        if qdrant_scores:
            return qdrant_scores, "qdrant"
        if VECTOR_REQUIRE_QDRANT:
            return {}, "qdrant-required"
    return {}, "none"


def _late_interaction_rerank(
    query: str,
    query_tokens: set[str],
    query_vec,
    docs_by_id: dict[str, SearchDocument],
    candidate_ids: list[str],
    chunk_bm25_scores: dict[str, float],
    *,
    rerank_top_n: int,
    max_chunks_per_doc: int,
) -> tuple[dict[str, float], dict[str, dict[str, object]]]:
    if not candidate_ids:
        return {}, {}

    lazy_chunks: dict[str, tuple[ChunkRecord, ...]] = {}

    def doc_chunks(doc: SearchDocument) -> tuple[ChunkRecord, ...]:
        if doc.chunks:
            return doc.chunks
        cached = lazy_chunks.get(doc.id)
        if cached is not None:
            return cached
        computed = tuple(_chunk_text(doc.kind, doc.id, doc.text))
        lazy_chunks[doc.id] = computed
        return computed

    # Keep reranking bounded and focused.
    selected_ids = candidate_ids[: max(1, int(rerank_top_n))]
    max_chunks_per_doc = max(2, int(max_chunks_per_doc))
    selected_chunks: list[ChunkRecord] = []
    for doc_id in selected_ids:
        doc = docs_by_id.get(doc_id)
        if not doc:
            continue
        chunks = doc_chunks(doc)
        selected_chunks.extend(chunks[: min(max_chunks_per_doc, len(chunks))])

    chunk_norm = _normalize_scores(chunk_bm25_scores)
    chunk_vectors: dict[str, "np.ndarray"] = {}
    if query_vec is not None and selected_chunks:
        text_to_vec = _embed_many([chunk.text for chunk in selected_chunks])
        for chunk in selected_chunks:
            vec = text_to_vec.get(chunk.text)
            if vec is not None:
                chunk_vectors[chunk.id] = vec

    rerank_scores: dict[str, float] = {}
    best_chunk_meta: dict[str, dict[str, object]] = {}
    query_lower = _normalize_text(query).lower()
    query_arr = None
    query_norm = 0.0
    if np is not None and query_vec is not None:
        try:
            query_arr = np.asarray(query_vec, dtype=np.float32).reshape(-1)
        except Exception:
            query_arr = None
        if query_arr is not None and query_arr.size > 0:
            query_norm = float(np.linalg.norm(query_arr))

    for doc_id in selected_ids:
        doc = docs_by_id.get(doc_id)
        if not doc:
            continue
        best_score = 0.0
        best_chunk: ChunkRecord | None = None
        chunks = doc_chunks(doc)
        for chunk in chunks[: min(max_chunks_per_doc, len(chunks))]:
            chunk_token_set = set(chunk.tokens)
            token_coverage = (len(query_tokens & chunk_token_set) / max(1, len(query_tokens))) if query_tokens else 0.0
            phrase_bonus = 1.0 if query_lower and query_lower in chunk.text.lower() else 0.0
            bm25_chunk = chunk_norm.get(chunk.id, 0.0)

            dense_score = 0.0
            if query_arr is not None and query_norm > 0 and np is not None:
                vec = chunk_vectors.get(chunk.id)
                if vec is not None:
                    try:
                        vec_arr = np.asarray(vec, dtype=np.float32).reshape(-1)
                    except Exception:
                        vec_arr = None
                    if vec_arr is None or vec_arr.size == 0 or vec_arr.size != query_arr.size:
                        vec_arr = None
                    denom = query_norm * float(np.linalg.norm(vec_arr)) if vec_arr is not None else 0.0
                    if denom > 0:
                        dense_score = max(0.0, float(np.dot(query_arr, vec_arr) / denom))

            if len(query_tokens) >= 2:
                score = (dense_score * 0.46) + (bm25_chunk * 0.23) + (token_coverage * 0.23) + (phrase_bonus * 0.08)
            else:
                score = (dense_score * 0.58) + (bm25_chunk * 0.2) + (token_coverage * 0.17) + (phrase_bonus * 0.05)
            if score > best_score:
                best_score = score
                best_chunk = chunk

        if best_chunk is not None:
            best_chunk_meta[doc_id] = {
                "id": best_chunk.id,
                "text": _clip(best_chunk.text, 220),
                "chunkIndex": best_chunk.chunk_index,
                "wordStart": best_chunk.word_start,
                "wordEnd": best_chunk.word_end,
            }
        rerank_scores[doc_id] = best_score

    return rerank_scores, best_chunk_meta


def _hybrid_rank(
    query: str,
    docs: list[SearchDocument],
    dense_scores: dict[str, float],
    query_vec,
    limit: int,
) -> tuple[list[dict], dict[str, dict[str, object]]]:
    if not docs:
        return [], {}
    query_tokens_list = _tokenize(query)
    if not query_tokens_list:
        return [], {}
    query_tokens = set(query_tokens_list)
    query_token_count = len(query_tokens)
    query_lower = _normalize_text(query).lower()

    docs_by_id = {doc.id: doc for doc in docs}
    source_limit = _source_topk_limit(limit, len(docs))
    # Ignore dense hits for docs that aren't part of this ranking corpus
    # (e.g., filtered-out log kinds), otherwise score normalization gets skewed.
    dense_scores = {item_id: float(score) for item_id, score in dense_scores.items() if item_id in docs_by_id}
    dense_scores = _top_k_scores(dense_scores, source_limit)
    doc_token_map = {doc.id: doc.tokens for doc in docs}
    doc_bm25_scores = _bm25_scores(query_tokens_list, doc_token_map)
    doc_bm25_scores = _top_k_scores(doc_bm25_scores, source_limit)

    query_token_set = {token for token in query_tokens if len(token) > 2 and token not in STOP_WORDS}
    lexical_scores: dict[str, float] = {}
    lexical_floor = 0.05 if query_token_count >= 2 else 0.0
    if query_token_set:
        for doc in docs:
            if not doc.token_set:
                continue
            score = _lexical_similarity_tokens(query_token_set, doc.token_set)
            if score > lexical_floor:
                lexical_scores[doc.id] = score
    lexical_scores = _top_k_scores(lexical_scores, source_limit)

    phrase_scores: dict[str, float] = {}
    if query_lower and query_token_count >= 2:
        phrase_candidates = set(dense_scores.keys()) | set(doc_bm25_scores.keys()) | set(lexical_scores.keys())
        if not phrase_candidates:
            for doc in docs:
                if len(phrase_candidates) >= source_limit:
                    break
                if query_tokens & doc.token_set:
                    phrase_candidates.add(doc.id)
        for doc_id in phrase_candidates:
            doc = docs_by_id.get(doc_id)
            if not doc:
                continue
            text_lower = doc.text.lower()
            if query_lower in text_lower:
                phrase_scores[doc.id] = 1.0
                continue
            overlap = len(query_tokens & doc.token_set)
            if overlap >= query_token_count and query_token_count > 0:
                phrase_scores[doc.id] = 0.35
            elif query_token_count >= 3 and overlap >= 2:
                phrase_scores[doc.id] = 0.15
    phrase_scores = _top_k_scores(phrase_scores, source_limit)

    rrf_sources = [dense_scores, doc_bm25_scores, lexical_scores]
    rrf_weights = [1.0, 0.98, 0.62]
    if phrase_scores:
        rrf_sources.append(phrase_scores)
        rrf_weights.append(0.66)
    rrf_scores = _rrf_fuse(
        rrf_sources,
        weights=rrf_weights,
    )
    rrf_scores = _top_k_scores(rrf_scores, source_limit)

    dense_norm = _normalize_scores(dense_scores)
    bm25_norm = _normalize_scores(doc_bm25_scores)
    lexical_norm = _normalize_scores(lexical_scores)
    phrase_norm = _normalize_scores(phrase_scores)
    rrf_norm = _normalize_scores(rrf_scores)
    component_weights = _hybrid_component_weights(
        query_token_count,
        sparse_available=bool(doc_bm25_scores or lexical_scores or phrase_scores),
    )

    base_scores: dict[str, float] = {}
    candidate_ids = (
        set(dense_scores.keys())
        | set(doc_bm25_scores.keys())
        | set(lexical_scores.keys())
        | set(phrase_scores.keys())
        | set(rrf_scores.keys())
    )
    for item_id in candidate_ids:
        score = (
            (rrf_norm.get(item_id, 0.0) * component_weights["rrf"])
            + (dense_norm.get(item_id, 0.0) * component_weights["dense"])
            + (bm25_norm.get(item_id, 0.0) * component_weights["bm25"])
            + (lexical_norm.get(item_id, 0.0) * component_weights["lexical"])
            + (phrase_norm.get(item_id, 0.0) * component_weights["phrase"])
        )
        if score > 0:
            base_scores[item_id] = score

    ranked_ids = [item_id for item_id, _ in sorted(base_scores.items(), key=lambda item: item[1], reverse=True)]
    if not ranked_ids:
        return [], {}
    ranked_ids = ranked_ids[:source_limit]

    # Chunk BM25 is expensive at corpus scale. Compute it only for the rerank candidates
    # so search stays fast even with thousands of log rows.
    rerank_top_n = _rerank_top_n_for_query(query_token_count)
    max_chunks_per_doc = _rerank_chunks_per_doc_for_query(query_token_count)
    selected_ids = ranked_ids[: max(1, rerank_top_n)]
    lazy_chunks: dict[str, tuple[ChunkRecord, ...]] = {}

    def doc_chunks(doc: SearchDocument) -> tuple[ChunkRecord, ...]:
        if doc.chunks:
            return doc.chunks
        cached = lazy_chunks.get(doc.id)
        if cached is not None:
            return cached
        computed = tuple(_chunk_text(doc.kind, doc.id, doc.text))
        lazy_chunks[doc.id] = computed
        return computed

    chunk_token_map: dict[str, tuple[str, ...]] = {}
    chunk_parent_map: dict[str, str] = {}
    for doc_id in selected_ids:
        doc = docs_by_id.get(doc_id)
        if not doc:
            continue
        chunks = doc_chunks(doc)
        for chunk in chunks[: min(max_chunks_per_doc, len(chunks))]:
            chunk_token_map[chunk.id] = chunk.tokens
            chunk_parent_map[chunk.id] = doc_id
    chunk_bm25 = _bm25_scores(query_tokens_list, chunk_token_map)
    parent_chunk_scores: dict[str, float] = {}
    for chunk_id, score in chunk_bm25.items():
        parent_id = chunk_parent_map.get(chunk_id)
        if not parent_id:
            continue
        parent_chunk_scores[parent_id] = max(parent_chunk_scores.get(parent_id, 0.0), score)

    rerank_scores, best_chunk_map = _late_interaction_rerank(
        query=query,
        query_tokens=query_tokens,
        query_vec=query_vec,
        docs_by_id=docs_by_id,
        candidate_ids=ranked_ids,
        chunk_bm25_scores=chunk_bm25,
        rerank_top_n=rerank_top_n,
        max_chunks_per_doc=max_chunks_per_doc,
    )
    rerank_norm = _normalize_scores(rerank_scores)

    rows: list[dict] = []
    for item_id in ranked_ids:
        doc = docs_by_id.get(item_id)
        if not doc:
            continue
        base = base_scores.get(item_id, 0.0)
        rerank = rerank_norm.get(item_id, 0.0)
        final_score = (base * 0.72) + (rerank * 0.28)
        if final_score < 0.04:
            continue
        rows.append(
            {
                "id": item_id,
                "score": round(final_score, 6),
                "rrfScore": round(rrf_scores.get(item_id, 0.0), 6),
                "vectorScore": round(dense_scores.get(item_id, 0.0), 6),
                "bm25Score": round(doc_bm25_scores.get(item_id, 0.0), 6),
                "lexicalScore": round(lexical_scores.get(item_id, 0.0), 6),
                "phraseScore": round(phrase_scores.get(item_id, 0.0), 6),
                "chunkScore": round(parent_chunk_scores.get(item_id, 0.0), 6),
                "rerankScore": round(rerank_scores.get(item_id, 0.0), 6),
            }
        )

    rows.sort(key=lambda item: float(item["score"]), reverse=True)
    return rows[:limit], best_chunk_map


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
    if len(q) < 1:
        return {
            "query": q,
            "mode": "empty",
            "topics": [],
            "tasks": [],
            "logs": [],
        }

    topic_docs = _prepare_docs(
        "topic",
        topics,
        lambda row: f"{row.get('name') or ''}\n{row.get('description') or ''}\n{row.get('searchText') or ''}",
        chunk=False,
    )
    task_docs = _prepare_docs(
        "task",
        tasks,
        lambda row: f"{row.get('title') or ''}\n{row.get('status') or ''}\n{row.get('searchText') or ''}",
        chunk=False,
    )
    filtered_logs = [
        row
        for row in logs
        if str(row.get("type") or "") not in ("system", "import")
        and (SEARCH_INCLUDE_TOOL_CALL_LOGS or not _is_tool_call_log(row))
        and not _is_memory_action_log(row)
        and not _is_command_log(row)
    ]
    log_docs = _prepare_docs("log", filtered_logs, _log_text, chunk=False)

    query_vec = _embed_query(q)
    topic_dense, topic_backend = _vector_topk(query_vec, kind_exact="topic", limit=max(topic_limit * 4, 80))
    task_dense, task_backend = _vector_topk(query_vec, kind_prefix="task:", limit=max(task_limit * 4, 140))
    log_dense, log_backend = _vector_topk(query_vec, kind_exact="log", limit=max(log_limit * 2, 220))

    topic_ranked, topic_chunks = _hybrid_rank(q, topic_docs, topic_dense, query_vec, topic_limit)
    task_ranked, task_chunks = _hybrid_rank(q, task_docs, task_dense, query_vec, task_limit)
    log_ranked, log_chunks = _hybrid_rank(q, log_docs, log_dense, query_vec, log_limit)

    topic_map = {str(item.get("id") or ""): item for item in topics}
    task_map = {str(item.get("id") or ""): item for item in tasks}
    log_map = {str(item.get("id") or ""): item for item in filtered_logs}

    topic_rows: list[dict] = []
    for item in topic_ranked:
        row = topic_map.get(item["id"]) or {}
        enriched = dict(item)
        enriched["id"] = item["id"]
        enriched["bestChunk"] = topic_chunks.get(item["id"])
        if row.get("name") is not None:
            enriched["name"] = row.get("name")
        if row.get("description") is not None:
            enriched["description"] = row.get("description")
        topic_rows.append(enriched)

    task_rows: list[dict] = []
    for item in task_ranked:
        row = task_map.get(item["id"]) or {}
        enriched = dict(item)
        enriched["id"] = item["id"]
        enriched["topicId"] = row.get("topicId")
        enriched["title"] = row.get("title")
        enriched["status"] = row.get("status")
        enriched["bestChunk"] = task_chunks.get(item["id"])
        task_rows.append(enriched)

    log_rows: list[dict] = []
    for item in log_ranked:
        row = log_map.get(item["id"]) or {}
        enriched = dict(item)
        enriched["id"] = item["id"]
        enriched["topicId"] = row.get("topicId")
        enriched["taskId"] = row.get("taskId")
        enriched["type"] = row.get("type")
        enriched["agentId"] = row.get("agentId")
        enriched["agentLabel"] = row.get("agentLabel")
        enriched["bestChunk"] = log_chunks.get(item["id"])
        log_rows.append(enriched)

    mode_parts = ["bm25", "lexical", "rrf", "rerank"]
    dense_backends = [backend for backend in [topic_backend, task_backend, log_backend] if backend != "none"]
    if query_vec is not None and dense_backends:
        if any(backend == "qdrant" for backend in dense_backends):
            mode_parts.insert(0, "qdrant")
        elif any(backend == "sqlite" for backend in dense_backends):
            mode_parts.insert(0, "sqlite-vector")

    return {
        "query": q,
        "mode": "+".join(mode_parts),
        "topics": topic_rows,
        "tasks": task_rows,
        "logs": log_rows,
    }


if VECTOR_PREWARM:
    _ensure_model_loading_async()
