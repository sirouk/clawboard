import { redirect } from "next/navigation";
export default async function TaskRedirect({ params }: { params: { taskId: string } }) {
  const taskId = params.taskId;
  redirect(`/u/task/${encodeURIComponent(taskId)}`);
}
