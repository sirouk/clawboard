import type {
  OpenClawPluginApi,
  PluginHookBeforeAgentStartEvent,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSentEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookAgentEndEvent,
  PluginHookMessageContext,
  PluginHookToolContext,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk";

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

type ClawboardLoggerConfig = {
  baseUrl: string;
  token?: string;
  enabled?: boolean;
  debug?: boolean;
  queuePath?: string;
  /** Optional: send logs to /api/ingest for async queueing. */
  queue?: boolean;
  /** Optional: override ingest path (default /api/log or /api/ingest when queue=true). */
  ingestPath?: string;
  /** Optional: force all logs into a single topic. */
  defaultTopicId?: string;
  /** Optional: force all logs into a single task. */
  defaultTaskId?: string;
  /** When true (default), auto-create a topic per OpenClaw sessionKey and attach logs to it. */
  autoTopicBySession?: boolean;
  /** When true (default), prepend retrieved Clawboard context before agent start. */
  contextAugment?: boolean;
  /** Hard cap for prepended context characters. */
  contextMaxChars?: number;
  /** Max topics to include in context block. */
  contextTopicLimit?: number;
  /** Max tasks to include in context block. */
  contextTaskLimit?: number;
  /** Max recent conversation entries to include in context block. */
  contextLogLimit?: number;
};

const DEFAULT_QUEUE = path.join(os.homedir(), ".openclaw", "clawboard-queue.jsonl");
const SUMMARY_MAX = 72;
const RAW_MAX = 5000;
const DEFAULT_CONTEXT_MAX_CHARS = 2200;
const DEFAULT_CONTEXT_TOPIC_LIMIT = 3;
const DEFAULT_CONTEXT_TASK_LIMIT = 3;
const DEFAULT_CONTEXT_LOG_LIMIT = 6;

function normalizeBaseUrl(url: string) {
  return url.replace(/\/$/, "");
}

function sanitizeMessageContent(content: string) {
  let text = (content ?? "").replace(/\r\n?/g, "\n").trim();
  text = text.replace(/^\s*summary\s*[:\-]\s*/gim, "");
  text = text.replace(/^\[Discord [^\]]+\]\s*/gim, "");
  text = text.replace(/\[message[_\s-]?id:[^\]]+\]/gi, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function summarize(content: string) {
  const trimmed = sanitizeMessageContent(content).replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= SUMMARY_MAX) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX - 1).trim()}…`;
}

function truncateRaw(content: string) {
  if (content.length <= RAW_MAX) return content;
  return `${content.slice(0, RAW_MAX - 1)}…`;
}

function clip(text: string, limit: number) {
  const value = (text ?? "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trim()}…`;
}

function normalizeWhitespace(value: string) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function tokenSet(value: string) {
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
    "an",
  ]);
  return new Set(
    normalized
      .split(" ")
      .map((item) => item.trim())
      .filter((item) => item.length > 2 && !stop.has(item))
  );
}

function lexicalSimilarity(a: string, b: string) {
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

function extractTextLoose(value: unknown, depth = 0): string | undefined {
  if (!value || depth > 4) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractTextLoose(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length ? parts.join("\n") : undefined;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = ["text", "content", "value", "message", "output_text", "input_text"];
    const parts: string[] = [];
    for (const key of keys) {
      const extracted = extractTextLoose(obj[key], depth + 1);
      if (extracted) parts.push(extracted);
    }
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

function latestUserInput(prompt: string | undefined, messages: unknown[] | undefined) {
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as { role?: unknown; content?: unknown };
      if (typeof message?.role !== "string" || message.role !== "user") continue;
      const text = extractTextLoose(message.content);
      const clean = sanitizeMessageContent(text ?? "");
      if (clean) return clean;
    }
  }
  const fallback = sanitizeMessageContent(prompt ?? "");
  return clip(fallback, 1000);
}

function isClassifierPayloadText(content: string) {
  const text = content.trim();
  if (!text) return false;
  if (!text.startsWith("{") && !text.startsWith("```")) return false;
  const markers = ["\"window\"", "\"candidateTopics\"", "\"candidateTasks\"", "\"instructions\"", "\"summaries\""];
  return markers.some((marker) => text.includes(marker));
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[redacted-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateRaw(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
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

async function ensureDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export default function register(api: OpenClawPluginApi) {
  const rawConfig = (api.pluginConfig ?? {}) as Partial<ClawboardLoggerConfig>;
  const enabled = rawConfig.enabled !== false;
  const debug = rawConfig.debug === true;
  const baseUrl = rawConfig.baseUrl ? normalizeBaseUrl(rawConfig.baseUrl) : "";
  const token = rawConfig.token;
  const queuePath = rawConfig.queuePath ?? DEFAULT_QUEUE;
  const useQueue = rawConfig.queue === true;
  const ingestPath = (rawConfig.ingestPath as string | undefined) ?? (useQueue ? "/api/ingest" : "/api/log");
  const defaultTopicId = rawConfig.defaultTopicId;
  const defaultTaskId = rawConfig.defaultTaskId;
  // Default OFF: session buckets are not meaningful topics.
  // Stage-2 classifier will attach real topics asynchronously.
  const autoTopicBySession = rawConfig.autoTopicBySession === true;
  const contextAugment = rawConfig.contextAugment !== false;
  const contextMaxChars =
    typeof rawConfig.contextMaxChars === "number" && Number.isFinite(rawConfig.contextMaxChars)
      ? Math.max(400, Math.min(12000, Math.floor(rawConfig.contextMaxChars)))
      : DEFAULT_CONTEXT_MAX_CHARS;
  const contextTopicLimit =
    typeof rawConfig.contextTopicLimit === "number" && Number.isFinite(rawConfig.contextTopicLimit)
      ? Math.max(1, Math.min(8, Math.floor(rawConfig.contextTopicLimit)))
      : DEFAULT_CONTEXT_TOPIC_LIMIT;
  const contextTaskLimit =
    typeof rawConfig.contextTaskLimit === "number" && Number.isFinite(rawConfig.contextTaskLimit)
      ? Math.max(1, Math.min(12, Math.floor(rawConfig.contextTaskLimit)))
      : DEFAULT_CONTEXT_TASK_LIMIT;
  const contextLogLimit =
    typeof rawConfig.contextLogLimit === "number" && Number.isFinite(rawConfig.contextLogLimit)
      ? Math.max(2, Math.min(20, Math.floor(rawConfig.contextLogLimit)))
      : DEFAULT_CONTEXT_LOG_LIMIT;

  if (!enabled) {
    api.logger.warn("[clawboard-logger] disabled by config");
    return;
  }

  if (!baseUrl) {
    api.logger.warn("[clawboard-logger] baseUrl missing; plugin disabled");
    return;
  }

  let flushing = false;

  const topicCache = new Map<string, string>();

  function safeId(prefix: string, raw: string) {
    const cleaned = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return `${prefix}-${cleaned || "unknown"}`;
  }

  async function upsertTopic(topicId: string, name: string) {
    try {
      const res = await fetch(`${baseUrl}/api/topics`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Clawboard-Token": token } : {}),
        },
        body: JSON.stringify({
          id: topicId,
          name,
          tags: ["openclaw"],
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function resolveTopicId(sessionKey: string | undefined | null) {
    if (defaultTopicId) return defaultTopicId;
    if (!autoTopicBySession) return undefined;
    if (!sessionKey) return undefined;

    const cached = topicCache.get(sessionKey);
    if (cached) return cached;

    const topicId = safeId("topic-session", sessionKey);
    // Best-effort create; even if it fails, we still attach logs to the same id.
    await upsertTopic(topicId, `Session ${sessionKey}`).catch(() => undefined);
    topicCache.set(sessionKey, topicId);
    return topicId;
  }

  function resolveTaskId() {
    return defaultTaskId;
  }

  function resolveAgentLabel(agentId?: string | null, sessionKey?: string | null) {
    const fromCtx = agentId && agentId !== "agent" ? agentId : undefined;
    let fromSession: string | undefined;
    if (!fromCtx && sessionKey && sessionKey.startsWith("agent:")) {
      const parts = sessionKey.split(":");
      if (parts.length >= 2) fromSession = parts[1];
    }
    const resolved = fromCtx ?? fromSession;
    if (!resolved || resolved === "main") return "OpenClaw";
    return `Agent ${resolved}`;
  }

  async function enqueue(payload: unknown) {
    await ensureDir(queuePath);
    await fs.appendFile(queuePath, `${JSON.stringify(payload)}\n`, "utf8");
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
      const remaining: string[] = [];
      for (const line of lines) {
        try {
          const payload = JSON.parse(line) as Record<string, unknown>;
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

  async function postLog(payload: Record<string, unknown>) {
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

  async function send(payload: Record<string, unknown>) {
    const ok = await postLog(payload);
    if (!ok) {
      await enqueue(payload);
      return;
    }
    await flushQueue();
  }

  flushQueue().catch(() => undefined);

  type ApiLogEntry = {
    id?: string;
    topicId?: string | null;
    taskId?: string | null;
    relatedLogId?: string | null;
    type?: string;
    content?: string;
    summary?: string;
    raw?: string;
    createdAt?: string;
    classificationStatus?: string;
    agentId?: string;
    agentLabel?: string;
  };
  type ApiTopic = {
    id: string;
    name: string;
    description?: string | null;
  };
  type ApiTask = {
    id: string;
    topicId?: string | null;
    title: string;
    status?: string;
  };

  const apiHeaders = {
    "Content-Type": "application/json",
    ...(token ? { "X-Clawboard-Token": token } : {}),
  };

  async function getJson(pathname: string, params?: Record<string, string | number | undefined>) {
    try {
      const url = new URL(`${baseUrl}${pathname}`);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === "") continue;
          url.searchParams.set(key, String(value));
        }
      }
      const res = await fetch(url.toString(), { headers: apiHeaders });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function coerceLogs(data: unknown) {
    return Array.isArray(data) ? (data as ApiLogEntry[]) : [];
  }

  function coerceTopics(data: unknown) {
    return Array.isArray(data) ? (data as ApiTopic[]) : [];
  }

  function coerceTasks(data: unknown) {
    return Array.isArray(data) ? (data as ApiTask[]) : [];
  }

  async function listLogs(params: Record<string, string | number | undefined>) {
    const data = await getJson("/api/log", params);
    return coerceLogs(data);
  }

  async function listTopics() {
    const data = await getJson("/api/topics");
    return coerceTopics(data);
  }

  async function listTasks(topicId: string) {
    const data = await getJson("/api/tasks", { topicId });
    return coerceTasks(data);
  }

  function formatLogLine(entry: ApiLogEntry) {
    const who = (entry.agentId || "").toLowerCase() === "user" ? "User" : entry.agentLabel || entry.agentId || "Agent";
    const text = sanitizeMessageContent(entry.summary || entry.content || "");
    return `${who}: ${clip(normalizeWhitespace(text), 120)}`;
  }

  function buildContextBlock(params: {
    query: string;
    sessionLogs: ApiLogEntry[];
    topics: ApiTopic[];
    tasks: ApiTask[];
    topicRecent: Record<string, ApiLogEntry[]>;
    notes: ApiLogEntry[];
  }) {
    const { query, sessionLogs, topics, tasks, topicRecent, notes } = params;
    const lines: string[] = [];
    lines.push("Clawboard continuity context:");
    lines.push(`Current user intent: ${clip(normalizeWhitespace(query), 180)}`);

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

    const timeline = sessionLogs.filter((entry) => entry.type === "conversation").slice(0, contextLogLimit);
    if (timeline.length > 0) {
      lines.push("Recent thread timeline:");
      for (const entry of timeline) {
        lines.push(`- ${formatLogLine(entry)}`);
      }
    }

    const notesByLog = new Map<string, string[]>();
    for (const note of notes) {
      if (note.type !== "note") continue;
      const key = String(note.relatedLogId ?? "");
      if (!key) continue;
      const text = sanitizeMessageContent(note.content || note.summary || "");
      if (!text) continue;
      const existing = notesByLog.get(key) ?? [];
      if (existing.length < 2) existing.push(clip(normalizeWhitespace(text), 140));
      notesByLog.set(key, existing);
    }
    const noteLines: string[] = [];
    for (const entry of timeline) {
      if (!entry.id) continue;
      const attached = notesByLog.get(entry.id) ?? [];
      for (const noteText of attached) {
        noteLines.push(`- ${formatLogLine(entry)} | note: ${noteText}`);
      }
      if (noteLines.length >= 4) break;
    }
    if (noteLines.length > 0) {
      lines.push("Curated user notes:");
      lines.push(...noteLines.slice(0, 4));
    }

    const topicCtxLines: string[] = [];
    for (const topic of topics) {
      const recent = topicRecent[topic.id] ?? [];
      if (recent.length === 0) continue;
      topicCtxLines.push(`Topic ${topic.name}:`);
      for (const item of recent.slice(0, 2)) {
        topicCtxLines.push(`- ${formatLogLine(item)}`);
      }
      if (topicCtxLines.length >= 10) break;
    }
    if (topicCtxLines.length > 0) {
      lines.push("Topic memory:");
      lines.push(...topicCtxLines.slice(0, 10));
    }

    const block = lines.join("\n");
    return clip(block, contextMaxChars);
  }

  async function retrieveContext(query: string, sessionKey?: string) {
    const normalizedQuery = clip(normalizeWhitespace(sanitizeMessageContent(query)), 500);
    if (!normalizedQuery || normalizedQuery.length < 6) return undefined;

    const [topicsAll, sessionLogsRaw] = await Promise.all([
      listTopics(),
      sessionKey
        ? listLogs({
            sessionKey,
            type: "conversation",
            classificationStatus: "classified",
            limit: 80,
            offset: 0,
          })
        : Promise.resolve([] as ApiLogEntry[]),
    ]);

    const sessionLogs = sessionLogsRaw
      .filter((entry) => entry.type === "conversation")
      .sort((a, b) => (String(a.createdAt || "") < String(b.createdAt || "") ? 1 : -1));

    const recentTopicOrder: string[] = [];
    const recentTopicSet = new Set<string>();
    const recentTaskSet = new Set<string>();
    for (const entry of sessionLogs) {
      if (entry.topicId && !recentTopicSet.has(entry.topicId)) {
        recentTopicSet.add(entry.topicId);
        recentTopicOrder.push(entry.topicId);
      }
      if (entry.taskId) recentTaskSet.add(entry.taskId);
    }

    const topicScore = new Map<string, number>();
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

    const topics = topicsAll
      .map((topic) => ({ topic, score: topicScore.get(topic.id) ?? 0 }))
      .filter((item) => item.score > 0.12 || recentTopicSet.has(item.topic.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, contextTopicLimit)
      .map((item) => item.topic);

    const taskBuckets = await Promise.all(
      topics.map(async (topic) => {
        const [tasks, logs] = await Promise.all([
          listTasks(topic.id),
          listLogs({
            topicId: topic.id,
            type: "conversation",
            classificationStatus: "classified",
            limit: contextLogLimit,
            offset: 0,
          }),
        ]);
        return { topicId: topic.id, tasks, logs };
      })
    );

    const topicRecent: Record<string, ApiLogEntry[]> = {};
    const taskScored: Array<{ task: ApiTask; score: number }> = [];
    const relatedIds = new Set<string>();
    for (const bucket of taskBuckets) {
      topicRecent[bucket.topicId] = bucket.logs;
      for (const log of bucket.logs) {
        if (log.id) relatedIds.add(log.id);
      }
      for (const task of bucket.tasks) {
        const lexical = lexicalSimilarity(normalizedQuery, task.title || "");
        const continuityBoost = recentTaskSet.has(task.id) ? 0.25 : 0;
        taskScored.push({ task, score: lexical + continuityBoost });
      }
    }
    for (const entry of sessionLogs.slice(0, contextLogLimit + 4)) {
      if (entry.id) relatedIds.add(entry.id);
    }

    const tasks = taskScored
      .sort((a, b) => b.score - a.score)
      .filter((item, idx) => item.score > 0.08 || idx < contextTaskLimit)
      .slice(0, contextTaskLimit)
      .map((item) => item.task);

    const relatedLogId = Array.from(relatedIds).slice(0, 50).join(",");
    const notes =
      relatedLogId.length > 0
        ? await listLogs({
            type: "note",
            relatedLogId,
            limit: 120,
            offset: 0,
          })
        : [];

    const context = buildContextBlock({
      query: normalizedQuery,
      sessionLogs,
      topics,
      tasks,
      topicRecent,
      notes,
    });
    return context || undefined;
  }

  api.on("before_agent_start", async (event: PluginHookBeforeAgentStartEvent, ctx) => {
    if (!contextAugment) return;
    if (ctx?.agentId && ctx.agentId !== "main") return;
    const input = latestUserInput(event.prompt, event.messages);
    if (!input) return;
    const context = await retrieveContext(input, ctx?.sessionKey);
    if (!context) return;
    return {
      prependContext:
        "Use this Clawboard retrieval context for continuity with user intent, topics, tasks, and curated notes.\n" +
        `${context}`,
    };
  });

  // Track last seen channel so we can attribute agent_end output when the
  // provider doesn't emit outbound message hooks.
  let lastChannelId: string | undefined;
  let lastEffectiveSessionKey: string | undefined;
  let lastMessageAt = 0;
  const inboundBySession = new Map<string, { ts: number; channelId?: string; sessionKey?: string }>();

  const resolveSessionKey = (meta: { sessionKey?: string } | undefined, ctx2: PluginHookMessageContext) => {
    const metaSession = meta?.sessionKey;
    if (typeof metaSession === "string" && metaSession.startsWith("channel:")) return metaSession;
    if (ctx2?.channelId) return `channel:${ctx2.channelId}`;
    return metaSession ?? (ctx2 as unknown as { sessionKey?: string })?.sessionKey;
  };

  api.on("message_received", async (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => {
    const raw = event.content ?? "";
    const cleanRaw = sanitizeMessageContent(raw);
    if (isClassifierPayloadText(cleanRaw)) return;
    if (!cleanRaw) return;
    const meta = (event.metadata as Record<string, unknown> | undefined) ?? undefined;
    const effectiveSessionKey = resolveSessionKey(meta as { sessionKey?: string } | undefined, ctx);
    lastChannelId = ctx.channelId;
    lastEffectiveSessionKey = effectiveSessionKey;
    lastMessageAt = Date.now();
    const ctxSessionKey = (ctx as unknown as { sessionKey?: string })?.sessionKey ?? (meta?.sessionKey as string | undefined);
    if (ctxSessionKey) {
      inboundBySession.set(ctxSessionKey, {
        ts: lastMessageAt,
        channelId: ctx.channelId,
        sessionKey: effectiveSessionKey,
      });
    }
    const topicId = await resolveTopicId(effectiveSessionKey);
    const taskId = resolveTaskId();

    const metaSummary = meta?.summary;
    const summary =
      typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);
    const incomingKey = `received:${ctx.channelId ?? "nochannel"}:${effectiveSessionKey ?? ""}:${summary}`;
    rememberIncoming(incomingKey);

    await send({
      topicId,
      taskId,
      type: "conversation",
      content: cleanRaw,
      summary,
      raw: truncateRaw(cleanRaw),
      idempotencyKey: meta?.messageId ? `discord:${meta.messageId}:user:conversation` : undefined,
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

  // Outbound assistant logging: message_sending is the reliable hook.
  const recentOutgoing = new Set<string>();
  const rememberOutgoing = (key: string) => {
    recentOutgoing.add(key);
    if (recentOutgoing.size > 200) {
      const first = recentOutgoing.values().next().value;
      if (first) recentOutgoing.delete(first);
    }
    (setTimeout(() => recentOutgoing.delete(key), 30_000) as unknown as { unref?: () => void })?.unref?.();
  };
  const recentIncoming = new Set<string>();
  const rememberIncoming = (key: string) => {
    recentIncoming.add(key);
    if (recentIncoming.size > 200) {
      const first = recentIncoming.values().next().value;
      if (first) recentIncoming.delete(first);
    }
    (setTimeout(() => recentIncoming.delete(key), 30_000) as unknown as { unref?: () => void })?.unref?.();
  };

  api.on("message_sending", async (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => {
    type MessageSendingEvent = PluginHookMessageSentEvent & { metadata?: Record<string, unknown> };
    const sendEvent = event as MessageSendingEvent;
    const raw = sendEvent.content ?? "";
    const cleanRaw = sanitizeMessageContent(raw);
    if (isClassifierPayloadText(cleanRaw)) return;
    if (!cleanRaw) return;
    const meta = sendEvent.metadata ?? undefined;
    const effectiveSessionKey = resolveSessionKey(meta as { sessionKey?: string } | undefined, ctx);
    const topicId = await resolveTopicId(effectiveSessionKey);
    const taskId = resolveTaskId();

    // Outbound message content is always assistant-side.
    const agentId = "assistant";
    const agentLabel = resolveAgentLabel(ctx.agentId, (meta?.sessionKey as string | undefined) ?? (ctx as unknown as { sessionKey?: string })?.sessionKey);

    const metaSummary = meta?.summary;
    const summary =
      typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);

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
        sessionKey: effectiveSessionKey,
      },
    });
  });

  api.on("message_sent", async (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => {
    // Avoid double-logging the actual message content; we log it at message_sending.
    // This hook is kept for future delivery status tracking.
    const raw = sanitizeMessageContent(event.content ?? "");
    const meta = (event as unknown as Record<string, unknown>) ?? {};
    const sessionKey = (meta?.sessionKey as string | undefined) ?? (ctx as unknown as { sessionKey?: string })?.sessionKey;
    const effectiveSessionKey = sessionKey ?? (ctx.channelId ? `channel:${ctx.channelId}` : undefined);
    const summary = summarize(raw);
    const dedupeKey = `sending:${ctx.channelId}:${effectiveSessionKey ?? ""}:${summary}`;
    if (recentOutgoing.has(dedupeKey)) return;
  });

  api.on("before_tool_call", async (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
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

  api.on("after_tool_call", async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
    const payload = event.error
      ? { error: event.error }
      : { result: redact(event.result), durationMs: event.durationMs };

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

  api.on("agent_end", async (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
    const payload = {
      success: event.success,
      error: event.error,
      durationMs: event.durationMs,
      messageCount: event.messages?.length ?? 0,
    };

    const topicId = await resolveTopicId(ctx.sessionKey);
    const taskId = resolveTaskId();

    // Some channels/providers don't emit message_sent reliably for assistant output.
    // As a fallback, capture assistant messages from the agent_end payload.
    type HookMessage = { role?: unknown; content?: unknown; [key: string]: unknown };
    const messages: HookMessage[] = Array.isArray(event.messages) ? (event.messages as HookMessage[]) : [];

    // agent_end is always this agent's run: treat assistant-role messages as assistant output.
    const agentId = "assistant";
    const agentLabel = resolveAgentLabel(ctx.agentId, ctx.sessionKey);

    if (debug) {
      // Optional debug telemetry for message-shape inspection.
      try {
        const shape = messages.slice(-20).map((m) => ({
          role: typeof m.role === "string" ? m.role : typeof m.role,
          contentType: Array.isArray(m.content) ? "array" : typeof m.content,
          keys: m && typeof m === "object" ? Object.keys(m).slice(0, 12) : [],
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
          source: { sessionKey: ctx.sessionKey },
        });
      } catch {
        // ignore
      }
    }

    const extractText = (value: unknown, depth = 0): string | undefined => {
      if (!value || depth > 4) return undefined;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        const parts = value
          .map((part) => extractText(part, depth + 1))
          .filter((part): part is string => Boolean(part));
        return parts.length ? parts.join("\n") : undefined;
      }
      if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const keys = ["text", "content", "value", "message", "output_text", "input_text"];
        const parts: string[] = [];
        for (const key of keys) {
          const extracted = extractText(obj[key], depth + 1);
          if (extracted) parts.push(extracted);
        }
        return parts.length ? parts.join("\n") : undefined;
      }
      return undefined;
    };

    const anchor = ctx.sessionKey ? inboundBySession.get(ctx.sessionKey) : undefined;
    const anchorFresh = !!anchor && Date.now() - anchor.ts < 2 * 60_000;
    const channelFresh = Date.now() - lastMessageAt < 2 * 60_000;
    let inferredSessionKey = (anchorFresh ? anchor?.sessionKey : undefined) ?? ctx.sessionKey;
    const discordSignal = messages.some((msg) => {
      const role = typeof msg.role === "string" ? msg.role : undefined;
      if (role !== "user") return false;
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
    const inferredChannelId =
      (anchorFresh ? anchor?.channelId : undefined) ??
      (inferredSessionKey.startsWith("channel:") && channelFresh ? lastChannelId : undefined);

    if (!inferredSessionKey) {
      // No session key to attribute messages; skip conversation logs.
    } else {
      for (const msg of messages) {
      const role = typeof msg.role === "string" ? msg.role : undefined;
      if (role !== "assistant" && role !== "user") continue;

      const content = extractText(msg.content);
      if (!content || !content.trim()) continue;
      const cleanedContent = sanitizeMessageContent(content);
      if (!cleanedContent) continue;
      if (isClassifierPayloadText(cleanedContent)) continue;

      const summary = summarize(cleanedContent);
      const isChannelSession = inferredSessionKey.startsWith("channel:");
      const isJsonLike =
        cleanedContent.trim().startsWith("{") &&
        (cleanedContent.includes("\"window\"") || cleanedContent.includes("\"topic\"") || cleanedContent.includes("\"candidateTopics\""));
      if (isJsonLike) continue;
      if (role === "user" && isChannelSession && channelFresh) {
        // Prefer message_received when it fired; otherwise allow agent_end fallback.
        const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${summary}`;
        if (recentIncoming.has(dedupeKey)) continue;
      }
      if (role === "assistant") {
        const dedupeKey = `sending:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${summary}`;
        if (recentOutgoing.has(dedupeKey)) continue;
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
            sessionKey: inferredSessionKey,
          },
        });
      } else {
        const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${summary}`;
        if (recentIncoming.has(dedupeKey)) continue;
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
            sessionKey: inferredSessionKey,
          },
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
