"use client";

import { useMemo, useState } from "react";
import { Button, Input, Select, Badge, Card } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import type { IntegrationLevel } from "@/lib/types";
import { apiFetch, getApiBase, setApiBase } from "@/lib/api";
import { cn } from "@/lib/cn";

const STEPS = [
  { id: 1, title: "OpenClaw Skill", description: "Install the skill and connect your agent." },
  { id: 2, title: "Token", description: "Store the API token locally for authenticated access." },
  { id: 3, title: "Instance", description: "Name your Clawboard and set integration depth." },
];

export function SetupWizard() {
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
  const [step, setStep] = useState(1);
  const [skillTab, setSkillTab] = useState<"install" | "plugin" | "connect">("install");
  const [localTitle, setLocalTitle] = useState(instanceTitle);
  const [localIntegration, setLocalIntegration] = useState<IntegrationLevel>(integrationLevel);
  const [message, setMessage] = useState<string | null>(null);
  const [instanceSaved, setInstanceSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, []);
  const apiBase = useMemo(() => getApiBase() || origin, [origin]);
  const [localApiBase, setLocalApiBase] = useState(apiBase);

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

  const completedSteps: Record<number, boolean> = {
    1: step > 1,
    2: token.trim().length > 0 || step > 2,
    3: instanceSaved,
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
              <Button variant="secondary" onClick={() => setStep(2)}>
                Back to token
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
