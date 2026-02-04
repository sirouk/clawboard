import { redirect } from "next/navigation";
import { loadStore } from "@/lib/store";
import { encodeTopicSlug } from "@/lib/slug";

export default async function TopicRedirect({ params }: { params: { topicId: string } }) {
  const topicId = params.topicId;
  const store = await loadStore();
  const topic = store.topics.find((item) => item.id === topicId);
  const slug = topic ? encodeTopicSlug(topic) : topicId;
  redirect(`/u/topic/${slug}`);
}
