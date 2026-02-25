import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import register from "./index.js";

function makeApi(config = {}) {
  const handlers = new Map();
  const api = {
    pluginConfig: {
      baseUrl: "http://clawboard.test",
      token: "test-token",
      enabled: true,
      autoTopicBySession: false,
      ...config,
    },
    logger: {
      warn() {},
      info() {},
      error() {},
      debug() {},
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool() {},
    __handlers: handlers,
  };
  return api;
}

function createFetchMock(plan) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (typeof plan === "function") {
      return plan(calls.length, url, options, calls);
    }
    const step = Array.isArray(plan) ? plan[calls.length - 1] : null;
    if (step instanceof Error) throw step;
    if (step && step.throwError) throw step.throwError;
    const ok = step && typeof step.ok === "boolean" ? step.ok : true;
    const body = step && step.body !== undefined ? step.body : {};
    return {
      ok,
      status: ok ? 200 : 500,
      async json() {
        return body;
      },
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body);
      },
    };
  };
  return { fn, calls };
}

async function waitFor(condition, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function parseBody(call) {
  return JSON.parse(String(call.options?.body || "{}"));
}

function isStartupAction(call) {
  try {
    const payload = parseBody(call);
    return payload.type === "action" && payload.content === "clawboard-logger startup: routing enabled";
  } catch {
    return false;
  }
}

function meaningfulCalls(calls) {
  return calls.filter((call) => !isStartupAction(call));
}

test("message_received logs user conversation with dedupe metadata (ING-001)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    await handler(
      {
        content: "Hello from Discord",
        metadata: {
          sessionKey: "channel:discord-123",
          messageId: "discord-msg-1",
        },
      },
      {
        channelId: "discord",
        conversationId: "channel:discord-123",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const call = meaningfulCalls(calls)[0];
    const payload = parseBody(call);
    assert.equal(call.url, "http://clawboard.test/api/log");
    assert.equal(call.options?.method, "POST");
    assert.equal(payload.type, "conversation");
    assert.equal(payload.agentId, "user");
    assert.equal(payload.content, "Hello from Discord");
    assert.equal(payload.source.sessionKey, "channel:discord-123");
    assert.equal(payload.source.messageId, "discord-msg-1");
    assert.ok(String(call.options?.headers?.["X-Idempotency-Key"] || "").includes("discord-msg-1"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("message_sending logs assistant row; message_sent does not duplicate it (ING-002)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const sending = api.__handlers.get("message_sending");
    const sent = api.__handlers.get("message_sent");
    assert.equal(typeof sending, "function");
    assert.equal(typeof sent, "function");

    const event = {
      content: "Assistant reply",
      metadata: {
        sessionKey: "channel:discord-456",
        messageId: "assistant-msg-1",
      },
    };
    const ctx = {
      channelId: "discord",
      conversationId: "channel:discord-456",
      agentId: "main",
    };

    await sending(event, ctx);
    await sent(event, ctx);

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const relevant = meaningfulCalls(calls);
    // message_sent should not append another log row.
    assert.equal(relevant.length, 1);
    const payload = parseBody(relevant[0]);
    assert.equal(payload.type, "conversation");
    assert.equal(payload.agentId, "assistant");
    assert.equal(payload.content, "Assistant reply");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("board session assistant output is not duplicated between message_sending and agent_end", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const sending = api.__handlers.get("message_sending");
    const agentEnd = api.__handlers.get("agent_end");
    assert.equal(typeof sending, "function");
    assert.equal(typeof agentEnd, "function");

    const sessionKey = "clawboard:task:topic-dup-1:task-dup-1";
    await sending(
      {
        content: "Done — I made an actual edit.",
        metadata: {
          sessionKey,
          messageId: "assistant-dup-msg-1",
          requestId: "occhat-dup-1",
        },
      },
      {
        channelId: "openclaw",
        conversationId: sessionKey,
        sessionKey,
        agentId: "main",
      }
    );

    await agentEnd(
      {
        success: true,
        messages: [
          {
            role: "assistant",
            content:
              "Done — I made an actual edit.\n\nI changed:\n- `/tmp/file.md`",
          },
        ],
      },
      {
        channelId: "openclaw",
        conversationId: sessionKey,
        sessionKey,
        agentId: "main",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const assistantConversationRows = meaningfulCalls(calls)
      .map((call) => parseBody(call))
      .filter(
        (payload) =>
          payload.type === "conversation" &&
          payload.agentId === "assistant" &&
          payload?.source?.sessionKey === sessionKey
      );
    assert.equal(assistantConversationRows.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("message_sending includes requestId in source metadata when present", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const sending = api.__handlers.get("message_sending");
    assert.equal(typeof sending, "function");

    await sending(
      {
        content: "Assistant reply with request id",
        metadata: {
          sessionKey: "clawboard:topic:topic-req-1",
          messageId: "assistant-msg-req-1",
          requestId: "occhat-request-meta-1",
        },
      },
      {
        channelId: "openclaw",
        conversationId: "clawboard:topic:topic-req-1",
        agentId: "main",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const payload = parseBody(meaningfulCalls(calls)[0]);
    assert.equal(payload.type, "conversation");
    assert.equal(payload.agentId, "assistant");
    assert.equal(payload.source.requestId, "occhat-request-meta-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent_end fallback reuses recent board-session requestId", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const received = api.__handlers.get("message_received");
    const agentEnd = api.__handlers.get("agent_end");
    assert.equal(typeof received, "function");
    assert.equal(typeof agentEnd, "function");

    await received(
      {
        content: "already persisted by backend",
        metadata: {
          sessionKey: "clawboard:topic:topic-req-fallback",
          messageId: "occhat-request-fallback-1",
        },
      },
      {
        channelId: "openclaw",
        sessionKey: "clawboard:topic:topic-req-fallback",
        conversationId: "clawboard:topic:topic-req-fallback",
        agentId: "main",
      }
    );

    await agentEnd(
      {
        success: true,
        messages: [{ role: "assistant", content: "Fallback assistant payload with request id" }],
      },
      {
        sessionKey: "clawboard:topic:topic-req-fallback",
        channelId: "openclaw",
        agentId: "main",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const payload = parseBody(meaningfulCalls(calls)[0]);
    assert.equal(payload.type, "conversation");
    assert.equal(payload.agentId, "assistant");
    assert.equal(payload.source.requestId, "occhat-request-fallback-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent_end ignores non-subagent user-role echoes", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const agentEnd = api.__handlers.get("agent_end");
    assert.equal(typeof agentEnd, "function");
    const sessionKey = "clawboard:task:topic-user-echo-1:task-user-echo-1";

    await agentEnd(
      {
        success: true,
        messages: [
          {
            role: "user",
            content: "System: You are the main OpenClaw agent. Continue this task.",
          },
        ],
      },
      {
        sessionKey,
        channelId: "openclaw",
        agentId: "main",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    const conversationRows = meaningfulCalls(calls)
      .map((call) => parseBody(call))
      .filter((payload) => payload.type === "conversation")
      .filter((payload) => String(payload?.source?.sessionKey || "") === sessionKey);
    assert.equal(conversationRows.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_agent_start adds no-reply-directive hint for board sessions", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, _options = {}) => {
      if (String(url).includes("/api/context")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { block: "board context block" };
          },
          async text() {
            return '{"block":"board context block"}';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        },
      };
    };

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("before_agent_start");
    assert.equal(typeof handler, "function");

    const result = await handler(
      {
        prompt: "What should I do next?",
        messages: [],
      },
      {
        sessionKey: "clawboard:topic:topic-123",
        conversationId: "clawboard:topic:topic-123",
      }
    );

    const prependContext = String(result?.prependContext || "");
    assert.ok(prependContext.includes("board context block"));
    assert.ok(prependContext.includes("never emit [[reply_to_current]] or [[reply_to:<id>]] tags"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_agent_start skips no-reply-directive hint for non-board sessions", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, _options = {}) => {
      if (String(url).includes("/api/context")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { block: "generic context block" };
          },
          async text() {
            return '{"block":"generic context block"}';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        },
      };
    };

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("before_agent_start");
    assert.equal(typeof handler, "function");

    const result = await handler(
      {
        prompt: "What should I do next?",
        messages: [],
      },
      {
        sessionKey: "channel:discord-123",
        conversationId: "channel:discord-123",
      }
    );

    const prependContext = String(result?.prependContext || "");
    assert.ok(prependContext.includes("generic context block"));
    assert.equal(prependContext.includes("never emit [[reply_to_current]] or [[reply_to:<id>]] tags"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_agent_start defaults to clawboard-only memory instruction", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, _options = {}) => {
      if (String(url).includes("/api/context")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { block: "memory policy context block" };
          },
          async text() {
            return '{"block":"memory policy context block"}';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        },
      };
    };

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("before_agent_start");
    assert.equal(typeof handler, "function");

    const result = await handler(
      {
        prompt: "Plan next steps",
        messages: [],
      },
      {
        sessionKey: "channel:discord-123",
        conversationId: "channel:discord-123",
      }
    );

    const prependContext = String(result?.prependContext || "");
    assert.ok(prependContext.includes("Do not run OpenClaw memory_search/memory_get"));
    assert.equal(prependContext.includes("merged with existing OpenClaw memory/turn context"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_agent_start can allow openclaw memory merge when explicitly enabled", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, _options = {}) => {
      if (String(url).includes("/api/context")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { block: "memory policy context block" };
          },
          async text() {
            return '{"block":"memory policy context block"}';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        },
      };
    };

    const api = makeApi({ enableOpenClawMemorySearch: true });
    register(api);

    const handler = api.__handlers.get("before_agent_start");
    assert.equal(typeof handler, "function");

    const result = await handler(
      {
        prompt: "Plan next steps",
        messages: [],
      },
      {
        sessionKey: "channel:discord-123",
        conversationId: "channel:discord-123",
      }
    );

    const prependContext = String(result?.prependContext || "");
    assert.ok(prependContext.includes("merged with existing OpenClaw memory/turn context"));
    assert.equal(prependContext.includes("Do not run OpenClaw memory_search/memory_get"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_agent_start skips context retrieval for heartbeat control-plane prompts", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, _options = {}) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return { block: "should-not-be-used" };
        },
        async text() {
          return '{"block":"should-not-be-used"}';
        },
      };
    };

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("before_agent_start");
    assert.equal(typeof handler, "function");

    const result = await handler(
      {
        prompt: "Heartbeat: run continuity check now",
        messages: [{ role: "user", content: "Heartbeat: run continuity check now" }],
      },
      {
        sessionKey: "agent:main:main",
        conversationId: "agent:main:main",
        channelId: "imessage",
      }
    );

    assert.equal(result, undefined);
    assert.equal(calls.some((url) => url.includes("/api/context")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_agent_start falls back to configured context mode when primary mode retrieval fails", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, _options = {}) => {
      const rawUrl = String(url);
      calls.push(rawUrl);
      if (!rawUrl.includes("/api/context")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {};
          },
          async text() {
            return "{}";
          },
        };
      }
      const parsed = new URL(rawUrl);
      const mode = parsed.searchParams.get("mode");
      if (mode === "auto") {
        throw new Error("simulated timeout");
      }
      if (mode === "full") {
        return {
          ok: true,
          status: 200,
          async json() {
            return { block: "fallback full context block" };
          },
          async text() {
            return '{"block":"fallback full context block"}';
          },
        };
      }
      return {
        ok: false,
        status: 503,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        },
      };
    };

    const api = makeApi({
      contextMode: "auto",
      contextFetchRetries: 0,
      contextFallbackModes: ["full", "cheap"],
    });
    register(api);

    const handler = api.__handlers.get("before_agent_start");
    assert.equal(typeof handler, "function");

    const result = await handler(
      {
        prompt: "Plan next steps",
        messages: [],
      },
      {
        sessionKey: "channel:test-fallback",
        conversationId: "channel:test-fallback",
      }
    );

    const prependContext = String(result?.prependContext || "");
    assert.ok(prependContext.includes("fallback full context block"));
    const contextCalls = calls.filter((url) => url.includes("/api/context"));
    assert.equal(contextCalls.length >= 2, true);
    assert.equal(new URL(contextCalls[0]).searchParams.get("mode"), "auto");
    assert.equal(new URL(contextCalls[1]).searchParams.get("mode"), "full");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_agent_start injects context for subagent scaffold prompts using generic retrieval query", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, _options = {}) => {
      const rawUrl = String(url);
      calls.push(rawUrl);
      if (rawUrl.includes("/api/context")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { block: "subagent context block" };
          },
          async text() {
            return '{"block":"subagent context block"}';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        },
      };
    };

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("before_agent_start");
    assert.equal(typeof handler, "function");

    const result = await handler(
      {
        prompt:
          "[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester.",
        messages: [],
      },
      {
        sessionKey: "agent:coding:subagent:test-scaffold",
        conversationId: "agent:coding:subagent:test-scaffold",
        channelId: "direct",
      }
    );

    const prependContext = String(result?.prependContext || "");
    assert.ok(prependContext.includes("subagent context block"));
    const contextCall = calls.find((url) => url.includes("/api/context"));
    assert.ok(contextCall, "expected /api/context call");
    const q = new URL(contextCall).searchParams.get("q");
    assert.equal(q, "current conversation continuity, active topics, active tasks, and curated notes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_tool_call emits action log with tool call summary (ING-003)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("before_tool_call");
    assert.equal(typeof handler, "function");

    await handler(
      {
        toolName: "web.search",
        params: { q: "idempotency" },
      },
      {
        sessionKey: "channel:test-tools",
        channelId: "discord",
        agentId: "assistant",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const payload = parseBody(meaningfulCalls(calls)[0]);
    assert.equal(payload.type, "action");
    assert.equal(payload.content, "Tool call: web.search");
    assert.equal(payload.summary, "Tool call: web.search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_tool_call inherits requestId across wrapped subagent session keys", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const received = api.__handlers.get("message_received");
    const toolCall = api.__handlers.get("before_tool_call");
    assert.equal(typeof received, "function");
    assert.equal(typeof toolCall, "function");

    await received(
      {
        content: "start request chain",
        metadata: {
          sessionKey: "clawboard:topic:topic-tool-request-001",
          messageId: "occhat-tool-request-001",
          requestId: "occhat-tool-request-001",
        },
      },
      {
        channelId: "webchat",
        sessionKey: "clawboard:topic:topic-tool-request-001",
        conversationId: "clawboard:topic:topic-tool-request-001",
      }
    );

    await toolCall(
      {
        toolName: "memory.search",
        params: { q: "progress" },
      },
      {
        sessionKey: "bridge:subagent:worker-1:clawboard:topic:topic-tool-request-001",
        channelId: "webchat",
        agentId: "assistant",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const payload = parseBody(meaningfulCalls(calls)[0]);
    assert.equal(payload.type, "action");
    assert.equal(payload.content, "Tool call: memory.search");
    assert.equal(payload.source.requestId, "occhat-tool-request-001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_tool_call recovers requestId from board session logs when in-memory request map is cold", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const call = { url: String(url), options };
      calls.push(call);
      if (String(url).includes("/api/log?")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return [
              {
                type: "conversation",
                agentId: "user",
                source: {
                  requestId: "occhat-board-fallback-req-1",
                  messageId: "occhat-board-fallback-req-1",
                },
              },
            ];
          },
          async text() {
            return '[{"type":"conversation","agentId":"user","source":{"requestId":"occhat-board-fallback-req-1"}}]';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        },
      };
    };

    const api = makeApi();
    register(api);

    const toolCall = api.__handlers.get("before_tool_call");
    assert.equal(typeof toolCall, "function");

    await toolCall(
      {
        toolName: "sessions_spawn",
        params: { agentId: "coding" },
      },
      {
        sessionKey: "agent:main:clawboard:task:topic-board-fallback-1:task-board-fallback-1",
        channelId: "openclaw",
        agentId: "main",
      }
    );

    await waitFor(
      () =>
        calls.some(
          (call) => String(call.options?.method || "").toUpperCase() === "POST" && String(call.url).includes("/api/log")
        ),
      2000
    );
    const postCalls = calls.filter(
      (call) => String(call.options?.method || "").toUpperCase() === "POST" && String(call.url).includes("/api/log")
    );
    const payload = parseBody(postCalls[postCalls.length - 1]);
    assert.equal(payload.type, "action");
    assert.equal(payload.source.requestId, "occhat-board-fallback-req-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subagent tool logs inherit board scope from parent board session when ctx.agentId is absent", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const queuePath = path.join(
      os.tmpdir(),
      `clawboard-logger-scope-inherit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
    );
    const api = makeApi({ queuePath });
    register(api);

    const toolCall = api.__handlers.get("before_tool_call");
    const toolResult = api.__handlers.get("after_tool_call");
    assert.equal(typeof toolCall, "function");
    assert.equal(typeof toolResult, "function");

    const parentSessionKey = "agent:main:clawboard:task:topic-scope-inherit-1:task-scope-inherit-1";
    const childSessionKey = "agent:coding:subagent:scope-inherit-worker-1";

    // Simulate a parent board-scoped tool call where ctx.agentId is unavailable.
    await toolCall(
      {
        toolName: "sessions_spawn",
        params: { agentId: "coding" },
      },
      {
        sessionKey: parentSessionKey,
        channelId: "openclaw",
      }
    );

    await toolResult(
      {
        toolName: "sessions_spawn",
        result: { status: "accepted", childSessionKey },
        durationMs: 8,
      },
      {
        sessionKey: parentSessionKey,
        channelId: "openclaw",
      }
    );

    // Simulate the spawned subagent's first tool call.
    await toolCall(
      {
        toolName: "exec",
        params: { command: "pwd" },
      },
      {
        sessionKey: childSessionKey,
        channelId: "openclaw",
        agentId: "coding",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 3);
    const childPayload = meaningfulCalls(calls)
      .map((call) => parseBody(call))
      .find((payload) => payload?.source?.sessionKey === childSessionKey);

    assert.ok(childPayload, "expected child subagent action log");
    assert.equal(childPayload.topicId, "topic-scope-inherit-1");
    assert.equal(childPayload.taskId, "task-scope-inherit-1");
    assert.equal(childPayload.source.boardScopeTopicId, "topic-scope-inherit-1");
    assert.equal(childPayload.source.boardScopeTaskId, "task-scope-inherit-1");
    assert.equal(childPayload.source.boardScopeInherited, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("spawned subagent tool logs inherit parent requestId via board scope fallback", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const queuePath = path.join(
      os.tmpdir(),
      `clawboard-logger-request-inherit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
    );
    const api = makeApi({ queuePath });
    register(api);

    const received = api.__handlers.get("message_received");
    const toolCall = api.__handlers.get("before_tool_call");
    const toolResult = api.__handlers.get("after_tool_call");
    assert.equal(typeof received, "function");
    assert.equal(typeof toolCall, "function");
    assert.equal(typeof toolResult, "function");

    const requestId = "occhat-subagent-request-001";
    const parentSessionKey = "agent:main:clawboard:task:topic-request-inherit-1:task-request-inherit-1";
    const childSessionKey = "agent:coding:subagent:request-inherit-child-1";

    await received(
      {
        content: "start delegated task",
        metadata: {
          sessionKey: "clawboard:task:topic-request-inherit-1:task-request-inherit-1",
          messageId: requestId,
          requestId,
        },
      },
      {
        channelId: "openclaw",
        sessionKey: "clawboard:task:topic-request-inherit-1:task-request-inherit-1",
        conversationId: "clawboard:task:topic-request-inherit-1:task-request-inherit-1",
        agentId: "main",
      }
    );

    await toolCall(
      {
        toolName: "sessions_spawn",
        params: { agentId: "coding" },
      },
      {
        sessionKey: parentSessionKey,
        channelId: "openclaw",
        agentId: "main",
      }
    );

    await toolResult(
      {
        toolName: "sessions_spawn",
        result: { status: "accepted", childSessionKey },
        durationMs: 8,
      },
      {
        sessionKey: parentSessionKey,
        channelId: "openclaw",
        agentId: "main",
      }
    );

    await toolCall(
      {
        toolName: "exec",
        params: { command: "pwd" },
      },
      {
        sessionKey: childSessionKey,
        channelId: "openclaw",
        agentId: "coding",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 3);
    const childPayload = meaningfulCalls(calls)
      .map((call) => parseBody(call))
      .find((payload) => payload?.source?.sessionKey === childSessionKey && payload?.content === "Tool call: exec");
    assert.ok(childPayload, "expected child subagent action log");
    assert.equal(childPayload.source.requestId, requestId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subagent tool logs do not inherit board scope without explicit spawn linkage", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const queuePath = path.join(
      os.tmpdir(),
      `clawboard-logger-scope-guard-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
    );
    const api = makeApi({ queuePath });
    register(api);

    const toolCall = api.__handlers.get("before_tool_call");
    const toolResult = api.__handlers.get("after_tool_call");
    assert.equal(typeof toolCall, "function");
    assert.equal(typeof toolResult, "function");

    const parentSessionKey = "agent:main:clawboard:task:topic-scope-guard-1:task-scope-guard-1";
    const linkedChildSessionKey = "agent:coding:subagent:scope-guard-linked-1";
    const unrelatedChildSessionKey = "agent:coding:subagent:scope-guard-unrelated-1";

    await toolCall(
      {
        toolName: "sessions_spawn",
        params: { agentId: "coding" },
      },
      {
        sessionKey: parentSessionKey,
        channelId: "openclaw",
      }
    );

    await toolResult(
      {
        toolName: "sessions_spawn",
        result: { status: "accepted", childSessionKey: linkedChildSessionKey },
        durationMs: 8,
      },
      {
        sessionKey: parentSessionKey,
        channelId: "openclaw",
      }
    );

    await toolCall(
      {
        toolName: "exec",
        params: { command: "pwd" },
      },
      {
        sessionKey: unrelatedChildSessionKey,
        channelId: "openclaw",
        agentId: "coding",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 3);
    const unrelatedPayload = meaningfulCalls(calls)
      .map((call) => parseBody(call))
      .find((payload) => payload?.source?.sessionKey === unrelatedChildSessionKey);

    assert.ok(unrelatedPayload, "expected unrelated subagent action log");
    assert.equal(unrelatedPayload.topicId, undefined);
    assert.equal(unrelatedPayload.taskId, undefined);
    assert.equal(unrelatedPayload.source.boardScopeTopicId, undefined);
    assert.equal(unrelatedPayload.source.boardScopeTaskId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subagent routing ignores stale conversation board scope when child linkage exists", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const queuePath = path.join(
      os.tmpdir(),
      `clawboard-logger-scope-stale-conv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
    );
    const api = makeApi({ queuePath });
    register(api);

    const toolCall = api.__handlers.get("before_tool_call");
    const toolResult = api.__handlers.get("after_tool_call");
    assert.equal(typeof toolCall, "function");
    assert.equal(typeof toolResult, "function");

    const staleParentSessionKey = "agent:main:clawboard:task:topic-scope-stale-1:task-scope-stale-1";
    const currentParentSessionKey = "agent:main:clawboard:task:topic-scope-current-1:task-scope-current-1";
    const childSessionKey = "agent:coding:subagent:scope-current-child-1";

    // Prime stale board scope in memory, simulating older board context that should not leak.
    await toolCall(
      {
        toolName: "exec",
        params: { command: "echo stale" },
      },
      {
        sessionKey: staleParentSessionKey,
        channelId: "openclaw",
      }
    );

    // Spawn child from the current board-scoped parent, which must define child inheritance.
    await toolCall(
      {
        toolName: "sessions_spawn",
        params: { agentId: "coding" },
      },
      {
        sessionKey: currentParentSessionKey,
        channelId: "openclaw",
      }
    );

    await toolResult(
      {
        toolName: "sessions_spawn",
        result: { status: "accepted", childSessionKey },
        durationMs: 8,
      },
      {
        sessionKey: currentParentSessionKey,
        channelId: "openclaw",
      }
    );

    // Child call carries stale conversationId, but should still resolve to linked current parent scope.
    await toolCall(
      {
        toolName: "exec",
        params: { command: "pwd" },
      },
      {
        sessionKey: childSessionKey,
        conversationId: staleParentSessionKey,
        channelId: "openclaw",
        agentId: "coding",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 4);
    const childPayload = meaningfulCalls(calls)
      .map((call) => parseBody(call))
      .find((payload) => payload?.source?.sessionKey === childSessionKey && payload?.content === "Tool call: exec");

    assert.ok(childPayload, "expected child subagent action log");
    assert.equal(childPayload.topicId, "topic-scope-current-1");
    assert.equal(childPayload.taskId, "task-scope-current-1");
    assert.equal(childPayload.source.boardScopeTopicId, "topic-scope-current-1");
    assert.equal(childPayload.source.boardScopeTaskId, "task-scope-current-1");
    assert.equal(childPayload.source.boardScopeInherited, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("after_tool_call emits action log for result and error (ING-004)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("after_tool_call");
    assert.equal(typeof handler, "function");

    const ctx = {
      sessionKey: "channel:test-tools",
      channelId: "discord",
      agentId: "assistant",
    };

    await handler(
      {
        toolName: "web.search",
        result: { ok: true },
        durationMs: 15,
      },
      ctx
    );

    await handler(
      {
        toolName: "web.search",
        error: "upstream timeout",
      },
      ctx
    );

    await waitFor(() => meaningfulCalls(calls).length >= 2);
    const relevant = meaningfulCalls(calls);
    const resultPayload = parseBody(relevant[0]);
    const errorPayload = parseBody(relevant[1]);

    assert.equal(resultPayload.content, "Tool result: web.search");
    assert.equal(errorPayload.content, "Tool error: web.search");
    assert.equal(resultPayload.type, "action");
    assert.equal(errorPayload.type, "action");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("after_tool_call reuses before_tool_call scope when result event lacks session metadata", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const beforeHandler = api.__handlers.get("before_tool_call");
    const afterHandler = api.__handlers.get("after_tool_call");
    assert.equal(typeof beforeHandler, "function");
    assert.equal(typeof afterHandler, "function");

    const runId = "run-scope-fallback-1";
    const scopedCtx = {
      sessionKey: "agent:main:clawboard:task:topic-fallback-1:task-fallback-1",
      channelId: "openclaw",
      agentId: "main",
    };

    await beforeHandler(
      {
        toolName: "sessions_spawn",
        params: { agentId: "coding" },
        runId,
      },
      scopedCtx
    );

    // Simulate runtime/provider result event where session metadata is missing.
    await afterHandler(
      {
        toolName: "sessions_spawn",
        result: { status: "accepted", childSessionKey: "agent:coding:subagent:fallback-worker-1" },
        durationMs: 12,
        runId,
      },
      {
        channelId: "openclaw",
        agentId: "main",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 2);
    const relevant = meaningfulCalls(calls);
    const resultPayload = parseBody(relevant[1]);

    assert.equal(resultPayload.content, "Tool result: sessions_spawn");
    assert.equal(resultPayload.topicId, "topic-fallback-1");
    assert.equal(resultPayload.taskId, "task-fallback-1");
    assert.equal(resultPayload.source.sessionKey, scopedCtx.sessionKey);
    assert.equal(resultPayload.source.boardScopeTopicId, "topic-fallback-1");
    assert.equal(resultPayload.source.boardScopeTaskId, "task-fallback-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("after_tool_call reuses before scope via tool fingerprint when runId is absent", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const beforeHandler = api.__handlers.get("before_tool_call");
    const afterHandler = api.__handlers.get("after_tool_call");
    assert.equal(typeof beforeHandler, "function");
    assert.equal(typeof afterHandler, "function");

    const parentSessionKey = "agent:main:clawboard:task:topic-fp-fallback-1:task-fp-fallback-1";
    const childSessionKey = "agent:coding:subagent:fp-fallback-worker-1";

    await beforeHandler(
      {
        toolName: "sessions_spawn",
        params: { agentId: "coding" },
      },
      {
        sessionKey: parentSessionKey,
        channelId: "openclaw",
        agentId: "main",
      }
    );

    // Runtime path where after_tool_call can arrive without session + runId.
    await afterHandler(
      {
        toolName: "sessions_spawn",
        params: { agentId: "coding" },
        result: { status: "accepted", childSessionKey },
        durationMs: 9,
      },
      {
        channelId: "openclaw",
        agentId: "main",
      }
    );

    // Child subagent call should now inherit scope from the recovered spawn linkage.
    await beforeHandler(
      {
        toolName: "exec",
        params: { command: "pwd" },
      },
      {
        sessionKey: childSessionKey,
        channelId: "openclaw",
        agentId: "coding",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 3);
    const payloads = meaningfulCalls(calls).map((call) => parseBody(call));
    const spawnResult = payloads.find((payload) => payload?.content === "Tool result: sessions_spawn");
    const childCall = payloads.find(
      (payload) => payload?.source?.sessionKey === childSessionKey && payload?.content === "Tool call: exec"
    );

    assert.ok(spawnResult, "expected sessions_spawn result log");
    assert.equal(spawnResult.topicId, "topic-fp-fallback-1");
    assert.equal(spawnResult.taskId, "task-fp-fallback-1");
    assert.equal(spawnResult.source.sessionKey, parentSessionKey);

    assert.ok(childCall, "expected child subagent tool call log");
    assert.equal(childCall.topicId, "topic-fp-fallback-1");
    assert.equal(childCall.taskId, "task-fp-fallback-1");
    assert.equal(childCall.source.boardScopeTopicId, "topic-fp-fallback-1");
    assert.equal(childCall.source.boardScopeTaskId, "task-fp-fallback-1");
    assert.equal(childCall.source.boardScopeInherited, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before_tool_call skips unanchored OpenClaw control-plane tool calls", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const queuePath = path.join(
      os.tmpdir(),
      `clawboard-logger-unanchored-before-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
    );
    const api = makeApi({ queuePath });
    register(api);

    const handler = api.__handlers.get("before_tool_call");
    assert.equal(typeof handler, "function");

    await handler(
      {
        toolName: "sessions_list",
        params: {},
      },
      {
        channelId: "openclaw",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(meaningfulCalls(calls).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("after_tool_call skips unanchored OpenClaw control-plane tool results", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const queuePath = path.join(
      os.tmpdir(),
      `clawboard-logger-unanchored-after-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
    );
    const api = makeApi({ queuePath });
    register(api);

    const handler = api.__handlers.get("after_tool_call");
    assert.equal(typeof handler, "function");

    await handler(
      {
        toolName: "sessions_list",
        result: { sessions: [] },
        durationMs: 11,
      },
      {
        channelId: "openclaw",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(meaningfulCalls(calls).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent_end fallback captures assistant output when send hooks are absent (ING-005)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("agent_end");
    assert.equal(typeof handler, "function");

    await handler(
      {
        success: true,
        messages: [
          { role: "assistant", content: "Fallback assistant payload" },
        ],
      },
      {
        sessionKey: "channel:agent-end-test",
        channelId: "discord",
        agentId: "main",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const payload = parseBody(meaningfulCalls(calls)[0]);
    assert.equal(payload.type, "conversation");
    assert.equal(payload.agentId, "assistant");
    assert.equal(payload.content, "Fallback assistant payload");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent_end suppresses subagent scaffold user payloads", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("agent_end");
    assert.equal(typeof handler, "function");

    await handler(
      {
        success: true,
        messages: [
          { role: "user", content: "[Subagent Context] You are running as a subagent (depth 1/1)." },
          { role: "assistant", content: "Subagent finished with actionable result." },
        ],
      },
      {
        sessionKey: "agent:coding:subagent:test-agent-end",
        channelId: "direct",
        agentId: "coding",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const payloads = meaningfulCalls(calls).map((call) => parseBody(call)).filter((payload) => payload?.type === "conversation");
    assert.ok(payloads.some((payload) => payload.content === "Subagent finished with actionable result."));
    assert.equal(payloads.some((payload) => String(payload.content || "").startsWith("[Subagent Context]")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("board-session user message echo is skipped to avoid double logging (ING-006)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    await handler(
      {
        content: "already persisted by /api/openclaw/chat",
        metadata: {
          sessionKey: "clawboard:topic:topic-123",
          messageId: "board-msg-1",
        },
      },
      {
        channelId: "openclaw",
        sessionKey: "clawboard:topic:topic-123",
        conversationId: "channel:ignored",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(meaningfulCalls(calls).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("message_received suppresses heartbeat control-plane prompts for agent:main:main", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    await handler(
      {
        content: "Heartbeat: read context and validate in-flight subagents",
        metadata: {
          sessionKey: "agent:main:main",
          messageId: "hb-msg-1",
        },
      },
      {
        channelId: "imessage",
        sessionKey: "agent:main:main",
        conversationId: "agent:main:main",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(meaningfulCalls(calls).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("message_received suppresses subagent scaffold prompts", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    await handler(
      {
        content:
          "[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester.",
        metadata: {
          sessionKey: "agent:coding:subagent:test-subagent",
          messageId: "subagent-msg-1",
        },
      },
      {
        channelId: "direct",
        sessionKey: "agent:coding:subagent:test-subagent",
        conversationId: "agent:coding:subagent:test-subagent",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(meaningfulCalls(calls).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webchat occhat user echo is skipped to avoid duplicate board prompt rows", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    await handler(
      {
        content: "echoed board prompt",
        metadata: {
          sessionKey: "channel:webchat|thread:test-dup",
          messageId: "webchat-msg-dup",
          requestId: "occhat-test-dup-1",
        },
      },
      {
        channelId: "webchat",
        sessionKey: "channel:webchat|thread:test-dup",
        conversationId: "channel:webchat|thread:test-dup",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(meaningfulCalls(calls).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webchat occhat user echo is skipped when only messageId has occhat prefix", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    await handler(
      {
        content: "echoed board prompt missing explicit requestId",
        metadata: {
          sessionKey: "channel:webchat|thread:test-dup-occhat",
          messageId: "occhat-test-dup-2",
        },
      },
      {
        channelId: "webchat",
        sessionKey: "channel:webchat|thread:test-dup-occhat",
        conversationId: "channel:webchat|thread:test-dup-occhat",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(meaningfulCalls(calls).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ignored internal session prefixes do not write logs (ING-007)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    await handler(
      {
        content: "cron envelope",
        metadata: {
          sessionKey: "agent:main:cron:abc123",
          messageId: "cron-msg-1",
        },
      },
      {
        channelId: "cron",
        sessionKey: "agent:main:cron:abc123",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(meaningfulCalls(calls).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifier/control payload text is suppressed in logging hooks (ING-008)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    await handler(
      {
        content: '{"window":[],"candidateTopics":[],"candidateTasks":[],"summaries":[]}',
        metadata: {
          sessionKey: "channel:test-payload",
          messageId: "payload-1",
        },
      },
      {
        channelId: "discord",
        conversationId: "channel:test-payload",
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(meaningfulCalls(calls).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("injected context blocks are stripped before persistence (ING-009)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    const content = [
      "[CLAWBOARD_CONTEXT_BEGIN]",
      "sensitive retrieval block",
      "[CLAWBOARD_CONTEXT_END]",
      "actual user message",
    ].join("\n");

    await handler(
      {
        content,
        metadata: {
          sessionKey: "channel:test-context-strip",
          messageId: "ctx-1",
        },
      },
      {
        channelId: "discord",
        conversationId: "channel:test-context-strip",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const payload = parseBody(meaningfulCalls(calls)[0]);
    assert.equal(payload.content, "actual user message");
    assert.ok(!String(payload.raw || "").includes("sensitive retrieval block"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("untrusted metadata wrappers are stripped before persistence", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { fn, calls } = createFetchMock([]);
    globalThis.fetch = fn;

    const api = makeApi();
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    const content = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"occhat-test-wrapper","sender":"gateway-client"}',
      "```",
      "",
      "actual user content",
    ].join("\n");

    await handler(
      {
        content,
        metadata: {
          sessionKey: "channel:test-wrapper-strip",
          messageId: "wrapper-1",
        },
      },
      {
        channelId: "discord",
        conversationId: "channel:test-wrapper-strip",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 1);
    const payload = parseBody(meaningfulCalls(calls)[0]);
    assert.equal(payload.content, "actual user content");
    assert.ok(!String(payload.content || "").includes("Conversation info (untrusted metadata)"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("send failures spill to durable queue and replay keeps idempotency key (ING-010, ING-011)", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  try {
    const queuePath = path.join(os.tmpdir(), `clawboard-logger-queue-${process.pid}-${Date.now()}.sqlite`);
    const calls = [];
    let failedQueueMsg1 = false;
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const key = String(options?.headers?.["X-Idempotency-Key"] || "");
      if (!failedQueueMsg1 && key.includes("queue-msg-1")) {
        failedQueueMsg1 = true;
        throw new Error("simulated transport outage");
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return "{}";
        },
      };
    };

    const api = makeApi({ queuePath });
    register(api);

    const handler = api.__handlers.get("message_received");
    assert.equal(typeof handler, "function");

    let now = 0;
    Date.now = () => {
      now += 1e4;
      return now;
    };

    await handler(
      {
        content: "first message should queue",
        metadata: {
          sessionKey: "channel:test-queue",
          messageId: "queue-msg-1",
        },
      },
      {
        channelId: "discord",
        conversationId: "channel:test-queue",
      }
    );

    Date.now = originalDateNow;

    await handler(
      {
        content: "second message triggers flush",
        metadata: {
          sessionKey: "channel:test-queue",
          messageId: "queue-msg-2",
        },
      },
      {
        channelId: "discord",
        conversationId: "channel:test-queue",
      }
    );

    await waitFor(() => meaningfulCalls(calls).length >= 3, 5000);

    const relevant = meaningfulCalls(calls);
    const firstHeader = String(relevant[0].options?.headers?.["X-Idempotency-Key"] || "");
    const replayCall = relevant.find((call, idx) => idx >= 2 && String(call.options?.headers?.["X-Idempotency-Key"] || "") === firstHeader);

    assert.ok(firstHeader.includes("queue-msg-1"));
    assert.ok(replayCall, "expected queued payload replay to reuse original idempotency key");
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});
