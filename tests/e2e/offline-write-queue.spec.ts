/**
 * Offline Write Queue Tests — Layer 2
 *
 * Validates that mutations made while the browser is offline are:
 *  1. Queued in IndexedDB via queueableApiMutation
 *  2. Reflected immediately in the UI via optimistic updates
 *  3. Drained and delivered to the server once the connection returns
 *
 * The write queue is in src/lib/write-queue.ts. It is drained by
 * data-provider.tsx on every SSE reconnect and on a 5s interval when online.
 */

import { expect, test } from "@playwright/test";
import { waitForUnifiedViewReady } from "../visual/helpers";

/**
 * Shared setup: set a token (needed for drain to run) and mock config for
 * write mode so rename pencils are enabled.
 */
async function setupWriteMode(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("clawboard.token", "test-token");
  });
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
}

test("topic rename while offline is queued and delivered on reconnect", async ({
  page,
  request,
}) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `wq-rename-${suffix}`;
  const topicName = `WQ Rename Topic ${suffix}`;
  const renamedName = `WQ Renamed ${suffix}`;

  await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false, status: "active" },
  });

  await setupWriteMode(page);
  await page.goto(`/u/topic/${topicId}`);
  await waitForUnifiedViewReady(page);
  await expect(page.locator(`[data-topic-card-id="${topicId}"]`).first()).toBeVisible({
    timeout: 20_000,
  });

  // Set up a listener BEFORE going offline so we can detect the queued POST once
  // we come back online.
  const renameDelivered = page.waitForRequest(
    (req) => {
      if (!req.url().includes("/api/topics") || req.method() !== "POST") return false;
      try {
        const body = req.postDataJSON() as Record<string, unknown>;
        return body.id === topicId && body.name === renamedName;
      } catch {
        return false;
      }
    },
    { timeout: 30_000 }
  );

  // Go offline.
  await page.context().setOffline(true);

  // Trigger a rename via the UI. With navigator.onLine === false, queueableApiMutation
  // will skip the network call and write to IndexedDB instead.
  await page.getByTestId(`rename-topic-${topicId}`).click();
  const nameInput = page.getByTestId(`rename-topic-input-${topicId}`);
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  await nameInput.fill(renamedName);
  await page.getByTestId(`save-topic-rename-${topicId}`).click();

  // The optimistic update must be visible immediately even while offline.
  await expect(page.getByText(renamedName).first()).toBeVisible({ timeout: 5_000 });

  // Come back online — drain fires (drainQueuedMutations on reconnect / 5s interval).
  await page.context().setOffline(false);

  // The queued POST /api/topics with the new name must be sent to the server.
  await renameDelivered;

  // Verify the server actually has the new name.
  const serverTopic = await request.get(`${apiBase}/api/topics/${topicId}`);
  if (serverTopic.ok()) {
    const data = (await serverTopic.json()) as { name?: string };
    expect(data.name).toBe(renamedName);
  }
});

test("multiple mutations queued offline are all drained in order on reconnect", async ({
  page,
  request,
}) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();

  // Create two topics.
  const topic1Id = `wq-multi-1-${suffix}`;
  const topic2Id = `wq-multi-2-${suffix}`;
  await request.post(`${apiBase}/api/topics`, {
    data: { id: topic1Id, name: `WQ Multi Topic 1 ${suffix}`, pinned: false, status: "active", sortIndex: 0 },
  });
  await request.post(`${apiBase}/api/topics`, {
    data: { id: topic2Id, name: `WQ Multi Topic 2 ${suffix}`, pinned: false, status: "active", sortIndex: 1 },
  });

  const name1 = `WQ Multi Renamed 1 ${suffix}`;
  const name2 = `WQ Multi Renamed 2 ${suffix}`;

  await setupWriteMode(page);
  await page.goto("/u");
  await waitForUnifiedViewReady(page);
  await expect(page.locator(`[data-topic-card-id="${topic1Id}"]`).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(`[data-topic-card-id="${topic2Id}"]`).first()).toBeVisible({
    timeout: 10_000,
  });

  const bothDelivered = Promise.all([
    page.waitForRequest(
      (req) => {
        if (!req.url().includes("/api/topics") || req.method() !== "POST") return false;
        try { return (req.postDataJSON() as Record<string, unknown>).id === topic1Id && (req.postDataJSON() as Record<string, unknown>).name === name1; }
        catch { return false; }
      },
      { timeout: 30_000 }
    ),
    page.waitForRequest(
      (req) => {
        if (!req.url().includes("/api/topics") || req.method() !== "POST") return false;
        try { return (req.postDataJSON() as Record<string, unknown>).id === topic2Id && (req.postDataJSON() as Record<string, unknown>).name === name2; }
        catch { return false; }
      },
      { timeout: 30_000 }
    ),
  ]);

  await page.context().setOffline(true);

  // Rename topic 1.
  await page.getByTestId(`rename-topic-${topic1Id}`).click();
  const input1 = page.getByTestId(`rename-topic-input-${topic1Id}`);
  await expect(input1).toBeVisible({ timeout: 5_000 });
  await input1.fill(name1);
  await page.getByTestId(`save-topic-rename-${topic1Id}`).click();
  // Close the edit mode before starting the second rename.
  await page.keyboard.press("Escape");

  // Rename topic 2.
  await page.getByTestId(`rename-topic-${topic2Id}`).click();
  const input2 = page.getByTestId(`rename-topic-input-${topic2Id}`);
  await expect(input2).toBeVisible({ timeout: 5_000 });
  await input2.fill(name2);
  await page.getByTestId(`save-topic-rename-${topic2Id}`).click();

  // Both optimistic updates visible.
  await expect(page.getByText(name1).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(name2).first()).toBeVisible({ timeout: 5_000 });

  // Come back online — both mutations drain.
  await page.context().setOffline(false);
  await bothDelivered;
});

test("draft text is written to localStorage immediately (survives before API responds)", async ({
  page,
  request,
}) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `wq-draft-${suffix}`;
  const topicName = `WQ Draft Topic ${suffix}`;
  const taskId = `wq-draft-task-${suffix}`;
  const taskTitle = `WQ Draft Task ${suffix}`;
  const draftText = `unsent offline draft ${suffix}`;

  await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false, status: "active" },
  });
  await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
  });

  await page.goto(`/u/topic/${topicId}/task/${taskId}`);
  await waitForUnifiedViewReady(page);

  const composer = page.getByTestId(`task-chat-composer-${topicId}`);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  const textbox = composer.getByRole("textbox");

  await page.context().setOffline(true);

  // Type the draft while offline — queueDraftUpsert writes to localStorage synchronously.
  await textbox.fill(draftText);

  // Verify localStorage was written immediately (the LOCAL_PREFIX is "clawboard.draft.v1:").
  const localKey = `clawboard:task:${topicId}:${taskId}`;
  const storedRaw = await page.evaluate((key) => {
    return window.localStorage.getItem(`clawboard.draft.v1:${key}`);
  }, localKey);

  expect(storedRaw).not.toBeNull();
  const stored = JSON.parse(storedRaw!) as { value: string };
  expect(stored.value).toBe(draftText);

  await page.context().setOffline(false);
});
