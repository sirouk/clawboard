import { NextRequest, NextResponse } from "next/server";
import { deleteTask, patchTask } from "../../../../../lib/db";
import { requireToken } from "../../../../../lib/auth";
import { z } from "zod";
import { toFastApiDetail } from "../../../../../lib/compat_api_validation";

const StatusSchema = z.enum(["todo", "doing", "blocked", "done"]);
const errorCode = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const value = (err as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
};
const PatchTaskSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    status: StatusSchema.optional(),
    topicId: z.string().min(1).optional(),
    color: z.string().optional().nullable()
  });

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

  const parsed = PatchTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ detail: toFastApiDetail(parsed.error) }, { status: 422 });
  }

  let updated: Awaited<ReturnType<typeof patchTask>> = null;
  try {
    updated = await patchTask(id, {
      ...parsed.data,
      color: parsed.data.color ?? undefined
    });
  } catch (err: unknown) {
    const code = errorCode(err);
    if (code === "P2003") {
      return NextResponse.json({ detail: "Invalid topicId" }, { status: 400 });
    }
    return NextResponse.json({ detail: "Failed to update task" }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ detail: "Task not found" }, { status: 404 });
  }
  // Match FastAPI contract: return the updated task object directly.
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
    await deleteTask(id);
    return NextResponse.json({ ok: true, deleted: true });
  } catch (err: unknown) {
    const code = errorCode(err);
    if (code === "P2025") {
      return NextResponse.json({ detail: "Task not found" }, { status: 404 });
    }
    return NextResponse.json({ detail: "Failed to delete task" }, { status: 500 });
  }
}
