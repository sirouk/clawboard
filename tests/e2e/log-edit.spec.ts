import { expect, test } from "@playwright/test";

test("messages can be edited and reallocated without impossible topic/task combinations", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();

  const topicAId = `topic-edit-a-${suffix}`;
  const topicBId = `topic-edit-b-${suffix}`;
  const topicAName = `Edit Topic A ${suffix}`;
  const topicBName = `Edit Topic B ${suffix}`;

  const createTopicA = await request.post(`${apiBase}/api/topics`, { data: { id: topicAId, name: topicAName, pinned: false } });
  const createTopicB = await request.post(`${apiBase}/api/topics`, { data: { id: topicBId, name: topicBName, pinned: false } });
  expect(createTopicA.ok()).toBeTruthy();
  expect(createTopicB.ok()).toBeTruthy();

  const taskAId = `task-edit-a-${suffix}`;
  const taskBId = `task-edit-b-${suffix}`;
  const taskAName = `Edit Task A ${suffix}`;
  const taskBName = `Edit Task B ${suffix}`;

  const createTaskA = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskAId, topicId: topicAId, title: taskAName, status: "todo", pinned: false },
  });
  const createTaskB = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskBId, topicId: topicBId, title: taskBName, status: "todo", pinned: false },
  });
  expect(createTaskA.ok()).toBeTruthy();
  expect(createTaskB.ok()).toBeTruthy();

  const originalMessage = `original-message-${suffix}`;
  const updatedMessage = `updated-message-${suffix}`;
  const logRes = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId: topicAId,
      taskId: taskAId,
      type: "conversation",
      content: originalMessage,
      summary: "Original summary",
      classificationStatus: "classified",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey: `channel:test-edit-${suffix}` },
    },
  });
  expect(logRes.ok()).toBeTruthy();
  const log = await logRes.json();

  await page.goto(`/u/topic/${topicAId}/task/${taskAId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const row = page.locator(`[data-log-id="${log.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId(`message-bubble-${log.id}`)).toContainText(originalMessage);

  const editButton = row.getByRole("button", { name: "Edit", exact: true });
  await expect(editButton).toBeVisible();
  await editButton.click();
  await expect(row.getByText("Edit message", { exact: false })).toBeVisible();

  const selects = row.locator("select");
  await expect(selects.first()).toBeVisible();
  await expect(selects).toHaveCount(2);
  const topicSelect = selects.nth(0);
  const taskSelect = selects.nth(1);

  await topicSelect.selectOption({ value: topicBId });
  await expect(taskSelect.locator("option", { hasText: taskAName })).toHaveCount(0);
  await taskSelect.selectOption({ value: taskBId });

  await row.locator("textarea").first().fill(updatedMessage);
  await row.getByRole("button", { name: "Save" }).click();

  // The log should immediately disappear from the previous task chat scope.
  await expect(page.locator(`[data-log-id="${log.id}"]`)).toHaveCount(0);

  // Expand the new destination and confirm the edited message is present.
  await page.goto(`/u/topic/${topicBId}/task/${taskBId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();
  const movedRow = page.locator(`[data-log-id="${log.id}"]`);
  await expect(movedRow).toBeVisible();
  await expect(movedRow.getByTestId(`message-bubble-${log.id}`)).toContainText(updatedMessage);
});
