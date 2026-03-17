"use client";

import { useEffect, useRef } from "react";
import { apiRequestUrl, getApiBase, getApiToken } from "@/lib/api";
import { useLocalStorageItem } from "@/lib/local-storage";
import type { LiveEvent } from "@/lib/live-utils";

export type ReconcileCursor = {
  since?: string;
  sinceSeq?: number;
};

export type ReconcileResult =
  | {
      cursor?: string;
      cursorSeq?: number;
      reset?: boolean;
    }
  | string
  | void;

type ReconcileFn = (cursor?: ReconcileCursor) => Promise<ReconcileResult>;

export type ConnectionInfo = {
  connected: boolean;
  reconnectAttempt: number;
};

const STREAM_EVENT_TS_KEY = "clawboard.stream.eventTs";
const STREAM_EVENT_ID_KEY = "clawboard.stream.lastEventId";
const STREAM_EVENT_SEQ_KEY = "clawboard.stream.lastSeq";

function readStoredCursor(key: string) {
  if (typeof window === "undefined") return undefined;
  const value = window.localStorage.getItem(key);
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function writeStoredCursor(key: string, value: string | undefined) {
  if (typeof window === "undefined") return;
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, normalized);
}

function readStoredSeq(key: string) {
  const value = readStoredCursor(key);
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function writeStoredSeq(key: string, value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    writeStoredCursor(key, undefined);
    return;
  }
  writeStoredCursor(key, String(Math.floor(value)));
}

// Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (max), with ±25% jitter.
function backoffDelayMs(retryCount: number): number {
  const base = Math.min(30_000, 1_000 * Math.pow(2, retryCount));
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}

// Minimum interval between reconcile calls to prevent storms from overlapping triggers.
const MIN_RECONCILE_INTERVAL_MS = 2_000;

// If the last SSE message arrived within this window, skip forced reconnect on focus —
// the connection is still healthy and only needs a reconcile to fill any gaps.
const RECENT_MESSAGE_THRESHOLD_MS = 35_000;

export function useLiveUpdates(options: {
  onEvent: (event: LiveEvent) => void;
  reconcile?: ReconcileFn;
  onConnectionChange?: (info: ConnectionInfo) => void;
}) {
  const handlerRef = useRef(options.onEvent);
  const reconcileRef = useRef<ReconcileFn | undefined>(options.reconcile);
  const onConnectionChangeRef = useRef(options.onConnectionChange);
  const lastEventTs = useRef<string | undefined>(readStoredCursor(STREAM_EVENT_TS_KEY));
  const lastSseId = useRef<string | undefined>(readStoredCursor(STREAM_EVENT_ID_KEY));
  const lastSeq = useRef<number | undefined>(readStoredSeq(STREAM_EVENT_SEQ_KEY));
  const lastMessageAt = useRef<number>(0);
  const lastReconcileAt = useRef<number>(0);
  const lastBase = useRef<string>("");

  useEffect(() => {
    handlerRef.current = options.onEvent;
  }, [options.onEvent]);

  useEffect(() => {
    reconcileRef.current = options.reconcile;
  }, [options.reconcile]);

  useEffect(() => {
    onConnectionChangeRef.current = options.onConnectionChange;
  }, [options.onConnectionChange]);

  // Subscribe to token/base changes so SSE can reconnect immediately when the user
  // updates Setup (common with remote/Tailscale access).
  useLocalStorageItem("clawboard.token");
  useLocalStorageItem("clawboard.apiBase");
  const token = getApiToken();
  const base = getApiBase();

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_CLAWBOARD_DISABLE_STREAM === "1") return;
    if (lastBase.current && base && lastBase.current !== base) {
      // Switching instances (or fixing API base) requires a full resync.
      lastEventTs.current = undefined;
      lastSseId.current = undefined;
      lastSeq.current = undefined;
      writeStoredCursor(STREAM_EVENT_TS_KEY, undefined);
      writeStoredCursor(STREAM_EVENT_ID_KEY, undefined);
      writeStoredSeq(STREAM_EVENT_SEQ_KEY, undefined);
    }
    lastBase.current = base;
    const streamUrl = apiRequestUrl("/api/stream");
    if (!base && !streamUrl.startsWith("/")) return;

    let closed = false;
    let streamAbort: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let connecting = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let reconciling = false;
    let retryCount = 0;
    let currentlyConnected = false;

    // Server sends `stream.ping` about every ~25s. If we haven't seen any SSE messages for a while,
    // treat the connection as stale and force a reconnect.
    const WATCHDOG_INTERVAL_MS = 5_000;
    const STALE_SSE_MS = 70_000;

    const notifyConnected = (connected: boolean) => {
      if (currentlyConnected === connected && connected) return;
      currentlyConnected = connected;
      onConnectionChangeRef.current?.({ connected, reconnectAttempt: retryCount });
    };

    const runReconcile = async () => {
      if (!reconcileRef.current) return;
      if (reconciling) return;
      // Throttle: don't reconcile more often than MIN_RECONCILE_INTERVAL_MS.
      const now = Date.now();
      if (now - lastReconcileAt.current < MIN_RECONCILE_INTERVAL_MS) return;
      reconciling = true;
      try {
        lastReconcileAt.current = Date.now();
        const next = await reconcileRef.current({
          since: lastEventTs.current,
          sinceSeq: lastSeq.current,
        });
        if (typeof next === "string") {
          lastEventTs.current = next;
          writeStoredCursor(STREAM_EVENT_TS_KEY, next);
        } else if (next && typeof next === "object") {
          if (next.reset) {
            // Backend detected a data reset newer than the client's cached snapshot.
            // Clear all cursor state so the next reconcile does a full (non-incremental) load.
            lastEventTs.current = undefined;
            lastSseId.current = undefined;
            lastSeq.current = undefined;
            writeStoredCursor(STREAM_EVENT_TS_KEY, undefined);
            writeStoredCursor(STREAM_EVENT_ID_KEY, undefined);
            writeStoredSeq(STREAM_EVENT_SEQ_KEY, undefined);
            lastReconcileAt.current = 0; // bypass throttle for immediate re-reconcile
            reconciling = false;
            void runReconcile();
            return;
          }
          const cursor = typeof next.cursor === "string" ? next.cursor.trim() || undefined : undefined;
          const cursorSeq =
            typeof next.cursorSeq === "number" && Number.isFinite(next.cursorSeq) ? Math.floor(next.cursorSeq) : undefined;
          if (typeof cursor !== "undefined") {
            lastEventTs.current = cursor;
            writeStoredCursor(STREAM_EVENT_TS_KEY, cursor);
          }
          if (typeof cursorSeq !== "undefined") {
            lastSeq.current = cursorSeq;
            writeStoredSeq(STREAM_EVENT_SEQ_KEY, cursorSeq);
          }
        }
      } catch {
        // Reconcile is best-effort. Network errors or transient API failures are silently
        // dropped here — the watchdog/poll timer will retry on the next tick.
      } finally {
        reconciling = false;
      }
    };

    const startPoll = () => {
      if (pollTimer) return;
      // Don't poll when the browser reports offline — saves battery and avoids error noise.
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      // Fallback: if SSE is blocked by a proxy/network hiccup, keep the UI current.
      pollTimer = setInterval(() => {
        if (closed) return;
        // Stop polling if we went offline while the timer was running.
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          stopPoll();
          return;
        }
        void runReconcile();
      }, 2_000);
    };

    const stopPoll = () => {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
    };

    const parseSseBlock = (rawBlock: string) => {
      const block = rawBlock.trim();
      if (!block) return;
      let eventName = "message";
      let eventId: string | undefined;
      const dataLines: string[] = [];
      for (const rawLine of block.split("\n")) {
        const line = rawLine.trimEnd();
        if (!line || line.startsWith(":")) continue;
        const sep = line.indexOf(":");
        const field = sep >= 0 ? line.slice(0, sep) : line;
        let value = sep >= 0 ? line.slice(sep + 1) : "";
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") {
          eventName = value || "message";
          continue;
        }
        if (field === "id") {
          eventId = value || undefined;
          continue;
        }
        if (field === "data") {
          dataLines.push(value);
        }
      }
      if (eventId) {
        lastSseId.current = eventId;
        writeStoredCursor(STREAM_EVENT_ID_KEY, eventId);
        const parsedEventSeq = Number.parseInt(eventId, 10);
        if (Number.isFinite(parsedEventSeq) && parsedEventSeq >= 0) {
          lastSeq.current = parsedEventSeq;
          writeStoredSeq(STREAM_EVENT_SEQ_KEY, parsedEventSeq);
        }
      }
      if (eventName !== "message") return;
      if (!dataLines.length) return;
      const payloadRaw = dataLines.join("\n");
      try {
        const payload = JSON.parse(payloadRaw) as LiveEvent & { eventTs?: string };
        if (payload.type === "stream.reset") {
          lastEventTs.current = undefined;
          lastSseId.current = undefined;
          lastSeq.current = undefined;
          writeStoredCursor(STREAM_EVENT_TS_KEY, undefined);
          writeStoredCursor(STREAM_EVENT_ID_KEY, undefined);
          writeStoredSeq(STREAM_EVENT_SEQ_KEY, undefined);
          void runReconcile();
          return;
        }
        const payloadSeq =
          typeof (payload as LiveEvent & { eventSeq?: unknown }).eventSeq === "number"
            ? Math.floor((payload as LiveEvent & { eventSeq?: number }).eventSeq as number)
            : undefined;
        if (typeof payloadSeq === "number" && Number.isFinite(payloadSeq) && payloadSeq >= 0) {
          lastSeq.current = payloadSeq;
          writeStoredSeq(STREAM_EVENT_SEQ_KEY, payloadSeq);
        }
        if (payload.eventTs) {
          lastEventTs.current = payload.eventTs;
          writeStoredCursor(STREAM_EVENT_TS_KEY, payload.eventTs);
        } else if ("data" in payload && payload.data && typeof payload.data === "object") {
          const maybe = payload.data as { updatedAt?: string; createdAt?: string };
          if (typeof maybe.updatedAt === "string") {
            lastEventTs.current = maybe.updatedAt;
            writeStoredCursor(STREAM_EVENT_TS_KEY, maybe.updatedAt);
          } else if (typeof maybe.createdAt === "string") {
            lastEventTs.current = maybe.createdAt;
            writeStoredCursor(STREAM_EVENT_TS_KEY, maybe.createdAt);
          }
        }
        handlerRef.current(payload);
      } catch {
        // ignore malformed events
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      // Don't schedule if the browser reports offline — we'll reconnect on the "online" event.
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      if (reconnectTimer) return;
      const delay = backoffDelayMs(retryCount);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closed) return;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (closed || connecting) return;
      // Don't attempt connection when offline.
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      connecting = true;
      retryCount += 1;
      streamAbort = new AbortController();
      lastMessageAt.current = Date.now();

      const headers = new Headers();
      headers.set("Accept", "text/event-stream");
      if (token) headers.set("X-ClawBoard-Token", token);
      if (lastSseId.current) headers.set("Last-Event-ID", lastSseId.current);

      try {
        const res = await fetch(streamUrl, {
          method: "GET",
          headers,
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          signal: streamAbort.signal,
        });
        if (!res.ok || !res.body) {
          if (res.status === 401) {
            console.error("[sse] stream unauthorized (401)");
          }
          startPoll();
          return;
        }

        // Stream opened — reset backoff and mark connected.
        retryCount = 0;
        lastMessageAt.current = Date.now();
        stopPoll();
        notifyConnected(true);
        void runReconcile();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          lastMessageAt.current = Date.now();
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let split = buffer.indexOf("\n\n");
          while (split >= 0) {
            const rawBlock = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            parseSseBlock(rawBlock);
            split = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (!closed) {
          startPoll();
        }
      } finally {
        connecting = false;
        streamAbort = null;
        if (!closed) {
          notifyConnected(false);
          scheduleReconnect();
        }
      }
    };

    const reconnect = () => {
      if (closed) return;
      startPoll();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        streamAbort?.abort();
      } catch {
        // ignore
      }
      streamAbort = null;
      // Reconnect immediately on explicit triggers (focus, visibility, online).
      // Reset retry count so we start fresh rather than using a long backoff.
      retryCount = 0;
      scheduleReconnect();
    };

    const startWatchdog = () => {
      if (watchdogTimer) return;
      watchdogTimer = setInterval(() => {
        if (closed) return;
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        const now = Date.now();
        if (now - lastMessageAt.current > STALE_SSE_MS) {
          reconnect();
          return;
        }
        void runReconcile();
      }, WATCHDOG_INTERVAL_MS);
    };

    const stopWatchdog = () => {
      if (!watchdogTimer) return;
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    };

    const onForeground = () => {
      if (closed) return;
      void runReconcile();
      // Only force reconnect if the stream appears stale (no message received recently).
      // If the stream is healthy, reconcile alone fills any gaps without disrupting the connection.
      if (Date.now() - lastMessageAt.current > RECENT_MESSAGE_THRESHOLD_MS) {
        reconnect();
      }
    };

    const onVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      onForeground();
    };

    const onOnline = () => {
      if (closed) return;
      // Back online — reconnect immediately and reconcile.
      retryCount = 0;
      void runReconcile();
      reconnect();
    };

    const onOffline = () => {
      if (closed) return;
      // Browser reports offline — abort the stream, cancel reconnect/poll timers, and mark disconnected.
      // We won't reschedule reconnection; the "online" event will trigger it.
      stopPoll();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        streamAbort?.abort();
      } catch {
        // ignore
      }
      streamAbort = null;
      notifyConnected(false);
    };

    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    // Always do an initial reconcile so the UI doesn't depend on SSE opening.
    void runReconcile();
    startWatchdog();
    void connect();

    return () => {
      closed = true;
      stopPoll();
      stopWatchdog();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        streamAbort?.abort();
      } catch {
        // ignore
      }
      streamAbort = null;
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [base, token]);
}
