import { normalizeTokenInput } from "@/lib/token";

const LOCAL_STORAGE_EVENT = "clawboard:local-storage";
const DEFAULT_API_PORT = "8010";

function emitLocalStorageChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LOCAL_STORAGE_EVENT));
}

function normalizeBase(value: string) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function hasScheme(value: string) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

function isLoopbackHost(hostname: string) {
  const value = (hostname ?? "").trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function coerceBrowserBase(value: string) {
  const trimmed = normalizeBase(value);
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed;
  if (hasScheme(trimmed)) return trimmed;
  if (typeof window === "undefined") return trimmed;
  // Treat bare host:port as same-protocol origin.
  return normalizeBase(`${window.location.protocol}//${trimmed}`);
}

export function getApiBase() {
  if (typeof window !== "undefined") {
    const runtimeBase =
      (window as unknown as { __CLAWBOARD_API_BASE?: string }).__CLAWBOARD_API_BASE ||
      window.localStorage.getItem("clawboard.apiBase");
    if (runtimeBase && runtimeBase.trim().length > 0) {
      return coerceBrowserBase(runtimeBase);
    }
  }

  const envBaseRaw = normalizeBase(process.env.NEXT_PUBLIC_CLAWBOARD_API_BASE ?? "");
  if (!envBaseRaw) return "";

  // Smart default for remote access:
  // If the bundle was built with a localhost API base (e.g. http://localhost:8010) but the
  // user is visiting Clawboard via a LAN/Tailscale hostname, rewrite the hostname to match
  // the current page hostname while keeping scheme + port.
  if (typeof window !== "undefined" && hasScheme(envBaseRaw)) {
    try {
      const url = new URL(envBaseRaw);
      const pageHost = window.location.hostname;
      if (isLoopbackHost(url.hostname) && pageHost && !isLoopbackHost(pageHost)) {
        url.hostname = pageHost;
        // Preserve the env port if present; otherwise default to the common docker-compose mapping.
        if (!url.port) url.port = DEFAULT_API_PORT;
        return normalizeBase(url.toString());
      }
    } catch {
      // Fall back to env string as-is.
    }
  }

  return envBaseRaw;
}

export function setApiBase(value: string) {
  if (typeof window === "undefined") return;
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) {
    window.localStorage.removeItem("clawboard.apiBase");
    emitLocalStorageChange();
    return;
  }
  window.localStorage.setItem("clawboard.apiBase", trimmed);
  emitLocalStorageChange();
}

export function apiUrl(path: string) {
  const base = getApiBase();
  if (!base) return path;
  if (path.startsWith("/")) return `${base}${path}`;
  return `${base}/${path}`;
}

const TOKEN_STORAGE_KEY = "clawboard.token";

export function getApiToken() {
  if (typeof window === "undefined") return "";
  const value = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  const normalized = normalizeTokenInput(value);
  if (normalized !== value) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, normalized);
    emitLocalStorageChange();
  }
  if (normalized) return normalized;

  // Allow a baked-in default token for self-hosted instances. If present, store it so all
  // callers (SSE, reconcile, writes) share a single source of truth.
  const baked = normalizeTokenInput(process.env.NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN ?? "");
  if (!baked) return "";
  window.localStorage.setItem(TOKEN_STORAGE_KEY, baked);
  emitLocalStorageChange();
  return baked;
}

function withTokenHeader(headers: HeadersInit | undefined, token: string): Headers {
  const next = new Headers(headers);
  if (token) {
    next.set("X-Clawboard-Token", token);
  }
  return next;
}

export function apiFetch(path: string, init: RequestInit = {}, tokenOverride?: string) {
  const token = (tokenOverride ?? getApiToken()).trim();
  return fetch(apiUrl(path), {
    ...init,
    headers: withTokenHeader(init.headers, token),
  });
}

export function apiUrlWithToken(path: string, tokenOverride?: string) {
  const token = (tokenOverride ?? getApiToken()).trim();
  const url = apiUrl(path);
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
