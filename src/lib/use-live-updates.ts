"use client";

import { useEffect, useRef } from "react";
import { apiUrl, getApiBase, getApiToken } from "@/lib/api";
import { useLocalStorageItem } from "@/lib/local-storage";
import type { LiveEvent } from "@/lib/live-utils";

type ReconcileFn = (since?: string) => Promise<string | void>;

// Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (max), with ±25% jitter.
function backoffDelayMs(retryCount: number): number {
  const base = Math.min(30_000, 1_000 * Math.pow(2, retryCount));
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}

export function useLiveUpdates(options: {
  onEvent: (event: LiveEvent) => void;
  reconcile?: ReconcileFn;
  onConnectionChange?: (connected: boolean) => void;
}) {
  const handlerRef = useRef(options.onEvent);
  const reconcileRef = useRef<ReconcileFn | undefined>(options.reconcile);
  const onConnectionChangeRef = useRef(options.onConnectionChange);
  const lastEventTs = useRef<string | undefined>(undefined);
  const lastSseId = useRef<string | undefined>(undefined);
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
    }
    lastBase.current = base;
    const streamUrl = apiUrl("/api/stream");
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
      if (currentlyConnected === connected) return;
      currentlyConnected = connected;
      onConnectionChangeRef.current?.(connected);
    };

    const runReconcile = async () => {
      if (!reconcileRef.current) return;
      if (reconciling) return;
      reconciling = true;
      try {
        lastReconcileAt.current = Date.now();
        const next = await reconcileRef.current(lastEventTs.current);
        if (typeof next === "string") {
          lastEventTs.current = next;
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
      // Fallback: if SSE is blocked by a proxy/network hiccup, keep the UI current.
      pollTimer = setInterval(() => {
        if (closed) return;
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
      if (eventId) lastSseId.current = eventId;
      if (eventName !== "message") return;
      if (!dataLines.length) return;
      const payloadRaw = dataLines.join("\n");
      try {
        const payload = JSON.parse(payloadRaw) as LiveEvent & { eventTs?: string };
        if (payload.type === "stream.reset") {
          lastEventTs.current = undefined;
          lastSseId.current = undefined;
          void runReconcile();
          return;
        }
        if (payload.eventTs) {
          lastEventTs.current = payload.eventTs;
        } else if ("data" in payload && payload.data && typeof payload.data === "object") {
          const maybe = payload.data as { updatedAt?: string; createdAt?: string };
          if (typeof maybe.updatedAt === "string") {
            lastEventTs.current = maybe.updatedAt;
          } else if (typeof maybe.createdAt === "string") {
            lastEventTs.current = maybe.createdAt;
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
      if (token) headers.set("X-Clawboard-Token", token);
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
      reconnect();
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
      // Browser reports offline — abort the stream, cancel reconnect timer, and mark disconnected.
      // We won't reschedule reconnection; the "online" event will trigger it.
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
