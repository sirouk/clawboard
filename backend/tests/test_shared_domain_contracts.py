from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-shared-contract-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import LogEntry, Task, Topic  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso(offset_seconds: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat().replace("+00:00", "Z")


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class SharedDomainContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    @staticmethod
    def _assert_log_shape(payload):
        required_fields = [
            "id",
            "topicId",
            "type",
            "content",
            "classificationStatus",
            "createdAt",
            "updatedAt",
        ]
        for field in required_fields:
            assert field in payload

    @staticmethod
    def _assert_fastapi_error(response, expected_status: int):
        assert response.status_code == expected_status, response.text
        payload = response.json()
        assert isinstance(payload, dict), response.text
        assert "detail" in payload, response.text
        return payload["detail"]

    def setUp(self):
        with get_session() as session:
            for row in session.exec(select(LogEntry)).all():
                session.delete(row)
            for row in session.exec(select(Task)).all():
                session.delete(row)
            for row in session.exec(select(Topic)).all():
                session.delete(row)
            session.commit()

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    def test_topics_contract_is_array_and_sorted_for_shared_read(self):
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-old-pinned",
                    name="Pinned old",
                    color="#FF8A4A",
                    description="contract",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=True,
                    sortIndex=10,
                    createdAt=now_iso(-120),
                    updatedAt=now_iso(-120),
                )
            )
            session.add(
                Topic(
                    id="topic-new-pinned",
                    name="Pinned new",
                    color="#4EA1FF",
                    description="contract",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=True,
                    sortIndex=1,
                    createdAt=now_iso(-60),
                    updatedAt=now_iso(-60),
                )
            )
            session.add(
                Topic(
                    id="topic-unpinned",
                    name="Unpinned",
                    color="#4EA1FF",
                    description="contract",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    sortIndex=0,
                    createdAt=now_iso(-30),
                    updatedAt=now_iso(-30),
                )
            )
            session.commit()

        res = self.client.get("/api/topics")
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsInstance(payload, list, res.text)
        if payload:
            for field in ["id", "name", "sortIndex", "updatedAt"]:
                self.assertIn(field, payload[0], res.text)
        self.assertEqual([item.get("id") for item in payload[:3]], ["topic-new-pinned", "topic-old-pinned", "topic-unpinned"])

    def test_tasks_contract_is_array_and_sorted_for_shared_read(self):
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-tasks-root",
                    name="Tasks root",
                    color="#FF8A4A",
                    description="contract",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    sortIndex=0,
                    createdAt=now_iso(-300),
                    updatedAt=now_iso(-300),
                )
            )
            session.add(
                Task(
                    id="task-unpinned",
                    topicId="topic-tasks-root",
                    title="Unpinned",
                    color="#4EA1FF",
                    status="todo",
                    sortIndex=0,
                    pinned=False,
                    createdAt=now_iso(-240),
                    updatedAt=now_iso(-240),
                    tags=[],
                    dueDate=None,
                    priority="medium",
                    snoozedUntil=None,
                )
            )
            session.add(
                Task(
                    id="task-pinned-old",
                    topicId="topic-tasks-root",
                    title="Pinned old",
                    color="#4EA1FF",
                    status="todo",
                    sortIndex=10,
                    pinned=True,
                    createdAt=now_iso(-180),
                    updatedAt=now_iso(-180),
                    tags=[],
                    dueDate=None,
                    priority="medium",
                    snoozedUntil=None,
                )
            )
            session.add(
                Task(
                    id="task-pinned-new",
                    topicId="topic-tasks-root",
                    title="Pinned new",
                    color="#4EA1FF",
                    status="todo",
                    sortIndex=5,
                    pinned=True,
                    createdAt=now_iso(-120),
                    updatedAt=now_iso(-120),
                    tags=[],
                    dueDate=None,
                    priority="medium",
                    snoozedUntil=None,
                )
            )
            session.commit()

        res = self.client.get("/api/tasks")
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsInstance(payload, list, res.text)
        if payload:
            for field in ["id", "topicId", "title", "sortIndex", "status", "updatedAt"]:
                self.assertIn(field, payload[0], res.text)
        self.assertEqual([item.get("id") for item in payload[:3]], ["task-pinned-new", "task-pinned-old", "task-unpinned"])

    def test_log_contract_is_array_and_sorted_for_shared_read(self):
        with get_session() as session:
            session.add(
                LogEntry(
                    id="log-old",
                    topicId=None,
                    taskId=None,
                    relatedLogId=None,
                    idempotencyKey=None,
                    type="conversation",
                    content="old",
                    summary="old",
                    raw=None,
                    classificationStatus="classified",
                    classificationAttempts=0,
                    classificationError=None,
                    createdAt=now_iso(-120),
                    updatedAt=now_iso(-120),
                    agentId="user",
                    agentLabel="User",
                    source={"sessionKey": "topic-chat:one"},
                )
            )
            session.add(
                LogEntry(
                    id="log-new",
                    topicId=None,
                    taskId=None,
                    relatedLogId=None,
                    idempotencyKey=None,
                    type="conversation",
                    content="new",
                    summary="new",
                    raw=None,
                    classificationStatus="classified",
                    classificationAttempts=0,
                    classificationError=None,
                    createdAt=now_iso(-60),
                    updatedAt=now_iso(-60),
                    agentId="user",
                    agentLabel="User",
                    source={"sessionKey": "topic-chat:two"},
                )
            )
            session.commit()

        res = self.client.get("/api/log")
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsInstance(payload, list, res.text)
        self.assertEqual(payload[0].get("id"), "log-new")
        self.assertEqual(payload[1].get("id"), "log-old")
        self._assert_log_shape(payload[0])
        self._assert_log_shape(payload[1])

    def test_write_endpoints_return_expected_status_codes(self):
        res_topic = self.client.post("/api/topics", headers=self.auth_headers, json={"name": "Write contract topic"})
        self.assertEqual(res_topic.status_code, 200, res_topic.text)
        topic_id = res_topic.json().get("id")
        self.assertIsNotNone(topic_id, res_topic.text)

        res_task = self.client.post(
            "/api/tasks",
            headers=self.auth_headers,
            json={"topicId": topic_id, "title": "Write contract task"},
        )
        self.assertEqual(res_task.status_code, 200, res_task.text)

        with get_session() as session:
            topic = session.get(Topic, topic_id)
            self.assertIsNotNone(topic)

        res_log = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": topic_id,
                "content": "contract log",
                "summary": "contract log",
                "raw": "contract raw",
                "createdAt": now_iso(),
                "agentId": "classifier",
                "agentLabel": "Classifier",
                "source": {"sessionKey": "contract"},
            },
        )
        self.assertEqual(res_log.status_code, 200, res_log.text)
        payload = res_log.json()
        self.assertIsInstance(payload, dict, res_log.text)
        self._assert_log_shape(payload)

    def test_shared_domain_404_envelope_is_fastapi_detail(self):
        missing_topic = self.client.get("/api/topics/nonexistent")
        self.assertEqual(self._assert_fastapi_error(missing_topic, 404), "Topic not found")

        missing_task = self.client.get("/api/tasks/nonexistent")
        self.assertEqual(self._assert_fastapi_error(missing_task, 404), "Task not found")

        missing_log = self.client.get("/api/log/nonexistent")
        self.assertEqual(self._assert_fastapi_error(missing_log, 404), "Log not found")

    def test_shared_domain_invalid_create_requests_return_422_detail_envelope(self):
        res_topic = self.client.post("/api/topics", headers=self.auth_headers, json={})
        detail = self._assert_fastapi_error(res_topic, 422)
        self.assertIsInstance(detail, list, res_topic.text)
        self.assertGreater(len(detail), 0, res_topic.text)

        res_task = self.client.post("/api/tasks", headers=self.auth_headers, json={})
        detail = self._assert_fastapi_error(res_task, 422)
        self.assertIsInstance(detail, list, res_task.text)
        self.assertGreater(len(detail), 0, res_task.text)

        res_log = self.client.post("/api/log", headers=self.auth_headers, json={})
        detail = self._assert_fastapi_error(res_log, 422)
        self.assertIsInstance(detail, list, res_log.text)
        self.assertGreater(len(detail), 0, res_log.text)



if __name__ == "__main__":
    unittest.main()
