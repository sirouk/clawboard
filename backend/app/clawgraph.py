from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Tuple


STOP_WORDS = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "about",
    "where",
    "what",
    "when",
    "have",
    "has",
    "been",
    "were",
    "is",
    "are",
    "to",
    "of",
    "on",
    "in",
    "a",
    "an",
    "user",
    "assistant",
    "system",
    "summary",
    "channel",
    "session",
    "message",
    "messages",
    "agent",
}

SLASH_COMMANDS = {
    "/new",
    "/topic",
    "/topics",
    "/task",
    "/tasks",
    "/log",
    "/logs",
    "/board",
    "/graph",
    "/help",
    "/reset",
    "/clear",
}

ENTITY_NOISE_TOKENS = {
    "ok",
    "okay",
    "yeah",
    "yes",
    "hey",
    "so",
    "please",
    "pls",
    "thanks",
    "thx",
}

ENTITY_BLOCKLIST = {
    "EST",
    "UTC",
    "Fri",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Sat",
    "Sun",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
}

ENTITY_ALIAS_MAP = {
    "open claw": "openclaw",
    "open-claw": "openclaw",
    "claw board": "clawboard",
    "claw-board": "clawboard",
    "open clawboard": "clawboard",
    "open-clawboard": "clawboard",
}

ENTITY_TYPE_PRIORITY = {
    "url": 6,
    "file": 5,
    "command": 4,
    "org": 3,
    "project": 2,
    "person": 1,
}

ENTITY_TYPE_WEIGHT = {
    "url": 0.72,
    "file": 0.8,
    "command": 0.86,
    "org": 0.94,
    "project": 1.0,
    "person": 0.9,
}

TOPIC_COLOR = "#ff8a4a"
TASK_COLOR = "#4ea1ff"
ENTITY_COLOR = "#45c4a0"
AGENT_COLOR = "#f2c84b"


@dataclass
class NodeBuild:
    id: str
    label: str
    kind: str
    score: float = 0.0
    size: float = 10.0
    meta: Dict[str, Any] | None = None


@dataclass(frozen=True)
class EntityHit:
    label: str
    key: str
    entity_type: str
    base_weight: float


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return cleaned or "node"


def _normalize_text(value: str) -> str:
    text = (value or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(?im)^\s*summary\s*[:\-]\s*", "", text)
    text = re.sub(r"(?im)^\[Discord [^\]]+\]\s*", "", text)
    text = re.sub(r"(?i)\[message[_\s-]?id:[^\]]+\]", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _is_tool_call_log(row: Any) -> bool:
    log_type = str(getattr(row, "type", "") or "")
    if log_type != "action":
        return False
    combined = " ".join(
        part
        for part in [
            str(getattr(row, "summary", "") or ""),
            str(getattr(row, "content", "") or ""),
            str(getattr(row, "raw", "") or ""),
        ]
        if part
    ).lower()
    return "tool call:" in combined or "tool result:" in combined or "tool error:" in combined


def _is_command_log(row: Any) -> bool:
    log_type = str(getattr(row, "type", "") or "")
    if log_type != "conversation":
        return False
    text = _normalize_text(str(getattr(row, "content", "") or getattr(row, "summary", "") or getattr(row, "raw", "") or ""))
    if not text.startswith("/"):
        return False
    command = text.split(None, 1)[0].lower()
    if command in SLASH_COMMANDS:
        return True
    return bool(re.fullmatch(r"/[a-z0-9_-]{2,}", command))


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        ts = datetime.fromisoformat(raw)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc)
    except Exception:
        return None


def _words(value: str) -> set[str]:
    normalized = re.sub(r"[^a-z0-9\s]+", " ", (value or "").lower())
    parts = [p.strip() for p in normalized.split(" ") if len(p.strip()) > 2]
    return {p for p in parts if p not in STOP_WORDS}


def _jaccard(a: str, b: str) -> float:
    wa = _words(a)
    wb = _words(b)
    if not wa or not wb:
        return 0.0
    inter = len(wa & wb)
    union = len(wa | wb)
    if union <= 0:
        return 0.0
    return inter / union


def _canonical_entity_key(text: str) -> str:
    normalized = _normalize_text(text).lower()
    normalized = normalized.strip("`*[](){}:;,.!?\"'")
    normalized = re.sub(r"[_\-]+", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized:
        return ""
    normalized = ENTITY_ALIAS_MAP.get(normalized, normalized)
    normalized = normalized.strip()
    parts = [part for part in normalized.split(" ") if part]
    while parts and parts[0] in ENTITY_NOISE_TOKENS:
        parts.pop(0)
    while parts and parts[-1] in ENTITY_NOISE_TOKENS:
        parts.pop()
    if not parts:
        return ""
    return " ".join(parts)


def _extract_entities(text: str) -> list[EntityHit]:
    source = _normalize_text(text)
    if not source:
        return []
    source = re.sub(r"\s+", " ", source)

    entities: list[tuple[str, str, float]] = []

    # URLs
    for match in re.finditer(r"\bhttps?://[^\s)\]>]+", source):
        token = match.group(0).strip("`*[](){}:;,.!?\"'")
        if len(token) >= 8:
            entities.append((token, "url", 1.12))

    # File paths (unix + relative file refs)
    for match in re.finditer(r"(?:\./|~/|/)[A-Za-z0-9._/\-]{3,}", source):
        token = match.group(0).strip("`*[](){}:;,.!?\"'")
        if len(token) >= 4:
            entities.append((token, "file", 1.03))
    for match in re.finditer(r"\b[A-Za-z0-9._/\-]+\.[A-Za-z0-9]{2,6}\b", source):
        token = match.group(0).strip("`*[](){}:;,.!?\"'")
        if "/" in token or "." in token:
            entities.append((token, "file", 0.94))

    # Commands and CLI snippets.
    for match in re.finditer(r"`([^`]{2,90})`", source):
        snippet = match.group(1).strip()
        if re.search(r"\b(openclaw|docker|npm|pnpm|curl|git|python|node|uvicorn|tailscale|sqlite3|pytest)\b", snippet, flags=re.IGNORECASE):
            entities.append((snippet, "command", 0.92))
    for match in re.finditer(r"\b(openclaw|docker|npm|pnpm|curl|git|python|node|uvicorn|tailscale|sqlite3|pytest)\b(?:\s+[A-Za-z0-9./:_-]+){0,4}", source, flags=re.IGNORECASE):
        snippet = match.group(0).strip()
        if len(snippet) >= 3:
            entities.append((snippet, "command", 0.84))

    # Handles/usernames.
    for match in re.finditer(r"@[A-Za-z0-9_]{3,32}", source):
        entities.append((match.group(0), "person", 0.88))

    # Uppercase tokens and acronyms.
    for match in re.finditer(r"\b[A-Z][A-Z0-9_-]{2,}\b", source):
        token = match.group(0).strip()
        if token in ENTITY_BLOCKLIST:
            continue
        entities.append((token, "org", 1.0))

    # CamelCase and TitleCase words.
    for match in re.finditer(r"\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+\b", source):
        token = match.group(0).strip()
        if len(token) >= 3:
            entities.append((token, "project", 0.94))

    # Single TitleCase entities ("Discord", "OpenClaw", "Tailscale").
    for match in re.finditer(r"\b[A-Z][a-z0-9]{2,}\b", source):
        token = match.group(0).strip()
        if token in ENTITY_BLOCKLIST:
            continue
        entities.append((token, "project", 0.8))

    # Multi-word named entities ("Open Claw", "Discord Bot", "Docker Desktop")
    for match in re.finditer(r"\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,2}\b", source):
        token = match.group(0).strip()
        if token in ENTITY_BLOCKLIST:
            continue
        if len(token) < 4:
            continue
        entity_type = "person" if len(token.split(" ")) == 2 else "org"
        entities.append((token, entity_type, 0.92))

    canonical: dict[str, EntityHit] = {}
    for raw_entity, entity_type, base_weight in entities:
        entity = raw_entity.strip("`*[](){}:;,.!?'\"")
        entity = re.sub(r"\s+", " ", entity).strip()
        if not entity:
            continue
        parts = [part for part in entity.split(" ") if part]
        while parts and parts[0].lower() in ENTITY_NOISE_TOKENS:
            parts.pop(0)
        while parts and parts[-1].lower() in ENTITY_NOISE_TOKENS:
            parts.pop()
        if not parts:
            continue
        entity = " ".join(parts).strip()
        key = _canonical_entity_key(entity)
        if not key:
            continue
        if key.upper() in ENTITY_BLOCKLIST:
            continue
        if key in STOP_WORDS:
            continue
        if len(entity) > 48:
            entity = entity[:48].rstrip()
            key = _canonical_entity_key(entity)
            if not key:
                continue
        if len(entity) < 3:
            continue
        existing = canonical.get(key)
        if not existing:
            canonical[key] = EntityHit(label=entity, key=key, entity_type=entity_type, base_weight=base_weight)
            continue
        existing_priority = ENTITY_TYPE_PRIORITY.get(existing.entity_type, 0)
        next_priority = ENTITY_TYPE_PRIORITY.get(entity_type, 0)
        chosen_type = entity_type if next_priority >= existing_priority else existing.entity_type
        chosen_weight = max(existing.base_weight, base_weight)
        chosen_label = entity if len(entity) >= len(existing.label) else existing.label
        canonical[key] = EntityHit(label=chosen_label, key=key, entity_type=chosen_type, base_weight=chosen_weight)
    return list(canonical.values())


def _edge_key(source: str, target: str, kind: str, undirected: bool = False) -> Tuple[str, str, str]:
    if not undirected:
        return source, target, kind
    if source <= target:
        return source, target, kind
    return target, source, kind


def _node_size(kind: str, score: float) -> float:
    base = {
        "topic": 20.0,
        "task": 15.0,
        "entity": 10.5,
        "agent": 11.5,
    }.get(kind, 10.0)
    boost = max(0.0, min(22.0, math.sqrt(max(score, 0.0)) * 2.4))
    return round(base + boost, 2)


def _node_color(kind: str) -> str:
    return {
        "topic": TOPIC_COLOR,
        "task": TASK_COLOR,
        "entity": ENTITY_COLOR,
        "agent": AGENT_COLOR,
    }.get(kind, "#aab7c4")


def _build_node(node: NodeBuild) -> Dict[str, Any]:
    return {
        "id": node.id,
        "label": node.label,
        "type": node.kind,
        "score": round(node.score, 4),
        "size": _node_size(node.kind, node.score),
        "color": _node_color(node.kind),
        "meta": node.meta or {},
    }


def build_clawgraph(
    topics: Iterable[Any],
    tasks: Iterable[Any],
    logs: Iterable[Any],
    *,
    max_entities: int = 120,
    max_nodes: int = 260,
    min_edge_weight: float = 0.16,
) -> Dict[str, Any]:
    topic_rows = list(topics)
    task_rows = list(tasks)
    log_rows = list(logs)

    nodes: Dict[str, NodeBuild] = {}
    edge_weights: Dict[Tuple[str, str, str], float] = defaultdict(float)
    edge_evidence: Dict[Tuple[str, str, str], int] = defaultdict(int)

    notes_by_related: Dict[str, List[str]] = defaultdict(list)
    for row in log_rows:
        log_type = str(getattr(row, "type", "") or "")
        if log_type != "note":
            continue
        related = str(getattr(row, "relatedLogId", "") or "").strip()
        if not related:
            continue
        content = str(getattr(row, "content", "") or getattr(row, "summary", "") or "").strip()
        if not content:
            continue
        if len(notes_by_related[related]) < 4:
            notes_by_related[related].append(_normalize_text(content)[:800])

    # Seed structural nodes first.
    for topic in topic_rows:
        topic_id = str(getattr(topic, "id", "") or "")
        if not topic_id:
            continue
        node_id = f"topic:{topic_id}"
        nodes[node_id] = NodeBuild(
            id=node_id,
            label=str(getattr(topic, "name", "") or topic_id),
            kind="topic",
            score=1.6 + (0.65 if bool(getattr(topic, "pinned", False)) else 0.0),
            meta={
                "topicId": topic_id,
                "description": getattr(topic, "description", None),
                "pinned": bool(getattr(topic, "pinned", False)),
            },
        )

    for task in task_rows:
        task_id = str(getattr(task, "id", "") or "")
        if not task_id:
            continue
        topic_id = str(getattr(task, "topicId", "") or "")
        node_id = f"task:{task_id}"
        status = str(getattr(task, "status", "") or "todo")
        status_boost = {"doing": 0.9, "blocked": 0.7, "todo": 0.45, "done": 0.1}.get(status, 0.3)
        nodes[node_id] = NodeBuild(
            id=node_id,
            label=str(getattr(task, "title", "") or task_id),
            kind="task",
            score=1.1 + status_boost + (0.45 if bool(getattr(task, "pinned", False)) else 0.0),
            meta={
                "taskId": task_id,
                "topicId": topic_id or None,
                "status": status,
                "pinned": bool(getattr(task, "pinned", False)),
            },
        )
        if topic_id and f"topic:{topic_id}" in nodes:
            key = _edge_key(f"topic:{topic_id}", node_id, "has_task")
            edge_weights[key] += 1.0 + status_boost * 0.25
            edge_evidence[key] += 1

    entity_score: Dict[str, float] = defaultdict(float)
    entity_label: Dict[str, str] = {}
    entity_type: Dict[str, str] = {}
    topic_entities: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    task_entities: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    agent_entities: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))

    created_values = [_parse_iso(getattr(row, "createdAt", None)) for row in log_rows]
    created_values = [value for value in created_values if value is not None]
    newest_ts = max(created_values) if created_values else None

    for row in log_rows:
        log_id = str(getattr(row, "id", "") or "")
        log_type = str(getattr(row, "type", "") or "")
        if log_type in ("note", "system", "import"):
            continue
        if _is_tool_call_log(row):
            continue
        if _is_command_log(row):
            continue

        summary = str(getattr(row, "summary", "") or "")
        content = str(getattr(row, "content", "") or "")
        raw = str(getattr(row, "raw", "") or "")
        attached_notes = notes_by_related.get(log_id, [])
        combined = "\n".join([summary, content, raw[:900], *attached_notes]).strip()
        entities = _extract_entities(combined)
        if not entities:
            continue

        topic_id = str(getattr(row, "topicId", "") or "")
        task_id = str(getattr(row, "taskId", "") or "")
        agent_label = str(getattr(row, "agentLabel", "") or getattr(row, "agentId", "") or "").strip()
        if agent_label:
            agent_node = f"agent:{_slug(agent_label)}"
            if agent_node not in nodes:
                nodes[agent_node] = NodeBuild(
                    id=agent_node,
                    label=agent_label[:38],
                    kind="agent",
                    score=0.9,
                    meta={"agentLabel": agent_label},
                )
            nodes[agent_node].score += 0.1

        base_weight = {
            "conversation": 1.0,
            "action": 0.72,
            "system": 0.55,
            "import": 0.45,
        }.get(log_type, 0.66)
        note_boost = 1.0 + min(0.8, len(attached_notes) * 0.2)
        created_at = _parse_iso(getattr(row, "createdAt", None))
        recency_boost = 1.0
        if newest_ts and created_at:
            age_hours = max(0.0, (newest_ts - created_at).total_seconds() / 3600.0)
            # Temporal signal: recent interactions retain stronger influence.
            recency_boost = 0.35 + (0.65 * math.exp(-age_hours / 96.0))
        weight = base_weight * note_boost * recency_boost

        entity_ids: List[str] = []
        for ent in entities:
            key = ent.key
            if not key:
                continue
            type_weight = ENTITY_TYPE_WEIGHT.get(ent.entity_type, 1.0)
            weighted = weight * ent.base_weight * type_weight
            entity_score[key] += weighted
            if key not in entity_label:
                entity_label[key] = ent.label
            else:
                # Prefer the longer title-cased label as canonical display text.
                if len(ent.label) > len(entity_label[key]):
                    entity_label[key] = ent.label
            if key not in entity_type:
                entity_type[key] = ent.entity_type
            else:
                current_priority = ENTITY_TYPE_PRIORITY.get(entity_type[key], 0)
                next_priority = ENTITY_TYPE_PRIORITY.get(ent.entity_type, 0)
                if next_priority >= current_priority:
                    entity_type[key] = ent.entity_type

            entity_id = f"entity:{_slug(key)}"
            entity_ids.append(entity_id)
            if topic_id:
                topic_entities[topic_id][entity_id] += weighted
            if task_id:
                task_entities[task_id][entity_id] += weighted
            if agent_label:
                agent_entities[agent_label][entity_id] += weighted * 0.85

        # Entity co-occurrence links.
        uniq_ids = sorted(set(entity_ids))
        for i in range(len(uniq_ids)):
            for j in range(i + 1, len(uniq_ids)):
                left = uniq_ids[i]
                right = uniq_ids[j]
                key = _edge_key(left, right, "co_occurs", undirected=True)
                edge_weights[key] += max(0.12, weight * 0.38)
                edge_evidence[key] += 1

    ranked_entities = sorted(entity_score.items(), key=lambda item: item[1], reverse=True)
    selected_entities = ranked_entities[: max(12, max_entities)]
    selected_entity_ids = {f"entity:{_slug(ent_key)}" for ent_key, _ in selected_entities}

    for ent_key, score in selected_entities:
        node_id = f"entity:{_slug(ent_key)}"
        label = entity_label.get(ent_key, ent_key)
        nodes[node_id] = NodeBuild(
            id=node_id,
            label=label,
            kind="entity",
            score=0.9 + score,
            meta={
                "entityKey": ent_key,
                "entityType": entity_type.get(ent_key, "project"),
                "mentions": round(score, 3),
            },
        )

    # Mentions edges to selected entities.
    for topic_id, ent_map in topic_entities.items():
        source = f"topic:{topic_id}"
        if source not in nodes:
            continue
        for ent_id, weight in ent_map.items():
            if ent_id not in selected_entity_ids:
                continue
            key = _edge_key(source, ent_id, "mentions")
            edge_weights[key] += weight
            edge_evidence[key] += 1
            nodes[source].score += weight * 0.05

    for task_id, ent_map in task_entities.items():
        source = f"task:{task_id}"
        if source not in nodes:
            continue
        for ent_id, weight in ent_map.items():
            if ent_id not in selected_entity_ids:
                continue
            key = _edge_key(source, ent_id, "mentions")
            edge_weights[key] += weight
            edge_evidence[key] += 1
            nodes[source].score += weight * 0.035

    for agent_label, ent_map in agent_entities.items():
        source = f"agent:{_slug(agent_label)}"
        if source not in nodes:
            continue
        for ent_id, weight in ent_map.items():
            if ent_id not in selected_entity_ids:
                continue
            key = _edge_key(source, ent_id, "agent_focus")
            edge_weights[key] += weight
            edge_evidence[key] += 1

    # Topic-topic relatedness based on shared entities + lexical overlap.
    topic_ids = [str(getattr(topic, "id", "") or "") for topic in topic_rows if getattr(topic, "id", None)]
    topic_name_map = {str(getattr(topic, "id", "")): str(getattr(topic, "name", "")) for topic in topic_rows}
    for i in range(len(topic_ids)):
        for j in range(i + 1, len(topic_ids)):
            left = topic_ids[i]
            right = topic_ids[j]
            left_map = topic_entities.get(left, {})
            right_map = topic_entities.get(right, {})
            shared_weight = 0.0
            for ent_id, lw in left_map.items():
                if ent_id in selected_entity_ids and ent_id in right_map:
                    shared_weight += min(lw, right_map[ent_id])
            lexical = _jaccard(topic_name_map.get(left, ""), topic_name_map.get(right, ""))
            score = shared_weight * 0.12 + lexical
            if score < 0.28:
                continue
            key = _edge_key(f"topic:{left}", f"topic:{right}", "related_topic", undirected=True)
            edge_weights[key] += score
            edge_evidence[key] += 1

    # Task-task relatedness inside same topic via shared entities.
    tasks_by_topic: Dict[str, List[str]] = defaultdict(list)
    for task in task_rows:
        tid = str(getattr(task, "id", "") or "")
        topic_id = str(getattr(task, "topicId", "") or "")
        if tid and topic_id:
            tasks_by_topic[topic_id].append(tid)
    for topic_id, task_ids in tasks_by_topic.items():
        for i in range(len(task_ids)):
            for j in range(i + 1, len(task_ids)):
                left = task_ids[i]
                right = task_ids[j]
                left_map = task_entities.get(left, {})
                right_map = task_entities.get(right, {})
                shared = 0.0
                for ent_id, lw in left_map.items():
                    if ent_id in selected_entity_ids and ent_id in right_map:
                        shared += min(lw, right_map[ent_id])
                if shared < 0.95:
                    continue
                key = _edge_key(f"task:{left}", f"task:{right}", "related_task", undirected=True)
                edge_weights[key] += shared * 0.11
                edge_evidence[key] += 1

    structural_nodes = {node_id for node_id, node in nodes.items() if node.kind in {"topic", "task", "agent"}}
    ranked_entity_nodes = [
        node_id
        for node_id, node in sorted(
            ((nid, n) for nid, n in nodes.items() if n.kind == "entity"),
            key=lambda item: item[1].score,
            reverse=True,
        )
    ]
    keep_entity_count = max(10, min(max_entities, max_nodes - len(structural_nodes)))
    kept_nodes = set(structural_nodes)
    kept_nodes.update(ranked_entity_nodes[:keep_entity_count])

    edge_list: List[Dict[str, Any]] = []
    for (source, target, kind), weight in sorted(edge_weights.items(), key=lambda item: item[1], reverse=True):
        if source not in kept_nodes or target not in kept_nodes:
            continue
        if weight < min_edge_weight and kind not in {"has_task"}:
            continue
        evidence = int(edge_evidence.get((source, target, kind), 1))
        edge_list.append(
            {
                "source": source,
                "target": target,
                "type": kind,
                "weight": round(float(weight), 4),
                "evidence": evidence,
            }
        )

    # Keep graph readable under heavy activity.
    edge_list = edge_list[:1200]

    used_nodes = set()
    for edge in edge_list:
        used_nodes.add(edge["source"])
        used_nodes.add(edge["target"])
    used_nodes.update(node_id for node_id in kept_nodes if node_id.startswith("topic:"))
    used_nodes.update(node_id for node_id in kept_nodes if node_id.startswith("task:"))

    node_list = []
    for node_id, node in sorted(nodes.items(), key=lambda item: (item[1].kind, -item[1].score, item[1].label)):
        if node_id not in used_nodes:
            continue
        node_list.append(_build_node(node))

    # Assign deterministic edge IDs after filtering.
    for idx, edge in enumerate(edge_list):
        edge["id"] = f"edge-{idx + 1}"

    topic_count = sum(1 for node in node_list if node["type"] == "topic")
    task_count = sum(1 for node in node_list if node["type"] == "task")
    entity_count = sum(1 for node in node_list if node["type"] == "entity")
    agent_count = sum(1 for node in node_list if node["type"] == "agent")
    density_base = max(1.0, len(node_list) * (len(node_list) - 1) / 2)
    density = min(1.0, len(edge_list) / density_base)

    return {
        "generatedAt": None,
        "stats": {
            "nodeCount": len(node_list),
            "edgeCount": len(edge_list),
            "topicCount": topic_count,
            "taskCount": task_count,
            "entityCount": entity_count,
            "agentCount": agent_count,
            "density": round(density, 4),
        },
        "nodes": node_list,
        "edges": edge_list,
    }
