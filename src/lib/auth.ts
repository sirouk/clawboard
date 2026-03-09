import { NextRequest, NextResponse } from "next/server";

export function isTokenRequired() {
  return Boolean(process.env.CLAWBOARD_TOKEN);
}

function isLoopbackHost(host: string) {
  const normalized = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function requestTargetsLoopback(request: NextRequest) {
  const hostHeader = request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.hostname;
  return isLoopbackHost(hostHeader);
}

type TokenOptions = {
  allowLoopback?: boolean;
};

export function hasValidToken(request: NextRequest, options: TokenOptions = {}) {
  if (!isTokenRequired()) return true;
  if (options.allowLoopback && requestTargetsLoopback(request)) return true;
  const header = request.headers.get("x-clawboard-token");
  const token = process.env.CLAWBOARD_TOKEN;
  if (!token) return true;
  return header === token;
}

export function requireToken(request: NextRequest, options: TokenOptions = {}) {
  if (hasValidToken(request, options)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
