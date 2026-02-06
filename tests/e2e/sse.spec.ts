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
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "System",
    },
  });

  expect(res.ok()).toBeTruthy();
  await expect(main.getByText(message, { exact: true })).toBeVisible();
});

test("sse patches update log content without refresh", async ({ page, request }) => {
  await page.goto("/u");
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const main = page.locator("main");
  await main.getByText("Clawboard", { exact: true }).first().click();
  await main.getByText("Ship onboarding wizard").first().click();

  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const message = `SSE patch ${Date.now()}`;
  const createdAt = "2026-02-02T11:05:00.000Z";
  const res = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId: "topic-1",
      taskId: "task-1",
      type: "note",
      content: message,
      summary: message,
      createdAt,
      classificationStatus: "classified",
      agentId: "system",
      agentLabel: "System",
    },
  });

  expect(res.ok()).toBeTruthy();
  const entry = await res.json();
  await expect(main.getByText(message)).toBeVisible();

  const updated = `${message} updated`;
  const patch = await request.patch(`${apiBase}/api/log/${entry.id}`, {
    data: {
      content: updated,
      summary: updated,
      classificationStatus: "classified",
    },
  });

  expect(patch.ok()).toBeTruthy();
  await expect(main.getByText(updated)).toBeVisible();
  await expect(main.getByText(message, { exact: true })).toHaveCount(0);
});
