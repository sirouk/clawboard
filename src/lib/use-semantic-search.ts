"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { SemanticSearchResponse } from "@/lib/types";

type SemanticSearchParams = {
  query: string;
  topicId?: string | null;
  sessionKey?: string | null;
  includePending?: boolean;
  limitTopics?: number;
  limitTasks?: number;
  limitLogs?: number;
  enabled?: boolean;
  debounceMs?: number;
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
  includePending = true,
  limitTopics = 120,
  limitTasks = 240,
  limitLogs = 1000,
  enabled = true,
  debounceMs = 220,
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
    if (!enabled || trimmedQuery.length < 1) return "";
    const params = new URLSearchParams();
    params.set("q", trimmedQuery);
    params.set("includePending", includePending ? "true" : "false");
    params.set("limitTopics", String(Math.max(1, limitTopics)));
    params.set("limitTasks", String(Math.max(1, limitTasks)));
    params.set("limitLogs", String(Math.max(10, limitLogs)));
    if (topicId) params.set("topicId", topicId);
    if (sessionKey) params.set("sessionKey", sessionKey);
    return `/api/search?${params.toString()}`;
  }, [enabled, includePending, limitLogs, limitTasks, limitTopics, sessionKey, topicId, trimmedQuery]);

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
      try {
        const res = await apiFetch(requestUrl, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`search_failed_${res.status}`);
        }
        const payload = (await res.json()) as SemanticSearchResponse;
        if (controller.signal.aborted) return;
        setState({
          data: payload,
          loading: false,
          error: null,
          query: trimmedQuery,
        });
      } catch (error) {
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
  }, [debounceMs, requestUrl, trimmedQuery, refreshKey]);

  return state;
}
