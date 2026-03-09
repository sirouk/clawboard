import { expect, test, type APIRequestContext } from "@playwright/test";

async function clearActiveBoardRuns(request: APIRequestContext, apiBase: string) {
  const changes = await request.get(`${apiBase}/api/changes`);
  expect(changes.ok()).toBeTruthy();
  const payload = (await changes.json()) as {
    openclawTyping?: Array<{ sessionKey?: string; typing?: boolean }>;
    openclawThreadWork?: Array<{ sessionKey?: string; active?: boolean }>;
  };
  const sessionKeys = new Set<string>();
  for (const item of payload.openclawTyping || []) {
    const sessionKey = String(item?.sessionKey ?? "").trim();
    if (sessionKey.startsWith("clawboard:task:") && item?.typing) sessionKeys.add(sessionKey);
  }
  for (const item of payload.openclawThreadWork || []) {
    const sessionKey = String(item?.sessionKey ?? "").trim();
    if (sessionKey.startsWith("clawboard:task:") && item?.active) sessionKeys.add(sessionKey);
  }
  for (const sessionKey of sessionKeys) {
    const cancel = await request.delete(`${apiBase}/api/openclaw/chat`, {
      data: { sessionKey },
    });
    expect(cancel.ok()).toBeTruthy();
  }
}

test("unified composer auto-grows and routes continuation to explicit selected target", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-target-${suffix}`;
  const topicName = `Target Topic ${suffix}`;
  const taskId = `task-target-${suffix}`;
  const taskTitle = `Target Task ${suffix}`;
  const logNeedle = `needle-${suffix}`;
  const resolvedTopicId = `topic-resolved-${suffix}`;
  const resolvedTaskId = `task-resolved-${suffix}`;

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
  const resolvePayloads: Array<Record<string, unknown>> = [];
  await page.route("**/api/openclaw/resolve-board-send", async (route) => {
    resolvePayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        topicId: resolvedTopicId,
        topicName: `Resolved Topic ${suffix}`,
        topicCreated: true,
        taskId: resolvedTaskId,
        taskTitle: `Resolved Task ${suffix}`,
        taskCreated: true,
        sessionKey: `clawboard:task:${resolvedTopicId}:${resolvedTaskId}`,
        decisionSource: "test",
      }),
    });
  });
  await page.route("**/api/openclaw/chat", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    sentPayloads.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  await expect(textarea).toBeVisible();

  await textarea.fill("line 1");
  await textarea.press("Shift+Enter");
  await textarea.type("line 2");
  await expect(textarea).toHaveValue("line 1\nline 2");

  const beforeHeight = await textarea.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  await textarea.fill(["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n"));
  const afterHeight = await textarea.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(afterHeight).toBeGreaterThan(beforeHeight);
  await expect(textarea).toHaveCSS("overflow-y", "hidden");

  await textarea.press("Enter");
  await expect.poll(() => sentPayloads.length).toBe(1);
  expect(String(sentPayloads[0]?.sessionKey ?? "")).toBe(`clawboard:task:${resolvedTopicId}:${resolvedTaskId}`);
  expect(Object.prototype.hasOwnProperty.call(sentPayloads[0] ?? {}, "topicOnly")).toBe(false);
  await expect.poll(() => resolvePayloads.length).toBe(1);
  expect(resolvePayloads[0]).toMatchObject({ forceNewTopic: true, forceNewTask: true });

  await textarea.fill(taskTitle);
  await expect(page.getByTestId(`select-task-target-${taskId}`)).toBeVisible();
  await page.getByTestId(`select-task-target-${taskId}`).click();
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText(taskTitle);

  await textarea.fill("continue in explicit task target");
  await page.getByTestId("unified-composer-send").click();
  await expect.poll(() => sentPayloads.length).toBe(2);
  expect(sentPayloads[1]?.sessionKey).toBe(`clawboard:task:${topicId}:${taskId}`);
});

test("keyboard send in unified composer uses new topic when no target and selected session when target exists", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-keyboard-${suffix}`;
  const topicName = `Keyboard Topic ${suffix}`;
  const existingTaskId = `task-keyboard-existing-${suffix}`;
  const resolvedTopicTaskId = `task-keyboard-topic-${suffix}`;
  const sentPayloads: Array<Record<string, unknown>> = [];
  const resolvePayloads: Array<Record<string, unknown>> = [];

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: existingTaskId, topicId, title: `Keyboard Task ${suffix}`, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.route("**/api/openclaw/resolve-board-send", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    resolvePayloads.push(payload);
    const selectedTopicId = String(payload?.selectedTopicId ?? "");
    const forceNewTopic = Boolean(payload?.forceNewTopic);
    const forceNewTask = Boolean(payload?.forceNewTask);
    const sessionKey = selectedTopicId
      ? `clawboard:task:${selectedTopicId}:${resolvedTopicTaskId}`
      : `clawboard:task:topic-auto-${suffix}:task-auto-${suffix}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        topicId: selectedTopicId || `topic-auto-${suffix}`,
        topicName: selectedTopicId ? topicName : `Auto Topic ${suffix}`,
        topicCreated: forceNewTopic,
        taskId: selectedTopicId ? resolvedTopicTaskId : `task-auto-${suffix}`,
        taskTitle: selectedTopicId ? `New Task In ${topicName}` : `Auto Task ${suffix}`,
        taskCreated: forceNewTask,
        sessionKey,
        decisionSource: "test",
      }),
    });
  });

  await page.route("**/api/openclaw/chat", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    sentPayloads.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ queued: true, requestId: `occhat-keyboard-${sentPayloads.length}` }),
    });
  });

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  await expect(textarea).toBeVisible();

  await textarea.fill(`keyboard-new-topic-${suffix}`);
  await textarea.press("Enter");
  await expect.poll(() => sentPayloads.length).toBe(1);
  expect(String(sentPayloads[0]?.sessionKey ?? "")).toBe(`clawboard:task:topic-auto-${suffix}:task-auto-${suffix}`);
  await expect.poll(() => resolvePayloads.length).toBe(1);
  expect(resolvePayloads[0]).toMatchObject({ forceNewTopic: true, forceNewTask: true });

  await textarea.fill(topicName);
  await expect(page.getByTestId(`select-topic-target-${topicId}`)).toBeVisible();
  await page.getByTestId(`select-topic-target-${topicId}`).click();
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText(topicName);

  await textarea.fill(`keyboard-selected-target-${suffix}`);
  await textarea.press("Enter");
  await expect.poll(() => sentPayloads.length).toBe(2);
  expect(sentPayloads[1]?.sessionKey).toBe(`clawboard:task:${topicId}:${resolvedTopicTaskId}`);
  await expect.poll(() => resolvePayloads.length).toBe(2);
  expect(resolvePayloads[1]).toMatchObject({
    selectedTopicId: topicId,
    forceNewTopic: false,
    forceNewTask: true,
  });
});

test("typing search orders topics and tasks by relevance instead of saved board order", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();

  const weakerTopicId = `topic-order-weaker-${suffix}`;
  const weakerTopicName = `Weaker Topic ${suffix}`;
  const strongerTopicId = `topic-order-stronger-${suffix}`;
  const strongerTopicName = `Stronger Topic ${suffix}`;

  const strongerExactTaskId = `task-order-stronger-exact-${suffix}`;
  const strongerExactTaskTitle = `semantic search relevance order ${suffix}`;
  const strongerPartialTaskId = `task-order-stronger-partial-${suffix}`;
  const strongerPartialTaskTitle = `search order ${suffix}`;
  const weakerTaskId = `task-order-weaker-${suffix}`;
  const weakerTaskTitle = `search topic ${suffix}`;

  const createWeakerTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: weakerTopicId, name: weakerTopicName, pinned: false, sortIndex: 0 },
  });
  expect(createWeakerTopic.ok()).toBeTruthy();

  const createStrongerTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: strongerTopicId, name: strongerTopicName, pinned: false, sortIndex: 9 },
  });
  expect(createStrongerTopic.ok()).toBeTruthy();

  const createStrongerExactTask = await request.post(`${apiBase}/api/tasks`, {
    data: {
      id: strongerExactTaskId,
      topicId: strongerTopicId,
      title: strongerExactTaskTitle,
      status: "todo",
      pinned: false,
      sortIndex: 9,
    },
  });
  expect(createStrongerExactTask.ok()).toBeTruthy();

  const createStrongerPartialTask = await request.post(`${apiBase}/api/tasks`, {
    data: {
      id: strongerPartialTaskId,
      topicId: strongerTopicId,
      title: strongerPartialTaskTitle,
      status: "todo",
      pinned: false,
      sortIndex: 0,
    },
  });
  expect(createStrongerPartialTask.ok()).toBeTruthy();

  const createWeakerTask = await request.post(`${apiBase}/api/tasks`, {
    data: {
      id: weakerTaskId,
      topicId: weakerTopicId,
      title: weakerTaskTitle,
      status: "todo",
      pinned: false,
      sortIndex: 0,
    },
  });
  expect(createWeakerTask.ok()).toBeTruthy();

  const createExactLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId: strongerTopicId,
      taskId: strongerExactTaskId,
      type: "conversation",
      content: `semantic search relevance order exact ${suffix}`,
      summary: "Exact ranking hit",
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey: `clawboard:task:${strongerTopicId}:${strongerExactTaskId}` },
    },
  });
  expect(createExactLog.ok()).toBeTruthy();

  const createWeakerLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId: weakerTopicId,
      taskId: weakerTaskId,
      type: "conversation",
      content: `search topic weak match ${suffix}`,
      summary: "Weak ranking hit",
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey: `clawboard:task:${weakerTopicId}:${weakerTaskId}` },
    },
  });
  expect(createWeakerLog.ok()).toBeTruthy();

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  await expect(textarea).toBeVisible();
  const baselineTopicOrder = await page.locator("[data-topic-card-id]").evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => el.getAttribute("data-topic-card-id") ?? "")
  );
  await page.getByText(strongerTopicName).click();
  await expect(page.getByTestId(`reorder-task-${strongerExactTaskId}`)).toBeVisible();
  const baselineTaskOrder = await page.locator(`[data-topic-card-id='${strongerTopicId}'] [data-task-card-id]`).evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => el.getAttribute("data-task-card-id") ?? "")
  );
  await textarea.fill(strongerExactTaskTitle);

  await expect(page.getByTestId(`select-task-target-${strongerExactTaskId}`)).toBeVisible();
  await expect(page.getByTestId(`select-task-target-${weakerTaskId}`)).toBeVisible();

  const topicOrder = await page.locator("[data-topic-card-id]").evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => el.getAttribute("data-topic-card-id") ?? "")
  );
  expect(topicOrder.indexOf(strongerTopicId)).toBeGreaterThanOrEqual(0);
  expect(topicOrder.indexOf(weakerTopicId)).toBeGreaterThanOrEqual(0);
  expect(topicOrder.indexOf(strongerTopicId)).toBeLessThan(topicOrder.indexOf(weakerTopicId));

  const taskOrder = await page.locator(`[data-topic-card-id='${strongerTopicId}'] [data-task-card-id]`).evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => el.getAttribute("data-task-card-id") ?? "")
  );
  expect(taskOrder.indexOf(strongerExactTaskId)).toBeGreaterThanOrEqual(0);
  expect(taskOrder.indexOf(strongerPartialTaskId)).toBeGreaterThanOrEqual(0);
  expect(taskOrder.indexOf(strongerExactTaskId)).toBeLessThan(taskOrder.indexOf(strongerPartialTaskId));

  await textarea.fill("");
  const restoredTopicOrder = await page.locator("[data-topic-card-id]").evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => el.getAttribute("data-topic-card-id") ?? "")
  );
  expect(restoredTopicOrder.indexOf(weakerTopicId)).toBeGreaterThanOrEqual(0);
  expect(restoredTopicOrder.indexOf(strongerTopicId)).toBeGreaterThanOrEqual(0);
  expect(restoredTopicOrder.indexOf(weakerTopicId) < restoredTopicOrder.indexOf(strongerTopicId)).toBe(
    baselineTopicOrder.indexOf(weakerTopicId) < baselineTopicOrder.indexOf(strongerTopicId)
  );

  await expect(page.getByTestId(`reorder-task-${strongerExactTaskId}`)).toBeVisible();

  const restoredTaskOrder = await page.locator(`[data-topic-card-id='${strongerTopicId}'] [data-task-card-id]`).evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => el.getAttribute("data-task-card-id") ?? "")
  );
  expect(restoredTaskOrder.indexOf(strongerPartialTaskId)).toBeGreaterThanOrEqual(0);
  expect(restoredTaskOrder.indexOf(strongerExactTaskId)).toBeGreaterThanOrEqual(0);
  expect(restoredTaskOrder.indexOf(strongerPartialTaskId) < restoredTaskOrder.indexOf(strongerExactTaskId)).toBe(
    baselineTaskOrder.indexOf(strongerPartialTaskId) < baselineTaskOrder.indexOf(strongerExactTaskId)
  );
});

test("typed /stop in unified composer cancels selected target run without posting a new chat send", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-unified-stop-${suffix}`;
  const topicName = `Unified Stop Topic ${suffix}`;
  const taskId = `task-unified-stop-${suffix}`;
  const taskTitle = `Unified Stop Task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  let postCount = 0;
  const deletePayloads: Array<Record<string, unknown>> = [];

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "doing", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  page.on("request", (req) => {
    if (req.url().includes("/api/openclaw/chat") && req.method() === "POST") {
      postCount += 1;
    }
  });

  await page.route("**/api/openclaw/chat", async (route) => {
    const method = route.request().method();
    if (method === "DELETE") {
      const raw = route.request().postData();
      let payload: Record<string, unknown> = {};
      try {
        payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }
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
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  const targetChip = page.getByTestId("unified-composer-target-chip");
  const chipText = (await targetChip.textContent().catch(() => "")) ?? "";
  if (!chipText.includes(taskTitle)) {
    await textarea.fill(taskTitle);
    await expect(page.getByTestId(`select-task-target-${taskId}`)).toBeVisible();
    await page.getByTestId(`select-task-target-${taskId}`).click();
  }
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText(taskTitle);

  await textarea.fill(`start-unified-run-${suffix}`);
  const firstSend = page.waitForResponse((resp) => {
    return resp.url().includes("/api/openclaw/chat") && resp.request().method() === "POST";
  });
  await textarea.press("Enter");
  await firstSend;
  await expect.poll(() => postCount).toBe(1);

  await textarea.fill("/stop");
  await textarea.press("Enter");
  await expect.poll(() => deletePayloads.length).toBe(1);

  expect(postCount).toBe(1);
  const deletedSessionKeys = deletePayloads.map((payload) => String(payload?.sessionKey ?? "")).filter(Boolean);
  if (deletedSessionKeys.length > 0) {
    expect(deletedSessionKeys[0]).toBe(sessionKey);
  }
  await expect(page.getByText("Cancelled selected target run.")).toBeVisible();
});

test("typed /stop in unified composer without selected target does not post a new chat message", async ({ page }) => {
  let postCount = 0;
  const deletePayloads: Array<Record<string, unknown>> = [];

  await page.route("**/api/log?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    });
  });
  await page.route("**/api/changes?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        spaces: [],
        topics: [],
        tasks: [],
        logs: [],
        drafts: [],
        deletedLogIds: [],
      }),
    });
  });
  await page.route("**/api/openclaw/chat", async (route) => {
    if (route.request().method() === "POST") {
      postCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ queued: true, requestId: "occhat-stop-no-target" }),
      });
      return;
    }
    if (route.request().method() === "DELETE") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      deletePayloads.push(payload);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ aborted: true, queueCancelled: 1, sessionKey: String(payload.sessionKey ?? ""), sessionKeys: [] }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();
  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();

  await textarea.fill("/stop");
  await textarea.press("Enter");

  expect(postCount).toBe(0);
  await expect(page.getByText("Select a topic/task target to stop.")).toBeVisible();
  expect(deletePayloads).toHaveLength(0);
});

test("unified stop button stays hidden for an unrelated in-flight board run without a selected target", async ({
  page,
  request,
}) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  await clearActiveBoardRuns(request, apiBase);
  const suffix = Date.now();
  const topicId = `topic-unified-stop-single-${suffix}`;
  const topicName = `Unified Stop Single ${suffix}`;
  const taskId = `task-unified-stop-single-${suffix}`;
  const taskTitle = `Unified Stop Single Task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const deletePayloads: Array<Record<string, unknown>> = [];

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "doing", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const queueRun = await request.post(`${apiBase}/api/openclaw/chat`, {
    data: {
      sessionKey,
      message: `pending-user-${suffix}`,
    },
  });
  expect(queueRun.ok()).toBeTruthy();

  await page.route("**/api/openclaw/chat", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    deletePayloads.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ aborted: true, queueCancelled: 1, sessionKey, sessionKeys: [sessionKey] }),
    });
  });

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  await expect(page.locator('[data-testid="unified-composer-stop"]:visible')).toHaveCount(0);
  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  await textarea.fill("/stop");
  await textarea.press("Enter");

  expect(deletePayloads).toHaveLength(0);
  await expect(page.getByText("Select a topic/task target to stop.")).toBeVisible();
});

test("unified stop button scopes to the revealed task route without an explicit selected target", async ({
  page,
  request,
}) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  await clearActiveBoardRuns(request, apiBase);
  const suffix = Date.now();
  const topicId = `topic-unified-stop-revealed-${suffix}`;
  const topicName = `Unified Stop Revealed ${suffix}`;
  const taskId = `task-unified-stop-revealed-${suffix}`;
  const taskTitle = `Unified Stop Revealed Task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const deletePayloads: Array<Record<string, unknown>> = [];

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "doing", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const queueRun = await request.post(`${apiBase}/api/openclaw/chat`, {
    data: {
      sessionKey,
      message: `pending-user-${suffix}`,
    },
  });
  expect(queueRun.ok()).toBeTruthy();

  await page.route("**/api/openclaw/chat", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    deletePayloads.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ aborted: true, queueCancelled: 1, sessionKey, sessionKeys: [sessionKey] }),
    });
  });

  await page.goto(`/u/topic/${topicId}/task/${taskId}?reveal=1`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const stop = page.locator('[data-testid="unified-composer-stop"]:visible').first();
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => deletePayloads.length).toBe(1);

  expect(String(deletePayloads[0]?.sessionKey ?? "")).toBe(sessionKey);
  await expect(page.getByText("Cancelled revealed task run.")).toBeVisible();
});

test("unified stop button follows orchestration-active selected task and sends scoped requestId", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-stop-orch-${suffix}`;
  const topicName = `Stop Orch Topic ${suffix}`;
  const taskId = `task-stop-orch-${suffix}`;
  const taskTitle = `Stop Orch Task ${suffix}`;
  const requestId = `occhat-stop-orch-${suffix}`;
  const runId = `ocorun-stop-orch-${suffix}`;
  const taskSession = `clawboard:task:${topicId}:${taskId}`;
  const deletePayloads: Array<Record<string, unknown>> = [];

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "doing", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const createOrchestrationLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "system",
      content: "Delegation started for selected task.",
      summary: "Delegation started",
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "Clawboard",
      source: {
        channel: "clawboard",
        sessionKey: taskSession,
        requestId,
        orchestration: true,
        runId,
        eventType: "run_created",
        runStatus: "running",
        boardScopeTopicId: topicId,
        boardScopeTaskId: taskId,
      },
    },
  });
  expect(createOrchestrationLog.ok()).toBeTruthy();

  await page.route("**/api/openclaw/chat", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    deletePayloads.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ aborted: true, queueCancelled: 1, sessionKey: taskSession, sessionKeys: [taskSession] }),
    });
  });

  await page.goto(`/u/topic/${topicId}/task/${taskId}?reveal=1`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();
  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  await textarea.fill(taskTitle);
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

  await expect(page.getByTestId("unified-composer-stop")).toBeVisible();
  await page.getByTestId("unified-composer-stop").click();
  await expect.poll(() => deletePayloads.length).toBe(1);

  expect(String(deletePayloads[0]?.sessionKey ?? "")).toBe(taskSession);
  expect(String(deletePayloads[0]?.requestId ?? "")).toBe(requestId);
  await expect(page.getByText("Cancelled selected target run.")).toBeVisible();
});

test("unified composer shows image preview and allows removing a specific attachment", async ({ page }) => {
  const imageName = `preview-${Date.now()}.png`;

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  const composerBox = textarea.locator("xpath=ancestor::div[contains(@class,'relative')][1]");
  await composerBox
    .locator("input[type='file']")
    .setInputFiles({ name: imageName, mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });

  const imagePreview = page.locator(`img[alt="${imageName}"]`);
  await expect(imagePreview).toBeVisible();

  const removeButton = page.getByRole("button", { name: `Remove ${imageName}` });
  await expect(removeButton).toBeVisible();
  await removeButton.click();
  await expect(imagePreview).toHaveCount(0);
});

test("unified attachment upload uses multipart and preserves draft/attachment on failure", async ({ page }) => {
  const suffix = Date.now();
  const fileName = `upload-fail-${suffix}.txt`;
  const message = `attachment failure path ${suffix}`;
  let attachmentsCalls = 0;
  let sawMultipart = false;
  const postPayloads: Array<Record<string, unknown>> = [];

  await page.route("**/api/attachments", async (route) => {
    attachmentsCalls += 1;
    const contentType = route.request().headers()["content-type"] ?? "";
    if (contentType.toLowerCase().includes("multipart/form-data")) {
      sawMultipart = true;
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Upload failed in test." }),
    });
  });

  await page.route("**/api/openclaw/resolve-board-send", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        topicId: `topic-upload-${suffix}`,
        topicName: `Upload Topic ${suffix}`,
        topicCreated: true,
        taskId: `task-upload-${suffix}`,
        taskTitle: `Upload Task ${suffix}`,
        taskCreated: true,
        sessionKey: `clawboard:task:topic-upload-${suffix}:task-upload-${suffix}`,
        decisionSource: "test",
      }),
    });
  });

  await page.route("**/api/openclaw/chat", async (route) => {
    if (route.request().method() === "POST") {
      postPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ queued: true, requestId: `occhat-upload-${suffix}` }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  await textarea.fill(message);

  const composerBox = textarea.locator("xpath=ancestor::div[contains(@class,'relative')][1]");
  await composerBox
    .locator("input[type='file']")
    .setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("hello attachment") });
  await expect(page.getByText(fileName)).toBeVisible();

  await textarea.press("Enter");
  await expect.poll(() => attachmentsCalls).toBe(1);
  expect(sawMultipart).toBeTruthy();
  expect(postPayloads).toHaveLength(0);

  await expect(page.getByText("Upload failed in test.")).toBeVisible();
  await expect(textarea).toHaveValue(message);
  await expect(page.getByText(fileName)).toBeVisible();
});
