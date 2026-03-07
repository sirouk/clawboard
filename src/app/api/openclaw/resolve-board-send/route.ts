import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireToken } from "../../../../lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ResolveBoardSendRequestSchema = z.object({
  message: z.string().min(1),
  spaceId: z.string().optional(),
  selectedTopicId: z.string().optional().nullable(),
  selectedTaskId: z.string().optional().nullable(),
  forceNewTopic: z.boolean().optional(),
  forceNewTask: z.boolean().optional(),
});

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
  headers.set("content-type", "application/json");
  return headers;
}

async function parseJsonBody(req: NextRequest) {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const body = await parseJsonBody(req);
  if (body === undefined) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ResolveBoardSendRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const base = resolveUpstreamBase();
  if (!base) {
    return NextResponse.json({ detail: "Missing CLAWBOARD_SERVER_API_BASE" }, { status: 500 });
  }

  const targetUrl = `${base}/api/openclaw/resolve-board-send`;
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: "POST",
      headers: buildForwardHeaders(req),
      body: JSON.stringify(parsed.data),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Upstream fetch failed";
    return NextResponse.json({ detail }, { status: 502 });
  }

  const bodyText = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return new NextResponse(bodyText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: { "content-type": contentType || "text/plain; charset=utf-8" },
    });
  }

  try {
    const payload = bodyText ? JSON.parse(bodyText) : {};
    return NextResponse.json(payload, { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Invalid JSON from upstream" }, { status: 502 });
  }
}
