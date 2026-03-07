import { test, expect } from "@playwright/test";

test("home loads unified view", async ({ page }) => {
  await page.goto("/u");
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
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
  const boardSearch = page.locator("[data-testid='unified-board-search']:visible").first();
  await expect(composer).toBeVisible();
  await expect(boardSearch).toBeVisible();
  await expect(page.getByRole("button", { name: /^\+ New topic$/i })).toHaveCount(0);

  await composer.fill("Message stays in composer");
  await expect(page.getByTestId("unified-composer-send")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach files" }).first()).toBeVisible();
  await expect(composer).toHaveValue("Message stays in composer");

  await boardSearch.fill("Clawboard");
  await expect(boardSearch).toHaveValue("Clawboard");
  await expect(page.locator("[data-topic-card-id='topic-1']").first()).toBeVisible();
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
