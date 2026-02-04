import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.MOCK_API_PORT || 3051);
const fixturePath = process.env.CLAWBOARD_FIXTURE_PATH || join(__dirname, "fixtures", "portal.json");

const store = JSON.parse(readFileSync(fixturePath, "utf8"));

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
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

const server = http.createServer(async (req, res) => {
  if (!req.url) return sendJson(res, 404, { error: "Not found" });
  if (req.method === "OPTIONS") return sendJson(res, 200, {});

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/health") return sendJson(res, 200, { status: "ok" });

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
      return sendJson(res, 200, { instance: store.instance, tokenRequired: false });
    }
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
      return sendJson(res, 200, task);
    }
  }

  if (url.pathname === "/api/log") {
    if (req.method === "GET") {
      const topicId = url.searchParams.get("topicId");
      const taskId = url.searchParams.get("taskId");
      const limit = Number(url.searchParams.get("limit") || 200);
      const offset = Number(url.searchParams.get("offset") || 0);
      let logs = [...store.logs];
      if (topicId) logs = logs.filter((l) => l.topicId === topicId);
      if (taskId) logs = logs.filter((l) => l.taskId === taskId);
      logs.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
      return sendJson(res, 200, logs.slice(offset, offset + limit));
    }
    if (req.method === "POST") {
      const payload = await parseBody(req);
      const now = payload.createdAt || nowIso();
      const entry = {
        id: nextId("log", store.logs),
        ...payload,
        createdAt: now,
      };
      store.logs.push(entry);
      return sendJson(res, 200, entry);
    }
  }

  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Mock API listening on http://localhost:${PORT}`);
});
