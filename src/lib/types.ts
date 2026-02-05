export type IntegrationLevel = "manual" | "write" | "full";

export type Topic = {
  id: string;
  name: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  status?: "active" | "paused" | "archived";
  tags?: string[];
  parentId?: string | null;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskStatus = "todo" | "doing" | "blocked" | "done";

export type Task = {
  id: string;
  topicId: string | null;
  title: string;
  status: TaskStatus;
  pinned?: boolean;
  priority?: "low" | "medium" | "high";
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LogEntry = {
  id: string;
  topicId: string | null;
  taskId?: string | null;
  relatedLogId?: string | null;
  type: "note" | "conversation" | "action" | "system" | "import";
  content: string;
  summary?: string;
  raw?: string;

  // Async classifier metadata
  classificationStatus?: "pending" | "classified" | "failed";
  classificationAttempts?: number;
  classificationError?: string | null;

  createdAt: string;
  updatedAt?: string;
  agentId?: string;
  agentLabel?: string;
  source?: {
    sessionKey?: string;
    messageId?: string;
    channel?: string;
  };
};

export type InstanceConfig = {
  title: string;
  integrationLevel: IntegrationLevel;
  updatedAt: string;
};

export type DataStore = {
  instance: InstanceConfig;
  topics: Topic[];
  tasks: Task[];
  logs: LogEntry[];
};

export type TopicStats = {
  taskCount: number;
  openCount: number;
  lastActivity?: string | null;
};

export type TopicWithStats = Topic & { stats?: TopicStats };
