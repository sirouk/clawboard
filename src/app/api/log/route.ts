import { NextRequest, NextResponse } from "next/server";
import { appendLog, getData } from "../../../../lib/db";
import { requireToken } from "../../../../lib/auth";
import { z } from "zod";
import {
  missingCompatibilityContentDetail,
  toFastApiDetail
} from "../../../../lib/compat_api_validation";

const MAX_STRING = 20_000;
const MAX_TEXT = 40_000;

const AppendLogSchema = z
  .object({
    type: z.string().min(1).max(64).optional(),
    content: z.string().min(1).max(MAX_STRING).optional(),
    summary: z.string().max(MAX_TEXT).optional(),
    raw: z.string().max(MAX_TEXT).optional(),

    topicId: z.string().min(1).max(256).nullable().optional(),
    taskId: z.string().min(1).max(256).nullable().optional(),
    relatedLogId: z.string().min(1).max(256).nullable().optional(),
    idempotencyKey: z.string().min(1).max(256).nullable().optional(),

    source: z.record(z.string(), z.unknown()).nullable().optional(),
    sessionKey: z.string().min(1).max(256).optional(),
    messageId: z.string().min(1).max(256).optional(),
    channel: z.string().min(1).max(128).optional(),

    agentId: z.string().min(1).max(64).optional(),
    agentLabel: z.string().min(1).max(128).optional(),

    createdAt: z.string().max(64).optional(),
    updatedAt: z.string().max(64).optional(),
    classificationStatus: z.string().max(64).optional(),
    classificationAttempts: z.number().int().min(0).max(1_000_000).optional(),
    classificationError: z.string().max(MAX_TEXT).nullable().optional(),

    attachments: z.array(z.unknown()).optional(),
    message: z.string().min(1).max(MAX_STRING).optional(),
    status: z.string().optional(),
  })
  .passthrough();

type CanonicalSource = {
  sessionKey?: string;
  messageId?: string;
  channel?: string;
  [key: string]: unknown;
};

type CanonicalLogPayload = z.infer<typeof AppendLogSchema>;

type CompatibilityLogRecord = Awaited<ReturnType<typeof getData>>["log"][number];

type CanonicalLogResponse = {
  id: string;
  topicId: string | null;
  taskId: string | null;
  relatedLogId: string | null;
  idempotencyKey: string | null;
  type: string;
  content: string;
  summary: string | null;
  raw: string | null;
  classificationStatus: string;
  classificationAttempts: number;
  classificationError: string | null;
  createdAt: string;
  updatedAt: string;
  agentId?: string;
  agentLabel?: string;
  source?: CanonicalSource;
};

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseSource(value: unknown): CanonicalSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const next: CanonicalSource = {};

  const sessionKey = trimString(candidate.sessionKey);
  const messageId = trimString(candidate.messageId);
  const channel = trimString(candidate.channel);

  if (sessionKey) next.sessionKey = sessionKey;
  if (messageId) next.messageId = messageId;
  if (channel) next.channel = channel;

  return Object.keys(next).length > 0 ? next : undefined;
}

function toCanonicalLog(entry: CompatibilityLogRecord): CanonicalLogResponse {
  const source = parseSource({
    sessionKey: entry.sessionKey,
    messageId: entry.messageId,
    channel: entry.channel,
  });

  const output: CanonicalLogResponse = {
    id: entry.id,
    topicId: entry.topicId,
    taskId: null,
    relatedLogId: null,
    idempotencyKey: null,
    type: "conversation",
    content: entry.message,
    summary: entry.message,
    raw: null,
    classificationStatus: "pending",
    classificationAttempts: 0,
    classificationError: null,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
  };

  if (entry.agentId) {
    output.agentId = entry.agentId;
  }
  if (entry.agentLabel) {
    output.agentLabel = entry.agentLabel;
  }
  if (source) {
    output.source = source;
  }

  return output;
}

function toCompatibilityLogInput(payload: CanonicalLogPayload) {
  const message = trimString(payload.content) ?? trimString(payload.message);
  if (!message) return null;

  const source = parseSource(payload.source);
  const sessionKey = source?.sessionKey ?? trimString(payload.sessionKey);
  const messageId = source?.messageId ?? trimString(payload.messageId);
  const channel = source?.channel ?? trimString(payload.channel);

  return {
    message,
    topicId: payload.topicId === null ? null : trimString(payload.topicId) ?? null,
    agentId: trimString(payload.agentId),
    agentLabel: trimString(payload.agentLabel),
    sessionKey: sessionKey || undefined,
    messageId: messageId || undefined,
    channel: channel || undefined,
  };
}

export async function GET(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  const data = await getData();
  const { searchParams } = new URL(req.url);
  const topicId = searchParams.get("topicId");
  const logs = (topicId ? data.log.filter((l) => l.topicId === topicId) : data.log)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toCanonicalLog);

  return NextResponse.json(logs);
}

export async function POST(req: NextRequest) {
  const authError = requireToken(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AppendLogSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ detail: toFastApiDetail(parsed.error) }, { status: 422 });
  }

  const input = toCompatibilityLogInput(parsed.data);
  if (!input) {
    return NextResponse.json(
      { detail: missingCompatibilityContentDetail() },
      { status: 422 }
    );
  }

  const entry = await appendLog(input);
  return NextResponse.json(toCanonicalLog(entry));
}
