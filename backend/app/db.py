from __future__ import annotations

import os
import hashlib
import colorsys
import re
from pathlib import Path
from sqlmodel import SQLModel, create_engine, Session, select

DATABASE_URL = os.getenv("CLAWBOARD_DB_URL", "sqlite:///./data/clawboard.db")

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, echo=False, connect_args=connect_args)


def _normalize_hex_color(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return text.upper()
    return None


def _auto_color(seed: str, offset: float = 0.0) -> str:
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    hue = ((int(digest[:8], 16) % 360) + offset) % 360
    sat = 0.62 + (int(digest[8:12], 16) % 13) / 100.0
    lig = 0.50 + (int(digest[12:16], 16) % 11) / 100.0
    r, g, b = colorsys.hls_to_rgb(hue / 360.0, min(0.66, lig), min(0.80, sat))
    return f"#{int(r * 255):02X}{int(g * 255):02X}{int(b * 255):02X}"


def init_db() -> None:
    if DATABASE_URL.startswith("sqlite"):
        db_path = DATABASE_URL.replace("sqlite:///", "", 1)
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    # Create tables.
    SQLModel.metadata.create_all(engine)

    # Lightweight migration for sqlite (create_all does not add columns).
    if DATABASE_URL.startswith("sqlite"):
        with engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA journal_mode=WAL;")
            conn.exec_driver_sql("PRAGMA synchronous=NORMAL;")
            conn.exec_driver_sql("PRAGMA foreign_keys=ON;")

            cols = conn.exec_driver_sql("PRAGMA table_info(logentry);").fetchall()
            existing = {row[1] for row in cols}  # name
            if "classificationStatus" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN classificationStatus TEXT NOT NULL DEFAULT 'pending';")
            if "classificationAttempts" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN classificationAttempts INTEGER NOT NULL DEFAULT 0;")
            if "classificationError" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN classificationError TEXT;")
            if "updatedAt" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN updatedAt TEXT NOT NULL DEFAULT '';")
            if "idempotencyKey" not in existing:
                conn.exec_driver_sql("ALTER TABLE logentry ADD COLUMN idempotencyKey TEXT;")

            topic_cols = conn.exec_driver_sql("PRAGMA table_info(topic);").fetchall()
            topic_existing = {row[1] for row in topic_cols}
            if "color" not in topic_existing:
                conn.exec_driver_sql("ALTER TABLE topic ADD COLUMN color TEXT;")

            task_cols = conn.exec_driver_sql("PRAGMA table_info(task);").fetchall()
            task_existing = {row[1] for row in task_cols}
            if "color" not in task_existing:
                conn.exec_driver_sql("ALTER TABLE task ADD COLUMN color TEXT;")

    # Backfill missing topic/task colors once so existing instances get stable hues.
    try:
        from .models import Topic, Task  # local import avoids circulars at module import time

        with Session(engine) as session:
            topics = session.exec(select(Topic)).all()
            topic_updates = 0
            for topic in topics:
                normalized = _normalize_hex_color(getattr(topic, "color", None))
                if normalized:
                    if topic.color != normalized:
                        topic.color = normalized
                        topic_updates += 1
                    continue
                topic.color = _auto_color(f"topic:{topic.id}:{topic.name}", 0.0)
                topic_updates += 1

            tasks = session.exec(select(Task)).all()
            task_updates = 0
            for task in tasks:
                normalized = _normalize_hex_color(getattr(task, "color", None))
                if normalized:
                    if task.color != normalized:
                        task.color = normalized
                        task_updates += 1
                    continue
                task.color = _auto_color(f"task:{task.id}:{task.title}", 21.0)
                task_updates += 1

            if topic_updates or task_updates:
                session.commit()
    except Exception:
        pass


def get_session() -> Session:
    return Session(engine)
