#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Iterable, Callable, Any

from sqlmodel import SQLModel, Session, create_engine, select
from sqlalchemy import text


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.models import (  # noqa: E402
    Attachment,
    DeletedLog,
    Draft,
    IngestQueue,
    InstanceConfig,
    LogEntry,
    SessionRoutingMemory,
    Space,
    Task,
    Topic,
)


DEFAULT_SOURCE_URL = "sqlite:///./data/clawboard.db"
DEFAULT_TARGET_URL = os.environ.get("CLAWBOARD_DB_URL", "postgresql+psycopg://clawboard:clawboard@localhost:5432/clawboard")

MODEL_ORDER = [
    InstanceConfig,
    Space,
    Topic,
    Task,
    LogEntry,
    DeletedLog,
    SessionRoutingMemory,
    IngestQueue,
    Attachment,
    Draft,
]


def _make_engine(url: str):
    kwargs: dict[str, object] = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 3}
    return create_engine(url, **kwargs)


def _table_name(model: type[SQLModel]) -> str:
    return str(getattr(model, "__tablename__", model.__name__.lower()))


def _iter_rows(session: Session, model: type[SQLModel]) -> Iterable[SQLModel]:
    return session.exec(select(model))


def _copy_model(
    source_session: Session,
    target_session: Session,
    model: type[SQLModel],
    *,
    batch_size: int,
    dry_run: bool,
    normalize_payload: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> int:
    copied = 0
    for row in _iter_rows(source_session, model):
        copied += 1
        if dry_run:
            continue
        payload = row.model_dump()
        if normalize_payload is not None:
            payload = normalize_payload(payload)
        target_session.merge(model(**payload))
        if copied % max(1, batch_size) == 0:
            target_session.commit()
    if not dry_run:
        target_session.commit()
    return copied


def _truncate_target(target_session: Session) -> None:
    table_names = [_table_name(model) for model in MODEL_ORDER]
    joined = ", ".join(f'"{name}"' for name in table_names)
    target_session.exec(text(f"TRUNCATE TABLE {joined} RESTART IDENTITY CASCADE"))
    target_session.commit()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrate Clawboard canonical data from SQLite to Postgres.",
    )
    parser.add_argument(
        "--source-url",
        default=DEFAULT_SOURCE_URL,
        help=f"Source SQLAlchemy URL (default: {DEFAULT_SOURCE_URL})",
    )
    parser.add_argument(
        "--target-url",
        default=DEFAULT_TARGET_URL,
        help="Target SQLAlchemy URL (default: CLAWBOARD_DB_URL or local Postgres).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="Rows per target commit (default: 500).",
    )
    parser.add_argument(
        "--truncate-target",
        action="store_true",
        help="Truncate known Clawboard tables in target before copy.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show copy counts without writing to target.",
    )
    parser.add_argument(
        "--skip-init-db",
        action="store_true",
        help="Skip backend init_db() on target after copy.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Required for non-dry-run execution.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_url = str(args.source_url or "").strip()
    target_url = str(args.target_url or "").strip()

    if not source_url:
        print("error: missing --source-url", file=sys.stderr)
        return 2
    if not target_url:
        print("error: missing --target-url", file=sys.stderr)
        return 2
    if not target_url.startswith("postgresql"):
        print("error: --target-url must be a Postgres URL (postgresql+psycopg://...)", file=sys.stderr)
        return 2
    if not args.dry_run and not args.yes:
        print("error: refusing to run without --yes (or use --dry-run).", file=sys.stderr)
        return 2

    source_engine = _make_engine(source_url)
    target_engine = _make_engine(target_url)

    print(f"source: {source_url}")
    print(f"target: {target_url}")
    print(f"dry_run: {bool(args.dry_run)}")
    print(f"truncate_target: {bool(args.truncate_target)}")

    # Ensure schema exists before copy.
    SQLModel.metadata.create_all(target_engine)

    counts: dict[str, int] = {}
    with Session(source_engine) as source_session, Session(target_engine) as target_session:
        source_topics = source_session.exec(select(Topic)).all()
        source_tasks = source_session.exec(select(Task)).all()
        source_logs = source_session.exec(select(LogEntry)).all()
        valid_topic_ids = {str(item.id or "").strip() for item in source_topics if str(item.id or "").strip()}
        valid_task_ids = {str(item.id or "").strip() for item in source_tasks if str(item.id or "").strip()}
        valid_log_ids = {str(item.id or "").strip() for item in source_logs if str(item.id or "").strip()}

        def _normalize_task(payload: dict[str, Any]) -> dict[str, Any]:
            topic_id = str(payload.get("topicId") or "").strip()
            if topic_id and topic_id not in valid_topic_ids:
                payload["topicId"] = None
            return payload

        def _normalize_log(payload: dict[str, Any]) -> dict[str, Any]:
            topic_id = str(payload.get("topicId") or "").strip()
            task_id = str(payload.get("taskId") or "").strip()
            if topic_id and topic_id not in valid_topic_ids:
                payload["topicId"] = None
            if task_id and task_id not in valid_task_ids:
                payload["taskId"] = None
            return payload

        def _normalize_attachment(payload: dict[str, Any]) -> dict[str, Any]:
            log_id = str(payload.get("logId") or "").strip()
            if log_id and log_id not in valid_log_ids:
                payload["logId"] = None
            return payload

        normalizers: dict[type[SQLModel], Callable[[dict[str, Any]], dict[str, Any]]] = {
            Task: _normalize_task,
            LogEntry: _normalize_log,
            Attachment: _normalize_attachment,
        }

        if args.truncate_target:
            if args.dry_run:
                print("target truncate: skipped (dry-run)")
            else:
                print("target truncate: start")
                _truncate_target(target_session)
                print("target truncate: done")

        for model in MODEL_ORDER:
            name = _table_name(model)
            copied = _copy_model(
                source_session,
                target_session,
                model,
                batch_size=max(1, int(args.batch_size)),
                dry_run=bool(args.dry_run),
                normalize_payload=normalizers.get(model),
            )
            counts[name] = copied
            print(f"{name}: {copied}")

    if not args.dry_run and not args.skip_init_db:
        # Re-run backend DB bootstrap against the target so runtime indexes/migrations are aligned.
        os.environ["CLAWBOARD_DB_URL"] = target_url
        from app.db import init_db as init_target_db  # noqa: E402

        init_target_db()
        print("target init_db: done")

    print("migration complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
