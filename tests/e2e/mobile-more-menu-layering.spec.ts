import { expect, test } from "@playwright/test";

test.describe("mobile more menu layering", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("setup remains clickable from More menu over board content", async ({ page }) => {
    await page.goto("/u");
    await page.getByRole("button", { name: "More navigation" }).waitFor();

    const moreButton = page.getByRole("button", { name: "More navigation" });
    await moreButton.click();

    const setupLink = page.locator("a[href='/setup']:visible").first();
    await expect(setupLink).toBeVisible();
    await Promise.all([page.waitForURL(/\/setup$/), setupLink.click()]);
  });
});
