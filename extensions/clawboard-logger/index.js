import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { computeEffectiveSessionKey, isBoardSessionKey, parseBoardSessionKey, } from "./session-key.js";
import { getIgnoreSessionPrefixesFromEnv, shouldIgnoreSessionKey } from "./ignore-session.js";
const DEFAULT_QUEUE = path.join(os.homedir(), ".openclaw", "clawboard-queue.sqlite");
const SUMMARY_MAX = 72;
const RAW_MAX = 5000;
const DEFAULT_CONTEXT_MAX_CHARS = 2200;
const DEFAULT_CONTEXT_TOPIC_LIMIT = 3;
const DEFAULT_CONTEXT_TASK_LIMIT = 3;
const DEFAULT_CONTEXT_LOG_LIMIT = 6;
const DEFAULT_CONTEXT_FETCH_TIMEOUT_MS = 3000;
const DEFAULT_CONTEXT_FETCH_RETRIES = 1;
const DEFAULT_CONTEXT_CACHE_TTL_MS = 45_000;
const DEFAULT_CONTEXT_CACHE_MAX_ENTRIES = 120;
const DEFAULT_CONTEXT_CACHE_FRESH_MS = 2500;
const CLAWBOARD_CONTEXT_BEGIN = "[CLAWBOARD_CONTEXT_BEGIN]";
const CLAWBOARD_CONTEXT_END = "[CLAWBOARD_CONTEXT_END]";
const IGNORE_SESSION_PREFIXES = getIgnoreSessionPrefixesFromEnv(process.env);
/** Longer TTL when resolving subagent scope from DB so long-running subagents stay aligned. Configurable via CLAWBOARD_BOARD_SCOPE_SUBAGENT_TTL_HOURS (default 48). */
const BOARD_SCOPE_SUBAGENT_PERSISTENCE_TTL_MS = envInt("CLAWBOARD_BOARD_SCOPE_SUBAGENT_TTL_HOURS", 48, 1, 168) * 60 * 60 * 1000;
const OPENCLAW_REQUEST_ID_PREFIX = "occhat-";
const OPENCLAW_DAY_SECONDS = 24 * 60 * 60;
const REPLY_DIRECTIVE_TAG_RE = /(?:\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]|\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\])\s*/gi;
function envInt(name, fallback, min, max) {
    const raw = (process.env[name] ?? "").trim();
    const parsed = Number.parseInt(raw, 10);
    const value = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, value));
}
function envBool(name, fallback) {
    const raw = (process.env[name] ?? "").trim().toLowerCase();
    if (!raw)
        return fallback;
    if (["1", "true", "yes", "on"].includes(raw))
        return true;
    if (["0", "false", "no", "off"].includes(raw))
        return false;
    return fallback;
}
function isContextMode(value) {
    return value === "auto" || value === "cheap" || value === "full" || value === "patient";
}
function parseContextModes(value, fallback = []) {
    const input = typeof value === "string" ? value : "";
    if (!input.trim())
        return [...fallback];
    const items = input
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => Boolean(item) && isContextMode(item));
    if (items.length === 0)
        return [...fallback];
    const seen = new Set();
    const deduped = [];
    for (const mode of items) {
        if (seen.has(mode))
            continue;
        seen.add(mode);
        deduped.push(mode);
    }
    return deduped;
}
const OPENCLAW_REQUEST_ID_TTL_MS = envInt("OPENCLAW_REQUEST_ID_TTL_SECONDS", 7 * OPENCLAW_DAY_SECONDS, 5 * 60, 90 * OPENCLAW_DAY_SECONDS) * 1000;
const OPENCLAW_REQUEST_ID_MAX_ENTRIES = envInt("OPENCLAW_REQUEST_ID_MAX_ENTRIES", 5000, 200, 50000);
function normalizeBaseUrl(url) {
    return url.replace(/\/$/, "");
}
function sanitizeMessageContent(content) {
    let text = (content ?? "").replace(/\r\n?/g, "\n").trim();
    text = text.replace(/\[CLAWBOARD_CONTEXT_BEGIN\][\s\S]*?\[CLAWBOARD_CONTEXT_END\]\s*/gi, "");
    text = text.replace(/^\s*Conversation info \(untrusted metadata\)\s*:\s*```(?:json)?\s*[\s\S]*?```\s*/i, "");
    text = text.replace(/^\s*Conversation info \(untrusted metadata\)\s*:\s*\{[\s\S]*?\}\s*/i, "");
    text = text.replace(/Clawboard continuity hook is active for this turn\.[\s\S]*?Prioritize curated user notes when present\.\s*/gi, "");
    text = text.replace(REPLY_DIRECTIVE_TAG_RE, " ");
    text = text.replace(/^\s*summary\s*[:\-]\s*/gim, "");
    text = text.replace(/^\[Discord [^\]]+\]\s*/gim, "");
    // OpenClaw/CLI transcripts sometimes include a local-time prefix like:
    // "[Sun 2026-02-08 09:01 EST] ..." which pollutes classifier/search signals.
    text = text.replace(/^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+[A-Za-z]{2,5}\]\s*/gim, "");
    text = text.replace(/\[message[_\s-]?id:[^\]]+\]/gi, "");
    text = text.replace(/[ \t]{2,}/g, " ");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
}
function shouldSuppressReplyDirectivesForSession(sessionKey) {
    return Boolean(sessionKey && isBoardSessionKey(sessionKey));
}
function summarize(content) {
    const trimmed = sanitizeMessageContent(content).replace(/\s+/g, " ");
    if (!trimmed)
        return "";
    if (trimmed.length <= SUMMARY_MAX)
        return trimmed;
    return `${trimmed.slice(0, SUMMARY_MAX - 1).trim()}…`;
}
function dedupeFingerprint(content) {
    const normalized = sanitizeMessageContent(content).replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized)
        return "empty";
    return `${normalized.slice(0, 220)}|${normalized.length}`;
}
function truncateRaw(content) {
    if (content.length <= RAW_MAX)
        return content;
    return `${content.slice(0, RAW_MAX - 1)}…`;
}
function clip(text, limit) {
    const value = (text ?? "").trim();
    if (value.length <= limit)
        return value;
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
        "an",
    ]);
    return new Set(normalized
        .split(" ")
        .map((item) => item.trim())
        .filter((item) => item.length > 2 && !stop.has(item)));
}
function lexicalSimilarity(a, b) {
    const sa = tokenSet(a);
    const sb = tokenSet(b);
    if (sa.size === 0 || sb.size === 0)
        return 0;
    let inter = 0;
    for (const token of sa) {
        if (sb.has(token))
            inter += 1;
    }
    const union = sa.size + sb.size - inter;
    if (union <= 0)
        return 0;
    return inter / union;
}
function extractTextLoose(value, depth = 0) {
    if (!value || depth > 4)
        return undefined;
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        const parts = value
            .map((entry) => extractTextLoose(entry, depth + 1))
            .filter((entry) => Boolean(entry));
        return parts.length ? parts.join("\n") : undefined;
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
        return parts.length ? parts.join("\n") : undefined;
    }
    return undefined;
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
    return clip(fallback, 1000);
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
    // Some classifier/control payloads are smaller and don't include the "window" schema,
    // but still shouldn't be logged as chat content.
    const controlMarkers = ["\"createTopic\"", "\"createTask\"", "\"topicId\"", "\"taskId\""];
    let hits = 0;
    for (const marker of controlMarkers) {
        if (text.includes(marker))
            hits += 1;
    }
    return hits >= 2;
}
function normalizeChannelId(value) {
    return String(value ?? "").trim().toLowerCase();
}
function isMainAgentSessionKey(value) {
    const key = String(value ?? "").trim();
    if (!key)
        return false;
    const base = key.split("|", 1)[0] ?? key;
    return base.trim().toLowerCase() === "agent:main:main";
}
function isHeartbeatControlPlaneText(content, params) {
    const clean = sanitizeMessageContent(content).trim();
    if (!clean)
        return false;
    const channel = normalizeChannelId(params?.channelId);
    const mainAgentSession = isMainAgentSessionKey(params?.sessionKey);
    if (channel === "heartbeat" || channel === "cron-event")
        return true;
    if (/^\[cron:[^\]]+\]/i.test(clean))
        return true;
    if (/^\s*heartbeat\s*:/i.test(clean))
        return mainAgentSession || channel === "heartbeat";
    if (/^\s*heartbeat_ok\s*$/i.test(clean))
        return mainAgentSession || channel === "heartbeat";
    if (mainAgentSession && /heartbeat and watchdog recovery check/i.test(clean))
        return true;
    return false;
}
function isSubagentScaffoldText(content, sessionKey) {
    const clean = sanitizeMessageContent(content).trim();
    if (!clean)
        return false;
    if (!/^\s*\[subagent context\]/i.test(clean))
        return false;
    const key = String(sessionKey ?? "").trim().toLowerCase();
    return key.includes(":subagent:");
}
function shouldSuppressNonSemanticConversation(content, params) {
    const sessionKey = params?.sessionKey ?? undefined;
    if (isSubagentScaffoldText(content, sessionKey))
        return true;
    if (isHeartbeatControlPlaneText(content, params))
        return true;
    return false;
}
function redact(value, depth = 0) {
    if (depth > 4)
        return "[redacted-depth]";
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string")
        return truncateRaw(value);
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value))
        return value.map((entry) => redact(entry, depth + 1));
    if (typeof value === "object") {
        const obj = value;
        const output = {};
        for (const [key, val] of Object.entries(obj)) {
            if (/token|secret|password|key|auth/i.test(key)) {
                output[key] = "[redacted]";
            }
            else {
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
    const rawConfig = (api.pluginConfig ?? {});
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
    const rawContextMode = typeof rawConfig.contextMode === "string" && rawConfig.contextMode.trim()
        ? rawConfig.contextMode
        : (process.env.CLAWBOARD_LOGGER_CONTEXT_MODE ?? "");
    const normalizedContextMode = rawContextMode.trim().toLowerCase();
    const effectiveContextMode = isContextMode(normalizedContextMode) ? normalizedContextMode : "auto";
    const contextFetchTimeoutMs = typeof rawConfig.contextFetchTimeoutMs === "number" && Number.isFinite(rawConfig.contextFetchTimeoutMs)
        ? Math.max(200, Math.min(20_000, Math.floor(rawConfig.contextFetchTimeoutMs)))
        : envInt("CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS", DEFAULT_CONTEXT_FETCH_TIMEOUT_MS, 200, 20_000);
    const contextMaxChars = typeof rawConfig.contextMaxChars === "number" && Number.isFinite(rawConfig.contextMaxChars)
        ? Math.max(400, Math.min(12000, Math.floor(rawConfig.contextMaxChars)))
        : DEFAULT_CONTEXT_MAX_CHARS;
    const contextTopicLimit = typeof rawConfig.contextTopicLimit === "number" && Number.isFinite(rawConfig.contextTopicLimit)
        ? Math.max(1, Math.min(8, Math.floor(rawConfig.contextTopicLimit)))
        : DEFAULT_CONTEXT_TOPIC_LIMIT;
    const contextTaskLimit = typeof rawConfig.contextTaskLimit === "number" && Number.isFinite(rawConfig.contextTaskLimit)
        ? Math.max(1, Math.min(12, Math.floor(rawConfig.contextTaskLimit)))
        : DEFAULT_CONTEXT_TASK_LIMIT;
    const contextLogLimit = typeof rawConfig.contextLogLimit === "number" && Number.isFinite(rawConfig.contextLogLimit)
        ? Math.max(2, Math.min(20, Math.floor(rawConfig.contextLogLimit)))
        : DEFAULT_CONTEXT_LOG_LIMIT;
    const contextFetchRetries = typeof rawConfig.contextFetchRetries === "number" && Number.isFinite(rawConfig.contextFetchRetries)
        ? Math.max(0, Math.min(3, Math.floor(rawConfig.contextFetchRetries)))
        : envInt("CLAWBOARD_LOGGER_CONTEXT_FETCH_RETRIES", DEFAULT_CONTEXT_FETCH_RETRIES, 0, 3);
    const contextCacheTtlMs = typeof rawConfig.contextCacheTtlMs === "number" && Number.isFinite(rawConfig.contextCacheTtlMs)
        ? Math.max(0, Math.min(5 * 60_000, Math.floor(rawConfig.contextCacheTtlMs)))
        : envInt("CLAWBOARD_LOGGER_CONTEXT_CACHE_TTL_MS", DEFAULT_CONTEXT_CACHE_TTL_MS, 0, 5 * 60_000);
    const contextCacheMaxEntries = typeof rawConfig.contextCacheMaxEntries === "number" && Number.isFinite(rawConfig.contextCacheMaxEntries)
        ? Math.max(8, Math.min(1000, Math.floor(rawConfig.contextCacheMaxEntries)))
        : envInt("CLAWBOARD_LOGGER_CONTEXT_CACHE_MAX_ENTRIES", DEFAULT_CONTEXT_CACHE_MAX_ENTRIES, 8, 1000);
    const contextUseCacheOnFailure = typeof rawConfig.contextUseCacheOnFailure === "boolean"
        ? rawConfig.contextUseCacheOnFailure
        : envBool("CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE", true);
    const contextFallbackModes = Array.isArray(rawConfig.contextFallbackModes)
        ? parseContextModes(rawConfig.contextFallbackModes.join(","))
        : parseContextModes(process.env.CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODES, []);
    const enableOpenClawMemorySearch = (() => {
        if (typeof rawConfig.enableOpenClawMemorySearch === "boolean") {
            return rawConfig.enableOpenClawMemorySearch;
        }
        if (typeof rawConfig.disableOpenClawMemorySearch === "boolean") {
            return !rawConfig.disableOpenClawMemorySearch;
        }
        const rawEnable = (process.env.CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH ?? "").trim();
        if (rawEnable) {
            return envBool("CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH", false);
        }
        const rawDisable = (process.env.CLAWBOARD_LOGGER_DISABLE_OPENCLAW_MEMORY_SEARCH ?? "").trim();
        if (rawDisable) {
            return !envBool("CLAWBOARD_LOGGER_DISABLE_OPENCLAW_MEMORY_SEARCH", true);
        }
        // Default: keep OpenClaw memory search off and prefer Clawboard retrieval context.
        return false;
    })();
    if (!enabled) {
        api.logger.warn("[clawboard-logger] disabled by config");
        return;
    }
    if (!baseUrl) {
        api.logger.warn("[clawboard-logger] baseUrl missing; plugin disabled");
        return;
    }
    let flushing = false;
    let flushTimer;
    const topicCache = new Map();
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
        db;
        insertStmt;
        selectStmt;
        deleteStmt;
        failStmt;
        scopeInsertStmt;
        scopeSelectByAgentStmt;
        constructor(filePath) {
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
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS board_scope_cache (
          agent_id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL,
          task_id TEXT,
          kind TEXT NOT NULL,
          session_key TEXT,
          updated_at_ms INTEGER NOT NULL
        );
      `);
            this.scopeInsertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO board_scope_cache (agent_id, topic_id, task_id, kind, session_key, updated_at_ms)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6);
      `);
            this.scopeSelectByAgentStmt = this.db.prepare(`
        SELECT topic_id as topicId, task_id as taskId, kind, session_key as sessionKey, updated_at_ms as updatedAt
        FROM board_scope_cache
        WHERE agent_id = ?1 AND updated_at_ms >= ?2
        ORDER BY updated_at_ms DESC
        LIMIT 1;
      `);
        }
        enqueue(idempotencyKey, payload, error) {
            const ts = nowMs();
            this.insertStmt.run(ts, ts, 0, idempotencyKey, JSON.stringify(payload), error.slice(0, 1200));
        }
        pickDue(limit) {
            const rows = this.selectStmt.all(nowMs(), Math.max(1, Math.min(200, limit)));
            return rows ?? [];
        }
        markSent(id) {
            this.deleteStmt.run(id);
        }
        markFailed(id, attempts, nextAttemptAtMs, error) {
            this.failStmt.run(id, attempts, nextAttemptAtMs, error.slice(0, 1200));
        }
        saveBoardScope(agentId, scope) {
            const taskId = scope.kind === "task" && scope.taskId ? scope.taskId : null;
            this.scopeInsertStmt.run(agentId, scope.topicId, taskId, scope.kind, scope.sessionKey ?? null, scope.updatedAt);
        }
        saveBoardScopeForSession(sessionKey, scope) {
            const key = normalizeId(sessionKey);
            if (!key)
                return;
            this.saveBoardScope(`session:${key}`, scope);
        }
        getFreshBoardScopeForAgent(agentId, cutoffMs) {
            const key = normalizeId(agentId);
            if (!key)
                return undefined;
            const rows = this.scopeSelectByAgentStmt.all(key, cutoffMs);
            const row = rows?.[0];
            if (!row)
                return undefined;
            const scope = {
                topicId: row.topicId,
                kind: row.kind === "task" ? "task" : "topic",
                sessionKey: row.sessionKey ?? "",
                inherited: true,
                updatedAt: row.updatedAt,
            };
            if (row.taskId)
                scope.taskId = row.taskId;
            return scope;
        }
        getFreshBoardScopeForSession(sessionKey, cutoffMs) {
            const key = normalizeId(sessionKey);
            if (!key)
                return undefined;
            return this.getFreshBoardScopeForAgent(`session:${key}`, cutoffMs);
        }
    }
    let queueDb;
    async function getQueueDb() {
        if (queueDb)
            return queueDb;
        await ensureDir(queuePath);
        queueDb = new SqliteQueue(queuePath);
        return queueDb;
    }
    function ensureIdempotencyKey(payload) {
        const existing = payload.idempotencyKey;
        if (typeof existing === "string" && existing.trim().length > 0)
            return existing.trim();
        const source = payload.source ?? undefined;
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
    function stableAgentEndMessageId(opts) {
        const seed = opts.rawId
            ? `${opts.sessionKey}|${opts.role}|${opts.rawId}`
            : `${opts.sessionKey}|${opts.role}|${opts.index}|${opts.fingerprint}`;
        const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
        return `oc:${digest}`;
    }
    function safeId(prefix, raw) {
        const cleaned = raw
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
                body: JSON.stringify({
                    id: topicId,
                    name,
                    tags: ["openclaw"],
                }),
            });
            return res.ok;
        }
        catch {
            return false;
        }
    }
    async function resolveTopicId(sessionKey) {
        const route = parseBoardSessionKey(sessionKey);
        if (route?.topicId)
            return route.topicId;
        if (defaultTopicId)
            return defaultTopicId;
        if (!autoTopicBySession)
            return undefined;
        if (!sessionKey)
            return undefined;
        const cached = topicCache.get(sessionKey);
        if (cached)
            return cached;
        const topicId = safeId("topic-session", sessionKey);
        // Best-effort create; even if it fails, we still attach logs to the same id.
        await upsertTopic(topicId, `Session ${sessionKey}`).catch(() => undefined);
        topicCache.set(sessionKey, topicId);
        return topicId;
    }
    function resolveTaskId(sessionKey) {
        const route = parseBoardSessionKey(sessionKey);
        if (route?.kind === "topic")
            return undefined;
        if (route?.kind === "task")
            return route.taskId;
        return defaultTaskId;
    }
    function resolveAgentLabel(agentId, sessionKey) {
        const fromCtx = agentId && agentId !== "agent" ? agentId : undefined;
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
    const boardScopeBySession = new Map();
    const boardScopeByAgent = new Map();
    function normalizeId(value) {
        const text = typeof value === "string" ? value.trim() : "";
        return text || undefined;
    }
    function normalizeRequestId(value) {
        return normalizeId(typeof value === "string" ? value : undefined);
    }
    function inferRequestIdFromMessageId(value) {
        const candidate = normalizeId(typeof value === "string" ? value : undefined);
        if (!candidate)
            return undefined;
        return candidate.toLowerCase().startsWith(OPENCLAW_REQUEST_ID_PREFIX) ? candidate : undefined;
    }
    function requestSessionKeys(sessionKey) {
        const normalized = normalizeId(sessionKey);
        if (!normalized)
            return [];
        const keys = new Set();
        keys.add(normalized);
        const base = normalized.split("|", 1)[0]?.trim() || normalized;
        if (base)
            keys.add(base);
        const boardRoute = parseBoardSessionKey(normalized);
        if (boardRoute) {
            const canonical = boardRoute.kind === "task"
                ? `clawboard:task:${boardRoute.topicId}:${boardRoute.taskId}`
                : `clawboard:topic:${boardRoute.topicId}`;
            keys.add(canonical);
        }
        return Array.from(keys);
    }
    function shortId(value, length = 8) {
        const clean = value.replace(/[^a-zA-Z0-9]+/g, "");
        return clean.slice(0, length) || value.slice(0, length);
    }
    function parseSubagentSession(sessionKey) {
        const key = normalizeId(sessionKey);
        if (!key || !key.startsWith("agent:"))
            return null;
        const parts = key.split(":");
        if (parts.length < 4)
            return null;
        const ownerAgentId = normalizeId(parts[1]);
        const subagentIdx = parts.indexOf("subagent");
        if (!ownerAgentId || subagentIdx < 0 || subagentIdx + 1 >= parts.length)
            return null;
        const subagentId = normalizeId(parts[subagentIdx + 1]);
        if (!subagentId)
            return null;
        return { ownerAgentId, subagentId };
    }
    function parseAgentSessionOwner(sessionKey) {
        const key = normalizeId(sessionKey);
        if (!key || !key.startsWith("agent:"))
            return undefined;
        const parts = key.split(":");
        return normalizeId(parts[1]);
    }
    function boardScopeFromSessionKey(sessionKey) {
        const key = normalizeId(sessionKey);
        if (!key)
            return undefined;
        const route = parseBoardSessionKey(key);
        if (!route)
            return undefined;
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
    function rememberBoardScope(scope, opts) {
        const stamped = { ...scope, updatedAt: nowMs() };
        const sessionKeys = opts?.sessionKeys ?? [];
        for (const rawKey of sessionKeys) {
            const key = normalizeId(rawKey);
            if (!key)
                continue;
            boardScopeBySession.set(key, stamped);
        }
        const agentIds = opts?.agentIds ?? [];
        for (const rawAgentId of agentIds) {
            const agentId = normalizeId(rawAgentId);
            if (!agentId)
                continue;
            boardScopeByAgent.set(agentId, stamped);
        }
        if (agentIds.length > 0) {
            getQueueDb()
                .then((db) => {
                for (const rawAgentId of agentIds) {
                    const agentId = normalizeId(rawAgentId);
                    if (agentId)
                        db.saveBoardScope(agentId, stamped);
                }
            })
                .catch(() => { });
        }
    }
    function deriveConversationFlow(params) {
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
    function buildSourceMeta(params) {
        const source = {};
        if (params.channel !== undefined)
            source.channel = params.channel;
        const sessionKey = normalizeId(params.sessionKey) ?? normalizeId(params.boardScope?.sessionKey);
        if (sessionKey)
            source.sessionKey = sessionKey;
        const messageId = normalizeId(params.messageId);
        if (messageId)
            source.messageId = messageId;
        const requestId = normalizeRequestId(params.requestId);
        if (requestId)
            source.requestId = requestId;
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
            if (flow.speakerId)
                source.speakerId = flow.speakerId;
            if (flow.speakerLabel)
                source.speakerLabel = flow.speakerLabel;
            if (flow.audienceId)
                source.audienceId = flow.audienceId;
            if (flow.audienceLabel)
                source.audienceLabel = flow.audienceLabel;
        }
        return source;
    }
    function hasSpecificSessionAnchor(effectiveSessionKey, ctx2) {
        const candidates = [
            normalizeId(effectiveSessionKey),
            normalizeId(ctx2.sessionKey),
            normalizeId(ctx2.conversationId),
        ];
        for (const candidate of candidates) {
            if (!candidate)
                continue;
            const lowered = candidate.toLowerCase();
            if (lowered === "channel:openclaw" || lowered === "channel:clawboard")
                continue;
            return true;
        }
        return false;
    }
    function hasToolRoutingAnchor(routing) {
        if (routing.topicId || routing.taskId)
            return true;
        const scope = routing.boardScope;
        if (!scope)
            return false;
        if (scope.topicId)
            return true;
        return scope.kind === "task" && Boolean(scope.taskId);
    }
    function extractSpawnedSubagentSessionKeys(value) {
        const out = new Set();
        const seen = new WeakSet();
        const CHILD_KEY_FIELDS = ["childSessionKey", "child_session_key"];
        const CHILD_LIST_FIELDS = ["childSessionKeys", "child_session_keys"];
        const record = (candidate) => {
            const key = normalizeId(typeof candidate === "string" ? candidate : undefined);
            if (!key)
                return;
            if (!parseSubagentSession(key))
                return;
            out.add(key);
        };
        const visit = (node, depth) => {
            if (depth > 6 || node === null || node === undefined)
                return;
            if (typeof node === "string") {
                record(node);
                return;
            }
            if (Array.isArray(node)) {
                for (const item of node)
                    visit(item, depth + 1);
                return;
            }
            if (typeof node !== "object")
                return;
            const obj = node;
            if (seen.has(obj))
                return;
            seen.add(obj);
            for (const field of CHILD_KEY_FIELDS) {
                record(obj[field]);
            }
            for (const field of CHILD_LIST_FIELDS) {
                const list = obj[field];
                if (!Array.isArray(list))
                    continue;
                for (const item of list)
                    record(item);
            }
            for (const next of Object.values(obj)) {
                visit(next, depth + 1);
            }
        };
        visit(value, 0);
        return Array.from(out);
    }
    function rememberSpawnedSubagentBoardScope(childSessionKey, scope) {
        const key = normalizeId(childSessionKey);
        if (!key)
            return;
        if (!parseSubagentSession(key))
            return;
        const inheritedScope = {
            ...scope,
            inherited: true,
            updatedAt: nowMs(),
        };
        const sessionKeys = requestSessionKeys(key);
        rememberBoardScope(inheritedScope, { sessionKeys, agentIds: [] });
        getQueueDb()
            .then((db) => {
            for (const sessionKey of sessionKeys) {
                db.saveBoardScopeForSession(sessionKey, inheritedScope);
            }
        })
            .catch(() => { });
    }
    function uniqueSessionCandidates(values) {
        const out = new Set();
        for (const value of values) {
            const normalized = normalizeId(value);
            if (!normalized)
                continue;
            out.add(normalized);
        }
        return Array.from(out);
    }
    async function resolveRoutingScope(effectiveSessionKey, ctx2, meta) {
        const normalizedSessionKey = normalizeId(effectiveSessionKey);
        const ctxSessionKey = normalizeId(ctx2.sessionKey);
        const metaSessionKey = typeof meta?.sessionKey === "string" ? normalizeId(meta.sessionKey) : undefined;
        const conversationKey = normalizeId(ctx2.conversationId);
        const subagent = parseSubagentSession(normalizedSessionKey ?? ctxSessionKey);
        const explicitSessionCandidates = uniqueSessionCandidates([normalizedSessionKey, ctxSessionKey, metaSessionKey]);
        const sessionCandidates = subagent
            ? explicitSessionCandidates
            : uniqueSessionCandidates([...explicitSessionCandidates, conversationKey]);
        const subagentSessionCandidates = subagent
            ? uniqueSessionCandidates([normalizedSessionKey, ctxSessionKey, metaSessionKey].flatMap((candidate) => requestSessionKeys(candidate)))
            : [];
        // Direct board scope from any supplied session key always wins.
        for (const candidate of sessionCandidates) {
            const direct = boardScopeFromSessionKey(candidate);
            if (!direct)
                continue;
            const sessionOwners = sessionCandidates
                .map((rawKey) => parseAgentSessionOwner(rawKey))
                .filter((value) => Boolean(value));
            rememberBoardScope(direct, {
                sessionKeys: sessionCandidates,
                agentIds: [normalizeId(ctx2.agentId), subagent?.ownerAgentId, ...sessionOwners],
            });
            return {
                topicId: direct.topicId,
                taskId: direct.kind === "task" ? direct.taskId : undefined,
                boardScope: direct,
            };
        }
        // Subagent sessions inherit board scope only when we have an explicit linkage
        // for that child session (in-memory or persisted by session key from sessions_spawn).
        // This prevents unrelated background/cron subagents from being pulled into a user's board chat.
        if (subagent) {
            const now = nowMs();
            const exact = subagentSessionCandidates
                .map((candidate) => (candidate ? boardScopeBySession.get(candidate) : undefined))
                .find((scope) => Boolean(scope && now - scope.updatedAt <= BOARD_SCOPE_SUBAGENT_PERSISTENCE_TTL_MS));
            let inherited = exact;
            let inheritedFromDb = false;
            if (!inherited && subagentSessionCandidates.length > 0) {
                try {
                    const db = await getQueueDb();
                    const cutoffPersistence = now - BOARD_SCOPE_SUBAGENT_PERSISTENCE_TTL_MS;
                    for (const candidate of subagentSessionCandidates) {
                        const fromDb = db.getFreshBoardScopeForSession(candidate, cutoffPersistence);
                        if (!fromDb)
                            continue;
                        inherited = fromDb;
                        inheritedFromDb = true;
                        break;
                    }
                }
                catch {
                    // DB unavailable or not yet initialized; leave inherited undefined
                }
            }
            const ttlMs = BOARD_SCOPE_SUBAGENT_PERSISTENCE_TTL_MS;
            const accepted = inherited && now - inherited.updatedAt <= ttlMs;
            if (accepted) {
                const nextScope = {
                    ...inherited,
                    inherited: true,
                    updatedAt: now,
                };
                rememberBoardScope(nextScope, {
                    sessionKeys: subagentSessionCandidates,
                    agentIds: [],
                });
                if (!inheritedFromDb) {
                    getQueueDb()
                        .then((db) => {
                        for (const candidate of subagentSessionCandidates) {
                            db.saveBoardScopeForSession(candidate, nextScope);
                        }
                    })
                        .catch(() => { });
                }
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
    function formatSendError(err) {
        if (err instanceof Error) {
            const msg = err.message || String(err);
            const cause = err.cause;
            if (cause && typeof cause === "object") {
                const c = cause;
                const code = typeof c.code === "string" ? c.code : undefined;
                const cmsg = typeof c.message === "string" ? c.message : undefined;
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
        if (!shouldLog)
            return;
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
        }
        catch (err) {
            warnSendFailure(err);
            return false;
        }
    }
    async function postLogWithRetry(payload) {
        // Keep the agent loop snappy: retry for up to ~10s, then spill to durable queue.
        const deadline = nowMs() + 10_000;
        let attempt = 0;
        while (true) {
            attempt += 1;
            const ok = await postLog(payload);
            if (ok)
                return true;
            if (nowMs() >= deadline)
                return false;
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
        if (rows.length === 0)
            return;
        for (const row of rows) {
            let payload;
            try {
                payload = JSON.parse(row.payloadJson);
            }
            catch (err) {
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
        if (flushing)
            return;
        flushing = true;
        try {
            await flushQueueOnce(50);
        }
        finally {
            flushing = false;
        }
    }
    function ensureFlushLoop() {
        if (flushTimer)
            return;
        flushTimer = setInterval(() => {
            flushQueue().catch(() => undefined);
        }, 2000);
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
        // Opportunistic drain.
        ensureFlushLoop();
        await flushQueue();
    }
    // Serialize sends to avoid stampeding the API (SQLite lock contention + abort timeouts).
    // Hooks still return immediately; this only affects background IO ordering.
    let sendChain = Promise.resolve();
    function sendAsync(payload) {
        sendChain = sendChain
            .then(() => send(payload))
            .catch((err) => {
            // Same rate-limiting as the main send path (this is usually the same root cause).
            warnSendFailure(err);
        });
    }
    ensureFlushLoop();
    flushQueue().catch(() => undefined);
    const apiHeaders = {
        "Content-Type": "application/json",
        ...(token ? { "X-Clawboard-Token": token } : {}),
    };
    async function getJson(pathname, params) {
        try {
            const url = new URL(`${baseUrl}${pathname}`);
            if (params) {
                for (const [key, value] of Object.entries(params)) {
                    if (value === undefined || value === null || value === "")
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
        }
        catch {
            return null;
        }
    }
    function coerceLogs(data) {
        return Array.isArray(data) ? data : [];
    }
    async function listLogs(params) {
        const data = await getJson("/api/log", params);
        return coerceLogs(data);
    }
    function toolJsonResult(payload) {
        return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            details: payload,
        };
    }
    async function toolFetchJson(params) {
        const method = (params.method || "GET").toUpperCase();
        const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 8000;
        try {
            const url = new URL(`${baseUrl}${params.pathname}`);
            if (params.query) {
                for (const [key, value] of Object.entries(params.query)) {
                    if (value === undefined || value === null || value === "")
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
                ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(params.body ?? {}) }),
            });
            clearTimeout(t);
            const text = await res.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            }
            catch {
                data = text ? { raw: text } : null;
            }
            return { ok: res.ok, status: res.status, data };
        }
        catch (err) {
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
        let n;
        if (typeof value === "number" && Number.isFinite(value))
            n = Math.floor(value);
        if (typeof value === "string" && value.trim()) {
            const parsed = Number.parseInt(value.trim(), 10);
            if (Number.isFinite(parsed))
                n = parsed;
        }
        if (n === undefined)
            return fallback;
        return Math.max(min, Math.min(max, n));
    }
    function registerAgentTools() {
        const api2 = api;
        if (typeof api2.registerTool !== "function")
            return;
        api2.registerTool((ctxTool) => {
            const ctxObj = (ctxTool ?? {});
            const defaultSessionKey = typeof ctxObj.sessionKey === "string" ? ctxObj.sessionKey : undefined;
            const agentId = typeof ctxObj.agentId === "string" ? ctxObj.agentId : undefined;
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
                        limitLogs: { type: "integer", description: "Max log matches." },
                    },
                    required: ["q"],
                },
                async execute(_toolCallId, params) {
                    const q = typeof params.q === "string" ? params.q.trim() : "";
                    if (!q)
                        return toolJsonResult({ ok: false, error: "q required" });
                    const sk = typeof params.sessionKey === "string" && params.sessionKey.trim()
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
                async execute(_toolCallId, params) {
                    const q = typeof params.q === "string" ? params.q.trim() : "";
                    const sk = typeof params.sessionKey === "string" && params.sessionKey.trim()
                        ? params.sessionKey.trim()
                        : defaultSessionKey;
                    const mode = typeof params.mode === "string" && params.mode.trim()
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
                async execute(_toolCallId, params) {
                    const id = typeof params.id === "string" ? params.id.trim() : "";
                    if (!id)
                        return toolJsonResult({ ok: false, error: "id required" });
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
                async execute(_toolCallId, params) {
                    const id = typeof params.id === "string" ? params.id.trim() : "";
                    if (!id)
                        return toolJsonResult({ ok: false, error: "id required" });
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
                async execute(_toolCallId, params) {
                    const id = typeof params.id === "string" ? params.id.trim() : "";
                    if (!id)
                        return toolJsonResult({ ok: false, error: "id required" });
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
                        body: patch,
                    });
                    return toolJsonResult(res);
                },
            });
            return tools;
        }, {
            names: [
                "clawboard_search",
                "clawboard_context",
                "clawboard_get_topic",
                "clawboard_get_task",
                "clawboard_get_log",
                "clawboard_create_note",
                "clawboard_update_task",
            ],
        });
    }
    registerAgentTools();
    const contextCache = new Map();
    function contextSessionCacheKey(sessionKey) {
        const normalized = normalizeWhitespace(String(sessionKey ?? ""));
        return normalized || "global";
    }
    function contextQueryHash(query) {
        return crypto.createHash("sha256").update(query).digest("hex").slice(0, 24);
    }
    function contextCacheKey(sessionKey, query, mode) {
        return `${contextSessionCacheKey(sessionKey)}|${mode}|${contextQueryHash(query)}`;
    }
    function contextModePlan(primary) {
        const defaultsByPrimary = {
            auto: ["full", "cheap"],
            cheap: ["auto", "full"],
            full: ["auto", "cheap"],
            patient: ["full", "auto", "cheap"],
        };
        const configured = contextFallbackModes.length > 0 ? contextFallbackModes : defaultsByPrimary[primary];
        const ordered = [primary, ...configured];
        const seen = new Set();
        const deduped = [];
        for (const mode of ordered) {
            if (!isContextMode(mode) || seen.has(mode))
                continue;
            seen.add(mode);
            deduped.push(mode);
        }
        return deduped.length > 0 ? deduped : [primary];
    }
    function pruneContextCache() {
        if (contextCache.size === 0)
            return;
        const now = nowMs();
        if (contextCacheTtlMs > 0) {
            for (const [key, entry] of contextCache.entries()) {
                if (now - entry.cachedAtMs > contextCacheTtlMs)
                    contextCache.delete(key);
            }
        }
        else {
            contextCache.clear();
            return;
        }
        if (contextCache.size <= contextCacheMaxEntries)
            return;
        const sorted = Array.from(contextCache.entries()).sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs);
        const overflow = contextCache.size - contextCacheMaxEntries;
        for (let i = 0; i < overflow; i += 1) {
            const row = sorted[i];
            if (!row)
                break;
            contextCache.delete(row[0]);
        }
    }
    function readContextCacheEntry(sessionKey, query, mode, maxAgeMs) {
        if (contextCacheTtlMs <= 0 || maxAgeMs <= 0)
            return undefined;
        const entry = contextCache.get(contextCacheKey(sessionKey, query, mode));
        if (!entry)
            return undefined;
        if (nowMs() - entry.cachedAtMs > maxAgeMs)
            return undefined;
        return entry;
    }
    function writeContextCache(sessionKey, query, mode, block) {
        if (contextCacheTtlMs <= 0)
            return;
        contextCache.set(contextCacheKey(sessionKey, query, mode), {
            mode,
            block,
            cachedAtMs: nowMs(),
        });
        pruneContextCache();
    }
    async function fetchContextBlockViaContextApi(query, sessionKey, mode) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), contextFetchTimeoutMs);
        try {
            const url = new URL(`${baseUrl}/api/context`);
            url.searchParams.set("q", query);
            if (sessionKey)
                url.searchParams.set("sessionKey", sessionKey);
            url.searchParams.set("mode", mode);
            url.searchParams.set("includePending", "1");
            url.searchParams.set("maxChars", String(contextMaxChars));
            // Working set should be a bit larger than semantic shortlist.
            url.searchParams.set("workingSetLimit", String(Math.max(6, contextTaskLimit)));
            url.searchParams.set("timelineLimit", String(contextLogLimit));
            const res = await fetch(url.toString(), { headers: apiHeaders, signal: controller.signal });
            if (!res.ok) {
                return {
                    status: res.status,
                    error: `http_${res.status}`,
                };
            }
            let payload;
            try {
                payload = await res.json();
            }
            catch (err) {
                return {
                    status: res.status,
                    error: `invalid_json:${formatSendError(err)}`,
                };
            }
            if (!payload || typeof payload !== "object") {
                return {
                    status: res.status,
                    error: "empty_payload",
                };
            }
            const block = payload.block;
            if (typeof block === "string" && block.trim().length > 0) {
                return {
                    status: res.status,
                    block: block.trim(),
                };
            }
            return {
                status: res.status,
                error: "empty_block",
            };
        }
        catch (err) {
            return {
                status: 0,
                error: formatSendError(err),
            };
        }
        finally {
            clearTimeout(t);
        }
    }
    async function retrieveContextViaContextApi(query, sessionKey, mode = "auto") {
        const normalizedQuery = clip(normalizeWhitespace(sanitizeMessageContent(query)), 500);
        if (!normalizedQuery)
            return undefined;
        const modes = contextModePlan(mode);
        const freshCacheTtlMs = Math.max(0, Math.min(contextCacheTtlMs, DEFAULT_CONTEXT_CACHE_FRESH_MS));
        if (freshCacheTtlMs > 0) {
            for (const currentMode of modes) {
                const cached = readContextCacheEntry(sessionKey, normalizedQuery, currentMode, freshCacheTtlMs);
                if (cached)
                    return cached.block;
            }
        }
        let lastError = "";
        for (const currentMode of modes) {
            for (let attempt = 0; attempt <= contextFetchRetries; attempt += 1) {
                const result = await fetchContextBlockViaContextApi(normalizedQuery, sessionKey, currentMode);
                if (result.block) {
                    writeContextCache(sessionKey, normalizedQuery, currentMode, result.block);
                    return result.block;
                }
                const status = typeof result.status === "number" ? result.status : 0;
                lastError = result.error ?? (status > 0 ? `http_${status}` : "unknown_error");
                const hardClientError = status >= 400 && status < 500 && status !== 408 && status !== 429;
                if (hardClientError)
                    break;
                if (attempt < contextFetchRetries) {
                    await sleep(computeBackoffMs(attempt + 1, 1500));
                }
            }
        }
        if (contextUseCacheOnFailure && contextCacheTtlMs > 0) {
            for (const currentMode of modes) {
                const cached = readContextCacheEntry(sessionKey, normalizedQuery, currentMode, contextCacheTtlMs);
                if (!cached)
                    continue;
                if (debug) {
                    const ageMs = Math.max(0, nowMs() - cached.cachedAtMs);
                    api.logger.warn(`[clawboard-logger] context retrieval failed (${lastError || "unknown"}); using cached context mode=${cached.mode} ageMs=${ageMs}`);
                }
                return cached.block;
            }
        }
        if (debug && lastError) {
            api.logger.warn(`[clawboard-logger] context retrieval unavailable: ${lastError}`);
        }
        return undefined;
    }
    const beforeAgentStartApi = api;
    beforeAgentStartApi.on("before_agent_start", async (event, ctx) => {
        if (!contextAugment)
            return;
        const input = latestUserInput(event.prompt, event.messages);
        const cleanInput = sanitizeMessageContent(input ?? "");
        const effectiveSessionKey = computeEffectiveSessionKey(undefined, ctx);
        const sessionKeyForContext = effectiveSessionKey ?? ctx?.sessionKey;
        if (shouldIgnoreSessionKey(sessionKeyForContext, IGNORE_SESSION_PREFIXES))
            return;
        // Avoid expensive retrieval for internal classifier payloads (these can be huge JSON blobs and will
        // stampede /api/search). The classifier/log hooks already skip logging these.
        if (cleanInput && isClassifierPayloadText(cleanInput))
            return;
        if (cleanInput &&
            isHeartbeatControlPlaneText(cleanInput, {
                sessionKey: sessionKeyForContext,
                channelId: ctx?.channelId,
            })) {
            return;
        }
        const isSubagentScaffoldPrompt = cleanInput &&
            isSubagentScaffoldText(cleanInput, sessionKeyForContext);
        if (cleanInput &&
            shouldSuppressNonSemanticConversation(cleanInput, {
                sessionKey: sessionKeyForContext,
                channelId: ctx?.channelId,
            }) &&
            !isSubagentScaffoldPrompt) {
            return;
        }
        const retrievalQuery = cleanInput && cleanInput.trim().length > 0 && !isSubagentScaffoldPrompt
            ? clip(cleanInput, 320)
            : "current conversation continuity, active topics, active tasks, and curated notes";
        const primaryMode = effectiveContextMode;
        const context = await retrieveContextViaContextApi(retrievalQuery, sessionKeyForContext, primaryMode);
        if (!context)
            return;
        const prependLines = [
            CLAWBOARD_CONTEXT_BEGIN,
            "Clawboard continuity hook is active for this turn. The block below already comes from Clawboard retrieval. Do not claim Clawboard is unavailable unless this block explicitly says retrieval failed.",
            enableOpenClawMemorySearch
                ? "Use this Clawboard retrieval context merged with existing OpenClaw memory/turn context. Prioritize curated user notes when present."
                : "Use this Clawboard retrieval context as the primary memory source for this turn. Do not run OpenClaw memory_search/memory_get unless the user explicitly asks for OpenClaw memory.",
        ];
        if (shouldSuppressReplyDirectivesForSession(sessionKeyForContext)) {
            prependLines.push("This session is Clawboard UI-native. Reply in plain text and never emit [[reply_to_current]] or [[reply_to:<id>]] tags.");
        }
        prependLines.push(context, CLAWBOARD_CONTEXT_END);
        const prependContext = prependLines.join("\n");
        return {
            prependContext,
        };
    });
    // Track last seen channel so we can attribute agent_end output when the
    // provider doesn't emit outbound message hooks.
    let lastChannelId;
    let lastEffectiveSessionKey;
    let lastMessageAt = 0;
    const inboundBySession = new Map();
    const agentEndCursorBySession = new Map();
    const openclawRequestBySession = new Map();
    const toolScopeByRunId = new Map();
    const toolScopeByFingerprint = new Map();
    const toolScopeByName = new Map();
    const TOOL_SCOPE_MEMORY_TTL_MS = 15 * 60_000;
    const TOOL_SCOPE_MEMORY_MAX_ENTRIES = 400;
    const TOOL_SCOPE_FINGERPRINT_QUEUE_MAX = 8;
    const pruneOpenclawRequestMap = (ts, forceTrim = false) => {
        for (const [key, value] of openclawRequestBySession.entries()) {
            if (ts - value.ts > OPENCLAW_REQUEST_ID_TTL_MS) {
                openclawRequestBySession.delete(key);
            }
        }
        if (!forceTrim && openclawRequestBySession.size <= OPENCLAW_REQUEST_ID_MAX_ENTRIES)
            return;
        if (openclawRequestBySession.size <= OPENCLAW_REQUEST_ID_MAX_ENTRIES)
            return;
        const ordered = Array.from(openclawRequestBySession.entries()).sort((a, b) => a[1].ts - b[1].ts);
        const overflow = openclawRequestBySession.size - OPENCLAW_REQUEST_ID_MAX_ENTRIES;
        for (let i = 0; i < overflow; i += 1) {
            const row = ordered[i];
            if (!row)
                break;
            openclawRequestBySession.delete(row[0]);
        }
    };
    const rememberOpenclawRequestId = (sessionKey, requestId) => {
        const normalizedRequestId = normalizeRequestId(requestId);
        if (!normalizedRequestId)
            return;
        const ts = nowMs();
        for (const key of requestSessionKeys(sessionKey)) {
            openclawRequestBySession.set(key, { requestId: normalizedRequestId, ts });
        }
        pruneOpenclawRequestMap(ts, openclawRequestBySession.size > OPENCLAW_REQUEST_ID_MAX_ENTRIES);
    };
    const recentOpenclawRequestId = (sessionKey) => {
        const ts = nowMs();
        if (openclawRequestBySession.size > OPENCLAW_REQUEST_ID_MAX_ENTRIES) {
            pruneOpenclawRequestMap(ts, true);
        }
        for (const key of requestSessionKeys(sessionKey)) {
            const row = openclawRequestBySession.get(key);
            if (!row)
                continue;
            if (ts - row.ts > OPENCLAW_REQUEST_ID_TTL_MS) {
                openclawRequestBySession.delete(key);
                continue;
            }
            return row.requestId;
        }
        return undefined;
    };
    const resolveOpenclawRequestId = (params) => {
        const explicit = normalizeRequestId(params.explicitRequestId);
        if (explicit) {
            rememberOpenclawRequestId(params.sessionKey, explicit);
            return explicit;
        }
        const inferred = inferRequestIdFromMessageId(params.messageId);
        if (inferred) {
            rememberOpenclawRequestId(params.sessionKey, inferred);
            return inferred;
        }
        return recentOpenclawRequestId(params.sessionKey);
    };
    const canonicalBoardScopeSessionKey = (scope) => {
        if (!scope?.topicId)
            return undefined;
        if (scope.kind === "task" && scope.taskId) {
            return `clawboard:task:${scope.topicId}:${scope.taskId}`;
        }
        return `clawboard:topic:${scope.topicId}`;
    };
    const resolveOpenclawRequestIdForBoardScope = async (params) => {
        if (params.requestId)
            return params.requestId;
        const candidates = new Set();
        const scopeSessionKey = normalizeId(params.boardScope?.sessionKey);
        if (scopeSessionKey) {
            for (const key of requestSessionKeys(scopeSessionKey))
                candidates.add(key);
        }
        const canonicalScopeSessionKey = canonicalBoardScopeSessionKey(params.boardScope);
        if (canonicalScopeSessionKey) {
            for (const key of requestSessionKeys(canonicalScopeSessionKey))
                candidates.add(key);
        }
        for (const candidate of candidates) {
            const candidateRequestId = recentOpenclawRequestId(candidate);
            if (!candidateRequestId)
                continue;
            rememberOpenclawRequestId(params.sessionKey, candidateRequestId);
            return candidateRequestId;
        }
        if (!canonicalScopeSessionKey)
            return params.requestId;
        try {
            const rows = await listLogs({
                sessionKey: canonicalScopeSessionKey,
                type: "conversation",
                limit: 16,
            });
            for (const row of rows) {
                if (!row || typeof row !== "object")
                    continue;
                const rowAgentId = normalizeId(typeof row.agentId === "string"
                    ? (row.agentId ?? "")
                    : undefined);
                if (rowAgentId && rowAgentId.toLowerCase() !== "user")
                    continue;
                const source = row.source && typeof row.source === "object"
                    ? (row.source ?? undefined)
                    : undefined;
                const candidateRequestId = normalizeRequestId(source?.requestId) ??
                    inferRequestIdFromMessageId(source?.requestId) ??
                    normalizeRequestId(source?.messageId) ??
                    inferRequestIdFromMessageId(source?.messageId);
                if (!candidateRequestId)
                    continue;
                rememberOpenclawRequestId(canonicalScopeSessionKey, candidateRequestId);
                rememberOpenclawRequestId(params.sessionKey, candidateRequestId);
                return candidateRequestId;
            }
        }
        catch {
            // Non-fatal fallback path when Clawboard API lookups fail transiently.
        }
        return params.requestId;
    };
    const pruneToolScopeMap = (ts, forceTrim = false) => {
        for (const [key, value] of toolScopeByRunId.entries()) {
            if (ts - value.ts > TOOL_SCOPE_MEMORY_TTL_MS) {
                toolScopeByRunId.delete(key);
            }
        }
        for (const [key, rows] of toolScopeByFingerprint.entries()) {
            const freshRows = rows.filter((row) => ts - row.ts <= TOOL_SCOPE_MEMORY_TTL_MS);
            if (freshRows.length > 0) {
                toolScopeByFingerprint.set(key, freshRows);
            }
            else {
                toolScopeByFingerprint.delete(key);
            }
        }
        for (const [key, rows] of toolScopeByName.entries()) {
            const freshRows = rows.filter((row) => ts - row.ts <= TOOL_SCOPE_MEMORY_TTL_MS);
            if (freshRows.length > 0) {
                toolScopeByName.set(key, freshRows);
            }
            else {
                toolScopeByName.delete(key);
            }
        }
        const fingerprintEntryCount = Array.from(toolScopeByFingerprint.values()).reduce((acc, rows) => acc + rows.length, 0);
        const nameEntryCount = Array.from(toolScopeByName.values()).reduce((acc, rows) => acc + rows.length, 0);
        const totalEntries = toolScopeByRunId.size + fingerprintEntryCount + nameEntryCount;
        if (!forceTrim && totalEntries <= TOOL_SCOPE_MEMORY_MAX_ENTRIES)
            return;
        if (totalEntries <= TOOL_SCOPE_MEMORY_MAX_ENTRIES)
            return;
        const runEntries = Array.from(toolScopeByRunId.entries())
            .map(([key, value]) => ({ kind: "run", key, ts: value.ts }))
            .sort((a, b) => a.ts - b.ts);
        const fingerprintEntries = Array.from(toolScopeByFingerprint.entries())
            .flatMap(([fingerprint, rows]) => rows.map((row, idx) => ({
            kind: "fingerprint",
            key: fingerprint,
            index: idx,
            ts: row.ts,
        })))
            .sort((a, b) => a.ts - b.ts);
        const nameEntries = Array.from(toolScopeByName.entries())
            .flatMap(([name, rows]) => rows.map((row) => ({
            kind: "name",
            key: name,
            ts: row.ts,
        })))
            .sort((a, b) => a.ts - b.ts);
        let overflow = totalEntries - TOOL_SCOPE_MEMORY_MAX_ENTRIES;
        let runCursor = 0;
        let fpCursor = 0;
        let nameCursor = 0;
        while (overflow > 0) {
            const nextRun = runEntries[runCursor];
            const nextFp = fingerprintEntries[fpCursor];
            const nextName = nameEntries[nameCursor];
            const pickRun = nextRun && (!nextFp || nextRun.ts <= nextFp.ts) && (!nextName || nextRun.ts <= nextName.ts);
            if (pickRun && nextRun) {
                toolScopeByRunId.delete(nextRun.key);
                runCursor += 1;
                overflow -= 1;
                continue;
            }
            const pickFp = nextFp && (!nextName || nextFp.ts <= nextName.ts);
            if (pickFp && nextFp) {
                const rows = toolScopeByFingerprint.get(nextFp.key) ?? [];
                if (rows.length > 0) {
                    rows.shift();
                    if (rows.length > 0) {
                        toolScopeByFingerprint.set(nextFp.key, rows);
                    }
                    else {
                        toolScopeByFingerprint.delete(nextFp.key);
                    }
                    overflow -= 1;
                }
                fpCursor += 1;
                continue;
            }
            if (nextName) {
                const rows = toolScopeByName.get(nextName.key) ?? [];
                if (rows.length > 0) {
                    rows.shift();
                    if (rows.length > 0) {
                        toolScopeByName.set(nextName.key, rows);
                    }
                    else {
                        toolScopeByName.delete(nextName.key);
                    }
                    overflow -= 1;
                }
                nameCursor += 1;
                continue;
            }
            break;
        }
    };
    const toolScopeNameKey = (toolName) => {
        return normalizeId(typeof toolName === "string" ? toolName : undefined)?.toLowerCase();
    };
    const toolScopeFingerprint = (toolName, params) => {
        const normalizedToolName = toolScopeNameKey(toolName);
        if (!normalizedToolName)
            return undefined;
        let serialized = "";
        try {
            serialized = JSON.stringify(redact(params ?? {})) ?? "";
        }
        catch {
            serialized = "";
        }
        const digest = crypto.createHash("sha1").update(`${normalizedToolName}|${serialized}`).digest("hex").slice(0, 24);
        return `${normalizedToolName}:${digest}`;
    };
    const rememberToolScopeForRun = (runId, value) => {
        const key = normalizeId(typeof runId === "string" ? runId : undefined);
        if (!key)
            return;
        const ts = nowMs();
        toolScopeByRunId.set(key, {
            ts,
            sessionKey: normalizeId(value.sessionKey),
            requestId: normalizeRequestId(value.requestId),
            routing: value.routing,
        });
        pruneToolScopeMap(ts, toolScopeByRunId.size > TOOL_SCOPE_MEMORY_MAX_ENTRIES);
    };
    const rememberToolScopeForFingerprint = (toolName, params, value) => {
        const key = toolScopeFingerprint(toolName, params);
        if (!key)
            return;
        const ts = nowMs();
        const rows = toolScopeByFingerprint.get(key) ?? [];
        rows.push({
            ts,
            sessionKey: normalizeId(value.sessionKey),
            requestId: normalizeRequestId(value.requestId),
            routing: value.routing,
        });
        while (rows.length > TOOL_SCOPE_FINGERPRINT_QUEUE_MAX) {
            rows.shift();
        }
        toolScopeByFingerprint.set(key, rows);
        pruneToolScopeMap(ts, toolScopeByRunId.size + rows.length > TOOL_SCOPE_MEMORY_MAX_ENTRIES);
    };
    const rememberToolScopeForName = (toolName, value) => {
        const key = toolScopeNameKey(toolName);
        if (!key)
            return;
        const ts = nowMs();
        const rows = toolScopeByName.get(key) ?? [];
        rows.push({
            ts,
            sessionKey: normalizeId(value.sessionKey),
            requestId: normalizeRequestId(value.requestId),
            routing: value.routing,
        });
        while (rows.length > TOOL_SCOPE_FINGERPRINT_QUEUE_MAX) {
            rows.shift();
        }
        toolScopeByName.set(key, rows);
        pruneToolScopeMap(ts, toolScopeByRunId.size + rows.length > TOOL_SCOPE_MEMORY_MAX_ENTRIES);
    };
    const recentToolScopeForRun = (runId) => {
        const key = normalizeId(typeof runId === "string" ? runId : undefined);
        if (!key)
            return undefined;
        const ts = nowMs();
        if (toolScopeByRunId.size > TOOL_SCOPE_MEMORY_MAX_ENTRIES) {
            pruneToolScopeMap(ts, true);
        }
        const row = toolScopeByRunId.get(key);
        if (!row)
            return undefined;
        if (ts - row.ts > TOOL_SCOPE_MEMORY_TTL_MS) {
            toolScopeByRunId.delete(key);
            return undefined;
        }
        return row;
    };
    const recentToolScopeForFingerprint = (toolName, params) => {
        const key = toolScopeFingerprint(toolName, params);
        if (!key)
            return undefined;
        const ts = nowMs();
        if (toolScopeByRunId.size > TOOL_SCOPE_MEMORY_MAX_ENTRIES) {
            pruneToolScopeMap(ts, true);
        }
        const rows = toolScopeByFingerprint.get(key);
        if (!rows || rows.length === 0)
            return undefined;
        const freshRows = rows.filter((row) => ts - row.ts <= TOOL_SCOPE_MEMORY_TTL_MS);
        if (freshRows.length === 0) {
            toolScopeByFingerprint.delete(key);
            return undefined;
        }
        const row = freshRows.pop();
        if (freshRows.length > 0) {
            toolScopeByFingerprint.set(key, freshRows);
        }
        else {
            toolScopeByFingerprint.delete(key);
        }
        return row;
    };
    const recentToolScopeForName = (toolName) => {
        const key = toolScopeNameKey(toolName);
        if (!key)
            return undefined;
        const ts = nowMs();
        if (toolScopeByRunId.size > TOOL_SCOPE_MEMORY_MAX_ENTRIES) {
            pruneToolScopeMap(ts, true);
        }
        const rows = toolScopeByName.get(key);
        if (!rows || rows.length === 0)
            return undefined;
        const freshRows = rows.filter((row) => ts - row.ts <= TOOL_SCOPE_MEMORY_TTL_MS);
        if (freshRows.length === 0) {
            toolScopeByName.delete(key);
            return undefined;
        }
        const row = freshRows.pop();
        if (freshRows.length > 0) {
            toolScopeByName.set(key, freshRows);
        }
        else {
            toolScopeByName.delete(key);
        }
        return row;
    };
    const resolveSessionKey = (meta, ctx2) => {
        const ctxSession = normalizeId(ctx2.sessionKey);
        if (parseSubagentSession(ctxSession))
            return ctxSession;
        const metaSession = normalizeId(meta?.sessionKey);
        if (parseSubagentSession(metaSession))
            return metaSession;
        const metaObj = meta ?? undefined;
        return computeEffectiveSessionKey(metaObj, ctx2);
    };
    const normalizeEventMeta = (meta, topLevelSessionKey) => {
        const merged = {
            ...(meta && typeof meta === "object" ? meta : {}),
        };
        const top = typeof topLevelSessionKey === "string" ? topLevelSessionKey.trim() : "";
        if (!top)
            return merged;
        const mergedSessionKey = typeof merged.sessionKey === "string" ? merged.sessionKey.trim() : "";
        if (!mergedSessionKey || (isBoardSessionKey(top) && !isBoardSessionKey(mergedSessionKey))) {
            merged.sessionKey = top;
        }
        return merged;
    };
    api.on("message_received", async (event, ctx) => {
        const createdAt = new Date().toISOString();
        const raw = event.content ?? "";
        const cleanRaw = sanitizeMessageContent(raw);
        if (isClassifierPayloadText(cleanRaw))
            return;
        if (!cleanRaw)
            return;
        const meta = normalizeEventMeta(event.metadata, event.sessionKey);
        const effectiveSessionKey = resolveSessionKey(meta, ctx);
        const messageId = typeof meta?.messageId === "string" && meta.messageId.trim().length > 0
            ? meta.messageId
            : typeof event.messageId === "string"
                ? (event.messageId ?? "")
                : undefined;
        let requestId = resolveOpenclawRequestId({
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            explicitRequestId: meta?.requestId,
            messageId,
        });
        if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
            return;
        if (shouldSuppressNonSemanticConversation(cleanRaw, {
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            channelId: ctx.channelId,
        })) {
            return;
        }
        const channelId = typeof ctx.channelId === "string" ? ctx.channelId.trim().toLowerCase() : "";
        const inferredRequestId = inferRequestIdFromMessageId(messageId);
        if (channelId === "webchat" &&
            (requestId?.toLowerCase().startsWith(OPENCLAW_REQUEST_ID_PREFIX) || Boolean(inferredRequestId))) {
            // Clawboard already persisted this user prompt via `/api/openclaw/chat`.
            // WebChat can echo it back with a different messageId; skip to avoid duplicate user rows.
            return;
        }
        const directBoardScope = boardScopeFromSessionKey(effectiveSessionKey ?? ctx?.sessionKey);
        if (directBoardScope) {
            rememberBoardScope(directBoardScope, {
                sessionKeys: [effectiveSessionKey, ctx.sessionKey],
                agentIds: [ctx.agentId, parseSubagentSession(ctx.sessionKey)?.ownerAgentId],
            });
            lastChannelId = ctx.channelId;
            lastEffectiveSessionKey = effectiveSessionKey;
            lastMessageAt = Date.now();
            const ctxSessionKey = ctx?.sessionKey ?? effectiveSessionKey;
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
        const inboundSubagent = parseSubagentSession(effectiveSessionKey ?? ctx.sessionKey);
        lastChannelId = ctx.channelId;
        lastEffectiveSessionKey = effectiveSessionKey;
        lastMessageAt = Date.now();
        const ctxSessionKey = ctx?.sessionKey ?? meta?.sessionKey;
        if (ctxSessionKey) {
            inboundBySession.set(ctxSessionKey, {
                ts: lastMessageAt,
                channelId: ctx.channelId,
                sessionKey: effectiveSessionKey,
            });
        }
        const routing = await resolveRoutingScope(effectiveSessionKey, ctx, meta);
        requestId = await resolveOpenclawRequestIdForBoardScope({
            requestId,
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            boardScope: routing.boardScope,
        });
        const topicId = routing.topicId;
        const taskId = routing.taskId;
        const metaSummary = meta?.summary;
        const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);
        const incomingKey = messageId
            ? `received:${ctx.channelId ?? "nochannel"}:${effectiveSessionKey ?? ""}:${messageId}`
            : null;
        if (incomingKey && recentIncoming.has(incomingKey))
            return;
        if (incomingKey)
            rememberIncoming(incomingKey);
        const inboundFingerprintKey = inboundSubagent
            ? null
            : incomingFingerprintDedupeKey(ctx.channelId, effectiveSessionKey, cleanRaw);
        if (inboundFingerprintKey && recentIncoming.has(inboundFingerprintKey))
            return;
        if (inboundFingerprintKey)
            rememberIncoming(inboundFingerprintKey, 60_000);
        const inboundAgentId = inboundSubagent?.ownerAgentId ?? "user";
        const inboundAgentLabel = inboundSubagent
            ? resolveAgentLabel(inboundSubagent.ownerAgentId, `agent:${inboundSubagent.ownerAgentId}`)
            : "User";
        sendAsync({
            topicId,
            taskId,
            type: "conversation",
            content: cleanRaw,
            summary,
            raw: truncateRaw(cleanRaw),
            createdAt,
            agentId: inboundAgentId,
            agentLabel: inboundAgentLabel,
            source: buildSourceMeta({
                channel: ctx.channelId,
                sessionKey: effectiveSessionKey,
                messageId,
                requestId,
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
    const recentOutgoing = new Set();
    const rememberOutgoing = (key) => {
        recentOutgoing.add(key);
        if (recentOutgoing.size > 200) {
            const first = recentOutgoing.values().next().value;
            if (first)
                recentOutgoing.delete(first);
        }
        setTimeout(() => recentOutgoing.delete(key), 30_000)?.unref?.();
    };
    const recentOutgoingBySession = new Map();
    const RECENT_OUTGOING_SESSION_WINDOW_MS = 5 * 60_000;
    const dedupeSessionKey = (sessionKey) => {
        const raw = String(sessionKey ?? "").trim();
        if (!raw)
            return "";
        return raw.split("|", 1)[0] ?? raw;
    };
    const rememberOutgoingSession = (sessionKey) => {
        const key = dedupeSessionKey(sessionKey);
        if (!key)
            return;
        const now = Date.now();
        recentOutgoingBySession.set(key, now);
        for (const [known, ts] of recentOutgoingBySession) {
            if (now - ts > RECENT_OUTGOING_SESSION_WINDOW_MS)
                recentOutgoingBySession.delete(known);
        }
    };
    const hasRecentOutgoingSession = (sessionKey) => {
        const key = dedupeSessionKey(sessionKey);
        if (!key)
            return false;
        const ts = recentOutgoingBySession.get(key);
        if (!ts)
            return false;
        const now = Date.now();
        if (now - ts > RECENT_OUTGOING_SESSION_WINDOW_MS) {
            recentOutgoingBySession.delete(key);
            return false;
        }
        return true;
    };
    const outgoingMessageIdDedupeKey = (channelId, sessionKey, messageId) => {
        const mid = String(messageId ?? "").trim();
        if (!mid)
            return "";
        return `sending:${channelId ?? "nochannel"}:${sessionKey ?? ""}:${mid}`;
    };
    const outgoingFingerprintDedupeKey = (channelId, sessionKey, content) => `sending:${channelId ?? "nochannel"}:${sessionKey ?? ""}:fp:${dedupeFingerprint(content)}`;
    const incomingFingerprintDedupeKey = (channelId, sessionKey, content) => `incoming-fp:${channelId ?? "nochannel"}:${sessionKey ?? ""}:${dedupeFingerprint(content)}`;
    const recentIncoming = new Set();
    const rememberIncoming = (key, ttlMs = 30_000) => {
        recentIncoming.add(key);
        if (recentIncoming.size > 200) {
            const first = recentIncoming.values().next().value;
            if (first)
                recentIncoming.delete(first);
        }
        setTimeout(() => recentIncoming.delete(key), ttlMs)?.unref?.();
    };
    api.on("message_sending", async (event, ctx) => {
        const createdAt = new Date().toISOString();
        const sendEvent = event;
        const raw = sendEvent.content ?? "";
        const cleanRaw = sanitizeMessageContent(raw);
        if (isClassifierPayloadText(cleanRaw))
            return;
        if (!cleanRaw)
            return;
        const meta = normalizeEventMeta(sendEvent.metadata, sendEvent.sessionKey);
        const effectiveSessionKey = resolveSessionKey(meta, ctx);
        let requestId = resolveOpenclawRequestId({
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            explicitRequestId: meta?.requestId,
            messageId: meta?.messageId,
        });
        if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
            return;
        if (shouldSuppressNonSemanticConversation(cleanRaw, {
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            channelId: ctx.channelId,
        })) {
            return;
        }
        const routing = await resolveRoutingScope(effectiveSessionKey, ctx, meta);
        requestId = await resolveOpenclawRequestIdForBoardScope({
            requestId,
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            boardScope: routing.boardScope,
        });
        const topicId = routing.topicId;
        const taskId = routing.taskId;
        // Outbound message content is always assistant-side.
        const agentId = "assistant";
        const agentLabel = resolveAgentLabel(ctx.agentId, meta?.sessionKey ?? ctx?.sessionKey);
        const metaSummary = meta?.summary;
        const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? summarize(metaSummary) : summarize(cleanRaw);
        const messageId = typeof meta?.messageId === "string" ? meta.messageId : undefined;
        const dedupeKeys = [
            outgoingMessageIdDedupeKey(ctx.channelId, effectiveSessionKey, messageId),
            outgoingFingerprintDedupeKey(ctx.channelId, effectiveSessionKey, cleanRaw),
        ].filter(Boolean);
        if (dedupeKeys.some((key) => recentOutgoing.has(key)))
            return;
        for (const key of dedupeKeys)
            rememberOutgoing(key);
        rememberOutgoingSession(effectiveSessionKey ?? ctx.sessionKey);
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
                requestId,
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
    api.on("message_sent", async (event, ctx) => {
        // Avoid double-logging the actual message content; we log it at message_sending.
        // This hook is kept for future delivery status tracking.
        const raw = sanitizeMessageContent(event.content ?? "");
        const meta = normalizeEventMeta(event.metadata, event.sessionKey);
        const sessionKey = meta?.sessionKey ?? ctx?.sessionKey;
        const effectiveSessionKey = sessionKey ?? (ctx.channelId ? `channel:${ctx.channelId}` : undefined);
        if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
            return;
        const dedupeKey = outgoingFingerprintDedupeKey(ctx.channelId, effectiveSessionKey, raw);
        if (recentOutgoing.has(dedupeKey))
            return;
    });
    api.on("before_tool_call", async (event, ctx) => {
        const createdAt = new Date().toISOString();
        const toolParamsRaw = event.params ??
            event.input ??
            {};
        const redacted = redact(toolParamsRaw);
        const toolMeta = normalizeEventMeta(event.metadata, event.sessionKey);
        const effectiveSessionKey = resolveSessionKey(toolMeta, ctx);
        let requestId = resolveOpenclawRequestId({
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            explicitRequestId: event.requestId ??
                event.runId ??
                toolMeta?.requestId,
        });
        if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
            return;
        const routing = await resolveRoutingScope(effectiveSessionKey, ctx);
        requestId = await resolveOpenclawRequestIdForBoardScope({
            requestId,
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            boardScope: routing.boardScope,
        });
        if (!hasSpecificSessionAnchor(effectiveSessionKey, ctx) && !hasToolRoutingAnchor(routing))
            return;
        rememberToolScopeForRun(event.runId, {
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            requestId,
            routing,
        });
        rememberToolScopeForFingerprint(event.toolName, toolParamsRaw, {
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            requestId,
            routing,
        });
        rememberToolScopeForName(event.toolName, {
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            requestId,
            routing,
        });
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
                requestId,
                boardScope: routing.boardScope,
            }),
        });
    });
    api.on("after_tool_call", async (event, ctx) => {
        const createdAt = new Date().toISOString();
        const toolResult = event.result ??
            event.output;
        const toolParamsRaw = event.params ??
            event.input ??
            {};
        const payload = event.error
            ? { error: event.error }
            : { result: redact(toolResult), durationMs: event.durationMs };
        const toolMeta = normalizeEventMeta(event.metadata, event.sessionKey);
        const remembered = recentToolScopeForRun(event.runId) ??
            recentToolScopeForFingerprint(event.toolName, toolParamsRaw) ??
            recentToolScopeForName(event.toolName);
        const resolvedSessionKey = resolveSessionKey(toolMeta, ctx);
        const effectiveSessionKey = hasSpecificSessionAnchor(resolvedSessionKey, ctx) || !remembered?.sessionKey
            ? resolvedSessionKey
            : remembered.sessionKey;
        const explicitRequestId = event.requestId ??
            event.runId ??
            toolMeta?.requestId ??
            remembered?.requestId;
        let requestId = resolveOpenclawRequestId({
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            explicitRequestId,
        });
        if (shouldIgnoreSessionKey(effectiveSessionKey ?? ctx?.sessionKey, IGNORE_SESSION_PREFIXES))
            return;
        const routingResolved = await resolveRoutingScope(effectiveSessionKey, ctx);
        const routing = hasToolRoutingAnchor(routingResolved) || !remembered?.routing ? routingResolved : remembered.routing;
        requestId = await resolveOpenclawRequestIdForBoardScope({
            requestId,
            sessionKey: effectiveSessionKey ?? ctx.sessionKey,
            boardScope: routing.boardScope,
        });
        if (!hasSpecificSessionAnchor(effectiveSessionKey, ctx) && !hasToolRoutingAnchor(routing))
            return;
        if (!event.error && event.toolName === "sessions_spawn" && routing.boardScope) {
            const childSessionKeys = extractSpawnedSubagentSessionKeys(toolResult);
            for (const childSessionKey of childSessionKeys) {
                rememberSpawnedSubagentBoardScope(childSessionKey, routing.boardScope);
                if (requestId) {
                    rememberOpenclawRequestId(childSessionKey, requestId);
                }
            }
        }
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
                requestId,
                boardScope: routing.boardScope,
            }),
        });
    });
    api.on("agent_end", async (event, ctx) => {
        const createdAtBaseMs = Date.now();
        const createdAt = new Date(createdAtBaseMs).toISOString();
        const eventMeta = normalizeEventMeta(event.metadata, event.sessionKey);
        const eventRequestIdRaw = event.requestId ??
            event.runId ??
            eventMeta?.requestId;
        const payload = {
            success: event.success,
            error: event.error,
            durationMs: event.durationMs,
            messageCount: event.messages?.length ?? 0,
        };
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const extractText = (value, depth = 0) => {
            if (!value || depth > 4)
                return undefined;
            if (typeof value === "string")
                return value;
            if (Array.isArray(value)) {
                const parts = value
                    .map((part) => extractText(part, depth + 1))
                    .filter((part) => Boolean(part));
                return parts.length ? parts.join("\n") : undefined;
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
        let requestId = resolveOpenclawRequestId({
            sessionKey: inferredSessionKey ?? ctx.sessionKey,
            explicitRequestId: eventRequestIdRaw,
            messageId: eventMeta?.messageId,
        });
        if (shouldIgnoreSessionKey(inferredSessionKey, IGNORE_SESSION_PREFIXES))
            return;
        const inferredChannelId = (anchorFresh ? anchor?.channelId : undefined) ??
            (inferredSessionKey.startsWith("channel:") && channelFresh ? lastChannelId : undefined);
        const sourceChannel = inferredChannelId ??
            ctx.channelId ??
            (typeof ctx.messageProvider === "string" ? ctx.messageProvider : undefined) ??
            (typeof ctx.provider === "string" ? ctx.provider : undefined) ??
            "direct";
        const routing = await resolveRoutingScope(inferredSessionKey, { ...ctx, channelId: inferredChannelId ?? ctx.channelId });
        requestId = await resolveOpenclawRequestIdForBoardScope({
            requestId,
            sessionKey: inferredSessionKey ?? ctx.sessionKey,
            boardScope: routing.boardScope,
        });
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
                        requestId,
                        boardScope: routing.boardScope,
                    }),
                });
            }
            catch {
                // ignore
            }
        }
        if (!inferredSessionKey) {
            // No session key to attribute messages; skip conversation logs.
        }
        else {
            const isChannelSession = inferredSessionKey.startsWith("channel:");
            const isBoardSession = Boolean(parseBoardSessionKey(inferredSessionKey));
            const isSubagentSession = Boolean(parseSubagentSession(inferredSessionKey));
            const skipBoardAssistantFallback = isBoardSession && hasRecentOutgoingSession(inferredSessionKey);
            let startIdx = 0;
            if (!isChannelSession) {
                const prev = agentEndCursorBySession.get(inferredSessionKey);
                if (typeof prev === "number" && Number.isFinite(prev)) {
                    startIdx = Math.max(0, Math.floor(prev));
                }
                else {
                    // On gateway restart we lose the in-memory cursor; only scan the tail to avoid
                    // re-walking huge direct-session histories (which can stall the gateway).
                    startIdx = Math.max(0, messages.length - 24);
                }
                if (startIdx > messages.length)
                    startIdx = Math.max(0, messages.length - 24);
            }
            // When logging multiple messages from a single agent_end event we want stable chronological ordering
            // without collapsing them onto the same timestamp.
            let agentEndSeq = 0;
            for (let idx = startIdx; idx < messages.length; idx += 1) {
                const msg = messages[idx];
                const role = typeof msg.role === "string" ? msg.role : undefined;
                if (role !== "assistant" && role !== "user")
                    continue;
                if (role === "user" && !isSubagentSession) {
                    // message_received is the source of truth for inbound user rows. agent_end commonly
                    // includes prompt/context echoes as role=user; logging those duplicates/pollutes chats.
                    continue;
                }
                // Heartbeat (and similar system) runs inject the prompt as role=user. Do not log those as "User"
                // so logs do not show "User -> OpenClaw · channel: heartbeat" or pollute task threads.
                const ch = (sourceChannel ?? ctx.channelId ?? "").toString().trim().toLowerCase();
                if (role === "user" && ch === "heartbeat")
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
                if (shouldSuppressNonSemanticConversation(cleanedContent, {
                    sessionKey: inferredSessionKey,
                    channelId: sourceChannel,
                })) {
                    continue;
                }
                const summary = summarize(cleanedContent);
                const fingerprint = dedupeFingerprint(cleanedContent);
                const rawId = typeof msg?.id === "string" ? msg.id : undefined;
                const messageId = stableAgentEndMessageId({
                    sessionKey: inferredSessionKey,
                    role,
                    index: idx,
                    fingerprint,
                    rawId,
                });
                const isJsonLike = cleanedContent.trim().startsWith("{") &&
                    (cleanedContent.includes("\"window\"") ||
                        cleanedContent.includes("\"topic\"") ||
                        cleanedContent.includes("\"candidateTopics\""));
                if (isJsonLike)
                    continue;
                if (role === "user" && isChannelSession && channelFresh) {
                    // Prefer message_received when it fired; otherwise allow agent_end fallback.
                    const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${messageId}`;
                    if (recentIncoming.has(dedupeKey))
                        continue;
                }
                if (role === "assistant") {
                    if (skipBoardAssistantFallback)
                        continue;
                    const dedupeKeys = [
                        outgoingMessageIdDedupeKey(inferredChannelId, inferredSessionKey, messageId),
                        outgoingFingerprintDedupeKey(inferredChannelId, inferredSessionKey, cleanedContent),
                    ].filter(Boolean);
                    if (dedupeKeys.some((key) => recentOutgoing.has(key)))
                        continue;
                    for (const key of dedupeKeys)
                        rememberOutgoing(key);
                    rememberOutgoingSession(inferredSessionKey);
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
                            requestId,
                            boardScope: routing.boardScope,
                            flow: deriveConversationFlow({
                                role: "assistant",
                                sessionKey: inferredSessionKey,
                                agentId: ctx.agentId,
                                assistantLabel: agentLabel,
                            }),
                        }),
                    });
                }
                else {
                    const dedupeKey = `received:${inferredChannelId ?? "nochannel"}:${inferredSessionKey}:${messageId}`;
                    if (recentIncoming.has(dedupeKey))
                        continue;
                    rememberIncoming(dedupeKey);
                    const subagentSession = parseSubagentSession(inferredSessionKey);
                    const inboundAgentId = subagentSession?.ownerAgentId ?? "user";
                    const inboundAgentLabel = subagentSession
                        ? resolveAgentLabel(subagentSession.ownerAgentId, `agent:${subagentSession.ownerAgentId}`)
                        : "User";
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
                        agentId: inboundAgentId,
                        agentLabel: inboundAgentLabel,
                        source: buildSourceMeta({
                            channel: sourceChannel,
                            sessionKey: inferredSessionKey,
                            messageId,
                            requestId,
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
                    requestId,
                    boardScope: routing.boardScope,
                }),
            });
        }
    });
}
// Export utility functions for testing
export { normalizeBaseUrl, sanitizeMessageContent, summarize, dedupeFingerprint, truncateRaw, clip, normalizeWhitespace, tokenSet, lexicalSimilarity };
