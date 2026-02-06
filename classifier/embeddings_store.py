import os
import sqlite3
import time
from typing import Iterable

import numpy as np
import requests

DB_PATH = os.environ.get("CLASSIFIER_EMBED_DB", "/data/classifier_embeddings.db")
QDRANT_URL = os.environ.get("QDRANT_URL")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "clawboard_embeddings")
QDRANT_DIM = int(os.environ.get("QDRANT_DIM", "384"))


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
    return {"Content-Type": "application/json"}


def _ensure_qdrant_collection():
    if not _use_qdrant():
        return
    try:
        r = requests.get(f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}", timeout=10)
        if r.status_code == 200:
            return
    except Exception:
        pass
    payload = {"vectors": {"size": QDRANT_DIM, "distance": "Cosine"}}
    requests.put(
        f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}",
        headers=_qdrant_headers(),
        json=payload,
        timeout=20,
    ).raise_for_status()


def upsert(kind: str, item_id: str, vector: Iterable[float]):
    if _use_qdrant():
        _ensure_qdrant_collection()
        vec = list(vector)
        payload = {"points": [{"id": f"{kind}:{item_id}", "vector": vec, "payload": {"kind": kind, "id": item_id}}]}
        requests.put(
            f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points",
            headers=_qdrant_headers(),
            json=payload,
            timeout=20,
        ).raise_for_status()
        return
    arr = np.asarray(list(vector), dtype=np.float32)
    blob = arr.tobytes()
    now = int(time.time())
    with _conn() as conn:
        conn.execute(
            "INSERT INTO embeddings(kind, id, vector, dim, updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(kind, id) DO UPDATE SET vector=excluded.vector, dim=excluded.dim, updated_at=excluded.updated_at",
            (kind, item_id, blob, int(arr.shape[0]), now),
        )
        conn.commit()


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
        _ensure_qdrant_collection()
        payload = {
            "vector": list(query_vec),
            "limit": k,
            "with_payload": True,
            "filter": {"must": [{"key": "kind", "match": {"value": kind}}]},
        }
        r = requests.post(
            f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points/search",
            headers=_qdrant_headers(),
            json=payload,
            timeout=20,
        )
        r.raise_for_status()
        res = r.json().get("result", [])
        return [(hit["payload"]["id"], float(hit["score"])) for hit in res if hit.get("payload")]
    q = np.asarray(list(query_vec), dtype=np.float32)
    scored = []
    for item_id, vec in get_all(kind):
        scored.append((item_id, cosine_sim(q, vec)))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:k]
