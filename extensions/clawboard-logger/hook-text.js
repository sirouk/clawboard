const DEFAULT_TEXT_KEYS = ["text", "content", "value", "message", "output_text", "input_text"];
export function extractNestedText(value, depth = 0, keys = DEFAULT_TEXT_KEYS) {
    if (!value || depth > 4)
        return undefined;
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        const parts = value
            .map((entry) => extractNestedText(entry, depth + 1, keys))
            .filter((entry) => Boolean(entry));
        return parts.length > 0 ? parts.join("\n") : undefined;
    }
    if (typeof value === "object") {
        const obj = value;
        const parts = [];
        for (const key of keys) {
            const extracted = extractNestedText(obj[key], depth + 1, keys);
            if (extracted)
                parts.push(extracted);
        }
        return parts.length > 0 ? parts.join("\n") : undefined;
    }
    return undefined;
}
