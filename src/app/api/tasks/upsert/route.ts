import { NextRequest, NextResponse } from "next/server";
import { upsertTask } from "../../../../../lib/db";
import { requireToken } from "../../../../../lib/auth";
import { z } from "zod";

const StatusSchema = z.enum(["todo", "doing", "blocked", "done"]);

const UpsertTaskSchema = z
  .object({
    id: z.string().min(1).optional(),
    topicId: z.string().min(1),
    title: z.string().min(1).max(500),
    status: StatusSchema.optional()
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

  const parsed = UpsertTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await upsertTask(parsed.data);
    return NextResponse.json(
      { task: result.task, created: result.created },
      { status: result.created ? 201 : 200 }
    );
  } catch (err: any) {
    const code = err?.code;
    if (code === "P2003") {
      return NextResponse.json({ error: "Invalid topicId" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to upsert task" }, { status: 500 });
  }
}
