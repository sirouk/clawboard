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

  if (!enabled) {
    api.logger.warn("[clawboard-logger] disabled by config");
    return;
  }

  if (!baseUrl) {
    api.logger.warn("[clawboard-logger] baseUrl missing; plugin disabled");
    return;
  }

  let flushing = false;

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
    const metaSummary = (event.metadata as Record<string, unknown> | undefined)?.summary;
    const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? metaSummary : summarize(raw);
    await send({
      type: "conversation",
      content: raw,
      summary,
      raw,
      agentId: "user",
      agentLabel: "User",
      source: {
        channel: ctx.channelId,
        sessionKey: (event.metadata as Record<string, unknown> | undefined)?.sessionKey,
        messageId: (event.metadata as Record<string, unknown> | undefined)?.messageId,
      },
    });
  });

  api.on("message_sent", async (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => {
    const raw = event.content ?? "";
    const metaSummary = (event as unknown as Record<string, unknown>)?.summary;
    const summary = typeof metaSummary === "string" && metaSummary.trim().length > 0 ? metaSummary : summarize(raw);
    await send({
      type: "conversation",
      content: raw,
      summary,
      raw,
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: {
        channel: ctx.channelId,
        sessionKey: (event as unknown as Record<string, unknown>)?.sessionKey,
      },
    });
  });

  api.on("before_tool_call", async (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
    const redacted = redact(event.params);
    await send({
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

    await send({
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

    await send({
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
