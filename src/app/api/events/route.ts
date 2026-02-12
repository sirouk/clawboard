import { NextRequest, NextResponse } from "next/server";
import { listEvents } from "../../../../lib/db";
import { requireToken } from "../../../../lib/auth";
import { z } from "zod";

const EventTypeSchema = z.enum([
  "conversation.user",
  "conversation.assistant",
  "action",
  "task"
]);

const LimitSchema = z.coerce.number().int().min(1).max(500);
type EventType = z.infer<typeof EventTypeSchema>;

export async function GET(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const topicId = searchParams.get("topicId");
  const type = searchParams.get("type");
  const query = searchParams.get("q");
  const source = searchParams.get("source");
  const limitRaw = searchParams.get("limit");

  let limit = 0;
  if (limitRaw) {
    const parsedLimit = LimitSchema.safeParse(limitRaw);
    if (!parsedLimit.success) {
      return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
    }
    limit = parsedLimit.data;
  }

  let parsedType: EventType | null = null;
  if (type) {
    const parsed = EventTypeSchema.safeParse(type);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
    }
    parsedType = parsed.data;
  }

  const events = await listEvents({
    topicId,
    type: parsedType,
    query,
    source,
    limit
  });

  return NextResponse.json({ events });
}
