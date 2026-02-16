/**
 * Converts a string to a URL-friendly slug.
 * @param value - The string to convert to a slug
 * @returns A sanitized slug string
 */
export function slugify(value: string): string {
  if (typeof value !== 'string') return "item";
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug.length > 0 ? slug : "item";
}

/** Encodes a topic with its name and ID into a slug */
export function encodeTopicSlug(topic: { id: string; name: string }): string {
  return `${slugify(topic.name)}--${topic.id}`;
}

/** Encodes a task with its title and ID into a slug */
export function encodeTaskSlug(task: { id: string; title: string }): string {
  return `${slugify(task.title)}--${task.id}`;
}

/** Extracts the ID from a slug encoded with '--' separator */
export function decodeSlugId(value: string): string {
  if (typeof value !== 'string' || !value) return "";
  const idx = value.lastIndexOf("--");
  return idx === -1 ? value : value.slice(idx + 2);
}
