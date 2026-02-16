"use client";

import { useEffect, useRef } from "react";
import { apiUrl, getApiBase, getApiToken } from "@/lib/api";
import { useLocalStorageItem } from "@/lib/local-storage";
import type { LiveEvent } from "@/lib/live-utils";

type ReconcileFn = (since?: string) => Promise<string | void>;

export function useLiveUpdates(options: { onEvent: (event: LiveEvent) => void; reconcile?: ReconcileFn }) {
  const handlerRef = useRef(options.onEvent);
  const reconcileRef = useRef<ReconcileFn | undefined>(options.reconcile);
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
      const now = Date.now();
      const wait = Math.max(0, RECONNECT_THROTTLE_MS - (now - lastReconnectAt));
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closed) return;
        lastReconnectAt = Date.now();
        void connect();
      }, wait);
    };

    const connect = async () => {
      if (closed || connecting) return;
      connecting = true;
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

        lastMessageAt.current = Date.now();
        stopPoll();
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
          scheduleReconnect();
        }
      }
    };

    const reconnect = () => {
      if (closed) return;
      startPoll();
      try {
        streamAbort?.abort();
      } catch {
        // ignore
      }
      streamAbort = null;
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

    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onVisibilityChange);

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
    };
  }, [base, token]);
}
