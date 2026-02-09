from __future__ import annotations

import json
import queue
import threading
from collections import deque
from typing import Any, Deque, Dict, Iterable, Set, Tuple


class EventHub:
    def __init__(self, max_buffer: int = 500, subscriber_queue_size: int | None = None) -> None:
        self._subscribers: Set[queue.Queue] = set()
        self._lock = threading.Lock()
        self._buffer: Deque[Tuple[int, Dict[str, Any]]] = deque(maxlen=max_buffer)
        self._next_id = 1
        # Bound per-subscriber queues so a slow/disconnected SSE client cannot
        # accumulate an unbounded backlog and exhaust RAM (which can deadlock the API).
        self._subscriber_queue_size = int(subscriber_queue_size or max_buffer or 1)

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=self._subscriber_queue_size)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, event: Dict[str, Any]) -> Dict[str, Any]:
        event_id = self._next_id
        self._next_id += 1
        payload = {**event, "eventId": str(event_id)}
        record = (event_id, payload)
        self._buffer.append(record)
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait(record)
            except queue.Full:
                # Drop the oldest event to keep tailing live updates.
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(record)
                except queue.Full:
                    continue
        return payload

    def replay(self, last_event_id: int) -> Iterable[Tuple[int, Dict[str, Any]]]:
        return [record for record in self._buffer if record[0] > last_event_id]

    def oldest_id(self) -> int | None:
        if not self._buffer:
            return None
        return self._buffer[0][0]

    @staticmethod
    def encode(event_id: int | None, event: Dict[str, Any]) -> str:
        payload = json.dumps(event, default=str)
        if event_id is None:
            return f"data: {payload}\n\n"
        return f"id: {event_id}\ndata: {payload}\n\n"


import os

_max_buffer = int(os.environ.get("CLAWBOARD_EVENT_BUFFER", "500"))
_subscriber_queue = int(os.environ.get("CLAWBOARD_EVENT_SUBSCRIBER_QUEUE", str(_max_buffer)))
event_hub = EventHub(max_buffer=_max_buffer, subscriber_queue_size=_subscriber_queue)
