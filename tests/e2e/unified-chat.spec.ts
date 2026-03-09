import { expect, test, type Page } from "@playwright/test";

async function ensureBoardOptionsVisible(page: Page) {
  const toolCallsToggle = page.getByRole("button", { name: /Show tool calls|Hide tool calls/i }).first();
  const fullMessagesToggle = page.getByRole("button", { name: /Show full messages|Hide full messages/i }).first();
  if ((await toolCallsToggle.count()) > 0 || (await fullMessagesToggle.count()) > 0) return;
  const optionsToggle = page.getByRole("button", { name: /View options|Hide options/i }).first();
  await expect(optionsToggle).toBeVisible();
  await optionsToggle.click();
}

test("unified chat renders natural bubbles for task chat entries", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-chat-${suffix}`;
  const topicName = `Chat UX ${suffix}`;
  const taskId = `task-chat-${suffix}`;
  const taskTitle = `Follow-up ${suffix}`;
  const sessionKey = `channel:test-chat-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const assistantLong = `assistant-${suffix} ${"a".repeat(260)} assistant-tail-${suffix}`;
  const userLong = `user-${suffix} ${"b".repeat(260)} user-tail-${suffix}`;

  const assistantLogRes = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: assistantLong,
      summary: "Assistant long response",
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey },
    },
  });
  expect(assistantLogRes.ok()).toBeTruthy();
  const assistantLog = await assistantLogRes.json();

  const userLogRes = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: userLong,
      summary: "User long response",
      classificationStatus: "classified",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey, messageId: `msg-${suffix}` },
    },
  });
  expect(userLogRes.ok()).toBeTruthy();
  const userLog = await userLogRes.json();

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const assistantBubble = page.getByTestId(`message-bubble-${assistantLog.id}`);
  const userBubble = page.getByTestId(`message-bubble-${userLog.id}`);
  await expect(assistantBubble).toHaveAttribute("data-agent-side", "left");
  await expect(userBubble).toHaveAttribute("data-agent-side", "right");

  await ensureBoardOptionsVisible(page);
  const fullMessagesToggle = page.getByRole("button", { name: /Show full messages|Hide full messages/i });
  await expect(fullMessagesToggle).toBeVisible();
  const fullMessagesLabel = ((await fullMessagesToggle.textContent()) || "").toLowerCase();
  if (fullMessagesLabel.includes("show")) {
    await fullMessagesToggle.click();
  }

  await expect(page.getByText(`assistant-tail-${suffix}`)).toBeVisible();
  await expect(page.getByText(`user-tail-${suffix}`)).toBeVisible();

  await expect(page.getByText("TASK CHAT")).toBeVisible();
});

test("board controls can show hidden tool/system chat rows", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-tools-${suffix}`;
  const topicName = `Tool Visibility ${suffix}`;
  const taskId = `task-tools-${suffix}`;
  const taskTitle = `Inspect tool rows ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const actionText = `tool-action-${suffix}`;
  const systemText = `system-event-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const actionLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "action",
      content: actionText,
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey },
    },
  });
  expect(actionLog.ok()).toBeTruthy();
  const actionLogEntry = await actionLog.json();

  const systemLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "system",
      content: systemText,
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "OpenClaw",
      source: { sessionKey },
    },
  });
  expect(systemLog.ok()).toBeTruthy();
  const systemLogEntry = await systemLog.json();

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  await ensureBoardOptionsVisible(page);
  const toolCallsToggle = page.getByRole("button", { name: /Show tool calls|Hide tool calls/i }).first();
  await expect(toolCallsToggle).toBeVisible();
  await expect(toolCallsToggle).toHaveText(/Show tool calls/i);

  const actionRow = page.locator(`[data-log-id="${actionLogEntry.id}"]`);
  const systemRow = page.locator(`[data-log-id="${systemLogEntry.id}"]`);
  await expect(actionRow).toHaveCount(0);
  await expect(systemRow).toHaveCount(0);

  await toolCallsToggle.click();
  await expect(toolCallsToggle).toHaveText(/Hide tool calls/i);
  await expect(page.getByText(actionText, { exact: false })).toBeVisible();
  await expect(page.getByText(systemText, { exact: false })).toBeVisible();
});

test("chat hides transport noise while still surfacing meaningful tool rows and counts", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-chat-noise-${suffix}`;
  const topicName = `Chat Noise ${suffix}`;
  const taskId = `task-chat-noise-${suffix}`;
  const taskTitle = `Chat noise task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const meaningfulToolText = `meaningful-tool-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const appendLog = async (data: Record<string, unknown>) => {
    const response = await request.post(`${apiBase}/api/log`, { data });
    expect(response.ok()).toBeTruthy();
  };

  await appendLog({
    topicId,
    taskId,
    type: "conversation",
    content: `user-${suffix}`,
    summary: `user-${suffix}`,
    classificationStatus: "classified",
    agentId: "user",
    agentLabel: "User",
    source: { sessionKey, channel: "clawboard" },
  });
  await appendLog({
    topicId,
    taskId,
    type: "conversation",
    content: `assistant-${suffix}`,
    summary: `assistant-${suffix}`,
    classificationStatus: "classified",
    agentId: "assistant",
    agentLabel: "OpenClaw",
    source: { sessionKey, channel: "clawboard" },
  });
  await appendLog({
    topicId,
    taskId,
    type: "action",
    content: meaningfulToolText,
    summary: `Tool call: ${meaningfulToolText}`,
    classificationStatus: "classified",
    agentId: "assistant",
    agentLabel: "OpenClaw",
    source: { sessionKey, channel: "clawboard" },
  });
  await appendLog({
    topicId,
    taskId,
    type: "action",
    content: "Transcript write: toolresult",
    summary: "Transcript write: toolresult",
    classificationStatus: "classified",
    agentId: "toolresult",
    agentLabel: "toolresult",
    source: { sessionKey, channel: "clawboard" },
  });
  await appendLog({
    topicId,
    taskId,
    type: "action",
    content: "Tool result persisted: exec",
    summary: "Tool result persisted: exec",
    classificationStatus: "classified",
    agentId: "assistant",
    agentLabel: "OpenClaw",
    source: { sessionKey, channel: "clawboard" },
  });
  await appendLog({
    topicId,
    taskId,
    type: "conversation",
    content: "HEARTBEAT_OK",
    summary: "HEARTBEAT_OK",
    classificationStatus: "classified",
    agentId: "assistant",
    agentLabel: "OpenClaw",
    source: { sessionKey, channel: "clawboard" },
  });
  await appendLog({
    topicId,
    taskId,
    type: "conversation",
    content: "Same recovery event already handled",
    summary: "Same recovery event already handled",
    classificationStatus: "classified",
    agentId: "assistant",
    agentLabel: "OpenClaw",
    source: { sessionKey, channel: "clawboard" },
  });
  await appendLog({
    topicId,
    taskId,
    type: "system",
    content: "cron-noise",
    summary: "cron-noise",
    classificationStatus: "classified",
    agentId: "system",
    agentLabel: "System",
    source: { sessionKey, channel: "cron-event" },
  });

  await page.goto(`/u/topic/${topicId}/task/${taskId}?reveal=1`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  await expect(page.getByText(`assistant-${suffix}`)).toBeVisible();
  await expect(page.getByText("HEARTBEAT_OK", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Same recovery event already handled", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Transcript write: toolresult", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Tool result persisted: exec", { exact: false })).toHaveCount(0);
  await expect(page.getByText("cron-noise", { exact: false })).toHaveCount(0);

  await ensureBoardOptionsVisible(page);
  const toolCallsToggle = page.getByRole("button", { name: /Show tool calls|Hide tool calls/i }).first();
  await expect(toolCallsToggle).toBeVisible();
  if ((await toolCallsToggle.textContent())?.toLowerCase().includes("show")) {
    await toolCallsToggle.click();
  }

  await expect(page.getByText(meaningfulToolText, { exact: false })).toBeVisible();
  await expect(page.getByText("HEARTBEAT_OK", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Same recovery event already handled", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Transcript write: toolresult", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Tool result persisted: exec", { exact: false })).toHaveCount(0);
  await expect(page.getByText("cron-noise", { exact: false })).toHaveCount(0);
  await expect(page.getByTestId(`task-chat-entries-${taskId}`)).toHaveText("3 entries · 1 tool/system call");
});

test("active task chat shows pending assistant and tool rows before classification settles", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-pending-chat-${suffix}`;
  const topicName = `Pending Chat ${suffix}`;
  const taskId = `task-pending-chat-${suffix}`;
  const taskTitle = `Pending visibility ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const assistantText = `pending-assistant-${suffix}`;
  const actionText = `pending-tool-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const pendingAssistant = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: assistantText,
      summary: assistantText,
      classificationStatus: "pending",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey, requestId: `req-pending-chat-${suffix}` },
    },
  });
  expect(pendingAssistant.ok()).toBeTruthy();
  const pendingAssistantEntry = await pendingAssistant.json();

  const pendingAction = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "action",
      content: actionText,
      summary: `Tool call: pending-tool-${suffix}`,
      classificationStatus: "pending",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey, requestId: `req-pending-chat-${suffix}` },
    },
  });
  expect(pendingAction.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  await expect(page.getByTestId(`message-bubble-${pendingAssistantEntry.id}`)).toContainText(assistantText);
  await expect(page.getByText(actionText, { exact: false })).toHaveCount(0);

  await ensureBoardOptionsVisible(page);
  const toolCallsToggle = page.getByRole("button", { name: /Show tool calls|Hide tool calls/i }).first();
  await expect(toolCallsToggle).toBeVisible();
  if ((await toolCallsToggle.textContent())?.toLowerCase().includes("show")) {
    await toolCallsToggle.click();
  }

  await expect(page.getByText(actionText, { exact: false })).toBeVisible();
});

test("responding tasks project live doing state into task pills and topic counts", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-live-doing-${suffix}`;
  const topicName = `Live Doing ${suffix}`;
  const taskId = `task-live-doing-${suffix}`;
  const taskTitle = `Live doing task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const queueRun = await request.post(`${apiBase}/api/openclaw/chat`, {
    data: {
      sessionKey,
      message: `live-doing-seed-${suffix}`,
    },
  });
  expect(queueRun.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}/task/${taskId}?reveal=1`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicCard = page.locator(`[data-topic-card-id="${topicId}"]`);
  await expect(topicCard.getByText("1 doing")).toBeVisible();
  await expect(page.getByTestId(`task-status-trigger-${taskId}`)).toContainText("Doing");
});

test("terminal system failures stay visible when tool/system rows are hidden", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-terminal-system-${suffix}`;
  const topicName = `Terminal Visibility ${suffix}`;
  const taskId = `task-terminal-system-${suffix}`;
  const taskTitle = `Terminal task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const terminalText = `terminal-system-${suffix}`;
  const regularSystemText = `regular-system-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const regularSystem = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "system",
      content: regularSystemText,
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "OpenClaw",
      source: { sessionKey, requestId: `req-regular-${suffix}`, requestTerminal: false },
    },
  });
  expect(regularSystem.ok()).toBeTruthy();
  const regularSystemEntry = await regularSystem.json();

  const terminalSystem = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "system",
      content: terminalText,
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "Clawboard",
      source: { sessionKey, requestId: `req-terminal-${suffix}`, requestTerminal: true },
    },
  });
  expect(terminalSystem.ok()).toBeTruthy();
  const terminalSystemEntry = await terminalSystem.json();

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const regularRow = page.locator(`[data-log-id="${regularSystemEntry.id}"]`);
  const terminalRow = page.locator(`[data-log-id="${terminalSystemEntry.id}"]`);

  await expect(regularRow).toHaveCount(0);
  await expect(terminalRow).toBeVisible();
  await expect(page.getByText(terminalText, { exact: false })).toBeVisible();
});

test("agent message exposes in-between tool call count and can reveal hidden rows", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-inline-tools-${suffix}`;
  const topicName = `Inline Tool Count ${suffix}`;
  const taskId = `task-inline-tools-${suffix}`;
  const taskTitle = `Inline tool rows ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const userText = `user-inline-${suffix}`;
  const actionText = `tool-inline-action-${suffix}`;
  const systemText = `tool-inline-system-${suffix}`;
  const assistantText = `assistant-inline-${suffix}`;
  const priorActionText = `tool-inline-prior-${suffix}`;
  const baseTime = Date.now();
  const createdAt = (offsetMs: number) => new Date(baseTime + offsetMs).toISOString();

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const previousUserLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: `previous-user-inline-${suffix}`,
      summary: "Previous user prompt",
      createdAt: createdAt(0),
      classificationStatus: "classified",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey, requestId: `req-inline-previous-${suffix}` },
    },
  });
  expect(previousUserLog.ok()).toBeTruthy();

  const priorActionLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "action",
      content: priorActionText,
      summary: `Tool call: inline-prior-${suffix}`,
      createdAt: createdAt(1),
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey },
    },
  });
  expect(priorActionLog.ok()).toBeTruthy();
  const priorActionLogEntry = await priorActionLog.json();

  const userLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: userText,
      summary: "User prompt",
      createdAt: createdAt(2),
      classificationStatus: "classified",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey, requestId: `req-inline-${suffix}` },
    },
  });
  expect(userLog.ok()).toBeTruthy();

  const actionLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "action",
      content: actionText,
      summary: `Tool call: inline-${suffix}`,
      createdAt: createdAt(3),
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey },
    },
  });
  expect(actionLog.ok()).toBeTruthy();
  const actionLogEntry = await actionLog.json();

  const systemLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "system",
      content: systemText,
      summary: "System event",
      createdAt: createdAt(4),
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "OpenClaw",
      source: { sessionKey },
    },
  });
  expect(systemLog.ok()).toBeTruthy();
  const systemLogEntry = await systemLog.json();

  const assistantLogRes = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: assistantText,
      summary: "Assistant response",
      createdAt: createdAt(5),
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey, requestId: `req-inline-${suffix}` },
    },
  });
  expect(assistantLogRes.ok()).toBeTruthy();
  const assistantLog = await assistantLogRes.json();

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const actionRow = page.locator(`[data-log-id="${actionLogEntry.id}"]`);
  const systemRow = page.locator(`[data-log-id="${systemLogEntry.id}"]`);
  const priorActionRow = page.locator(`[data-log-id="${priorActionLogEntry.id}"]`);
  await expect(actionRow).toHaveCount(0);
  await expect(systemRow).toHaveCount(0);
  await expect(priorActionRow).toHaveCount(0);

  const inlineToggle = page.getByTestId(`tool-call-toggle-${assistantLog.id}`);
  await expect(inlineToggle).toBeVisible();
  await expect(inlineToggle).toHaveText(/2 tool calls/i);
  await expect(inlineToggle).toHaveAttribute("aria-expanded", "false");

  const setInlineToggleExpanded = async (expanded: boolean) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await inlineToggle.click();
      try {
        await expect(inlineToggle).toHaveAttribute("aria-expanded", expanded ? "true" : "false");
        return;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
  };

  await setInlineToggleExpanded(true);
  await expect(actionRow).toBeVisible();
  await expect(systemRow).toBeVisible();
  await expect(priorActionRow).toHaveCount(0);

  await setInlineToggleExpanded(false);
  await expect(actionRow).toHaveCount(0);
  await expect(systemRow).toHaveCount(0);
});

test("topic and task labels include scoped tool/system call totals", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-call-totals-${suffix}`;
  const topicName = `Call Totals ${suffix}`;
  const taskAId = `task-call-totals-a-${suffix}`;
  const taskATitle = `Call Totals A ${suffix}`;
  const taskBId = `task-call-totals-b-${suffix}`;
  const taskBTitle = `Call Totals B ${suffix}`;
  const taskASessionKey = `clawboard:task:${topicId}:${taskAId}`;
  const taskBSessionKey = `clawboard:task:${topicId}:${taskBId}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTaskA = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskAId, topicId, title: taskATitle, status: "todo", pinned: false },
  });
  expect(createTaskA.ok()).toBeTruthy();

  const createTaskB = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskBId, topicId, title: taskBTitle, status: "todo", pinned: false },
  });
  expect(createTaskB.ok()).toBeTruthy();

  const taskAAction = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId: taskAId,
      type: "action",
      content: `task-a-tool-${suffix}`,
      summary: "Tool call: task-a-tool",
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey: taskASessionKey },
    },
  });
  expect(taskAAction.ok()).toBeTruthy();

  const taskASystem = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId: taskAId,
      type: "system",
      content: `task-a-system-${suffix}`,
      summary: "System event",
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "OpenClaw",
      source: { sessionKey: taskASessionKey },
    },
  });
  expect(taskASystem.ok()).toBeTruthy();

  const taskBAction = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId: taskBId,
      type: "action",
      content: `task-b-tool-${suffix}`,
      summary: "Tool call: task-b-tool",
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey: taskBSessionKey },
    },
  });
  expect(taskBAction.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}/task/${taskAId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicCard = page.locator(`[data-topic-card-id="${topicId}"]`).first();
  const taskACard = page.locator(`[data-task-card-id="${taskAId}"]`).first();
  const taskBCard = page.locator(`[data-task-card-id="${taskBId}"]`).first();

  await expect(topicCard.getByText(/3 tool\/system calls/i).first()).toBeVisible();
  await expect(taskACard.getByText(/2 tool\/system calls/i).first()).toBeVisible();
  await expect(taskBCard.getByText(/1 tool\/system call/i).first()).toBeVisible();
});

test("typing indicator shows live hidden tool call count while awaiting agent response", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-typing-tools-${suffix}`;
  const topicName = `Typing Tool Count ${suffix}`;
  const taskId = `task-typing-tools-${suffix}`;
  const taskTitle = `Typing hidden rows ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const pendingUser = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: `typing-user-${suffix}`,
      summary: "Pending user prompt",
      classificationStatus: "classified",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey, requestId: `req-typing-${suffix}` },
    },
  });
  expect(pendingUser.ok()).toBeTruthy();

  const queueRes = await request.post(`${apiBase}/api/openclaw/chat`, {
    data: {
      sessionKey,
      message: `typing-seed-${suffix}`,
    },
  });
  expect(queueRes.ok()).toBeTruthy();

  const actionLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "action",
      content: `typing-action-${suffix}`,
      summary: `Tool call: typing-${suffix}`,
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "OpenClaw",
      source: { sessionKey, requestId: `req-typing-${suffix}` },
    },
  });
  expect(actionLog.ok()).toBeTruthy();

  const systemLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "system",
      content: `typing-system-${suffix}`,
      summary: "System work update",
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "OpenClaw",
      source: { sessionKey, requestId: `req-typing-${suffix}`, requestTerminal: false },
    },
  });
  expect(systemLog.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const hiddenCount = page.getByTestId(`task-chat-hidden-tool-count-${taskId}`);
  await expect(hiddenCount).toBeVisible();
  await expect(hiddenCount).toHaveText(/2 hidden tool calls/i);
});
