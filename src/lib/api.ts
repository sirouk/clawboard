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
    return;
  }
  window.localStorage.setItem("clawboard.apiBase", trimmed);
}

export function apiUrl(path: string) {
  const base = getApiBase();
  if (!base) return path;
  if (path.startsWith("/")) return `${base}${path}`;
  return `${base}/${path}`;
}
