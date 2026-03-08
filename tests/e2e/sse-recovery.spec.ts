import { expect, test } from "@playwright/test";

test("changes reconcile removes deleted task/topic after SSE disconnect", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `sse-recovery-topic-${suffix}`;
  const topicName = `SSE Recovery Topic ${suffix}`;
  const taskId = `sse-recovery-task-${suffix}`;
  const taskTitle = `SSE Recovery Task ${suffix}`;

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
  await expect(page.locator(`[data-topic-card-id="${topicId}"]`).first()).toBeVisible();
  await expect(page.locator(`[data-task-card-id="${taskId}"]`).first()).toBeVisible();

  await page.context().setOffline(true);

  const deleteTask = await request.delete(`${apiBase}/api/tasks/${taskId}`);
  expect(deleteTask.ok()).toBeTruthy();
  const deleteTopic = await request.delete(`${apiBase}/api/topics/${topicId}`);
  expect(deleteTopic.ok()).toBeTruthy();

  await page.context().setOffline(false);

  await expect(page.locator(`[data-task-card-id="${taskId}"]`)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(`[data-topic-card-id="${topicId}"]`)).toHaveCount(0, { timeout: 20_000 });
});

test("changes reconcile clears stale responding state after missed terminal SSE", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `sse-signal-topic-${suffix}`;
  const topicName = `SSE Signal Topic ${suffix}`;
  const taskId = `sse-signal-task-${suffix}`;
  const taskTitle = `SSE Signal Task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;

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

  const sendRes = await request.post(`${apiBase}/api/openclaw/chat`, {
    data: { sessionKey, message: `signal recovery ${suffix}`, agentId: "main" },
  });
  expect(sendRes.ok()).toBeTruthy();
  const sendBody = (await sendRes.json()) as { requestId?: string };
  const requestId = String(sendBody.requestId ?? "").trim();
  expect(requestId.length).toBeGreaterThan(0);

  const responding = page.locator('[title="OpenClaw responding"]').first();
  await expect(responding).toBeVisible({ timeout: 20_000 });

  await page.context().setOffline(true);

  const cancelRes = await request.delete(`${apiBase}/api/openclaw/chat`, {
    data: { sessionKey, requestId },
  });
  expect(cancelRes.ok()).toBeTruthy();

  await page.context().setOffline(false);

  await expect(page.locator('[title="OpenClaw responding"]')).toHaveCount(0, { timeout: 20_000 });
});
