import { Suspense } from "react";
import { ClawgraphLive } from "@/components/clawgraph-live";

export default function GraphPage() {
  return (
    <Suspense fallback={null}>
      <ClawgraphLive />
    </Suspense>
  );
}
