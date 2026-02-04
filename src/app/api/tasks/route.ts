import { NextRequest, NextResponse } from "next/server";
import { appendLog, loadStore, updateStore, upsertTask } from "@/lib/store";
import { hasValidToken } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const store = await loadStore();
  const { searchParams } = request.nextUrl;
  const topicId = searchParams.get("topicId");
  const status = searchParams.get("status");

  let tasks = store.tasks;
  if (topicId) {
    tasks = tasks.filter((task) => task.topicId === topicId);
  }
  if (status) {
    tasks = tasks.filter((task) => task.status === status);
  }

  tasks = [...tasks].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
  return NextResponse.json({ tasks });
}

export async function POST(request: NextRequest) {
  if (!hasValidToken(request)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload || !payload.title) {
    return NextResponse.json({ error: "Task title is required" }, { status: 400 });
  }

  const store = await updateStore((current) => {
    const task = upsertTask(current, payload);
    appendLog(current, {
      topicId: task.topicId,
      type: "action",
      content: `Task ${payload.id ? "updated" : "created"}: ${task.title}`,
      agentId: payload.agentId,
      agentLabel: payload.agentLabel,
    });
    return current;
  });

  return NextResponse.json({ tasks: store.tasks });
}
