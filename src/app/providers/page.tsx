import { Badge, Card, CardHeader } from "@/components/ui";

export default function ProvidersPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Providers</h1>
          <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
            Add new inference providers to your OpenClaw instance with the fastest, safest path.
          </p>
        </div>
        <Badge tone="accent2">Savings</Badge>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Chutes (Recommended)</h2>
              <p className="text-sm text-[rgb(var(--claw-muted))]">
                Production-hardened Chutes x OpenClaw integration with atomic config and secure auth profiles.
              </p>
            </div>
            <Badge tone="success">Provider</Badge>
          </div>
        </CardHeader>
        <div className="space-y-5 text-sm text-[rgb(var(--claw-muted))]">
          <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
            <p className="text-[rgb(var(--claw-text))] font-semibold">Fast path (human-first bootstrap)</p>
            <p className="mt-2">
              These scripts are self-contained. They install OpenClaw if needed, add Chutes auth, configure the provider,
              and set the agent&apos;s primary model (no extra aliases).
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">macOS / Linux / WSL / Git Bash</div>
                <pre className="mt-2 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
{`curl -fsSL https://raw.githubusercontent.com/sirouk/Clawboard/main/inference-providers/add_chutes.sh | bash`}
                </pre>
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Windows (PowerShell + Git Bash/WSL)</div>
                <pre className="mt-2 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
{`iwr -useb https://raw.githubusercontent.com/sirouk/Clawboard/main/inference-providers/add_chutes.sh | bash`}
                </pre>
              </div>
            </div>
          </div>

          <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
            <p className="text-[rgb(var(--claw-text))] font-semibold">Agent-first (autonomous)</p>
            <p className="mt-2">Tell your OpenClaw instance:</p>
            <pre className="mt-3 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
{`Follow the instructions at skills/chutes/SKILL.md to set up Chutes.`}
            </pre>
          </div>
        </div>
      </Card>
    </div>
  );
}
