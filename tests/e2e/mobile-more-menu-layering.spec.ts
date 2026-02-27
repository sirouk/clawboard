import { expect, test } from "@playwright/test";

test.describe("mobile more menu layering", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("setup remains clickable from More menu over board content", async ({ page }) => {
    await page.goto("/u");
    await page.getByRole("button", { name: "More navigation" }).waitFor();

    const moreButton = page.getByRole("button", { name: "More navigation" });
    await moreButton.click();

    const settingsLink = page.locator("a[href='/settings']:visible").first();
    await expect(settingsLink).toBeVisible();
    await settingsLink.click();
    await expect(page).toHaveURL(/\/settings(?:\?.*)?$/);
  });
});
