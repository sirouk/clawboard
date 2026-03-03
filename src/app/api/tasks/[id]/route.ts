import { NextRequest } from "next/server";
import { proxyApiRequest } from "../../../../lib/server-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

async function proxyTaskRequest(req: NextRequest, context: RouteContext) {
  const id = encodeURIComponent((await context.params).id);
  return proxyApiRequest(req, `/api/tasks/${id}`, { legacyRouteId: "/api/tasks/[id]" });
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  return proxyTaskRequest(req, context);
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  return proxyTaskRequest(req, context);
}

export async function GET(req: NextRequest, context: RouteContext) {
  return proxyTaskRequest(req, context);
}
