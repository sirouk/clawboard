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
