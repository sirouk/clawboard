import test from "node:test";
import assert from "node:assert/strict";

// Test what we can with the currently exported functions
test("index module can be imported", async () => {
  const indexModule = await import("./index.js");
  assert.ok(indexModule);
  assert.ok(typeof indexModule.default === "function");
});

// Note: Most utility functions in index.ts are not exported, so we can't test them directly
// This is a known limitation that we should address by exporting the utility functions
