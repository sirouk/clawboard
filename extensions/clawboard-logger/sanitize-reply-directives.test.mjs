import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeMessageContent } from "./index.js";

test("sanitizeMessageContent strips reply directive tags", () => {
  const raw = "[[reply_to_current]] test [[ reply_to: abc-123 ]] done";
  assert.equal(sanitizeMessageContent(raw), "test done");
});

test("sanitizeMessageContent strips single-bracket reply directive tags", () => {
  const raw = "[reply_to_current] test [ reply_to: abc-123 ] done";
  assert.equal(sanitizeMessageContent(raw), "test done");
});

test("sanitizeMessageContent keeps non-directive bracket content", () => {
  const raw = "[[not_a_directive]] keep me";
  assert.equal(sanitizeMessageContent(raw), "[[not_a_directive]] keep me");
});
