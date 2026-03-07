import { test, expect } from "@playwright/test";

test.describe("Real Chat E2E", () => {
  test("should send a message and see it in the log", async ({ page, request }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `topic-real-chat-${suffix}`;
    const topicName = `Real Chat ${suffix}`;
    const taskId = `task-real-chat-${suffix}`;
    const taskTitle = `Real Chat Task ${suffix}`;
    const sessionKey = `clawboard:task:${topicId}:${taskId}`;
    const message = `Hello from Playwright E2E ${suffix}`;

    const createTopic = await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false },
    });
    expect(createTopic.ok()).toBeTruthy();

    const createTask = await request.post(`${apiBase}/api/tasks`, {
      data: { id: taskId, topicId, title: taskTitle, status: "doing", pinned: false },
    });
    expect(createTask.ok()).toBeTruthy();

    await page.goto(`/u/topic/${topicId}/task/${taskId}?reveal=1`);
    await page.getByRole("heading", { name: "Unified View" }).waitFor();

    const composer = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
    await expect(composer).toBeVisible();
    await composer.fill(taskTitle);
    const topicHeader = page.locator(`[data-topic-card-id="${topicId}"] > div[role="button"]`).first();
    await expect(topicHeader).toBeVisible();
    const topicExpanded = (await topicHeader.getAttribute("aria-expanded")) === "true";
    if (!topicExpanded) {
      await topicHeader.click();
    }
    const taskHeader = page.locator(`[data-task-card-id="${taskId}"] > div[role="button"]`).first();
    await expect(taskHeader).toBeVisible({ timeout: 20_000 });
    const selectTarget = page.getByTestId(`select-task-target-${taskId}`);
    await expect(selectTarget).toBeVisible({ timeout: 20_000 });
    await selectTarget.click();
    await expect(page.getByTestId("unified-composer-target-chip")).toContainText(taskTitle);

    await composer.fill(message);
    await composer.press("Enter");
    await expect
      .poll(async () => {
        const logsRes = await request.get(`${apiBase}/api/log?sessionKey=${encodeURIComponent(sessionKey)}&limit=30`);
        if (!logsRes.ok()) return false;
        const rows = (await logsRes.json()) as Array<{ content?: string }>;
        return rows.some((row) => row.content === message);
      })
      .toBeTruthy();

    await page.goto("/log");
    await page.getByRole("heading", { name: "All Activity" }).waitFor();
    await expect(page.getByText(message, { exact: true }).first()).toBeVisible();
  });
});
