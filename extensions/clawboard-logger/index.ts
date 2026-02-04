import type {
  OpenClawPluginApi,
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
  queuePath?: string;
  /** Optional: force all logs into a single topic. */
  defaultTopicId?: string;
  /** Optional: force all logs into a single task. */
  defaultTaskId?: string;
  /** When true (default), auto-create a topic per OpenClaw sessionKey and attach logs to it. */
  autoTopicBySession?: boolean;
};

const DEFAULT_QUEUE = path.join(os.homedir(), ".openclaw", "clawboard-queue.jsonl");
const SUMMARY_MAX = 160;
const RAW_MAX = 5000;

function normalizeBaseUrl(url: string) {
  return url.replace(/\/$/, "");
}

function summarize(content: string) {
  const trimmed = content.trim().replace(/\s+/g, " ");
  if (trimmed.length <= SUMMARY_MAX) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX - 1)}…`;
}

function truncateRaw(content: string) {
  if (content.length <= RAW_MAX) return content;
  return `${content.slice(0, RAW_MAX - 1)}…`;
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
  const baseUrl = rawConfig.baseUrl ? normalizeBaseUrl(rawConfig.baseUrl) : "";
  const token = rawConfig.token;
  const queuePath = rawConfig.queuePath ?? DEFAULT_QUEUE;
  const defaultTopicId = rawConfig.defaultTopicId;
  const defaultTaskId = rawConfig.defaultTaskId;
  const autoTopicBySession = rawConfig.autoTopicBySession !== false;

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
      const res = await fetch(`${baseUrl}/api/log`, {
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

  api.on("message_received", async (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => {
    const raw = event.content ?? "";
    const meta = (event.metadata as Record<string, unknown> | undefined) ?? undefined;
    const sessionKey = (meta?.sessionKey as string | undefined) ?? undefined;
    const topicId = await resolveTopicId(sessionKey);
    const taskId = resolveTaskId();

    const metaSummary = meta?.summary;
    const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? metaSummary : summarize(raw);

    await send({
      topicId,
      taskId,
      type: "conversation",
      content: raw,
      summary,
      raw,
      agentId: "user",
      agentLabel: "User",
      source: {
        channel: ctx.channelId,
        sessionKey,
        messageId: meta?.messageId,
      },
    });
  });

  api.on("message_sent", async (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => {
    const raw = event.content ?? "";
    const meta = (event as unknown as Record<string, unknown>) ?? {};
    const sessionKey = (meta?.sessionKey as string | undefined) ?? (ctx as unknown as { sessionKey?: string })?.sessionKey;
    const topicId = await resolveTopicId(sessionKey);
    const taskId = resolveTaskId();

    const metaSummary = meta?.summary;
    const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? metaSummary : summarize(raw);

    await send({
      topicId,
      taskId,
      type: "conversation",
      content: raw,
      summary,
      raw,
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: {
        channel: ctx.channelId,
        sessionKey,
      },
    });
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
  });
}
