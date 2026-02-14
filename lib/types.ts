export type Status = "todo" | "doing" | "blocked" | "done";

export type Topic = {
  id: string;
  name: string;
  description?: string;
  parentId?: string | null;
  tags?: string[];
  color?: string;
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  topicId: string;
  title: string;
  status: Status;
  color?: string;
  createdAt: string;
  updatedAt: string;
};

export type ActivityLog = {
  id: string;
  topicId: string | null;
  message: string;
  createdAt: string;

  // OpenClaw context (optional but recommended)
  agentId?: string; // e.g. main | coding | web | social
  agentLabel?: string;
  sessionKey?: string;
  messageId?: string;
  channel?: string;
};

export type EventType =
  | "conversation.user"
  | "conversation.assistant"
  | "action"
  | "task";

export type EventSourceMeta = {
  source: "memory" | "api" | "manual" | string;
  filePath?: string;
  section?: string;
  lineNumber?: number;
  cursor?: string;
};

export type Event = {
  id: string;
  type: EventType;
  content: string;
  timestamp: string;
  topicId?: string | null;
  agentId?: string;
  agentLabel?: string;
  source: EventSourceMeta;
  sourceId: string;
  createdAt: string;
  updatedAt: string;
};

export type ImportJobStatus = "pending" | "running" | "done" | "failed";

export type ImportJob = {
  id: string;
  status: ImportJobStatus;
  cursor?: string | null;
  summary?: {
    sessionsFound: number;
    entriesImported: number;
    pending: number;
    failed: number;
    uncategorized: number;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type PortalData = {
  seedVersion?: string;
  topics: Topic[];
  tasks: Task[];
  log: ActivityLog[];
  events: Event[];
  importJobs: ImportJob[];
};
