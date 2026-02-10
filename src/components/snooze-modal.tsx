"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/cn";

type SnoozePreset = {
  id: "tonight" | "tomorrow" | "weekend" | "nextWeek";
  label: string;
  description: string;
  until: (now: Date) => Date;
};

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function toLocalDateInput(value: Date) {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function toLocalTimeInput(value: Date) {
  return `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
}

function parseLocalDateTime(dateText: string, timeText: string) {
  const [yRaw, mRaw, dRaw] = (dateText || "").split("-");
  const [hhRaw, mmRaw] = (timeText || "").split(":");
  const y = Number(yRaw);
  const m = Number(mRaw);
  const d = Number(dRaw);
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt;
}

function formatUntilLabel(value: Date) {
  try {
    return value.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return value.toISOString();
  }
}

const PRESETS: SnoozePreset[] = [
  {
    id: "tonight",
    label: "Tonight",
    description: "8:00 PM",
    until: (now) => {
      const d = new Date(now);
      d.setHours(20, 0, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d;
    },
  },
  {
    id: "tomorrow",
    label: "Tomorrow",
    description: "9:00 AM",
    until: (now) => {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    id: "weekend",
    label: "This weekend",
    description: "Sat 9:00 AM",
    until: (now) => {
      const d = new Date(now);
      const day = d.getDay(); // 0..6
      const untilSaturday = (6 - day + 7) % 7;
      d.setDate(d.getDate() + untilSaturday);
      d.setHours(9, 0, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 7);
      return d;
    },
  },
  {
    id: "nextWeek",
    label: "Next week",
    description: "Mon 9:00 AM",
    until: (now) => {
      const d = new Date(now);
      const day = d.getDay(); // 0..6
      let untilMonday = (1 - day + 7) % 7;
      if (untilMonday === 0) untilMonday = 7;
      d.setDate(d.getDate() + untilMonday);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
];

export function SnoozeModal({
  open,
  title,
  subtitle,
  entityLabel,
  onClose,
  onSnooze,
}: {
  open: boolean;
  title: string;
  subtitle?: string | null;
  entityLabel?: string | null;
  onClose: () => void;
  onSnooze: (untilIso: string) => Promise<void> | void;
}) {
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("09:00");
  const [customError, setCustomError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setSaving(false);
    setSaveError(null);
    setCustomError(null);
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    setCustomDate(toLocalDateInput(tomorrow));
    setCustomTime(toLocalTimeInput(tomorrow));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, open]);

  const customUntil = useMemo(() => {
    const dt = parseLocalDateTime(customDate, customTime);
    if (!dt) return null;
    if (dt.getTime() <= Date.now()) return null;
    return dt;
  }, [customDate, customTime]);

  const submit = async (until: Date) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSnooze(until.toISOString());
      if (!mountedRef.current) return;
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to snooze.";
      if (!mountedRef.current) return;
      setSaveError(message);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-4 pb-5 pt-12 backdrop-blur md:items-center md:pb-12 md:pt-24"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "w-full max-w-lg overflow-hidden rounded-t-[28px] border border-[rgba(255,255,255,0.14)] bg-[radial-gradient(circle_at_16%_18%,rgba(77,171,158,0.22),transparent_54%),radial-gradient(circle_at_84%_26%,rgba(226,86,64,0.18),transparent_56%),rgba(12,14,18,0.94)] shadow-[0_24px_90px_rgba(0,0,0,0.65)]",
          "md:rounded-[28px]"
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[rgba(255,255,255,0.10)] px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[rgba(148,163,184,0.9)]">
              {title}
            </div>
            {entityLabel ? <div className="mt-1 truncate text-base font-semibold text-[rgb(var(--claw-text))]">{entityLabel}</div> : null}
            {subtitle ? (
              <div className="mt-1 text-xs text-[rgba(148,163,184,0.92)]">{subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[rgba(255,255,255,0.14)] text-[rgb(var(--claw-muted))] transition hover:border-[rgba(255,90,45,0.35)] hover:text-[rgb(var(--claw-text))]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[72vh] overflow-y-auto px-5 py-4 md:max-h-[70vh]">
          <div className="grid gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={saving}
                onClick={() => {
                  const now = new Date();
                  void submit(preset.until(now));
                }}
                className={cn(
                  "group flex w-full items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[rgba(255,255,255,0.12)] bg-[rgba(20,24,31,0.78)] px-4 py-3 text-left transition",
                  "hover:border-[rgba(77,171,158,0.45)] hover:bg-[rgba(20,24,31,0.92)]",
                  "disabled:cursor-not-allowed disabled:opacity-60"
                )}
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[rgb(var(--claw-text))]">{preset.label}</div>
                  <div className="mt-0.5 text-xs text-[rgba(148,163,184,0.9)]">{preset.description}</div>
                </div>
                <div className="shrink-0 text-xs font-semibold uppercase tracking-[0.18em] text-[rgba(77,171,158,0.95)] transition group-hover:text-[rgb(var(--claw-accent-2))]">
                  {saving ? "..." : formatUntilLabel(preset.until(new Date()))}
                </div>
              </button>
            ))}
          </div>

          <div className="mt-5 rounded-[var(--radius-lg)] border border-[rgba(255,255,255,0.12)] bg-[rgba(10,12,16,0.32)] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[rgba(148,163,184,0.9)]">
              Pick a date & time
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs text-[rgb(var(--claw-muted))]">Date</div>
                <Input
                  type="date"
                  value={customDate}
                  onChange={(event) => {
                    setCustomDate(event.target.value);
                    setCustomError(null);
                  }}
                  disabled={saving}
                  className="h-10"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-[rgb(var(--claw-muted))]">Time</div>
                <Input
                  type="time"
                  value={customTime}
                  onChange={(event) => {
                    setCustomTime(event.target.value);
                    setCustomError(null);
                  }}
                  disabled={saving}
                  className="h-10"
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-[rgba(148,163,184,0.92)]">
                {customUntil ? `Snooze until ${formatUntilLabel(customUntil)}` : "Choose a future date/time."}
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  if (!customUntil) {
                    setCustomError("Pick a future date/time.");
                    return;
                  }
                  void submit(customUntil);
                }}
              >
                {saving ? "Snoozing..." : "Snooze"}
              </Button>
            </div>
            {(customError || saveError) ? (
              <div className="mt-2 text-xs text-[rgb(var(--claw-warning))]">{customError ?? saveError}</div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[rgba(255,255,255,0.10)] px-5 py-4">
          <div className="text-xs text-[rgba(148,163,184,0.9)]">{saving ? "Saving…" : ""}</div>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

