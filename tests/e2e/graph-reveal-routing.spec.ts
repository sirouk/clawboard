import { expect, test } from "@playwright/test";

test("reveal deep-links surface archived topics and done tasks in board", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `graph-reveal-topic-${suffix}`;
  const topicName = `Graph Reveal Topic ${suffix}`;
  const taskId = `graph-reveal-task-${suffix}`;
  const taskTitle = `Graph Reveal Task ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const archiveTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, status: "archived" },
  });
  expect(archiveTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "done", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.goto(`/u?topic=${encodeURIComponent(topicId)}&task=${encodeURIComponent(taskId)}`);
  await page.getByPlaceholder("Search topics, tasks, or messages").waitFor();
  await expect(page.locator(`[data-topic-card-id='${topicId}']`)).toHaveCount(0);
  await expect(page.locator(`[data-task-card-id='${taskId}']`)).toHaveCount(0);

  await page.goto(`/u?topic=${encodeURIComponent(topicId)}&task=${encodeURIComponent(taskId)}&reveal=1`);
  await page.getByPlaceholder("Search topics, tasks, or messages").waitFor();

  const topicCard = page.locator(`[data-topic-card-id='${topicId}']`).first();
  const taskCard = page.locator(`[data-task-card-id='${taskId}']`).first();
  await expect(topicCard).toBeVisible();
  await expect(taskCard).toBeVisible();
  await expect(page).toHaveURL(/reveal=1/);
});
