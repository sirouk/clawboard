import { expect, test } from "@playwright/test";

const LIVE_SMOKE_ENABLED = process.env.PLAYWRIGHT_LIVE_STACK_SMOKE === "1";

const resolveToken = () =>
  (process.env.PLAYWRIGHT_CLAWBOARD_TOKEN ?? "").trim() ||
  (process.env.CLAWBOARD_TOKEN ?? "").trim();

const authHeaders = (token: string): Record<string, string> => {
  if (!token) return {};
  return { "X-Clawboard-Token": token };
};

test.describe("live stack smoke", () => {
  test.skip(!LIVE_SMOKE_ENABLED, "Set PLAYWRIGHT_LIVE_STACK_SMOKE=1 to run live stack smoke tests.");

  test("chat send + cancel path is healthy", async ({ page, request }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://127.0.0.1:8010";
    const token = resolveToken();
    const suffix = Date.now();
    const topicId = `topic-live-smoke-${suffix}`;
    const topicName = `Live Smoke ${suffix}`;
    const taskId = `task-live-smoke-${suffix}`;
    const taskTitle = `Live Smoke Task ${suffix}`;
    const sessionKey = `clawboard:task:${topicId}:${taskId}`;
    const message = `live-smoke-message-${suffix}`;

    let createTopic: Awaited<ReturnType<typeof request.post>>;
    try {
      createTopic = await request.post(`${apiBase}/api/topics`, {
        headers: authHeaders(token),
        data: { id: topicId, name: topicName, pinned: false },
      });
    } catch (error) {
      throw new Error(
        `Live stack API unreachable at ${apiBase}. Ensure Clawboard services are running and PLAYWRIGHT_API_BASE is correct. ${String(error)}`
      );
    }
    if (createTopic.status() === 401 || createTopic.status() === 403) {
      throw new Error(
        "Live stack API rejected auth while creating topic. Set PLAYWRIGHT_CLAWBOARD_TOKEN or export CLAWBOARD_TOKEN."
      );
    }
    expect(createTopic.ok()).toBeTruthy();

    const createTask = await request.post(`${apiBase}/api/tasks`, {
      headers: authHeaders(token),
      data: { id: taskId, topicId, title: taskTitle, status: "doing", pinned: false },
    });
    expect(createTask.ok()).toBeTruthy();

    await page.addInitScript(
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

    await page.goto(`/u/topic/${topicId}/task/${taskId}`);
    await page.getByRole("heading", { name: "Unified View" }).waitFor();

    const composer = page.locator('[data-testid="unified-composer-textarea"]:visible').first();
    await expect(composer).toBeVisible();

    const send = page.waitForResponse(
      (resp) => resp.url().includes("/api/openclaw/chat") && resp.request().method() === "POST"
    );
    await composer.fill(message);
    await composer.press("Enter");
    const sendRes = await send;
    expect(sendRes.ok()).toBeTruthy();

    const statusRes = await request.get(`${apiBase}/api/openclaw/chat-dispatch/status`, {
      headers: authHeaders(token),
    });
    expect(statusRes.ok()).toBeTruthy();
    const status = (await statusRes.json()) as {
      counts?: Partial<Record<"pending" | "retry" | "processing", number>>;
    };
    expect(typeof status.counts?.pending).toBe("number");
    expect(typeof status.counts?.retry).toBe("number");
    expect(typeof status.counts?.processing).toBe("number");

    const cancelRes = await request.delete(`${apiBase}/api/openclaw/chat`, {
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      data: { sessionKey },
    });
    expect(cancelRes.ok()).toBeTruthy();
  });
});
