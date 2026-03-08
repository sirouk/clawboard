import test from "node:test";
import assert from "node:assert/strict";

// Test what we can with the currently exported functions
test("index module can be imported", async () => {
  const indexModule = await import("./index.js");
  assert.ok(indexModule);
  assert.ok(typeof indexModule.default === "function");
});

test("resolveBoardTaskPatchId falls back to the current board task id for loose task matches", async () => {
  const { resolveBoardTaskPatchId } = await import("./index.js");
  assert.equal(
    resolveBoardTaskPatchId("followup-1772933621", "clawboard:task:topic-followup-1772933621:task-followup-1772933621"),
    "task-followup-1772933621"
  );
});

test("resolveBoardTaskPatchId preserves explicit non-matching task ids", async () => {
  const { resolveBoardTaskPatchId } = await import("./index.js");
  assert.equal(
    resolveBoardTaskPatchId("task-some-other-work", "clawboard:task:topic-followup-1772933621:task-followup-1772933621"),
    "task-some-other-work"
  );
});

test("resolveBoardTaskPatchId falls back to the current board task id when the model sends a task title", async () => {
  const { resolveBoardTaskPatchId } = await import("./index.js");
  assert.equal(
    resolveBoardTaskPatchId(
      "latency-check-1772934937",
      "clawboard:task:topic-0e23dc33-e9b1-4105-a3e6-be5e9e502b98:task-b1f29fe2-72d1-4c04-8ec3-733bdb144a66"
    ),
    "task-b1f29fe2-72d1-4c04-8ec3-733bdb144a66"
  );
});

test("agent_end fallback still logs the final board assistant reply after an earlier outbound message", async () => {
  const posted = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url ?? "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    posted.push({ url, body });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const handlers = new Map();
    const plugin = (await import("./index.js")).default;
    plugin({
      pluginConfig: {
        baseUrl: "http://clawboard.local",
        token: "test-token",
      },
      logger: {
        warn() {},
        info() {},
        debug() {},
        error() {},
      },
      on(name, handler) {
        handlers.set(name, handler);
      },
    });

    const messageSending = handlers.get("message_sending");
    const agentEnd = handlers.get("agent_end");
    assert.equal(typeof messageSending, "function");
    assert.equal(typeof agentEnd, "function");

    const ctx = {
      agentId: "main",
      sessionKey: "clawboard:task:topic-123:task-456",
      channelId: "webchat",
    };

    await messageSending(
      {
        content: "Dispatched to coding specialist. I will relay the result shortly.",
        sessionKey: ctx.sessionKey,
      },
      ctx
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    await agentEnd(
      {
        success: true,
        messages: [
          { role: "assistant", content: "Dispatched to coding specialist. I will relay the result shortly." },
          { role: "assistant", content: "LATENCY_OK" },
        ],
      },
      ctx
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    const conversationBodies = posted
      .map((entry) => entry.body)
      .filter((body) => body && body.type === "conversation")
      .map((body) => ({ content: body.content, topicId: body.topicId, taskId: body.taskId }));

    assert.deepEqual(conversationBodies, [
      {
        content: "Dispatched to coding specialist. I will relay the result shortly.",
        topicId: "topic-123",
        taskId: "task-456",
      },
      {
        content: "LATENCY_OK",
        topicId: "topic-123",
        taskId: "task-456",
      },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});
