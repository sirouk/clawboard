import type { LogEntry, Task, Topic } from "@/lib/types";

export type LiveEvent =
  | { type: "topic.upserted"; data: Topic }
  | { type: "topic.deleted"; data: { id: string } }
  | { type: "task.upserted"; data: Task }
  | { type: "task.deleted"; data: { id: string } }
  | { type: "log.appended"; data: LogEntry }
  | { type: "log.patched"; data: LogEntry }
  | { type: "log.deleted"; data: { id: string } }
  | { type: "config.updated"; data: unknown }
  | { type: "stream.reset" }
  | { type: string; data?: unknown };

export function upsertById<T extends { id: string; updatedAt?: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [next, ...items];
  }
  const current = items[index];
  const currentUpdatedAtMs = parseIsoMs(current.updatedAt);
  const nextUpdatedAtMs = parseIsoMs(next.updatedAt);
  if (
    Number.isFinite(currentUpdatedAtMs) &&
    Number.isFinite(nextUpdatedAtMs) &&
    nextUpdatedAtMs < currentUpdatedAtMs
  ) {
    return items;
  }
  if (JSON.stringify(current) === JSON.stringify(next)) {
    return items;
  }
  const copy = [...items];
  copy[index] = { ...current, ...next };
  return copy;
}

export function prependUnique<T extends { id: string }>(items: T[], next: T): T[] {
  if (items.some((item) => item.id === next.id)) return items;
  return [next, ...items];
}

export function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

export function mergeById<T extends { id: string; updatedAt?: string }>(items: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return items;
  let next = items;
  for (const entry of incoming) {
    next = upsertById(next, entry);
  }
  return next;
}

export function mergeLogs(items: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (incoming.length === 0) return items;
  let next = items;
  for (const entry of incoming) {
    next = upsertById(next, entry);
  }
  return next.sort(compareLogsDesc);
}

function parseIsoMs(value: string | undefined): number {
  if (!value) return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

export function compareLogsDesc(a: LogEntry, b: LogEntry): number {
  const aCreated = parseIsoMs(a.createdAt);
  const bCreated = parseIsoMs(b.createdAt);
  if (Number.isFinite(aCreated) && Number.isFinite(bCreated) && aCreated !== bCreated) return bCreated - aCreated;

  // Stable, deterministic tiebreaker for same-createdAt entries.
  // Prefer idempotencyKey (present on history-synced entries) over the random
  // UUID-based id so same-second gateway messages sort consistently.
  if (a.id === b.id) return 0;
  const aKey = a.idempotencyKey ?? a.id;
  const bKey = b.idempotencyKey ?? b.id;
  return aKey > bKey ? 1 : aKey < bKey ? -1 : 0;
}

export function maxTimestamp(items: Array<{ updatedAt?: string; createdAt?: string }>): string | undefined {
  let max = "";
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = item.updatedAt ?? item.createdAt ?? "";
    const ms = parseIsoMs(value);
    if (Number.isFinite(ms)) {
      if (ms > maxMs) {
        maxMs = ms;
        max = value;
      }
      continue;
    }
    if (value > max && !Number.isFinite(maxMs)) max = value;
  }
  return max || undefined;
}
