from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session, select

from .db import engine
from .events import event_hub
from .models import ChangeEvent

MAX_REPLAY_EVENTS = max(100, int(os.getenv("CLAWBOARD_DURABLE_REPLAY_MAX", "5000") or "5000"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _event_identity(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    event_type = str(payload.get("type") or "").strip().lower()
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    entity_id = str((data or {}).get("id") or "").strip() or None
    if event_type.startswith("space."):
        return "space", entity_id
    if event_type.startswith("topic."):
        return "topic", entity_id
    if event_type.startswith("log."):
        return "log", entity_id
    if event_type.startswith("draft."):
        return "draft", str((data or {}).get("key") or "").strip() or entity_id
    if event_type.startswith("openclaw."):
        return "signal", str((data or {}).get("sessionKey") or "").strip() or None
    return None, entity_id


def publish_live_event(event: dict[str, Any], *, durable: bool = True) -> dict[str, Any]:
    payload = dict(event)
    event_ts = str(payload.get("eventTs") or "").strip() or _now_iso()
    payload["eventTs"] = event_ts
    if not durable:
        return event_hub.publish(payload)

    entity_kind, entity_id = _event_identity(payload)
    try:
        with Session(engine) as session:
            row = ChangeEvent(
                eventType=str(payload.get("type") or "").strip() or "unknown",
                entityKind=entity_kind,
                entityId=entity_id,
                payload=payload,
                eventTs=event_ts,
                createdAt=_now_iso(),
            )
            session.add(row)
            session.commit()
            session.refresh(row)
            seq = int(row.id or 0)
    except Exception:
        return event_hub.publish(payload)

    payload["eventSeq"] = seq
    payload["eventId"] = str(seq)
    return event_hub.publish(payload, event_id=seq)


def replay_live_events_after(last_event_id: int, *, limit: int | None = None) -> tuple[list[tuple[int, dict[str, Any]]], bool]:
    cap = max(1, int(limit or MAX_REPLAY_EVENTS))
    with Session(engine) as session:
        rows = session.exec(
            select(ChangeEvent)
            .where(ChangeEvent.id > int(last_event_id))
            .order_by(ChangeEvent.id.asc())
            .limit(cap + 1)
        ).all()
    overflowed = len(rows) > cap
    if overflowed:
        rows = rows[:cap]
    events: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        seq = int(row.id or 0)
        payload = dict(row.payload or {})
        payload["eventSeq"] = seq
        payload["eventId"] = str(seq)
        events.append((seq, payload))
    return events, overflowed


def oldest_live_event_id() -> int | None:
    with Session(engine) as session:
        row = session.exec(select(ChangeEvent.id).order_by(ChangeEvent.id.asc()).limit(1)).first()
    if row is None:
        return None
    return int(row)


def latest_live_event_id() -> int | None:
    with Session(engine) as session:
        row = session.exec(select(ChangeEvent.id).order_by(ChangeEvent.id.desc()).limit(1)).first()
    if row is None:
        return None
    return int(row)
