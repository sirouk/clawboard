import { expect, test } from "@playwright/test";

test("logs page uses 50-row load more increment", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-log-paging-${suffix}`;
  const topicName = `Log Paging ${suffix}`;

  const topicRes = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(topicRes.ok()).toBeTruthy();

  let oldestContent = "";
  for (let i = 0; i < 55; i += 1) {
    const content = `log-paging-${suffix}-${i}`;
    if (i === 0) oldestContent = content;
    const createLog = await request.post(`${apiBase}/api/log`, {
      data: {
        topicId,
        type: "action",
        content,
        summary: content,
        classificationStatus: "classified",
        agentId: "assistant",
        agentLabel: "OpenClaw",
        source: { sessionKey: `channel:log-paging-${suffix}` },
      },
    });
    expect(createLog.ok()).toBeTruthy();
  }

  await page.goto("/log");
  await page.getByRole("heading", { name: "All Activity" }).waitFor();
  await page.getByRole("button", { name: "Load 50 more" }).waitFor();

  await expect(page.getByText(oldestContent, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Load 50 more" }).click();
  await expect(page.getByText(oldestContent, { exact: true })).toBeVisible();
});

test("unified view uses task=2 and topic=4 load increments", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-unified-paging-${suffix}`;
  const topicName = `Unified Paging ${suffix}`;
  const taskId = `task-unified-paging-${suffix}`;
  const taskTitle = `Task Paging ${suffix}`;
  const sessionKey = `channel:unified-paging-${suffix}`;

  const topicRes = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(topicRes.ok()).toBeTruthy();

  const taskRes = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(taskRes.ok()).toBeTruthy();

  let hiddenTaskLogId = "";
  for (let i = 0; i < 4; i += 1) {
    const content = `task-paging-${suffix}-${i}`;
    const createLog = await request.post(`${apiBase}/api/log`, {
      data: {
        topicId,
        taskId,
        type: "conversation",
        content,
        summary: content,
        classificationStatus: "classified",
        agentId: i % 2 === 0 ? "assistant" : "user",
        agentLabel: i % 2 === 0 ? "OpenClaw" : "User",
        source: { sessionKey, messageId: `task-msg-${suffix}-${i}` },
      },
    });
    expect(createLog.ok()).toBeTruthy();
    const taskLog = await createLog.json();
    if (i === 0) hiddenTaskLogId = taskLog.id;
  }

  let hiddenTopicLogId = "";
  for (let i = 0; i < 6; i += 1) {
    const content = `topic-paging-${suffix}-${i}`;
    const createLog = await request.post(`${apiBase}/api/log`, {
      data: {
        topicId,
        type: "conversation",
        content,
        summary: content,
        classificationStatus: "classified",
        agentId: i % 2 === 0 ? "assistant" : "user",
        agentLabel: i % 2 === 0 ? "OpenClaw" : "User",
        source: { sessionKey, messageId: `topic-msg-${suffix}-${i}` },
      },
    });
    expect(createLog.ok()).toBeTruthy();
    const topicLog = await createLog.json();
    if (i === 0) hiddenTopicLogId = topicLog.id;
  }

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicButton = page.getByRole("button", { name: new RegExp(topicName) }).first();
  await topicButton.click();
  const taskButton = page.getByRole("button", { name: new RegExp(taskTitle) }).first();
  await taskButton.click();

  await expect(page.locator(`[data-log-id="${hiddenTaskLogId}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Load 2 more" }).first().click();
  await expect(page.locator(`[data-log-id="${hiddenTaskLogId}"]`)).toBeVisible();

  await expect(page.locator(`[data-log-id="${hiddenTopicLogId}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Load 4 more" }).first().click();
  await expect(page.locator(`[data-log-id="${hiddenTopicLogId}"]`)).toBeVisible();
});
