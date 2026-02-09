import { expect, test } from "@playwright/test";

test("app routes redirect and deep-links resolve into unified view", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();

  const topicId = `topic-route-${suffix}`;
  const topicName = `Route Topic ${suffix}`;
  const taskId = `task-route-${suffix}`;
  const taskTitle = `Route Task ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, { data: { id: topicId, name: topicName, pinned: false } });
  expect(createTopic.ok()).toBeTruthy();
  const createTask = await request.post(`${apiBase}/api/tasks`, { data: { id: taskId, topicId, title: taskTitle, pinned: false } });
  expect(createTask.ok()).toBeTruthy();

  await page.goto("/");
  await expect(page).toHaveURL(/\/u$/);
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();

  await page.goto("/unified");
  await expect(page).toHaveURL(/\/u$/);

  await page.goto(`/topics/${encodeURIComponent(topicId)}`);
  await expect(page).toHaveURL(new RegExp(`/u/topic/${topicId}`));
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
  await expect(page.getByText(topicName)).toBeVisible();

  await page.goto(`/tasks/${encodeURIComponent(taskId)}`);
  await expect(page).toHaveURL(new RegExp(`/u/task/${taskId}`));
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();

  await page.goto("/chat");
  await expect(page).toHaveURL(/\/u$/);

  await page.goto(`/chat/${encodeURIComponent(`topic:${topicId}`)}`);
  await expect(page).toHaveURL(new RegExp(`/u/topic/${topicId}\\?chat=1`));

  await page.goto(`/chat/${encodeURIComponent(`task:${topicId}:${taskId}`)}`);
  await expect(page).toHaveURL(new RegExp(`/u/topic/${topicId}/task/${taskId}`));
});

