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
    from sqlmodel import select

    from app.db import init_db, get_session
    from app.main import app, _ingest_openclaw_history_messages  # noqa: E402
    from app.events import EventHub, event_hub
    from app.models import LogEntry, OpenClawChatDispatchQueue
    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    EventHub = None  # type: ignore[assignment]
    event_hub = None  # type: ignore[assignment]
    get_session = None  # type: ignore[assignment]
    _ingest_openclaw_history_messages = None  # type: ignore[assignment]
    LogEntry = None  # type: ignore[assignment]
    OpenClawChatDispatchQueue = None  # type: ignore[assignment]
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
        write_headers = {"Host": "localhost:8010", "X-ClawBoard-Token": "test-token"}
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
        replayed = event_hub.publish({"type": "topic.upserted", "data": {"name": "stale"}})
        oldest = event_hub.oldest_id()
        self.assertEqual(oldest, 11)
        should_reset = oldest is not None and 2 < oldest
        self.assertTrue(should_reset)
        self.assertEqual(replayed["eventId"], "11")

    def test_changes_reconcile_returns_topic_tombstones(self):
        write_headers = {"Host": "localhost:8010", "X-ClawBoard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}
        suffix = str(int(datetime.now(timezone.utc).timestamp() * 1000))

        topic_res = self.client.post(
            "/api/topics",
            json={"id": f"topic-replay-delete-{suffix}", "name": f"Replay Delete Topic {suffix}"},
            headers=write_headers,
        )
        self.assertEqual(topic_res.status_code, 200, topic_res.text)
        topic = topic_res.json()

        since = now_iso()

        deleted_topic = self.client.delete(f"/api/topics/{topic['id']}", headers=write_headers)
        self.assertEqual(deleted_topic.status_code, 200, deleted_topic.text)

        changes = self.client.get("/api/changes", params={"since": since}, headers=read_headers)
        self.assertEqual(changes.status_code, 200, changes.text)
        payload = changes.json()

        deleted_topics = payload.get("deletedTopics") or []
        self.assertTrue(any(str(item.get("id") or "") == str(topic["id"]) for item in deleted_topics))
        self.assertTrue(str(payload.get("cursor") or "").strip())

    def test_changes_reconcile_returns_active_openclaw_signal_snapshots(self):
        read_headers = {"Host": "localhost:8010"}
        session_key = "clawboard:task:topic-signal-sync:task-signal-sync"
        request_id = "occhat-signal-sync"
        stamp = now_iso()

        with get_session() as session:
            session.add(
                OpenClawChatDispatchQueue(
                    requestId=request_id,
                    sessionKey=session_key,
                    agentId="main",
                    sentAt=stamp,
                    message="Signal sync smoke",
                    attachmentIds=[],
                    status="pending",
                    attempts=0,
                    nextAttemptAt=stamp,
                    claimedAt=None,
                    completedAt=None,
                    lastError=None,
                    createdAt=stamp,
                    updatedAt=stamp,
                )
            )
            session.commit()

        changes = self.client.get("/api/changes", headers=read_headers)
        self.assertEqual(changes.status_code, 200, changes.text)
        payload = changes.json()

        typing = payload.get("openclawTyping") or []
        thread_work = payload.get("openclawThreadWork") or []
        self.assertTrue(any(str(item.get("sessionKey") or "") == session_key for item in typing))
        self.assertTrue(any(str(item.get("sessionKey") or "") == session_key for item in thread_work))
        self.assertTrue(any(str(item.get("requestId") or "") == request_id for item in typing))
        self.assertTrue(any(str(item.get("requestId") or "") == request_id for item in thread_work))
        self.assertGreaterEqual(str(payload.get("cursor") or ""), stamp)

    def test_log_chat_counts_exclude_internal_noise_and_cron_rows(self):
        write_headers = {"Host": "localhost:8010", "X-ClawBoard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}
        suffix = str(int(datetime.now(timezone.utc).timestamp() * 1000))
        topic_id = f"topic-chat-counts-{suffix}"
        session_key = f"clawboard:topic:{topic_id}"

        topic_res = self.client.post(
            "/api/topics",
            json={"id": topic_id, "name": f"Chat Counts {suffix}"},
            headers=write_headers,
        )
        self.assertEqual(topic_res.status_code, 200, topic_res.text)

        def append_log(payload: dict[str, object]) -> None:
            response = self.client.post("/api/log", json=payload, headers=write_headers)
            self.assertEqual(response.status_code, 200, response.text)

        append_log(
            {
                "topicId": topic_id,
                "type": "conversation",
                "content": f"user-{suffix}",
                "summary": f"user-{suffix}",
                "agentId": "user",
                "agentLabel": "User",
                "source": {"sessionKey": session_key, "channel": "clawboard"},
            }
        )
        append_log(
            {
                "topicId": topic_id,
                "type": "conversation",
                "content": f"assistant-{suffix}",
                "summary": f"assistant-{suffix}",
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {"sessionKey": session_key, "channel": "clawboard"},
            }
        )
        append_log(
            {
                "topicId": topic_id,
                "type": "action",
                "content": f"meaningful-tool-{suffix}",
                "summary": f"Tool call: meaningful-tool-{suffix}",
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {"sessionKey": session_key, "channel": "clawboard"},
            }
        )
        append_log(
            {
                "topicId": topic_id,
                "type": "action",
                "content": "Transcript write: toolresult",
                "summary": "Transcript write: toolresult",
                "agentId": "toolresult",
                "agentLabel": "toolresult",
                "source": {"sessionKey": session_key, "channel": "clawboard"},
            }
        )
        append_log(
            {
                "topicId": topic_id,
                "type": "action",
                "content": "Tool result persisted: exec",
                "summary": "Tool result persisted: exec",
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {"sessionKey": session_key, "channel": "clawboard"},
            }
        )
        append_log(
            {
                "topicId": topic_id,
                "type": "conversation",
                "content": "HEARTBEAT_OK",
                "summary": "HEARTBEAT_OK",
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {"sessionKey": session_key, "channel": "clawboard"},
            }
        )
        append_log(
            {
                "topicId": topic_id,
                "type": "conversation",
                "content": "Same recovery event already handled",
                "summary": "Same recovery event already handled",
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {"sessionKey": session_key, "channel": "clawboard"},
            }
        )
        append_log(
            {
                "topicId": topic_id,
                "type": "conversation",
                "content": "Done. Task closed.",
                "summary": "Done. Task closed.",
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {"sessionKey": session_key, "channel": "clawboard"},
            }
        )
        append_log(
            {
                "topicId": topic_id,
                "type": "system",
                "content": "cron-noise",
                "summary": "cron-noise",
                "agentId": "system",
                "agentLabel": "System",
                "source": {"sessionKey": session_key, "channel": "cron-event"},
            }
        )
        append_log(
            {
                "topicId": topic_id,
                "type": "system",
                "content": "Coding specialist still running. Waiting for its completion to provide the combined answer.",
                "summary": "Coding specialist still running. Waiting for its completion to provide the combined answer.",
                "agentId": "system",
                "agentLabel": "System",
                "source": {
                    "sessionKey": session_key,
                    "channel": "clawboard",
                    "suppressedWaitingStatus": True,
                },
            }
        )

        counts = self.client.get("/api/log/chat-counts", headers=read_headers)
        self.assertEqual(counts.status_code, 200, counts.text)
        payload = counts.json()
        self.assertEqual((payload.get("topicChatCounts") or {}).get(topic_id), 3)

    def test_history_sync_skips_no_reply_sentinel_messages(self):
        session_key = "clawboard:topic:topic-no-reply-skip"

        ingested, max_seen = _ingest_openclaw_history_messages(
            session_key=session_key,
            messages=[
                {
                    "role": "assistant",
                    "timestamp": 1773033001464,
                    "content": [{"type": "text", "text": "NO_REPLY"}],
                    "messageId": "oc:no-reply-sentinel",
                    "requestId": "occhat-no-reply-sentinel",
                }
            ],
            since_ms=0,
        )

        self.assertEqual(ingested, 0)
        self.assertEqual(max_seen, 1773033001464)

        with get_session() as session:
            rows = session.exec(
                select(LogEntry).where(LogEntry.source["sessionKey"].as_string() == session_key)
            ).all()
        self.assertEqual(rows, [])

    def test_history_sync_skips_board_scoped_assistant_duplicate_from_live_path(self):
        write_headers = {"Host": "localhost:8010", "X-ClawBoard-Token": "test-token"}
        suffix = str(int(datetime.now(timezone.utc).timestamp() * 1000))
        topic_id = f"topic-history-dedupe-{suffix}"
        session_key = f"clawboard:topic:{topic_id}"
        live_session_key = f"agent:main:{session_key}"
        message_text = "Good news: the cron scheduler is enabled and running with 2 jobs configured."

        topic_res = self.client.post(
            "/api/topics",
            json={"id": topic_id, "name": f"History Dedupe {suffix}"},
            headers=write_headers,
        )
        self.assertEqual(topic_res.status_code, 200, topic_res.text)

        live_res = self.client.post(
            "/api/log",
            json={
                "topicId": topic_id,
                "type": "conversation",
                "content": message_text,
                "summary": message_text,
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {
                    "sessionKey": live_session_key,
                    "channel": "direct",
                    "requestId": f"occhat-history-dedupe-{suffix}",
                    "boardScopeTopicId": topic_id,
                    "boardScopeKind": "topic",
                    "boardScopeLock": True,
                },
            },
            headers=write_headers,
        )
        self.assertEqual(live_res.status_code, 200, live_res.text)

        history_timestamp = int(datetime.now(timezone.utc).timestamp() * 1000)
        _ingest_openclaw_history_messages(
            session_key=session_key,
            messages=[
                {
                    "id": f"history-message-{suffix}",
                    "role": "assistant",
                    "timestamp": history_timestamp,
                    "content": [{"type": "text", "text": message_text}],
                }
            ],
            since_ms=0,
        )

        with get_session() as session:
            rows = session.exec(
                select(LogEntry)
                .where(LogEntry.topicId == topic_id)
                .where(LogEntry.type == "conversation")
                .where(LogEntry.agentId == "assistant")
            ).all()
        self.assertEqual(len(rows), 1)


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
