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
