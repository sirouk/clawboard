import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.MOCK_API_PORT || 3051);
const HOST = process.env.MOCK_API_HOST || "127.0.0.1";
const fixturePath = process.env.CLAWBOARD_FIXTURE_PATH || join(__dirname, "fixtures", "portal.json");

const store = JSON.parse(readFileSync(fixturePath, "utf8"));
store.spaces = Array.isArray(store.spaces) ? store.spaces : [];
store.topics = Array.isArray(store.topics) ? store.topics : [];
store.logs = Array.isArray(store.logs) ? store.logs : [];
store.drafts = Array.isArray(store.drafts) ? store.drafts : [];
const legacyTasks = Array.isArray(store.tasks) ? store.tasks : [];
const topicIds = new Set(store.topics.map((topic) => String(topic.id || "").trim()).filter(Boolean));
for (const task of legacyTasks) {
  const id = String(task.id || "").trim();
  if (!id || topicIds.has(id)) continue;
  const now = nowIso();
  store.topics.push({
    id,
    name: String(task.title || task.name || id).trim() || id,
    description: task.description ?? null,
    parentId: task.topicId ?? null,
    tags: Array.isArray(task.tags) ? task.tags : [],
    color: task.color ?? null,
    status: task.status ?? "todo",
    priority: task.priority ?? "medium",
    dueDate: task.dueDate ?? null,
    snoozedUntil: task.snoozedUntil ?? null,
    spaceId: task.spaceId ?? null,
    sortIndex: Number.isFinite(task.sortIndex) ? Number(task.sortIndex) : store.topics.length,
    createdAt: task.createdAt || now,
    updatedAt: task.updatedAt || task.createdAt || now,
  });
  topicIds.add(id);
}
for (const log of store.logs) {
  if (!log.topicId && log.taskId) {
    log.topicId = log.taskId;
  }
  if ("taskId" in log) {
    log.taskId = null;
  }
}
delete store.tasks;
const subscribers = new Set();
const eventBuffer = [];
const MAX_EVENTS = 200;
let nextEventId = 0;
const BOARD_TOPIC_SESSION_PREFIX = "clawboard:topic:";
const deletedLogs = [];
const deletedTopics = [];
const liveTyping = new Map();
const liveThreadWork = new Map();
const openclawWorkspaces = [
  {
    agentId: "main",
    agentName: "Main",
    workspaceDir: "/Users/test/.openclaw/workspace",
    ideUrl: "http://workspace-ide.localhost:13337/?folder=/Users/test/.openclaw/workspace",
    preferred: false,
  },
  {
    agentId: "coding",
    agentName: "Coding",
    workspaceDir: "/Users/test/.openclaw/workspace-coding",
    ideUrl: "http://workspace-ide-coding.localhost:13338/?folder=/workspace",
    preferred: true,
  },
  {
    agentId: "docs",
    agentName: "Docs",
    workspaceDir: "/Users/test/.openclaw/workspace-docs",
    ideUrl: "http://workspace-ide.localhost:13337/?folder=/Users/test/.openclaw/workspace-docs",
    preferred: false,
  },
];

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function pushEvent(type, data, eventTs) {
  nextEventId += 1;
  const payload = {
    type,
    data,
    eventId: String(nextEventId),
    eventTs: eventTs || data?.updatedAt || data?.createdAt || nowIso(),
  };
  const record = { id: nextEventId, payload };
  eventBuffer.push(record);
  if (eventBuffer.length > MAX_EVENTS) eventBuffer.shift();
  for (const res of subscribers) {
    res.write(`id: ${record.id}\n`);
    res.write(`data: ${JSON.stringify(record.payload)}\n\n`);
  }
}

function reorderByIds(ids, orderedIds) {
  const orderIndex = new Map(orderedIds.map((id, idx) => [id, idx]));
  return ids.slice().sort((a, b) => {
    const ai = orderIndex.has(a) ? orderIndex.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.has(b) ? orderIndex.get(b) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return 0;
  });
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

function maxIso(current, candidate) {
  const value = String(candidate || "").trim();
  if (!value) return current;
  if (!current) return value;
  return value > current ? value : current;
}

function recordDeleted(list, id, deletedAt) {
  const key = String(id || "").trim();
  const stamp = String(deletedAt || nowIso()).trim() || nowIso();
  if (!key) return;
  list.push({ id: key, deletedAt: stamp });
}

function setTypingSignal(sessionKey, typing, requestId, updatedAt) {
  const key = String(sessionKey || "").trim();
  const stamp = String(updatedAt || nowIso()).trim() || nowIso();
  const rid = String(requestId || "").trim();
  if (!key) return;
  if (typing) {
    liveTyping.set(key, { sessionKey: key, typing: true, requestId: rid || undefined, updatedAt: stamp });
  } else {
    liveTyping.delete(key);
  }
  pushEvent("openclaw.typing", { sessionKey: key, typing: Boolean(typing), ...(rid ? { requestId: rid } : {}) }, stamp);
}

function setThreadWorkSignal(sessionKey, active, requestId, reason, updatedAt) {
  const key = String(sessionKey || "").trim();
  const stamp = String(updatedAt || nowIso()).trim() || nowIso();
  const rid = String(requestId || "").trim();
  const reasonText = String(reason || "").trim();
  if (!key) return;
  if (active) {
    liveThreadWork.set(key, {
      sessionKey: key,
      active: true,
      requestId: rid || undefined,
      reason: reasonText || undefined,
      updatedAt: stamp,
    });
  } else {
    liveThreadWork.delete(key);
  }
  pushEvent(
    "openclaw.thread_work",
    { sessionKey: key, active: Boolean(active), ...(rid ? { requestId: rid } : {}), ...(reasonText ? { reason: reasonText } : {}) },
    stamp
  );
}

function maybeResolveSignalsFromLog(entry) {
  const source = entry && typeof entry.source === "object" ? entry.source : {};
  const sessionKey = String(source.sessionKey || "").trim();
  const requestId = String(source.requestId || source.messageId || "").trim();
  const updatedAt = String(entry.updatedAt || entry.createdAt || nowIso()).trim() || nowIso();
  const agentId = String(entry.agentId || "").trim().toLowerCase();
  const requestTerminal = Boolean(source.requestTerminal);
  if (!sessionKey) return;
  if (agentId === "assistant" || requestTerminal) {
    setTypingSignal(sessionKey, false, requestId, updatedAt);
    setThreadWorkSignal(sessionKey, false, requestId, agentId === "assistant" ? "assistant_response" : "request_terminal", updatedAt);
  }
}

function buildChangesCursor(payload) {
  let cursor = "";
  for (const collection of [payload.spaces, payload.topics, payload.logs, payload.drafts]) {
    for (const item of collection || []) {
      cursor = maxIso(cursor, item.updatedAt || item.createdAt);
    }
  }
  for (const item of payload.deletedTopics || []) cursor = maxIso(cursor, item.deletedAt);
  for (const item of payload.deletedLogs || []) cursor = maxIso(cursor, item.deletedAt);
  for (const item of payload.openclawTyping || []) cursor = maxIso(cursor, item.updatedAt);
  for (const item of payload.openclawThreadWork || []) cursor = maxIso(cursor, item.updatedAt);
  return cursor || undefined;
}

function parseBoardSessionKey(sessionKey) {
  const key = String(sessionKey || "").trim();
  if (!key) return { topicId: null };
  if (key.startsWith(BOARD_TOPIC_SESSION_PREFIX)) {
    const topicId = key.slice(BOARD_TOPIC_SESSION_PREFIX.length).trim().split(":", 1)[0]?.trim() ?? "";
    return { topicId: topicId || null };
  }
  return { topicId: null };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isBriefParallelDispatchText(text) {
  return (
    (
      text.includes("dispatching ")
      && text.includes(" specialist")
      && text.includes(" in parallel")
      && text.includes(" now")
    )
    || (
      text.includes("dispatching to both ")
      && text.includes(" in parallel")
      && text.includes("combined answer shortly")
    )
  );
}

function isRedundantPartialSpecialistCompletionText(text) {
  return (
    text.includes("specialist ")
    && text.includes(" completed:")
    && (text.includes("still waiting on specialist ") || text.includes("waiting for specialist "))
    && (text.includes("will deliver the combined answer") || text.includes("delivering the combined answer"))
  );
}

function hasSuppressedWaitingStatus(entry) {
  const value = entry?.source?.suppressedWaitingStatus;
  return value === true || value === 1 || normalizeText(value) === "true";
}

function isLowSignalClosureText(text) {
  return (
    text.startsWith("task closed")
    || text.startsWith("done. task closed")
    || text.startsWith("done task closed")
    || text.startsWith("request complete")
    || text.startsWith("done. request complete")
    || text.startsWith("done request complete")
  );
}

function isChatNoiseLog(entry) {
  const type = normalizeText(entry?.type);
  const agentId = normalizeText(entry?.agentId);
  const channel = normalizeText(entry?.source?.channel);
  const text = normalizeText(entry?.summary || entry?.content || entry?.raw || "");
  if (channel === "cron-event") return true;
  if (type === "action" && (agentId === "toolresult" || text.startsWith("transcript write:") || text.startsWith("tool result persisted:"))) {
    return true;
  }
  if (
    type === "conversation" &&
    agentId === "assistant" &&
    (text === "heartbeat_ok" || text === "same recovery event already handled")
  ) {
    return true;
  }
  if (type === "conversation" && agentId === "assistant" && isBriefParallelDispatchText(text)) {
    return true;
  }
  if (type === "conversation" && agentId === "assistant" && isLowSignalClosureText(text)) {
    return true;
  }
  if (type === "system" && agentId === "system" && hasSuppressedWaitingStatus(entry)) {
    return true;
  }
  if (type === "system" && agentId === "system" && isRedundantPartialSpecialistCompletionText(text)) {
    return true;
  }
  return false;
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
  }

  const densityBase = Math.max(1, (nodes.length * (nodes.length - 1)) / 2);
  return {
    generatedAt: nowIso(),
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      topicCount: nodes.filter((node) => node.type === "topic").length,
      taskCount: 0,
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

  if (url.pathname === "/api/test/live-event" && req.method === "POST") {
    const payload = await parseBody(req);
    const type = String(payload.type || "").trim();
    if (!type) return sendJson(res, 400, { error: "type required" });
    const data = payload.data && typeof payload.data === "object" ? payload.data : {};
    const eventTs = String(payload.eventTs || data.updatedAt || data.createdAt || nowIso()).trim() || nowIso();
    pushEvent(type, data, eventTs);
    return sendJson(res, 200, { ok: true, type, eventTs });
  }

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
      res.write(`data: ${JSON.stringify({ type: "stream.ping", ts: nowIso() })}\n\n`);
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

  if (url.pathname === "/api/openclaw/workspaces" && req.method === "GET") {
    const requested = String(url.searchParams.get("agentId") || "").trim();
    const workspaces = requested
      ? openclawWorkspaces.filter((workspace) => workspace.agentId === requested)
      : openclawWorkspaces;
    return sendJson(res, 200, {
      configured: true,
      provider: "code-server",
      baseUrl: "http://workspace-ide.localhost:13337",
      workspaces,
    });
  }

  if (url.pathname === "/api/changes") {
    const since = url.searchParams.get("since");
    const filterSince = (items, key) => {
      if (!since) return items;
      return items.filter((item) => (item[key] || "") >= since);
    };
    const payload = {
      cursor: undefined,
      spaces: filterSince(store.spaces, "updatedAt"),
      topics: filterSince(store.topics, "updatedAt"),
      logs: filterSince(store.logs, "updatedAt"),
      drafts: filterSince(store.drafts, "updatedAt"),
      deletedLogIds: filterSince(deletedLogs, "deletedAt").map((item) => item.id),
      deletedTopics: filterSince(deletedTopics, "deletedAt"),
      openclawTyping: Array.from(liveTyping.values()),
      openclawThreadWork: Array.from(liveThreadWork.values()),
    };
    payload.cursor = buildChangesCursor({
      ...payload,
      deletedLogs: filterSince(deletedLogs, "deletedAt"),
    });
    return sendJson(res, 200, payload);
  }

  if (url.pathname === "/api/metrics" && req.method === "GET") {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const countCreated24h = (items) =>
      items.filter((item) => {
        const stamp = Date.parse(item.createdAt || item.updatedAt || "");
        if (Number.isNaN(stamp)) return false;
        return stamp >= dayAgo;
      }).length;
    const topicsCreated24h = countCreated24h(store.topics);
    return sendJson(res, 200, {
      creation: {
        topics: { total: store.topics.length, created24h: topicsCreated24h },
        gate: {
          topics: {
            allowedTotal: store.topics.length,
            blockedTotal: 0,
            allowed24h: topicsCreated24h,
            blocked24h: 0,
          },
        },
      },
    });
  }

  if (url.pathname === "/api/clawgraph" && req.method === "GET") {
    return sendJson(res, 200, buildMockClawgraph());
  }

  if (url.pathname === "/api/reindex" && req.method === "POST") {
    return sendJson(res, 200, { ok: true, queued: true });
  }

  if (url.pathname === "/api/openclaw/chat" && req.method === "POST") {
    const payload = await parseBody(req);
    const sessionKey = String(payload.sessionKey || "").trim();
    const message = String(payload.message || "").trim();
    const agentId = String(payload.agentId || "main").trim() || "main";
    if (!sessionKey) return sendJson(res, 400, { detail: "sessionKey is required" });
    if (!message) return sendJson(res, 400, { detail: "message is required" });
    const requestId = `occhat-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const createdAt = nowIso();
    const { topicId } = parseBoardSessionKey(sessionKey);
    const entry = normalizeLog({
      id: nextId("log", store.logs),
      topicId,
      type: "conversation",
      content: message,
      summary: message.length > 72 ? `${message.slice(0, 71).trim()}…` : message,
      raw: message,
      createdAt,
      updatedAt: createdAt,
      classificationStatus: "pending",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey, channel: "openclaw", requestId, agentId },
    });
    store.logs.push(entry);
    setTypingSignal(sessionKey, true, requestId, createdAt);
    setThreadWorkSignal(sessionKey, true, requestId, "queued", createdAt);
    pushEvent("log.appended", entry);
    return sendJson(res, 200, { queued: true, requestId });
  }

  if (url.pathname === "/api/openclaw/chat" && req.method === "DELETE") {
    const payload = await parseBody(req);
    const sessionKey = String(payload.sessionKey || "").trim();
    const requestId = String(payload.requestId || "").trim();
    const now = nowIso();
    if (sessionKey) {
      setTypingSignal(sessionKey, false, requestId, now);
      setThreadWorkSignal(sessionKey, false, requestId, "user_cancelled", now);
    }
    return sendJson(res, 200, {
      aborted: true,
      queueCancelled: sessionKey ? 1 : 0,
      sessionKey,
      sessionKeys: sessionKey ? [sessionKey] : [],
      gatewayAbortCount: sessionKey ? 1 : 0,
    });
  }

  if (url.pathname === "/api/search" && req.method === "GET") {
    const q = url.searchParams.get("q") || "";
    const topicId = url.searchParams.get("topicId");
    const includePending = url.searchParams.get("includePending") !== "false";
    const limitTopics = Number(url.searchParams.get("limitTopics") || 24);
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

    const logs = store.logs
      .map(normalizeLog)
      .filter((entry) => (topicId ? entry.topicId === topicId : true))
      .filter((entry) => (includePending ? true : (entry.classificationStatus || "pending") === "classified"))
      .map((entry) => {
        const score = scoreText(q, `${entry.summary || ""} ${entry.content || ""} ${entry.raw || ""}`);
        const parentBoost = entry.topicId && topicIdSet.has(entry.topicId) ? 0.08 : 0;
        return {
          id: entry.id,
          topicId: entry.topicId ?? null,
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
      logs,
      notes: [],
      matchedTopicIds: topics.map((item) => item.id),
      matchedLogIds: logs.map((item) => item.id),
    });
  }

  if (url.pathname === "/api/topics") {
    if (req.method === "GET") {
      const topics = [...store.topics];
      topics.sort((a, b) => {
        const aSortIndex = Number.isFinite(a.sortIndex) ? Number(a.sortIndex) : Number.MAX_SAFE_INTEGER;
        const bSortIndex = Number.isFinite(b.sortIndex) ? Number(b.sortIndex) : Number.MAX_SAFE_INTEGER;
        if (aSortIndex !== bSortIndex) return aSortIndex - bSortIndex;
        if (a.updatedAt !== b.updatedAt) return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
        return String(a.id || "").localeCompare(String(b.id || ""));
      });
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
          snoozedUntil: payload.snoozedUntil ?? null,
          tags: payload.tags ?? [],
          parentId: payload.parentId ?? null,
          sortIndex: Number.isFinite(payload.sortIndex) ? Number(payload.sortIndex) : -1,
          createdAt: now,
          updatedAt: now,
        };
        store.topics.push(topic);
      }
      pushEvent("topic.upserted", topic);
      return sendJson(res, 200, topic);
    }
  }

  if (url.pathname.startsWith("/api/topics/") && req.method === "DELETE") {
    const topicId = url.pathname.split("/").pop();
    if (!topicId) return sendJson(res, 400, { error: "topicId required" });
    const idx = store.topics.findIndex((t) => t.id === topicId);
    if (idx < 0) return sendJson(res, 200, { ok: true, deleted: false });
    store.topics.splice(idx, 1);
    const now = nowIso();
    recordDeleted(deletedTopics, topicId, now);
    for (const log of store.logs) {
      if (log.topicId !== topicId) continue;
      log.topicId = null;
      log.updatedAt = now;
    }
    pushEvent("topic.deleted", { id: topicId, updatedAt: now });
    return sendJson(res, 200, { ok: true, deleted: true });
  }

  if (url.pathname.startsWith("/api/topics/") && req.method === "PATCH") {
    const topicId = url.pathname.split("/").pop();
    if (!topicId) return sendJson(res, 400, { error: "topicId required" });
    const topic = store.topics.find((entry) => entry.id === topicId);
    if (!topic) return sendJson(res, 404, { error: "Not found" });

    const payload = await parseBody(req);
    const fields = new Set(Object.keys(payload || {}));
    const now = nowIso();

    Object.assign(topic, payload);

    if (fields.has("snoozedUntil")) {
      topic.snoozedUntil = payload.snoozedUntil ?? null;
    }
    if (fields.has("status")) {
      topic.status = payload.status ?? "active";
    }

    const normalizedStatus = String(topic.status || "active").trim().toLowerCase();
    if (topic.snoozedUntil && normalizedStatus !== "archived" && normalizedStatus !== "snoozed") {
      topic.status = "snoozed";
    } else if (fields.has("snoozedUntil") && topic.snoozedUntil == null && !fields.has("status") && normalizedStatus === "snoozed") {
      topic.status = "active";
    }

    topic.updatedAt = now;
    pushEvent("topic.upserted", topic);
    return sendJson(res, 200, topic);
  }

  if (url.pathname === "/api/topics/reorder" && req.method === "POST") {
    const payload = await parseBody(req);
    const orderedIds = Array.isArray(payload.orderedIds) ? payload.orderedIds.map((v) => String(v || "").trim()).filter(Boolean) : [];
    const unique = [...new Set(orderedIds)];
    const allIds = store.topics.map((t) => t.id);
    const unknown = unique.filter((id) => !allIds.includes(id));
    if (unknown.length) return sendJson(res, 400, { extra: unknown.slice(0, 50), message: "Unknown ids in orderedIds." });

    const order = reorderByIds(allIds, unique);
    const now = nowIso();
    for (let i = 0; i < order.length; i += 1) {
      const id = order[i];
      const topic = store.topics.find((t) => t.id === id);
      if (!topic) continue;
      topic.sortIndex = i;
      // Reordering is not a meaningful content update; do not touch updatedAt.
      pushEvent("topic.upserted", topic, now);
    }
    return sendJson(res, 200, { ok: true, count: order.length, changed: unique.length });
  }

  if (url.pathname === "/api/log") {
    if (req.method === "GET") {
      const topicId = url.searchParams.get("topicId");
      const sessionKey = url.searchParams.get("sessionKey");
      const type = url.searchParams.get("type");
      const classificationStatus = url.searchParams.get("classificationStatus");
      const limit = Number(url.searchParams.get("limit") || 200);
      const offset = Number(url.searchParams.get("offset") || 0);
      let logs = [...store.logs].map(normalizeLog);
      if (topicId) logs = logs.filter((l) => l.topicId === topicId);
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
      maybeResolveSignalsFromLog(entry);
      return sendJson(res, 200, entry);
    }
  }

  if (url.pathname === "/api/log/chat-counts" && req.method === "GET") {
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    const topicChatCounts = {};
    for (const log of store.logs.map(normalizeLog)) {
      if (!log.topicId) continue;
      if (spaceId && String(log.spaceId || "").trim() !== spaceId) continue;
      if (isChatNoiseLog(log)) continue;
      topicChatCounts[log.topicId] = (topicChatCounts[log.topicId] || 0) + 1;
    }
    return sendJson(res, 200, { topicChatCounts });
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
    maybeResolveSignalsFromLog(entry);
    return sendJson(res, 200, entry);
  }

  if (url.pathname.startsWith("/api/log/") && req.method === "DELETE") {
    const logId = url.pathname.split("/").pop();
    const toDelete = store.logs.filter((log) => log.id === logId || log.relatedLogId === logId);
    if (toDelete.length === 0) return sendJson(res, 200, { ok: true, deleted: false, deletedIds: [] });

    const deletedIds = toDelete.map((row) => row.id);
    store.logs = store.logs.filter((log) => !deletedIds.includes(log.id));
    const deletedAt = nowIso();

    for (const deletedId of deletedIds) {
      recordDeleted(deletedLogs, deletedId, deletedAt);
      pushEvent("log.deleted", { id: deletedId, rootId: logId });
    }

    return sendJson(res, 200, { ok: true, deleted: true, deletedIds });
  }

  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock API listening on http://${HOST}:${PORT}`);
});
