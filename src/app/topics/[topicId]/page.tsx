import { redirect } from "next/navigation";

export default async function TopicRedirect({ params }: { params: Promise<{ topicId: string }> }) {
  const resolved = await params;
  const topicId = String(resolved?.topicId ?? "").trim();
  if (!topicId) redirect("/u");
  redirect(`/u/topic/${encodeURIComponent(topicId)}`);
}
