import json
import os
import time
import hashlib
import requests

CLAWBOARD_API_BASE = os.environ.get("CLAWBOARD_API_BASE", "http://localhost:8010").rstrip("/")
CLAWBOARD_TOKEN = os.environ.get("CLAWBOARD_TOKEN")

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "http://127.0.0.1:18789").rstrip("/")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN")
OPENCLAW_MODEL = os.environ.get("OPENCLAW_MODEL", "openai-codex/gpt-5.2")

INTERVAL = int(os.environ.get("CLASSIFIER_INTERVAL_SECONDS", "10"))
MAX_ATTEMPTS = int(os.environ.get("CLASSIFIER_MAX_ATTEMPTS", "3"))

LOCK_PATH = os.environ.get("CLASSIFIER_LOCK_PATH", "/data/classifier.lock")


def headers_clawboard():
    h = {"Content-Type": "application/json"}
    if CLAWBOARD_TOKEN:
        h["X-Clawboard-Token"] = CLAWBOARD_TOKEN
    return h


def oc_headers():
    if not OPENCLAW_GATEWAY_TOKEN:
        raise RuntimeError("OPENCLAW_GATEWAY_TOKEN is required")
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
    }


def acquire_lock():
    # extremely simple single-flight: atomic create
    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode("utf-8"))
        os.close(fd)
        return True
    except FileExistsError:
        return False


def release_lock():
    try:
        os.unlink(LOCK_PATH)
    except FileNotFoundError:
        pass


def list_pending(limit=50):
    r = requests.get(
        f"{CLAWBOARD_API_BASE}/api/log",
        params={"classificationStatus": "pending", "limit": limit},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def upsert_topic(topic_id: str, name: str):
    payload = {"id": topic_id, "name": name, "tags": ["classified"]}
    r = requests.post(
        f"{CLAWBOARD_API_BASE}/api/topics",
        headers=headers_clawboard(),
        data=json.dumps(payload),
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def patch_log(log_id: str, patch: dict):
    r = requests.patch(
        f"{CLAWBOARD_API_BASE}/api/log/{log_id}",
        headers=headers_clawboard(),
        data=json.dumps(patch),
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def call_classifier(log_entry: dict, candidates: list[dict]):
    # Minimal prompt: pick existing topic by id or create new deterministic id.
    content = log_entry.get("content") or ""
    source = log_entry.get("source") or {}
    channel = source.get("channel") or "unknown"

    prompt = {
        "log": {
            "id": log_entry.get("id"),
            "type": log_entry.get("type"),
            "summary": log_entry.get("summary"),
            "content": content[:2000],
            "source": source,
        },
        "candidates": candidates,
        "instructions": "Return strict JSON: {\"topicId\": string, \"topicName\": string, \"confidence\": number}. Prefer existing candidates when relevant."
    }

    body = {
        "model": OPENCLAW_MODEL,
        "messages": [
            {
                "role": "system",
                "content": "You are a routing classifier for an ops dashboard. Respond with STRICT JSON only.",
            },
            {"role": "user", "content": json.dumps(prompt)},
        ],
        "temperature": 0,
        "max_tokens": 300,
    }

    r = requests.post(
        f"{OPENCLAW_BASE_URL}/v1/chat/completions",
        headers=oc_headers(),
        data=json.dumps(body),
        timeout=40,
    )
    r.raise_for_status()
    data = r.json()
    text = data["choices"][0]["message"]["content"]
    return json.loads(text)


def topic_candidates():
    # Placeholder candidate set: most recent topics.
    r = requests.get(f"{CLAWBOARD_API_BASE}/api/topics", timeout=10)
    r.raise_for_status()
    topics = r.json()
    # compact
    return [{"id": t["id"], "name": t["name"], "updatedAt": t.get("updatedAt")} for t in topics[:25]]


def stable_topic_id(channel: str):
    base = channel.lower().replace("/", "-").replace(":", "-")
    base = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in base)
    base = "-".join([p for p in base.split("-") if p])[:50]
    if not base:
        base = hashlib.sha1(channel.encode()).hexdigest()[:10]
    return f"topic-{base}"


def process_one(log_entry: dict):
    attempts = int(log_entry.get("classificationAttempts") or 0)
    if attempts >= MAX_ATTEMPTS:
        return

    try:
        cands = topic_candidates()
        result = call_classifier(log_entry, cands)
        topic_id = result.get("topicId")
        topic_name = result.get("topicName")
        if not topic_id:
            # deterministic fallback: bucket by channel
            src = log_entry.get("source") or {}
            topic_id = stable_topic_id(src.get("channel") or "unknown")
            topic_name = f"Channel {src.get('channel') or 'unknown'}"

        upsert_topic(topic_id, topic_name or topic_id)
        patch_log(
            log_entry["id"],
            {
                "topicId": topic_id,
                "classificationStatus": "classified",
                "classificationAttempts": attempts + 1,
                "classificationError": None,
            },
        )
    except Exception as e:
        err = str(e)
        patch = {
            "classificationStatus": "pending" if attempts + 1 < MAX_ATTEMPTS else "failed",
            "classificationAttempts": attempts + 1,
            "classificationError": err[:500],
        }
        patch_log(log_entry["id"], patch)


def main():
    while True:
        if not acquire_lock():
            time.sleep(INTERVAL)
            continue
        try:
            try:
                pending = list_pending(limit=50)
            except Exception as e:
                # API not ready yet (common on container start). Don't crash.
                print(f"classifier: clawboard api unavailable: {e}")
                pending = []

            for entry in pending:
                process_one(entry)
        finally:
            release_lock()
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
