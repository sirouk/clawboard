"use client";

import { cn } from "@/lib/cn";

export type SlashCommand = {
  name: string;
  description: string;
  kind: "cmd" | "skill";
};

type ChatSuggestionsProps = {
  suggestions: SlashCommand[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  className?: string;
};

export function ChatSuggestions({
  suggestions,
  selectedIndex,
  onSelect,
  className,
}: ChatSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div
      className={cn(
        "absolute left-2 right-2 bottom-full z-50 mb-2 overflow-hidden rounded-[var(--radius-md)] border",
        "border-[rgba(255,255,255,0.14)] bg-[rgba(8,10,14,0.96)] shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-200",
        className
      )}
    >
      <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] border-b border-[rgba(255,255,255,0.06)]">
        Slash commands
      </div>
      <div className="max-h-64 overflow-y-auto overscroll-contain py-1">
        {suggestions.map((cmd, idx) => (
          <button
            key={`${cmd.kind}-${cmd.name}`}
            type="button"
            className={cn(
              "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors",
              idx === selectedIndex 
                ? "bg-[rgba(255,90,45,0.2)] text-[rgb(var(--claw-text))]" 
                : "text-[rgb(var(--claw-muted))] hover:bg-[rgba(255,255,255,0.04)] hover:text-[rgb(var(--claw-text))]"
            )}
            onMouseDown={(e) => {
              // Prevent textarea blur
              e.preventDefault();
              onSelect(idx);
            }}
          >
            <div className="flex flex-1 flex-col min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "font-mono text-sm font-semibold",
                  idx === selectedIndex ? "text-[rgb(var(--claw-accent))]" : ""
                )}>
                  /{cmd.name}
                </span>
              </div>
              {cmd.description ? (
                <span className="truncate text-xs opacity-80 mt-0.5">
                  {cmd.description}
                </span>
              ) : null}
            </div>
            <span className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] border",
              cmd.kind === "skill" 
                ? "border-[rgba(77,171,158,0.4)] text-[rgb(var(--claw-accent-2))]" 
                : "border-[rgba(255,255,255,0.1)] text-[rgb(var(--claw-muted))]"
            )}>
              {cmd.kind === "skill" ? "skill" : "core"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
