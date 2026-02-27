import { expect, test } from "@playwright/test";

test.describe("mobile task fullscreen chat", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("task chat is fullscreen, scrollable, and closes cleanly", async ({ page, request }, testInfo) => {
    test.setTimeout(45_000);
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `mobile-topic-${suffix}`;
    const topicName = `Mobile Topic ${suffix}`;
    const taskId = `mobile-task-${suffix}`;
    const taskTitle = `Mobile Task ${suffix}`;
    const sessionKey = `channel:mobile-${suffix}`;

    const createTopic = await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false },
    });
    expect(createTopic.ok()).toBeTruthy();

    const createTask = await request.post(`${apiBase}/api/tasks`, {
      data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
    });
    expect(createTask.ok()).toBeTruthy();

    for (let i = 0; i < 12; i += 1) {
      const fromUser = i % 2 === 0;
      const res = await request.post(`${apiBase}/api/log`, {
        data: {
          topicId,
          taskId,
          type: "conversation",
          content: `${fromUser ? "user" : "assistant"}-${suffix}-${i} ${"lorem ipsum ".repeat(18)}`,
          summary: `msg-${i}`,
          classificationStatus: "classified",
          agentId: fromUser ? "user" : "assistant",
          agentLabel: fromUser ? "User" : "OpenClaw",
          source: { sessionKey },
        },
        timeout: 10_000,
      });
      expect(res.ok()).toBeTruthy();
    }

    await page.goto("/u");
    await page.getByTestId("unified-composer-textarea").first().waitFor();

    await page.getByRole("button", { name: `Expand topic ${topicName}`, exact: true }).click();
    await page.getByRole("button", { name: `Expand task ${taskTitle}`, exact: true }).click();

    const taskCard = page.locator(`[data-task-card-id='${taskId}']`).first();
    await expect(taskCard).toBeVisible();

    const cardPosition = await taskCard.evaluate((el) => window.getComputedStyle(el).position);
    expect(cardPosition).toBe("fixed");
    const cardBackground = await taskCard.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(cardBackground === "transparent" || cardBackground === "rgba(0, 0, 0, 0)").toBeFalsy();

    const box = await taskCard.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeLessThanOrEqual(1);
    expect(box!.height).toBeGreaterThanOrEqual(840);

    await expect(page.getByRole("button", { name: "Close chat" })).toBeVisible();
    const context = page.getByTestId(`task-chat-context-${taskId}`);
    await expect(context).toBeVisible();
    await expect(context).toContainText(topicName);
    await expect(context).toContainText(taskTitle);
    const breadcrumb = page.getByTestId(`task-chat-breadcrumb-${taskId}`);
    await expect(breadcrumb).toBeVisible();
    const breadcrumbWrap = await breadcrumb.evaluate((el) => window.getComputedStyle(el).flexWrap);
    expect(breadcrumbWrap).toBe("wrap");

    const statusSelect = page.getByTestId(`task-chat-status-${taskId}`);
    await expect(statusSelect).toBeVisible();
    const statusBox = await statusSelect.boundingBox();
    expect(statusBox).not.toBeNull();
    expect(statusBox!.width).toBeGreaterThanOrEqual(104);
    expect(statusBox!.width).toBeLessThanOrEqual(112);
    await statusSelect.selectOption("doing");
    await expect(statusSelect).toHaveValue("doing");
    await statusSelect.selectOption("todo");
    await expect(statusSelect).toHaveValue("todo");

    const scroller = page.getByTestId(`task-chat-scroll-${taskId}`);
    await expect(scroller).toBeVisible();

    const scrollMetrics = await scroller.evaluate((el) => {
      const node = el as HTMLElement;
      return {
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        before: node.scrollTop,
      };
    });

    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight + 20);

    const afterScroll = await scroller.evaluate((el) => {
      const node = el as HTMLElement;
      const start = node.scrollTop;
      node.scrollTop = Math.max(0, start - 300);
      return { start, end: node.scrollTop };
    });

    expect(afterScroll.end).not.toBe(afterScroll.start);

    const controls = page.getByTestId(`task-chat-controls-${taskId}`);
    await expect(controls).toBeVisible();
    const flexWrap = await controls.evaluate((el) => window.getComputedStyle(el).flexWrap);
    expect(flexWrap).toBe("nowrap");

    const loadOlder = controls.getByRole("button", { name: "Load older" });
    if (await loadOlder.count()) {
      const entries = page.getByTestId(`task-chat-entries-${taskId}`);
      const loadOlderBox = await loadOlder.first().boundingBox();
      const entriesBox = await entries.boundingBox();
      expect(loadOlderBox).not.toBeNull();
      expect(entriesBox).not.toBeNull();
      expect((statusBox?.y ?? 0)).toBeLessThan((entriesBox?.y ?? 0));
      expect((loadOlderBox?.x ?? 0)).toBeGreaterThan((entriesBox?.x ?? 0));
      const statusRight = (statusBox?.x ?? 0) + (statusBox?.width ?? 0);
      const loadOlderRight = (loadOlderBox?.x ?? 0) + (loadOlderBox?.width ?? 0);
      expect(Math.abs(statusRight - loadOlderRight)).toBeLessThanOrEqual(10);
      const overlap =
        Math.min((loadOlderBox?.y ?? 0) + (loadOlderBox?.height ?? 0), (entriesBox?.y ?? 0) + (entriesBox?.height ?? 0)) -
        Math.max(loadOlderBox?.y ?? 0, entriesBox?.y ?? 0);
      expect(overlap).toBeGreaterThan(0);
    }

    const composer = page.getByTestId(`task-chat-composer-${taskId}`);
    await expect(composer).toBeVisible();
    const composerInput = composer.getByRole("textbox").first();
    await expect(composer.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Attach files" })).toBeVisible();
    await composerInput.click();
    await composerInput.fill("Drafting while reviewing earlier messages.");
    await scroller.evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = 0;
    });
    await scroller.evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = node.scrollHeight;
    });
    await expect(composer).toBeVisible();
    await expect(composerInput).toBeVisible();
    const composerBox = await composer.boundingBox();
    const viewport = page.viewportSize();
    expect(composerBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 6);

    await page.screenshot({ path: testInfo.outputPath("task-fullscreen-open.png") });

    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(page.getByRole("button", { name: "Close chat" })).toHaveCount(0);

    await page.screenshot({ path: testInfo.outputPath("task-fullscreen-closed.png") });
  });

  test("marking active task done exits fullscreen and returns to topic view", async ({ page, request }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `mobile-topic-done-${suffix}`;
    const topicName = `Mobile Topic Done ${suffix}`;
    const taskId = `mobile-task-done-${suffix}`;
    const taskTitle = `Mobile Task Done ${suffix}`;

    const createTopic = await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false },
    });
    expect(createTopic.ok()).toBeTruthy();

    const createTask = await request.post(`${apiBase}/api/tasks`, {
      data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
    });
    expect(createTask.ok()).toBeTruthy();

    await page.goto("/u");
    await page.getByTestId("unified-composer-textarea").first().waitFor();

    await page.getByRole("button", { name: `Expand topic ${topicName}`, exact: true }).click();
    await page.getByRole("button", { name: `Expand task ${taskTitle}`, exact: true }).click();

    const closeButton = page.getByRole("button", { name: "Close chat" });
    await expect(closeButton).toBeVisible();

    const statusSelect = page.getByTestId(`task-chat-status-${taskId}`);
    await expect(statusSelect).toBeVisible();
    await statusSelect.selectOption("done");

    await expect(closeButton).toHaveCount(0);

    const topicCard = page.locator(`[data-topic-card-id='${topicId}']`).first();
    await expect(topicCard).toBeVisible();
    await expect(topicCard.getByPlaceholder(/Add a task/)).toBeVisible();
    await expect(topicCard.locator(`[data-task-card-id='${taskId}']`)).toHaveCount(0);
  });

  test("marking active task done with done visible exits fullscreen and collapses task", async ({ page, request }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `mobile-topic-done-visible-${suffix}`;
    const topicName = `Mobile Topic Done Visible ${suffix}`;
    const taskId = `mobile-task-done-visible-${suffix}`;
    const taskTitle = `Mobile Task Done Visible ${suffix}`;

    const createTopic = await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false },
    });
    expect(createTopic.ok()).toBeTruthy();

    const createTask = await request.post(`${apiBase}/api/tasks`, {
      data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
    });
    expect(createTask.ok()).toBeTruthy();

    await page.goto("/u?done=1");
    await page.getByTestId("unified-composer-textarea").first().waitFor();

    await page.getByRole("button", { name: `Expand topic ${topicName}`, exact: true }).click();
    await page.getByRole("button", { name: `Expand task ${taskTitle}`, exact: true }).click();

    const closeButton = page.getByRole("button", { name: "Close chat" });
    await expect(closeButton).toBeVisible();

    const statusSelect = page.getByTestId(`task-chat-status-${taskId}`);
    await expect(statusSelect).toBeVisible();
    await statusSelect.selectOption("done");

    await expect(closeButton).toHaveCount(0);

    const taskCard = page.locator(`[data-task-card-id='${taskId}']`).first();
    await expect(taskCard).toBeVisible();
    await expect
      .poll(async () => taskCard.getByText("TASK CHAT").count(), { timeout: 20000 })
      .toBe(0);
    await expect
      .poll(async () => page.getByTestId(`task-chat-controls-${taskId}`).count(), { timeout: 20000 })
      .toBe(0);
  });
});
