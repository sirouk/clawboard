#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP_DIR = os.path.join(ROOT_DIR, "backend", "app")
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

from vector_maintenance import (  # noqa: E402
    resolve_clawboard_db_path,
    resolve_embeddings_db_path,
    resolve_reindex_queue_path,
    run_one_time_vector_cleanup,
)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="One-time cleanup pass for Clawboard embeddings (stale + non-semantic vectors).",
    )
    parser.add_argument(
        "--clawboard-db",
        default=resolve_clawboard_db_path(),
        help="Path to Clawboard sqlite DB (default: resolved from CLAWBOARD_DB_URL or ./data/clawboard.db).",
    )
    parser.add_argument(
        "--embeddings-db",
        default=resolve_embeddings_db_path(),
        help="Path to embeddings sqlite DB (default: CLASSIFIER_EMBED_DB/CLAWBOARD_VECTOR_DB_PATH or ./data/classifier_embeddings.db).",
    )
    parser.add_argument(
        "--queue-path",
        default=resolve_reindex_queue_path(),
        help="Path to reindex queue jsonl (default: CLAWBOARD_REINDEX_QUEUE_PATH/CLASSIFIER_REINDEX_QUEUE_PATH or ./data/reindex-queue.jsonl).",
    )
    parser.add_argument(
        "--qdrant-url",
        default=(os.getenv("QDRANT_URL") or os.getenv("CLAWBOARD_QDRANT_URL") or "").strip(),
        help="Optional Qdrant base URL, e.g. http://localhost:6333.",
    )
    parser.add_argument(
        "--qdrant-collection",
        default=(os.getenv("QDRANT_COLLECTION") or os.getenv("CLAWBOARD_QDRANT_COLLECTION") or "clawboard_embeddings").strip(),
        help="Qdrant collection name.",
    )
    parser.add_argument(
        "--qdrant-api-key",
        default=(os.getenv("QDRANT_API_KEY") or os.getenv("CLAWBOARD_QDRANT_API_KEY") or "").strip(),
        help="Optional Qdrant API key.",
    )
    parser.add_argument(
        "--qdrant-timeout-sec",
        type=float,
        default=5.0,
        help="Qdrant delete timeout in seconds.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute cleanup plan without writing any changes.",
    )
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    report = run_one_time_vector_cleanup(
        clawboard_db_path=args.clawboard_db,
        embeddings_db_path=args.embeddings_db,
        queue_path=args.queue_path,
        qdrant_url=args.qdrant_url,
        qdrant_collection=args.qdrant_collection,
        qdrant_api_key=args.qdrant_api_key or None,
        qdrant_timeout_sec=float(args.qdrant_timeout_sec),
        dry_run=bool(args.dry_run),
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
