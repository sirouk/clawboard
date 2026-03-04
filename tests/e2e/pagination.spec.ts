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

  let oldestLogId = "";
  for (let i = 0; i < 55; i += 1) {
    const content = `log-paging-${suffix}-${i}`;
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
    const row = await createLog.json();
    if (i === 0) oldestLogId = String(row?.id ?? "");
  }

  await page.goto("/log");
  await page.getByRole("heading", { name: "All Activity" }).waitFor();
  await page.getByRole("button", { name: "Load 50 more" }).waitFor();

  expect(oldestLogId).toBeTruthy();
  await expect(page.locator(`[data-log-id="${oldestLogId}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Load 50 more" }).click();
  await expect(page.locator(`[data-log-id="${oldestLogId}"]`)).toBeVisible();
});

test("unified view task chat uses task=2 load increment", async ({ page, request }) => {
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

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicButton = page.getByRole("button", { name: new RegExp(topicName) }).first();
  await topicButton.click();
  const taskButton = page.getByRole("button", { name: new RegExp(taskTitle) }).first();
  await taskButton.click();

  const taskCard = page.locator(`[data-task-card-id="${taskId}"]`).first();
  await taskCard.getByRole("button", { name: "Load older" }).first().waitFor();
  await expect(page.locator(`[data-log-id="${hiddenTaskLogId}"]`)).toHaveCount(0);
  await taskCard.getByRole("button", { name: "Load older" }).first().click();
  await expect(page.locator(`[data-log-id="${hiddenTaskLogId}"]`)).toBeVisible();

});

test("unified view does not auto-load older history on initial render", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-unified-no-autoload-${suffix}`;
  const topicName = `Unified No Autoload ${suffix}`;
  const taskId = `task-unified-no-autoload-${suffix}`;
  const taskTitle = `Task No Autoload ${suffix}`;
  const sessionKey = `channel:unified-no-autoload-${suffix}`;

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
    const content = `task-no-autoload-${suffix}-${i}`;
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
        source: { sessionKey, messageId: `task-no-autoload-msg-${suffix}-${i}` },
      },
    });
    expect(createLog.ok()).toBeTruthy();
    const taskLog = await createLog.json();
    if (i === 0) hiddenTaskLogId = taskLog.id;
  }

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicButton = page.getByRole("button", { name: new RegExp(topicName) }).first();
  await topicButton.click();
  const taskButton = page.getByRole("button", { name: new RegExp(taskTitle) }).first();
  await taskButton.click();

  const taskCard = page.locator(`[data-task-card-id="${taskId}"]`).first();
  const taskLoadOlder = taskCard.getByRole("button", { name: "Load older" }).first();
  await taskLoadOlder.waitFor();
  await expect(taskLoadOlder).toBeVisible();
  const taskControls = page.getByTestId(`task-chat-controls-${taskId}`);
  const taskEntries = page.getByTestId(`task-chat-entries-${taskId}`);
  const taskControlsWrap = await taskControls.evaluate((el) => window.getComputedStyle(el).flexWrap);
  expect(taskControlsWrap).toBe("nowrap");
  const taskLoadOlderWhiteSpace = await taskLoadOlder.evaluate((el) => window.getComputedStyle(el).whiteSpace);
  expect(taskLoadOlderWhiteSpace).toBe("nowrap");
  const taskLoadOlderBox = await taskLoadOlder.boundingBox();
  const taskEntriesBox = await taskEntries.boundingBox();
  expect(taskLoadOlderBox).not.toBeNull();
  expect(taskEntriesBox).not.toBeNull();
  expect((taskLoadOlderBox?.x ?? 0)).toBeGreaterThan((taskEntriesBox?.x ?? 0));
  await expect(page.locator(`[data-log-id="${hiddenTaskLogId}"]`)).toHaveCount(0);
  await page.waitForTimeout(1000);
  await expect(taskLoadOlder).toBeVisible();
  await expect(page.locator(`[data-log-id="${hiddenTaskLogId}"]`)).toHaveCount(0);

});
