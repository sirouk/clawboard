import { test, expect, type Page } from "@playwright/test";

async function ensureBoardOptionsVisible(page: Page) {
  const fullMessagesToggle = page.getByRole("button", { name: /Show full messages|Hide full messages/i });
  if (await fullMessagesToggle.count()) return;
  const optionsToggle = page.getByRole("button", { name: /View options|Hide options/i }).first();
  await expect(optionsToggle).toBeVisible();
  await optionsToggle.click();
}

test("home loads unified view", async ({ page }) => {
  await page.goto("/u");
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
  await ensureBoardOptionsVisible(page);
  await expect(page.getByRole("button", { name: /Show full messages|Hide full messages/i })).toBeVisible();
});

test("dashboard route loads legacy dashboard widgets", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent Activity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Topics" })).toBeVisible();
});

test("legacy routes redirect to unified view", async ({ page }) => {
  await page.goto("/topics");
  await expect(page).toHaveURL(/\/u$/);
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();

  await page.goto("/tasks");
  await expect(page).toHaveURL(/\/u$/);
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
});

test("logs route loads raw log hopper", async ({ page }) => {
  await page.goto("/log");
  await expect(page.getByRole("heading", { name: "All Activity" })).toBeVisible();
  await expect(page.getByText("pending logs before classification")).toBeVisible();
});

test("graph route loads clawgraph view", async ({ page }) => {
  await page.goto("/graph");
  await expect(page.getByRole("heading", { name: "Clawgraph" })).toBeVisible();
  await expect(page.getByTestId("clawgraph-canvas")).toBeVisible();
});

test("unified view expands topics and tasks", async ({ page }) => {
  await page.goto("/u");
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
  await page.getByRole("button", { name: "Expand topic Clawboard", exact: true }).click();
  await expect(page.getByText("Ship onboarding wizard")).toBeVisible();
  await page.getByRole("button", { name: "Expand task Ship onboarding wizard", exact: true }).click();

  await ensureBoardOptionsVisible(page);
  const toolCallsToggle = page.getByRole("button", { name: /Show tool calls|Hide tool calls/i }).first();
  await expect(toolCallsToggle).toBeVisible();
  if ((await toolCallsToggle.textContent())?.toLowerCase().includes("show")) {
    await toolCallsToggle.click();
  }

  await expect(page.getByText("Scaffolded onboarding wizard layout", { exact: false })).toBeVisible();
});

test("unified board uses freeform composer and hides top-level new topic button", async ({ page }) => {
  await page.goto("/u");
  const composer = page.locator("[data-testid='unified-composer-textarea']:visible").first();
  await expect(composer).toBeVisible();
  await expect(page.locator("[data-testid='unified-board-search']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^\+ New topic$/i })).toHaveCount(0);

  await composer.fill("Message stays in composer");
  await expect(page.getByTestId("unified-composer-send")).toContainText("Start new topic");
  await expect(page.getByRole("button", { name: "Attach files" }).first()).toBeVisible();
  await expect(composer).toHaveValue("Message stays in composer");

  await composer.fill("Clawboard");
  await expect(composer).toHaveValue("Clawboard");
  const topicCard = page.locator("[data-topic-card-id='topic-1']").first();
  await expect(topicCard).toBeVisible();
  await expect(page.locator("[data-topic-card-id='topic-1'] > div[role='button']").first()).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText("New topic -> new task");
  await expect(page.getByTestId("unified-composer-send")).toContainText("Start new topic");
});

test("instance title updates live after config changes", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const nextTitle = `Clawboard Live ${Date.now()}`;

  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();
  await expect(page.getByText("Clawboard").first()).toBeVisible();

  const response = await request.post(`${apiBase}/api/config`, {
    data: { title: nextTitle },
  });
  expect(response.ok()).toBeTruthy();

  await expect(page.getByText(nextTitle).first()).toBeVisible();
});

test("browser API calls use the configured mock API base by default in Playwright, including unified board send", async ({
  page,
  request,
}) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const directApiOrigin = new URL(apiBase).origin;
  const webOrigin = "http://127.0.0.1:3050";
  const suffix = Date.now();
  const topicId = `topic-proxy-send-${suffix}`;
  const topicName = `Proxy Send ${suffix}`;
  const taskId = `task-proxy-send-${suffix}`;
  const taskTitle = `Proxy Task ${suffix}`;
  const sessionKey = `clawboard:task:${topicId}:${taskId}`;
  const message = `Proxy send ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "doing", pinned: false },
  });
  expect(createTask.ok()).toBeTruthy();

  let sendPayload: Record<string, unknown> | null = null;
  let sendRequestUrl = "";
  let sameOriginSendHits = 0;
  page.on("request", (req) => {
    if (req.url().startsWith(`${webOrigin}/api/openclaw/chat`)) {
      sameOriginSendHits += 1;
    }
  });
  await page.route(`${directApiOrigin}/api/openclaw/chat`, async (route) => {
    sendRequestUrl = route.request().url();
    sendPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ queued: true, requestId: `req-proxy-send-${suffix}` }),
    });
  });

  await page.goto(`http://127.0.0.1:3050/u/topic/${topicId}/task/${taskId}?reveal=1`);
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const composer = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
  await expect(composer).toBeVisible();

  const topicHeader = page.locator(`[data-topic-card-id="${topicId}"] > div[role="button"]`).first();
  await expect(topicHeader).toBeVisible();
  if ((await topicHeader.getAttribute("aria-expanded")) !== "true") {
    await topicHeader.click();
  }

  const taskHeader = page.locator(`[data-task-card-id="${taskId}"] > div[role="button"]`).first();
  await expect(taskHeader).toBeVisible();
  await composer.fill(taskTitle);
  const selectTarget = page.getByTestId(`select-task-target-${taskId}`);
  await expect(selectTarget).toBeVisible();
  await selectTarget.click();
  await expect(page.getByTestId("unified-composer-target-chip")).toContainText(taskTitle);
  await expect(page.getByTestId("unified-composer-send")).toContainText("Continue task");

  await composer.fill(message);
  await page.getByTestId("unified-composer-send").click();

  await expect
    .poll(() => sendPayload)
    .toMatchObject({
      sessionKey,
      message,
    });
  expect(sendRequestUrl.startsWith(`${directApiOrigin}/api/openclaw/chat`)).toBeTruthy();
  expect(sameOriginSendHits).toBe(0);
  await expect(page.getByText("Failed to fetch")).toHaveCount(0);
});

test("explicit local loopback api base still uses same-origin proxy for browser calls", async ({ page }) => {
  const webOrigin = "http://127.0.0.1:3050";
  let sameOriginConfigHits = 0;
  let directLoopbackHits = 0;

  await page.addInitScript(() => {
    window.localStorage.setItem("clawboard.apiBase", "http://127.0.0.1:8010");
    window.localStorage.setItem("clawboard.token", "local-proxy-token");
  });

  page.on("request", (req) => {
    if (req.url().startsWith(`${webOrigin}/api/config`)) sameOriginConfigHits += 1;
    if (req.url().startsWith("http://127.0.0.1:8010/api/config")) directLoopbackHits += 1;
  });

  await page.route("http://127.0.0.1:8010/api/config", async (route) => {
    directLoopbackHits += 1000;
    await route.abort();
  });

  await page.goto(`${webOrigin}/u`);
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();

  await expect
    .poll(() => sameOriginConfigHits)
    .toBeGreaterThan(0);
  expect(directLoopbackHits).toBe(0);
  await expect(page.getByText("Failed to fetch")).toHaveCount(0);
});
