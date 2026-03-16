/**
 * Sync Correctness Tests — Layer 3
 *
 * Validates bidirectional sync between the board and the server:
 *  - SSE pushes are reflected immediately in the UI
 *  - Optimistic patches show before server confirmation
 *  - Reconnect after disconnect triggers a full authoritative reconcile
 *    so missed events are applied and the UI is never left stale
 */

import { expect, test } from "@playwright/test";
import { waitForUnifiedViewReady } from "../visual/helpers";

test("SSE topic.updated event immediately updates the topic name in the board", async ({
  page,
  request,
}) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `sync-sse-rename-${suffix}`;
  const topicName = `Sync SSE Topic ${suffix}`;
  const updatedName = `Sync SSE Topic Renamed ${suffix}`;

  await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false, status: "active" },
  });

  await page.goto("/u");
  await waitForUnifiedViewReady(page);

  // Confirm the original name is visible.
  await expect(page.locator(`[data-topic-card-id="${topicId}"]`).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(topicName).first()).toBeVisible();

  // Push a rename via the mock API (SSE delivers the event to the browser).
  const patch = await request.patch(`${apiBase}/api/topics/${topicId}`, {
    data: { name: updatedName },
  });
  expect(patch.ok()).toBeTruthy();

  // The UI must update without a page reload.
  await expect(page.getByText(updatedName).first()).toBeVisible({ timeout: 10_000 });
  // Old name must be gone.
  await expect(page.getByText(topicName)).toHaveCount(0, { timeout: 5_000 });
});

test("SSE new topic appears on board without page reload", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `sync-sse-create-${suffix}`;
  const topicName = `Sync SSE New Topic ${suffix}`;

  await page.goto("/u");
  await waitForUnifiedViewReady(page);

  // Verify the topic does not exist yet.
  await expect(page.locator(`[data-topic-card-id="${topicId}"]`)).toHaveCount(0);

  // Create the topic server-side; SSE delivers the event.
  const create = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false, status: "active" },
  });
  expect(create.ok()).toBeTruthy();

  // The board must show the new topic without a page reload.
  await expect(page.locator(`[data-topic-card-id="${topicId}"]`).first()).toBeVisible({
    timeout: 10_000,
  });
});

test("optimistic patch reflects immediately before server confirms", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `sync-opt-topic-${suffix}`;
  const topicName = `Sync Optimistic Topic ${suffix}`;
  const taskId = `sync-opt-task-${suffix}`;
  const taskTitle = `Sync Optimistic Task ${suffix}`;

  await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false, status: "active" },
  });
  await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });

  // Add a token so write operations are enabled.
  await page.addInitScript(() => {
    window.localStorage.setItem("clawboard.token", "test-token");
  });
  // Route config to allow write mode with token.
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        instance: { title: "Clawboard", integrationLevel: "write", updatedAt: "2026-01-01T00:00:00.000Z" },
        tokenRequired: true,
        tokenConfigured: true,
      }),
    });
  });

  // Intercept the PATCH so we can delay the server response and verify the
  // optimistic update appeared before it.
  let serverResolve: (() => void) | null = null;
  const serverGate = new Promise<void>((resolve) => { serverResolve = resolve; });

  await page.route(`**/api/topics/${topicId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      // Hold the response until we explicitly release it.
      await serverGate;
      await route.continue();
    } else {
      await route.continue();
    }
  });

  await page.goto(`/u/topic/${topicId}`);
  await waitForUnifiedViewReady(page);

  await expect(page.locator(`[data-topic-card-id="${topicId}"]`).first()).toBeVisible({
    timeout: 20_000,
  });

  // Change status via UI (status trigger → "Done").
  const statusTrigger = page.getByTestId(`task-status-trigger-${topicId}`).first();
  await expect(statusTrigger).toBeVisible({ timeout: 10_000 });
  await statusTrigger.click();
  const doneOption = page.getByRole("option", { name: /Done/i }).first();
  if (await doneOption.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await doneOption.click();
  }

  // The optimistic update should be visible BEFORE the server responds.
  // (Server gate is still locked.)
  await expect(statusTrigger).toContainText(/Done/i, { timeout: 5_000 });

  // Release the server — the real response should not revert the UI.
  serverResolve!();
  await page.waitForTimeout(500);
  await expect(statusTrigger).toContainText(/Done/i);
});

test("reconnect after offline triggers reconcile: deleted topic is removed", async ({
  page,
  request,
}) => {
  // This is a direct re-validation of the existing sse-recovery test, kept here
  // for cross-layer documentation. Uses x-mock-silent-event to simulate a delete
  // that was missed while offline.
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `sync-reconcile-${suffix}`;
  const topicName = `Sync Reconcile Topic ${suffix}`;

  await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false, status: "active" },
  });

  await page.goto("/u");
  await waitForUnifiedViewReady(page);
  await expect(page.locator(`[data-topic-card-id="${topicId}"]`).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.context().setOffline(true);

  // Delete while offline — SSE event will be missed.
  const del = await request.delete(`${apiBase}/api/topics/${topicId}`);
  expect(del.ok()).toBeTruthy();

  await page.context().setOffline(false);

  // Reconnect triggers changes-since reconcile — topic must disappear.
  await expect(page.locator(`[data-topic-card-id="${topicId}"]`)).toHaveCount(0, {
    timeout: 20_000,
  });
});
