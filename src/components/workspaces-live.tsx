"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useOpenClawWorkspaces } from "@/components/providers";
import { orderOpenClawWorkspaces, workspaceLabel, workspaceRoute } from "@/lib/openclaw-workspaces";

export function WorkspacesLive({ selectedAgentId }: { selectedAgentId?: string | null }) {
  const { loading, error, configured, provider, baseUrl, workspaces, refresh } = useOpenClawWorkspaces();
  const [copiedAgentId, setCopiedAgentId] = useState<string | null>(null);
  const [ideSessionStatus, setIdeSessionStatus] = useState<"idle" | "authorizing" | "ready" | "error">("idle");
  const [ideSessionError, setIdeSessionError] = useState<string | null>(null);
  const [frameNonce, setFrameNonce] = useState(0);
  const [authAttempt, setAuthAttempt] = useState(0);

  const ordered = useMemo(() => {
    return orderOpenClawWorkspaces(workspaces);
  }, [workspaces]);
  const selectedWorkspace = useMemo(() => {
    const normalized = String(selectedAgentId || "").trim().toLowerCase();
    if (normalized) {
      const explicit = ordered.find((workspace) => String(workspace.agentId || "").trim().toLowerCase() === normalized);
      if (explicit) return explicit;
    }
    return ordered[0] ?? null;
  }, [ordered, selectedAgentId]);

  const copyWorkspacePath = async (agentId: string, workspaceDir: string) => {
    try {
      await navigator.clipboard.writeText(workspaceDir);
      setCopiedAgentId(agentId);
      window.setTimeout(() => {
        setCopiedAgentId((prev) => (prev === agentId ? null : prev));
      }, 1600);
    } catch {
      setCopiedAgentId(null);
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
      setIdeSessionStatus("authorizing");
      setIdeSessionError(null);
      try {
        const response = await fetch("/api/openclaw/workspaces/session", {
          method: "POST",
          cache: "no-store",
        });
        if (cancelled) return;
        if (response.ok) {
          setIdeSessionStatus("ready");
          setIdeSessionError(null);
          setFrameNonce((current) => current + 1);
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
  }, [authAttempt, configured, selectedWorkspace?.agentId, selectedWorkspace?.ideUrl]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="items-start gap-3 max-md:flex-col">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent2">In Clawboard</Badge>
              {configured ? <Badge tone="success">{provider || "workspace ide"}</Badge> : <Badge tone="warning">Not configured</Badge>}
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-[rgb(var(--claw-text))]">Agent Workspaces</h2>
              <p className="mt-2 max-w-[72ch] text-sm text-[rgb(var(--claw-muted))]">
                Jump between agent workspaces from the chip row below while keeping orchestration, chat, and the active
                code surface in one place.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 max-md:w-full">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                refresh();
                setIdeSessionStatus("idle");
                setIdeSessionError(null);
                setAuthAttempt((current) => current + 1);
              }}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
            {baseUrl ? (
              <div className="max-w-[26rem] overflow-x-auto whitespace-nowrap rounded-full border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.55)] px-3 py-2 text-[11px] text-[rgb(var(--claw-muted))]">
                {baseUrl}
              </div>
            ) : null}
          </div>
        </CardHeader>
          <div className="space-y-3 text-sm text-[rgb(var(--claw-muted))]">
          <p>Clawboard task chat will call out recent specialist workspace activity and link you to the most relevant workspace view.</p>
          {!configured ? (
            <p className="text-[rgb(var(--claw-warning))]">
              Workspace IDE is not configured yet. Set <code>CLAWBOARD_WORKSPACE_IDE_BASE_URL</code> and start the optional
              code-server companion to make these links live.
            </p>
          ) : null}
          {error ? <p className="text-[rgb(var(--claw-warning))]">{error}</p> : null}
          {ideSessionError ? <p className="text-[rgb(var(--claw-warning))]">{ideSessionError}</p> : null}
          <div
            className="flex flex-wrap items-center gap-2 pt-1"
            data-testid="workspace-chip-row"
          >
            {ordered.map((workspace) => {
              const agentId = String(workspace.agentId || "").trim();
              const label = workspaceLabel(agentId, workspace.agentName);
              const selected = selectedWorkspace?.agentId === agentId;
              const preferred = Boolean(workspace.preferred) || agentId === "coding";
              return (
                <Link
                  key={agentId}
                  href={workspaceRoute(agentId)}
                  data-testid={`open-workspace-${agentId}`}
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
        </div>
      </Card>

      {selectedWorkspace ? (
        <Card className="overflow-hidden">
          <CardHeader className="items-start gap-3 max-md:flex-col">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent2">{workspaceLabel(selectedWorkspace.agentId, selectedWorkspace.agentName)}</Badge>
                {Boolean(selectedWorkspace.preferred) || selectedWorkspace.agentId === "coding" ? <Badge tone="success">Preferred</Badge> : null}
                <span className="text-xs uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">Embedded workspace</span>
              </div>
              <p className="text-sm text-[rgb(var(--claw-muted))]">
                {selectedWorkspace.agentId === "coding"
                  ? "Primary repo inspection and edit bay."
                  : selectedWorkspace.agentId === "main"
                    ? "Supervisor workspace for orchestration and final curation."
                    : "Specialist workspace resolved from OpenClaw configuration."}
              </p>
              <div className="overflow-x-auto whitespace-nowrap rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.6)] px-3 py-2 text-xs text-[rgb(var(--claw-text))]">
                {selectedWorkspace.workspaceDir}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 max-md:w-full">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void copyWorkspacePath(selectedWorkspace.agentId, selectedWorkspace.workspaceDir)}
              >
                {copiedAgentId === selectedWorkspace.agentId ? "Copied path" : "Copy path"}
              </Button>
              {selectedWorkspace.ideUrl ? (
                <div className="max-w-full overflow-x-auto whitespace-nowrap rounded-full border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.55)] px-3 py-2 text-[11px] text-[rgb(var(--claw-muted))]">
                  {selectedWorkspace.ideUrl}
                </div>
              ) : null}
            </div>
          </CardHeader>
          {selectedWorkspace.ideUrl ? (
            <div className="relative">
              {ideSessionStatus === "authorizing" ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-[rgba(5,8,12,0.82)] text-sm text-[rgb(var(--claw-muted))]">
                  Authorizing embedded workspace...
                </div>
              ) : null}
              <iframe
                key={`${selectedWorkspace.agentId}:${frameNonce}`}
                data-testid="workspace-ide-frame"
                title={`${workspaceLabel(selectedWorkspace.agentId, selectedWorkspace.agentName)} workspace`}
                src={selectedWorkspace.ideUrl}
                allow="clipboard-read; clipboard-write; fullscreen"
                className={cn(
                  "h-[74vh] w-full border-0 bg-black",
                  ideSessionStatus === "authorizing" ? "opacity-0" : "opacity-100",
                )}
              />
            </div>
          ) : (
            <div className="px-4 pb-4 text-sm text-[rgb(var(--claw-warning))]">
              Workspace IDE is not configured yet for this workspace.
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
