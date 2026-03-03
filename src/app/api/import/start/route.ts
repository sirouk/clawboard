import { NextRequest } from "next/server";
import { blockLegacyApiRoute } from "../../../../lib/server-api-proxy";

export async function POST(req: NextRequest) {
  return blockLegacyApiRoute(
    req,
    "/api/import/start",
    "Route removed from the Next.js legacy API surface with no canonical FastAPI replacement.",
  );
}
