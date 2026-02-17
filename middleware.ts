import { NextResponse, type NextRequest } from "next/server";

const HEADER = "x-clawboard-token";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_TEST_HOSTS = new Set(["testclient", "testserver"]);

function firstForwardedAddress(value?: string | null): string {
  if (!value) return "";
  const forwarded = value.split(",")[0]?.trim();
  if (!forwarded) return "";
  if (forwarded.startsWith("[") && forwarded.endsWith("]")) {
    return forwarded.slice(1, -1);
  }
  return forwarded;
}

function clientAddress(request: NextRequest): string {
  if (process.env.CLAWBOARD_TRUST_PROXY === "1") {
    const forwarded = firstForwardedAddress(request.headers.get("x-forwarded-for"));
    if (forwarded) return forwarded;

    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  const ip = (request as NextRequest & { ip?: string | null }).ip;
  return (ip ?? "").trim();
}

function isTestHost(value?: string | null): boolean {
  if (!value) return false;
  const raw = value.trim().toLowerCase();
  return LOCAL_TEST_HOSTS.has(raw);
}

function isLoopbackAddress(value?: string | null): boolean {
  if (!value) return false;
  const raw = value.trim().toLowerCase();
  if (!raw) return false;
  if (LOCAL_HOSTS.has(raw)) return true;
  if (raw.startsWith("::ffff:127.")) return true;
  if (raw === "0:0:0:0:0:0:0:1") return true;
  if (raw.startsWith("127.")) return true;
  return false;
}

function isLocalRequest(request: NextRequest): boolean {
  const ipAddress = clientAddress(request);
  if (isLoopbackAddress(ipAddress)) return true;
  if (isTestHost(ipAddress)) return true;
  return false;
}

function getExpectedToken() {
  return process.env.CLAWBOARD_TOKEN ?? process.env.PORTAL_TOKEN ?? "";
}

export function middleware(request: NextRequest) {
  const token = getExpectedToken();
  if (!token) {
    return NextResponse.json(
      { detail: "Server misconfigured: missing CLAWBOARD_TOKEN (or PORTAL_TOKEN)" },
      { status: 503 }
    );
  }

  // Tighten surface: do not accept tokens in query params (leaks via logs/referrers).
  if (request.nextUrl.searchParams.has("token")) {
    return NextResponse.json(
      { detail: "Do not pass token via query param. Use X-Clawboard-Token header." },
      { status: 400 }
    );
  }

  const isReadMethod = request.method.toUpperCase() === "GET" || request.method.toUpperCase() === "HEAD";
  if (isReadMethod && isLocalRequest(request)) {
    const localRes = NextResponse.next();
    localRes.headers.set("Cache-Control", "no-store, max-age=0");
    localRes.headers.set("Pragma", "no-cache");
    localRes.headers.set("X-Content-Type-Options", "nosniff");
    return localRes;
  }

  const provided = request.headers.get(HEADER);
  if (!provided || provided !== token) {
    return NextResponse.json(
      { detail: "Unauthorized: invalid or missing X-Clawboard-Token" },
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
