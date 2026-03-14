import { redirect } from "next/navigation";

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function ChatThreadRedirect({ params }: { params: Promise<{ threadId: string }> }) {
  const resolved = await params;
  const threadId = safeDecode(String(resolved?.threadId ?? "")).trim();

  if (threadId.startsWith("topic:")) {
    const topicId = threadId.slice("topic:".length).trim().split(":", 1)[0]?.trim() ?? "";
    if (topicId) {
      redirect(`/u/topic/${encodeURIComponent(topicId)}`);
    }
    redirect("/u");
  }

  redirect("/u");
}
