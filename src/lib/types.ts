export type IntegrationLevel = "manual" | "write" | "full";

export type Topic = {
  id: string;
  name: string;
  createdBy?: "user" | "classifier" | "import";
  sortIndex?: number;
  color?: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  // "paused" is a legacy alias retained for backward compatibility.
  status?: "active" | "snoozed" | "archived" | "paused";
  snoozedUntil?: string | null;
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
  sortIndex?: number;
  color?: string;
  status: TaskStatus;
  pinned?: boolean;
  priority?: "low" | "medium" | "high";
  dueDate?: string | null;
  snoozedUntil?: string | null;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
};

export type Attachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type Draft = {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
};

export type LogEntry = {
  id: string;
  topicId: string | null;
  taskId?: string | null;
  relatedLogId?: string | null;
  idempotencyKey?: string | null;
  type: "note" | "conversation" | "action" | "system" | "import";
  content: string;
  summary?: string;
  raw?: string;
  attachments?: Attachment[] | null;

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
    requestId?: string;
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

export type SemanticTopicMatch = {
  id: string;
  name: string;
  description?: string | null;
  score: number;
  noteWeight?: number;
  sessionBoosted?: boolean;
};

export type SemanticTaskMatch = {
  id: string;
  topicId?: string | null;
  title: string;
  status?: TaskStatus;
  score: number;
  noteWeight?: number;
  sessionBoosted?: boolean;
};

export type SemanticLogMatch = {
  id: string;
  topicId?: string | null;
  taskId?: string | null;
  type: LogEntry["type"];
  agentId?: string | null;
  agentLabel?: string | null;
  summary?: string;
  content?: string;
  createdAt?: string;
  score: number;
  noteCount?: number;
  noteWeight?: number;
  sessionBoosted?: boolean;
};

export type SemanticNoteMatch = {
  id: string;
  relatedLogId?: string | null;
  topicId?: string | null;
  taskId?: string | null;
  summary?: string;
  content?: string;
  createdAt?: string;
};

export type SemanticSearchResponse = {
  query: string;
  mode: string;
  topics: SemanticTopicMatch[];
  tasks: SemanticTaskMatch[];
  logs: SemanticLogMatch[];
  notes: SemanticNoteMatch[];
  matchedTopicIds: string[];
  matchedTaskIds: string[];
  matchedLogIds: string[];
};
