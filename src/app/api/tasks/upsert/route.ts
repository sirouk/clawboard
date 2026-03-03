import { NextRequest } from "next/server";
import { blockLegacyApiRoute } from "../../../../lib/server-api-proxy";

export async function POST(req: NextRequest) {
  return blockLegacyApiRoute(
    req,
    "/api/tasks/upsert",
    "Route removed from the Next.js legacy API surface. Use canonical FastAPI task create/update endpoints instead.",
  );
}
