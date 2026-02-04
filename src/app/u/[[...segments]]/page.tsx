import { Suspense } from "react";
import { UnifiedView } from "@/components/unified-view";

export default async function UnifiedSegmentsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-[rgb(var(--claw-muted))]">Loading unified view…</div>}>
      <UnifiedView basePath="/u" />
    </Suspense>
  );
}
