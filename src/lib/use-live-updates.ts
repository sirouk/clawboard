"use client";

import { useEffect, useRef } from "react";
import { apiUrlWithToken, getApiBase, getApiToken } from "@/lib/api";
import type { LiveEvent } from "@/lib/live-utils";

type ReconcileFn = (since?: string) => Promise<string | void>;

export function useLiveUpdates(options: { onEvent: (event: LiveEvent) => void; reconcile?: ReconcileFn }) {
  const handlerRef = useRef(options.onEvent);
  const reconcileRef = useRef<ReconcileFn | undefined>(options.reconcile);
  const lastEventTs = useRef<string | undefined>(undefined);
  const hadOpen = useRef(false);

  useEffect(() => {
    handlerRef.current = options.onEvent;
  }, [options.onEvent]);

  useEffect(() => {
    reconcileRef.current = options.reconcile;
  }, [options.reconcile]);

  const token = getApiToken();

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_CLAWBOARD_DISABLE_STREAM === "1") return;
    const base = getApiBase();
    const streamUrl = apiUrlWithToken("/api/stream", token);
    if (!base && !streamUrl.startsWith("/")) return;

    const source = new EventSource(streamUrl);

    const runReconcile = async () => {
      if (!reconcileRef.current) return;
      const next = await reconcileRef.current(lastEventTs.current);
      if (typeof next === "string") {
        lastEventTs.current = next;
      }
    };

    source.onopen = () => {
      if (!hadOpen.current) {
        hadOpen.current = true;
        void runReconcile();
        return;
      }
      void runReconcile();
    };

    source.onmessage = (event) => {
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
      // EventSource auto-reconnects; keep quiet to avoid UI noise
    };

    return () => {
      source.close();
    };
  }, [token]);
}
