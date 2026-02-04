export function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "item";
}

export function encodeTopicSlug(topic: { id: string; name: string }) {
  return `${slugify(topic.name)}--${topic.id}`;
}

export function encodeTaskSlug(task: { id: string; title: string }) {
  return `${slugify(task.title)}--${task.id}`;
}

export function decodeSlugId(value: string) {
  if (!value) return "";
  const idx = value.lastIndexOf("--");
  if (idx === -1) return value;
  return value.slice(idx + 2);
}
