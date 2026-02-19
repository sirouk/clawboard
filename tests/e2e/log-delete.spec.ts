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

  let deleteOpened = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await row.getByRole("button", { name: "Edit" }).click({ timeout: 5000 });
      const deleteButton = row.getByRole("button", { name: "Delete" });
      await expect(deleteButton).toBeVisible({ timeout: 4000 });
      await deleteButton.click({ timeout: 5000 });
      deleteOpened = true;
      break;
    } catch {
      if (attempt === 5) throw new Error("Failed to open delete confirmation controls.");
      await page.waitForTimeout(120);
    }
  }
  expect(deleteOpened).toBeTruthy();

  await row.getByRole("button", { name: "Confirm delete" }).click({ timeout: 5000 });

  await expect(page.locator(`[data-log-id="${log.id}"]`)).toHaveCount(0);
});
