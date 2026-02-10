import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import os from "os";
import { upsertEvent, updateImportJob } from "./db";
import { Event } from "./types";

const MEMORY_ROOT = "/Users/chris/clawd";
const MEMORY_DIR = path.join(MEMORY_ROOT, "memory");
const MEMORY_FILE = path.join(MEMORY_ROOT, "MEMORY.md");
const AGENTS_ROOT = path.join(os.homedir(), ".openclaw", "agents");

const hashId = (value: string) =>
  crypto.createHash("sha1").update(value).digest("hex");

const isHeading = (line: string) => /^#+\s+/.test(line);
const isListItem = (line: string) => /^\s*([-*+]\s+|\d+[.)]\s+)/.test(line);

const normalizeLine = (line: string) => line.replace(/^\s*([-*+]\s+|\d+[.)]\s+)/, "").trim();

const parseDateFromFilename = (filePath: string) => {
  const base = path.basename(filePath);
  const match = base.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  return new Date(`${match[1]}T09:00:00.000Z`);
};

const inferTopicId = (content: string): string | null => {
  const text = content.toLowerCase();
  if (text.includes("chutes")) return "topic-chutes";
  if (text.includes("thomas") || text.includes("trading") || text.includes("vortex"))
    return "topic-trading";
  if (
    text.includes("ops") ||
    text.includes("finance") ||
    text.includes("invoice") ||
    text.includes("payroll") ||
    text.includes("tax") ||
    text.includes("admin")
  )
    return "topic-ops-admin-finance";
  if (
    text.includes("web3") ||
    text.includes("aptos") ||
    text.includes("open libra") ||
    text.includes("walrus") ||
    text.includes("namada")
  )
    return "topic-web3";
  if (
    text.includes("client") ||
    text.includes("legacy") ||
    text.includes("construction") ||
    text.includes("ingredients")
  )
    return "topic-legacy-clients";
  if (text.includes("personal") || text.includes("chris todo")) return "topic-personal";
  if (text.includes("clawboard") || text.includes("portal")) return "topic-chris-ops-portal";
  if (text.includes("meta")) return "topic-meta";
  return null;
};

const formatContent = (sectionStack: string[], line: string) => {
  if (sectionStack.length === 0) return line.trim();
  return `[${sectionStack.join(" > ")}] ${line.trim()}`;
};

const extractEntries = (filePath: string, text: string, fallbackDate: Date) => {
  const lines = text.split(/\r?\n/);
  const sectionStack: string[] = [];
  const entries: {
    content: string;
    lineNumber: number;
    section?: string;
  }[] = [];

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    if (isHeading(line)) {
      const title = line.replace(/^#+\s+/, "").trim();
      const depth = line.match(/^#+/)?.[0].length ?? 1;
      sectionStack.splice(depth - 1);
      sectionStack[depth - 1] = title;
      return;
    }

    if (isListItem(line)) {
      const cleaned = normalizeLine(line);
      entries.push({
        content: formatContent(sectionStack, cleaned),
        lineNumber: index + 1,
        section: sectionStack.join(" > ")
      });
      return;
    }

    if (line.length > 0) {
      entries.push({
        content: formatContent(sectionStack, line),
        lineNumber: index + 1,
        section: sectionStack.join(" > ")
      });
    }
  });

  const timestamp = fallbackDate.toISOString();
  return { entries, timestamp };
};

export const scanMemorySources = async () => {
  const files: string[] = [];
  try {
    const memoryFiles = await fs.readdir(MEMORY_DIR);
    for (const file of memoryFiles) {
      if (file.endsWith(".md")) files.push(path.join(MEMORY_DIR, file));
    }
  } catch {
    // ignore missing
  }
  files.push(MEMORY_FILE);
  return files;
};

export const scanSessionSources = async () => {
  const files: string[] = [];
  try {
    const agents = await fs.readdir(AGENTS_ROOT);
    for (const agent of agents) {
      const sessionsDir = path.join(AGENTS_ROOT, agent, "sessions");
      try {
        const sessionFiles = await fs.readdir(sessionsDir);
        for (const file of sessionFiles) {
          if (file.endsWith(".jsonl")) files.push(path.join(sessionsDir, file));
        }
      } catch {
        // ignore missing
      }
    }
  } catch {
    // ignore missing
  }
  return files;
};

type CursorState = {
  sourceType: "session" | "memory";
  filePath: string;
  lineIndex: number;
};

const parseCursor = (cursor?: string | null): CursorState | null => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as CursorState;
    if (!parsed?.filePath || !parsed.sourceType || !parsed.lineIndex) return null;
    return parsed;
  } catch {
    return null;
  }
};

const serializeCursor = (state: CursorState | null) =>
  state ? JSON.stringify(state) : null;

const extractMessageContent = (payload: any): string => {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return payload
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text ?? "";
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof payload?.text === "string") return payload.text;
  return "";
};

const extractToolCalls = (payload: any) => {
  if (!Array.isArray(payload)) return [] as any[];
  return payload.filter((part) => part?.type === "toolCall" || part?.type === "toolResult");
};

const formatToolContent = (toolCall: any) => {
  const name = toolCall?.name ?? toolCall?.toolName ?? "tool";
  const args = toolCall?.arguments ?? toolCall?.input ?? null;
  if (args === null || args === undefined) return `tool:${name}`;
  try {
    return `tool:${name} ${JSON.stringify(args)}`;
  } catch {
    return `tool:${name}`;
  }
};

const parseSessionTimestamp = (record: any) => {
  if (record?.message?.timestamp) {
    return new Date(record.message.timestamp).toISOString();
  }
  if (record?.timestamp) {
    return new Date(record.timestamp).toISOString();
  }
  return new Date().toISOString();
};

export const importMemory = async (options?: {
  cursor?: string | null;
  jobId?: string;
}) => {
  const sessionFiles = await scanSessionSources();
  const memoryFiles = await scanMemorySources();
  const sources = [
    ...sessionFiles.map((filePath) => ({ sourceType: "session" as const, filePath })),
    ...memoryFiles.map((filePath) => ({ sourceType: "memory" as const, filePath }))
  ].sort((a, b) => a.sourceType.localeCompare(b.sourceType) || a.filePath.localeCompare(b.filePath));

  let entriesImported = 0;
  let failed = 0;
  let uncategorized = 0;
  let processedEntries = 0;
  let processedSources = 0;
  let lastCursorState: CursorState | null = null;
  let cursorState = parseCursor(options?.cursor ?? null);

  for (const source of sources) {
    if (cursorState) {
      if (cursorState.sourceType !== source.sourceType || cursorState.filePath !== source.filePath) {
        continue;
      }
    }

    processedSources += 1;

    if (source.sourceType === "memory") {
      try {
        const text = await fs.readFile(source.filePath, "utf8");
        const stats = await fs.stat(source.filePath);
        const dateFromName = parseDateFromFilename(source.filePath);
        const fallbackDate = dateFromName ?? stats.mtime;
        const { entries, timestamp } = extractEntries(source.filePath, text, fallbackDate);

        for (const entry of entries) {
          if (cursorState && entry.lineNumber <= cursorState.lineIndex) continue;

          const sourceId = hashId(`${source.filePath}|${entry.lineNumber}`);
          const topicId = inferTopicId(entry.content);
          const result = await upsertEvent({
            type: "conversation.assistant",
            content: entry.content,
            timestamp,
            topicId,
            source: {
              source: "memory",
              filePath: source.filePath,
              section: entry.section,
              lineNumber: entry.lineNumber
            },
            sourceId
          });
          if (result.created) entriesImported += 1;
          if (!topicId) uncategorized += 1;

          processedEntries += 1;
          lastCursorState = {
            sourceType: source.sourceType,
            filePath: source.filePath,
            lineIndex: entry.lineNumber
          };

          if (options?.jobId && processedEntries % 200 === 0) {
            await updateImportJob(options.jobId, {
              cursor: serializeCursor(lastCursorState)
            });
          }
        }
      } catch {
        failed += 1;
      }
    } else {
      try {
        const raw = await fs.readFile(source.filePath, "utf8");
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const agentId = path.basename(path.dirname(path.dirname(source.filePath)));

        for (let index = 0; index < lines.length; index += 1) {
          const lineNumber = index + 1;
          if (cursorState && lineNumber <= cursorState.lineIndex) continue;

          let record: any;
          try {
            record = JSON.parse(lines[index]);
          } catch {
            failed += 1;
            continue;
          }

          if (record?.type !== "message") continue;
          const role = record?.message?.role;

          const content = extractMessageContent(record?.message?.content);
          if (role === "user" || role === "assistant") {
            if (content) {
              const sourceId = hashId(`${source.filePath}|${record?.id ?? lineNumber}`);
              const topicId = inferTopicId(content);
              const type = role === "user" ? "conversation.user" : "conversation.assistant";

              const result = await upsertEvent({
                type,
                content,
                timestamp: parseSessionTimestamp(record),
                topicId,
                agentId,
                agentLabel: agentId,
                source: {
                  source: "session",
                  filePath: source.filePath,
                  lineNumber,
                  cursor: record?.id
                },
                sourceId
              });
              if (result.created) entriesImported += 1;
              if (!topicId) uncategorized += 1;
              processedEntries += 1;
            }
          }

          const toolCalls = extractToolCalls(record?.message?.content);
          for (const toolCall of toolCalls) {
            const toolContent = formatToolContent(toolCall);
            const toolSourceId = hashId(
              `${source.filePath}|${record?.id ?? lineNumber}|${toolCall?.id ?? toolCall?.name ?? "tool"}`
            );
            const toolTopicId = inferTopicId(toolContent);

            const result = await upsertEvent({
              type: "action",
              content: toolContent,
              timestamp: parseSessionTimestamp(record),
              topicId: toolTopicId,
              agentId,
              agentLabel: agentId,
              source: {
                source: "session",
                filePath: source.filePath,
                lineNumber,
                cursor: `${record?.id ?? "line"}:${toolCall?.id ?? toolCall?.name ?? "tool"}`
              },
              sourceId: toolSourceId
            });
            if (result.created) entriesImported += 1;
            if (!toolTopicId) uncategorized += 1;
            processedEntries += 1;
          }

          lastCursorState = {
            sourceType: source.sourceType,
            filePath: source.filePath,
            lineIndex: lineNumber
          };

          if (options?.jobId && processedEntries % 200 === 0) {
            await updateImportJob(options.jobId, {
              cursor: serializeCursor(lastCursorState)
            });
          }
        }
      } catch {
        failed += 1;
      }
    }

    cursorState = null;
  }

  return {
    summary: {
      sessionsFound: sources.length,
      entriesImported,
      pending: 0,
      failed,
      uncategorized
    },
    cursor: serializeCursor(lastCursorState)
  };
};

export const buildEventFilter = (events: Event[], filters: {
  topicId?: string | null;
  type?: Event["type"] | null;
  query?: string | null;
  source?: string | null;
}) => {
  const query = filters.query?.toLowerCase().trim();
  return events
    .filter((event) => (filters.topicId ? event.topicId === filters.topicId : true))
    .filter((event) => (filters.type ? event.type === filters.type : true))
    .filter((event) => (filters.source ? event.source.source === filters.source : true))
    .filter((event) => {
      if (!query) return true;
      const haystack = `${event.content} ${event.agentId ?? ""}`.toLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
};
