import { NextRequest, NextResponse } from "next/server";
import { isIP } from "node:net";

export const requireToken = (req: NextRequest) => {
  const token = process.env.CLAWBOARD_TOKEN ?? process.env.PORTAL_TOKEN;
  if (!token) {
    // Fail closed: if the server token isn't configured, do not silently expose endpoints.
    return NextResponse.json(
      { detail: "Server misconfigured: missing CLAWBOARD_TOKEN (or PORTAL_TOKEN)" },
      { status: 503 }
    );
  }

  if (req.nextUrl.searchParams.has("token")) {
    return NextResponse.json(
      { detail: "Do not pass token via query param. Use X-Clawboard-Token header." },
      { status: 400 }
    );
  }

  const isReadMethod = req.method.toUpperCase() === "GET" || req.method.toUpperCase() === "HEAD";
  if (isReadMethod && isLocalRequest(req)) {
    return null;
  }

  const provided = req.headers.get("x-clawboard-token");
  if (!provided || provided !== token) {
    return NextResponse.json(
      { detail: "Unauthorized: invalid or missing X-Clawboard-Token" },
      { status: 401 }
    );
  }
  return null;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_TEST_HOSTS = new Set(["testclient", "testserver"]);

function isTestHost(value?: string | null): boolean {
  if (!value) return false;
  const raw = value.trim().toLowerCase();
  return LOCAL_TEST_HOSTS.has(raw);
}

function firstForwardedAddress(value?: string | null): string {
  if (!value) return "";
  const forwarded = value.split(",")[0]?.trim();
  if (!forwarded) return "";
  if (forwarded.startsWith("[") && forwarded.endsWith("]")) {
    return forwarded.slice(1, -1);
  }
  return forwarded;
}

function clientAddress(req: NextRequest): string {
  if (process.env.CLAWBOARD_TRUST_PROXY === "1") {
    const forwarded = firstForwardedAddress(req.headers.get("x-forwarded-for"));
    if (forwarded) return forwarded;
    const realIp = req.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  const ip = (req as NextRequest & { ip?: string | null }).ip;
  return (ip ?? "").trim();
}

function isLoopbackAddress(value?: string | null): boolean {
  if (!value) return false;
  const raw = value.trim().toLowerCase();
  if (!raw) return false;
  if (LOCAL_HOSTS.has(raw)) return true;
  if (raw.startsWith("::ffff:127.")) return true;
  const family = isIP(raw);
  if (family === 4) {
    return raw.startsWith("127.");
  }
  if (family === 6) {
    return raw === "::1";
  }
  return false;
}

function isLocalRequest(req: NextRequest): boolean {
  const ipAddress = clientAddress(req);
  if (isLoopbackAddress(ipAddress)) return true;
  if (isTestHost(ipAddress)) return true;
  return false;
}
