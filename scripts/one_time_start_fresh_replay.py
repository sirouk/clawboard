#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
ENV_FILE = Path(os.environ.get("CLAWBOARD_ENV_FILE", str(REPO_ROOT / ".env"))).expanduser()

DEFAULT_DB = DATA_DIR / "clawboard.db"
DEFAULT_EMBED_DB = DATA_DIR / "classifier_embeddings.db"
DEFAULT_QDRANT_DIR = DATA_DIR / "qdrant"
DEFAULT_REINDEX_QUEUE = DATA_DIR / "reindex-queue.jsonl"
DEFAULT_CREATION_GATE = DATA_DIR / "creation-gate.jsonl"
DEFAULT_CLASSIFIER_LOCK = DATA_DIR / "classifier.lock"

DEFAULT_API_BASE = os.environ.get("CLAWBOARD_ADMIN_API_BASE", "http://localhost:8010").rstrip("/")


def _utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _timestamp_slug() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _run(cmd: list[str], cwd: Path) -> None:
    subprocess.run(cmd, cwd=str(cwd), check=True)


def _run_capture(cmd: list[str], cwd: Path) -> str:
    out = subprocess.check_output(cmd, cwd=str(cwd))
    return out.decode("utf-8", errors="ignore").strip()


def _copy_any(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
        return
    shutil.copy2(src, dst)


def _backup(data_dir: Path, db_path: Path, embed_db_path: Path, qdrant_dir: Path, reindex_queue: Path, creation_gate: Path, classifier_lock: Path) -> Path:
    backup_dir = data_dir / "backups" / f"{_timestamp_slug()}_start_fresh_replay"
    backup_dir.mkdir(parents=True, exist_ok=True)

    # Prefer backing up the live docker volume database if available.
    # (In docker-compose, CLAWBOARD_DB_URL defaults to sqlite:////db/clawboard.db on a named volume.)
    container_id = ""
    try:
        container_id = _run_capture(["docker", "compose", "ps", "-q", "api"], cwd=REPO_ROOT)
    except Exception:
        container_id = ""

    if container_id:
        for suffix in ("", "-wal", "-shm"):
            src = f"{container_id}:/db/clawboard.db{suffix}"
            dst = backup_dir / f"clawboard.db{suffix}"
            try:
                subprocess.run(["docker", "cp", src, str(dst)], cwd=str(REPO_ROOT), check=False)
            except Exception:
                pass
    else:
        # Fallback: copy a local db file snapshot if present.
        # SQLite WAL mode requires copying the db plus wal/shm to preserve a consistent snapshot.
        for suffix in ("", "-wal", "-shm"):
            _copy_any(Path(f"{db_path}{suffix}"), backup_dir / (db_path.name + suffix))

    _copy_any(embed_db_path, backup_dir / embed_db_path.name)
    _copy_any(reindex_queue, backup_dir / reindex_queue.name)
    _copy_any(creation_gate, backup_dir / creation_gate.name)
    _copy_any(classifier_lock, backup_dir / classifier_lock.name)
    _copy_any(qdrant_dir, backup_dir / qdrant_dir.name)
    return backup_dir


def _ensure_instance_config(cur: sqlite3.Cursor, integration_level: str) -> None:
    now = _utc_iso_now()
    row = cur.execute("SELECT id FROM instanceconfig WHERE id = 1;").fetchone()
    if row is None:
        cur.execute(
            "INSERT INTO instanceconfig (id, title, integrationLevel, updatedAt) VALUES (1, ?, ?, ?);",
            ("Clawboard", integration_level, now),
        )
        return
    cur.execute(
        "UPDATE instanceconfig SET integrationLevel = ?, updatedAt = ? WHERE id = 1;",
        (integration_level, now),
    )


def _reset_sqlite(db_path: Path, integration_level: str) -> None:
    if not db_path.exists():
        raise FileNotFoundError(f"Clawboard DB not found: {db_path}")

    now = _utc_iso_now()
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA foreign_keys=OFF;")
        cur.execute("BEGIN IMMEDIATE;")

        _ensure_instance_config(cur, integration_level)

        # "Start fresh" derived state:
        # - detach all logs from topics/tasks
        # - reset classifier state to pending so stage-2 replays everything
        cur.execute(
            """
            UPDATE logentry
            SET topicId = NULL,
                taskId = NULL,
                classificationStatus = 'pending',
                classificationAttempts = 0,
                classificationError = NULL,
                updatedAt = ?
            ;
            """,
            (now,),
        )

        # Clear derived objects. (Log history remains; classifier will recreate topics/tasks.)
        cur.execute("DELETE FROM task;")
        cur.execute("DELETE FROM topic;")

        # Clear any async ingest backlog (should be empty, but keep it clean).
        cur.execute("DELETE FROM ingestqueue;")

        conn.commit()
    finally:
        conn.close()


def _read_env_kv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    data: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip("'").strip('"')
        if k:
            data[k] = v
    return data


def _admin_reset(api_base: str, token: str, integration_level: str) -> None:
    url = f"{api_base}/api/admin/start-fresh-replay"
    body = json.dumps({"integrationLevel": integration_level}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Clawboard-Token"] = token

    last_error: Exception | None = None
    for attempt in range(6):
        req = urllib.request.Request(url=url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                if 200 <= resp.status < 300:
                    return
                raise RuntimeError(f"unexpected status: {resp.status}")
        except urllib.error.HTTPError as exc:
            last_error = exc
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"admin reset failed ({exc.code}): {detail[:300]}") from exc
        except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError) as exc:
            last_error = exc

        # Linear backoff; this only runs once per reset and keeps behavior predictable.
        import time

        time.sleep(0.4 * (attempt + 1))

    raise RuntimeError(f"admin reset failed after retries: {last_error}")


def _wipe_vectors(embed_db_path: Path, qdrant_dir: Path, reindex_queue: Path, creation_gate: Path, classifier_lock: Path) -> None:
    # Vector stores are derived; wipe them so replay doesn't read stale embeddings.
    for p in (embed_db_path, reindex_queue, classifier_lock, creation_gate):
        try:
            if p.exists():
                p.unlink()
        except IsADirectoryError:
            pass

    if qdrant_dir.exists():
        shutil.rmtree(qdrant_dir)
    qdrant_dir.mkdir(parents=True, exist_ok=True)


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="One-time: start fresh (clear topics/tasks + reset classifier) and replay existing logs through stage-2 classifier.",
    )
    p.add_argument("--yes", action="store_true", help="Required. Acknowledge this is destructive to derived state.")
    p.add_argument(
        "--integration-level",
        default="full",
        choices=("manual", "write", "full"),
        help="Set /api/config integrationLevel (default: full).",
    )
    p.add_argument("--db", default=str(DEFAULT_DB), help="Path to clawboard.sqlite (default: ./data/clawboard.db).")
    p.add_argument(
        "--embed-db",
        default=str(DEFAULT_EMBED_DB),
        help="Path to embeddings sqlite (default: ./data/classifier_embeddings.db).",
    )
    p.add_argument(
        "--qdrant-dir",
        default=str(DEFAULT_QDRANT_DIR),
        help="Path to qdrant storage dir (default: ./data/qdrant).",
    )
    p.add_argument(
        "--reindex-queue",
        default=str(DEFAULT_REINDEX_QUEUE),
        help="Path to reindex queue jsonl (default: ./data/reindex-queue.jsonl).",
    )
    p.add_argument(
        "--creation-gate",
        default=str(DEFAULT_CREATION_GATE),
        help="Path to creation gate audit jsonl (default: ./data/creation-gate.jsonl).",
    )
    p.add_argument(
        "--classifier-lock",
        default=str(DEFAULT_CLASSIFIER_LOCK),
        help="Path to classifier lock file (default: ./data/classifier.lock).",
    )
    p.add_argument(
        "--no-restart",
        action="store_true",
        help="Do not stop/start docker services (assumes you will restart manually).",
    )
    return p


def main() -> int:
    args = build_arg_parser().parse_args()
    if not args.yes:
        print("error: refusing to run without --yes (this clears topics/tasks and resets classifier state).", file=sys.stderr)
        return 2

    db_path = Path(args.db).expanduser().resolve()
    embed_db_path = Path(args.embed_db).expanduser().resolve()
    qdrant_dir = Path(args.qdrant_dir).expanduser().resolve()
    reindex_queue = Path(args.reindex_queue).expanduser().resolve()
    creation_gate = Path(args.creation_gate).expanduser().resolve()
    classifier_lock = Path(args.classifier_lock).expanduser().resolve()

    env = _read_env_kv(ENV_FILE)
    token = os.environ.get("CLAWBOARD_TOKEN", "").strip() or env.get("CLAWBOARD_TOKEN", "").strip()
    api_base = os.environ.get("CLAWBOARD_ADMIN_API_BASE", "").strip() or DEFAULT_API_BASE
    if not token:
        print(
            f"error: CLAWBOARD_TOKEN is required to call {api_base}/api/admin/start-fresh-replay (set in {ENV_FILE}).",
            file=sys.stderr,
        )
        return 2

    print("one_time_start_fresh_replay: backing up current state...")
    backup_dir = _backup(DATA_DIR, db_path, embed_db_path, qdrant_dir, reindex_queue, creation_gate, classifier_lock)
    print(f"one_time_start_fresh_replay: backup written: {backup_dir}")

    print("one_time_start_fresh_replay: resetting derived state via API (topics/tasks cleared; logs set pending)...")
    try:
        _admin_reset(api_base, token, args.integration_level)
    except Exception as exc:
        # Fallback for non-docker/local dev where CLAWBOARD_DB_URL points at ./data/clawboard.db
        if db_path.exists():
            print(f"warning: admin reset failed ({exc}); falling back to sqlite file reset: {db_path}")
            _reset_sqlite(db_path, args.integration_level)
        else:
            raise

    if args.no_restart:
        print("one_time_start_fresh_replay: done. Restart clawboard services to begin replay (vectors not wiped).")
        return 0

    print("one_time_start_fresh_replay: stopping docker services...")
    _run(["bash", "deploy.sh", "down"], cwd=REPO_ROOT)

    print("one_time_start_fresh_replay: wiping derived vector stores (qdrant + embeddings + queues)...")
    _wipe_vectors(embed_db_path, qdrant_dir, reindex_queue, creation_gate, classifier_lock)

    print("one_time_start_fresh_replay: starting docker services...")
    _run(["bash", "deploy.sh", "up"], cwd=REPO_ROOT)
    print("one_time_start_fresh_replay: done. Classifier will now replay pending logs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
