import { NextRequest } from "next/server";
import { proxyApiRequest } from "../../../../../lib/server-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  const id = encodeURIComponent((await context.params).id);
  return proxyApiRequest(req, `/api/topics/${id}/thread`, {
    legacyRouteId: "/api/topics/[id]/thread",
  });
}
