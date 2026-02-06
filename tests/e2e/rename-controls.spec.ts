import { expect, test } from "@playwright/test";

test("rename pencils are visible but disabled in read-only mode", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("clawboard.token");
  });

  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        instance: {
          title: "Clawboard",
          integrationLevel: "manual",
          updatedAt: "2026-02-06T00:00:00.000Z",
        },
        tokenRequired: true,
      }),
    });
  });

  await page.goto("/u");
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
  await page.getByRole("button", { name: /Clawboard/ }).first().click();

  await expect(page.locator("[data-testid^='rename-topic-']").first()).toBeDisabled();
  await expect(page.locator("[data-testid^='rename-task-']").first()).toBeDisabled();
});

test("rename pencils save topic/task names and queue reindex requests", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("clawboard.token", "test-token");
  });

  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        instance: {
          title: "Clawboard",
          integrationLevel: "manual",
          updatedAt: "2026-02-06T00:00:00.000Z",
        },
        tokenRequired: true,
      }),
    });
  });

  await page.route("**/api/topics", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const payload = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: String(payload.id ?? "topic-1"),
        name: String(payload.name ?? "Topic"),
        description: "Product and platform work.",
        priority: "high",
        status: "active",
        tags: ["product", "platform"],
        parentId: null,
        color: typeof payload.color === "string" ? payload.color : "#FF8A4A",
        pinned: false,
        createdAt: "2026-02-01T14:00:00.000Z",
        updatedAt: new Date().toISOString(),
      }),
    });
  });

  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const payload = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: String(payload.id ?? "task-1"),
        topicId: payload.topicId ?? "topic-1",
        title: String(payload.title ?? "Task"),
        color: typeof payload.color === "string" ? payload.color : "#4EA1FF",
        status: "todo",
        pinned: false,
        priority: "medium",
        dueDate: null,
        createdAt: "2026-02-02T10:00:00.000Z",
        updatedAt: new Date().toISOString(),
      }),
    });
  });

  await page.goto("/u");
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
  await page.getByRole("button", { name: /Clawboard/ }).first().click();

  const newTopicName = "Clawboard Renamed";
  const newTopicColor = "#2AA9A2";
  const topicRenameButton = page.locator("[data-testid^='rename-topic-']").first();
  const topicRenameId = await topicRenameButton.getAttribute("data-testid");
  const topicRequest = page.waitForRequest((request) => {
    if (!request.url().includes("/api/topics") || request.method() !== "POST") return false;
    try {
      const body = request.postDataJSON() as Record<string, unknown>;
      return body.name === newTopicName && body.color === newTopicColor;
    } catch {
      return false;
    }
  });
  const topicReindex = page.waitForRequest((request) => {
    if (!request.url().includes("/api/reindex") || request.method() !== "POST") return false;
    try {
      const body = request.postDataJSON() as Record<string, unknown>;
      return body.kind === "topic" && body.text === newTopicName;
    } catch {
      return false;
    }
  });

  await topicRenameButton.click();
  await page.locator("[data-testid^='rename-topic-input-']").first().fill(newTopicName);
  await page.locator("[data-testid^='rename-topic-color-']").first().fill(newTopicColor);
  await page.locator("[data-testid^='save-topic-rename-']").first().click();
  await topicRequest;
  await topicReindex;
  await expect(page.locator(`[data-testid='${topicRenameId}']`)).toHaveAttribute("aria-label", new RegExp(newTopicName));

  const newTaskName = "Ship onboarding wizard renamed";
  const newTaskColor = "#7A5CFF";
  const taskRenameButton = page.locator("[data-testid^='rename-task-']").first();
  const taskRenameId = await taskRenameButton.getAttribute("data-testid");
  const taskRequest = page.waitForRequest((request) => {
    if (!request.url().includes("/api/tasks") || request.method() !== "POST") return false;
    try {
      const body = request.postDataJSON() as Record<string, unknown>;
      return body.title === newTaskName && body.color === newTaskColor;
    } catch {
      return false;
    }
  });
  const taskReindex = page.waitForRequest((request) => {
    if (!request.url().includes("/api/reindex") || request.method() !== "POST") return false;
    try {
      const body = request.postDataJSON() as Record<string, unknown>;
      return body.kind === "task" && body.text === newTaskName;
    } catch {
      return false;
    }
  });

  await taskRenameButton.click();
  await page.locator("[data-testid^='rename-task-input-']").first().fill(newTaskName);
  await page.locator("[data-testid^='rename-task-color-']").first().fill(newTaskColor);
  await page.locator("[data-testid^='save-task-rename-']").first().click();
  await taskRequest;
  await taskReindex;
  await expect(page.locator(`[data-testid='${taskRenameId}']`)).toHaveAttribute("aria-label", new RegExp(newTaskName));
});
