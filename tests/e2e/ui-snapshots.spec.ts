import { test } from "@playwright/test";

test("ui snapshots pass", async ({ page }, testInfo) => {
  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();
  await page.screenshot({ path: testInfo.outputPath("home-unified.png"), fullPage: true });

  await page.goto("/dashboard");
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
  await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true });

  await page.goto("/setup");
  await page.getByRole("heading", { name: "Setup" }).waitFor();
  await page.screenshot({ path: testInfo.outputPath("setup.png"), fullPage: true });

  await page.goto("/stats");
  await page.getByRole("heading", { name: "Stats" }).waitFor();
  await page.screenshot({ path: testInfo.outputPath("stats.png"), fullPage: true });
});
