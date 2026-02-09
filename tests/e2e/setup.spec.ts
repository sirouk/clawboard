import { expect, test } from "@playwright/test";

test("setup wizard enforces token gating and persists instance settings", async ({ page }) => {
  type ConfigPost = { title?: string; integrationLevel?: string };
  const seen: { configBody?: ConfigPost; authHeader?: string | null } = {};

  await page.route("**/api/config", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instance: { title: "Clawboard", integrationLevel: "manual", updatedAt: "2026-02-06T00:00:00.000Z" },
          tokenRequired: true,
          tokenConfigured: true,
        }),
      });
      return;
    }

    if (req.method() === "POST") {
      seen.authHeader = req.headers()["x-clawboard-token"] ?? null;
      seen.configBody = req.postDataJSON() as ConfigPost;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instance: { ...seen.configBody, updatedAt: new Date().toISOString() },
          tokenRequired: true,
          tokenConfigured: true,
        }),
      });
      return;
    }

    await route.continue();
  });

  await page.goto("/setup");
  await expect(page.getByText("Instance Configuration")).toBeVisible();

  await page.getByRole("button", { name: /Step 2/i }).click();
  await expect(page.getByRole("heading", { name: "API Token" })).toBeVisible();

  const continueBtn = page.getByRole("button", { name: "Continue to instance" });
  await expect(continueBtn).toBeDisabled();

  await page.getByPlaceholder("Token required").fill(" test-token ");
  await page.getByRole("button", { name: "Save token locally" }).click();
  await expect(page.getByText("Token stored locally.")).toBeVisible();

  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();

  await expect(page.getByRole("heading", { name: "Instance Details" })).toBeVisible();
  await page.getByPlaceholder("Clawboard").fill("Clawboard Test Instance");
  await page.locator("select").first().selectOption("full");

  // Preserve the existing api base, but ensure trailing slashes are normalized.
  const apiBaseInput = page.getByPlaceholder("http://localhost:8010");
  const currentApiBase = await apiBaseInput.inputValue();
  await apiBaseInput.fill(`${currentApiBase}/`);

  await page.getByRole("button", { name: "Save setup" }).click();
  await expect(page.getByText("Saved. Instance updated.")).toBeVisible();

  const storedToken = await page.evaluate(() => window.localStorage.getItem("clawboard.token"));
  expect(storedToken).toBe("test-token");
  const storedTitle = await page.evaluate(() => window.localStorage.getItem("clawboard.instanceTitle"));
  expect(storedTitle).toBe("Clawboard Test Instance");
  const storedLevel = await page.evaluate(() => window.localStorage.getItem("clawboard.integrationLevel"));
  expect(storedLevel).toBe("full");
  const storedApiBase = await page.evaluate(() => window.localStorage.getItem("clawboard.apiBase"));
  expect(storedApiBase).toBe(currentApiBase.replace(/\/$/, ""));

  expect(seen.authHeader).toBe("test-token");
  expect(seen.configBody?.title).toBe("Clawboard Test Instance");
  expect(seen.configBody?.integrationLevel).toBe("full");
});

test("setup wizard warns when remote read is locked", async ({ page }) => {
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Unauthorized" }),
    });
  });

  await page.goto("/setup");
  await page.getByRole("button", { name: /Step 2/i }).click();

  await expect(page.getByText(/connection is locked/i)).toBeVisible();
});
