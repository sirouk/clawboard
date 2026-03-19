import { expect, test, type Page } from "@playwright/test";

async function waitForUnifiedViewReady(page: Page) {
  const firstTopicCard = page.locator("[data-topic-card-id]").first();
  const composer = page.getByTestId("unified-composer-textarea").first();
  await Promise.race([
    firstTopicCard.waitFor({ state: "visible" }),
    composer.waitFor({ state: "visible" }),
  ]);
}

async function clickPrimaryTabUntilUrl(page: Page, label: string, urlPattern: RegExp) {
  const nav = page.getByRole("navigation", { name: "Primary views" });
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await nav.getByRole("link", { name: label }).click();
    try {
      await expect(page).toHaveURL(urlPattern, { timeout: 5_000 });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await page.waitForTimeout(250);
    }
  }

  if (lastError) throw lastError;
}

test("topic-first shell loads and the centered header tabs switch views", async ({ page }) => {
  await page.goto("/u");
  await waitForUnifiedViewReady(page);

  const unifiedTab = page.getByRole("link", { name: "Board View" });
  const workspaceTab = page.getByRole("link", { name: "Code Workspace" });

  await expect(unifiedTab).toHaveAttribute("aria-current", "page");
  await expect(unifiedTab).toHaveAttribute("href", /\/u/);
  await expect(workspaceTab).toHaveAttribute("href", /\/workspaces/);
  await expect(page.locator("[data-topic-card-id='topic-1']")).toBeVisible();

  await clickPrimaryTabUntilUrl(page, "Code Workspace", /\/workspaces/);
  await expect(page.getByTestId("workspace-ide-frame")).toBeVisible();

  await clickPrimaryTabUntilUrl(page, "Board View", /\/u/);
  await expect(page.locator("[data-topic-card-id='topic-1']")).toBeVisible();
});

test("core routes for logs and graph stay reachable", async ({ page }) => {
  await page.goto("/log");
  await expect(page.getByPlaceholder("Search messages")).toBeVisible();

  await page.goto("/graph");
  await expect(page.getByTestId("clawgraph-canvas")).toBeVisible();
});
