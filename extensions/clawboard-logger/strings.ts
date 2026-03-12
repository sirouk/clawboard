import fs from "node:fs/promises";
import path from "node:path";
import { isBoardSessionKey, parseBoardSessionKey } from "./session-key.js";
import type { ContextMode } from "./types.js";

export function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = (process.env[name] ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

export function envBool(name: string, fallback: boolean) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export function isContextMode(value: string): value is ContextMode {
  return value === "auto" || value === "cheap" || value === "full" || value === "patient";
}

export function parseContextModes(
  value: string | undefined | null,
  fallback: ContextMode[] = [],
) {
  const input = typeof value === "string" ? value : "";
  if (!input.trim()) return [...fallback];
  const items = input
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is ContextMode => Boolean(item) && isContextMode(item));
  if (items.length === 0) return [...fallback];
  const seen = new Set<string>();
  const deduped: ContextMode[] = [];
  for (const mode of items) {
    if (seen.has(mode)) continue;
    seen.add(mode);
    deduped.push(mode);
  }
  return deduped;
}

export function parseHookNameList(value: string | undefined | null) {
  const input = typeof value === "string" ? value : "";
  if (!input.trim()) return [];
  const seen = new Set<string>();
  const hooks: string[] = [];
  for (const item of input.split(",")) {
    const name = item.trim();
    if (!name) continue;
    if (!/^[a-z0-9_]+$/i.test(name)) continue;
    const lowered = name.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    hooks.push(lowered);
  }
  return hooks;
}

export function normalizeBaseUrl(url: string) {
  return url.replace(/\/$/, "");
}

export function normalizeBaseUrlCandidate(value: string | undefined | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.search = "";
    parsed.hash = "";
    return normalizeBaseUrl(parsed.toString());
  } catch {
    return "";
  }
}

export function parseBaseUrlList(value: string | undefined | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const parts = raw.split(",").map((item) => normalizeBaseUrlCandidate(item)).filter(Boolean);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    deduped.push(part);
  }
  return deduped;
}

export function isLoopbackHost(hostname: string) {
  const host = String(hostname ?? "").trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function defaultLoopbackFallbacks(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl);
    if (isLoopbackHost(parsed.hostname)) return [];
    const protocol = parsed.protocol;
    const port = parsed.port ? `:${parsed.port}` : "";
    const pathname = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/$/, "") : "";
    return [
      `${protocol}//127.0.0.1${port}${pathname}`,
      `${protocol}//localhost${port}${pathname}`,
    ].map((item) => normalizeBaseUrlCandidate(item)).filter(Boolean);
  } catch {
    return [];
  }
}

export function buildBaseUrlCandidates(primaryBaseUrl: string, explicitFallbacks: string[]) {
  const primary = normalizeBaseUrlCandidate(primaryBaseUrl);
  if (!primary) return [];
  const candidates = [primary, ...explicitFallbacks, ...defaultLoopbackFallbacks(primary)];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeBaseUrlCandidate(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

export function isRetryableFetchError(err: unknown) {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || "").toLowerCase();
  const cause = (err as unknown as { cause?: unknown }).cause;
  let code = "";
  if (cause && typeof cause === "object") {
    const maybe = (cause as { code?: unknown }).code;
    if (typeof maybe === "string") code = maybe.toUpperCase();
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  return (
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("enotfound")
  );
}

const REPLY_DIRECTIVE_TAG_RE =
  /(?:\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]|\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\])\s*/gi;

export function stripClawboardWrapperArtifacts(content: string) {
  let text = content ?? "";
  text = text.replace(/\[CLAWBOARD_CONTEXT_BEGIN\]\s*/gi, "");
  text = text.replace(/\[CLAWBOARD_CONTEXT_END\]\s*/gi, "");
  text = text.replace(/^\s*Conversation info \(untrusted metadata\)\s*:\s*```(?:json)?\s*[\s\S]*?```\s*/gim, "");
  text = text.replace(/^\s*Conversation info \(untrusted metadata\)\s*:\s*\{[\s\S]*?\}\s*/gim, "");
  text = text.replace(REPLY_DIRECTIVE_TAG_RE, " ");
  return text;
}

export function sanitizeRetrievedContextBlock(content: string) {
  let text = (content ?? "").replace(/\r\n?/g, "\n").trim();
  text = stripClawboardWrapperArtifacts(text);
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function sanitizeMessageContent(content: string) {
  let text = (content ?? "").replace(/\r\n?/g, "\n").trim();
  text = text.replace(/\[CLAWBOARD_CONTEXT_BEGIN\][\s\S]*?\[CLAWBOARD_CONTEXT_END\]\s*/gi, "");
  text = stripClawboardWrapperArtifacts(text);
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
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function shouldSuppressReplyDirectivesForSession(sessionKey: string | undefined) {
  return Boolean(sessionKey && isBoardSessionKey(sessionKey));
}

const SUMMARY_MAX = 72;
const RAW_MAX = 5000;

export function summarize(content: string) {
  const trimmed = sanitizeMessageContent(content).replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= SUMMARY_MAX) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX - 1).trim()}…`;
}

export function dedupeFingerprint(content: string) {
  const normalized = sanitizeMessageContent(content).replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return "empty";
  return `${normalized.slice(0, 220)}|${normalized.length}`;
}

export function truncateRaw(content: string) {
  if (content.length <= RAW_MAX) return content;
  return `${content.slice(0, RAW_MAX - 1)}…`;
}

export function clip(text: string, limit: number) {
  const value = (text ?? "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trim()}…`;
}

export function normalizeWhitespace(value: string) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function tokenSet(value: string) {
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

export function lexicalSimilarity(a: string, b: string) {
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

export function normalizeTaskIdentity(value: string | undefined | null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return "";
  return normalized.replace(/^task[-_:]?/i, "");
}

export function resolveBoardTaskPatchId(
  requestedId: string | undefined | null,
  sessionKey: string | undefined | null,
  fallbackTaskId?: string | undefined | null
) {
  const requested = typeof requestedId === "string" ? requestedId.trim() : "";
  const route = parseBoardSessionKey(sessionKey);
  const sessionTaskId =
    route?.kind === "task"
      ? route.taskId
      : (typeof fallbackTaskId === "string" ? fallbackTaskId.trim() : "");
  if (!requested) return sessionTaskId || undefined;
  if (!sessionTaskId) return requested;
  if (requested === sessionTaskId) return requested;
  if (normalizeTaskIdentity(requested) === normalizeTaskIdentity(sessionTaskId)) return sessionTaskId;
  if (!/^task[-_:]/i.test(requested)) return sessionTaskId;
  return requested;
}

export function extractTextLoose(value: unknown, depth = 0): string | undefined {
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

export function latestUserInput(prompt: string | undefined, messages: unknown[] | undefined) {
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

export function isClassifierPayloadText(content: string) {
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

export function normalizeChannelId(value: string | undefined | null) {
  return String(value ?? "").trim().toLowerCase();
}

export function isMainAgentSessionKey(value: string | undefined | null) {
  const key = String(value ?? "").trim();
  if (!key) return false;
  const base = key.split("|", 1)[0] ?? key;
  return base.trim().toLowerCase() === "agent:main:main";
}

export function isHeartbeatControlPlaneText(
  content: string,
  params?: {
    sessionKey?: string | null;
    channelId?: string | null;
  },
) {
  const clean = sanitizeMessageContent(content).trim();
  if (!clean) return false;
  const channel = normalizeChannelId(params?.channelId);
  const mainAgentSession = isMainAgentSessionKey(params?.sessionKey);

  if (channel === "heartbeat" || channel === "cron-event") return true;
  if (/^\[cron:[^\]]+\]/i.test(clean)) return true;
  if (/^\s*heartbeat\s*:/i.test(clean)) return mainAgentSession || channel === "heartbeat";
  if (/^\s*heartbeat_ok\s*$/i.test(clean)) return mainAgentSession || channel === "heartbeat";
  if (mainAgentSession && /heartbeat and watchdog recovery check/i.test(clean)) return true;
  return false;
}

export function isSubagentScaffoldText(content: string, sessionKey: string | undefined | null) {
  const clean = sanitizeMessageContent(content).trim();
  if (!clean) return false;
  if (!/^\s*\[subagent context\]/i.test(clean)) return false;
  const key = String(sessionKey ?? "").trim().toLowerCase();
  return key.includes(":subagent:");
}

export function shouldSuppressNonSemanticConversation(
  content: string,
  params?: {
    sessionKey?: string | null;
    channelId?: string | null;
  },
) {
  const sessionKey = params?.sessionKey ?? undefined;
  if (isSubagentScaffoldText(content, sessionKey)) return true;
  if (isHeartbeatControlPlaneText(content, params)) return true;
  return false;
}

export function redact(value: unknown, depth = 0): unknown {
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

export async function ensureDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}
