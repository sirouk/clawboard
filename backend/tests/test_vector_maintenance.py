from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP_DIR = os.path.join(ROOT, "app")
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

import vector_maintenance as vm  # noqa: E402


def _seed_clawboard_db(path: str) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE topic (id TEXT PRIMARY KEY, name TEXT)")
        conn.execute("CREATE TABLE task (id TEXT PRIMARY KEY, topicId TEXT, title TEXT)")
        conn.execute(
            """
            CREATE TABLE logentry (
              id TEXT PRIMARY KEY,
              topicId TEXT,
              type TEXT,
              summary TEXT,
              content TEXT,
              raw TEXT
            )
            """
        )

        conn.execute("INSERT INTO topic(id, name) VALUES ('topic-1', 'Valid Topic')")
        conn.execute("INSERT INTO task(id, topicId, title) VALUES ('task-1', 'topic-1', 'Valid Task')")
        conn.execute("INSERT INTO task(id, topicId, title) VALUES ('task-2', NULL, 'Loose Task')")

        conn.execute(
            "INSERT INTO logentry(id, topicId, type, summary, content, raw) VALUES ('log-good', 'topic-1', 'conversation', '', 'Ship feature now', '')"
        )
        conn.execute(
            "INSERT INTO logentry(id, topicId, type, summary, content, raw) VALUES ('log-command', 'topic-1', 'conversation', '', '/new', '')"
        )
        conn.execute(
            "INSERT INTO logentry(id, topicId, type, summary, content, raw) VALUES ('log-memory', 'topic-1', 'action', 'Tool call: memory_search', '', '')"
        )
        conn.execute(
            "INSERT INTO logentry(id, topicId, type, summary, content, raw) VALUES ('log-system', 'topic-1', 'system', '', 'internal', '')"
        )
        conn.commit()
    finally:
        conn.close()


def _seed_embeddings_db(path: str) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            """
            CREATE TABLE embeddings (
              kind TEXT NOT NULL,
              id TEXT NOT NULL,
              vector BLOB NOT NULL,
              dim INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(kind, id)
            )
            """
        )
        rows = [
            ("topic", "topic-1"),
            ("topic", "topic-orphan"),
            ("task:topic-legacy", "task-1"),
            ("task:unassigned", "task-2"),
            ("task:topic-missing", "task-orphan"),
            ("log", "log-good"),
            ("log", "log-command"),
            ("log", "log-memory"),
            ("log", "log-system"),
            ("log", "log-orphan"),
        ]
        for kind, item_id in rows:
            conn.execute(
                "INSERT INTO embeddings(kind, id, vector, dim, updated_at) VALUES (?, ?, ?, ?, ?)",
                (kind, item_id, b"\x00\x00\x80?", 1, 0),
            )
        conn.commit()
    finally:
        conn.close()


class VectorMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="clawboard-vector-maint-")
        self.clawboard_db = os.path.join(self.tmp, "clawboard.db")
        self.embeddings_db = os.path.join(self.tmp, "embeddings.db")
        self.queue_path = os.path.join(self.tmp, "reindex-queue.jsonl")
        _seed_clawboard_db(self.clawboard_db)
        _seed_embeddings_db(self.embeddings_db)

    def _embedding_keys(self) -> set[tuple[str, str]]:
        conn = sqlite3.connect(self.embeddings_db)
        try:
            rows = conn.execute("SELECT kind, id FROM embeddings").fetchall()
            return {(str(kind), str(item_id)) for kind, item_id in rows}
        finally:
            conn.close()

    def test_build_cleanup_plan_detects_stale_and_missing(self):
        plan = vm.build_cleanup_plan(self.clawboard_db, self.embeddings_db)

        self.assertEqual(plan["desiredCount"], 4)
        self.assertEqual(plan["managedExistingCount"], 10)
        self.assertEqual(len(plan["deletePairs"]), 7)
        self.assertEqual(len(plan["missingPairs"]), 1)

        self.assertIn(("task:topic-1", "task-1"), set(plan["missingPairs"]))
        self.assertIn(("topic", "topic-orphan"), set(plan["deletePairs"]))
        self.assertIn(("log", "log-command"), set(plan["deletePairs"]))

    def test_run_one_time_cleanup_applies_sqlite_and_enqueues_reindex(self):
        report = vm.run_one_time_vector_cleanup(
            clawboard_db_path=self.clawboard_db,
            embeddings_db_path=self.embeddings_db,
            queue_path=self.queue_path,
            qdrant_url="",
            dry_run=False,
        )

        self.assertEqual(report["sqliteDeleted"], 7)
        self.assertEqual(report["queueEnqueued"], 8)
        self.assertEqual(report["qdrantDeleteAttempted"], 0)

        remaining = self._embedding_keys()
        self.assertEqual(
            remaining,
            {
                ("topic", "topic-1"),
                ("task:unassigned", "task-2"),
                ("log", "log-good"),
            },
        )

        with open(self.queue_path, "r", encoding="utf-8") as f:
            payloads = [json.loads(line) for line in f if line.strip()]
        self.assertEqual(len(payloads), 8)

        deletes = [item for item in payloads if item.get("op") == "delete"]
        upserts = [item for item in payloads if item.get("op") == "upsert"]
        self.assertEqual(len(deletes), 7)
        self.assertEqual(len(upserts), 1)

        upsert = upserts[0]
        self.assertEqual(upsert.get("kind"), "task")
        self.assertEqual(upsert.get("id"), "task-1")
        self.assertEqual(upsert.get("topicId"), "topic-1")

    def test_run_one_time_cleanup_dry_run_keeps_data_unchanged(self):
        report = vm.run_one_time_vector_cleanup(
            clawboard_db_path=self.clawboard_db,
            embeddings_db_path=self.embeddings_db,
            queue_path=self.queue_path,
            qdrant_url="",
            dry_run=True,
        )

        self.assertTrue(report["dryRun"])
        self.assertEqual(report["sqliteDeleted"], 0)
        self.assertEqual(report["queueEnqueued"], 0)
        self.assertEqual(len(self._embedding_keys()), 10)
        self.assertFalse(os.path.exists(self.queue_path))


if __name__ == "__main__":
    unittest.main()
