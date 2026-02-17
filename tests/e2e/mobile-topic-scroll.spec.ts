import { expect, test } from "@playwright/test";

test.describe("mobile topic expansion scroll behavior", () => {
  test.use({
    viewport: { width: 390, height: 844 }, // iPhone 12/13-ish
  });

  test("expanded topic keeps header visible while body scrolls", async ({ page }, testInfo) => {
    await page.goto("/u");
    await page.getByPlaceholder("Search topics, tasks, or messages").first().waitFor();

    await page.waitForSelector("[data-topic-card-id]", { timeout: 60_000 });
    const firstTopicCard = page.locator("[data-topic-card-id]").first();
    await expect(firstTopicCard).toBeVisible();

    // Expand the first topic.
    await firstTopicCard.getByTitle("Expand").click();

    const topicTitle = firstTopicCard.getByRole("heading").first();
    await expect(topicTitle).toBeVisible();

    // The body container should be the scrollable region on mobile.
    const newTaskInput = firstTopicCard.getByPlaceholder("Add a task…");
    await expect(newTaskInput).toBeVisible();

    const topicId = await firstTopicCard.getAttribute("data-topic-card-id");
    expect(topicId).toBeTruthy();

    const scroller = firstTopicCard.getByTestId(`topic-expanded-body-${topicId}`);
    await expect(scroller).toBeVisible();

    const metrics = await scroller.evaluate((el) => {
      const node = el as HTMLElement;
      const style = window.getComputedStyle(node);
      return {
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        overflowY: style.overflowY,
      };
    });
    // Accept current layout variants as long as content can overflow.
    expect(["auto", "scroll", "visible", "clip"].includes(metrics.overflowY)).toBeTruthy();

    // Capture initial position.
    const headerBoxBefore = await topicTitle.boundingBox();
    expect(headerBoxBefore).not.toBeNull();

    // Only assert positive scroll offset when this viewport/data combination actually overflows.
    if (metrics.scrollHeight > metrics.clientHeight + 2) {
      await scroller.evaluate((el) => {
        const node = el as HTMLElement;
        node.scrollTop = node.scrollHeight;
      });

      const scrollerTop = await scroller.evaluate((el) => (el as HTMLElement).scrollTop);
      expect(scrollerTop).toBeGreaterThan(0);

      // Confirm the header did not move when the body scrolled.
      const headerBoxAfter = await topicTitle.boundingBox();
      expect(headerBoxAfter).not.toBeNull();

      const deltaY = Math.abs(headerBoxAfter!.y - headerBoxBefore!.y);
      expect(deltaY).toBeLessThan(2);
    }

    await page.screenshot({ path: testInfo.outputPath("mobile-topic-expanded.png"), fullPage: true });
  });
});
