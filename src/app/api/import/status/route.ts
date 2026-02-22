import { NextRequest, NextResponse } from "next/server";
import { getImportJob, getLatestImportJob } from "../../../../../lib/db";
import { requireToken } from "../../../../../lib/auth";
import { z } from "zod";

const JobIdSchema = z.string().min(1).max(256);

export async function GET(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (jobId) {
    const parsed = JobIdSchema.safeParse(jobId);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid jobId" }, { status: 400 });
    }
    const job = await getImportJob(jobId);
    return NextResponse.json({ job });
  }

  const latest = await getLatestImportJob();
  return NextResponse.json({ job: latest });
}
