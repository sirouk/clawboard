import { expect, test } from "@playwright/test";

test("read-only mode keeps note composer visible but disabled", async ({ page }) => {
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        instance: {
          title: "Clawboard",
          integrationLevel: "manual",
          updatedAt: "2026-02-06T00:00:00.000Z",
        },
        tokenRequired: true,
      }),
    });
  });

  await page.goto("/log");
  await expect(page.getByRole("heading", { name: "All Activity" })).toBeVisible();

  await page.getByRole("button", { name: "Add note" }).first().click();
  const noteTextarea = page.locator("textarea").first();

  await expect(noteTextarea).toBeDisabled();
  await expect(noteTextarea).toHaveAttribute("placeholder", /Add token in Setup/i);
  await expect(page.getByRole("button", { name: "Save note" }).first()).toBeDisabled();
  await expect(page.getByText("Read-only mode. Add a token in Setup.").first()).toBeVisible();
});

