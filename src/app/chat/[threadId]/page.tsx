import { redirect } from "next/navigation";

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function ChatThreadRedirect({ params }: { params: { threadId: string } }) {
  const threadId = safeDecode(params.threadId ?? "").trim();

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

