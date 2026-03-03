import { NextRequest } from "next/server";
import { proxyApiRequest } from "../../../lib/server-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return proxyApiRequest(req, "/api/log", { legacyRouteId: "/api/log" });
}

export async function POST(req: NextRequest) {
  return proxyApiRequest(req, "/api/log", { legacyRouteId: "/api/log" });
}
