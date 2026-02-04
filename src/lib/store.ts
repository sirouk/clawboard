import { promises as fs } from "fs";
import path from "path";
import { DataStore, LogEntry, Task, Topic } from "@/lib/types";

function nowIso() {
  return new Date().toISOString();
}

function getDataPath() {
  const configured = process.env.CLAWBOARD_DATA_PATH;
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  return path.join(process.cwd(), "data", "portal.json");
}

async function ensureStoreFile() {
  const filePath = getDataPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    const timestamp = nowIso();
    const data: DataStore = {
      instance: {
        title: "Clawboard",
        integrationLevel: "manual",
        updatedAt: timestamp,
      },
      topics: [],
      tasks: [],
      logs: [],
    };

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  }
}

export async function loadStore(): Promise<DataStore> {
  await ensureStoreFile();
  const filePath = getDataPath();
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as DataStore;
}

export async function saveStore(store: DataStore) {
  const filePath = getDataPath();
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf8");
}

export async function updateStore(updater: (store: DataStore) => DataStore) {
  const store = await loadStore();
  const updated = updater(store);
  await saveStore(updated);
  return updated;
}

export function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function upsertTopic(store: DataStore, input: Partial<Topic> & Pick<Topic, "name">) {
  const timestamp = nowIso();
  if (input.id) {
    const idx = store.topics.findIndex((topic) => topic.id === input.id);
    if (idx >= 0) {
      const existing = store.topics[idx];
      const updated: Topic = {
        ...existing,
        ...input,
        name: input.name ?? existing.name,
        updatedAt: timestamp,
      };
      store.topics[idx] = updated;
      return updated;
    }
  }

  const created: Topic = {
    id: createId("topic"),
    name: input.name,
    description: input.description ?? "",
    priority: input.priority ?? "medium",
    status: input.status ?? "active",
    tags: input.tags ?? [],
    parentId: input.parentId ?? null,
    pinned: input.pinned ?? false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.topics.push(created);
  return created;
}

export function upsertTask(store: DataStore, input: Partial<Task> & Pick<Task, "title">) {
  const timestamp = nowIso();
  if (input.id) {
    const idx = store.tasks.findIndex((task) => task.id === input.id);
    if (idx >= 0) {
      const existing = store.tasks[idx];
      const updated: Task = {
        ...existing,
        ...input,
        title: input.title ?? existing.title,
        updatedAt: timestamp,
      };
      store.tasks[idx] = updated;
      return updated;
    }
  }

  const created: Task = {
    id: createId("task"),
    topicId: input.topicId ?? null,
    title: input.title,
    status: input.status ?? "todo",
    pinned: input.pinned ?? false,
    priority: input.priority ?? "medium",
    dueDate: input.dueDate ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.tasks.push(created);
  return created;
}

export function appendLog(store: DataStore, input: Omit<LogEntry, "id" | "createdAt">) {
  const entry: LogEntry = {
    ...input,
    id: createId("log"),
    createdAt: nowIso(),
  };
  store.logs.push(entry);
  return entry;
}
