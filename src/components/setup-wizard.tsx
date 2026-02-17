"use client";

import { useMemo, useState } from "react";
import { Button, Input, Select, Badge, Card } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { useDataStore } from "@/components/data-provider";
import type { IntegrationLevel, Space, Topic } from "@/lib/types";
import { apiFetch, getApiBase, setApiBase } from "@/lib/api";
import { cn } from "@/lib/cn";
import { getSpaceDefaultVisibility, resolveSpaceVisibilityFromViewer } from "@/lib/space-visibility";

const STEPS = [
  { id: 1, title: "OpenClaw Skill", description: "Install the skill and connect your agent." },
  { id: 2, title: "Token", description: "Store the API token locally for authenticated access." },
  { id: 3, title: "Instance", description: "Name your Clawboard and set integration depth." },
  { id: 4, title: "Spaces", description: "Control cross-space visibility for search, graph, and context." },
];

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

export function SetupWizard({ initialStep = 1 }: { initialStep?: number } = {}) {
  const {
    instanceTitle,
    setInstanceTitle,
    token,
    setToken,
    tokenRequired,
    tokenConfigured,
    remoteReadLocked,
    integrationLevel,
    setIntegrationLevel,
  } = useAppConfig();
  const { spaces: storeSpaces, topics: storeTopics, setSpaces } = useDataStore();
  const [step, setStep] = useState(() => {
    const safe = Number.isFinite(initialStep) ? Math.floor(initialStep) : 1;
    if (safe < 1) return 1;
    if (safe > STEPS.length) return STEPS.length;
    return safe;
  });
  const [skillTab, setSkillTab] = useState<"install" | "plugin" | "connect">("install");
  const [localTitle, setLocalTitle] = useState(instanceTitle);
  const [localIntegration, setLocalIntegration] = useState<IntegrationLevel>(integrationLevel);
  const [message, setMessage] = useState<string | null>(null);
  const [instanceSaved, setInstanceSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [spaceSavingKey, setSpaceSavingKey] = useState<string | null>(null);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const readOnly = tokenRequired && token.trim().length === 0;

  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, []);
  const apiBase = useMemo(() => getApiBase() || origin, [origin]);
  const [localApiBase, setLocalApiBase] = useState(apiBase);
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

  const connectionSnippet = useMemo(() => {
    const target = localApiBase || "<clawboard-api-url>";
    const safeToken = token && token.trim().length > 0 ? "<stored-local-token>" : "<required-token>";
    const name = localTitle?.trim() || "Clawboard";
    const level = localIntegration || "write";
    return `To connect OpenClaw to Clawboard, I need:
1) Clawboard API base URL (FastAPI, local or Tailscale). -> ${target}
2) Does the server require a write token? If yes, paste it. -> ${safeToken}
3) Instance display name. -> ${name}
4) Integration level: manual / write / full backfill. -> ${level}

Once I have those, I’ll validate /api/health and /api/config and start logging.`;
  }, [localApiBase, localIntegration, localTitle, token]);

  const saveInstance = async () => {
    setSaving(true);
    setMessage(null);
    try {
      if (localApiBase && localApiBase.trim().length > 0) {
        setApiBase(localApiBase);
      }
      const res = await apiFetch(
        "/api/config",
        {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: localTitle,
          integrationLevel: localIntegration,
        }),
        },
        token
      );

      if (!res.ok) {
        throw new Error("Failed to update instance. Add token if required.");
      }

      setInstanceTitle(localTitle);
      setIntegrationLevel(localIntegration);
      setInstanceSaved(true);
      setMessage("Saved. Instance updated.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  const handleTokenSave = () => {
    setToken(token.trim());
    setMessage("Token stored locally.");
  };

  const updateSpaceConnectivity = async (viewerSpaceId: string, visibleSpaceId: string, enabled: boolean) => {
    if (readOnly) {
      setSpaceError("Read-only mode. Add a token in Settings to update space visibility.");
      return;
    }
    const viewer = spaces.find((space) => space.id === viewerSpaceId);
    if (!viewer) return;
    const currentConnectivity =
      viewer.connectivity && typeof viewer.connectivity === "object" ? viewer.connectivity : {};
    const visibleSpace = spaces.find((space) => space.id === visibleSpaceId);
    const hadPrevious = Object.prototype.hasOwnProperty.call(currentConnectivity, visibleSpaceId);
    const previousEnabled = hadPrevious
      ? Boolean(currentConnectivity[visibleSpaceId])
      : getSpaceDefaultVisibility(visibleSpace);
    const saveKey = `${viewerSpaceId}:${visibleSpaceId}`;
    setSpaceSavingKey(saveKey);
    setSpaceError(null);
    setMessage(null);

    setSpaces((prev) =>
      prev.map((space) => {
        if (space.id !== viewerSpaceId) return space;
        const connectivity = {
          ...(space.connectivity && typeof space.connectivity === "object" ? space.connectivity : {}),
          [visibleSpaceId]: enabled,
        };
        return { ...space, connectivity };
      })
    );

    try {
      const res = await apiFetch(
        `/api/spaces/${encodeURIComponent(viewerSpaceId)}/connectivity`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            connectivity: {
              [visibleSpaceId]: enabled,
            },
          }),
        },
        token
      );
      if (!res.ok) {
        throw new Error("Failed to update space connectivity.");
      }
      const updated = (await res.json().catch(() => null)) as Space | null;
      if (updated && typeof updated.id === "string" && updated.id.trim()) {
        setSpaces((prev) => prev.map((space) => (space.id === updated.id ? { ...space, ...updated } : space)));
      }
      setMessage("Space visibility updated.");
    } catch (err) {
      setSpaces((prev) =>
        prev.map((space) => {
          if (space.id !== viewerSpaceId) return space;
          const connectivity = {
            ...(space.connectivity && typeof space.connectivity === "object" ? space.connectivity : {}),
          };
          if (hadPrevious) connectivity[visibleSpaceId] = previousEnabled;
          else delete connectivity[visibleSpaceId];
          return { ...space, connectivity };
        })
      );
      setSpaceError(err instanceof Error ? err.message : "Failed to update space connectivity.");
    } finally {
      setSpaceSavingKey(null);
    }
  };

  const completedSteps: Record<number, boolean> = {
    1: step > 1,
    2: token.trim().length > 0 || step > 2,
    3: instanceSaved,
    4: spaces.length > 0,
  };

  const copyToClipboard = async (value: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setMessage("Copied to clipboard.");
  };

  const clipboardIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4h6l1 2h3v14H5V6h3l1-2z" />
      <path d="M9 4h6v2H9z" />
    </svg>
  );

  const skillInstallSnippet = `# Choose where to keep the repo (optional):
# - export CLAWBOARD_DIR=/absolute/path/to/clawboard
# - export CLAWBOARD_PARENT_DIR=/absolute/path/to/projects (installs to .../clawboard)
CLAWBOARD_PARENT_DIR="${"$"}{CLAWBOARD_PARENT_DIR:-}"
CLAWBOARD_DIR="${"$"}{CLAWBOARD_DIR:-${"$"}{CLAWBOARD_PARENT_DIR:+${"$"}CLAWBOARD_PARENT_DIR/clawboard}}"
CLAWBOARD_DIR="${"$"}{CLAWBOARD_DIR:-${"$"}HOME/clawboard}"
git clone https://github.com/sirouk/clawboard "${"$"}CLAWBOARD_DIR"
mkdir -p ~/.openclaw/skills
cp -R "${"$"}CLAWBOARD_DIR/skills/clawboard" ~/.openclaw/skills/clawboard`;

  const pluginInstallSnippet = useMemo(() => {
    const baseUrl = (localApiBase || "<clawboard-api-url>").trim() || "<clawboard-api-url>";
    return `# Recommended: enable OpenResponses so attachments work (POST /v1/responses)
openclaw config set gateway.http.endpoints.responses.enabled --json true

# Install + enable the Clawboard logger plugin
openclaw plugins install -l "${"$"}CLAWBOARD_DIR/extensions/clawboard-logger"
openclaw plugins enable clawboard-logger

# Configure plugin (token should match server-side CLAWBOARD_TOKEN)
# contextMode options: auto | cheap | full | patient
openclaw config set plugins.entries.clawboard-logger.config --json '{
  "baseUrl":"${baseUrl}",
  "token":"<CLAWBOARD_TOKEN>",
  "enabled":true,
  "contextMode":"auto",
  "contextFallbackMode":"cheap",
  "contextFetchTimeoutMs":1200,
  "contextTotalBudgetMs":2200,
  "contextMaxChars":2200
}'
openclaw config set plugins.entries.clawboard-logger.enabled --json true

# Restart gateway to apply config
openclaw gateway restart`;
  }, [localApiBase]);

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <Card className="p-4">
        <div className="space-y-4">
          {STEPS.map((item) => {
            const active = step === item.id;
            const complete = completedSteps[item.id];
            return (
              <button
                key={item.id}
                className={cn(
                  "w-full rounded-[var(--radius-md)] border px-4 py-3 text-left transition",
                  active
                    ? "border-[rgba(226,86,64,0.5)] bg-[rgba(226,86,64,0.1)]"
                    : complete
                      ? "border-[rgba(80,200,120,0.45)] bg-[rgba(80,200,120,0.08)]"
                      : "border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))]"
                )}
                onClick={() => setStep(item.id)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">Step {item.id}</span>
                  {active ? <Badge tone="accent">Active</Badge> : complete ? <Badge tone="success">Done</Badge> : null}
                </div>
                <div className="mt-2 text-sm">{item.title}</div>
                <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{item.description}</p>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="space-y-6">
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">Instance Details</h2>
              <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">Give this Clawboard a name and choose integration depth.</p>
            </div>
            <div>
              <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Instance Name</label>
              <Input value={localTitle} onChange={(event) => setLocalTitle(event.target.value)} placeholder="Clawboard" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Integration Level</label>
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
              <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                Stored locally in your browser so you can switch Tailscale endpoints without rebuilding.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={saveInstance} disabled={saving}>
                {saving ? "Saving..." : "Save setup"}
              </Button>
              <Button variant="secondary" onClick={() => setStep(4)}>
                Space visibility
              </Button>
              <Button variant="secondary" onClick={() => setStep(2)}>
                Back to token
              </Button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">Space Visibility</h2>
              <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
                Spaces are derived from topic tags. Select a space, then control where that space is visible from other
                spaces for classifier retrieval, search, graph, and logger context injection.
              </p>
            </div>
            {readOnly ? (
              <p className="text-xs text-[rgb(var(--claw-warning))]">
                Read-only mode. Add a token in Settings to change visibility.
              </p>
            ) : null}
            {spaceError ? <p className="text-xs text-[rgb(var(--claw-danger))]">{spaceError}</p> : null}
            <div className="space-y-3">
              {spaces.map((selectedSpace) => {
                const targets = spaces.filter((target) => target.id !== selectedSpace.id);
                return (
                  <div
                    key={selectedSpace.id}
                    className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4"
                  >
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{selectedSpace.name}</div>
                        <div className="truncate font-mono text-[10px] text-[rgb(var(--claw-muted))]">{selectedSpace.id}</div>
                      </div>
                      <Badge tone="accent">{targets.length} spaces</Badge>
                    </div>
                    {targets.length === 0 ? (
                      <p className="text-xs text-[rgb(var(--claw-muted))]">
                        Create another tagged topic to enable cross-space controls.
                      </p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {targets.map((target) => {
                          const enabled = resolveSpaceVisibilityFromViewer(target, selectedSpace);
                          const saveKey = `${target.id}:${selectedSpace.id}`;
                          const disabled = readOnly || spaceSavingKey === saveKey;
                          return (
                            <label
                              key={target.id}
                              className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[rgb(var(--claw-border))] bg-[rgba(8,10,14,0.45)] px-3 py-2"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold">{target.name}</div>
                                <div className="truncate text-xs text-[rgb(var(--claw-muted))]">
                                  {enabled ? "Can see this space" : "Blocked from this space"}
                                </div>
                                <div className="truncate font-mono text-[10px] text-[rgb(var(--claw-muted))]">{target.id}</div>
                              </div>
                              <SpaceSwitch
                                checked={enabled}
                                disabled={disabled}
                                onToggle={() => {
                                  void updateSpaceConnectivity(target.id, selectedSpace.id, !enabled);
                                }}
                              />
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" onClick={() => setStep(3)}>
                Back to instance
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">API Token</h2>
              <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
                Store your API token once. Non-localhost reads and all writes require it.
              </p>
            </div>
            <div>
              <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Token</label>
              <Input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={tokenRequired ? "Token required" : "Optional token"}
              />
              <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                {tokenRequired
                  ? "Server requires a token for writes and for non-localhost reads."
                  : "Server currently allows unauthenticated reads."}
              </p>
              {remoteReadLocked && !token && (
                <p className="mt-2 text-xs text-[rgb(var(--claw-warning))]">
                  This connection is locked. Enter token to read data from this network.
                </p>
              )}
              {token && !tokenConfigured && (
                <p className="mt-2 text-xs text-[rgb(var(--claw-warning))]">
                  API server token is not configured yet. Set <code>CLAWBOARD_TOKEN</code> on the server.
                </p>
              )}
            </div>
            <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
              <div className="text-sm font-semibold">Connectivity indicators</div>
              <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                The header now shows icon-only status. Hover/tap for details.
              </p>
              <div className="mt-3 grid gap-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="inline-grid h-7 w-7 place-items-center rounded-full border border-[rgba(80,200,120,0.45)] bg-[rgba(80,200,120,0.12)] text-[rgb(var(--claw-success))]">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <path d="M13 2 5 13h6l-1 9 9-11h-6z" />
                    </svg>
                  </span>
                  <span>Token accepted. Read/write active.</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="inline-grid h-7 w-7 place-items-center rounded-full border border-[rgba(239,68,68,0.5)] bg-[rgba(239,68,68,0.12)] text-[rgb(var(--claw-danger))]">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <circle cx="12" cy="12" r="8.8" />
                      <path d="m9 9 6 6" />
                      <path d="m15 9-6 6" />
                    </svg>
                  </span>
                  <span>Token provided but rejected by API.</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="inline-grid h-7 w-7 place-items-center rounded-full border border-[rgba(234,179,8,0.46)] bg-[rgba(234,179,8,0.12)] text-[rgb(var(--claw-warning))]">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <circle cx="8.5" cy="12" r="3.5" />
                      <path d="M12 12h9" />
                      <path d="M18 12v3" />
                      <path d="M21 12v2" />
                    </svg>
                  </span>
                  <span>Token saved locally, but server-side token config is missing.</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="inline-grid h-7 w-7 place-items-center rounded-full border border-[rgba(234,179,8,0.46)] bg-[rgba(234,179,8,0.12)] text-[rgb(var(--claw-warning))]">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <rect x="4" y="11" width="16" height="10" rx="2.2" />
                      <path d="M8 11V8a4 4 0 1 1 8 0v3" />
                    </svg>
                  </span>
                  <span>Reads are allowed, but writes are blocked until token/auth passes.</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="inline-grid h-7 w-7 place-items-center rounded-full border border-[rgba(77,171,158,0.46)] bg-[rgba(77,171,158,0.12)] text-[rgb(var(--claw-accent-2))]">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <path d="M4 12h5" />
                      <path d="M15 12h5" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </span>
                  <span>No token is required on this server.</span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleTokenSave}>Save token locally</Button>
              <Button variant="secondary" onClick={() => setStep(3)} disabled={tokenRequired && token.trim().length === 0}>
                Continue to instance
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl font-semibold">OpenClaw Skill</h2>
              <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
                Install the Clawboard skill in your OpenClaw instance and point it to this server.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                className={cn(skillTab === "install" ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={() => setSkillTab("install")}
              >
                Install
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className={cn(skillTab === "plugin" ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={() => setSkillTab("plugin")}
              >
                Plugin config
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className={cn(skillTab === "connect" ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={() => setSkillTab("connect")}
              >
                Connect prompt
              </Button>
            </div>

            <div className="space-y-3">
              <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold">Clawboard API base URL</div>
                    <div className="text-xs text-[rgb(var(--claw-muted))]">FastAPI base URL used by OpenClaw.</div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => copyToClipboard(localApiBase)}>
                    Copy
                  </Button>
                </div>
                <div className="mt-2 text-sm text-[rgb(var(--claw-text))]">
                  {localApiBase || "(set NEXT_PUBLIC_CLAWBOARD_API_BASE)"}
                </div>
              </div>

              {skillTab === "install" && (
                <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Skill install</div>
                    <Button size="sm" variant="secondary" onClick={() => copyToClipboard(skillInstallSnippet)} aria-label="Copy skill install commands">
                      <span className="h-4 w-4">{clipboardIcon}</span>
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                    Clawhub is coming soon. For now, install manually.
                  </p>
                  <pre className="mt-3 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
{skillInstallSnippet}
                  </pre>
                  <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                    OpenClaw picks up new skills on the next turn. Important: the cloned repo and the installed skill
                    are different folders. OpenClaw reads the installed skill at <code>~/.openclaw/skills/clawboard</code>.
                    Editing <code>$CLAWBOARD_DIR/skills/clawboard</code> does not update the installed copy; re-copy the
                    skill (or rerun bootstrap) after changes.
                  </p>
                </div>
              )}

              {skillTab === "plugin" && (
                <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Always‑on logger plugin (required)</div>
                    <Button size="sm" variant="secondary" onClick={() => copyToClipboard(pluginInstallSnippet)} aria-label="Copy logger plugin commands">
                      <span className="h-4 w-4">{clipboardIcon}</span>
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                    Clawboard can queue messages even if OpenClaw is misconfigured, but without the plugin you will not
                    see assistant output and tool traces reliably.
                  </p>
                  <pre className="mt-3 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
{pluginInstallSnippet}
                  </pre>
                  <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                    If you see <code>extracted package missing package.json</code>, update your repo: <code>cd ${"$"}CLAWBOARD_DIR && git pull</code>.
                  </p>
                  <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                    Use the same token as your API server&apos;s <code>CLAWBOARD_TOKEN</code>. Keep it private: it grants write
                    access and non-localhost reads.
                  </p>
                </div>
              )}

              {skillTab === "connect" && (
                <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Connect prompt</div>
                    <Button size="sm" variant="secondary" onClick={() => copyToClipboard(connectionSnippet)}>
                      Copy
                    </Button>
                  </div>
                  <pre className="mt-3 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
{connectionSnippet}
                  </pre>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => setStep(2)}>I installed this - continue</Button>
            </div>
          </div>
        )}

        {message && <p className="text-sm text-[rgb(var(--claw-muted))]">{message}</p>}
      </Card>
    </div>
  );
}
