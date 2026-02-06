from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import threading
import uuid
from collections import Counter, defaultdict
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


EMBED_DB_PATH = os.getenv("CLAWBOARD_VECTOR_DB_PATH", "./data/classifier_embeddings.db")
EMBED_MODEL = os.getenv("CLAWBOARD_VECTOR_MODEL", "BAAI/bge-small-en-v1.5")

QDRANT_URL = (os.getenv("CLAWBOARD_QDRANT_URL") or os.getenv("QDRANT_URL") or "").rstrip("/")
QDRANT_COLLECTION = os.getenv(
    "CLAWBOARD_QDRANT_COLLECTION",
    os.getenv("QDRANT_COLLECTION", "clawboard_embeddings"),
)
QDRANT_DIM = int(os.getenv("CLAWBOARD_QDRANT_DIM", os.getenv("QDRANT_DIM", "384")))
QDRANT_TIMEOUT = float(os.getenv("CLAWBOARD_QDRANT_TIMEOUT", "2.6"))
QDRANT_API_KEY = os.getenv("CLAWBOARD_QDRANT_API_KEY") or os.getenv("QDRANT_API_KEY")
QDRANT_SEED_MAX = int(os.getenv("CLAWBOARD_QDRANT_SEED_MAX", "10000"))

RRF_K = int(os.getenv("CLAWBOARD_RRF_K", "60"))
RERANK_TOP_N = int(os.getenv("CLAWBOARD_RERANK_TOP_N", "84"))
CHUNK_WORDS = int(os.getenv("CLAWBOARD_CHUNK_WORDS", "72"))
CHUNK_OVERLAP = int(os.getenv("CLAWBOARD_CHUNK_OVERLAP", "18"))
MAX_CHUNKS_PER_DOC = int(os.getenv("CLAWBOARD_MAX_CHUNKS_PER_DOC", "18"))

_MODEL = None
_MODEL_LOCK = threading.Lock()
_QDRANT_SEED_ATTEMPTED: set[str] = set()
_QDRANT_COLLECTION_READY = False

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


def _prepare_docs(kind: str, rows: Iterable[dict], text_builder) -> list[SearchDocument]:
    docs: list[SearchDocument] = []
    for row in rows:
        item_id = str(row.get("id") or "").strip()
        if not item_id:
            continue
        text = _normalize_text(text_builder(row))
        if not text:
            continue
        chunks = _chunk_text(kind, item_id, text)
        tokens = tuple(_tokenize(text))
        if not tokens:
            continue
        docs.append(
            SearchDocument(
                id=item_id,
                kind=kind,
                text=text,
                tokens=tokens,
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


def _embed_many(texts: list[str]) -> dict[str, "np.ndarray"]:
    model = _get_model()
    if model is None or np is None:
        return {}
    unique_texts = [text for text in dict.fromkeys(texts) if text]
    if not unique_texts:
        return {}
    try:
        vectors = list(model.embed(unique_texts))
    except Exception:
        return {}

    embedded: dict[str, "np.ndarray"] = {}
    for text, vec in zip(unique_texts, vectors):
        arr = np.asarray(vec, dtype=np.float32)
        if arr.size == 0:
            continue
        embedded[text] = arr
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


def _qdrant_seed_from_sqlite(*, kind_exact: str | None = None, kind_prefix: str | None = None) -> bool:
    if not QDRANT_URL or np is None:
        return False
    vectors = _load_vectors(kind_exact=kind_exact, kind_prefix=kind_prefix)
    if not vectors:
        return False
    if not _ensure_qdrant_collection(dim_hint=int(vectors[0][2].shape[0])):
        return False
    vectors = vectors[: max(100, QDRANT_SEED_MAX)]
    batch_size = 256
    ok = False
    for idx in range(0, len(vectors), batch_size):
        chunk = vectors[idx : idx + batch_size]
        points: list[dict] = []
        for kind, item_id, vec in chunk:
            kind_root = kind.split(":", 1)[0] if ":" in kind else kind
            points.append(
                {
                    "id": _qdrant_point_id(kind, item_id),
                    "vector": vec.astype(float).tolist(),
                    "payload": {
                        "kind": kind,
                        "kindRoot": kind_root,
                        "id": item_id,
                    },
                }
            )
        if not points:
            continue
        result = _qdrant_request(
            "PUT",
            f"/collections/{QDRANT_COLLECTION}/points?wait=true",
            {"points": points},
        )
        if result is None:
            continue
        ok = True
    return ok


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


def _sqlite_topk(query_vec, *, kind_exact: str | None = None, kind_prefix: str | None = None, limit: int = 120) -> dict[str, float]:
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


def _vector_topk(query_vec, *, kind_exact: str | None = None, kind_prefix: str | None = None, limit: int = 120) -> tuple[dict[str, float], str]:
    if query_vec is None:
        return {}, "none"
    if QDRANT_URL:
        qdrant_scores = _qdrant_topk(query_vec, kind_exact=kind_exact, kind_prefix=kind_prefix, limit=limit)
        if qdrant_scores:
            return qdrant_scores, "qdrant"
        namespace = kind_exact or (f"{kind_prefix}*" if kind_prefix else "all")
        if namespace not in _QDRANT_SEED_ATTEMPTED:
            _QDRANT_SEED_ATTEMPTED.add(namespace)
            seeded = _qdrant_seed_from_sqlite(kind_exact=kind_exact, kind_prefix=kind_prefix)
            if seeded:
                retry_scores = _qdrant_topk(query_vec, kind_exact=kind_exact, kind_prefix=kind_prefix, limit=limit)
                if retry_scores:
                    return retry_scores, "qdrant"
    sqlite_scores = _sqlite_topk(query_vec, kind_exact=kind_exact, kind_prefix=kind_prefix, limit=limit)
    if sqlite_scores:
        return sqlite_scores, "sqlite"
    return {}, "none"


def _late_interaction_rerank(
    query: str,
    query_tokens: set[str],
    query_vec,
    docs_by_id: dict[str, SearchDocument],
    candidate_ids: list[str],
    chunk_bm25_scores: dict[str, float],
) -> tuple[dict[str, float], dict[str, dict[str, object]]]:
    if not candidate_ids:
        return {}, {}

    # Keep reranking bounded and focused.
    selected_ids = candidate_ids[: max(1, RERANK_TOP_N)]
    selected_chunks: list[ChunkRecord] = []
    for doc_id in selected_ids:
        doc = docs_by_id.get(doc_id)
        if not doc:
            continue
        selected_chunks.extend(doc.chunks[: min(8, len(doc.chunks))])

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
    query_norm = float(np.linalg.norm(query_vec)) if np is not None and query_vec is not None else 0.0

    for doc_id in selected_ids:
        doc = docs_by_id.get(doc_id)
        if not doc:
            continue
        best_score = 0.0
        best_chunk: ChunkRecord | None = None
        for chunk in doc.chunks:
            chunk_token_set = set(chunk.tokens)
            token_coverage = (len(query_tokens & chunk_token_set) / max(1, len(query_tokens))) if query_tokens else 0.0
            phrase_bonus = 1.0 if query_lower and query_lower in chunk.text.lower() else 0.0
            bm25_chunk = chunk_norm.get(chunk.id, 0.0)

            dense_score = 0.0
            if query_vec is not None and query_norm > 0 and np is not None:
                vec = chunk_vectors.get(chunk.id)
                if vec is not None:
                    denom = query_norm * float(np.linalg.norm(vec))
                    if denom > 0:
                        dense_score = max(0.0, float(np.dot(query_vec, vec) / denom))

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
    query_tokens = _tokenize(query)
    if not query_tokens:
        return [], {}

    docs_by_id = {doc.id: doc for doc in docs}
    doc_token_map = {doc.id: doc.tokens for doc in docs}
    doc_bm25_scores = _bm25_scores(query_tokens, doc_token_map)
    lexical_scores = {doc.id: lexical_similarity(query, doc.text) for doc in docs if doc.text}
    lexical_scores = {key: score for key, score in lexical_scores.items() if score > 0}

    chunk_token_map: dict[str, tuple[str, ...]] = {}
    chunk_parent_map: dict[str, str] = {}
    for doc in docs:
        for chunk in doc.chunks:
            chunk_token_map[chunk.id] = chunk.tokens
            chunk_parent_map[chunk.id] = doc.id
    chunk_bm25 = _bm25_scores(query_tokens, chunk_token_map)
    parent_chunk_scores: dict[str, float] = {}
    for chunk_id, score in chunk_bm25.items():
        parent_id = chunk_parent_map.get(chunk_id)
        if not parent_id:
            continue
        parent_chunk_scores[parent_id] = max(parent_chunk_scores.get(parent_id, 0.0), score)

    rrf_scores = _rrf_fuse(
        [dense_scores, doc_bm25_scores, lexical_scores, parent_chunk_scores],
        weights=[1.0, 0.95, 0.55, 0.74],
    )

    dense_norm = _normalize_scores(dense_scores)
    bm25_norm = _normalize_scores(doc_bm25_scores)
    lexical_norm = _normalize_scores(lexical_scores)
    chunk_norm = _normalize_scores(parent_chunk_scores)
    rrf_norm = _normalize_scores(rrf_scores)

    base_scores: dict[str, float] = {}
    for item_id in set(docs_by_id.keys()) | set(dense_scores.keys()) | set(doc_bm25_scores.keys()) | set(rrf_scores.keys()):
        score = (
            (rrf_norm.get(item_id, 0.0) * 0.44)
            + (dense_norm.get(item_id, 0.0) * 0.24)
            + (bm25_norm.get(item_id, 0.0) * 0.2)
            + (chunk_norm.get(item_id, 0.0) * 0.08)
            + (lexical_norm.get(item_id, 0.0) * 0.04)
        )
        if score > 0:
            base_scores[item_id] = score

    ranked_ids = [item_id for item_id, _ in sorted(base_scores.items(), key=lambda item: item[1], reverse=True)]
    if not ranked_ids:
        return [], {}

    rerank_scores, best_chunk_map = _late_interaction_rerank(
        query=query,
        query_tokens=set(query_tokens),
        query_vec=query_vec,
        docs_by_id=docs_by_id,
        candidate_ids=ranked_ids,
        chunk_bm25_scores=chunk_bm25,
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

    topic_docs = _prepare_docs("topic", topics, lambda row: f"{row.get('name') or ''}\n{row.get('description') or ''}")
    task_docs = _prepare_docs("task", tasks, lambda row: f"{row.get('title') or ''}\n{row.get('status') or ''}")
    log_docs = _prepare_docs("log", logs, _log_text)

    query_vec = _embed_query(q)
    topic_dense, topic_backend = _vector_topk(query_vec, kind_exact="topic", limit=max(topic_limit * 4, 80))
    task_dense, task_backend = _vector_topk(query_vec, kind_prefix="task:", limit=max(task_limit * 4, 140))
    log_dense, log_backend = _vector_topk(query_vec, kind_exact="log", limit=max(log_limit * 2, 220))

    topic_ranked, topic_chunks = _hybrid_rank(q, topic_docs, topic_dense, query_vec, topic_limit)
    task_ranked, task_chunks = _hybrid_rank(q, task_docs, task_dense, query_vec, task_limit)
    log_ranked, log_chunks = _hybrid_rank(q, log_docs, log_dense, query_vec, log_limit)

    topic_map = {str(item.get("id") or ""): item for item in topics}
    task_map = {str(item.get("id") or ""): item for item in tasks}
    log_map = {str(item.get("id") or ""): item for item in logs}

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
