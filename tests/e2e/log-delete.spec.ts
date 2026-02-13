import { expect, test } from "@playwright/test";

test("messages can be deleted and disappear immediately in the UI", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();

  const topicId = `topic-delete-${suffix}`;
  const topicName = `Delete Topic ${suffix}`;
  const taskId = `task-delete-${suffix}`;
  const taskName = `Delete Task ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, { data: { id: topicId, name: topicName, pinned: false } });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskName, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const message = `delete-me-${suffix}`;
  const logRes = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: message,
      summary: `Delete summary ${suffix}`,
      classificationStatus: "classified",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey: `channel:test-delete-${suffix}` },
    },
  });
  expect(logRes.ok()).toBeTruthy();
  const log = await logRes.json();

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  await page.locator("div[role='button']").filter({ hasText: topicName }).first().click();
  await page.locator("div[role='button']").filter({ hasText: taskName }).first().click();

  const row = page.locator(`[data-log-id="${log.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId(`message-bubble-${log.id}`)).toContainText(message);

  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByRole("button", { name: "Delete" }).click();
  await row.getByRole("button", { name: "Confirm delete" }).click();

  await expect(page.locator(`[data-log-id="${log.id}"]`)).toHaveCount(0);
});
