export function getApiBase() {
  const base = process.env.NEXT_PUBLIC_CLAWBOARD_API_BASE;
  if (!base || base.trim().length === 0) return "";
  return base.replace(/\/$/, "");
}

export function apiUrl(path: string) {
  const base = getApiBase();
  if (!base) return path;
  if (path.startsWith("/")) return `${base}${path}`;
  return `${base}/${path}`;
}
