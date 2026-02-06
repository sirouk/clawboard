import os
import sqlite3
import time
import uuid
from typing import Iterable

import numpy as np
import requests

DB_PATH = os.environ.get("CLASSIFIER_EMBED_DB", "/data/classifier_embeddings.db")
QDRANT_URL = os.environ.get("QDRANT_URL")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "clawboard_embeddings")
QDRANT_DIM = int(os.environ.get("QDRANT_DIM", "384"))
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY")
QDRANT_TIMEOUT = float(os.environ.get("QDRANT_TIMEOUT", "8"))


def _use_qdrant() -> bool:
    return bool(QDRANT_URL)


def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS embeddings (
          kind TEXT NOT NULL,
          id TEXT NOT NULL,
          vector BLOB NOT NULL,
          dim INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(kind, id)
        )
        """
    )
    return conn


def _qdrant_headers():
    headers = {"Content-Type": "application/json"}
    if QDRANT_API_KEY:
        headers["api-key"] = QDRANT_API_KEY
    return headers


def _qdrant_point_id(kind: str, item_id: str) -> str:
    # Qdrant requires point ids as uint or UUID. Use deterministic UUIDv5 for idempotent upserts.
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"clawboard:{kind}:{item_id}"))


def _ensure_qdrant_collection():
    if not _use_qdrant():
        return
    try:
        r = requests.get(f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}", timeout=QDRANT_TIMEOUT)
        if r.status_code == 200:
            return
    except Exception:
        pass
    payload = {
        "vectors": {"size": QDRANT_DIM, "distance": "Cosine"},
        "hnsw_config": {"m": 32, "ef_construct": 256, "full_scan_threshold": 20000},
        "optimizers_config": {"default_segment_number": 2},
    }
    requests.put(
        f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}",
        headers=_qdrant_headers(),
        json=payload,
        timeout=QDRANT_TIMEOUT,
    ).raise_for_status()


def upsert(kind: str, item_id: str, vector: Iterable[float]):
    arr = np.asarray(list(vector), dtype=np.float32)
    blob = arr.tobytes()
    now = int(time.time())

    # Always mirror into sqlite for local fallback / portability.
    with _conn() as conn:
        conn.execute(
            "INSERT INTO embeddings(kind, id, vector, dim, updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(kind, id) DO UPDATE SET vector=excluded.vector, dim=excluded.dim, updated_at=excluded.updated_at",
            (kind, item_id, blob, int(arr.shape[0]), now),
        )
        conn.commit()

    if _use_qdrant():
        try:
            _ensure_qdrant_collection()
            vec = arr.astype(float).tolist()
            kind_root = kind.split(":", 1)[0] if ":" in kind else kind
            payload = {
                "points": [
                    {
                        "id": _qdrant_point_id(kind, item_id),
                        "vector": vec,
                        "payload": {
                            "kind": kind,
                            "kindRoot": kind_root,
                            "id": item_id,
                        },
                    }
                ]
            }
            requests.put(
                f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points",
                headers=_qdrant_headers(),
                json=payload,
                timeout=QDRANT_TIMEOUT,
            ).raise_for_status()
        except Exception:
            # Sqlite fallback already persisted above.
            pass
        return


def get_all(kind: str):
    if _use_qdrant():
        _ensure_qdrant_collection()
        # Qdrant doesn't provide a cheap full scan without scroll; avoid for qdrant mode.
        return []
    with _conn() as conn:
        rows = conn.execute("SELECT id, vector, dim FROM embeddings WHERE kind=?", (kind,)).fetchall()
    out = []
    for item_id, blob, dim in rows:
        arr = np.frombuffer(blob, dtype=np.float32, count=int(dim))
        out.append((item_id, arr))
    return out


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def topk(kind: str, query_vec: Iterable[float], k: int = 5):
    if _use_qdrant():
        try:
            _ensure_qdrant_collection()
            payload = {
                "vector": np.asarray(list(query_vec), dtype=np.float32).astype(float).tolist(),
                "limit": max(k * 4, 24),
                "with_payload": True,
                "filter": {"must": [{"key": "kind", "match": {"value": kind}}]},
            }
            r = requests.post(
                f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points/search",
                headers=_qdrant_headers(),
                json=payload,
                timeout=QDRANT_TIMEOUT,
            )
            r.raise_for_status()
            res = r.json().get("result", [])
            rows = []
            for hit in res:
                if not isinstance(hit, dict):
                    continue
                payload = hit.get("payload") if isinstance(hit.get("payload"), dict) else {}
                item_id = str(payload.get("id") or "").strip()
                if not item_id:
                    continue
                rows.append((item_id, float(hit.get("score") or 0.0)))
            if rows:
                rows.sort(key=lambda item: item[1], reverse=True)
                return rows[:k]
        except Exception:
            pass
    q = np.asarray(list(query_vec), dtype=np.float32)
    scored = []
    for item_id, vec in get_all(kind):
        scored.append((item_id, cosine_sim(q, vec)))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:k]
