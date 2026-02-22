import { NextRequest, NextResponse } from "next/server";
import { createImportJob, getLatestImportJob, updateImportJob } from "../../../../../lib/db";
import { requireToken } from "../../../../../lib/auth";
import { importMemory } from "../../../../../lib/importer";

export async function POST(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const latest = await getLatestImportJob();
  const resumeCursor = latest?.status === "failed" ? latest.cursor : null;

  const job = await createImportJob();
  await updateImportJob(job.id, { status: "running", startedAt: new Date().toISOString() });

  try {
    const { summary, cursor } = await importMemory({ cursor: resumeCursor, jobId: job.id });
    const finishedAt = new Date().toISOString();
    const updated = await updateImportJob(job.id, {
      status: "done",
      summary,
      cursor,
      finishedAt
    });
    return NextResponse.json({ job: updated });
  } catch (err: unknown) {
    const message =
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "Import failed";
    const finishedAt = new Date().toISOString();
    const updated = await updateImportJob(job.id, {
      status: "failed",
      error: message,
      finishedAt
    });
    return NextResponse.json({ job: updated }, { status: 500 });
  }
}
