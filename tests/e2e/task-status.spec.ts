import { expect, test } from "@playwright/test";

test("task status selector updates and persists", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-status-${suffix}`;
  const topicName = `Status Topic ${suffix}`;
  const taskId = `task-status-${suffix}`;
  const taskTitle = `Status Task ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();
  await page.locator("div[role='button']").filter({ hasText: topicName }).first().click();

  const statusUpdate = page.waitForRequest((apiRequest) => {
    if (!apiRequest.url().includes("/api/tasks") || apiRequest.method() !== "POST") return false;
    try {
      const body = apiRequest.postDataJSON() as Record<string, unknown>;
      return body.id === taskId && body.status === "done";
    } catch {
      return false;
    }
  });

  await page.getByTestId(`rename-task-${taskId}`).click();
  await page.getByTestId(`task-status-${taskId}`).selectOption("done");
  await statusUpdate;
  await expect(page.getByTestId(`task-status-${taskId}`)).toHaveCount(0);

  const tasksRes = await request.get(`${apiBase}/api/tasks`);
  expect(tasksRes.ok()).toBeTruthy();
  const tasks = (await tasksRes.json()) as Array<{ id: string; status: string }>;
  const updated = tasks.find((task) => task.id === taskId);
  expect(updated?.status).toBe("done");
});

test("collapsed task status dropdown is visible and keyboard navigable", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-status-menu-${suffix}`;
  const topicName = `Status Menu Topic ${suffix}`;
  const taskId = `task-status-menu-${suffix}`;
  const taskTitle = `Status Menu Task ${suffix}`;
  const taskId2 = `task-status-menu-${suffix}-b`;
  const taskTitle2 = `Status Menu Task ${suffix} B`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const createTask2 = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId2, topicId, title: taskTitle2, status: "todo", pinned: false },
  });
  expect(createTask2.ok()).toBeTruthy();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();
  await page.locator("div[role='button']").filter({ hasText: topicName }).first().click();

  const taskCard = page.locator(`[data-task-card-id='${taskId}']`);
  await expect(taskCard).toBeVisible();
  await expect(taskCard.getByText("TASK CHAT")).toHaveCount(0);

  const trigger = page.getByTestId(`task-status-trigger-${taskId}`);
  await expect(trigger).toBeVisible();
  await trigger.click();

  const menu = page.getByTestId(`task-status-menu-${taskId}`);
  await expect(menu).toBeVisible();

  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect((menuBox?.height ?? 0) > 40).toBeTruthy();

  const statusUpdate = page.waitForRequest((apiRequest) => {
    if (!apiRequest.url().includes("/api/tasks") || apiRequest.method() !== "POST") return false;
    try {
      const body = apiRequest.postDataJSON() as Record<string, unknown>;
      return body.id === taskId && body.status === "blocked";
    } catch {
      return false;
    }
  });

  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId(`task-status-option-${taskId}-0`)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId(`task-status-option-${taskId}-1`)).toBeFocused();
  await page.keyboard.press("Enter");

  await statusUpdate;
  await expect(menu).toHaveCount(0);

  const tasksRes = await request.get(`${apiBase}/api/tasks`);
  expect(tasksRes.ok()).toBeTruthy();
  const tasks = (await tasksRes.json()) as Array<{ id: string; status: string }>;
  const updated = tasks.find((task) => task.id === taskId);
  expect(updated?.status).toBe("blocked");
});

test("mobile task status dropdown remains usable", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-status-mobile-${suffix}`;
  const topicName = `Status Mobile Topic ${suffix}`;
  const taskId = `task-status-mobile-${suffix}`;
  const taskTitle = `Status Mobile Task ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/u");
  await page.getByText("Unified View").first().waitFor();
  await page.getByRole("button", { name: `Expand topic ${topicName}`, exact: true }).click();

  const trigger = page.getByTestId(`task-status-trigger-${taskId}`);
  await expect(trigger).toBeVisible();
  await trigger.click();

  const option = page.getByRole("menuitem", { name: "Done" }).first();
  await expect(option).toBeVisible();

  const statusUpdate = page.waitForRequest((apiRequest) => {
    if (!apiRequest.url().includes("/api/tasks") || apiRequest.method() !== "POST") return false;
    try {
      const body = apiRequest.postDataJSON() as Record<string, unknown>;
      return body.id === taskId && body.status === "done";
    } catch {
      return false;
    }
  });

  await option.click();
  await statusUpdate;

  const tasksRes = await request.get(`${apiBase}/api/tasks`);
  expect(tasksRes.ok()).toBeTruthy();
  const tasks = (await tasksRes.json()) as Array<{ id: string; status: string }>;
  const updated = tasks.find((task) => task.id === taskId);
  expect(updated?.status).toBe("done");
});
