"use client";

import { useState } from "react";
import { Badge, Button, Card, CardHeader } from "@/components/ui";
import { cn } from "@/lib/cn";

const HUMAN_UNIX_COMMAND = "curl -fsSL https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh | bash";
const HUMAN_WINDOWS_COMMAND = "iwr -useb https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh | bash";
const AGENT_PROMPT = "Follow the instructions at skills/chutes/SKILL.md to set up Chutes.";

export default function ProvidersPage() {
  const [message, setMessage] = useState<string | null>(null);
  const [unlockedBlocks, setUnlockedBlocks] = useState<Record<string, boolean>>({});

  const unlockOverflow = (key: string) => {
    setUnlockedBlocks((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  };

  const codeBlockClass = (key: string) =>
    cn(
      "mt-2 rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))] claw-scrollbar-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(255,90,45,0.4)]",
      unlockedBlocks[key]
        ? "overflow-x-auto whitespace-pre"
        : "claw-truncate-fade overflow-hidden whitespace-nowrap text-ellipsis cursor-pointer select-none"
    );

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("Copied to clipboard.");
    } catch {
      setMessage("Clipboard unavailable. Copy manually.");
    }
  };

		return (
		  <div className="space-y-6">
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

        <div className="grid gap-5 xl:grid-cols-2">
          <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[rgb(var(--claw-text))] font-semibold">I&apos;m setting this up manually</p>
              <Badge tone="accent2">Human</Badge>
            </div>
            <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
              Run one command and the bootstrap script configures provider auth and default model mapping.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                  <div className="flex items-center justify-between gap-2">
                  <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">macOS / Linux / WSL / Git Bash</div>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label="Copy unix setup command"
                    onClick={() => void copyToClipboard(HUMAN_UNIX_COMMAND)}
                  >
                    Copy
                  </Button>
                </div>
                <pre
                  className={codeBlockClass("human-unix")}
                  tabIndex={0}
                  role="textbox"
                  aria-label="Manual setup command"
                  onClick={() => unlockOverflow("human-unix")}
                >{HUMAN_UNIX_COMMAND}</pre>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Windows (PowerShell + Git Bash/WSL)</div>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label="Copy windows setup command"
                    onClick={() => void copyToClipboard(HUMAN_WINDOWS_COMMAND)}
                  >
                    Copy
                  </Button>
                </div>
                <pre
                  className={codeBlockClass("human-windows")}
                  tabIndex={0}
                  role="textbox"
                  aria-label="Windows setup command"
                  onClick={() => unlockOverflow("human-windows")}
                >{HUMAN_WINDOWS_COMMAND}</pre>
              </div>
            </div>
          </div>

          <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[rgb(var(--claw-text))] font-semibold">I want OpenClaw to do it</p>
              <Badge tone="accent">Agent</Badge>
            </div>
            <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
              Give your main agent this instruction and let it perform the provider install autonomously.
            </p>
            <div className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Prompt</div>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="Copy agent prompt"
                  onClick={() => void copyToClipboard(AGENT_PROMPT)}
                >
                  Copy
                </Button>
              </div>
              <pre
                className={codeBlockClass("agent-prompt")}
                tabIndex={0}
                role="textbox"
                aria-label="Agent prompt"
                onClick={() => unlockOverflow("agent-prompt")}
              >{AGENT_PROMPT}</pre>
            </div>
          </div>
        </div>
      </Card>

      {message && <p className="text-sm text-[rgb(var(--claw-muted))]">{message}</p>}
    </div>
  );
}
