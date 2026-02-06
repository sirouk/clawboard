import { test, expect } from "@playwright/test";

test("classification patches move logs between topics without refresh", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicAId = `topic-sse-a-${suffix}`;
  const topicBId = `topic-sse-b-${suffix}`;
  const topicAName = `SSE Topic A ${suffix}`;
  const topicBName = `SSE Topic B ${suffix}`;

  const topicARes = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicAId, name: topicAName, pinned: false },
  });
  const topicBRes = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicBId, name: topicBName, pinned: false },
  });

  expect(topicARes.ok()).toBeTruthy();
  expect(topicBRes.ok()).toBeTruthy();

  const taskAName = `SSE Task A ${suffix}`;
  const taskBName = `SSE Task B ${suffix}`;

  const taskARes = await request.post(`${apiBase}/api/tasks`, {
    data: { id: `task-a-${suffix}`, topicId: topicAId, title: taskAName },
  });
  const taskBRes = await request.post(`${apiBase}/api/tasks`, {
    data: { id: `task-b-${suffix}`, topicId: topicBId, title: taskBName },
  });

  expect(taskARes.ok()).toBeTruthy();
  expect(taskBRes.ok()).toBeTruthy();

  const taskA = await taskARes.json();
  const taskB = await taskBRes.json();

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicAButton = page.getByRole("button", { name: new RegExp(topicAName) }).first();
  const topicBButton = page.getByRole("button", { name: new RegExp(topicBName) }).first();
  await expect(topicAButton).toBeVisible();
  await expect(topicBButton).toBeVisible();

  const message = `Classification pending ${suffix}`;
  const create = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId: topicAId,
      taskId: taskA.id,
      type: "conversation",
      content: message,
      summary: message,
      classificationStatus: "pending",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey: `channel:test-${suffix}` },
    },
  });

  expect(create.ok()).toBeTruthy();
  const entry = await create.json();
  const messageLocator = page.getByTestId(`message-bubble-${entry.id}`).getByText(message, { exact: true });

  await expect(messageLocator).toHaveCount(0);

  const classify = await request.patch(`${apiBase}/api/log/${entry.id}`, {
    data: {
      topicId: topicAId,
      classificationStatus: "classified",
    },
  });
  expect(classify.ok()).toBeTruthy();

  await topicAButton.click();
  const taskAButton = page.getByRole("button", { name: new RegExp(taskAName) }).first();
  await taskAButton.click();
  await expect(messageLocator).toBeVisible();

  const move = await request.patch(`${apiBase}/api/log/${entry.id}`, {
    data: {
      topicId: topicBId,
      taskId: taskB.id,
      classificationStatus: "classified",
    },
  });
  expect(move.ok()).toBeTruthy();

  await expect(messageLocator).toHaveCount(0);
  await topicBButton.click();
  const taskBButton = page.getByRole("button", { name: new RegExp(taskBName) }).first();
  await taskBButton.click();
  await expect(messageLocator).toBeVisible();
});
