import { expect, test } from "@playwright/test";

test("board topics panel can search topics and navigate into unified view selection", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-nav-${suffix}`;
  const topicName = `Nav Topic ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  // Expand the Board topics panel in the left nav.
  await page.locator("aside").getByRole("link", { name: "Board", exact: true }).click();
  const searchInput = page.getByPlaceholder("Search topics…");
  await expect(searchInput).toBeVisible();

  await searchInput.fill(topicName);
  const navTopicButton = page.locator("aside").getByRole("button", { name: topicName }).first();
  await expect(navTopicButton).toBeVisible();
  await navTopicButton.click();

  await expect(page).toHaveURL(new RegExp(`/u/topic/.*${topicId}`));
  await expect(page.locator("div[role='button']").filter({ hasText: topicName }).first()).toHaveAttribute("aria-expanded", "true");
});

test("topic chat send is instant and task promotion auto-expands task composer", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-chat-${suffix}`;
  const topicName = `Board Chat ${suffix}`;
  const taskId = `task-chat-${suffix}`;
  const taskTitle = `Promoted Task ${suffix}`;
  const sessionKey = `clawboard:topic:${topicId}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicComposer = page.getByTestId(`topic-chat-composer-${topicId}`);
  const topicChatToggle = page.getByTestId(`toggle-topic-chat-${topicId}`);
  const toggleLabel = (await topicChatToggle.getAttribute("aria-label")) ?? "";
  if (/expand/i.test(toggleLabel)) {
    await topicChatToggle.click();
  }
  await expect(topicComposer).toBeVisible();

  const message = `hello-promote-${suffix}`;
  const openclawSend = page.waitForResponse((resp) => {
    return resp.url().includes("/api/openclaw/chat") && resp.request().method() === "POST";
  });

  await topicComposer.getByRole("textbox").fill(message);
  await topicComposer.getByRole("textbox").press("Enter");
  await openclawSend;

  // The user message should appear immediately as pending in the active topic chat pane.
  await expect(page.getByText(message, { exact: false })).toBeVisible();

  const logsRes = await request.get(`${apiBase}/api/log?sessionKey=${encodeURIComponent(sessionKey)}&limit=10`);
  expect(logsRes.ok()).toBeTruthy();
  const logs = (await logsRes.json()) as Array<{ id: string; content: string }>;
  const appended = logs.find((row) => row.content === message);
  expect(appended?.id).toBeTruthy();

  const patchRes = await request.patch(`${apiBase}/api/log/${encodeURIComponent(appended!.id)}`, {
    data: { taskId, classificationStatus: "classified" },
  });
  expect(patchRes.ok()).toBeTruthy();

  // UI should auto-expand the promoted task chat and focus its composer.
  const taskComposer = page.getByTestId(`task-chat-composer-${taskId}`);
  await expect(taskComposer).toBeVisible();
  await expect(taskComposer.getByRole("textbox")).toBeFocused();
});
