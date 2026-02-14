const TOPIC_PALETTE = ["#FF8A4A", "#4DA39E", "#6FA8FF", "#E0B35A", "#8BC17E", "#F17C8E"];

export function normalizeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

export function hashString(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export function pickTopicColor(seed: string, existingColors: Array<string | null | undefined> = []): string {
  const normalizedExisting = new Set(existingColors.map(normalizeHexColor).filter(Boolean) as string[]);
  const preferred = TOPIC_PALETTE[Math.abs(hashString(seed)) % TOPIC_PALETTE.length];
  const preferredNorm = normalizeHexColor(preferred)!;
  if (!normalizedExisting.has(preferredNorm)) return preferredNorm;

  // Deterministically walk the palette by a step derived from the seed.
  const step = 1 + (Math.abs(hashString(`step:${seed}`)) % (TOPIC_PALETTE.length - 1));
  let idx = TOPIC_PALETTE.indexOf(preferredNorm);
  for (let i = 0; i < TOPIC_PALETTE.length; i += 1) {
    idx = (idx + step) % TOPIC_PALETTE.length;
    const candidate = normalizeHexColor(TOPIC_PALETTE[idx])!;
    if (!normalizedExisting.has(candidate)) return candidate;
  }

  // Palette exhausted; return preferred deterministically.
  return preferredNorm;
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex: string) {
  const normalized = normalizeHexColor(hex) ?? "#000000";
  const raw = normalized.slice(1);
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16)
  };
}

function rgbToHex(rgb: { r: number; g: number; b: number }) {
  const r = clampByte(rgb.r).toString(16).padStart(2, "0");
  const g = clampByte(rgb.g).toString(16).padStart(2, "0");
  const b = clampByte(rgb.b).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`.toUpperCase();
}

function mix(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
  };
}

export function deriveTaskColor(topicColor: string, seed: string): string {
  const base = hexToRgb(topicColor);
  // Push away from the base color by mixing toward white/black depending on a seed bit.
  const h = hashString(seed);
  const towardWhite = (h & 1) === 0;
  const mixTarget = towardWhite ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  const t = 0.22 + (Math.abs(h) % 18) / 100; // 0.22 - 0.39
  const mixed = mix(base, mixTarget, t);

  // Ensure it isn't identical to the topic color.
  const derived = rgbToHex(mixed);
  return derived === normalizeHexColor(topicColor) ? rgbToHex(mix(base, mixTarget, Math.min(0.6, t + 0.15))) : derived;
}
