from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import or_, text
from sqlalchemy.orm import defer
from sqlmodel import select


def build_context_response(
    main_module: Any,
    *,
    q: str | None,
    session_key: str | None,
    space_id: str | None,
    allowed_space_ids_raw: str | None,
    mode: str,
    include_pending: bool,
    max_chars: int,
    working_set_limit: int,
    timeline_limit: int,
) -> dict[str, Any]:
    raw_query_input = main_module._coerce_safe_text(q or "")
    raw_query = main_module._sanitize_log_text(raw_query_input)
    completion_event = main_module._parse_internal_task_completion_event(raw_query_input)
    normalized_query = (
        main_module._internal_task_completion_intent_label(completion_event)
        if completion_event
        else main_module._clip(raw_query, 500)
    )
    requested_mode = (mode or "auto").strip().lower()
    effective_mode = requested_mode if requested_mode in {"auto", "cheap", "full", "patient"} else "auto"

    low_signal = (
        bool(completion_event)
        or main_module._is_affirmation(normalized_query)
        or normalized_query.strip().startswith("/")
        or main_module._is_low_signal_context_query(normalized_query)
    )
    board_topic_hint_id = main_module._parse_board_session_key(session_key or "")
    board_session_hint = bool(board_topic_hint_id)
    if completion_event:
        run_semantic = False
    elif effective_mode in {"full", "patient"}:
        run_semantic = True
    elif effective_mode == "cheap":
        run_semantic = False
    else:
        run_semantic = ((not low_signal) and main_module._query_has_signal(normalized_query)) or (
            low_signal and board_session_hint and bool(normalized_query.strip())
        )

    now_dt = datetime.now(timezone.utc)
    data: dict[str, Any] = {}
    layers: list[str] = []
    lines: list[str] = []

    lines.append("ClawBoard context (layered):")
    if normalized_query:
        lines.append(f"Current user intent: {main_module._clip(normalized_query, 180)}")
    if completion_event:
        remaining_active_subagents = 0
        try:
            remaining_active_subagents = max(
                0,
                int(str(completion_event.get("active_subagent_runs") or "0").strip() or "0"),
            )
        except Exception:
            remaining_active_subagents = 0
        completion_task = main_module._sanitize_log_text(completion_event.get("task"))
        data["turnHint"] = {
            "kind": "delegated_completion",
            "task": completion_task or None,
            "status": main_module._sanitize_log_text(completion_event.get("status")) or None,
            "source": main_module._sanitize_log_text(completion_event.get("source")) or None,
            "resultPreview": main_module._sanitize_log_text(completion_event.get("result_preview")) or None,
            "remainingActiveSubagentRuns": remaining_active_subagents or None,
        }
        layers.append("A:turn_hint")
        lines.append("Turn hint:")
        lines.append(
            f"- Delegated specialist just completed{f': {completion_task}' if completion_task else ' in the current task'}."
        )
        lines.append("- Read the current topic thread before replying.")
        lines.append("- If the specialist result is already visible there, do not repeat or paraphrase the full body.")
        if remaining_active_subagents > 0:
            lines.append(
                f"- {remaining_active_subagents} sibling delegated run(s) are still active in this workflow/session."
            )
            lines.append(
                "- Keep this completion internal until the remaining related runs finish unless a user decision is needed or more than 5 minutes have passed since the last visible update."
            )
            lines.append(
                "- Do not send a user-facing message that only says you are checking, waiting on, or confirming other specialists."
            )
            lines.append(
                "- If you need confirmation, use session_status(...) as internal supervision rather than another status post."
            )
        lines.append(
            "- Close the loop by validating the work, adding only the delta or caveats, and stating whether the request is satisfied."
        )
    if effective_mode != "auto":
        lines.append(f"Mode: {effective_mode}")

    with main_module.get_session() as session:
        resolved_source_space_id = main_module._resolve_source_space_id(
            session,
            explicit_space_id=space_id,
            session_key=session_key,
        )
        allowed_space_ids = main_module._resolve_allowed_space_ids(
            session,
            source_space_id=resolved_source_space_id,
            allowed_space_ids_raw=allowed_space_ids_raw,
        )

        routing_items: list[dict[str, Any]] = []
        routing_row: Any = None
        if session_key:
            row = session.get(main_module.SessionRoutingMemory, session_key)
            if not row and "|" in session_key:
                row = session.get(main_module.SessionRoutingMemory, session_key.split("|", 1)[0])
            if row and isinstance(getattr(row, "items", None), list):
                routing_row = row
                routing_items = list(row.items or [])[-6:]

        timeline: list[dict[str, Any]] = []
        timeline_label = "Recent session timeline:"
        timeline_scope = "session"
        if timeline_limit > 0 and (session_key or board_topic_hint_id):
            query_logs = select(main_module.LogEntry).options(defer(main_module.LogEntry.raw))
            if board_topic_hint_id:
                timeline_scope = "topic_thread"
                timeline_label = "Recent current topic thread:"
                query_logs = query_logs.where(main_module.LogEntry.topicId == board_topic_hint_id)
            else:
                base_key = (session_key.split("|", 1)[0] or "").strip()
                if not base_key:
                    query_logs = None
                elif main_module.DATABASE_URL.startswith("sqlite"):
                    query_logs = query_logs.where(
                        text(
                            "(json_extract(source, '$.sessionKey') = :base_key OR json_extract(source, '$.sessionKey') LIKE :like_key)"
                        )
                    ).params(base_key=base_key, like_key=f"{base_key}|%")
                else:
                    expr = main_module.LogEntry.source["sessionKey"].as_string()
                    query_logs = query_logs.where(or_(expr == base_key, expr.like(f"{base_key}|%")))
            if query_logs is not None:
                query_logs = query_logs.where(main_module.LogEntry.type == "conversation").order_by(
                    main_module.LogEntry.createdAt.desc(),
                    (
                        text("rowid DESC")
                        if main_module.DATABASE_URL.startswith("sqlite")
                        else main_module.LogEntry.id.desc()
                    ),
                ).limit(max(20, timeline_limit * 5))
                rows = session.exec(query_logs).all()
                if allowed_space_ids is not None:
                    topic_by_id_for_timeline = main_module._load_related_maps_for_logs(session, rows)
                    rows = [
                        entry
                        for entry in rows
                        if main_module._log_matches_allowed_spaces(
                            entry,
                            allowed_space_ids,
                            topic_by_id_for_timeline,
                        )
                    ]
                for entry in rows:
                    if main_module._is_command_log(entry):
                        continue
                    summary = main_module._sanitize_log_text(entry.summary or "") or main_module._clip(
                        main_module._sanitize_log_text(entry.content or ""),
                        220,
                    )
                    who = (
                        "User"
                        if str(entry.agentId or "").strip().lower() == "user"
                        else (entry.agentLabel or entry.agentId or "Agent")
                    )
                    source_map = entry.source if isinstance(entry.source, dict) else {}
                    timeline.append(
                        {
                            "id": entry.id,
                            "topicId": entry.topicId,
                            "agentId": entry.agentId,
                            "agentLabel": entry.agentLabel,
                            "sessionKey": str(source_map.get("sessionKey") or "").strip() or None,
                            "createdAt": entry.createdAt,
                            "text": main_module._clip(f"{who}: {summary}", 160),
                        }
                    )
                    if len(timeline) >= timeline_limit:
                        break
                if timeline:
                    data["timeline"] = timeline
                    data["timelineScope"] = timeline_scope
                    layers.append("A:timeline")

        all_topics = session.exec(select(main_module.Topic)).all()
        all_topic_by_id = {
            str(getattr(topic, "id", "") or ""): topic
            for topic in all_topics
            if getattr(topic, "id", None)
        }
        topics = (
            [topic for topic in all_topics if main_module._topic_matches_allowed_spaces(topic, allowed_space_ids)]
            if allowed_space_ids is not None
            else all_topics
        )
        topic_by_id = {topic.id: topic for topic in topics}

        if routing_items and allowed_space_ids is not None:
            filtered_routing_items: list[dict[str, Any]] = []
            for item in routing_items:
                topic_id_hint = str(item.get("topicId") or "").strip()
                allowed = False
                if topic_id_hint:
                    candidate_topic = all_topic_by_id.get(topic_id_hint)
                    if candidate_topic and main_module._topic_matches_allowed_spaces(
                        candidate_topic,
                        allowed_space_ids,
                    ):
                        allowed = True
                if not topic_id_hint:
                    allowed = True
                if allowed:
                    filtered_routing_items.append(item)
            routing_items = filtered_routing_items

        if routing_items:
            data["routingMemory"] = {
                "sessionKey": str(getattr(routing_row, "sessionKey", "") or session_key or ""),
                "items": routing_items,
                "createdAt": getattr(routing_row, "createdAt", None),
                "updatedAt": getattr(routing_row, "updatedAt", None),
            }
            layers.append("A:routing_memory")

        visible_topics = [topic for topic in topics if main_module._topic_visible(topic, now_dt)]
        visible_topics.sort(key=main_module._topic_order_key)
        working_topics = visible_topics[: max(0, min(12, working_set_limit))]

        board_topic_id = main_module._parse_board_session_key(session_key or "")
        board_topic = topic_by_id.get(board_topic_id) if board_topic_id else None
        if board_topic:
            data["boardSession"] = {
                "kind": "topic",
                "topicId": board_topic.id,
                "topicName": board_topic.name,
            }
            layers.append("A:board_session")
            status = str(getattr(board_topic, "status", "") or "").strip()
            suffix = f" [{status}]" if status else ""
            lines.append("Active board location:")
            lines.append(f"- Topic Chat: {board_topic.name}{suffix}")
            working_topics = [board_topic, *[topic for topic in working_topics if topic.id != board_topic.id]]

        orchestration_runs = main_module._orchestration_context_snapshot(session, session_key=session_key, limit=3)
        if orchestration_runs:
            data["orchestration"] = {"runs": orchestration_runs}
            layers.append("A:orchestration")
            lines.append("Active orchestration runs:")
            for run in orchestration_runs:
                mode_label = str(run.get("mode") or "single")
                status_label = str(run.get("status") or "running")
                terminal = int(run.get("itemsTerminal") or 0)
                total = int(run.get("itemsTotal") or 0)
                request_id = str(run.get("requestId") or "")
                convergence = run.get("convergence") if isinstance(run.get("convergence"), dict) else {}
                gate_ready = bool(convergence.get("ready"))
                gate_reason = str(convergence.get("reason") or "").strip().lower()
                gate_label = "ready" if gate_ready else (f"waiting:{gate_reason}" if gate_reason else "waiting")
                lines.append(
                    f"- {status_label} [{mode_label}] {terminal}/{total} items | gate {gate_label} | request {request_id}"
                )
            if completion_event:
                related_active_subagents = 0
                for run in orchestration_runs:
                    for item in run.get("items") or []:
                        if str(item.get("kind") or "").strip().lower() != "subagent":
                            continue
                        if (
                            str(item.get("status") or "").strip().lower()
                            in main_module._ORCHESTRATION_TERMINAL_ITEM_STATUSES
                        ):
                            continue
                        related_active_subagents += 1
                if related_active_subagents > 0:
                    turn_hint = data.get("turnHint") if isinstance(data.get("turnHint"), dict) else {}
                    turn_hint["remainingActiveSubagentRuns"] = related_active_subagents
                    data["turnHint"] = turn_hint
                    lines.append("Delegation handling:")
                    lines.append(
                        f"- {related_active_subagents} sibling delegated run(s) are still active in this topic/workflow."
                    )
                    lines.append(
                        "- Treat this completion as internal supervision unless a real blocker or decision needs to be surfaced now."
                    )
                    lines.append(
                        "- Do not narrate routine bookkeeping like 'checking on the others' or 'awaiting the rest' back to the user."
                    )

        continuity_topic_ids: list[str] = []
        for item in routing_items[-4:]:
            tid = str(item.get("topicId") or "").strip()
            if tid:
                continuity_topic_ids.append(tid)
        for item in timeline[: max(0, min(12, timeline_limit * 2))]:
            tid = str(item.get("topicId") or "").strip()
            if tid:
                continuity_topic_ids.append(tid)

        seen_topic_ids = {topic.id for topic in working_topics}
        for tid in continuity_topic_ids:
            if len(working_topics) >= max(0, min(12, working_set_limit)):
                break
            topic = topic_by_id.get(tid)
            if topic and main_module._topic_visible(topic, now_dt) and tid not in seen_topic_ids:
                working_topics.append(topic)
                seen_topic_ids.add(tid)

        data["workingSet"] = {
            "topics": [topic.model_dump() for topic in working_topics[:working_set_limit]],
        }
        layers.append("A:working_set")

        if working_topics:
            lines.append("Working set topics:")
            for topic in working_topics[:working_set_limit]:
                digest = main_module._sanitize_log_text(getattr(topic, "digest", None))
                suffix = f" | digest: {main_module._clip(digest, 140)}" if digest else ""
                lines.append(f"- {topic.name}{suffix}")

        if routing_items:
            lines.append("Session routing memory (newest last):")
            for item in routing_items[-4:]:
                topic_name = str(item.get("topicName") or item.get("topicId") or "").strip()
                anchor = str(item.get("anchor") or "").strip()
                if anchor:
                    lines.append(
                        f"- {topic_name} | anchor: {main_module._clip(main_module._sanitize_log_text(anchor), 120)}"
                    )
                else:
                    lines.append(f"- {topic_name}")

        if timeline:
            lines.append(timeline_label)
            for item in timeline[:timeline_limit]:
                lines.append(f"- {item['text']}")

        semantic = None
        if run_semantic and normalized_query:
            limit_topics = 8
            limit_logs = max(24, timeline_limit * 6)
            if effective_mode == "patient":
                limit_topics = 12
                limit_logs = max(60, timeline_limit * 10)
            semantic = main_module._search_impl(
                session,
                normalized_query,
                topic_id=None,
                allowed_space_ids=allowed_space_ids,
                session_key=session_key,
                include_pending=include_pending,
                limit_topics=limit_topics,
                limit_logs=limit_logs,
                allow_deep_content_scan=False,
            )
            data["semantic"] = semantic
            layers.append("B:semantic")

        if semantic:
            topics_hit_limit = 3
            logs_hit_limit = 6
            if effective_mode == "patient":
                topics_hit_limit = 5
                logs_hit_limit = 12

            topics_hit = list(semantic.get("topics") or [])[:topics_hit_limit]
            logs_hit = list(semantic.get("logs") or [])[:logs_hit_limit]

            if topics_hit:
                lines.append("Semantic recall topics:")
                for item in topics_hit:
                    name = str(item.get("name") or item.get("id") or "").strip()
                    score = item.get("score")
                    lines.append(f"- {name} (score {score})")
            if logs_hit:
                lines.append("Semantic recall logs:")
                for item in logs_hit:
                    who = (
                        "User"
                        if str(item.get("agentId") or "").strip().lower() == "user"
                        else (item.get("agentLabel") or item.get("agentId") or "Agent")
                    )
                    text2 = main_module._sanitize_log_text(str(item.get("summary") or item.get("content") or ""))
                    lines.append(f"- {who}: {main_module._clip(text2, 140)}")

    block = main_module._clip("\n".join(lines).strip(), max_chars)
    return {
        "ok": True,
        "sessionKey": session_key,
        "q": normalized_query,
        "mode": effective_mode,
        "layers": layers,
        "block": block,
        "data": data,
    }
