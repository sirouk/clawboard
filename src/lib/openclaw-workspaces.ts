import type { OpenClawWorkspace } from "@/lib/types";

export function workspaceLabel(agentId: string, agentName?: string | null) {
  const text = String(agentName || "").trim();
  if (text) return text;
  const raw = String(agentId || "").trim().replace(/[-_]+/g, " ");
  return raw ? raw.slice(0, 1).toUpperCase() + raw.slice(1) : "Agent";
}

export function orderOpenClawWorkspaces(workspaces: OpenClawWorkspace[]) {
  return [...workspaces].sort((a, b) => {
    const aId = String(a.agentId || "").trim().toLowerCase();
    const bId = String(b.agentId || "").trim().toLowerCase();
    if (aId === "coding" && bId !== "coding") return -1;
    if (bId === "coding" && aId !== "coding") return 1;
    if (aId === "main" && bId !== "main") return -1;
    if (bId === "main" && aId !== "main") return 1;
    if (Boolean(a.preferred) !== Boolean(b.preferred)) return a.preferred ? -1 : 1;
    return workspaceLabel(a.agentId, a.agentName).localeCompare(workspaceLabel(b.agentId, b.agentName));
  });
}

export function workspaceRoute(agentId: string) {
  const normalized = String(agentId || "").trim();
  if (!normalized) return "/workspaces";
  return `/workspaces/${encodeURIComponent(normalized)}`;
}
