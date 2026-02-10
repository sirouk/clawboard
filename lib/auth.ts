import { NextRequest, NextResponse } from "next/server";

export const requireToken = (req: NextRequest) => {
  const token = process.env.CLAWBOARD_TOKEN ?? process.env.PORTAL_TOKEN;
  if (!token) {
    // Fail closed: if the server token isn't configured, do not silently expose endpoints.
    return NextResponse.json(
      { error: "Server misconfigured: missing CLAWBOARD_TOKEN (or PORTAL_TOKEN)" },
      { status: 500 }
    );
  }
  const provided = req.headers.get("x-clawboard-token");
  if (!provided || provided !== token) {
    return NextResponse.json(
      { error: "Unauthorized: invalid or missing X-Clawboard-Token" },
      { status: 401 }
    );
  }
  return null;
};
