import { test, expect } from "@playwright/test";

test.describe("Real Chat E2E", () => {
  test("should send a message and see it in the log", async ({ page, request }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `topic-real-chat-${suffix}`;
    const topicName = `Real Chat ${suffix}`;
    const sessionKey = `clawboard:topic:${topicId}`;
    const message = `Hello from Playwright E2E ${suffix}`;

    const createTopic = await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false },
    });
    expect(createTopic.ok()).toBeTruthy();

    await page.goto(`/u/topic/${topicId}`);
    await page.getByRole("heading", { name: "Unified View" }).waitFor();

    const topicToggle = page.getByTestId(`toggle-topic-chat-${topicId}`);
    const label = (await topicToggle.getAttribute("aria-label")) ?? "";
    if (/expand/i.test(label)) {
      await topicToggle.click();
    }

    const composer = page.getByTestId(`topic-chat-composer-${topicId}`).getByRole("textbox");
    await expect(composer).toBeVisible();

    const send = page.waitForResponse(
      (resp) => resp.url().includes("/api/openclaw/chat") && resp.request().method() === "POST"
    );
    await composer.fill(message);
    await composer.press("Enter");
    await send;

    await expect(page.locator("[data-testid^='message-bubble-']").filter({ hasText: message }).first()).toBeVisible();

    const logsRes = await request.get(
      `${apiBase}/api/log?sessionKey=${encodeURIComponent(sessionKey)}&limit=30`
    );
    expect(logsRes.ok()).toBeTruthy();
    const rows = (await logsRes.json()) as Array<{ content?: string }>;
    expect(rows.some((row) => row.content === message)).toBeTruthy();

    await page.goto("/log");
    await page.getByRole("heading", { name: "All Activity" }).waitFor();
    await expect(page.getByText(message, { exact: true }).first()).toBeVisible();
  });
});
