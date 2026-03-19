import { expect, test } from "@playwright/test";

test("board topics panel can search topics and navigate into unified view selection", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-nav-${suffix}`;
  const topicName = `Nav Topic ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  await page.goto("/u");
  await page.getByRole("heading", { name: "Board View" }).waitFor();

  // Expand the Board topics panel in the left nav.
  await page.locator("aside").getByRole("link", { name: "Board", exact: true }).click();
  const searchInput = page.getByPlaceholder("Search tasks, topics…");
  await expect(searchInput).toBeVisible();

  await searchInput.fill(topicName);
  const navTopicButton = page.locator(`aside [data-board-topic-id='${topicId}'] > button`).first();
  await expect(navTopicButton).toBeVisible();
  await navTopicButton.click();

  await expect(page).toHaveURL(new RegExp(`/u/topic/.*${topicId}`));
  await expect(page.locator("div[role='button']").filter({ hasText: topicName }).first()).toHaveAttribute("aria-expanded", "true");
});

test("creating a task in topic view auto-expands task chat and focuses task composer", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-create-task-${suffix}`;
  const topicName = `Create Task Topic ${suffix}`;
  const taskTitle = `Task from topic ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  await page.goto(`/u/topic/${topicId}`);
  await page.getByRole("heading", { name: "Board View" }).waitFor();

  const topicCard = page.locator(`[data-topic-card-id='${topicId}']`).first();
  await expect(topicCard).toBeVisible();

  const addTaskInput = topicCard.getByPlaceholder("Add a task…");
  if (!(await addTaskInput.isVisible())) {
    await topicCard.getByTitle("Expand").click();
  }
  await expect(addTaskInput).toBeVisible();

  const createTaskRequest = page.waitForResponse((resp) => {
    return resp.url().includes("/api/tasks") && resp.request().method() === "POST";
  });

  await addTaskInput.fill(taskTitle);
  await addTaskInput.press("Enter");
  await createTaskRequest;

  const taskCard = page.locator("[data-task-card-id]").filter({ hasText: taskTitle }).first();
  await expect(taskCard).toBeVisible();
  const taskId = await taskCard.getAttribute("data-task-card-id");
  expect(taskId).toBeTruthy();

  const taskComposer = page.getByTestId(`task-chat-composer-${taskId}`);
  await expect(taskComposer).toBeVisible();
  await expect(taskComposer.getByRole("textbox")).toBeFocused();
});

test("typed /abort in task composer cancels in-flight run as a /stop alias", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-abort-${suffix}`;
  const topicName = `Abort Topic ${suffix}`;
  const taskId = `task-abort-${suffix}`;
  const taskTitle = `Abort Task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const postPayloads: Array<Record<string, unknown>> = [];
  const deletePayloads: Array<Record<string, unknown>> = [];
  const requestId = `occhat-abort-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();
  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.route("**/api/openclaw/chat", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      postPayloads.push(payload);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ queued: true, requestId }),
      });
      return;
    }
    if (method === "DELETE") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      deletePayloads.push(payload);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ aborted: true, queueCancelled: 1, sessionKey, sessionKeys: [sessionKey] }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Board View" }).waitFor();

  const taskComposer = page.getByTestId(`task-chat-composer-${taskId}`);
  await expect(taskComposer).toBeVisible();
  const textbox = taskComposer.getByRole("textbox");
  const sendButton = taskComposer.getByRole("button", { name: "Send" });

  await textbox.fill(`start-task-run-${suffix}`);
  await sendButton.click();
  await expect.poll(() => postPayloads.length).toBe(1);

  await textbox.fill("/abort");
  await sendButton.click();
  await expect.poll(() => deletePayloads.length).toBe(1);

  expect(postPayloads).toHaveLength(1);
  expect(postPayloads[0]?.sessionKey).toBe(sessionKey);
  expect(postPayloads[0]?.message).toBe(`start-task-run-${suffix}`);
  expect(deletePayloads[0]?.sessionKey).toBe(sessionKey);
  expect(deletePayloads[0]?.requestId).toBe(requestId);
  await expect(taskComposer.getByText("Cancellation requested.")).toBeVisible();
});

test("topic chat history window stays anchored when new entries arrive", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-history-stable-${suffix}`;
  const topicName = `History Stable ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  // Seed 4 conversation logs: user-1, asst-1, user-2, asst-2.
  // With TASK_TIMELINE_LIMIT=2 only the last 2 visible entries (user-2, asst-2) show initially.
  const base = Date.now() - 10_000;
  const msgOldest = `oldest-${suffix}`;
  const msgNewest = `newest-${suffix}`;
  const seedLogs = [
    { agentId: "user",      content: msgOldest,           createdAt: new Date(base).toISOString() },
    { agentId: "assistant", content: `asst-1-${suffix}`,  createdAt: new Date(base + 1000).toISOString() },
    { agentId: "user",      content: msgNewest,           createdAt: new Date(base + 2000).toISOString() },
    { agentId: "assistant", content: `asst-2-${suffix}`,  createdAt: new Date(base + 3000).toISOString() },
  ];
  for (const entry of seedLogs) {
    const r = await request.post(`${apiBase}/api/log`, {
      data: { topicId, type: "conversation", classificationStatus: "classified", ...entry },
    });
    expect(r.ok()).toBeTruthy();
  }

  await page.goto(`/u/topic/${topicId}`);
  await page.getByRole("heading", { name: "Board View" }).waitFor();

  const scrollEl = page.getByTestId(`topic-chat-scroll-${topicId}`);
  await expect(scrollEl).toBeVisible({ timeout: 15_000 });

  // Newest message must be visible; oldest must be absent from DOM (truncated).
  await expect(scrollEl.getByText(msgNewest, { exact: false })).toBeVisible();
  await expect(scrollEl.locator(`text=${msgOldest}`)).toHaveCount(0);

  // Inject 5 action entries to simulate agent activity arriving via SSE.
  for (let i = 0; i < 5; i++) {
    await request.post(`${apiBase}/api/log`, {
      data: {
        topicId,
        type: "action",
        agentId: "agent",
        content: `agent-action-${i}-${suffix}`,
        summary: `action ${i}`,
        createdAt: new Date(base + 4000 + i * 200).toISOString(),
        classificationStatus: "classified",
      },
    });
  }

  // Allow time for the client to process SSE events and re-render.
  await page.waitForTimeout(1500);

  // After new entries the window must remain anchored:
  // - newest user message still visible (not scrolled away)
  // - oldest user message still absent (no backward drift)
  await expect(scrollEl.getByText(msgNewest, { exact: false })).toBeVisible();
  await expect(scrollEl.locator(`text=${msgOldest}`)).toHaveCount(0);
});

test("topic chat scroll to top loads older messages", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-scroll-older-${suffix}`;
  const topicName = `Scroll Older ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  // Long content ensures the 2 visible messages overflow the scroll container,
  // so the initial scrollTop will be > 0 and setting it to 0 fires a real scroll event.
  const longBody = "x".repeat(1500);
  const base = Date.now() - 10_000;
  const msgOldest = `oldest-scroll-${suffix}`;
  const msgMiddle = `middle-scroll-${suffix}`;
  const msgNewest = `newest-scroll-${suffix}`;
  const seedLogs = [
    { agentId: "user",      content: `${msgOldest} ${longBody}`, createdAt: new Date(base).toISOString() },
    { agentId: "assistant", content: `asst-1-${suffix} ${longBody}`, createdAt: new Date(base + 1000).toISOString() },
    { agentId: "user",      content: `${msgMiddle} ${longBody}`, createdAt: new Date(base + 2000).toISOString() },
    { agentId: "assistant", content: `asst-2-${suffix} ${longBody}`, createdAt: new Date(base + 3000).toISOString() },
    { agentId: "user",      content: `${msgNewest} ${longBody}`, createdAt: new Date(base + 4000).toISOString() },
    { agentId: "assistant", content: `asst-3-${suffix} ${longBody}`, createdAt: new Date(base + 5000).toISOString() },
  ];
  for (const entry of seedLogs) {
    const r = await request.post(`${apiBase}/api/log`, {
      data: { topicId, type: "conversation", classificationStatus: "classified", ...entry },
    });
    expect(r.ok()).toBeTruthy();
  }

  await page.goto(`/u/topic/${topicId}`);

  const scrollEl = page.getByTestId(`topic-chat-scroll-${topicId}`);
  const historyHint = page.getByTestId(`topic-chat-history-hint-${topicId}`);
  await expect(scrollEl).toBeVisible({ timeout: 15_000 });
  await expect(historyHint).toBeVisible();
  await expect(historyHint).toContainText("older above");

  // Give the chat time to auto-scroll to the bottom.
  await page.waitForTimeout(500);

  // Oldest message must not be in the DOM yet.
  await expect(scrollEl.locator(`text=${msgOldest}`)).toHaveCount(0);
  await expect(scrollEl.locator(`text=${msgMiddle}`)).toHaveCount(0);
  // Newest is visible.
  await expect(scrollEl.getByText(msgNewest, { exact: false })).toBeVisible();

  // Scroll the chat area to the top.  React's onScroll handler calls loadOlderChat
  // when scrollTop <= 24 and the chat is truncated.
  await scrollEl.evaluate((el) => {
    el.scrollTop = 0;
  });

  // Wait for React to re-render with the next older slice appended.
  await expect(scrollEl.getByText(msgMiddle, { exact: false })).toBeVisible({ timeout: 5_000 });
  await expect(scrollEl.locator(`text=${msgOldest}`)).toHaveCount(0);
  await expect(historyHint).toBeVisible();

  // Continued upward scroll pressure should load the next slice without requiring
  // a down-then-up reset of the scroll position.
  await scrollEl.hover();
  await page.mouse.wheel(0, -240);

  await expect(scrollEl.getByText(msgOldest, { exact: false })).toBeVisible({ timeout: 5_000 });
  await expect(historyHint).toHaveCount(0);
});

test("expanded topic routes upward wheel back into topic chat before page scroll", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const longBody = "y".repeat(1800);
  const fillerTopicIds: string[] = [];

  for (let i = 0; i < 6; i += 1) {
    const topicId = `topic-scroll-lock-filler-${i}-${suffix}`;
    fillerTopicIds.push(topicId);
    const createTopic = await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: `Scroll Lock Filler ${i} ${suffix}`, pinned: false, sortIndex: i },
    });
    expect(createTopic.ok()).toBeTruthy();
  }

  const topicId = `topic-scroll-lock-${suffix}`;
  const topicName = `Scroll Lock ${suffix}`;
  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false, sortIndex: 99 },
  });
  expect(createTopic.ok()).toBeTruthy();

  const base = Date.now() - 10_000;
  const seedLogs = [
    { agentId: "user", content: `older-lock-a-${suffix} ${longBody}`, createdAt: new Date(base).toISOString() },
    { agentId: "assistant", content: `older-lock-b-${suffix} ${longBody}`, createdAt: new Date(base + 1000).toISOString() },
    { agentId: "user", content: `older-lock-c-${suffix} ${longBody}`, createdAt: new Date(base + 2000).toISOString() },
    { agentId: "assistant", content: `older-lock-d-${suffix} ${longBody}`, createdAt: new Date(base + 3000).toISOString() },
    { agentId: "user", content: `older-lock-e-${suffix} ${longBody}`, createdAt: new Date(base + 4000).toISOString() },
    { agentId: "assistant", content: `older-lock-f-${suffix} ${longBody}`, createdAt: new Date(base + 5000).toISOString() },
  ];
  for (const entry of seedLogs) {
    const r = await request.post(`${apiBase}/api/log`, {
      data: { topicId, type: "conversation", classificationStatus: "classified", ...entry },
    });
    expect(r.ok()).toBeTruthy();
  }

  await page.goto("/u");

  const topicCard = page.locator(`[data-topic-card-id="${topicId}"]`).first();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await expect(topicCard).toBeVisible({ timeout: 8_000 });
      await topicCard.evaluate((el) => {
        el.scrollIntoView({ block: "center", behavior: "auto" });
      });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await page.waitForTimeout(150);
    }
  }

  await topicCard.getByTitle("Expand").click();

  const scrollEl = page.getByTestId(`topic-chat-scroll-${topicId}`);
  await expect(scrollEl).toBeVisible();
  await page.waitForTimeout(500);

  const cardBoxBefore = await topicCard.boundingBox();
  const topicHeader = topicCard.locator("> div[role='button']").first();
  const chatScrollBefore = await scrollEl.evaluate((el) => el.scrollTop);
  expect(cardBoxBefore).not.toBeNull();
  expect(chatScrollBefore).toBeGreaterThan(20);

  await topicHeader.evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -320, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(150);

  const cardBoxAfter = await topicCard.boundingBox();
  const chatScrollAfter = await scrollEl.evaluate((el) => el.scrollTop);
  expect(cardBoxAfter).not.toBeNull();
  expect(chatScrollAfter).toBeLessThan(chatScrollBefore);
  expect(Math.abs((cardBoxAfter?.y ?? 0) - (cardBoxBefore?.y ?? 0))).toBeLessThan(8);
});

test("topic chat releases scroll back to the page at top and bottom edges", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const longBody = "z".repeat(1800);

  for (let i = 0; i < 10; i += 1) {
    const fillerId = `topic-scroll-release-filler-${i}-${suffix}`;
    const createFiller = await request.post(`${apiBase}/api/topics`, {
      data: { id: fillerId, name: `Scroll Release Filler ${i} ${suffix}`, pinned: false, sortIndex: i },
    });
    expect(createFiller.ok()).toBeTruthy();
  }

  const topicId = `topic-scroll-release-${suffix}`;
  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: `Scroll Release ${suffix}`, pinned: false, sortIndex: 4 },
  });
  expect(createTopic.ok()).toBeTruthy();

  const base = Date.now() - 10_000;
  const msgOldest = `release-oldest-${suffix}`;
  const msgMiddle = `release-middle-${suffix}`;
  const msgNewest = `release-newest-${suffix}`;
  const seedLogs = [
    { agentId: "user", content: `${msgOldest} ${longBody}`, createdAt: new Date(base).toISOString() },
    { agentId: "assistant", content: `release-asst-1-${suffix} ${longBody}`, createdAt: new Date(base + 1000).toISOString() },
    { agentId: "user", content: `${msgMiddle} ${longBody}`, createdAt: new Date(base + 2000).toISOString() },
    { agentId: "assistant", content: `release-asst-2-${suffix} ${longBody}`, createdAt: new Date(base + 3000).toISOString() },
    { agentId: "user", content: `${msgNewest} ${longBody}`, createdAt: new Date(base + 4000).toISOString() },
    { agentId: "assistant", content: `release-asst-3-${suffix} ${longBody}`, createdAt: new Date(base + 5000).toISOString() },
  ];
  for (const entry of seedLogs) {
    const response = await request.post(`${apiBase}/api/log`, {
      data: { topicId, type: "conversation", classificationStatus: "classified", ...entry },
    });
    expect(response.ok()).toBeTruthy();
  }

  await page.goto("/u");

  const topicCard = page.locator(`[data-topic-card-id="${topicId}"]`).first();
  await expect(topicCard).toBeVisible({ timeout: 10_000 });
  await topicCard.evaluate((el) => {
    el.scrollIntoView({ block: "center", behavior: "auto" });
  });
  await topicCard.getByTitle("Expand").click();

  const scrollEl = page.getByTestId(`topic-chat-scroll-${topicId}`);
  const historyHint = page.getByTestId(`topic-chat-history-hint-${topicId}`);
  await expect(scrollEl).toBeVisible();
  await expect(historyHint).toBeVisible();
  await page.waitForTimeout(500);

  await scrollEl.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(scrollEl.getByText(msgMiddle, { exact: false })).toBeVisible({ timeout: 5_000 });
  await scrollEl.hover();
  await page.mouse.wheel(0, -240);
  await expect(scrollEl.getByText(msgOldest, { exact: false })).toBeVisible({ timeout: 5_000 });
  await expect(historyHint).toHaveCount(0);

  await scrollEl.evaluate((el) => {
    el.scrollTop = 0;
  });
  const pageScrollBeforeUp = await page.evaluate(() => window.scrollY);
  await scrollEl.hover();
  await page.mouse.wheel(0, -320);
  await page.waitForTimeout(150);
  const pageScrollAfterUp = await page.evaluate(() => window.scrollY);
  const chatScrollAfterUp = await scrollEl.evaluate((el) => el.scrollTop);
  expect(pageScrollAfterUp).toBeLessThan(pageScrollBeforeUp - 8);
  expect(chatScrollAfterUp).toBeLessThanOrEqual(1);

  await scrollEl.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const pageScrollBeforeDown = await page.evaluate(() => window.scrollY);
  await scrollEl.hover();
  await page.mouse.wheel(0, 320);
  await page.waitForTimeout(150);
  const pageScrollAfterDown = await page.evaluate(() => window.scrollY);
  const chatRemainingAfterDown = await scrollEl.evaluate(
    (el) => el.scrollHeight - (el.scrollTop + el.clientHeight)
  );
  expect(pageScrollAfterDown).toBeGreaterThan(pageScrollBeforeDown + 8);
  expect(chatRemainingAfterDown).toBeLessThanOrEqual(1);
});

test("sent topic chat message stays visible after the server confirms it", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-msg-persist-${suffix}`;
  const topicName = `Message Persist ${suffix}`;
  const sentMessage = `persist-msg-${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  // Seed 4 logs (2 user turns) so the chat window is truncated (start > 0).
  // This is the condition under which the "disappear" bug manifested.
  const base = Date.now() - 10_000;
  const seedLogs = [
    { agentId: "user",      content: `user-prior-1-${suffix}`, createdAt: new Date(base).toISOString() },
    { agentId: "assistant", content: `asst-prior-1-${suffix}`, createdAt: new Date(base + 1000).toISOString() },
    { agentId: "user",      content: `user-prior-2-${suffix}`, createdAt: new Date(base + 2000).toISOString() },
    { agentId: "assistant", content: `asst-prior-2-${suffix}`, createdAt: new Date(base + 3000).toISOString() },
  ];
  for (const entry of seedLogs) {
    const r = await request.post(`${apiBase}/api/log`, {
      data: { topicId, type: "conversation", classificationStatus: "classified", ...entry },
    });
    expect(r.ok()).toBeTruthy();
  }

  await page.goto(`/u/topic/${topicId}`);
  await page.getByRole("heading", { name: "Board View" }).waitFor();

  const scrollEl = page.getByTestId(`topic-chat-scroll-${topicId}`);
  const composer = page.getByTestId(`topic-chat-composer-${topicId}`);
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // Send a message via the topic chat composer.
  await composer.getByRole("textbox").fill(sentMessage);
  await composer.getByRole("button", { name: "Send" }).click();

  // Message must appear immediately as a pending entry.
  await expect(scrollEl.getByText(sentMessage, { exact: false })).toBeVisible({ timeout: 5_000 });

  // The mock API immediately confirms the message via SSE (log.appended event).
  // After confirmation the pending entry is replaced by the real log entry.
  // With chatHistoryStarts anchored at its initial value the window does not
  // drift past the new entry, so the message stays visible.
  await page.waitForTimeout(1500);
  await expect(scrollEl.getByText(sentMessage, { exact: false })).toBeVisible();
});
