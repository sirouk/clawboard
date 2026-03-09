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
os.environ["OPENCLAW_BASE_URL"] = "http://localhost:18789"
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
        session_key = "clawboard:task:topic-orch-001:task-orch-001"
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

    def test_orch_002d_waiting_status_detector_catches_relay_promises(self):
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Dispatched to **coding** specialist (session `abcd1234`) - waiting for the result. "
                "I'll relay it back the moment the specialist completes.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Task tagged in Clawboard. The coding specialist will auto-announce when complete - "
                "I'll relay the `LATENCY_TEST_ALPHA` response back here immediately.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Docs result is visible in the thread above — still waiting on the coding specialist "
                "to report on the actual script behavior. I'll deliver the 5-bullet comparison once both are in.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Sent to coding agent — running `openclaw cron list --json` now. "
                "I'll report back with whether any jobs are active once the result comes in.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Task state updated — coding specialist is checking for active cron jobs now. "
                "I'll let you know as soon as the result comes back.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Let me check if the coding specialist has completed the cron list check.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "No additional action needed — the coding specialist has accepted the task and will return results automatically.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Dispatched two specialists in parallel. Both results will be announced back here when complete. I'll synthesize them into one combined answer.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Dispatching two coding specialists in parallel now.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "This is the same request — I already dispatched both coding specialists. Let me check their status and synthesize the combined answer.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Both specialists are still running. Let me query them directly for their results.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Visibility restrictions prevent cross-agent messaging. Re-spawning fresh specialists now.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Re-dispatched two fresh coding specialists. Both will auto-report back. I'll deliver the combined answer once results arrive.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Same request — checking if the two specialists I just spawned have completed.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_waiting_status_text(
                "Let me spawn fresh specialists with clear instructions.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_non_delivery_status_text(
                "HEARTBEAT_OK",
                "HEARTBEAT_OK",
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_non_delivery_status_text(
                "No active delegations. Only main session running. All clear.",
                "Only main session running",
                None,
            )
        )
        self.assertFalse(
            main_module._orchestration_is_non_delivery_status_text(
                "Task complete. Weather monitoring is live. Waiting on your Discord webhook.",
                "Task complete",
                None,
            )
        )
        self.assertFalse(
            main_module._orchestration_is_waiting_status_text(
                "**LATENCY_TEST_ALPHA** The coding specialist responded as requested. Task complete.",
                None,
                None,
            )
        )

    def test_orch_002da_duplicate_waiting_status_updates_are_demoted_to_system_logs(self):
        session_key = "clawboard:task:topic-orch-002da:task-orch-002da"
        request_id = self._openclaw_chat(session_key=session_key, message="Kick off delegated work and keep the chatter minimal.")

        first_iso = now_iso()
        second_iso = (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        first = self._append_log(
            LogAppend(
                type="conversation",
                content="Dispatching to both `coding` and `docs` specialists in parallel to inspect the script and README. I'll synthesize the comparison once both report back.",
                summary="Initial dispatch",
                createdAt=first_iso,
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002da-first",
        )
        second = self._append_log(
            LogAppend(
                type="conversation",
                content="Awaiting results from both specialists. Next checkpoint in ~1 minute.",
                summary="Follow-up status",
                createdAt=second_iso,
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002da-second",
        )

        self.assertEqual(first.type, "conversation")
        self.assertEqual(first.agentId, "assistant")
        self.assertEqual(second.type, "system")
        self.assertEqual(second.agentId, "system")
        self.assertTrue(bool((second.source or {}).get("suppressedWaitingStatus")))

    def test_orch_002dc_live_style_follow_up_statuses_are_demoted_to_system_logs(self):
        session_key = "clawboard:task:topic-orch-002dc:task-orch-002dc"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Use coding to inspect the cron jobs and keep status noise out of the user thread.",
        )

        first_iso = now_iso()
        second_iso = (datetime.now(timezone.utc) + timedelta(seconds=6)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        third_iso = (datetime.now(timezone.utc) + timedelta(seconds=12)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        first = self._append_log(
            LogAppend(
                type="conversation",
                content="Dispatching to the coding specialist to run `openclaw cron list --json` and check for active jobs.",
                summary="Initial dispatch",
                createdAt=first_iso,
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002dc-first",
        )
        second = self._append_log(
            LogAppend(
                type="conversation",
                content="Task state updated — coding specialist is checking for active cron jobs now. I'll let you know as soon as the result comes back.",
                summary="Task state updated",
                createdAt=second_iso,
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002dc-second",
        )
        third = self._append_log(
            LogAppend(
                type="conversation",
                content="Let me check if the coding specialist has completed the cron list check.",
                summary="Follow-up check",
                createdAt=third_iso,
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002dc-third",
        )
        fourth = self._append_log(
            LogAppend(
                type="conversation",
                content="No additional action needed — the coding specialist has accepted the task and will return results automatically.",
                summary="Specialist accepted task",
                createdAt=(datetime.now(timezone.utc) + timedelta(seconds=18)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002dc-fourth",
        )
        fifth = self._append_log(
            LogAppend(
                type="conversation",
                content="Dispatched two specialists in parallel. Both results will be announced back here when complete. I'll synthesize them into one combined answer.",
                summary="Parallel specialist dispatch",
                createdAt=(datetime.now(timezone.utc) + timedelta(seconds=24)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002dc-fifth",
        )
        sixth = self._append_log(
            LogAppend(
                type="conversation",
                content="This is the same request — I already dispatched both coding specialists. Let me check their status and synthesize the combined answer.",
                summary="Repeat dispatch status",
                createdAt=(datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002dc-sixth",
        )
        seventh = self._append_log(
            LogAppend(
                type="conversation",
                content="Visibility restrictions prevent cross-agent messaging. Re-spawning fresh specialists now.",
                summary="Respawn status",
                createdAt=(datetime.now(timezone.utc) + timedelta(seconds=36)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002dc-seventh",
        )
        eighth = self._append_log(
            LogAppend(
                type="conversation",
                content="Let me spawn fresh specialists with clear instructions.",
                summary="Fresh specialist respawn",
                createdAt=(datetime.now(timezone.utc) + timedelta(seconds=42)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002dc-eighth",
        )

        self.assertEqual(first.type, "conversation")
        self.assertEqual(second.type, "system")
        self.assertEqual(second.agentId, "system")
        self.assertTrue(bool((second.source or {}).get("suppressedWaitingStatus")))
        self.assertEqual(third.type, "system")
        self.assertEqual(third.agentId, "system")
        self.assertTrue(bool((third.source or {}).get("suppressedWaitingStatus")))
        self.assertEqual(fourth.type, "system")
        self.assertEqual(fourth.agentId, "system")
        self.assertTrue(bool((fourth.source or {}).get("suppressedWaitingStatus")))
        self.assertEqual(fifth.type, "system")
        self.assertEqual(fifth.agentId, "system")
        self.assertTrue(bool((fifth.source or {}).get("suppressedWaitingStatus")))
        self.assertEqual(sixth.type, "system")
        self.assertEqual(sixth.agentId, "system")
        self.assertTrue(bool((sixth.source or {}).get("suppressedWaitingStatus")))
        self.assertEqual(seventh.type, "system")
        self.assertEqual(seventh.agentId, "system")
        self.assertTrue(bool((seventh.source or {}).get("suppressedWaitingStatus")))
        self.assertEqual(eighth.type, "system")
        self.assertEqual(eighth.agentId, "system")
        self.assertTrue(bool((eighth.source or {}).get("suppressedWaitingStatus")))

    def test_orch_002db_duplicate_waiting_status_updates_are_demoted_without_request_id(self):
        session_key = "clawboard:task:topic-orch-002db:task-orch-002db"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Delegate, but keep duplicate status chatter out of the thread.",
        )

        first_iso = now_iso()
        second_iso = (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        first = self._append_log(
            LogAppend(
                type="conversation",
                content="Dispatched to `coding` and `docs`. I'll synthesize once both report back.",
                summary="Initial dispatch",
                createdAt=first_iso,
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
            ),
            idem="orch-002db-first",
        )
        second = self._append_log(
            LogAppend(
                type="conversation",
                content="Awaiting results from both specialists. Next checkpoint in ~1 minute.",
                summary="Follow-up status",
                createdAt=second_iso,
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "webchat"},
            ),
            idem="orch-002db-second",
        )

        self.assertEqual(first.type, "conversation")
        self.assertEqual(second.type, "system")
        self.assertEqual(second.agentId, "system")
        self.assertTrue(bool((second.source or {}).get("suppressedWaitingStatus")))

    def test_orch_003_main_response_does_not_close_while_subagent_still_active(self):
        session_key = "clawboard:task:topic-orch-003:task-orch-003"
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

    def test_orch_003aa_heartbeat_only_status_does_not_count_as_delivery(self):
        session_key = "clawboard:task:topic-orch-003aa:task-orch-003aa"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Do not close the run on heartbeat chatter alone.",
        )
        child_session = "agent:coding:subagent:orch-003aa-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003aa-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003aa-spawn",
        )
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
            idem="orch-003aa-subagent-done",
        )
        self._append_log(
            LogAppend(
                type="conversation",
                content="HEARTBEAT_OK",
                summary="HEARTBEAT_OK",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003aa-heartbeat",
        )

        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "running")
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(statuses.get(f"subagent:{child_session}"), "done")
            self.assertEqual(statuses.get("main.response"), "running")

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
            idem="orch-003aa-main-final",
        )

        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "done")
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(statuses.get("main.response"), "done")
            self.assertEqual(statuses.get(f"subagent:{child_session}"), "done")

    def test_orch_003a_waiting_status_after_child_done_keeps_main_open_without_duplicate_follow_up(self):
        session_key = "clawboard:task:topic-orch-003a:task-orch-003a"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Delegate to coding, then relay the completed result without stalling on status promises.",
        )
        child_session = "agent:coding:subagent:orch-003a-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003a-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003a-spawn",
        )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=True):
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="LATENCY_TEST_ALPHA",
                    summary="Child completion",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Coding",
                    source={"sessionKey": child_session, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003a-child-done",
            )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False), patch.object(
            main_module,
            "_orchestration_completed_subagent_follow_up_grace_seconds",
            return_value=0.0,
        ), patch.object(
            main_module,
            "_orchestration_enqueue_follow_up_dispatch",
            return_value=True,
        ) as follow_up_mock:
            self._append_log(
                LogAppend(
                    type="conversation",
                    content=(
                        "Task tagged in Clawboard. The coding specialist will auto-announce when complete - "
                        "I'll relay the `LATENCY_TEST_ALPHA` response back here immediately."
                    ),
                    summary="Main waiting status",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="OpenClaw",
                    source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
                ),
                idem="orch-003a-main-waiting",
            )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "running")
            self.assertIsNone(run.completedAt)
            items = {
                row.itemKey: row
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(items["main.response"].status, "running")
            self.assertEqual(items[f"subagent:{child_session}"].status, "done")

        follow_up_mock.assert_not_called()

    def test_orch_003aa_tick_enqueues_follow_up_after_child_done_and_main_silence(self):
        session_key = "clawboard:task:topic-orch-003aa:task-orch-003aa"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Delegate to coding, then recover if the main agent goes silent after the child finishes.",
        )
        child_session = "agent:coding:subagent:orch-003aa-child"
        base_dt = datetime.now(timezone.utc)
        child_done_iso = (base_dt - timedelta(seconds=30)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003aa-child"}}',
                createdAt=(base_dt - timedelta(seconds=40)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003aa-spawn",
        )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=True):
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="LATENCY_TEST_ALPHA",
                    summary="Child completion",
                    createdAt=child_done_iso,
                    agentId="assistant",
                    agentLabel="Coding",
                    source={"sessionKey": child_session, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003aa-child-done",
            )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False), patch.object(
            main_module,
            "_orchestration_completed_subagent_follow_up_grace_seconds",
            return_value=0.0,
        ), patch.object(
            main_module,
            "_orchestration_enqueue_follow_up_dispatch",
            return_value=True,
        ) as follow_up_mock:
            main_module._orchestration_tick_once(now_dt=datetime.now(timezone.utc))

        follow_up_mock.assert_called_once()
        follow_up_message = str(follow_up_mock.call_args.kwargs.get("message") or "")
        self.assertIn("[ORCHESTRATION_FOLLOW_UP]", follow_up_message)
        self.assertIn("Do not send another status-only promise", follow_up_message)
        self.assertIn("LATENCY_TEST_ALPHA", follow_up_message)
        self.assertNotIn("sessions_history", follow_up_message)

    def test_orch_003ab_subagent_completion_does_not_follow_up_while_other_subagent_still_running(self):
        session_key = "clawboard:task:topic-orch-003ab:task-orch-003ab"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Delegate to coding and docs, but stay quiet until both are done.",
        )
        coding_child = "agent:coding:subagent:orch-003ab-coding"
        docs_child = "agent:docs:subagent:orch-003ab-docs"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003ab-coding"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003ab-spawn-coding",
        )
        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:docs:subagent:orch-003ab-docs"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003ab-spawn-docs",
        )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False), patch.object(
            main_module,
            "_orchestration_completed_subagent_follow_up_grace_seconds",
            return_value=0.0,
        ), patch.object(
            main_module,
            "_orchestration_enqueue_follow_up_dispatch",
            return_value=True,
        ) as follow_up_mock:
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="README inspection complete.",
                    summary="Docs completion",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Docs",
                    source={"sessionKey": docs_child, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003ab-docs-done",
            )

        follow_up_mock.assert_not_called()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            items = {
                row.itemKey: row
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(items[f"subagent:{docs_child}"].status, "done")
            self.assertEqual(items[f"subagent:{coding_child}"].status, "running")
            self.assertEqual(items["main.response"].status, "running")

    def test_orch_003ac_waiting_status_after_last_child_done_does_not_mark_main_delivered(self):
        session_key = "clawboard:task:topic-orch-003ac:task-orch-003ac"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Delegate to coding and docs, then wait for a real final answer.",
        )
        coding_child = "agent:coding:subagent:orch-003ac-coding"
        docs_child = "agent:docs:subagent:orch-003ac-docs"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003ac-coding"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003ac-spawn-coding",
        )
        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:docs:subagent:orch-003ac-docs"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003ac-spawn-docs",
        )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False):
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="README inspection complete.",
                    summary="Docs completion",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Docs",
                    source={"sessionKey": docs_child, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003ac-docs-done",
            )
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="Bootstrap prompt analysis complete.",
                    summary="Coding completion",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Coding",
                    source={"sessionKey": coding_child, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003ac-coding-done",
            )
            self._append_log(
                LogAppend(
                    type="conversation",
                    content=(
                        "Docs result is visible in the thread above — still waiting on the coding specialist "
                        "to report on the actual script behavior. I'll deliver the 5-bullet comparison once both are in."
                    ),
                    summary="Main waiting status",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="OpenClaw",
                    source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
                ),
                idem="orch-003ac-main-waiting",
            )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "running")
            self.assertIsNone(run.completedAt)
            items = {
                row.itemKey: row
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(items[f"subagent:{docs_child}"].status, "done")
            self.assertEqual(items[f"subagent:{coding_child}"].status, "done")
            self.assertEqual(items["main.response"].status, "running")

    def test_orch_003aca_waiting_status_after_child_done_does_not_block_recovery_follow_up(self):
        session_key = "clawboard:task:topic-orch-003aca:task-orch-003aca"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Delegate to coding, but recover with a curated follow-up if main only posts status chatter.",
        )
        child_session = "agent:coding:subagent:orch-003aca-child"
        base_dt = datetime.now(timezone.utc)

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003aca-child"}}',
                createdAt=(base_dt - timedelta(seconds=40)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003aca-spawn",
        )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False):
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="Cron inspection finished: there are 2 active jobs.",
                    summary="Coding completion",
                    createdAt=(base_dt - timedelta(seconds=30)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    agentId="assistant",
                    agentLabel="Coding",
                    source={"sessionKey": child_session, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003aca-child-done",
            )
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="Task state updated — coding specialist is checking for active cron jobs now. I'll let you know as soon as the result comes back.",
                    summary="Task state updated",
                    createdAt=(base_dt - timedelta(seconds=20)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    agentId="assistant",
                    agentLabel="OpenClaw",
                    source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
                ),
                idem="orch-003aca-main-waiting",
            )

        with patch.object(
            main_module,
            "_orchestration_completed_subagent_follow_up_grace_seconds",
            return_value=0.0,
        ), patch.object(
            main_module,
            "_orchestration_original_request_still_dispatching",
            return_value=False,
        ), patch.object(
            main_module,
            "_orchestration_enqueue_follow_up_dispatch",
            return_value=True,
        ) as follow_up_mock:
            main_module._orchestration_tick_once(now_dt=datetime.now(timezone.utc))

        follow_up_mock.assert_called_once()
        follow_up_message = str(follow_up_mock.call_args.kwargs.get("message") or "")
        self.assertIn("[ORCHESTRATION_FOLLOW_UP]", follow_up_message)
        self.assertIn("Do not send another status-only promise", follow_up_message)

    def test_orch_003ad_low_signal_main_ack_after_child_done_does_not_count_as_delivery(self):
        session_key = "clawboard:task:topic-orch-003ad:task-orch-003ad"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Delegate to coding, but only close after a real curated answer.",
        )
        child_session = "agent:coding:subagent:orch-003ad-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003ad-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003ad-spawn",
        )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False):
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="Bootstrap prompt analysis complete.",
                    summary="Coding completion",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Coding",
                    source={"sessionKey": child_session, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003ad-child-done",
            )
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="Done.",
                    summary="Done.",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="OpenClaw",
                    source={"sessionKey": session_key, "channel": "webchat", "requestId": request_id},
                ),
                idem="orch-003ad-main-ack",
            )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "running")
            self.assertIsNone(run.completedAt)
            items = {
                row.itemKey: row
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(items[f"subagent:{child_session}"].status, "done")
            self.assertEqual(items["main.response"].status, "running")

        with patch.object(
            main_module,
            "_orchestration_completed_subagent_follow_up_grace_seconds",
            return_value=0.0,
        ), patch.object(
            main_module,
            "_orchestration_original_request_still_dispatching",
            return_value=False,
        ), patch.object(
            main_module,
            "_orchestration_enqueue_follow_up_dispatch",
            return_value=True,
        ) as follow_up_mock:
            main_module._orchestration_tick_once(now_dt=datetime.now(timezone.utc))

        follow_up_mock.assert_called_once()
        follow_up_message = str(follow_up_mock.call_args.kwargs.get("message") or "")
        self.assertIn("[ORCHESTRATION_FOLLOW_UP]", follow_up_message)
        self.assertIn("Do not send another status-only promise", follow_up_message)

    def test_orch_003ae_task_admin_messages_are_low_signal_delivery_text(self):
        self.assertTrue(
            main_module._orchestration_is_low_signal_delivery_text(
                "Task tracking updated. The coding specialist will auto-report when the cron check completes.",
                None,
                None,
            )
        )
        self.assertTrue(
            main_module._orchestration_is_low_signal_delivery_text(
                "Task updated with delegation state. The coding specialist will report the cron list results when complete.",
                None,
                None,
            )
        )
        self.assertTrue(main_module._orchestration_is_low_signal_delivery_text("Task closed.", None, None))
        self.assertTrue(
            main_module._orchestration_is_low_signal_delivery_text(
                "Task closed. Let me know if you want to troubleshoot those failing weather checks.",
                None,
                None,
            )
        )
        self.assertTrue(main_module._orchestration_is_low_signal_delivery_text("Done. Task closed.", None, None))
        self.assertTrue(main_module._orchestration_is_low_signal_delivery_text("Request complete.", None, None))
        self.assertTrue(
            main_module._orchestration_is_low_signal_delivery_text(
                "Request complete. Let me know if you want me to dig deeper.",
                None,
                None,
            )
        )
        self.assertTrue(main_module._orchestration_is_low_signal_delivery_text("Done. Request complete.", None, None))

    def test_orch_003b_late_subagent_spawn_reopens_main_supervision(self):
        session_key = "clawboard:task:topic-orch-003b:task-orch-003b"
        request_id = self._openclaw_chat(session_key=session_key, message="Reply first, then delegate late.")
        child_session = "agent:coding:subagent:orch-003b-child"

        self._append_log(
            LogAppend(
                type="conversation",
                content="I have the initial answer and will circle back if I need to delegate.",
                summary="Main initial reply",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003b-main-initial",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "done")
            main_item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(main_item)
            self.assertEqual(main_item.status, "done")
            self.assertTrue(bool(main_item.completedAt))

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003b-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003b-spawn-late",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "running")
            self.assertIsNone(run.completedAt)
            items = {
                row.itemKey: row
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertIn("main.response", items)
            self.assertIn(f"subagent:{child_session}", items)
            self.assertEqual(items["main.response"].status, "running")
            self.assertEqual(int(items["main.response"].attempts or 0), 0)
            self.assertIsNone(items["main.response"].completedAt)
            self.assertTrue(bool(items["main.response"].nextCheckAt))
            self.assertEqual(items[f"subagent:{child_session}"].status, "running")

    def test_orch_003c_failed_subagent_stays_failed_and_requeues_main_recovery(self):
        session_key = "clawboard:task:topic-orch-003c:task-orch-003c"
        request_id = self._openclaw_chat(session_key=session_key, message="Delegate, then recover if the child fails.")
        child_session = "agent:coding:subagent:orch-003c-child"

        self._append_log(
            LogAppend(
                type="conversation",
                content="I have the initial answer and may delegate a follow-up.",
                summary="Main initial reply",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003c-main-initial",
        )

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003c-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003c-spawn-late",
        )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False), patch.object(
            main_module,
            "_orchestration_completed_subagent_follow_up_grace_seconds",
            return_value=0.0,
        ), patch.object(
            main_module,
            "_orchestration_enqueue_follow_up_dispatch",
            return_value=True,
        ) as follow_up_mock:
            self._append_log(
                LogAppend(
                    type="system",
                    content="OpenClaw chat failed: Request was aborted",
                    summary="OpenClaw chat failed: Request was aborted",
                    createdAt=now_iso(),
                    agentId="system",
                    agentLabel="System",
                    source={
                        "sessionKey": child_session,
                        "channel": "direct",
                        "requestId": request_id,
                        "requestTerminal": True,
                    },
                ),
                idem="orch-003c-subagent-failed",
            )

        self._append_log(
            LogAppend(
                type="conversation",
                content="Buffered assistant output arrived after the failure log.",
                summary="Late child assistant backfill",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Coding",
                source={"sessionKey": child_session, "channel": "direct", "requestId": request_id},
            ),
            idem="orch-003c-subagent-late-assistant",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "running")
            self.assertIsNone(run.completedAt)
            items = {
                row.itemKey: row
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(items["main.response"].status, "running")
            self.assertEqual(items[f"subagent:{child_session}"].status, "failed")
            self.assertEqual(
                str(items[f"subagent:{child_session}"].lastError or ""),
                "OpenClaw chat failed: Request was aborted",
            )

        follow_up_mock.assert_called_once()
        recovery_follow_up = str(follow_up_mock.call_args.kwargs.get("message") or "")
        self.assertIn("session_status", recovery_follow_up)
        self.assertNotIn("sessions_history", recovery_follow_up)

    def test_orch_003cc_completed_subagent_follow_up_embeds_result_without_sessions_history(self):
        session_key = "clawboard:task:topic-orch-003cc:task-orch-003cc"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Delegate to a child and relay the result without cross-agent history reads.",
        )
        child_session = "agent:coding:subagent:orch-003cc-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003cc-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003cc-spawn",
        )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False), patch.object(
            main_module,
            "_orchestration_completed_subagent_follow_up_grace_seconds",
            return_value=0.0,
        ), patch.object(
            main_module,
            "_orchestration_enqueue_follow_up_dispatch",
            return_value=True,
        ) as follow_up_mock:
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="Child completed with the cron inventory already summarized.",
                    summary="Child completion",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Coding",
                    source={"sessionKey": child_session, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003cc-child-done",
            )

        follow_up_mock.assert_called_once()
        follow_up_message = str(follow_up_mock.call_args.kwargs.get("message") or "")
        self.assertIn("[ORCHESTRATION_FOLLOW_UP]", follow_up_message)
        self.assertIn("result is already visible in the current task thread", follow_up_message)
        self.assertIn("do not restate or paraphrase the full body", follow_up_message.lower())
        self.assertIn("validating the work", follow_up_message)
        self.assertIn("Child completed with the cron inventory already summarized.", follow_up_message)
        self.assertNotIn("sessions_history", follow_up_message)

    def test_orch_003cd_completed_subagent_follow_up_batches_multiple_children_once(self):
        session_key = "clawboard:task:topic-orch-003cd:task-orch-003cd"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Delegate to coding and docs, then deliver one curated close-out.",
        )
        coding_child = "agent:coding:subagent:orch-003cd-coding"
        docs_child = "agent:docs:subagent:orch-003cd-docs"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003cd-coding"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003cd-spawn-coding",
        )
        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:docs:subagent:orch-003cd-docs"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003cd-spawn-docs",
        )

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False), patch.object(
            main_module,
            "_orchestration_completed_subagent_follow_up_grace_seconds",
            return_value=0.0,
        ), patch.object(
            main_module,
            "_orchestration_enqueue_follow_up_dispatch",
            return_value=True,
        ) as follow_up_mock:
            self._append_log(
                LogAppend(
                    type="conversation",
                    content="README inspection complete.",
                    summary="Docs completion",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Docs",
                    source={"sessionKey": docs_child, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003cd-docs-done",
            )
            follow_up_mock.assert_not_called()

            self._append_log(
                LogAppend(
                    type="conversation",
                    content="Bootstrap prompt analysis complete.",
                    summary="Coding completion",
                    createdAt=now_iso(),
                    agentId="assistant",
                    agentLabel="Coding",
                    source={"sessionKey": coding_child, "channel": "direct", "requestId": request_id},
                ),
                idem="orch-003cd-coding-done",
            )

        follow_up_mock.assert_called_once()
        follow_up_message = str(follow_up_mock.call_args.kwargs.get("message") or "")
        idempotency_suffix = str(follow_up_mock.call_args.kwargs.get("idempotency_suffix") or "")
        self.assertIn("not a new user request", follow_up_message.lower())
        self.assertIn("do not re-dispatch specialists", follow_up_message.lower())
        self.assertIn("README inspection complete.", follow_up_message)
        self.assertIn("Bootstrap prompt analysis complete.", follow_up_message)
        self.assertTrue(idempotency_suffix.startswith("subagent-done-batch:"))

    def test_orch_003d_failed_subagent_attempt_does_not_poison_run_after_retry_and_main_final(self):
        session_key = "clawboard:task:topic-orch-003d:task-orch-003d"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Retry delegated work if the first child fails, then finish cleanly.",
        )
        first_child = "agent:coding:subagent:orch-003d-a"
        second_child = "agent:coding:subagent:orch-003d-b"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003d-a"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003d-spawn-a",
        )
        self._append_log(
            LogAppend(
                type="system",
                content="OpenClaw chat failed: upstream inference outage",
                summary="OpenClaw chat failed: upstream inference outage",
                createdAt=now_iso(),
                agentId="system",
                agentLabel="System",
                source={
                    "sessionKey": first_child,
                    "channel": "direct",
                    "requestId": request_id,
                    "requestTerminal": True,
                },
            ),
            idem="orch-003d-failed-a",
        )
        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003d-b"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003d-spawn-b",
        )
        self._append_log(
            LogAppend(
                type="conversation",
                content="Recovered coding output from the retry attempt.",
                summary="Retry child finished",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Coding",
                source={"sessionKey": second_child, "channel": "direct", "requestId": request_id},
            ),
            idem="orch-003d-child-b-done",
        )
        self._append_log(
            LogAppend(
                type="conversation",
                content="Here is the final integrated answer after retrying the failed specialist.",
                summary="Main final answer",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003d-main-final",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "done")
            self.assertTrue(bool(run.completedAt))
            items = {
                row.itemKey: row
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(items["main.response"].status, "done")
            self.assertEqual(items[f"subagent:{first_child}"].status, "failed")
            self.assertEqual(items[f"subagent:{second_child}"].status, "done")

    def test_orch_003da_tick_does_not_revive_resolved_failed_attempt_after_main_delivery(self):
        session_key = "clawboard:task:topic-orch-003da:task-orch-003da"
        request_id = self._openclaw_chat(
            session_key=session_key,
            message="Do not keep yelling about a failed retry after the user already got the answer.",
        )
        failed_child = "agent:coding:subagent:orch-003da-failed"
        done_child = "agent:coding:subagent:orch-003da-done"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003da-failed"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003da-spawn-failed",
        )
        self._append_log(
            LogAppend(
                type="system",
                content="OpenClaw chat failed: 429 from specialist retry",
                summary="OpenClaw chat failed: 429 from specialist retry",
                createdAt=now_iso(),
                agentId="system",
                agentLabel="System",
                source={
                    "sessionKey": failed_child,
                    "channel": "direct",
                    "requestId": request_id,
                    "requestTerminal": True,
                },
            ),
            idem="orch-003da-failed-child-terminal",
        )
        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003da-done"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003da-spawn-done",
        )
        self._append_log(
            LogAppend(
                type="conversation",
                content="Recovered specialist output from the successful attempt.",
                summary="Retry child finished",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Coding",
                source={"sessionKey": done_child, "channel": "direct", "requestId": request_id},
            ),
            idem="orch-003da-done-child-finished",
        )
        self._append_log(
            LogAppend(
                type="conversation",
                content="Integrated final answer already delivered to the user.",
                summary="Main final answer",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003da-main-final",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            main_item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(main_item)
            # Simulate the stale live state: the final answer exists, but main.response/run were
            # left active and would previously get reopened + re-stalled forever.
            main_item.status = "stalled"
            main_item.completedAt = None
            main_item.nextCheckAt = now_iso()
            main_item.updatedAt = now_iso()
            session.add(main_item)
            run.status = "stalled"
            run.completedAt = None
            session.add(run)
            session.commit()

        main_module._orchestration_tick_once()
        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "done")
            items = {
                row.itemKey: row
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(items["main.response"].status, "done")
            self.assertEqual(items[f"subagent:{failed_child}"].status, "failed")
            self.assertEqual(items[f"subagent:{done_child}"].status, "done")
            run_events = session.exec(
                select(OrchestrationEvent)
                .where(OrchestrationEvent.runId == run.runId)
                .where(OrchestrationEvent.eventType == "run_status_changed")
                .order_by(OrchestrationEvent.id.asc())
            ).all()
            self.assertTrue(run_events)
            self.assertEqual(str((run_events[-1].payload or {}).get("to") or "").strip().lower(), "done")

    def test_orch_003e_tick_revives_terminal_run_with_unresolved_failed_subagent(self):
        session_key = "clawboard:task:topic-orch-003e:task-orch-003e"
        request_id = self._openclaw_chat(session_key=session_key, message="Recover after restart if delegated work failed.")
        child_session = "agent:web:subagent:orch-003e-child"
        legacy_iso = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            main_item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(main_item)
            main_item.status = "done"
            main_item.completedAt = legacy_iso
            main_item.updatedAt = legacy_iso
            main_item.meta = {"role": "primary_response", "lastActivityAt": legacy_iso}
            session.add(main_item)
            session.add(
                OrchestrationItem(
                    runId=run.runId,
                    itemKey=f"subagent:{child_session}",
                    parentItemKey="main.response",
                    requestId=request_id,
                    agentId="web",
                    kind="subagent",
                    goal="research and report back",
                    sessionKey=child_session,
                    status="failed",
                    attempts=0,
                    nextCheckAt=None,
                    startedAt=legacy_iso,
                    completedAt=legacy_iso,
                    lastError="gateway outage",
                    meta={"seededBy": "test_orch_003e"},
                    createdAt=legacy_iso,
                    updatedAt=legacy_iso,
                )
            )
            run.status = "failed"
            run.completedAt = legacy_iso
            run.updatedAt = legacy_iso
            session.add(run)
            session.commit()

        with patch.object(main_module, "_orchestration_original_request_still_dispatching", return_value=False), patch.object(
            main_module,
            "_orchestration_enqueue_follow_up_dispatch",
            return_value=True,
        ) as follow_up_mock:
            stats = main_module._orchestration_tick_once(now_dt=datetime.now(timezone.utc))

        self.assertGreaterEqual(int(stats.get("recoveredRuns") or 0), 1)
        follow_up_mock.assert_called_once()
        recovery_follow_up = str(follow_up_mock.call_args.kwargs.get("message") or "")
        self.assertIn("session_status", recovery_follow_up)
        self.assertNotIn("sessions_history", recovery_follow_up)

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(run.status, "running")
            self.assertIsNone(run.completedAt)
            items = {
                row.itemKey: row
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(items["main.response"].status, "running")
            self.assertEqual(items[f"subagent:{child_session}"].status, "failed")
            recovery = dict((run.meta or {}).get("recovery") or {})
            self.assertEqual(int(recovery.get("attempts") or 0), 1)
            self.assertTrue(str(recovery.get("lastRequestId") or "").startswith("occhat-fup-"))

    def test_orch_003f_recovery_follow_up_respects_pending_row_and_backoff(self):
        session_key = "clawboard:task:topic-orch-003f:task-orch-003f"
        request_id = self._openclaw_chat(session_key=session_key, message="Keep retrying supervision with backoff.")
        child_session = "agent:docs:subagent:orch-003f-child"
        base_dt = datetime.now(timezone.utc) - timedelta(minutes=30)
        base_iso = base_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            main_item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(main_item)
            main_item.status = "running"
            main_item.updatedAt = base_iso
            main_item.nextCheckAt = base_iso
            main_item.meta = {"role": "primary_response", "lastActivityAt": base_iso}
            session.add(main_item)
            session.add(
                OrchestrationItem(
                    runId=run.runId,
                    itemKey=f"subagent:{child_session}",
                    parentItemKey="main.response",
                    requestId=request_id,
                    agentId="docs",
                    kind="subagent",
                    goal="write the docs update",
                    sessionKey=child_session,
                    status="failed",
                    attempts=0,
                    nextCheckAt=None,
                    startedAt=base_iso,
                    completedAt=base_iso,
                    lastError="provider timeout",
                    meta={"seededBy": "test_orch_003f"},
                    createdAt=base_iso,
                    updatedAt=base_iso,
                )
            )
            queue_row = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == request_id).limit(1)
            ).first()
            self.assertIsNotNone(queue_row)
            queue_row.status = "sent"
            queue_row.completedAt = base_iso
            queue_row.updatedAt = base_iso
            queue_row.claimedAt = None
            session.add(queue_row)
            session.commit()

        first_now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            items = session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            self.assertTrue(
                main_module._orchestration_maybe_enqueue_recovery_follow_up(
                    session,
                    run=run,
                    items=items,
                    now_value=first_now,
                    trigger="test",
                    force=True,
                )
            )
            session.commit()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            items = session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            self.assertFalse(
                main_module._orchestration_maybe_enqueue_recovery_follow_up(
                    session,
                    run=run,
                    items=items,
                    now_value=first_now,
                    trigger="test",
                    force=False,
                )
            )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            recovery = dict((run.meta or {}).get("recovery") or {})
            follow_up_request_id = str(recovery.get("lastRequestId") or "")
            self.assertTrue(follow_up_request_id.startswith("occhat-fup-"))
            queue_row = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == follow_up_request_id).limit(1)
            ).first()
            self.assertIsNotNone(queue_row)
            queue_row.status = "sent"
            queue_row.completedAt = first_now
            queue_row.updatedAt = first_now
            queue_row.claimedAt = None
            session.add(queue_row)
            session.commit()

        not_due_iso = (datetime.fromisoformat(first_now.replace("Z", "+00:00")) + timedelta(seconds=90)).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            items = session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            self.assertFalse(
                main_module._orchestration_maybe_enqueue_recovery_follow_up(
                    session,
                    run=run,
                    items=items,
                    now_value=not_due_iso,
                    trigger="test",
                    force=False,
                )
            )

        due_iso = (datetime.fromisoformat(first_now.replace("Z", "+00:00")) + timedelta(seconds=121)).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            items = session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            self.assertTrue(
                main_module._orchestration_maybe_enqueue_recovery_follow_up(
                    session,
                    run=run,
                    items=items,
                    now_value=due_iso,
                    trigger="test",
                    force=False,
                )
            )
            session.commit()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            recovery = dict((run.meta or {}).get("recovery") or {})
            self.assertEqual(int(recovery.get("attempts") or 0), 2)

    def test_orch_003g_duplicate_subagent_replay_repairs_stale_completion_state(self):
        session_key = "clawboard:task:topic-orch-003g:task-orch-003g"
        request_id = self._openclaw_chat(session_key=session_key, message="Delegate and recover from replay races.")
        child_session = "agent:coding:subagent:orch-003g-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003g-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003g-spawn",
        )

        child_message_id = "oc:orch-003g-child-msg"
        first_child_row = self._append_log(
            LogAppend(
                type="conversation",
                content="LATENCY_OK",
                summary="LATENCY_OK",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Coding",
                source={"sessionKey": child_session, "channel": "direct", "requestId": request_id, "messageId": child_message_id},
            ),
            idem="orch-003g-child-first",
        )
        self._append_log(
            LogAppend(
                type="conversation",
                content="Done — latency test complete.",
                summary="Main final response",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id, "messageId": "oc:orch-003g-main"},
            ),
            idem="orch-003g-main-final",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            items = session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            child_item = next(item for item in items if item.itemKey == f"subagent:{child_session}")
            main_item = next(item for item in items if item.itemKey == "main.response")
            child_item.status = "stalled"
            child_item.completedAt = None
            child_item.nextCheckAt = now_iso()
            main_item.status = "running"
            main_item.completedAt = None
            main_item.nextCheckAt = now_iso()
            run.status = "running"
            run.completedAt = None
            session.add(child_item)
            session.add(main_item)
            session.add(run)
            session.commit()

        replay_row = self._append_log(
            LogAppend(
                type="conversation",
                content="LATENCY_OK",
                summary="LATENCY_OK",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Coding",
                source={"sessionKey": child_session, "channel": "direct", "requestId": request_id, "messageId": child_message_id},
            ),
            idem="orch-003g-child-replay",
        )

        self.assertEqual(replay_row.id, first_child_row.id)
        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(statuses.get(f"subagent:{child_session}"), "done")
            self.assertEqual(statuses.get("main.response"), "done")
            self.assertEqual(run.status, "done")

    def test_orch_003h_tick_repairs_stale_subagent_completion_from_existing_logs(self):
        session_key = "clawboard:task:topic-orch-003h:task-orch-003h"
        request_id = self._openclaw_chat(session_key=session_key, message="Recover stale orchestration state from logs.")
        child_session = "agent:coding:subagent:orch-003h-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003h-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003h-spawn",
        )
        self._append_log(
            LogAppend(
                type="conversation",
                content="LATENCY_OK",
                summary="LATENCY_OK",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Coding",
                source={"sessionKey": child_session, "channel": "direct", "requestId": request_id, "messageId": "oc:orch-003h-child"},
            ),
            idem="orch-003h-child",
        )
        self._append_log(
            LogAppend(
                type="conversation",
                content="Done — latency test complete.",
                summary="Main final response",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="OpenClaw",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id, "messageId": "oc:orch-003h-main"},
            ),
            idem="orch-003h-main",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            items = session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            child_item = next(item for item in items if item.itemKey == f"subagent:{child_session}")
            main_item = next(item for item in items if item.itemKey == "main.response")
            child_item.status = "stalled"
            child_item.completedAt = None
            child_item.nextCheckAt = now_iso()
            main_item.status = "running"
            main_item.completedAt = None
            main_item.nextCheckAt = now_iso()
            run.status = "running"
            run.completedAt = None
            session.add(child_item)
            session.add(main_item)
            session.add(run)
            session.commit()

        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            statuses = {
                row.itemKey: row.status
                for row in session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            }
            self.assertEqual(statuses.get(f"subagent:{child_session}"), "done")
            self.assertEqual(statuses.get("main.response"), "done")
            self.assertEqual(run.status, "done")

    def test_orch_003i_tick_repair_enqueues_follow_up_when_child_finished_but_main_has_not_replied(self):
        session_key = "clawboard:task:topic-orch-003i:task-orch-003i"
        request_id = self._openclaw_chat(session_key=session_key, message="Recover a finished child and relay it.")
        child_session = "agent:coding:subagent:orch-003i-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-003i-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-003i-spawn",
        )
        self._append_log(
            LogAppend(
                type="conversation",
                content="LATENCY_OK",
                summary="LATENCY_OK",
                createdAt=now_iso(),
                agentId="assistant",
                agentLabel="Coding",
                source={"sessionKey": child_session, "channel": "direct", "requestId": request_id, "messageId": "oc:orch-003i-child"},
            ),
            idem="orch-003i-child",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            child_item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == f"subagent:{child_session}")
            ).first()
            self.assertIsNotNone(child_item)
            child_item.status = "stalled"
            child_item.completedAt = None
            session.add(child_item)
            queue_row = session.exec(
                select(OpenClawChatDispatchQueue).where(OpenClawChatDispatchQueue.requestId == request_id).limit(1)
            ).first()
            self.assertIsNotNone(queue_row)
            queue_row.status = "sent"
            queue_row.completedAt = now_iso()
            queue_row.updatedAt = queue_row.completedAt
            queue_row.claimedAt = None
            session.add(queue_row)
            session.commit()

        main_module._orchestration_tick_once()

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            child_item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == f"subagent:{child_session}")
            ).first()
            self.assertEqual(child_item.status, "done")
            follow_up_rows = session.exec(
                select(OpenClawChatDispatchQueue)
                .where(OpenClawChatDispatchQueue.requestId.like("occhat-fup-%"))
            ).all()
            self.assertTrue(follow_up_rows)
            self.assertTrue(any(session_key == row.sessionKey for row in follow_up_rows))

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

    def test_orch_004b_cancel_during_subagent_phase_stops_parent_and_child_immediately(self):
        session_key = "clawboard:task:topic-orch-004b:task-orch-004b"
        request_id = self._openclaw_chat(session_key=session_key, message="Delegate and then cancel mid-flight.")
        child_session = "agent:coding:subagent:orch-004b-child"
        now_value = now_iso()

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-004b-child"}}',
                createdAt=now_value,
                agentId="main",
                agentLabel="Main",
                source={
                    "sessionKey": session_key,
                    "channel": "openclaw",
                    "requestId": request_id,
                    "boardScopeTopicId": "topic-orch-004b",
                    "boardScopeTaskId": "task-orch-004b",
                },
            ),
            idem="orch-004b-spawn",
        )
        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: exec_command",
                summary="subagent progress",
                raw='{"ok":true}',
                createdAt=now_value,
                agentId="coding",
                agentLabel="Agent coding",
                source={
                    "channel": "direct",
                    "sessionKey": child_session,
                    "requestId": request_id,
                    "boardScopeTopicId": "topic-orch-004b",
                    "boardScopeTaskId": "task-orch-004b",
                },
            ),
            idem="orch-004b-subagent-progress",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            main_item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == "main.response")
            ).first()
            self.assertIsNotNone(main_item)
            main_item.status = "stalled"
            main_item.updatedAt = now_value
            main_item.nextCheckAt = now_value
            session.add(main_item)
            child_item = session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run.runId)
                .where(OrchestrationItem.itemKey == f"subagent:{child_session}")
            ).first()
            if child_item is None:
                child_item = OrchestrationItem(
                    runId=run.runId,
                    itemKey=f"subagent:{child_session}",
                    parentItemKey="main.response",
                    requestId=request_id,
                    agentId="coding",
                    kind="subagent",
                    goal="execute delegated coding work",
                    sessionKey=child_session,
                    status="running",
                    attempts=0,
                    nextCheckAt=now_value,
                    startedAt=now_value,
                    completedAt=None,
                    lastError=None,
                    meta={"seededBy": "test_orch_004b"},
                    createdAt=now_value,
                    updatedAt=now_value,
                )
            self.assertEqual(str(child_item.status or ""), "running")
            session.add(child_item)
            session.commit()

        published: list[dict] = []

        def _collect_event(event: dict):
            published.append(event)
            return {**event, "eventId": str(len(published))}

        with patch.object(main_module, "gateway_rpc", new=AsyncMock(return_value={"ok": True})), patch.object(
            main_module.event_hub, "publish", side_effect=_collect_event
        ):
            result = main_module.openclaw_chat_cancel(
                OpenClawChatCancelRequest(sessionKey=session_key, requestId=request_id)
            )

        self.assertTrue(bool(result.get("aborted")))
        cancelled_sessions = set(result.get("sessionKeys") or [])
        self.assertIn(session_key, cancelled_sessions)
        self.assertIn(child_session, cancelled_sessions)

        typing_stop_sessions = {
            str((event.get("data") or {}).get("sessionKey") or "")
            for event in published
            if str(event.get("type") or "") == "openclaw.typing" and not bool((event.get("data") or {}).get("typing"))
        }
        self.assertIn(session_key, typing_stop_sessions)
        self.assertIn(child_session, typing_stop_sessions)
        thread_work_stop_sessions = {
            str((event.get("data") or {}).get("sessionKey") or "")
            for event in published
            if str(event.get("type") or "") == "openclaw.thread_work"
            and not bool((event.get("data") or {}).get("active"))
        }
        self.assertIn(session_key, thread_work_stop_sessions)
        self.assertIn(child_session, thread_work_stop_sessions)

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            self.assertEqual(str(run.status or ""), "cancelled")
            items = session.exec(select(OrchestrationItem).where(OrchestrationItem.runId == run.runId)).all()
            self.assertTrue(items)
            statuses = {str(item.itemKey or ""): str(item.status or "") for item in items}
            self.assertIn(statuses.get("main.response"), {"cancelled", "done"})
            self.assertIn(statuses.get(f"subagent:{child_session}"), {"cancelled", "done"})

    def test_orch_005_context_includes_orchestration_snapshot(self):
        session_key = "clawboard:task:topic-orch-005:task-orch-005"
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
        session_key = "clawboard:task:topic-orch-006:task-orch-006"
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
        session_key = "clawboard:task:topic-orch-006b:task-orch-006b"
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
        session_key = "clawboard:task:topic-orch-006c:task-orch-006c"
        request_id = self._openclaw_chat(session_key=session_key, message="Keep me posted while this runs.")
        child_session = "agent:coding:subagent:orch-006c-child"
        due_dt = datetime.now(timezone.utc) - timedelta(minutes=2)
        due_iso = due_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        fresh_iso = now_iso()

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-006c-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-006c-spawn",
        )

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

    def test_orch_006ca_tick_skips_main_check_in_before_any_subagent_exists(self):
        session_key = "clawboard:task:topic-orch-006ca:task-orch-006ca"
        request_id = self._openclaw_chat(session_key=session_key, message="Tell me when delegated work starts.")
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
            logs = session.exec(
                select(LogEntry)
                .where(LogEntry.topicId == "topic-orch-006ca")
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
            self.assertFalse(checkins, "Main check-ins should wait until delegated items or failures actually exist.")

    def test_orch_007_main_only_assistant_reply_closes_run_without_subagents(self):
        session_key = "clawboard:task:topic-orch-007:task-orch-007"
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
        session_key = "clawboard:task:topic-orch-008:task-orch-008"
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

    def test_orch_009a_stale_session_cannot_append_duplicate_item_done_event(self):
        session_key = "clawboard:task:topic-orch-009a:task-orch-009a"
        request_id = self._openclaw_chat(session_key=session_key, message="Delegate once and close cleanly.")
        child_session = "agent:coding:subagent:orch-009a-child"

        self._append_log(
            LogAppend(
                type="action",
                content="Tool result: sessions_spawn",
                summary="Tool result: sessions_spawn",
                raw='{"toolName":"sessions_spawn","result":{"childSessionKey":"agent:coding:subagent:orch-009a-child"}}',
                createdAt=now_iso(),
                agentId="main",
                agentLabel="Main",
                source={"sessionKey": session_key, "channel": "openclaw", "requestId": request_id},
            ),
            idem="orch-009a-spawn",
        )

        with get_session() as session:
            run = session.exec(select(OrchestrationRun).where(OrchestrationRun.requestId == request_id)).first()
            self.assertIsNotNone(run)
            run_id = run.runId

        with get_session() as stale_session:
            stale_item = stale_session.exec(
                select(OrchestrationItem)
                .where(OrchestrationItem.runId == run_id)
                .where(OrchestrationItem.itemKey == f"subagent:{child_session}")
            ).first()
            self.assertIsNotNone(stale_item)
            self.assertEqual(stale_item.status, "running")

            with get_session() as fresh_session:
                fresh_item = fresh_session.exec(
                    select(OrchestrationItem)
                    .where(OrchestrationItem.runId == run_id)
                    .where(OrchestrationItem.itemKey == f"subagent:{child_session}")
                ).first()
                self.assertIsNotNone(fresh_item)
                changed = main_module._orchestration_mark_item_status(
                    fresh_session,
                    run_id=run_id,
                    item=fresh_item,
                    status="done",
                    now_value=now_iso(),
                    source_log_id="orch-009a-log-a",
                    completed_at=now_iso(),
                )
                self.assertTrue(changed)
                fresh_session.commit()

            changed_again = main_module._orchestration_mark_item_status(
                stale_session,
                run_id=run_id,
                item=stale_item,
                status="done",
                now_value=now_iso(),
                source_log_id="orch-009a-log-b",
                completed_at=now_iso(),
            )
            self.assertFalse(changed_again)
            stale_session.commit()

        with get_session() as session:
            done_events = session.exec(
                select(OrchestrationEvent)
                .where(OrchestrationEvent.runId == run_id)
                .where(OrchestrationEvent.itemKey == f"subagent:{child_session}")
                .where(OrchestrationEvent.eventType == "item_done")
            ).all()
            self.assertEqual(len(done_events), 1)


if __name__ == "__main__":
    unittest.main()
