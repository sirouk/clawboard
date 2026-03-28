import crypto from "node:crypto";

import type { ContextMode } from "./types.js";

export type ContextCacheEntry = {
  mode: ContextMode;
  block: string;
  cachedAtMs: number;
};

export function createContextCache(options: {
  ttlMs: number;
  maxEntries: number;
  fallbackModes: ContextMode[];
  normalizeWhitespace: (value: string) => string;
  isContextMode: (value: string) => value is ContextMode;
  nowMs?: () => number;
}) {
  const nowMs = options.nowMs ?? Date.now;
  const contextCache = new Map<string, ContextCacheEntry>();

  function contextSessionCacheKey(sessionKey: string | undefined) {
    const normalized = options.normalizeWhitespace(String(sessionKey ?? ""));
    return normalized || "global";
  }

  function contextQueryHash(query: string) {
    return crypto.createHash("sha256").update(query).digest("hex").slice(0, 24);
  }

  function contextCacheKey(sessionKey: string | undefined, query: string, mode: ContextMode) {
    return `${contextSessionCacheKey(sessionKey)}|${mode}|${contextQueryHash(query)}`;
  }

  function contextModePlan(primary: ContextMode): ContextMode[] {
    const defaultsByPrimary: Record<ContextMode, ContextMode[]> = {
      auto: ["full", "cheap"],
      cheap: ["auto", "full"],
      full: ["auto", "cheap"],
      patient: ["full", "auto", "cheap"],
    };
    const configured = options.fallbackModes.length > 0 ? options.fallbackModes : defaultsByPrimary[primary];
    const ordered = [primary, ...configured];
    const seen = new Set<ContextMode>();
    const deduped: ContextMode[] = [];
    for (const mode of ordered) {
      if (!options.isContextMode(mode) || seen.has(mode)) continue;
      seen.add(mode);
      deduped.push(mode);
    }
    return deduped.length > 0 ? deduped : [primary];
  }

  function pruneContextCache() {
    if (contextCache.size === 0) return;
    const now = nowMs();
    if (options.ttlMs > 0) {
      for (const [key, entry] of contextCache.entries()) {
        if (now - entry.cachedAtMs > options.ttlMs) contextCache.delete(key);
      }
    } else {
      contextCache.clear();
      return;
    }
    if (contextCache.size <= options.maxEntries) return;
    const sorted = Array.from(contextCache.entries()).sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs);
    const overflow = contextCache.size - options.maxEntries;
    for (let idx = 0; idx < overflow; idx += 1) {
      const row = sorted[idx];
      if (!row) break;
      contextCache.delete(row[0]);
    }
  }

  function readContextCacheEntry(
    sessionKey: string | undefined,
    query: string,
    mode: ContextMode,
    maxAgeMs: number,
  ): ContextCacheEntry | undefined {
    if (options.ttlMs <= 0 || maxAgeMs <= 0) return undefined;
    const entry = contextCache.get(contextCacheKey(sessionKey, query, mode));
    if (!entry) return undefined;
    if (nowMs() - entry.cachedAtMs > maxAgeMs) return undefined;
    return entry;
  }

  function writeContextCache(sessionKey: string | undefined, query: string, mode: ContextMode, block: string) {
    if (options.ttlMs <= 0) return;
    contextCache.set(contextCacheKey(sessionKey, query, mode), {
      mode,
      block,
      cachedAtMs: nowMs(),
    });
    pruneContextCache();
  }

  return {
    contextCache,
    contextModePlan,
    contextSessionCacheKey,
    contextQueryHash,
    contextCacheKey,
    pruneContextCache,
    readContextCacheEntry,
    writeContextCache,
  };
}
