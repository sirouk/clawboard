"use client";

import { usePathname } from "next/navigation";
import { startTransition, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { useOpenClawWorkspaces } from "@/components/providers";
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

export function WorkspacesLive({
  selectedAgentId,
  active = false,
}: {
  selectedAgentId?: string | null;
  active?: boolean;
}) {
  const pathname = usePathname();
  const { error, configured, workspaces } = useOpenClawWorkspaces();
  const [ideSessionStatus, setIdeSessionStatus] = useState<"idle" | "authorizing" | "ready" | "error">("idle");
  const [ideSessionError, setIdeSessionError] = useState<string | null>(null);
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState("");
  const [mountedWorkspaceKeys, setMountedWorkspaceKeys] = useState<string[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    async function authorizeEmbeddedWorkspace() {
      if (!configured || !selectedWorkspace?.ideUrl) {
        setIdeSessionStatus("idle");
        setIdeSessionError(null);
        return;
      }
      if (!active && !selectedWorkspaceMounted) {
        setIdeSessionStatus("idle");
        setIdeSessionError(null);
        return;
      }
      if (mountedWorkspaceKeys.includes(normalizeAgentId(selectedWorkspace.agentId))) {
        setIdeSessionStatus("ready");
        setIdeSessionError(null);
        return;
      }
      setIdeSessionStatus("authorizing");
      setIdeSessionError(null);
      try {
        const response = await fetch(
          `/api/openclaw/workspaces/session?agentId=${encodeURIComponent(String(selectedWorkspace.agentId || ""))}`,
          {
            method: "POST",
            cache: "no-store",
          }
        );
        if (cancelled) return;
        if (response.ok) {
          setIdeSessionStatus("ready");
          setIdeSessionError(null);
          setMountedWorkspaceKeys((current) => {
            const normalized = normalizeAgentId(selectedWorkspace.agentId);
            return current.includes(normalized) ? current : [...current, normalized];
          });
          return;
        }
        let detail = "Workspace login failed.";
        try {
          const body = (await response.json()) as { detail?: unknown };
          if (typeof body?.detail === "string" && body.detail.trim()) {
            detail = body.detail.trim();
          }
        } catch {
          // Ignore parse errors and keep generic detail.
        }
        setIdeSessionStatus("error");
        setIdeSessionError(detail);
      } catch (fetchError) {
        if (cancelled) return;
        const detail =
          fetchError instanceof Error && fetchError.message.trim()
            ? fetchError.message.trim()
            : "Workspace login failed.";
        setIdeSessionStatus("error");
        setIdeSessionError(detail);
      }
    }
    void authorizeEmbeddedWorkspace();
    return () => {
      cancelled = true;
    };
  }, [active, configured, mountedWorkspaceKeys, selectedWorkspace?.agentId, selectedWorkspace?.ideUrl, selectedWorkspaceMounted]);

  return (
    <div className="space-y-4">
      {!configured ? (
        <div className="rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.24)] bg-[rgba(43,18,12,0.42)] px-3 py-2 text-sm text-[rgb(var(--claw-warning))]">
          Workspace IDE is not configured yet.
        </div>
      ) : null}
      {error ? (
        <div className="rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.24)] bg-[rgba(43,18,12,0.42)] px-3 py-2 text-sm text-[rgb(var(--claw-warning))]">
          {error}
        </div>
      ) : null}
      {ideSessionError ? (
        <div className="rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.24)] bg-[rgba(43,18,12,0.42)] px-3 py-2 text-sm text-[rgb(var(--claw-warning))]">
          {ideSessionError}
        </div>
      ) : null}

      {selectedWorkspace?.ideUrl ? (
        <div className="relative h-[76vh] min-h-[32rem] overflow-hidden rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] bg-black">
          {ideSessionStatus === "authorizing" && !selectedWorkspaceMounted ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[rgba(5,8,12,0.82)] text-sm text-[rgb(var(--claw-muted))]">
              Opening workspace...
            </div>
          ) : null}
          {mountedWorkspaces.map((workspace) => {
            const normalizedAgentId = normalizeAgentId(workspace.agentId);
            const active = normalizedAgentId === normalizeAgentId(selectedWorkspace.agentId);
            return (
              <iframe
                key={normalizedAgentId}
                data-testid={active ? "workspace-ide-frame" : `workspace-ide-frame-${normalizedAgentId}`}
                title={`${workspaceLabel(workspace.agentId, workspace.agentName)} workspace`}
                src={workspace.ideUrl ?? undefined}
                allow="clipboard-read; clipboard-write; fullscreen"
                className={cn(
                  "absolute inset-0 h-full w-full border-0 bg-black transition-opacity",
                  active ? "z-10 opacity-100" : "pointer-events-none z-0 opacity-0"
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
