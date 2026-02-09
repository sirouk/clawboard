import { redirect } from "next/navigation";

type MaybePromise<T> = T | Promise<T>;

export default async function TopicRedirect({ params }: { params: MaybePromise<{ topicId: string }> }) {
  // Next.js can provide `params` as either a plain object or a Promise (depending on runtime mode).
  const resolved = await params;
  const topicId = String(resolved?.topicId ?? "").trim();
  if (!topicId) redirect("/u");
  redirect(`/u/topic/${encodeURIComponent(topicId)}`);
}
