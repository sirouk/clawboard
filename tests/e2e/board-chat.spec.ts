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
  const searchInput = page.getByPlaceholder("Search tasks, topics…");
  await expect(searchInput).toBeVisible();

  await searchInput.fill(topicName);
  const navTopicButton = page.locator(`aside [data-board-topic-id='${topicId}'] > button`).first();
  await expect(navTopicButton).toBeVisible();
  await navTopicButton.click();

  await expect(page).toHaveURL(new RegExp(`/u/topic/.*${topicId}`));
  await expect(page.locator("div[role='button']").filter({ hasText: topicName }).first()).toHaveAttribute("aria-expanded", "true");
});

test("creating a task in topic view auto-expands task chat and focuses task composer", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-create-task-${suffix}`;
  const topicName = `Create Task Topic ${suffix}`;
  const taskTitle = `Task from topic ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicCard = page.locator(`[data-topic-card-id='${topicId}']`).first();
  await expect(topicCard).toBeVisible();

  const addTaskInput = topicCard.getByPlaceholder("Add a task…");
  if (!(await addTaskInput.isVisible())) {
    await topicCard.getByTitle("Expand").click();
  }
  await expect(addTaskInput).toBeVisible();

  const createTaskRequest = page.waitForResponse((resp) => {
    return resp.url().includes("/api/tasks") && resp.request().method() === "POST";
  });

  await addTaskInput.fill(taskTitle);
  await addTaskInput.press("Enter");
  await createTaskRequest;

  const taskCard = page.locator("[data-task-card-id]").filter({ hasText: taskTitle }).first();
  await expect(taskCard).toBeVisible();
  const taskId = await taskCard.getAttribute("data-task-card-id");
  expect(taskId).toBeTruthy();

  const taskComposer = page.getByTestId(`task-chat-composer-${taskId}`);
  await expect(taskComposer).toBeVisible();
  await expect(taskComposer.getByRole("textbox")).toBeFocused();
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
  await expect(page.locator("[data-testid^='message-bubble-']").filter({ hasText: message }).first()).toBeVisible();

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
  await expect(taskComposer.getByRole("textbox")).toBeVisible();
});

test("typed /stop in topic composer cancels in-flight run without posting another chat send", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-stop-${suffix}`;
  const topicName = `Stop Topic ${suffix}`;
  const sessionKey = `clawboard:topic:${topicId}`;
  const postPayloads: Array<Record<string, unknown>> = [];
  const deletePayloads: Array<Record<string, unknown>> = [];
  const requestId = `occhat-stop-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  await page.route("**/api/openclaw/chat", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      postPayloads.push(payload);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ queued: true, requestId }),
      });
      return;
    }
    if (method === "DELETE") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      deletePayloads.push(payload);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ aborted: true, queueCancelled: 1, sessionKey, sessionKeys: [sessionKey] }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/u/topic/${topicId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicComposer = page.getByTestId(`topic-chat-composer-${topicId}`);
  const topicChatToggle = page.getByTestId(`toggle-topic-chat-${topicId}`);
  const toggleLabel = (await topicChatToggle.getAttribute("aria-label")) ?? "";
  if (/expand/i.test(toggleLabel)) {
    await topicChatToggle.click();
  }
  await expect(topicComposer).toBeVisible();

  const textbox = topicComposer.getByRole("textbox");
  await textbox.fill(`start-run-${suffix}`);
  await textbox.press("Enter");
  await expect.poll(() => postPayloads.length).toBe(1);

  await textbox.fill("/stop");
  await topicComposer.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => deletePayloads.length).toBe(1);
  expect(postPayloads).toHaveLength(1);
  expect(postPayloads[0]?.message).toBe(`start-run-${suffix}`);
  expect(deletePayloads[0]?.sessionKey).toBe(sessionKey);
  expect(deletePayloads[0]?.requestId).toBe(requestId);
  await expect(topicComposer.getByText("Cancellation requested.")).toBeVisible();
});

test("typed /abort in task composer cancels in-flight run as a /stop alias", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-abort-${suffix}`;
  const topicName = `Abort Topic ${suffix}`;
  const taskId = `task-abort-${suffix}`;
  const taskTitle = `Abort Task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const postPayloads: Array<Record<string, unknown>> = [];
  const deletePayloads: Array<Record<string, unknown>> = [];
  const requestId = `occhat-abort-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();
  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.route("**/api/openclaw/chat", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      postPayloads.push(payload);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ queued: true, requestId }),
      });
      return;
    }
    if (method === "DELETE") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      deletePayloads.push(payload);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ aborted: true, queueCancelled: 1, sessionKey, sessionKeys: [sessionKey] }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const taskComposer = page.getByTestId(`task-chat-composer-${taskId}`);
  await expect(taskComposer).toBeVisible();
  const textbox = taskComposer.getByRole("textbox");

  await textbox.fill(`start-task-run-${suffix}`);
  await textbox.press("Enter");
  await expect.poll(() => postPayloads.length).toBe(1);

  await textbox.fill("/abort");
  await taskComposer.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => deletePayloads.length).toBe(1);

  expect(postPayloads).toHaveLength(1);
  expect(postPayloads[0]?.sessionKey).toBe(sessionKey);
  expect(postPayloads[0]?.message).toBe(`start-task-run-${suffix}`);
  expect(deletePayloads[0]?.sessionKey).toBe(sessionKey);
  expect(deletePayloads[0]?.requestId).toBe(requestId);
  await expect(taskComposer.getByText("Cancellation requested.")).toBeVisible();
});
