import { NextRequest } from "next/server";

export function isTokenRequired() {
  return Boolean(process.env.CLAWBOARD_TOKEN);
}

export function hasValidToken(request: NextRequest) {
  if (!isTokenRequired()) return true;
  const header = request.headers.get("x-clawboard-token");
  const token = process.env.CLAWBOARD_TOKEN;
  if (!token) return true;
  return header === token;
}
