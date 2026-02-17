import { expect, test } from "@playwright/test";

test("deleting a log emits SSE and removes it from other open clients", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3050";
  const token = (process.env.PLAYWRIGHT_TOKEN ?? "").trim();

  const suffix = Date.now();
  const headers = token ? { "X-Clawboard-Token": token } : undefined;

  const topicId = `topic-sse-delete-${suffix}`;
  const topicName = `SSE Delete Topic ${suffix}`;
  const taskId = `task-sse-delete-${suffix}`;
  const taskName = `SSE Delete Task ${suffix}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
    ...(headers ? { headers } : {}),
  });
  expect(createTopic.ok()).toBeTruthy();

  const createTask = await request.post(`${apiBase}/api/tasks`, {
    data: { id: taskId, topicId, title: taskName, status: "todo", pinned: false },
    ...(headers ? { headers } : {}),
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
    ...(headers ? { headers } : {}),
  });
  expect(logRes.ok()).toBeTruthy();
  const log = await logRes.json();

  // Ensure the log is visible to reads before we attempt UI deletion (prevents "deleted:false" due to races).
  {
    const deadline = Date.now() + 10_000;
    let seen = false;
    while (!seen && Date.now() < deadline) {
      const res = await request.get(
        `${apiBase}/api/log?topicId=${encodeURIComponent(topicId)}&taskId=${encodeURIComponent(taskId)}&limit=200`,
        headers ? { headers } : undefined
      );
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
      if (tokenValue) {
        window.localStorage.setItem("clawboard.token", tokenValue);
      } else {
        window.localStorage.removeItem("clawboard.token");
      }
    },
    [apiBase, token]
  );

  const pageA = await ctx.newPage();
  const pageB = await ctx.newPage();

  await pageA.goto(`${baseURL}/u/topic/${topicId}/task/${taskId}`);
  await pageB.goto(`${baseURL}/u/topic/${topicId}/task/${taskId}`);

  await pageA.getByRole("heading", { name: "Unified View" }).waitFor();
  await pageB.getByRole("heading", { name: "Unified View" }).waitFor();

  const rowA = pageA.locator(`[data-log-id="${log.id}"]`);
  const rowB = pageB.locator(`[data-log-id="${log.id}"]`);
  await expect(rowA).toBeVisible({ timeout: 30_000 });
  await expect(rowB).toBeVisible({ timeout: 30_000 });

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
