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

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreText(query, text) {
  const q = normalizeText(query);
  const target = normalizeText(text);
  if (!q || !target) return 0;
  if (target.includes(q)) return 1;
  const tokens = q.split(" ").filter(Boolean);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (target.includes(token)) hits += 1;
  }
  if (hits === 0) return 0;
  return Number((hits / tokens.length).toFixed(6));
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "node";
}

function buildMockClawgraph() {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeIds = new Set();

  const addNode = (node) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  const addEdge = (edge) => {
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    edges.push(edge);
  };

  const topicById = new Map(store.topics.map((topic) => [topic.id, topic]));
  const taskById = new Map(store.tasks.map((task) => [task.id, task]));
  const agentSeen = new Set();

  for (const topic of store.topics) {
    addNode({
      id: `topic:${topic.id}`,
      label: topic.name || topic.id,
      type: "topic",
      score: 2.2,
      size: 18,
      color: "#ff8a4a",
      meta: { topicId: topic.id },
    });
  }

  for (const task of store.tasks) {
    addNode({
      id: `task:${task.id}`,
      label: task.title || task.id,
      type: "task",
      score: task.status === "doing" ? 1.9 : task.status === "blocked" ? 1.7 : 1.4,
      size: 14,
      color: "#4ea1ff",
      meta: { taskId: task.id, topicId: task.topicId || null, status: task.status || "todo" },
    });
    if (task.topicId && topicById.has(task.topicId)) {
      addEdge({
        id: `edge:topic-task:${task.topicId}:${task.id}`,
        source: `topic:${task.topicId}`,
        target: `task:${task.id}`,
        type: "has_task",
        weight: 1.2,
        evidence: 1,
      });
    }
  }

  const recentLogs = [...store.logs]
    .map(normalizeLog)
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
    .slice(0, 400);

  for (const log of recentLogs) {
    const label = (log.agentLabel || log.agentId || "").trim();
    if (!label) continue;
    const agentId = `agent:${slug(label)}`;
    if (!agentSeen.has(agentId)) {
      agentSeen.add(agentId);
      addNode({
        id: agentId,
        label: label.slice(0, 36),
        type: "agent",
        score: 1.1,
        size: 11,
        color: "#f2c84b",
        meta: { agentLabel: label },
      });
    }
    if (log.topicId && topicById.has(log.topicId)) {
      addEdge({
        id: `edge:agent-topic:${agentId}:${log.topicId}`,
        source: agentId,
        target: `topic:${log.topicId}`,
        type: "agent_focus",
        weight: 0.7,
        evidence: 1,
      });
    }
    if (log.taskId && taskById.has(log.taskId)) {
      addEdge({
        id: `edge:agent-task:${agentId}:${log.taskId}`,
        source: agentId,
        target: `task:${log.taskId}`,
        type: "mentions",
        weight: 0.6,
        evidence: 1,
      });
    }
  }

  const densityBase = Math.max(1, (nodes.length * (nodes.length - 1)) / 2);
  return {
    generatedAt: nowIso(),
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      topicCount: nodes.filter((node) => node.type === "topic").length,
      taskCount: nodes.filter((node) => node.type === "task").length,
      entityCount: nodes.filter((node) => node.type === "entity").length,
      agentCount: nodes.filter((node) => node.type === "agent").length,
      density: Math.min(1, Number((edges.length / densityBase).toFixed(4))),
    },
    nodes,
    edges,
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

  if (url.pathname === "/api/clawgraph" && req.method === "GET") {
    return sendJson(res, 200, buildMockClawgraph());
  }

  if (url.pathname === "/api/reindex" && req.method === "POST") {
    return sendJson(res, 200, { ok: true, queued: true });
  }

  if (url.pathname === "/api/search" && req.method === "GET") {
    const q = url.searchParams.get("q") || "";
    const topicId = url.searchParams.get("topicId");
    const includePending = url.searchParams.get("includePending") !== "false";
    const limitTopics = Number(url.searchParams.get("limitTopics") || 24);
    const limitTasks = Number(url.searchParams.get("limitTasks") || 48);
    const limitLogs = Number(url.searchParams.get("limitLogs") || 360);

    const topics = [...store.topics]
      .map((topic) => ({
        id: topic.id,
        name: topic.name,
        description: topic.description || "",
        score: scoreText(q, `${topic.name || ""} ${topic.description || ""}`),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limitTopics));

    const topicIdSet = new Set(topics.map((item) => item.id));

    const tasks = [...store.tasks]
      .filter((task) => (topicId ? task.topicId === topicId : true))
      .map((task) => {
        const score = scoreText(q, `${task.title || ""} ${task.status || ""}`);
        const parentBoost = task.topicId && topicIdSet.has(task.topicId) ? 0.12 : 0;
        return {
          id: task.id,
          topicId: task.topicId ?? null,
          title: task.title,
          status: task.status,
          score: Number((score + parentBoost).toFixed(6)),
          noteWeight: 0,
          sessionBoosted: false,
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limitTasks));

    const taskIdSet = new Set(tasks.map((item) => item.id));

    const logs = store.logs
      .map(normalizeLog)
      .filter((entry) => (topicId ? entry.topicId === topicId : true))
      .filter((entry) => (includePending ? true : (entry.classificationStatus || "pending") === "classified"))
      .map((entry) => {
        const score = scoreText(q, `${entry.summary || ""} ${entry.content || ""} ${entry.raw || ""}`);
        const parentBoost =
          (entry.topicId && topicIdSet.has(entry.topicId) ? 0.08 : 0) + (entry.taskId && taskIdSet.has(entry.taskId) ? 0.08 : 0);
        return {
          id: entry.id,
          topicId: entry.topicId ?? null,
          taskId: entry.taskId ?? null,
          type: entry.type,
          agentId: entry.agentId || "",
          agentLabel: entry.agentLabel || "",
          summary: entry.summary || "",
          content: entry.content || "",
          createdAt: entry.createdAt,
          score: Number((score + parentBoost).toFixed(6)),
          noteCount: 0,
          noteWeight: 0,
          sessionBoosted: false,
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, Math.max(10, limitLogs));

    return sendJson(res, 200, {
      query: q,
      mode: "lexical",
      topics,
      tasks,
      logs,
      notes: [],
      matchedTopicIds: topics.map((item) => item.id),
      matchedTaskIds: tasks.map((item) => item.id),
      matchedLogIds: logs.map((item) => item.id),
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
