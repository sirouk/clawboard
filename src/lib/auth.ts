import { NextRequest, NextResponse } from "next/server";

export function isTokenRequired() {
  return Boolean(process.env.CLAWBOARD_TOKEN);
}

export function hasValidToken(request: NextRequest) {
  const token = process.env.CLAWBOARD_TOKEN;
  if (!token) return true;
  const header = request.headers.get("x-clawboard-token");
  return header === token;
}

export function requireToken(request: NextRequest) {
  if (hasValidToken(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
