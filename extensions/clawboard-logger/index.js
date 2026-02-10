import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import { computeEffectiveSessionKey, parseBoardSessionKey } from "./session-key.js";
import { getIgnoreSessionPrefixesFromEnv, shouldIgnoreSessionKey } from "./ignore-session.js";
export { computeEffectiveSessionKey, parseBoardSessionKey };

const DEFAULT_QUEUE = path.join(os.homedir(), ".openclaw", "clawboard-queue.sqlite");
const SUMMARY_MAX = 72;
const RAW_MAX = 5000;
const DEFAULT_CONTEXT_MAX_CHARS = 2200;
const DEFAULT_CONTEXT_TOPIC_LIMIT = 3;
const DEFAULT_CONTEXT_TASK_LIMIT = 3;
const DEFAULT_CONTEXT_LOG_LIMIT = 6;
const CLAWBOARD_CONTEXT_BEGIN = "[CLAWBOARD_CONTEXT_BEGIN]";
const CLAWBOARD_CONTEXT_END = "[CLAWBOARD_CONTEXT_END]";
const IGNORE_SESSION_PREFIXES = getIgnoreSessionPrefixesFromEnv(process.env);

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
  // OpenClaw/CLI transcripts sometimes include a local-time prefix like:
  // "[Sun 2026-02-08 09:01 EST] ..." which pollutes classifier/search signals.
  text = text.replace(/^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+[A-Za-z]{2,5}\]\s*/gim, "");
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

function dedupeFingerprint(content) {
  const normalized = sanitizeMessageContent(content).replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized)
    return "empty";
  return `${normalized.slice(0, 220)}|${normalized.length}`;
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
  if (markers.some((marker) => text.includes(marker)))
    return true;

  const controlMarkers = ["\"createTopic\"", "\"createTask\"", "\"topicId\"", "\"taskId\""];
  let hits = 0;
  for (const marker of controlMarkers) {
    if (text.includes(marker))
      hits += 1;
  }
  return hits >= 2;
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
  const contextMode = typeof rawConfig.contextMode === "string" && ["auto", "cheap", "full", "patient"].includes(rawConfig.contextMode) ? rawConfig.contextMode : "auto";
  const contextFallbackMode = typeof rawConfig.contextFallbackMode === "string" && ["auto", "cheap", "full", "patient"].includes(rawConfig.contextFallbackMode) ? rawConfig.contextFallbackMode : "cheap";
  const contextFetchTimeoutMs = typeof rawConfig.contextFetchTimeoutMs === "number" && Number.isFinite(rawConfig.contextFetchTimeoutMs) ? Math.max(200, Math.min(2e4, Math.floor(rawConfig.contextFetchTimeoutMs))) : 1200;
  const contextTotalBudgetMs = typeof rawConfig.contextTotalBudgetMs === "number" && Number.isFinite(rawConfig.contextTotalBudgetMs) ? Math.max(400, Math.min(45e3, Math.floor(rawConfig.contextTotalBudgetMs))) : 2200;
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

  let flushTimer;

  function nowMs() {
    return Date.now();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function jitter(ms) {
    const spread = Math.max(10, Math.floor(ms * 0.25));
    return ms + Math.floor((Math.random() - 0.5) * 2 * spread);
  }

  function computeBackoffMs(attempt, capMs) {
    const base = Math.min(capMs, Math.floor(250 * Math.pow(2, Math.max(0, attempt - 1))));
    return Math.max(50, jitter(base));
  }

  class SqliteQueue {
    constructor(filePath) {
      this.db = new DatabaseSync(filePath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA synchronous=NORMAL;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS clawboard_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at_ms INTEGER NOT NULL,
          next_attempt_at_ms INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL,
          last_error TEXT
        );
      `);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_clawboard_queue_next_attempt ON clawboard_queue(next_attempt_at_ms);");
      this.insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO clawboard_queue
          (created_at_ms, next_attempt_at_ms, attempts, idempotency_key, payload_json, last_error)
        VALUES
          (?1, ?2, ?3, ?4, ?5, ?6);
      `);
      this.selectStmt = this.db.prepare(`
        SELECT id, idempotency_key as idempotencyKey, payload_json as payloadJson, attempts
        FROM clawboard_queue
        WHERE next_attempt_at_ms <= ?1
        ORDER BY id ASC
        LIMIT ?2;
      `);
      this.deleteStmt = this.db.prepare("DELETE FROM clawboard_queue WHERE id = ?1;");
      this.failStmt = this.db.prepare(`
        UPDATE clawboard_queue
        SET attempts = ?2, next_attempt_at_ms = ?3, last_error = ?4
        WHERE id = ?1;
      `);
    }
    enqueue(idempotencyKey, payload, error) {
      const ts = nowMs();
      this.insertStmt.run(ts, ts, 0, idempotencyKey, JSON.stringify(payload), String(error).slice(0, 1200));
    }
    pickDue(limit) {
      const rows = this.selectStmt.all(nowMs(), Math.max(1, Math.min(200, limit)));
      return rows ?? [];
    }
    markSent(id) {
      this.deleteStmt.run(id);
    }
    markFailed(id, attempts, nextAttemptAtMs, error) {
      this.failStmt.run(id, attempts, nextAttemptAtMs, String(error).slice(0, 1200));
    }
  }

  let queueDb;

  async function getQueueDb() {
    if (queueDb) return queueDb;
    await ensureDir(queuePath);
    queueDb = new SqliteQueue(queuePath);
    return queueDb;
  }

  function ensureIdempotencyKey(payload) {
    const existing = payload.idempotencyKey;
    if (typeof existing === "string" && existing.trim().length > 0) return existing.trim();

    const source = payload.source ?? void 0;
    const channel = typeof source?.channel === "string" ? source.channel.trim() : "";
    const sessionKey = typeof source?.sessionKey === "string" ? source.sessionKey.trim() : "";
    const messageId = typeof source?.messageId === "string" ? source.messageId.trim() : "";
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
    const type = typeof payload.type === "string" ? payload.type : "";

    if (messageId) {
      const scope = sessionKey || "na";
      const key = `clawboard:${channel || "na"}:${scope}:${messageId}:${agentId || "na"}:${type || "log"}`;
      payload.idempotencyKey = key;
      return key;
    }

    const relatedLogId = typeof payload.relatedLogId === "string" ? payload.relatedLogId : "";
    const content = typeof payload.content === "string" ? payload.content : "";
    const summary = typeof payload.summary === "string" ? payload.summary : "";
    const raw = typeof payload.raw === "string" ? payload.raw : "";
    const fingerprint = dedupeFingerprint(content || summary || raw);

    const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : "";
    const seed = `${sessionKey}|${channel}|${agentId}|${type}|${relatedLogId}|${fingerprint}|${createdAt}`;
    const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
    const key = `clawboard:fp:${digest}`;
    payload.idempotencyKey = key;
    return key;
  }

  function stableAgentEndMessageId(opts) {
    const seed = opts.rawId
      ? `${opts.sessionKey}|${opts.role}|${opts.rawId}`
      : `${opts.sessionKey}|${opts.role}|${opts.index}|${opts.fingerprint}`;
    const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
    return `oc:${digest}`;
  }

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
    const route = parseBoardSessionKey(sessionKey);
    if (route?.topicId)
      return route.topicId;
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

  function resolveTaskId(sessionKey) {
    const route = parseBoardSessionKey(sessionKey);
    if (route?.kind === "topic")
      return void 0;
    if (route?.kind === "task")
      return route.taskId;
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

  // When Clawboard isn't reachable (common during local dev restarts and during purge),
  // Node's fetch throws (often: "TypeError: fetch failed"). Don't spam the logs.
  const SEND_WARN_INTERVAL_MS = 3e4;
  let lastSendWarnAt = 0;
  let lastSendWarnSig = "";
  let suppressedSendWarns = 0;

  function formatSendError(err) {
    if (err instanceof Error) {
      const msg = err.message || String(err);
      const cause = err.cause;
      if (cause && typeof cause === "object") {
        const code = typeof cause.code === "string" ? cause.code : void 0;
        const cmsg = typeof cause.message === "string" ? cause.message : void 0;
        if (code || cmsg)
          return `${msg} (cause: ${code ? `${code} ` : ""}${cmsg ?? ""}`.trim() + ")";
      }
      return msg;
    }
    return String(err);
  }

  function warnSendFailure(err) {
    const now = nowMs();
    const sig = formatSendError(err);
    suppressedSendWarns += 1;
    const shouldLog = lastSendWarnAt === 0 || sig !== lastSendWarnSig || now - lastSendWarnAt >= SEND_WARN_INTERVAL_MS;
    if (!shouldLog) return;

    const suppressed = Math.max(0, suppressedSendWarns - 1);
    const suffix = suppressed > 0 ? ` (suppressed ${suppressed} similar error(s))` : "";
    api.logger.warn(`[clawboard-logger] failed to send log: ${sig}${suffix}`);
    lastSendWarnAt = now;
    lastSendWarnSig = sig;
    suppressedSendWarns = 0;
  }

  async function postLog(payload) {
    const idempotencyKey = ensureIdempotencyKey(payload);
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8e3);
      const res = await fetch(`${baseUrl}${ingestPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Clawboard-Token": token } : {}),
          "X-Idempotency-Key": idempotencyKey,
        },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      clearTimeout(t);
      return res.ok;
    } catch (err) {
      warnSendFailure(err);
      return false;
    }
  }

  async function postLogWithRetry(payload) {
    const deadline = nowMs() + 1e4;
    let attempt = 0;
    while (true) {
      attempt += 1;
      const ok = await postLog(payload);
      if (ok) return true;
      if (nowMs() >= deadline) return false;
      await sleep(computeBackoffMs(attempt, 2500));
    }
  }

  async function flushQueueOnce(limit = 25) {
    const db = await getQueueDb();
    const rows = db.pickDue(limit);
    if (rows.length === 0) return;

    for (const row of rows) {
      let payload;
      try {
        payload = JSON.parse(row.payloadJson);
      } catch (err) {
        db.markFailed(row.id, row.attempts + 1, nowMs() + 6e4, `json parse failed: ${String(err)}`);
        continue;
      }

      payload.idempotencyKey = row.idempotencyKey;
      const ok = await postLog(payload);
      if (ok) {
        db.markSent(row.id);
        continue;
      }

      const attempts = row.attempts + 1;
      const backoff = computeBackoffMs(attempts, 3e5);
      db.markFailed(row.id, attempts, nowMs() + backoff, "send failed");
    }
  }

  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      await flushQueueOnce(50);
    } finally {
      flushing = false;
    }
  }

  function ensureFlushLoop() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      flushQueue().catch(() => undefined);
    }, 2e3);
    flushTimer?.unref?.();
  }

  async function enqueueDurable(payload, error) {
    const db = await getQueueDb();
    const idempotencyKey = ensureIdempotencyKey(payload);
    db.enqueue(idempotencyKey, payload, error);
    ensureFlushLoop();
  }

  async function send(payload) {
    ensureIdempotencyKey(payload);
    const ok = await postLogWithRetry(payload);
    if (!ok) {
      await enqueueDurable(payload, "retry window exceeded");
      return;
    }
    ensureFlushLoop();
    await flushQueue();
  }

  let sendChain = Promise.resolve();

  function sendAsync(payload) {
    sendChain = sendChain.then(() => send(payload)).catch((err) => {
      warnSendFailure(err);
    });
  }

  ensureFlushLoop();
  flushQueue().catch(() => undefined);

  // Startup marker (helps verify the running code version and routing behavior).
  send({
    type: "action",
    content: "clawboard-logger startup: routing enabled",
    summary: "clawboard-logger startup",
    raw: JSON.stringify(
      { autoTopicBySession, defaultTopicId, defaultTaskId, contextAugment, contextMode, contextFallbackMode, contextFetchTimeoutMs, contextTotalBudgetMs, contextMaxChars },
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
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), contextFetchTimeoutMs);
      const res = await fetch(url.toString(), { headers: apiHeaders, signal: controller.signal });
      clearTimeout(t);
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

  function toolJsonResult(payload) {
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload
    };
  }

  async function toolFetchJson(params) {
    const method = (params.method || "GET").toUpperCase();
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 8e3;
    try {
      const url = new URL(`${baseUrl}${params.pathname}`);
      if (params.query) {
        for (const [key, value] of Object.entries(params.query)) {
          if (value === void 0 || value === null || value === "")
            continue;
          url.searchParams.set(key, String(value));
        }
      }
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url.toString(), {
        method,
        headers: apiHeaders,
        signal: controller.signal,
        ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(params.body ?? {}) })
      });
      clearTimeout(t);
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text ? { raw: text } : null;
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: { error: String(err) } };
    }
  }

  function coerceBool(value, fallback = false) {
    if (typeof value === "boolean")
      return value;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes" || v === "on")
        return true;
      if (v === "false" || v === "0" || v === "no" || v === "off")
        return false;
    }
    return fallback;
  }

  function coerceInt(value, fallback, min, max) {
    let n = void 0;
    if (typeof value === "number" && Number.isFinite(value))
      n = Math.floor(value);
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed))
        n = parsed;
    }
    if (n === void 0)
      return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function registerAgentTools() {
    if (typeof api.registerTool !== "function")
      return;
    api.registerTool(
      (ctxTool) => {
        const defaultSessionKey = typeof ctxTool?.sessionKey === "string" ? ctxTool.sessionKey : void 0;
        const agentId = typeof ctxTool?.agentId === "string" ? ctxTool.agentId : void 0;
        const tools = [];
        tools.push({
          name: "clawboard_search",
          label: "Clawboard Search",
          description: "Search Clawboard topics, tasks, logs, and curated notes (hybrid semantic + lexical).",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              q: { type: "string", description: "Search query." },
              sessionKey: { type: "string", description: "Optional continuity session key override." },
              topicId: { type: "string", description: "Optional topic scope restriction." },
              includePending: { type: "boolean", description: "Include pending (unclassified) logs." },
              limitTopics: { type: "integer", description: "Max topic matches." },
              limitTasks: { type: "integer", description: "Max task matches." },
              limitLogs: { type: "integer", description: "Max log matches." }
            },
            required: ["q"]
          },
          async execute(_toolCallId, params) {
            const q = typeof params.q === "string" ? params.q.trim() : "";
            if (!q)
              return toolJsonResult({ ok: false, error: "q required" });
            const sk = typeof params.sessionKey === "string" && params.sessionKey.trim() ? params.sessionKey.trim() : defaultSessionKey;
            const includePending = coerceBool(params.includePending, true);
            const topicId = typeof params.topicId === "string" ? params.topicId.trim() : "";
            const limitTopics = coerceInt(params.limitTopics, 24, 1, 2e3);
            const limitTasks = coerceInt(params.limitTasks, 48, 1, 5e3);
            const limitLogs = coerceInt(params.limitLogs, 360, 10, 5e3);
            const res = await toolFetchJson({
              pathname: "/api/search",
              query: {
                q,
                sessionKey: sk,
                topicId: topicId || void 0,
                includePending,
                limitTopics,
                limitTasks,
                limitLogs
              }
            });
            return toolJsonResult(res);
          }
        });
        tools.push({
          name: "clawboard_context",
          label: "Clawboard Context",
          description: "Get a prompt-ready layered context block from Clawboard (working set + continuity + optional recall).",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              q: { type: "string", description: "Current user query or retrieval hint (optional)." },
              sessionKey: { type: "string", description: "Optional continuity session key override." },
              mode: { type: "string", description: "auto|cheap|full|patient (default auto)." },
              maxChars: { type: "integer", description: "Max chars for returned block." },
              workingSetLimit: { type: "integer", description: "Working set item limit." },
              timelineLimit: { type: "integer", description: "Timeline line limit." }
            }
          },
          async execute(_toolCallId, params) {
            const q = typeof params.q === "string" ? params.q.trim() : "";
            const sk = typeof params.sessionKey === "string" && params.sessionKey.trim() ? params.sessionKey.trim() : defaultSessionKey;
            const mode = typeof params.mode === "string" && params.mode.trim() ? params.mode.trim() : "auto";
            const maxChars = coerceInt(params.maxChars, 6e3, 400, 12e3);
            const workingSetLimit = coerceInt(params.workingSetLimit, 8, 0, 40);
            const timelineLimit = coerceInt(params.timelineLimit, 8, 0, 40);
            const res = await toolFetchJson({
              pathname: "/api/context",
              query: {
                q: q || "current conversation continuity, active topics, active tasks, and curated notes",
                sessionKey: sk,
                mode,
                maxChars,
                workingSetLimit,
                timelineLimit
              }
            });
            return toolJsonResult(res);
          }
        });
        tools.push({
          name: "clawboard_get_topic",
          label: "Get Clawboard Topic",
          description: "Fetch a Clawboard topic by id.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string", description: "Topic id." } },
            required: ["id"]
          },
          async execute(_toolCallId, params) {
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (!id)
              return toolJsonResult({ ok: false, error: "id required" });
            const res = await toolFetchJson({ pathname: `/api/topics/${encodeURIComponent(id)}` });
            return toolJsonResult(res);
          }
        });
        tools.push({
          name: "clawboard_get_task",
          label: "Get Clawboard Task",
          description: "Fetch a Clawboard task by id.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string", description: "Task id." } },
            required: ["id"]
          },
          async execute(_toolCallId, params) {
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (!id)
              return toolJsonResult({ ok: false, error: "id required" });
            const res = await toolFetchJson({ pathname: `/api/tasks/${encodeURIComponent(id)}` });
            return toolJsonResult(res);
          }
        });
        tools.push({
          name: "clawboard_get_log",
          label: "Get Clawboard Log",
          description: "Fetch a Clawboard log entry by id (optionally including raw payload).",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "Log id." },
              includeRaw: { type: "boolean", description: "Include raw payload (can be large)." }
            },
            required: ["id"]
          },
          async execute(_toolCallId, params) {
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (!id)
              return toolJsonResult({ ok: false, error: "id required" });
            const includeRaw = coerceBool(params.includeRaw, false);
            const res = await toolFetchJson({
              pathname: `/api/log/${encodeURIComponent(id)}`,
              query: { includeRaw }
            });
            return toolJsonResult(res);
          }
        });
        tools.push({
          name: "clawboard_create_note",
          label: "Create Clawboard Note",
          description: "Create a curated note attached to an existing log entry (high-weight retrieval signal).",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              relatedLogId: { type: "string", description: "Log id this note attaches to." },
              text: { type: "string", description: "Note text (concise, durable, factual)." },
              topicId: { type: "string", description: "Optional explicit topic id." },
              taskId: { type: "string", description: "Optional explicit task id." }
            },
            required: ["relatedLogId", "text"]
          },
          async execute(_toolCallId, params) {
            const relatedLogId = typeof params.relatedLogId === "string" ? params.relatedLogId.trim() : "";
            const text = typeof params.text === "string" ? sanitizeMessageContent(params.text).trim() : "";
            if (!relatedLogId)
              return toolJsonResult({ ok: false, error: "relatedLogId required" });
            if (!text)
              return toolJsonResult({ ok: false, error: "text required" });
            const clipped = clip(text, 1600);
            const topicId = typeof params.topicId === "string" ? params.topicId.trim() : "";
            const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
            const payload = {
              type: "note",
              relatedLogId,
              topicId: topicId || void 0,
              taskId: taskId || void 0,
              content: clipped,
              summary: summarize(clipped),
              createdAt: new Date().toISOString(),
              agentId: agentId || "assistant",
              agentLabel: "OpenClaw",
              source: {
                sessionKey: defaultSessionKey
              }
            };
            const res = await toolFetchJson({
              pathname: "/api/log",
              method: "POST",
              body: payload
            });
            return toolJsonResult(res);
          }
        });
        tools.push({
          name: "clawboard_update_task",
          label: "Update Clawboard Task",
          description: "Patch a task (status/priority/due/pin/snooze/tags) without needing the full task payload.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "Task id." },
              status: { type: "string", description: "todo|doing|blocked|done" },
              priority: { type: "string", description: "low|medium|high" },
              dueDate: { type: "string", description: "ISO due date" },
              pinned: { type: "boolean", description: "Pin/unpin task" },
              snoozedUntil: { type: "string", description: "ISO snooze-until timestamp (nullable string to clear)" },
              tags: { type: "array", items: { type: "string" }, description: "Tags list" }
            },
            required: ["id"]
          },
          async execute(_toolCallId, params) {
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (!id)
              return toolJsonResult({ ok: false, error: "id required" });
            const patch = {};
            if (typeof params.status === "string" && params.status.trim())
              patch.status = params.status.trim();
            if (typeof params.priority === "string" && params.priority.trim())
              patch.priority = params.priority.trim();
            if (typeof params.dueDate === "string" && params.dueDate.trim())
              patch.dueDate = params.dueDate.trim();
            if (typeof params.pinned === "boolean")
              patch.pinned = params.pinned;
            if (typeof params.snoozedUntil === "string")
              patch.snoozedUntil = params.snoozedUntil.trim() || null;
            if (Array.isArray(params.tags))
              patch.tags = params.tags.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean);
            if (Object.keys(patch).length === 0)
              return toolJsonResult({ ok: false, error: "no patch fields provided" });
            const res = await toolFetchJson({
              pathname: `/api/tasks/${encodeURIComponent(id)}`,
              method: "PATCH",
              body: patch
            });
            return toolJsonResult(res);
          }
        });
        return tools;
      },
      {
        names: [
          "clawboard_search",
          "clawboard_context",
          "clawboard_get_topic",
          "clawboard_get_task",
          "clawboard_get_log",
          "clawboard_create_note",
          "clawboard_update_task"
        ]
      }
    );
  }

  registerAgentTools();

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

  async function retrieveContextViaContextApi(query, sessionKey, mode = "auto") {
    const normalizedQuery = clip(normalizeWhitespace(sanitizeMessageContent(query)), 500);
    if (!normalizedQuery)
      return void 0;
    const payload = await getJson("/api/context", {
      q: normalizedQuery,
      sessionKey,
      mode,
      includePending: 1,
      maxChars: contextMaxChars,
      workingSetLimit: Math.max(6, contextTaskLimit),
      timelineLimit: contextLogLimit
    });
    if (!payload || typeof payload !== "object")
      return void 0;
    const block = payload.block;
    if (typeof block === "string" && block.trim().length > 0)
      return block.trim();
    return void 0;
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
    const cleanInput = sanitizeMessageContent(input ?? "");
    const effectiveSessionKey = computeEffectiveSessionKey(void 0, ctx);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
      return;
    if (cleanInput && isClassifierPayloadText(cleanInput))
      return;
    const retrievalQuery = cleanInput && cleanInput.trim().length > 0 ? clip(cleanInput, 320) : "current conversation continuity, active topics, active tasks, and curated notes";
    const upstream = extractUpstreamMemorySignals(event.prompt, event.messages);
    const startedAt = nowMs();
    const sessionKeyForContext = effectiveSessionKey ?? ctx?.sessionKey;
    const primaryMode = contextMode;
    let context = await retrieveContextViaContextApi(retrievalQuery, sessionKeyForContext, primaryMode);
    if (!context && contextFallbackMode !== primaryMode) {
      const remaining = Math.max(0, contextTotalBudgetMs - (nowMs() - startedAt));
      if (remaining > 150) {
        context = await retrieveContextViaContextApi(retrievalQuery, sessionKeyForContext, contextFallbackMode);
      }
    }
    if (!context) {
      const remaining = Math.max(0, contextTotalBudgetMs - (nowMs() - startedAt));
      if (remaining > 250) {
        context = await Promise.race([
          retrieveContext(retrievalQuery, sessionKeyForContext, upstream),
          sleep(remaining).then(() => void 0)
        ]);
      }
    }
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
  const agentEndCursorBySession = /* @__PURE__ */ new Map();

  const resolveSessionKey = (meta, ctx2) => {
    return computeEffectiveSessionKey(meta, ctx2);
  };

  api.on("message_received", async (event, ctx) => {
    const createdAt = new Date().toISOString();
    const raw = event.content ?? "";
    const cleanRaw = sanitizeMessageContent(raw);
    if (isClassifierPayloadText(cleanRaw))
      return;
    if (!cleanRaw)
      return;
    const meta = event.metadata ?? undefined;
    const effectiveSessionKey = resolveSessionKey(meta, ctx);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
      return;
    if (parseBoardSessionKey(effectiveSessionKey ?? ctx?.sessionKey))
      return;
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
    const taskId = resolveTaskId(effectiveSessionKey);

    const metaSummary = meta?.summary;
    const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);
    const messageId = typeof meta?.messageId === "string" ? meta.messageId : void 0;
    const incomingKey = messageId ? `received:${ctx.channelId ?? "nochannel"}:${effectiveSessionKey ?? ""}:${messageId}` : null;
    if (incomingKey && recentIncoming.has(incomingKey))
      return;
    if (incomingKey)
      rememberIncoming(incomingKey);

    sendAsync({
      topicId,
      taskId,
      type: "conversation",
      content: cleanRaw,
      summary,
      raw: truncateRaw(cleanRaw),
      createdAt,
      agentId: "user",
      agentLabel: "User",
      source: {
        channel: ctx.channelId,
        sessionKey: effectiveSessionKey,
        messageId,
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
    const createdAt = new Date().toISOString();
    const raw = event.content ?? "";
    const cleanRaw = sanitizeMessageContent(raw);
    if (isClassifierPayloadText(cleanRaw))
      return;
    if (!cleanRaw)
      return;
    const meta = event.metadata ?? void 0;
    const effectiveSessionKey = resolveSessionKey(meta, ctx);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
      return;
    const topicId = await resolveTopicId(effectiveSessionKey);
    const taskId = resolveTaskId(effectiveSessionKey);
    const agentId = "assistant";
    const agentLabel = resolveAgentLabel(ctx.agentId, meta?.sessionKey ?? ctx?.sessionKey);
    const metaSummary = meta?.summary;
    const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);
    const messageId = typeof meta?.messageId === "string" ? meta.messageId : void 0;
    const dedupeKey = messageId ? `sending:${ctx.channelId ?? "nochannel"}:${effectiveSessionKey ?? ""}:${messageId}` : null;
    if (dedupeKey && recentOutgoing.has(dedupeKey))
      return;
    if (dedupeKey)
      rememberOutgoing(dedupeKey);
    sendAsync({
      topicId,
      taskId,
      type: "conversation",
      content: cleanRaw,
      summary,
      raw: truncateRaw(cleanRaw),
      createdAt,
      agentId,
      agentLabel,
      source: {
        channel: ctx.channelId,
        sessionKey: effectiveSessionKey,
        messageId
      }
    });
  });

  api.on("message_sent", async (event, ctx) => {
    const raw = sanitizeMessageContent(event.content ?? "");
    const meta = event ?? {};
    const sessionKey = meta?.sessionKey ?? ctx?.sessionKey;
    const effectiveSessionKey = sessionKey ?? (ctx.channelId ? `channel:${ctx.channelId}` : void 0);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
      return;
    const dedupeKey = `sending:${ctx.channelId ?? "nochannel"}:${effectiveSessionKey ?? ""}:${dedupeFingerprint(raw)}`;
    if (recentOutgoing.has(dedupeKey))
      return;
  });

  api.on("before_tool_call", async (event, ctx) => {
    const createdAt = new Date().toISOString();
    const redacted = redact(event.params);
    const effectiveSessionKey = resolveSessionKey(void 0, ctx);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
      return;
    const topicId = await resolveTopicId(effectiveSessionKey);
    const taskId = resolveTaskId(effectiveSessionKey);

    sendAsync({
      topicId,
      taskId,
      type: "action",
      content: `Tool call: ${event.toolName}`,
      summary: `Tool call: ${event.toolName}`,
      raw: JSON.stringify(redacted, null, 2),
      createdAt,
      agentId: ctx.agentId,
      agentLabel: resolveAgentLabel(ctx.agentId, effectiveSessionKey ?? ctx.sessionKey),
      source: {
        channel: ctx.channelId,
        sessionKey: effectiveSessionKey,
      },
    });
  });

  api.on("after_tool_call", async (event, ctx) => {
    const createdAt = new Date().toISOString();
    const payload = event.error ? { error: event.error } : { result: redact(event.result), durationMs: event.durationMs };
    const effectiveSessionKey = resolveSessionKey(void 0, ctx);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
      return;
    const topicId = await resolveTopicId(effectiveSessionKey);
    const taskId = resolveTaskId(effectiveSessionKey);

    sendAsync({
      topicId,
      taskId,
      type: "action",
      content: event.error ? `Tool error: ${event.toolName}` : `Tool result: ${event.toolName}`,
      summary: event.error ? `Tool error: ${event.toolName}` : `Tool result: ${event.toolName}`,
      raw: JSON.stringify(payload, null, 2),
      createdAt,
      agentId: ctx.agentId,
      agentLabel: resolveAgentLabel(ctx.agentId, effectiveSessionKey ?? ctx.sessionKey),
      source: {
        channel: ctx.channelId,
        sessionKey: effectiveSessionKey,
      },
    });
  });

  api.on("agent_end", async (event, ctx) => {
    const createdAtBaseMs = Date.now();
    const createdAt = new Date(createdAtBaseMs).toISOString();
    const payload = {
      success: event.success,
      error: event.error,
      durationMs: event.durationMs,
      messageCount: event.messages?.length ?? 0,
    };

    const messages = Array.isArray(event.messages) ? event.messages : [];

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
    if (shouldIgnoreSessionKey(inferredSessionKey, IGNORE_SESSION_PREFIXES))
      return;
    const inferredChannelId = (anchorFresh ? anchor?.channelId : void 0) ?? (inferredSessionKey.startsWith("channel:") && channelFresh ? lastChannelId : void 0);
    const sourceChannel = inferredChannelId ?? ctx.channelId ?? (typeof ctx.messageProvider === "string" ? ctx.messageProvider : void 0) ?? (typeof ctx.provider === "string" ? ctx.provider : void 0) ?? "direct";

    const topicId = await resolveTopicId(inferredSessionKey);
    const taskId = resolveTaskId(inferredSessionKey);

    const agentId = "assistant";
    const agentLabel = resolveAgentLabel(ctx.agentId, inferredSessionKey);

    if (debug) {
      try {
        const shape = messages.slice(-20).map((m) => ({
          role: typeof m?.role === "string" ? m.role : typeof m?.role,
          contentType: Array.isArray(m?.content) ? "array" : typeof m?.content,
          keys: m && typeof m === "object" ? Object.keys(m).slice(0, 12) : []
        }));
        sendAsync({
          topicId,
          taskId,
          type: "action",
          content: "clawboard-logger: agent_end message shape",
          summary: "clawboard-logger: agent_end message shape",
          raw: JSON.stringify(shape, null, 2),
          createdAt,
          agentId: "system",
          agentLabel: "Clawboard Logger",
          source: { channel: inferredChannelId, sessionKey: inferredSessionKey }
        });
      } catch {
      }
    }

    if (!inferredSessionKey) {
    } else {
      const isChannelSession = inferredSessionKey.startsWith("channel:");
      const isBoardSession = Boolean(parseBoardSessionKey(inferredSessionKey));
      let startIdx = 0;
      if (!isChannelSession) {
        const prev = agentEndCursorBySession.get(inferredSessionKey);
        if (typeof prev === "number" && Number.isFinite(prev)) {
          startIdx = Math.max(0, Math.floor(prev));
        } else {
          startIdx = Math.max(0, messages.length - 24);
        }
      if (startIdx > messages.length)
        startIdx = Math.max(0, messages.length - 24);
    }

      let agentEndSeq = 0;

      for (let idx = startIdx; idx < messages.length; idx += 1) {
        const msg = messages[idx];
        const role = typeof msg?.role === "string" ? msg.role : void 0;
        if (role !== "assistant" && role !== "user")
          continue;
        if (isBoardSession && role === "user")
          continue;
        if (isChannelSession && role === "user")
          continue;
        const content = extractText(msg.content);
        if (!content || !content.trim())
          continue;
        const cleanedContent = sanitizeMessageContent(content);
        if (!cleanedContent)
          continue;
        if (isClassifierPayloadText(cleanedContent))
          continue;
        if (cleanedContent.trim() === "NO_REPLY")
          continue;
        const summary = summarize(cleanedContent);
        const fingerprint = dedupeFingerprint(cleanedContent);
        const rawId = typeof msg?.id === "string" ? msg.id : void 0;
        const messageId = stableAgentEndMessageId({
          sessionKey: inferredSessionKey,
          role,
          index: idx,
          fingerprint,
          rawId
        });
        const isJsonLike = cleanedContent.trim().startsWith("{") && (cleanedContent.includes("\"window\"") || cleanedContent.includes("\"topic\"") || cleanedContent.includes("\"candidateTopics\""));
        if (isJsonLike)
          continue;
        if (role === "user" && isChannelSession && channelFresh) {
          const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${messageId}`;
          if (recentIncoming.has(dedupeKey))
            continue;
        }
        if (role === "assistant") {
          const dedupeKey = `sending:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${messageId}`;
          if (recentOutgoing.has(dedupeKey))
            continue;
          rememberOutgoing(dedupeKey);
          const messageCreatedAt = new Date(createdAtBaseMs + agentEndSeq).toISOString();
          agentEndSeq += 1;
          sendAsync({
            topicId,
            taskId,
            type: "conversation",
            content: cleanedContent,
            summary,
            raw: truncateRaw(cleanedContent),
            createdAt: messageCreatedAt,
            agentId,
            agentLabel,
            source: {
              channel: sourceChannel,
              sessionKey: inferredSessionKey,
              messageId
            }
          });
        } else {
          const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${messageId}`;
          if (recentIncoming.has(dedupeKey))
            continue;
          rememberIncoming(dedupeKey);
          const messageCreatedAt = new Date(createdAtBaseMs + agentEndSeq).toISOString();
          agentEndSeq += 1;
          sendAsync({
            topicId,
            taskId,
            type: "conversation",
            content: cleanedContent,
            summary,
            raw: truncateRaw(cleanedContent),
            createdAt: messageCreatedAt,
            agentId: "user",
            agentLabel: "User",
            source: {
              channel: sourceChannel,
              sessionKey: inferredSessionKey,
              messageId
            }
          });
        }
      }

      if (!isChannelSession) {
        agentEndCursorBySession.set(inferredSessionKey, messages.length);
      }
    }

    if (!event.success || debug) {
      sendAsync({
        topicId,
        taskId,
        type: "action",
        content: event.success ? "Agent run complete" : "Agent run failed",
        summary: event.success ? "Agent run complete" : "Agent run failed",
        raw: JSON.stringify(payload, null, 2),
        createdAt,
        agentId: ctx.agentId,
        agentLabel: ctx.agentId ? `Agent ${ctx.agentId}` : "Agent",
        source: {
          channel: sourceChannel,
          sessionKey: inferredSessionKey,
        },
      });
    }
  });
}
