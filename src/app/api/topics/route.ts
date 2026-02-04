import { NextRequest, NextResponse } from "next/server";
import { appendLog, loadStore, updateStore, upsertTopic } from "@/lib/store";
import { hasValidToken } from "@/lib/auth";

export async function GET() {
  const store = await loadStore();
  return NextResponse.json({ topics: store.topics });
}

export async function POST(request: NextRequest) {
  if (!hasValidToken(request)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload || !payload.name) {
    return NextResponse.json({ error: "Topic name is required" }, { status: 400 });
  }

  const store = await updateStore((current) => {
    const topic = upsertTopic(current, payload);
    appendLog(current, {
      topicId: topic.id,
      type: "action",
      content: `Topic ${payload.id ? "updated" : "created"}: ${topic.name}`,
      agentId: payload.agentId,
      agentLabel: payload.agentLabel,
    });
    return current;
  });

  return NextResponse.json({ topics: store.topics });
}
