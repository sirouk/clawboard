import { NextRequest, NextResponse } from "next/server";
import { requireToken } from "../../../../lib/auth";
import { normalizeApiBase, resolveServerApiBase } from "../../../../lib/server-api-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isLoopbackHost(hostname: string) {
  const value = String(hostname || "").trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

function isPrivateIpv4Host(hostname: string) {
  const value = String(hostname || "").trim();
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (first === 10 || first === 127) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}

function isLocalishHost(hostname: string) {
  const value = String(hostname || "").trim().toLowerCase();
  return isLoopbackHost(value) || isPrivateIpv4Host(value) || value.endsWith(".local");
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

function resolveBrowserOrigin(request: NextRequest) {
  const forwardedProto = String(request.headers.get("x-forwarded-proto") || "").trim().toLowerCase();
  const forwardedHost = String(request.headers.get("x-forwarded-host") || "").trim();
  const host = (forwardedHost || request.headers.get("host") || request.nextUrl.host || "").split(",")[0]?.trim();
  const protocol = forwardedProto || request.nextUrl.protocol.replace(/:$/, "") || "http";
  if (!host) return null;
  try {
    return new URL(`${protocol}://${host}`);
  } catch {
    return null;
  }
}

function rewriteIdeUrlForBrowser(rawUrl: string | null | undefined, request: NextRequest) {
  const text = normalizeApiBase(String(rawUrl || ""));
  if (!text) return text || null;
  let target: URL;
  try {
    target = new URL(text);
  } catch {
    return text;
  }
  const browserOrigin = resolveBrowserOrigin(request);
  if (!browserOrigin) return text;
  if (browserOrigin.hostname === target.hostname) return text;
  if (!isLocalishHost(browserOrigin.hostname) || !isLocalishHost(target.hostname)) return text;
  target.protocol = browserOrigin.protocol;
  target.hostname = browserOrigin.hostname;
  return target.toString();
}

function rewriteWorkspacePayloadForBrowser(payload: unknown, request: NextRequest) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const baseUrl = rewriteIdeUrlForBrowser(typeof record.baseUrl === "string" ? record.baseUrl : null, request);
  const workspaces = Array.isArray(record.workspaces)
    ? record.workspaces.map((workspace) => {
        if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return workspace;
        const row = workspace as Record<string, unknown>;
        return {
          ...row,
          ideUrl: rewriteIdeUrlForBrowser(typeof row.ideUrl === "string" ? row.ideUrl : null, request),
        };
      })
    : record.workspaces;
  return {
    ...record,
    baseUrl,
    workspaces,
  };
}

export async function GET(req: NextRequest) {
  const authError = requireToken(req, { allowLoopback: true });
  if (authError) return authError;

  const base = resolveServerApiBase();
  if (!base) {
    return NextResponse.json({ detail: "Missing CLAWBOARD_SERVER_API_BASE" }, { status: 500 });
  }

  const targetUrl = `${base}/api/openclaw/workspaces${req.nextUrl.search}`;
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
    return NextResponse.json(rewriteWorkspacePayloadForBrowser(parsed, req), { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Invalid JSON from upstream" }, { status: 502 });
  }
}
