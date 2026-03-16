"use client";

import { apiFetch, getApiToken } from "@/lib/api";

const DB_NAME = "clawboard-write-queue";
const DB_VERSION = 1;
const STORE_NAME = "mutations";

export type QueuedMutation = {
  id: string;
  path: string;
  method: string;
  headers: Array<[string, string]>;
  bodyText?: string;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
};

export type QueueableMutationOptions = {
  token?: string;
  idempotencyKey?: string;
  queuedResponse?: unknown;
  allowQueue?: boolean;
};

let drainPromise: Promise<void> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `queued-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hasIndexedDb() {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function openQueueDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("nextAttemptAt", "nextAttemptAt", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open write queue."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (error?: unknown) => void) => void
) {
  if (!hasIndexedDb()) throw new Error("IndexedDB unavailable");
  const db = await openQueueDb();
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    run(store, resolve, reject);
    tx.oncomplete = () => db.close();
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("Write queue transaction aborted."));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Write queue transaction failed."));
    };
  });
}

function backoffMs(attempts: number) {
  const base = Math.min(60_000, 1_000 * Math.pow(2, Math.max(0, attempts)));
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(1_000, Math.round(base + jitter));
}

function canQueueBody(body: BodyInit | null | undefined): body is string | undefined {
  return typeof body === "undefined" || body === null || typeof body === "string";
}

function queuedResponse(body: unknown) {
  return new Response(JSON.stringify(body ?? { queued: true }), {
    status: 202,
    headers: {
      "Content-Type": "application/json",
      "X-Clawboard-Queued": "1",
    },
  });
}

async function putMutation(mutation: QueuedMutation) {
  await withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.put(mutation);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to enqueue mutation."));
  });
}

async function deleteMutation(id: string) {
  await withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to delete queued mutation."));
  });
}

async function listDueMutations(now: string) {
  return await withStore<QueuedMutation[]>("readonly", (store, resolve, reject) => {
    const request = store.index("nextAttemptAt").getAll(IDBKeyRange.upperBound(now));
    request.onsuccess = () => {
      const rows = Array.isArray(request.result) ? (request.result as QueuedMutation[]) : [];
      rows.sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.createdAt.localeCompare(b.createdAt));
      resolve(rows);
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to load queued mutations."));
  });
}

async function bumpMutation(mutation: QueuedMutation) {
  const attempts = Math.max(0, mutation.attempts) + 1;
  await putMutation({
    ...mutation,
    attempts,
    nextAttemptAt: new Date(Date.now() + backoffMs(attempts)).toISOString(),
  });
}

export async function queueableApiMutation(
  path: string,
  init: RequestInit,
  options: QueueableMutationOptions = {}
) {
  const method = String(init.method ?? "POST").trim().toUpperCase() || "POST";
  const token = (options.token ?? getApiToken()).trim();
  const allowQueue = options.allowQueue !== false;
  const headers = new Headers(init.headers);
  if (options.idempotencyKey) {
    headers.set("X-Idempotency-Key", options.idempotencyKey);
  }

  const body = init.body;
  const bodyText = canQueueBody(body) ? body ?? undefined : undefined;
  const queueUnsupported = !canQueueBody(body);

  const attempt = () => apiFetch(path, { ...init, method, headers }, token);

  if (allowQueue && typeof navigator !== "undefined" && navigator.onLine === false) {
    if (queueUnsupported) throw new Error("This action requires a live connection.");
    await putMutation({
      id: randomId(),
      path,
      method,
      headers: Array.from(headers.entries()),
      bodyText,
      createdAt: nowIso(),
      attempts: 0,
      nextAttemptAt: nowIso(),
    });
    return queuedResponse(options.queuedResponse);
  }

  try {
    return await attempt();
  } catch (error) {
    if (!allowQueue || queueUnsupported) throw error;
    await putMutation({
      id: randomId(),
      path,
      method,
      headers: Array.from(headers.entries()),
      bodyText,
      createdAt: nowIso(),
      attempts: 0,
      nextAttemptAt: nowIso(),
    });
    return queuedResponse(options.queuedResponse);
  }
}

export async function drainQueuedMutations() {
  if (drainPromise) return await drainPromise;
  drainPromise = (async () => {
    if (!hasIndexedDb()) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    // token may be empty in open (no-auth) deployments — still attempt the drain
    // and let the server decide. In token-required mode, the UI enforces read-only
    // when no token is set, so the queue will be empty.
    const token = getApiToken().trim();

    const due = await listDueMutations(nowIso());
    for (const mutation of due) {
      const headers = new Headers(mutation.headers);
      try {
        const res = await apiFetch(
          mutation.path,
          {
            method: mutation.method,
            headers,
            body: mutation.bodyText,
          },
          token
        );
        if (res.ok || res.status === 404 || res.status === 409) {
          await deleteMutation(mutation.id);
          continue;
        }
        if (res.status >= 500 || res.status === 429) {
          await bumpMutation(mutation);
          break;
        }
        await deleteMutation(mutation.id);
      } catch {
        await bumpMutation(mutation);
        break;
      }
    }
  })();

  try {
    await drainPromise;
  } finally {
    drainPromise = null;
  }
}
