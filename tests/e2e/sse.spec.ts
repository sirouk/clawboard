import { test, expect } from "@playwright/test";

test("sse updates render without refresh", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `sse-topic-${suffix}`;
  const topicName = `SSE Topic ${suffix}`;
  const taskId = `sse-task-${suffix}`;
  const taskTitle = `SSE Task ${suffix}`;
  const sessionKey = `channel:sse-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();
  await page.getByTestId("unified-composer-textarea").first().waitFor();
  await expect(page.locator(`[data-task-card-id="${taskId}"]`).first()).toBeVisible();
  const topicExpand = page.getByRole("button", { name: `Expand topic ${topicName}`, exact: true });
  if ((await topicExpand.count()) > 0) {
    await topicExpand.first().click();
  }
  const taskExpand = page.getByRole("button", { name: `Expand task ${taskTitle}`, exact: true });
  if ((await taskExpand.count()) > 0) {
    await taskExpand.first().click();
  }

  const main = page.locator("main");
  await expect(page.getByTestId(`task-chat-entries-${taskId}`)).toBeVisible();

  const message = `SSE update ${Date.now()}`;
  const now = "2026-02-02T11:00:00.000Z";

  const res = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "note",
      content: message,
      summary: message,
      createdAt: now,
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "System",
      source: { sessionKey },
    },
  });

  expect(res.ok()).toBeTruthy();
  await expect(main.getByText(message, { exact: true })).toBeVisible({ timeout: 20_000 });
});

test("sse patches update log content without refresh", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `sse-patch-topic-${suffix}`;
  const topicName = `SSE Patch Topic ${suffix}`;
  const taskId = `sse-patch-task-${suffix}`;
  const taskTitle = `SSE Patch Task ${suffix}`;
  const sessionKey = `channel:sse-patch-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();
  await page.getByTestId("unified-composer-textarea").first().waitFor();
  await expect(page.locator(`[data-task-card-id="${taskId}"]`).first()).toBeVisible();
  const topicExpand = page.getByRole("button", { name: `Expand topic ${topicName}`, exact: true });
  if ((await topicExpand.count()) > 0) {
    await topicExpand.first().click();
  }
  const taskExpand = page.getByRole("button", { name: `Expand task ${taskTitle}`, exact: true });
  if ((await taskExpand.count()) > 0) {
    await taskExpand.first().click();
  }

  const main = page.locator("main");
  await expect(page.getByTestId(`task-chat-entries-${taskId}`)).toBeVisible();

  const message = `SSE patch ${Date.now()}`;
  const createdAt = "2026-02-02T11:05:00.000Z";
  const res = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "note",
      content: message,
      summary: message,
      createdAt,
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "System",
      source: { sessionKey },
    },
  });

  expect(res.ok()).toBeTruthy();
  const entry = await res.json();
  await expect(main.getByText(message)).toBeVisible({ timeout: 20_000 });

  const updated = `${message} updated`;
  const patch = await request.patch(`${apiBase}/api/log/${entry.id}`, {
    data: {
      content: updated,
      summary: updated,
      classificationStatus: "classified",
    },
  });

  expect(patch.ok()).toBeTruthy();
  await expect(main.getByText(updated)).toBeVisible({ timeout: 20_000 });
  await expect(main.getByText(message, { exact: true })).toHaveCount(0);
});
