import { test, expect } from "@playwright/test";

test.describe("Real Chat E2E", () => {
  test("should send a message and see it in the log", async ({ page }) => {
    // We expect the services to be running at localhost:3010 (web) and localhost:8010 (api)
    const baseURL = "http://localhost:3010";
    const token = "af8d0bebf8b273af98bce2f35ac02aa08b2d980b95fb7bc1";

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
