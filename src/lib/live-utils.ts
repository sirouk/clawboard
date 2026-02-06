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

export function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [next, ...items];
  }
  const current = items[index];
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

export function mergeById<T extends { id: string }>(items: T[], incoming: T[]): T[] {
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
  return next.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function maxTimestamp(items: Array<{ updatedAt?: string; createdAt?: string }>): string | undefined {
  let max = "";
  for (const item of items) {
    const value = item.updatedAt ?? item.createdAt ?? "";
    if (value > max) max = value;
  }
  return max || undefined;
}
