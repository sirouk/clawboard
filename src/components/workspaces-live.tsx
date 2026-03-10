"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { useOpenClawWorkspaces } from "@/components/providers";
import { WORKSPACE_NAV_SYNC_EVENT, orderOpenClawWorkspaces, workspaceLabel, workspaceRoute } from "@/lib/openclaw-workspaces";

function normalizeAgentId(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase();
}

export function WorkspacesLive({ selectedAgentId }: { selectedAgentId?: string | null }) {
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
    setMountedWorkspaceKeys((current) => current.filter((key) => availableKeySet.has(key)));
    setSelectedWorkspaceKey((current) => {
      if (selectedWorkspaceKeyFromRoute && availableKeySet.has(selectedWorkspaceKeyFromRoute)) {
        return selectedWorkspaceKeyFromRoute;
      }
      if (current && availableKeySet.has(current)) {
        return current;
      }
      return availableKeys[0] ?? "";
    });
  }, [ordered, selectedWorkspaceKeyFromRoute]);

  const selectedWorkspace = useMemo(() => {
    const selected = ordered.find((workspace) => normalizeAgentId(workspace.agentId) === selectedWorkspaceKey);
    return selected ?? ordered[0] ?? null;
  }, [ordered, selectedWorkspaceKey]);

  const mountedWorkspaces = useMemo(() => {
    const mountedKeySet = new Set(mountedWorkspaceKeys);
    if (selectedWorkspace?.ideUrl) {
      mountedKeySet.add(normalizeAgentId(selectedWorkspace.agentId));
    }
    return ordered.filter((workspace) => mountedKeySet.has(normalizeAgentId(workspace.agentId)) && workspace.ideUrl);
  }, [mountedWorkspaceKeys, ordered, selectedWorkspace]);

  const selectedWorkspaceMounted = useMemo(
    () => mountedWorkspaceKeys.includes(normalizeAgentId(selectedWorkspace?.agentId)),
    [mountedWorkspaceKeys, selectedWorkspace?.agentId]
  );

  const selectWorkspace = (agentId: string) => {
    const normalized = normalizeAgentId(agentId);
    if (!normalized) return;
    setSelectedWorkspaceKey(normalized);
    setMountedWorkspaceKeys((current) => (current.includes(normalized) ? current : [...current, normalized]));
    if (typeof window !== "undefined") {
      const nextUrl = workspaceRoute(normalized);
      if (window.location.pathname !== nextUrl) {
        window.history.replaceState(window.history.state, "", nextUrl);
      }
      window.dispatchEvent(new Event(WORKSPACE_NAV_SYNC_EVENT));
    }
  };

  useEffect(() => {
    let cancelled = false;
    async function authorizeEmbeddedWorkspace() {
      if (!configured || !selectedWorkspace?.ideUrl) {
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
  }, [configured, mountedWorkspaceKeys, selectedWorkspace?.agentId, selectedWorkspace?.ideUrl]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="workspace-chip-row">
        {ordered.map((workspace) => {
          const agentId = String(workspace.agentId || "").trim();
          const normalizedAgentId = normalizeAgentId(agentId);
          const label = workspaceLabel(agentId, workspace.agentName);
          const selected = normalizeAgentId(selectedWorkspace?.agentId) === normalizedAgentId;
          const preferred = Boolean(workspace.preferred) || normalizedAgentId === "coding";
          return (
            <Link
              key={agentId}
              href={workspaceRoute(agentId)}
              data-testid={`open-workspace-${agentId}`}
              onClick={(event) => {
                event.preventDefault();
                selectWorkspace(agentId);
              }}
              className={cn(
                "inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium transition",
                selected
                  ? "border-[rgba(255,90,45,0.42)] bg-[linear-gradient(90deg,rgba(255,90,45,0.28),rgba(255,90,45,0.1))] text-[rgb(var(--claw-text))] shadow-[0_0_0_1px_rgba(255,90,45,0.22)]"
                  : preferred
                    ? "border-[rgba(77,171,158,0.35)] bg-[rgba(77,171,158,0.12)] text-[rgb(var(--claw-text))] hover:border-[rgba(77,171,158,0.48)]"
                    : "border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.45)] text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
              )}
            >
              <span>{label}</span>
              {selected ? (
                <span className="text-[10px] uppercase tracking-[0.16em] text-[rgba(255,198,179,0.95)]">Viewing</span>
              ) : null}
            </Link>
          );
        })}
      </div>

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
