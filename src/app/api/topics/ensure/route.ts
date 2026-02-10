import { NextRequest, NextResponse } from "next/server";
import { ensureTopic } from "../../../../../lib/db";
import { requireToken } from "../../../../../lib/auth";
import { z } from "zod";

const EnsureTopicSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional().nullable(),
    parentId: z.string().min(1).optional().nullable(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional()
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

  const parsed = EnsureTopicSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await ensureTopic({
      id: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.description ?? undefined,
      parentId: parsed.data.parentId ?? null,
      tags: parsed.data.tags
    });

    return NextResponse.json({ topic: result.topic, created: result.created });
  } catch (err: any) {
    const code = err?.code;
    if (code === "P2003") {
      return NextResponse.json({ error: "Invalid parentId" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to ensure topic" }, { status: 500 });
  }
}
