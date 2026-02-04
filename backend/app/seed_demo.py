from __future__ import annotations

import argparse
import json
from pathlib import Path
from sqlmodel import select, delete

from .db import init_db, get_session
from .models import InstanceConfig, Topic, Task, LogEntry


def load_fixture(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Fixture file not found: {path}")
    return json.loads(path.read_text())


def reset_db(session):
    session.exec(delete(LogEntry))
    session.exec(delete(Task))
    session.exec(delete(Topic))
    session.exec(delete(InstanceConfig))
    session.commit()


def seed_from_fixture(session, fixture: dict):
    instance = fixture.get("instance") or {}
    inst = InstanceConfig(
        id=1,
        title=instance.get("title", "Clawboard"),
        integrationLevel=instance.get("integrationLevel", "manual"),
        updatedAt=instance.get("updatedAt", ""),
    )
    session.add(inst)

    topics = [Topic(**topic) for topic in fixture.get("topics", [])]
    tasks = [Task(**task) for task in fixture.get("tasks", [])]
    logs = [LogEntry(**log) for log in fixture.get("logs", [])]

    session.add_all(topics)
    session.commit()

    session.add_all(tasks)
    session.commit()

    session.add_all(logs)
    session.commit()


def main():
    parser = argparse.ArgumentParser(description="Seed Clawboard demo data into SQLite.")
    parser.add_argument("--fixture", default="/tmp/portal.json", help="Path to fixture JSON")
    parser.add_argument("--reset", action="store_true", help="Reset database before seeding")
    parser.add_argument("--reset-only", action="store_true", help="Only reset database")
    args = parser.parse_args()

    init_db()

    with get_session() as session:
        if args.reset or args.reset_only:
            reset_db(session)
            if args.reset_only:
                print("Database cleared.")
                return

        fixture = load_fixture(Path(args.fixture))
        seed_from_fixture(session, fixture)
        print("Demo data loaded.")


if __name__ == "__main__":
    main()
