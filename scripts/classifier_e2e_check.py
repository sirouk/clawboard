#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

API_BASE = os.environ.get("CLAWBOARD_TEST_API_BASE", "http://localhost:8010").rstrip("/")
TOKEN = os.environ.get("CLAWBOARD_TOKEN", "")
POLL_SECONDS = float(os.environ.get("CLAWBOARD_CLASSIFIER_TEST_POLL_SECONDS", "2"))
TIMEOUT_SECONDS = float(os.environ.get("CLAWBOARD_CLASSIFIER_TEST_TIMEOUT_SECONDS", "180"))
CREATED_AT_BASE = os.environ.get("CLAWBOARD_CLASSIFIER_TEST_CREATED_AT_BASE", "2099-01-01T00").strip()

GENERIC_TOPIC_NAMES = {
    "general",
    "misc",
    "miscellaneous",
    "new",
    "topic",
    "topics",
    "task",
    "tasks",
    "todo",
    "note",
    "notes",
    "log",
    "logs",
    "board",
    "graph",
    "clawgraph",
    "clawboard",
}

GENERIC_TASK_TITLES = {
    "todo",
    "task",
    "new task",
    "follow up",
    "next step",
    "action item",
}

LOW_SIGNAL_PREFIXES = (
    "let ",
    "lets ",
    "let's ",
    "can ",
    "can you",
    "could ",
    "would ",
    "should ",
    "please ",
    "what ",
    "how ",
    "why ",
    "tell ",
    "show ",
    "review ",
    "summarize ",
)

ROOT_DIR = Path(__file__).resolve().parents[1]
FIXTURES_DIR = ROOT_DIR / "classifier" / "tests" / "fixtures"


def fail(message: str) -> None:
    raise AssertionError(message)


def _api_request(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    url = f"{API_BASE}{path}"
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["X-Clawboard-Token"] = TOKEN
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    last_error: Exception | None = None
    for attempt in range(4):
        req = urllib.request.Request(url=url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                body = response.read().decode("utf-8")
                if not body:
                    return None
                return json.loads(body)
        except urllib.error.HTTPError as exc:
            if exc.code in {502, 503, 504} and attempt < 3:
                last_error = exc
                time.sleep(0.5 * (attempt + 1))
                continue
            body = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"{method} {path} failed ({exc.code}): {body[:280]}") from exc
        except (urllib.error.URLError, ConnectionResetError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt >= 3:
                break
            time.sleep(0.5 * (attempt + 1))

    raise RuntimeError(f"{method} {path} failed after retries: {last_error}")


def _append_conversation(
    session_key: str,
    agent_id: str,
    agent_label: str,
    content: str,
    *,
    message_id: str | None = None,
    created_at: str | None = None,
) -> str:
    msg_id = message_id or f"classifier-e2e-{uuid.uuid4().hex[:12]}"
    payload = {
        "type": "conversation",
        "content": content,
        "summary": content,
        "raw": "",
        "agentId": agent_id,
        "agentLabel": agent_label,
        **({"createdAt": created_at} if created_at else {}),
        "source": {
            "sessionKey": session_key,
            "channel": "classifier-e2e",
            "messageId": msg_id,
        },
    }
    row = _api_request("POST", "/api/log", payload)
    log_id = str((row or {}).get("id") or "")
    if not log_id:
        fail(f"append_log missing id for session={session_key}")
    return log_id


def _append_action(
    session_key: str,
    agent_id: str,
    agent_label: str,
    content: str,
    *,
    message_id: str | None = None,
    created_at: str | None = None,
) -> str:
    msg_id = message_id or f"classifier-e2e-{uuid.uuid4().hex[:12]}"
    payload = {
        "type": "action",
        "content": content,
        "summary": content,
        "raw": "",
        "agentId": agent_id,
        "agentLabel": agent_label,
        **({"createdAt": created_at} if created_at else {}),
        "source": {
            "sessionKey": session_key,
            "channel": "classifier-e2e",
            "messageId": msg_id,
        },
    }
    row = _api_request("POST", "/api/log", payload)
    log_id = str((row or {}).get("id") or "")
    if not log_id:
        fail(f"append_action missing id for session={session_key}")
    return log_id


def _append_log(
    log_type: str,
    session_key: str,
    agent_id: str,
    agent_label: str,
    content: str,
    *,
    message_id: str | None = None,
    created_at: str | None = None,
) -> str:
    msg_id = message_id or f"classifier-e2e-{uuid.uuid4().hex[:12]}"
    payload = {
        "type": log_type,
        "content": content,
        "summary": content,
        "raw": "",
        "agentId": agent_id,
        "agentLabel": agent_label,
        **({"createdAt": created_at} if created_at else {}),
        "source": {
            "sessionKey": session_key,
            "channel": "classifier-e2e",
            "messageId": msg_id,
        },
    }
    row = _api_request("POST", "/api/log", payload)
    log_id = str((row or {}).get("id") or "")
    if not log_id:
        fail(f"append_log missing id for session={session_key}")
    return log_id


def _create_topic(name: str) -> str:
    payload = {"name": name, "tags": ["classifier-e2e"]}
    row = _api_request("POST", "/api/topics", payload)
    topic_id = str((row or {}).get("id") or "")
    if not topic_id:
        fail(f"create_topic missing id for name={name!r}")
    return topic_id


def _create_task(topic_id: str, title: str) -> str:
    payload = {"topicId": topic_id, "title": title, "status": "todo", "tags": ["classifier-e2e"]}
    row = _api_request("POST", "/api/tasks", payload)
    task_id = str((row or {}).get("id") or "")
    if not task_id:
        fail(f"create_task missing id for title={title!r}")
    return task_id


def _wait_for_classification(session_key: str, expected_ids: set[str]) -> dict[str, dict[str, Any]]:
    deadline = time.time() + TIMEOUT_SECONDS
    last_rows: dict[str, dict[str, Any]] = {}
    while time.time() < deadline:
        query = urllib.parse.urlencode(
            {
                "sessionKey": session_key,
                "limit": 500,
            }
        )
        rows = _api_request("GET", f"/api/log?{query}") or []
        indexed: dict[str, dict[str, Any]] = {}
        for row in rows:
            rid = str((row or {}).get("id") or "")
            if rid in expected_ids:
                indexed[rid] = row
        last_rows = indexed
        if expected_ids.issubset(indexed.keys()):
            pending = [
                rid
                for rid, row in indexed.items()
                if str((row or {}).get("classificationStatus") or "pending") == "pending"
            ]
            if not pending:
                return indexed
        time.sleep(POLL_SECONDS)

    status_snapshot = {
        rid: str((last_rows.get(rid) or {}).get("classificationStatus") or "missing")
        for rid in sorted(expected_ids)
    }
    fail(f"classifier timeout for {session_key}; statuses={status_snapshot}")
    return {}


def _normalize(value: str | None) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9\s]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _word_count(value: str | None) -> int:
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'/_-]*", str(value or "")))


def _assert_topic_name_quality(name: str, *, label: str) -> None:
    normalized = _normalize(name)
    if not normalized:
        fail(f"{label}: topic name is empty")
    if "_" in str(name or ""):
        fail(f"{label}: topic name contains underscores (looks like a token/identifier): {name!r}")
    if re.search(r"\b[0-9A-F]{6,}\b", str(name or "")):
        fail(f"{label}: topic name contains hash/run id token: {name!r}")
    if normalized in GENERIC_TOPIC_NAMES:
        fail(f"{label}: topic name is generic: {name!r}")
    if any(normalized.startswith(prefix) for prefix in LOW_SIGNAL_PREFIXES):
        fail(f"{label}: topic name starts with low-signal phrasing: {name!r}")
    wc = _word_count(name)
    if wc < 1 or wc > 6:
        fail(f"{label}: topic name word count out of range (1-6): {name!r}")


def _assert_task_title_quality(title: str, *, label: str) -> None:
    normalized = _normalize(title)
    if not normalized:
        fail(f"{label}: task title is empty")
    if "_" in str(title or ""):
        fail(f"{label}: task title contains underscores (looks like a token/identifier): {title!r}")
    if re.search(r"\b[0-9A-F]{6,}\b", str(title or "")):
        fail(f"{label}: task title contains hash/run id token: {title!r}")
    if normalized in GENERIC_TASK_TITLES:
        fail(f"{label}: task title is generic: {title!r}")
    wc = _word_count(title)
    if wc < 2 or wc > 12:
        fail(f"{label}: task title word count out of range (2-12): {title!r}")


def _validate_rows(
    rows_by_id: dict[str, dict[str, Any]],
    *,
    label: str,
    require_task: bool,
    forbid_task: bool,
) -> set[str]:
    if not rows_by_id:
        fail(f"{label}: no rows returned")
    topic_ids: set[str] = set()
    task_ids: set[str] = set()
    for rid, row in rows_by_id.items():
        status = str((row or {}).get("classificationStatus") or "pending")
        if status != "classified":
            fail(f"{label}: log {rid} status={status}, expected classified")
        topic_id = str((row or {}).get("topicId") or "")
        if not topic_id:
            fail(f"{label}: log {rid} missing topicId")
        topic_ids.add(topic_id)
        task_id = str((row or {}).get("taskId") or "")
        if task_id:
            task_ids.add(task_id)
        summary = str((row or {}).get("summary") or "").strip()
        if not summary:
            fail(f"{label}: log {rid} missing summary")
        if len(summary) > 56:
            fail(f"{label}: log {rid} summary too long ({len(summary)} > 56)")

    if len(topic_ids) != 1:
        fail(f"{label}: expected 1 topicId, found {sorted(topic_ids)}")

    if forbid_task and task_ids:
        fail(f"{label}: expected no tasks, found {sorted(task_ids)}")
    if require_task and not task_ids:
        fail(f"{label}: expected at least one task assignment")
    return task_ids


def _assert_log_state(
    row: dict[str, Any],
    *,
    label: str,
    expected_status: str,
    expected_error: str | None = None,
    expect_topic: bool | None = None,
) -> None:
    rid = str((row or {}).get("id") or "")
    status = str((row or {}).get("classificationStatus") or "pending")
    if status != expected_status:
        fail(f"{label}: log {rid} status={status}, expected {expected_status}")

    if expected_error is not None:
        got = (row or {}).get("classificationError")
        if str(got or "") != str(expected_error or ""):
            fail(f"{label}: log {rid} classificationError={got!r}, expected {expected_error!r}")

    if expect_topic is True:
        topic_id = str((row or {}).get("topicId") or "")
        if not topic_id:
            fail(f"{label}: log {rid} expected topicId to be set")
    if expect_topic is False:
        topic_id = str((row or {}).get("topicId") or "")
        if topic_id:
            fail(f"{label}: log {rid} expected no topicId, got {topic_id}")


def _load_fixture_window(name: str) -> list[dict[str, Any]]:
    path = FIXTURES_DIR / name
    if not path.exists():
        fail(f"missing fixture: {path}")
    return json.loads(path.read_text("utf-8"))


def _inject_nimbus_token(text: str, *, token: str | None) -> str:
    if not token:
        return text
    return re.sub(r"\bNIMBUS\b", token, text)


def main() -> int:
    cleanup_enabled = os.environ.get("CLAWBOARD_CLASSIFIER_TEST_CLEANUP", "1").strip() not in {"0", "false", "no"}
    run_token = uuid.uuid4().hex[:8].upper()
    created_log_ids: list[str] = []
    explicit_topic_ids: set[str] = set()
    explicit_task_ids: set[str] = set()

    scenarios = [
        {
            "label": "small-talk",
            "fixture": "small_talk_window.json",
            "nimbusToken": None,
            "requireTask": False,
            "forbidTask": True,
            # Small talk topic names are inherently low-signal; don't enforce strict name quality.
            "validateTopic": False,
            "validateTasks": False,
        },
        {
            "label": "topical-no-tasks",
            "fixture": "topical_no_tasks_window.json",
            "nimbusToken": f"NIMBUS_AUTH_{run_token}",
            "requireTask": False,
            "forbidTask": True,
            "validateTopic": True,
            "validateTasks": False,
        },
        {
            "label": "task-oriented",
            "fixture": "task_oriented_window.json",
            "nimbusToken": f"NIMBUS_LOGIN_{run_token}",
            "requireTask": True,
            "forbidTask": False,
            "validateTopic": True,
            "validateTasks": True,
        },
        {
            "label": "assistant-contamination",
            "mode": "assistant-contamination",
        },
        {
            "label": "multi-bundle",
            "mode": "multi-bundle",
        },
        {
            "label": "board-topic-promote-task",
            "mode": "board-topic-promote-task",
        },
        {
            "label": "board-topic-smalltalk",
            "mode": "board-topic-smalltalk",
        },
        {
            "label": "board-task-fixed-scope",
            "mode": "board-task-fixed-scope",
        },
        {
            "label": "filtering-mixed",
            "mode": "filtering-mixed",
        },
    ]

    scenario_results: list[dict[str, Any]] = []
    extra_sessions: list[str] = []

    try:
        for scenario_idx, scenario in enumerate(scenarios):
            label = str(scenario["label"])
            session_key = f"channel:classifier-e2e:{label}:{run_token.lower()}"

            if str(scenario.get("mode") or "") == "board-topic-promote-task":
                # Board Topic Chat pins the topic scope, but classifier may infer/create a task within it.
                topic_name = f"Board Topic Promote Z{run_token}"
                topic_id = _create_topic(topic_name)
                explicit_topic_ids.add(topic_id)
                session_key = f"clawboard:topic:{topic_id}"

                steps: list[tuple[str, str, str, str]] = [
                    ("conversation", "user", "User", f"Fix OAuth redirect Z{run_token} in the portal login flow."),
                    ("action", "assistant", "Assistant", "Tool call: web.search oauth redirect loop"),
                    ("conversation", "assistant", "Assistant", "Ok. I will inspect the callback handler and patch it."),
                ]

                expected_ids: set[str] = set()
                ids_in_order: list[str] = []
                for idx, (kind, agent_id, agent_label, content) in enumerate(steps):
                    message_id = f"classifier-e2e:{label}:{idx}:{run_token.lower()}"
                    created_at = f"{CREATED_AT_BASE}:{scenario_idx:02d}:{idx:02d}.000Z"
                    if kind == "conversation":
                        log_id = _append_conversation(
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                    else:
                        log_id = _append_action(
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                    created_log_ids.append(log_id)
                    expected_ids.add(log_id)
                    ids_in_order.append(log_id)

                print(f"classifier e2e: waiting {label} session {session_key}")
                rows = _wait_for_classification(session_key, expected_ids)

                task_ids = _validate_rows(rows, label=label, require_task=True, forbid_task=False)
                if len(task_ids) != 1:
                    fail(f"{label}: expected exactly one inferred task, got {sorted(task_ids)}")
                inferred_task_id = next(iter(task_ids))

                for rid in ids_in_order:
                    row = rows.get(rid) or {}
                    if str(row.get("topicId") or "") != topic_id:
                        fail(f"{label}: log {rid} expected topic {topic_id}, got {row.get('topicId')}")
                    if str(row.get("type") or "") == "action":
                        if str(row.get("taskId") or "") != inferred_task_id:
                            fail(
                                f"{label}: action log {rid} expected task {inferred_task_id}, got {row.get('taskId')}"
                            )

                explicit_task_ids.add(inferred_task_id)
                extra_sessions.append(session_key)
                continue

            if str(scenario.get("mode") or "") == "board-topic-smalltalk":
                # Board Topic Chat pins the topic scope; even small-talk should not be rerouted into "Small Talk".
                topic_id = _create_topic(f"Board Topic Smalltalk Z{run_token}")
                explicit_topic_ids.add(topic_id)
                session_key = f"clawboard:topic:{topic_id}"

                steps: list[tuple[str, str, str]] = [
                    ("user", "User", "Hey there."),
                    ("assistant", "Assistant", "Hey! What's up?"),
                ]

                expected_ids: set[str] = set()
                for idx, (agent_id, agent_label, content) in enumerate(steps):
                    message_id = f"classifier-e2e:{label}:{idx}:{run_token.lower()}"
                    created_at = f"{CREATED_AT_BASE}:{scenario_idx:02d}:{idx:02d}.000Z"
                    log_id = _append_conversation(
                        session_key,
                        agent_id,
                        agent_label,
                        content,
                        message_id=message_id,
                        created_at=created_at,
                    )
                    created_log_ids.append(log_id)
                    expected_ids.add(log_id)

                print(f"classifier e2e: waiting {label} session {session_key}")
                rows = _wait_for_classification(session_key, expected_ids)
                _validate_rows(rows, label=label, require_task=False, forbid_task=True)
                for rid, row in rows.items():
                    if str((row or {}).get("topicId") or "") != topic_id:
                        fail(f"{label}: log {rid} expected topic {topic_id}, got {(row or {}).get('topicId')}")
                    if str((row or {}).get("taskId") or ""):
                        fail(f"{label}: log {rid} expected no taskId, got {(row or {}).get('taskId')}")

                extra_sessions.append(session_key)
                continue

            if str(scenario.get("mode") or "") == "board-task-fixed-scope":
                # Board Task Chat pins both topic + task; classifier must not reroute.
                topic_id = _create_topic(f"Board Task Fixed Z{run_token}")
                task_id = _create_task(topic_id, f"Ship portal hotfix Z{run_token}")
                explicit_topic_ids.add(topic_id)
                explicit_task_ids.add(task_id)
                session_key = f"clawboard:task:{topic_id}:{task_id}"

                steps: list[tuple[str, str, str, str]] = [
                    ("conversation", "user", "User", "Update: also fix the copy on the login form."),
                    ("conversation", "user", "User", "/new"),
                    ("action", "assistant", "Assistant", "Tool call: memory_search login copy"),
                    ("system", "system", "System", "System: heartbeat"),
                ]

                expected_ids: set[str] = set()
                ids_by_step: list[tuple[str, str]] = []
                for idx, (kind, agent_id, agent_label, content) in enumerate(steps):
                    message_id = f"classifier-e2e:{label}:{idx}:{run_token.lower()}"
                    created_at = f"{CREATED_AT_BASE}:{scenario_idx:02d}:{idx:02d}.000Z"
                    if kind == "conversation":
                        log_id = _append_conversation(
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                    elif kind == "action":
                        log_id = _append_action(
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                    else:
                        log_id = _append_log(
                            kind,
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                    created_log_ids.append(log_id)
                    expected_ids.add(log_id)
                    ids_by_step.append((kind, log_id))

                print(f"classifier e2e: waiting {label} session {session_key}")
                rows = _wait_for_classification(session_key, expected_ids)

                for rid, row in rows.items():
                    if str(row.get("topicId") or "") != topic_id:
                        fail(f"{label}: log {rid} expected topic {topic_id}, got {row.get('topicId')}")
                    if str(row.get("taskId") or "") != task_id:
                        fail(f"{label}: log {rid} expected task {task_id}, got {row.get('taskId')}")

                for kind, rid in ids_by_step:
                    row = rows.get(rid) or {}
                    if kind == "action":
                        _assert_log_state(
                            row,
                            label=f"{label}:memory-action",
                            expected_status="classified",
                            expected_error="filtered_memory_action",
                            expect_topic=True,
                        )
                    elif kind == "system":
                        _assert_log_state(
                            row,
                            label=f"{label}:system",
                            expected_status="classified",
                            expected_error="filtered_non_semantic",
                            expect_topic=True,
                        )
                    else:
                        _assert_log_state(
                            row,
                            label=f"{label}:{kind}",
                            expected_status="classified",
                            expect_topic=True,
                        )

                extra_sessions.append(session_key)
                continue

            if str(scenario.get("mode") or "") == "filtering-mixed":
                # Mixed logs in one scope should not strand anything in pending.
                steps: list[tuple[str, str, str, str]] = [
                    ("conversation", "user", "User", f"Filtering Mixed Z{run_token}: explain idempotency keys for message ingestion."),
                    ("conversation", "assistant", "Assistant", "Use X-Idempotency-Key, and fall back to source.messageId per channel."),
                    ("conversation", "user", "User", "/new"),
                    ("conversation", "assistant", "Assistant", "{\"window\":[],\"topic\":null,\"task\":null}"),
                    ("conversation", "assistant", "Assistant", "[clawboard_context_begin]x[clawboard_context_end]"),
                    ("action", "assistant", "Assistant", "Tool call: memory_search idempotency"),
                    ("import", "system", "System", "Import: seeded initial fixtures"),
                ]

                expected_ids: set[str] = set()
                ids: dict[str, list[str]] = {"command": [], "noise": [], "memory": [], "import": [], "semantic": []}
                for idx, (kind, agent_id, agent_label, content) in enumerate(steps):
                    message_id = f"classifier-e2e:{label}:{idx}:{run_token.lower()}"
                    created_at = f"{CREATED_AT_BASE}:{scenario_idx:02d}:{idx:02d}.000Z"
                    if kind == "conversation":
                        log_id = _append_conversation(
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                        if content.strip() == "/new":
                            ids["command"].append(log_id)
                        elif content.strip().startswith("{") or "clawboard_context_begin" in content:
                            ids["noise"].append(log_id)
                        else:
                            ids["semantic"].append(log_id)
                    elif kind == "action":
                        log_id = _append_action(
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                        ids["memory"].append(log_id)
                    else:
                        log_id = _append_log(
                            kind,
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                        if kind == "import":
                            ids["import"].append(log_id)
                    created_log_ids.append(log_id)
                    expected_ids.add(log_id)

                print(f"classifier e2e: waiting {label} session {session_key}")
                rows = _wait_for_classification(session_key, expected_ids)

                for rid in ids["semantic"]:
                    row = rows.get(rid) or {}
                    _assert_log_state(row, label=f"{label}:semantic", expected_status="classified", expect_topic=True)
                    summary = str((row or {}).get("summary") or "").strip()
                    if not summary:
                        fail(f"{label}: semantic log {rid} missing summary")
                    if len(summary) > 56:
                        fail(f"{label}: semantic log {rid} summary too long ({len(summary)} > 56)")

                for rid in ids["command"]:
                    _assert_log_state(
                        rows.get(rid) or {},
                        label=f"{label}:command",
                        expected_status="classified",
                        expected_error="filtered_command",
                        expect_topic=False,
                    )

                for rid in ids["noise"]:
                    row = rows.get(rid) or {}
                    err = str((row or {}).get("classificationError") or "")
                    if err not in {"classifier_payload_noise", "context_injection_noise"}:
                        fail(f"{label}: noise log {rid} expected noise error, got {err!r}")
                    _assert_log_state(row, label=f"{label}:noise", expected_status="failed", expect_topic=False)

                for rid in ids["memory"]:
                    _assert_log_state(
                        rows.get(rid) or {},
                        label=f"{label}:memory",
                        expected_status="classified",
                        expected_error="filtered_memory_action",
                        expect_topic=False,
                    )

                for rid in ids["import"]:
                    _assert_log_state(
                        rows.get(rid) or {},
                        label=f"{label}:import",
                        expected_status="classified",
                        expected_error="filtered_non_semantic",
                        expect_topic=False,
                    )

                extra_sessions.append(session_key)
                continue

            if str(scenario.get("mode") or "") == "assistant-contamination":
                # Regression test: topic selection should anchor on user intent, not assistant
                # disclaimers (e.g. "Auth/permissions") that can otherwise cause false-positive
                # reuse of an existing "Auth" topic.
                nimbus_name = f"E2E Nimbus Auth Z{run_token}"
                nimbus_id = _create_topic(nimbus_name)
                explicit_topic_ids.add(nimbus_id)

                steps = [
                    (
                        "conversation",
                        "user",
                        "User",
                        "GraphQL caching: what's a good invalidation strategy for Apollo Federation subgraphs with nested resolvers?",
                    ),
                    (
                        "conversation",
                        "assistant",
                        "Assistant",
                        (
                            "In Apollo Federation, cache at the entity/field level. "
                            "Auth/permissions: don't leak cached data across viewers."
                        ),
                    ),
                ]

                expected_ids: set[str] = set()
                for idx, (_kind, agent_id, agent_label, content) in enumerate(steps):
                    message_id = f"classifier-e2e:{label}:{idx}:{run_token.lower()}"
                    created_at = f"{CREATED_AT_BASE}:{scenario_idx:02d}:{idx:02d}.000Z"
                    log_id = _append_conversation(
                        session_key,
                        agent_id,
                        agent_label,
                        content,
                        message_id=message_id,
                        created_at=created_at,
                    )
                    created_log_ids.append(log_id)
                    expected_ids.add(log_id)

                print(f"classifier e2e: waiting {label} session {session_key}")
                rows = _wait_for_classification(session_key, expected_ids)
                _validate_rows(rows, label=label, require_task=False, forbid_task=True)
                topic_id = str(next(iter({str((row or {}).get('topicId') or '') for row in rows.values()})))
                if topic_id == nimbus_id:
                    fail(f"{label}: incorrectly reused auth topic {nimbus_id} for GraphQL caching bundle")
                extra_sessions.append(session_key)
                continue

            if str(scenario.get("mode") or "") == "multi-bundle":
                # Make these unique without relying on hash-like suffixes that the classifier is
                # explicitly trained to strip from durable topic names.
                topic_a_name = f"E2E SQLModel Z{run_token}"
                topic_b_name = f"E2E Docker Z{run_token}"
                topic_a_id = _create_topic(topic_a_name)
                topic_b_id = _create_topic(topic_b_name)
                explicit_topic_ids |= {topic_a_id, topic_b_id}

                steps = [
                    ("conversation", "user", "User", f"Quick question about {topic_a_name}: how do SQLModel inserts work?"),
                    ("action", "assistant", "Assistant", "Tool call: web.search SQLModel insert docs"),
                    ("conversation", "assistant", "Assistant", "SQLModel inserts use session.add() then commit()."),
                    ("conversation", "user", "User", f"New thread: {topic_b_name} can't reach the api container. What should I check?"),
                    ("action", "assistant", "Assistant", "Tool call: web.search docker DNS issue"),
                    ("conversation", "assistant", "Assistant", "Check network, DNS, and service names."),
                ]

                expected_ids: set[str] = set()
                ids_in_order: list[str] = []
                for idx, (kind, agent_id, agent_label, content) in enumerate(steps):
                    message_id = f"classifier-e2e:{label}:{idx}:{run_token.lower()}"
                    created_at = f"{CREATED_AT_BASE}:{scenario_idx:02d}:{idx:02d}.000Z"
                    if kind == "conversation":
                        log_id = _append_conversation(
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                    else:
                        log_id = _append_action(
                            session_key,
                            agent_id,
                            agent_label,
                            content,
                            message_id=message_id,
                            created_at=created_at,
                        )
                    created_log_ids.append(log_id)
                    expected_ids.add(log_id)
                    ids_in_order.append(log_id)

                print(f"classifier e2e: waiting {label} session {session_key}")
                rows = _wait_for_classification(session_key, expected_ids)
                if set(rows.keys()) != expected_ids:
                    fail(f"{label}: missing rows; expected={len(expected_ids)} got={len(rows)}")

                first_bundle_ids = set(ids_in_order[:3])
                second_bundle_ids = set(ids_in_order[3:])
                for rid in sorted(first_bundle_ids):
                    row = rows.get(rid) or {}
                    if str(row.get("classificationStatus") or "pending") != "classified":
                        fail(f"{label}: log {rid} not classified")
                    if str(row.get("topicId") or "") != topic_a_id:
                        fail(f"{label}: log {rid} expected topic {topic_a_id}, got {row.get('topicId')}")
                    if str(row.get("taskId") or ""):
                        fail(f"{label}: log {rid} unexpectedly has taskId={row.get('taskId')}")

                for rid in sorted(second_bundle_ids):
                    row = rows.get(rid) or {}
                    if str(row.get("classificationStatus") or "pending") != "classified":
                        fail(f"{label}: log {rid} not classified")
                    if str(row.get("topicId") or "") != topic_b_id:
                        fail(f"{label}: log {rid} expected topic {topic_b_id}, got {row.get('topicId')}")
                    if str(row.get("taskId") or ""):
                        fail(f"{label}: log {rid} unexpectedly has taskId={row.get('taskId')}")

                extra_sessions.append(session_key)
                continue

            fixture = str(scenario["fixture"])
            window = _load_fixture_window(fixture)

            expected_ids: set[str] = set()
            for idx, entry in enumerate(window):
                agent_id = str(entry.get("agentId") or "user")
                agent_label = "User" if agent_id.lower() == "user" else "Assistant"
                content = str(entry.get("content") or "")
                content = _inject_nimbus_token(content, token=scenario.get("nimbusToken"))
                if label == "small-talk" and agent_id.lower() == "user" and idx == 0:
                    # Make this session uniquely identifiable without changing "small talk" intent.
                    content = f"{content} [LATTE_CHAT_{run_token}]"
                message_id = f"classifier-e2e:{label}:{idx}:{run_token.lower()}"
                created_at = f"{CREATED_AT_BASE}:{scenario_idx:02d}:{idx:02d}.000Z"
                log_id = _append_conversation(
                    session_key,
                    agent_id,
                    agent_label,
                    content,
                    message_id=message_id,
                    created_at=created_at,
                )
                created_log_ids.append(log_id)
                expected_ids.add(log_id)

            print(f"classifier e2e: waiting {label} session {session_key}")
            rows = _wait_for_classification(session_key, expected_ids)
            task_ids = _validate_rows(
                rows,
                label=label,
                require_task=bool(scenario["requireTask"]),
                forbid_task=bool(scenario["forbidTask"]),
            )
            topic_id = str(next(iter({str((row or {}).get("topicId") or "") for row in rows.values()})))

            scenario_results.append(
                {
                    "label": label,
                    "sessionKey": session_key,
                    "topicId": topic_id,
                    "taskIds": sorted(task_ids),
                    "validateTopic": bool(scenario["validateTopic"]),
                    "validateTasks": bool(scenario["validateTasks"]),
                }
            )

        topics = _api_request("GET", "/api/topics") or []
        topics_by_id = {str((item or {}).get("id") or ""): item for item in topics if (item or {}).get("id")}

        tasks = _api_request("GET", "/api/tasks") or []
        tasks_by_id = {str((item or {}).get("id") or ""): item for item in tasks if (item or {}).get("id")}

        for result in scenario_results:
            topic_id = str(result["topicId"])
            if result.get("validateTopic"):
                topic = topics_by_id.get(topic_id)
                if not topic:
                    fail(f"topic lookup failed for topicId={topic_id}")
                _assert_topic_name_quality(str((topic or {}).get("name") or ""), label=f"topic:{topic_id}")

            if result.get("validateTasks"):
                for task_id in result.get("taskIds") or []:
                    task = tasks_by_id.get(str(task_id))
                    if not task:
                        fail(f"task lookup failed for taskId={task_id}")
                    _assert_task_title_quality(str((task or {}).get("title") or ""), label=f"task:{task_id}")

        print("classifier e2e checks passed")
        for result in scenario_results:
            print(f"{result['label']}_session={result['sessionKey']}")
        for session_key in extra_sessions:
            print(f"extra_session={session_key}")
        return 0
    finally:
        if cleanup_enabled:
            # Always remove logs created by this run.
            for log_id in created_log_ids:
                try:
                    _api_request("DELETE", f"/api/log/{log_id}")
                except Exception:
                    pass

            # Remove any fixtures created explicitly by this harness.
            for task_id in sorted(explicit_task_ids):
                try:
                    _api_request("DELETE", f"/api/tasks/{task_id}")
                except Exception:
                    pass

            for topic_id in sorted(explicit_topic_ids):
                try:
                    _api_request("DELETE", f"/api/topics/{topic_id}")
                except Exception:
                    pass

            # Best-effort cleanup for any topics/tasks created during this run that include the run token.
            # This prevents long-lived test data from accumulating in a dev DB.
            try:
                token_marker = f"Z{run_token}"
                topics = _api_request("GET", "/api/topics") or []
                tasks = _api_request("GET", "/api/tasks") or []

                token_task_ids = [
                    str((t or {}).get("id") or "")
                    for t in tasks
                    if token_marker in str((t or {}).get("title") or "")
                ]
                token_topic_ids = [
                    str((t or {}).get("id") or "")
                    for t in topics
                    if token_marker in str((t or {}).get("name") or "")
                ]

                for task_id in sorted({tid for tid in token_task_ids if tid}):
                    try:
                        _api_request("DELETE", f"/api/tasks/{task_id}")
                    except Exception:
                        pass

                for topic_id in sorted({tid for tid in token_topic_ids if tid}):
                    try:
                        _api_request("DELETE", f"/api/topics/{topic_id}")
                    except Exception:
                        pass
            except Exception:
                pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"classifier e2e check failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
