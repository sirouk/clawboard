import { NextRequest } from "next/server";
import { proxyApiRequest } from "../../../../lib/server-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

async function proxyTopicRequest(req: NextRequest, context: RouteContext) {
  const id = encodeURIComponent((await context.params).id);
  return proxyApiRequest(req, `/api/topics/${id}`, { legacyRouteId: "/api/topics/[id]" });
}

export async function GET(req: NextRequest, context: RouteContext) {
  return proxyTopicRequest(req, context);
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  return proxyTopicRequest(req, context);
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  return proxyTopicRequest(req, context);
}
