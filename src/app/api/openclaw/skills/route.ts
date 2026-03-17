import { NextRequest, NextResponse } from "next/server";
import { resolveServerApiBase } from "../../../../lib/server-api-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildForwardHeaders(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  return headers;
}

export async function GET(req: NextRequest) {
  // Auth is enforced by the FastAPI middleware via the forwarded X-Clawboard-Token header.
  const base = resolveServerApiBase();
  if (!base) {
    return NextResponse.json({ detail: "Missing CLAWBOARD_SERVER_API_BASE" }, { status: 500 });
  }

  const targetUrl = `${base}/api/openclaw/skills${req.nextUrl.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: "GET",
      headers: buildForwardHeaders(req),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Upstream fetch failed";
    return NextResponse.json({ detail }, { status: 502 });
  }

  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return new NextResponse(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: { "content-type": contentType || "text/plain; charset=utf-8" },
    });
  }

  try {
    const parsed = text ? JSON.parse(text) : {};
    return NextResponse.json(parsed, { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Invalid JSON from upstream" }, { status: 502 });
  }
}
