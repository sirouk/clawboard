import { NextRequest, NextResponse } from "next/server";
import { resolveServerApiBase } from "../../../lib/server-api-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function forwardRequestHeaders(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  for (const key of HOP_BY_HOP_HEADERS) headers.delete(key);
  return headers;
}

function forwardResponseHeaders(upstream: Response) {
  const headers = new Headers(upstream.headers);
  for (const key of HOP_BY_HOP_HEADERS) headers.delete(key);
  return headers;
}

async function proxyRequest(request: NextRequest, path: string[]) {
  const base = resolveServerApiBase();
  if (!base) {
    return NextResponse.json({ detail: "Missing CLAWBOARD_SERVER_API_BASE" }, { status: 500 });
  }

  const suffix = path.length > 0 ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const targetUrl = `${base}/api${suffix}${request.nextUrl.search}`;

  const init: RequestInit = {
    method: request.method,
    headers: forwardRequestHeaders(request),
    redirect: "manual",
    cache: "no-store",
  };

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Upstream fetch failed";
    return NextResponse.json({ detail }, { status: 502 });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardResponseHeaders(upstream),
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, (await context.params).path || []);
}

export async function HEAD(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, (await context.params).path || []);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, (await context.params).path || []);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, (await context.params).path || []);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, (await context.params).path || []);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, (await context.params).path || []);
}

export async function OPTIONS(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, (await context.params).path || []);
}
