import { NextRequest } from "next/server";
import { proxyApiRequest } from "../../../../lib/server-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return proxyApiRequest(req, "/api/openclaw/chat", {
    legacyRouteId: "/api/openclaw/chat",
  });
}

export async function DELETE(req: NextRequest) {
  return proxyApiRequest(req, "/api/openclaw/chat", {
    legacyRouteId: "/api/openclaw/chat",
  });
}
