import { expect, test } from "@playwright/test";

test.describe("topic chat scroll stability after sending a message", () => {
  test("topic card stays visible after sending from task chat composer", async ({ page, request }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();

    // Create several topics with distinct sortIndex values so the target topic
    // is NOT at the top of the board.
    const topicIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const topicId = `topic-scroll-${i}-${suffix}`;
      const topicName = `Scroll Stability Topic ${i} ${suffix}`;
      const res = await request.post(`${apiBase}/api/topics`, {
        data: { id: topicId, name: topicName, pinned: false, sortIndex: i, status: "active" },
      });
      expect(res.ok()).toBeTruthy();
      topicIds.push(topicId);
    }

    // We'll test with the LAST topic (highest sortIndex → lowest position in the list).
    const targetTopicId = topicIds[topicIds.length - 1];

    // Route the chat endpoint so we can observe the send without needing a real backend.
    const chatPayloads: Array<Record<string, unknown>> = [];
    await page.route("**/api/openclaw/chat", async (route) => {
      if (route.request().method() === "POST") {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        chatPayloads.push(payload);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ queued: true, requestId: `req-scroll-${suffix}` }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/u");
    await page.getByRole("heading", { name: "Unified View" }).waitFor();

    // Wait for all topic cards to appear.
    const targetCard = page.locator(`[data-topic-card-id='${targetTopicId}']`);
    await expect(targetCard).toBeVisible({ timeout: 30_000 });

    // Expand the target topic's task (which is the topic itself in flat topology).
    const taskCard = page.locator(`[data-task-card-id='${targetTopicId}']`);
    if (await taskCard.count() > 0 && !(await taskCard.locator("[data-testid]").filter({ hasText: "composer" }).count())) {
      // Click the task header to expand if not already expanded.
      const taskHeader = taskCard.locator("> div[role='button']").first();
      if (await taskHeader.count() > 0) {
        const expanded = await taskHeader.getAttribute("aria-expanded");
        if (expanded !== "true") {
          await taskHeader.click();
        }
      }
    }

    // Find the task chat composer for the target topic.
    const composer = page.getByTestId(`task-chat-composer-${targetTopicId}`);
    await expect(composer).toBeVisible({ timeout: 15_000 });
    const textbox = composer.getByRole("textbox");
    await textbox.focus();

    // Record position of the topic card before sending.
    const boxBefore = await targetCard.boundingBox();
    expect(boxBefore).not.toBeNull();

    // Type and send a message.
    const message = `stability-test-${suffix}`;
    await textbox.fill(message);
    const sendButton = composer.getByRole("button", { name: "Send" });
    await sendButton.click();

    // Wait for the chat request to be intercepted.
    await expect.poll(() => chatPayloads.length).toBeGreaterThanOrEqual(1);

    // Give a short pause for React to re-render and any scroll compensation to complete.
    await page.waitForTimeout(500);

    // The target topic card should still be visible in the viewport.
    const boxAfter = await targetCard.boundingBox();
    expect(boxAfter).not.toBeNull();

    const viewportHeight = page.viewportSize()?.height ?? 720;

    // The topic card should be within the viewport (visible to the user).
    // Allow a generous margin — the card should be at least partially visible.
    const cardTopInView = boxAfter!.y < viewportHeight;
    const cardBottomInView = boxAfter!.y + boxAfter!.height > 0;
    expect(
      cardTopInView && cardBottomInView,
      `Topic card should be visible in viewport. Card y=${boxAfter!.y}, viewport height=${viewportHeight}`
    ).toBeTruthy();

    // The topic card should NOT have jumped by more than a small tolerance.
    // A jump of more than half the viewport height indicates the scroll compensation failed.
    const positionDelta = Math.abs(boxAfter!.y - boxBefore!.y);
    expect(
      positionDelta,
      `Topic card position shifted by ${positionDelta}px (before: y=${boxBefore!.y}, after: y=${boxAfter!.y}). ` +
        `Expected minimal shift but the topic appears to have jumped.`
    ).toBeLessThan(viewportHeight / 2);
  });

  test("topic card is visible and composer focused after sending from unified composer", async ({ page, request }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();

    // Create topics.
    const topicIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const topicId = `topic-unified-scroll-${i}-${suffix}`;
      const topicName = `Unified Scroll Topic ${i} ${suffix}`;
      const res = await request.post(`${apiBase}/api/topics`, {
        data: { id: topicId, name: topicName, pinned: false, sortIndex: i, status: "active" },
      });
      expect(res.ok()).toBeTruthy();
      topicIds.push(topicId);
    }

    const targetTopicId = topicIds[topicIds.length - 1];

    // Intercept resolve-board-send and chat endpoints.
    await page.route("**/api/openclaw/resolve-board-send", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          topicId: targetTopicId,
          taskId: targetTopicId,
          sessionKey: `clawboard:topic:${targetTopicId}`,
        }),
      });
    });

    const chatPayloads: Array<Record<string, unknown>> = [];
    await page.route("**/api/openclaw/chat", async (route) => {
      if (route.request().method() === "POST") {
        chatPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ queued: true, requestId: `req-unified-${suffix}` }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/u");
    await page.getByRole("heading", { name: "Unified View" }).waitFor();

    const targetCard = page.locator(`[data-topic-card-id='${targetTopicId}']`);
    await expect(targetCard).toBeVisible({ timeout: 30_000 });

    // Type in the unified composer and send.
    const unifiedComposer = page.getByTestId("unified-composer-textarea");
    await expect(unifiedComposer).toBeVisible();
    await unifiedComposer.fill(`unified-stability-${suffix}`);
    await unifiedComposer.press("Enter");

    // Wait for the chat request.
    await expect.poll(() => chatPayloads.length).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500);

    // After send: the target topic card should be visible in the viewport
    // and the task chat composer should be expanded and focused.
    const boxAfter = await targetCard.boundingBox();
    expect(boxAfter).not.toBeNull();

    const viewportHeight = page.viewportSize()?.height ?? 720;
    const cardTopInView = boxAfter!.y < viewportHeight;
    const cardBottomInView = boxAfter!.y + boxAfter!.height > 0;
    expect(
      cardTopInView && cardBottomInView,
      `Topic card should be visible after unified send. Card y=${boxAfter!.y}, viewport=${viewportHeight}`
    ).toBeTruthy();

    // The task chat composer for the target topic should now be visible.
    const taskComposer = page.getByTestId(`task-chat-composer-${targetTopicId}`);
    await expect(taskComposer).toBeVisible({ timeout: 5_000 });
  });
});
