import test from "node:test";
import assert from "node:assert/strict";

import { computeEffectiveSessionKey, parseBoardSessionKey } from "./session-key.js";

test("computeEffectiveSessionKey prefers conversationId over channelId", () => {
  const meta = { messageId: "m1" };
  const ctx = { channelId: "discord", conversationId: "channel:discord-123" };
  assert.equal(computeEffectiveSessionKey(meta, ctx), "channel:discord-123");
});

test("computeEffectiveSessionKey falls back to channel bucket when no conversation id", () => {
  const meta = {};
  const ctx = { channelId: "discord" };
  assert.equal(computeEffectiveSessionKey(meta, ctx), "channel:discord");
});

test("computeEffectiveSessionKey appends thread id to avoid collisions", () => {
  const meta = { threadId: "999" };
  const ctx = { channelId: "discord", conversationId: "channel:discord-123" };
  assert.equal(computeEffectiveSessionKey(meta, ctx), "channel:discord-123|thread:999");
});

test("computeEffectiveSessionKey does not duplicate thread id if already present", () => {
  const meta = { threadId: "999" };
  const ctx = { channelId: "discord", conversationId: "channel:discord-123|thread:999" };
  assert.equal(computeEffectiveSessionKey(meta, ctx), "channel:discord-123|thread:999");
});

test("computeEffectiveSessionKey prefers board sessionKey over conversationId", () => {
  const meta = {};
  const ctx = {
    channelId: "discord",
    conversationId: "channel:discord-123",
    sessionKey: "clawboard:topic:topic-123",
  };
  assert.equal(computeEffectiveSessionKey(meta, ctx), "clawboard:topic:topic-123");
});

test("computeEffectiveSessionKey prefers wrapped board sessionKey over conversationId", () => {
  const meta = {};
  const ctx = {
    channelId: "discord",
    conversationId: "channel:discord-123",
    sessionKey: "agent:main:clawboard:topic:topic-123",
  };
  assert.equal(computeEffectiveSessionKey(meta, ctx), "agent:main:clawboard:topic:topic-123");
});

test("computeEffectiveSessionKey does not append thread suffix to board sessionKey", () => {
  const meta = { threadId: "999" };
  const ctx = { sessionKey: "clawboard:task:topic-123:task-456" };
  assert.equal(computeEffectiveSessionKey(meta, ctx), "clawboard:task:topic-123:task-456");
});

test("parseBoardSessionKey parses topic scope", () => {
  assert.deepEqual(parseBoardSessionKey("clawboard:topic:topic-123"), { kind: "topic", topicId: "topic-123" });
});

test("parseBoardSessionKey parses wrapped topic scope", () => {
  assert.deepEqual(parseBoardSessionKey("agent:main:clawboard:topic:topic-123"), { kind: "topic", topicId: "topic-123" });
});

test("parseBoardSessionKey parses task scope", () => {
  assert.deepEqual(parseBoardSessionKey("clawboard:task:topic-123:task-456"), {
    kind: "task",
    topicId: "topic-123",
    taskId: "task-456",
  });
});

test("parseBoardSessionKey parses wrapped task scope", () => {
  assert.deepEqual(parseBoardSessionKey("agent:main:clawboard:task:topic-123:task-456"), {
    kind: "task",
    topicId: "topic-123",
    taskId: "task-456",
  });
});

test("parseBoardSessionKey ignores thread suffix", () => {
  assert.deepEqual(parseBoardSessionKey("clawboard:topic:topic-123|thread:999"), { kind: "topic", topicId: "topic-123" });
});

test("parseBoardSessionKey rejects malformed values", () => {
  assert.equal(parseBoardSessionKey(""), null);
  assert.equal(parseBoardSessionKey("clawboard:topic:"), null);
  assert.equal(parseBoardSessionKey("clawboard:topic:foo"), null);
  assert.equal(parseBoardSessionKey("clawboard:task:topic-1"), null);
  assert.equal(parseBoardSessionKey("clawboard:task:topic-1:bar"), null);
  assert.equal(parseBoardSessionKey("channel:discord"), null);
});

// Additional tests for edge cases
test("computeEffectiveSessionKey handles empty inputs gracefully", () => {
  assert.equal(computeEffectiveSessionKey({}, {}), undefined);
  assert.equal(computeEffectiveSessionKey(undefined, {}), undefined);
  assert.equal(computeEffectiveSessionKey({}, { channelId: "" }), undefined);
});

test("computeEffectiveSessionKey handles channel fallback correctly", () => {
  const meta = {};
  const ctx = { channelId: "discord" };
  assert.equal(computeEffectiveSessionKey(meta, ctx), "channel:discord");
  
  // Test with empty conversationId
  const ctx2 = { channelId: "discord", conversationId: "" };
  assert.equal(computeEffectiveSessionKey(meta, ctx2), "channel:discord");
});

test("computeEffectiveSessionKey handles threadId edge cases", () => {
  const meta = { threadId: "thread-123" };
  const ctx = { sessionKey: "clawboard:topic:topic-123|thread:thread-123" };
  assert.equal(computeEffectiveSessionKey(meta, ctx), "clawboard:topic:topic-123|thread:thread-123");
});
