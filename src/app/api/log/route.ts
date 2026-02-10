import { NextRequest, NextResponse } from "next/server";
import { appendLog, getData } from "../../../../lib/db";
import { requireToken } from "../../../../lib/auth";
import { z } from "zod";

const AppendLogSchema = z
  .object({
    message: z.string().min(1).max(20_000),
    topicId: z.string().min(1).optional().nullable(),
    agentId: z.string().min(1).max(64).optional().nullable(),
    agentLabel: z.string().min(1).max(128).optional().nullable(),
    sessionKey: z.string().min(1).max(256).optional().nullable(),
    messageId: z.string().min(1).max(256).optional().nullable(),
    channel: z.string().min(1).max(64).optional().nullable()
  })
  .strict();

export async function GET(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const data = await getData();
  const { searchParams } = new URL(req.url);
  const topicId = searchParams.get("topicId");
  const log = (topicId ? data.log.filter((l) => l.topicId === topicId) : data.log)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return NextResponse.json({ log });
}

export async function POST(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AppendLogSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const entry = await appendLog({
    message: parsed.data.message,
    topicId: parsed.data.topicId ?? null,
    agentId: parsed.data.agentId ?? undefined,
    agentLabel: parsed.data.agentLabel ?? undefined,
    sessionKey: parsed.data.sessionKey ?? undefined,
    messageId: parsed.data.messageId ?? undefined,
    channel: parsed.data.channel ?? undefined
  });
  return NextResponse.json({ entry }, { status: 201 });
}
