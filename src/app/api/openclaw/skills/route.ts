import { NextRequest, NextResponse } from "next/server";
import { requireToken } from "../../../../lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeBase(raw: string) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function resolveUpstreamBase() {
  return normalizeBase(
    process.env.CLAWBOARD_SERVER_API_BASE ||
      process.env.CLAWBOARD_PUBLIC_API_BASE ||
      process.env.NEXT_PUBLIC_CLAWBOARD_API_BASE ||
      "http://localhost:8010",
  );
}

function buildForwardHeaders(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  const fallbackToken = String(process.env.CLAWBOARD_SERVER_API_TOKEN || process.env.CLAWBOARD_TOKEN || "").trim();
  if (fallbackToken && !headers.get("x-clawboard-token")) {
    headers.set("x-clawboard-token", fallbackToken);
  }
  return headers;
}

export async function GET(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const base = resolveUpstreamBase();
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
