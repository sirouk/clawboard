import { NextRequest, NextResponse } from "next/server";
import { resolveServerApiBase } from "@/lib/server-api-base";

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

const warnedLegacyRoutes = new Set<string>();

type ProxyApiOptions = {
  legacyRouteId?: string;
};

function buildForwardHeaders(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  for (const key of HOP_BY_HOP_HEADERS) headers.delete(key);
  return headers;
}

function buildResponseHeaders(upstream: Response, options: ProxyApiOptions) {
  const headers = new Headers(upstream.headers);
  for (const key of HOP_BY_HOP_HEADERS) headers.delete(key);
  headers.set("x-clawboard-api-owner", "fastapi");
  if (options.legacyRouteId) {
    headers.set("x-clawboard-api-compat", "legacy-next-shim");
    headers.set("x-clawboard-api-legacy-route", options.legacyRouteId);
  }
  return headers;
}

function warnLegacyRouteOnce(
  request: NextRequest,
  legacyRouteId: string,
  status: "proxied" | "blocked",
  targetPath?: string,
) {
  const key = `${status}:${request.method.toUpperCase()}:${legacyRouteId}`;
  if (warnedLegacyRoutes.has(key)) return;
  warnedLegacyRoutes.add(key);

  const suffix = targetPath ? ` -> ${targetPath}` : "";
  // Route-usage telemetry for deprecation and ownership migration.
  console.warn(
    `[api-ownership] Legacy Next API route ${status}: ${request.method.toUpperCase()} ${legacyRouteId}${suffix}`,
  );
}

export async function proxyApiRequest(
  request: NextRequest,
  upstreamPath: string,
  options: ProxyApiOptions = {},
) {
  if (options.legacyRouteId) {
    warnLegacyRouteOnce(request, options.legacyRouteId, "proxied", upstreamPath);
  }

  const base = resolveServerApiBase();
  if (!base) {
    return NextResponse.json({ detail: "Missing CLAWBOARD_SERVER_API_BASE" }, { status: 500 });
  }

  const normalizedPath = upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`;
  const targetUrl = `${base}${normalizedPath}${request.nextUrl.search}`;
  const init: RequestInit = {
    method: request.method,
    headers: buildForwardHeaders(request),
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
    headers: buildResponseHeaders(upstream, options),
  });
}

export function blockLegacyApiRoute(request: NextRequest, legacyRouteId: string, detail: string) {
  warnLegacyRouteOnce(request, legacyRouteId, "blocked");
  return NextResponse.json(
    {
      error: "Deprecated API route",
      detail,
    },
    {
      status: 410,
      headers: {
        "x-clawboard-api-owner": "nextjs",
        "x-clawboard-api-compat": "legacy-next-blocked",
        "x-clawboard-api-legacy-route": legacyRouteId,
      },
    },
  );
}
