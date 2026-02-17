"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Select } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { useDataStore } from "@/components/data-provider";
import { apiFetch, getApiBase, setApiBase } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { IntegrationLevel, Space, Topic } from "@/lib/types";

function deriveSpaceName(spaceId: string) {
  const normalized = String(spaceId || "").trim();
  if (!normalized || normalized === "space-default") return "Global";
  const base = normalized.replace(/^space[-_]+/i, "");
  const withSpaces = base.replace(/[-_]+/g, " ").trim();
  if (!withSpaces) return normalized;
  return withSpaces.replace(/\b\w/g, (match) => match.toUpperCase());
}

function spaceIdFromTagLabel(value: string) {
  let text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (text.startsWith("system:")) return null;
  if (text.startsWith("space:")) text = text.split(":", 2)[1]?.trim() ?? "";
  const slugged = text
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slugged || slugged === "default" || slugged === "global" || slugged === "all" || slugged === "all-spaces") {
    return null;
  }
  return `space-${slugged}`;
}

function topicSpaceIds(topic: Pick<Topic, "spaceId" | "tags"> | null | undefined) {
  const out = new Set<string>();
  for (const rawTag of topic?.tags ?? []) {
    const fromTag = spaceIdFromTagLabel(String(rawTag ?? ""));
    if (fromTag) out.add(fromTag);
  }
  const primary = String(topic?.spaceId ?? "").trim();
  if (primary && primary !== "space-default") out.add(primary);
  return Array.from(out);
}

function SpaceSwitch({
  checked,
  onToggle,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-9 w-16 items-center rounded-full border px-1 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(77,171,158,0.38)] disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-[rgba(77,171,158,0.62)] bg-[linear-gradient(120deg,rgba(54,151,135,0.62),rgba(61,128,205,0.56))] shadow-[0_0_0_1px_rgba(77,171,158,0.18),0_6px_18px_rgba(35,120,140,0.35)]"
          : "border-[rgb(var(--claw-border))] bg-[linear-gradient(120deg,rgba(24,28,36,0.96),rgba(14,17,24,0.9))]"
      )}
    >
      <span className="pointer-events-none absolute left-2 text-[9px] font-semibold tracking-[0.14em] text-white/70">
        ON
      </span>
      <span className="pointer-events-none absolute right-2 text-[9px] font-semibold tracking-[0.14em] text-white/55">
        OFF
      </span>
      <span
        className={cn(
          "relative z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border shadow-[0_8px_18px_rgba(0,0,0,0.42)] transition-transform duration-200",
          checked
            ? "translate-x-7 border-[rgba(190,255,238,0.8)] bg-[linear-gradient(155deg,#f2fff8,#baf6e4)] text-[rgb(20,96,84)]"
            : "translate-x-0 border-[rgba(146,158,176,0.5)] bg-[linear-gradient(155deg,#eef4ff,#cfd7e6)] text-[rgb(71,83,108)]"
        )}
      >
        {checked ? (
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.1">
            <path d="M4.5 10.5l3.2 3.1 7.8-7.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.1">
            <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </button>
  );
}

export function SettingsLive() {
  const {
    instanceTitle,
    setInstanceTitle,
    integrationLevel,
    setIntegrationLevel,
    token,
    setToken,
    tokenRequired,
  } = useAppConfig();
  const { spaces: storeSpaces, topics: storeTopics, setSpaces } = useDataStore();

  const [localTitle, setLocalTitle] = useState(instanceTitle);
  const [localIntegration, setLocalIntegration] = useState<IntegrationLevel>(integrationLevel);
  const [localToken, setLocalToken] = useState(token);
  const [localApiBase, setLocalApiBase] = useState(() => getApiBase() || "");
  const [sourceSpaceId, setSourceSpaceId] = useState("");
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingConnectivityKey, setSavingConnectivityKey] = useState<string | null>(null);
  const [cleanupArmedSpaceId, setCleanupArmedSpaceId] = useState<string | null>(null);
  const [cleanupSpaceId, setCleanupSpaceId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setLocalTitle(instanceTitle), [instanceTitle]);
  useEffect(() => setLocalIntegration(integrationLevel), [integrationLevel]);
  useEffect(() => setLocalToken(token), [token]);

  const spaces = useMemo(() => {
    const byId = new Map<string, Space>();
    const topicBackedSpaceIds = new Set<string>();
    for (const topic of storeTopics) {
      for (const id of topicSpaceIds(topic)) topicBackedSpaceIds.add(id);
    }
    for (const space of storeSpaces) {
      const id = String(space?.id ?? "").trim();
      if (!id) continue;
      if (id === "space-default") continue;
      if (!topicBackedSpaceIds.has(id)) continue;
      byId.set(id, space);
    }
    for (const topic of storeTopics) {
      for (const id of topicSpaceIds(topic)) {
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          name: deriveSpaceName(id),
          color: null,
          connectivity: {},
          createdAt: "",
          updatedAt: "",
        });
      }
    }
    const out = Array.from(byId.values());
    out.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return out;
  }, [storeSpaces, storeTopics]);

  useEffect(() => {
    if (spaces.length === 0) return;
    if (sourceSpaceId && spaces.some((space) => space.id === sourceSpaceId)) return;
    setSourceSpaceId(spaces[0].id);
  }, [sourceSpaceId, spaces]);
  useEffect(() => {
    if (!cleanupArmedSpaceId) return;
    if (cleanupArmedSpaceId === sourceSpaceId) return;
    setCleanupArmedSpaceId(null);
  }, [cleanupArmedSpaceId, sourceSpaceId]);

  const sourceSpace = useMemo(
    () => spaces.find((space) => space.id === sourceSpaceId) ?? null,
    [sourceSpaceId, spaces]
  );
  const targets = useMemo(() => spaces.filter((space) => space.id !== sourceSpaceId), [sourceSpaceId, spaces]);
  const topicCountBySpaceId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const topic of storeTopics) {
      for (const id of topicSpaceIds(topic)) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [storeTopics]);
  const sourceTopicCount = topicCountBySpaceId.get(sourceSpaceId) ?? 0;
  const readOnly = tokenRequired && !localToken.trim();

  const saveGeneral = async () => {
    setSavingGeneral(true);
    setError(null);
    setMessage(null);
    try {
      if (localApiBase.trim()) setApiBase(localApiBase.trim());
      const res = await apiFetch(
        "/api/config",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: localTitle.trim() || "Clawboard",
            integrationLevel: localIntegration,
          }),
        },
        localToken.trim()
      );
      if (!res.ok) throw new Error("Failed to update instance settings.");
      setInstanceTitle(localTitle.trim() || "Clawboard");
      setIntegrationLevel(localIntegration);
      setToken(localToken.trim());
      setMessage("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setSavingGeneral(false);
    }
  };

  const toggleVisibility = async (targetId: string, enabled: boolean) => {
    if (!sourceSpaceId || !sourceSpace) return;
    if (readOnly) {
      setError("Token required to update space visibility.");
      return;
    }
    const targetSpace = spaces.find((space) => space.id === targetId);
    if (!targetSpace) return;
    const key = `${targetId}:${sourceSpaceId}`;
    const currentConnectivity =
      targetSpace.connectivity && typeof targetSpace.connectivity === "object" ? targetSpace.connectivity : {};
    const hadPrevious = Object.prototype.hasOwnProperty.call(currentConnectivity, sourceSpaceId);
    const previous = hadPrevious ? Boolean(currentConnectivity[sourceSpaceId]) : true;

    setSavingConnectivityKey(key);
    setError(null);
    setMessage(null);

    setSpaces((prev) =>
      prev.map((space) => {
        if (space.id !== targetId) return space;
        const connectivity = {
          ...(space.connectivity && typeof space.connectivity === "object" ? space.connectivity : {}),
          [sourceSpaceId]: enabled,
        };
        return { ...space, connectivity };
      })
    );

    try {
      const res = await apiFetch(
        `/api/spaces/${encodeURIComponent(targetId)}/connectivity`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            connectivity: {
              [sourceSpaceId]: enabled,
            },
          }),
        },
        localToken.trim()
      );
      if (!res.ok) throw new Error("Failed to update visibility.");
      const updated = (await res.json().catch(() => null)) as Space | null;
      if (updated && typeof updated.id === "string" && updated.id.trim()) {
        setSpaces((prev) => prev.map((space) => (space.id === updated.id ? { ...space, ...updated } : space)));
      }
      setMessage("Space visibility updated.");
    } catch (err) {
      setSpaces((prev) =>
        prev.map((space) => {
          if (space.id !== targetId) return space;
          const connectivity = {
            ...(space.connectivity && typeof space.connectivity === "object" ? space.connectivity : {}),
          };
          if (hadPrevious) connectivity[sourceSpaceId] = previous;
          else delete connectivity[sourceSpaceId];
          return { ...space, connectivity };
        })
      );
      setError(err instanceof Error ? err.message : "Failed to update visibility.");
    } finally {
      setSavingConnectivityKey(null);
    }
  };

  const cleanupSpaceTag = async (spaceId: string) => {
    const normalized = String(spaceId || "").trim();
    if (!normalized) return;
    if (readOnly) {
      setError("Token required to cleanup space tags.");
      return;
    }
    setCleanupSpaceId(normalized);
    setCleanupArmedSpaceId(null);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch(
        `/api/spaces/${encodeURIComponent(normalized)}/cleanup-tag`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
        localToken.trim()
      );
      if (!res.ok) throw new Error("Failed to cleanup space tags.");
      const payload = (await res.json().catch(() => null)) as
        | { updatedTopicCount?: number; removedTagCount?: number }
        | null;
      const updatedCount = Number(payload?.updatedTopicCount ?? 0);
      const removedCount = Number(payload?.removedTagCount ?? 0);
      setMessage(
        `Space tag removed from topics (${Number.isFinite(updatedCount) ? updatedCount : 0} topics, ${
          Number.isFinite(removedCount) ? removedCount : 0
        } tags removed).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cleanup space tags.");
    } finally {
      setCleanupSpaceId(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-wrap items-start gap-3">
          <div>
            <h2 className="text-lg font-semibold">Settings</h2>
            <p className="mt-1 text-sm text-[rgb(var(--claw-muted))]">
              Space visibility governs classifier retrieval, semantic search, graph traversal, and logger context injection.
            </p>
          </div>
          <Badge tone="accent2">Live</Badge>
        </CardHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Instance Name</label>
            <Input value={localTitle} onChange={(event) => setLocalTitle(event.target.value)} placeholder="Clawboard" />
          </div>
          <div>
            <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Integration</label>
            <Select value={localIntegration} onChange={(event) => setLocalIntegration(event.target.value as IntegrationLevel)}>
              <option value="manual">Manual only</option>
              <option value="write">Assistant can write</option>
              <option value="full">Full backfill</option>
            </Select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">API Base URL</label>
            <Input
              value={localApiBase}
              onChange={(event) => setLocalApiBase(event.target.value)}
              placeholder="http://localhost:8010"
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">API Token</label>
            <Input
              type="password"
              value={localToken}
              onChange={(event) => setLocalToken(event.target.value)}
              placeholder={tokenRequired ? "Token required" : "Optional"}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={saveGeneral} disabled={savingGeneral}>
            {savingGeneral ? "Saving..." : "Save settings"}
          </Button>
          {readOnly ? (
            <span className="text-xs text-[rgb(var(--claw-warning))]">
              Token required to apply write-side settings and space visibility changes.
            </span>
          ) : null}
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="p-0">
          <div className="border-b border-[rgb(var(--claw-border))] px-4 py-3">
            <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Space</div>
          </div>
          <div className="p-3 lg:hidden">
            <label className="mb-1 block text-xs uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">
              Selected space
            </label>
            <Select value={sourceSpaceId} onChange={(event) => setSourceSpaceId(event.target.value)}>
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name} ({topicCountBySpaceId.get(space.id) ?? 0})
                </option>
              ))}
            </Select>
          </div>
          <div className="hidden max-h-[56vh] overflow-auto p-2 lg:block">
            <div className="space-y-2">
              {spaces.map((space) => {
                const active = space.id === sourceSpaceId;
                return (
                  <button
                    key={space.id}
                    type="button"
                    onClick={() => setSourceSpaceId(space.id)}
                    className={cn(
                      "w-full rounded-[var(--radius-sm)] border px-3 py-2 text-left transition",
                      active
                        ? "border-[rgba(255,90,45,0.5)] bg-[rgba(255,90,45,0.14)]"
                        : "border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] hover:border-[rgba(255,90,45,0.32)]"
                    )}
                  >
                    <div className="truncate text-sm font-semibold">{space.name}</div>
                    <div className="truncate text-[10px] text-[rgb(var(--claw-muted))]">
                      {topicCountBySpaceId.get(space.id) ?? 0} topics
                    </div>
                    <div className="truncate font-mono text-[10px] text-[rgb(var(--claw-muted))]">{space.id}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </Card>

        <Card className="p-0">
          <div className="border-b border-[rgb(var(--claw-border))] px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">Where {sourceSpace?.name ?? "Selected space"} is visible</div>
              <Badge tone="muted">{targets.length} spaces</Badge>
            </div>
            <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
              These toggles control whether this selected space can be used from each other space for search, graph, classifier retrieval, and logger context injection.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone="muted">{sourceTopicCount} topics</Badge>
              {sourceSpaceId ? (
                cleanupArmedSpaceId === sourceSpaceId ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                      disabled={cleanupSpaceId === sourceSpaceId || readOnly}
                      onClick={() => {
                        void cleanupSpaceTag(sourceSpaceId);
                      }}
                    >
                      {cleanupSpaceId === sourceSpaceId ? "Cleaning..." : "Confirm delete tag"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cleanupSpaceId === sourceSpaceId}
                      onClick={() => setCleanupArmedSpaceId(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-[rgb(var(--claw-danger))]"
                    disabled={cleanupSpaceId === sourceSpaceId || readOnly}
                    onClick={() => setCleanupArmedSpaceId(sourceSpaceId)}
                  >
                    Delete tag from topics
                  </Button>
                )
              ) : null}
            </div>
          </div>
          <div className="p-3 sm:p-4">
            {targets.length === 0 ? (
              <p className="text-sm text-[rgb(var(--claw-muted))]">Create another tagged topic to configure cross-space visibility.</p>
            ) : (
              <div className="space-y-2.5">
                {targets.map((target) => {
                  const connectivity =
                    target.connectivity && typeof target.connectivity === "object"
                      ? target.connectivity
                      : {};
                  const hasExplicit = Object.prototype.hasOwnProperty.call(connectivity, sourceSpaceId);
                  const enabled = hasExplicit ? Boolean(connectivity[sourceSpaceId]) : true;
                  const key = `${target.id}:${sourceSpaceId}`;
                  return (
                    <div
                      key={target.id}
                      className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[rgb(var(--claw-border))] bg-[linear-gradient(145deg,rgba(25,30,38,0.78),rgba(14,17,23,0.74))] px-3 py-3 sm:px-4"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">
                          {target.name} <span className="text-[rgb(var(--claw-muted))]">({topicCountBySpaceId.get(target.id) ?? 0})</span>
                        </div>
                        <div className="truncate text-xs text-[rgb(var(--claw-muted))]">
                          {enabled ? "Can see this space" : "Blocked from this space"}
                        </div>
                        <div className="truncate font-mono text-[10px] text-[rgb(var(--claw-muted))]">{target.id}</div>
                      </div>
                      <SpaceSwitch
                        checked={enabled}
                        disabled={readOnly || savingConnectivityKey === key}
                        onToggle={() => {
                          void toggleVisibility(target.id, !enabled);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      </div>

      {error ? <p className="text-sm text-[rgb(var(--claw-danger))]">{error}</p> : null}
      {message ? <p className="text-sm text-[rgb(var(--claw-muted))]">{message}</p> : null}
    </div>
  );
}
