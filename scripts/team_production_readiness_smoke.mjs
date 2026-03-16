#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const cwd = process.cwd();
const envFile = process.env.CLAWBOARD_ENV_FILE || path.join(cwd, ".env");
const defaultApiBase = "http://localhost:8010";
const defaultWebBase = "http://localhost:3010";

const slo = {
  warmUnifiedLoadMs: 3000,
  sameOriginResolveMs: 2000,
  sameOriginChatQueueMs: 1000,
  canonicalThreadReadMs: 1500,
  directBackendChatQueueMs: 1000,
};
const fetchTimeoutMs = 20_000;

function readEnvValue(key) {
  if (!fs.existsSync(envFile)) return "";
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith(`${key}=`)) continue;
    let value = trimmed.slice(key.length + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }
  return "";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function authHeaders(token, extra = {}) {
  const headers = { ...extra };
  if (token) headers["X-Clawboard-Token"] = token;
  return headers;
}

async function timedFetch(name, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${fetchTimeoutMs}ms`)), fetchTimeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const elapsedMs = Math.round(performance.now() - started);
    return { name, url, response, elapsedMs, error: null };
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - started);
    return { name, url, response: null, elapsedMs, error };
  } finally {
    clearTimeout(timeout);
  }
}

async function jsonBody(response) {
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function pushResult(results, entry) {
  results.push(entry);
}

function printResults(results) {
  const labelWidth = Math.max(...results.map((entry) => entry.name.length), 10);
  for (const entry of results) {
    const status = entry.ok ? "PASS" : entry.skipped ? "SKIP" : "FAIL";
    const latency = Number.isFinite(entry.elapsedMs) ? `${String(entry.elapsedMs).padStart(4, " ")}ms` : "   n/a";
    const detail = entry.detail ? ` ${entry.detail}` : "";
    console.log(`${status}  ${entry.name.padEnd(labelWidth, " ")}  ${latency}${detail}`);
  }
}

async function main() {
  const apiBase = firstNonEmpty(process.env.PLAYWRIGHT_API_BASE, process.env.CLAWBOARD_PUBLIC_API_BASE, readEnvValue("CLAWBOARD_PUBLIC_API_BASE"), defaultApiBase);
  const webBase = firstNonEmpty(process.env.PLAYWRIGHT_BASE_URL, process.env.CLAWBOARD_PUBLIC_WEB_URL, readEnvValue("CLAWBOARD_PUBLIC_WEB_URL"), defaultWebBase);
  const token = firstNonEmpty(process.env.PLAYWRIGHT_CLAWBOARD_TOKEN, process.env.CLAWBOARD_TOKEN, readEnvValue("CLAWBOARD_TOKEN"));
  const suffix = `${Date.now()}`;
  const topicSeedMessage = `team-production-readiness-${suffix}`;
  const sameOriginFollowUp = `same-origin-follow-up-${suffix}`;
  const directBackendMessage = `direct-backend-${suffix}`;
  const results = [];

  console.log(`Using apiBase=${apiBase}`);
  console.log(`Using webBase=${webBase}`);
  console.log(`Using token=${token ? "present" : "missing"}`);

  const health = await timedFetch("direct_api_health", `${apiBase}/api/health`, {
    headers: authHeaders(token),
  });
  pushResult(results, {
    name: health.name,
    elapsedMs: health.elapsedMs,
    ok: Boolean(health.response?.ok),
    detail: health.response?.ok ? "" : health.error ? `error=${String(health.error)}` : `status=${health.response?.status}`,
  });
  if (!health.response?.ok) {
    printResults(results);
    process.exitCode = 1;
    return;
  }

  const unifiedLoad = await timedFetch("warm_unified_view", `${webBase}/u`, {
    headers: authHeaders(token),
  });
  pushResult(results, {
    name: unifiedLoad.name,
    elapsedMs: unifiedLoad.elapsedMs,
    ok: Boolean(unifiedLoad.response?.ok) && unifiedLoad.elapsedMs <= slo.warmUnifiedLoadMs,
    detail: unifiedLoad.response?.ok
      ? `(slo<=${slo.warmUnifiedLoadMs}ms)`
      : unifiedLoad.error
        ? `error=${String(unifiedLoad.error)}`
        : `status=${unifiedLoad.response?.status}`,
  });

  const resolve = await timedFetch("same_origin_resolve", `${webBase}/api/openclaw/resolve-board-send`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      message: topicSeedMessage,
      forceNewTopic: true,
    }),
  });
  const resolvePayload = await jsonBody(resolve.response);
  const topicId = String(resolvePayload?.topicId || "").trim();
  const sessionKey = String(resolvePayload?.sessionKey || "").trim();
  pushResult(results, {
    name: resolve.name,
    elapsedMs: resolve.elapsedMs,
    ok: Boolean(resolve.response?.ok) && resolve.elapsedMs <= slo.sameOriginResolveMs && Boolean(topicId) && Boolean(sessionKey),
    detail: resolve.response?.ok
      ? `(topic=${topicId || "missing"}, slo<=${slo.sameOriginResolveMs}ms)`
      : resolve.error
        ? `error=${String(resolve.error)}`
        : `status=${resolve.response?.status}`,
  });
  if (!resolve.response?.ok || !topicId || !sessionKey) {
    printResults(results);
    process.exitCode = 1;
    return;
  }

  const sameOriginChat = await timedFetch("same_origin_chat_queue", `${webBase}/api/openclaw/chat`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      sessionKey,
      message: topicSeedMessage,
    }),
  });
  const sameOriginChatPayload = await jsonBody(sameOriginChat.response);
  pushResult(results, {
    name: sameOriginChat.name,
    elapsedMs: sameOriginChat.elapsedMs,
    ok: Boolean(sameOriginChat.response?.ok) && sameOriginChat.elapsedMs <= slo.sameOriginChatQueueMs && sameOriginChatPayload?.queued === true,
    detail: sameOriginChat.response?.ok
      ? `(queued=${String(Boolean(sameOriginChatPayload?.queued))}, slo<=${slo.sameOriginChatQueueMs}ms)`
      : sameOriginChat.error
        ? `error=${String(sameOriginChat.error)}`
        : `status=${sameOriginChat.response?.status}`,
  });

  const followUp = await timedFetch("same_origin_follow_up", `${webBase}/api/openclaw/chat`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      sessionKey,
      message: sameOriginFollowUp,
    }),
  });
  const followUpPayload = await jsonBody(followUp.response);
  pushResult(results, {
    name: followUp.name,
    elapsedMs: followUp.elapsedMs,
    ok: Boolean(followUp.response?.ok) && followUpPayload?.queued === true,
    detail: followUp.response?.ok
      ? `(queued=${String(Boolean(followUpPayload?.queued))})`
      : followUp.error
        ? `error=${String(followUp.error)}`
        : `status=${followUp.response?.status}`,
  });

  const directChat = await timedFetch("direct_backend_chat_queue", `${apiBase}/api/openclaw/chat`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      sessionKey,
      message: directBackendMessage,
    }),
  });
  const directChatPayload = await jsonBody(directChat.response);
  pushResult(results, {
    name: directChat.name,
    elapsedMs: directChat.elapsedMs,
    ok: Boolean(directChat.response?.ok) && directChat.elapsedMs <= slo.directBackendChatQueueMs && directChatPayload?.queued === true,
    detail: directChat.response?.ok
      ? `(queued=${String(Boolean(directChatPayload?.queued))}, slo<=${slo.directBackendChatQueueMs}ms)`
      : directChat.error
        ? `error=${String(directChat.error)}`
        : `status=${directChat.response?.status}`,
  });

  const thread = await timedFetch("same_origin_topic_thread", `${webBase}/api/topics/${encodeURIComponent(topicId)}/thread?limit=20`, {
    headers: authHeaders(token),
  });
  const threadPayload = await jsonBody(thread.response);
  const logs = Array.isArray(threadPayload?.logs) ? threadPayload.logs : [];
  const logBodies = logs.map((entry) => String(entry?.content || entry?.summary || "").trim());
  const continuityOk =
    logBodies.some((body) => body === topicSeedMessage) &&
    logBodies.some((body) => body === sameOriginFollowUp) &&
    logBodies.some((body) => body === directBackendMessage);
  pushResult(results, {
    name: thread.name,
    elapsedMs: thread.elapsedMs,
    ok:
      Boolean(thread.response?.ok) &&
      thread.elapsedMs <= slo.canonicalThreadReadMs &&
      threadPayload?.topicId === topicId &&
      threadPayload?.timelineScope === "topic_thread" &&
      continuityOk,
    detail: thread.response?.ok
      ? `(logs=${logs.length}, continuity=${String(continuityOk)}, slo<=${slo.canonicalThreadReadMs}ms)`
      : thread.error
        ? `error=${String(thread.error)}`
        : `status=${thread.response?.status}`,
  });

  printResults(results);

  const failed = results.filter((entry) => !entry.ok && !entry.skipped);
  if (failed.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log("All readiness smoke checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
