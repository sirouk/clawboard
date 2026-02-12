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

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  await page.locator("div[role='button']").filter({ hasText: topicName }).first().click();
  await page.locator("div[role='button']").filter({ hasText: taskTitle }).first().click();

  const assistantBubble = page.getByTestId(`message-bubble-${assistantLog.id}`);
  const userBubble = page.getByTestId(`message-bubble-${userLog.id}`);
  await expect(assistantBubble).toHaveAttribute("data-agent-side", "left");
  await expect(userBubble).toHaveAttribute("data-agent-side", "right");

  const optionsToggle = page.getByRole("button", { name: /View options|Hide options/i });
  await expect(optionsToggle).toBeVisible();
  const optionsLabel = ((await optionsToggle.textContent()) || "").toLowerCase();
  if (optionsLabel.includes("view")) {
    await optionsToggle.click();
  }
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
