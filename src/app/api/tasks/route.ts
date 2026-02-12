import { NextRequest, NextResponse } from "next/server";
import { createTask, getData } from "../../../../lib/db";
import { requireToken } from "../../../../lib/auth";
import { z } from "zod";

const StatusSchema = z.enum(["todo", "doing", "blocked", "done"]);
const errorCode = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const value = (err as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
};

const CreateTaskSchema = z
  .object({
    topicId: z.string().min(1),
    title: z.string().min(1).max(500),
    status: StatusSchema.optional()
  })
  .strict();

export async function GET(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const data = await getData();
  const { searchParams } = new URL(req.url);
  const topicId = searchParams.get("topicId");
  const status = searchParams.get("status");

  let tasks = data.tasks;
  if (topicId) tasks = tasks.filter((t) => t.topicId === topicId);
  if (status) {
    const parsed = StatusSchema.safeParse(status);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    tasks = tasks.filter((t) => t.status === parsed.data);
  }

  // Newest updated first by default
  tasks = tasks.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Match FastAPI contract: return the task list directly.
  return NextResponse.json(tasks);
}

export async function POST(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const task = await createTask(parsed.data);
    // Match FastAPI contract: return the created task object directly.
    return NextResponse.json(task, { status: 201 });
  } catch (err: unknown) {
    // Prisma FK violation, etc.
    const code = errorCode(err);
    if (code === "P2003") {
      return NextResponse.json({ error: "Invalid topicId" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
