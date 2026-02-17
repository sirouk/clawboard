import { test, expect } from "@playwright/test";

test.describe("Real Chat E2E", () => {
  test("should send a message and see it in the log", async ({ page }) => {
    test.skip(
      process.env.PLAYWRIGHT_USE_EXTERNAL_SERVER !== "1",
      "Requires external Clawboard/OpenClaw runtime with real chat agents."
    );

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3010";
    const token = process.env.PLAYWRIGHT_TOKEN ?? "";
    test.skip(!token, "PLAYWRIGHT_TOKEN is required for real-chat external test.");

    await page.goto(`${baseURL}/setup`);
    
    // Clear local storage to ensure we use the new token
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // Navigate to setup and set the token manually to be sure
    await page.goto(`${baseURL}/setup`);
    await page.click('button:has-text("Step 2")');
    await page.fill('input[type="password"], input[type="text"]', token);
    await page.click('button:has-text("Save Token")');
    
    // Go to unified view
    await page.goto(`${baseURL}/u`);
    
    // Find a topic and open chat
    await page.waitForSelector('text="Small Talk"');
    const topicRow = page.locator('div').filter({ hasText: /^Small Talk/ }).first();
    await topicRow.locator('button[title*="Chat"]').click();

    // Type and send a message
    const composer = page.locator('textarea[placeholder*="Message"]');
    await composer.fill("Hello from Playwright E2E");
    await page.keyboard.press("Enter");

    // Check if the message appears in the list
    await expect(page.locator('text="Hello from Playwright E2E"')).toBeVisible({ timeout: 10000 });
    
    // Wait for assistant response (typing indicator then message)
    // This might take a while depending on the model
    console.log("Waiting for assistant response...");
    await expect(page.locator('div[data-agent-id="assistant"]')).toBeVisible({ timeout: 60000 });
    console.log("Assistant responded!");
  });
});
