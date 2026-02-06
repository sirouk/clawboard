from __future__ import annotations

import json
import queue
import threading
from collections import deque
from typing import Any, Deque, Dict, Iterable, Set, Tuple


class EventHub:
    def __init__(self, max_buffer: int = 500) -> None:
        self._subscribers: Set[queue.Queue] = set()
        self._lock = threading.Lock()
        self._buffer: Deque[Tuple[int, Dict[str, Any]]] = deque(maxlen=max_buffer)
        self._next_id = 1

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
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

event_hub = EventHub(max_buffer=int(os.environ.get("CLAWBOARD_EVENT_BUFFER", "500")))
