import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function listRouteFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listRouteFiles(next)));
      continue;
    }
    if (entry.isFile() && entry.name === "route.ts") {
      out.push(next);
    }
  }
  return out;
}

test("next api route surface does not import Prisma-backed lib/db handlers", async () => {
  const root = process.cwd();
  const routes = await listRouteFiles(path.join(root, "src", "app", "api"));

  for (const routeFile of routes) {
    const text = await readFile(routeFile, "utf8");
    assert.doesNotMatch(
      text,
      /from\s+["'][^"']*lib\/db["']/,
      `legacy Prisma import found in ${path.relative(root, routeFile)}`,
    );
  }
});

test("canonical overlapping routes are explicit FastAPI proxy shims", async () => {
  const root = process.cwd();
  const expectedProxyRoutes = [
    "src/app/api/topics/route.ts",
    "src/app/api/topics/[id]/route.ts",
    "src/app/api/topics/[id]/thread/route.ts",
    "src/app/api/log/route.ts",
    "src/app/api/openclaw/chat/route.ts",
    "src/app/api/openclaw/resolve-board-send/route.ts",
  ];

  for (const rel of expectedProxyRoutes) {
    const text = await readFile(path.join(root, rel), "utf8");
    assert.match(text, /proxyApiRequest\(/, `${rel} must proxy to FastAPI`);
    assert.match(text, /legacyRouteId:/, `${rel} must emit legacy-route telemetry`);
  }
});

test("legacy-only next api routes are explicitly blocked", async () => {
  const root = process.cwd();
  const expectedBlockedRoutes = [
    "src/app/api/topics/ensure/route.ts",
    "src/app/api/events/route.ts",
    "src/app/api/events/append/route.ts",
    "src/app/api/events/upsert/route.ts",
    "src/app/api/import/start/route.ts",
    "src/app/api/import/status/route.ts",
  ];

  for (const rel of expectedBlockedRoutes) {
    const text = await readFile(path.join(root, rel), "utf8");
    assert.match(text, /blockLegacyApiRoute\(/, `${rel} must stay deprecated and blocked`);
  }
});

test("server proxy helper emits ownership telemetry headers and warnings", async () => {
  const root = process.cwd();
  const helperPath = path.join(root, "src", "lib", "server-api-proxy.ts");
  const text = await readFile(helperPath, "utf8");

  assert.match(text, /x-clawboard-api-owner/, "expected ownership header tagging");
  assert.match(text, /Legacy Next API route/, "expected legacy route warning telemetry");
  assert.match(text, /CLAWBOARD_SERVER_API_TOKEN|CLAWBOARD_TOKEN/, "expected server-side proxy token fallback");
});
