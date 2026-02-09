"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui";
import type { Topic } from "@/lib/types";
import { buildTopicUrl, UNIFIED_BASE } from "@/lib/url";
import { apiFetch } from "@/lib/api";

type ActionItem = {
  label: string;
  href: string;
  meta?: string;
};

const BASE_ACTIONS: ActionItem[] = [
  { label: "Board (Unified)", href: UNIFIED_BASE },
  { label: "Clawgraph", href: "/graph" },
  { label: "Dashboard (Legacy)", href: "/dashboard" },
  { label: "Stats", href: "/stats" },
  { label: "Providers", href: "/providers" },
  { label: "Setup", href: "/setup" },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [topics, setTopics] = useState<Topic[]>([]);

  useEffect(() => {
    if (!open) return;
    apiFetch("/api/topics", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setTopics(data);
        }
      })
      .catch(() => null);
  }, [open]);

  const actions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const topicActions = topics.map((topic) => ({
      label: `Topic: ${topic.name}`,
      href: buildTopicUrl(topic, topics),
      meta: "topic",
    }));
    const all = [...BASE_ACTIONS, ...topicActions];
    if (!normalized) return all;
    return all.filter((item) => item.label.toLowerCase().includes(normalized));
  }, [query, topics]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-24 backdrop-blur">
      <div className="w-full max-w-2xl rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel))] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-3">
          <Input
            autoFocus
            placeholder="Jump to a topic or page"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="mt-4 max-h-[60vh] overflow-y-auto">
          {actions.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No matches.</p>}
          <ul className="space-y-2">
            {actions.map((action) => (
              <li key={action.href}>
                <button
                  className="flex w-full items-center justify-between rounded-[var(--radius-md)] border border-transparent bg-[rgb(var(--claw-panel-2))] px-4 py-3 text-left text-sm transition hover:border-[rgba(255,90,45,0.4)]"
                  onClick={() => {
                    setOpen(false);
                    setQuery("");
                    router.push(action.href);
                  }}
                >
                  <span>{action.label}</span>
                  {action.meta && <span className="text-xs text-[rgb(var(--claw-muted))]">{action.meta}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
