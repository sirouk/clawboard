import os
import sqlite3
import time
from typing import Iterable, Optional

import numpy as np

DB_PATH = os.environ.get("CLASSIFIER_EMBED_DB", "/data/classifier_embeddings.db")


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


def upsert(kind: str, item_id: str, vector: Iterable[float]):
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
    q = np.asarray(list(query_vec), dtype=np.float32)
    scored = []
    for item_id, vec in get_all(kind):
        scored.append((item_id, cosine_sim(q, vec)))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:k]
