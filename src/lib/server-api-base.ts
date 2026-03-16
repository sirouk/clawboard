import fs from "node:fs";

const DOCKER_ONLY_API_HOSTS = new Set(["api"]);

export function normalizeApiBase(raw: string) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function runningInsideContainer() {
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

function resolveHostApiFallbackBase() {
  return normalizeApiBase(
    process.env.CLAWBOARD_SERVER_API_BASE_HOST_FALLBACK ||
      process.env.CLAWBOARD_LOCAL_API_BASE ||
      "http://127.0.0.1:8010"
  );
}

function rewriteDockerOnlyApiBase(rawBase: string) {
  const normalized = normalizeApiBase(rawBase);
  if (!normalized || runningInsideContainer()) return normalized;

  try {
    const upstream = new URL(normalized);
    if (!DOCKER_ONLY_API_HOSTS.has(upstream.hostname.toLowerCase())) return normalized;

    const fallback = new URL(resolveHostApiFallbackBase());
    if (!fallback.pathname || fallback.pathname === "/") {
      fallback.pathname = upstream.pathname;
    }
    return normalizeApiBase(fallback.toString());
  } catch {
    return normalized;
  }
}

export function resolveServerApiBase() {
  const configured = normalizeApiBase(
    process.env.CLAWBOARD_SERVER_API_BASE ||
      process.env.CLAWBOARD_PUBLIC_API_BASE ||
      process.env.NEXT_PUBLIC_CLAWBOARD_API_BASE ||
      "http://localhost:8010"
  );
  return rewriteDockerOnlyApiBase(configured);
}
