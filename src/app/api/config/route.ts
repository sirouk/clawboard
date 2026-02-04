import { NextRequest, NextResponse } from "next/server";
import { loadStore, updateStore } from "@/lib/store";
import { hasValidToken, isTokenRequired } from "@/lib/auth";
import type { IntegrationLevel } from "@/lib/types";

export async function GET() {
  const store = await loadStore();
  return NextResponse.json({
    instance: store.instance,
    tokenRequired: isTokenRequired(),
  });
}

export async function POST(request: NextRequest) {
  if (!hasValidToken(request)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { title, integrationLevel } = payload as {
    title?: string;
    integrationLevel?: IntegrationLevel;
  };

  const store = await updateStore((current) => {
    if (title && typeof title === "string") {
      current.instance.title = title.trim();
    }
    if (integrationLevel) {
      current.instance.integrationLevel = integrationLevel;
    }
    current.instance.updatedAt = new Date().toISOString();
    return current;
  });

  return NextResponse.json({ instance: store.instance, tokenRequired: isTokenRequired() });
}
