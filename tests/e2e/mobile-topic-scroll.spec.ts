import { expect, test } from "@playwright/test";

test.describe("mobile topic expansion scroll behavior", () => {
  test.use({
    viewport: { width: 390, height: 844 }, // iPhone 12/13-ish
  });

  test("expanded topic keeps header visible while body scrolls", async ({ page }, testInfo) => {
    await page.goto("/u");
    await page.getByPlaceholder("Search topics, tasks, or messages").waitFor();

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

    // Capture initial position.
    const headerBoxBefore = await topicTitle.boundingBox();
    expect(headerBoxBefore).not.toBeNull();

    // Force an internal scroll (wheel scrolling can scroll the page depending on platform/input).
    await scroller.evaluate((el) => {
      (el as HTMLElement).scrollTop = 1200;
    });

    const scrollerTop = await scroller.evaluate((el) => (el as HTMLElement).scrollTop);
    expect(scrollerTop).toBeGreaterThan(0);

    // Confirm the header did not move when the body scrolled.
    const headerBoxAfter = await topicTitle.boundingBox();
    expect(headerBoxAfter).not.toBeNull();

    const deltaY = Math.abs(headerBoxAfter!.y - headerBoxBefore!.y);
    expect(deltaY).toBeLessThan(2);

    await page.screenshot({ path: testInfo.outputPath("mobile-topic-expanded.png"), fullPage: true });
  });
});
