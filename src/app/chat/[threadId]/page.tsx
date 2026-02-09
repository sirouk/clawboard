import { redirect } from "next/navigation";

type MaybePromise<T> = T | Promise<T>;

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function ChatThreadRedirect({ params }: { params: MaybePromise<{ threadId: string }> }) {
  // Next.js can provide `params` as either a plain object or a Promise (depending on runtime mode).
  const resolved = await params;
  const threadId = safeDecode(String(resolved?.threadId ?? "")).trim();

  if (threadId.startsWith("topic:")) {
    const topicId = threadId.slice("topic:".length).trim();
    if (topicId) redirect(`/u/topic/${encodeURIComponent(topicId)}?chat=1`);
    redirect("/u");
  }

  if (threadId.startsWith("task:")) {
    const rest = threadId.slice("task:".length).trim();
    const [topicId, taskId] = rest.split(":");
    if (topicId && taskId) {
      redirect(`/u/topic/${encodeURIComponent(topicId)}/task/${encodeURIComponent(taskId)}`);
    }
    redirect("/u");
  }

  redirect("/u");
}
