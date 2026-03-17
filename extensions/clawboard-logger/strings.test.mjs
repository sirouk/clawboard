import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  buildBaseUrlCandidates,
  clip,
  dedupeFingerprint,
  ensureDir,
  envBool,
  envInt,
  extractTextLoose,
  isClassifierPayloadText,
  isHeartbeatControlPlaneText,
  isRetryableFetchError,
  latestUserInput,
  lexicalSimilarity,
  normalizeBaseUrlCandidate,
  normalizeChannelId,
  normalizeWhitespace,
  parseBaseUrlList,
  parseContextModes,
  parseHookNameList,
  redact,
  sanitizeRetrievedContextBlock,
  shouldSuppressNonSemanticConversation,
  shouldSuppressReplyDirectivesForSession,
  stripClawBoardWrapperArtifacts,
  summarize,
  tokenSet,
  truncateRaw,
} from "./strings.js";

test("envInt clamps parsed values and falls back for invalid input", () => {
  process.env.CLAWBOARD_TEST_INT = "42";
  assert.equal(envInt("CLAWBOARD_TEST_INT", 8, 1, 50), 42);

  process.env.CLAWBOARD_TEST_INT = "500";
  assert.equal(envInt("CLAWBOARD_TEST_INT", 8, 1, 50), 50);

  process.env.CLAWBOARD_TEST_INT = "wat";
  assert.equal(envInt("CLAWBOARD_TEST_INT", 8, 1, 50), 8);

  delete process.env.CLAWBOARD_TEST_INT;
});

test("envBool recognizes truthy, falsy, and fallback values", () => {
  process.env.CLAWBOARD_TEST_BOOL = "yes";
  assert.equal(envBool("CLAWBOARD_TEST_BOOL", false), true);

  process.env.CLAWBOARD_TEST_BOOL = "off";
  assert.equal(envBool("CLAWBOARD_TEST_BOOL", true), false);

  process.env.CLAWBOARD_TEST_BOOL = "maybe";
  assert.equal(envBool("CLAWBOARD_TEST_BOOL", true), true);

  delete process.env.CLAWBOARD_TEST_BOOL;
});

test("parseContextModes and parseHookNameList normalize and dedupe", () => {
  assert.deepEqual(parseContextModes("Auto, full, auto, invalid", ["cheap"]), ["auto", "full"]);
  assert.deepEqual(parseContextModes("  ", ["cheap"]), ["cheap"]);

  assert.deepEqual(parseHookNameList("message_received, MESSAGE_RECEIVED, invalid-hook, agent_end"), [
    "message_received",
    "agent_end",
  ]);
});

test("base URL helpers normalize, dedupe, and add loopback fallbacks", () => {
  assert.equal(normalizeBaseUrlCandidate("https://clawboard.local/path/?q=1#frag"), "https://clawboard.local/path");
  assert.equal(normalizeBaseUrlCandidate("ftp://clawboard.local"), "");

  assert.deepEqual(parseBaseUrlList("https://a.local/, https://a.local, http://b.local/app"), [
    "https://a.local",
    "http://b.local/app",
  ]);

  assert.deepEqual(buildBaseUrlCandidates("https://clawboard.local/app", ["https://clawboard.local/app"]), [
    "https://clawboard.local/app",
    "https://127.0.0.1/app",
    "https://localhost/app",
  ]);
});

test("isRetryableFetchError recognizes common fetch failure shapes", () => {
  const retryable = new Error("fetch failed");
  retryable.cause = { code: "ECONNREFUSED" };
  assert.equal(isRetryableFetchError(retryable), true);
  assert.equal(isRetryableFetchError(new Error("socket ETIMEDOUT while connecting")), true);
  assert.equal(isRetryableFetchError(new Error("validation failed")), false);
  assert.equal(isRetryableFetchError("nope"), false);
});

test("wrapper sanitizers strip board artifacts but keep meaningful text", () => {
  const raw =
    "[CLAWBOARD_CONTEXT_BEGIN]\nKeep this\n[[reply_to_current]]\nConversation info (untrusted metadata): {\"x\":1}\n[CLAWBOARD_CONTEXT_END]";
  assert.equal(stripClawBoardWrapperArtifacts(raw).trim(), "Keep this");
  assert.equal(sanitizeRetrievedContextBlock(`${raw}\n\n\nSecond line`), "Keep this\n Second line");
  assert.equal(shouldSuppressReplyDirectivesForSession("clawboard:topic:topic-123"), true);
  assert.equal(shouldSuppressReplyDirectivesForSession("channel:discord"), false);
});

test("text summarizers and token helpers normalize noisy content", () => {
  assert.equal(summarize("Summary:   Hello   there"), "Hello there");
  assert.equal(dedupeFingerprint(" Hello   There "), dedupeFingerprint("hello there"));
  assert.equal(truncateRaw("x".repeat(6000)).endsWith("…"), true);
  assert.equal(clip("alpha beta gamma", 10), "alpha bet…");
  assert.equal(normalizeWhitespace("alpha\n beta\tgamma"), "alpha beta gamma");
  assert.deepEqual([...tokenSet("Fix the login callback and login copy")], ["fix", "login", "callback", "copy"]);
  assert.ok(lexicalSimilarity("login callback fix", "fix login callback") > 0.9);
});

test("text extraction helpers prefer the latest user message and trim classifier payload noise", () => {
  assert.equal(
    extractTextLoose({
      content: [{ text: "alpha" }, { value: "beta" }],
      ignored: "gamma",
    }),
    "alpha\nbeta",
  );

  assert.equal(
    latestUserInput("fallback", [
      { role: "assistant", content: "ignore me" },
      { role: "user", content: [{ text: "Please ship the fix" }] },
    ]),
    "Please ship the fix",
  );

  assert.equal(
    isClassifierPayloadText('{"createTopic":false,"topicId":"topic-1","createTask":false,"taskId":null}'),
    true,
  );
  assert.equal(isClassifierPayloadText("plain user text"), false);
});

test("control-plane helpers only suppress the intended conversation classes", () => {
  assert.equal(
    isHeartbeatControlPlaneText("heartbeat: watchdog check", {
      sessionKey: "agent:main:main",
      channelId: "openclaw",
    }),
    true,
  );
  assert.equal(
    shouldSuppressNonSemanticConversation("[subagent context] delegated work", {
      sessionKey: "agent:main:subagent:123",
    }),
    true,
  );
  assert.equal(
    shouldSuppressNonSemanticConversation("Real user question", {
      sessionKey: "channel:discord",
      channelId: "discord",
    }),
    false,
  );
  assert.equal(normalizeChannelId("  Discord "), "discord");
});

test("redact and ensureDir protect secrets and create parent directories", async () => {
  assert.deepEqual(redact({ apiToken: "secret", nested: [{ password: "hidden" }, { safe: "ok" }] }), {
    apiToken: "[redacted]",
    nested: [{ password: "[redacted]" }, { safe: "ok" }],
  });

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawboard-logger-"));
  const filePath = path.join(tempRoot, "nested", "file.json");
  await ensureDir(filePath);
  const stat = await fs.stat(path.dirname(filePath));
  assert.equal(stat.isDirectory(), true);
});
