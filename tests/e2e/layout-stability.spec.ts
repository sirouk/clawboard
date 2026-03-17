import { expect, test } from "@playwright/test";
import { injectClsObserver, waitForUnifiedViewReady } from "../visual/helpers";

test.describe("layout stability — Cumulative Layout Shift", () => {
  test("initial paint of /u has acceptable CLS (< 0.1)", async ({ page }) => {
    const getCls = await injectClsObserver(page);

    await page.goto("/u");
    await waitForUnifiedViewReady(page);

    // Wait a moment for any deferred layout shifts to settle (e.g. lazy images,
    // web font swap, dynamic imports finishing).
    await page.waitForTimeout(800);

    const cls = await getCls();
    expect(
      cls,
      `Expected CLS < 0.1 on /u first paint but got ${cls.toFixed(4)}. ` +
        `This likely indicates a layout shift from state initializing as false/null then ` +
        `updating after hydration (e.g. mdUp column layout, filters drawer).`
    ).toBeLessThan(0.1);
  });

  test("Board → Workspaces → Board navigation: both hub panels stay in DOM", async ({
    page,
    request,
  }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `ls-nav-topic-${suffix}`;
    const topicName = `Layout Stability Nav Topic ${suffix}`;

    await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false, status: "active" },
    });

    await page.goto("/u");
    await waitForUnifiedViewReady(page);

    // Expand the topic so there is meaningful board state to survive the round-trip.
    const topicExpand = page
      .getByRole("button", { name: `Expand topic ${topicName}`, exact: true })
      .first();
    if (await topicExpand.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await topicExpand.click();
    }

    // Navigate to Workspaces via the header tab.
    const workspacesLink = page.getByRole("link", { name: "Code Workspace" }).first();
    await expect(workspacesLink).toBeVisible({ timeout: 10_000 });
    await workspacesLink.click();

    // The board panel must remain mounted (just hidden) so state is preserved.
    const boardPanel = page.getByTestId("board-hub-panel");
    await expect(boardPanel).toBeAttached({ timeout: 10_000 });

    // The workspace panel should now be visible.
    const workspacePanel = page.getByTestId("workspace-hub-panel");
    await expect(workspacePanel).toBeVisible({ timeout: 10_000 });

    // Navigate back to Board.
    const boardLink = page.getByRole("link", { name: "Unified View" }).first();
    await boardLink.click();

    // Both panels still in DOM.
    await expect(boardPanel).toBeAttached();
    await expect(workspacePanel).toBeAttached();

    // Topic card is still visible — board state was preserved, not reset.
    await expect(page.locator(`[data-topic-card-id="${topicId}"]`).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("workspace fetch error does not flash the workspace list to empty", async ({ page }) => {
    let callCount = 0;
    // First call succeeds; subsequent calls fail (simulates a refetch error after route change).
    await page.route("**/api/openclaw/workspaces", async (route) => {
      callCount += 1;
      if (callCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            configured: true,
            provider: "code-server",
            baseUrl: "http://workspace-ide.localhost:13337",
            workspaces: [
              {
                agentId: "main",
                agentName: "Main",
                workspaceDir: "/workspace",
                ideUrl: "http://workspace-ide.localhost:13337",
                preferred: true,
              },
            ],
          }),
        });
      } else {
        await route.fulfill({ status: 500, body: "Internal Server Error" });
      }
    });

    await page.goto("/workspaces/main");
    // Wait for the workspace IDE frame to appear on the first successful load.
    await expect(page.getByTestId("workspace-ide-frame")).toBeVisible({ timeout: 15_000 });

    // Navigate to board and back; this triggers a re-fetch that will fail.
    const boardLink = page.getByRole("link", { name: "Unified View" }).first();
    await boardLink.click();
    await page.getByRole("heading", { name: "Unified View" }).waitFor({ timeout: 10_000 });

    const workspacesLink = page.getByRole("link", { name: "Code Workspace" }).first();
    await workspacesLink.click();

    // Even after the failing refetch, the previously loaded workspace IDE frame must still be visible.
    // The providers.tsx error path preserves previous data instead of clearing it.
    await expect(page.getByTestId("workspace-ide-frame")).toBeVisible({ timeout: 10_000 });
  });
});
