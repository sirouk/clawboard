import { redirect } from "next/navigation";
export default async function TopicRedirect({ params }: { params: { topicId: string } }) {
  const topicId = params.topicId;
  redirect(`/u/topic/${encodeURIComponent(topicId)}`);
}
