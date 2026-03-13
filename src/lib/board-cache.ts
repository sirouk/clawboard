"use client";

import type { Draft, LogEntry, Space, Topic } from "@/lib/types";

const DB_NAME = "clawboard-board-cache";
const DB_VERSION = 1;
const SNAPSHOT_STORE = "snapshots";
const SNAPSHOT_KEY = "board";

export type BoardSnapshot = {
  spaces: Space[];
  topics: Topic[];
  logs: LogEntry[];
  drafts: Record<string, Draft>;
  openclawTyping: Record<string, { typing: boolean; requestId?: string; updatedAt: string }>;
  openclawThreadWork: Record<string, { active: boolean; requestId?: string; reason?: string; updatedAt: string }>;
  cachedAt: string;
};

function isValidSpace(value: Space | null | undefined): value is Space {
  return Boolean(value && String(value.id ?? "").trim() && String(value.name ?? "").trim());
}

function isValidTopic(value: Topic | null | undefined): value is Topic {
  return Boolean(
    value &&
      String(value.id ?? "").trim() &&
      String(value.name ?? "").trim() &&
      String(value.updatedAt ?? value.createdAt ?? "").trim()
  );
}

function isValidLog(value: LogEntry | null | undefined): value is LogEntry {
  return Boolean(
    value &&
      String(value.id ?? "").trim() &&
      String(value.createdAt ?? "").trim() &&
      typeof value.content === "string"
  );
}

function isValidDraft(value: Draft | null | undefined): value is Draft {
  return Boolean(value && String(value.key ?? "").trim() && typeof value.value === "string");
}

function sanitizeSnapshot(snapshot: BoardSnapshot | null | undefined): BoardSnapshot | null {
  if (!snapshot) return null;
  const drafts = Object.fromEntries(
    Object.entries(snapshot.drafts ?? {}).filter(([, value]) => isValidDraft(value as Draft | null | undefined))
  ) as Record<string, Draft>;
  return {
    spaces: Array.isArray(snapshot.spaces) ? snapshot.spaces.filter(isValidSpace) : [],
    topics: Array.isArray(snapshot.topics) ? snapshot.topics.filter(isValidTopic) : [],
    logs: Array.isArray(snapshot.logs) ? snapshot.logs.filter(isValidLog) : [],
    drafts,
    openclawTyping: snapshot.openclawTyping ?? {},
    openclawThreadWork: snapshot.openclawThreadWork ?? {},
    cachedAt: String(snapshot.cachedAt ?? "").trim() || new Date(0).toISOString(),
  };
}

function hasIndexedDb() {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function openBoardCacheDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open board cache."));
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void) {
  return new Promise<T>((resolve, reject) => {
    if (!hasIndexedDb()) {
      resolve(undefined as T);
      return;
    }
    void openBoardCacheDb()
      .then((db) => {
        const transaction = db.transaction(SNAPSHOT_STORE, mode);
        const store = transaction.objectStore(SNAPSHOT_STORE);
        run(store);
        transaction.oncomplete = () => {
          db.close();
        };
        transaction.onerror = () => {
          const error = transaction.error ?? new Error("Board cache transaction failed.");
          db.close();
          reject(error);
        };
        transaction.onabort = () => {
          const error = transaction.error ?? new Error("Board cache transaction aborted.");
          db.close();
          reject(error);
        };
        const request = store.get(SNAPSHOT_KEY);
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error("Board cache request failed."));
      })
      .catch(reject);
  });
}

export async function loadBoardSnapshot() {
  if (!hasIndexedDb()) return null;
  try {
    return sanitizeSnapshot((await withStore<BoardSnapshot | null>("readonly", () => {})) ?? null);
  } catch {
    return null;
  }
}

export async function saveBoardSnapshot(snapshot: BoardSnapshot) {
  if (!hasIndexedDb()) return;
  const sanitized = sanitizeSnapshot(snapshot);
  if (!sanitized) return;
  try {
    await new Promise<void>((resolve, reject) => {
      void openBoardCacheDb()
        .then((db) => {
          const transaction = db.transaction(SNAPSHOT_STORE, "readwrite");
          const store = transaction.objectStore(SNAPSHOT_STORE);
          store.put(sanitized, SNAPSHOT_KEY);
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => {
            const error = transaction.error ?? new Error("Failed to save board cache.");
            db.close();
            reject(error);
          };
          transaction.onabort = () => {
            const error = transaction.error ?? new Error("Failed to save board cache.");
            db.close();
            reject(error);
          };
        })
        .catch(reject);
    });
  } catch {
    // Best-effort cache only.
  }
}
