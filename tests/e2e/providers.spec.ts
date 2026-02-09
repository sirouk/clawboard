import { expect, test } from "@playwright/test";

test("providers page supports copying commands and unlocking truncated blocks", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });

  await page.goto("/providers");

  await expect(page.getByRole("heading", { name: "Chutes (Recommended)" })).toBeVisible();

  const unixPre = page.getByRole("textbox", { name: "Manual setup command" });
  await expect(unixPre).toBeVisible();
  await expect(unixPre).toHaveClass(/claw-truncate-fade/);
  await unixPre.click();
  await expect(unixPre).not.toHaveClass(/claw-truncate-fade/);

  await page.getByRole("button", { name: "Copy unix setup command" }).click();
  await expect(page.getByText("Copied to clipboard.")).toBeVisible();

  await page.getByRole("button", { name: "Copy agent prompt" }).click();
  await expect(page.getByText("Copied to clipboard.")).toBeVisible();
});

