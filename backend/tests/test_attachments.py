from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-attachments-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"
os.environ["CLAWBOARD_ATTACHMENTS_DIR"] = os.path.join(TMP_DIR, "attachments")
# Keep this tight so tests fail fast if something accidentally tries to upload large files.
os.environ["CLAWBOARD_ATTACHMENT_MAX_BYTES"] = str(1024 * 1024)  # 1MB

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import Attachment, LogEntry  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class AttachmentApiTests(unittest.TestCase):
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
            for row in session.exec(select(LogEntry)).all():
                session.delete(row)
            session.commit()

    def test_upload_and_download_roundtrip(self):
        content = b"hello attachments\n"
        res = self.client.post(
            "/api/attachments",
            headers=self.auth_headers,
            files={"files": ("notes.txt", content, "text/plain")},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsInstance(payload, list)
        self.assertEqual(len(payload), 1)
        att = payload[0]
        self.assertTrue(str(att.get("id") or "").startswith("att-"))
        self.assertEqual(att.get("fileName"), "notes.txt")
        self.assertEqual(att.get("mimeType"), "text/plain")
        self.assertEqual(att.get("sizeBytes"), len(content))

        att_id = att["id"]
        download = self.client.get(f"/api/attachments/{att_id}", headers=self.auth_headers)
        self.assertEqual(download.status_code, 200, download.text)
        self.assertEqual(download.content, content)
        self.assertTrue((download.headers.get("content-type") or "").startswith("text/plain"))

    def test_upload_infers_mime_from_filename_when_octet_stream(self):
        content = b"# hello\n"
        res = self.client.post(
            "/api/attachments",
            headers=self.auth_headers,
            files={"files": ("notes.md", content, "application/octet-stream")},
        )
        self.assertEqual(res.status_code, 200, res.text)
        att = res.json()[0]
        self.assertEqual(att.get("mimeType"), "text/markdown")

    def test_openclaw_chat_persists_attachments_metadata(self):
        # Upload a markdown attachment
        upload = self.client.post(
            "/api/attachments",
            headers=self.auth_headers,
            files={"files": ("brief.md", b"todo: tests\n", "application/octet-stream")},
        )
        self.assertEqual(upload.status_code, 200, upload.text)
        att_id = upload.json()[0]["id"]

        # Configure a fast-fail base URL so the background task doesn't hang.
        os.environ["OPENCLAW_BASE_URL"] = "http://127.0.0.1:9"
        os.environ["OPENCLAW_GATEWAY_TOKEN"] = "test"

        session_key = "clawboard:topic:topic-test"
        msg = "check attachment"
        chat = self.client.post(
            "/api/openclaw/chat",
            headers=self.auth_headers,
            json={"sessionKey": session_key, "message": msg, "agentId": "main", "attachmentIds": [att_id]},
        )
        self.assertEqual(chat.status_code, 200, chat.text)
        self.assertTrue(chat.json().get("queued"))

        logs = self.client.get(f"/api/log?sessionKey={session_key}&limit=20", headers=self.auth_headers)
        self.assertEqual(logs.status_code, 200, logs.text)
        rows = logs.json()
        user_rows = [row for row in rows if (row.get("agentId") or "").lower() == "user" and row.get("content") == msg]
        self.assertTrue(user_rows)
        attachments = user_rows[0].get("attachments") or []
        self.assertTrue(any(att.get("id") == att_id for att in attachments))
