import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  ActivityLog,
  Event,
  ImportJob,
  PortalData,
  Status,
  Task,
  Topic
} from "./types";
import { prisma } from "./prisma";

const DATA_PATH =
  process.env.PORTAL_DATA_PATH ?? path.join(process.cwd(), "data", "portal.json");

const SEED_VERSION = "2026-02-03b";

const nowIso = () => new Date().toISOString();

const seedData = (): PortalData => {
  const createdAt = nowIso();
  const topics: Topic[] = [
    {
      id: "topic-chutes",
      name: "Chutes (KorBon)",
      description: "Primary KorBon initiatives.",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "topic-trading",
      name: "Trading (THOMAS/Vortex)",
      description: "Trading systems and related ops.",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "topic-ops-admin-finance",
      name: "Ops/Admin/Finance",
      description: "Operations, admin, and finance tasks.",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "topic-web3",
      name: "Web3",
      description: "Web3 initiatives.",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "topic-legacy-clients",
      name: "Legacy Clients",
      description: "Ongoing legacy client work.",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "topic-personal",
      name: "Personal",
      description: "Chris personal tasks and goals.",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "topic-chris-ops-portal",
      name: "Chris Ops Portal",
      description: "The portal itself: backlog, improvements, and backfill work.",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "topic-meta",
      name: "Off-topic / Meta",
      description: "Meta notes, ideas, or uncategorized log entries.",
      createdAt,
      updatedAt: createdAt
    }
  ];

  const tasks: Task[] = [
    {
      id: "task-seed-mvp",
      topicId: "topic-ops-admin-finance",
      title: "Seed portal baseline tasks (business + personal)",
      status: "todo",
      createdAt,
      updatedAt: createdAt
    }
  ];

  const log: ActivityLog[] = [
    {
      id: "log-seed",
      topicId: null,
      message: "Seeded initial KorBon Ops Portal data.",
      createdAt
    }
  ];

  const events: Event[] = [];
  const importJobs: ImportJob[] = [];

  return { seedVersion: SEED_VERSION, topics, tasks, log, events, importJobs };
};

const parseDate = (value?: string | Date | null) =>
  value ? new Date(value) : undefined;

const toIso = (value?: Date | null) => (value ? value.toISOString() : undefined);

const parseJson = <T,>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const parseJsonOptional = <T,>(value: unknown): T | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const normalizeTags = (tags: unknown): string[] => {
  if (Array.isArray(tags)) {
    return tags.filter((t): t is string => typeof t === "string");
  }
  if (typeof tags === "string") {
    const parsed = parseJson<unknown>(tags, []);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string");
    }
  }
  return [];
};

const readJson = async (): Promise<PortalData | null> => {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    return JSON.parse(raw) as PortalData;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    return null;
  }
};

const serializeTopic = (topic: {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  tags: unknown;
  createdAt: Date;
  updatedAt: Date;
}): Topic => ({
  id: topic.id,
  name: topic.name,
  description: topic.description ?? undefined,
  parentId: topic.parentId ?? null,
  tags: normalizeTags(topic.tags),
  createdAt: topic.createdAt.toISOString(),
  updatedAt: topic.updatedAt.toISOString()
});

const serializeTask = (task: {
  id: string;
  topicId: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): Task => ({
  id: task.id,
  topicId: task.topicId,
  title: task.title,
  status: task.status as Status,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString()
});

const serializeLog = (entry: {
  id: string;
  topicId: string | null;
  message: string;
  createdAt: Date;
  agentId: string | null;
  agentLabel: string | null;
  sessionKey: string | null;
  messageId: string | null;
  channel: string | null;
}): ActivityLog => ({
  id: entry.id,
  topicId: entry.topicId,
  message: entry.message,
  createdAt: entry.createdAt.toISOString(),
  agentId: entry.agentId ?? undefined,
  agentLabel: entry.agentLabel ?? undefined,
  sessionKey: entry.sessionKey ?? undefined,
  messageId: entry.messageId ?? undefined,
  channel: entry.channel ?? undefined
});

const serializeEvent = (event: {
  id: string;
  type: string;
  content: string;
  timestamp: Date;
  topicId: string | null;
  agentId: string | null;
  agentLabel: string | null;
  source: unknown;
  sourceId: string;
  createdAt: Date;
  updatedAt: Date;
}): Event => ({
  id: event.id,
  type: event.type as Event["type"],
  content: event.content,
  timestamp: event.timestamp.toISOString(),
  topicId: event.topicId ?? null,
  agentId: event.agentId ?? undefined,
  agentLabel: event.agentLabel ?? undefined,
  source: parseJson<Event["source"]>(event.source, { source: "unknown" }),
  sourceId: event.sourceId,
  createdAt: event.createdAt.toISOString(),
  updatedAt: event.updatedAt.toISOString()
});

const serializeImportJob = (job: {
  id: string;
  status: string;
  cursor: string | null;
  summary: unknown;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): ImportJob => ({
  id: job.id,
  status: job.status as ImportJob["status"],
  cursor: job.cursor ?? null,
  summary: parseJsonOptional<ImportJob["summary"]>(job.summary),
  error: job.error ?? undefined,
  createdAt: job.createdAt.toISOString(),
  updatedAt: job.updatedAt.toISOString(),
  startedAt: toIso(job.startedAt),
  finishedAt: toIso(job.finishedAt)
});

let seedPromise: Promise<void> | null = null;

const migrateFromJsonIfNeeded = async () => {
  const [topicCount, taskCount, logCount, eventCount, importCount] =
    await prisma.$transaction([
      prisma.topic.count(),
      prisma.task.count(),
      prisma.activityLog.count(),
      prisma.event.count(),
      prisma.importJob.count()
    ]);

  if (topicCount + taskCount + logCount + eventCount + importCount > 0) return;

  const legacy = await readJson();
  if (!legacy) return;

  await prisma.workspaceConfig.upsert({
    where: { id: "default" },
    update: { seedVersion: legacy.seedVersion ?? SEED_VERSION },
    create: {
      id: "default",
      seedVersion: legacy.seedVersion ?? SEED_VERSION
    }
  });

  // Since we checked for empty DB, no duplicates expected
  await prisma.topic.createMany({
    data: legacy.topics.map((topic) => ({
      id: topic.id,
      name: topic.name,
      description: topic.description ?? null,
      parentId: topic.parentId ?? null,
      tags: JSON.stringify(topic.tags ?? []),
      createdAt: parseDate(topic.createdAt) ?? new Date(),
      updatedAt: parseDate(topic.updatedAt) ?? new Date()
    }))
  });

  await prisma.task.createMany({
    data: legacy.tasks.map((task) => ({
      id: task.id,
      topicId: task.topicId,
      title: task.title,
      status: task.status,
      createdAt: parseDate(task.createdAt) ?? new Date(),
      updatedAt: parseDate(task.updatedAt) ?? new Date()
    }))
  });

  await prisma.activityLog.createMany({
    data: legacy.log.map((entry) => ({
      id: entry.id,
      topicId: entry.topicId ?? null,
      message: entry.message,
      createdAt: parseDate(entry.createdAt) ?? new Date(),
      agentId: entry.agentId ?? null,
      agentLabel: entry.agentLabel ?? null,
      sessionKey: entry.sessionKey ?? null,
      messageId: entry.messageId ?? null,
      channel: entry.channel ?? null
    }))
  });

  await prisma.event.createMany({
    data: legacy.events.map((event) => ({
      id: event.id,
      type: event.type,
      content: event.content,
      timestamp: parseDate(event.timestamp) ?? new Date(),
      topicId: event.topicId ?? null,
      agentId: event.agentId ?? null,
      agentLabel: event.agentLabel ?? null,
      source: JSON.stringify(event.source ?? { source: "legacy" }),
      sourceId: event.sourceId,
      createdAt: parseDate(event.createdAt) ?? new Date(),
      updatedAt: parseDate(event.updatedAt) ?? new Date()
    }))
  });

  await prisma.importJob.createMany({
    data: legacy.importJobs.map((job) => ({
      id: job.id,
      status: job.status,
      cursor: job.cursor ?? null,
      summary: job.summary ? JSON.stringify(job.summary) : null,
      error: job.error ?? null,
      createdAt: parseDate(job.createdAt) ?? new Date(),
      updatedAt: parseDate(job.updatedAt) ?? new Date(),
      startedAt: parseDate(job.startedAt) ?? null,
      finishedAt: parseDate(job.finishedAt) ?? null
    }))
  });
};

const ensureSeeded = async () => {
  if (!seedPromise) {
    seedPromise = (async () => {
      await migrateFromJsonIfNeeded();

      const config = await prisma.workspaceConfig.findUnique({
        where: { id: "default" }
      });

      if (!config) {
        await prisma.workspaceConfig.create({
          data: { id: "default", seedVersion: SEED_VERSION }
        });
      } else if (config.seedVersion !== SEED_VERSION) {
        await prisma.workspaceConfig.update({
          where: { id: config.id },
          data: { seedVersion: SEED_VERSION }
        });
      }

      const seeded = seedData();

      // Use upsert for seeded data to handle duplicates gracefully
      for (const topic of seeded.topics) {
        await prisma.topic.upsert({
          where: { id: topic.id },
          update: {},
          create: {
            id: topic.id,
            name: topic.name,
            description: topic.description ?? null,
            parentId: topic.parentId ?? null,
            tags: JSON.stringify(topic.tags ?? []),
            createdAt: parseDate(topic.createdAt) ?? new Date(),
            updatedAt: parseDate(topic.updatedAt) ?? new Date()
          }
        });
      }

      for (const task of seeded.tasks) {
        await prisma.task.upsert({
          where: { id: task.id },
          update: {},
          create: {
            id: task.id,
            topicId: task.topicId,
            title: task.title,
            status: task.status,
            createdAt: parseDate(task.createdAt) ?? new Date(),
            updatedAt: parseDate(task.updatedAt) ?? new Date()
          }
        });
      }

      for (const entry of seeded.log) {
        await prisma.activityLog.upsert({
          where: { id: entry.id },
          update: {},
          create: {
            id: entry.id,
            topicId: entry.topicId ?? null,
            message: entry.message,
            createdAt: parseDate(entry.createdAt) ?? new Date()
          }
        });
      }
    })();
  }

  return seedPromise;
};

export const getData = async (): Promise<PortalData> => {
  await ensureSeeded();
  const [config, topics, tasks, log, events, importJobs] =
    await prisma.$transaction([
      prisma.workspaceConfig.findUnique({ where: { id: "default" } }),
      prisma.topic.findMany(),
      prisma.task.findMany(),
      prisma.activityLog.findMany(),
      prisma.event.findMany(),
      prisma.importJob.findMany()
    ]);

  return {
    seedVersion: config?.seedVersion ?? SEED_VERSION,
    topics: topics.map(serializeTopic),
    tasks: tasks.map(serializeTask),
    log: log.map(serializeLog),
    events: events.map(serializeEvent),
    importJobs: importJobs.map(serializeImportJob)
  };
};

export const createTopic = async (input: {
  name: string;
  description?: string;
  parentId?: string | null;
  tags?: string[];
  id?: string;
}) => {
  await ensureSeeded();
  const id = input.id ?? `topic-${crypto.randomUUID()}`;
  const createdAt = new Date();
  const topic = await prisma.topic.create({
    data: {
      id,
      name: input.name,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      tags: JSON.stringify(input.tags ?? []),
      createdAt,
      updatedAt: createdAt
    }
  });
  return serializeTopic(topic);
};

export const ensureTopic = async (input: {
  id?: string;
  name: string;
  description?: string;
  parentId?: string | null;
  tags?: string[];
}) => {
  await ensureSeeded();
  const match = input.id
    ? await prisma.topic.findUnique({ where: { id: input.id } })
    : await prisma.topic.findFirst({ where: { name: input.name } });

  if (match) {
    const updated = await prisma.topic.update({
      where: { id: match.id },
      data: {
        name: input.name ?? match.name,
        description: input.description ?? match.description,
        parentId: input.parentId ?? match.parentId,
        tags: JSON.stringify(input.tags ?? normalizeTags(match.tags)),
        updatedAt: new Date()
      }
    });
    return { topic: serializeTopic(updated), created: false };
  }

  const topic = await prisma.topic.create({
    data: {
      id: input.id ?? `topic-${crypto.randomUUID()}`,
      name: input.name,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      tags: JSON.stringify(input.tags ?? []),
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });

  return { topic: serializeTopic(topic), created: true };
};

export const patchTopic = async (
  id: string,
  input: Partial<Pick<Topic, "name" | "description" | "parentId" | "tags">>
) => {
  await ensureSeeded();
  const existing = await prisma.topic.findUnique({ where: { id } });
  if (!existing) return null;

  const updated = await prisma.topic.update({
    where: { id },
    data: {
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      parentId: input.parentId ?? existing.parentId,
      tags: JSON.stringify(input.tags ?? normalizeTags(existing.tags)),
      updatedAt: new Date()
    }
  });

  return serializeTopic(updated);
};

export const deleteTopic = async (id: string) => {
  await ensureSeeded();
  await prisma.$transaction([
    prisma.task.deleteMany({ where: { topicId: id } }),
    prisma.activityLog.deleteMany({ where: { topicId: id } }),
    prisma.event.deleteMany({ where: { topicId: id } }),
    prisma.topic.delete({ where: { id } })
  ]);
};

export const createTask = async (input: {
  topicId: string;
  title: string;
  status?: Status;
  id?: string;
}) => {
  await ensureSeeded();
  const id = input.id ?? `task-${crypto.randomUUID()}`;
  const createdAt = new Date();
  const task = await prisma.task.create({
    data: {
      id,
      topicId: input.topicId,
      title: input.title,
      status: input.status ?? "todo",
      createdAt,
      updatedAt: createdAt
    }
  });
  return serializeTask(task);
};

export const upsertTask = async (input: {
  id?: string;
  topicId: string;
  title: string;
  status?: Status;
}) => {
  await ensureSeeded();
  if (input.id) {
    const existing = await prisma.task.findUnique({ where: { id: input.id } });
    if (existing) {
      const updated = await prisma.task.update({
        where: { id: input.id },
        data: {
          topicId: input.topicId ?? existing.topicId,
          title: input.title ?? existing.title,
          status: input.status ?? (existing.status as Status),
          updatedAt: new Date()
        }
      });
      return { task: serializeTask(updated), created: false };
    }
  }

  const task = await createTask({
    id: input.id,
    topicId: input.topicId,
    title: input.title,
    status: input.status
  });
  return { task, created: true };
};

export const patchTask = async (
  id: string,
  input: Partial<Pick<Task, "title" | "status" | "topicId">>
) => {
  await ensureSeeded();
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing) return null;

  const updated = await prisma.task.update({
    where: { id },
    data: {
      title: input.title ?? existing.title,
      status: input.status ?? (existing.status as Status),
      topicId: input.topicId ?? existing.topicId,
      updatedAt: new Date()
    }
  });
  return serializeTask(updated);
};

export const deleteTask = async (id: string) => {
  await ensureSeeded();
  await prisma.task.delete({ where: { id } });
};

export const appendLog = async (input: {
  message: string;
  topicId: string | null;
  agentId?: string;
  agentLabel?: string;
  sessionKey?: string;
  messageId?: string;
  channel?: string;
}) => {
  await ensureSeeded();
  const entry = await prisma.activityLog.create({
    data: {
      id: `log-${crypto.randomUUID()}`,
      topicId: input.topicId ?? null,
      message: input.message,
      createdAt: new Date(),
      agentId: input.agentId ?? null,
      agentLabel: input.agentLabel ?? null,
      sessionKey: input.sessionKey ?? null,
      messageId: input.messageId ?? null,
      channel: input.channel ?? null
    }
  });
  return serializeLog(entry);
};

export const appendEvent = async (input: {
  type: Event["type"];
  content: string;
  timestamp: string;
  topicId?: string | null;
  agentId?: string;
  agentLabel?: string;
  source: Event["source"];
  sourceId: string;
}) => {
  await ensureSeeded();
  const existing = await prisma.event.findUnique({
    where: { sourceId: input.sourceId }
  });
  if (existing) {
    return { created: false, entry: serializeEvent(existing) };
  }

  const createdAt = new Date();
  const event = await prisma.event.create({
    data: {
      id: `evt-${crypto.randomUUID()}`,
      type: input.type,
      content: input.content,
      timestamp: new Date(input.timestamp),
      topicId: input.topicId ?? null,
      agentId: input.agentId ?? null,
      agentLabel: input.agentLabel ?? null,
      source: JSON.stringify(input.source),
      sourceId: input.sourceId,
      createdAt,
      updatedAt: createdAt
    }
  });

  return { created: true, entry: serializeEvent(event) };
};

export const upsertEvent = async (input: {
  type: Event["type"];
  content: string;
  timestamp: string;
  topicId?: string | null;
  agentId?: string;
  agentLabel?: string;
  source: Event["source"];
  sourceId: string;
}) => {
  await ensureSeeded();
  const existing = await prisma.event.findUnique({
    where: { sourceId: input.sourceId }
  });
  if (existing) {
    const updated = await prisma.event.update({
      where: { sourceId: input.sourceId },
      data: {
        type: input.type,
        content: input.content,
        timestamp: new Date(input.timestamp),
        topicId: input.topicId ?? null,
        agentId: input.agentId ?? null,
        agentLabel: input.agentLabel ?? null,
        source: JSON.stringify(input.source),
        updatedAt: new Date()
      }
    });
    return { created: false, entry: serializeEvent(updated) };
  }

  return appendEvent(input);
};

export const createImportJob = async () => {
  await ensureSeeded();
  const createdAt = new Date();
  const job = await prisma.importJob.create({
    data: {
      id: `import-${crypto.randomUUID()}`,
      status: "pending",
      cursor: null,
      createdAt,
      updatedAt: createdAt
    }
  });
  return serializeImportJob(job);
};

export const updateImportJob = async (
  id: string,
  patch: Partial<Omit<ImportJob, "id" | "createdAt">>
) => {
  await ensureSeeded();
  const existing = await prisma.importJob.findUnique({ where: { id } });
  if (!existing) return null;

  const updated = await prisma.importJob.update({
    where: { id },
    data: {
      status: patch.status ?? existing.status,
      cursor: patch.cursor ?? existing.cursor,
      summary: patch.summary ? JSON.stringify(patch.summary) : existing.summary,
      error: patch.error ?? existing.error,
      startedAt: patch.startedAt ? new Date(patch.startedAt) : existing.startedAt,
      finishedAt: patch.finishedAt
        ? new Date(patch.finishedAt)
        : existing.finishedAt,
      updatedAt: new Date()
    }
  });
  return serializeImportJob(updated);
};

export const getImportJob = async (id: string) => {
  await ensureSeeded();
  const job = await prisma.importJob.findUnique({ where: { id } });
  return job ? serializeImportJob(job) : null;
};

export const getLatestImportJob = async () => {
  await ensureSeeded();
  const latest = await prisma.importJob.findFirst({
    orderBy: { createdAt: "desc" }
  });
  return latest ? serializeImportJob(latest) : null;
};

export const listEvents = async (filters: {
  topicId?: string | null;
  type?: Event["type"] | null;
  query?: string | null;
  source?: string | null;
  limit?: number;
}) => {
  await ensureSeeded();
  const where: { topicId?: string; type?: Event["type"] } = {};
  if (filters.topicId) where.topicId = filters.topicId;
  if (filters.type) where.type = filters.type;

  const events = (await prisma.event.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: filters.limit && filters.limit > 0 ? filters.limit : undefined
  })) as Array<Parameters<typeof serializeEvent>[0]>;

  const query = filters.query?.toLowerCase().trim();
  const filtered = events.filter((event) => {
    if (filters.source) {
      const parsed = parseJson<Event["source"]>(event.source, { source: "unknown" });
      if (parsed.source !== filters.source) return false;
    }
    if (!query) return true;
    return `${event.content} ${event.agentId ?? ""}`
      .toLowerCase()
      .includes(query);
  });

  return filtered.map(serializeEvent);
};
