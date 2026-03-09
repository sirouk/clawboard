import { NextRequest, NextResponse } from "next/server";
import { requireToken } from "../../../../../lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeBase(raw: string) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function resolveIdeBase() {
  return normalizeBase(
    process.env.CLAWBOARD_WORKSPACE_IDE_INTERNAL_BASE_URL ||
      process.env.CLAWBOARD_WORKSPACE_IDE_BASE_URL ||
      "http://workspace-ide:8080",
  );
}

function readCookieValues(response: Response) {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (values.length > 0) return values.filter(Boolean);
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

export async function POST(req: NextRequest) {
  const authError = requireToken(req, { allowLoopback: true });
  if (authError) return authError;

  const base = resolveIdeBase();
  const password = String(process.env.CLAWBOARD_WORKSPACE_IDE_PASSWORD || "").trim();
  if (!base || !password) {
    return NextResponse.json({ detail: "Workspace IDE auth is not configured." }, { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password }),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Workspace IDE login failed";
    return NextResponse.json({ detail }, { status: 502 });
  }

  const cookies = readCookieValues(upstream);
  if (cookies.length === 0 || (upstream.status !== 302 && upstream.status !== 303 && upstream.status !== 200)) {
    const detail = upstream.statusText || "Workspace IDE rejected login";
    return NextResponse.json({ detail }, { status: 502 });
  }

  const response = NextResponse.json({ ok: true, provider: "code-server" });
  response.headers.set("cache-control", "no-store");
  for (const cookie of cookies) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
