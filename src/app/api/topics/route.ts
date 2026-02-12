import { NextRequest, NextResponse } from "next/server";
import { createTopic, getData } from "../../../../lib/db";
import { requireToken } from "../../../../lib/auth";
import { z } from "zod";

const CreateTopicSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional().nullable(),
    parentId: z.string().min(1).optional().nullable(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional()
  })
  .strict();
const errorCode = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const value = (err as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
};

export async function GET(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const data = await getData();
  return NextResponse.json({ topics: data.topics });
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
  const parsed = CreateTopicSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const topic = await createTopic({
      name: parsed.data.name,
      description: parsed.data.description ?? undefined,
      parentId: parsed.data.parentId ?? null,
      tags: parsed.data.tags
    });
    return NextResponse.json({ topic }, { status: 201 });
  } catch (err: unknown) {
    const code = errorCode(err);
    if (code === "P2003") {
      return NextResponse.json({ error: "Invalid parentId" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to create topic" }, { status: 500 });
  }
}
