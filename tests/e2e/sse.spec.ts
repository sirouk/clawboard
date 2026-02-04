import { test, expect } from "@playwright/test";

test("sse updates render without refresh", async ({ page, request }) => {
  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const main = page.locator("main");
  await main.getByText("Clawboard", { exact: true }).first().click();
  await main.getByText("Ship onboarding wizard").first().click();

  const message = `SSE update ${Date.now()}`;
  const now = "2026-02-02T11:00:00.000Z";

  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const res = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId: "topic-1",
      taskId: "task-1",
      type: "note",
      content: message,
      summary: message,
      createdAt: now,
      agentId: "system",
      agentLabel: "System",
    },
  });

  expect(res.ok()).toBeTruthy();
  await expect(main.getByText(message)).toBeVisible();
});
