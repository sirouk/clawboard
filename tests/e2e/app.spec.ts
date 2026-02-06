import { test, expect } from "@playwright/test";

test("home loads unified view", async ({ page }) => {
  await page.goto("/u");
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show full messages" })).toBeVisible();
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

test("unified view expands topics and tasks", async ({ page }) => {
  await page.goto("/u");
  await expect(page.getByRole("heading", { name: "Unified View" })).toBeVisible();
  await page.getByRole("button", { name: /Clawboard/ }).first().click();
  await expect(page.getByText("Ship onboarding wizard")).toBeVisible();
  await page.getByRole("button", { name: /Ship onboarding wizard/ }).first().click();
  await expect(page.getByText("Scaffolded onboarding wizard layout", { exact: false })).toBeVisible();
});
