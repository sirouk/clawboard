import { NextResponse, type NextRequest } from "next/server";

const HEADER = "x-clawboard-token";

function getExpectedToken() {
  return process.env.CLAWBOARD_TOKEN ?? process.env.PORTAL_TOKEN ?? "";
}

export function middleware(request: NextRequest) {
  const token = getExpectedToken();
  if (!token) {
    return NextResponse.json(
      { error: "Server misconfigured: missing CLAWBOARD_TOKEN (or PORTAL_TOKEN)" },
      { status: 500 }
    );
  }

  // Tighten surface: do not accept tokens in query params (leaks via logs/referrers).
  if (request.nextUrl.searchParams.has("token")) {
    return NextResponse.json(
      { error: "Do not pass token via query param. Use X-Clawboard-Token header." },
      { status: 400 }
    );
  }

  const provided = request.headers.get(HEADER);
  if (!provided || provided !== token) {
    return NextResponse.json(
      { error: "Unauthorized: invalid or missing X-Clawboard-Token" },
      { status: 401 }
    );
  }

  const res = NextResponse.next();
  // Prevent caching at every hop.
  res.headers.set("Cache-Control", "no-store, max-age=0");
  res.headers.set("Pragma", "no-cache");
  res.headers.set("X-Content-Type-Options", "nosniff");
  return res;
}

export const config = {
  matcher: ["/api/:path*"]
};

