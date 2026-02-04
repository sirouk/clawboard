import { redirect } from "next/navigation";
import { loadStore } from "@/lib/store";
import { encodeTaskSlug, encodeTopicSlug } from "@/lib/slug";

export default async function TaskRedirect({ params }: { params: { taskId: string } }) {
  const taskId = params.taskId;
  const store = await loadStore();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task) {
    redirect("/");
  }

  const taskSlug = encodeTaskSlug(task);
  const topic = store.topics.find((item) => item.id === task.topicId);
  const topicParam = topic ? `/topic/${encodeTopicSlug(topic)}` : "";
  redirect(`/u${topicParam}/task/${taskSlug}`);
}
