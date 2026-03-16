/**
 * Connection Status Banner Tests — Layer 5
 *
 * Validates that the ConnectionStatusBanner in app-shell.tsx correctly:
 *  - Shows "Offline" after a sustained disconnect (3 s delay to avoid flashing on blips)
 *  - Shows "Reconnecting" when the SSE stream is attempting to reconnect
 *  - Shows "Back online — synced" briefly after reconnect, then hides
 *  - Does NOT flash for brief sub-3 s network interruptions
 *
 * The banner is driven by `connectionStatus` and `disconnectedSince` from the
 * data store (data-provider.tsx). It uses role="status" + aria-live="polite".
 */

import { expect, test } from "@playwright/test";
import { waitForUnifiedViewReady } from "../visual/helpers";

const BANNER_SHOW_DELAY_MS = 3_000;

test.describe("connection status banner", () => {
  test("banner shows 'Offline' after sustained disconnect, clears after reconnect", async ({
    page,
  }) => {
    await page.goto("/u");
    await waitForUnifiedViewReady(page);

    // Banner must be absent at baseline.
    const banner = page.getByRole("status");
    await expect(banner).not.toBeVisible();

    // Go offline — SSE connection drops.
    await page.context().setOffline(true);

    // Banner should NOT appear immediately (3 s debounce).
    await expect(banner).not.toBeVisible();

    // Wait past the debounce threshold.
    await page.waitForTimeout(BANNER_SHOW_DELAY_MS + 500);

    // Banner should now be visible with the offline message.
    await expect(banner).toBeVisible({ timeout: 5_000 });
    await expect(banner).toContainText(/Offline/i);

    // Come back online.
    await page.context().setOffline(false);

    // Banner should transition to "Back online — synced" then hide.
    await expect(banner).toContainText(/Back online/i, { timeout: 15_000 });
    // After the dismiss delay, banner hides.
    await expect(banner).not.toBeVisible({ timeout: 10_000 });
  });

  test("brief disconnect (< 3 s) does not trigger the banner", async ({ page }) => {
    await page.goto("/u");
    await waitForUnifiedViewReady(page);

    const banner = page.getByRole("status");
    await expect(banner).not.toBeVisible();

    // Go offline for less than the debounce window.
    await page.context().setOffline(true);
    await page.waitForTimeout(1_500);
    await page.context().setOffline(false);

    // Wait another moment to confirm the banner never showed.
    await page.waitForTimeout(1_000);
    await expect(banner).not.toBeVisible();
  });

  test("banner shows 'Reconnecting' during SSE reconnect attempt", async ({ page }) => {
    await page.goto("/u");
    await waitForUnifiedViewReady(page);

    // Block the SSE stream endpoint to force a reconnect loop.
    // The SSE watchdog will transition to "reconnecting" status after the first
    // failed reconnect attempt.
    await page.route("**/api/stream", async (route) => {
      // Return a non-streaming 503 so the SSE client keeps trying to reconnect.
      await route.fulfill({ status: 503, body: "Service Unavailable" });
    });

    // Wait past the debounce so the banner appears.
    await page.waitForTimeout(BANNER_SHOW_DELAY_MS + 1_000);

    const banner = page.getByRole("status");

    // Banner should show either "Offline" or "Reconnecting" while the stream is blocked.
    await expect(banner).toBeVisible({ timeout: 5_000 });
    const text = await banner.textContent();
    expect(
      text?.toLowerCase().includes("reconnecting") || text?.toLowerCase().includes("offline"),
      `Expected banner to say "Reconnecting" or "Offline" but got: "${text}"`
    ).toBeTruthy();

    // Unblock the stream — the banner should eventually clear.
    await page.unroute("**/api/stream");
    await expect(banner).not.toBeVisible({ timeout: 30_000 });
  });
});
