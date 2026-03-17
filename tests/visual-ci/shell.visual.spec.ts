import { expect, test } from "@playwright/test";
import { applyVisualStabilizers, gotoPath, waitForUnifiedViewReady } from "../visual/helpers";

test.beforeEach(async ({ page }) => {
  await applyVisualStabilizers(page);
});

test("unified shell visual baseline", async ({ page }) => {
  await gotoPath(page, "/u");
  await waitForUnifiedViewReady(page);
  await expect(page).toHaveScreenshot("shell-unified.png");
});

test("workspaces shell visual baseline", async ({ page }) => {
  await gotoPath(page, "/workspaces");
  await expect(page.getByRole("link", { name: "Code Workspace" })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveScreenshot("shell-workspaces.png");
});
