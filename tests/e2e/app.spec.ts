import { test, expect } from "@playwright/test";

test("home loads unified view", async ({ page }) => {
  await page.goto("/u");
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
  const optionsToggle = page.getByRole("button", { name: /Board controls/i }).first();
  await expect(optionsToggle).toBeVisible();
  await optionsToggle.click();
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
  await expect(page.getByText("Scaffolded onboarding wizard layout", { exact: false })).toBeVisible();
});
