import type {
  OpenClawPluginApi,
} from "openclaw/plugin-sdk";

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import {
  computeEffectiveSessionKey,
  isBoardSessionKey,
  parseBoardSessionKey,
} from "./session-key";
import { getIgnoreSessionPrefixesFromEnv, shouldIgnoreSessionKey } from "./ignore-session";

type HookEvent = {
  [key: string]: unknown;
};

type PluginHookBeforeAgentStartEvent = HookEvent & {
  prompt?: string;
  messages?: unknown[];
};

type PluginHookMessageReceivedEvent = HookEvent & {
  content?: string;
  metadata?: {
    sessionKey?: string;
    [key: string]: unknown;
  };
  sessionKey?: string;
};

type PluginHookMessageSentEvent = HookEvent & {
  content?: string;
  metadata?: {
    sessionKey?: string;
    [key: string]: unknown;
  };
  sessionKey?: string;
};

type PluginHookBeforeToolCallEvent = HookEvent & {
  toolName?: string;
  input?: unknown;
};

type PluginHookAfterToolCallEvent = HookEvent & {
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
};

type PluginHookAgentEndEvent = HookEvent & {
  output?: unknown;
  message?: string;
  messages?: unknown[];
};

type PluginHookContextBase = {
  agentId?: string;
  sessionKey?: string;
  channelId?: string;
  conversationId?: string;
  accountId?: string;
  messageProvider?: string;
  provider?: string;
  [key: string]: unknown;
};

type PluginHookMessageContext = PluginHookContextBase;
type PluginHookToolContext = PluginHookContextBase;
type PluginHookAgentContext = PluginHookContextBase;

type BoardScope = {
  topicId: string;
  taskId?: string;
  kind: "topic" | "task";
  sessionKey: string;
  inherited: boolean;
  updatedAt: number;
};

type RoutingScope = {
  topicId?: string;
  taskId?: string;
  boardScope?: BoardScope;
};

type ActorFlow = {
  speakerId?: string;
  speakerLabel?: string;
  audienceId?: string;
  audienceLabel?: string;
};

type ClawboardLoggerConfig = {
  baseUrl: string;
  token?: string;
  enabled?: boolean;
  debug?: boolean;
  queuePath?: string;
  /**
   * Optional: send logs to /api/ingest for async queueing (server-side).
   * Note: this is independent of the plugin's local durable queue.
   */
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
  /**
   * Context retrieval mode (passed to Clawboard `/api/context`):
   * - auto: Layer A always, Layer B conditional
   * - cheap: Layer A only
   * - full: Layer A + Layer B
   * - patient: like full, but server may use larger bounded recall limits
   */
  contextMode?: "auto" | "cheap" | "full" | "patient";
  /** Timeout (ms) for context GET calls (e.g. `/api/context`, `/api/search`) in before_agent_start. */
  contextFetchTimeoutMs?: number;
  /** Hard cap for prepended context characters. */
  contextMaxChars?: number;
  /** Max topics to include in context block. */
  contextTopicLimit?: number;
  /** Max tasks to include in context block. */
  contextTaskLimit?: number;
  /** Max recent conversation entries to include in context block. */
  contextLogLimit?: number;
};

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
const BOARD_SCOPE_TTL_MS = 15 * 60_000;

function normalizeBaseUrl(url: string) {
  return url.replace(/\/$/, "");
}

function sanitizeMessageContent(content: string) {
  let text = (content ?? "").replace(/\r\n?/g, "\n").trim();
  text = text.replace(/\[CLAWBOARD_CONTEXT_BEGIN\][\s\S]*?\[CLAWBOARD_CONTEXT_END\]\s*/gi, "");
  text = text.replace(
    /Clawboard continuity hook is active for this turn\.[\s\S]*?Prioritize curated user notes when present\.\s*/gi,
    "",
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

function summarize(content: string) {
  const trimmed = sanitizeMessageContent(content).replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= SUMMARY_MAX) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX - 1).trim()}…`;
}

function dedupeFingerprint(content: string) {
  const normalized = sanitizeMessageContent(content).replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return "empty";
  return `${normalized.slice(0, 220)}|${normalized.length}`;
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
  if (markers.some((marker) => text.includes(marker))) return true;

  // Some classifier/control payloads are smaller and don't include the "window" schema,
  // but still shouldn't be logged as chat content.
  const controlMarkers = ["\"createTopic\"", "\"createTask\"", "\"topicId\"", "\"taskId\""];
  let hits = 0;
  for (const marker of controlMarkers) {
    if (text.includes(marker)) hits += 1;
  }
  return hits >= 2;
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
  const contextMode: "auto" | "cheap" | "full" | "patient" = (
    rawConfig.contextMode && ["auto", "cheap", "full", "patient"].includes(rawConfig.contextMode)
      ? rawConfig.contextMode
      : "auto"
  );
  const contextFetchTimeoutMs =
    typeof rawConfig.contextFetchTimeoutMs === "number" && Number.isFinite(rawConfig.contextFetchTimeoutMs)
      ? Math.max(200, Math.min(20_000, Math.floor(rawConfig.contextFetchTimeoutMs)))
      : 1200;
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
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  const topicCache = new Map<string, string>();

  function nowMs() {
    return Date.now();
  }

  function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  function jitter(ms: number) {
    const spread = Math.max(10, Math.floor(ms * 0.25));
    return ms + Math.floor((Math.random() - 0.5) * 2 * spread);
  }

  function computeBackoffMs(attempt: number, capMs: number) {
    const base = Math.min(capMs, Math.floor(250 * Math.pow(2, Math.max(0, attempt - 1))));
    return Math.max(50, jitter(base));
  }

  type QueuedRow = {
    id: number;
    idempotencyKey: string;
    payloadJson: string;
    attempts: number;
  };

  class SqliteQueue {
    db: DatabaseSync;
    insertStmt: ReturnType<DatabaseSync["prepare"]>;
    selectStmt: ReturnType<DatabaseSync["prepare"]>;
    deleteStmt: ReturnType<DatabaseSync["prepare"]>;
    failStmt: ReturnType<DatabaseSync["prepare"]>;

    constructor(filePath: string) {
      this.db = new DatabaseSync(filePath);
      // Reasonable durability without being too slow.
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

    enqueue(idempotencyKey: string, payload: Record<string, unknown>, error: string) {
      const ts = nowMs();
      this.insertStmt.run(ts, ts, 0, idempotencyKey, JSON.stringify(payload), error.slice(0, 1200));
    }

    pickDue(limit: number): QueuedRow[] {
      const rows = this.selectStmt.all(nowMs(), Math.max(1, Math.min(200, limit))) as QueuedRow[];
      return rows ?? [];
    }

    markSent(id: number) {
      this.deleteStmt.run(id);
    }

    markFailed(id: number, attempts: number, nextAttemptAtMs: number, error: string) {
      this.failStmt.run(id, attempts, nextAttemptAtMs, error.slice(0, 1200));
    }
  }

  let queueDb: SqliteQueue | undefined;

  async function getQueueDb() {
    if (queueDb) return queueDb;
    await ensureDir(queuePath);
    queueDb = new SqliteQueue(queuePath);
    return queueDb;
  }

  function ensureIdempotencyKey(payload: Record<string, unknown>) {
    const existing = payload.idempotencyKey;
    if (typeof existing === "string" && existing.trim().length > 0) return existing.trim();

    const source = (payload.source as Record<string, unknown> | undefined) ?? undefined;
    const channel = typeof source?.channel === "string" ? source.channel.trim() : "";
    const sessionKey = typeof source?.sessionKey === "string" ? source.sessionKey.trim() : "";
    const messageId = typeof source?.messageId === "string" ? source.messageId.trim() : "";
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
    const type = typeof payload.type === "string" ? payload.type : "";

    if (messageId) {
      // Include sessionKey to avoid collisions on platforms where message IDs are only unique
      // per conversation (e.g. Telegram message_id).
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

    // Keep idempotency stable across retries and gateway restarts. Prefer distinct keys for
    // repeated identical messages rather than risking false dedupe (missing messages).
    const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : "";
    const seed = `${sessionKey}|${channel}|${agentId}|${type}|${relatedLogId}|${fingerprint}|${createdAt}`;
    const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
    const key = `clawboard:fp:${digest}`;
    payload.idempotencyKey = key;
    return key;
  }

  function stableAgentEndMessageId(opts: {
    sessionKey: string;
    role: string;
    index: number;
    fingerprint: string;
    rawId?: string;
  }) {
    const seed = opts.rawId
      ? `${opts.sessionKey}|${opts.role}|${opts.rawId}`
      : `${opts.sessionKey}|${opts.role}|${opts.index}|${opts.fingerprint}`;
    const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
    return `oc:${digest}`;
  }

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
    const route = parseBoardSessionKey(sessionKey);
    if (route?.topicId) return route.topicId;
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

  function resolveTaskId(sessionKey: string | undefined | null) {
    const route = parseBoardSessionKey(sessionKey);
    if (route?.kind === "topic") return undefined;
    if (route?.kind === "task") return route.taskId;
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

  const boardScopeBySession = new Map<string, BoardScope>();
  const boardScopeByAgent = new Map<string, BoardScope>();

  function normalizeId(value: string | undefined | null) {
    const text = typeof value === "string" ? value.trim() : "";
    return text || undefined;
  }

  function shortId(value: string, length = 8) {
    const clean = value.replace(/[^a-zA-Z0-9]+/g, "");
    return clean.slice(0, length) || value.slice(0, length);
  }

  function parseSubagentSession(sessionKey: string | undefined | null) {
    const key = normalizeId(sessionKey);
    if (!key || !key.startsWith("agent:")) return null;
    const parts = key.split(":");
    if (parts.length < 4) return null;
    const ownerAgentId = normalizeId(parts[1]);
    const subagentIdx = parts.indexOf("subagent");
    if (!ownerAgentId || subagentIdx < 0 || subagentIdx + 1 >= parts.length) return null;
    const subagentId = normalizeId(parts[subagentIdx + 1]);
    if (!subagentId) return null;
    return { ownerAgentId, subagentId };
  }

  function boardScopeFromSessionKey(sessionKey: string | undefined | null): BoardScope | undefined {
    const key = normalizeId(sessionKey);
    if (!key) return undefined;
    const route = parseBoardSessionKey(key);
    if (!route) return undefined;
    if (route.kind === "task") {
      return {
        topicId: route.topicId,
        taskId: route.taskId,
        kind: "task",
        sessionKey: key,
        inherited: false,
        updatedAt: nowMs(),
      };
    }
    return {
      topicId: route.topicId,
      kind: "topic",
      sessionKey: key,
      inherited: false,
      updatedAt: nowMs(),
    };
  }

  function isFreshBoardScope(scope: BoardScope | undefined, now = nowMs()) {
    return Boolean(scope && now - scope.updatedAt <= BOARD_SCOPE_TTL_MS);
  }

  function rememberBoardScope(
    scope: BoardScope,
    opts?: {
      sessionKeys?: Array<string | undefined>;
      agentIds?: Array<string | undefined>;
    },
  ) {
    const stamped: BoardScope = { ...scope, updatedAt: nowMs() };
    const sessionKeys = opts?.sessionKeys ?? [];
    for (const rawKey of sessionKeys) {
      const key = normalizeId(rawKey);
      if (!key) continue;
      boardScopeBySession.set(key, stamped);
    }
    const agentIds = opts?.agentIds ?? [];
    for (const rawAgentId of agentIds) {
      const agentId = normalizeId(rawAgentId);
      if (!agentId) continue;
      boardScopeByAgent.set(agentId, stamped);
    }
  }

  function deriveConversationFlow(params: {
    role: "user" | "assistant";
    sessionKey?: string;
    agentId?: string;
    assistantLabel?: string;
  }): ActorFlow {
    const sessionKey = normalizeId(params.sessionKey);
    const subagent = parseSubagentSession(sessionKey);
    if (subagent) {
      const ownerId = subagent.ownerAgentId;
      const ownerLabel = resolveAgentLabel(ownerId, `agent:${ownerId}`);
      const subagentSpeakerId = `subagent:${subagent.subagentId}`;
      const subagentLabel = `Subagent ${shortId(subagent.subagentId)}`;
      if (params.role === "user") {
        return {
          speakerId: ownerId,
          speakerLabel: ownerLabel,
          audienceId: subagentSpeakerId,
          audienceLabel: subagentLabel,
        };
      }
      return {
        speakerId: subagentSpeakerId,
        speakerLabel: subagentLabel,
        audienceId: ownerId,
        audienceLabel: ownerLabel,
      };
    }

    const assistantId = normalizeId(params.agentId) ?? "assistant";
    const assistantLabel = normalizeId(params.assistantLabel) ?? resolveAgentLabel(assistantId, sessionKey);
    if (params.role === "user") {
      return {
        speakerId: "user",
        speakerLabel: "User",
        audienceId: assistantId,
        audienceLabel: assistantLabel,
      };
    }
    return {
      speakerId: assistantId,
      speakerLabel: assistantLabel,
      audienceId: "user",
      audienceLabel: "User",
    };
  }

  function buildSourceMeta(params: {
    channel?: string;
    sessionKey?: string;
    messageId?: string;
    boardScope?: BoardScope;
    flow?: ActorFlow;
  }) {
    const source: Record<string, unknown> = {};
    if (params.channel !== undefined) source.channel = params.channel;
    const sessionKey = normalizeId(params.sessionKey);
    if (sessionKey) source.sessionKey = sessionKey;
    const messageId = normalizeId(params.messageId);
    if (messageId) source.messageId = messageId;

    const boardScope = params.boardScope;
    if (boardScope?.topicId) {
      source.boardScopeTopicId = boardScope.topicId;
      source.boardScopeKind = boardScope.kind;
      source.boardScopeSessionKey = boardScope.sessionKey;
      source.boardScopeInherited = Boolean(boardScope.inherited);
      source.boardScopeLock = true;
      if (boardScope.kind === "task" && boardScope.taskId) {
        source.boardScopeTaskId = boardScope.taskId;
      }
    }

    const flow = params.flow;
    if (flow) {
      if (flow.speakerId) source.speakerId = flow.speakerId;
      if (flow.speakerLabel) source.speakerLabel = flow.speakerLabel;
      if (flow.audienceId) source.audienceId = flow.audienceId;
      if (flow.audienceLabel) source.audienceLabel = flow.audienceLabel;
    }
    return source;
  }

  async function resolveRoutingScope(
    effectiveSessionKey: string | undefined,
    ctx2: PluginHookContextBase,
    meta?: Record<string, unknown> | undefined,
  ): Promise<RoutingScope> {
    const normalizedSessionKey = normalizeId(effectiveSessionKey);
    const ctxSessionKey = normalizeId(ctx2.sessionKey);
    const metaSessionKey = typeof meta?.sessionKey === "string" ? normalizeId(meta.sessionKey) : undefined;
    const conversationKey = normalizeId(ctx2.conversationId);
    const sessionCandidates = [normalizedSessionKey, ctxSessionKey, metaSessionKey, conversationKey];

    // Direct board scope from any supplied session key always wins.
    for (const candidate of sessionCandidates) {
      const direct = boardScopeFromSessionKey(candidate);
      if (!direct) continue;
      const sub = parseSubagentSession(normalizedSessionKey ?? ctxSessionKey);
      rememberBoardScope(direct, {
        sessionKeys: sessionCandidates,
        agentIds: [normalizeId(ctx2.agentId), sub?.ownerAgentId],
      });
      return {
        topicId: direct.topicId,
        taskId: direct.kind === "task" ? direct.taskId : undefined,
        boardScope: direct,
      };
    }

    // Subagent sessions inherit from the owning agent's most-recent board scope.
    const subagent = parseSubagentSession(normalizedSessionKey ?? ctxSessionKey);
    if (subagent) {
      const now = nowMs();
      const exact = sessionCandidates
        .map((candidate) => (candidate ? boardScopeBySession.get(candidate) : undefined))
        .find((scope) => isFreshBoardScope(scope, now));
      const inherited = exact ?? boardScopeByAgent.get(subagent.ownerAgentId);
      if (isFreshBoardScope(inherited, now)) {
        const nextScope: BoardScope = {
          ...(inherited as BoardScope),
          inherited: true,
          updatedAt: now,
        };
        rememberBoardScope(nextScope, {
          sessionKeys: sessionCandidates,
          agentIds: [subagent.ownerAgentId, normalizeId(ctx2.agentId)],
        });
        return {
          topicId: nextScope.topicId,
          taskId: nextScope.kind === "task" ? nextScope.taskId : undefined,
          boardScope: nextScope,
        };
      }
    }

    return {
      topicId: await resolveTopicId(normalizedSessionKey),
      taskId: resolveTaskId(normalizedSessionKey),
    };
  }

  // When Clawboard isn't reachable (common during local dev restarts and during purge),
  // Node's fetch throws (often: "TypeError: fetch failed"). Don't spam the logs.
  const SEND_WARN_INTERVAL_MS = 30_000;
  let lastSendWarnAt = 0;
  let lastSendWarnSig = "";
  let suppressedSendWarns = 0;

  function formatSendError(err: unknown): string {
    if (err instanceof Error) {
      const msg = err.message || String(err);
      const cause = (err as unknown as { cause?: unknown }).cause;
      if (cause && typeof cause === "object") {
        const c = cause as { code?: unknown; message?: unknown };
        const code = typeof c.code === "string" ? c.code : undefined;
        const cmsg = typeof c.message === "string" ? c.message : undefined;
        if (code || cmsg) return `${msg} (cause: ${code ? `${code} ` : ""}${cmsg ?? ""}`.trim() + ")";
      }
      return msg;
    }
    return String(err);
  }

  function warnSendFailure(err: unknown) {
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

  async function postLog(payload: Record<string, unknown>) {
    const idempotencyKey = ensureIdempotencyKey(payload);
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
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

  async function postLogWithRetry(payload: Record<string, unknown>) {
    // Keep the agent loop snappy: retry for up to ~10s, then spill to durable queue.
    const deadline = nowMs() + 10_000;
    let attempt = 0;
    while (true) {
      attempt += 1;
      const ok = await postLog(payload);
      if (ok) return true;
      if (nowMs() >= deadline) return false;
      const delay = computeBackoffMs(attempt, 2500);
      await sleep(delay);
    }
  }

  async function flushQueueOnce(limit = 25) {
    if (!useQueue) {
      // Even if server-side queueing isn't enabled, the plugin still needs its local durable queue.
      // This block intentionally does nothing; local queue flush is always enabled.
    }
    const db = await getQueueDb();
    const rows = db.pickDue(limit);
    if (rows.length === 0) return;

    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      } catch (err) {
        db.markFailed(row.id, row.attempts + 1, nowMs() + 60_000, `json parse failed: ${String(err)}`);
        continue;
      }

      // Always send with the same idempotency key that was queued.
      payload.idempotencyKey = row.idempotencyKey;

      const ok = await postLog(payload);
      if (ok) {
        db.markSent(row.id);
        continue;
      }

      const attempts = row.attempts + 1;
      const backoff = computeBackoffMs(attempts, 300_000);
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
    }, 2000);
    (flushTimer as unknown as { unref?: () => void })?.unref?.();
  }

  async function enqueueDurable(payload: Record<string, unknown>, error: string) {
    const db = await getQueueDb();
    const idempotencyKey = ensureIdempotencyKey(payload);
    db.enqueue(idempotencyKey, payload, error);
    ensureFlushLoop();
  }

  async function send(payload: Record<string, unknown>) {
    ensureIdempotencyKey(payload);
    const ok = await postLogWithRetry(payload);
    if (!ok) {
      await enqueueDurable(payload, "retry window exceeded");
      return;
    }
    // Opportunistic drain.
    ensureFlushLoop();
    await flushQueue();
  }

  // Serialize sends to avoid stampeding the API (SQLite lock contention + abort timeouts).
  // Hooks still return immediately; this only affects background IO ordering.
  let sendChain: Promise<void> = Promise.resolve();

  function sendAsync(payload: Record<string, unknown>) {
    sendChain = sendChain
      .then(() => send(payload))
      .catch((err) => {
        // Same rate-limiting as the main send path (this is usually the same root cause).
        warnSendFailure(err);
      });
  }

  ensureFlushLoop();
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
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), contextFetchTimeoutMs);
      const res = await fetch(url.toString(), { headers: apiHeaders, signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function coerceLogs(data: unknown) {
    return Array.isArray(data) ? (data as ApiLogEntry[]) : [];
  }

  async function listLogs(params: Record<string, string | number | undefined>) {
    const data = await getJson("/api/log", params);
    return coerceLogs(data);
  }

  function toolJsonResult(payload: unknown) {
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    };
  }

  async function toolFetchJson(params: {
    pathname: string;
    method?: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    timeoutMs?: number;
  }) {
    const method = (params.method || "GET").toUpperCase();
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 8000;
    try {
      const url = new URL(`${baseUrl}${params.pathname}`);
      if (params.query) {
        for (const [key, value] of Object.entries(params.query)) {
          if (value === undefined || value === null || value === "") continue;
          url.searchParams.set(key, String(value));
        }
      }
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url.toString(), {
        method,
        headers: apiHeaders,
        signal: controller.signal,
        ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(params.body ?? {}) }),
      });
      clearTimeout(t);
      const text = await res.text();
      let data: unknown = null;
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

  function coerceBool(value: unknown, fallback = false) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
      if (v === "false" || v === "0" || v === "no" || v === "off") return false;
    }
    return fallback;
  }

  function coerceInt(value: unknown, fallback: number, min: number, max: number) {
    let n: number | undefined;
    if (typeof value === "number" && Number.isFinite(value)) n = Math.floor(value);
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) n = parsed;
    }
    if (n === undefined) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function registerAgentTools() {
    const api2 = api as unknown as { registerTool?: (tool: unknown, opts?: { names?: string[]; optional?: boolean }) => void };
    if (typeof api2.registerTool !== "function") return;

    api2.registerTool(
      (ctxTool: unknown) => {
        const ctxObj = (ctxTool ?? {}) as { sessionKey?: unknown; agentId?: unknown };
        const defaultSessionKey = typeof ctxObj.sessionKey === "string" ? ctxObj.sessionKey : undefined;
        const agentId = typeof ctxObj.agentId === "string" ? ctxObj.agentId : undefined;

        const tools: unknown[] = [];

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
              limitLogs: { type: "integer", description: "Max log matches." },
            },
            required: ["q"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const q = typeof params.q === "string" ? params.q.trim() : "";
            if (!q) return toolJsonResult({ ok: false, error: "q required" });
            const sk =
              typeof params.sessionKey === "string" && params.sessionKey.trim()
                ? params.sessionKey.trim()
                : defaultSessionKey;
            const includePending = coerceBool(params.includePending, true);
            const topicId = typeof params.topicId === "string" ? params.topicId.trim() : "";
            const limitTopics = coerceInt(params.limitTopics, 24, 1, 2000);
            const limitTasks = coerceInt(params.limitTasks, 48, 1, 5000);
            const limitLogs = coerceInt(params.limitLogs, 360, 10, 5000);
            const res = await toolFetchJson({
              pathname: "/api/search",
              query: {
                q,
                sessionKey: sk,
                topicId: topicId || undefined,
                includePending,
                limitTopics,
                limitTasks,
                limitLogs,
              },
            });
            return toolJsonResult(res);
          },
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
              timelineLimit: { type: "integer", description: "Timeline line limit." },
            },
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const q = typeof params.q === "string" ? params.q.trim() : "";
            const sk =
              typeof params.sessionKey === "string" && params.sessionKey.trim()
                ? params.sessionKey.trim()
                : defaultSessionKey;
            const mode =
              typeof params.mode === "string" && params.mode.trim()
                ? params.mode.trim()
                : "auto";
            const maxChars = coerceInt(params.maxChars, 6000, 400, 12000);
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
                timelineLimit,
              },
            });
            return toolJsonResult(res);
          },
        });

        tools.push({
          name: "clawboard_get_topic",
          label: "Get Clawboard Topic",
          description: "Fetch a Clawboard topic by id.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string", description: "Topic id." } },
            required: ["id"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (!id) return toolJsonResult({ ok: false, error: "id required" });
            const res = await toolFetchJson({ pathname: `/api/topics/${encodeURIComponent(id)}` });
            return toolJsonResult(res);
          },
        });

        tools.push({
          name: "clawboard_get_task",
          label: "Get Clawboard Task",
          description: "Fetch a Clawboard task by id.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string", description: "Task id." } },
            required: ["id"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (!id) return toolJsonResult({ ok: false, error: "id required" });
            const res = await toolFetchJson({ pathname: `/api/tasks/${encodeURIComponent(id)}` });
            return toolJsonResult(res);
          },
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
              includeRaw: { type: "boolean", description: "Include raw payload (can be large)." },
            },
            required: ["id"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (!id) return toolJsonResult({ ok: false, error: "id required" });
            const includeRaw = coerceBool(params.includeRaw, false);
            const res = await toolFetchJson({
              pathname: `/api/log/${encodeURIComponent(id)}`,
              query: { includeRaw },
            });
            return toolJsonResult(res);
          },
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
              taskId: { type: "string", description: "Optional explicit task id." },
            },
            required: ["relatedLogId", "text"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const relatedLogId = typeof params.relatedLogId === "string" ? params.relatedLogId.trim() : "";
            const text = typeof params.text === "string" ? sanitizeMessageContent(params.text).trim() : "";
            if (!relatedLogId) return toolJsonResult({ ok: false, error: "relatedLogId required" });
            if (!text) return toolJsonResult({ ok: false, error: "text required" });
            const clipped = clip(text, 1600);
            const topicId = typeof params.topicId === "string" ? params.topicId.trim() : "";
            const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
            const payload = {
              type: "note",
              relatedLogId,
              topicId: topicId || undefined,
              taskId: taskId || undefined,
              content: clipped,
              summary: summarize(clipped),
              createdAt: new Date().toISOString(),
              agentId: agentId || "assistant",
              agentLabel: "OpenClaw",
              source: {
                sessionKey: defaultSessionKey,
              },
            };
            const res = await toolFetchJson({
              pathname: "/api/log",
              method: "POST",
              body: payload,
            });
            return toolJsonResult(res);
          },
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
              tags: { type: "array", items: { type: "string" }, description: "Tags list" },
            },
            required: ["id"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (!id) return toolJsonResult({ ok: false, error: "id required" });
            const patch: Record<string, unknown> = {};
            if (typeof params.status === "string" && params.status.trim()) patch.status = params.status.trim();
            if (typeof params.priority === "string" && params.priority.trim()) patch.priority = params.priority.trim();
            if (typeof params.dueDate === "string" && params.dueDate.trim()) patch.dueDate = params.dueDate.trim();
            if (typeof params.pinned === "boolean") patch.pinned = params.pinned;
            if (typeof params.snoozedUntil === "string") patch.snoozedUntil = params.snoozedUntil.trim() || null;
            if (Array.isArray(params.tags)) patch.tags = params.tags.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean);
            if (Object.keys(patch).length === 0) return toolJsonResult({ ok: false, error: "no patch fields provided" });
            const res = await toolFetchJson({
              pathname: `/api/tasks/${encodeURIComponent(id)}`,
              method: "PATCH",
              body: patch,
            });
            return toolJsonResult(res);
          },
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
          "clawboard_update_task",
        ],
      },
    );
  }

  registerAgentTools();

  async function retrieveContextViaContextApi(
    query: string,
    sessionKey: string | undefined,
    mode: "auto" | "cheap" | "full" | "patient" = "auto",
  ) {
    const normalizedQuery = clip(normalizeWhitespace(sanitizeMessageContent(query)), 500);
    if (!normalizedQuery) return undefined;
    const payload = await getJson("/api/context", {
      q: normalizedQuery,
      sessionKey,
      mode,
      includePending: 1,
      maxChars: contextMaxChars,
      // Working set should be a bit larger than semantic shortlist.
      workingSetLimit: Math.max(6, contextTaskLimit),
      timelineLimit: contextLogLimit,
    });
    if (!payload || typeof payload !== "object") return undefined;
    const block = (payload as { block?: unknown }).block;
    if (typeof block === "string" && block.trim().length > 0) {
      return block.trim();
    }
    return undefined;
  }

  const beforeAgentStartApi = api as unknown as {
    on: (event: "before_agent_start", handler: (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => unknown) => void;
  };

  beforeAgentStartApi.on("before_agent_start", async (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => {
    if (!contextAugment) return;
    const input = latestUserInput(event.prompt, event.messages);
    const cleanInput = sanitizeMessageContent(input ?? "");
    const effectiveSessionKey = computeEffectiveSessionKey(undefined, ctx);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES)) return;
    // Avoid expensive retrieval for internal classifier payloads (these can be huge JSON blobs and will
    // stampede /api/search). The classifier/log hooks already skip logging these.
    if (cleanInput && isClassifierPayloadText(cleanInput)) return;
    const retrievalQuery =
      cleanInput && cleanInput.trim().length > 0
        ? clip(cleanInput, 320)
        : "current conversation continuity, active topics, active tasks, and curated notes";
    const sessionKeyForContext = effectiveSessionKey ?? ctx?.sessionKey;
    const primaryMode = contextMode;
    const context = await retrieveContextViaContextApi(retrievalQuery, sessionKeyForContext, primaryMode);
    if (!context) return;
    const prependContext = [
      CLAWBOARD_CONTEXT_BEGIN,
      "Clawboard continuity hook is active for this turn. The block below already comes from Clawboard retrieval. Do not claim Clawboard is unavailable unless this block explicitly says retrieval failed.",
      "Use this Clawboard retrieval context merged with existing OpenClaw memory/turn context. Prioritize curated user notes when present.",
      context,
      CLAWBOARD_CONTEXT_END,
    ].join("\n");
    return {
      prependContext,
    };
  });

  // Track last seen channel so we can attribute agent_end output when the
  // provider doesn't emit outbound message hooks.
  let lastChannelId: string | undefined;
  let lastEffectiveSessionKey: string | undefined;
  let lastMessageAt = 0;
  const inboundBySession = new Map<string, { ts: number; channelId?: string; sessionKey?: string }>();
  const agentEndCursorBySession = new Map<string, number>();

  const resolveSessionKey = (meta: { sessionKey?: string } | undefined, ctx2: PluginHookContextBase) => {
    const metaObj = (meta as Record<string, unknown> | undefined) ?? undefined;
    return computeEffectiveSessionKey(metaObj, ctx2);
  };

  const normalizeEventMeta = (
    meta: Record<string, unknown> | undefined,
    topLevelSessionKey: unknown,
  ): { sessionKey?: string; [key: string]: unknown } => {
    const merged: Record<string, unknown> = {
      ...(meta && typeof meta === "object" ? meta : {}),
    };
    const top = typeof topLevelSessionKey === "string" ? topLevelSessionKey.trim() : "";
    if (!top) return merged as { sessionKey?: string; [key: string]: unknown };
    const mergedSessionKey =
      typeof merged.sessionKey === "string" ? merged.sessionKey.trim() : "";
    if (!mergedSessionKey || (isBoardSessionKey(top) && !isBoardSessionKey(mergedSessionKey))) {
      merged.sessionKey = top;
    }
    return merged as { sessionKey?: string; [key: string]: unknown };
  };

	  api.on("message_received", async (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => {
	    const createdAt = new Date().toISOString();
	    const raw = event.content ?? "";
	    const cleanRaw = sanitizeMessageContent(raw);
	    if (isClassifierPayloadText(cleanRaw)) return;
	    if (!cleanRaw) return;
    const meta = normalizeEventMeta(
      event.metadata as Record<string, unknown> | undefined,
      (event as { sessionKey?: unknown }).sessionKey,
    );
	    const effectiveSessionKey = resolveSessionKey(meta as { sessionKey?: string } | undefined, ctx);
	    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES)) return;
    const directBoardScope = boardScopeFromSessionKey(effectiveSessionKey ?? ctx?.sessionKey);
    if (directBoardScope) {
      rememberBoardScope(directBoardScope, {
        sessionKeys: [effectiveSessionKey, ctx.sessionKey],
        agentIds: [ctx.agentId, parseSubagentSession(ctx.sessionKey)?.ownerAgentId],
      });
      lastChannelId = ctx.channelId;
      lastEffectiveSessionKey = effectiveSessionKey;
      lastMessageAt = Date.now();
      const ctxSessionKey = (ctx as unknown as { sessionKey?: string })?.sessionKey ?? effectiveSessionKey;
      if (ctxSessionKey) {
        inboundBySession.set(ctxSessionKey, {
          ts: lastMessageAt,
          channelId: ctx.channelId,
          sessionKey: effectiveSessionKey,
        });
      }
      if (effectiveSessionKey && effectiveSessionKey !== ctxSessionKey) {
        inboundBySession.set(effectiveSessionKey, {
          ts: lastMessageAt,
          channelId: ctx.channelId,
          sessionKey: effectiveSessionKey,
        });
      }
      // Clawboard UI messages (board sessions) are already persisted immediately by the backend
      // (`/api/openclaw/chat`). Avoid double-logging if OpenClaw emits message_received for them.
      return;
    }
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
	    const routing = await resolveRoutingScope(effectiveSessionKey, ctx, meta);
	    const topicId = routing.topicId;
	    const taskId = routing.taskId;

	    const metaSummary = meta?.summary;
	    const summary =
	      typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);
	    const messageId = typeof meta?.messageId === "string" ? meta.messageId : undefined;
    const incomingKey = messageId
      ? `received:${ctx.channelId ?? "nochannel"}:${effectiveSessionKey ?? ""}:${messageId}`
      : null;
    if (incomingKey && recentIncoming.has(incomingKey)) return;
    if (incomingKey) rememberIncoming(incomingKey);

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
	      source: buildSourceMeta({
	        channel: ctx.channelId,
	        sessionKey: effectiveSessionKey,
	        messageId,
	        boardScope: routing.boardScope,
	        flow: deriveConversationFlow({
	          role: "user",
	          sessionKey: effectiveSessionKey ?? ctx.sessionKey,
	          agentId: ctx.agentId,
	          assistantLabel: resolveAgentLabel(ctx.agentId, effectiveSessionKey ?? ctx.sessionKey),
	        }),
	      }),
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
    const createdAt = new Date().toISOString();
    type MessageSendingEvent = PluginHookMessageSentEvent & { metadata?: Record<string, unknown> };
    const sendEvent = event as MessageSendingEvent;
    const raw = sendEvent.content ?? "";
    const cleanRaw = sanitizeMessageContent(raw);
    if (isClassifierPayloadText(cleanRaw)) return;
    if (!cleanRaw) return;
    const meta = normalizeEventMeta(sendEvent.metadata as Record<string, unknown> | undefined, sendEvent.sessionKey);
    const effectiveSessionKey = resolveSessionKey(meta as { sessionKey?: string } | undefined, ctx);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES)) return;
    const routing = await resolveRoutingScope(effectiveSessionKey, ctx, meta);
    const topicId = routing.topicId;
    const taskId = routing.taskId;

    // Outbound message content is always assistant-side.
    const agentId = "assistant";
    const agentLabel = resolveAgentLabel(ctx.agentId, meta?.sessionKey ?? (ctx as unknown as { sessionKey?: string })?.sessionKey);

    const metaSummary = meta?.summary;
    const summary =
      typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);

    const messageId = typeof meta?.messageId === "string" ? meta.messageId : undefined;
    const dedupeKey = messageId
      ? `sending:${ctx.channelId ?? "nochannel"}:${effectiveSessionKey ?? ""}:${messageId}`
      : null;
    if (dedupeKey && recentOutgoing.has(dedupeKey)) return;
    if (dedupeKey) rememberOutgoing(dedupeKey);

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
      source: buildSourceMeta({
        channel: ctx.channelId,
        sessionKey: effectiveSessionKey,
        messageId,
        boardScope: routing.boardScope,
        flow: deriveConversationFlow({
          role: "assistant",
          sessionKey: effectiveSessionKey ?? ctx.sessionKey,
          agentId: ctx.agentId,
          assistantLabel: agentLabel,
        }),
      }),
    });
  });

  api.on("message_sent", async (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => {
    // Avoid double-logging the actual message content; we log it at message_sending.
    // This hook is kept for future delivery status tracking.
    const raw = sanitizeMessageContent(event.content ?? "");
    const meta = normalizeEventMeta(
      (event as unknown as { metadata?: Record<string, unknown> }).metadata as Record<string, unknown> | undefined,
      (event as unknown as { sessionKey?: unknown }).sessionKey,
    );
    const sessionKey = meta?.sessionKey ?? (ctx as unknown as { sessionKey?: string })?.sessionKey;
    const effectiveSessionKey = sessionKey ?? (ctx.channelId ? `channel:${ctx.channelId}` : undefined);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES)) return;
    const dedupeKey = `sending:${ctx.channelId ?? "nochannel"}:${effectiveSessionKey ?? ""}:${dedupeFingerprint(raw)}`;
    if (recentOutgoing.has(dedupeKey)) return;
  });

  api.on("before_tool_call", async (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
    const createdAt = new Date().toISOString();
    const redacted = redact(event.params);
    const effectiveSessionKey = resolveSessionKey(undefined, ctx);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES)) return;
    const routing = await resolveRoutingScope(effectiveSessionKey, ctx);
    const topicId = routing.topicId;
    const taskId = routing.taskId;

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
      source: buildSourceMeta({
        channel: ctx.channelId,
        sessionKey: effectiveSessionKey,
        boardScope: routing.boardScope,
      }),
    });
  });

  api.on("after_tool_call", async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
    const createdAt = new Date().toISOString();
    const payload = event.error
      ? { error: event.error }
      : { result: redact(event.result), durationMs: event.durationMs };

    const effectiveSessionKey = resolveSessionKey(undefined, ctx);
    if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES)) return;
    const routing = await resolveRoutingScope(effectiveSessionKey, ctx);
    const topicId = routing.topicId;
    const taskId = routing.taskId;

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
      source: buildSourceMeta({
        channel: ctx.channelId,
        sessionKey: effectiveSessionKey,
        boardScope: routing.boardScope,
      }),
    });
  });

  api.on("agent_end", async (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
    const createdAtBaseMs = Date.now();
    const createdAt = new Date(createdAtBaseMs).toISOString();
    const payload = {
      success: event.success,
      error: event.error,
      durationMs: event.durationMs,
      messageCount: event.messages?.length ?? 0,
    };

    // Some channels/providers don't emit message_sent reliably for assistant output.
    // As a fallback, capture assistant messages from the agent_end payload.
    type HookMessage = { role?: unknown; content?: unknown; [key: string]: unknown };
    const messages: HookMessage[] = Array.isArray(event.messages) ? (event.messages as HookMessage[]) : [];

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
    if (shouldIgnoreSessionKey(inferredSessionKey, IGNORE_SESSION_PREFIXES)) return;
    const inferredChannelId =
      (anchorFresh ? anchor?.channelId : undefined) ??
      (inferredSessionKey.startsWith("channel:") && channelFresh ? lastChannelId : undefined);

    const sourceChannel =
      inferredChannelId ??
      ctx.channelId ??
      (typeof ctx.messageProvider === "string" ? ctx.messageProvider : undefined) ??
      (typeof ctx.provider === "string" ? ctx.provider : undefined) ??
      "direct";

    const routing = await resolveRoutingScope(inferredSessionKey, { ...ctx, channelId: inferredChannelId ?? ctx.channelId });
    const topicId = routing.topicId;
    const taskId = routing.taskId;

    // agent_end is always this agent's run: treat assistant-role messages as assistant output.
    const agentId = "assistant";
    const agentLabel = resolveAgentLabel(ctx.agentId, inferredSessionKey);

    if (debug) {
      // Optional debug telemetry for message-shape inspection.
      try {
        const shape = messages.slice(-20).map((m) => ({
          role: typeof m.role === "string" ? m.role : typeof m.role,
          contentType: Array.isArray(m.content) ? "array" : typeof m.content,
          keys: m && typeof m === "object" ? Object.keys(m).slice(0, 12) : [],
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
          source: buildSourceMeta({
            channel: inferredChannelId,
            sessionKey: inferredSessionKey,
            boardScope: routing.boardScope,
          }),
        });
      } catch {
        // ignore
      }
    }

    if (!inferredSessionKey) {
      // No session key to attribute messages; skip conversation logs.
	    } else {
	      const isChannelSession = inferredSessionKey.startsWith("channel:");
	      const isBoardSession = Boolean(parseBoardSessionKey(inferredSessionKey));
	      let startIdx = 0;
	      if (!isChannelSession) {
	        const prev = agentEndCursorBySession.get(inferredSessionKey);
	        if (typeof prev === "number" && Number.isFinite(prev)) {
	          startIdx = Math.max(0, Math.floor(prev));
        } else {
          // On gateway restart we lose the in-memory cursor; only scan the tail to avoid
          // re-walking huge direct-session histories (which can stall the gateway).
          startIdx = Math.max(0, messages.length - 24);
        }
        if (startIdx > messages.length) startIdx = Math.max(0, messages.length - 24);
      }

      // When logging multiple messages from a single agent_end event we want stable chronological ordering
      // without collapsing them onto the same timestamp.
      let agentEndSeq = 0;

	      for (let idx = startIdx; idx < messages.length; idx += 1) {
	        const msg = messages[idx];
	        const role = typeof msg.role === "string" ? msg.role : undefined;
	        if (role !== "assistant" && role !== "user") continue;
	        if (isBoardSession && role === "user") {
	          // Clawboard persists UI-originated user messages immediately via `/api/openclaw/chat`.
	          // Logging them again from agent_end duplicates them (same content, different ids).
	          continue;
	        }
	        if (isChannelSession && role === "user") {
	          // Inbound user messages for channel sessions are logged via message_received with the
	          // upstream messageId. agent_end often includes prior context prompts, so logging user
	          // role messages here creates duplicate user entries in Clawboard.
          continue;
        }

        const content = extractText(msg.content);
        if (!content || !content.trim()) continue;
        const cleanedContent = sanitizeMessageContent(content);
        if (!cleanedContent) continue;
        if (isClassifierPayloadText(cleanedContent)) continue;
        if (cleanedContent.trim() === "NO_REPLY") continue;

        const summary = summarize(cleanedContent);
        const fingerprint = dedupeFingerprint(cleanedContent);
        const rawId = typeof (msg as { id?: unknown })?.id === "string" ? (msg as { id: string }).id : undefined;
        const messageId = stableAgentEndMessageId({
          sessionKey: inferredSessionKey,
          role,
          index: idx,
          fingerprint,
          rawId,
        });
        const isJsonLike =
          cleanedContent.trim().startsWith("{") &&
          (cleanedContent.includes("\"window\"") ||
            cleanedContent.includes("\"topic\"") ||
            cleanedContent.includes("\"candidateTopics\""));
        if (isJsonLike) continue;
        if (role === "user" && isChannelSession && channelFresh) {
          // Prefer message_received when it fired; otherwise allow agent_end fallback.
          const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${messageId}`;
          if (recentIncoming.has(dedupeKey)) continue;
        }
        if (role === "assistant") {
          const dedupeKey = `sending:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${messageId}`;
          if (recentOutgoing.has(dedupeKey)) continue;
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
            source: buildSourceMeta({
              channel: sourceChannel,
              sessionKey: inferredSessionKey,
              messageId,
              boardScope: routing.boardScope,
              flow: deriveConversationFlow({
                role: "assistant",
                sessionKey: inferredSessionKey,
                agentId: ctx.agentId,
                assistantLabel: agentLabel,
              }),
            }),
          });
        } else {
          const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${messageId}`;
          if (recentIncoming.has(dedupeKey)) continue;
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
            source: buildSourceMeta({
              channel: sourceChannel,
              sessionKey: inferredSessionKey,
              messageId,
              boardScope: routing.boardScope,
              flow: deriveConversationFlow({
                role: "user",
                sessionKey: inferredSessionKey,
                agentId: ctx.agentId,
                assistantLabel: agentLabel,
              }),
            }),
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
        source: buildSourceMeta({
          channel: inferredChannelId,
          sessionKey: inferredSessionKey,
          boardScope: routing.boardScope,
        }),
      });
    }
  });
}


// Export utility functions for testing
export {
  normalizeBaseUrl,
  sanitizeMessageContent,
  summarize,
  dedupeFingerprint,
  truncateRaw,
  clip,
  normalizeWhitespace,
  tokenSet,
  lexicalSimilarity
};
