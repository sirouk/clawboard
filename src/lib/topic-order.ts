type OrderedTopicLike = {
  id: string;
  sortIndex?: number;
  updatedAt?: string | null;
};

function normalizedSortIndex(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : Number.MAX_SAFE_INTEGER;
}

export function compareByBoardOrder<T extends OrderedTopicLike>(a: T, b: T) {
  const sortDelta = normalizedSortIndex(a.sortIndex) - normalizedSortIndex(b.sortIndex);
  if (sortDelta !== 0) return sortDelta;

  const aUpdatedAt = String(a.updatedAt ?? "");
  const bUpdatedAt = String(b.updatedAt ?? "");
  if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt.localeCompare(aUpdatedAt);

  return a.id.localeCompare(b.id);
}

export function optimisticTopSortIndex<T extends Pick<OrderedTopicLike, "id" | "sortIndex">>(
  items: T[],
  focusId?: string
) {
  let floor = 0;
  let found = false;
  for (const item of items) {
    if (focusId && item.id === focusId) continue;
    if (!Number.isFinite(item.sortIndex)) continue;
    floor = found ? Math.min(floor, Number(item.sortIndex)) : Number(item.sortIndex);
    found = true;
  }
  return found ? floor - 1 : 0;
}
