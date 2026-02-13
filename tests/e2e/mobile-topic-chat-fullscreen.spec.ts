import { expect, test } from "@playwright/test";

test.describe("mobile topic chat fullscreen", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("topic chat opens fullscreen, scrolls, and closes back to board", async ({ page, request }) => {
    test.setTimeout(45_000);
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `mobile-topic-chat-${suffix}`;
    const topicName = `Mobile Overlay ${suffix}`;
    const sessionKey = `channel:mobile-topic-chat-${suffix}`;

    const createTopic = await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false },
    });
    expect(createTopic.ok()).toBeTruthy();

    for (let i = 0; i < 20; i += 1) {
      const fromUser = i % 2 === 0;
      const res = await request.post(`${apiBase}/api/log`, {
        data: {
          topicId,
          type: "conversation",
          content: `${fromUser ? "user" : "assistant"}-${suffix}-${i} ${"dolor sit amet ".repeat(24)}`,
          summary: `topic-msg-${i}`,
          classificationStatus: "classified",
          agentId: fromUser ? "user" : "assistant",
          agentLabel: fromUser ? "User" : "OpenClaw",
          source: { sessionKey },
        },
      });
      expect(res.ok()).toBeTruthy();
    }

    await page.goto("/u");
    await page.getByPlaceholder("Search topics, tasks, or messages").waitFor();

    const topicCardHeader = page.locator("div[role='button']").filter({ hasText: topicName }).first();
    await expect(topicCardHeader).toBeVisible();
    await topicCardHeader.click();

    const topicChatToggle = page.getByTestId(`toggle-topic-chat-${topicId}`);
    await expect(topicChatToggle).toBeVisible();
    await topicChatToggle.click();

    const topicCard = page.locator(`[data-topic-card-id='${topicId}']`).first();
    await expect(topicCard).toBeVisible();
    const cardPosition = await topicCard.evaluate((el) => window.getComputedStyle(el).position);
    expect(cardPosition).toBe("fixed");
    const cardBackground = await topicCard.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(cardBackground === "transparent" || cardBackground === "rgba(0, 0, 0, 0)").toBeFalsy();

    await expect(page.getByRole("button", { name: "Close chat" })).toBeVisible();
    const context = page.getByTestId(`topic-chat-context-${topicId}`);
    await expect(context).toBeVisible();
    await expect(context).toContainText(topicName);
    const breadcrumb = page.getByTestId(`topic-chat-breadcrumb-${topicId}`);
    await expect(breadcrumb).toBeVisible();
    const breadcrumbWrap = await breadcrumb.evaluate((el) => window.getComputedStyle(el).flexWrap);
    expect(breadcrumbWrap).toBe("nowrap");
    const chatScroller = page.getByTestId(`topic-chat-scroll-${topicId}`);
    await expect(chatScroller).toBeVisible();

    const scrollMetrics = await chatScroller.evaluate((el) => {
      const node = el as HTMLElement;
      return {
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      };
    });
    if (scrollMetrics.scrollHeight > scrollMetrics.clientHeight) {
      const afterScroll = await chatScroller.evaluate((el) => {
        const node = el as HTMLElement;
        const start = node.scrollTop;
        node.scrollTop = Math.max(0, start - 280);
        return { start, end: node.scrollTop };
      });
      expect(afterScroll.end).not.toBe(afterScroll.start);
    }

    const controls = page.getByTestId(`topic-chat-controls-${topicId}`);
    await expect(controls).toBeVisible();
    const flexWrap = await controls.evaluate((el) => window.getComputedStyle(el).flexWrap);
    expect(flexWrap).toBe("nowrap");

    const loadOlder = controls.getByRole("button", { name: "Load older" });
    if (await loadOlder.count()) {
      const entries = page.getByTestId(`topic-chat-entries-${topicId}`);
      const whiteSpace = await loadOlder.first().evaluate((el) => window.getComputedStyle(el).whiteSpace);
      expect(whiteSpace).toBe("nowrap");
      const loadOlderBox = await loadOlder.first().boundingBox();
      const entriesBox = await entries.boundingBox();
      expect(loadOlderBox).not.toBeNull();
      expect(entriesBox).not.toBeNull();
      expect((loadOlderBox?.x ?? 0)).toBeGreaterThan((entriesBox?.x ?? 0));
      const overlap =
        Math.min((loadOlderBox?.y ?? 0) + (loadOlderBox?.height ?? 0), (entriesBox?.y ?? 0) + (entriesBox?.height ?? 0)) -
        Math.max(loadOlderBox?.y ?? 0, entriesBox?.y ?? 0);
      expect(overlap).toBeGreaterThan(0);
    }

    const composer = page.getByTestId(`topic-chat-composer-${topicId}`);
    await expect(composer).toBeVisible();
    const composerInput = composer.getByRole("textbox").first();
    await expect(composer.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Attach files" })).toBeVisible();
    await composerInput.click();
    await composerInput.fill("Drafting while reading older topic messages.");
    await chatScroller.evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = 0;
    });
    await chatScroller.evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = node.scrollHeight;
    });
    await expect(composer).toBeVisible();
    await expect(composerInput).toBeVisible();
    const composerBox = await composer.boundingBox();
    const viewport = page.viewportSize();
    expect(composerBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 6);

    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(page.getByRole("button", { name: "Close chat" })).toHaveCount(0);
    await expect(page.getByPlaceholder("Search topics, tasks, or messages")).toBeVisible();
  });
});
