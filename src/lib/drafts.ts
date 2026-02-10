"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, getApiToken } from "@/lib/api";
import type { Draft } from "@/lib/types";
import { useDataStore } from "@/components/data-provider";

type LocalDraftSnapshot = { value: string; updatedAt: string };
type DraftLike = Pick<Draft, "value" | "updatedAt"> | null | undefined;

const LOCAL_PREFIX = "clawboard.draft.v1:";
const DEFAULT_DEBOUNCE_MS = 450;
const APPLY_SERVER_SILENCE_MS = 1500;

function parseLocalDraft(raw: string | null): LocalDraftSnapshot | null {
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as { value?: unknown; updatedAt?: unknown };
    const value = String(payload?.value ?? "");
    const updatedAt = String(payload?.updatedAt ?? "").trim();
    return { value, updatedAt };
  } catch {
    // Back-compat: raw string value (no timestamp).
    return { value: raw, updatedAt: "" };
  }
}

function toMs(value: string | undefined) {
  if (!value) return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

export function readBestDraftValue(key: string, serverDraft?: DraftLike, fallback = ""): string {
  if (typeof window === "undefined") return serverDraft?.value ?? fallback;
  const safeKey = (key ?? "").trim();
  if (!safeKey) return fallback;
  const local = parseLocalDraft(window.localStorage.getItem(`${LOCAL_PREFIX}${safeKey}`));
  const serverMs = toMs(serverDraft?.updatedAt);
  const localMs = toMs(local?.updatedAt);

  if (Number.isFinite(serverMs) && Number.isFinite(localMs)) {
    return serverMs >= localMs ? (serverDraft?.value ?? "") : (local?.value ?? "");
  }
  if (Number.isFinite(serverMs)) return serverDraft?.value ?? "";
  if (Number.isFinite(localMs)) return local?.value ?? "";
  return (serverDraft?.value ?? local?.value ?? fallback) ?? fallback;
}

function writeLocalDraft(key: string, value: string) {
  if (typeof window === "undefined") return;
  const safeKey = (key ?? "").trim();
  if (!safeKey) return;
  const updatedAt = new Date().toISOString();
  try {
    window.localStorage.setItem(`${LOCAL_PREFIX}${safeKey}`, JSON.stringify({ value, updatedAt }));
  } catch {
    // ignore storage failures (private mode / quota).
  }
}

const pendingTimers = new Map<string, number>();
const pendingValues = new Map<string, string>();

export function queueDraftUpsert(key: string, value: string, debounceMs = DEFAULT_DEBOUNCE_MS) {
  const safeKey = (key ?? "").trim();
  if (!safeKey) return;
  const nextValue = value ?? "";

  // Always persist locally immediately (survives refresh/offline even if token is missing).
  writeLocalDraft(safeKey, nextValue);

  // Server sync requires a token (drafts endpoint is write-protected).
  if (getApiToken().trim().length === 0) return;

  pendingValues.set(safeKey, nextValue);
  const existing = pendingTimers.get(safeKey);
  if (existing != null) window.clearTimeout(existing);
  const timer = window.setTimeout(async () => {
    pendingTimers.delete(safeKey);
    const latest = pendingValues.get(safeKey) ?? "";
    pendingValues.delete(safeKey);
    try {
      await apiFetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: safeKey, value: latest }),
      });
    } catch {
      // Best-effort: drafts are convenience state.
    }
  }, Math.max(50, debounceMs));
  pendingTimers.set(safeKey, timer);
}

export function usePersistentDraft(key: string, options?: { fallback?: string; debounceMs?: number }) {
  const { drafts } = useDataStore();
  const safeKey = (key ?? "").trim();
  const serverDraft = safeKey ? drafts[safeKey] : null;
  const serverUpdatedAt = serverDraft?.updatedAt ?? "";
  const serverValue = serverDraft?.value ?? "";
  const serverLike: DraftLike = safeKey ? { value: serverValue, updatedAt: serverUpdatedAt } : null;
  const fallback = options?.fallback ?? "";
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const [value, setValueState] = useState(() => readBestDraftValue(safeKey, serverLike, fallback));
  const lastEditAtRef = useRef(0);
  const keyRef = useRef("");

  useEffect(() => {
    const schedule = (updater: string | ((prev: string) => string)) => {
      // Avoid synchronous setState-in-effect (can cause cascading renders).
      // This is still a valid effect: it synchronizes React state with external systems
      // (server drafts + localStorage).
      const apply = () => setValueState(updater as never);
      if (typeof queueMicrotask === "function") {
        queueMicrotask(apply);
      } else {
        Promise.resolve().then(apply);
      }
    };

    const serverForRead: DraftLike = safeKey ? { value: serverValue, updatedAt: serverUpdatedAt } : null;

    if (!safeKey) {
      keyRef.current = "";
      schedule(fallback);
      return;
    }
    if (keyRef.current !== safeKey) {
      keyRef.current = safeKey;
      schedule(readBestDraftValue(safeKey, serverForRead, fallback));
      return;
    }

    // Apply server/local updates if the user hasn't typed recently.
    if (Date.now() - lastEditAtRef.current < APPLY_SERVER_SILENCE_MS) return;
    const next = readBestDraftValue(safeKey, serverForRead, fallback);
    schedule((prev) => (prev === next ? prev : next));
  }, [fallback, safeKey, serverUpdatedAt, serverValue]);

  const setValue = useCallback(
    (next: string) => {
      const text = next ?? "";
      setValueState(text);
      lastEditAtRef.current = Date.now();
      if (!safeKey) return;
      queueDraftUpsert(safeKey, text, debounceMs);
    },
    [debounceMs, safeKey]
  );

  return { value, setValue };
}
