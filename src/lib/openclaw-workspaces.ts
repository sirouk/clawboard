import type { OpenClawWorkspace } from "@/lib/types";

export const WORKSPACE_NAV_SYNC_EVENT = "clawboard:navigation-sync";

function workspaceHomeRoot(path: string) {
  const normalized = normalizeWorkspacePath(path);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length >= 2 && (segments[0] === "Users" || segments[0] === "home")) {
    return `/${segments[0]}/${segments[1]}`;
  }
  return "";
}

function normalizeWorkspacePath(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

export function workspaceLabel(agentId: string, agentName?: string | null) {
  const normalizedAgentId = String(agentId || "").trim().toLowerCase();
  const text = String(agentName || "").trim();
  if (normalizedAgentId === "main" && (!text || text.toLowerCase() === "main")) return "workspace";
  if (text) return text;
  const raw = String(agentId || "").trim().replace(/[-_]+/g, " ");
  return raw ? raw.slice(0, 1).toUpperCase() + raw.slice(1) : "Agent";
}

export function workspaceDirPrefix(workspaces: OpenClawWorkspace[]) {
  const normalizedPaths = workspaces.map((workspace) => normalizeWorkspacePath(workspace.workspaceDir)).filter(Boolean);
  if (normalizedPaths.length === 0) return "";
  const hasLeadingSlash = normalizedPaths.every((path) => path.startsWith("/"));
  let sharedSegments = normalizedPaths[0].split("/").filter(Boolean);
  for (const path of normalizedPaths.slice(1)) {
    const segments = path.split("/").filter(Boolean);
    let matched = 0;
    while (matched < sharedSegments.length && matched < segments.length && sharedSegments[matched] === segments[matched]) {
      matched += 1;
    }
    sharedSegments = sharedSegments.slice(0, matched);
    if (sharedSegments.length === 0) break;
  }
  if (sharedSegments.length === 0) return "";
  return `${hasLeadingSlash ? "/" : ""}${sharedSegments.join("/")}`;
}

export function workspaceDirLabel(workspaceDir: string, sharedPrefix: string) {
  const normalized = normalizeWorkspacePath(workspaceDir);
  if (!normalized) return "";
  if (sharedPrefix && normalized.startsWith(`${sharedPrefix}/`)) {
    return normalized.slice(sharedPrefix.length + 1) || ".";
  }
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

export function workspaceDirDisplay(workspaceDir: string) {
  const normalized = normalizeWorkspacePath(workspaceDir);
  if (!normalized) return "";
  const root = workspaceHomeRoot(normalized);
  if (root && normalized === root) return "~";
  if (root && normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length) || "/";
  }
  return normalized;
}

export function orderOpenClawWorkspaces(workspaces: OpenClawWorkspace[]) {
  return [...workspaces].sort((a, b) => {
    const aId = String(a.agentId || "").trim().toLowerCase();
    const bId = String(b.agentId || "").trim().toLowerCase();
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
