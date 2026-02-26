from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-orchestration-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"
os.environ["OPENCLAW_BASE_URL"] = "http://127.0.0.1:18789"
os.environ["OPENCLAW_GATEWAY_TOKEN"] = "test-token"
os.environ["CLAWBOARD_ORCHESTRATION_ENABLED"] = "1"
os.environ["CLAWBOARD_ORCHESTRATION_EMIT_CHAT_EVENTS"] = "1"
os.environ["CLAWBOARD_ORCHESTRATION_POLL_SECONDS"] = "3600"

try:
    from fastapi import BackgroundTasks
    from sqlmodel import select

    from app import main as main_module  # noqa: E402
    from app.db import get_session, init_db  # noqa: E402
    from app.models import (  # noqa: E402
        LogEntry,
        OpenClawChatDispatchQueue,
        OrchestrationEvent,
        OrchestrationItem,
        OrchestrationRun,
        Task,
        Topic,
    )
    from app.schemas import LogAppend, OpenClawChatCancelRequest, OpenClawChatRequest  # noqa: E402

    _TESTS_AVAILABLE = True
except Exception:
    BackgroundTasks = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@unittest.skipUnless(_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class OrchestrationRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        with get_session() as session:
            for row in session.exec(select(OrchestrationEvent)).all():
                session.delete(row)
            for row in session.exec(select(OrchestrationItem)).all():
                session.delete(row)
            for row in session.exec(select(OrchestrationRun)).all():
                session.delete(row)
            for row in session.exec(select(OpenClawChatDispatchQueue)).all():
                session.delete(row)
            for row in session.exec(select(LogEntry)).all():
                session.delete(row)
            for row in session.exec(select(Task)).all():
                session.delete(row)
            for row in session.exec(select(Topic)).all():
                session.delete(row)
            session.commit()

    def _openclaw_chat(self, *, session_key: str, message: str) -> str:
        payload = OpenClawChatRequest(
            sessionKey=session_key,
            message=message,
            agentId="main",
        )
        response = main_module.openclaw_chat(payload, BackgroundTasks())
        self.assertTrue(bool(response.get("queued")))
        request_id = str(response.get("requestId") or "")
        self.assertTrue(request_id.startswith("occhat-"))
        return request_id

    def _append_log(self, payload: LogAppend, idem: str):
        with get_session() as session:
            return main_module.append_log_entry(session, payload, idempotency_key=idem)

    def test_orch_001_chat_creates_run_and_main_item(self):
        session_key = "clawboard:topic:topic-orch-001"
        request_id = self._openclaw_chat(session_key=session_key, message="Plan and execute this task.")
        request_base = main_module._openclaw_request_id_base(request_id)

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_base)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "running")
            self.assertEqual(run.baseSessionKey, session_key)
            main_item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(main_item)
            self.assertEqual(main_item.status, "running")
            self.assertTrue(bool(main_item.nextCheckAt))
            logs = session.exec(select(LogEntry)).all()
            orchestration_logs = [
                row
                for row in logs
                if isinstance(getattr(row, "source", None), dict)
                and bool((row.source or {}).get("orchestration"))
                and str((row.source or {}).get("requestId") or "") == request_base
            ]
            self.assertTrue(orchestration_logs, "Expected in-band orchestration status logs for run creation.")
            self.assertTrue(any("delegation started" in str(row.summary or "").lower() for row in orchestration_logs))

    def test_orch_002_sessions_spawn_action_creates_subagent_item(self):
        session_key = "clawboard:task:topic-orch-002:task-orch-002"
        request_id = self._openclaw_chat(session_key=session_key, message="Delegate coding work.")
        child_session = "agent:coding:subagent:orch-002-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-002-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-002-spawn",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == f"subagent:{child_session}")
            ).first()
            self.assertIsNotNone(item)
            self.assertEqual(item.kind, "subagent")
            self.assertEqual(item.agentId, "coding")
            self.assertEqual(item.status, "running")
            logs = session.exec(select(LogEntry)).all()
            subagent_status_logs = [
                row
                for row in logs
                if isinstance(getattr(row, "source", None), dict)
                and bool((row.source or {}).get("orchestration"))
                and str((row.source or {}).get("eventType") or "") == "item_created"
                and str((row.source or {}).get("itemKey") or "") == f"subagent:{child_session}"
            ]
            self.assertTrue(subagent_status_logs, "Expected in-band subagent item_created status log.")
            self.assertTrue(any("delegated to coding" in str(row.summary or "").lower() for row in subagent_status_logs))

    def test_orch_002b_sessions_spawn_error_result_does_not_create_subagent_item(self):
        session_key = "clawboard:task:topic-orch-002b:task-orch-002b"
        request_id = self._openclaw_chat(session_key=session_key, message="Delegate coding work.")
        child_session = "agent:coding:subagent:orch-002b-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw=(
                    '{"result":{"details":{"status":"error","error":"gateway timeout after 10000ms",'
                    '"childSessionKey":"agent:coding:subagent:orch-002b-child"}}}'
                ),
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-002b-spawn-error",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == f"subagent:{child_session}")
            ).first()
            self.assertIsNone(item)

    def test_orch_002c_sessions_spawn_error_without_status_does_not_create_subagent_item(self):
        session_key = "clawboard:task:topic-orch-002c:task-orch-002c"
        request_id = self._openclaw_chat(session_key=session_key, message="Delegate coding work.")
        child_session = "agent:coding:subagent:orch-002c-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw=(
                    '{"isError":true,"result":{"error":"gateway timeout after 10000ms",'
                    '"childSessionKey":"agent:coding:subagent:orch-002c-child"}}'
                ),
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-002c-spawn-error",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == f"subagent:{child_session}")
            ).first()
            self.assertIsNone(item)

    def test_orch_003_main_response_does_not_close_while_subagent_still_active(self):
        session_key = "clawboard:topic:topic-orch-003"
        request_id = self._openclaw_chat(session_key=session_key, message="Do this with a subagent.")
        child_session = "agent:coding:subagent:orch-003-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003-spawn",
        )

        self._append_log(
            LogAppend(
                type="conversation",
                content="I delegated to coding and will report back.",
                summary="Main status update",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003-main-assistant",
        )

        # The status update should not close main.response while a subagent item is still running.
        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(statuses.get("main.response"), "running")
            self.assertEqual(statuses.get(f"subagent:{child_session}"), "running")

        self._append_log(
            LogAppend(
                type="conversation",
                content="Completed coding deliverable.",
                summary="Subagent completed work",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Coding",
                source={"sessionKey": child_session, "channel": "direct", "requestId": request_id},
            ),
            idem="orch-003-subagent-assistant",
        )

        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(run.status, "running")
            self.assertIsNone(run.completedAt)
            self.assertEqual(statuses.get("main.response"), "running")
            self.assertEqual(statuses.get(f"subagent:{child_session}"), "done")

        self._append_log(
            LogAppend(
                type="conversation",
                content="Here is the final integrated result.",
                summary="Main final response",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003-main-final",
        )

        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "done")
            self.assertTrue(bool(run.completedAt))
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(statuses.get("main.response"), "done")
            self.assertEqual(statuses.get(f"subagent:{child_session}"), "done")

        context_response = main_module.context(
            q="what finished?",
            sessionKey=session_key,
            spaceId=None,
            allowedSpaceIds=None,
            mode="cheap",
            includePending=True,
            maxChars=2200,
            workingSetLimit=6,
            timelineLimit=6,
        )
        runs = list((((context_response.get("data") or {}).get("orchestration") or {}).get("runs") or []))
        self.assertTrue(runs)
        convergence = runs[0].get("convergence") or {}
        self.assertTrue(bool(convergence.get("ready")))
        self.assertEqual(str(convergence.get("reason") or ""), "converged")

    def test_orch_004_cancel_marks_run_and_items_cancelled(self):
        session_key = "clawboard:task:topic-orch-004:task-orch-004"
        request_id = self._openclaw_chat(session_key=session_key, message="Will cancel this run.")
        child_session = "agent:coding:subagent:orch-004-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-004-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={
                    "sessionKey": session_key,
                    "channel": "openclaw",
                    "requestId": request_id,
                    "boardScopeTopicId": "topic-orch-004",
                    "boardScopeTaskId": "task-orch-004",
                },
            ),
            idem="orch-004-spawn",
        )

        with patch.object(main_module, "gateway_rpc", new=AsyncMock(return_value={"ok": True})):
            result = main_module.openclaw_chat_cancel(
                OpenClawChatCancelRequest(sessionKey=session_key, requestId=request_id)
            )
        self.assertIn("queueCancelled", result)

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "cancelled")
            items = session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            self.assertTrue(items)
            self.assertTrue(all(str(item.status or "") in {"cancelled", "done"} for item in items))

    def test_orch_005_context_includes_orchestration_snapshot(self):
        session_key = "clawboard:topic:topic-orch-005"
        request_id = self._openclaw_chat(session_key=session_key, message="Track this with orchestration.")
        response = main_module.context(
            q="what is running?",
            sessionKey=session_key,
            spaceId=None,
            allowedSpaceIds=None,
            mode="cheap",
            includePending=True,
            maxChars=2200,
            workingSetLimit=6,
            timelineLimit=6,
        )
        self.assertTrue(response.get("ok"))
        orchestration = ((response.get("data") or {}).get("orchestration") or {})
        runs = list(orchestration.get("runs") or [])
        self.assertTrue(runs)
        self.assertEqual(str(runs[0].get("requestId") or ""), request_id)
        convergence = runs[0].get("convergence") or {}
        self.assertFalse(bool(convergence.get("ready")))
        self.assertIn(str(convergence.get("reason") or ""), {"awaiting_run", "awaiting_items"})

    def test_orch_006_tick_marks_idle_items_stalled(self):
        session_key = "clawboard:topic:topic-orch-006"
        request_id = self._openclaw_chat(session_key=session_key, message="This will idle.")
        old_dt = datetime.now(timezone.utc) - timedelta(hours=2)
        old_iso = old_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(item)
            item.status = "running"
            item.startedAt = old_iso
            item.updatedAt = old_iso
            item.nextCheckAt = old_iso
            meta = dict(item.meta or {})
            meta["lastActivityAt"] = old_iso
            item.meta = meta
            session.add(item)
            run.updatedAt = old_iso
            session.add(run)
            session.commit()

        stats = main_module._orchestration_tick_once(now_dt=datetime.now(timezone.utc))
        self.assertGreaterEqual(int(stats.get("stalledItems") or 0), 1)

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertEqual(item.status, "stalled")
            self.assertEqual(run.status, "stalled")

    def test_orch_006b_tick_stalls_items_when_last_activity_metadata_is_missing(self):
        session_key = "clawboard:topic:topic-orch-006b"
        request_id = self._openclaw_chat(session_key=session_key, message="Idle without explicit lastActivity metadata.")
        old_dt = datetime.now(timezone.utc) - timedelta(hours=2)
        old_iso = old_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(item)
            item.status = "running"
            item.startedAt = None
            item.createdAt = old_iso
            # Keep updatedAt fresh to simulate prior bookkeeping churn.
            item.updatedAt = now_iso()
            item.nextCheckAt = old_iso
            item.meta = {"role": "primary_response"}
            session.add(item)
            run.updatedAt = old_iso
            session.add(run)
            session.commit()

        stats = main_module._orchestration_tick_once(now_dt=datetime.now(timezone.utc))
        self.assertGreaterEqual(int(stats.get("stalledItems") or 0), 1)

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertEqual(item.status, "stalled")
            self.assertEqual(run.status, "stalled")
            last_activity = main_module._iso_to_timestamp(str((item.meta or {}).get("lastActivityAt") or ""))
            self.assertIsNotNone(last_activity)
            self.assertLess(abs(float(last_activity or 0.0) - old_dt.timestamp()), 2.0)

    def test_orch_006c_tick_emits_periodic_main_check_in_events(self):
        session_key = "clawboard:topic:topic-orch-006c"
        request_id = self._openclaw_chat(session_key=session_key, message="Keep me posted while this runs.")
        due_dt = datetime.now(timezone.utc) - timedelta(minutes=2)
        due_iso = due_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        fresh_iso = now_iso()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(item)
            item.status = "running"
            item.attempts = 0
            item.nextCheckAt = due_iso
            meta = dict(item.meta or {})
            meta["lastActivityAt"] = fresh_iso
            item.meta = meta
            session.add(item)
            session.commit()

        main_module._orchestration_tick_once(now_dt=datetime.now(timezone.utc))

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(item)
            self.assertGreaterEqual(int(item.attempts or 0), 1)

            logs = session.exec(
                select(LogEntry)
                .where(LogEntry.topicId == "topic-orch-006c")
                .where(LogEntry.type == "system")
                .order_by(LogEntry.createdAt.asc(), LogEntry.id.asc())
            ).all()
            checkins = [
                row
                for row in logs
                if isinstance(getattr(row, "source", None), dict)
                and bool((row.source or {}).get("orchestration"))
                and str((row.source or {}).get("eventType") or "") == "item_check_in"
            ]
            self.assertTrue(checkins, "Expected in-band orchestration check-in events from main.response.")
            latest = checkins[-1]
            self.assertIn("check-in", str(latest.summary or "").lower())
            payload = (latest.source or {}).get("eventPayload") if isinstance(latest.source, dict) else {}
            payload = payload if isinstance(payload, dict) else {}
            self.assertGreaterEqual(int(payload.get("attempt") or 0), 1)
            self.assertGreaterEqual(int(payload.get("nextCheckInSeconds") or 0), 60)

    def test_orch_007_main_only_assistant_reply_closes_run_without_subagents(self):
        session_key = "clawboard:topic:topic-orch-007"
        request_id = self._openclaw_chat(session_key=session_key, message="Simple question: what is 2 + 2?")

        self._append_log(
            LogAppend(
                type="conversation",
                content="2 + 2 is 4.",
                summary="Main direct answer",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-007-main-direct",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "done")
            items = session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            self.assertEqual(len(items), 1)
            self.assertEqual(str(items[0].itemKey or ""), "main.response")
            self.assertEqual(str(items[0].status or ""), "done")

    def test_orch_008_multi_subagent_run_requires_all_children_and_main_final(self):
        session_key = "clawboard:topic:topic-orch-008"
        request_id = self._openclaw_chat(session_key=session_key, message="Coordinate coding + web research.")
        child_a = "agent:coding:subagent:orch-008-a"
        child_b = "agent:web:subagent:orch-008-b"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-008-a","linked":"agent:web:subagent:orch-008-b"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-008-spawn",
        )

        self._append_log(
            LogAppend(
                type="conversation",
                content="Delegated to coding and web.",
                summary="Main status update",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-008-main-status",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(statuses.get("main.response"), "running")
            self.assertEqual(statuses.get(f"subagent:{child_a}"), "running")
            self.assertEqual(statuses.get(f"subagent:{child_b}"), "running")

        self._append_log(
            LogAppend(
                type="conversation",
                content="Coding side complete.",
                summary="Coding complete",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Coding",
                source={"sessionKey": child_a, "channel": "direct", "requestId": request_id},
            ),
            idem="orch-008-child-a",
        )
        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(run.status, "running")
            self.assertEqual(statuses.get("main.response"), "running")
            self.assertEqual(statuses.get(f"subagent:{child_a}"), "done")
            self.assertEqual(statuses.get(f"subagent:{child_b}"), "running")

        self._append_log(
            LogAppend(
                type="conversation",
                content="Web side complete.",
                summary="Web complete",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Web",
                source={"sessionKey": child_b, "channel": "direct", "requestId": request_id},
            ),
            idem="orch-008-child-b",
        )
        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(run.status, "running")
            self.assertEqual(statuses.get("main.response"), "running")
            self.assertEqual(statuses.get(f"subagent:{child_a}"), "done")
            self.assertEqual(statuses.get(f"subagent:{child_b}"), "done")

        self._append_log(
            LogAppend(
                type="conversation",
                content="Integrated result from coding + web complete.",
                summary="Main final integrated response",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-008-main-final",
        )
        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(run.status, "done")
            self.assertEqual(statuses.get("main.response"), "done")
            self.assertEqual(statuses.get(f"subagent:{child_a}"), "done")
            self.assertEqual(statuses.get(f"subagent:{child_b}"), "done")

    def test_orch_009_duplicate_spawn_actions_do_not_duplicate_subagent_items(self):
        session_key = "clawboard:task:topic-orch-009:task-orch-009"
        request_id = self._openclaw_chat(session_key=session_key, message="Delegate once despite duplicate spawn logs.")
        child_session = "agent:coding:subagent:orch-009-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-009-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-009-spawn-a",
        )
        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn (duplicate replay)",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-009-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-009-spawn-b",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            subagent_items = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == f"subagent:{child_session}")
            ).all()
            self.assertEqual(len(subagent_items), 1)


if __name__ == "__main__":
    unittest.main()
