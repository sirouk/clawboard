import { Suspense } from "react";
import { loadStore } from "@/lib/store";
import { UnifiedView } from "@/components/unified-view";

export default async function UnifiedSegmentsPage() {
  const store = await loadStore();
  return (
    <Suspense fallback={<div className="text-sm text-[rgb(var(--claw-muted))]">Loading unified view…</div>}>
      <UnifiedView topics={store.topics} tasks={store.tasks} logs={store.logs} basePath="/u" />
    </Suspense>
  );
}
