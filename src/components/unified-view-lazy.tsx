"use client";

import dynamic from "next/dynamic";

const UnifiedViewDeferred = dynamic(
  () => import("@/components/unified-view").then((mod) => mod.UnifiedView),
  {
    ssr: false,
    loading: () => null,
  }
);

export function UnifiedViewLazy({ basePath = "/u", active = true }: { basePath?: string; active?: boolean } = {}) {
  return <UnifiedViewDeferred basePath={basePath} active={active} />;
}
