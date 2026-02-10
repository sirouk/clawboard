"use client";

import { useEffect, useRef } from "react";
import { apiUrlWithToken, getApiBase, getApiToken } from "@/lib/api";
import { useLocalStorageItem } from "@/lib/local-storage";
import type { LiveEvent } from "@/lib/live-utils";

type ReconcileFn = (since?: string) => Promise<string | void>;

export function useLiveUpdates(options: { onEvent: (event: LiveEvent) => void; reconcile?: ReconcileFn }) {
  const handlerRef = useRef(options.onEvent);
  const reconcileRef = useRef<ReconcileFn | undefined>(options.reconcile);
  const lastEventTs = useRef<string | undefined>(undefined);
  const lastMessageAt = useRef<number>(0);
  const lastReconcileAt = useRef<number>(0);
  const lastBase = useRef<string>("");

  useEffect(() => {
    handlerRef.current = options.onEvent;
  }, [options.onEvent]);

  useEffect(() => {
    reconcileRef.current = options.reconcile;
  }, [options.reconcile]);

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
    }
    lastBase.current = base;
    const streamUrl = apiUrlWithToken("/api/stream", token);
    if (!base && !streamUrl.startsWith("/")) return;

    let closed = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let reconciling = false;
    let lastReconnectAt = 0;

    // Safety net: even with SSE, reconcile periodically so the UI never depends on a single socket.
    // Keep this fast enough to feel "live" when SSE silently stalls.
    const WATCHDOG_INTERVAL_MS = 5_000;
    // Server sends `stream.ping` about every ~25s. If we haven't seen any SSE messages for a while,
    // treat the connection as stale and force a reconnect.
    const STALE_SSE_MS = 70_000;
    const RECONNECT_THROTTLE_MS = 5_000;

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

    const connect = () => {
      if (closed) return;
      source = new EventSource(streamUrl);
      lastMessageAt.current = Date.now();

      source.onopen = () => {
        lastMessageAt.current = Date.now();
        stopPoll();
        void runReconcile();
      };

      source.onmessage = (event) => {
        lastMessageAt.current = Date.now();
        if (!event.data) return;
        try {
          const payload = JSON.parse(event.data) as LiveEvent & { eventTs?: string };
          if (payload.type === "stream.reset") {
            lastEventTs.current = undefined;
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

      source.onerror = () => {
        // EventSource auto-reconnects. Keep UI fresh with polling until it comes back.
        startPoll();
      };
    };

    const reconnect = () => {
      if (closed) return;
      const now = Date.now();
      if (now - lastReconnectAt < RECONNECT_THROTTLE_MS) return;
      lastReconnectAt = now;

      // While reconnecting, keep the UI moving even if the browser doesn't surface an error.
      startPoll();
      try {
        source?.close();
      } catch {
        // ignore
      }
      source = null;
      connect();
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

    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Always do an initial reconcile so the UI doesn't depend on SSE opening.
    void runReconcile();
    startWatchdog();
    connect();

    return () => {
      closed = true;
      stopPoll();
      stopWatchdog();
      try {
        source?.close();
      } catch {
        // ignore
      }
      source = null;
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [base, token]);
}
