from __future__ import annotations

import os
from pathlib import Path
from sqlmodel import SQLModel, create_engine, Session

DATABASE_URL = os.getenv("CLAWBOARD_DB_URL", "sqlite:///./data/clawboard.db")

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, echo=False, connect_args=connect_args)


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


def get_session() -> Session:
    return Session(engine)
