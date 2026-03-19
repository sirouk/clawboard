"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { cn } from "@/lib/cn";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";

type SnoozePresetId = "tonight" | "tomorrow" | "weekend" | "nextWeek";

type SnoozePreset = {
  id: SnoozePresetId;
  label: string;
  description: string;
  detail: string;
  until: Date;
};

type SnoozePresetConfig = {
  tonightTime: string;
  tomorrowTime: string;
  weekendDay: number;
  weekendTime: string;
  nextWeekDay: number;
  nextWeekTime: string;
};

type TimeParts = {
  hours: number;
  minutes: number;
};

const SNOOZE_PRESET_CONFIG_KEY = "clawboard.snoozePresetConfig";

const DEFAULT_PRESET_CONFIG: SnoozePresetConfig = {
  tonightTime: "20:00",
  tomorrowTime: "09:00",
  weekendDay: 6,
  weekendTime: "09:00",
  nextWeekDay: 1,
  nextWeekTime: "09:00",
};

const WEEKDAY_OPTIONS = [
  { value: 0, short: "Sun", long: "Sunday" },
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
] as const;

const WEEKEND_DAY_OPTIONS = WEEKDAY_OPTIONS.filter((option) => option.value === 6 || option.value === 0);
const NEXT_WEEK_DAY_OPTIONS = WEEKDAY_OPTIONS.filter(
  (option) => option.value === 1 || option.value === 2 || option.value === 3 || option.value === 4 || option.value === 5
);

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

function parseTimeInput(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec((value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes } satisfies TimeParts;
}

function normalizeTimeInput(value: unknown, fallback: string) {
  const safeValue = typeof value === "string" ? value.trim() : "";
  return parseTimeInput(safeValue) ? safeValue : fallback;
}

function normalizeWeekday(value: unknown, allowedDays: readonly number[], fallback: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  return allowedDays.includes(numeric) ? numeric : fallback;
}

function normalizePresetConfig(value: unknown): SnoozePresetConfig {
  const raw = value && typeof value === "object" ? (value as Partial<SnoozePresetConfig>) : {};
  return {
    tonightTime: normalizeTimeInput(raw.tonightTime, DEFAULT_PRESET_CONFIG.tonightTime),
    tomorrowTime: normalizeTimeInput(raw.tomorrowTime, DEFAULT_PRESET_CONFIG.tomorrowTime),
    weekendDay: normalizeWeekday(
      raw.weekendDay,
      WEEKEND_DAY_OPTIONS.map((option) => option.value),
      DEFAULT_PRESET_CONFIG.weekendDay
    ),
    weekendTime: normalizeTimeInput(raw.weekendTime, DEFAULT_PRESET_CONFIG.weekendTime),
    nextWeekDay: normalizeWeekday(
      raw.nextWeekDay,
      NEXT_WEEK_DAY_OPTIONS.map((option) => option.value),
      DEFAULT_PRESET_CONFIG.nextWeekDay
    ),
    nextWeekTime: normalizeTimeInput(raw.nextWeekTime, DEFAULT_PRESET_CONFIG.nextWeekTime),
  };
}

function parsePresetConfig(raw: string | null) {
  if (!raw) return DEFAULT_PRESET_CONFIG;
  try {
    return normalizePresetConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_PRESET_CONFIG;
  }
}

function applyTime(value: Date, timeText: string, fallback: string) {
  const dt = new Date(value);
  const time = parseTimeInput(timeText) ?? parseTimeInput(fallback);
  if (!time) return dt;
  dt.setHours(time.hours, time.minutes, 0, 0);
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

function formatTimeLabel(timeText: string) {
  const parts = parseTimeInput(timeText);
  if (!parts) return timeText;
  const dt = new Date(2000, 0, 1, parts.hours, parts.minutes, 0, 0);
  try {
    return dt.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return `${pad2(parts.hours)}:${pad2(parts.minutes)}`;
  }
}

function weekdayLong(day: number) {
  return WEEKDAY_OPTIONS.find((option) => option.value === day)?.long ?? "Day";
}

function buildSnoozePresets(now: Date, config: SnoozePresetConfig): SnoozePreset[] {
  const tonight = applyTime(now, config.tonightTime, DEFAULT_PRESET_CONFIG.tonightTime);
  if (tonight.getTime() <= now.getTime()) tonight.setDate(tonight.getDate() + 1);

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowUntil = applyTime(tomorrow, config.tomorrowTime, DEFAULT_PRESET_CONFIG.tomorrowTime);

  const weekend = new Date(now);
  const untilWeekendDay = (config.weekendDay - weekend.getDay() + 7) % 7;
  weekend.setDate(weekend.getDate() + untilWeekendDay);
  const weekendUntil = applyTime(weekend, config.weekendTime, DEFAULT_PRESET_CONFIG.weekendTime);
  if (weekendUntil.getTime() <= now.getTime()) weekendUntil.setDate(weekendUntil.getDate() + 7);

  const nextWeek = new Date(now);
  let untilNextMonday = (1 - nextWeek.getDay() + 7) % 7;
  if (untilNextMonday === 0) untilNextMonday = 7;
  nextWeek.setDate(nextWeek.getDate() + untilNextMonday);
  nextWeek.setDate(nextWeek.getDate() + ((config.nextWeekDay - 1 + 7) % 7));
  const nextWeekUntil = applyTime(nextWeek, config.nextWeekTime, DEFAULT_PRESET_CONFIG.nextWeekTime);

  return [
    {
      id: "tonight",
      label: "Tonight",
      description: `Today at ${formatTimeLabel(config.tonightTime)}`,
      detail: formatUntilLabel(tonight),
      until: tonight,
    },
    {
      id: "tomorrow",
      label: "Tomorrow",
      description: `Tomorrow at ${formatTimeLabel(config.tomorrowTime)}`,
      detail: formatUntilLabel(tomorrowUntil),
      until: tomorrowUntil,
    },
    {
      id: "weekend",
      label: "This weekend",
      description: `${weekdayLong(config.weekendDay)} at ${formatTimeLabel(config.weekendTime)}`,
      detail: formatUntilLabel(weekendUntil),
      until: weekendUntil,
    },
    {
      id: "nextWeek",
      label: "Next week",
      description: `${weekdayLong(config.nextWeekDay)} at ${formatTimeLabel(config.nextWeekTime)}`,
      detail: formatUntilLabel(nextWeekUntil),
      until: nextWeekUntil,
    },
  ];
}

function savePresetConfig(next: SnoozePresetConfig) {
  setLocalStorageItem(SNOOZE_PRESET_CONFIG_KEY, JSON.stringify(normalizePresetConfig(next)));
}

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
  const storedPresetConfigRaw = useLocalStorageItem(SNOOZE_PRESET_CONFIG_KEY);
  const storedPresetConfig = useMemo(() => parsePresetConfig(storedPresetConfigRaw), [storedPresetConfigRaw]);

  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("09:00");
  const [customError, setCustomError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [presetConfig, setPresetConfig] = useState<SnoozePresetConfig>(storedPresetConfig);
  const [presetEditorOpen, setPresetEditorOpen] = useState(false);
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
    setPresetEditorOpen(false);
    setPresetConfig(storedPresetConfig);
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    setCustomDate(toLocalDateInput(tomorrow));
    setCustomTime(toLocalTimeInput(tomorrow));
  }, [open, storedPresetConfig]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, open]);

  const quickPresets = useMemo(() => buildSnoozePresets(new Date(), presetConfig), [presetConfig]);

  const customUntil = useMemo(() => {
    const dt = parseLocalDateTime(customDate, customTime);
    if (!dt) return null;
    if (dt.getTime() <= Date.now()) return null;
    return dt;
  }, [customDate, customTime]);

  const updatePresetConfig = (patch: Partial<SnoozePresetConfig>) => {
    setPresetConfig((prev) => {
      const next = normalizePresetConfig({ ...prev, ...patch });
      savePresetConfig(next);
      return next;
    });
  };

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
      className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(2,4,8,0.72)] px-3 pb-3 pt-12 backdrop-blur-md sm:px-4 sm:pb-5 md:items-center md:px-6 md:pb-8 md:pt-20"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative w-full max-w-4xl overflow-hidden rounded-[28px] border border-[rgba(255,255,255,0.14)]",
          "bg-[radial-gradient(circle_at_top_left,rgba(54,160,132,0.24),transparent_34%),radial-gradient(circle_at_top_right,rgba(255,120,72,0.16),transparent_28%),linear-gradient(180deg,rgba(14,17,23,0.98),rgba(8,10,14,0.96))]",
          "shadow-[0_30px_120px_rgba(0,0,0,0.58)]"
        )}
      >
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),transparent_28%,transparent_72%,rgba(255,255,255,0.03))]" />

        <div className="relative border-b border-[rgba(255,255,255,0.08)] px-4 pb-4 pt-4 sm:px-5 md:px-6 md:pb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[rgba(148,163,184,0.84)]">
                {title}
              </div>
              {entityLabel ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="inline-flex max-w-full items-center rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(8,11,16,0.56)] px-3 py-1.5 text-sm font-semibold text-[rgb(var(--claw-text))] shadow-[0_8px_26px_rgba(0,0,0,0.24)]">
                    <span className="truncate">{entityLabel}</span>
                  </span>
                </div>
              ) : null}
              {subtitle ? (
                <p className="mt-3 max-w-2xl text-sm leading-6 text-[rgba(196,205,220,0.82)]">{subtitle}</p>
              ) : null}
            </div>

            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(9,12,16,0.72)] text-[rgb(var(--claw-muted))] transition hover:border-[rgba(255,90,45,0.35)] hover:text-[rgb(var(--claw-text))]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="relative max-h-[calc(100vh-7rem)] overflow-y-auto px-4 py-4 sm:px-5 md:max-h-[78vh] md:px-6 md:py-5">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.88fr)]">
            <section className="rounded-[24px] border border-[rgba(255,255,255,0.1)] bg-[linear-gradient(180deg,rgba(14,18,24,0.88),rgba(10,12,18,0.7))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] md:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[rgba(148,163,184,0.82)]">
                    Quick picks
                  </div>
                  <h2 className="mt-2 text-lg font-semibold text-[rgb(var(--claw-text))] md:text-[1.35rem]">
                    Return it when it will feel useful again
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-[rgba(192,201,214,0.8)]">
                    These presets stay fast, but now you can tune the times to match how you actually work.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setPresetEditorOpen((prev) => !prev)}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] transition",
                    presetEditorOpen
                      ? "border-[rgba(77,171,158,0.42)] bg-[rgba(77,171,158,0.14)] text-[rgb(var(--claw-accent-2))]"
                      : "border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] text-[rgba(210,218,229,0.82)] hover:border-[rgba(255,255,255,0.2)] hover:text-[rgb(var(--claw-text))]"
                  )}
                >
                  <span>{presetEditorOpen ? "Done tuning" : "Tune quick picks"}</span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={cn("h-3.5 w-3.5 transition", presetEditorOpen ? "rotate-180" : "")}
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {quickPresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      void submit(preset.until);
                    }}
                    className={cn(
                      "group min-h-[136px] rounded-[22px] border border-[rgba(255,255,255,0.1)] bg-[linear-gradient(180deg,rgba(18,22,30,0.86),rgba(10,13,18,0.74))] p-4 text-left transition",
                      "hover:border-[rgba(77,171,158,0.45)] hover:bg-[linear-gradient(180deg,rgba(22,28,38,0.94),rgba(12,16,22,0.82))] hover:shadow-[0_18px_48px_rgba(0,0,0,0.24)]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(77,171,158,0.35)]",
                      "disabled:cursor-not-allowed disabled:opacity-60"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[rgba(148,163,184,0.8)]">
                          {preset.label}
                        </div>
                        <div className="mt-2 text-lg font-semibold leading-tight text-[rgb(var(--claw-text))]">
                          {preset.description}
                        </div>
                      </div>
                      <div className="rounded-full border border-[rgba(77,171,158,0.16)] bg-[rgba(77,171,158,0.08)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgb(var(--claw-accent-2))]">
                        {saving ? "..." : "Quick"}
                      </div>
                    </div>
                    <div className="mt-5 flex items-end justify-between gap-3">
                      <div className="text-sm leading-6 text-[rgba(201,210,222,0.78)]">{preset.detail}</div>
                      <div className="shrink-0 text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(77,171,158,0.95)] transition group-hover:text-[rgb(var(--claw-accent-2))]">
                        Snooze
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {presetEditorOpen ? (
                <div className="mt-4 rounded-[22px] border border-[rgba(77,171,158,0.16)] bg-[linear-gradient(180deg,rgba(8,14,16,0.76),rgba(10,13,18,0.62))] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[rgba(148,163,184,0.84)]">
                        Saved on this device
                      </div>
                      <div className="mt-1 text-sm text-[rgba(201,210,222,0.82)]">
                        Change the default return times once, then use the quick picks everywhere.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setPresetConfig(DEFAULT_PRESET_CONFIG);
                        savePresetConfig(DEFAULT_PRESET_CONFIG);
                      }}
                      className="inline-flex items-center rounded-full border border-[rgba(255,255,255,0.14)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(210,218,229,0.82)] transition hover:border-[rgba(255,255,255,0.24)] hover:text-[rgb(var(--claw-text))]"
                    >
                      Reset defaults
                    </button>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="rounded-[18px] border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)] p-3">
                      <label htmlFor="snooze-tonight-time" className="text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(148,163,184,0.82)]">
                        Tonight
                      </label>
                      <p className="mt-1 text-xs text-[rgba(201,210,222,0.72)]">Best for “not now, but still today.”</p>
                      <Input
                        id="snooze-tonight-time"
                        type="time"
                        step={300}
                        value={presetConfig.tonightTime}
                        onChange={(event) => updatePresetConfig({ tonightTime: event.target.value })}
                        disabled={saving}
                        className="mt-3 h-11"
                      />
                    </div>

                    <div className="rounded-[18px] border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)] p-3">
                      <label htmlFor="snooze-tomorrow-time" className="text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(148,163,184,0.82)]">
                        Tomorrow
                      </label>
                      <p className="mt-1 text-xs text-[rgba(201,210,222,0.72)]">Useful for next-morning follow-up.</p>
                      <Input
                        id="snooze-tomorrow-time"
                        type="time"
                        step={300}
                        value={presetConfig.tomorrowTime}
                        onChange={(event) => updatePresetConfig({ tomorrowTime: event.target.value })}
                        disabled={saving}
                        className="mt-3 h-11"
                      />
                    </div>

                    <div className="rounded-[18px] border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)] p-3">
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(148,163,184,0.82)]">
                        This weekend
                      </div>
                      <p className="mt-1 text-xs text-[rgba(201,210,222,0.72)]">Choose the day and time you usually review.</p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Select
                          aria-label="Weekend snooze day"
                          value={String(presetConfig.weekendDay)}
                          onChange={(event) => updatePresetConfig({ weekendDay: Number(event.target.value) })}
                          disabled={saving}
                          className="h-11"
                        >
                          {WEEKEND_DAY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.long}
                            </option>
                          ))}
                        </Select>
                        <Input
                          aria-label="Weekend snooze time"
                          type="time"
                          step={300}
                          value={presetConfig.weekendTime}
                          onChange={(event) => updatePresetConfig({ weekendTime: event.target.value })}
                          disabled={saving}
                          className="h-11"
                        />
                      </div>
                    </div>

                    <div className="rounded-[18px] border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)] p-3">
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(148,163,184,0.82)]">
                        Next week
                      </div>
                      <p className="mt-1 text-xs text-[rgba(201,210,222,0.72)]">Aim for the next real workday, not just “later.”</p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Select
                          aria-label="Next week snooze day"
                          value={String(presetConfig.nextWeekDay)}
                          onChange={(event) => updatePresetConfig({ nextWeekDay: Number(event.target.value) })}
                          disabled={saving}
                          className="h-11"
                        >
                          {NEXT_WEEK_DAY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.long}
                            </option>
                          ))}
                        </Select>
                        <Input
                          aria-label="Next week snooze time"
                          type="time"
                          step={300}
                          value={presetConfig.nextWeekTime}
                          onChange={(event) => updatePresetConfig({ nextWeekTime: event.target.value })}
                          disabled={saving}
                          className="h-11"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="rounded-[24px] border border-[rgba(255,255,255,0.1)] bg-[linear-gradient(180deg,rgba(11,14,19,0.92),rgba(8,10,14,0.74))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] md:p-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[rgba(148,163,184,0.82)]">
                Exact time
              </div>
              <h2 className="mt-2 text-lg font-semibold text-[rgb(var(--claw-text))] md:text-[1.35rem]">
                Pick a precise return point
              </h2>
              <p className="mt-2 text-sm leading-6 text-[rgba(192,201,214,0.8)]">
                Use this when the quick picks are close, but not quite right.
              </p>

              <div className="mt-4 rounded-[22px] border border-[rgba(255,255,255,0.1)] bg-[linear-gradient(180deg,rgba(17,21,29,0.88),rgba(10,13,18,0.76))] p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[rgba(148,163,184,0.8)]">
                  Preview
                </div>
                <div className="mt-2 text-base font-semibold leading-7 text-[rgb(var(--claw-text))]">
                  {customUntil ? formatUntilLabel(customUntil) : "Choose a future date and time"}
                </div>
                <div className="mt-2 text-sm leading-6 text-[rgba(192,201,214,0.76)]">
                  {customUntil ? "This item will come back at exactly this moment." : "Past times are blocked so you do not accidentally unsnooze immediately."}
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <div className="rounded-[18px] border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)] p-3">
                  <label htmlFor="snooze-custom-date" className="text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(148,163,184,0.82)]">
                    Date
                  </label>
                  <Input
                    id="snooze-custom-date"
                    type="date"
                    value={customDate}
                    onChange={(event) => {
                      setCustomDate(event.target.value);
                      setCustomError(null);
                    }}
                    disabled={saving}
                    className="mt-3 h-11"
                  />
                </div>

                <div className="rounded-[18px] border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)] p-3">
                  <label htmlFor="snooze-custom-time" className="text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(148,163,184,0.82)]">
                    Time
                  </label>
                  <Input
                    id="snooze-custom-time"
                    type="time"
                    value={customTime}
                    onChange={(event) => {
                      setCustomTime(event.target.value);
                      setCustomError(null);
                    }}
                    disabled={saving}
                    className="mt-3 h-11"
                  />
                </div>
              </div>

              {(customError || saveError) ? (
                <div className="mt-4 rounded-[16px] border border-[rgba(234,179,8,0.28)] bg-[rgba(234,179,8,0.09)] px-3 py-2 text-sm text-[rgb(var(--claw-warning))]">
                  {customError ?? saveError}
                </div>
              ) : null}

              <div className="mt-4 flex flex-col gap-3 sm:flex-row xl:flex-col 2xl:flex-row">
                <Button
                  size="md"
                  variant="secondary"
                  disabled={saving}
                  onClick={() => {
                    if (!customUntil) {
                      setCustomError("Pick a future date/time.");
                      return;
                    }
                    void submit(customUntil);
                  }}
                  className="h-12 w-full rounded-[16px] border-[rgba(77,171,158,0.28)] bg-[rgba(77,171,158,0.12)] text-[rgb(var(--claw-text))] hover:bg-[rgba(77,171,158,0.18)]"
                >
                  {saving ? "Snoozing..." : "Snooze until this time"}
                </Button>
                <Button size="md" variant="ghost" onClick={onClose} disabled={saving} className="h-12 w-full rounded-[16px] border border-[rgba(255,255,255,0.12)] hover:border-[rgba(255,255,255,0.2)]">
                  Cancel
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
