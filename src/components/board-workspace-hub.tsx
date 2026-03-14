"use client";

import { Suspense } from "react";
import { UnifiedView } from "@/components/unified-view";
import { WorkspacesLive } from "@/components/workspaces-live";

type BoardWorkspaceHubView = "board" | "workspaces";

export function BoardWorkspaceHub({
  activeView,
  selectedWorkspaceAgentId,
}: {
  activeView: BoardWorkspaceHubView;
  selectedWorkspaceAgentId?: string | null;
}) {
  const boardActive = activeView === "board";
  const workspacesActive = activeView === "workspaces";

  return (
    <>
      <section hidden={!boardActive} aria-hidden={!boardActive} data-testid="board-hub-panel">
        <Suspense fallback={<div className="text-sm text-[rgb(var(--claw-muted))]">Loading unified view...</div>}>
          <UnifiedView basePath="/u" />
        </Suspense>
      </section>
      <section hidden={!workspacesActive} aria-hidden={!workspacesActive} data-testid="workspace-hub-panel">
        <WorkspacesLive selectedAgentId={selectedWorkspaceAgentId} />
      </section>
    </>
  );
}
