import type { Space } from "@/lib/types";

const LEGACY_DEFAULT_VISIBILITY_KEY = "__claw_default_visible";

type ConnectivityRecord = Record<string, boolean>;

function connectivityOf(space: Pick<Space, "connectivity"> | null | undefined): ConnectivityRecord {
  const connectivity = space?.connectivity;
  if (!connectivity || typeof connectivity !== "object") return {};
  return connectivity;
}

export function getSpaceDefaultVisibility(
  space: Pick<Space, "connectivity" | "defaultVisible"> | null | undefined
): boolean {
  if (typeof space?.defaultVisible === "boolean") {
    return space.defaultVisible;
  }
  const connectivity = connectivityOf(space);
  if (!Object.prototype.hasOwnProperty.call(connectivity, LEGACY_DEFAULT_VISIBILITY_KEY)) {
    return true;
  }
  return Boolean(connectivity[LEGACY_DEFAULT_VISIBILITY_KEY]);
}

export function resolveSpaceVisibilityFromViewer(
  viewer: Pick<Space, "connectivity"> | null | undefined,
  candidate: Pick<Space, "id" | "connectivity" | "defaultVisible"> | null | undefined
): boolean {
  if (!candidate) return false;
  const viewerConnectivity = connectivityOf(viewer);
  if (Object.prototype.hasOwnProperty.call(viewerConnectivity, candidate.id)) {
    return Boolean(viewerConnectivity[candidate.id]);
  }
  return getSpaceDefaultVisibility(candidate);
}
