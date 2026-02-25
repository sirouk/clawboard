"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { SemanticSearchResponse } from "@/lib/types";

type SemanticSearchParams = {
  query: string;
  topicId?: string | null;
  sessionKey?: string | null;
  spaceId?: string | null;
  allowedSpaceIds?: string[] | null;
  includePending?: boolean;
  limitTopics?: number;
  limitTasks?: number;
  limitLogs?: number;
  enabled?: boolean;
  debounceMs?: number;
  requestTimeoutMs?: number;
  minQueryLength?: number;
  refreshKey?: string | number | null;
};

type SemanticSearchState = {
  data: SemanticSearchResponse | null;
  loading: boolean;
  error: string | null;
  query: string;
};

export function useSemanticSearch({
  query,
  topicId,
  sessionKey,
  spaceId,
  allowedSpaceIds,
  includePending = true,
  limitTopics = 80,
  limitTasks = 160,
  limitLogs = 240,
  enabled = true,
  debounceMs = 380,
  requestTimeoutMs = 15000,
  minQueryLength = 2,
  refreshKey = null,
}: SemanticSearchParams): SemanticSearchState {
  const trimmedQuery = query.trim();
  const [state, setState] = useState<SemanticSearchState>({
    data: null,
    loading: false,
    error: null,
    query: "",
  });

  const requestUrl = useMemo(() => {
    if (!enabled || trimmedQuery.length < Math.max(1, minQueryLength)) return "";
    const topicsValue = Math.min(Math.max(1, limitTopics), 120);
    const tasksValue = Math.min(Math.max(1, limitTasks), 240);
    const logsValue = Math.min(Math.max(10, limitLogs), 320);
    const params = new URLSearchParams();
    params.set("q", trimmedQuery);
    params.set("includePending", includePending ? "true" : "false");
    params.set("limitTopics", String(topicsValue));
    params.set("limitTasks", String(tasksValue));
    params.set("limitLogs", String(logsValue));
    if (topicId) params.set("topicId", topicId);
    if (sessionKey) params.set("sessionKey", sessionKey);
    if (spaceId) params.set("spaceId", spaceId);
    if (allowedSpaceIds && allowedSpaceIds.length > 0) {
      params.set("allowedSpaceIds", allowedSpaceIds.join(","));
    }
    return `/api/search?${params.toString()}`;
  }, [
    allowedSpaceIds,
    enabled,
    includePending,
    limitLogs,
    limitTasks,
    limitTopics,
    minQueryLength,
    sessionKey,
    spaceId,
    topicId,
    trimmedQuery,
  ]);

  useEffect(() => {
    if (!requestUrl) {
      setState((prev) => {
        if (!prev.data && !prev.loading && !prev.error && prev.query === "") return prev;
        return { data: null, loading: false, error: null, query: "" };
      });
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setState((prev) => ({ ...prev, loading: true, error: null, query: trimmedQuery }));
      let timedOut = false;
      const timeoutMs = Math.max(1000, Math.floor(requestTimeoutMs));
      const timeoutTimer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        let payload: SemanticSearchResponse | null = null;
        const maxAttempts = 2;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const res = await apiFetch(requestUrl, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (res.ok) {
            payload = (await res.json()) as SemanticSearchResponse;
            break;
          }
          if (res.status !== 429 || attempt >= maxAttempts - 1) {
            throw new Error(`search_failed_${res.status}`);
          }
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 180 + attempt * 120);
          });
        }
        if (!payload) {
          throw new Error("search_failed");
        }
        window.clearTimeout(timeoutTimer);
        if (controller.signal.aborted) return;
        setState({
          data: payload,
          loading: false,
          error: null,
          query: trimmedQuery,
        });
      } catch (error) {
        window.clearTimeout(timeoutTimer);
        if (controller.signal.aborted && timedOut) {
          setState((prev) => ({
            data: prev.query === trimmedQuery ? prev.data : null,
            loading: false,
            error: "search_timeout",
            query: trimmedQuery,
          }));
          return;
        }
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "search_failed";
        setState((prev) => ({
          data: prev.query === trimmedQuery ? prev.data : null,
          loading: false,
          error: message,
          query: trimmedQuery,
        }));
      }
    }, Math.max(0, debounceMs));

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [debounceMs, requestTimeoutMs, requestUrl, trimmedQuery, refreshKey]);

  return state;
}
