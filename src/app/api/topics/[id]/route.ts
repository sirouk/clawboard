import { NextRequest, NextResponse } from "next/server";
import { deleteTopic, getData, patchTopic } from "../../../../../lib/db";
import { requireToken } from "../../../../../lib/auth";
import { z } from "zod";
import { toFastApiDetail } from "../../../../../lib/compat_api_validation";

const PatchTopicSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional().nullable(),
    parentId: z.string().min(1).optional().nullable(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
    color: z.string().optional().nullable()
  });
const errorCode = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const value = (err as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireToken(req);
  if (authError) return authError;

  const { id } = await params;
  const data = await getData();
  const topic = data.topics.find((t) => t.id === id);
  if (!topic) {
    return NextResponse.json({ detail: "Topic not found" }, { status: 404 });
  }
  // Match FastAPI contract: return the topic object directly.
  return NextResponse.json(topic);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireToken(req);
  if (authError) return authError;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PatchTopicSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ detail: toFastApiDetail(parsed.error) }, { status: 422 });
  }

  let updated: Awaited<ReturnType<typeof patchTopic>> = null;
  try {
    updated = await patchTopic(id, {
      name: parsed.data.name,
      description: parsed.data.description ?? undefined,
      parentId: parsed.data.parentId,
      tags: parsed.data.tags,
      color: parsed.data.color ?? undefined
    });
  } catch (err: unknown) {
    const code = errorCode(err);
    if (code === "P2003") {
      return NextResponse.json({ detail: "Invalid parentId" }, { status: 400 });
    }
    return NextResponse.json({ detail: "Failed to update topic" }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ detail: "Topic not found" }, { status: 404 });
  }
  // Match FastAPI contract: return the updated topic object directly.
  return NextResponse.json(updated);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireToken(req);
  if (authError) return authError;

  const { id } = await params;
  try {
    await deleteTopic(id);
    return NextResponse.json({ ok: true, deleted: true });
  } catch (err: unknown) {
    const code = errorCode(err);
    if (code === "P2025") {
      return NextResponse.json({ detail: "Topic not found" }, { status: 404 });
    }
    return NextResponse.json({ detail: "Failed to delete topic" }, { status: 500 });
  }
}
