import { test } from "@playwright/test";

test("ui snapshots pass", async ({ page }, testInfo) => {
  await page.goto("/u");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: testInfo.outputPath("home-unified.png"), fullPage: true });

  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true });

  await page.goto("/setup");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: testInfo.outputPath("setup.png"), fullPage: true });

  await page.goto("/stats");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: testInfo.outputPath("stats.png"), fullPage: true });
});
