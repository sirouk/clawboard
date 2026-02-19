#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
ENV_FILE = Path(os.environ.get("CLAWBOARD_ENV_FILE", str(REPO_ROOT / ".env"))).expanduser()
REPLY_DIRECTIVE_TAG_RE = re.compile(
    r"(?:\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]|\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\])\s*",
    flags=re.IGNORECASE,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read_env(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            data[key] = value
    return data


def _prepare_env() -> None:
    env = _read_env(ENV_FILE)
    if "CLAWBOARD_DB_URL" not in os.environ:
        value = env.get("CLAWBOARD_DB_URL", "").strip()
        if value:
            os.environ["CLAWBOARD_DB_URL"] = value


def _strip_reply_directives(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    text = REPLY_DIRECTIVE_TAG_RE.sub(" ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


@dataclass
class Counters:
    scanned: int = 0
    changed_logs: int = 0
    changed_content: int = 0
    changed_summary: int = 0
    changed_raw: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "One-time cleanup for historical logs: strip OpenClaw reply directive tags "
            "([[reply_to_current]] / [[reply_to:<id>]] and [reply_to_current] / [reply_to:<id>]) "
            "from stored content/summary/raw."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Persist changes. Without this flag, runs in dry-run mode.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Required with --apply to confirm writes.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional max number of log rows to scan (default: all).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print each changed log id in dry-run mode.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.apply and not args.yes:
        print("error: --apply requires --yes", file=sys.stderr)
        return 2

    _prepare_env()
    if str(BACKEND_ROOT) not in sys.path:
        sys.path.insert(0, str(BACKEND_ROOT))

    try:
        from sqlmodel import Session, select  # noqa: WPS433 (runtime import required after env setup)
    except Exception as exc:
        print("error: python dependency 'sqlmodel' is required for this script.", file=sys.stderr)
        print(f"detail: {exc}", file=sys.stderr)
        print(
            "hint: run inside the backend environment/container, or install deps first "
            "(for example: pip install -r backend/requirements.txt).",
            file=sys.stderr,
        )
        return 2

    try:
        from app.db import DATABASE_URL, engine, init_db  # noqa: WPS433
        from app.models import LogEntry  # noqa: WPS433
    except Exception as exc:
        print("error: failed to import clawboard backend modules.", file=sys.stderr)
        print(f"detail: {exc}", file=sys.stderr)
        print("hint: ensure backend dependencies are installed and CLAWBOARD_DB_URL is valid.", file=sys.stderr)
        return 2

    init_db()
    counters = Counters()
    changed_ids: list[str] = []
    mode = "APPLY" if args.apply else "DRY-RUN"

    print(f"one_time_strip_reply_directives: mode={mode} db={DATABASE_URL}")
    if args.limit > 0:
        print(f"one_time_strip_reply_directives: limit={args.limit}")

    with Session(engine) as session:
        statement = select(LogEntry).order_by(LogEntry.createdAt.asc(), LogEntry.id.asc())
        if args.limit > 0:
            statement = statement.limit(args.limit)
        rows = session.exec(statement).all()

        for row in rows:
            counters.scanned += 1
            changed = False

            next_content = _strip_reply_directives(row.content)
            if next_content != row.content:
                row.content = next_content or ""
                counters.changed_content += 1
                changed = True

            next_summary = _strip_reply_directives(row.summary)
            if next_summary != row.summary:
                row.summary = next_summary
                counters.changed_summary += 1
                changed = True

            next_raw = _strip_reply_directives(row.raw)
            if next_raw != row.raw:
                row.raw = next_raw
                counters.changed_raw += 1
                changed = True

            if not changed:
                continue

            counters.changed_logs += 1
            changed_ids.append(row.id)
            if args.verbose and not args.apply:
                print(f"- would update log {row.id}")

            if args.apply:
                row.updatedAt = _now_iso()
                session.add(row)

        if args.apply and counters.changed_logs > 0:
            session.commit()

    print(
        "one_time_strip_reply_directives: "
        f"scanned={counters.scanned} changed_logs={counters.changed_logs} "
        f"content={counters.changed_content} summary={counters.changed_summary} raw={counters.changed_raw}"
    )
    if counters.changed_logs > 0:
        sample = ", ".join(changed_ids[:5])
        suffix = " ..." if len(changed_ids) > 5 else ""
        print(f"one_time_strip_reply_directives: sample_ids={sample}{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
