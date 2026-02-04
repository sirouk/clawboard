"use client";

import { useMemo, useState } from "react";
import { Button, Input, Select, Badge, Card } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import type { IntegrationLevel } from "@/lib/types";
import { apiUrl, getApiBase } from "@/lib/api";

const STEPS = [
  { id: 1, title: "Instance", description: "Name your Clawboard and set integration depth." },
  { id: 2, title: "Token", description: "Store the API token locally for writes." },
  { id: 3, title: "OpenClaw Skill", description: "Install the skill and connect your agent." },
];

export function SetupWizard() {
  const { instanceTitle, setInstanceTitle, token, setToken, tokenRequired, integrationLevel, setIntegrationLevel } = useAppConfig();
  const [step, setStep] = useState(1);
  const [localTitle, setLocalTitle] = useState(instanceTitle);
  const [localIntegration, setLocalIntegration] = useState<IntegrationLevel>(integrationLevel);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, []);
  const apiBase = useMemo(() => getApiBase() || origin, [origin]);

  const connectionSnippet = useMemo(() => {
    const target = apiBase || "<clawboard-api-url>";
    const safeToken = token && token.trim().length > 0 ? token.trim() : "<optional-token>";
    const name = localTitle?.trim() || "Clawboard";
    const level = localIntegration || "manual";
    return `To connect OpenClaw to Clawboard, I need:
1) Clawboard API base URL (FastAPI, local or Tailscale). -> ${target}
2) Does the server require a write token? If yes, paste it. -> ${safeToken}
3) Instance display name. -> ${name}
4) Integration level: manual / write / full backfill. -> ${level}

Once I have those, I’ll validate /api/health and /api/config and start logging.`;
  }, [apiBase, localIntegration, localTitle, token]);

  const saveInstance = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(apiUrl("/api/config"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Clawboard-Token": token,
        },
        body: JSON.stringify({
          title: localTitle,
          integrationLevel: localIntegration,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to update instance. Add token if required.");
      }

      setInstanceTitle(localTitle);
      setIntegrationLevel(localIntegration);
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

  const skillInstallSnippet = `git clone https://github.com/sirouk/clawboard ~/clawboard
mkdir -p ~/.openclaw/skills
cp -R ~/clawboard/skills/clawboard ~/.openclaw/skills/clawboard`;

  const pluginInstallSnippet = `openclaw plugins install -l ~/clawboard/extensions/clawboard-logger
openclaw plugins enable clawboard-logger`;

  const pluginConfigSnippet = `"plugins": {
  "entries": {
    "clawboard-logger": {
      "enabled": true,
      "config": {
        "baseUrl": "${apiBase || "<clawboard-api-url>"}",
        "token": "${token && token.trim().length > 0 ? token.trim() : "YOUR_TOKEN"}"
      }
    }
  }
}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <Card className="p-4">
        <div className="space-y-4">
          {STEPS.map((item) => {
            const active = step === item.id;
            return (
              <button
                key={item.id}
                className={`w-full rounded-[var(--radius-md)] border px-4 py-3 text-left transition ${
                  active
                    ? "border-[rgba(226,86,64,0.5)] bg-[rgba(226,86,64,0.1)]"
                    : "border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))]"
                }`}
                onClick={() => setStep(item.id)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">Step {item.id}</span>
                  {active && <Badge tone="accent">Active</Badge>}
                </div>
                <div className="mt-2 text-sm">{item.title}</div>
                <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{item.description}</p>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="space-y-6">
        {step === 1 && (
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
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={saveInstance} disabled={saving}>
                {saving ? "Saving..." : "Save & continue"}
              </Button>
              <Button variant="secondary" onClick={() => setStep(2)}>
                Next
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">API Token</h2>
              <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">Store your API token once for write access.</p>
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
                {tokenRequired ? "Server requires a token for write operations." : "Token is optional for this server."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleTokenSave}>Save token locally</Button>
              <Button variant="secondary" onClick={() => setStep(3)}>
                Next
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl font-semibold">OpenClaw Skill</h2>
              <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
                Install the Clawboard skill in your OpenClaw instance and point it to this server.
              </p>
            </div>

            <div className="space-y-3">
              <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold">Clawboard API base URL</div>
                    <div className="text-xs text-[rgb(var(--claw-muted))]">FastAPI base URL used by OpenClaw.</div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => copyToClipboard(apiBase)}>
                    Copy
                  </Button>
                </div>
                <div className="mt-2 text-sm text-[rgb(var(--claw-text))]">{apiBase || "(set NEXT_PUBLIC_CLAWBOARD_API_BASE)"}</div>
              </div>

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
                  OpenClaw picks up new skills on the next turn.
                </p>
              </div>

              <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">Always‑on logger plugin (required)</div>
                  <Button size="sm" variant="secondary" onClick={() => copyToClipboard(pluginInstallSnippet)} aria-label="Copy logger plugin commands">
                    <span className="h-4 w-4">{clipboardIcon}</span>
                  </Button>
                </div>
                <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                  The plugin ensures every turn is logged even if the agent misses a tool call.
                </p>
                <pre className="mt-3 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
{pluginInstallSnippet}
                </pre>
                <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                  If you see <code>extracted package missing package.json</code>, update your repo: <code>cd ~/clawboard && git pull</code>.
                </p>
                <div className="mt-3 flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Plugin config</div>
                  <Button size="sm" variant="secondary" onClick={() => copyToClipboard(pluginConfigSnippet)} aria-label="Copy logger plugin config">
                    <span className="h-4 w-4">{clipboardIcon}</span>
                  </Button>
                </div>
                <pre className="mt-3 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
{pluginConfigSnippet}
                </pre>
                <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                  Use the same token as your API server&apos;s <code>CLAWBOARD_TOKEN</code>. If the server does not require a token,
                  remove the <code>token</code> field or leave it empty.
                </p>
              </div>

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
            </div>
          </div>
        )}

        {message && <p className="text-sm text-[rgb(var(--claw-muted))]">{message}</p>}
      </Card>
    </div>
  );
}
