import { redirect } from "next/navigation";

type MaybePromise<T> = T | Promise<T>;

export default async function TaskRedirect({ params }: { params: MaybePromise<{ taskId: string }> }) {
  // Next.js can provide `params` as either a plain object or a Promise (depending on runtime mode).
  const resolved = await params;
  const taskId = String(resolved?.taskId ?? "").trim();
  if (!taskId) redirect("/u");
  redirect(`/u/task/${encodeURIComponent(taskId)}`);
}
