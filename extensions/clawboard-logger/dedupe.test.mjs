import test from "node:test";
import assert from "node:assert/strict";

import { createDedupeState, outgoingMessageIdDedupeKey } from "./dedupe.js";

function sanitize(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

test("outgoingMessageIdDedupeKey requires a message id", () => {
  assert.equal(outgoingMessageIdDedupeKey("discord", "channel:abc", undefined), "");
  assert.equal(outgoingMessageIdDedupeKey("discord", "channel:abc", "msg-1"), "sending:discord:channel:abc:msg-1");
});

test("dedupe state remembers recent outgoing board content by base session", () => {
  let now = 1_000;
  const dedupe = createDedupeState({
    sanitizeMessageContent: sanitize,
    lexicalSimilarity: (a, b) => (a === b ? 1 : 0),
    dedupeFingerprint: sanitize,
    nowMs: () => now,
  });

  dedupe.rememberOutgoingSession("clawboard:topic:topic-1|wrapped", "Hello there");
  assert.equal(dedupe.looksLikeRecentBoardAssistantEcho("clawboard:topic:topic-1", "  hello   there "), true);

  now += 6 * 60_000;
  assert.equal(dedupe.looksLikeRecentBoardAssistantEcho("clawboard:topic:topic-1", "hello there"), false);
});
