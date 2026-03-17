import { expect, test } from "@playwright/test";

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";

test.describe("sticky topic header — content clipping", () => {
  test("expanded topic card clips content and header is sticky", async ({
    page,
    request,
  }) => {
    const suffix = Date.now();
    const topicId = `sticky-clip-topic-${suffix}`;
    const topicName = `Sticky Clip Test ${suffix}`;

    // Create a topic with enough messages to produce scrollable chat content.
    await request.post(`${API_BASE}/api/topics`, {
      data: { id: topicId, name: topicName, status: "active" },
    });

    const messages: { id: string; topicId: string; message: string }[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        id: `sticky-msg-${suffix}-${i}`,
        topicId,
        message: `Message ${i}: ${"Lorem ipsum dolor sit amet consectetur. ".repeat(4)}`,
      });
    }
    await request.post(`${API_BASE}/api/ingest`, { data: messages });

    await page.goto("/u");
    await page.waitForSelector(`[data-topic-card-id="${topicId}"]`, { timeout: 10_000 });

    // Expand the topic.
    const card = page.locator(`[data-topic-card-id="${topicId}"]`);
    await card.locator('[role="button"]').first().click();

    // Wait for expanded body to appear.
    await page.getByTestId(`topic-expanded-body-${topicId}`).waitFor({ state: "visible", timeout: 10_000 });

    // Verify the expanded card has clip-path set (prevents content from showing above header).
    const clipPath = await card.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.clipPath || style.getPropertyValue("clip-path") || "none";
    });
    expect(clipPath, "Expanded topic card must have clip-path to clip scrolled content").not.toBe("none");
    expect(clipPath).toContain("inset");

    // Verify the header is position: sticky.
    const header = card.locator('[role="button"]').first();
    const headerPosition = await header.evaluate((el) => window.getComputedStyle(el).position);
    expect(headerPosition, "Topic header must be sticky when expanded").toBe("sticky");

    // Verify the card does NOT have overflow: hidden (which would break sticky).
    const overflow = await card.evaluate((el) => window.getComputedStyle(el).overflow);
    expect(overflow, "Card must not have overflow:hidden when expanded (breaks sticky)").not.toBe("hidden");

    // Scroll the page so the header would become stuck.
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    const cardBox = await card.boundingBox();
    expect(cardBox).toBeTruthy();

    await page.evaluate((cardY) => {
      window.scrollTo({ top: window.scrollY + cardY + 150, behavior: "instant" });
    }, cardBox!.y);
    await page.waitForTimeout(200);

    // After scrolling, verify chat messages inside the scroller don't visually
    // extend above the card's clip boundary. We check that the chat scroller's
    // bounding box top is >= the card's bounding box top (within clip-path).
    const chatScroller = page.getByTestId(`topic-chat-scroll-${topicId}`);
    const scrollerVisible = await chatScroller.isVisible().catch(() => false);
    if (scrollerVisible) {
      const scrollerBox = await chatScroller.boundingBox();
      const updatedCardBox = await card.boundingBox();
      if (scrollerBox && updatedCardBox) {
        expect(
          scrollerBox.y,
          "Chat scroller top must not extend above the card boundary"
        ).toBeGreaterThanOrEqual(updatedCardBox.y - 1); // 1px tolerance for rounding
      }
    }

    // Cleanup.
    await request.delete(`${API_BASE}/api/topics/${topicId}`);
  });
});
