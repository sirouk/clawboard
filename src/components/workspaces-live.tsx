"use client";

import { usePathname } from "next/navigation";
import { startTransition, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { useAppConfig, useOpenClawWorkspaces } from "@/components/providers";
import { setLocalStorageItem } from "@/lib/local-storage";
import { orderOpenClawWorkspaces, workspaceLabel } from "@/lib/openclaw-workspaces";

const WORKSPACE_LAST_URL_KEY = "clawboard.workspaces.lastUrl";

function normalizeAgentId(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase();
}

function stringArraysEqual(a: string[], b: string[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Build the iframe src URL that auto-authenticates with code-server.
 * Points to a same-origin Next.js route that serves an auto-submitting
 * login form. The form POSTs to code-server's /login (same-site, different
 * port), so the SameSite=Lax auth cookie is properly saved.
 */
function buildAutoLoginUrl(ideBase: string, token: string): string {
  const params = new URLSearchParams({ target: ideBase, t: token });
  return `/workspace-auth?${params.toString()}`;
}

export function WorkspacesLive({
  selectedAgentId,
  active = false,
}: {
  selectedAgentId?: string | null;
  active?: boolean;
}) {
  const pathname = usePathname();
  const { token } = useAppConfig();
  const { error, configured, workspaces, loading: workspaceLoading } = useOpenClawWorkspaces();
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState("");
  const [mountedWorkspaceKeys, setMountedWorkspaceKeys] = useState<string[]>([]);
  const [loadedIframeKeys, setLoadedIframeKeys] = useState<string[]>([]);

  const ordered = useMemo(() => {
    return orderOpenClawWorkspaces(workspaces);
  }, [workspaces]);
  const selectedWorkspaceKeyFromRoute = useMemo(() => normalizeAgentId(selectedAgentId), [selectedAgentId]);

  useEffect(() => {
    const availableKeys = ordered.map((workspace) => normalizeAgentId(workspace.agentId)).filter(Boolean);
    const availableKeySet = new Set(availableKeys);
    startTransition(() => {
      setMountedWorkspaceKeys((current) => {
        const next = current.filter((key) => availableKeySet.has(key));
        return stringArraysEqual(current, next) ? current : next;
      });
      setSelectedWorkspaceKey((current) => {
        if (selectedWorkspaceKeyFromRoute && availableKeySet.has(selectedWorkspaceKeyFromRoute)) {
          return current === selectedWorkspaceKeyFromRoute ? current : selectedWorkspaceKeyFromRoute;
        }
        if (current && availableKeySet.has(current)) {
          return current;
        }
        const fallback = availableKeys[0] ?? "";
        return current === fallback ? current : fallback;
      });
    });
  }, [ordered, selectedWorkspaceKeyFromRoute]);

  const selectedWorkspace = useMemo(() => {
    const selected = ordered.find((workspace) => normalizeAgentId(workspace.agentId) === selectedWorkspaceKey);
    return selected ?? ordered[0] ?? null;
  }, [ordered, selectedWorkspaceKey]);

  const mountedWorkspaces = useMemo(() => {
    const mountedKeySet = new Set(mountedWorkspaceKeys);
    if (active && selectedWorkspace?.ideUrl) {
      mountedKeySet.add(normalizeAgentId(selectedWorkspace.agentId));
    }
    return ordered.filter((workspace) => mountedKeySet.has(normalizeAgentId(workspace.agentId)) && workspace.ideUrl);
  }, [active, mountedWorkspaceKeys, ordered, selectedWorkspace]);

  const selectedWorkspaceMounted = useMemo(
    () => mountedWorkspaceKeys.includes(normalizeAgentId(selectedWorkspace?.agentId)),
    [mountedWorkspaceKeys, selectedWorkspace?.agentId]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const nextUrl = `${window.location.pathname}${window.location.search}`;
    if (!pathname.startsWith("/workspaces/")) return;
    if (!nextUrl.startsWith("/workspaces/")) return;
    setLocalStorageItem(WORKSPACE_LAST_URL_KEY, nextUrl);
  }, [pathname]);

  // Mount the selected workspace when active and token is available.
  const selectedAgentNormalized = normalizeAgentId(selectedWorkspace?.agentId);
  const shouldMount =
    configured &&
    Boolean(selectedWorkspace?.ideUrl) &&
    (active || selectedWorkspaceMounted) &&
    !mountedWorkspaceKeys.includes(selectedAgentNormalized) &&
    Boolean(token);

  useEffect(() => {
    if (!shouldMount) return;
    setMountedWorkspaceKeys((current) =>
      current.includes(selectedAgentNormalized) ? current : [...current, selectedAgentNormalized]
    );
  }, [shouldMount, selectedAgentNormalized]);

  // Build auto-login iframe URLs using the same-origin page route.
  // Depends on the reactive context token so URLs update if the token changes.
  const iframeUrls = useMemo(() => {
    const urls: Record<string, string> = {};
    for (const workspace of mountedWorkspaces) {
      const key = normalizeAgentId(workspace.agentId);
      if (!workspace.ideUrl || !token) continue;
      urls[key] = buildAutoLoginUrl(workspace.ideUrl, token);
    }
    return urls;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, mountedWorkspaces.map((w) => normalizeAgentId(w.agentId)).join(",")]);

  const hasToken = Boolean(token.trim());
  const selectedNormalizedKey = normalizeAgentId(selectedWorkspace?.agentId);
  const selectedIframeLoaded = loadedIframeKeys.includes(selectedNormalizedKey);

  // Determine whether to show "Opening workspace…" overlay:
  // visible while the workspace is initializing (not yet mounted) or the iframe hasn't loaded.
  const showLoadingOverlay =
    configured &&
    Boolean(selectedWorkspace?.ideUrl) &&
    hasToken &&
    (!selectedWorkspaceMounted || !selectedIframeLoaded);

  return (
    <div className="space-y-4">
      {/* Only show "not configured" once we know (not during initial load) */}
      {!workspaceLoading && !configured ? (
        <div className="rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.24)] bg-[rgba(43,18,12,0.42)] px-3 py-2 text-sm text-[rgb(var(--claw-warning))]">
          Workspace IDE is not configured yet.
        </div>
      ) : null}
      {error ? (
        <div className="rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.24)] bg-[rgba(43,18,12,0.42)] px-3 py-2 text-sm text-[rgb(var(--claw-warning))]">
          {error}
        </div>
      ) : null}
      {!hasToken ? (
        <div className="rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.24)] bg-[rgba(43,18,12,0.42)] px-3 py-2 text-sm text-[rgb(var(--claw-warning))]">
          Set your API token in Settings to access the Code Workspace.
        </div>
      ) : null}

      {/* Loading skeleton while workspace data is being fetched */}
      {workspaceLoading && !configured && workspaces.length === 0 ? (
        <div className="relative h-[76vh] min-h-[32rem] overflow-hidden rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] bg-black">
          <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-[rgb(var(--claw-muted))]">
            Loading workspace…
          </div>
        </div>
      ) : null}

      {/* Empty state: configured but no workspaces */}
      {!workspaceLoading && configured && workspaces.length === 0 ? (
        <div className="rounded-[var(--radius-md)] border border-[rgba(77,171,158,0.18)] bg-[rgba(5,8,12,0.6)] px-4 py-6 text-center text-sm text-[rgb(var(--claw-muted))]">
          No workspaces are available yet.
        </div>
      ) : null}

      {selectedWorkspace?.ideUrl ? (
        <div className="relative h-[76vh] min-h-[32rem] overflow-hidden rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] bg-black">
          {showLoadingOverlay ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[rgba(5,8,12,0.82)] text-sm text-[rgb(var(--claw-muted))]">
              Opening workspace…
            </div>
          ) : null}
          {mountedWorkspaces.map((workspace) => {
            const normalizedAgentId = normalizeAgentId(workspace.agentId);
            const isActive = normalizedAgentId === normalizeAgentId(selectedWorkspace.agentId);
            const src = iframeUrls[normalizedAgentId];
            if (!src) return null;
            return (
              <iframe
                key={normalizedAgentId}
                data-testid={isActive ? "workspace-ide-frame" : `workspace-ide-frame-${normalizedAgentId}`}
                title={`${workspaceLabel(workspace.agentId, workspace.agentName)} workspace`}
                src={src}
                allow="clipboard-read; clipboard-write; fullscreen"
                onLoad={() => {
                  setLoadedIframeKeys((current) =>
                    current.includes(normalizedAgentId) ? current : [...current, normalizedAgentId]
                  );
                }}
                className={cn(
                  "absolute inset-0 h-full w-full border-0 bg-black transition-opacity",
                  isActive ? "z-10 opacity-100" : "pointer-events-none z-0 opacity-0"
                )}
              />
            );
          })}
        </div>
      ) : selectedWorkspace ? (
        <div className="rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.24)] bg-[rgba(43,18,12,0.42)] px-3 py-2 text-sm text-[rgb(var(--claw-warning))]">
          Workspace IDE is not configured yet for this workspace.
        </div>
      ) : null}
    </div>
  );
}
