import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireToken } from "../../../../lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ChatRequestSchema = z.object({
  sessionKey: z.string().min(1),
  message: z.string().min(1),
  topicId: z.string().optional().nullable(),
  spaceId: z.string().optional(),
  agentId: z.string().optional(),
  attachmentIds: z.array(z.string()).optional(),
});

const CancelSchema = z.object({
  sessionKey: z.string().min(1),
  requestId: z.string().optional(),
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

async function proxyJsonRequest(request: NextRequest, payload: unknown) {
  const base = resolveUpstreamBase();
  if (!base) {
    return NextResponse.json({ detail: "Missing CLAWBOARD_SERVER_API_BASE" }, { status: 500 });
  }

  const targetUrl = `${base}/api/openclaw/chat`;
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers: buildForwardHeaders(request),
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Upstream fetch failed";
    return NextResponse.json({ detail }, { status: 502 });
  }

  const body = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return new NextResponse(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: { "content-type": contentType || "text/plain; charset=utf-8" },
    });
  }

  try {
    const parsed = body ? JSON.parse(body) : {};
    return NextResponse.json(parsed, { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Invalid JSON from upstream" }, { status: 502 });
  }
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
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  return proxyJsonRequest(req, parsed.data);
}

export async function DELETE(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const body = await parseJsonBody(req);
  if (body === undefined) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = CancelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  return proxyJsonRequest(req, parsed.data);
}
