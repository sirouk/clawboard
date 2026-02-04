import { NextRequest, NextResponse } from "next/server";
import { appendLog, loadStore, updateStore } from "@/lib/store";
import { hasValidToken } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const store = await loadStore();
  const { searchParams } = request.nextUrl;
  const topicId = searchParams.get("topicId");
  const taskId = searchParams.get("taskId");
  const relatedLogId = searchParams.get("relatedLogId");
  const type = searchParams.get("type");
  const agentId = searchParams.get("agentId");

  let logs = store.logs;
  if (topicId) {
    logs = logs.filter((entry) => entry.topicId === topicId);
  }
  if (taskId) {
    logs = logs.filter((entry) => entry.taskId === taskId);
  }
  if (relatedLogId) {
    logs = logs.filter((entry) => entry.relatedLogId === relatedLogId);
  }
  if (type) {
    logs = logs.filter((entry) => entry.type === type);
  }
  if (agentId) {
    logs = logs.filter((entry) => entry.agentId === agentId);
  }

  logs = [...logs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return NextResponse.json({ logs });
}

export async function POST(request: NextRequest) {
  if (!hasValidToken(request)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload || !payload.content) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  const store = await updateStore((current) => {
    appendLog(current, {
      topicId: payload.topicId ?? null,
      taskId: payload.taskId ?? null,
      relatedLogId: payload.relatedLogId ?? null,
      type: payload.type ?? "note",
      content: payload.content,
      summary: payload.summary,
      raw: payload.raw,
      agentId: payload.agentId,
      agentLabel: payload.agentLabel,
      source: payload.source,
    });
    return current;
  });

  return NextResponse.json({ logs: store.logs });
}
