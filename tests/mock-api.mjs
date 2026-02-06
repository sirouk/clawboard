import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.MOCK_API_PORT || 3051);
const fixturePath = process.env.CLAWBOARD_FIXTURE_PATH || join(__dirname, "fixtures", "portal.json");

const store = JSON.parse(readFileSync(fixturePath, "utf8"));
const subscribers = new Set();
const eventBuffer = [];
const MAX_EVENTS = 200;
let nextEventId = 0;

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function pushEvent(type, data) {
  nextEventId += 1;
  const payload = {
    type,
    data,
    eventId: String(nextEventId),
    eventTs: data?.updatedAt || data?.createdAt || nowIso(),
  };
  const record = { id: nextEventId, payload };
  eventBuffer.push(record);
  if (eventBuffer.length > MAX_EVENTS) eventBuffer.shift();
  for (const res of subscribers) {
    res.write(`id: ${record.id}\n`);
    res.write(`data: ${JSON.stringify(record.payload)}\n\n`);
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function nextId(prefix, arr) {
  const max = arr.reduce((acc, item) => {
    const match = String(item.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    if (!match) return acc;
    return Math.max(acc, Number(match[1]));
  }, 0);
  return `${prefix}-${max + 1}`;
}

function normalizeLog(entry) {
  const createdAt = entry.createdAt || nowIso();
  return {
    ...entry,
    classificationStatus: entry.classificationStatus ?? "classified",
    createdAt,
    updatedAt: entry.updatedAt || createdAt,
  };
}

store.logs = Array.isArray(store.logs) ? store.logs.map(normalizeLog) : [];

const server = http.createServer(async (req, res) => {
  if (!req.url) return sendJson(res, 404, { error: "Not found" });
  if (req.method === "OPTIONS") return sendJson(res, 200, {});

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/health") return sendJson(res, 200, { status: "ok" });

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("event: ready\ndata: {}\n\n");
    const lastEvent = req.headers["last-event-id"];
    const lastId = lastEvent ? Number(lastEvent) : null;
    const oldest = eventBuffer.length ? eventBuffer[0].id : null;
    if (lastId && oldest && lastId < oldest) {
      res.write(`data: ${JSON.stringify({ type: "stream.reset" })}\n\n`);
    } else if (lastId) {
      for (const record of eventBuffer) {
        if (record.id > lastId) {
          res.write(`id: ${record.id}\n`);
          res.write(`data: ${JSON.stringify(record.payload)}\n\n`);
        }
      }
    }
    subscribers.add(res);
    const interval = setInterval(() => {
      res.write(": ping\n\n");
    }, 20000);
    req.on("close", () => {
      clearInterval(interval);
      subscribers.delete(res);
    });
    return;
  }

  if (url.pathname === "/api/config") {
    if (req.method === "GET") {
      return sendJson(res, 200, { instance: store.instance, tokenRequired: false });
    }
    if (req.method === "POST") {
      const payload = await parseBody(req);
      store.instance = {
        ...store.instance,
        ...payload,
        updatedAt: nowIso(),
      };
      pushEvent("config.updated", store.instance);
      return sendJson(res, 200, { instance: store.instance, tokenRequired: false });
    }
  }

  if (url.pathname === "/api/changes") {
    const since = url.searchParams.get("since");
    const filterSince = (items, key) => {
      if (!since) return items;
      return items.filter((item) => (item[key] || "") >= since);
    };
    return sendJson(res, 200, {
      topics: filterSince(store.topics, "updatedAt"),
      tasks: filterSince(store.tasks, "updatedAt"),
      logs: filterSince(store.logs, "updatedAt"),
    });
  }

  if (url.pathname === "/api/topics") {
    if (req.method === "GET") {
      const topics = [...store.topics];
      topics.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
      topics.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
      return sendJson(res, 200, topics);
    }
    if (req.method === "POST") {
      const payload = await parseBody(req);
      const now = nowIso();
      let topic = payload.id ? store.topics.find((t) => t.id === payload.id) : null;
      if (topic) {
        Object.assign(topic, payload, { updatedAt: now });
      } else {
        topic = {
          id: payload.id || nextId("topic", store.topics),
          name: payload.name,
          description: payload.description ?? "",
          priority: payload.priority ?? "medium",
          status: payload.status ?? "active",
          tags: payload.tags ?? [],
          parentId: payload.parentId ?? null,
          pinned: payload.pinned ?? false,
          createdAt: now,
          updatedAt: now,
        };
        store.topics.push(topic);
      }
      pushEvent("topic.upserted", topic);
      return sendJson(res, 200, topic);
    }
  }

  if (url.pathname === "/api/tasks") {
    if (req.method === "GET") {
      const topicId = url.searchParams.get("topicId");
      let tasks = [...store.tasks];
      if (topicId) tasks = tasks.filter((t) => t.topicId === topicId);
      tasks.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
      tasks.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
      return sendJson(res, 200, tasks);
    }
    if (req.method === "POST") {
      const payload = await parseBody(req);
      const now = nowIso();
      let task = payload.id ? store.tasks.find((t) => t.id === payload.id) : null;
      if (task) {
        Object.assign(task, payload, { updatedAt: now });
      } else {
        task = {
          id: payload.id || nextId("task", store.tasks),
          topicId: payload.topicId ?? null,
          title: payload.title,
          status: payload.status ?? "todo",
          pinned: payload.pinned ?? false,
          priority: payload.priority ?? "medium",
          dueDate: payload.dueDate ?? null,
          createdAt: now,
          updatedAt: now,
        };
        store.tasks.push(task);
      }
      pushEvent("task.upserted", task);
      return sendJson(res, 200, task);
    }
  }

  if (url.pathname === "/api/log") {
    if (req.method === "GET") {
      const topicId = url.searchParams.get("topicId");
      const taskId = url.searchParams.get("taskId");
      const sessionKey = url.searchParams.get("sessionKey");
      const type = url.searchParams.get("type");
      const classificationStatus = url.searchParams.get("classificationStatus");
      const limit = Number(url.searchParams.get("limit") || 200);
      const offset = Number(url.searchParams.get("offset") || 0);
      let logs = [...store.logs].map(normalizeLog);
      if (topicId) logs = logs.filter((l) => l.topicId === topicId);
      if (taskId) logs = logs.filter((l) => l.taskId === taskId);
      if (sessionKey)
        logs = logs.filter((l) => (l.source || {}).sessionKey === sessionKey);
      if (type) logs = logs.filter((l) => l.type === type);
      if (classificationStatus) logs = logs.filter((l) => l.classificationStatus === classificationStatus);
      logs.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
      return sendJson(res, 200, logs.slice(offset, offset + limit));
    }
    if (req.method === "POST") {
      const payload = await parseBody(req);
      const now = payload.createdAt || nowIso();
      const entry = normalizeLog({
        id: payload.id || nextId("log", store.logs),
        ...payload,
        createdAt: now,
        updatedAt: payload.updatedAt || now,
        classificationStatus: payload.classificationStatus ?? "pending",
      });
      store.logs.push(entry);
      pushEvent("log.appended", entry);
      return sendJson(res, 200, entry);
    }
  }

  if (url.pathname.startsWith("/api/log/") && req.method === "PATCH") {
    const logId = url.pathname.split("/").pop();
    const payload = await parseBody(req);
    const entry = store.logs.find((log) => log.id === logId);
    if (!entry) return sendJson(res, 404, { error: "Not found" });
    Object.assign(entry, payload, { updatedAt: nowIso() });
    const normalized = normalizeLog(entry);
    Object.assign(entry, normalized);
    pushEvent("log.patched", entry);
    return sendJson(res, 200, entry);
  }

  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Mock API listening on http://localhost:${PORT}`);
});
