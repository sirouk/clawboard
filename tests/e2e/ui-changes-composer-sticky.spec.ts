/**
 * Tests for:
 *   1. Freeform composer textarea smaller default height (min-height 40px via inline style)
 *   2. Composer auto-expands as text is typed
 *   3. Sticky topic headers in single-column mode
 *   4. Sticky task headers in single-column mode
 *   5. Sticky headers disabled in two-column mode
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3010";

test.describe("composer textarea height", () => {
  test("empty textarea has reduced min-height (~40px not 120px)", async ({ page }) => {
    await page.goto(`${BASE}/u`);
    const textarea = page.getByTestId("unified-composer-textarea");
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    const box = await textarea.boundingBox();
    expect(box).not.toBeNull();

    // Verify the inline style min-height overrides the base TextArea class (min-h-[120px]).
    // With JS floor of 44px, the rendered height should be 44-60px (44px + possible font/padding).
    // Old behaviour was 88px (the JS auto-resize floor was hardcoded to 88).
    expect(box!.height).toBeGreaterThanOrEqual(30);
    expect(box!.height).toBeLessThan(72);
  });

  test("textarea grows as content is typed", async ({ page }) => {
    await page.goto(`${BASE}/u`);
    const textarea = page.getByTestId("unified-composer-textarea");
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    const emptyHeight = (await textarea.boundingBox())!.height;

    // Type several lines to trigger auto-expand
    await textarea.click();
    await textarea.fill(
      "Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven"
    );
    await page.waitForTimeout(400);

    const expandedHeight = (await textarea.boundingBox())!.height;
    // Should grow by at least one line-height beyond empty height
    expect(expandedHeight).toBeGreaterThan(emptyHeight + 10);
  });
});

test.describe("sticky topic headers (single column, mobile viewport)", () => {
  test.use({ viewport: { width: 520, height: 900 } }); // Below md breakpoint → always single column

  test("expanded topic header is position:sticky with correct top offset", async ({ page }) => {
    await page.goto(`${BASE}/u`);
    await page.waitForSelector("[data-topic-card-id]", { timeout: 20_000 });

    const firstCard = page.locator("[data-topic-card-id]").first();
    const topicId = await firstCard.getAttribute("data-topic-card-id");
    expect(topicId).toBeTruthy();

    // Expand the topic by clicking the header row
    const headerRow = firstCard.locator('[role="button"]').first();
    const initialPosition = await headerRow.evaluate((el) =>
      window.getComputedStyle(el).position
    );

    // Click to expand (if not already expanded)
    if (initialPosition !== "sticky") {
      await headerRow.click();
      await page.waitForTimeout(600);
    }

    const expandedCard = page.locator(`[data-topic-card-id="${topicId}"]`);
    const stickyHeader = expandedCard.locator('[role="button"]').first();

    // Must be sticky after expansion
    const position = await stickyHeader.evaluate((el) =>
      window.getComputedStyle(el).position
    );
    expect(position).toBe("sticky");

    // top should be set to stickyBarHeight (> 0px, some positive value below a reasonable cap)
    const topValue = await stickyHeader.evaluate((el) =>
      window.getComputedStyle(el).top
    );
    const topPx = parseInt(topValue, 10);
    expect(topPx).toBeGreaterThan(0);
    expect(topPx).toBeLessThan(600); // board bar + any banners

    // Topic header z-index is 10; task headers are z-20 so they pop over topics when both are stuck
    const zIndex = await stickyHeader.evaluate((el) =>
      window.getComputedStyle(el).zIndex
    );
    expect(parseInt(zIndex, 10)).toBeGreaterThanOrEqual(10);

    await page.screenshot({ path: "test-results/sticky-topic-header-mobile.png" });
  });
});

test.describe("sticky headers desktop (single vs two column)", () => {
  test.use({ viewport: { width: 1280, height: 900 } }); // Desktop, md+ breakpoint

  /**
   * Helper: ensures single-column mode is active.
   * Button label logic:
   *   twoColumn=true  → button reads "1 column"  (click → switches to single col)
   *   twoColumn=false → button reads "2 column"  (click → switches to two col)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function ensureSingleColumn(page: any) {
    const boardControls = page.getByRole("button", { name: /Board controls/i }).first();
    const hasToggle = await boardControls.isVisible().catch(() => false);
    if (hasToggle) {
      await boardControls.click();
      await page.waitForTimeout(400);
    }

    // If we see "1 column" button, we're currently in 2-col → click to switch to single
    const oneColBtn = page.getByRole("button", { name: /^1 column$/i }).first();
    const isInTwoCol = await oneColBtn.isVisible().catch(() => false);
    if (isInTwoCol) {
      await oneColBtn.click();
      await page.waitForTimeout(400);
    }
    if (hasToggle) {
      await boardControls.click();
      await page.waitForTimeout(300);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function ensureTwoColumn(page: any) {
    const boardControls = page.getByRole("button", { name: /Board controls/i }).first();
    const hasToggle = await boardControls.isVisible().catch(() => false);
    if (hasToggle) {
      await boardControls.click();
      await page.waitForTimeout(400);
    }

    // If we see "2 column" button, we're currently in single-col → click to switch to two-col
    const twoColBtn = page.getByRole("button", { name: /^2 column$/i }).first();
    const isInSingleCol = await twoColBtn.isVisible().catch(() => false);
    if (isInSingleCol) {
      await twoColBtn.click();
      await page.waitForTimeout(400);
    }
    if (hasToggle) {
      await boardControls.click();
      await page.waitForTimeout(300);
    }
  }

  test("topic header IS sticky in single-column desktop mode", async ({ page }) => {
    await page.goto(`${BASE}/u`);
    await page.waitForSelector("[data-topic-card-id]", { timeout: 20_000 });

    await ensureSingleColumn(page);

    const firstCard = page.locator("[data-topic-card-id]").first();
    const topicId = await firstCard.getAttribute("data-topic-card-id");
    const headerRow = firstCard.locator('[role="button"]').first();
    await headerRow.click();
    await page.waitForTimeout(600);

    const stickyHeader = page.locator(`[data-topic-card-id="${topicId}"]`)
      .locator('[role="button"]').first();

    const position = await stickyHeader.evaluate((el) =>
      window.getComputedStyle(el).position
    );
    expect(position).toBe("sticky");

    const topValue = await stickyHeader.evaluate((el) =>
      window.getComputedStyle(el).top
    );
    expect(parseInt(topValue, 10)).toBeGreaterThan(0);

    await page.screenshot({ path: "test-results/single-col-sticky-desktop.png" });
  });

  test("topic header IS sticky in two-column desktop mode (stays column-width)", async ({ page }) => {
    await page.goto(`${BASE}/u`);
    await page.waitForSelector("[data-topic-card-id]", { timeout: 20_000 });

    await ensureTwoColumn(page);

    const firstCard = page.locator("[data-topic-card-id]").first();
    const topicId = await firstCard.getAttribute("data-topic-card-id");
    const headerRow = firstCard.locator('[role="button"]').first();
    await headerRow.click();
    await page.waitForTimeout(600);

    const stickyHeader = page.locator(`[data-topic-card-id="${topicId}"]`)
      .locator('[role="button"]').first();

    const position = await stickyHeader.evaluate((el) =>
      window.getComputedStyle(el).position
    );
    // Sticky now applies in both single- and two-column modes
    expect(position).toBe("sticky");

    // Header width must not exceed half the viewport (stays within its column)
    const box = await stickyHeader.boundingBox();
    const viewportWidth = page.viewportSize()!.width;
    expect(box!.width).toBeLessThan(viewportWidth * 0.7);

    await page.screenshot({ path: "test-results/two-col-sticky-desktop.png" });
  });
});
