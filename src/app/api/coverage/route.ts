import { NextRequest, NextResponse } from "next/server";
import { getData, getLatestImportJob } from "../../../../lib/db";
import { requireToken } from "../../../../lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const data = await getData();
  const latest = await getLatestImportJob();
  const uncategorized = data.events.filter((e) => !e.topicId).length;

  const summary = {
    sessionsFound: latest?.summary?.sessionsFound ?? 0,
    entriesImported: latest?.summary?.entriesImported ?? 0,
    pending: latest?.summary?.pending ?? 0,
    failed: latest?.summary?.failed ?? 0,
    uncategorized: latest?.summary?.uncategorized ?? uncategorized
  };

  return NextResponse.json({ summary, latestJob: latest });
}

