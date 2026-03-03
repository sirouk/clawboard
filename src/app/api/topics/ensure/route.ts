import { NextRequest } from "next/server";
import { blockLegacyApiRoute } from "../../../../lib/server-api-proxy";

export async function POST(req: NextRequest) {
  return blockLegacyApiRoute(
    req,
    "/api/topics/ensure",
    "Route removed from the Next.js legacy API surface. Use canonical FastAPI topic create/update endpoints instead.",
  );
}
