import { loadStore } from "@/lib/store";
import { DashboardLive } from "@/components/dashboard-live";

export default async function DashboardPage() {
  const store = await loadStore();
  return <DashboardLive initialTasks={store.tasks} initialLogs={store.logs} initialTopics={store.topics} />;
}
