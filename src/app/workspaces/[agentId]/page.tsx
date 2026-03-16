import { WorkspacesLive } from "@/components/workspaces-live";

export default async function WorkspaceAgentPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return <WorkspacesLive selectedAgentId={agentId} active />;
}
