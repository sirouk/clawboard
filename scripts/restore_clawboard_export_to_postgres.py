#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import text
from sqlmodel import SQLModel, Session, create_engine


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


DEFAULT_TARGET_URL = os.environ.get(
    "CLAWBOARD_DB_URL",
    "postgresql+psycopg://clawboard:clawboard@localhost:5432/clawboard",
)
DEFAULT_SPACE_ID = "space-default"

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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _make_engine(url: str):
    return create_engine(url, echo=False)


def _table_name(model: type[SQLModel]) -> str:
    return str(getattr(model, "__tablename__", model.__name__.lower()))


def _truncate_target(target_session: Session) -> None:
    table_names = [_table_name(model) for model in MODEL_ORDER]
    joined = ", ".join(f'"{name}"' for name in table_names)
    target_session.exec(text(f"TRUNCATE TABLE {joined} RESTART IDENTITY CASCADE"))
    target_session.commit()


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            text_line = line.strip()
            if not text_line:
                continue
            item = json.loads(text_line)
            if isinstance(item, dict):
                rows.append(item)
    return rows


def _model_payload(model: type[SQLModel], payload: dict[str, Any]) -> dict[str, Any]:
    keys = set(getattr(model, "model_fields", {}).keys())
    return {k: v for k, v in payload.items() if k in keys}


def _copy_rows(
    target_session: Session,
    model: type[SQLModel],
    rows: list[dict[str, Any]],
    *,
    batch_size: int,
    dry_run: bool,
    normalize_payload: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> int:
    copied = 0
    for row in rows:
        copied += 1
        if dry_run:
            continue
        payload = _model_payload(model, row)
        if normalize_payload is not None:
            payload = normalize_payload(payload)
        target_session.merge(model(**payload))
        if copied % max(1, int(batch_size)) == 0:
            target_session.commit()
    if not dry_run:
        target_session.commit()
    return copied


def _load_export(export_dir: Path) -> dict[str, Any]:
    config = _load_json(export_dir / "config.json", {})
    spaces = _load_json(export_dir / "spaces.json", [])
    topics = _load_json(export_dir / "topics.json", [])
    tasks = _load_json(export_dir / "tasks.json", [])
    attachments = _load_json(export_dir / "attachments.json", [])
    logs = _load_jsonl(export_dir / "logs.jsonl")

    if not isinstance(config, dict):
        raise RuntimeError("config.json must be a JSON object")
    if not isinstance(spaces, list):
        raise RuntimeError("spaces.json must be a JSON array")
    if not isinstance(topics, list):
        raise RuntimeError("topics.json must be a JSON array")
    if not isinstance(tasks, list):
        raise RuntimeError("tasks.json must be a JSON array")
    if not isinstance(attachments, list):
        raise RuntimeError("attachments.json must be a JSON array")

    spaces = [row for row in spaces if isinstance(row, dict)]
    topics = [row for row in topics if isinstance(row, dict)]
    tasks = [row for row in tasks if isinstance(row, dict)]
    attachments = [row for row in attachments if isinstance(row, dict)]

    return {
        "config": config,
        "spaces": spaces,
        "topics": topics,
        "tasks": tasks,
        "attachments": attachments,
        "logs": logs,
    }


def _sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 256)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _derive_attachment_rows(
    logs: list[dict[str, Any]],
    attachments_seed: list[dict[str, Any]],
    *,
    attachments_dir: Path | None,
) -> list[dict[str, Any]]:
    now = _now_iso()
    log_meta: dict[str, dict[str, Any]] = {}
    for row in logs:
        log_id = str(row.get("id") or "").strip()
        if not log_id:
            continue
        created_at = str(row.get("createdAt") or "").strip() or now
        updated_at = str(row.get("updatedAt") or "").strip() or created_at
        raw_attachments = row.get("attachments")
        if not isinstance(raw_attachments, list):
            continue
        for raw in raw_attachments:
            if not isinstance(raw, dict):
                continue
            att_id = str(raw.get("id") or "").strip()
            if not att_id:
                continue
            base = log_meta.get(att_id, {})
            base["id"] = att_id
            base["logId"] = base.get("logId") or log_id
            base["fileName"] = str(raw.get("fileName") or base.get("fileName") or att_id)
            base["mimeType"] = str(raw.get("mimeType") or base.get("mimeType") or "application/octet-stream")
            size = raw.get("sizeBytes")
            if isinstance(size, int):
                base["sizeBytes"] = size
            elif "sizeBytes" not in base:
                base["sizeBytes"] = 0
            base["createdAt"] = base.get("createdAt") or created_at
            base["updatedAt"] = max(str(base.get("updatedAt") or ""), updated_at) or updated_at
            log_meta[att_id] = base

    merged: dict[str, dict[str, Any]] = {k: dict(v) for k, v in log_meta.items()}
    for seed in attachments_seed:
        att_id = str(seed.get("id") or "").strip()
        if not att_id:
            continue
        base = merged.get(att_id, {})
        base["id"] = att_id
        base["logId"] = str(seed.get("logId") or base.get("logId") or "").strip() or None
        base["fileName"] = str(seed.get("fileName") or base.get("fileName") or att_id)
        base["mimeType"] = str(seed.get("mimeType") or base.get("mimeType") or "application/octet-stream")
        size = seed.get("sizeBytes")
        if isinstance(size, int):
            base["sizeBytes"] = size
        elif "sizeBytes" not in base:
            base["sizeBytes"] = 0
        base["createdAt"] = str(seed.get("createdAt") or base.get("createdAt") or now)
        base["updatedAt"] = str(seed.get("updatedAt") or base.get("updatedAt") or base["createdAt"])
        merged[att_id] = base

    rows: list[dict[str, Any]] = []
    for att_id in sorted(merged.keys()):
        item = merged[att_id]
        file_name = str(item.get("fileName") or att_id)
        mime_type = str(item.get("mimeType") or "application/octet-stream")
        size_bytes = int(item.get("sizeBytes") or 0)
        created_at = str(item.get("createdAt") or now)
        updated_at = str(item.get("updatedAt") or created_at)
        storage_path = att_id
        sha256 = str(item.get("sha256") or "").strip()
        if attachments_dir is not None:
            candidate = attachments_dir / storage_path
            if candidate.exists():
                sha256 = _sha256_of_file(candidate)
                size_bytes = candidate.stat().st_size
        if not sha256:
            sha256 = hashlib.sha256(att_id.encode("utf-8")).hexdigest()
        rows.append(
            {
                "id": att_id,
                "logId": item.get("logId"),
                "fileName": file_name,
                "mimeType": mime_type,
                "sizeBytes": size_bytes,
                "sha256": sha256,
                "storagePath": storage_path,
                "createdAt": created_at,
                "updatedAt": updated_at,
            }
        )
    return rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Restore Clawboard export JSON files into Postgres.",
    )
    parser.add_argument(
        "--export-dir",
        required=True,
        help="Directory containing config.json/topics.json/tasks.json/logs.jsonl (and optional spaces/attachments).",
    )
    parser.add_argument(
        "--target-url",
        default=DEFAULT_TARGET_URL,
        help="Target SQLAlchemy URL (default: CLAWBOARD_DB_URL or local Postgres).",
    )
    parser.add_argument(
        "--attachments-dir",
        default="",
        help="Optional path to attachment files directory (default: <export-dir>/../attachments when present).",
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
        help="Truncate known Clawboard tables in target before restore.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show restore counts without writing to target.",
    )
    parser.add_argument(
        "--skip-init-db",
        action="store_true",
        help="Skip backend init_db() on target after restore.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Required for non-dry-run execution.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    export_dir = Path(str(args.export_dir or "")).expanduser().resolve()
    target_url = str(args.target_url or "").strip()
    if not export_dir.exists():
        print(f"error: export dir not found: {export_dir}", file=sys.stderr)
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

    attachments_dir: Path | None = None
    if args.attachments_dir:
        attachments_dir = Path(args.attachments_dir).expanduser().resolve()
    else:
        default_attachments = (export_dir.parent / "attachments").resolve()
        if default_attachments.exists():
            attachments_dir = default_attachments

    print(f"export_dir: {export_dir}")
    print(f"target: {target_url}")
    print(f"dry_run: {bool(args.dry_run)}")
    print(f"truncate_target: {bool(args.truncate_target)}")
    print(f"attachments_dir: {attachments_dir if attachments_dir else '<none>'}")

    data = _load_export(export_dir)
    config = data["config"]
    spaces: list[dict[str, Any]] = data["spaces"]
    topics: list[dict[str, Any]] = data["topics"]
    tasks: list[dict[str, Any]] = data["tasks"]
    logs: list[dict[str, Any]] = data["logs"]
    attachments_seed: list[dict[str, Any]] = data["attachments"]

    instance_payload = config.get("instance") if isinstance(config.get("instance"), dict) else {}
    instance_rows = [instance_payload] if isinstance(instance_payload, dict) and instance_payload else []

    if not spaces:
        now = _now_iso()
        seen_spaces: set[str] = {DEFAULT_SPACE_ID}
        for row in topics + tasks + logs:
            sid = str(row.get("spaceId") or "").strip()
            if sid:
                seen_spaces.add(sid)
        spaces = [
            {
                "id": sid,
                "name": "Default" if sid == DEFAULT_SPACE_ID else sid,
                "color": None,
                "defaultVisible": True,
                "connectivity": {},
                "createdAt": now,
                "updatedAt": now,
            }
            for sid in sorted(seen_spaces)
        ]

    valid_space_ids = {str(row.get("id") or "").strip() for row in spaces if str(row.get("id") or "").strip()}
    if DEFAULT_SPACE_ID not in valid_space_ids:
        now = _now_iso()
        spaces.append(
            {
                "id": DEFAULT_SPACE_ID,
                "name": "Default",
                "color": None,
                "defaultVisible": True,
                "connectivity": {},
                "createdAt": now,
                "updatedAt": now,
            }
        )
        valid_space_ids.add(DEFAULT_SPACE_ID)

    valid_topic_ids = {str(row.get("id") or "").strip() for row in topics if str(row.get("id") or "").strip()}
    valid_task_ids = {str(row.get("id") or "").strip() for row in tasks if str(row.get("id") or "").strip()}

    def _normalize_topic(payload: dict[str, Any]) -> dict[str, Any]:
        out = dict(payload)
        space_id = str(out.get("spaceId") or "").strip()
        if not space_id or space_id not in valid_space_ids:
            out["spaceId"] = DEFAULT_SPACE_ID
        return out

    def _normalize_task(payload: dict[str, Any]) -> dict[str, Any]:
        out = dict(payload)
        topic_id = str(out.get("topicId") or "").strip()
        if topic_id and topic_id not in valid_topic_ids:
            out["topicId"] = None
            topic_id = ""
        if topic_id:
            topic_space = str(next((t.get("spaceId") for t in topics if str(t.get("id") or "") == topic_id), "") or "")
            if topic_space in valid_space_ids:
                out["spaceId"] = topic_space
        space_id = str(out.get("spaceId") or "").strip()
        if not space_id or space_id not in valid_space_ids:
            out["spaceId"] = DEFAULT_SPACE_ID
        return out

    def _normalize_log(payload: dict[str, Any]) -> dict[str, Any]:
        out = dict(payload)
        topic_id = str(out.get("topicId") or "").strip()
        task_id = str(out.get("taskId") or "").strip()
        if topic_id and topic_id not in valid_topic_ids:
            out["topicId"] = None
            topic_id = ""
        if task_id and task_id not in valid_task_ids:
            out["taskId"] = None
            task_id = ""
        if task_id:
            task_topic = str(next((t.get("topicId") for t in tasks if str(t.get("id") or "") == task_id), "") or "")
            if task_topic and task_topic in valid_topic_ids:
                out["topicId"] = task_topic
        space_id = str(out.get("spaceId") or "").strip()
        if task_id:
            task_space = str(next((t.get("spaceId") for t in tasks if str(t.get("id") or "") == task_id), "") or "")
            if task_space in valid_space_ids:
                out["spaceId"] = task_space
        elif topic_id:
            topic_space = str(next((t.get("spaceId") for t in topics if str(t.get("id") or "") == topic_id), "") or "")
            if topic_space in valid_space_ids:
                out["spaceId"] = topic_space
        resolved_space = str(out.get("spaceId") or "").strip()
        if not resolved_space or resolved_space not in valid_space_ids:
            out["spaceId"] = DEFAULT_SPACE_ID
        attachments = out.get("attachments")
        if not isinstance(attachments, list):
            out["attachments"] = None
        return out

    attachment_rows = _derive_attachment_rows(
        logs,
        attachments_seed,
        attachments_dir=attachments_dir,
    )

    valid_log_ids = {str(row.get("id") or "").strip() for row in logs if str(row.get("id") or "").strip()}

    def _normalize_attachment(payload: dict[str, Any]) -> dict[str, Any]:
        out = dict(payload)
        log_id = str(out.get("logId") or "").strip()
        if log_id and log_id not in valid_log_ids:
            out["logId"] = None
        if not str(out.get("storagePath") or "").strip():
            out["storagePath"] = str(out.get("id") or "")
        return out

    target_engine = _make_engine(target_url)
    SQLModel.metadata.create_all(target_engine)

    counts: dict[str, int] = {}
    with Session(target_engine) as target_session:
        if args.truncate_target:
            if args.dry_run:
                print("target truncate: skipped (dry-run)")
            else:
                print("target truncate: start")
                _truncate_target(target_session)
                print("target truncate: done")

        counts["instanceconfig"] = _copy_rows(
            target_session,
            InstanceConfig,
            instance_rows,
            batch_size=max(1, int(args.batch_size)),
            dry_run=bool(args.dry_run),
        )
        counts["space"] = _copy_rows(
            target_session,
            Space,
            spaces,
            batch_size=max(1, int(args.batch_size)),
            dry_run=bool(args.dry_run),
        )
        counts["topic"] = _copy_rows(
            target_session,
            Topic,
            topics,
            batch_size=max(1, int(args.batch_size)),
            dry_run=bool(args.dry_run),
            normalize_payload=_normalize_topic,
        )
        counts["task"] = _copy_rows(
            target_session,
            Task,
            tasks,
            batch_size=max(1, int(args.batch_size)),
            dry_run=bool(args.dry_run),
            normalize_payload=_normalize_task,
        )
        counts["logentry"] = _copy_rows(
            target_session,
            LogEntry,
            logs,
            batch_size=max(1, int(args.batch_size)),
            dry_run=bool(args.dry_run),
            normalize_payload=_normalize_log,
        )
        counts["attachment"] = _copy_rows(
            target_session,
            Attachment,
            attachment_rows,
            batch_size=max(1, int(args.batch_size)),
            dry_run=bool(args.dry_run),
            normalize_payload=_normalize_attachment,
        )

    for name in ["instanceconfig", "space", "topic", "task", "logentry", "attachment"]:
        print(f"{name}: {counts.get(name, 0)}")

    if not args.dry_run and not args.skip_init_db:
        os.environ["CLAWBOARD_DB_URL"] = target_url
        from app.db import init_db as init_target_db  # noqa: E402

        init_target_db()
        print("target init_db: done")

    print("restore complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
