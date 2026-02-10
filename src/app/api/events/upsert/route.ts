import { NextRequest, NextResponse } from "next/server";
import { upsertEvent } from "../../../../../lib/db";
import { requireToken } from "../../../../../lib/auth";
import { z } from "zod";

const EventTypeSchema = z.enum([
  "conversation.user",
  "conversation.assistant",
  "action",
  "task"
]);

const EventSourceSchema = z
  .object({
    source: z.string().min(1).max(64),
    filePath: z.string().max(4096).optional(),
    section: z.string().max(1024).optional(),
    lineNumber: z.number().int().positive().optional(),
    cursor: z.string().max(10_000).optional()
  })
  .passthrough();

const UpsertEventSchema = z
  .object({
    type: EventTypeSchema,
    content: z.string().min(1).max(200_000),
    timestamp: z.string().datetime(),
    topicId: z.string().min(1).optional().nullable(),
    agentId: z.string().min(1).max(64).optional().nullable(),
    agentLabel: z.string().min(1).max(128).optional().nullable(),
    source: EventSourceSchema,
    sourceId: z.string().min(1).max(256)
  })
  .strict();

export async function POST(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = UpsertEventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const result = await upsertEvent({
    type: parsed.data.type,
    content: parsed.data.content,
    timestamp: parsed.data.timestamp,
    topicId: parsed.data.topicId ?? null,
    agentId: parsed.data.agentId ?? undefined,
    agentLabel: parsed.data.agentLabel ?? undefined,
    source: parsed.data.source,
    sourceId: parsed.data.sourceId
  });

  return NextResponse.json(
    { event: result.entry, created: result.created },
    { status: result.created ? 201 : 200 }
  );
}
