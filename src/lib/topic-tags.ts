const OPERATIONAL_TOPIC_TAG_PREFIXES = [
  "agent:",
  "session:",
  "request:",
  "run:",
  "subagent:",
  "delegate:",
  "delegation:",
  "worker:",
  "orchestration:",
] as const;

const OPERATIONAL_TOPIC_TAG_VALUES = new Set(["delegating"]);

export function cleanTopicTagLabel(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTopicTagKey(value: string) {
  const raw = cleanTopicTagLabel(value).toLowerCase();
  if (!raw) return "";
  const withDashes = raw.replace(/\s+/g, "-");
  const stripped = withDashes.replace(/[^a-z0-9:_-]/g, "");
  return stripped.replace(/:{2,}/g, ":").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

export function isOperationalTopicTagLabel(value: unknown) {
  const lowered = cleanTopicTagLabel(value).toLowerCase();
  if (!lowered) return false;
  if (OPERATIONAL_TOPIC_TAG_VALUES.has(lowered)) return true;
  return OPERATIONAL_TOPIC_TAG_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

export function isUserFacingTopicTagLabel(value: unknown) {
  const lowered = cleanTopicTagLabel(value).toLowerCase();
  if (!lowered) return false;
  if (lowered.startsWith("system:")) return false;
  return !isOperationalTopicTagLabel(lowered);
}

export function filterUserFacingTopicTagLabels(values: Iterable<unknown>) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    const label = cleanTopicTagLabel(rawValue);
    const key = normalizeTopicTagKey(label);
    if (!key || seen.has(key) || !isUserFacingTopicTagLabel(label)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

export function mergeVisibleAndReservedTopicTagLabels(existingValues: Iterable<unknown>, userFacingValues: Iterable<unknown>) {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (rawValue: unknown) => {
    const label = cleanTopicTagLabel(rawValue);
    const key = normalizeTopicTagKey(label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(label);
  };
  for (const rawValue of existingValues) {
    if (isUserFacingTopicTagLabel(rawValue)) continue;
    add(rawValue);
  }
  for (const rawValue of userFacingValues) {
    add(rawValue);
  }
  return out;
}

export function spaceIdFromTopicTagLabel(value: unknown) {
  let text = cleanTopicTagLabel(value);
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (lowered.startsWith("system:")) return null;
  if (lowered.startsWith("space:")) {
    text = cleanTopicTagLabel(text.split(":", 2)[1] ?? "");
  } else {
    if (isOperationalTopicTagLabel(text)) return null;
    if (lowered.includes(":")) return null;
  }
  const slug = text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || slug === "default" || slug === "global" || slug === "all" || slug === "all-spaces") {
    return null;
  }
  return `space-${slug}`;
}
