from __future__ import annotations

import base64
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
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

try:
    from fastapi import BackgroundTasks, HTTPException
    from fastapi.testclient import TestClient
    from sqlalchemy.exc import OperationalError
    from sqlmodel import select

    from app import main as main_module  # noqa: E402
    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import Attachment, IngestQueue, LogEntry, Task, Topic  # noqa: E402
    from app.schemas import LogAppend, OpenClawChatRequest  # noqa: E402

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
        with get_session() as session:
            for row in session.exec(select(Attachment)).all():
                session.delete(row)
            for row in session.exec(select(IngestQueue)).all():
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

    def test_chat_001_persists_user_log_before_background_dispatch(self):
        payload = OpenClawChatRequest(
            sessionKey="clawboard:topic:topic-chat-001",
            message="persist before dispatch",
            agentId="main",
        )
        background = BackgroundTasks()
        order: list[str] = []

        with patch.dict(
            os.environ,
            {"OPENCLAW_BASE_URL": "http://127.0.0.1:18789", "OPENCLAW_GATEWAY_TOKEN": "test-token"},
            clear=False,
        ):
            def _add_task(*_args, **_kwargs):
                with get_session() as session:
                    rows = session.exec(
                        select(LogEntry).where(LogEntry.content == "persist before dispatch")
                    ).all()
                    self.assertTrue(rows, "user log should already exist before dispatch scheduling")
                order.append("dispatch")

            with patch.object(background, "add_task", side_effect=_add_task):
                response = main_module.openclaw_chat(payload, background)

        self.assertTrue(response.get("queued"))
        self.assertEqual(order, ["dispatch"])

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

    def test_chat_003_and_004_run_openclaw_chat_typing_lifecycle(self):
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
        self.assertGreaterEqual(len(typing_events), 2)
        self.assertTrue(bool((typing_events[0].get("data") or {}).get("typing")))
        self.assertFalse(bool((typing_events[-1].get("data") or {}).get("typing")))
        self.assertEqual((typing_events[0].get("data") or {}).get("requestId"), "request-chat-003")
        self.assertEqual((typing_events[-1].get("data") or {}).get("requestId"), "request-chat-003")
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
            watchdog._check(
                base_key="channel:watchdog-ok",
                request_id="request-watchdog-ok",
                sent_at=sent_at,
            )
        error_logger.assert_not_called()

    def test_chat_006_watchdog_logs_when_assistant_is_missing(self):
        watchdog = main_module._OpenClawAssistantLogWatchdog()
        with patch.object(main_module, "_log_openclaw_chat_error") as error_logger:
            watchdog._check(
                base_key="channel:watchdog-missing",
                request_id="request-watchdog-missing",
                sent_at=now_iso(),
            )
        error_logger.assert_called_once()
        kwargs = error_logger.call_args.kwargs
        detail = str(kwargs.get("detail") or "")
        self.assertIn("no assistant output was logged back", detail.lower())

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
