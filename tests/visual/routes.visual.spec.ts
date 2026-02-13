import { expect, test } from "@playwright/test";
import { applyVisualStabilizers, gotoPath } from "./helpers";

test.beforeEach(async ({ page }) => {
  await applyVisualStabilizers(page);
});

test("route /u visual baseline", async ({ page }) => {
  await gotoPath(page, "/u");
  await page.getByPlaceholder("Search topics, tasks, or messages").waitFor();
  await expect(page).toHaveScreenshot("route-u.png");
});

test("route /dashboard visual baseline", async ({ page }) => {
  await gotoPath(page, "/dashboard");
  await page.getByRole("heading", { name: "Active Tasks" }).waitFor();
  await expect(page).toHaveScreenshot("route-dashboard.png");
});

test("route /log visual baseline", async ({ page }) => {
  await gotoPath(page, "/log");
  await page.getByRole("heading", { name: "All Activity" }).waitFor();
  await page.getByPlaceholder("Search messages").waitFor();
  await expect(page).toHaveScreenshot("route-log.png");
});

test("route /graph visual baseline", async ({ page }) => {
  await gotoPath(page, "/graph");
  await page.getByTestId("clawgraph-canvas").waitFor();
  await page.locator("[data-node-id]").first().waitFor();
  await page.getByText("Stable").first().waitFor();
  await expect(page).toHaveScreenshot("route-graph.png", { maxDiffPixelRatio: 0.05 });
});

test("route /stats visual baseline", async ({ page }) => {
  await gotoPath(page, "/stats");
  await page.getByRole("heading", { name: "Creation Intelligence" }).waitFor();
  await expect(page).toHaveScreenshot("route-stats.png");
});

test("route /setup visual baseline", async ({ page }) => {
  await gotoPath(page, "/setup");
  await page.getByText("Instance Configuration").waitFor();
  await expect(page).toHaveScreenshot("route-setup.png");
});

test("route /providers visual baseline", async ({ page }) => {
  await gotoPath(page, "/providers");
  await page.getByRole("heading", { name: "Chutes (Recommended)" }).waitFor();
  await expect(page).toHaveScreenshot("route-providers.png");
});
