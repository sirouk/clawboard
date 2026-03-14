import { expect, test, type Page } from "@playwright/test";

async function waitForUnifiedViewReady(page: Page) {
  const firstTopicCard = page.locator("[data-topic-card-id]").first();
  const composer = page.getByTestId("unified-composer-textarea").first();
  await Promise.race([
    firstTopicCard.waitFor({ state: "visible" }),
    composer.waitFor({ state: "visible" }),
  ]);
}

test("topic-first shell loads and the centered header tabs switch views", async ({ page }) => {
  await page.goto("/u");
  await waitForUnifiedViewReady(page);

  const unifiedTab = page.getByRole("link", { name: "Unified View" });
  const workspaceTab = page.getByRole("link", { name: "Code Workspaces" });

  await expect(unifiedTab).toHaveAttribute("aria-current", "page");
  await expect(unifiedTab).toHaveAttribute("href", /\/u/);
  await expect(workspaceTab).toHaveAttribute("href", /\/workspaces/);
  await expect(page.locator("[data-topic-card-id='topic-1']")).toBeVisible();

  const workspaceHref = await workspaceTab.getAttribute("href");
  expect(workspaceHref).toBeTruthy();
  await page.goto(workspaceHref!);
  await expect(page).toHaveURL(/\/workspaces/);
  await expect(page.getByTestId("workspace-chip-row")).toBeVisible();

  const unifiedHref = await page.getByRole("link", { name: "Unified View" }).getAttribute("href");
  expect(unifiedHref).toBeTruthy();
  await page.goto(unifiedHref!);
  await expect(page).toHaveURL(/\/u/);
  await expect(page.locator("[data-topic-card-id='topic-1']")).toBeVisible();
});

test("core routes for logs and graph stay reachable", async ({ page }) => {
  await page.goto("/log");
  await expect(page.getByPlaceholder("Search messages")).toBeVisible();

  await page.goto("/graph");
  await expect(page.getByTestId("clawgraph-canvas")).toBeVisible();
});
