import { normalizeTokenInput } from "@/lib/token";

const LOCAL_STORAGE_EVENT = "clawboard:local-storage";

function emitLocalStorageChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LOCAL_STORAGE_EVENT));
}

export function getApiBase() {
  if (typeof window !== "undefined") {
    const runtimeBase =
      (window as unknown as { __CLAWBOARD_API_BASE?: string }).__CLAWBOARD_API_BASE ||
      window.localStorage.getItem("clawboard.apiBase");
    if (runtimeBase && runtimeBase.trim().length > 0) {
      return runtimeBase.replace(/\/$/, "");
    }
  }
  const base = process.env.NEXT_PUBLIC_CLAWBOARD_API_BASE;
  if (!base || base.trim().length === 0) return "";
  return base.replace(/\/$/, "");
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
  return normalized;
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
