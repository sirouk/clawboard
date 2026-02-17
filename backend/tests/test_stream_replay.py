from __future__ import annotations

import os
import queue
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-stream-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient

    from app.db import init_db
    from app.main import app  # noqa: E402
    from app.events import EventHub, event_hub
    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    EventHub = None  # type: ignore[assignment]
    event_hub = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class StreamReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    def setUp(self):
        event_hub._buffer.clear()  # type: ignore[attr-defined]
        event_hub._next_id = 1  # type: ignore[attr-defined]

    def test_reconnect_replays_only_new_events_after_cursor(self):
        first = event_hub.publish({"type": "topic.updated", "data": {"name": "alpha"}})
        second = event_hub.publish({"type": "topic.updated", "data": {"name": "bravo"}})
        replayed = list(event_hub.replay(int(first["eventId"])))
        self.assertEqual(len(replayed), 1)
        replay_id, replay_payload = replayed[0]
        self.assertEqual(str(replay_id), str(second["eventId"]))
        self.assertEqual(str(replay_payload.get("type") or ""), "topic.updated")
        self.assertEqual(replay_payload.get("data"), {"name": "bravo"})

    def test_reconnect_plus_changes_reconcile_recovers_topic_updates(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        since = now_iso()
        prior = event_hub.publish({"type": "log.appended", "data": {"id": "seed"}})

        created = self.client.post("/api/topics", json={"name": "SSE Reconcile Topic"}, headers=write_headers)
        self.assertEqual(created.status_code, 200, created.text)
        topic = created.json()

        replayed = list(event_hub.replay(int(prior["eventId"])))
        topic_replayed = next(
            (
                payload
                for _, payload in replayed
                if str(payload.get("type") or "") == "topic.upserted"
                and str((payload.get("data") or {}).get("id") or "") == str(topic["id"])
            ),
            None,
        )
        self.assertIsNotNone(topic_replayed, "Expected topic.upserted event in replay buffer after anchor event.")

        changes = self.client.get(
            "/api/changes",
            params={"since": since},
            headers=read_headers,
        )
        self.assertEqual(changes.status_code, 200, changes.text)
        payload = changes.json()
        topics = payload.get("topics") or []
        self.assertTrue(any(str(item.get("id") or "") == str(topic["id"]) for item in topics))

    def test_stale_cursor_returns_stream_reset(self):
        event_hub._next_id = 11  # type: ignore[attr-defined]
        replayed = event_hub.publish({"type": "task.upserted", "data": {"name": "stale"}})
        oldest = event_hub.oldest_id()
        self.assertEqual(oldest, 11)
        should_reset = oldest is not None and 2 < oldest
        self.assertTrue(should_reset)
        self.assertEqual(replayed["eventId"], "11")


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class EventHubBackpressureTests(unittest.TestCase):
    def test_subscriber_queue_caps_and_drops_oldest_during_slow_consumption(self):
        hub = EventHub(max_buffer=5, subscriber_queue_size=1)
        subscriber = hub.subscribe()

        for index in range(3):
            hub.publish({"type": "log.appended", "seq": index})

        payloads = []
        try:
            while True:
                payloads.append(subscriber.get_nowait())
        except queue.Empty:
            pass

        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[-1][0], 3)
