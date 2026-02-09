export const BOARD_TOPIC_SESSION_PREFIX = "clawboard:topic:" as const;
export const BOARD_TASK_SESSION_PREFIX = "clawboard:task:" as const;

export function topicSessionKey(topicId: string) {
  return `${BOARD_TOPIC_SESSION_PREFIX}${topicId}`;
}

export function taskSessionKey(topicId: string, taskId: string) {
  return `${BOARD_TASK_SESSION_PREFIX}${topicId}:${taskId}`;
}

export function isBoardSessionKey(value: string | undefined | null) {
  const key = (value ?? "").trim();
  return key.startsWith(BOARD_TOPIC_SESSION_PREFIX) || key.startsWith(BOARD_TASK_SESSION_PREFIX);
}

