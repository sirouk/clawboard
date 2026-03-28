const DEFAULT_TEXT_KEYS = ["text", "content", "value", "message", "output_text", "input_text"] as const;

export function extractNestedText(
  value: unknown,
  depth = 0,
  keys: readonly string[] = DEFAULT_TEXT_KEYS,
): string | undefined {
  if (!value || depth > 4) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractNestedText(entry, depth + 1, keys))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of keys) {
      const extracted = extractNestedText(obj[key], depth + 1, keys);
      if (extracted) parts.push(extracted);
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}
