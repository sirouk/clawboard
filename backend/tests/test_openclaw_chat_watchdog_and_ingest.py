from __future__ import annotations

import base64
import os
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-openclaw-ingest-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"
os.environ["CLAWBOARD_ATTACHMENTS_DIR"] = os.path.join(TMP_DIR, "attachments")
os.environ["OPENCLAW_BASE_URL"] = "http://127.0.0.1:18789"
os.environ["OPENCLAW_GATEWAY_TOKEN"] = "test-token"
os.environ.setdefault("OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS", "0")
os.environ.setdefault("OPENCLAW_CHAT_IN_FLIGHT_RETRY_GRACE_SECONDS", "120")
os.environ.setdefault("OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS", "1209600")
os.environ.setdefault("OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES", "24")

try:
    from fastapi import BackgroundTasks, HTTPException
    from fastapi.testclient import TestClient
    from sqlalchemy.exc import OperationalError
    from sqlmodel import select

    from app import main as main_module  # noqa: E402
    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import (
        Attachment,
        IngestQueue,
        LogEntry,
        OpenClawChatDispatchQueue,
        OpenClawGatewayHistoryCursor,
        OpenClawGatewayHistorySyncState,
        Task,
        Topic,
    )  # noqa: E402
    from app.schemas import LogAppend, OpenClawChatRequest, OpenClawChatCancelRequest  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    BackgroundTasks = None  # type: ignore[assignment]
    HTTPException = None  # type: ignore[assignment]
    TestClient = None  # type: ignore[assignment]
    OperationalError = Exception  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _publish_collector(events: list[dict]):
    def _publish(event: dict):
        events.append(event)
        return {**event, "eventId": str(len(events))}

    return _publish


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class OpenClawChatAndIngestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    def setUp(self):
        # Keep history-sync unit paths deterministic regardless of local .env defaults.
        # Individual tests can still override this with patch.dict as needed.
        os.environ["OPENCLAW_GATEWAY_HISTORY_SYNC_SESSIONS_LIST_DISABLE"] = "0"
        with main_module._OPENCLAW_WATCHDOG_BACKFILL_STATE_LOCK:
            main_module._OPENCLAW_WATCHDOG_BACKFILL_STATE.clear()
        with main_module._OPENCLAW_HISTORY_SYNC_SESSION_BACKOFF_LOCK:
            main_module._OPENCLAW_HISTORY_SYNC_SESSION_BACKOFF.clear()
        with get_session() as session:
            for row in session.exec(select(Attachment)).all():
                session.delete(row)
            for row in session.exec(select(IngestQueue)).all():
                session.delete(row)
            for row in session.exec(select(OpenClawChatDispatchQueue)).all():
                session.delete(row)
            for row in session.exec(select(OpenClawGatewayHistoryCursor)).all():
                session.delete(row)
            for row in session.exec(select(OpenClawGatewayHistorySyncState)).all():
                session.delete(row)
            for row in session.exec(select(LogEntry)).all():
                session.delete(row)
            for row in session.exec(select(Task)).all():
                session.delete(row)
            for row in session.exec(select(Topic)).all():
                session.delete(row)
            session.commit()

    def test_ing_014_source_scope_metadata_is_normalized(self):
        created = now_iso()
        with get_session() as session:
            topic = Topic(
                id="topic-ing-014",
                name="ING 014 Topic",
                color="#FF8A4A",
                description="test",
                priority="medium",
                status="active",
                tags=[],
                parentId=None,
                pinned=False,
                createdAt=created,
                updatedAt=created,
            )
            session.add(topic)
            session.commit()
            task = Task(
                id="task-ing-014",
                topicId=topic.id,
                title="ING 014 Task",
                color="#4EA1FF",
                status="todo",
                pinned=False,
                priority="medium",
                dueDate=None,
                createdAt=created,
                updatedAt=created,
            )
            session.add(task)
            session.commit()

        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "scope metadata only payload",
                "summary": "scope metadata only payload",
                "createdAt": created,
                "agentId": "user",
                "agentLabel": "User",
                "source": {
                    "sessionKey": "agent:main:subagent:ing-014",
                    "boardScopeTopicId": "topic-ing-014",
                    "boardScopeTaskId": "task-ing-014",
                    "boardScopeSpaceId": "space-default",
                    "boardScopeLock": True,
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload.get("topicId"), "topic-ing-014")
        self.assertEqual(payload.get("taskId"), "task-ing-014")
        source = payload.get("source") or {}
        self.assertEqual(source.get("boardScopeTopicId"), "topic-ing-014")
        self.assertEqual(source.get("boardScopeTaskId"), "task-ing-014")
        self.assertEqual(source.get("boardScopeKind"), "task")
        self.assertEqual(source.get("boardScopeSpaceId"), "space-default")
        self.assertTrue(bool(source.get("boardScopeLock")))

    def test_ing_018_queue_ingest_and_worker_drain(self):
        with patch.dict(
            os.environ,
            {
                "CLAWBOARD_INGEST_MODE": "queue",
                "CLAWBOARD_QUEUE_POLL_SECONDS": "0.01",
                "CLAWBOARD_QUEUE_BATCH": "10",
            },
            clear=False,
        ):
            enqueue = self.client.post(
                "/api/ingest",
                headers=self.auth_headers,
                json={
                    "type": "conversation",
                    "content": "queued payload",
                    "summary": "queued payload",
                    "createdAt": now_iso(),
                    "agentId": "user",
                    "agentLabel": "User",
                    "source": {"channel": "tests", "sessionKey": "channel:ingest-queue", "messageId": "ing-018"},
                },
            )
            self.assertEqual(enqueue.status_code, 200, enqueue.text)
            queue_id = enqueue.json().get("id")
            self.assertIsNotNone(queue_id)

            with get_session() as session:
                row = session.get(IngestQueue, queue_id)
                self.assertIsNotNone(row)
                self.assertEqual(row.status, "pending")

            def _break_sleep(_seconds: float):
                raise KeyboardInterrupt

            with patch.object(main_module.time, "sleep", side_effect=_break_sleep):
                with self.assertRaises(KeyboardInterrupt):
                    main_module._queue_worker()

            with get_session() as session:
                row = session.get(IngestQueue, queue_id)
                self.assertIsNotNone(row)
                self.assertEqual(row.status, "done")
                self.assertEqual(int(row.attempts or 0), 1)
                self.assertIsNone(row.lastError)
                logs = session.exec(select(LogEntry).where(LogEntry.content == "queued payload")).all()
                self.assertEqual(len(logs), 1)

    def test_ing_019_append_retries_sqlite_lock_then_commits(self):
        payload = LogAppend(
            type="conversation",
            content="sqlite lock retry test",
            summary="sqlite lock retry test",
            createdAt=now_iso(),
            agentId="user",
            agentLabel="User",
            source={"channel": "tests", "sessionKey": "channel:lock-retry", "messageId": "ing-019"},
        )
        with get_session() as session:
            original_commit = session.commit
            commit_calls = {"count": 0}

            def _flaky_commit():
                commit_calls["count"] += 1
                if commit_calls["count"] == 1:
                    raise OperationalError("INSERT INTO logentry ...", {}, Exception("database is locked"))
                return original_commit()

            with patch.object(session, "commit", side_effect=_flaky_commit), patch.object(
                main_module.time, "sleep", return_value=None
            ) as sleep_mock:
                entry = main_module.append_log_entry(session, payload, idempotency_key="ing-019-idem")

            self.assertTrue(bool(entry.id))
            self.assertGreaterEqual(commit_calls["count"], 2)
            self.assertTrue(sleep_mock.called)
            persisted = session.get(LogEntry, entry.id)
            self.assertIsNotNone(persisted)

    def test_ing_020_assistant_append_publishes_typing_false(self):
        published: list[dict] = []
        with patch.object(main_module.event_hub, "publish", side_effect=_publish_collector(published)):
            with get_session() as session:
                main_module.append_log_entry(
                    session,
                    LogAppend(
                        type="conversation",
                        content="assistant reply",
                        summary="assistant reply",
                        createdAt=now_iso(),
                        agentId="assistant",
                        agentLabel="Assistant",
                        source={
                            "sessionKey": "clawboard:topic:topic-chat-ing-020",
                            "requestId": "request-ing-020",
                        },
                    ),
                    idempotency_key="assistant-ing-020",
                )

        typing_events = [event for event in published if str(event.get("type") or "") == "openclaw.typing"]
        self.assertTrue(typing_events)
        terminal = typing_events[-1]
        self.assertFalse(bool((terminal.get("data") or {}).get("typing")))
        self.assertEqual((terminal.get("data") or {}).get("requestId"), "request-ing-020")

    def test_ing_020b_assistant_append_infers_request_id_from_latest_unresolved_board_send(self):
        sent_at = now_iso()
        request_id = "occhat-request-020b"
        session_key = "clawboard:topic:topic-chat-ing-020b"
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="user prompt",
                    summary="user prompt",
                    createdAt=sent_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": session_key,
                        "requestId": request_id,
                        "messageId": request_id,
                    },
                ),
                idempotency_key="ing-020b-user",
            )

            assistant = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant reply",
                    summary="assistant reply",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "openclaw",
                        "sessionKey": session_key,
                        "messageId": "assistant-msg-020b",
                    },
                ),
                idempotency_key="ing-020b-assistant",
            )

            source = assistant.source if isinstance(assistant.source, dict) else {}
            self.assertEqual(source.get("requestId"), request_id)

    def test_ing_020c_user_echo_dedupes_by_request_id_even_with_distinct_message_id(self):
        request_id = "occhat-request-020c"
        session_key = "channel:webchat|thread:ing-020c"
        created_at = now_iso()
        with get_session() as session:
            first = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="persisted by /api/openclaw/chat",
                    summary="persisted by /api/openclaw/chat",
                    createdAt=created_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": session_key,
                        "requestId": request_id,
                        "messageId": request_id,
                    },
                ),
                idempotency_key=f"openclaw-chat:user:{request_id}",
            )

            echoed = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="persisted by /api/openclaw/chat",
                    summary="persisted by /api/openclaw/chat",
                    createdAt=created_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "webchat",
                        "sessionKey": session_key,
                        "requestId": request_id,
                        "messageId": "webchat-msg-ing-020c",
                    },
                ),
                idempotency_key="src:conversation:webchat:user:webchat-msg-ing-020c",
            )

            rows = session.exec(select(LogEntry).where(LogEntry.type == "conversation")).all()

        self.assertEqual(first.id, echoed.id)
        self.assertEqual(len(rows), 1)

    def test_ing_020c2_user_echo_dedupes_when_replay_lacks_request_and_message_ids(self):
        request_id = "occhat-request-020c2"
        session_key = "clawboard:task:topic-ing-020c2:task-ing-020c2"
        created_at = now_iso()
        duplicate_at = (
            datetime.fromisoformat(created_at.replace("Z", "+00:00")) + timedelta(seconds=40)
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with get_session() as session:
            first = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="persisted by /api/openclaw/chat",
                    summary="persisted by /api/openclaw/chat",
                    createdAt=created_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": session_key,
                        "requestId": request_id,
                        "messageId": request_id,
                    },
                ),
                idempotency_key=f"openclaw-chat:user:{request_id}",
            )

            echoed = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="persisted by /api/openclaw/chat",
                    summary="persisted by /api/openclaw/chat",
                    createdAt=duplicate_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "clawboard",
                        "sessionKey": session_key,
                    },
                ),
                idempotency_key="src:conversation:clawboard:user:ing-020c2-unlabeled",
            )

            rows = session.exec(select(LogEntry).where(LogEntry.type == "conversation")).all()

        self.assertEqual(first.id, echoed.id)
        self.assertEqual(len(rows), 1)

    def test_ing_020d_assistant_webchat_replay_dedupes_into_existing_clawboard_row(self):
        request_id = "occhat-request-020d"
        topic_id = "topic-ing-020d"
        task_id = "task-ing-020d"
        board_session_key = f"clawboard:task:{topic_id}:{task_id}"
        gateway_session_key = f"agent:main:clawboard:task:{topic_id}:{task_id}"
        created_at = now_iso()
        with get_session() as session:
            # Persist the authoritative user send row as /api/openclaw/chat would.
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="user prompt for 020d",
                    summary="user prompt for 020d",
                    createdAt=created_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": board_session_key,
                        "requestId": request_id,
                        "messageId": request_id,
                    },
                ),
                idempotency_key=f"openclaw-chat:user:{request_id}",
            )

            # First assistant row arrives via watchdog/history-sync (channel=clawboard).
            first_assistant = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant response 020d",
                    summary="assistant response 020d",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "clawboard",
                        "sessionKey": board_session_key,
                        "requestId": request_id,
                    },
                ),
                idempotency_key="openclaw-chat:assistant:020d-clawboard",
            )

            # Replay row arrives later from logger/webchat with messageId only and no requestId.
            replay_assistant = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant response 020d",
                    summary="assistant response 020d",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "webchat",
                        "sessionKey": gateway_session_key,
                        "messageId": "oc:assistant-020d",
                        "boardScopeTopicId": topic_id,
                        "boardScopeTaskId": task_id,
                    },
                ),
                idempotency_key="src:conversation:webchat:assistant:oc:assistant-020d",
            )

            assistant_rows = session.exec(
                select(LogEntry)
                .where(LogEntry.type == "conversation")
                .where(LogEntry.agentId == "assistant")
            ).all()

        self.assertEqual(first_assistant.id, replay_assistant.id)
        self.assertEqual(len(assistant_rows), 1)

    def test_ing_020e_history_ingest_dedupes_against_existing_webchat_assistant_row(self):
        request_id = "occhat-request-020e"
        topic_id = "topic-ing-020e"
        task_id = "task-ing-020e"
        board_session_key = f"clawboard:task:{topic_id}:{task_id}"
        gateway_session_key = f"agent:main:{board_session_key}"
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant response 020e",
                    summary="assistant response 020e",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "webchat",
                        "sessionKey": gateway_session_key,
                        "requestId": request_id,
                        "messageId": "oc:assistant-020e",
                        "boardScopeTopicId": topic_id,
                        "boardScopeTaskId": task_id,
                    },
                ),
                idempotency_key="src:conversation:webchat:assistant:oc:assistant-020e",
            )

        history_messages = [
            {
                "timestamp": 1700000020000,
                "role": "assistant",
                "text": "assistant response 020e",
                "requestId": request_id,
            }
        ]
        ingested, _ = main_module._ingest_openclaw_history_messages(
            session_key=board_session_key,
            messages=history_messages,
            since_ms=0,
        )

        self.assertEqual(ingested, 0)
        with get_session() as session:
            rows = session.exec(
                select(LogEntry)
                .where(LogEntry.type == "conversation")
                .where(LogEntry.agentId == "assistant")
                .where(LogEntry.content == "assistant response 020e")
            ).all()
            self.assertEqual(len(rows), 1)
            source = rows[0].source if isinstance(rows[0].source, dict) else {}
            self.assertEqual(source.get("channel"), "webchat")

    def test_ing_020e2_history_ingest_preserves_assistant_reply_when_request_id_matches_user_row(self):
        request_id = "occhat-request-020e2"
        topic_id = "topic-ing-020e2"
        board_session_key = f"clawboard:topic:{topic_id}"
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="user prompt 020e2",
                    summary="user prompt 020e2",
                    createdAt=now_iso(),
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": board_session_key,
                        "requestId": request_id,
                        "messageId": request_id,
                    },
                ),
                idempotency_key=f"openclaw-chat:user:{request_id}",
            )

        history_messages = [
            {
                "timestamp": 1700000025000,
                "role": "assistant",
                "text": "[[reply_to_current]] assistant completion 020e2",
                "requestId": request_id,
            }
        ]
        ingested, _ = main_module._ingest_openclaw_history_messages(
            session_key=board_session_key,
            messages=history_messages,
            since_ms=0,
        )

        self.assertEqual(ingested, 1)
        with get_session() as session:
            rows = session.exec(
                select(LogEntry)
                .where(LogEntry.type == "conversation")
                .where(LogEntry.source["requestId"].as_string() == request_id)
                .order_by(LogEntry.createdAt.asc())
            ).all()
            self.assertEqual(len(rows), 2)
            self.assertEqual(str(rows[0].agentId or ""), "user")
            self.assertEqual(str(rows[1].agentId or ""), "assistant")
            self.assertEqual(str(rows[1].content or ""), "assistant completion 020e2")

    def test_ing_020f_assistant_uses_canonical_idempotency_key_by_base_request_id(self):
        request_id = "occhat-request-020f:retry-1"
        with get_session() as session:
            row = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant response 020f",
                    summary="assistant response 020f",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "webchat",
                        "sessionKey": "agent:main:clawboard:topic:topic-ing-020f",
                        "requestId": request_id,
                        "messageId": "oc:assistant-020f",
                    },
                ),
                idempotency_key="src:conversation:webchat:assistant:oc:assistant-020f",
            )
            idem = str(row.idempotencyKey or "")
            self.assertTrue(idem.startswith("openclaw-assistant:occhat-request-020f:"))

    def test_ing_020g_assistant_dedupes_between_base_and_retry_suffix_request_ids(self):
        request_id_base = "occhat-request-020g"
        with get_session() as session:
            first = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant response 020g",
                    summary="assistant response 020g",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "clawboard",
                        "sessionKey": "clawboard:topic:topic-ing-020g",
                        "requestId": f"{request_id_base}:retry-1",
                        "messageId": "oc:assistant-020g-a",
                    },
                ),
                idempotency_key="openclaw-history:ing-020g-a",
            )

            second = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant response 020g",
                    summary="assistant response 020g",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "webchat",
                        "sessionKey": "agent:main:clawboard:topic:topic-ing-020g",
                        "requestId": request_id_base,
                        "messageId": "oc:assistant-020g-b",
                    },
                ),
                idempotency_key="src:conversation:webchat:assistant:oc:assistant-020g-b",
            )

            rows = session.exec(
                select(LogEntry)
                .where(LogEntry.type == "conversation")
                .where(LogEntry.agentId == "assistant")
                .where(LogEntry.content == "assistant response 020g")
            ).all()

        self.assertEqual(first.id, second.id)
        self.assertEqual(len(rows), 1)

    def test_ing_020h_history_ingest_dedupes_when_existing_request_id_has_retry_suffix(self):
        request_id_base = "occhat-request-020h"
        board_session_key = "clawboard:topic:topic-ing-020h"
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant response 020h",
                    summary="assistant response 020h",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "webchat",
                        "sessionKey": "agent:main:clawboard:topic:topic-ing-020h",
                        "requestId": f"{request_id_base}:retry-1",
                        "messageId": "oc:assistant-020h",
                    },
                ),
                idempotency_key="src:conversation:webchat:assistant:oc:assistant-020h",
            )

        ingested, _ = main_module._ingest_openclaw_history_messages(
            session_key=board_session_key,
            messages=[
                {
                    "timestamp": 1700000030000,
                    "role": "assistant",
                    "text": "assistant response 020h",
                    "requestId": request_id_base,
                }
            ],
            since_ms=0,
        )

        self.assertEqual(ingested, 0)
        with get_session() as session:
            rows = session.exec(
                select(LogEntry)
                .where(LogEntry.type == "conversation")
                .where(LogEntry.agentId == "assistant")
                .where(LogEntry.content == "assistant response 020h")
            ).all()
            self.assertEqual(len(rows), 1)

    def test_ing_020h2_history_ingest_keeps_distinct_assistant_completion_for_same_request(self):
        request_id = "occhat-request-020h2"
        topic_id = "topic-ing-020h2"
        board_session_key = f"clawboard:topic:{topic_id}"
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="user prompt 020h2",
                    summary="user prompt 020h2",
                    createdAt=now_iso(),
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": board_session_key,
                        "requestId": request_id,
                        "messageId": request_id,
                    },
                ),
                idempotency_key=f"openclaw-chat:user:{request_id}",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="dispatch ack 020h2",
                    summary="dispatch ack 020h2",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="OpenClaw",
                    source={
                        "channel": "webchat",
                        "sessionKey": f"agent:main:{board_session_key}",
                        "requestId": request_id,
                        "messageId": "oc:assistant-020h2-dispatch",
                    },
                ),
                idempotency_key="src:conversation:webchat:assistant:oc:assistant-020h2-dispatch",
            )

        ingested, _ = main_module._ingest_openclaw_history_messages(
            session_key=f"agent:main:{board_session_key}",
            messages=[
                {
                    "timestamp": int(time.time() * 1000) + 5000,
                    "role": "assistant",
                    "text": "[[reply_to_current]] final completion 020h2",
                }
            ],
            since_ms=0,
        )

        self.assertEqual(ingested, 1)
        with get_session() as session:
            assistant_rows = session.exec(
                select(LogEntry)
                .where(LogEntry.type == "conversation")
                .where(LogEntry.agentId == "assistant")
                .where(LogEntry.source["requestId"].as_string() == request_id)
                .order_by(LogEntry.createdAt.asc())
            ).all()
            self.assertEqual(len(assistant_rows), 2)
            contents = [str(row.content or "") for row in assistant_rows]
            self.assertIn("dispatch ack 020h2", contents)
            self.assertIn("final completion 020h2", contents)

    def test_ing_020h3_assistant_identifier_dedupe_prefers_content_match_over_first_candidate(self):
        request_id = "occhat-request-020h3"
        topic_id = "topic-ing-020h3"
        board_session_key = f"clawboard:topic:{topic_id}"
        child_session_key = "agent:coding:subagent:ing-020h3-child"
        gateway_session_key = f"agent:main:{board_session_key}"
        with get_session() as session:
            subagent_row = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="subagent progress 020h3",
                    summary="subagent progress 020h3",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Coding",
                    source={
                        "channel": "direct",
                        "sessionKey": child_session_key,
                        "requestId": request_id,
                        "messageId": "oc:subagent-020h3",
                    },
                ),
                idempotency_key="src:conversation:direct:assistant:oc:subagent-020h3",
            )
            main_row = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="final completion 020h3",
                    summary="final completion 020h3",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="OpenClaw",
                    source={
                        "channel": "clawboard",
                        "sessionKey": board_session_key,
                        "requestId": request_id,
                        "messageId": "oc:main-020h3",
                    },
                ),
                idempotency_key="openclaw-chat:assistant:020h3-main",
            )

            replay_row = main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="final completion 020h3",
                    summary="final completion 020h3",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "webchat",
                        "sessionKey": gateway_session_key,
                        "requestId": request_id,
                        "messageId": "oc:assistant-020h3-replay",
                        "boardScopeTopicId": topic_id,
                    },
                ),
                idempotency_key="src:conversation:webchat:assistant:oc:assistant-020h3-replay",
            )

            self.assertEqual(replay_row.id, main_row.id)
            self.assertNotEqual(replay_row.id, subagent_row.id)
            assistant_rows = session.exec(
                select(LogEntry)
                .where(LogEntry.type == "conversation")
                .where(LogEntry.agentId == "assistant")
                .where(LogEntry.source["requestId"].as_string() == request_id)
            ).all()
            self.assertEqual(len(assistant_rows), 2)

    def test_ing_020h4_history_ingest_skips_injected_context_artifacts_and_advances_cursor(self):
        session_key = "clawboard:topic:topic-ing-020h4"
        artifact_ts = 1700000040000
        ingested, max_seen = main_module._ingest_openclaw_history_messages(
            session_key=session_key,
            messages=[
                {
                    "timestamp": artifact_ts,
                    "role": "assistant",
                    "text": "[CLAWBOARD_CONTEXT_BEGIN]\\ncontext payload\\n[CLAWBOARD_CONTEXT_END]",
                }
            ],
            since_ms=0,
        )

        self.assertEqual(ingested, 0)
        self.assertEqual(max_seen, artifact_ts)
        with get_session() as session:
            rows = session.exec(select(LogEntry)).all()
            self.assertEqual(rows, [])

    def test_ing_020h5_history_ingest_skips_legacy_context_wrapper_artifacts_and_advances_cursor(self):
        session_key = "clawboard:topic:topic-ing-020h5"
        artifact_ts = 1700000045000
        ingested, max_seen = main_module._ingest_openclaw_history_messages(
            session_key=session_key,
            messages=[
                {
                    "timestamp": artifact_ts,
                    "role": "assistant",
                    "text": (
                        "Clawboard continuity hook is active for this turn.\n"
                        "Use this Clawboard retrieval context to improve continuity.\n"
                        "Clawboard Context (Layered):\n"
                        "- synthetic context payload"
                    ),
                }
            ],
            since_ms=0,
        )

        self.assertEqual(ingested, 0)
        self.assertEqual(max_seen, artifact_ts)
        with get_session() as session:
            rows = session.exec(select(LogEntry)).all()
            self.assertEqual(rows, [])

    def test_chat_020i_in_flight_probe_allows_multi_hour_windows(self):
        with patch.dict(
            os.environ,
            {"OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "7200"},
            clear=False,
        ):
            self.assertEqual(main_module._openclaw_chat_in_flight_probe_seconds(), 7200.0)

    def test_chat_020j_request_attribution_lookback_defaults_to_days(self):
        with patch.dict(
            os.environ,
            {
                "OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS": "",
                "OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES": "",
            },
            clear=False,
        ):
            self.assertEqual(main_module._openclaw_request_attribution_lookback_seconds(), 1209600)
            self.assertEqual(main_module._openclaw_request_attribution_max_candidates(), 24)

    def test_chat_001_persists_user_log_and_enqueues_durable_dispatch(self):
        payload = OpenClawChatRequest(
            sessionKey="clawboard:topic:topic-chat-001",
            message="persist before dispatch",
            agentId="main",
        )
        background = BackgroundTasks()

        with patch.dict(
            os.environ,
            {"OPENCLAW_BASE_URL": "http://127.0.0.1:18789", "OPENCLAW_GATEWAY_TOKEN": "test-token"},
            clear=False,
        ), patch.object(background, "add_task") as add_task:
            response = main_module.openclaw_chat(payload, background)

        self.assertTrue(response.get("queued"))
        request_id = str(response.get("requestId") or "")
        self.assertTrue(request_id.startswith("occhat-"))
        add_task.assert_not_called()

        with get_session() as session:
            user_rows = session.exec(select(LogEntry).where(LogEntry.content == "persist before dispatch")).all()
            self.assertTrue(user_rows)
            queue_row = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == request_id)
            ).first()
            self.assertIsNotNone(queue_row)
            self.assertEqual(str(queue_row.status or ""), "pending")
            self.assertEqual(str(queue_row.sessionKey or ""), "clawboard:topic:topic-chat-001")

    def test_chat_001b_cancel_fans_out_to_linked_subagent_sessions(self):
        request_id = "occhat-cancel-001b"
        parent_session = "clawboard:task:topic-cancel-001b:task-cancel-001b"
        subagent_session = "agent:coding:subagent:cancel-001b"
        created = now_iso()
        with get_session() as session:
            session.add(
                OpenClawChatDispatchQueue(
                    requestId=request_id,
                    sessionKey=parent_session,
                    agentId="main",
                    sentAt=created,
                    message="parent dispatch",
                    attachmentIds=[],
                    status="processing",
                    attempts=1,
                    nextAttemptAt=created,
                    claimedAt=created,
                    completedAt=None,
                    lastError=None,
                    createdAt=created,
                    updatedAt=created,
                )
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="action",
                    content="Tool call: sessions_spawn",
                    summary="spawn subagent",
                    raw='{"session":"agent:coding:subagent:cancel-001b"}',
                    createdAt=created,
                    agentId="main",
                    agentLabel="Main",
                    source={
                        "channel": "clawboard",
                        "sessionKey": parent_session,
                        "requestId": request_id,
                    },
                ),
                idempotency_key="cancel-001b-anchor",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="action",
                    content="Tool result: exec_command",
                    summary="subagent progress",
                    raw='{"ok":true}',
                    createdAt=created,
                    agentId="coding",
                    agentLabel="Agent coding",
                    source={
                        "channel": "direct",
                        "sessionKey": subagent_session,
                        "requestId": request_id,
                        "boardScopeTopicId": "topic-cancel-001b",
                        "boardScopeTaskId": "task-cancel-001b",
                    },
                ),
                idempotency_key="cancel-001b-subagent",
            )

        rpc_calls: list[tuple[str, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            rpc_calls.append((method, params))
            return {"ok": True}

        with patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)):
            response = main_module.openclaw_chat_cancel(
                OpenClawChatCancelRequest(sessionKey=parent_session, requestId=request_id)
            )

        self.assertTrue(bool(response.get("aborted")))
        self.assertEqual(int(response.get("queueCancelled") or 0), 1)
        cancelled_sessions = set(response.get("sessionKeys") or [])
        self.assertIn(parent_session, cancelled_sessions)
        self.assertIn(subagent_session, cancelled_sessions)
        self.assertEqual(int(response.get("gatewayAbortCount") or 0), len(rpc_calls))
        called_sessions = {str(params.get("sessionKey") or "") for method, params in rpc_calls if method == "chat.abort"}
        self.assertIn(parent_session, called_sessions)
        self.assertIn(subagent_session, called_sessions)
        self.assertTrue(
            all(str(params.get("requestId") or "") == request_id for method, params in rpc_calls if method == "chat.abort")
        )

        with get_session() as session:
            rows = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == request_id)
            ).all()
            self.assertTrue(rows)
            for row in rows:
                self.assertEqual(str(row.status or ""), "failed")
                self.assertEqual(str(row.lastError or ""), "user_cancelled")
                self.assertIsNone(row.claimedAt)
                self.assertTrue(bool(str(row.completedAt or "").strip()))

    def test_chat_001c_cancel_request_filter_matches_retry_suffix_rows(self):
        request_id_base = "occhat-cancel-001c"
        request_id_retry = f"{request_id_base}:retry-2"
        session_key = "clawboard:topic:topic-cancel-001c"
        created = now_iso()
        with get_session() as session:
            session.add(
                OpenClawChatDispatchQueue(
                    requestId=request_id_retry,
                    sessionKey=session_key,
                    agentId="main",
                    sentAt=created,
                    message="retry dispatch",
                    attachmentIds=[],
                    status="pending",
                    attempts=2,
                    nextAttemptAt=created,
                    claimedAt=None,
                    completedAt=None,
                    lastError=None,
                    createdAt=created,
                    updatedAt=created,
                )
            )
            session.commit()

        with patch.object(main_module, "gateway_rpc", new=AsyncMock(return_value={"ok": True})):
            response = main_module.openclaw_chat_cancel(
                OpenClawChatCancelRequest(sessionKey=session_key, requestId=request_id_base)
            )

        self.assertTrue(bool(response.get("aborted")))
        self.assertEqual(int(response.get("queueCancelled") or 0), 1)
        with get_session() as session:
            row = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == request_id_retry)
            ).first()
            self.assertIsNotNone(row)
            self.assertEqual(str(row.status or ""), "failed")
            self.assertEqual(str(row.lastError or ""), "user_cancelled")

    def test_chat_002_attachment_payload_is_bound_into_gateway_call(self):
        root = Path(TMP_DIR) / "attachments-chat-002"
        root.mkdir(parents=True, exist_ok=True)
        attachment_path = root / "att-chat-002"
        attachment_bytes = b"hello attachment payload\n"
        attachment_path.write_bytes(attachment_bytes)

        published: list[dict] = []
        captured: dict[str, object] = {}

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            captured["method"] = method
            captured["params"] = params
            captured["kwargs"] = kwargs
            return {"ok": True}

        with patch.object(main_module, "ATTACHMENTS_DIR", str(root)), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check", return_value=None
        ):
            main_module._run_openclaw_chat(
                "request-chat-002",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-002",
                agent_id="main",
                sent_at=now_iso(),
                message="send with attachment",
                attachments=[
                    {
                        "id": "att-chat-002",
                        "storagePath": "att-chat-002",
                        "fileName": "notes.txt",
                        "mimeType": "text/plain",
                        "sizeBytes": len(attachment_bytes),
                    }
                ],
            )

        self.assertEqual(captured.get("method"), "chat.send")
        params = captured.get("params") or {}
        ws_attachments = params.get("attachments") if isinstance(params, dict) else []
        self.assertTrue(ws_attachments)
        self.assertEqual(ws_attachments[0].get("fileName"), "notes.txt")
        self.assertEqual(ws_attachments[0].get("mimeType"), "text/plain")
        decoded = base64.b64decode(ws_attachments[0].get("content") or "")
        self.assertEqual(decoded, attachment_bytes)

    def test_chat_003_run_openclaw_chat_emits_typing_start_without_forced_stop_on_success(self):
        published: list[dict] = []
        scheduled: list[dict] = []

        with patch.object(main_module.event_hub, "publish", side_effect=_publish_collector(published)), patch.object(
            main_module, "gateway_rpc", new=AsyncMock(return_value={"ok": True})
        ), patch.object(main_module, "_schedule_openclaw_assistant_log_check", side_effect=lambda **kwargs: scheduled.append(kwargs)):
            main_module._run_openclaw_chat(
                "request-chat-003",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-003",
                agent_id="main",
                sent_at=now_iso(),
                message="hello",
                attachments=None,
            )

        typing_events = [event for event in published if str(event.get("type") or "") == "openclaw.typing"]
        self.assertEqual(len(typing_events), 1)
        self.assertTrue(bool((typing_events[0].get("data") or {}).get("typing")))
        self.assertEqual((typing_events[0].get("data") or {}).get("requestId"), "request-chat-003")
        self.assertEqual(len(scheduled), 1)

    def test_chat_004_gateway_failure_still_emits_typing_false(self):
        published: list[dict] = []

        with patch.object(main_module.event_hub, "publish", side_effect=_publish_collector(published)), patch.object(
            main_module, "gateway_rpc", new=AsyncMock(side_effect=RuntimeError("boom"))
        ), patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-004",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004",
                agent_id="main",
                sent_at=now_iso(),
                message="trigger failure",
                attachments=None,
            )

        error_logger.assert_called_once()
        typing_events = [event for event in published if str(event.get("type") or "") == "openclaw.typing"]
        self.assertTrue(typing_events)
        self.assertFalse(bool((typing_events[-1].get("data") or {}).get("typing")))

    def test_chat_004b_in_flight_recovery_aborts_and_retries_once(self):
        published: list[dict] = []
        scheduled: list[dict] = []
        calls: list[tuple[str, dict, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            calls.append((method, params, kwargs))
            idx = len(calls)
            if idx == 1:
                return {"status": "started", "runId": "run-004b-1"}
            if idx == 2:
                return {"status": "in_flight", "runId": "run-004b-1"}
            if idx == 3:
                return {"aborted": True}
            if idx == 4:
                return {"status": "started", "runId": "run-004b-2"}
            raise AssertionError(f"unexpected gateway call {idx}: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_POLL_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_RETRY_GRACE_SECONDS": "0",
            },
            clear=False,
        ), patch.object(main_module, "_openclaw_chat_request_has_non_user_activity", return_value=False), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check", side_effect=lambda **kwargs: scheduled.append(kwargs)
        ), patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-004b",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004b",
                agent_id="main",
                sent_at=now_iso(),
                message="trigger in-flight recovery",
                attachments=None,
            )

        self.assertEqual([call[0] for call in calls], ["chat.send", "chat.send", "chat.abort", "chat.send"])
        self.assertEqual(calls[0][1].get("idempotencyKey"), "request-chat-004b")
        self.assertEqual(calls[1][1].get("idempotencyKey"), "request-chat-004b")
        self.assertEqual(calls[3][1].get("idempotencyKey"), "request-chat-004b:retry-1")
        abort_params = calls[2][1]
        self.assertEqual(abort_params.get("sessionKey"), "clawboard:topic:topic-chat-004b")
        self.assertEqual(abort_params.get("runId"), "run-004b-1")
        self.assertEqual(len(scheduled), 1)
        error_logger.assert_not_called()

    def test_chat_004b1_topic_session_uses_board_probe_fallback_when_global_probe_disabled(self):
        published: list[dict] = []
        scheduled: list[dict] = []
        calls: list[tuple[str, dict, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            calls.append((method, params, kwargs))
            idx = len(calls)
            if idx == 1:
                return {"status": "started", "runId": "run-004b1-1"}
            if idx == 2:
                return {"status": "in_flight", "runId": "run-004b1-1"}
            if idx == 3:
                return {"aborted": True}
            if idx == 4:
                return {"status": "started", "runId": "run-004b1-2"}
            raise AssertionError(f"unexpected gateway call {idx}: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_PROBE_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_POLL_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_RETRY_GRACE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_ABORT_RETRY": "1",
            },
            clear=False,
        ), patch.object(main_module, "_openclaw_chat_request_has_non_user_activity", return_value=False), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check", side_effect=lambda **kwargs: scheduled.append(kwargs)
        ), patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-004b1",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004b1",
                agent_id="main",
                sent_at=now_iso(),
                message="trigger board fallback recovery",
                attachments=None,
            )

        self.assertEqual([call[0] for call in calls], ["chat.send", "chat.send", "chat.abort", "chat.send"])
        self.assertEqual(calls[0][1].get("idempotencyKey"), "request-chat-004b1")
        self.assertEqual(calls[1][1].get("idempotencyKey"), "request-chat-004b1")
        self.assertEqual(calls[3][1].get("idempotencyKey"), "request-chat-004b1:retry-1")
        abort_params = calls[2][1]
        self.assertEqual(abort_params.get("sessionKey"), "clawboard:topic:topic-chat-004b1")
        self.assertEqual(abort_params.get("runId"), "run-004b1-1")
        self.assertEqual(len(scheduled), 1)
        error_logger.assert_not_called()

    def test_chat_004b1a_topic_session_skips_abort_retry_by_default(self):
        published: list[dict] = []
        scheduled: list[dict] = []
        calls: list[tuple[str, dict, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            calls.append((method, params, kwargs))
            if len(calls) > 1:
                raise AssertionError(f"board default should not trigger probe abort+retry calls: {len(calls)}")
            return {"status": "started", "runId": "run-004b1a-1"}

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_PROBE_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_POLL_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_RETRY_GRACE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_ABORT_RETRY": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_DIRECT_RETRY": "0",
            },
            clear=False,
        ), patch.object(main_module, "_openclaw_chat_request_has_non_user_activity", return_value=False), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check", side_effect=lambda **kwargs: scheduled.append(kwargs)
        ), patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-004b1a",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004b1a",
                agent_id="main",
                sent_at=now_iso(),
                message="board default should avoid abort retry",
                attachments=None,
            )

        self.assertEqual([call[0] for call in calls], ["chat.send"])
        self.assertEqual(calls[0][1].get("idempotencyKey"), "request-chat-004b1a")
        self.assertEqual(len(scheduled), 1)
        error_logger.assert_not_called()

    def test_chat_004b1aa_topic_session_direct_retries_without_abort_by_default(self):
        published: list[dict] = []
        scheduled: list[dict] = []
        calls: list[tuple[str, dict, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            calls.append((method, params, kwargs))
            idx = len(calls)
            if idx == 1:
                return {"status": "started", "runId": "run-004b1aa-1"}
            if idx == 2:
                return {"status": "started", "runId": "run-004b1aa-2"}
            raise AssertionError(f"unexpected gateway call {idx}: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_PROBE_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_POLL_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_RETRY_GRACE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_ABORT_RETRY": "0",
            },
            clear=False,
        ), patch.object(main_module, "_openclaw_chat_request_has_non_user_activity", return_value=False), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check", side_effect=lambda **kwargs: scheduled.append(kwargs)
        ), patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-004b1aa",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004b1aa",
                agent_id="main",
                sent_at=now_iso(),
                message="board default should try direct retry before watchdog-only recovery",
                attachments=None,
            )

        self.assertEqual([call[0] for call in calls], ["chat.send", "chat.send"])
        self.assertEqual(calls[0][1].get("idempotencyKey"), "request-chat-004b1aa")
        self.assertEqual(calls[1][1].get("idempotencyKey"), "request-chat-004b1aa:probe-direct-retry-1")
        self.assertEqual(len(scheduled), 1)
        error_logger.assert_not_called()

    def test_chat_004b1ab_topic_session_direct_retry_requires_progress_during_grace(self):
        published: list[dict] = []
        scheduled: list[dict] = []
        calls: list[tuple[str, dict, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            calls.append((method, params, kwargs))
            idx = len(calls)
            if idx == 1:
                return {"status": "started", "runId": "run-004b1ab-1"}
            if idx == 2:
                return {"status": "started", "runId": "run-004b1ab-2"}
            raise AssertionError(f"unexpected gateway call {idx}: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_PROBE_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_POLL_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_RETRY_GRACE_SECONDS": "1",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_RETRY_GRACE_SECONDS": "0.05",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_ABORT_RETRY": "0",
            },
            clear=False,
        ), patch.object(main_module, "_openclaw_chat_request_has_non_user_activity", return_value=False), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check", side_effect=lambda **kwargs: scheduled.append(kwargs)
        ), patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            ok = main_module._run_openclaw_chat(
                "request-chat-004b1ab",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004b1ab",
                agent_id="main",
                sent_at=now_iso(),
                message="board direct retry should fail fast when no progress follows",
                attachments=None,
            )

        self.assertFalse(ok)
        self.assertEqual([call[0] for call in calls], ["chat.send", "chat.send"])
        self.assertEqual(calls[0][1].get("idempotencyKey"), "request-chat-004b1ab")
        self.assertEqual(calls[1][1].get("idempotencyKey"), "request-chat-004b1ab:probe-direct-retry-1")
        # Failure path should not schedule assistant watchdog checks.
        self.assertEqual(len(scheduled), 0)
        error_logger.assert_called_once()
        _, kwargs = error_logger.call_args
        self.assertIn("direct retry", str(kwargs.get("raw") or "").lower())

    def test_chat_004b1b_dispatch_retry_attempt_uses_retry_scoped_idempotency(self):
        published: list[dict] = []
        scheduled: list[dict] = []
        calls: list[tuple[str, dict, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            calls.append((method, params, kwargs))
            idx = len(calls)
            if idx == 1:
                return {"status": "started", "runId": "run-004b1b-1"}
            if idx == 2:
                return {"status": "in_flight", "runId": "run-004b1b-1"}
            if idx == 3:
                return {"aborted": True}
            if idx == 4:
                return {"status": "started", "runId": "run-004b1b-2"}
            raise AssertionError(f"unexpected gateway call {idx}: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_PROBE_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_POLL_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_RETRY_GRACE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_ABORT_RETRY": "1",
            },
            clear=False,
        ), patch.object(main_module, "_openclaw_chat_request_has_non_user_activity", return_value=False), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check", side_effect=lambda **kwargs: scheduled.append(kwargs)
        ), patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-004b1b",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004b1b",
                agent_id="main",
                sent_at=now_iso(),
                message="trigger board fallback recovery with retry attempt",
                attachments=None,
                dispatch_attempt=3,
            )

        self.assertEqual([call[0] for call in calls], ["chat.send", "chat.send", "chat.abort", "chat.send"])
        self.assertEqual(calls[0][1].get("idempotencyKey"), "request-chat-004b1b:retry-2")
        self.assertEqual(calls[1][1].get("idempotencyKey"), "request-chat-004b1b:retry-2")
        self.assertEqual(calls[3][1].get("idempotencyKey"), "request-chat-004b1b:retry-2-probe-retry-1")
        abort_params = calls[2][1]
        self.assertEqual(abort_params.get("sessionKey"), "clawboard:topic:topic-chat-004b1b")
        self.assertEqual(abort_params.get("runId"), "run-004b1b-1")
        self.assertEqual(len(scheduled), 1)
        error_logger.assert_not_called()

    def test_chat_004b2_non_board_session_skips_board_probe_fallback(self):
        published: list[dict] = []
        scheduled: list[dict] = []
        calls: list[tuple[str, dict, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            calls.append((method, params, kwargs))
            if len(calls) > 1:
                raise AssertionError(f"non-board fallback should not trigger extra calls: {len(calls)}")
            return {"status": "started", "runId": "run-004b2-1"}

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "0",
                "OPENCLAW_CHAT_BOARD_IN_FLIGHT_PROBE_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_POLL_SECONDS": "0.01",
            },
            clear=False,
        ), patch.object(main_module, "_openclaw_chat_request_has_non_user_activity", return_value=False), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check", side_effect=lambda **kwargs: scheduled.append(kwargs)
        ), patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-004b2",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="agent:main:main",
                agent_id="main",
                sent_at=now_iso(),
                message="non-board session should skip board fallback",
                attachments=None,
            )

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1].get("idempotencyKey"), "request-chat-004b2")
        self.assertEqual(len(scheduled), 1)
        error_logger.assert_not_called()

    def test_chat_004c_in_flight_recovery_logs_error_when_retry_still_stuck(self):
        published: list[dict] = []
        calls: list[tuple[str, dict, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            calls.append((method, params, kwargs))
            idx = len(calls)
            if idx == 1:
                return {"status": "started", "runId": "run-004c-1"}
            if idx == 2:
                return {"status": "in_flight", "runId": "run-004c-1"}
            if idx == 3:
                return {"aborted": True}
            if idx == 4:
                return {"status": "in_flight", "runId": "run-004c-1"}
            raise AssertionError(f"unexpected gateway call {idx}: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_POLL_SECONDS": "0.01",
            },
            clear=False,
        ), patch.object(main_module, "_openclaw_chat_request_has_non_user_activity", return_value=False), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check"
        ) as schedule_mock, patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-004c",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004c",
                agent_id="main",
                sent_at=now_iso(),
                message="trigger in-flight recovery failure",
                attachments=None,
            )

        self.assertEqual([call[0] for call in calls], ["chat.send", "chat.send", "chat.abort", "chat.send"])
        self.assertEqual(calls[0][1].get("idempotencyKey"), "request-chat-004c")
        self.assertEqual(calls[1][1].get("idempotencyKey"), "request-chat-004c")
        self.assertEqual(calls[3][1].get("idempotencyKey"), "request-chat-004c:retry-1")
        schedule_mock.assert_not_called()
        error_logger.assert_called_once()
        kwargs = error_logger.call_args.kwargs
        self.assertIn("stalled in-flight", str(kwargs.get("raw") or "").lower())

    def test_chat_004d_in_flight_recovery_logs_error_when_no_progress_after_retry(self):
        published: list[dict] = []
        calls: list[tuple[str, dict, dict]] = []

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            calls.append((method, params, kwargs))
            idx = len(calls)
            if idx == 1:
                return {"status": "started", "runId": "run-004d-1"}
            if idx == 2:
                return {"status": "in_flight", "runId": "run-004d-1"}
            if idx == 3:
                return {"aborted": True}
            if idx == 4:
                return {"status": "started", "runId": "run-004d-2"}
            raise AssertionError(f"unexpected gateway call {idx}: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_PROBE_POLL_SECONDS": "0.01",
                "OPENCLAW_CHAT_IN_FLIGHT_RETRY_GRACE_SECONDS": "0.01",
            },
            clear=False,
        ), patch.object(main_module, "_openclaw_chat_request_has_non_user_activity", return_value=False), patch.object(
            main_module.event_hub, "publish", side_effect=_publish_collector(published)
        ), patch.object(main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)), patch.object(
            main_module, "_schedule_openclaw_assistant_log_check"
        ) as schedule_mock, patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-004d",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004d",
                agent_id="main",
                sent_at=now_iso(),
                message="trigger post-retry grace failure",
                attachments=None,
            )

        self.assertEqual([call[0] for call in calls], ["chat.send", "chat.send", "chat.abort", "chat.send"])
        self.assertEqual(calls[0][1].get("idempotencyKey"), "request-chat-004d")
        self.assertEqual(calls[1][1].get("idempotencyKey"), "request-chat-004d")
        self.assertEqual(calls[3][1].get("idempotencyKey"), "request-chat-004d:retry-1")
        schedule_mock.assert_not_called()
        error_logger.assert_called_once()
        kwargs = error_logger.call_args.kwargs
        self.assertIn("remained stalled after abort+retry", str(kwargs.get("raw") or "").lower())

    def test_chat_004d1_progress_check_matches_retry_suffix_request_id(self):
        sent_at = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="action",
                    content="retry-attempt progress",
                    summary="retry-attempt progress",
                    createdAt=now_iso(),
                    agentId="toolresult",
                    agentLabel="Toolresult",
                    source={
                        "channel": "clawboard",
                        "sessionKey": "clawboard:topic:topic-chat-004d1",
                        "requestId": "request-chat-004d1:retry-1",
                        "messageId": "request-chat-004d1:retry-1",
                    },
                ),
                idempotency_key="chat-004d1-progress",
            )

        self.assertTrue(
            main_module._openclaw_chat_request_has_non_user_activity(
                request_id="request-chat-004d1",
                sent_at=sent_at,
                session_key="clawboard:topic:topic-chat-004d1",
            )
        )

    def test_chat_004d2_progress_check_falls_back_to_unlabeled_session_activity(self):
        sent_at = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="action",
                    content="unlabeled tool progress",
                    summary="unlabeled tool progress",
                    createdAt=now_iso(),
                    agentId="toolresult",
                    agentLabel="Toolresult",
                    source={
                        "channel": "clawboard",
                        "sessionKey": "clawboard:topic:topic-chat-004d2|thread:worker",
                    },
                ),
                idempotency_key="chat-004d2-progress",
            )

        self.assertTrue(
            main_module._openclaw_chat_request_has_non_user_activity(
                request_id="request-chat-004d2",
                sent_at=sent_at,
                session_key="clawboard:topic:topic-chat-004d2|thread:main",
            )
        )

    def test_chat_004d3_progress_check_matches_wrapped_board_task_session_without_request_id(self):
        sent_at = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="action",
                    content="wrapped task session tool progress",
                    summary="wrapped task session tool progress",
                    createdAt=now_iso(),
                    agentId="toolresult",
                    agentLabel="Toolresult",
                    source={
                        "channel": "clawboard",
                        "sessionKey": "agent:main:clawboard:task:topic-chat-004d3:task-chat-004d3",
                    },
                ),
                idempotency_key="chat-004d3-progress",
            )

        self.assertTrue(
            main_module._openclaw_chat_request_has_non_user_activity(
                request_id="request-chat-004d3",
                sent_at=sent_at,
                session_key="clawboard:task:topic-chat-004d3:task-chat-004d3",
            )
        )

    def test_chat_004e_serializes_chat_dispatch_per_session_key(self):
        published: list[dict] = []
        call_order: list[str] = []
        first_started = threading.Event()
        release_first = threading.Event()

        async def _fake_gateway_rpc(method: str, params: dict, **kwargs):
            self.assertEqual(method, "chat.send")
            request_id = str(params.get("idempotencyKey") or "")
            call_order.append(request_id)
            if request_id == "request-chat-004e-first":
                first_started.set()
                release_first.wait(timeout=2.0)
            return {"ok": True}

        def _run(request_id: str):
            main_module._run_openclaw_chat(
                request_id,
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-004e|thread:test",
                agent_id="main",
                sent_at=now_iso(),
                message=f"dispatch {request_id}",
                attachments=None,
            )

        with patch.object(main_module.event_hub, "publish", side_effect=_publish_collector(published)), patch.object(
            main_module, "gateway_rpc", new=AsyncMock(side_effect=_fake_gateway_rpc)
        ), patch.object(main_module, "_schedule_openclaw_assistant_log_check", return_value=None):
            first = threading.Thread(target=_run, args=("request-chat-004e-first",))
            second = threading.Thread(target=_run, args=("request-chat-004e-second",))
            first.start()
            self.assertTrue(first_started.wait(timeout=1.0), "first dispatch should reach gateway")
            second.start()
            main_module.time.sleep(0.15)
            self.assertEqual(call_order, ["request-chat-004e-first"])
            release_first.set()
            first.join(timeout=2.0)
            second.join(timeout=2.0)

        self.assertEqual(call_order, ["request-chat-004e-first", "request-chat-004e-second"])

    def test_chat_005_watchdog_noop_when_assistant_log_arrives(self):
        sent_at = now_iso()
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant delivered",
                    summary="assistant delivered",
                    createdAt=sent_at,
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={"sessionKey": "channel:watchdog-ok"},
                ),
                idempotency_key="watchdog-ok-assistant",
            )

        watchdog = main_module._OpenClawAssistantLogWatchdog()
        with patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            retry_after = watchdog._check(
                base_key="channel:watchdog-ok",
                request_id="request-watchdog-ok",
                sent_at=sent_at,
                agent_id="main",
            )
        self.assertIsNone(retry_after)
        error_logger.assert_not_called()

    def test_chat_006_watchdog_logs_when_assistant_is_missing(self):
        sent_at = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        watchdog = main_module._OpenClawAssistantLogWatchdog()
        with patch.object(main_module, "_log_openclaw_chat_watchdog_warning") as warning_logger, patch.object(
            main_module, "_log_openclaw_chat_error"
        ) as error_logger:
            retry_after = watchdog._check(
                base_key="channel:watchdog-missing",
                request_id="request-watchdog-missing",
                sent_at=sent_at,
                poll_seconds=5.0,
                idle_seconds=30.0,
            )
        self.assertIsNotNone(retry_after)
        self.assertEqual(float(retry_after or 0.0), 5.0)
        warning_logger.assert_called_once()
        kwargs = warning_logger.call_args.kwargs
        detail = str(kwargs.get("detail") or "")
        self.assertIn("no assistant output has been logged", detail.lower())
        self.assertIn("keep monitoring", detail.lower())
        error_logger.assert_not_called()

    def test_chat_009_watchdog_retries_while_recent_non_user_activity_exists(self):
        sent_at = (datetime.now(timezone.utc) - timedelta(seconds=45)).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="action",
                    content="tool call: memory_search",
                    summary="tool call: memory_search",
                    createdAt=now_iso(),
                    agentId="main",
                    agentLabel="Main",
                    source={"sessionKey": "channel:watchdog-active", "requestId": "request-watchdog-active"},
                ),
                idempotency_key="watchdog-active-action",
            )

        watchdog = main_module._OpenClawAssistantLogWatchdog()
        with patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            retry_after = watchdog._check(
                base_key="channel:watchdog-active",
                request_id="request-watchdog-active",
                sent_at=sent_at,
                poll_seconds=11.0,
                idle_seconds=120.0,
            )
        self.assertIsNotNone(retry_after)
        self.assertGreater(float(retry_after or 0), 0.0)
        self.assertLessEqual(float(retry_after or 0), 11.0)
        error_logger.assert_not_called()

    def test_chat_010_watchdog_retries_before_idle_threshold_without_activity(self):
        watchdog = main_module._OpenClawAssistantLogWatchdog()
        with patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            retry_after = watchdog._check(
                base_key="channel:watchdog-wait",
                request_id="request-watchdog-wait",
                sent_at=now_iso(),
                poll_seconds=7.0,
                idle_seconds=120.0,
            )
        self.assertIsNotNone(retry_after)
        self.assertGreater(float(retry_after or 0), 0.0)
        self.assertLessEqual(float(retry_after or 0), 7.0)
        error_logger.assert_not_called()

    def test_chat_011_recovery_reschedules_unresolved_openclaw_request(self):
        sent_at = (datetime.now(timezone.utc) - timedelta(seconds=900)).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="recover me",
                    summary="recover me",
                    createdAt=sent_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": "clawboard:topic:topic-recover-011",
                        "requestId": "request-recover-011",
                    },
                ),
                idempotency_key="recover-011-user",
            )

        class _StubWatchdog:
            def __init__(self):
                self.calls: list[dict] = []

            def schedule(self, **kwargs):
                self.calls.append(kwargs)

        stub = _StubWatchdog()
        with patch.object(main_module, "_get_openclaw_assistant_log_watchdog", return_value=stub), patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_ASSISTANT_LOG_GRACE_SECONDS": "300",
                "OPENCLAW_CHAT_ASSISTANT_LOG_POLL_SECONDS": "30",
                "OPENCLAW_CHAT_ASSISTANT_LOG_IDLE_SECONDS": "600",
                "OPENCLAW_CHAT_ASSISTANT_LOG_RECOVERY_LOOKBACK_SECONDS": "3600",
                "OPENCLAW_CHAT_ASSISTANT_LOG_RECOVERY_MAX_ROWS": "1000",
            },
            clear=False,
        ):
            recovered = main_module._recover_openclaw_assistant_log_checks()

        self.assertEqual(recovered, 1)
        self.assertEqual(len(stub.calls), 1)
        call = stub.calls[0]
        self.assertEqual(call.get("request_id"), "request-recover-011")
        self.assertEqual(call.get("session_key"), "clawboard:topic:topic-recover-011")
        self.assertEqual(call.get("sent_at"), sent_at)
        self.assertEqual(float(call.get("delay_seconds", 1.0)), 0.0)

    def test_chat_012_recovery_skips_terminal_and_assistant_completed_requests(self):
        sent_at = now_iso()
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="terminal request",
                    summary="terminal request",
                    createdAt=sent_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": "clawboard:topic:topic-recover-012",
                        "requestId": "request-recover-terminal",
                    },
                ),
                idempotency_key="recover-012-user-terminal",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="system",
                    content="already warned",
                    summary="already warned",
                    createdAt=now_iso(),
                    agentId="system",
                    agentLabel="Clawboard",
                    source={
                        "channel": "clawboard",
                        "sessionKey": "clawboard:topic:topic-recover-012",
                        "requestId": "request-recover-terminal",
                    },
                ),
                idempotency_key="recover-012-terminal",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant request",
                    summary="assistant request",
                    createdAt=sent_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": "clawboard:topic:topic-recover-012",
                        "requestId": "request-recover-assistant",
                    },
                ),
                idempotency_key="recover-012-user-assistant",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="assistant already replied",
                    summary="assistant already replied",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "openclaw",
                        "sessionKey": "clawboard:topic:topic-recover-012",
                        "requestId": "request-recover-assistant",
                    },
                ),
                idempotency_key="recover-012-assistant",
            )

        class _StubWatchdog:
            def __init__(self):
                self.calls: list[dict] = []

            def schedule(self, **kwargs):
                self.calls.append(kwargs)

        stub = _StubWatchdog()
        with patch.object(main_module, "_get_openclaw_assistant_log_watchdog", return_value=stub), patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_ASSISTANT_LOG_RECOVERY_LOOKBACK_SECONDS": "3600",
                "OPENCLAW_CHAT_ASSISTANT_LOG_RECOVERY_MAX_ROWS": "1000",
            },
            clear=False,
        ):
            recovered = main_module._recover_openclaw_assistant_log_checks()

        self.assertEqual(recovered, 0)
        self.assertEqual(stub.calls, [])

    def test_chat_012b_recovery_keeps_warning_only_requests_active(self):
        sent_at = now_iso()
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="warning-only request",
                    summary="warning-only request",
                    createdAt=sent_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": "clawboard:topic:topic-recover-012b",
                        "requestId": "request-recover-warning-only",
                    },
                ),
                idempotency_key="recover-012b-user",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="system",
                    content="still waiting",
                    summary="still waiting",
                    createdAt=now_iso(),
                    agentId="system",
                    agentLabel="Clawboard",
                    source={
                        "channel": "clawboard",
                        "sessionKey": "clawboard:topic:topic-recover-012b",
                        "requestId": "request-recover-warning-only",
                        "watchdogMissingAssistant": True,
                    },
                ),
                idempotency_key="recover-012b-warning",
            )

        class _StubWatchdog:
            def __init__(self):
                self.calls: list[dict] = []

            def schedule(self, **kwargs):
                self.calls.append(kwargs)

        stub = _StubWatchdog()
        with patch.object(main_module, "_get_openclaw_assistant_log_watchdog", return_value=stub), patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_ASSISTANT_LOG_RECOVERY_LOOKBACK_SECONDS": "3600",
                "OPENCLAW_CHAT_ASSISTANT_LOG_RECOVERY_MAX_ROWS": "1000",
            },
            clear=False,
        ):
            recovered = main_module._recover_openclaw_assistant_log_checks()

        self.assertEqual(recovered, 1)
        self.assertEqual(len(stub.calls), 1)
        call = stub.calls[0]
        self.assertEqual(call.get("request_id"), "request-recover-warning-only")

    def test_chat_013_watchdog_exception_path_returns_retry_instead_of_dropping_check(self):
        class _BoomContext:
            def __enter__(self):
                raise RuntimeError("db transient failure")

            def __exit__(self, exc_type, exc, tb):
                return False

        watchdog = main_module._OpenClawAssistantLogWatchdog()
        with patch.object(main_module, "get_session", return_value=_BoomContext()), patch.object(
            main_module, "_log_openclaw_chat_error"
        ) as error_logger:
            retry_after = watchdog._check(
                base_key="channel:watchdog-transient-error",
                request_id="request-watchdog-transient-error",
                sent_at=now_iso(),
                poll_seconds=13.0,
                idle_seconds=60.0,
            )

        self.assertIsNotNone(retry_after)
        self.assertEqual(float(retry_after or 0.0), 13.0)
        error_logger.assert_not_called()

    def test_chat_014_watchdog_does_not_let_other_request_activity_mask_failure(self):
        sent_at = (datetime.now(timezone.utc) - timedelta(seconds=180)).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="action",
                    content="tool call from another request",
                    summary="tool call from another request",
                    createdAt=now_iso(),
                    agentId="main",
                    agentLabel="Main",
                    source={
                        "sessionKey": "channel:watchdog-shared-session",
                        "requestId": "request-other",
                    },
                ),
                idempotency_key="watchdog-shared-session-other-request",
            )

        watchdog = main_module._OpenClawAssistantLogWatchdog()
        with patch.object(main_module, "_log_openclaw_chat_watchdog_warning") as warning_logger, patch.object(
            main_module, "_log_openclaw_chat_error"
        ) as error_logger:
            retry_after = watchdog._check(
                base_key="channel:watchdog-shared-session",
                request_id="request-target",
                sent_at=sent_at,
                poll_seconds=5.0,
                idle_seconds=30.0,
            )

        self.assertIsNotNone(retry_after)
        self.assertEqual(float(retry_after or 0.0), 5.0)
        warning_logger.assert_called_once()
        detail = str(warning_logger.call_args.kwargs.get("detail") or "")
        self.assertIn("no assistant output has been logged", detail.lower())
        error_logger.assert_not_called()

    def test_chat_015_recovery_prefers_latest_duplicate_request_row(self):
        sent_at_old = (datetime.now(timezone.utc) - timedelta(seconds=1200)).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        sent_at_new = (datetime.now(timezone.utc) - timedelta(seconds=600)).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="duplicate request older row",
                    summary="duplicate request older row",
                    createdAt=sent_at_old,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": "clawboard:topic:topic-recover-015-old",
                        "requestId": "request-recover-015-duplicate",
                    },
                ),
                idempotency_key="recover-015-old",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="duplicate request newer row",
                    summary="duplicate request newer row",
                    createdAt=sent_at_new,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": "clawboard:topic:topic-recover-015-new",
                        "requestId": "request-recover-015-duplicate",
                    },
                ),
                idempotency_key="recover-015-new",
            )

        class _StubWatchdog:
            def __init__(self):
                self.calls: list[dict] = []

            def schedule(self, **kwargs):
                self.calls.append(kwargs)

        stub = _StubWatchdog()
        with patch.object(main_module, "_get_openclaw_assistant_log_watchdog", return_value=stub), patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_ASSISTANT_LOG_GRACE_SECONDS": "300",
                "OPENCLAW_CHAT_ASSISTANT_LOG_POLL_SECONDS": "30",
                "OPENCLAW_CHAT_ASSISTANT_LOG_IDLE_SECONDS": "600",
                "OPENCLAW_CHAT_ASSISTANT_LOG_RECOVERY_LOOKBACK_SECONDS": "3600",
                "OPENCLAW_CHAT_ASSISTANT_LOG_RECOVERY_MAX_ROWS": "1000",
            },
            clear=False,
        ):
            recovered = main_module._recover_openclaw_assistant_log_checks()

        self.assertEqual(recovered, 1)
        self.assertEqual(len(stub.calls), 1)
        call = stub.calls[0]
        self.assertEqual(call.get("request_id"), "request-recover-015-duplicate")
        self.assertEqual(call.get("session_key"), "clawboard:topic:topic-recover-015-new")
        self.assertEqual(call.get("sent_at"), sent_at_new)
        self.assertEqual(float(call.get("delay_seconds", 1.0)), 0.0)

    def test_chat_016_gateway_history_sync_ingests_and_persists_cursor(self):
        session_key = "agent:main:clawboard:topic:topic-history-016"
        history_messages = [
            {"timestamp": 1700000001000, "role": "user", "text": "history user", "id": "hmsg-016-user"},
            {"timestamp": 1700000002000, "role": "assistant", "text": "history assistant", "id": "hmsg-016-assistant"},
            {
                "timestamp": 1700000003000,
                "role": "tool",
                "content": [{"type": "tool_use", "name": "memory_search", "status": "ok"}],
            },
        ]

        def _fake_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "sessions.list":
                return {"sessions": [{"key": session_key, "updatedAt": 2500}]}
            if method == "chat.history":
                self.assertEqual(params.get("sessionKey"), session_key)
                return {"messages": history_messages}
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_HISTORY_LIMIT": "50",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_fake_sync_rpc):
            first_stats = main_module._sync_openclaw_gateway_history_once()
            second_stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(int(first_stats.get("ingested") or 0), 3)
        self.assertEqual(int(second_stats.get("ingested") or 0), 0)
        self.assertEqual(int(first_stats.get("sessionsScanned") or 0), 1)
        self.assertEqual(int(first_stats.get("cursorUpdates") or 0), 1)

        with get_session() as session:
            all_logs = session.exec(select(LogEntry)).all()
            scoped = [
                row
                for row in all_logs
                if isinstance(row.source, dict) and str(row.source.get("sessionKey") or "") == session_key
            ]
            self.assertEqual(len(scoped), 3)
            channels = {str((row.source or {}).get("channel") or "") for row in scoped}
            self.assertEqual(channels, {"clawboard"})
            cursor = session.get(OpenClawGatewayHistoryCursor, session_key)
            self.assertIsNotNone(cursor)
            self.assertEqual(int(cursor.lastTimestampMs or 0), 1700000003000)

    def test_chat_017_history_ingest_uses_stable_message_id_dedupe(self):
        session_key = "agent:main:clawboard:topic:topic-history-017"
        messages = [
            {
                "timestamp": 1700000010000,
                "role": "assistant",
                "text": "history dedupe assistant",
                "id": "history-message-017",
            }
        ]
        first_ingested, _ = main_module._ingest_openclaw_history_messages(
            session_key=session_key,
            messages=messages,
            since_ms=0,
        )
        second_ingested, _ = main_module._ingest_openclaw_history_messages(
            session_key=session_key,
            messages=messages,
            since_ms=0,
        )

        self.assertEqual(first_ingested, 1)
        self.assertEqual(second_ingested, 0)
        with get_session() as session:
            logs = session.exec(
                select(LogEntry).where(LogEntry.content == "history dedupe assistant")
            ).all()
            self.assertEqual(len(logs), 1)

    def test_chat_021_gateway_history_sync_continues_on_per_session_failure(self):
        failed_key = "agent:main:clawboard:topic:topic-history-021-failed"
        ok_key = "agent:main:clawboard:topic:topic-history-021-ok"

        def _fake_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "sessions.list":
                return {
                    "sessions": [
                        {"key": failed_key, "updatedAt": 2000},
                        {"key": ok_key, "updatedAt": 2001},
                    ]
                }
            if method == "chat.history":
                if str(params.get("sessionKey") or "") == failed_key:
                    raise TimeoutError("history timeout")
                return {
                    "messages": [
                        {
                            "timestamp": 1700000100000,
                            "role": "assistant",
                            "text": "history session survived partial failure",
                            "id": "hmsg-021-ok",
                        }
                    ]
                }
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_CURSOR_SEED_LIMIT": "0",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_fake_sync_rpc):
            stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(int(stats.get("ingested") or 0), 1)
        self.assertEqual(int(stats.get("sessionsScanned") or 0), 2)
        self.assertEqual(int(stats.get("failedSessions") or 0), 1)
        self.assertIn("partial failures", str(stats.get("errorSummary") or ""))
        with get_session() as session:
            rows = session.exec(
                select(LogEntry).where(LogEntry.content == "history session survived partial failure")
            ).all()
            self.assertEqual(len(rows), 1)

    def test_chat_022_gateway_history_sync_uses_cursor_seed_when_sessions_list_fails(self):
        session_key = "agent:main:clawboard:topic:topic-history-022"
        with get_session() as session:
            session.add(
                OpenClawGatewayHistoryCursor(
                    sessionKey=session_key,
                    lastTimestampMs=0,
                    updatedAt=now_iso(),
                )
            )
            session.commit()

        def _fake_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "sessions.list":
                raise TimeoutError("sessions.list timeout")
            if method == "chat.history":
                self.assertEqual(str(params.get("sessionKey") or ""), session_key)
                return {
                    "messages": [
                        {
                            "timestamp": 1700000200000,
                            "role": "assistant",
                            "text": "cursor seed fallback message",
                            "id": "hmsg-022",
                        }
                    ]
                }
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_CURSOR_SEED_LIMIT": "10",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_fake_sync_rpc):
            stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(int(stats.get("ingested") or 0), 1)
        self.assertEqual(int(stats.get("sessionsScanned") or 0), 1)
        self.assertEqual(int(stats.get("failedSessions") or 0), 0)
        self.assertIn("sessions.list fallback active", str(stats.get("errorSummary") or ""))
        with get_session() as session:
            rows = session.exec(
                select(LogEntry).where(LogEntry.content == "cursor seed fallback message")
            ).all()
            self.assertEqual(len(rows), 1)

    def test_chat_023_history_rpc_retries_with_write_scope_on_read_scope_error(self):
        calls: list[list[str] | None] = []

        def _fake_run_gateway_rpc_sync(
            method: str,
            params: dict,
            *,
            scopes=None,
            token_override=None,
            use_device_auth_override=None,
            rpc_timeout_seconds=None,
        ):
            calls.append(list(scopes) if isinstance(scopes, list) else None)
            if isinstance(scopes, list) and scopes == ["operator.read"]:
                raise RuntimeError("missing scope: operator.read")
            return {"ok": True, "method": method}

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_RETRY_WITH_WRITE_SCOPE": "1",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_rpc_sync", side_effect=_fake_run_gateway_rpc_sync):
            payload = main_module._run_gateway_history_rpc_sync("sessions.list", {"limit": 1}, scopes=["operator.read"])

        self.assertEqual(payload.get("ok"), True)
        self.assertGreaterEqual(len(calls), 2)
        self.assertEqual(calls[0], ["operator.read"])
        self.assertEqual(calls[1], ["operator.write"])

    def test_chat_024_gateway_history_sync_uses_recent_log_seeds(self):
        session_key = "agent:main:clawboard:topic:topic-history-024"
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="seed session from recent logs",
                    summary="seed session from recent logs",
                    createdAt=now_iso(),
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": session_key,
                        "requestId": "request-history-024",
                    },
                ),
                idempotency_key="seed-history-024",
            )

        def _fake_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "sessions.list":
                raise TimeoutError("sessions.list timeout")
            if method == "chat.history":
                self.assertEqual(str(params.get("sessionKey") or ""), session_key)
                return {
                    "messages": [
                        {
                            "timestamp": 1700000300000,
                            "role": "assistant",
                            "text": "recent log seed fallback message",
                            "id": "hmsg-024",
                        }
                    ]
                }
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_CURSOR_SEED_LIMIT": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_LOG_SEED_LIMIT": "10",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_LOG_SEED_LOOKBACK_SECONDS": "3600",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_fake_sync_rpc):
            stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(int(stats.get("ingested") or 0), 1)
        self.assertEqual(int(stats.get("sessionsScanned") or 0), 1)
        self.assertEqual(int(stats.get("failedSessions") or 0), 0)
        self.assertIn("sessions.list fallback active", str(stats.get("errorSummary") or ""))
        with get_session() as session:
            rows = session.exec(
                select(LogEntry).where(LogEntry.content == "recent log seed fallback message")
            ).all()
            self.assertEqual(len(rows), 1)

    def test_chat_024b_gateway_history_sync_seeds_spawned_subagent_sessions_when_sessions_list_disabled(self):
        parent_session = "clawboard:topic:topic-history-024b"
        child_session = "agent:coding:subagent:history-024b"
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="action",
                    content="Tool call: sessions_spawn",
                    summary="sessions_spawn",
                    raw=(
                        '{"tool":"sessions_spawn","result":{"childSessionKey":"'
                        + child_session
                        + '","agentId":"coding"}}'
                    ),
                    createdAt=now_iso(),
                    agentId="toolcall",
                    agentLabel="Tool call",
                    source={
                        "channel": "clawboard",
                        "sessionKey": parent_session,
                    },
                    classificationStatus="classified",
                ),
                idempotency_key="seed-history-024b-spawn",
            )

        seen_history_keys: list[str] = []

        def _fake_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "chat.history":
                key = str(params.get("sessionKey") or "")
                seen_history_keys.append(key)
                if key == child_session:
                    return {
                        "messages": [
                            {
                                "timestamp": 1700000310000,
                                "role": "assistant",
                                "text": "subagent seed fallback message",
                                "id": "hmsg-024b",
                            }
                        ]
                    }
                return {"messages": []}
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SESSIONS_LIST_DISABLE": "1",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_CURSOR_SEED_LIMIT": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_LOG_SEED_LIMIT": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_UNRESOLVED_SEED_LIMIT": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SUBAGENT_SEED_LIMIT": "10",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SUBAGENT_SEED_LOOKBACK_SECONDS": "3600",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_fake_sync_rpc):
            stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(int(stats.get("ingested") or 0), 1)
        self.assertEqual(int(stats.get("sessionsScanned") or 0), 1)
        self.assertEqual(seen_history_keys, [child_session])
        with get_session() as session:
            rows = session.exec(
                select(LogEntry).where(LogEntry.content == "subagent seed fallback message")
            ).all()
            self.assertEqual(len(rows), 1)
            source = rows[0].source if isinstance(rows[0].source, dict) else {}
            self.assertEqual(str(source.get("sessionKey") or ""), child_session)

    def test_chat_025_history_ingest_does_not_advance_cursor_past_write_failure(self):
        session_key = "agent:main:clawboard:topic:topic-history-025"
        ts_1 = 1700000400000
        ts_2 = 1700000401000
        messages = [
            {"timestamp": ts_1, "role": "assistant", "text": "cursor-safe one", "id": "hmsg-025-1"},
            {"timestamp": ts_2, "role": "assistant", "text": "cursor-safe two", "id": "hmsg-025-2"},
        ]

        original_append = main_module.append_log_entry
        call_count = {"value": 0}

        def _flaky_append(session, payload, idempotency_key=None):
            call_count["value"] += 1
            if call_count["value"] >= 2:
                raise RuntimeError("simulated write failure")
            return original_append(session, payload, idempotency_key=idempotency_key)

        with patch.object(main_module, "append_log_entry", side_effect=_flaky_append):
            ingested_first, max_seen_first = main_module._ingest_openclaw_history_messages(
                session_key=session_key,
                messages=messages,
                since_ms=0,
            )

        self.assertEqual(ingested_first, 1)
        self.assertEqual(max_seen_first, ts_1)

        ingested_second, max_seen_second = main_module._ingest_openclaw_history_messages(
            session_key=session_key,
            messages=messages,
            since_ms=max_seen_first,
        )
        self.assertEqual(ingested_second, 1)
        self.assertEqual(max_seen_second, ts_2)

        with get_session() as session:
            rows = session.exec(
                select(LogEntry).where(LogEntry.content.in_(["cursor-safe one", "cursor-safe two"]))
            ).all()
            contents = sorted(str(row.content or "") for row in rows)
            self.assertEqual(contents, ["cursor-safe one", "cursor-safe two"])

    def test_chat_026_watchdog_attempts_history_backfill_before_warning(self):
        watchdog = main_module._OpenClawAssistantLogWatchdog()
        session_key = "agent:main:clawboard:topic:topic-history-026"
        request_id = "request-history-026"
        sent_at = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        def _backfill(_session_key: str):
            with get_session() as session:
                main_module.append_log_entry(
                    session,
                    LogAppend(
                        type="conversation",
                        content="assistant recovered by backfill",
                        summary="assistant recovered by backfill",
                        createdAt=now_iso(),
                        agentId="assistant",
                        agentLabel="Assistant",
                        source={
                            "channel": "openclaw",
                            "sessionKey": session_key,
                            "requestId": request_id,
                            "messageId": request_id,
                        },
                    ),
                    idempotency_key="backfill-026-assistant",
                )
            return {"ingested": 1, "cursorUpdated": 1}

        with patch.object(main_module, "_openclaw_gateway_history_sync_enabled", return_value=True), patch.object(
            main_module,
            "_sync_openclaw_gateway_history_single_session",
            side_effect=_backfill,
        ) as backfill_mock, patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            retry_after = watchdog._check(
                base_key=session_key,
                request_id=request_id,
                sent_at=sent_at,
                poll_seconds=30.0,
                idle_seconds=30.0,
            )

        self.assertIsNone(retry_after)
        backfill_mock.assert_called_once_with(session_key)
        error_logger.assert_not_called()
        with get_session() as session:
            self.assertTrue(main_module._openclaw_watchdog_has_assistant_by_request(session, request_id, sent_at))

    def test_chat_027_unresolved_seed_sessions_excludes_resolved_and_terminal(self):
        unresolved_session = "agent:main:clawboard:topic:topic-history-027-unresolved"
        resolved_session = "agent:main:clawboard:topic:topic-history-027-resolved"
        terminal_session = "agent:main:clawboard:topic:topic-history-027-terminal"
        now = now_iso()
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="unresolved request",
                    summary="unresolved request",
                    createdAt=now,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": unresolved_session,
                        "requestId": "request-history-027-unresolved",
                    },
                ),
                idempotency_key="history-027-unresolved-user",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="resolved request",
                    summary="resolved request",
                    createdAt=now,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": resolved_session,
                        "requestId": "request-history-027-resolved",
                    },
                ),
                idempotency_key="history-027-resolved-user",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="resolved assistant",
                    summary="resolved assistant",
                    createdAt=now,
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={
                        "channel": "openclaw",
                        "sessionKey": resolved_session,
                        "requestId": "request-history-027-resolved",
                    },
                ),
                idempotency_key="history-027-resolved-assistant",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="terminal request",
                    summary="terminal request",
                    createdAt=now,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": terminal_session,
                        "requestId": "request-history-027-terminal",
                    },
                ),
                idempotency_key="history-027-terminal-user",
            )
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="system",
                    content="terminal warning",
                    summary="terminal warning",
                    createdAt=now,
                    agentId="system",
                    agentLabel="Clawboard",
                    source={
                        "channel": "clawboard",
                        "sessionKey": terminal_session,
                        "requestId": "request-history-027-terminal",
                    },
                ),
                idempotency_key="history-027-terminal-system",
            )

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_HISTORY_SYNC_UNRESOLVED_SEED_LIMIT": "10",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_UNRESOLVED_LOOKBACK_SECONDS": "3600",
            },
            clear=False,
        ):
            seeds = main_module._openclaw_gateway_history_unresolved_seed_sessions(limit=10, lookback_seconds=3600)

        self.assertEqual(seeds, [unresolved_session])

    def test_chat_028_history_sync_retries_timeout_with_smaller_limit(self):
        session_key = "agent:main:clawboard:topic:topic-history-028"
        calls: list[int] = []

        def _fake_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "sessions.list":
                return {"sessions": [{"key": session_key, "updatedAt": 3000}]}
            if method == "chat.history":
                limit = int(params.get("limit") or 0)
                calls.append(limit)
                if limit >= 120:
                    raise TimeoutError("chat history timeout")
                return {
                    "messages": [
                        {
                            "timestamp": 1700000500000,
                            "role": "assistant",
                            "text": "timeout fallback recovered",
                            "id": "hmsg-028",
                        }
                    ]
                }
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_HISTORY_LIMIT": "120",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_fake_sync_rpc):
            stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(int(stats.get("ingested") or 0), 1)
        self.assertEqual(int(stats.get("failedSessions") or 0), 0)
        self.assertEqual(int(stats.get("timeoutRecoveredSessions") or 0), 1)
        self.assertIn(120, calls)
        self.assertIn(40, calls)
        with get_session() as session:
            rows = session.exec(select(LogEntry).where(LogEntry.content == "timeout fallback recovered")).all()
            self.assertEqual(len(rows), 1)

    def test_chat_029_seed_sessions_are_preserved_when_candidate_list_is_trimmed(self):
        unresolved_key = "agent:main:clawboard:topic:topic-history-029-unresolved"
        hot_a = "agent:main:clawboard:topic:topic-history-029-a"
        hot_b = "agent:main:clawboard:topic:topic-history-029-b"
        hot_c = "agent:main:clawboard:topic:topic-history-029-c"
        requested_keys: list[str] = []

        def _fake_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "sessions.list":
                return {
                    "sessions": [
                        {"key": hot_a, "updatedAt": 3000},
                        {"key": hot_b, "updatedAt": 2000},
                        {"key": hot_c, "updatedAt": 1000},
                    ]
                }
            if method == "chat.history":
                key = str(params.get("sessionKey") or "")
                requested_keys.append(key)
                return {
                    "messages": [
                        {
                            "timestamp": 1700000600000,
                            "role": "assistant",
                            "text": f"seed-trim-{key}",
                            "id": f"hmsg-029-{key}",
                        }
                    ]
                }
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SESSION_LIMIT": "2",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_fake_sync_rpc), patch.object(
            main_module,
            "_openclaw_gateway_history_unresolved_seed_sessions",
            return_value=[unresolved_key],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_cursor_seed_sessions",
            return_value=[],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_recent_log_seed_sessions",
            return_value=[],
        ):
            stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(int(stats.get("sessionsScanned") or 0), 2)
        self.assertIn(unresolved_key, requested_keys)

    def test_chat_030_sessions_list_timeout_retries_with_reduced_window(self):
        session_key = "agent:main:clawboard:topic:topic-history-030"
        sessions_list_calls: list[tuple[int, int]] = []

        def _fake_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "sessions.list":
                limit = int(params.get("limit") or 0)
                active_minutes = int(params.get("activeMinutes") or 0)
                sessions_list_calls.append((limit, active_minutes))
                if len(sessions_list_calls) == 1:
                    raise TimeoutError("sessions.list timeout")
                return {"sessions": [{"key": session_key, "updatedAt": 4000}]}
            if method == "chat.history":
                return {
                    "messages": [
                        {
                            "timestamp": 1700000700000,
                            "role": "assistant",
                            "text": "sessions.list timeout recovered",
                            "id": "hmsg-030",
                        }
                    ]
                }
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SESSION_LIMIT": "180",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_ACTIVE_MINUTES": "10080",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_fake_sync_rpc), patch.object(
            main_module,
            "_openclaw_gateway_history_cursor_seed_sessions",
            return_value=[],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_recent_log_seed_sessions",
            return_value=[],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_unresolved_seed_sessions",
            return_value=[],
        ):
            stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(len(sessions_list_calls), 2)
        self.assertEqual(sessions_list_calls[0], (180, 10080))
        self.assertEqual(sessions_list_calls[1], (60, 5040))
        self.assertEqual(int(stats.get("sessionsListTimeoutRecovered") or 0), 1)
        self.assertEqual(int(stats.get("failedSessions") or 0), 0)
        with get_session() as session:
            rows = session.exec(select(LogEntry).where(LogEntry.content == "sessions.list timeout recovered")).all()
            self.assertEqual(len(rows), 1)

    def test_chat_031_iso_after_seconds_allows_negative_offsets(self):
        base = datetime(2026, 2, 19, 20, 0, 0, tzinfo=timezone.utc)
        earlier = main_module._iso_after_seconds(base, -120.0)
        later = main_module._iso_after_seconds(base, 120.0)
        self.assertEqual(earlier, "2026-02-19T19:58:00.000Z")
        self.assertEqual(later, "2026-02-19T20:02:00.000Z")

    def test_chat_032_auto_quarantine_only_fails_stale_synthetic_dispatch_rows(self):
        now_dt = datetime.now(timezone.utc)
        old_stamp = (now_dt - timedelta(hours=7)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        fresh_stamp = now_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with get_session() as session:
            session.add(
                OpenClawChatDispatchQueue(
                    requestId="occhat-quarantine-synth",
                    sessionKey="clawboard:task:topic-smoke-123:task-smoke-123",
                    agentId="main",
                    sentAt=old_stamp,
                    message="synthetic canary payload",
                    attachmentIds=[],
                    status="retry",
                    attempts=4,
                    nextAttemptAt=old_stamp,
                    claimedAt=None,
                    completedAt=None,
                    lastError="timeout",
                    createdAt=old_stamp,
                    updatedAt=old_stamp,
                )
            )
            session.add(
                OpenClawChatDispatchQueue(
                    requestId="occhat-quarantine-real",
                    sessionKey="clawboard:topic:topic-real-123",
                    agentId="main",
                    sentAt=old_stamp,
                    message="real user message should remain queued",
                    attachmentIds=[],
                    status="pending",
                    attempts=1,
                    nextAttemptAt=old_stamp,
                    claimedAt=None,
                    completedAt=None,
                    lastError="timeout",
                    createdAt=old_stamp,
                    updatedAt=fresh_stamp,
                )
            )
            session.commit()

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_DISPATCH_AUTO_QUARANTINE_SECONDS": "60",
                "OPENCLAW_CHAT_DISPATCH_AUTO_QUARANTINE_LIMIT": "50",
                "OPENCLAW_CHAT_DISPATCH_AUTO_QUARANTINE_SYNTHETIC_ONLY": "1",
            },
            clear=False,
        ):
            changed = main_module._openclaw_chat_dispatch_auto_quarantine_stale_rows(now_dt)

        self.assertEqual(changed, 1)
        with get_session() as session:
            synthetic_row = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == "occhat-quarantine-synth")
            ).first()
            real_row = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == "occhat-quarantine-real")
            ).first()
            self.assertIsNotNone(synthetic_row)
            self.assertIsNotNone(real_row)
            self.assertEqual(str(synthetic_row.status), "failed")
            self.assertTrue(str(synthetic_row.lastError or "").startswith("auto_quarantined:"))
            self.assertEqual(str(real_row.status), "pending")

    def test_chat_032b_recover_stale_processing_reclaims_pre_restart_claims(self):
        now_dt = datetime.now(timezone.utc)
        now_iso_value = now_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        old_stamp = (now_dt - timedelta(minutes=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        pre_restart_claim = (now_dt - timedelta(seconds=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        post_restart_claim = (now_dt - timedelta(milliseconds=200)).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        process_started_iso = (now_dt - timedelta(seconds=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        with get_session() as session:
            session.add(
                OpenClawChatDispatchQueue(
                    requestId="occhat-recover-pre-restart",
                    sessionKey="clawboard:topic:topic-recover-032b",
                    agentId="main",
                    sentAt=old_stamp,
                    message="pre restart claim",
                    attachmentIds=[],
                    status="processing",
                    attempts=2,
                    nextAttemptAt=old_stamp,
                    claimedAt=pre_restart_claim,
                    completedAt=None,
                    lastError=None,
                    createdAt=old_stamp,
                    updatedAt=pre_restart_claim,
                )
            )
            session.add(
                OpenClawChatDispatchQueue(
                    requestId="occhat-recover-post-restart",
                    sessionKey="clawboard:topic:topic-recover-032b",
                    agentId="main",
                    sentAt=old_stamp,
                    message="post restart claim",
                    attachmentIds=[],
                    status="processing",
                    attempts=1,
                    nextAttemptAt=old_stamp,
                    claimedAt=post_restart_claim,
                    completedAt=None,
                    lastError=None,
                    createdAt=old_stamp,
                    updatedAt=post_restart_claim,
                )
            )
            session.commit()

        with patch.dict(
            os.environ,
            {"OPENCLAW_CHAT_DISPATCH_STALE_PROCESSING_SECONDS": "3600"},
            clear=False,
        ), patch.object(main_module, "_OPENCLAW_CHAT_DISPATCH_PROCESS_STARTED_AT_ISO", process_started_iso):
            changed = main_module._openclaw_chat_dispatch_recover_stale_processing_jobs(now_dt)

        self.assertEqual(changed, 1)
        with get_session() as session:
            pre_row = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == "occhat-recover-pre-restart")
            ).first()
            post_row = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == "occhat-recover-post-restart")
            ).first()
            self.assertIsNotNone(pre_row)
            self.assertIsNotNone(post_row)
            self.assertEqual(str(pre_row.status), "retry")
            self.assertIsNone(pre_row.claimedAt)
            self.assertEqual(str(pre_row.nextAttemptAt or ""), now_iso_value)
            self.assertIn("Recovered stale processing dispatch row", str(pre_row.lastError or ""))
            self.assertEqual(str(post_row.status), "processing")
            self.assertEqual(str(post_row.claimedAt or ""), post_restart_claim)

    def test_chat_033_history_ingest_dedupes_when_metadata_drifts(self):
        session_key = "agent:main:clawboard:topic:topic-history-033"
        ts = 1700001234567
        messages_a = [
            {
                "timestamp": ts,
                "role": "assistant",
                "text": "history dedupe payload",
                "metadata": {"trace": "a"},
            }
        ]
        messages_b = [
            {
                "timestamp": ts,
                "role": "assistant",
                "text": "history dedupe payload",
                "metadata": {"trace": "b", "volatile": str(time.time())},
            }
        ]

        ingested_a, _ = main_module._ingest_openclaw_history_messages(
            session_key=session_key,
            messages=messages_a,
            since_ms=0,
        )
        ingested_b, _ = main_module._ingest_openclaw_history_messages(
            session_key=session_key,
            messages=messages_b,
            since_ms=0,
        )

        self.assertEqual(ingested_a, 1)
        self.assertEqual(ingested_b, 0)
        with get_session() as session:
            rows = session.exec(select(LogEntry).where(LogEntry.content == "history dedupe payload")).all()
            self.assertEqual(len(rows), 1)

    def test_chat_034_history_sync_seed_only_mode_skips_sessions_list(self):
        session_key = "clawboard:topic:topic-history-034"
        rpc_calls: list[str] = []

        def _fake_sync_rpc(method: str, params: dict, *, scopes=None):
            rpc_calls.append(method)
            if method == "chat.history":
                self.assertEqual(str(params.get("sessionKey") or ""), session_key)
                return {
                    "messages": [
                        {
                            "timestamp": 1700001500000,
                            "role": "assistant",
                            "text": "seed-only sync message",
                            "id": "hmsg-034",
                        }
                    ]
                }
            raise AssertionError(f"sessions.list should be skipped in seed-only mode: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SESSIONS_LIST_DISABLE": "1",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_fake_sync_rpc), patch.object(
            main_module,
            "_openclaw_gateway_history_cursor_seed_sessions",
            return_value=[session_key],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_recent_log_seed_sessions",
            return_value=[],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_unresolved_seed_sessions",
            return_value=[],
        ):
            stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(rpc_calls, ["chat.history"])
        self.assertEqual(int(stats.get("sessionsScanned") or 0), 1)
        self.assertEqual(int(stats.get("ingested") or 0), 1)
        with get_session() as session:
            rows = session.exec(select(LogEntry).where(LogEntry.content == "seed-only sync message")).all()
            self.assertEqual(len(rows), 1)

    def test_chat_035_history_ingest_unwraps_untrusted_metadata_and_request_id(self):
        session_key = "clawboard:topic:topic-history-035"
        existing_request_id = "occhat-history-035-existing"
        existing_created_at = datetime.fromtimestamp(1700001600, tz=timezone.utc).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        with get_session() as session:
            main_module.append_log_entry(
                session,
                LogAppend(
                    type="conversation",
                    content="existing user prompt",
                    summary="existing user prompt",
                    createdAt=existing_created_at,
                    agentId="user",
                    agentLabel="User",
                    source={
                        "channel": "openclaw",
                        "sessionKey": session_key,
                        "requestId": existing_request_id,
                        "messageId": existing_request_id,
                    },
                ),
                idempotency_key=f"openclaw-chat:user:{existing_request_id}",
            )

        wrapper_existing = (
            "Conversation info (untrusted metadata):\n"
            "```json\n"
            '{\n  "message_id": "occhat-history-035-existing",\n  "sender": "gateway-client"\n}\n'
            "```\n\n"
            "existing user prompt"
        )
        wrapper_new = (
            "Conversation info (untrusted metadata):\n"
            "```json\n"
            '{\n  "message_id": "occhat-history-035-new",\n  "sender": "gateway-client"\n}\n'
            "```\n\n"
            "new user prompt from history"
        )
        ingested, _ = main_module._ingest_openclaw_history_messages(
            session_key=session_key,
            messages=[
                {
                    "timestamp": 1700001600000,
                    "role": "user",
                    "content": [{"type": "text", "text": wrapper_existing}],
                },
                {
                    "timestamp": 1700001601000,
                    "role": "user",
                    "content": [{"type": "text", "text": wrapper_new}],
                },
            ],
            since_ms=0,
        )

        self.assertEqual(ingested, 1)
        with get_session() as session:
            all_rows = session.exec(select(LogEntry)).all()
            existing_rows = []
            new_rows = []
            for row in all_rows:
                source = row.source if isinstance(row.source, dict) else {}
                request_id = str(source.get("requestId") or "")
                if request_id == existing_request_id:
                    existing_rows.append(row)
                if request_id == "occhat-history-035-new":
                    new_rows.append(row)
            self.assertEqual(len(existing_rows), 1)

            self.assertEqual(len(new_rows), 1)
            self.assertEqual(str(new_rows[0].content or ""), "new user prompt from history")
            self.assertNotIn("Conversation info (untrusted metadata)", str(new_rows[0].content or ""))

    def test_chat_036_history_session_key_detector_includes_board_keys(self):
        self.assertTrue(main_module._openclaw_history_session_key_likely_gateway("clawboard:topic:topic-history-036"))
        self.assertTrue(
            main_module._openclaw_history_session_key_likely_gateway(
                "clawboard:task:topic-history-036:task-history-036"
            )
        )
        self.assertTrue(
            main_module._openclaw_history_session_key_likely_gateway(
                "agent:main:clawboard:topic:topic-history-036|thread:abc"
            )
        )
        self.assertFalse(main_module._openclaw_history_session_key_likely_gateway("unrelated:session:key"))

    def test_chat_037_watchdog_backfill_cooldown_applies_exponential_spacing(self):
        session_key = "clawboard:topic:topic-history-037"
        with patch.dict(
            os.environ,
            {
                "OPENCLAW_CHAT_ASSISTANT_LOG_BACKFILL_BASE_SECONDS": "60",
                "OPENCLAW_CHAT_ASSISTANT_LOG_BACKFILL_MAX_SECONDS": "3600",
            },
            clear=False,
        ):
            self.assertTrue(main_module._openclaw_watchdog_backfill_should_run(session_key, now_mono=100.0))
            main_module._openclaw_watchdog_backfill_record_result(
                session_key,
                changed=False,
                failed=False,
                now_mono=100.0,
            )
            self.assertFalse(main_module._openclaw_watchdog_backfill_should_run(session_key, now_mono=150.0))
            self.assertTrue(main_module._openclaw_watchdog_backfill_should_run(session_key, now_mono=161.0))
            main_module._openclaw_watchdog_backfill_record_result(
                session_key,
                changed=False,
                failed=True,
                now_mono=161.0,
            )
            self.assertFalse(main_module._openclaw_watchdog_backfill_should_run(session_key, now_mono=280.0))
            self.assertTrue(main_module._openclaw_watchdog_backfill_should_run(session_key, now_mono=402.0))

    def test_chat_038_history_sync_defers_session_after_timeout_failure(self):
        session_key = "agent:main:clawboard:topic:topic-history-038"
        chat_history_calls_first = {"count": 0}

        def _failing_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "sessions.list":
                return {"sessions": [{"key": session_key, "updatedAt": 1000}]}
            if method == "chat.history":
                chat_history_calls_first["count"] += 1
                raise TimeoutError("chat history timeout")
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SESSION_LIMIT": "1",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SESSION_BACKOFF_BASE_SECONDS": "600",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_TRANSPORT_RETRY_ATTEMPTS": "1",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_failing_sync_rpc), patch.object(
            main_module,
            "_openclaw_gateway_history_cursor_seed_sessions",
            return_value=[],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_recent_log_seed_sessions",
            return_value=[],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_unresolved_seed_sessions",
            return_value=[],
        ):
            first_stats = main_module._sync_openclaw_gateway_history_once()

        # First cycle tries the configured limit, then a reduced timeout-retry limit.
        self.assertEqual(chat_history_calls_first["count"], 2)
        self.assertEqual(int(first_stats.get("failedSessions") or 0), 1)

        chat_history_calls_second = {"count": 0}

        def _recovered_sync_rpc(method: str, params: dict, *, scopes=None):
            if method == "sessions.list":
                return {"sessions": [{"key": session_key, "updatedAt": 2000}]}
            if method == "chat.history":
                chat_history_calls_second["count"] += 1
                return {
                    "messages": [
                        {
                            "timestamp": 1700001700000,
                            "role": "assistant",
                            "text": "history backoff should defer this call",
                            "id": "hmsg-038",
                        }
                    ]
                }
            raise AssertionError(f"Unexpected RPC method: {method}")

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_DISABLE": "0",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SESSION_LIMIT": "1",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_SESSION_BACKOFF_BASE_SECONDS": "600",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_TRANSPORT_RETRY_ATTEMPTS": "1",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_history_rpc_sync", side_effect=_recovered_sync_rpc), patch.object(
            main_module,
            "_openclaw_gateway_history_cursor_seed_sessions",
            return_value=[],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_recent_log_seed_sessions",
            return_value=[],
        ), patch.object(
            main_module,
            "_openclaw_gateway_history_unresolved_seed_sessions",
            return_value=[],
        ):
            second_stats = main_module._sync_openclaw_gateway_history_once()

        self.assertEqual(chat_history_calls_second["count"], 0)
        self.assertEqual(int(second_stats.get("failedSessions") or 0), 0)
        self.assertEqual(int(second_stats.get("deferredByBackoff") or 0), 1)
        self.assertEqual(int(second_stats.get("ingested") or 0), 0)

    def test_chat_039_history_rpc_retries_transient_transport_errors(self):
        call_count = {"value": 0}

        def _flaky_rpc(
            method: str,
            params: dict,
            *,
            scopes=None,
            token_override=None,
            use_device_auth_override=None,
            rpc_timeout_seconds=None,
        ):
            call_count["value"] += 1
            if call_count["value"] == 1:
                raise RuntimeError("gateway connect failed: gateway client stopped")
            return {"ok": True, "method": method}

        with patch.dict(
            os.environ,
            {
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_TRANSPORT_RETRY_ATTEMPTS": "2",
                "OPENCLAW_GATEWAY_HISTORY_SYNC_TRANSPORT_RETRY_BASE_SECONDS": "0.01",
            },
            clear=False,
        ), patch.object(main_module, "_run_gateway_rpc_sync", side_effect=_flaky_rpc), patch.object(
            main_module.time, "sleep", return_value=None
        ):
            payload = main_module._run_gateway_history_rpc_sync("sessions.list", {"limit": 1}, scopes=["operator.read"])

        self.assertEqual(payload.get("ok"), True)
        self.assertEqual(call_count["value"], 2)

    def test_chat_007_openclaw_chat_fail_closes_when_persist_fails(self):
        payload = OpenClawChatRequest(
            sessionKey="clawboard:topic:topic-chat-007",
            message="cannot persist",
            agentId="main",
        )
        background = BackgroundTasks()

        with patch.dict(
            os.environ,
            {"OPENCLAW_BASE_URL": "http://127.0.0.1:18789", "OPENCLAW_GATEWAY_TOKEN": "test-token"},
            clear=False,
        ), patch.object(main_module, "append_log_entry", side_effect=RuntimeError("db down")), patch.object(
            background, "add_task"
        ) as add_task:
            with self.assertRaises(HTTPException) as ctx:
                main_module.openclaw_chat(payload, background)

        self.assertEqual(ctx.exception.status_code, 503)
        add_task.assert_not_called()

    def test_chat_008_missing_attachment_persists_error_and_skips_gateway(self):
        published: list[dict] = []

        with patch.object(main_module.event_hub, "publish", side_effect=_publish_collector(published)), patch.object(
            main_module, "gateway_rpc", new=AsyncMock(return_value={"ok": True})
        ) as rpc_mock, patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            main_module._run_openclaw_chat(
                "request-chat-008",
                base_url="http://127.0.0.1:18789",
                token="test-token",
                session_key="clawboard:topic:topic-chat-008",
                agent_id="main",
                sent_at=now_iso(),
                message="with missing attachment",
                attachments=[
                    {
                        "id": "att-missing",
                        "storagePath": "att-missing",
                        "fileName": "missing.txt",
                        "mimeType": "text/plain",
                        "sizeBytes": 1,
                    }
                ],
            )

        rpc_mock.assert_not_called()
        error_logger.assert_called_once()
        detail = str(error_logger.call_args.kwargs.get("detail") or "")
        self.assertIn("attachment missing on disk", detail.lower())
        typing_events = [event for event in published if str(event.get("type") or "") == "openclaw.typing"]
        self.assertTrue(typing_events)
        self.assertFalse(bool((typing_events[-1].get("data") or {}).get("typing")))

if __name__ == "__main__":
    unittest.main()
