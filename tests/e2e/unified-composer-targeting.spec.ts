import { expect, test } from "@playwright/test";

test("unified composer auto-grows and routes continuation to explicit selected target", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-target-${suffix}`;
  const topicName = `Target Topic ${suffix}`;
  const taskId = `task-target-${suffix}`;
  const taskTitle = `Target Task ${suffix}`;
  const logNeedle = `needle-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const createLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: `search-hit ${logNeedle}`,
      summary: "Search hit message",
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey: `clawboard:task:${topicId}:${taskId}` },
    },
  });
  expect(createLog.ok()).toBeTruthy();

  const sentPayloads: Array<Record<string, unknown>> = [];
  await page.route("**/api/openclaw/chat", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    sentPayloads.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });

  await page.goto(`/u/topic/${topicId}/task/${taskId}?q=${encodeURIComponent(logNeedle)}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const textarea = page.getByTestId("unified-composer-textarea");
  await expect(textarea).toBeVisible();

  const beforeHeight = await textarea.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  await textarea.fill(["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n"));
  const afterHeight = await textarea.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(afterHeight).toBeGreaterThan(beforeHeight);
  await expect(textarea).toHaveCSS("overflow-y", "hidden");

  await page.getByTestId("unified-composer-new-topic").click();
  await expect.poll(() => sentPayloads.length).toBe(1);
  expect(String(sentPayloads[0]?.sessionKey ?? "")).toMatch(/^clawboard:topic:topic-/);
  expect(sentPayloads[0]?.topicOnly).toBe(false);

  await textarea.fill("continue in explicit task target");
  await page.getByTestId(`select-task-target-${taskId}`).click();
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText(`task: ${taskTitle}`);

  await page.getByTestId("unified-composer-send").click();
  await expect.poll(() => sentPayloads.length).toBe(2);
  expect(sentPayloads[1]?.sessionKey).toBe(`clawboard:task:${topicId}:${taskId}`);
});
