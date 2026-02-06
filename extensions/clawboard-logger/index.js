import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_QUEUE = path.join(os.homedir(), ".openclaw", "clawboard-queue.jsonl");
const SUMMARY_MAX = 72;
const RAW_MAX = 5000;
const DEFAULT_CONTEXT_MAX_CHARS = 2200;
const DEFAULT_CONTEXT_TOPIC_LIMIT = 3;
const DEFAULT_CONTEXT_TASK_LIMIT = 3;
const DEFAULT_CONTEXT_LOG_LIMIT = 6;
const CLAWBOARD_CONTEXT_BEGIN = "[CLAWBOARD_CONTEXT_BEGIN]";
const CLAWBOARD_CONTEXT_END = "[CLAWBOARD_CONTEXT_END]";

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, "");
}

function sanitizeMessageContent(content) {
  let text = (content ?? "").replace(/\r\n?/g, "\n").trim();
  text = text.replace(/\[CLAWBOARD_CONTEXT_BEGIN\][\s\S]*?\[CLAWBOARD_CONTEXT_END\]\s*/gi, "");
  text = text.replace(
    /Clawboard continuity hook is active for this turn\.[\s\S]*?Prioritize curated user notes when present\.\s*/gi,
    ""
  );
  text = text.replace(/^\s*summary\s*[:\-]\s*/gim, "");
  text = text.replace(/^\[Discord [^\]]+\]\s*/gim, "");
  text = text.replace(/\[message[_\s-]?id:[^\]]+\]/gi, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function summarize(content) {
  const trimmed = sanitizeMessageContent(content).replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= SUMMARY_MAX) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX - 1).trim()}…`;
}

function truncateRaw(content) {
  if (content.length <= RAW_MAX) return content;
  return `${content.slice(0, RAW_MAX - 1)}…`;
}

function clip(text, limit) {
  const value = (text ?? "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trim()}…`;
}

function normalizeWhitespace(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function tokenSet(value) {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ");
  const stop = new Set([
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
    "an"
  ]);
  return new Set(
    normalized
      .split(" ")
      .map((item) => item.trim())
      .filter((item) => item.length > 2 && !stop.has(item))
  );
}

function lexicalSimilarity(a, b) {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const token of sa) {
    if (sb.has(token)) inter += 1;
  }
  const union = sa.size + sb.size - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function extractTextLoose(value, depth = 0) {
  if (!value || depth > 4) return void 0;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractTextLoose(entry, depth + 1))
      .filter(Boolean);
    return parts.length ? parts.join("\n") : void 0;
  }
  if (typeof value === "object") {
    const obj = value;
    const keys = ["text", "content", "value", "message", "output_text", "input_text"];
    const parts = [];
    for (const key of keys) {
      const extracted = extractTextLoose(obj[key], depth + 1);
      if (extracted)
        parts.push(extracted);
    }
    return parts.length ? parts.join("\n") : void 0;
  }
  return void 0;
}

function latestUserInput(prompt, messages) {
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (typeof message?.role !== "string" || message.role !== "user")
        continue;
      const text = extractTextLoose(message.content);
      const clean = sanitizeMessageContent(text ?? "");
      if (clean)
        return clean;
    }
  }
  const fallback = sanitizeMessageContent(prompt ?? "");
  return clip(fallback, 1e3);
}

function isClassifierPayloadText(content) {
  const text = content.trim();
  if (!text)
    return false;
  if (!text.startsWith("{") && !text.startsWith("```"))
    return false;
  const markers = ["\"window\"", "\"candidateTopics\"", "\"candidateTasks\"", "\"instructions\"", "\"summaries\""];
  return markers.some((marker) => text.includes(marker));
}

function redact(value, depth = 0) {
  if (depth > 4) return "[redacted-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateRaw(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (typeof value === "object") {
    const obj = value;
    const output = {};
    for (const [key, val] of Object.entries(obj)) {
      if (/token|secret|password|key|auth/i.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = redact(val, depth + 1);
      }
    }
    return output;
  }
  return "[unserializable]";
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export default function register(api) {
  const rawConfig = api.pluginConfig ?? {};
  const enabled = rawConfig.enabled !== false;
  const debug = rawConfig.debug === true;
  const baseUrl = rawConfig.baseUrl ? normalizeBaseUrl(rawConfig.baseUrl) : "";
  const token = rawConfig.token;
  const queuePath = rawConfig.queuePath ?? DEFAULT_QUEUE;
  const useQueue = rawConfig.queue === true;
  const ingestPath = rawConfig.ingestPath ?? (useQueue ? "/api/ingest" : "/api/log");
  const defaultTopicId = rawConfig.defaultTopicId;
  const defaultTaskId = rawConfig.defaultTaskId;
  // Default OFF: session buckets are not meaningful topics.
  // Stage-2 classifier will attach real topics asynchronously.
  const autoTopicBySession = rawConfig.autoTopicBySession === true;
  const contextAugment = rawConfig.contextAugment !== false;
  const contextMaxChars = typeof rawConfig.contextMaxChars === "number" && Number.isFinite(rawConfig.contextMaxChars) ? Math.max(400, Math.min(12e3, Math.floor(rawConfig.contextMaxChars))) : DEFAULT_CONTEXT_MAX_CHARS;
  const contextTopicLimit = typeof rawConfig.contextTopicLimit === "number" && Number.isFinite(rawConfig.contextTopicLimit) ? Math.max(1, Math.min(8, Math.floor(rawConfig.contextTopicLimit))) : DEFAULT_CONTEXT_TOPIC_LIMIT;
  const contextTaskLimit = typeof rawConfig.contextTaskLimit === "number" && Number.isFinite(rawConfig.contextTaskLimit) ? Math.max(1, Math.min(12, Math.floor(rawConfig.contextTaskLimit))) : DEFAULT_CONTEXT_TASK_LIMIT;
  const contextLogLimit = typeof rawConfig.contextLogLimit === "number" && Number.isFinite(rawConfig.contextLogLimit) ? Math.max(2, Math.min(20, Math.floor(rawConfig.contextLogLimit))) : DEFAULT_CONTEXT_LOG_LIMIT;

  if (!enabled) {
    api.logger.warn("[clawboard-logger] disabled by config");
    return;
  }

  if (!baseUrl) {
    api.logger.warn("[clawboard-logger] baseUrl missing; plugin disabled");
    return;
  }

  let flushing = false;
  const topicCache = new Map();

  function safeId(prefix, raw) {
    const cleaned = String(raw)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return `${prefix}-${cleaned || "unknown"}`;
  }

  async function upsertTopic(topicId, name) {
    try {
      const res = await fetch(`${baseUrl}/api/topics`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Clawboard-Token": token } : {}),
        },
        body: JSON.stringify({ id: topicId, name, tags: ["openclaw"] }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function resolveTopicId(sessionKey) {
    if (defaultTopicId) return defaultTopicId;
    if (!autoTopicBySession) return undefined;
    if (!sessionKey) return undefined;

    const cached = topicCache.get(sessionKey);
    if (cached) return cached;

    const topicId = safeId("topic-session", sessionKey);
    await upsertTopic(topicId, `Session ${sessionKey}`).catch(() => undefined);
    topicCache.set(sessionKey, topicId);
    return topicId;
  }

  function resolveTaskId() {
    return defaultTaskId;
  }

  function resolveAgentLabel(agentId, sessionKey) {
    const fromCtx = agentId && agentId !== "agent" ? agentId : void 0;
    let fromSession;
    if (!fromCtx && sessionKey && sessionKey.startsWith("agent:")) {
      const parts = sessionKey.split(":");
      if (parts.length >= 2)
        fromSession = parts[1];
    }
    const resolved = fromCtx ?? fromSession;
    if (!resolved || resolved === "main")
      return "OpenClaw";
    return `Agent ${resolved}`;
  }

  async function enqueue(payload) {
    await ensureDir(queuePath);
    await fs.appendFile(queuePath, `${JSON.stringify(payload)}\n`, "utf8");
  }

  async function postLog(payload) {
    try {
      const res = await fetch(`${baseUrl}${ingestPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Clawboard-Token": token } : {}),
        },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch (err) {
      api.logger.warn(`[clawboard-logger] failed to send log: ${String(err)}`);
      return false;
    }
  }

  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      const exists = await fs
        .stat(queuePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) return;
      const raw = await fs.readFile(queuePath, "utf8");
      if (!raw.trim()) return;
      const lines = raw.split("\n").filter(Boolean);
      const remaining = [];
      for (const line of lines) {
        try {
          const payload = JSON.parse(line);
          const ok = await postLog(payload);
          if (!ok) remaining.push(line);
        } catch {
          remaining.push(line);
        }
      }
      if (remaining.length === 0) {
        await fs.unlink(queuePath).catch(() => undefined);
      } else {
        await fs.writeFile(queuePath, remaining.join("\n") + "\n", "utf8");
      }
    } finally {
      flushing = false;
    }
  }

  async function send(payload) {
    const ok = await postLog(payload);
    if (!ok) {
      await enqueue(payload);
      return;
    }
    await flushQueue();
  }

  flushQueue().catch(() => undefined);

  // Startup marker (helps verify the running code version and routing behavior).
  send({
    type: "action",
    content: "clawboard-logger startup: routing enabled",
    summary: "clawboard-logger startup",
    raw: JSON.stringify(
      { autoTopicBySession, defaultTopicId, defaultTaskId, contextAugment, contextMaxChars },
      null,
      2
    ),
    agentId: "system",
    agentLabel: "Clawboard Logger",
  }).catch(() => undefined);

  const apiHeaders = {
    "Content-Type": "application/json",
    ...(token ? { "X-Clawboard-Token": token } : {})
  };

  async function getJson(pathname, params) {
    try {
      const url = new URL(`${baseUrl}${pathname}`);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value === void 0 || value === null || value === "")
            continue;
          url.searchParams.set(key, String(value));
        }
      }
      const res = await fetch(url.toString(), { headers: apiHeaders });
      if (!res.ok)
        return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function coerceArray(data) {
    return Array.isArray(data) ? data : [];
  }

  async function listLogs(params) {
    return coerceArray(await getJson("/api/log", params));
  }

  async function listTopics() {
    return coerceArray(await getJson("/api/topics"));
  }

  async function listTasks(topicId) {
    return coerceArray(await getJson("/api/tasks", { topicId }));
  }

  async function semanticLookup(query, sessionKey) {
    const data = await getJson("/api/search", {
      q: query,
      sessionKey,
      includePending: 1,
      limitTopics: Math.max(12, contextTopicLimit * 4),
      limitTasks: Math.max(24, contextTaskLimit * 5),
      limitLogs: Math.max(120, contextLogLimit * 30)
    });
    if (!data || typeof data !== "object")
      return null;
    return data;
  }

  function extractUpstreamMemorySignals(prompt, messages) {
    const memoryLines = [];
    const turnLines = [];
    const seen = /* @__PURE__ */ new Set();
    const remember = (line, bucket) => {
      const text = clip(normalizeWhitespace(sanitizeMessageContent(line)), 180);
      if (!text)
        return;
      const key = text.toLowerCase();
      if (seen.has(key))
        return;
      seen.add(key);
      bucket.push(text);
    };
    const promptText = sanitizeMessageContent(prompt ?? "");
    if (promptText) {
      const lines = promptText.split("\n").map((line) => line.trim()).filter(Boolean);
      const memoryHints = lines.filter((line) => /(memory|markdown|\.md\b|session|history|continuity|topic|task|retriev|vector|embed|note|curat)/i.test(line));
      for (const line of memoryHints.slice(0, 8))
        remember(line, memoryLines);
    }
    if (Array.isArray(messages)) {
      const recent = messages.slice(-8);
      for (const raw of recent) {
        const item = raw ?? {};
        const role = typeof item.role === "string" ? item.role : "turn";
        const text = extractTextLoose(item.content);
        if (!text)
          continue;
        const clean = clip(normalizeWhitespace(sanitizeMessageContent(text)), 140);
        if (!clean)
          continue;
        remember(`${role}: ${clean}`, turnLines);
      }
    }
    return {
      memoryLines: memoryLines.slice(0, 6),
      turnLines: turnLines.slice(0, 6)
    };
  }

  function formatLogLine(entry) {
    const who = (entry.agentId || "").toLowerCase() === "user" ? "User" : entry.agentLabel || entry.agentId || "Agent";
    const text = sanitizeMessageContent(entry.summary || entry.content || "");
    return `${who}: ${clip(normalizeWhitespace(text), 120)}`;
  }

  function buildContextBlock({ query, searchMode, sessionLogs, semanticLogs, topics, tasks, topicRecent, notes, upstream }) {
    const lines = [];
    lines.push("Clawboard continuity context:");
    lines.push(`Current user intent: ${clip(normalizeWhitespace(query), 180)}`);
    if (searchMode)
      lines.push(`Retrieval mode: ${searchMode}`);
    if (upstream.memoryLines.length > 0) {
      lines.push("OpenClaw memory signals (sessions/markdown/recent retrieval):");
      for (const line of upstream.memoryLines.slice(0, 5))
        lines.push(`- ${line}`);
    }
    if (upstream.turnLines.length > 0) {
      lines.push("Recent turns:");
      for (const line of upstream.turnLines.slice(0, 4))
        lines.push(`- ${line}`);
    }
    if (topics.length > 0) {
      lines.push("Likely topics:");
      for (const topic of topics) {
        const desc = topic.description ? ` - ${clip(normalizeWhitespace(topic.description), 80)}` : "";
        lines.push(`- ${topic.name}${desc}`);
      }
    }
    if (tasks.length > 0) {
      lines.push("Likely active tasks:");
      for (const task of tasks) {
        const status = task.status ? ` [${task.status}]` : "";
        lines.push(`- ${task.title}${status}`);
      }
    }
    const timeline = [];
    const pushed = /* @__PURE__ */ new Set();
    for (const item of sessionLogs.filter((entry) => entry.type === "conversation").slice(0, contextLogLimit + 2)) {
      const key = item.id || `${item.createdAt}:${item.summary || item.content || ""}`;
      if (pushed.has(key))
        continue;
      pushed.add(key);
      timeline.push(item);
      if (timeline.length >= contextLogLimit)
        break;
    }
    for (const item of semanticLogs.slice(0, contextLogLimit + 3)) {
      if (item.type && item.type !== "conversation")
        continue;
      const key = item.id || `${item.createdAt}:${item.summary || item.content || ""}`;
      if (pushed.has(key))
        continue;
      pushed.add(key);
      timeline.push({
        id: item.id,
        topicId: item.topicId,
        taskId: item.taskId,
        type: item.type ?? "conversation",
        summary: item.summary ?? void 0,
        content: item.content ?? void 0,
        createdAt: item.createdAt
      });
      if (timeline.length >= contextLogLimit)
        break;
    }
    if (timeline.length > 0) {
      lines.push("Recent thread timeline:");
      for (const entry of timeline)
        lines.push(`- ${formatLogLine(entry)}`);
    }
    const notesByLog = /* @__PURE__ */ new Map();
    for (const note of notes) {
      if ("type" in note && note.type && note.type !== "note")
        continue;
      const key = String(note.relatedLogId ?? "");
      if (!key)
        continue;
      const text = sanitizeMessageContent(note.content || note.summary || "");
      if (!text)
        continue;
      const existing = notesByLog.get(key) ?? [];
      if (existing.length < 2)
        existing.push(clip(normalizeWhitespace(text), 140));
      notesByLog.set(key, existing);
    }
    const noteLines = [];
    for (const entry of timeline) {
      if (!entry.id)
        continue;
      const attached = notesByLog.get(entry.id) ?? [];
      for (const noteText of attached)
        noteLines.push(`- ${formatLogLine(entry)} | note: ${noteText}`);
      if (noteLines.length >= 4)
        break;
    }
    if (noteLines.length > 0) {
      lines.push("Curated user notes (high weight):");
      lines.push(...noteLines.slice(0, 4));
    }
    const topicCtxLines = [];
    for (const topic of topics) {
      const recent = topicRecent[topic.id] ?? [];
      if (recent.length === 0)
        continue;
      topicCtxLines.push(`Topic ${topic.name}:`);
      for (const item of recent.slice(0, 2))
        topicCtxLines.push(`- ${formatLogLine(item)}`);
      if (topicCtxLines.length >= 10)
        break;
    }
    if (topicCtxLines.length > 0) {
      lines.push("Topic memory:");
      lines.push(...topicCtxLines.slice(0, 10));
    }
    return clip(lines.join("\n"), contextMaxChars);
  }

  async function retrieveContext(query, sessionKey, upstream) {
    const normalizedQuery = clip(normalizeWhitespace(sanitizeMessageContent(query)), 500);
    if (!normalizedQuery || normalizedQuery.length < 6)
      return void 0;
    const [topicsAll, sessionLogsRaw, semantic] = await Promise.all([
      listTopics(),
      sessionKey ? listLogs({
        sessionKey,
        type: "conversation",
        limit: 80,
        offset: 0
      }) : Promise.resolve([]),
      semanticLookup(normalizedQuery, sessionKey)
    ]);
    const sessionLogs = sessionLogsRaw.filter((entry) => entry.type === "conversation").sort((a, b) => String(a.createdAt || "") < String(b.createdAt || "") ? 1 : -1);
    const topicsById = new Map(topicsAll.map((topic) => [topic.id, topic]));
    const recentTopicOrder = [];
    const recentTopicSet = /* @__PURE__ */ new Set();
    const recentTaskSet = /* @__PURE__ */ new Set();
    for (const entry of sessionLogs) {
      if (entry.topicId && !recentTopicSet.has(entry.topicId)) {
        recentTopicSet.add(entry.topicId);
        recentTopicOrder.push(entry.topicId);
      }
      if (entry.taskId)
        recentTaskSet.add(entry.taskId);
    }
    const topicScore = /* @__PURE__ */ new Map();
    if (semantic?.topics?.length) {
      for (const item of semantic.topics) {
        if (!item?.id)
          continue;
        const base = Number(item.score || 0);
        const noteWeight = Number(item.noteWeight || 0);
        const boosted = base + Math.min(0.24, noteWeight);
        topicScore.set(item.id, Math.max(topicScore.get(item.id) ?? 0, boosted));
      }
    }
    for (let i = 0; i < recentTopicOrder.length; i += 1) {
      const id = recentTopicOrder[i];
      const continuityBoost = Math.max(0.5, 0.9 - i * 0.08);
      topicScore.set(id, Math.max(topicScore.get(id) ?? 0, continuityBoost));
    }
    for (const topic of topicsAll) {
      const lexical = lexicalSimilarity(normalizedQuery, `${topic.name} ${topic.description ?? ""}`);
      if (lexical > 0) {
        const next = Math.max(topicScore.get(topic.id) ?? 0, lexical * 0.8);
        topicScore.set(topic.id, next);
      }
    }
    const topics = topicsAll.map((topic) => ({ topic, score: topicScore.get(topic.id) ?? 0 })).filter((item) => item.score > 0.12 || recentTopicSet.has(item.topic.id)).sort((a, b) => b.score - a.score).slice(0, contextTopicLimit).map((item) => item.topic);
    const semanticTaskById = new Map((semantic?.tasks ?? []).map((item) => [item.id, item]));
    const semanticLogs = (semantic?.logs ?? []).slice(0, contextLogLimit + 4);
    const semanticNotes = (semantic?.notes ?? []).slice(0, 120);
    const taskBuckets = await Promise.all(
      topics.map(async (topic) => {
        const [tasks, logs] = await Promise.all([
          listTasks(topic.id),
          listLogs({
            topicId: topic.id,
            type: "conversation",
            limit: contextLogLimit,
            offset: 0
          })
        ]);
        return { topicId: topic.id, tasks, logs };
      })
    );
    const topicRecent = {};
    const taskScored = [];
    const relatedIds = /* @__PURE__ */ new Set();
    for (const bucket of taskBuckets) {
      topicRecent[bucket.topicId] = bucket.logs;
      for (const log of bucket.logs) {
        if (log.id)
          relatedIds.add(log.id);
      }
      for (const task of bucket.tasks) {
        const lexical = lexicalSimilarity(normalizedQuery, task.title || "");
        const continuityBoost = recentTaskSet.has(task.id) ? 0.25 : 0;
        const semanticScore = Number(semanticTaskById.get(task.id)?.score || 0);
        const noteWeight = Number(semanticTaskById.get(task.id)?.noteWeight || 0);
        taskScored.push({ task, score: lexical + continuityBoost + semanticScore + Math.min(0.24, noteWeight) });
      }
    }
    for (const entry of sessionLogs.slice(0, contextLogLimit + 4)) {
      if (entry.id)
        relatedIds.add(entry.id);
    }
    for (const entry of semanticLogs) {
      if (entry.id)
        relatedIds.add(entry.id);
      if (entry.topicId && topics.length < contextTopicLimit) {
        const candidate = topicsById.get(entry.topicId);
        if (candidate && !topics.some((item) => item.id === candidate.id))
          topics.push(candidate);
      }
    }
    const tasks = taskScored.sort((a, b) => b.score - a.score).filter((item, idx) => item.score > 0.08 || idx < contextTaskLimit).slice(0, contextTaskLimit).map((item) => item.task);
    const relatedLogId = Array.from(relatedIds).slice(0, 50).join(",");
    const fallbackNotes = relatedLogId.length > 0 ? await listLogs({
      type: "note",
      relatedLogId,
      limit: 120,
      offset: 0
    }) : [];
    const notes = [...semanticNotes, ...fallbackNotes];
    const context = buildContextBlock({
      query: normalizedQuery,
      searchMode: semantic?.mode,
      sessionLogs,
      semanticLogs,
      topics,
      tasks,
      topicRecent,
      notes,
      upstream
    });
    return context || void 0;
  }

  api.on("before_agent_start", async (event, ctx) => {
    if (!contextAugment)
      return;
    const input = latestUserInput(event.prompt, event.messages);
    const retrievalQuery = input && input.trim().length > 0 ? input : "current conversation continuity, active topics, active tasks, and curated notes";
    const upstream = extractUpstreamMemorySignals(event.prompt, event.messages);
    const context = await retrieveContext(retrievalQuery, ctx?.sessionKey, upstream);
    if (!context)
      return;
    const prependContext = [
      CLAWBOARD_CONTEXT_BEGIN,
      "Clawboard continuity hook is active for this turn. The block below already comes from Clawboard retrieval. Do not claim Clawboard is unavailable unless this block explicitly says retrieval failed.",
      "Use this Clawboard retrieval context merged with existing OpenClaw memory/turn context. Prioritize curated user notes when present.",
      context,
      CLAWBOARD_CONTEXT_END
    ].join("\n");
    return {
      prependContext
    };
  });

  let lastChannelId;
  let lastEffectiveSessionKey;
  let lastMessageAt = 0;
  const inboundBySession = /* @__PURE__ */ new Map();

  const resolveSessionKey = (meta, ctx2) => {
    const metaSession = meta?.sessionKey;
    if (typeof metaSession === "string" && metaSession.startsWith("channel:"))
      return metaSession;
    if (ctx2?.channelId)
      return `channel:${ctx2.channelId}`;
    const ctxSession = ctx2?.sessionKey;
    if (ctxSession)
      return ctxSession;
    return metaSession;
  };

  api.on("message_received", async (event, ctx) => {
    const raw = event.content ?? "";
    const cleanRaw = sanitizeMessageContent(raw);
    if (isClassifierPayloadText(cleanRaw))
      return;
    if (!cleanRaw)
      return;
    const meta = event.metadata ?? undefined;
    const effectiveSessionKey = resolveSessionKey(meta, ctx);
    lastChannelId = ctx.channelId;
    lastEffectiveSessionKey = effectiveSessionKey;
    lastMessageAt = Date.now();
    const ctxSessionKey = ctx?.sessionKey ?? meta?.sessionKey;
    if (ctxSessionKey) {
      inboundBySession.set(ctxSessionKey, {
        ts: lastMessageAt,
        channelId: ctx.channelId,
        sessionKey: effectiveSessionKey
      });
    }
    const topicId = await resolveTopicId(effectiveSessionKey);
    const taskId = resolveTaskId();

    const metaSummary = meta?.summary;
    const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);
    const incomingKey = `received:${ctx.channelId ?? "nochannel"}:${effectiveSessionKey ?? ""}:${summary}`;
    rememberIncoming(incomingKey);

    await send({
      topicId,
      taskId,
      type: "conversation",
      content: cleanRaw,
      summary,
      raw: truncateRaw(cleanRaw),
      idempotencyKey: meta?.messageId ? `discord:${meta.messageId}:user:conversation` : void 0,
      agentId: "user",
      agentLabel: "User",
      source: {
        channel: ctx.channelId,
        sessionKey: effectiveSessionKey,
        messageId: meta?.messageId,
      },
    });

    // Intentionally allow topicId to be null/undefined. Stage-2 classifier
    // will attach this log to a real topic based on conversation context.
  });

  const recentOutgoing = /* @__PURE__ */ new Set();
  const rememberOutgoing = (key) => {
    recentOutgoing.add(key);
    if (recentOutgoing.size > 200) {
      const first = recentOutgoing.values().next().value;
      if (first)
        recentOutgoing.delete(first);
    }
    setTimeout(() => recentOutgoing.delete(key), 30e3).unref?.();
  };
  const recentIncoming = /* @__PURE__ */ new Set();
  const rememberIncoming = (key) => {
    recentIncoming.add(key);
    if (recentIncoming.size > 200) {
      const first = recentIncoming.values().next().value;
      if (first)
        recentIncoming.delete(first);
    }
    setTimeout(() => recentIncoming.delete(key), 30e3).unref?.();
  };

  api.on("message_sending", async (event, ctx) => {
    const raw = event.content ?? "";
    const cleanRaw = sanitizeMessageContent(raw);
    if (isClassifierPayloadText(cleanRaw))
      return;
    if (!cleanRaw)
      return;
    const meta = event.metadata ?? void 0;
    const effectiveSessionKey = resolveSessionKey(meta, ctx);
    const topicId = await resolveTopicId(effectiveSessionKey);
    const taskId = resolveTaskId();
    const agentId = "assistant";
    const agentLabel = resolveAgentLabel(ctx.agentId, meta?.sessionKey ?? ctx?.sessionKey);
    const metaSummary = meta?.summary;
    const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);
    const dedupeKey = `sending:${ctx.channelId}:${effectiveSessionKey ?? ""}:${summary}`;
    rememberOutgoing(dedupeKey);
    await send({
      topicId,
      taskId,
      type: "conversation",
      content: cleanRaw,
      summary,
      raw: truncateRaw(cleanRaw),
      agentId,
      agentLabel,
      source: {
        channel: ctx.channelId,
        sessionKey: effectiveSessionKey
      }
    });
  });

  api.on("message_sent", async (event, ctx) => {
    const raw = sanitizeMessageContent(event.content ?? "");
    const meta = event ?? {};
    const sessionKey = meta?.sessionKey ?? ctx?.sessionKey;
    const effectiveSessionKey = sessionKey ?? (ctx.channelId ? `channel:${ctx.channelId}` : void 0);
    const summary = summarize(raw);
    const dedupeKey = `sending:${ctx.channelId}:${effectiveSessionKey ?? ""}:${summary}`;
    if (recentOutgoing.has(dedupeKey))
      return;
  });

  api.on("before_tool_call", async (event, ctx) => {
    const redacted = redact(event.params);
    const topicId = await resolveTopicId(ctx.sessionKey);
    const taskId = resolveTaskId();

    await send({
      topicId,
      taskId,
      type: "action",
      content: `Tool call: ${event.toolName}`,
      summary: `Tool call: ${event.toolName}`,
      raw: JSON.stringify(redacted, null, 2),
      agentId: ctx.agentId,
      agentLabel: ctx.agentId ? `Agent ${ctx.agentId}` : "Agent",
      source: {
        sessionKey: ctx.sessionKey,
      },
    });
  });

  api.on("after_tool_call", async (event, ctx) => {
    const payload = event.error ? { error: event.error } : { result: redact(event.result), durationMs: event.durationMs };
    const topicId = await resolveTopicId(ctx.sessionKey);
    const taskId = resolveTaskId();

    await send({
      topicId,
      taskId,
      type: "action",
      content: event.error ? `Tool error: ${event.toolName}` : `Tool result: ${event.toolName}`,
      summary: event.error ? `Tool error: ${event.toolName}` : `Tool result: ${event.toolName}`,
      raw: JSON.stringify(payload, null, 2),
      agentId: ctx.agentId,
      agentLabel: ctx.agentId ? `Agent ${ctx.agentId}` : "Agent",
      source: {
        sessionKey: ctx.sessionKey,
      },
    });
  });

  api.on("agent_end", async (event, ctx) => {
    const payload = {
      success: event.success,
      error: event.error,
      durationMs: event.durationMs,
      messageCount: event.messages?.length ?? 0,
    };

    const topicId = await resolveTopicId(ctx.sessionKey);
    const taskId = resolveTaskId();

    const messages = Array.isArray(event.messages) ? event.messages : [];
    const agentId = "assistant";
    const agentLabel = resolveAgentLabel(ctx.agentId, ctx.sessionKey);

    if (debug) {
      try {
        const shape = messages.slice(-20).map((m) => ({
          role: typeof m?.role === "string" ? m.role : typeof m?.role,
          contentType: Array.isArray(m?.content) ? "array" : typeof m?.content,
          keys: m && typeof m === "object" ? Object.keys(m).slice(0, 12) : []
        }));
        await send({
          topicId,
          taskId,
          type: "action",
          content: "clawboard-logger: agent_end message shape",
          summary: "clawboard-logger: agent_end message shape",
          raw: JSON.stringify(shape, null, 2),
          agentId: "system",
          agentLabel: "Clawboard Logger",
          source: { sessionKey: ctx.sessionKey }
        });
      } catch {
      }
    }

    const extractText = (value, depth = 0) => {
      if (!value || depth > 4) return void 0;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        const parts = value.map((part) => extractText(part, depth + 1)).filter(Boolean);
        return parts.length ? parts.join("\n") : void 0;
      }
      if (typeof value === "object") {
        const obj = value;
        const keys = ["text", "content", "value", "message", "output_text", "input_text"];
        const parts = [];
        for (const key of keys) {
          const extracted = extractText(obj[key], depth + 1);
          if (extracted)
            parts.push(extracted);
        }
        return parts.length ? parts.join("\n") : void 0;
      }
      return void 0;
    };

    const anchor = ctx.sessionKey ? inboundBySession.get(ctx.sessionKey) : void 0;
    const anchorFresh = !!anchor && Date.now() - anchor.ts < 2 * 60 * 1e3;
    const channelFresh = Date.now() - lastMessageAt < 2 * 60 * 1e3;
    let inferredSessionKey = (anchorFresh ? anchor?.sessionKey : void 0) ?? ctx.sessionKey;
    const discordSignal = messages.some((msg) => {
      const role = typeof msg?.role === "string" ? msg.role : void 0;
      if (role !== "user")
        return false;
      const text = extractText(msg.content) ?? "";
      return /\[Discord /i.test(text) || /channel:discord/i.test(text);
    });
    if (discordSignal && channelFresh && lastEffectiveSessionKey?.startsWith("channel:")) {
      inferredSessionKey = lastEffectiveSessionKey;
    }
    if (!inferredSessionKey) {
      const agentTag = ctx.agentId ?? "unknown";
      inferredSessionKey = `agent:${agentTag}:adhoc:${Date.now()}`;
    }
    const inferredChannelId = (anchorFresh ? anchor?.channelId : void 0) ?? (inferredSessionKey.startsWith("channel:") && channelFresh ? lastChannelId : void 0);

    if (!inferredSessionKey) {
    } else {
      for (const msg of messages) {
        const role = typeof msg?.role === "string" ? msg.role : void 0;
        if (role !== "assistant" && role !== "user")
          continue;
        const content = extractText(msg.content);
        if (!content || !content.trim())
          continue;
        const cleanedContent = sanitizeMessageContent(content);
        if (!cleanedContent)
          continue;
        if (isClassifierPayloadText(cleanedContent))
          continue;
        const summary = summarize(cleanedContent);
        const isJsonLike = cleanedContent.trim().startsWith("{") && (cleanedContent.includes("\"window\"") || cleanedContent.includes("\"topic\"") || cleanedContent.includes("\"candidateTopics\""));
        if (isJsonLike)
          continue;
        const isChannelSession = inferredSessionKey.startsWith("channel:");
        if (role === "user" && isChannelSession && channelFresh) {
          const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${summary}`;
          if (recentIncoming.has(dedupeKey))
            continue;
        }
        if (role === "assistant") {
          const dedupeKey = `sending:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${summary}`;
          if (recentOutgoing.has(dedupeKey))
            continue;
          rememberOutgoing(dedupeKey);
          await send({
            topicId,
            taskId,
            type: "conversation",
            content: cleanedContent,
            summary,
            raw: truncateRaw(cleanedContent),
            agentId,
            agentLabel,
            source: {
              channel: inferredChannelId,
              sessionKey: inferredSessionKey
            }
          });
        } else {
          const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${summary}`;
          if (recentIncoming.has(dedupeKey))
            continue;
          rememberIncoming(dedupeKey);
          await send({
            topicId,
            taskId,
            type: "conversation",
            content: cleanedContent,
            summary,
            raw: truncateRaw(cleanedContent),
            agentId: "user",
            agentLabel: "User",
            source: {
              channel: inferredChannelId,
              sessionKey: inferredSessionKey
            }
          });
        }
      }
    }

    if (!event.success || debug) {
      await send({
        topicId,
        taskId,
        type: "action",
        content: event.success ? "Agent run complete" : "Agent run failed",
        summary: event.success ? "Agent run complete" : "Agent run failed",
        raw: JSON.stringify(payload, null, 2),
        agentId: ctx.agentId,
        agentLabel: ctx.agentId ? `Agent ${ctx.agentId}` : "Agent",
        source: {
          sessionKey: ctx.sessionKey,
        },
      });
    }
  });
}
