import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_IGNORE_SESSION_PREFIXES,
  parseIgnoreSessionPrefixes,
  shouldIgnoreSessionKey,
} from "./ignore-session.js";

test("parseIgnoreSessionPrefixes falls back to default when unset", () => {
  assert.deepEqual(parseIgnoreSessionPrefixes(undefined), [...DEFAULT_IGNORE_SESSION_PREFIXES]);
  assert.deepEqual(parseIgnoreSessionPrefixes(""), [...DEFAULT_IGNORE_SESSION_PREFIXES]);
  assert.deepEqual(parseIgnoreSessionPrefixes("   "), [...DEFAULT_IGNORE_SESSION_PREFIXES]);
});

test("parseIgnoreSessionPrefixes normalizes comma-separated values", () => {
  assert.deepEqual(parseIgnoreSessionPrefixes(" internal:clawboard-classifier: , Foo "), [
    "internal:clawboard-classifier:",
    "foo",
  ]);
});

test("shouldIgnoreSessionKey ignores classifier internal sessions by default", () => {
  assert.equal(shouldIgnoreSessionKey("internal:clawboard-classifier:classifier:123"), true);
  assert.equal(shouldIgnoreSessionKey("agent:main:internal:clawboard-classifier:classifier:123"), true);
  assert.equal(shouldIgnoreSessionKey("AGENT:MAIN:INTERNAL:CLAWBOARD-CLASSIFIER:CLASSIFIER:123"), true);
  assert.equal(shouldIgnoreSessionKey("agent:main:cron:7a06627e-5fac-45af-9765-14d1f6e19708"), true);
});

test("shouldIgnoreSessionKey supports custom prefixes", () => {
  assert.equal(shouldIgnoreSessionKey("internal:foo:bar", ["internal:foo:"]), true);
  assert.equal(shouldIgnoreSessionKey("agent:main:internal:foo:bar", ["internal:foo:"]), true);
  assert.equal(shouldIgnoreSessionKey("internal:foo:bar", ["internal:bar:"]), false);
});

// Additional tests for edge cases
test("parseIgnoreSessionPrefixes handles null and whitespace-only inputs", () => {
  assert.deepEqual(parseIgnoreSessionPrefixes(null), [...DEFAULT_IGNORE_SESSION_PREFIXES]);
  assert.deepEqual(parseIgnoreSessionPrefixes(" "), [...DEFAULT_IGNORE_SESSION_PREFIXES]);
  assert.deepEqual(parseIgnoreSessionPrefixes("\t\n"), [...DEFAULT_IGNORE_SESSION_PREFIXES]);
});

test("shouldIgnoreSessionKey handles empty and null inputs", () => {
  assert.equal(shouldIgnoreSessionKey(null), false);
  assert.equal(shouldIgnoreSessionKey(undefined), false);
  assert.equal(shouldIgnoreSessionKey(""), false);
  assert.equal(shouldIgnoreSessionKey("   "), false);
});

test("shouldIgnoreSessionKey handles empty prefix list", () => {
  assert.equal(shouldIgnoreSessionKey("internal:clawboard-classifier:test", []), false);
  assert.equal(shouldIgnoreSessionKey("any:key", []), false);
});

test("shouldIgnoreSessionKey handles malformed prefixes", () => {
  assert.equal(shouldIgnoreSessionKey("test:key", [""]), false);
  assert.equal(shouldIgnoreSessionKey("test:key", [null]), false);
  assert.equal(shouldIgnoreSessionKey("test:key", [undefined]), false);
});
