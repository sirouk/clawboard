import { expect, test, type APIRequestContext } from "@playwright/test";

const LIVE_SMOKE_ENABLED = process.env.PLAYWRIGHT_LIVE_STACK_SMOKE === "1";

const resolveToken = () =>
  (process.env.PLAYWRIGHT_CLAWBOARD_TOKEN ?? "").trim() ||
  (process.env.CLAWBOARD_TOKEN ?? "").trim();

const authHeaders = (token: string): Record<string, string> => {
  if (!token) return {};
  return { "X-ClawBoard-Token": token };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForLiveApiReady(
  request: APIRequestContext,
  apiBase: string,
  token: string
) {
  await expect
    .poll(
      async () => {
        try {
          const response = await request.get(`${apiBase}/api/health`, {
            headers: authHeaders(token),
          });
          if (!response.ok()) return `status:${response.status()}`;
          const payload = (await response.json().catch(() => null)) as { status?: unknown } | null;
          return String(payload?.status ?? "").trim().toLowerCase() || "missing-status";
        } catch (error) {
          return `error:${String(error)}`;
        }
      },
      {
        timeout: 45_000,
        intervals: [500, 1000, 1500, 2000],
      }
    )
    .toBe("ok");
}

async function waitForLiveWebReady(
  request: APIRequestContext,
  baseUrl: string
) {
  await expect
    .poll(
      async () => {
        try {
          const response = await request.get(`${baseUrl}/u`);
          return response.ok() ? "ok" : `status:${response.status()}`;
        } catch (error) {
          return `error:${String(error)}`;
        }
      },
      {
        timeout: 45_000,
        intervals: [500, 1000, 1500, 2000],
      }
    )
    .toBe("ok");
}

async function postWithTransientRetry(
  request: APIRequestContext,
  url: string,
  options: { headers?: Record<string, string>; data?: unknown },
  attempts = 3
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request.post(url, options);
      if (response.status() >= 500 && response.status() < 600 && attempt < attempts) {
        await sleep(attempt * 1000);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) throw error;
      await sleep(attempt * 1000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`POST ${url} failed after ${attempts} attempts`);
}

test.describe("live stack smoke", () => {
  test.skip(!LIVE_SMOKE_ENABLED, "Set PLAYWRIGHT_LIVE_STACK_SMOKE=1 to run live stack smoke tests.");

  test("chat enqueue + durable log + cancel path is healthy without inference", async ({ page, request }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:8010";
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3010";
    const token = resolveToken();
    const suffix = Date.now();
    const topicId = `topic-live-smoke-${suffix}`;
    const topicName = `Live Smoke ${suffix}`;
    const taskId = `task-live-smoke-${suffix}`;
    const taskTitle = `Live Smoke Task ${suffix}`;
    const sessionKey = `clawboard:task:${topicId}:${taskId}`;
    const message = `live-smoke-message-${suffix}`;

    let createTopic: Awaited<ReturnType<typeof request.post>>;
    await waitForLiveApiReady(request, apiBase, token);
    try {
      createTopic = await postWithTransientRetry(request, `${apiBase}/api/topics`, {
        headers: authHeaders(token),
        data: { id: topicId, name: topicName, pinned: false },
      });
    } catch (error) {
      throw new Error(
        `Live stack API unreachable at ${apiBase}. Ensure ClawBoard services are running and PLAYWRIGHT_API_BASE is correct. ${String(error)}`
      );
    }
    if (createTopic.status() === 401 || createTopic.status() === 403) {
      throw new Error(
        "Live stack API rejected auth while creating topic. Set PLAYWRIGHT_CLAWBOARD_TOKEN or export CLAWBOARD_TOKEN."
      );
    }
    expect(createTopic.ok()).toBeTruthy();

    const createTask = await postWithTransientRetry(request, `${apiBase}/api/tasks`, {
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
        window.localStorage.removeItem("draft:unified:composer");
      },
      [apiBase, token]
    );

    await waitForLiveWebReady(request, baseUrl);
    await page.goto(`${baseUrl}/u/topic/${topicId}/task/${taskId}`);
    await page.getByRole("heading", { name: "Board View" }).waitFor();

    const taskComposer = page.getByTestId(`task-chat-composer-${taskId}`);
    await expect(taskComposer).toBeVisible();
    const composer = taskComposer.getByRole("textbox");
    const sendButton = taskComposer.getByRole("button", { name: "Send" });
    await expect(composer).toBeVisible();
    await expect(sendButton).toBeVisible();
    await composer.fill(message);
    const sendRes = await Promise.all([
      page.waitForResponse((resp) => resp.url().includes("/api/openclaw/chat") && resp.request().method() === "POST"),
      sendButton.click(),
    ]).then(([resp]) => resp);
    expect(sendRes.ok()).toBeTruthy();
    const sendBody = (await sendRes.json()) as { queued?: boolean; requestId?: string };
    expect(sendBody.queued).toBe(true);
    expect(typeof sendBody.requestId).toBe("string");
    expect(String(sendBody.requestId || "").trim().length).toBeGreaterThan(0);

    // The smoke only requires the request to be durably accepted; it does not wait for
    // model output because providers/inference may be unavailable in operator environments.
    await expect
      .poll(async () => {
        const logsRes = await request.get(`${apiBase}/api/log?sessionKey=${encodeURIComponent(sessionKey)}&limit=30`, {
          headers: authHeaders(token),
        });
        if (!logsRes.ok()) return false;
        const rows = (await logsRes.json()) as Array<{ content?: string; agentId?: string }>;
        return rows.some((row) => row.content === message && row.agentId === "user");
      })
      .toBeTruthy();

    await page.goto(`${baseUrl}/u`);
    await page.getByRole("heading", { name: "Board View" }).waitFor();
    await expect(page.locator('[data-testid="unified-composer-stop"]:visible')).toHaveCount(0);

    await page.goto(`${baseUrl}/u/topic/${topicId}/task/${taskId}?reveal=1`);
    await page.getByRole("heading", { name: "Board View" }).waitFor();
    await expect(page.getByTestId(`task-status-trigger-${taskId}`)).toContainText("Doing");
    await expect(page.locator('[data-testid="unified-composer-stop"]:visible')).toHaveCount(1);

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

    const cancelRes = await Promise.all([
      page.waitForResponse((resp) => resp.url().includes("/api/openclaw/chat") && resp.request().method() === "DELETE"),
      page.getByTestId("unified-composer-stop").click(),
    ]).then(([resp]) => resp);
    expect(cancelRes.ok()).toBeTruthy();
  });
});
