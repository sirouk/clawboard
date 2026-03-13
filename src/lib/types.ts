export type IntegrationLevel = "manual" | "write" | "full";

export type TopicStatus = "active" | "todo" | "doing" | "blocked" | "done" | "snoozed" | "archived" | "paused";

export type Topic = {
  id: string;
  spaceId?: string;
  name: string;
  createdBy?: "user" | "classifier" | "import";
  sortIndex?: number;
  color?: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  status?: TopicStatus;
  dueDate?: string | null;
  snoozedUntil?: string | null;
  tags?: string[];
  parentId?: string | null;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
};

/** @deprecated Use TopicStatus instead. Kept for backward compatibility. */
export type TaskStatus = "todo" | "doing" | "blocked" | "done";

/** @deprecated Tasks have been merged into Topics. Use Topic instead. */
export type Task = Topic & {
  /** @deprecated Use `name` instead. */
  title?: string;
  /** @deprecated Topics no longer have a topicId; they ARE topics. */
  topicId?: string | null;
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
  spaceId?: string;
  topicId: string | null;
  /** @deprecated Tasks merged into Topics. Kept for backward compat with old data. */
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
    boardScopeSpaceId?: string;
    boardScopeTopicId?: string;
    boardScopeKind?: "topic";
    boardScopeSessionKey?: string;
    boardScopeInherited?: boolean;
    boardScopeLock?: boolean;
    speakerId?: string;
    speakerLabel?: string;
    audienceId?: string;
    audienceLabel?: string;
    orchestration?: boolean;
    runId?: string;
    itemKey?: string;
    eventType?: string;
    runStatus?: "running" | "stalled" | "done" | "failed" | "cancelled";
    runActive?: boolean;
    watchdogMissingAssistant?: boolean;
    requestTerminal?: boolean;
  };
};

export type InstanceConfig = {
  title: string;
  integrationLevel: IntegrationLevel;
  updatedAt: string;
};

export type Space = {
  id: string;
  name: string;
  color?: string | null;
  defaultVisible?: boolean;
  connectivity?: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
};

export type DataStore = {
  instance: InstanceConfig;
  topics: Topic[];
  logs: LogEntry[];
};

export type TopicStats = {
  logCount?: number;
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

export type SemanticLogMatch = {
  id: string;
  topicId?: string | null;
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
  summary?: string;
  content?: string;
  createdAt?: string;
};

export type SemanticSearchResponse = {
  query: string;
  mode: string;
  topics: SemanticTopicMatch[];
  logs: SemanticLogMatch[];
  notes: SemanticNoteMatch[];
  matchedTopicIds: string[];
  matchedLogIds: string[];
};

export type OpenClawWorkspace = {
  agentId: string;
  agentName?: string | null;
  workspaceDir: string;
  ideUrl?: string | null;
  preferred?: boolean;
};

export type OpenClawWorkspacesResponse = {
  configured: boolean;
  provider?: string | null;
  baseUrl?: string | null;
  workspaces: OpenClawWorkspace[];
};
