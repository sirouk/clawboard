import { NextRequest } from "next/server";
import { blockLegacyApiRoute } from "../../../lib/server-api-proxy";

export async function GET(req: NextRequest) {
  return blockLegacyApiRoute(
    req,
    "/api/events",
    "Route removed from the Next.js legacy API surface with no canonical FastAPI replacement.",
  );
}
