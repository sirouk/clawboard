import { expect, test } from "@playwright/test";

test.describe("mobile task chat fullscreen", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("task chat is available on mobile and topic chat controls are absent", async ({ page, request }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `mobile-task-chat-${suffix}`;
    const topicName = `Mobile Task Overlay ${suffix}`;
    const taskId = `task-mobile-${suffix}`;
    const taskTitle = `Mobile Task ${suffix}`;
    const sessionKey = `clawboard:task:${topicId}:${taskId}`;

    const createTopic = await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false },
    });
    expect(createTopic.ok()).toBeTruthy();

    const createTask = await request.post(`${apiBase}/api/tasks`, {
      data: { id: taskId, topicId, title: taskTitle, status: "doing", pinned: false },
    });
    expect(createTask.ok()).toBeTruthy();

    for (let i = 0; i < 6; i += 1) {
      const fromUser = i % 2 === 0;
      const res = await request.post(`${apiBase}/api/log`, {
        data: {
          topicId,
          taskId,
          type: "conversation",
          content: `${fromUser ? "user" : "assistant"}-${suffix}-${i}`,
          summary: `task-msg-${i}`,
          classificationStatus: "classified",
          agentId: fromUser ? "user" : "assistant",
          agentLabel: fromUser ? "User" : "OpenClaw",
          source: { sessionKey },
        },
      });
      expect(res.ok()).toBeTruthy();
    }

    await page.goto("/u");
    await page.getByTestId("unified-composer-textarea").first().waitFor();
    await page.getByRole("button", { name: new RegExp(topicName) }).first().click();
    await page.getByRole("button", { name: new RegExp(taskTitle) }).first().click();
    await expect(page.getByTestId(`toggle-topic-chat-${topicId}`)).toHaveCount(0);
    await expect(page.getByTestId(`task-chat-composer-${taskId}`)).toBeVisible();
    await expect(page.getByTestId(`task-chat-scroll-${taskId}`)).toBeVisible();
  });
});
