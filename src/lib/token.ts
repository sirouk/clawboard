export function normalizeTokenInput(value: string) {
  const raw = (value ?? "").trim();
  if (!raw) return "";

  const unwrapped = raw.replace(/^['"]|['"]$/g, "").trim();
  if (!unwrapped) return "";

  const lines = unwrapped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? "";

  const withoutExport = firstLine.replace(/^export\s+/i, "").trim();
  const assignment = withoutExport.match(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
  if (assignment?.[1]) {
    return normalizeTokenInput(assignment[1]);
  }

  const tokenParam = withoutExport.match(/(?:^|[?&\s])token=([^&\s]+)/i);
  if (tokenParam?.[1]) {
    return decodeURIComponent(tokenParam[1]).replace(/^['"]|['"]$/g, "").trim();
  }

  return withoutExport;
}
