"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { UnifiedViewLazy } from "@/components/unified-view-lazy";

type BoardWorkspaceHubView = "board" | "workspaces";

const WorkspacesLiveDeferred = dynamic(
  () => import("@/components/workspaces-live").then((mod) => mod.WorkspacesLive),
  {
    ssr: false,
    loading: () => null,
  }
);

export function BoardWorkspaceHub({
  activeView,
  selectedWorkspaceAgentId,
}: {
  activeView: BoardWorkspaceHubView;
  selectedWorkspaceAgentId?: string | null;
}) {
  // Track whether workspaces have ever been the active view so we only mount
  // WorkspacesLive on demand but keep it alive thereafter (preserves its state).
  // Derived-state-during-render pattern: calling setState synchronously during
  // render is the React-idiomatic way to handle "adjust state when a prop changes"
  // (see react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [workspacesEverActive, setWorkspacesEverActive] = useState(
    () => activeView === "workspaces"
  );
  if (activeView === "workspaces" && !workspacesEverActive) {
    setWorkspacesEverActive(true);
  }

  const boardActive = activeView === "board";
  const workspacesActive = activeView === "workspaces";

  return (
    <>
      {/* Board is always mounted — hiding with CSS preserves all state (expanded rows,
          pending messages, scroll position) when the user visits Workspaces and returns. */}
      <section
        data-testid="board-hub-panel"
        className={boardActive ? "" : "hidden"}
      >
        <UnifiedViewLazy basePath="/u" active={boardActive} />
      </section>

      {/* Workspaces is mounted on first visit and kept alive after that. */}
      {workspacesEverActive ? (
        <section
          data-testid="workspace-hub-panel"
          className={workspacesActive ? "" : "hidden"}
        >
          <WorkspacesLiveDeferred
            selectedAgentId={selectedWorkspaceAgentId}
            active={workspacesActive}
          />
        </section>
      ) : null}
    </>
  );
}
