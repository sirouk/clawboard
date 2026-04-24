"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Select, Switch } from "@/components/ui";
import {
  DEFAULT_PRESET_CONFIG,
  normalizePresetConfig,
  parsePresetConfig,
  savePresetConfig,
  SnoozePresetEditor,
  SNOOZE_PRESET_CONFIG_KEY,
} from "@/components/snooze-modal";
import { useAppConfig } from "@/components/providers";
import { useDataStore } from "@/components/data-provider";
import { apiFetch, getApiBase, setApiBase } from "@/lib/api";
import { cn } from "@/lib/cn";
import { randomId } from "@/lib/id";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import { getSpaceDefaultVisibility } from "@/lib/space-visibility";
import { setPwaBadge, showPwaNotification, usePwaNotifications, usePwaBadging } from "@/lib/pwa-utils";
import { spaceIdFromTopicTagLabel } from "@/lib/topic-tags";
import type { IntegrationLevel, Space, Topic } from "@/lib/types";
import { normalizeHexColor, pickVibrantDistinctColor, TOPIC_FALLBACK_COLORS } from "@/components/unified-view";

const TEST_PWA_DELAY_MS = 3000;
const FOCUS_COMPOSER_ON_TOPIC_EXPAND_KEY = "clawboard.unified.focusComposerOnTopicExpand";

function deriveSpaceName(spaceId: string) {
  const normalized = String(spaceId || "").trim();
  if (!normalized || normalized === "space-default") return "Global";
  const base = normalized.replace(/^space[-_]+/i, "");
  const withSpaces = base.replace(/[-_]+/g, " ").trim();
  if (!withSpaces) return normalized;
  return withSpaces
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => {
      const token = String(segment ?? "").trim().toLowerCase();
      if (!token) return "";
      const devSuffix = token.match(/^([a-z]{2})dev$/);
      if (devSuffix) return `${devSuffix[1].toUpperCase()}Dev`;
      if (/^[a-z]{1,2}$/.test(token)) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
}

function friendlyLabelFromSlug(value: string) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  return slug
    .split("-")
    .filter(Boolean)
    .map((segment) => {
      const token = String(segment ?? "").trim().toLowerCase();
      if (!token) return "";
      const devSuffix = token.match(/^([a-z]{2})dev$/);
      if (devSuffix) return `${devSuffix[1].toUpperCase()}Dev`;
      if (/^[a-z]{1,2}$/.test(token)) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
}

function displaySpaceName(space: Pick<Space, "id" | "name">) {
  const id = String(space?.id ?? "").trim();
  const raw = String(space?.name ?? "").trim();
  if (!raw) return deriveSpaceName(id);
  const friendly = friendlyLabelFromSlug(raw);
  return friendly || deriveSpaceName(id);
}

async function readApiErrorMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json();
    const detail = typeof payload?.detail === "string" ? payload.detail.trim() : "";
    if (detail) return detail;
  } catch {
    // Ignore invalid JSON error payloads and fall back to the caller-provided message.
  }
  return fallback;
}

function spaceIdFromTagLabel(value: string) {
  return spaceIdFromTopicTagLabel(value);
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
      aria-label={checked ? "Visible" : "Hidden"}
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-8 w-14 flex-none items-center rounded-full border p-1 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(80,200,120,0.42)] disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-[rgba(166,255,201,0.88)] bg-[rgb(var(--claw-success))] shadow-[0_0_0_1px_rgba(80,200,120,0.25)]"
          : "border-[rgba(148,163,184,0.56)] bg-[rgba(17,22,30,0.96)]"
      )}
    >
      <span
        className={cn(
          "inline-flex h-6 w-6 items-center justify-center rounded-full border shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-transform duration-200",
          checked
            ? "translate-x-6 border-white/75 bg-[rgb(248,250,252)] text-[rgb(24,102,74)]"
            : "translate-x-0 border-[rgba(148,163,184,0.7)] bg-[rgb(226,232,240)] text-[rgb(71,85,105)]"
        )}
      >
        {checked ? (
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M4.5 10.5l3.1 3.1 7.9-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
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

  const {
    isSupported: pushSupported,
    permission: pushPermission,
    isEnabled: pushEnabled,
    isEnabling: pushEnabling,
    enableNotifications,
    toggleNotifications,
  } = usePwaNotifications();
  const { isSupported: badgeSupported } = usePwaBadging();

  const [localTitle, setLocalTitle] = useState(instanceTitle);
  const [localIntegration, setLocalIntegration] = useState<IntegrationLevel>(integrationLevel);
  const [localToken, setLocalToken] = useState(token);
  const [localApiBase, setLocalApiBase] = useState(() => getApiBase() || "");
  const [sourceSpaceId, setSourceSpaceId] = useState("");
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingConnectivityKey, setSavingConnectivityKey] = useState<string | null>(null);
  const [savingDefaultVisibility, setSavingDefaultVisibility] = useState(false);
  const [cleanupArmedSpaceId, setCleanupArmedSpaceId] = useState<string | null>(null);
  const [cleanupSpaceId, setCleanupSpaceId] = useState<string | null>(null);
  const [backfillArmed, setBackfillArmed] = useState(false);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testPwaPending, setTestPwaPending] = useState(false);
  const [testPwaStatus, setTestPwaStatus] = useState<string | null>(null);
  const testPwaTimerRef = useRef<number | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetRunning, setResetRunning] = useState(false);
  const [shufflingSpaceColors, setShufflingSpaceColors] = useState(false);

  const snoozePresetRaw = useLocalStorageItem(SNOOZE_PRESET_CONFIG_KEY);
  const snoozePreset = useMemo(() => parsePresetConfig(snoozePresetRaw), [snoozePresetRaw]);

  const showFullMessagesRaw = useLocalStorageItem("clawboard.display.showFullMessages");
  const showFullMessages = showFullMessagesRaw !== "false";
  const showToolCallsRaw = useLocalStorageItem("clawboard.display.showToolCalls");
  const showToolCallsSetting = showToolCallsRaw === "true";
  const focusComposerOnTopicExpandRaw = useLocalStorageItem(FOCUS_COMPOSER_ON_TOPIC_EXPAND_KEY);
  const focusComposerOnTopicExpand = focusComposerOnTopicExpandRaw !== "false";

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
      byId.set(id, { ...space, name: displaySpaceName(space) });
    }
    for (const topic of storeTopics) {
      for (const id of topicSpaceIds(topic)) {
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          name: deriveSpaceName(id),
          color: null,
          defaultVisible: true,
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
  useEffect(() => {
    return () => {
      if (testPwaTimerRef.current === null) return;
      window.clearTimeout(testPwaTimerRef.current);
      testPwaTimerRef.current = null;
    };
  }, []);

  const sourceSpace = useMemo(
    () => spaces.find((space) => space.id === sourceSpaceId) ?? null,
    [sourceSpaceId, spaces]
  );
  const targets = useMemo(() => spaces.filter((space) => space.id !== sourceSpaceId), [sourceSpaceId, spaces]);
  const defaultVisibilityVisible = useMemo(() => getSpaceDefaultVisibility(sourceSpace), [sourceSpace]);
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
            title: localTitle.trim() || "ClawBoard",
            integrationLevel: localIntegration,
          }),
        },
        localToken.trim()
      );
      if (!res.ok) throw new Error("Failed to update instance settings.");
      setInstanceTitle(localTitle.trim() || "ClawBoard");
      setIntegrationLevel(localIntegration);
      setToken(localToken.trim());
      setMessage("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setSavingGeneral(false);
    }
  };

  const startFullBackfillReplay = async () => {
    if (readOnly) {
      setError("Token required to start backfill replay.");
      return;
    }
    setBackfillRunning(true);
    setBackfillArmed(false);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch(
        "/api/admin/start-fresh-replay",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            integrationLevel: "full",
            replayMode: "reclassify",
          }),
        },
        localToken.trim()
      );
      const payload = (await res.json().catch(() => null)) as { detail?: unknown; resetAt?: unknown } | null;
      if (!res.ok) {
        const detail = payload?.detail;
        const message =
          typeof detail === "string" && detail.trim()
            ? detail.trim()
            : "Failed to start backfill replay.";
        throw new Error(message);
      }
      setIntegrationLevel("full");
      setLocalIntegration("full");
      const resetAt = typeof payload?.resetAt === "string" ? payload.resetAt.trim() : "";
      if (resetAt) {
        const stamp = Number.isNaN(Date.parse(resetAt)) ? resetAt : new Date(resetAt).toLocaleString();
        setMessage(
          `Backfill replay started (${stamp}). Existing topic links were preserved; unassigned or failed conversation logs are now pending for re-allocation.`
        );
      } else {
        setMessage(
          "Backfill replay started. Existing topic links were preserved; unassigned or failed conversation logs are now pending for re-allocation."
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start backfill replay.");
    } finally {
      setBackfillRunning(false);
    }
  };

  const toggleVisibility = async (targetId: string, enabled: boolean) => {
    if (!sourceSpaceId || !sourceSpace) return;
    if (readOnly) {
      setError("Token required to update space visibility.");
      return;
    }
    const key = `${sourceSpaceId}:${targetId}`;
    const currentConnectivity =
      sourceSpace.connectivity && typeof sourceSpace.connectivity === "object" ? sourceSpace.connectivity : {};
    const hadPrevious = Object.prototype.hasOwnProperty.call(currentConnectivity, targetId);
    const previous = hadPrevious ? Boolean(currentConnectivity[targetId]) : false;
    const previousUpdatedAt = String(sourceSpace.updatedAt ?? "");
    const optimisticUpdatedAt = new Date().toISOString();

    setSavingConnectivityKey(key);
    setError(null);
    setMessage(null);

    setSpaces((prev) =>
      prev.map((space) => {
        if (space.id !== sourceSpaceId) return space;
        const connectivity = {
          ...(space.connectivity && typeof space.connectivity === "object" ? space.connectivity : {}),
          [targetId]: enabled,
        };
        return { ...space, connectivity, updatedAt: optimisticUpdatedAt };
      })
    );

    try {
      const res = await apiFetch(
        `/api/spaces/${encodeURIComponent(sourceSpaceId)}/connectivity`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            connectivity: {
              [targetId]: enabled,
            },
          }),
        },
        localToken.trim()
      );
      if (!res.ok) throw new Error("Failed to update visibility.");
      const updated = (await res.json().catch(() => null)) as Space | null;
      if (updated && typeof updated.id === "string" && updated.id.trim()) {
        setSpaces((prev) => {
          let seen = false;
          const next = prev.map((space) => {
            if (space.id !== updated.id) return space;
            seen = true;
            return { ...space, ...updated };
          });
          if (seen) return next;
          return [updated, ...next];
        });
      }
      setMessage("Space visibility updated.");
    } catch (err) {
      setSpaces((prev) =>
        prev.map((space) => {
          if (space.id !== sourceSpaceId) return space;
          const connectivity = {
            ...(space.connectivity && typeof space.connectivity === "object" ? space.connectivity : {}),
          };
          if (hadPrevious) connectivity[targetId] = previous;
          else delete connectivity[targetId];
          return { ...space, connectivity, updatedAt: previousUpdatedAt || space.updatedAt };
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

  const applyDefaultVisibility = async (visible: boolean) => {
    if (!sourceSpaceId) return;
    if (readOnly) {
      setError("Token required to update space visibility.");
      return;
    }

    setSavingDefaultVisibility(true);
    setError(null);
    setMessage(null);

    const hadPrevious = typeof sourceSpace?.defaultVisible === "boolean";
    const previous = getSpaceDefaultVisibility(sourceSpace);
    const previousUpdatedAt = String(sourceSpace?.updatedAt ?? "");
    const optimisticUpdatedAt = new Date().toISOString();

    setSpaces((prev) =>
      prev.map((space) => {
        if (space.id !== sourceSpaceId) return space;
        return { ...space, defaultVisible: visible, updatedAt: optimisticUpdatedAt };
      })
    );

    try {
      const res = await apiFetch(
        `/api/spaces/${encodeURIComponent(sourceSpaceId)}/connectivity`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            defaultVisible: visible,
          }),
        },
        localToken.trim()
      );
      if (!res.ok) throw new Error("Failed to update default space visibility.");
      const updated = (await res.json().catch(() => null)) as Space | null;
      if (updated && typeof updated.id === "string" && updated.id.trim()) {
        const persisted = getSpaceDefaultVisibility(updated);
        if (persisted !== visible) {
          throw new Error("API did not persist default visibility policy. Restart the backend and retry.");
        }
        setSpaces((prev) => {
          let seen = false;
          const next = prev.map((space) => {
            if (space.id !== updated.id) return space;
            seen = true;
            return { ...space, ...updated };
          });
          if (seen) return next;
          return [updated, ...next];
        });
      }
      setMessage(`Default visibility for newly added spaces set to ${visible ? "Visible" : "Hidden"}.`);
    } catch (err) {
      setSpaces((prev) =>
        prev.map((space) => {
          if (space.id !== sourceSpaceId) return space;
          if (hadPrevious) return { ...space, defaultVisible: previous, updatedAt: previousUpdatedAt || space.updatedAt };
          return { ...space, defaultVisible: undefined, updatedAt: previousUpdatedAt || space.updatedAt };
        })
      );
      setError(err instanceof Error ? err.message : "Failed to update default space visibility.");
    } finally {
      setSavingDefaultVisibility(false);
    }
  };

  const queueTestPwaNotification = () => {
    if (testPwaPending) return;
    if (testPwaTimerRef.current !== null) {
      window.clearTimeout(testPwaTimerRef.current);
      testPwaTimerRef.current = null;
    }

    setTestPwaStatus(`Scheduled. Sending in ${Math.floor(TEST_PWA_DELAY_MS / 1000)} seconds...`);
    setTestPwaPending(true);

    testPwaTimerRef.current = window.setTimeout(() => {
      testPwaTimerRef.current = null;
      void (async () => {
        try {
          await setPwaBadge(1);
          const sent = await showPwaNotification(
            {
              title: "ClawBoard test ping",
              body: "This is your delayed test notification + badge.",
              tag: "clawboard-test-pwa",
              data: { url: "/settings" },
            },
            pushEnabled
          );
          if (!sent) {
            setTestPwaStatus("Could not send notification. Make sure push is allowed and granted.");
            return;
          }
          setTestPwaStatus("Test notification sent. Badge set to 1.");
        } catch {
          setTestPwaStatus("Failed to send test notification.");
        } finally {
          setTestPwaPending(false);
        }
      })();
    }, TEST_PWA_DELAY_MS);
  };

  const testPwaDisabled = testPwaPending || !pushSupported || pushPermission !== "granted" || !pushEnabled;

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
            <Input value={localTitle} onChange={(event) => setLocalTitle(event.target.value)} placeholder="ClawBoard" />
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

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-lg font-semibold">Display</h2>
            <p className="mt-1 text-sm text-[rgb(var(--claw-muted))]">
              Control how chat messages appear on the board.
            </p>
          </div>
        </CardHeader>
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <h3 className="text-sm font-semibold">Show Full Messages</h3>
              <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                Display the complete content of each chat message instead of a condensed summary.
              </p>
            </div>
            <div className="flex flex-none items-center">
              <Switch
                checked={showFullMessages}
                onCheckedChange={(checked) =>
                  setLocalStorageItem("clawboard.display.showFullMessages", checked ? "true" : "false")
                }
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-[rgb(var(--claw-border))] pt-6">
            <div className="flex-1">
              <h3 className="text-sm font-semibold">Show Tool Calls</h3>
              <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                Show tool call entries (code execution, file reads, API requests) in chat logs.
              </p>
            </div>
            <div className="flex flex-none items-center">
              <Switch
                checked={showToolCallsSetting}
                onCheckedChange={(checked) =>
                  setLocalStorageItem("clawboard.display.showToolCalls", checked ? "true" : "false")
                }
              />
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-lg font-semibold">Board Behavior</h2>
            <p className="mt-1 text-sm text-[rgb(var(--claw-muted))]">
              Tune how the board responds when you open topics and conversations.
            </p>
          </div>
        </CardHeader>
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <h3 className="text-sm font-semibold">Focus Composer On Topic Expand</h3>
              <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                When you expand a topic, jump straight into its topic chat message box. This matches the left-nav topic open flow.
              </p>
            </div>
            <div className="flex flex-none items-center">
              <Switch
                checked={focusComposerOnTopicExpand}
                onCheckedChange={(checked) =>
                  setLocalStorageItem(FOCUS_COMPOSER_ON_TOPIC_EXPAND_KEY, checked ? "true" : "false")
                }
              />
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-lg font-semibold">Space Colors</h2>
            <p className="mt-1 text-sm text-[rgb(var(--claw-muted))]">
              Assign a distinct vibrant color to each space. Colors appear in the sidebar and on the Space chip.
            </p>
          </div>
        </CardHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            {spaces.map((space) => {
              const color = normalizeHexColor(space.color) ?? "#4DA39E";
              return (
                <div key={space.id} className="flex items-center gap-2 rounded-full border border-[rgb(var(--claw-border))] px-3 py-1.5">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                  <span className="text-xs font-semibold text-[rgb(var(--claw-text))]">{space.name}</span>
                  <span className="font-mono text-[10px] text-[rgb(var(--claw-muted))]">{color}</span>
                </div>
              );
            })}
            {spaces.length === 0 && (
              <p className="text-xs text-[rgb(var(--claw-muted))]">No spaces found.</p>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={shufflingSpaceColors || readOnly || spaces.length === 0}
            onClick={async () => {
              setShufflingSpaceColors(true);
              setError(null);
              setMessage(null);
              try {
                const runSeed = randomId();
                const assigned: string[] = [];
                const usageCount = new Map<string, number>();
                const updates: Array<{ space: Space; color: string }> = [];
                for (const space of spaces) {
                  const color = pickVibrantDistinctColor({
                    palette: TOPIC_FALLBACK_COLORS,
                    seed: `${runSeed}:space:${space.id}:${space.name}`,
                    primaryAvoid: assigned,
                    secondaryAvoid: assigned,
                    usageCount,
                  });
                  const normalized = normalizeHexColor(color) ?? color;
                  assigned.push(normalized);
                  usageCount.set(normalized, (usageCount.get(normalized) ?? 0) + 1);
                  updates.push({ space, color: normalized });
                }
                const persisted = new Map<string, Space>();
                for (const { space, color } of updates) {
                  const res = await apiFetch(
                    "/api/spaces",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: space.id, name: space.name, color }),
                    },
                    localToken.trim()
                  );
                  if (!res.ok) {
                    throw new Error(await readApiErrorMessage(res, `Failed to persist color for ${space.name}.`));
                  }
                  const saved = (await res.json().catch(() => null)) as Space | null;
                  if (!saved || typeof saved.id !== "string" || !saved.id.trim()) {
                    throw new Error(`API returned an invalid space payload for ${space.name}.`);
                  }
                  persisted.set(saved.id, saved);
                }
                setSpaces((prev) => {
                  const next = prev.map((space) => persisted.get(space.id) ?? space);
                  for (const saved of persisted.values()) {
                    if (next.some((space) => space.id === saved.id)) continue;
                    next.push(saved);
                  }
                  return next;
                });
                setMessage("Space colors updated.");
              } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to update space colors.");
              } finally {
                setShufflingSpaceColors(false);
              }
            }}
          >
            {shufflingSpaceColors ? "Shuffling…" : "Shuffle Space Colors"}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-lg font-semibold">Snooze Shortcuts</h2>
            <p className="mt-1 text-sm text-[rgb(var(--claw-muted))]">
              Set the default return times for the snooze quick picks. Saved on this device.
            </p>
          </div>
        </CardHeader>
        <div className="space-y-4">
          <SnoozePresetEditor
            value={snoozePreset}
            onChange={(patch) => savePresetConfig(normalizePresetConfig({ ...snoozePreset, ...patch }))}
          />
          <div className="flex items-center gap-3 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => savePresetConfig(DEFAULT_PRESET_CONFIG)}
            >
              Reset to defaults
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader className="flex-wrap items-start gap-3">
          <div>
            <h2 className="text-lg font-semibold">Backfill Replay</h2>
            <p className="mt-1 text-sm text-[rgb(var(--claw-muted))]">
              Reclassify existing conversation logs and re-allocate them across current topics.
            </p>
          </div>
          <Badge tone={localIntegration === "full" ? "accent2" : "muted"}>{localIntegration === "full" ? "Full mode" : "Not full mode"}</Badge>
        </CardHeader>
        <div className="space-y-3 text-xs text-[rgb(var(--claw-muted))]">
          <p>
            Modes: <span className="text-[rgb(var(--claw-text))]">manual</span> (UI-first),{" "}
            <span className="text-[rgb(var(--claw-text))]">write</span> (live logging),{" "}
            <span className="text-[rgb(var(--claw-text))]">full</span> (write + replay/backfill workflows).
          </p>
          <p className="text-[rgb(var(--claw-muted))]">
            Default replay is non-destructive: existing topic links stay in place; only unassigned or failed conversation logs are re-queued.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {backfillArmed ? (
            <>
              <Button
                variant="secondary"
                disabled={backfillRunning || readOnly}
                onClick={() => {
                  void startFullBackfillReplay();
                }}
              >
                {backfillRunning ? "Starting..." : "Confirm backfill replay"}
              </Button>
              <Button variant="ghost" disabled={backfillRunning} onClick={() => setBackfillArmed(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              disabled={backfillRunning || readOnly}
              onClick={() => {
                setBackfillArmed(true);
              }}
            >
              Start backfill replay
            </Button>
          )}
          {readOnly ? (
            <span className="text-xs text-[rgb(var(--claw-warning))]">
              Token required to run admin replay actions.
            </span>
          ) : null}
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-[rgb(var(--claw-border))] px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Space visibility</h3>
              <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                Pick a source space on the left, then toggle which other spaces are visible from it.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="muted" className="rounded-full px-4 py-1.5 text-[11px] tracking-[0.16em]">
                {sourceTopicCount} topics
              </Badge>
              <Badge tone="muted" className="rounded-full px-4 py-1.5 text-[11px] tracking-[0.16em]">
                {targets.length} spaces
              </Badge>
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
              {sourceSpaceId ? (
                <div className="inline-flex items-center gap-2 rounded-full border border-[rgb(var(--claw-border))] bg-[rgba(16,21,29,0.72)] px-3 py-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[rgb(var(--claw-muted))]">
                    {defaultVisibilityVisible ? "Visible default for new spaces" : "Hidden default for new spaces"}
                  </span>
                  <SpaceSwitch
                    checked={defaultVisibilityVisible}
                    disabled={readOnly || savingDefaultVisibility || !sourceSpaceId}
                    onToggle={() => {
                      void applyDefaultVisibility(!defaultVisibilityVisible);
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid min-h-[22rem] grid-cols-2">
          <div className="min-w-0 border-r border-[rgb(var(--claw-border))]">
            <div className="border-b border-[rgb(var(--claw-border))] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[rgb(var(--claw-muted))] sm:px-4">
              Space
            </div>
            <div className="min-h-[20rem] max-h-[56vh] overflow-y-auto overflow-x-hidden p-3 sm:p-3.5">
              {spaces.length === 0 ? (
                <p className="rounded-[var(--radius-sm)] border border-[rgb(var(--claw-border))] px-3 py-3 text-xs text-[rgb(var(--claw-muted))]">
                  Create a tagged topic to configure space visibility.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {spaces.map((space) => {
                    const active = space.id === sourceSpaceId;
                    return (
                      <button
                        key={space.id}
                        type="button"
                        onClick={() => setSourceSpaceId(space.id)}
                        className={cn(
                          "w-full rounded-[12px] border px-3.5 py-3 text-left transition",
                          active
                            ? "border-[rgba(166,255,201,0.82)] bg-[linear-gradient(118deg,rgba(80,200,120,0.22),rgba(77,171,158,0.18))] shadow-[0_0_0_1px_rgba(80,200,120,0.15)]"
                            : "border-[rgb(var(--claw-border))] bg-[rgba(16,21,29,0.74)] hover:border-[rgba(148,163,184,0.52)]"
                        )}
                      >
                        <div
                          className={cn(
                            "truncate text-sm",
                            active ? "font-semibold text-[rgb(var(--claw-text))]" : "font-medium text-[rgb(var(--claw-text))]"
                          )}
                        >
                          {space.name}
                        </div>
                        <div className="truncate text-[10px] text-[rgb(var(--claw-muted))]">
                          {topicCountBySpaceId.get(space.id) ?? 0} topics
                        </div>
                        <div className="hidden truncate font-mono text-[10px] text-[rgb(var(--claw-muted))] sm:block">
                          {space.id}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0">
            <div className="border-b border-[rgb(var(--claw-border))] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[rgb(var(--claw-muted))] sm:px-4">
              Spaces visible from {sourceSpace?.name ?? "selected space"}
            </div>
            <div className="min-h-[20rem] max-h-[56vh] overflow-y-auto overflow-x-hidden p-3 sm:p-3.5">
              {targets.length === 0 ? (
                <p className="rounded-[var(--radius-sm)] border border-[rgb(var(--claw-border))] px-3 py-3 text-xs text-[rgb(var(--claw-muted))]">
                  Create another tagged topic to configure cross-space visibility.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {targets.map((target) => {
                    const sourceConnectivity =
                      sourceSpace?.connectivity && typeof sourceSpace.connectivity === "object"
                        ? sourceSpace.connectivity
                        : {};
                    const hasExplicit = Object.prototype.hasOwnProperty.call(sourceConnectivity, target.id);
                    const enabled = hasExplicit ? Boolean(sourceConnectivity[target.id]) : false;
                    const key = `${sourceSpaceId}:${target.id}`;
                    return (
                      <div
                        key={target.id}
                        className={cn(
                          "flex items-center justify-between gap-3 rounded-[12px] border px-3.5 py-3 transition",
                          enabled
                            ? "border-[rgba(80,200,120,0.38)] bg-[rgba(28,46,37,0.42)]"
                            : "border-[rgb(var(--claw-border))] bg-[rgba(16,21,29,0.74)]"
                        )}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-[rgb(var(--claw-text))]">
                            {target.name} <span className="text-[rgb(var(--claw-muted))]">({topicCountBySpaceId.get(target.id) ?? 0})</span>
                          </div>
                          <div
                            className={cn(
                              "inline-flex items-center gap-1.5 truncate text-[11px] font-medium",
                              enabled ? "text-[rgb(var(--claw-success))]" : "text-[rgb(var(--claw-muted))]"
                            )}
                          >
                            <span
                              className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                enabled ? "bg-[rgb(var(--claw-success))]" : "bg-[rgb(var(--claw-muted))]"
                              )}
                            />
                            {enabled ? "Visible" : "Hidden"}
                          </div>
                          <div className="hidden truncate font-mono text-[10px] text-[rgb(var(--claw-muted))] sm:block">
                            {target.id}
                          </div>
                        </div>
                        <div className="flex flex-none items-center">
                          <SpaceSwitch
                            checked={enabled}
                            disabled={readOnly || savingConnectivityKey === key}
                            onToggle={() => {
                              void toggleVisibility(target.id, !enabled);
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>

      {error ? <p className="text-sm text-[rgb(var(--claw-danger))]">{error}</p> : null}
      {message ? <p className="text-sm text-[rgb(var(--claw-muted))]">{message}</p> : null}

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-lg font-semibold">PWA Enhancements</h2>
            <p className="mt-1 text-sm text-[rgb(var(--claw-muted))]">
              Configure notifications and badging for your Home Screen app.
            </p>
          </div>
          <Badge tone={pushSupported ? "success" : "warning"}>
            {pushSupported ? "Supported" : "Not Supported"}
          </Badge>
        </CardHeader>
        
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <h3 className="text-sm font-semibold">Enable Notifications</h3>
              <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                Request permission to send notifications when the app is in the background.
              </p>
              {pushPermission === "denied" && (
                <p className="mt-2 text-xs text-[rgb(var(--claw-danger))]">
                  Notifications are blocked. Please enable them in your device settings.
                </p>
              )}
            </div>
            <div className="flex flex-none items-center gap-3">
              {pushPermission === "granted" ? (
                <Badge tone="success">Granted</Badge>
              ) : (
                <Button 
                  size="sm" 
                  disabled={!pushSupported || pushPermission === "denied" || pushEnabling}
                  onClick={enableNotifications}
                >
                  {pushEnabling ? "Enabling..." : "Enable"}
                </Button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-[rgb(var(--claw-border))] pt-6">
            <div className="flex-1">
              <h3 className="text-sm font-semibold">Allow Push Notifications</h3>
              <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                Globally enable or disable notifications from ClawBoard.
              </p>
            </div>
            <div className="flex flex-none items-center">
              <Switch
                checked={pushEnabled}
                disabled={!pushSupported || pushPermission !== "granted"}
                onCheckedChange={toggleNotifications}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-[rgb(var(--claw-border))] pt-6">
            <div className="flex-1">
              <h3 className="text-sm font-semibold">Unread Badge Count</h3>
              <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                Show unread topic chat replies plus unsnoozed topics on the app icon badge.
              </p>
            </div>
            <div className="flex flex-none items-center">
              <Badge tone={badgeSupported ? "success" : "warning"}>
                {badgeSupported ? "Supported" : "Not Supported"}
              </Badge>
            </div>
          </div>

          <div className="border-t border-[rgb(var(--claw-border))] pt-6">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <h3 className="text-sm font-semibold">Test Notification + Badge</h3>
                <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                  Click once to send a test notification and badge after 3 seconds.
                  Native badge API is preferred; unsupported clients fall back to title count.
                </p>
                {testPwaStatus ? (
                  <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">{testPwaStatus}</p>
                ) : null}
              </div>
              <div className="flex flex-none items-center">
                <Button size="sm" disabled={testPwaDisabled} onClick={queueTestPwaNotification}>
                  {testPwaPending ? "Queued..." : "Send test in 3s"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-lg font-semibold">Reset Local Data</h2>
            <p className="mt-1 text-sm text-[rgb(var(--claw-muted))]">
              Clear all local storage, IndexedDB caches, and reload to re-sync from the server.
              Your remote data is not affected.
            </p>
          </div>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          {!resetArmed ? (
            <Button
              variant="secondary"
              onClick={() => setResetArmed(true)}
              disabled={resetRunning}
            >
              Reset local data…
            </Button>
          ) : (
            <>
              <Button
                disabled={resetRunning}
                onClick={async () => {
                  setResetRunning(true);
                  const deleteIdb = (name: string) =>
                    new Promise<void>((resolve) => {
                      try {
                        const req = window.indexedDB.deleteDatabase(name);
                        req.onsuccess = () => resolve();
                        req.onerror = () => resolve();
                        req.onblocked = () => resolve();
                      } catch {
                        resolve();
                      }
                    });
                  try {
                    window.localStorage.clear();
                    window.sessionStorage.clear();
                    // Delete known databases by name (works everywhere)
                    await Promise.allSettled([
                      deleteIdb("clawboard-board-cache"),
                      deleteIdb("clawboard-write-queue"),
                    ]);
                    // Also enumerate and delete any others if the API is available
                    if (typeof window.indexedDB.databases === "function") {
                      try {
                        const dbs = await window.indexedDB.databases();
                        await Promise.allSettled(
                          dbs
                            .map((db) => db.name)
                            .filter((name): name is string => Boolean(name))
                            .map(deleteIdb)
                        );
                      } catch {
                        // databases() not supported — known DBs already deleted above
                      }
                    }
                    // Clear Cache API (service worker caches)
                    if (typeof caches !== "undefined") {
                      try {
                        const keys = await caches.keys();
                        await Promise.allSettled(keys.map((key) => caches.delete(key)));
                      } catch {
                        // ok
                      }
                    }
                    // Unregister service workers
                    if (navigator.serviceWorker) {
                      try {
                        const registrations = await navigator.serviceWorker.getRegistrations();
                        await Promise.allSettled(registrations.map((r) => r.unregister()));
                      } catch {
                        // ok
                      }
                    }
                  } catch (err) {
                    console.error("Reset failed:", err);
                  }
                  window.location.replace("/u");
                }}
              >
                {resetRunning ? "Resetting…" : "Confirm reset & reload"}
              </Button>
              <Button variant="secondary" onClick={() => setResetArmed(false)} disabled={resetRunning}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
