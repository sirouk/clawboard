import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Serves a minimal HTML page that auto-submits a POST form to code-server's
 * /login endpoint. Loaded inside the workspace iframe so the auth cookie
 * lands on code-server's origin (same-site, different port).
 *
 * Query params:
 *   target – full code-server IDE URL (e.g. https://host:10000/?folder=/path)
 *   t      – the token / password
 */
export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("target");
  const token = req.nextUrl.searchParams.get("t");

  if (!target || !token) {
    return new NextResponse("Missing parameters", { status: 400 });
  }

  // Validate that the token matches the server-side CLAWBOARD_TOKEN to prevent
  // this page from being used to probe arbitrary passwords.
  const serverToken = String(process.env.CLAWBOARD_TOKEN || "").trim();
  if (!serverToken || token !== serverToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Extract just the origin (scheme + host + port) for the login POST.
  // The full target URL (with ?folder=... etc.) is used as the redirect after login.
  let loginUrl: string;
  try {
    const parsed = new URL(target);
    loginUrl = `${parsed.origin}/login`;
  } catch {
    loginUrl = `${target.split("?")[0].replace(/\/+$/, "")}/login`;
  }

  // Minimal HTML page: auto-submits the login form, then code-server
  // sets its cookie and redirects to the IDE within this iframe.
  // We include a "to" hidden field — code-server uses this as the redirect
  // destination after successful login.
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background:#0e1116;color:#94a3b8;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<span>Opening workspace…</span>
<form id="f" method="POST" action="${escapeAttr(loginUrl)}">
<input type="hidden" name="password" value="${escapeAttr(token)}"/>
</form>
<script>document.getElementById("f").submit();</script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
