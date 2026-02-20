from __future__ import annotations

import types
import unittest
from unittest.mock import patch

from classifier import classifier as c


class SpaceScopedSessionTests(unittest.TestCase):
    def test_classify_session_scoped_sets_scope_context_and_resets(self):
        observed_scopes: list[tuple[str | None, tuple[str, ...] | None]] = []

        def _capture_scope(session_key: str):
            observed_scopes.append((session_key, c._SPACE_SCOPE_ALLOWED_IDS.get()))

        with (
            patch.object(c, "_resolve_allowed_space_ids_for_session", return_value=("space-alpha", "space-beta")),
            patch.object(c, "classify_session", side_effect=_capture_scope),
        ):
            c._classify_session_scoped("clawboard:topic:topic-123")

        self.assertEqual(len(observed_scopes), 1)
        self.assertEqual(observed_scopes[0][0], "clawboard:topic:topic-123")
        self.assertEqual(observed_scopes[0][1], ("space-alpha", "space-beta"))
        self.assertIsNone(c._SPACE_SCOPE_ALLOWED_IDS.get())

    def test_classify_session_scoped_without_scope_calls_plain_classify(self):
        with (
            patch.object(c, "_resolve_allowed_space_ids_for_session", return_value=None),
            patch.object(c, "classify_session") as classify_mock,
        ):
            c._classify_session_scoped("channel:plain-session")

        classify_mock.assert_called_once_with("channel:plain-session")
        self.assertIsNone(c._SPACE_SCOPE_ALLOWED_IDS.get())

    def test_space_scope_params_appends_allowed_space_ids(self):
        token = c._SPACE_SCOPE_ALLOWED_IDS.set(("space-one", "space-two"))
        try:
            payload = c._space_scope_params({"limit": 25, "offset": 0})
        finally:
            c._SPACE_SCOPE_ALLOWED_IDS.reset(token)

        self.assertEqual(payload.get("limit"), 25)
        self.assertEqual(payload.get("offset"), 0)
        self.assertEqual(payload.get("allowedSpaceIds"), "space-one,space-two")

    def test_negative_cache_keys_are_case_insensitive(self):
        cache: dict[str, float] = {}
        c._negative_cache_mark(cache, "TASK-AbC-123", ttl_seconds=300.0)
        self.assertTrue(c._negative_cache_has(cache, "task-abc-123"))
        self.assertTrue(c._negative_cache_has(cache, "TASK-ABC-123"))

    def test_missing_session_cache_uses_session_base_key(self):
        calls: list[str] = []

        class _FakeResponse:
            def __init__(self, *, ok: bool, status_code: int, body: object):
                self.ok = ok
                self.status_code = status_code
                self._body = body

            def json(self):
                return self._body

        def _fake_get(url, params=None, headers=None, timeout=None):
            _ = (params, headers, timeout)
            text = str(url)
            calls.append(text)
            if text.endswith("/api/log"):
                return _FakeResponse(ok=True, status_code=200, body=[])
            if "/api/tasks/" in text:
                return _FakeResponse(ok=False, status_code=404, body={"detail": "missing"})
            if "/api/topics/" in text:
                return _FakeResponse(ok=False, status_code=404, body={"detail": "missing"})
            if text.endswith("/api/spaces/allowed"):
                return _FakeResponse(ok=True, status_code=200, body={"allowedSpaceIds": ["space-default"]})
            raise AssertionError(f"unexpected classifier HTTP call: {text}")

        fake_requests = types.SimpleNamespace(get=_fake_get)
        c._MISSING_TASK_SCOPE_CACHE.clear()
        c._MISSING_TOPIC_SCOPE_CACHE.clear()
        c._MISSING_SESSION_SCOPE_CACHE.clear()
        try:
            with patch.object(c, "requests", fake_requests):
                scoped_a = c._resolve_allowed_space_ids_for_session(
                    "clawboard:task:topic-404-loop:task-404-loop|thread:one"
                )
                scoped_b = c._resolve_allowed_space_ids_for_session(
                    "clawboard:task:topic-404-loop:task-404-loop|thread:two"
                )
        finally:
            c._MISSING_TASK_SCOPE_CACHE.clear()
            c._MISSING_TOPIC_SCOPE_CACHE.clear()
            c._MISSING_SESSION_SCOPE_CACHE.clear()

        self.assertIsNone(scoped_a)
        self.assertIsNone(scoped_b)
        self.assertEqual(len([call for call in calls if "/api/tasks/" in call]), 1)
        self.assertEqual(len([call for call in calls if "/api/log" in call]), 1)


class SpaceScopedApiForwardingTests(unittest.TestCase):
    def test_list_logs_forwards_allowed_space_ids(self):
        captured: dict[str, object] = {}

        class _FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return []

        def _fake_get(url, params=None, headers=None, timeout=None):
            captured["url"] = url
            captured["params"] = params or {}
            captured["headers"] = headers or {}
            captured["timeout"] = timeout
            return _FakeResponse()

        token = c._SPACE_SCOPE_ALLOWED_IDS.set(("space-a", "space-b", "space-c"))
        try:
            fake_requests = types.SimpleNamespace(get=_fake_get)
            with patch.object(c, "requests", fake_requests):
                rows = c.list_logs({"sessionKey": "channel:test", "limit": 10, "offset": 0})
        finally:
            c._SPACE_SCOPE_ALLOWED_IDS.reset(token)

        self.assertEqual(rows, [])
        params = captured.get("params") or {}
        self.assertEqual(params.get("sessionKey"), "channel:test")
        self.assertEqual(params.get("allowedSpaceIds"), "space-a,space-b,space-c")


if __name__ == "__main__":
    unittest.main()
