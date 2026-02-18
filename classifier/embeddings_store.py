from __future__ import annotations

import os
import uuid
from typing import Iterable

try:
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover
    np = None  # type: ignore
try:
    import requests  # type: ignore
except Exception:  # pragma: no cover
    requests = None  # type: ignore

QDRANT_URL = os.environ.get("QDRANT_URL")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "clawboard_embeddings")
QDRANT_DIM = int(os.environ.get("QDRANT_DIM", "384"))
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY")
QDRANT_TIMEOUT = float(os.environ.get("QDRANT_TIMEOUT", "8"))

def _use_qdrant() -> bool:
    return bool(QDRANT_URL)


def _qdrant_headers():
    headers = {"Content-Type": "application/json"}
    if QDRANT_API_KEY:
        headers["api-key"] = QDRANT_API_KEY
    return headers


def _qdrant_point_id(kind: str, item_id: str) -> str:
    # Qdrant requires point ids as uint or UUID. Use deterministic UUIDv5 for idempotent upserts.
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"clawboard:{kind}:{item_id}"))


def _ensure_qdrant_collection():
    if not _use_qdrant() or requests is None:
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
    if np is None:
        raise RuntimeError("classifier dependency missing: numpy")
    if not _use_qdrant() or requests is None:
        return

    try:
        _ensure_qdrant_collection()
        vec = np.asarray(list(vector), dtype=np.float32).astype(float).tolist()
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
        # Keep classification flow resilient when vector infrastructure is transiently unavailable.
        pass


def delete(kind: str, item_id: str):
    if not _use_qdrant() or requests is None:
        return

    try:
        _ensure_qdrant_collection()
        payload = {"points": [_qdrant_point_id(kind, item_id)]}
        requests.post(
            f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points/delete",
            headers=_qdrant_headers(),
            json=payload,
            timeout=QDRANT_TIMEOUT,
        ).raise_for_status()
    except Exception:
        pass


def delete_task_other_namespaces(item_id: str, keep_kind: str | None = None):
    if not _use_qdrant() or requests is None:
        return

    try:
        _ensure_qdrant_collection()
        flt = {
            "must": [
                {"key": "kindRoot", "match": {"value": "task"}},
                {"key": "id", "match": {"value": item_id}},
            ]
        }
        if keep_kind:
            flt["must_not"] = [{"key": "kind", "match": {"value": keep_kind}}]
        payload = {"filter": flt}
        requests.post(
            f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points/delete",
            headers=_qdrant_headers(),
            json=payload,
            timeout=QDRANT_TIMEOUT,
        ).raise_for_status()
    except Exception:
        pass


def get_all(kind: str):
    # SQLite mirror is retired; full scans are intentionally unsupported here.
    return []


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def topk(kind: str, query_vec: Iterable[float], k: int = 5):
    if np is None:
        raise RuntimeError("classifier dependency missing: numpy")
    if not _use_qdrant() or requests is None:
        return []

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
    return []
