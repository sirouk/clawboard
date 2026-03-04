import { expect, test } from "@playwright/test";

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
  await page.route("**/api/openclaw/resolve-board-send", async (route) => {
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

  await page.goto(`/u/topic/${topicId}/task/${taskId}?q=${encodeURIComponent(logNeedle)}`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const textarea = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  await expect(textarea).toBeVisible();

  const beforeHeight = await textarea.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  await textarea.fill(["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n"));
  const afterHeight = await textarea.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(afterHeight).toBeGreaterThan(beforeHeight);
  await expect(textarea).toHaveCSS("overflow-y", "hidden");

  await textarea.press("Control+Enter");
  await expect.poll(() => sentPayloads.length).toBe(1);
  expect(String(sentPayloads[0]?.sessionKey ?? "")).toBe(`clawboard:task:${resolvedTopicId}:${resolvedTaskId}`);
  expect(Object.prototype.hasOwnProperty.call(sentPayloads[0] ?? {}, "topicOnly")).toBe(false);

  await textarea.fill("continue in explicit task target");
  await page.getByTestId(`select-task-target-${taskId}`).click();
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText(`task: ${taskTitle}`);

  await page.getByTestId("unified-composer-send").click();
  await expect.poll(() => sentPayloads.length).toBe(2);
  expect(sentPayloads[1]?.sessionKey).toBe(`clawboard:task:${topicId}:${taskId}`);
});

test("keyboard send in unified composer uses new topic when no target and selected session when target exists", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-keyboard-${suffix}`;
  const topicName = `Keyboard Topic ${suffix}`;
  const topicTaskId = `task-keyboard-${suffix}`;
  const sentPayloads: Array<Record<string, unknown>> = [];

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: topicTaskId, topicId, title: `Keyboard Task ${suffix}`, status: "todo", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  await page.route("**/api/openclaw/resolve-board-send", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    const selectedTopicId = String(payload?.selectedTopicId ?? "");
    const sessionKey = selectedTopicId
      ? `clawboard:task:${selectedTopicId}:${topicTaskId}`
      : `clawboard:task:topic-auto-${suffix}:task-auto-${suffix}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        topicId: selectedTopicId || `topic-auto-${suffix}`,
        topicName: selectedTopicId ? topicName : `Auto Topic ${suffix}`,
        topicCreated: !selectedTopicId,
        taskId: selectedTopicId ? topicTaskId : `task-auto-${suffix}`,
        taskTitle: selectedTopicId ? `Keyboard Task ${suffix}` : `Auto Task ${suffix}`,
        taskCreated: !selectedTopicId,
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
  await textarea.press("Control+Enter");
  await expect.poll(() => sentPayloads.length).toBe(1);
  expect(String(sentPayloads[0]?.sessionKey ?? "")).toBe(`clawboard:task:topic-auto-${suffix}:task-auto-${suffix}`);

  await textarea.fill(`target ${topicName}`);
  await expect(page.getByTestId(`select-topic-target-${topicId}`)).toBeVisible();
  await page.getByTestId(`select-topic-target-${topicId}`).click();
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText(topicName);

  await textarea.fill(`keyboard-selected-target-${suffix}`);
  await textarea.press("Control+Enter");
  await expect.poll(() => sentPayloads.length).toBe(2);
  expect(sentPayloads[1]?.sessionKey).toBe(`clawboard:task:${topicId}:${topicTaskId}`);
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
  const chipVisible = await targetChip.isVisible().catch(() => false);
  if (!chipVisible) {
    await textarea.fill(`target ${taskTitle}`);
    await expect(page.getByTestId(`select-task-target-${taskId}`)).toBeVisible();
    await page.getByTestId(`select-task-target-${taskId}`).click();
  }
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText(taskTitle);

  await textarea.fill(`start-unified-run-${suffix}`);
  const firstSend = page.waitForResponse((resp) => {
    return resp.url().includes("/api/openclaw/chat") && resp.request().method() === "POST";
  });
  await textarea.press("Control+Enter");
  await firstSend;
  await expect.poll(() => postCount).toBe(1);

  await textarea.fill("/stop");
  await textarea.press("Control+Enter");
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
  await textarea.press("Control+Enter");

  expect(postCount).toBe(0);
  const statusNotice = page
    .getByText("Select a topic/task target to stop.")
    .or(page.getByText("Cancelled the only active board run."))
    .or(page.getByText("Cancelled active chat run."));
  await expect(statusNotice.first()).toBeVisible();
  expect(deletePayloads.length).toBeLessThanOrEqual(1);
});

test("unified stop button is visible for a single in-flight board run without a selected target", async ({
  page,
  request,
}) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-unified-stop-single-${suffix}`;
  const topicName = `Unified Stop Single ${suffix}`;
  const taskId = `task-unified-stop-single-${suffix}`;
  const taskTitle = `Unified Stop Single Task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const requestId = `req-unified-stop-single-${suffix}`;
  const deletePayloads: Array<Record<string, unknown>> = [];

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "doing", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  const seedPendingUser = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: `pending-user-${suffix}`,
      summary: "Pending user prompt",
      classificationStatus: "classified",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey, requestId },
    },
  });
  expect(seedPendingUser.ok()).toBeTruthy();

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

  const stop = page.locator('[data-testid="unified-composer-stop"]:visible').first();
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => deletePayloads.length).toBe(1);

  expect(String(deletePayloads[0]?.sessionKey ?? "")).toBe(sessionKey);
  const cancelNotice = page
    .getByText("Cancelled the only active board run.")
    .or(page.getByText("Cancelled active chat run."));
  await expect(cancelNotice.first()).toBeVisible();
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
  await textarea.fill(taskTitle.slice(0, 1) || "t");
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
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText(`task: ${taskTitle}`);

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

  await textarea.press("Control+Enter");
  await expect.poll(() => attachmentsCalls).toBe(1);
  expect(sawMultipart).toBeTruthy();
  expect(postPayloads).toHaveLength(0);

  await expect(page.getByText("Upload failed in test.")).toBeVisible();
  await expect(textarea).toHaveValue(message);
  await expect(page.getByText(fileName)).toBeVisible();
});
