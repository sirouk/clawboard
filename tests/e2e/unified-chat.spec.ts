import { expect, test } from "@playwright/test";

test("unified chat renders natural bubbles and topic-only chat entries", async ({ page, request }) => {
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
  const topicOnlyMessage = `topic-only-${suffix}`;

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

  const topicOnlyRes = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      type: "conversation",
      content: topicOnlyMessage,
      summary: "Topic-level note",
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey },
    },
  });
  expect(topicOnlyRes.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const assistantBubble = page.getByTestId(`message-bubble-${assistantLog.id}`);
  const userBubble = page.getByTestId(`message-bubble-${userLog.id}`);
  await expect(assistantBubble).toHaveAttribute("data-agent-side", "left");
  await expect(userBubble).toHaveAttribute("data-agent-side", "right");

  const optionsToggle = page.getByRole("button", { name: /Board controls/i }).first();
  await expect(optionsToggle).toBeVisible();
  await optionsToggle.click();
  const fullMessagesToggle = page.getByRole("button", { name: /Show full messages|Hide full messages/i });
  await expect(fullMessagesToggle).toBeVisible();
  const fullMessagesLabel = ((await fullMessagesToggle.textContent()) || "").toLowerCase();
  if (fullMessagesLabel.includes("show")) {
    await fullMessagesToggle.click();
  }

  await expect(page.getByText(`assistant-tail-${suffix}`)).toBeVisible();
  await expect(page.getByText(`user-tail-${suffix}`)).toBeVisible();

  await expect(page.getByText("TASK CHAT")).toBeVisible();

  await expect(page.getByText("TOPIC CHAT")).toBeVisible();
  const topicChatToggle = page.getByTestId(`toggle-topic-chat-${topicId}`);
  const topicChatToggleLabel = (await topicChatToggle.getAttribute("aria-label")) ?? "";
  if (/expand/i.test(topicChatToggleLabel)) {
    await topicChatToggle.click();
  }
  await expect(page.getByText(topicOnlyMessage, { exact: false })).toBeVisible();
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

  const optionsToggle = page.getByRole("button", { name: /Board controls/i }).first();
  await expect(optionsToggle).toBeVisible();
  const expanded = (await optionsToggle.getAttribute("aria-expanded")) === "true";
  if (!expanded) await optionsToggle.click();

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

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const userLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: userText,
      summary: "User prompt",
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
  await expect(actionRow).toHaveCount(0);
  await expect(systemRow).toHaveCount(0);

  const inlineToggle = page.getByTestId(`tool-call-toggle-${assistantLog.id}`);
  await expect(inlineToggle).toBeVisible();
  await expect(inlineToggle).toHaveText(/2 tool calls/i);

  await inlineToggle.click();
  await expect(actionRow).toBeVisible();
  await expect(systemRow).toBeVisible();

  await inlineToggle.click();
  await expect(actionRow).toHaveCount(0);
  await expect(systemRow).toHaveCount(0);
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

  const actionLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "action",
      content: `typing-action-${suffix}`,
      summary: `Tool call: typing-${suffix}`,
      classificationStatus: "classified",
      agentId: "assistant",
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
