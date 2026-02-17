import { expect, test } from "@playwright/test";

test("deleting a log emits SSE and removes it from other open clients", async ({ browser, request }) => {
  test.skip(
    process.env.PLAYWRIGHT_USE_EXTERNAL_SERVER !== "1",
    "Requires external Clawboard/OpenClaw server with live SSE fanout."
  );
  test.setTimeout(120_000);
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:8010";
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3010";
  const token = process.env.PLAYWRIGHT_TOKEN ?? "";
  test.skip(!token, "PLAYWRIGHT_TOKEN env var is required for external-server SSE test");

  const suffix = Date.now();
  const headers = { "X-Clawboard-Token": token };

  const topicId = `topic-sse-delete-${suffix}`;
  const topicName = `SSE Delete Topic ${suffix}`;
  const taskId = `task-sse-delete-${suffix}`;
  const taskName = `SSE Delete Task ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, { data: { id: topicId, name: topicName, pinned: false }, headers });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskName, status: "todo", pinned: false },
    headers,
  });
  expect(createTask.ok()).toBeTruthy();

  const message = `sse-delete-me-${suffix}`;
  const logRes = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      taskId,
      type: "conversation",
      content: message,
      summary: `SSE delete summary ${suffix}`,
      classificationStatus: "classified",
      agentId: "user",
      agentLabel: "User",
      source: { sessionKey: `channel:test-sse-delete-${suffix}` },
    },
    headers,
  });
  expect(logRes.ok()).toBeTruthy();
  const log = await logRes.json();

  // Ensure the log is visible to reads before we attempt UI deletion (prevents "deleted:false" due to races).
  {
    const deadline = Date.now() + 10_000;
    let seen = false;
    while (!seen && Date.now() < deadline) {
      const res = await request.get(`${apiBase}/api/log?topicId=${encodeURIComponent(topicId)}&taskId=${encodeURIComponent(taskId)}&limit=200`, { headers });
      expect(res.ok()).toBeTruthy();
      const items = (await res.json()) as Array<{ id?: string }>;
      seen = Array.isArray(items) && items.some((item) => item && item.id === log.id);
      if (!seen) await new Promise((r) => setTimeout(r, 250));
    }
    expect(seen, `expected newly created log ${String(log.id)} to appear in GET /api/log before deletion`).toBeTruthy();
  }

  const ctx = await browser.newContext();
  await ctx.addInitScript(
    ([apiBaseValue, tokenValue]) => {
      window.localStorage.setItem("clawboard.apiBase", apiBaseValue);
      window.localStorage.setItem("clawboard.token", tokenValue);
    },
    [apiBase, token]
  );

  const pageA = await ctx.newPage();
  const pageB = await ctx.newPage();

  await pageA.goto(`${baseURL}/u`);
  await pageB.goto(`${baseURL}/u`);

  await pageA.getByRole("heading", { name: "Unified View" }).waitFor();
  await pageB.getByRole("heading", { name: "Unified View" }).waitFor();

  const topicButtonA = pageA.locator("div[role='button']").filter({ hasText: topicName }).first();
  const taskButtonA = pageA.locator("div[role='button']").filter({ hasText: taskName }).first();
  const topicButtonB = pageB.locator("div[role='button']").filter({ hasText: topicName }).first();
  const taskButtonB = pageB.locator("div[role='button']").filter({ hasText: taskName }).first();

  await expect(topicButtonA).toBeVisible({ timeout: 30_000 });
  await topicButtonA.click();
  await expect(taskButtonA).toBeVisible({ timeout: 30_000 });
  await taskButtonA.click();

  await expect(topicButtonB).toBeVisible({ timeout: 30_000 });
  await topicButtonB.click();
  await expect(taskButtonB).toBeVisible({ timeout: 30_000 });
  await taskButtonB.click();

  const rowA = pageA.locator(`[data-log-id="${log.id}"]`);
  const rowB = pageB.locator(`[data-log-id="${log.id}"]`);
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  await rowA.getByRole("button", { name: "Edit" }).click();
  await rowA.getByRole("button", { name: "Delete" }).click();

  const deleteResponsePromise = pageA.waitForResponse((res) => {
    if (res.request().method() !== "DELETE") return false;
    return res.url().includes(`/api/log/${encodeURIComponent(log.id)}`);
  });

  await rowA.getByRole("button", { name: "Confirm delete" }).click();

  const deleteRes = await deleteResponsePromise;
  expect(deleteRes.ok()).toBeTruthy();
  const deletePayload = (await deleteRes.json().catch(() => null)) as
    | { ok?: boolean; deleted?: boolean; deletedIds?: unknown }
    | null;

  expect(deletePayload && typeof deletePayload === "object").toBeTruthy();
  expect(deletePayload?.ok).toBeTruthy();
  expect(deletePayload?.deleted).toBeTruthy();
  const deletedIds = Array.isArray(deletePayload?.deletedIds) ? deletePayload?.deletedIds : [];
  expect(deletedIds).toContain(log.id);

  // Page A should remove soon due to local state update after DELETE response.
  await expect(pageA.locator(`[data-log-id="${log.id}"]`)).toHaveCount(0, { timeout: 10_000 });
  // Page B should remove without reload due to SSE log.deleted.
  await expect(pageB.locator(`[data-log-id="${log.id}"]`)).toHaveCount(0, { timeout: 15_000 });

  await ctx.close();
});
